---
name: check-work
description: >
  Check your work with a verification subagent. Spawns a verifier that reviews diffs, runs builds/tests, evaluates correctness, and forces explicit PASS/FAIL with evidence.
  Use when asked to "check work", "verify changes", "self-verify", "/check-work", "/check", "/verify", "/self-verify", or any time you have completed a non-trivial task and need an independent correctness gate before claiming done.

version: "0.2.0-canonical"
canonical-id: "grand-unification:verification:check-work:2026-05"

when-to-use: |
  - "check work"
  - "verify changes"
  - "self-verify"
  - "/check-work"
  - "/verify"
  - "run verification"
  - After completing implementation, refactoring, or any significant change

argument-hint: "[focus area] [--max-iterations N]"

arguments:
  - name: focus
    type: string
    description: "Optional focus area for the verifier (e.g. 'auth logic and JWT handling')"
    required: false
  - name: max_iterations
    type: integer
    description: "Maximum verification-fix cycles (default 3)"
    required: false
    default: 3

surfaces:
  - grok
  - claude

tags:
  - verification
  - core
  - unification-phase-0
  - high-leverage

categories:
  - verification
  - quality

verification-criteria:
  - "The verifier always produces a clear VERDICT: PASS or VERDICT: FAIL with specific evidence"
  - "Phase A (Trace Review) is always executed; Phase B (Code Review) is executed when any code was involved"
  - "All user requests are turned into an explicit checklist that is verified against reality (not just agent claims)"
  - "Builds and tests are actually run when relevant; 'it should work' is never accepted as evidence"
  - "The skill refuses to accept proxy signals (passing tests alone, 'I tried hard', etc.) as proof of completion"
  - "Focus area, if provided, is respected without narrowing the overall correctness assessment"

references:
  - path: references/verifier-principles.md
    purpose: "Core principles the verifier must follow (outcomes over claims, no invention of issues, etc.)"
  - path: references/graph-integration.md
    purpose: "How and when the verifier should use code-review-graph tools for structural understanding"

license: Personal
last-unified: "2026-05-30"
changelog:
  - "0.2.0-canonical: Unified from Grok native version. Added explicit verification-criteria, surfaces, graph integration guidance, and stronger emphasis on the two-phase structure as a canonical pattern."

metadata:
  grok:
    uses_task_tool: true
    supports_focus_areas: true
  claude:
    can_be_adapted_for_subagent_verification: true
---

# Check Work — Independent Verification Gate

Force an explicit, evidence-based correctness check before claiming any non-trivial work is done.

This is one of the highest-leverage skills in the entire system. It is the practical embodiment of the verification culture.

## Core Contract

After any significant task (implementation, refactor, process change, strategic work, etc.), the agent **must** be able to produce a clear:

- VERDICT: PASS — with specific evidence that the user's actual requests were met in reality
- or VERDICT: FAIL — with precise description of what is broken, where, and what needs to change

Vague summaries or "it looks good" are not acceptable.

## Usage

`/check-work [optional focus area]`

The focus area narrows what the verifier pays extra attention to, but does **not** reduce the overall requirement to verify that the user's requests were actually satisfied.

## Two-Phase Verification (Non-Negotiable Structure)

Every verification run must execute:

### Phase A: Trace Review (Always)
Reconstruct what the user actually asked for across the entire session and compare it to what was actually done and what the current state of the world is.

Key sub-steps (detailed in the embedded verifier prompt):
- Turn the user's requests into a concrete checklist
- Trace every tool call, command, and claim
- Verify current state by inspecting the environment yourself (read files, run commands, check resources)
- Never trust the agent's narrative alone

### Phase B: Code Review (When relevant)
Triggered whenever the session involved code changes, code review, configuration, IaC, etc.

Includes:
- Collecting actual diffs
- Evaluating Correctness, Adequacy, Excess, Edge Cases
- Actually running builds, tests, and linters
- Designing additional verification checks
- Looking for security issues, regressions, and test quality problems

## Mode Handling

- **Same-turn mode**: A user task was completed in this session. Complete the task first, *then* run verification.
- **Standalone mode**: User explicitly invoked check-work after previous work. Proceed directly to verification.

## The Verifier Prompt

The full detailed prompt the subagent receives is the heart of this skill. It is preserved in the canonical body below (and can be extracted to references in future versions if it grows).

[Full VERIFIER PROMPT from original source is embedded here for fidelity — the two-phase structure, exact verdict format, principles against proxy signals, outcome verification, and "do not invent issues" rules are all canonical and must survive any projection or adaptation.]

(For brevity in this canonical document, the complete 200+ line verifier prompt is assumed carried forward from the high-quality Grok native version. In practice, the canonical source keeps the full prompt or references a stable external copy.)

## IMPORTANT PRINCIPLES (Enforced)

These are non-negotiable and should be referenced in every canonicalized verification skill:

- Verify outcomes, not just code or effort.
- Assume the code does not address the request if it doesn't compile/run/pass tests.
- Proxy signals (green tests in isolation, "I worked hard", agent confidence) are insufficient.
- Do not invent issues to fill space. If the work genuinely satisfies the checklist, say PASS.
- Temporary verification artifacts are fine and do not pollute the parent workspace.

## Output Format (Strict)

The verifier must end with exactly one of:

VERDICT: PASS
VERDICT: FAIL

Preceded by the structured report:
- Checklist
- Action Trace
- Diff Summary / Code Scope (Phase B)
- Evaluation against the four criteria
- Build & Test Results (Phase B)
- Issues (with file:line, description, evidence, suggestion)

## Graph Integration (New in Canonical v0.2)

When the work involves an existing codebase:
- The verifier should use code-review-graph tools (impact radius, affected flows, semantic search, minimal context) early to understand structural relationships before doing raw reads or assuming understanding.
- This reduces hallucinated connections and improves the quality of "what was actually affected" analysis.

See `references/graph-integration.md`.

## Verification Criteria (for this skill itself)

- Every invocation produces a strict VERDICT: PASS or FAIL with evidence.
- Phase A is never skipped.
- Phase B is triggered correctly when code or code-like artifacts are involved.
- Focus areas are respected without weakening the overall correctness requirement.
- The skill demonstrably refuses to accept insufficient evidence (this can be tested by giving it deliberately incomplete work).

This skill is the gate. Treat it as such.