import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";

const CLI = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));
const exec = promisify(execFile);

function makeProject(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-autonomous-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(temp, "Furniture Bot staging");
  bootstrapProject({ name: "Furniture Bot staging", dest: root, profile: "automation" });
  return root;
}

async function cli(cwd, ...args) {
  const result = await exec(process.execPath, [CLI, ...args, "--json"], { cwd, timeout: 15_000 });
  return JSON.parse(result.stdout);
}

function writeInputs(root, { recordWorkflowId = "WF-stage", recordStatus = "error" } = {}) {
  const execution = { id: 231, error: { message: "Example test failure", stack: "Raw stack stays local" } };
  fs.writeFileSync(path.join(root, "event.json"), JSON.stringify([{ workflow: { id: "WF-stage" }, execution }]));
  fs.writeFileSync(path.join(root, "execution.json"), JSON.stringify({
    id: "231", workflowId: recordWorkflowId, status: recordStatus, lastNodeExecuted: "Validate product details",
    data: { input: "Raw customer data stays local" },
  }));
}

const delivery = ["autonomous", "audit", "--event", "event.json", "--execution", "execution.json"];

test("staging failure is skipped by default and concurrent delivery creates one verified audit when enabled", async (t) => {
  const root = makeProject(t);
  const other = makeProject(t);
  writeInputs(root);

  assert.equal((await cli(root, "autonomous", "status")).mode, "off");
  const skipped = await cli(root, ...delivery);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.taskId, null);
  assert.match(skipped.nextAction, /manually/);
  assert.equal((await cli(root, "task", "list")).tasks.length, 0);
  assert.equal((await cli(root, "checkpoint", "list")).count, 0);
  assert.equal((await cli(root, "recommend")).autonomousMode, "off");

  assert.equal((await cli(root, "autonomous", "on")).mode, "on");
  assert.equal((await cli(other, "autonomous", "status")).mode, "off");
  const attempts = await Promise.all([cli(root, ...delivery), cli(root, ...delivery)]);
  const first = attempts.find((result) => !result.reused);
  const duplicate = attempts.find((result) => result.reused);
  assert.equal(first.status, "completed");
  assert.equal(first.mode, "on");
  assert.match(first.nextAction, /Last node: Validate product details/);
  assert.match(first.nextAction, /SHA-256: [a-f0-9]{64}/);
  assert.deepEqual(duplicate, { ...first, reused: true });
  assert.equal((await cli(root, "recommend")).autonomousMode, "on");
  assert.equal((await cli(root, "task", "list")).tasks.length, 1);
  assert.equal((await cli(root, "checkpoint", "list")).count, 1);
  const task = await cli(root, "task", "show", "--task", first.taskId);
  assert.deepEqual(task.record.evidence_refs, [first.evidenceId]);
  const evidenceFiles = fs.readdirSync(path.join(root, "evidence"));
  assert.equal(evidenceFiles.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "evidence", evidenceFiles[0]), "utf8"), /Raw customer|Raw stack/);
  assert.equal((await cli(root, "validate")).valid, true);

  assert.equal((await cli(root, "autonomous", "off")).mode, "off");
  writeInputs(other);
  assert.equal((await cli(other, ...delivery)).status, "skipped");
  assert.equal((await cli(root, ...delivery)).status, "skipped");
  assert.equal((await cli(root, "checkpoint", "list")).count, 1);
});

test("an unmatched execution blocks the audit and recommend points to its evidence gap", async (t) => {
  const root = makeProject(t);
  writeInputs(root, { recordWorkflowId: "unrelated-workflow" });
  await cli(root, "autonomous", "on");
  const blocked = await cli(root, ...delivery);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.evidenceId, null);
  assert.match(blocked.nextAction, /does not match.*workflow WF-stage, execution 231/);
  assert.deepEqual(await cli(root, ...delivery), { ...blocked, reused: true });

  const recommendation = (await cli(root, "recommend")).recommendations.find((entry) => entry.category === "autonomous_audit");
  assert.equal(recommendation.reason, blocked.nextAction);
  assert.equal(recommendation.command, `geloforge checkpoint show --id ${blocked.checkpointId}`);
  assert.deepEqual((await cli(root, "task", "show", "--task", blocked.taskId)).record.evidence_refs, []);
  assert.equal((await cli(root, "checkpoint", "list")).count, 1);
  assert.equal((await cli(root, "validate")).valid, true);
});
