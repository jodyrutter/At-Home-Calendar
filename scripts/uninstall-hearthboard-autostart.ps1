Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Hearthboard Auto Start"
$startupFolder = [Environment]::GetFolderPath("Startup")
$startupVbsPath = Join-Path $startupFolder "Hearthboard Auto Start.vbs"

try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Green
} catch {
}

if (Test-Path $startupVbsPath) {
  Remove-Item -LiteralPath $startupVbsPath -Force
  Write-Host "Removed startup-folder launcher." -ForegroundColor Green
}
