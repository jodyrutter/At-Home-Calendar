Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Hearthboard Standby Watchdog"
$projectRoot = "C:\Users\jody4\OneDrive\Documents\New project"
$scriptPath = Join-Path $projectRoot "scripts\hearthboard-standby-watchdog.ps1"

if (-not (Test-Path $scriptPath)) {
  throw "Standby watchdog script not found at $scriptPath"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT60S"

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -ErrorAction Stop `
  -Force | Out-Null

Write-Host "Installed scheduled task '$taskName'." -ForegroundColor Green
Write-Host "The Windows backup stack will now wake only if the Pi health check fails." -ForegroundColor Green
