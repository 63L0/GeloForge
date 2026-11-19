import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: HARNESS_DIR,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("geloforge CLI handles help, version, and unknown command errors cleanly", () => {
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /init/);
  assert.match(help.stdout, /validate/);
  assert.match(help.stdout, /context/);
  assert.match(help.stdout, /status/);

  const ver = runCli(["--version"]);
  assert.equal(ver.status, 0);
  assert.equal(ver.stdout.trim(), fs.readFileSync(path.join(HARNESS_DIR, "VERSION"), "utf8").trim());

  const badCmd = runCli(["nonexistent"]);
  assert.equal(badCmd.status, 1);
  assert.match(badCmd.stderr, /Unknown command/);
});

test("geloforge init, validate, status, and context work end-to-end via CLI", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-cli-"));
  try {
    const dryDest = path.join(tmp, "dry-proj");
    const dryRes = runCli(["init", "--name", "CLI Dry App", "--profile", "web", "--dest", dryDest, "--dry-run", "--json"]);
    assert.equal(dryRes.status, 0, dryRes.stderr);
    assert.equal(JSON.parse(dryRes.stdout).dryRun, true);
    assert.equal(fs.existsSync(dryDest), false);

    // Non-git project lifecycle
    const nonGitDest = path.join(tmp, "nongit-app");
    const initNoGit = runCli(["init", "--name", "CLI NonGit App", "--profile", "desktop", "--dest", nonGitDest, "--json"]);
    assert.equal(initNoGit.status, 0, initNoGit.stderr);
    assert.equal(JSON.parse(initNoGit.stdout).gitInitialized, false);

    const statusNoGit = runCli(["status", "--project", nonGitDest, "--json"]);
    assert.equal(statusNoGit.status, 0, statusNoGit.stderr);
    const statusObj1 = JSON.parse(statusNoGit.stdout);
    assert.equal(statusObj1.valid, true);
    assert.equal(statusObj1.vcs.available, false);
    assert.equal(statusObj1.project.profile, "desktop");

    // Git-enabled project lifecycle
    const gitDest = path.join(tmp, "git-app");
    const initGit = runCli(["init", "--name", "CLI Git App", "--profile", "web", "--dest", gitDest, "--git", "--json"]);
    assert.equal(initGit.status, 0, initGit.stderr);

    const valPass = runCli(["validate", "--project", gitDest, "--json"]);
    assert.equal(valPass.status, 0, valPass.stderr);
    assert.equal(JSON.parse(valPass.stdout).valid, true);

    const statusGit = runCli(["status", "--project", gitDest, "--json"]);
    assert.equal(statusGit.status, 0, statusGit.stderr);
    const statusObj2 = JSON.parse(statusGit.stdout);
    assert.equal(statusObj2.vcs.available, true);
    assert.equal(statusObj2.vcs.branch, "main");
    assert.equal(statusObj2.vcs.head, "unborn");

    // Context compilation to stdout JSON & atomic --out file
    const ctxJson = runCli(["context", "--project", gitDest, "--query", "routing", "--profile", "working", "--json"]);
    assert.equal(ctxJson.status, 0, ctxJson.stderr);
    const ctxParsed = JSON.parse(ctxJson.stdout);
    assert.equal(ctxParsed.manifest.project_id, "proj-cli-git-app");

    const outFile = path.join(tmp, "outputs", "packet.md");
    const ctxOut = runCli(["context", "--project", gitDest, "--query", "routing", "--out", outFile]);
    assert.equal(ctxOut.status, 0, ctxOut.stderr);
    assert.equal(fs.existsSync(outFile), true);
    assert.match(fs.readFileSync(outFile, "utf8"), /# GeloForge Compiled Context Packet/);

    // Unsafe --out path inside harness repo or traversal must fail with exit 1
    const badOut1 = runCli(["context", "--project", gitDest, "--query", "routing", "--out", path.join(HARNESS_DIR, "illegal.md")]);
    assert.equal(badOut1.status, 1);
    assert.equal(fs.existsSync(path.join(HARNESS_DIR, "illegal.md")), false);

    const badOut2 = runCli(["context", "--project", gitDest, "--query", "routing", "--out", `${tmp}/../illegal.md`]);
    assert.equal(badOut2.status, 1);

    // Broken project fails validate with exit 1
    fs.unlinkSync(path.join(gitDest, "brain", "INDEX.md"));
    const valFail = runCli(["validate", "--project", gitDest, "--json"]);
    assert.equal(valFail.status, 1);
    assert.equal(JSON.parse(valFail.stdout).valid, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
