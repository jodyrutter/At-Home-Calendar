param(
    [switch]$StopParsec
)

$ErrorActionPreference = "SilentlyContinue"

Write-Host "Preparing a cleaner gaming session..." -ForegroundColor Cyan

$processNames = @(
    "Overwolf",
    "OverwolfBrowser",
    "OverwolfHelper",
    "OverwolfHelper64",
    "Discord",
    "NVIDIA Overlay",
    "btweb"
)

foreach ($name in $processNames) {
    $procs = Get-Process -Name $name
    if ($procs) {
        $procs | Stop-Process -Force
        Write-Host "Stopped $name" -ForegroundColor Yellow
    }
}

if ($StopParsec) {
    $parsecService = Get-Service -Name "Parsec"
    if ($parsecService -and $parsecService.Status -eq "Running") {
        Stop-Service -Name "Parsec" -Force
        Write-Host "Stopped Parsec service" -ForegroundColor Yellow
    }

    Get-Process -Name "parsecd" | Stop-Process -Force
}

Write-Host ""
Write-Host "Cleanup complete." -ForegroundColor Green
Write-Host "League/Vanguard will still start normally when launched." -ForegroundColor Green
if (-not $StopParsec) {
    Write-Host "Tip: run with -StopParsec if you are not using Parsec for that session." -ForegroundColor DarkGray
}
