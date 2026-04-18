Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$exportDirectory = Join-Path $projectRoot "local-certs"
$exportPath = Join-Path $exportDirectory "hearthboard-local-root.crt"

New-Item -ItemType Directory -Path $exportDirectory -Force | Out-Null

try {
  docker compose ps caddy | Out-Null
} catch {
  throw "Docker Compose is not available from this folder."
}

$pem = docker compose exec -T caddy sh -lc "cat /data/caddy/pki/authorities/local/root.crt"
if (-not $pem) {
  throw "Could not read the Caddy local root certificate. Start Hearthboard HTTPS first, then rerun this script."
}

[System.IO.File]::WriteAllText($exportPath, ($pem -join "`n"), [System.Text.Encoding]::ASCII)
Write-Host "Exported Hearthboard local root CA to $exportPath" -ForegroundColor Green
