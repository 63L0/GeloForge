import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
import { handleMcpMessage } from "../core/mcp-server.mjs";
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

    // Release lease 1 via CLI
    const relCli = spawnSync(
      process.execPath,
      [CLI_PATH, "task", "release", "--project", projectDir, "TASK-0001", "--created-at", "2026-11-20T10:30:00Z", "--json"],
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
    claimTaskLease({
      projectDir,
      taskId: "TASK-0001",
      tool: "gemini",
      role: "developer",
      scopes: ["src/core"],
      createdAt: "2026-11-20T09:09:00Z",
    });
    claimTaskLease({
      projectDir,
      taskId: "TASK-0002",
      tool: "codex",
      role: "qa-security-reviewer",
      scopes: ["src/core/engine.mjs"],
      force: true,
      createdAt: "2026-11-20T09:09:30Z",
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
