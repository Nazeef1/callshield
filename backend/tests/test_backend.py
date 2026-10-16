"""CallShield backend tests. Run from the project root:  .venv/Scripts/python -m unittest -v

No network: the live client is exercised with httpx.MockTransport; the app runs in mock mode.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ["CALLSHIELD_MODE"] = "mock"  # never let an import build a live client

import httpx
from fastapi.testclient import TestClient

from backend import risk
from backend.app import create_app
from backend.audio import make_sine_wav, wav_duration
from backend.detectif import (DetectifError, LiveClient, MockClient, normalize_detect, normalize_verify,
                              normalize_verify_error)
from backend.events import Broadcaster
from backend.store import Store, valid_customer_id

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
        self.assertEqual(r["score"], 10)

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


class AppMockModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(mode="mock", client=MockClient(latency=(0, 0), seed=1),
                              store_path=Path(self.tmp.name) / "store.json",
                              frontend_dir=Path(self.tmp.name) / "no-frontend")
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def _enroll(self, cid="ada-01", name="Ada Lovelace"):
        return self.client.post("/api/enroll", data={"customer_id": cid, "display_name": name, "phone_last4": "4711"},
                                files={"file": ("enroll.wav", WAV_20S, "audio/wav")})

    def _check(self, **fields):
        data = {"customer_id": "ada-01", "action": "fund_transfer", "amount": "50000", "call_id": "call_1",
                "trigger": "keyword", "transcript": "transfer fifty thousand"}
        data.update(fields)
        return self.client.post("/api/check", data=data, files={"file": ("clip.wav", WAV_8S, "audio/wav")})

    def test_status(self):
        r = self.client.get("/api/status")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"mode": "mock", "credits": None, "health": "unknown", "cost_per_check": 100})

    def test_full_flow(self):
        r = self._enroll()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["mode"], "mock")
        self.assertIsNone(body["credits"])
        self.assertEqual(body["customer"]["customer_id"], "ada-01")
        self.assertEqual(body["customer"]["phone_last4"], "4711")
        self.assertEqual(body["customer"]["samples"], 1)
        self.assertTrue(body["request_id"].startswith("mock_"))
        self.assertAlmostEqual(body["quality"]["duration_seconds"], 20.0, places=1)

        cust = self.client.get("/api/customers").json()["customers"]
        self.assertEqual([c["customer_id"] for c in cust], ["ada-01"])
        self.assertEqual(set(cust[0]) >= {"customer_id", "display_name", "phone_last4", "enrolled_at", "samples"}, True)

        # genuine -> APPROVE
        g = self._check(mock_scenario="genuine", amount="20000").json()
        self.assertEqual(g["mode"], "mock")
        self.assertEqual(g["risk"]["decision"], "APPROVE")
        self.assertFalse(g["alert"]["sent"])
        self.assertEqual(g["speaker"]["decision"], "match")
        self.assertEqual(g["deepfake"]["verdict"], "real")
        self.assertEqual(g["customer_name"], "Ada Lovelace")
        self.assertEqual(g["action_label"], "Fund transfer")
        self.assertIsNone(g["credits"])
        self.assertAlmostEqual(g["audio_seconds"], 8.0)
        for key in ("check_id", "mode", "created_at", "call_id", "customer_id", "customer_name", "action",
                    "action_label", "amount", "trigger", "transcript", "deepfake", "speaker", "risk", "alert",
                    "credits", "request_ids", "latency_ms", "audio_seconds"):
            self.assertIn(key, g)
        self.assertTrue(g["check_id"].startswith("chk_"))
        self.assertTrue(g["deepfake"]["operation_id"].startswith("mock_"))

        # deepfake -> BLOCK + alert event payload
        events = []
        orig = self.app.state.broadcaster.publish
        self.app.state.broadcaster.publish = lambda ev, data: (events.append((ev, data)), orig(ev, data))
        d = self._check(mock_scenario="deepfake").json()
        self.assertEqual(d["risk"]["decision"], "BLOCK")
        self.assertEqual(d["deepfake"]["verdict"], "fake")
        self.assertTrue(d["alert"]["sent"])
        self.assertIn("₹50,000 fund transfer", d["alert"]["message"])
        self.assertEqual([e[0] for e in events], ["assessment", "alert"])
        alert = events[1][1]
        self.assertEqual(set(alert), {"check_id", "customer_id", "customer_name", "action_label", "amount",
                                      "decision", "message", "created_at", "mode"})

        # imposter, sim reset -> STEP_UP (62+5) ; uncertain -> STEP_UP
        i = self._check(mock_scenario="imposter", action="sim_otp_reset", amount="").json()
        self.assertEqual(i["speaker"]["decision"], "no_match")
        self.assertEqual(i["risk"]["decision"], "STEP_UP")
        u = self._check(mock_scenario="uncertain", action="limit_change", amount="").json()
        self.assertEqual(u["deepfake"]["verdict"], "not_sure")
        self.assertEqual(u["risk"]["decision"], "STEP_UP")

        # unknown caller -> deepfake-only
        unk = self._check(customer_id="", mock_scenario="genuine", amount="1000").json()
        self.assertIsNone(unk["speaker"])
        self.assertIsNone(unk["customer_id"])
        self.assertIn("Caller not enrolled — identity unverified", unk["risk"]["reasons"])

        lst = self.client.get("/api/assessments?limit=50").json()["assessments"]
        self.assertEqual(len(lst), 5)
        self.assertEqual(lst[0]["check_id"], unk["check_id"])  # newest first
        self.assertEqual(len(self.client.get("/api/assessments?limit=2").json()["assessments"]), 2)

        # customer responds to the block alert
        events.clear()
        r = self.client.post(f"/api/alerts/{d['check_id']}/respond", json={"response": "not_me"})
        self.assertEqual(r.json(), {"ok": True})
        self.assertEqual(events[0][0], "customer_response")
        self.assertEqual(events[0][1]["response"], "not_me")
        stored = [a for a in self.client.get("/api/assessments").json()["assessments"]
                  if a["check_id"] == d["check_id"]][0]
        self.assertEqual(stored["customer_response"]["response"], "not_me")

        self.assertEqual(self.client.post("/api/alerts/chk_nope/respond", json={"response": "me"}).status_code, 404)
        bad = self.client.post(f"/api/alerts/{d['check_id']}/respond", json={"response": "maybe"})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.json()["error"]["code"], "invalid_response")

        fb = self.client.post("/api/feedback", json={"operation_id": d["deepfake"]["operation_id"], "correct": True})
        self.assertEqual(fb.json()["ok"], True)

    def test_validation_errors(self):
        self._enroll()
        short = self.client.post("/api/check", data={"customer_id": "ada-01", "action": "fund_transfer"},
                                 files={"file": ("c.wav", WAV_3S, "audio/wav")})
        self.assertEqual(short.status_code, 422)
        self.assertEqual(short.json()["error"]["code"], "audio_too_short")
        bad_action = self._check(action="wire_money")
        self.assertEqual(bad_action.status_code, 400)
        self.assertEqual(bad_action.json()["error"]["code"], "invalid_action")
        bad_id = self._check(customer_id="bad id!")
        self.assertEqual(bad_id.json()["error"]["code"], "invalid_customer_id")
        bad_amt = self._check(amount="lots")
        self.assertEqual(bad_amt.json()["error"]["code"], "invalid_amount")
        bad_sc = self._check(mock_scenario="aliens")
        self.assertEqual(bad_sc.json()["error"]["code"], "invalid_mock_scenario")
        missing = self.client.post("/api/check", data={"action": "fund_transfer"})
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.json()["error"]["code"], "invalid_request")
        short_enroll = self.client.post("/api/enroll", data={"customer_id": "bob"},
                                        files={"file": ("e.wav", WAV_8S, "audio/wav")})
        self.assertEqual(short_enroll.json()["error"]["code"], "audio_too_short")
        bad_phone = self.client.post("/api/enroll", data={"customer_id": "bob", "phone_last4": "12a"},
                                     files={"file": ("e.wav", WAV_20S, "audio/wav")})
        self.assertEqual(bad_phone.json()["error"]["code"], "invalid_phone_last4")

    def test_not_enrolled_customer_is_deepfake_only(self):
        r = self._check(customer_id="stranger-9", mock_scenario="deepfake").json()
        self.assertIsNone(r["speaker"])
        self.assertEqual(r["risk"]["decision"], "BLOCK")

    def test_missing_frontend_is_404_not_crash(self):
        self.assertEqual(self.client.get("/").status_code, 404)


class _FakeLive:
    """Stands in for LiveClient inside the app (no network) to test credit guard + accounting."""
    mode = "live"

    def __init__(self, available=1000, verify_resp=None, verify_exc=None):
        self.available = available
        self.verify_resp = verify_resp or VERIFY_OK
        self.verify_exc = verify_exc
        self.paid_calls = 0
        self.credit_calls = 0

    async def aclose(self):
        pass

    async def health(self):
        return {"status": "ok"}

    async def credits(self):
        self.credit_calls += 1
        return {"available": self.available, "reserved": 0, "plan": "free", "unlimited": False,
                "price_per_operation": 50}

    async def list_speakers(self):
        return {"data": [{"speaker_id": "customer-4711", "display_name": "Ada", "samples": 2,
                          "created_at": "2026-10-13T09:30:00Z"}]}

    async def verify(self, *a, **k):
        self.paid_calls += 1
        if self.verify_exc:
            raise self.verify_exc
        return copy.deepcopy(self.verify_resp)

    async def detect(self, *a, **k):
        self.paid_calls += 1
        return copy.deepcopy(DETECT_FAKE)

    async def enroll(self, *a, **k):
        self.paid_calls += 1
        raise AssertionError("not used")

    async def feedback(self, op, correct):
        return {"ok": True}


class AppLiveLogicTests(unittest.TestCase):
    def _app(self, fake):
        self.tmp = tempfile.TemporaryDirectory()
        app = create_app(mode="live", client=fake, store_path=Path(self.tmp.name) / "s.json",
                         frontend_dir=Path(self.tmp.name))
        c = TestClient(app)
        c.__enter__()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(c.__exit__, None, None, None)
        return c

    def _check(self, c, cid="customer-4711"):
        return c.post("/api/check", data={"customer_id": cid, "action": "fund_transfer", "amount": "50000",
                                          "mock_scenario": "deepfake"},
                      files={"file": ("clip.wav", WAV_8S, "audio/wav")})

    def test_credit_guard_refuses_below_100(self):
        fake = _FakeLive(available=90)
        c = self._app(fake)
        r = self._check(c)
        self.assertEqual(r.status_code, 402)
        self.assertEqual(r.json()["error"]["code"], "insufficient_credits")
        self.assertEqual(fake.paid_calls, 0)

    def test_live_verify_flow_sync_and_accounting(self):
        fake = _FakeLive(available=1000)
        c = self._app(fake)
        st = c.get("/api/status").json()
        self.assertEqual(st, {"mode": "live", "credits": {"available": 1000, "price_per_operation": 50},
                              "health": "ok", "cost_per_check": 100})
        # customers synced from DetectifAI speaker list
        cust = c.get("/api/customers").json()["customers"]
        self.assertEqual(cust[0]["customer_id"], "customer-4711")
        a = self._check(c).json()
        self.assertEqual(a["mode"], "live")
        self.assertNotIn("mock_scenario", a)
        self.assertEqual(a["speaker"]["decision"], "match")
        self.assertEqual(a["credits"], {"charged": 100, "balance": 4850})
        self.assertEqual(a["request_ids"], ["req_8f14e45fceea167a5a36dedd"])
        # balance from the response updates the cached status without another /v1/credits call
        calls_before = fake.credit_calls
        self.assertEqual(c.get("/api/status").json()["credits"]["available"], 4850)
        self.assertEqual(fake.credit_calls, calls_before)

    def test_verify_error_with_partial_deepfake(self):
        exc = DetectifError(503, "inference_overloaded", "busy", request_id="req_503",
                            partial=ERR_503_PARTIAL["partial"])
        fake = _FakeLive(verify_exc=exc)
        c = self._app(fake)
        c.get("/api/customers")
        a = self._check(c).json()
        self.assertIsNone(a["speaker"])
        self.assertEqual(a["deepfake"]["verdict"], "real")
        self.assertEqual(a["credits"]["charged"], 50)
        self.assertTrue(any("Voice verification failed" in r for r in a["risk"]["reasons"]))

    def test_verify_upstream_error_maps(self):
        fake = _FakeLive(verify_exc=DetectifError(422, "too_little_speech", "Need 2 s of speech", request_id="r"))
        c = self._app(fake)
        c.get("/api/customers")
        r = self._check(c)
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"]["code"], "too_little_speech")

    def test_embedded_deepfake_error_adds_reason(self):
        resp = copy.deepcopy(VERIFY_OK)
        resp["deepfake"] = {"error": {"type": "unprocessable_audio", "code": "audio_too_short",
                                      "message": "Audio must be longer than 4 seconds"}, "operation_id": "op_df"}
        c = self._app(_FakeLive(verify_resp=resp))
        c.get("/api/customers")
        a = self._check(c).json()
        self.assertIsNone(a["deepfake"])
        self.assertTrue(a["risk"]["reasons"][0].startswith("Deepfake check unavailable (audio_too_short)"))
        self.assertEqual(a["credits"]["charged"], 50)


if __name__ == "__main__":
    unittest.main()
