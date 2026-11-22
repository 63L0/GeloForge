/**
 * Inspects a GeloForge project's validation health, Second Brain operational state, and Git status.
 */

import fs from "node:fs";
import path from "node:path";
import { findBlockedAudit, readAutonomousMode } from "./autonomous-audit.mjs";
import { parseYaml, extractFrontmatter } from "./yaml-subset.mjs";
import { validateProject } from "./project-validator.mjs";
import { getGitStatusScoped } from "./git-utils.mjs";
import { resolveProjectPaths } from "./project-locator.mjs";
import {
  assertSafeWithinRoot,
  hasSecretContent,
  isForbiddenSecretPath,
  walkNonSymlinkFiles,
} from "./path-safety.mjs";
import { listTaskLeases, listTasks, scopesOverlap } from "./task-manager.mjs";

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
  const advisoryWarnings = [...validation.warnings];
  let autonomousMode = "off";
  let blockedAudit = null;
  try {
    autonomousMode = readAutonomousMode(projectDir);
    blockedAudit = findBlockedAudit(projectDir, state?.blocked_tasks ?? []);
  } catch (err) {
    advisoryWarnings.push(`Could not inspect autonomous audit state: ${err.message}`);
  }

  const pendingApprovalsInbox = manifest
    ? scanPendingApprovalsInbox({ projectDir, projectPaths, state, warnings: advisoryWarnings })
    : [];

  let activeLeases = [];
  let expiredLeasesCount = 0;
  let leaseOverlaps = [];
  try {
    const leaseState = listTaskLeases({ projectDir });
    activeLeases = leaseState.activeLeases || [];
    expiredLeasesCount = (leaseState.expiredLeases || []).length;
    leaseOverlaps = detectLeaseOverlaps(activeLeases);
  } catch (err) {
    advisoryWarnings.push(`Could not inspect active task leases: ${err.message}`);
  }

  let tasks = [];
  if (manifest) {
    try {
      tasks = listTasks({ projectDir }).tasks || [];
    } catch (err) {
      advisoryWarnings.push(`Could not inspect project tasks: ${err.message}`);
    }
  }

  const recommendations = buildRecommendations({
    validation,
    manifest,
    state,
    vcs,
    tasks,
    pendingApprovalsInbox,
    activeLeases,
    leaseOverlaps,
    blockedAudit,
  });

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

  if (leaseOverlaps.length > 0) {
    nextSteps.push(`Resolve ${leaseOverlaps.length} overlapping multi-IDE lease(s): geloforge task leases`);
  }
  if (pendingApprovalsInbox.length > 0) {
    nextSteps.push(
      `Review ${pendingApprovalsInbox.length} pending human approval item(s): geloforge recommend`
    );
  }

  return {
    projectDir,
    autonomousMode,
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
          lastCheckpoint: state.last_checkpoint ?? null,
        }
      : null,
    vcs,
    activeLeases,
    expiredLeasesCount,
    leaseOverlaps,
    pendingApprovalsInbox,
    recommendations,
    nextSteps,
    counts: {
      records: validation.recordCount,
      markdownFiles: validation.checkedMarkdownFiles,
      errors: validation.errors.length,
      warnings: advisoryWarnings.length,
      pendingApprovalsInbox: pendingApprovalsInbox.length,
      activeLeases: activeLeases.length,
    },
    errors: validation.errors,
    warnings: advisoryWarnings,
  };
}

/**
 * Returns structured Co-Pilot recommendations and pending human approvals for a project.
 */
export function getProjectRecommendations(projectDir) {
  const status = getProjectStatus(projectDir);
  return {
    projectDir: status.projectDir,
    autonomousMode: status.autonomousMode,
    valid: status.valid,
    project: status.project,
    operationalState: status.operationalState,
    vcs: status.vcs,
    activeLeases: status.activeLeases,
    leaseOverlaps: status.leaseOverlaps,
    pendingApprovalsInbox: status.pendingApprovalsInbox,
    recommendations: status.recommendations,
    nextSteps: status.nextSteps,
    warnings: status.warnings,
    errors: status.errors,
  };
}

const MAX_INBOX_FILE_BYTES = 512 * 1024;
const PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };

function readSafeProjectRecordText(projectDir, relPath, warnings) {
  const norm = relPath.replace(/\\/g, "/");
  if (isForbiddenSecretPath(norm)) {
    warnings.push(`Skipped forbidden secret path in status scan: ${norm}`);
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
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INBOX_FILE_BYTES) {
    return null;
  }
  const text = fs.readFileSync(resolved, "utf8");
  if (hasSecretContent(text)) {
    warnings.push(`Blocked record containing credential-like content: ${norm}`);
    return null;
  }
  return text;
}

function scanPendingApprovalsInbox({ projectDir, projectPaths, state, warnings }) {
  const items = [];
  const seenKeys = new Set();

  const proposalsRelDir = String(projectPaths.proposals_dir || "proposals").replace(/\\/g, "/");
  const decisionsRelDir = String(projectPaths.decisions_dir || "brain/decisions").replace(/\\/g, "/");

  // 1. Skill proposals under <proposals_dir>/skills/.proposals/*.yaml
  const skillPropsDir = path.join(projectDir, proposalsRelDir, "skills", ".proposals");
  for (const absFile of walkNonSymlinkFiles(projectDir, skillPropsDir, (p) => /\.ya?ml$/i.test(p), warnings)) {
    const rel = path.relative(projectDir, absFile).replace(/\\/g, "/");
    const raw = readSafeProjectRecordText(projectDir, rel, warnings);
    if (!raw) continue;
    try {
      const data = parseYaml(raw, rel);
      const statusVal = String(data?.status || "draft").toLowerCase();
      if (!data || data.is_example === true) continue;
      if (!["draft", "pending", "proposed", "pending_approval"].includes(statusVal)) continue;
      const skillName = String(data.skill_name || path.basename(rel, path.extname(rel)));
      const kind = data.kind === "skill_update" ? "skill_update" : "skill_draft";
      const key = `${kind}:${skillName}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      items.push({
        kind,
        id: skillName,
        title: `${kind === "skill_update" ? "Skill update" : "Skill draft"}: ${skillName}`,
        status: statusVal,
        path: rel,
        requestedBy: data.created_by || null,
        createdAt: data.created_at || null,
        summary: data.reason || null,
        approveHint: `Review ${proposalsRelDir}/skills/${skillName}/SKILL.md, sign APPR via "geloforge skills sign", then run "geloforge skills promote --skill ${skillName} --approval APPR-NNNN".`,
      });
    } catch (err) {
      warnings.push(`Could not parse skill proposal ${rel}: ${err.message}`);
    }
  }

  // 2. APPR-*.yaml records under <proposals_dir>
  const apprSeenIds = new Set();
  const proposalsAbs = path.join(projectDir, proposalsRelDir);
  for (const absFile of walkNonSymlinkFiles(
    projectDir,
    proposalsAbs,
    (p) => /^APPR-\d{4}.*\.ya?ml$/i.test(path.basename(p)),
    warnings
  )) {
    const rel = path.relative(projectDir, absFile).replace(/\\/g, "/");
    const raw = readSafeProjectRecordText(projectDir, rel, warnings);
    if (!raw) continue;
    try {
      const data = parseYaml(raw, rel);
      if (!data || data.is_example === true || typeof data.id !== "string") continue;
      const statusVal = String(data.status || "").toLowerCase();
      const listedPending = Array.isArray(state?.pending_approvals) && state.pending_approvals.includes(data.id);
      if (!listedPending && !["pending", "proposed", "requested", "draft"].includes(statusVal)) continue;
      apprSeenIds.add(data.id);
      const key = `approval_record:${data.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      items.push({
        kind: "approval_record",
        id: data.id,
        title: data.title || data.summary || data.boundary_category || data.action_category || data.id,
        status: statusVal || "pending",
        path: rel,
        requestedBy: data.requested_by || null,
        createdAt: data.requested_at || data.created_at || null,
        summary: data.rationale || (data.boundary_category ? `category=${data.boundary_category}` : null),
        approveHint: `Inspect ${rel}; owner must review and mark approved (or promote skill if skill-related).`,
      });
    } catch (err) {
      warnings.push(`Could not parse approval record ${rel}: ${err.message}`);
    }
  }

  // 3. Pending ADR-*.md proposals under <decisions_dir> and <proposals_dir>
  for (const dirRel of Array.from(new Set([decisionsRelDir, proposalsRelDir]))) {
    const absDir = path.join(projectDir, dirRel);
    for (const absFile of walkNonSymlinkFiles(
      projectDir,
      absDir,
      (p) => /^ADR-\d{4}.*\.md$/i.test(path.basename(p)),
      warnings
    )) {
      const rel = path.relative(projectDir, absFile).replace(/\\/g, "/");
      const raw = readSafeProjectRecordText(projectDir, rel, warnings);
      if (!raw) continue;
      try {
        const fm = extractFrontmatter(raw, rel);
        if (!fm || fm.is_example === true) continue;
        const statusVal = String(fm.status || "").toLowerCase();
        if (!["proposed", "draft", "pending", "under_review"].includes(statusVal)) continue;
        const adrId = String(fm.id || path.basename(rel, ".md"));
        const key = `adr_proposal:${adrId}:${rel}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        items.push({
          kind: "adr_proposal",
          id: adrId,
          title: fm.title || adrId,
          status: statusVal,
          path: rel,
          requestedBy: fm.owner || fm.proposed_by || fm.author || null,
          createdAt: fm.updated_at || fm.created_at || fm.date || null,
          summary: Array.isArray(fm.tags) && fm.tags.length > 0 ? `tags=${fm.tags.join(",")}` : fm.decision_summary || null,
          approveHint: `Review architectural trade-offs in ${rel} and record human decision before updating ADR status.`,
        });
      } catch (err) {
        warnings.push(`Could not parse ADR frontmatter ${rel}: ${err.message}`);
      }
    }
  }

  // 4. State pending_approvals entries not already represented above
  for (const apprId of state?.pending_approvals || []) {
    if (apprSeenIds.has(apprId)) continue;
    const key = `state_approval:${apprId}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    items.push({
      kind: "state_approval",
      id: apprId,
      title: `Pending state approval: ${apprId}`,
      status: "pending",
      path: null,
      requestedBy: null,
      createdAt: null,
      summary: "Listed in state.pending_approvals",
      approveHint: `Review ${apprId} and resolve state.pending_approvals.`,
    });
  }

  items.sort((a, b) => {
    const kCmp = String(a.kind).localeCompare(String(b.kind));
    if (kCmp !== 0) return kCmp;
    const idCmp = String(a.id).localeCompare(String(b.id));
    if (idCmp !== 0) return idCmp;
    return String(a.path || "").localeCompare(String(b.path || ""));
  });

  return items;
}

function detectLeaseOverlaps(activeLeases) {
  const overlaps = [];
  for (let i = 0; i < activeLeases.length; i += 1) {
    for (let j = i + 1; j < activeLeases.length; j += 1) {
      const a = activeLeases[i];
      const b = activeLeases[j];
      const sameTask = a.task_id === b.task_id;
      const scopeHit = (a.claimed_scope || []).some((s1) =>
        (b.claimed_scope || []).some((s2) => scopesOverlap(s1, s2))
      );
      if (sameTask || scopeHit) {
        overlaps.push({
          leaseA: { task_id: a.task_id, role: a.role, tool: a.tool, session_id: a.session_id },
          leaseB: { task_id: b.task_id, role: b.role, tool: b.tool, session_id: b.session_id },
          sameTask,
          scopeOverlap: scopeHit,
        });
      }
    }
  }
  return overlaps;
}

function buildRecommendations({
  validation,
  state,
  vcs,
  tasks,
  pendingApprovalsInbox,
  activeLeases,
  leaseOverlaps,
  blockedAudit,
}) {
  const recs = [];

  if (!validation.valid) {
    recs.push({
      rank: 100,
      priority: "critical",
      category: "validation",
      title: `Fix ${validation.errors.length} Second Brain validation error(s)`,
      reason: "Schema, ID reference, or safety validation failed; AI agents should not trust invalid state.",
      options: ["Inspect errors with validate --json and repair referenced records"],
      command: "geloforge validate",
      requiresHumanApproval: false,
    });
  }

  if (leaseOverlaps.length > 0) {
    recs.push({
      rank: 95,
      priority: "high",
      category: "coordination",
      title: `Resolve ${leaseOverlaps.length} overlapping multi-IDE task/file-scope lease(s)`,
      reason: "Two concurrent IDE sessions claimed the same task or overlapping file paths.",
      options: [
        "Release stale/duplicate lease via geloforge task release",
        "Narrow file scopes into disjoint modules or separate Git worktrees",
      ],
      command: "geloforge task leases",
      requiresHumanApproval: true,
    });
  }

  if (state && (state.open_conflicts || []).length > 0) {
    recs.push({
      rank: 90,
      priority: "high",
      category: "conflict",
      title: `Resolve ${state.open_conflicts.length} open conflict(s): ${state.open_conflicts.join(", ")}`,
      reason: "Unresolved CONF-* contradictions block authoritative decisions and require human arbitration.",
      options: [
        "Accept newer verified evidence and supersede older decision via ADR",
        "Reject conflicting proposal and document rationale in CONF record",
      ],
      command: `geloforge recommend`,
      requiresHumanApproval: true,
    });
  }

  if (pendingApprovalsInbox.length > 0) {
    const first = pendingApprovalsInbox[0];
    recs.push({
      rank: 85,
      priority: "high",
      category: "approval_inbox",
      title: `Review ${pendingApprovalsInbox.length} pending human approval item(s)`,
      reason: `Human authorization pending for: ${pendingApprovalsInbox.map((i) => `${i.kind}:${i.id}`).slice(0, 4).join(", ")}.`,
      options: [
        "Inspect diff/evidence and sign/approve with human authorization",
        "Reject or request narrower scope before promotion",
      ],
      command: first.approveHint,
      requiresHumanApproval: true,
    });
  }

  if (state && (state.blocked_tasks || []).length > 0) {
    recs.push({
      rank: 80,
      priority: "high",
      category: "blocked_task",
      title: `Unblock ${state.blocked_tasks.length} blocked task(s): ${state.blocked_tasks.join(", ")}`,
      reason: "Work cannot advance on blocked tasks without human decision or dependency completion.",
      options: [
        "Resolve blocker and move task back to ready/active via geloforge task update",
        "Pause/cancel obsolete task via geloforge task update --status cancelled",
      ],
      command: `geloforge task show --task ${state.blocked_tasks[0]}`,
      requiresHumanApproval: true,
    });
  }

  if (blockedAudit) {
    recs.push({
      rank: 81,
      priority: "high",
      category: "autonomous_audit",
      title: `Review the blocked staging audit in ${blockedAudit.id}`,
      reason: blockedAudit.resume_instructions,
      options: ["Inspect the checkpoint and verify the missing or mismatched evidence"],
      command: `geloforge checkpoint show --id ${blockedAudit.id}`,
      requiresHumanApproval: false,
    });
  }

  if (state) {
    const activeIds = state.active_tasks || [];
    if (activeIds.length === 0) {
      const candidate = tasks
        .filter((t) => !t.is_example && (t.status === "ready" || t.status === "inbox" || t.status === "in_review"))
        .sort((a, b) => (PRIORITY_ORDER[b.priority] || 0) - (PRIORITY_ORDER[a.priority] || 0))[0];

      if (candidate) {
        recs.push({
          rank: 72,
          priority: "medium",
          category: "task_activation",
          title: `Activate next ${candidate.priority}-priority task: ${candidate.id} (${candidate.title})`,
          reason: "No task is currently active in project state, while queued non-example task contracts exist.",
          options: [
            `Activate ${candidate.id} and compile focused context`,
            "Create a new scoped task if priorities changed",
          ],
          command: `geloforge task update --task ${candidate.id} --status active --activate`,
          requiresHumanApproval: false,
        });
      } else {
        recs.push({
          rank: 70,
          priority: "medium",
          category: "task_creation",
          title: "Create and activate a scoped task contract",
          reason: "No active or queued tasks exist; defining a task enables tight token budgets and evidence tracking.",
          options: ["Define task objective + acceptance criteria before editing"],
          command: 'geloforge task new --title "<goal>" --activate',
          requiresHumanApproval: false,
        });
      }
    } else {
      const primaryTaskId = activeIds[0];
      const primaryTask = tasks.find((t) => t.id === primaryTaskId);

      if (vcs.available && vcs.dirtyCount > 0 && !state.last_checkpoint) {
        recs.push({
          rank: 76,
          priority: "medium",
          category: "checkpoint",
          title: `Create a recovery checkpoint before context grows (${vcs.dirtyCount} uncommitted change(s))`,
          reason: "Mid-session checkpoints preserve verified state and resume instructions so fresh sessions avoid context rot.",
          options: ["Save CHKPT-NNNN now and continue or start a fresh context window"],
          command: `geloforge checkpoint create --summary "Progress on ${primaryTaskId}"`,
          requiresHumanApproval: false,
        });
      }

      if (!state.last_verified_evidence || (primaryTask && primaryTask.evidenceCount === 0)) {
        recs.push({
          rank: 74,
          priority: "medium",
          category: "verification",
          title: `Capture command-backed verification evidence for ${primaryTaskId}`,
          reason: "Verified EVID-* records separate real passing checks from unverified agent claims.",
          options: ["Run project test suite via evidence capture (shell: false)"],
          command: `geloforge evidence capture --task ${primaryTaskId} -- <test-command>`,
          requiresHumanApproval: false,
        });
      } else {
        recs.push({
          rank: 68,
          priority: "medium",
          category: "task_closure",
          title: `Review ${primaryTaskId} completion readiness or extract reusable skill`,
          reason: `${primaryTaskId} has ${primaryTask?.evidenceCount || 1} linked evidence record(s).`,
          options: [
            `Mark task completed: geloforge task done --task ${primaryTaskId}`,
            `Draft quarantined skill from verified work: geloforge skills draft --task ${primaryTaskId}`,
          ],
          command: `geloforge task done --task ${primaryTaskId}`,
          requiresHumanApproval: true,
        });
      }

      recs.push({
        rank: 60,
        priority: "low",
        category: "context_efficiency",
        title: `Compile diff-focused quick context for ${primaryTaskId}`,
        reason: "Keeps token consumption bounded (~4000 tokens) and highlights peer IDE leases.",
        options: ["Compile quick diff packet (completed tasks pruned automatically)"],
        command: `geloforge context --task ${primaryTaskId} --from-diff --map --profile quick`,
        requiresHumanApproval: false,
      });
    }
  }

  if (activeLeases.length === 0 && state && (state.active_tasks || []).length > 0 && vcs.available && vcs.dirtyCount > 0) {
    recs.push({
      rank: 50,
      priority: "low",
      category: "multi_ide_coordination",
      title: `Claim a cooperative task lease for ${state.active_tasks[0]} when using multiple IDEs`,
      reason: "Active workspace edits exist with no active lease; leases warn peer IDE agents before scope collisions.",
      options: ["Register your IDE tool, role, and owned paths with TTL"],
      command: `geloforge task claim --task ${state.active_tasks[0]} --tool <ide> --role developer --scopes "<paths>"`,
      requiresHumanApproval: false,
    });
  }

  recs.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return String(a.title).localeCompare(String(b.title));
  });

  return recs;
}
