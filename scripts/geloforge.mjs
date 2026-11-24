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
import { bootstrapProject, DEFAULT_INIT_LOCATION } from "./bootstrap-project.mjs";
import { adoptProject } from "../core/adopt-project.mjs";
import { auditStagingFailure, readAutonomousMode, setAutonomousMode, stagingProgressPath } from "../core/autonomous-audit.mjs";
import { authorizeStagingWorker, watchStagingAudits } from "../core/staging-audit.mjs";
import { learnFromStagingAudits } from "../core/audit-learning.mjs";
import { manageWorktrees } from "../core/worktrees.mjs";
import { promoteProjectProposal } from "../core/promotion.mjs";
import { compileCachedContext } from "../core/context-cache.mjs";
import { validateProject } from "../core/project-validator.mjs";
import { compileContext } from "../core/context-compiler.mjs";
import { getProjectStatus, getProjectRecommendations } from "../core/project-status.mjs";
import { createHandoff, inspectHandoff, latestTaskHandoff } from "../core/handoff.mjs";
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
import { verifyTask } from "../core/verify-task.mjs";
import { compactSession, createCheckpoint, getCheckpoint, listCheckpoints } from "../core/checkpoint.mjs";
import { startMcpStdioServer } from "../core/mcp-server.mjs";
import { initMcpClients } from "../core/mcp-init.mjs";
import { checkMcpLock, lockMcpServers } from "../core/mcp-lock.mjs";
import { runProjectDoctor } from "../core/doctor.mjs";
import { HOOK_TARGETS, initProjectHooks } from "../core/hooks-init.mjs";
import { runDemo } from "../core/resume-demo.mjs";
import { scanEvidenceManifests, generateProjectReport } from "../core/project-report.mjs";
import { getCodingLoopStatus, runCodingLoop } from "../core/coding-loop.mjs";
import {
  discoverSkills,
  resolveProjectForSkills,
} from "../core/skills.mjs";
import { STARTER_SKILL_CATALOG, suggestProjectSkills } from "../core/skills-advisor.mjs";
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
import { loadProjectManifestAndState, resolveProjectDir } from "../core/project-locator.mjs";
import { readRuntimeJson } from "../core/runtime-files.mjs";

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
  verify     Run a check, save a checkpoint, and complete the task on verified evidence
  validate   Validate a project's schemas, compatibility, IDs, references, and links
  context    Compile a deterministic, trust-tiered context packet for a task or query
  skills     Discover, inspect, validate, and security-lint portable SKILL.md packages
  resume     Show the active task, last check, and next action
  demo       Run a disposable checkout handoff without an API key
  handoff    Create or inspect a cross-agent file-based handoff record (HANDOFF-NNNN)
  checkpoint Create, list, inspect, resume, or compact session checkpoints (CHKPT-NNNN)
  compact    Save a recovery checkpoint, build a slim resume packet, and print a fresh-chat prompt
  report     Generate a shareable Markdown/JSON PR & project verification report
  recommend  Show ranked Human-in-the-Loop Co-Pilot recommendations & approval inbox
  autonomous Run opt-in staging audits, review progress, and learn from completed audits
  loop       Run bounded implement -> verify -> review -> fix coding loop for a task
  proposal   Review, sign, or promote a canonical-document proposal
  worktree   Add, list, or remove isolated local Git worktrees
  status     Inspect project health, operational task state, leases, and Git status
  doctor     Run one-command diagnostics across setup, compatibility, MCP locks, skills, and hooks
  hooks      Install or preview opt-in Git pre-commit, Claude Code, and Gemini CLI hooks (hooks init)
  mcp        Start stdio MCP server, configure clients (mcp init), or pin tools (mcp lock)

Global Options:
  -h, --help     Show help (use "geloforge <command> --help" for command options)
  -v, --version  Show GeloForge version
`);
}

function printSubHelp(cmd) {
  switch (cmd) {
    case "doctor":
      console.log(`Usage: geloforge doctor [options]

Checks Node.js runtime, Second Brain validation, harness compatibility, Git status,
cooperative task leases, skill lint health, MCP tool lockfiles, and ambient hooks.

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --global-dir <path>     Override global skills directory (default: GELOFORGE_SKILLS_DIR or ~/.geloforge/skills)
  --include-drafts        Include quarantined drafts when running skills lint
  --skip-mcp-check        Skip probing stdio MCP servers when .geloforge/mcp-lock.json exists
  --timeout-ms <ms>       MCP probe timeout in ms (500-30000)
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "hooks":
      console.log(`Usage: geloforge hooks init [options]

Installs or previews lightweight, opt-in local checks without background daemons:
  git      .git/hooks/pre-commit (runs geloforge validate + mcp lock --check if locked)
  claude   .claude/settings.json hooks.Stop (advisory doctor reminder)
  gemini   .gemini/settings.json hooks.AfterAgent (preserves existing mcpServers)

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --target <list>         Targets: git, claude, gemini (comma-separated or repeatable; default: all)
  --dry-run               Preview file changes without writing disk
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "autonomous":
      console.log(`Usage: geloforge autonomous <status|on|off|audit|authorize|watch|progress|learn> [options]

  status | on | off     Inspect or set this project's switch (default OFF)
  audit                 Verify one saved local failure with --event and --execution
  authorize             Sign a staging --config with --key (optional --expires-at)
  watch                 Process staging deliveries using --config, --approval and --owner-key
                        Use --once to process the inbox and exit
  progress              Show the saved audit stage and remaining work with --task
  learn                 List recurring failures, or draft with --pattern and --skill
                        Use --step to provide a reviewed checklist step

Paths for --event, --execution and --config are relative to the project.
Use --project <path> to select the project and --json for machine-readable output.
`);
      break;
    case "proposal":
      console.log(`Usage: geloforge proposal <preview|sign|promote> --proposal <file.md> --target <file.md> --evidence EVID-NNNN [options]

  sign       Use --key <private PEM> and optional --expires-at <ISO timestamp>
  promote    Use --approval APPR-NNNN and --owner-key <pinned public PEM>
  --project  Project path (auto-detected when omitted)
  --json     Emit structured output

Paths are project-relative. Repeat --evidence to bind multiple verified records.
`);
      break;
    case "worktree":
      console.log(`Usage: geloforge worktree <list|add|remove> [name] [options]

  --project <path>     Git project root (auto-detected when omitted)
  --workspace <path>   Workspace containing worktrees/ (defaults to project parent)
  --ref <ref>          Commit or ref for add (defaults to HEAD)
  --json               Emit structured output

Removal delegates to Git's clean-worktree check and preserves the branch.
`);
      break;
    case "init":
      console.log(`Usage: geloforge init --name "<Project Name>" [options]

Options:
  --name <string>         Project display name (required, 3-80 chars)
  --slug <string>         Lowercase ASCII slug (optional)
  --dest <path>           Target directory (default: ${DEFAULT_INIT_LOCATION})
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
  --cache                 Reuse an unchanged query packet from the project disk cache
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
      console.log(`Usage: geloforge checkpoint <create|list|show|resume|compact> [options]

Subcommands:
  create                  Capture a CHKPT-NNNN session recovery checkpoint
  list                    List recovery checkpoints ordered newest first
  show                    Inspect a specific checkpoint (or last project checkpoint)
  resume                  Read a checkpoint, compare current state, and show the next action
  compact                 1-command checkpoint + slim resume packet + fresh-chat prompt (alias: geloforge compact)

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
  --local                 Save in local-runtime/checkpoints/ without updating project state ('create')
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "compact":
      console.log(`Usage: geloforge compact [options]

Saves a recovery checkpoint (CHKPT-NNNN), compiles a slim quick resume context packet,
and outputs a ready-to-paste fresh-chat resume prompt for long sessions.

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  -t, --task <TASK-NNNN>  Focus resume packet on a specific task (defaults to first active task)
  -q, --query <text>      Resume focus query when no task is active
  --summary <text>        Progress summary for the saved checkpoint
  --resume <text>         Explicit resume instructions override
  --evidence <EVID-NNNN>  Link verified evidence ID
  --profile <name>        Context profile: quick (default), working, or deep
  --budget <int>          Override context token budget
  --no-map                Omit selective codebase symbol map from resume packet
  --skills                Include matching portable skills in resume packet
  --exclude-unverified    Omit unverified A5-A6/draft items from resume packet
  -o, --out <file>        Write compiled resume Markdown packet atomically to a safe path
  --local                 Save checkpoint locally without incrementing project state_revision
  --dry-run               Preview checkpoint and prompt without writing files
  --json                  Emit structured JSON output
  -h, --help              Show help
`);
      break;
    case "report":
      console.log(`Usage: geloforge report [options]

Generates a shareable Markdown/JSON verification report across tasks, evidence receipts,
session checkpoints, and doctor health checks (for PRs, handoffs, or release audits).

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  -t, --task <TASK-NNNN>  Filter report tables to one specific task contract
  --check-mcp             Probe live stdio MCP servers against .geloforge/mcp-lock.json
  --timeout-ms <ms>       MCP probe timeout in ms (500-30000)
  -o, --out <file>        Write Markdown report atomically to a safe path
  --dry-run               Preview report without writing '--out' file
  --json                  Emit structured JSON report
  -h, --help              Show help
`);
      break;
    case "mcp":
      console.log(`Usage: geloforge mcp [serve] [--project <path>] [--read-only]
       geloforge mcp init [--project <path>] [--client <name>] [--read-only] [--dry-run] [--json]
       geloforge mcp lock [--project <path>] [--client <name>] [--check] [--dry-run] [--timeout-ms <ms>] [--json]

Runs GeloForge's zero-dependency JSON-RPC 2.0 MCP server on stdin/stdout.
Pins operations to the configured/current project root (when present).
Read-only tools: geloforge_status, geloforge_recommend, geloforge_context.
State-mutating tools (disabled by --read-only): geloforge_task (new/update/done/claim/release),
geloforge_checkpoint (create), geloforge_skills (draft/propose in quarantine only).
Privileged skill promote/rollback/keygen/sign actions remain strictly refused over MCP.

Options:
  -p, --project <path>    Trusted project root directory
  --read-only             Refuse all state-mutating MCP actions
  -h, --help              Show help

Init / Lock options:
  --client <name>         cursor, vscode, claude, gemini, or antigravity
  --check                 Compare live stdio MCP tool definitions against .geloforge/mcp-lock.json
  --timeout-ms <ms>       Probe timeout per stdio server (100-60000, default: 8000)
  --dry-run               Preview changes without writing files
  --json                  Emit structured JSON output
`);
      break;
    case "loop":
      console.log(`Usage: geloforge loop run --config <relpath> [--task TASK-NNNN] [options]
       geloforge loop status [--task TASK-NNNN] [--project <path>] [--json]

Run a bounded implement -> verify -> review -> fix loop for one open task.
Deterministic command verification gates task completion; LLM review never overrides a failing gate.

Options:
  -p, --project <path>    Target project directory (auto-detected from CWD if omitted)
  --config <relpath>      Project-relative JSON config file (required for 'run')
  -t, --task <TASK-NNNN>  Target task ID (defaults to sole active task)
  --tool <name>           Cooperative lease tool label
  --session <id>          Cooperative lease session label
  --dry-run               Validate config, executables, task, and context without running providers
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
  --file <path>                Track a relevant source file (repeatable)
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
  --evidence <EVID-NNNN>  Link verified evidence ID ('update'/'done', repeatable)
  --require-evidence      Refuse 'done' unless task has verified EVID-* check(s)
  --created-by <name>     Author label ('new')
  --created-at <iso>      ISO-8601 timestamp override
  --dry-run               Preview changes without writing disk

'task claim' / 'task release' / 'task leases' Options:
  --tool <name>           Advisory IDE / agent tool label (e.g. "codex", "antigravity")
  --session <id>          Advisory session identifier label
  --scope <path-prefix>   Owned file/dir scope (repeatable; defaults to task scope_in)
  --ttl <minutes>         Lease TTL in minutes (1-1440, default: 120)
  --force                 Override colliding active lease or ownership mismatch
  --include-expired       Include expired leases in 'leases' output
`);
      break;
    case "verify":
      console.log(`Usage: geloforge verify [options] -- <command> [args...]

Run the explicit command from the project root. A successful check records verified
evidence, saves a checkpoint, and completes the task with --require-evidence.
A failed check saves draft evidence and leaves the task open for a retry.

Options:
  -p, --project <path>    Target project (auto-detected from CWD if omitted)
  -t, --task <id>         Task to finish (defaults to the sole active task)
  --file <path>           Bind evidence to this input file (repeatable)
  --name <text>           Evidence check name
  --timeout <ms>          Command timeout (50-600000, default 60000)
  --tool <name>           Cooperative lease tool label
  --session <id>          Cooperative lease session label
  --dry-run               Preview verification without running the command
  --json                  Emit verification results
  -h, --help              Show help
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

Discovery, Static Checks & Advisor:
  list            List discovered portable skills across project (.agents/skills) and global dirs
  show            Inspect one skill's metadata, supporting resources, and instructions
  validate        Validate SKILL.md frontmatter, path/symlink/secret safety, and local links
  lint            Run static security and quality lint checks across discovered skills
  suggest         Analyze project signals & goal to rank existing skills, detect gaps, or scaffold drafts

Adaptive Skills Lifecycle (Evidence-Backed & Human-Authorized):
  draft           Draft a quarantined skill in proposals/skills/ from verified EVID/HANDOFF records
  propose-update  Propose an isolated update to an existing trusted skill with diff preview
  keygen          Generate an Ed25519 approver keypair (public key in repo, optional --pub-out external pin, private key external)
  sign            Sign an APPR-NNNN approval bound to content SHA-256, base SHA-256, & evidence
  promote         Promote a validated quarantined proposal after genuine authorization
  history         Inspect append-only revision ledger and snapshot integrity for a skill
  rollback        Restore an authorized verified snapshot revision (never bypasses approval)

Advisor Options ('suggest'):
  --goal <text>           Target goal description to rank existing skills and detect gaps
  --query <text>          Alias for --goal
  --task <TASK-NNNN>      Analyze a specific task's scope and acceptance criteria
  --limit <1..20>         Max existing skills to recommend (default: 5)
  --template <id>         Use a curated starter template (${STARTER_SKILL_CATALOG.map((t) => t.id).join(", ")})
  --scaffold-draft        Stage a quarantined SKILL.md draft under proposals/skills/ (never active)
  --name <skill-slug>     Custom skill slug when used with --scaffold-draft

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
      cache: { type: "boolean" },
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
  const compile = parsed.values.cache ? compileCachedContext : compileContext;
  const result = compile({
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

async function handleAutonomous(args) {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printSubHelp("autonomous");
    return 0;
  }
  const specific = {
    status: {}, on: {}, off: {},
    audit: { event: { type: "string" }, execution: { type: "string" } },
    authorize: { config: { type: "string" }, key: { type: "string" }, "expires-at": { type: "string" } },
    watch: { config: { type: "string" }, approval: { type: "string" }, "owner-key": { type: "string" }, once: { type: "boolean" } },
    progress: { task: { type: "string" } },
    learn: { pattern: { type: "string" }, skill: { type: "string" }, step: { type: "string" } },
  };
  if (!Object.hasOwn(specific, subcommand)) throw new Error("Unknown autonomous subcommand. See autonomous --help.");
  const { values } = parseArgs({
    args: rest,
    options: {
      ...specific[subcommand], project: { type: "string", short: "p" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    printSubHelp("autonomous");
    return 0;
  }

  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const options = { projectDir, harnessDir: HARNESS_DIR };
  let result;
  if (subcommand === "audit") {
    result = auditStagingFailure({ ...options, eventFile: values.event, executionFile: values.execution });
  } else if (subcommand === "status") {
    loadProjectManifestAndState(projectDir, HARNESS_DIR);
    result = { mode: readAutonomousMode(projectDir) };
  } else if (subcommand === "authorize") {
    result = authorizeStagingWorker({ ...options, configFile: values.config, privateKeyPath: values.key,
      expiresAt: values["expires-at"] });
  } else if (subcommand === "watch") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    const signals = ["SIGINT", "SIGTERM"];
    for (const signal of signals) process.on(signal, stop);
    try {
      result = await watchStagingAudits({
        ...options, configFile: values.config, approvalId: values.approval, publicKeyPath: values["owner-key"],
        once: values.once, signal: controller.signal,
        onResult: values.once ? undefined : (outcome) => {
          console.log(values.json ? JSON.stringify(outcome) :
            `${outcome.taskId ?? outcome.file} ${outcome.status}. ${outcome.nextAction}`);
        },
      });
    } finally {
      for (const signal of signals) process.removeListener(signal, stop);
    }
  } else if (subcommand === "progress") {
    loadProjectManifestAndState(projectDir, HARNESS_DIR);
    const progress = readRuntimeJson(projectDir, stagingProgressPath(values.task));
    if (!progress) throw new Error("No staging audit progress found for this task.");
    const stepStatus = (step) => ({ attempts: step.attempts, saved: Boolean(step.result), issue: step.error ?? null });
    const nextAction = progress.nextAction ?? progress.stopReason ?? "Resume the same inbox delivery with the audit worker. Completed steps will be reused.";
    result = {
      taskId: values.task, runs: progress.runs, repairRetries: progress.repairs,
      specialists: progress.specialists.map(stepStatus), reviewer: progress.reviewer && stepStatus(progress.reviewer), nextAction,
    };
  } else if (subcommand === "learn") {
    result = learnFromStagingAudits({ ...options, patternId: values.pattern, skillName: values.skill, step: values.step });
  } else {
    result = { mode: setAutonomousMode({ ...options, enabled: subcommand === "on" }) };
  }

  if (values.json) console.log(JSON.stringify({ projectDir, ...result }, null, 2));
  else if (["status", "on", "off", "audit"].includes(subcommand)) {
    console.log(`Autonomous mode: ${result.mode.toUpperCase()}`);
    if (subcommand === "audit") {
      console.log(`Audit ${result.status}: workflow ${result.workflowId}, execution ${result.executionId}${result.reused ? " (existing task)" : ""}`);
      if (result.taskId) console.log(`Task: ${result.taskId}`);
      if (result.checkpointId) console.log(`Checkpoint: ${result.checkpointId}`);
      if (result.evidenceId) console.log(`Evidence: ${result.evidenceId}`);
      console.log(`Next step: ${result.nextAction}`);
    }
  } else console.log(JSON.stringify(result, null, 2));
  return 0;
}

function handleProposal(args) {
  const [action, ...rest] = args;
  if (!action || ["--help", "-h"].includes(action)) {
    printSubHelp("proposal");
    return 0;
  }
  if (!["preview", "sign", "promote"].includes(action)) throw new Error("Use proposal preview, sign, or promote.");
  const { values } = parseArgs({
    args: rest,
    options: {
      project: { type: "string", short: "p" }, proposal: { type: "string" }, target: { type: "string" },
      evidence: { type: "string", multiple: true }, approval: { type: "string" }, key: { type: "string" },
      "owner-key": { type: "string" }, "expires-at": { type: "string" }, json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    printSubHelp("proposal");
    return 0;
  }
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const result = promoteProjectProposal({
    projectDir, harnessDir: HARNESS_DIR, action, proposal: values.proposal, target: values.target,
    evidenceIds: values.evidence, approvalId: values.approval, privateKeyPath: values.key,
    publicKeyPath: values["owner-key"], expiresAt: values["expires-at"],
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function handleWorktree(args) {
  const [action, ...rest] = args;
  if (!action || ["--help", "-h"].includes(action)) {
    printSubHelp("worktree");
    return 0;
  }
  if (!["list", "add", "remove"].includes(action)) throw new Error("Use worktree list, add, or remove.");
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      project: { type: "string", short: "p" }, workspace: { type: "string" }, ref: { type: "string" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    printSubHelp("worktree");
    return 0;
  }
  if (positionals.length !== (action === "list" ? 0 : 1)) throw new Error("Supply one worktree name for add or remove.");
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const result = manageWorktrees({ projectDir, action, name: positionals[0], workspace: values.workspace, ref: values.ref });
  console.log(JSON.stringify(result, null, 2));
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
  console.log(`Autonomous mode: ${status.autonomousMode.toUpperCase()}`);
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
  console.log(`Autonomous mode    : ${rec.autonomousMode.toUpperCase()}`);
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
        local: { type: "boolean" },
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
      local: parsed.values.local,
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

  if (subcmd === "show" || subcmd === "resume") {
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
    const res = getCheckpoint({ projectDir, checkpointId: targetId, harnessDir: HARNESS_DIR, newest: subcmd === "resume" });
    if (subcmd === "resume") {
      const { state } = loadProjectManifestAndState(projectDir, HARNESS_DIR);
      const advanced = state.state_revision !== res.record.state_revision;
      const unavailable = ["expired", "invalidated"].includes(res.record.status);
      const resume = {
        ...res, stateAdvanced: advanced,
        nextAction: unavailable ? "Use a current checkpoint or run geloforge recommend." : res.record.resume_instructions,
        reason: unavailable ? "This checkpoint is expired or invalidated." : advanced
          ? "Project state differs from the saved checkpoint. Confirm the current task before applying the saved instructions."
          : "The checkpoint matches the current project state revision.",
      };
      if (parsed.values.json) console.log(JSON.stringify(resume, null, 2));
      else console.log(`${res.checkpointId} — ${resume.reason}\n${resume.nextAction}`);
      return 0;
    }
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

  if (subcmd === "compact") {
    return handleCompact(rest);
  }

  throw new Error(`Unknown checkpoint subcommand "${subcmd}". Expected: create, list, show, resume, or compact.`);
}

function handleCompact(args) {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      task: { type: "string", short: "t" },
      query: { type: "string", short: "q" },
      summary: { type: "string" },
      resume: { type: "string" },
      evidence: { type: "string" },
      "created-by": { type: "string" },
      role: { type: "string" },
      status: { type: "string" },
      id: { type: "string" },
      "created-at": { type: "string" },
      profile: { type: "string" },
      budget: { type: "string" },
      "no-map": { type: "boolean", default: false },
      skills: { type: "boolean", default: false },
      "from-diff": { type: "boolean", default: false },
      "exclude-unverified": { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      "dry-run": { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    printSubHelp("compact");
    return 0;
  }
  let budgetNum;
  if (parsed.values.budget !== undefined) {
    if (!/^\d+$/.test(parsed.values.budget.trim())) {
      throw new Error(`Invalid --budget "${parsed.values.budget}". Must be a positive integer.`);
    }
    budgetNum = Number.parseInt(parsed.values.budget.trim(), 10);
  }
  const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
  const res = compactSession({
    projectDir,
    harnessDir: HARNESS_DIR,
    workspaceRoot: WORKSPACE_ROOT,
    taskId: parsed.values.task,
    query: parsed.values.query,
    summary: parsed.values.summary,
    resumeInstructions: parsed.values.resume,
    evidenceRef: parsed.values.evidence,
    createdBy: parsed.values["created-by"],
    role: parsed.values.role,
    status: parsed.values.status,
    id: parsed.values.id,
    createdAt: parsed.values["created-at"],
    profile: parsed.values.profile || "quick",
    budget: budgetNum,
    includeMap: !parsed.values["no-map"],
    includeSkills: parsed.values.skills,
    fromDiff: parsed.values["from-diff"],
    excludeUnverified: parsed.values["exclude-unverified"],
    out: parsed.values.out,
    dryRun: parsed.values["dry-run"],
    local: parsed.values.local,
  });
  if (parsed.values.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(res.dryRun ? `DRY RUN — Session compaction preview (${res.checkpointId})` : `Session compacted: ${res.recordPath}`);
  console.log(`Checkpoint     : ${res.checkpointId} | state_revision=${res.stateRevision} | branch=${res.record.git_branch}`);
  console.log(
    `Resume Packet  : profile=${res.contextPacket.effectiveProfile} (~${res.contextPacket.estimatedTokens} tokens, ${res.contextPacket.includedDocuments} docs included, ${res.contextPacket.omittedDocuments} omitted)`
  );
  if (res.contextPacket.outPath) {
    console.log(`Packet Written : ${res.contextPacket.outPath}`);
  }
  console.log("");
  console.log("Paste this prompt into a fresh AI chat:");
  console.log(`  ${res.freshSessionPrompt}`);
  return 0;
}

async function handleReport(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      task: { type: "string", short: "t" },
      "check-mcp": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      out: { type: "string", short: "o" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printSubHelp("report");
    return 0;
  }
  const timeoutMs = values["timeout-ms"] !== undefined ? parseCheckTimeout(values["timeout-ms"]) : undefined;
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const res = await generateProjectReport({
    projectDir,
    harnessDir: HARNESS_DIR,
    workspaceRoot: WORKSPACE_ROOT,
    taskId: values.task,
    checkMcp: values["check-mcp"],
    timeoutMs,
    out: values.out,
    dryRun: values["dry-run"],
  });
  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(res.markdown.trimEnd());
  if (res.outPath) {
    console.log(`\n${values["dry-run"] ? "DRY RUN — Report not written" : "Report written"}: ${res.outPath}`);
  }
  return 0;
}

function handleMcpInit(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      client: { type: "string", multiple: true },
      "read-only": { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    printSubHelp("mcp");
    return 0;
  }
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const result = initMcpClients({
    projectDir, harnessDir: HARNESS_DIR, clients: values.client,
    readOnly: values["read-only"], dryRun: values["dry-run"],
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.dryRun ? `MCP setup preview for ${projectDir}` : `MCP setup for ${projectDir}`);
    for (const file of result.files) console.log(`  ${file.action.padEnd(10)} ${file.path}`);
  }
  return 0;
}

async function handleMcpLock(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      client: { type: "string", multiple: true },
      check: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printSubHelp("mcp");
    return 0;
  }
  if (values.check && values["dry-run"]) {
    throw new Error("--dry-run only applies when writing .geloforge/mcp-lock.json.");
  }
  const timeoutMs = values["timeout-ms"] !== undefined ? parseCheckTimeout(values["timeout-ms"]) : undefined;
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const result = values.check
    ? await checkMcpLock({ projectDir, harnessDir: HARNESS_DIR, clients: values.client, timeoutMs })
    : await lockMcpServers({
      projectDir,
      harnessDir: HARNESS_DIR,
      clients: values.client,
      timeoutMs,
      dryRun: values["dry-run"],
    });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (values.check) {
    console.log(
      result.passed
        ? `MCP lock verified (${result.checkedCount} stdio server(s)): ${result.lockPath}`
        : `MCP lock check failed (${result.driftedServers.length} drifted, ${result.addedServers.length} added, ${result.removedServers.length} removed, ${result.errors.length} errors)`
    );
  } else {
    console.log(
      `${result.dryRun ? "DRY RUN — " : ""}Pinned ${result.serverCount} stdio MCP server(s) to ${result.lockPath} (${result.skippedCount} non-stdio skipped)`
    );
  }
  return values.check && !result.passed ? 1 : 0;
}

async function handleLoop(args) {
  if (!args.length || args[0] === "-h" || args[0] === "--help") {
    printSubHelp("loop");
    return 0;
  }
  const [subcmd, ...rest] = args;
  if (!["run", "status"].includes(subcmd)) {
    throw new Error(`Unknown loop subcommand "${subcmd}". Expected: run or status.`);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      project: { type: "string", short: "p" },
      config: { type: "string" },
      task: { type: "string", short: "t" },
      tool: { type: "string" },
      session: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printSubHelp("loop");
    return 0;
  }
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  if (subcmd === "status") {
    const res = getCodingLoopStatus({ projectDir, harnessDir: HARNESS_DIR, taskId: values.task });
    if (values.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`${res.taskId} loop status: ${res.status} (rounds=${res.roundsUsed}/${res.maxFixRounds}, attempts=${res.implementAttempts})`);
    return 0;
  }
  if (!values.config) {
    throw new Error("Missing required --config <relpath> for 'geloforge loop run'.");
  }
  const res = await runCodingLoop({
    projectDir,
    harnessDir: HARNESS_DIR,
    configFile: values.config,
    taskId: values.task,
    tool: values.tool,
    sessionId: values.session,
    dryRun: values["dry-run"],
  });
  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
  } else if (res.status === "dry_run") {
    console.log(`DRY RUN — Loop ready for ${res.taskId} (maxFixRounds=${res.maxFixRounds}, verify=${res.verifyCommand.join(" ")})`);
  } else if (res.status === "completed") {
    console.log(`${res.taskId} completed (${res.evidenceId}, ${res.checkpointId}) in ${res.roundsUsed} fix round(s)`);
  } else {
    console.error(`${res.taskId} blocked (${res.reason}, ${res.checkpointId})`);
  }
  return ["completed", "dry_run"].includes(res.status) ? 0 : 1;
}

async function handleMcp(args) {
  if (args[0] === "init") return handleMcpInit(args.slice(1));
  if (args[0] === "lock") return handleMcpLock(args.slice(1));
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
      "read-only": { type: "boolean", default: false },
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
  await startMcpStdioServer({
    defaultProjectDir,
    harnessDir: HARNESS_DIR,
    readOnly: parsed.values["read-only"],
  });
  return 0;
}

function handleHandoff(args) {
  const parsed = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      inspect: { type: "string" },
      file: { type: "string", multiple: true },
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
    artifactsProduced: (parsed.values.file || []).map(path => ({ path, track: true })),
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
        evidence: { type: "string", multiple: true },
        "require-evidence": { type: "boolean", default: false },
        tool: { type: "string" },
        session: { type: "string" },
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
      throw new Error(`Missing task ID for 'geloforge task ${subcmd} <TASK-NNNN>'.`);
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res =
      subcmd === "done"
        ? completeTask({
            projectDir,
            harnessDir: HARNESS_DIR,
            taskId: targetId,
            evidenceRefs: parsed.values.evidence,
            requireEvidence: parsed.values["require-evidence"],
            tool: parsed.values.tool,
            sessionId: parsed.values.session,
            force: parsed.values.force,
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
            evidenceRefs: parsed.values.evidence,
            requireEvidence: parsed.values["require-evidence"],
            tool: parsed.values.tool,
            sessionId: parsed.values.session,
            force: parsed.values.force,
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
    if (res.status === "completed") {
      const evLabel =
        (res.verifiedEvidenceRefs || []).length > 0 ? res.verifiedEvidenceRefs.join(", ") : "no verified EVID-* check";
      console.log(`Verification : ${res.verificationStatus} (${evLabel})`);
    }
    for (const w of res.warnings || []) console.log(`  - [WARN] ${w}`);
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
        tool: { type: "string" },
        session: { type: "string" },
        role: { type: "string" },
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
      throw new Error("Missing task ID for 'geloforge task release <TASK-NNNN>'.");
    }
    const { projectDir } = resolveProjectDir({ project: parsed.values.project, harnessDir: HARNESS_DIR });
    const res = releaseTaskLease({
      projectDir,
      harnessDir: HARNESS_DIR,
      taskId: targetId,
      tool: parsed.values.tool,
      sessionId: parsed.values.session,
      role: parsed.values.role,
      force: parsed.values.force,
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

function splitCheckArguments(args) {
  const dash = args.indexOf("--");
  return dash === -1 ? { options: args, command: [] } : { options: args.slice(0, dash), command: args.slice(dash + 1) };
}

function parseCheckTimeout(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error(`Invalid --timeout "${value}". Must be a positive integer.`);
  return Number.parseInt(value.trim(), 10);
}

function handleResume(args) {
  const { values } = parseArgs({ args, options: {
    project: { type: "string" }, task: { type: "string" }, help: { type: "boolean", short: "h" }
  } });
  if (values.help) {
    console.log("geloforge resume [--project <dir>] [--task TASK-NNNN]");
    return 0;
  }
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const active = listTasks({ projectDir }).tasks.filter(task => task.activeInState);
  if (!values.task && active.length !== 1) {
    console.log(active.length ? "Choose a task with resume --task:" : "No active task. Use task list or resume --task.");
    for (const task of active) console.log(task.id, task.title);
    return 0;
  }
  const task = getTask({ projectDir, taskId: values.task || active[0].id });
  const handoff = latestTaskHandoff(projectDir, HARNESS_DIR, task.id);
  const record = handoff?.record;
  const { projectPaths } = loadProjectManifestAndState(projectDir);
  const receipt = scanEvidenceManifests(projectDir, projectPaths.evidence_dir)
    .filter(e => e.taskId === task.id).at(-1);
  console.log("Goal:", task.id, task.record.title);
  console.log("Last step:", record?.completed_items.at(-1) || record?.summary || "No handoff recorded");
  console.log("Files:", record?.artifacts_produced.map(f => f.path).join(", ") || "None recorded");
  console.log("Last check:", receipt?.checks.map(c => c.command + " — " + c.result).join(", ") || "No recorded run");
  if (receipt) console.log("Checked files:", receipt.files.map(f => f.path + " " + f.state).join(", ") || "freshness unknown");
  for (const warning of handoff?.warnings || []) console.log("Warning:", warning);
  console.log("Next:", record?.recommended_next_action || `geloforge context --task ${task.id}`);
  return 0;
}

function handleVerify(args) {
  const { options, command } = splitCheckArguments(args);
  const { values } = parseArgs({
    args: options,
    options: {
      project: { type: "string", short: "p" },
      file: { type: "string", multiple: true },
      task: { type: "string", short: "t" },
      name: { type: "string" },
      timeout: { type: "string" },
      tool: { type: "string" },
      session: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (!args.length || values.help) {
    printSubHelp("verify");
    return 0;
  }
  if (!command.length) throw new Error('Pass a command after "--". Example: geloforge verify -- node --test');
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const result = verifyTask({
    projectDir, harnessDir: HARNESS_DIR, taskId: values.task, commandArgv: command,
    artifactPaths: values.file, name: values.name, timeoutMs: parseCheckTimeout(values.timeout),
    tool: values.tool, sessionId: values.session, dryRun: values["dry-run"],
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === "dry_run") {
    console.log(`Would check ${result.taskId} with ${result.evidence.command}`);
  } else {
    console.log(`${result.evidence.id} ${result.evidence.status} for ${result.taskId}`);
    if (result.checkpoint) console.log(`${result.checkpoint.checkpointId} saved`);
    if (result.completion) {
      console.log(`${result.taskId} completed with verified evidence`);
      for (const warning of result.completion.warnings) console.log(`  [WARN] ${warning}`);
    } else {
      console.error(result.error || result.evidence.record.checks[0].summary);
    }
  }
  return ["completed", "dry_run"].includes(result.status) ? 0 : 1;
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

  const { options, command } = splitCheckArguments(rest);

  const parsed = parseArgs({
    args: options,
    options: {
      project: { type: "string", short: "p" },
      task: { type: "string", short: "t" },
      name: { type: "string" },
      title: { type: "string" },
      id: { type: "string" },
      role: { type: "string" },
      "verified-by": { type: "string" },
      timeout: { type: "string" },
      file: { type: "string", multiple: true },
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
    timeoutMs: parseCheckTimeout(parsed.values.timeout),
    artifactPaths: parsed.values.file,
    linkTask: !parsed.values["no-link"],
    createdAt: parsed.values["created-at"],
    dryRun: parsed.values["dry-run"],
    commandArgv: command,
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

async function handleSkillsSuggest(rest) {
  const parsed = parseArgs({
    args: rest,
    options: {
      project: { type: "string", short: "p" },
      task: { type: "string" },
      goal: { type: "string" },
      query: { type: "string" },
      "global-dir": { type: "string" },
      "include-drafts": { type: "boolean", default: false },
      limit: { type: "string" },
      template: { type: "string" },
      "scaffold-draft": { type: "boolean", default: false },
      name: { type: "string" },
      "dry-run": { type: "boolean", default: false },
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
  let limit;
  if (parsed.values.limit !== undefined) {
    if (!/^\d+$/.test(parsed.values.limit.trim())) {
      throw new Error("--limit must be a positive integer (1..20).");
    }
    limit = Number(parsed.values.limit.trim());
  }
  const scaffoldDraft = Boolean(parsed.values["scaffold-draft"]);
  if (parsed.values.name && !scaffoldDraft) {
    throw new Error("--name is only supported with '--scaffold-draft' on 'geloforge skills suggest'.");
  }
  if (parsed.values["dry-run"] && !scaffoldDraft) {
    throw new Error("--dry-run is only supported with '--scaffold-draft' on 'geloforge skills suggest'.");
  }

  const loc = resolveProjectForSkills({
    project: parsed.values.project,
    harnessDir: HARNESS_DIR,
  });
  if (!loc.projectDir) {
    throw new Error("'geloforge skills suggest' requires a GeloForge project directory (--project <path> or inside a project).");
  }

  const res = suggestProjectSkills({
    projectDir: loc.projectDir,
    harnessDir: HARNESS_DIR,
    globalSkillsDir: parsed.values["global-dir"],
    taskId: parsed.values.task || null,
    goal: parsed.values.goal || null,
    query: parsed.values.query || null,
    includeDrafts: Boolean(parsed.values["include-drafts"]),
    limit,
    templateId: parsed.values.template || null,
    scaffoldDraft,
    skillName: parsed.values.name || null,
    dryRun: Boolean(parsed.values["dry-run"]),
    createdAt: parsed.values["created-at"],
  });

  if (parsed.values.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }

  console.log(`Skills Advisor : ${res.projectDir} (${res.projectId || "project"})`);
  if (res.goal) console.log(`Goal           : ${res.goal}`);
  if (res.taskId) console.log(`Task           : ${res.taskId}`);
  console.log(`Detected Stack : ${res.detectedSignals.stacks.join(", ") || "(none)"}`);
  console.log(
    `Repo Commands  : ${res.detectedSignals.commands.map((c) => c.command).join(" | ") || "(none detected)"}`
  );
  console.log(
    `Skill Pool     : ${res.activeSkillCount} active | ${res.quarantinedDraftCount} quarantined draft(s) | ${res.detectedSignals.verifiedEvidenceIds.length} verified EVID-*`
  );
  console.log("");
  console.log("Recommended Existing Skills:");
  if (res.recommendedSkills.length === 0) {
    console.log("  (no matching active skills discovered for this project/goal)");
  } else {
    for (const item of res.recommendedSkills) {
      console.log(`  - ${item.name} [${item.source}, score=${item.score}] — ${item.reasons.join("; ")}`);
      console.log(`      Use: ${item.command}`);
    }
  }
  console.log("");
  console.log("Detected Skill Gaps:");
  if (res.skillGaps.length === 0) {
    console.log("  (none detected)");
  } else {
    for (const gap of res.skillGaps) {
      const draftTag = gap.existingQuarantinedDraft ? " [quarantined draft exists]" : "";
      const promoTag = gap.promotableAfterReview
        ? "evidence-backed (promotable after review)"
        : "repo/goal scaffold (needs EVID-* before promotion)";
      console.log(`  - [${gap.kind}] ${gap.suggestedName}${draftTag} — ${promoTag}`);
      console.log(`      Reason : ${gap.reason}`);
      console.log(`      Action : ${gap.recommendedCommand}`);
    }
  }
  if (Array.isArray(res.starterCatalog) && res.starterCatalog.length > 0) {
    console.log("");
    console.log("Starter Skill Templates:");
    for (const tpl of res.starterCatalog.slice(0, 3)) {
      const stateTag = tpl.alreadyActive
        ? " [active]"
        : tpl.alreadyQuarantined
          ? " [quarantined draft exists]"
          : "";
      console.log(`  - ${tpl.id} (score=${tpl.score})${stateTag} — ${tpl.description}`);
      console.log(`      Stage: ${tpl.scaffoldCommand}`);
    }
  }
  if (res.scaffoldResult) {
    const sr = res.scaffoldResult;
    console.log("");
    console.log(
      sr.dryRun
        ? `DRY RUN — Quarantined scaffold "${sr.skillName}" (${sr.mode}) not written.`
        : `Quarantined draft created (${sr.mode}): ${sr.proposalDir}/SKILL.md`
    );
    console.log(`Candidate SHA  : ${sr.candidateDigest}`);
    console.log(
      `Promotable Now : ${sr.promotable ? "yes (after human approval/signature)" : "no (capture verified EVID-* first)"}`
    );
    for (const step of sr.nextSteps || []) {
      console.log(`  - Next: ${step}`);
    }
  }
  return 0;
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
  if (subcmd === "suggest") {
    return handleSkillsSuggest(rest);
  }
  if (!["list", "show", "validate", "lint"].includes(subcmd)) {
    throw new Error(
      `Unknown skills subcommand "${subcmd}". Expected: list, show, validate, lint, suggest, draft, propose-update, keygen, sign, promote, history, or rollback.`
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

async function handleDoctor(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string", short: "p" },
      "global-dir": { type: "string" },
      "include-drafts": { type: "boolean", default: false },
      "skip-mcp-check": { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printSubHelp("doctor");
    return 0;
  }
  const timeoutMs = values["timeout-ms"] !== undefined ? parseCheckTimeout(values["timeout-ms"]) : undefined;
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const res = await runProjectDoctor({
    projectDir,
    harnessDir: HARNESS_DIR,
    globalSkillsDir: values["global-dir"],
    includeDrafts: values["include-drafts"],
    checkMcp: !values["skip-mcp-check"],
    timeoutMs,
  });
  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.healthy ? 0 : 1;
  }
  console.log(`GeloForge Doctor : ${res.projectDir} (${res.projectId || "project"}) | harness v${res.harnessVersion}`);
  console.log(`Health Status    : ${res.healthy ? "HEALTHY" : "ISSUES FOUND"} (pass=${res.counts.pass} | warn=${res.counts.warn} | fail=${res.counts.fail})`);
  console.log("");
  for (const chk of res.checks) {
    const tag = chk.status === "pass" ? "[PASS]" : chk.status === "warn" ? "[WARN]" : "[FAIL]";
    console.log(`  ${tag} ${chk.id}: ${chk.summary}`);
    for (const d of chk.details || []) {
      console.log(`      - ${d}`);
    }
    if (chk.fix) {
      console.log(`      Fix: ${chk.fix}`);
    }
  }
  if (res.nextActions.length > 0) {
    console.log("");
    console.log("Recommended Next Actions:");
    for (const cmd of res.nextActions) {
      console.log(`  - ${cmd}`);
    }
  }
  return res.healthy ? 0 : 1;
}

function handleHooks(args) {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printSubHelp("hooks");
    return 0;
  }
  const [subcmd, ...rest] = args;
  if (subcmd !== "init") {
    throw new Error(`Unknown hooks subcommand "${subcmd}". Expected: init.`);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      project: { type: "string", short: "p" },
      target: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    printSubHelp("hooks");
    return 0;
  }
  const { projectDir } = resolveProjectDir({ project: values.project, harnessDir: HARNESS_DIR });
  const res = initProjectHooks({
    projectDir,
    harnessDir: HARNESS_DIR,
    targets: values.target?.length ? values.target : HOOK_TARGETS,
    dryRun: values["dry-run"],
  });
  if (values.json) {
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.log(res.dryRun ? `Hooks setup preview for ${res.projectDir}` : `Hooks setup for ${res.projectDir}`);
  for (const file of res.files) {
    const extra = file.reason ? ` (${file.reason})` : "";
    console.log(`  ${file.target.padEnd(7)} ${file.action.padEnd(10)} ${file.path}${extra}`);
  }
  return 0;
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
      case "demo":
        code = runDemo(rest);
        break;
      case "resume":
        code = handleResume(rest);
        break;
      case "verify":
        code = handleVerify(rest);
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
      case "compact":
        code = handleCompact(rest);
        break;
      case "report":
        code = await handleReport(rest);
        break;
      case "recommend":
        code = handleRecommend(rest);
        break;
      case "doctor":
        code = await handleDoctor(rest);
        break;
      case "hooks":
        code = handleHooks(rest);
        break;
      case "autonomous":
        code = await handleAutonomous(rest);
        break;
      case "loop":
        code = await handleLoop(rest);
        break;
      case "proposal":
        code = handleProposal(rest);
        break;
      case "worktree":
        code = handleWorktree(rest);
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

// npm links the executable through node_modules/.bin on POSIX.
const entryPath = process.argv[1];
const isDirectRun = entryPath && fs.existsSync(entryPath) &&
  fs.realpathSync(entryPath) === fs.realpathSync(__filename);
if (isDirectRun) {
  await main();
}
