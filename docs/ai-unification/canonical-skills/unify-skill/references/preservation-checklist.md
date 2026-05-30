# Preservation Checklist for Skill Unification

When canonicalizing a skill, protect these things above all else.

## Must Preserve

- **Core judgment and taste**: Any "never do this", "always check X before Y", specific ordering of verification steps, or hard-won heuristics.
- **Verification criteria**: If the original had any notion of "how do we know this worked?", make it stronger and explicit in the canonical version.
- **Trigger phrases**: All the natural language and slash commands that should cause the skill to activate.
- **Safety / no-go rules**: Anything the skill explicitly refuses to do or requires human ratification for.
- **Multi-stage structure**: The actual workflow logic (especially in Epic-style or skill-creator-style skills).
- **"Why" explanations**: The reasoning behind rules is often more valuable than the rules themselves.

## Should Usually Preserve

- High-quality embedded prompts (verifier prompts, grader prompts, etc.).
- References to external tools, MCPs, or scripts that the skill depends on.
- Examples that illustrate correct usage.

## Can Usually Be Improved or Restructured

- Surface-specific implementation details (how files are written on one particular tool).
- Temporary scaffolding that existed only to work around limitations of one surface.
- Overly chatty or repetitive prose (canonical skills benefit from tighter writing).

## Red Flags (Investigate Before Canonicalizing)

- The skill's power comes mostly from one very long embedded prompt with no structure — this may indicate it should be broken into multiple smaller canonical skills + references.
- The original has almost no verification thinking — this is a gap the canonical version must fill.
- Heavy dependence on a single tool's unique features with no abstraction — note this in metadata and surface notes.

Use this checklist explicitly while performing Step 2 of the Unify Skill workflow.