<#
  restart-with-cdp.ps1  ---  干净重启 ChatGPT 桌面端并开启 Chromium 远程调试端口。

  背景：ChatGPT(Codex) 桌面端是 MSIX 打包的 Electron 应用，且是单实例：
       再启动一次只会把"开新窗口"转发给主实例，命令行开关无法传入。
       所以必须在主进程完全退出后，用 AUMID 激活并带上 --remote-debugging-port。
       AUMID 由签名证书派生（OpenAI.Codex_2p2nqsd0c76g0!App），跨版本稳定。
#>
[CmdletBinding()]
param(
    [int]$Port = 9333,
    [switch]$Force
)

$ErrorActionPreference = 'Continue'

function Get-ChatGPTAumid {
    $sh = New-Object -ComObject Shell.Application
    $item = $sh.NameSpace('shell:AppsFolder').Items() |
        Where-Object { $_.Name -eq 'ChatGPT' } |
        Select-Object -First 1
    if (-not $item) { throw 'shell:AppsFolder 中找不到 ChatGPT' }
    return $item.Path
}

function Test-CdpPort([int]$p) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$p/json/version" -TimeoutSec 2
        return [bool]$r.webSocketDebuggerUrl
    } catch { return $false }
}

function Stop-ChatGPT {
    for ($round = 0; $round -lt 8; $round++) {
        $procs = @(Get-Process ChatGPT -ErrorAction SilentlyContinue)
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
    $left = @(Get-Process ChatGPT -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
        Write-Output ("警告：仍有 {0} 个 ChatGPT 进程无法结束，继续尝试激活" -f $left.Count)
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

Stop-ChatGPT
Write-Output '旧实例已退出。'

$launchArgs = "--remote-debugging-port=$Port"
$launched = $false
try {
    $newPid = [Aam]::Activate($aumid, $launchArgs)
    Write-Output "已通过 AUMID 激活（保留 MSIX 身份），PID=$newPid"
    $launched = $true
} catch {
    Write-Output "AUMID 激活失败：$($_.Exception.Message)"
}

if (-not $launched) {
    $root = 'C:\Program Files\WindowsApps'
    $found = Get-ChildItem $root -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { throw '找不到 ChatGPT 安装目录' }
    $bin = Join-Path $found.FullName 'app\ChatGPT.exe'
    Write-Output "兜底直启：$bin"
    Start-Process -FilePath $bin -ArgumentList $launchArgs
}

for ($i = 0; $i -lt 90; $i++) {
    if (Test-CdpPort $Port) {
        Write-Output "CDP 端口 $Port 已就绪"
        $list = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
        $list | ForEach-Object { Write-Output ("target: type={0}  title={1}  url={2}" -f $_.type, $_.title, $_.url) }
        exit 0
    }
    Start-Sleep -Milliseconds 500
}
throw "等待 CDP 端口 $Port 超时"
