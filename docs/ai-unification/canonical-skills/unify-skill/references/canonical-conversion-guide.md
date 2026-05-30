# Canonical Conversion Guide (Draft)

Rules and patterns for migrating legacy skills into Grand Unification canonical form (v0.1).

## General Process

1. Read the full source skill + all its declared assets.
2. Identify the *judgment kernel* — the parts that encode taste, hard constraints, verification order, and "why".
3. Map frontmatter:
   - `name` → usually keep or slightly clean
   - `description` → merge best trigger phrases from all known surfaces + make it unification-aware
   - Add `verification-criteria` (this is often the biggest upgrade)
   - Add `canonical-id`, `version`, `last-unified`, `surfaces`
4. Restructure body for progressive disclosure.
5. Extract long prompts, schemas, and surface-specific details into `references/`.
6. Declare scripts and references explicitly in frontmatter.
7. Add a migration note in `changelog`.

## Common Upgrades During Canonicalization

- Turn implicit "success looks like X" into explicit `verification-criteria` list.
- Add `when-to-use` with concrete phrases if the original only had a vague description.
- Ensure every multi-stage loop has clear entry and exit criteria.
- Make sure the skill can be used by a verifier subagent without the original author's context.

## Things That Often Need Improvement

- Legacy descriptions that are too vague or too surface-specific.
- Missing explicit verification steps (very common).
- Hard-coded assumptions about the user's environment or other skills.
- Over-reliance on "the model will just know" instead of clear contracts.

## What Not to Over-Preserve

- Surface-specific implementation details (e.g. exact `search_replace` usage on Grok, or specific `claude` CLI commands) — move these to surface notes sections or separate projectors.
- Temporary workarounds that were only needed because of limitations in one tool.

## After Conversion

- Always run the new canonical skill through its own verification-criteria.
- Consider using the `unify-skill` skill again on the result if it was complex (recursive dogfooding is encouraged).
- Update the unification roadmap with any schema or process learnings.