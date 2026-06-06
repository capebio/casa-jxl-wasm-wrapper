# TOON Format Instructions

The `text/toon` format is used to maintain a durable ledger of benchmark permutation timings. It is designed to be easily readable by humans while remaining simple to parse by scripts.

**Crucially: One benchmark test run equals one `.toon` file.** A single file should contain all the timings and permutations for that specific test run.

## File Structure Example

A `.toon` file should consist of a global metadata header followed by one or more compact tabular sections. Shared values stay in the header. Only values that vary per measurement belong in the rows.

```toon
TestName: timing-tests
RunTimestamp: 2026-06-06T02-56-09-401Z
Agent: codex
Tier: relaxed-simd-mt
Source: mixed
Target: 1600
Quality: 85
Efforts: 3
Modes: std, std+chunked
TimeBase: 2026-06-06T02:

---
runs[4]{t|mode|effort|file|raw_ms|rgba_ms|encode_ms|total_ms|size}:
  56:^21.777@ | std           | 3 | P22004^07@.ORF | 3329.765 | 260.446 | 8656.313 | 12246.524 | 1715365B
  &27.615@    | std^+chunked@ | ~ | ~               | ~        | ~       | 5837.321 | 9427.532  | 1744648B
  &36.006@    | &@            | ~ | &09@            | 2415.705 | 170.368 | 5778.283 | 8364.356  | 1766845B
  &42.274@    | &+chunked@    | ~ | ~               | ~        | ~       | 6268.481 | 8854.554  | 1795823B

# Aggregates
TotalRecords: 4
TotalEncodeMs: 28440.398
TotalWallMs: 38892.966
```

## Parsing Rules
- A single `.toon` file contains all data for a given test run.
- Tabular timing sections are separated from the run header with `---`.
- Timing rows use pipe `|` delimiters to separate columns.
- Aggregates and Notes sections begin with `# ` to denote section headers.
- Repeated cell shorthand is allowed in tabular rows:
  - `~` means "same as the previous row in this column".
  - Use it only when the meaning is unambiguous.
  - Keep the column order fixed so repeated values can be reconstructed mechanically.
- Template shorthand is allowed for repeated string patterns:
  - `prefix^value@suffix` defines the active template for the current column and expands to `prefix + value + suffix`.
  - `&value@` reuses the active template for the current column and expands to `prefix + value + suffix`.
  - A later `prefix^value@suffix` in the same column replaces that column's active template.
  - Template shorthand is column-scoped. It must not cross columns.
  - Reserved characters in unquoted cells are `|`, `~`, `^`, `@`, and `&`.
  - If a literal cell needs a reserved character, quote the whole cell with double quotes. Quoted cells do not expand shorthand.
- In numeric timing columns, `0` is canonical shorthand for `0.000`.
- Always end each timing row with a filesize field that includes a unit suffix such as `B` or `KB`.
