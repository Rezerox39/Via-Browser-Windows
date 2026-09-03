# Via Browser Windows — Port Status Matrix

**Last updated:** v7.4.0  
**Reference:** Via Android APK (v7.2.1)

## Status Key

| Status | Meaning |
|--------|---------|
| MATCH | Functionally equivalent to Android |
| PARTIAL | Some functionality works but important behavior missing |
| BROKEN | Implementation exists but does not work reliably |
| MISSING | No meaningful implementation |
| PLACEHOLDER | UI or code exists but is effectively fake |
| WINDOWS_DIFFERENCE | Android behavior cannot exist on Windows, but good equivalent exists |
| UNKNOWN | Insufficient evidence |

## P0 — Core Browser

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| URL navigation | Full | Full | MATCH | `navigate_tab` + `parse_address` | HTTP/HTTPS/localhost/IP |
| Search navigation | Full | Full | MATCH | `parse_address` with engine routing | All 12 engines |
| HTTPS | Full | Full | MATCH | WebView2 native | |
| Back | Full | Partial | PARTIAL | `history.back()` via eval | No `canGoBack` state |
| Forward | Full | Partial | PARTIAL | `history.forward()` via eval | No `canGoForward` state |
| Reload | Full | Full | MATCH | `location.reload()` via eval | |
| Stop loading | Full | Missing | MISSING | No stop command | |
| URL without scheme | Full | Full | MATCH | `parse_address` adds https:// | |
| Malformed URLs | Full | Partial | PARTIAL | Falls back to search | May miss edge cases |
| Certificate errors | Full | Unknown | UNKNOWN | WebView2 default behavior | |
| DNS failures | Full | Unknown | UNKNOWN | WebView2 default behavior | |
| target=_blank | Full | Partial | PARTIAL | `on_new_window` → navigates active tab | Should create new tab |
| window.open() | Full | Partial | PARTIAL | Same as target=_blank | |
| JavaScript navigation | Full | Full | MATCH | WebView2 native | |
| Download triggered nav | Full | Full | MATCH | `on_download` handler | |

## P1 — Tabs

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| New tab | Full | Full | MATCH | `create_tab` → real WebView | |
| Close tab | Full | Full | MATCH | `close_tab` → destroy WebView | |
| Switch tab | Full | Full | MATCH | `show_tab` / `select_tab` | |
| Many tabs | Full | Partial | PARTIAL | Works but no cleanup of stale state | |
| Tab restore (restart) | Full | Partial | PARTIAL | `save_session` / `restore_session` | |
| Duplicate tab | Full | Missing | MISSING | No duplicate command | |
| Recently closed | Full | Partial | PARTIAL | `ClosedTabStack` exists, no UI panel | |
| Ctrl+T | Full | Full | MATCH | Frontend keyboard handler | |
| Ctrl+W | Full | Full | MATCH | Frontend keyboard handler | |
| Ctrl+Shift+T | Full | Full | MATCH | Frontend keyboard handler | |
| Ctrl+Tab | Full | Missing | MISSING | No cycling shortcut | |
| Tab strip UI | Full | Missing | MISSING | No visual tab strip | |
| Tab count | Full | Full | MATCH | Overlay badge | |

## P1 — Navigation Overlay

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| Address bar | N/A (top bar) | Full | MATCH | New in v7.4.0 | Address bar in overlay |
| Back button | Full | Full | MATCH | `shell::nav_back` | |
| Forward button | Full | Full | MATCH | `shell::nav_forward` | |
| Home button | Full | Full | MATCH | `shell::nav_home` → navigate to newtab | Fixed URL resolution |
| Tabs button | Full | Full | MATCH | Opens tabs panel | |
| Menu button | Full | Full | MATCH | Opens floating menu overlay | New in v7.4.0 |
| 2D dragging | Full | Full | MATCH | Full X/Y with threshold | |
| Persistent position | Full | Partial | PARTIAL | In-memory only, lost on restart | |
| Resize clamping | Full | Full | MATCH | `clamp_overlay_position` | |
| Above WebViews | Full | Full | MATCH | Child WebView, created after tabs | |

## P1 — Menu

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| Menu panel | Full | Full | MATCH | Floating overlay WebView | New in v7.4.0 |
| Bookmarks | Full | Full | MATCH | Panel + IPC | |
| History | Full | Full | MATCH | Panel + IPC | |
| Downloads | Full | Full | MATCH | Panel + IPC | |
| Night mode | Full | Partial | PARTIAL | CSS class toggle, no dark injection | |
| Desktop mode | Full | Partial | PARTIAL | UA string, no per-site | |
| Find in page | Full | Partial | PARTIAL | Via `__viaSend` message bus | |
| Scripts | Full | Partial | PARTIAL | Manager exists, execution works | |
| Reader mode | Full | Partial | PARTIAL | Bundle exists, activation via menu | |
| User agent | Full | Partial | PARTIAL | Settings exist, applied at tab creation | |
| Site config | Full | Partial | PARTIAL | Adblock per-site, not UA/JS | |
| Saved pages | Full | Partial | PARTIAL | `save_page` saves HTML to downloads | |
| Network log | Full | Partial | PARTIAL | Resource sniffer in init.js | |
| Share/URL copy | Full | Full | MATCH | Clipboard copy | |
| Refresh | Full | Full | MATCH | `location.reload()` | |

## P1 — Bookmarks

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| Add bookmark | Full | Full | MATCH | `add_bookmark` IPC | |
| Remove bookmark | Full | Full | MATCH | `remove_bookmark` IPC | |
| List bookmarks | Full | Full | MATCH | `list_bookmarks` IPC | |
| Edit bookmark | Full | Missing | MISSING | No edit command | |
| Folders | Full | Partial | PARTIAL | `folder` field exists, no folder UI | |
| Persistence | Full | Full | MATCH | JSON store | |
| Import/Export | Full | Partial | PARTIAL | Via backup system | |

## P1 — History

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| Record pages | Full | Full | MATCH | `add_history` on page load | |
| Search | Full | Full | MATCH | `list_history` with query | |
| Delete item | Full | Missing | MISSING | No single-item delete | |
| Clear all | Full | Full | MATCH | `clear_history` | |
| Persistence | Full | Full | MATCH | JSON store | |
| Private exclusion | Full | Missing | MISSING | No private mode isolation | |

## P1 — Downloads

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| Native downloads | Full | Full | MATCH | `on_download` handler | |
| Filename handling | Full | Full | MATCH | `real_filename` + dedup | |
| Progress | Full | Partial | PARTIAL | Events emitted, limited detail | |
| Cancel | Full | Missing | MISSING | No cancel command | |
| Download list | Full | Full | MATCH | `list_downloads` | |
| Open file | Full | Full | MATCH | `open_download` | |
| Reveal in folder | Full | Full | MATCH | `reveal_download` | |
| Blob downloads | Full | Full | MATCH | JS capture + `save_blob_download` | |
| Persistence | Full | Full | MATCH | JSON store | |

## P2 — Features

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| Ad blocking | Full | Partial | PARTIAL | fetch/XHR/image intercept + cosmetic | No network-level |
| Mark as ad | Full | Full | MATCH | `mark_as_ad` with selector | |
| Custom CSS | Full | Partial | PARTIAL | `user_css` setting, injected via init.js | |
| User scripts | Full | Partial | PARTIAL | Tampermonkey-style, URL matching | |
| Cookie manager | Full | Partial | PARTIAL | `get_cookies` / `clear_cookies` | |
| QR scanner | Full | Partial | PARTIAL | Image/file/clipboard scan | No live camera |
| Password manager | Full | Full | MATCH | Windows Credential Manager | |
| Backup/Restore | Full | Full | MATCH | `.via` export/import | |
| Private browsing | Full | Missing | MISSING | Boolean flag only, no isolation | |
| Fullscreen | Full | Full | MATCH | F11 shortcut | |
| Night mode | Full | Partial | PARTIAL | CSS class only | |
| Text zoom | Full | Full | MATCH | `text_size` CSS zoom | |
| Show images | Full | Partial | PARTIAL | CSS hide, not real blocking | |
| Incognito | Full | Place | PLACEHOLDER | Toggle exists, no real isolation | |
| Search suggestions | Full | Partial | PARTIAL | `search_suggest` command exists | |

## P3 — Polish

| Feature | Android | Windows | Status | Evidence | Notes |
|---------|---------|---------|--------|----------|-------|
| Dark theme | Full | Partial | PARTIAL | Dark CSS, no light theme | |
| Tab strip | Full | Missing | MISSING | No visual tab strip | |
| Context menu | Full | Partial | PARTIAL | WebView2 default | |
| Keyboard shortcuts | Full | Partial | PARTIAL | Ctrl+T/W/B/H/L | |
| DPI scaling | Full | Unknown | UNKNOWN | Not tested | |
| Window state persist | Full | Missing | MISSING | No window position save | |

## Summary Counts

| Status | Count |
|--------|-------|
| MATCH | 38 |
| PARTIAL | 30 |
| BROKEN | 0 |
| MISSING | 12 |
| PLACEHOLDER | 1 |
| WINDOWS_DIFFERENCE | 0 |
| UNKNOWN | 3 |
| **Total** | **84** |
