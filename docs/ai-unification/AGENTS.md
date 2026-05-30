# AGENTS.md — Grand Unification Work

This directory contains the source of truth for the Personal AI OS Grand Unification effort.

## Mandatory Rules for All Work Here

1. **code-review-graph First**
   - Before using raw `grep`, `read_file`, or `list_dir` for exploration or impact analysis of existing code, you **must** call the code-review-graph MCP tools (semantic_search_nodes, get_impact_radius, get_affected_flows, traverse_graph, get_minimal_context, etc.).
   - This is non-negotiable. The graph gives structural context that raw scanning cannot.

2. **Verification Gates**
   - Before claiming any canonical skill migration, projector improvement, or roadmap update is "done", run the canonical `check-work` skill (or its direct equivalent) with a clear focus on the changes made.
   - VERDICT: PASS is required.

3. **Dogfood the Unification Tools**
   - Use `create-skill`, `unify-skill`, `owl`, `check-work`, and `best-of-n` on the unification effort itself whenever the task fits.
   - This is how we prove the system works and accelerate further.

4. **Update the Record**
   - After any significant canonical skill addition, projector change, or enforcement step, update:
     - `unification-roadmap.md`
     - This file if new rules emerge
   - Keep the status section in `README.md` current.

5. **Judgment > Ceremony**
   - Prefer small, high-signal canonical skills over bloated ones.
   - Preserve the "why" and the verification taste from source skills.
   - When in doubt, make it easier for the next person (or future agent) to continue the unification.

## Current Live Canonical Skills (reference)

See `unification-roadmap.md` for the prioritized backlog and latest status.

## Spirit

This work exists to reduce fragmentation and cognitive load across Grok, Claude, Cursor, and custom agent systems while protecting the user's strongest assets: rigorous verification culture, token economics discipline, and high-agency structured workflows.

Every change should make the overall system more convergent and more powerful, not just add another dialect.