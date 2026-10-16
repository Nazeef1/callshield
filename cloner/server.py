"""CallShield Attack Lab — local voice-cloning FastAPI service.

Red-team tool: clones a consenting team member's own voice so DetectifAI's
deepfake detection can be tested. Binds to 127.0.0.1 only.

Contract:
  GET  /health
  POST /warmup
  POST /clone  (multipart: reference, text, engine, language) -> audio/wav
"""
from __future__ import annotations

import os
import tempfile
import time

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

from . import eleven_engine
from .audio import convert_to_wav, probe_duration_seconds, wav_stats
from .config import MAX_TEXT_CHARS, MIN_REFERENCE_SECONDS
from .local_engine import MODEL_NAME as LOCAL_MODEL, local_engine

app = FastAPI(title="CallShield Attack Lab Cloner", version="1.0")

_ALLOWED_EXT = {".wav", ".mp3", ".m4a", ".webm", ".ogg"}


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


@app.get("/health")
def health():
    try:
        import torch
        cuda_ok = torch.cuda.is_available()
    except Exception:
        cuda_ok = False
    device = "cuda" if cuda_ok else "cpu"
    return {
        "ok": True,
        "engines": {
            "local": {
                "available": local_engine.available,
                "model": LOCAL_MODEL,
                "device": device,
                "loaded": local_engine.loaded,
            },
            "elevenlabs": {"available": eleven_engine.available()},
        },
    }


@app.post("/warmup")
def warmup():
    if not local_engine.available:
        return _err("engine_unavailable", "Local engine package not installed.", 503)
    t0 = time.time()
    local_engine.load()
    return {"ok": True, "loaded": local_engine.loaded, "device": local_engine.device,
            "load_ms": int((time.time() - t0) * 1000)}


@app.post("/clone")
async def clone(
    reference: UploadFile = File(...),
    text: str = Form(...),
    engine: str = Form("local"),
    language: str = Form("en"),
):
    text = (text or "").strip()
    if not text:
        return _err("text_too_long", "Text is empty.", 400)
    if len(text) > MAX_TEXT_CHARS:
        return _err("text_too_long", f"Text exceeds {MAX_TEXT_CHARS} characters.", 400)

    ext = os.path.splitext(reference.filename or "")[1].lower()
    if ext not in _ALLOWED_EXT:
        ext = ".bin"

    tmpdir = tempfile.mkdtemp(prefix="cloner_")
    raw_path = os.path.join(tmpdir, "reference" + ext)
    wav_path = os.path.join(tmpdir, "reference_24k.wav")
    try:
        with open(raw_path, "wb") as f:
            f.write(await reference.read())

        # Convert to mono 24 kHz 16-bit WAV for the model.
        try:
            convert_to_wav(raw_path, wav_path, sample_rate=24000)
        except Exception as e:
            return _err("generation_failed", f"Could not decode reference audio: {e}", 400)

        dur = probe_duration_seconds(wav_path)
        if dur < MIN_REFERENCE_SECONDS:
            return _err("reference_too_short",
                        f"Reference is {dur:.1f}s; need >= {MIN_REFERENCE_SECONDS:.0f}s.", 400)

        t0 = time.time()
        if engine == "elevenlabs":
            if not eleven_engine.available():
                return _err("engine_unavailable", "ElevenLabs API key not configured.", 503)
            try:
                wav_bytes, _sr = eleven_engine.generate_wav(text, wav_path, language)
            except Exception as e:
                return _err("generation_failed", f"ElevenLabs generation failed: {e}", 502)
            model_name = eleven_engine.MODEL_NAME
        else:
            if not local_engine.available:
                return _err("engine_unavailable", "Local engine package not installed.", 503)
            try:
                wav_bytes, _sr = local_engine.generate_wav(text, wav_path)
            except Exception as e:
                return _err("generation_failed", f"Local generation failed: {e}", 500)
            model_name = LOCAL_MODEL

        gen_ms = int((time.time() - t0) * 1000)
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Engine": engine,
                "X-Model": model_name,
                "X-Gen-Ms": str(gen_ms),
            },
        )
    finally:
        for p in (raw_path, wav_path):
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


# Expose wav_stats for optional debugging via import; not a route.
__all__ = ["app", "wav_stats"]
