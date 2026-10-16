"""CallShield backend (FastAPI). See CONTRACT.md section "CallShield backend API".

Run from the project root:
    .venv/Scripts/python -m uvicorn backend.app:app --port 8000
Mode = mock if CALLSHIELD_MODE=mock or no DETECTIF_API_KEY, else live.
"""
from __future__ import annotations

import asyncio
import math
import os
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.staticfiles import StaticFiles

from . import attack, risk
from .public_limit import PublicLimiter
from .audio import wav_duration
from .detectif import (MOCK_SCENARIOS, PRICE_PER_OPERATION, DetectifError, LiveClient, MockClient,
                       normalize_detect, normalize_verify, normalize_verify_error)
from .events import PING_INTERVAL, Broadcaster
from .store import Store, valid_customer_id

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")  # does not override variables already set in the environment

COST_PER_CHECK = 2 * PRICE_PER_OPERATION      # verify + deepfake
MIN_CHECK_BALANCE = 100
MIN_ENROLL_BALANCE = PRICE_PER_OPERATION
CREDITS_TTL = 30.0
HEALTH_TTL = 30.0
SPEAKERS_TTL = 60.0
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MIN_VERIFY_SECONDS = 3.5     # DetectifAI verify needs 3-60 s
MIN_DEEPFAKE_SECONDS = 4.0   # deepfake check needs MORE than 4 s
MAX_VERIFY_SECONDS = 60.0
MAX_DETECT_SECONDS = 120.0
ENROLL_MIN_SECONDS = 15.0
ENROLL_MAX_SECONDS = 60.0
TRIGGERS = ("manual", "keyword", "upload")


def detect_mode() -> str:
    key = (os.getenv("DETECTIF_API_KEY") or "").strip()
    if (os.getenv("CALLSHIELD_MODE") or "").strip().lower() == "mock" or not key:
        return "mock"
    return "live"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def upstream_to_api_error(e: DetectifError) -> ApiError:
    extra = {"request_id": e.request_id} if e.request_id else {}
    if e.status == 402:
        avail = (e.credits or {}).get("available")
        return ApiError(402, "insufficient_credits", "DetectifAI: not enough credits for this operation.",
                        available=avail, **extra)
    if e.status in (400, 413, 415, 422):
        return ApiError(e.status, e.code, f"DetectifAI: {e.message}", **extra)
    if e.status == 429:
        return ApiError(429, "rate_limited", "DetectifAI rate limit reached; try again in a moment.", **extra)
    if e.status == 503:
        return ApiError(503, "upstream_busy", "DetectifAI is busy; try again in a moment.", **extra)
    if e.status in (401, 403):
        return ApiError(502, "upstream_error", f"DetectifAI rejected the request ({e.code}).", **extra)
    if e.status == 0:
        return ApiError(502, "upstream_error", e.message, **extra)
    return ApiError(502, "upstream_error", f"DetectifAI error {e.status} ({e.code}): {e.message}", **extra)


class Upstream:
    """Mode, client and the cached free calls (credits / health / speakers)."""

    def __init__(self, mode: str, client):
        self.mode = mode
        self.client = client
        self.lock = asyncio.Lock()  # serialises paid live calls so the credit guard can't be raced
        self._credits: Optional[dict] = None
        self._credits_at = 0.0
        self._health: Optional[str] = None
        self._health_at = 0.0
        self._speakers_at = 0.0

    async def get_credits(self, force: bool = False) -> dict:
        if not force and self._credits is not None and time.monotonic() - self._credits_at < CREDITS_TTL:
            return self._credits
        resp = await self.client.credits()
        self._credits = {
            "available": resp.get("available"),
            "price_per_operation": resp.get("price_per_operation", PRICE_PER_OPERATION),
            "unlimited": bool(resp.get("unlimited")),
        }
        self._credits_at = time.monotonic()
        return self._credits

    def note_balance(self, balance: Optional[int]) -> None:
        if balance is None:
            return
        if self._credits is None:
            self._credits = {"available": balance, "price_per_operation": PRICE_PER_OPERATION, "unlimited": False}
        else:
            self._credits["available"] = balance
        self._credits_at = time.monotonic()

    async def ensure_credits(self, needed: int) -> None:
        try:
            c = await self.get_credits()
        except DetectifError as e:
            raise ApiError(502, "upstream_error",
                           f"Could not check the DetectifAI credit balance ({e.code}); not spending credits.") from None
        if c.get("unlimited"):
            return
        available = c.get("available") or 0
        if available < needed:
            raise ApiError(402, "insufficient_credits",
                           f"Only {available} DetectifAI credits left; this needs {needed}. "
                           "Run in mock mode (CALLSHIELD_MODE=mock) to keep demoing.",
                           available=available, required=needed)

    async def get_health(self) -> str:
        if self._health is not None and time.monotonic() - self._health_at < HEALTH_TTL:
            return self._health
        try:
            resp = await self.client.health()
            self._health = "ok" if resp.get("status") == "ok" else "down"
        except DetectifError:
            self._health = "down"
        self._health_at = time.monotonic()
        return self._health

    def speakers_stale(self) -> bool:
        return time.monotonic() - self._speakers_at >= SPEAKERS_TTL

    def mark_speakers_synced(self) -> None:
        self._speakers_at = time.monotonic()


class LazyStatic:
    """Serve ../frontend at "/" (html=True). Missing directory -> 404 instead of a crash."""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self._static: Optional[StaticFiles] = None

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not self.directory.is_dir():
            resp = JSONResponse({"error": {"code": "not_found", "message": "frontend/ not found"}}, status_code=404)
            await resp(scope, receive, send)
            return
        if self._static is None:
            self._static = StaticFiles(directory=str(self.directory), html=True)
        await self._static(scope, receive, send)


class FeedbackBody(BaseModel):
    operation_id: str
    correct: bool


class RespondBody(BaseModel):
    response: str


def _public_customer(c: dict) -> dict:
    return {
        "customer_id": c.get("customer_id"),
        "display_name": c.get("display_name"),
        "phone_last4": c.get("phone_last4"),
        "enrolled_at": c.get("enrolled_at"),
        "samples": c.get("samples"),
        "mode": c.get("mode"),
    }


def _parse_amount(raw: Optional[str]):
    if raw is None or str(raw).strip() == "":
        return None
    text = str(raw).strip().replace(",", "").replace("₹", "").replace("INR", "").strip()
    try:
        value = float(text)
    except ValueError:
        raise ApiError(400, "invalid_amount", "amount must be a number (INR).") from None
    if not math.isfinite(value) or value < 0:
        raise ApiError(400, "invalid_amount", "amount must be a non-negative number (INR).")
    return int(value) if value.is_integer() else round(value, 2)


async def _read_upload(file: UploadFile) -> bytes:
    data = await file.read()
    if not data:
        raise ApiError(400, "empty_file", "The uploaded audio file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ApiError(413, "file_too_large", "Audio upload is larger than 25 MB.")
    return data


def create_app(mode: Optional[str] = None, client=None, store_path=None, frontend_dir=None,
               ping_interval: float = PING_INTERVAL, cloner=None) -> FastAPI:
    mode = mode or detect_mode()
    owns_client = client is None
    owns_cloner = cloner is None
    if cloner is None:
        cloner = attack.ClonerClient()  # Attack Lab (laptop-only) -> local voice-cloning service
    if client is None:
        if mode == "live":
            client = LiveClient(os.environ["DETECTIF_API_KEY"].strip(),
                                base_url=os.getenv("DETECTIF_BASE_URL") or None)
        else:
            client = MockClient()
    data_dir = Path(os.getenv("CALLSHIELD_DATA_DIR") or (ROOT / "data"))
    store = Store(store_path or (data_dir / "store.json"))
    upstream = Upstream(mode, client)
    broadcaster = Broadcaster(ping_interval=ping_interval)

    @asynccontextmanager
    async def lifespan(_app):
        yield
        if owns_client:
            await client.aclose()
        if owns_cloner:
            await cloner.aclose()

    app = FastAPI(title="CallShield", version="1.0", lifespan=lifespan)
    app.state.mode = mode
    app.state.store = store
    app.state.upstream = upstream
    app.state.broadcaster = broadcaster
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    # ---- error envelopes ------------------------------------------------
    @app.exception_handler(ApiError)
    async def _api_error(_req, exc: ApiError):
        body = {"code": exc.code, "message": exc.message}
        body.update({k: v for k, v in exc.extra.items() if v is not None})
        return JSONResponse({"error": body, "mode": mode}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req, exc: RequestValidationError):
        parts = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err.get("loc", ()) if x not in ("body", "query", "path"))
            parts.append(f"{loc}: {err.get('msg')}" if loc else str(err.get("msg")))
        return JSONResponse({"error": {"code": "invalid_request", "message": "; ".join(parts) or "Invalid request"},
                             "mode": mode}, status_code=400)

    @app.exception_handler(Exception)
    async def _unhandled(_req, exc: Exception):
        return JSONResponse({"error": {"code": "internal_error", "message": f"Internal error ({type(exc).__name__})"},
                             "mode": mode}, status_code=500)

    # ---- helpers --------------------------------------------------------
    public_limiter = PublicLimiter()

    def is_enrolled(customer: Optional[dict]) -> bool:
        return customer is not None and (mode == "mock" or customer.get("mode") == "live")

    async def sync_live_speakers() -> None:
        """Live mode: pull enrolled speakers from DetectifAI (free) so a wiped store self-heals."""
        if mode != "live" or not upstream.speakers_stale():
            return
        upstream.mark_speakers_synced()
        try:
            resp = await client.list_speakers()
        except DetectifError:
            return
        for sp in resp.get("data") or []:
            sid = sp.get("speaker_id")
            if not sid or not valid_customer_id(sid):
                continue
            existing = store.get_customer(sid)
            if existing and existing.get("mode") == "live" and existing.get("samples") == sp.get("samples"):
                continue
            store.upsert_customer({
                "customer_id": sid,
                "display_name": (existing or {}).get("display_name") or sp.get("display_name") or sid,
                "phone_last4": (existing or {}).get("phone_last4"),
                "enrolled_at": (existing or {}).get("enrolled_at") or sp.get("created_at") or now_iso(),
                "samples": sp.get("samples"),
                "mode": "live",
            })

    # ---- routes ---------------------------------------------------------
    @app.get("/api/status")
    async def status():
        credits = None
        health = "unknown"
        if mode == "live":
            try:
                c = await upstream.get_credits()
                credits = {"available": c.get("available"), "price_per_operation": c.get("price_per_operation")}
                if c.get("unlimited"):
                    credits["unlimited"] = True
            except DetectifError:
                credits = None
            health = await upstream.get_health()
        return {"mode": mode, "credits": credits, "health": health, "cost_per_check": COST_PER_CHECK}

    @app.get("/api/customers")
    async def customers():
        await sync_live_speakers()
        items = [c for c in store.list_customers() if is_enrolled(c)]
        return {"customers": [_public_customer(c) for c in items]}

    @app.post("/api/enroll")
    async def enroll(request: Request, file: UploadFile = File(...), customer_id: str = Form(...),
                     display_name: str = Form(""), phone_last4: Optional[str] = Form(None)):
        customer_id = customer_id.strip()
        if not valid_customer_id(customer_id):
            raise ApiError(400, "invalid_customer_id",
                           "customer_id must be 1-64 characters from A-Z, a-z, 0-9, '_', '.', ':' and '-'.")
        display_name = (display_name or "").strip()[:128] or customer_id
        phone_last4 = (phone_last4 or "").strip() or None
        if phone_last4 is not None and not (len(phone_last4) == 4 and phone_last4.isdigit()):
            raise ApiError(400, "invalid_phone_last4", "phone_last4 must be exactly 4 digits.")
        if mode == "live":
            ok, msg = public_limiter.check(request, "enroll")
            if not ok:
                raise ApiError(429, "public_limit", msg)
        data = await _read_upload(file)
        dur = wav_duration(data)
        if dur is not None and dur < ENROLL_MIN_SECONDS:
            raise ApiError(422, "audio_too_short",
                           f"Enrollment needs 15–60 s of audio with at least 10 s of speech; got {dur:.1f} s.",
                           audio_seconds=round(dur, 2))
        if dur is not None and dur > ENROLL_MAX_SECONDS:
            raise ApiError(422, "audio_too_long", f"Enrollment audio must be at most 60 s; got {dur:.1f} s.",
                           audio_seconds=round(dur, 2))

        async def _call():
            try:
                return await client.enroll(data, file.filename, file.content_type, customer_id, display_name)
            except DetectifError as e:
                if e.status == 402 and e.credits:
                    upstream.note_balance(e.credits.get("available"))
                raise upstream_to_api_error(e) from None

        if mode == "live":
            async with upstream.lock:
                await upstream.ensure_credits(MIN_ENROLL_BALANCE)
                resp = await _call()
        else:
            resp = await _call()

        credits = None
        if mode == "live" and isinstance(resp.get("credits"), dict):
            credits = {"charged": resp["credits"].get("charged"), "balance": resp["credits"].get("balance")}
            upstream.note_balance(credits["balance"])
        speaker = resp.get("speaker") or {}
        existing = store.get_customer(customer_id)
        customer = store.upsert_customer({
            "customer_id": customer_id,
            "display_name": display_name,
            "phone_last4": phone_last4,
            "enrolled_at": (existing or {}).get("enrolled_at") if is_enrolled(existing) else now_iso(),
            "samples": speaker.get("samples") or ((existing or {}).get("samples") or 0) + 1,
            "mode": mode,
        })
        upstream.mark_speakers_synced()
        quality = resp.get("quality") or {}
        return {
            "ok": True,
            "mode": mode,
            "customer": _public_customer(customer),
            "quality": {"speech_seconds": quality.get("speech_seconds"),
                        "duration_seconds": quality.get("duration_seconds")},
            "credits": credits,
            "request_id": resp.get("request_id"),
        }

    @app.post("/api/check")
    async def check(request: Request, file: UploadFile = File(...), customer_id: str = Form(""),
                    action: str = Form(...), amount: Optional[str] = Form(None), call_id: str = Form(""),
                    trigger: str = Form("manual"), transcript: Optional[str] = Form(None),
                    mock_scenario: Optional[str] = Form(None)):
        customer_id = (customer_id or "").strip()
        if customer_id and not valid_customer_id(customer_id):
            raise ApiError(400, "invalid_customer_id",
                           "customer_id must be 1-64 characters from A-Z, a-z, 0-9, '_', '.', ':' and '-'.")
        action = (action or "").strip()
        if action not in risk.ACTIONS:
            raise ApiError(400, "invalid_action", f"action must be one of {', '.join(risk.ACTIONS)}.")
        amount_value = _parse_amount(amount)
        trigger = (trigger or "manual").strip()
        if trigger not in TRIGGERS:
            trigger = "manual"
        scenario = None
        if mode == "mock":
            scenario = (mock_scenario or "").strip() or "genuine"
            if scenario not in MOCK_SCENARIOS:
                raise ApiError(400, "invalid_mock_scenario",
                               f"mock_scenario must be one of {', '.join(MOCK_SCENARIOS)}.")

        data = await _read_upload(file)
        customer = store.get_customer(customer_id) if customer_id else None
        enrolled = is_enrolled(customer)

        dur = wav_duration(data)
        if dur is not None:
            min_needed = max(MIN_DEEPFAKE_SECONDS, MIN_VERIFY_SECONDS if enrolled else 0.0)
            if dur <= min_needed:
                raise ApiError(422, "audio_too_short",
                               f"Clip is {dur:.1f} s; the deepfake check needs more than {min_needed:g} s of audio "
                               "(send 5–20 s).", audio_seconds=round(dur, 2))
            max_allowed = MAX_VERIFY_SECONDS if enrolled else MAX_DETECT_SECONDS
            if dur > max_allowed:
                raise ApiError(422, "audio_too_long", f"Clip is {dur:.1f} s; send at most {max_allowed:g} s "
                               "(5–20 s recommended).", audio_seconds=round(dur, 2))

        if mode == "live":
            ok, msg = public_limiter.check(request, "check")
            if not ok:
                raise ApiError(429, "public_limit", msg)
        fname, ctype = file.filename or "clip.wav", file.content_type or "audio/wav"
        request_ids: list[str] = []
        notes: dict = {}

        async def _run() -> dict:
            if enrolled:
                try:
                    resp = await client.verify(data, fname, ctype, customer_id, detect_deepfake=True,
                                               scenario=scenario)
                    out = normalize_verify(resp)
                    request_ids.append(out["request_id"])
                    return out
                except DetectifError as e:
                    if e.request_id:
                        request_ids.append(e.request_id)
                    out = normalize_verify_error(e)
                    if out is not None:  # verification failed, deepfake completed (partial)
                        notes["speaker_note"] = f"Voice verification failed ({e.code}) — identity unverified"
                        return out
                    if e.status == 404 and e.code == "speaker_not_found":
                        notes["speaker_note"] = ("Customer voiceprint not found at DetectifAI — "
                                                 "identity unverified")
                    else:
                        raise
            resp = await client.detect(data, fname, ctype, scenario=scenario)
            out = normalize_detect(resp)
            request_ids.append(out["request_id"])
            return out

        t0 = time.perf_counter()
        try:
            if mode == "live":
                async with upstream.lock:
                    await upstream.ensure_credits(MIN_CHECK_BALANCE)
                    out = await _run()
            else:
                out = await _run()
        except DetectifError as e:
            if e.status == 402 and e.credits:
                upstream.note_balance(e.credits.get("available"))
            raise upstream_to_api_error(e) from None
        latency_ms = int((time.perf_counter() - t0) * 1000)

        deepfake_note = None
        if out["deepfake"] is None and out.get("deepfake_error"):
            err = out["deepfake_error"]
            deepfake_note = f"Deepfake check unavailable ({err['code']}): {err['message']}"
        assessment_risk = risk.assess(out["deepfake"], out["speaker"], action, amount_value,
                                      speaker_note=notes.get("speaker_note"), deepfake_note=deepfake_note)
        alert = risk.build_alert(assessment_risk["decision"], action, amount_value)

        credits = None
        if mode == "live":
            credits = {"charged": out["charged"], "balance": out["balance"]}
            upstream.note_balance(out["balance"])

        audio_seconds = round(dur, 2) if dur is not None else out.get("duration_seconds")
        assessment = {
            "check_id": f"chk_{uuid.uuid4().hex[:16]}",
            "mode": mode,
            "created_at": now_iso(),
            "call_id": (call_id or "").strip() or None,
            "customer_id": customer_id or None,
            "customer_name": (customer or {}).get("display_name") if customer else None,
            "action": action,
            "action_label": risk.action_label(action),
            "amount": amount_value,
            "trigger": trigger,
            "transcript": (transcript or "").strip() or None,
            "deepfake": out["deepfake"],
            "speaker": out["speaker"],
            "risk": assessment_risk,
            "alert": alert,
            "credits": credits,
            "request_ids": [r for r in request_ids if r],
            "latency_ms": latency_ms,
            "audio_seconds": audio_seconds,
            "customer_response": None,
        }
        if mode == "mock":
            assessment["mock_scenario"] = scenario
        store.add_assessment(assessment)
        broadcaster.publish("assessment", assessment)
        if alert["sent"]:
            broadcaster.publish("alert", {
                "check_id": assessment["check_id"],
                "customer_id": assessment["customer_id"],
                "customer_name": assessment["customer_name"],
                "action_label": assessment["action_label"],
                "amount": amount_value,
                "decision": assessment_risk["decision"],
                "message": alert["message"],
                "created_at": assessment["created_at"],
                "mode": mode,
            })
        return assessment

    @app.get("/api/assessments")
    async def assessments(limit: int = Query(50)):
        limit = max(1, min(500, limit))
        return {"assessments": store.list_assessments(limit)}

    @app.get("/api/events")
    async def events():
        return StreamingResponse(broadcaster.stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                                          "Connection": "keep-alive"})

    @app.post("/api/alerts/{check_id}/respond")
    async def respond(check_id: str, body: RespondBody):
        if body.response not in ("me", "not_me"):
            raise ApiError(400, "invalid_response", 'response must be "me" or "not_me".')
        created_at = now_iso()
        updated = store.update_assessment(check_id, customer_response={"response": body.response,
                                                                       "created_at": created_at})
        if updated is None:
            raise ApiError(404, "not_found", f"No assessment with check_id {check_id}.")
        broadcaster.publish("customer_response", {"check_id": check_id, "response": body.response,
                                                  "created_at": created_at})
        return {"ok": True}

    @app.post("/api/feedback")
    async def feedback(body: FeedbackBody):
        if mode != "live":
            return {"ok": True, "mode": mode}
        if body.operation_id.startswith("mock_"):
            raise ApiError(400, "invalid_operation_id", "Cannot send feedback for a mock operation.")
        try:
            await client.feedback(body.operation_id, body.correct)
        except DetectifError as e:
            api = upstream_to_api_error(e)
            status_code = e.status if 400 <= e.status < 500 else api.status
            return JSONResponse({"ok": False, "mode": mode,
                                 "error": {"code": e.code if e.status else api.code, "message": e.message}},
                                status_code=status_code)
        return {"ok": True, "mode": mode}

    # Attack Lab (local red-team, laptop-only): /api/attack/* + a guarded /attack.html
    frontend_path = Path(frontend_dir) if frontend_dir else ROOT / "frontend"
    attack.register(app, cloner, frontend_path)

    # Static frontend LAST so /api/* routes win.
    app.mount("/", LazyStatic(frontend_path), name="frontend")
    return app


app = create_app()
