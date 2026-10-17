"""Generate the virtual agent's voice prompts (frontend/voice/agent/<id>.mp3) from prompts.json.

Uses Microsoft's neural TTS through edge-tts (needs internet, run once; the MP3s are committed):
    python tools/make_agent_voice.py            # only missing / changed prompts
    python tools/make_agent_voice.py --all      # regenerate everything
Requires uv (runs `uvx edge-tts`).
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / "frontend" / "voice" / "agent"


def main() -> None:
    spec = json.loads((DIR / "prompts.json").read_text(encoding="utf-8"))
    voice = spec["voice"]
    stamp_path = DIR / ".stamps.json"
    stamps = {} if "--all" in sys.argv or not stamp_path.exists() else json.loads(stamp_path.read_text())
    for pid, text in spec["prompts"].items():
        digest = hashlib.sha1(f"{voice}|{text}".encode()).hexdigest()
        out = DIR / f"{pid}.mp3"
        if out.exists() and stamps.get(pid) == digest:
            continue
        subprocess.run(["uvx", "edge-tts", "--voice", voice, "--text", text, "--write-media", str(out)], check=True)
        stamps[pid] = digest
        print(f"made {out.name}")
    stamp_path.write_text(json.dumps(stamps, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
