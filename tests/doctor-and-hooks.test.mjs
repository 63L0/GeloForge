import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { runProjectDoctor } from "../core/doctor.mjs";
import { initProjectHooks } from "../core/hooks-init.mjs";
import { lockMcpServers, MCP_LOCK_PATH } from "../core/mcp-lock.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");
const SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function runCli(args, { cwd = HARNESS_DIR, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
}

function initGitCommit(projectDir) {
  const opts = { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
  execFileSync("git", ["-C", projectDir, "config", "user.name", "Test User"], opts);
  execFileSync("git", ["-C", projectDir, "config", "user.email", "test@example.invalid"], opts);
  execFileSync("git", ["-C", projectDir, "add", "-A"], opts);
  execFileSync("git", ["-C", projectDir, "commit", "-m", "init"], opts);
}

test("initProjectHooks installs git, claude, and gemini hooks idempotently while preserving user config", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-hooks-"));
  try {
    const projectDir = path.join(tmp, "app");
    bootstrapProject({ name: "Hooks Test App", dest: projectDir, git: true });
    initGitCommit(projectDir);

    // Pre-existing user git pre-commit hook and Gemini mcpServers config
    const gitHookPath = path.join(projectDir, ".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(gitHookPath), { recursive: true });
    fs.writeFileSync(gitHookPath, "#!/usr/bin/env sh\necho custom-user-hook\n", "utf8");

    fs.mkdirSync(path.join(projectDir, ".gemini"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { geloforge: { command: "node", args: ["mock"] } }, theme: "dark" }, null, 2),
      "utf8"
    );

    // Dry run touches nothing for claude
    const dryRes = initProjectHooks({ projectDir, harnessDir: HARNESS_DIR, dryRun: true });
    assert.equal(dryRes.dryRun, true);
    assert.equal(fs.existsSync(path.join(projectDir, ".claude", "settings.json")), false);

    // Apply all targets
    const applyRes = initProjectHooks({ projectDir, harnessDir: HARNESS_DIR, dryRun: false });
    assert.deepEqual(
      applyRes.files.map((f) => [f.target, f.action]),
      [
        ["git", "update"],
        ["claude", "create"],
        ["gemini", "update"],
      ]
    );

    const gitContent = fs.readFileSync(gitHookPath, "utf8");
    assert.match(gitContent, /echo custom-user-hook/);
    assert.match(gitContent, /geloforge:hooks-init:start/);

    const claudeCfg = JSON.parse(fs.readFileSync(path.join(projectDir, ".claude", "settings.json"), "utf8"));
    assert.ok(Array.isArray(claudeCfg.hooks?.Stop));
    assert.match(claudeCfg.hooks.Stop[0].hooks[0].command, /geloforge doctor/);

    const geminiCfg = JSON.parse(fs.readFileSync(path.join(projectDir, ".gemini", "settings.json"), "utf8"));
    assert.equal(geminiCfg.theme, "dark");
    assert.deepEqual(geminiCfg.mcpServers.geloforge, { command: "node", args: ["mock"] });
    assert.ok(Array.isArray(geminiCfg.hooks?.AfterAgent));

    // Re-run is completely idempotent
    const secondRes = initProjectHooks({ projectDir, harnessDir: HARNESS_DIR, dryRun: false });
    assert.equal(secondRes.files.every((f) => f.action === "unchanged"), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("initProjectHooks skips non-git repos for git target and refuses symlinks fail-closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-hooks-sec-"));
  try {
    const nonGitDir = path.join(tmp, "plain-app");
    bootstrapProject({ name: "Plain App", dest: nonGitDir, git: false });
    const res = initProjectHooks({ projectDir: nonGitDir, harnessDir: HARNESS_DIR, dryRun: true });
    const gitPlan = res.files.find((f) => f.target === "git");
    assert.equal(gitPlan.action, "skipped");

    const cliDry = runCli(["hooks", "init", "--project", nonGitDir, "--target", "claude,gemini", "--dry-run", "--json"]);
    assert.equal(cliDry.status, 0, cliDry.stderr);
    const cliJson = JSON.parse(cliDry.stdout);
    assert.equal(cliJson.files.length, 2);

    // Symlinked .claude dir fails closed
    const outsideDir = path.join(tmp, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(nonGitDir, ".claude"), SYMLINK_TYPE);
    assert.throws(
      () => initProjectHooks({ projectDir: nonGitDir, harnessDir: HARNESS_DIR, targets: ["claude"] }),
      /symbolic link|escapes|symlink/i
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("runProjectDoctor passes on healthy configured project and flags outdated/drift/broken states with fixes", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-doctor-"));
  const isolatedGlobal = path.join(tmp, "empty-global");
  fs.mkdirSync(isolatedGlobal, { recursive: true });
  try {
    const projectDir = path.join(tmp, "app");
    bootstrapProject({ name: "Doctor App", dest: projectDir, git: true });
    initGitCommit(projectDir);

    // Healthy project before hooks/mcp lock gives healthy=true (warns on optional hooks/mcp)
    const initial = await runProjectDoctor({
      projectDir,
      harnessDir: HARNESS_DIR,
      globalSkillsDir: isolatedGlobal,
    });
    assert.equal(initial.healthy, true);
    assert.equal(initial.counts.fail, 0);
    assert.ok(initial.nextActions.length >= 1);

    // Install hooks + mock MCP server + lockfile + clean commit -> fully configured pass
    initProjectHooks({ projectDir, harnessDir: HARNESS_DIR });
    const mockMcp = path.join(projectDir, "src", "mock-mcp.mjs");
    fs.writeFileSync(
      mockMcp,
      [
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'rl.on("line", (line) => {',
        '  const s = line.trim(); if (!s) return; const m = JSON.parse(s); if (m.id === undefined) return;',
        '  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "doc-mcp", version: "1.0.0" } } }) + "\\n");',
        '  else if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");',
        "});",
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { mock: { command: process.execPath, args: [mockMcp] } } }, null, 2),
      "utf8"
    );
    await lockMcpServers({ projectDir, harnessDir: HARNESS_DIR, timeoutMs: 6000 });
    initGitCommit(projectDir);

    const healthyCli = runCli(["doctor", "--project", projectDir, "--global-dir", isolatedGlobal, "--json"]);
    assert.equal(healthyCli.status, 0, healthyCli.stderr || healthyCli.stdout);
    const healthyJson = JSON.parse(healthyCli.stdout);
    assert.equal(healthyJson.healthy, true);
    assert.equal(healthyJson.counts.fail, 0);
    assert.equal(healthyJson.checks.find((c) => c.id === "mcp_lock").status, "pass");
    assert.equal(healthyJson.checks.find((c) => c.id === "hooks_configured").status, "pass");

    // Corrupt mcp-lock.json -> doctor fails closed with exit code 1 and fix hint
    fs.writeFileSync(path.join(projectDir, MCP_LOCK_PATH), "{broken-json", "utf8");
    const brokenCli = runCli(["doctor", "--project", projectDir, "--global-dir", isolatedGlobal, "--json"]);
    assert.equal(brokenCli.status, 1);
    const brokenJson = JSON.parse(brokenCli.stdout);
    assert.equal(brokenJson.healthy, false);
    assert.equal(brokenJson.checks.find((c) => c.id === "mcp_lock").status, "fail");
    assert.match(brokenJson.nextActions.join(" "), /geloforge mcp lock --check/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
