import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { runProjectDoctor } from "../core/doctor.mjs";
import { handleMcpMessage } from "../core/mcp-server.mjs";
import { generateProjectReport } from "../core/project-report.mjs";
import { getProjectRecommendations } from "../core/project-status.mjs";
import { promoteSkillProposal } from "../core/skills-lifecycle.mjs";
import { completeTask, createTask } from "../core/task-manager.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");

function runCli(args, { cwd = HARNESS_DIR } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
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

test("geloforge compact and doctor session_hygiene compact long sessions and prune completed tasks", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-compact-"));
  const isolatedGlobal = path.join(tmp, "empty-global");
  fs.mkdirSync(isolatedGlobal, { recursive: true });
  try {
    const projectDir = path.join(tmp, "app");
    bootstrapProject({ name: "Compact App", dest: projectDir, git: true });
    initGitCommit(projectDir);

    const t1 = createTask({ projectDir, harnessDir: HARNESS_DIR, title: "Completed baseline task", activate: true });
    completeTask({ projectDir, harnessDir: HARNESS_DIR, taskId: t1.id });

    // Create 4 active tasks to trigger session_hygiene warning in doctor & recommend
    const activeIds = [];
    for (let i = 1; i <= 4; i += 1) {
      activeIds.push(createTask({ projectDir, harnessDir: HARNESS_DIR, title: `Active stream ${i}`, activate: true }).id);
    }

    const beforeDoc = await runProjectDoctor({
      projectDir,
      harnessDir: HARNESS_DIR,
      globalSkillsDir: isolatedGlobal,
      checkMcp: false,
    });
    const beforeHygiene = beforeDoc.checks.find((c) => c.id === "session_hygiene");
    assert.equal(beforeHygiene.status, "warn");
    assert.equal(beforeHygiene.fix, "geloforge compact");

    const recs = getProjectRecommendations(projectDir).recommendations;
    assert.ok(recs.some((r) => r.category === "session_compaction" && r.command === "geloforge compact"));

    // Dry-run does not create checkpoint files
    const dryRes = runCli(["compact", "--project", projectDir, "--dry-run", "--json"]);
    assert.equal(dryRes.status, 0, dryRes.stderr || dryRes.stdout);
    const dryJson = JSON.parse(dryRes.stdout);
    assert.equal(dryJson.dryRun, true);
    assert.equal(dryJson.checkpointId, "CHKPT-0001");
    assert.equal(fs.existsSync(path.join(projectDir, dryJson.recordPath)), false);

    // Real compaction writes CHKPT-0001, prunes TASK-0001 from context packet, writes --out packet
    const outPacketPath = path.join(tmp, "resume-packet.md");
    const compactRes = runCli([
      "checkpoint",
      "compact",
      "--project",
      projectDir,
      "--task",
      activeIds[0],
      "--summary",
      "Completed baseline and isolated active stream",
      "--out",
      outPacketPath,
      "--json",
    ]);
    assert.equal(compactRes.status, 0, compactRes.stderr || compactRes.stdout);
    const compactJson = JSON.parse(compactRes.stdout);
    assert.equal(compactJson.checkpointId, "CHKPT-0001");
    assert.equal(fs.existsSync(path.join(projectDir, compactJson.recordPath)), true);
    assert.equal(fs.existsSync(outPacketPath), true);
    assert.match(compactJson.freshSessionPrompt, /geloforge checkpoint resume --id CHKPT-0001/);
    assert.match(compactJson.freshSessionPrompt, new RegExp(`--task ${activeIds[0]}`));
    assert.equal(compactJson.contextPacket.markdown.includes("Completed baseline task"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("starter skill catalog templates scaffold lint-clean quarantined drafts cleanly", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-catalog-"));
  const isolatedGlobal = path.join(tmp, "empty-global");
  fs.mkdirSync(isolatedGlobal, { recursive: true });
  try {
    const projectDir = path.join(tmp, "web-app");
    bootstrapProject({ name: "Catalog App", dest: projectDir, profile: "web", git: true });
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "catalog-app", dependencies: { react: "^19.0.0", next: "^15.0.0" }, scripts: { test: "node --test" } }, null, 2),
      "utf8"
    );

    const listRes = runCli(["skills", "suggest", "--project", projectDir, "--global-dir", isolatedGlobal, "--json"]);
    assert.equal(listRes.status, 0, listRes.stderr || listRes.stdout);
    const listJson = JSON.parse(listRes.stdout);
    assert.equal(listJson.starterCatalog[0].id, "web-ui-verification");
    assert.ok(listJson.starterCatalog.length >= 5);

    const badTpl = runCli(["skills", "suggest", "--project", projectDir, "--template", "nonexistent-tpl"]);
    assert.equal(badTpl.status, 1);
    assert.match(badTpl.stderr, /Unknown starter skill template/);

    const scaffoldRes = runCli([
      "skills",
      "suggest",
      "--project",
      projectDir,
      "--global-dir",
      isolatedGlobal,
      "--template",
      "web-ui-verification",
      "--scaffold-draft",
      "--json",
    ]);
    assert.equal(scaffoldRes.status, 0, scaffoldRes.stderr || scaffoldRes.stdout);
    const scaffoldJson = JSON.parse(scaffoldRes.stdout);
    assert.equal(scaffoldJson.selectedTemplate, "web-ui-verification");
    assert.equal(scaffoldJson.scaffoldResult.quarantined, true);
    assert.equal(scaffoldJson.scaffoldResult.promotable, false);
    assert.equal(scaffoldJson.scaffoldResult.lintPassed, true);
    assert.equal(fs.existsSync(path.join(projectDir, "proposals", "skills", "web-ui-verification", "SKILL.md")), true);

    // Promote stays fail-closed until verified EVID-* is captured
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir,
          harnessDir: HARNESS_DIR,
          skillName: "web-ui-verification",
          interactiveConfirm: () => true,
        }),
      /Proposal metadata missing|Refusing untrusted proposal/i
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("geloforge report summarizes verified tasks/evidence/checkpoints/doctor and blocks unsafe --out", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-report-"));
  try {
    const projectDir = path.join(tmp, "rep-app");
    bootstrapProject({ name: "Report App", dest: projectDir, git: true });
    initGitCommit(projectDir);

    const t1 = createTask({ projectDir, harnessDir: HARNESS_DIR, title: "Verify math check", activate: true });
    const ev = runCli(["verify", "--project", projectDir, "--task", t1.id, "--", process.execPath, "-e", "process.exit(0)"]);
    assert.equal(ev.status, 0, ev.stderr || ev.stdout);

    const reportOut = path.join(tmp, "pr-report.md");
    const repRes = runCli(["report", "--project", projectDir, "--task", t1.id, "--out", reportOut, "--json"]);
    assert.equal(repRes.status, 0, repRes.stderr || repRes.stdout);
    const repJson = JSON.parse(repRes.stdout);
    assert.equal(repJson.valid, true);
    assert.equal(repJson.healthy, true);
    assert.equal(repJson.summary.verifiedEvidenceCount, 1);
    assert.equal(fs.existsSync(reportOut), true);
    assert.match(repJson.markdown, /# GeloForge Verification Report/);
    assert.match(repJson.markdown, /EVID-0001/);
    assert.match(repJson.markdown, /Doctor Health Checks/);

    await assert.rejects(
      () => generateProjectReport({ projectDir, harnessDir: HARNESS_DIR, out: path.join(projectDir, ".env") }),
      /sensitive secret\/credential/i
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("MCP geloforge_checkpoint compact/resume and geloforge_skills template honor read-only boundaries", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-mcp-compact-"));
  try {
    const projectDir = path.join(tmp, "mcp-app");
    bootstrapProject({ name: "MCP Compact App", dest: projectDir, profile: "automation", git: true });
    const t1 = createTask({ projectDir, harnessDir: HARNESS_DIR, title: "MCP resume test", activate: true });

    const roBlocked = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "geloforge_checkpoint", arguments: { action: "compact", summary: "Blocked" } },
      },
      { defaultProjectDir: projectDir, harnessDir: HARNESS_DIR, readOnly: true }
    );
    assert.equal(roBlocked.result.isError, true);

    const compactReply = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "geloforge_checkpoint", arguments: { action: "compact", task: t1.id, summary: "Via MCP" } },
      },
      { defaultProjectDir: projectDir, harnessDir: HARNESS_DIR, readOnly: false }
    );
    assert.equal(compactReply.result.isError, false, compactReply.result.content[0].text);
    const compactPayload = JSON.parse(compactReply.result.content[0].text);
    assert.equal(compactPayload.checkpointId, "CHKPT-0001");
    assert.match(compactPayload.freshSessionPrompt, /CHKPT-0001/);

    const roResume = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "geloforge_checkpoint", arguments: { action: "resume" } },
      },
      { defaultProjectDir: projectDir, harnessDir: HARNESS_DIR, readOnly: true }
    );
    assert.equal(roResume.result.isError, false, roResume.result.content[0].text);
    assert.equal(JSON.parse(roResume.result.content[0].text).checkpointId, "CHKPT-0001");

    const tplReply = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "geloforge_skills",
          arguments: { action: "scaffold", template: "automation-workflow-guardrails" },
        },
      },
      { defaultProjectDir: projectDir, harnessDir: HARNESS_DIR, readOnly: false }
    );
    assert.equal(tplReply.result.isError, false, tplReply.result.content[0].text);
    const tplPayload = JSON.parse(tplReply.result.content[0].text);
    assert.equal(tplPayload.selectedTemplate, "automation-workflow-guardrails");
    assert.equal(tplPayload.scaffoldResult.quarantined, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
