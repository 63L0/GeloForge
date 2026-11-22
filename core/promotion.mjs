import fs from "node:fs";
import path from "node:path";
import { assertSafeWithinRoot, hasSecretContent, isForbiddenSecretPath } from "./path-safety.mjs";
import { loadProjectManifestAndState, scanAndAllocateRecordId } from "./project-locator.mjs";
import { runMultiFileTransaction, withProjectLock } from "./project-lock.mjs";
import { loadVerifiedSourceBundle } from "./skills-lifecycle.mjs";
import { readRegularFile, sha256 } from "./runtime-files.mjs";
import { signOperationApproval, verifyOperationApproval } from "./operation-approval.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { extractFrontmatter, serializeYaml } from "./yaml-subset.mjs";

function projectMarkdownPath(projectDir, value) {
  if (typeof value !== "string" || !value.endsWith(".md") || hasSecretContent(value) ||
      isForbiddenSecretPath(value) || value.includes("\\") ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Use a safe project-relative Markdown path.");
  }
  return assertSafeWithinRoot(projectDir, value);
}

export function promoteProjectProposal(options) {
  const { projectDir, harnessDir, proposal, target, evidenceIds, approvalId, publicKeyPath, privateKeyPath,
    expiresAt, action = "preview" } = options;
  const execute = () => {
    const project = loadProjectManifestAndState(projectDir, harnessDir);
    const { manifest, projectPaths, schemasDir } = project;
    const sourcePath = projectMarkdownPath(projectDir, proposal);
    const targetPath = projectMarkdownPath(projectDir, target);
    if (!proposal.startsWith(`${projectPaths.proposals_dir}/`) || sourcePath === targetPath) {
      throw new Error("Choose a proposal from the project's proposals directory.");
    }
    const isRequirement = [projectPaths.prd, projectPaths.constraints].includes(target) &&
      /^brain\/requirements\/[^/]+\.md$/.test(target);
    const adrMatch = target.match(/^brain\/decisions\/(ADR-\d{4})-[a-z0-9-]+\.md$/);
    const adrId = target.startsWith(`${projectPaths.decisions_dir}/`) ? adrMatch?.[1] : null;
    if (!isRequirement && !adrId) throw new Error("Choose a canonical requirements document or ADR target.");
    const raw = readRegularFile(sourcePath)?.toString("utf8");
    if (!raw?.trim() || hasSecretContent(raw)) throw new Error("Proposal is missing, empty, or contains credential-like content.");
    if (/^\s*is_example:\s*true\b/im.test(raw)) throw new Error("Example proposals cannot be promoted.");
    const original = readRegularFile(targetPath);
    if (original && hasSecretContent(original.toString("utf8"))) throw new Error("Canonical document contains credential-like content.");
    let adr;
    if (adrId) {
      const frontmatter = extractFrontmatter(raw, proposal);
      if (frontmatter.id !== adrId || frontmatter.status !== "proposed" ||
          frontmatter.owner !== manifest.owner || frontmatter.is_example) {
        throw new Error("Supply a proposed ADR with a matching ID and the current owner.");
      }
      scanAndAllocateRecordId({ projectDir, searchDirs: [projectPaths.decisions_dir], prefix: "ADR", explicitId: adrId });
      const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      adr = { frontmatter, body: normalized.slice(normalized.indexOf("\n---", 3) + 5) };
      const check = validateAgainstSchema(frontmatter, JSON.parse(fs.readFileSync(path.join(schemasDir, "adr.schema.json"), "utf8")));
      if (!check.valid) throw new Error(`Invalid proposed ADR: ${check.errors.join("; ")}`);
    }
    const bundle = loadVerifiedSourceBundle({ projectDir, harnessDir, evidenceIds });
    const evidence = bundle.evidenceDigests;
    const input = { proposal, target, content: sha256(raw), base: original ? sha256(original) : null, evidence };
    const operation = {
      title: `Promote proposal into ${target}`, category: isRequirement ? "requirements_change" : "architecture_change",
      targets: [proposal, target, ...bundle.evidenceList.map(({ data }) => data.id)],
      risk: "Updates one canonical document and binds it to verified evidence.", digest: sha256(JSON.stringify(input)),
    };
    const preview = { ...input, digest: operation.digest };
    if (action === "preview") return preview;
    if (action === "sign") return { ...preview, ...signOperationApproval({ project, operation, privateKeyPath, expiresAt }) };
    const approval = verifyOperationApproval({ project, operation, approvalId, publicKeyPath });
    const receipt = assertSafeWithinRoot(projectDir, `local-runtime/promotions/${approvalId}.json`);
    if (fs.existsSync(receipt)) throw new Error(`Approval ${approvalId} was already used. Sign a fresh approval.`);
    const content = adr ? `---\n${serializeYaml({
      ...adr.frontmatter, status: "accepted", approved_by: manifest.owner, decided_at: approval.decided_at,
      updated_at: approval.decided_at, approval_ref: approvalId,
    })}---\n${adr.body}` : raw;
    const archivedProposal = adr ? `local-runtime/promotions/${approvalId}-source.md` : null;
    const result = { ...preview, approvalId, archivedProposal, promoted: true };
    const steps = [
      { filePath: targetPath, content, allowOverwrite: Boolean(original) },
      { filePath: receipt, content: `${JSON.stringify(result, null, 2)}\n`, allowOverwrite: false, mode: 0o600 },
    ];
    if (archivedProposal) {
      // A proposed ADR and its canonical successor cannot share a live record ID.
      steps.push(
        { filePath: assertSafeWithinRoot(projectDir, archivedProposal), content: raw, allowOverwrite: false, mode: 0o600 },
        { filePath: sourcePath, deleteIfExists: true },
      );
    }
    runMultiFileTransaction(steps, { projectDir });
    return result;
  };
  return action === "preview" ? execute() : withProjectLock(projectDir, execute);
}
