# Lightbox 3-Way Source Toggle

**Date:** 2026-05-13  
**Status:** Approved

## Goal

Let the user compare decoded ORF, exported JXL, and embedded camera JPEG in the lightbox with obvious visual feedback on which source is active.

## Sources

| Mode | Data | Resolution | Availability |
|------|------|-----------|--------------|
| `raw` | `card._lightbox.rgb` (RGB8) | 1800px long edge | Always (after pipeline) |
| `jxl` | Decode blob URL via jxl-worker | Full-res (e.g. 5184×3888) | After JXL encode completes |
| `jpeg` | `card._embeddedPreview.bmp` (ImageBitmap) | ~1920px | After JPEG extraction |

Skip unavailable states silently when cycling.

## Input Mapping (lightbox open only)

- **Spacebar**: cycle forward `raw → jxl → jpeg → raw`
- **↑**: step forward through sources
- **↓**: step backward through sources
- **← / →**: navigate between photos (unchanged)

## State

Replace `card._showJpeg: boolean` with `card._sourceMode: 'raw' | 'jxl' | 'jpeg'`.

Reset to `'raw'` on lightbox open and on photo navigation.

## JXL Decode

Add `decode_jxl` message type to existing `jxl-worker.js`:
- Main thread sends `{ type: 'decode_jxl', id, url }` (blob URL from download link)
- Worker fetches blob → jSquash decode → posts back `{ type: 'jxl_decoded', id, rgba, w, h }`
- Main thread draws `new ImageData(rgba, w, h)` to lightbox canvas, resets zoom
- Show loading badge during decode; discard decoded buffer after draw (no per-card storage)

## Source Label Overlay

Single `<div id="lb-source-label">` absolutely positioned, centered over `.lightbox-viewport`.

- Large bold text: `"RAW"` / `"JXL"` / `"JPEG"`
- CSS keyframe animation: 0.1s fade-in → hold 0.5s → 0.9s fade-out = 1.5s total
- Re-trigger by toggling a `data-key` attribute (odd/even) to force animation restart
- Shown on every source switch including initial lightbox open

## Zoom

Reset zoom on every source switch (canvas dimensions change between modes).

## Toggle Button

Update `lbToggleJpegBtn` text to show current mode: `"RAW"` / `"JXL"` / `"JPEG"`. Button click cycles forward (same as spacebar).

## Out of Scope

- Persisting source mode per-card across sessions
- Storing decoded JXL pixels on the card
- Keyboard shortcuts outside lightbox
