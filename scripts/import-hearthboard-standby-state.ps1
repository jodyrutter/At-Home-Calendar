param(
  [string]$SnapshotPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$snapshotDir = Join-Path $PSScriptRoot "standby-state"
if (-not $SnapshotPath) {
  $SnapshotPath = Join-Path $snapshotDir "pi-store.json"
}

if (-not (Test-Path -LiteralPath $SnapshotPath)) {
  throw "Snapshot not found at $SnapshotPath"
}

$raw = Get-Content -LiteralPath $SnapshotPath -Raw
if ([string]::IsNullOrWhiteSpace($raw)) {
  throw "Snapshot file is empty: $SnapshotPath"
}

$null = $raw | ConvertFrom-Json

$snapshotParent = Split-Path -Parent $SnapshotPath
$snapshotFile = Split-Path -Leaf $SnapshotPath
$dockerSnapshotParent = $snapshotParent.Replace("\", "/")

& docker run --rm `
  -v "newproject_hearthboard-data:/data" `
  -v "${dockerSnapshotParent}:/import" `
  alpine sh -lc "cp '/import/$snapshotFile' /data/store.json"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to copy standby snapshot into the local data volume."
}

Push-Location $projectRoot
try {
  & docker compose up -d postgres | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start local standby postgres."
  }

  $deadline = (Get-Date).AddMinutes(2)
  do {
    & docker compose exec -T postgres pg_isready -U hearthboard -d hearthboard *> $null
    if ($LASTEXITCODE -eq 0) {
      break
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  & docker compose exec -T postgres psql -U hearthboard -d hearthboard -c "DELETE FROM hearthboard_state WHERE store_id='primary';" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to clear local standby database state."
  }
} finally {
  Pop-Location
}

Write-Host "Imported standby snapshot from $SnapshotPath" -ForegroundColor Green
