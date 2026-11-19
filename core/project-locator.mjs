/**
 * Project root discovery (CWD upward search) and canonical manifest path resolution.
 * Zero external dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSameOrInside } from "./path-safety.mjs";

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
