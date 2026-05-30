---
name: review
description: >
  Run a structured, evidence-based code review (local changes, branch, or PR) using a dedicated reviewer persona. For code targets, graph tools are used early to understand impact and structure before flagging issues. Findings are always written by the reviewer subagent with clear severity, location, description, and suggestion.
  Use when asked to "review", "code review", "review my changes", "review this PR", "/review", or any time you want an independent, non-author review of work in progress or a PR.

version: "0.2.0-canonical"
canonical-id: "grand-unification:review:review:2026-05"

when-to-use: |
  - "review"
  - "code review"
  - "review my changes"
  - "review this PR"
  - "/review"
  - Any request for an independent look at diffs or a pull request

argument-hint: "[--local | --branch <name> | --pr <number-or-url> | <auto-detect>]"

surfaces:
  - grok

tags:
  - review
  - quality
  - unification

categories:
  - review
  - core

verification-criteria:
  - "A dedicated reviewer subagent (injected with the reviewer persona) produces all findings — the orchestrator does not invent issues"
  - "For any target involving existing code, code-review-graph tools (impact radius, affected flows, etc.) are consulted before or during issue identification"
  - "Every issue has Severity (bug/suggestion/nit), precise File:line, Description, and Suggestion"
  - "No issues are invented to fill space; empty or clean reviews are valid and reported honestly"
  - "The final output (review file, summary, or pending PR review) is the direct result of the reviewer subagent plus minimal orchestrator post-processing"
  - "The review itself can be verified with check-work (trace of what was reviewed vs what was flagged)"

references:
  - path: references/reviewer-persona.md
    purpose: "Core reviewer persona instructions (injected into every reviewer subagent)"
  - path: references/graph-for-review.md
    purpose: "How and when to use the code-review-graph during reviews (mandatory for code targets)"
  - path: references/review-output-format.md
    purpose: "Canonical issue format and summary structure"

license: Personal
last-unified: "2026-05-30"
changelog:
  - "0.2.0-canonical: Unified core review capability. Added explicit graph mandate for code reviews, strong verification-criteria, and references to persona + output standards. Full mode orchestration (local/branch/PR) preserved in spirit with surface-specific details noted for projectors."

metadata:
  grok:
    uses_spawn_subagent: true
    requires_persona_injection: true
    benefits_from_code_review_graph: true
---

# Review — Independent Structured Code Review

Orchestrate a high-quality, persona-driven review of changes while ensuring structural understanding via the graph and strict output discipline.

The reviewer subagent does the actual thinking and writing. The orchestrator's job is coordination, context gathering, graph augmentation, and clean delivery.

## Core Principles (Non-Negotiable)

- Reviewer is read-only. Neither subagent nor orchestrator modifies source during the review.
- All substantive findings come from the injected reviewer persona + the actual diff + source context.
- Graph tools are used for any review that touches existing code (see references).
- Do not invent issues. Clean diffs get clean (or empty) reviews.
- Output format is consistent and machine-friendly where needed (especially for PR mode).

## High-Level Flow

1. Parse mode and target (local / branch / PR or auto-detect).
2. Collect the diff and changed-files list (with size guards and empty-diff short-circuits).
3. For code targets: Run relevant code-review-graph queries (impact radius, affected flows, etc.) and include key findings in the reviewer prompt.
4. Launch one reviewer subagent with the full persona instructions prepended + rich context (diff, changed files, graph insights, mode-specific details).
5. Post-process the reviewer's output according to mode:
   - Local/branch: Write review file + summary.
   - PR: Build and post PENDING review via GitHub API (with proper line mapping to the right side of the diff).
6. Clean up transient files (asymmetric by mode and success).
7. Deliver final report with clear paths/URLs and counts.

## Graph Integration (Mandatory for Code Targets)

Before or during the reviewer launch:
- Use `get_impact_radius` and/or `get_affected_flows` on the changed files.
- Feed high-signal graph findings into the reviewer prompt (e.g., "These changes touch 3 critical payment flows according to the graph...").
- The reviewer is encouraged to reference structural context when assessing blast radius and risk.

See `references/graph-for-review.md`.

## Output Discipline

The reviewer must produce:
- A clear `## Summary` (2-4 sentences).
- Structured issues with exact format:
  ### Issue N -- Severity: bug|suggestion|nit
  - File: path:line
  - Description: ...
  - Suggestion: ...

No invention of issues. Empty reviews are valid.

## Verification Criteria (for this skill)

- The reviewer subagent (not the orchestrator) authors the findings.
- Graph tools were used on any non-trivial code review.
- Output matches the canonical format.
- Empty or clean results are handled honestly without forcing content.
- The delivered artifacts (files or pending review) accurately reflect the reviewer's work.

This skill pairs extremely well with `check-work` (run a review, then verify the review itself was thorough) and `owl` (use for strategic/architectural reviews).

Full low-level orchestration details (exact diff collection commands, PR payload construction, cleanup rules) are preserved from the high-quality source implementation and should be maintained in surface-specific projectors or detailed references as the unification matures.