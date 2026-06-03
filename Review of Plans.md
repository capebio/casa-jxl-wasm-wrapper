# Review of Plans

This document provides an evaluation of all plan, specification, and handoff documents found within the `docs/` directory and root folder to determine their implementation status.

## 1. Implemented Plans (Can be archived or removed)

The following plans have been fully realized in the codebase:

*   **`docs/superpowers/plans/2026-06-p3-lightbox-jxl-progressive-decoder.md` & `docs/superpowers/specs/2026-06-p3-lightbox-jxl-progressive-decoder.md`**
    *   **Goal:** Replace jsquash one-shot decode with progressive streaming from `@casabio/jxl-wasm` in the production lightbox (Phase P3.1).
    *   **Status: Implemented.** The required cache policies (`onFirstProgress`, `onFinal`, `never`) and the progressive decoder fallback mechanism have been fully integrated into `web/main.js` and `web/jxl-decode-worker.js`.

*   **`EpicCodeReview_DeferredItems_Handoff.md`**
    *   **Goal:** Address deferred items (Q1–Q7) from an epic code review.
    *   **Status: Implemented.** All items are explicitly marked as "CLOSED" in the document and the corresponding fixes (e.g., `tiled-128` blur integration, memory leak fixes) exist in the code.

*   **`casabio-jxl-wrapper-construction-spec-v2.md` & `final-jxl-wrapper-architecture Grok, Gemini and ChatGPT.md`**
    *   **Goal:** Outline the architecture for the Casabio JXL Wrapper across browser and server.
    *   **Status: Implemented.** The architecture has been built. The `packages/` directory contains the exact module map specified by these documents (e.g., `jxl-wasm`, `jxl-core`, `jxl-session`, `jxl-worker-browser`, `jxl-cache`, etc.).

## 2. Outstanding / Partially Implemented Plans

The following plans still have uncompleted phases or backlog items:

*   **`docs/handoff-p3-lightbox-jxl-decoder.md`**
    *   **Status: Partially Implemented.**
    *   **Completed:** Phase P3.1 (Progressive First Paint) is finished.
    *   **Outstanding (P3.2 - Viewport / ROI Awareness):** The decode worker currently hardcodes `region: null` and `downsample: 1`. It needs to dynamically accept viewport regions to optimize decoding for zoomed-in images.
    *   **Outstanding (P3.3 - JXL Container Previews + JXTC + Polish):** Using embedded previews before full decode, enabling JXTC tiled paths, and adding multi-frame progressive navigation are not yet implemented.

*   **`docs/ai-unification/unification-roadmap.md`**
    *   **Status: Partially Implemented / Ongoing.**
    *   **Completed:** Tier 1 and Tier 2 skills (`check-work`, `owl`, `best-of-n`, `review`) have been unified and exist in `docs/ai-unification/canonical-skills`.
    *   **Outstanding:** Tier 3 and 4 skills (e.g., `pptx`, `docx`, `xlsx`, `frontend-design`, `find-skills`) remain on the backlog, along with the canonicalization of a large Epic review skill. Projector hardening is likely still an ongoing task.

## 3. Analysis Documents (Not Actionable Plans)

These documents provide architectural context or performance analysis rather than step-by-step plans. They do not need to be "implemented" or "removed," but they remain useful for reference:

*   **`Tauri-progressive-implementation.md`**
    *   **Context:** Recommends a native desktop Rust/Tauri approach using `jpegxl-sys` to bypass browser WASM limitations.

*   **`WASM_DNG_ANALYSIS.md`**
    *   **Context:** Details the performance bottlenecks of single-threaded WASM for DNG processing and makes pipeline recommendations.
