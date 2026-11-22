# GeloForge — Detailed CLI & Technical Guide

[← Project overview and quick start](../README.md)

This is the in-depth reference previously presented on the repository homepage. Beginners can start with the [5-minute quickstart](./quickstart-5min.md); the sections below document flags, workflows, budgets, and limitations for advanced users.

---

**Build with AI coding assistants without losing context, decisions, or verification truth.**

**Version:** `0.9.1` | **License:** [MIT](../LICENSE)

GeloForge is a zero-dependency, provider-neutral toolkit for organizing projects, managing project memory, compiling bounded prompt context, mapping source symbols, pinning MCP tool surfaces, recommending/quarantining skills, running bounded coding loops, and handing off verified work across coding sessions or different AI assistants.

It stores persistent project memory in plain Markdown and YAML inside your project's own repository (**Second Brain**) so you are never locked into one AI tool or chat history.

---

## 1. What GeloForge Does Today

- **Unified CLI ([scripts/geloforge.mjs](../scripts/geloforge.mjs)):** Non-interactive `geloforge` commands (`init`, `adopt`, `task`, `evidence`, `verify`, `validate`, `context`, `skills`, `handoff`, `checkpoint`, `recommend`, `autonomous`, `loop`, `proposal`, `worktree`, `status`, `doctor`, `hooks`, `mcp`) with CWD project auto-discovery, `--json` output, and atomic `--out` writes.
- **Brownfield Adoption & Greenfield Scaffolding (`adopt`, `init`):** Safely onboard existing repos with `geloforge adopt` without altering existing source files ([adopt-project.mjs](../core/adopt-project.mjs)), or initialize new Second Brain repos ([templates/project-starter/](../templates/project-starter/README.md)) with domain overlays (`web`, `desktop`, `mobile`, `automation`, `ai-system`).
- **Task Contracts & Command-Backed Evidence (`task`, `evidence`, `verify`):** Manage schema-strict `TASK-NNNN` contracts ([task-manager.mjs](../core/task-manager.mjs)) and capture real `EVID-NNNN` records via `geloforge evidence capture -- <cmd>` or `geloforge verify` with `shell: false`, secret redaction, and explicit pass/fail/timeout accuracy ([evidence-capture.mjs](../core/evidence-capture.mjs)).
- **Portable Agent Skills & Advisor (`skills`, `context --skills`):** Discover, analyze/recommend (`skills suggest` + quarantined `--scaffold-draft`), validate, and statically security-lint [agentskills.io](https://agentskills.io)-compatible `SKILL.md` packages in `.agents/skills/` and `~/.geloforge/skills/` (`GELOFORGE_SKILLS_DIR`) with progressive disclosure (`Tier 0` index -> `Tier 1` relevant skills -> `Tier 2` support paths), quarantine for `proposals/skills/`, and evidence-backed drafting, update proposals, Ed25519/PR-branch/TTY-authorized promotion, content-addressed history, and rollback ([skills.mjs](../core/skills.mjs), [skills-advisor.mjs](../core/skills-advisor.mjs), [skills-lint.mjs](../core/skills-lint.mjs), [skills-lifecycle.mjs](../core/skills-lifecycle.mjs), [Portable Skills Guide](../docs/portable-skills.md), [Example Skill](../examples/skills/evidence-backed-bugfix/SKILL.md)).
- **Deterministic Context Compiler (`context`):** Assembles edge-anchored 3-zone, trust-tiered `L4` Markdown packets + `CPACK-0001` JSON manifests ranked with Contextual BM25 (including Markdown headings), explicit `budget_breakdown`, `--exclude-unverified`, open-conflict surfacing, selective `--skills`, and verified `A0` safety preservation ([context-compiler.mjs](../core/context-compiler.mjs)).
- **Selective Codebase Mapping (`context --map`):** Extracts deterministic multi-language symbol outlines, local import boost, and `L<line>` references within `--map-budget`, respecting `.gitignore` and excluding `.env*`, keys, binaries, and build outputs ([codebase-map.mjs](../core/codebase-map.mjs)).
- **Cross-Agent File-Based Handoffs (`handoff`):** Generates and cross-validates (`--inspect`) schema-strict `HANDOFF-NNNN` transfers that separate audited `verified_evidence` (`EVID-*`) from `unverified_claims`, surface `contradiction_warnings`, and capture project-scoped Git state/drift ([handoff.mjs](../core/handoff.mjs)).
- **Strict Validation, Diagnostics & Ambient Hooks (`validate`, `status`, `doctor`, `hooks`):** Checks 12 JSON Schemas ([schemas/](../schemas/README.md)), `1.0`/`1.1` compatibility ([compatibility.mjs](../core/compatibility.mjs)), duplicate IDs, cross-record references, symlink safety, forged evidence entries, MCP lock drift, relative Markdown links, one-command diagnostics (`doctor`), opt-in ambient hooks (`hooks init`), and actionable `nextSteps` ([project-validator.mjs](../core/project-validator.mjs)).
- **MCP Server, Tool Pinning & Bounded Workflows (`mcp`, `loop`, `autonomous`, `proposal`, `worktree`):** Zero-dependency stdio MCP server + client installer (`mcp init`) + SHA-256 tool pinning (`mcp lock`), capped coding loops (`loop run`), opt-in staging audits (`autonomous`), Ed25519 canonical proposal promotion (`proposal`), and isolated Git worktrees (`worktree`).

---

## 2. Requirements & Installation

- **Node.js `>= 20.0.0`** (uses built-in Node modules only — **zero third-party `npm install` packages and zero paid APIs**).
- **Git** (used for `.gitignore`-aware mapping, Git state/drift tracking, and optional `--git` project creation).
- **Tested Platforms:** Automated tests verified across **Linux (`ubuntu-latest`)**, **macOS (`macos-latest`)**, and **Windows (`windows-latest`)** on **Node.js 20 and 22** via [.github/workflows/ci.yml](../.github/workflows/ci.yml), plus local Windows 11 verification (`Node.js v24.21.0`).

Clone the repository and run the full test suite:

```bash
git clone https://github.com/63L0/GeloForge.git
cd GeloForge
npm test
```

Run commands directly via `node scripts/geloforge.mjs <command>`, `npm run geloforge -- <command>`, or link globally from the repo root with `npm link` to invoke `geloforge` directly.

---

## 3. How to Start a Project (Existing or New)

See the standalone [5-Minute Quickstart](../docs/quickstart-5min.md) for the shortest onboarding flow inside any existing repository:

```bash
# Onboard an existing repo non-destructively (run from repo root)
geloforge adopt --dry-run
geloforge adopt --profile web

# Create an isolated new project with its own Git repo
node scripts/geloforge.mjs init --name "My Web App" --profile web --dest ../projects/my-web-app --git

# From inside any project directory or nested subdirectory (--project is auto-detected):
geloforge status
geloforge task new --title "Verify auth flow" --activate
geloforge evidence capture --task TASK-0001 --name "Unit tests" -- node --test
```

Available overlays under [templates/profiles/](../templates/profiles/README.md): `web`, `desktop`, `mobile`, `automation`, and `ai-system`. See [docs/new-projects.md](../docs/new-projects.md) for all initialization flags (`--slug`, `--owner`, `--description`, `--created-at`).

---

## 4. How to Use the Context Compiler

Compile a deterministic, trust-tiered context packet for a task (`TASK-NNNN`) or ad-hoc description (`--query`):

```bash
# Task-targeted packet with default working (~8,000 est. tokens) budget
node scripts/geloforge.mjs context --project ../projects/my-web-app --task TASK-0001

# Strict trust mode: omit A5-A6 external research, unverified skills & drafts completely
node scripts/geloforge.mjs context --project ../projects/my-web-app --task TASK-0001 --exclude-unverified

# Include portable skills with progressive disclosure (Tier 0/1/2)
node scripts/geloforge.mjs context --project ../projects/my-web-app --task TASK-0001 --skills --skills-budget 1200

# Inspect and lint project or global skills (.agents/skills & ~/.geloforge/skills)
node scripts/geloforge.mjs skills list --project ../projects/my-web-app
node scripts/geloforge.mjs skills lint --project ../projects/my-web-app --strict

# Save Markdown atomically to a file outside protected directories
node scripts/geloforge.mjs context --project ../projects/my-web-app --query "checkout pricing" --profile deep --out ../packets/task-context.md
```

- **Budget Profiles & Minimum Floors:** `quick` targets `~4,000`, `working` targets `~8,000`, and `deep` targets `~16,000` estimated tokens (`Math.ceil(utf8_bytes / 4)` — heuristic, not vendor tokenizer exact). Untouched starter repos fit inside `quick` (`~4,000`), while mandatory `A0` safety policies, constraints, active task contracts, and open `CONF-NNNN` conflicts are **never silently truncated**; if mandatory or direct-linked content exceeds a target, `budget_overrun: true` and `budget_breakdown` report actual sizes honestly alongside `effective_profile`.
- **Prompt-Injection Boundary Note:** Packet sections separate authoritative decisions (`A1`–`A2`) from unverified records (`A5`–`A6`, drafts) and escape spoofed document markers (`<<<ESCAPED_END_GELOFORGE_DOC>>>` / `<<<ESCAPED_GELOFORGE_DOC`). However, **document markers alone cannot prevent persuasive text inside untrusted files or source comments from influencing an AI model**. Use `--exclude-unverified` when strict trust isolation is needed. Details: [context-compiler-spec.md](../context/context-compiler-spec.md).

---

## 5. How to Use Codebase Mapping

Add `--map` to include a compact structural outline of the most relevant source files without dumping the entire repository:

```bash
# Include mapped source symbols with an explicit map budget
node scripts/geloforge.mjs context --project ../projects/my-web-app --task TASK-0001 --map --map-budget 1000

# Inspect full machine-readable manifest, selection reasons, and budget breakdown
node scripts/geloforge.mjs context --project ../projects/my-web-app --task TASK-0001 --map --json
```

- Respects `.gitignore` rules via `git ls-files` (when project root is a Git repo) or `.gitignore`-aware fallback walks, hard-blocking `.env*`, `secrets/`, private keys, credentials, binaries, lockfiles, `node_modules/`, `dist/`, `obj/`, and `bin/Debug`/`bin/Release`.
- Extracts outline signatures with `L<line>` pointers for JavaScript/TypeScript, Python, Go, Rust, Java, C#, Kotlin, C/C++, Shell, SQL, Markdown, JSON, YAML, and TOML, and degrades cleanly to summary mode for unsupported extensions.
- Pre-ranks path relevance on repositories larger than `maxScannedFiles` (`500` default) and boosts files imported by high-priority task inputs, omitting files already included verbatim via `TASK.required_inputs`.

---

## 6. How to Generate and Inspect a Handoff

Transfer verified state between coding sessions, agent roles, or AI tools without inventing test results:

```bash
# Create a structured handoff record in handoffs/HANDOFF-0001-*.yaml
node scripts/geloforge.mjs handoff \
  --project ../projects/my-web-app \
  --task TASK-0001 \
  --from-role developer --to-role qa-security-reviewer \
  --from-tool codex --to-tool gemini-cli \
  --completed "Implemented integer cents pricing API" \
  --open "Run staging rate-limit verification" \
  --claim "Local load smoke ran cleanly" \
  --next-action "Verify EVID-0001 and resolve open conflicts before merge."

# Validate and inspect a handoff from another session or tool (detects Git HEAD drift & forged evidence)
node scripts/geloforge.mjs handoff --project ../projects/my-web-app --inspect handoffs/HANDOFF-0001-task-0001.yaml
```

- `verified_evidence` is populated **only** from audited `evidence/EVID-*.yaml` files with `status: "verified"`, at least one `"passed"` check, zero `"failed"`/`"blocked"` checks, and `is_example !== true`.
- Unbacked test/build assertions passed in `--completed` or `--claim` remain inside `unverified_claims` and trigger explicit `contradiction_warnings`.

---

## 7. Working with One AI Agent or Switching Between Agents

GeloForge works identically whether you use a single coding assistant across sessions or hand work between multiple tools (such as Codex, Gemini CLI, Google Antigravity, or Claude Code):

- **Single Agent (Session-to-Session Resume):**
  1. Run `geloforge context --project <dir> --task TASK-0001 --map` and supply the packet to your assistant.
  2. Have your assistant implement changes and run real project tests; record the verified test results in `evidence/EVID-NNNN-*.yaml`.
  3. Close the session with `geloforge handoff --project <dir> --task TASK-0001 --from-role developer --to-role developer ...`.
  4. In the next session, run `geloforge handoff --inspect` + `geloforge context --task TASK-0001 --map`.
- **Switching Between Different AI Agents:**
  1. Agent A finishes its work and writes a `HANDOFF-NNNN` record specifying `--from-tool <toolA> --to-tool <toolB>` alongside current Git `HEAD` and dirty files.
  2. Agent B runs `geloforge validate` and `geloforge handoff --inspect` to verify schema truth, detect Git drift, distinguish verified `EVID-*` from `unverified_claims`, and compile its own fresh `geloforge context` packet from the shared Second Brain.

---

## 8. Owner Review

Owner review is required for canonical document changes, skill promotion and rollback, and release decisions. Use the signed gates in [Canonical proposal promotion](#canonical-proposal-promotion) and [Portable Skills](./portable-skills.md). For a repair task, use `geloforge verify --task TASK-NNNN -- <test-command>` and check what the command actually verified.

See [Known Limitations](./known-limitations.md) for runner and evidence boundaries.

---

## 9. Validation, Benchmarks, and Updates

```bash
# Run GeloForge's full zero-dependency test suite
npm test

# Validate a project's Second Brain, symlinks, references, and handoff authenticity
node scripts/geloforge.mjs validate --project ../projects/my-web-app

# Run deterministic size/recall/latency benchmarks on synthetic repositories
npm run benchmark
```

- **Benchmark Caveat:** `npm run benchmark` evaluates deterministic document recall, `.gitignore`/secret exclusions, byte/token estimates, latency, and heap/RSS deltas on synthetic repositories. **It does not measure live LLM task accuracy or vendor API billing.**
- **Updating GeloForge:** Inspect [CHANGELOG.md](../CHANGELOG.md), [core/compatibility.json](../core/compatibility.json), and [docs/versioning-and-upgrades.md](../docs/versioning-and-upgrades.md). Validate existing projects (`1.0` and `1.1` schemas remain supported).

---

## 10. Error Recovery, Security, Attribution, and License

- **Recovery:** Project scaffolding (`bootstrap-project.mjs`) stages into `.harness-stage-*` and CLI `--out` / handoff writes use `.geloforge-tmp-*` atomic temp-file renames without overwriting existing targets unless `--out` explicitly targets a safe non-handoff file. Use standard Git recovery (`git status`, `git diff`, `git revert <commit>`) for repository rollbacks.
- **Security & Limitations:** See [SECURITY.md](../SECURITY.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and [docs/known-limitations.md](../docs/known-limitations.md).
- **Third-Party Research Attribution:** Architectural patterns in v0.3 and v0.4 were informed by public open-source tools documented in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and [docs/research/upstream-patterns-v0.3.md](../docs/research/upstream-patterns-v0.3.md) (NousResearch Hermes Agent `[MIT]`, `agentskills.io`, GitHub Spec Kit `[MIT]`, BMad Method `[MIT]`, OpenHands `[MIT]`, and Aider `[Apache-2.0]` concepts re-implemented cleanly in original zero-dependency Node.js without copying external source files).
- **License & Distribution:** Released under the [MIT License](../LICENSE) (`Copyright (c) 2026 63L0`) and published publicly to npm (`npx geloforge`) with zero external runtime dependencies.

## v0.5 Human-in-the-Loop Co-Pilot, Anti-Context-Rot & Multi-IDE Coordination

GeloForge v0.5 adds practical Co-Pilot coordination and short-session workflows without changing Second Brain determinism or security boundaries:

### 1. Human-in-the-Loop Approval Inbox & Recommendations
```bash
node scripts/geloforge.mjs recommend
node scripts/geloforge.mjs recommend --json
```
- Scans pending skill drafts/updates (`proposals/skills/.proposals/*.yaml`), pending `APPR-*.yaml` records, proposed `ADR-*.md` frontmatter, open `CONF-*` conflicts, and overlapping multi-IDE leases.
- Ranks recommended next actions with explicit trade-off options while preserving human authorization gates.

### 2. Task Completion, Reactivation & Multi-IDE Cooperative Leases
```bash
# Mark a task completed (records verificationStatus="unverified" unless verified EVID-* exists; pass --require-evidence to enforce)
node scripts/geloforge.mjs task done --task TASK-0001
node scripts/geloforge.mjs task done --task TASK-0001 --require-evidence --evidence EVID-0001 --tool gemini-ide

# Update/reactivate a task cleanly
node scripts/geloforge.mjs task update --task TASK-0001 --status active --activate

# Claim/release a cooperative lease across IDEs/tools (serialized via .geloforge/.state.lock; tool/session are advisory labels)
node scripts/geloforge.mjs task claim --task TASK-0002 --tool gemini-ide --role developer --scope "src/auth" --ttl 120
node scripts/geloforge.mjs task leases
node scripts/geloforge.mjs task release --task TASK-0002 --tool gemini-ide
```
Active peer leases are automatically surfaced inside compiled `context` packets as an operational collision guard. Releasing or completing another session's active lease requires matching `--tool` / `--session` confirmation (or explicit `--force`).

### 3. Anti-Context-Rot Context Compilation & Checkpoints
```bash
# Focus context on current Git diff changes (completed tasks pruned automatically)
node scripts/geloforge.mjs context --from-diff --map --profile quick

# Include historical completed tasks only when explicitly needed
node scripts/geloforge.mjs context --query "billing" --include-completed

# Save/inspect a schema-valid CHKPT-NNNN session checkpoint before rotating sessions
node scripts/geloforge.mjs checkpoint create --summary "Core auth verified; ready for QA review"
node scripts/geloforge.mjs checkpoint list
node scripts/geloforge.mjs checkpoint show CHKPT-0001
```
See [schemas/recovery-checkpoint.schema.json](../schemas/recovery-checkpoint.schema.json) for checkpoint fields and [SECURITY.md](../SECURITY.md) for boundaries.

### 4. Zero-Dependency MCP Server (`geloforge mcp`)

From an adopted project, run `geloforge mcp init --dry-run` to preview setup, then run `geloforge mcp init` to configure the four default project clients (`cursor`, `vscode`, `claude`, `gemini`), or add `--client antigravity` for Antigravity. Repeat `--client <name>` to select specific clients. Add `--read-only` to set up read-only servers and guidance.

| Client | MCP config | Project instructions |
| --- | --- | --- |
| `cursor` | `.cursor/mcp.json` | `.cursor/rules/geloforge.mdc` |
| `vscode` | `.vscode/mcp.json` | `.github/instructions/geloforge.instructions.md` |
| `claude` | `.mcp.json` | `.claude/rules/geloforge.md` |
| `gemini` | `.gemini/settings.json` | `GEMINI.md` or the configured project context file |
| `antigravity` | `.agents/mcp_config.json` | `AGENTS.md` |

The setup keeps other server entries and settings, adds a GeloForge rule for each client, and pins the server to the project root. Reload the client and accept its project trust or MCP prompt if shown. Rerun setup after moving a checkout or changing the CLI installation path.
```bash
# Default project-pinned server (supports read + disclosed state-mutating tools)
node scripts/geloforge.mjs mcp --project /path/to/your/project

# Read-only mode (refuses all state-mutating actions)
node scripts/geloforge.mjs mcp --project /path/to/your/project --read-only
```
Supports JSON-RPC 2.0 stdin/stdout (`\n`-delimited JSON or `Content-Length:` LSP framing bounded to 1 MB messages / 4 KB headers) and confines calls to the pinned project root (failing closed if launched outside a recognized project without `--project`):
- **Read-only tools:** `geloforge_status`, `geloforge_recommend`, `geloforge_context`, plus read actions (`list`/`show`/`leases`/`validate`/`lint`/`history`) on `geloforge_task`, `geloforge_checkpoint`, and `geloforge_skills`.
- **State-mutating tools (disabled under `--read-only`):** `geloforge_task` (`new`, `update`, `done`, `claim`, `release`), `geloforge_checkpoint` (`create`), and quarantined `geloforge_skills` (`draft`, `propose`).
- **Strictly refused over MCP:** `geloforge_skills` `promote`, `rollback`, `keygen`, and `sign` so human authorization remains under local CLI / Git control.

## Autonomous Mode staging pilot

Use the GeloForge source checkout or a package built from it and a separate, adopted staging project. Autonomous Mode defaults to OFF for each project. A staging delivery starts an audit automatically while its worker is running.

### Configure the worker

1. Install and authenticate one of the [supported provider CLIs](../adapters/README.md) on the staging worker host. Run it under a dedicated OS account or container with staging inputs, staging-only credentials, and access limited to the selected provider. Keep the owner's private signing key outside that account.
2. Save a project-relative worker configuration such as `local-runtime/staging-audit.json`. The workflow IDs are an explicit allowlist. The example uses one Codex specialist.

```json
{
  "version": 1,
  "workflowIds": ["staging-workflow"],
  "timeoutMs": 45000,
  "maxRuns": 3,
  "maxTotalRuns": 20,
  "specialists": [
    {
      "area": "Inquiry routing",
      "provider": "codex",
      "executable": "/absolute/path/to/codex"
    }
  ]
}
```

Use a native executable path or the provider's Node.js entry point on Windows. The other provider values are `gemini` and `antigravity`. For parallel audits, configure exactly two specialists with disjoint, nonempty `nodes` lists, then add `reviewer` with its own `provider` and `executable`. Choose one of the two profiles before signing. The run cap includes specialists, the reviewer, and any report repair retries. A parallel audit needs at least three launches to finish.

3. Sign the configuration using the owner's Ed25519 private key. An existing [GeloForge approver key](./portable-skills.md) works. Keep a pinned public PEM for the worker. The default approval lasts 24 hours and binds the project checkout, workflow allowlist, executable bytes, and run limits.

```shell
geloforge autonomous authorize --config local-runtime/staging-audit.json --key "<owner-private.pem>"
geloforge autonomous on
geloforge autonomous watch --config local-runtime/staging-audit.json --approval APPR-NNNN --owner-key "<owner-public.pem>"
```

Run these commands from the staging project. Alternatively, pass `--project "<staging-project>"`. Keep the public pin and watcher launch settings under operator control. For supervised jobs, use `watch --once` to process the inbox and exit. Run `geloforge autonomous off` to pause new audit runs.

### Deliver n8n staging failures

1. Start the worker once to create `local-runtime/n8n-audit/inbox/` under the staging project. Mount that inbox as `/files/geloforge-inbox` in the staging n8n service, or change the export's **Write audit delivery** path to match the shared directory. Give n8n permission to write and the worker permission to read and acknowledge files.
2. Import the [staging delivery workflow](../adapters/n8n/staging-audit-error-workflow.json). In **Get saved staging execution**, select a credential for the staging n8n instance scoped to execution reads. Select this error workflow in the settings of a staging workflow on the allowlist. Enable saving failed executions for the audited workflow. [Error Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.errortrigger/) · [File node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.readwritefile/)
3. Trigger one controlled automatic staging failure. The error workflow delivers IDs, the executed revision, and node metadata. Confirm the task, report, evidence, and checkpoint in the worker output. If the saved record is inaccessible or the API omits the trace, restore the staging evidence and redeliver. Trigger failures that have no saved execution ID require operator review.

Completed deliveries are acknowledged. An interrupted run keeps the inbox entry and resumes from the saved specialist results when the worker restarts. Use `geloforge autonomous progress --task TASK-NNNN`, `geloforge checkpoint resume --id CHKPT-NNNN`, or `geloforge recommend` to see the next action. Audit reports record evidence coverage and suggested next actions. Root cause and customer-facing behavior require direct staging verification.

For an offline check without a provider, save an Error Trigger object as `failure.json` and a separate saved execution JSON with matching `id`, `workflowId`, and `status: "error"`. Run `geloforge autonomous on` and `geloforge autonomous audit --event failure.json --execution execution.json`. This verifies the local failure metadata.

### Learn from verified runs

```shell
geloforge autonomous learn
geloforge autonomous learn --pattern <pattern-id> --skill n8n-staging-review
```

A recurring pattern requires matching failed-node observations from at least two distinct, verified executions. The second command drafts a quarantined skill or proposes an update. Review and [sign the skill](./portable-skills.md) before promotion.

## Canonical proposal promotion

Put the candidate Markdown file in `proposals/`. For an ADR, give it `status: proposed` and match the intended `ADR-NNNN` and project owner. Preview the source, target, and verified evidence before signing.

```shell
geloforge proposal preview --proposal proposals/constraints.md --target brain/requirements/constraints.md --evidence EVID-NNNN
geloforge proposal sign --proposal proposals/constraints.md --target brain/requirements/constraints.md --evidence EVID-NNNN --key "<owner-private.pem>"
geloforge proposal promote --proposal proposals/constraints.md --target brain/requirements/constraints.md --evidence EVID-NNNN --approval APPR-NNNN --owner-key "<owner-public.pem>"
```

Changes to the draft, current target, or evidence require a new review and signature. Promoting a new ADR records the approval in its frontmatter and archives the reviewed draft in the local promotion receipt directory.

## Local recovery tools

```shell
geloforge checkpoint create --local --resume "Review the saved staging result."
geloforge checkpoint resume
geloforge worktree add routing-review --workspace "<workspace-root>"
geloforge worktree list --workspace "<workspace-root>"
geloforge context --query "quotation handoff" --cache --json
```

Local checkpoints stay under the project's `local-runtime/checkpoints/`. Worktrees get their own branches. Removal checks for pending changes and ignored files before Git removes the checkout and preserves the branch. The query cache is opt-in and uses one packet per project under `local-runtime/context-cache/`. Requests with tasks, maps, diffs, skills, or a lease registry use a fresh compile.

---

## v0.8 & v0.9 Features

### 1. MCP Tool-Surface Pinning (`geloforge mcp lock`)

Pin configured stdio MCP servers to canonical SHA-256 tool-schema digests under `.geloforge/mcp-lock.json` and check for schema drift over JSON-RPC 2.0 (zero network calls):

```bash
# Snapshot configured stdio MCP server tool schemas
geloforge mcp lock --project /path/to/your/project --dry-run
geloforge mcp lock --project /path/to/your/project

# Verify live tool schemas still match the lockfile (optionally scope by --client and --timeout-ms)
geloforge mcp lock --check --timeout-ms 8000 --json
```

### 2. Bounded Coding Loop (`geloforge loop`)

Run a capped `implement -> verify -> review -> fix` cycle against one open task ([coding-loop.mjs](../core/coding-loop.mjs)). Deterministic test/evidence verification gates task completion, and fail-closed reviewer `policy_checks` never override a failing test gate:

```bash
geloforge loop run --config local-runtime/loop.json --task TASK-0001 --dry-run
geloforge loop run --config local-runtime/loop.json --task TASK-0001 --tool codex
geloforge loop status --task TASK-0001 --json
```

### 3. Contextual BM25, 3-Zone Context Layout & Offline Regression Evals

- **Contextual BM25 & 3-Zone Layout:** [context-compiler.mjs](../core/context-compiler.mjs) indexes Markdown headings (`#`–`####`, excluding YAML frontmatter and fenced code blocks) into Contextual BM25 `headerText` and orders compiled packets with edge anchors (contiguous `A0`/`A1`–`A2` prefix, middle reference/trace, bottom recency anchor for conflicts and operational tasks).
- **Offline Regression Evals:** Run `npm run eval` (backed by [regression-evals.json](../evaluations/regression-evals.json)) to verify retrieval recall, 3-zone ordering, heading indexing, Windows lock retry resilience, and skill quarantine gates offline.

### 4. Project & Goal Skills Advisor (`geloforge skills suggest`)

Inspect project stack markers, active tasks, or an explicit `--goal` to rank matching existing skills, detect coverage gaps, and optionally stage a quarantined draft under `proposals/skills/` without auto-promoting ([skills-advisor.mjs](../core/skills-advisor.mjs)):

```bash
geloforge skills suggest --goal "Harden checkout webhook validation"
geloforge skills suggest --task TASK-0001 --limit 5 --json
geloforge skills suggest --goal "Add CSV invoice exporter" --scaffold-draft --name csv-exporter --dry-run
```

Also exposed via the `geloforge_skills` MCP tool (`suggest` and `scaffold` actions).

### 5. One-Command Diagnostics (`doctor`) & Opt-In Ambient Hooks (`hooks init`)

Run one-command project health checks across Node.js runtime, Second Brain validation, compatibility, Git state, active leases, skill lint, MCP lock drift, and hooks ([doctor.mjs](../core/doctor.mjs)):

```bash
geloforge doctor
geloforge doctor --include-drafts --skip-mcp-check --json
```

Preview or install opt-in ambient guardrails without background daemons while preserving existing settings and MCP servers ([hooks-init.mjs](../core/hooks-init.mjs)):

```bash
# Preview all targets (git pre-commit, claude hooks.Stop, gemini hooks.AfterAgent)
geloforge hooks init --dry-run

# Install selected targets
geloforge hooks init --target git,claude,gemini
```
