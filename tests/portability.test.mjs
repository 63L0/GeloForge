import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { validateProject } from "../core/project-validator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");

function walkFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

export function hasLeakedUsernameInPath(content, username) {
  if (typeof username !== "string" || username.trim().length < 3) {
    return false;
  }
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`/(?:home|Users)/${escaped}(?=[/\\\\\\s"'\`]|$)`, "i"),
    new RegExp(`[A-Za-z]:[\\\\/]Users[\\\\/]${escaped}(?=[/\\\\\\s"'\`]|$)`, "i"),
    new RegExp(`~${escaped}(?=[/\\\\\\s"'\`]|$)`, "i"),
  ];
  return patterns.some((pat) => pat.test(content));
}

test("harness repository contains no hardcoded workspace paths, user home paths, or current OS username in paths", () => {
  const username = os.userInfo().username;
  const userHome = os.homedir();
  const files = walkFiles(HARNESS_DIR);

  for (const full of files) {
    const rel = path.relative(HARNESS_DIR, full).replace(/\\/g, "/");
    if (rel === "tests/portability.test.mjs") continue;
    const content = fs.readFileSync(full, "utf8");
    assert.equal(/C:[\\/]AI-Workspace/i.test(content), false, `Hardcoded C:\\AI-Workspace found in ${rel}`);
    assert.equal(/C:[\\/]Users[\\/]/i.test(content), false, `Hardcoded C:\\Users\\ path found in ${rel}`);
    assert.equal(content.includes(userHome), false, `Hardcoded homedir found in ${rel}`);
    assert.equal(
      hasLeakedUsernameInPath(content, username),
      false,
      `Current OS username "${username}" leaked in user path inside ${rel}`
    );
  }
});

test("path-contextual username detector ignores plain English words like 'runner' while catching user-path leaks", () => {
  assert.equal(hasLeakedUsernameInPath("Portable Node test runner discovery works.", "runner"), false);
  assert.equal(hasLeakedUsernameInPath("Built for /home/runner/work/repo", "runner"), true);
  assert.equal(hasLeakedUsernameInPath("Saved in C:\\Users\\runner\\repo", "runner"), true);
  assert.equal(hasLeakedUsernameInPath("macOS path /Users/runner/src/app.mjs", "runner"), true);
});

test("generated project stays fully valid after moving to a new path with spaces and Unicode", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-move-"));
  try {
    const initialDir = path.join(tmp, "origin", "portable-app");
    const movedDir = path.join(tmp, "destination", "moved project café");
    fs.mkdirSync(path.dirname(movedDir), { recursive: true });

    const bootRes = bootstrapProject({
      name: "Portable App",
      profile: "web",
      dest: initialDir,
      git: true,
    });
    assert.equal(bootRes.validation.valid, true);

    fs.renameSync(initialDir, movedDir);
    const postMove = validateProject(movedDir);
    assert.equal(postMove.valid, true, postMove.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
