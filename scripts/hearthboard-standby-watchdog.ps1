param(
  [string]$PiHealthUrl = $env:HEARTHBOARD_PI_HEALTH_URL,
  [string]$PiSshTarget = $env:HEARTHBOARD_PI_SSH_TARGET,
  [string]$RemoteExportScript = $env:HEARTHBOARD_PI_EXPORT_SCRIPT,
  [int]$CheckIntervalSeconds = 300,
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot "hearthboard-standby-watchdog.log"
$piUrl = if ($PiHealthUrl) { $PiHealthUrl } else { "https://192.168.1.220:42069/api/health" }
$piSshTarget = if ($PiSshTarget) { $PiSshTarget } else { "jodyrutter@192.168.1.220" }
$remoteExportScript = if ($RemoteExportScript) { $RemoteExportScript } else { "/home/jodyrutter/hearthboard/deploy/raspberry-pi/export-hearthboard-state.sh" }
$snapshotPath = Join-Path $PSScriptRoot "standby-state\pi-store.json"
$syncScriptPath = Join-Path $PSScriptRoot "sync-hearthboard-standby-state.ps1"
$importScriptPath = Join-Path $PSScriptRoot "import-hearthboard-standby-state.ps1"

function Write-StandbyLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding ASCII
}

function Test-PiHealthy {
  $null = & curl.exe -k -fsS --max-time 12 $piUrl 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Get-RunningComposeServices {
  Push-Location $projectRoot
  try {
    $services = & docker compose ps --services --status running 2>$null
    if ($LASTEXITCODE -ne 0) {
      return @()
    }
    return @($services | Where-Object { $_ })
  } finally {
    Pop-Location
  }
}

function Sync-StandbySnapshot {
  if (-not (Test-Path $syncScriptPath)) {
    throw "Standby sync script not found at $syncScriptPath"
  }

  Write-StandbyLog "Pi is healthy. Syncing standby snapshot from the Pi."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScriptPath -PiSshTarget $piSshTarget -RemoteExportScript $remoteExportScript -SnapshotPath $snapshotPath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Standby snapshot sync failed."
  }
}

function Start-BackupStack {
  Push-Location $projectRoot
  try {
    if (Test-Path $snapshotPath) {
      if (-not (Test-Path $importScriptPath)) {
        throw "Standby import script not found at $importScriptPath"
      }

      Write-StandbyLog "Restoring the latest Pi snapshot into the Windows backup store."
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $importScriptPath -SnapshotPath $snapshotPath | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "Standby snapshot import failed."
      }
    } else {
      Write-StandbyLog "No Pi snapshot found yet. Starting backup stack with the last local standby state."
    }

    Write-StandbyLog "Pi is unavailable. Starting Windows backup stack."
    & docker compose up -d --build hearthboard caddy | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "docker compose up failed."
    }
  } finally {
    Pop-Location
  }
}

function Stop-BackupStack {
  Push-Location $projectRoot
  try {
    Write-StandbyLog "Pi is healthy again. Stopping Windows backup stack."
    & docker compose down | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "docker compose down failed."
    }
  } finally {
    Pop-Location
  }
}

Write-StandbyLog ("Standby watchdog started. Checking {0} every {1}s." -f $piUrl, $CheckIntervalSeconds)

while ($true) {
  $piHealthy = $false

  try {
    $piHealthy = Test-PiHealthy
  } catch {
    $piHealthy = $false
    Write-StandbyLog ("Pi health check failed: {0}" -f $_.Exception.Message)
  }

  $runningServices = @(Get-RunningComposeServices)
  $backupRunning = $runningServices.Count -gt 0

  if ($piHealthy) {
    try {
      Sync-StandbySnapshot
    } catch {
      Write-StandbyLog ("Standby snapshot sync failed: {0}" -f $_.Exception.Message)
    }

    if ($backupRunning) {
      Stop-BackupStack
    } else {
      Write-StandbyLog "Pi is healthy. Windows backup stack stays offline."
    }
  } else {
    if (-not $backupRunning) {
      Start-BackupStack
    } else {
      Write-StandbyLog "Pi is still unavailable. Windows backup stack stays online."
    }
  }

  if ($Once) {
    break
  }

  Start-Sleep -Seconds $CheckIntervalSeconds
}
