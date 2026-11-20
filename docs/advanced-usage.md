# GeloForge — Detailed CLI & Technical Guide

[← Project overview and quick start](../README.md)

This is the in-depth reference previously presented on the repository homepage. Beginners can start with the [5-minute quickstart](./quickstart-5min.md); the sections below document flags, workflows, budgets, and limitations for advanced users.

---

**Build with AI coding assistants without losing context, decisions, or verification truth.**

**Version:** `0.4.0` | **License:** [MIT](../LICENSE)

GeloForge is a zero-dependency, provider-neutral toolkit for organizing projects, managing project memory, compiling bounded prompt context, mapping source symbols, and handing off verified work across coding sessions or different AI assistants.

It stores persistent project memory in plain Markdown and YAML inside your project's own repository (**Second Brain**) so you are never locked into one AI tool or chat history.

---

## 1. What GeloForge Does Today

- **Unified CLI ([scripts/geloforge.mjs](../scripts/geloforge.mjs)):** Non-interactive `geloforge` commands (`init`, `adopt`, `task`, `evidence`, `validate`, `context`, `skills`, `handoff`, `status`) with CWD project auto-discovery, `--json` output, and atomic `--out` writes.
- **Brownfield Adoption & Greenfield Scaffolding (`adopt`, `init`):** Safely onboard existing repos with `geloforge adopt` without altering existing source files ([adopt-project.mjs](../core/adopt-project.mjs)), or initialize new Second Brain repos ([templates/project-starter/](../templates/project-starter/README.md)) with domain overlays (`web`, `desktop`, `mobile`, `automation`, `ai-system`).
- **Task Contracts & Command-Backed Evidence (`task`, `evidence`):** Manage schema-strict `TASK-NNNN` contracts ([task-manager.mjs](../core/task-manager.mjs)) and capture real `EVID-NNNN` records via `geloforge evidence capture -- <cmd>` with `shell: false`, secret redaction, and explicit pass/fail/timeout accuracy ([evidence-capture.mjs](../core/evidence-capture.mjs)).
- **Portable Agent Skills (`skills`, `context --skills`):** Discover, validate, and statically security-lint [agentskills.io](https://agentskills.io)-compatible `SKILL.md` packages in `.agents/skills/` and `~/.geloforge/skills/` (`GELOFORGE_SKILLS_DIR`) with progressive disclosure (`Tier 0` index -> `Tier 1` relevant skills -> `Tier 2` support paths), quarantine for `proposals/skills/`, and evidence-backed drafting, update proposals, Ed25519/PR-branch/TTY-authorized promotion, content-addressed history, and rollback ([skills.mjs](../core/skills.mjs), [skills-lint.mjs](../core/skills-lint.mjs), [skills-lifecycle.mjs](../core/skills-lifecycle.mjs), [Portable Skills Guide](../docs/portable-skills.md), [Example Skill](../examples/skills/evidence-backed-bugfix/SKILL.md)).
- **Deterministic Context Compiler (`context`):** Assembles trust-tiered `L4` Markdown packets + `CPACK-0001` JSON manifests with explicit `budget_breakdown`, `--exclude-unverified`, open-conflict surfacing, selective `--skills`, and verified `A0` safety preservation ([context-compiler.mjs](../core/context-compiler.mjs)).
- **Selective Codebase Mapping (`context --map`):** Extracts deterministic multi-language symbol outlines, local import boost, and `L<line>` references within `--map-budget`, respecting `.gitignore` and excluding `.env*`, keys, binaries, and build outputs ([codebase-map.mjs](../core/codebase-map.mjs)).
- **Cross-Agent File-Based Handoffs (`handoff`):** Generates and cross-validates (`--inspect`) schema-strict `HANDOFF-NNNN` transfers that separate audited `verified_evidence` (`EVID-*`) from `unverified_claims`, surface `contradiction_warnings`, and capture project-scoped Git state/drift ([handoff.mjs](../core/handoff.mjs)).
- **Strict Validation & Health Checks (`validate`, `status`):** Checks 12 JSON Schemas ([schemas/](../schemas/README.md)), `1.0`/`1.1` compatibility ([compatibility.mjs](../core/compatibility.mjs)), duplicate IDs, cross-record references, symlink safety, forged evidence entries, relative Markdown links, and actionable `nextSteps` ([project-validator.mjs](../core/project-validator.mjs)).

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

## 8. What Requires Manual Work & What Is Not Implemented Yet

**Still Requires Manual Action:**
- Running your verification command explicitly (`geloforge evidence capture --task TASK-NNNN -- <cmd>`) or authoring/reviewing `evidence/EVID-NNNN-*.yaml` manifests (exit code `0` confirms command execution succeeded, not full application correctness — review tool output and untested paths carefully).
- Authorizing skill promotions/rollbacks (`geloforge skills sign` / `promote` / `rollback`), configuring GitHub branch protection & `CODEOWNERS` for team repos, promoting canonical `brain/decisions/` or `brain/requirements/`, and resolving `CONF-NNNN` conflicts.
- Invoking your chosen AI coding assistant CLI or IDE with compiled packets or handoffs.

**Not Implemented Yet:**
- Automatic skill self-modification daemons or remote skill marketplaces.
- Live multi-agent orchestrators, autonomous agent runners, or background daemons.
- Automated promotion of non-skill `proposals/` into canonical `brain/decisions/` or `brain/requirements/` (`APPR-*` for canonical ADRs/PRDs remains manual).
- OS/Git pre-commit write-ownership enforcement or runtime spend interceptors (`policies/` ownership rules remain documented governance only).
- On-disk compiled context caching (`<workspace-root>/local-runtime/context-cache/`), automated `CHKPT-NNNN` checkpoint tooling, vector databases, RAG pipelines, or paid API integrations.

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
- **License:** Released under the [MIT License](../LICENSE) (`Copyright (c) 2026 63L0`). Note: `"private": true` in [package.json](../package.json) prevents accidental npm registry publishing while keeping this repository open-source under MIT.

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
# Mark a task completed (updates state.last_completed_task and releases its lease)
node scripts/geloforge.mjs task done --task TASK-0001

# Update/reactivate a task cleanly
node scripts/geloforge.mjs task update --task TASK-0001 --status active --activate

# Claim a cooperative lease across IDEs/tools (blocks overlapping scopes unless --force)
node scripts/geloforge.mjs task claim --task TASK-0002 --tool gemini-ide --role developer --scope "src/auth" --ttl 120
node scripts/geloforge.mjs task leases
node scripts/geloforge.mjs task release --task TASK-0002
```
Active peer leases are automatically surfaced inside compiled `context` packets as an operational collision guard.

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
```bash
node scripts/geloforge.mjs mcp --project /path/to/your/project
```
Exposes `geloforge_status`, `geloforge_recommend`, `geloforge_context`, `geloforge_task`, `geloforge_checkpoint`, and read/lint/draft `geloforge_skills` tools over JSON-RPC 2.0 stdin/stdout (supporting both newline-delimited JSON and `Content-Length:` LSP framing). Privileged skill actions (`promote`, `rollback`, `keygen`, `sign`) are strictly refused over MCP so human authorization stays under local CLI / Git control.
