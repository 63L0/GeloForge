#!/usr/bin/env node
/**
 * Unified non-interactive CLI entrypoint for GeloForge.
 * Commands: init, validate, context, handoff, status.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { bootstrapProject } from "./bootstrap-project.mjs";
import { adoptProject } from "../core/adopt-project.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { getProjectStatus, getProjectRecommendations } from "../core/project-status.mjs";
import { createHandoff, inspectHandoff } from "../core/handoff.mjs";
import {
  claimTaskLease,
  completeTask,
  createTask,
  getTask,
  listTaskLeases,
  listTasks,
  releaseTaskLease,
  updateTask,
} from "../core/task-manager.mjs";
import { captureEvidence } from "../core/evidence-capture.mjs";
import { createCheckpoint, getCheckpoint, listCheckpoints } from "../core/checkpoint.mjs";
import { startMcpStdioServer } from "../core/mcp-server.mjs";
import {
  discoverSkills,
  resolveProjectForSkills,
} from "../core/skills.mjs";
import { STATIC_LINT_DISCLAIMER, lintDiscoveredSkills, lintSkill } from "../core/skills-lint.mjs";
import {
  draftSkillFromExperience,
  generateApproverKeypair,
  getSkillHistory,
  promoteSkillProposal,
  proposeSkillUpdate,
  rollbackSkill,
  signSkillApproval,
} from "../core/skills-lifecycle.mjs";
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
  task       Create, update, lease, complete, list, or inspect scoped task contracts (TASK-NNNN)
  evidence   Run an explicit command (shell: false) and record EVID-NNNN manifest
  validate   Validate a project's schemas, compatibility, IDs, references, and links
  context    Compile a deterministic, trust-tiered context packet for a task or query
  skills     Discover, inspect, validate, and security-lint portable SKILL.md packages
  handoff    Create or inspect a cross-agent file-based handoff record (HANDOFF-NNNN)
  checkpoint Create, list, or inspect session recovery checkpoints (CHKPT-NNNN)
  recommend  Show ranked Human-in-the-Loop Co-Pilot recommendations & approval inbox
  status     Inspect project health, operational task state, leases, and Git status
  mcp        Start zero-dependency JSON-RPC 2.0 MCP server over stdio

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
      console.log(`Usage: geloforge context [--project <path>] (--task TASK-NNNN | --query <text> | --from-diff) [options]

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  -t, --task <id>         Task contract ID (e.g. TASK-0001)
  -q, --query <text>      Task description or search query
  --from-diff             Focus context packet on current scoped Git working-tree changes
  --include-completed     Include completed/cancelled/superseded tasks (pruned by default)
  --profile <name>        Budget profile: quick (~4000), working (~8000), deep (~16000)
  --budget <int>          Override estimated-token budget target (>= 100)
  --map                   Include selective deterministic codebase symbol outline map
  --map-budget <int>      Override codebase map token budget (>= 100)
  --skills                Include portable Agent Skills with Tier 0/1/2 progressive disclosure
  --skill <name>          Explicitly pin a trusted skill into Tier 1 (repeatable; implies --skills)
  --skills-budget <int>   Override portable skills estimated-token budget (>= 100)
  --exclude-unverified    Omit A5-A6, draft, and unverified records/skills completely
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
    case "recommend":
      console.log(`Usage: geloforge recommend [--project <path>] [--json]

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "checkpoint":
      console.log(`Usage: geloforge checkpoint <create|list|show> [options]

Subcommands:
  create                  Capture a CHKPT-NNNN session recovery checkpoint
  list                    List recovery checkpoints ordered newest first
  show                    Inspect a specific checkpoint (or latest if ID omitted)

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --summary <text>        Progress summary for resume instructions ('create')
  --resume <text>         Explicit resume instructions override ('create')
  --evidence <EVID-NNNN>  Link verified evidence ID ('create')
  --created-by <name>     Creator label ('create')
  --role <role>           Agent role fallback creator ('create')
  --status <status>       Checkpoint status (filter for 'list', override for 'create')
  --id <CHKPT-NNNN>       Explicit checkpoint ID ('create' or 'show')
  --created-at <iso>      ISO-8601 timestamp override ('create')
  --dry-run               Preview checkpoint without writing disk ('create')
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "mcp":
      console.log(`Usage: geloforge mcp [serve] [--project <path>]

Runs GeloForge's zero-dependency JSON-RPC 2.0 MCP server on stdin/stdout.
Supports status, recommend, context, task, checkpoint, and read/draft/lint skill tools;
privileged skill promote/rollback/keygen/sign actions remain strictly refused over MCP.

Options:
  -p, --project <path>    Default project directory when tool call omits 'project'
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
      console.log(`Usage: geloforge task <new|update|done|claim|release|leases|list|show> [options]

Subcommands:
  new      Create a new schema-valid TASK-NNNN contract
  update   Update task status/priority/role cleanly in state
  done     Mark task completed, update state, and release active lease
  claim    Claim a cooperative multi-IDE task/file-scope lease
  release  Release an active task lease
  leases   List active (and optionally expired) multi-IDE leases
  list     List tasks under configured tasks_dir
  show     Show details for a specific TASK-NNNN contract

Common Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --json                  Emit structured JSON output
  -h, --help              Show help

'task new' / 'task update' / 'task done' Options:
  --title <string>        Task title (required for 'new', >= 3 chars)
  --objective <string>    Detailed task objective ('new')
  --id <TASK-NNNN>        Explicit task ID ('new')
  -t, --task <TASK-NNNN>  Target task ID ('update'/'done'/'show'/'claim'/'release')
  --priority <level>      low, medium (default), high, or critical
  --role <role>           orchestrator, researcher, software-architect, developer, qa-security-reviewer
  --budget <profile>      quick, working (default), or deep
  --status <status>       inbox, ready, active, blocked, in_review, completed, cancelled
  --activate              Add task to active_tasks in operational state
  --criteria <text>       Acceptance criterion ('new', repeatable)
  --scope-in <text>       In-scope item ('new', repeatable)
  --scope-out <text>      Out-of-scope item ('new', repeatable)
  --input <relpath>       Required project input file path ('new', repeatable)
  --dep <TASK-NNNN>       Dependency task ID ('new', repeatable)
  --created-by <name>     Author label ('new')
  --created-at <iso>      ISO-8601 timestamp override
  --dry-run               Preview changes without writing disk

'task claim' / 'task release' / 'task leases' Options:
  --tool <name>           IDE / agent tool label (e.g. "codex", "antigravity")
  --session <id>          Session identifier label
  --scope <path-prefix>   Owned file/dir scope (repeatable; defaults to task scope_in)
  --ttl <minutes>         Lease TTL in minutes (1-1440, default: 120)
  --force                 Override colliding active lease or reactivate completed check
  --include-expired       Include expired leases in 'leases' output
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
      console.log(`Usage: geloforge skills <subcommand> [options]

Discovery & Static Checks:
  list            List discovered portable skills across project (.agents/skills) and global dirs
  show            Inspect one skill's metadata, supporting resources, and instructions
  validate        Validate SKILL.md frontmatter, path/symlink/secret safety, and local links
  lint            Run static security and quality lint checks across discovered skills

Adaptive Skills Lifecycle (Evidence-Backed & Human-Authorized):
  draft           Draft a quarantined skill in proposals/skills/ from verified EVID/HANDOFF records
  propose-update  Propose an isolated update to an existing trusted skill with diff preview
  keygen          Generate an Ed25519 approver keypair (public key in repo, optional --pub-out external pin, private key external)
  sign            Sign an APPR-NNNN approval bound to content SHA-256, base SHA-256, & evidence
  promote         Promote a validated quarantined proposal after genuine authorization
  history         Inspect append-only revision ledger and snapshot integrity for a skill
  rollback        Restore an authorized verified snapshot revision (never bypasses approval)

Authorization Options for 'promote' & 'rollback':
  --approval <APPR-NNNN>  Verify cryptographic Ed25519 signature (recommended)
  --public-key <file>     Verify signature against an external pinned SPKI public key PEM
  --mode pr-branch        Commit isolated branch for protected-branch human PR review (not pushed)
  --interactive           Explicit TTY confirmation (convenience safeguard; weaker than Ed25519/PR)
  (--approved-by is REFUSED: self-reported flags do not authorize promotion or rollback)

Common Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --global-dir <path>     Override global skills directory (default: GELOFORGE_SKILLS_DIR or ~/.geloforge/skills)
  --include-drafts        Include quarantined drafts under proposals/skills/ (never auto-trusted)
  --strict                In 'lint': fail on high/warning findings in addition to critical/error
  --dry-run               Preview lifecycle operation without mutating disk
  --json                  Emit structured JSON output
  -h, --help              Show help
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
      skills: { type: "boolean", default: false },
      skill: { type: "string", multiple: true },
      "skills-budget": { type: "string" },
      "exclude-unverified": { type: "boolean", default: false },
      "from-diff": { type: "boolean", default: false },
      "include-completed": { type: "boolean", default: false },
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

  const pinnedSkills = parsed.values.skill || [];
  const includeSkills = parsed.values.skills || pinnedSkills.length > 0;
  let skillsBudgetNum;
  if (parsed.values["skills-budget"] !== undefined) {
    if (!includeSkills) {
      throw new Error("--skills-budget requires --skills or --skill.");
    }
    if (!/^\d+$/.test(parsed.values["skills-budget"].trim())) {
      throw new Error(`Invalid --skills-budget "${parsed.values["skills-budget"]}". Must be a positive integer.`);
    }
    skillsBudgetNum = Number.parseInt(parsed.values["skills-budget"].trim(), 10);
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
    includeSkills,
    pinnedSkills,
    skillsBudget: skillsBudgetNum,
    excludeUnverified: parsed.values["exclude-unverified"],
    fromDiff: parsed.values["from-diff"],
    includeCompleted: parsed.values["include-completed"],
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
  if ((status.activeLeases || []).length > 0) {
    console.log(
      `Leases         : ${status.activeLeases.map((l) => `${l.task_id} (${l.tool || "unknown"}/${l.role || "unassigned"})`).join(", ")}`
    );
  }
  if ((status.pendingApprovalsInbox || []).length > 0) {
    console.log(
      `Approval Inbox : ${status.pendingApprovalsInbox.length} item(s) — ${status.pendingApprovalsInbox.map((i) => `${i.kind}:${i.id}`).join(", ")}`
    );
  }
  if (Array.isArray(status.recommendations) && status.recommendations.length > 0) {
    const topRec = status.recommendations[0];
    console.log(`Recommendation : [${topRec.priority}] ${topRec.title} -> ${topRec.command}`);
  }
  if (Array.isArray(status.nextSteps) && status.nextSteps.length > 0) {
    console.log(`Next Step      : ${status.nextSteps[0]}`);
  }
  for (const w of status.warnings) console.log(`  - [WARN] ${w}`);
  for (const e of status.errors) console.error(`  - [ERR] ${e}`);
  return 0;
}

function handleRecommend(args) {
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
    printSubHelp("recommend");
    return 0;
  }
  const explicitTarget = parsed.values.project || parsed.positionals[0] || null;
  const { projectDir } = resolveProjectDir({ project: explicitTarget, harnessDir: HARNESS_DIR });
  const rec = getProjectRecommendations(projectDir);
  if (parsed.values.json) {
    console.log(JSON.stringify(rec, null, 2));
    return 0;
  }
  console.log(`Co-Pilot Recommend : ${rec.project ? `${rec.project.name} (${rec.project.id})` : rec.projectDir}`);
  console.log(
    `Approval Inbox     : ${rec.pendingApprovalsInbox.length} pending item(s) | Active Leases: ${rec.activeLeases.length}`
  );
  if (rec.pendingApprovalsInbox.length > 0) {
    console.log("\nPending Human Approvals:");
    for (const item of rec.pendingApprovalsInbox) {
      console.log(`  - [${item.kind}] ${item.id} (${item.status}) — ${item.title}`);
      console.log(`    Action: ${item.approveHint}`);
    }
  }
  if (rec.recommendations.length > 0) {
    console.log("\nRanked Next Actions:");
    for (const r of rec.recommendations) {
      const gate = r.requiresHumanApproval ? " [HUMAN-APPROVAL]" : "";
      console.log(`  - [${r.priority.toUpperCase()}${gate}] ${r.title}`);
      console.log(`    Why    : ${r.reason}`);
      if (Array.isArray(r.options) && r.options.length > 0) {
        console.log(`    Options: ${r.options.join(" | ")}`);
      }
      console.log(`    Run    : ${r.command}`);
    }
  } else {
    console.log("  (no pending actions)");
  }
  return 0;
}

function handleCheckpoint(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printSubHelp("checkpoint");
    return 0;
  }
  const [subcmd, ...rest] = args;
  if (subcmd === "create") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        summary: { type: "string" },
        resume: { type: "string" },
        evidence: { type: "string" },
        "created-by": { type: "string" },
        role: { type: "string" },
        status: { type: "string" },
        id: { type: "string" },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (parsed.values.help) {
      printSubHelp("checkpoint");
      return 0;
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = createCheckpoint({
      projectDir,
      harnessDir: HARNESS_DIR,
      summary: parsed.values.summary,
      resumeInstructions: parsed.values.resume,
      evidenceRef: parsed.values.evidence,
      createdBy: parsed.values["created-by"],
      role: parsed.values.role,
      status: parsed.values.status,
      id: parsed.values.id,
      createdAt: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(res.dryRun ? `DRY RUN — Checkpoint ${res.checkpointId} not written.` : `Checkpoint created: ${res.recordPath}`);
    console.log(`ID / State Rev : ${res.checkpointId} | state_revision=${res.stateRevision} | branch=${res.record.git_branch}`);
    console.log(`Resume         : ${res.record.resume_instructions}`);
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
      printSubHelp("checkpoint");
      return 0;
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = listCheckpoints({ projectDir, status: parsed.values.status, harnessDir: HARNESS_DIR });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Checkpoints (${res.count}) | latest=${res.lastCheckpointId || "none"}:`);
    for (const c of res.checkpoints) {
      console.log(`  - ${c.id} [${c.status}] branch=${c.git_branch} rev=${c.state_revision} — ${c.resume_instructions}`);
    }
    return 0;
  }

  if (subcmd === "show") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        id: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help) {
      printSubHelp("checkpoint");
      return 0;
    }
    const targetId = parsed.values.id || parsed.positionals[0] || null;
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = getCheckpoint({ projectDir, checkpointId: targetId, harnessDir: HARNESS_DIR });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Checkpoint : ${res.checkpointId} (${res.record.status})${res.isLastCheckpoint ? " [LATEST]" : ""}`);
    console.log(`File       : ${res.recordPath}`);
    console.log(`Git        : ${res.record.git_branch} @ ${res.record.git_commit} (clean=${res.record.working_tree_clean})`);
    console.log(`Active     : ${(res.record.active_tasks || []).join(", ") || "(none)"}`);
    console.log(`Resume     : ${res.record.resume_instructions}`);
    return 0;
  }

  throw new Error(`Unknown checkpoint subcommand "${subcmd}". Expected: create, list, or show.`);
}

async function handleMcp(args) {
  let effectiveArgs = args;
  if (args.length > 0 && (args[0] === "-h" || args[0] === "--help")) {
    printSubHelp("mcp");
    return 0;
  }
  if (args.length > 0 && args[0] === "serve") {
    effectiveArgs = args.slice(1);
  }
  const parsed = parseArgs({
    args: effectiveArgs,
    options: {
      project: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    printSubHelp("mcp");
    return 0;
  }
  let defaultProjectDir = null;
  if (parsed.values.project) {
    defaultProjectDir = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR }).projectDir;
  }
  await startMcpStdioServer({ defaultProjectDir, harnessDir: HARNESS_DIR });
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

  if (subcmd === "update" || subcmd === "done") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        task: { type: "string", short: "t" },
        id: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        role: { type: "string" },
        activate: { type: "boolean", default: false },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
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
    const targetId = parsed.values.task || parsed.values.id || parsed.positionals[0];
    if (!targetId) {
      throw new Error(`Missing task ID for 'geloforge task ${subcmd} <TASK-NNNN>'.`);
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res =
      subcmd === "done"
        ? completeTask({
            projectDir,
            harnessDir: HARNESS_DIR,
            taskId: targetId,
            updatedAt: parsed.values["created-at"],
            dryRun: parsed.values["dry-run"],
          })
        : updateTask({
            projectDir,
            harnessDir: HARNESS_DIR,
            taskId: targetId,
            status: parsed.values.status,
            priority: parsed.values.priority,
            assignedRole: parsed.values.role,
            activate: parsed.values.activate,
            updatedAt: parsed.values["created-at"],
            dryRun: parsed.values["dry-run"],
          });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(
      res.dryRun
        ? `DRY RUN — Task ${res.id} not updated.`
        : `Task updated: ${res.id} (${res.previousStatus} -> ${res.status}) | state_revision=${res.stateRevision}`
    );
    return 0;
  }

  if (subcmd === "claim") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        task: { type: "string", short: "t" },
        id: { type: "string" },
        role: { type: "string" },
        tool: { type: "string" },
        session: { type: "string" },
        scope: { type: "string", multiple: true },
        ttl: { type: "string" },
        force: { type: "boolean", default: false },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
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
    const targetId = parsed.values.task || parsed.values.id || parsed.positionals[0];
    if (!targetId) {
      throw new Error("Missing task ID for 'geloforge task claim <TASK-NNNN>'.");
    }
    let ttlMinutes;
    if (parsed.values.ttl !== undefined) {
      if (!/^\d+$/.test(parsed.values.ttl.trim())) {
        throw new Error(`Invalid --ttl "${parsed.values.ttl}". Must be a positive integer.`);
      }
      ttlMinutes = Number.parseInt(parsed.values.ttl.trim(), 10);
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = claimTaskLease({
      projectDir,
      harnessDir: HARNESS_DIR,
      taskId: targetId,
      role: parsed.values.role,
      tool: parsed.values.tool,
      sessionId: parsed.values.session,
      scopes: parsed.values.scope,
      ttlMinutes,
      force: parsed.values.force,
      createdAt: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(res.dryRun ? `DRY RUN — Lease for ${res.lease.task_id} not written.` : `Lease claimed: ${res.lease.task_id} (${res.leasesRelPath})`);
    console.log(`Tool / Role : ${res.lease.tool} / ${res.lease.role} | expires=${res.lease.expires_at}`);
    console.log(`Scopes      : ${(res.lease.claimed_scope || []).join(", ") || "(none)"}`);
    return 0;
  }

  if (subcmd === "release") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        task: { type: "string", short: "t" },
        id: { type: "string" },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
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
    const targetId = parsed.values.task || parsed.values.id || parsed.positionals[0];
    if (!targetId) {
      throw new Error("Missing task ID for 'geloforge task release <TASK-NNNN>'.");
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = releaseTaskLease({
      projectDir,
      harnessDir: HARNESS_DIR,
      taskId: targetId,
      nowIso: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(
      res.dryRun
        ? `DRY RUN — Release check for ${res.taskId}.`
        : res.released
          ? `Lease released: ${res.taskId}`
          : `No active lease found for ${res.taskId}`
    );
    return 0;
  }

  if (subcmd === "leases") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        "include-expired": { type: "boolean", default: false },
        "created-at": { type: "string" },
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
    const res = listTaskLeases({
      projectDir,
      includeExpired: parsed.values["include-expired"],
      nowIso: parsed.values["created-at"],
      harnessDir: HARNESS_DIR,
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Task Leases (${res.activeLeases.length} active, ${res.expiredLeases.length} expired):`);
    for (const l of res.leases) {
      console.log(
        `  - ${l.task_id} [${l.tool}/${l.role}] expires=${l.expires_at} scopes=[${(l.claimed_scope || []).join(", ")}]`
      );
    }
    return 0;
  }

  throw new Error(`Unknown task subcommand "${subcmd}". Expected: new, update, done, claim, release, leases, list, or show.`);
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

async function promptTtyAuthorization({ action, skillName, targetRevision, contentSha256, expectedInput }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "--interactive requires a real interactive terminal (TTY). Use --approval <APPR-NNNN> or --mode pr-branch in non-interactive sessions."
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("");
    console.log(
      "Local Interactive Authorization (CONVENIENCE SAFEGUARD ONLY — weaker than Ed25519 signatures or protected-branch PR reviews):"
    );
    console.log(`  Action  : ${action}${targetRevision ? ` (${targetRevision})` : ""}`);
    console.log(`  Skill   : ${skillName}`);
    console.log(`  Digest  : ${contentSha256}`);
    const answer = await rl.question(`Type exact phrase "${expectedInput}" to authorize: `);
    return answer.trim() === expectedInput;
  } finally {
    rl.close();
  }
}

async function handleSkillsLifecycle(subcmd, rest) {
  if (subcmd === "draft") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        "from-evidence": { type: "string", multiple: true },
        evidence: { type: "string", multiple: true },
        "from-handoff": { type: "string", multiple: true },
        handoff: { type: "string", multiple: true },
        name: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        step: { type: "string", multiple: true },
        tag: { type: "string", multiple: true },
        trigger: { type: "string", multiple: true },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (parsed.values.help) {
      printSubHelp("skills");
      return 0;
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = draftSkillFromExperience({
      projectDir,
      harnessDir: HARNESS_DIR,
      evidenceIds: [...(parsed.values["from-evidence"] || []), ...(parsed.values.evidence || [])],
      handoffIds: [...(parsed.values["from-handoff"] || []), ...(parsed.values.handoff || [])],
      skillName: parsed.values.name,
      title: parsed.values.title,
      description: parsed.values.description,
      steps: parsed.values.step,
      tags: parsed.values.tag,
      triggers: parsed.values.trigger,
      createdAt: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(res.dryRun ? `DRY RUN — Quarantined draft "${res.skillName}" not written.` : `Skill draft created (QUARANTINED): ${res.proposalDir}/SKILL.md`);
    console.log(`Candidate SHA : ${res.candidateDigest}`);
    console.log(`Provenance    : ${res.evidenceDigests.join(", ")}`);
    for (const w of res.stalenessWarnings) console.log(`  - [WARN] ${w}`);
    return 0;
  }

  if (subcmd === "propose-update") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        name: { type: "string" },
        "from-evidence": { type: "string", multiple: true },
        evidence: { type: "string", multiple: true },
        "from-handoff": { type: "string", multiple: true },
        handoff: { type: "string", multiple: true },
        reason: { type: "string" },
        "patch-file": { type: "string" },
        "append-note": { type: "string" },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help) {
      printSubHelp("skills");
      return 0;
    }
    const targetName = parsed.values.name || parsed.positionals[0];
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = proposeSkillUpdate({
      projectDir,
      harnessDir: HARNESS_DIR,
      skillName: targetName,
      evidenceIds: [...(parsed.values["from-evidence"] || []), ...(parsed.values.evidence || [])],
      handoffIds: [...(parsed.values["from-handoff"] || []), ...(parsed.values.handoff || [])],
      reason: parsed.values.reason,
      patchFile: parsed.values["patch-file"],
      appendNote: parsed.values["append-note"],
      createdAt: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(res.dryRun ? `DRY RUN — Update proposal for "${res.skillName}" not written.` : `Update proposal staged (QUARANTINED): ${res.proposalDir}/SKILL.md`);
    console.log(`Base / Cand   : ${res.baseSkillDigest.slice(0, 19)} -> ${res.candidateDigest.slice(0, 19)} (${res.diffSummary})`);
    console.log(`Provenance    : ${res.evidenceDigests.join(", ")}`);
    for (const w of res.stalenessWarnings) console.log(`  - [WARN] ${w}`);
    return 0;
  }

  if (subcmd === "keygen") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        approver: { type: "string" },
        out: { type: "string", short: "o" },
        "pub-out": { type: "string" },
        "created-at": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (parsed.values.help) {
      printSubHelp("skills");
      return 0;
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = generateApproverKeypair({
      projectDir,
      harnessDir: HARNESS_DIR,
      workspaceRoot: WORKSPACE_ROOT,
      approverId: parsed.values.approver,
      privateKeyOut: parsed.values.out,
      publicKeyOut: parsed.values["pub-out"],
      createdAt: parsed.values["created-at"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Ed25519 Approver Registered : ${res.approverId} (${res.keyFingerprint})`);
    console.log(`Public Registry (repo)      : ${res.registryPath}`);
    console.log(`Private Key (external 0600) : ${res.privateKeyPath}`);
    if (res.publicKeyPath) console.log(`Public Key (external pin)   : ${res.publicKeyPath}`);
    return 0;
  }

  if (subcmd === "sign") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        action: { type: "string", default: "promote" },
        skill: { type: "string" },
        name: { type: "string" },
        proposal: { type: "string" },
        revision: { type: "string" },
        approver: { type: "string" },
        key: { type: "string" },
        rationale: { type: "string" },
        "risk-assessment": { type: "string" },
        "expires-at": { type: "string" },
        "decided-at": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help) {
      printSubHelp("skills");
      return 0;
    }
    const skillName = parsed.values.skill || parsed.values.name || parsed.values.proposal || parsed.positionals[0];
    const targetRev = parsed.values.revision || parsed.positionals[1];
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = signSkillApproval({
      projectDir,
      harnessDir: HARNESS_DIR,
      action: parsed.values.action,
      skillName,
      targetRevision: targetRev,
      approverId: parsed.values.approver,
      privateKeyPath: parsed.values.key,
      rationale: parsed.values.rationale,
      riskAssessment: parsed.values["risk-assessment"],
      expiresAt: parsed.values["expires-at"],
      decidedAt: parsed.values["decided-at"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Signed Approval Created : ${res.approvalId} -> ${res.relPath}`);
    console.log(`Bound Operation         : ${res.action} ${res.skillName}${res.targetRevision ? ` (${res.targetRevision})` : ""}`);
    console.log(`Bound Content SHA-256   : ${res.contentSha256}`);
    console.log(`Approver / Key          : ${res.approverId} (${res.keyFingerprint})`);
    return 0;
  }

  if (subcmd === "promote") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        name: { type: "string" },
        approval: { type: "string" },
        "public-key": { type: "string" },
        mode: { type: "string" },
        branch: { type: "string" },
        interactive: { type: "boolean", default: false },
        "approved-by": { type: "string" },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help) {
      printSubHelp("skills");
      return 0;
    }
    const proposalName = parsed.values.name || parsed.positionals[0];
    if (parsed.values.interactive && parsed.values.mode) {
      throw new Error("Cannot combine --interactive with --mode; choose one authorization mode.");
    }
    if (parsed.values.approval && (parsed.values.mode || parsed.values.interactive)) {
      throw new Error("Cannot combine --approval with --mode or --interactive; choose one authorization mode.");
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const authMode = parsed.values.interactive ? "interactive" : parsed.values.mode;

    let interactiveConfirm = null;
    if (authMode === "interactive" && !parsed.values["dry-run"] && !parsed.values["approved-by"] && !parsed.values.approval) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "--interactive requires a real interactive terminal (TTY). Use --approval <APPR-NNNN> or --mode pr-branch in non-interactive sessions."
        );
      }
      const preview = promoteSkillProposal({
        projectDir,
        harnessDir: HARNESS_DIR,
        proposalName,
        dryRun: true,
      });
      const expectedInput = `promote ${preview.skillName} ${preview.candidateDigest.slice(7, 15)}`;
      const ok = await promptTtyAuthorization({
        action: preview.action,
        skillName: preview.skillName,
        targetRevision: null,
        contentSha256: preview.candidateDigest,
        expectedInput,
      });
      interactiveConfirm = () => ok;
    }

    const res = promoteSkillProposal({
      projectDir,
      harnessDir: HARNESS_DIR,
      proposalName,
      approvalId: parsed.values.approval,
      publicKeyPath: parsed.values["public-key"],
      mode: authMode,
      branch: parsed.values.branch,
      approvedBy: parsed.values["approved-by"],
      interactiveConfirm,
      createdAt: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(res.dryRun ? `DRY RUN — Promotion check passed for "${res.skillName}"` : `Promoted Skill (${res.action}) : ${res.activeRel} (${res.revision})`);
    console.log(`Authorization Tier : ${res.authorizationTier || "preview"}${res.approvalId ? ` (${res.approvalId})` : ""}`);
    if (res.keyTrustSource) console.log(`Key Trust Source   : ${res.keyTrustSource}`);
    console.log(`Digest / History   : ${res.candidateDigest}${res.historyRel ? ` | ${res.historyRel}` : ""}`);
    if (res.prBranch) console.log(`PR Review Branch   : ${res.prBranch} (${res.prCommitSha}) — push & require PR approval before merging`);
    if (res.authorizationWarning) console.log(`  - [NOTICE] ${res.authorizationWarning}`);
    return 0;
  }

  if (subcmd === "history") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        name: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help) {
      printSubHelp("skills");
      return 0;
    }
    const targetName = parsed.values.name || parsed.positionals[0];
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = getSkillHistory({ projectDir, skillName: targetName, harnessDir: HARNESS_DIR });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(`Skill History : ${res.skillName} | active=${res.activeExists} | drift=${res.driftDetected}`);
    console.log(`Current SHA   : ${res.currentSha256 || "(not active)"}`);
    if (res.revisions.length === 0) {
      console.log("  (no recorded revisions yet)");
      return 0;
    }
    for (const r of res.revisions) {
      console.log(
        `  - ${r.revision} [${r.action}] tier=${r.authorization_tier} appr=${r.approval_ref || "none"} sha=${r.package_sha256.slice(0, 19)} snapOk=${r.snapshotValid}${r.restored_from_revision ? ` from=${r.restored_from_revision}` : ""}`
      );
    }
    return 0;
  }

  if (subcmd === "rollback") {
    const parsed = parseArgs({
      args: rest,
      options: {
        project: { type: "string", short: "p" },
        name: { type: "string" },
        revision: { type: "string" },
        approval: { type: "string" },
        "public-key": { type: "string" },
        mode: { type: "string" },
        branch: { type: "string" },
        interactive: { type: "boolean", default: false },
        "approved-by": { type: "string" },
        "created-at": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    });
    if (parsed.values.help) {
      printSubHelp("skills");
      return 0;
    }
    const skillName = parsed.values.name || parsed.positionals[0];
    const targetRevision = parsed.values.revision || parsed.positionals[1];
    if (parsed.values.interactive && parsed.values.mode) {
      throw new Error("Cannot combine --interactive with --mode; choose one authorization mode.");
    }
    if (parsed.values.approval && (parsed.values.mode || parsed.values.interactive)) {
      throw new Error("Cannot combine --approval with --mode or --interactive; choose one authorization mode.");
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const authMode = parsed.values.interactive ? "interactive" : parsed.values.mode;

    let interactiveConfirm = null;
    if (authMode === "interactive" && !parsed.values["dry-run"] && !parsed.values["approved-by"] && !parsed.values.approval) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "--interactive requires a real interactive terminal (TTY). Use --approval <APPR-NNNN> or --mode pr-branch in non-interactive sessions."
        );
      }
      const preview = rollbackSkill({
        projectDir,
        harnessDir: HARNESS_DIR,
        skillName,
        targetRevision,
        dryRun: true,
      });
      const expectedInput = `rollback ${preview.skillName} ${preview.restoredDigest.slice(7, 15)}`;
      const ok = await promptTtyAuthorization({
        action: "rollback",
        skillName: preview.skillName,
        targetRevision: preview.targetRevision,
        contentSha256: preview.restoredDigest,
        expectedInput,
      });
      interactiveConfirm = () => ok;
    }

    const res = rollbackSkill({
      projectDir,
      harnessDir: HARNESS_DIR,
      skillName,
      targetRevision,
      approvalId: parsed.values.approval,
      publicKeyPath: parsed.values["public-key"],
      mode: authMode,
      branch: parsed.values.branch,
      approvedBy: parsed.values["approved-by"],
      interactiveConfirm,
      createdAt: parsed.values["created-at"],
      dryRun: parsed.values["dry-run"],
    });
    if (parsed.values.json) {
      console.log(JSON.stringify(res, null, 2));
      return 0;
    }
    console.log(
      res.dryRun
        ? `DRY RUN — Rollback check passed for "${res.skillName}" -> ${res.targetRevision}`
        : `Rolled Back Skill : ${res.activeRel} -> ${res.restoredFromRevision} (recorded as ${res.newRevision})`
    );
    console.log(`Authorization Tier : ${res.authorizationTier || "preview"}${res.approvalId ? ` (${res.approvalId})` : ""}`);
    if (res.keyTrustSource) console.log(`Key Trust Source   : ${res.keyTrustSource}`);
    console.log(`Restored SHA-256   : ${res.restoredDigest}`);
    if (res.prBranch) console.log(`PR Review Branch   : ${res.prBranch} (${res.prCommitSha}) — push & require PR approval before merging`);
    if (res.authorizationWarning) console.log(`  - [NOTICE] ${res.authorizationWarning}`);
    return 0;
  }

  throw new Error(`Unknown skills subcommand "${subcmd}".`);
}

async function handleSkills(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printSubHelp("skills");
    return 0;
  }
  const [subcmd, ...rest] = args;
  if (["draft", "propose-update", "keygen", "sign", "promote", "history", "rollback"].includes(subcmd)) {
    return handleSkillsLifecycle(subcmd, rest);
  }
  if (!["list", "show", "validate", "lint"].includes(subcmd)) {
    throw new Error(
      `Unknown skills subcommand "${subcmd}". Expected: list, show, validate, lint, draft, propose-update, keygen, sign, promote, history, or rollback.`
    );
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

async function main() {
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
        code = await handleSkills(rest);
        break;
      case "handoff":
        code = handleHandoff(rest);
        break;
      case "checkpoint":
        code = handleCheckpoint(rest);
        break;
      case "recommend":
        code = handleRecommend(rest);
        break;
      case "status":
        code = handleStatus(rest);
        break;
      case "mcp":
        code = await handleMcp(rest);
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
  await main();
}
