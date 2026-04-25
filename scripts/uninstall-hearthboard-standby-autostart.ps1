Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Hearthboard Standby Watchdog"

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Green
} else {
  Write-Host "Scheduled task '$taskName' was not installed." -ForegroundColor Yellow
}
