import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { parseYaml } from "../core/yaml-subset.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const BOOTSTRAP_CLI = path.join(HARNESS_DIR, "scripts", "bootstrap-project.mjs");

function readAllFilesMap(rootDir) {
  const map = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        map.set(path.relative(rootDir, full).replace(/\\/g, "/"), fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(rootDir);
  return map;
}

test("bootstrap creates deterministic base project, supports --git, and rejects overwrite", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-boot-"));
  try {
    const destA = path.join(tmp, "det-a");
    const destB = path.join(tmp, "det-b");
    const fixedTs = "2026-05-01T12:00:00.000Z";

    const resA = bootstrapProject({
      name: "Deterministic App",
      owner: "Test Owner",
      dest: destA,
      createdAt: fixedTs,
    });
    const resB = bootstrapProject({
      name: "Deterministic App",
      owner: "Test Owner",
      dest: destB,
      createdAt: fixedTs,
    });

    assert.equal(resA.validation.valid, true);
    assert.equal(resA.gitInitialized, false);
    assert.equal(fs.existsSync(path.join(destA, ".git")), false);
    assert.deepEqual(readAllFilesMap(destA), readAllFilesMap(destB), "Output must be deterministic");

    // Existing directory rejection must preserve existing contents.
    const sentinel = "# DO NOT OVERWRITE\n";
    fs.writeFileSync(path.join(destA, "README.md"), sentinel, "utf8");
    assert.throws(() => bootstrapProject({ name: "Deterministic App", dest: destA }), /Refusing to overwrite/i);
    assert.equal(fs.readFileSync(path.join(destA, "README.md"), "utf8"), sentinel);

    // Optional --git initializes local repo cleanly.
    const destGit = path.join(tmp, "git-app");
    const resGit = bootstrapProject({ name: "Git Enabled App", dest: destGit, git: true });
    assert.equal(resGit.gitInitialized, true);
    assert.equal(fs.existsSync(path.join(destGit, ".git")), true);
    const manifest = parseYaml(fs.readFileSync(path.join(destGit, "brain", "manifest.yaml"), "utf8"));
    assert.equal(manifest.repository.initialized, true);
    assert.equal(execFileSync("git", ["-C", destGit, "branch", "--show-current"], { encoding: "utf8" }).trim(), "main");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("bootstrap dry-run writes nothing and partial failure rolls back cleanly", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tx-"));
  try {
    const dryDest = path.join(tmp, "dry-target");
    const cliDry = spawnSync(
      process.execPath,
      [BOOTSTRAP_CLI, "--name", "Dry Run App", "--profile", "web", "--dest", dryDest, "--dry-run"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(cliDry.status, 0, cliDry.stderr);
    assert.equal(fs.existsSync(dryDest), false);

    // Partial failure simulation before atomic commit must leave neither dest nor stage dir.
    const nestedParent = path.join(tmp, "new-parent");
    const failDest = path.join(nestedParent, "failed-project");
    assert.throws(
      () =>
        bootstrapProject({
          name: "Rollback Test App",
          dest: failDest,
          onBeforeCommit: (stageDir) => {
            assert.equal(fs.existsSync(stageDir), true);
            throw new Error("Simulated mid-bootstrap failure");
          },
        }),
      /Simulated mid-bootstrap failure/
    );
    assert.equal(fs.existsSync(failDest), false, "Failed destination must not exist");
    assert.equal(fs.existsSync(nestedParent), false, "Empty newly created parent must roll back cleanly");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("bootstrap supports spaces/Unicode, optional profiles, and rejects invalid names/traversal", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-prof-"));
  try {
    const unicodeDest = path.join(tmp, "Temp Space Dir", "Café Project 2026");
    const res = bootstrapProject({
      name: "Café App 2026",
      profile: "automation",
      dest: unicodeDest,
    });
    assert.equal(res.slug, "cafe-app-2026");
    assert.equal(res.profile, "automation");
    assert.equal(fs.existsSync(path.join(unicodeDest, "brain", "profile.md")), true);
    const ignoreText = fs.readFileSync(path.join(unicodeDest, ".gitignore"), "utf8");
    assert.match(ignoreText, /Profile additions \(automation/);
    assert.equal(validateProject(unicodeDest).valid, true);

    for (const badName of ["CON", "ab", "bad/name", "bad:name", "bad..name", "trailing."]) {
      assert.throws(() => bootstrapProject({ name: badName, dest: path.join(tmp, "x") }));
    }
    for (const badDest of [`${tmp}/../escape`, `${tmp}\\..\\escape`, `${tmp}/foo/../bar`]) {
      assert.throws(() => bootstrapProject({ name: "Valid Name", dest: badDest }));
    }
    assert.throws(() => bootstrapProject({ name: "Valid Name", profile: "nonexistent", dest: path.join(tmp, "p1") }));
    assert.throws(() => bootstrapProject({ name: "Valid Name", profile: "../web", dest: path.join(tmp, "p2") }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
