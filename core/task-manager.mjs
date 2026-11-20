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
    atomicWriteFile(filePath, yamlText, { allowOverwrite: false });
    if (updatedState) {
      const stateYaml = serializeYaml(updatedState, { headerComment: "Current Operational Project State" });
      atomicWriteFile(stateFilePath, stateYaml, { allowOverwrite: true });
    }
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

function readLeasesFile(projectDir) {
  const leasesRelPath = ".geloforge/task-leases.yaml";
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

/**
 * Releases a cooperative lease for `taskId` from `.geloforge/task-leases.yaml` (and prunes expired leases).
 */
export function releaseTaskLease({
  projectDir,
  taskId,
  nowIso = new Date().toISOString(),
  dryRun = false,
  harnessDir = DEFAULT_HARNESS_DIR,
} = {}) {
  if (typeof taskId !== "string" || !/^TASK-\d{4}$/i.test(taskId.trim())) {
    throw new Error(`Invalid task ID "${taskId}". Expected TASK-NNNN.`);
  }
  const cleanId = taskId.trim().toUpperCase();
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const nowMs = Date.parse(validateCreatedAt(nowIso));
  const { leasesRelPath, leasesAbs, exists, leases } = readLeasesFile(loaded.projectDir);

  if (!exists) {
    return {
      dryRun: Boolean(dryRun),
      released: false,
      taskId: cleanId,
      leasesRelPath,
      activeLeases: [],
    };
  }

  let removed = false;
  const remaining = [];
  for (const entry of leases) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.task_id === cleanId) {
      removed = true;
      continue;
    }
    const expMs = Date.parse(String(entry.expires_at || ""));
    if (Number.isFinite(expMs) && expMs > nowMs) {
      remaining.push(entry);
    }
  }

  if (!dryRun) {
    const payload = {
      schema_version: "1.0",
      updated_at: validateCreatedAt(nowIso),
      leases: remaining,
    };
    atomicWriteFile(leasesAbs, serializeYaml(payload, { headerComment: "Cooperative multi-IDE task & scope leases (advisory collision avoidance)" }), {
      allowOverwrite: true,
    });
  }

  return {
    dryRun: Boolean(dryRun),
    released: removed,
    taskId: cleanId,
    leasesRelPath,
    activeLeases: remaining,
  };
}

/**
 * Claims a cooperative task & file-scope lease for an AI/IDE session, blocking colliding tasks or overlapping scopes unless `--force`.
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
} = {}) {
  if (typeof taskId !== "string" || !/^TASK-\d{4}$/i.test(taskId.trim())) {
    throw new Error(`Invalid task ID "${taskId}". Expected TASK-NNNN.`);
  }
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
  for (const other of leaseState.activeLeases) {
    if (other.task_id === taskInfo.id) {
      if (!force) {
        throw new Error(
          `Task lease collision: ${taskInfo.id} is already claimed by tool "${other.tool}" (role "${other.role}") until ${other.expires_at}. Run "geloforge task release ${taskInfo.id}" or pass --force.`
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
    claimed_scope: claimedScope,
    claimed_at: nowIso,
    expires_at: expiresAt,
  };

  const nextLeases = [...leaseState.activeLeases.filter((l) => l.task_id !== taskInfo.id), newLease].sort((a, b) =>
    a.task_id.localeCompare(b.task_id)
  );
  const leasesAbs = assertSafeWithinRoot(loaded.projectDir, leaseState.leasesRelPath);

  if (!dryRun) {
    atomicWriteFile(
      leasesAbs,
      serializeYaml(
        {
          schema_version: "1.0",
          updated_at: nowIso,
          leases: nextLeases,
        },
        { headerComment: "Cooperative multi-IDE task & scope leases (advisory collision avoidance)" }
      ),
      { allowOverwrite: true }
    );
    updateTask({
      projectDir: loaded.projectDir,
      taskId: taskInfo.id,
      status: "active",
      assignedRole: effectiveRole,
      activate: true,
      updatedAt: nowIso,
      harnessDir,
    });
  }

  return {
    dryRun: Boolean(dryRun),
    projectDir: loaded.projectDir,
    leasesRelPath: leaseState.leasesRelPath,
    lease: newLease,
    activeLeases: nextLeases,
  };
}

/**
 * Updates an existing TASK-NNNN contract status/priority/role and synchronizes brain/state/current.yaml cleanly.
 */
export function updateTask(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const taskInfo = getTask({ projectDir: options.projectDir, taskId: options.taskId, harnessDir });
  const loaded = loadProjectManifestAndState(options.projectDir, harnessDir);
  const { projectDir, schemasDir, state, stateSchema, stateFilePath } = loaded;

  const tStat = fs.lstatSync(taskInfo.filePath);
  if (tStat.isSymbolicLink() || !tStat.isFile()) {
    throw new Error(`Refusing symbolic link or non-regular task file: ${taskInfo.relPath}`);
  }

  const activate = Boolean(options.activate);
  const nextStatus = options.status
    ? String(options.status).trim().toLowerCase()
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

  const nextPriority = options.priority
    ? String(options.priority).trim().toLowerCase()
    : taskInfo.record.priority;
  if (!ALLOWED_PRIORITIES.has(nextPriority)) {
    throw new Error(`Invalid --priority "${nextPriority}". Expected: low, medium, high, critical.`);
  }

  const nextRole = options.assignedRole
    ? String(options.assignedRole).trim()
    : taskInfo.record.assigned_role;
  if (!ALLOWED_ROLES.has(nextRole)) {
    throw new Error(`Invalid --role "${nextRole}". Expected one of: ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }

  const timestamp = validateCreatedAt(options.updatedAt);
  const updatedRecord = {
    ...taskInfo.record,
    status: nextStatus,
    priority: nextPriority,
    assigned_role: nextRole,
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

  const yamlText = serializeYaml(updatedRecord, { headerComment: `Task Contract ${taskInfo.id}` });
  const dryRun = Boolean(options.dryRun);
  if (!dryRun) {
    atomicWriteFile(taskInfo.filePath, yamlText, { allowOverwrite: true });
    atomicWriteFile(
      stateFilePath,
      serializeYaml(updatedState, { headerComment: "Current Operational Project State" }),
      { allowOverwrite: true }
    );
    if (nextStatus === "completed" || nextStatus === "cancelled") {
      releaseTaskLease({ projectDir, taskId: taskInfo.id, nowIso: timestamp, dryRun: false, harnessDir });
    }
  }

  return {
    dryRun,
    id: taskInfo.id,
    relPath: taskInfo.relPath,
    previousStatus: taskInfo.record.status,
    status: nextStatus,
    record: updatedRecord,
    stateRevision: updatedState.state_revision,
    activeTasks,
    blockedTasks,
    lastCompletedTask,
  };
}

/**
 * Convenience wrapper marking a task "completed", removing it from active_tasks,
 * updating last_completed_task, and releasing any active lease.
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
