# ML Agent Deployment Brief

## Objective

Optimise JXL decode pipeline.

Priority order:

1.  eliminate copies
2.  keep buffers in WASM
3.  improve cache locality
4.  fuse image kernels
5.  enable SIMD
6.  tune concurrency

## Required checks

Before changing pixels: - run golden corpus - compare SSIM - compare
Butteraugli

## Architecture target

JS → scheduler → WASM → SIMD kernels → output

## Rules

Do not: - add allocations in hot paths - convert Uint8↔Float32
repeatedly - move pixel buffers between layers unnecessarily

Prefer: - ring buffers - pointer advancement - tile reuse - SoA
layouts - LUTs - precomputed transforms
