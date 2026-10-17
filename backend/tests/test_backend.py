"""CallShield backend tests. Run from the project root:  .venv/Scripts/python -m unittest -v

No network: LiveClient is exercised with httpx.MockTransport; the app runs on tests.fakes.FakeClient.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

import backend.app as app_module
from backend import risk
from backend.app import create_app
from backend.attack import ClonerClient
from backend.audio import make_sine_wav, wav_duration
from backend.detectif import DetectifError, LiveClient, normalize_detect, normalize_verify, normalize_verify_error
from backend.events import Broadcaster
from backend.store import Store, valid_customer_id
from backend.tests.fakes import FakeClient

ROOT = Path(__file__).resolve().parents[2]
LIVE_DETECT_FIXTURE = ROOT / "testdata" / "live_detect_tts.json"

WAV_8S = make_sine_wav(8.0)
WAV_3S = make_sine_wav(3.0)
WAV_20S = make_sine_wav(20.0)

# --- example payloads copied from the DetectifAI OpenAPI spec ------------------------------------
SEGMENTS = [{"start": 0.0, "end": 4.0, "score": 0.79}, {"start": 2.0, "end": 6.0, "score": 0.83}]
DETECT_FAKE = {
    "request_id": "req_8f14e45fceea167a5a36dedd", "operation_id": "op_6f1ed002ab5595859014ebf0951522d9",
    "object": "deepfake.detection", "model": {"name": "aletheia-wavlm", "version": "x"}, "latency_ms": 58.3,
    "idempotent_replay": False,
    "result": {"threshold": 0.62, "verdict": "fake", "label": "synthetic", "is_synthetic": True,
               "decided_by": "second_stage", "score": 0.8127, "language": {"code": "en", "probability": 0.99},
               "route": "en", "second_stage_probability": 0.9342, "duration_seconds": 9.1, "segments": SEGMENTS},
    "credits": {"charged": 50, "balance": 4900},
}
EMBEDDED_DF = {
    "verdict": "real", "label": "genuine", "is_synthetic": False, "decided_by": "main_model", "score": 0.08,
    "threshold": 0.62, "duration_seconds": 6.1,
    "segments": [{"start": 0.0, "end": 4.0, "score": 0.08}, {"start": 2.0, "end": 6.1, "score": 0.07}],
    "operation_id": "op_0b9d2f4c1e7a4b6c8d0e1f2a3b4c5d6e", "credits_charged": 50,
    "model": {"name": "aletheia-wavlm", "version": "x"},
}
VERIFY_OK = {
    "request_id": "req_8f14e45fceea167a5a36dedd", "operation_id": "op_6f1ed002ab5595859014ebf0951522d9",
    "object": "speaker.verification", "speaker_id": "customer-4711",
    "result": {"decision": "match", "similarity": 0.7412, "threshold": 0.53, "duration_seconds": 4.1,
               "similarity_semantics": "..."},
    "deepfake": EMBEDDED_DF, "model": {"name": "eidos-redimnet2", "version": "redimnet2-b2"},
    "credits": {"charged": 50, "balance": 4850}, "latency_ms": 301.5, "idempotent_replay": False,
}
ERR_402 = {"error": {"type": "insufficient_credits", "code": "insufficient_credits",
                     "message": "Not enough credits are available for this operation."},
           "request_id": "req_8f14e45fceea167a5a36dedd", "credits": {"available": 20, "required": 50}}
ERR_429 = {"error": {"type": "rate_limited", "code": "rate_limited", "message": "Model operation rate limit"},
           "request_id": "req_429"}
ERR_503_PARTIAL = {"error": {"type": "overloaded", "code": "inference_overloaded",
                             "message": "The service is at capacity; retry shortly."},
                   "request_id": "req_503", "operation_id": "op_x",
                   "partial": {"deepfake": EMBEDDED_DF, "credits": {"charged": 50, "balance": 4850}}}


def run(coro):
    return asyncio.run(coro)


async def _no_sleep(_secs):
    return None


class AudioTests(unittest.TestCase):
    def test_wav_duration(self):
        self.assertAlmostEqual(wav_duration(WAV_8S), 8.0, places=3)
        self.assertAlmostEqual(wav_duration(WAV_3S), 3.0, places=3)
        self.assertIsNone(wav_duration(b"\x1aE\xdf\xa3webm..."))


class RiskTests(unittest.TestCase):
    def test_format_inr(self):
        self.assertEqual(risk.format_inr(50000), "₹50,000")
        self.assertEqual(risk.format_inr(100000), "₹1,00,000")
        self.assertEqual(risk.format_inr(12345678), "₹1,23,45,678")
        self.assertEqual(risk.format_inr(999), "₹999")
        self.assertEqual(risk.format_inr(1500.5), "₹1,500.50")

    def test_genuine_approves(self):
        r = risk.assess({"verdict": "real", "score": 0.1}, {"decision": "match", "similarity": 0.75,
                                                             "threshold": 0.53}, "fund_transfer", 20000)
        self.assertEqual(r["decision"], "APPROVE")
        self.assertEqual(r["score"], 12)  # 2 + 0 + 10
        self.assertEqual(r["level"], "low")

    def test_deepfake_blocks_even_with_matching_voice(self):
        r = risk.assess({"verdict": "fake", "score": 0.81}, {"decision": "match", "similarity": 0.6,
                                                              "threshold": 0.53}, "fund_transfer", 50000)
        self.assertEqual(r["decision"], "BLOCK")
        self.assertEqual(r["score"], 100)  # 70 + 10 weak + 20 action -> clamp
        self.assertEqual(r["level"], "high")
        self.assertIn("Synthetic voice detected (score 0.81)", r["reasons"])
        self.assertIn("High-risk action: Fund transfer ₹50,000", r["reasons"])

    def test_contract_example_reasons(self):
        r = risk.assess({"verdict": "fake", "score": 0.81}, {"decision": "no_match", "similarity": 0.21,
                                                              "threshold": 0.53}, "fund_transfer", 50000)
        self.assertEqual(r["reasons"], ["Synthetic voice detected (score 0.81)",
                                        "Voice does not match enrolled customer (0.21 < 0.53)",
                                        "High-risk action: Fund transfer ₹50,000"])

    def test_imposter(self):
        imp = {"decision": "no_match", "similarity": 0.2, "threshold": 0.53}
        small = risk.assess({"verdict": "real", "score": 0.1}, imp, "fund_transfer", 10000)
        self.assertEqual((small["score"], small["decision"]), (62, "STEP_UP"))
        big = risk.assess({"verdict": "real", "score": 0.1}, imp, "fund_transfer", 50000)
        self.assertEqual((big["score"], big["decision"]), (72, "BLOCK"))
        sim = risk.assess({"verdict": "real", "score": 0.1}, imp, "sim_otp_reset")
        self.assertEqual((sim["score"], sim["decision"]), (67, "STEP_UP"))

    def test_uncertain_steps_up(self):
        r = risk.assess({"verdict": "not_sure", "score": 0.65}, {"decision": "match", "similarity": 0.58,
                                                                  "threshold": 0.53}, "limit_change")
        self.assertEqual(r["decision"], "STEP_UP")
        self.assertEqual(r["score"], 50)
        self.assertEqual(r["level"], "medium")
        # not_sure always steps up even with a low score
        r2 = risk.assess({"verdict": "not_sure", "score": 0.65}, {"decision": "match", "similarity": 0.9,
                                                                   "threshold": 0.53}, "beneficiary_add")
        self.assertEqual(r2["score"], 40)
        self.assertEqual(r2["decision"], "STEP_UP")

    def test_unknown_caller(self):
        r = risk.assess({"verdict": "real", "score": 0.1}, None, "fund_transfer", 1000)
        self.assertEqual(r["score"], 32)
        self.assertEqual(r["decision"], "APPROVE")
        self.assertIn("Caller not enrolled — identity unverified", r["reasons"])

    def test_missing_deepfake_note(self):
        r = risk.assess(None, {"decision": "match", "similarity": 0.8, "threshold": 0.53}, "fund_transfer",
                        deepfake_note="Deepfake check unavailable (audio_too_short): too short")
        self.assertEqual(r["reasons"][0], "Deepfake check unavailable (audio_too_short): too short")
        self.assertEqual(r["score"], 40)
        self.assertEqual(r["decision"], "STEP_UP")

    def test_missing_deepfake_fails_closed(self):
        # Strong voice match + low-risk action would score 10, but no deepfake verdict must never APPROVE.
        r = risk.assess(None, {"decision": "match", "similarity": 0.9, "threshold": 0.53}, "beneficiary_add")
        self.assertEqual(r["score"], 40)
        self.assertEqual(r["decision"], "STEP_UP")
        self.assertIn("Deepfake check did not run — voice not verified as human", r["reasons"])
        self.assertEqual(risk.assess(None, {"decision": "no_match", "similarity": 0.1, "threshold": 0.53},
                                     "fund_transfer", 50000)["decision"], "BLOCK")

    def test_feedback_from_customer_response(self):
        clone = {"deepfake": {"verdict": "fake", "operation_id": "op_df"},
                 "speaker": {"decision": "match", "operation_id": "op_sp"}}
        self.assertEqual(risk.feedback_from_response(clone, "not_me"), [
            {"operation_id": "op_df", "signal": "deepfake", "correct": True},
            {"operation_id": "op_sp", "signal": "speaker", "correct": False}])
        self.assertEqual(risk.feedback_from_response(clone, "me"), [
            {"operation_id": "op_df", "signal": "deepfake", "correct": False},
            {"operation_id": "op_sp", "signal": "speaker", "correct": True}])
        impostor = {"deepfake": {"verdict": "real", "operation_id": "op_df"},
                    "speaker": {"decision": "no_match", "operation_id": "op_sp"}}
        # a human impostor is real speech: "not me" says nothing about the deepfake verdict
        self.assertEqual(risk.feedback_from_response(impostor, "not_me"),
                         [{"operation_id": "op_sp", "signal": "speaker", "correct": True}])
        unsure = {"deepfake": {"verdict": "not_sure", "operation_id": "op_df"}, "speaker": None}
        self.assertEqual(risk.feedback_from_response(unsure, "me"), [])

    def test_alerts(self):
        a = risk.build_alert("BLOCK", "fund_transfer", 50000)
        self.assertTrue(a["sent"])
        self.assertEqual(a["message"], "CallShield blocked a ₹50,000 fund transfer requested on a call claiming "
                                       "to be you. If this wasn't you, no action is needed — your money is safe.")
        s = risk.build_alert("STEP_UP", "sim_otp_reset")
        self.assertEqual(s["message"], "A call claiming to be you asked for a SIM/OTP reset. "
                                       "Confirm in the app if this was you.")
        self.assertFalse(risk.build_alert("APPROVE", "fund_transfer", 10)["sent"])


class LiveClientTests(unittest.TestCase):
    def _client(self, handler):
        return LiveClient("dtf_live_TESTKEY", base_url="https://platform.detectif.ai",
                          transport=httpx.MockTransport(handler), sleep=_no_sleep)

    def test_verify_with_embedded_deepfake(self):
        seen = {}

        def handler(req: httpx.Request):
            seen["path"] = req.url.path
            seen["auth"] = req.headers.get("authorization")
            seen["idem"] = req.headers.get("idempotency-key")
            seen["body"] = req.content
            return httpx.Response(200, json=VERIFY_OK)

        async def go():
            c = self._client(handler)
            try:
                return await c.verify(WAV_8S, "clip.wav", "audio/wav", "customer-4711", detect_deepfake=True)
            finally:
                await c.aclose()

        resp = run(go())
        self.assertEqual(seen["path"], "/v1/speakers/verify")
        self.assertEqual(seen["auth"], "Bearer dtf_live_TESTKEY")
        self.assertEqual(len(seen["idem"]), 36)
        self.assertIn(b'name="detect_deepfake"', seen["body"])
        self.assertIn(b'name="speaker_id"', seen["body"])
        self.assertIn(b'filename="clip.wav"', seen["body"])
        out = normalize_verify(resp)
        self.assertEqual(out["speaker"], {"decision": "match", "similarity": 0.7412, "threshold": 0.53,
                                          "operation_id": "op_6f1ed002ab5595859014ebf0951522d9"})
        self.assertEqual(out["deepfake"]["verdict"], "real")
        self.assertEqual(out["deepfake"]["operation_id"], "op_0b9d2f4c1e7a4b6c8d0e1f2a3b4c5d6e")
        self.assertEqual(out["charged"], 100)   # verify 50 + embedded deepfake 50
        self.assertEqual(out["balance"], 4850)

    def test_verify_embedded_deepfake_error(self):
        resp = copy.deepcopy(VERIFY_OK)
        resp["deepfake"] = {"error": {"type": "unprocessable_audio", "code": "audio_too_short",
                                      "message": "Audio must be longer than 4 seconds"},
                            "operation_id": "op_df", "credits_charged": 0}
        out = normalize_verify(resp)
        self.assertIsNone(out["deepfake"])
        self.assertEqual(out["deepfake_error"]["code"], "audio_too_short")
        self.assertEqual(out["charged"], 50)

    def test_detect_fake(self):
        def handler(req):
            self.assertEqual(req.url.path, "/v1/deepfake/detect")
            return httpx.Response(200, json=DETECT_FAKE)

        async def go():
            c = self._client(handler)
            try:
                return await c.detect(WAV_8S, "clip.wav", "audio/wav")
            finally:
                await c.aclose()

        out = normalize_detect(run(go()))
        self.assertEqual(out["deepfake"]["verdict"], "fake")
        self.assertAlmostEqual(out["deepfake"]["score"], 0.8127)
        self.assertEqual(out["deepfake"]["decided_by"], "second_stage")
        self.assertEqual(out["deepfake"]["segments"][0], {"start": 0.0, "end": 4.0, "score": 0.79})
        self.assertEqual((out["charged"], out["balance"]), (50, 4900))
        self.assertIsNone(out["speaker"])

    @unittest.skipUnless(LIVE_DETECT_FIXTURE.exists(), "testdata/live_detect_tts.json not present")
    def test_real_live_detect_payload_with_nulls(self):
        payload = json.loads(LIVE_DETECT_FIXTURE.read_text(encoding="utf-8"))
        out = normalize_detect(payload)
        self.assertEqual(out["deepfake"]["verdict"], payload["result"]["verdict"])
        self.assertEqual(out["deepfake"]["operation_id"], payload["operation_id"])
        self.assertEqual(len(out["deepfake"]["segments"]), len(payload["result"]["segments"]))
        self.assertEqual(out["charged"], payload["credits"]["charged"])
        self.assertEqual(out["balance"], payload["credits"]["balance"])
        r = risk.assess(out["deepfake"], None, "fund_transfer", 50000)
        if payload["result"]["verdict"] == "fake":
            self.assertEqual(r["decision"], "BLOCK")

    def test_402_maps_to_error(self):
        async def go():
            c = self._client(lambda req: httpx.Response(402, json=ERR_402))
            try:
                await c.detect(WAV_8S, "clip.wav", "audio/wav")
            finally:
                await c.aclose()

        with self.assertRaises(DetectifError) as cm:
            run(go())
        e = cm.exception
        self.assertEqual((e.status, e.code), (402, "insufficient_credits"))
        self.assertEqual(e.request_id, "req_8f14e45fceea167a5a36dedd")
        self.assertEqual(e.credits, {"available": 20, "required": 50})
        self.assertNotIn("TESTKEY", str(e))

    def test_429_retries_once_with_same_key(self):
        keys, sleeps = [], []

        async def rec_sleep(s):
            sleeps.append(s)

        def handler(req):
            keys.append(req.headers.get("idempotency-key"))
            if len(keys) == 1:
                return httpx.Response(429, json=ERR_429, headers={"Retry-After": "2"})
            return httpx.Response(200, json=DETECT_FAKE)

        async def go():
            c = LiveClient("k", transport=httpx.MockTransport(handler), sleep=rec_sleep)
            try:
                return await c.detect(WAV_8S, "clip.wav", "audio/wav")
            finally:
                await c.aclose()

        resp = run(go())
        self.assertEqual(resp["operation_id"], DETECT_FAKE["operation_id"])
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(sleeps, [2.0])

    def test_429_twice_raises_and_only_two_attempts(self):
        calls = []

        def handler(req):
            calls.append(1)
            return httpx.Response(429, json=ERR_429, headers={"Retry-After": "1"})

        async def go():
            c = self._client(handler)
            try:
                await c.detect(WAV_8S, "clip.wav", "audio/wav")
            finally:
                await c.aclose()

        with self.assertRaises(DetectifError) as cm:
            run(go())
        self.assertEqual(cm.exception.status, 429)
        self.assertEqual(len(calls), 2)

    def _retry_once(self, first):
        """`first(request)` answers attempt 1 (response or raise); attempt 2 succeeds. -> (keys, sleeps)."""
        keys, sleeps = [], []

        async def rec_sleep(s):
            sleeps.append(s)

        def handler(req):
            keys.append(req.headers.get("idempotency-key"))
            return first(req) if len(keys) == 1 else httpx.Response(200, json=DETECT_FAKE)

        async def go():
            c = LiveClient("k", transport=httpx.MockTransport(handler), sleep=rec_sleep)
            try:
                return await c.detect(WAV_8S, "clip.wav", "audio/wav")
            finally:
                await c.aclose()

        self.assertEqual(run(go())["operation_id"], DETECT_FAKE["operation_id"])
        return keys, sleeps

    def test_502_504_network_and_timeout_retry_once_with_same_key(self):
        def connect_error(req):
            raise httpx.ConnectError("boom", request=req)

        def timeout(req):
            raise httpx.ReadTimeout("slow", request=req)

        for name, first, waits in (("502", lambda req: httpx.Response(502), [1.0]),
                                   ("504", lambda req: httpx.Response(504), [1.0]),
                                   ("network", connect_error, [1.0]),
                                   ("timeout", timeout, [])):
            with self.subTest(name):
                keys, sleeps = self._retry_once(first)
                self.assertEqual(len(keys), 2)
                self.assertEqual(len(keys[0]), 36)
                self.assertEqual(keys[0], keys[1])
                self.assertEqual(sleeps, waits)

    def test_each_paid_call_gets_a_fresh_key(self):
        keys = []

        def handler(req):
            keys.append(req.headers.get("idempotency-key"))
            return httpx.Response(200, json=DETECT_FAKE)

        async def go():
            c = self._client(handler)
            try:
                await c.detect(WAV_8S, "a.wav", "audio/wav")
                await c.detect(WAV_8S, "b.wav", "audio/wav")
            finally:
                await c.aclose()

        run(go())
        self.assertEqual(len(keys), 2)
        self.assertNotEqual(keys[0], keys[1])

    def test_503_partial_deepfake(self):
        async def go():
            c = self._client(lambda req: httpx.Response(503, json=ERR_503_PARTIAL))
            try:
                await c.verify(WAV_8S, "clip.wav", "audio/wav", "customer-4711")
            finally:
                await c.aclose()

        with self.assertRaises(DetectifError) as cm:
            run(go())
        out = normalize_verify_error(cm.exception)
        self.assertIsNotNone(out)
        self.assertIsNone(out["speaker"])
        self.assertEqual(out["deepfake"]["verdict"], "real")
        self.assertEqual((out["charged"], out["balance"]), (50, 4850))

    def test_free_endpoints_and_feedback(self):
        def handler(req):
            if req.url.path == "/v1/credits":
                return httpx.Response(200, json={"available": 1950, "reserved": 0, "plan": "free",
                                                 "unlimited": False, "price_per_operation": 50})
            if req.url.path == "/v1/speakers":
                return httpx.Response(200, json={"object": "list", "data": [{"speaker_id": "a", "samples": 1}],
                                                 "has_more": False})
            if req.url.path == "/v1/operations/op_1/feedback":
                self.assertEqual(json.loads(req.content), {"correct": False})
                self.assertIsNone(req.headers.get("idempotency-key"))
                return httpx.Response(200, json={"object": "operation.feedback", "correct": False})
            return httpx.Response(200, json={"status": "ok", "inference": "ok"})

        async def go():
            c = self._client(handler)
            try:
                return (await c.health(), await c.credits(), await c.list_speakers(),
                        await c.feedback("op_1", False))
            finally:
                await c.aclose()

        h, cr, sp, fb = run(go())
        self.assertEqual(h["status"], "ok")
        self.assertEqual(cr["available"], 1950)
        self.assertEqual(sp["data"][0]["speaker_id"], "a")
        self.assertFalse(fb["correct"])

    def test_network_error(self):
        def handler(req):
            raise httpx.ConnectError("boom")

        async def go():
            c = self._client(handler)
            try:
                await c.health()
            finally:
                await c.aclose()

        with self.assertRaises(DetectifError) as cm:
            run(go())
        self.assertEqual(cm.exception.code, "network_error")
        self.assertNotIn("TESTKEY", repr(LiveClient("dtf_live_TESTKEY")))


class StoreTests(unittest.TestCase):
    def test_customer_id_validation(self):
        self.assertTrue(valid_customer_id("customer-4711"))
        self.assertTrue(valid_customer_id("a.b:c_d"))
        self.assertFalse(valid_customer_id(""))
        self.assertFalse(valid_customer_id("has space"))
        self.assertFalse(valid_customer_id("x" * 65))

    def test_upsert_merges_and_delete(self):
        with tempfile.TemporaryDirectory() as d:
            s = Store(Path(d) / "store.json")
            s.upsert_customer({"customer_id": "a", "display_name": "A", "phone_last4": "1234", "samples": 1})
            merged = s.upsert_customer({"customer_id": "a", "display_name": "A2", "phone_last4": None, "samples": 2})
            self.assertEqual(merged, {"customer_id": "a", "display_name": "A2", "phone_last4": "1234", "samples": 2})
            self.assertEqual(Store(Path(d) / "store.json").get_customer("a"), merged)
            self.assertTrue(s.delete_customer("a"))
            self.assertFalse(s.delete_customer("a"))
            self.assertEqual(s.list_customers(), [])

    def test_assessment_cap_and_order(self):
        with tempfile.TemporaryDirectory() as d:
            s = Store(Path(d) / "store.json", max_assessments=5)
            for i in range(8):
                s.add_assessment({"check_id": f"chk_{i}"})
            items = s.list_assessments(50)
            self.assertEqual([a["check_id"] for a in items], ["chk_7", "chk_6", "chk_5", "chk_4", "chk_3"])
            s2 = Store(Path(d) / "store.json")  # persisted
            self.assertEqual(len(s2.list_assessments(50)), 5)


class BroadcasterTests(unittest.TestCase):
    def test_stream_events_and_ping(self):
        async def go():
            b = Broadcaster(ping_interval=0.05)
            gen = b.stream()
            first = await gen.__anext__()
            b.publish("alert", {"x": 1})
            evt = await gen.__anext__()
            ping = await gen.__anext__()
            await gen.aclose()
            return first, evt, ping, b.subscriber_count

        first, evt, ping, count = run(go())
        self.assertIn(": connected", first)
        self.assertEqual(evt, 'event: alert\ndata: {"x":1}\n\n')
        self.assertEqual(ping, ": ping\n\n")
        self.assertEqual(count, 0)


class _AppCase(unittest.TestCase):
    """An app on a FakeClient, a temp store and no frontend."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = self.make_fake()
        self.app = create_app(client=self.fake, store_path=Path(self.tmp.name) / "store.json",
                              frontend_dir=Path(self.tmp.name) / "no-frontend")
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.events = []
        orig = self.app.state.broadcaster.publish
        self.app.state.broadcaster.publish = lambda ev, data: (self.events.append((ev, data)), orig(ev, data))

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def make_fake(self) -> FakeClient:
        return FakeClient()

    def _enroll(self, cid="ada-01", name="Ada Lovelace", wav=WAV_20S, **extra):
        data = {"customer_id": cid, "display_name": name, "phone_last4": "4711", **extra}
        return self.client.post("/api/enroll", data=data, files={"file": ("enroll.wav", wav, "audio/wav")})

    def _check(self, wav=WAV_8S, deepfake_wav=None, **fields):
        data = {"customer_id": "ada-01", "action": "fund_transfer", "amount": "50000", "call_id": "call_1",
                "trigger": "voicebot", "transcript": "transfer fifty thousand"}
        data.update(fields)
        data = {k: v for k, v in data.items() if v is not None}
        files = {"file": ("clip.wav", wav, "audio/wav")}
        if deepfake_wav is not None:
            files["deepfake_file"] = ("df.wav", deepfake_wav, "audio/wav")
        return self.client.post("/api/check", data=data, files=files)

    def assertNoMode(self, obj):
        if isinstance(obj, dict):
            self.assertNotIn("mode", obj)
            for v in obj.values():
                self.assertNoMode(v)
        elif isinstance(obj, list):
            for v in obj:
                self.assertNoMode(v)


class AppTests(_AppCase):
    def test_status(self):
        r = self.client.get("/api/status")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"credits": {"available": 5000, "price_per_operation": 50, "unlimited": False},
                                    "health": "ok", "cost_per_check": 100})

    def test_status_when_upstream_is_down(self):
        down = DetectifError(0, "network_error", "Could not reach DetectifAI (ConnectError)")
        self.fake.fail("credits", down)
        self.fake.fail("health", down)
        self.assertEqual(self.client.get("/api/status").json(),
                         {"credits": None, "health": "down", "cost_per_check": 100})

    def test_full_flow(self):
        r = self._enroll()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertNoMode(body)
        self.assertTrue(body["ok"])
        self.assertEqual(body["credits"], {"charged": 50, "balance": 4950})
        self.assertEqual(body["customer"], {"customer_id": "ada-01", "display_name": "Ada Lovelace",
                                            "phone_last4": "4711", "enrolled_at": body["customer"]["enrolled_at"],
                                            "samples": 1})
        self.assertTrue(body["request_id"].startswith("req_"))
        self.assertAlmostEqual(body["quality"]["duration_seconds"], 20.0, places=1)
        self.assertEqual(self.fake.calls[-1], ("enroll", {"speaker_id": "ada-01", "display_name": "Ada Lovelace"}))

        cust = self.client.get("/api/customers").json()["customers"]
        self.assertEqual([c["customer_id"] for c in cust], ["ada-01"])
        self.assertEqual(set(cust[0]), {"customer_id", "display_name", "phone_last4", "enrolled_at", "samples"})

        # genuine -> APPROVE (one verify call with the embedded deepfake check)
        g = self._check(amount="20000").json()
        self.assertNoMode(g)
        self.assertEqual(g["risk"]["decision"], "APPROVE")
        self.assertFalse(g["alert"]["sent"])
        self.assertEqual(g["speaker"]["decision"], "match")
        self.assertEqual(g["deepfake"]["verdict"], "real")
        self.assertEqual(g["customer_name"], "Ada Lovelace")
        self.assertEqual(g["action_label"], "Fund transfer")
        self.assertEqual(g["trigger"], "voicebot")
        self.assertEqual(g["transcript"], "transfer fifty thousand")
        self.assertEqual(g["call_id"], "call_1")
        self.assertEqual(g["credits"], {"charged": 100, "balance": 4850})
        self.assertAlmostEqual(g["audio_seconds"], 8.0)
        self.assertEqual(len(g["request_ids"]), 1)
        self.assertIsNone(g["customer_response"])
        self.assertEqual(set(g), {"check_id", "created_at", "call_id", "customer_id", "customer_name", "action",
                                  "action_label", "amount", "trigger", "transcript", "deepfake", "speaker", "risk",
                                  "alert", "credits", "request_ids", "latency_ms", "audio_seconds",
                                  "customer_response"})
        self.assertTrue(g["check_id"].startswith("chk_"))
        self.assertTrue(g["deepfake"]["operation_id"].startswith("op_"))
        self.assertEqual(self.fake.calls[-1][0], "verify")
        self.assertTrue(self.fake.calls[-1][1]["detect_deepfake"])

        # deepfake -> BLOCK + alert event payload
        self.fake.scenario = "deepfake"
        self.events.clear()
        d = self._check().json()
        self.assertEqual(d["risk"]["decision"], "BLOCK")
        self.assertEqual(d["deepfake"]["verdict"], "fake")
        self.assertTrue(d["alert"]["sent"])
        self.assertIn("₹50,000 fund transfer", d["alert"]["message"])
        self.assertEqual([e[0] for e in self.events], ["assessment", "alert"])
        self.assertEqual(self.events[0][1], d)
        self.assertEqual(set(self.events[1][1]), {"check_id", "customer_id", "customer_name", "action_label",
                                                  "amount", "decision", "message", "created_at"})

        # imposter, sim reset -> STEP_UP (62+5) ; uncertain -> STEP_UP
        self.fake.scenario = "imposter"
        i = self._check(action="sim_otp_reset", amount="").json()
        self.assertEqual(i["speaker"]["decision"], "no_match")
        self.assertEqual(i["risk"]["decision"], "STEP_UP")
        self.fake.scenario = "uncertain"
        u = self._check(action="limit_change", amount="").json()
        self.assertEqual(u["deepfake"]["verdict"], "not_sure")
        self.assertEqual(u["risk"]["decision"], "STEP_UP")

        # unknown caller -> deepfake-only
        self.fake.scenario = "genuine"
        unk = self._check(customer_id="", amount="1000").json()
        self.assertIsNone(unk["speaker"])
        self.assertIsNone(unk["customer_id"])
        self.assertIn("Caller not enrolled — identity unverified", unk["risk"]["reasons"])
        self.assertEqual(self.fake.calls[-1][0], "detect")
        self.assertEqual(unk["credits"]["charged"], 50)

        lst = self.client.get("/api/assessments?limit=50").json()["assessments"]
        self.assertEqual(len(lst), 5)
        self.assertEqual(lst[0]["check_id"], unk["check_id"])  # newest first
        self.assertEqual(len(self.client.get("/api/assessments?limit=2").json()["assessments"]), 2)

        # customer responds to the block alert
        self.events.clear()
        r = self.client.post(f"/api/alerts/{d['check_id']}/respond", json={"response": "not_me"})
        self.assertTrue(r.json()["ok"])
        sent = r.json()["auto_feedback"]
        # clone blocked + customer says "not me" -> the fake verdict was right, the voice match was wrong
        self.assertEqual(sent, [
            {"operation_id": d["deepfake"]["operation_id"], "signal": "deepfake", "correct": True, "ok": True},
            {"operation_id": d["speaker"]["operation_id"], "signal": "speaker", "correct": False, "ok": True}])
        self.assertEqual(self.fake.feedback_sent, [(d["deepfake"]["operation_id"], True),
                                                   (d["speaker"]["operation_id"], False)])
        self.assertEqual(self.events, [("customer_response", {"check_id": d["check_id"], "response": "not_me",
                                                              "created_at": self.events[0][1]["created_at"],
                                                              "auto_feedback": sent})])
        again = self.client.post(f"/api/alerts/{d['check_id']}/respond", json={"response": "not_me"}).json()
        self.assertEqual(again["auto_feedback"], sent)  # reported once, not on every tap
        self.assertEqual(len(self.fake.feedback_sent), 2)
        stored = [a for a in self.client.get("/api/assessments").json()["assessments"]
                  if a["check_id"] == d["check_id"]][0]
        self.assertEqual(stored["customer_response"]["response"], "not_me")
        self.assertEqual(stored["auto_feedback"], sent)

        self.assertEqual(self.client.post("/api/alerts/chk_nope/respond", json={"response": "me"}).status_code, 404)
        bad = self.client.post(f"/api/alerts/{d['check_id']}/respond", json={"response": "maybe"})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.json(), {"error": {"code": "invalid_response",
                                                "message": 'response must be "me" or "not_me".'}})

    def test_auto_feedback_failure_is_recorded(self):
        self._enroll()
        self.fake.scenario = "deepfake"
        d = self._check().json()
        self.fake.fail("feedback", DetectifError(404, "operation_not_found", "No such operation"))
        sent = self.client.post(f"/api/alerts/{d['check_id']}/respond", json={"response": "me"}).json()
        self.assertEqual([(f["signal"], f["correct"], f["ok"], f["error"]) for f in sent["auto_feedback"]],
                         [("deepfake", False, False, "operation_not_found"),
                          ("speaker", True, False, "operation_not_found")])

    def test_feedback_endpoint(self):
        r = self.client.post("/api/feedback", json={"operation_id": "op_123", "correct": True})
        self.assertEqual(r.json(), {"ok": True})
        self.assertEqual(self.fake.feedback_sent, [("op_123", True)])
        self.fake.fail("feedback", DetectifError(404, "operation_not_found", "No such operation"))
        r = self.client.post("/api/feedback", json={"operation_id": "op_x", "correct": False})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json(), {"ok": False, "error": {"code": "operation_not_found",
                                                           "message": "No such operation"}})
        self.fake.fail("feedback", DetectifError(0, "network_error", "Could not reach DetectifAI"))
        r = self.client.post("/api/feedback", json={"operation_id": "op_x", "correct": False})
        self.assertEqual(r.status_code, 502)
        self.assertEqual(r.json()["error"]["code"], "upstream_error")
        self.assertEqual(self.client.post("/api/feedback", json={"correct": True}).status_code, 400)

    def test_check_passphrase_with_separate_deepfake_clip(self):
        self.assertEqual(self._enroll().status_code, 200)
        # a 3 s passphrase is too short for the deepfake check on its own, fine with a separate natural clip
        r = self._check(wav=WAV_3S, deepfake_wav=WAV_8S)
        self.assertEqual(r.status_code, 200, r.text)
        a = r.json()
        self.assertEqual(a["speaker"]["decision"], "match")
        self.assertEqual(a["deepfake"]["verdict"], "real")
        self.assertEqual(len(a["request_ids"]), 2)
        self.assertEqual(a["credits"], {"charged": 100, "balance": 4850})
        self.assertAlmostEqual(a["audio_seconds"], 3.0)
        (v_name, v), (d_name, d) = self.fake.calls[-2:]
        self.assertEqual((v_name, v["detect_deepfake"], v["size"]), ("verify", False, len(WAV_3S)))
        self.assertEqual((d_name, d["size"]), ("detect", len(WAV_8S)))
        # without the separate clip the same passphrase is rejected as too short
        self.assertEqual(self._check(wav=WAV_3S).json()["error"]["code"], "audio_too_short")
        # the deepfake clip itself must be longer than 4 s
        r = self._check(wav=WAV_3S, deepfake_wav=WAV_3S)
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"]["code"], "audio_too_short")
        self.assertEqual(self.fake.paid_calls, 3)  # enroll + verify + detect; rejected clips cost nothing

    def test_split_check_when_passphrase_cannot_be_verified(self):
        self._enroll()
        self.fake.fail("verify", DetectifError(422, "too_little_speech", "Need 2 s of speech", request_id="req_v"))
        a = self._check(wav=WAV_3S, deepfake_wav=WAV_8S).json()
        self.assertIsNone(a["speaker"])
        self.assertEqual(a["deepfake"]["verdict"], "real")
        self.assertEqual(a["request_ids"][0], "req_v")
        self.assertTrue(any(r.startswith("Passphrase too short to verify") for r in a["risk"]["reasons"]))
        self.assertNotEqual(a["risk"]["decision"], "APPROVE")
        self.fake.fail("verify", None)
        self.fake.speakers.clear()  # voiceprint gone at DetectifAI
        a = self._check(wav=WAV_3S, deepfake_wav=WAV_8S).json()
        self.assertIsNone(a["speaker"])
        self.assertIn("Customer voiceprint not found at DetectifAI — identity unverified", a["risk"]["reasons"])
        self.fake.fail("verify", DetectifError(503, "inference_overloaded", "busy"))
        r = self._check(wav=WAV_3S, deepfake_wav=WAV_8S)
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"]["code"], "upstream_busy")

    def test_unenrolled_split_check_is_deepfake_only(self):
        a = self._check(customer_id="stranger-9", wav=WAV_3S, deepfake_wav=WAV_8S).json()
        self.assertIsNone(a["speaker"])
        self.assertIsNone(a["customer_name"])
        self.assertEqual([c[0] for c in self.fake.calls if c[0] in ("verify", "detect")], ["detect"])

    def test_enrolled_here_but_missing_upstream(self):
        self._enroll()
        self.fake.speakers.clear()
        a = self._check().json()
        self.assertIsNone(a["speaker"])
        self.assertEqual(a["deepfake"]["verdict"], "real")
        self.assertIn("Customer voiceprint not found at DetectifAI — identity unverified", a["risk"]["reasons"])
        self.assertEqual([c[0] for c in self.fake.calls[-2:]], ["verify", "detect"])

    def test_trigger(self):
        self._enroll()
        self.assertEqual(self._check(trigger=None).json()["trigger"], "voicebot")
        self.assertEqual(self._check(trigger="manual").json()["trigger"], "manual")
        self.assertEqual(self._check(trigger="keyword").json()["trigger"], "voicebot")

    def test_delete_customer(self):
        self.assertEqual(self._enroll().status_code, 200)
        r = self.client.delete("/api/customers/ada-01")
        self.assertEqual(r.json(), {"ok": True, "customer_id": "ada-01", "removed_local": True})
        self.assertNotIn("ada-01", self.fake.speakers)
        self.assertEqual(self.client.get("/api/customers").json()["customers"], [])
        # deleting again is fine (already gone at DetectifAI and here)
        self.assertEqual(self.client.delete("/api/customers/ada-01").json()["removed_local"], False)
        self.assertEqual(self.client.delete("/api/customers/bad id!").status_code, 400)
        self.fake.fail("delete_speaker", DetectifError(503, "inference_overloaded", "busy"))
        self._enroll()
        self.assertEqual(self.client.delete("/api/customers/ada-01").status_code, 503)
        self.assertEqual(len(self.client.get("/api/customers").json()["customers"]), 1)  # kept locally

    def test_validation_errors(self):
        self._enroll()
        short = self.client.post("/api/check", data={"customer_id": "ada-01", "action": "fund_transfer"},
                                 files={"file": ("c.wav", WAV_3S, "audio/wav")})
        self.assertEqual(short.status_code, 422)
        self.assertEqual(short.json()["error"]["code"], "audio_too_short")
        self.assertEqual(short.json()["error"]["audio_seconds"], 3.0)
        bad_action = self._check(action="wire_money")
        self.assertEqual(bad_action.status_code, 400)
        self.assertEqual(bad_action.json()["error"]["code"], "invalid_action")
        self.assertEqual(self._check(customer_id="bad id!").json()["error"]["code"], "invalid_customer_id")
        self.assertEqual(self._check(amount="lots").json()["error"]["code"], "invalid_amount")
        self.assertEqual(self._check(amount="-5").json()["error"]["code"], "invalid_amount")
        self.assertEqual(self._check(amount="₹1,500").json()["amount"], 1500)
        empty = self._check(wav=b"")
        self.assertEqual(empty.json()["error"]["code"], "empty_file")
        missing = self.client.post("/api/check", data={"action": "fund_transfer"})
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.json()["error"]["code"], "invalid_request")
        self.assertNoMode(missing.json())
        short_enroll = self._enroll(cid="bob", wav=WAV_8S)
        self.assertEqual(short_enroll.json()["error"]["code"], "audio_too_short")
        long_enroll = self._enroll(cid="bob", wav=make_sine_wav(61.0))
        self.assertEqual(long_enroll.json()["error"]["code"], "audio_too_long")
        bad_phone = self._enroll(cid="bob", phone_last4="12a")
        self.assertEqual(bad_phone.json()["error"]["code"], "invalid_phone_last4")
        self.assertEqual(self._enroll(cid="bad id!").json()["error"]["code"], "invalid_customer_id")

    def test_not_enrolled_customer_is_deepfake_only(self):
        self.fake.scenario = "deepfake"
        r = self._check(customer_id="stranger-9").json()
        self.assertIsNone(r["speaker"])
        self.assertEqual(r["risk"]["decision"], "BLOCK")

    def test_missing_frontend_is_404_not_crash(self):
        self.assertEqual(self.client.get("/").status_code, 404)

    def test_credit_guard_refuses_below_100(self):
        self._enroll()
        self.fake.available = 90
        self.app.state.upstream.note_balance(90)
        paid = self.fake.paid_calls
        r = self._check()
        self.assertEqual(r.status_code, 402)
        self.assertEqual(r.json()["error"]["code"], "insufficient_credits")
        self.assertEqual((r.json()["error"]["available"], r.json()["error"]["required"]), (90, 100))
        self.assertEqual(self.fake.paid_calls, paid)

    def test_enroll_credit_guard(self):
        self.fake.available = 40
        r = self._enroll()
        self.assertEqual(r.status_code, 402)
        self.assertEqual(self.fake.paid_calls, 0)
        self.assertEqual(self.client.get("/api/customers").json()["customers"], [])

    def test_credit_guard_fails_closed_when_balance_unknown(self):
        self.fake.fail("credits", DetectifError(0, "network_error", "down"))
        r = self._check(customer_id="")
        self.assertEqual(r.status_code, 502)
        self.assertIn("not spending credits", r.json()["error"]["message"])
        self.assertEqual(self.fake.paid_calls, 0)

    def test_upstream_402_maps_and_updates_balance(self):
        self.fake.fail("detect", DetectifError(402, "insufficient_credits", "Not enough credits",
                                               request_id="req_402", credits={"available": 20, "required": 50}))
        r = self._check(customer_id="")
        self.assertEqual(r.status_code, 402)
        self.assertEqual(r.json()["error"], {"code": "insufficient_credits", "available": 20, "request_id": "req_402",
                                             "message": "DetectifAI: not enough credits for this operation."})
        self.assertEqual(self.client.get("/api/status").json()["credits"]["available"], 20)

    def test_verify_upstream_error_maps(self):
        self._enroll()
        self.fake.fail("verify", DetectifError(422, "too_little_speech", "Need 2 s of speech", request_id="r"))
        r = self._check()
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"], {"code": "too_little_speech", "message": "DetectifAI: Need 2 s of speech",
                                             "request_id": "r"})
        self.fake.fail("verify", DetectifError(429, "rate_limited", "slow down"))
        self.assertEqual(self._check().json()["error"]["code"], "rate_limited")

    def test_verify_error_with_partial_deepfake(self):
        self._enroll()
        self.fake.fail("verify", DetectifError(503, "inference_overloaded", "busy", request_id="req_503",
                                               partial=ERR_503_PARTIAL["partial"]))
        a = self._check().json()
        self.assertIsNone(a["speaker"])
        self.assertEqual(a["deepfake"]["verdict"], "real")
        self.assertEqual(a["credits"], {"charged": 50, "balance": 4850})
        self.assertEqual(a["request_ids"], ["req_503"])
        self.assertTrue(any("Voice verification failed" in r for r in a["risk"]["reasons"]))
        self.assertEqual(a["risk"]["decision"], "STEP_UP")

    def test_embedded_deepfake_error_adds_reason(self):
        self._enroll()
        resp = copy.deepcopy(VERIFY_OK)
        resp["deepfake"] = {"error": {"type": "unprocessable_audio", "code": "audio_too_short",
                                      "message": "Audio must be longer than 4 seconds"}, "operation_id": "op_df"}
        self.fake.respond("verify", resp)
        a = self._check().json()
        self.assertIsNone(a["deepfake"])
        self.assertTrue(a["risk"]["reasons"][0].startswith("Deepfake check unavailable (audio_too_short)"))
        self.assertEqual(a["credits"]["charged"], 50)
        self.assertEqual(a["risk"]["decision"], "STEP_UP")  # fail closed: no deepfake verdict never approves


class AppSpeakerSyncTests(_AppCase):
    def make_fake(self):
        return FakeClient(available=1000, speakers=[{"speaker_id": "customer-4711", "display_name": "Ada",
                                                     "samples": 2, "created_at": "2026-10-13T09:30:00Z"},
                                                    {"speaker_id": "bad id!", "samples": 1}])

    def test_sync_and_accounting(self):
        cust = self.client.get("/api/customers").json()["customers"]
        self.assertEqual(cust, [{"customer_id": "customer-4711", "display_name": "Ada", "phone_last4": None,
                                 "enrolled_at": "2026-10-13T09:30:00Z", "samples": 2}])
        a = self._check(customer_id="customer-4711").json()
        self.assertEqual(a["speaker"]["decision"], "match")
        self.assertEqual(a["customer_name"], "Ada")
        self.assertEqual(a["credits"], {"charged": 100, "balance": 900})
        # the balance from the response updates the cached status without another /v1/credits call
        calls_before = self.fake.credit_calls
        self.assertEqual(self.client.get("/api/status").json()["credits"]["available"], 900)
        self.assertEqual(self.fake.credit_calls, calls_before)
        # the speaker list is cached (free call, but not on every page load)
        self.client.get("/api/customers")
        self.assertEqual(sum(1 for c in self.fake.calls if c[0] == "list_speakers"), 1)

    def test_sync_failure_is_ignored(self):
        self.fake.fail("list_speakers", DetectifError(0, "network_error", "down"))
        self.assertEqual(self.client.get("/api/customers").json(), {"customers": []})


class CreateAppTests(unittest.TestCase):
    def setUp(self):
        self.saved = os.environ.pop("DETECTIF_API_KEY", None)

    def tearDown(self):
        os.environ.pop("DETECTIF_API_KEY", None)
        if self.saved is not None:
            os.environ["DETECTIF_API_KEY"] = self.saved

    def test_missing_api_key_is_a_clear_error(self):
        with self.assertRaises(RuntimeError) as cm:
            create_app()
        self.assertIn("DETECTIF_API_KEY", str(cm.exception))

    def test_module_app_is_built_lazily(self):
        self.assertNotIn("app", vars(app_module))  # importing create_app built nothing
        with self.assertRaises(RuntimeError):
            app_module.app
        with self.assertRaises(AttributeError):
            app_module.nope

    def test_live_client_is_built_from_the_key(self):
        os.environ["DETECTIF_API_KEY"] = " dtf_live_TESTKEY "
        with tempfile.TemporaryDirectory() as d:
            cloner = ClonerClient("http://cloner.test")
            app = create_app(store_path=Path(d) / "s.json", cloner=cloner)
            client = app.state.upstream.client
            self.assertIsInstance(client, LiveClient)
            self.assertNotIn("TESTKEY", repr(client))
            run(client.aclose())
            run(cloner.aclose())


if __name__ == "__main__":
    unittest.main()
