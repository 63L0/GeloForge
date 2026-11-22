/**
 * Bounded implement -> verify -> review -> fix coding loop orchestrator.
 * Deterministic verification (captureEvidence) gates completion and cannot be overridden by LLM review.
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveAuditProvider, runProviderProcess, startAuditProvider } from "./audit-provider.mjs";
import { createCheckpoint } from "./checkpoint.mjs";
import { compileContext } from "./context-compiler.mjs";
import { captureEvidence } from "./evidence-capture.mjs";
import { getGitRepoInfo } from "./git-utils.mjs";
import { hasSecretContent, isForbiddenSecretPath, redactSecretContent } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { withProjectLock } from "./project-lock.mjs";
import { readRuntimeJson, writeRuntimeJson } from "./runtime-files.mjs";
import { completeTask, getTask, updateTask } from "./task-manager.mjs";

export const CODING_LOOP_VERSION = 1;
const CLOSED_TASK_STATUSES = new Set(["completed", "cancelled", "superseded"]);
const MAX_DIFF_CHARS = 32 * 1024;
const MAX_FEEDBACK_CHARS = 4096;

export function codingLoopProgressPath(taskId) {
  return `local-runtime/checkpoints/${taskId}-coding-loop.json`;
}

function boundedInteger(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readLoopConfig(projectDir, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.endsWith(".json") ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    isForbiddenSecretPath(relativePath) ||
    hasSecretContent(relativePath)
  ) {
    throw new Error("Supply a project-relative JSON config path with --config.");
  }
  const raw = readRuntimeJson(projectDir, relativePath);
  if (!raw || raw.version !== CODING_LOOP_VERSION) {
    throw new Error("Coding loop config requires version: 1.");
  }
  if (
    !Array.isArray(raw.verifyCommand) ||
    raw.verifyCommand.length === 0 ||
    raw.verifyCommand.some((part) => typeof part !== "string" || !part.trim() || hasSecretContent(part))
  ) {
    throw new Error("Coding loop config requires a non-empty verifyCommand array of safe command strings.");
  }
  const implementer = resolveAuditProvider(raw.implementer, projectDir);
  const reviewer = raw.reviewer != null ? resolveAuditProvider(raw.reviewer, projectDir) : null;
  return {
    version: CODING_LOOP_VERSION,
    maxFixRounds: boundedInteger("maxFixRounds", raw.maxFixRounds ?? 2, 0, 5),
    timeoutMs: boundedInteger("timeoutMs", raw.timeoutMs ?? 60_000, 100, 300_000),
    verifyCommand: [...raw.verifyCommand],
    implementer,
    reviewer,
  };
}

function resolveOpenTask(projectDir, harnessDir, explicitTaskId) {
  let taskId = explicitTaskId;
  if (!taskId) {
    const { state } = loadProjectManifestAndState(projectDir, harnessDir);
    const active = state.active_tasks ?? [];
    if (active.length !== 1) {
      throw new Error("Pass --task TASK-NNNN when there is no single active task.");
    }
    [taskId] = active;
  }
  const task = getTask({ projectDir, harnessDir, taskId });
  if (CLOSED_TASK_STATUSES.has(task.record.status)) {
    throw new Error(`${task.id} is ${task.record.status}. Reopen or create a new task before running the loop.`);
  }
  return task;
}

function collectBoundedDiff(projectDir) {
  const info = getGitRepoInfo(projectDir);
  if (!info.available) return "";
  let raw = "";
  try {
    const args = info.unborn ? ["diff", "--", "."] : ["diff", "HEAD", "--", "."];
    raw = execFileSync("git", ["-C", projectDir, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
  if (!raw) return "";

  const kept = [];
  let allowSection = true;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
    if (match) {
      allowSection = !isForbiddenSecretPath(match[1]) && !isForbiddenSecretPath(match[2]);
    }
    if (allowSection) kept.push(line);
  }
  const safe = redactSecretContent(kept.join("\n").trim());
  return safe.length > MAX_DIFF_CHARS ? `${safe.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated]` : safe;
}

function buildImplementPrompt({ stage, round, task, contextMarkdown, feedback }) {
  const sections = [
    `Stage: ${stage} (round ${round})`,
    `Task ${task.id}: ${task.record.title}`,
    `Objective: ${task.record.objective}`,
    `Acceptance criteria:\n${(task.record.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n")}`,
    `Respond with concise JSON if convenient: { "summary": "...", "notes": [] }`,
  ];
  if (feedback) {
    sections.push(`Prior failure/review feedback to resolve:\n${redactSecretContent(feedback).slice(0, MAX_FEEDBACK_CHARS)}`);
  }
  sections.push(`Project context:\n${redactSecretContent(contextMarkdown).slice(0, 48 * 1024)}`);
  return sections.join("\n\n");
}

function buildReviewPrompt({ round, task, evidence, diffText }) {
  const checkSummary = evidence.record?.checks?.[0]?.summary ?? "";
  return [
    "Perform an independent read-only code review against the task contract and acceptance criteria.",
    "Do not modify files, run external network calls, or override deterministic test results.",
    "Return ONLY valid JSON with format:",
    '{ "verdict": "approve" | "request_changes", "summary": "...", "findings": [{ "severity": "blocking" | "minor", "file": "...", "message": "..." }] }',
    JSON.stringify({
      taskId: task.id,
      round,
      title: task.record.title,
      objective: task.record.objective,
      scopeIn: task.record.scope_in ?? [],
      scopeOut: task.record.scope_out ?? [],
      acceptanceCriteria: task.record.acceptance_criteria ?? [],
      verifiedEvidence: {
        id: evidence.id,
        exitCode: evidence.exitCode,
        summary: redactSecretContent(checkSummary).slice(0, 600),
      },
    }),
    `Working tree diff:\n${diffText || "(no git diff available)"}`,
  ].join("\n\n");
}

function validateReviewResponse(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Reviewer output must be a JSON object.");
  }
  if (!["approve", "request_changes"].includes(output.verdict)) {
    throw new Error('Reviewer verdict must be "approve" or "request_changes".');
  }
  if (typeof output.summary !== "string" || !output.summary.trim()) {
    throw new Error("Reviewer response requires a non-empty summary.");
  }
  if (!Array.isArray(output.findings) || output.findings.length > 50) {
    throw new Error("Reviewer findings must be an array of at most 50 entries.");
  }
  const findings = output.findings.map((item) => {
    if (!item || typeof item !== "object" || !["blocking", "minor"].includes(item.severity) ||
        typeof item.message !== "string" || !item.message.trim()) {
      throw new Error("Each reviewer finding requires severity (blocking|minor) and non-empty message.");
    }
    return {
      severity: item.severity,
      ...(typeof item.file === "string" && item.file.trim() ? { file: redactSecretContent(item.file.trim()).slice(0, 200) } : {}),
      message: redactSecretContent(item.message.trim()).slice(0, 500),
    };
  });
  if (output.verdict === "approve" && findings.some((item) => item.severity === "blocking")) {
    throw new Error('Reviewer cannot return verdict "approve" with blocking findings.');
  }
  return {
    verdict: output.verdict,
    summary: redactSecretContent(output.summary.trim()).slice(0, 600),
    findings,
  };
}

async function runWorkspaceProvider(resolvedProvider, projectDir, prompt, timeoutMs) {
  const request = "Complete the task described in the prompt provided on stdin (also saved in loop-input.txt outside the project) and return a concise JSON summary {\"summary\": \"...\", \"notes\": []}.";
  const result = await runProviderProcess({
    ...resolvedProvider,
    prompt,
    cwd: projectDir,
    inputFile: "loop-input.txt",
    timeoutMs,
    requireJson: false,
    buildArgs: ({ finalPath, provider }) => ({
      codex: ["--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check",
        "--ephemeral", "--ignore-user-config", "--output-last-message", finalPath, request],
      gemini: ["--approval-mode=auto_edit", "--output-format=json", "--prompt", request],
      antigravity: ["--mode=agent", "--output-format=json", "--print", request],
    }[provider]),
  }).promise;

  if (result.parsed && typeof result.parsed.summary === "string") {
    return {
      summary: redactSecretContent(result.parsed.summary.trim()).slice(0, 600),
      notes: Array.isArray(result.parsed.notes) ? result.parsed.notes.slice(0, 10).map((n) => redactSecretContent(String(n))) : [],
    };
  }
  return {
    summary: redactSecretContent(String(result.rawText ?? "").trim() || "Implementation turn finished.").slice(0, 600),
    notes: [],
  };
}

/**
 * Executes a bounded implement -> verify -> review -> fix loop for one open task.
 */
export async function runCodingLoop({
  projectDir,
  harnessDir,
  configFile,
  taskId = null,
  tool = null,
  sessionId = null,
  dryRun = false,
} = {}) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  const absProject = loaded.projectDir;
  const config = readLoopConfig(absProject, configFile);
  const initialTask = resolveOpenTask(absProject, harnessDir, taskId);
  const progressPath = codingLoopProgressPath(initialTask.id);

  compileContext({
    projectDir: absProject,
    harnessDir,
    taskId: initialTask.id,
    profile: "working",
    includeSkills: true,
    globalSkillsDir: null,
  });

  if (dryRun) {
    return {
      status: "dry_run",
      projectDir: absProject,
      taskId: initialTask.id,
      maxFixRounds: config.maxFixRounds,
      verifyCommand: config.verifyCommand,
      implementer: config.implementer.runner,
      reviewer: config.reviewer?.runner ?? null,
      progressPath,
    };
  }

  let task = initialTask;
  if (task.record.status !== "active") {
    updateTask({ projectDir: absProject, harnessDir, taskId: task.id, status: "active", activate: true, tool, sessionId });
    task = getTask({ projectDir: absProject, harnessDir, taskId: task.id });
  }

  const progress = {
    version: CODING_LOOP_VERSION,
    taskId: task.id,
    status: "running",
    maxFixRounds: config.maxFixRounds,
    verifyCommand: config.verifyCommand,
    roundsUsed: 0,
    implementAttempts: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    evidenceId: null,
    checkpointId: null,
    reason: null,
    review: null,
    history: [],
  };
  const persist = () => {
    progress.updatedAt = new Date().toISOString();
    writeRuntimeJson(absProject, progressPath, progress);
  };
  persist();

  const stopBlocked = (reason, summary, { evidenceId = null, verifiedEvidence = false, review = null } = {}) => {
    let checkpoint;
    withProjectLock(absProject, () => {
      updateTask({ projectDir: absProject, harnessDir, taskId: task.id, status: "blocked", tool, sessionId });
      checkpoint = createCheckpoint({
        projectDir: absProject,
        harnessDir,
        ...(verifiedEvidence && evidenceId ? { evidenceRef: evidenceId } : {}),
        summary,
      });
    });
    progress.status = "blocked";
    progress.reason = reason;
    progress.evidenceId = evidenceId;
    progress.checkpointId = checkpoint.checkpointId;
    progress.review = review;
    persist();
    return {
      status: "blocked",
      reason,
      projectDir: absProject,
      taskId: task.id,
      roundsUsed: progress.roundsUsed,
      implementAttempts: progress.implementAttempts,
      evidenceId,
      checkpointId: checkpoint.checkpointId,
      review,
      progressPath,
    };
  };

  const runImplementStage = async (stage, round, feedback = null) => {
    progress.implementAttempts += 1;
    const context = compileContext({
      projectDir: absProject,
      harnessDir,
      taskId: task.id,
      profile: "working",
      includeSkills: true,
      globalSkillsDir: null,
    });
    const prompt = buildImplementPrompt({ stage, round, task, contextMarkdown: context.markdown, feedback });
    try {
      const reply = await runWorkspaceProvider(config.implementer, absProject, prompt, config.timeoutMs);
      progress.history.push({ stage, round, ok: true, summary: reply.summary });
      persist();
      return { ok: true, error: null };
    } catch (err) {
      const msg = redactSecretContent(err.message);
      progress.history.push({ stage, round, ok: false, error: msg });
      persist();
      return { ok: false, error: msg };
    }
  };

  await runImplementStage("implement", 0, null);

  let lastReview = null;
  for (let round = 0; round <= config.maxFixRounds; round += 1) {
    progress.roundsUsed = round;
    const evidence = captureEvidence({
      projectDir: absProject,
      harnessDir,
      taskId: task.id,
      commandArgv: config.verifyCommand,
      name: "Coding loop verification gate",
      timeoutMs: config.timeoutMs,
      linkVerifiedOnly: true,
    });
    const checkSummary = redactSecretContent(evidence.record?.checks?.[0]?.summary ?? "");
    progress.history.push({
      stage: "verify",
      round,
      evidenceId: evidence.id,
      verified: evidence.verified,
      exitCode: evidence.exitCode,
      summary: checkSummary.slice(0, 600),
    });
    persist();

    if (!evidence.verified) {
      if (round < config.maxFixRounds) {
        const feedback = `${checkSummary}\n${evidence.outputExcerpt ?? ""}`.trim();
        await runImplementStage("fix", round + 1, feedback);
        continue;
      }
      return stopBlocked(
        "verify_failed_max_rounds",
        `Coding loop blocked after ${config.maxFixRounds} fix round(s); verification failed (${evidence.id}).`,
        { evidenceId: evidence.id, verifiedEvidence: false }
      );
    }

    if (config.reviewer) {
      const diffText = collectBoundedDiff(absProject);
      const reviewPrompt = buildReviewPrompt({ round, task, evidence, diffText });
      let review;
      try {
        const rawReview = await startAuditProvider(config.reviewer, reviewPrompt, { timeoutMs: config.timeoutMs }).promise;
        review = validateReviewResponse(rawReview);
      } catch (err) {
        const msg = redactSecretContent(err.message);
        review = {
          verdict: "request_changes",
          summary: msg,
          findings: [{ severity: "blocking", message: msg }],
          invalid: true,
        };
      }
      lastReview = review;
      progress.history.push({ stage: "review", round, ...review });
      persist();

      if (review.verdict !== "approve") {
        if (round < config.maxFixRounds) {
          const feedback = JSON.stringify(review);
          await runImplementStage("fix", round + 1, feedback);
          continue;
        }
        return stopBlocked(
          "review_changes_requested_max_rounds",
          `Coding loop blocked after ${config.maxFixRounds} fix round(s); reviewer requested changes (${evidence.id}).`,
          { evidenceId: evidence.id, verifiedEvidence: true, review }
        );
      }
    }

    let checkpoint;
    withProjectLock(absProject, () => {
      checkpoint = createCheckpoint({
        projectDir: absProject,
        harnessDir,
        evidenceRef: evidence.id,
        summary: `Coding loop verified and completed ${task.id} (${evidence.id}).`,
      });
      completeTask({
        projectDir: absProject,
        harnessDir,
        taskId: task.id,
        requireEvidence: true,
        evidenceRefs: [evidence.id],
        tool,
        sessionId,
      });
    });
    progress.status = "completed";
    progress.evidenceId = evidence.id;
    progress.checkpointId = checkpoint.checkpointId;
    progress.review = lastReview;
    persist();
    return {
      status: "completed",
      projectDir: absProject,
      taskId: task.id,
      roundsUsed: round,
      implementAttempts: progress.implementAttempts,
      evidenceId: evidence.id,
      checkpointId: checkpoint.checkpointId,
      review: lastReview,
      progressPath,
    };
  }

  throw new Error("Coding loop exited unexpectedly without resolution.");
}

/**
 * Loads the persisted coding-loop status and stage history for a task.
 */
export function getCodingLoopStatus({ projectDir, harnessDir, taskId = null } = {}) {
  const loaded = loadProjectManifestAndState(projectDir, harnessDir);
  let targetId = taskId;
  if (!targetId) {
    const active = loaded.state.active_tasks ?? [];
    if (active.length !== 1) {
      throw new Error("Pass --task TASK-NNNN when there is no single active task.");
    }
    [targetId] = active;
  }
  const task = getTask({ projectDir: loaded.projectDir, harnessDir, taskId: targetId });
  const progressPath = codingLoopProgressPath(task.id);
  const progress = readRuntimeJson(loaded.projectDir, progressPath);
  if (!progress) {
    throw new Error(`No coding loop progress found for ${task.id}.`);
  }
  return {
    projectDir: loaded.projectDir,
    progressPath,
    ...progress,
  };
}
