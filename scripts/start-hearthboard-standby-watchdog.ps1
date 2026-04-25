Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "hearthboard-standby-watchdog.ps1"

Start-Process powershell.exe `
  -ArgumentList @(
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$scriptPath`""
  ) `
  -WindowStyle Hidden

Write-Host "Started the Hearthboard standby watchdog in the background." -ForegroundColor Green
