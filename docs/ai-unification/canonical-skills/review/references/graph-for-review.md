# Graph Usage in Reviews

When reviewing changes that touch existing code:

1. After diff collection, call code-review-graph tools on the list of changed files.
2. Prioritize:
   - `get_impact_radius` — what else is likely affected?
   - `get_affected_flows` — which execution paths go through the changed areas?
   - `get_bridge_nodes` or `get_surprising_connections` if the changes look architecturally risky.

3. Include the most relevant findings in the reviewer prompt so the persona can reason about blast radius and coupling, not just local diff hunks.

4. The reviewer is encouraged (but not required) to cite graph evidence in high-severity issues.

This turns a purely textual review into a structurally informed one — one of the highest-leverage upgrades available in the unification.