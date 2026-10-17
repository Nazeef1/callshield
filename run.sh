#!/usr/bin/env bash
# CallShield launcher (Git Bash / macOS / Linux). Needs DETECTIF_API_KEY in .env.
#   ./run.sh
#   PORT=8080 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
PY=".venv/Scripts/python.exe"
[ -x "$PY" ] || PY=".venv/bin/python"
PORT="${PORT:-8000}"
echo "CallShield -> http://localhost:${PORT}"
exec "$PY" -m uvicorn backend.app:app --host 0.0.0.0 --port "$PORT" --timeout-graceful-shutdown 2
