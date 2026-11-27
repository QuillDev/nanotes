; Windows installs of the earlier (Tauri) app lived in %LOCALAPPDATA%\NaNotes with their own
; uninstaller. Remove that copy quietly when this one goes in, so there's one NaNotes in the Start
; menu. Settings live in %APPDATA%\moe.quill.nanotes and stay.
!macro customInstall
  IfFileExists "$LOCALAPPDATA\NaNotes\uninstall.exe" 0 +2
    ExecWait '"$LOCALAPPDATA\NaNotes\uninstall.exe" /S _?=$LOCALAPPDATA\NaNotes'
!macroend
