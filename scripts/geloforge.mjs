#!/usr/bin/env node
/**
 * Unified non-interactive CLI entrypoint for GeloForge.
 * Commands: init, validate, context, status.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "./bootstrap-project.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { getProjectStatus } from "../core/project-status.mjs";
import { validateOutputFilePath } from "../core/path-safety.mjs";

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
  validate   Validate a project's schemas, compatibility, IDs, references, and links
  context    Compile a deterministic, trust-tiered context packet for a task or query
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
    case "validate":
      console.log(`Usage: geloforge validate --project <path> [--json]

Options:
  -p, --project <path>    Target project directory (or pass as positional arg)
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "context":
      console.log(`Usage: geloforge context --project <path> (--task TASK-NNNN | --query <text>) [options]

Options:
  -p, --project <path>    Target project directory (required)
  -t, --task <id>         Task contract ID (e.g. TASK-0001)
  -q, --query <text>      Task description or search query
  --profile <name>        Budget profile: quick (~2000), working (~8000), deep (~16000)
  --budget <int>          Override estimated-token budget target (>= 100)
  --format <type>         Output format: markdown (default) or json
  -o, --out <file>        Write output atomically to a safe file path
  --compiled-at <iso>     ISO-8601 timestamp for deterministic manifest
  --json                  Alias for --format json
  -h, --help              Show help
`);
      break;
    case "status":
      console.log(`Usage: geloforge status --project <path> [--json]

Options:
  -p, --project <path>    Target project directory (or pass as positional arg)
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
  }
}

function writeFileAtomically(resolvedOutPath, content) {
  const parent = path.dirname(resolvedOutPath);
  fs.mkdirSync(parent, { recursive: true });
  const tempPath = path.join(parent, `.geloforge-tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tempPath, resolvedOutPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
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
  const target = parsed.values.project || parsed.positionals[0];
  if (!target) {
    throw new Error("Missing target project path (--project <path>).");
  }
  const result = validateProject(target);
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

  let resolvedOut = null;
  if (parsed.values.out !== undefined) {
    resolvedOut = validateOutputFilePath(parsed.values.out, {
      harnessDir: HARNESS_DIR,
      workspaceRoot: WORKSPACE_ROOT,
    });
  }

  const result = compileContext({
    projectDir: parsed.values.project,
    taskId: parsed.values.task,
    query: parsed.values.query,
    profile: parsed.values.profile || "working",
    budget: budgetNum,
    compiledAt: parsed.values["compiled-at"],
    harnessDir: HARNESS_DIR,
  });

  const payload = format === "json" ? `${JSON.stringify(result, null, 2)}\n` : result.markdown;

  if (resolvedOut) {
    writeFileAtomically(resolvedOut, payload);
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
  const target = parsed.values.project || parsed.positionals[0];
  if (!target) {
    throw new Error("Missing target project path (--project <path>).");
  }
  const status = getProjectStatus(target);
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
      case "validate":
        code = handleValidate(rest);
        break;
      case "context":
        code = handleContext(rest);
        break;
      case "status":
        code = handleStatus(rest);
        break;
      default:
        console.error(`ERROR: Unknown command "${command}". Run "geloforge --help" for usage.`);
        process.exit(1);
    }
    process.exit(code);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

const isDirectRun = Boolean(process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));
if (isDirectRun) {
  main();
}
