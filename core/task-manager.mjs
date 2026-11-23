/**
 * Task Contract manager (create, list, show) for GeloForge projects.
 * Enforces strict schema validation, duplicate-ID checks, and atomic writes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeWithinRoot,
  atomicWriteFile,
  deriveSlug,
  hasSecretContent,
  isForbiddenSecretPath,
  validateScalarText,
  walkNonSymlinkFiles,
} from "./path-safety.mjs";
import { parseYaml, serializeYaml } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { loadProjectManifestAndState, scanAndAllocateRecordId } from "./project-locator.mjs";
import { runMultiFileTransaction, sleepSyncMs, withProjectLock } from "./project-lock.mjs";
import { validateCreatedAt } from "./template-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

const ALLOWED_TASK_STATUSES = new Set(["inbox", "ready", "active", "in_review", "blocked", "completed", "cancelled"]);
const ALLOWED_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const ALLOWED_ROLES = new Set([
  "orchestrator",
  "researcher",
  "software-architect",
  "developer",
  "qa-security-reviewer",
]);
const ALLOWED_BUDGETS = new Set(["quick", "working", "deep"]);

function normalizeTextList(raw, fieldName, { allowEmpty = true } = {}) {
  if (raw === undefined || raw === null) {
    return [];
  }
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of arr) {
    const clean = validateScalarText(fieldName, item);
    if (hasSecretContent(clean)) {
      throw new Error(`Refusing credential-like content in ${fieldName}.`);
    }
    out.push(clean);
  }
  if (!allowEmpty && out.length === 0) {
    throw new Error(`${fieldName} must contain at least one item.`);
  }
  return out;
}

/**
 * Creates a schema-valid TASK-NNNN contract in manifest.paths.tasks_dir and optionally activates it.
 */
export function createTask(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <path>).");
  }

  const executeCreate = () => {
    const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
  const { projectDir, schemasDir, manifest, state, stateSchema, stateFilePath, projectPaths } = loaded;

  const title = validateScalarText("--title", options.title);
  if (title.length < 3) {
    throw new Error("--title must be at least 3 characters.");
  }
  if (hasSecretContent(title)) {
    throw new Error("Refusing credential-like content in --title.");
  }

  const activate = Boolean(options.activate);
  const status = (options.status ? String(options.status).trim() : activate ? "active" : "ready").toLowerCase();
  if (!ALLOWED_TASK_STATUSES.has(status)) {
    throw new Error(`Invalid task status "${status}". Expected one of: ${Array.from(ALLOWED_TASK_STATUSES).join(", ")}`);
  }
  if (activate && (status === "completed" || status === "cancelled")) {
    throw new Error(`Cannot --activate a task created with terminal status "${status}".`);
  }

  const priority = (options.priority || "medium").trim().toLowerCase();
  if (!ALLOWED_PRIORITIES.has(priority)) {
    throw new Error(`Invalid --priority "${priority}". Expected: low, medium, high, critical.`);
  }

  const assignedRole = (options.assignedRole || "developer").trim();
  if (!ALLOWED_ROLES.has(assignedRole)) {
    throw new Error(`Invalid --role "${assignedRole}". Expected one of: ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }

  const contextBudget = (options.contextBudget || "working").trim().toLowerCase();
  if (!ALLOWED_BUDGETS.has(contextBudget)) {
    throw new Error(`Invalid --budget "${contextBudget}". Expected: quick, working, deep.`);
  }

  const objective = validateScalarText("--objective", options.objective ?? title);
  if (hasSecretContent(objective)) {
    throw new Error("Refusing credential-like content in --objective.");
  }

  const createdBy = validateScalarText("--created-by", options.createdBy ?? manifest.owner ?? "developer");
  const createdAt = validateCreatedAt(options.createdAt);

  const scopeIn = normalizeTextList(options.scopeIn, "--scope-in");
  const scopeOut = normalizeTextList(options.scopeOut, "--scope-out");
  const expectedOutputs = normalizeTextList(options.expectedOutputs, "--expected-output");
  const criteriaInput = normalizeTextList(options.acceptanceCriteria, "--criteria");
  const acceptanceCriteria =
    criteriaInput.length > 0
      ? criteriaInput
      : [`Verify "${title}" with recorded command-backed evidence before handoff.`];

  const dependencies = [];
  for (const dep of normalizeTextList(options.dependencies, "--dep")) {
    const up = dep.toUpperCase();
    if (!/^TASK-\d{4}$/.test(up)) {
      throw new Error(`Invalid dependency task ID "${dep}". Expected TASK-NNNN.`);
    }
    dependencies.push(up);
  }

  const requiredInputs = [];
  for (const rawInput of normalizeTextList(options.requiredInputs, "--input")) {
    const norm = rawInput.replace(/\\/g, "/");
    if (isForbiddenSecretPath(norm)) {
      throw new Error(`Refusing secret path in --input: "${rawInput}".`);
    }
    const target = assertSafeWithinRoot(projectDir, norm);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) {
      throw new Error(`Referenced --input file does not exist or is not a regular file: "${norm}".`);
    }
    requiredInputs.push({ path: norm, revision: "working-tree" });
  }

  const { id, existingIds } = scanAndAllocateRecordId({
    projectDir,
    searchDirs: [projectPaths.tasks_dir, projectPaths.proposals_dir],
    prefix: "TASK",
    explicitId: options.id ?? null,
  });

  for (const dep of dependencies) {
    if (!existingIds.has(dep)) {
      throw new Error(`Dependency task "${dep}" does not exist in ${projectPaths.tasks_dir}.`);
    }
  }

  const slug = deriveSlug(title) || "task";
  const relPath = `${projectPaths.tasks_dir}/${id}-${slug.slice(0, 42)}.yaml`;
  const filePath = assertSafeWithinRoot(projectDir, relPath);
  if (fs.existsSync(filePath)) {
    throw new Error(`Refusing to overwrite existing task file: ${filePath}`);
  }

  const record = {
    schema_version: "1.1",
    id,
    title,
    project_id: manifest.project_id,
    status,
    memory_layer: "L2_OPERATIONAL",
    authority_level: "A4",
    priority,
    assigned_role: assignedRole,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt,
    objective,
    scope_in: scopeIn,
    scope_out: scopeOut,
    required_inputs: requiredInputs,
    expected_outputs: expectedOutputs,
    acceptance_criteria: acceptanceCriteria,
    dependencies,
    approval_required: false,
    approval_ref: null,
    context_budget: contextBudget,
    max_retries: 2,
    evidence_refs: [],
  };

  const taskSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, "task-contract.schema.json"), "utf8"));
  const schemaCheck = validateAgainstSchema(record, taskSchema);
  if (!schemaCheck.valid) {
    throw new Error(`Task failed schema validation: ${schemaCheck.errors.join("; ")}`);
  }

  const yamlText = serializeYaml(record, { headerComment: `Task Contract ${id}` });
  const tasksDirAbs = assertSafeWithinRoot(projectDir, projectPaths.tasks_dir);
  if (fs.existsSync(tasksDirAbs) && fs.lstatSync(tasksDirAbs).isSymbolicLink()) {
    throw new Error(`Refusing symbolic link tasks directory: ${tasksDirAbs}`);
  }

  let updatedState = null;
  if (activate) {
    const activeTasks = Array.isArray(state.active_tasks) ? [...state.active_tasks] : [];
    if (!activeTasks.includes(id)) activeTasks.push(id);
    const blockedTasks = (state.blocked_tasks || []).filter((t) => t !== id);
    updatedState = {
      ...state,
      state_revision: (state.state_revision ?? 0) + 1,
      status: state.status === "initialized" ? "active" : state.status,
      updated_at: createdAt,
      current_phase: state.current_phase === "initialization" || state.current_phase === "adoption" ? "implementation" : state.current_phase,
      active_tasks: activeTasks,
      blocked_tasks: blockedTasks,
    };
    const stCheck = validateAgainstSchema(updatedState, stateSchema);
    if (!stCheck.valid) {
      throw new Error(`Updated operational state failed schema validation: ${stCheck.errors.join("; ")}`);
    }
  }

  const dryRun = Boolean(options.dryRun);
  if (!dryRun) {
    const txSteps = [{ label: "task", filePath, content: yamlText, allowOverwrite: false }];
    if (updatedState) {
      const stateYaml = serializeYaml(updatedState, { headerComment: "Current Operational Project State" });
      txSteps.push({ label: "state", filePath: stateFilePath, content: stateYaml, allowOverwrite: true });
    }
    runMultiFileTransaction(txSteps, { projectDir, faultHook: options._faultHook });
  }

  return {
    dryRun,
    id,
    relPath,
    filePath,
    activated: activate,
    record,
    yaml: yamlText,
  };
  };

  if (options.dryRun) {
    return executeCreate();
  }
  return withProjectLock(options.projectDir, executeCreate, {
    lockTimeoutMs: options.lockTimeoutMs,
    staleLockMs: options.staleLockMs,
  });
}

/**
 * Lists schema-valid TASK-NNNN records under manifest.paths.tasks_dir.
 */
export function listTasks({ projectDir, status = null, harnessDir = DEFAULT_HARNESS_DIR }) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const tasksDirAbs = assertSafeWithinRoot(loaded.projectDir, loaded.projectPaths.tasks_dir);
  const taskSchema = JSON.parse(fs.readFileSync(path.join(loaded.schemasDir, "task-contract.schema.json"), "utf8"));
  const filterStatus = status ? status.trim().toLowerCase() : null;

  if (!fs.existsSync(tasksDirAbs)) {
    return { projectDir: loaded.projectDir, tasksDir: loaded.projectPaths.tasks_dir, tasks: [] };
  }

  const files = walkNonSymlinkFiles(loaded.projectDir, tasksDirAbs, (p) => /^TASK-\d{4}.*\.ya?ml$/i.test(path.basename(p)));
  const tasks = [];
  for (const filePath of files) {
    const relPath = path.relative(loaded.projectDir, filePath).replace(/\\/g, "/");
    try {
      const data = parseYaml(fs.readFileSync(filePath, "utf8"), relPath);
      if (data?.is_example) continue;
      if (!validateAgainstSchema(data, taskSchema).valid) continue;
      if (filterStatus && data.status !== filterStatus) continue;
      tasks.push({
        id: data.id,
        title: data.title,
        status: data.status,
        priority: data.priority,
        assignedRole: data.assigned_role,
        contextBudget: data.context_budget,
        evidenceCount: (data.evidence_refs || []).length,
        relPath,
        activeInState: (loaded.state.active_tasks || []).includes(data.id),
      });
    } catch {
      // Ignore malformed non-task files during list
    }
  }

  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return {
    projectDir: loaded.projectDir,
    tasksDir: loaded.projectPaths.tasks_dir,
    tasks,
  };
}

/**
 * Checks whether two file-scope strings/globs overlap (exact, parent/child, or wildcard).
 */
export function scopesOverlap(scopeA, scopeB) {
  const norm = (raw) =>
    String(raw || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/\*\*$/, "")
      .replace(/\/\*$/, "")
      .replace(/\/+$/, "");
  const a = norm(scopeA);
  const b = norm(scopeB);
  if (a === "" || a === "*" || a === "." || b === "" || b === "*" || b === ".") {
    return true;
  }
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export const TASK_LEASES_PATH = ".geloforge/task-leases.yaml";

function readLeasesFile(projectDir) {
  const leasesRelPath = TASK_LEASES_PATH;
  const leasesAbs = assertSafeWithinRoot(projectDir, leasesRelPath);
  if (!fs.existsSync(leasesAbs)) {
    return { leasesRelPath, leasesAbs, exists: false, leases: [] };
  }
  const st = fs.lstatSync(leasesAbs);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Refusing symbolic link or non-regular lease registry: ${leasesRelPath}`);
  }
  const raw = fs.readFileSync(leasesAbs, "utf8");
  if (hasSecretContent(raw)) {
    throw new Error(`Blocked credential-like pattern in ${leasesRelPath}.`);
  }
  const parsed = parseYaml(raw, leasesRelPath);
  const leases = Array.isArray(parsed?.leases) ? parsed.leases : [];
  return { leasesRelPath, leasesAbs, exists: true, leases };
}

/**
 * Lists active and expired cooperative task/scope leases under `.geloforge/task-leases.yaml`.
 */
export function listTaskLeases({
  projectDir,
  nowIso = new Date().toISOString(),
  includeExpired = false,
  harnessDir = DEFAULT_HARNESS_DIR,
} = {}) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const nowMs = Date.parse(validateCreatedAt(nowIso));
  const { leasesRelPath, leases } = readLeasesFile(loaded.projectDir);

  const activeLeases = [];
  const expiredLeases = [];
  for (const entry of leases) {
    if (!entry || typeof entry !== "object" || typeof entry.task_id !== "string") continue;
    const expMs = Date.parse(String(entry.expires_at || ""));
    if (Number.isFinite(expMs) && expMs > nowMs) {
      activeLeases.push(entry);
    } else {
      expiredLeases.push(entry);
    }
  }
  activeLeases.sort((a, b) => a.task_id.localeCompare(b.task_id));
  expiredLeases.sort((a, b) => a.task_id.localeCompare(b.task_id));

  return {
    projectDir: loaded.projectDir,
    leasesRelPath,
    activeLeases,
    expiredLeases,
    leases: includeExpired ? [...activeLeases, ...expiredLeases] : activeLeases,
  };
}

function indexEvidenceById(projectDir, projectPaths, schemasDir) {
  const evidDirRel = String(projectPaths.evidence_dir || "evidence").replace(/\\/g, "/");
  const evidDirAbs = assertSafeWithinRoot(projectDir, evidDirRel);
  const byId = new Map();
  if (!fs.existsSync(evidDirAbs)) {
    return byId;
  }
  const evSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, "evidence-manifest.schema.json"), "utf8"));
  const files = walkNonSymlinkFiles(projectDir, evidDirAbs, (p) => /^EVID-\d{4}.*\.ya?ml$/i.test(path.basename(p)));
  for (const absFile of files) {
    const rel = path.relative(projectDir, absFile).replace(/\\/g, "/");
    try {
      const raw = fs.readFileSync(absFile, "utf8");
      if (hasSecretContent(raw)) {
        continue;
      }
      const data = parseYaml(raw, rel);
      if (!data || typeof data.id !== "string") continue;
      const schemaRes = validateAgainstSchema(data, evSchema);
      const checks = Array.isArray(data.checks) ? data.checks : [];
      const passed = checks.filter((c) => c.result === "passed").length;
      const failedOrBlocked = checks.filter((c) => c.result === "failed" || c.result === "blocked").length;
      const isVerified =
        schemaRes.valid &&
        data.is_example !== true &&
        data.status === "verified" &&
        checks.length > 0 &&
        passed > 0 &&
        failedOrBlocked === 0;
      let reason = "verified";
      if (!schemaRes.valid) reason = `schema invalid (${schemaRes.errors.join("; ")})`;
      else if (data.is_example === true) reason = "is_example fixture";
      else if (data.status !== "verified") reason = `status="${data.status}" (expected "verified")`;
      else if (passed === 0 || failedOrBlocked > 0) reason = `checks passed=${passed}, failed/blocked=${failedOrBlocked}`;
      const id = data.id.trim().toUpperCase();
      byId.set(id, {
        id,
        relPath: rel,
        isVerified,
        reason,
        taskId: data.task_id,
        createdAtMs: Date.parse(data.created_at),
        isFailedDraft: schemaRes.valid && data.is_example !== true && data.status === "draft" && failedOrBlocked > 0,
      });
    } catch (err) {
      const idMatch = path.basename(rel).match(/^(EVID-\d{4})/i);
      if (idMatch) {
        byId.set(idMatch[1].toUpperCase(), {
          id: idMatch[1].toUpperCase(),
          relPath: rel,
          isVerified: false,
          reason: `unreadable YAML (${err.message})`,
        });
      }
    }
  }
  return byId;
}

function isLaterEvidence(left, right) {
  // Allocated evidence IDs order attempts created within the same timestamp.
  return left.createdAtMs > right.createdAtMs
    || (left.createdAtMs === right.createdAtMs && left.id > right.id);
}

export function verifyTaskEvidenceRefs({
  projectDir,
  projectPaths,
  schemasDir,
  evidenceRefs = [],
  strictExplicit = false,
  taskId = null,
}) {
  const byId = indexEvidenceById(projectDir, projectPaths, schemasDir);
  const verifiedIds = [];
  const unverifiedIds = [];
  const reasons = [];
  const seen = new Set();
  const failedDrafts = [];
  let latestVerified = null;

  for (const rawId of evidenceRefs) {
    const clean = String(rawId || "").trim().toUpperCase();
    if (!/^EVID-\d{4}$/.test(clean)) {
      if (strictExplicit) {
        throw new Error(`Invalid evidence ID "${rawId}". Expected EVID-NNNN.`);
      }
      continue;
    }
    if (seen.has(clean)) continue;
    seen.add(clean);

    const entry = byId.get(clean);
    if (!entry) {
      const msg = `${clean} not found under ${projectPaths.evidence_dir}/`;
      if (strictExplicit) {
        throw new Error(`Refusing to link unverified or missing evidence ${clean} (${msg}).`);
      }
      unverifiedIds.push(clean);
      reasons.push(msg);
      continue;
    }
    if (!entry.isVerified) {
      const msg = `${clean} (${entry.relPath}): ${entry.reason}`;
      if (strictExplicit) {
        throw new Error(`Refusing to link unverified evidence ${msg}.`);
      }
      if (taskId !== null && entry.taskId === taskId && entry.isFailedDraft) {
        failedDrafts.push(entry);
      } else {
        unverifiedIds.push(clean);
        reasons.push(msg);
      }
      continue;
    }
    verifiedIds.push(clean);
    if (taskId !== null && entry.taskId === taskId && Number.isFinite(entry.createdAtMs)
      && (!latestVerified || isLaterEvidence(entry, latestVerified))) {
      latestVerified = entry;
    }
  }

  // Retain earlier failed attempts in task history. A newer pass is required on this task.
  for (const draft of failedDrafts) {
    if (!latestVerified || !isLaterEvidence(latestVerified, draft)) {
      unverifiedIds.push(draft.id);
      reasons.push(`${draft.id} (${draft.relPath}): ${draft.reason}`);
    }
  }

  return { verifiedIds, unverifiedIds, reasons };
}

/**
 * Releases a cooperative lease for `taskId` from `.geloforge/task-leases.yaml` (and prunes expired leases).
 * Requires matching advisory `--tool` or `--session` confirmation (or `--force`) when an active lease exists.
 */
export function releaseTaskLease({
  projectDir,
  taskId,
  tool = null,
  sessionId = null,
  role = null,
  force = false,
  nowIso = new Date().toISOString(),
  dryRun = false,
  harnessDir = DEFAULT_HARNESS_DIR,
  lockTimeoutMs,
  staleLockMs,
} = {}) {
  if (typeof projectDir !== "string" || projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <path>).");
  }
  if (typeof taskId !== "string" || !/^TASK-\d{4}$/i.test(taskId.trim())) {
    throw new Error(`Invalid task ID "${taskId}". Expected TASK-NNNN.`);
  }
  const cleanId = taskId.trim().toUpperCase();

  const run = () => {
    const loaded = loadProjectManifestAndState(projectDir, harnessDir);
    const tsIso = validateCreatedAt(nowIso);
    const nowMs = Date.parse(tsIso);
    const { leasesRelPath, leasesAbs, exists, leases } = readLeasesFile(loaded.projectDir);

    if (!exists) {
      return {
        dryRun: Boolean(dryRun),
        released: false,
        taskId: cleanId,
        leasesRelPath,
        identityModel: "advisory_self_declared",
        releasedLease: null,
        releasedByOverride: false,
        activeLeases: [],
      };
    }

    const callerTool = typeof tool === "string" && tool.trim() ? tool.trim() : null;
    const callerSession = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
    const callerRole = typeof role === "string" && role.trim() ? role.trim() : null;

    let removed = false;
    let releasedLease = null;
    const remaining = [];
    for (const entry of leases) {
      if (!entry || typeof entry !== "object") continue;
      const expMs = Date.parse(String(entry.expires_at || ""));
      const isActive = Number.isFinite(expMs) && expMs > nowMs;
      if (entry.task_id === cleanId) {
        if (isActive && !force) {
          if (!callerTool && !callerSession) {
            throw new Error(
              `Refusing unverified lease release on ${cleanId}: active lease is held by tool "${entry.tool}" (session "${entry.session_id}", role "${entry.role}"). Pass matching --tool or --session to confirm cooperative ownership, or pass --force.`
            );
          }
          if (callerTool && callerTool !== entry.tool) {
            throw new Error(
              `Lease ownership mismatch on ${cleanId}: active lease is held by tool "${entry.tool}" (session "${entry.session_id}"), not tool "${callerTool}". Pass --force to override.`
            );
          }
          if (callerSession && callerSession !== entry.session_id) {
            throw new Error(
              `Lease ownership mismatch on ${cleanId}: active lease is held by session "${entry.session_id}" (tool "${entry.tool}"), not session "${callerSession}". Pass --force to override.`
            );
          }
          if (callerRole && callerRole !== entry.role) {
            throw new Error(
              `Lease ownership mismatch on ${cleanId}: active lease is held by role "${entry.role}" (tool "${entry.tool}"), not role "${callerRole}". Pass --force to override.`
            );
          }
        }
        removed = true;
        releasedLease = entry;
        continue;
      }
      if (isActive) {
        remaining.push(entry);
      }
    }

    if (!dryRun) {
      const payload = {
        schema_version: "1.0",
        updated_at: tsIso,
        leases: remaining,
      };
      atomicWriteFile(
        leasesAbs,
        serializeYaml(payload, { headerComment: "Cooperative multi-IDE task & scope leases (advisory collision avoidance)" }),
        { allowOverwrite: true }
      );
    }

    return {
      dryRun: Boolean(dryRun),
      released: removed,
      taskId: cleanId,
      leasesRelPath,
      identityModel: "advisory_self_declared",
      releasedLease,
      releasedByOverride: Boolean(force && releasedLease),
      activeLeases: remaining,
    };
  };

  if (dryRun) {
    return run();
  }
  return withProjectLock(projectDir, run, { lockTimeoutMs, staleLockMs });
}

function prepareTaskUpdatePlan({
  loaded,
  taskInfo,
  harnessDir,
  status,
  priority,
  assignedRole,
  activate = false,
  evidenceRefs = [],
  requireEvidence = false,
  tool = null,
  sessionId = null,
  force = false,
  updatedAt,
  leaseStateOverride = null,
  skipLeaseWrite = false,
}) {
  const tStat = fs.lstatSync(taskInfo.filePath);
  if (tStat.isSymbolicLink() || !tStat.isFile()) {
    throw new Error(`Refusing symbolic link or non-regular task file: ${taskInfo.relPath}`);
  }

  const { projectDir, schemasDir, state, stateSchema, stateFilePath, projectPaths } = loaded;
  const nextStatus = status
    ? String(status).trim().toLowerCase()
    : activate
      ? "active"
      : taskInfo.record.status;
  if (!ALLOWED_TASK_STATUSES.has(nextStatus)) {
    throw new Error(
      `Invalid task status "${nextStatus}". Expected one of: ${Array.from(ALLOWED_TASK_STATUSES).join(", ")}`
    );
  }
  if (activate && (nextStatus === "completed" || nextStatus === "cancelled")) {
    throw new Error(`Cannot --activate a task with terminal status "${nextStatus}".`);
  }

  const nextPriority = priority ? String(priority).trim().toLowerCase() : taskInfo.record.priority;
  if (!ALLOWED_PRIORITIES.has(nextPriority)) {
    throw new Error(`Invalid --priority "${nextPriority}". Expected: low, medium, high, critical.`);
  }

  const nextRole = assignedRole ? String(assignedRole).trim() : taskInfo.record.assigned_role;
  if (!ALLOWED_ROLES.has(nextRole)) {
    throw new Error(`Invalid --role "${nextRole}". Expected one of: ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }

  const timestamp = validateCreatedAt(updatedAt);
  const warnings = [];

  // Check active lease ownership before updating/closing task
  const leaseState = leaseStateOverride || listTaskLeases({ projectDir, nowIso: timestamp, harnessDir });
  const activeLease = (leaseState.activeLeases || []).find((l) => l.task_id === taskInfo.id) || null;
  if (activeLease && !force) {
    const callerTool = typeof tool === "string" && tool.trim() ? tool.trim() : null;
    const callerSession = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
    if (callerTool && callerTool !== activeLease.tool) {
      throw new Error(
        `Lease ownership mismatch on ${taskInfo.id}: active lease belongs to tool "${activeLease.tool}" (session "${activeLease.session_id}"), not "${callerTool}". Pass --force to override.`
      );
    }
    if (callerSession && callerSession !== activeLease.session_id) {
      throw new Error(
        `Lease ownership mismatch on ${taskInfo.id}: active lease belongs to session "${activeLease.session_id}" (tool "${activeLease.tool}"), not "${callerSession}". Pass --force to override.`
      );
    }
    if ((nextStatus === "completed" || nextStatus === "cancelled") && !callerTool && !callerSession) {
      warnings.push(
        `Auto-released active lease on ${taskInfo.id} (tool="${activeLease.tool}") without explicit --tool/--session confirmation.`
      );
    }
  }

  // Validate explicit evidence refs strictly, then compute overall task evidence truth
  const explicitEvIds = normalizeTextList(evidenceRefs, "--evidence").map((s) => s.toUpperCase());
  if (explicitEvIds.length > 0) {
    verifyTaskEvidenceRefs({
      projectDir,
      projectPaths,
      schemasDir,
      evidenceRefs: explicitEvIds,
      strictExplicit: true,
    });
  }

  const mergedEvidenceRefs = Array.from(
    new Set([...(Array.isArray(taskInfo.record.evidence_refs) ? taskInfo.record.evidence_refs : []), ...explicitEvIds])
  );

  const evidEval = verifyTaskEvidenceRefs({
    projectDir,
    projectPaths,
    schemasDir,
    evidenceRefs: mergedEvidenceRefs,
    taskId: taskInfo.id,
  });
  const verified = evidEval.verifiedIds.length > 0 && evidEval.unverifiedIds.length === 0;
  const verificationStatus = verified ? "verified" : "unverified";

  if (nextStatus === "completed") {
    if (requireEvidence && !verified) {
      throw new Error(
        `Refusing to mark ${taskInfo.id} completed with --require-evidence: task lacks verified EVID-* evidence (${evidEval.reasons.join("; ") || "0 linked evidence records"}). Run "geloforge evidence capture --task ${taskInfo.id} -- <test-command>" first.`
      );
    }
    if (!verified) {
      warnings.push(
        `Task ${taskInfo.id} marked completed without verified EVID-* evidence (verificationStatus="unverified"). Task completion alone is not verified test evidence.`
      );
    }
  }

  const updatedRecord = {
    ...taskInfo.record,
    status: nextStatus,
    priority: nextPriority,
    assigned_role: nextRole,
    evidence_refs: mergedEvidenceRefs,
    updated_at: timestamp,
  };

  const taskSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, "task-contract.schema.json"), "utf8"));
  const schemaCheck = validateAgainstSchema(updatedRecord, taskSchema);
  if (!schemaCheck.valid) {
    throw new Error(`Updated task failed schema validation: ${schemaCheck.errors.join("; ")}`);
  }

  let activeTasks = Array.isArray(state.active_tasks) ? [...state.active_tasks] : [];
  let blockedTasks = Array.isArray(state.blocked_tasks) ? [...state.blocked_tasks] : [];
  let lastCompletedTask = state.last_completed_task ?? null;

  if (nextStatus === "completed") {
    activeTasks = activeTasks.filter((t) => t !== taskInfo.id);
    blockedTasks = blockedTasks.filter((t) => t !== taskInfo.id);
    lastCompletedTask = taskInfo.id;
  } else if (nextStatus === "cancelled") {
    activeTasks = activeTasks.filter((t) => t !== taskInfo.id);
    blockedTasks = blockedTasks.filter((t) => t !== taskInfo.id);
  } else if (nextStatus === "blocked") {
    activeTasks = activeTasks.filter((t) => t !== taskInfo.id);
    if (!blockedTasks.includes(taskInfo.id)) blockedTasks.push(taskInfo.id);
  } else if (nextStatus === "active" || activate) {
    if (!activeTasks.includes(taskInfo.id)) activeTasks.push(taskInfo.id);
    blockedTasks = blockedTasks.filter((t) => t !== taskInfo.id);
    if (lastCompletedTask === taskInfo.id) {
      lastCompletedTask = null;
    }
  } else {
    activeTasks = activeTasks.filter((t) => t !== taskInfo.id);
    blockedTasks = blockedTasks.filter((t) => t !== taskInfo.id);
  }

  // Note: NEVER set state.last_verified_evidence from task done alone
  const updatedState = {
    ...state,
    state_revision: (state.state_revision ?? 0) + 1,
    status: state.status === "initialized" && activeTasks.length > 0 ? "active" : state.status,
    updated_at: timestamp,
    active_tasks: activeTasks,
    blocked_tasks: blockedTasks,
    last_completed_task: lastCompletedTask,
  };
  const stCheck = validateAgainstSchema(updatedState, stateSchema);
  if (!stCheck.valid) {
    throw new Error(`Updated operational state failed schema validation: ${stCheck.errors.join("; ")}`);
  }

  const taskYaml = serializeYaml(updatedRecord, { headerComment: `Task Contract ${taskInfo.id}` });
  const stateYaml = serializeYaml(updatedState, { headerComment: "Current Operational Project State" });
  const steps = [
    { label: "task", filePath: taskInfo.filePath, content: taskYaml, allowOverwrite: true },
    { label: "state", filePath: stateFilePath, content: stateYaml, allowOverwrite: true },
  ];

  if (!skipLeaseWrite && (nextStatus === "completed" || nextStatus === "cancelled")) {
    const rawLeases = readLeasesFile(projectDir);
    if (rawLeases.exists && rawLeases.leases.some((l) => l && l.task_id === taskInfo.id)) {
      const remaining = (leaseState.activeLeases || []).filter((l) => l.task_id !== taskInfo.id);
      const leaseYaml = serializeYaml(
        { schema_version: "1.0", updated_at: timestamp, leases: remaining },
        { headerComment: "Cooperative multi-IDE task & scope leases (advisory collision avoidance)" }
      );
      steps.push({ label: "leases", filePath: rawLeases.leasesAbs, content: leaseYaml, allowOverwrite: true });
    }
  }

  return {
    steps,
    warnings,
    result: {
      id: taskInfo.id,
      relPath: taskInfo.relPath,
      previousStatus: taskInfo.record.status,
      status: nextStatus,
      record: updatedRecord,
      stateRevision: updatedState.state_revision,
      activeTasks,
      blockedTasks,
      lastCompletedTask,
      verified,
      verificationStatus,
      verifiedEvidenceRefs: evidEval.verifiedIds,
      warnings,
    },
  };
}

/**
 * Claims a cooperative task & file-scope lease for an AI/IDE session under `.geloforge/.state.lock`,
 * blocking colliding tasks or overlapping scopes unless `--force`.
 */
export function claimTaskLease({
  projectDir,
  taskId,
  role = null,
  tool = "local-agent",
  scopes = [],
  sessionId = null,
  ttlMinutes = 120,
  force = false,
  createdAt,
  dryRun = false,
  harnessDir = DEFAULT_HARNESS_DIR,
  lockTimeoutMs,
  staleLockMs,
  _holdLockMs = 0,
  _faultHook = null,
} = {}) {
  if (typeof projectDir !== "string" || projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <path>).");
  }
  if (typeof taskId !== "string" || !/^TASK-\d{4}$/i.test(taskId.trim())) {
    throw new Error(`Invalid task ID "${taskId}". Expected TASK-NNNN.`);
  }

  const run = () => {
    const taskInfo = getTask({ projectDir, taskId, harnessDir });
    const loaded = loadProjectManifestAndState(projectDir, harnessDir);

    if (!force && (taskInfo.record.status === "completed" || taskInfo.record.status === "cancelled")) {
      throw new Error(
        `Cannot claim ${taskInfo.id} because its status is "${taskInfo.record.status}". Reactivate it or pass --force.`
      );
    }

    const effectiveRole = (role ? String(role) : taskInfo.record.assigned_role).trim();
    if (!ALLOWED_ROLES.has(effectiveRole)) {
      throw new Error(`Invalid --role "${effectiveRole}". Expected one of: ${Array.from(ALLOWED_ROLES).join(", ")}`);
    }

    const cleanTool = validateScalarText("--tool", String(tool || "local-agent"));
    if (hasSecretContent(cleanTool)) {
      throw new Error("Refusing credential-like content in --tool.");
    }

    const ttl = ttlMinutes === undefined || ttlMinutes === null ? 120 : Number(ttlMinutes);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1440) {
      throw new Error(`Invalid --ttl "${ttlMinutes}". Expected integer minutes between 1 and 1440.`);
    }

    const nowIso = validateCreatedAt(createdAt);
    const nowMs = Date.parse(nowIso);
    const expiresAt = new Date(nowMs + ttl * 60 * 1000).toISOString();

    const rawScopes = Array.isArray(scopes) ? scopes : scopes ? [scopes] : [];
    const claimedScope = rawScopes.length > 0 ? normalizeTextList(rawScopes, "--scope") : [...(taskInfo.record.scope_in || [])];

    const cleanSession = sessionId ? validateScalarText("--session", sessionId) : `sess-${taskInfo.id.toLowerCase()}-${deriveSlug(cleanTool) || "agent"}`;
    if (hasSecretContent(cleanSession)) {
      throw new Error("Refusing credential-like content in --session.");
    }

    const leaseState = listTaskLeases({ projectDir: loaded.projectDir, nowIso, harnessDir });
    if (Number.isFinite(Number(_holdLockMs)) && Number(_holdLockMs) > 0) {
      sleepSyncMs(Number(_holdLockMs));
    }

    for (const other of leaseState.activeLeases) {
      if (other.task_id === taskInfo.id) {
        if (!force) {
          throw new Error(
            `Task lease collision: ${taskInfo.id} is already claimed by tool "${other.tool}" (role "${other.role}") until ${other.expires_at}. Run "geloforge task release ${taskInfo.id} --tool ${other.tool}" or pass --force.`
          );
        }
        continue;
      }
      if (!force) {
        for (const s1 of claimedScope) {
          for (const s2 of other.claimed_scope || []) {
            if (scopesOverlap(s1, s2)) {
              throw new Error(
                `File-scope collision: scope "${s1}" on ${taskInfo.id} overlaps with active peer lease on ${other.task_id} (tool "${other.tool}", role "${other.role}", scope "${s2}"). Coordinate scopes or pass --force.`
              );
            }
          }
        }
      }
    }

    const newLease = {
      task_id: taskInfo.id,
      title: taskInfo.record.title,
      role: effectiveRole,
      tool: cleanTool,
      session_id: cleanSession,
      identity_mode: "advisory_self_declared",
      claimed_scope: claimedScope,
      claimed_at: nowIso,
      expires_at: expiresAt,
    };

    const nextLeases = [...leaseState.activeLeases.filter((l) => l.task_id !== taskInfo.id), newLease].sort((a, b) =>
      a.task_id.localeCompare(b.task_id)
    );
    const leasesAbs = assertSafeWithinRoot(loaded.projectDir, leaseState.leasesRelPath);

    const updatePlan = prepareTaskUpdatePlan({
      loaded,
      taskInfo,
      harnessDir,
      status: "active",
      assignedRole: effectiveRole,
      activate: true,
      tool: cleanTool,
      sessionId: cleanSession,
      force: true,
      updatedAt: nowIso,
      leaseStateOverride: leaseState,
      skipLeaseWrite: true,
    });

    if (!dryRun) {
      const leaseYaml = serializeYaml(
        {
          schema_version: "1.0",
          updated_at: nowIso,
          leases: nextLeases,
        },
        { headerComment: "Cooperative multi-IDE task & scope leases (advisory collision avoidance)" }
      );
      runMultiFileTransaction(
        [{ label: "leases", filePath: leasesAbs, content: leaseYaml, allowOverwrite: true }, ...updatePlan.steps],
        { projectDir: loaded.projectDir, faultHook: _faultHook }
      );
    }

    return {
      dryRun: Boolean(dryRun),
      projectDir: loaded.projectDir,
      leasesRelPath: leaseState.leasesRelPath,
      identityModel: "advisory_self_declared",
      lease: newLease,
      activeLeases: nextLeases,
    };
  };

  if (dryRun) {
    return run();
  }
  return withProjectLock(projectDir, run, { lockTimeoutMs, staleLockMs });
}

/**
 * Updates an existing TASK-NNNN contract status/priority/role cleanly inside project lock and rollback transaction.
 */
export function updateTask(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <path>).");
  }

  const run = () => {
    const taskInfo = getTask({ projectDir: options.projectDir, taskId: options.taskId, harnessDir });
    const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
    const plan = prepareTaskUpdatePlan({
      loaded,
      taskInfo,
      harnessDir,
      status: options.status,
      priority: options.priority,
      assignedRole: options.assignedRole,
      activate: Boolean(options.activate),
      evidenceRefs: options.evidenceRefs,
      requireEvidence: Boolean(options.requireEvidence),
      tool: options.tool,
      sessionId: options.sessionId,
      force: Boolean(options.force),
      updatedAt: options.updatedAt,
    });

    const dryRun = Boolean(options.dryRun);
    if (!dryRun) {
      runMultiFileTransaction(plan.steps, { projectDir: loaded.projectDir, faultHook: options._faultHook });
    }

    return {
      dryRun,
      ...plan.result,
    };
  };

  if (options.dryRun) {
    return run();
  }
  return withProjectLock(options.projectDir, run, {
    lockTimeoutMs: options.lockTimeoutMs,
    staleLockMs: options.staleLockMs,
  });
}

/**
 * Convenience wrapper marking a task "completed", removing it from active_tasks,
 * updating last_completed_task, checking evidence truth, and releasing any active lease atomically.
 */
export function completeTask(options = {}) {
  return updateTask({
    ...options,
    status: "completed",
    activate: false,
  });
}

/**
 * Loads a single TASK-NNNN contract by exact ID.
 */
export function getTask({ projectDir, taskId, harnessDir = DEFAULT_HARNESS_DIR }) {
  if (typeof taskId !== "string" || !/^TASK-\d{4}$/i.test(taskId.trim())) {
    throw new Error(`Invalid task ID "${taskId}". Expected TASK-NNNN.`);
  }
  const cleanId = taskId.trim().toUpperCase();
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const tasksDirAbs = assertSafeWithinRoot(loaded.projectDir, loaded.projectPaths.tasks_dir);

  if (fs.existsSync(tasksDirAbs)) {
    const files = walkNonSymlinkFiles(loaded.projectDir, tasksDirAbs, (p) => /^TASK-\d{4}.*\.ya?ml$/i.test(path.basename(p)));
    for (const filePath of files) {
      const relPath = path.relative(loaded.projectDir, filePath).replace(/\\/g, "/");
      const raw = fs.readFileSync(filePath, "utf8");
      const data = parseYaml(raw, relPath);
      if (data && data.id === cleanId) {
        return {
          projectDir: loaded.projectDir,
          id: cleanId,
          relPath,
          filePath,
          record: data,
          yaml: raw,
          activeInState: (loaded.state.active_tasks || []).includes(cleanId),
        };
      }
    }
  }
  throw new Error(`Task "${cleanId}" not found under ${loaded.projectPaths.tasks_dir} in ${loaded.projectDir}.`);
}
