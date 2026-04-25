param(
  [string]$PiBaseUrl = $env:HEARTHBOARD_PI_BASE_URL,
  [string]$RunnerLabel = $env:HEARTHBOARD_SPEEDTEST_RUNNER_LABEL,
  [string]$Profile = "hourly"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot "desktop-speedtest.log"
$nodeScriptPath = Join-Path $PSScriptRoot "run-hearthboard-speedtest.mjs"
$envPath = Join-Path $projectRoot ".env"

function Resolve-NodePath {
  $candidate = (Get-Command node -ErrorAction SilentlyContinue)
  if ($candidate -and $candidate.Source) {
    return $candidate.Source
  }

  $default = "C:\Program Files\nodejs\node.exe"
  if (Test-Path $default) {
    return $default
  }

  throw "Unable to locate node.exe for desktop speedtest."
}

function Write-SpeedtestLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $logPath -Value $line -Encoding ASCII
}

function Read-DotEnv {
  param([string]$Path)
  $map = @{}
  if (-not (Test-Path $Path)) {
    return $map
  }

  foreach ($line in Get-Content -Path $Path) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line.TrimStart().StartsWith("#")) { continue }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    $map[$key] = $value
  }
  return $map
}

function Get-SpeedtestPushKey {
  param([string]$Secret)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("hearthboard-speedtest-push`0" + $Secret)
    $hash = $sha.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

if (-not (Test-Path $nodeScriptPath)) {
  throw "Speedtest runner not found at $nodeScriptPath"
}

$nodePath = Resolve-NodePath

$envMap = Read-DotEnv -Path $envPath
$resolvedBaseUrl = if ($PiBaseUrl) {
  $PiBaseUrl
} elseif ($envMap.ContainsKey("HEARTHBOARD_PI_BASE_URL")) {
  $envMap["HEARTHBOARD_PI_BASE_URL"]
} else {
  "https://192.168.1.220:42069"
}

$resolvedRunnerLabel = if ($RunnerLabel) {
  $RunnerLabel
} elseif ($envMap.ContainsKey("HEARTHBOARD_DESKTOP_SPEEDTEST_LABEL")) {
  $envMap["HEARTHBOARD_DESKTOP_SPEEDTEST_LABEL"]
} else {
  "Desktop PC"
}

$pushSecret = if ($env:HEARTHBOARD_SPEEDTEST_PUSH_SECRET) {
  $env:HEARTHBOARD_SPEEDTEST_PUSH_SECRET
} elseif ($envMap.ContainsKey("SPEEDTEST_PUSH_SECRET")) {
  $envMap["SPEEDTEST_PUSH_SECRET"]
} elseif ($envMap.ContainsKey("INTEGRATION_TOKEN_ENCRYPTION_KEY")) {
  $envMap["INTEGRATION_TOKEN_ENCRYPTION_KEY"]
} else {
  ""
}

if (-not $pushSecret) {
  throw "Missing speedtest push secret. Set SPEEDTEST_PUSH_SECRET or INTEGRATION_TOKEN_ENCRYPTION_KEY in .env."
}

$pushKey = Get-SpeedtestPushKey -Secret $pushSecret

Write-SpeedtestLog ("Starting hourly desktop speedtest against the open internet (profile={0})." -f $Profile)
$rawSample = & $nodePath $nodeScriptPath --profile $Profile 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Desktop speedtest failed: $rawSample"
}

$sample = $rawSample | ConvertFrom-Json
$payloadObject = [ordered]@{
  downloadMbps = [double]$sample.downloadMbps
  uploadMbps = [double]$sample.uploadMbps
  latencyMs = [double]$sample.latencyMs
  source = "internet"
  target = [string]$sample.target
  serverLocation = [string]$sample.serverLocation
  runner = [string]$resolvedRunnerLabel
  client = "desktop"
}
$payloadJson = $payloadObject | ConvertTo-Json -Compress
$payloadPath = [System.IO.Path]::GetTempFileName()

try {
  Set-Content -Path $payloadPath -Value $payloadJson -Encoding UTF8 -NoNewline
  $result = & curl.exe -k -fsS --max-time 90 `
    -X POST `
    "$resolvedBaseUrl/api/speedtest/results" `
    -H "Content-Type: application/json" `
    -H "X-Hearthboard-Speedtest-Key: $pushKey" `
    --data-binary "@$payloadPath" 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to push desktop speedtest to Pi: $result"
  }
  Write-SpeedtestLog (
    "Pushed desktop sample ({0} down / {1} up / {2} ms) to {3}." -f
      $sample.downloadMbps, $sample.uploadMbps, $sample.latencyMs, $resolvedBaseUrl
  )
} finally {
  Remove-Item -LiteralPath $payloadPath -ErrorAction SilentlyContinue
}
