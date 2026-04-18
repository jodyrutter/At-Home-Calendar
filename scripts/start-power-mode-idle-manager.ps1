Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$managerScript = Join-Path $projectRoot "scripts\power-mode-idle-manager.ps1"

if (-not (Test-Path $managerScript)) {
  throw "Power mode idle manager script not found at $managerScript"
}

Start-Process powershell.exe -ArgumentList @(
  "-NoProfile",
  "-WindowStyle", "Hidden",
  "-ExecutionPolicy", "Bypass",
  "-File", $managerScript
) | Out-Null
