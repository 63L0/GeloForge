# GeloForge

**Build with AI coding assistants without losing context, decisions, or verification truth.**

**Version:** `0.3.0` (Release Candidate — not yet tagged or published) | **License:** [MIT](./LICENSE)

GeloForge is a zero-dependency, provider-neutral toolkit for organizing projects, managing project memory, compiling bounded prompt context, mapping source symbols, and handing off verified work across coding sessions or different AI assistants.

It stores persistent project memory in plain Markdown and YAML inside your project's own repository (**Second Brain**) so you are never locked into one AI tool or chat history.

---

## 1. What GeloForge Does Today

- **Unified CLI ([scripts/geloforge.mjs](./scripts/geloforge.mjs)):** Non-interactive `geloforge` commands (`init`, `validate`, `context`, `handoff`, `status`) with `--json` output and safe atomic `--out` writes.
- **Transactional Project Scaffolding (`init`):** Initializes a reusable Second Brain ([templates/project-starter/](./templates/project-starter/README.md)) plus optional domain overlays (`web`, `desktop`, `mobile`, `automation`, `ai-system`).
- **Deterministic Context Compiler (`context`):** Assembles trust-tiered `L4` Markdown packets + `CPACK-0001` JSON manifests with explicit `budget_breakdown`, `--exclude-unverified`, open-conflict surfacing, and verified `A0` safety preservation ([context-compiler.mjs](./core/context-compiler.mjs)).
- **Selective Codebase Mapping (`context --map`):** Extracts deterministic multi-language symbol outlines, local import boost, and `L<line>` references within `--map-budget`, respecting `.gitignore` and excluding `.env*`, keys, binaries, and build outputs ([codebase-map.mjs](./core/codebase-map.mjs)).
- **Cross-Agent File-Based Handoffs (`handoff`):** Generates and cross-validates (`--inspect`) schema-strict `HANDOFF-NNNN` transfers that separate audited `verified_evidence` (`EVID-*`) from `unverified_claims`, surface `contradiction_warnings`, and capture project-scoped Git state/drift ([handoff.mjs](./core/handoff.mjs)).
- **Strict Validation & Health Checks (`validate`, `status`):** Checks 12 JSON Schemas ([schemas/](./schemas/README.md)), `1.0`/`1.1` compatibility ([compatibility.mjs](./core/compatibility.mjs)), duplicate IDs, cross-record references, symlink safety, forged evidence entries, and relative Markdown links ([project-validator.mjs](./core/project-validator.mjs)).

---

## 2. Requirements & Installation

- **Node.js `>= 20.0.0`** (uses built-in Node modules only — **zero third-party `npm install` packages and zero paid APIs**).
- **Git** (used for `.gitignore`-aware mapping, Git state/drift tracking, and optional `--git` project creation).
- **Tested Platforms:** Verified directly on **Windows 11** (`Node.js v24.21.0`). Cross-platform Linux and macOS CI workflows are configured in [.github/workflows/ci.yml](./.github/workflows/ci.yml), **not yet directly executed in Linux or macOS runners during local audit**.

Clone the repository and run the full test suite:

```bash
git clone https://github.com/63L0/GeloForge.git
cd GeloForge
npm test
```

Run commands directly via `node scripts/geloforge.mjs <command>`, `npm run geloforge -- <command>`, or link globally from the repo root with `npm link` to invoke `geloforge` directly.

---

## 3. How to Start a Project

Preview first with `--dry-run`, or scaffold an isolated project with its own Git repository:

```bash
# Preview files without touching disk
node scripts/geloforge.mjs init --name "My Web App" --profile web --dest ../projects/my-web-app --git --dry-run

# Create a TypeScript/React/API web project
node scripts/geloforge.mjs init --name "My Web App" --profile web --dest ../projects/my-web-app --git

# Check operational & Git health
node scripts/geloforge.mjs status --project ../projects/my-web-app
```

Available overlays under [templates/profiles/](./templates/profiles/README.md): `web`, `desktop`, `mobile`, `automation`, and `ai-system`. See [docs/new-projects.md](./docs/new-projects.md) for all initialization flags (`--slug`, `--owner`, `--description`, `--created-at`).

---

## 4. How to Use the Context Compiler

Compile a deterministic, trust-tiered context packet for a task (`TASK-NNNN`) or ad-hoc description (`--query`):

```bash
# Task-targeted packet with default working (~8,000 est. tokens) budget
node scripts/geloforge.mjs context --project ../projects/my-web-app --task TASK-0001

# Strict trust mode: omit A5-A6 external research & unverified drafts completely
node scripts/geloforge.mjs context --project ../projects/my-web-app --task TASK-0001 --exclude-unverified

# Save Markdown atomically to a file outside protected directories
node scripts/geloforge.mjs context --project ../projects/my-web-app --query "checkout pricing" --profile deep --out ../packets/task-context.md
```

- **Budget Profiles & Honest Minimum Floor:** `quick` targets `~2,000`, `working` targets `~8,000`, and `deep` targets `~16,000` estimated tokens (`Math.ceil(utf8_bytes / 4)` — heuristic, not vendor tokenizer exact). Mandatory `A0` safety policies, constraints, active task contracts, and open `CONF-NNNN` conflicts are **never silently truncated** to hit `2,000`; an untouched minimal 1-task starter already measures `~2,600+` est. tokens under `quick`, so `budget_overrun: true` and `budget_breakdown` report actual sizes honestly alongside `effective_profile`.
- **Prompt-Injection Boundary Note:** Packet sections separate authoritative decisions (`A1`–`A2`) from unverified records (`A5`–`A6`, drafts) and escape spoofed document markers (`<<<ESCAPED_END_GELOFORGE_DOC>>>` / `<<<ESCAPED_GELOFORGE_DOC`). However, **document markers alone cannot prevent persuasive text inside untrusted files or source comments from influencing an AI model**. Use `--exclude-unverified` when strict trust isolation is needed. Details: [context-compiler-spec.md](./context/context-compiler-spec.md).

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
- Running your project's own test commands and writing/reviewing `evidence/EVID-NNNN-*.yaml` manifests (GeloForge audits existing `EVID-*` files; it does not run arbitrary project test suites automatically).
- Recording human approval (`approved_by` / `APPR-NNNN`), promoting proposals into canonical `brain/decisions/` or `brain/requirements/`, and resolving `CONF-NNNN` conflicts.
- Invoking your chosen AI coding assistant CLI or IDE with compiled packets or handoffs.

**Not Implemented Yet:**
- Live multi-agent orchestrators, autonomous agent runners, or background daemons.
- Restricted Integration Controller for automated proposal-to-canonical promotion.
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
- **Updating GeloForge:** Inspect [CHANGELOG.md](./CHANGELOG.md), [core/compatibility.json](./core/compatibility.json), and [docs/versioning-and-upgrades.md](./docs/versioning-and-upgrades.md). Validate existing projects (`1.0` and `1.1` schemas remain supported).

---

## 10. Error Recovery, Security, Attribution, and License

- **Recovery:** Project scaffolding (`bootstrap-project.mjs`) stages into `.harness-stage-*` and CLI `--out` / handoff writes use `.geloforge-tmp-*` atomic temp-file renames without overwriting existing targets unless `--out` explicitly targets a safe non-handoff file. Use standard Git recovery (`git status`, `git diff`, `git revert <commit>`) for repository rollbacks.
- **Security & Limitations:** See [SECURITY.md](./SECURITY.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and [docs/known-limitations.md](./docs/known-limitations.md).
- **Third-Party Research Attribution:** Architectural patterns in v0.3 were informed by public open-source tools documented in [docs/research/upstream-patterns-v0.3.md](./docs/research/upstream-patterns-v0.3.md) (GitHub Spec Kit `[MIT]`, BMad Method `[MIT]`, OpenHands `[MIT]`, and Aider `[Apache-2.0]` repo-map concepts re-implemented cleanly in original Node.js without copying Apache-2.0 source code and with strict `.env*`/secret blacklists).
- **License:** Released under the [MIT License](./LICENSE) (`Copyright (c) 2026 63L0`). Note: `"private": true` in [package.json](./package.json) prevents accidental npm registry publishing while keeping this repository open-source under MIT.
