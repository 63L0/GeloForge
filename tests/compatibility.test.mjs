import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCompatibilityConfig,
  checkManifestCompatibility,
  checkRecordSchemaVersion,
  upgradeManifestFixture10To11,
} from "../core/compatibility.mjs";
import { bootstrapProject } from "../scripts/bootstrap-project.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { parseYaml } from "../core/yaml-subset.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");

test("version metadata across VERSION, package.json, and compatibility.json stays synchronized", () => {
  const versionTxt = fs.readFileSync(path.join(HARNESS_DIR, "VERSION"), "utf8").trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(HARNESS_DIR, "package.json"), "utf8"));
  const compat = loadCompatibilityConfig();

  assert.equal(versionTxt, pkg.version);
  assert.equal(compat.harness_version, versionTxt);
  assert.ok(Number.parseInt(process.versions.node.split(".")[0], 10) >= 20);
});

test("compatibility checker accepts 1.1 and 1.0, and rejects unsupported versions", () => {
  const compat = loadCompatibilityConfig();

  const currentRes = checkManifestCompatibility(
    {
      schema_version: "1.1",
      template_version: "1.0.0",
      profile: "web",
      profile_version: "1.0.0",
    },
    compat
  );
  assert.equal(currentRes.compatible, true);
  assert.equal(currentRes.status, "current");

  const legacyRes = checkManifestCompatibility({ schema_version: "1.0" }, compat);
  assert.equal(legacyRes.compatible, true);
  assert.equal(legacyRes.status, "compatible_upgrade_available");
  assert.ok(legacyRes.warnings.length > 0);

  const badSchema = checkManifestCompatibility({ schema_version: "2.0", template_version: "1.0.0" }, compat);
  assert.equal(badSchema.compatible, false);

  const badTemplate = checkManifestCompatibility({ schema_version: "1.1", template_version: "2.0.0" }, compat);
  assert.equal(badTemplate.compatible, false);

  const badProfile = checkManifestCompatibility(
    { schema_version: "1.1", template_version: "1.0.0", profile: "web", profile_version: "2.0.0" },
    compat
  );
  assert.equal(badProfile.compatible, false);

  assert.equal(checkRecordSchemaVersion({ schema_version: "9.9" }, compat).compatible, false);
});

test("simulated upgrade from 1.0 manifest fixture to 1.1 passes full project validation", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-upg-"));
  try {
    const projectDir = path.join(tmp, "legacy-proj");
    bootstrapProject({ name: "Legacy Project", dest: projectDir });

    // Rewrite manifest into a Phase 1 (1.0) fixture.
    const legacyManifestYaml = `schema_version: "1.0"
project_id: "proj-legacy-project"
slug: "legacy-project"
name: "Legacy Project"
description: "Phase 1.0 manifest fixture"
status: "initialized"
owner: "Project Owner"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A1"
harness_version: "0.1.0-foundation"
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-01T00:00:00Z"
repository:
  vcs: "git"
  initialized: false
  default_branch: "main"
paths:
  brain_index: "brain/INDEX.md"
  prd: "brain/requirements/prd.md"
  constraints: "brain/requirements/constraints.md"
  architecture: "brain/architecture/overview.md"
  state: "brain/state/current.yaml"
  decisions_dir: "brain/decisions"
  research_dir: "brain/research"
  tasks_dir: "tasks"
  evidence_dir: "evidence"
  proposals_dir: "proposals"
policies:
  - "policies/approval-boundaries.md"
`;
    const manifestPath = path.join(projectDir, "brain", "manifest.yaml");
    fs.writeFileSync(manifestPath, legacyManifestYaml, "utf8");

    const preUpgrade = validateProject(projectDir);
    assert.equal(preUpgrade.valid, true);
    assert.equal(preUpgrade.compatibilityStatus, "compatible_upgrade_available");
    assert.ok(preUpgrade.warnings.length > 0);

    // Simulate upgrade 1.0 -> 1.1 and verify clean current status.
    const parsedLegacy = parseYaml(fs.readFileSync(manifestPath, "utf8"));
    const upgraded = upgradeManifestFixture10To11(parsedLegacy);
    const upgradedYaml = legacyManifestYaml
      .replace('schema_version: "1.0"', `schema_version: "${upgraded.schema_version}"`)
      .replace('harness_version: "0.1.0-foundation"', `harness_version: "${upgraded.harness_version}"\ntemplate_version: "${upgraded.template_version}"\nprofile: null\nprofile_version: null`);
    fs.writeFileSync(manifestPath, upgradedYaml, "utf8");

    const postUpgrade = validateProject(projectDir);
    assert.equal(postUpgrade.valid, true, postUpgrade.errors.join("; "));
    assert.equal(postUpgrade.compatibilityStatus, "current");
    assert.equal(postUpgrade.warnings.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
});
