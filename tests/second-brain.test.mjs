import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { validateProject } from "../core/project-validator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const VALIDATE_CLI = path.join(HARNESS_DIR, "scripts", "validate-project.mjs");

function populateRichValidRecords(projectDir) {
  for (const d of ["brain/research", "brain/conflicts", "brain/incidents", "proposals", "evidence"]) {
    fs.mkdirSync(path.join(projectDir, d), { recursive: true });
  }

  fs.writeFileSync(
    path.join(projectDir, "brain", "decisions", "ADR-0001-storage.md"),
    `---
schema_version: "1.1"
id: "ADR-0001"
title: "Use Plain YAML and Markdown"
status: "accepted"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A2"
owner: "Project Owner"
proposed_by: "software-architect"
approved_by: "Project Owner"
created_at: "2026-01-10T00:00:00Z"
updated_at: "2026-01-11T00:00:00Z"
decided_at: "2026-01-11T00:00:00Z"
review_by: "2027-01-11"
supersedes: []
superseded_by: null
related_requirements:
  - "brain/requirements/constraints.md"
related_research:
  - "RES-0001"
approval_ref: "APPR-0001"
tags:
  - "storage"
---

# ADR-0001
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "brain", "research", "RES-0001-yaml.md"),
    `---
schema_version: "1.1"
id: "RES-0001"
title: "YAML Subset Tradeoffs"
status: "verified"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A5"
author_role: "researcher"
created_at: "2026-01-05T00:00:00Z"
updated_at: "2026-01-05T00:00:00Z"
valid_until: "2028-01-05"
question: "Can zero-dep YAML subset cover project records?"
confidence: "high"
sources:
  - title: "YAML 1.2 Spec"
    reference: "local://spec-notes"
    type: "standard"
    accessed_at: "2026-01-05T00:00:00Z"
related_tasks:
  - "TASK-0001"
related_adrs:
  - "ADR-0001"
contradicts: []
tags:
  - "yaml"
---

# RES-0001
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "proposals", "APPR-0001-adr.yaml"),
    `schema_version: "1.1"
id: "APPR-0001"
title: "Approve ADR-0001"
status: "approved"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A1"
boundary_category: "architecture_change"
requested_by: "software-architect"
requested_at: "2026-01-10T00:00:00Z"
decided_by: "Project Owner"
decided_at: "2026-01-11T00:00:00Z"
expires_at: null
target_records:
  - "ADR-0001"
rationale: "Keeps project memory portable."
risk_assessment: "Low"
conditions: []
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "tasks", "TASK-0001-setup.yaml"),
    `schema_version: "1.1"
id: "TASK-0001"
title: "Initialize Core Record Set"
project_id: "proj-second-brain-fixture"
status: "active"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
priority: "medium"
assigned_role: "developer"
created_by: "orchestrator"
created_at: "2026-01-12T00:00:00Z"
updated_at: "2026-01-12T00:00:00Z"
objective: "Validate core records."
scope_in:
  - "brain/"
scope_out:
  - "external APIs"
required_inputs:
  - path: "brain/INDEX.md"
    revision: "rev-1"
expected_outputs:
  - "evidence/EVID-0001-check.yaml"
acceptance_criteria:
  - "Validation passes cleanly."
dependencies: []
approval_required: true
approval_ref: "APPR-0001"
context_budget: "quick"
max_retries: 2
evidence_refs:
  - "EVID-0001"
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "evidence", "EVID-0001-check.yaml"),
    `schema_version: "1.1"
id: "EVID-0001"
title: "Local Check Evidence"
task_id: "TASK-0001"
status: "verified"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A3"
produced_by_role: "qa-security-reviewer"
verified_by: "Project Owner"
created_at: "2026-01-12T01:00:00Z"
source_revision: "rev-1"
environment:
  os: "Windows 11"
  runtime: "Node.js 24"
checks:
  - name: "Validate project"
    command: "node scripts/validate-project.mjs"
    result: "passed"
    summary: "All checks passed."
artifacts: []
limitations: []
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "brain", "incidents", "INC-0001-minor.yaml"),
    `schema_version: "1.1"
id: "INC-0001"
title: "Minor Regression Fixture"
status: "resolved"
severity: "low"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
detected_at: "2026-01-12T02:00:00Z"
detected_by: "qa-security-reviewer"
summary: "Simulated minor issue."
impact: "None"
root_cause: "Missing fixture reference"
related_tasks:
  - "TASK-0001"
evidence_refs:
  - "EVID-0001"
follow_up_actions:
  - "Added regression test."
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(projectDir, "brain", "state", "current.yaml"),
    `schema_version: "1.1"
project_id: "proj-second-brain-fixture"
state_revision: 1
status: "active"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
updated_at: "2026-01-12T02:00:00Z"
updated_by: "orchestrator"
current_phase: "verification"
active_tasks:
  - "TASK-0001"
blocked_tasks: []
pending_approvals: []
open_conflicts: []
last_verified_evidence: "EVID-0001"
last_checkpoint: null
last_completed_task: null
known_dependencies: []
summary: "Rich fixture state."
`,
    "utf8"
  );
}

test("Second Brain validator accepts valid complete record graph and CLI exits 0", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sb-ok-"));
  try {
    const projectDir = path.join(tmp, "sb-valid");
    bootstrapProject({ name: "Second Brain Fixture", dest: projectDir });
    populateRichValidRecords(projectDir);

    const res = validateProject(projectDir, { referenceDate: "2026-11-19" });
    assert.equal(res.valid, true, res.errors.join("; "));
    assert.equal(res.recordCount, 6);
    assert.equal(res.warnings.length, 0);

    const cliRes = spawnSync(process.execPath, [VALIDATE_CLI, "--project", projectDir], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliRes.status, 0, cliRes.stderr);
    assert.match(cliRes.stdout, /Project Validation: PASS/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("Second Brain validator rejects malformed, duplicate, stale-violating, and broken-ref records", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-sb-bad-"));
  try {
    // 1. Duplicate ID detection
    const dupDir = path.join(tmp, "dup");
    bootstrapProject({ name: "Second Brain Fixture", slug: "second-brain-fixture", dest: dupDir });
    populateRichValidRecords(dupDir);
    fs.copyFileSync(
      path.join(dupDir, "tasks", "TASK-0001-setup.yaml"),
      path.join(dupDir, "tasks", "TASK-0001-duplicate.yaml")
    );
    const dupRes = validateProject(dupDir);
    assert.equal(dupRes.valid, false);
    assert.match(dupRes.errors.join("\n"), /Duplicate record ID "TASK-0001"/);

    // 2. Broken cross-record reference + invalid status + missing required field + broken markdown link
    const badDir = path.join(tmp, "bad");
    bootstrapProject({ name: "Second Brain Fixture", slug: "second-brain-fixture", dest: badDir });
    populateRichValidRecords(badDir);
    fs.writeFileSync(
      path.join(badDir, "tasks", "TASK-0002-broken.yaml"),
      `schema_version: "1.1"
id: "TASK-0002"
title: "Broken Task"
project_id: "proj-second-brain-fixture"
status: "bogus_status"
memory_layer: "L2_OPERATIONAL"
authority_level: "A4"
priority: "low"
assigned_role: "developer"
created_by: "orchestrator"
created_at: "2026-01-12T00:00:00Z"
updated_at: "2026-01-12T00:00:00Z"
scope_in: []
scope_out: []
required_inputs:
  - path: "missing-file.md"
    revision: "rev-1"
expected_outputs: []
acceptance_criteria:
  - "Criterion"
dependencies:
  - "TASK-9999"
approval_required: false
approval_ref: "APPR-9999"
context_budget: "quick"
max_retries: 1
evidence_refs: []
`,
      "utf8"
    );
    fs.appendFileSync(path.join(badDir, "README.md"), "\n[Broken](./does-not-exist.md)\n", "utf8");
    const badRes = validateProject(badDir);
    assert.equal(badRes.valid, false);
    const errText = badRes.errors.join("\n");
    assert.match(errText, /missing required property "objective"/);
    assert.match(errText, /not in enum/);
    assert.match(errText, /broken reference to unknown record ID "TASK-9999"/);
    assert.match(errText, /broken reference to unknown record ID "APPR-9999"/);
    assert.match(errText, /referenced file does not exist: missing-file\.md/);
    assert.match(errText, /broken relative markdown link "\.\/does-not-exist\.md"/);

    const cliBad = spawnSync(process.execPath, [VALIDATE_CLI, "--project", badDir], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(cliBad.status, 1);

    // 3. Example record in canonical dir + unapproved accepted ADR + invalid YAML tab + stale research warning
    const miscDir = path.join(tmp, "misc");
    bootstrapProject({ name: "Second Brain Fixture", slug: "second-brain-fixture", dest: miscDir });
    populateRichValidRecords(miscDir);
    fs.writeFileSync(
      path.join(miscDir, "brain", "decisions", "ADR-0002-bad.md"),
      `---
schema_version: "1.1"
id: "ADR-0002"
title: "Unapproved Accepted Example"
status: "accepted"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A2"
owner: "Owner"
proposed_by: "software-architect"
approved_by: null
created_at: "2026-01-10T00:00:00Z"
updated_at: "2026-01-10T00:00:00Z"
decided_at: null
review_by: null
supersedes: []
superseded_by: null
related_requirements: []
related_research: []
approval_ref: null
tags: []
is_example: true
example_notice: "EXAMPLE ONLY"
---
`,
      "utf8"
    );
    fs.writeFileSync(path.join(miscDir, "tasks", "TASK-0003-tab.yaml"), "id:\n\tbad: 1\n", "utf8");
    const miscRes = validateProject(miscDir, { referenceDate: "2030-01-01" });
    assert.equal(miscRes.valid, false);
    assert.match(miscRes.errors.join("\n"), /example record \(is_example: true\) is forbidden/);
    assert.match(miscRes.errors.join("\n"), /accepted ADR must specify non-null approved_by/);
    assert.match(miscRes.errors.join("\n"), /Tabs are forbidden/);
    assert.ok(miscRes.warnings.some((w) => /RES-0001.*expired/.test(w)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
