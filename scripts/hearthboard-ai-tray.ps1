# Hearthboard tray: monitors Jody AI, lets Jody flip its policy from the system
# tray, and (optionally) auto-restricts Jody AI whenever a listed game is
# running so the GPU is free for gaming.
#
# Run with:
#   powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass `
#     -File ".\scripts\hearthboard-ai-tray.ps1"
#
# Logs: scripts\hearthboard-ai-tray.log (rolling, trimmed at 256 KB).
# Settings: scripts\hearthboard-ai-tray.settings.json (auto-created).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------- Paths & logging (set up FIRST so startup errors are captured) ----
$projectRoot = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot "hearthboard-ai-tray.log"
$settingsPath = Join-Path $PSScriptRoot "hearthboard-ai-tray.settings.json"

function Write-TrayLog {
  param(
    [string]$Message,
    [ValidateSet("info", "warn", "error")]
    [string]$Level = "info"
  )
  try {
    if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 262144)) {
      Remove-Item $logPath -Force -ErrorAction SilentlyContinue
    }
    $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    Add-Content -Path $logPath -Value "[$stamp] [$Level] $Message" -ErrorAction SilentlyContinue
  } catch {
    # Swallow — logging must never kill the tray.
  }
}

# Capture any uncaught terminating errors so the hidden powershell window does
# not disappear without leaving a breadcrumb.
trap {
  Write-TrayLog "Uncaught error: $($_.Exception.Message)" "error"
  Write-TrayLog "StackTrace: $($_.ScriptStackTrace)" "error"
  continue
}

Write-TrayLog "Tray starting. projectRoot=$projectRoot"

# ---------- Winforms + icon plumbing ---------------------------------------
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-TrayLog "Failed to load System.Windows.Forms / System.Drawing: $($_.Exception.Message)" "error"
  throw
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class HearthboardTrayNative {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
"@

# ---------- Single-instance mutex ------------------------------------------
$createdNew = $false
$mutex = $null
try {
  $mutex = [System.Threading.Mutex]::new($true, "Local\HearthboardAiTray", [ref]$createdNew)
} catch {
  Write-TrayLog "Mutex creation failed: $($_.Exception.Message)" "error"
  throw
}
if (-not $createdNew) {
  Write-TrayLog "Another tray instance is already running. Exiting."
  if ($null -ne $mutex) { $mutex.Dispose() }
  exit 0
}

# ---------- Constants -------------------------------------------------------
$baseUrl = "http://127.0.0.1:42070"
$statusEndpoint = "$baseUrl/api/local-ai/status"
$policyEndpoint = "$baseUrl/api/local-ai/policy"
$assistantUrl = "https://127.0.0.1:42069/assistant"

# Default game process names (no .exe suffix, case-insensitive). Covers the
# League of Legends client, the game itself, and a few friends.
$defaultGameProcesses = @(
  "LeagueClient",
  "LeagueClientUx",
  "League of Legends",
  "RiotClientServices",
  "RiotClientUx",
  "VALORANT",
  "VALORANT-Win64-Shipping",
  "csgo",
  "cs2",
  "Overwatch",
  "destiny2",
  "FortniteClient-Win64-Shipping",
  "Dota2",
  "WoW",
  "WoWClassic"
)

# ---------- Settings persistence --------------------------------------------
function Get-TraySettings {
  $defaults = [pscustomobject]@{
    autoRestrictWhileGaming = $true
    gameProcessNames = $defaultGameProcesses
  }

  if (-not (Test-Path $settingsPath)) {
    return $defaults
  }

  try {
    $raw = Get-Content $settingsPath -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $defaults }
    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop

    if (-not $parsed.PSObject.Properties.Match("autoRestrictWhileGaming").Count) {
      $parsed | Add-Member -NotePropertyName autoRestrictWhileGaming -NotePropertyValue $true -Force
    }
    if (-not $parsed.PSObject.Properties.Match("gameProcessNames").Count -or -not $parsed.gameProcessNames) {
      $parsed | Add-Member -NotePropertyName gameProcessNames -NotePropertyValue $defaultGameProcesses -Force
    }
    return $parsed
  } catch {
    Write-TrayLog "Failed to parse settings, using defaults: $($_.Exception.Message)" "warn"
    return $defaults
  }
}

function Save-TraySettings {
  param([object]$Settings)
  try {
    ($Settings | ConvertTo-Json -Depth 5) | Set-Content -Path $settingsPath -Encoding UTF8
  } catch {
    Write-TrayLog "Failed to save settings: $($_.Exception.Message)" "warn"
  }
}

$script:settings = Get-TraySettings
Write-TrayLog "Settings loaded. autoRestrictWhileGaming=$($script:settings.autoRestrictWhileGaming)"

# ---------- Icon factory ----------------------------------------------------
function ConvertTo-Icon {
  param(
    [System.Drawing.Color]$Color,
    [string]$Symbol
  )

  $bitmap = [System.Drawing.Bitmap]::new(16, 16)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(50, 15, 23, 42))
  $graphics.FillEllipse($shadowBrush, 1, 2, 13, 13)
  $shadowBrush.Dispose()

  $fillBrush = [System.Drawing.SolidBrush]::new($Color)
  $graphics.FillEllipse($fillBrush, 1, 1, 13, 13)
  $fillBrush.Dispose()

  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(170, 255, 255, 255), 1.2)
  $graphics.DrawEllipse($pen, 1.4, 1.4, 12, 12)
  $pen.Dispose()

  if ($Symbol -eq "check") {
    $symbolPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 2.2)
    $symbolPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $symbolPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLines($symbolPen, [System.Drawing.Point[]]@(
      [System.Drawing.Point]::new(4, 8),
      [System.Drawing.Point]::new(7, 11),
      [System.Drawing.Point]::new(12, 5)
    ))
    $symbolPen.Dispose()
  } elseif ($Symbol -eq "x") {
    $symbolPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 2.1)
    $symbolPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $symbolPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($symbolPen, 4, 4, 11, 11)
    $graphics.DrawLine($symbolPen, 11, 4, 4, 11)
    $symbolPen.Dispose()
  } elseif ($Symbol -eq "game") {
    # Tiny controller silhouette (two dots + connector).
    $symbolBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $graphics.FillEllipse($symbolBrush, 3, 7, 4, 4)
    $graphics.FillEllipse($symbolBrush, 9, 7, 4, 4)
    $symbolBrush.Dispose()
    $connectPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 2)
    $graphics.DrawLine($connectPen, 6, 9, 10, 9)
    $connectPen.Dispose()
  } elseif ($Symbol) {
    $font = [System.Drawing.Font]::new("Segoe UI", 7.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString($Symbol, $font, $textBrush, [System.Drawing.RectangleF]::new(0, 0, 16, 16), $format)
    $format.Dispose()
    $textBrush.Dispose()
    $font.Dispose()
  }

  $graphics.Dispose()
  $handle = $bitmap.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle).Clone()
  [HearthboardTrayNative]::DestroyIcon($handle) | Out-Null
  $bitmap.Dispose()
  return $icon
}

# ---------- HTTP helpers ----------------------------------------------------
function Invoke-LocalAiApi {
  param(
    [ValidateSet("GET", "POST")]
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null
  )

  $parameters = @{
    Method = $Method
    Uri = $Uri
    TimeoutSec = 8
    Headers = @{ "Accept" = "application/json" }
  }

  if ($null -ne $Body) {
    $parameters["ContentType"] = "application/json"
    $parameters["Body"] = ($Body | ConvertTo-Json -Compress)
  }

  Invoke-RestMethod @parameters
}

function Normalize-StatusSnapshot {
  param([object]$Status)

  if ($null -eq $Status) {
    $Status = [pscustomobject]@{}
  }

  if (-not $Status.PSObject.Properties.Match("appReachable").Count) {
    $Status | Add-Member -NotePropertyName appReachable -NotePropertyValue $true -Force
  }

  return $Status
}

function Get-StatusSnapshot {
  try {
    $status = Invoke-LocalAiApi -Method GET -Uri $statusEndpoint
    return (Normalize-StatusSnapshot -Status $status)
  } catch {
    Write-TrayLog "Status fetch failed: $($_.Exception.Message)" "warn"
    return (Normalize-StatusSnapshot -Status ([pscustomobject]@{
      name = "Jody AI"
      appReachable = $false
      reachable = $false
      ready = $false
      loaded = $false
      localAiAllowed = $true
      error = "Hearthboard is unavailable right now."
    }))
  }
}

# ---------- Icons -----------------------------------------------------------
$icons = @{
  available = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(33, 166, 117)) -Symbol "check"
  offline = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(188, 57, 57)) -Symbol "x"
  needsModel = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(219, 132, 35)) -Symbol "?"
  restricted = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(188, 57, 57)) -Symbol "x"
  gaming = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(88, 101, 242)) -Symbol "game"
}

# ---------- Tray construction -----------------------------------------------
$notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$notifyIcon.Icon = $icons.needsModel
$notifyIcon.Visible = $true
$notifyIcon.Text = "Hearthboard (starting...)"

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$statusItem = $menu.Items.Add("Checking Jody AI...")
$statusItem.Enabled = $false
[void]$menu.Items.Add("-")
$allowItem = $menu.Items.Add("Jody AI allow")
$restrictItem = $menu.Items.Add("Jody AI restrict")
[void]$menu.Items.Add("-")
$autoRestrictItem = $menu.Items.Add("Auto-restrict while gaming")
$autoRestrictItem.CheckOnClick = $true
$autoRestrictItem.Checked = [bool]$script:settings.autoRestrictWhileGaming
$gamingStatusItem = $menu.Items.Add("No games detected")
$gamingStatusItem.Enabled = $false
[void]$menu.Items.Add("-")
$refreshItem = $menu.Items.Add("Refresh now")
$openItem = $menu.Items.Add("Open Jody AI")
$openLogItem = $menu.Items.Add("Open tray log")
[void]$menu.Items.Add("-")
$exitItem = $menu.Items.Add("Exit tray")
$notifyIcon.ContextMenuStrip = $menu

# ---------- State -----------------------------------------------------------
$script:lastStatus = $null
$script:restrictedByAuto = $false   # did WE flip to restricted because of a game?
$script:lastGameList = @()           # last detected game process names
$script:gamingActive = $false        # is a game currently running?
$script:suppressAutoUntil = $null    # after manual allow, don't auto-restrict again during the same gaming session

# ---------- Visual update ---------------------------------------------------
function Update-TrayVisual {
  param([object]$Status)

  $Status = Normalize-StatusSnapshot -Status $Status
  $script:lastStatus = $Status
  $title = if ($Status.PSObject.Properties.Match("name").Count -and $Status.name) { [string]$Status.name } else { "Jody AI" }
  $appReachable = $Status.appReachable -ne $false

  $allowItem.Checked = $false
  $restrictItem.Checked = $false
  $allowItem.Enabled = $false
  $restrictItem.Enabled = $false

  if (-not $appReachable) {
    $notifyIcon.Icon = $icons.offline
    $statusItem.Text = "Hearthboard is unavailable"
    $notifyIcon.Text = "Hearthboard unavailable"
    return
  }

  $isAllowed = $Status.PSObject.Properties.Match("localAiAllowed").Count -and ($Status.localAiAllowed -ne $false)

  if (-not $isAllowed) {
    if ($script:gamingActive -and $script:restrictedByAuto) {
      $notifyIcon.Icon = $icons.gaming
      $statusItem.Text = "$title paused for gaming"
      $notifyIcon.Text = "Hearthboard: Jody AI paused for gaming"
    } else {
      $notifyIcon.Icon = $icons.restricted
      $statusItem.Text = "$title is restricted"
      $notifyIcon.Text = "Hearthboard: Jody AI restricted"
    }
    $allowItem.Enabled = $true
    $restrictItem.Checked = $true
    return
  }

  $allowItem.Checked = $true
  $restrictItem.Enabled = $true

  $reachable = $Status.PSObject.Properties.Match("reachable").Count -and $Status.reachable
  $ready = $Status.PSObject.Properties.Match("ready").Count -and $Status.ready
  $loaded = $Status.PSObject.Properties.Match("loaded").Count -and $Status.loaded

  if (-not $reachable) {
    $notifyIcon.Icon = $icons.offline
    $statusItem.Text = "$title is offline"
    $notifyIcon.Text = "Hearthboard: Jody AI offline"
    return
  }

  if (-not $ready) {
    $notifyIcon.Icon = $icons.needsModel
    $statusItem.Text = "$title needs a model"
    $notifyIcon.Text = "Hearthboard: Jody AI needs setup"
    return
  }

  $notifyIcon.Icon = $icons.available
  if ($loaded) {
    $statusItem.Text = "$title is awake"
    $notifyIcon.Text = "Hearthboard: Jody AI awake"
    return
  }

  $statusItem.Text = "$title is sleeping"
  $notifyIcon.Text = "Hearthboard: Jody AI sleeping"
}

function Refresh-Status {
  Update-TrayVisual -Status (Get-StatusSnapshot)
}

# ---------- Policy flip -----------------------------------------------------
function Set-LocalAiPolicy {
  param(
    [bool]$Allowed,
    [switch]$Silent,
    [switch]$FromAuto
  )

  try {
    $payload = Invoke-LocalAiApi -Method POST -Uri $policyEndpoint -Body @{ allowed = $Allowed }
    Update-TrayVisual -Status $payload.status
    Write-TrayLog "Policy set. allowed=$Allowed fromAuto=$FromAuto"

    if (-not $Silent) {
      $message = if ($Allowed) {
        if ($FromAuto) { "Jody AI is allowed again now that your game has closed." }
        else { "Jody AI is allowed again and can start when requested." }
      } else {
        if ($FromAuto) { "Jody AI paused so your game keeps the GPU. It will resume when the game closes." }
        else { "Jody AI is now restricted and cannot start or wake until you allow it again." }
      }
      $notifyIcon.ShowBalloonTip(
        1500,
        "Hearthboard",
        $message,
        [System.Windows.Forms.ToolTipIcon]::Info
      )
    }
    return $true
  } catch {
    Write-TrayLog "Policy update failed. allowed=$Allowed error=$($_.Exception.Message)" "error"
    if (-not $Silent) {
      [System.Windows.Forms.MessageBox]::Show(
        "I could not update the local AI policy right now.`r`n`r`n$($_.Exception.Message)",
        "Hearthboard",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
      ) | Out-Null
    }
    Refresh-Status
    return $false
  }
}

# ---------- Game detection --------------------------------------------------
function Get-RunningGameList {
  $targets = @()
  if ($script:settings.PSObject.Properties.Match("gameProcessNames").Count -and $script:settings.gameProcessNames) {
    $targets = @($script:settings.gameProcessNames)
  }
  if (-not $targets -or $targets.Count -eq 0) {
    return @()
  }

  $running = @()
  try {
    $all = Get-Process -ErrorAction SilentlyContinue
    if ($null -eq $all) { return @() }
    foreach ($target in $targets) {
      $needle = $target.Trim()
      if (-not $needle) { continue }
      $match = $all | Where-Object { $_.ProcessName -ieq $needle } | Select-Object -First 1
      if ($match) {
        $running += $needle
      }
    }
  } catch {
    Write-TrayLog "Get-Process failed: $($_.Exception.Message)" "warn"
  }
  return ,$running
}

function Update-GamingState {
  $running = Get-RunningGameList
  $nowActive = $running.Count -gt 0
  $changed = ($script:gamingActive -ne $nowActive) -or (
    (@($script:lastGameList) -join "|") -ne (($running) -join "|")
  )

  $script:gamingActive = $nowActive
  $script:lastGameList = $running

  if ($nowActive) {
    $gamingStatusItem.Text = "Gaming: " + ($running -join ", ")
  } else {
    $gamingStatusItem.Text = "No games detected"
  }

  if ($changed) {
    Write-TrayLog ("Gaming state changed. active={0} games=[{1}]" -f $nowActive, ($running -join ","))
  }

  # Only act if the feature is on.
  if (-not [bool]$script:settings.autoRestrictWhileGaming) {
    if ($script:restrictedByAuto -and -not $nowActive) {
      $script:restrictedByAuto = $false
    }
    return
  }

  $currentlyAllowed = $true
  if ($null -ne $script:lastStatus -and $script:lastStatus.PSObject.Properties.Match("localAiAllowed").Count) {
    $currentlyAllowed = $script:lastStatus.localAiAllowed -ne $false
  }

  if ($nowActive) {
    # A game is running. Auto-restrict if Jody AI is currently allowed AND the
    # user hasn't overridden us for this gaming session.
    if ($currentlyAllowed -and -not $script:suppressAutoUntil) {
      Write-TrayLog "Auto-restrict triggered by game: $($running -join ', ')"
      if (Set-LocalAiPolicy -Allowed $false -FromAuto) {
        $script:restrictedByAuto = $true
      }
    }
    return
  }

  # No games running now.
  if (-not $currentlyAllowed -and $script:restrictedByAuto) {
    Write-TrayLog "Auto-allow triggered: last game closed"
    if (Set-LocalAiPolicy -Allowed $true -FromAuto) {
      $script:restrictedByAuto = $false
    }
  }

  # Gaming session ended, clear the per-session manual override so the next
  # game launch can auto-restrict again.
  $script:suppressAutoUntil = $null
}

# ---------- Event wiring ----------------------------------------------------
$allowItem.add_Click({
  # Manual allow while a game is running disables auto-restrict for the rest of
  # this gaming session. We record this so we don't immediately re-restrict on
  # the next poll tick.
  if ($script:gamingActive) {
    $script:suppressAutoUntil = "session"
    Write-TrayLog "Manual allow while gaming — auto-restrict suppressed for this session."
  }
  $script:restrictedByAuto = $false
  Set-LocalAiPolicy -Allowed $true | Out-Null
})

$restrictItem.add_Click({
  $script:restrictedByAuto = $false
  Set-LocalAiPolicy -Allowed $false | Out-Null
})

$autoRestrictItem.add_Click({
  $script:settings.autoRestrictWhileGaming = [bool]$autoRestrictItem.Checked
  Save-TraySettings -Settings $script:settings
  Write-TrayLog "autoRestrictWhileGaming=$($script:settings.autoRestrictWhileGaming)"
  # If the user just turned it ON mid-session and a game is running, evaluate.
  Update-GamingState
})

$refreshItem.add_Click({
  Refresh-Status
  Update-GamingState
})

$openItem.add_Click({ Start-Process $assistantUrl })
$openLogItem.add_Click({
  try {
    if (-not (Test-Path $logPath)) {
      New-Item -ItemType File -Path $logPath -Force | Out-Null
    }
    Start-Process notepad.exe -ArgumentList $logPath
  } catch {
    Write-TrayLog "Open log failed: $($_.Exception.Message)" "warn"
  }
})
$notifyIcon.add_DoubleClick({ Start-Process $assistantUrl })

$menu.add_Opening({
  Refresh-Status
  Update-GamingState
})

# Two timers: slow poll for Hearthboard status, fast poll for game detection.
$statusTimer = [System.Windows.Forms.Timer]::new()
$statusTimer.Interval = 15000
$statusTimer.add_Tick({ Refresh-Status })
$statusTimer.Start()

$gameTimer = [System.Windows.Forms.Timer]::new()
$gameTimer.Interval = 5000
$gameTimer.add_Tick({ Update-GamingState })
$gameTimer.Start()

$exitItem.add_Click({
  Write-TrayLog "Tray exiting via menu."
  $statusTimer.Stop()
  $gameTimer.Stop()
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

# ---------- Boot ------------------------------------------------------------
try {
  Refresh-Status
  Update-GamingState
  Write-TrayLog "Tray initialised. Entering message loop."
  [System.Windows.Forms.Application]::Run()
} catch {
  Write-TrayLog "Fatal in message loop: $($_.Exception.Message)" "error"
  throw
} finally {
  try { $statusTimer.Dispose() } catch {}
  try { $gameTimer.Dispose() } catch {}
  try { $notifyIcon.Dispose() } catch {}
  try { $menu.Dispose() } catch {}
  try { $icons.Values | ForEach-Object { $_.Dispose() } } catch {}
  try { $mutex.ReleaseMutex() | Out-Null } catch {}
  try { $mutex.Dispose() } catch {}
  Write-TrayLog "Tray shut down cleanly."
}
