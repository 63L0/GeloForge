/**
 * Shareable GitHub-Flavored Markdown and JSON verification report generator (`geloforge report`).
 * Summarizes tasks, audited command evidence, session checkpoints, and doctor health checks
 * cleanly without third-party dependencies or network calls.
 */

import { fileFreshness } from "./file-freshness.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCheckpoints } from "./checkpoint.mjs";
import { runProjectDoctor } from "./doctor.mjs";
import {
  assertSafeWithinRoot,
  atomicWriteFile,
  isForbiddenSecretPath,
  redactSecretContent,
  validateOutputFilePath,
  walkNonSymlinkFiles,
} from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { getProjectStatus } from "./project-status.mjs";
import { getTask, listTasks } from "./task-manager.mjs";
import { parseYaml } from "./yaml-subset.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_HARNESS_DIR = path.resolve(__dirname, "..");

function escapeCell(value, fallback = "—") {
  if (value === undefined || value === null) return fallback;
  const raw = redactSecretContent(String(value)).replace(/\r?\n|\t/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return fallback;
  return raw.replace(/\|/g, "\\|");
}

export function scanEvidenceManifests(projectDir, evidenceDirRel) {
  const absDir = assertSafeWithinRoot(projectDir, evidenceDirRel);
  const st = fs.lstatSync(absDir, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    return [];
  }

  const files = walkNonSymlinkFiles(projectDir, absDir, (p) => /^EVID-\d{4}.*\.ya?ml$/i.test(path.basename(p)));
  const items = [];
  for (const filePath of files) {
    const relPath = path.relative(projectDir, filePath).replace(/\\/g, "/");
    if (isForbiddenSecretPath(relPath)) continue;
    let parsed;
    try {
      parsed = parseYaml(fs.readFileSync(filePath, "utf8"), relPath);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || parsed.is_example === true || !parsed.id) {
      continue;
    }
    const checks = (Array.isArray(parsed.checks) ? parsed.checks : [])
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        name: typeof c.name === "string" ? redactSecretContent(c.name) : null,
        command: typeof c.command === "string" ? redactSecretContent(c.command.trim()) : "",
        result: c.result || null,
        exitCode: Number.isInteger(c.exit_code) ? c.exit_code : null,
      }));
    items.push({
      id: String(parsed.id),
      status: String(parsed.status || "draft"),
      taskId: typeof parsed.task_id === "string" ? parsed.task_id : null,
      relatedTasks: Array.isArray(parsed.related_tasks) ? parsed.related_tasks.map((t) => String(t)) : [],
      title: typeof parsed.title === "string" ? redactSecretContent(parsed.title) : String(parsed.id),
      createdAt: parsed.created_at || null,
      files: (Array.isArray(parsed.artifacts) ? parsed.artifacts : [])
        .filter(a => a?.description === "Verified command input" && typeof a.path === "string")
        .map(a => ({ path: a.path, state: fileFreshness(projectDir, a) })),
      checks,
      relPath,
    });
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  return items;
}

/**
 * Builds a deterministic Markdown + JSON verification summary across tasks, evidence, checkpoints, and doctor checks.
 */
export async function generateProjectReport(options = {}) {
  const harnessDir = path.resolve(options.harnessDir || DEFAULT_HARNESS_DIR);
  if (typeof options.projectDir !== "string" || options.projectDir.trim().length === 0) {
    throw new Error("Missing required project directory (--project <dir>).");
  }

  let outAbs = null;
  if (options.out !== undefined && options.out !== null && String(options.out).trim() !== "") {
    outAbs = validateOutputFilePath(String(options.out), {
      harnessDir,
      workspaceRoot: options.workspaceRoot ?? null,
    });
  }

  const { projectDir, manifest, state, projectPaths } = loadProjectManifestAndState(options.projectDir, harnessDir);
  const status = getProjectStatus(projectDir, { harnessDir });
  const listedTasks = listTasks({ projectDir, harnessDir }).tasks || [];
  const hydratedTasks = listedTasks.map((item) => {
    try {
      const full = getTask({ projectDir, taskId: item.id, harnessDir });
      return {
        id: item.id,
        title: full.record.title || item.title,
        status: full.record.status || item.status,
        priority: full.record.priority || item.priority,
        verificationStatus: full.record.verification_status || "unverified",
        evidenceRefs: Array.isArray(full.record.evidence_refs) ? [...full.record.evidence_refs] : [],
        activeInState: item.activeInState,
        relPath: item.relPath,
      };
    } catch {
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        verificationStatus: "unverified",
        evidenceRefs: [],
        activeInState: item.activeInState,
        relPath: item.relPath,
      };
    }
  });

  let taskFilter = null;
  let tasks = hydratedTasks;
  if (options.taskId !== undefined && options.taskId !== null && String(options.taskId).trim() !== "") {
    taskFilter = String(options.taskId).trim().toUpperCase();
    const matched = hydratedTasks.filter((t) => t.id === taskFilter);
    if (matched.length === 0) {
      throw new Error(`Task "${taskFilter}" was not found in project ${projectDir}.`);
    }
    tasks = matched;
  }

  const allEvidence = scanEvidenceManifests(projectDir, projectPaths.evidence_dir);
  const taskEvidenceRefs = new Set(tasks.flatMap((t) => t.evidenceRefs || []));
  const evidence = taskFilter
    ? allEvidence.filter(
        (ev) => ev.taskId === taskFilter || ev.relatedTasks.includes(taskFilter) || taskEvidenceRefs.has(ev.id)
      )
    : allEvidence;

  const checkpointList = listCheckpoints({ projectDir, harnessDir });
  const latestCheckpoint = checkpointList.checkpoints?.[0] || null;
  const doctor = await runProjectDoctor({
    projectDir,
    harnessDir,
    globalSkillsDir: options.globalSkillsDir,
    checkMcp: Boolean(options.checkMcp),
    timeoutMs: options.timeoutMs,
  });

  const generatedAt = options.generatedAt || new Date().toISOString();
  const projectId = manifest?.project_id || status.project?.id || null;
  const projectName = manifest?.name || status.project?.name || path.basename(projectDir);
  const gitSummary = status.vcs?.available
    ? `${status.vcs.branch || "HEAD"} @ ${String(status.vcs.head || "unborn").slice(0, 12)}${
        status.vcs.clean ? " (clean)" : ` (${status.vcs.dirtyCount} dirty)`
      }`
    : "no-git";
  const activeTaskIds = Array.isArray(state?.active_tasks) ? state.active_tasks : [];

  const summary = {
    valid: status.valid,
    healthy: doctor.healthy,
    git: gitSummary,
    doctorCounts: doctor.counts,
    activeTasks: activeTaskIds,
    taskCount: tasks.length,
    verifiedEvidenceCount: evidence.filter((e) => e.status === "verified").length,
    draftEvidenceCount: evidence.filter((e) => e.status !== "verified").length,
    latestEvidenceId: state?.last_verified_evidence || evidence.find((e) => e.status === "verified")?.id || null,
    latestCheckpointId: state?.last_checkpoint || latestCheckpoint?.id || null,
  };

  const lines = [
    `# GeloForge Verification Report — ${escapeCell(projectName)} (${escapeCell(projectId, "project")})`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Project Status | ${status.valid ? "PASS" : "FAIL"} (compat=${escapeCell(status.compatibilityStatus, "unknown")}) |`,
    `| Branch @ Commit | \`${escapeCell(gitSummary)}\` |`,
    `| Doctor Health | ${doctor.healthy ? "HEALTHY" : "ISSUES FOUND"} (pass=${doctor.counts.pass}, warn=${doctor.counts.warn}, fail=${doctor.counts.fail}) |`,
    `| Active Tasks | ${activeTaskIds.length > 0 ? activeTaskIds.join(", ") : "(none)"} |`,
    `| Latest Evidence | ${summary.latestEvidenceId || "(none)"} |`,
    `| Latest Checkpoint | ${summary.latestCheckpointId || "(none)"} |`,
    "",
    "## Task Status",
    "",
  ];

  if (tasks.length === 0) {
    lines.push("_No non-example task contracts recorded yet._", "");
  } else {
    lines.push("| Task ID | Title | Status | Verification | Evidence |", "| --- | --- | --- | --- | --- |");
    for (const t of tasks) {
      const evCell = t.evidenceRefs.length > 0 ? t.evidenceRefs.join(", ") : "—";
      lines.push(
        `| ${t.id} | ${escapeCell(t.title)} | ${escapeCell(t.status)} | ${escapeCell(t.verificationStatus)} | ${escapeCell(evCell)} |`
      );
    }
    lines.push("");
  }

  lines.push("## Verified & Draft Evidence Receipts", "");
  if (evidence.length === 0) {
    lines.push("_No evidence manifests recorded yet._", "");
  } else {
    lines.push("| Evidence ID | Status | Task | Command(s) | Exit Code(s) | Result(s) | Checked files today |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const ev of evidence) {
      const cmdCell = ev.checks.map((c) => (c.command ? `\`${c.command}\`` : "(none)")).join("; ") || "—";
      const codeCell = ev.checks.map((c) => c.exitCode ?? "—").join(", ") || "—";
      const resultCell = ev.checks.map((c) => escapeCell(c.result)).join(", ") || "—";
      lines.push(
        `| ${ev.id} | ${escapeCell(ev.status)} | ${escapeCell(ev.taskId)} | ${escapeCell(cmdCell)} | ${escapeCell(codeCell)} | ${resultCell} | ${ev.files.map(f => escapeCell(f.path + " " + f.state)).join(", ") || "unknown"} |`
      );
    }
    lines.push("");
  }

  lines.push("## Session Checkpoint & Resume State", "");
  if (!latestCheckpoint) {
    lines.push("- **Latest Checkpoint:** `(none)` — run `geloforge compact` to capture a checkpoint and resume packet.", "");
  } else {
    lines.push(
      `- **Checkpoint:** \`${latestCheckpoint.id}\` (\`${latestCheckpoint.status}\`, branch \`${escapeCell(latestCheckpoint.git_branch)}\`, state rev \`${latestCheckpoint.state_revision}\`)`,
      `- **Resume Instructions:** ${redactSecretContent(latestCheckpoint.resume_instructions || "(none)")}`,
      ""
    );
  }

  lines.push(
    "## Doctor Health Checks",
    "",
    "| Check | Status | Summary |",
    "| --- | --- | --- |",
    ...doctor.checks.map((chk) => `| \`${chk.id}\` | ${chk.status.toUpperCase()} | ${escapeCell(chk.summary)} |`),
    ""
  );

  const markdown = redactSecretContent(lines.join("\n"));
  if (outAbs && !options.dryRun) {
    atomicWriteFile(outAbs, markdown, { allowOverwrite: true });
  }

  return {
    projectDir,
    projectId,
    projectName,
    generatedAt,
    taskFilter,
    valid: status.valid,
    healthy: doctor.healthy,
    summary,
    tasks,
    evidence,
    latestCheckpoint,
    doctor: {
      healthy: doctor.healthy,
      counts: doctor.counts,
      checks: doctor.checks,
    },
    outPath: outAbs || null,
    markdown,
  };
}
