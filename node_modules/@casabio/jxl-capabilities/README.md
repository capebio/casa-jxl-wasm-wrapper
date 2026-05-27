# @casabio/jxl-capabilities

Runtime capability probe for the Casabio JXL wrapper.

## Capabilities

| Capability | Description | User-Visible Implication |
|---|---|---|
| `wasm` | WebAssembly support | Essential for browser-side JXL processing. |
| `wasmSimd` | WASM SIMD support | ~1.5-1.8x faster decode throughput. |
| `wasmRelaxedSimd` | WASM Relaxed SIMD | Additional 20% speedup on modern engines. |
| `wasmThreads` | WASM PThreads (SharedArrayBuffer) | Enables multi-core decoding. |
| `crossOriginIsolated` | COOP/COEP headers present | Required for `wasmThreads`. |
| `sharedArrayBuffer` | Shared memory support | Required for `wasmThreads`. |
| `offscreenCanvas` | OffscreenCanvas support | Enables hardware-accelerated rendering from workers. |
| `imageBitmap` | ImageBitmap support | Optimized zero-copy transfer to main thread. |
| `nativeJxlDecoder` | Browser/Node native support | Fast path using platform-native codecs. |
| `selectedWasmBuild` | Chosen WASM artifact | Selection from: `relaxed-simd-mt`, `simd-mt`, `simd`, `scalar`. |
| `libjxlVersion` | libjxl version | Informational; tracks codec evolution. |

## Usage

```ts
import { getCapabilities } from '@casabio/jxl-capabilities';

const caps = await getCapabilities();
console.log('Selected build:', caps.selectedWasmBuild);
```
