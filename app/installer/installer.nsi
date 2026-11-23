; BALTA Crucible installer (NSIS 3, Modern UI 2). Built by scripts/build-installer.mjs, which stages the application and passes
;   /DVERSION=1.0.0 /DSTAGE=<staged app folder> /DOUTFILE=<installer path> /DRES=<this folder>
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!define PRODUCT "BALTA Crucible"
!define PUBLISHER "BALTA Robotics"
!define APPEXE "BALTA Crucible.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BALTACrucible"
!define WPILIB_FOLDER "2026 WPILib Tools"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${PRODUCT}"
InstallDirRegKey HKLM "Software\${PRODUCT}" "InstallDir"
RequestExecutionLevel admin
BrandingText "${PUBLISHER}  |  ${PRODUCT} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${PUBLISHER}"

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
${StrRep}

!define MUI_ICON "${STAGE}\resources\app\build\icon.ico"
!define MUI_UNICON "${STAGE}\resources\app\build\icon.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${RES}\welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${RES}\welcome.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${RES}\header.bmp"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_ABORTWARNING

!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPEXE}"
!define MUI_FINISHPAGE_RUN_TEXT "$(RUN_NOW)"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

; /UPDATE (the in-app update): the same installer, but only its progress page is shown: every other page is skipped, the install folder stays where it was, and the
; window closes itself when the files are in. Without it the install is the full wizard; with /S nothing is shown at all.
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpdating
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpdating
!insertmacro MUI_PAGE_DIRECTORY
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpdating
!insertmacro MUI_PAGE_COMPONENTS
Page custom RobotPageCreate RobotPageLeave
Page custom PatchPageCreate PatchPageLeave
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpdating
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Turkish"

LangString SEC_MAIN ${LANG_ENGLISH} "BALTA Crucible (required)"
LangString SEC_MAIN ${LANG_TURKISH} "BALTA Crucible (gerekli)"
LangString SEC_START ${LANG_ENGLISH} "Start Menu shortcut"
LangString SEC_START ${LANG_TURKISH} "Başlat Menüsü kısayolu"
LangString SEC_WPILIB ${LANG_ENGLISH} "Shortcut in the WPILib Tools Start Menu folder"
LangString SEC_WPILIB ${LANG_TURKISH} "WPILib Tools Başlat Menüsü klasöründe kısayol"
LangString SEC_DESKTOP ${LANG_ENGLISH} "Desktop shortcut"
LangString SEC_DESKTOP ${LANG_TURKISH} "Masaüstü kısayolu"
LangString DESC_MAIN ${LANG_ENGLISH} "The application, its runtime and the uninstaller."
LangString DESC_MAIN ${LANG_TURKISH} "Uygulama, çalışma ortamı ve kaldırıcı."
LangString DESC_START ${LANG_ENGLISH} "Adds BALTA Crucible to the Start Menu."
LangString DESC_START ${LANG_TURKISH} "BALTA Crucible'ı Başlat Menüsüne ekler."
LangString DESC_WPILIB ${LANG_ENGLISH} "Puts BALTA Crucible next to Glass, AdvantageScope and the other WPILib tools."
LangString DESC_WPILIB ${LANG_TURKISH} "BALTA Crucible'ı Glass, AdvantageScope ve diğer WPILib araçlarının yanına koyar."
LangString DESC_DESKTOP ${LANG_ENGLISH} "Adds a shortcut to the desktop."
LangString DESC_DESKTOP ${LANG_TURKISH} "Masaüstüne kısayol ekler."
LangString RUN_NOW ${LANG_ENGLISH} "Start BALTA Crucible"
LangString RUN_NOW ${LANG_TURKISH} "BALTA Crucible'ı başlat"
LangString ROBOT_TITLE ${LANG_ENGLISH} "Robot project (optional)"
LangString ROBOT_TITLE ${LANG_TURKISH} "Robot projesi (isteğe bağlı)"
LangString ROBOT_SUB ${LANG_ENGLISH} "Where the robot code lives, so the app can start it."
LangString ROBOT_SUB ${LANG_TURKISH} "Uygulamanın başlatabilmesi için robot kodunun bulunduğu klasör."
LangString ROBOT_TEXT ${LANG_ENGLISH} "Choose the robot project folder (the one with gradlew.bat). BALTA Crucible launches it in simulation with its bridge. You can leave this empty and set it later in %APPDATA%\BALTA Crucible\crucible.config.json."
LangString ROBOT_TEXT ${LANG_TURKISH} "Robot proje klasörünü seçin (gradlew.bat dosyasının bulunduğu klasör). BALTA Crucible onu benzetimde köprüsüyle başlatır. Boş bırakıp daha sonra %APPDATA%\BALTA Crucible\crucible.config.json dosyasından ayarlayabilirsiniz."
LangString ROBOT_BROWSE ${LANG_ENGLISH} "Browse..."
LangString ROBOT_BROWSE ${LANG_TURKISH} "Gözat..."
LangString ROBOT_BAD ${LANG_ENGLISH} "That folder has no gradlew.bat. Use it anyway?"
LangString ROBOT_BAD ${LANG_TURKISH} "Bu klasörde gradlew.bat yok. Yine de kullanılsın mı?"
LangString PATCH_TITLE ${LANG_ENGLISH} "Patch a project?"
LangString PATCH_TITLE ${LANG_TURKISH} "Bir proje yamalansın mı?"
LangString PATCH_SUB ${LANG_ENGLISH} "Add the BALTA Crucible bridge to your robot code."
LangString PATCH_SUB ${LANG_TURKISH} "BALTA Crucible köprüsünü robot kodunuza ekleyin."
LangString PATCH_TEXT ${LANG_ENGLISH} "To simulate your robot, its code needs the bridge library and a few small edits: one block next to registerTelemetry in the code that creates the drivetrain, a guard on the drivetrain's own simulation thread, and the simulation GUI switched off while the bridge is on (build.gradle). All of it is simulation only and does nothing on a real robot. The original of every changed file is copied to .crucible-backup in the project first, and you can run this again later from the Start Menu (Patch a robot project)."
LangString PATCH_TEXT ${LANG_TURKISH} "Robotunuzu benzetmek için kodunun köprü kitaplığına ve birkaç küçük değişikliğe ihtiyacı var: sürüş sistemini oluşturan kodda registerTelemetry satırının yanına bir blok, sürüş sisteminin kendi benzetim iş parçacığına bir koruma ve köprü açıkken benzetim arayüzünün kapatılması (build.gradle). Hepsi yalnızca benzetime yöneliktir ve gerçek robotta hiçbir şey yapmaz. Değişen her dosyanın aslı önce projedeki .crucible-backup klasörüne kopyalanır; bunu daha sonra Başlat Menüsünden (Robot projesini yamala) tekrar çalıştırabilirsiniz."
LangString PATCH_YES ${LANG_ENGLISH} "Patch my robot project now (recommended)"
LangString PATCH_YES ${LANG_TURKISH} "Robot projemi şimdi yamala (önerilir)"
LangString PATCH_NO ${LANG_ENGLISH} "Do not change my code"
LangString PATCH_NO ${LANG_TURKISH} "Kodumu değiştirme"
LangString PATCH_NONE ${LANG_ENGLISH} "No robot project was chosen on the previous page, so there is nothing to patch now. You can patch one later from the Start Menu."
LangString PATCH_NONE ${LANG_TURKISH} "Önceki sayfada robot projesi seçilmedi, bu yüzden şimdi yamalanacak bir şey yok. Daha sonra Başlat Menüsünden yamalayabilirsiniz."
LangString PATCH_DONE ${LANG_ENGLISH} "Robot project patched."
LangString PATCH_DONE ${LANG_TURKISH} "Robot projesi yamalandı."
LangString PATCH_FAIL ${LANG_ENGLISH} "The patch tool reported a problem (see the details). Originals of anything it changed are in .crucible-backup in the project."
LangString PATCH_FAIL ${LANG_TURKISH} "Yama aracı bir sorun bildirdi (ayrıntılara bakın). Değiştirdiği her şeyin aslı projedeki .crucible-backup içindedir."
LangString RUNNING ${LANG_ENGLISH} "BALTA Crucible is running. Close it and press OK to continue."
LangString RUNNING ${LANG_TURKISH} "BALTA Crucible çalışıyor. Kapatın ve devam etmek için Tamam'a basın."

Var Updating
Var RobotDir
Var RobotEdit
Var RobotBrowse
Var PatchNow
Var RadioPatch
Var RadioSkip

; ---------------------------------------------------------------- robot project page
Function SkipIfUpdating
  ${If} $Updating == 1
    Abort
  ${EndIf}
FunctionEnd

Function RobotPageCreate
  ${If} $Updating == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(ROBOT_TITLE)" "$(ROBOT_SUB)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "$(ROBOT_TEXT)"
  Pop $0
  ${NSD_CreateText} 0 46u 78% 12u "$RobotDir"
  Pop $RobotEdit
  ${NSD_CreateButton} 80% 45u 20% 14u "$(ROBOT_BROWSE)"
  Pop $RobotBrowse
  ${NSD_OnClick} $RobotBrowse RobotBrowseClick
  nsDialogs::Show
FunctionEnd

Function RobotBrowseClick
  ${NSD_GetText} $RobotEdit $0
  nsDialogs::SelectFolderDialog "$(ROBOT_SUB)" "$0"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $RobotEdit $0
  ${EndIf}
FunctionEnd

Function RobotPageLeave
  ${NSD_GetText} $RobotEdit $RobotDir
  ${If} $RobotDir != ""
    ${IfNot} ${FileExists} "$RobotDir\gradlew.bat"
      MessageBox MB_YESNO|MB_ICONQUESTION "$(ROBOT_BAD)" IDYES ok
      Abort
      ok:
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- "Patch a project?" page
Function PatchPageCreate
  ${If} $Updating == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(PATCH_TITLE)" "$(PATCH_SUB)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 78u "$(PATCH_TEXT)"
  Pop $0
  ${If} $RobotDir == ""
    ${NSD_CreateLabel} 0 84u 100% 30u "$(PATCH_NONE)"
    Pop $0
    StrCpy $PatchNow 0
  ${Else}
    ${NSD_CreateLabel} 0 82u 100% 10u "$RobotDir"
    Pop $0
    ${NSD_CreateRadioButton} 0 96u 100% 12u "$(PATCH_YES)"
    Pop $RadioPatch
    ${NSD_CreateRadioButton} 0 110u 100% 12u "$(PATCH_NO)"
    Pop $RadioSkip
    ${NSD_Check} $RadioPatch
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function PatchPageLeave
  ${If} $RobotDir != ""
    ${NSD_GetState} $RadioPatch $PatchNow
  ${Else}
    StrCpy $PatchNow 0
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- install
Function .onInit
  SetRegView 64
  ; a running copy blocks the file replacement
  check:
  FindWindow $0 "Chrome_WidgetWin_1" "${PRODUCT}"
  ${If} $0 != 0
    ; silent (the in-app update): stop at once instead of waiting for a click nobody can see
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(RUNNING)" /SD IDCANCEL IDOK check
    Abort
  ${EndIf}
  ; guess the robot project from a previous install
  ReadRegStr $RobotDir HKCU "Software\${PRODUCT}" "RobotDir"
  ; command line (also for silent installs): /ROBOT=<project folder> and /PATCH=1 to patch it; /D=<install folder> must come last
  ${GetParameters} $0
  StrCpy $Updating 0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $Updating 1
    SetAutoClose true
  ${EndIf}
  ${GetOptions} $0 "/ROBOT=" $1
  ${If} $1 != ""
    StrCpy $RobotDir $1
  ${EndIf}
  ${GetOptions} $0 "/PATCH=" $1
  ${If} $1 == "1"
    StrCpy $PatchNow 1
  ${EndIf}
  ; the WPILib Tools entry only makes sense when that Start Menu folder exists
  Call HideWpilibSection
FunctionEnd

Section "$(SEC_MAIN)" SecMain
  SectionIn RO
  SetShellVarContext all
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKLM "Software\${PRODUCT}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\resources\app\build\icon.ico"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINSTKEY}" "EstimatedSize" "$0"

  ; the robot project (and its 3D model folder, if it has one) for this user
  SetShellVarContext current
  ${If} $RobotDir != ""
    WriteRegStr HKCU "Software\${PRODUCT}" "RobotDir" "$RobotDir"
    CreateDirectory "$APPDATA\${PRODUCT}"
    ${StrRep} $2 "$RobotDir" "\" "/"
    StrCpy $3 ""
    FindFirst $4 $5 "$RobotDir\advantagescope\Robot_*"
    ${DoWhile} $5 != ""
      ${If} ${FileExists} "$RobotDir\advantagescope\$5\config.json"
        ${StrRep} $6 "$RobotDir\advantagescope\$5" "\" "/"
        StrCpy $3 ',$\r$\n  "modelDir": "$6"'
      ${EndIf}
      FindNext $4 $5
    ${Loop}
    FindClose $4
    FileOpen $7 "$APPDATA\${PRODUCT}\crucible.config.json" w
    FileWrite $7 '{$\r$\n  "robotDir": "$2"$3$\r$\n}$\r$\n'
    FileClose $7
  ${EndIf}

  ; patch the robot project with the integration tool, which runs on the application's own runtime (no Node.js needed)
  ${If} $PatchNow == 1
  ${AndIf} $RobotDir != ""
    DetailPrint "Patching $RobotDir"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i.r0'
    nsExec::ExecToLog '"$INSTDIR\${APPEXE}" "$INSTDIR\resources\integrator\integrate-robot.mjs" "$RobotDir" --apply --backup'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", n)i.r1'
    ${If} $0 == 0
      DetailPrint "$(PATCH_DONE)"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(PATCH_FAIL)"
    ${EndIf}
  ${EndIf}
SectionEnd

Section "$(SEC_START)" SecStart
  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\${PRODUCT}"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\${PRODUCT}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\resources\app\build\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Patch a robot project.lnk" "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\integrator\patch-robot.ps1"' "$INSTDIR\resources\app\build\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\${PRODUCT}\Uninstall ${PRODUCT}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\resources\app\build\icon.ico" 0
SectionEnd

Section "$(SEC_WPILIB)" SecWpilib
  SetShellVarContext all
  CreateShortcut "$SMPROGRAMS\${WPILIB_FOLDER}\${PRODUCT}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\resources\app\build\icon.ico" 0
SectionEnd

Section /o "$(SEC_DESKTOP)" SecDesktop
  SetShellVarContext all
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\resources\app\build\icon.ico" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "$(DESC_MAIN)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStart} "$(DESC_START)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecWpilib} "$(DESC_WPILIB)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "$(DESC_DESKTOP)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; the WPILib tools entry only makes sense when that Start Menu folder exists
Function HideWpilibSection
  SetShellVarContext all
  ${IfNot} ${FileExists} "$SMPROGRAMS\${WPILIB_FOLDER}\*.*"
    SectionSetText ${SecWpilib} ""
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- uninstall
Function un.onInit
  SetRegView 64
  check:
  FindWindow $0 "Chrome_WidgetWin_1" "${PRODUCT}"
  ${If} $0 != 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(RUNNING)" IDOK check
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext all
  Delete "$SMPROGRAMS\${WPILIB_FOLDER}\${PRODUCT}.lnk"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  RMDir /r "$SMPROGRAMS\${PRODUCT}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"
  DeleteRegKey HKLM "Software\${PRODUCT}"
  ; the user's settings ($APPDATA\${PRODUCT}) and saved screenshots stay
SectionEnd
