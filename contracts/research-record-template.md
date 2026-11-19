---
schema_version: "1.0"
id: "{{RESEARCH_ID}}"
title: "{{RESEARCH_TITLE}}"
status: "draft"
memory_layer: "L3_RESEARCH_EVIDENCE"
authority_level: "A5"
author_role: "researcher"
created_at: "{{CREATED_AT}}"
updated_at: "{{UPDATED_AT}}"
valid_until: null
question: "{{RESEARCH_QUESTION}}"
confidence: "medium"
sources:
  - title: "{{SOURCE_TITLE}}"
    reference: "{{SOURCE_REFERENCE}}"
    type: "official_docs"
    accessed_at: "{{CREATED_AT}}"
related_tasks: []
related_adrs: []
contradicts: []
tags:
  - "research"
---

# {{RESEARCH_ID}}: {{RESEARCH_TITLE}}

## Research Question

{{RESEARCH_QUESTION}}

## Summary

Summarize verifiable findings concisely without unverified extrapolation.

## Detailed Findings

- Finding 1 (cite source reference and revision/date).
- Finding 2 (distinguish observed facts from assumptions).

## Contradictions and Knowledge Gaps

- Note any conflicts with existing `A0`–`A4` records (create `CONF-NNNN` if contradictory).
- State explicitly what was NOT tested or verified.

## Sources

1. `{{SOURCE_TITLE}}` — `{{SOURCE_REFERENCE}}` (accessed `{{CREATED_AT}}`)
