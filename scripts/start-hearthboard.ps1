Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Starting Hearthboard on port 42069..." -ForegroundColor Cyan

try {
  docker info | Out-Null
} catch {
  Write-Error "Docker Desktop does not appear to be running. Start Docker Desktop, then run this script again."
}

docker compose up --build -d

$localIp = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*" -and
    $_.PrefixOrigin -ne "WellKnown"
  } |
  Sort-Object InterfaceMetric |
  Select-Object -First 1 -ExpandProperty IPAddress

Write-Host ""
Write-Host "Hearthboard should now be available at:" -ForegroundColor Green
Write-Host "  http://localhost:42069"

if ($localIp) {
  Write-Host "  http://$localIp`:42069"
}

Write-Host ""
Write-Host "To stop it later, run .\\scripts\\stop-hearthboard.ps1" -ForegroundColor Yellow
