<#
  restart-with-cdp.ps1 -- 干净重启 ChatGPT 并开启 Chromium 远程调试端口。

  要点：
    1. MSIX 应用是单实例：必须先让旧实例真正退干净（0 内存的僵尸条目不算），
       否则 AUMID 激活会被旧实例接走，新实例就不带 --remote-debugging-port。
    2. 用 AUMID 激活（跨版本稳定），不用带版本号的路径。
    3. 激活后端口没开就再清一次、再激活，最多 3 轮。
#>
[CmdletBinding()]
param(
    [int]$Port = 9333,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'

function Get-ChatGPTAumid {
    $sh = New-Object -ComObject Shell.Application
    $item = $sh.NameSpace('shell:AppsFolder').Items() | Where-Object { $_.Name -eq 'ChatGPT' } | Select-Object -First 1
    if (-not $item) { throw 'shell:AppsFolder 中找不到 ChatGPT' }
    return $item.Path
}

function Test-CdpPort([int]$p) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(600)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch { return $false } finally { $client.Close() }
}

function Stop-ChatGPT {
    for ($round = 0; $round -lt 8; $round++) {
        $procs = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.WorkingSet64 -gt 0 })
        if ($procs.Count -eq 0) { return }
        if ($round -eq 0) {
            foreach ($p in $procs) { try { $p.CloseMainWindow() | Out-Null } catch {} }
            Start-Sleep -Seconds 1
        }
        foreach ($p in @(Get-Process ChatGPT -ErrorAction SilentlyContinue)) {
            try { Stop-Process -Id $p.Id -Force -ErrorAction Stop }
            catch { Write-Output ("  无法结束 PID {0}: {1}" -f $p.Id, $_.Exception.Message) }
        }
        Start-Sleep -Seconds 1
    }
}

if (-not $Force -and (Test-CdpPort $Port)) {
    Write-Output "CDP 端口 $Port 已在监听，无需重启。"
    exit 0
}

$src = @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  int ActivateApplication([In] string appUserModelId, [In] string arguments, [In] int options, [Out] out uint processId);
  int ActivateForFile([In] string appUserModelId, [In] IntPtr itemArray, [In] string verb, [Out] out uint processId);
  int ActivateForProtocol([In] string appUserModelId, [In] IntPtr itemArray, [Out] out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager { }
public static class Aam {
  public static uint Activate(string aumid, string args) {
    var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
    uint pid;
    int hr = mgr.ActivateApplication(aumid, args, 0, out pid);
    if (hr != 0) throw new COMException("ActivateApplication failed", hr);
    return pid;
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue

$aumid = Get-ChatGPTAumid
Write-Output "AUMID: $aumid"

# 1) 让旧实例彻底退出
Stop-ChatGPT
for ($w = 0; $w -lt 40; $w++) {
    $left = @(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.WorkingSet64 -gt 0 })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
}
Write-Output '旧实例已退出。'

$launchArgs = "--remote-debugging-port=$Port"

function Invoke-Activation([string]$id, [string]$arguments) {
    try {
        $newPid = [Aam]::Activate($id, $arguments)
        Write-Output "已通过 AUMID 激活（保留 MSIX 身份），PID=$newPid"
        return $true
    } catch {
        Write-Output "AUMID 激活失败：$($_.Exception.Message)"
        return $false
    }
}

# 2) 激活 + 等端口；失败就再来一轮（最多 3 轮）
$ready = $false
for ($attempt = 1; $attempt -le 3 -and -not $ready; $attempt++) {
    if (-not (Invoke-Activation $aumid $launchArgs)) {
        $found = Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $bin = Join-Path $found.FullName 'app\ChatGPT.exe'
            Write-Output "兜底直启：$bin"
            Start-Process -FilePath $bin -ArgumentList $launchArgs
        }
    }
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-CdpPort $Port) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready -and $attempt -lt 3) {
        Write-Output "第 $attempt 轮未就绪，清理后重试…"
        Stop-ChatGPT
        Start-Sleep -Seconds 2
    }
}

if (-not $ready) { throw "等待 CDP 端口 $Port 超时" }

Write-Output "CDP 端口 $Port 已就绪"
$list = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
$list | ForEach-Object { Write-Output ("target: type={0}  title={1}  url={2}" -f $_.type, $_.title, $_.url) }
exit 0
