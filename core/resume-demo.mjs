import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runDemo(args) {
  if (args.length) {
    console.log("Usage: geloforge demo");
    return args.every(a => ["--help", "-h"].includes(a)) ? 0 : 1;
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "geloforge-checkout-"));
  const cli = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));
  function run(argv, expected = 0) {
    const result = spawnSync(process.execPath, [cli, ...argv], { cwd, encoding: "utf8" });
    if (result.status !== expected) throw new Error(result.stderr || result.stdout || "Demo command failed");
    return result.stdout;
  }
  try {
    run(["adopt", "--name", "Checkout demo"]);
    fs.writeFileSync(path.join(cwd, "checkout.mjs"), "export const valid = email => true;\n");
    fs.writeFileSync(path.join(cwd, "checkout.test.mjs"), "import assert from 'node:assert/strict';\nimport {valid} from './checkout.mjs';\nassert.equal(valid(''), false);\n");
    run(["task", "new", "--title", "Reject empty checkout email", "--activate"]);
    const verify = ["verify", "--file", "checkout.mjs", "--file", "checkout.test.mjs", "--", "node", "--test", "checkout.test.mjs"];
    run(verify, 1);
    run(["handoff", "--task", "TASK-0001", "--file", "checkout.mjs", "--completed", "Added a failing checkout test", "--next-action", "Fix checkout.mjs and run node --test checkout.test.mjs"]);
    console.log(run(["resume"]));
    fs.writeFileSync(path.join(cwd, "checkout.mjs"), "export const valid = email => email.trim().length > 0;\n");
    console.log("Applied the sample fix. Before retesting:");
    console.log(run(["resume"]));
    console.log(run(verify));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return 0;
}
