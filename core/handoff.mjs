/**
 * Cross-Agent File-Based Handoff Engine for GeloForge (v0.3 Stage 3).
 * Creates and inspects schema-valid HANDOFF-NNNN YAML + Markdown summaries across AI tools
 * and agent roles while reading Second Brain contracts read-only, strictly separating
 * verified EVID-* test evidence from unverified agent claims, and refusing secret leaks.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYaml, extractFrontmatter } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import {
  assertSafeWithinRoot,
  atomicWriteFile,
  deriveSlug,
  hasSecretContent,
  isForbiddenSecretPath,
  validateOutputFilePath,
} from "./path-safety.mjs";
import { checkRecordSchemaVersion, loadCompatibilityConfig } from "./compatibility.mjs";

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

const ALLOWED_HANDOFF_STATUSES = new Set(["draft", "submitted", "acknowledged", "rejected", "superseded"]);
const MAX_RECORD_BYTES = 512 * 1024;
const VERIFICATION_CLAIM_REGEX =
  /\b(?:tests?\s+pass(?:ed|ing)?|all\s+checks?\s+pass(?:ed)?|verified\s+pass(?:ing)?|suite\s+pass(?:ed)?|ci\s+green|coverage\s+\d+%)\b/i;

function loadSchema(harnessDir, name) {
  return JSON.parse(fs.readFileSync(path.join(harnessDir, "schemas", name), "utf8"));
}

function readSafeProjectText(projectDir, relPath, warnings) {
  const norm = relPath.replace(/\\/g, "/");
  if (isForbiddenSecretPath(norm)) {
    warnings.push(`Blocked forbidden secret path: ${norm}`);
    return null;
  }
  let resolved;
  try {
    resolved = assertSafeWithinRoot(projectDir, norm);
  } catch (err) {
    warnings.push(`Blocked unsafe path "${norm}": ${err.message}`);
    return null;
  }
  if (!fs.existsSync(resolved)) {
    return null;
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    warnings.push(`Skipped non-regular or symlink file: ${norm}`);
    return null;
  }
  if (stat.size > MAX_RECORD_BYTES) {
    warnings.push(`Skipped oversized file (> ${MAX_RECORD_BYTES} bytes): ${norm}`);
    return null;
  }
  const text = fs.readFileSync(resolved, "utf8");
  if (hasSecretContent(text)) {
    warnings.push(`Blocked file with credential-like content: ${norm}`);
    return null;
  }
  return { resolved, text };
}

function walkNonSymlinkFiles(rootDir, absDir, predicate, warnings) {
  if (!fs.existsSync(absDir)) {
    return [];
  }
  const dirStat = fs.lstatSync(absDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    warnings.push(`Skipped symbolic link directory: ${path.relative(rootDir, absDir).replace(/\\/g, "/")}`);
    return [];
  }
  const out = [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(absDir, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      warnings.push(`Skipped symbolic link inside project: ${path.relative(rootDir, full).replace(/\\/g, "/")}`);
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkNonSymlinkFiles(rootDir, full, predicate, warnings));
    } else if (stat.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function collectGitState(projectDir, warnings) {
  try {
    const inside = execFileSync("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (inside !== "true") {
      return { available: false, branch: null, head: null, dirty: false, changed_files: [] };
    }
  } catch {
    return { available: false, branch: null, head: null, dirty: false, changed_files: [] };
  }

  let branch = null;
  try {
    branch = execFileSync("git", ["-C", projectDir, "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    try {
      branch = execFileSync("git", ["-C", projectDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      branch = null;
    }
  }

  let head = null;
  try {
    head = execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    head = "unborn-head";
  }

  let rawChanged = [];
  let dirty = false;
  try {
    const statusOut = execFileSync("git", ["-C", projectDir, "status", "--porcelain", "-z", "-uall"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
    const tokens = statusOut.split("\0").filter(Boolean);
    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i];
      if (entry.length < 4) continue;
      dirty = true;
      const xy = entry.slice(0, 2);
      const filePath = entry.slice(3).replace(/\\/g, "/");
      if (xy.includes("R") || xy.includes("C")) {
        i += 1;
      }
      if (isForbiddenSecretPath(filePath)) {
        warnings.push(`Excluded sensitive changed path from git_state.changed_files: ${filePath}`);
        continue;
      }
      rawChanged.push(filePath);
    }
  } catch (err) {
    warnings.push(`Unable to collect git status: ${err.message}`);
  }

  const changedFiles = Array.from(new Set(rawChanged)).sort((a, b) => a.localeCompare(b));
  if (changedFiles.length > 100) {
    warnings.push(`Truncated git_state.changed_files from ${changedFiles.length} to 100 entries.`);
  }
  return {
    available: true,
    branch: branch || null,
    head,
    dirty,
    changed_files: changedFiles.slice(0, 100),
  };
}

function yamlScalar(val) {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  return JSON.stringify(String(val));
}

function serializeObjectLines(obj, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (typeof val[0] === "object" && val[0] !== null) {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          const itemEntries = Object.entries(item).filter(([, v]) => v !== undefined);
          if (itemEntries.length === 0) continue;
          const [firstKey, firstVal] = itemEntries[0];
          lines.push(`${pad}  - ${firstKey}: ${yamlScalar(firstVal)}`);
          for (const [k, v] of itemEntries.slice(1)) {
            lines.push(`${pad}    ${k}: ${yamlScalar(v)}`);
          }
        }
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of val) {
          lines.push(`${pad}  - ${yamlScalar(item)}`);
        }
      }
    } else if (typeof val === "object" && val !== null) {
      lines.push(`${pad}${key}:`);
      lines.push(...serializeObjectLines(val, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(val)}`);
    }
  }
  return lines;
}

export function serializeHandoffYaml(record) {
  return `${serializeObjectLines(record, 0).join("\n")}\n`;
}

export function renderHandoffMarkdown(record, inspectMeta = null) {
  const lines = [
    `# Agent Handoff: ${record.id}`,
    "",
    `- **Schema Version:** \`${record.schema_version}\``,
    `- **Task:** ${record.task_id ? `\`${record.task_id}\`` : "None (project-level handoff)"}`,
    `- **Transfer:** \`${record.from_role}\`${record.from_tool ? ` (${record.from_tool})` : ""} -> \`${record.to_role}\`${record.to_tool ? ` (${record.to_tool})` : ""}`,
    `- **Status / Authority:** \`${record.status}\` / \`${record.authority_level}\` (${record.memory_layer})`,
    `- **Created At:** \`${record.created_at}\``,
    `- **Summary:** ${record.summary}`,
  ];

  if (record.git_state) {
    const g = record.git_state;
    lines.push(
      "",
      "## Git State",
      `- **Git Available:** ${g.available ? "Yes" : "No"}`,
      ...(g.available
        ? [
            `- **Branch:** \`${g.branch || "detached"}\` | **HEAD:** \`${g.head || "unknown"}\` | **Dirty:** ${g.dirty ? "Yes" : "No"}`,
            ...(g.changed_files.length > 0
              ? g.changed_files.map((f) => `  - \`${f}\``)
              : ["  - *(no changed files)*"]),
          ]
        : [])
    );
  }

  if (inspectMeta && inspectMeta.gitDrift && inspectMeta.gitDrift.changed) {
    lines.push(
      "",
      `> **Git Revision Drift:** Current repository HEAD is \`${inspectMeta.gitDrift.currentHead}\`, while handoff recorded \`${inspectMeta.gitDrift.recordedHead}\`.`
    );
  }

  lines.push("", "## Requirements & Approved Decisions (Authoritative References)");
  const reqs = record.relevant_requirements || [];
  const decs = record.relevant_decisions || [];
  if (reqs.length === 0 && decs.length === 0) {
    lines.push("- (none linked)");
  } else {
    for (const r of reqs) lines.push(`- Requirement: \`${r}\``);
    for (const d of decs) lines.push(`- Decision: \`${d}\``);
  }

  lines.push("", "## Completed Work");
  if (record.completed_items.length === 0) lines.push("- (none)");
  else for (const item of record.completed_items) lines.push(`- ${item}`);

  lines.push("", "## Verified Evidence (Backed by Audited EVID-* Records)");
  const verifiedEv = record.verified_evidence || [];
  if (verifiedEv.length === 0) {
    lines.push("- *(None verified — do not assume tests/checks passed without inspecting or running them.)*");
  } else {
    for (const ev of verifiedEv) {
      lines.push(
        `- **\`${ev.id}\`** (\`${ev.path}\`, verified_by=\`${ev.verified_by || "unassigned"}\`) — ${ev.checks_summary}`
      );
    }
  }

  lines.push("", "## Unverified Agent Claims (Non-Authoritative — Must Be Verified)");
  const claims = record.unverified_claims || [];
  if (claims.length === 0) lines.push("- (none)");
  else for (const c of claims) lines.push(`- [UNVERIFIED] ${c}`);

  lines.push("", "## Remaining Work & Blockers");
  lines.push("### Open Items");
  if (record.open_items.length === 0) lines.push("- (none)");
  else for (const item of record.open_items) lines.push(`- ${item}`);

  if ((record.blockers || []).length > 0) {
    lines.push("", "### Blockers");
    for (const b of record.blockers) lines.push(`- ${b}`);
  }
  if ((record.open_questions || []).length > 0) {
    lines.push("", "### Open Questions");
    for (const q of record.open_questions) lines.push(`- ${q}`);
  }
  if (record.unresolved_risks.length > 0) {
    lines.push("", "### Unresolved Risks");
    for (const r of record.unresolved_risks) lines.push(`- ${r}`);
  }

  lines.push("", "## Conflicts & Contradiction Warnings");
  const hasConf = record.conflicts_detected.length > 0 || (record.contradiction_warnings || []).length > 0;
  if (!hasConf) {
    lines.push("- (none)");
  } else {
    for (const cid of record.conflicts_detected) lines.push(`- Open Conflict: \`${cid}\``);
    for (const cw of record.contradiction_warnings || []) lines.push(`- [WARNING] ${cw}`);
  }

  lines.push("", "## Recommended Next Action", `- ${record.recommended_next_action}`);
  return `${lines.join("\n")}\n`;
}

function normalizeStringList(raw, fieldName) {
  if (raw === undefined || raw === null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of arr) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`Invalid empty entry in ${fieldName}.`);
    }
    const trimmed = item.trim();
    if (hasSecretContent(trimmed)) {
      throw new Error(`Refusing to write handoff containing credential-like content in ${fieldName}.`);
    }
    out.push(trimmed);
  }
  return out;
}

function loadProjectSnapshot(projectDir, harnessDir, warnings) {
  const manifestRead = readSafeProjectText(projectDir, "brain/manifest.yaml", warnings);
  if (!manifestRead) {
    throw new Error(`Missing or unreadable brain/manifest.yaml in ${projectDir}`);
  }
  const manifest = parseYaml(manifestRead.text, "brain/manifest.yaml");
  const manifestRes = validateAgainstSchema(manifest, loadSchema(harnessDir, "project-manifest.schema.json"));
  if (!manifestRes.valid) {
    throw new Error(`Invalid brain/manifest.yaml: ${manifestRes.errors.join("; ")}`);
  }

  const stateRead = readSafeProjectText(projectDir, "brain/state/current.yaml", warnings);
  if (!stateRead) {
    throw new Error(`Missing or unreadable brain/state/current.yaml in ${projectDir}`);
  }
  const state = parseYaml(stateRead.text, "brain/state/current.yaml");
  const stateRes = validateAgainstSchema(state, loadSchema(harnessDir, "project-state.schema.json"));
  if (!stateRes.valid) {
    throw new Error(`Invalid brain/state/current.yaml: ${stateRes.errors.join("; ")}`);
  }

  const requirements = [];
  for (const reqFile of walkNonSymlinkFiles(projectDir, path.join(projectDir, "brain", "requirements"), (p) => p.endsWith(".md"), warnings)) {
    requirements.push(path.relative(projectDir, reqFile).replace(/\\/g, "/"));
  }

  const decisions = [];
  const decisionSchema = loadSchema(harnessDir, "adr.schema.json");
  for (const df of walkNonSymlinkFiles(projectDir, path.join(projectDir, "brain", "decisions"), (p) => /^ADR-\d{4}.*\.md$/i.test(path.basename(p)), warnings)) {
    const rel = path.relative(projectDir, df).replace(/\\/g, "/");
    const r = readSafeProjectText(projectDir, rel, warnings);
    if (!r) continue;
    try {
      const data = extractFrontmatter(r.text, rel);
      const v = validateAgainstSchema(data, decisionSchema);
      if (v.valid) decisions.push({ rel, data });
    } catch (err) {
      warnings.push(`Skipped malformed ADR ${rel}: ${err.message}`);
    }
  }

  const tasks = [];
  const taskSchema = loadSchema(harnessDir, "task-contract.schema.json");
  for (const tf of walkNonSymlinkFiles(projectDir, path.join(projectDir, "tasks"), (p) => /^TASK-\d{4}.*\.ya?ml$/i.test(path.basename(p)), warnings)) {
    const rel = path.relative(projectDir, tf).replace(/\\/g, "/");
    const r = readSafeProjectText(projectDir, rel, warnings);
    if (!r) continue;
    try {
      const data = parseYaml(r.text, rel);
      const v = validateAgainstSchema(data, taskSchema);
      if (v.valid) tasks.push({ rel, data });
    } catch (err) {
      warnings.push(`Skipped malformed TASK ${rel}: ${err.message}`);
    }
  }

  const evidences = [];
  const evidSchema = loadSchema(harnessDir, "evidence-manifest.schema.json");
  for (const ef of walkNonSymlinkFiles(projectDir, path.join(projectDir, "evidence"), (p) => /^EVID-\d{4}.*\.ya?ml$/i.test(path.basename(p)), warnings)) {
    const rel = path.relative(projectDir, ef).replace(/\\/g, "/");
    const r = readSafeProjectText(projectDir, rel, warnings);
    if (!r) continue;
    try {
      const data = parseYaml(r.text, rel);
      const v = validateAgainstSchema(data, evidSchema);
      if (v.valid) evidences.push({ rel, data });
    } catch (err) {
      warnings.push(`Skipped malformed EVID ${rel}: ${err.message}`);
    }
  }

  const conflicts = [];
  const confSchema = loadSchema(harnessDir, "conflict-record.schema.json");
  for (const cf of walkNonSymlinkFiles(projectDir, path.join(projectDir, "brain", "conflicts"), (p) => /^CONF-\d{4}.*\.ya?ml$/i.test(path.basename(p)), warnings)) {
    const rel = path.relative(projectDir, cf).replace(/\\/g, "/");
    const r = readSafeProjectText(projectDir, rel, warnings);
    if (!r) continue;
    try {
      const data = parseYaml(r.text, rel);
      const v = validateAgainstSchema(data, confSchema);
      if (v.valid) {
        conflicts.push({ rel, data });
      } else {
        warnings.push(`Skipped invalid CONF ${rel}: ${v.errors.join("; ")}`);
      }
    } catch (err) {
      warnings.push(`Skipped malformed CONF ${rel}: ${err.message}`);
    }
  }

  const existingHandoffs = [];
  for (const dirName of ["handoffs", "tasks"]) {
    for (const hf of walkNonSymlinkFiles(projectDir, path.join(projectDir, dirName), (p) => /^HANDOFF-\d{4}.*\.ya?ml$/i.test(path.basename(p)), warnings)) {
      const rel = path.relative(projectDir, hf).replace(/\\/g, "/");
      const r = readSafeProjectText(projectDir, rel, warnings);
      if (!r) continue;
      try {
        const data = parseYaml(r.text, rel);
        if (data && typeof data.id === "string") {
          existingHandoffs.push({ rel, id: data.id, data });
        }
      } catch {
        const idMatch = path.basename(rel).match(/^(HANDOFF-\d{4})/i);
        if (idMatch) existingHandoffs.push({ rel, id: idMatch[1].toUpperCase(), data: null });
      }
    }
  }

  return { manifest, state, requirements, decisions, tasks, evidences, conflicts, existingHandoffs };
}

function summarizeEvidence(ev) {
  const checks = Array.isArray(ev.data.checks) ? ev.data.checks : [];
  const passed = checks.filter((c) => c.result === "passed").length;
  const failed = checks.filter((c) => c.result === "failed").length;
  const other = checks.length - passed - failed;
  const verifiedStatus = ev.data.status === "verified" && failed === 0 && !ev.data.is_example;
  return {
    verified: verifiedStatus,
    failedCount: failed,
    summary: `${passed} passed, ${failed} failed, ${other} other (status=${ev.data.status})`,
  };
}

export function createHandoff(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const workspaceRoot = path.resolve(options.workspaceRoot || path.resolve(harnessDir, ".."));

  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <dir>).");
  }
  const projectDir = path.resolve(options.projectDir);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }
  const rootStat = fs.lstatSync(projectDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Project root must be a real non-symlink directory: ${projectDir}`);
  }

  const fromRole = options.fromRole || "developer";
  const toRole = options.toRole || "qa-security-reviewer";
  if (!ALLOWED_ROLES.has(fromRole)) {
    throw new Error(`Invalid --from-role "${fromRole}". Allowed: ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }
  if (!ALLOWED_ROLES.has(toRole)) {
    throw new Error(`Invalid --to-role "${toRole}". Allowed: ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }
  const status = options.status || "submitted";
  if (!ALLOWED_HANDOFF_STATUSES.has(status)) {
    throw new Error(`Invalid handoff status "${status}".`);
  }

  const fromTool = options.fromTool ? String(options.fromTool).trim() : null;
  const toTool = options.toTool ? String(options.toTool).trim() : null;
  if ((fromTool && hasSecretContent(fromTool)) || (toTool && hasSecretContent(toTool))) {
    throw new Error("Refusing to write handoff containing credential-like content in tool metadata.");
  }

  const warnings = [];
  const contradictionWarnings = [];
  const snap = loadProjectSnapshot(projectDir, harnessDir, warnings);

  // Determine task linkage
  const taskId = options.taskId ? options.taskId.trim() : snap.state.active_tasks?.[0] || null;
  if (taskId !== null && !/^TASK-\d{4}$/.test(taskId)) {
    throw new Error(`Invalid task ID "${taskId}". Expected TASK-NNNN.`);
  }
  let targetTask = null;
  if (taskId) {
    targetTask = snap.tasks.find((t) => t.data.id === taskId) || null;
    if (!targetTask) {
      throw new Error(`Task "${taskId}" was not found or failed validation in ${projectDir}.`);
    }
  }

  // Assign deterministic non-colliding ID
  const usedIds = new Set(snap.existingHandoffs.map((h) => h.id));
  let handoffId = options.id ? options.id.trim().toUpperCase() : null;
  if (handoffId) {
    if (!/^HANDOFF-\d{4}$/.test(handoffId)) {
      throw new Error(`Invalid handoff ID "${handoffId}". Expected format HANDOFF-NNNN.`);
    }
    if (usedIds.has(handoffId)) {
      throw new Error(`Duplicate handoff ID "${handoffId}" already exists in project.`);
    }
  } else {
    let maxNum = 0;
    for (const existing of usedIds) {
      const m = existing.match(/^HANDOFF-(\d{4})$/);
      if (m) maxNum = Math.max(maxNum, Number.parseInt(m[1], 10));
    }
    handoffId = `HANDOFF-${String(maxNum + 1).padStart(4, "0")}`;
  }

  // Validate caller-supplied lists (never allow secret leaks)
  const completedItems = normalizeStringList(options.completedItems, "completed_items");
  const openItems = normalizeStringList(options.openItems, "open_items");
  const unverifiedClaims = normalizeStringList(options.unverifiedClaims, "unverified_claims");
  const blockers = normalizeStringList(options.blockers, "blockers");
  const openQuestions = normalizeStringList(options.openQuestions, "open_questions");
  const unresolvedRisks = normalizeStringList(options.unresolvedRisks, "unresolved_risks");

  const summaryRaw =
    typeof options.summary === "string" && options.summary.trim().length > 0
      ? options.summary.trim()
      : targetTask
        ? `Cross-agent handoff for ${taskId} (${targetTask.data.title}) from ${fromRole} to ${toRole}.`
        : `Project handoff for ${snap.manifest.name} from ${fromRole} to ${toRole}.`;
  if (hasSecretContent(summaryRaw)) {
    throw new Error("Refusing to write handoff containing credential-like content in summary.");
  }

  const nextActionRaw =
    typeof options.nextAction === "string" && options.nextAction.trim().length > 0
      ? options.nextAction.trim()
      : targetTask
        ? `Review ${taskId} acceptance criteria, verified evidence, and open items before continuing.`
        : `Review current operational state and prioritize remaining tasks.`;
  if (hasSecretContent(nextActionRaw)) {
    throw new Error("Refusing to write handoff containing credential-like content in recommended_next_action.");
  }

  const contextPackRef = options.contextPackRef ? options.contextPackRef.trim() : null;
  if (contextPackRef !== null && !/^CPACK-\d{4}$/.test(contextPackRef)) {
    throw new Error(`Invalid --context-pack-ref "${contextPackRef}". Expected CPACK-NNNN.`);
  }

  // Artifacts (if explicitly provided; never fabricate)
  const artifactsProduced = [];
  for (const art of options.artifactsProduced || []) {
    if (!art || typeof art.path !== "string") continue;
    if (isForbiddenSecretPath(art.path)) {
      throw new Error(`Refusing secret artifact path in handoff: ${art.path}`);
    }
    assertSafeWithinRoot(projectDir, art.path);
    const purpose = String(art.purpose || "Artifact produced during task execution").trim();
    if (hasSecretContent(purpose)) {
      throw new Error(`Refusing credential-like content in artifact purpose for ${art.path}`);
    }
    artifactsProduced.push({
      path: art.path.replace(/\\/g, "/"),
      purpose,
      status: ["draft", "proposed", "verified", "rejected"].includes(art.status) ? art.status : "draft",
    });
  }

  // Read-only approved decisions & unapproved ADR alerts
  const relevantDecisions = [];
  for (const adr of snap.decisions) {
    if (adr.data.is_example) continue;
    if (adr.data.status === "accepted" && (!adr.data.approved_by || !adr.data.decided_at)) {
      contradictionWarnings.push(
        `Untrusted ADR ${adr.data.id} (${adr.rel}) has status "accepted" without approved_by/decided_at; excluded from relevant_decisions.`
      );
      continue;
    }
    if (adr.data.status === "accepted") {
      relevantDecisions.push(adr.data.id);
    }
  }
  relevantDecisions.sort();

  // Open conflicts
  const openConflicts = snap.conflicts
    .filter((c) => !c.data.is_example && (c.data.status === "open" || c.data.status === "under_review"))
    .map((c) => c.data.id)
    .sort();
  if (openConflicts.length > 0) {
    contradictionWarnings.push(
      `Project has ${openConflicts.length} unresolved conflict(s): ${openConflicts.join(", ")}.`
    );
  }

  // Gather & strictly verify evidence vs. unverified claims
  const requestedEvidenceIds = normalizeStringList(options.evidenceRefs, "evidence_refs");
  const candidateEvidenceIds = new Set(requestedEvidenceIds);
  if (targetTask) {
    for (const evId of targetTask.data.evidence_refs || []) candidateEvidenceIds.add(evId);
  }
  for (const ev of snap.evidences) {
    if (!ev.data.is_example && taskId && ev.data.task_id === taskId) {
      candidateEvidenceIds.add(ev.data.id);
    }
  }

  const evidenceById = new Map(snap.evidences.map((e) => [e.data.id, e]));
  const evidenceRefs = [];
  const verifiedEvidence = [];
  let failedEvidenceDetected = false;

  for (const evId of Array.from(candidateEvidenceIds).sort()) {
    const ev = evidenceById.get(evId);
    if (!ev) {
      contradictionWarnings.push(
        `Referenced evidence ${evId} does not exist or failed schema validation; excluded from evidence_refs and verified_evidence.`
      );
      unverifiedClaims.push(`Claimed evidence ${evId} not found in audited evidence/*.yaml`);
      continue;
    }
    if (ev.data.is_example) {
      contradictionWarnings.push(`Canonical example fixture ${evId} cannot be used as real task evidence.`);
      continue;
    }
    evidenceRefs.push(ev.data.id);
    const summaryInfo = summarizeEvidence(ev);
    if (summaryInfo.failedCount > 0) {
      failedEvidenceDetected = true;
    }
    if (summaryInfo.verified) {
      verifiedEvidence.push({
        id: ev.data.id,
        path: ev.rel,
        status: "verified",
        verified_by: ev.data.verified_by ?? null,
        checks_summary: summaryInfo.summary,
      });
    } else {
      contradictionWarnings.push(
        `Evidence ${ev.data.id} (${ev.rel}) is not verified (${summaryInfo.summary}); excluded from verified_evidence.`
      );
    }
  }

  // Check for agent verification claims lacking backing verified evidence or contradicting failed checks
  const promotedCompletedWarnings = [];
  for (const item of completedItems) {
    if (VERIFICATION_CLAIM_REGEX.test(item)) {
      if (verifiedEvidence.length === 0 || failedEvidenceDetected) {
        const msg = `Completed item makes test/verification assertion ("${item}") without uncontradicted verified EVID-* record.`;
        contradictionWarnings.push(msg);
        promotedCompletedWarnings.push(`Verification assertion from completed_items (unverified): ${item}`);
      }
    }
  }
  for (const claim of unverifiedClaims) {
    if (VERIFICATION_CLAIM_REGEX.test(claim)) {
      if (verifiedEvidence.length === 0) {
        contradictionWarnings.push(
          `Agent claim asserts verification ("${claim}") with zero verified EVID-* records in evidence/.`
        );
      }
      if (failedEvidenceDetected) {
        contradictionWarnings.push(
          `Contradiction: agent claim asserts verification ("${claim}") while evidence contains failed check(s).`
        );
      }
    }
  }
  const finalUnverifiedClaims = Array.from(new Set([...unverifiedClaims, ...promotedCompletedWarnings]));

  // Derive remaining items from target task acceptance criteria if none provided
  const finalOpenItems =
    openItems.length > 0
      ? openItems
      : targetTask && verifiedEvidence.length === 0
        ? [`Verify task acceptance criteria for ${taskId} before marking complete.`]
        : [];

  const gitState = collectGitState(projectDir, warnings);
  const createdAt = options.createdAt || new Date().toISOString();

  const record = {
    schema_version: "1.1",
    id: handoffId,
    task_id: taskId,
    from_role: fromRole,
    to_role: toRole,
    from_tool: fromTool,
    to_tool: toTool,
    status,
    memory_layer: "L2_OPERATIONAL",
    authority_level: "A4",
    created_at: createdAt,
    summary: summaryRaw,
    completed_items: completedItems,
    open_items: finalOpenItems,
    artifacts_produced: artifactsProduced,
    evidence_refs: evidenceRefs,
    unresolved_risks: unresolvedRisks,
    conflicts_detected: openConflicts,
    recommended_next_action: nextActionRaw,
    context_pack_ref: contextPackRef,
    git_state: gitState,
    relevant_requirements: snap.requirements.sort(),
    relevant_decisions: relevantDecisions,
    verified_evidence: verifiedEvidence,
    unverified_claims: finalUnverifiedClaims,
    blockers,
    open_questions: openQuestions,
    contradiction_warnings: contradictionWarnings,
  };

  const yamlText = serializeHandoffYaml(record);
  const schema = loadSchema(harnessDir, "agent-handoff.schema.json");
  const roundTripParsed = parseYaml(yamlText, `${handoffId}.yaml`);
  const schemaCheck = validateAgainstSchema(roundTripParsed, schema);
  if (!schemaCheck.valid) {
    throw new Error(`Internal handoff failed schema validation: ${schemaCheck.errors.join("; ")}`);
  }

  // Determine destination path safely (refuse symlinks, traversal, or overwrites)
  const slugPart = taskId ? taskId.toLowerCase() : deriveSlug(snap.manifest.name);
  const defaultRel = `handoffs/${handoffId}-${slugPart}.yaml`;
  let targetAbs;
  let targetRel;
  if (options.out) {
    targetAbs = validateOutputFilePath(options.out, { harnessDir, workspaceRoot });
    targetRel = path.relative(projectDir, targetAbs).replace(/\\/g, "/");
  } else {
    const handoffsDir = path.join(projectDir, "handoffs");
    if (fs.existsSync(handoffsDir) && fs.lstatSync(handoffsDir).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link directory: ${handoffsDir}`);
    }
    targetAbs = assertSafeWithinRoot(projectDir, defaultRel);
    targetRel = defaultRel;
  }

  if (fs.existsSync(targetAbs)) {
    throw new Error(`Refusing to overwrite existing handoff file: ${targetAbs}`);
  }

  const dryRun = Boolean(options.dryRun);
  if (!dryRun) {
    atomicWriteFile(targetAbs, yamlText, {
      allowOverwrite: false,
      onBeforeCommit: options.onBeforeCommit || null,
    });
  }

  return {
    id: handoffId,
    taskId,
    filePath: targetAbs,
    relPath: targetRel,
    dryRun,
    record,
    yaml: yamlText,
    markdown: renderHandoffMarkdown(record),
    warnings: [...warnings, ...contradictionWarnings],
  };
}

export function inspectHandoff(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const compatConfig = options.compatibilityConfig || loadCompatibilityConfig();

  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <dir>).");
  }
  const projectDir = path.resolve(options.projectDir);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }
  const rootStat = fs.lstatSync(projectDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Project root must be a real non-symlink directory: ${projectDir}`);
  }

  if (typeof options.handoffPath !== "string" || options.handoffPath.trim().length === 0) {
    throw new Error("Missing handoff file path (--inspect <file>).");
  }
  const relOrRaw = options.handoffPath.trim();
  let resolvedHandoff;
  if (path.isAbsolute(relOrRaw)) {
    // Allow explicit absolute file path inside projectDir (still checking no symlinks/traversal via relative conversion)
    const rel = path.relative(projectDir, path.resolve(relOrRaw));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Handoff file path must reside within project root: ${relOrRaw}`);
    }
    resolvedHandoff = assertSafeWithinRoot(projectDir, rel);
  } else {
    resolvedHandoff = assertSafeWithinRoot(projectDir, relOrRaw);
  }

  if (isForbiddenSecretPath(path.relative(projectDir, resolvedHandoff))) {
    throw new Error(`Refusing secret path as handoff file: ${relOrRaw}`);
  }
  if (!fs.existsSync(resolvedHandoff)) {
    throw new Error(`Handoff file not found: ${resolvedHandoff}`);
  }
  const stat = fs.lstatSync(resolvedHandoff);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Handoff path must be a regular non-symlink file: ${relOrRaw}`);
  }
  if (stat.size > MAX_RECORD_BYTES) {
    throw new Error(`Handoff file exceeds ${MAX_RECORD_BYTES} byte limit: ${relOrRaw}`);
  }

  const rawText = fs.readFileSync(resolvedHandoff, "utf8");
  if (hasSecretContent(rawText)) {
    throw new Error(`Refusing handoff file containing credential-like content: ${relOrRaw}`);
  }

  const relLabel = path.relative(projectDir, resolvedHandoff).replace(/\\/g, "/");
  const record = parseYaml(rawText, relLabel);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Malformed handoff YAML in ${relLabel}: expected mapping object.`);
  }

  const errors = [];
  const warnings = [];
  const verCheck = checkRecordSchemaVersion(record, compatConfig);
  if (!verCheck.compatible) {
    errors.push(verCheck.error);
  }
  const schemaCheck = validateAgainstSchema(record, loadSchema(harnessDir, "agent-handoff.schema.json"));
  if (!schemaCheck.valid) {
    errors.push(...schemaCheck.errors);
  }

  const snap = loadProjectSnapshot(projectDir, harnessDir, warnings);
  if (record.task_id && !snap.tasks.some((t) => t.data.id === record.task_id)) {
    errors.push(`Broken reference task_id="${record.task_id}" not found in project tasks/.`);
  }
  const evMap = new Map(snap.evidences.map((e) => [e.data.id, e]));
  for (const evId of record.evidence_refs || []) {
    const ev = evMap.get(evId);
    if (!ev) {
      errors.push(`Broken reference evidence_refs entry "${evId}" not found in evidence/.`);
    } else if (!summarizeEvidence(ev).verified) {
      warnings.push(`Referenced evidence "${evId}" is not currently verified (${summarizeEvidence(ev).summary}).`);
    }
  }
  const confMap = new Map(snap.conflicts.map((c) => [c.data.id, c]));
  for (const confId of record.conflicts_detected || []) {
    if (!confMap.has(confId)) {
      errors.push(`Broken reference conflicts_detected entry "${confId}" not found in brain/conflicts/.`);
    }
  }
  const adrIds = new Set(snap.decisions.map((d) => d.data.id));
  for (const adrId of record.relevant_decisions || []) {
    if (!adrIds.has(adrId)) {
      errors.push(`Broken reference relevant_decisions entry "${adrId}" not found in brain/decisions/.`);
    }
  }

  const currentGit = collectGitState(projectDir, warnings);
  const recordedHead = record.git_state?.head || null;
  const gitDrift = {
    available: currentGit.available,
    recordedHead,
    currentHead: currentGit.head,
    changed: Boolean(currentGit.available && recordedHead && currentGit.head && recordedHead !== currentGit.head),
  };
  if (gitDrift.changed) {
    warnings.push(`Git HEAD moved since handoff (${recordedHead} -> ${currentGit.head}).`);
  }

  return {
    valid: errors.length === 0,
    compatible: verCheck.compatible,
    compatibilityStatus: verCheck.compatible ? "compatible" : "incompatible",
    id: record.id || null,
    schemaVersion: record.schema_version || null,
    filePath: resolvedHandoff,
    relPath: relLabel,
    record,
    errors,
    warnings,
    gitDrift,
    markdown: errors.length === 0 ? renderHandoffMarkdown(record, { gitDrift }) : null,
  };
}
