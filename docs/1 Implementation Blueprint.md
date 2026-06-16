# Implementation Blueprint

## Purpose

Engineering handoff for optimising the JXL decode pipeline into a
high-performance imaging system.

The central rule:

> Remove unnecessary movement of data before making computation faster.

## Final architecture

JS API → Session lifecycle → Worker scheduler → WASM codec engine → SIMD
kernels → output views

The session layer owns: - cancellation - backpressure - ownership -
event delivery

It should not perform pixel work.

------------------------------------------------------------------------

# Chapter 1 --- Zero allocation streaming

Goal:

Avoid:

input chunk → copy → queue → worker → copy → decode

Replace with:

input ring buffer → WASM memory view → pointer advancement → decode

Principles: - fixed buffers - stable ownership - no repeated slicing -
no iterator overhead

------------------------------------------------------------------------

# Chapter 2 --- WASM memory architecture

Keep image data in WASM memory.

Avoid:

Uint8Array → Float32Array → copied buffer → worker transfer

Prefer:

compressed input → WASM decode → working planes → output view

------------------------------------------------------------------------

# Chapter 3 --- Pixel layout

RGBA:

R = red G = green B = blue A = alpha

Prefer separating colour work:

R plane G plane B plane

and handling alpha separately where possible.

Reason: alpha usually does not need expensive colour transforms.

------------------------------------------------------------------------

# Chapter 4 --- Tile architecture

Default:

Tile based processing.

Benefits: - cache locality - bounded memory - progressive output -
parallel execution

Alternative: scanline streaming.

Benchmark before replacing tiles.

------------------------------------------------------------------------

# Chapter 5 --- SIMD

SIMD: one instruction over many values.

Separate concepts:

SIMD: more work per CPU instruction.

Multithreading: more CPU cores doing work.

Use: - WASM SIMD - AVX where available - FMA - packed integer operations

Avoid: - shuffles - unnecessary format conversions - divisions in hot
loops

------------------------------------------------------------------------

# Chapter 6 --- Kernel fusion

Prefer:

decode → transform → output

instead of:

decode → store → transform → copy → output

Every intermediate buffer costs bandwidth.

------------------------------------------------------------------------

# Chapter 7 --- Quality gates

Every pixel-changing optimisation requires:

-   golden images
-   SSIM checks
-   Butteraugli checks
-   visual regression

Timing alone is insufficient.

------------------------------------------------------------------------

# Chapter 8 --- Batching and concurrency

Batch work where throughput matters.

Use: - worker pools - shared pools - tile scheduling

Avoid: - tiny IPC messages - frequent synchronisation

------------------------------------------------------------------------

# Chapter 9 --- Representation layer

Keep codec reconstruction separate from biological representation.

Pipeline:

sensor image → decoded image → illumination invariant transform →
recognition / AR / photogrammetry

------------------------------------------------------------------------

# Chapter 10 --- Benchmark order

1.  measure
2.  remove copies
3.  fix memory layout
4.  fuse kernels
5.  SIMD
6.  concurrency
7.  algorithmic changes
