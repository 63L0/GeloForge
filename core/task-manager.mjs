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
