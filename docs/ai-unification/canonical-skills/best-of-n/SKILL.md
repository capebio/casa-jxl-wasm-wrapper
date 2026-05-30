---
name: best-of-n
description: >
  Implement a task N ways in parallel using isolated worktrees, rigorously evaluate all candidates using correctness-first criteria plus code quality and safety, then apply the winner.
  Use when asked to "best of n", "try multiple approaches", "parallel implementations", "/best-of-n", "/bon", or any time you want higher quality output by exploring the solution space instead of taking the first path.

version: "0.2.0-canonical"
canonical-id: "grand-unification:parallel:best-of-n:2026-05"

when-to-use: |
  - "best of n"
  - "try multiple approaches"
  - "parallel implementations"
  - "/best-of-n"
  - "/bon"
  - "explore a few different ways to do X"
  - High-stakes or creative implementation where first-try quality is insufficient

argument-hint: "[N] <task description>"

arguments:
  - name: n
    type: integer
    description: "Number of parallel candidates (2-10, default 3)"
    required: false
    default: 3
  - name: task
    type: string
    description: "The task to implement in multiple ways"
    required: true

surfaces:
  - grok

tags:
  - parallel
  - quality
  - acceleration
  - unification

categories:
  - execution
  - meta

verification-criteria:
  - "N distinct candidates are actually spawned in isolated worktrees (not sequential or same context)"
  - "Evaluation is done only after all candidates complete and uses the explicit criteria (Correctness > Code Quality > Safety)"
  - "The winner is chosen with clear reasoning; a comparison table or structured findings are presented before applying changes"
  - "The winner's changes are reviewed in the main context and any remaining issues fixed before final response"
  - "If the target involves existing code, graph tools (impact radius, affected flows) are consulted during evaluation to understand blast radius"
  - "Response ends with WINNER: <number> and the applied changes are the result of the tournament, not the agent's original plan"

references:
  - path: references/evaluation-criteria.md
    purpose: "Detailed, canonical evaluation rubric with examples and anti-patterns"
  - path: references/parallel-best-practices.md
    purpose: "How to structure prompts for independent candidates and avoid common failure modes in tournaments"

license: Personal
last-unified: "2026-05-30"
changelog:
  - "0.2.0-canonical: Enriched with full schema fields, explicit verification-criteria, graph integration during evaluation, and stronger separation of exploration vs selection."

metadata:
  grok:
    requires_worktree_isolation: true
    uses_task_tool_for_parallelism: true
    benefits_from_code_review_graph: true
---

# Best-of-N — Parallel Solution Tournament

When first-try quality isn't good enough, explore the space in parallel and select rigorously.

This skill is a core accelerator. It turns "one good idea" into "the best of several good ideas" with relatively low extra cost when subagents + worktrees are available.

## Usage

`/best-of-n [N] <task>`

- N defaults to 3 if omitted.
- Valid range: 2-10 (higher N increases exploration but also context and time cost).

## Core Loop (Strict)

1. Parse N and task.
2. Spawn N independent subagents **in one turn** using the `task` tool:
   - Each gets its own worktree isolation.
   - Prompt explicitly tells them they are one of N independent implementations.
   - `run_in_background: true`
3. Block until all complete using `wait_tasks` or equivalent.
4. Evaluate all candidates using the rubric below.
5. Select winner, present structured comparison.
6. Apply the winner's changes to main workspace (via the appropriate merge/apply mechanism).
7. Review the merged result in context and fix any remaining problems.
8. End response with `WINNER: <number>`.

## Evaluation Criteria (Canonical Order)

**1. Correctness (Highest weight)**
- Does it fully solve the stated task?
- Does it handle the requirements completely?
- Are there logic errors, type errors, missing cases, or broken behavior?

A candidate that is correct but ugly beats one that is elegant but incomplete or wrong.

**2. Code Quality**
- Clean, readable, well-structured?
- Follows existing patterns and conventions in the codebase?
- Avoids unnecessary complexity or cleverness?

**3. Safety**
- Introduces no new bugs, security issues, or breaking changes to unrelated functionality?
- Scope is appropriately limited to the task?

## Graph Integration (New Canonical Requirement)

When the task touches existing code:
- During evaluation, use code-review-graph tools (especially `get_impact_radius` and `get_affected_flows`) to understand which execution paths and modules each candidate actually touches.
- Prefer candidates that solve the problem with minimal unnecessary blast radius.
- Document any graph findings in the evaluation (e.g., "Candidate 2 touches 2 critical auth flows; Candidate 3 touches 7...").

See `references/evaluation-criteria.md` for the full rubric and examples.

## Anti-Patterns to Avoid

- Running candidates sequentially (defeats the purpose).
- Evaluating before all candidates finish.
- Letting your own "preferred" approach bias the selection.
- Applying changes without a final review pass in the main context.
- Choosing based on style when correctness differs.

## Verification Criteria (for this skill)

- All N candidates ran in true isolation.
- Evaluation followed the Correctness > Quality > Safety order with evidence.
- Graph tools were used when relevant to the task.
- The final applied result is the winner's work (reviewed and cleaned up), not a hybrid invented by the main agent.
- Response contains the structured comparison and ends with the WINNER declaration.

This skill rewards thorough exploration. Use it when the cost of being wrong is high or when you want the best possible implementation rather than a "good enough" one.