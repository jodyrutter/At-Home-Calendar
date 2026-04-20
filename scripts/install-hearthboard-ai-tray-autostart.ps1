Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Installs a dedicated Windows logon task for the Hearthboard AI tray.
# Run this ONCE from an elevated PowerShell prompt:
#   powershell.exe -ExecutionPolicy Bypass -File ".\scripts\install-hearthboard-ai-tray-autostart.ps1"
#
# The task runs as the current interactive user, 30 s after logon, hidden.
# If Task Scheduler registration fails (for any reason), we fall back to a
# .vbs launcher in the Windows Startup folder so the tray still comes up.

$taskName       = "Hearthboard AI Tray"
$projectRoot    = "C:\Users\jody4\OneDrive\Documents\New project"
$scriptPath     = Join-Path $projectRoot "scripts\start-hearthboard-ai-tray.ps1"
$trayScript     = Join-Path $projectRoot "scripts\hearthboard-ai-tray.ps1"
$startupFolder  = [Environment]::GetFolderPath("Startup")
$startupVbsPath = Join-Path $startupFolder "Hearthboard AI Tray.vbs"

Write-Host ""
Write-Host "Hearthboard AI tray autostart installer" -ForegroundColor Cyan
Write-Host "----------------------------------------" -ForegroundColor Cyan
Write-Host "Launcher script : $scriptPath"
Write-Host "Tray script     : $trayScript"
Write-Host "Task name       : $taskName"
Write-Host "Running as      : $env:USERDOMAIN\$env:USERNAME"
Write-Host ""

if (-not (Test-Path $scriptPath)) {
  throw "Launcher script not found at $scriptPath"
}
if (-not (Test-Path $trayScript)) {
  throw "Tray script not found at $trayScript"
}

function Install-StartupFolderEntry {
  $escapedScriptPath = $scriptPath.Replace("\", "\\")
  $startupScript = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$escapedScriptPath""", 0, False
"@

  Set-Content -Path $startupVbsPath -Value $startupScript -Encoding ASCII
  Write-Host "Installed Startup-folder launcher at:" -ForegroundColor Green
  Write-Host "  $startupVbsPath" -ForegroundColor Green
}

try {
  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = "PT30S"

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

  $principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

  Register-ScheduledTask `
    -TaskName $taskName `
    -Description "Launches the Hearthboard AI tray (hidden) ~30 seconds after you sign in." `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -ErrorAction Stop `
    -Force | Out-Null

  Write-Host "Registered scheduled task '$taskName'." -ForegroundColor Green
  Write-Host "The tray will start about 30 seconds after you sign into Windows." -ForegroundColor Green

  # Also drop a Startup-folder entry as a belt-and-suspenders fallback. It's
  # harmless if both fire: hearthboard-ai-tray.ps1 is idempotent because
  # start-hearthboard-ai-tray.ps1 just calls Start-Process on the tray script
  # and the tray checks for an existing instance.
  Install-StartupFolderEntry

  Write-Host ""
  Write-Host "Run it right now with:" -ForegroundColor Cyan
  Write-Host "  Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "See it in Task Scheduler (taskschd.msc) under Task Scheduler Library." -ForegroundColor DarkGray
} catch {
  Write-Warning "Task Scheduler registration failed: $($_.Exception.Message)"
  Write-Warning "Falling back to the Startup folder."
  Install-StartupFolderEntry
}
