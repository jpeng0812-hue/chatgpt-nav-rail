# install.ps1 -- one-time setup: launcher shortcuts + background watchdog.
#
# What it creates:
#   %USERPROFILE%\Desktop\ChatGPT (消息导航栏).lnk
#   %APPDATA%\Microsoft\Windows\Start Menu\Programs\ChatGPT (消息导航栏).lnk
#   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ChatGPTNavRail.lnk  -> watch-hidden.vbs
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
[CmdletBinding()]
param([switch]$NoWatchdog)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cmd = Join-Path $Here 'Start-ChatGPT-Nav.cmd'
$Vbs = Join-Path $Here 'supervisor-hidden.vbs'
$Name = 'ChatGPT (消息导航栏)'

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$startup = [Environment]::GetFolderPath('Startup')

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [int]$Style) {
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.Arguments = $Arguments
    $lnk.WindowStyle = $Style
    $lnk.WorkingDirectory = $Here
    $lnk.IconLocation = "$env:SystemRoot\System32\imageres.dll,262"
    $lnk.Description = 'ChatGPT 桌面端 + 消息导航栏'
    $lnk.Save()
}

# 1) launcher shortcuts (minimized console -> keeps a taskbar entry, no popup)
New-Shortcut (Join-Path $desktop "$Name.lnk") $Cmd '' 7
New-Shortcut (Join-Path $programs "$Name.lnk") $Cmd '' 7
Write-Host "shortcut: $desktop\$Name.lnk"
Write-Host "shortcut: $programs\$Name.lnk"

# 2) watchdog at logon
if (-not $NoWatchdog) {
    New-Shortcut (Join-Path $startup 'ChatGPTNavRail.lnk') "$env:SystemRoot\System32\wscript.exe" "`"$Vbs`"" 7
    Write-Host "startup : $startup\ChatGPTNavRail.lnk"
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$Vbs`"" -WindowStyle Hidden
    Write-Host 'watchdog: started'
}

# 3) bring the rail up right now
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Here 'launch.ps1')

Write-Host ''
Write-Host 'Done. Pin "ChatGPT (消息导航栏)" instead of the original ChatGPT icon.'
