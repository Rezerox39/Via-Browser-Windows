# Via Browser for Windows

A desktop web browser for Windows, rebuilt from the spirit of
**Via Browser 7.2.1** (Android, `mark.via.gp`). This is **not a conversion of the APK** — Android
apps can't be turned into native Windows executables. Instead it's a faithful re-implementation
using **Tauri 2 + Rust + WebView2**, matching Via's philosophy of a lean app that uses the OS's
native web engine rather than bundling a heavy Chromium.

> **Constraint update:** the earlier "under 5 MB" limit has been lifted. The new priority is
> absolute feature perfection and a flawless 1:1 UI/UX with the Android app. Heavy assets,
> full libraries and complete UI pages are welcome — no size-driven shortcuts.

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

- **Via-style mobile UI on PC** — no top chrome, **pure AMOLED-black (#000000)** local home screen with the **official Via ribbon logo** extracted from the APK's assets, and no fake speed-dial tiles.
  (no external site is loaded on launch; the webview stays hidden until you
  search/navigate). A 5-icon bottom navigation bar capped at a phone-like
  500px (Back / Forward / Home / Tabs / Menu), a floating address bar, a
  card-grid tab switcher, and a dark 4-column scrollable slide-up grid menu
  with all of Via's tools.
- **Tabs** — real parallel tabs (each is a native WebView2 child webview);
  visual card grid switcher with live titles/URLs. `Ctrl+T`, `Ctrl+W`, `Ctrl+L`.
- **Omnibox + routing** — the address bar round-trips through a Rust
  `parse_and_load_url` command (Via-style URL vs. search detection) so
  `github.com` loads `https://github.com` and anything else searches the
  active engine (Google / Bing / DuckDuckGo / Baidu) with live suggestions.
- **Full Via menu (37 tools)** — Find in page, Save / Saved pages, Translate,
  View source, Full-screen, Show images, Resource sniffer, User-agent,
  Network log, Scan QR, Add to home screen, Read aloud, AI, Orientation,
  Ad blocking, Mark as ad, Text size, Clear data, Customize menu, Reload,
  Site configuration, Scripts, Print/PDF, Reader mode, Open with, Game mode,
  Add favorite, Report abuse, Bookmarks, History, Downloads, Incognito,
  Add bookmark, Desktop site, Night mode, Settings.
- **Reader mode (ported from the APK)** — bundles Via's actual
  `Readability.js` + readerable-detection + reader renderer/CSS extracted
  from the decompiled Android sources (`j6/w.java`, `j6/c0.java`), with
  next/prev-chapter navigation links.
- **Resource sniffer** — injected capture of media URLs
  (`.mp4/.mp3/.m3u8/...`) plus a live Network-log panel backed by Rust.
- **Mark as ad** — click-to-block element picker that persists a cosmetic
  filter rule per domain and ships it into the ad-blocking pipeline.
- **Ad & tracker blocker** — URL-block at request time (fetch/XHR) plus
  cosmetic content hiding using Via's bundled EasyList-derived filter list
  (extracted from `simple.txt` in the Android APK), with per-site overrides.
- **User scripts** — Tampermonkey-style script manager (name + URL match +
  code) stored in settings; Via's GM API spec is the reference.
- **Night mode** — full-window color inversion like Via on Android.
- **Desktop / Mobile / Via UA** — quick User-Agent switch + reload.
- **Downloads** — WebView2 downloads are intercepted in Rust, saved to the OS
  Downloads folder (with auto-collision handling), and surfaced in a **full-screen
  Downloads page**: category filters (All / Archives / APK / Video / Documents /
  Images / Audio / Other) with live counts, a "Download started" toast, live byte
  count, real progress bar (a same-origin HEAD probe supplies the total; otherwise
  an animated bar), green Completed / red Failed states, click-to-open and
  reveal-in-folder (↗). Saved pages land here too.
- **Settings** — dedicated full-screen categorized page (General /
  Customization / Privacy / Advanced / Scripts / About) with instant switches:
  search engine, Restore tabs on startup (reopens last session), Clear data on
  exit (Incognito), Night mode, Show images, Ad blocking, Network log, custom
  CSS, and more — plus **Export/Import .via backups** of bookmarks, history,
  settings and scripts.
- **Bookmarks & History** — dedicated full-screen pages with live search,
  click-to-open navigation, and clear-history.
- **Backup (.via)** — one-click export writes `via-backup-<ts>.via` to your
  Downloads folder; import restores the newest backup found there.
- **Privacy** — clear cache & history, Incognito (no history + auto-clear on
  exit), and a cookie inspector.
- **Persistence** — bookmarks, history, downloads/saved pages, scripts,
  per-site configuration, custom CSS, and custom filters all survive restarts.

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
