#!/usr/bin/env node
/**
 * Smoke test the source CLI or the installed npm tarball in disposable projects.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "geloforge.mjs");
const { values: options } = parseArgs({
  options: {
    packed: { type: "boolean", default: false },
    "pack-destination": { type: "string" },
  },
});

function runNode(args, cwd, input) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, "CLI process error: " + String(result.error));
  assert.equal(
    result.status,
    0,
    "Command failed: " + args.join(" ") +
      "\nstdout:\n" + result.stdout + "\nstderr:\n" + result.stderr
  );
  return result.stdout.trim();
}

const expected = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const compat = JSON.parse(fs.readFileSync(path.join(ROOT, "core", "compatibility.json"), "utf8"));
assert.equal(pkg.version, expected);
assert.equal(compat.harness_version, expected);
assert.deepEqual(Object.keys(pkg.dependencies || {}), [], "GeloForge must have no runtime packages");

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "geloforge smoke-"));
try {
  let cliPrefix = [CLI];
  if (options.packed) {
    const npm = process.env.npm_execpath;
    assert.ok(npm, "Run the package smoke with npm run smoke:package");
    const packDir = path.resolve(options["pack-destination"] ?? scratch);
    const cache = path.join(scratch, "npm-cache");
    fs.mkdirSync(packDir, { recursive: true });
    const packOutput = JSON.parse(runNode([
      npm, "pack", "--json", "--offline", "--ignore-scripts", "--cache", cache,
      "--pack-destination", packDir,
    ], ROOT));
    // npm 10/11 emits an array [pack], whereas npm 12+ emits an object keyed by package name.
    const pack = Array.isArray(packOutput)
      ? packOutput[0]
      : (packOutput?.[pkg.name] ?? Object.values(packOutput ?? {})[0]);
    assert.ok(pack && typeof pack.filename === "string" && Array.isArray(pack.files), "Expected npm pack --json metadata");
    assert.ok(pack.files.some(({ path }) => path === "adapters/n8n/staging-audit-error-workflow.json"));
    cliPrefix = [
      npm, "exec", "--yes", "--offline", "--ignore-scripts", "--cache", cache,
      "--package", path.join(packDir, pack.filename), "--", "geloforge",
    ];
    console.log(`Packed ${pack.filename} (${pack.entryCount} files, ${pack.size} bytes)`);
  }

  const cli = (args, cwd = scratch, input) => runNode([...cliPrefix, ...args], cwd, input);
  const cliJson = (args, cwd) => JSON.parse(cli([...args, "--json"], cwd));

  assert.equal(cli(["--version"]), expected);
  assert.match(cli(["--help"]), /^\s+mcp\s+/m);

  // Greenfield project: a packaged init defaults to the user's working directory.
  const newProject = options.packed
    ? path.join(scratch, "projects", "smoke-automation")
    : path.join(scratch, "new-automation");
  const initArgs = ["init", "--name", "Smoke Automation", "--profile", "automation", "--git"];
  if (!options.packed) initArgs.push("--dest", newProject);
  const init = cliJson(initArgs);
  assert.equal(init.projectId, "proj-smoke-automation");
  assert.equal(init.destDir, newProject);
  assert.equal(fs.existsSync(path.join(newProject, "brain", "manifest.yaml")), true);
  const gitignore = fs.readFileSync(path.join(newProject, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^artifacts\/$/m);
  assert.equal(fs.existsSync(path.join(newProject, "gitignore.template")), false);

  const status = cliJson(["status", "--project", newProject]);
  assert.equal(status.valid, true);
  assert.equal(status.project.profile, "automation");

  const task = cliJson(["task", "new", "--project", newProject,
    "--title", "Verify first local CLI run", "--activate"]);
  assert.equal(task.id, "TASK-0001");

  const recommendations = cliJson(["recommend", "--project", newProject]);
  assert.ok(Array.isArray(recommendations.recommendations));

  const context = cliJson(["context", "--project", newProject, "--task", task.id,
    "--profile", "quick", "--map"]);
  assert.equal(context.manifest.project_id, init.projectId);

  const verification = JSON.parse(cli(["verify", "--project", newProject,
    "--task", task.id, "--name", "Installed Node runtime", "--json", "--",
    process.execPath, "--version"]));
  assert.equal(verification.status, "completed");
  assert.equal(verification.evidence.id, "EVID-0001");
  assert.equal(verification.completion.verificationStatus, "verified");
  const cp = verification.checkpoint;
  assert.match(cp.checkpointId, /^CHKPT-\d{4}$/);
  const checkpoints = cliJson(["checkpoint", "list", "--project", newProject]);
  assert.ok(checkpoints.checkpoints.some((x) => x.id === cp.checkpointId));

  assert.equal(cliJson(["autonomous", "status"], newProject).mode, "off");
  const local = cliJson(["checkpoint", "create", "--local", "--resume", "Check staged results."], newProject);
  const recovered = cliJson(["checkpoint", "resume", "--id", local.checkpointId], newProject);
  assert.equal(recovered.nextAction, "Check staged results.");
  const cached = ["context", "--query", "staged results", "--cache"];
  assert.equal(cliJson(cached, newProject).diskCache, "miss");
  assert.equal(cliJson(cached, newProject).diskCache, "hit");

  const finalValidation = cliJson(["validate", "--project", newProject]);
  assert.equal(finalValidation.valid, true,
    "Generated project with task/evidence/checkpoint must remain schema-valid");

  const setup = cliJson(["mcp", "init", "--read-only"], newProject);
  assert.equal(setup.clients.length, 4);
  assert.equal(setup.files.length, 8);

  const mcpRequests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "geloforge_status", arguments: {} } },
  ];
  const [mcpInit, mcpStatus] = cli(
    ["mcp", "--project", ".", "--read-only"], newProject,
    mcpRequests.map((request) => JSON.stringify(request)).join("\n") + "\n"
  ).split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(mcpInit.result.serverInfo.name, "geloforge-mcp");
  assert.equal(mcpInit.result.serverInfo.version, expected);
  assert.equal(mcpStatus.result.isError, false);
  assert.equal(JSON.parse(mcpStatus.result.content[0].text).project.id, init.projectId);

  // The generated configuration for this local tarball must also work offline.
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(newProject, ".vscode", "mcp.json"), "utf8"));
  const launch = mcpConfig.servers.geloforge;
  assert.equal(launch.command, process.execPath);
  const generatedReply = runNode(launch.args, scratch, JSON.stringify(mcpRequests[0]) + "\n");
  assert.equal(JSON.parse(generatedReply).result.serverInfo.version, expected);

  // Brownfield project: exercise adopt from CWD and preserve existing files.
  const existing = path.join(scratch, "existing-application");
  fs.mkdirSync(existing);
  const original = "console.log('original customer code');\n";
  fs.writeFileSync(path.join(existing, "app.js"), original, "utf8");
  fs.writeFileSync(path.join(existing, "README.md"), "# Existing application\n", "utf8");

  const preview = cliJson(["adopt", "--profile", "automation", "--dry-run"], existing);
  assert.equal(preview.dryRun, true);
  assert.equal(fs.existsSync(path.join(existing, "brain")), false);

  cliJson(["adopt", "--profile", "automation"], existing);
  assert.equal(fs.readFileSync(path.join(existing, "app.js"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(existing, "README.md"), "utf8"),
    "# Existing application\n");
  assert.equal(cliJson(["validate"], existing).valid, true);

  console.log(`PASS: v${expected} ${options.packed ? "npm tarball" : "source"} smoke ` +
    "(CLI, init, task, context, verify, checkpoint, adopt, validate, staging switch, local recovery, disk cache, MCP setup and stdio)");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}
