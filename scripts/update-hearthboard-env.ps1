param(
  [string]$PublicDomain = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"

function Get-EnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Lines,
    [Parameter(Mandatory = $true)]
    [string]$Key
  )

  $prefix = "$Key="
  foreach ($line in $Lines) {
    if ($line.StartsWith($prefix)) {
      return $line.Substring($prefix.Length)
    }
  }

  return ""
}

function Get-PreferredLanIp {
  $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown" -and
      $_.InterfaceAlias -notmatch "vEthernet|WSL|Loopback|Docker|Hyper-V|Default Switch"
    } |
    Sort-Object InterfaceMetric

  if (-not $candidates) {
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.PrefixOrigin -ne "WellKnown"
      } |
      Sort-Object InterfaceMetric
  }

  return $candidates | Select-Object -First 1 -ExpandProperty IPAddress
}

function Set-EnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Lines,
    [Parameter(Mandatory = $true)]
    [string]$Key,
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $pattern = "^{0}=" -f [Regex]::Escape($Key)
  $updated = $false

  for ($index = 0; $index -lt $Lines.Count; $index += 1) {
    if ($Lines[$index] -match $pattern) {
      $Lines[$index] = "$Key=$Value"
      $updated = $true
      break
    }
  }

  if (-not $updated) {
    $Lines += "$Key=$Value"
  }

  return ,$Lines
}

$lanIp = Get-PreferredLanIp
$siteAddresses = @("localhost", "127.0.0.1")
if ($lanIp) {
  $siteAddresses += $lanIp
}

$lines = @()
if (Test-Path $envPath) {
  $lines = [string[]](Get-Content -Path $envPath -ErrorAction Stop)
}

$lanIpValue = if ($lanIp) { $lanIp } else { "" }
$defaultSni = if ($lanIp) { $lanIp } else { "localhost" }
$existingPublicDomain = Get-EnvValue -Lines $lines -Key "HEARTHBOARD_PUBLIC_DOMAIN"
$resolvedPublicDomain = if ($PublicDomain) {
  $PublicDomain.Trim()
} elseif ($existingPublicDomain) {
  $existingPublicDomain.Trim()
} else {
  "jodyrutter-sh.duckdns.org"
}

$lines = Set-EnvValue -Lines $lines -Key "HEARTHBOARD_LOCAL_SITE_ADDRESSES" -Value ($siteAddresses -join " ")
$lines = Set-EnvValue -Lines $lines -Key "HEARTHBOARD_PUBLIC_DOMAIN" -Value $resolvedPublicDomain
$lines = Set-EnvValue -Lines $lines -Key "HEARTHBOARD_PRIMARY_LAN_IP" -Value $lanIpValue
$lines = Set-EnvValue -Lines $lines -Key "HEARTHBOARD_DEFAULT_SNI" -Value $defaultSni

Set-Content -Path $envPath -Value $lines -Encoding ASCII

[pscustomobject]@{
  envPath = $envPath
  lanIp = $lanIp
  siteAddresses = $siteAddresses
  publicDomain = $resolvedPublicDomain
} | ConvertTo-Json -Compress
