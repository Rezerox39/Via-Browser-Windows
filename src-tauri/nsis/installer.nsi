!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!define WEBVIEW2_GUID "{F3017226-FE2A-4295-8BEB-235B8ED43A9A}"
!define WEBVIEW2_BOOTSTRAPPER_URL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

Var WebView2Found

Function .onInit
  ; Check for WebView2 Runtime before installation begins
  StrCpy $WebView2Found "0"

  ; Per-user check
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      StrCpy $WebView2Found "1"

  ; Per-machine check (64-bit)
  StrCmp $WebView2Found "1" +5 0
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      StrCpy $WebView2Found "1"

  ; Per-machine check (32-bit on 64-bit system)
  StrCmp $WebView2Found "1" +5 0
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      StrCpy $WebView2Found "1"

  ; If not found, show branded dialog and attempt installation
  StrCmp $WebView2Found "1" done

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Via Browser needs Microsoft WebView2 Runtime to display web pages.$\r$\n$\r$\n\
    WebView2 is a free runtime from Microsoft (not Microsoft Edge itself).$\r$\n$\r$\n\
    Click Yes to download and install the WebView2 Evergreen Bootstrapper$\r$\n\
    automatically, or No to skip and install Via without it.$\r$\n$\r$\n\
    You can also download it manually from:$\r$\n\
    https://developer.microsoft.com/en-us/microsoft-edge/webview2/" \
    IDNO skip_webview2

  ; Download and run the Evergreen Bootstrapper
  DetailPrint "Downloading WebView2 Evergreen Bootstrapper..."
  NSISdl::download /TIMEOUT=60000 "${WEBVIEW2_BOOTSTRAPPER_URL}" "$TEMP\webview2_bootstrapper.exe"
  Pop $0
  StrCmp $0 "success" install_wv2

  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "Could not download WebView2 Runtime installer.$\r$\n$\r$\n\
    Please download it manually from:$\r$\n\
    https://developer.microsoft.com/en-us/microsoft-edge/webview2/" \
    IDOK skip_webview2

install_wv2:
  DetailPrint "Installing WebView2 Runtime..."
  ExecWait '"$TEMP\webview2_bootstrapper.exe" /silent /install' $0
  StrCmp $0 "0" wv2_installed

  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "WebView2 Runtime installation returned exit code: $0$\r$\n$\r$\n\
    Via Browser will be installed but may not work without WebView2.$\r$\n\
    You can install it later from:$\r$\n\
    https://developer.microsoft.com/en-us/microsoft-edge/webview2/" \
    IDOK skip_webview2

wv2_installed:
  ; Verify the installation
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      StrCpy $WebView2Found "1"

  StrCmp $WebView2Found "1" done
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  StrCmp $0 "" +3 0
    StrCmp $0 "0.0.0.0" +2 0
      StrCpy $WebView2Found "1"

  StrCmp $WebView2Found "1" done

  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "WebView2 Runtime could not be verified.$\r$\n\
    Via will be installed but may fail to launch.$\r$\n\
    Install WebView2 manually if needed." IDOK skip_webview2

skip_webview2:
done:
  ; Clean up
  Delete "$TEMP\webview2_bootstrapper.exe"
FunctionEnd
