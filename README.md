# Via Browser for Windows

A lightweight, minimalist desktop web browser for Windows, rebuilt from the spirit of
**Via Browser 7.2.1** (Android, `mark.via.gp`). This is **not a conversion of the APK** — Android
apps can't be turned into native Windows executables. Instead it's a faithful, ultra-light
re-implementation using **Tauri 2 + Rust + WebView2**, matching Via's core philosophy:
a tiny binary that uses the OS's native web engine rather than bundling a heavy Chromium.

Because it reuses Windows' built-in **WebView2** (preinstalled on Windows 10/11), the whole app
is only ~3 MB and uses far less RAM than Electron-based browsers.

## Why a port, not a converter

- Via ships as compiled Android Dalvik bytecode (`.dex`) tied to `android.app`, `android.view`
  and the Android `WebView`. There is no tool that "converts" an APK into a native `.exe`.
  Any tool claiming to is either a scam or just wraps an Android emulator.
- The faithful, lightweight path is a native re-implementation. This repo is that port.

## What's included

| Asset | Source |
|---|---|
| `via-browser-win.exe` | Standalone Windows x64 binary (3.2 MB) |
| `Via Browser_7.2.1_x64-setup.exe` | NSIS installer (1.3 MB) |
| Built-in ad blocker | Via's own EasyList-derived `/assets/simple.txt` (61 KB, 3,100+ rules) |
| Error page & logo | Extracted from the APK's `/assets/` |

## Features

- **Via-style mobile UI on PC** — no top chrome. A 5-icon bottom navigation bar
  (Back / Forward / Home / Tabs / Menu), a centered speed-dial homepage, a
  full-width floating address bar, a card-grid tab switcher, and a slide-up
  grid menu. Just like the Android app, adapted for mouse & keyboard.
- **Tabs** — real parallel tabs (each is a native WebView2 child webview);
  visual card grid switcher. `Ctrl+T`, `Ctrl+W`, `Ctrl+L`.
- **Omnibox** — floating address/search bar with live suggestions
  (Google / Bing / DuckDuckGo / Baidu).
- **Ad & tracker blocker** — Url-block at request time (fetch/XHR) plus
  cosmetic content hiding using Via's bundled EasyList-derived filter list
  (extracted from `simple.txt` in the Android APK).
- **User scripts & styles** — inject custom CSS and JS per page.
- **Night mode** — full-window color inversion like Via on Android.
- **Desktop / Mobile toggle** — instant User-Agent switch + reload.
- **Privacy** — clear cache & history now, or automatically on exit.

## Install & run on Windows

1. Download `Via Browser_7.2.1_x64-setup.exe`.
2. Run it (Windows SmartScreen may warn because the installer is unsigned — choose *More info → Run anyway*).
3. Launch **Via Browser** from the Start Menu or desktop shortcut.

> Requirement: Windows 10/11 with WebView2 (built-in). The installer bundles the app; the
> WebView2 evergreen runtime will be used automatically.

## Build it yourself

Prerequisites on the build machine: **Rust** (stable), **Node.js 18+**, and Tauri's Linux
system deps for a Linux host, or build on a **Windows** machine for a fully native toolchain.

```bash
npm install
npm run tauri build        # native host build
```

Cross-compile a Windows `.exe` from Linux with `cargo-xwin`:

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
# scripts/build-windows.sh runs the full NSIS cross-build
```

The CI workflow (`.github/workflows/build.yml`) also produces signed-free Windows installers
via GitHub Actions on `ubuntu-latest` with the official MSVC + WebView2 toolchain.

> Note: cross-compiled (xwin) installers from Linux are unsigned; the GitHub Actions workflow
> builds on native Windows so you can add an Authenticode signing step if you hold a cert.

## Project layout

```
src/                     Browser chrome UI (tabs, omnibox, settings) — TS/CSS
src/commands.rs          Tauri commands: tabs, navigation, ad-block, settings, suggestions
src/adblock.rs           Parses Via's EasyList-style rules into a fast domain/path blocker
src/init.rs              JS injected into each page (request blocking, cosmetic CSS, user JS)
src/settings.rs          Settings model + UA switcher
src-tauri/assets/        Via's extracted filters.txt, error.html, logo.svg
```

## Route & architecture notes

- Tabs are child WebViews of the main window, positioned below the chrome bar; switching tabs
  shows the active WebView and hides the rest.
- Ad blocking runs twice: a lightweight navigation guard in Rust, plus a DOM-level
  fetch/XHR/image interceptor injected at document start for finer coverage.
- Settings persist to `%APPDATA%/com.via.browser/via-settings.json`.
