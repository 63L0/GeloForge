import { getProjectRecommendations } from "./project-status.mjs";
import { createCheckpoint } from "./checkpoint.mjs";
import { captureEvidence } from "./evidence-capture.mjs";
import { redactSecretContent } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { withProjectLock } from "./project-lock.mjs";
import { completeTask, getTask } from "./task-manager.mjs";

export function verifyTask({ projectDir, harnessDir, taskId, commandArgv, name, timeoutMs, tool, sessionId, artifactPaths, dryRun }) {
  if (!taskId) {
    const { state } = loadProjectManifestAndState(projectDir, harnessDir);
    const active = state.active_tasks ?? [];
    if (active.length !== 1) throw new Error("Pass --task TASK-NNNN when there is no single active task.");
    [taskId] = active;
  }
  const task = getTask({ projectDir, harnessDir, taskId });
  taskId = task.id;
  const taskOptions = { projectDir, harnessDir, taskId, tool, sessionId };
  const assertOpen = ({ record }) => {
    if (["completed", "cancelled", "superseded"].includes(record.status)) {
      throw new Error(`${taskId} is ${record.status}. Run evidence capture to check a closed task.`);
    }
  };
  assertOpen(task);
  completeTask({ ...taskOptions, dryRun: true });

  const evidence = captureEvidence({
    projectDir, harnessDir, taskId, commandArgv, name, timeoutMs, dryRun, artifactPaths, linkVerifiedOnly: true,
  });
  const result = { taskId, evidence, checkpoint: null, completion: null };
  if (dryRun) return { ...result, status: "dry_run" };
  if (!evidence.verified) return { ...result, status: "check_failed" };

  try {
    withProjectLock(projectDir, () => {
      assertOpen(getTask(taskOptions));
      const completionOptions = { ...taskOptions, requireEvidence: true, evidenceRefs: [evidence.id] };
      completeTask({ ...completionOptions, dryRun: true });
      result.checkpoint = createCheckpoint({
        projectDir, harnessDir, evidenceRef: evidence.id,
        summary: `Verification command passed for ${taskId} (${evidence.id}).`,
      });
      result.completion = completeTask(completionOptions);
    });
  } catch (err) {
    return { ...result, status: "completion_blocked", error: redactSecretContent(err.message) };
  }

  // Completion is committed. A failed advisory read must never turn a pass into a retry.
  let followUp;
  try {
    const { recommendations } = getProjectRecommendations(projectDir);
    const top = recommendations.find(item => item.sources?.length);
    followUp = top
      ? { status: "suggested", title: top.title, reason: top.reason, sources: top.sources, askBeforeStarting: true }
      : { status: "none" };
  } catch {
    followUp = { status: "unavailable" };
  }
  return { ...result, status: "completed", followUp };
}
