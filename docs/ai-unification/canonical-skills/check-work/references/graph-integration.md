# Graph Integration for Verifiers

When the session being verified involved changes to an existing codebase, the verifier should use the code-review-graph MCP tools early and often.

## Why

Raw file reading and grep give local views. The graph gives structural context:
- Impact radius of changed files
- Execution flows that touch the changed areas
- Community boundaries (which parts of the system are tightly coupled)
- Bridge nodes and surprising connections

This dramatically improves the quality of "what was actually affected" and "did the change touch the right things" analysis.

## Recommended Usage in Verification

1. After collecting the diff, run `get_impact_radius` or `get_affected_flows` on the changed files.
2. Use `semantic_search_nodes` or `traverse_graph` when you need to understand relationships the agent claimed.
3. Use `get_minimal_context` when you want to read only the structurally relevant parts of a file instead of the whole thing.
4. Reference specific graph findings in your verification report (e.g., "The change touches 3 critical flows according to the graph...").

## When to Skip

- Purely new code with no existing structure to analyze.
- Non-code tasks (documentation, process changes, pure research) where the graph has nothing useful to say.

## Enforcement

Future versions of check-work and related verification skills should treat early graph usage as a positive signal in Phase B and a mild negative signal when it was obviously relevant but not used.