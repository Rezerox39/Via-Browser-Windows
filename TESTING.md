# Via Browser Windows — Parity Matrix & Testing

## Parity Matrix

| Feature | Status | Evidence |
|---------|--------|----------|
| **Navigation** | REAL | URL/search routing via `parse_address()`, `wv.navigate()`, back/forward, reload, history integration |
| **Tab creation/switching** | REAL | Independent WebView2 child webviews per tab, `show_tab()`/`hide_tab()` |
| **Tab close/undo** | REAL | Close via `close_tab()`, undo via closed-tab stack `pop_closed_tab` |
| **Session restore** | REAL | `save_session()`/`restore_session()` persist tab list; restore on boot when enabled |
| **Ad blocking (URL+cosmetic)** | REAL | 3142 EasyList rules in `adblock.rs`, fetch/XHR blocking, cosmetic CSS hiding in `init.rs` |
| **Night mode** | REAL | Injects CSS via `wv.eval()` on all tabs; toggles persist |
| **Text size / zoom** | REAL | Runtime zoom via `eval_tab` on toggle, not just page load |
| **Download filename** | REAL | `probe_download_filename()` reads Content-Disposition; `real_filename()` parses query params; collision handling with `(1)` suffix |
| **Download from JS** | REAL | `download_from_js()` streams via reqwest, reads Content-Disposition from same response |
| **Blob download** | REAL | `save_blob_download()` handles page-local blob/data URIs |
| **Export/Import backup** | REAL | Versioned `.via` JSON with store + settings; import validates |
| **Clear data** | REAL | `clear_all_browsing_data()` on all webviews |
| **Bookmarks** | REAL | Add/remove/search, folder navigation, persistence via `features::Store` |
| **History** | REAL | Auto-record on navigation, search, 2000 item limit, persistence |
| **Downloads panel** | REAL | Live progress from `download-progress` events, saved history, completion status |
| **QR scan from image** | REAL (PARTIAL on Windows) | `rfd` file picker + `image` crate + `rqrr` decoder; cross-compiled successfully; requires Windows camera test for "Scan with camera" |
| **QR scan from clipboard** | REAL (PARTIAL on Windows) | `arboard` clipboard image read + `rqrr`; cross-compiled; text clipboard fallback via PowerShell |
| **QR camera capture** | UNAVAILABLE | WebView2 doesn't expose camera to Rust; would require Windows Media Foundation via `windows` crate; image-file scanner is the workaround |
| **Password manager (save)** | PARTIAL | `keyring` crate with Windows Credential Manager backend; save/get/delete wired to IPC; requires Windows test to verify Credential Manager integration |
| **Password manager (fill)** | PARTIAL | Injects credentials into active `<input>` via `eval_tab`; user must click target field first; origin-scoping via `via.{host}` service key |
| **Password manager (export)** | REMOVED | Encrypted export not implemented to avoid shipping insecure placeholder; blocked with clear error message |
| **Toolbar customization** | REAL | `ToolbarLayout` in settings JSON; placement (top/bottom), show/hide buttons, restore defaults; applied on boot |
| **Context menus** | REAL | Right-click on links: open/copy/save; on images: open/copy/save |
| **Site configuration** | PARTIAL | Per-site adblock/UA override shown for current host; only checked at navigation time, not mid-browse |
| **Cookie inspector** | PARTIAL | Lists cookies from all webviews with name/domain/path; clear-all works; per-cookie deletion not implemented |
| **Reader mode** | REAL | Readability.js + readerable.js + reader.css bundled from APK; activates via menu; renders in-page |
| **Network log** | REAL | `init.rs` captures via `__viaSniff`; displays in panel with type/URL |
| **Search suggestions** | COSMETIC | Toggle exists but `search_suggest` command not wired to frontend typing; only local history search |
| **Show images toggle** | PARTIAL | CSS injection hides images at page load; no runtime toggle for already-loaded pages |
| **User-agent switch** | PARTIAL | `resolve_ua()` returns correct UA; applied at tab creation; runtime change requires reload |
| **Incognito mode** | COSMETIC | Toggle exists in UI; no actual private-browsing isolation implemented |
| **QR scanner (camera)** | UNAVAILABLE | Requires Windows Media Foundation capture; image/clipboard scanner is the workaround |
| **Password manager (import/export)** | REMOVED | Not implemented; no fake control exposed |
| **Saved pages panel** | PARTIAL | `save_page()` saves HTML to Downloads; no dedicated saved-pages list panel |
| **Resource sniffer panel** | PARTIAL | `__viaMedia` captures URLs; only shown as toast count, no full panel |
| **Homepage shortcuts persistence** | REAL | `list_homepage_shortcuts`/`save_homepage_shortcuts` in Rust settings; survives restart |
| **Error page for nav failures** | PARTIAL | `assets/error.html` bundled but not wired to WebView2 navigation errors |
| **About page** | REAL | Via branding with logo in panel |
| **Keyboard shortcuts** | REAL | Ctrl+T/W/L/R/F/D/H/J, Ctrl+Shift+T/N, Ctrl+/-, Alt+Left/Right, F5/F11, Escape |

## Automated Tests (Linux sandbox)

| Command | What it validates |
|---|---|
| `npx tsc --noEmit` | TypeScript type-checks (IPC matches Rust signatures) |
| `npm run build` | Vite bundles to `dist/` |
| `cargo xwin check --target x86_64-pc-windows-msvc` | Rust compiles with all deps including keyring, rqrr, image, rfd, arboard |
| `node scripts/smoke-test.mjs` | Headless JSDOM: containers, menu, panels, IPC listeners, bookmarks, settings |
| Build: `bash scripts/build-windows.sh` | Full cross-compile: exe + NSIS installer |

## Windows Manual Test Checklist

### Navigation & toolbar
- [ ] Open app → homepage with logo, search bar, shortcut tiles
- [ ] Type URL → loads page, address bar shows URL
- [ ] Type search query → opens in default search engine
- [ ] Back / Forward / Reload buttons work
- [ ] Home button returns to homepage
- [ ] Security indicator (🔒) for HTTPS
- [ ] Alt+Left/Right navigation, F5 reload, F11 fullscreen, Escape closes panel
- [ ] Toolbar customization: top/bottom placement, show/hide buttons, persist on restart

### Tabs
- [ ] Ctrl+T new tab, Ctrl+W close, Ctrl+Shift+T undo-close
- [ ] Tabs panel shows all open tabs, click switches
- [ ] Five independent tabs with separate browsing contexts
- [ ] Close last tab shows homepage
- [ ] Session restore on restart (if enabled)

### Downloads
- [ ] Click .apk link → saves with `filename.apk`
- [ ] Click GitHub release asset → saves with actual name (not UUID)
- [ ] Click codeload archive → saves with Content-Disposition name
- [ ] Click AWS-redirected asset → saves with proper name from query params
- [ ] Download panel shows progress, bytes, status
- [ ] Unicode filename from Content-Disposition
- [ ] Collision: same filename → `(1)`, `(2)` suffix

### QR Scanner
- [ ] Scan from image file: PNG/JPG with QR code → decodes correctly
- [ ] Scan from clipboard: copy image, paste → decodes
- [ ] Scan from text clipboard: copy URL, scan → shows URL with Open/Copy
- [ ] No auto-navigation without user confirmation
- [ ] Cancel button works
- [ ] Camera: (requires Windows machine with camera)

### Password Manager
- [ ] Save credentials for current site → stored in Windows Credential Manager
- [ ] Fill credentials: click password field, then Fill → injects password
- [ ] Delete credentials → removes from Credential Manager
- [ ] Credentials don't appear in settings export, logs, or frontend state
- [ ] Wrong origin rejected (service key scoped by host)

### Toolbar Customization
- [ ] Open toolbar panel from menu
- [ ] Switch top/bottom placement → toolbar moves
- [ ] Toggle buttons on/off → buttons appear/disappear
- [ ] Restore defaults → resets to original layout
- [ ] Restart app → layout persists

### Panels
- [ ] Every panel opens above a loaded webpage
- [ ] Panels scroll, close with Escape/backdrop
- [ ] Resize window → panels adapt
- [ ] Context menu on links and images

### Settings
- [ ] Search engine cycling persists after restart
- [ ] Night mode applies CSS to all tabs
- [ ] Text size zoom applies to active page
- [ ] Ad blocking toggle changes behavior
- [ ] User-Agent switch reloads with new UA
- [ ] Clear data clears cache/cookies/history

### Keyboard shortcuts
- [ ] Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+R, Ctrl+F, Ctrl+D, Ctrl+H, Ctrl+J
- [ ] Ctrl+Shift+T (undo close), Ctrl+Shift+N (incognito toggle)
- [ ] Ctrl+Plus/Minus (zoom), Alt+Left/Right (nav), F5, F11, Escape

### Packaging
- [ ] Fresh install from .exe runs correctly
- [ ] NSIS installer completes without errors
- [ ] Via logo in title bar (no anvil default)
- [ ] App icon in taskbar

## Known Limitations (WebView2)
- Camera capture: not exposed to Rust layer; requires Windows Media Foundation
- Per-tab cookie isolation: WebView2 shares cookie jar across webviews
- Runtime UA change: requires page reload (WebView2 sets UA at creation)
- Show images toggle: only affects new page loads, not already-loaded pages
- Error page: `error.html` bundled but not wired to WebView2 error events
