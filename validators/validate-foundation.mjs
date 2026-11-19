#!/usr/bin/env node
/**
 * Zero-dependency Phase 1 Foundation Validation Suite.
 * Verifies workspace structure, documentation/role specs, JSON schemas, YAML templates,
 * contract examples, internal markdown links, project bootstrapper safety, and Git hygiene.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseYaml, extractFrontmatter } from "../core/yaml-subset.mjs";
import { validateAgainstSchema } from "../core/json-schema-lite.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(HARNESS_DIR, "..");
const BOOTSTRAP_SCRIPT = path.join(HARNESS_DIR, "scripts", "bootstrap-project.mjs");

let passedCount = 0;
let failedCount = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passedCount += 1;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failedCount += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push({ label, msg });
    console.error(`[FAIL] ${label}\n       -> ${msg}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function loadJson(filePath) {
  return JSON.parse(readUtf8(filePath));
}

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
      // Remove inline code spans so illustrative examples like `[text](path)` are skipped.
      out.push(line.replace(/`[^`]*`/g, ""));
    }
  }
  return out.join("\n");
}

function checkMarkdownLinks(baseDir) {
  const mdFiles = walkFiles(baseDir, (p) => p.endsWith(".md"));
  const broken = [];
  const linkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;

  for (const mdFile of mdFiles) {
    const cleaned = stripFencedAndInlineCode(readUtf8(mdFile));
    let match;
    while ((match = linkRegex.exec(cleaned)) !== null) {
      const rawTarget = match[1].trim().split(/\s+/)[0];
      if (
        !rawTarget ||
        rawTarget.startsWith("#") ||
        rawTarget.startsWith("http://") ||
        rawTarget.startsWith("https://") ||
        rawTarget.startsWith("mailto:")
      ) {
        continue;
      }
      if (rawTarget.startsWith("file://")) {
        broken.push(`${path.relative(baseDir, mdFile)} -> absolute file:// link not portable (${rawTarget})`);
        continue;
      }
      const targetNoHash = rawTarget.split("#")[0];
      if (!targetNoHash) {
        continue;
      }
      const resolved = path.resolve(path.dirname(mdFile), targetNoHash);
      if (!fs.existsSync(resolved)) {
        broken.push(`${path.relative(baseDir, mdFile)} -> broken link "${rawTarget}"`);
      }
    }
  }
  return { count: mdFiles.length, broken };
}

function runBootstrap(args) {
  return spawnSync(process.execPath, [BOOTSTRAP_SCRIPT, ...args], {
    cwd: HARNESS_DIR,
    encoding: "utf8",
    windowsHide: true,
  });
}

function main() {
  console.log("=== Phase 1 AI Development Harness Foundation Validator ===\n");

  // ---------------------------------------------------------------------------
  // 1. Workspace & Harness Structure
  // ---------------------------------------------------------------------------
  console.log("--- 1. Workspace & Harness Structure ---");

  check("Top-level workspace directories exist without root .git", () => {
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
      assert(fs.existsSync(path.join(WORKSPACE_ROOT, rel)), `Missing directory: ${rel}`);
    }
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, ".git")), "Workspace root must NOT have a .git directory");
    assert(fs.existsSync(path.join(HARNESS_DIR, ".git")), "harness/.git must exist (harness is its own Git repo)");
  });

  check("Required harness directories and root files exist", () => {
    const requiredPaths = [
      "README.md",
      "VERSION",
      ".gitignore",
      "package.json",
      "policies",
      "roles",
      "skills/README.md",
      "contracts",
      "contracts/examples",
      "schemas",
      "context/context-compiler-spec.md",
      "core",
      "evaluations/README.md",
      "scripts/bootstrap-project.mjs",
      "templates/project-starter",
      "docs",
    ];
    for (const rel of requiredPaths) {
      assert(fs.existsSync(path.join(HARNESS_DIR, rel)), `Missing harness entry: ${rel}`);
    }
  });

  check("project-starter template contains all required files and .gitkeep placeholders", () => {
    const starterDir = path.join(HARNESS_DIR, "templates", "project-starter");
    const requiredStarterFiles = [
      "README.md",
      "AGENTS.md",
      "GEMINI.md",
      ".gitignore",
      "brain/INDEX.md",
      "brain/manifest.yaml",
      "brain/requirements/prd.md",
      "brain/requirements/constraints.md",
      "brain/architecture/overview.md",
      "brain/state/current.yaml",
      "brain/decisions/.gitkeep",
      "brain/research/.gitkeep",
      "brain/lessons/.gitkeep",
      "brain/conflicts/.gitkeep",
      "tasks/inbox/.gitkeep",
      "tasks/active/.gitkeep",
      "tasks/review/.gitkeep",
      "tasks/completed/.gitkeep",
      "tasks/blocked/.gitkeep",
      "proposals/.gitkeep",
      "evidence/.gitkeep",
      "docs/.gitkeep",
      "src/.gitkeep",
      "tests/.gitkeep",
    ];
    for (const rel of requiredStarterFiles) {
      assert(fs.existsSync(path.join(starterDir, rel)), `Missing project-starter file: ${rel}`);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Docs, Policies, Roles & Context Spec
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Docs, Policies, Roles & Context Spec ---");

  check("All Section 15 documentation and policy deliverables exist", () => {
    const requiredDocs = [
      "README.md",
      "docs/architecture.md",
      "docs/second-brain.md",
      "docs/new-projects.md",
      "docs/future-roadmap.md",
      "docs/known-limitations.md",
      "policies/token-efficiency.md",
      "policies/approval-boundaries.md",
      "policies/memory-policy.md",
    ];
    for (const rel of requiredDocs) {
      const full = path.join(HARNESS_DIR, rel);
      assert(fs.existsSync(full), `Missing deliverable: ${rel}`);
      assert(readUtf8(full).trim().length > 100, `Deliverable unexpectedly short: ${rel}`);
    }
  });

  check("All 5 role specifications define all 8 mandatory sections", () => {
    const roles = [
      "orchestrator.md",
      "researcher.md",
      "software-architect.md",
      "developer.md",
      "qa-security-reviewer.md",
    ];
    const requiredHeadings = [
      "## Purpose",
      "## Responsibilities",
      "## Required Inputs",
      "## Expected Outputs",
      "## Allowed Future Operations",
      "## Forbidden Operations",
      "## Handoff Format",
      "## Acceptance Criteria",
    ];
    for (const roleFile of roles) {
      const text = readUtf8(path.join(HARNESS_DIR, "roles", roleFile));
      for (const heading of requiredHeadings) {
        assert(text.includes(heading), `${roleFile} missing heading "${heading}"`);
      }
    }
  });

  check("Future-phase documents explicitly mark unbuilt features NOT IMPLEMENTED", () => {
    const mustMark = [
      "context/context-compiler-spec.md",
      "roles/README.md",
      "docs/future-roadmap.md",
      "docs/known-limitations.md",
      "skills/README.md",
      "evaluations/README.md",
    ];
    for (const rel of mustMark) {
      const text = readUtf8(path.join(HARNESS_DIR, rel));
      assert(/not implemented/i.test(text), `${rel} must explicitly mark unbuilt features NOT IMPLEMENTED`);
    }
    const agentsMd = readUtf8(path.join(HARNESS_DIR, "templates", "project-starter", "AGENTS.md"));
    const geminiMd = readUtf8(path.join(HARNESS_DIR, "templates", "project-starter", "GEMINI.md"));
    assert(/not.*automatically configure/i.test(agentsMd), "AGENTS.md must disclaim auto-configuration");
    assert(/not.*automatically configure/i.test(geminiMd), "GEMINI.md must disclaim auto-configuration");
  });

  // ---------------------------------------------------------------------------
  // 3. JSON Schemas
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. JSON Schemas ---");

  const schemaNames = [
    "project-manifest.schema.json",
    "adr.schema.json",
    "task-contract.schema.json",
    "agent-handoff.schema.json",
    "research-record.schema.json",
    "evidence-manifest.schema.json",
    "project-state.schema.json",
    "approval-record.schema.json",
    "conflict-record.schema.json",
    "recovery-checkpoint.schema.json",
    "context-pack-manifest.schema.json",
  ];
  const loadedSchemas = {};

  check("All 11 JSON schemas parse cleanly and enforce strict object metadata", () => {
    for (const name of schemaNames) {
      const schema = loadJson(path.join(HARNESS_DIR, "schemas", name));
      assert(schema.$schema === "https://json-schema.org/draft/2020-12/schema", `${name}: invalid $schema`);
      assert(typeof schema.$id === "string" && schema.$id.length > 0, `${name}: missing $id`);
      assert(typeof schema.title === "string" && schema.title.length > 0, `${name}: missing title`);
      assert(schema.type === "object", `${name}: root type must be "object"`);
      assert(schema.additionalProperties === false, `${name}: additionalProperties must be false`);
      assert(Array.isArray(schema.required) && schema.required.length > 0, `${name}: required array missing`);
      assert(typeof schema.properties === "object" && schema.properties !== null, `${name}: properties missing`);
      loadedSchemas[name] = schema;
    }
  });

  // ---------------------------------------------------------------------------
  // 4. YAML Templates, Examples & Negative Self-Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. YAML Templates, Examples & Negative Self-Tests ---");

  check("Contract templates and starter YAML files parse cleanly", () => {
    const yamlTemplates = [
      "contracts/task-contract-template.yaml",
      "contracts/agent-handoff-template.yaml",
      "contracts/evidence-manifest-template.yaml",
      "contracts/approval-record-template.yaml",
      "contracts/conflict-record-template.yaml",
      "contracts/recovery-checkpoint-template.yaml",
      "contracts/context-pack-manifest-template.yaml",
      "templates/project-starter/brain/manifest.yaml",
      "templates/project-starter/brain/state/current.yaml",
    ];
    for (const rel of yamlTemplates) {
      const data = parseYaml(readUtf8(path.join(HARNESS_DIR, rel)), rel);
      assert(data && typeof data === "object" && !Array.isArray(data), `${rel} did not parse as an object`);
    }
    const fmTemplates = ["contracts/adr-template.md", "contracts/research-record-template.md"];
    for (const rel of fmTemplates) {
      const fm = extractFrontmatter(readUtf8(path.join(HARNESS_DIR, rel)), rel);
      assert(fm && typeof fm === "object" && !Array.isArray(fm), `${rel} frontmatter invalid`);
    }
  });

  check("All 9 contract examples validate strictly against their schemas and carry is_example: true", () => {
    const examplePairs = [
      { file: "ADR-0000-example-decision.md", schema: "adr.schema.json", frontmatter: true },
      { file: "TASK-0000-example-task.yaml", schema: "task-contract.schema.json", frontmatter: false },
      { file: "HANDOFF-0000-example-handoff.yaml", schema: "agent-handoff.schema.json", frontmatter: false },
      { file: "RES-0000-example-research.md", schema: "research-record.schema.json", frontmatter: true },
      { file: "EVID-0000-example-evidence.yaml", schema: "evidence-manifest.schema.json", frontmatter: false },
      { file: "APPR-0000-example-approval.yaml", schema: "approval-record.schema.json", frontmatter: false },
      { file: "CONF-0000-example-conflict.yaml", schema: "conflict-record.schema.json", frontmatter: false },
      { file: "CHKPT-0000-example-checkpoint.yaml", schema: "recovery-checkpoint.schema.json", frontmatter: false },
      { file: "CPACK-0000-example-context-pack.yaml", schema: "context-pack-manifest.schema.json", frontmatter: false },
    ];
    for (const pair of examplePairs) {
      const fullPath = path.join(HARNESS_DIR, "contracts", "examples", pair.file);
      const raw = readUtf8(fullPath);
      const parsed = pair.frontmatter ? extractFrontmatter(raw, pair.file) : parseYaml(raw, pair.file);
      assert(parsed.is_example === true, `${pair.file} must set is_example: true`);
      assert(
        typeof parsed.example_notice === "string" && /EXAMPLE ONLY/i.test(parsed.example_notice),
        `${pair.file} must carry an explicit EXAMPLE ONLY example_notice`
      );
      const res = validateAgainstSchema(parsed, loadedSchemas[pair.schema]);
      assert(res.valid, `${pair.file} failed ${pair.schema}: ${res.errors.join("; ")}`);
    }
  });

  check("Negative parser & schema self-tests reject malformed inputs", () => {
    let threwTab = false;
    try {
      parseYaml("root:\n\tchild: 1\n", "tab-test");
    } catch {
      threwTab = true;
    }
    assert(threwTab, "YAML parser failed to reject tab indentation");

    let threwDup = false;
    try {
      parseYaml("a: 1\na: 2\n", "dup-test");
    } catch {
      threwDup = true;
    }
    assert(threwDup, "YAML parser failed to reject duplicate keys");

    let threwUnquoted = false;
    try {
      parseYaml("id: {{TASK_ID}}\n", "unquoted-placeholder-test");
    } catch {
      threwUnquoted = true;
    }
    assert(threwUnquoted, "YAML parser failed to reject unquoted {{...}}");

    const badTask = {
      schema_version: "1.0",
      id: "BAD-ID",
      status: "invalid_status",
      unexpected_field: true,
    };
    const res = validateAgainstSchema(badTask, loadedSchemas["task-contract.schema.json"]);
    assert(!res.valid && res.errors.length >= 3, "Schema validator failed to reject invalid task contract");
  });

  // ---------------------------------------------------------------------------
  // 5. Internal Markdown Links
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Internal Markdown Links ---");

  check("All relative markdown links in harness/**/*.md resolve cleanly", () => {
    const { count, broken } = checkMarkdownLinks(HARNESS_DIR);
    assert(count > 0, "Expected markdown files inside harness/");
    assert(broken.length === 0, `Broken links found:\n  - ${broken.join("\n  - ")}`);
  });

  // ---------------------------------------------------------------------------
  // 6. Bootstrap Script Safe Local End-to-End Tests (Temp Dir Only)
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Bootstrap Script End-to-End Tests ---");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-validate-"));
  try {
    check("bootstrap --dry-run exits 0 and writes zero files", () => {
      const dryDest = path.join(tempRoot, "dry-run-project");
      const res = runBootstrap([
        "--name",
        "Dry Run Sample",
        "--owner",
        "Test Owner",
        "--dest",
        dryDest,
        "--dry-run",
      ]);
      assert(res.status === 0, `Dry run exited ${res.status}: ${res.stderr}`);
      assert(!fs.existsSync(dryDest), "Dry run unexpectedly created destination directory");
    });

    const alphaDest = path.join(tempRoot, "alpha-app");
    check("bootstrap creates valid Second Brain without --git and substitutes all placeholders", () => {
      const res = runBootstrap([
        "--name",
        "Alpha Test App",
        "--owner",
        'Owner "Quote" Test',
        "--description",
        "Local validation test project",
        "--dest",
        alphaDest,
      ]);
      assert(res.status === 0, `Bootstrap failed (${res.status}): ${res.stderr}\n${res.stdout}`);
      assert(!fs.existsSync(path.join(alphaDest, ".git")), "Unexpected .git created without --git flag");

      const generatedFiles = walkFiles(alphaDest);
      assert(generatedFiles.length >= 24, `Expected >= 24 generated files, found ${generatedFiles.length}`);
      for (const f of generatedFiles) {
        const text = readUtf8(f);
        assert(!/\{\{[A-Z0-9_]+\}\}/.test(text), `Leftover placeholder in ${path.relative(alphaDest, f)}`);
      }

      const manifest = parseYaml(readUtf8(path.join(alphaDest, "brain", "manifest.yaml")), "alpha/manifest.yaml");
      assert(manifest.status === "initialized", `Expected manifest.status "initialized", got "${manifest.status}"`);
      assert(manifest.repository.initialized === false, "Expected repository.initialized === false without --git");
      const mRes = validateAgainstSchema(manifest, loadedSchemas["project-manifest.schema.json"]);
      assert(mRes.valid, `Generated manifest failed schema: ${mRes.errors.join("; ")}`);

      const state = parseYaml(readUtf8(path.join(alphaDest, "brain", "state", "current.yaml")), "alpha/current.yaml");
      const sRes = validateAgainstSchema(state, loadedSchemas["project-state.schema.json"]);
      assert(sRes.valid, `Generated state failed schema: ${sRes.errors.join("; ")}`);

      const linkCheck = checkMarkdownLinks(alphaDest);
      assert(linkCheck.broken.length === 0, `Broken links in generated project: ${linkCheck.broken.join("; ")}`);
    });

    check("bootstrap refuses accidental overwrite and preserves existing files", () => {
      const readmePath = path.join(alphaDest, "README.md");
      const sentinel = "# SENTINEL — MUST NOT BE OVERWRITTEN\n";
      fs.writeFileSync(readmePath, sentinel, "utf8");

      const rerun = runBootstrap(["--name", "Alpha Test App", "--dest", alphaDest]);
      assert(rerun.status !== 0, "Expected non-zero exit when destination already exists");
      assert(readUtf8(readmePath) === sentinel, "Existing file was modified during overwrite refusal test!");
    });

    check("bootstrap rejects unsafe project names and protected destinations", () => {
      const badNameCases = [
        ["--name", "../escape", "--dest", path.join(tempRoot, "bad-1")],
        ["--name", "CON", "--dest", path.join(tempRoot, "bad-2")],
        ["--name", "ab", "--dest", path.join(tempRoot, "bad-3")],
        ["--name", "bad/name", "--dest", path.join(tempRoot, "bad-4")],
        ["--name", "bad:name", "--dest", path.join(tempRoot, "bad-5")],
      ];
      for (const args of badNameCases) {
        const res = runBootstrap(args);
        assert(res.status !== 0, `Expected failure for unsafe args: ${args.join(" ")}`);
      }

      const illegalHarnessDest = path.join(HARNESS_DIR, "illegal-nested-project");
      const badDest1 = runBootstrap(["--name", "Illegal Harness Child", "--dest", illegalHarnessDest]);
      assert(badDest1.status !== 0, "Expected failure when targeting inside harness/");
      assert(!fs.existsSync(illegalHarnessDest), "Created directory inside harness/ despite rejection");

      const illegalRuntimeDest = path.join(WORKSPACE_ROOT, "local-runtime", "illegal-project");
      const badDest2 = runBootstrap(["--name", "Illegal Runtime Child", "--dest", illegalRuntimeDest]);
      assert(badDest2.status !== 0, "Expected failure when targeting inside local-runtime/");
      assert(!fs.existsSync(illegalRuntimeDest), "Created directory inside local-runtime/ despite rejection");
    });

    check("bootstrap --git initializes isolated Git repository and marks manifest initialized: true", () => {
      const betaDest = path.join(tempRoot, "beta-git-app");
      const res = runBootstrap(["--name", "Beta Git App", "--dest", betaDest, "--git"]);
      assert(res.status === 0, `Bootstrap --git failed (${res.status}): ${res.stderr}`);
      assert(fs.existsSync(path.join(betaDest, ".git")), "Expected .git directory in --git project");

      const manifest = parseYaml(readUtf8(path.join(betaDest, "brain", "manifest.yaml")), "beta/manifest.yaml");
      assert(manifest.repository.initialized === true, "Expected repository.initialized === true with --git");
      const mRes = validateAgainstSchema(manifest, loadedSchemas["project-manifest.schema.json"]);
      assert(mRes.valid, `Generated --git manifest failed schema: ${mRes.errors.join("; ")}`);

      const gitOut = execFileSync("git", ["-C", betaDest, "status", "--short"], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert(typeof gitOut === "string", "git status failed inside bootstrapped project");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
  }

  // ---------------------------------------------------------------------------
  // 7. Git Hygiene & Secret Scan
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. Git Hygiene & Secret Scan ---");

  check("harness Git status succeeds, no secrets or .env tracked, and local-runtime excluded", () => {
    const statusOut = execFileSync("git", ["-C", HARNESS_DIR, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert(typeof statusOut === "string", "git status returned non-string");

    const trackedRaw = execFileSync("git", ["-C", HARNESS_DIR, "ls-files"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const untrackedIncludedRaw = execFileSync(
      "git",
      ["-C", HARNESS_DIR, "ls-files", "--others", "--exclude-standard"],
      { encoding: "utf8", windowsHide: true }
    );
    const candidateFiles = [
      ...trackedRaw.split(/\r?\n/),
      ...untrackedIncludedRaw.split(/\r?\n/),
    ]
      .map((s) => s.trim())
      .filter(Boolean);

    assert(candidateFiles.length > 0, "Expected tracked or unignored files in harness Git repo");

    const forbiddenFilePattern = /(^|\/)(\.env(\..*)?|.+\.(pem|key|p12|pfx))$/i;
    const secretContentPatterns = [
      /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bghp_[A-Za-z0-9]{36}\b/,
      /\bAIza[0-9A-Za-z_-]{35}\b/,
      /\bsk-[A-Za-z0-9]{20,}\b/,
    ];

    for (const rel of candidateFiles) {
      assert(!forbiddenFilePattern.test(rel.replace(/\\/g, "/")), `Forbidden secret/env file in Git scope: ${rel}`);
      assert(!rel.startsWith("local-runtime"), `local-runtime file must not be in harness Git scope: ${rel}`);
      const full = path.join(HARNESS_DIR, rel);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        const content = readUtf8(full);
        for (const pat of secretContentPatterns) {
          assert(!pat.test(content), `Potential secret pattern ${pat} matched in ${rel}`);
        }
      }
    }

    const gitignore = readUtf8(path.join(HARNESS_DIR, ".gitignore"));
    assert(gitignore.includes("local-runtime/"), ".gitignore must exclude local-runtime/");
    assert(gitignore.includes(".env"), ".gitignore must exclude .env");
  });

  // ---------------------------------------------------------------------------
  // Final Summary
  // ---------------------------------------------------------------------------
  console.log("\n=== Validation Summary ===");
  console.log(`PASSED : ${passedCount}`);
  console.log(`FAILED : ${failedCount}`);
  console.log("NOT TESTED / NOT IMPLEMENTED IN PHASE 1:");
  console.log("  - Deterministic Context Compiler execution (Documented only / Not implemented)");
  console.log("  - Restricted Integration Controller & auto-promotion (Not implemented)");
  console.log("  - Codex CLI, Gemini CLI & multi-agent subagent execution (Not implemented)");
  console.log("  - OS-level write ownership / token budget runtime enforcement (Documented only / Blocked until Phase 2+)");
  console.log("  - Automated recovery checkpoints & Git worktree automation (Not implemented)");

  if (failedCount > 0) {
    console.error("\nValidation FAILED.");
    process.exit(1);
  }
  console.log("\nAll Phase 1 foundation validation checks PASSED.");
}

main();
