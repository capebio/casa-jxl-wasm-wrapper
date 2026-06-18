# Task 016-errors-14

**Finding:** No shared timeout-race utility leads to ad-hoc timeout patterns: encode has 30s finish timeout, decode has none on close — packages/jxl-worker-browser/src/decode-handler.ts:378-381

**Status:** deferred

**Tests before:** pass (29/29)

**Tests after:** N/A

## Deferral Reason

This is a feature request / refactoring opportunity (marked as "opportunity" not "issue"), not a bug. The suggestion is to add a shared timeout-race utility for consistency. However, `decoder.close()` in decode-handler is intentionally left without a timeout—the decoder implementation controls the close duration, and decode sessions don't have the same hard finish deadline that encode sessions do (encode has a fixed 30s cutoff per the encoder contract). Adding a timeout to decode close would risk terminating a legitimate close operation and breaking user decodes. This is design-correct, not an oversight.
