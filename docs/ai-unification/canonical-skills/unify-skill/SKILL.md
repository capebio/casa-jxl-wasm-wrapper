---
name: unify-skill
description: >
  Help convert existing skills from any surface (Grok, Claude plugins, .agents Epic, Cursor, Superpowers, marketplace-cache) into the new Grand Unification canonical format.
  Use when the user wants to "canonicalize this skill", "bring this skill into the unification", "convert skill to canonical schema", "unify-skill", or is working on the Grand Unification effort and needs assistance migrating skills while preserving verification criteria, rich workflows, and trigger quality.

version: "0.1.0-canonical"
canonical-id: "grand-unification:meta:unify-skill:2026-05"

when-to-use: |
  - "canonicalize this skill"
  - "convert this skill to canonical"
  - "bring X into the unification"
  - "unify this skill"
  - "migrate skill to new format"
  - Working on Grand Unification and need help porting an existing skill

argument-hint: "<path to existing skill or description of skill to unify> [--target-name <new-name>] [--from-surface grok|claude|agents]"

arguments:
  - name: source
    type: string
    description: "Path to an existing SKILL.md or description of the skill to convert"
    required: true
  - name: target_name
    type: string
    description: "Desired canonical skill name (kebab-case)"
    required: false
  - name: from_surface
    type: "grok | claude | agents | cursor | superpowers"
    description: "Original surface the skill came from (helps with mapping)"
    required: false

surfaces:
  - grok
  - claude

tags:
  - meta
  - unification
  - skill-migration
  - grand-unification
  - dogfood

categories:
  - creation
  - meta
  - unification

verification-criteria:
  - "The output canonical SKILL.md follows the exact structure and required fields from canonical-skill-schema.md v0.1"
  - "All valuable trigger phrases, workflows, embedded prompts, and verification logic from the source are preserved or improved"
  - "verification-criteria section is present and concrete (not generic)"
  - "references/ and scripts/ are declared correctly and any important assets are copied or linked"
  - "The new canonical version is at least as good as (ideally better than) the original at its core job"
  - "Changelog entry is added noting the source surface and date of canonicalization"

references:
  - path: references/canonical-conversion-guide.md
    purpose: "Step-by-step mapping rules from common legacy surfaces to canonical form"
  - path: references/preservation-checklist.md
    purpose: "What must be kept when migrating (judgment, verification taste, hard constraints)"

license: Personal
last-unified: "2026-05-30"
changelog:
  - "0.1.0-canonical: Initial version created via dogfooding the unified create-skill"

metadata:
  grok:
    supports_subagents: true
  claude:
    supports_evals: false   # for now; this skill is more analytical
---

# Unify Skill

Assist with the Grand Unification by converting legacy skills from any surface into high-fidelity canonical form.

This is a core meta-skill for the unification effort. Dogfood it heavily.

## When to Use

- User points at an existing skill (Grok bundled, Claude plugin skill, .agents Epic, Superpowers/Caveman, etc.) and says "canonicalize this" or "bring this into the unification".
- You are doing unification work and need a systematic way to migrate the next skill while protecting its unique value (especially verification criteria and encoded judgment).
- You want to compare two versions of a capability across surfaces and produce the best canonical merge.

## Core Workflow

### Step 1: Identify the Source Skill

Ask for (or locate) the source:
- Full path to a SKILL.md (or .md that functions as one)
- Or the name + surface (e.g. "the review skill from .claude/plugins" or "caveman from marketplace-cache")

Read the entire source skill (and its references/scripts if relevant).

### Step 2: Analyze Value & Structure

Before writing anything, explicitly answer in your thinking:

1. **What is the irreplaceable judgment or taste** in this skill? (This must survive.)
2. **What are its strongest verification / success criteria?** (Extract or improve them.)
3. **What workflows / embedded prompts / multi-stage loops** make it powerful?
4. **Which frontmatter fields** from the legacy version map cleanly to canonical, and which need enrichment (especially `verification-criteria`, `when-to-use`, `surfaces`)?
5. **What assets** (scripts, references, evals) should be brought along?

Document any gaps or weaknesses you notice in the source (this is valuable signal for the canonical version).

### Step 3: Choose Target Name & Scope

Propose a clean kebab-case `name` for the canonical version (may differ from legacy for clarity).

Decide whether this belongs under the current unification effort (inside `docs/ai-unification/canonical-skills/` in this repo) or should be projected more broadly later.

### Step 4: Draft the Canonical Version

Create a new directory under `canonical-skills/<target-name>/`.

Write `SKILL.md` following the v0.1 schema exactly:

- Rich `description` with trigger phrases from both the original and new unification context.
- Full `verification-criteria` (make them concrete and testable).
- Proper `references` and `scripts` declarations.
- `changelog` entry noting the migration source and date.
- Body that preserves (and where possible improves) the original logic, with clear sections.

Extract long material into `references/` as needed.

If the original had excellent embedded prompts or multi-agent logic, keep them but label their origin.

### Step 5: Validate Against Schema

Run any available validation (e.g. the stub in create-skill or future stricter checker).

Manually review against `canonical-skill-schema.md`:

- All required + strongly recommended fields present?
- Description specific and trigger-effective?
- Verification criteria actionable?
- No loss of critical judgment or constraints?

### Step 6: Present for Review + Iterate

Show the user (or a verifier subagent) the diff between the original and the new canonical version.

Focus the review on:
- Did we preserve the soul of the skill?
- Is the new version easier to project to other surfaces?
- Are the verification-criteria stronger?

Incorporate feedback by editing the **canonical source** only.

### Step 7: Record the Migration

Add a clear entry in the unification changelog / decisions if this migration revealed schema gaps or new patterns.

Update the main unification README or roadmap if this was a significant skill.

## Important Principles for Unification

- **Judgment over scaffolding**: If the original had brilliant taste or hard-won rules ("never do X without Y", specific verification orders, etc.), those must be front and center in the canonical body.
- **Verification culture is non-negotiable**: Every canonicalized skill must leave the process with better or equal explicit verification-criteria than it arrived with.
- **Improve, don't just translate**: Where the canonical schema gives us new power (e.g. explicit `surfaces`, `verification-criteria`, `metadata`), use it.
- **Cite sources**: In the changelog and comments, note where the best parts came from (Grok, Claude skill-creator, Epic, Caveman, etc.).
- **Dogfood**: After finishing a unification, consider using this skill (or create-skill) on the next candidate.

## Surface-Specific Migration Notes (start here, expand in references)

**From Grok native skills:**
- Usually clean frontmatter. Add `verification-criteria`, `surfaces`, `canonical-id`, and `last-unified`.
- Argument handling is already good — map to canonical `arguments` array.

**From Claude plugin skills (especially Superpowers / skill-creator family):**
- Often extremely rich workflows and eval machinery.
- The hard part is deciding what belongs in the main body vs references vs separate skills.
- Preserve the "why" explanations and anti-surprise rules.

**From .agents Epic skills:**
- Very strong self-direction, no-go lists, and staged processes (collect → finders → verify → plan → fix → progress-review).
- These patterns are gold for the unification. Extract the judgment rules into references where possible.

**From Caveman / compression skills:**
- Extreme focus on token economics and terse communication.
- The compression rules and intensity levels are high-value and should become first-class in any affected canonical skills.

## Output Contract

When done, the user should have:
- A new directory `canonical-skills/<name>/` with a complete, schema-compliant `SKILL.md`
- Any necessary references and scripts copied or declared
- A clear record of what was gained and what (if anything) was intentionally left behind during canonicalization

Never claim a skill is unified until it passes the verification-criteria you defined for *this* skill.

## Verification Criteria (for using this skill)

- The produced canonical skill is valid per the current schema document.
- No important trigger phrases, constraints, or verification logic were lost.
- The canonical version is clearly better positioned for multi-surface use than the source was.
- The migration is documented (changelog + any decisions captured).
- You (or a verification subagent) have reviewed the result against the source before presenting it as complete.