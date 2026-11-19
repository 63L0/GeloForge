# Upstream Open-Source Research — GeloForge v0.3.0

**Research Date:** 2026-11-19  
**Goal:** Identify proven patterns for context compilation, selective codebase mapping, cross-agent handoffs, CLI developer experience, and workflow boundaries while preserving GeloForge's lightweight, provider-neutral, zero-dependency core.

## Repositories Examined

| Project | Canonical Repository | Revision Examined | License & Attribution Findings | Decision |
| :--- | :--- | :--- | :--- | :--- |
| **GitHub Spec Kit** | `github/spec-kit` | HEAD `617e9a0a59df6c4c18401fb796ea1dd1fac0c6e2` (`v1.4.2`) | **MIT** (`Copyright GitHub, Inc.`) — compatible with GeloForge MIT. | **ADAPT** CLI non-interactive safety & proportional workflow ideas; **REJECT** Python/MCP/preset catalog dependencies. |
| **Aider** | `Aider-AI/aider` | HEAD `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (`v0.86.0`) | **Apache-2.0** (`LICENSE.txt`) — re-implementing algorithmic concepts cleanly in original Node.js avoids Apache-2.0 source-copy notice obligations. | **ADAPT** `.gitignore`-aware ranking + budget-fitting algorithm cleanly in Stage 3 (hard-excluding `.env*` and secrets); **REJECT** Python/`tree-sitter`/`networkx` stack. |
| **BMad Method** | `bmad-code-org/BMAD-METHOD` | HEAD `e435a22574fe55722841086e5566420178b98df3` (`v6.12.4`) | **MIT** (`Copyright (c) 2025 BMad Code, LLC`) + **`TRADEMARK.md` brand restriction** (excludes BMad names/marks from MIT). | **ADAPT** verbatim Git SHA traceability, proportional ceremony, and "never silently drop existing rules"; **REJECT** copying skill DSL or trademarked assets. |
| **OpenHands & SDK** | `OpenHands/OpenHands` & `OpenHands/software-agent-sdk` | HEAD `e1b8b60f25084a64412c3a2789a921034fc895c7` (`v1.42.0`) & `141423921fdaeb08cd5f53464a69e860da70b66f` | **MIT** (`Copyright © 2025 OpenHands contributors`) — compatible with GeloForge MIT. | **ADAPT** strict control/credential separation, explicit terminal/resumable state modeling, and corruption-tolerant diagnostics; **REJECT** server/UI/daemon infrastructure. |

## Specific Source Files Studied & Engineering Takeaways

1. **`github/spec-kit`** (`pyproject.toml`, `spec-driven.md`, `templates/tasks-template.md`, `workflows/bugfix/workflow.yml`, `src/specify_cli/command_init.py`):
   - `_prompts_allowed` prevents interactive pickers from hanging when invoked inside agent PTYs; GeloForge CLI defaults to strictly non-interactive execution with explicit `--json` automation output.
   - `workflows/bugfix/workflow.yml` separates lightweight bug assessment/fix/test from heavy multi-artifact specification flows.
2. **`Aider-AI/aider`** (`aider/repomap.py`, `aider/special.py`, `aider/repo.py`, `aider/linter.py`):
   - `RepoMap` extracts definitions/references, prioritizes active/mentioned paths and compound identifiers, penalizes `_private` or overly common symbols, and fits within token budgets cleanly.
   - **Important security divergence:** `aider/special.py` includes `.env` in `ROOT_IMPORTANT_FILES`. GeloForge strictly blacklists `.env*`, keys, certificates, and credential-like strings from context packets and future codebase maps.
3. **`bmad-code-org/BMAD-METHOD`** (`README.md`, `TRADEMARK.md`, `skills/method/bmad-project-context/SKILL.md`, `skills/method/bmad-build/workflow.md`):
   - Capturing full canonical Git revisions verbatim and surfacing existing instructions/constraints via an explicit ledger rather than silent deletion aligns with GeloForge's `A0`/`A1` and `CONF-NNNN` safety principles.
4. **`OpenHands/OpenHands` & `OpenHands/software-agent-sdk`** (`docs/architecture.md`, `docs/ACP_AGENTS.md`, `openhands-sdk/openhands/sdk/conversation/state.py`, `event_store.py`):
   - Control layers should never store provider credentials directly; unreadable/corrupted auxiliary files should surface explicit structured diagnostics (`UNREADABLE_EVENT_FILE_CODE` pattern) rather than crashing non-fatal tooling.

## Stage 2 Feature Decisions

- **ADOPT (Stage 2):** Deterministic Context Compiler (`core/context-compiler.mjs`), unified `geloforge` CLI (`init`, `validate`, `context`, `status`) via `scripts/geloforge.mjs`, and validator task-state conflict + folder hygiene checks.
- **DEFER (Stage 3+):** Selective codebase mapping, file-based cross-agent handoff CLI, proportional workflow guide, on-disk context caching (pending Stage 2 latency measurement), and deterministic checkpoints.
- **REJECT (v0.3.0):** Multi-agent orchestration, ACP subprocess runners, background daemons, vector DB/RAG infrastructure, paid APIs, and third-party runtime dependencies.
