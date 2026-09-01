!macro NSIS_HOOK_PREINSTALL
  ; After Tauri's built-in WebView2 check, verify the runtime is actually present.
  ; This catches cases where the bootstrapper download failed silently.
  Var /GLOBAL WV2_VERIFIED
  StrCpy $WV2_VERIFIED "0"

  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEB-235B8ED43A9A}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      StrCpy $WV2_VERIFIED "1"

  StrCmp $WV2_VERIFIED "1" +5 0
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEB-235B8ED43A9A}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      StrCpy $WV2_VERIFIED "1"

  StrCmp $WV2_VERIFIED "1" wv2_ok

  ; WebView2 still not found after Tauri's attempt — show branded error
  MessageBox MB_YESNO|MB_ICONEXCLAMATION \
    "Via Browser requires Microsoft WebView2 Runtime, which was not detected.$\r$\n$\r$\n\
    The installer will continue, but Via may not launch correctly.$\r$\n$\r$\n\
    Install WebView2 manually from:$\r$\n\
    https://developer.microsoft.com/en-us/microsoft-edge/webview2/$\r$\n$\r$\n\
    Click Yes to continue installing Via, or No to abort." \
    IDYES wv2_ok IDNO wv2_abort
  Goto wv2_ok

wv2_abort:
  Abort "Installation aborted — WebView2 Runtime is required."

wv2_ok:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Verify WebView2 after installation completes
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEB-235B8ED43A9A}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      Goto wv2_done

  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEB-235B8ED43A9A}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      Goto wv2_done

  ; WebView2 missing — show recovery dialog
  MessageBox MB_YESNO|MB_ICONEXCLAMATION \
    "Via Browser installed successfully, but WebView2 Runtime was not detected.$\r$\n$\r$\n\
    Via will not work without WebView2.$\r$\n$\r$\n\
    Click Yes to open the official download page, or No to finish." \
    IDNO wv2_done

  ExecShell "open" "https://developer.microsoft.com/en-us/microsoft-edge/webview2/"

wv2_done:
!macroend
