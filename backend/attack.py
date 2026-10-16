"""Attack Lab (local red-team): clone a consenting team member's OWN voice and fire it at CallShield.

Cloning is done by a separate local service (default http://127.0.0.1:8100, env CALLSHIELD_CLONER_URL):
  GET  /health  -> {"ok", "engines": {"local": {...}, "elevenlabs": {...}}}
  POST /clone   multipart reference, text, engine, language -> audio/wav (+ X-Engine, X-Model, X-Gen-Ms)
  POST /warmup

SECURITY: the Attack Lab only works for requests made on the presenter's laptop. The app is exposed to judges
through a cloudflared tunnel, which connects from localhost, so "client host is 127.0.0.1" alone is not enough:
a request is local only if
  * env CALLSHIELD_ATTACK_LAB != "0", and
  * the TCP client is a loopback address, and
  * it carries no proxy / tunnel headers (cf-connecting-ip, cf-ray, x-forwarded-*, x-real-ip, forwarded, ...), and
  * its Host header (and Origin header, when a browser sends one) names a loopback host.
Anything else gets 403 attack_lab_disabled. Clones are streamed back to the caller and never stored server-side.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.datastructures import UploadFile

DEFAULT_CLONER_URL = "http://127.0.0.1:8100"
CLONE_TIMEOUT = 180.0
HEALTH_TIMEOUT = 2.5
MAX_TEXT_CHARS = 400
MAX_REFERENCE_BYTES = 25 * 1024 * 1024
ENGINES = ("local", "elevenlabs")
LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$")
PASSTHROUGH_HEADERS = ("X-Engine", "X-Model", "X-Gen-Ms")

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}
# Headers added by cloudflared and other reverse proxies / tunnels. Any of them => not a laptop-local request.
PROXY_HEADERS = ("cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "cf-warp-tag-id", "true-client-ip",
                 "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded")
DISABLED_MESSAGE = "The Attack Lab only runs on the presenter's laptop."
ENV_OFF_MESSAGE = "The Attack Lab is turned off (CALLSHIELD_ATTACK_LAB=0)."


class ClonerError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def lab_env_enabled() -> bool:
    return (os.getenv("CALLSHIELD_ATTACK_LAB") or "1").strip() != "0"


def lab_public() -> bool:
    """CALLSHIELD_ATTACK_LAB=public: judges may use the lab from the deployed site (mic-recorded reference only,
    consent required, rate-limited, clones never stored). Cloning still runs on the presenter's GPU laptop."""
    return (os.getenv("CALLSHIELD_ATTACK_LAB") or "").strip().lower() == "public"


def _host_only(value: str) -> str:
    """'localhost:8000' -> 'localhost', '[::1]:8000' -> '::1'."""
    value = (value or "").strip().lower()
    if value.startswith("["):
        return value[1:value.find("]")] if "]" in value else value[1:]
    if value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def access_check(request: Request) -> tuple[bool, Optional[str]]:
    """(allowed, reason). Allowed only for requests made on this machine, not through a tunnel/proxy."""
    if not lab_env_enabled():
        return False, ENV_OFF_MESSAGE
    if lab_public():
        origin = request.headers.get("origin")
        host = _host_only(request.headers.get("x-forwarded-host") or request.headers.get("host", ""))
        if origin and origin != "null" and _host_only(urlsplit(origin).netloc) != host:
            return False, "Cross-site requests to the Attack Lab are not allowed."
        return True, None
    client = request.client.host if request.client else ""
    if (client or "").lower() not in LOOPBACK_HOSTS:
        return False, DISABLED_MESSAGE
    headers = request.headers
    if any(h in headers for h in PROXY_HEADERS):
        return False, DISABLED_MESSAGE
    if _host_only(headers.get("host", "")) not in LOOPBACK_HOSTS:
        return False, DISABLED_MESSAGE
    origin = headers.get("origin")
    if origin and origin != "null":
        if _host_only(urlsplit(origin).netloc) not in LOOPBACK_HOSTS:
            return False, DISABLED_MESSAGE
    return True, None


def _forbidden(reason: Optional[str]) -> JSONResponse:
    return JSONResponse({"error": {"code": "attack_lab_disabled", "message": reason or DISABLED_MESSAGE}},
                        status_code=403, headers={"Cache-Control": "no-store"})


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status,
                        headers={"Cache-Control": "no-store"})


class ClonerClient:
    """Thin async client for the local voice-cloning service."""

    def __init__(self, base_url: Optional[str] = None, timeout: float = CLONE_TIMEOUT,
                 transport: Optional[httpx.AsyncBaseTransport] = None):
        self.base_url = (base_url or os.getenv("CALLSHIELD_CLONER_URL") or DEFAULT_CLONER_URL).rstrip("/")
        headers = {"User-Agent": "CallShield-AttackLab/1.0"}
        token = (os.getenv("CALLSHIELD_CLONER_TOKEN") or "").strip()
        if token:
            headers["X-Cloner-Token"] = token
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(timeout, connect=10.0),
                                         transport=transport, headers=headers)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _unavailable(self) -> ClonerError:
        where = "the presenter's GPU laptop" if lab_public() else self.base_url
        return ClonerError(503, "cloner_unavailable",
                           f"The voice-cloning service isn't reachable at {where}. "
                           "Start it in another terminal with .\\run_cloner.ps1 and try again.")

    async def _request(self, method: str, path: str, *, timeout: Optional[float] = None, **kw) -> httpx.Response:
        try:
            resp = await self._client.request(method, path, timeout=timeout or httpx.USE_CLIENT_DEFAULT, **kw)
        except (httpx.ConnectError, httpx.ConnectTimeout):
            raise self._unavailable() from None
        except httpx.TimeoutException:
            raise ClonerError(504, "cloner_timeout",
                              f"The voice-cloning service did not answer within {int(timeout or CLONE_TIMEOUT)} s. "
                              "The first local generation can be slow while the model loads — try Warm up first.") from None
        except httpx.HTTPError as exc:
            raise ClonerError(503, "cloner_unavailable",
                              f"Could not talk to the voice-cloning service ({type(exc).__name__}). "
                              "Is .\\run_cloner.ps1 running?") from None
        if not (200 <= resp.status_code < 300):
            raise self._error_from(resp)
        return resp

    @staticmethod
    def _error_from(resp: httpx.Response) -> ClonerError:
        code, message = f"cloner_http_{resp.status_code}", f"The voice-cloning service returned HTTP {resp.status_code}."
        try:
            body = resp.json()
        except Exception:
            body = None
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                code = str(err.get("code") or code)
                message = str(err.get("message") or message)
            elif isinstance(body.get("detail"), str):
                message = body["detail"]
        status = resp.status_code if 400 <= resp.status_code < 500 else (503 if resp.status_code == 503 else 502)
        return ClonerError(status, code, f"Cloner: {message}")

    async def health(self) -> dict:
        resp = await self._request("GET", "/health", timeout=HEALTH_TIMEOUT)
        try:
            body = resp.json()
        except Exception:
            raise ClonerError(502, "cloner_bad_response", "The voice-cloning service returned non-JSON health.") from None
        if not isinstance(body, dict):
            raise ClonerError(502, "cloner_bad_response", "The voice-cloning service returned an unexpected health shape.")
        return body

    async def warmup(self) -> tuple[int, dict]:
        resp = await self._request("POST", "/warmup")
        try:
            body = resp.json()
        except Exception:
            body = {"ok": True}
        return resp.status_code, body if isinstance(body, dict) else {"ok": True, "result": body}

    async def clone(self, reference: bytes, filename: str, content_type: str, text: str, engine: str,
                    language: str) -> httpx.Response:
        resp = await self._request("POST", "/clone",
                                   files={"reference": (filename, reference, content_type)},
                                   data={"text": text, "engine": engine, "language": language})
        ctype = resp.headers.get("content-type", "").lower()
        if not resp.content or not (ctype.startswith("audio/") or ctype.startswith("application/octet-stream")):
            raise ClonerError(502, "cloner_bad_response",
                              f"The voice-cloning service returned {ctype or 'no content type'} instead of audio.")
        return resp


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in ("true", "1", "yes", "on")


def register(app: FastAPI, cloner: ClonerClient, frontend_dir: Path) -> None:
    """Add the /api/attack/* routes and a laptop-only /attack.html. Call BEFORE mounting the static frontend."""
    from .public_limit import PublicLimiter
    clone_limiter = PublicLimiter()

    @app.get("/api/attack/status")
    async def attack_status(request: Request, probe: int = 1):
        ok, reason = access_check(request)
        if not ok:
            return JSONResponse({"enabled": False, "reason": reason, "cloner": None},
                                headers={"Cache-Control": "no-store"})
        cloner_json, cloner_error = None, None
        if probe:
            try:
                cloner_json = await cloner.health()
            except ClonerError as e:
                cloner_error = {"code": e.code, "message": e.message}
        return JSONResponse({"enabled": True, "reason": None, "cloner": cloner_json, "cloner_error": cloner_error,
                             "cloner_url": None if lab_public() else cloner.base_url,
                             "public": lab_public() and any(h in request.headers for h in PROXY_HEADERS),
                             "mode": getattr(app.state, "mode", None),
                             "max_text_chars": MAX_TEXT_CHARS},
                            headers={"Cache-Control": "no-store"})

    @app.post("/api/attack/warmup")
    async def attack_warmup(request: Request):
        ok, reason = access_check(request)
        if not ok:
            return _forbidden(reason)
        try:
            status, body = await cloner.warmup()
        except ClonerError as e:
            return _error(e.status, e.code, e.message)
        return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})

    @app.post("/api/attack/clone")
    async def attack_clone(request: Request):
        # Guard BEFORE parsing the body: remote requests never get their upload read or forwarded.
        ok, reason = access_check(request)
        if not ok:
            return _forbidden(reason)
        allowed, msg = clone_limiter.check(request, "clone")
        if not allowed:
            return _error(429, "public_limit", msg)
        try:
            form = await request.form(max_files=2, max_fields=10)
        except Exception:
            return _error(400, "invalid_request", "Expected a multipart form with reference, text, engine and consent.")
        try:
            return await _clone_from_form(form)
        finally:
            await form.close()  # drop the spooled reference upload right away

    async def _clone_from_form(form) -> Response:
        if not _truthy(form.get("consent")):
            return _error(400, "consent_required",
                          "Tick the consent box: you may only clone your own voice, with your consent (rule 5.3).")
        reference = form.get("reference")
        if not isinstance(reference, UploadFile):
            return _error(400, "invalid_request", "reference: an audio file of your own voice is required.")
        text = str(form.get("text") or "").strip()
        if not text:
            return _error(400, "invalid_text", "text: write the script the clone should say.")
        if len(text) > MAX_TEXT_CHARS:
            return _error(400, "text_too_long", f"text must be at most {MAX_TEXT_CHARS} characters (got {len(text)}).")
        engine = str(form.get("engine") or "local").strip().lower()
        if engine not in ENGINES:
            return _error(400, "invalid_engine", f"engine must be one of {', '.join(ENGINES)}.")
        language = str(form.get("language") or "en").strip() or "en"
        if not LANGUAGE_RE.match(language):
            return _error(400, "invalid_language", "language must be a code like 'en' or 'hi'.")
        data = await reference.read()
        if not data:
            return _error(400, "empty_file", "The reference audio file is empty.")
        if len(data) > MAX_REFERENCE_BYTES:
            return _error(413, "file_too_large", "Reference audio is larger than 25 MB.")
        try:
            resp = await cloner.clone(data, reference.filename or "reference.wav",
                                      reference.content_type or "application/octet-stream", text, engine, language)
        except ClonerError as e:
            return _error(e.status, e.code, e.message)
        headers = {"Cache-Control": "no-store", "Content-Disposition": 'inline; filename="callshield-clone.wav"'}
        for h in PASSTHROUGH_HEADERS:
            if resp.headers.get(h) is not None:
                headers[h] = resp.headers[h]
        media = resp.headers.get("content-type", "audio/wav").split(";")[0].strip() or "audio/wav"
        if media == "application/octet-stream":
            media = "audio/wav"
        return Response(content=resp.content, media_type=media, headers=headers)

    @app.get("/attack.html", include_in_schema=False)
    async def attack_page(request: Request):
        ok, reason = access_check(request)
        if not ok:
            return HTMLResponse(
                "<!doctype html><meta charset='utf-8'><title>CallShield</title>"
                "<body style='background:#0f1115;color:#e8eaf0;font-family:system-ui;padding:40px'>"
                f"<h1>Attack Lab unavailable</h1><p>{reason}</p><p><a style='color:#d4ff2a' href='/'>"
                "Back to the agent console</a></p></body>", status_code=403)
        page = Path(frontend_dir) / "attack.html"
        if not page.is_file():
            return _error(404, "not_found", "attack.html not found")
        return FileResponse(page, media_type="text/html", headers={"Cache-Control": "no-store"})
