"""DetectifAI client (async, httpx) and response normalisation.

Endpoints (base https://platform.detectif.ai):
  GET  /v1/health, /v1/credits, /v1/speakers                  (free)
  DELETE /v1/speakers/{speaker_id}                            (free; deletes the voiceprint permanently)
  POST /v1/speakers/enroll, /v1/speakers/verify, /v1/deepfake/detect   (50 credits per check)
  POST /v1/operations/{operation_id}/feedback                 (free)

Every paid call gets a fresh uuid4 Idempotency-Key. On 429/503 (after Retry-After), 502/504 and network
errors (after 1 s) or a timeout we retry ONCE with the same key, so a retry can never be charged twice.

The API key is only ever placed in the Authorization header. It is never logged, never part of
an exception message and never part of repr().
"""
from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

import httpx

DEFAULT_BASE_URL = "https://platform.detectif.ai"
SPEAKER_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
PRICE_PER_OPERATION = 50


class DetectifError(Exception):
    """A non-2xx DetectifAI response (or a transport failure, status 0)."""

    def __init__(self, status: int, code: str, message: str, request_id: Optional[str] = None,
                 partial: Optional[dict] = None, type: Optional[str] = None, param: Optional[str] = None,
                 credits: Optional[dict] = None, operation_id: Optional[str] = None):
        super().__init__(f"DetectifAI {status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        self.partial = partial
        self.type = type
        self.param = param
        self.credits = credits
        self.operation_id = operation_id

    def to_dict(self) -> dict:
        return {"status": self.status, "code": self.code, "message": self.message,
                "request_id": self.request_id, "type": self.type, "param": self.param}


def _parse_retry_after(value: Optional[str], default: float = 1.0, cap: float = 10.0) -> float:
    if not value:
        return default
    value = value.strip()
    try:
        secs = float(value)
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
            secs = (when - datetime.now(timezone.utc)).total_seconds()
        except Exception:
            return default
    return max(0.0, min(cap, secs))


def _error_from_response(resp: httpx.Response) -> DetectifError:
    request_id = resp.headers.get("X-Request-Id")
    try:
        body = resp.json()
    except Exception:
        body = None
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        e = body["error"]
        return DetectifError(
            status=resp.status_code,
            code=str(e.get("code") or f"http_{resp.status_code}"),
            message=str(e.get("message") or resp.reason_phrase or "DetectifAI error"),
            request_id=body.get("request_id") or request_id,
            partial=body.get("partial") if isinstance(body.get("partial"), dict) else None,
            type=e.get("type"),
            param=e.get("param"),
            credits=body.get("credits") if isinstance(body.get("credits"), dict) else None,
            operation_id=body.get("operation_id"),
        )
    return DetectifError(resp.status_code, f"http_{resp.status_code}",
                         f"DetectifAI returned HTTP {resp.status_code}", request_id=request_id)


class LiveClient:
    def __init__(self, api_key: str, base_url: Optional[str] = None, timeout: float = 60.0,
                 transport: Optional[httpx.AsyncBaseTransport] = None,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
                 max_retry_wait: float = 10.0):
        if not api_key:
            raise ValueError("DetectifAI API key is required for the live client")
        self._sleep = sleep
        self._max_retry_wait = max_retry_wait
        self._client = httpx.AsyncClient(
            base_url=(base_url or DEFAULT_BASE_URL).rstrip("/"),
            timeout=httpx.Timeout(timeout, connect=10.0),
            transport=transport,
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json",
                     "User-Agent": "CallShield/1.0"},
        )

    def __repr__(self) -> str:  # never leak the key
        return f"<LiveClient base_url={self._client.base_url!s}>"

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, *, paid: bool = False, data: Optional[dict] = None,
                       files: Optional[dict] = None, json_body: Optional[dict] = None,
                       params: Optional[dict] = None) -> dict:
        headers = {"Idempotency-Key": str(uuid.uuid4())} if paid else {}
        for attempt in range(2):
            try:
                resp = await self._client.request(method, path, data=data, files=files, json=json_body,
                                                  params=params, headers=headers)
            except httpx.TimeoutException:
                if attempt == 0:
                    continue  # same headers -> same Idempotency-Key: a retry can't run the check twice
                raise DetectifError(0, "timeout", "DetectifAI did not respond in time") from None
            except httpx.HTTPError as exc:
                if attempt == 0:
                    await self._sleep(1.0)
                    continue
                raise DetectifError(0, "network_error",
                                    f"Could not reach DetectifAI ({type(exc).__name__})") from None
            if resp.status_code in (502, 504) and attempt == 0:
                await self._sleep(1.0)
                continue
            if resp.status_code in (429, 503) and attempt == 0:
                await self._sleep(_parse_retry_after(resp.headers.get("Retry-After"), cap=self._max_retry_wait))
                continue  # same headers -> same Idempotency-Key
            if 200 <= resp.status_code < 300:
                if resp.status_code == 204 or not resp.content:
                    return {}
                try:
                    body = resp.json()
                except Exception:
                    raise DetectifError(resp.status_code, "invalid_response",
                                        "DetectifAI returned a non-JSON response",
                                        request_id=resp.headers.get("X-Request-Id")) from None
                return body if isinstance(body, dict) else {"data": body}
            raise _error_from_response(resp)
        raise AssertionError("unreachable")

    # ---- free endpoints -------------------------------------------------
    async def health(self) -> dict:
        return await self._request("GET", "/v1/health")

    async def credits(self) -> dict:
        return await self._request("GET", "/v1/credits")

    async def list_speakers(self, max_pages: int = 5) -> dict:
        speakers: list = []
        cursor = None
        for _ in range(max_pages):
            params = {"limit": 100}
            if cursor:
                params["cursor"] = cursor
            page = await self._request("GET", "/v1/speakers", params=params)
            speakers.extend(page.get("data") or [])
            cursor = page.get("next_cursor")
            if not page.get("has_more") or not cursor:
                break
        return {"data": speakers}

    async def feedback(self, operation_id: str, correct: bool) -> dict:
        return await self._request("POST", f"/v1/operations/{quote(str(operation_id), safe='')}/feedback",
                                   json_body={"correct": bool(correct)})

    async def delete_speaker(self, speaker_id: str) -> dict:
        return await self._request("DELETE", f"/v1/speakers/{quote(str(speaker_id), safe='')}")

    # ---- paid endpoints (50 credits per completed check) -------------------
    @staticmethod
    def _file(file_bytes: bytes, filename: Optional[str], content_type: Optional[str]) -> dict:
        return {"file": (filename or "audio.wav", file_bytes, content_type or "application/octet-stream")}

    async def enroll(self, file_bytes: bytes, filename: Optional[str], content_type: Optional[str],
                     speaker_id: str, display_name: Optional[str] = None) -> dict:
        data = {"speaker_id": speaker_id}
        if display_name:
            data["display_name"] = display_name[:128]
        return await self._request("POST", "/v1/speakers/enroll", paid=True, data=data,
                                   files=self._file(file_bytes, filename, content_type))

    async def verify(self, file_bytes: bytes, filename: Optional[str], content_type: Optional[str],
                     speaker_id: str, detect_deepfake: bool = True) -> dict:
        data = {"speaker_id": speaker_id, "detect_deepfake": "true" if detect_deepfake else "false"}
        return await self._request("POST", "/v1/speakers/verify", paid=True, data=data,
                                   files=self._file(file_bytes, filename, content_type))

    async def detect(self, file_bytes: bytes, filename: Optional[str], content_type: Optional[str]) -> dict:
        return await self._request("POST", "/v1/deepfake/detect", paid=True,
                                   files=self._file(file_bytes, filename, content_type))


# ---------------------------------------------------------------------------
# Response normalisation
# ---------------------------------------------------------------------------

def _num(v: Any) -> Optional[float]:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _deepfake_view(obj: dict, operation_id: Optional[str]) -> dict:
    return {
        "verdict": obj.get("verdict"),
        "score": _num(obj.get("score")),
        "threshold": _num(obj.get("threshold")),
        "decided_by": obj.get("decided_by"),
        "segments": [{"start": _num(s.get("start")), "end": _num(s.get("end")), "score": _num(s.get("score"))}
                     for s in (obj.get("segments") or []) if isinstance(s, dict)],
        "operation_id": operation_id,
    }


def parse_embedded_deepfake(obj: Any) -> tuple[Optional[dict], Optional[dict], int]:
    """verify's `deepfake` field -> (deepfake view | None, error {code, message} | None, credits charged)."""
    if not isinstance(obj, dict):
        return None, None, 0
    charged = _int(obj.get("credits_charged"))
    if obj.get("verdict") is None:
        err = obj.get("error") if isinstance(obj.get("error"), dict) else {}
        return None, {"code": err.get("code") or "deepfake_failed",
                      "message": err.get("message") or "The deepfake check did not complete."}, charged
    return _deepfake_view(obj, obj.get("operation_id")), None, charged


def _credits(resp: dict) -> tuple[int, Optional[int]]:
    c = resp.get("credits") if isinstance(resp.get("credits"), dict) else None
    if not c:
        return 0, None
    bal = c.get("balance")
    return _int(c.get("charged")), (None if bal is None else _int(bal))


def normalize_detect(resp: dict) -> dict:
    result = resp.get("result") or {}
    charged, balance = _credits(resp)
    return {
        "deepfake": _deepfake_view(result, resp.get("operation_id")),
        "deepfake_error": None,
        "speaker": None,
        "speaker_error": None,
        "charged": charged,
        "balance": balance,
        "has_credits": isinstance(resp.get("credits"), dict),
        "request_id": resp.get("request_id"),
        "duration_seconds": _num(result.get("duration_seconds")),
    }


def normalize_verify(resp: dict) -> dict:
    result = resp.get("result") or {}
    deepfake, df_error, df_charged = parse_embedded_deepfake(resp.get("deepfake"))
    verify_charged, balance = _credits(resp)
    # The docs say the two checks are counted separately; the top-level `credits.charged` is
    # treated as the verification's own charge and the embedded deepfake's `credits_charged`
    # is added. If the top-level figure evidently already includes both, don't double count.
    if df_charged and verify_charged >= 2 * df_charged:
        total = verify_charged
    else:
        total = verify_charged + df_charged
    return {
        "deepfake": deepfake,
        "deepfake_error": df_error,
        "speaker": {
            "decision": result.get("decision"),
            "similarity": _num(result.get("similarity")),
            "threshold": _num(result.get("threshold")),
            "operation_id": resp.get("operation_id"),
        },
        "speaker_error": None,
        "charged": total,
        "balance": balance,
        "has_credits": isinstance(resp.get("credits"), dict),
        "request_id": resp.get("request_id"),
        "duration_seconds": _num(result.get("duration_seconds")),
    }


def normalize_verify_error(err: DetectifError) -> Optional[dict]:
    """A failed verification that still carries `partial.deepfake` -> normalised outcome, else None."""
    partial = err.partial or {}
    df_obj = partial.get("deepfake")
    if not isinstance(df_obj, dict) or df_obj.get("verdict") is None:
        return None
    charged, balance = _credits(partial)
    if not charged:
        charged = _int(df_obj.get("credits_charged"))
    return {
        "deepfake": _deepfake_view(df_obj, df_obj.get("operation_id")),
        "deepfake_error": None,
        "speaker": None,
        "speaker_error": {"code": err.code, "message": err.message},
        "charged": charged,
        "balance": balance,
        "has_credits": isinstance(partial.get("credits"), dict),
        "request_id": err.request_id,
        "duration_seconds": _num(df_obj.get("duration_seconds")),
    }

