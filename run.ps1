# CallShield launcher (Windows PowerShell). Needs DETECTIF_API_KEY in .env.
#   .\run.ps1
#   .\run.ps1 -Port 8080
param(
    [int]$Port = 8000
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Python venv not found at $python" }
Write-Host "CallShield -> http://localhost:$Port"
& $python -m uvicorn backend.app:app --host 0.0.0.0 --port $Port --timeout-graceful-shutdown 2
