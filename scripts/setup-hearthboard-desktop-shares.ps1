Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$shareSpecs = @(
  @{ Name = "HearthDrone"; Path = "E:\Drone" },
  @{ Name = "HearthJapan"; Path = "D:\Home\Japan-photos" },
  @{ Name = "HearthGeneral"; Path = "D:\Home\Pictures" },
  @{ Name = "HearthPhone"; Path = "D:\Home\Phone-photos" },
  @{ Name = "HearthPhoneQuarantine"; Path = "D:\Home\Phone-photos-Quarantine" }
)

$accountName = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }

foreach ($spec in $shareSpecs) {
  if (-not (Test-Path $spec.Path)) {
    Write-Warning "Skipping missing path $($spec.Path)"
    continue
  }

  $existing = Get-SmbShare -Name $spec.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Share already exists: $($spec.Name) -> $($existing.Path)" -ForegroundColor Yellow
    continue
  }

  New-SmbShare `
    -Name $spec.Name `
    -Path $spec.Path `
    -ReadAccess $accountName `
    -CachingMode None | Out-Null

  Write-Host "Created share $($spec.Name) -> $($spec.Path)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Use these SMB share paths from the Raspberry Pi:" -ForegroundColor Cyan
foreach ($spec in $shareSpecs) {
  Write-Host ("  //192.168.1.118/{0}" -f $spec.Name)
}
