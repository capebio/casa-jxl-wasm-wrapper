# Handoff: jxl-policy — index.ts / DECISIONS.md / STATE.md (22-lens review)

Scope: `packages/jxl-policy/src/index.ts`, `packages/jxl-policy/DECISIONS.md`, `packages/jxl-policy/STATE.md`.
Date: 2026-06-11. Five agent sessions. Each agent edits only its assigned file; any edit outside it must be deferred to the end and approved first. New files (tests) are deliverables, not out-of-scope edits.

## Consolidated findings (deduped across all lenses)

| # | Severity | Finding |
|---|----------|---------|
| F1 | P0-strategic | **Package is consumed by nothing.** Repo-wide grep for `jxl-policy` matches only the package itself, `package-lock.json`, `docs/Optimal-settings.md`, and a mention in `jxl-core/DECISIONS.md`. No `jxl-session`, `jxl-pyramid`, scheduler, or `web/` import. STATE.md says `COMPLETE`; it is complete-but-unwired. |
| F2 | P1-bug | `applyDecodePolicy("typo" as any, base)` (or any JS/JSON-config caller) → `decodePolicies[name]` is `undefined` → `TypeError` reading `.progressionTarget`, far from the call site. No runtime validation, no type guards for config-driven policy names. |
| F3 | P1-hardening | `decodePolicies` / `encodePolicies` are exported **mutable** objects. Any consumer can poison global policy for the whole app. Freeze them; use `as const satisfies` to keep literal types while validating shape. |
| F4 | P1-type-drift | `DecodePolicy`/`EncodePolicy` re-declare unions that already exist in jxl-core (`priority`, `progressionTarget`, `downsample`, `effort`). If jxl-core adds a priority tier, this file silently diverges. Derive via indexed-access types. |
| F5 | P2-feature | D-002 punts container-size→downsample mapping to every caller. Provide one pure helper `downsampleForContainer()` (clz32 log2 clamp) so the mapping lives in the policy package it belongs to. |
| F6 | P2-feature | `viewer` encode policy sets `progressive: true, previewFirst: true` but not `groupOrder: 1`, which `jxl-core/src/types.ts:173` documents as "Strongly recommended for useful early progressive bytes." Center-out group order is exactly the viewer/lightbox use case. |
| F7 | P2-verify | `viewer` encode `effort: 4` vs user's prior measurement that effort=3 won on speed+filesize. `docs/Optimal-settings.md` references jxl-policy — reconcile against it before changing. |
| F8 | P2-feature | No decode preset for ML inference (species-ID pipeline of the biodiversity platform). Models want small full-detail pixels at background priority; a `mlInference` preset makes the recognition path one line for callers. |
| F9 | P3-hygiene | `applyDecodePolicy`: when `base` carries an explicit `downsample: undefined` key, the spread copies the key, the `!== undefined` guard skips reassignment, and the output has a present-but-undefined `downsample` key — a hazard for any downstream `'downsample' in opts` check. Normalize. |
| F10 | P3-gap | Zero tests. Pure functions, trivial to test: caller-wins, gap-fill, `false` preserved (`??` not `\|\|`), idempotence (apply twice = apply once), all names resolvable, frozen tables throw on mutation. |
| F11 | P3-docs | DECISIONS.md missing decisions for anything done above; STATE.md has no dates and a misleading COMPLETE status given F1. |
| F12 | Rejected/deferred (record, do NOT implement) | (a) Per-policy `budgetMs` defaults — tunables without benchmark data, forbidden by CLAUDE.md; structure exists in DecodeOptions, populate only with evidence. (b) "realtime/AR" preset — same reason. (c) `progressiveDetail` per policy — facade already derives it from `emitEveryPass`/`progressionTarget`; duplicating the mapping here risks drift; only add if Spec 10.3 explicitly assigns detail per policy. (d) `promotePolicy(gallery→viewer)` helper — promotion is scheduler preemption territory; wrong layer. |

---

## Agent 1 — `packages/jxl-policy/src/index.ts`: hardening + type derivation (F2, F3, F4, F9)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Context: 81-line pure module, two overlay functions (`caller ?? policy`). Imports `DecodeOptions`, `EncodeOptions` from `@casabio/jxl-core` (see `packages/jxl-core/src/types.ts:49` and `:142`). Build is plain `tsc` to `dist/`.

1. **Derive unions from jxl-core** instead of re-declaring:

```ts
type Priority = NonNullable<DecodeOptions["priority"]>;
type Downsample = NonNullable<DecodeOptions["downsample"]>;

export interface DecodePolicy {
  progressionTarget: NonNullable<DecodeOptions["progressionTarget"]>;
  emitEveryPass: boolean;
  priority: Priority;
  downsample?: Downsample;
}

export interface EncodePolicy {
  effort: NonNullable<EncodeOptions["effort"]>;
  progressive: boolean;
  previewFirst: boolean;
  priority: Priority;
}
```

2. **Freeze + satisfies** (keeps literal types, validates shape, blocks runtime mutation; frozen objects also keep V8 shapes monomorphic):

```ts
export const decodePolicies = Object.freeze({
  thumbnail: { progressionTarget: "dc", emitEveryPass: false, priority: "near", downsample: 8 },
  // ... unchanged entries ...
} as const satisfies Record<DecodePolicyName, DecodePolicy>);
```

Same for `encodePolicies`. Note: `Object.freeze` is shallow but sufficient — entries are one level deep. Derive `DecodePolicyName` from the table (`export type DecodePolicyName = keyof typeof decodePolicies;`) or keep the explicit union; either way `satisfies` pins them together.

3. **Runtime guards** for config/URL/manifest-driven callers:

```ts
export function isDecodePolicyName(s: string): s is DecodePolicyName {
  return Object.prototype.hasOwnProperty.call(decodePolicies, s);
}
export function isEncodePolicyName(s: string): s is EncodePolicyName {
  return Object.prototype.hasOwnProperty.call(encodePolicies, s);
}
```

And in both `apply*` functions, fail fast with a useful message:

```ts
const p = decodePolicies[name];
if (!p) throw new RangeError(`Unknown decode policy "${name}" (valid: ${Object.keys(decodePolicies).join(", ")})`);
```

4. **F9 normalize `downsample` key**: after computing `out`, ensure no present-but-undefined key:

```ts
const downsample = base.downsample ?? p.downsample;
if (downsample !== undefined) out.downsample = downsample;
else delete out.downsample; // spread may have copied an explicit-undefined key from base
```

Verify: `npx tsc -p packages/jxl-policy` clean; `dist/` re-emitted. No behavior change for valid inputs (apply functions remain idempotent and caller-wins).

---

## Agent 2 — `packages/jxl-policy/src/index.ts`: features (F5, F6, F7, F8)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run after Agent 1 (builds on its diff). May read `docs/Optimal-settings.md`, the spec, and `packages/jxl-core/src/types.ts` for grounding; edits only index.ts.

1. **F5 — container-size downsample helper.** Closes the gap D-002 documents ("Callers with a known container size should pass `downsample` explicitly" — give them the function). Largest power-of-two d ∈ {1,2,4,8} such that the downsampled image still covers the container:

```ts
/**
 * Largest power-of-two downsample (1|2|4|8) whose result still covers
 * containerW×containerH (CSS px × devicePixelRatio if you want crisp output).
 * Section 9.2: thumbnail downsample "4 or 8 depending on container size".
 */
export function downsampleForContainer(
  imageW: number, imageH: number,
  containerW: number, containerH: number,
): Downsample {
  if (imageW <= 0 || imageH <= 0 || containerW <= 0 || containerH <= 0) return 1;
  const ratio = Math.min(imageW / containerW, imageH / containerH);
  if (ratio < 2) return 1;
  // floor(log2(ratio)) via clz32 — ratio >= 2 here so (ratio|0) >= 2
  const log2 = 31 - Math.clz32(ratio | 0);
  return (1 << Math.min(log2, 3)) as Downsample;
}
```

2. **F6 — `groupOrder: 1` in `viewer` encode policy.** `types.ts:173` calls center-out group order "Strongly recommended for useful early progressive bytes" and the viewer policy is precisely the progressive-paint path. Add `groupOrder: 1` to the `viewer` entry and widen `EncodePolicy` with `groupOrder?: NonNullable<EncodeOptions["groupOrder"]>;` plus the `?? p.groupOrder` line in `applyEncodePolicy` (guard the undefined key like Agent 1 did for `downsample`). Do NOT add `progressiveDc`/`progressiveAc` — no benchmark evidence (CLAUDE.md: no tunables without evidence).

3. **F7 — viewer effort 4 vs measured effort 3.** Prior measurements (recorded in project memory and possibly `docs/Optimal-settings.md`) showed effort=3 best on speed+filesize for this corpus. Read `docs/Optimal-settings.md`; if it confirms effort 3 for interactive encodes, change `viewer.effort` to 3 and have Agent 4 record it as a decision (Section 11.3 said 4; measurement overrides default). If the doc contradicts or is silent, leave at 4 and note it.

4. **F8 — `mlInference` decode preset** for the species-ID/recognition path (biodiversity platform; also the AR-identification on-ramp). Models want final-quality pixels at small size, off the interactive path; EXIF/XMP irrelevant to inference but `preserveIcc` stays default (color fidelity affects model accuracy):

```ts
// ML inference: final-quality pixels, small, off the interactive path.
// Caller supplies targetWidth/targetHeight for the model's input size;
// downsample 4 gets WASM most of the way before the JS bilinear resize.
mlInference: { progressionTarget: "final", emitEveryPass: false, priority: "background", downsample: 4 },
```

Add `"mlInference"` to `DecodePolicyName`. No new fields needed — `targetWidth/targetHeight/format` are caller-supplied per model.

Verify: tsc clean. Sanity-check `downsampleForContainer`: (4000,3000,200,150)→8; (4000,3000,1000,750)→4; (800,600,640,480)→1; (4000,3000,2001,1501)→1 (ratio 1.99); (4000,3000,2000,1500)→2.

---

## Agent 3 — new file `packages/jxl-policy/test/policy.test.ts` (F10)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run after Agents 1–2. Check sibling packages (`packages/jxl-scheduler/test/`, `packages/jxl-cache/test/`) for the repo's test runner/convention (node:test vs vitest, dist-test build pattern) and match it exactly; wire a `test` script into `packages/jxl-policy/package.json` the same way siblings do (package.json edit = part of the deliverable, flag it in the summary).

Required cases:

1. **Caller wins**: `applyDecodePolicy("thumbnail", { format: "rgba8", downsample: 2 })` → `downsample === 2`, not 8.
2. **Gap fill**: empty base → all four policy fields land; `viewer` output has NO `downsample` key (`'downsample' in out === false`).
3. **Falsy preservation**: `base.emitEveryPass = false` against `viewer` (policy true) stays `false` — proves `??` not `||`.
4. **Explicit-undefined key**: `applyDecodePolicy("viewer", { format: "rgba8", downsample: undefined })` → no `downsample` key in output (F9 regression).
5. **Idempotence**: `apply(name, apply(name, base))` deep-equals `apply(name, base)` for every policy name, decode and encode.
6. **Unknown name throws** `RangeError` mentioning valid names; `isDecodePolicyName("viewer") === true`, `("bogus") === false`.
7. **Frozen tables**: mutation attempt throws in strict mode (or at minimum leaves table unchanged).
8. **Passthrough**: unrelated base fields (`signal`, `budgetMs`, `onMetric`) survive both apply functions untouched.
9. **Helper math**: the five `downsampleForContainer` cases from Agent 2's verify line, plus zero/negative dimension → 1.

Verify: run the package test script; all green.

---

## Agent 4 — `packages/jxl-policy/DECISIONS.md` (F11, F12)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run last (records what Agents 1–3 actually did — read their diffs/summaries first; drop entries for anything they rejected). Append, matching existing D-00N style, one short paragraph each:

- **D-005 Frozen policy tables + derived types**: tables are `Object.freeze`d and `satisfies`-checked; field unions derived from jxl-core via indexed-access types so drift is a compile error, not a runtime surprise.
- **D-006 Runtime validation**: `apply*` throws `RangeError` on unknown names; `is*PolicyName` guards exported for config-driven callers. Rationale: policy names will arrive from manifests/URLs, not just typed literals.
- **D-007 viewer groupOrder=1**: center-out group order per jxl-core's own "strongly recommended" guidance for progressive viewing. `progressiveDc`/`progressiveAc` deliberately NOT set — no benchmark evidence.
- **D-008 viewer effort** (only if Agent 2 changed it): effort 4→3 per measured speed+filesize results (`docs/Optimal-settings.md`); Section 11.3's 4 was a spec default, measurement overrides.
- **D-009 mlInference preset**: final/background/downsample-4; model input size is caller-supplied via targetWidth/Height; preserveIcc untouched because color fidelity affects model accuracy.
- **D-010 Deferred (record so they're not re-proposed)**: per-policy `budgetMs` defaults and a realtime/AR preset — tunables requiring benchmark data (CLAUDE.md rule); `progressiveDetail` per policy — facade already derives it, duplicating the mapping invites drift; `promotePolicy` helper — promotion is scheduler preemption, wrong layer.

---

## Agent 5 — `packages/jxl-policy/STATE.md` (F1, F11)

If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md

Run last. The real work is an **integration audit** (read-only outside this file): grep the repo for `jxl-policy` imports and confirm the package is still unconsumed; identify where wiring belongs by reading entry points — candidates: `packages/jxl-session/src/decode-session.ts` (apply decode policy where options are assembled), pyramid ingest (encode policies for ladder levels: thumbnail/viewer/archival map naturally to pyramid tiers), `web/main.js` lightbox (viewer policy + `downsampleForContainer` for filmstrip thumbnails).

Then rewrite STATE.md truthfully:

- Status: `COMPLETE (unwired)` — code, tests, docs done; **zero consumers** as of 2026-06-11.
- Tasks complete: existing list + hardening/features/tests from this handoff (reflect what actually landed).
- Blockers: none for the package itself; integration blocked on T-INT wiring.
- Context: keep the T-INT paragraph; add a "Pending integration" section listing the concrete wiring points found in the audit, each as `file → what to call`. Do NOT perform the wiring — that touches scheduler/session layers and per CLAUDE.md needs its own layer-confirmation pass; list it for a future task and request approval if tempted.
- Add absolute dates to status lines.

---

## Overview — what implementing this achieves

jxl-policy is currently a well-shaped but inert organ: nothing in the pipeline calls it, its tables can be silently mutated by any importer, and a misspelled policy name from a manifest would surface as a cryptic TypeError three frames deep. Agents 1 and 3 turn it into something the rest of the system can actually lean on — frozen, type-derived, runtime-validated, and regression-tested — so that when T-INT wiring happens, the policy layer is a trustworthy single source of truth rather than another drift surface. The type-derivation work means future jxl-core option changes (new priority tiers, new downsample factors) become compile errors here instead of silent divergence.

Agent 2 closes the gap between what the policy layer promises and what the encoder can deliver: center-out group order makes the viewer's progressive paints visibly useful earlier (the user's lightbox sees the subject before the corners), the container-size helper moves D-002's "every caller computes their own downsample" debt into one tested function, and the effort reconciliation aligns the preset with measured corpus data instead of a spec default. The `mlInference` preset is the first concrete hook for the biodiversity platform's recognition path — species-ID and future AR identification get a one-line, off-the-interactive-path decode profile instead of each caller rediscovering the right knob combination.

Agents 4 and 5 keep the package's paper trail honest: decisions recorded so rejected tunables (budget defaults, realtime presets, per-policy progressiveDetail) are not re-proposed next quarter, and STATE.md stops claiming COMPLETE for a package with zero consumers — replacing that with a concrete, audited wiring map that makes the eventual integration task mechanical rather than archaeological.
