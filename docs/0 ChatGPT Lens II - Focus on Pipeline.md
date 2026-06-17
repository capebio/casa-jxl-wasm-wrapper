Here's a consolidated handoff that extends your review framework with the findings from the JPEG XL worker, telemetry, WASM boundary, and pipeline investigations.

# JPEG XL Pipeline Optimization Handoff

## Shift Focus From Files To Pipelines

### Executive Summary

The initial optimization passes correctly identified local improvements inside individual files. Those should still be implemented.

However, analysis now suggests that the largest remaining opportunities are unlikely to be inside individual functions or files.

They are likely located in:

```text
JS ↔ WASM boundaries
Worker ↔ Main Thread boundaries
Allocation lifetimes
Ownership transfers
Repeated buffer traversals
Codec initialization
Pipeline architecture
```

The next optimization phase should therefore move from:

```text
Function Optimization
```

to:

```text
Pipeline Optimization
```

The goal is to construct a single high-performance ownership-preserving encode/decode pipeline with minimal boundary crossings, minimal copies, minimal allocations, and maximal reuse.

------

# Additional Lens: Ownership & Pipeline Lens

Apply after all existing lenses.

For every significant buffer:

Determine:

```text
Where created?
Who owns it?
Who consumes it?
Who destroys it?
```

Classify:

```text
Owned
Borrowed
Transferred
Shared
```

For every ownership change record:

```text
Copy?
Transfer?
View?
Alias?
```

Do not proceed with optimization until ownership is understood.

------

# Additional Lens: Boundary Cost Lens

For every boundary:

```text
JS → JS
JS → Worker
Worker → JS
JS → WASM
WASM → JS
JS → GPU
```

Record:

```text
Data size
Frequency
Allocation count
Copy count
Transfer count
```

Assign:

```text
Low
Medium
High
Very High
```

cost classification.

The objective is not faster code.

The objective is fewer expensive crossings.

------

# Additional Lens: Buffer Lifecycle Lens

Construct a lifecycle record for every major buffer.

Example:

```text
Buffer: Decoded RGBA

Created:
    WASM Decoder

Owner:
    Decoder

Size:
    256 MB

Crossings:
    WASM → JS
    Worker → Main

Copies:
    2

Traversals:
    Telemetry
    Histogram
    Render

Destroyed:
    GC
```

Repeat for:

```text
Encoded JXL
Decoded RGBA
Input JPEG XL
Thumbnails
Intermediate telemetry buffers
```

------

# Additional Lens: Traversal Lens

Track how many times each large buffer is scanned.

Example:

```text
Decode
↓
RGBA

Pass 1:
Telemetry

Pass 2:
Histogram

Pass 3:
Thumbnail

Pass 4:
Render

Pass 5:
Export
```

Repeated full-buffer traversals are often larger bottlenecks than arithmetic.

Prefer:

```text
One pass
Many outputs
```

over:

```text
Many passes
One output each
```

------

# Additional Lens: Runtime Reuse Lens

Investigate:

```text
Worker lifetime
WASM runtime lifetime
Decoder lifetime
Encoder lifetime
Allocator lifetime
```

Question:

```text
Can this persist?
Can this be pooled?
Can this be reused?
```

Reuse is usually superior to repeated construction.

------

# Investigation Deliverables

Produce the following maps.

------

## 1. Pipeline Map

Document complete flow.

### Decode

```text
Source
↓
Fetch
↓
ArrayBuffer
↓
Worker
↓
Decoder Wrapper
↓
WASM
↓
RGBA
↓
Telemetry
↓
Render
```

### Encode

```text
RGBA
↓
Worker
↓
Encoder Wrapper
↓
WASM
↓
JXL
↓
Transfer
↓
Storage
```

For each node record:

```text
Responsibility
Input
Output
```

------

## 2. Buffer Lifecycle Map

For every major buffer:

| Buffer | Created | Owner | Size | Copies | Destroyed |
| ------ | ------- | ----- | ---- | ------ | --------- |
|        |         |       |      |        |           |

Include all:

```text
JS ↔ WASM
Worker ↔ Main
Module ↔ Module
```

transitions.

------

## 3. Allocation Map

Search entire encode/decode path for:

```text
_malloc
_free
malloc
free
HEAPU8
HEAPU16
HEAPU32
HEAPF32
HEAPF64
memory.grow
```

Record:

| Location | Allocation | Size | Frequency |
| -------- | ---------- | ---- | --------- |
|          |            |      |           |

The goal is to discover:

```text
malloc
↓
memcpy
↓
decode
↓
memcpy
↓
free
```

chains.

------

## 4. Traversal Map

For every large buffer:

| Buffer | Traversals |
| ------ | ---------- |
|        |            |

Document:

```text
Telemetry scans
Histogram scans
Thumbnail scans
Verification scans
Render scans
```

------

## 5. Boundary Map

For every boundary crossing record:

| Source | Destination | Bytes | Copies | Frequency |
| ------ | ----------- | ----- | ------ | --------- |
|        |             |       |        |           |

Especially:

```text
JS ↔ WASM
Worker ↔ Main
```

------

# Required Searches

## WASM Memory

Search:

```text
_malloc
_free
malloc
free
HEAPU8
HEAPU16
HEAPU32
HEAPF32
HEAPF64
memory.grow
```

Investigate every occurrence.

------

## Hidden Copies

Search:

```text
new Uint8Array(
new Uint16Array(
new Float32Array(
slice(
Array.from(
Uint8Array.from(
structuredClone(
```

Determine whether:

```text
View
Copy
Transfer
```

is occurring.

------

## Thread Transfers

Search:

```text
postMessage(
```

Verify transfer lists are used:

```js
postMessage(message, [buffer]);
```

where appropriate.

------

# Timing Instrumentation Requirements

Insert timing probes around:

## Decode

```text
Fetch
ArrayBuffer creation
Decoder creation
push()
decode()
event delivery
pixel extraction
postMessage transfer
```

## Encode

```text
Encoder creation
pushPixels()
encode
chunk generation
chunk aggregation
postMessage transfer
```

Collect:

```text
Average
P95
Large image
Small image
```

results.

------

# Confirmed Optimization Opportunities

The following opportunities have already been identified and should be investigated immediately.

------

## 1. Audit JS ↔ WASM Copies

Highest priority.

Determine whether:

```text
pushPixels()
push()
event.pixels
```

borrow memory or perform full copies.

Potential impact:

```text
Very High
```

------

## 2. Audit Worker Transfer Ownership

Verify transfer lists are used everywhere.

Potential impact:

```text
High
```

------

## 3. Streaming Decode

Current pattern:

```text
fetch
↓
arrayBuffer
↓
decoder.push(buffer)
```

Investigate:

```text
fetch stream
↓
decoder.push(chunk)
```

Potential impact:

```text
Lower memory
Earlier decode start
Better progressive responsiveness
```

------

## 4. Decoder / Encoder Pooling

Investigate reuse of:

```text
Decoder instances
Encoder instances
Runtime state
Allocator state
```

Potential impact:

```text
Medium to High
```

------

## 5. WASM SIMD Build

Verify:

```text
-msimd128
```

availability.

Potential impact:

```text
High
```

------

## 6. WASM Threading

Verify:

```text
pthreads
SharedArrayBuffer
```

availability.

Potential impact:

```text
Very High
```

for large images.

------

## 7. Remove Repeated Traversals

Look for:

```text
Telemetry
Histogram
Thumbnail
Verification
```

operating independently on the same RGBA buffer.

Potential impact:

```text
Medium to High
```

------

## 8. Runtime Lifetime Optimization

Replace:

```text
Create
Use
Dispose
```

per request with:

```text
Persistent runtime
Pooled resources
```

where possible.

Potential impact:

```text
Medium
```

------

# Optimization Index

At completion produce:

| Rank | Opportunity | Impact | Effort |
| ---- | ----------- | ------ | ------ |
|      |             |        |        |

Rank by measured evidence, not intuition.

------

# Success Criteria

The review is complete only when the following can be answered for every large buffer:

```text
Where was it created?
Who owns it?
How many times is it copied?
How many times is it traversed?
How many boundaries does it cross?
When is it destroyed?
What is its total cost?
```

Once those answers exist, the hottest edges of the graph will reveal where the next major performance gains are hiding.

The likely remaining wins are not inside functions.

They are inside the seams between components.

This should become the governing document for the next phase. The previous file-level lenses remain valid, but the agent's default assumption should now be that **every JS↔WASM copy, worker transfer, allocation, traversal, and runtime initialization is guilty until proven innocent by measurement**.