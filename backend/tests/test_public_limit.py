"""PublicLimiter tests. Run from the project root:  .venv/Scripts/python -m unittest -v"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from starlette.requests import Request

from backend import public_limit
from backend.public_limit import PublicLimiter, client_ip, is_public


def make_request(headers: dict | None = None, client_host: str = "127.0.0.1") -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "headers": raw, "client": (client_host, 1234)})


def tunnel(ip: str) -> Request:
    return make_request({"cf-connecting-ip": ip})


class PublicLimiterTests(unittest.TestCase):
    def setUp(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("CALLSHIELD_PUBLIC_")}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_is_public_and_client_ip(self):
        self.assertFalse(is_public(make_request()))
        self.assertTrue(is_public(tunnel("1.2.3.4")))
        self.assertEqual(client_ip(tunnel("1.2.3.4")), "1.2.3.4")
        self.assertEqual(client_ip(make_request({"x-forwarded-for": "5.6.7.8, 10.0.0.1"})), "5.6.7.8")
        self.assertEqual(client_ip(make_request(client_host="9.9.9.9")), "9.9.9.9")

    def test_local_requests_are_never_limited(self):
        lim = PublicLimiter()
        for _ in range(50):
            self.assertEqual(lim.check(make_request(), "check"), (True, None))

    def test_per_ip_check_cap(self):
        lim = PublicLimiter()
        for _ in range(4):
            self.assertTrue(lim.check(tunnel("1.1.1.1"), "check")[0])
        allowed, msg = lim.check(tunnel("1.1.1.1"), "check")
        self.assertFalse(allowed)
        self.assertIn("live checks", msg)
        self.assertTrue(lim.check(tunnel("2.2.2.2"), "check")[0])  # another visitor still has budget

    def test_global_check_cap(self):
        lim = PublicLimiter()
        for i in range(8):
            self.assertTrue(lim.check(tunnel(f"10.0.0.{i}"), "check")[0])
        self.assertFalse(lim.check(tunnel("10.0.0.99"), "check")[0])

    def test_enroll_and_clone_caps(self):
        lim = PublicLimiter()
        for _ in range(4):
            self.assertTrue(lim.check(tunnel("1.1.1.1"), "enroll")[0])
        allowed, msg = lim.check(tunnel("1.1.1.1"), "enroll")
        self.assertFalse(allowed)
        self.assertIn("voice enrollments", msg)
        for _ in range(4):
            self.assertTrue(lim.check(tunnel("1.1.1.1"), "clone")[0])
        allowed, msg = lim.check(tunnel("1.1.1.1"), "clone")
        self.assertFalse(allowed)
        self.assertIn("voice clones", msg)

    def test_env_overrides(self):
        os.environ["CALLSHIELD_PUBLIC_CHECKS_PER_IP"] = "1"
        lim = PublicLimiter()
        self.assertTrue(lim.check(tunnel("1.1.1.1"), "check")[0])
        self.assertFalse(lim.check(tunnel("1.1.1.1"), "check")[0])
        os.environ["CALLSHIELD_PUBLIC_CHECKS_PER_IP"] = "not-a-number"  # falls back to the default (4)
        self.assertTrue(lim.check(tunnel("3.3.3.3"), "check")[0])

    def test_window_expires(self):
        lim = PublicLimiter()
        with mock.patch.object(public_limit.time, "time", return_value=1000.0):
            for _ in range(4):
                lim.check(tunnel("1.1.1.1"), "check")
            self.assertFalse(lim.check(tunnel("1.1.1.1"), "check")[0])
        later = 1000.0 + public_limit.WINDOW_SECONDS + 1
        with mock.patch.object(public_limit.time, "time", return_value=later):
            self.assertTrue(lim.check(tunnel("1.1.1.1"), "check")[0])


if __name__ == "__main__":
    unittest.main()
