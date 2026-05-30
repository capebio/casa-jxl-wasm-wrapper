# Skill Anatomy (Canonical Reference)

Standard layout and patterns for skills in the Grand Unification.

## Directory Structure

```
skill-name/
├── SKILL.md                 # Required. Canonical enriched frontmatter + body
├── references/              # Optional but recommended for progressive disclosure
│   ├── *.md
│   └── ...
├── scripts/                 # Optional. Deterministic helpers (Python, JS, shell, etc.)
│   └── ...
├── evals/                   # For skills that support test-driven improvement
│   ├── evals.json
│   └── ...
└── assets/                  # Templates, images, fonts, etc. used in output
```

## Frontmatter Contract (v0.1)

See the parent `canonical-skill-schema.md` for the full superset.

Critical fields every skill must have:
- `name`
- `description` (the trigger text — this is the most important field on every surface)
- `verification-criteria` (list of concrete, checkable outcomes)

## Body Patterns

- Start with a short purpose statement.
- Use `## Steps` or `## Workflow` with numbered actions.
- Extract long prompts, schemas, or examples into `references/`.
- End complex skills with an explicit **Verification Criteria** section that the agent must satisfy before claiming success.
- Use imperative language ("Do X", "Run Y", "Never Z unless...").

## Progressive Disclosure Rules

- Metadata (name + description) is always loaded (~100 tokens).
- Full SKILL.md body is loaded when the skill triggers (target < 500 lines for most skills).
- References, scripts, and assets are loaded on demand or executed directly.

When a skill supports multiple domains or variants, split by subdirectory under `references/` (e.g. `aws.md`, `gcp.md`).

## Anti-Surprise & Safety

- Never hide destructive operations behind vague instructions.
- Declare all external commands, MCP tools, or side effects in the body or references.
- If the skill can modify the user's environment significantly, include explicit confirmation steps.

## Verification Culture

Every canonical skill must make it easy for a verifier (human or subagent) to answer:
- Did it do exactly what the user asked?
- Did it meet the declared `verification-criteria`?
- Did it avoid excess or hidden side effects?

This is non-negotiable for participation in the unified set.