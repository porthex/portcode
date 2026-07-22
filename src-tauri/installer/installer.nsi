Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh
!include WinMessages.nsh
!include Util.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
; Beta builds used portcode.exe before receiving their own main binary name.
; Keep this explicit legacy identity so an update can repair installs whose
; registry already says portcode-beta.exe while an old binary/shortcut remains.
!define PORTCODE_LEGACY_BETA_BINARY "portcode.exe"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
Var PortcodeHighContrast
Var PortcodeInstallState
Var PortcodeInstalledVersion
Var PortcodeWelcomeDialog
Var PortcodeFinishDialog
Var PortcodeLaunchCheckbox
Var PortcodeShortcutCheckbox
Var PortcodeDisplayFont
Var PortcodeTitleFont
Var PortcodeHeadingFont
Var PortcodeBodyFont
Var PortcodeMonoFont
Var PortcodeIconHandle
Var PortcodePagePhase

; Portcode installer design system. Hex values are RGB for SetCtlColors.
!define PORTCODE_BG "0x0A0C12"
!define PORTCODE_RAIL "0x0F121B"
!define PORTCODE_PANEL "0x171C29"
!define PORTCODE_BORDER "0x222A3C"
!define PORTCODE_TEXT "0xE8ECF4"
!define PORTCODE_MUTED "0x98A2B5"
!define PORTCODE_FAINT "0x6C778C"
!define PORTCODE_CYAN "0x21E6FF"
!define PORTCODE_MAGENTA "0xFF2E7E"
!define PORTCODE_SUCCESS "0x34FF9E"
!define PORTCODE_WARNING "0xFFB02E"

; MUI calls this after its own window setup and before the first page is shown.
!define MUI_CUSTOMFUNCTION_GUIINIT PortcodeGuiInit

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Portcode's welcome/finish panels use the same neon-noir palette as the app.
; Other wizard pages keep native Windows controls for accessibility and DPI support.
!define MUI_BGCOLOR "0A0C12"
!define MUI_TEXTCOLOR "F2F4FA"
!define MUI_WELCOMEPAGE_TITLE_3LINES
!define MUI_FINISHPAGE_TITLE_3LINES

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear.
; The custom Portcode surfaces keep all copy live and all interactions native.
; 1. Welcome / update / repair page
Page custom PortcodeWelcomeCreateV2 PortcodeWelcomeLeave

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; NSIS installs update and repair in place. Never surface Tauri's stock
  ; uninstall/reinstall maintenance choice for an existing Portcode install.
  ${If} $PortcodeInstallState != 0
    Abort
  ${EndIf}

  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; A newer NSIS build is an in-place update. Skip the maintenance prompt and
  ; preserve the existing install location, shortcuts, and application data.
  ; WiX migrations still use Tauri's explicit uninstall path above.
  ${If} $WixMode <> 1
  ${AndIf} $R0 = 1
    StrCpy $UpdateMode 1
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the begining
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ${If} $PassiveMode = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other erros? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. The current-user install location is deliberate and shown on the welcome
;    surface. Removing the directory page keeps install and update one step.

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!define MUI_PAGE_CUSTOMFUNCTION_SHOW PortcodeInstFilesShow
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
; Don't auto-jump so errors and the accessible details log remain inspectable.
!define MUI_FINISHPAGE_NOAUTOCLOSE
Page custom PortcodeFinishCreateV2 PortcodeFinishLeave

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; ---------------------------------------------------------------------------
; Portcode installer experience
; ---------------------------------------------------------------------------

Function PortcodeGuiInit
  StrCpy $PortcodeHighContrast 0
  ${If} ${IsHighContrastModeActive}
    StrCpy $PortcodeHighContrast 1
    Return
  ${EndIf}

  ; Ask Windows for its native dark frame. Attribute 20 is Windows 10 20H1+;
  ; attribute 19 and the window property cover older supported Windows builds.
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$hWndParent,i20,*i1,i4)i.r0'
  IntCmp $0 0 portcode_frame_done portcode_frame_done portcode_frame_fallback
  portcode_frame_fallback:
    System::Call 'DWMAPI::DwmSetWindowAttribute(p$hWndParent,i19,*i1,i4)i.r0'
    System::Call 'USER32::SetProp(p$hWndParent,t"UseImmersiveDarkModeColors",i1)'
  portcode_frame_done:
  ; Windows 11 uses explicit frame colors when available. Unsupported builds
  ; simply ignore these attributes and keep the native dark frame above.
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$hWndParent,i35,*i0x00120C0A,i4)i.r0'
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$hWndParent,i36,*i0x00F4ECE8,i4)i.r0'
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$hWndParent,i34,*i0x003C2A22,i4)i.r0'

  CreateFont $PortcodeDisplayFont "Segoe UI Variable Display" 20 600
  CreateFont $PortcodeTitleFont "Segoe UI Variable Display" 14 600
  CreateFont $PortcodeHeadingFont "Segoe UI Variable Text" 10 600
  CreateFont $PortcodeBodyFont "Segoe UI Variable Text" 9 400
  CreateFont $PortcodeMonoFont "Cascadia Mono" 8 400

  ; The wizard footer is part of the same surface instead of a branded NSIS
  ; strip. The first pass proved that MUI's branding controls overlap custom
  ; full-window pages, so they are intentionally removed.
  SetCtlColors $HWNDPARENT ${PORTCODE_TEXT} ${PORTCODE_BG}
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1034
  SendMessage $0 ${WM_SETTEXT} 0 "STR:"
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}

  ; Keep real Windows buttons (keyboard, narration and focus all keep working)
  ; while opting them into the operating system's dark control theme.
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'UXTHEME::SetWindowTheme(p r0,w "DarkMode_Explorer",p0)'
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'UXTHEME::SetWindowTheme(p r0,w "DarkMode_Explorer",p0)'
  GetDlgItem $0 $HWNDPARENT 3
  System::Call 'UXTHEME::SetWindowTheme(p r0,w "DarkMode_Explorer",p0)'

  ; MUI's stock 75px action clips "Repair Portcode" and "Update Portcode".
  ; Resize the real native controls and align them to a calmer 12px footer grid.
  System::Call 'USER32::GetClientRect(p$hWndParent,@r0)'
  System::Call '*$0(i,i,i.r1,i.r2)'
  IntOp $3 $1 - 130
  IntOp $4 $2 - 39
  GetDlgItem $0 $HWNDPARENT 1
  System::Call 'USER32::MoveWindow(pr0,ir3,ir4,i118,i27,i1)'
  IntOp $3 $1 - 220
  GetDlgItem $0 $HWNDPARENT 2
  System::Call 'USER32::MoveWindow(pr0,ir3,ir4,i80,i27,i1)'
FunctionEnd

Function PortcodeDetectInstallState
  StrCpy $PortcodeInstallState 0
  StrCpy $PortcodeInstalledVersion ""

  ReadRegStr $0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${If} $0 == ""
    Return
  ${EndIf}

  StrCpy $PortcodeInstalledVersion $0
  nsis_tauri_utils::SemverCompare "${VERSION}" $PortcodeInstalledVersion
  Pop $R0

  ${If} $R0 = 1
    ; A newer package updates the existing installation in place.
    StrCpy $PortcodeInstallState 1
    StrCpy $UpdateMode 1
  ${ElseIf} $R0 = 0
    ; Same-version installs are repairs, never uninstall/reinstall prompts.
    StrCpy $PortcodeInstallState 2
    StrCpy $UpdateMode 1
  ${ElseIf} $R0 = -1
    StrCpy $PortcodeInstallState 3
  ${EndIf}
FunctionEnd

; V2 shell: the installer is only ~314 dialog units wide, so the brand and
; progress rhythm live in one horizontal header. This preserves the app's rail
; language without sacrificing a third of the usable canvas.
Function PortcodeCreateShellV2
  ${NSD_CreateIcon} 19u 13u 19u 19u ""
  Pop $0
  ${NSD_SetIconFromInstaller} $0 $PortcodeIconHandle

  ${NSD_CreateLabel} 51u 11u 94u 13u "PORTCODE"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeTitleFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}

  ${NSD_CreateLabel} 51u 27u 110u 9u "BETA CHANNEL  /  NATIVE"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MAGENTA} ${PORTCODE_BG}
  ${EndIf}

  ${NSD_CreateLabel} 207u 17u 91u 10u "v${VERSION}"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_BG}
  ${EndIf}

  ; Two restrained neon segments echo the app's magenta/cyan gradient.
  ${NSD_CreateLabel} 16u 43u 64u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MAGENTA} ${PORTCODE_MAGENTA}
  ${EndIf}
  ${NSD_CreateLabel} 80u 43u -96u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_CYAN}
  ${EndIf}

  ${NSD_CreateLabel} 16u 52u 82u 10u "01  READY"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    ${If} $PortcodePagePhase = 1
      SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_BG}
    ${Else}
      SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_BG}
    ${EndIf}
  ${EndIf}
  ${NSD_CreateLabel} 111u 52u 82u 10u "02  SETUP"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    ${If} $PortcodePagePhase = 1
      SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_BG}
    ${Else}
      SetCtlColors $0 ${PORTCODE_FAINT} ${PORTCODE_BG}
    ${EndIf}
  ${EndIf}
  ${NSD_CreateLabel} 206u 52u 92u 10u "03  OPEN"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    ${If} $PortcodePagePhase = 1
      SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_BG}
    ${Else}
      SetCtlColors $0 ${PORTCODE_FAINT} ${PORTCODE_BG}
    ${EndIf}
  ${EndIf}

  ${NSD_CreateLabel} 0 -1u 100% 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_BORDER} ${PORTCODE_BORDER}
  ${EndIf}
FunctionEnd

Function PortcodeWelcomeCreateV2
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}

  nsDialogs::Create 1044
  Pop $PortcodeWelcomeDialog
  ${If} $PortcodeWelcomeDialog == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $PortcodeWelcomeDialog ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}

  StrCpy $PortcodePagePhase 0
  Call PortcodeCreateShellV2

  ${If} $PortcodeInstallState = 1
    StrCpy $0 "A sharper Portcode is ready."
    StrCpy $1 "Update the app in place. Your workspace does not move."
    StrCpy $2 "UPDATE IN PLACE"
    StrCpy $3 "$PortcodeInstalledVersion  ->  ${VERSION}"
    StrCpy $4 "Sessions, settings and local data stay exactly where they are."
  ${ElseIf} $PortcodeInstallState = 2
    StrCpy $0 "Portcode is current."
    StrCpy $1 "Refresh the native app files while keeping your workspace intact."
    StrCpy $2 "REPAIR IN PLACE"
    StrCpy $3 "Installed  ${VERSION}"
    StrCpy $4 "Nothing is uninstalled. Your sessions and settings are preserved."
  ${ElseIf} $PortcodeInstallState = 3
    StrCpy $0 "This build is older."
    StrCpy $1 "Portcode stopped before making any changes."
    StrCpy $2 "DOWNGRADE BLOCKED"
    StrCpy $3 "$PortcodeInstalledVersion  >  ${VERSION}"
    StrCpy $4 "Use a newer installer to continue."
  ${Else}
    StrCpy $0 "Meet Portcode."
    StrCpy $1 "One fast, native workspace for building real software with AI."
    StrCpy $2 "LOCAL INSTALL  /  NO ADMIN"
    StrCpy $3 "$INSTDIR"
    StrCpy $4 "Private to this Windows account. No cloud migration required."
  ${EndIf}

  ${NSD_CreateLabel} 16u 74u -32u 38u "$0"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeDisplayFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}
  ${NSD_CreateLabel} 16u 116u -32u 16u "$1"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_BG}
  ${EndIf}

  ; A single state card carries the only operational information that matters.
  ${NSD_CreateLabel} 16u 139u -32u 45u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_PANEL} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 16u 139u 76u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MAGENTA} ${PORTCODE_MAGENTA}
  ${EndIf}
  ${NSD_CreateLabel} 92u 139u -108u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_CYAN}
  ${EndIf}
  ${NSD_CreateLabel} 27u 148u -54u 9u "$2"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    ${If} $PortcodeInstallState = 3
      SetCtlColors $0 ${PORTCODE_WARNING} ${PORTCODE_PANEL}
    ${Else}
      SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_PANEL}
    ${EndIf}
  ${EndIf}
  ${NSD_CreateLabel} 27u 160u -54u 10u "$3"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeHeadingFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 27u 173u -54u 9u "$4"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_PANEL}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Cancel"
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  ${If} $PortcodeInstallState = 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Update Portcode"
  ${ElseIf} $PortcodeInstallState = 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Repair Portcode"
  ${ElseIf} $PortcodeInstallState = 3
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Unavailable"
    EnableWindow $0 0
    GetDlgItem $1 $HWNDPARENT 2
    SendMessage $1 ${WM_SETTEXT} 0 "STR:Close"
  ${Else}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Install Portcode"
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function PortcodeFinishCreateV2
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}

  StrCpy $PortcodeLaunchCheckbox 0
  StrCpy $PortcodeShortcutCheckbox 0
  nsDialogs::Create 1044
  Pop $PortcodeFinishDialog
  ${If} $PortcodeFinishDialog == error
    Abort
  ${EndIf}
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $PortcodeFinishDialog ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}

  StrCpy $PortcodePagePhase 1
  Call PortcodeCreateShellV2

  ${If} $UpdateMode = 1
    StrCpy $0 "You're up to date."
    StrCpy $1 "Portcode was updated in place. Pick up exactly where you left off."
    StrCpy $2 "UPDATED  /  ${VERSION}"
    StrCpy $3 "Sessions, settings, extensions and local data all stayed put."
  ${Else}
    StrCpy $0 "Portcode is ready."
    StrCpy $1 "Your native AI coding workspace is installed and ready to open."
    StrCpy $2 "INSTALLED  /  ${VERSION}"
    StrCpy $3 "Current-user install. No admin access or background service."
  ${EndIf}

  ${NSD_CreateLabel} 16u 78u -32u 28u "$0"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeDisplayFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}
  ${NSD_CreateLabel} 16u 111u -32u 16u "$1"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_BG}
  ${EndIf}

  ${NSD_CreateLabel} 16u 136u -32u 39u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_PANEL} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 16u 136u -32u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_SUCCESS}
  ${EndIf}
  ${NSD_CreateLabel} 27u 146u -54u 10u "$2"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeHeadingFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 27u 160u -54u 9u "$3"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_PANEL}
  ${EndIf}

  ${NSD_CreateCheckbox} 16u 183u 126u 11u "Launch ${PRODUCTNAME}"
  Pop $PortcodeLaunchCheckbox
  ${NSD_Check} $PortcodeLaunchCheckbox
  SendMessage $PortcodeLaunchCheckbox ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $PortcodeLaunchCheckbox ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}
  ${If} $UpdateMode != 1
    ${NSD_CreateCheckbox} 157u 183u 141u 11u "Create a desktop shortcut"
    Pop $PortcodeShortcutCheckbox
    SendMessage $PortcodeShortcutCheckbox ${WM_SETFONT} $PortcodeBodyFont 1
    ${If} $PortcodeHighContrast = 0
      SetCtlColors $PortcodeShortcutCheckbox ${PORTCODE_TEXT} ${PORTCODE_BG}
    ${EndIf}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"

  nsDialogs::Show
FunctionEnd

Function PortcodeWelcomeCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}

  nsDialogs::Create 1044
  Pop $PortcodeWelcomeDialog
  ${If} $PortcodeWelcomeDialog == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${If} $PortcodeHighContrast = 0
    SetCtlColors $PortcodeWelcomeDialog ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}

  ; Left rail: brand, channel and the three-step installation rhythm.
  ${NSD_CreateLabel} 0 0 108u 100% ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_RAIL} ${PORTCODE_RAIL}
  ${EndIf}

  ${NSD_CreateLabel} 107u 0 1u 100% ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_BORDER} ${PORTCODE_BORDER}
  ${EndIf}

  ${NSD_CreateIcon} 13u 12u 23u 23u ""
  Pop $0
  ${NSD_SetIconFromInstaller} $0 $PortcodeIconHandle

  ${NSD_CreateLabel} 43u 13u 57u 12u "PORTCODE"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeHeadingFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_RAIL}
  ${EndIf}

  ${NSD_CreateLabel} 43u 26u 57u 9u "BETA CHANNEL"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MAGENTA} ${PORTCODE_RAIL}
  ${EndIf}

  ${NSD_CreateLabel} 13u 48u 29u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_CYAN}
  ${EndIf}

  ${NSD_CreateLabel} 13u 60u 83u 10u "01   READY"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 13u 77u 83u 10u "02   SETUP"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_FAINT} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 13u 94u 83u 10u "03   OPEN"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_FAINT} ${PORTCODE_RAIL}
  ${EndIf}

  ${NSD_CreateLabel} 13u -32u 83u 10u "NATIVE WINDOWS BUILD"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_FAINT} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 13u -20u 83u 10u "v${VERSION}"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_RAIL}
  ${EndIf}

  ; Content surface. Copy changes at runtime for install, update, repair and
  ; downgrade-blocked states; it is never baked into artwork.
  ${NSD_CreateLabel} 120u 13u -14u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_BORDER} ${PORTCODE_BORDER}
  ${EndIf}

  ${NSD_CreateLabel} 120u 20u -14u 10u "WELCOME  //  CURRENT USER"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_BG}
  ${EndIf}

  ${If} $PortcodeInstallState = 1
    StrCpy $0 "A sharper Portcode is ready."
    StrCpy $1 "Update in place. Your work stays exactly where it is."
    StrCpy $2 "UPDATE IN PLACE"
    StrCpy $3 "$PortcodeInstalledVersion  ->  ${VERSION}"
    StrCpy $4 "Sessions, settings, extensions and local data are preserved."
  ${ElseIf} $PortcodeInstallState = 2
    StrCpy $0 "Portcode is already current."
    StrCpy $1 "Refresh the application files without touching your work."
    StrCpy $2 "REPAIR IN PLACE"
    StrCpy $3 "Installed version  ${VERSION}"
    StrCpy $4 "Sessions, settings, extensions and local data are preserved."
  ${ElseIf} $PortcodeInstallState = 3
    StrCpy $0 "A newer build is installed."
    StrCpy $1 "This older package cannot replace your current Portcode build."
    StrCpy $2 "DOWNGRADE BLOCKED"
    StrCpy $3 "$PortcodeInstalledVersion  >  ${VERSION}"
    StrCpy $4 "Get a newer installer to continue. Nothing has been changed."
  ${Else}
    StrCpy $0 "Your coding agent, ready to work."
    StrCpy $1 "A fast, native workspace for shipping real code with AI."
    StrCpy $2 "LOCAL INSTALL  //  NO ADMIN"
    StrCpy $3 "$INSTDIR"
    StrCpy $4 "Private to this Windows account. You can move your work anytime."
  ${EndIf}

  ${NSD_CreateLabel} 120u 36u -14u 28u "$0"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeDisplayFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}

  ${NSD_CreateLabel} 120u 70u -14u 20u "$1"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_BG}
  ${EndIf}

  ${NSD_CreateLabel} 120u 100u -14u 54u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_PANEL} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 130u 109u -25u 10u "$2"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    ${If} $PortcodeInstallState = 3
      SetCtlColors $0 ${PORTCODE_WARNING} ${PORTCODE_PANEL}
    ${Else}
      SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_PANEL}
    ${EndIf}
  ${EndIf}
  ${NSD_CreateLabel} 130u 123u -25u 11u "$3"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeHeadingFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 130u 138u -25u 10u "$4"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_PANEL}
  ${EndIf}

  ${NSD_CreateLabel} 120u -20u -14u 10u "SECURE BY DEFAULT  /  REVERSIBLE  /  NO CLOUD MIGRATION"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_FAINT} ${PORTCODE_BG}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Cancel"
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $PortcodeInstallState = 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Update Portcode"
  ${ElseIf} $PortcodeInstallState = 2
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Repair Portcode"
  ${ElseIf} $PortcodeInstallState = 3
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Unavailable"
    EnableWindow $0 0
    GetDlgItem $1 $HWNDPARENT 2
    SendMessage $1 ${WM_SETTEXT} 0 "STR:Close"
  ${Else}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Install Portcode"
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function PortcodeWelcomeLeave
  ${If} $PortcodeInstallState = 3
    Abort
  ${EndIf}
FunctionEnd

Function PortcodeInstFilesShow
  ${If} $PortcodeInstallState = 1
    !insertmacro MUI_HEADER_TEXT "Updating Portcode" "Keeping your sessions, settings and local data exactly where they are."
    SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:Applying the new build..."
  ${ElseIf} $PortcodeInstallState = 2
    !insertmacro MUI_HEADER_TEXT "Repairing Portcode" "Refreshing application files without touching your work."
    SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:Refreshing the native application..."
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Setting up Portcode" "Preparing your private, native coding workspace."
    SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:Installing the native application..."
  ${EndIf}

  ${If} $PortcodeHighContrast = 0
    SetCtlColors $mui.InstFilesPage ${PORTCODE_TEXT} ${PORTCODE_BG}
    SetCtlColors $mui.InstFilesPage.Text ${PORTCODE_TEXT} ${PORTCODE_BG}
    SetCtlColors $mui.InstFilesPage.ShowLogButton ${PORTCODE_MUTED} ${PORTCODE_BG}
    SetCtlColors $mui.InstFilesPage.Log ${PORTCODE_TEXT} ${PORTCODE_PANEL}
    SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBARCOLOR} 0 0x00FFE621
    SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBKCOLOR} 0 0x00291C17

    GetDlgItem $0 $HWNDPARENT 1034
    SetCtlColors $0 ${PORTCODE_BG} ${PORTCODE_BG}
    GetDlgItem $0 $HWNDPARENT 1037
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_BG}
    SendMessage $0 ${WM_SETFONT} $PortcodeTitleFont 1
    GetDlgItem $0 $HWNDPARENT 1038
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_BG}
    SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${EndIf}
FunctionEnd

Function PortcodeFinishCreate
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}

  StrCpy $PortcodeLaunchCheckbox 0
  StrCpy $PortcodeShortcutCheckbox 0
  nsDialogs::Create 1044
  Pop $PortcodeFinishDialog
  ${If} $PortcodeFinishDialog == error
    Abort
  ${EndIf}

  ${If} $PortcodeHighContrast = 0
    SetCtlColors $PortcodeFinishDialog ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}

  ${NSD_CreateLabel} 0 0 108u 100% ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_RAIL} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 107u 0 1u 100% ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_BORDER} ${PORTCODE_BORDER}
  ${EndIf}
  ${NSD_CreateIcon} 13u 12u 23u 23u ""
  Pop $0
  ${NSD_SetIconFromInstaller} $0 $PortcodeIconHandle
  ${NSD_CreateLabel} 43u 13u 57u 12u "PORTCODE"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeHeadingFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 43u 26u 57u 9u "BETA CHANNEL"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MAGENTA} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 13u 48u 29u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_SUCCESS}
  ${EndIf}
  ${NSD_CreateLabel} 13u 60u 83u 10u "01   READY"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 13u 77u 83u 10u "02   SETUP"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_RAIL}
  ${EndIf}
  ${NSD_CreateLabel} 13u 94u 83u 10u "03   OPEN"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_CYAN} ${PORTCODE_RAIL}
  ${EndIf}

  ${NSD_CreateLabel} 120u 13u -14u 1u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_SUCCESS}
  ${EndIf}
  ${NSD_CreateLabel} 120u 20u -14u 10u "SETUP COMPLETE  //  READY"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeMonoFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_BG}
  ${EndIf}

  ${If} $UpdateMode = 1
    StrCpy $0 "You're up to date."
    StrCpy $1 "Portcode was updated in place. Pick up exactly where you left off."
    StrCpy $2 "UPDATED TO  ${VERSION}"
    StrCpy $3 "Your sessions, settings, extensions and local data stayed put."
  ${Else}
    StrCpy $0 "Portcode is ready."
    StrCpy $1 "Your native AI coding workspace is installed and ready to open."
    StrCpy $2 "INSTALLED  ${VERSION}"
    StrCpy $3 "Current-user install. No background service and no admin access."
  ${EndIf}

  ${NSD_CreateLabel} 120u 39u -14u 27u "$0"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeDisplayFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}
  ${NSD_CreateLabel} 120u 72u -14u 20u "$1"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_BG}
  ${EndIf}
  ${NSD_CreateLabel} 120u 102u -14u 45u ""
  Pop $0
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_PANEL} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 130u 111u -25u 11u "$2"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeHeadingFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_SUCCESS} ${PORTCODE_PANEL}
  ${EndIf}
  ${NSD_CreateLabel} 130u 128u -25u 10u "$3"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $0 ${PORTCODE_MUTED} ${PORTCODE_PANEL}
  ${EndIf}

  ${NSD_CreateCheckbox} 120u -35u 115u 11u "Launch ${PRODUCTNAME}"
  Pop $PortcodeLaunchCheckbox
  ${NSD_Check} $PortcodeLaunchCheckbox
  SendMessage $PortcodeLaunchCheckbox ${WM_SETFONT} $PortcodeBodyFont 1
  ${If} $PortcodeHighContrast = 0
    SetCtlColors $PortcodeLaunchCheckbox ${PORTCODE_TEXT} ${PORTCODE_BG}
  ${EndIf}

  ${If} $UpdateMode != 1
    ${NSD_CreateCheckbox} 120u -20u 140u 11u "Create a desktop shortcut"
    Pop $PortcodeShortcutCheckbox
    SendMessage $PortcodeShortcutCheckbox ${WM_SETFONT} $PortcodeBodyFont 1
    ${If} $PortcodeHighContrast = 0
      SetCtlColors $PortcodeShortcutCheckbox ${PORTCODE_TEXT} ${PORTCODE_BG}
    ${EndIf}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Finish"

  nsDialogs::Show
FunctionEnd

Function PortcodeFinishLeave
  ${If} $PortcodeShortcutCheckbox != 0
    ${NSD_GetState} $PortcodeShortcutCheckbox $0
    ${If} $0 = ${BST_CHECKED}
      Call CreateOrUpdateDesktopShortcut
    ${EndIf}
  ${EndIf}
  ${NSD_GetState} $PortcodeLaunchCheckbox $0
  ${If} $0 = ${BST_CHECKED}
    Call RunMainBinary
  ${EndIf}
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}

  Call PortcodeDetectInstallState

  ; Downgrades are blocked in every execution mode, including passive and
  ; silent invocations where no explanatory page can be shown.
  !if "${ALLOWDOWNGRADES}" == "false"
    ${If} $PortcodeInstallState = 3
      ${If} $PassiveMode = 1
      ${OrIf} ${Silent}
        SetErrorLevel 1638
        Quit
      ${EndIf}
    ${EndIf}
  !endif

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd


Section EarlyChecks
  ; Defense in depth: never let an older package enter the install sections.
  !if "${ALLOWDOWNGRADES}" == "false"
    ${If} $PortcodeInstallState = 3
      SetErrorLevel 1638
      Abort
    ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  ; Capture the previous identity before overwriting the uninstall metadata.
  ; Updates must close every executable they are about to replace or remove.
  ClearErrors
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} ${Errors}
    StrCpy $OldMainBinaryName ""
    ClearErrors
  ${EndIf}

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
  ${AndIf} ${FileExists} "$INSTDIR\$OldMainBinaryName"
    !insertmacro CheckIfAppIsRunning "$OldMainBinaryName" "${PRODUCTNAME}"
  ${EndIf}
  ; A prior update may already have replaced MainBinaryName in the registry while
  ; leaving beta.3/beta.4's portcode.exe and its desktop shortcut behind.
  ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
  ${AndIf} $OldMainBinaryName != "${PORTCODE_LEGACY_BETA_BINARY}"
  ${AndIf} ${FileExists} "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    !insertmacro CheckIfAppIsRunning "${PORTCODE_LEGACY_BETA_BINARY}" "${PRODUCTNAME}"
  ${EndIf}

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Never leave an obsolete beta executable launchable after a successful
  ; upgrade. CheckIfAppIsRunning above makes these immediate deletes reliable;
  ; if another process still holds a file, fail the install instead of quietly
  ; scheduling deletion for a reboot and exposing two beta versions meanwhile.
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
  ${AndIf} ${FileExists} "$INSTDIR\$OldMainBinaryName"
    ClearErrors
    Delete "$INSTDIR\$OldMainBinaryName"
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "Setup could not remove the previous ${PRODUCTNAME} executable ($OldMainBinaryName). Close it and run setup again."
      Abort
    ${EndIf}
  ${EndIf}
  ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
  ${AndIf} ${FileExists} "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    ClearErrors
    Delete "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "Setup could not remove the legacy ${PRODUCTNAME} executable (${PORTCODE_LEGACY_BETA_BINARY}). Close it and run setup again."
      Abort
    ${EndIf}
  ${EndIf}

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Existing owned shortcuts are upgrade state, not a new-shortcut preference.
  ; Repair them on every install mode, including an ordinary GUI update whose
  ; finish page intentionally omits the "Create a desktop shortcut" checkbox.
  Call MigrateExistingDesktopShortcut

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
  ${AndIf} ${FileExists} "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    !insertmacro CheckIfAppIsRunning "${PORTCODE_LEGACY_BETA_BINARY}" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"
  ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
  ${AndIf} ${FileExists} "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    ClearErrors
    Delete "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    ${If} ${Errors}
      MessageBox MB_ICONSTOP "Uninstall could not remove the legacy ${PRODUCTNAME} executable (${PORTCODE_LEGACY_BETA_BINARY}). Close it and try again."
      Abort
    ${EndIf}
  ${EndIf}

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
      !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
      Pop $0
      ${If} $0 = 1
        !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
        Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
        RMDir "$SMPROGRAMS\$AppStartMenuFolder"
      ${EndIf}
      !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
      Pop $0
      ${If} $0 = 1
        !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
        Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
      !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
      Pop $0
      ${If} $0 = 1
        !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
        Delete "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  ${If} $OldMainBinaryName != ""
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      StrCpy $R0 1
    ${EndIf}

    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      StrCpy $R0 1
    ${EndIf}
  ${EndIf}

  ; The uninstall registry may already name the current binary even though a
  ; shortcut from beta.3/beta.4 still names the known legacy executable.
  ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      StrCpy $R0 1
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      StrCpy $R0 1
    ${EndIf}
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function MigrateExistingDesktopShortcut
  StrCpy $R0 0
  ${If} $OldMainBinaryName != ""
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      StrCpy $R0 1
    ${EndIf}
  ${EndIf}
  ${If} "${MAINBINARYNAME}.exe" != "${PORTCODE_LEGACY_BETA_BINARY}"
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${PORTCODE_LEGACY_BETA_BINARY}"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      StrCpy $R0 1
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; Migrate first; creating a new shortcut remains governed by update mode and
  ; the user's explicit shortcut preference below.
  Call MigrateExistingDesktopShortcut
  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
