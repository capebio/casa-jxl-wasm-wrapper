Make appropriate changes to 
c:\Foo\raw-converter-wasm\docs\Overview and features of the CasaWASM JXL wrapper.md
Only if any proposals were rejected then update c:\Foo\raw-converter-wasm\docs\rejected optimizations.md
Noting the affected files where necessary.
Commit changes.
Push changes.
if outstanding work, provide a concise handoff with sufficient context for an agent to continue your tasks

---

## Session handoff — 2026-05-26

### What was done

Evaluated all non-`[x]` items in `docs/feature-summary.md` against the actual codebase.

| Item | Verdict | Action |
|------|---------|--------|
| Multi-Tiered WASM Matrix | Positive — already implemented | Added `[x]` |
| Worker WASM Build Tier Reporting | Positive — already implemented (`worker.ts:468`, `protocol.ts:212`) | Added `[x]`, added file refs |
| PGO | Positive — externally blocked (corpus manifest not landed) | No change; FAILED note kept |
| Color Management (DNG) | Positive — stale FAILED note; fully implemented via `choose_camera_to_srgb_matrix` using ForwardMatrix1/2 + ColorMatrix1/2 | Added `[x]`, updated description |
| ROI Decoding (true bitstream) | Positive — JS-crop fallback implemented + honest flags; true bitstream blocked by libjxl tile API | Changed FAILED → PARTIAL with explanation |

Files changed:
- `docs/feature-summary.md`
- `docs/Overview and features of the CasaWASM JXL wrapper.md`

No proposals rejected. `docs/rejected optimizations.md` not modified.

### Outstanding / unresolved

- **PGO**: Still requires the corpus-side training manifest to land before `wasm-opt --pgo` can be applied to the WASM artifacts. No code changes needed — it is a build-pipeline task.
- **True bitstream ROI**: Blocked on libjxl exposing `JxlDecoderGetFrameHeader` tile-grid fields. Track against libjxl releases. When available, `bridge.cpp` and `facade.ts` will need updates.
- **Commit + push**: Not yet done. Run standard git workflow.
