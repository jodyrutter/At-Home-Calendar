$ErrorActionPreference = "Stop"

$password = Read-Host "Enter the remote-access password for Calendar and Jody AI" -AsSecureString
$confirm = Read-Host "Confirm the remote-access password" -AsSecureString

$ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
$confirmPtr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm)

try {
  $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $confirmPlain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($confirmPtr)
} finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  if ($confirmPtr -ne [IntPtr]::Zero) {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($confirmPtr)
  }
}

if ($plain -ne $confirmPlain) {
  throw "The passwords did not match."
}

if ($plain.Length -lt 8) {
  throw "Choose a password with at least 8 characters."
}

$payload = @{ password = $plain } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:42069/api/auth/password" -Method Post -ContentType "application/json" -Body $payload | Out-Null
Write-Host "Remote-access password updated for protected Hearthboard pages."
