import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_RUNNER = path.join(HARNESS_DIR, "scripts", "run-evals.mjs");

test("regression eval runner executes all categories and supports --category filtering", () => {
  const full = spawnSync(process.execPath, [EVAL_RUNNER, "--json"], {
    cwd: HARNESS_DIR,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(full.error, undefined);
  assert.equal(full.status, 0, full.stderr || full.stdout);
  const summary = JSON.parse(full.stdout);
  assert.equal(summary.failed, 0);
  assert.equal(summary.passed, summary.total);
  assert.ok(summary.total >= 5);

  const filtered = spawnSync(process.execPath, [EVAL_RUNNER, "--category", "retrieval", "--json"], {
    cwd: HARNESS_DIR,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(filtered.error, undefined);
  assert.equal(filtered.status, 0, filtered.stderr || filtered.stdout);
  const sub = JSON.parse(filtered.stdout);
  assert.equal(sub.failed, 0);
  assert.ok(sub.total >= 1);
  assert.ok(sub.results.every((r) => r.category === "retrieval" && r.passed));

  const badCat = spawnSync(process.execPath, [EVAL_RUNNER, "--category", "unknown-cat"], {
    cwd: HARNESS_DIR,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(badCat.status, 1);
});
