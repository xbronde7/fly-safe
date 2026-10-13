!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\eve-local-intel-updater"
  ${endIf}
!macroend
