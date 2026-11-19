---
schema_version: "1.0"
id: "ADR-0000"
title: "Example ADR Format Demonstration"
status: "proposed"
memory_layer: "L1_AUTHORITATIVE"
authority_level: "A2"
owner: "Project Owner"
proposed_by: "software-architect"
approved_by: null
created_at: "2026-01-01T00:00:00Z"
updated_at: "2026-01-01T00:00:00Z"
decided_at: null
review_by: "2026-07-01"
supersedes: []
superseded_by: null
related_requirements:
  - "brain/requirements/constraints.md#REQ-EXAMPLE-01"
related_research:
  - "RES-0000"
approval_ref: null
tags:
  - "example"
  - "documentation"
is_example: true
example_notice: "EXAMPLE ONLY — NOT REAL EVIDENCE OR AN APPROVED DECISION"
---

# ADR-0000: Example ADR Format Demonstration

> **EXAMPLE ONLY — NOT REAL EVIDENCE OR AN APPROVED DECISION.**

## Status

`proposed` (Illustrative template example only.)

## Context

Demonstrates how a proposed architectural decision links constraints (`brain/requirements/constraints.md`) and research (`RES-0000`) before owner approval (`APPR-NNNN`).

## Decision

Proposed example decision: store configuration schema files as plain UTF-8 JSON alongside Markdown documentation.

## Alternatives Considered

| Option | Pros | Cons | Reason Not Selected |
| :--- | :--- | :--- | :--- |
| Plain JSON Schema | Zero runtime dependency to parse in Node.js | Verbose for hand editing | Selected for machine validation |
| Custom DSL | Compact | Requires custom parser maintenance | Higher maintenance cost |

## Consequences

- Illustrative consequence only.

## Evidence and References

- Example research: `RES-0000`
- Approval: pending (`null`)
