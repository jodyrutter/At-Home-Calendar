Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Hearthboard Desktop Speedtest Push"
$projectRoot = "C:\Users\jody4\OneDrive\Documents\New project"
$launcherPath = Join-Path $projectRoot "scripts\run-desktop-speedtest.cmd"
$workingDir = Join-Path $projectRoot "scripts"
$description = "Runs an hourly desktop internet speed test and pushes the result to the Hearthboard Pi."
$currentUser = "$env:COMPUTERNAME\$env:USERNAME"

if (-not (Test-Path $launcherPath)) {
  throw "Desktop speedtest launcher not found at $launcherPath"
}

try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
} catch {}

$startTime = (Get-Date).AddMinutes(1).ToString("HH:mm")

& schtasks.exe /Create `
  /TN $taskName `
  /SC HOURLY `
  /MO 1 `
  /ST $startTime `
  /TR $launcherPath `
  /RU $currentUser `
  /RL LIMITED `
  /F | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Failed to register scheduled task '$taskName'."
}

& schtasks.exe /Run /TN $taskName | Out-Null

Write-Host "Installed scheduled task '$taskName'." -ForegroundColor Green
Write-Host "This PC will now run an internet speed test hourly and push the result to the Pi." -ForegroundColor Green
