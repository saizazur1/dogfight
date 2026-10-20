"""Static server for the game: like `python3 -m http.server`, but tells the browser to re-check every file.

Without this, Chrome reuses old cached copies of some modules after an update (no Cache-Control header), so a new
main.js can run against an old controls.js and every step throws. Usage: python3 tools/serve.py [port=8320]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # revalidate every time (cheap: 304 when unchanged)
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8320
    root = Path(__file__).resolve().parent.parent
    print(f"Serving {root} at http://127.0.0.1:{port}/", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), partial(NoCacheHandler, directory=str(root))).serve_forever()
