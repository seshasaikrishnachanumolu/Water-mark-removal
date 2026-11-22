"""Operational basics: stale-file cleanup and a small per-IP rate limiter."""
from __future__ import annotations

import json
import shutil
import threading
import time
from collections import defaultdict, deque
from pathlib import Path


def start_cleanup(root: Path, ttl_seconds: int, interval: int = 1800) -> None:
    """Delete upload / result folders older than ttl_seconds, forever, in a daemon thread.

    `root` holds one folder per uploaded video; `root/studio` holds per-request work
    files. Both are swept, but the `studio` folder itself is kept.
    """
    def sweep(base: Path, keep: set[str]) -> None:
        if not base.is_dir():
            return
        now = time.time()
        for p in base.iterdir():
            if p.name in keep:
                continue
            try:
                if now - p.stat().st_mtime > ttl_seconds:
                    shutil.rmtree(p) if p.is_dir() else p.unlink()
            except OSError:
                pass  # in use / already gone: try again next round

    def loop() -> None:
        while True:
            sweep(root, {"studio"})
            sweep(root / "studio", set())
            time.sleep(interval)

    threading.Thread(target=loop, daemon=True, name="storage-cleanup").start()


class RateLimitMiddleware:
    """Sliding-window limit on POST /api/* per client IP (pure ASGI, so uploads still stream)."""

    def __init__(self, app, per_minute: int):
        self.app = app
        self.per_minute = per_minute
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    async def __call__(self, scope, receive, send):
        if (self.per_minute > 0 and scope["type"] == "http" and scope["method"] == "POST"
                and scope["path"].startswith("/api/")):
            ip = (scope.get("client") or ("?",))[0]
            now = time.monotonic()
            with self.lock:
                q = self.hits[ip]
                while q and now - q[0] > 60:
                    q.popleft()
                limited = len(q) >= self.per_minute
                if not limited:
                    q.append(now)
            if limited:
                body = json.dumps({"detail": "Too many requests. Please slow down."}).encode()
                await send({"type": "http.response.start", "status": 429,
                            "headers": [(b"content-type", b"application/json"),
                                        (b"retry-after", b"30"),
                                        (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
