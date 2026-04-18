Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class NativeMethods {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
"@

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, "Local\HearthboardAiTray", [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  exit 0
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$baseUrl = "https://127.0.0.1:42069"
$statusEndpoint = "$baseUrl/api/local-ai/status"
$policyEndpoint = "$baseUrl/api/local-ai/policy"
$assistantUrl = "https://127.0.0.1:42069/assistant"
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

function ConvertTo-Icon {
  param(
    [System.Drawing.Color]$Color,
    [string]$Glyph
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

  if ($Glyph) {
    $font = [System.Drawing.Font]::new("Segoe UI", 7.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $format = [System.Drawing.StringFormat]::new()
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString($Glyph, $font, $textBrush, [System.Drawing.RectangleF]::new(0, 0, 16, 16), $format)
    $format.Dispose()
    $textBrush.Dispose()
    $font.Dispose()
  }

  $graphics.Dispose()
  $handle = $bitmap.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle).Clone()
  [NativeMethods]::DestroyIcon($handle) | Out-Null
  $bitmap.Dispose()
  return $icon
}

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
    Headers = @{
      "Accept" = "application/json"
    }
  }

  if ($null -ne $Body) {
    $parameters["ContentType"] = "application/json"
    $parameters["Body"] = ($Body | ConvertTo-Json -Compress)
  }

  Invoke-RestMethod @parameters
}

function Get-StatusSnapshot {
  try {
    $status = Invoke-LocalAiApi -Method GET -Uri $statusEndpoint
    $status | Add-Member -NotePropertyName appReachable -NotePropertyValue $true -Force
    return $status
  } catch {
    return [pscustomobject]@{
      name = "Jody AI"
      appReachable = $false
      reachable = $false
      ready = $false
      loaded = $false
      localAiAllowed = $true
      error = "Hearthboard is unavailable right now."
    }
  }
}

$icons = @{
  sleeping = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(64, 116, 184)) -Glyph ""
  awake = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(33, 166, 117)) -Glyph ""
  offline = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(99, 102, 108)) -Glyph "!"
  needsModel = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(219, 132, 35)) -Glyph "?"
  restricted = ConvertTo-Icon -Color ([System.Drawing.Color]::FromArgb(188, 57, 57)) -Glyph "X"
}

$notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$notifyIcon.Visible = $true
$notifyIcon.Text = "Hearthboard"

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$statusItem = $menu.Items.Add("Checking Jody AI...")
$statusItem.Enabled = $false
[void]$menu.Items.Add("-")
$allowItem = $menu.Items.Add("Jody AI allow")
$restrictItem = $menu.Items.Add("Jody AI restrict")
[void]$menu.Items.Add("-")
$refreshItem = $menu.Items.Add("Refresh")
$openItem = $menu.Items.Add("Open Jody AI")
[void]$menu.Items.Add("-")
$exitItem = $menu.Items.Add("Exit tray")
$notifyIcon.ContextMenuStrip = $menu

$script:lastStatus = $null

function Update-TrayVisual {
  param([object]$Status)

  $script:lastStatus = $Status
  $title = if ($Status.name) { [string]$Status.name } else { "Jody AI" }
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

  if ($Status.localAiAllowed -eq $false) {
    $notifyIcon.Icon = $icons.restricted
    $statusItem.Text = "$title is restricted"
    $notifyIcon.Text = "Hearthboard: Jody AI restricted"
    $allowItem.Enabled = $true
    $restrictItem.Enabled = $false
    $restrictItem.Checked = $true
    return
  }

  $allowItem.Checked = $true
  $allowItem.Enabled = $false
  $restrictItem.Enabled = $true

  if (-not $Status.reachable) {
    $notifyIcon.Icon = $icons.offline
    $statusItem.Text = "$title is offline"
    $notifyIcon.Text = "Hearthboard: Jody AI offline"
    return
  }

  if (-not $Status.ready) {
    $notifyIcon.Icon = $icons.needsModel
    $statusItem.Text = "$title needs a model"
    $notifyIcon.Text = "Hearthboard: Jody AI needs setup"
    return
  }

  if ($Status.loaded) {
    $notifyIcon.Icon = $icons.awake
    $statusItem.Text = "$title is awake"
    $notifyIcon.Text = "Hearthboard: Jody AI awake"
    return
  }

  $notifyIcon.Icon = $icons.sleeping
  $statusItem.Text = "$title is sleeping"
  $notifyIcon.Text = "Hearthboard: Jody AI sleeping"
}

function Refresh-Status {
  Update-TrayVisual -Status (Get-StatusSnapshot)
}

function Set-LocalAiPolicy {
  param([bool]$Allowed)

  try {
    $payload = Invoke-LocalAiApi -Method POST -Uri $policyEndpoint -Body @{ allowed = $Allowed }
    Update-TrayVisual -Status $payload.status
    $notifyIcon.ShowBalloonTip(
      1200,
      "Hearthboard",
      $(if ($Allowed) { "Jody AI is allowed again and can start when requested." } else { "Jody AI is now restricted and cannot start or wake until you allow it again." }),
      [System.Windows.Forms.ToolTipIcon]::Info
    )
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "I could not update the local AI policy right now.`r`n`r`n$($_.Exception.Message)",
      "Hearthboard",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    Refresh-Status
  }
}

$allowItem.add_Click({ Set-LocalAiPolicy -Allowed $true })
$restrictItem.add_Click({ Set-LocalAiPolicy -Allowed $false })
$refreshItem.add_Click({ Refresh-Status })
$openItem.add_Click({ Start-Process $assistantUrl })
$notifyIcon.add_DoubleClick({ Start-Process $assistantUrl })

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 15000
$timer.add_Tick({ Refresh-Status })
$timer.Start()

$menu.add_Opening({
  Refresh-Status
})

$exitItem.add_Click({
  $timer.Stop()
  $notifyIcon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

Refresh-Status
[System.Windows.Forms.Application]::Run()

$timer.Dispose()
$notifyIcon.Dispose()
$menu.Dispose()
$icons.Values | ForEach-Object { $_.Dispose() }
$mutex.ReleaseMutex() | Out-Null
$mutex.Dispose()
