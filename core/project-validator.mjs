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
import { assertSafeWithinRoot } from "./path-safety.mjs";
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

function walkFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      results.push(full);
    }
  }
  return results;
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
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    return {
      valid: false,
      errors: [`Project directory does not exist: ${projectDir}`],
      warnings,
      compatibilityStatus: "invalid",
      recordCount: 0,
      checkedMarkdownFiles: 0,
    };
  }

  // 1. Core required files
  const requiredCoreFiles = [
    "brain/manifest.yaml",
    "brain/state/current.yaml",
    "brain/INDEX.md",
    "brain/requirements/prd.md",
    "brain/requirements/constraints.md",
    "brain/architecture/overview.md",
  ];
  for (const rel of requiredCoreFiles) {
    const full = path.join(projectDir, rel);
    if (!fs.existsSync(full)) {
      errors.push(`Missing required project file: ${rel}`);
    }
  }

  let manifest = null;
  let state = null;
  let compatibilityStatus = "unknown";

  // 2. Parse and validate manifest.yaml
  const manifestPath = path.join(projectDir, "brain", "manifest.yaml");
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = parseYaml(fs.readFileSync(manifestPath, "utf8"), "brain/manifest.yaml");
      const mRes = validateAgainstSchema(manifest, loadSchema("project-manifest.schema.json"));
      if (!mRes.valid) {
        errors.push(`brain/manifest.yaml schema error(s): ${mRes.errors.join("; ")}`);
      }
      const compat = checkManifestCompatibility(manifest, compatConfig);
      compatibilityStatus = compat.status;
      errors.push(...compat.errors);
      warnings.push(...compat.warnings);

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

  // 3. Parse and validate state/current.yaml
  const statePath = path.join(projectDir, "brain", "state", "current.yaml");
  if (fs.existsSync(statePath)) {
    try {
      state = parseYaml(fs.readFileSync(statePath, "utf8"), "brain/state/current.yaml");
      const sVer = checkRecordSchemaVersion(state, compatConfig);
      if (!sVer.compatible) {
        errors.push(`brain/state/current.yaml: ${sVer.error}`);
      }
      const sRes = validateAgainstSchema(state, loadSchema("project-state.schema.json"));
      if (!sRes.valid) {
        errors.push(`brain/state/current.yaml schema error(s): ${sRes.errors.join("; ")}`);
      }
      if (manifest && state && manifest.project_id !== state.project_id) {
        errors.push(
          `Project ID mismatch: manifest.project_id="${manifest.project_id}" vs state.project_id="${state.project_id}"`
        );
      }
    } catch (err) {
      errors.push(`Failed to parse brain/state/current.yaml: ${err.message}`);
    }
  }

  // 4. Scan structured records across core & optional record folders
  const recordDirs = [
    "brain/decisions",
    "brain/research",
    "brain/conflicts",
    "brain/incidents",
    "tasks",
    "evidence",
    "proposals",
  ];
  const canonicalDirs = new Set([
    "brain/decisions",
    "brain/research",
    "brain/conflicts",
    "brain/incidents",
    "tasks",
    "evidence",
  ]);
  const records = [];
  const seenIds = new Map();

  for (const relDir of recordDirs) {
    const absDir = path.join(projectDir, relDir);
    if (!fs.existsSync(absDir)) {
      continue;
    }
    const files = walkFiles(absDir, (p) => /\.(md|ya?ml)$/i.test(p));
    for (const filePath of files) {
      const fileName = path.basename(filePath);
      const spec = matchRecordType(fileName);
      if (!spec) {
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
  }

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
    }
  }

  // 6. Markdown links, placeholder hygiene, and portability scan
  const mdFiles = walkFiles(projectDir, (p) => p.endsWith(".md"));
  const linkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;
  const projectBaseResolved = path.resolve(projectDir);

  for (const mdFile of mdFiles) {
    const relMd = path.relative(projectDir, mdFile).replace(/\\/g, "/");
    const raw = fs.readFileSync(mdFile, "utf8");
    if (/\{\{[A-Z0-9_]+\}\}/.test(raw)) {
      errors.push(`${relMd}: contains unreplaced template placeholder`);
    }
    if (/(^|[^A-Za-z0-9_])([A-Za-z]:[\\/])/.test(raw)) {
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

  // Check YAML files for leftover placeholders too
  const yamlFiles = walkFiles(projectDir, (p) => /\.ya?ml$/i.test(p));
  for (const yf of yamlFiles) {
    const raw = fs.readFileSync(yf, "utf8");
    if (/\{\{[A-Z0-9_]+\}\}/.test(raw)) {
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
