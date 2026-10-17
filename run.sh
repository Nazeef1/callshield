#!/usr/bin/env bash
# CallShield launcher (Git Bash / macOS / Linux). Needs DETECTIF_API_KEY in .env.
#   ./run.sh
#   PORT=8080 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
PY=".venv/Scripts/python.exe"
[ -x "$PY" ] || PY=".venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "Python venv not found (looked for .venv/Scripts/python.exe and .venv/bin/python)." >&2
  echo "Create it: python -m venv .venv, then install requirements.txt into it." >&2
  exit 1
fi
PORT="${PORT:-8000}"
echo "CallShield -> http://localhost:${PORT}"
exec "$PY" -m uvicorn backend.app:app --host 0.0.0.0 --port "$PORT" --timeout-graceful-shutdown 2
