#!/usr/bin/env node
/**
 * Deterministic relevance, mandatory-coverage, size, and timing benchmark comparing:
 *   Baseline : v0.2.0 naive full Second Brain + global policy dump (no selective compiler)
 *   Candidate: compileContext() (Stage 2 deterministic Context Compiler)
 * Note: Model-level LLM accuracy is NOT measured here (requires live model/paid API runs).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { compileContext, estimateTokens } from "../core/context-compiler.mjs";

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
      console.log(`  - Budget target / overrun                   : ${res1.manifest.token_budget_target} / ${res1.budgetOverrun} (effective: ${res1.manifest.effective_profile})`);
      console.log(`  - Compile latency / deterministic           : ${elapsedMs.toFixed(2)} ms / ${deterministic}`);
    }
    console.log("\nNote: Model-level LLM accuracy/token billing is NOT measured without live model API execution.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

runBenchmark();
