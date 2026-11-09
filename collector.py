#!/usr/bin/env python3
"""Local collector for the MD Capture extension.

Listens on 127.0.0.1:8765. POST /save accepts one JSON bundle
{url, host, path, title, markdown, article_markdown, meta, html} and
writes it under ~/md-captures/<host>/<timestamp>-<slug>/ as
page.md, article.md, meta.json and page.html.
GET /ping answers ok. GET /latest answers the newest bundle dir.
"""

import json
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path.home() / "md-captures"
ROOT.mkdir(parents=True, exist_ok=True)


def slugify(text: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", (text or "").strip()).strip("-.")
    return (slug or fallback)[:60]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep stdout quiet
        pass

    def _send(self, code, body, content_type="text/plain; charset=utf-8"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, "")

    def do_GET(self):
        if self.path == "/ping":
            self._send(200, "ok")
        elif self.path == "/latest":
            bundles = sorted(p for p in ROOT.rglob("*") if p.is_dir())
            self._send(200, str(bundles[-1]) if bundles else "")
        else:
            self._send(404, "not found")

    def do_POST(self):
        if self.path != "/save":
            self._send(404, "not found")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as error:
            self._send(400, f"bad request: {error}")
            return
        host = slugify(payload.get("host") or "unknown", "unknown")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        slug = slugify(payload.get("title") or payload.get("path") or "page", "page")
        bundle = ROOT / host / f"{stamp}-{slug}"
        bundle.mkdir(parents=True, exist_ok=True)
        (bundle / "page.md").write_text(payload.get("markdown") or "", encoding="utf-8")
        if payload.get("article_markdown"):
            (bundle / "article.md").write_text(payload["article_markdown"], encoding="utf-8")
        (bundle / "meta.json").write_text(
            json.dumps(payload.get("meta") or {}, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        (bundle / "page.html").write_text(payload.get("html") or "", encoding="utf-8")
        self._send(200, json.dumps({"saved": str(bundle)}), "application/json")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
