"""Local speech-to-text (Whisper via transformers) for the agent console's live transcript.

The caller's audio already reaches the agent console during a phone call; the console sends short
utterances here so the keyword trigger works without Chrome's cloud speech service (which can't share
the mic with a call on Android). Lazy-loaded on first use; GPU if available.
"""
from __future__ import annotations

import io
import os
import threading

MODEL_NAME = os.environ.get("ASR_MODEL", "openai/whisper-base")  # openai/whisper-small: better, ~1 GB
# The xet download path stalls on some networks (phone hotspots); plain HTTPS from the CDN works.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

# Whisper tends to "hear" these on near-silent clips.
_HALLUCINATIONS = {"", "you", "thank you", "thank you.", "thanks for watching", "thanks for watching!",
                   "bye", "bye.", ".", "...", "okay.", "so"}


class Transcriber:
    def __init__(self):
        self._pipe = None
        self._lock = threading.Lock()
        self.device = None

    @property
    def available(self) -> bool:
        try:
            import torch  # noqa: F401
            import transformers  # noqa: F401
            return True
        except Exception:
            return False

    @property
    def loaded(self) -> bool:
        return self._pipe is not None

    def load(self) -> None:
        with self._lock:
            if self._pipe is not None:
                return
            import torch
            from transformers import pipeline
            cuda = torch.cuda.is_available()
            self.device = "cuda" if cuda else "cpu"
            self._pipe = pipeline("automatic-speech-recognition", model=MODEL_NAME,
                                  dtype=torch.float16 if cuda else torch.float32,
                                  device=0 if cuda else -1)

    def transcribe_wav(self, wav_bytes: bytes, language: str = "en") -> str:
        import numpy as np
        import soundfile as sf
        samples, rate = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=True)
        samples = samples.mean(axis=1)
        if rate != 16000:
            import librosa
            samples = librosa.resample(samples, orig_sr=rate, target_sr=16000)
        samples = np.ascontiguousarray(samples, dtype=np.float32)
        self.load()
        with self._lock:
            out = self._pipe({"raw": samples, "sampling_rate": 16000},
                             generate_kwargs={"language": language, "task": "transcribe"})
        text = (out.get("text") or "").strip()
        return "" if text.lower() in _HALLUCINATIONS else text


transcriber = Transcriber()
