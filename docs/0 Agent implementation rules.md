Agent implementation rules (one-writer discipline)

1. Unique branch name. Name your branch <task>-<your-id> (or a random token) — never a generic/shared name (no final, fix, Decode_12, etc.). If you touch the submodule, give its branch a unique name too.
2. Your own worktree. Work in your own git worktree (sibling dir). Never checkout/switch/reset/rebase/stash the primary checkout, and never switch its branch.
3. Push early, push often. Push your branch to the remote immediately and after every milestone. Local-only work is one cleanup from gone.
4. Never touch main. Don't commit, push, merge, or rebase onto main, and don't bump the superproject's submodule gitlink. That's the integrator's job alone.
5. Know which repo. Superproject (packages/, web/, src/) and submodule (external/libjxl-012) are separate — branch + push each independently, both uniquely named.
6. Hand off, don't self-merge. When done, report your pushed branch name(s). One integrator lands work on main serially.