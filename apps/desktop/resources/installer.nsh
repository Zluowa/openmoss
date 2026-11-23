; Relaunch Moss cleanly after an update or assisted install.
; StdUtils::ExecShellAsUser drops elevation back to the desktop user when a per-machine
; installer ran elevated. If launching via the Start Menu shortcut fails (for example,
; Explorer is busy or the shortcut could not be opened), fall back to the installed
; executable via ExecShellAsUser and finally direct Exec so updates always reopen Moss.
!macro mossLaunchApp ARGS
  Push $0
  ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "${ARGS}"
  ${if} $0 != "ok"
  ${andIf} $0 != "fallback"
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "${ARGS}"
    ${if} $0 != "ok"
    ${andIf} $0 != "fallback"
      ${if} "${ARGS}" == ""
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
      ${else}
        Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${ARGS}'
      ${endIf}
    ${endIf}
  ${endIf}
  Pop $0
!macroend

; Included in installer.nsi after Var launchLink and allowOnlyOneInstallerInstance.nsh.
; Defining customCheckAppRunning skips app-builder-lib's default getProcessInfo.nsh / Var pid
; inclusion, so restore them here for non-update installs that delegate to _CHECK_APP_RUNNING.
; Also hook .onInstSuccess so visible --updated --force-run installs relaunch Moss reliably
; (assisted installers only run doStartApp automatically when /S is passed).
!macro customHeader
  !include "getProcessInfo.nsh"
  Var pid

  !ifndef BUILD_UNINSTALLER
    Function .onInstSuccess
      ${if} ${isUpdated}
      ${andIf} ${isForceRun}
      ${andIfNot} ${Silent}
        HideWindow
        !insertmacro mossLaunchApp "--updated"
      ${endIf}
    FunctionEnd
  !endif
!macroend

; Installed apps start this installer with --updated --force-run (without /S).
; Keep the installation progress window visible instead of forcing SetSilent silent:
; - users see real installation progress instead of a 1-2 minute silent blackout
; - SetAutoClose true closes the progress window automatically on completion
; - customInstallMode and customFinishPage skip wizard pages so zero clicks are needed
; - explicit /S callers (such as autoInstallOnAppQuit) remain completely silent
!macro customInit
  ${if} ${isUpdated}
    SetAutoClose true
  ${endIf}
!macroend

; Reinforce auto-close at the end of the install section for --updated runs.
!macro customInstall
  ${if} ${isUpdated}
    SetAutoClose true
  ${endIf}
!macroend

; Skip the install-mode wizard page on --updated while keeping per-machine vs per-user
; installation scope (and elevating via UAC when updating a per-machine install).
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} ${isUpdated}
      ${if} $hasPerMachineInstallation == "1"
        StrCpy $isForceMachineInstall "1"
      ${else}
        StrCpy $isForceCurrentInstall "1"
      ${endIf}
    ${endIf}
  !endif
!macroend

; Skip the finish page on --updated so the installer auto-closes and relaunches Moss via
; .onInstSuccess. Fresh installs keep the finish page with "Run Moss" checked by default.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        !insertmacro mossLaunchApp "--updated"
      ${else}
        !insertmacro mossLaunchApp ""
      ${endIf}
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif

  Function mossSkipFinishPageIfUpdated
    ${if} ${isUpdated}
      Abort
    ${endIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE mossSkipFinishPageIfUpdated
  !insertmacro MUI_PAGE_FINISH
!macroend

; On --updated, Moss is already shutting down its main, GPU, renderer, and helper processes as
; the installer launches. app-builder-lib's default _CHECK_APP_RUNNING only retries twice before
; hitting MessageBox /SD IDCANCEL, which silently aborts when silent. Wait patiently for
; processes under $INSTDIR to exit gracefully, then request close, then force-stop lingering
; helpers before prompting.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${if} ${isUpdated}
    ${GetProcessInfo} 0 $pid $1 $2 $3 $4
    ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
      StrCpy $R1 0
      mossWaitGraceful:
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          Goto mossAppStopped
        ${endIf}
        IntOp $R1 $R1 + 1
        ${if} $R1 <= 24
          DetailPrint "$(appClosing)"
          Sleep 500
          Goto mossWaitGraceful
        ${endIf}

      DetailPrint "$(appClosing)"
      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
      Sleep 1000

      StrCpy $R1 0
      mossWaitForce:
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          Goto mossAppStopped
        ${endIf}
        IntOp $R1 $R1 + 1
        !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
        Sleep 1000
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 != 0
          Goto mossAppStopped
        ${endIf}
        ${if} $R1 < 15
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
          Goto mossWaitForce
        ${endIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY mossWaitForce
        Quit
      mossAppStopped:
    ${endIf}
  ${else}
    !insertmacro _CHECK_APP_RUNNING
  ${endIf}
!macroend

; The app registers its URL schemes in HKCU while it runs, writing "<exe>" "%1" as the
; command, and electron-builder never removes them. Another install may own a scheme by
; now, so only a handler that launches this exact executable goes.
!macro mossRemoveOwnProtocolHandler SCHEME
  Push $0
  Push $1
  Push $2
  ReadRegStr $0 HKCU "Software\Classes\${SCHEME}\shell\open\command" ""
  StrCpy $1 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  StrLen $2 $1
  StrCpy $2 $0 $2
  ${if} $2 == $1
    DeleteRegKey HKCU "Software\Classes\${SCHEME}"
  ${endIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

; An update runs the old uninstaller too, and that install keeps its handlers and its
; downloaded agent runtimes. Moss data stays on uninstall, including Codex overlays next to the
; Codex home: see docs/providers/codex.md for why nothing here touches them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro mossRemoveOwnProtocolHandler "moss"
    !insertmacro mossRemoveOwnProtocolHandler "moss-beta"
    !insertmacro mossRemoveOwnProtocolHandler "moss-canary"
    !insertmacro mossRemoveOwnProtocolHandler "moss-cua"
    !insertmacro mossRemoveOwnProtocolHandler "moss-connectors"
    ; The agent runtimes Moss downloaded after install (about 800 MB, see
    ; packages/shared/src/agentRuntimeStore.ts) are program files, not the person's data: a
    ; real uninstall removes them, an update never does. The folder is the uninstalling user's
    ; own LOCALAPPDATA, read from the environment because $LOCALAPPDATA points at the
    ; all-users profile when Moss was installed for everyone.
    Push $0
    ReadEnvStr $0 LOCALAPPDATA
    ${if} $0 != ""
      RMDir /r "$0\Moss\runtimes"
      RMDir "$0\Moss"
    ${endIf}
    Pop $0
  ${endIf}
!macroend
