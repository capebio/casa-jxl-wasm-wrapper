# Task 005-contracts-8
**Finding:** No test verifies that all fields of the Capabilities interface are present and typed correctly in the returned object — packages/jxl-capabilities/test/tier-matrix.test.ts:1-180
**Status:** deferred_adr
**Tests before:** pass (9/9)
**Tests after:** pass (10/10)

## Change
No code edits. ADR draft written to `undefined/sections/005/adr_draft/contracts-8-capabilities-field-contract-test.md` with a proposed structural smoke test covering all 18 Capabilities fields, two implementation options, and deferred questions about `deviceMemory: null` assertion semantics in Node test environments.
