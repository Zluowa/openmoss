; Installed apps start this installer with --updated --force-run but without /S, and the
; assisted installer's update run still shows its install-mode and finish pages. The user
; already chose to install inside Moss, so an update runs silently and relaunches the app.
; Deciding here also covers builds already in the field, whose call can no longer change.
!macro customInit
  ${if} ${isUpdated}
    SetSilent silent
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

; An update runs the old uninstaller too, and that install keeps its handlers. Moss data
; stays on uninstall, including Codex overlays next to the Codex home: see
; docs/providers/codex.md for why nothing here touches them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro mossRemoveOwnProtocolHandler "moss"
    !insertmacro mossRemoveOwnProtocolHandler "moss-beta"
    !insertmacro mossRemoveOwnProtocolHandler "moss-canary"
    !insertmacro mossRemoveOwnProtocolHandler "moss-cua"
    !insertmacro mossRemoveOwnProtocolHandler "moss-connectors"
  ${endIf}
!macroend
