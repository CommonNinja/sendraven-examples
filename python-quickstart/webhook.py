"""
Receiving SendRaven webhooks with the standard library.

Every delivery is a POST with a JSON body and an X-CN-Signature header:

    X-CN-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">

keyed with the endpoint's signing secret (the whole `whsec_...` string).
Verify against the raw bytes before parsing: re-serialised JSON will not hash
the same.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional, Union


def verify_signature(raw_body: Union[bytes, str], header: Optional[str], secret: str,
                     tolerance_seconds: int = 300, now: Optional[float] = None) -> bool:
    """True only for a signature made with `secret` over exactly `raw_body`, no
    older than `tolerance_seconds`. Each delivery attempt, retries included,
    carries a fresh timestamp."""
    if not header:
        return False
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs((now if now is not None else time.time()) - t) > tolerance_seconds:
        return False
    body = raw_body.encode() if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))


def serve(secret: str, on_event: Callable[[dict], None], port: int = 3000) -> None:
    """A dependency-free receiver. It answers 204 as soon as the signature
    checks out and runs `on_event` on a background thread: SendRaven allows
    ten seconds, and a slow handler turns into a retry. Deliveries are
    at-least-once, so `on_event` must be safe to run twice for one event."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep the console for events
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                self.send_response(413)
                self.end_headers()
                return
            raw = self.rfile.read(length)
            if not verify_signature(raw, self.headers.get("X-CN-Signature"), secret):
                self.send_response(401)
                self.end_headers()
                return
            try:
                event = json.loads(raw)
            except ValueError:
                self.send_response(400)
                self.end_headers()
                return
            self.send_response(204)
            self.end_headers()
            threading.Thread(target=_safe, args=(on_event, event), daemon=True).start()

    print(f"Listening for signed webhooks on :{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


def _safe(fn: Callable[[dict], None], event: dict) -> None:
    try:
        fn(event)
    except Exception as e:  # noqa: BLE001 - a handler bug must not kill the server
        print(f"webhook handler failed: {e!r}")
