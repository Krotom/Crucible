# Creates the BALTA Crucible shortcuts (with the app icon) and builds the app once.
#   powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1            Start Menu, in the "WPILib Tools" folder
#   ... -Desktop                                                                       also on the desktop
#   ... -Remove                                                                        removes the shortcuts again
# The Start Menu entry goes into the existing "2026 WPILib Tools" folder (all users when this runs elevated, otherwise this user's copy of the same
# folder, which Windows shows merged with the all-users one). Re-run it after moving the app folder.
param(
  [switch]$Desktop,
  [switch]$Remove,
  [string]$Folder = '2026 WPILib Tools'
)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $app 'build\icon.ico'
$vbs = Join-Path $app 'scripts\launch.vbs'
$name = 'BALTA Crucible.lnk'

$userPrograms = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$allPrograms = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$startDir = if ($elevated -and (Test-Path (Join-Path $allPrograms $Folder))) { Join-Path $allPrograms $Folder } else { Join-Path $userPrograms $Folder }
$targets = @(Join-Path $startDir $name)
if ($Desktop) { $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) $name }

if ($Remove) {
  foreach ($t in $targets + (Join-Path (Join-Path $allPrograms $Folder) $name) + (Join-Path (Join-Path $userPrograms $Folder) $name) + (Join-Path ([Environment]::GetFolderPath('Desktop')) $name)) {
    if (Test-Path $t) { Remove-Item $t -Force; "removed $t" }
  }
  return
}

foreach ($p in @($icon, $vbs)) { if (-not (Test-Path $p)) { throw "missing $p" } }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js was not found on PATH' }

# build once now, so the first launch from the shortcut is instant
Push-Location $app
try { node scripts\launch.mjs --build-only 2>$null } catch {}
if (-not (Test-Path (Join-Path $app 'out\main\index.js'))) {
  Write-Host 'Building the app ...'
  & node (Join-Path $app 'node_modules\electron-vite\bin\electron-vite.js') build
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'the build failed' }
}
Pop-Location

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
  New-Item -ItemType Directory -Force -Path (Split-Path $t) | Out-Null
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = "//nologo `"$vbs`""
  $lnk.WorkingDirectory = $app
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'BALTA Crucible: physics simulation and analysis for FRC robot code'
  $lnk.WindowStyle = 7
  $lnk.Save()
  "created $t"
}
