import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("checkout demo resumes failed verification, detects scoped drift, and completes", () => {
  const cli = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [cli, "demo"], { encoding: "utf8" });
  assert.match(output, /Last check: .*failed/);
  assert.match(output, /checkout.mjs changed, checkout.test.mjs unchanged/);
  assert.match(output, /Warning: Handoff file changed: checkout.mjs/);
  assert.match(output, /TASK-0001 completed with verified evidence/);
});

test("resume limits long summaries and links to full records on demand", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gf-resume-details-"));
  const cli = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  try {
    run("adopt", "--name", "Details test");
    run("task", "new", "--title", "Check summary limits", "--activate");
    const action = "Read the relevant project files. ".repeat(12).trim();
    run("handoff", "--task", "TASK-0001", "--next-action", action);
    const compact = run("resume");
    assert.match(compact, /Details: geloforge resume --task TASK-0001 --details/);
    assert.ok(!compact.includes(action));
    const full = run("resume", "--details");
    assert.ok(full.includes(action));
    assert.match(full, /Source: handoffs\/HANDOFF-/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
