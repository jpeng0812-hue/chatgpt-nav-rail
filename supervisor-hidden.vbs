' supervisor-hidden.vbs -- starts the node supervisor with no console window.
Option Explicit
Dim fso, shell, here, nodePath, scriptPath, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = here & "\supervisor.mjs"

nodePath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodePath) Then
  nodePath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe"
End If
If Not fso.FileExists(nodePath) Then
  nodePath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\OpenAI\Codex\runtimes\cua_node\5c41f77a7900391c\bin\node.exe"
End If
If Not fso.FileExists(nodePath) Then nodePath = "node.exe"

cmd = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & scriptPath & Chr(34)
shell.Run cmd, 0, False
