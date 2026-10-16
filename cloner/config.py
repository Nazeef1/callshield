"""Configuration and environment loading for the CallShield Attack Lab cloner.

Loads the project .env (for ELEVENLABS_API_KEY) without ever printing the key.
Locates ffmpeg/ffprobe on this machine.
"""
from __future__ import annotations

import glob
import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent  # C:\Users\gooners\Unclone
ENV_PATH = PROJECT_ROOT / ".env"
CACHE_DIR = PROJECT_ROOT / "cloner" / ".cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Load .env from the project root (does not override already-set env vars).
load_dotenv(ENV_PATH)

ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_MODEL_ID = os.environ.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")

MAX_TEXT_CHARS = 400
MIN_REFERENCE_SECONDS = 5.0


def _find_ffmpeg_binary(name: str) -> str:
    """Return a path to ffmpeg/ffprobe. Prefer PATH, fall back to the WinGet install."""
    found = shutil.which(name)
    if found:
        return found
    patterns = [
        os.path.expandvars(
            r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\*Gyan.FFmpeg*\ffmpeg-*\bin\\" + name + ".exe"
        ),
        r"C:\Users\*\AppData\Local\Microsoft\WinGet\Packages\*Gyan.FFmpeg*\ffmpeg-*\bin\\" + name + ".exe",
    ]
    for pat in patterns:
        hits = glob.glob(pat)
        if hits:
            return hits[0]
    # last resort: bare name, let the OS resolve (will error clearly if missing)
    return name


FFMPEG = _find_ffmpeg_binary("ffmpeg")
FFPROBE = _find_ffmpeg_binary("ffprobe")
