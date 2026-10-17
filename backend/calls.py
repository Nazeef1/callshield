"""Browser-to-browser helpline calls: WebSocket signaling relay for WebRTC.

The caller (phone app or Attack Lab) dials, every connected receive screen rings, the first agent to answer
gets the call. The server only relays setup messages (SDP offer/answer, ICE candidates) and the agent's call
state; the audio itself flows peer to peer between the two browsers.

    WS /api/call/ws?role=caller|agent[&code=...]

caller -> server : dial {customer_id, display_name} | signal {data} | hangup
agent  -> server : accept {caller_id} | decline {caller_id} | signal {data} | state {state, text?} | hangup
server -> agent  : hello {id} | incoming {caller_id, customer_id, display_name} | cancel {caller_id}
                   | taken {caller_id} | signal {data} | hangup
server -> caller : hello {id} | ringing | no_agent | accepted | declined | signal {data} | state {state, text}
                   | hangup

If CALLSHIELD_CALL_CODE is set, both sides must pass it as ?code= (closed with 4401 otherwise).
"""
from __future__ import annotations

import hmac
import os
import uuid
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

MAX_STATE = 40
MAX_STATE_TEXT = 300


class Peer:
    def __init__(self, ws: WebSocket, role: str):
        self.ws = ws
        self.role = role
        self.id = f"{role}_{uuid.uuid4().hex[:10]}"
        self.partner: Optional["Peer"] = None
        self.dial: Optional[dict] = None   # caller only: what it dialled with, while ringing / on call

    async def send(self, msg: dict) -> None:
        try:
            await self.ws.send_json(msg)
        except Exception:  # peer already gone; its own handler cleans up
            pass


class CallRelay:
    def __init__(self):
        self.agents: dict[str, Peer] = {}
        self.callers: dict[str, Peer] = {}

    def ringing(self) -> list[Peer]:
        return [c for c in self.callers.values() if c.dial and c.partner is None]

    @staticmethod
    def incoming(c: Peer) -> dict:
        return {"type": "incoming", "caller_id": c.id, **c.dial}

    async def join(self, p: Peer) -> None:
        if p.role == "agent":
            self.agents[p.id] = p
            for c in self.ringing():
                await p.send(self.incoming(c))
        else:
            self.callers[p.id] = p

    async def leave(self, p: Peer) -> None:
        if p.role == "agent":
            self.agents.pop(p.id, None)
        else:
            self.callers.pop(p.id, None)
            if p.dial and p.partner is None:
                await self.to_agents({"type": "cancel", "caller_id": p.id})
        await self.hangup(p)

    async def to_agents(self, msg: dict) -> None:
        for a in list(self.agents.values()):
            await a.send(msg)

    async def hangup(self, p: Peer) -> None:
        other = p.partner
        p.partner = None
        if p.role == "caller":
            p.dial = None
        if other is not None:
            other.partner = None
            if other.role == "caller":
                other.dial = None
            await other.send({"type": "hangup"})

    async def handle(self, p: Peer, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "signal":
            if p.partner is not None:
                await p.partner.send({"type": "signal", "data": msg.get("data")})
        elif kind == "hangup":
            if p.role == "caller" and p.dial and p.partner is None:
                await self.to_agents({"type": "cancel", "caller_id": p.id})
            await self.hangup(p)
        elif p.role == "caller":
            await self.handle_caller(p, kind, msg)
        else:
            await self.handle_agent(p, kind, msg)

    async def handle_caller(self, p: Peer, kind, msg: dict) -> None:
        if kind == "dial":
            if p.partner is not None or p.dial:
                return
            p.dial = {
                "customer_id": str(msg.get("customer_id") or "")[:64],
                "display_name": str(msg.get("display_name") or "")[:80],
            }
            if not self.agents:
                p.dial = None
                await p.send({"type": "no_agent"})
                return
            await p.send({"type": "ringing"})
            await self.to_agents(self.incoming(p))

    async def handle_agent(self, p: Peer, kind, msg: dict) -> None:
        if kind == "state":
            if p.partner is not None:
                await p.partner.send({"type": "state", "state": str(msg.get("state") or "")[:MAX_STATE],
                                      "text": str(msg.get("text") or "")[:MAX_STATE_TEXT]})
            return
        c = self.callers.get(str(msg.get("caller_id") or ""))
        if kind == "accept":
            if p.partner is not None:
                return
            if c is None or not c.dial or c.partner is not None:
                await p.send({"type": "cancel", "caller_id": msg.get("caller_id")})
                return
            p.partner, c.partner = c, p
            await c.send({"type": "accepted"})
            for a in list(self.agents.values()):
                if a is not p:
                    await a.send({"type": "taken", "caller_id": c.id})
        elif kind == "decline":
            # Only the last agent still ringing turns the call away.
            if c is not None and c.dial and c.partner is None and len(self.agents) <= 1:
                c.dial = None
                await c.send({"type": "declined"})


def register(app: FastAPI) -> None:
    relay = CallRelay()
    app.state.call_relay = relay

    @app.websocket("/api/call/ws")
    async def call_ws(ws: WebSocket, role: str = "", code: str = ""):
        expected = (os.getenv("CALLSHIELD_CALL_CODE") or "").strip()
        if role not in ("caller", "agent"):
            await ws.close(code=4400)
            return
        if expected and not hmac.compare_digest(code.encode(), expected.encode()):
            await ws.close(code=4401)
            return
        await ws.accept()
        p = Peer(ws, role)
        await relay.join(p)
        await p.send({"type": "hello", "id": p.id})
        try:
            while True:
                msg = await ws.receive_json()
                if isinstance(msg, dict):
                    await relay.handle(p, msg)
        except (WebSocketDisconnect, ValueError):
            pass
        finally:
            await relay.leave(p)
