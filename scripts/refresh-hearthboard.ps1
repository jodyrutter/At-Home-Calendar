# Rebuilds and restarts the Hearthboard Docker services so local code changes
# (server.js, public/*, Caddyfile, etc.) are picked up.  Run this from an
# elevated PowerShell whenever you can't see a site change you just made.
#
#   powershell.exe -ExecutionPolicy Bypass -File ".\scripts\refresh-hearthboard.ps1"
#
# Flags:
#   -NoBuild     Skip the docker build step (fast restart only).
#   -PullCaddy   Also pull a fresh caddy image.
#   -Logs        Tail container logs after the restart.

param(
  [switch]$NoBuild,
  [switch]$PullCaddy,
  [switch]$Logs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = "C:\Users\jody4\OneDrive\Documents\New project"
Set-Location $projectRoot

Write-Host ""
Write-Host "Hearthboard refresh" -ForegroundColor Cyan
Write-Host "-------------------" -ForegroundColor Cyan
Write-Host "Project root : $projectRoot"
Write-Host ""

# 1. Make sure Docker is reachable.
try {
  docker info --format "{{.ServerVersion}}" | Out-Null
  Write-Host "Docker daemon is up." -ForegroundColor Green
} catch {
  throw "Docker daemon is not reachable.  Start Docker Desktop first, then rerun."
}

# 2. Pick up any .env / env changes for the Caddy trust hosts.
$envUpdater = Join-Path $projectRoot "scripts\update-hearthboard-env.ps1"
if (Test-Path $envUpdater) {
  try {
    & $envUpdater | Out-Null
    Write-Host "Refreshed HTTPS host settings." -ForegroundColor Green
  } catch {
    Write-Warning "update-hearthboard-env.ps1 failed: $($_.Exception.Message)"
  }
}

# 3. Rebuild the hearthboard image so the new server.js + public/* baked in.
if (-not $NoBuild) {
  Write-Host "Rebuilding hearthboard image (COPY . . needs a rebuild to see new code)..." -ForegroundColor Cyan
  docker compose build hearthboard
  if ($LASTEXITCODE -ne 0) { throw "docker compose build hearthboard failed with exit code $LASTEXITCODE" }
}

if ($PullCaddy) {
  Write-Host "Pulling latest caddy image..." -ForegroundColor Cyan
  docker compose pull caddy
}

# 4. Recreate the containers so the new image is actually used.
Write-Host "Recreating containers..." -ForegroundColor Cyan
docker compose up -d --force-recreate hearthboard caddy
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed with exit code $LASTEXITCODE" }

# 5. Wait briefly for the healthcheck, then report status.
Start-Sleep -Seconds 3
Write-Host ""
Write-Host "Container status:" -ForegroundColor Cyan
docker compose ps

Write-Host ""
Write-Host "Waiting for /api/health ..." -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(45)
$healthy  = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:42070/api/health" -TimeoutSec 3
    if ($response.StatusCode -eq 200) {
      $healthy = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 1500
  }
}

if ($healthy) {
  Write-Host "Hearthboard is healthy on http://127.0.0.1:42070/api/health" -ForegroundColor Green
  Write-Host "Open https://192.168.1.118:42069/ and press Ctrl+Shift+R to force-refresh the browser cache." -ForegroundColor Green
} else {
  Write-Warning "Hearthboard did not become healthy within 45 s.  Check logs:"
  Write-Host "  docker logs hearthboard --tail 80" -ForegroundColor Yellow
}

if ($Logs) {
  Write-Host ""
  Write-Host "Tailing hearthboard logs (Ctrl+C to exit)..." -ForegroundColor Cyan
  docker logs hearthboard --tail 60 --follow
}
