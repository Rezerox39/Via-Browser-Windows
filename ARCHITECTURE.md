# Via Browser Windows — Architecture

## Window Hierarchy

```
NATIVE TAURI WINDOW ("main")
├── MAIN WEBVIEW (index.html)       ← Created first, hidden behind child WebViews
│   ├── Homepage (search bar)       ← Shown briefly at boot
│   ├── Side menu DOM               ← Managed by main.ts
│   └── Panel DOM                   ← Bookmarks, history, settings, etc.
│
├── CHILD WEBVIEW: tab-1            ← Created via window.add_child()
│   └── Website content (Google, etc.)
│
├── CHILD WEBVIEW: tab-2            ← Another tab
│   └── Website content (YouTube, etc.)
│
├── CHILD WEBVIEW: tab-N            ← More tabs...
│
├── CHILD WEBVIEW: nav-overlay      ← Created after tabs, sits above them
│   ├── Address bar (search/URL input)
│   ├── Back / Forward / Home buttons
│   ├── Tab count badge
│   └── Menu button
│
└── CHILD WEBVIEW: menu-overlay     ← Created on-demand, sits above everything
    └── Floating menu panel
```

**Layer order (bottom to top):**
1. Main webview (hidden)
2. Tab WebViews (only active one visible)
3. Navigation overlay (always visible)
4. Menu overlay (visible when menu is open)

## Key Principles

- **Rust is authoritative for native state**: tab IDs, WebView instances, active tab, overlay position
- **Frontend is a UI projection**: receives events from Rust, renders panels/menus
- **Navigation overlay is a native sibling**: separate child WebView, NOT injected into pages
- **No JS injection for navigation**: nav buttons call Rust commands → Rust navigates the active tab WebView

## Data Flow

```
User clicks Back in overlay
  → overlay JS: invoke('on_nav_click', {action: 'back'})
  → Rust: shell::nav_back()
  → gets active tab from BrowserState
  → gets WebView label from tabs HashMap
  → calls wv.eval("history.back()")
  → browser goes back
```

```
User types URL in address bar
  → overlay JS: invoke('address_bar_navigate', {url: '...'})
  → Rust: commands::address_bar_navigate()
  → parse_address() resolves URL or search query
  → gets active tab WebView
  → calls wv.navigate(parsed_url)
  → page loads
  → on_navigation event fires
  → on_page_load fires NAVIGATION_FINISHED
  → Rust emits 'tab-url' event to main window
  → Rust calls shell::update_overlay_url() to update address bar
```

## Tab Lifecycle

1. `create_tab(url)` — Creates real native child WebView via `window.add_child()`
2. WebView is hidden by default
3. `show_tab(id)` — Shows WebView, sets bounds, focuses, updates overlay URL
4. `hide_tab(id)` — Hides WebView, moves off-screen
5. `select_tab(id)` — Shows active tab, hides all others, updates overlay
6. `close_tab(id)` — Destroys WebView, removes from state
7. All tabs share the same window bounds (full window size)

## State Management

### Rust (authoritative)
- `BrowserState.tabs: HashMap<u32, String>` — tab ID → WebView label
- `BrowserState.active: Option<u32>` — active tab ID
- `ShellState.overlay` — nav overlay position and label
- `SessionState` — saved session entries
- `SettingsState` — user settings
- `StoreState` — bookmarks, history, downloads

### Frontend (projection)
- `tabs[]` — local tab array with url/title/active
- `activeId` — current active tab ID
- `settings` — cached settings

Frontend subscribes to Rust events:
- `tab-url` — URL changed
- `tab-title` — title changed
- `nav-action` — navigation action needed
- `menu-action` — menu item clicked
- `download-started/progress/finished`

## File Structure

```
src-tauri/src/
├── lib.rs          — App setup, command registration
├── commands.rs     — All IPC commands, tab management, URL parsing
├── shell.rs        — Navigation overlay, menu overlay, 2D drag
├── features.rs     — Bookmarks, history, downloads, scripts, backup
├── settings.rs     — Settings types, UA resolution
├── init.rs         — Per-page JS injection (adblock, scripts, CSS, sniffer)
├── adblock.rs      — Filter list parser, domain blocking
├── reader.rs       — Reader mode bundle (from Via APK)
├── native.rs       — QR scanning, password manager (Windows APIs)
└── main.rs         — Entry point

src/
├── main.ts         — Frontend: tabs, search, menu, panels, keyboard
├── styles.css      — Dark theme, menu, panel, toast styles
└── main.ts.bak     — Backup

public/
├── nav-overlay.html   — Navigation overlay (address bar + buttons)
├── menu-overlay.html  — Floating menu panel
├── newtab.html        — Via new tab page (search)
├── via-logo.svg       — Via logo
└── via-icon-144.png   — Via icon

src-tauri/assets/
├── filters.txt        — Ad blocker filter list
├── error.html         — Error page (not yet wired)
├── logo.svg           — App logo
└── reader/            — Reader mode assets (from Via APK)
```
