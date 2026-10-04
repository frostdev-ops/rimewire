#!/usr/bin/env python3
"""Serve the work-package board: `python scripts/wp-board/serve.py [--port 8737] [--open]`.

Binds to 127.0.0.1 only. Reads docs/wp/ and runs read-only git commands. The only write is
`POST /api/notes`, which appends an agent update to target/wp-notes/notes.jsonl (see journal.py):

  curl -s localhost:8737/api/notes -H 'Content-Type: application/json' \\
       -d '{"wp": "WP-C1", "kind": "progress", "percent": 60, "text": "fetch next", "author": "lead"}'
  curl -s 'localhost:8737/api/notes?wp=WP-C1&limit=20'
"""

import sys

sys.dont_write_bytecode = True

import argparse  # noqa: E402
import errno  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
import webbrowser  # noqa: E402
from http import HTTPStatus  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402
from pathlib import Path  # noqa: E402
from urllib.parse import parse_qs, urlparse  # noqa: E402

import board  # noqa: E402
import journal  # noqa: E402

MAX_POST = 16 * 1024

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
STATIC = HERE / "static"
DATA_REPO = REPO

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/board.css": ("board.css", "text/css; charset=utf-8"),
    "/board.js": ("board.js", "text/javascript; charset=utf-8"),
}
DOC_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.md$")
BRAND_FILES = {
    "/brand/mark.svg": ("assets/brand/crosspane-mark-color.svg", "image/svg+xml"),
    "/brand/wordmark.svg": ("assets/brand/crosspane-wordmark-dark.svg", "image/svg+xml"),
    "/brand/lockup.svg": ("assets/brand/crosspane-lockup-dark.svg", "image/svg+xml"),
    "/brand/favicon.png": ("assets/brand/favicon.png", "image/png"),
    "/brand/hero.webp": ("assets/brand/crosspane-hero.webp", "image/webp"),
}


class State:
    """The latest board, its version, and when each card first appeared or last moved."""

    def __init__(self, repo: Path):
        self.repo = repo
        self.cond = threading.Condition()
        self.version = 0
        self.board: dict | None = None
        self.error = ""
        self.started = time.time()
        self.first_seen: dict[str, float | None] = {}
        self.last_cls: dict[str, str] = {}
        self.changed: dict[str, tuple[float, str]] = {}
        self.sig: tuple = ()

    def rebuild(self) -> None:
        try:
            fresh = board.build(self.repo)
        except Exception:  # keep serving the last good board; show the error on the page
            with self.cond:
                self.error = traceback.format_exc(limit=3)
                self.version += 1
                self.cond.notify_all()
            return
        now = time.time()
        initial = self.board is None
        for item in board.every_item(fresh):
            key = item["key"]
            if key not in self.first_seen:
                self.first_seen[key] = None if initial else now
            prev = self.last_cls.get(key)
            if prev is not None and prev != item["cls"]:
                self.changed[key] = (now, prev)
            self.last_cls[key] = item["cls"]
            item["arrived_at"] = self.first_seen[key]
            item["arrived"] = self.first_seen[key] is not None
            if key in self.changed:
                item["changed_at"], item["previous_cls"] = self.changed[key]
        with self.cond:
            self.version += 1
            fresh["version"] = self.version
            fresh["server_started"] = self.started
            self.board = fresh
            self.error = ""
            self.cond.notify_all()

    def watch(self, interval: float) -> None:
        while True:
            try:
                sig = board.signature(self.repo)
            except Exception:
                sig = ()
            if sig != self.sig:
                self.sig = sig
                self.rebuild()
            time.sleep(interval)


class Handler(BaseHTTPRequestHandler):
    server_version = "crosspane-wp-board"
    state: State

    def log_message(self, format, *args):  # noqa: A002 - quiet access log
        pass

    def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, value, status: int = 200) -> None:
        self.send_bytes(json.dumps(value).encode(), "application/json", status)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        try:
            if path in STATIC_FILES:
                name, ctype = STATIC_FILES[path]
                self.send_bytes((STATIC / name).read_bytes(), ctype)
            elif path in BRAND_FILES:
                rel, ctype = BRAND_FILES[path]
                self.send_bytes((REPO / rel).read_bytes(), ctype)
            elif path == "/api/board":
                with self.state.cond:
                    snapshot, error = self.state.board, self.state.error
                if snapshot is None:
                    self.send_json({"error": error or "starting"}, 503)
                else:
                    self.send_json(snapshot | {"error": error})
            elif path == "/api/wp":
                key = parse_qs(url.query).get("key", [""])[0]
                with self.state.cond:
                    snapshot = self.state.board
                found = board.detail(DATA_REPO, snapshot, key) if snapshot else None
                if found is None:
                    self.send_json({"error": "unknown work package"}, 404)
                else:
                    self.send_json(found)
            elif path == "/api/doc":
                name = parse_qs(url.query).get("file", [""])[0]
                wp_dir = DATA_REPO / "docs" / "wp"
                if not DOC_NAME.match(name) or name not in os.listdir(wp_dir):
                    self.send_json({"error": "unknown document"}, 404)
                else:
                    text = (wp_dir / name).read_text(encoding="utf-8", errors="replace")
                    spec = board.parse_spec(text)
                    self.send_json({"file": name, "h1": spec.h1, "markdown": text})
            elif path == "/api/notes":
                query = parse_qs(url.query)
                wp = query.get("wp", [""])[0]
                try:
                    limit = max(0, int(query.get("limit", ["50"])[0]))
                except ValueError:
                    limit = 50
                found = journal.read_all(DATA_REPO)
                if wp:
                    found = [n for n in found if n["wp"] == wp]
                found = found[::-1][:limit] if limit else found[::-1]
                self.send_json({"notes": found})
            elif path == "/events":
                self.events()
            else:
                self.send_json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        if urlparse(self.path).path != "/api/notes":
            self.send_json({"error": "not found"}, 404)
            return
        # Browsers can't send application/json cross-origin without a preflight this server never
        # answers, and any Origin they do send must be this board's own.
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        origin = self.headers.get("Origin")
        allowed = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        if ctype != "application/json" or (origin is not None and origin not in allowed):
            self.send_json({"error": "send JSON from a local client (Content-Type: application/json)"}, 403)
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json({"error": "Content-Length required"}, 411)
            return
        if not 0 < length <= MAX_POST:
            self.send_json({"error": f"body must be 1 to {MAX_POST} bytes"}, 413)
            return
        try:
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")
            note = journal.make(
                str(body.get("wp", "")),
                str(body.get("kind", "note")),
                str(body.get("text", "")),
                body.get("percent"),
                str(body.get("author", "") or "api"),
            )
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
            return
        try:
            journal.append(DATA_REPO, note)
        except OSError as exc:
            self.send_json({"error": f"could not write the journal: {exc}"}, 500)
            return
        self.send_json({"note": note | {"source": "main"}}, 201)

    def events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        sent = -1
        self.wfile.write(b"retry: 2000\n\n")
        while True:
            with self.state.cond:
                self.state.cond.wait_for(lambda: self.state.version != sent, timeout=15)
                version = self.state.version
            if version != sent:
                self.wfile.write(f"event: version\ndata: {version}@{self.state.started}\n\n".encode())
                sent = version
            else:
                self.wfile.write(b": ping\n\n")
            self.wfile.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8737)
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between change polls")
    parser.add_argument("--open", action="store_true", help="open the board in a browser")
    parser.add_argument("--repo", type=Path, default=REPO, help="repository to read (default: this one)")
    args = parser.parse_args()

    global DATA_REPO
    DATA_REPO = args.repo.resolve()
    state = State(DATA_REPO)
    state.sig = board.signature(DATA_REPO)
    state.rebuild()
    threading.Thread(target=state.watch, args=(args.interval,), daemon=True).start()

    Handler.state = state
    url = f"http://127.0.0.1:{args.port}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        print(
            f"Port {args.port} is already in use, probably by a board that is already running: {url}\n"
            f"Open that, or start another with --port N.",
            file=sys.stderr,
        )
        if args.open:
            webbrowser.open(url)
        sys.exit(1)
    server.daemon_threads = True
    print(f"Crosspane work-package board: {url}  (watching {DATA_REPO / 'docs' / 'wp'})", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
