import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";

const CLI = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));
const evalFixture = JSON.parse(fs.readFileSync(new URL("../evaluations/staging-audits.json", import.meta.url), "utf8"));
const deliveryWorkflow = JSON.parse(fs.readFileSync(new URL("../adapters/n8n/staging-audit-error-workflow.json", import.meta.url), "utf8"));
const exec = promisify(execFile);

async function cli(cwd, ...args) {
  const out = await exec(process.execPath, [CLI, ...args, "--json"], { cwd, timeout: 20_000 });
  return JSON.parse(out.stdout);
}

const mock = String.raw`
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const inputs = fs.readFileSync("audit-input.txt", "utf8");
const data = JSON.parse(inputs.split("\n").find((line) => line.startsWith('{"taskId"')));
const args = process.argv.slice(2);
const provider = args[0] === "--ask-for-approval" ? "codex" : args[0] === "--approval-mode=plan" ? "gemini" : "antigravity";
if (provider === "codex" && (!args.includes("read-only") || !args.includes("--ignore-user-config"))) process.exit(10);
if (provider === "antigravity" && (!args.includes("--mode=plan") || !args.includes("--sandbox"))) process.exit(11);
if (process.env.API_KEY || inputs.includes("PRIVATE RAW DATA")) process.exit(12);
const role = data.candidates ? "review" : data.area;
const id = data.execution.id;
const output = new URL("./events.jsonl", import.meta.url);
const log = (event) => fs.appendFileSync(output, JSON.stringify({ id, role, event, provider, skill: inputs.includes("Check staged n8n workflow routing") }) + "\n");
log("start");
if (fs.existsSync(new URL("./hang-all", import.meta.url)) ||
    (role === "review" && fs.existsSync(new URL("./hold-review", import.meta.url)))) {
  await delay(15000);
}
if (fs.existsSync(new URL("./invalid-output", import.meta.url))) {
  console.log("invalid JSON");
  process.exit(0);
}
const record = data.execution;
if (data.allowedNodes?.length === 2 &&
    new Set(["Inquiry routing", "Quotation handoff"]).has(role) &&
    fs.existsSync(new URL("./parallel-barrier", import.meta.url))) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const starts = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse)
      .filter((line) => line.id === id && line.event === "start");
    if (starts.some((line) => line.role !== role)) break;
    if (attempt === 59) process.exit(13);
    await delay(25);
  }
}
const findings = [{
  workflowId: record.workflowId, executionId: id, revision: record.revision,
  node: role === "Quotation handoff" ? "Create staff handoff" : record.failedNode,
  pattern: role === "Quotation handoff" ? "handoff" : "routing",
  reference: role === "Quotation handoff" ? "defined" : "failed-at",
  summary: role === "Quotation handoff" ? "The graph defines the staff handoff node." : "The execution records failure at the inquiry validation node.",
}];
const result = data.candidates
  ? { accepted: data.candidates.filter((item) => item.reference === "failed-at").map((item) => item.id),
    gaps: ["The staff handoff node is defined. This execution lacks a handoff trace."], nextAction: "Inspect inquiry validation in staging." }
  : { findings, gaps: [], nextAction: "Check the saved staging execution before changing routing." };
if (provider === "codex") fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(result));
else console.log(JSON.stringify({ ...(provider === "antigravity" && { status: "SUCCESS" }), response: JSON.stringify(result) }));
log("end");
`;

function setup(t, { parallel = false, maxRuns = 5, maxTotalRuns = 20, timeoutMs = 1800 } = {}) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-stage-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const project = path.join(temp, "furniture project");
  bootstrapProject({ name: "Furniture Staging Fixture", dest: project, profile: "automation", git: false });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = path.join(temp, "owner.pem");
  const pin = path.join(temp, "owner-public.pem");
  const executable = path.join(temp, "mock-provider.mjs");
  fs.writeFileSync(key, privateKey);
  fs.writeFileSync(pin, publicKey);
  fs.writeFileSync(executable, mock);
  const { workflowId, areas } = evalFixture;
  const lane = (area, provider) => ({ area, nodes: areas[area], provider, executable });
  const settings = {
    version: 1, workflowIds: [workflowId], maxRuns, maxTotalRuns, timeoutMs,
    specialists: [lane("Inquiry routing", "codex")],
  };
  if (parallel) {
    settings.specialists.push(lane("Quotation handoff", "gemini"));
    settings.reviewer = { provider: "antigravity", executable };
  }
  const configFile = "local-runtime/staging.json";
  const root = path.join(project, "local-runtime", "n8n-audit", "inbox");
  fs.mkdirSync(root, { recursive: true });
  const skillDir = path.join(project, ".agents", "skills", "staging-check");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---", 'name: "staging-check"', 'description: "Audit n8n staging workflow routing and inspect saved execution evidence."',
    "metadata:", '  geloforge_triggers: "n8n, audit, routing"', "---", "", "# Check staged n8n workflow routing", "",
    "## When to Use", "Use for confirmed staging workflow failures.", "",
  ].join("\n"));
  fs.writeFileSync(path.join(project, configFile), JSON.stringify(settings));
  const authorize = () => cli(project, "autonomous", "authorize", "--config", configFile, "--key", key);
  const watchArgs = (approval) => ["autonomous", "watch", "--config", configFile, "--approval", approval, "--owner-key", pin];
  const watch = (approval) => cli(project, ...watchArgs(approval), "--once");
  const marker = (name) => path.join(temp, name);
  const events = () => fs.existsSync(marker("events.jsonl")) ?
    fs.readFileSync(marker("events.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  return { project, root, settings, configFile, executable, authorize, watch, watchArgs, events, marker };
}

// Execute the importable n8n Code node bodies with the corresponding n8n inputs.
function deliveryFor(row, { missing = false } = {}) {
  const workflowId = evalFixture.workflowId;
  const eventNode = deliveryWorkflow.nodes.find((node) => node.name === "Select staging failure IDs");
  const projectNode = deliveryWorkflow.nodes.find((node) => node.name === "Project audit evidence");
  const event = { workflow: { id: workflowId }, execution: { id: Number(row.executionId), error: { message: "PRIVATE RAW DATA" } } };
  const [selected] = new Function("$input", eventNode.parameters.jsCode)({ first: () => ({ json: event }) });
  const raw = missing ? { error: "PRIVATE RAW DATA" } : {
    id: row.executionId, workflowId, status: "error",
    workflowData: { versionId: evalFixture.revision, nodes: Object.values(evalFixture.areas).flat().map((name) => ({ name, parameters: "PRIVATE RAW DATA" })) },
    data: { resultData: { lastNodeExecuted: row.failedNode, runData: Object.fromEntries(row.executed.map((name) => [name, ["PRIVATE RAW DATA"]])) } },
  };
  const [projected] = new Function("$input", "$", "$execution", "Buffer", projectNode.parameters.jsCode)(
    { first: () => ({ json: raw }) }, () => ({ first: () => selected }), { id: 99 }, Buffer,
  );
  const bytes = Buffer.from(projected.binary.data.data, "base64");
  assert.doesNotMatch(bytes.toString(), /PRIVATE RAW DATA/);
  return { name: projected.json.fileName, bytes };
}

function send(fixture, row, options) {
  const { name, bytes } = deliveryFor(row, options);
  const file = path.join(fixture.root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

const [first, second] = evalFixture.cases;

test("single-agent worker starts from a staging delivery, verifies evidence, deduplicates and unblocks missing records", async (t) => {
  const f = setup(t);
  const file = send(f, first, { missing: true });
  const { approvalId } = await f.authorize();
  assert.deepEqual((await f.watch(approvalId)).results, []);
  assert.equal(fs.existsSync(file), true);
  await cli(f.project, "autonomous", "on");
  const blocked = (await f.watch(approvalId)).results[0];
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.nextAction, /saved execution record is unavailable/);
  assert.equal(f.events().length, 0);
  assert.equal(fs.existsSync(file), false);

  send(f, first);
  const done = (await f.watch(approvalId)).results[0];
  assert.equal(done.status, "completed");
  assert.equal(done.taskId, blocked.taskId);
  assert.equal(done.runs, 1);
  assert.equal(done.repairRetries, 0);
  assert.match(done.evidenceId, /^EVID-/);
  assert.match(done.checkpointId, /^CHKPT-/);
  const report = JSON.parse(fs.readFileSync(path.join(f.project, done.reportPath)));
  assert.deepEqual(report.findings.map((finding) => finding.node), first.expected.supported);
  assert.deepEqual((await cli(f.project, "task", "show", "--task", done.taskId)).record.evidence_refs, [done.evidenceId]);
  assert.ok(f.events().some((event) => event.skill));

  send(f, first);
  assert.deepEqual((await f.watch(approvalId)).results[0], { ...done, reused: true });
  assert.equal(f.events().filter(({ event }) => event === "start").length, 1);
  assert.equal((await cli(f.project, "task", "list")).tasks.length, 1);
  send(f, second);
  assert.equal((await f.watch(approvalId)).results[0].status, "completed");
  const { patterns } = await cli(f.project, "autonomous", "learn");
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].executions.length, 2);
  const draft = await cli(f.project, "autonomous", "learn", "--pattern", patterns[0].id, "--skill", "n8n-audit-pattern");
  assert.ok(fs.existsSync(path.join(f.project, draft.proposalDir, "SKILL.md")));
  assert.equal(fs.existsSync(path.join(f.project, ".agents", "skills", "n8n-audit-pattern")), false);
  assert.equal((await cli(f.project, "validate")).valid, true);
  fs.appendFileSync(path.join(f.project, done.reportPath), " ");
  assert.deepEqual((await cli(f.project, "autonomous", "learn")).patterns, []);
});

async function waitUntil(check) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail("Timed out waiting for the staged worker result.");
}

test("two scoped specialists overlap, followed by a fresh reviewer with independently checked references", async (t) => {
  const f = setup(t, { parallel: true });
  fs.writeFileSync(f.marker("parallel-barrier"), "");
  await cli(f.project, "autonomous", "on");
  const { approvalId } = await f.authorize();
  send(f, first);
  const done = (await f.watch(approvalId)).results[0];
  assert.equal(done.status, "completed");
  assert.equal(done.runs, 3);
  const logs = f.events();
  assert.deepEqual(new Set(logs.slice(0, 2).map(({ role }) => role)), new Set(Object.keys(evalFixture.areas)));
  assert.deepEqual(logs.slice(0, 2).map(({ event }) => event), ["start", "start"]);
  assert.equal(logs[4].role, "review");
  assert.equal(logs[4].provider, "antigravity");
  const report = JSON.parse(fs.readFileSync(path.join(f.project, done.reportPath)));
  assert.deepEqual(report.findings.map(({ node }) => node), first.expected.supported);
  for (const node of first.expected.omitted) assert.ok(!report.findings.some((finding) => finding.node === node));
  assert.match(report.gaps.join(" "), /lacks a handoff trace/);
});

test("persistent worker picks up an arriving file and resumes from the last completed specialist steps", {
  skip: process.platform === "win32" ? "Signal-driven worker shutdown is exercised on POSIX" : false,
}, async (t) => {
  const f = setup(t, { parallel: true, timeoutMs: 10_000 });
  fs.writeFileSync(f.marker("hold-review"), "");
  await cli(f.project, "autonomous", "on");
  const { approvalId } = await f.authorize();
  const child = spawn(process.execPath, [CLI, ...f.watchArgs(approvalId), "--json"], {
    cwd: f.project, stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  });
  const diagnostics = [];
  child.stderr.on("data", (chunk) => diagnostics.push(chunk));
  await waitUntil(() => fs.existsSync(path.join(f.project, "local-runtime", "n8n-audit", "worker.json")));
  const pending = send(f, first);
  await waitUntil(() => f.events().some(({ role, event }) => role === "review" && event === "start"));
  await assert.rejects(f.watch(approvalId), /already has a live audit worker/);
  child.kill("SIGTERM");
  assert.equal(await closed, 0, Buffer.concat(diagnostics).toString());
  assert.equal(fs.existsSync(pending), true);
  const status = await cli(f.project, "autonomous", "progress", "--task", "TASK-0001");
  assert.ok(status.specialists.every(({ saved }) => saved));
  assert.equal(status.reviewer.saved, false);
  fs.unlinkSync(f.marker("hold-review"));

  const resumed = (await f.watch(approvalId)).results[0];
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.taskId, "TASK-0001");
  assert.equal(resumed.reused, true);
  assert.equal(resumed.runs, 4);
  assert.equal(resumed.repairRetries, 1);
  assert.equal(f.events().filter((item) => item.event === "start" && item.role !== "review").length, 2);
});

test("timed-out providers stop at the run limit and save a recoverable checkpoint", async (t) => {
  const f = setup(t, { maxRuns: 1, timeoutMs: 200 });
  fs.writeFileSync(f.marker("hang-all"), "");
  await cli(f.project, "autonomous", "on");
  const { approvalId } = await f.authorize();
  send(f, first);
  const blocked = (await f.watch(approvalId)).results[0];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.runs, 1);
  assert.equal(blocked.repairRetries, 0);
  assert.match(blocked.nextAction, /Run limit reached.*timeout/);
  assert.match(blocked.checkpointId, /^CHKPT-/);
  const resumed = await cli(f.project, "checkpoint", "resume", "--id", blocked.checkpointId);
  assert.equal(resumed.nextAction, blocked.nextAction);
});

test("a malformed provider response consumes at most two report repair retries", async (t) => {
  const f = setup(t);
  fs.writeFileSync(f.marker("invalid-output"), "");
  await cli(f.project, "autonomous", "on");
  const { approvalId } = await f.authorize();
  send(f, first);
  const blocked = (await f.watch(approvalId)).results[0];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.runs, 3);
  assert.equal(blocked.repairRetries, 2);
  assert.match(blocked.nextAction, /Two report repair retries/);
  assert.equal(blocked.evidenceId, null);
  assert.match(blocked.checkpointId, /^CHKPT-/);
});

test("the worker refuses changed executable bytes, an unsigned configuration, and overlapping scopes", async (t) => {
  const f = setup(t, { parallel: true });
  await cli(f.project, "autonomous", "on");
  send(f, first);
  await assert.rejects(f.watch("APPR-0099"), /Expected one owner approval record/);
  const { approvalId } = await f.authorize();
  fs.appendFileSync(f.executable, "\n");
  await assert.rejects(f.watch(approvalId), /does not authorize these inputs/);
  f.settings.specialists[1].nodes = f.settings.specialists[0].nodes;
  fs.writeFileSync(path.join(f.project, f.configFile), JSON.stringify(f.settings));
  await assert.rejects(f.authorize(), /disjoint/);
  assert.equal(f.events().length, 0);
  assert.equal((await cli(f.project, "task", "list")).tasks.length, 0);
});

test("an approval's total launch cap holds across separate audit deliveries", async (t) => {
  const f = setup(t, { maxTotalRuns: 1 });
  await cli(f.project, "autonomous", "on");
  const { approvalId } = await f.authorize();
  send(f, first);
  assert.equal((await f.watch(approvalId)).results[0].status, "completed");
  send(f, second);
  const blocked = (await f.watch(approvalId)).results[0];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.runs, 0);
  assert.match(blocked.nextAction, /Owner-approved total run limit reached/);
  assert.equal(f.events().filter(({ event }) => event === "start").length, 1);
});
