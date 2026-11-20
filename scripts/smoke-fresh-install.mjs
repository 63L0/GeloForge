#!/usr/bin/env node
/**
 * Fresh-checkout smoke test for the local GeloForge CLI.
 * Runs against disposable projects outside the repository: no paid APIs or remote calls.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "geloforge.mjs");

function cli(args, cwd = ROOT) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, "CLI process error: " + String(result.error));
  assert.equal(
    result.status,
    0,
    "CLI failed: geloforge " + args.join(" ") +
      "\nstdout:\n" + result.stdout + "\nstderr:\n" + result.stderr
  );
  return result.stdout.trim();
}

function cliJson(args, cwd = ROOT) {
  const output = cli([...args, "--json"], cwd);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("CLI did not return valid JSON: " + output.slice(0, 700));
  }
}

const expected = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const compat = JSON.parse(fs.readFileSync(path.join(ROOT, "core", "compatibility.json"), "utf8"));
assert.equal(expected, "0.5.0", "Release smoke only covers v0.5.0 candidate");
assert.equal(pkg.version, expected);
assert.equal(compat.harness_version, expected);
assert.equal(pkg.private, true, "GitHub source release must remain private to npm");
assert.equal(fs.existsSync(path.join(ROOT, "node_modules")), false,
  "Fresh-checkout smoke requires no third-party node_modules directory");

assert.equal(cli(["--version"]), expected);
assert.match(cli(["--help"]), /checkpoint|recommend|mcp/);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "geloforge-v050-smoke-"));
try {
  // Greenfield project: real Git-enabled scaffolding and the new v0.5 lifecycle.
  const newProject = path.join(scratch, "new-automation");
  const init = cliJson(["init", "--name", "Smoke Automation", "--profile", "automation",
    "--dest", newProject, "--git"]);
  assert.equal(init.projectId, "proj-smoke-automation");
  assert.equal(fs.existsSync(path.join(newProject, "brain", "manifest.yaml")), true);

  const status = cliJson(["status", "--project", newProject]);
  assert.equal(status.valid, true);
  assert.equal(status.project.profile, "automation");

  const task = cliJson(["task", "new", "--project", newProject,
    "--title", "Verify first local CLI run", "--activate"]);
  assert.equal(task.id, "TASK-0001");

  const recommendations = cliJson(["recommend", "--project", newProject]);
  assert.ok(Array.isArray(recommendations.recommendations));

  const context = cliJson(["context", "--project", newProject, "--task", task.id,
    "--profile", "quick", "--map"]);
  assert.equal(context.manifest.project_id, init.projectId);

  const evidence = cliJson(["evidence", "capture", "--project", newProject,
    "--task", task.id, "--name", "Installed Node runtime", "--",
    process.execPath, "--version"]);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.id, "EVID-0001");

  const completed = cliJson(["task", "done", "--project", newProject, "--task", task.id,
    "--require-evidence", "--evidence", evidence.id]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.verificationStatus, "verified");

  const cp = cliJson(["checkpoint", "create", "--project", newProject,
    "--summary", "Fresh local CLI smoke passed"]);
  assert.match(cp.checkpointId, /^CHKPT-\d{4}$/);
  const checkpoints = cliJson(["checkpoint", "list", "--project", newProject]);
  assert.ok(checkpoints.checkpoints.some((x) => x.id === cp.checkpointId));

  const finalValidation = cliJson(["validate", "--project", newProject]);
  assert.equal(finalValidation.valid, true,
    "Generated project with task/evidence/checkpoint must remain schema-valid");

  // Brownfield project: dry-run must leave existing code untouched.
  const existing = path.join(scratch, "existing-application");
  fs.mkdirSync(existing);
  const original = "console.log('original customer code');\n";
  fs.writeFileSync(path.join(existing, "app.js"), original, "utf8");
  fs.writeFileSync(path.join(existing, "README.md"), "# Existing application\n", "utf8");

  const preview = cliJson(["adopt", "--dest", existing, "--profile", "automation", "--dry-run"]);
  assert.equal(preview.dryRun, true);
  assert.equal(fs.existsSync(path.join(existing, "brain")), false);

  cliJson(["adopt", "--dest", existing, "--profile", "automation"]);
  assert.equal(fs.readFileSync(path.join(existing, "app.js"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(existing, "README.md"), "utf8"),
    "# Existing application\n");
  assert.equal(cliJson(["validate", "--project", existing]).valid, true);

  console.log("PASS: v" + expected +
    " fresh-checkout smoke (CLI, init, task, context, evidence, done, checkpoint, adopt, validate)");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}
