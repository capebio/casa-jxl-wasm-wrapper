# Deep Reference Code Audit Handoff – JXL Feature Parity

**Date:** 2026-06  
**Branch:** finishing_feature_parity  
**Context:** This handoff addresses the realization that prior parity work (FEATURE_PARITY_MATRIX.md, REFERENCE_INDEX.md, designs/) was based primarily on the *reduced notes* in `docs/references/` rather than exhaustive analysis of the actual upstream reference code.

**Goal:** Produce a systematic, honest comparison of our current CasaWASM JXL implementation (WASM + native paths) against the *real* code in the reference libraries. Mark gaps clearly as:
- **Red (❌)**: Not implemented / major missing capability
- **Orange (🟠)**: Needs improvement (partial, not first-class, ergonomic gap, missing important options, weaker than reference, etc.)

**Do not** default to ✅ just because something is reachable via the raw `advancedFrameSettings` escape hatch.

---

## Reproducibility & Source Pinning (Critical)

To make this audit verifiable by future people (including yourself in 3 months), **always pin the exact revision** of the reference code you audited.

### Recommended Practice

For every library you audit, record **at minimum**:

- Exact commit hash (or tag) of the reference
- Date + time you fetched it
- How you obtained the source

#### For libjxl (cjxl_main.cc, encode.h, etc.)

```bash
# Get the current commit hash of the main branch
git ls-remote https://github.com/libjxl/libjxl.git HEAD

# Then fetch a specific file at that revision
curl -L "https://raw.githubusercontent.com/libjxl/libjxl/<COMMIT_HASH>/tools/cjxl_main.cc" > cjxl_main.cc
```

Record in your audit section:
```markdown
**Libjxl commit:** `a1b2c3d4e5f6...` (main branch as of 2026-06-12)
**Fetched via:** raw.githubusercontent.com at above commit
**Date audited:** 2026-06-12 14:30 UTC
```

#### For jpegxl-rs

Preferred methods (in order):

1. **Best:** Clone the repo at a specific tag/commit
   ```bash
   git clone https://github.com/inflation/jpegxl-rs.git
   cd jpegxl-rs
   git checkout <tag-or-commit>
   ```

2. View specific file on GitHub at a pinned revision:
   `https://github.com/inflation/jpegxl-rs/blob/<commit>/src/encode.rs`

3. Use `cargo expand` on a pinned version in a temporary project (good for seeing the final macro expansion).

Record the exact method + revision in the audit section.

#### General Rule
Never audit against "the current main". Always pin. "Date audited" alone is insufficient for later exact reproduction.

---

## Recommended Matrix Evolution

You have two good options. Choose one and be consistent:

### Option A (Recommended for cleanliness)
Keep the existing `FEATURE_PARITY_MATRIX.md` as the high-level WASM-vs-Tauri overview.

Create a **new dedicated file**:
`docs/references/REFERENCE_CODE_AUDIT.md`

Structure it with one major section per reference library. Each section contains its own table with columns such as:

| # | Feature / Option / Pattern | Reference Location (file:line or function) | Current WASM (jxl-wasm) | Current Native (jxl-native) | Gap Severity | Notes / Action |

Use **❌** and **🟠** (and keep ✅ / N/A where truly complete).

### Option B
Add new top-level sections to `FEATURE_PARITY_MATRIX.md`:
- 9. cjxl_main.cc Reference Audit
- 10. jpegxl-rs Reference Audit
- etc.

Option A is cleaner for this deep-dive phase.

---

## Libraries to Audit (in priority order)

### 1. cjxl_main.cc (Highest priority)
**Why:** Repeatedly described in our own docs as "the single best real-world reference for how *all* the advanced encoder options are actually used together in production."

**Actual source (MUST pin to a specific commit):**

Use this process for reproducibility:
```bash
git ls-remote https://github.com/libjxl/libjxl.git HEAD
curl -L "https://raw.githubusercontent.com/libjxl/libjxl/<COMMIT_HASH>/tools/cjxl_main.cc" > cjxl_main.cc
```

Record the exact commit hash in your audit section (see "Reproducibility & Source Pinning" section above).

**Key areas to examine (non-exhaustive):**
- `AddCommandLineOptions()` and `ProcessFlags()`
- All calls to `ProcessFlag`, `ProcessBoolFlag`, `params->options.emplace_back`
- `SetDistanceFromFlags`
- Handling of `--modular_*`, `--progressive*`, `--brotli_effort`, `--photon_noise_iso`, `--group_order`, `--center_x/y`, `--buffering`, `--faster_decoding`, `--epf`, `--gaborish`, `--dots`, `--patches`, `--responsive`, `--already_downsampled`, `--upsampling_mode`, `--dec-hints`, `--frame_indexing`, `--allow_expert_options`, `--disable_perceptual_optimizations`, etc.
- JPEG reconstruction metadata logic
- Container / box decisions
- Any validation or combinations that are not obvious

**What to look for vs our code:**
- Options that have dedicated nice flags in cjxl but are only reachable via our `advancedFrameSettings` escape hatch.
- Usage patterns around `GROUP_ORDER` + centers, `BUFFERING` modes, fine-grained JPEG metadata control, etc.

---

### 2. Official libjxl Headers (encode.h + related)
**Critical file:** `lib/include/jxl/encode.h` (especially the full `JxlEncoderFrameSettingId` enum)

**Acquisition:** Same pinning method as cjxl_main.cc (use `git ls-remote` + raw URL at exact commit). Record the commit hash.

**What to extract:**
- Complete list of every `JXL_ENC_FRAME_SETTING_*` constant (there are ~40).
- Any comments or behaviors around them.
- Related structs (`JxlEncoderFrameSettings`, etc.).

**Cross-check against:**
- Our `facade.ts` `EncoderOptions` and `ModularOptions`
- `bridge.cpp` wiring
- `jxl-native` native.cc + index.ts

Create a table that lists every enum value and marks whether we have first-class support, escape-only, or nothing.

---

### 3. jpegxl-rs (encode.rs + related)
**Sources:** The actual crate (not just our thin `.note.txt`).

**Acquisition (choose one and record the revision):**
- Best: `git clone https://github.com/inflation/jpegxl-rs.git && git checkout <tag-or-commit>`
- Good: View files on GitHub at a specific commit (e.g. `https://github.com/inflation/jpegxl-rs/blob/<commit>/src/encode.rs`)
- Alternative: Create a temp Cargo project, pin a version in `Cargo.toml`, then use `cargo expand`

See the "Reproducibility & Source Pinning" section above for the exact recording format required.

Focus on:
- High-level builder API ergonomics
- How the escape hatch (`set_frame_option`) is used
- Any convenience methods that don't exist in our TS API
- Error handling and validation patterns

---

### 4. chafey/libjxl-js
**Key files:**
- `JpegXLEncoder.hpp`
- `JpegXLDecoder.hpp`
- `jslib.cpp`

Look for thin binding patterns, especially around progressive modes, extra channels, and any options that were hard-coded or exposed differently.

---

### 5. libvips (jxlsave.c / jxlload.c)
**Focus:**
- Production multi-band → extra channel mapping
- Interlace / progressive handling
- Any option mapping or heuristics that are more sophisticated than ours

---

### 6. Official libjxl examples (encode_oneshot.cc + others)
Lower priority but still useful for baseline usage.

---

## Workflow Recommendation ("Clean Terminal" Style)

1. **Start fresh** (new terminal / new agent session if possible).
2. Open only these files:
   - `docs/references/DEEP_REFERENCE_CODE_AUDIT_HANDOFF.md` (this file)
   - `docs/FEATURE_PARITY_MATRIX.md`
   - `docs/references/REFERENCE_INDEX.md`
   - The actual reference source you're currently auditing (use `web_fetch` or local clones)
3. For each library, create a section in `REFERENCE_CODE_AUDIT.md` (or the chosen target file).
4. **Be ruthless** with **❌** and **🟠**.
   - "We can reach it via `advancedFrameSettings`" counts as **Orange at best**, never Green.
   - Dedicated nice flags or ergonomic methods in the reference that we only expose via escape hatch = Orange.
   - Missing first-class support for something the reference treats as important = Red.
5. After each library section, add a "Summary of New Gaps" subsection.
6. At the very end, produce a consolidated "Master Gap List for 2026-06" that can be used to update the main matrix or spawn new design notes.

### Per-Library Audit Process Checklist

Copy this short checklist when you start work on a new library:

- [ ] Fetched the reference source at a **pinned commit** (recorded below)
- [ ] Re-verified all pre-seeded example rows against the actual code I fetched
- [ ] Prepared to use **❌** (missing) or **🟠** (needs improvement) unless there is clear first-class support
- [ ] Will not trust old notes without re-checking them in the real source

---

## Recommended Structure for Each Library Section

When writing in `REFERENCE_CODE_AUDIT.md`, start every library with a **Reproducibility Header** like this:

```markdown
## 1. cjxl_main.cc

**Reproducibility**
- Commit / Revision: `<exact hash or tag>`
- Fetched via: `git ls-remote` + raw URL / git clone + checkout / docs.rs / etc.
- Date fetched: YYYY-MM-DD
- Date audited: YYYY-MM-DD

**Seeded rows status:** All pre-existing example rows were re-verified against the pinned source above. [Yes / Partial / No — see notes]

**Notes on process:**
- (Optional: any shortcuts taken, unusual decisions, etc.)
```

This header format gives future readers immediate confidence in the audit's reliability.

## Warning About Pre-Seeded Rows

The file `REFERENCE_CODE_AUDIT.md` contains some example rows that were seeded as scaffolding when this handoff was created (e.g. GROUP_ORDER, DOTS, EPF, BUFFERING).

**These seeds are NOT verified findings.** They exist only to show the expected format.

**You must re-verify every single seeded row against the actual source code you fetch before keeping or modifying the severity.** Treat them as "suggested starting points to investigate", not as established truth. The instruction to "be ruthless" applies to the seeds as much as to anything you discover yourself.

---

## Template for Library Sections

```markdown
## Library: cjxl_main.cc

**Reproducibility**
- Commit / Revision: `<exact hash or tag>`
- Fetched via: `git ls-remote` + raw URL / git clone + checkout
- Date fetched: 2026-06-XX
- Date audited: 2026-06-XX

**Seeded rows status:** All pre-existing example rows were re-verified against the pinned source above. [Yes / Partial / No]

### Key Observations Not Fully Captured in Prior Notes

- ...

### Detailed Gap Table

| Ref Feature / Pattern | Location | WASM Status | Native Status | Severity | Recommendation |
|-----------------------|----------|-------------|---------------|----------|----------------|
| GROUP_ORDER + center controls | ProcessFlags + cmdline | 🟠 (only via escape) | ... | Orange | First-class option + benchmark |
| ... | ... | ... | ... | ... | ... |

### New Gaps Summary
- ...
```

---

## Current Known Methodological Debt (from prior session)

- Our `advancedFrameSettings` escape hatch is powerful but means many real reference features are "technically possible" but not ergonomic or discoverable.
- Several controls that have dedicated nice flags in cjxl (and dedicated enum values) are not first-class in our `EncoderOptions`.
- Streaming / buffering modes, group ordering for progressive, fine-grained JPEG metadata control, EPF/Gaborish/Dots/Patches as named options, etc., are candidates for Orange/Red.

---

## Next Steps After Filling the Audit

1. Update `FEATURE_PARITY_MATRIX.md` with any high-impact new rows or status changes (use Red/Orange where appropriate).
2. Create new `designs/` notes for any high-value missing features.
3. Update `REFERENCE_INDEX.md` with newly discovered important patterns from the real code.
4. Append a summary entry to `PROGRESS_LOG.md`.

---

**Handoff complete.** You now have a clean, focused artifact to drive the next iteration without carrying the full weight of the previous conversation context.

When you have gone through one or two libraries, feel free to share the updated audit file and we can decide on prioritization and implementation slices.
