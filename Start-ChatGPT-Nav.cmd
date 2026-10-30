@echo off
rem Start-ChatGPT-Nav.cmd -- daily launcher: ChatGPT + message nav rail.
rem Double-click this (or pin it to the taskbar) instead of the original ChatGPT icon.
setlocal
set HERE=%~dp0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%launch.ps1"
if errorlevel 1 (
  echo.
  echo [nav] launch failed - see %%LOCALAPPDATA%%\ChatGPTNavRail\nav.log
  pause
)
endlocal
