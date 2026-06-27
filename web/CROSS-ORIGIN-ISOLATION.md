# Cross-Origin Isolation — REQUIRED for the MT speedup

The viewer auto-selects the `relaxed-simd-mt` WASM tier (multithreaded libjxl
encode/decode, ~2.4× round-trip on large RAW files) **only when the page is
cross-origin-isolated**.

Tier selection: `packages/jxl-wasm/src/facade.ts` `detectTier()` —
`SharedArrayBuffer` + `crossOriginIsolated === true` → MT. Otherwise it falls
back **silently** to single-thread `simd` (correct output, ~2.4× slower). No
error is thrown, so a misconfigured deploy regresses without any visible signal.

Cross-origin isolation requires these response headers on the HTML document
(and they must not be stripped from the WASM/JS assets):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: cross-origin
```

These match `tools/dev-server.mjs` (`SECURITY_HEADERS`) and `serve.ts`.

## Host configs in this directory

| Host | File | Notes |
|------|------|-------|
| Netlify / Cloudflare Pages | `_headers` | Applies to `/*`. |
| Vercel | `vercel.json` | `headers` rule on `/(.*)`. |

### nginx
```nginx
add_header Cross-Origin-Opener-Policy   same-origin   always;
add_header Cross-Origin-Embedder-Policy require-corp  always;
add_header Cross-Origin-Resource-Policy cross-origin  always;
```

### Apache (.htaccess)
```apache
Header always set Cross-Origin-Opener-Policy   "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"
Header always set Cross-Origin-Resource-Policy "cross-origin"
```

## Caveat — COEP `require-corp`

With COEP on, **every cross-origin subresource** (fonts, CDN scripts, images,
analytics) must send `Cross-Origin-Resource-Policy: cross-origin` (or CORS), or
the browser blocks it. Keep assets same-origin, or ensure third parties send
CORP/CORS. If a deploy breaks after adding these headers, a blocked cross-origin
subresource is the usual cause.

## Verify after deploy

Open DevTools console on the deployed page:

```js
crossOriginIsolated   // must be true
typeof SharedArrayBuffer !== "undefined"   // must be true
```

Both `true` → MT tier active. Either `false` → stuck on single-thread `simd`.
