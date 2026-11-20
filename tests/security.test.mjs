import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject, renderSinglePass } from "../scripts/bootstrap-project.mjs";
import { assertNoSymlinkInTree, assertSafeWithinRoot, validateDestinationPath } from "../core/path-safety.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(HARNESS_DIR, "..");

test("unsafe paths, protected harness directories, and unrelated file preservation hold", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sec-"));
  try {
    const siblingFile = path.join(tmp, "unrelated-notes.txt");
    fs.writeFileSync(siblingFile, "preserve me\n", "utf8");

    const parsedRoot = path.parse(tmp).root;
    for (const unsafeDest of [
      parsedRoot,
      path.join(HARNESS_DIR, "nested-evil"),
      path.join(WORKSPACE_ROOT, "local-runtime", "nested-evil"),
      path.join(WORKSPACE_ROOT, "worktrees", "nested-evil"),
      WORKSPACE_ROOT,
      path.join(WORKSPACE_ROOT, "projects"),
      "\\\\evil-server\\share\\proj",
      path.join(tmp, "trailing-dot."),
    ]) {
      assert.throws(() => validateDestinationPath(unsafeDest, { harnessDir: HARNESS_DIR, workspaceRoot: WORKSPACE_ROOT }));
    }

    assert.throws(() =>
      bootstrapProject({ name: "Evil Target", dest: path.join(HARNESS_DIR, "should-never-exist") })
    );
    assert.equal(fs.existsSync(path.join(HARNESS_DIR, "should-never-exist")), false);
    assert.equal(fs.readFileSync(siblingFile, "utf8"), "preserve me\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("symbolic links and NTFS junctions in destination ancestors or templates are rejected", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sym-"));
  try {
    const realTarget = path.join(tmp, "real-target");
    const junctionLink = path.join(tmp, "junction-to-harness");
    fs.mkdirSync(realTarget);

    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(HARNESS_DIR, junctionLink, linkType);
    assert.throws(() => assertSafeWithinRoot(tmp, "junction-to-harness/escaped-child"), /symbolic links/i);

    assert.throws(
      () =>
        validateDestinationPath(path.join(junctionLink, "escaped-child"), {
          harnessDir: HARNESS_DIR,
          workspaceRoot: WORKSPACE_ROOT,
        }),
      /symbolic link or junction/i
    );

    const templateClone = path.join(tmp, "fake-template");
    fs.mkdirSync(templateClone);
    const badSubLink = path.join(templateClone, "linked-dir");
    fs.symlinkSync(realTarget, badSubLink, linkType);
    assert.throws(() => assertNoSymlinkInTree(templateClone), /symbolic link \/ junction/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a project lock can disappear during the path safety lookup", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lock-stat-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
  const lock = path.join(tmp, ".geloforge", ".state.lock");
  fs.mkdirSync(path.dirname(lock));
  fs.writeFileSync(lock, "{}");
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, options) => {
    if (file === lock) fs.unlinkSync(lock);
    return lstat(file, options);
  });

  assert.equal(assertSafeWithinRoot(tmp, ".geloforge/.state.lock"), lock);
  assert.equal(fs.existsSync(lock), false);
});

test("single-pass placeholder rendering prevents double-interpolation and preserves custom braces", () => {
  const rendered = renderSinglePass(
    "desc={{PROJECT_DESCRIPTION}}; owner={{PROJECT_OWNER}}",
    { PROJECT_DESCRIPTION: "Inject {{PROJECT_OWNER}}", PROJECT_OWNER: "SecretOwner" },
    false,
    "test"
  );
  assert.equal(rendered, "desc=Inject {{PROJECT_OWNER}}; owner=SecretOwner");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tpl-"));
  try {
    const dest = path.join(tmp, "mustache-app");
    const res = bootstrapProject({
      name: "Mustache App",
      description: "Supports {{CUSTOM_MUSTACHE_VAR}} templates",
      dest,
    });
    assert.equal(res.validation.valid, true);
    const readme = fs.readFileSync(path.join(dest, "README.md"), "utf8");
    assert.equal(readme.includes("Supports {{CUSTOM_MUSTACHE_VAR}} templates"), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("gitignore excludes secret fixtures, tracked files contain no secrets, and core/scripts have zero network calls", () => {
  for (const ignoredSample of [".env", ".env.production", "private.pem", "signing.key", "local-runtime/trace.log"]) {
    const chk = spawnSync("git", ["-C", HARNESS_DIR, "check-ignore", "-q", ignoredSample], { windowsHide: true });
    assert.equal(chk.status, 0, `Expected .gitignore to ignore "${ignoredSample}"`);
  }

  const tracked = execFileSync("git", ["-C", HARNESS_DIR, "ls-files"], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const secretPatterns = [
    /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bghp_[A-Za-z0-9]{36}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bsk-[A-Za-z0-9]{20,}\b/,
  ];
  for (const rel of tracked) {
    assert.equal(/(^|\/)(\.env(\..*)?|.+\.(pem|key|p12|pfx))$/i.test(rel), false, `Secret file tracked: ${rel}`);
    const content = fs.readFileSync(path.join(HARNESS_DIR, rel), "utf8");
    for (const pat of secretPatterns) {
      assert.equal(pat.test(content), false, `Secret pattern matched in ${rel}`);
    }
  }

  // Verify zero network imports or fetch calls in core/*.mjs and scripts/*.mjs.
  for (const dir of ["core", "scripts"]) {
    for (const file of fs.readdirSync(path.join(HARNESS_DIR, dir))) {
      if (!file.endsWith(".mjs")) continue;
      const src = fs.readFileSync(path.join(HARNESS_DIR, dir, file), "utf8");
      assert.equal(/node:(http|https|http2|net|tls|dgram)/.test(src), false, `Network import in ${dir}/${file}`);
      assert.equal(/\bfetch\s*\(/.test(src), false, `fetch() call in ${dir}/${file}`);
    }
  }
});
