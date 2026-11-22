import fs from "node:fs";
import { AUDIT_CREATOR } from "./autonomous-audit.mjs";
import { assertSafeWithinRoot, validateSlug } from "./path-safety.mjs";
import { loadProjectManifestAndState } from "./project-locator.mjs";
import { withProjectLock } from "./project-lock.mjs";
import { readRuntimeJson, sha256 } from "./runtime-files.mjs";
import { draftSkillFromExperience, loadVerifiedSourceBundle, proposeSkillUpdate } from "./skills-lifecycle.mjs";
import { reportArtifactPath } from "./staging-audit.mjs";
import { verifyStagingReport } from "./staging-evidence.mjs";
import { getTask, listTasks } from "./task-manager.mjs";

export function learnFromStagingAudits({ projectDir, harnessDir, patternId, skillName, step }) {
  const read = () => {
    const project = loadProjectManifestAndState(projectDir, harnessDir);
    const patterns = new Map();
    const warnings = [];
    for (const { id } of listTasks({ ...project, harnessDir, status: "completed" }).tasks) {
      const { record } = getTask({ ...project, harnessDir, taskId: id });
      if (record.created_by !== AUDIT_CREATOR) continue;
      const artifact = reportArtifactPath(project.projectPaths, id);
      try {
        const source = readRuntimeJson(projectDir, artifact);
        if (!source) continue;
        const report = verifyStagingReport(source, id);
        const { evidenceList } = loadVerifiedSourceBundle({ projectDir, harnessDir, evidenceIds: record.evidence_refs });
        const evidence = evidenceList.find(({ data }) => data.task_id === id && data.verified_by === "geloforge-staging-report" &&
          data.artifacts.some(({ path, sha256: digest }) => path === artifact && digest));
        if (!evidence) throw new Error("Missing evidence binding.");
        for (const { workflowId, node, pattern, reference } of report.findings) {
          // A node definition gives useful context, but it does not show a recurring failure.
          if (!node || reference !== "failed-at") continue;
          const key = sha256(JSON.stringify([workflowId, node, pattern])).slice(0, 16);
          if (!patterns.has(key)) patterns.set(key, { id: key, workflowId, node, pattern, executions: new Map() });
          patterns.get(key).executions.set(report.executionId, {
            executionId: report.executionId, evidenceId: evidence.data.id, revision: report.execution.revision,
          });
        }
      } catch {
        warnings.push(`Excluded ${id} because its report or evidence could not be verified.`);
      }
    }
    const recurring = [...patterns.values()].filter((pattern) => pattern.executions.size >= 2)
      .map(({ executions, ...pattern }) => ({ ...pattern, executions: [...executions.values()] }));
    return { patterns: recurring, warnings };
  };
  if (!patternId) {
    if (skillName || step) throw new Error("Use --pattern before drafting a skill.");
    return read();
  }
  return withProjectLock(projectDir, () => {
    validateSlug(skillName);
    const result = read();
    const pattern = result.patterns.find(({ id }) => id === patternId);
    if (!pattern) throw new Error("Recurring pattern is missing or its evidence is no longer verified.");
    const evidenceIds = pattern.executions.map(({ evidenceId }) => evidenceId);
    const note = step ?? `For ${pattern.pattern} failures in workflow ${pattern.workflowId}, check whether ${pattern.node} is the failing node and confirm the saved execution and revision before recommending a fix.`;
    const options = { projectDir, harnessDir, evidenceIds, skillName };
    const active = assertSafeWithinRoot(projectDir, `.agents/skills/${skillName}/SKILL.md`);
    const proposal = fs.existsSync(active)
      ? proposeSkillUpdate({ ...options, reason: "Review a recurring staging failure pattern.", appendNote: note })
      : draftSkillFromExperience({
        ...options, title: "Investigate recurring n8n staging failures",
        description: "Review the saved n8n staging execution and confirm recurring failures against linked evidence.",
        steps: [note], tags: ["n8n", "staging", pattern.pattern], triggers: ["n8n", "audit", pattern.pattern],
      });
    return { pattern, proposalDir: proposal.proposalDir, nextAction: "Review the draft, then use the existing skill signing and promotion commands." };
  });
}
