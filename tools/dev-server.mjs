#!/usr/bin/env node
// Minimal static dev server for web/ with COOP/COEP headers.
// Required for SharedArrayBuffer (WASM threads) in browser.
// Usage: node tools/dev-server.mjs [port=8080] [root=web]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2]) || 8080;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  process.argv[3] ?? 'web',
);

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.orf':  'application/octet-stream',
  '.dng':  'application/octet-stream',
};

const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  let filePath = path.join(root, url.pathname);

  // Directory → index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Path traversal guard
  if (!filePath.startsWith(root)) {
    res.writeHead(403, SECURITY_HEADERS); res.end('Forbidden'); return;
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] ?? 'application/octet-stream';

  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentType });

  fs.createReadStream(filePath).pipe(res);
}).listen(port, () => {
  console.log(`Dev server: http://localhost:${port}  (root: ${root})`);
  console.log('COOP/COEP active → SharedArrayBuffer available → simd-mt WASM tier');
});
