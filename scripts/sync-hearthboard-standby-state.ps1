param(
  [string]$PiSshTarget = $env:HEARTHBOARD_PI_SSH_TARGET,
  [string]$RemoteExportScript = $env:HEARTHBOARD_PI_EXPORT_SCRIPT,
  [string]$SnapshotPath = "",
  [switch]$MirrorToVolume
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$snapshotDir = Join-Path $PSScriptRoot "standby-state"
if (-not $SnapshotPath) {
  $SnapshotPath = Join-Path $snapshotDir "pi-store.json"
}

if (-not $PiSshTarget) {
  $PiSshTarget = "jodyrutter@192.168.1.220"
}

if (-not $RemoteExportScript) {
  $RemoteExportScript = "/home/jodyrutter/hearthboard/deploy/raspberry-pi/export-hearthboard-state.sh"
}

New-Item -ItemType Directory -Force -Path $snapshotDir | Out-Null
$tmpPath = "$SnapshotPath.tmp"
$metaPath = Join-Path (Split-Path -Parent $SnapshotPath) "pi-store.meta.json"

$raw = & ssh.exe $PiSshTarget $RemoteExportScript
if ($LASTEXITCODE -ne 0) {
  throw "ssh export failed with exit code $LASTEXITCODE."
}

if ([string]::IsNullOrWhiteSpace($raw)) {
  throw "Pi export returned no state."
}

$null = $raw | ConvertFrom-Json
[System.IO.File]::WriteAllText($tmpPath, $raw, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $tmpPath -Destination $SnapshotPath -Force

$meta = [ordered]@{
  syncedAt = [DateTime]::UtcNow.ToString("o")
  piSshTarget = $PiSshTarget
  remoteExportScript = $RemoteExportScript
  snapshotPath = $SnapshotPath
}
$meta | ConvertTo-Json | Set-Content -LiteralPath $metaPath -Encoding UTF8

if ($MirrorToVolume) {
  $snapshotParent = Split-Path -Parent $SnapshotPath
  $snapshotFile = Split-Path -Leaf $SnapshotPath
  $dockerSnapshotParent = $snapshotParent.Replace("\", "/")
  & docker run --rm `
    -v "newproject_hearthboard-data:/data" `
    -v "${dockerSnapshotParent}:/import" `
    alpine sh -lc "cp '/import/$snapshotFile' /data/store.json"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to mirror snapshot into the local standby data volume."
  }
}

Write-Host "Synced Pi standby snapshot to $SnapshotPath" -ForegroundColor Green
