/**
 * Reusable project Second Brain validator.
 * Verifies core files, manifest/state schemas, version compatibility, record schemas,
 * duplicate IDs, cross-record references, markdown links, and portability hygiene.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, extractFrontmatter } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { assertSafeWithinRoot, isForbiddenSecretPath, walkNonSymlinkFiles } from "./path-safety.mjs";
import { resolveProjectPaths } from "./project-locator.mjs";
import {
  loadCompatibilityConfig,
  checkManifestCompatibility,
  checkRecordSchemaVersion,
} from "./compatibility.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const SCHEMAS_DIR = path.join(HARNESS_DIR, "schemas");

const RECORD_TYPES = [
  { prefix: "ADR", regex: /^ADR-\d{4}.*\.md$/i, schema: "adr.schema.json", frontmatter: true },
  { prefix: "RES", regex: /^RES-\d{4}.*\.md$/i, schema: "research-record.schema.json", frontmatter: true },
  { prefix: "TASK", regex: /^TASK-\d{4}.*\.ya?ml$/i, schema: "task-contract.schema.json", frontmatter: false },
  { prefix: "HANDOFF", regex: /^HANDOFF-\d{4}.*\.ya?ml$/i, schema: "agent-handoff.schema.json", frontmatter: false },
  { prefix: "EVID", regex: /^EVID-\d{4}.*\.ya?ml$/i, schema: "evidence-manifest.schema.json", frontmatter: false },
  { prefix: "APPR", regex: /^APPR-\d{4}.*\.ya?ml$/i, schema: "approval-record.schema.json", frontmatter: false },
  { prefix: "CONF", regex: /^CONF-\d{4}.*\.ya?ml$/i, schema: "conflict-record.schema.json", frontmatter: false },
  { prefix: "INC", regex: /^INC-\d{4}.*\.ya?ml$/i, schema: "incident-record.schema.json", frontmatter: false },
  { prefix: "CHKPT", regex: /^CHKPT-\d{4}.*\.ya?ml$/i, schema: "recovery-checkpoint.schema.json", frontmatter: false },
  { prefix: "CPACK", regex: /^CPACK-\d{4}.*\.ya?ml$/i, schema: "context-pack-manifest.schema.json", frontmatter: false },
];

const SCHEMA_CACHE = new Map();

function loadSchema(schemaName) {
  if (!SCHEMA_CACHE.has(schemaName)) {
    const schemaPath = path.join(SCHEMAS_DIR, schemaName);
    SCHEMA_CACHE.set(schemaName, JSON.parse(fs.readFileSync(schemaPath, "utf8")));
  }
  return SCHEMA_CACHE.get(schemaName);
}

function stripFencedAndInlineCode(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      out.push(line.replace(/`[^`]*`/g, ""));
    }
  }
  return out.join("\n");
}

const IGNORED_PROJECT_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  "vendor",
  "obj",
  "coverage",
  ".cache",
]);

function isSecondBrainOrGuideRelPath(relPath, projectPaths) {
  const norm = relPath.replace(/\\/g, "/");
  if (norm === "AGENTS.md" || norm === "GEMINI.md" || norm === "CLAUDE.md") {
    return true;
  }
  const prefixes = [
    "brain/",
    `${projectPaths.tasks_dir}/`,
    `${projectPaths.evidence_dir}/`,
    `${projectPaths.proposals_dir}/`,
    `${projectPaths.handoffs_dir}/`,
  ];
  return prefixes.some((p) => norm.startsWith(p) || norm === p.slice(0, -1));
}

function matchRecordType(fileName) {
  for (const spec of RECORD_TYPES) {
    if (spec.regex.test(fileName)) {
      return spec;
    }
  }
  return null;
}

export function validateProject(rawProjectDir, options = {}) {
  const errors = [];
  const warnings = [];
  const compatConfig = options.compatibilityConfig || loadCompatibilityConfig();
  const referenceDate = options.referenceDate || new Date().toISOString().slice(0, 10);

  if (typeof rawProjectDir !== "string" || rawProjectDir.trim().length === 0) {
    return {
      valid: false,
      errors: ["Project path must be a non-empty string."],
      warnings,
      compatibilityStatus: "invalid",
      recordCount: 0,
      checkedMarkdownFiles: 0,
    };
  }

  const projectDir = path.resolve(rawProjectDir);
  if (!fs.existsSync(projectDir)) {
    return {
      valid: false,
      errors: [`Project directory does not exist: ${projectDir}`],
      warnings,
      compatibilityStatus: "invalid",
      recordCount: 0,
      checkedMarkdownFiles: 0,
    };
  }
  const projectStat = fs.lstatSync(projectDir);
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) {
    return {
      valid: false,
      errors: [`Project root must be a real non-symlink directory: ${projectDir}`],
      warnings,
      compatibilityStatus: "invalid",
      recordCount: 0,
      checkedMarkdownFiles: 0,
    };
  }

  let manifest = null;
  let state = null;
  let compatibilityStatus = "unknown";
  let projectPaths = resolveProjectPaths(null);

  // 1. Verify and parse brain/manifest.yaml first so custom paths can be resolved cleanly
  const manifestRel = "brain/manifest.yaml";
  try {
    const manifestFull = assertSafeWithinRoot(projectDir, manifestRel);
    if (!fs.existsSync(manifestFull)) {
      errors.push(`Missing required project file: ${manifestRel}`);
    } else if (!fs.lstatSync(manifestFull).isFile()) {
      errors.push(`Required project path must be a regular file: ${manifestRel}`);
    } else {
      try {
        manifest = parseYaml(fs.readFileSync(manifestFull, "utf8"), manifestRel);
        const mRes = validateAgainstSchema(manifest, loadSchema("project-manifest.schema.json"));
        if (!mRes.valid) {
          errors.push(`brain/manifest.yaml schema error(s): ${mRes.errors.join("; ")}`);
        }
        const compat = checkManifestCompatibility(manifest, compatConfig);
        compatibilityStatus = compat.status;
        errors.push(...compat.errors);
        warnings.push(...compat.warnings);
        projectPaths = resolveProjectPaths(manifest);

        if (manifest && manifest.paths && typeof manifest.paths === "object") {
          const requiredPathKeys = [
            "brain_index",
            "prd",
            "constraints",
            "architecture",
            "state",
            "decisions_dir",
            "tasks_dir",
          ];
          for (const [key, relVal] of Object.entries(manifest.paths)) {
            try {
              const resolved = assertSafeWithinRoot(projectDir, relVal);
              if (requiredPathKeys.includes(key) && !fs.existsSync(resolved)) {
                errors.push(`manifest.paths.${key} target does not exist: ${relVal}`);
              }
            } catch (err) {
              errors.push(`manifest.paths.${key} unsafe: ${err.message}`);
            }
          }
        }

        if (manifest && manifest.profile) {
          const profileGuide = path.join(projectDir, "brain", "profile.md");
          if (!fs.existsSync(profileGuide)) {
            errors.push(`Manifest declares profile "${manifest.profile}", but brain/profile.md is missing.`);
          }
        }
      } catch (err) {
        errors.push(`Failed to parse brain/manifest.yaml: ${err.message}`);
      }
    }
  } catch (err) {
    errors.push(`Core project file unsafe (${manifestRel}): ${err.message}`);
  }

  // 2. Verify remaining core required files using resolved paths
  const requiredCoreFiles = Array.from(
    new Set([
      projectPaths.state,
      projectPaths.brain_index,
      projectPaths.prd,
      projectPaths.constraints,
      projectPaths.architecture,
    ])
  );
  for (const rel of requiredCoreFiles) {
    try {
      const full = assertSafeWithinRoot(projectDir, rel);
      if (!fs.existsSync(full)) {
        errors.push(`Missing required project file: ${rel}`);
      } else if (!fs.lstatSync(full).isFile()) {
        errors.push(`Required project path must be a regular file: ${rel}`);
      }
    } catch (err) {
      errors.push(`Core project file unsafe (${rel}): ${err.message}`);
    }
  }

  // 3. Parse and validate operational state file
  let statePath = null;
  try {
    statePath = assertSafeWithinRoot(projectDir, projectPaths.state);
  } catch {
    statePath = null;
  }
  if (statePath && fs.existsSync(statePath) && fs.lstatSync(statePath).isFile()) {
    try {
      state = parseYaml(fs.readFileSync(statePath, "utf8"), projectPaths.state);
      const sVer = checkRecordSchemaVersion(state, compatConfig);
      if (!sVer.compatible) {
        errors.push(`${projectPaths.state}: ${sVer.error}`);
      }
      const sRes = validateAgainstSchema(state, loadSchema("project-state.schema.json"));
      if (!sRes.valid) {
        errors.push(`${projectPaths.state} schema error(s): ${sRes.errors.join("; ")}`);
      }
      if (manifest && state && manifest.project_id !== state.project_id) {
        errors.push(
          `Project ID mismatch: manifest.project_id="${manifest.project_id}" vs state.project_id="${state.project_id}"`
        );
      }
    } catch (err) {
      errors.push(`Failed to parse ${projectPaths.state}: ${err.message}`);
    }
  }

  // 4. Scan structured records across resolved core & optional record folders
  const recordDirs = Array.from(
    new Set([
      projectPaths.decisions_dir,
      projectPaths.research_dir,
      projectPaths.conflicts_dir,
      projectPaths.incidents_dir,
      projectPaths.tasks_dir,
      projectPaths.evidence_dir,
      projectPaths.proposals_dir,
      projectPaths.handoffs_dir,
    ])
  );
  const canonicalDirs = new Set(recordDirs.filter((d) => d !== projectPaths.proposals_dir));
  const records = [];
  const seenIds = new Map();

  for (const relDir of recordDirs) {
    const absDir = path.join(projectDir, relDir);
    if (!fs.existsSync(absDir)) {
      continue;
    }
    const files = walkNonSymlinkFiles(projectDir, absDir, (p) => /\.(md|ya?ml)$/i.test(p), null, {
      onSymlink: (_rel, msg) => errors.push(msg),
    });
    for (const filePath of files) {
      const fileName = path.basename(filePath);
      const spec = matchRecordType(fileName);
      if (!spec) {
        const relUnrecognized = path.relative(projectDir, filePath).replace(/\\/g, "/");
        const skillsDraftPrefix = `${projectPaths.proposals_dir.replace(/\\/g, "/")}/skills/`;
        if (relDir === projectPaths.proposals_dir && relUnrecognized.startsWith(skillsDraftPrefix)) {
          continue;
        }
        if (!/^(README|INDEX)\.md$/i.test(fileName)) {
          warnings.push(`Unrecognized file in structured record directory ${relDir}: ${relUnrecognized}`);
        }
        continue;
      }
      const relFile = path.relative(projectDir, filePath).replace(/\\/g, "/");
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = spec.frontmatter ? extractFrontmatter(raw, relFile) : parseYaml(raw, relFile);

        const verCheck = checkRecordSchemaVersion(parsed, compatConfig);
        if (!verCheck.compatible) {
          errors.push(`${relFile}: ${verCheck.error}`);
        }

        const schemaRes = validateAgainstSchema(parsed, loadSchema(spec.schema));
        if (!schemaRes.valid) {
          errors.push(`${relFile} failed ${spec.schema}: ${schemaRes.errors.join("; ")}`);
        }

        if (parsed && typeof parsed.id === "string") {
          if (seenIds.has(parsed.id)) {
            errors.push(`Duplicate record ID "${parsed.id}" found in ${relFile} and ${seenIds.get(parsed.id)}`);
          } else {
            seenIds.set(parsed.id, relFile);
          }
        }

        if (canonicalDirs.has(relDir) && parsed?.is_example === true) {
          errors.push(`${relFile}: example record (is_example: true) is forbidden in canonical directory ${relDir}`);
        }

        if (spec.prefix === "ADR" && parsed?.status === "accepted") {
          if (!parsed.approved_by || !parsed.decided_at) {
            errors.push(`${relFile}: accepted ADR must specify non-null approved_by and decided_at`);
          }
        }

        if (
          spec.prefix === "RES" &&
          typeof parsed?.valid_until === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(parsed.valid_until) &&
          parsed.valid_until < referenceDate
        ) {
          warnings.push(`${relFile}: research record ${parsed.id} expired on ${parsed.valid_until} (< ${referenceDate})`);
        }

        records.push({ relFile, spec, data: parsed });
      } catch (err) {
        errors.push(`Failed to parse record ${relFile}: ${err.message}`);
      }
    }
  }

  // 5. Cross-record reference integrity checks
  const ensureIdExists = (sourceLabel, refId) => {
    if (typeof refId === "string" && !seenIds.has(refId)) {
      errors.push(`${sourceLabel}: broken reference to unknown record ID "${refId}"`);
    }
  };

  if (state && typeof state === "object") {
    for (const id of state.active_tasks || []) ensureIdExists("brain/state/current.yaml#active_tasks", id);
    for (const id of state.blocked_tasks || []) ensureIdExists("brain/state/current.yaml#blocked_tasks", id);
    for (const id of state.pending_approvals || []) ensureIdExists("brain/state/current.yaml#pending_approvals", id);
    for (const id of state.open_conflicts || []) ensureIdExists("brain/state/current.yaml#open_conflicts", id);
    if (state.last_verified_evidence) ensureIdExists("brain/state/current.yaml#last_verified_evidence", state.last_verified_evidence);
    if (state.last_completed_task) ensureIdExists("brain/state/current.yaml#last_completed_task", state.last_completed_task);
    if (state.last_checkpoint) ensureIdExists("brain/state/current.yaml#last_checkpoint", state.last_checkpoint);

    const activeSet = new Set(state.active_tasks || []);
    const blockedSet = new Set(state.blocked_tasks || []);
    for (const id of activeSet) {
      if (blockedSet.has(id)) {
        errors.push(`brain/state/current.yaml: task "${id}" cannot be in both active_tasks and blocked_tasks`);
      }
    }
    if (state.last_completed_task) {
      if (activeSet.has(state.last_completed_task)) {
        errors.push(`brain/state/current.yaml: last_completed_task "${state.last_completed_task}" cannot also be in active_tasks`);
      }
      if (blockedSet.has(state.last_completed_task)) {
        errors.push(`brain/state/current.yaml: last_completed_task "${state.last_completed_task}" cannot also be in blocked_tasks`);
      }
    }
  }

  const evidById = new Map(
    records.filter((r) => r.spec.prefix === "EVID" && r.data && typeof r.data.id === "string").map((r) => [r.data.id, r])
  );

  for (const { relFile, spec, data } of records) {
    if (!data || typeof data !== "object") continue;

    if (spec.prefix === "TASK") {
      for (const dep of data.dependencies || []) ensureIdExists(`${relFile}#dependencies`, dep);
      for (const ev of data.evidence_refs || []) ensureIdExists(`${relFile}#evidence_refs`, ev);
      if (data.approval_ref) ensureIdExists(`${relFile}#approval_ref`, data.approval_ref);
      for (const inp of data.required_inputs || []) {
        if (inp && typeof inp.path === "string") {
          try {
            const target = assertSafeWithinRoot(projectDir, inp.path);
            if (!fs.existsSync(target)) {
              errors.push(`${relFile}#required_inputs: referenced file does not exist: ${inp.path}`);
            }
          } catch (err) {
            errors.push(`${relFile}#required_inputs: ${err.message}`);
          }
        }
      }
    } else if (spec.prefix === "ADR") {
      for (const sup of data.supersedes || []) ensureIdExists(`${relFile}#supersedes`, sup);
      if (data.superseded_by) ensureIdExists(`${relFile}#superseded_by`, data.superseded_by);
      for (const resId of data.related_research || []) ensureIdExists(`${relFile}#related_research`, resId);
      if (data.approval_ref) ensureIdExists(`${relFile}#approval_ref`, data.approval_ref);
    } else if (spec.prefix === "HANDOFF") {
      if (data.task_id) ensureIdExists(`${relFile}#task_id`, data.task_id);
      for (const ev of data.evidence_refs || []) ensureIdExists(`${relFile}#evidence_refs`, ev);
      for (const conf of data.conflicts_detected || []) ensureIdExists(`${relFile}#conflicts_detected`, conf);
      for (const adr of data.relevant_decisions || []) ensureIdExists(`${relFile}#relevant_decisions`, adr);
      for (const ve of data.verified_evidence || []) {
        if (!ve || typeof ve.id !== "string") continue;
        const evRec = evidById.get(ve.id);
        if (!evRec) {
          errors.push(`${relFile}#verified_evidence: forged or missing evidence ID "${ve.id}"`);
          continue;
        }
        const checks = Array.isArray(evRec.data.checks) ? evRec.data.checks : [];
        const passed = checks.filter((c) => c.result === "passed").length;
        const bad = checks.filter((c) => c.result === "failed" || c.result === "blocked").length;
        if (evRec.data.status !== "verified" || passed === 0 || bad > 0 || evRec.data.is_example === true) {
          errors.push(
            `${relFile}#verified_evidence: evidence "${ve.id}" is not verified with passing checks (${passed} passed, ${bad} failed/blocked, status=${evRec.data.status})`
          );
        }
        if (ve.path && ve.path !== evRec.relFile) {
          errors.push(`${relFile}#verified_evidence: path mismatch for "${ve.id}" ("${ve.path}" vs "${evRec.relFile}")`);
        }
      }
      for (const art of data.artifacts_produced || []) {
        if (art && typeof art.path === "string") {
          if (isForbiddenSecretPath(art.path)) {
            errors.push(`${relFile}#artifacts_produced: forbidden secret path "${art.path}"`);
            continue;
          }
          try {
            assertSafeWithinRoot(projectDir, art.path);
          } catch (err) {
            errors.push(`${relFile}#artifacts_produced: ${err.message}`);
          }
        }
      }
    } else if (spec.prefix === "EVID") {
      if (data.task_id) ensureIdExists(`${relFile}#task_id`, data.task_id);
    } else if (spec.prefix === "CONF") {
      if (data.approval_ref) ensureIdExists(`${relFile}#approval_ref`, data.approval_ref);
      for (const item of data.conflicting_records || []) {
        if (item && typeof item.path === "string") {
          try {
            const target = assertSafeWithinRoot(projectDir, item.path);
            if (!fs.existsSync(target)) {
              errors.push(`${relFile}#conflicting_records: referenced file does not exist: ${item.path}`);
            }
          } catch (err) {
            errors.push(`${relFile}#conflicting_records: ${err.message}`);
          }
        }
      }
    } else if (spec.prefix === "INC") {
      for (const t of data.related_tasks || []) ensureIdExists(`${relFile}#related_tasks`, t);
      for (const ev of data.evidence_refs || []) ensureIdExists(`${relFile}#evidence_refs`, ev);
    } else if (spec.prefix === "CHKPT") {
      for (const t of data.active_tasks || []) ensureIdExists(`${relFile}#active_tasks`, t);
      if (data.verification_evidence_ref) {
        ensureIdExists(`${relFile}#verification_evidence_ref`, data.verification_evidence_ref);
      }
    }
  }

  // 6. Markdown links, placeholder hygiene, and portability scan
  const harnessTokenRegex =
    /\{\{(PROJECT_NAME|PROJECT_SLUG|PROJECT_ID|PROJECT_DESCRIPTION|PROJECT_OWNER|CREATED_AT|CREATED_DATE|HARNESS_VERSION|TEMPLATE_VERSION|PROFILE_NAME|PROFILE_VERSION)\}\}/;
  const mdFiles = walkNonSymlinkFiles(projectDir, projectDir, (p) => p.endsWith(".md"), null, {
    ignoreDirs: IGNORED_PROJECT_SCAN_DIRS,
    onSymlink: (_rel, msg) => errors.push(msg),
  });
  const linkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const projectBaseResolved = path.resolve(projectDir);

  for (const mdFile of mdFiles) {
    const relMd = path.relative(projectDir, mdFile).replace(/\\/g, "/");
    const raw = fs.readFileSync(mdFile, "utf8");
    if (harnessTokenRegex.test(raw)) {
      errors.push(`${relMd}: contains unreplaced template placeholder`);
    }
    if (isSecondBrainOrGuideRelPath(relMd, projectPaths) && /(^|[^A-Za-z0-9_])([A-Za-z]:[\\/])/.test(raw)) {
      errors.push(`${relMd}: contains hardcoded Windows drive path`);
    }

    const cleaned = stripFencedAndInlineCode(raw);
    let match;
    while ((match = linkRegex.exec(cleaned)) !== null) {
      const rawTarget = match[1].trim().split(/\s+/)[0];
      if (
        !rawTarget ||
        rawTarget.startsWith("#") ||
        rawTarget.startsWith("http://") ||
        rawTarget.startsWith("https://") ||
        rawTarget.startsWith("mailto:")
      ) {
        continue;
      }
      if (rawTarget.startsWith("file://")) {
        errors.push(`${relMd}: non-portable file:// link "${rawTarget}"`);
        continue;
      }
      const targetNoHash = rawTarget.split("#")[0];
      if (!targetNoHash) continue;
      const resolved = path.resolve(path.dirname(mdFile), targetNoHash);
      const relToRoot = path.relative(projectBaseResolved, resolved);
      if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
        errors.push(`${relMd}: markdown link escapes project root "${rawTarget}"`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        errors.push(`${relMd}: broken relative markdown link "${rawTarget}"`);
      }
    }
  }

  // Check YAML files for leftover harness placeholders too
  const yamlFiles = walkNonSymlinkFiles(projectDir, projectDir, (p) => /\.ya?ml$/i.test(p), null, {
    ignoreDirs: IGNORED_PROJECT_SCAN_DIRS,
    onSymlink: (_rel, msg) => errors.push(msg),
  });
  for (const yf of yamlFiles) {
    const raw = fs.readFileSync(yf, "utf8");
    if (harnessTokenRegex.test(raw)) {
      const relY = path.relative(projectDir, yf).replace(/\\/g, "/");
      errors.push(`${relY}: contains unreplaced template placeholder`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    compatibilityStatus,
    recordCount: records.length,
    checkedMarkdownFiles: mdFiles.length,
  };
}
