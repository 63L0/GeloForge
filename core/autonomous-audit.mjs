import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCheckpoint, listCheckpoints } from "./checkpoint.mjs";
import { captureEvidence } from "./evidence-capture.mjs";
import { assertSafeWithinRoot, atomicWriteFile, hasSecretContent, isForbiddenSecretPath } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { withProjectLock } from "./project-lock.mjs";
import { normalizeN8nId as normalizeId } from "./staging-evidence.mjs";
import { completeTask, createTask, getTask, listTasks, updateTask } from "./task-manager.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const MODE_FILE = "local-runtime/autonomous-mode.json";
export const AUDIT_CREATOR = "geloforge-autonomous";
const MAX_JSON_BYTES = 256 * 1024;
const VERIFICATION_TIMEOUT_MS = 3000;

export function readAutonomousMode(projectDir) {
  const file = assertSafeWithinRoot(projectDir, MODE_FILE);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return "off";
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) {
    throw new Error("Invalid autonomous mode file. Run geloforge autonomous off to reset regular files.");
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Cannot read autonomous mode. Run geloforge autonomous off to reset the file.");
  }
  if (typeof config?.enabled !== "boolean") {
    throw new Error("Invalid autonomous mode setting. Run geloforge autonomous off to reset it.");
  }
  return config.enabled ? "on" : "off";
}

export function setAutonomousMode({ projectDir, harnessDir, enabled }) {
  return withProjectLock(projectDir, () => {
    loadProjectManifestAndState(projectDir, harnessDir);
    const file = assertSafeWithinRoot(projectDir, MODE_FILE);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error("Autonomous mode requires a regular settings file.");
    atomicWriteFile(file, `${JSON.stringify({ enabled }, null, 2)}\n`);
    return enabled ? "on" : "off";
  });
}

export function findBlockedAudit(projectDir, blockedTaskIds) {
  if (blockedTaskIds.length === 0) return null;
  const owners = new Set(blockedTaskIds.map((taskId) => `${AUDIT_CREATOR}/${taskId}`));
  return listCheckpoints({ projectDir }).checkpoints.find((item) =>
    owners.has(item.created_by) && item.verification_evidence_ref === null
  ) ?? null;
}

function inputPath(rawPath, label) {
  if (typeof rawPath !== "string" || !/\.json$/i.test(rawPath) ||
      path.win32.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath) ||
      isForbiddenSecretPath(rawPath) || hasSecretContent(rawPath)) {
    throw new Error(`${label} must be a project-relative JSON file path.`);
  }
  return rawPath.replace(/\\/g, "/");
}

function readJsonInput(projectDir, relativePath, label) {
  let raw;
  try {
    const target = assertSafeWithinRoot(projectDir, relativePath);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error("Invalid file");
    raw = fs.readFileSync(target);
    if (raw.length > MAX_JSON_BYTES) throw new Error("File too large");
  } catch {
    throw new Error(`${label} is missing, unreadable, unsafe, or larger than 256 KiB. Use a regular local JSON file inside this project.`);
  }
  try {
    return { data: JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, "")), raw };
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function readFailureEvent(projectDir, eventFile) {
  const { data } = readJsonInput(projectDir, inputPath(eventFile, "--event"), "n8n failure event");
  if (Array.isArray(data) && data.length !== 1) {
    throw new Error("Supply a single n8n Error Trigger event per call.");
  }
  const event = Array.isArray(data) ? data[0] : data;
  const workflowId = normalizeId(event?.workflow?.id);
  const executionId = normalizeId(event?.execution?.id);
  if (!workflowId || !executionId || typeof event.execution.error?.message !== "string" ||
      !event.execution.error.message.trim()) {
    throw new Error("Expected a saved n8n failure with workflow.id, execution.id, and execution.error.message.");
  }
  return { workflowId, executionId };
}

function verifyExecutionRecord(projectDir, recordPath, workflowId, executionId) {
  const { data, raw } = readJsonInput(projectDir, inputPath(recordPath, "--execution"), "Execution record");
  if (normalizeId(data?.id) !== executionId || normalizeId(data?.workflowId) !== workflowId) {
    throw new Error("Execution record does not match the failure's workflow and execution IDs.");
  }
  if (data.status !== "error") throw new Error('Execution record must have status "error".');

  // Preserve a short node label only. Raw errors, inputs, and payload bodies stay in the source files.
  const rawNode = data.lastNodeExecuted || data.data?.resultData?.lastNodeExecuted;
  const node = typeof rawNode === "string" ? rawNode.trim() : "";
  const nodeLabel = /^[\p{L}\p{N} _()./-]{1,100}$/u.test(node) && !hasSecretContent(node)
    ? `Last node: ${node}.`
    : "Last node unavailable in the normalized evidence.";
  const digest = createHash("sha256").update(raw).digest("hex");
  return `Recorded failure matched workflow ${workflowId}, execution ${executionId}. ${nodeLabel} SHA-256: ${digest}.`;
}

export function stagingProgressPath(taskId) {
  if (!/^TASK-\d{4}$/.test(taskId)) throw new Error("Invalid staging audit task ID.");
  return `local-runtime/checkpoints/${taskId}-staging-audit.json`;
}

// The caller holds the project lock across lookup and allocation.
export function getOrCreateStagingTask({ projectDir, harnessDir, workflowId, executionId }) {
  const title = `Audit n8n staging failure ${workflowId}/${executionId}`;
  const project = { projectDir, harnessDir };
  const existing = listTasks(project).tasks
    .filter((task) => task.title === title)
    .map((task) => getTask({ ...project, taskId: task.id }))
    .find((task) => task.record.created_by === AUDIT_CREATOR);
  const task = existing ?? createTask({
    ...project, title, activate: true, createdBy: AUDIT_CREATOR,
    assignedRole: "qa-security-reviewer", contextBudget: "quick",
    objective: `Inspect saved staging execution ${executionId} for n8n workflow ${workflowId} and report evidence-based findings.`,
    scopeIn: ["Inspect local staging execution evidence"],
    scopeOut: ["Workflow changes", "Execution retries", "Customer messages"],
    acceptanceCriteria: ["Verify the execution identity, recorded failure, and each cited finding reference."],
  });
  return { task, existing: Boolean(existing) };
}

/** Runs the first-pass audit of one delivered n8n staging failure using local files. */
export function auditStagingFailure({ projectDir, harnessDir, eventFile, executionFile }) {
  return withProjectLock(projectDir, () => {
    loadProjectManifestAndState(projectDir, harnessDir);
    const mode = readAutonomousMode(projectDir);
    const { workflowId, executionId } = readFailureEvent(projectDir, eventFile);
    const result = { mode, workflowId, executionId, taskId: null, checkpointId: null, evidenceId: null, reused: false };
    if (mode === "off") {
      return {
        ...result, status: "skipped",
        nextAction: `Review workflow ${workflowId}, execution ${executionId} manually. Use geloforge recommend for project guidance.`,
      };
    }

    const recordPath = executionFile === undefined ? null : inputPath(executionFile, "--execution");
    const project = { projectDir, harnessDir };
    const { task, existing } = getOrCreateStagingTask({ ...project, workflowId, executionId });
    if (fs.existsSync(assertSafeWithinRoot(projectDir, stagingProgressPath(task.id)))) {
      throw new Error("This task is managed by the staging worker. Resume it through autonomous watch.");
    }
    const taskOptions = { ...project, taskId: task.id };
    const checkpointOwner = `${AUDIT_CREATOR}/${task.id}`;
    const prior = existing && listCheckpoints(project).checkpoints.find((item) => item.created_by === checkpointOwner);
    if (existing && task.record.status !== "active") {
      return {
        ...result, taskId: task.id, status: task.record.status, reused: true,
        checkpointId: prior?.id ?? null, evidenceId: prior?.verification_evidence_ref ?? null,
        nextAction: prior?.resume_instructions ?? `Inspect ${task.id} with geloforge task show --task ${task.id}.`,
      };
    }

    let checkpoint = prior;
    if (!checkpoint) {
      const evidence = recordPath && captureEvidence({
        ...taskOptions, name: "Verify saved n8n staging execution",
        commandArgv: [process.execPath, MODULE_PATH, recordPath, workflowId, executionId],
        timeoutMs: VERIFICATION_TIMEOUT_MS, linkVerifiedOnly: true,
      });
      const nextAction = evidence?.verified
        ? `${evidence.outputExcerpt} Review the recorded failure in staging to determine the cause.`
        : `${evidence?.record.checks[0].summary ?? "No saved staging execution record was supplied."} Obtain the saved error record for workflow ${workflowId}, execution ${executionId}, and confirm it before closing ${task.id}.`;
      const saved = createCheckpoint({
        ...project, createdBy: checkpointOwner,
        evidenceRef: evidence?.verified ? evidence.id : null,
        resumeInstructions: nextAction,
      });
      checkpoint = {
        id: saved.checkpointId,
        verification_evidence_ref: saved.record.verification_evidence_ref,
        resume_instructions: saved.record.resume_instructions,
      };
    }

    const evidenceId = checkpoint.verification_evidence_ref;
    const updated = evidenceId
      ? completeTask({ ...taskOptions, evidenceRefs: [evidenceId], requireEvidence: true })
      : updateTask({ ...taskOptions, status: "blocked" });
    return {
      ...result, taskId: task.id, status: updated.status, reused: Boolean(existing),
      checkpointId: checkpoint.id, evidenceId, nextAction: checkpoint.resume_instructions,
    };
  });
}

// A fixed local verifier is executed by evidence capture. Event data never chooses an executable.
if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const [recordPath, workflowId, executionId] = process.argv.slice(2);
  try {
    console.log(verifyExecutionRecord(process.cwd(), recordPath, workflowId, executionId));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
