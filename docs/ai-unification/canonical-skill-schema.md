# Canonical Skill Schema — Grand Unification v0.1

**Status:** Draft (P0 of Grand Unification Plan)  
**Date:** 2026-05-30  
**Location of canonical sources (Phase 1):** `docs/ai-unification/canonical-skills/` (this repo)  
**Goal:** Single source of truth for high-value skills that can be projected to Grok, Claude Code (plugins/skills), Cursor, and future surfaces with minimal loss of fidelity.

---

## Design Principles

1. **Pragmatic compatibility first** — Enriched Markdown + YAML frontmatter (exactly the style already used by Grok SKILL.md and most Claude skills). No new file formats for v0.1.
2. **Superset, not lowest common denominator** — Capture the richest semantics we actually use today (Grok's `when-to-use` + `argument-hint`, Claude's eval/benchmarking workflows, Epic-style self-direction, verification criteria, etc.).
3. **Projectors are lossy but honest** — A projector may drop or simplify fields that have no equivalent on the target surface. The canonical source remains authoritative.
4. **Description is king** — The `description` field remains the primary auto-invocation mechanism across all surfaces. Everything else is supporting structure.
5. **Verification & judgment are first-class** — This unification exists to protect and propagate your strongest asset (rigorous verification culture + encoded taste).

---

## Canonical Frontmatter (v0.1)

```yaml
---
# Required
name: skill-kebab-name          # 2-64 chars, lowercase letters/digits/hyphens
description: >-                 # Primary trigger text. Be "pushy" (Claude) and specific (Grok).
  What this skill does in 1-2 sentences.
  Include concrete trigger phrases and slash-command forms.

# Strongly recommended
version: "0.1.0"
canonical-id: "grand-unification:meta:create-skill:2025-05"   # stable identity across renames/forks

# Activation & interface
when-to-use: |
  - "create a skill"
  - "scaffold a new skill"
  - "/create-skill"
  - "skillify this workflow"
  # Free-form or structured list. Projectors map to the target's preferred style.
argument-hint: "<description of workflow> [--scope project|user]"
arguments:
  - name: description
    type: string
    description: "What the skill should accomplish"
    required: true
  - name: scope
    type: "project | user"
    description: "Where to install the skill"
    required: false
    default: "project"

# Cross-surface metadata
surfaces:
  - grok
  - claude
  - cursor
tags:
  - meta
  - skill-creation
  - unification-phase-0
categories:
  - creation
  - meta

# Verification & quality (core to your culture)
verification-criteria:
  - "Generated SKILL.md follows the exact frontmatter + body contract for the target surface"
  - "Description field is specific enough to trigger reliably without over-triggering"
  - "All referenced scripts/references exist and are correctly linked"
  - "Skill can be invoked via slash command and via natural language within 1 minute of creation"

# Bundled assets (optional but powerful)
references:
  - path: references/schemas.md
    purpose: "JSON schemas for evals, grading, and benchmark output"
  - path: references/best-practices.md
    purpose: "Writing style, progressive disclosure, and anti-surprise rules"
scripts:
  - path: scripts/package_skill.py
    purpose: "Package a finished skill into distributable .skill file"
    platforms: ["python"]

# Provenance & evolution
license: "Personal / MIT (choose per skill)"
authors:
  - "Original: Grok bundled + Superpowers skill-creator"
  - "Canonicalized: GrokIsTheOwl unification 2026-05"
last-unified: "2026-05-30"
changelog:
  - "0.1.0: Initial canonicalization from Grok create-skill + Claude skill-creator"

# Free-form surface hints (projectors may use or ignore)
metadata:
  grok:
    supports_subagents: true
    preferred_scope_default: "project"
  claude:
    supports_evals: true
    supports_blind_comparison: true
    has_skill_creator_evolution_loop: true
---
```

**Rules for the frontmatter:**
- Unknown fields are preserved in the canonical source and may be passed through or mapped by projectors.
- `description` must contain the trigger phrases. Do not rely on `when-to-use` alone for auto-invocation on any surface.
- `verification-criteria` is mandatory for any skill that participates in your verification culture (most should).

---

## Body Structure (Markdown)

The body remains normal, high-quality Markdown. Recommended top-level sections for complex skills (use only what applies):

```markdown
# Skill Display Name

One-paragraph summary.

## When to Use

## Core Workflow / Steps

## Embedded Prompts / Verifier Prompts (if any)

## References & Scripts

## Surface-Specific Notes

### Grok
### Claude
### Cursor

## Verification Criteria (repeat or expand the frontmatter list here for the agent)
```

Large embedded prompts or long reference material should be extracted to `references/` files and linked from the body (progressive disclosure).

---

## Projector Contract (v0.1)

### Grok Projector (canonical → native)
- Input: canonical `SKILL.md`
- Output: `SKILL.md` in `~/.grok/skills/<name>/` or project equivalent
- Mapping:
  - `name`, `description` → direct
  - `when-to-use`, `argument-hint`, `arguments` → preserved (Grok already supports some)
  - `verification-criteria` → added as a section or comment if not present
  - Unknown fields → kept in frontmatter (harmless)
- Post-processing: ensure directory + reload hint

### Claude Projector (canonical → plugin skill)
- Input: canonical `SKILL.md`
- Output: skill folder compatible with Claude Code plugins (or standalone `~/.claude/skills/`)
- Mapping:
  - `name` → used for directory and frontmatter
  - `description` → made "pushy" per Claude best practice (the projector can have a small rewrite pass)
  - `version` → preserved
  - `references` + `scripts` → copied into the target skill folder
  - `verification-criteria` → turned into explicit success checks inside the body
  - Rich workflow (evals, iteration, blind comparison) → if the canonical body references them, the projector ensures the corresponding scripts/references are present or notes the gap
- For full plugins: also generate minimal `plugin.json` / manifest entries if the skill is part of a larger plugin.

### Future Projectors
- Cursor rules / skills
- AGENTS.md fragments (for project-level rules)
- code-review-graph-aware skill variants

---

## First Batch (Meta / Creation Cluster) — Phase 0.1

Chosen per user direction:

1. **create-skill / skillify** (Grok native)
2. **skill-creator** (from Superpowers / marketplace-cache — the heavy lifter with evals, benchmarking, description optimization)
3. **find-skills** (discovery)
4. (Optional fourth) **skill-development** or the plugin-dev cluster if scope grows

These four will give us:
- A bootstrap loop (using the new unified creation skill to create more unified skills)
- Strong test of rich workflow + references + scripts
- Good coverage of both "simple interactive" and "full eval-driven evolution" ends of the spectrum

---

## Open Questions (to resolve before v0.2)

- How do we handle skills that are *mostly* the same logic but have surface-specific sub-prompts? (One body with `:::grok` / `:::claude` fences? Separate partial bodies?)
- Evaluation harness for the projectors themselves (golden canonical → rendered diff + manual review).
- Git + sync story: canonical lives here in raw-converter-wasm for now. How/when do we push updates to `~/.grok/skills/` and Claude plugin directories?
- Ownership of the heavy eval/benchmark scaffolding (currently lives deep in the skill-creator plugin). Does it become a first-class bundled reference in the canonical version?

---

## Success Criteria for P0 Completion

- [ ] Schema v0.1 documented and reviewed
- [ ] At least 2 skills from the meta cluster converted to canonical form in `canonical-skills/`
- [ ] Working (even if manual) Grok projector that produces a usable native skill
- [ ] Claude projector that produces a skill usable in Claude Code (at minimum the frontmatter + body + key references)
- [ ] The unified creation skill can be used to create the next unified skill (dogfood)
- [ ] Decision record written for any schema changes discovered during the first conversions

---

*This document itself will be updated as we learn from the first conversions. It is the living spec for Phase 1 of the Grand Unification.*