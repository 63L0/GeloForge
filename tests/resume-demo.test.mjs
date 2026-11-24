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
