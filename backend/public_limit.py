"""Caps paid DetectifAI operations requested through the public tunnel link.

Requests from the presenter's laptop (no proxy/tunnel headers) are never limited. Requests that arrive via a
tunnel (Cloudflare adds cf-connecting-ip etc.) share a small hourly budget, so a leaked judge link can't drain
the team's credits. Limits are configurable with env vars:
  CALLSHIELD_PUBLIC_CHECKS_PER_HOUR   (default 8)   live checks via the public link, all visitors together
  CALLSHIELD_PUBLIC_CHECKS_PER_IP     (default 4)   per visitor IP per hour
  CALLSHIELD_PUBLIC_ENROLLS_PER_HOUR  (default 4)   enrollments via the public link per hour
"""
from __future__ import annotations

import os
import threading
import time
from collections import deque

from fastapi import Request

from .attack import PROXY_HEADERS

WINDOW_SECONDS = 3600.0


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.getenv(name, "") or default))
    except ValueError:
        return default


def is_public(request: Request) -> bool:
    headers = request.headers
    return any(h in headers for h in PROXY_HEADERS)


def client_ip(request: Request) -> str:
    h = request.headers
    return (h.get("cf-connecting-ip") or h.get("x-real-ip")
            or (h.get("x-forwarded-for") or "").split(",")[0].strip()
            or (request.client.host if request.client else "unknown"))


class PublicLimiter:
    def __init__(self):
        self._lock = threading.Lock()
        self._events: dict[str, deque] = {}

    def _prune(self, key: str, now: float) -> deque:
        q = self._events.setdefault(key, deque())
        while q and now - q[0] > WINDOW_SECONDS:
            q.popleft()
        return q

    def check(self, request: Request, kind: str) -> tuple[bool, str | None]:
        """Returns (allowed, message). Records the use when allowed."""
        if not is_public(request):
            return True, None
        now = time.time()
        if kind == "enroll":
            limits = [("enroll:all", _env_int("CALLSHIELD_PUBLIC_ENROLLS_PER_HOUR", 4))]
        else:
            ip = client_ip(request)
            limits = [("check:all", _env_int("CALLSHIELD_PUBLIC_CHECKS_PER_HOUR", 8)),
                      (f"check:ip:{ip}", _env_int("CALLSHIELD_PUBLIC_CHECKS_PER_IP", 4))]
        with self._lock:
            for key, cap in limits:
                q = self._prune(key, now)
                if len(q) >= cap:
                    wait_min = max(1, int((WINDOW_SECONDS - (now - q[0])) // 60) + 1) if q else 60
                    what = "voice enrollments" if kind == "enroll" else "live checks"
                    return False, (f"The public demo link allows a limited number of {what} per hour to protect "
                                   f"our DetectifAI credits. Try again in about {wait_min} min, or ask the team "
                                   "to run it on the presenter's laptop.")
            for key, _cap in limits:
                self._events[key].append(now)
        return True, None
