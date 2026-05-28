# CasaWASM JXL Feature Completeness and Gaps

**Location:** `c:\Foo\raw-converter-wasm\docs\` (canonical source)  
**Related Documents:**
- [Overview and features of the CasaWASM JXL wrapper.md](./Overview%20and%20features%20of%20the%20CasaWASM%20JXL%20wrapper.md)
- [WASM_Tauri_feature_comparison.md](./WASM_Tauri_feature_comparison.md)
- `Tauri-progressive-implementation.md`

**Date:** 2026-05-28 (updated with libvips + other wrapper references + performance analysis)  
**Owner / Strategy:** Make the CasaWASM JXL wrapper the most complete, production-grade, and feature-maximal JPEG XL implementation.

---

## Reference Implementations Collected

As requested, we are gathering key source files from mature open-source wrappers around libjxl as design and implementation references. These are stored locally in:

**`c:\Foo\raw-converter-wasm\docs\references\`**

Current references (as of this update):

- **libvips** (`jxlsave.c` and `jxlload.c`) — The most widely used production high-level abstraction over libjxl. Excellent reference for what a pragmatic, battle-tested API chooses to expose.
- **jpegxl-rs** (inflation/jpegxl-rs `encode.rs`) — One of the best high-level Rust wrappers over the real libjxl. Shows an excellent builder-pattern API with escape hatches to raw `JxlEncoderFrameSettings`.
- Others (chafey/libjxl-js, official libjxl WASM demo, etc.) will be added as we pull the most relevant files.

A `README.md` in that folder explains the purpose of each reference.

These files are for **reference only** (design patterns, option mapping, error handling, high-level ergonomics). We are not copying code directly due to license differences, but they are extremely valuable for deciding what (and how) to expose in CasaWASM.

---

## Performance, Size, and "Lite vs Full" Considerations

### Short Answer
Including more features in the **wrapper layer** (facade.ts + bridge.cpp) has **very low** impact on runtime speed or download size.

The real size/performance trade-off lives in the **WASM binary** (the compiled libjxl), not in how many options the JavaScript/TypeScript glue exposes.

### Detailed Analysis

1. **WASM Binary Size (the big one)**
   - The downloaded `.wasm` file size is determined almost entirely by which parts of libjxl were compiled in during the Emscripten build.
   - Simply exposing more `JxlEncoderFrameSettingId` values or decoder events in the bridge adds only a few kilobytes (mostly the JS/TS glue and FFI bindings).
   - A "kitchen-sink" build of libjxl (all encoders, decoders, color management, threading, etc.) will be significantly larger than a minimal one.

2. **Runtime Speed**
   - Most "advanced features" are just integer/float options passed to libjxl at encode/decode time.
   - The wrapper overhead for setting these options is negligible (a few function calls).
   - The actual performance difference comes from the settings themselves (e.g., effort=10 is much slower than effort=3, decoding_speed=4 is faster but lower quality, etc.). This is the same whether you expose the option or not.

3. **Download Overhead**
   - The wrapper (JS + WASM) is typically loaded once per page / worker.
   - After the first load it is cached (Service Worker, Cache API, or browser HTTP cache).
   - Subsequent encode/decode operations do **not** re-download the wrapper.

### Recommendation: The "Full + Lite" Strategy You Suggested

Your instinct is excellent and is the standard approach used by serious WASM image libraries.

**Proposed approach:**

- Build a **"Full" CasaWASM** that compiles as much of libjxl as practical and exposes a very wide surface (most or all of the `JxlEncoderFrameSettingId` values, rich extra channel support, photon noise, filters, etc.).
- After the full version is working and well-tested, create a **"Lite" / "Scientific"** build that:
  - Strips out features you don't need (e.g., no animation if not required, limited color management, smaller threading support, etc.).
  - Uses Emscripten feature flags / dead code elimination aggressively.
  - Still exposes the exact tunings the scientific/Casabio workflows actually use (after real measurement).

This gives you the best of both worlds:
- Maximum capability for research/experimentation in the Full version.
- Smallest possible download + fastest startup for production deploys in the Lite version.

Many teams end up shipping 2–3 variants (e.g., "full", "lite", "decode-only").

---

(The rest of the document contains the previous detailed gaps analysis, the libvips production reference section, the expanded encoder table from official libjxl research, and the prioritized Sprint list.)

**Next suggested action:** Decide on the initial build strategy (how "full" do we want the first WASM binary to be?) and document it in this file or a new `Build_Strategy.md`. This decision will heavily influence the sprint priorities and Emscripten/CMake configuration work.
---

## Reference Code System (Updated 2026-05-28)

See the dedicated index at:
**docs/references/REFERENCE_INDEX.md**

This index maps specific JXL features (Modular controls, progressive, extra channels, Brotli effort, etc.) to exact files and line ranges across:
- chafey/libjxl-js (C++ Embind)
- inflation/jpegxl-rs (Rust)
- libvips (C)
- libjxl reference headers

Use this when implementing a feature to quickly pull the relevant sections from each reference, compare approaches, and design the CasaWASM + Tauri versions.

## Implementation Workflow & Scaffolding (Updated)

A complete scaffolding system now exists:

- eferences/REFERENCE_INDEX.md — Feature-by-feature mapping with file + line references across libraries.
- eferences/FEATURE_IMPLEMENTATION_TEMPLATE.md — The operational template that tells the agent exactly how to research, compare, design, and implement features across both WASM and Tauri in a coordinated way.

When starting any new feature work, the agent should be instructed to follow the template and use the index.

## Updated Implementation Process (2026-05-28)

The full scaffolding now includes:

- eferences/REFERENCE_INDEX.md (feature mapping with line references)
- eferences/FEATURE_IMPLEMENTATION_TEMPLATE.md (mandatory agent process)

Key new rules enforced by the template:
- Every feature starts on a fresh, appropriately named git branch.
- Every feature must include UI exposure in the Benchmark pages.
- Every feature/section must end with a standardized Cleanup & Handoff block (drawing from the project's _cleanup.md patterns).
- Clear handoff protocol when issues are encountered.

See the template for the complete checklist and process.

## Current Recommended Division of Labor (Research vs Implementation)

See eferences/FEATURE_IMPLEMENTATION_TEMPLATE.md (especially the new section 11) for the agreed workflow:

Grok will do the heavy per-feature research aggregation, difference highlighting, and produce a design proposal (saved in eferences/designs/). The implementing agent then executes using that proposal + the full template process.

This is considered the most efficient way to tackle the large number of remaining features at high quality.

## Handoff Document

A comprehensive handoff document exists at:
eferences/HANDOFF.md

Use this when clearing context between sessions. It contains the current state of the scaffolding, recommended workflow, and instructions for resuming feature design note work.

---

## Design Phase Status (2026-05-28)

The first major wave of design notes for the high-leverage and audit items has been completed:

- 11 design notes written in `references/designs/`
- Full coverage of the 2026-05-28 audit section in `REFERENCE_INDEX.md` (Gain Maps, Patches & Splines, Container decisions)
- Master index created at `designs/DESIGNS_INDEX.md`

See `designs/DESIGNS_INDEX.md` for the complete list, priority mapping, and cross-references.

The scaffolding is now ready for implementation agents to begin work following `FEATURE_IMPLEMENTATION_TEMPLATE.md`.
