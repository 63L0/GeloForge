/**
 * Mid-session recovery checkpoint manager for GeloForge (v0.5).
 * Writes schema-valid CHKPT-NNNN records under brain/handoffs/ so agents and humans
 * can restart fresh sessions cleanly without context rot or lost operational state.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, serializeYaml } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { checkRecordSchemaVersion } from "./compatibility.mjs";
import {
  assertSafeWithinRoot,
  atomicWriteFile,
  hasSecretContent,
  isForbiddenSecretPath,
  walkNonSymlinkFiles,
} from "./path-safety.mjs";
import { getGitStatusScoped } from "./git-utils.mjs";
import { loadProjectManifestAndState, scanAndAllocateRecordId } from "./project-locator.mjs";
import { listTaskLeases } from "./task-manager.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

const ALLOWED_CHECKPOINT_STATUSES = new Set([
  "created",
  "verified",
  "restored",
  "expired",
  "invalidated",
]);

function loadCheckpointSchema(schemasDir) {
  const schemaPath = path.join(schemasDir, "recovery-checkpoint.schema.json");
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

function buildAutoResumeInstructions({
  summary,
  activeTasks,
  blockedTasks,
  openConflicts,
  pendingApprovals,
  activeLeases,
  gitStatus,
  evidenceRef,
}) {
  const parts = [];
  if (typeof summary === "string" && summary.trim().length > 0) {
    parts.push(`Summary: ${summary.trim()}`);
  }
  if (activeTasks.length > 0) {
    parts.push(`Active task(s): ${activeTasks.join(", ")}.`);
  } else {
    parts.push("No active task currently set in state; inspect queued tasks or recommend next action.");
  }
  if (blockedTasks.length > 0) {
    parts.push(`Blocked task(s): ${blockedTasks.join(", ")}.`);
  }
  if (openConflicts.length > 0) {
    parts.push(`Open conflict(s): ${openConflicts.join(", ")}.`);
  }
  if (pendingApprovals.length > 0) {
    parts.push(`Pending approval(s): ${pendingApprovals.join(", ")}.`);
  }
  if (activeLeases.length > 0) {
    const leaseText = activeLeases
      .map((l) => `${l.task_id} (${l.tool || "unknown"}/${l.role || "unassigned"})`)
      .join(", ");
    parts.push(`Active multi-IDE lease(s): ${leaseText}.`);
  }
  if (gitStatus.available) {
    if (gitStatus.changedFiles.length > 0) {
      const sample = gitStatus.changedFiles.slice(0, 8).join(", ");
      const suffix = gitStatus.changedFiles.length > 8 ? ` (+${gitStatus.changedFiles.length - 8} more)` : "";
      parts.push(`Modified files (${gitStatus.changedFiles.length}): ${sample}${suffix}.`);
    } else {
      parts.push("Git working tree is clean.");
    }
  }
  if (evidenceRef) {
    parts.push(`Latest verified evidence: ${evidenceRef}.`);
  }
  if (activeTasks.length > 0) {
    parts.push(
      `Next session: run "geloforge context --task ${activeTasks[0]} --from-diff --map --profile quick" before editing.`
    );
  } else {
    parts.push('Next session: run "geloforge recommend" to review priorities and pending human approvals.');
  }
  return parts.join(" ");
}

/**
 * Creates a schema-valid CHKPT-NNNN recovery checkpoint and updates project state.
 */
export function createCheckpoint(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <dir>).");
  }

  const { projectDir, schemasDir, compatConfig, manifest, state, stateSchema, projectPaths } =
    loadProjectManifestAndState(options.projectDir, harnessDir);

  if (!state) {
    throw new Error(`Missing or invalid ${projectPaths.state} in ${projectDir}`);
  }

  const createdAt = options.createdAt || new Date().toISOString();
  const createdBy = String(options.createdBy || options.role || "geloforge-copilot").trim();
  if (!createdBy) {
    throw new Error("--created-by must not be empty.");
  }
  if (hasSecretContent(createdBy)) {
    throw new Error("Refusing credential-like content in --created-by.");
  }

  const status = String(options.status || "created").trim();
  if (!ALLOWED_CHECKPOINT_STATUSES.has(status)) {
    throw new Error(
      `Invalid checkpoint status "${status}". Allowed: ${Array.from(ALLOWED_CHECKPOINT_STATUSES).join(", ")}`
    );
  }

  let evidenceRef = options.evidenceRef !== undefined ? options.evidenceRef : state.last_verified_evidence ?? null;
  if (evidenceRef !== null && evidenceRef !== undefined && String(evidenceRef).trim() !== "") {
    evidenceRef = String(evidenceRef).trim().toUpperCase();
    if (!/^EVID-\d{4}$/.test(evidenceRef)) {
      throw new Error(`Invalid --evidence ref "${evidenceRef}". Expected EVID-NNNN.`);
    }
  } else {
    evidenceRef = null;
  }

  const warnings = [];
  const gitStatus = getGitStatusScoped(projectDir, warnings);
  let activeLeases = [];
  try {
    activeLeases = listTaskLeases({ projectDir, nowIso: createdAt, harnessDir }).activeLeases || [];
  } catch (err) {
    warnings.push(`Could not inspect task leases: ${err.message}`);
  }

  const activeTasks = Array.isArray(state.active_tasks) ? [...state.active_tasks] : [];
  const resumeRaw =
    typeof options.resumeInstructions === "string" && options.resumeInstructions.trim().length > 0
      ? options.resumeInstructions.trim()
      : buildAutoResumeInstructions({
          summary: options.summary || "",
          activeTasks,
          blockedTasks: state.blocked_tasks || [],
          openConflicts: state.open_conflicts || [],
          pendingApprovals: state.pending_approvals || [],
          activeLeases,
          gitStatus,
          evidenceRef,
        });

  if (hasSecretContent(resumeRaw)) {
    throw new Error("Refusing to write checkpoint containing credential-like content in resume_instructions.");
  }
  if (typeof options.summary === "string" && hasSecretContent(options.summary)) {
    throw new Error("Refusing to write checkpoint containing credential-like content in summary.");
  }

  const explicitId = options.id ? String(options.id).trim().toUpperCase() : null;
  const searchDirs = Array.from(new Set([projectPaths.handoffs_dir, projectPaths.tasks_dir]));
  const { id } = scanAndAllocateRecordId({
    projectDir,
    searchDirs,
    prefix: "CHKPT",
    explicitId,
  });

  const relPath = `${projectPaths.handoffs_dir}/${id}-checkpoint.yaml`;
  if (isForbiddenSecretPath(relPath)) {
    throw new Error(`Refusing checkpoint destination path: ${relPath}`);
  }
  const targetAbs = assertSafeWithinRoot(projectDir, relPath);
  if (fs.existsSync(targetAbs)) {
    throw new Error(`Checkpoint file already exists: ${relPath}`);
  }

  const nextStateRevision = (typeof state.state_revision === "number" ? state.state_revision : 0) + 1;
  const stateRelPath = String(projectPaths.state || "brain/state/current.yaml").replace(/\\/g, "/");

  const checkpointSchema = loadCheckpointSchema(schemasDir);
  const record = {
    schema_version: manifest.schema_version || compatConfig.default_schema_version || "1.1",
    id,
    project_id: manifest.project_id,
    status,
    memory_layer: "L2_OPERATIONAL",
    authority_level: "A4",
    created_at: createdAt,
    created_by: createdBy,
    git_branch: gitStatus.available && gitStatus.branch ? gitStatus.branch : "no-git-branch",
    git_commit: gitStatus.available
      ? gitStatus.unborn
        ? "unborn-head"
        : gitStatus.head || "unknown"
      : "unavailable",
    working_tree_clean: gitStatus.available ? !gitStatus.dirty : true,
    active_tasks: activeTasks,
    state_file_path: stateRelPath,
    state_revision: nextStateRevision,
    resume_instructions: resumeRaw,
    verification_evidence_ref: evidenceRef,
  };

  const yamlText = serializeYaml(record, {
    headerComment: `GeloForge recovery checkpoint ${id}`,
  });
  const roundTrip = parseYaml(yamlText, relPath);
  const schemaCheck = validateAgainstSchema(roundTrip, checkpointSchema);
  if (!schemaCheck.valid) {
    throw new Error(`Checkpoint failed schema validation: ${schemaCheck.errors.join("; ")}`);
  }

  const nextState = {
    ...state,
    updated_at: createdAt,
    state_revision: nextStateRevision,
    last_checkpoint: id,
  };
  const stateCheck = validateAgainstSchema(nextState, stateSchema);
  if (!stateCheck.valid) {
    throw new Error(`Updated state failed schema validation: ${stateCheck.errors.join("; ")}`);
  }

  if (!options.dryRun) {
    atomicWriteFile(targetAbs, yamlText, { allowOverwrite: false });
    const stateAbs = assertSafeWithinRoot(projectDir, stateRelPath);
    atomicWriteFile(
      stateAbs,
      serializeYaml(nextState, { headerComment: "Current operational state of the project." }),
      { allowOverwrite: true }
    );
  }

  return {
    dryRun: Boolean(options.dryRun),
    projectDir,
    checkpointId: id,
    recordPath: relPath,
    record: roundTrip,
    stateRevision: nextStateRevision,
    changedFiles: gitStatus.changedFiles || [],
    activeLeases,
    warnings,
    nextCommand:
      activeTasks.length > 0
        ? `geloforge context --task ${activeTasks[0]} --from-diff --map --profile quick`
        : "geloforge recommend",
  };
}

function scanCheckpointsInternal({ projectDir, schemasDir, compatConfig, projectPaths }) {
  const schema = loadCheckpointSchema(schemasDir);
  const searchDirs = Array.from(new Set([projectPaths.handoffs_dir, projectPaths.tasks_dir]));
  const warnings = [];
  const checkpoints = [];
  const seenFiles = new Set();

  for (const relDir of searchDirs) {
    const absDir = path.join(projectDir, relDir);
    const files = walkNonSymlinkFiles(
      projectDir,
      absDir,
      (p) => /^CHKPT-\d{4}.*\.ya?ml$/i.test(path.basename(p)),
      warnings
    );
    for (const file of files) {
      const rel = path.relative(projectDir, file).replace(/\\/g, "/");
      if (seenFiles.has(rel) || isForbiddenSecretPath(rel)) {
        continue;
      }
      seenFiles.add(rel);
      const raw = fs.readFileSync(file, "utf8");
      if (hasSecretContent(raw)) {
        warnings.push(`Blocked checkpoint containing credential-like content: ${rel}`);
        continue;
      }
      let data;
      try {
        data = parseYaml(raw, rel);
      } catch (err) {
        warnings.push(`Invalid YAML in checkpoint ${rel}: ${err.message}`);
        continue;
      }
      const verCheck = checkRecordSchemaVersion(data, compatConfig);
      if (!verCheck.compatible) {
        warnings.push(`Incompatible checkpoint ${rel}: ${verCheck.error}`);
        continue;
      }
      const res = validateAgainstSchema(data, schema);
      if (!res.valid) {
        warnings.push(`Checkpoint ${rel} failed schema check: ${res.errors.join("; ")}`);
        continue;
      }
      checkpoints.push({ relPath: rel, record: data });
    }
  }

  checkpoints.sort((a, b) => {
    const tA = Date.parse(a.record.created_at || "") || 0;
    const tB = Date.parse(b.record.created_at || "") || 0;
    if (tB !== tA) return tB - tA;
    return String(b.record.id).localeCompare(String(a.record.id));
  });

  return { checkpoints, warnings };
}

/**
 * Lists valid recovery checkpoints ordered newest first.
 */
export function listCheckpoints(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <dir>).");
  }
  const { projectDir, schemasDir, compatConfig, state, projectPaths } = loadProjectManifestAndState(
    options.projectDir,
    harnessDir
  );
  const { checkpoints, warnings } = scanCheckpointsInternal({
    projectDir,
    schemasDir,
    compatConfig,
    projectPaths,
  });

  const statusFilter = options.status ? String(options.status).trim() : null;
  if (statusFilter && !ALLOWED_CHECKPOINT_STATUSES.has(statusFilter)) {
    throw new Error(`Invalid status filter "${statusFilter}".`);
  }

  const filtered = statusFilter
    ? checkpoints.filter((c) => c.record.status === statusFilter)
    : checkpoints;

  return {
    projectDir,
    lastCheckpointId: state?.last_checkpoint ?? null,
    count: filtered.length,
    checkpoints: filtered.map((c) => ({
      id: c.record.id,
      status: c.record.status,
      created_at: c.record.created_at,
      created_by: c.record.created_by,
      git_branch: c.record.git_branch,
      git_commit: c.record.git_commit,
      working_tree_clean: c.record.working_tree_clean,
      active_tasks: c.record.active_tasks,
      state_revision: c.record.state_revision,
      verification_evidence_ref: c.record.verification_evidence_ref,
      resume_instructions: c.record.resume_instructions,
      recordPath: c.relPath,
    })),
    warnings,
  };
}

/**
 * Retrieves a single recovery checkpoint (or the latest if checkpointId is omitted).
 */
export function getCheckpoint(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <dir>).");
  }
  const { projectDir, schemasDir, compatConfig, state, projectPaths } = loadProjectManifestAndState(
    options.projectDir,
    harnessDir
  );
  const { checkpoints, warnings } = scanCheckpointsInternal({
    projectDir,
    schemasDir,
    compatConfig,
    projectPaths,
  });

  let found = null;
  if (options.checkpointId) {
    const targetId = String(options.checkpointId).trim().toUpperCase();
    found = checkpoints.find((c) => c.record.id === targetId) || null;
    if (!found) {
      throw new Error(`Checkpoint "${targetId}" was not found or failed validation.`);
    }
  } else if (state?.last_checkpoint) {
    found = checkpoints.find((c) => c.record.id === state.last_checkpoint) || checkpoints[0] || null;
  } else {
    found = checkpoints[0] || null;
  }

  if (!found) {
    throw new Error("No recovery checkpoints found in project.");
  }

  return {
    projectDir,
    checkpointId: found.record.id,
    recordPath: found.relPath,
    record: found.record,
    isLastCheckpoint: state?.last_checkpoint === found.record.id,
    warnings,
  };
}
