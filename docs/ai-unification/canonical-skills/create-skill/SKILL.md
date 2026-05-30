---
# Required
name: create-skill
description: >
  Interactively create, scaffold, or improve a new skill (SKILL.md + optional scripts/references/evals).
  Use when the user wants to create a skill, capture a workflow as a reusable skill, run /create-skill, /skillify,
  improve an existing skill's description or structure, or asks "turn this into a skill".

# Strongly recommended for unification
version: "0.2.0-canonical"
canonical-id: "grand-unification:meta:create-skill:2026-05"

when-to-use: |
  - "create a skill"
  - "scaffold a new skill"
  - "/create-skill"
  - "/skillify"
  - "turn this workflow into a skill"
  - "improve this skill's description"
  - "make a skill for X"

argument-hint: "<what the skill should do> [--scope project|user] [--with-evals]"

arguments:
  - name: description
    type: string
    description: "What workflow or capability the new skill should automate or guide"
    required: true
  - name: scope
    type: "project | user"
    description: "Installation scope (project = repo .grok/skills or equivalent; user = global)"
    required: false
    default: "project"
  - name: with-evals
    type: boolean
    description: "Whether to set up test cases + evaluation loop (recommended for non-trivial skills)"
    required: false
    default: false

surfaces:
  - grok
  - claude
  - cursor

tags:
  - meta
  - skill-creation
  - unification-phase-0
  - dogfood

categories:
  - creation
  - meta

verification-criteria:
  - "The generated skill has a high-quality, specific description field that will trigger reliably"
  - "Frontmatter follows canonical schema v0.1 (or the target's native equivalent after projection)"
  - "Body contains clear steps, success criteria, and references to any bundled assets"
  - "If --with-evals was requested, at least 2-3 realistic test cases are created with the user"
  - "User can invoke the new skill via slash command and natural language within 60 seconds of completion"
  - "All referenced scripts and references exist at the paths declared in the skill"

references:
  - path: references/skill-anatomy.md
    purpose: "Standard directory layout, progressive disclosure, and writing patterns"
  - path: references/description-best-practices.md
    purpose: "How to write trigger-effective descriptions for different surfaces"

scripts:
  - path: scripts/validate-skill-structure.py
    purpose: "Basic structural validation of a generated skill against the canonical schema"
    platforms: ["python"]

license: Personal
last-unified: "2026-05-30"
changelog:
  - "0.2.0-canonical: First unified version merging Grok create-skill interactivity with Claude skill-creator evaluation mindset and verification criteria"

metadata:
  grok:
    uses_search_replace_for_creation: true
    supports_subagents: true
  claude:
    supports_evals: true
    supports_description_optimization: true
    supports_packaging: true
---

# Create Skill (Canonical)

Interactively capture a repeatable workflow as a high-quality, triggerable skill on the target surface(s).

This is a **meta-skill** — use it to bootstrap more of the Grand Unification.

## Step 0: Determine Mode & Ambition

Before asking the user anything, detect context:

- Is there already a concrete workflow in the current session (repeated steps, corrections, file operations, a pattern the user wants to repeat)?
- Did the user explicitly say "turn this into a skill", "skillify", or run `/create-skill` on a fresh topic?
- Do they want a **light** skill (simple steps + good description) or a **heavy** skill (with evals, references, scripts, verification criteria, iteration loop)?

Ask one clarifying question if the ambition level is unclear:
> "Do you want a straightforward skill that just follows clear steps, or a more powerful one with test cases and an improvement loop?"

Default to **straightforward** unless the workflow is complex or the user says "with evals", "properly", or "like the skill-creator".

## Step 1: Capture Intent (One Question at a Time)

Ask the user the following, **one at a time** as normal conversation:

1. **Skill name** (kebab-case, 2-64 chars). Validate immediately.
2. **Scope** — Project (recommended, version-controllable) vs User (global). Default based on whether we are inside a git repo with a `.grok/` or equivalent.
3. **Core purpose** — What does this skill enable the agent to do that it currently has to be told every time? Get 1-2 sentences + 3-5 example trigger phrases from the user.
4. **Success criteria** — How will we (and the agent using the skill) know it did the job correctly? (This becomes `verification-criteria`.)

If `--with-evals` or the user wants a heavy skill, also ask:
5. "Should we set up 2-3 test cases so we can verify and improve the skill later?"

## Step 2: Draft the Description (The Most Important Part)

The `description` frontmatter field is the primary trigger mechanism on every surface.

Draft a description that is:
- Specific about what the skill does
- Contains the exact trigger phrases the user gave you
- Slightly "pushy" (Claude style) while remaining accurate (Grok style)

Show the draft to the user and iterate until they approve.

Example good description (for this skill itself):
> Interactively create, scaffold, or improve a new skill (SKILL.md + optional scripts/references/evals). Use when the user wants to create a skill, capture a workflow as a reusable skill, run /create-skill, /skillify, improve an existing skill's description or structure, or asks "turn this into a skill".

## Step 3: Generate the Canonical Source

Using the approved information, write a complete canonical `SKILL.md` following the structure in `references/skill-anatomy.md`.

Key requirements:
- Use the exact canonical frontmatter fields defined in the Grand Unification schema.
- Include a clear "Verification Criteria" section in the body (repeat + expand the frontmatter list).
- Extract anything long (detailed prompts, large examples, schemas) into `references/` files.
- If scripts are needed for deterministic work, declare them in `scripts/` and create stubs.

Write the file using the appropriate creation tool for the current surface (`search_replace` on Grok, equivalent on others). Use absolute paths.

## Step 4: Create Supporting Assets (if any)

- Create `references/` and `scripts/` directories as declared.
- For heavy skills: create the initial `evals/evals.json` skeleton with the test cases gathered in Step 1.
- Run any available structural validator (see `scripts/validate-skill-structure.py`).

## Step 5: Project & Install on Target Surface(s)

Once the canonical source exists:
- Run the Grok projector → install to the chosen scope.
- (Later) Run the Claude projector → produce a usable Claude Code skill or plugin component.
- Tell the user exactly how to invoke it on each surface:
  - Grok: `/<name>` and natural language
  - Claude: natural language using the description, or via plugin
- Demonstrate one successful invocation before finishing.

## Step 6: Verify (Non-Negotiable)

You **must** use the verification subagent / check-work pattern (or the canonical equivalent once it exists) before declaring the new skill complete.

The user (or you) should be able to:
- Invoke the skill via slash command
- Invoke the skill via natural language that matches the description
- See it produce correct output on at least one realistic task

If anything is broken, fix it in the **canonical source** first, then re-project.

## Embedded Principles (Always Follow)

- **Description is sacred.** Spend disproportionate time on it.
- **Progressive disclosure.** Keep the main SKILL.md under ~400-500 lines when possible. Push detail into references/.
- **Verification culture.** Every skill you create must have explicit, testable `verification-criteria`.
- **No surprise.** The skill must not contain hidden destructive behavior or requirements the description does not prepare the user for.
- **Dogfood.** After creating a skill, consider using the new skill (or this one) to improve the next one.

## Surface Notes

### Grok
- Prefers clear steps + `search_replace` for file creation.
- `argument-hint` and structured `arguments` are well supported.
- Subagent support (`task` tool) is excellent for heavy skills.

### Claude
- Benefits from "pushy" descriptions.
- Has mature support for evals, blind comparison, description optimization loops, and packaging (when the skill-creator scaffolding is present).
- The canonical version should declare `metadata.claude.supports_evals: true` when those assets are included.

### Cursor
- (To be expanded in a later projector pass)

## Verification Criteria (for this skill)

- Generated skill follows canonical frontmatter schema v0.1 (or clean native equivalent after projection).
- Description contains specific, realistic trigger phrases and will cause auto-invocation on the intended surfaces.
- User can successfully invoke the created skill both by slash command and by natural language within one minute.
- All declared references and scripts exist and are referenced from the body.
- If evals were requested, the initial `evals/evals.json` skeleton exists with at least two realistic test cases.
- The skill was verified (by you or a verification subagent) before you told the user it was ready.