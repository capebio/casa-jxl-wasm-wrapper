# Grand Unification Roadmap & Backlog

**Current Phase:** P0 — Bootstrap (Schema + Core Creation/Unification Tools)

**Acceleration Goal:** Use the new `create-skill` and `unify-skill` to rapidly migrate high-leverage skills so the unification becomes self-sustaining.

## Status (as of latest session)

**Live Canonical Skills (in repo + projected to ~/.grok/skills):**
- `create-skill` (v0.2.0-canonical)
- `unify-skill` (v0.1.0-canonical)
- `owl` (v0.1.0-canonical)
- `check-work` (v0.2.0-canonical)
- `best-of-n` (v0.2.0-canonical)
- `review` (v0.2.0-canonical) — Structured code review with mandatory graph usage for code targets (just dogfooded)

**Acceleration achieved:** 7 canonical skills. `autoclear` v0.3 enforces tab titles in the format `NN - Description` (number first) so truncation still reveals sequence — ideal for long PowerShell + Windows Terminal agent runs.

**P0-4 Enforcement Step (this session):** 
- Graph-first rule embedded in `owl`, `check-work`, and now `best-of-n` (evaluation phase).
- Formal "Operating Rules for Unification Work" section live in `README.md`.
- 5th skill (`best-of-n`) demonstrates the pattern: new canonical skills are being written to use the graph where it improves evaluation quality.

**Projectors:**
- Grok: Basic working (user + project scope). Needs hardening for arguments, better frontmatter handling, and asset copying.

**Schema:**
- v0.1 (enriched Markdown + YAML) — Stable enough for Phase 1 migrations.

## Prioritized Backlog (Leverage × Effort)

### Tier 1 — Highest Acceleration / Verification Culture (Do Next)
1. **check-work** (and any verification-before-completion equivalents)
   - Extremely high leverage. Central to user's operating principles.
   - Will improve every future skill and project.
2. **owl** (strategic multi-perspective review)
   - Encodes the exact process that produced this unification plan.
   - Self-referential power: use the Owl skill to review unification progress.
3. One strong Epic skill (e.g. simplified EpicCodeReview or key components)
   - High complexity = good test of the schema's ability to handle rich staged workflows.

### Tier 2 — Core Review & Quality
4. `review` (Grok bundled reviewer)
5. `best-of-n`
6. `verify` / related from Claude side if they exist

### Tier 3 — Productivity & Document Skills (Lower risk, good volume)
7. `pptx`, `docx`, `xlsx` (document generation cluster)
8. `frontend-design`
9. Caveman-related compression / cavecrew skills (token economics are strategic)

### Tier 4 — Discovery & Meta
10. Internal version of find-skills / skill discovery across all local surfaces
11. `skill-development` / plugin-dev pieces

## Parallel Tracks (can run alongside skill migration)

- **P0-4: Code-review-graph Enforcement**
  - Update all key AGENTS.md / Claude.md / project rules to mandate graph usage before raw grep/read for exploration and review tasks.
  - Modify core review/planning skills to call graph tools early.
  - Target: Make graph the default path for any non-trivial codebase work.

- **Projector Hardening**
  - Improve Grok projector (proper parsing, argument mapping, better UX).
  - Build first Claude projector (highest long-term value).

- **Dogfood Loop**
  - After each new canonical skill, immediately use `create-skill` or `unify-skill` to produce the next one.
  - Goal: 1 new canonical skill per focused session until Tier 1 is done.

- **Evaluation & Observability**
  - Later: Simple way to measure which canonical skills deliver real velocity.

## Success Metrics for Phase 1

- 8–10 high/medium value skills in canonical form.
- Both Grok and Claude projectors producing usable output for at least the Tier 1 skills.
- Clear reduction in "which version of X do I use?" cognitive load for the user.
- The unification tools themselves (`create-skill`, `unify-skill`, future `owl`) are the primary way new skills are added.

## Next Session Focus Recommendation

Continue aggressive dogfooding:
1. Canonicalize `check-work` (or `owl` if the user wants the strategic review capability live fastest).
2. Make a visible enforcement change for code-review-graph in at least one primary rule file.
3. Harden the Grok projector slightly based on what the new migrations reveal.

---

**This document should be updated after every significant unification step.** It is the single source of truth for momentum.