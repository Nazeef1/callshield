"""Small audio helpers (stdlib only).

We only need the duration of uploaded clips so we can reject audio that DetectifAI
would refuse anyway *before* spending credits. WAV is parsed from its RIFF header
(works for PCM, float and WAVE_FORMAT_EXTENSIBLE); other formats return None and the
duration check is skipped.
"""
from __future__ import annotations

import io
import math
import struct
import wave
from typing import Optional


def is_wav(data: bytes) -> bool:
    return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


def wav_duration(data: bytes) -> Optional[float]:
    """Duration in seconds of a RIFF/WAVE byte string, or None if it is not a parseable WAV."""
    if not is_wav(data):
        return None
    pos = 12
    byte_rate = None
    n = len(data)
    while pos + 8 <= n:
        chunk_id = data[pos:pos + 4]
        (size,) = struct.unpack_from("<I", data, pos + 4)
        body = pos + 8
        if chunk_id == b"fmt " and body + 12 <= n:
            # audio_format(H) channels(H) sample_rate(I) byte_rate(I)
            byte_rate = struct.unpack_from("<I", data, body + 8)[0]
        elif chunk_id == b"data":
            if not byte_rate:
                return None
            available = n - body
            # Streaming encoders sometimes write 0 or 0xFFFFFFFF as the size.
            if size == 0 or size > available:
                size = available
            return size / float(byte_rate)
        pos = body + size + (size & 1)  # chunks are word aligned
    return None


def make_sine_wav(seconds: float = 8.0, rate: int = 16000, freq: float = 220.0) -> bytes:
    """16-bit mono sine tone WAV (used by tests and demos)."""
    frames = int(seconds * rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        samples = bytearray()
        for i in range(frames):
            v = int(12000 * math.sin(2 * math.pi * freq * i / rate))
            samples += struct.pack("<h", v)
        w.writeframes(bytes(samples))
    return buf.getvalue()
