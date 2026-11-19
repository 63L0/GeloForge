/**
 * Project root discovery (CWD upward search) and canonical manifest path resolution.
 * Zero external dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSameOrInside, assertSafeWithinRoot, walkNonSymlinkFiles } from "./path-safety.mjs";
import { parseYaml } from "./yaml-subset.mjs";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import { loadCompatibilityConfig, checkManifestCompatibility, checkRecordSchemaVersion } from "./compatibility.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

export const DEFAULT_PROJECT_PATHS = Object.freeze({
  brain_index: "brain/INDEX.md",
  prd: "brain/requirements/prd.md",
  constraints: "brain/requirements/constraints.md",
  architecture: "brain/architecture/overview.md",
  state: "brain/state/current.yaml",
  decisions_dir: "brain/decisions",
  research_dir: "brain/research",
  tasks_dir: "tasks",
  evidence_dir: "evidence",
  proposals_dir: "proposals",
  conflicts_dir: "brain/conflicts",
  incidents_dir: "brain/incidents",
  handoffs_dir: "handoffs",
});

function normalizeRelPath(raw, fallback) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Resolves configured relative Second Brain paths from a parsed project manifest.
 */
export function resolveProjectPaths(manifest = null) {
  const configured = manifest && manifest.paths && typeof manifest.paths === "object" ? manifest.paths : {};
  return {
    brain_index: normalizeRelPath(configured.brain_index, DEFAULT_PROJECT_PATHS.brain_index),
    prd: normalizeRelPath(configured.prd, DEFAULT_PROJECT_PATHS.prd),
    constraints: normalizeRelPath(configured.constraints, DEFAULT_PROJECT_PATHS.constraints),
    architecture: normalizeRelPath(configured.architecture, DEFAULT_PROJECT_PATHS.architecture),
    state: normalizeRelPath(configured.state, DEFAULT_PROJECT_PATHS.state),
    decisions_dir: normalizeRelPath(configured.decisions_dir, DEFAULT_PROJECT_PATHS.decisions_dir),
    research_dir: normalizeRelPath(configured.research_dir, DEFAULT_PROJECT_PATHS.research_dir),
    tasks_dir: normalizeRelPath(configured.tasks_dir, DEFAULT_PROJECT_PATHS.tasks_dir),
    evidence_dir: normalizeRelPath(configured.evidence_dir, DEFAULT_PROJECT_PATHS.evidence_dir),
    proposals_dir: normalizeRelPath(configured.proposals_dir, DEFAULT_PROJECT_PATHS.proposals_dir),
    conflicts_dir: DEFAULT_PROJECT_PATHS.conflicts_dir,
    incidents_dir: DEFAULT_PROJECT_PATHS.incidents_dir,
    handoffs_dir: DEFAULT_PROJECT_PATHS.handoffs_dir,
  };
}

/**
 * Resolves a project root from an explicit `--project` argument or by walking upward
 * from `cwd` to the nearest non-symlink `brain/manifest.yaml`, stopping at Git root or FS root.
 */
export function resolveProjectDir({ project = null, cwd = process.cwd(), harnessDir = DEFAULT_HARNESS_DIR } = {}) {
  if (typeof project === "string" && project.trim().length > 0) {
    return {
      projectDir: path.resolve(project),
      discoveredFromCwd: false,
    };
  }

  const resolvedHarness = path.resolve(harnessDir);
  let cursor = path.resolve(cwd);
  const visited = new Set();

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    if (!fs.existsSync(cursor)) {
      throw new Error(`Current working directory does not exist: ${cursor}`);
    }
    const dirStat = fs.lstatSync(cursor);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`Refusing symbolic link directory during project discovery: ${cursor}`);
    }

    if (!isSameOrInside(cursor, resolvedHarness)) {
      const brainDir = path.join(cursor, "brain");
      const manifestFile = path.join(brainDir, "manifest.yaml");
      if (fs.existsSync(manifestFile)) {
        if (fs.lstatSync(brainDir).isSymbolicLink() || fs.lstatSync(manifestFile).isSymbolicLink()) {
          throw new Error(`Refusing symbolic link Second Brain manifest during discovery: ${manifestFile}`);
        }
        return {
          projectDir: cursor,
          discoveredFromCwd: true,
        };
      }
    }

    if (fs.existsSync(path.join(cursor, ".git"))) {
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  throw new Error(
    `No GeloForge project found from "${path.resolve(cwd)}" (searched upward to Git root). Run "geloforge adopt" to add GeloForge to this repository, or pass "--project <path>".`
  );
}

/**
 * Loads and schema-validates brain/manifest.yaml and state YAML safely inside projectDir.
 */
export function loadProjectManifestAndState(rawProjectDir, harnessDir = DEFAULT_HARNESS_DIR) {
  const projectDir = path.resolve(rawProjectDir);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }
  const rootStat = fs.lstatSync(projectDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Project root must be a real non-symlink directory: ${projectDir}`);
  }

  const schemasDir = path.join(path.resolve(harnessDir), "schemas");
  const compatConfig = loadCompatibilityConfig();

  const manifestPath = assertSafeWithinRoot(projectDir, "brain/manifest.yaml");
  if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) {
    throw new Error(`Missing or unsafe brain/manifest.yaml in ${projectDir}`);
  }
  const manifest = parseYaml(fs.readFileSync(manifestPath, "utf8"), "brain/manifest.yaml");
  const manifestSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, "project-manifest.schema.json"), "utf8"));
  const mValid = validateAgainstSchema(manifest, manifestSchema);
  if (!mValid.valid) {
    throw new Error(`Invalid brain/manifest.yaml: ${mValid.errors.join("; ")}`);
  }
  const compat = checkManifestCompatibility(manifest, compatConfig);
  if (!compat.compatible) {
    throw new Error(`Incompatible brain/manifest.yaml: ${compat.errors.join("; ")}`);
  }

  const projectPaths = resolveProjectPaths(manifest);
  const statePath = assertSafeWithinRoot(projectDir, projectPaths.state);
  if (!fs.existsSync(statePath) || !fs.lstatSync(statePath).isFile()) {
    throw new Error(`Missing or unsafe ${projectPaths.state} in ${projectDir}`);
  }
  const state = parseYaml(fs.readFileSync(statePath, "utf8"), projectPaths.state);
  const sVer = checkRecordSchemaVersion(state, compatConfig);
  if (!sVer.compatible) {
    throw new Error(`${projectPaths.state}: ${sVer.error}`);
  }
  const stateSchema = JSON.parse(fs.readFileSync(path.join(schemasDir, "project-state.schema.json"), "utf8"));
  const sValid = validateAgainstSchema(state, stateSchema);
  if (!sValid.valid) {
    throw new Error(`Invalid ${projectPaths.state}: ${sValid.errors.join("; ")}`);
  }

  return {
    projectDir,
    schemasDir,
    compatConfig,
    manifest,
    state,
    stateSchema,
    stateFilePath: statePath,
    projectPaths,
  };
}

/**
 * Scans record folders to discover existing IDs and allocate the next sequential ID (PREFIX-NNNN).
 */
export function scanAndAllocateRecordId({ projectDir, searchDirs, prefix, explicitId = null }) {
  const idRegex = new RegExp(`^(${prefix})-(\\d{4})$`, "i");
  const filePrefixRegex = new RegExp(`^(${prefix}-\\d{4})(?=[^0-9]|$)`, "i");
  const existingIds = new Set();
  let maxNum = 0;

  for (const relDir of Array.from(new Set(searchDirs))) {
    const absDir = assertSafeWithinRoot(projectDir, relDir);
    if (!fs.existsSync(absDir)) continue;
    const files = walkNonSymlinkFiles(projectDir, absDir, (p) => /\.(md|ya?ml)$/i.test(p));
    for (const f of files) {
      const base = path.basename(f);
      const fnameMatch = base.match(filePrefixRegex);
      if (fnameMatch) {
        const up = fnameMatch[1].toUpperCase();
        existingIds.add(up);
        const n = Number.parseInt(up.split("-")[1], 10);
        if (n > maxNum) maxNum = n;
      }
      try {
        const raw = fs.readFileSync(f, "utf8");
        const parsedIdMatch = raw.match(new RegExp(`^id:\\s*["']?(${prefix}-\\d{4})["']?\\s*$`, "im"));
        if (parsedIdMatch) {
          const up = parsedIdMatch[1].toUpperCase();
          existingIds.add(up);
          const n = Number.parseInt(up.split("-")[1], 10);
          if (n > maxNum) maxNum = n;
        }
      } catch {
        // Ignore unreadable file during ID scan
      }
    }
  }

  if (explicitId !== null && explicitId !== undefined) {
    const clean = String(explicitId).trim().toUpperCase();
    if (!idRegex.test(clean)) {
      throw new Error(`Invalid record ID "${explicitId}". Expected format ${prefix}-NNNN.`);
    }
    if (existingIds.has(clean)) {
      throw new Error(`Duplicate record ID "${clean}" already exists.`);
    }
    return { id: clean, existingIds };
  }

  return {
    id: `${prefix}-${String(maxNum + 1).padStart(4, "0")}`,
    existingIds,
  };
}

