Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName       = "Hearthboard AI Tray"
$startupFolder  = [Environment]::GetFolderPath("Startup")
$startupVbsPath = Join-Path $startupFolder "Hearthboard AI Tray.vbs"

try {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Green
  } else {
    Write-Host "No scheduled task named '$taskName' was found." -ForegroundColor DarkGray
  }
} catch {
  Write-Warning "Could not remove scheduled task: $($_.Exception.Message)"
}

if (Test-Path $startupVbsPath) {
  Remove-Item -Path $startupVbsPath -Force
  Write-Host "Removed Startup-folder launcher at $startupVbsPath" -ForegroundColor Green
} else {
  Write-Host "No Startup-folder launcher was found." -ForegroundColor DarkGray
}
