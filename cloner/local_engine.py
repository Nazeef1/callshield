"""Local GPU voice-cloning engine wrapper (Resemble AI Chatterbox).

Lazy-loads the model on first use and keeps it resident. Thread-safe load.
"""
from __future__ import annotations

import threading

from .audio import float_to_wav_bytes

MODEL_NAME = "chatterbox"


class LocalEngine:
    def __init__(self) -> None:
        self._model = None
        self._device = None
        self._sr = None
        self._lock = threading.Lock()
        self._import_error: str | None = None

    @property
    def available(self) -> bool:
        """True if the package imports (independent of whether it is loaded)."""
        try:
            import chatterbox.tts  # noqa: F401
            return True
        except Exception as e:  # pragma: no cover
            self._import_error = str(e)
            return False

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        if self._device:
            return self._device
        try:
            import torch
            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    def load(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            import torch
            from chatterbox.tts import ChatterboxTTS

            device = "cuda" if torch.cuda.is_available() else "cpu"
            model = ChatterboxTTS.from_pretrained(device=device)
            self._model = model
            self._device = device
            self._sr = int(getattr(model, "sr", 24000))

    def generate_wav(self, text: str, reference_wav_path: str) -> tuple[bytes, int]:
        """Generate cloned speech; return (wav_bytes, sample_rate)."""
        self.load()
        import torch

        with torch.no_grad():
            wav = self._model.generate(text, audio_prompt_path=reference_wav_path)
        # wav is a torch tensor shaped (1, N) or (N,)
        arr = wav.squeeze().detach().to("cpu").numpy()
        return float_to_wav_bytes(arr, self._sr), self._sr


local_engine = LocalEngine()
