"""Helpline call signaling relay (/api/call/ws). Run:  .venv/Scripts/python -m unittest -v"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ["CALLSHIELD_MODE"] = "mock"

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.app import create_app


class CallRelayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.client = TestClient(create_app(mode="mock", store_path=Path(self.tmp.name) / "store.json"))
        os.environ.pop("CALLSHIELD_CALL_CODE", None)

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()
        os.environ.pop("CALLSHIELD_CALL_CODE", None)

    def ws(self, role, code=""):
        q = f"role={role}" + (f"&code={code}" if code else "")
        return self.client.websocket_connect(f"/api/call/ws?{q}")

    def test_dial_without_agent(self):
        with self.ws("caller") as c:
            self.assertEqual(c.receive_json()["type"], "hello")
            c.send_json({"type": "dial", "customer_id": "cust-a"})
            self.assertEqual(c.receive_json()["type"], "no_agent")

    def test_full_call_flow(self):
        with self.ws("agent") as a, self.ws("caller") as c:
            a.receive_json(); c.receive_json()  # hello
            c.send_json({"type": "dial", "customer_id": "cust-a", "display_name": "Asha"})
            self.assertEqual(c.receive_json()["type"], "ringing")
            inc = a.receive_json()
            self.assertEqual((inc["type"], inc["customer_id"], inc["display_name"]), ("incoming", "cust-a", "Asha"))

            a.send_json({"type": "accept", "caller_id": inc["caller_id"]})
            self.assertEqual(c.receive_json()["type"], "accepted")

            c.send_json({"type": "signal", "data": {"sdp": {"type": "offer", "sdp": "x"}}})
            self.assertEqual(a.receive_json(), {"type": "signal", "data": {"sdp": {"type": "offer", "sdp": "x"}}})
            a.send_json({"type": "signal", "data": {"ice": {"candidate": "y"}}})
            self.assertEqual(c.receive_json()["data"], {"ice": {"candidate": "y"}})

            c.send_json({"type": "transcript", "text": "please transfer fifty thousand", "final": True})
            self.assertEqual(a.receive_json(), {"type": "transcript", "text": "please transfer fifty thousand", "final": True})

            c.send_json({"type": "hangup"})
            self.assertEqual(a.receive_json()["type"], "hangup")

    def test_agent_joining_late_sees_ringing_call_and_cancel(self):
        with self.ws("agent") as a1, self.ws("caller") as c:
            a1.receive_json(); c.receive_json()
            c.send_json({"type": "dial"})
            c.receive_json(); a1.receive_json()
            with self.ws("agent") as a2:
                self.assertEqual(a2.receive_json()["type"], "incoming")  # ringing calls replay on join
                self.assertEqual(a2.receive_json()["type"], "hello")
            c.send_json({"type": "hangup"})
            self.assertEqual(a1.receive_json()["type"], "cancel")

    def test_second_agent_gets_taken(self):
        with self.ws("agent") as a1, self.ws("agent") as a2, self.ws("caller") as c:
            a1.receive_json(); a2.receive_json(); c.receive_json()
            c.send_json({"type": "dial"})
            c.receive_json()
            inc = a1.receive_json(); a2.receive_json()
            a1.send_json({"type": "accept", "caller_id": inc["caller_id"]})
            self.assertEqual(c.receive_json()["type"], "accepted")
            self.assertEqual(a2.receive_json(), {"type": "taken", "caller_id": inc["caller_id"]})

    def test_access_code(self):
        os.environ["CALLSHIELD_CALL_CODE"] = "s3cret"
        with self.assertRaises(WebSocketDisconnect) as cm:
            with self.ws("caller", code="nope") as c:
                c.receive_json()
        self.assertEqual(cm.exception.code, 4401)
        with self.ws("caller", code="s3cret") as c:
            self.assertEqual(c.receive_json()["type"], "hello")


if __name__ == "__main__":
    unittest.main()
