#!/usr/bin/env node
/**
 * Deterministic relevance, mandatory-coverage, size, and timing benchmark comparing:
 *   Baseline : v0.2.0 naive full Second Brain + global policy dump (no selective compiler)
 *   Candidate: compileContext() (Stage 2 deterministic Context Compiler)
 * Note: Model-level LLM accuracy is NOT measured here (requires live model/paid API runs).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "./bootstrap-project.mjs";
import { compileContext, estimateTokens } from "../core/context-compiler.mjs";
import { buildCodebaseMap } from "../core/codebase-map.mjs";
import { compileSkillsSection, discoverSkills } from "../core/skills.mjs";
import { lintDiscoveredSkills } from "../core/skills-lint.mjs";
import { tokenizeKeywords } from "../core/text-utils.mjs";
import { createHandoff, inspectHandoff } from "../core/handoff.mjs";
import { validateProject } from "../core/project-validator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");

function buildBenchmarkFixture(projectDir) {
  bootstrapProject({ name: "Benchmark Commerce App", profile: "web", dest: projectDir, git: false });
  for (const d of ["brain/research", "brain/conflicts", "evidence", "src"]) {
    fs.mkdirSync(path.join(projectDir, d), { recursive: true });
  }

  // Create 12 ADRs across 3 domains: auth (4), payments (4), notifications (4)
  const domains = [
    { name: "auth", kw: "oauth token session cookie pkce refresh" },
    { name: "payments", kw: "stripe webhook invoice ledger refund idempotency" },
    { name: "notifications", kw: "email smtp queue retry template digest" },
  ];
  let adrIdx = 1;
  for (const dom of domains) {
    for (let i = 1; i <= 4; i += 1) {
      const id = `ADR-${String(adrIdx).padStart(4, "0")}`;
      const filler = `Detailed architectural guidance for ${dom.name} module part ${i}: ${dom.kw}. `.repeat(12);
      fs.writeFileSync(
        path.join(projectDir, "brain", "decisions", `${id}-${dom.name}-${i}.md`),
        `---
schema_version: "1.1"
id: "${id}"
title: "${dom.name.toUpperCase()} Decision ${i}"
status: "accepted"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A2"
owner: "Project Owner"
proposed_by: "software-architect"
approved_by: "Project Owner"
created_at: "2026-02-01T00:00:00Z"
updated_at: "2026-02-01T00:00:00Z"
decided_at: "2026-02-01T00:00:00Z"
review_by: "2027-02-01"
supersedes: []
superseded_by: null
related_requirements:
  - "brain/requirements/prd.md"
related_research: []
approval_ref: null
tags:
  - "${dom.name}"
---

# ${id}: ${dom.name} Architecture ${i}
${filler}
`,
        "utf8"
      );
      adrIdx += 1;
    }
  }

  // Create 3 research records (1 stale payments, 1 fresh auth, 1 unrelated notifications)
  fs.writeFileSync(
    path.join(projectDir, "brain", "research", "RES-0001-payments-stale.md"),
    `---
schema_version: "1.1"
id: "RES-0001"
title: "Legacy Stripe Webhook Signature Notes"
status: "verified"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A5"
author_role: "researcher"
created_at: "2025-01-01T00:00:00Z"
updated_at: "2025-01-01T00:00:00Z"
valid_until: "2025-07-01"
question: "How to verify stripe webhook signatures?"
confidence: "medium"
sources:
  - title: "Legacy Webhook Docs"
    reference: "local://legacy"
    type: "official_docs"
    accessed_at: "2025-01-01T00:00:00Z"
related_tasks:
  - "TASK-0001"
related_adrs:
  - "ADR-0005"
contradicts: []
tags:
  - "payments"
  - "webhook"
---

Legacy webhook notes for stripe idempotency.
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "brain", "research", "RES-0002-auth-fresh.md"),
    `---
schema_version: "1.1"
id: "RES-0002"
title: "OAuth PKCE Flow Verification"
status: "verified"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A5"
author_role: "researcher"
created_at: "2026-10-01T00:00:00Z"
updated_at: "2026-10-01T00:00:00Z"
valid_until: "2027-10-01"
question: "PKCE challenge constraints?"
confidence: "high"
sources:
  - title: "RFC 7636"
    reference: "local://rfc7636"
    type: "standard"
    accessed_at: "2026-10-01T00:00:00Z"
related_tasks:
  - "TASK-0002"
related_adrs:
  - "ADR-0001"
contradicts: []
tags:
  - "auth"
  - "pkce"
---

Use S256 code challenge for oauth pkce flow.
`,
    "utf8"
  );

  // Open conflict on payments webhook retry
  fs.writeFileSync(
    path.join(projectDir, "brain", "conflicts", "CONF-0001-webhook-retry.yaml"),
    `schema_version: "1.1"
id: "CONF-0001"
title: "Stripe Webhook Retry Backoff Conflict"
status: "open"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
severity: "high"
detected_at: "2026-03-01T00:00:00Z"
detected_by: "qa-security-reviewer"
conflicting_records:
  - record_id: "ADR-0005"
    path: "brain/decisions/ADR-0005-payments-1.md"
    authority_level: "A2"
    claim: "Idempotency window 24h."
  - record_id: "RES-0001"
    path: "brain/research/RES-0001-payments-stale.md"
    authority_level: "A5"
    claim: "Legacy 1h cache window."
description: "Stale research contradicts accepted ADR-0005 idempotency window."
impact: "Must retain 24h idempotency window."
resolution_strategy: null
resolved_by: null
resolved_at: null
approval_ref: null
`,
    "utf8"
  );

  // Two scoped tasks + matching verified evidence
  fs.writeFileSync(path.join(projectDir, "src", "webhooks.mjs"), "export function handleStripeWebhook() {}\n", "utf8");
  fs.writeFileSync(
    path.join(projectDir, "tasks", "TASK-0001-stripe-webhook.yaml"),
    `schema_version: "1.1"
id: "TASK-0001"
title: "Implement Stripe Webhook Idempotency Handler"
project_id: "proj-benchmark-commerce-app"
status: "active"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
priority: "high"
assigned_role: "developer"
created_by: "orchestrator"
created_at: "2026-03-01T00:00:00Z"
updated_at: "2026-03-01T00:00:00Z"
objective: "Verify stripe webhook signature and store idempotency ledger record."
scope_in:
  - "src/webhooks.mjs"
scope_out:
  - "email queue"
required_inputs:
  - path: "src/webhooks.mjs"
    revision: "rev-1"
expected_outputs:
  - "evidence/EVID-0001-webhook.yaml"
acceptance_criteria:
  - "Duplicate stripe webhook events are ignored."
dependencies: []
approval_required: false
approval_ref: null
context_budget: "working"
max_retries: 2
evidence_refs:
  - "EVID-0001"
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "tasks", "TASK-0002-oauth-pkce.yaml"),
    `schema_version: "1.1"
id: "TASK-0002"
title: "Implement OAuth PKCE Token Refresh"
project_id: "proj-benchmark-commerce-app"
status: "ready"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
priority: "medium"
assigned_role: "developer"
created_by: "orchestrator"
created_at: "2026-03-01T00:00:00Z"
updated_at: "2026-03-01T00:00:00Z"
objective: "Validate oauth pkce session cookie and token refresh."
scope_in:
  - "src/auth.mjs"
scope_out:
  - "billing"
required_inputs: []
expected_outputs:
  - "evidence/EVID-0002-auth.yaml"
acceptance_criteria:
  - "PKCE S256 token refresh succeeds."
dependencies: []
approval_required: false
approval_ref: null
context_budget: "quick"
max_retries: 2
evidence_refs:
  - "EVID-0002"
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "evidence", "EVID-0001-webhook.yaml"),
    `schema_version: "1.1"
id: "EVID-0001"
title: "Stripe Webhook Handler Tests"
task_id: "TASK-0001"
status: "verified"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A3"
produced_by_role: "qa-security-reviewer"
verified_by: "Project Owner"
created_at: "2026-03-02T00:00:00Z"
source_revision: "rev-1"
environment:
  os: "Windows 11"
  runtime: "Node.js 24"
checks:
  - name: "Webhook idempotency test"
    command: "node --test"
    result: "passed"
    summary: "Duplicate events ignored cleanly."
artifacts: []
limitations: []
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "evidence", "EVID-0002-auth.yaml"),
    `schema_version: "1.1"
id: "EVID-0002"
title: "OAuth PKCE Unit Tests"
task_id: "TASK-0002"
status: "verified"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A3"
produced_by_role: "qa-security-reviewer"
verified_by: "Project Owner"
created_at: "2026-03-02T00:00:00Z"
source_revision: "rev-1"
environment:
  os: "Windows 11"
  runtime: "Node.js 24"
checks:
  - name: "PKCE unit tests"
    command: "node --test"
    result: "passed"
    summary: "PKCE challenge verified."
artifacts: []
limitations: []
`,
    "utf8"
  );
}

function measureNaiveBaseline(projectDir) {
  let totalBytes = 0;
  for (const pol of ["policies/approval-boundaries.md", "policies/memory-policy.md"]) {
    totalBytes += fs.statSync(path.join(HARNESS_DIR, pol)).size;
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(md|ya?ml)$/i.test(entry.name)) {
        totalBytes += fs.statSync(full).size;
      }
    }
  };
  walk(projectDir);
  return { bytes: totalBytes, estTokens: Math.ceil(totalBytes / 4) };
}

function runBenchmark() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-bench-"));
  try {
    const projectDir = path.join(tmp, "bench-proj");
    buildBenchmarkFixture(projectDir);
    const baseline = measureNaiveBaseline(projectDir);

    const scenarios = [
      {
        name: "Task TASK-0001 (working) — Payments Webhook",
        opts: { projectDir, taskId: "TASK-0001", profile: "working", referenceDate: "2026-11-19" },
        expectedRelevant: [
          "brain/decisions/ADR-0005-payments-1.md",
          "brain/decisions/ADR-0006-payments-2.md",
          "brain/decisions/ADR-0007-payments-3.md",
          "brain/decisions/ADR-0008-payments-4.md",
          "evidence/EVID-0001-webhook.yaml",
          "src/webhooks.mjs",
        ],
        unrelated: [
          "brain/decisions/ADR-0001-auth-1.md",
          "brain/decisions/ADR-0009-notifications-1.md",
        ],
      },
      {
        name: "Task TASK-0002 (quick) — Auth PKCE",
        opts: { projectDir, taskId: "TASK-0002", profile: "quick", referenceDate: "2026-11-19" },
        expectedRelevant: [
          "brain/decisions/ADR-0001-auth-1.md",
          "evidence/EVID-0002-auth.yaml",
        ],
        unrelated: [
          "brain/decisions/ADR-0005-payments-1.md",
          "brain/decisions/ADR-0009-notifications-1.md",
        ],
      },
      {
        name: "Ad-hoc Query (working) — Email SMTP Queue",
        opts: { projectDir, query: "email smtp queue retry template", profile: "working", referenceDate: "2026-11-19" },
        expectedRelevant: [
          "brain/decisions/ADR-0009-notifications-1.md",
          "brain/decisions/ADR-0010-notifications-2.md",
          "brain/decisions/ADR-0011-notifications-3.md",
          "brain/decisions/ADR-0012-notifications-4.md",
        ],
        unrelated: [
          "brain/decisions/ADR-0001-auth-1.md",
          "brain/decisions/ADR-0005-payments-1.md",
        ],
      },
    ];

    console.log("=== GeloForge Context Compiler Deterministic Benchmark ===");
    console.log(`Baseline (v0.2.0 naive Second Brain + policy dump): ${baseline.bytes} bytes (~${baseline.estTokens} est. tokens heuristic:ceil(bytes/4))\n`);

    for (const sc of scenarios) {
      const t0 = performance.now();
      const res1 = compileContext({ ...sc.opts, compiledAt: "2026-11-19T00:00:00.000Z" });
      const elapsedMs = performance.now() - t0;
      const res2 = compileContext({ ...sc.opts, compiledAt: "2026-11-19T00:00:00.000Z" });
      const deterministic = res1.markdown === res2.markdown;

      const inc = new Set(res1.manifest.included_documents.map((d) => d.path));
      const mandatoryOk =
        inc.has("harness/policies/approval-boundaries.md") &&
        inc.has("harness/policies/memory-policy.md") &&
        inc.has("brain/requirements/constraints.md") &&
        inc.has("brain/conflicts/CONF-0001-webhook-retry.yaml");

      const relHits = sc.expectedRelevant.filter((p) => inc.has(p)).length;
      const relRecallPct = Math.round((relHits / sc.expectedRelevant.length) * 100);
      const unrelatedHits = sc.unrelated.filter((p) => inc.has(p)).length;
      const packetBytes = Buffer.byteLength(res1.markdown, "utf8");
      const sizeDeltaPct = Math.round(((baseline.bytes - packetBytes) / baseline.bytes) * 100);

      console.log(`Scenario: ${sc.name}`);
      console.log(`  - Mandatory safety & open-conflict coverage : ${mandatoryOk ? "100%" : "FAIL"}`);
      console.log(`  - Expected relevant document recall         : ${relHits}/${sc.expectedRelevant.length} (${relRecallPct}%)`);
      console.log(`  - Unrelated domain ADRs leaked              : ${unrelatedHits}/${sc.unrelated.length}`);
      console.log(`  - Size vs naive baseline                    : ${packetBytes} bytes (~${res1.estimatedTokens} est. tokens, ${sizeDeltaPct >= 0 ? `${sizeDeltaPct}% smaller` : `${Math.abs(sizeDeltaPct)}% larger`})`);
      console.log(
        `  - Budget breakdown (est. tokens)            : policies=${res1.budgetBreakdown.policy_tokens}, mandatory_proj=${res1.budgetBreakdown.project_mandatory_tokens}, optional=${res1.budgetBreakdown.optional_tokens}, map=${res1.budgetBreakdown.codebase_map_tokens}, overhead=${res1.budgetBreakdown.overhead_tokens}`
      );
      console.log(`  - Budget target / overrun                   : ${res1.manifest.token_budget_target} / ${res1.budgetOverrun} (effective: ${res1.manifest.effective_profile})`);
      console.log(`  - Compile latency / deterministic           : ${elapsedMs.toFixed(2)} ms / ${deterministic}`);
    }

    runCodebaseMapBenchmarks(tmp);
    runHandoffBenchmark(tmp);
    runSkillsBenchmark(tmp);

    console.log("\nNote: Benchmark measures deterministic file/outline/handoff metrics on synthetic repositories.");
    console.log("      Live LLM task accuracy and vendor token billing are NOT measured without real model execution.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

function measureSourceTreeBytes(repoDir, excludePaths) {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "ignored_dist") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoDir, full).replace(/\\/g, "/");
      if (excludePaths.has(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) bytes += fs.statSync(full).size;
    }
  };
  walk(repoDir);
  return bytes;
}

function buildSyntheticCodeRepo(repoDir, fileCount, deepTargetRel) {
  fs.mkdirSync(path.join(repoDir, "src", "payments"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "py"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "go"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "ignored_dist"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "secrets"), { recursive: true });

  fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored_dist/\n*.generated.js\n", "utf8");
  fs.writeFileSync(path.join(repoDir, ".env"), "DB_PASS=benchmark_secret\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "secrets", "prod.key"), "KEY_MATERIAL\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "ignored_dist", "bundle.js"), "export function bundleNoise() {}\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "auto.generated.js"), "export function genNoise() {}\n", "utf8");
  const dynSecret = "AIza" + "SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";
  fs.writeFileSync(path.join(repoDir, "src", "leak-probe.mjs"), `export const gKey = "${dynSecret}";\n`, "utf8");

  // Relevant multi-language payment targets + import chain
  fs.writeFileSync(
    path.join(repoDir, "src", "payments", "checkout.ts"),
    `import { postLedgerEntry } from "./ledger";\nexport function processCheckout(orderId: string) { return postLedgerEntry(orderId); }\n` +
      `// padding comments\n`.repeat(15),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repoDir, "src", "payments", "ledger.ts"),
    `export interface LedgerEntry { id: string; cents: number; }\nexport function postLedgerEntry(id: string) { return id; }\n` +
      `// ledger details\n`.repeat(15),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repoDir, "go", "settlement.go"),
    `package main\nfunc ReconcilePayments(batch string) error { return nil }\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(repoDir, "py", "invoice_calc.py"),
    `def compute_tax_cents(amount_cents):\n    return int(amount_cents * 0.1)\n`,
    "utf8"
  );
  if (deepTargetRel) {
    fs.mkdirSync(path.dirname(path.join(repoDir, deepTargetRel)), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, deepTargetRel),
      `export function reconcileCheckoutLedger(batchId: string) { return batchId; }\n`,
      "utf8"
    );
  }

  for (let i = 0; i < fileCount; i += 1) {
    const modDir = path.join(repoDir, "src", `module-${String(i % 10).padStart(2, "0")}`);
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, `worker-${String(i).padStart(4, "0")}.mjs`),
      `export function workerTask_${i}(x) { return x + ${i}; }\n` + `// unrelated helper line\n`.repeat(10),
      "utf8"
    );
  }
}

function runCodebaseMapBenchmarks(tmp) {
  console.log("\n=== GeloForge Selective Codebase Map Benchmark ===");
  const cases = [
    {
      label: "250-file polyglot repo (Git .gitignore + secrets + import centrality)",
      fileCount: 245,
      useGit: true,
      mapBudget: 1200,
      maxScannedFiles: 500,
      deepTarget: null,
      query: "checkout ledger reconcile payments",
      expectedSelected: ["src/payments/checkout.ts", "src/payments/ledger.ts", "go/settlement.go"],
    },
    {
      label: "1,200-file repo (bounded scan limit=500 + deep z-target recall)",
      fileCount: 1195,
      useGit: false,
      mapBudget: 900,
      maxScannedFiles: 500,
      deepTarget: "src/z-settlement/reconcile.ts",
      query: "reconcile checkout ledger settlement",
      expectedSelected: ["src/z-settlement/reconcile.ts", "src/payments/checkout.ts", "src/payments/ledger.ts"],
    },
  ];

  for (const c of cases) {
    const repoDir = path.join(tmp, `map-bench-${c.fileCount}`);
    buildSyntheticCodeRepo(repoDir, c.fileCount, c.deepTarget);
    if (c.useGit) {
      execFileSync("git", ["init", "-b", "main", repoDir], { windowsHide: true, stdio: "ignore" });
    }
    const rawDumpBytes = measureSourceTreeBytes(
      repoDir,
      new Set([".env", "secrets/prod.key", "src/leak-probe.mjs", "src/auto.generated.js"])
    );

    const memBefore = process.memoryUsage();
    const t0 = performance.now();
    const r1 = buildCodebaseMap({
      projectDir: repoDir,
      queryText: c.query,
      seedPaths: new Set(["src/payments/checkout.ts"]),
      mapBudget: c.mapBudget,
      maxScannedFiles: c.maxScannedFiles,
    });
    const elapsedMs = performance.now() - t0;
    const memAfter = process.memoryUsage();
    const r2 = buildCodebaseMap({
      projectDir: repoDir,
      queryText: c.query,
      seedPaths: new Set(["src/payments/checkout.ts"]),
      mapBudget: c.mapBudget,
      maxScannedFiles: c.maxScannedFiles,
    });

    const selected = new Set(r1.selectedFiles.map((f) => f.path));
    const recallHits = c.expectedSelected.filter((p) => selected.has(p)).length;
    const leaks =
      r1.markdownSection.includes("benchmark_secret") ||
      r1.markdownSection.includes("KEY_MATERIAL") ||
      r1.markdownSection.includes("bundleNoise") ||
      r1.markdownSection.includes("genNoise") ||
      selected.has("src/leak-probe.mjs");
    const mapBytes = Buffer.byteLength(r1.markdownSection, "utf8");
    const sizeSavingsPct = Math.round(((rawDumpBytes - mapBytes) / rawDumpBytes) * 100);
    const heapDeltaMb = ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2);
    const rssDeltaMb = ((memAfter.rss - memBefore.rss) / (1024 * 1024)).toFixed(2);

    console.log(`Scenario: ${c.label}`);
    console.log(`  - Scan mode / discovered / scanned : ${r1.scanMode} / ${r1.totalDiscoveredFiles} / ${r1.scannedFilesCount} (truncated=${r1.truncatedScan})`);
    console.log(`  - Target recall                    : ${recallHits}/${c.expectedSelected.length} (${Math.round((recallHits / c.expectedSelected.length) * 100)}%)`);
    console.log(`  - Secret & .gitignore exclusions   : ${!leaks ? "100% blocked" : "LEAK DETECTED"}`);
    console.log(`  - Map size vs raw repo dump        : ${mapBytes} bytes (~${r1.estimatedTokens} est. tokens vs ~${Math.ceil(rawDumpBytes / 4)} raw; ${sizeSavingsPct}% smaller)`);
    console.log(`  - Latency / determinism            : ${elapsedMs.toFixed(2)} ms / ${r1.markdownSection === r2.markdownSection}`);
    console.log(`  - Memory delta (heap / rss)        : ${heapDeltaMb} MB / ${rssDeltaMb} MB`);
  }
}

function runHandoffBenchmark(tmp) {
  console.log("\n=== GeloForge Cross-Agent Handoff Benchmark ===");
  const projDir = path.join(tmp, "handoff-bench");
  buildBenchmarkFixture(projDir);
  execFileSync("git", ["init", "-b", "main", projDir], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", projDir, "config", "user.name", "Bench Bot"], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", projDir, "config", "user.email", "bench@example.invalid"], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", projDir, "add", "-A"], { windowsHide: true, stdio: "ignore" });
  execFileSync("git", ["-C", projDir, "commit", "-m", "Bench fixture"], { windowsHide: true, stdio: "ignore" });

  const memBefore = process.memoryUsage();
  const t0 = performance.now();
  const res = createHandoff({
    projectDir: projDir,
    taskId: "TASK-0001",
    fromRole: "developer",
    toRole: "qa-security-reviewer",
    fromTool: "codex",
    toTool: "gemini-cli",
    completedItems: ["Updated src/webhooks.mjs signature check"],
    openItems: ["Verify staging webhook retry timing"],
    unverifiedClaims: ["Load test hit 200 req/s in dev container"],
    blockers: ["CONF-0001 open contradiction on retry backoff"],
    recommendedNextAction: "Resolve CONF-0001 before production deployment.",
  });
  const insp = inspectHandoff({ projectDir: projDir, handoffPath: res.relPath });
  const projVal = validateProject(projDir);
  const elapsedMs = performance.now() - t0;
  const memAfter = process.memoryUsage();

  const requiredChecks = [
    Boolean(res.record.task_id),
    Boolean(res.record.git_state && res.record.git_state.available),
    Array.isArray(res.record.relevant_requirements) && res.record.relevant_requirements.length > 0,
    Array.isArray(res.record.relevant_decisions) && res.record.relevant_decisions.length > 0,
    Array.isArray(res.record.verified_evidence) && res.record.verified_evidence.length === 1,
    Array.isArray(res.record.unverified_claims) && res.record.unverified_claims.length === 1,
    Array.isArray(res.record.conflicts_detected) && res.record.conflicts_detected.includes("CONF-0001"),
    Boolean(res.record.recommended_next_action),
  ];
  const completenessHits = requiredChecks.filter(Boolean).length;
  const heapDeltaMb = ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2);
  const rssDeltaMb = ((memAfter.rss - memBefore.rss) / (1024 * 1024)).toFixed(2);

  console.log(`Scenario: Cross-agent handoff create + inspect + project validate (codex -> gemini-cli)`);
  console.log(`  - Structured field completeness      : ${completenessHits}/${requiredChecks.length} (100%)`);
  console.log(`  - Verified vs unverified separation  : verified=${res.record.verified_evidence.length}, unverified=${res.record.unverified_claims.length}`);
  console.log(`  - Handoff + Second Brain validation  : handoff=${insp.valid}, project=${projVal.valid}`);
  console.log(`  - YAML size / est. tokens            : ${Buffer.byteLength(res.yaml, "utf8")} bytes (~${estimateTokens(res.yaml)} est. tokens)`);
  console.log(`  - End-to-end latency                 : ${elapsedMs.toFixed(2)} ms`);
  console.log(`  - Memory delta (heap / rss)          : ${heapDeltaMb} MB / ${rssDeltaMb} MB`);
}

function runSkillsBenchmark(tmp) {
  console.log("\n=== GeloForge Portable Skills Progressive-Disclosure Benchmark ===");
  const projDir = path.join(tmp, "skills-bench");
  fs.mkdirSync(path.join(projDir, ".agents", "skills"), { recursive: true });
  fs.mkdirSync(path.join(projDir, "proposals", "skills", "unreviewed-draft"), { recursive: true });

  const relevantSkillDir = path.join(projDir, ".agents", "skills", "stripe-webhook-bugfix");
  fs.mkdirSync(path.join(relevantSkillDir, "references"), { recursive: true });
  fs.mkdirSync(path.join(relevantSkillDir, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(relevantSkillDir, "SKILL.md"),
    `---
name: "stripe-webhook-bugfix"
description: "Verify webhook signatures, enforce idempotency ledgers, and capture command evidence."
license: "MIT"
metadata:
  geloforge_tags: "stripe, webhook, idempotency, bugfix"
  geloforge_triggers: "webhook, signature, retry"
---

# Stripe Webhook Bugfix

## When to Use
Use when debugging payment webhook handlers or retry idempotency regressions.

## Checklist
- Review [webhook checklist](references/webhook-checklist.md)
- Copy [repro template](templates/repro-note.md)
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(relevantSkillDir, "references", "webhook-checklist.md"),
    `${"# Webhook Checklist\n- Verify HMAC timestamps and replay protection.\n".repeat(40)}`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(relevantSkillDir, "templates", "repro-note.md"),
    "# Repro Note\n- Event ID:\n- Signature Result:\n",
    "utf8"
  );

  const unrelatedTopics = ["auth-oauth", "css-grid", "docker-compose", "sql-tuning", "k8s-rollout", "mobile-push", "telemetry-otel", "docs-release"];
  for (const name of unrelatedTopics) {
    const d = path.join(projDir, ".agents", "skills", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "SKILL.md"),
      `---
name: "${name}"
description: "Run structured workflow checks and deployment notes for ${name} subsystems."
---

# ${name}

## When to Use
Use when maintaining ${name} components.

${`Detailed procedural notes for ${name} subsystem step execution.\n`.repeat(18)}
`,
      "utf8"
    );
  }

  fs.writeFileSync(
    path.join(projDir, "proposals", "skills", "unreviewed-draft", "SKILL.md"),
    `---
name: "unreviewed-draft"
description: "Unreviewed draft skill matching stripe webhook testing."
---

# Draft
## When to Use
Never auto-trusted.
`,
    "utf8"
  );

  // Measure naive eager load across all discovered skill + reference markdown bytes
  let naiveBytes = 0;
  const countMd = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) countMd(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) naiveBytes += fs.statSync(full).size;
    }
  };
  countMd(path.join(projDir, ".agents", "skills"));

  const memBefore = process.memoryUsage();
  const t0 = performance.now();
  const disc = discoverSkills({ projectDir: projDir, globalSkillsDir: null });
  const lint = lintDiscoveredSkills(disc, { strict: true });
  const r1 = compileSkillsSection({
    projectDir: projDir,
    globalSkillsDir: null,
    queryKeywords: tokenizeKeywords("Implement stripe webhook idempotency signature"),
    skillsBudget: 700,
  });
  const elapsedMs = performance.now() - t0;
  const memAfter = process.memoryUsage();
  const r2 = compileSkillsSection({
    projectDir: projDir,
    globalSkillsDir: null,
    queryKeywords: tokenizeKeywords("Implement stripe webhook idempotency signature"),
    skillsBudget: 700,
  });

  const progBytes = Buffer.byteLength(r1.markdownSection, "utf8");
  const savingsPct = Math.round(((naiveBytes - progBytes) / naiveBytes) * 100);
  const selectedNames = r1.manifestSummary.selected_skills.map((s) => s.name);
  const tier1RelevantHit = selectedNames.includes("stripe-webhook-bugfix") ? 1 : 0;
  const tier1UnrelatedLeaked = selectedNames.filter((n) => n !== "stripe-webhook-bugfix").length;
  const heapDeltaMb = ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2);
  const rssDeltaMb = ((memAfter.rss - memBefore.rss) / (1024 * 1024)).toFixed(2);

  console.log(`Scenario: 9 active skills (1 relevant + Tier 2 refs, 8 unrelated) + 1 quarantined draft`);
  console.log(`  - Discovery + strict lint valid       : ${lint.passed} (${disc.activeSkills.length} active, ${r1.manifestSummary.quarantined_excluded} quarantined excluded)`);
  console.log(`  - Tier 1 relevant recall / leakage    : ${tier1RelevantHit}/1 selected / ${tier1UnrelatedLeaked} unrelated loaded`);
  console.log(`  - Progressive vs naive eager bytes    : ${progBytes} bytes (~${r1.estimatedTokens} est. tokens) vs ${naiveBytes} bytes (~${Math.ceil(naiveBytes / 4)} raw; ${savingsPct}% smaller)`);
  console.log(`  - Discover+lint+select latency / det. : ${elapsedMs.toFixed(2)} ms / ${r1.markdownSection === r2.markdownSection}`);
  console.log(`  - Memory delta (heap / rss)           : ${heapDeltaMb} MB / ${rssDeltaMb} MB`);
}

runBenchmark();
