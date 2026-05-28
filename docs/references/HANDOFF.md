# Handoff Document — CasaWASM JXL Feature Implementation Scaffolding

**Date:** 2026-05-28  
**Context:** End of long scaffolding-building conversation

---

## 1. Overall Goal & Strategy

The strategic intent is:

> Make the **CasaWASM JXL wrapper** (browser + Node) the most complete, production-grade, and feature-maximal JPEG XL implementation in the stack. Use it as the reference implementation. Then port the capabilities and learnings to Tauri (native), and eventually into Casabio proper.

Focus is on advanced encoder/decoder controls that are currently missing or weakly exposed (especially Modular mode tuning, extra channels, photon noise, Brotli effort, progressive encode options, resampling, etc.), while maintaining excellent progressive UX and ROI (JXTC) support.

---

## 2. Current Scaffolding (as of 2026-05-28)

All files live under the canonical docs folder:

**Main Documents**
- CasaWASM_JXL_Feature_Completeness_and_Gaps.md — The living inventory of gaps + current recommended division of labor.
- WASM_Tauri_feature_comparison.md — The original feature parity table between WASM and Tauri (moved here earlier).

**References System** (eferences/ folder)
- REFERENCE_INDEX.md — Feature-by-feature mapping with file + line guidance across multiple libraries. Includes a strong "How to Use" section.
- FEATURE_IMPLEMENTATION_TEMPLATE.md — The authoritative process document that agents must follow. Includes:
  - Mandatory git branching at start of each feature
  - Benchmark wiring requirement
  - Handoff protocol for issues
  - Standardized Cleanup & Handoff at the end of every feature (incorporating patterns from _cleanup_source.md)
  - Recommended hybrid workflow (Grok synthesizes → produces design note; agent implements)
- PROGRESS_LOG.md — Dedicated file for recording progress after each feature (has entry template).
- designs/ — Folder where per-feature design notes will be stored (one .md file per feature).
- _cleanup_source.md — Original _cleanup.md patterns for reference.
- Various reference notes and partial source files.

**Collected References** (for comparison)
- chafey/libjxl-js (thin Embind C++ → JS binding)
- inflation/jpegxl-rs (high-level Rust wrapper — recommended model for Tauri)
- libvips (jxlsave.c / jxlload.c) — pragmatic production C abstraction
- cjxl_main.cc (official libjxl CLI) — best real-world usage of the full option set
- Official libjxl examples (encode_oneshot.cc, etc.) + headers
- Others as noted in the index

---

## 3. Recommended Workflow Going Forward (Hybrid Model)

**Default process for each feature:**

1. **Grok** performs the research aggregation using REFERENCE_INDEX.md:
   - Pulls relevant code from the key references.
   - Analyzes differences and trade-offs.
   - Produces a **Feature Design Note** saved as eferences/designs/<feature-name>.md.
   - The note includes recommended design for both WASM and Tauri, suggested files, and rationale.

2. The design note becomes the primary source of truth for that feature.

3. The **implementing agent** then follows FEATURE_IMPLEMENTATION_TEMPLATE.md:
   - Creates a new appropriately named git branch.
   - Implements (typically WASM first, then Tauri).
   - Wires controls into Benchmark pages.
   - Writes tests.
   - At the end: produces Cleanup & Handoff block + appends a proper entry to PROGRESS_LOG.md.

This hybrid (Grok synthesizes once per feature → agent executes with autonomy) was chosen for efficiency when doing many features.

---

## 4. How to Use This Handoff in Future Sessions

When starting a new session after clearing context:

1. Feed this handoff document to the agent (or paste the key sections).
2. Tell the agent which specific feature you want a design note for.
3. The agent should:
   - Read the latest REFERENCE_INDEX.md
   - Read the latest FEATURE_IMPLEMENTATION_TEMPLATE.md
   - Read relevant reference files as needed
   - Produce a high-quality design note in eferences/designs/

You can then review the design note, iterate with the agent if needed, and later hand the note + template to an implementation agent or developer.

---

## 5. Current Priority Features (from Sprint List)

See the Sprint Priorities section in CasaWASM_JXL_Feature_Completeness_and_Gaps.md.

High-leverage items from earlier discussion include:
- Brotli Effort + basic extra-channel distance
- Decoding Speed tier
- Core Modular controls (predictor, group size, etc.)
- Resampling + Photon Noise
- Full extra channel infrastructure
- etc.

---

## 6. Open Decisions / Notes

- Tauri side strongly prefers Rust (jpegxl-rs or jpegxl-sys) over raw C++.
- Every feature must include benchmark UI exposure.
- The designs/ folder will become a very valuable knowledge base over time.

---

**End of Handoff**

This document + the files in eferences/ should allow you to efficiently restart work in fresh contexts without losing the scaffolding and process we built.
