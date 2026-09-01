# Testing Matrix — Via Browser Windows PC

## Automated (Linux sandbox, every commit)

| Command | What it validates |
|---|---|
| `npx tsc --noEmit` | Type-checks all TypeScript (IPC calls match Rust signatures) |
| `npm run build` | Vite bundles `src/main.ts` → `dist/assets/index-*.js` + CSS |
| `cargo xwin check --target x86_64-pc-windows-msvc` | Rust compiles against all frontend command/event names |
| `node scripts/smoke-test.mjs` | Headless JSDOM: verifies static HTML containers exist, panel open/close, menu renders >10 items, IPC event listeners registered (`download-started`, `download-progress`, `tab-url`, `tab-title`, `via-msg`, `new-window-request`), keyboard shortcut support. |
| `python3` Content-Disposition parser test | Validates filename extraction from `filename="x"` / `filename*=UTF-8''x` / raw `filename=x` including percent-encoded Unicode. |

## Windows manual testing (requires actual `via-browser-win.exe`)

### Navigation & toolbar
- [ ] Open app → shows homepage with logo, search bar, shortcut tiles
- [ ] Type a URL in address bar → loads page, address bar shows URL
- [ ] Type a search query → opens in default search engine
- [ ] Back / Forward / Reload buttons work and update state
- [ ] Home button returns to homepage
- [ ] Security indicator (🔒) shows for HTTPS sites
- [ ] Alt+Left / Alt+Right navigation
- [ ] F5 reload, F11 fullscreen, Escape closes panel

### Tabs
- [ ] Ctrl+T creates a new tab, Ctrl+W closes current, Ctrl+Shift+T would undo (if wired)
- [ ] Tabs panel shows all open tabs, clicking switches
- [ ] Close button on tab items removes tabs
- [ ] Tab counter badge updates

### Downloads — hard acceptance requirement
- [ ] Click a `.apk` download link → saves with `filename.apk` (real name)
- [ ] Click a GitHub release asset → saves with actual file name (not UUID)
- [ ] Click a codeload archive (URL ends in `v1.0`, no `.tar.gz`) → saves with Content-Disposition name
- [ ] Click an AWS-redirected asset (UUID in path) → saves with proper name from query params
- [ ] Download panel shows progress bar, bytes, status
- [ ] Unicode filename: link with `filename*=UTF-8''...` → saved correctly
- [ ] Server with no Content-Disposition → fallback name from URL path or `.zip`
- [ ] Collision handling: same filename → suffix `(1)`, `(2)` appended

### Bookmarks & history
- [ ] Add bookmark from menu → appears in Bookmarks panel
- [ ] Remove bookmark → disappears from list
- [ ] Click bookmark → navigates to URL
- [ ] History panel shows entries with timestamps
- [ ] Search history filter works

### Settings
- [ ] Search engine toggle cycles Google/Bing/DuckDuckGo/Baidu
- [ ] Night mode toggle applies color inversion
- [ ] Ad blocking toggle enables/disables
- [ ] Desktop/Mobile UA toggle switches user-agent
- [ ] Text size increase/decrease
- [ ] Show images toggle
- [ ] Export/Import `.via` backup files
- [ ] Settings persist after restart

### Scripts
- [ ] Scripts panel lists installed scripts
- [ ] Enable/disable scripts
- [ ] Delete script removes it
- [ ] Script injection works (test with a simple `document.title = 'test'`)

### Site configuration
- [ ] Site config panel lists per-site overrides
- [ ] Remove site config

### Keyboard shortcuts
- [ ] Ctrl+T, Ctrl+W, Ctrl+L (address bar focus), Ctrl+R, Ctrl+F, Ctrl+D, Ctrl+H, Ctrl+J
- [ ] Ctrl+Plus / Ctrl+Minus text zoom
- [ ] F5 reload, F11 fullscreen

### In-browser toasts
- [ ] "Download started" toast visible (not covered by native webview)
- [ ] "Download complete" / "Download failed" toast visible
- [ ] Bookmark added toast
- [ ] Settings changed toast

### Branding
- [ ] Via ribbon logo on homepage (blue/red/yellow SVG)
- [ ] Via logo in taskbar/title bar (icon.ico)
- [ ] NSIS installer uses Via branding, no default anvil
- [ ] About page shows "Via Browser for Windows" + version

### Persistence
- [ ] Bookmarks survive restart
- [ ] History survives restart
- [ ] Settings survive restart
- [ ] Open tabs session restore (if enabled)
- [ ] Download records persist

### Privacy
- [ ] Incognito mode: no history recorded
- [ ] Clear data: cache, cookies, history cleared
- [ ] Per-site ad blocking works
