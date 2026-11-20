import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";

const CLI = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));

function makeProject(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-verify-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const project = path.join(temp, "verification trial");
  bootstrapProject({ name: "Verification Trial", dest: project });
  return project;
}

function cli(cwd, args, expectedStatus = 0) {
  const out = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 20_000 });
  assert.equal(out.error, undefined);
  assert.equal(out.status, expectedStatus, out.stderr || out.stdout);
  return out;
}

test("verify preserves a failed attempt and finishes a retried task with fresh evidence and a checkpoint", (t) => {
  const root = makeProject(t);
  cli(root, ["task", "new", "--title", "Check project", "--activate"]);
  const preview = JSON.parse(cli(root, [
    "verify", "--dry-run", "--json", "--", process.execPath, "-e", "throw new Error('should not run')",
  ]).stdout);
  assert.equal(preview.status, "dry_run");
  assert.equal(fs.existsSync(path.join(root, "evidence")), false);

  const failed = JSON.parse(cli(root, [
    "verify", "--json", "--", process.execPath, "-e", "process.exit(7)",
  ], 1).stdout);
  assert.equal(failed.status, "check_failed");
  assert.equal(failed.evidence.id, "EVID-0001");
  assert.equal(failed.evidence.exitCode, 7);
  assert.equal(failed.evidence.status, "draft");
  assert.equal(failed.evidence.linkedToTask, false);
  assert.ok(fs.existsSync(path.join(root, failed.evidence.relPath)));
  assert.equal(failed.checkpoint, null);
  const open = JSON.parse(cli(root, ["task", "show", "TASK-0001", "--json"]).stdout);
  assert.equal(open.record.status, "active");

  const passed = JSON.parse(cli(path.join(root, "src"), [
    "verify", "--json", "--", process.execPath, "-e",
    "if (process.argv[1] !== 'two words' || process.argv[2] !== '--check') process.exit(8)",
    "--", "two words", "--check",
  ]).stdout);
  assert.equal(passed.status, "completed");
  assert.equal(passed.evidence.id, "EVID-0002");
  assert.equal(passed.checkpoint.record.verification_evidence_ref, "EVID-0002");
  assert.deepEqual(passed.completion.record.evidence_refs, ["EVID-0002"]);
  assert.equal(passed.completion.verificationStatus, "verified");
  assert.equal(JSON.parse(cli(root, ["validate", "--json"]).stdout).valid, true);
});

test("verify requires an exact task when several are active and runs the check outside the project lock", (t) => {
  const root = makeProject(t);
  cli(root, ["task", "new", "--title", "First task", "--activate"]);
  cli(root, ["task", "new", "--title", "Second task", "--activate"]);
  const ambiguous = cli(root, ["verify", "--", process.execPath, "--version"], 1);
  assert.match(ambiguous.stderr, /Pass --task TASK-NNNN/);

  const passed = JSON.parse(cli(root, [
    "verify", "--task", "TASK-0001", "--json", "--", process.execPath, CLI,
    "task", "new", "--title", "Created by the command", "--activate",
  ]).stdout);
  assert.equal(passed.status, "completed");
  assert.deepEqual(passed.completion.activeTasks, ["TASK-0002", "TASK-0003"]);
  const finished = cli(root, ["verify", "--task", "TASK-0001", "--", process.execPath, "--version"], 1);
  assert.match(finished.stderr, /TASK-0001 is completed/);
});
