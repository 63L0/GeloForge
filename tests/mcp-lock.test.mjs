import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";

const CLI = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));

const mockMcpServerCode = String.raw`
import fs from "node:fs";
import readline from "node:readline";

const modeFile = process.env.MOCK_MCP_MODE_FILE;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" } },
    }) + "\n");
    return;
  }
  if (msg.method === "tools/list") {
    const mode = modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, "utf8").trim() : "v1";
    const tools = [
      {
        name: "mock_ping",
        description: mode === "drifted" ? "Changed description triggers lock drift." : "Original ping tool.",
        inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
      },
      ...(mode === "drifted" ? [{
        name: "mock_extra",
        description: "Unexpected added tool.",
        inputSchema: { type: "object", properties: {} },
      }] : []),
    ];
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\n");
  }
});
`;

function cli(cwd, args, expectedStatus = 0) {
  const out = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 25_000 });
  assert.equal(out.error, undefined);
  assert.equal(out.status, expectedStatus, out.stderr || out.stdout);
  return out;
}

test("mcp lock pins stdio servers, skips non-stdio entries, and detects tool-surface drift on --check", (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-mcplock-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const project = path.join(temp, "sample project");
  bootstrapProject({ name: "MCP Lock Trial", dest: project, profile: "automation", git: false });

  cli(project, ["mcp", "init", "--client", "antigravity", "--read-only", "--json"]);

  const modeFile = path.join(temp, "mode.txt");
  const mockServer = path.join(temp, "mock-mcp.mjs");
  fs.writeFileSync(modeFile, "v1");
  fs.writeFileSync(mockServer, mockMcpServerCode);

  fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({
    mcpServers: {
      mock: {
        command: process.execPath,
        args: [mockServer],
        env: { MOCK_MCP_MODE_FILE: modeFile, SECRET_API_KEY: "sk-testsecretvalue1234567890" },
      },
      remote: {
        type: "http",
        url: "https://example.invalid/mcp",
      },
    },
  }, null, 2));

  const preview = JSON.parse(cli(project, ["mcp", "lock", "--dry-run", "--json"]).stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.serverCount, 2);
  assert.equal(preview.skippedCount, 1);
  assert.equal(preview.skipped[0].reason, "non_stdio_skipped");
  assert.equal(fs.existsSync(path.join(project, ".geloforge", "mcp-lock.json")), false);

  const locked = JSON.parse(cli(project, ["mcp", "lock", "--json"]).stdout);
  assert.equal(locked.action, "locked");
  assert.equal(locked.serverCount, 2);
  assert.equal(locked.skippedCount, 1);

  const lockFile = path.join(project, ".geloforge", "mcp-lock.json");
  const lockText = fs.readFileSync(lockFile, "utf8");
  assert.equal(lockText.includes("sk-testsecretvalue"), false);
  assert.equal(lockText.includes(process.execPath), false);

  const passCheck = JSON.parse(cli(project, ["mcp", "lock", "--check", "--json"]).stdout);
  assert.equal(passCheck.passed, true);
  assert.equal(passCheck.checkedCount, 2);
  assert.deepEqual(passCheck.driftedServers, []);
  assert.deepEqual(passCheck.addedServers, []);
  assert.deepEqual(passCheck.removedServers, []);

  fs.writeFileSync(modeFile, "drifted");
  const failCheck = JSON.parse(cli(project, ["mcp", "lock", "--check", "--json"], 1).stdout);
  assert.equal(failCheck.passed, false);
  assert.equal(failCheck.driftedServers.length, 1);
  assert.equal(failCheck.driftedServers[0].name, "mock");
  assert.deepEqual(failCheck.driftedServers[0].changedTools, ["mock_ping"]);
  assert.deepEqual(failCheck.driftedServers[0].addedTools, ["mock_extra"]);

  assert.equal(JSON.parse(cli(project, ["validate", "--json"]).stdout).valid, true);
});

test("mcp lock --check refuses missing or symlinked lockfiles cleanly", (t) => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge-mcplock-sec-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const project = path.join(temp, "sec-proj");
  bootstrapProject({ name: "MCP Security Trial", dest: project, git: false });

  const missing = cli(project, ["mcp", "lock", "--check"], 1);
  assert.match(missing.stderr, /mcp-lock\.json/);

  const targetDir = path.join(temp, "link-target");
  fs.mkdirSync(targetDir);
  fs.mkdirSync(path.join(project, ".geloforge"), { recursive: true });
  fs.symlinkSync(targetDir, path.join(project, ".geloforge", "mcp-lock.json"), process.platform === "win32" ? "junction" : "dir");
  const symlinked = cli(project, ["mcp", "lock", "--check"], 1);
  assert.match(symlinked.stderr, /symbolic links|regular file/i);
});
