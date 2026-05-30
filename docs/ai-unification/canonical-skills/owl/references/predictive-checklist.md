# Predictive Checklist for Owl Reviews

Force yourself to answer these when writing the outlook section.

## Model & Tool Evolution
- In 12-18 months, which parts of the current custom orchestration will become redundant or much cheaper because base models are stronger at long-horizon planning, self-verification, and tool use?
- Which parts of our custom scaffolding will still be valuable (judgment kernels, domain taste, verification taste)?

## Maintenance & Drift
- What is the current maintenance tax of the AI OS (keeping skills in sync across surfaces, reconciling marketplace updates, etc.)?
- Is that tax growing linearly or super-linearly with the number of canonical + legacy skills?

## Feedback & Observability
- Where are we flying blind today (no data on which skills/patterns actually move velocity or quality)?
- What would a minimal telemetry / value measurement system look like, and why don't we have it yet?

## Security & Blast Radius
- As the AI OS becomes more powerful and trusted, how does the attack surface (skills executing code, subagents, worktrees, marketplace cache) grow?
- What assumptions about "trusted skills" will we regret?

## Self-Reference (Unification Specific)
- Is the Grand Unification reducing or increasing the number of places the user has to think about "which version of this capability do I use"?
- Are the unification tools themselves (create-skill, unify-skill, projectors) demonstrating the verification culture and graph usage they recommend?

Answer at least 4-5 of these explicitly in every serious Owl review. Vague "things will get better" is not predictive.