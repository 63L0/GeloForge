import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, extractFrontmatter } from "../core/yaml-subset.mjs";
import { validateAgainstSchema } from "../core/json-schema-lite.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(HARNESS_DIR, "..");

function walkFiles(dir, predicate = () => true) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && predicate(full)) {
      results.push(full);
    }
  }
  return results;
}

function stripFencedAndInlineCode(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      out.push(line.replace(/`[^`]*`/g, ""));
    }
  }
  return out.join("\n");
}

test("workspace and harness structural boundaries are clean", () => {
  const isWorkspaceLayout =
    path.basename(HARNESS_DIR).toLowerCase() === "harness" &&
    fs.existsSync(path.join(WORKSPACE_ROOT, "local-runtime"));

  if (isWorkspaceLayout) {
    for (const rel of [
      "harness",
      "projects",
      "worktrees",
      "local-runtime",
      "local-runtime/logs",
      "local-runtime/context-cache",
      "local-runtime/checkpoints",
      "local-runtime/task-state",
    ]) {
      assert.equal(fs.existsSync(path.join(WORKSPACE_ROOT, rel)), true, `Missing workspace dir: ${rel}`);
    }
    assert.equal(fs.existsSync(path.join(WORKSPACE_ROOT, ".git")), false, "Workspace root must not contain .git");
  }
  assert.equal(fs.existsSync(path.join(HARNESS_DIR, ".git")), true, "harness/.git must exist");

  for (const obsolete of ["skills", "evaluations", "validators"]) {
    assert.equal(fs.existsSync(path.join(HARNESS_DIR, obsolete)), false, `Obsolete folder still present: ${obsolete}`);
  }

  for (const rel of [
    "README.md",
    "LICENSE",
    "VERSION",
    ".gitignore",
    ".gitattributes",
    "package.json",
    "CHANGELOG.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "core/yaml-subset.mjs",
    "core/json-schema-lite.mjs",
    "core/path-safety.mjs",
    "core/compatibility.json",
    "core/compatibility.mjs",
    "core/project-validator.mjs",
    "adapters/README.md",
    "adapters/antigravity/README.md",
    "adapters/codex/README.md",
    "adapters/gemini/README.md",
    "scripts/bootstrap-project.mjs",
    "scripts/validate-project.mjs",
    "docs/versioning-and-upgrades.md",
  ]) {
    assert.equal(fs.existsSync(path.join(HARNESS_DIR, rel)), true, `Missing harness file: ${rel}`);
  }
});

test("project-starter template keeps minimal 4 empty .gitkeep folders and required files", () => {
  const starterDir = path.join(HARNESS_DIR, "templates", "project-starter");
  const expectedFiles = [
    ".gitignore",
    "AGENTS.md",
    "GEMINI.md",
    "README.md",
    "brain/INDEX.md",
    "brain/manifest.yaml",
    "brain/requirements/prd.md",
    "brain/requirements/constraints.md",
    "brain/architecture/overview.md",
    "brain/state/current.yaml",
    "brain/decisions/.gitkeep",
    "tasks/.gitkeep",
    "src/.gitkeep",
    "tests/.gitkeep",
  ];
  for (const rel of expectedFiles) {
    assert.equal(fs.existsSync(path.join(starterDir, rel)), true, `Missing starter file: ${rel}`);
  }
  const actualGitkeeps = walkFiles(starterDir, (p) => path.basename(p) === ".gitkeep")
    .map((p) => path.relative(starterDir, p).replace(/\\/g, "/"))
    .sort();
  assert.deepEqual(actualGitkeeps, [
    "brain/decisions/.gitkeep",
    "src/.gitkeep",
    "tasks/.gitkeep",
    "tests/.gitkeep",
  ]);
});

test("all 12 JSON schemas parse strictly and all 10 templates + 10 examples validate", () => {
  const schemaFiles = walkFiles(path.join(HARNESS_DIR, "schemas"), (p) => p.endsWith(".schema.json"));
  assert.equal(schemaFiles.length, 12, "Expected exactly 12 JSON schema files");

  const schemas = {};
  for (const full of schemaFiles) {
    const name = path.basename(full);
    const schema = JSON.parse(fs.readFileSync(full, "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", `${name}: bad $schema`);
    assert.equal(schema.type, "object", `${name}: root type must be object`);
    assert.equal(schema.additionalProperties, false, `${name}: additionalProperties must be false`);
    schemas[name] = schema;
  }

  for (const rel of [
    "contracts/task-contract-template.yaml",
    "contracts/agent-handoff-template.yaml",
    "contracts/evidence-manifest-template.yaml",
    "contracts/approval-record-template.yaml",
    "contracts/conflict-record-template.yaml",
    "contracts/incident-record-template.yaml",
    "contracts/recovery-checkpoint-template.yaml",
    "contracts/context-pack-manifest-template.yaml",
    "templates/project-starter/brain/manifest.yaml",
    "templates/project-starter/brain/state/current.yaml",
  ]) {
    const parsed = parseYaml(fs.readFileSync(path.join(HARNESS_DIR, rel), "utf8"), rel);
    assert.equal(typeof parsed, "object");
  }
  for (const rel of ["contracts/adr-template.md", "contracts/research-record-template.md"]) {
    const parsed = extractFrontmatter(fs.readFileSync(path.join(HARNESS_DIR, rel), "utf8"), rel);
    assert.equal(typeof parsed, "object");
  }

  const examples = [
    { file: "ADR-0000-example-decision.md", schema: "adr.schema.json", frontmatter: true },
    { file: "TASK-0000-example-task.yaml", schema: "task-contract.schema.json", frontmatter: false },
    { file: "HANDOFF-0000-example-handoff.yaml", schema: "agent-handoff.schema.json", frontmatter: false },
    { file: "RES-0000-example-research.md", schema: "research-record.schema.json", frontmatter: true },
    { file: "EVID-0000-example-evidence.yaml", schema: "evidence-manifest.schema.json", frontmatter: false },
    { file: "APPR-0000-example-approval.yaml", schema: "approval-record.schema.json", frontmatter: false },
    { file: "CONF-0000-example-conflict.yaml", schema: "conflict-record.schema.json", frontmatter: false },
    { file: "INC-0000-example-incident.yaml", schema: "incident-record.schema.json", frontmatter: false },
    { file: "CHKPT-0000-example-checkpoint.yaml", schema: "recovery-checkpoint.schema.json", frontmatter: false },
    { file: "CPACK-0000-example-context-pack.yaml", schema: "context-pack-manifest.schema.json", frontmatter: false },
  ];
  for (const ex of examples) {
    const raw = fs.readFileSync(path.join(HARNESS_DIR, "contracts", "examples", ex.file), "utf8");
    const parsed = ex.frontmatter ? extractFrontmatter(raw, ex.file) : parseYaml(raw, ex.file);
    assert.equal(parsed.is_example, true, `${ex.file} must set is_example: true`);
    assert.match(parsed.example_notice, /EXAMPLE ONLY/i);
    const res = validateAgainstSchema(parsed, schemas[ex.schema]);
    assert.equal(res.valid, true, `${ex.file} failed ${ex.schema}: ${res.errors.join("; ")}`);
  }
});

test("all relative markdown links in harness/**/*.md resolve and README covers all 10 topics", () => {
  const mdFiles = walkFiles(HARNESS_DIR, (p) => p.endsWith(".md"));
  assert.ok(mdFiles.length > 20);
  const linkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const mdFile of mdFiles) {
    const cleaned = stripFencedAndInlineCode(fs.readFileSync(mdFile, "utf8"));
    let match;
    while ((match = linkRegex.exec(cleaned)) !== null) {
      const target = match[1].trim().split(/\s+/)[0];
      if (!target || target.startsWith("#") || /^https?:\/\/|^mailto:/i.test(target)) {
        continue;
      }
      assert.equal(target.startsWith("file://"), false, `Non-portable file:// link in ${mdFile}: ${target}`);
      const noHash = target.split("#")[0];
      if (!noHash) continue;
      const resolved = path.resolve(path.dirname(mdFile), noHash);
      assert.equal(fs.existsSync(resolved), true, `Broken link in ${path.relative(HARNESS_DIR, mdFile)}: ${target}`);
    }
  }

  const readme = fs.readFileSync(path.join(HARNESS_DIR, "README.md"), "utf8");
  for (let i = 1; i <= 10; i += 1) {
    assert.match(readme, new RegExp(`^## ${i}\\.`, "m"), `README.md missing numbered section ${i}`);
  }

  for (const role of ["orchestrator.md", "researcher.md", "software-architect.md", "developer.md", "qa-security-reviewer.md"]) {
    const txt = fs.readFileSync(path.join(HARNESS_DIR, "roles", role), "utf8");
    for (const h of [
      "## Purpose",
      "## Responsibilities",
      "## Required Inputs",
      "## Expected Outputs",
      "## Allowed Future Operations",
      "## Forbidden Operations",
      "## Handoff Format",
      "## Acceptance Criteria",
    ]) {
      assert.equal(txt.includes(h), true, `${role} missing ${h}`);
    }
  }
});
