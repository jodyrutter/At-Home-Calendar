Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$exportScript = Join-Path $PSScriptRoot "export-hearthboard-local-ca.ps1"
$certificatePath = Join-Path $projectRoot "local-certs\hearthboard-local-root.crt"

& $exportScript | Out-Null

$certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)

try {
  $existing = $store.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint }
  if ($existing) {
    Write-Host "Hearthboard local root CA is already trusted for the current user." -ForegroundColor Yellow
  } else {
    $store.Add($certificate)
    Write-Host "Trusted Hearthboard local root CA for the current user." -ForegroundColor Green
  }
} finally {
  $store.Close()
}
