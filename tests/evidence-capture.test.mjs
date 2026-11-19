import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adoptProject } from "../core/adopt-project.mjs";
import { createTask } from "../core/task-manager.mjs";
import { captureEvidence } from "../core/evidence-capture.mjs";
import { createHandoff, inspectHandoff } from "../core/handoff.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { parseYaml } from "../core/yaml-subset.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");

function snapshotHashes(rootDir, curDir = rootDir, out = new Map()) {
  for (const entry of fs.readdirSync(curDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(curDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      snapshotHashes(rootDir, full, out);
    } else if (entry.isFile()) {
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");
      out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
    }
  }
  return out;
}

test("captureEvidence accurately distinguishes exit-0, failures, timeouts, missing binaries, and redacts secrets", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-evid-"));
  try {
    const repoDir = path.join(tmp, "api-repo");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "index.mjs"), "export const ok = true;\n", "utf8");
    adoptProject({ dest: repoDir, name: "API Evidence App", evidenceDir: "ops-evidence" });
    createTask({ projectDir: repoDir, title: "Verify API unit checks", activate: true });

    // Dry run does not execute command or allocate written files
    const dryFlagFile = path.join(repoDir, "should-not-exist.txt");
    const dry = captureEvidence({
      projectDir: repoDir,
      taskId: "TASK-0001",
      name: "Dry check",
      dryRun: true,
      commandArgv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(dryFlagFile)}, 'ran')`],
    });
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(dryFlagFile), false);
    assert.equal(fs.existsSync(dry.filePath), false);

    // 1. Passing command -> verified evidence + linked to TASK-0001 + honest limitations
    const passRes = captureEvidence({
      projectDir: repoDir,
      taskId: "TASK-0001",
      name: "Smoke test",
      commandArgv: [process.execPath, "-e", "console.log('1 passed in 2ms')"],
    });
    assert.equal(passRes.verified, true);
    assert.equal(passRes.status, "verified");
    assert.equal(passRes.checkResult, "passed");
    assert.equal(passRes.relPath.startsWith("ops-evidence/EVID-0001-"), true);
    assert.ok(passRes.record.limitations.some((l) => /Exit code 0 proves command execution succeeded/i.test(l)));

    const stateAfterPass = parseYaml(fs.readFileSync(path.join(repoDir, "brain", "state", "current.yaml"), "utf8"));
    assert.equal(stateAfterPass.last_verified_evidence, "EVID-0001");

    // 2. Failing command via CLI (must exit 1, write draft EVID-0002, preserve last_verified_evidence = EVID-0001)
    const cliFail = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "evidence",
        "capture",
        "--task",
        "TASK-0001",
        "--name",
        "Failing suite",
        "--json",
        "--",
        process.execPath,
        "-e",
        "console.error('AssertionError: expected 2'); process.exit(2);",
      ],
      { cwd: repoDir, encoding: "utf8", windowsHide: true }
    );
    assert.equal(cliFail.status, 1);
    const failObj = JSON.parse(cliFail.stdout);
    assert.equal(failObj.id, "EVID-0002");
    assert.equal(failObj.verified, false);
    assert.equal(failObj.status, "draft");
    assert.equal(failObj.checkResult, "failed");
    assert.equal(failObj.record.verified_by, null);

    const stateAfterFail = parseYaml(fs.readFileSync(path.join(repoDir, "brain", "state", "current.yaml"), "utf8"));
    assert.equal(stateAfterFail.last_verified_evidence, "EVID-0001");

    // Handoff must include EVID-0001 in verified_evidence and reject EVID-0002 from verified_evidence
    const hf = createHandoff({ projectDir: repoDir, taskId: "TASK-0001" });
    assert.deepEqual(hf.record.verified_evidence.map((v) => v.id), ["EVID-0001"]);
    assert.ok(hf.warnings.some((w) => /EVID-0002.*not verified/i.test(w)));

    // 3. Timeout command -> blocked draft
    const timeoutRes = captureEvidence({
      projectDir: repoDir,
      taskId: "TASK-0001",
      name: "Timeout check",
      timeoutMs: 120,
      linkTask: false,
      commandArgv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
    });
    assert.equal(timeoutRes.timedOut, true);
    assert.equal(timeoutRes.verified, false);
    assert.equal(timeoutRes.status, "draft");
    assert.equal(timeoutRes.checkResult, "blocked");
    assert.match(timeoutRes.record.checks[0].summary, /timed out/i);

    // 4. Nonexistent executable -> blocked draft
    const missingExeRes = captureEvidence({
      projectDir: repoDir,
      taskId: "TASK-0001",
      name: "Missing exe",
      linkTask: false,
      commandArgv: ["nonexistent-binary-gf-xyz-9999"],
    });
    assert.equal(missingExeRes.verified, false);
    assert.equal(missingExeRes.status, "draft");
    assert.equal(missingExeRes.checkResult, "blocked");

    // 5. Secret redaction across stdout, stderr, and command arguments (secrets constructed dynamically)
    const fakeAws = "AKIA" + "1234567890ABCDEF";
    const fakeGhp = "ghp_" + "a".repeat(36);
    const pemHeader = "-----BEGIN " + "PRIVATE KEY-----";
    const secScript = `console.log("aws=" + "${fakeAws}"); console.error("API_KEY=topsecretval token=${fakeGhp} ${pemHeader}\\nSECRET_BODY");`;
    const secRes = captureEvidence({
      projectDir: repoDir,
      taskId: "TASK-0001",
      name: "Secret redaction check",
      linkTask: false,
      commandArgv: [process.execPath, "-e", secScript],
    });
    const savedYaml = fs.readFileSync(secRes.filePath, "utf8");
    assert.equal(savedYaml.includes(fakeAws), false);
    assert.equal(savedYaml.includes(fakeGhp), false);
    assert.equal(savedYaml.includes("topsecretval"), false);
    assert.equal(savedYaml.includes(pemHeader), false);
    assert.match(savedYaml, /\[REDACTED_SECRET\]/);

    // 6. Verify shell metacharacters are NOT executed via shell: false
    const shellInjectionFile = path.join(repoDir, "pwned.txt");
    const noShell = captureEvidence({
      projectDir: repoDir,
      taskId: "TASK-0001",
      name: "Argv literal check",
      linkTask: false,
      commandArgv: [process.execPath, "-e", "console.log(process.argv[1])", `ok && echo pwn > ${shellInjectionFile}`],
    });
    assert.equal(noShell.verified, true);
    assert.equal(fs.existsSync(shellInjectionFile), false);

    assert.equal(validateProject(repoDir).valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("end-to-end onboarding journey: adopt -> task new -> evidence capture -> context --map -> handoff -> validate", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-e2e-v04-"));
  try {
    const repoDir = path.join(tmp, "math-lib");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "math-lib", version: "1.0.0", type: "module" }, null, 2));
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Math Lib\n\nTiny arithmetic helpers.\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "src", "calc.mjs"), "export function add(a, b) { return a + b; }\nexport function multiply(a, b) { return a * b; }\n", "utf8");
    fs.writeFileSync(
      path.join(repoDir, "tests", "calc.test.mjs"),
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add, multiply } from "../src/calc.mjs";\ntest("calc works", () => { assert.equal(add(2, 3), 5); assert.equal(multiply(2, 3), 6); });\n',
      "utf8"
    );

    execFileSync("git", ["init", "-b", "main", repoDir], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "E2E Dev"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "e2e@example.invalid"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "add", "-A"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", repoDir, "commit", "-m", "Initial math-lib"], { windowsHide: true, stdio: "ignore" });

    // Simulate active dirty edit before onboarding
    fs.appendFileSync(path.join(repoDir, "src", "calc.mjs"), "export function subtract(a, b) { return a - b; }\n", "utf8");
    const preHashes = snapshotHashes(repoDir);

    const run = (args, cwd = path.join(repoDir, "src")) =>
      spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, encoding: "utf8", windowsHide: true });

    // 1. adopt from repo root
    const adoptRes = run(["adopt", "--json"], repoDir);
    assert.equal(adoptRes.status, 0, adoptRes.stderr);
    for (const [rel, h] of preHashes.entries()) {
      assert.equal(snapshotHashes(repoDir).get(rel), h, `Modified pre-existing file: ${rel}`);
    }

    // 2. task new from nested CWD without --project
    const taskRes = run(["task", "new", "--title", "Verify arithmetic helpers", "--input", "src/calc.mjs", "--activate", "--json"]);
    assert.equal(taskRes.status, 0, taskRes.stderr);
    const taskObj = JSON.parse(taskRes.stdout);
    assert.equal(taskObj.id, "TASK-0001");

    // 3. evidence capture running real node --test with command flags after "--"
    const evidRes = run([
      "evidence",
      "capture",
      "--task",
      "TASK-0001",
      "--name",
      "Math unit test suite",
      "--json",
      "--",
      process.execPath,
      "--test",
      "tests/calc.test.mjs",
    ]);
    assert.equal(evidRes.status, 0, evidRes.stderr);
    const evidObj = JSON.parse(evidRes.stdout);
    assert.equal(evidObj.id, "EVID-0001");
    assert.equal(evidObj.verified, true);
    assert.equal(evidObj.status, "verified");

    // 4. context --map from nested CWD
    const ctxRes = run(["context", "--task", "TASK-0001", "--map", "--json"]);
    assert.equal(ctxRes.status, 0, ctxRes.stderr);
    const ctxObj = JSON.parse(ctxRes.stdout);
    const incPaths = new Set(ctxObj.manifest.included_documents.map((d) => d.path));
    assert.equal(incPaths.has("tasks/TASK-0001-verify-arithmetic-helpers.yaml"), true);
    assert.equal(incPaths.has(evidObj.relPath), true);
    assert.ok(ctxObj.markdown.includes("subtract"));

    // 5. handoff + inspect + validate from nested CWD
    const hfRes = run([
      "handoff",
      "--task",
      "TASK-0001",
      "--from-role",
      "developer",
      "--to-role",
      "qa-security-reviewer",
      "--from-tool",
      "codex",
      "--to-tool",
      "gemini-cli",
      "--claim",
      "Manual fuzzing looks good",
      "--json",
    ]);
    assert.equal(hfRes.status, 0, hfRes.stderr);
    const hfObj = JSON.parse(hfRes.stdout);
    assert.deepEqual(hfObj.record.verified_evidence.map((v) => v.id), ["EVID-0001"]);
    assert.deepEqual(hfObj.record.unverified_claims, ["Manual fuzzing looks good"]);

    const insp = inspectHandoff({ projectDir: repoDir, handoffPath: hfObj.relPath });
    assert.equal(insp.valid, true, insp.errors.join("; "));

    const valRes = run(["validate", "--json"]);
    assert.equal(valRes.status, 0, valRes.stderr);
    assert.equal(JSON.parse(valRes.stdout).valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
