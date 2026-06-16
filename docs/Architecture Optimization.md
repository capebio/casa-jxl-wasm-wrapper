# Architecture Optimization

## How to think about optimisation

The best optimisation path:

Measure → identify bottleneck → remove movement → change representation
→ fuse → vectorise → parallelise → validate

------------------------------------------------------------------------

# Zero-copy

Zero-copy means avoiding unnecessary duplication.

A buffer should ideally have one owner and many views.

------------------------------------------------------------------------

# Ring buffers

A fixed circular buffer.

Instead of allocating new chunks:

advance pointers.

Benefits: - predictable memory - no fragmentation - lower latency

------------------------------------------------------------------------

# Memory bandwidth

Many image workloads are not limited by arithmetic.

They are limited by:

-   reading pixels
-   writing intermediates
-   cache misses

Reducing passes is often more valuable than faster maths.

------------------------------------------------------------------------

# SIMD

Single Instruction Multiple Data.

A CPU instruction processes many values.

Example:

Scalar: one pixel

SIMD: many pixels

------------------------------------------------------------------------

# AVX / AVX2 / AVX-512

CPU SIMD instruction families.

They provide wider vector registers.

Wider is not always faster: - memory can dominate - CPU frequency may
drop

------------------------------------------------------------------------

# WASM SIMD

Portable SIMD for WebAssembly.

Allows vector operations across platforms.

------------------------------------------------------------------------

# Multithreading

Different from SIMD.

SIMD: one core, many values.

Multithreading: many cores, separate tasks.

They combine well.

------------------------------------------------------------------------

# SSIM

Structural Similarity Index.

A quality metric.

Used to detect whether an optimisation damages image structure.

------------------------------------------------------------------------

# Butteraugli

Perceptual image metric.

Closer to human visual sensitivity.

Useful for compression and perceptual transforms.

------------------------------------------------------------------------

# LUTs

Look-up tables.

Replace expensive functions:

log exp division gamma curves

with:

lookup + interpolation

when error is controlled.

------------------------------------------------------------------------

# AoS vs SoA

Array of Structures:

RGBA RGBA RGBA

Structure of Arrays:

RRRR GGGG BBBB AAAA

SoA is often better for SIMD.

------------------------------------------------------------------------

# Fusion

Combining operations to remove intermediate buffers.

------------------------------------------------------------------------

# Cache locality

Processors are fast when data is nearby.

Design data structures around access patterns.

------------------------------------------------------------------------

# Elasticsearch / Lucene lens

High performance comes from:

-   precomputation
-   immutable segments
-   sequential access
-   skipping irrelevant work
-   batching

Apply the same questions:

Can this be precomputed? Can lookup replace calculation? Can random work
become sequential?

------------------------------------------------------------------------

# Symmetry and group theory lens

Look for:

-   repeated transformations
-   invariants
-   equivalent states

Possible optimisations:

-   compose transformations
-   cache canonical forms
-   remove redundant operations

------------------------------------------------------------------------

# Biological representation lens

Separate:

accurate reconstruction

from:

task-specific representation.

Illumination-invariant transforms can make biological signal easier to
detect.

Validate them separately from codec fidelity.

------------------------------------------------------------------------

# Final architecture

Decode correctly first.

Then:

memory optimisation → SIMD → scheduling → representation intelligence
