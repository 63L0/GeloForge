import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { adoptProject } from "../core/adopt-project.mjs";
import {
  claimTaskLease,
  completeTask,
  createTask,
  listTaskLeases,
  releaseTaskLease,
  updateTask,
} from "../core/task-manager.mjs";
import { captureEvidence } from "../core/evidence-capture.mjs";
import { createCheckpoint, getCheckpoint, listCheckpoints } from "../core/checkpoint.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { getProjectRecommendations, getProjectStatus } from "../core/project-status.mjs";
import { draftSkillFromExperience } from "../core/skills-lifecycle.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { withProjectLock } from "../core/project-lock.mjs";
import {
  MAX_MCP_HEADER_BYTES,
  MAX_MCP_MESSAGE_BYTES,
  MCP_TOOLS,
  handleMcpMessage,
  startMcpStdioServer,
} from "../core/mcp-server.mjs";
import { parseYaml } from "../core/yaml-subset.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");

function runGit(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function initTempProject(prefix = "gf-v05-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(tmp, "app");
  bootstrapProject({
    name: "CoPilot App",
    dest: projectDir,
    owner: "Architect",
    git: true,
    createdAt: "2026-11-20T09:00:00Z",
  });
  runGit(projectDir, ["config", "user.name", "Test Architect"]);
  runGit(projectDir, ["config", "user.email", "architect@example.com"]);
  runGit(projectDir, ["add", "-A"]);
  runGit(projectDir, ["commit", "-m", "initial brain"]);
  return { tmp, projectDir };
}

test("task update, task done auto-releases lease, and reactivation clears last_completed_task cleanly", () => {
  const { tmp, projectDir } = initTempProject();
  try {
    createTask({
      projectDir,
      title: "Implement token budget guard",
      priority: "high",
      activate: true,
      createdAt: "2026-11-20T09:05:00Z",
    });

    claimTaskLease({
      projectDir,
      taskId: "TASK-0001",
      tool: "codex",
      role: "developer",
      scopes: ["src/budget.mjs"],
      createdAt: "2026-11-20T09:06:00Z",
    });

    // Complete task via API: updates state.last_completed_task & releases lease
    const doneRes = completeTask({
      projectDir,
      taskId: "TASK-0001",
      updatedAt: "2026-11-20T09:10:00Z",
    });
    assert.equal(doneRes.status, "completed");
    assert.equal(doneRes.lastCompletedTask, "TASK-0001");
    assert.deepEqual(doneRes.activeTasks, []);

    const leasesAfterDone = listTaskLeases({ projectDir, nowIso: "2026-11-20T09:11:00Z" });
    assert.equal(leasesAfterDone.activeLeases.length, 0);

    const valDone = validateProject(projectDir);
    assert.equal(valDone.valid, true, `Validation failed after done: ${valDone.errors.join("; ")}`);

    // Reactivate via CLI: clears state.last_completed_task so validator stays happy
    const reactRes = spawnSync(
      process.execPath,
      [CLI_PATH, "task", "update", "--project", projectDir, "--task", "TASK-0001", "--status", "active", "--activate", "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(reactRes.status, 0, reactRes.stderr);
    const reactJson = JSON.parse(reactRes.stdout);
    assert.equal(reactJson.status, "active");
    assert.equal(reactJson.lastCompletedTask, null);
    assert.deepEqual(reactJson.activeTasks, ["TASK-0001"]);

    const valReact = validateProject(projectDir);
    assert.equal(valReact.valid, true, `Validation failed after reactivate: ${valReact.errors.join("; ")}`);

    // Finish again via CLI `task done`
    const cliDone = spawnSync(
      process.execPath,
      [CLI_PATH, "task", "done", "--project", projectDir, "TASK-0001", "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(cliDone.status, 0, cliDone.stderr);
    assert.equal(JSON.parse(cliDone.stdout).lastCompletedTask, "TASK-0001");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("multi-IDE cooperative leases prevent overlapping edits, prune expired leases, and surface in compileContext", () => {
  const { tmp, projectDir } = initTempProject();
  try {
    createTask({
      projectDir,
      title: "Backend auth handler",
      activate: true,
      createdAt: "2026-11-20T09:05:00Z",
    });
    createTask({
      projectDir,
      title: "Refactor shared auth utility",
      createdAt: "2026-11-20T09:05:00Z",
    });

    const lease1 = claimTaskLease({
      projectDir,
      taskId: "TASK-0001",
      tool: "gemini-ide",
      role: "developer",
      scopes: ["src/auth"],
      ttlMinutes: 60,
      createdAt: "2026-11-20T10:00:00Z",
    });
    assert.deepEqual(lease1.lease.claimed_scope, ["src/auth"]);

    // Overlapping scope without --force must fail
    assert.throws(
      () =>
        claimTaskLease({
          projectDir,
          taskId: "TASK-0002",
          tool: "codex-ide",
          role: "qa-security-reviewer",
          scopes: ["src/auth/jwt.mjs"],
          ttlMinutes: 60,
          createdAt: "2026-11-20T10:05:00Z",
        }),
      /File-scope collision/i
    );

    // Non-overlapping scope succeeds cleanly
    claimTaskLease({
      projectDir,
      taskId: "TASK-0002",
      tool: "codex-ide",
      role: "qa-security-reviewer",
      scopes: ["docs/security.md"],
      ttlMinutes: 15,
      createdAt: "2026-11-20T10:05:00Z",
    });

    // Context compiler automatically injects active peer lease awareness
    const packet = compileContext({
      projectDir,
      taskId: "TASK-0001",
      profile: "working",
      compiledAt: "2026-11-20T10:10:00Z",
    });
    assert.match(packet.markdown, /Active Multi-IDE Peer Leases/i);
    assert.match(packet.markdown, /codex-ide/);
    assert.match(packet.markdown, /docs\/security\.md/);

    // At 10:25Z, lease 2 (15m TTL from 10:05Z) expired while lease 1 (60m TTL from 10:00Z) remains active
    const expiredCheck = listTaskLeases({
      projectDir,
      nowIso: "2026-11-20T10:25:00Z",
      includeExpired: true,
    });
    assert.equal(expiredCheck.activeLeases.length, 1);
    assert.equal(expiredCheck.activeLeases[0].task_id, "TASK-0001");
    assert.equal(expiredCheck.expiredLeases.length, 1);
    assert.equal(expiredCheck.expiredLeases[0].task_id, "TASK-0002");

    // Releasing without confirmation or as another peer tool fails closed
    assert.throws(
      () => releaseTaskLease({ projectDir, taskId: "TASK-0001", nowIso: "2026-11-20T10:30:00Z" }),
      /Refusing unverified lease release/i
    );
    assert.throws(
      () => releaseTaskLease({ projectDir, taskId: "TASK-0001", tool: "codex-ide", nowIso: "2026-11-20T10:30:00Z" }),
      /Lease ownership mismatch/i
    );

    // Release lease 1 via CLI confirming owning --tool
    const relCli = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        "task",
        "release",
        "--project",
        projectDir,
        "TASK-0001",
        "--tool",
        "gemini-ide",
        "--created-at",
        "2026-11-20T10:30:00Z",
        "--json",
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(relCli.status, 0, relCli.stderr);
    assert.equal(JSON.parse(relCli.stdout).released, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("anti-context-rot prunes completed tasks by default and --from-diff focuses uncommitted changes", () => {
  const { tmp, projectDir } = initTempProject();
  try {
    createTask({
      projectDir,
      title: "Historical billing migration work",
      createdAt: "2026-11-20T09:01:00Z",
    });
    completeTask({
      projectDir,
      taskId: "TASK-0001",
      updatedAt: "2026-11-20T09:02:00Z",
    });
    createTask({
      projectDir,
      title: "Current invoice formatter fix",
      activate: true,
      createdAt: "2026-11-20T09:05:00Z",
    });

    // Completed task TASK-0001 is omitted by default when querying general workspace topic
    const prunedPacket = compileContext({
      projectDir,
      query: "billing migration and invoice formatter",
      profile: "working",
      compiledAt: "2026-11-20T09:15:00Z",
    });
    assert.equal(
      prunedPacket.markdown.includes("Historical billing migration work"),
      false,
      "Completed non-target task should be pruned by default"
    );

    // Explicitly passing includeCompleted restores completed task
    const fullPacket = compileContext({
      projectDir,
      query: "billing migration and invoice formatter",
      profile: "working",
      includeCompleted: true,
      compiledAt: "2026-11-20T09:15:00Z",
    });
    assert.equal(fullPacket.markdown.includes("Historical billing migration work"), true);

    // Dirty uncommitted source file in Git repo triggers --from-diff focus without explicit --task or --query
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src", "invoice.mjs"), "export function formatInvoice() { return 'ok'; }\n", "utf8");
    const diffCli = spawnSync(
      process.execPath,
      [CLI_PATH, "context", "--project", projectDir, "--from-diff", "--profile", "quick", "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(diffCli.status, 0, diffCli.stderr);
    const diffRes = JSON.parse(diffCli.stdout);
    assert.match(diffRes.markdown, /TASK-0002/);
    assert.match(diffRes.markdown, /Co-Pilot Session Guidance/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkpoint create, list, show persist schema-valid CHKPT-NNNN and pass project validation", () => {
  const { tmp, projectDir } = initTempProject();
  try {
    createTask({
      projectDir,
      title: "Build session checkpointing",
      activate: true,
      createdAt: "2026-11-20T09:05:00Z",
    });

    // Secret guard refuses credentials in summary/resume
    assert.throws(
      () =>
        createCheckpoint({
          projectDir,
          summary: "Used token " + "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234",
        }),
      /credential-like/i
    );

    const cp = createCheckpoint({
      projectDir,
      summary: "Completed task state sync; ready for CLI verification.",
      createdBy: "developer",
      createdAt: "2026-11-20T09:20:00Z",
    });
    assert.equal(cp.checkpointId, "CHKPT-0001");
    assert.match(cp.record.resume_instructions, /TASK-0001/);

    const state = parseYaml(fs.readFileSync(path.join(projectDir, "brain", "state", "current.yaml"), "utf8"));
    assert.equal(state.last_checkpoint, "CHKPT-0001");

    const val = validateProject(projectDir);
    assert.equal(val.valid, true, `Validation failed with CHKPT-0001: ${val.errors.join("; ")}`);

    const listRes = listCheckpoints({ projectDir });
    assert.equal(listRes.count, 1);
    assert.equal(listRes.lastCheckpointId, "CHKPT-0001");

    const showCli = spawnSync(
      process.execPath,
      [CLI_PATH, "checkpoint", "show", "--project", projectDir, "CHKPT-0001", "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(showCli.status, 0, showCli.stderr);
    assert.equal(JSON.parse(showCli.stdout).checkpointId, "CHKPT-0001");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("status & recommend aggregate approval inbox (skill draft, APPR, ADR) and overlapping lease alerts", () => {
  const { tmp, projectDir } = initTempProject();
  try {
    createTask({
      projectDir,
      title: "Verified workflow extraction",
      activate: true,
      createdAt: "2026-11-20T09:05:00Z",
    });
    const ev = captureEvidence({
      projectDir,
      taskId: "TASK-0001",
      commandArgv: ["node", "-e", "console.log('ok')"],
      verifiedBy: "architect",
      createdAt: "2026-11-20T09:06:00Z",
    });
    assert.equal(ev.verified, true);

    draftSkillFromExperience({
      projectDir,
      evidenceIds: [ev.id],
      skillName: "safe-release-check",
      title: "Safe Release Check",
      description: "Verify build before tagging.",
      steps: ["Run node test suite cleanly."],
      createdAt: "2026-11-20T09:07:00Z",
    });

    // Pending schema-valid APPR proposal & proposed ADR
    fs.writeFileSync(
      path.join(projectDir, "proposals", "APPR-0001-release-gate.yaml"),
      [
        'schema_version: "1.1"',
        'id: "APPR-0001"',
        'title: "Approve release security boundary gate"',
        'status: "pending"',
        'memory_layer: "L2_OPERATIONAL"',
        'authority_level: "A2"',
        'boundary_category: "security_boundary"',
        'requested_by: "developer"',
        'requested_at: "2026-11-20T09:08:00Z"',
        "decided_by: null",
        "decided_at: null",
        "expires_at: null",
        "target_records:",
        '  - "TASK-0001"',
        'rationale: "Enforce security boundary gate before release."',
        'risk_assessment: "Low local risk"',
        "conditions:",
        '  - "Verify CI passes cleanly"',
      ].join("\n") + "\n",
      "utf8"
    );

    fs.writeFileSync(
      path.join(projectDir, "brain", "decisions", "ADR-0001-use-stdio-mcp.md"),
      [
        "---",
        'schema_version: "1.1"',
        'id: "ADR-0001"',
        'title: "Use Stdio MCP Transport"',
        'status: "proposed"',
        'memory_layer: "L1_AUTHORITATIVE"',
        'authority_level: "A2"',
        'owner: "Architect"',
        'proposed_by: "developer"',
        "approved_by: null",
        'created_at: "2026-11-20T09:08:00Z"',
        'updated_at: "2026-11-20T09:08:00Z"',
        "decided_at: null",
        "review_by: null",
        "supersedes: []",
        "superseded_by: null",
        "related_requirements: []",
        "related_research: []",
        "approval_ref: null",
        "tags:",
        '  - "mcp"',
        '  - "copilot"',
        "---",
        "",
        "# ADR-0001",
        "",
      ].join("\n"),
      "utf8"
    );

    // Claim overlapping leases with --force to verify overlap recommendation
    createTask({ projectDir, title: "Parallel module work", createdAt: "2026-11-20T09:08:30Z" });
    const leaseCreatedAt = new Date().toISOString();
    claimTaskLease({
      projectDir,
      taskId: "TASK-0001",
      tool: "gemini",
      role: "developer",
      scopes: ["src/core"],
      createdAt: leaseCreatedAt,
    });
    claimTaskLease({
      projectDir,
      taskId: "TASK-0002",
      tool: "codex",
      role: "qa-security-reviewer",
      scopes: ["src/core/engine.mjs"],
      force: true,
      createdAt: leaseCreatedAt,
    });

    const status = getProjectStatus(projectDir);
    assert.equal(status.activeLeases.length, 2);
    assert.equal(status.leaseOverlaps.length, 1);
    const kinds = new Set(status.pendingApprovalsInbox.map((i) => i.kind));
    assert.equal(kinds.has("skill_draft"), true);
    assert.equal(kinds.has("approval_record"), true);
    assert.equal(kinds.has("adr_proposal"), true);

    // Baseline nextSteps preserved alongside new inbox hint
    assert.equal(status.nextSteps.some((s) => s.includes("geloforge context --task TASK-0001")), true);
    assert.equal(status.recommendations.some((r) => r.category === "approval_inbox"), true);
    assert.equal(status.recommendations.some((r) => r.category === "coordination"), true);

    const recCli = spawnSync(
      process.execPath,
      [CLI_PATH, "recommend", "--project", projectDir, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(recCli.status, 0, recCli.stderr);
    const recJson = JSON.parse(recCli.stdout);
    assert.equal(recJson.pendingApprovalsInbox.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("MCP server handles JSONL & LSP stdio framing and strictly refuses privileged skill actions", () => {
  const { tmp, projectDir } = initTempProject();
  try {
    createTask({
      projectDir,
      title: "Verify MCP bridge",
      activate: true,
      createdAt: "2026-11-20T09:05:00Z",
    });

    // Unit-level handleMcpMessage checks + privilege gate assertions
    const initReply = handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { defaultProjectDir: projectDir }
    );
    assert.equal(initReply.result.serverInfo.name, "geloforge-mcp");

    assert.equal(
      handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { defaultProjectDir: projectDir }),
      null
    );

    for (const blockedAction of ["promote", "rollback", "keygen", "sign"]) {
      const blocked = handleMcpMessage(
        {
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "geloforge_skills", arguments: { action: blockedAction, name: "demo" } },
        },
        { defaultProjectDir: projectDir }
      );
      assert.equal(blocked.result.isError, true);
      assert.match(blocked.result.content[0].text, /Refusing privileged skill/i);
    }

    // End-to-end stdio JSONL round-trip via CLI `geloforge mcp`
    const jsonlRequests = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "geloforge_recommend", arguments: {} } }),
    ].join("\n") + "\n";

    const jsonlProc = spawnSync(
      process.execPath,
      [CLI_PATH, "mcp", "--project", projectDir],
      { input: jsonlRequests, encoding: "utf8", windowsHide: true }
    );
    assert.equal(jsonlProc.status, 0, jsonlProc.stderr);
    const lines = jsonlProc.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[1].result.tools.length, 6);
    const recPayload = JSON.parse(lines[2].result.content[0].text);
    assert.equal(recPayload.operationalState.activeTasks[0], "TASK-0001");

    // End-to-end Content-Length LSP framing round-trip
    const reqObj = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "geloforge_checkpoint",
        arguments: { action: "create", summary: "MCP stdio test checkpoint", createdBy: "mcp-test" },
      },
    });
    const lspFrame = `Content-Length: ${Buffer.byteLength(reqObj, "utf8")}\r\n\r\n${reqObj}`;
    const lspProc = spawnSync(
      process.execPath,
      [CLI_PATH, "mcp", "serve", "--project", projectDir],
      { input: lspFrame, encoding: "utf8", windowsHide: true }
    );
    assert.equal(lspProc.status, 0, lspProc.stderr);
    assert.match(lspProc.stdout, /^Content-Length:\s*\d+\r\n\r\n/);
    const bodyStart = lspProc.stdout.indexOf("\r\n\r\n") + 4;
    const lspResp = JSON.parse(lspProc.stdout.slice(bodyStart));
    const cpPayload = JSON.parse(lspResp.result.content[0].text);
    assert.equal(cpPayload.checkpointId, "CHKPT-0001");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("concurrent two-process claimTaskLease serializes via .state.lock, enforces timeout, and recovers stale locks", async () => {
  const { tmp, projectDir } = initTempProject("gf-race-");
  try {
    createTask({ projectDir, title: "Worker task A", scopeIn: ["src/shared.mjs"], createdAt: "2026-11-20T09:05:00Z" });
    createTask({ projectDir, title: "Worker task B", scopeIn: ["src/shared.mjs"], createdAt: "2026-11-20T09:05:00Z" });

    const runClaimWorker = (taskId, tool, targetMs, holdMs = 100) =>
      new Promise((resolve) => {
        const script = [
          `import { claimTaskLease } from ${JSON.stringify(new URL("../core/task-manager.mjs", import.meta.url).href)};`,
          "const target = Number(process.argv[1]);",
          "while (Date.now() < target) {}",
          "try {",
          `  const res = claimTaskLease({ projectDir: ${JSON.stringify(projectDir)}, taskId: ${JSON.stringify(taskId)}, tool: ${JSON.stringify(tool)}, scopes: ["src/shared.mjs"], _holdLockMs: ${holdMs} });`,
          '  console.log(JSON.stringify({ ok: true, task: res.lease.task_id, tool: res.lease.tool }));',
          "} catch (err) {",
          '  console.error(JSON.stringify({ ok: false, message: err.message }));',
          "  process.exitCode = 1;",
          "}",
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, String(targetMs)], {
          cwd: HARNESS_DIR,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
          out += d;
        });
        child.stderr.on("data", (d) => {
          err += d;
        });
        child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
      });

    const targetStart = Date.now() + 350;
    const [w1, w2] = await Promise.all([
      runClaimWorker("TASK-0001", "gemini-ide", targetStart, 120),
      runClaimWorker("TASK-0002", "codex-ide", targetStart, 120),
    ]);
    const wins = [w1, w2].filter((r) => r.code === 0);
    const losses = [w1, w2].filter((r) => r.code !== 0);
    assert.equal(wins.length, 1, `Expected exactly 1 winner; got w1=${JSON.stringify(w1)} w2=${JSON.stringify(w2)}`);
    assert.equal(losses.length, 1);
    assert.match(losses[0].err, /File-scope collision/i);

    const active = listTaskLeases({ projectDir }).activeLeases;
    assert.equal(active.length, 1);
    assert.equal(fs.existsSync(path.join(projectDir, ".geloforge", ".state.lock")), false);

    const winningTaskId = active[0].task_id;
    const losingTaskId = winningTaskId === "TASK-0001" ? "TASK-0002" : "TASK-0001";

    // Bounded lockTimeoutMs while another live process holds .state.lock
    const holdScript = [
      `import { claimTaskLease } from ${JSON.stringify(new URL("../core/task-manager.mjs", import.meta.url).href)};`,
      `claimTaskLease({ projectDir: ${JSON.stringify(projectDir)}, taskId: ${JSON.stringify(winningTaskId)}, tool: ${JSON.stringify(active[0].tool)}, force: true, _holdLockMs: 450 });`,
    ].join("\n");
    const holder = spawn(process.execPath, ["--input-type=module", "-e", holdScript], {
      cwd: HARNESS_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const holderClosed = new Promise((resolve) => holder.once("close", resolve));
    // Wait until lockfile appears
    const lockPath = path.join(projectDir, ".geloforge", ".state.lock");
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(lockPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.throws(
      () =>
        claimTaskLease({
          projectDir,
          taskId: losingTaskId,
          tool: "codex-ide",
          scopes: ["docs/other.md"],
          lockTimeoutMs: 60,
        }),
      /Timed out waiting for project state lock/i
    );
    await holderClosed;

    // Stale lock recovery 1: guaranteed-dead child PID even with future expires_at
    createTask({ projectDir, title: "Stale recovery task A", scopeIn: ["docs/separate-a.md"], createdAt: "2026-11-20T09:06:00Z" });
    createTask({ projectDir, title: "Stale recovery task B", scopeIn: ["docs/separate-b.md"], createdAt: "2026-11-20T09:06:30Z" });
    const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.equal(deadChild.status, 0);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadChild.pid,
        token: "stale-dead-pid-token",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8"
    );
    const recoveredDeadPid = claimTaskLease({
      projectDir,
      taskId: "TASK-0003",
      tool: "codex-ide",
      scopes: ["docs/separate-a.md"],
      lockTimeoutMs: 1000,
    });
    assert.equal(recoveredDeadPid.lease.task_id, "TASK-0003");
    assert.equal(fs.existsSync(lockPath), false);

    // Live lock protection: an active process holding .state.lock longer than staleLockMs MUST NOT be stolen
    createTask({ projectDir, title: "Live holder task", scopeIn: ["src/live-long.mjs"], createdAt: "2026-11-20T09:07:00Z" });
    createTask({ projectDir, title: "Impatient peer task", scopeIn: ["src/live-long.mjs"], createdAt: "2026-11-20T09:07:10Z" });
    const longHoldScript = [
      `import { claimTaskLease } from ${JSON.stringify(new URL("../core/task-manager.mjs", import.meta.url).href)};`,
      `claimTaskLease({ projectDir: ${JSON.stringify(projectDir)}, taskId: "TASK-0004", tool: "live-holder-ide", scopes: ["src/live-long.mjs"], staleLockMs: 60, _holdLockMs: 360 });`,
    ].join("\n");
    const liveHolder = spawn(process.execPath, ["--input-type=module", "-e", longHoldScript], {
      cwd: HARNESS_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const liveHolderClosed = new Promise((resolve) => liveHolder.once("close", resolve));
    const waitDeadline = Date.now() + 2500;
    while (!fs.existsSync(lockPath) && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(fs.existsSync(lockPath), true, "Expected live holder lockfile to appear");

    // Attempting acquisition past staleLockMs (60ms) while lockTimeoutMs (140ms) < holdMs (360ms) must timeout, NOT steal!
    assert.throws(
      () =>
        claimTaskLease({
          projectDir,
          taskId: "TASK-0005",
          tool: "impatient-ide",
          scopes: ["src/live-long.mjs"],
          staleLockMs: 60,
          lockTimeoutMs: 140,
        }),
      /Timed out waiting for project state lock/i
    );

    // A waiter with sufficient timeout waits out the live holder cleanly (past staleLockMs) and sees committed TASK-0004 lease
    const longWaitScript = [
      `import { claimTaskLease } from ${JSON.stringify(new URL("../core/task-manager.mjs", import.meta.url).href)};`,
      "try {",
      `  claimTaskLease({ projectDir: ${JSON.stringify(projectDir)}, taskId: "TASK-0005", tool: "patient-ide", scopes: ["src/live-long.mjs"], staleLockMs: 60, lockTimeoutMs: 3000 });`,
      '  console.log("UNEXPECTED_WIN");',
      "} catch (err) {",
      "  console.error(err.message);",
      "  process.exitCode = 1;",
      "}",
    ].join("\n");
    const waiterRes = await new Promise((resolve) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", longWaitScript], {
        cwd: HARNESS_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
    });
    await liveHolderClosed;
    assert.equal(waiterRes.code, 1);
    assert.match(waiterRes.err, /File-scope collision.*TASK-0004/i);

    // Concurrent stale-lock reclaimers race: 3 independent processes racing on dead-PID lock; exactly 1 wins and 2 fail closed
    createTask({ projectDir, title: "Reclaim racer 1", scopeIn: ["src/shared-reclaim.mjs"], createdAt: "2026-11-20T09:07:20Z" });
    createTask({ projectDir, title: "Reclaim racer 2", scopeIn: ["src/shared-reclaim.mjs"], createdAt: "2026-11-20T09:07:30Z" });
    createTask({ projectDir, title: "Reclaim racer 3", scopeIn: ["src/shared-reclaim.mjs"], createdAt: "2026-11-20T09:07:40Z" });
    const deadChild2 = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
    assert.equal(deadChild2.status, 0);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadChild2.pid,
        token: "dead-race-token",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8"
    );
    const reclaimBarrier = Date.now() + 350;
    const runReclaimRacer = (taskId, tool) =>
      new Promise((resolve) => {
        const script = [
          `import { claimTaskLease } from ${JSON.stringify(new URL("../core/task-manager.mjs", import.meta.url).href)};`,
          "const t = Number(process.argv[1]);",
          "while (Date.now() < t) {}",
          "try {",
          `  const res = claimTaskLease({ projectDir: ${JSON.stringify(projectDir)}, taskId: ${JSON.stringify(taskId)}, tool: ${JSON.stringify(tool)}, scopes: ["src/shared-reclaim.mjs"], staleLockMs: 50, lockTimeoutMs: 3000, _holdLockMs: 90 });`,
          "  console.log(res.lease.task_id);",
          "} catch (e) {",
          "  console.error(e.message);",
          "  process.exitCode = 1;",
          "}",
        ].join("\n");
        const p = spawn(process.execPath, ["--input-type=module", "-e", script, String(reclaimBarrier)], {
          cwd: HARNESS_DIR,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
      });
    const racerResults = await Promise.all([
      runReclaimRacer("TASK-0006", "reclaim-a"),
      runReclaimRacer("TASK-0007", "reclaim-b"),
      runReclaimRacer("TASK-0008", "reclaim-c"),
    ]);
    assert.equal(racerResults.filter((r) => r.code === 0).length, 1);
    assert.equal(racerResults.filter((r) => r.code !== 0).length, 2);
    for (const loser of racerResults.filter((r) => r.code !== 0)) {
      assert.match(loser.err, /File-scope collision/i);
    }

    // Corrupt/pidless lockfile older than staleLockMs recovers cleanly
    createTask({ projectDir, title: "Corrupt lock target", scopeIn: ["docs/corrupt.md"], createdAt: "2026-11-20T09:07:50Z" });
    fs.writeFileSync(lockPath, "{corrupt-unparseable", "utf8");
    const pastSec = (Date.now() - 5000) / 1000;
    fs.utimesSync(lockPath, pastSec, pastSec);
    const recoveredCorrupt = claimTaskLease({
      projectDir,
      taskId: "TASK-0009",
      tool: "codex-ide",
      scopes: ["docs/corrupt.md"],
      staleLockMs: 50,
      lockTimeoutMs: 1000,
    });
    assert.equal(recoveredCorrupt.lease.task_id, "TASK-0009");
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.reclaim`), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("fault injection triggers full multi-file rollback in claimTaskLease, updateTask, completeTask, and createCheckpoint", () => {
  const { tmp, projectDir } = initTempProject("gf-tx-fault-");
  try {
    const t1 = createTask({ projectDir, title: "Transactional check", createdAt: "2026-11-20T09:05:00Z" });
    const statePath = path.join(projectDir, "brain", "state", "current.yaml");
    const leasesPath = path.join(projectDir, ".geloforge", "task-leases.yaml");

    const snapTaskBeforeClaim = fs.readFileSync(t1.filePath, "utf8");
    const snapStateBeforeClaim = fs.readFileSync(statePath, "utf8");

    // 1. Fault on state write during claimTaskLease rolls back leases & task file
    assert.throws(
      () =>
        claimTaskLease({
          projectDir,
          taskId: "TASK-0001",
          tool: "gemini",
          scopes: ["src/a.mjs"],
          _faultHook: (label) => {
            if (label === "state") throw new Error("Simulated state write failure");
          },
        }),
      /Simulated state write failure/
    );
    assert.equal(fs.existsSync(leasesPath), false, "Newly created leases file must roll back cleanly");
    assert.equal(fs.readFileSync(t1.filePath, "utf8"), snapTaskBeforeClaim);
    assert.equal(fs.readFileSync(statePath, "utf8"), snapStateBeforeClaim);

    // Succeed normal claim, then inject fault on leases removal during completeTask
    claimTaskLease({ projectDir, taskId: "TASK-0001", tool: "gemini", scopes: ["src/a.mjs"] });
    const snapTaskActive = fs.readFileSync(t1.filePath, "utf8");
    const snapStateActive = fs.readFileSync(statePath, "utf8");
    const snapLeasesActive = fs.readFileSync(leasesPath, "utf8");

    assert.throws(
      () =>
        completeTask({
          projectDir,
          taskId: "TASK-0001",
          tool: "gemini",
          _faultHook: (label) => {
            if (label === "leases") throw new Error("Simulated leases write failure");
          },
        }),
      /Simulated leases write failure/
    );
    assert.equal(fs.readFileSync(t1.filePath, "utf8"), snapTaskActive);
    assert.equal(fs.readFileSync(statePath, "utf8"), snapStateActive);
    assert.equal(fs.readFileSync(leasesPath, "utf8"), snapLeasesActive);

    // Fault on state write during updateTask rolls back task file cleanly
    assert.throws(
      () =>
        updateTask({
          projectDir,
          taskId: "TASK-0001",
          priority: "critical",
          tool: "gemini",
          _faultHook: (label) => {
            if (label === "state") throw new Error("Simulated update state fault");
          },
        }),
      /Simulated update state fault/
    );
    assert.equal(fs.readFileSync(t1.filePath, "utf8"), snapTaskActive);
    assert.equal(fs.readFileSync(statePath, "utf8"), snapStateActive);

    // Fault on state write during createCheckpoint unlinks newly written CHKPT-0001
    assert.throws(
      () =>
        createCheckpoint({
          projectDir,
          summary: "Should roll back cleanly",
          _faultHook: (label) => {
            if (label === "state") throw new Error("Simulated checkpoint state fault");
          },
        }),
      /Simulated checkpoint state fault/
    );
    assert.equal(fs.existsSync(path.join(projectDir, "brain", "handoffs", "CHKPT-0001-checkpoint.yaml")), false);
    assert.equal(fs.readFileSync(statePath, "utf8"), snapStateActive);
    assert.equal(validateProject(projectDir).valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("lease ownership distinguishes advisory labels and blocks unintended peer releases unless --force", () => {
  const { tmp, projectDir } = initTempProject("gf-owner-");
  try {
    createTask({ projectDir, title: "Peer ownership guard", createdAt: "2026-11-20T09:05:00Z" });
    const claim = claimTaskLease({
      projectDir,
      taskId: "TASK-0001",
      tool: "gemini-cli",
      sessionId: "gemini-win-1",
      scopes: ["src/core"],
      createdAt: "2026-11-20T09:06:00Z",
    });
    assert.equal(claim.lease.identity_mode, "advisory_self_declared");
    assert.equal(claim.identityModel, "advisory_self_declared");

    // Wrong tool or wrong sessionId cannot release or close active peer lease
    assert.throws(
      () => releaseTaskLease({ projectDir, taskId: "TASK-0001", sessionId: "codex-win-2", nowIso: "2026-11-20T09:10:00Z" }),
      /Lease ownership mismatch/i
    );
    assert.throws(
      () => completeTask({ projectDir, taskId: "TASK-0001", tool: "codex-cli", updatedAt: "2026-11-20T09:10:00Z" }),
      /Lease ownership mismatch/i
    );

    // Matching advisory session confirms release cleanly
    const rel = releaseTaskLease({
      projectDir,
      taskId: "TASK-0001",
      sessionId: "gemini-win-1",
      nowIso: "2026-11-20T09:10:00Z",
    });
    assert.equal(rel.released, true);
    assert.equal(rel.releasedByOverride, false);

    // Re-claim and verify explicit --force override works
    claimTaskLease({
      projectDir,
      taskId: "TASK-0001",
      tool: "gemini-cli",
      sessionId: "gemini-win-1",
      scopes: ["src/core"],
      createdAt: "2026-11-20T09:11:00Z",
    });
    const forced = releaseTaskLease({
      projectDir,
      taskId: "TASK-0001",
      tool: "human-override",
      force: true,
      nowIso: "2026-11-20T09:12:00Z",
    });
    assert.equal(forced.released, true);
    assert.equal(forced.releasedByOverride, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("task done separates completion from verified evidence and enforces --require-evidence cleanly", () => {
  const { tmp, projectDir } = initTempProject("gf-evid-truth-");
  try {
    createTask({ projectDir, title: "Task without test", activate: true, createdAt: "2026-11-20T09:05:00Z" });
    createTask({ projectDir, title: "Task with test", activate: true, createdAt: "2026-11-20T09:05:30Z" });

    // 1. Completing TASK-0001 without evidence warns honestly and leaves state.last_verified_evidence null
    const unverifiedDone = completeTask({ projectDir, taskId: "TASK-0001", updatedAt: "2026-11-20T09:06:00Z" });
    assert.equal(unverifiedDone.verified, false);
    assert.equal(unverifiedDone.verificationStatus, "unverified");
    assert.ok(unverifiedDone.warnings.some((w) => /not verified test evidence/i.test(w)));
    const st1 = parseYaml(fs.readFileSync(path.join(projectDir, "brain", "state", "current.yaml"), "utf8"));
    assert.equal(st1.last_verified_evidence, null);

    // 2. Capture failing command -> draft EVID-0001 (NOT verified)
    const failEv = captureEvidence({
      projectDir,
      taskId: "TASK-0002",
      commandArgv: ["node", "-e", "process.exit(1)"],
      createdAt: "2026-11-20T09:07:00Z",
    });
    assert.equal(failEv.verified, false);

    // Refuses --require-evidence on unverified TASK-0002 and refuses linking draft/failed EVID-0001
    assert.throws(
      () => completeTask({ projectDir, taskId: "TASK-0002", requireEvidence: true }),
      /Refusing to mark TASK-0002 completed with --require-evidence/i
    );
    assert.throws(
      () => completeTask({ projectDir, taskId: "TASK-0002", evidenceRefs: [failEv.id] }),
      /Refusing to link unverified evidence/i
    );
    assert.throws(
      () => createCheckpoint({ projectDir, summary: "Bad ref", evidenceRef: failEv.id }),
      /Refusing to link unverified evidence/i
    );

    // 3. Fix check -> capture passing command -> EVID-0002 (verified)
    const passEv = captureEvidence({
      projectDir,
      taskId: "TASK-0002",
      commandArgv: ["node", "-e", "console.log('verified')"],
      verifiedBy: "qa-reviewer",
      createdAt: "2026-11-20T09:08:00Z",
    });
    assert.equal(passEv.verified, true);

    // Complete cleanly via CLI with --require-evidence (fails if unverified EVID-0001 still attached, so check explicit fix or new task!)
    createTask({ projectDir, title: "Clean verified task", activate: true, createdAt: "2026-11-20T09:08:30Z" });
    const passEv2 = captureEvidence({
      projectDir,
      taskId: "TASK-0003",
      commandArgv: ["node", "-e", "console.log('clean pass')"],
      verifiedBy: "qa-reviewer",
      createdAt: "2026-11-20T09:09:00Z",
    });
    const cliDone = spawnSync(
      process.execPath,
      [CLI_PATH, "task", "done", "--project", projectDir, "TASK-0003", "--require-evidence", "--evidence", passEv2.id, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(cliDone.status, 0, cliDone.stderr);
    const doneJson = JSON.parse(cliDone.stdout);
    assert.equal(doneJson.verified, true);
    assert.equal(doneJson.verificationStatus, "verified");
    assert.deepEqual(doneJson.verifiedEvidenceRefs, [passEv2.id]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("MCP stdio enforces framing size bounds, malformed frame recovery, root confinement, and --read-only disclosure", async () => {
  const { tmp: tmpA, projectDir: projectA } = initTempProject("gf-mcp-a-");
  const { tmp: tmpB, projectDir: projectB } = initTempProject("gf-mcp-b-");
  try {
    assert.equal(MAX_MCP_MESSAGE_BYTES, 1024 * 1024);
    assert.equal(MAX_MCP_HEADER_BYTES, 4096);

    // Verify tool mutation metadata disclosure
    const statusTool = MCP_TOOLS.find((t) => t.name === "geloforge_status");
    const taskTool = MCP_TOOLS.find((t) => t.name === "geloforge_task");
    assert.equal(statusTool.annotations.readOnlyHint, true);
    assert.equal(taskTool.annotations.readOnlyHint, false);
    assert.ok(taskTool.annotations.mutatingActions.includes("done"));

    // Reject batch array JSON-RPC and non-trusted cross-project target escape
    const arrErr = handleMcpMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }], { defaultProjectDir: projectA });
    assert.equal(arrErr.error.code, -32600);

    const escapeCall = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "geloforge_task", arguments: { action: "new", project: projectB, title: "Out of bounds write" } },
      },
      { defaultProjectDir: projectA }
    );
    assert.equal(escapeCall.result.isError, true);
    assert.match(escapeCall.result.content[0].text, /outside trusted project root/i);

    const skillEscape = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "geloforge_skills", arguments: { action: "list", project: projectB } },
      },
      { defaultProjectDir: projectA }
    );
    assert.equal(skillEscape.result.isError, true);
    assert.match(skillEscape.result.content[0].text, /outside trusted project root/i);

    // --read-only permits read queries and refuses mutating actions cleanly
    const roRead = handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "geloforge_status", arguments: {} } },
      { defaultProjectDir: projectA, readOnly: true }
    );
    assert.equal(roRead.result.isError, false);

    const roMutate = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "geloforge_task", arguments: { action: "new", title: "Blocked write" } },
      },
      { defaultProjectDir: projectA, readOnly: true }
    );
    assert.equal(roMutate.result.isError, true);
    assert.match(roMutate.result.content[0].text, /--read-only/i);
    assert.match(roMutate.result.content[0].text, /Hint: Read-only actions allowed: list, show, leases\./);

    for (const toolName of ["geloforge_context", "geloforge_task", "geloforge_checkpoint", "geloforge_skills"]) {
      const def = MCP_TOOLS.find((t) => t.name === toolName);
      assert.ok(Array.isArray(def?.input_examples) && def.input_examples.length >= 1, `${toolName} should expose input_examples`);
    }
    const invalidTaskAction = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "geloforge_task", arguments: { action: "bogus" } },
      },
      { defaultProjectDir: projectA }
    );
    assert.equal(invalidTaskAction.result.isError, true);
    assert.match(invalidTaskAction.result.content[0].text, /Hint: Valid actions: .* Example:/);

    const missingContextTarget = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "geloforge_context", arguments: {} },
      },
      { defaultProjectDir: projectA }
    );
    assert.equal(missingContextTarget.result.isError, true);
    assert.match(missingContextTarget.result.content[0].text, /Hint: Pass at least one target:/);

    // Stdio framing bounds & recovery test: oversized Content-Length + negative Content-Length + multi-header valid ping
    const inLsp = new PassThrough();
    const outLsp = new PassThrough();
    let lspOutText = "";
    outLsp.on("data", (d) => {
      lspOutText += d.toString("utf8");
    });

    const srvLsp = startMcpStdioServer({
      defaultProjectDir: projectA,
      input: inLsp,
      output: outLsp,
      maxMessageBytes: 256,
      maxHeaderBytes: 128,
    });

    const oversizedBody = "x".repeat(400);
    const validPing = JSON.stringify({ jsonrpc: "2.0", id: 77, method: "ping" });
    inLsp.write(`Content-Length: ${oversizedBody.length}\r\n\r\n${oversizedBody}`);
    inLsp.write("Content-Length: -5\r\n\r\n");
    inLsp.write(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(validPing, "utf8")}\r\n\r\n${validPing}`
    );
    inLsp.end();
    await srvLsp;

    assert.match(lspOutText, /exceeds maxMessageBytes/i);
    assert.match(lspOutText, /Invalid Content-Length header/i);
    assert.match(lspOutText, /"id":77,"result":\{\}/);

    // JSONL oversized line followed by valid ping recovery
    const inJsonl = new PassThrough();
    const outJsonl = new PassThrough();
    let jsonlOutText = "";
    outJsonl.on("data", (d) => {
      jsonlOutText += d.toString("utf8");
    });
    const srvJsonl = startMcpStdioServer({
      defaultProjectDir: projectA,
      input: inJsonl,
      output: outJsonl,
      maxMessageBytes: 128,
    });
    inJsonl.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "y".repeat(200) } })}\n`);
    inJsonl.write(`${JSON.stringify({ jsonrpc: "2.0", id: 88, method: "ping" })}\n`);
    inJsonl.end();
    await srvJsonl;

    const jsonlLines = jsonlOutText.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(jsonlLines.length, 2);
    assert.equal(jsonlLines[0].error.code, -32600);
    assert.equal(jsonlLines[1].id, 88);
  } finally {
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  }
});

test("process-interruption rollback journal (.tx-journal.json) recovers interrupted partial writes on next locked call", () => {
  const { tmp, projectDir } = initTempProject("gf-tx-journal-");
  try {
    const t1 = createTask({ projectDir, title: "Interrupted claim target", scopeIn: ["src/journal.mjs"], createdAt: "2026-11-20T09:05:00Z" });
    const statePath = path.join(projectDir, "brain", "state", "current.yaml");
    const leasesPath = path.join(projectDir, ".geloforge", "task-leases.yaml");
    const journalPath = path.join(projectDir, ".geloforge", ".tx-journal.json");
    const lockPath = path.join(projectDir, ".geloforge", ".state.lock");

    const preCrashTask = fs.readFileSync(t1.filePath, "utf8");
    const preCrashState = fs.readFileSync(statePath, "utf8");

    // Simulate abrupt mid-transaction child process termination AFTER leases file is written (bypassing catch & finally)
    const crashScript = [
      `import { claimTaskLease } from ${JSON.stringify(new URL("../core/task-manager.mjs", import.meta.url).href)};`,
      `claimTaskLease({`,
      `  projectDir: ${JSON.stringify(projectDir)},`,
      `  taskId: "TASK-0001",`,
      `  tool: "crashed-ide",`,
      `  scopes: ["src/journal.mjs"],`,
      `  _faultHook: (label) => { if (label === "after:leases") process.exit(99); },`,
      `});`,
    ].join("\n");
    const crashProc = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript], {
      cwd: HARNESS_DIR,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(crashProc.status, 99);
    assert.equal(fs.existsSync(journalPath), true, "Pending rollback journal should exist after abrupt process exit");
    assert.equal(fs.existsSync(lockPath), true, "Orphan lockfile should exist after abrupt process exit");
    assert.equal(fs.existsSync(leasesPath), true, "Partial leases file was written before termination");
    assert.match(fs.readFileSync(leasesPath, "utf8"), /crashed-ide/);

    // Next locked operation reclaims dead PID lock and replays .tx-journal.json automatically before executing
    const recoveryUpdate = updateTask({
      projectDir,
      taskId: "TASK-0001",
      priority: "high",
      updatedAt: "2026-11-20T09:10:00Z",
    });
    assert.equal(recoveryUpdate.record.priority, "high");
    assert.deepEqual(recoveryUpdate.activeTasks, []);
    assert.equal(fs.existsSync(journalPath), false, "Journal must be cleared after recovery");
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(leasesPath), false, "Interrupted newly-created leases file must be unlinked by journal replay");
    const stateAfterFirst = parseYaml(fs.readFileSync(statePath, "utf8"));
    assert.equal(stateAfterFirst.state_revision, 1);
    assert.deepEqual(stateAfterFirst.active_tasks, []);
    assert.notEqual(fs.readFileSync(t1.filePath, "utf8"), preCrashTask);

    // Second interruption: crash AFTER mutating an existing task file, then verify exact pre-image restoration
    const stableTaskSnap = fs.readFileSync(t1.filePath, "utf8");
    const crashUpdateScript = [
      `import { updateTask } from ${JSON.stringify(new URL("../core/task-manager.mjs", import.meta.url).href)};`,
      `updateTask({`,
      `  projectDir: ${JSON.stringify(projectDir)},`,
      `  taskId: "TASK-0001",`,
      `  priority: "critical",`,
      `  updatedAt: "2026-11-20T09:15:00Z",`,
      `  _faultHook: (label) => { if (label === "after:task") process.exit(98); },`,
      `});`,
    ].join("\n");
    const crashProc2 = spawnSync(process.execPath, ["--input-type=module", "-e", crashUpdateScript], {
      cwd: HARNESS_DIR,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(crashProc2.status, 98);
    assert.match(fs.readFileSync(t1.filePath, "utf8"), /priority:\s*"critical"/);
    assert.equal(fs.existsSync(journalPath), true);

    const noopRecovery = withProjectLock(projectDir, () => "recovered");
    assert.equal(noopRecovery, "recovered");
    assert.equal(fs.readFileSync(t1.filePath, "utf8"), stableTaskSnap, "Pre-existing task file must be restored from .tx-journal.json");
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(validateProject(projectDir).valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("unpinned MCP server launched outside a project without --project fails closed across all tools", () => {
  const { tmp: tmpProj, projectDir: projectA } = initTempProject("gf-unpinned-target-");
  const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gf-outside-cwd-"));
  try {
    createTask({ projectDir: projectA, title: "Target should never be touched", activate: true, createdAt: "2026-11-20T09:05:00Z" });
    const stateBefore = fs.readFileSync(path.join(projectA, "brain", "state", "current.yaml"), "utf8");

    const blockedCalls = [
      { name: "geloforge_status", arguments: { project: projectA } },
      { name: "geloforge_recommend", arguments: { project: projectA } },
      { name: "geloforge_context", arguments: { project: projectA, query: "test" } },
      { name: "geloforge_task", arguments: { action: "list", project: projectA } },
      { name: "geloforge_task", arguments: { action: "new", project: projectA, title: "Unauthorized external task" } },
      { name: "geloforge_checkpoint", arguments: { action: "create", project: projectA, summary: "Unauthorized checkpoint" } },
      { name: "geloforge_skills", arguments: { action: "list", project: projectA } },
    ];

    for (let i = 0; i < blockedCalls.length; i += 1) {
      const reply = handleMcpMessage(
        { jsonrpc: "2.0", id: i + 1, method: "tools/call", params: blockedCalls[i] },
        { defaultProjectDir: null, cwd: outsideCwd }
      );
      assert.equal(reply.result.isError, true, `Expected fail-closed refusal for ${blockedCalls[i].name}`);
      assert.match(reply.result.content[0].text, /without a trusted project root/i);
    }

    // End-to-end CLI invocation launched from outside any project without --project
    const cliReq = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "geloforge_task", arguments: { action: "new", project: projectA, title: "CLI unpinned bypass" } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "geloforge_skills", arguments: { action: "list", project: projectA } },
      }),
    ].join("\n") + "\n";

    const cliProc = spawnSync(process.execPath, [CLI_PATH, "mcp"], {
      cwd: outsideCwd,
      input: cliReq,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliProc.status, 0, cliProc.stderr);
    const replies = cliProc.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(replies.length, 3);
    assert.equal(replies[1].result.isError, true);
    assert.match(replies[1].result.content[0].text, /without a trusted project root/i);
    assert.equal(replies[2].result.isError, true);
    assert.match(replies[2].result.content[0].text, /without a trusted project root/i);

    assert.equal(fs.readFileSync(path.join(projectA, "brain", "state", "current.yaml"), "utf8"), stateBefore);
  } finally {
    fs.rmSync(tmpProj, { recursive: true, force: true });
    fs.rmSync(outsideCwd, { recursive: true, force: true });
  }
});
