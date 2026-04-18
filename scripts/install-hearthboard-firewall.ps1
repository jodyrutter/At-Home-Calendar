Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  throw "Run this script from an elevated PowerShell window (Run as administrator)."
}

$rules = @(
  @{ Display = "Hearthboard HTTP 80"; Protocol = "TCP"; Port = "80" },
  @{ Display = "Hearthboard HTTPS 443"; Protocol = "TCP"; Port = "443" },
  @{ Display = "Hearthboard HTTPS Alt 42069"; Protocol = "TCP"; Port = "42069" },
  @{ Display = "Hearthboard HTTP3 443"; Protocol = "UDP"; Port = "443" }
)

foreach ($rule in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $rule.Display -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Firewall rule already exists: $($rule.Display)" -ForegroundColor Yellow
    continue
  }

  New-NetFirewallRule `
    -DisplayName $rule.Display `
    -Direction Inbound `
    -Action Allow `
    -Protocol $rule.Protocol `
    -LocalPort $rule.Port | Out-Null

  Write-Host "Added firewall rule: $($rule.Display)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Windows Firewall is now allowing inbound Hearthboard web traffic on ports 80, 443, and 42069." -ForegroundColor Green
