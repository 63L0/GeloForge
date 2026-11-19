# Portable Agent Skills Guide

GeloForge supports portable, plain-file [Agent Skills](https://agentskills.io) (`SKILL.md` packages) with deterministic discovery, progressive disclosure inside the Context Compiler, static security/quality linting, and fail-closed boundary checks.

> **Provider-Neutral & Portable:** Skills follow the open `agentskills.io` format. The same `SKILL.md` package can be used across **Codex**, **Gemini CLI**, **Claude Code**, **Hermes Agent**, and **GeloForge** without proprietary wrappers.

---

## 1. Create Your First Portable Skill in 2 Minutes

Create a folder matching your kebab-case skill name under `.agents/skills/` in your project repository (or globally under `~/.geloforge/skills/`):

```text
.agents/
  skills/
    release-smoke-check/
      SKILL.md                  # Required: YAML frontmatter + concise workflow
      references/               # Optional (Tier 2): checklists/guides loaded on demand
        checklist.md
      templates/                # Optional (Tier 2): reusable output/report templates
        release-note.md
      scripts/                  # Optional helper scripts (NEVER auto-executed by GeloForge)
```

Minimal `SKILL.md`:

```markdown
---
name: "release-smoke-check"
description: "Verify build artifacts, run core smoke tests, and capture command-backed evidence before tagging a release."
license: "MIT"
metadata:
  geloforge_tags: "release, smoke, evidence"
  geloforge_triggers: "release, tag, smoke check"
---

# Release Smoke Check

## When to Use

Use this skill before tagging or publishing a release branch.

## Steps

1. Confirm working tree hygiene with `git status`.
2. Run `geloforge evidence capture --task TASK-0001 --name "Test suite" -- npm test`.
3. Inspect open blockers using the [release checklist](references/checklist.md).
```

Check your skill locally:

```bash
geloforge skills validate
geloforge skills lint --strict
```

Try GeloForge's bundled example skill right away:

```bash
# POSIX / macOS / Linux
GELOFORGE_SKILLS_DIR=./examples/skills geloforge skills lint --strict

# PowerShell
$env:GELOFORGE_SKILLS_DIR = "./examples/skills"; node scripts/geloforge.mjs skills lint --strict
```

See the complete runnable example at [examples/skills/evidence-backed-bugfix/SKILL.md](../examples/skills/evidence-backed-bugfix/SKILL.md).

---

## 2. Discovery Locations, Precedence & Quarantine

GeloForge discovers skills **on demand** (without maintaining a stale global cache or database) from three roots:

| Scope | Directory | Trust Status | Notes |
| :--- | :--- | :--- | :--- |
| **Project-local** | `<project>/.agents/skills/<name>/SKILL.md` | Project-trusted (`A5` non-authoritative skill guidance) | Highest precedence; shared with teammates via Git |
| **Global user** | `~/.geloforge/skills/<name>/SKILL.md` (override with `GELOFORGE_SKILLS_DIR` or `--global-dir`) | Global-trusted (`A5` non-authoritative skill guidance) | Personal skills shared across projects on one machine |
| **Quarantined drafts** | `<project>/proposals/skills/<name>/SKILL.md` (or configured `paths.proposals_dir`) | **Quarantined (`untrusted`)** | Ignored by `context --skills`; inspectable only via `--include-drafts` |

### Conflict & Fail-Closed Precedence Rules

- **Project overrides global:** If `<name>` exists in both `.agents/skills/` and `~/.geloforge/skills/`, the project skill wins and a conflict diagnostic is reported.
- **Fail-closed override:** If a project-local skill with `<name>` is invalid, contains secrets, or uses symlinks/junctions, GeloForge **refuses to fall back** to a global skill with the same name.
- **Same-scope duplicates:** Duplicate skill names inside the same scope fail validation (`VAL-DUPLICATE-NAME`).
- **Support directories never misclassified:** Nested files inside `references/`, `templates/`, `assets/`, and `scripts/` are never treated as standalone skills even if named `SKILL.md`.
- **No auto-promotion:** Drafts inside `proposals/skills/` never override trusted skills and never enter `geloforge context --skills` packets automatically.

---

## 3. Agent Skills Specification & Optional GeloForge Hints

GeloForge validates standard [agentskills.io](https://agentskills.io) frontmatter:

- **`name`** *(required)*: `1–64` characters, lowercase ASCII `a-z`, `0-9`, single hyphens (no `--`, no leading/trailing `-`, no Windows reserved names like `con`), **must match parent folder name**.
- **`description`** *(required)*: Non-empty string `<= 1024` characters describing what the skill does and when to use it.
- **`license`** *(optional)*: License name/SPDX string (e.g. `"MIT"`).
- **`compatibility`** *(optional)*: Environment compatibility note (`<= 500` characters).
- **`metadata`** *(optional)*: Flat YAML map of **string keys to string values**. Place optional GeloForge hints here so skills stay strictly compatible with external Agent Skills tools:
  - `metadata.geloforge_tags`: comma-separated topic keywords (e.g. `"bugfix, debugging, tests"`)
  - `metadata.geloforge_triggers`: comma-separated trigger phrases
  - `metadata.geloforge_trust`: set `"unverified"` to force exclusion when `--exclude-unverified` is enabled
- **`allowed-tools`** *(optional)*: Space-separated tool string or YAML array of tool strings.

Adding unknown top-level frontmatter keys emits a portability warning (`COMPAT-EXTRA-FRONTMATTER`) recommending you move them into `metadata:`.

---

## 4. Progressive Disclosure in `geloforge context`

Compile task context together with relevant skills:

```bash
# Auto-discover skills and select relevant ones within default --skills-budget
geloforge context --task TASK-0001 --skills

# Pin specific trusted skill(s) explicitly and bound token allocation
geloforge context --task TASK-0001 --skills --skill evidence-backed-bugfix --skills-budget 1200

# Strict mode: exclude unverified skills & A5-A6 drafts completely
geloforge context --task TASK-0001 --skills --exclude-unverified
```

Three tiers prevent skill bloat:

- **Tier 0 — Discovery Index:** Lists eligible skill names and concise 1-line descriptions (`<= 160` chars) so the AI assistant knows what exists.
- **Tier 1 — Relevant Skills:** Ranks eligible skills deterministically (`ranking_method: "deterministic:metadata-keyword-pin"`) using `--skill` pins, name keywords, `metadata.geloforge_tags` / `geloforge_triggers`, description overlap, and body keyword overlap. Loads full `SKILL.md` instructions wrapped in escaped `<<<GELOFORGE_DOC>>>` fences while honoring `--skills-budget`. Oversized or lower-ranked skills stay in Tier 0 and are recorded under `omitted_skills` rather than silently truncated.
- **Tier 2 — Supporting Resources:** Lists safe relative paths under `references/`, `templates/`, `assets/`, and `scripts/` **without eagerly loading file contents**. Scripts are explicitly labeled as **never auto-executed**.

> **Deterministic Metadata Ranking vs. AI Semantic Understanding:** GeloForge's Context Compiler selects skills using deterministic keyword/metadata/pin rules — **not** embeddings, LLM classifiers, or semantic understanding. Adding clear words in `name`, `description`, `metadata.geloforge_tags`, and `## When to Use`, or pinning via `--skill <name>`, ensures reliable selection.

---

## 5. Observed CLI Examples

Below is actual output observed running GeloForge CLI against the bundled example skill via `GELOFORGE_SKILLS_DIR`:

```text
$ geloforge skills list
Project Root : (none — global skills only)
Global Root  : <skills-dir> (GELOFORGE_SKILLS_DIR)
Skills Found : 1 listed | 0 quarantined draft(s)
  - evidence-backed-bugfix [global, valid, ~526 tok] — Reproduce a software bug minimally, isolate its root cause without br...

$ geloforge skills validate
Skills Validation : PASS
Checked Packages  : 1 | Invalid: 0 | Conflicts: 0

$ geloforge skills lint --strict
Skills Lint : PASS (strict)
Counts      : critical=0 | high=0 | error=0 | warning=0
Disclaimer  : Static checks detect known risky patterns only. A passing lint result does NOT prove a skill is harmless or guarantee protection against semantic prompt injection.
```

Sample `--json` fields produced by `geloforge context --project <dir> --task TASK-0001 --skills --json` with `evidence-backed-bugfix` enabled:

```json
{
  "breakdown": {
    "mandatory_tokens": 3416,
    "policy_tokens": 2368,
    "project_mandatory_tokens": 1048,
    "optional_tokens": 1232,
    "codebase_map_tokens": 0,
    "skills_tokens": 847,
    "overhead_tokens": 599
  },
  "skills": {
    "enabled": true,
    "ranking_method": "deterministic:metadata-keyword-pin",
    "discovered_count": 1,
    "indexed_count": 1,
    "pinned_skills": [],
    "selected_skills": [
      {
        "name": "evidence-backed-bugfix",
        "source": "global",
        "tier": "tier1+tier2",
        "score": 240,
        "reason": "name matched 1 keyword(s); tags/triggers matched 5 keyword(s); description matched 5 keyword(s); body matched 7 keyword(s)",
        "supporting_resources": [
          "references/bugfix-checklist.md",
          "templates/repro-note.md"
        ]
      }
    ],
    "omitted_skills": [],
    "quarantined_excluded": 0,
    "security_flagged_excluded": 0,
    "estimated_tokens": 847,
    "skills_budget": 1400
  }
}
```

---

## 6. Using Portable Skills Across AI Coding Tools

Keep project skills committed in `.agents/skills/` as pure Markdown + relative references so any coding assistant can consume them:

- **OpenAI Codex / Codex CLI:** Reads project `.agents/skills/<name>/SKILL.md` conventions natively; use `geloforge skills lint --strict` in CI to catch broken references, secrets, or oversized instructions early.
- **Google Gemini CLI / Antigravity:** Store reusable skills in `.agents/skills/` (or global `~/.geloforge/skills/`), compile task-ready packets with `geloforge context --task TASK-NNNN --map --skills`, or share project-independent `SKILL.md` workflows directly.
- **Claude Code & Hermes-Compatible Tools:** `SKILL.md` frontmatter (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) avoids GeloForge-only wrapper syntax. Any GeloForge keyword hints stay safely inside standard string `metadata.*` keys.

---

## 7. Security Boundaries & Threat Model

1. **Zero automatic script execution:** GeloForge never spawns or evaluates files inside `scripts/` during `skills`, `validate`, `lint`, or `context`.
2. **Fail-closed filesystem & secret checks:** Symlinks and NTFS junctions (roots, skill dirs, internal files, link targets), `..` path traversal, `file://`/absolute links, binary files, `.env*`/`*.pem`/`credentials.json`/SSH key files, and embedded credential literals are blocked and redacted.
3. **Mandatory `A0` policy preservation:** Skills run as non-authoritative `A5` guidance inside `<<<GELOFORGE_DOC>>>` fences and can never remove or weaken `policies/approval-boundaries.md` or `policies/memory-policy.md`.
4. **Static scanner limits (Important):** `geloforge skills lint` flags known patterns (`ignore previous instructions`, `override A0`, `curl ... | sh`, encoded execution, hidden bidi/zero-width Unicode, exfiltration commands, `auto-approve` claims). **A clean lint run does NOT prove a skill is harmless and does NOT stop semantic prompt injection.** Always review external skills before trusting them.
