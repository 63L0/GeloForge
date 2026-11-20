import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";

const CLI = fileURLToPath(new URL("../scripts/geloforge.mjs", import.meta.url));

function makeProject(t) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge mcp setup-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(temp, "My Project");
  bootstrapProject({ name: "My Project", dest: root });
  return root;
}

function init(cwd, ...args) {
  return spawnSync(process.execPath, [CLI, "mcp", "init", "--json", ...args], { cwd, encoding: "utf8" });
}

test("mcp init previews and installs all four project clients with an executable stdio configuration", (t) => {
  const root = makeProject(t);
  const preview = init(root, "--dry-run");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).files.length, 8);
  assert.equal(fs.existsSync(path.join(root, ".cursor")), false);
  assert.equal(fs.existsSync(path.join(root, ".geloforge")), false);

  const geminiGuide = path.join(root, "GEMINI.md");
  const originalGuide = fs.readFileSync(geminiGuide, "utf8");
  const installed = init(path.join(root, "src"));
  assert.equal(installed.status, 0, installed.stderr);

  const clients = [
    [".cursor/mcp.json", "mcpServers", ".cursor/rules/geloforge.mdc"],
    [".vscode/mcp.json", "servers", ".github/instructions/geloforge.instructions.md"],
    [".mcp.json", "mcpServers", ".claude/rules/geloforge.md"],
    [".gemini/settings.json", "mcpServers", "GEMINI.md"],
  ];
  for (const [file, key, guide] of clients) {
    const entry = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"))[key].geloforge;
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [CLI, "mcp", "--project", root]);
    const rules = fs.readFileSync(path.join(root, guide), "utf8");
    for (const tool of ["recommend", "context", "task", "checkpoint"]) {
      assert.match(rules, new RegExp(`geloforge_${tool}`));
    }
    const server = spawnSync(entry.command, entry.args, {
      cwd: path.dirname(root), encoding: "utf8", timeout: 10_000,
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    });
    assert.equal(server.status, 0, server.stderr);
    assert.equal(JSON.parse(server.stdout).result.serverInfo.name, "geloforge-mcp");
  }
  assert.ok(fs.readFileSync(geminiGuide, "utf8").startsWith(originalGuide));
  const repeated = init(root);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.ok(JSON.parse(repeated.stdout).files.every((file) => file.action === "unchanged"));
});

test("mcp init preserves VS Code JSONC, existing server settings, and Gemini's selected guide", (t) => {
  const root = makeProject(t);
  const vscode = path.join(root, ".vscode", "mcp.json");
  fs.mkdirSync(path.dirname(vscode));
  fs.writeFileSync(vscode, [
    "{",
    '  "inputs": [], // keep the inputs',
    '  "servers": {',
    '    "other": {"type":"http","url":"https://example.invalid/api"},',
    '    "geloforge": {"type":"stdio","command":"npx","args":["geloforge@0.5.0","mcp"],',
    '      "env": {"PROJECT_MODE":"local"}, // keep the environment',
    "    },",
    "  },",
    "}",
  ].join("\n"), { mode: 0o600 });
  const gemini = path.join(root, ".gemini", "settings.json");
  fs.mkdirSync(path.dirname(gemini));
  fs.writeFileSync(gemini, '{"context":{"fileName":["AI-WORK.md"]},"mcpServers":{}}\n');
  fs.writeFileSync(path.join(root, "AI-WORK.md"), "# Existing instructions\n");

  const result = init(root, "--client", "vscode", "--client", "gemini", "--read-only");
  assert.equal(result.status, 0, result.stderr);
  const contents = fs.readFileSync(vscode, "utf8");
  assert.ok(contents.includes('"other": {"type":"http","url":"https://example.invalid/api"},'));
  assert.ok(contents.includes('"env": {"PROJECT_MODE":"local"}, // keep the environment'));
  assert.ok(contents.includes('"inputs": [], // keep the inputs'));
  assert.ok(contents.includes('"--read-only"'));
  if (process.platform !== "win32") assert.equal(fs.statSync(vscode).mode & 0o777, 0o600);
  const geminiEntry = JSON.parse(fs.readFileSync(gemini, "utf8"));
  assert.deepEqual(geminiEntry.context.fileName, ["AI-WORK.md"]);
  assert.equal(geminiEntry.mcpServers.geloforge.args.at(-1), "--read-only");
  const guide = fs.readFileSync(path.join(root, "AI-WORK.md"), "utf8");
  assert.ok(guide.startsWith("# Existing instructions\n"));
  assert.match(guide, /read task and checkpoint history/);
  assert.equal(fs.existsSync(path.join(root, ".cursor")), false);
});

test("mcp init preflights all clients before writing when a server name conflicts", (t) => {
  const root = makeProject(t);
  const config = path.join(root, ".mcp.json");
  const original = '{"mcpServers":{"geloforge":{"type":"http","url":"https://example.invalid/mcp"}}}\n';
  fs.writeFileSync(config, original);
  const result = init(root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /geloforge server name in \.mcp\.json/);
  assert.equal(fs.readFileSync(config, "utf8"), original);
  assert.equal(fs.existsSync(path.join(root, ".cursor")), false);
  assert.equal(fs.existsSync(path.join(root, ".vscode")), false);
});
