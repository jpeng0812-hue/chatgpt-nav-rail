# launch.ps1 -- make ChatGPT run WITH the CDP port, and keep the injector alive.
#
#   port closed + no visible window  -> start it with the port
#   port closed + visible window     -> only when autoRestart is on
#   port open                        -> just make sure the injector runs
#
# Idempotent. Exit 0 = nav rail is live.
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$Quiet,
    [switch]$Hidden   # 预启动：窗口一出现就隐藏（不弹窗、不占任务栏）
)

$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $env:LOCALAPPDATA 'ChatGPTNavRail'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$LogFile = Join-Path $StateDir 'nav.log'
$PidFile = Join-Path $StateDir 'daemon.pid'
$ConfigPath = Join-Path $Here 'config.json'

$Config = @{ port = 9333; autoRestart = $true; restartCooldownSec = 120 }
if (Test-Path $ConfigPath) {
    try {
        $loaded = Get-Content $ConfigPath -Raw | ConvertFrom-Json
        foreach ($p in $loaded.PSObject.Properties) { $Config[$p.Name] = $p.Value }
    } catch { }
}
if ($Port -le 0) { $Port = [int]$Config.port }

function Write-Log([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date).ToString('s'), $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
    if (-not $Quiet) { Write-Output $Message }
}

function Test-CdpPort([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch { return $false } finally { $client.Close() }
}

if (-not ('NavWin2' -as [type])) {
    Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NavWin2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static bool HasWindow(uint[] pids) {
    bool found = false;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(h)) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.ToString() == "ChatGPT") { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@ -ErrorAction SilentlyContinue
}

function Test-ChatGPTWindow {
    $ids = @((Get-Process ChatGPT -ErrorAction SilentlyContinue).Id)
    if ($ids.Count -eq 0) { return $false }
    return [NavWin2]::HasWindow($ids)
}

function Get-DaemonPid {
    if (-not (Test-Path $PidFile)) { return 0 }
    $raw = (Get-Content $PidFile -Raw).Trim()
    if (-not $raw) { return 0 }
    $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'node') { return [int]$raw }
    return 0
}

function Stop-StrayInjectors {
    $needle = Join-Path $Here 'injector\daemon.mjs'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
}

function Start-Daemon {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Write-Log 'ERROR: node.exe not found'; return $false }
    $daemon = Join-Path $Here 'injector\daemon.mjs'
    if (-not (Test-Path $daemon)) { Write-Log "ERROR: missing $daemon"; return $false }
    $daemonLog = Join-Path $StateDir 'injector.log'
    if ((Test-Path $daemonLog) -and (Get-Item $daemonLog).Length -gt 2MB) { Move-Item -Force $daemonLog "$daemonLog.1" }
    $p = Start-Process -FilePath $node -ArgumentList @("`"$daemon`"", '--port', "$Port", '--log', "`"$daemonLog`"") -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $p.Id -Encoding ASCII
    Start-Sleep -Milliseconds 700
    if ($p.HasExited) { Write-Log "ERROR: injector exited immediately ($($p.ExitCode))"; return $false }
    Write-Log "injector started (pid $($p.Id))"
    return $true
}

# ---- 1. port ---------------------------------------------------------------
if (-not (Test-CdpPort $Port)) {
    $hasWindow = Test-ChatGPTWindow
    if ($hasWindow -and -not [bool]$Config.autoRestart) {
        Write-Log 'ChatGPT is running without the debug port; autoRestart is off (launch it from the shortcut).'
        exit 2
    }
    if ($hasWindow) {
        Write-Log 'ChatGPT is running without the debug port -> switching it to a debug-port launch.'
    } else {
        Write-Log 'ChatGPT is not running (or only stray processes) -> starting it with the debug port.'
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Here 'restart-with-cdp.ps1') -Port $Port -Force |
        ForEach-Object { Write-Log ([string]$_) }
    if (-not (Test-CdpPort $Port)) { Write-Log "ERROR: CDP port $Port still closed."; exit 1 }
}

# ---- 2. injector -----------------------------------------------------------
$daemonPid = Get-DaemonPid
if (-not $daemonPid) {
    Stop-StrayInjectors
    if (-not (Start-Daemon)) { exit 1 }
} else {
    Write-Log "injector already running (pid $daemonPid)"
}

# ---- 3. 预启动模式：把窗口隐藏（点图标即唤醒，不会重启） ----
if ($Hidden) {
    if (-not ('NavHide' -as [type])) {
        Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NavHide {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public static IntPtr FindChat(uint[] pids) {
    IntPtr best = IntPtr.Zero;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(h)) return true;
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.ToString() == "ChatGPT") { best = h; return false; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@ -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 200; $i++) {
        $ids = @((Get-Process ChatGPT -ErrorAction SilentlyContinue).Id)
        if ($ids.Count -gt 0) {
            $hwnd = [NavHide]::FindChat($ids)
            if ($hwnd -ne [IntPtr]::Zero) {
                [NavHide]::ShowWindow($hwnd, 0) | Out-Null   # SW_HIDE
                Write-Log 'preload: window hidden (click any ChatGPT icon to bring it up)'
                break
            }
        }
        Start-Sleep -Milliseconds 150
    }
}

Write-Log "OK: nav rail active on port $Port"
exit 0
