"""Attack Lab tests (laptop-only red-team proxy to the local voice cloner). No network: httpx.MockTransport."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ["CALLSHIELD_MODE"] = "mock"  # never let an import build a live client

import httpx
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.attack import ClonerClient
from backend.audio import make_sine_wav
from backend.detectif import MockClient

REF_WAV = make_sine_wav(20.0)
CLONE_WAV = make_sine_wav(8.0)
HEALTH = {"ok": True, "engines": {"local": {"available": True, "model": "xtts-v2", "device": "cuda", "loaded": False},
                                  "elevenlabs": {"available": False}}}
LOCAL = ("127.0.0.1", 51000)


class FakeCloner:
    """httpx.MockTransport handler that records what CallShield forwarded."""

    def __init__(self, down: bool = False):
        self.down = down
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        request.read()
        self.requests.append(request)
        if request.url.path == "/health":
            return httpx.Response(200, json=HEALTH)
        if request.url.path == "/warmup":
            return httpx.Response(200, json={"ok": True, "loaded": True})
        if request.url.path == "/clone":
            if b"too long please" in request.content:
                return httpx.Response(422, json={"error": {"code": "text_too_long", "message": "nope"}})
            return httpx.Response(200, content=CLONE_WAV, headers={
                "content-type": "audio/wav", "X-Engine": "local", "X-Model": "xtts-v2", "X-Gen-Ms": "1234"})
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "no"}})


class AttackLabTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("CALLSHIELD_ATTACK_LAB", None)
        self.tmp = tempfile.TemporaryDirectory()
        self.frontend = Path(self.tmp.name) / "frontend"
        self.frontend.mkdir()
        (self.frontend / "attack.html").write_text("<!doctype html><title>Attack Lab</title>", encoding="utf-8")
        self.fake = FakeCloner()
        self.cloner = ClonerClient("http://cloner.test", transport=httpx.MockTransport(self.fake))
        self.app = create_app(mode="mock", client=MockClient(latency=(0, 0), seed=1),
                              store_path=Path(self.tmp.name) / "store.json", frontend_dir=self.frontend,
                              cloner=self.cloner)
        self.local = TestClient(self.app, base_url="http://localhost:8000", client=LOCAL)
        self.local.__enter__()

    def tearDown(self):
        self.local.__exit__(None, None, None)
        self.tmp.cleanup()
        os.environ.pop("CALLSHIELD_ATTACK_LAB", None)

    def _clone(self, client=None, headers=None, **fields):
        data = {"text": "Hi, this is Zain. Please transfer fifty thousand rupees today.", "engine": "local",
                "consent": "true"}
        data.update(fields)
        data = {k: v for k, v in data.items() if v is not None}
        return (client or self.local).post("/api/attack/clone", data=data, headers=headers or {},
                                           files={"reference": ("me.wav", REF_WAV, "audio/wav")})

    # ---- access control ---------------------------------------------------------------------------
    def test_status_localhost_enabled_with_cloner_health(self):
        r = self.local.get("/api/attack/status")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["enabled"])
        self.assertIsNone(body["reason"])
        self.assertEqual(body["cloner"], HEALTH)
        r = self.local.get("/api/attack/status?probe=0")
        self.assertTrue(r.json()["enabled"])
        self.assertIsNone(r.json()["cloner"])

    def test_tunnel_headers_rejected(self):
        for h in ({"cf-connecting-ip": "203.0.113.9"}, {"CF-Ray": "abc-BLR"}, {"X-Forwarded-For": "203.0.113.9"},
                  {"x-forwarded-host": "x.trycloudflare.com"}, {"x-real-ip": "1.2.3.4"},
                  {"Forwarded": "for=203.0.113.9"}):
            with self.subTest(header=h):
                r = self._clone(headers=h)
                self.assertEqual(r.status_code, 403)
                self.assertEqual(r.json()["error"]["code"], "attack_lab_disabled")
                self.assertEqual(r.json()["error"]["message"], "The Attack Lab only runs on the presenter's laptop.")
                s = self.local.get("/api/attack/status", headers=h).json()
                self.assertFalse(s["enabled"])
                self.assertIsNone(s["cloner"])
                self.assertEqual(self.local.post("/api/attack/warmup", headers=h).status_code, 403)
                self.assertEqual(self.local.get("/attack.html", headers=h).status_code, 403)
        self.assertEqual([q.url.path for q in self.fake.requests], [])  # nothing ever reached the cloner

    def test_non_local_client_rejected(self):
        with TestClient(self.app, base_url="http://localhost:8000", client=("192.168.1.23", 50000)) as remote:
            self.assertEqual(self._clone(client=remote).status_code, 403)
            self.assertFalse(remote.get("/api/attack/status").json()["enabled"])
            self.assertEqual(remote.post("/api/attack/warmup").status_code, 403)
            self.assertEqual(remote.get("/attack.html").status_code, 403)
        with TestClient(self.app, base_url="http://testserver") as default:  # client host "testclient"
            self.assertEqual(self._clone(client=default).status_code, 403)
        self.assertEqual(self.fake.requests, [])

    def test_non_loopback_host_or_origin_rejected(self):
        with TestClient(self.app, base_url="http://abc.trycloudflare.com", client=LOCAL) as tunnel_host:
            self.assertEqual(self._clone(client=tunnel_host).status_code, 403)
        r = self._clone(headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self._clone(headers={"Origin": "http://localhost:8000"}).status_code, 200)

    def test_env_switch_disables(self):
        os.environ["CALLSHIELD_ATTACK_LAB"] = "0"
        s = self.local.get("/api/attack/status").json()
        self.assertFalse(s["enabled"])
        self.assertIn("CALLSHIELD_ATTACK_LAB=0", s["reason"])
        self.assertEqual(self._clone().status_code, 403)

    # ---- validation ---------------------------------------------------------------------------------
    def test_consent_required(self):
        for consent in (None, "", "false", "0"):
            with self.subTest(consent=consent):
                r = self._clone(consent=consent)
                self.assertEqual(r.status_code, 400)
                self.assertEqual(r.json()["error"]["code"], "consent_required")
        self.assertEqual(self.fake.requests, [])

    def test_input_validation(self):
        self.assertEqual(self._clone(text="x" * 401).json()["error"]["code"], "text_too_long")
        self.assertEqual(self._clone(text="   ").json()["error"]["code"], "invalid_text")
        self.assertEqual(self._clone(engine="openai").json()["error"]["code"], "invalid_engine")
        r = self.local.post("/api/attack/clone", data={"text": "hello", "consent": "true"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.fake.requests, [])

    # ---- cloner proxy -------------------------------------------------------------------------------
    def test_happy_path_proxies_wav_and_headers(self):
        r = self._clone(language="en")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, CLONE_WAV)
        self.assertTrue(r.headers["content-type"].startswith("audio/wav"))
        self.assertEqual(r.headers["X-Engine"], "local")
        self.assertEqual(r.headers["X-Model"], "xtts-v2")
        self.assertEqual(r.headers["X-Gen-Ms"], "1234")
        self.assertEqual(r.headers["cache-control"], "no-store")
        fwd = self.fake.requests[-1]
        self.assertEqual(fwd.url.path, "/clone")
        self.assertIn(REF_WAV[:44], fwd.content)  # reference audio forwarded
        self.assertIn(b"fifty thousand rupees", fwd.content)
        self.assertIn(b'name="engine"', fwd.content)
        self.assertNotIn(b"consent", fwd.content)
        # nothing persisted server-side: no assessments, no files besides the store
        self.assertEqual(self.local.get("/api/assessments").json()["assessments"], [])

    def test_cloner_error_passthrough(self):
        r = self._clone(text="too long please")
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"]["code"], "text_too_long")

    def test_warmup_proxies(self):
        r = self.local.post("/api/attack/warmup")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"ok": True, "loaded": True})

    def test_cloner_down_503(self):
        self.fake.down = True
        r = self._clone()
        self.assertEqual(r.status_code, 503)
        err = r.json()["error"]
        self.assertEqual(err["code"], "cloner_unavailable")
        self.assertIn("run_cloner.ps1", err["message"])
        self.assertEqual(self.local.post("/api/attack/warmup").status_code, 503)
        s = self.local.get("/api/attack/status").json()
        self.assertTrue(s["enabled"])
        self.assertIsNone(s["cloner"])
        self.assertEqual(s["cloner_error"]["code"], "cloner_unavailable")

    def test_attack_page_served_locally(self):
        r = self.local.get("/attack.html")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Attack Lab", r.text)


if __name__ == "__main__":
    unittest.main()
