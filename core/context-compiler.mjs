/**
 * Deterministic Layer 4 Context Compiler for GeloForge.
 * Reads harness safety policies and project Second Brain records, rejects untrusted/unsafe inputs,
 * ranks optional records deterministically within budget targets, never omits mandatory safety
 * or contradiction context, and emits a traceable CPACK-0001 manifest + Markdown packet.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYaml, extractFrontmatter } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { assertSafeWithinRoot, isForbiddenSecretPath } from "./path-safety.mjs";
import { loadCompatibilityConfig, checkManifestCompatibility } from "./compatibility.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

export const PROFILE_BUDGETS = {
  quick: 2000,
  working: 8000,
  deep: 16000,
};

export const TOKEN_ESTIMATE_METHOD = "heuristic:ceil(utf8_bytes/4)";
const MAX_DOC_BYTES = 512 * 1024;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "what", "where",
  "which", "will", "should", "must", "have", "has", "been", "being", "they", "their",
  "them", "then", "than", "only", "also", "more", "most", "some", "such", "each",
  "other", "about", "after", "before", "between", "through", "under", "over", "using",
  "use", "used", "task", "project", "brain", "file", "files", "all", "not", "are", "but",
]);

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

const RECORD_SPECS = [
  { prefix: "ADR", regex: /^ADR-\d{4}.*\.md$/i, schema: "adr.schema.json", frontmatter: true },
  { prefix: "RES", regex: /^RES-\d{4}.*\.md$/i, schema: "research-record.schema.json", frontmatter: true },
  { prefix: "TASK", regex: /^TASK-\d{4}.*\.ya?ml$/i, schema: "task-contract.schema.json", frontmatter: false },
  { prefix: "HANDOFF", regex: /^HANDOFF-\d{4}.*\.ya?ml$/i, schema: "agent-handoff.schema.json", frontmatter: false },
  { prefix: "EVID", regex: /^EVID-\d{4}.*\.ya?ml$/i, schema: "evidence-manifest.schema.json", frontmatter: false },
  { prefix: "APPR", regex: /^APPR-\d{4}.*\.ya?ml$/i, schema: "approval-record.schema.json", frontmatter: false },
  { prefix: "CONF", regex: /^CONF-\d{4}.*\.ya?ml$/i, schema: "conflict-record.schema.json", frontmatter: false },
  { prefix: "INC", regex: /^INC-\d{4}.*\.ya?ml$/i, schema: "incident-record.schema.json", frontmatter: false },
];

const CANONICAL_DIRS = new Set([
  "brain/decisions",
  "brain/research",
  "brain/conflicts",
  "brain/incidents",
  "tasks",
  "evidence",
]);

export function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function sha256Short(text) {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)}`;
}

function loadSchema(schemasDir, name) {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, name), "utf8"));
}

function getGitHeadRevision(projectDir) {
  try {
    const inside = execFileSync("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (inside !== "true") {
      return "no-git-repo";
    }
    return execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return fs.existsSync(path.join(projectDir, ".git")) ? "git-unborn-head" : "no-git-repo";
  }
}

function tokenizeKeywords(text) {
  if (!text || typeof text !== "string") {
    return new Set();
  }
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

function sanitizeFenceContent(text) {
  // Neutralize any spoofed closing delimiter inside untrusted project content.
  return text.replace(/<<<END_GELOFORGE_DOC>>>/g, "<<<ESCAPED_END_GELOFORGE_DOC>>>");
}

function renderDocFence(doc) {
  const safeText = sanitizeFenceContent(doc.text.trimEnd());
  return [
    `<<<GELOFORGE_DOC path="${doc.path}" layer="${doc.memory_layer}" authority="${doc.authority_level}" trust="${doc.trustLabel}" revision="${doc.revision}" mandatory="${doc.mandatory}" >>>`,
    safeText,
    "<<<END_GELOFORGE_DOC>>>",
  ].join("\n");
}

function loadMandatorySafetyPolicies(harnessDir, profile, warnings) {
  const approvalPath = path.join(harnessDir, "policies", "approval-boundaries.md");
  const memoryPath = path.join(harnessDir, "policies", "memory-policy.md");

  const approvalRaw = fs.readFileSync(approvalPath, "utf8");
  const memoryRaw = fs.readFileSync(memoryPath, "utf8");

  const docs = [
    {
      path: "harness/policies/approval-boundaries.md",
      memory_layer: "L1_AUTHORITATIVE",
      authority_level: "A0",
      revision: sha256Short(approvalRaw),
      reason: "Mandatory global A0 security and approval boundary rules (verbatim).",
      mandatory: true,
      trustLabel: "authoritative-policy",
      section: "policies",
      text: approvalRaw,
    },
  ];

  let useDigest = false;
  let memorySectionText = memoryRaw;
  let memoryReason = "Mandatory global A0 memory authority and write-ownership policy (verbatim).";

  if (profile === "quick") {
    const startIdx = memoryRaw.indexOf("## 3. Knowledge Authority Hierarchy");
    const endIdx = memoryRaw.indexOf("## 4. Write Ownership Rules");
    if (startIdx !== -1 && endIdx > startIdx) {
      const candidate = memoryRaw.slice(startIdx, endIdx).trim();
      const hasAllLevels = ["A0", "A1", "A2", "A3", "A4", "A5", "A6"].every((lvl) => candidate.includes(lvl));
      const hasCriticalRule =
        candidate.includes("CRITICAL RULE") &&
        candidate.includes("NOT automatic permission to ignore contradictory evidence");
      if (memoryRaw.includes(candidate) && hasAllLevels && hasCriticalRule) {
        useDigest = true;
        memorySectionText = `${candidate}\n\n[Integrity-verified verbatim A0-A6 section from harness/policies/memory-policy.md (${sha256Short(memoryRaw)})]`;
        memoryReason = "Mandatory A0-A6 authority & contradiction rules (verified verbatim excerpt; full policy in working/deep).";
      }
    }
    if (!useDigest) {
      warnings.push(
        "Policy digest verification failed for policies/memory-policy.md; included full policy verbatim."
      );
    }
  }

  docs.push({
    path: "harness/policies/memory-policy.md",
    memory_layer: "L1_AUTHORITATIVE",
    authority_level: "A0",
    revision: sha256Short(memoryRaw),
    reason: memoryReason,
    mandatory: true,
    trustLabel: "authoritative-policy",
    section: "policies",
    text: memorySectionText,
  });

  return docs;
}

function safeReadProjectFile(projectDir, relPath, warnings) {
  const normalizedRel = relPath.replace(/\\/g, "/");
  if (isForbiddenSecretPath(normalizedRel)) {
    const reason = `Blocked by security filter (forbidden secret/internal path: ${normalizedRel})`;
    warnings.push(reason);
    return { status: "blocked", reason };
  }

  let resolved;
  try {
    resolved = assertSafeWithinRoot(projectDir, normalizedRel);
  } catch (err) {
    const reason = `Blocked by path-safety filter (${err.message})`;
    warnings.push(reason);
    return { status: "blocked", reason };
  }

  if (!fs.existsSync(resolved)) {
    return { status: "missing" };
  }

  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) {
    return { status: "blocked", reason: `Not a regular file: ${normalizedRel}` };
  }
  if (stat.size > MAX_DOC_BYTES) {
    const reason = `Skipped oversized file (${stat.size} bytes > ${MAX_DOC_BYTES} limit): ${normalizedRel}`;
    warnings.push(reason);
    return { status: "blocked", reason };
  }

  const text = fs.readFileSync(resolved, "utf8");
  for (const pat of SECRET_CONTENT_PATTERNS) {
    if (pat.test(text)) {
      const reason = `Blocked by security filter (credential-like content detected in ${normalizedRel})`;
      warnings.push(reason);
      return { status: "blocked", reason };
    }
  }

  return {
    status: "ok",
    text,
    revision: sha256Short(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function walkNonSymlinkFiles(rootDir, absDir, predicate, warnings) {
  if (!fs.existsSync(absDir)) {
    return [];
  }
  const dirStat = fs.lstatSync(absDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    warnings.push(`Skipped symbolic link or non-directory: ${path.relative(rootDir, absDir)}`);
    return [];
  }
  const results = [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(absDir, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      warnings.push(`Blocked symbolic link inside project: ${path.relative(rootDir, full).replace(/\\/g, "/")}`);
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkNonSymlinkFiles(rootDir, full, predicate, warnings));
    } else if (stat.isFile() && predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

function matchRecordSpec(fileName) {
  for (const spec of RECORD_SPECS) {
    if (spec.regex.test(fileName)) {
      return spec;
    }
  }
  return null;
}

export function compileContext(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  const schemasDir = path.join(harnessDir, "schemas");
  const compatConfig = options.compatibilityConfig || loadCompatibilityConfig();

  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project path (--project <dir>).");
  }
  const projectDir = path.resolve(options.projectDir);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }
  const rootStat = fs.lstatSync(projectDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Project root must be a real non-symlink directory: ${projectDir}`);
  }

  const taskId = options.taskId ? options.taskId.trim() : null;
  const query = options.query ? options.query.trim() : null;
  if (!taskId && !query) {
    throw new Error("Provide either a task ID (--task TASK-NNNN) or a task description (--query <text>).");
  }
  if (taskId && !/^TASK-\d{4}$/.test(taskId)) {
    throw new Error(`Invalid task ID "${taskId}". Expected format TASK-NNNN.`);
  }

  const profile = options.profile || "working";
  if (!Object.hasOwn(PROFILE_BUDGETS, profile)) {
    throw new Error(`Invalid context profile "${profile}". Expected: quick, working, or deep.`);
  }

  const tokenBudgetTarget =
    options.budget !== undefined && options.budget !== null ? Number(options.budget) : PROFILE_BUDGETS[profile];
  if (!Number.isInteger(tokenBudgetTarget) || tokenBudgetTarget < 100) {
    throw new Error(`Invalid token budget "${options.budget}". Must be an integer >= 100.`);
  }

  const referenceDate = options.referenceDate || new Date().toISOString().slice(0, 10);
  const compiledAt = options.compiledAt || new Date().toISOString();

  const warnings = [];
  const freshnessWarnings = [];
  const omittedCandidates = [];
  const unresolvedConflictIds = [];

  // 1. Validate core manifest and project state
  const manifestRead = safeReadProjectFile(projectDir, "brain/manifest.yaml", warnings);
  if (manifestRead.status !== "ok") {
    throw new Error("Missing or unreadable brain/manifest.yaml in target project.");
  }
  const manifest = parseYaml(manifestRead.text, "brain/manifest.yaml");
  const manifestSchemaRes = validateAgainstSchema(
    manifest,
    loadSchema(schemasDir, "project-manifest.schema.json")
  );
  if (!manifestSchemaRes.valid) {
    throw new Error(`Invalid brain/manifest.yaml: ${manifestSchemaRes.errors.join("; ")}`);
  }
  const compat = checkManifestCompatibility(manifest, compatConfig);
  if (!compat.compatible) {
    throw new Error(`Incompatible project manifest: ${compat.errors.join("; ")}`);
  }
  warnings.push(...compat.warnings);

  const stateRead = safeReadProjectFile(projectDir, "brain/state/current.yaml", warnings);
  if (stateRead.status !== "ok") {
    throw new Error("Missing or unreadable brain/state/current.yaml in target project.");
  }
  const state = parseYaml(stateRead.text, "brain/state/current.yaml");
  const stateSchemaRes = validateAgainstSchema(state, loadSchema(schemasDir, "project-state.schema.json"));
  if (!stateSchemaRes.valid) {
    throw new Error(`Invalid brain/state/current.yaml: ${stateSchemaRes.errors.join("; ")}`);
  }
  if (state.project_id !== manifest.project_id) {
    throw new Error(
      `Project ID mismatch between manifest ("${manifest.project_id}") and state ("${state.project_id}").`
    );
  }

  // 2. Load mandatory A0 harness safety policies
  const mandatoryDocs = loadMandatorySafetyPolicies(harnessDir, profile, warnings);

  // Add manifest & state as mandatory L1/L2 orientation records
  mandatoryDocs.push(
    {
      path: "brain/manifest.yaml",
      memory_layer: "L1_AUTHORITATIVE",
      authority_level: "A1",
      revision: manifestRead.revision,
      reason: "Canonical project manifest and metadata.",
      mandatory: true,
      trustLabel: "authoritative",
      section: "authoritative",
      text: manifestRead.text,
    },
    {
      path: "brain/state/current.yaml",
      memory_layer: "L2_OPERATIONAL",
      authority_level: "A4",
      revision: stateRead.revision,
      reason: "Current verified operational state, blockers, and conflicts.",
      mandatory: true,
      trustLabel: "operational",
      section: "operational",
      text: stateRead.text,
    }
  );

  const constraintsRead = safeReadProjectFile(projectDir, "brain/requirements/constraints.md", warnings);
  if (constraintsRead.status === "ok") {
    mandatoryDocs.push({
      path: "brain/requirements/constraints.md",
      memory_layer: "L1_AUTHORITATIVE",
      authority_level: "A1",
      revision: constraintsRead.revision,
      reason: "Mandatory project constraints and non-negotiable invariants.",
      mandatory: true,
      trustLabel: "authoritative",
      section: "authoritative",
      text: constraintsRead.text,
    });
  } else if (constraintsRead.status === "blocked") {
    omittedCandidates.push({ path: "brain/requirements/constraints.md", reason: constraintsRead.reason });
  }

  // 3. Scan project structured records cleanly
  const recordDirs = [
    "brain/decisions",
    "brain/research",
    "brain/conflicts",
    "brain/incidents",
    "tasks",
    "evidence",
    "proposals",
  ];
  const parsedRecords = [];
  const seenIds = new Map();

  for (const relDir of recordDirs) {
    const absDir = path.join(projectDir, relDir);
    const files = walkNonSymlinkFiles(projectDir, absDir, (p) => /\.(md|ya?ml)$/i.test(p), warnings);
    for (const filePath of files) {
      const fileName = path.basename(filePath);
      const spec = matchRecordSpec(fileName);
      if (!spec) {
        continue;
      }
      const relFile = path.relative(projectDir, filePath).replace(/\\/g, "/");
      const readRes = safeReadProjectFile(projectDir, relFile, warnings);
      if (readRes.status !== "ok") {
        omittedCandidates.push({ path: relFile, reason: readRes.reason || "Unreadable file" });
        continue;
      }

      let data;
      try {
        data = spec.frontmatter ? extractFrontmatter(readRes.text, relFile) : parseYaml(readRes.text, relFile);
        const sRes = validateAgainstSchema(data, loadSchema(schemasDir, spec.schema));
        if (!sRes.valid) {
          warnings.push(`Skipped malformed record ${relFile}: ${sRes.errors.join("; ")}`);
          omittedCandidates.push({ path: relFile, reason: `Malformed schema (${spec.schema})` });
          continue;
        }
      } catch (err) {
        warnings.push(`Skipped malformed record ${relFile}: ${err.message}`);
        omittedCandidates.push({ path: relFile, reason: `Malformed YAML/frontmatter (${err.message})` });
        continue;
      }

      if (CANONICAL_DIRS.has(relDir) && data.is_example === true) {
        const msg = `Rejected example fixture (is_example: true) in canonical directory: ${relFile}`;
        warnings.push(msg);
        omittedCandidates.push({ path: relFile, reason: "Example fixture rejected in canonical dir" });
        continue;
      }

      if (typeof data.id === "string") {
        if (seenIds.has(data.id)) {
          warnings.push(`Duplicate record ID "${data.id}" in ${relFile} and ${seenIds.get(data.id)}`);
        } else {
          seenIds.set(data.id, relFile);
        }
      }

      let unverifiedOverride = false;
      if (spec.prefix === "ADR" && data.status === "accepted" && (!data.approved_by || !data.decided_at)) {
        warnings.push(
          `Untrusted ADR status: ${relFile} claims status "accepted" without approved_by/decided_at; quarantined as unverified.`
        );
        unverifiedOverride = true;
      }

      let isStale = false;
      if (
        spec.prefix === "RES" &&
        typeof data.valid_until === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(data.valid_until) &&
        data.valid_until < referenceDate
      ) {
        isStale = true;
        freshnessWarnings.push(
          `${relFile}: ${data.id} expired on ${data.valid_until} (< ${referenceDate}); verify before relying on findings.`
        );
      }

      parsedRecords.push({
        relFile,
        spec,
        data,
        text: readRes.text,
        revision: readRes.revision,
        unverifiedOverride,
        isStale,
      });
    }
  }

  // 4. Identify target task & open conflicts
  let targetTask = null;
  if (taskId) {
    targetTask = parsedRecords.find((r) => r.spec.prefix === "TASK" && r.data.id === taskId) || null;
    if (!targetTask) {
      throw new Error(`Target task "${taskId}" was not found or failed validation in ${projectDir}.`);
    }
    mandatoryDocs.push({
      path: targetTask.relFile,
      memory_layer: targetTask.data.memory_layer,
      authority_level: targetTask.data.authority_level,
      revision: targetTask.revision,
      reason: `Target task contract (${taskId}).`,
      mandatory: true,
      trustLabel: "operational",
      section: "operational",
      text: targetTask.text,
    });
  }

  // Open conflicts are NEVER silenced by token budgets.
  for (const rec of parsedRecords) {
    if (rec.spec.prefix === "CONF" && (rec.data.status === "open" || rec.data.status === "under_review")) {
      unresolvedConflictIds.push(rec.data.id);
      mandatoryDocs.push({
        path: rec.relFile,
        memory_layer: rec.data.memory_layer,
        authority_level: rec.data.authority_level,
        revision: rec.revision,
        reason: `Mandatory unresolved conflict (${rec.data.id}: ${rec.data.severity}).`,
        mandatory: true,
        trustLabel: "conflict-alert",
        section: "conflicts",
        text: rec.text,
      });
    }
  }

  // Check TASK.required_inputs safety & build direct reference set
  const directRefPaths = new Set();
  const directRefIds = new Set(state.active_tasks || []);
  if (targetTask) {
    for (const dep of targetTask.data.dependencies || []) directRefIds.add(dep);
    for (const ev of targetTask.data.evidence_refs || []) directRefIds.add(ev);
    if (targetTask.data.approval_ref) directRefIds.add(targetTask.data.approval_ref);

    for (const inp of targetTask.data.required_inputs || []) {
      if (!inp || typeof inp.path !== "string") continue;
      const norm = inp.path.replace(/\\/g, "/");
      const checkInp = safeReadProjectFile(projectDir, norm, warnings);
      if (checkInp.status === "ok") {
        directRefPaths.add(norm);
      } else {
        omittedCandidates.push({
          path: norm,
          reason: checkInp.reason || `Referenced input missing (${norm})`,
        });
      }
    }
  }

  // 5. Build keyword query set for relevance scoring
  const keywordParts = [];
  if (query) keywordParts.push(query);
  if (targetTask) {
    keywordParts.push(
      targetTask.data.id,
      targetTask.data.title,
      targetTask.data.objective,
      ...(targetTask.data.scope_in || []),
      ...(targetTask.data.acceptance_criteria || [])
    );
  }
  const queryKeywords = tokenizeKeywords(keywordParts.join(" "));

  // 6. Gather & score optional candidates
  const mandatoryPathSet = new Set(mandatoryDocs.map((d) => d.path));
  const optionalCandidates = [];

  const addCandidate = (candidate) => {
    if (mandatoryPathSet.has(candidate.path)) {
      return;
    }
    const titleWords = tokenizeKeywords(`${candidate.title || ""} ${candidate.path} ${(candidate.tags || []).join(" ")}`);
    const bodyWords = tokenizeKeywords(candidate.text);
    let titleMatches = 0;
    let bodyMatches = 0;
    for (const kw of queryKeywords) {
      if (titleWords.has(kw)) titleMatches += 1;
      else if (bodyWords.has(kw)) bodyMatches += 1;
    }

    let score = candidate.basePriority;
    if (candidate.isDirectRef) score += 100;
    score += titleMatches * 12;
    score += Math.min(bodyMatches * 3, 24);

    if (!candidate.isDirectRef && !candidate.isCoreOrientation && queryKeywords.size > 0 && titleMatches === 0 && bodyMatches === 0) {
      omittedCandidates.push({ path: candidate.path, reason: "Not relevant to task or query keywords" });
      return;
    }
    if ((candidate.status === "superseded" || candidate.status === "rejected") && !candidate.isDirectRef && titleMatches === 0) {
      omittedCandidates.push({ path: candidate.path, reason: `Historical ${candidate.status} record not directly referenced` });
      return;
    }

    optionalCandidates.push({
      ...candidate,
      score,
      matchedKeywords: titleMatches + bodyMatches,
    });
  };

  // Core orientation Markdown docs
  const coreOptionalSpecs = [
    { rel: "brain/requirements/prd.md", layer: "L1_AUTHORITATIVE", auth: "A1", trust: "authoritative", section: "authoritative", base: 35, reason: "Product requirements overview." },
    { rel: "brain/architecture/overview.md", layer: "L1_AUTHORITATIVE", auth: "A2", trust: "authoritative", section: "authoritative", base: 30, reason: "Project architecture overview." },
    { rel: "brain/profile.md", layer: "L1_AUTHORITATIVE", auth: "A2", trust: "authoritative", section: "authoritative", base: 20, reason: "Project domain profile conventions." },
    { rel: "brain/INDEX.md", layer: "L2_OPERATIONAL", auth: "A4", trust: "operational", section: "operational", base: 12, reason: "Second Brain navigation index." },
  ];
  for (const spec of coreOptionalSpecs) {
    const readRes = safeReadProjectFile(projectDir, spec.rel, warnings);
    if (readRes.status === "ok") {
      addCandidate({
        path: spec.rel,
        memory_layer: spec.layer,
        authority_level: spec.auth,
        revision: readRes.revision,
        reason: spec.reason,
        mandatory: false,
        trustLabel: spec.trust,
        section: spec.section,
        basePriority: spec.base,
        isCoreOrientation: true,
        isDirectRef: directRefPaths.has(spec.rel),
        title: spec.rel,
        tags: [],
        status: "active",
        text: readRes.text,
      });
    } else if (readRes.status === "blocked") {
      omittedCandidates.push({ path: spec.rel, reason: readRes.reason });
    }
  }

  // Structured records (excluding target task and open conflicts already in mandatoryDocs)
  const structuredCandidatePaths = new Set();
  for (const rec of parsedRecords) {
    if (mandatoryPathSet.has(rec.relFile)) continue;
    structuredCandidatePaths.add(rec.relFile);

    const d = rec.data;
    const isDirect =
      directRefPaths.has(rec.relFile) ||
      directRefIds.has(d.id) ||
      (Array.isArray(d.related_tasks) && taskId && d.related_tasks.includes(taskId)) ||
      (d.task_id && taskId && d.task_id === taskId);

    let trustLabel = "operational";
    let section = "operational";
    let basePriority = 15;
    let reason = `${rec.spec.prefix} record (${d.status || "active"}).`;

    if (rec.spec.prefix === "ADR") {
      if (rec.unverifiedOverride || d.status === "proposed") {
        trustLabel = "non-authoritative-unverified";
        section = "unverified";
        basePriority = 4;
        reason = rec.unverifiedOverride
          ? "Quarantined ADR missing approved_by/decided_at (unverified)."
          : "Proposed ADR (not yet owner-approved).";
      } else if (d.status === "accepted") {
        trustLabel = "authoritative";
        section = "authoritative";
        basePriority = 25;
        reason = "Accepted Architecture Decision Record.";
      } else {
        trustLabel = "historical";
        section = "operational";
        basePriority = -20;
      }
    } else if (rec.spec.prefix === "EVID") {
      trustLabel = d.status === "verified" ? "verified-evidence" : "non-authoritative-unverified";
      section = d.status === "verified" ? "operational" : "unverified";
      basePriority = d.status === "verified" ? 22 : 5;
      reason = d.status === "verified" ? "Verified implementation/test evidence." : `Unverified evidence (${d.status}).`;
    } else if (rec.spec.prefix === "RES") {
      trustLabel = "non-authoritative-external-research";
      section = "unverified";
      basePriority = rec.isStale ? -15 : 10;
      reason = rec.isStale
        ? "Stale external research (non-authoritative; past valid_until)."
        : "External research finding (non-authoritative A5).";
    } else if (rec.spec.prefix === "APPR") {
      trustLabel = d.status === "approved" ? "authoritative" : "operational";
      section = d.status === "approved" ? "authoritative" : "operational";
      basePriority = 16;
    }

    addCandidate({
      path: rec.relFile,
      memory_layer: d.memory_layer,
      authority_level: rec.unverifiedOverride ? "A6" : d.authority_level,
      revision: rec.revision,
      reason: isDirect ? `${reason} (directly referenced)` : reason,
      mandatory: false,
      trustLabel,
      section,
      basePriority,
      isCoreOrientation: false,
      isDirectRef: Boolean(isDirect),
      title: d.title || d.id || rec.relFile,
      tags: d.tags || [],
      status: d.status || "active",
      text: rec.text,
    });
  }

  // Non-record files explicitly listed in TASK.required_inputs (e.g. src/ or docs/)
  for (const relPath of directRefPaths) {
    if (mandatoryPathSet.has(relPath) || coreOptionalSpecs.some((s) => s.rel === relPath) || structuredCandidatePaths.has(relPath)) {
      continue;
    }
    const readRes = safeReadProjectFile(projectDir, relPath, warnings);
    if (readRes.status === "ok") {
      addCandidate({
        path: relPath,
        memory_layer: "L2_OPERATIONAL",
        authority_level: "A4",
        revision: readRes.revision,
        reason: "Explicitly listed in target task required_inputs.",
        mandatory: false,
        trustLabel: "task-input",
        section: "operational",
        basePriority: 40,
        isCoreOrientation: false,
        isDirectRef: true,
        title: relPath,
        tags: [],
        status: "active",
        text: readRes.text,
      });
    }
  }

  // Optional lessons learned under brain/lessons/
  const lessonFiles = walkNonSymlinkFiles(projectDir, path.join(projectDir, "brain", "lessons"), (p) => p.endsWith(".md"), warnings);
  for (const lf of lessonFiles) {
    const relLesson = path.relative(projectDir, lf).replace(/\\/g, "/");
    const readRes = safeReadProjectFile(projectDir, relLesson, warnings);
    if (readRes.status === "ok") {
      addCandidate({
        path: relLesson,
        memory_layer: "L3_RESEARCH_EVIDENCE",
        authority_level: "A4",
        revision: readRes.revision,
        reason: "Project lesson learned.",
        mandatory: false,
        trustLabel: "non-authoritative-lesson",
        section: "unverified",
        basePriority: 8,
        isCoreOrientation: false,
        isDirectRef: directRefPaths.has(relLesson),
        title: relLesson,
        tags: [],
        status: "active",
        text: readRes.text,
      });
    }
  }

  // Deterministic sort: highest score first, lexicographical path tie-breaker.
  optionalCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  // 7. Budget fitting — mandatory documents are NEVER dropped.
  const fixedHeaderOverheadTokens = 260;
  const mandatoryTokenSum =
    fixedHeaderOverheadTokens +
    mandatoryDocs.reduce((acc, doc) => acc + estimateTokens(renderDocFence(doc)) + 4, 0);

  let remainingBudget = tokenBudgetTarget - mandatoryTokenSum;
  const selectedOptional = [];

  for (const cand of optionalCandidates) {
    const entryTokens = estimateTokens(renderDocFence(cand)) + 4;
    if (remainingBudget >= entryTokens) {
      selectedOptional.push(cand);
      remainingBudget -= entryTokens;
    } else {
      omittedCandidates.push({
        path: cand.path,
        reason: `Budget limit reached (${entryTokens} est. tokens needed, ${Math.max(0, remainingBudget)} remaining)`,
      });
    }
  }

  const includedDocs = [...mandatoryDocs, ...selectedOptional];
  const gitRevision = getGitHeadRevision(projectDir);

  // Build Markdown packet organized strictly by trust class
  const renderSection = (title, sectionKey, emptyNote = null) => {
    const items = includedDocs.filter((d) => d.section === sectionKey);
    if (items.length === 0 && !emptyNote) {
      return "";
    }
    const lines = [`## ${title}`];
    if (items.length === 0) {
      lines.push(emptyNote);
    } else {
      for (const doc of items) {
        lines.push("", renderDocFence(doc));
      }
    }
    return lines.join("\n");
  };

  // Pre-compute effective profile & final markdown deterministically
  const preliminaryMarkdown = assembleMarkdown({
    manifest,
    taskId,
    query,
    gitRevision,
    profile,
    effectiveProfile: profile,
    tokenBudgetTarget,
    estimatedTokens: 0,
    budgetOverrun: false,
    freshnessWarnings,
    unresolvedConflictIds,
    warnings,
    omittedCandidates,
    includedDocs,
    renderSection,
  });
  const finalTokens = estimateTokens(preliminaryMarkdown);
  const budgetOverrun = finalTokens > tokenBudgetTarget;
  let effectiveProfile = profile;
  if (budgetOverrun) {
    effectiveProfile = finalTokens <= PROFILE_BUDGETS.working ? "working" : "deep";
    warnings.push(
      `Budget overrun: compiled packet is ~${finalTokens} est. tokens (${TOKEN_ESTIMATE_METHOD}) vs ${profile} target ${tokenBudgetTarget}; mandatory safety/authority policies preserved verbatim (escalated effective_profile: ${effectiveProfile}).`
    );
  }

  const pass2Markdown = assembleMarkdown({
    manifest,
    taskId,
    query,
    gitRevision,
    profile,
    effectiveProfile,
    tokenBudgetTarget,
    estimatedTokens: finalTokens,
    budgetOverrun,
    freshnessWarnings,
    unresolvedConflictIds,
    warnings,
    omittedCandidates,
    includedDocs,
    renderSection,
  });
  const measuredFinalTokens = estimateTokens(pass2Markdown);
  const finalMarkdown =
    measuredFinalTokens === finalTokens
      ? pass2Markdown
      : assembleMarkdown({
          manifest,
          taskId,
          query,
          gitRevision,
          profile,
          effectiveProfile,
          tokenBudgetTarget,
          estimatedTokens: measuredFinalTokens,
          budgetOverrun,
          freshnessWarnings,
          unresolvedConflictIds,
          warnings,
          omittedCandidates,
          includedDocs,
          renderSection,
        });
  const exactFinalTokens = estimateTokens(finalMarkdown);

  // Deterministic cache_key & manifest assembly
  const sortedInputsKey = includedDocs
    .map((d) => `${d.path}@${d.revision}`)
    .sort()
    .join("|");
  const cacheKey = crypto
    .createHash("sha256")
    .update(JSON.stringify({ projectId: manifest.project_id, taskId, query, profile, tokenBudgetTarget, sortedInputsKey }))
    .digest("hex")
    .slice(0, 16);

  omittedCandidates.sort((a, b) => a.path.localeCompare(b.path));
  unresolvedConflictIds.sort();

  const packManifest = {
    schema_version: "1.1",
    id: "CPACK-0001",
    task_id: taskId,
    query,
    project_id: manifest.project_id,
    status: "compiled",
    memory_layer: "L4_TEMPORARY_CONTEXT",
    authority_level: "A4",
    profile,
    effective_profile: effectiveProfile,
    token_budget_target: tokenBudgetTarget,
    estimated_tokens: exactFinalTokens,
    token_estimate_method: TOKEN_ESTIMATE_METHOD,
    budget_overrun: budgetOverrun,
    compiled_at: compiledAt,
    expires_at: null,
    compiler_version: compatConfig.harness_version,
    included_documents: includedDocs.map((d) => ({
      path: d.path,
      memory_layer: d.memory_layer,
      authority_level: d.authority_level,
      revision: d.revision,
      reason: d.reason,
      mandatory: d.mandatory,
    })),
    omitted_candidates: omittedCandidates,
    freshness_warnings: freshnessWarnings,
    unresolved_conflicts: unresolvedConflictIds,
    cache_key: `cpack-${cacheKey}`,
    invalidation_triggers: [
      "harness/policies/*",
      "brain/manifest.yaml",
      "brain/state/current.yaml",
      "brain/requirements/*",
      "brain/decisions/*",
      "brain/conflicts/*",
      ...(taskId ? [`tasks/${taskId}*`] : []),
    ],
  };

  const packValidation = validateAgainstSchema(
    packManifest,
    loadSchema(schemasDir, "context-pack-manifest.schema.json")
  );
  if (!packValidation.valid) {
    throw new Error(`Internal ContextPack manifest failed schema validation: ${packValidation.errors.join("; ")}`);
  }

  return {
    manifest: packManifest,
    markdown: finalMarkdown,
    estimatedTokens: exactFinalTokens,
    tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
    budgetOverrun,
    warnings,
    gitRevision,
    stats: {
      mandatoryCount: mandatoryDocs.length,
      optionalIncludedCount: selectedOptional.length,
      omittedCount: omittedCandidates.length,
      unresolvedConflictCount: unresolvedConflictIds.length,
      freshnessWarningCount: freshnessWarnings.length,
    },
  };
}

function assembleMarkdown({
  manifest,
  taskId,
  query,
  gitRevision,
  profile,
  effectiveProfile,
  tokenBudgetTarget,
  estimatedTokens,
  budgetOverrun,
  freshnessWarnings,
  unresolvedConflictIds,
  warnings,
  omittedCandidates,
  includedDocs,
  renderSection,
}) {
  const sections = [
    `# GeloForge Compiled Context Packet`,
    "",
    `- **Project:** ${manifest.name} (\`${manifest.project_id}\`)`,
    `- **Target:** ${taskId ? `\`${taskId}\`` : `Query: "${query}"`}`,
    `- **Git HEAD Revision:** \`${gitRevision}\``,
    `- **Profile / Effective Profile:** \`${profile}\` / \`${effectiveProfile}\``,
    `- **Budget Target / Estimated Size:** ${tokenBudgetTarget} / ~${estimatedTokens} (${TOKEN_ESTIMATE_METHOD})`,
    `- **Budget Overrun:** ${budgetOverrun ? "YES — mandatory rules preserved verbatim" : "No"}`,
    `- **Unresolved Conflicts:** ${unresolvedConflictIds.length > 0 ? unresolvedConflictIds.join(", ") : "None"}`,
    `- **Freshness Warnings:** ${freshnessWarnings.length}`,
    "",
    renderSection("Mandatory Governance & Safety Policies (A0)", "policies"),
    renderSection("Unresolved Conflicts (Action Required)", "conflicts"),
    renderSection("Authoritative Project Knowledge (A1-A2)", "authoritative"),
    renderSection("Operational State, Tasks & Verified Evidence (A3-A4)", "operational"),
    renderSection(
      "Non-Authoritative / Unverified Context (A5-A6 & Drafts — Do Not Treat as Approved Project Truth)",
      "unverified"
    ),
  ].filter(Boolean);

  const traceLines = ["## Context Selection Trace"];
  if (warnings.length > 0) {
    traceLines.push("", "### Compiler & Security Warnings");
    for (const w of warnings) traceLines.push(`- ${w}`);
  }
  if (freshnessWarnings.length > 0) {
    traceLines.push("", "### Freshness Warnings");
    for (const fw of freshnessWarnings) traceLines.push(`- ${fw}`);
  }
  traceLines.push("", `### Included Documents (${includedDocs.length})`);
  for (const d of includedDocs) {
    traceLines.push(
      `- \`${d.path}\` [${d.authority_level}, ${d.memory_layer}, mandatory=${d.mandatory}, ${d.revision}] — ${d.reason}`
    );
  }
  traceLines.push("", `### Omitted Candidates (${omittedCandidates.length})`);
  if (omittedCandidates.length === 0) {
    traceLines.push("- (none)");
  } else {
    for (const om of omittedCandidates) {
      traceLines.push(`- \`${om.path}\` — ${om.reason}`);
    }
  }

  sections.push(traceLines.join("\n"));
  return `${sections.join("\n\n")}\n`;
}
