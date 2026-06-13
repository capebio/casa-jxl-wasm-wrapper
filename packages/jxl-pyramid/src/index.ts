// index.ts
// Entry point for the @casabio/jxl-pyramid workspace package.
// Re-exports all schemas, constants, and test fixtures for the Pyramid Gallery Pipeline.
// Group 7: Megatexture Viewport Selection surface (choose-level + grid-layout + plan) for pan/zoom/dpr -> level + tile grids.

export * from "./manifest.js";
export * from "./constants.js";
export * from "./fixtures.js";
export * from "./tiling.js";
export * from "./level-source.js";
export * from "./decode-level.js";
export * from "./choose-level.js";
export * from "./grid-layout.js";
export * from "./tiled-decode-pool.js";
export * from "./decode-core.js";
export * from "./cache.js";
export * from "./worker-protocol.js";
export { prepareDecodePlan, expandRegionByTiles, type DecodePlan, type JxtcHeader } from "./plan.js";
export { PoolState, HandleState } from "./tiled-decode-pool.js";
// plan.ts: core viewport->tiles + header plan for megatexture (Group 7). Exported for direct use + pool. DecodeOptions/PyramidError from decode-core for Grok3 signal/lifecycle.
