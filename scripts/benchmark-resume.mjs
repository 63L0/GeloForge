// Create identical starter code in three isolated trial directories and grade the final behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./geloforge.mjs", import.meta.url));
const arms = ["repo", "note", "geloforge"];
const note = "Checkout accepts blank email addresses. I added checkout.test.mjs and confirmed it fails. Fix validEmail in checkout.mjs. Keep valid addresses working, reject whitespace-only input, and run node checkout.test.mjs.";
const prompt = "Finish the interrupted checkout validation task. Reject blank or whitespace-only email, preserve acceptance of valid email, and run the tests.";
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== expected) throw new Error(result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}
function prepare() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geloforge-trial-"));
  for (const arm of arms) {
    const cwd = path.join(root, arm);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "checkout.mjs"), "export function validEmail(email) { return true; }\n");
    fs.writeFileSync(path.join(cwd, "checkout.test.mjs"), "import assert from 'node:assert/strict';\nimport { validEmail } from './checkout.mjs';\nassert.equal(validEmail(''), false);\n");
    if (arm === "note") fs.writeFileSync(path.join(cwd, "HANDOFF.md"), note + "\n");
    if (arm === "geloforge") {
      const gf = (args, expected) => run(process.execPath, [cli, ...args], cwd, expected);
      gf(["adopt", "--name", "Checkout trial"]);
      gf(["task", "new", "--title", "Reject blank checkout emails", "--activate"]);
      gf(["verify", "--file", "checkout.mjs", "--", "node", "checkout.test.mjs"], 1);
      gf(["handoff", "--task", "TASK-0001", "--file", "checkout.mjs", "--completed", "Added failing checkout.test.mjs", "--next-action", note]);
    }
  }
  return root;
}
function grade(cwd) {
  // The acceptance checks live outside the trial directory so changing the visible test cannot earn a pass.
  const checker = `import assert from 'node:assert/strict';
import {validEmail} from './checkout.mjs';
for (const email of ['', '  ', '\\t']) assert.equal(validEmail(email), false);
assert.equal(validEmail('dev@example.org'), true);`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", checker], { cwd, timeout: 10000 }).status === 0;
}
const [action, directory] = process.argv.slice(2);
if (action === "prepare") {
  console.log(prepare());
  console.log(prompt);
} else if (action === "grade" && directory) {
  const results = arms.map(arm => {
    const cwd = path.resolve(directory, arm);
    if (!fs.existsSync(path.join(cwd, "checkout.mjs"))) throw new Error("Missing trial: " + arm);
    return { arm, passed: grade(cwd) };
  });
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.every(r => r.passed) ? 0 : 1;
} else if (action === "self-test") {
  const root = prepare();
  try {
    for (const arm of arms) {
      const cwd = path.join(root, arm);
      assert.equal(grade(cwd), false);
      fs.writeFileSync(path.join(cwd, "checkout.mjs"), "export const validEmail = email => email.trim().length > 0;\n");
      assert.equal(grade(cwd), true);
    }
    console.log("All three arms rejected the starter and accepted the reference fix.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  console.error("Usage: node scripts/benchmark-resume.mjs prepare | grade <trial-root> | self-test");
  process.exitCode = 2;
}
