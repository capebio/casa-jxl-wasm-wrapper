# Task 016-logic-3

**Finding:** progressionTarget !== 'final' with emitEveryPass=true silently behaves like progressionTarget='final', ignoring the requested stop point — packages/jxl-worker-browser/src/decode-handler.ts:486-489

**Status:** deferred

**Tests before:** pass (29/29)

**Tests after:** deferred (attempted fix failed test)

## Deferral Reason

The finding's title suggests the condition is inverted, but testing reveals the current logic is correct:

- When `progressionTarget="dc"` and `emitEveryPass=true`: condition `"dc" !== "final" && !true` = `false` → decoder continues, emits every pass ✓
- When `progressionTarget="dc"` and `emitEveryPass=false`: condition `"dc" !== "final" && !false` = `true` → decoder finishes after dc pass ✓
- When `progressionTarget="final"` and `emitEveryPass=true`: condition `"final" !== "final" && !true` = `false` → decoder continues ✓

Changing `!==` to `===` breaks the test "decode handler finishes worker session after early progression target progress without waiting for close", which expects early termination when `progressionTarget != "final"` and `emitEveryPass=false`. The current implementation correctly stops at the requested target only when not emitting every pass; when emitting every pass, it continues regardless of target. This is the intended behavior.
