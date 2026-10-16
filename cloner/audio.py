"""Audio helpers: ffmpeg conversion, duration/RMS probing, WAV wrapping."""
from __future__ import annotations

import io
import struct
import subprocess
import wave

from .config import FFMPEG, FFPROBE


def probe_duration_seconds(path: str) -> float:
    """Return duration in seconds using ffprobe, or 0.0 on failure."""
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def convert_to_wav(src_path: str, dst_path: str, sample_rate: int = 24000) -> None:
    """Convert any input audio to mono 16-bit PCM WAV at the given sample rate."""
    subprocess.run(
        [FFMPEG, "-y", "-i", src_path, "-ac", "1", "-ar", str(sample_rate),
         "-sample_fmt", "s16", dst_path],
        capture_output=True, check=True, timeout=120,
    )


def float_to_wav_bytes(samples, sample_rate: int) -> bytes:
    """Wrap a 1-D float array/tensor in [-1, 1] into a 16-bit PCM mono WAV (bytes)."""
    import numpy as np

    arr = np.asarray(samples, dtype=np.float32).reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm)
    return buf.getvalue()


def pcm16_to_wav_bytes(pcm_bytes: bytes, sample_rate: int) -> bytes:
    """Wrap raw little-endian 16-bit PCM mono bytes into a WAV container (bytes)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm_bytes)
    return buf.getvalue()


def wav_stats(wav_bytes: bytes) -> dict:
    """Return {duration_s, rms, peak, sample_rate, frames} for a 16-bit PCM WAV."""
    import numpy as np

    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(data ** 2))) if data.size else 0.0
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    return {
        "duration_s": round(n / sr, 3) if sr else 0.0,
        "rms": round(rms, 5),
        "peak": round(peak, 5),
        "sample_rate": sr,
        "frames": n,
    }
