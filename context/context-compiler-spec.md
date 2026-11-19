# Deterministic Context Compiler Specification

> **Status:** **Stage 2 Vertical Slice IMPLEMENTED** in [core/context-compiler.mjs](../core/context-compiler.mjs) (`geloforge context`).
> **Deferred:** On-disk packet caching under `<workspace-root>/local-runtime/context-cache/` remains **NOT IMPLEMENTED** pending latency benchmarks.

## 1. Objective

The **Deterministic Context Compiler** assembles **Layer 4 (`L4_TEMPORARY_CONTEXT`)** task packets from a project's Second Brain (`L1`–`L3`) and global harness policies (`A0`), emitting:

1. A deterministic Markdown context packet grouped strictly by trust tier (`A0` policies, open conflicts, `A1`–`A2` authoritative knowledge, `A3`–`A4` operational/verified state, and quarantined `A5`–`A6`/draft non-authoritative records).
2. A machine-validatable [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json) (`CPACK-0001`) recording included files, SHA-256 revisions, Git `HEAD` commit, omitted candidates, freshness warnings, unresolved conflicts, and invalidation triggers.

## 2. Implemented Pipeline ([core/context-compiler.mjs](../core/context-compiler.mjs))

1. **Identify Target:** Accept `--task TASK-NNNN` or `--query <text>` for a validated project root (`manifest.yaml` + `state/current.yaml`).
2. **Load Mandatory Safety Policies (`A0`):** Always include `policies/approval-boundaries.md` verbatim. In `working`/`deep`, include `policies/memory-policy.md` verbatim; in `quick`, extract `## 3. Knowledge Authority Hierarchy` only after verifying exact verbatim substring + `CRITICAL RULE` + `A0`–`A6` completeness (falling back to the full file if verification fails).
3. **Read Mandatory Project State & Constraints:** Always include `brain/manifest.yaml`, `brain/state/current.yaml`, target `TASK-NNNN`, `brain/requirements/constraints.md`, and all `open`/`under_review` `CONF-NNNN` conflicts.
4. **Enforce Untrusted-Content & Path Safety:** Block `.env*`, keys, symlinks/junctions, path traversal, files > 512 KB, embedded secret patterns, canonical `is_example: true` fixtures, and unapproved `accepted` ADRs (`approved_by: null`). Quarantine `A5`/`A6` and draft items inside a clearly labeled non-authoritative section.
5. **Score & Select Optional Candidates:** Rank `prd.md`, `overview.md`, `profile.md`, `ADR-*`, `EVID-*`, `RES-*`, and `TASK.required_inputs` deterministically using explicit references, authority/freshness weights, and keyword overlap.
6. **Budget Fitting & Honest Token Estimation:** Uses `Math.ceil(utf8_bytes / 4)` (`heuristic:ceil(utf8_bytes/4)` — not vendor-exact tokenization). **Never omits or truncates mandatory rules:** sets `budget_overrun: true` and escalates `effective_profile` when mandatory content exceeds the target budget.

## 3. Starting Context Budget Targets & Unavoidable Minimum Floors

Targets below are **soft packing goals, not hard truncation cliffs**. Mandatory governance policies (`A0`), project manifest/state/constraints, target `TASK-NNNN`, and open `CONF-NNNN` contradictions are **never dropped** to hit a numerical target; when unavoidable mandatory context exceeds a target, `budget_overrun: true` and `budget_breakdown` (`policy_tokens`, `project_mandatory_tokens`, `optional_tokens`, `codebase_map_tokens`, `overhead_tokens`) are reported honestly alongside `effective_profile`.

| Profile | Starting Target | Intended Use Case |
| :--- | :--- | :--- |
| `quick` | ~2,000 est. tokens | Narrow validation, status updates, or single-file checks |
| `working` | ~8,000 est. tokens | Standard feature tasks, bug fixes, tests, or targeted ADR drafting |
| `deep` | ~16,000 est. tokens | Complex architecture, multi-module debugging, security reviews, or conflict resolution |

### Measured `quick` Profile Minimum Context Floor

Even with a verified verbatim `A0` excerpt of `policies/memory-policy.md`, an untouched 1-task starter project compiles to **~2,600+ est. tokens** (`approval-boundaries.md` + `memory-policy.md` excerpt + `brain/manifest.yaml` + `brain/state/current.yaml` + `brain/requirements/constraints.md` + `TASK-0001` + trace/headers), and a realistic fixture with an open conflict plus task-linked ADR/evidence compiles to **~4,300+ est. tokens** under `quick` (`effective_profile: "working"`). In `quick` mode, the compiler compacts long `Omitted Candidates` trace listings in Markdown (full trace remains in `--json`) while preserving every mandatory safety rule and project invariant verbatim.

## 4. Prompt-Injection Threat Model & Limitations

- **What `<<<GELOFORGE_DOC>>>` isolation does:** Separates authoritative policies (`A0`) and project decisions (`A1`–`A2`) from unverified/external records (`A5`–`A6`, drafts) and escapes spoofed closing fences (`<<<ESCAPED_END_GELOFORGE_DOC>>>`) so untrusted files cannot forge delimiter boundaries.
- **What marker escaping does NOT do:** Escaping document markers alone **does NOT prevent malicious instructions inside untrusted files, research notes, or source comments from semantically influencing an AI model's reasoning or tool requests**.
- **Mitigations:** Use `--exclude-unverified` when strict trust isolation is required, rely on deterministic schema validation (`approved_by` checks on ADRs, rejection of canonical `is_example` fixtures), and treat human approval (`APPR-NNNN`) and OS/repository boundaries as the authoritative safety gate.
