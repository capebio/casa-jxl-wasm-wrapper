# jxl-policy — DECISIONS.md

## D-001 Policy is overlay, caller wins

`applyDecodePolicy`/`applyEncodePolicy` use `caller.field ?? policy.field`. Caller-supplied options always take precedence; the policy only fills `undefined` gaps. More restrictive than the alternative (policy overrides caller) and matches the principle of least surprise.

## D-002 thumbnail downsample 8, gallery/prefetch downsample 4

Section 9.2 says "Thumbnail policy defaults to downsample 4 or 8 depending on container size." Without container size at policy-selection time, chose 8 for `thumbnail` (smallest surface, most aggressive) and 4 for `gallery`/`prefetch` (near-viewport, may be promoted). Callers with a known container size should pass `downsample` explicitly.

## D-003 lib DOM in tsconfig

jxl-core's emitted `.d.ts` references `AbortSignal` (a DOM/Node global). Consuming it requires `DOM` in lib. jxl-policy adds it though it has no DOM runtime use.

## D-004 No "background prefetch" as encode policy

Section 11.3 only defines encode efforts for thumbnail/viewer/archival. Decode has a `prefetch` policy; encode does not — there is no "prefetch encode" workload in the spec.
