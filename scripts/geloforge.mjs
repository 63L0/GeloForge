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
import { atomicWriteFile, validateOutputFilePath } from "../core/path-safety.mjs";
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
  validate   Validate a project's schemas, compatibility, IDs, references, and links
  context    Compile a deterministic, trust-tiered context packet for a task or query
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
  --profile <name>        Budget profile: quick (~2000), working (~8000), deep (~16000)
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
      case "validate":
        code = handleValidate(rest);
        break;
      case "context":
        code = handleContext(rest);
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
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));
if (isDirectRun) {
  main();
}
