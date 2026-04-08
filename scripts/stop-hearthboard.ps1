Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Stopping Hearthboard..." -ForegroundColor Cyan
docker compose down
