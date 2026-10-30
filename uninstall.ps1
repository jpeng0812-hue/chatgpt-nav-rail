# uninstall.ps1 -- remove shortcuts, stop the watchdog and the injector.
# The ChatGPT app itself is left untouched (only its debug port goes away after a normal restart).
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = Join-Path $env:LOCALAPPDATA 'ChatGPTNavRail'
$Name = 'ChatGPT (消息导航栏)'

$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk"),
        (Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk"),
        (Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatGPTNavRail.lnk')
    )) {
    if (Test-Path $lnk) { Remove-Item -Force $lnk; Write-Host "removed $lnk" }
}

$pidFile = Join-Path $StateDir 'daemon.pid'
if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    if ($raw) {
        Stop-Process -Id ([int]$raw) -Force -ErrorAction SilentlyContinue
        Write-Host "stopped injector (pid $raw)"
    }
    Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
}

# the watchdog runs as powershell.exe hosting watch.ps1 -> find and stop it
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'watch\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "stopped watchdog (pid $($_.ProcessId))" }

Write-Host 'Uninstalled. Restart ChatGPT to drop the debug port.'

# stop the node supervisor
$needle = Join-Path $Here 'supervisor.mjs'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "stopped supervisor (pid $($_.ProcessId))" }