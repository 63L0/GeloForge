/**
 * Evidence-backed adaptive skills lifecycle for GeloForge (v0.4 PR 3):
 *   Verified Experience -> Quarantined Draft/Update Proposal -> Evaluation/Lint
 *   -> Genuine Human Authorization (Ed25519 / PR Branch / Explicit TTY)
 *   -> Atomic Promotion -> Content-Addressed History & Authorized Rollback
 *
 * Security invariants:
 * - Zero third-party dependencies, zero network calls, zero automatic script execution.
 * - Never treats self-reported `--approved-by` flags as human authorization.
 * - Fails closed on missing/unverified/tampered evidence, contradictions, symlinks,
 *   secrets, digest mismatches, stale bases, or unauthorized promotion/rollback.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYaml, serializeYaml } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import {
  CONTROL_CHAR_REGEX,
  WINDOWS_RESERVED_NAME_REGEX,
  assertSafeWithinRoot,
  atomicWriteFile,
  deriveSlug,
  hasSecretContent,
  isForbiddenSecretPath,
  isSameOrInside,
  redactSecretContent,
  validateScalarText,
  walkNonSymlinkFiles,
} from "./path-safety.mjs";
import { getGitRepoInfo, getGitStatusScoped } from "./git-utils.mjs";
import { loadProjectManifestAndState, scanAndAllocateRecordId } from "./project-locator.mjs";
import { validateCreatedAt } from "./template-utils.mjs";
import {
  MAX_SKILL_BYTES,
  computeSkillPackageDigest,
  inspectSkillPackage,
  parseSkillMarkdown,
} from "./skills.mjs";
import {
  assertSafeAncestorChain,
  assertSafeDirNonSymlink,
  copyTreeSafe,
  findConsumedApprovalInHistory,
  getSkillHistory,
  inspectRollbackSnapshotForGate,
  readSafeYamlWithinProject,
  recordHistoryRevision,
  removeDirSafe,
  renameSyncRetry,
  sha256Hex,
  stageAtomicSwap,
  validateAndLintSkillStaging,
  validateSkillSlugName,
} from "./skills-history.mjs";

export { getSkillHistory };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

const ALLOWED_AUTHORIZATION_MODES = new Set(["approval", "pr-branch", "interactive"]);

function loadSchema(schemasDir, schemaName) {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, schemaName), "utf8"));
}

function validateExternalKeyOutPath(
  rawPath,
  { projectDir, harnessDir, workspaceRoot, label = "--out", allowInsideProject = false }
) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(`Missing required ${label} <file> path for Ed25519 key.`);
  }
  if (CONTROL_CHAR_REGEX.test(rawPath)) {
    throw new Error("Key output path contains illegal control characters.");
  }
  if (/^(\\\\|\/\/)/.test(rawPath)) {
    throw new Error(`Refusing UNC/network path for key output: "${rawPath}".`);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(rawPath)) {
    throw new Error(`Refusing path traversal ".." in key path: "${rawPath}".`);
  }

  const resolved = path.resolve(rawPath);
  const baseName = path.basename(resolved);
  if (WINDOWS_RESERVED_NAME_REGEX.test(baseName)) {
    throw new Error(`Key filename "${baseName}" conflicts with reserved Windows device name.`);
  }
  const protectedDirs = [path.resolve(harnessDir)];
  if (!allowInsideProject) {
    protectedDirs.unshift(path.resolve(projectDir));
  }
  if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, "worktrees"))) {
    protectedDirs.push(path.resolve(workspaceRoot, "worktrees"));
  }
  if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, "local-runtime"))) {
    protectedDirs.push(path.resolve(workspaceRoot, "local-runtime"));
  }
  for (const dir of protectedDirs) {
    if (isSameOrInside(resolved, dir)) {
      throw new Error(`Refusing to write key inside repository or protected directory: ${dir}`);
    }
  }

  // Reject symlinks on target or ancestors (ignoring macOS /tmp, /var, /etc OS links)
  let cursor = resolved;
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const isDarwinSys =
      process.platform === "darwin" && (cursor === "/tmp" || cursor === "/var" || cursor === "/etc");
    try {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink() && !isDarwinSys) {
        throw new Error(`Refusing symbolic link/junction in key path: ${cursor}`);
      }
      if (cursor === resolved) {
        throw new Error(`Refusing to overwrite existing key file: ${resolved}`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return resolved;
}

function validateExternalFileReadPath(rawPath, projectDir, label = "--key", { forbidInsideRepo = true } = {}) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(`Missing required ${label} file path.`);
  }
  if (CONTROL_CHAR_REGEX.test(rawPath) || /^(\\\\|\/\/)/.test(rawPath) || /(^|[\\/])\.\.([\\/]|$)/.test(rawPath)) {
    throw new Error(`Unsafe ${label} file path: "${rawPath}".`);
  }
  const resolved = path.resolve(rawPath);
  if (forbidInsideRepo && isSameOrInside(resolved, path.resolve(projectDir))) {
    throw new Error(`Refusing private key stored inside project repository (${resolved}); keep signing keys outside version control.`);
  }
  let cursor = resolved;
  const visited = new Set();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const isDarwinSys =
      process.platform === "darwin" && (cursor === "/tmp" || cursor === "/var" || cursor === "/etc");
    const st = fs.lstatSync(cursor);
    if (st.isSymbolicLink() && !isDarwinSys) {
      throw new Error(`Refusing symbolic link/junction in ${label} path: ${cursor}`);
    }
    if (cursor === resolved && !st.isFile()) {
      throw new Error(`${label} path is not a regular file: ${resolved}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolved;
}

function findRecordYamlById(projectDir, relDir, prefix, rawId) {
  const idClean = String(rawId || "").trim().toUpperCase();
  const idRegex = new RegExp(`^${prefix}-\\d{4}$`);
  if (!idRegex.test(idClean)) {
    throw new Error(`Invalid ${prefix} ID "${rawId}". Expected ${prefix}-NNNN.`);
  }
  const absDir = assertSafeWithinRoot(projectDir, relDir);
  if (!assertSafeDirNonSymlink(absDir, relDir)) {
    throw new Error(`${relDir}/ directory does not exist; ${idClean} not found.`);
  }
  const matches = [];
  const files = walkNonSymlinkFiles(projectDir, absDir, (p) => /\.ya?ml$/i.test(p), null, {
    onSymlink: (_rel, msg) => {
      throw new Error(msg);
    },
  });
  for (const fullPath of files) {
    const relPath = path.relative(projectDir, fullPath).replace(/\\/g, "/");
    const loaded = readSafeYamlWithinProject(projectDir, relPath);
    if (loaded?.data && typeof loaded.data.id === "string" && loaded.data.id.toUpperCase() === idClean) {
      matches.push(loaded);
    }
  }
  if (matches.length === 0) {
    throw new Error(`Record ${idClean} not found under ${relDir}/.`);
  }
  if (matches.length > 1) {
    throw new Error(`Duplicate record ID ${idClean} found in ${matches.map((m) => m.relPath).join(" and ")}.`);
  }
  return matches[0];
}

function verifySingleEvidenceRecord(loadedEvid, projectDir, schemasDir) {
  const d = loadedEvid.data;
  const res = validateAgainstSchema(d, loadSchema(schemasDir, "evidence-manifest.schema.json"));
  if (!res.valid) {
    throw new Error(`${loadedEvid.relPath} failed evidence-manifest schema: ${res.errors.join("; ")}`);
  }
  if (d.is_example === true) {
    throw new Error(`${loadedEvid.relPath}: example evidence fixture (is_example: true) cannot back skills.`);
  }
  if (d.status !== "verified") {
    throw new Error(`${loadedEvid.relPath}: evidence status is "${d.status}", expected "verified".`);
  }
  const checks = Array.isArray(d.checks) ? d.checks : [];
  if (checks.length === 0) {
    throw new Error(`${loadedEvid.relPath}: verified evidence must contain at least one check.`);
  }
  const bad = checks.filter((c) => c.result === "failed" || c.result === "blocked");
  const passed = checks.filter((c) => c.result === "passed");
  if (bad.length > 0 || passed.length === 0) {
    throw new Error(
      `${loadedEvid.relPath}: evidence requires >= 1 passed check and 0 failed/blocked checks (${passed.length} passed, ${bad.length} failed/blocked).`
    );
  }
  for (const chk of checks) {
    if (hasSecretContent(chk.command || "") || hasSecretContent(chk.summary || "")) {
      throw new Error(`${loadedEvid.relPath}: evidence check contains unredacted credential pattern.`);
    }
  }

  for (const art of d.artifacts || []) {
    if (!art || typeof art.path !== "string") continue;
    if (isForbiddenSecretPath(art.path)) {
      throw new Error(`${loadedEvid.relPath}: forbidden secret artifact path "${art.path}".`);
    }
    const artFull = assertSafeWithinRoot(projectDir, art.path);
    if (typeof art.sha256 === "string" && art.sha256.trim().length > 0) {
      if (!fs.existsSync(artFull) || !fs.lstatSync(artFull).isFile()) {
        throw new Error(`${loadedEvid.relPath}: hashed artifact missing or unsafe on disk: "${art.path}".`);
      }
      const actualHex = sha256Hex(fs.readFileSync(artFull));
      const expectedHex = art.sha256.trim().replace(/^sha256:/i, "").toLowerCase();
      if (actualHex !== expectedHex) {
        throw new Error(`${loadedEvid.relPath}: artifact SHA-256 mismatch on "${art.path}" (tampered artifact).`);
      }
    }
  }
  return loadedEvid;
}

/**
 * Loads, schema-checks, cross-verifies, and contradiction-checks source EVID/HANDOFF records.
 * Fails closed on invalid/unverified/tampered evidence or open CONF contradictions.
 */
export function loadVerifiedSourceBundle({
  projectDir,
  evidenceIds = [],
  handoffIds = [],
  harnessDir = DEFAULT_HARNESS_DIR,
} = {}) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const { schemasDir, projectPaths } = loaded;
  const resolvedProj = loaded.projectDir;

  const evIdList = Array.from(new Set((evidenceIds || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean)));
  const hoIdList = Array.from(new Set((handoffIds || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean)));
  if (evIdList.length === 0 && hoIdList.length === 0) {
    throw new Error("Provide at least one source record (--from-evidence EVID-NNNN or --from-handoff HANDOFF-NNNN).");
  }

  const evidenceMap = new Map();
  const handoffRecords = [];
  const referencedIds = new Set([...evIdList, ...hoIdList]);
  const referencedPaths = new Set();

  for (const evId of evIdList) {
    const rec = findRecordYamlById(resolvedProj, projectPaths.evidence_dir, "EVID", evId);
    verifySingleEvidenceRecord(rec, resolvedProj, schemasDir);
    evidenceMap.set(evId, rec);
    referencedPaths.add(rec.relPath);
    if (rec.data.task_id) referencedIds.add(rec.data.task_id);
  }

  const handoffSchema = loadSchema(schemasDir, "agent-handoff.schema.json");
  for (const hoId of hoIdList) {
    const hRec = findRecordYamlById(resolvedProj, projectPaths.handoffs_dir, "HANDOFF", hoId);
    const hValid = validateAgainstSchema(hRec.data, handoffSchema);
    if (!hValid.valid) {
      throw new Error(`${hRec.relPath} failed agent-handoff schema: ${hValid.errors.join("; ")}`);
    }
    if (hRec.data.is_example === true) {
      throw new Error(`${hRec.relPath}: example handoff (is_example: true) cannot back skills.`);
    }
    if (hRec.data.status === "rejected") {
      throw new Error(`${hRec.relPath}: rejected handoff cannot back skills.`);
    }
    const verifiedRefs = Array.isArray(hRec.data.verified_evidence) ? hRec.data.verified_evidence : [];
    if (verifiedRefs.length === 0) {
      throw new Error(
        `${hRec.relPath}: handoff has zero verified_evidence entries; unverified_claims alone cannot generate or update skills.`
      );
    }
    for (const ve of verifiedRefs) {
      const evRec = findRecordYamlById(resolvedProj, projectPaths.evidence_dir, "EVID", ve.id);
      verifySingleEvidenceRecord(evRec, resolvedProj, schemasDir);
      if (ve.path && ve.path !== evRec.relPath) {
        throw new Error(`${hRec.relPath}: verified_evidence path mismatch for ${ve.id} ("${ve.path}" vs "${evRec.relPath}").`);
      }
      evidenceMap.set(evRec.data.id, evRec);
      referencedIds.add(evRec.data.id);
      referencedPaths.add(evRec.relPath);
      if (evRec.data.task_id) referencedIds.add(evRec.data.task_id);
    }
    referencedPaths.add(hRec.relPath);
    if (hRec.data.task_id) referencedIds.add(hRec.data.task_id);
    handoffRecords.push(hRec);
  }

  // Check brain/conflicts for open or under_review contradictions on source evidence/tasks/handoffs
  const conflictsAbs = assertSafeWithinRoot(resolvedProj, projectPaths.conflicts_dir);
  const openConflictIds = [];
  if (assertSafeDirNonSymlink(conflictsAbs, projectPaths.conflicts_dir)) {
    const confFiles = walkNonSymlinkFiles(resolvedProj, conflictsAbs, (p) => /\.ya?ml$/i.test(p), null, {
      onSymlink: (_rel, msg) => {
        throw new Error(msg);
      },
    });
    for (const cf of confFiles) {
      const rel = path.relative(resolvedProj, cf).replace(/\\/g, "/");
      const confLoaded = readSafeYamlWithinProject(resolvedProj, rel);
      const cData = confLoaded?.data;
      if (!cData || (cData.status !== "open" && cData.status !== "under_review")) {
        continue;
      }
      const hitsRef =
        (cData.conflicting_records || []).some(
          (cr) => referencedIds.has(cr.record_id) || referencedPaths.has(String(cr.path || "").replace(/\\/g, "/"))
        ) || handoffRecords.some((h) => (h.data.conflicts_detected || []).includes(cData.id));
      if (hitsRef) {
        openConflictIds.push(cData.id);
      }
    }
  }
  if (openConflictIds.length > 0) {
    throw new Error(
      `Open contradiction conflict(s) (${openConflictIds.join(", ")}) affect the source evidence/task. Resolve conflicts before drafting or promoting skills.`
    );
  }

  // Git revision staleness detection (informational warning — fails only if requested strict elsewhere)
  const gitInfo = getGitRepoInfo(resolvedProj);
  const stalenessWarnings = [];
  const headCommit = gitInfo.available && !gitInfo.unborn ? gitInfo.head : null;

  const evidenceList = Array.from(evidenceMap.values()).sort((a, b) => a.data.id.localeCompare(b.data.id));
  for (const ev of evidenceList) {
    const rev = String(ev.data.source_revision || "");
    if (headCommit && /^[a-f0-9]{7,40}$/i.test(rev) && !headCommit.startsWith(rev) && !rev.startsWith(headCommit)) {
      stalenessWarnings.push(
        `Evidence ${ev.data.id} was captured at Git revision ${rev}, while current HEAD is ${headCommit.slice(0, 12)}.`
      );
    }
  }

  // Load primary task details if readable (non-fatal if archived)
  const taskIds = Array.from(new Set(evidenceList.map((e) => e.data.task_id).filter(Boolean))).sort();
  let primaryTask = null;
  if (taskIds.length > 0) {
    try {
      primaryTask = findRecordYamlById(resolvedProj, projectPaths.tasks_dir, "TASK", taskIds[0]);
    } catch {
      primaryTask = null;
    }
  }

  const evidenceDigests = [
    ...evidenceList.map((e) => `${e.data.id}@${e.sha256}`),
    ...handoffRecords.map((h) => `${h.data.id}@${h.sha256}`),
  ].sort();

  return {
    ...loaded,
    evidenceList,
    handoffRecords,
    taskIds,
    primaryTask,
    evidenceDigests,
    stalenessWarnings,
  };
}

function formatFactualObservationsLines(bundle) {
  const lines = [];
  for (const ev of bundle.evidenceList) {
    const d = ev.data;
    lines.push(`- **${d.id}** (\`${ev.relPath}\`, task \`${d.task_id}\`, revision \`${d.source_revision}\`, ${d.environment.os} / ${d.environment.runtime}):`);
    for (const chk of d.checks) {
      lines.push(`  - Check \`${chk.name}\` — command: \`${chk.command}\` -> result: \`${chk.result}\` (${chk.summary})`);
    }
    if (Array.isArray(d.limitations) && d.limitations.length > 0) {
      for (const lim of d.limitations) {
        lines.push(`  - Recorded limitation: ${lim}`);
      }
    }
  }
  for (const h of bundle.handoffRecords) {
    lines.push(`- **${h.data.id}** (\`${h.relPath}\`, role \`${h.data.from_role}\` -> \`${h.data.to_role}\`): ${h.data.summary}`);
  }
  return lines;
}

function buildDraftSkillMarkdown({ skillName, title, description, bundle, suggestedSteps = [], tags = [], triggers = [] }) {
  const sourceIds = [...bundle.evidenceList.map((e) => e.data.id), ...bundle.handoffRecords.map((h) => h.data.id)];
  const mergedTags = Array.from(new Set(["evidence-backed", ...tags])).join(", ");
  const mergedTriggers = Array.from(
    new Set(triggers.length > 0 ? triggers : [skillName.replace(/-/g, " "), bundle.taskIds[0] || "verification"])
  ).join(", ");

  const frontmatterObj = {
    name: skillName,
    description,
    license: "MIT",
    metadata: {
      geloforge_origin: "evidence_draft",
      geloforge_source_records: sourceIds.join(", "),
      ...(bundle.taskIds.length > 0 ? { geloforge_source_task: bundle.taskIds.join(", ") } : {}),
      geloforge_tags: mergedTags,
      geloforge_triggers: mergedTriggers,
    },
  };

  const yamlLines = serializeYaml(frontmatterObj).trimEnd();
  const factualLines = formatFactualObservationsLines(bundle);

  const procLines =
    suggestedSteps.length > 0
      ? suggestedSteps.map((s, idx) => `${idx + 1}. ${s}`)
      : [
          ...(bundle.primaryTask?.data?.objective
            ? [`1. Confirm task objective applies: ${bundle.primaryTask.data.objective}`]
            : ["1. Review whether the target repository context matches the source task constraints."]),
          ...bundle.evidenceList.flatMap((ev, idx) =>
            ev.data.checks.map(
              (chk, cIdx) =>
                `${bundle.primaryTask ? idx + cIdx + 2 : idx + cIdx + 1}. Re-run verification command \`${chk.command}\` explicitly with \`geloforge evidence capture\` (never treat historical \`exit 0\` as proof for new edits).`
            )
          ),
        ];

  const mdLines = [
    "---",
    yamlLines,
    "---",
    "",
    `# ${title}`,
    "",
    "> **Draft Status (Quarantined):** Generated from local verified records below. Passing source evidence does **not** prove generalized procedure steps are valid; human review and authorization are required before promotion.",
    "",
    "## When to Use",
    "",
    `Use this skill when working on tasks related to ${title.toLowerCase()} where the recorded verification steps below apply.`,
    "",
    "## Verified Observations (Source Evidence — Factual Only)",
    "",
    ...factualLines,
    "",
    "## Suggested Procedure (Agent/Draft Suggestion — Unverified Until Promoted)",
    "",
    ...procLines,
    "",
    "## Provenance & Limitations",
    "",
    `- **Source Records & Digests:** ${bundle.evidenceDigests.map((d) => `\`${d}\``).join(", ")}`,
    ...(bundle.stalenessWarnings.length > 0
      ? bundle.stalenessWarnings.map((w) => `- **Staleness Notice:** ${w}`)
      : ["- **Git Alignment:** Source evidence matches checked Git state or non-Git workspace."]),
    "",
  ];

  return mdLines.join("\n");
}

function ensureProposalSlotAvailable(projectDir, proposalDir, metaRel, metaAbs) {
  let allowMetaOverwrite = false;
  if (fs.existsSync(metaAbs)) {
    const existing = readSafeYamlWithinProject(projectDir, metaRel);
    const st = existing?.data?.status;
    if ((st === "promoted" || st === "pending_pr_review") && !fs.existsSync(proposalDir)) {
      allowMetaOverwrite = true;
    } else {
      throw new Error(
        `Proposal metadata "${metaRel}" already exists; resolve or remove pending proposal before creating a new one.`
      );
    }
  }
  return allowMetaOverwrite;
}

/**
 * Phase 3: Creates a quarantined portable SKILL.md draft under <proposalsDir>/skills/
 * backed strictly by verified EVID-* / HANDOFF-* facts without auto-activating.
 */
export function draftSkillFromExperience(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const createdAt = validateCreatedAt(options.createdAt);
  const bundle = loadVerifiedSourceBundle({
    projectDir: options.projectDir,
    evidenceIds: options.evidenceIds || [],
    handoffIds: options.handoffIds || [],
    harnessDir,
  });
  const { projectDir, projectPaths } = bundle;

  const fallbackTitle =
    bundle.primaryTask?.data?.title ||
    bundle.evidenceList[0]?.data?.title ||
    bundle.handoffRecords[0]?.data?.id ||
    "verified-workflow";
  const skillName = validateSkillSlugName(options.skillName, fallbackTitle);

  if (options.title && CONTROL_CHAR_REGEX.test(options.title)) {
    throw new Error("Title contains invalid control characters.");
  }
  const title = (options.title ? validateScalarText("--title", options.title) : null) ||
    `${bundle.primaryTask?.data?.title || bundle.evidenceList[0].data.title}`;

  const rawDesc =
    options.description ||
    `Apply verified checks for ${title} backed by ${bundle.evidenceList.map((e) => e.data.id).join(", ")}. Review draft guidance before use.`;
  let description = redactSecretContent(validateScalarText("--description", rawDesc));
  if (description.length < 20) {
    description = `${description} — reviewed draft from verified project evidence.`;
  }
  if (description.length > 1024) {
    description = `${description.slice(0, 1021)}...`;
  }
  if (hasSecretContent(title) || hasSecretContent(description)) {
    throw new Error("Refusing draft metadata containing credential-like content.");
  }

  const suggestedSteps = Array.isArray(options.steps)
    ? options.steps.map((s) => validateScalarText("--step", s))
    : [];
  for (const s of suggestedSteps) {
    if (hasSecretContent(s)) throw new Error("Refusing draft step containing credential-like content.");
  }

  const activeDir = assertSafeWithinRoot(projectDir, `.agents/skills/${skillName}`);
  if (fs.existsSync(activeDir)) {
    throw new Error(
      `Active skill "${skillName}" already exists at .agents/skills/${skillName}. Use "geloforge skills propose-update ${skillName}" instead.`
    );
  }

  const skillsProposalsRoot = assertSafeWithinRoot(projectDir, `${projectPaths.proposals_dir}/skills`);
  assertSafeAncestorChain(skillsProposalsRoot, projectDir, "proposals/skills");
  assertSafeDirNonSymlink(skillsProposalsRoot, `${projectPaths.proposals_dir}/skills`);

  const proposalSkillRel = `${projectPaths.proposals_dir}/skills/${skillName}`;
  const proposalSkillDir = assertSafeWithinRoot(projectDir, proposalSkillRel);
  const metaRel = `${projectPaths.proposals_dir}/skills/.proposals/${skillName}.yaml`;
  const metaAbs = assertSafeWithinRoot(projectDir, metaRel);

  if (fs.existsSync(proposalSkillDir)) {
    throw new Error(`Proposal "${skillName}" already exists under ${proposalSkillRel}. Avoid duplicate proposals.`);
  }
  const allowMetaOverwrite = ensureProposalSlotAvailable(projectDir, proposalSkillDir, metaRel, metaAbs);

  const markdown = buildDraftSkillMarkdown({
    skillName,
    title,
    description,
    bundle,
    suggestedSteps,
    tags: options.tags || [],
    triggers: options.triggers || [],
  });
  if (hasSecretContent(markdown)) {
    throw new Error("Refusing draft because generated SKILL.md triggered secret-content detection.");
  }

  // Stage in isolated temp dir, validate + strict lint + compute digest
  const stageDir = path.join(projectDir, projectPaths.proposals_dir, "skills", `.geloforge-stage-${crypto.randomBytes(6).toString("hex")}`);
  let verified;
  try {
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, "SKILL.md"), markdown, { encoding: "utf8", flag: "wx" });
    verified = validateAndLintSkillStaging({
      stageDir,
      skillName,
      displayRoot: `${projectPaths.proposals_dir}/skills`,
    });

    const proposalMeta = {
      schema_version: "1.0",
      proposal_id: `PROP-${skillName}`,
      kind: "new_skill",
      skill_name: skillName,
      status: "draft",
      created_at: createdAt,
      base_skill_digest: null,
      candidate_digest: verified.digestInfo.digest,
      source_evidence: bundle.evidenceList.map((e) => ({
        id: e.data.id,
        path: e.relPath,
        sha256: e.sha256,
      })),
      source_handoffs: bundle.handoffRecords.map((h) => ({
        id: h.data.id,
        path: h.relPath,
        sha256: h.sha256,
      })),
      reason: `Evidence-backed draft generated from ${[...bundle.evidenceList, ...bundle.handoffRecords].map((r) => r.data.id).join(", ")}.`,
      warnings: bundle.stalenessWarnings,
    };

    if (options.dryRun) {
      return {
        dryRun: true,
        skillName,
        proposalDir: proposalSkillRel,
        proposalMetaPath: metaRel,
        candidateDigest: verified.digestInfo.digest,
        evidenceDigests: bundle.evidenceDigests,
        stalenessWarnings: bundle.stalenessWarnings,
        lintPassed: true,
        markdown,
        proposalMeta,
      };
    }

    assertSafeAncestorChain(proposalSkillDir, projectDir, proposalSkillRel);
    renameSyncRetry(stageDir, proposalSkillDir);
    atomicWriteFile(metaAbs, serializeYaml(proposalMeta, { headerComment: "Quarantined GeloForge skill draft metadata" }), {
      allowOverwrite: allowMetaOverwrite,
    });

    return {
      dryRun: false,
      skillName,
      proposalDir: proposalSkillRel,
      proposalMetaPath: metaRel,
      candidateDigest: verified.digestInfo.digest,
      evidenceDigests: bundle.evidenceDigests,
      stalenessWarnings: bundle.stalenessWarnings,
      lintPassed: true,
      proposalMeta,
    };
  } finally {
    removeDirSafe(stageDir);
  }
}

/**
 * Deterministic line-based unified diff helper with zero external dependencies
 * and bounded DP memory allocation.
 */
export function computeUnifiedDiff(oldText, newText, oldLabel = "a/SKILL.md", newLabel = "b/SKILL.md") {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }

  const aMid = a.slice(start, endA + 1);
  const bMid = b.slice(start, endB + 1);
  const m = aMid.length;
  const n = bMid.length;

  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (let k = 0; k < start; k += 1) {
    lines.push(` ${a[k]}`);
  }

  let added = 0;
  let removed = 0;
  if (m * n > 1_000_000) {
    for (const line of aMid) {
      lines.push(`-${line}`);
      removed += 1;
    }
    for (const line of bMid) {
      lines.push(`+${line}`);
      added += 1;
    }
  } else {
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (aMid[i] === bMid[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        lines.push(` ${aMid[i]}`);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push(`-${aMid[i]}`);
        removed += 1;
        i += 1;
      } else {
        lines.push(`+${bMid[j]}`);
        added += 1;
        j += 1;
      }
    }
    while (i < m) {
      lines.push(`-${aMid[i]}`);
      removed += 1;
      i += 1;
    }
    while (j < n) {
      lines.push(`+${bMid[j]}`);
      added += 1;
      j += 1;
    }
  }

  for (let k = endA + 1; k < a.length; k += 1) {
    lines.push(` ${a[k]}`);
  }

  return {
    diff: lines.join("\n"),
    added,
    removed,
  };
}

/**
 * Phase 4: Proposes an isolated candidate update to an existing trusted project skill
 * without modifying `.agents/skills/<skillName>/`.
 */
export function proposeSkillUpdate(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const createdAt = validateCreatedAt(options.createdAt);
  const skillName = validateSkillSlugName(options.skillName);
  const reason = redactSecretContent(validateScalarText("--reason", options.reason || "Incorporate verified findings."));
  if (hasSecretContent(reason)) {
    throw new Error("Refusing update reason containing credential-like content.");
  }

  const bundle = loadVerifiedSourceBundle({
    projectDir: options.projectDir,
    evidenceIds: options.evidenceIds || [],
    handoffIds: options.handoffIds || [],
    harnessDir,
  });
  const { projectDir, projectPaths } = bundle;

  const activeRel = `.agents/skills/${skillName}`;
  const activeDir = assertSafeWithinRoot(projectDir, activeRel);
  if (!fs.existsSync(activeDir)) {
    throw new Error(`Trusted skill "${skillName}" does not exist at ${activeRel}. Use "geloforge skills draft" for new skills.`);
  }
  const activeDigestInfo = computeSkillPackageDigest(activeDir);
  const activePkg = inspectSkillPackage({
    skillDir: activeDir,
    folderName: skillName,
    source: "project",
    trustTier: "project_trusted",
    displayRoot: ".agents/skills",
  });
  if (!activePkg.valid) {
    throw new Error(`Current active skill "${skillName}" is invalid and cannot be updated safely.`);
  }

  const proposalRel = `${projectPaths.proposals_dir}/skills/${skillName}`;
  const proposalDir = assertSafeWithinRoot(projectDir, proposalRel);
  const metaRel = `${projectPaths.proposals_dir}/skills/.proposals/${skillName}.yaml`;
  const metaAbs = assertSafeWithinRoot(projectDir, metaRel);

  if (fs.existsSync(proposalDir)) {
    let staleNote = "";
    try {
      const existingMeta = readSafeYamlWithinProject(projectDir, metaRel);
      if (existingMeta?.data?.base_skill_digest && existingMeta.data.base_skill_digest !== activeDigestInfo.digest) {
        staleNote = " Existing proposal appears stale against current active skill.";
      }
    } catch {
      // Ignore unreadable meta
    }
    throw new Error(
      `An update or draft proposal for "${skillName}" already exists at ${proposalRel}.${staleNote} Resolve or remove it before creating another proposal.`
    );
  }
  const allowMetaOverwrite = ensureProposalSlotAvailable(projectDir, proposalDir, metaRel, metaAbs);

  let candidateSkillMd = "";
  if (options.patchFile) {
    const patchAbs = validateExternalFileReadPath(options.patchFile, projectDir, "--patch-file", {
      forbidInsideRepo: false,
    });
    if (isForbiddenSecretPath(path.basename(patchAbs))) {
      throw new Error(`Blocked forbidden secret filename for --patch-file: ${path.basename(patchAbs)}`);
    }
    const pStat = fs.lstatSync(patchAbs);
    if (pStat.size > MAX_SKILL_BYTES) {
      throw new Error(`--patch-file exceeds max skill size (${MAX_SKILL_BYTES} bytes).`);
    }
    candidateSkillMd = fs.readFileSync(patchAbs, "utf8");
    if (hasSecretContent(candidateSkillMd)) {
      throw new Error("Blocked --patch-file containing credential-like pattern.");
    }
    const parsedCand = parseSkillMarkdown(candidateSkillMd, options.patchFile);
    if (parsedCand.frontmatter?.name !== skillName) {
      throw new Error(`Candidate SKILL.md frontmatter name "${parsedCand.frontmatter?.name}" must equal "${skillName}".`);
    }
  } else {
    const note = options.appendNote ? validateScalarText("--append-note", options.appendNote) : null;
    if (note && hasSecretContent(note)) {
      throw new Error("Blocked --append-note containing credential-like pattern.");
    }
    const factualLines = formatFactualObservationsLines(bundle);
    const updateLines = [
      "",
      `## Proposed Evidence-Backed Update (${createdAt.slice(0, 10)})`,
      "",
      `- **Reason:** ${reason}`,
      `- **Provenance:** ${bundle.evidenceDigests.map((d) => `\`${d}\``).join(", ")}`,
      ...(note ? [`- **Proposed Improvement (Unverified Suggestion):** ${note}`] : []),
      "",
      "### Supporting Verified Observations",
      "",
      ...factualLines,
      "",
    ];
    candidateSkillMd = `${activePkg.rawSkillText.trimEnd()}\n${updateLines.join("\n")}`;
  }

  const diffRes = computeUnifiedDiff(
    activePkg.rawSkillText.replace(/\r\n/g, "\n").trimEnd(),
    candidateSkillMd.replace(/\r\n/g, "\n").trimEnd(),
    `.agents/skills/${skillName}/SKILL.md`,
    `${proposalRel}/SKILL.md`
  );
  if (diffRes.added === 0 && diffRes.removed === 0) {
    throw new Error("Proposed update introduces no changes to SKILL.md.");
  }

  const skillsProposalsRoot = assertSafeWithinRoot(projectDir, `${projectPaths.proposals_dir}/skills`);
  assertSafeAncestorChain(skillsProposalsRoot, projectDir, "proposals/skills");
  assertSafeDirNonSymlink(skillsProposalsRoot, `${projectPaths.proposals_dir}/skills`);
  fs.mkdirSync(skillsProposalsRoot, { recursive: true });

  const stageDir = path.join(skillsProposalsRoot, `.geloforge-stage-${crypto.randomBytes(6).toString("hex")}`);
  try {
    copyTreeSafe(activeDir, stageDir);
    fs.writeFileSync(path.join(stageDir, "SKILL.md"), candidateSkillMd, "utf8");

    const verified = validateAndLintSkillStaging({
      stageDir,
      skillName,
      displayRoot: `${projectPaths.proposals_dir}/skills`,
    });
    if (verified.digestInfo.digest === activeDigestInfo.digest) {
      throw new Error("Proposed candidate package SHA-256 is identical to the active skill.");
    }

    const proposalMeta = {
      schema_version: "1.0",
      proposal_id: `PROP-${skillName}`,
      kind: "update_skill",
      skill_name: skillName,
      status: "draft",
      created_at: createdAt,
      base_skill_digest: activeDigestInfo.digest,
      candidate_digest: verified.digestInfo.digest,
      source_evidence: bundle.evidenceList.map((e) => ({
        id: e.data.id,
        path: e.relPath,
        sha256: e.sha256,
      })),
      source_handoffs: bundle.handoffRecords.map((h) => ({
        id: h.data.id,
        path: h.relPath,
        sha256: h.sha256,
      })),
      reason,
      diff_summary: `+${diffRes.added}/-${diffRes.removed} lines in SKILL.md`,
      warnings: bundle.stalenessWarnings,
    };

    if (options.dryRun) {
      return {
        dryRun: true,
        skillName,
        proposalDir: proposalRel,
        proposalMetaPath: metaRel,
        baseSkillDigest: activeDigestInfo.digest,
        candidateDigest: verified.digestInfo.digest,
        diff: diffRes.diff,
        diffSummary: proposalMeta.diff_summary,
        evidenceDigests: bundle.evidenceDigests,
        stalenessWarnings: bundle.stalenessWarnings,
        proposalMeta,
      };
    }

    assertSafeAncestorChain(proposalDir, projectDir, proposalRel);
    renameSyncRetry(stageDir, proposalDir);
    atomicWriteFile(metaAbs, serializeYaml(proposalMeta, { headerComment: "Quarantined GeloForge skill update proposal metadata" }), {
      allowOverwrite: allowMetaOverwrite,
    });

    return {
      dryRun: false,
      skillName,
      proposalDir: proposalRel,
      proposalMetaPath: metaRel,
      baseSkillDigest: activeDigestInfo.digest,
      candidateDigest: verified.digestInfo.digest,
      diff: diffRes.diff,
      diffSummary: proposalMeta.diff_summary,
      evidenceDigests: bundle.evidenceDigests,
      stalenessWarnings: bundle.stalenessWarnings,
      proposalMeta,
    };
  } finally {
    removeDirSafe(stageDir);
  }
}

function loadApproversRegistry(projectDir) {
  const relPath = ".geloforge/approvers.yaml";
  const loaded = readSafeYamlWithinProject(projectDir, relPath);
  if (!loaded || !loaded.data) {
    return { relPath, approvers: [] };
  }
  if (typeof loaded.data !== "object" || Array.isArray(loaded.data) || !Array.isArray(loaded.data.approvers)) {
    throw new Error(`${relPath}: invalid approvers registry format (expected mapping with "approvers" list).`);
  }
  const seenIds = new Set();
  const approvers = [];
  for (const entry of loaded.data.approvers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${relPath}: approver entry must be a YAML object.`);
    }
    if (typeof entry.approver_id !== "string" || entry.approver_id.trim().length === 0) {
      throw new Error(`${relPath}: approver entry missing valid "approver_id".`);
    }
    if (seenIds.has(entry.approver_id)) {
      throw new Error(`${relPath}: duplicate approver_id "${entry.approver_id}" in approvers registry.`);
    }
    seenIds.add(entry.approver_id);
    if (entry.algorithm !== "ed25519") {
      throw new Error(`${relPath}: unsupported algorithm "${entry.algorithm}" for approver "${entry.approver_id}".`);
    }
    if (typeof entry.public_key_pem !== "string" || !entry.public_key_pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error(`${relPath}: invalid public_key_pem for approver "${entry.approver_id}".`);
    }
    let pubObj;
    try {
      pubObj = crypto.createPublicKey(entry.public_key_pem);
    } catch {
      throw new Error(`${relPath}: unparseable public_key_pem for approver "${entry.approver_id}".`);
    }
    if (pubObj.asymmetricKeyType !== "ed25519") {
      throw new Error(`${relPath}: public key for approver "${entry.approver_id}" must be Ed25519.`);
    }
    const canonicalPubPem = pubObj.export({ type: "spki", format: "pem" });
    const canonicalFp = `ed25519:${sha256Hex(canonicalPubPem).slice(0, 16)}`;
    const rawFp = `ed25519:${sha256Hex(entry.public_key_pem).slice(0, 16)}`;
    if (entry.key_fingerprint !== canonicalFp && entry.key_fingerprint !== rawFp) {
      throw new Error(`${relPath}: key_fingerprint mismatch for approver "${entry.approver_id}".`);
    }
    approvers.push(entry);
  }
  return { relPath, approvers };
}

/**
 * Generates an Ed25519 keypair, storing ONLY the public key in `.geloforge/approvers.yaml`
 * (plus optional pinned external `--pub-out`) and writing the private key outside project/harness trees (`mode 0o600`, no overwrite).
 */
export function generateApproverKeypair(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
  const { projectDir } = loaded;
  const createdAt = validateCreatedAt(options.createdAt);
  const approverId = validateScalarText("--approver", options.approverId);
  if (hasSecretContent(approverId)) {
    throw new Error("Invalid --approver identifier.");
  }

  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : path.resolve(harnessDir, "..");
  const privOutAbs = validateExternalKeyOutPath(options.privateKeyOut, {
    projectDir,
    harnessDir,
    workspaceRoot,
    label: "--out",
    allowInsideProject: false,
  });
  let pubOutAbs = null;
  if (options.publicKeyOut) {
    pubOutAbs = validateExternalKeyOutPath(options.publicKeyOut, {
      projectDir,
      harnessDir,
      workspaceRoot,
      label: "--pub-out",
      allowInsideProject: true,
    });
    if (pubOutAbs === privOutAbs) {
      throw new Error("--pub-out and --out must point to separate files.");
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const keyFingerprint = `ed25519:${sha256Hex(publicKeyPem).slice(0, 16)}`;

  const registry = loadApproversRegistry(projectDir);
  if (registry.approvers.some((a) => a.approver_id === approverId)) {
    throw new Error(`Approver "${approverId}" is already registered in ${registry.relPath}. Use a unique --approver ID.`);
  }

  fs.mkdirSync(path.dirname(privOutAbs), { recursive: true });
  fs.writeFileSync(privOutAbs, privateKeyPem, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (pubOutAbs) {
    fs.mkdirSync(path.dirname(pubOutAbs), { recursive: true });
    fs.writeFileSync(pubOutAbs, publicKeyPem, { encoding: "utf8", mode: 0o644, flag: "wx" });
  }

  const regAbs = assertSafeWithinRoot(projectDir, registry.relPath);
  assertSafeAncestorChain(regAbs, projectDir, registry.relPath);
  const updated = {
    schema_version: "1.0",
    approvers: [
      ...registry.approvers,
      {
        approver_id: approverId,
        algorithm: "ed25519",
        key_fingerprint: keyFingerprint,
        created_at: createdAt,
        public_key_pem: publicKeyPem,
      },
    ],
  };
  atomicWriteFile(regAbs, serializeYaml(updated, { headerComment: "Registered Ed25519 public keys ONLY — never commit private keys" }), {
    allowOverwrite: true,
  });

  return {
    approverId,
    keyFingerprint,
    publicKeyPem,
    registryPath: registry.relPath,
    privateKeyPath: privOutAbs,
    publicKeyPath: pubOutAbs,
    createdAt,
  };
}

function buildApprovalSigningPayload({
  projectId,
  action,
  skillName,
  proposalId,
  targetRevision,
  contentSha256,
  baseSha256,
  evidenceDigests,
  approverId,
  decidedAt,
  expiresAt,
}) {
  return JSON.stringify({
    version: 1,
    project_id: projectId,
    action,
    skill_name: skillName,
    proposal_id: proposalId || null,
    target_revision: targetRevision || null,
    content_sha256: contentSha256,
    base_sha256: baseSha256 || null,
    evidence_digests: [...(evidenceDigests || [])].sort(),
    approver_id: approverId,
    decided_at: decidedAt,
    expires_at: expiresAt || null,
  });
}

/**
 * Resolves exact content SHA-256, base SHA-256, and verified evidence digests for a pending promotion proposal.
 */
function inspectProposalForGate(projectDir, projectPaths, skillName, harnessDir) {
  const proposalRel = `${projectPaths.proposals_dir}/skills/${skillName}`;
  const proposalDir = assertSafeWithinRoot(projectDir, proposalRel);
  if (!fs.existsSync(proposalDir)) {
    throw new Error(`Proposal directory not found: ${proposalRel}`);
  }
  const metaRel = `${projectPaths.proposals_dir}/skills/.proposals/${skillName}.yaml`;
  const loadedMeta = readSafeYamlWithinProject(projectDir, metaRel);
  if (!loadedMeta || !loadedMeta.data) {
    throw new Error(`Proposal metadata missing: ${metaRel}. Refusing untrusted proposal without provenance.`);
  }
  const meta = loadedMeta.data;
  if (meta.status !== "draft") {
    throw new Error(`Proposal "${skillName}" is not in "draft" status (got "${meta.status}").`);
  }
  if (meta.skill_name !== skillName) {
    throw new Error(`Proposal metadata skill_name "${meta.skill_name}" mismatches "${skillName}".`);
  }

  // Re-verify referenced evidence & handoffs fail-closed
  const sourceEvIds = (meta.source_evidence || []).map((e) => e.id).filter(Boolean);
  const sourceHoIds = (meta.source_handoffs || []).map((h) => h.id).filter(Boolean);
  const bundle = loadVerifiedSourceBundle({
    projectDir,
    evidenceIds: sourceEvIds,
    handoffIds: sourceHoIds,
    harnessDir,
  });

  // Verify stored evidence SHA-256s match live evidence on disk
  for (const se of meta.source_evidence || []) {
    const live = bundle.evidenceList.find((e) => e.data.id === se.id);
    if (!live || live.sha256 !== se.sha256) {
      throw new Error(`Evidence ${se.id} changed or missing since proposal was created (fail-closed).`);
    }
  }
  for (const sh of meta.source_handoffs || []) {
    const liveH = bundle.handoffRecords.find((h) => h.data.id === sh.id);
    if (!liveH || liveH.sha256 !== sh.sha256) {
      throw new Error(`Handoff ${sh.id} changed or missing since proposal was created (fail-closed).`);
    }
  }

  const verified = validateAndLintSkillStaging({
    stageDir: proposalDir,
    skillName,
    displayRoot: `${projectPaths.proposals_dir}/skills`,
  });

  if (verified.digestInfo.digest !== meta.candidate_digest) {
    throw new Error(
      `Proposal content digest mismatch for "${skillName}" (disk=${verified.digestInfo.digest} vs meta=${meta.candidate_digest}); refusing modified proposal.`
    );
  }

  const activeRel = `.agents/skills/${skillName}`;
  const activeDir = assertSafeWithinRoot(projectDir, activeRel);
  const activeExists = fs.existsSync(activeDir);
  let currentBaseSha = null;
  if (activeExists) {
    currentBaseSha = computeSkillPackageDigest(activeDir).digest;
  }

  if (meta.kind === "new_skill") {
    if (activeExists) {
      throw new Error(`Conflict: active skill "${skillName}" now exists at ${activeRel}; refusing new_skill promotion.`);
    }
  } else if (meta.kind === "update_skill") {
    if (!activeExists) {
      throw new Error(`Active skill "${skillName}" missing at ${activeRel}; update proposal cannot apply.`);
    }
    if (currentBaseSha !== meta.base_skill_digest) {
      throw new Error(
        `Stale/concurrent update conflict: active skill "${skillName}" digest (${currentBaseSha}) no longer matches proposal base (${meta.base_skill_digest}).`
      );
    }
  } else {
    throw new Error(`Unsupported proposal kind "${meta.kind}".`);
  }

  return {
    proposalRel,
    proposalDir,
    metaRel,
    meta,
    bundle,
    candidateDigest: verified.digestInfo.digest,
    currentBaseSha,
    action: meta.kind === "new_skill" ? "promote_new" : "promote_update",
  };
}

function createApprovalRecordFile({
  projectDir,
  schemasDir,
  projectPaths,
  title,
  status,
  boundaryCategory,
  requestedBy,
  decidedBy,
  timestamp,
  expiresAt,
  targetRecords,
  rationale,
  riskAssessment,
  conditions,
  skillAuthorization,
  slugHint,
}) {
  const { id } = scanAndAllocateRecordId({
    projectDir,
    searchDirs: [projectPaths.proposals_dir, projectPaths.decisions_dir],
    prefix: "APPR",
  });
  const record = {
    schema_version: "1.1",
    id,
    title,
    status,
    memory_layer: "L2_OPERATIONAL",
    authority_level: "A4",
    boundary_category: boundaryCategory,
    requested_by: requestedBy,
    requested_at: timestamp,
    decided_by: decidedBy,
    decided_at: status === "approved" ? timestamp : null,
    expires_at: expiresAt || null,
    target_records: targetRecords,
    rationale,
    risk_assessment: riskAssessment,
    conditions,
    skill_authorization: skillAuthorization,
  };

  const schema = loadSchema(schemasDir, "approval-record.schema.json");
  const valid = validateAgainstSchema(record, schema);
  if (!valid.valid) {
    throw new Error(`Internal APPR record failed schema validation: ${valid.errors.join("; ")}`);
  }

  const slug = deriveSlug(slugHint || title) || "skill-approval";
  const relPath = `${projectPaths.proposals_dir}/${id}-${slug}.yaml`;
  const absPath = assertSafeWithinRoot(projectDir, relPath);
  atomicWriteFile(absPath, serializeYaml(record, { headerComment: "GeloForge skill authorization record" }), {
    allowOverwrite: false,
  });
  return { id, relPath, absPath, record };
}

/**
 * Phase 5: Cryptographically signs an approval (APPR-NNNN) bound to exact content SHA-256,
 * base SHA-256, source evidence digests, action, and approver identity.
 */
export function signSkillApproval(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
  const { projectDir, schemasDir, manifest, projectPaths } = loaded;

  const decidedAt = validateCreatedAt(options.decidedAt);
  let expiresAt = null;
  if (options.expiresAt) {
    expiresAt = validateCreatedAt(options.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(decidedAt)) {
      throw new Error(`--expires-at (${expiresAt}) must be after --decided-at (${decidedAt}).`);
    }
  }

  const approverId = validateScalarText("--approver", options.approverId);
  const privKeyAbs = validateExternalFileReadPath(options.privateKeyPath, projectDir, "--key", { forbidInsideRepo: true });
  const privateKeyObj = crypto.createPrivateKey(fs.readFileSync(privKeyAbs, "utf8"));
  if (privateKeyObj.asymmetricKeyType !== "ed25519") {
    throw new Error(`Private key must be Ed25519 (got ${privateKeyObj.asymmetricKeyType}).`);
  }
  const derivedPubPem = crypto.createPublicKey(privateKeyObj).export({ type: "spki", format: "pem" });
  const keyFingerprint = `ed25519:${sha256Hex(derivedPubPem).slice(0, 16)}`;

  const registry = loadApproversRegistry(projectDir);
  const regEntry = registry.approvers.find((a) => a.approver_id === approverId);
  if (!regEntry) {
    throw new Error(`Approver "${approverId}" is not registered in ${registry.relPath}. Run "geloforge skills keygen" first.`);
  }
  if (regEntry.key_fingerprint !== keyFingerprint) {
    throw new Error(`Private key fingerprint (${keyFingerprint}) does not match registered key (${regEntry.key_fingerprint}) for "${approverId}".`);
  }

  const reqAction = options.action || "promote";
  let boundAction;
  let skillName;
  let proposalId = null;
  let targetRevision = null;
  let contentSha256;
  let baseSha256 = null;
  let evidenceDigests = [];
  let targetRecords = [];

  if (reqAction === "promote") {
    skillName = validateSkillSlugName(options.skillName || options.proposalName);
    const gate = inspectProposalForGate(projectDir, projectPaths, skillName, harnessDir);
    boundAction = gate.action;
    proposalId = gate.meta.proposal_id;
    contentSha256 = gate.candidateDigest;
    baseSha256 = gate.currentBaseSha;
    evidenceDigests = gate.bundle.evidenceDigests;
    targetRecords = [gate.proposalRel, ...gate.bundle.evidenceList.map((e) => e.relPath)];
  } else if (reqAction === "rollback") {
    skillName = validateSkillSlugName(options.skillName);
    targetRevision = String(options.targetRevision || "").trim();
    const gate = inspectRollbackSnapshotForGate(projectDir, skillName, targetRevision);
    boundAction = "rollback";
    contentSha256 = gate.targetDigest;
    baseSha256 = gate.currentBaseSha;
    evidenceDigests = Array.isArray(gate.entry.evidence_digests) ? gate.entry.evidence_digests : [];
    targetRecords = [gate.snapshotRel, gate.histInfo.histRel];
  } else {
    throw new Error(`Invalid --action "${reqAction}". Expected: promote or rollback.`);
  }

  const payloadStr = buildApprovalSigningPayload({
    projectId: manifest.project_id,
    action: boundAction,
    skillName,
    proposalId,
    targetRevision,
    contentSha256,
    baseSha256,
    evidenceDigests,
    approverId,
    decidedAt,
    expiresAt,
  });
  const signatureBase64 = crypto.sign(null, Buffer.from(payloadStr, "utf8"), privateKeyObj).toString("base64");

  const rationale = validateScalarText(
    "--rationale",
    options.rationale || `Reviewed ${boundAction} for skill "${skillName}" at ${contentSha256.slice(0, 19)}.`
  );
  const riskAssessment = validateScalarText(
    "--risk-assessment",
    options.riskAssessment || "Static lint passed; skill remains A5 non-authoritative with zero auto-execution."
  );

  const appr = createApprovalRecordFile({
    projectDir,
    schemasDir,
    projectPaths,
    title: `${boundAction} ${skillName}`.slice(0, 80),
    status: "approved",
    boundaryCategory: boundAction === "rollback" ? "destructive_action" : "security_boundary",
    requestedBy: options.requestedBy || approverId,
    decidedBy: approverId,
    timestamp: decidedAt,
    expiresAt,
    targetRecords,
    rationale,
    riskAssessment,
    conditions: ["Valid only while content_sha256, base_sha256, and source evidence digests remain unchanged."],
    skillAuthorization: {
      action: boundAction,
      skill_name: skillName,
      proposal_id: proposalId,
      target_revision: targetRevision,
      content_sha256: contentSha256,
      base_sha256: baseSha256,
      evidence_digests: evidenceDigests,
      authorization_tier: "cryptographic_ed25519",
      approver_id: approverId,
      key_fingerprint: keyFingerprint,
      signature_algorithm: "ed25519",
      signature_base64: signatureBase64,
    },
    slugHint: `${boundAction}-${skillName}`,
  });

  return {
    approvalId: appr.id,
    relPath: appr.relPath,
    action: boundAction,
    skillName,
    targetRevision,
    contentSha256,
    baseSha256,
    approverId,
    keyFingerprint,
  };
}

function assertValidIsoTimestamp(value, fieldLabel) {
  if (typeof value !== "string" || value.trim().length < 10) {
    throw new Error(`Invalid or missing ISO-8601 timestamp for ${fieldLabel}: "${value}".`);
  }
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO-8601 timestamp for ${fieldLabel}: "${value}".`);
  }
  return parsed;
}

/**
 * Verifies a cryptographic Ed25519 APPR-NNNN approval record fail-closed.
 */
export function verifySignedSkillApproval({
  projectDir,
  projectPaths,
  schemasDir,
  projectId,
  approvalId,
  expectedAction,
  skillName,
  expectedProposalId = null,
  targetRevision = null,
  expectedContentSha256,
  expectedBaseSha256 = null,
  expectedEvidenceDigests = [],
  publicKeyPath = null,
  nowIso = new Date().toISOString(),
}) {
  const loadedAppr = findRecordYamlById(projectDir, projectPaths.proposals_dir, "APPR", approvalId);
  const appr = loadedAppr.data;
  const schemaRes = validateAgainstSchema(appr, loadSchema(schemasDir, "approval-record.schema.json"));
  if (!schemaRes.valid) {
    throw new Error(`${loadedAppr.relPath}: invalid APPR schema: ${schemaRes.errors.join("; ")}`);
  }
  if (appr.is_example === true) {
    throw new Error(`${loadedAppr.relPath}: example approval cannot authorize skills.`);
  }
  if (appr.status !== "approved") {
    throw new Error(`${loadedAppr.relPath}: approval status is "${appr.status}", expected "approved".`);
  }

  const consumed = findConsumedApprovalInHistory(projectDir, loadedAppr.data.id);
  if (consumed) {
    throw new Error(
      `Approval replay refused (${loadedAppr.relPath}): ${loadedAppr.data.id} was already consumed by skill "${consumed.skillName}" (${consumed.revision} in ${consumed.histRel}). Sign a fresh approval.`
    );
  }

  assertValidIsoTimestamp(appr.decided_at, `${loadedAppr.relPath}: decided_at`);
  const nowMs = assertValidIsoTimestamp(nowIso, "nowIso");
  if (appr.expires_at !== null && appr.expires_at !== undefined) {
    const expiresMs = assertValidIsoTimestamp(appr.expires_at, `${loadedAppr.relPath}: expires_at`);
    if (expiresMs < nowMs) {
      throw new Error(`${loadedAppr.relPath}: approval expired at ${appr.expires_at}.`);
    }
  }

  const sa = appr.skill_authorization;
  if (!sa || sa.authorization_tier !== "cryptographic_ed25519") {
    throw new Error(
      `${loadedAppr.relPath}: authorization_tier "${sa?.authorization_tier || "missing"}" is not cryptographic_ed25519; unsigned text approvals cannot bypass human authorization.`
    );
  }
  if (sa.signature_algorithm !== "ed25519" || !sa.signature_base64 || !sa.approver_id || !sa.key_fingerprint) {
    throw new Error(`${loadedAppr.relPath}: incomplete Ed25519 signature metadata.`);
  }
  if (appr.decided_by !== sa.approver_id) {
    throw new Error(
      `${loadedAppr.relPath}: decided_by "${appr.decided_by}" mismatches skill_authorization.approver_id "${sa.approver_id}".`
    );
  }
  if (sa.action !== expectedAction || sa.skill_name !== skillName) {
    throw new Error(
      `${loadedAppr.relPath}: bound to action="${sa.action}" skill="${sa.skill_name}", expected action="${expectedAction}" skill="${skillName}".`
    );
  }
  if (expectedProposalId !== null && sa.proposal_id !== expectedProposalId) {
    throw new Error(
      `${loadedAppr.relPath}: bound proposal_id "${sa.proposal_id}" mismatches "${expectedProposalId}".`
    );
  }
  if ((sa.target_revision || null) !== (targetRevision || null)) {
    throw new Error(`${loadedAppr.relPath}: bound target_revision "${sa.target_revision}" mismatches "${targetRevision}".`);
  }
  if (sa.content_sha256 !== expectedContentSha256) {
    throw new Error(
      `Approval digest mismatch (${loadedAppr.relPath}): signed ${sa.content_sha256}, current ${expectedContentSha256}. Re-review and re-sign.`
    );
  }
  if ((sa.base_sha256 || null) !== (expectedBaseSha256 || null)) {
    throw new Error(
      `Stale approval (${loadedAppr.relPath}): signed base_sha256=${sa.base_sha256 || "null"} does not match current active skill base=${expectedBaseSha256 || "null"}.`
    );
  }
  const signedEv = JSON.stringify([...(sa.evidence_digests || [])].sort());
  const curEv = JSON.stringify([...(expectedEvidenceDigests || [])].sort());
  if (signedEv !== curEv) {
    throw new Error(`Approval evidence binding mismatch (${loadedAppr.relPath}): source evidence changed after signing.`);
  }

  if (typeof sa.signature_base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(sa.signature_base64)) {
    throw new Error(`Cryptographic Ed25519 signature verification failed for ${loadedAppr.relPath}: malformed base64 encoding.`);
  }
  const sigBuf = Buffer.from(sa.signature_base64, "base64");
  if (sigBuf.length !== 64) {
    throw new Error(
      `Cryptographic Ed25519 signature verification failed for ${loadedAppr.relPath}: invalid signature byte length (${sigBuf.length}, expected 64).`
    );
  }

  let trustedPubPem;
  let trustedFingerprint;
  let keyTrustSource;
  let inRepoRegistryDirty = false;
  if (publicKeyPath) {
    keyTrustSource = "external_pinned_public_key";
    const pubAbs = validateExternalFileReadPath(publicKeyPath, projectDir, "--public-key", { forbidInsideRepo: false });
    const rawPubPem = fs.readFileSync(pubAbs, "utf8");
    if (hasSecretContent(rawPubPem)) {
      throw new Error("--public-key file must contain only an SPKI public key, never private key material.");
    }
    let pubObj;
    try {
      pubObj = crypto.createPublicKey(rawPubPem);
    } catch {
      throw new Error(`Unparseable --public-key PEM file: ${pubAbs}`);
    }
    if (pubObj.asymmetricKeyType !== "ed25519") {
      throw new Error(`Pinned --public-key must be Ed25519 (got ${pubObj.asymmetricKeyType}).`);
    }
    trustedPubPem = pubObj.export({ type: "spki", format: "pem" });
    trustedFingerprint = `ed25519:${sha256Hex(trustedPubPem).slice(0, 16)}`;
    if (trustedFingerprint !== sa.key_fingerprint) {
      throw new Error(`Pinned --public-key fingerprint (${trustedFingerprint}) mismatches approval (${sa.key_fingerprint}).`);
    }
  } else {
    keyTrustSource = "in_repo_registry";
    const registry = loadApproversRegistry(projectDir);
    const regEntry = registry.approvers.find((a) => a.approver_id === sa.approver_id);
    if (!regEntry) {
      throw new Error(`Approver "${sa.approver_id}" not found in ${registry.relPath}.`);
    }
    let regPubObj;
    try {
      regPubObj = crypto.createPublicKey(regEntry.public_key_pem);
    } catch {
      throw new Error(`Unparseable public key for approver "${sa.approver_id}" in ${registry.relPath}.`);
    }
    if (regPubObj.asymmetricKeyType !== "ed25519") {
      throw new Error(`Registered key for approver "${sa.approver_id}" must be Ed25519.`);
    }
    trustedPubPem = regPubObj.export({ type: "spki", format: "pem" });
    trustedFingerprint = `ed25519:${sha256Hex(trustedPubPem).slice(0, 16)}`;
    const rawFp = `ed25519:${sha256Hex(regEntry.public_key_pem).slice(0, 16)}`;
    if (
      regEntry.key_fingerprint !== sa.key_fingerprint ||
      (trustedFingerprint !== sa.key_fingerprint && rawFp !== sa.key_fingerprint)
    ) {
      throw new Error(`Public key fingerprint mismatch for approver "${sa.approver_id}".`);
    }
    const gitInfo = getGitRepoInfo(projectDir);
    if (gitInfo.available) {
      const gs = getGitStatusScoped(projectDir);
      inRepoRegistryDirty = gs.changedFiles.includes(registry.relPath);
    }
  }

  const payloadStr = buildApprovalSigningPayload({
    projectId,
    action: sa.action,
    skillName: sa.skill_name,
    proposalId: sa.proposal_id,
    targetRevision: sa.target_revision,
    contentSha256: sa.content_sha256,
    baseSha256: sa.base_sha256,
    evidenceDigests: sa.evidence_digests,
    approverId: sa.approver_id,
    decidedAt: appr.decided_at,
    expiresAt: appr.expires_at,
  });
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(payloadStr, "utf8"),
      crypto.createPublicKey(trustedPubPem),
      sigBuf
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(`Cryptographic Ed25519 signature verification failed for ${loadedAppr.relPath}.`);
  }

  return {
    approvalId: loadedAppr.data.id,
    relPath: loadedAppr.relPath,
    tier: "cryptographic_ed25519",
    approverId: sa.approver_id,
    keyFingerprint: sa.key_fingerprint,
    keyTrustSource,
    inRepoRegistryDirty,
  };
}

function assertAuthorizedOperation({
  projectDir,
  projectPaths,
  schemasDir,
  manifest,
  expectedAction,
  skillName,
  expectedProposalId = null,
  targetRevision = null,
  contentSha256,
  baseSha256,
  evidenceDigests,
  targetRecords,
  approvalId,
  publicKeyPath = null,
  mode,
  branch,
  approvedBy,
  interactiveConfirm,
  timestamp,
  slugHint,
  rationale,
}) {
  if (approvedBy) {
    throw new Error(
      `Security refusal: self-reported --approved-by "${approvedBy}" cannot authorize "${expectedAction}". Use --approval <APPR-NNNN> (Ed25519), --mode pr-branch, or explicit --interactive TTY confirmation.`
    );
  }
  if (approvalId && mode) {
    throw new Error("Cannot combine --approval with --mode or --interactive; specify exactly one authorization mode.");
  }
  if (publicKeyPath && !approvalId) {
    throw new Error("--public-key requires --approval <APPR-NNNN>.");
  }

  const chosenMode = approvalId ? "approval" : mode || null;
  if (!chosenMode || !ALLOWED_AUTHORIZATION_MODES.has(chosenMode)) {
    throw new Error(
      `Authorization required for "${expectedAction}" on "${skillName}". Supply one of: --approval <APPR-NNNN>, --mode pr-branch, or --interactive (real TTY).`
    );
  }

  if (chosenMode === "approval") {
    const verified = verifySignedSkillApproval({
      projectDir,
      projectPaths,
      schemasDir,
      projectId: manifest.project_id,
      approvalId,
      expectedAction,
      skillName,
      expectedProposalId,
      targetRevision,
      expectedContentSha256: contentSha256,
      expectedBaseSha256: baseSha256,
      expectedEvidenceDigests: evidenceDigests,
      publicKeyPath,
      nowIso: timestamp,
    });
    return {
      tier: "cryptographic_ed25519",
      approvalId: verified.approvalId,
      approvalRelPath: verified.relPath,
      approverId: verified.approverId,
      keyFingerprint: verified.keyFingerprint,
      keyTrustSource: verified.keyTrustSource,
      inRepoRegistryDirty: verified.inRepoRegistryDirty,
      prBranch: null,
    };
  }

  if (chosenMode === "interactive") {
    if (typeof interactiveConfirm !== "function") {
      throw new Error("--interactive requires an interactive TTY confirmation handler.");
    }
    const token = `${expectedAction === "rollback" ? "rollback" : "promote"} ${skillName} ${contentSha256.slice(7, 15)}`;
    const confirmed = interactiveConfirm({
      action: expectedAction,
      skillName,
      targetRevision,
      contentSha256,
      baseSha256,
      expectedInput: token,
    });
    if (confirmed !== true) {
      throw new Error(`Interactive confirmation aborted or did not match "${token}".`);
    }
    const appr = createApprovalRecordFile({
      projectDir,
      schemasDir,
      projectPaths,
      title: `Interactive ${expectedAction} ${skillName}`.slice(0, 80),
      status: "approved",
      boundaryCategory: expectedAction === "rollback" ? "destructive_action" : "security_boundary",
      requestedBy: "local-operator",
      decidedBy: "local-interactive-tty",
      timestamp,
      expiresAt: null,
      targetRecords,
      rationale,
      riskAssessment:
        "LOCAL CONVENIENCE AUTHORIZATION ONLY: TTY confirmation is weaker than independent Ed25519 signatures or protected-branch PR reviews and relies on local operator integrity.",
      conditions: [
        "Not cryptographically signed.",
        `Confirmed interactive prompt digest ${contentSha256.slice(0, 19)}.`,
      ],
      skillAuthorization: {
        action: expectedAction,
        skill_name: skillName,
        proposal_id: expectedAction === "rollback" ? null : `PROP-${skillName}`,
        target_revision: targetRevision,
        content_sha256: contentSha256,
        base_sha256: baseSha256,
        evidence_digests: evidenceDigests,
        authorization_tier: "local_interactive_tty",
        approver_id: "local-interactive-tty",
        key_fingerprint: null,
        signature_algorithm: null,
        signature_base64: null,
      },
      slugHint,
    });
    return {
      tier: "local_interactive_tty",
      approvalId: appr.id,
      approvalRelPath: appr.relPath,
      approverId: "local-interactive-tty",
      keyFingerprint: null,
      keyTrustSource: null,
      inRepoRegistryDirty: false,
      prBranch: null,
    };
  }

  // pr-branch mode: verify clean Git root (aside from proposals/skills/) and prepare dedicated branch + pending APPR
  const gitInfo = getGitRepoInfo(projectDir);
  if (!gitInfo.available || !gitInfo.isRepoRoot) {
    throw new Error("--mode pr-branch requires the project directory to be a Git repository root.");
  }
  if (gitInfo.unborn) {
    throw new Error("--mode pr-branch requires an existing base commit (HEAD is unborn). Commit initial files first.");
  }
  const gs = getGitStatusScoped(projectDir);
  const proposalsSkillsPrefix = `${projectPaths.proposals_dir.replace(/\\/g, "/")}/skills/`;
  const outsideDirty = gs.changedFiles.filter((f) => !f.startsWith(proposalsSkillsPrefix));
  if (outsideDirty.length > 0) {
    throw new Error(
      `--mode pr-branch requires a clean Git working tree outside ${proposalsSkillsPrefix}. Dirty files: ${outsideDirty.join(", ")}`
    );
  }

  const defaultBranch = `skill-${expectedAction === "rollback" ? "rollback" : "promote"}/${skillName}-${contentSha256.slice(7, 15)}`;
  const targetBranch = validateScalarText("--branch", branch || defaultBranch);
  if (/\s|\.\./.test(targetBranch)) {
    throw new Error(`Invalid Git branch name "${targetBranch}".`);
  }

  // Fail closed BEFORE mutating any skill files if targetBranch already exists
  try {
    execFileSync("git", ["-C", projectDir, "show-ref", "--verify", "--quiet", `refs/heads/${targetBranch}`], {
      windowsHide: true,
      stdio: "ignore",
    });
    throw new Error(`Git branch "${targetBranch}" already exists. Specify a different --branch.`);
  } catch (err) {
    if (err.message && err.message.startsWith("Git branch ")) {
      throw err;
    }
  }

  return {
    tier: "git_pr_review_pending",
    approvalId: null,
    approvalRelPath: null,
    approverId: null,
    keyFingerprint: null,
    keyTrustSource: null,
    inRepoRegistryDirty: false,
    prBranch: targetBranch,
  };
}

function isTrackedInGitHead(projectDir, relPath) {
  try {
    execFileSync("git", ["-C", projectDir, "ls-files", "--error-unmatch", "--", relPath], {
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared transactional staging, history ledger update, atomic swap, proposal retirement,
 * and optional PR-branch commit helper with full failure rollback.
 */
function applyAuthorizedSkillPackageChange({
  projectDir,
  projectPaths,
  schemasDir,
  sourcePackageDir,
  expectedDigest,
  baseSha256,
  skillName,
  action,
  auth,
  evidenceDigests,
  timestamp,
  restoredFromRevision = null,
  reason,
  targetRecords,
  proposalMetaUpdate = null,
  extraStagePaths = [],
}) {
  const activeRel = `.agents/skills/${skillName}`;
  const activeAbs = assertSafeWithinRoot(projectDir, activeRel);
  const skillsParentAbs = path.dirname(activeAbs);
  fs.mkdirSync(skillsParentAbs, { recursive: true });
  assertSafeDirNonSymlink(skillsParentAbs, ".agents/skills");

  const stageDir = path.join(skillsParentAbs, `.geloforge-stage-${crypto.randomBytes(6).toString("hex")}`);
  let checkedOutPrBranch = false;
  let origHeadRef = null;
  let pendingAppr = null;
  let revInfo = null;
  let swapHandle = null;
  let proposalBackupDir = null;
  let origMetaRaw = null;
  let metaAbs = null;
  let prDetails = null;

  try {
    if (auth.tier === "git_pr_review_pending") {
      const curBranch = execFileSync("git", ["-C", projectDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      origHeadRef =
        curBranch === "HEAD"
          ? execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
              encoding: "utf8",
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            }).trim()
          : curBranch;

      execFileSync("git", ["-C", projectDir, "checkout", "-b", auth.prBranch], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      checkedOutPrBranch = true;

      pendingAppr = createApprovalRecordFile({
        projectDir,
        schemasDir,
        projectPaths,
        title: `PR Review Pending ${action} ${skillName}`.slice(0, 80),
        status: "pending",
        boundaryCategory: action === "rollback" ? "destructive_action" : "security_boundary",
        requestedBy: "geloforge-cli",
        decidedBy: null,
        timestamp,
        expiresAt: null,
        targetRecords,
        rationale: reason,
        riskAssessment:
          "STAGED ON REVIEW BRANCH ONLY: Requires repository branch protection and an independent human PR approval before merging to main. Without protected-branch enforcement, Git PR review is advisory only.",
        conditions: [
          `Must be merged to protected main after human review on branch ${auth.prBranch}.`,
          `Verify ${expectedDigest} matches reviewed .agents/skills/${skillName}.`,
        ],
        skillAuthorization: {
          action,
          skill_name: skillName,
          proposal_id: action === "rollback" ? null : `PROP-${skillName}`,
          target_revision: restoredFromRevision,
          content_sha256: expectedDigest,
          base_sha256: baseSha256,
          evidence_digests: evidenceDigests,
          authorization_tier: "git_pr_review_pending",
          approver_id: null,
          key_fingerprint: null,
          signature_algorithm: null,
          signature_base64: null,
        },
        slugHint: `pr-${action}-${skillName}`,
      });
    }

    copyTreeSafe(sourcePackageDir, stageDir);
    if (computeSkillPackageDigest(stageDir).digest !== expectedDigest) {
      throw new Error(`Staged package digest mismatch; aborting ${action}.`);
    }

    const effectiveApprovalId = pendingAppr ? pendingAppr.id : auth.approvalId;
    revInfo = recordHistoryRevision({
      projectDir,
      skillName,
      action,
      sourceDirToSnapshot: stageDir,
      packageSha256: expectedDigest,
      baseSha256,
      approvalId: effectiveApprovalId,
      authorizationTier: auth.tier,
      approverId: auth.approverId,
      evidenceDigests,
      createdAt: timestamp,
      restoredFromRevision,
      reason,
    });

    swapHandle = stageAtomicSwap(stageDir, activeAbs);

    if (proposalMetaUpdate) {
      metaAbs = assertSafeWithinRoot(projectDir, proposalMetaUpdate.metaRel);
      origMetaRaw = fs.existsSync(metaAbs) ? fs.readFileSync(metaAbs, "utf8") : null;
      const updatedMeta = {
        ...proposalMetaUpdate.meta,
        status: auth.tier === "git_pr_review_pending" ? "pending_pr_review" : "promoted",
        promoted_at: timestamp,
        promoted_revision: revInfo.revision,
        authorization_tier: auth.tier,
        approval_ref: effectiveApprovalId,
      };
      atomicWriteFile(metaAbs, serializeYaml(updatedMeta), { allowOverwrite: true });
      const propParent = path.dirname(proposalMetaUpdate.proposalDir);
      proposalBackupDir = path.join(propParent, `.geloforge-prop-backup-${crypto.randomBytes(6).toString("hex")}`);
      renameSyncRetry(proposalMetaUpdate.proposalDir, proposalBackupDir);
    }

    if (auth.tier === "git_pr_review_pending") {
      const startBranch = getGitRepoInfo(projectDir).branch || auth.prBranch;
      const snapRels = (revInfo.createdSnapshotDirs || []).map((abs) => path.relative(projectDir, abs).replace(/\\/g, "/"));
      const stageList = Array.from(
        new Set([activeRel, revInfo.historyRel, ...snapRels, ...extraStagePaths, pendingAppr.relPath])
      ).filter((rel) => fs.existsSync(assertSafeWithinRoot(projectDir, rel)) || isTrackedInGitHead(projectDir, rel));

      execFileSync("git", ["-C", projectDir, "add", "--all", "--", ...stageList], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync(
        "git",
        ["-C", projectDir, "commit", "-m", `skills(${skillName}): ${action} (${expectedDigest.slice(0, 19)})`],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
      const commitSha = execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      prDetails = {
        approvalId: pendingAppr.id,
        approvalRelPath: pendingAppr.relPath,
        branch: startBranch,
        commitSha,
      };
    }

    swapHandle.commit();
    if (proposalBackupDir) {
      removeDirSafe(proposalBackupDir);
    }
  } catch (err) {
    try {
      if (swapHandle) swapHandle.rollback();
    } catch {
      // Best-effort restore
    }
    try {
      if (proposalBackupDir && fs.existsSync(proposalBackupDir) && proposalMetaUpdate && !fs.existsSync(proposalMetaUpdate.proposalDir)) {
        renameSyncRetry(proposalBackupDir, proposalMetaUpdate.proposalDir);
      }
    } catch {
      // Best-effort restore
    }
    try {
      if (metaAbs) {
        if (origMetaRaw !== null) {
          atomicWriteFile(metaAbs, origMetaRaw, { allowOverwrite: true });
        } else if (fs.existsSync(metaAbs)) {
          fs.rmSync(metaAbs, { force: true });
        }
      }
    } catch {
      // Best-effort restore
    }
    try {
      if (revInfo) {
        if (revInfo.previousHistoryRaw !== null) {
          atomicWriteFile(revInfo.historyAbs, revInfo.previousHistoryRaw, { allowOverwrite: true });
        } else if (fs.existsSync(revInfo.historyAbs)) {
          fs.rmSync(revInfo.historyAbs, { force: true });
        }
        for (const sDir of revInfo.createdSnapshotDirs || []) {
          removeDirSafe(sDir);
        }
      }
    } catch {
      // Best-effort restore
    }
    try {
      if (pendingAppr && fs.existsSync(pendingAppr.absPath)) {
        fs.rmSync(pendingAppr.absPath, { force: true });
      }
    } catch {
      // Best-effort restore
    }
    removeDirSafe(stageDir);
    if (checkedOutPrBranch && origHeadRef) {
      try {
        execFileSync("git", ["-C", projectDir, "reset", "--mixed"], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync("git", ["-C", projectDir, "checkout", origHeadRef], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync("git", ["-C", projectDir, "branch", "-D", auth.prBranch], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // Best-effort Git branch cleanup
      }
    }
    throw err;
  }

  let authorizationWarning = null;
  if (auth.tier === "local_interactive_tty") {
    authorizationWarning =
      "Authorized via local TTY confirmation (weaker than independent Ed25519 signature or protected-branch PR review).";
  } else if (auth.tier === "git_pr_review_pending") {
    authorizationWarning = `Committed on branch "${prDetails.branch}" ONLY (not pushed). Security depends on Git branch protection & required human PR reviews before merging.`;
  } else if (auth.tier === "cryptographic_ed25519" && auth.keyTrustSource === "in_repo_registry") {
    authorizationWarning =
      `Verified against mutable in-repo .geloforge/approvers.yaml${auth.inRepoRegistryDirty ? " (uncommitted in Git)" : ""}. ` +
      "Local processes/agents with workspace write access can run keygen or edit this file; pin external --public-key <file> or enforce protected-branch PR reviews + CODEOWNERS for independent human authorization.";
  }

  return {
    activeRel,
    revInfo,
    prDetails,
    authorizationWarning,
  };
}

/**
 * Phase 5: Promotes a quarantined proposal into `.agents/skills/<name>/` after verifying
 * proposal integrity, evidence hashes, strict lint, base digest, and human authorization.
 */
export function promoteSkillProposal(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
  const { projectDir, schemasDir, manifest, projectPaths } = loaded;
  const skillName = validateSkillSlugName(options.proposalName || options.skillName);
  const timestamp = validateCreatedAt(options.createdAt);

  const gate = inspectProposalForGate(projectDir, projectPaths, skillName, harnessDir);

  if (options.dryRun) {
    return {
      dryRun: true,
      action: gate.action,
      skillName,
      candidateDigest: gate.candidateDigest,
      baseSha256: gate.currentBaseSha,
      evidenceDigests: gate.bundle.evidenceDigests,
      proposalDir: gate.proposalRel,
    };
  }

  const auth = assertAuthorizedOperation({
    projectDir,
    projectPaths,
    schemasDir,
    manifest,
    expectedAction: gate.action,
    skillName,
    expectedProposalId: gate.meta.proposal_id,
    targetRevision: null,
    contentSha256: gate.candidateDigest,
    baseSha256: gate.currentBaseSha,
    evidenceDigests: gate.bundle.evidenceDigests,
    targetRecords: [gate.proposalRel, ...gate.bundle.evidenceList.map((e) => e.relPath)],
    approvalId: options.approvalId,
    publicKeyPath: options.publicKeyPath,
    mode: options.mode,
    branch: options.branch,
    approvedBy: options.approvedBy,
    interactiveConfirm: options.interactiveConfirm,
    timestamp,
    slugHint: `${gate.action}-${skillName}`,
    rationale: gate.meta.reason || `Promote ${skillName} backed by ${gate.bundle.evidenceDigests.join(", ")}.`,
  });

  const activeRel = `.agents/skills/${skillName}`;
  const applied = applyAuthorizedSkillPackageChange({
    projectDir,
    projectPaths,
    schemasDir,
    sourcePackageDir: gate.proposalDir,
    expectedDigest: gate.candidateDigest,
    baseSha256: gate.currentBaseSha,
    skillName,
    action: gate.action,
    auth,
    evidenceDigests: gate.bundle.evidenceDigests,
    timestamp,
    restoredFromRevision: null,
    reason: gate.meta.reason,
    targetRecords: [activeRel, ...gate.bundle.evidenceList.map((e) => e.relPath)],
    extraStagePaths: [gate.metaRel, gate.proposalRel],
    proposalMetaUpdate: {
      metaRel: gate.metaRel,
      meta: gate.meta,
      proposalDir: gate.proposalDir,
    },
  });

  return {
    dryRun: false,
    action: gate.action,
    skillName,
    activeRel: applied.activeRel,
    revision: applied.revInfo.revision,
    snapshotRel: applied.revInfo.snapshotRel,
    historyRel: applied.revInfo.historyRel,
    candidateDigest: gate.candidateDigest,
    authorizationTier: auth.tier,
    keyTrustSource: auth.keyTrustSource || null,
    approvalId: applied.prDetails ? applied.prDetails.approvalId : auth.approvalId,
    approvalRelPath: applied.prDetails ? applied.prDetails.approvalRelPath : auth.approvalRelPath,
    prBranch: applied.prDetails ? applied.prDetails.branch : null,
    prCommitSha: applied.prDetails ? applied.prDetails.commitSha : null,
    authorizationWarning: applied.authorizationWarning,
  };
}

/**
 * Phase 6: Restores a skill deterministically from a verified historical snapshot after
 * enforcing content integrity AND explicit human authorization (never an unsigned escape hatch).
 */
export function rollbackSkill(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
  const { projectDir, schemasDir, manifest, projectPaths } = loaded;
  const skillName = validateSkillSlugName(options.skillName);
  const targetRevision = String(options.targetRevision || "").trim();
  const timestamp = validateCreatedAt(options.createdAt);

  const gate = inspectRollbackSnapshotForGate(projectDir, skillName, targetRevision);

  if (options.dryRun) {
    return {
      dryRun: true,
      skillName,
      targetRevision,
      restoredDigest: gate.targetDigest,
      currentBaseSha256: gate.currentBaseSha,
      snapshotRel: gate.snapshotRel,
    };
  }

  const evidenceDigests = Array.isArray(gate.entry.evidence_digests) ? gate.entry.evidence_digests : [];
  const auth = assertAuthorizedOperation({
    projectDir,
    projectPaths,
    schemasDir,
    manifest,
    expectedAction: "rollback",
    skillName,
    targetRevision,
    contentSha256: gate.targetDigest,
    baseSha256: gate.currentBaseSha,
    evidenceDigests,
    targetRecords: [gate.snapshotRel, gate.histInfo.histRel],
    approvalId: options.approvalId,
    publicKeyPath: options.publicKeyPath,
    mode: options.mode,
    branch: options.branch,
    approvedBy: options.approvedBy,
    interactiveConfirm: options.interactiveConfirm,
    timestamp,
    slugHint: `rollback-${skillName}-${targetRevision}`,
    rationale: `Authorized rollback of skill "${skillName}" from ${gate.currentBaseSha.slice(0, 19)} to ${targetRevision} (${gate.targetDigest.slice(0, 19)}).`,
  });

  const activeRel = `.agents/skills/${skillName}`;
  const applied = applyAuthorizedSkillPackageChange({
    projectDir,
    projectPaths,
    schemasDir,
    sourcePackageDir: gate.snapshotDir,
    expectedDigest: gate.targetDigest,
    baseSha256: gate.currentBaseSha,
    skillName,
    action: "rollback",
    auth,
    evidenceDigests,
    timestamp,
    restoredFromRevision: targetRevision,
    reason: `Rolled back to verified snapshot ${targetRevision}.`,
    targetRecords: [activeRel, gate.histInfo.histRel, gate.snapshotRel],
  });

  return {
    dryRun: false,
    skillName,
    activeRel: applied.activeRel,
    restoredFromRevision: targetRevision,
    newRevision: applied.revInfo.revision,
    restoredDigest: gate.targetDigest,
    previousBaseDigest: gate.currentBaseSha,
    historyRel: applied.revInfo.historyRel,
    snapshotRel: applied.revInfo.snapshotRel,
    authorizationTier: auth.tier,
    keyTrustSource: auth.keyTrustSource || null,
    approvalId: applied.prDetails ? applied.prDetails.approvalId : auth.approvalId,
    approvalRelPath: applied.prDetails ? applied.prDetails.approvalRelPath : auth.approvalRelPath,
    prBranch: applied.prDetails ? applied.prDetails.branch : null,
    prCommitSha: applied.prDetails ? applied.prDetails.commitSha : null,
    authorizationWarning: applied.authorizationWarning,
  };
}
