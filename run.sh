#!/usr/bin/env bash
# CallShield launcher (Git Bash / macOS / Linux)
#   ./run.sh            -> live mode if DETECTIF_API_KEY is in .env, else mock
#   ./run.sh --mock     -> force mock mode (no DetectifAI credits used)
#   PORT=8080 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
if [ "${1:-}" = "--mock" ]; then export CALLSHIELD_MODE=mock; fi
PY=".venv/Scripts/python.exe"
[ -x "$PY" ] || PY=".venv/bin/python"
PORT="${PORT:-8000}"
echo "CallShield -> http://localhost:${PORT}  (mode: ${CALLSHIELD_MODE:-auto})"
exec "$PY" -m uvicorn backend.app:app --host 0.0.0.0 --port "$PORT" --timeout-graceful-shutdown 2
