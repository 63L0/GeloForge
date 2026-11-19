/**
 * Inspects a GeloForge project's validation health, Second Brain operational state, and Git status.
 */

import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "./yaml-subset.mjs";
import { validateProject } from "./project-validator.mjs";
import { getGitStatusScoped } from "./git-utils.mjs";
import { resolveProjectPaths } from "./project-locator.mjs";

function inspectGitState(projectDir) {
  const gs = getGitStatusScoped(projectDir);
  if (!gs.available) {
    return { available: false, branch: null, head: null, dirtyCount: 0, clean: null };
  }
  return {
    available: true,
    branch: gs.branch,
    head: gs.unborn ? "unborn" : gs.head,
    dirtyCount: gs.dirtyCount,
    clean: !gs.dirty,
  };
}

export function getProjectStatus(rawProjectDir, options = {}) {
  if (typeof rawProjectDir !== "string" || rawProjectDir.trim().length === 0) {
    throw new Error("Missing required project path (--project <path>).");
  }
  const projectDir = path.resolve(rawProjectDir);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }
  const rootStat = fs.lstatSync(projectDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Project root must be a real non-symlink directory: ${projectDir}`);
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

  const projectPaths = resolveProjectPaths(manifest);
  let state = null;
  const statePath = path.join(projectDir, projectPaths.state);
  if (fs.existsSync(statePath)) {
    try {
      state = parseYaml(fs.readFileSync(statePath, "utf8"), projectPaths.state);
    } catch {
      state = null;
    }
  }

  const vcs = inspectGitState(projectDir);

  const nextSteps = [];
  if (!validation.valid) {
    nextSteps.push('Run "geloforge validate" and fix Second Brain schema or reference errors.');
  } else if (state) {
    if ((state.open_conflicts || []).length > 0) {
      nextSteps.push(
        `Resolve ${state.open_conflicts.length} open conflict(s) (${state.open_conflicts.join(", ")}) before approving decisions.`
      );
    }
    if ((state.blocked_tasks || []).length > 0) {
      nextSteps.push(`Unblock task(s): ${(state.blocked_tasks || []).join(", ")}.`);
    }
    if ((state.active_tasks || []).length === 0) {
      nextSteps.push('Create and activate a task: geloforge task new --title "<goal>" --activate');
    } else if (!state.last_verified_evidence) {
      nextSteps.push(
        `Capture command-backed evidence: geloforge evidence capture --task ${state.active_tasks[0]} -- <test-command>`
      );
    } else {
      nextSteps.push(
        `Compile task context: geloforge context --task ${state.active_tasks[0]} --map --profile quick`
      );
    }
  }

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
    nextSteps,
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
