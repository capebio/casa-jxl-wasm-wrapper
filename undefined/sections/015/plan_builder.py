import json

# Build plan from confirmed findings for section 015 (jxl-wasm)
findings_data = [
    # logic findings
    {"id": "logic-2", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1515, "line_end": 1539, "severity": "high", "finding_type": "issue", "category": "wrong-arithmetic", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Use actual bytes written (woff) instead of pre-drain batchBytes in progressive decoder push call",
     "reason": "One-line argument substitution decPush(dec, chunkBufPtr, woff); no design judgment."},

    {"id": "logic-3", "file": "packages/jxl-wasm/scripts/benchmark-pgo.mjs", "line_start": 70, "line_end": 76, "severity": "low", "finding_type": "issue", "category": "off-by-one", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Move `warmed` flag inside scenario loop so each scenario gets its own warm-up run",
     "reason": "Move variable declaration inside the loop; trivial."},

    {"id": "logic-4", "file": "packages/jxl-wasm/src/bridge.cpp", "line_start": 1786, "line_end": 1787, "severity": "medium", "finding_type": "issue", "category": "wrong-arithmetic", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Fix JXTC vertical tile-seam blend: assign separate lerp values to pL and pR instead of same blended value",
     "reason": "Requires correct lerp math for both sides (pL=lerp(l,r,0.25), pR=lerp(l,r,0.75)); visual quality impact."},

    {"id": "logic-5", "file": "packages/jxl-wasm/src/bridge.cpp", "line_start": 1803, "line_end": 1807, "severity": "medium", "finding_type": "issue", "category": "wrong-arithmetic", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Fix JXTC horizontal tile-seam blend: assign separate lerp values to pT and pB instead of same blended value",
     "reason": "Parallel to logic-4; requires same lerp fix for horizontal seam.",
     "depends_on": ["015-logic-4"]},

    {"id": "logic-6", "file": "packages/jxl-wasm/scripts/benchmark-pgo.mjs", "line_start": 143, "line_end": 147, "severity": "high", "finding_type": "issue", "category": "copy-paste-error", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Fix encodeRgba8 to allocate and pass separate ICC, EXIF, XMP metadata pointers instead of same metaPtr",
     "reason": "Copy-paste fix: allocate separate buffers for each metadata slot; trivial."},

    {"id": "logic-8", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1621, "line_end": 1622, "severity": "medium", "finding_type": "issue", "category": "off-by-one", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Normalize passOrdinal on final event to use flushCount-1 for consistency with progress events",
     "reason": "One-line fix changing passOrdinal on final event from flushCount to flushCount-1."},

    {"id": "logic-11", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2646, "line_end": 2651, "severity": "medium", "finding_type": "issue", "category": "wrong-default", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Add JSDoc warning to distanceFromQuality documenting that null quality produces lossy output (distance=1)",
     "reason": "Add JSDoc warning or change default to throw; trivial."},

    {"id": "logic-13", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 593, "line_end": 640, "severity": "medium", "finding_type": "opportunity", "category": "missing-invariant-check", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add test for rgb8 format path in expectedPixelBytes to catch channel-count regressions",
     "reason": "Requires writing an encode test with rgb8 format and verifying correct byte count."},

    # security findings
    {"id": "security-1", "file": "packages/jxl-wasm/scripts/pgo-train.mjs", "line_start": 6, "line_end": 14, "severity": "high", "finding_type": "issue", "category": "path-traversal", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Validate JXL_PGO_MODULE_JS path against trusted build artifact root before dynamic import",
     "reason": "Add path.resolve + startsWith(packageRoot) guard; trivial build-time hardening."},

    {"id": "security-2", "file": "packages/jxl-wasm/scripts/benchmark-pgo.mjs", "line_start": 56, "line_end": 58, "severity": "high", "finding_type": "issue", "category": "path-traversal", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Validate moduleJs path in benchmarkModule against expected build artifact root before dynamic import",
     "reason": "Same pattern as security-1; add resolve + root-prefix guard."},

    {"id": "security-3", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 24, "line_end": 27, "severity": "medium", "finding_type": "issue", "category": "path-traversal", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Validate LIBJXL_REPO env var against https:// prefix before passing to git clone in build-pgo.mjs",
     "reason": "Add URL prefix guard; trivial."},

    {"id": "security-4", "file": "packages/jxl-wasm/scripts/build.mjs", "line_start": 20, "line_end": 22, "severity": "medium", "finding_type": "issue", "category": "path-traversal", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Validate LIBJXL_REPO, DOCKER_BIN, EMSDK_IMAGE env vars before use in build.mjs subprocess calls",
     "reason": "Same pattern as security-3 in build.mjs; add URL/path prefix guards."},

    {"id": "security-5", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 380, "line_end": 395, "severity": "medium", "finding_type": "issue", "category": "path-traversal", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add root-containment check in expandGlob to prevent directory traversal above manifest root",
     "reason": "Add path.resolve + startsWith(root) check after resolution; requires handling both glob and non-glob paths."},

    {"id": "security-6", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 237, "line_end": 258, "severity": "medium", "finding_type": "issue", "category": "unsafe-deserialization", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add file-hash integrity check on PGO lock file before using its scenarios",
     "reason": "Requires choosing a verification strategy (hash in separate .sig or inline); moderate."},

    {"id": "security-7", "file": "packages/jxl-wasm/src/bridge.cpp", "line_start": 1092, "line_end": 1146, "severity": "high", "finding_type": "issue", "category": "integer-overflow", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Add sw > 0 and sh > 0 guards to BoxDownscaleRgba8 to prevent overflow in ceiling division path",
     "reason": "Add two-line early return guard; trivial."},

    {"id": "security-8", "file": "packages/jxl-wasm/scripts/build.mjs", "line_start": 665, "line_end": 668, "severity": "medium", "finding_type": "issue", "category": "shell-injection", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Remove shell:true from runEmscripten .bat invocation in build.mjs; use cmd.exe /c explicit array form",
     "reason": "Requires understanding .bat invocation on Windows without shell:true; moderate."},

    {"id": "security-9", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 753, "line_end": 758, "severity": "medium", "finding_type": "issue", "category": "shell-injection", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Remove shell:true from runEmscripten .bat invocation in build-pgo.mjs; mirror fix from security-8",
     "reason": "Same fix as security-8 in build-pgo.mjs.",
     "depends_on": ["015-security-8"]},

    {"id": "security-10", "file": "packages/jxl-wasm/scripts/pgo-train.mjs", "line_start": 244, "line_end": 248, "severity": "low", "finding_type": "issue", "category": "path-traversal", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Replace custom pathToFileUrl with Node pathToFileURL from node:url to get proper path normalization",
     "reason": "One-line import substitution; trivial."},

    {"id": "security-11", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 260, "line_end": 290, "severity": "medium", "finding_type": "opportunity", "category": "missing-input-validation", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add allow-list validation for PGO manifest op field and length limit for name in normalizeManifest",
     "reason": "Add op allow-list ['encode','decode'] and name length cap; straightforward."},

    {"id": "security-12", "file": "packages/jxl-wasm/src/loader.ts", "line_start": 56, "line_end": 78, "severity": "medium", "finding_type": "opportunity", "category": "missing-integrity-check", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Wire wasmIntegrity from build manifest into fetch options.integrity for WASM binary verification",
     "reason": "Requires understanding the loader+manifest interface to thread integrity hash into fetch; straightforward."},

    # errors findings
    {"id": "errors-1", "file": "packages/jxl-wasm/scripts/pgo-train.mjs", "line_start": 14, "line_end": 14, "severity": "high", "finding_type": "issue", "category": "unhandled-rejection", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Wrap top-level import() in pgo-train.mjs with try/catch that reports the attempted module path",
     "reason": "Add try/catch around import() with diagnostic message; trivial."},

    {"id": "errors-2", "file": "packages/jxl-wasm/scripts/build.mjs", "line_start": 129, "line_end": 129, "severity": "medium", "finding_type": "issue", "category": "swallowed-exception", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Replace bare catch {} in PGO auto-stage block with ENOENT-only silent guard; log other errors",
     "reason": "Add code === ENOENT check; otherwise console.warn; trivial."},

    {"id": "errors-3", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 648, "line_end": 651, "severity": "medium", "finding_type": "issue", "category": "swallowed-exception", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Replace bare catch {} in cloneSubmoduleAtCommit with ENOENT-specific guard; log other errors",
     "reason": "Same pattern as errors-2; trivial."},

    {"id": "errors-4", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 537, "line_end": 541, "severity": "medium", "finding_type": "issue", "category": "missing-error-propagation", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Include compile error message in WebAssembly.validate failure throw in linkBridge",
     "reason": "Forward the caught compile error or use WebAssembly.compile for better diagnostics; trivial."},

    {"id": "errors-5", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 572, "line_end": 576, "severity": "medium", "finding_type": "issue", "category": "swallowed-exception", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Replace bare catch in ensureLibjxlSource with ENOENT-specific guard to avoid silent rm+reclone on permission errors",
     "reason": "Check error.code === ENOENT; log and rethrow others; trivial."},

    {"id": "errors-6", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1041, "line_end": 1055, "severity": "high", "finding_type": "issue", "category": "resource-leak", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Wrap encodeRgb16Planar plane pointer allocations in try/finally to free rPtr/gPtr on OOM",
     "reason": "Add try/finally block around three ensureU16Heap calls; requires careful WASM heap management."},

    {"id": "errors-8", "file": "packages/jxl-wasm/scripts/benchmark-pgo.mjs", "line_start": 183, "line_end": 201, "severity": "medium", "finding_type": "issue", "category": "unbounded-input", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add i >= bytes.length bounds check to outer while loop in parsePpmHeader to prevent infinite loop on truncated input",
     "reason": "Add outer bounds check with useful error on truncated/non-PPM input; straightforward."},

    {"id": "errors-9", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1632, "line_end": 1636, "severity": "medium", "finding_type": "issue", "category": "misleading-error-message", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Fix inputClosed error message in eventsProgressive to not report 'JXL decode error: 0' when decError returns 0",
     "reason": "Add conditional message or use specific 'unexpected end of stream' message; trivial."},

    {"id": "errors-10", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1411, "line_end": 1419, "severity": "medium", "finding_type": "issue", "category": "hard-throw-on-oom", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Fall back to normal transfer path (reusablePixelBuf=null) instead of throwing on OOM in deferredRelease pre-allocation",
     "reason": "Change throw to fallback assignment with warning; trivial."},

    {"id": "errors-11", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1449, "line_end": 1458, "severity": "low", "finding_type": "issue", "category": "hard-throw-on-overflow", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Grow deferredRelease buffer in preparePixelsForEmit when pixel data exceeds pre-allocated capacity",
     "reason": "Requires reallocating reusablePixelBuf and updating reusablePixelCap; depends on errors-10.",
     "depends_on": ["015-errors-10"]},

    {"id": "errors-12", "file": "packages/jxl-wasm/src/loader.ts", "line_start": 85, "line_end": 94, "severity": "medium", "finding_type": "issue", "category": "swallowed-exception", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Require getFreshResponse for compileFromResponse fallback instead of using partially-consumed response",
     "reason": "Requires changing fallback logic to throw if getFreshResponse not provided; straightforward."},

    {"id": "errors-15", "file": "packages/jxl-wasm/scripts/build-pgo.mjs", "line_start": 425, "line_end": 430, "severity": "low", "finding_type": "issue", "category": "missing-precondition-check", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Add upfront llvm-profdata existence check with actionable error message before mergeProfiles",
     "reason": "Add which/existsSync check with clear error message; trivial."},

    {"id": "errors-16", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1986, "line_end": 1986, "severity": "info", "finding_type": "opportunity", "category": "no-structured-logging", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Gate LibjxlEncoder console.log profiling telemetry behind debug flag or route through onMetric callback",
     "reason": "Replace console.log with onMetric call or debug-mode guard; trivial."},

    {"id": "errors-17", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 972, "line_end": 978, "severity": "info", "finding_type": "opportunity", "category": "no-structured-logging", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Remove or gate unconditional console.log in decodeTiledRegionRgba8 and decodeTileContainerRegion hot path",
     "reason": "Delete or add debug-flag guard; trivial."},

    {"id": "errors-18", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 466, "line_end": 477, "severity": "low", "finding_type": "opportunity", "category": "no-error-taxonomy", "tier": "sonnet", "task_kind": "adr_draft",
     "title": "ADR: Define typed WASM error classes (OomError, DecodeError) to let scheduler make informed retry decisions",
     "reason": "Cross-cutting API design: affects facade, decode-handler, and scheduler retry logic; needs design before implementation."},

    {"id": "errors-19", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 3141, "line_end": 3175, "severity": "medium", "finding_type": "issue", "category": "wasm-ffi-type-error", "tier": "opus", "task_kind": "direct_fix",
     "title": "Fix perceptualConstancyApplyBulk to pass WASM heap pointer integers not JS Float32Array objects to AVX2 function",
     "reason": "Requires WASM heap alloc, Float32Array copy-in, call with pointer integers, copy-out — significant FFI refactor."},

    # concurrency findings
    {"id": "concurrency-1", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2374, "line_end": 2384, "severity": "medium", "finding_type": "issue", "category": "check-then-act", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Verify loadLibjxlModule double-load race is fully closed: ensure rejection only clears promise if it is still the current one",
     "reason": "The p===modulePromise guard is present; verify it covers all paths; trivial audit + comment."},

    {"id": "concurrency-2", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1906, "line_end": 1972, "severity": "high", "finding_type": "issue", "category": "missing-await", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Serialize queuedPixelBytes increment inside push-task chain to prevent byte-count drift from concurrent pushPixels",
     "reason": "Move increment inside the .then() task to keep it serialized; requires understanding chaining semantics."},

    {"id": "concurrency-3", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1975, "line_end": 2063, "severity": "high", "finding_type": "issue", "category": "resource-leak", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add post-creation cancel check in initModule to free wasmEncState if cancel() fired during module load",
     "reason": "Add cancel check after state creation with immediate freeWasmState(); straightforward."},

    {"id": "concurrency-4", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2065, "line_end": 2070, "severity": "medium", "finding_type": "issue", "category": "undocumented-contract", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Add JSDoc to LibjxlEncoder.finish() documenting idempotency and that chunks() is non-idempotent",
     "reason": "Documentation only; trivial."},

    {"id": "concurrency-5", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 566, "line_end": 584, "severity": "medium", "finding_type": "issue", "category": "shared-mutable-state", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Document required afterEach cleanup for module-level test state; add reset assertions or factory isolation",
     "reason": "Requires documenting required test cleanup and optionally refactoring into a context object; straightforward."},

    {"id": "concurrency-6", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2319, "line_end": 2332, "severity": "medium", "finding_type": "issue", "category": "resource-leak", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Guard chunks() generator enc_take_chunk loop against cancelled wasmEncState=0 to prevent UB call",
     "reason": "Add wasmEncState check inside generator loop before each enc_take_chunk call; needs careful generator-cancel semantics."},

    {"id": "concurrency-7", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2597, "line_end": 2616, "severity": "medium", "finding_type": "issue", "category": "dangling-wasm-view", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Strengthen JSDoc on takeBufferView: caller must copy data synchronously before any WASM allocation",
     "reason": "Enhance existing comment at line 2599 to be more prominent; trivial."},

    {"id": "concurrency-8", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1876, "line_end": 1887, "severity": "medium", "finding_type": "issue", "category": "resource-leak", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Call decFree explicitly in LibjxlDecoder.dispose() to prevent WASM state leak when generator finally is skipped",
     "reason": "Add decFree call in dispose() with a guard for already-freed state; requires tracking dec handle lifetime."},

    {"id": "concurrency-9", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 74, "line_end": 76, "severity": "low", "finding_type": "issue", "category": "swallowed-exception", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Log non-quota IDB write failures in writeIndexedDbModule catch instead of swallowing them silently",
     "reason": "Add code check: only swallow QuotaExceededError; console.warn others; trivial."},

    {"id": "concurrency-10", "file": "packages/jxl-wasm/src/loader.ts", "line_start": 23, "line_end": 47, "severity": "low", "finding_type": "opportunity", "category": "cancellation-token", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Plumb AbortSignal through IDB read/write in loader.ts to enable abort during cold cache operations",
     "reason": "Thread signal into readIndexedDbModule/writeIndexedDbModule and check on IDB transactions."},

    # contracts findings
    {"id": "contracts-1", "file": "packages/jxl-wasm/test/pyramid-bridge-runtime.test.ts", "line_start": 2, "line_end": 2, "severity": "high", "finding_type": "issue", "category": "missing-export", "tier": "opus", "task_kind": "direct_fix",
     "title": "Implement encodeRgba8Pyramid and downscaleRgba16 in facade.ts or remove the broken test file",
     "reason": "Requires implementing two missing pyramid encode and downscale functions with full WASM bridge wiring, or deciding to delete stub tests."},

    {"id": "contracts-2", "file": "packages/jxl-wasm/exports.txt", "line_start": 33, "line_end": 63, "severity": "high", "finding_type": "issue", "category": "exports-drift", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add TypeScript declarations for ~25 undeclared WASM exports in LibjxlWasmModule interface",
     "reason": "Review each undeclared symbol and add correct TS signatures; straightforward but methodical."},

    {"id": "contracts-3", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 748, "line_end": 749, "severity": "medium", "finding_type": "issue", "category": "undocumented-contract", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Document ButteraugliComparator.compare() synchronous contract and module-snapshot behavior in JSDoc",
     "reason": "JSDoc documentation only; trivial."},

    {"id": "contracts-4", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 878, "line_end": 913, "severity": "medium", "finding_type": "issue", "category": "inconsistent-validation", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Unify tileSize minimum to >= 16 in encodeTileContainer to match encodeTiledRgba8 validation contract",
     "reason": "Change < 1 check to < 16 in encodeTileContainer; trivial."},

    {"id": "contracts-5", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 594, "line_end": 638, "severity": "medium", "finding_type": "issue", "category": "serialization-drift", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add JSDoc to serializeExtraChannelsForWasm documenting the required two-step HEAPU8.set pattern for plane_ptr fields",
     "reason": "Docstring update plus test exercising the full two-copy pattern; straightforward."},

    {"id": "contracts-6", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 600, "line_end": 605, "severity": "medium", "finding_type": "issue", "category": "silent-drop", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Change EXTRA_TYPE_TO_JXL fallback from silent ?? 15 to console.warn for unrecognized ExtraChannelType",
     "reason": "Replace silent fallback with warning or throw; trivial."},

    {"id": "contracts-7", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2065, "line_end": 2069, "severity": "low", "finding_type": "issue", "category": "undocumented-contract", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Add JSDoc to JxlEncoder interface documenting finish() idempotency and chunks() non-idempotency",
     "reason": "Documentation only; trivial."},

    {"id": "contracts-8", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 23, "line_end": 84, "severity": "medium", "finding_type": "issue", "category": "return-shape-drift", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Add optional sourceScale, region, progressiveSequence, passOrdinal fields to budget_exceeded DecodeEvent variant",
     "reason": "Type union extension; trivial."},

    {"id": "contracts-9", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 673, "line_end": 702, "severity": "medium", "finding_type": "issue", "category": "missing-input-validation", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Add width/height > 0 guards to computePsnrWasm and computeSsimWasm matching butteraugliPixelSize pattern",
     "reason": "Add dimension check matching existing butteraugli guard; trivial."},

    {"id": "contracts-10", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2226, "line_end": 2236, "severity": "medium", "finding_type": "issue", "category": "silent-drop", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "On partial metadata OOM, preserve successfully-allocated boxes and only drop the failing one",
     "reason": "Restructure metadata allocation to be independent per box; straightforward logic change."},

    {"id": "contracts-11", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 330, "line_end": 410, "severity": "medium", "finding_type": "opportunity", "category": "missing-contract-test", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Add post-load WASM symbol contract verification asserting all LibjxlWasmModule interface fields are present",
     "reason": "Iterate declared interface fields and check module presence at load time; straightforward."},

    {"id": "contracts-12", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 3097, "line_end": 3175, "severity": "low", "finding_type": "issue", "category": "silent-fallback", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Emit onMetric or console.warn when perceptualConstancyApplyBulk falls back to identity due to missing WASM functions",
     "reason": "Add one-line metric emission or warning in identity fallback branch; trivial."},

    # performance findings
    {"id": "perf-1", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1407, "line_end": 1420, "severity": "medium", "finding_type": "issue", "category": "alloc-in-hot-path", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Size deferredRelease pre-allocation to actual image dimensions from header event instead of fixed 8 MB estimate",
     "reason": "Requires resizing reusablePixelBuf after header event; needs header info available at allocation time."},

    {"id": "perf-2", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 1463, "line_end": 1469, "severity": "medium", "finding_type": "issue", "category": "redundant-alloc", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Skip full-frame copy in takeAndWrap when no region/downsample is applied by using takeBuffer directly",
     "reason": "Distinguish no-op path from region path; use takeBuffer instead of retainBufferView+copy."},

    {"id": "perf-3", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 972, "line_end": 978, "severity": "medium", "finding_type": "issue", "category": "console-log-hot-path", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Remove or gate console.log calls in decodeTiledRegionRgba8 and decodeTileContainerRegion tile hot path",
     "reason": "Delete or add debug guard; trivial. Fixes same issue as errors-17.",
     "depends_on": ["015-errors-17"]},

    {"id": "perf-4", "file": "packages/jxl-wasm/scripts/benchmark-pgo.mjs", "line_start": 194, "line_end": 194, "severity": "low", "finding_type": "issue", "category": "alloc-in-loop", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Hoist TextDecoder instantiation outside parsePpmHeader token loop to module-level constant",
     "reason": "Move new TextDecoder() to module scope; trivial."},

    {"id": "perf-5", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2723, "line_end": 2729, "severity": "low", "finding_type": "issue", "category": "quadratic-scan", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Optimize scanForValidJpeg to advance offset by jpegEnd on failed candidates to avoid O(n*m) worst case",
     "reason": "Add offset jump on failed JPEG candidate; requires understanding findValidJpegEnd contract."},

    {"id": "perf-6", "file": "packages/jxl-wasm/src/facade.ts", "line_start": 2890, "line_end": 2920, "severity": "low", "finding_type": "issue", "category": "redundant-computation", "tier": "haiku", "task_kind": "direct_fix",
     "title": "Hoist y-fraction multiplications out of x-loop in bilinearResize rgba16/rgbaf32 to halve per-pixel multiplications",
     "reason": "Compute (1-yt) and yt once per row; straightforward arithmetic hoist."},

    {"id": "perf-7", "file": "packages/jxl-wasm/src/bridge.cpp", "line_start": 726, "line_end": 735, "severity": "low", "finding_type": "issue", "category": "excessive-realloc", "tier": "sonnet", "task_kind": "direct_fix",
     "title": "Change EncodeRgbaWithMetadata output buffer growth factor from 2x to 1.5x to reduce peak WASM heap waste",
     "reason": "Change growth factor constant; verify no off-by-one in new size; straightforward."},

    {"id": "perf-8", "file": "packages/jxl-wasm/scripts/benchmark-pgo.mjs", "line_start": 1, "line_end": 45, "severity": "info", "finding_type": "opportunity", "category": "no-performance-ci", "tier": "sonnet", "task_kind": "adr_draft",
     "title": "ADR: Wire PGO benchmark regression gate into CI using compareEncodeBenchmarks with 2% threshold",
     "reason": "Requires CI design decision: runner choice, baseline storage, threshold policy; needs ADR before implementation."},
]

# Build tasks
tasks = []
for f in findings_data:
    task = {
        "task_id": f"015-{f['id']}",
        "finding_id": f["id"],
        "title": f["title"],
        "file": f["file"],
        "severity": f["severity"],
        "finding_type": f["finding_type"],
        "category": f["category"],
        "tier": f["tier"],
        "task_kind": f["task_kind"],
        "status": "pending",
        "reason_for_tier": f["reason"],
    }
    if f.get("line_start") is not None:
        task["line_start"] = f["line_start"]
    if f.get("line_end") is not None:
        task["line_end"] = f["line_end"]
    if f.get("depends_on"):
        task["depends_on"] = f["depends_on"]
    tasks.append(task)

# Counts
total = len(tasks)
issue_count = sum(1 for t in tasks if t["finding_type"] == "issue")
opp_count = sum(1 for t in tasks if t["finding_type"] == "opportunity")
direct_fix = sum(1 for t in tasks if t["task_kind"] == "direct_fix")
adr_draft = sum(1 for t in tasks if t["task_kind"] == "adr_draft")
haiku = sum(1 for t in tasks if t["tier"] == "haiku")
sonnet = sum(1 for t in tasks if t["tier"] == "sonnet")
opus_count = sum(1 for t in tasks if t["tier"] == "opus")

plan = {
    "section_index": 15,
    "section_name": "jxl-wasm",
    "tasks": tasks,
    "counts": {
        "total": total,
        "pending": total,
        "deferred": 0,
        "issue": issue_count,
        "opportunity": opp_count,
        "direct_fix": direct_fix,
        "adr_draft": adr_draft,
        "haiku": haiku,
        "sonnet": sonnet,
        "opus": opus_count,
    }
}

with open("C:/Foo/raw-converter-wasm/undefined/sections/015/plan.json", "w") as f:
    json.dump(plan, f, indent=2)

print(f"Total tasks: {total}")
print(f"Issues: {issue_count}, Opportunities: {opp_count}")
print(f"Direct fix: {direct_fix}, ADR draft: {adr_draft}")
print(f"Haiku: {haiku}, Sonnet: {sonnet}, Opus: {opus_count}")
print("Written plan.json")
