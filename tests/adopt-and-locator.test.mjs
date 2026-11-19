import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { adoptProject } from "../core/adopt-project.mjs";
import { resolveProjectDir } from "../core/project-locator.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { getProjectStatus } from "../core/project-status.mjs";

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
      const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      out.set(rel, hash);
    }
  }
  return out;
}

function initRepoWithBaseline(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
  }
  execFileSync("git", ["init", "-b", "main", dir], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Adopt Tester"], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "adopt@example.invalid"], {
    windowsHide: true,
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "add", "-A"], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "Baseline existing repo"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

test("adoptProject safely onboards dirty & clean existing Git repos without altering pre-existing files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-adopt-git-"));
  try {
    const repoDir = path.join(tmp, "payments-service");
    initRepoWithBaseline(repoDir, {
      "package.json": JSON.stringify({ name: "@acme/payments-api", version: "1.0.0" }, null, 2),
      "README.md": "# Payments Service\n\nLegacy Windows docs path C:\\Tools\\pay.exe stays untouched.\n",
      ".gitignore": "node_modules/\ndist/\n",
      "src/ledger.js": "export function totalCents(items) { return items.reduce((a, b) => a + b, 0); }\n",
      "tests/ledger.test.js": "console.log('ok');\n",
      "AGENTS.md": "# Custom Existing Team Guide\nDo not overwrite me.\n",
    });

    // Make the repo dirty with both modified and untracked files before adoption
    fs.appendFileSync(path.join(repoDir, "src", "ledger.js"), "// pending dirty edit\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "notes-untracked.txt"), "work in progress\n", "utf8");

    const beforeHashes = snapshotHashes(repoDir);
    const beforeHead = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();

    // Dry run must write zero files
    const dry = adoptProject({ dest: repoDir, profile: "web", dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(path.join(repoDir, "brain")), false);
    assert.deepEqual(snapshotHashes(repoDir), beforeHashes);

    // Passing --with-agent-guides must refuse collision without creating partial brain/ files
    assert.throws(
      () => adoptProject({ dest: repoDir, withAgentGuides: true }),
      /Refusing to overwrite existing file during adoption: AGENTS\.md/
    );
    assert.equal(fs.existsSync(path.join(repoDir, "brain")), false);

    // Default adopt adds Second Brain without touching AGENTS.md or existing files
    const res = adoptProject({ dest: repoDir, profile: "web", owner: "Core Team" });
    assert.equal(res.dryRun, false);
    assert.equal(res.projectName, "payments-api");
    assert.equal(res.gitDetected, true);
    assert.equal(res.defaultBranch, "main");
    assert.equal(res.validation.valid, true, res.validation.errors.join("; "));
    assert.ok(res.detectedStack.some((h) => h.marker === "package.json"));

    // Verify 100% of pre-existing files kept byte-identical SHA-256 and Git HEAD unchanged
    const afterHashes = snapshotHashes(repoDir);
    for (const [rel, hash] of beforeHashes.entries()) {
      assert.equal(afterHashes.get(rel), hash, `Pre-existing file modified: ${rel}`);
    }
    const afterHead = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    assert.equal(afterHead, beforeHead);

    // Refuses duplicate adoption cleanly
    assert.throws(() => adoptProject({ dest: repoDir }), /already contains a GeloForge Second Brain/);

    // Verify validate, status, and context work cleanly from nested subdir without --project
    const nestedCwd = path.join(repoDir, "src");
    const cliVal = spawnSync(process.execPath, [CLI_PATH, "validate", "--json"], {
      cwd: nestedCwd,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliVal.status, 0, cliVal.stderr);
    assert.equal(JSON.parse(cliVal.stdout).valid, true);

    const cliStatus = spawnSync(process.execPath, [CLI_PATH, "status", "--json"], {
      cwd: nestedCwd,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    const parsedStatus = JSON.parse(cliStatus.stdout);
    assert.equal(parsedStatus.valid, true);
    assert.ok(parsedStatus.vcs.dirtyCount >= 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("adoptProject handles Go/Python repos with custom paths, .venv symlinks, and missing src/", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-adopt-poly-"));
  try {
    const pyRepo = path.join(tmp, "py-tool");
    fs.mkdirSync(path.join(pyRepo, "app"), { recursive: true });
    fs.mkdirSync(path.join(pyRepo, ".venv", "bin"), { recursive: true });
    fs.writeFileSync(path.join(pyRepo, "pyproject.toml"), '[project]\nname = "log-analyzer"\n', "utf8");
    fs.writeFileSync(path.join(pyRepo, "app", "cli.py"), "def run():\n    return True\n", "utf8");
    fs.writeFileSync(path.join(pyRepo, "README.md"), "# log-analyzer\nDocs for C:\\Python312\\python.exe\n", "utf8");

    // Simulate a symlink inside .venv which must NOT break GeloForge validation
    const venvTarget = path.join(tmp, "system-python-dir");
    fs.mkdirSync(venvTarget, { recursive: true });
    fs.writeFileSync(path.join(venvTarget, "README.md"), "# External pkg with broken [link](./missing.md)\n", "utf8");
    fs.symlinkSync(
      venvTarget,
      path.join(pyRepo, ".venv", "bin", "python-dir"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const res = adoptProject({
      dest: pyRepo,
      tasksDir: "ops-tasks",
      evidenceDir: "ops-evidence",
    });
    assert.equal(res.projectName, "log-analyzer");
    assert.equal(res.validation.valid, true, res.validation.errors.join("; "));
    assert.equal(validateProject(pyRepo).valid, true);
    assert.equal(getProjectStatus(pyRepo).valid, true);

    const ctx = compileContext({ projectDir: pyRepo, query: "log analyzer", profile: "working" });
    assert.ok(ctx.markdown.includes("Auto-Detected Stack Hints (A6 Draft"));
    assert.ok(ctx.markdown.includes("pyproject.toml"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("adoptProject partial failure rollback removes ONLY newly created files/dirs and rejects collisions/symlinks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-adopt-rb-"));
  try {
    const existing = path.join(tmp, "app-repo");
    fs.mkdirSync(path.join(existing, "src"), { recursive: true });
    fs.mkdirSync(path.join(existing, "brain", "notes"), { recursive: true });
    fs.writeFileSync(path.join(existing, "src", "index.js"), "export const x = 1;\n", "utf8");
    fs.writeFileSync(path.join(existing, "brain", "notes", "keep.md"), "# Keep pre-existing note\n", "utf8");
    const beforeHashes = snapshotHashes(existing);

    assert.throws(
      () =>
        adoptProject({
          dest: existing,
          onBeforeCommit: ({ destDir }) => {
            assert.equal(fs.existsSync(path.join(destDir, "brain", "manifest.yaml")), true);
            throw new Error("Simulated mid-adoption failure");
          },
        }),
      /Simulated mid-adoption failure/
    );

    // Pre-existing files/dirs inside app-repo/ and brain/notes/ remain intact; newly added files are rolled back
    assert.deepEqual(snapshotHashes(existing), beforeHashes);
    assert.equal(fs.existsSync(path.join(existing, "brain", "manifest.yaml")), false);
    assert.equal(fs.existsSync(path.join(existing, "brain", "state")), false);
    assert.equal(fs.existsSync(path.join(existing, "tasks")), false);
    assert.equal(fs.existsSync(path.join(existing, "brain", "notes", "keep.md")), true);

    // Symlink target rejection
    const symDest = path.join(tmp, "sym-repo");
    fs.symlinkSync(existing, symDest, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => adoptProject({ dest: symDest }), /non-symlink directory/i);

    // Traversal rejection
    assert.throws(() => adoptProject({ dest: `${existing}/../app-repo` }), /traversal/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("resolveProjectDir searches upward to Git root, rejects symlinks, and never selects harness repo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-locate-"));
  try {
    const outer = path.join(tmp, "outer-with-manifest");
    fs.mkdirSync(path.join(outer, "brain"), { recursive: true });
    fs.writeFileSync(path.join(outer, "brain", "manifest.yaml"), "name: outer\n", "utf8");

    const innerGit = path.join(outer, "inner-git-without-geloforge");
    const deepSub = path.join(innerGit, "packages", "web");
    fs.mkdirSync(path.join(innerGit, ".git"), { recursive: true });
    fs.mkdirSync(deepSub, { recursive: true });

    // Upward discovery from inner Git repo MUST stop at innerGit's .git boundary and not leak into outer!
    assert.throws(() => resolveProjectDir({ cwd: deepSub, harnessDir: HARNESS_DIR }), /Run "geloforge adopt"/);

    // Now adopt innerGit and resolve from nested directory
    fs.rmSync(path.join(innerGit, ".git"), { recursive: true, force: true });
    initRepoWithBaseline(innerGit, {
      "packages/web/app.js": "export const ok = true;\n",
      "README.md": "# Inner\n",
    });
    adoptProject({ dest: innerGit, name: "Inner Web" });

    const located = resolveProjectDir({ cwd: deepSub, harnessDir: HARNESS_DIR });
    assert.equal(located.discoveredFromCwd, true);
    assert.equal(located.projectDir, path.resolve(innerGit));

    // Explicit --project always overrides CWD discovery
    const override = resolveProjectDir({ project: outer, cwd: deepSub, harnessDir: HARNESS_DIR });
    assert.equal(override.discoveredFromCwd, false);
    assert.equal(override.projectDir, path.resolve(outer));

    // Harness repo itself is never auto-selected
    assert.throws(() => resolveProjectDir({ cwd: HARNESS_DIR, harnessDir: HARNESS_DIR }), /No GeloForge project/);

    // Symlink CWD escape rejected
    const symSub = path.join(tmp, "sym-sub");
    fs.symlinkSync(deepSub, symSub, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => resolveProjectDir({ cwd: symSub, harnessDir: HARNESS_DIR }), /symbolic link/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
