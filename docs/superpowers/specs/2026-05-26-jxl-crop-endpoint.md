# Spec: /api/jxl-crop Server Endpoint

**Date:** 2026-05-26  
**Status:** Approved

## Goal

Server-side JXL crop service (Tier A ROI). Decodes a local JXL file, crops to a pixel-coordinate region, re-encodes as a small JXL, and returns it. The browser then decodes the small crop JXL via the existing session pipeline. Avoids browser-side full-frame decode for annotation crop views (plant organs, species detail regions).

## Constraints

- Local file path input only (Option A). Remote URL support to be added when deployed to production server.
- Pixel coordinates only — callers must convert from normalized via `normalizedToPixelExtent` before calling.
- WASM codec only (no `@casabio/jxl-native` installed in this repo).
- Single file change: `serve.ts`. No changes to facade, bridge, or protocol.

## Interface

```
GET /api/jxl-crop?file=<abs-path>&x=<int>&y=<int>&w=<int>&h=<int>
                 [&distance=<float>]  default 1.0
                 [&effort=<int 1-9>]  default 4
```

**Success:** `200 image/jxl` with COOP/COEP headers, body = crop JXL bytes.  
**Errors:** `400` bad params, `404` file not found, `500` WASM failure (`X-Jxl-Error` header).

## Architecture

Single async handler in `serve.ts` using the public facade API:

```
readFile(file)
  → createDecoder({ format:"rgba8", region:{x,y,w,h}, progressionTarget:"final",
                    emitEveryPass:false, preserveIcc:false, preserveMetadata:false })
  → push all bytes → close → await "final" event → pixels + dims
  → createEncoder({ format:"rgba8", width, height, hasAlpha:true,
                    distance, effort, progressive:false, previewFirst:false,
                    chunked:false, iccProfile:null, exif:null, xmp:null, quality:null })
  → pushPixels → finish → collect chunks → concat → return
```

## Caching

Server-side `Map<string, Uint8Array>` keyed on `"${file}:${x}:${y}:${w}:${h}:${distance}:${effort}"`.  
Cap: 50 entries. Eviction: delete the oldest key on overflow (insertion-order Map iteration).  
No TTL — cache lives for server session. Prevents re-encoding same annotation crop on each browser refresh.

## Success Criteria

- `GET /api/jxl-crop?file=<valid.jxl>&x=100&y=100&w=500&h=400` returns `200 image/jxl`.
- Returned bytes decode successfully in the browser via existing `DecodeSession`.
- Second identical request returns from cache (no WASM work).
- Out-of-bounds crop (x+w > imageWidth) returns 400 or libjxl clamps gracefully.
- Missing file returns 404.
