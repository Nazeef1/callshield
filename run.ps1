# CallShield launcher (Windows PowerShell)
#   .\run.ps1            -> live mode if DETECTIF_API_KEY is in .env, else mock
#   .\run.ps1 -Mock      -> force mock mode (no DetectifAI credits used)
#   .\run.ps1 -Port 8080
param(
    [switch]$Mock,
    [int]$Port = 8000
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Python venv not found at $python" }
if ($Mock) { $env:CALLSHIELD_MODE = "mock" }
Write-Host "CallShield -> http://localhost:$Port  (mode: $(if ($env:CALLSHIELD_MODE) { $env:CALLSHIELD_MODE } else { 'auto' }))"
& $python -m uvicorn backend.app:app --host 0.0.0.0 --port $Port --timeout-graceful-shutdown 2
