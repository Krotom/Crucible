' Starts BALTA Crucible without a console window (this is what the shortcuts run).
Option Explicit
Dim sh, fso, here, root, rc, log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
sh.CurrentDirectory = root
rc = sh.Run("cmd /c node ""scripts\launch.mjs""", 0, True)
If rc <> 0 Then
  log = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\BALTA Crucible\launch.log"
  MsgBox "BALTA Crucible could not start." & vbCrLf & vbCrLf & "Node.js must be installed and the app folder built (npm install, then npm run build)." & vbCrLf & "Details: " & log, 16, "BALTA Crucible"
End If
