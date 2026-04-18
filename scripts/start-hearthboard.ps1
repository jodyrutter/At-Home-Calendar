Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Starting Hearthboard on port 42069..." -ForegroundColor Cyan
$projectRoot = Split-Path -Parent $PSScriptRoot

try {
  $envInfo = & (Join-Path $PSScriptRoot "update-hearthboard-env.ps1") | ConvertFrom-Json
} catch {
  Write-Warning "Could not refresh Hearthboard HTTPS host settings automatically. Continuing with the existing .env values."
  $envInfo = $null
}

try {
  docker info | Out-Null
} catch {
  Write-Error "Docker Desktop does not appear to be running. Start Docker Desktop, then run this script again."
}

Set-Location $projectRoot
docker compose up --build -d
& (Join-Path $PSScriptRoot "start-hearthboard-ai-tray.ps1")

$localIp = $envInfo.lanIp

Write-Host ""
Write-Host "Hearthboard should now be available at:" -ForegroundColor Green
Write-Host "  https://localhost"
Write-Host "  https://localhost:42069"

if ($localIp) {
  Write-Host "  https://$localIp"
  Write-Host "  https://$localIp`:42069"
}

Write-Host ""
Write-Host "If this is your first HTTPS run, trust the local certificate on this PC with:" -ForegroundColor Yellow
Write-Host "  .\\scripts\\install-hearthboard-local-ca.ps1"
Write-Host ""
Write-Host "To stop it later, run .\\scripts\\stop-hearthboard.ps1" -ForegroundColor Yellow
