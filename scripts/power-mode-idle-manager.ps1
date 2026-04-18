Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class IdleInterop {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
  }

  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\HearthboardPowerModeIdleManager", [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  exit 0
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot "logs"
$logPath = Join-Path $logDirectory "power-mode-idle-manager.log"
$idleThresholdSeconds = 30 * 60
$activeReturnThresholdSeconds = 60
$pollIntervalSeconds = 30
$balancedGuid = "381b4222-f694-41f0-9685-ff5bb260df2e"
$ultimateTemplateGuid = "e9a42b02-d5df-448d-aa00-03f14749eb61"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-Log {
  param([string]$Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logPath -Value "[$timestamp] $Message"
}

function Get-IdleSeconds {
  $info = [IdleInterop+LASTINPUTINFO]::new()
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][IdleInterop+LASTINPUTINFO])
  [IdleInterop]::GetLastInputInfo([ref]$info) | Out-Null
  $elapsed = [uint32][Environment]::TickCount - [uint32]$info.dwTime

  return [math]::Floor(([double]$elapsed) / 1000)
}

function Get-PowerSchemeMap {
  $schemes = @{}
  $output = powercfg /list
  foreach ($line in $output) {
    if ($line -match "Power Scheme GUID:\s+([a-f0-9-]+)\s+\((.+?)\)") {
      $schemes[$matches[2]] = $matches[1]
    }
  }

  return $schemes
}

function Ensure-UltimatePerformanceGuid {
  $schemes = Get-PowerSchemeMap
  if ($schemes.ContainsKey("Ultimate Performance")) {
    return $schemes["Ultimate Performance"]
  }

  Write-Log "Ultimate Performance plan was missing. Attempting to create it."
  powercfg -duplicatescheme $ultimateTemplateGuid | Out-Null
  Start-Sleep -Seconds 1
  $schemes = Get-PowerSchemeMap
  if ($schemes.ContainsKey("Ultimate Performance")) {
    Write-Log "Ultimate Performance plan was created successfully."
    return $schemes["Ultimate Performance"]
  }

  throw "Ultimate Performance plan could not be found or created."
}

function Get-ActiveSchemeGuid {
  $output = powercfg /getactivescheme
  foreach ($line in $output) {
    if ($line -match "Power Scheme GUID:\s+([a-f0-9-]+)") {
      return $matches[1]
    }
  }

  return ""
}

function Set-ActiveScheme {
  param(
    [string]$Guid,
    [string]$Label
  )

  $current = Get-ActiveSchemeGuid
  if ($current -ieq $Guid) {
    return $false
  }

  powercfg /setactive $Guid | Out-Null
  Write-Log "Switched power plan to $Label."
  return $true
}

$ultimateGuid = Ensure-UltimatePerformanceGuid
$idleSwitchedToBalanced = $false

Write-Log "Power mode idle manager started."
[void](Set-ActiveScheme -Guid $ultimateGuid -Label "Ultimate Performance")

try {
  while ($true) {
    $idleSeconds = Get-IdleSeconds

    if (-not $idleSwitchedToBalanced -and $idleSeconds -ge $idleThresholdSeconds) {
      if (Set-ActiveScheme -Guid $balancedGuid -Label "Balanced") {
        $idleSwitchedToBalanced = $true
      } else {
        $idleSwitchedToBalanced = ($idleSeconds -ge $idleThresholdSeconds)
      }
    } elseif ($idleSwitchedToBalanced -and $idleSeconds -le $activeReturnThresholdSeconds) {
      if (Set-ActiveScheme -Guid $ultimateGuid -Label "Ultimate Performance") {
        $idleSwitchedToBalanced = $false
      } else {
        $idleSwitchedToBalanced = $false
      }
    }

    Start-Sleep -Seconds $pollIntervalSeconds
  }
} finally {
  Write-Log "Power mode idle manager stopped."
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}
