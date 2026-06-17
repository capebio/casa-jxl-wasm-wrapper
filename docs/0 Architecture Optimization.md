# Architecture Optimisation Framework

## Core Principle

Most optimisation efforts start too low in the stack.

Engineers often jump directly to:

- SIMD
- multithreading
- compiler flags
- micro-optimisations

These can be valuable, but they rarely deliver the largest gains.

The highest leverage optimisation sequence is:

```text
Measure
→ Identify Bottleneck
→ Remove Movement
→ Change Representation
→ Fuse
→ Vectorise
→ Parallelise
→ Validate
```

The further left an optimisation occurs, the larger its potential impact.

------

# Level 1: Strategic Optimisation

Strategic optimisation asks:

> Is the architecture aligned with the problem being solved?

Most performance problems originate here.

A poor architecture can make every subsequent optimisation ineffective.

------

## Strategic Lens 1: Representation Drives Cost

The most important question:

> What is the unit of work?

Many systems accidentally choose an expensive representation.

Example:

```text
Progressive Decode
→ Full Frame
→ Full Frame
→ Full Frame
→ Full Frame
```

The architecture treats each progressive pass as an independent image.

This immediately forces:

- repeated memory movement
- repeated storage
- repeated analysis
- repeated rendering

The cost model becomes:

```text
Passes × Image Size
```

instead of:

```text
Passes × Metadata
```

Always ask:

> Is this representation fundamentally larger than necessary?

------

## Strategic Lens 2: Shared Artifacts Create Hidden Coupling

This is one of the most common architectural performance problems.

A single expensive object becomes the dependency of multiple systems.

Example:

```text
RGBA Frame
├─ Viewer
├─ Statistics
├─ Charts
└─ Export
```

All consumers become dependent on the most expensive representation.

As a result:

```text
Viewer requirements
=
System requirements
```

even when other subsystems do not need pixels at all.

------

### Preferred Architecture

Separate pipelines:

```text
Measurement Pipeline
    receives:
        hashes
        metrics
        timings

Visualization Pipeline
    receives:
        pixels

Export Pipeline
    receives:
        retained checkpoints
```

The most expensive representation should only exist where it is genuinely required.

This architectural separation often produces larger gains than SIMD or multithreading.

------

## Strategic Lens 3: Event-Centric vs Object-Centric Design

Many systems process objects when they should process events.

Example:

Current:

```text
Decoder
→ Frame
→ Frame
→ Frame
```

Better:

```text
Decoder Event
├─ Changed Region
├─ Perceptual Delta
├─ Timing
├─ Metadata
└─ Optional Frame
```

Most consumers do not require the full object.

They require information about the object.

------

## Strategic Lens 4: Explicit Memory Budgets

Never allow memory growth to emerge accidentally.

Bad:

```text
Store Everything
→ Trim Later
```

Good:

```text
Memory Budget
→ Retention Policy
→ Storage
```

Memory should be designed, not observed.

------

## Strategic Lens 5: Decouple Producers from Consumers

Avoid:

```text
Decode
→ Render
→ Continue
```

Prefer:

```text
Producer
→ Queue
→ Consumer
```

The producer should not inherit consumer latency.

------

# Level 2: Operational Optimisation

Operational optimisation asks:

> Which subsystems dominate runtime?

------

## Memory Bandwidth

Many image pipelines are not arithmetic constrained.

They are constrained by:

- memory reads
- memory writes
- cache misses
- GPU uploads

Reducing passes through memory often produces larger gains than faster mathematics.

------

## Zero-Copy

Data should ideally have:

```text
One Owner
Many Views
```

Avoid:

```text
Copy
→ Copy
→ Copy
→ Copy
```

Prefer:

```text
Transfer
→ View
→ Reuse
```

Every copy consumes bandwidth and cache capacity.

------

## Ring Buffers

For streaming workloads:

```text
Allocate Once
Reuse Forever
```

Instead of:

```text
Allocate
Store
Allocate
Store
Allocate
Store
```

use:

```text
Fixed Circular Buffer
```

Advantages:

- predictable memory
- bounded latency
- reduced fragmentation
- reduced GC pressure

------

## Fusion

Every pass over memory has a cost.

Avoid:

```text
Read Image
→ Compute Hash

Read Image
→ Compute Statistics

Read Image
→ Compute Variance

Read Image
→ Compute Perceptual Metrics
```

Prefer:

```text
Read Image Once
→ Compute Everything
```

Bandwidth savings frequently exceed arithmetic savings.

------

## Cache Locality

Processors are fast when data is nearby.

Design around:

```text
Sequential Access
```

Avoid:

```text
Random Access
```

whenever possible.

------

## Elasticsearch / Lucene Lens

High-performance systems often rely on:

- precomputation
- immutable structures
- batching
- sequential traversal
- skipping unnecessary work

Questions to ask:

- Can this be precomputed?
- Can lookup replace calculation?
- Can immutable state replace mutable state?
- Can random work become sequential work?

------

# Level 3: Tactical Optimisation

Only after strategic and operational issues are addressed.

------

## SIMD

SIMD performs:

```text
One Instruction
Many Values
```

Ideal for:

- pixel transforms
- comparisons
- reductions
- statistics
- color transforms

------

## AVX / AVX2 / AVX-512

Useful when:

- arithmetic dominates
- memory is already efficient

Always verify:

```text
Memory Bound?
or
Compute Bound?
```

before investing heavily.

------

## WASM SIMD

Portable SIMD for browser environments.

Ideal for:

- image processing
- change detection
- statistics
- downsampling
- transforms

------

## Multithreading

Different from SIMD.

```text
SIMD
=
One Core
Many Values
Multithreading
=
Many Cores
Many Tasks
```

They are complementary.

------

## LUTs

Replace expensive functions:

```text
log
exp
gamma
division
```

with:

```text
Lookup
+ Interpolation
```

when acceptable error bounds exist.

------

## AoS vs SoA

Array of Structures:

```text
RGBA RGBA RGBA
```

Structure of Arrays:

```text
RRRR
GGGG
BBBB
AAAA
```

SoA often enables:

- better SIMD
- better cache utilisation
- simpler vectorisation

------

## Symmetry Lens

Look for invariants.

Questions:

- Are equivalent states recomputed?
- Are transformations repeatedly applied?
- Can operations be composed?

Optimisation opportunities often emerge from recognising mathematical symmetry.

------

## Biological Representation Lens

Separate:

```text
Accurate Reconstruction
```

from:

```text
Task-Specific Representation
```

The representation used for analysis does not always need to match the representation used for reconstruction.

------

# Validation

Every optimisation must be validated.

Measure:

- runtime
- memory
- bandwidth
- cache behaviour
- quality metrics

Use:

- SSIM
- Butteraugli
- visual inspection
- correctness tests

Never assume an optimisation is beneficial.

Measure first.

Measure after.

Compare.

Repeat.

------

# Final Optimisation Hierarchy

```text
1. Architecture
2. Representation
3. Memory Movement
4. Memory Layout
5. Fusion
6. Cache Locality
7. SIMD
8. Multithreading
9. Micro-Optimisation
10. Validation
```

The largest performance gains usually come from changing what work is performed, not performing the same work faster.

This version elevates what I think was the strongest new insight:

> **Shared Artifacts Create Hidden Coupling**

because that principle generalises far beyond image processing. It's the same optimisation pattern behind high-performance systems like Lucene, databases, compilers, game engines, and distributed systems: once you stop forcing every subsystem to consume the most expensive representation, entire classes of memory traffic disappear.
