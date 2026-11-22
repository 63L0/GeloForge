/** Evidence format shared by the n8n delivery worker, report verifier and learning scan. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertSafeWithinRoot, hasSecretContent } from "./path-safety.mjs";
import { readRegularFile, sha256 } from "./runtime-files.mjs";

export const evidenceVerifier = fileURLToPath(import.meta.url);
export const patternTypes = ["routing", "validation", "duplicate-action", "handoff", "runtime"];
export const referenceTypes = ["failed-at", "executed", "defined"];

export function normalizeN8nId(value) {
  const id = Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof id === "string" && /^[a-z0-9_-]{1,64}$/i.test(id) && !hasSecretContent(id) ? id : null;
}

export function validNodeName(value) {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 180 &&
    !/[\x00-\x1f\x7f]/.test(value) && !hasSecretContent(value);
}

function nodeList(value, limit) {
  if (!Array.isArray(value) || value.length > limit || value.some((name) => !validNodeName(name))) return null;
  return [...new Set(value)];
}

export function inspectDelivery(payload) {
  const delivery = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
  const workflowId = normalizeN8nId(delivery?.workflowId);
  const executionId = normalizeN8nId(delivery?.executionId);
  if (delivery?.environment !== "staging" || !workflowId || !executionId) {
    throw new Error("Expected a staging failure delivery with a workflow ID and a saved execution ID.");
  }
  const result = { workflowId, executionId, execution: null };
  const scoped = message => ({ ...result, missingEvidence: `${message} Supply the saved staging record for ${workflowId}/${executionId} and redeliver the event.` });
  const record = delivery.execution;
  if (!record) return scoped("The saved execution record is unavailable.");
  if (normalizeN8nId(record.id) !== executionId || normalizeN8nId(record.workflowId) !== workflowId || record.status !== "error") {
    return scoped("The execution record must match both IDs and show error status.");
  }
  const revision = normalizeN8nId(record.revision);
  const nodes = nodeList(record.nodes, 512);
  const executed = nodeList(record.executed, 512);
  const failedNode = record.failedNode ?? null;
  if (!revision || !nodes?.length || !executed ||
      (failedNode !== null && (!validNodeName(failedNode) || !nodes.includes(failedNode))) ||
      executed.some((name) => !nodes.includes(name))) {
    return scoped("The execution's workflow revision, node list, or node trace is unavailable or inconsistent.");
  }
  return { ...result, execution: { id: executionId, workflowId, status: "error", revision, nodes, executed, failedNode } };
}

function shortText(text, max = 400) {
  return typeof text === "string" && text.trim().length > 0 && text.length <= max &&
    !/[\x00-\x1f\x7f]/.test(text) && !hasSecretContent(text);
}

function reportNotes(value) {
  if (!Array.isArray(value?.gaps) || value.gaps.length > 12 || value.gaps.some((gap) => !shortText(gap)) ||
      !shortText(value.nextAction)) {
    throw new Error("Report must include bounded gaps and a next action.");
  }
  return { gaps: [...new Set(value.gaps)], nextAction: value.nextAction };
}

export function validateSpecialistReport(value, execution, allowedNodes = execution.nodes, maxFindings = 10) {
  const notes = reportNotes(value);
  if (!Array.isArray(value.findings) || value.findings.length > maxFindings) throw new Error(`Expected up to ${maxFindings} findings.`);
  const findings = value.findings.map((finding) => {
    if (!finding || finding.workflowId !== execution.workflowId || finding.executionId !== execution.id ||
        finding.revision !== execution.revision || !patternTypes.includes(finding.pattern) ||
        !referenceTypes.includes(finding.reference) || !shortText(finding.summary)) {
      throw new Error("A finding does not bind to the saved workflow, revision and execution.");
    }
    const { node, pattern, reference, summary } = finding;
    if (node === null) {
      if (execution.failedNode !== null || reference !== "failed-at") throw new Error("The affected node is required when available.");
    } else if (!allowedNodes.includes(node) || !execution.nodes.includes(node) ||
        (reference === "failed-at" && node !== execution.failedNode) ||
        (reference === "executed" && !execution.executed.includes(node))) {
      throw new Error("A finding's node or evidence reference does not match its scope and the execution trace.");
    }
    return { workflowId: finding.workflowId, executionId: finding.executionId, revision: finding.revision,
      node, pattern, reference, summary };
  });
  return { findings, ...notes };
}

export function validateReview(value, candidates) {
  const notes = reportNotes(value);
  if (!Array.isArray(value.accepted) || value.accepted.length > candidates.length ||
      new Set(value.accepted).size !== value.accepted.length ||
      value.accepted.some((id) => !candidates.some((item) => item.id === id))) {
    throw new Error("Reviewer must select existing finding IDs from the supplied candidates.");
  }
  if (value.accepted.length < candidates.length && notes.gaps.length === 0) {
    throw new Error("Reviewer must explain omitted candidates in gaps.");
  }
  return { accepted: value.accepted, ...notes };
}

export function verifyStagingReport(report, taskId) {
  if (!/^TASK-\d{4}$/.test(taskId) || report?.taskId !== taskId || report.version !== 1) {
    throw new Error("Staging report does not match the audit task.");
  }
  const snapshot = inspectDelivery({ environment: "staging", workflowId: report.workflowId,
    executionId: report.executionId, execution: report.execution });
  if (!snapshot.execution || !isDeepStrictEqual(snapshot.execution, report.execution)) {
    throw new Error("Required staging evidence is unavailable or changed.");
  }
  const validated = validateSpecialistReport(report, report.execution, report.execution.nodes, 20);
  if (!isDeepStrictEqual(validated.findings, report.findings)) throw new Error("Staging findings contain unsupported fields.");
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === evidenceVerifier) {
  try {
    const [taskId, relativePath, digest] = process.argv.slice(2);
    const raw = readRegularFile(assertSafeWithinRoot(process.cwd(), relativePath));
    if (!raw || sha256(raw) !== digest) throw new Error("Staging report artifact is unavailable or changed.");
    const report = verifyStagingReport(JSON.parse(raw), taskId);
    console.log(`Checked ${report.findings.length} finding references for workflow ${report.workflowId}, revision ${report.execution.revision}, execution ${report.executionId}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
