' boot-hidden.vbs -- logon entry: start the supervisor, then preload ChatGPT WITH the debug port (window hidden).
Option Explicit
Dim fso, shell, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

' 1) supervisor (no console)
shell.Run "wscript.exe """ & here & "\supervisor-hidden.vbs""", 0, False
' 2) preload ChatGPT with the debug port, then hide its window
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & here & "\launch.ps1"" -Hidden", 0, False