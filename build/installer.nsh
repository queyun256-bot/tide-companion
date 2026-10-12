; Keep the install per-user, matching the existing local health-data ownership.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Clear the publisher left by earlier versions when upgrading this application.
!macro customInstall
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "Publisher"
!macroend

; Application data in %APPDATA%\小浪桌宠 is intentionally never removed.
; Remove login startup only when it belongs to this installed executable.
; Upgrades preserve it; the app refreshes the path when next launched.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "org.transpet.desktop"
    StrCpy $R1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    StrLen $R2 $R1
    StrCpy $R3 $R0 $R2
    ${If} $R3 == $R1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "org.transpet.desktop"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "org.transpet.desktop"
    ${EndIf}
  ${EndIf}
!macroend
