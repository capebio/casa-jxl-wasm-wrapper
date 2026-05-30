# AI OS Grand Unification — Phase 1

This directory contains the artifacts for converging your fragmented skill and agent ecosystems (Grok, Claude Code, Cursor, .agents Epic, Superpowers/Caveman) into a single canonical source of truth with projectors.

**Current status:** Strong acceleration — 7 canonical skills. `autoclear` v0.3 uses `N-Description` tab titles (no padding, number+hyphen first) so truncation reliably shows the sequence (e.g. "3-Refa...").

## Directory Layout

- `canonical-skill-schema.md` — The living v0.1 spec (enriched Markdown + YAML frontmatter superset)
- `canonical-skills/` — The single sources of truth (one directory per skill)
  - Each contains `SKILL.md` (canonical) + optional `references/`, `scripts/`, `evals/`
- `projectors/` — Code that turns canonical sources into native formats for each surface
- `decisions/` — ADRs for schema changes, projector strategy, scope decisions
- `roadmap.md` — Overall Grand Unification plan and progress (to be created)

## Guiding Principles (from the Owl review)

- **Convergence over proliferation** — One canonical definition, many projections.
- **Judgment > Scaffolding** — Preserve the taste, verification criteria, and hard-won heuristics. The dispatch mechanics can be simplified later.
- **Dogfood immediately** — The unified creation skill should be usable to create the next unified skill.
- **code-review-graph is mandatory** — Any review, planning, exploration, or creation skill must use code-review-graph tools (impact radius, affected flows, semantic search, minimal context, etc.) *before* raw grep/read when working with existing code. This is non-negotiable.

## Operating Rules for Unification Work (Enforced Here)

All work in `docs/ai-unification/` and all canonical skills produced from it must follow these rules:

1. **Graph first.** For any analysis of existing code or systems, call the code-review-graph MCP tools early.
2. **Verification gates.** Use the canonical `check-work` (or its descendants) before claiming any unification artifact or migration is complete.
3. **Dogfood.** Use `create-skill`, `unify-skill`, and `owl` on the unification effort itself whenever possible.
4. **Evidence over narrative.** Every claim in reviews or migration notes must cite specific files, graph findings, or observable behavior.
5. **Update the roadmap.** After any significant step, update `unification-roadmap.md`.

## Phase 0 Scope (Meta / Creation Cluster)

Per direction: start with skills whose purpose is creating, discovering, and improving other skills.

First targets:
- `create-skill` (unified from Grok create-skill + Claude skill-creator)
- `find-skills`
- Related plugin-dev / skill-development pieces as needed

## How to Work Here

1. Author or enrich a canonical `SKILL.md` in `canonical-skills/<name>/`
2. Run the relevant projector(s)
3. Test the projected skill on the target surface
4. Feed learnings back into the canonical source and this schema doc
5. Record decisions in `decisions/`

## Related Documents

- Owl Strategic Document (parent directory)
- The individual Strategic_overview*.md files in this project's docs

---

*This is infrastructure work that increases leverage on every future project, including CasaWASM / raw-converter-wasm itself.*