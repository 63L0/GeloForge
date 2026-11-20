import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "scripts", "geloforge.mjs");
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-demo-"));
const project = path.join(scratch, "GeloForge");
const scope = "docs/quickstart-5min.md";

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}

function geloforge(...args) {
  return JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    cwd: project, encoding: "utf8", windowsHide: true, timeout: 30_000,
  }));
}

function mcpClient() {
  const child = spawn(process.execPath, [cli, "mcp", "--project", project], { windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let id = 0;
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
  });
  child.stderr.pipe(process.stderr);
  async function request(method, params) {
    id += 1;
    const requestId = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`MCP ${method} timed out`));
      }, 10_000);
      pending.set(requestId, (reply) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params, id: requestId })}\n`);
    });
  }
  return {
    async start() {
      const reply = await request("initialize", {});
      assert.equal(reply.result.serverInfo.name, "geloforge-mcp");
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    },
    async call(name, args, expectError = false) {
      const { result } = await request("tools/call", { name, arguments: args });
      assert.equal(result.isError, expectError, result.content[0].text);
      return expectError ? result.content[0].text : JSON.parse(result.content[0].text);
    },
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.stdin.end();
      });
    },
  };
}

const clients = [];
let worktree = false;
try {
  const revision = git("rev-parse", "HEAD").trim();
  git("worktree", "add", "--detach", project, revision);
  worktree = true;
  geloforge("adopt", "--name", "GeloForge", "--json");
  const setup = geloforge("mcp", "init", "--json");
  assert.equal(setup.clients.length, 4);
  console.log(`$ geloforge mcp init\n  4 client configs generated on GeloForge ${revision.slice(0, 7)}`);

  const first = mcpClient();
  const second = mcpClient();
  clients.push(first, second);
  await Promise.all(clients.map((client) => client.start()));
  const task = await first.call("geloforge_task", { action: "new", title: "Review verify quickstart" });
  const peer = await second.call("geloforge_task", { action: "new", title: "Review onboarding examples" });
  const lease = await first.call("geloforge_task", {
    action: "claim", task: task.id, tool: "mcp-a", sessionId: "demo-a", scopes: [scope],
  });
  assert.deepEqual(lease.lease.claimed_scope, [scope]);
  console.log(`MCP A > geloforge_task claim ${task.id}\n  Claimed ${scope}`);

  const blocked = await second.call("geloforge_task", {
    action: "claim", task: peer.id, tool: "mcp-b", sessionId: "demo-b", scopes: [scope],
  }, true);
  assert.match(blocked, /collision|overlap/i);
  console.log(`MCP B > geloforge_task claim ${peer.id}\n  Blocked by ${task.id} on ${scope}`);

  const verified = geloforge("verify", "--task", task.id, "--tool", "mcp-a", "--session", "demo-a", "--json",
    "--", process.execPath, "--test", "tests/verify.test.mjs");
  assert.equal(verified.status, "completed");
  console.log(`$ geloforge verify -- node --test tests/verify.test.mjs\n  ${verified.evidence.id} verified · ${verified.checkpoint.checkpointId} saved · ${task.id} completed`);

  const skill = "verify-quickstart";
  const draft = await second.call("geloforge_skills", {
    action: "draft", name: skill, evidenceIds: [verified.evidence.id],
    description: "Verify GeloForge's one-command task completion before updating the quickstart.",
    steps: ["Run node --test tests/verify.test.mjs and review the verified record."],
  });
  assert.equal(draft.skillName, skill);
  const key = path.join(scratch, "demo-approver.pem");
  geloforge("skills", "keygen", "--approver", "demo-approver", "--out", key, "--json");
  const signed = geloforge("skills", "sign", "--skill", skill, "--approver", "demo-approver",
    "--key", key, "--rationale", "Verify the local demo's evidence-backed candidate.", "--json");
  assert.match(signed.approvalId, /^APPR-\d{4}$/);
  console.log(`MCP B > geloforge_skills draft ${skill}\n  Quarantined draft · ${signed.approvalId} signed with a local demo key`);

  assert.equal(geloforge("validate", "--json").valid, true);
} finally {
  await Promise.all(clients.map((client) => client.stop()));
  if (worktree) git("worktree", "remove", "--force", project);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}
