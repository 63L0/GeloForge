import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { createHandoff, inspectHandoff } from "../core/handoff.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { validateAgainstSchema } from "../core/json-schema-lite.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const CLI_PATH = path.join(HARNESS_DIR, "scripts", "geloforge.mjs");

function hashTree(baseDir, subPaths) {
  const out = new Map();
  const walk = (abs) => {
    if (!fs.existsSync(abs)) return;
    const stat = fs.lstatSync(abs);
    if (stat.isFile()) {
      const rel = path.relative(baseDir, abs).replace(/\\/g, "/");
      out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
    } else if (stat.isDirectory()) {
      for (const e of fs.readdirSync(abs).sort()) walk(path.join(abs, e));
    }
  };
  for (const s of subPaths) walk(path.join(baseDir, s));
  return out;
}

function setupHandoffProject(projectDir, { withGit = true } = {}) {
  bootstrapProject({ name: "Handoff Fixture App", dest: projectDir, git: withGit });
  fs.mkdirSync(path.join(projectDir, "brain", "conflicts"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "evidence"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });

  fs.writeFileSync(path.join(projectDir, "src", "app.mjs"), "export function run() { return 1; }\n", "utf8");

  // Approved ADR vs Spoofed ADR (missing approved_by)
  fs.writeFileSync(
    path.join(projectDir, "brain", "decisions", "ADR-0001-core-api.md"),
    `---
schema_version: "1.1"
id: "ADR-0001"
title: "Use REST JSON Contracts"
status: "accepted"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A2"
owner: "Project Owner"
proposed_by: "software-architect"
approved_by: "Project Owner"
created_at: "2026-02-01T00:00:00Z"
updated_at: "2026-02-02T00:00:00Z"
decided_at: "2026-02-02T00:00:00Z"
review_by: "2027-02-02"
supersedes: []
superseded_by: null
related_requirements:
  - "brain/requirements/prd.md"
related_research: []
approval_ref: null
tags:
  - "api"
---

# Approved API Decision
Use explicit JSON schemas.
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "brain", "decisions", "ADR-0002-proposed.md"),
    `---
schema_version: "1.1"
id: "ADR-0002"
title: "Unapproved Experimental GraphQL"
status: "proposed"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A6"
owner: "Project Owner"
proposed_by: "researcher"
approved_by: null
created_at: "2026-02-05T00:00:00Z"
updated_at: "2026-02-05T00:00:00Z"
decided_at: null
review_by: null
supersedes: []
superseded_by: null
related_requirements: []
related_research: []
approval_ref: null
tags: []
---

# Proposed Only
Pending review.
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "tasks", "TASK-0001-api-endpoint.yaml"),
    `schema_version: "1.1"
id: "TASK-0001"
title: "Build Status Endpoint"
project_id: "proj-handoff-fixture-app"
status: "active"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
priority: "high"
assigned_role: "developer"
created_by: "orchestrator"
created_at: "2026-03-01T00:00:00Z"
updated_at: "2026-03-01T00:00:00Z"
objective: "Implement status endpoint per ADR-0001."
scope_in:
  - "src/app.mjs"
scope_out: []
required_inputs:
  - path: "src/app.mjs"
    revision: "HEAD"
expected_outputs:
  - "evidence/EVID-0001-endpoint.yaml"
acceptance_criteria:
  - "Endpoint returns 200 OK."
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
    path.join(projectDir, "evidence", "EVID-0001-endpoint.yaml"),
    `schema_version: "1.1"
id: "EVID-0001"
title: "Endpoint Unit Tests"
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
  - name: "Status test suite"
    command: "node --test"
    result: "passed"
    summary: "All status tests passed."
artifacts: []
limitations: []
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "brain", "conflicts", "CONF-0001-rate-limit.yaml"),
    `schema_version: "1.1"
id: "CONF-0001"
title: "Rate Limit Default Disagreement"
status: "open"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
severity: "medium"
detected_at: "2026-03-02T00:00:00Z"
detected_by: "developer"
conflicting_records:
  - record_id: "ADR-0001"
    path: "brain/decisions/ADR-0001-core-api.md"
    authority_level: "A2"
    claim: "100 req/min"
  - record_id: "TASK-0001"
    path: "tasks/TASK-0001-api-endpoint.yaml"
    authority_level: "A4"
    claim: "600 req/min"
description: "Need decision on default rate limit."
impact: "Blocks final middleware config."
resolution_strategy: null
resolved_by: null
resolved_at: null
approval_ref: null
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "brain", "state", "current.yaml"),
    `schema_version: "1.1"
project_id: "proj-handoff-fixture-app"
state_revision: 1
status: "active"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
updated_at: "2026-03-02T00:00:00Z"
updated_by: "orchestrator"
current_phase: "implementation"
active_tasks:
  - "TASK-0001"
blocked_tasks: []
pending_approvals: []
open_conflicts:
  - "CONF-0001"
last_verified_evidence: "EVID-0001"
last_checkpoint: null
last_completed_task: null
known_dependencies: []
summary: "Implementing API endpoint."
`,
    "utf8"
  );

  if (withGit) {
    execFileSync("git", ["-C", projectDir, "config", "user.name", "Handoff Bot"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", projectDir, "config", "user.email", "handoff@example.invalid"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", projectDir, "add", "-A"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", projectDir, "commit", "-m", "Initial fixture"], { windowsHide: true, stdio: "ignore" });
  }
}

test("createHandoff separates verified evidence from unverified claims, redacts secret paths, and preserves Second Brain immutability", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-hoff-main-"));
  try {
    const projectDir = path.join(tmp, "proj");
    setupHandoffProject(projectDir, { withGit: true });

    // Create dirty modified tracked file + untracked secret file (must NOT enter git_state.changed_files)
    fs.appendFileSync(path.join(projectDir, "src", "app.mjs"), "export const v = 2;\n", "utf8");
    fs.writeFileSync(path.join(projectDir, ".env.local"), "SECRET=123\n", "utf8");

    const beforeHashes = hashTree(projectDir, ["brain/decisions", "brain/requirements", "brain/manifest.yaml", "brain/state/current.yaml"]);

    const res = createHandoff({
      projectDir,
      taskId: "TASK-0001",
      fromRole: "developer",
      toRole: "qa-security-reviewer",
      fromTool: "codex",
      toTool: "gemini-cli",
      completedItems: ["Implemented /status handler in src/app.mjs"],
      openItems: ["Add rate-limit integration check"],
      unverifiedClaims: ["Staging benchmark handled 500 rps locally"],
      blockers: ["Waiting on CONF-0001 rate-limit decision"],
      openQuestions: ["Should 429 include Retry-After header?"],
      unresolvedRisks: ["Rate limit unconfigured under load"],
      recommendedNextAction: "Resolve CONF-0001 and review EVID-0001.",
    });

    const afterHashes = hashTree(projectDir, ["brain/decisions", "brain/requirements", "brain/manifest.yaml", "brain/state/current.yaml"]);
    assert.deepEqual(afterHashes, beforeHashes, "Handoff creation must never modify Second Brain decisions/requirements/state");

    assert.equal(res.id, "HANDOFF-0001");
    assert.equal(fs.existsSync(res.filePath), true);
    assert.equal(res.record.from_tool, "codex");
    assert.equal(res.record.to_tool, "gemini-cli");
    assert.deepEqual(res.record.relevant_decisions, ["ADR-0001"]);
    assert.deepEqual(res.record.conflicts_detected, ["CONF-0001"]);
    assert.equal(res.record.verified_evidence.length, 1);
    assert.equal(res.record.verified_evidence[0].id, "EVID-0001");
    assert.equal(res.record.unverified_claims.includes("Staging benchmark handled 500 rps locally"), true);
    assert.equal(res.record.git_state.available, true);
    assert.equal(res.record.git_state.dirty, true);
    assert.equal(res.record.git_state.changed_files.includes("src/app.mjs"), true);
    assert.equal(res.record.git_state.changed_files.includes(".env.local"), false);

    // Schema and full project validation must pass cleanly
    const schema = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, "schemas", "agent-handoff.schema.json"), "utf8"));
    const sCheck = validateAgainstSchema(res.record, schema);
    assert.equal(sCheck.valid, true, sCheck.errors.join("; "));

    const valRes = validateProject(projectDir);
    assert.equal(valRes.valid, true, valRes.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("createHandoff never promotes unverified/failed claims into verified_evidence and warns on contradictions", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-hoff-evid-"));
  try {
    const projectDir = path.join(tmp, "proj");
    setupHandoffProject(projectDir, { withGit: false });

    // Replace EVID-0001 with failed/draft check so task has zero verified evidence
    fs.writeFileSync(
      path.join(projectDir, "evidence", "EVID-0001-endpoint.yaml"),
      `schema_version: "1.1"
id: "EVID-0001"
title: "Failing Endpoint Tests"
task_id: "TASK-0001"
status: "draft"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A3"
produced_by_role: "developer"
verified_by: null
created_at: "2026-03-02T00:00:00Z"
source_revision: "rev-1"
environment:
  os: "Windows 11"
  runtime: "Node.js 24"
checks:
  - name: "Status test suite"
    command: "node --test"
    result: "failed"
    summary: "Returned 500 on malformed header."
artifacts: []
limitations: []
`,
      "utf8"
    );

    const res = createHandoff({
      projectDir,
      taskId: "TASK-0001",
      completedItems: ["All tests passed cleanly locally"],
      unverifiedClaims: ["All checks passed after retry"],
      evidenceRefs: ["EVID-9999"],
    });

    assert.equal(res.record.git_state.available, false);
    assert.deepEqual(res.record.verified_evidence, []);
    // Missing EVID-9999 must not enter evidence_refs (preserves validateProject reference integrity)
    assert.deepEqual(res.record.evidence_refs, ["EVID-0001"]);
    assert.ok(res.record.unverified_claims.some((c) => /All tests passed cleanly locally/.test(c)));
    assert.ok(res.record.unverified_claims.some((c) => /EVID-9999/.test(c)));
    assert.ok(res.record.contradiction_warnings.some((w) => /EVID-0001.*not verified/.test(w)));
    assert.ok(res.record.contradiction_warnings.some((w) => /EVID-9999/.test(w)));
    assert.ok(res.record.contradiction_warnings.some((w) => /without uncontradicted verified EVID-\* record/.test(w)));
    assert.ok(res.record.contradiction_warnings.some((w) => /contains failed check/.test(w)));

    const valRes = validateProject(projectDir);
    assert.equal(valRes.valid, true, valRes.errors.join("; "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("createHandoff handles unborn HEAD, secret rejection, duplicate IDs, overwrite refusal, and atomic rollback", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-hoff-edge-"));
  try {
    const projectDir = path.join(tmp, "proj");
    setupHandoffProject(projectDir, { withGit: false });
    // Initialize Git repo with ZERO commits (unborn HEAD)
    execFileSync("git", ["init", "-b", "main", projectDir], { windowsHide: true, stdio: "ignore" });

    // Reject credential content inside caller summary or claims
    const fakeKey = "sk-" + "abcdefghijklmnopqrstuvwxyz123456";
    assert.throws(
      () => createHandoff({ projectDir, taskId: "TASK-0001", summary: `Testing ${fakeKey}` }),
      /credential-like/
    );

    // Dry-run validates without writing
    const dryRes = createHandoff({ projectDir, taskId: "TASK-0001", dryRun: true });
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.record.git_state.head, "unborn-head");
    assert.equal(fs.existsSync(dryRes.filePath), false);

    // Atomic rollback on simulated write failure leaves zero temp files
    assert.throws(
      () =>
        createHandoff({
          projectDir,
          taskId: "TASK-0001",
          onBeforeCommit: () => {
            throw new Error("Simulated disk failure before rename");
          },
        }),
      /Simulated disk failure/
    );
    const handoffsDir = path.join(projectDir, "handoffs");
    if (fs.existsSync(handoffsDir)) {
      assert.deepEqual(fs.readdirSync(handoffsDir), []);
    }

    // Create real HANDOFF-0001
    const okRes = createHandoff({ projectDir, taskId: "TASK-0001" });
    assert.equal(fs.existsSync(okRes.filePath), true);

    // Refuse duplicate explicit ID or overwriting existing file
    assert.throws(() => createHandoff({ projectDir, taskId: "TASK-0001", id: "HANDOFF-0001" }), /Duplicate handoff ID/);
    assert.throws(() => createHandoff({ projectDir, taskId: "TASK-0001", out: okRes.filePath }), /Refusing to overwrite/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("inspectHandoff validates 1.1 & legacy 1.0 handoffs, detects Git drift, and works via CLI", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gf-hoff-cli-"));
  try {
    const projectDir = path.join(tmp, "proj");
    setupHandoffProject(projectDir, { withGit: true });

    // CLI create handoff with --json
    const createdStdout = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "handoff",
        "--project",
        projectDir,
        "--task",
        "TASK-0001",
        "--from-tool",
        "antigravity",
        "--to-tool",
        "codex",
        "--completed",
        "Added handler",
        "--claim",
        "Manual smoke check OK",
        "--json",
      ],
      { encoding: "utf8", windowsHide: true }
    );
    const created = JSON.parse(createdStdout);
    assert.equal(created.id, "HANDOFF-0001");

    // Advance Git HEAD to verify drift detection in inspectHandoff
    fs.writeFileSync(path.join(projectDir, "src", "extra.mjs"), "export const x = 1;\n", "utf8");
    execFileSync("git", ["-C", projectDir, "add", "-A"], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", projectDir, "commit", "-m", "Advance HEAD"], { windowsHide: true, stdio: "ignore" });

    const inspRaw = execFileSync(
      process.execPath,
      [CLI_PATH, "handoff", "--project", projectDir, "--inspect", created.relPath, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    const insp = JSON.parse(inspRaw);
    assert.equal(insp.valid, true);
    assert.equal(insp.gitDrift.changed, true);
    assert.ok(insp.warnings.some((w) => /Git HEAD moved/.test(w)));

    // Legacy v0.2.0 schema_version 1.0 handoff fixture validates via inspectHandoff
    const legacyRel = "handoffs/HANDOFF-0009-legacy.yaml";
    fs.writeFileSync(
      path.join(projectDir, legacyRel),
      `schema_version: "1.0"
id: "HANDOFF-0009"
task_id: "TASK-0001"
from_role: "developer"
to_role: "qa-security-reviewer"
status: "submitted"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
created_at: "2026-01-10T00:00:00Z"
summary: "Legacy 1.0 format handoff"
completed_items:
  - "Initial scaffolding"
open_items:
  - "Run verification"
artifacts_produced: []
evidence_refs:
  - "EVID-0001"
unresolved_risks: []
conflicts_detected: []
recommended_next_action: "Verify tests."
context_pack_ref: null
`,
      "utf8"
    );
    const legacyInsp = inspectHandoff({ projectDir, handoffPath: legacyRel });
    assert.equal(legacyInsp.valid, true, legacyInsp.errors.join("; "));
    assert.equal(legacyInsp.schemaVersion, "1.0");
    assert.ok(legacyInsp.markdown.includes("HANDOFF-0009"));

    // Error handling: missing file, traversal, and malformed YAML
    assert.throws(() => inspectHandoff({ projectDir, handoffPath: "handoffs/MISSING.yaml" }), /not found/);
    assert.throws(() => inspectHandoff({ projectDir, handoffPath: "../outside.yaml" }), /escapes/);
    fs.writeFileSync(path.join(projectDir, "handoffs", "HANDOFF-0010-bad.yaml"), "schema_version:\n\tbad: true\n", "utf8");
    assert.throws(() => inspectHandoff({ projectDir, handoffPath: "handoffs/HANDOFF-0010-bad.yaml" }), /Tabs are forbidden/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
