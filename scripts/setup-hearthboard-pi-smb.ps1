Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).
  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  throw "Run this script from an elevated PowerShell window."
}

$name = "hearthboardpi"
$chars = ("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789").ToCharArray()
$password = -join (1..24 | ForEach-Object { $chars[(Get-Random -Minimum 0 -Maximum $chars.Length)] })
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$account = "$env:COMPUTERNAME\$name"

$shareSpecs = @(
  @{ Name = "HearthDrone"; Path = "E:\Drone" },
  @{ Name = "HearthJapan"; Path = "D:\Home\Japan-photos" },
  @{ Name = "HearthGeneral"; Path = "D:\Home\Pictures" },
  @{ Name = "HearthPhone"; Path = "D:\Home\Phone-photos" },
  @{ Name = "HearthPhoneQuarantine"; Path = "D:\Home\Phone-photos-Quarantine" }
)

$existing = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if ($existing) {
  Set-LocalUser -Name $name -Password $secure
  Write-Host "Reset password for existing local user '$name'." -ForegroundColor Yellow
} else {
  New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires -Description "Read-only SMB account for Hearthboard Pi" | Out-Null
  Write-Host "Created local user '$name'." -ForegroundColor Green
}

foreach ($spec in $shareSpecs) {
  if (-not (Test-Path $spec.Path)) {
    Write-Warning "Skipping missing path $($spec.Path)"
    continue
  }

  if (-not (Get-SmbShare -Name $spec.Name -ErrorAction SilentlyContinue)) {
    New-SmbShare -Name $spec.Name -Path $spec.Path -ReadAccess $account -CachingMode None | Out-Null
    Write-Host "Created share $($spec.Name)." -ForegroundColor Green
  }

  Grant-SmbShareAccess -Name $spec.Name -AccountName $account -AccessRight Read -Force | Out-Null
  icacls $spec.Path /grant "${account}:(OI)(CI)RX" | Out-Null
}

if (-not (Get-NetFirewallRule -DisplayName "Hearthboard SMB from Pi" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule `
    -DisplayName "Hearthboard SMB from Pi" `
    -Direction Inbound `
    -Action Allow `
    -Enabled True `
    -Profile Private `
    -Protocol TCP `
    -LocalPort 445 `
    -RemoteAddress 192.168.1.220 | Out-Null
  Write-Host "Added firewall rule for Pi SMB access." -ForegroundColor Green
}

Write-Host ""
Write-Host "Use these SMB credentials on the Raspberry Pi:" -ForegroundColor Cyan
Write-Host "  Username: $name"
Write-Host "  Password: $password"
Write-Host ""
Write-Host "Shares:" -ForegroundColor Cyan
foreach ($spec in $shareSpecs) {
  Write-Host ("  //192.168.1.118/{0}" -f $spec.Name)
}
