import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";

const CLI = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));

const mockLoopProvider = String.raw`
import fs from "node:fs";
import path from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const args = process.argv.slice(2);
const provider = args[0] === "--ask-for-approval" ? "codex" : args[0].startsWith("--approval-mode=") ? "gemini" : "antigravity";
if (provider === "gemini" && process.env.GEMINI_CLI_TRUST_WORKSPACE !== "true") process.exit(15);

const stateDir = new URL("./", import.meta.url);
const eventsPath = new URL("./events.jsonl", import.meta.url);
const mode = fs.existsSync(new URL("./always-fail", stateDir))
  ? "always-fail"
  : fs.existsSync(new URL("./policy-fail-first", stateDir))
    ? "policy-fail-first"
    : "happy";

if (provider === "codex") {
  if (!args.includes("workspace-write")) process.exit(10);
  const countFile = new URL("./implement-count.txt", stateDir);
  const attempt = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0) + 1;
  fs.writeFileSync(countFile, String(attempt));
  fs.appendFileSync(eventsPath, JSON.stringify({ role: "implementer", attempt, cwd: process.cwd(), hasMap: prompt.includes("Selective Codebase Map") }) + "\n");

  const target = path.join(process.cwd(), "src", "answer.mjs");
  if (mode === "always-fail") {
    fs.writeFileSync(target, "export const answer = () => 41;\n");
  } else if (mode === "policy-fail-first") {
    if (attempt === 1) {
      if (!prompt.includes("Selective Codebase Map") || !prompt.includes("src/answer.mjs")) process.exit(11);
      fs.writeFileSync(target, "export const answer = () => 42;\n");
    } else {
      if (!prompt.includes("failed policy check")) process.exit(14);
      fs.writeFileSync(target, "export const answer = () => 42;\n");
    }
  } else if (attempt === 1) {
    if (!prompt.includes("Selective Codebase Map") || !prompt.includes("src/answer.mjs")) process.exit(11);
    fs.writeFileSync(target, "export const answer = () => 41;\n");
  } else if (attempt === 2) {
    if (!prompt.includes("Command failed")) process.exit(12);
    fs.writeFileSync(target, "export const answer = () => 42; // needs-cleanup\n");
  } else {
    if (!prompt.includes("Remove needs-cleanup comment")) process.exit(13);
    fs.writeFileSync(target, "export const answer = () => 42;\n");
  }

  const outFile = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(outFile, JSON.stringify({ summary: "Implementer attempt " + attempt + " finished." }));
} else {
  const reviewCountFile = new URL("./review-count.txt", stateDir);
  const reviewTurn = (fs.existsSync(reviewCountFile) ? Number(fs.readFileSync(reviewCountFile, "utf8")) : 0) + 1;
  fs.writeFileSync(reviewCountFile, String(reviewTurn));
  fs.appendFileSync(eventsPath, JSON.stringify({ role: "reviewer", reviewTurn, cwd: process.cwd() }) + "\n");

  let payload;
  if (mode === "policy-fail-first") {
    payload = reviewTurn === 1
      ? {
          verdict: "approve",
          summary: "Contradictory failed policy check.",
          policy_checks: [{ rule: "Respect scope_out", passed: false }],
          findings: [],
        }
      : {
          verdict: "approve",
          summary: "All policy checks passed.",
          policy_checks: [{ rule: "Respect scope_out", passed: true }],
          findings: [],
        };
  } else {
    payload = prompt.includes("needs-cleanup")
      ? {
          verdict: "request_changes",
          summary: "Cleanup marker remains in diff.",
          policy_checks: [{ rule: "No temporary cleanup markers", passed: false }],
          findings: [{ severity: "blocking", file: "src/answer.mjs", message: "Remove needs-cleanup comment" }],
        }
      : {
          verdict: "approve",
          summary: "Deterministic gate and diff review passed.",
          policy_checks: [{ rule: "No temporary cleanup markers", passed: true }],
          findings: [],
        };
  }
  console.log(JSON.stringify({ response: JSON.stringify(payload) }));
}
`;

function cli(cwd, args, expectedStatus = 0) {
  const out = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.equal(out.error, undefined);
  assert.equal(out.status, expectedStatus, out.stderr || out.stdout);
  return out;
}

function setupLoopProject(t, { maxFixRounds = 2, withReviewer = true, alwaysFail = false, policyFailFirst = false } = {}) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-loop-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const project = path.join(temp, "loop project");
  bootstrapProject({ name: "Coding Loop Trial", dest: project, git: true });
  fs.writeFileSync(path.join(project, "src", "answer.mjs"), "export const answer = () => 0;\n");
  execFileSync("git", ["-C", project, "add", "."], { windowsHide: true });
  execFileSync("git", [
    "-C", project,
    "-c", "user.name=Test", "-c", "user.email=test@example.com",
    "commit", "-m", "initial",
  ], { windowsHide: true });

  const providerPath = path.join(temp, "mock-provider.mjs");
  fs.writeFileSync(providerPath, mockLoopProvider);
  if (alwaysFail) fs.writeFileSync(path.join(temp, "always-fail"), "");
  if (policyFailFirst) fs.writeFileSync(path.join(temp, "policy-fail-first"), "");

  const verifyScript = alwaysFail
    ? "process.exit(2)"
    : "import { answer } from './src/answer.mjs'; if (answer() !== 42) { console.error('Expected 42'); process.exit(2); }";
  const config = {
    version: 1,
    maxFixRounds,
    timeoutMs: 15_000,
    verifyCommand: [process.execPath, "--input-type=module", "-e", verifyScript],
    implementer: { provider: "codex", executable: providerPath },
    ...(withReviewer ? { reviewer: { provider: "gemini", executable: providerPath } } : {}),
  };
  fs.mkdirSync(path.join(project, "local-runtime"), { recursive: true });
  fs.writeFileSync(path.join(project, "local-runtime", "loop.json"), JSON.stringify(config, null, 2));
  cli(project, ["task", "new", "--title", "Fix answer module", "--activate", "--criteria", "answer() returns 42"]);

  const events = () => {
    const file = path.join(temp, "events.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
  };
  return { temp, project, events };
}

test("coding loop runs implement -> verify -> review -> fix rounds and completes with verified evidence", (t) => {
  const { project, events } = setupLoopProject(t);

  const preview = JSON.parse(cli(project, ["loop", "run", "--config", "local-runtime/loop.json", "--dry-run", "--json"]).stdout);
  assert.equal(preview.status, "dry_run");
  assert.equal(preview.taskId, "TASK-0001");
  assert.equal(events().length, 0);

  const res = JSON.parse(cli(project, ["loop", "run", "--config", "local-runtime/loop.json", "--json"]).stdout);
  assert.equal(res.status, "completed");
  assert.equal(res.taskId, "TASK-0001");
  assert.equal(res.roundsUsed, 2);
  assert.equal(res.implementAttempts, 3);
  assert.match(res.evidenceId, /^EVID-/);
  assert.match(res.checkpointId, /^CHKPT-/);
  assert.equal(res.review.verdict, "approve");

  // Deterministic gate failed on attempt 1 so reviewer was only invoked after verify passed on attempts 2 and 3.
  const log = events();
  assert.deepEqual(log.map((e) => e.role), ["implementer", "implementer", "reviewer", "implementer", "reviewer"]);
  assert.equal(log[0].hasMap, true);
  assert.notEqual(path.resolve(log[2].cwd).toLowerCase(), path.resolve(project).toLowerCase());

  const task = JSON.parse(cli(project, ["task", "show", "--task", "TASK-0001", "--json"]).stdout);
  assert.equal(task.record.status, "completed");
  assert.ok(task.record.evidence_refs.includes(res.evidenceId));

  const status = JSON.parse(cli(project, ["loop", "status", "--task", "TASK-0001", "--json"]).stdout);
  assert.equal(status.status, "completed");
  assert.deepEqual(
    status.history.map((h) => `${h.stage}:${h.round}`),
    ["implement:0", "verify:0", "fix:1", "verify:1", "review:1", "fix:2", "verify:2", "review:2"]
  );
  assert.equal(JSON.parse(cli(project, ["validate", "--json"]).stdout).valid, true);
});

test("coding loop stops bounded after maxFixRounds when deterministic verify keeps failing", (t) => {
  const { project, events } = setupLoopProject(t, { maxFixRounds: 1, alwaysFail: true });
  const blocked = JSON.parse(cli(project, ["loop", "run", "--config", "local-runtime/loop.json", "--json"], 1).stdout);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "verify_failed_max_rounds");
  assert.equal(blocked.roundsUsed, 1);
  assert.equal(blocked.implementAttempts, 2);
  assert.match(blocked.checkpointId, /^CHKPT-/);

  // Reviewer must never run while deterministic verify is red.
  assert.deepEqual(events().map((e) => e.role), ["implementer", "implementer"]);
  const task = JSON.parse(cli(project, ["task", "show", "--task", "TASK-0001", "--json"]).stdout);
  assert.equal(task.record.status, "blocked");
});

test("coding loop rejects reviewer approve verdict when any policy_check fails (fail-closed)", (t) => {
  const { project } = setupLoopProject(t, { maxFixRounds: 1, policyFailFirst: true });
  const res = JSON.parse(cli(project, ["loop", "run", "--config", "local-runtime/loop.json", "--json"]).stdout);
  assert.equal(res.status, "completed");
  assert.equal(res.roundsUsed, 1);
  assert.equal(res.implementAttempts, 2);
  assert.deepEqual(res.review.policy_checks, [{ rule: "Respect scope_out", passed: true }]);
});
