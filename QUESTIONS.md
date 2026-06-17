# EpicCodeReview — Deferred items & questions

Run: `epiccodereview/20260617T202430Z` (core decode chain, modelswitching)

---

## Section 002 — jxl-core (contract package)

jxl-core itself is a clean, well-built contract package (matches its 5/5 score). One
safe local fix landed (`buffering` inline object deduped to `BufferingControls`). The
rest of the confirmed findings describe **cross-package contract debt whose fix lives in
jxl-session / jxl-worker-* , not in jxl-core** — adding/narrowing shared types from this
section would either break exhaustive consumer switches (tsc can't see them from here) or
add optional fields that nothing populates (a *worse* contract: caller passes a field that
is silently dropped). Per the fixer guardrails these are deferred to the jxl-session /
jxl-worker passes, where the producer/consumer can be wired atomically.

> Heads-up: MEMORY.md records that several of these consumer-side seams were recently fixed
> (jxl-scheduler S1/S2/S3, jxl-worker-node W-1/W-2 identity guard, decode-session). **Verify
> current consumer code before acting** — some items below may already be closed.

### A. Cross-package contract debt (fix in jxl-session / jxl-worker pass)

1. **MsgEncodeStart drops ~15 EncodeOptions fields** — `modular, brotliEffort, decodingSpeed,
   photonNoiseIso, buffering, advancedControls, jpegReconstruction, alreadyDownsampled,
   upsamplingMode, ecResampling, frameIndexing, allowExpertOptions` have no wire field, and
   `progressiveFlavor / progressiveAc / qProgressiveAc` exist on `MsgEncodeStart` but
   `encode-session.ts` never copies them → silently dropped before reaching the worker.
   Root cause + fix → ADR `encode-options-normalization-utility.md`. (Matches prior
   encode-session/types lens handoff: "~15 fields never forwarded".)

2. **Worker error codes are not in `JxlErrorCode`** — workers emit `DuplicateSession,
   UnhandledError, UnhandledRejection, WorkerError, MessageDeserializeError`; both sessions'
   `normalizeCode()` collapse anything unknown to `"Internal"`, losing the real cause. The
   wire `code` field is typed `string`, not `JxlErrorCode`, so TS never catches it
   (e.g. `spawn.ts` emits `code:"WorkerError"`). Fix = decide the canonical code set, then
   widen the union *and* the runtime `KNOWN_JXL_ERROR_CODES` Set together (cross-package).

3. **`MsgWorkerError` has no `sessionId`** (protocol.ts ~305) — a top-level worker crash
   mid-decode is not attributable to the owning session and isn't a terminal message, so
   `done()` can hang. Fix spans worker (set sessionId) + scheduler/session (route + treat as
   terminal). Check whether jxl-worker-node "crash-as-graceful-ack" fix already covers this.

4. **`DecodeFrameMeta` fields dropped by session `makeFrame`** — `sourceScale,
   progressiveSequence, passOrdinal, frameIndex, frameDuration, frameName,
   animTicksPerSecond, progressiveRegion, regionFallback` ride decode_progress/decode_final
   but never reach `DecodeFrameEvent` consumers. Fix in `decode-session.ts makeFrame`.

5. **`decode_budget_exceeded` metadata gaps** — carries no folded metrics; the node backend
   drops `region` (browser keeps it) → backend-divergent shape; it doesn't extend
   `DecodeFrameMeta` so the "best frame so far" loses progressive metadata. Fixes in
   worker(node) + decode-session.

6. **Unbounded / unsanitized error `message` strings** — only the decode path truncates;
   encode/worker paths do not. Truncation belongs in the worker handlers (out of section).

7. **`MsgDecodeError` partial-pixel fields independently optional** (protocol.ts ~142) —
   permits the invalid "pixels present but stride absent/0" state every consumer must defend
   against. A required-together union would fix it but narrows a shared type → needs a
   coordinated change with all producers/consumers.

### B. Needs product/intent decision

8. **`effort` typed `1..9` vs `allowExpertOptions` JSDoc claiming effort 10/11** (types.ts:160,
   MsgEncodeStart:185). Should expert effort 10/11 be representable? If yes, widen both the
   `EncodeOptions.effort` and `MsgEncodeStart.effort` types (+ guarded runtime check); if no,
   correct the JSDoc. Did not guess — needs intent. (Mechanism → ADR
   `numeric-invariant-checking-convention.md`.)

### C. ADR drafts written (awaiting ratification)

- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/encode-options-normalization-utility.md`
  — extract a single typed `encodeOptionsToStartMsg()` mapper with an exhaustiveness guard.
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/protocol-version-handshake.md`
  — add `PROTOCOL_VERSION` constant + assert at `worker_ready` (keep fire-and-forget intact).
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/runtime-validation-at-worker-boundary.md`
  — lightweight hand guards for drift-detection (boundary is first-party, not untrusted input).
- `.epiccodereview/20260617T202430Z/sections/002/adr_draft/numeric-invariant-checking-convention.md`
  — dev-mode `assertInvariant` helper for the prose-only numeric contracts.

### D. Inspected and intentionally NOT changed (low value / speculative)

- **errors.ts `Object.setPrototypeOf` / redundant `cause` field** — no concrete failure at
  the package's `target: ES2022` (native classes; `instanceof` works; line 35 re-sets
  `cause`). Only matters if a consumer re-transpiles dist to ES5 — speculative for an ESM
  (`module: ES2022`) lib. Skipped as opportunistic.
- **protocol.ts JSDoc wording on `progressiveDc`/`groupOrder`** — cosmetic, not behavioral.
- **`src/schemas/*.json` (`additionalProperties:false` omits real fields)** — the schemas
  are currently **unconsumed** (no importer; verifier-confirmed). Fixing is low-value until
  wired; folded into the runtime-validation ADR.

### E. Verifier-uncertain (could not confirm from available code)

- `errors.ts:22` — `JxlError.partial` may hold a `DecodeFrameEvent` whose `pixels`
  ArrayBuffer was transferred/neutered; only producer uses a live buffer, no concrete detach.
- `protocol.ts:90-167` — worker→main pixel messages carry `pixelStride/outputBytes/region`
  with no bounds; OOB impact depends on consumer + a forged-message threat model.
- `protocol.ts:137-146` — free-form error `message`; info-leak depends on consumer.
- `types.ts:51-84` — `Region`/resize fields are unconstrained numbers; allocation/OOB impact
  depends on the pipeline, not the contract layer.
