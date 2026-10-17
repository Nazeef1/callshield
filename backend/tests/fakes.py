"""FakeClient: an in-memory stand-in for detectif.LiveClient (same async surface, DetectifAI-shaped JSON).

Pick the outcome of the next checks with `scenario` (genuine | deepfake | imposter | uncertain); make a method
fail with `fail(method, DetectifError(...))`; replace a paid response with `respond(method, body)`.
"""
from __future__ import annotations

import copy
import uuid
from datetime import datetime, timezone
from typing import Optional

from backend.audio import wav_duration
from backend.detectif import DetectifError

PRICE = 50
SCENARIOS = {
    #            deepfake verdict, score, decided_by          speaker decision, similarity
    "genuine": (("real", 0.08, "main_model"), ("match", 0.7412)),
    "deepfake": (("fake", 0.8127, "second_stage"), ("match", 0.6104)),
    "imposter": (("real", 0.10, "main_model"), ("no_match", 0.2133)),
    "uncertain": (("not_sure", 0.65, "language_threshold"), ("match", 0.5812)),
}
MODEL_DF = {"name": "aletheia-wavlm", "version": "x"}
MODEL_SP = {"name": "eidos-redimnet2", "version": "redimnet2-b2"}


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:24]}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeClient:
    def __init__(self, scenario: str = "genuine", available: int = 5000, speakers: Optional[list] = None):
        self.scenario = scenario
        self.available = available
        self.speakers: dict[str, dict] = {s["speaker_id"]: dict(s) for s in speakers or []}
        self.errors: dict[str, DetectifError] = {}
        self.responses: dict[str, dict] = {}
        self.calls: list[tuple[str, dict]] = []
        self.feedback_sent: list[tuple[str, bool]] = []
        self.credit_calls = 0
        self.closed = False

    # ---- test controls ----------------------------------------------------
    def fail(self, method: str, error: Optional[DetectifError]) -> None:
        if error is None:
            self.errors.pop(method, None)
        else:
            self.errors[method] = error

    def respond(self, method: str, body: Optional[dict]) -> None:
        if body is None:
            self.responses.pop(method, None)
        else:
            self.responses[method] = body

    @property
    def paid_calls(self) -> int:
        return sum(1 for name, _ in self.calls if name in ("enroll", "verify", "detect"))

    def _enter(self, method: str, **info) -> None:
        self.calls.append((method, info))
        if method in self.errors:
            raise self.errors[method]

    def _charge(self, amount: int) -> dict:
        self.available -= amount
        return {"charged": amount, "balance": self.available}

    def _deepfake(self, duration: float) -> dict:
        verdict, score, decided_by = SCENARIOS[self.scenario][0]
        label = {"real": "genuine", "fake": "synthetic", "not_sure": "uncertain"}[verdict]
        segments, start = [], 0.0
        while True:
            end = min(duration, start + 4.0)
            segments.append({"start": round(start, 2), "end": round(end, 2), "score": score})
            if end >= duration:
                break
            start += 2.0
        return {"threshold": 0.62, "verdict": verdict, "label": label, "is_synthetic": verdict == "fake",
                "decided_by": decided_by, "score": score, "language": {"code": "en", "probability": 0.99},
                "route": "en", "duration_seconds": round(duration, 2), "segments": segments}

    # ---- free endpoints -----------------------------------------------------
    async def aclose(self) -> None:
        self.closed = True

    async def health(self) -> dict:
        self._enter("health")
        return {"request_id": _id("req"), "status": "ok", "inference": "ok"}

    async def credits(self) -> dict:
        self._enter("credits")
        self.credit_calls += 1
        return {"request_id": _id("req"), "object": "credits", "plan": "free", "unlimited": False,
                "available": self.available, "reserved": 0, "price_per_operation": PRICE}

    async def list_speakers(self) -> dict:
        self._enter("list_speakers")
        return {"data": [dict(s) for s in self.speakers.values()]}

    async def delete_speaker(self, speaker_id: str) -> dict:
        self._enter("delete_speaker", speaker_id=speaker_id)
        if self.speakers.pop(speaker_id, None) is None:
            raise DetectifError(404, "speaker_not_found", f"No speaker with id {speaker_id}.", request_id=_id("req"))
        return {}

    async def feedback(self, operation_id: str, correct: bool) -> dict:
        self._enter("feedback", operation_id=operation_id, correct=correct)
        self.feedback_sent.append((operation_id, bool(correct)))
        return {"request_id": _id("req"), "object": "operation.feedback", "operation_id": operation_id,
                "correct": bool(correct), "created_at": _now()}

    # ---- paid endpoints -----------------------------------------------------
    async def enroll(self, file_bytes: bytes, filename: Optional[str], content_type: Optional[str],
                     speaker_id: str, display_name: Optional[str] = None) -> dict:
        self._enter("enroll", speaker_id=speaker_id, display_name=display_name)
        duration = wav_duration(file_bytes) or 20.0
        now = _now()
        sp = self.speakers.get(speaker_id) or {"speaker_id": speaker_id, "samples": 0, "created_at": now}
        sp.update({"display_name": display_name or sp.get("display_name"), "samples": min(5, sp["samples"] + 1),
                   "updated_at": now})
        self.speakers[speaker_id] = sp
        return {"request_id": _id("req"), "operation_id": _id("op"), "object": "speaker.enrollment",
                "speaker": dict(sp),
                "quality": {"speech_seconds": round(duration * 0.9, 2), "duration_seconds": round(duration, 2)},
                "model": MODEL_SP, "credits": self._charge(PRICE), "latency_ms": 412.0, "idempotent_replay": False}

    async def verify(self, file_bytes: bytes, filename: Optional[str], content_type: Optional[str],
                     speaker_id: str, detect_deepfake: bool = True) -> dict:
        self._enter("verify", speaker_id=speaker_id, detect_deepfake=detect_deepfake, size=len(file_bytes))
        if "verify" in self.responses:
            return copy.deepcopy(self.responses["verify"])
        if speaker_id not in self.speakers:
            raise DetectifError(404, "speaker_not_found", f"No speaker with id {speaker_id}.", request_id=_id("req"))
        duration = wav_duration(file_bytes) or 8.0
        decision, similarity = SCENARIOS[self.scenario][1]
        deepfake = None
        if detect_deepfake:
            deepfake = {**self._deepfake(duration), "operation_id": _id("op"), "credits_charged": PRICE,
                        "model": MODEL_DF}
            self.available -= PRICE
        return {"request_id": _id("req"), "operation_id": _id("op"), "object": "speaker.verification",
                "speaker_id": speaker_id,
                "result": {"decision": decision, "similarity": similarity, "threshold": 0.53,
                           "duration_seconds": round(duration, 2),
                           "similarity_semantics": "Higher means the two voices are more alike. Not a percentage."},
                "deepfake": deepfake, "model": MODEL_SP, "credits": self._charge(PRICE), "latency_ms": 301.5,
                "idempotent_replay": False}

    async def detect(self, file_bytes: bytes, filename: Optional[str], content_type: Optional[str]) -> dict:
        self._enter("detect", size=len(file_bytes))
        if "detect" in self.responses:
            return copy.deepcopy(self.responses["detect"])
        duration = wav_duration(file_bytes) or 8.0
        return {"request_id": _id("req"), "operation_id": _id("op"), "object": "deepfake.detection",
                "model": MODEL_DF, "latency_ms": 58.3, "idempotent_replay": False,
                "result": self._deepfake(duration), "credits": self._charge(PRICE)}
