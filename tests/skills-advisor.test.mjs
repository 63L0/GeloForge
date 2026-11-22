import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { createTask } from "../core/task-manager.mjs";
import { captureEvidence } from "../core/evidence-capture.mjs";
import { discoverSkills } from "../core/skills.mjs";
import { promoteSkillProposal } from "../core/skills-lifecycle.mjs";
import { suggestProjectSkills } from "../core/skills-advisor.mjs";
import { handleMcpMessage } from "../core/mcp-server.mjs";

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

function writeSkill(rootDir, name, description, tags, triggers, body) {
  const dir = path.join(rootDir, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: "${description}"`,
      "license: MIT",
      "metadata:",
      `  geloforge_tags: "${tags.join(", ")}"`,
      `  geloforge_triggers: "${triggers.join(", ")}"`,
      "---",
      "",
      `# ${name}`,
      "",
      "## When to Use",
      "",
      body,
      "",
    ].join("\n"),
    "utf8"
  );
}

test("skills-advisor detects stack/commands and ranks matching active skills above unrelated skills", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-adv-rank-"));
  const isolatedGlobal = path.join(tmp, "empty-global");
  fs.mkdirSync(isolatedGlobal, { recursive: true });
  try {
    const projectDir = path.join(tmp, "app");
    bootstrapProject({ name: "Postgres API App", dest: projectDir, git: false });

    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify(
        {
          name: "postgres-api-app",
          dependencies: { express: "^4.18.0", pg: "^8.11.0" },
          devDependencies: { vitest: "^1.0.0" },
          scripts: { test: "vitest run", lint: "eslint ." },
        },
        null,
        2
      ),
      "utf8"
    );
    fs.mkdirSync(path.join(projectDir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8");
    fs.writeFileSync(
      path.join(projectDir, "brain", "requirements", "constraints.md"),
      [
        "# Constraints",
        "",
        "- Parameterize all Postgres migration queries inside transactions.",
        "- Verify Vitest migration checks before release.",
        "",
      ].join("\n"),
      "utf8"
    );

    writeSkill(
      projectDir,
      "postgres-migration-verify",
      "Verify PostgreSQL schema migrations inside explicit database transactions with Vitest checks.",
      ["postgres", "migration", "vitest", "sql"],
      ["database migration", "postgres schema"],
      "Use this skill whenever validating Postgres schema migrations or running Vitest database tests."
    );
    writeSkill(
      projectDir,
      "mobile-swift-packaging",
      "Prepare Apple iOS Xcode TestFlight archive packages and App Store provisioning bundles.",
      ["ios", "swift", "xcode"],
      ["testflight", "swift package"],
      "Use this skill for Apple Xcode and Swift iOS mobile archive packaging."
    );

    const task = createTask({
      projectDir,
      harnessDir: HARNESS_DIR,
      title: "Harden Postgres migration rollback tests",
      objective: "Run migration safety tests against PostgreSQL transactions.",
      activate: true,
    });

    const result = suggestProjectSkills({
      projectDir,
      harnessDir: HARNESS_DIR,
      globalSkillsDir: isolatedGlobal,
      taskId: task.id,
      goal: "verify database migrations in postgres",
    });

    assert.equal(result.detectedSignals.stacks.includes("node"), true);
    assert.equal(result.detectedSignals.stacks.includes("postgres"), true);
    assert.equal(result.detectedSignals.stacks.includes("express"), true);
    assert.equal(result.detectedSignals.stacks.includes("vitest"), true);
    assert.equal(result.detectedSignals.stacks.includes("github-actions"), true);
    assert.deepEqual(
      result.detectedSignals.commands.map((c) => c.command),
      ["npm test", "npm run lint"]
    );
    assert.ok(result.recommendedSkills.length >= 1);
    assert.equal(result.recommendedSkills[0].name, "postgres-migration-verify");
    assert.equal(
      result.recommendedSkills.some((s) => s.name === "mobile-swift-packaging"),
      false
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("skills-advisor detects evidence-backed gap and scaffolds promotable quarantined draft without touching .agents/skills", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-adv-evid-"));
  const isolatedGlobal = path.join(tmp, "empty-global");
  fs.mkdirSync(isolatedGlobal, { recursive: true });
  try {
    const projectDir = path.join(tmp, "evid-app");
    bootstrapProject({ name: "Webhook Verifier", dest: projectDir, git: false });
    const t = createTask({
      projectDir,
      harnessDir: HARNESS_DIR,
      title: "Verify webhook HMAC signatures",
      objective: "Validate Meta webhook signature checks cleanly.",
      activate: true,
    });
    const ev = captureEvidence({
      projectDir,
      harnessDir: HARNESS_DIR,
      taskId: t.id,
      name: "Webhook HMAC test",
      commandArgv: [process.execPath, "-e", "console.log('webhook hmac ok'); process.exit(0);"],
      createdAt: "2026-11-22T10:00:00Z",
    });
    assert.equal(ev.verified, true);

    const advised = suggestProjectSkills({
      projectDir,
      harnessDir: HARNESS_DIR,
      globalSkillsDir: isolatedGlobal,
      taskId: t.id,
      scaffoldDraft: true,
      createdAt: "2026-11-22T10:05:00Z",
    });

    assert.ok(advised.skillGaps.some((g) => g.kind === "evidence_backed_workflow"));
    assert.ok(advised.scaffoldResult);
    assert.equal(advised.scaffoldResult.mode, "evidence_draft");
    assert.equal(advised.scaffoldResult.quarantined, true);
    assert.equal(advised.scaffoldResult.promotable, true);
    assert.equal(
      fs.existsSync(path.join(projectDir, advised.scaffoldResult.proposalDir, "SKILL.md")),
      true
    );
    assert.equal(
      fs.existsSync(path.join(projectDir, advised.scaffoldResult.proposalMetaPath)),
      true
    );
    assert.equal(fs.existsSync(path.join(projectDir, ".agents", "skills")), false);

    const disc = discoverSkills({
      projectDir,
      globalSkillsDir: isolatedGlobal,
      proposalsDir: "proposals",
      includeDrafts: false,
    });
    assert.equal(disc.activeSkills.length, 0);
    assert.equal(disc.quarantinedSkills.length, 1);
    assert.equal(disc.quarantinedSkills[0].valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("skills-advisor day-1 goal scaffold stays strictly quarantined, passes strict lint, and promote fails closed", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-adv-day1-"));
  const isolatedGlobal = path.join(tmp, "empty-global");
  fs.mkdirSync(isolatedGlobal, { recursive: true });
  try {
    const projectDir = path.join(tmp, "day1-app");
    bootstrapProject({ name: "Quote Engine", dest: projectDir, git: false });
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "quote-engine", scripts: { test: "node --test" } }, null, 2),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projectDir, "brain", "requirements", "constraints.md"),
      "# Constraints\n\n- Require deterministic quotation totals across currencies.\n",
      "utf8"
    );

    const res = suggestProjectSkills({
      projectDir,
      harnessDir: HARNESS_DIR,
      globalSkillsDir: isolatedGlobal,
      goal: "Verify multi-currency quotation math",
      scaffoldDraft: true,
      createdAt: "2026-11-22T10:10:00Z",
    });

    assert.equal(res.skillGaps[0].kind, "goal_workflow");
    assert.equal(res.scaffoldResult.mode, "repo_scaffold_quarantined");
    assert.equal(res.scaffoldResult.quarantined, true);
    assert.equal(res.scaffoldResult.promotable, false);
    assert.equal(res.scaffoldResult.lintPassed, true);

    const skillName = res.scaffoldResult.skillName;
    const draftSkillMd = path.join(projectDir, "proposals", "skills", skillName, "SKILL.md");
    const proposalMeta = path.join(projectDir, "proposals", "skills", ".proposals", `${skillName}.yaml`);
    assert.equal(fs.existsSync(draftSkillMd), true);
    assert.equal(fs.existsSync(proposalMeta), false);
    assert.equal(fs.existsSync(path.join(projectDir, ".agents", "skills", skillName)), false);

    // Must validate & pass strict lint via CLI when --include-drafts is passed
    const lintRes = runCli([
      "skills",
      "lint",
      "--project",
      projectDir,
      "--global-dir",
      isolatedGlobal,
      "--include-drafts",
      "--strict",
      "--json",
    ]);
    assert.equal(lintRes.status, 0, lintRes.stderr);
    const lintJson = JSON.parse(lintRes.stdout);
    assert.equal(lintJson.passed, true);

    // Promotion must STILL fail closed because unverified repo scaffolds lack verified EVID-* provenance
    assert.throws(
      () =>
        promoteSkillProposal({
          projectDir,
          harnessDir: HARNESS_DIR,
          skillName,
          interactiveConfirm: () => true,
        }),
      /Proposal metadata missing|Refusing untrusted proposal without provenance/i
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("skills-advisor ignores symlinked manifests, strips secrets, enforces MCP permissions, and supports CLI", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-adv-sec-mcp-"));
  const isolatedGlobal = path.join(tmp, "empty-global");
  fs.mkdirSync(isolatedGlobal, { recursive: true });
  try {
    const outsideDir = path.join(tmp, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, "package.json"),
      JSON.stringify({ dependencies: { stripe: "^14.0.0" }, scripts: { build: "echo outside" } }),
      "utf8"
    );

    const projectDir = path.join(tmp, "sec-app");
    bootstrapProject({ name: "Secure Advisor App", dest: projectDir, git: false });
    const fakeKey = "AKIA" + "1234567890ABCDEF";
    fs.writeFileSync(
      path.join(projectDir, "brain", "requirements", "constraints.md"),
      [
        "# Constraints",
        "",
        "- Validate local config cleanly before staging deploy.",
        `- Never hardcode keys like ${fakeKey} in source files.`,
        "",
      ].join("\n"),
      "utf8"
    );

    // Symlinked .github/workflows junction (works cross-platform) + optional file symlinked package.json
    fs.mkdirSync(path.join(outsideDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "workflows", "ci.yml"), "name: Out\n", "utf8");
    fs.mkdirSync(path.join(projectDir, ".github"), { recursive: true });
    fs.symlinkSync(path.join(outsideDir, "workflows"), path.join(projectDir, ".github", "workflows"), SYMLINK_TYPE);
    try {
      fs.symlinkSync(path.join(outsideDir, "package.json"), path.join(projectDir, "package.json"), process.platform === "win32" ? "file" : undefined);
    } catch {
      // File symlinks on unprivileged Windows require Developer Mode; .github/workflows junction still exercises symlink rejection
    }

    const roCtx = {
      readOnly: true,
      defaultProjectDir: projectDir,
      allowedProjectRoots: [projectDir],
      harnessDir: HARNESS_DIR,
    };

    const mcpSuggest = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "geloforge_skills",
          arguments: { action: "suggest", goal: "Validate deployment config" },
        },
      },
      roCtx
    );
    assert.equal(mcpSuggest.result.isError, false);
    const suggestPayload = JSON.parse(mcpSuggest.result.content[0].text);
    assert.equal(suggestPayload.detectedSignals.stacks.includes("stripe"), false);
    assert.equal(suggestPayload.detectedSignals.stacks.includes("github-actions"), false);
    assert.equal(suggestPayload.skillGaps[0].constraints.some((c) => c.includes(fakeKey)), false);

    // Read-only MCP refuses scaffold
    const mcpScaffoldRo = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "geloforge_skills",
          arguments: { action: "scaffold", goal: "Validate deployment config" },
        },
      },
      roCtx
    );
    assert.equal(mcpScaffoldRo.result.isError, true);
    assert.match(mcpScaffoldRo.result.content[0].text, /--read-only/);

    // Writable MCP scaffolds quarantined draft; promote still blocked
    const rwCtx = { ...roCtx, readOnly: false };
    const mcpPromote = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "geloforge_skills", arguments: { action: "promote", name: "anything" } },
      },
      rwCtx
    );
    assert.equal(mcpPromote.result.isError, true);
    assert.match(mcpPromote.result.content[0].text, /Refusing privileged/i);

    const mcpScaffoldRw = handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "geloforge_skills",
          arguments: { action: "scaffold", goal: "Validate deployment config", name: "deploy-config-check" },
        },
      },
      rwCtx
    );
    assert.equal(mcpScaffoldRw.result.isError, false);
    const rwPayload = JSON.parse(mcpScaffoldRw.result.content[0].text);
    assert.equal(rwPayload.scaffoldResult.skillName, "deploy-config-check");
    assert.equal(
      fs.existsSync(path.join(projectDir, "proposals", "skills", "deploy-config-check", "SKILL.md")),
      true
    );

    // CLI dry-run + JSON
    const cliDry = runCli([
      "skills",
      "suggest",
      "--project",
      projectDir,
      "--global-dir",
      isolatedGlobal,
      "--goal",
      "Audit release checklist",
      "--scaffold-draft",
      "--name",
      "audit-release-cli",
      "--dry-run",
      "--json",
    ]);
    assert.equal(cliDry.status, 0, cliDry.stderr);
    const cliJson = JSON.parse(cliDry.stdout);
    assert.equal(cliJson.scaffoldResult.dryRun, true);
    assert.equal(cliJson.scaffoldResult.skillName, "audit-release-cli");
    assert.equal(fs.existsSync(path.join(projectDir, "proposals", "skills", "audit-release-cli")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
