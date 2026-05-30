# Description Best Practices (for Triggering)

The `description` field is the single most important piece of a skill for auto-invocation.

## Core Rules

1. **Specificity beats generality.** "Create a well-formatted conventional commit from staged changes" > "Help with git commits".

2. **Include the actual phrases users say.** If people say "/commit", "make a commit", "conventional commit", "git commit", put several of them in the description.

3. **Be slightly pushy (Claude surfaces).** Claude tends to under-trigger. Good descriptions say "Use this skill whenever the user mentions X or asks to Y, even if they don't explicitly name the skill."

4. **Stay honest (Grok surfaces).** Grok and strict surfaces penalize over-triggering. Balance the pushiness with accuracy.

5. **One skill, one clear job.** If a description tries to cover three unrelated workflows, split the skill.

## Good vs Bad Examples

**Bad (too vague):**
> Helps with documentation and writing tasks.

**Good:**
> Create, edit, or extract content from .docx files. Use whenever the user mentions a Word document, .docx file, "make a report", "letter", "memo", or wants to convert between docx and other formats.

**Good (with slash command):**
> Interactively create a new Grok skill (SKILL.md + optional scripts/references). Use when the user wants to create a skill, scaffold a skill, or runs /create-skill or /skillify.

## Length

Aim for 1-4 sentences. Long enough to be specific and contain trigger phrases. Short enough that it doesn't bloat every context that loads available skills.

## After Writing

- Test manually by describing tasks in the user's natural language.
- For high-value skills, consider running description optimization loops (Claude side) or equivalent A/B testing on trigger rate.
- Update the canonical description when real usage reveals missing trigger phrases.