# CallShield Attack Lab — local voice-cloning service launcher.
# Red-team tool: clones a consenting team member's OWN voice to test DetectifAI
# deepfake detection. Binds to 127.0.0.1 only — never expose publicly.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$python = Join-Path $root "cloner\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Error "venv python not found at $python. Create it with: uv venv --python 3.11 cloner\.venv"
    exit 1
}

Write-Host "Starting CallShield Attack Lab cloner on http://127.0.0.1:8100 ..."
& $python -m uvicorn cloner.server:app --host 127.0.0.1 --port 8100
