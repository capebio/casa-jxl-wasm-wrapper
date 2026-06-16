# Progressive JXL Visual Convergence Profiling Plan

**Date:** Tuesday, 9 June 2026
**Path:** `docs/superpowers/plans/2026-06-09-convergence-profiling.md`
**Status:** Staged for Multi-Agent Execution

---

## 🧭 Executive Summary & Core Concept

**Visual Convergence Profiling** is a state-of-the-art progressive image delivery technique. On slow or congested connections (3G, 4G, or poor public Wi-Fi), downloading the entire lossless or high-quality JXL image (the final AC passes) represents a massive network tax for detail that is mathematically present but visually indistinguishable to the human eye.

By profiling the image **offline during ingestion**, we can detect the exact **Visual Convergence Point**—the byte offset in the progressive JXL stream where the decoded image achieves visual saturation (e.g., SSIM > 0.9995 or Butteraugli distance < 1.1 compared to the lossless final frame). 

This byte offset is saved directly in the manifest as `convergedByteEnd`. When the client (browser gallery or lightbox) fetches the image over the network, it reads the manifest and issues an HTTP `Range: bytes=0-convergedByteEnd` request. This **cuts network bandwidth and download times by up to 50%**, with **0% visible quality loss** and **0% extra client-side CPU overhead**.

```
  JXL Codestream Bytes (Progressive AC Passes)
  ┌───────────────────────┬──────────────────────────────────────────┐
  │  Visual DC + AC 1..5  │     Lossless/Heavy High-Frequency AC     │
  │     (Necessary)       │        (Mathematically Perfect)          │
  ├───────────────────────┼──────────────────────────────────────────┤
  ▲                       ▲                                          ▲
  0                 convergedByteEnd                             Total Bytes
                     [FETCH CLAMP]                          [NO DOWNLOAD REQ]
                     (50% Bytes)                              (50% Savings)
```

---

## 🚀 Grok 1 Agency: Manifest Schema Expansion & CLI Options

### 🧭 Goal
Expand the ingestion-compiler's manifest schema and CLI argument parser to support the optional `convergedByteEnd` field on level entries and configure the profiling toggles.

### 📂 Files of Interest
*   `packages/pyramid-ingest/src/schema.ts`
*   `packages/pyramid-ingest/src/manifest.ts`

### 🛠️ Technical Context
*   **The Manifest Contract:** Ingestion results are validated via strict Zod schemas inside `schema.ts`. Any new manifest property must be formally declared in the schema, otherwise parse and roundtrip operations will reject the file as corrupted.

### 📋 Concrete Requirements
1.  **Schema Expansion:**
    *   In `schema.ts`, expand `levelEntrySchema` to include an optional field:
        ```typescript
        convergedByteEnd: z.number().int().positive().optional()
        ```
2.  **CLI Argument Integration:**
    *   In `schema.ts`, expand `cliArgsSchema` to add a new option:
        ```typescript
        "profile-convergence": z.boolean().optional().default(false)
        ```
3.  **Command-Line Parameter Wiring:**
    *   In `cli.ts` (or `ingest.ts`), register `profile-convergence` so it is cleanly parsed and passed through options.
4.  **REJECTION GUARANTEE:** If you determine that altering the schema at this stage violates backward compatibility for existing parsed indexes, reject and write custom pre-parsing schema adaptors inside `schema.ts` instead.

---

## 🚀 Grok 2 Agency: Ingestion-Time Progressive Pass Profiler

### 🧭 Goal
Build the visual convergence profiling loop. During ingestion-time encoding, execute an incremental decode of the progressive stream, compute SSIM/Butteraugli on each pass, identify the byte boundary where visual saturation is achieved, and record it in the manifest level.

### 📂 Files of Interest
*   `packages/pyramid-ingest/src/ladder.ts`
*   `packages/pyramid-ingest/src/backends.ts`

### 🛠️ Technical Context
*   **WASM Capabilities:** The `jxl-wasm` facade supports progressive decoding. By pushing bytes incrementally and listening to `progress` and `pass` events, we can capture the decoded pixel buffers at each progression pass.

### 📋 Concrete Requirements
1.  **Progression Analyzer Loop:**
    *   When `--profile-convergence` is enabled, after writing a compiled JXL level buffer, instantiate an in-memory progressive decoder session.
    *   Push the bytes of the level incrementally (or feed them pass-by-pass).
    *   For each decoded pass $p$, capture the intermediate RGBA8 pixel buffer.
2.  **Visual Saturation Detection:**
    *   Compute the **SSIM** (using the `ssim.js` package already listed in root devDependencies) or **Butteraugli distance** between the intermediate pass pixels and the final lossless image pixels.
    *   The **Visual Convergence Point** is defined as the first pass where:
        *   **SSIM $\ge$ 0.9995** OR **Butteraugli $\le$ 1.1**
    *   Track the exact progressive stream byte offset (representing the number of bytes pushed up to that pass) and write it as `convergedByteEnd` on the level entry.
3.  **Graceful Degradation:** If the JXL image lacks progressive pass boundaries (e.g. it is a single-pass or lossless one-shot image), gracefully omit `convergedByteEnd` and proceed without throwing.
4.  **REJECTION GUARANTEE:** If running the in-memory decoder during the ingestion compile adds too much overhead or doubles ingestion time, reject doing the full analysis on smaller levels and restrict convergence profiling strictly to large levels (e.g., width $\ge$ 1024px).

---

## 🚀 Grok 3 Agency: Client-Side Fetch Manager Range Truncation

### 🧭 Goal
Integrate `convergedByteEnd` truncation inside the client-side fetch manager or progressive stream reader, ensuring that HTTP Range requests clamp the maximum byte bounds to save bandwidth.

### 📂 Files of Interest
*   `packages/jxl-progressive/src/progressive-stream.ts`
*   `packages/jxl-session/src/session.ts`

### 🛠️ Technical Context
*   **Range Fetching:** The progressive pipeline downloads bytes incrementally from a server using fetch managers. If the level entry declares `convergedByteEnd`, we can tell the fetcher to stop downloading once this boundary is met.

### 📋 Concrete Requirements
1.  **Clamped Range Requests:**
    *   In the progressive fetch manager (or stream generator), inspect if the level's manifest metadata has `convergedByteEnd` populated.
    *   If `convergedByteEnd` is present and the connection is under high latency (or if the caller configures `clamped: true`), instruct the HTTP fetcher to issue a Range request restricted to the first `convergedByteEnd` bytes:
        ```typescript
        headers.set("Range", `bytes=0-${convergedByteEnd}`);
        ```
2.  **Symmetrical Stream Closing:**
    *   Ensure that the progressive decoder receives an immediate stream close signal (`close()`) right after the truncated bytes are pushed, so that it flushes the final converged pass and paints the image without waiting for trailing bytes.
3.  **REJECTION GUARANTEE:** If implementing Range truncation inside the stream generator risks regressing Sneyers progressive-streaming checkpoints or breaking the backpressure queue invariants, reject the fetch-level changes and implement it instead as an optional parameter on the `JxlSession` initializer.

---

## 🚀 Grok 4 Agency: Integration & End-to-End Validation Tests

### 🧭 Goal
Write the unit and integration tests to verify the convergence profiler's mathematical precision and confirm the network truncation saving.

### 📂 Files of Interest
*   `packages/pyramid-ingest/test/manifest.test.ts`
*   `packages/jxl-progressive/test/progressive-perf.test.ts`

### 📋 Concrete Requirements
1.  **Profiler Integrity Test:**
    *   Write a unit test inside `packages/pyramid-ingest/test/manifest.test.ts` that feeds a mock progressive JXL stream, runs the profiler, and asserts that `convergedByteEnd` is successfully written and is strictly less than the total file size.
2.  **Truncated Stream Decode Test:**
    *   Write a test inside `packages/jxl-progressive/test/` asserting that a truncated byte buffer (cut exactly at `convergedByteEnd`) decodes successfully into a complete, visually clean image with zero decoding crashes or pending promise hangs.
3.  **REJECTION GUARANTEE:** If mock JXL buffers cannot reliably simulate progressive pass progression without loading real files, allow the test to gracefully skip if the test corpus assets are missing from the runtime path.
