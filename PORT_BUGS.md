# Via Browser Windows — Known Bugs

## v7.4.0 — Fixed

### BUG-001: Overlay steals keyboard focus
- **Severity:** P0
- **Root cause:** `ensure_overlay_above()` called `set_focus()` on the overlay WebView after every tab switch, stealing focus from the browsing WebView
- **Fix:** Removed `set_focus()` from `ensure_overlay_above()` — overlay now shows without taking focus
- **File:** `src-tauri/src/shell.rs`

### BUG-002: Home navigation fails on external pages
- **Severity:** P0
- **Root cause:** `nav_home()` used `window.location.href = 'newtab.html'` (relative URL), which failed when browsing external sites (different origin)
- **Fix:** Changed to `window.location.replace('tauri://localhost/newtab.html')` (absolute asset URL)
- **Files:** `src-tauri/src/shell.rs`, `src-tauri/src/commands.rs`

### BUG-003: No address bar while browsing
- **Severity:** P0
- **Root cause:** Search/address input only existed on the newtab page; once navigating to a website, there was no way to type a URL
- **Fix:** Added address bar to the native navigation overlay
- **Files:** `public/nav-overlay.html`, `src-tauri/src/shell.rs`, `src-tauri/src/commands.rs`

### BUG-004: Menu invisible behind child WebViews
- **Severity:** P0
- **Root cause:** Side menu DOM was in the main webview, which is hidden behind child tab WebViews
- **Fix:** Created floating `menu-overlay.html` as a separate child WebView that sits above tab WebViews
- **Files:** `public/menu-overlay.html`, `src-tauri/src/shell.rs`, `src-tauri/src/commands.rs`, `src/main.ts`

### BUG-005: updateTabCount used unnecessary IPC hacks
- **Severity:** P2
- **Root cause:** `updateTabCount()` made multiple redundant IPC calls and tried to access overlay directly
- **Fix:** Simplified to single `__updateTabCount()` JS call on overlay
- **File:** `src/main.ts`

## v7.4.0 — Remaining Known Issues

### REMAIN-001: Overlay position not persisted across restarts
- **Severity:** P2
- **Description:** Overlay position is stored in `ShellState` (memory only), lost on restart
- **Fix needed:** Persist to `via-store.json` or local settings

### REMAIN-002: target=_blank navigates active tab instead of creating new tab
- **Severity:** P1
- **Description:** `on_new_window` navigates the active tab instead of creating a new child WebView
- **Fix needed:** Create a new tab for popup/new-window requests

### REMAIN-003: No `canGoBack`/`canGoForward` state for Back/Forward buttons
- **Severity:** P1
- **Description:** Back/Forward buttons don't reflect navigation state
- **Fix needed:** Use WebView2 navigation state or track history depth

### REMAIN-004: Private browsing is cosmetic only
- **Severity:** P1
- **Description:** Incognito toggle only suppresses history recording; no cookie/storage isolation
- **Fix needed:** Separate WebView2 profile/environment for private tabs

### REMAIN-005: No tab strip UI
- **Severity:** P2
- **Description:** No visual way to see/switch between tabs; only Ctrl+Tab or tabs panel
- **Fix needed:** Add tab strip to overlay or create tab strip overlay

### REMAIN-006: Night mode only toggles CSS class
- **Severity:** P2
- **Description:** `night_mode` adds `night-mode` class but no actual dark theme injection into child WebViews
- **Fix needed:** Inject dark CSS into child WebViews or use WebView2 dark mode

### REMAIN-007: Error page not wired into WebView2 navigation failures
- **Severity:** P2
- **Description:** `error.html` exists but isn't shown on DNS/connection failures
- **Fix needed:** Listen for WebView2 navigation errors and show error.html

### REMAIN-008: Search suggestions not live in address bar
- **Severity:** P2
- **Description:** `search_suggest` command exists but address bar doesn't show suggestions while typing
- **Fix needed:** Add debounced suggestion dropdown to address bar
