# "Patch a robot project": pick a robot project folder, see what the BALTA Crucible bridge would change, and apply it (originals are backed up).
# Started from the Start Menu entry the installer creates. Runs the integration tool with the application's own runtime (no Node.js needed).
Add-Type -AssemblyName System.Windows.Forms
$here = $PSScriptRoot
$exe = Join-Path (Split-Path (Split-Path $here -Parent) -Parent) 'BALTA Crucible.exe'
$tool = Join-Path $here 'integrate-robot.mjs'
$title = 'BALTA Crucible: patch a robot project'

function Invoke-Tool([string[]]$toolArgs) {
  $env:ELECTRON_RUN_AS_NODE = '1'
  try { $out = & $exe $tool @toolArgs 2>&1 | Out-String } finally { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  return @{ Code = $LASTEXITCODE; Text = $out.Trim() }
}

$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Choose the robot project folder (the one with build.gradle and gradlew.bat)'
$dlg.ShowNewFolderButton = $false
if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return }
$project = $dlg.SelectedPath

$check = Invoke-Tool @($project)
if ($check.Code -ne 0) { [void][System.Windows.Forms.MessageBox]::Show($check.Text, $title, 'OK', 'Error'); return }
if ($check.Text -notmatch '\[todo\]') {
  [void][System.Windows.Forms.MessageBox]::Show("This project already has the bridge.`n`n$($check.Text)", $title, 'OK', 'Information')
  return
}
$ask = "Here is what the check found. Apply the changes? The original of every changed file is copied to .crucible-backup in the project first.`n`n$($check.Text)"
if ([System.Windows.Forms.MessageBox]::Show($ask, $title, 'YesNo', 'Question') -ne [System.Windows.Forms.DialogResult]::Yes) { return }

$result = Invoke-Tool @($project, '--apply', '--backup')
$icon = if ($result.Code -eq 0) { 'Information' } else { 'Error' }
[void][System.Windows.Forms.MessageBox]::Show($result.Text, $title, 'OK', $icon)
