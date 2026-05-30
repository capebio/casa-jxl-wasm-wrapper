# Autoclear Handoff Template

The agent must fill this out and save it to a predictable location (recommended: `$env:TEMP\autoclear-handoff-<slug>.md`).

```markdown
# AUTOCLEAR HANDOFF - [TAB_TITLE]

**Section**: [Number/Name]
**Completed**: [timestamp]
**Verification**: VERDICT: PASS via check-work (or equivalent)

**Tab Title** (must be in format N-Description): 4-Refactor Authentication Module

## Tab Title (for new terminal tab)
[TAB_TITLE]   ← e.g. "04-crocodile" or "Auth-Module-Review"

## What Was Accomplished
- Bullet list

## Key Artifacts & Locations
- `relative/or/absolute/path` — description

## Important Decisions & Rationale
- ...

## Current State / Todo Summary
(Include relevant todo items or state so the next instance can continue cleanly)

## Deferred Items
- ...

## Instructions for Next Section
[Clear, specific instructions for what the new agent should do next]
```

The new Grok instance should be told in its initial prompt: "Read the full handoff at [exact path]. The tab title for this session should be considered [TAB_TITLE]. Then begin the work."