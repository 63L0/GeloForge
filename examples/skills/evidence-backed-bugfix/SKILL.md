---
name: "evidence-backed-bugfix"
description: "Reproduce a software bug minimally, isolate its root cause without broad refactors, implement a targeted fix, and verify with command-backed test evidence before handing off."
license: "MIT"
compatibility: "Provider-neutral Agent Skills package tested with GeloForge on Node.js >= 20, Linux, macOS, and Windows."
metadata:
  author: "GeloForge"
  version: "1.0"
  geloforge_tags: "bugfix, debugging, tests, regression, evidence"
  geloforge_triggers: "bug, regression, failing test, error, fix, crash"
---

# Evidence-Backed Bugfix

Follow a disciplined, minimal-change bugfix loop so claims of a fix rest on reproducible observations rather than guesswork.

## When to Use

Use this skill whenever fixing a reproducible software defect, failing test, edge-case crash, or regression inside an existing codebase. Do **not** skip reproduction unless a bug is strictly static/compile-time and provable by deterministic inspection.

## Workflow

1. **Reproduce Before Editing**
   - Capture the smallest command, test case, or input that reliably triggers the failure.
   - Copy or adapt the [reproduction note template](templates/repro-note.md) if handing off or documenting findings.
2. **Isolate the Root Cause**
   - Trace the failing code path and inspect boundary conditions (nulls, encodings, platform paths, error handling).
   - Check whether the project's Second Brain has active architectural decisions or constraints affecting that module.
3. **Implement a Minimal, Reversible Fix**
   - Fix the underlying defect cleanly without unrelated refactors or weakening assertions.
   - Add a deterministic regression test that fails before the fix and passes after it.
4. **Verify Honest Evidence**
   - Run the targeted regression test **and** the wider test suite using `geloforge evidence capture --task <TASK-NNNN> -- <cmd>` (note: exit code `0` proves command execution succeeded, not exhaustive correctness).
   - Walk through the [bugfix verification checklist](references/bugfix-checklist.md) before closing the task or generating a handoff.
