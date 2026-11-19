#!/usr/bin/env node
/**
 * Unified non-interactive CLI entrypoint for GeloForge.
 * Commands: init, validate, context, handoff, status.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "./bootstrap-project.mjs";
import { adoptProject } from "../core/adopt-project.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { getProjectStatus } from "../core/project-status.mjs";
import { createHandoff, inspectHandoff } from "../core/handoff.mjs";
import { createTask, listTasks, getTask } from "../core/task-manager.mjs";
import { captureEvidence } from "../core/evidence-capture.mjs";
import {
  discoverSkills,
  resolveProjectForSkills,
} from "../core/skills.mjs";
import { STATIC_LINT_DISCLAIMER, lintDiscoveredSkills, lintSkill } from "../core/skills-lint.mjs";
import { atomicWriteFile, redactSecretContent, validateOutputFilePath } from "../core/path-safety.mjs";
import { resolveProjectDir } from "../core/project-locator.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_DIR = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(HARNESS_DIR, "..");

function getVersion() {
  return fs.readFileSync(path.join(HARNESS_DIR, "VERSION"), "utf8").trim();
}

function printMainHelp() {
  console.log(`GeloForge CLI v${getVersion()}

Usage:
  geloforge <command> [options]

Commands:
  init       Initialize a new project Second Brain (supports profiles & --dry-run)
  adopt      Add GeloForge Second Brain to an existing project without overwriting files
  task       Create, list, or inspect scoped task contracts (TASK-NNNN)
  evidence   Run an explicit command (shell: false) and record EVID-NNNN manifest
  validate   Validate a project's schemas, compatibility, IDs, references, and links
  context    Compile a deterministic, trust-tiered context packet for a task or query
  skills     Discover, inspect, validate, and security-lint portable SKILL.md packages
  handoff    Create or inspect a cross-agent file-based handoff record (HANDOFF-NNNN)
  status     Inspect project health, operational task state, and Git status

Global Options:
  -h, --help     Show help (use "geloforge <command> --help" for command options)
  -v, --version  Show GeloForge version
`);
}

function printSubHelp(cmd) {
  switch (cmd) {
    case "init":
      console.log(`Usage: geloforge init --name "<Project Name>" [options]

Options:
  --name <string>         Project display name (required, 3-80 chars)
  --slug <string>         Lowercase ASCII slug (optional)
  --dest <path>           Target directory (default: <workspace-root>/projects/<slug>)
  --owner <string>        Project owner name
  --description <string>  Short project description
  --profile <name>        Optional overlay: web, desktop, mobile, automation, ai-system
  --created-at <iso>      ISO-8601 timestamp for deterministic output
  --git                   Initialize local Git repo (git init -b main)
  --dry-run               Preview planned files without writing
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "adopt":
      console.log(`Usage: geloforge adopt [--dest <path>] [options]

Options:
  -d, --dest <path>       Existing project directory (default: current working directory)
  -p, --project <path>    Alias for --dest
  --name <string>         Display name (default: inferred from manifest or directory name)
  --slug <string>         Lowercase ASCII slug (optional)
  --owner <string>        Project owner name (default: "Project Owner")
  --description <string>  Short project description
  --profile <name>        Optional overlay: web, desktop, mobile, automation, ai-system
  --tasks-dir <relpath>   Relative task contracts folder (default: "tasks")
  --evidence-dir <rel>    Relative evidence manifests folder (default: "evidence")
  --with-agent-guides     Also create AGENTS.md & GEMINI.md (refuses overwrite if present)
  --created-at <iso>      ISO-8601 timestamp for deterministic output
  --dry-run               Preview planned files without modifying disk
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "validate":
      console.log(`Usage: geloforge validate [--project <path>] [--json]

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "context":
      console.log(`Usage: geloforge context [--project <path>] (--task TASK-NNNN | --query <text>) [options]

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  -t, --task <id>         Task contract ID (e.g. TASK-0001)
  -q, --query <text>      Task description or search query
  --profile <name>        Budget profile: quick (~4000), working (~8000), deep (~16000)
  --budget <int>          Override estimated-token budget target (>= 100)
  --map                   Include selective deterministic codebase symbol outline map
  --map-budget <int>      Override codebase map token budget (>= 100)
  --exclude-unverified    Omit A5-A6, draft, and unverified records completely
  --format <type>         Output format: markdown (default) or json
  -o, --out <file>        Write output atomically to a safe file path
  --compiled-at <iso>     ISO-8601 timestamp for deterministic manifest
  --json                  Alias for --format json
  -h, --help              Show help
`);
      break;
    case "status":
      console.log(`Usage: geloforge status [--project <path>] [--json]

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "handoff":
      console.log(`Usage: geloforge handoff [--project <path>] [options]

Create Options:
  -p, --project <path>         Target project directory (auto-detected from CWD if omitted)
  -t, --task <id>              Target task ID (defaults to first active task if any)
  --id <HANDOFF-NNNN>          Explicit handoff ID (auto-assigned if omitted)
  --from-role <role>           Source agent role (default: developer)
  --to-role <role>             Receiving agent role (default: qa-security-reviewer)
  --from-tool <name>           Source AI tool label (e.g. "codex", "antigravity")
  --to-tool <name>             Target AI tool label (e.g. "gemini-cli", "claude-code")
  --summary <text>             Concise transfer summary
  --next-action <text>         Recommended next action
  --completed <text>           Completed item (repeatable)
  --open <text>                Remaining open item (repeatable)
  --claim <text>               Unverified agent claim (repeatable)
  --blocker <text>             Blocker description (repeatable)
  --question <text>            Open question (repeatable)
  --risk <text>                Unresolved risk (repeatable)
  --evidence <EVID-NNNN>       Evidence ID reference (repeatable)
  --context-pack-ref <id>      Associated CPACK-NNNN ID
  --created-at <iso>           ISO-8601 timestamp override
  --dry-run                    Validate and preview without writing file
  -o, --out <file>             Custom safe output YAML path (default: handoffs/HANDOFF-NNNN-*.yaml)
  --format <type>              Stdout format: markdown (default), yaml, or json
  --json                       Alias for --format json

Inspect Options:
  --inspect <file>             Validate and render an existing handoff YAML file
  -h, --help                   Show help
`);
      break;
    case "task":
      console.log(`Usage: geloforge task <new|list|show> [options]

Subcommands:
  new    Create a new schema-valid TASK-NNNN contract
  list   List tasks under configured tasks_dir
  show   Show details for a specific TASK-NNNN contract

Common Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --json                  Emit structured JSON output
  -h, --help              Show help

'task new' Options:
  --title <string>        Task title (required, >= 3 chars)
  --objective <string>    Detailed task objective (defaults to title)
  --id <TASK-NNNN>        Explicit task ID (auto-assigned if omitted)
  --priority <level>      low, medium (default), high, or critical
  --role <role>           orchestrator, researcher, software-architect, developer (default), qa-security-reviewer
  --budget <profile>      quick, working (default), or deep
  --status <status>       inbox, ready (default), active (default with --activate), blocked, in_review
  --activate              Add task to active_tasks in operational state
  --criteria <text>       Acceptance criterion (repeatable)
  --scope-in <text>       In-scope item (repeatable)
  --scope-out <text>      Out-of-scope item (repeatable)
  --input <relpath>       Required project input file path (repeatable)
  --dep <TASK-NNNN>       Dependency task ID (repeatable)
  --created-by <name>     Author label (default: manifest owner)
  --created-at <iso>      ISO-8601 timestamp override
  --dry-run               Preview generated task without writing disk

'task list' / 'task show' Options:
  --status <status>       Filter tasks in 'list'
  -t, --task <TASK-NNNN>  Target task ID for 'show' (or pass as positional arg)
`);
      break;
    case "evidence":
      console.log(`Usage: geloforge evidence capture --task TASK-NNNN [options] -- <command> [args...]

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  -t, --task <TASK-NNNN>  Target task contract ID (required)
  --name <string>         Short check name (defaults to command executable)
  --title <string>        Manifest title override
  --id <EVID-NNNN>        Explicit evidence ID (auto-assigned if omitted)
  --role <role>           Producer role (default: developer)
  --verified-by <label>   Verifier label used ONLY when exit code === 0
  --timeout <ms>          Command timeout in ms (50-600000, default: 60000)
  --no-link               Do not attach EVID-NNNN to TASK-NNNN or project state
  --created-at <iso>      ISO-8601 timestamp override
  --dry-run               Preview manifest without executing command or writing files
  --json                  Emit structured JSON output
  -h, --help              Show help

Safety & Accuracy Notes:
  - Executes ONLY the explicit command after "--" with shell: false (no shell interpolation).
  - Secret tokens/keys are redacted before persisting output or printing diagnostics.
  - Exits 0 only when command exit code === 0 (writes draft EVID-NNNN and exits 1 on failures/timeouts).
`);
      break;
    case "skills":
      console.log(`Usage: geloforge skills <list|show|validate|lint> [options]

Subcommands:
  list       List discovered portable skills across project (.agents/skills) and global dirs
  show       Inspect one skill's metadata, supporting resources, and instructions
  validate   Validate SKILL.md frontmatter, path/symlink/secret safety, and local links
  lint       Run static security and quality lint checks across discovered skills

Common Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --global-dir <path>     Override global skills directory (default: GELOFORGE_SKILLS_DIR or ~/.geloforge/skills)
  --include-drafts        Include quarantined drafts under proposals/skills/ (never auto-trusted)
  --json                  Emit structured JSON output
  -h, --help              Show help

'skills show' Options:
  --name <skill-name>     Target skill name (or pass as positional arg: geloforge skills show <name>)

'skills lint' Options:
  --strict                Fail (exit 1) on high/warning findings in addition to critical/error findings
`);
      break;
  }
}

function handleInit(args) {
  const parsed = parseArgs({
    args,
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      dest: { type: "string" },
      owner: { type: "string" },
      description: { type: "string" },
      profile: { type: "string" },
      "created-at": { type: "string" },
      git: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    printSubHelp("init");
    return 0;
  }
  const res = bootstrapProject({
    name: parsed.values.name,
    slug: parsed.values.slug,
    dest: parsed.values.dest,
    owner: parsed.values.owner,
    description: parsed.values.description,
    profile: parsed.values.profile,
    createdAt: parsed.values["created-at"],
    git: parsed.values.git,
    dryRun: parsed.values["dry-run"],
  });
  if (parsed.values.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(res.dryRun ? "DRY RUN — No files created." : "Project Second Brain initialized successfully.");
  console.log(`Project ID  : ${res.projectId}`);
  console.log(`Profile     : ${res.profile ? `${res.profile} (${res.profileVersion})` : "none"}`);
  console.log(`Destination : ${res.destDir}`);
  console.log(`Files       : ${res.files.length}`);
  return 0;
}

function handleAdopt(args) {
  const parsed = parseArgs({
    args,
    options: {
      dest: { type: "string", short: "d" },
      project: { type: "string", short: "p" },
      name: { type: "string" },
      slug: { type: "string" },
      owner: { type: "string" },
      description: { type: "string" },
      profile: { type: "string" },
      "tasks-dir": { type: "string" },
      "evidence-dir": { type: "string" },
      "with-agent-guides": { type: "boolean", default: false },
      "created-at": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    printSubHelp("adopt");
    return 0;
  }
  const dest = parsed.values.dest || parsed.values.project || process.cwd();
  const res = adoptProject({
    dest,
    name: parsed.values.name,
    slug: parsed.values.slug,
    owner: parsed.values.owner,
    description: parsed.values.description,
    profile: parsed.values.profile,
    tasksDir: parsed.values["tasks-dir"],
    evidenceDir: parsed.values["evidence-dir"],
    withAgentGuides: parsed.values["with-agent-guides"],
    createdAt: parsed.values["created-at"],
    dryRun: parsed.values["dry-run"],
    harnessDir: HARNESS_DIR,
    workspaceRoot: WORKSPACE_ROOT,
  });
  if (parsed.values.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(res.dryRun ? "DRY RUN — No files written." : "Existing project adopted into GeloForge.");
  console.log(`Project     : ${res.projectName} (${res.projectId})`);
  console.log(`Directory   : ${res.destDir}`);
  console.log(`Git Repo    : ${res.gitDetected ? `yes (branch=${res.defaultBranch})` : "no"}`);
  console.log(`Added Files : ${res.files.length}`);
  for (const w of res.warnings) console.log(`  - [WARN] ${w}`);
  return 0;
}

function handleValidate(args) {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (parsed.values.help) {
    printSubHelp("validate");
    return 0;
  }
  const explicitTarget = parsed.values.project || parsed.positionals[0] || null;
  const { projectDir } = resolveProjectDir({ project: explicitTarget, harnessDir: HARNESS_DIR });
  const result = validateProject(projectDir);
  if (parsed.values.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  console.log(`Project Validation: ${result.valid ? "PASS" : "FAIL"}`);
  console.log(`Compatibility     : ${result.compatibilityStatus}`);
  console.log(`Records Checked   : ${result.recordCount}`);
  console.log(`Markdown Checked  : ${result.checkedMarkdownFiles}`);
  for (const w of result.warnings) console.log(`  - [WARN] ${w}`);
  for (const e of result.errors) console.error(`  - [ERR] ${e}`);
  return result.valid ? 0 : 1;
}

function handleContext(args) {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      task: { type: "string", short: "t" },
      query: { type: "string", short: "q" },
      profile: { type: "string" },
      budget: { type: "string" },
      map: { type: "boolean", default: false },
      "map-budget": { type: "string" },
      "exclude-unverified": { type: "boolean", default: false },
      format: { type: "string", default: "markdown" },
      out: { type: "string", short: "o" },
      "compiled-at": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    printSubHelp("context");
    return 0;
  }
  const format = parsed.values.json ? "json" : parsed.values.format;
  if (format !== "markdown" && format !== "json") {
    throw new Error(`Invalid --format "${format}". Expected "markdown" or "json".`);
  }

  let budgetNum;
  if (parsed.values.budget !== undefined) {
    if (!/^\d+$/.test(parsed.values.budget.trim())) {
      throw new Error(`Invalid --budget "${parsed.values.budget}". Must be a positive integer.`);
    }
    budgetNum = Number.parseInt(parsed.values.budget.trim(), 10);
  }

  let mapBudgetNum;
  if (parsed.values["map-budget"] !== undefined) {
    if (!parsed.values.map) {
      throw new Error("--map-budget requires --map.");
    }
    if (!/^\d+$/.test(parsed.values["map-budget"].trim())) {
      throw new Error(`Invalid --map-budget "${parsed.values["map-budget"]}". Must be a positive integer.`);
    }
    mapBudgetNum = Number.parseInt(parsed.values["map-budget"].trim(), 10);
  }

  let resolvedOut = null;
  if (parsed.values.out !== undefined) {
    resolvedOut = validateOutputFilePath(parsed.values.out, {
      harnessDir: HARNESS_DIR,
      workspaceRoot: WORKSPACE_ROOT,
    });
  }

  const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
  const result = compileContext({
    projectDir,
    taskId: parsed.values.task,
    query: parsed.values.query,
    profile: parsed.values.profile || "working",
    budget: budgetNum,
    includeMap: parsed.values.map,
    mapBudget: mapBudgetNum,
    excludeUnverified: parsed.values["exclude-unverified"],
    compiledAt: parsed.values["compiled-at"],
    harnessDir: HARNESS_DIR,
  });

  const payload = format === "json" ? `${JSON.stringify(result, null, 2)}\n` : result.markdown;

  if (resolvedOut) {
    atomicWriteFile(resolvedOut, payload);
    if (parsed.values.json) {
      console.log(
        JSON.stringify(
          {
            writtenTo: resolvedOut,
            format,
            manifest: result.manifest,
            warnings: result.warnings,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Context packet written to: ${resolvedOut}`);
      console.log(
        `Profile: ${result.manifest.profile} (effective: ${result.manifest.effective_profile}) | ~${result.estimatedTokens} est. tokens (${result.tokenEstimateMethod}) | Budget Overrun: ${result.budgetOverrun}`
      );
      for (const w of result.warnings) console.log(`  - [WARN] ${w}`);
    }
    return 0;
  }

  process.stdout.write(payload);
  return 0;
}

function handleStatus(args) {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (parsed.values.help) {
    printSubHelp("status");
    return 0;
  }
  const explicitTarget = parsed.values.project || parsed.positionals[0] || null;
  const { projectDir } = resolveProjectDir({ project: explicitTarget, harnessDir: HARNESS_DIR });
  const status = getProjectStatus(projectDir);
  if (parsed.values.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`Project Status : ${status.valid ? "VALID" : "INVALID"} (${status.compatibilityStatus})`);
  if (status.project) {
    console.log(
      `Project        : ${status.project.name} (${status.project.id}) | profile=${status.project.profile || "none"} | schema=${status.project.schemaVersion}`
    );
  }
  if (status.operationalState) {
    const s = status.operationalState;
    console.log(
      `Operational    : phase=${s.currentPhase} | active=${s.activeTasks.length} | blocked=${s.blockedTasks.length} | approvals=${s.pendingApprovals.length} | conflicts=${s.openConflicts.length}`
    );
  }
  console.log(
    `Git            : ${
      status.vcs.available
        ? `branch=${status.vcs.branch || "detached"} | head=${status.vcs.head} | dirty=${status.vcs.dirtyCount}`
        : "not a Git repository"
    }`
  );
  console.log(`Counts         : records=${status.counts.records} | markdown=${status.counts.markdownFiles} | errors=${status.counts.errors} | warnings=${status.counts.warnings}`);
  if (Array.isArray(status.nextSteps) && status.nextSteps.length > 0) {
    console.log(`Next Step      : ${status.nextSteps[0]}`);
  }
  for (const w of status.warnings) console.log(`  - [WARN] ${w}`);
  for (const e of status.errors) console.error(`  - [ERR] ${e}`);
  return 0;
}

function handleHandoff(args) {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      inspect: { type: "string" },
      task: { type: "string", short: "t" },
      id: { type: "string" },
      "from-role": { type: "string" },
      "to-role": { type: "string" },
      "from-tool": { type: "string" },
      "to-tool": { type: "string" },
      status: { type: "string" },
      summary: { type: "string" },
      "next-action": { type: "string" },
      completed: { type: "string", multiple: true },
      open: { type: "string", multiple: true },
      claim: { type: "string", multiple: true },
      blocker: { type: "string", multiple: true },
      question: { type: "string", multiple: true },
      risk: { type: "string", multiple: true },
      evidence: { type: "string", multiple: true },
      "context-pack-ref": { type: "string" },
      "created-at": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      format: { type: "string", default: "markdown" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) {
    printSubHelp("handoff");
    return 0;
  }

  const format = parsed.values.json ? "json" : parsed.values.format;
  if (format !== "markdown" && format !== "yaml" && format !== "json") {
    throw new Error(`Invalid --format "${format}". Expected "markdown", "yaml", or "json".`);
  }

  const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });

  if (parsed.values.inspect) {
    const res = inspectHandoff({
      projectDir,
      handoffPath: parsed.values.inspect,
      harnessDir: HARNESS_DIR,
    });
    if (format === "json") {
      console.log(JSON.stringify(res, null, 2));
      return res.valid ? 0 : 1;
    }
    if (format === "yaml") {
      console.log(fs.readFileSync(res.filePath, "utf8"));
      return res.valid ? 0 : 1;
    }
    console.log(`Handoff Inspection : ${res.valid ? "PASS" : "FAIL"} (${res.compatibilityStatus})`);
    console.log(`File / ID / Schema : ${res.relPath} | ${res.id} | ${res.schemaVersion}`);
    for (const w of res.warnings) console.log(`  - [WARN] ${w}`);
    for (const e of res.errors) console.error(`  - [ERR] ${e}`);
    if (res.markdown) {
      console.log("");
      process.stdout.write(res.markdown);
    }
    return res.valid ? 0 : 1;
  }

  const res = createHandoff({
    projectDir,
    taskId: parsed.values.task,
    id: parsed.values.id,
    fromRole: parsed.values["from-role"],
    toRole: parsed.values["to-role"],
    fromTool: parsed.values["from-tool"],
    toTool: parsed.values["to-tool"],
    status: parsed.values.status,
    summary: parsed.values.summary,
    nextAction: parsed.values["next-action"],
    completedItems: parsed.values.completed,
    openItems: parsed.values.open,
    unverifiedClaims: parsed.values.claim,
    blockers: parsed.values.blocker,
    openQuestions: parsed.values.question,
    unresolvedRisks: parsed.values.risk,
    evidenceRefs: parsed.values.evidence,
    contextPackRef: parsed.values["context-pack-ref"],
    createdAt: parsed.values["created-at"],
    dryRun: parsed.values["dry-run"],
    out: parsed.values.out,
    harnessDir: HARNESS_DIR,
    workspaceRoot: WORKSPACE_ROOT,
  });

  if (format === "json") {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  if (format === "yaml") {
    process.stdout.write(res.yaml);
    return 0;
  }
  console.log(res.dryRun ? `DRY RUN — Handoff ${res.id} not written.` : `Handoff created: ${res.filePath}`);
  for (const w of res.warnings) console.log(`  - [WARN] ${w}`);
  console.log("");
  process.stdout.write(res.markdown);
  return 0;
}

function handleTask(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printSubHelp("task");
    return 0;
  }
  const [subcmd, ...rest] = args;
  if (subcmd === "new") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        title: { type: "string" },
        objective: { type: "string" },
        id: { type: "string" },
        priority: { type: "string" },
        role: { type: "string" },
        budget: { type: "string" },
        status: { type: "string" },
        activate: { type: "boolean", default: false },
        criteria: { type: "string", multiple: true },
        "scope-in": { type: "string", multiple: true },
        "scope-out": { type: "string", multiple: true },
        output: { type: "string", multiple: true },
        input: { type: "string", multiple: true },
        dep: { type: "string", multiple: true },
        "created-by": { type: "string" },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (parsed.values.help) {
      printSubHelp("task");
      return 0;
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = createTask({
      projectDir,
      harnessDir: HARNESS_DIR,
      title: parsed.values.title,
      objective: parsed.values.objective,
      id: parsed.values.id,
      priority: parsed.values.priority,
      assignedRole: parsed.values.role,
      contextBudget: parsed.values.budget,
      status: parsed.values.status,
      activate: parsed.values.activate,
      acceptanceCriteria: parsed.values.criteria,
      scopeIn: parsed.values["scope-in"],
      scopeOut: parsed.values["scope-out"],
      expectedOutputs: parsed.values.output,
      requiredInputs: parsed.values.input,
      dependencies: parsed.values.dep,
      createdBy: parsed.values["created-by"],
      createdAt: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(res.dryRun ? `DRY RUN — Task ${res.id} not written.` : `Task created: ${res.relPath}`);
    console.log(`ID / Status : ${res.id} (${res.record.status}) | activated=${res.activated}`);
    console.log(`Title       : ${res.record.title}`);
    return 0;
  }

  if (subcmd === "list") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        status: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (parsed.values.help) {
      printSubHelp("task");
      return 0;
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = listTasks({ projectDir, status: parsed.values.status, harnessDir: HARNESS_DIR });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Tasks in ${res.tasksDir}/ (${res.tasks.length}):`);
    if (res.tasks.length === 0) {
      console.log("  (none yet — run: geloforge task new --title \"...\")");
    } else {
      for (const t of res.tasks) {
        console.log(
          `  - ${t.id} [${t.status}${t.activeInState ? ", active-in-state" : ""}] (${t.priority}, evid=${t.evidenceCount}) — ${t.title}`
        );
      }
    }
    return 0;
  }

  if (subcmd === "show") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        task: { type: "string", short: "t" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help) {
      printSubHelp("task");
      return 0;
    }
    const targetId = parsed.values.task || parsed.positionals[0];
    if (!targetId) {
      throw new Error("Missing task ID for 'geloforge task show <TASK-NNNN>'.");
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = getTask({ projectDir, taskId: targetId, harnessDir: HARNESS_DIR });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Task        : ${res.id} (${res.record.status})`);
    console.log(`File        : ${res.relPath}`);
    console.log(`Title       : ${res.record.title}`);
    console.log(`Objective   : ${res.record.objective}`);
    console.log(`Evidence    : ${(res.record.evidence_refs || []).join(", ") || "(none)"}`);
    return 0;
  }

  throw new Error(`Unknown task subcommand "${subcmd}". Expected: new, list, or show.`);
}

function handleEvidence(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printSubHelp("evidence");
    return 0;
  }
  const [subcmd, ...rest] = args;
  if (subcmd !== "capture") {
    throw new Error(`Unknown evidence subcommand "${subcmd}". Expected: capture.`);
  }

  // Split raw argv at the first "--" so command flags (--test, --json, -v) never collide with CLI flags.
  const dashIdx = rest.indexOf("--");
  const gfArgs = dashIdx === -1 ? rest : rest.slice(0, dashIdx);
  const cmdArgv = dashIdx === -1 ? [] : rest.slice(dashIdx + 1);

  const parsed = parseArgs({
    args: gfArgs,
    options: {
      project: { type: "string", short: "p" },
      task: { type: "string", short: "t" },
      name: { type: "string" },
      title: { type: "string" },
      id: { type: "string" },
      role: { type: "string" },
      "verified-by": { type: "string" },
      timeout: { type: "string" },
      "no-link": { type: "boolean", default: false },
      "created-at": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    printSubHelp("evidence");
    return 0;
  }

  let timeoutMs;
  if (parsed.values.timeout !== undefined) {
    if (!/^\d+$/.test(parsed.values.timeout.trim())) {
      throw new Error(`Invalid --timeout "${parsed.values.timeout}". Must be a positive integer.`);
    }
    timeoutMs = Number.parseInt(parsed.values.timeout.trim(), 10);
  }

  const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
  const res = captureEvidence({
    projectDir,
    harnessDir: HARNESS_DIR,
    taskId: parsed.values.task,
    name: parsed.values.name,
    title: parsed.values.title,
    id: parsed.values.id,
    producedByRole: parsed.values.role,
    verifiedBy: parsed.values["verified-by"],
    timeoutMs,
    linkTask: !parsed.values["no-link"],
    createdAt: parsed.values["created-at"],
    dryRun: parsed.values["dry-run"],
    commandArgv: cmdArgv,
  });

  if (parsed.values.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.dryRun || res.verified ? 0 : 1;
  }

  console.log(
    res.dryRun
      ? `DRY RUN — Evidence ${res.id} not written.`
      : `Evidence recorded: ${res.relPath} (status=${res.status}, check=${res.checkResult})`
  );
  console.log(`Task / Cmd  : ${res.taskId} | ${res.command}`);
  console.log(`Duration    : ${res.durationMs}ms | exit=${res.exitCode ?? "n/a"} | linked=${res.linkedToTask}`);
  return res.dryRun || res.verified ? 0 : 1;
}

function summarizeSkillForJson(skill) {
  return {
    name: skill.name,
    folderName: skill.folderName,
    source: skill.source,
    trustTier: skill.trustTier,
    trusted: skill.trusted,
    valid: skill.valid,
    blocked: skill.blocked,
    hasSecrets: skill.hasSecrets,
    displayPath: skill.displayPath,
    contentDigest: skill.contentDigest,
    estimatedTokens: skill.estimatedTokens,
    description: skill.hasSecrets
      ? "[REDACTED]"
      : typeof skill.frontmatter?.description === "string"
        ? skill.frontmatter.description
        : null,
    tags: skill.tags,
    triggers: skill.triggers,
    resources: skill.resources,
    errors: skill.errors,
    warnings: skill.warnings,
  };
}

function handleSkills(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printSubHelp("skills");
    return 0;
  }
  const [subcmd, ...rest] = args;
  if (!["list", "show", "validate", "lint"].includes(subcmd)) {
    throw new Error(`Unknown skills subcommand "${subcmd}". Expected: list, show, validate, or lint.`);
  }

  const parsed = parseArgs({
    args: rest,
    options: {
      project: { type: "string", short: "p" },
      "global-dir": { type: "string" },
      name: { type: "string" },
      "include-drafts": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: subcmd === "show",
  });

  if (parsed.values.help) {
    printSubHelp("skills");
    return 0;
  }
  if (parsed.values.strict && subcmd !== "lint") {
    throw new Error("--strict is only supported with 'geloforge skills lint'.");
  }
  if (parsed.values.name && subcmd !== "show") {
    throw new Error("--name is only supported with 'geloforge skills show'.");
  }

  const loc = resolveProjectForSkills({
    project: parsed.values.project,
    harnessDir: HARNESS_DIR,
  });
  const discovery = discoverSkills({
    projectDir: loc.projectDir,
    globalSkillsDir: parsed.values["global-dir"],
    proposalsDir: loc.proposalsDir,
    includeDrafts: parsed.values["include-drafts"],
  });

  if (subcmd === "list") {
    const payload = {
      projectDir: discovery.projectDir,
      globalSkillsDir: discovery.globalSkillsDir,
      globalSourceLabel: discovery.globalSourceLabel,
      skills: discovery.visibleSkills.map(summarizeSkillForJson),
      quarantinedCount: discovery.quarantinedSkills.length,
      conflicts: discovery.conflicts,
      rootErrors: discovery.rootErrors,
      rootWarnings: discovery.rootWarnings,
    };
    if (parsed.values.json) {
      console.log(JSON.stringify(payload, null, 2));
      return discovery.rootErrors.length > 0 ? 1 : 0;
    }
    console.log(`Project Root : ${discovery.projectDir || "(none — global skills only)"}`);
    console.log(`Global Root  : ${discovery.globalSkillsDir || "(disabled)"} (${discovery.globalSourceLabel})`);
    console.log(`Skills Found : ${discovery.visibleSkills.length} listed | ${discovery.quarantinedSkills.length} quarantined draft(s)`);
    if (discovery.visibleSkills.length === 0) {
      console.log('  (none found — create ".agents/skills/<name>/SKILL.md" or set GELOFORGE_SKILLS_DIR)');
    } else {
      for (const s of discovery.visibleSkills) {
        const status = s.blocked ? "BLOCKED" : s.valid ? "valid" : "invalid";
        const desc = s.hasSecrets
          ? "[REDACTED]"
          : String(s.frontmatter?.description || "(missing description)").replace(/\s+/g, " ").trim();
        const shortDesc = desc.length > 72 ? `${desc.slice(0, 69)}...` : desc;
        console.log(`  - ${s.name} [${s.source}, ${status}, ~${s.estimatedTokens} tok] — ${shortDesc}`);
      }
    }
    if (!parsed.values["include-drafts"] && discovery.quarantinedSkills.length > 0) {
      console.log(`  (Pass --include-drafts to view ${discovery.quarantinedSkills.length} quarantined draft skill(s) under ${loc.proposalsDir}/skills/)`);
    }
    for (const c of discovery.conflicts) console.log(`  - [CONFLICT] ${c.message}`);
    for (const w of discovery.rootWarnings) console.log(`  - [WARN] ${w}`);
    for (const e of discovery.rootErrors) console.error(`  - [ERR] ${e}`);
    return discovery.rootErrors.length > 0 ? 1 : 0;
  }

  if (subcmd === "show") {
    const targetName = parsed.values.name || parsed.positionals[0];
    if (!targetName) {
      throw new Error("Missing skill name for 'geloforge skills show <name>'.");
    }
    const found = discovery.visibleSkills.find((s) => s.name === targetName || s.folderName === targetName);
    if (!found) {
      const qFound = discovery.quarantinedSkills.find((s) => s.name === targetName || s.folderName === targetName);
      if (qFound) {
        throw new Error(
          `Skill "${targetName}" is quarantined under ${qFound.displayPath} and excluded from active skills. Pass --include-drafts to inspect it safely.`
        );
      }
      throw new Error(`Skill "${targetName}" not found in project or global skills directories.`);
    }
    const lintRes = lintSkill(found);
    const bodyOut = found.hasSecrets
      ? "[REDACTED: skill contains secret content or secret files and cannot be displayed verbatim]"
      : found.body;
    if (parsed.values.json) {
      console.log(
        JSON.stringify(
          {
            ...summarizeSkillForJson(found),
            frontmatter: found.hasSecrets ? null : found.frontmatter,
            body: bodyOut,
            lint: lintRes,
            disclaimer: STATIC_LINT_DISCLAIMER,
          },
          null,
          2
        )
      );
      return found.valid && !lintRes.hasCriticalOrError ? 0 : 1;
    }

    console.log(`Skill       : ${found.name} [${found.source}, ${found.trustTier}]`);
    console.log(`Path        : ${found.displayPath}/SKILL.md (${found.contentDigest})`);
    console.log(`Status      : ${found.blocked ? "BLOCKED" : found.valid ? "valid" : "invalid"} | ~${found.estimatedTokens} est. tokens`);
    if (found.frontmatter?.license) console.log(`License     : ${found.frontmatter.license}`);
    if (found.frontmatter?.compatibility) console.log(`Compat      : ${found.frontmatter.compatibility}`);
    if (found.tags.length > 0) console.log(`Tags        : ${found.tags.join(", ")}`);
    if (found.triggers.length > 0) console.log(`Triggers    : ${found.triggers.join(", ")}`);
    console.log(`References  : ${found.resources.references.join(", ") || "(none)"}`);
    console.log(`Templates   : ${found.resources.templates.join(", ") || "(none)"}`);
    if (found.resources.scripts.length > 0) {
      console.log(`Scripts     : ${found.resources.scripts.join(", ")} (NEVER auto-executed by GeloForge)`);
    }
    for (const f of lintRes.findings) {
      console.log(`  - [${f.severity.toUpperCase()} ${f.ruleId}] ${f.message}`);
    }
    console.log("");
    console.log(bodyOut);
    return found.valid && !lintRes.hasCriticalOrError ? 0 : 1;
  }

  if (subcmd === "validate") {
    const pool = [...discovery.allSkills];
    if (parsed.values["include-drafts"]) {
      pool.push(...discovery.quarantinedSkills);
    }
    const invalidSkills = pool.filter((s) => !s.valid);
    const valid = discovery.rootErrors.length === 0 && invalidSkills.length === 0;
    const payload = {
      valid,
      projectDir: discovery.projectDir,
      globalSkillsDir: discovery.globalSkillsDir,
      checkedCount: pool.length,
      invalidCount: invalidSkills.length,
      rootErrors: discovery.rootErrors,
      rootWarnings: discovery.rootWarnings,
      conflicts: discovery.conflicts,
      skills: pool.map(summarizeSkillForJson),
    };
    if (parsed.values.json) {
      console.log(JSON.stringify(payload, null, 2));
      return valid ? 0 : 1;
    }
    console.log(`Skills Validation : ${valid ? "PASS" : "FAIL"}`);
    console.log(`Checked Packages  : ${pool.length} | Invalid: ${invalidSkills.length} | Conflicts: ${discovery.conflicts.length}`);
    for (const e of discovery.rootErrors) console.error(`  - [ERR ROOT] ${e}`);
    for (const w of discovery.rootWarnings) console.log(`  - [WARN] ${w}`);
    for (const c of discovery.conflicts) console.log(`  - [CONFLICT] ${c.message}`);
    for (const s of pool) {
      if (s.errors.length === 0 && s.warnings.length === 0) continue;
      for (const err of s.errors) {
        console.error(`  - [ERR ${err.code}] ${err.file}: ${err.message}`);
        if (err.remediation) console.error(`      Fix: ${err.remediation}`);
      }
      for (const warn of s.warnings) {
        console.log(`  - [WARN ${warn.code}] ${warn.file}: ${warn.message}`);
      }
    }
    return valid ? 0 : 1;
  }

  // lint
  const report = lintDiscoveredSkills(discovery, {
    strict: parsed.values.strict,
    includeDrafts: parsed.values["include-drafts"],
  });
  if (parsed.values.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  }
  console.log(`Skills Lint : ${report.passed ? "PASS" : "FAIL"}${report.strict ? " (strict)" : ""}`);
  console.log(
    `Counts      : critical=${report.counts.critical} | high=${report.counts.high} | error=${report.counts.error} | warning=${report.counts.warning}`
  );
  console.log(`Disclaimer  : ${report.disclaimer}`);
  for (const e of report.rootErrors) console.error(`  - [CRITICAL ROOT] ${e}`);
  for (const w of report.rootWarnings) console.log(`  - [WARN ROOT] ${w}`);
  for (const c of report.conflicts) console.log(`  - [CONFLICT] ${c.message}`);
  for (const sr of report.skills) {
    for (const f of sr.findings) {
      const printer = f.severity === "critical" || f.severity === "error" ? console.error : console.log;
      printer(`  - [${f.severity.toUpperCase()} ${f.ruleId}] ${f.file}: ${f.message}`);
      if (f.remediation) printer(`      Fix: ${f.remediation}`);
    }
  }
  return report.passed ? 0 : 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    printMainHelp();
    process.exit(0);
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    console.log(getVersion());
    process.exit(0);
  }

  const [command, ...rest] = argv;
  try {
    let code = 0;
    switch (command) {
      case "init":
        code = handleInit(rest);
        break;
      case "adopt":
        code = handleAdopt(rest);
        break;
      case "task":
        code = handleTask(rest);
        break;
      case "evidence":
        code = handleEvidence(rest);
        break;
      case "validate":
        code = handleValidate(rest);
        break;
      case "context":
        code = handleContext(rest);
        break;
      case "skills":
        code = handleSkills(rest);
        break;
      case "handoff":
        code = handleHandoff(rest);
        break;
      case "status":
        code = handleStatus(rest);
        break;
      default:
        console.error(`ERROR: Unknown command "${command}". Run "geloforge --help" for usage.`);
        process.exit(1);
    }
    process.exitCode = code;
  } catch (err) {
    console.error(`ERROR: ${redactSecretContent(err.message)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));
if (isDirectRun) {
  main();
}
