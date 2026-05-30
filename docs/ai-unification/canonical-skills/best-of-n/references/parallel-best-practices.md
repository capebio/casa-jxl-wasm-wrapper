# Parallel Best Practices for Best-of-N

## Prompting Independent Candidates

Each candidate prompt should:
- Explicitly say "You are candidate X of N independent implementations. Do not coordinate with others."
- Give the full task description.
- Ask them to summarize their approach and changes at the end (helps evaluation).
- Encourage them to use the full tool set available.

## Isolation Hygiene

- Always use worktree isolation.
- Never share state between candidates except through the final selection process.
- After selection, the winner's worktree is the source of truth for the merge.

## Common Failure Modes

1. **Candidate collapse** — All N candidates produce nearly identical solutions because the prompt was too constraining. Fix: Make the initial prompt more open-ended for the exploration phase.

2. **Evaluation bias** — Main agent favors the approach it would have taken anyway. Fix: Force a structured table comparison before declaring a winner.

3. **Premature merging** — Applying changes before all candidates finish or before structured evaluation. Fix: Strict adherence to the 8-step loop.

4. **Ignoring the graph** — When working on existing systems, evaluating candidates purely on surface appearance instead of structural impact. Fix: Mandate graph usage in evaluation for any non-greenfield task.

## When to Use Higher N

- 2: Quick sanity check on two very different approaches.
- 3 (default): Good balance for most non-trivial tasks.
- 5+: When the design space is genuinely wide and the cost of being suboptimal is high (architecture decisions, complex algorithms, user-facing flows with many constraints).

## Post-Tournament Cleanup

After applying the winner:
- Run a final `check-work` pass focused on the merged changes.
- Clean up any obvious style or integration nits the winner may have left.
- The final result should be better than any individual candidate because of the review step.