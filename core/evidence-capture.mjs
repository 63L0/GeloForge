/**
 * Command-backed Verification Evidence Capture for GeloForge.
 * Executes explicit user-supplied argv commands directly with shell: false,
 * redacts secret material, accurately records pass/fail/timeout/error outcomes
 * without overclaiming test correctness, and writes schema-valid EVID-NNNN manifests.
 */

import fs from "node:fs";
import { readRegularFile } from "./runtime-files.mjs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertSafeWithinRoot,
  isForbiddenSecretPath,
  deriveSlug,
  hasSecretContent,
  redactSecretContent,
  validateScalarText,
} from "./path-safety.mjs";
import { serializeYaml } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { getGitRepoInfo } from "./git-utils.mjs";
import { loadProjectManifestAndState, scanAndAllocateRecordId } from "./project-locator.mjs";
import { getTask } from "./task-manager.mjs";
import { runMultiFileTransaction, withProjectLock } from "./project-lock.mjs";
import { validateCreatedAt } from "./template-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

const ALLOWED_ROLES = new Set([
  "orchestrator",
  "researcher",
  "software-architect",
  "developer",
  "qa-security-reviewer",
]);

const MAX_EXCERPT_CHARS = 480;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;

function formatOutputExcerpt(stdout, stderr) {
  const combinedRaw = [stdout || "", stderr || ""].filter((s) => s.trim().length > 0).join("\n");
  if (!combinedRaw) {
    return "(no stdout/stderr output)";
  }
  const redacted = redactSecretContent(combinedRaw);
  const compact = redacted.replace(/\r?\n/g, " | ").replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_EXCERPT_CHARS) {
    return compact;
  }
  return `${compact.slice(0, MAX_EXCERPT_CHARS - 3)}...`;
}

/**
 * Executes an explicit command (shell: false) inside projectDir and writes an EVID-NNNN manifest.
 */
export function captureEvidence(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <path>).");
  }

  const commandArgv = options.commandArgv;
  if (!Array.isArray(commandArgv) || commandArgv.length === 0 || commandArgv.some((a) => typeof a !== "string" || a.length === 0)) {
    throw new Error('Missing command to execute after "--". Example: geloforge evidence capture --task TASK-0001 -- node --test');
  }

  const taskIdRaw = options.taskId;
  if (typeof taskIdRaw !== "string" || !/^TASK-\d{4}$/i.test(taskIdRaw.trim())) {
    throw new Error(`Invalid or missing --task "${taskIdRaw}". Expected TASK-NNNN.`);
  }
  const taskId = taskIdRaw.trim().toUpperCase();

  const producedByRole = (options.producedByRole || "developer").trim();
  if (!ALLOWED_ROLES.has(producedByRole)) {
    throw new Error(`Invalid --role "${producedByRole}". Expected one of: ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
    const num = Number(options.timeoutMs);
    if (!Number.isInteger(num) || num < 50 || num > MAX_TIMEOUT_MS) {
      throw new Error(`Invalid --timeout "${options.timeoutMs}". Must be an integer between 50 and ${MAX_TIMEOUT_MS} ms.`);
    }
    timeoutMs = num;
  }

  const redactedCommand = redactSecretContent(commandArgv.join(" "));
  const checkName = validateScalarText("--name", options.name ?? `Command check: ${path.basename(commandArgv[0])}`);
  if (hasSecretContent(checkName)) {
    throw new Error("Refusing credential-like content in --name.");
  }
  const createdAt = validateCreatedAt(options.createdAt);
  const dryRun = Boolean(options.dryRun);
  const slug = deriveSlug(checkName) || "check";
  const prepareTarget = () => {
    const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
    const { projectDir, projectPaths } = loaded;
    const targetTask = getTask({ projectDir, taskId, harnessDir });
    assertSafeWithinRoot(projectDir, projectPaths.evidence_dir);
    const { id } = scanAndAllocateRecordId({
      projectDir,
      searchDirs: [projectPaths.evidence_dir, projectPaths.proposals_dir],
      prefix: "EVID",
      explicitId: options.id ?? null,
    });
    const title = validateScalarText("--title", options.title ?? `Evidence ${id}: ${checkName}`);
    if (hasSecretContent(title)) throw new Error("Refusing credential-like content in --title.");
    const relPath = `${projectPaths.evidence_dir}/${id}-${slug.slice(0, 42)}.yaml`;
    const filePath = assertSafeWithinRoot(projectDir, relPath);
    if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing evidence file: ${filePath}`);
    return { ...loaded, targetTask, id, title, relPath, filePath };
  };
  const initial = dryRun ? prepareTarget() : withProjectLock(options.projectDir, prepareTarget);
  const { projectDir } = initial;
  const readArtifacts = () => (options.artifactPaths || []).map((relativePath) => {
    if (path.isAbsolute(relativePath) || isForbiddenSecretPath(relativePath) || hasSecretContent(relativePath)) {
      throw new Error("Use a safe, project-relative evidence artifact path.");
    }
    const bytes = readRegularFile(assertSafeWithinRoot(projectDir, relativePath));
    if (!bytes || hasSecretContent(bytes.toString("utf8"))) throw new Error("Evidence artifact is missing or unsafe.");
    return {
      path: relativePath, description: "Verified command input",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const gitInfo = getGitRepoInfo(projectDir);
  const sourceRevision = !gitInfo.available ? "no-git-repo" : gitInfo.unborn ? "git-unborn-head" : gitInfo.head;
  const environment = {
    os: `${process.platform} (${os.release()})`,
    runtime: `Node.js ${process.version}`,
  };

  if (dryRun) {
    const { id, title, relPath, filePath } = initial;
    const previewRecord = {
      schema_version: "1.1",
      id,
      title,
      task_id: taskId,
      status: "draft",
      memory_layer: "L3_RESEARCH_EVIDENCE",
      authority_level: "A4",
      produced_by_role: producedByRole,
      verified_by: null,
      created_at: createdAt,
      source_revision: sourceRevision,
      environment,
      checks: [
        {
          name: checkName,
          command: redactedCommand,
          result: "not_tested",
          summary: "DRY RUN — command not executed.",
        },
      ],
      artifacts: [],
      limitations: [
        "Dry run only: command was not executed and no evidence file was written.",
      ],
    };
    return {
      dryRun: true,
      id,
      taskId,
      relPath,
      filePath,
      command: redactedCommand,
      exitCode: null,
      timedOut: false,
      checkResult: "not_tested",
      status: "draft",
      verified: false,
      durationMs: 0,
      linkedToTask: false,
      outputExcerpt: "",
      record: previewRecord,
      yaml: serializeYaml(previewRecord, { headerComment: `Evidence Manifest ${id} (dry-run)` }),
    };
  }

  const artifacts = readArtifacts();
  const [exe, ...cmdArgs] = commandArgv;
  const startedAt = Date.now();
  const proc = spawnSync(exe, cmdArgs, {
    cwd: projectDir,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  const durationMs = Math.max(0, Date.now() - startedAt);

  const excerpt = formatOutputExcerpt(proc.stdout, proc.stderr);
  const timedOut =
    proc.error?.code === "ETIMEDOUT" ||
    Boolean(proc.error && /ETIMEDOUT/i.test(proc.error.message));

  let checkResult;
  let summary;
  if (timedOut) {
    checkResult = "blocked";
    summary = `Command timed out after ${timeoutMs}ms (${durationMs}ms elapsed); output excerpt: ${excerpt}`;
  } else if (proc.error) {
    checkResult = "blocked";
    const errText = redactSecretContent(proc.error.message || proc.error.code || "spawn failed");
    summary = `Command execution failed to spawn (${proc.error.code || "ERROR"}): ${errText}`;
  } else if (proc.status === 0 && !proc.signal) {
    checkResult = "passed";
    summary = `Exit code 0 in ${durationMs}ms (command execution succeeded under shell: false; output excerpt: ${excerpt})`;
  } else {
    checkResult = "failed";
    const reason = proc.signal ? `signal ${proc.signal}` : `exit code ${proc.status}`;
    summary = `Command failed with ${reason} in ${durationMs}ms; output excerpt: ${excerpt}`;
  }

  const isVerified = checkResult === "passed";
  const manifestStatus = isVerified ? "verified" : "draft";
  const verifiedBy = isVerified ? (options.verifiedBy || "local-cli-exit-0") : null;

  const limitations = isVerified
    ? [
        "Exit code 0 proves command execution succeeded in this local environment; it does not independently prove tool-reported test completeness, untested code paths, or broader development claims.",
        "Executed directly with shell: false; stdout/stderr excerpts are bounded and secret-redacted before saving.",
      ]
    : [
        `Command check outcome is "${checkResult}" (${timedOut ? "timed out" : "non-zero/spawn error"}); evidence recorded as status="draft" (NOT verified) and excluded from HANDOFF verified_evidence.`,
        "No test assertions or feature completeness are verified when command execution fails or blocks.",
        ...(proc.error?.code === "ENOENT"
          ? ["Executable not found with shell: false; pass a direct binary path or *.cmd / node command without shell interpolation."]
          : []),
      ];

  // Run the command outside the project lock, then allocate and link against current state.
  return withProjectLock(projectDir, () => {
    const { schemasDir, state, stateSchema, stateFilePath, targetTask, id, title, relPath, filePath } = prepareTarget();
    if (artifacts.length && JSON.stringify(artifacts) !== JSON.stringify(readArtifacts())) {
      throw new Error("Evidence artifact changed during verification. Retry with a stable copy.");
    }
    const record = {
      schema_version: "1.1",
      id,
      title,
      task_id: taskId,
      status: manifestStatus,
      memory_layer: "L3_RESEARCH_EVIDENCE",
      authority_level: isVerified ? "A3" : "A6",
      produced_by_role: producedByRole,
      verified_by: verifiedBy,
      created_at: createdAt,
      source_revision: sourceRevision,
      environment,
      checks: [
        {
          name: checkName,
          command: redactedCommand,
          result: checkResult,
          summary: redactSecretContent(summary),
        },
      ],
      artifacts,
      limitations: [...limitations, ...(options.limitations || [])].map((l) => redactSecretContent(l)),
    };

    const evidSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, "evidence-manifest.schema.json"), "utf8"));
    const schemaCheck = validateAgainstSchema(record, evidSchema);
    if (!schemaCheck.valid) {
      throw new Error(`Captured evidence failed schema validation: ${schemaCheck.errors.join("; ")}`);
    }

    const yamlText = serializeYaml(record, { headerComment: `Evidence Manifest ${id}` });
    const steps = [{ label: "evidence", filePath, content: yamlText, allowOverwrite: false }];

    const linkedToTask = options.linkTask !== false && (!options.linkVerifiedOnly || isVerified);
    if (linkedToTask) {
      const refs = Array.isArray(targetTask.record.evidence_refs) ? [...targetTask.record.evidence_refs] : [];
      if (!refs.includes(id)) {
        refs.push(id);
        const updatedTask = {
          ...targetTask.record,
          updated_at: createdAt,
          evidence_refs: refs,
        };
        const taskSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, "task-contract.schema.json"), "utf8"));
        const tValid = validateAgainstSchema(updatedTask, taskSchema);
        if (!tValid.valid) {
          throw new Error(`Failed updating task ${taskId} with evidence ref: ${tValid.errors.join("; ")}`);
        }
        steps.push({
          label: "task",
          filePath: targetTask.filePath,
          content: serializeYaml(updatedTask, { headerComment: `Task Contract ${taskId}` }),
        });
      }

      if (isVerified) {
        const updatedState = {
          ...state,
          state_revision: (state.state_revision ?? 0) + 1,
          updated_at: createdAt,
          last_verified_evidence: id,
        };
        const stValid = validateAgainstSchema(updatedState, stateSchema);
        if (!stValid.valid) {
          throw new Error(`Failed updating state with verified evidence ${id}: ${stValid.errors.join("; ")}`);
        }
        steps.push({
          label: "state",
          filePath: stateFilePath,
          content: serializeYaml(updatedState, { headerComment: "Current Operational Project State" }),
        });
      }
    }

    runMultiFileTransaction(steps, { projectDir });
    return {
      dryRun: false,
      id,
      taskId,
      relPath,
      filePath,
      command: redactedCommand,
      exitCode: proc.status ?? null,
      signal: proc.signal ?? null,
      timedOut,
      checkResult,
      status: manifestStatus,
      verified: isVerified,
      durationMs,
      linkedToTask,
      outputExcerpt: excerpt,
      record,
      yaml: yamlText,
    };
  });
}
