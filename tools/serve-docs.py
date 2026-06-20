"""Serve docs/ with COOP + COEP headers so SharedArrayBuffer works."""
import http.server, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DOCS = os.path.join(os.path.dirname(__file__), '..', 'docs')

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.abspath(DOCS), **kw)
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy',   'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control',                'no-cache')
        super().end_headers()
    def log_message(self, fmt, *args):
        pass  # silence request log

print(f'Serving docs/ at  http://localhost:{PORT}/')
print(f'Ecosystem map  →  http://localhost:{PORT}/ecosystem-map.html')
print('Ctrl-C to stop.')
http.server.HTTPServer(('', PORT), Handler).serve_forever()
