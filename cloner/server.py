"""CallShield Attack Lab — local voice-cloning FastAPI service.

Red-team tool: clones a consenting team member's own voice so DetectifAI's
deepfake detection can be tested. Binds to 127.0.0.1 only.

Contract:
  GET  /health
  POST /warmup
  POST /clone  (multipart: reference, text, engine, language) -> audio/wav
  POST /transcribe  (multipart: file = 16 kHz mono WAV, language) -> {text, ms, model}
       Local Whisper speech-to-text for the agent console's live call transcript.
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
from .asr import MODEL_NAME as ASR_MODEL, transcriber
from .local_engine import MODEL_NAME as LOCAL_MODEL, local_engine

app = FastAPI(title="CallShield Attack Lab Cloner", version="1.0")

_ALLOWED_EXT = {".wav", ".mp3", ".m4a", ".webm", ".ogg"}


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


# Shared-secret guard. When CLONER_TOKEN is set (in .env, loaded by .config), every request must carry it in
# X-Cloner-Token. This is what lets the cloner sit behind a public tunnel: only the CallShield backend knows it.
_CLONER_TOKEN = os.environ.get("CLONER_TOKEN", "").strip()


@app.middleware("http")
async def _require_token(request, call_next):
    if _CLONER_TOKEN:
        import hmac
        sent = request.headers.get("x-cloner-token", "")
        if not hmac.compare_digest(sent.encode(), _CLONER_TOKEN.encode()):
            return _err("unauthorized", "Missing or wrong X-Cloner-Token.", 401)
    return await call_next(request)


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
        "asr": {"available": transcriber.available, "model": ASR_MODEL, "loaded": transcriber.loaded},
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


@app.post("/transcribe")
def transcribe(file: UploadFile = File(...), language: str = Form("en")):
    if not transcriber.available:
        return _err("asr_unavailable", "Speech-to-text needs torch + transformers in this venv.", 503)
    data = file.file.read()
    if not data:
        return _err("empty_file", "The audio file is empty.", 400)
    t0 = time.time()
    try:
        text = transcriber.transcribe_wav(data, (language or "en")[:5])
    except Exception as e:
        return _err("transcribe_failed", f"Transcription failed: {e}", 500)
    return {"text": text, "ms": int((time.time() - t0) * 1000), "model": ASR_MODEL}


# Expose wav_stats for optional debugging via import; not a route.
__all__ = ["app", "wav_stats"]
