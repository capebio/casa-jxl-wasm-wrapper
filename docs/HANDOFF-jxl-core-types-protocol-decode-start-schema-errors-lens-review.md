# HANDOFF — Lens Review: jxl-core types.ts / protocol.ts / schemas/decode_start.json / errors.ts

Date: 2026-06-11. Source: 22-lens in-memory review. Files reviewed:

1. `packages/jxl-core/src/types.ts` (393 ln) — public API contract (spec §5): pixel formats, ImageInfo, Decode/EncodeOptions, session interfaces, metrics, capabilities.
2. `packages/jxl-core/src/protocol.ts` (335 ln) — worker wire contract (spec §16): main↔worker message interfaces + unions.
3. `packages/jxl-core/src/schemas/decode_start.json` (41 ln) — JSON Schema for `MsgDecodeStart`.
4. `packages/jxl-core/src/errors.ts` (38 ln) — error taxonomy (spec §18): `JxlErrorCode` + `JxlError`.

Strategic picture: this is the **contract triple** — types (what callers say), protocol (what crosses the worker boundary), schema (what a validator would accept) — plus the error taxonomy that names every failure. Everything above (session, scheduler) and below (workers, handlers) compiles against these. The review's headline: **the triple has drifted and nothing enforces sync**. The schema rejects every currently-valid `decode_start` message; the protocol omits fields the public types promise; the types omit fields the wire carries semantics for. Individual fixes below; the durable fix is Agent 5's sync harness.

**Spec discipline**: `types.ts` header says *"Do not add fields not present in the spec."* Findings are therefore split into:
- **[SYNC]** — bringing schema/types/protocol into agreement with what the code already does. `protocol.ts` + shipped handlers are reality; implement these directly.
- **[SPEC-AMEND]** — new capability. Implement only the proposal text/JSDoc; do not add fields/messages until approval is granted (request it at the end of your session).

Lens 15 (Butteraugli) note: the relevant knob (`disablePerceptualHeuristics`, ID 39) already exists in both types and protocol; no speed lever lives in these files beyond the field-sync items. Lens 19 note: numeric enum discriminants for message `type` were considered and **rejected** (debuggability loss; string switch is not hot) — recorded here so it isn't re-proposed.

Severity: P0 = active contract break, P1 = real divergence/type hole, P2 = solid improvement, P3 = nice-to-have.

---

## Agent 1 — `packages/jxl-core/src/types.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### T-1 (P1, [SYNC]) — `"rgb8"` is encode-only but decode surfaces accept it
`PixelFormat` includes `"rgb8"` ("encode input only" per its own comment), yet `DecodeOptions.format`, `DecodeFrameEvent.format`, and (Agent 2's side) `MsgDecodeStart.format` are typed `PixelFormat` — the compiler happily accepts a decode into `rgb8`, which the schema (correctly) rejects. Export split aliases and use them:

```ts
export type DecodePixelFormat = Exclude<PixelFormat, "rgb8">;   // rgba8 | rgba16 | rgbaf32
export type EncodePixelFormat = PixelFormat;
// DecodeOptions.format: DecodePixelFormat;  DecodeFrameEvent.format: DecodePixelFormat;
```
Coordinate with Agent 2 (protocol uses the same alias). Check downstream compile fallout (facade, handlers) — if any decode path genuinely passes `rgb8`, that's a bug this change correctly exposes.

### T-2 (P1, [SYNC]) — `effort: 1..9` contradicts `allowExpertOptions`
`EncodeOptions.allowExpertOptions` documents gating `effort=11` ("expert mode… effort 1-11 only when true"), but `effort` is typed `1|…|9` — 10 and 11 are unrepresentable, making the gate dead code at the type level. Widen to `1|2|3|4|5|6|7|8|9|10|11` with JSDoc: "10–11 require `allowExpertOptions: true`; runtime-validated, rejected otherwise." Mirror in `MsgEncodeStart.effort` (Agent 2). Verify the facade/encode-handler actually validates the gate (extend search to `packages/jxl-wasm/src/facade.ts`, `packages/jxl-worker-browser/src/encode-handler.ts`); if not, note it for those owners — do not edit them without approval.

### T-3 (P1, [SYNC]) — duplicated buffering type + ambiguous dual pathway
`EncodeOptions.buffering` is an inline literal identical to the exported `BufferingControls` (and `AdvancedEncoderControls.buffering` is a *third* route to the same knobs; likewise `advancedControls.groupOrder` (`GroupOrderControls`, mode-string flavored) vs top-level `groupOrder: 0|1` + `centerX/centerY`). Two actions:
1. Replace the inline literal: `buffering?: BufferingControls;` — pure dedupe, zero behavior change.
2. Determine real precedence by reading the consumer (facade/encode-handler): which wins when both top-level and `advancedControls` variants are set? Document the answer in JSDoc on both sites (e.g. "top-level wins; `advancedControls` is the legacy grouping"). If the consumer's behavior is order-dependent or contradictory, report it — don't fix other files without approval.

### T-4 (P2, [SYNC]) — extract shared unions; kill literal duplication
The same literal unions are retyped across the two files: priority appears 4× (`"visible"|"near"|"background"`), progressive detail 2×, progression target 2× (≡ `DecodeStage`), wasm build 2× (`Capabilities.selectedWasmBuild` vs `MsgWorkerReady.wasmBuild`). Export once, reuse everywhere (protocol already imports from types — zero new coupling):

```ts
export type Priority = "visible" | "near" | "background";
export type ProgressiveDetail = "dc" | "lastPasses" | "passes" | "dcProgressive";
export type ProgressionTarget = DecodeStage;            // intentional alias, documented
export type WasmBuild = "relaxed-simd-mt" | "simd-mt" | "simd" | "scalar";
// Capabilities.selectedWasmBuild: WasmBuild | "none";
```
Agent 2 consumes these; sequence your change first.

### T-5 (P2, [SPEC-AMEND]) — decode-side orientation + intrinsic size are missing from `ImageInfo`
The encoder can *write* EXIF orientation (1–8, metadata-only rotation) and intrinsic display size — but `ImageInfo` cannot *report* either on decode. Consumers cannot know pixels are in sensor orientation (photogrammetry/digital-twin pipelines need the original orientation tag; a gallery needs intrinsic size for HiDPI layout). Round-trip asymmetry: we can encode what we cannot see back. Proposal (JSDoc + spec note only until approved):

```ts
export interface ImageInfo {
  // ...
  orientation?: 1|2|3|4|5|6|7|8;   // EXIF orientation from basic info; absent = 1
  intrinsicWidth?: number;          // display-size override when signaled
  intrinsicHeight?: number;
}
```
Requires bridge plumbing (`JxlBasicInfo.orientation` / `have_intrinsic_size` are already read by libjxl) — flag for the facade owner; your deliverable is the approved type + spec text.

### T-6 (P3, [SPEC-AMEND]) — `ColorSpaceHint` gaps for the perceptual-color roadmap
Missing plain `"rec2020"` (wide-gamut SDR). Longer-term, the perceptual constancy work (log-space HPCS model in LookRenderer) wants a structured hint — `colorEncoding?: { primaries, transfer, whitePoint }` — so it can skip ICC parsing for the common signaled cases. Write the proposal in the handoff notes for spec discussion; implement only `"rec2020"` if approved, nothing else.

### T-7 (P3, docs) — sharpen ambiguous contracts in place
- `ImageInfo.exif`: state the exact payload layout (JXL Exif box payload = 4-byte TIFF-offset prefix + TIFF data, per ISO/IEC 18181-2) — consumers get this wrong constantly.
- `EncodeSession.getStats()`: add "poll-free pattern: `await done()` then `getStats()!`" to the JSDoc (null-before-done is race-bait as documented).
- `DecodeSession.push` accepts `ArrayBuffer | Uint8Array` while `EncodeSession.pushPixels` accepts only `ArrayBuffer` — document the asymmetry or propose parity ([SPEC-AMEND], minor).
- `hasAnimation`: document the current single-frame contract explicitly ("multi-frame files: only the first frame is decoded/emitted; no frame index/duration surface exists") so the gap is a stated limitation, not silence.

---

## Agent 2 — `packages/jxl-core/src/protocol.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### PR-1 (P0, doc lie, [SYNC]) — header comment is false
Line 3: *"Keys are snake_case per spec."* Keys are camelCase (`sessionId`, `budgetMs`); only the `type` **values** are snake_case. A contract file's header misstating the contract invites a "fix" that breaks every handler. Replace with: `// Message "type" values are snake_case; field keys are camelCase. Per spec §16.`

### PR-2 (P1, [SYNC]) — error `code` fields are untyped `string`
`MsgDecodeError.code`, `MsgEncodeError.code`, `MsgWorkerError.code` are `string`, though the taxonomy exists in `errors.ts`. Type them `JxlErrorCode` (import type from `./errors.js` — no cycle: errors imports only types). The worker boundary is untrusted at runtime, so pair with Agent 4's `toJxlErrorCode()` guard at the receiving side; the static type still kills the "typo'd code string in a handler" bug class at compile time.

### PR-3 (P1, [SYNC]) — `MsgDecodeError` partial payload cannot be reconstructed into a `DecodeFrameEvent`
`JxlError.partial` is a `DecodeFrameEvent`, whose `format` is required. The error message carries `partialPixels/partialInfo/partialPixelStride/partialStage` — but **no format** (contrast `MsgDecodeBudgetExceeded`, which carries `format`). The session layer must currently guess (presumably the requested format — true today, but region/format fallbacks make guessing fragile). Add:

```ts
partialFormat?: PixelFormat;   // required when partialPixels is present
```
and extend the existing "required when partialPixels present" JSDoc convention. Verify the decode-handler populates it (extend search to `packages/jxl-worker-browser/src/decode-handler.ts`); if the handler needs the one-line addition, request approval for that edit.

### PR-4 (P1, [SYNC]) — `DecodeFrameEvent` promises fields no message carries
`DecodeFrameEvent` has `sourceScale?`, `progressiveRegion?`, `regionFallback?` — but `MsgDecodeProgress`/`MsgDecodeFinal` carry none of them (the fallback is only signaled out-of-band via the `region_fallback_full_frame` metric). Determine where the session layer gets these values (extend search to `packages/jxl-session/src/decode-session.ts`): if it derives them from the request + metrics, document that derivation on the message types ("not on the wire; session derives from request/metrics"); if it can't, add the fields to both messages ([SYNC] — the public type already promises them) and flag the handler change for approval.

### PR-5 (P1, [SYNC]) — `MsgEncodeStart` omits a third of `EncodeOptions`
Missing vs the public options: `modular`, `brotliEffort`, `decodingSpeed`, `photonNoiseIso`, `buffering` (whole block), `advancedControls` (filters/EPF/gaborish), `jpegReconstruction` (whole block), `alreadyDownsampled`, `upsamplingMode`, `ecResampling`, `frameIndexing`, `allowExpertOptions`. Either (a) worker encodes silently drop knobs the public API accepts — a contract hole — or (b) they ride a path other than `MsgEncodeStart`. **Verify first** (how the session layer builds `encode_start`, what `encode-handler.ts` reads), then sync the message to reality: add the fields the handler honors; for genuinely-dropped knobs, add them to the message *and* file the handler gap for approval. Note `intrinsicSize`, `disablePerceptualHeuristics`, `codestreamLevel`, `orientation`, `centerX/Y` already made it across — the omissions look like accretion drift, not policy.

### PR-6 (P2, [SYNC]) — factor the repeated frame payload; tighten `decode_progress` stage
`MsgDecodeProgress`, `MsgDecodeFinal`, `MsgDecodeBudgetExceeded` repeat `{sessionId, info, pixels, format, region?, pixelStride}`. Factor:

```ts
interface FramePayloadBase {
  sessionId: string;
  info: ImageInfo;
  pixels: ArrayBuffer;          // transferred
  format: PixelFormat;          // DecodePixelFormat after T-1 lands
  region?: Region;
  pixelStride: number;
}
export interface MsgDecodeProgress extends FramePayloadBase {
  type: "decode_progress";
  stage: Exclude<DecodeStage, "header">;   // header travels as MsgDecodeHeader, never as a pixel frame
}
```
Pure refactor — emitted `.d.ts` shape is identical; drift surface shrinks to one definition.

### PR-7 (P2, docs, [SYNC]) — write the lifecycle guarantees down
Add one comment block stating what handler authors currently reverse-engineer:
- **Terminal messages** (exactly one per decode session): `decode_final` | `decode_error` | `decode_cancelled` | `decode_budget_exceeded`. After a terminal, the worker sends nothing further for that sessionId (except `worker_drain` already in flight).
- **Pause asymmetry is intentional**: `decode_pause` → `decode_paused` ack (preemption barrier); `decode_resume` has no ack (worker simply continues; next frame/drain is the implicit ack).
- **`release_state` has no ack** — fire-and-forget state drop for re-submitted tasks.
- **`decode_budget_exceeded` semantics**: graceful end — frame stream ends with the carried best frame, `done()` rejects `BudgetExceeded` (matches the CLAUDE.md behavioral contract; protocol file should say it too).
- Budget-before-first-pixels edge: state what `pixels` holds when the budget trips pre-DC (zero-length buffer vs last header-stage state) — verify against decode-handler and document the truth.

### PR-8 (P2, [SPEC-AMEND]) — protocol version for stale-worker detection
A service-worker-cached `worker.js` from build N meeting a main bundle from build N+1 fails today as garbled behavior. Proposal: new `version.ts` (keeps protocol.ts type-only) with `export const PROTOCOL_VERSION = 1;` and `MsgWorkerReady.protocolVersion?: number` — main compares on ready, hard-respawns (or errors `CapabilityMissing`) on mismatch. Optional field = old workers stay compatible. Implement only after approval; deliverable otherwise is the proposal text.

### PR-9 (P2, [SPEC-AMEND]) — `decode_set_priority` for live reprioritization
Priority is fixed at `decode_start`. A scrolling pyramid viewer / AR session constantly promotes and demotes tiles; today's only tool is cancel+restart, throwing away decoded passes. Scheduler already owns preemption — this is the missing protocol hook:

```ts
export interface MsgDecodeSetPriority {
  type: "decode_set_priority";
  sessionId: string;
  priority: Priority;
}
```
Check `packages/jxl-scheduler/src/scheduler.ts` first: if the scheduler reprioritizes purely on its own queue (never needs the worker to know), the right design may be session→scheduler API only, with **no** protocol message — in that case write that conclusion down here and in the rejection log instead. Approval required either way.

### PR-10 (P1 perf, verify-first, [SYNC]) — metadata blobs ride every progress frame
`MsgDecodeProgress.info: ImageInfo` — and `ImageInfo` may contain `iccProfile`, `exif`, `xmp` byte arrays. These are **structured-cloned (copied) on every pass** if the handler populates them: a multi-KB ICC × every refinement pass × every concurrent session is real memcpy + GC churn on the hot boundary. Verify what `decode-handler.ts` actually posts. If blobs ride every pass: document the slim-info convention on the protocol ("`decode_header` carries full metadata; `info` on progress/final omits `iccProfile`/`exif`/`xmp`") and request approval for the one-line handler strip. If the handler already strips: encode that as the documented contract so it can't regress.

### PR-11 (P3, [SPEC-AMEND]) — additive metrics for cold-start attribution
`CodecMetric` (Agent 1's file, but wire-relevant here) lacks `worker_spawn_ms` and `wasm_init_ms`; the capabilities/loader work measures these but has no sanctioned channel. Additive union members are backward compatible. Propose; implement on approval.

---

## Agent 3 — `packages/jxl-core/src/schemas/decode_start.json`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: the schema is exported (`package.json` → `"./schemas/*": "./src/schemas/*.json"`); no in-repo runtime validator consumes it (grep found none) — it exists for external validation and as documentation. Three sibling schemas exist (`encode_start.json`, `decode_header.json`, `worker_ready.json`, per STATE.md).

### S-1 (P0, [SYNC]) — schema rejects every currently-valid message
`MsgDecodeStart` gained `progressiveDetail`, `targetWidth`, `targetHeight`, `fitMode` (all non-optional, `X | null`); the schema has `additionalProperties: false` and none of the four — so any honest validator rejects every message the session layer now produces. Corrected schema (full replacement):

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://casabio.org/schemas/jxl-core/decode_start.json",
  "title": "MsgDecodeStart",
  "type": "object",
  "required": [
    "type", "sessionId", "format", "region", "downsample",
    "progressionTarget", "emitEveryPass", "progressiveDetail",
    "preserveIcc", "preserveMetadata", "priority", "budgetMs",
    "targetWidth", "targetHeight", "fitMode"
  ],
  "additionalProperties": false,
  "properties": {
    "type": { "const": "decode_start" },
    "sessionId": { "type": "string" },
    "format": { "enum": ["rgba8", "rgba16", "rgbaf32"] },
    "region": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "required": ["x", "y", "w", "h"],
          "additionalProperties": false,
          "properties": {
            "x": { "type": "integer", "minimum": 0 },
            "y": { "type": "integer", "minimum": 0 },
            "w": { "type": "integer", "minimum": 1 },
            "h": { "type": "integer", "minimum": 1 }
          }
        }
      ]
    },
    "downsample": { "enum": [1, 2, 4, 8] },
    "progressionTarget": { "enum": ["header", "dc", "pass", "final"] },
    "emitEveryPass": { "type": "boolean" },
    "progressiveDetail": {
      "oneOf": [
        { "type": "null" },
        { "enum": ["dc", "lastPasses", "passes", "dcProgressive"] }
      ]
    },
    "preserveIcc": { "type": "boolean" },
    "preserveMetadata": { "type": "boolean" },
    "priority": { "enum": ["visible", "near", "background"] },
    "budgetMs": { "oneOf": [{ "type": "null" }, { "type": "number", "minimum": 0 }] },
    "targetWidth": { "oneOf": [{ "type": "null" }, { "type": "integer", "minimum": 1 }] },
    "targetHeight": { "oneOf": [{ "type": "null" }, { "type": "integer", "minimum": 1 }] },
    "fitMode": {
      "oneOf": [
        { "type": "null" },
        { "enum": ["contain", "cover", "stretch"] }
      ]
    }
  }
}
```
Cross-check every line against the current `MsgDecodeStart` in `protocol.ts` before writing — protocol is the source of truth. Note the `format` enum intentionally excludes `"rgb8"` (encode-only); this is the runtime mirror of Agent 1's T-1.

### S-2 (P2) — `$id` is not a URI
`"jxl-core/decode_start"` violates draft-07 `$id` expectations (relative-reference base); ajv strict mode warns, resolvers mis-base `$ref`s. Use an absolute URI (snippet above) — pick the org-consistent base if one exists elsewhere in the repo.

### S-3 (P2, approval-gated) — audit the three sibling schemas
`encode_start.json`, `decode_header.json`, `worker_ready.json` almost certainly drifted the same way (`MsgEncodeStart` gained ~10 fields since; `MsgWorkerReady` gained `wasmBuild`). They are outside your named file: **audit and produce corrected drafts in your report, request approval before editing them.** PR-5's verification outcome (Agent 2) feeds `encode_start.json` — coordinate.

### S-4 (P3, docs) — state the schema's job
One `"description"` field: "Documentation + external-validation schema for the worker wire message; not enforced at runtime in-repo. Source of truth: src/protocol.ts. Keep in sync via test/protocol-schema-sync.test.ts" (Agent 5's harness). A schema nobody knows the role of is a schema nobody updates.

---

## Agent 4 — `packages/jxl-core/src/errors.ts`

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

### E-1 (P2, [SYNC]) — boundary guard for untrusted code strings
Once Agent 2 types the wire `code` fields as `JxlErrorCode`, the *runtime* boundary still receives arbitrary strings (old workers, future codes, corruption). Add to errors.ts (already a runtime module):

```ts
const CODES: ReadonlySet<string> = new Set([
  "MalformedCodestream", "TruncatedStream", "UnsupportedFeature", "OutOfMemory",
  "BudgetExceeded", "Cancelled", "WorkerCrashed", "CapabilityMissing",
  "ConfigError", "QueueOverflow", "Internal",
]);
export function isJxlErrorCode(s: string): s is JxlErrorCode { return CODES.has(s); }
export function toJxlErrorCode(s: string): JxlErrorCode {
  return isJxlErrorCode(s) ? s : "Internal";
}
```
Keep `CODES` adjacent to the union with a "update both" comment (Agent 5's exhaustiveness trick can enforce: `const _check: Record<JxlErrorCode, true>`-style mapping instead of a bare Set — prefer that form so adding a code without updating the set is a compile error):

```ts
const CODE_MAP: Record<JxlErrorCode, true> = {
  MalformedCodestream: true, TruncatedStream: true, UnsupportedFeature: true,
  OutOfMemory: true, BudgetExceeded: true, Cancelled: true, WorkerCrashed: true,
  CapabilityMissing: true, ConfigError: true, QueueOverflow: true, Internal: true,
};
const CODES: ReadonlySet<string> = new Set(Object.keys(CODE_MAP));
```

### E-2 (P2, [SPEC-AMEND]) — retryability classification
Session/scheduler retry logic needs "is this worth retrying?" per code; today each consumer invents its own list. Proposal:

```ts
/** Codes where a fresh attempt (new worker / re-fetch) can plausibly succeed. */
export const RETRYABLE_CODES: ReadonlySet<JxlErrorCode> =
  new Set(["WorkerCrashed", "OutOfMemory", "QueueOverflow", "Internal"]);
```
**Check first** whether the scheduler already classifies (extend search to `packages/jxl-scheduler/src/scheduler.ts`, session layer); if it does, propose migrating that knowledge here rather than duplicating — and if its list disagrees with the above, its list wins (it has the operational experience). Approval before adding.

### E-3 (P3, docs) — per-code emission guide
JSDoc table on `JxlErrorCode`: one line per code — emitted-by (worker/facade/scheduler), typical trigger, whether `partial` may be present (only `TruncatedStream` and budget paths today), retryable (per E-2). Turns the taxonomy from a name list into an operating manual.

### E-4 (P3, docs + micro-cleanup) — `instanceof` across realms; `cause` handling
- Document: `JxlError` instances never cross the worker boundary (codes + messages do; the session layer re-wraps). `instanceof JxlError` is therefore safe main-side only; cross-realm consumers should switch on `.code`. One JSDoc line prevents a class of "why is instanceof false" bugs.
- The `cause` triple-handling (super options + field declaration + conditional reassign) is correct but only by accident of ordering under `useDefineForClassFields` (field-define overwrites the ES2022 `Error.cause` set by `super`, then the ctor body restores it). Verify the package's tsconfig target/flags; if `useDefineForClassFields` is in play, switch the field to `declare readonly cause?: unknown;` and keep the explicit assignment as the single write. Behavior-neutral; removes the ordering dependence. If the tsconfig makes the current form fully safe, leave it and note why.

---

## Agent 5 — cross-file: contract sync harness (new file `packages/jxl-core/test/protocol-schema-sync.test.ts`)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

You own **one new file** (the test). Do not edit src files or sibling packages without approval; your job is the enforcement loop that makes S-1-class drift impossible to reintroduce. Check the package's existing test setup first (`packages/jxl-core/test/`, `package.json` scripts — repo convention is the node test runner with `dist-test` compilation; mirror whatever sibling packages like jxl-capabilities do).

### X-1 — fixture-vs-schema sync test
A canonical, fully-populated `MsgDecodeStart` fixture **typed against the real interface** (so the compiler keeps the fixture honest), validated against `schemas/decode_start.json`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MsgDecodeStart } from "../src/protocol.js";
import schema from "../src/schemas/decode_start.json" with { type: "json" };

const fixture: MsgDecodeStart = {
  type: "decode_start", sessionId: "s1", format: "rgba8", region: { x: 0, y: 0, w: 8, h: 8 },
  downsample: 2, progressionTarget: "final", emitEveryPass: true, progressiveDetail: "passes",
  preserveIcc: true, preserveMetadata: true, priority: "visible", budgetMs: 250,
  targetWidth: 512, targetHeight: null, fitMode: "contain",
};
```
Two directions, both required:
1. **Schema accepts the typed fixture** (catches schema-behind-protocol — today's S-1).
2. **Schema's `properties` keys ⊆ fixture keys and `required` ⊆ keyof fixture, and every fixture key ∈ schema `properties`** (catches protocol-behind-schema and forgotten `required` updates) — a structural walk, no validator needed.
For direction 1, prefer a ~60-line hand-rolled mini-validator handling exactly the constructs this schema uses (`const`, `enum`, `type`, `oneOf` of null/x, `required`, `additionalProperties:false`, `minimum`, nested object) over adding an `ajv` devDependency — check repo devDeps first; if `ajv` is already present somewhere, use it instead. Run a second fixture with all nullables null and minima at bounds.

### X-2 — exhaustiveness + uniqueness guards (same test file)
- Discriminant uniqueness: build a `Record<MainToWorkerMessage["type"], true>` and `Record<WorkerToMainMessage["type"], true>` object literal — a duplicated or renamed `type` literal becomes a compile error in the test, with zero runtime cost.
- Error-code set sync (Agent 4's E-1): assert `toJxlErrorCode("BudgetExceeded") === "BudgetExceeded"` and `toJxlErrorCode("nonsense") === "Internal"` once E-1 lands (skip gracefully if not yet landed; note ordering).

### X-3 — schema generation (proposal only, approval-gated)
Hand-synced schemas are the disease; X-1 is a vaccine for one message. The cure: a devDependency (`ts-json-schema-generator`) + script emitting schemas for all `MainToWorkerMessage` members into `src/schemas/`, with the test asserting generated == committed. This adds a devDep and a build step — write the proposal (script sketch, package.json diff) and request approval; do not install. If rejected, X-1's pattern extends to the three sibling schemas by hand (coordinate with Agent 3's S-3 drafts).

### X-4 — sequencing
Agent 1's shared unions (T-4) and Agent 3's corrected schema (S-1) land before your test goes green; write the test against the corrected shapes and mark it expected-fail until they merge (node test runner `todo` option), so it documents the target state rather than blocking.

---

## What implementing this achieves

The contract triple becomes a contract again. Today the schema rejects every message the pipeline actually sends, the public encode options promise a dozen knobs the wire may silently drop, the decode-side types promise frame fields no message carries, and the protocol header's own comment misdescribes its casing convention — each one a small lie, and together the kind of drift that turns every future handler bug into an archaeology project. The [SYNC] items (T-1..T-4, PR-1..PR-7, PR-10, S-1, E-1) close every known gap between what the types say, what the wire carries, and what a validator accepts — and Agent 5's harness turns "stay in sync" from a code-review hope into a compile error and a failing test, which is the only form of discipline that survives accretion at this codebase's pace.

The [SPEC-AMEND] items are small protocol investments with outsized leverage for the platform's actual direction: decode-side orientation and intrinsic size make round-trips honest and feed photogrammetry pipelines the sensor-orientation truth they require; `decode_set_priority` gives the pyramid viewer and AR identification loop a way to chase the user's gaze without burning decoded passes on cancel+restart; a protocol version field turns the stale-cached-worker failure mode from undebuggable garbage into a clean respawn; and typed, classified error codes with a retryability set let the session and scheduler share one recovery policy instead of three private guesses. None of these change hot-path behavior — they are contract clarity, purchased once in the package every other layer compiles against, which is the cheapest place in the entire pipeline to buy correctness.

Perf-wise the set is deliberately conservative — these are type files — but PR-10 is a genuine hot-boundary win if verification shows metadata blobs riding every progressive pass (multi-KB structured clones per pass per session, eliminated by documenting and enforcing slim progress-info), and the transfer-list and payload-factoring cleanups shrink the surface where a forgotten transfer silently degrades into a full copy. The net effect: the boundary layer stops being a place where performance and correctness regressions hide, and starts being the place where they get caught.
