Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "Hearthboard Auto Start"
$projectRoot = "C:\Users\jody4\OneDrive\Documents\New project"
$scriptPath = Join-Path $projectRoot "scripts\hearthboard-autostart.ps1"
$startupFolder = [Environment]::GetFolderPath("Startup")
$startupVbsPath = Join-Path $startupFolder "Hearthboard Auto Start.vbs"

if (-not (Test-Path $scriptPath)) {
  throw "Autostart script not found at $scriptPath"
}

function Install-StartupFolderEntry {
  $escapedScriptPath = $scriptPath.Replace("\", "\\")
  $startupScript = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$escapedScriptPath""", 0, False
"@

  Set-Content -Path $startupVbsPath -Value $startupScript -Encoding ASCII
  Write-Host "Installed startup-folder launcher at $startupVbsPath" -ForegroundColor Green
  Write-Host "Hearthboard will auto-start shortly after you sign into Windows." -ForegroundColor Green
}

try {
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = "PT45S"

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
  Write-Host "Hearthboard will auto-start about 45 seconds after you sign into Windows." -ForegroundColor Green
} catch {
  Write-Warning "Task Scheduler registration failed, so a Startup folder launcher is being installed instead."
  Install-StartupFolderEntry
}
