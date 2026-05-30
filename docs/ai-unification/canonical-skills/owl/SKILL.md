---
name: owl
description: >
  Perform a deep, multi-perspective strategic review (Owl mode). Examine code, architecture, processes, or systems from near and far, day and night, across multiple lenses (strengths, deficiencies, opportunities, risks, predictive outlook).
  Use when the user asks for a "strategic review", "Owl review", "GrokIsTheOwl", "high-level assessment", "architectural review", "grand unification review", or wants wise, predictive, actionable analysis beyond normal code review.

version: "0.1.0-canonical"
canonical-id: "grand-unification:meta:owl:2026-05"

when-to-use: |
  - "strategic review"
  - "owl review"
  - "GrokIsTheOwl"
  - "do an Owl on this"
  - "high-level / architectural / predictive review"
  - "review this from multiple perspectives"
  - Working on the Grand Unification and want the original Owl lens applied

argument-hint: "<target: codebase / process / skill set / subsystem> [--depth near|far|both] [--focus verification|architecture|token-economics|unification]"

arguments:
  - name: target
    type: string
    description: "What to review (path, skill name, subsystem, the unification effort itself, etc.)"
    required: true
  - name: depth
    type: "near | far | both"
    description: "Focus: near (details), far (big picture), or both"
    required: false
    default: "both"
  - name: focus
    type: string
    description: "Optional additional lenses (verification culture, token economics, fragmentation, etc.)"
    required: false

surfaces:
  - grok

tags:
  - meta
  - strategic
  - review
  - unification
  - owl
  - predictive

categories:
  - review
  - meta

verification-criteria:
  - "The review explicitly uses multiple perspectives (near/far, day/night, strengths + deficiencies + opportunities + risks)"
  - "Predictive outlook (6-18 month risks and opportunities) is included and grounded"
  - "Recommendations are actionable and prioritized (not generic advice)"
  - "The review references specific evidence from the target (files, patterns, existing docs, measured behaviors)"
  - "Self-referential: when reviewing the unification or AI OS, the review itself demonstrates the value of the canonical skills and schema"
  - "Output is crisp, high-signal, and earns every token (per the user's operating principles)"

references:
  - path: references/owl-lenses.md
    purpose: "The core Owl perspectives and how to apply them systematically"
  - path: references/predictive-checklist.md
    purpose: "Questions to force good forward-looking analysis"

license: Personal
last-unified: "2026-05-30"
changelog:
  - "0.1.0-canonical: Initial encoding of the Owl strategic review process that launched the Grand Unification effort"

metadata:
  grok:
    heavy_subagent_use: true
    benefits_from_code_review_graph: true
---

# Owl — Strategic Multi-Perspective Review

Act as the metaphorical Owl: see in night and day, turn your head in all directions, focus near and far, be wise and predictive.

This skill exists because the original Owl review (May 2026) produced the Grand Unification plan. It should now be reusable on the unification itself and on any important system.

## Owl Nature (Core Mindset)

- **Night and Day**: Surface issues (day) and hidden structural problems, cultural debt, and second-order effects (night).
- **All Directions**: Architecture, DX, performance, security, maintainability, token economics, verification culture, future risk.
- **Near and Far**: Specific files/lines + system-level patterns and incentives.
- **Predictive**: Not just "what is wrong now" but "what will hurt in 6-18 months as models and tools improve".
- **Actionable Wisdom**: Every finding should lead to a clear, prioritized recommendation or experiment.

## When to Invoke Strongly

- Major architectural or process decisions
- Periodic health checks on the AI OS / Grand Unification effort
- Before big investments (new projectors, heavy skill migrations, new Epic-style loops)
- When the user says "strategic review", "Owl mode", or "think like the Owl"

## Workflow

### 1. Frame the Hunt
Clarify the target and the most relevant lenses for this review.
- Is the target code, a skill/process, the unification itself, a subsystem, or the user's overall operating system?
- What time horizon matters most (now, 6 months, 18 months)?

### 2. Gather Evidence (Use Tools Ruthlessly)
- For code/process targets: Use code-review-graph tools first (impact radius, affected flows, communities, bridge nodes, semantic search) before raw grep/read. This is mandatory per the user's own rules.
- Read key docs, SKILL.md files, AGENTS.md / Claude.md, roadmap files.
- Sample real usage (session patterns, recent work, installed skills).
- Look for duplication, drift, maintenance tax, and verification gaps.

### 3. Apply the Lenses (Systematically)
Run through the core Owl perspectives (detailed in `references/owl-lenses.md`):

- **Strengths** (what is genuinely world-class and worth protecting)
- **Deficiencies & Structural Weaknesses** (fragmentation, missing feedback loops, hidden risks)
- **Opportunities** (efficiency, features, maintainability, predictive)
- **Risks & Predictive Outlook** (model improvement curves, maintenance burden growth, security surface expansion)
- **Self-Reference** (when reviewing the AI OS or unification: does the thing under review demonstrate the patterns it claims to value?)

### 4. Synthesize & Prioritize
- Group findings.
- Distinguish quick wins from deep bets.
- Identify the 1-3 highest-leverage moves.
- Include concrete next actions (with suggested effort/impact where possible).

### 5. Deliver the Document
Produce a clear, actionable strategic document (similar structure to the original "New GrokIsTheOwl Strategic Document"):
- Executive summary (far view)
- Strengths
- Deficiencies
- Opportunities (categorized)
- Prioritized recommendations
- Predictive section
- Clear success criteria for follow-up

Use the user's preferred style: crisp, precise, every token earns its place. Avoid generic AI review fluff.

### 6. Verify Your Own Review
Before delivering, apply light self-verification:
- Did I use multiple perspectives?
- Is the predictive section grounded or hand-wavy?
- Are recommendations actionable?
- Did I cite specific evidence?
- If this was a review of the unification, does it advance the acceleration?

## Special Mode: Reviewing the Grand Unification Itself

When the target is the unification effort, the AI OS, or this set of canonical skills:
- Explicitly evaluate progress against the roadmap.
- Check whether the new canonical skills and projectors are actually reducing fragmentation or just adding another layer.
- Assess dogfooding effectiveness.
- Look for "cobbler's children" problems (the unification tools themselves not using the graph, verification, etc.).
- Recommend concrete next dogfood targets.

## Output Principles

- **Brevity with substance** (user's CLAUDE.md rule).
- **Evidence-based** — name specific files, patterns, skills, or observed behaviors.
- **Predictive honesty** — state reasonable assumptions and time horizons.
- **Actionable** — every major section should contain things the user can actually do.

## Verification Criteria (for this skill)

- Review demonstrates at least four distinct Owl perspectives.
- Predictive outlook section exists and is not generic.
- Recommendations are prioritized and include some notion of effort/impact or sequencing.
- When the target involves the user's AI tooling or unification, the review itself uses or references the canonical skills and schema.
- The review would still be valuable 12 months from now (not just current-state snapshot).

Use subagents liberally for parallel lens application when the target is large. This is exactly the kind of high-agency, high-judgment work that benefits from structured parallelism.