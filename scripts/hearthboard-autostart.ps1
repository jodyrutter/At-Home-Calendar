Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = "C:\Users\jody4\OneDrive\Documents\New project"
$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
$logDirectory = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDirectory "hearthboard-autostart.log"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-Log {
  param([string]$Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logPath -Value "[$timestamp] $Message"
}

function Wait-ForDocker {
  param([int]$TimeoutSeconds = 180)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  while ((Get-Date) -lt $deadline) {
    try {
      docker info | Out-Null
      Write-Log "Docker daemon is ready."
      return $true
    } catch {
      Start-Sleep -Seconds 5
    }
  }

  return $false
}

Write-Log "Autostart task invoked."

if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
  if (Test-Path $dockerDesktopPath) {
    Write-Log "Starting Docker Desktop."
    Start-Process -FilePath $dockerDesktopPath
  } else {
    Write-Log "Docker Desktop executable was not found."
    throw "Docker Desktop executable was not found."
  }
} else {
  Write-Log "Docker Desktop process is already running."
}

if (-not (Wait-ForDocker)) {
  Write-Log "Docker daemon did not become ready in time."
  throw "Docker daemon did not become ready in time."
}

Set-Location $projectRoot
try {
  & (Join-Path $projectRoot "scripts\update-hearthboard-env.ps1") | Out-Null
  Write-Log "Refreshed Hearthboard HTTPS host settings."
} catch {
  Write-Log "Could not refresh Hearthboard HTTPS host settings automatically."
}

try {
  docker compose up -d | Out-Null
  Write-Log "Hearthboard started with docker compose up -d."
} catch {
  Write-Log "Standard startup failed, retrying with build."
  docker compose up --build -d | Out-Null
  Write-Log "Hearthboard started after rebuild."
}
