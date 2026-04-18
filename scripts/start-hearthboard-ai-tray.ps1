Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$trayScript = Join-Path $projectRoot "scripts\hearthboard-ai-tray.ps1"

if (-not (Test-Path $trayScript)) {
  throw "Tray script not found at $trayScript"
}

Start-Process powershell.exe -ArgumentList @(
  "-NoProfile",
  "-WindowStyle", "Hidden",
  "-ExecutionPolicy", "Bypass",
  "-File", $trayScript
) | Out-Null
