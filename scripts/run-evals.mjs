#!/usr/bin/env node
/**
 * Deterministic real-failure regression evaluation runner (`npm run eval`).
 * Exercises retrieval ranking, context layout, query cache, MCP pinning/hints,
 * and coding loop guardrails offline in disposable workspaces.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { compileCachedContext } from "../core/context-cache.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { runCodingLoop } from "../core/coding-loop.mjs";
import { checkMcpLock, lockMcpServers, MCP_LOCK_PATH } from "../core/mcp-lock.mjs";
import { handleMcpMessage } from "../core/mcp-server.mjs";
import { claimTaskLease, createTask, releaseTaskLease } from "../core/task-manager.mjs";
import { bootstrapProject } from "./bootstrap-project.mjs";

const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_FIXTURE_PATH = path.join(HARNESS_DIR, "evaluations", "regression-evals.json");

function makeWorkspace(prefix, { git = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const projectDir = path.join(root, "eval-project");
  bootstrapProject({ name: "Eval Fixture App", dest: projectDir, profile: "automation", git });
  return { root, projectDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}

function writeMarkdownDoc(projectDir, relPath, frontmatterYaml, body) {
  const abs = path.join(projectDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `---\n${frontmatterYaml.trim()}\n---\n\n${body.trim()}\n`, "utf8");
}

function writeAdrDoc(projectDir, relPath, { id, title, body, tags = ["eval"] }) {
  writeMarkdownDoc(
    projectDir,
    relPath,
    [
      'schema_version: "1.1"',
      `id: "${id}"`,
      `title: "${title}"`,
      'status: "accepted"',
      'memory_layer: "L1_AUTHORITATIVE"',
      'authority_level: "A2"',
      'owner: "Project Owner"',
      'proposed_by: "software-architect"',
      'approved_by: "Project Owner"',
      'created_at: "2026-10-01T00:00:00Z"',
      'updated_at: "2026-10-01T00:00:00Z"',
      'decided_at: "2026-10-01T00:00:00Z"',
      'review_by: "2027-10-01"',
      "supersedes: []",
      "superseded_by: null",
      "related_requirements: []",
      "related_research: []",
      "approval_ref: null",
      "tags:",
      ...tags.map((t) => `  - "${t}"`),
    ].join("\n"),
    `# ${title}\n${body}`
  );
}

function writeResearchDoc(projectDir, relPath, { id, title, body, status = "draft" }) {
  writeMarkdownDoc(
    projectDir,
    relPath,
    [
      'schema_version: "1.1"',
      `id: "${id}"`,
      `title: "${title}"`,
      `status: "${status}"`,
      'memory_layer: "L3_RESEARCH_EVIDENCE"',
      'authority_level: "A5"',
      'author_role: "researcher"',
      'created_at: "2026-10-01T00:00:00Z"',
      'updated_at: "2026-10-01T00:00:00Z"',
      'valid_until: "2027-10-01"',
      `question: "${title}"`,
      'confidence: "low"',
      "sources: []",
      "related_tasks: []",
      "related_adrs: []",
      "contradicts: []",
      'tags: ["eval"]',
    ].join("\n"),
    `# ${title}\n${body}`
  );
}

function runRetrievalEval(spec) {
  const ws = makeWorkspace("gf-eval-ret-");
  try {
    const { projectDir } = ws;
    const { rareDoc, noisyDoc, unrelatedDoc } = spec.input;
    for (const doc of [rareDoc, unrelatedDoc]) {
      writeAdrDoc(projectDir, doc.relPath, { id: doc.id, title: doc.title, body: doc.body });
    }
    const noiseText = Array.from({ length: noisyDoc.repeatCount }, (_, i) => `${noisyDoc.repeatedWord} step ${i + 1}`).join(" ");
    writeResearchDoc(projectDir, noisyDoc.relPath, { id: noisyDoc.id, title: noisyDoc.title, body: noiseText });

    const packet = compileContext({
      projectDir,
      harnessDir: HARNESS_DIR,
      query: spec.input.query,
      budget: spec.input.budget,
    });
    const includedPaths = packet.manifest.included_documents.map((d) => d.path);
    const rareIdx = includedPaths.indexOf(spec.expected.mustInclude);
    const noiseIdx = includedPaths.indexOf(spec.expected.mustOutrank);
    assert.ok(rareIdx !== -1, `Expected ${spec.expected.mustInclude} to be included`);
    assert.equal(includedPaths.includes(spec.expected.mustOmit), false, `Expected ${spec.expected.mustOmit} omitted`);
    if (noiseIdx !== -1) {
      assert.ok(rareIdx < noiseIdx, `Expected ${spec.expected.mustInclude} (${rareIdx}) before ${spec.expected.mustOutrank} (${noiseIdx})`);
    }
    return { includedCount: includedPaths.length, rareRank: rareIdx, noiseRank: noiseIdx };
  } finally {
    ws.cleanup();
  }
}

function runLayoutEval(spec) {
  const ws = makeWorkspace("gf-eval-lay-");
  try {
    const { projectDir } = ws;
    fs.mkdirSync(path.join(projectDir, "brain", "conflicts"), { recursive: true });
    writeAdrDoc(projectDir, "brain/decisions/ADR-0001-layout.md", {
      id: "ADR-0001",
      title: "Layout Rule",
      body: "Enforce edge-anchored ordering.",
    });
    writeResearchDoc(projectDir, "brain/research/RES-0001-note.md", {
      id: "RES-0001",
      title: "Draft Research",
      body: "Draft unverified observation about layout.",
    });
    fs.writeFileSync(
      path.join(projectDir, "brain", "conflicts", "CONF-0001-eval.yaml"),
      [
        'schema_version: "1.1"',
        'id: "CONF-0001"',
        'title: "Open Layout Check"',
        'status: "open"',
        'memory_layer: "L2_OPERATIONAL"',
        'authority_level: "A4"',
        'severity: "high"',
        'detected_at: "2026-10-01T00:00:00Z"',
        'detected_by: "qa-security-reviewer"',
        "conflicting_records:",
        '  - record_id: "ADR-0001"',
        '    path: "brain/decisions/ADR-0001-layout.md"',
        '    authority_level: "A2"',
        '    claim: "Enforce edge-anchored ordering."',
        '  - record_id: "RES-0001"',
        '    path: "brain/research/RES-0001-note.md"',
        '    authority_level: "A5"',
        '    claim: "Draft unverified observation about layout."',
        'description: "Unverified research observation conflicts with accepted layout ADR."',
        'impact: "Must follow ADR-0001 layout ordering."',
        "resolution_strategy: null",
        "resolved_by: null",
        "resolved_at: null",
        "approval_ref: null",
      ].join("\n") + "\n"
    );
    const task = createTask({ projectDir, harnessDir: HARNESS_DIR, title: "Verify context ordering", activate: true });
    const packet = compileContext({ projectDir, harnessDir: HARNESS_DIR, taskId: task.id, query: "layout" });

    let prev = -1;
    const offsets = {};
    for (const heading of spec.input.orderedHeadings) {
      const idx = packet.markdown.indexOf(heading);
      assert.ok(idx > prev, `Heading "${heading}" at ${idx} expected after ${prev}`);
      offsets[heading] = idx;
      prev = idx;
    }
    return { verifiedHeadings: spec.input.orderedHeadings.length };
  } finally {
    ws.cleanup();
  }
}

function runCacheEval(spec) {
  const ws = makeWorkspace("gf-eval-cache-");
  try {
    const { projectDir } = ws;
    const { query, tool, sessionId, scope } = spec.input;
    const task = createTask({ projectDir, harnessDir: HARNESS_DIR, title: "Cache regression test", activate: true });
    claimTaskLease({ projectDir, harnessDir: HARNESS_DIR, taskId: task.id, tool, sessionId, scope: [scope] });

    const leased = compileCachedContext({ projectDir, harnessDir: HARNESS_DIR, query });
    assert.equal(leased.diskCache, spec.expected.whileLeased);

    releaseTaskLease({ projectDir, harnessDir: HARNESS_DIR, taskId: task.id, tool, sessionId });
    assert.equal(fs.existsSync(path.join(projectDir, ".geloforge", "task-leases.yaml")), true);

    const run1 = compileCachedContext({ projectDir, harnessDir: HARNESS_DIR, query });
    const run2 = compileCachedContext({ projectDir, harnessDir: HARNESS_DIR, query });
    assert.equal(run1.diskCache, spec.expected.afterReleaseRun1);
    assert.equal(run2.diskCache, spec.expected.afterReleaseRun2);
    return { leased: leased.diskCache, run1: run1.diskCache, run2: run2.diskCache };
  } finally {
    ws.cleanup();
  }
}

async function runMcpGuardrailsEval(spec) {
  const ws = makeWorkspace("gf-eval-mcp-");
  try {
    const { root, projectDir } = ws;
    const modeFile = path.join(root, "mode.txt");
    const mockMcp = path.join(root, "mock-mcp.mjs");
    fs.writeFileSync(modeFile, "v1");
    fs.writeFileSync(mockMcp, [
      'import fs from "node:fs"; import readline from "node:readline";',
      'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
      'rl.on("line", (line) => { const s = line.trim(); if (!s) return; const m = JSON.parse(s); if (m.id === undefined) return;',
      'if (m.method === "initialize") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "eval-mcp", version: "1.0.0" } } }) + "\\n"); }',
      `else if (m.method === "tools/list") { const drifted = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() === "drifted";`,
      `const tools = [{ name: ${JSON.stringify(spec.input.mutatedToolName)}, description: drifted ? "Drifted description" : "Original description", inputSchema: { type: "object", properties: {} } }];`,
      `if (drifted) tools.push({ name: ${JSON.stringify(spec.input.addedToolName)}, description: "Added tool", inputSchema: { type: "object", properties: {} } });`,
      'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools } }) + "\\n"); } });',
    ].join("\n"));

    fs.writeFileSync(path.join(projectDir, ".mcp.json"), JSON.stringify({
      mcpServers: { mock: { command: process.execPath, args: [mockMcp] } },
    }, null, 2));

    const locked = await lockMcpServers({ projectDir, harnessDir: HARNESS_DIR, timeoutMs: 6000 });
    assert.equal(locked.serverCount, 1);
    assert.equal(fs.existsSync(path.join(projectDir, MCP_LOCK_PATH)), true);
    assert.equal((await checkMcpLock({ projectDir, harnessDir: HARNESS_DIR, timeoutMs: 6000 })).passed, true);

    fs.writeFileSync(modeFile, "drifted");
    const drifted = await checkMcpLock({ projectDir, harnessDir: HARNESS_DIR, timeoutMs: 6000 });
    assert.equal(drifted.passed, false);
    assert.deepEqual(drifted.driftedServers[0].changedTools, [spec.input.mutatedToolName]);
    assert.deepEqual(drifted.driftedServers[0].addedTools, [spec.input.addedToolName]);

    const badAction = handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "geloforge_task", arguments: { action: spec.input.invalidTaskAction } } },
      { defaultProjectDir: projectDir, harnessDir: HARNESS_DIR }
    );
    assert.equal(badAction.result.isError, true);
    assert.match(badAction.result.content[0].text, /Hint: Valid actions:/);

    return { driftDetected: true, hintReturned: true };
  } finally {
    ws.cleanup();
  }
}

async function runCodingLoopEval(spec) {
  const ws = makeWorkspace("gf-eval-loop-", { git: true });
  try {
    const { root, projectDir } = ws;
    fs.writeFileSync(path.join(projectDir, "src", "check.mjs"), "export const val = () => 0;\n");
    execFileSync("git", ["-C", projectDir, "add", "."], { windowsHide: true });
    execFileSync("git", ["-C", projectDir, "-c", "user.name=Eval", "-c", "user.email=eval@example.invalid", "commit", "-m", "init"], { windowsHide: true });

    const providerScript = path.join(root, "mock-provider.mjs");
    fs.writeFileSync(providerScript, [
      'import fs from "node:fs"; import path from "node:path";',
      'const chunks = []; for await (const c of process.stdin) chunks.push(c); const prompt = Buffer.concat(chunks).toString("utf8");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "--ask-for-approval") {',
      '  fs.writeFileSync(path.join(process.cwd(), "src", "check.mjs"), "export const val = () => 42;\\n");',
      '  fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ summary: "Updated value to 42" }));',
      '} else {',
      '  const cntFile = new URL("./rev.txt", import.meta.url);',
      '  const n = (fs.existsSync(cntFile) ? Number(fs.readFileSync(cntFile, "utf8")) : 0) + 1;',
      '  fs.writeFileSync(cntFile, String(n));',
      `  const payload = n === 1 ? { verdict: "approve", summary: "Bad policy", policy_checks: [{ rule: ${JSON.stringify(spec.input.policyRule)}, passed: false }], findings: [] }`,
      `    : { verdict: "approve", summary: "Clean", policy_checks: [{ rule: ${JSON.stringify(spec.input.policyRule)}, passed: true }], findings: [] };`,
      '  console.log(JSON.stringify({ response: JSON.stringify(payload) }));',
      '}',
    ].join("\n"));

    fs.mkdirSync(path.join(projectDir, "local-runtime"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "local-runtime", "eval-loop.json"), JSON.stringify({
      version: 1,
      maxFixRounds: spec.input.maxFixRounds,
      timeoutMs: 15_000,
      verifyCommand: [process.execPath, "--input-type=module", "-e", "import { val } from './src/check.mjs'; if (val() !== 42) process.exit(2);"],
      implementer: { provider: "codex", executable: providerScript },
      reviewer: { provider: "gemini", executable: providerScript },
    }, null, 2));

    const task = createTask({ projectDir, harnessDir: HARNESS_DIR, title: "Eval loop policy gate", activate: true });
    const res = await runCodingLoop({
      projectDir,
      harnessDir: HARNESS_DIR,
      configFile: "local-runtime/eval-loop.json",
      taskId: task.id,
    });
    assert.equal(res.status, spec.input.expectedOutcome);
    assert.equal(res.roundsUsed, spec.input.expectedRoundsUsed);
    assert.equal(res.implementAttempts, spec.input.expectedAttempts);
    assert.match(res.evidenceId, /^EVID-/);
    assert.match(res.checkpointId, /^CHKPT-/);
    return { status: res.status, roundsUsed: res.roundsUsed, implementAttempts: res.implementAttempts };
  } finally {
    ws.cleanup();
  }
}

const EVAL_RUNNERS = {
  retrieval: runRetrievalEval,
  context_layout: runLayoutEval,
  context_cache: runCacheEval,
  mcp_guardrails: runMcpGuardrailsEval,
  coding_loop: runCodingLoopEval,
};

async function main() {
  const { values } = parseArgs({
    options: {
      category: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log("Usage: node scripts/run-evals.mjs [--category <name>] [--json]");
    return 0;
  }

  const suite = JSON.parse(fs.readFileSync(EVAL_FIXTURE_PATH, "utf8"));
  const validCategories = Object.keys(EVAL_RUNNERS);
  if (values.category && !Object.hasOwn(EVAL_RUNNERS, values.category)) {
    throw new Error(`Unknown eval category "${values.category}". Expected one of: ${validCategories.join(", ")}`);
  }

  const selected = suite.cases.filter((item) => !values.category || item.category === values.category);
  const results = [];
  for (const item of selected) {
    const runner = EVAL_RUNNERS[item.category];
    if (!runner) {
      results.push({ id: item.id, category: item.category, passed: false, durationMs: 0, metrics: null, error: `Unsupported category "${item.category}".` });
      continue;
    }
    const t0 = Date.now();
    try {
      const metrics = await runner(item);
      results.push({ id: item.id, category: item.category, passed: true, durationMs: Date.now() - t0, metrics, error: null });
    } catch (err) {
      results.push({ id: item.id, category: item.category, passed: false, durationMs: Date.now() - t0, metrics: null, error: err.message });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const summary = {
    version: suite.version,
    total: results.length,
    passed,
    failed,
    passRate: results.length > 0 ? Math.round((passed / results.length) * 1000) / 10 : 0,
    results,
  };

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`=== GeloForge Regression Evals (${passed}/${results.length} passed, ${summary.passRate}%) ===`);
    for (const r of results) {
      console.log(`  [${r.passed ? "PASS" : "FAIL"}] ${r.id} (${r.category}, ${r.durationMs}ms)${r.error ? ` — ${r.error}` : ""}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
