~~~markdown
# Code Optimisation Review Lenses

Use these lenses sequentially. Do not optimise blindly. Each pass should look for:
- speed
- memory efficiency
- computational efficiency
- maintainability
- correctness
- future extensibility

Focus only on the specified files.

---

# Phase 1 — Strategic / Architectural Lens

## 1. System Role
Ask:

- What is this file's true responsibility?
- Is it doing work that belongs elsewhere?
- Is it becoming a coordinator, calculator, cache, or transport layer accidentally?

Look for:

- misplaced complexity
- unnecessary coupling
- architectural bottlenecks
- future migration blockers

---

## 2. Data Flow Lens

Trace:

input
→ transformation
→ processing
→ output

For every boundary ask:

- Is data copied?
- Is data converted unnecessarily?
- Is ownership clear?
- Is the lifetime clear?

Find:

- hidden copies
- repeated conversions
- unnecessary serialisation
- poor API boundaries

---

## 3. Pipeline Lens

Break the code into stages:

- input/decode
- validation
- transform
- compute
- aggregation
- output

For each stage:

- Can it be skipped?
- Can it be combined?
- Can it happen earlier/later?
- Can it be incremental?

---

# Phase 2 — Performance Lens

## 4. Hot Path Lens

Find code that executes:

- per pixel
- per element
- per tile
- per frame
- per request

Inspect:

- loops
- allocations
- function calls
- branching
- conversions

Ask:

"Does this need to happen this many times?"

---

## 5. Algorithmic Complexity Lens

Look for:

- O(n²) hidden inside loops
- repeated scans
- repeated reductions
- unnecessary sorting
- repeated searching

Consider:

- caching
- memoisation
- incremental updates
- spatial partitioning
- temporal reuse

---

## 6. Mathematical Optimisation Lens

Question the maths:

- Is the formula necessary?
- Can it be approximated safely?
- Can expensive operations become lookup tables?
- Can values be precomputed?
- Can operations be reordered?

Look for:

replace:

- division → multiplication
- sqrt/log/exp → approximations or tables
- repeated transforms → cached transforms
- expensive comparisons → bounds

---

# Phase 3 — Memory Lens

## 7. Allocation Lens

Find:

- arrays created inside loops
- temporary objects
- repeated typed array creation
- unnecessary cloning

Ask:

"Who owns this memory?"

---

## 8. Lifetime Lens

Classify every buffer:

- permanent
- per-operation
- temporary
- borrowed

Look for:

- memory retained too long
- caches growing forever
- references preventing GC
- accidental duplication

---

## 9. Data Layout Lens

Consider:

Array of structures:

```js
[
 {x,y,value}
]
~~~

versus:

Structure of arrays:

```js
{
 x:[],
 y:[],
 value:[]
}
```

Ask:

- Is this CPU cache friendly?
- Is this WASM/GPU friendly?
- Is transfer efficient?

------

# Phase 4 — Boundary Lens

## 10. Interface Lens

Inspect:

- JS ↔ WASM
- worker ↔ main thread
- module ↔ module

Ask:

- Are calls too granular?
- Are large objects crossing boundaries?
- Are abstractions leaking?

Prefer:

few large operations

over:

many tiny operations

------

## 11. Error / State Lens

Inspect:

- cancellation
- failure paths
- retries
- partial results
- invalid inputs

Look for:

- impossible states
- silent failures
- stale state
- race conditions

------

# Phase 5 — Feature / Future Lens

## 12. Extension Lens

Ask:

"If we wanted to replace this algorithm tomorrow, how painful?"

Look for:

- hard-coded assumptions
- fixed formats
- unnecessary dependencies

Add:

- interfaces
- adapters
- backend seams

Do not add complexity without purpose.

------

## 13. Information Lens

Ask:

"What information does this computation produce that is being thrown away?"

Look for:

- reusable intermediate values
- statistics
- gradients
- masks
- confidence values
- metadata

------

## 14. Progressive / Incremental Lens

If data arrives over time:

Ask:

"Why recompute what has not changed?"

Look for:

- deltas
- dirty regions
- previous-frame reuse
- convergence detection

------

# Phase 6 — Adversarial / Dark Lens

## 15. Reverse the Flow

Run the system backwards:

Output:
"What was needed to produce this?"

Find:

- unnecessary inputs
- unnecessary work
- missing metadata

------

## 16. Black Box Lens

Pretend this file is a service.

Ask:

- What is the smallest useful input?
- What is the smallest useful output?
- What assumptions does it make?

------

## 17. Future Scale Lens

Imagine:

10× image size
100× requests
real-time constraints

What breaks first?

Look for:

- memory explosions
- contention
- quadratic behaviour
- API limits

------

# Final Pass — Missing Pieces

After all lenses ask:

## What did we not question?

Check:

- Are we solving the right problem?
- Are we measuring the right thing?
- Are we producing the right output?
- Are we forcing today's architecture onto tomorrow's requirements?

Find the three darkest areas:

1. unexplored assumptions
2. hidden bottlenecks
3. future opportunities

------

# Final Output Format

Produce:

## Confirmed Issues

Only real problems.

## Proposed Optimisations

Include:

- reason
- expected impact
- implementation notes

## Architectural Opportunities

Longer-term improvements.

## Risks / Rejected Ideas

Anything tempting but harmful.

## Implementation Handoff

Group changes by file/component.
Include code where ambiguity exists.

```

```