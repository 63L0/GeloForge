/**
 * Inspects a GeloForge project's validation health, Second Brain operational state, and Git status.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseYaml } from "./yaml-subset.mjs";
import { validateProject } from "./project-validator.mjs";

function inspectGitState(projectDir) {
  try {
    const inside = execFileSync("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (inside !== "true") {
      return { available: false, branch: null, head: null, dirtyCount: 0, clean: null };
    }

    const branch = execFileSync("git", ["-C", projectDir, "branch", "--show-current"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;

    let head = null;
    try {
      head = execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      head = "unborn";
    }

    const porcelain = execFileSync("git", ["-C", projectDir, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dirtyLines = porcelain
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean);

    return {
      available: true,
      branch,
      head,
      dirtyCount: dirtyLines.length,
      clean: dirtyLines.length === 0,
    };
  } catch {
    return { available: false, branch: null, head: null, dirtyCount: 0, clean: null };
  }
}

export function getProjectStatus(rawProjectDir, options = {}) {
  if (typeof rawProjectDir !== "string" || rawProjectDir.trim().length === 0) {
    throw new Error("Missing required project path (--project <path>).");
  }
  const projectDir = path.resolve(rawProjectDir);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  const validation = validateProject(projectDir, options);

  let manifest = null;
  const manifestPath = path.join(projectDir, "brain", "manifest.yaml");
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = parseYaml(fs.readFileSync(manifestPath, "utf8"), "brain/manifest.yaml");
    } catch {
      manifest = null;
    }
  }

  let state = null;
  const statePath = path.join(projectDir, "brain", "state", "current.yaml");
  if (fs.existsSync(statePath)) {
    try {
      state = parseYaml(fs.readFileSync(statePath, "utf8"), "brain/state/current.yaml");
    } catch {
      state = null;
    }
  }

  const vcs = inspectGitState(projectDir);

  return {
    projectDir,
    valid: validation.valid,
    compatibilityStatus: validation.compatibilityStatus,
    project: manifest
      ? {
          id: manifest.project_id || null,
          name: manifest.name || null,
          slug: manifest.slug || null,
          status: manifest.status || null,
          profile: manifest.profile ?? null,
          profileVersion: manifest.profile_version ?? null,
          schemaVersion: manifest.schema_version || null,
        }
      : null,
    operationalState: state
      ? {
          currentPhase: state.current_phase || null,
          stateRevision: state.state_revision ?? null,
          status: state.status || null,
          activeTasks: state.active_tasks || [],
          blockedTasks: state.blocked_tasks || [],
          pendingApprovals: state.pending_approvals || [],
          openConflicts: state.open_conflicts || [],
          lastVerifiedEvidence: state.last_verified_evidence ?? null,
          lastCompletedTask: state.last_completed_task ?? null,
        }
      : null,
    vcs,
    counts: {
      records: validation.recordCount,
      markdownFiles: validation.checkedMarkdownFiles,
      errors: validation.errors.length,
      warnings: validation.warnings.length,
    },
    errors: validation.errors,
    warnings: validation.warnings,
  };
}
