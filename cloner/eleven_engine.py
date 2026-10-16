"""ElevenLabs Instant Voice Clone engine (UNTESTED — requires ELEVENLABS_API_KEY).

Flow:
  1. POST /v1/voices/add (multipart name, files) -> voice_id, cached by sha256(reference).
  2. POST /v1/text-to-speech/{voice_id}?output_format=pcm_16000 JSON {text, model_id}
     -> raw 16 kHz PCM, wrapped into a WAV container by the caller.
The API key is read from config and never logged.
"""
from __future__ import annotations

import hashlib
import json
import os

import httpx

from .audio import pcm16_to_wav_bytes
from .config import CACHE_DIR, ELEVENLABS_API_KEY, ELEVENLABS_MODEL_ID

MODEL_NAME = "elevenlabs-ivc"
BASE = "https://api.elevenlabs.io/v1"
_VOICE_CACHE = CACHE_DIR / "eleven_voices.json"


def available() -> bool:
    return bool(ELEVENLABS_API_KEY)


def _load_cache() -> dict:
    try:
        return json.loads(_VOICE_CACHE.read_text())
    except Exception:
        return {}


def _save_cache(cache: dict) -> None:
    try:
        _VOICE_CACHE.write_text(json.dumps(cache))
    except Exception:
        pass


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _get_or_create_voice(reference_path: str) -> str:
    digest = _sha256_file(reference_path)
    cache = _load_cache()
    if digest in cache:
        return cache[digest]
    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    with open(reference_path, "rb") as f:
        files = {"files": (os.path.basename(reference_path), f, "audio/wav")}
        data = {"name": f"callshield-attacklab-{digest[:12]}"}
        resp = httpx.post(f"{BASE}/voices/add", headers=headers, data=data,
                          files=files, timeout=120)
    resp.raise_for_status()
    voice_id = resp.json()["voice_id"]
    cache[digest] = voice_id
    _save_cache(cache)
    return voice_id


def generate_wav(text: str, reference_path: str, language: str = "en") -> tuple[bytes, int]:
    """Return (wav_bytes, sample_rate=16000). Raises on failure."""
    voice_id = _get_or_create_voice(reference_path)
    headers = {"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"}
    body = {"text": text, "model_id": ELEVENLABS_MODEL_ID}
    resp = httpx.post(
        f"{BASE}/text-to-speech/{voice_id}",
        params={"output_format": "pcm_16000"},
        headers=headers, json=body, timeout=120,
    )
    resp.raise_for_status()
    return pcm16_to_wav_bytes(resp.content, 16000), 16000
