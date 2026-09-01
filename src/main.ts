import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/* ═══════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════ */
type Tab = { id: number; url: string; title: string; active: boolean };
type TabInfo = { id: number; url: string; title: string; loading: boolean; active: boolean };
type Settings = {
  homepage: string; search_engine: string; ua_mode: string; custom_ua: string;
  adblock_enabled: boolean; clear_on_exit: boolean; user_css: string;
  night_mode: boolean; desktop_mode: boolean; text_size: number;
  show_images: boolean; network_log: boolean; game_mode: boolean;
  search_suggest: boolean; scripts: UserScript[]; sites: SiteConfig[];
  pages_log: string[][]; restore_tabs: boolean; homepage_shortcuts: HomeShortcut[];
  toolbar_layout: ToolbarLayout;
};
type UserScript = { id: string; name: string; match_urls: string; code: string; enabled: boolean };
type SiteConfig = { host: string; ua_mode: string; adblock_enabled: boolean };
type HomeShortcut = { label: string; url: string; icon: string };
type ToolbarLayout = { placement: string; visible: string[]; compact_two_row: boolean };
type Bookmark = { url: string; title: string; folder: string };
type HistItem = { url: string; title: string; ts: number };
type DlItem = { url: string; path: string; title: string; size: number; done: boolean };
type ClosedTab = { url: string; title: string; ts: number };
type SessionEntry = { url: string; title: string; active: boolean; order: number };

const ENGINES: Record<string, string> = {
  Google: "https://www.google.com/search?q=",
  DuckDuckGo: "https://duckduckgo.com/?q=",
  Bing: "https://www.bing.com/search?q=",
  Baidu: "https://www.baidu.com/s?wd=",
};

/* ═══════════════════════════════════════════════
   State
   ═══════════════════════════════════════════════ */
let tabs: Tab[] = [];
let activeId: number | null = null;
let searchEngine = "Google";
let settings: Settings | null = null;
let bookmarks: Bookmark[] = [];
let historyItems: HistItem[] = [];
let downloads: DlItem[] = [];
let nightMode = false;
let desktopMode = true;
let textSize = 1.0;
let showImages = true;
let adblockOn = true;
let incognitoMode = false;
let restoreTabs = false;
let menuPage = 0;
const MENU_PAGE_SIZE = 12;

/* ═══════════════════════════════════════════════
   DOM helpers
   ═══════════════════════════════════════════════ */
const $ = (s: string) => document.getElementById(s) as HTMLElement;
function esc(s: string): string { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function showToast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout((el as any)._t);
  (el as any)._t = setTimeout(() => el.classList.remove("show"), 2400);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(1) + " GB";
}

/* ═══════════════════════════════════════════════
   Menu item definitions
   ═══════════════════════════════════════════════ */
interface MenuItem {
  id: string;
  label: string;
  icon: string;
  action: () => void;
  active?: () => boolean;
}

function makeMenuIcon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${paths}</svg>`;
}

const MENU_ITEMS: MenuItem[] = [
  { id: "bookmarks", label: "Bookmarks", icon: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>',
    action: () => openPanel("Bookmarks", renderBookmarks) },
  { id: "history", label: "History", icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    action: () => openPanel("History", renderHistory) },
  { id: "downloads", label: "Downloads", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    action: () => openPanel("Downloads", renderDownloads) },
  { id: "saved", label: "Saved pages", icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    action: () => openPanel("Saved Pages", renderSavedPages) },
  { id: "night", label: "Night mode", icon: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>',
    action: () => { nightMode = !nightMode; applyNightMode(); persistSettings(); showToast(nightMode ? "Night mode on" : "Night mode off"); refreshMenuState(); } },
  { id: "desktop", label: "Desktop mode", icon: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    action: () => { desktopMode = !desktopMode; persistSettings(); showToast(desktopMode ? "Desktop UA" : "Mobile UA"); refreshMenuState(); } },
  { id: "reader", label: "Reader mode", icon: '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>',
    action: () => activateReader() },
  { id: "qr", label: "QR scanner", icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="4" height="4"/><line x1="21" y1="14" x2="21" y2="21"/><line x1="14" y1="21" x2="21" y2="21"/>',
    action: () => scanQR() },
  { id: "find", label: "Find on page", icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
    action: () => activateFind() },
  { id: "fullscreen", label: "Full screen", icon: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    action: () => toggleFullscreen() },
  { id: "share", label: "Share link", icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    action: () => shareLink() },
  { id: "addbm", label: "Add bookmark", icon: '<path d="M12 5v14M5 12h14"/>',
    action: () => addBookmark() },
  { id: "extensions", label: "Extensions", icon: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    action: () => openPanel("Extensions", renderExtensions) },
  { id: "scripts", label: "Scripts", icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    action: () => openPanel("Scripts", renderScripts) },
  { id: "siteconfig", label: "Site config", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    action: () => openPanel("Site configuration", renderSiteConfig) },
  { id: "cookies", label: "Cookies", icon: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><path d="M12 6a6 6 0 100 12 6 6 0 000-12z"/><circle cx="12" cy="12" r="2"/>',
    action: () => openPanel("Cookies", renderCookies) },
  { id: "customize", label: "Customize", icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    action: () => openPanel("Customize menu", renderCustomizeMenu) },
  { id: "settings", label: "Settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>',
    action: () => openPanel("Settings", renderSettings) },
  { id: "about", label: "About", icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    action: () => openPanel("About", renderAbout) },
];

function getDefaultMenuOrder(): string[] {
  return MENU_ITEMS.map(i => i.id);
}

function getMenuOrder(): string[] {
  const order = settings?.toolbar_layout?.visible;
  if (order && order.length > 0) {
    const valid = order.filter(id => MENU_ITEMS.some(m => m.id === id));
    const missing = MENU_ITEMS.map(m => m.id).filter(id => !valid.includes(id));
    return [...valid, ...missing];
  }
  return getDefaultMenuOrder();
}

/* ═══════════════════════════════════════════════
   Tab management
   ═══════════════════════════════════════════════ */
async function createTab(url?: string): Promise<Tab> {
  const info = await invoke<TabInfo>("create_tab", { url: url || null });
  const tab: Tab = { id: info.id, url: info.url || "about:blank", title: "New tab", active: true };
  tabs.push(tab);
  await invoke("select_tab", { id: info.id });
  activeId = info.id;
  showBrowsingUI();
  updateTabCount();
  return tab;
}

async function closeTab(id: number) {
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    await invoke("push_closed_tab", { url: tab.url, title: tab.title }).catch(() => {});
  }
  await invoke("close_tab", { id }).catch(() => {});
  tabs = tabs.filter(t => t.id !== id);
  if (activeId === id) {
    if (tabs.length > 0) {
      const last = tabs[tabs.length - 1];
      await switchTab(last.id);
    } else {
      activeId = null;
      showHomepage();
    }
  }
  updateTabCount();
}

async function switchTab(id: number) {
  tabs.forEach(t => t.active = false);
  const tab = tabs.find(t => t.id === id);
  if (tab) tab.active = true;
  activeId = id;
  await invoke("select_tab", { id }).catch(() => {});
  showBrowsingUI();
  updateUrlDisplay();
  updateTabCount();
}

function updateTabCount() {
  const count = tabs.length || 1;
  const el1 = $("nav-tab-count");
  const el2 = $("url-tab-count");
  if (el1) el1.textContent = String(count);
  if (el2) el2.textContent = String(count);
}

function updateUrlDisplay() {
  const tab = tabs.find(t => t.id === activeId);
  const input = $("url-input") as HTMLInputElement;
  if (tab && tab.url && tab.url !== "about:blank") {
    input.value = tab.url;
  }
}

function updateNavButtons() {
  // We can't query history state from the webview, so we keep buttons always enabled
  // and let the webview handle back/forward internally
  const back = $("nav-back");
  const fwd = $("nav-fwd");
  const urlBack = $("url-back");
  const urlFwd = $("url-fwd");
  if (activeId) {
    back?.removeAttribute("disabled");
    fwd?.removeAttribute("disabled");
    urlBack?.removeAttribute("disabled");
    urlFwd?.removeAttribute("disabled");
  } else {
    back?.setAttribute("disabled", "");
    fwd?.setAttribute("disabled", "");
    urlBack?.setAttribute("disabled", "");
    urlFwd?.setAttribute("disabled", "");
  }
}

/* ═══════════════════════════════════════════════
   Homepage / URL bar
   ═══════════════════════════════════════════════ */
function showHomepage() {
  $("home").classList.remove("hidden");
  $("url-bar").classList.add("hidden");
  activeId = null;
  hideAllWebviews();
  updateNavButtons();
  closeSideMenu();
}

function showBrowsingUI() {
  $("home").classList.add("hidden");
  $("url-bar").classList.remove("hidden");
  updateUrlDisplay();
  updateNavButtons();
}

function openUrlBar() {
  $("home").classList.add("hidden");
  $("url-bar").classList.remove("hidden");
  const input = $("url-input") as HTMLInputElement;
  input.value = "";
  input.focus();
}

async function navigate(url: string) {
  if (activeId) {
    await invoke("navigate_tab", { id: activeId, url }).catch(() => {});
    updateUrlDisplay();
    return;
  }
  await createTab(url);
}

function handleUrlGo() {
  const val = ($("url-input") as HTMLInputElement).value.trim();
  if (!val) return;
  closeSideMenu();
  if (/^https?:\/\//i.test(val) || /^[a-z0-9-]+\.[a-z]/i.test(val) || val.includes("://")) {
    navigate(/^https?:\/\//i.test(val) ? val : "https://" + val);
  } else {
    navigate((ENGINES[searchEngine] || ENGINES.Google) + encodeURIComponent(val));
  }
}

function hideAllWebviews() {
  if (activeId) invoke("hide_tab", { id: activeId }).catch(() => {});
}

/* ═══════════════════════════════════════════════
   Side Menu
   ═══════════════════════════════════════════════ */
function buildSideMenuGrid() {
  const grid = $("side-menu-grid");
  const order = getMenuOrder();
  const start = menuPage * MENU_PAGE_SIZE;
  const pageIds = order.slice(start, start + MENU_PAGE_SIZE);
  const items = pageIds.map(id => MENU_ITEMS.find(m => m.id === id)).filter(Boolean) as MenuItem[];

  grid.innerHTML = items.map(item => {
    const active = item.active?.() ? " active" : "";
    return `<button class="sheet-item${active}" data-menu-id="${item.id}">${makeMenuIcon(item.icon)}<span>${item.label}</span></button>`;
  }).join("");

  grid.querySelectorAll(".sheet-item").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-menu-id")!;
      const item = MENU_ITEMS.find(m => m.id === id);
      if (item) { closeSideMenu(); item.action(); }
    });
  });

  // Pagination
  const totalPages = Math.ceil(order.length / MENU_PAGE_SIZE);
  $("side-menu-pagination").innerHTML = Array.from({ length: totalPages }, (_, i) =>
    `<div class="pg-dot${i === menuPage ? ' active' : ''}" data-p="${i}"></div>`
  ).join("");
  $("side-menu-pagination").querySelectorAll(".pg-dot").forEach(el => {
    el.addEventListener("click", () => { menuPage = parseInt(el.getAttribute("data-p")!); buildSideMenuGrid(); });
  });
}

function refreshMenuState() { buildSideMenuGrid(); }

function openSideMenu() {
  buildSideMenuGrid();
  $("side-menu").classList.add("open");
  $("menu-backdrop").classList.add("open");
  if (activeId) invoke("hide_tab", { id: activeId }).catch(() => {});
}

function closeSideMenu() {
  $("side-menu").classList.remove("open");
  $("menu-backdrop").classList.remove("open");
  if (activeId) invoke("show_tab", { id: activeId }).catch(() => {});
}

/* ═══════════════════════════════════════════════
   Panel system
   ═══════════════════════════════════════════════ */
let panelType = "";

function openPanel(title: string, renderFn: (body: HTMLElement) => void) {
  $("panel-title").textContent = title;
  const body = $("panel-body");
  body.innerHTML = "";
  renderFn(body);
  $("panel-backdrop").classList.add("open");
  $("panel").classList.add("open");
  if (activeId) invoke("hide_tab", { id: activeId }).catch(() => {});
}

function closePanel() {
  $("panel-backdrop").classList.remove("open");
  $("panel").classList.remove("open");
  panelType = "";
  if (activeId) invoke("show_tab", { id: activeId }).catch(() => {});
}

/* ═══════════════════════════════════════════════
   Panel renderers
   ═══════════════════════════════════════════════ */
function renderBookmarks(body: HTMLElement) {
  bookmarks = (window as any).__bmCache || bookmarks;
  if (!bookmarks.length) { body.innerHTML = '<div class="empty-state">No bookmarks yet</div>'; return; }
  body.innerHTML = '<div class="pp-list">' + bookmarks.map(b =>
    `<div class="pp-item" data-url="${esc(b.url)}">
      <div class="pi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg></div>
      <div class="pi-info"><div class="pi-title">${esc(b.title || b.url)}</div><div class="pi-sub">${esc(b.url)}</div></div>
      <div class="pi-action" data-del="${esc(b.url)}">✕</div>
    </div>`
  ).join("") + "</div>";
  body.querySelectorAll(".pp-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).getAttribute("data-del")) {
        const url = (e.target as HTMLElement).getAttribute("data-del")!;
        invoke("remove_bookmark", { url }).then(() => {
          bookmarks = bookmarks.filter(b => b.url !== url);
          renderBookmarks(body);
          showToast("Bookmark removed");
        });
        return;
      }
      const url = el.getAttribute("data-url")!;
      closePanel();
      navigate(url);
    });
  });
}

function renderHistory(body: HTMLElement) {
  if (!historyItems.length) { body.innerHTML = '<div class="empty-state">No history yet</div>'; return; }
  const grouped: Record<string, HistItem[]> = {};
  historyItems.forEach(h => {
    const d = new Date(h.ts * 1000).toISOString().slice(0, 10);
    (grouped[d] = grouped[d] || []).push(h);
  });
  body.innerHTML = '<div style="padding:8px 16px"><button class="btn" id="clear-history-btn">Clear history</button></div>' +
    Object.entries(grouped).map(([date, items]) =>
    `<div class="sec-title">${date}</div><div class="pp-list">` +
    items.map(h =>
      `<div class="pp-item" data-url="${esc(h.url)}">
        <div class="pi-info"><div class="pi-title">${esc(h.title || h.url)}</div><div class="pi-sub" style="color:var(--accent)">${esc(h.url)}</div></div>
      </div>`
    ).join("") + "</div>"
  ).join("");
  body.querySelector("#clear-history-btn")?.addEventListener("click", async () => {
    await invoke("clear_history");
    historyItems = [];
    renderHistory(body);
    showToast("History cleared");
  });
  body.querySelectorAll(".pp-item").forEach(el => {
    el.addEventListener("click", () => { closePanel(); navigate(el.getAttribute("data-url")!); });
  });
}

function renderDownloads(body: HTMLElement) {
  if (!downloads.length) { body.innerHTML = '<div class="empty-state">No downloads yet</div>'; return; }
  body.innerHTML = downloads.map(d =>
    `<div class="dl-item">
      <div class="dl-name">${esc(d.title)}</div>
      <div class="dl-meta">${formatSize(d.size)} ${d.done ? "✓ Complete" : "In progress"}</div>
      ${d.done ? `<div class="dl-actions">
        <button data-open="${esc(d.path)}">Open</button>
        <button data-folder="${esc(d.path)}">Show in folder</button>
      </div>` : ""}
    </div>`
  ).join("");
  body.querySelectorAll("[data-open]").forEach(el =>
    el.addEventListener("click", () => invoke("open_download", { path: el.getAttribute("data-open")! }))
  );
  body.querySelectorAll("[data-folder]").forEach(el =>
    el.addEventListener("click", () => invoke("reveal_download", { path: el.getAttribute("data-folder")! }))
  );
}

function renderSavedPages(body: HTMLElement) {
  body.innerHTML = '<div class="empty-state">No saved pages yet.<br>Use "Save page" from a web page to save it here.</div>';
}

function renderExtensions(body: HTMLElement) {
  body.innerHTML = `
    <div style="padding:16px">
      <div class="sec-title">Chrome Extensions</div>
      <div style="padding:12px 0;color:var(--fg-muted);font-size:13px;line-height:1.6">
        Via Browser uses Microsoft WebView2 which does not support Chrome extensions directly.
        <br><br>
        Extensions provide ad blocking, privacy protection, and customization. For similar functionality, Via includes:
        <br>• Built-in ad blocking (Settings → Ad blocking)
        <br>• Built-in tracker prevention
        <br>• User scripts (Scripts menu)
        <br>• Custom user CSS and JavaScript (Settings)
        <br><br>
        If extension support is added in a future WebView2 release, it will appear here.
      </div>
    </div>`;
}

function renderScripts(body: HTMLElement) {
  const scripts = settings?.scripts || [];
  if (!scripts.length) {
    body.innerHTML = '<div class="empty-state">No scripts yet</div><div style="padding:16px"><button class="btn primary" id="add-script-btn">+ Add Script</button></div>';
    body.querySelector("#add-script-btn")?.addEventListener("click", () => {
      const name = prompt("Script name:");
      if (!name) return;
      const matchUrls = prompt("Match URLs (semicolon-separated, empty for all):", "") || "";
      const code = prompt("Script code:", "") || "";
      if (!code) { showToast("No code provided"); return; }
      const id = "s" + Date.now();
      const script: UserScript = { id, name, match_urls: matchUrls, code, enabled: true };
      if (!settings) settings = { ...({} as Settings), scripts: [] };
      settings.scripts.push(script);
      invoke("save_script", { script }).then(() => {
        showToast("Script saved");
        renderScripts(body);
      });
    });
    return;
  }
  body.innerHTML = '<div class="pp-list">' + scripts.map(s =>
    `<div class="pp-item" data-sid="${esc(s.id)}">
      <div class="pi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>
      <div class="pi-info"><div class="pi-title">${esc(s.name)}</div><div class="pi-sub">${esc(s.match_urls || "All pages")}</div></div>
      <div class="pi-action" data-delscript="${esc(s.id)}">✕</div>
    </div>`
  ).join("") + '</div><div style="padding:16px"><button class="btn primary" id="add-script-btn">+ Add Script</button></div>';
  body.querySelectorAll("[data-delscript]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = el.getAttribute("data-delscript")!;
      await invoke("delete_script", { id });
      if (settings) settings.scripts = settings.scripts.filter(s => s.id !== id);
      renderScripts(body);
      showToast("Script deleted");
    });
  });
  body.querySelector("#add-script-btn")?.addEventListener("click", () => {
    const name = prompt("Script name:");
    if (!name) return;
    const matchUrls = prompt("Match URLs (semicolon-separated, empty for all):", "") || "";
    const code = prompt("Script code:", "") || "";
    if (!code) { showToast("No code provided"); return; }
    const id = "s" + Date.now();
    const script: UserScript = { id, name, match_urls: matchUrls, code, enabled: true };
    if (!settings) settings = { ...({} as Settings), scripts: [] };
    settings.scripts.push(script);
    invoke("save_script", { script }).then(() => {
      showToast("Script saved");
      renderScripts(body);
    });
  });
}

function renderSiteConfig(body: HTMLElement) {
  const sites = settings?.sites || [];
  if (!sites.length) {
    body.innerHTML = '<div class="empty-state">No per-site overrides yet.<br>Open a site and configure it from the menu.</div>';
    return;
  }
  body.innerHTML = '<div class="pp-list">' + sites.map(s =>
    `<div class="pp-item">
      <div class="pi-info">
        <div class="pi-title">${esc(s.host)}</div>
        <div class="pi-sub">UA: ${esc(s.ua_mode || "Default")} · Ad block: ${s.adblock_enabled ? "On" : "Off"}</div>
      </div>
      <div class="pi-action" data-delhost="${esc(s.host)}">✕</div>
    </div>`
  ).join("") + "</div>";
  body.querySelectorAll("[data-delhost]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const host = el.getAttribute("data-delhost")!;
      await invoke("delete_site_config", { host });
      if (settings) settings.sites = settings.sites.filter(s => s.host !== host);
      renderSiteConfig(body);
      showToast("Site config removed");
    });
  });
}

function renderCookies(body: HTMLElement) {
  invoke<any[]>("get_cookies").then(cookies => {
    if (!cookies.length) { body.innerHTML = '<div class="empty-state">No cookies</div>'; return; }
    body.innerHTML = '<div class="pp-list">' + cookies.map(c =>
      `<div class="pp-item">
        <div class="pi-info"><div class="pi-title">${esc(c.name || "?")}</div>
        <div class="pi-sub">${esc(c.domain || "?")} · ${esc(c.value?.substring(0, 30) || "")}${(c.value?.length || 0) > 30 ? "..." : ""}</div></div>
      </div>`
    ).join("") + '</div><div style="padding:16px"><button class="btn" id="clear-cookies-btn">Clear all cookies</button></div>';
    body.querySelector("#clear-cookies-btn")?.addEventListener("click", async () => {
      await invoke("clear_cookies");
      renderCookies(body);
      showToast("Cookies cleared");
    });
  }).catch(() => { body.innerHTML = '<div class="empty-state">Could not read cookies</div>'; });
}

function renderCustomizeMenu(body: HTMLElement) {
  const order = getMenuOrder();
  body.innerHTML = `
    <div class="sec-title">Hold and drag to rearrange items</div>
    <div id="customize-list">${order.map(id => {
      const item = MENU_ITEMS.find(m => m.id === id);
      if (!item) return "";
      return `<div class="drag-item" data-mid="${item.id}" draggable="true">
        <span class="drag-handle">⠿</span>
        <span class="drag-label">${esc(item.label)}</span>
        <span class="switch on" data-toggle="${item.id}"></span>
      </div>`;
    }).join("")}</div>
    <div style="padding:16px">
      <button class="btn" id="reset-menu-btn">Reset to defaults</button>
    </div>`;

  // Toggle visibility
  body.querySelectorAll(".switch[data-toggle]").forEach(el => {
    el.addEventListener("click", async () => {
      el.classList.toggle("on");
      // Save the order with toggled state
      await saveCustomizeState(body);
    });
  });

  // Drag and drop reorder
  const list = body.querySelector("#customize-list")!;
  let dragEl: HTMLElement | null = null;
  list.addEventListener("dragstart", (e) => {
    dragEl = (e.target as HTMLElement).closest(".drag-item");
    if (dragEl) dragEl.style.opacity = "0.5";
  });
  list.addEventListener("dragend", () => {
    if (dragEl) dragEl.style.opacity = "";
    dragEl = null;
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest(".drag-item") as HTMLElement;
    if (target && target !== dragEl && dragEl) {
      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        list.insertBefore(dragEl, target);
      } else {
        list.insertBefore(dragEl, target.nextSibling);
      }
    }
  });

  // Reset button
  body.querySelector("#reset-menu-btn")?.addEventListener("click", async () => {
    if (settings && settings.toolbar_layout) settings.toolbar_layout.visible = [];
    await persistSettings();
    renderCustomizeMenu(body);
    showToast("Menu reset to defaults");
  });
}

async function saveCustomizeState(body: HTMLElement) {
  const items = body.querySelectorAll(".drag-item");
  const order: string[] = [];
  items.forEach(el => {
    const id = el.getAttribute("data-mid")!;
    const toggle = el.querySelector(".switch");
    if (toggle && toggle.classList.contains("on")) {
      order.push(id);
    }
  });
  if (!settings) return;
  if (!settings.toolbar_layout) settings.toolbar_layout = { placement: "top", visible: [], compact_two_row: false };
  settings.toolbar_layout.visible = order;
  await persistSettings();
  refreshMenuState();
}

function renderSettings(body: HTMLElement) {
  const s = settings;
  if (!s) return;
  body.innerHTML = `
    <div class="mg-list">
      <div class="sec-title">General</div>
      <div class="mg-item" data-set="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Search engine <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></span></div>
      <div class="mg-item" data-set="suggest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> Search suggestions <span class="switch ${s.search_suggest ? 'on' : ''}" data-key="search_suggest"></span></div>

      <div class="sec-title">Appearance</div>
      <div class="mg-item" data-set="night"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg> Night mode <span class="switch ${nightMode ? 'on' : ''}" data-key="night_mode"></span></div>
      <div class="mg-item" data-set="textsize"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg> Text size <span style="margin-left:auto;color:var(--fg-muted)">${Math.round(s.text_size * 100)}%</span></div>
      <div class="mg-item" data-set="showimg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Show images <span class="switch ${s.show_images ? 'on' : ''}" data-key="show_images"></span></div>

      <div class="sec-title">Privacy</div>
      <div class="mg-item" data-set="adblock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Ad blocking <span class="switch ${s.adblock_enabled ? 'on' : ''}" data-key="adblock_enabled"></span></div>
      <div class="mg-item" data-set="desktop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Desktop mode <span class="switch ${s.desktop_mode ? 'on' : ''}" data-key="desktop_mode"></span></div>
      <div class="mg-item" data-set="clearex"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> Clear data on exit <span class="switch ${s.clear_on_exit ? 'on' : ''}" data-key="clear_on_exit"></span></div>

      <div class="sec-title">Startup</div>
      <div class="mg-item" data-set="restore"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 109-9"/><polyline points="3 3 3 9 9 9"/></svg> Restore tabs <span class="switch ${s.restore_tabs ? 'on' : ''}" data-key="restore_tabs"></span></div>

      <div class="sec-title">Data</div>
      <div class="mg-item" data-set="export"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export backup <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></span></div>
      <div class="mg-item" data-set="import"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Import backup <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></span></div>
    </div>`;

  // Toggle switches
  body.querySelectorAll(".switch[data-key]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      el.classList.toggle("on");
      const key = el.getAttribute("data-key")!;
      (s as any)[key] = el.classList.contains("on");
      if (key === "night_mode") applyNightMode();
      persistSettings();
    });
  });

  // Clickable items
  body.querySelectorAll(".mg-item[data-set]").forEach(el => {
    el.addEventListener("click", () => {
      const key = el.getAttribute("data-set")!;
      handleSettingClick(key, s, body);
    });
  });
}

function handleSettingClick(key: string, s: Settings, body: HTMLElement) {
  switch (key) {
    case "search": {
      const engines = Object.keys(ENGINES);
      const idx = engines.indexOf(searchEngine);
      const next = engines[(idx + 1) % engines.length];
      searchEngine = next;
      s.search_engine = next;
      persistSettings();
      showToast("Search: " + next);
      renderSettings(body);
      break;
    }
    case "textsize": {
      textSize = textSize >= 2.0 ? 0.5 : textSize + 0.25;
      s.text_size = textSize;
      persistSettings();
      showToast("Text size: " + Math.round(textSize * 100) + "%");
      renderSettings(body);
      break;
    }
    case "export":
      invoke<string>("export_backup").then(path => {
        showToast("Backup saved: " + path.split(/[/\\]/).pop());
      }).catch(e => showToast("Export failed: " + e));
      break;
    case "import":
      invoke("import_latest_backup").then(() => {
        showToast("Backup imported");
        return invoke<Settings>("get_settings");
      }).then(s2 => {
        settings = s2;
        applyAllSettings();
        renderSettings(body);
      }).catch(e => showToast("Import failed: " + e));
      break;
  }
}

function renderAbout(body: HTMLElement) {
  body.innerHTML = `<div style="text-align:center;padding:48px 16px">
    <img src="/via-logo.svg" style="width:72px;margin-bottom:16px" />
    <div style="font-size:18px;font-weight:600;margin-bottom:4px">Via Browser</div>
    <div style="font-size:12px;color:var(--fg-muted)">Windows Desktop</div>
    <div style="font-size:12px;color:var(--fg-dim);margin-top:16px;line-height:1.8">
      Lightweight, fast, private browsing<br>
      Built with Tauri + WebView2
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════
   Features
   ═══════════════════════════════════════════════ */
function applyNightMode() {
  document.documentElement.style.setProperty("--bg", nightMode ? "#000000" : "#000000");
  // Night mode via the backend
  invoke("set_night_mode", { enabled: nightMode }).catch(() => {});
}

function applyAllSettings() {
  if (settings) {
    searchEngine = settings.search_engine || "Google";
    nightMode = settings.night_mode;
    desktopMode = settings.desktop_mode;
    textSize = settings.text_size || 1;
    showImages = settings.show_images !== false;
    adblockOn = settings.adblock_enabled !== false;
    restoreTabs = settings.restore_tabs || false;
  }
  applyNightMode();
}

async function persistSettings() {
  if (!settings) return;
  settings.search_engine = searchEngine;
  settings.night_mode = nightMode;
  settings.desktop_mode = desktopMode;
  settings.text_size = textSize;
  settings.show_images = showImages;
  settings.adblock_enabled = adblockOn;
  settings.restore_tabs = restoreTabs;
  await invoke("set_settings", { settings }).catch(() => {});
}

function activateReader() {
  if (!activeId) { showToast("Open a page first"); return; }
  invoke<string>("reader_bundle").then(js => {
    return invoke("eval_tab", { id: activeId!, js });
  }).then(() => {
    showToast("Reader mode activated");
  }).catch(e => showToast("Reader mode failed: " + e));
}

function activateFind() {
  if (!activeId) { showToast("Open a page first"); return; }
  const query = prompt("Find on page:");
  if (!query) return;
  const js = `window.find(${JSON.stringify(query)})`;
  invoke("eval_tab", { id: activeId, js }).catch(() => {
    showToast("Find not supported on this page");
  });
}

function toggleFullscreen() {
  const win = (window as any).__TAURI__?.window?.appWindow;
  if (win) {
    win.isFullscreen().then((fs: boolean) => {
      win.setFullscreen(!fs);
    }).catch(() => {});
  } else {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }
}

function shareLink() {
  const tab = tabs.find(t => t.id === activeId);
  if (tab && tab.url) {
    navigator.clipboard.writeText(tab.url).then(() => {
      showToast("Link copied to clipboard");
    }).catch(() => {
      showToast("Could not copy link");
    });
  }
}

async function addBookmark() {
  const tab = tabs.find(t => t.id === activeId);
  if (!tab || !tab.url) { showToast("Open a page first"); return; }
  await invoke("add_bookmark", { url: tab.url, title: tab.title || tab.url, folder: null });
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => bookmarks);
  showToast("Bookmark added");
  refreshMenuState();
}

async function scanQR() {
  try {
    const text = await invoke<string>("qr_pick_and_scan");
    if (text) {
      const result = confirm("QR Code detected:\n" + text + "\n\nOpen this URL?");
      if (result) {
        if (/^https?:\/\//i.test(text)) {
          navigate(text);
        } else {
          navigate("https://www.google.com/search?q=" + encodeURIComponent(text));
        }
      }
    }
  } catch (e) {
    showToast("QR scan cancelled or unavailable");
  }
}

/* ═══════════════════════════════════════════════
   Events from backend
   ═══════════════════════════════════════════════ */
function setupEvents() {
  listen<{ id: number; url: string }>("tab-url", (ev) => {
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) {
      tab.url = ev.payload.url;
      if (tab.id === activeId) updateUrlDisplay();
      // Add to history
      invoke("add_history", { url: ev.payload.url, title: tab.title }).catch(() => {});
    }
  });

  listen<{ id: number; title: string }>("tab-title", (ev) => {
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) {
      tab.title = ev.payload.title;
      if (tab.id === activeId) updateUrlDisplay();
    }
  });

  listen<{ url: string }>("new-window-request", (ev) => {
    createTab(ev.payload.url);
  });

  // Download events
  listen<any>("download-progress", (ev) => {
    const p = ev.payload;
    downloads = downloads.map(d => d.url === p.url ? { ...d, size: p.received || d.size, done: p.done } : d);
    if (p.done) {
      showToast(p.success ? "Download complete" : "Download failed");
      refreshDownloads();
    }
  });

  listen<any>("download-started", (ev) => {
    const p = ev.payload;
    downloads.unshift({ url: p.url || "", path: p.path || "", title: p.filename || "Download", size: 0, done: false });
    showToast("Download started");
  });
}

function refreshDownloads() {
  invoke<DlItem[]>("list_downloads").then(dl => { downloads = dl; }).catch(() => {});
}

/* ═══════════════════════════════════════════════
   Keyboard shortcuts
   ═══════════════════════════════════════════════ */
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === "t") { e.preventDefault(); createTab(); }
    else if (ctrl && e.shiftKey && e.key === "T") { e.preventDefault(); reopenClosedTab(); }
    else if (ctrl && e.key === "w") { e.preventDefault(); if (activeId) closeTab(activeId); }
    else if (ctrl && e.key === "l") { e.preventDefault(); openUrlBar(); }
    else if (ctrl && e.key === "r") { e.preventDefault(); if (activeId) invoke("eval_tab", { id: activeId, js: "location.reload()" }); }
    else if (ctrl && e.key === "f") { e.preventDefault(); activateFind(); }
    else if (ctrl && e.key === "d") { e.preventDefault(); addBookmark(); }
    else if (ctrl && e.key === "h") { e.preventDefault(); openPanel("History", renderHistory); }
    else if (ctrl && e.shiftKey && e.key === "P") { e.preventDefault(); toggleIncognito(); }
    else if (e.key === "Escape") {
      if ($("panel").classList.contains("open")) closePanel();
      else if ($("side-menu").classList.contains("open")) closeSideMenu();
    }
    else if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
  });
}

async function reopenClosedTab() {
  const closed = await invoke<ClosedTab | null>("pop_closed_tab").catch(() => null);
  if (closed) {
    await createTab(closed.url);
    showToast("Tab restored");
  } else {
    showToast("No closed tabs");
  }
}

function toggleIncognito() {
  incognitoMode = !incognitoMode;
  showToast(incognitoMode ? "Incognito mode on" : "Incognito mode off");
}

/* ═══════════════════════════════════════════════
   Session
   ═══════════════════════════════════════════════ */
async function saveSession() {
  if (!restoreTabs || !tabs.length) return;
  const entries: SessionEntry[] = tabs.map((t, i) => ({
    url: t.url, title: t.title, active: t.id === activeId, order: i,
  }));
  await invoke("save_session", { entries }).catch(() => {});
}

/* ═══════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════ */
async function boot() {
  // Load settings
  settings = await invoke<Settings>("get_settings").catch(() => null);
  applyAllSettings();

  // Load data
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
  historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []);
  downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);

  // Setup events and keyboard
  setupEvents();
  setupKeyboard();

  // Restore session if enabled
  if (restoreTabs) {
    const session = await invoke<SessionEntry[]>("restore_session").catch(() => []);
    if (session.length) {
      const sorted = [...session].sort((a, b) => a.order - b.order);
      for (const entry of sorted) {
        const tab = await createTab(entry.url !== "about:blank" ? entry.url : undefined);
        if (!entry.active) {
          // Don't switch away from active tab
        }
      }
      // Switch to the originally active tab
      const activeEntry = session.find(s => s.active);
      if (activeEntry) {
        const tab = tabs.find(t => t.url === activeEntry.url);
        if (tab) await switchTab(tab.id);
      }
      updateTabCount();
    }
  }

  // === Wire up DOM events ===

  // Bottom nav buttons
  $("nav-back").addEventListener("click", () => {
    if (activeId) invoke("eval_tab", { id: activeId, js: "history.back()" }).catch(() => {});
  });
  $("nav-fwd").addEventListener("click", () => {
    if (activeId) invoke("eval_tab", { id: activeId, js: "history.forward()" }).catch(() => {});
  });
  $("nav-home").addEventListener("click", () => {
    if (activeId) {
      invoke("eval_tab", { id: activeId, js: "history.go(-999)" }).catch(() => {});
    }
    showHomepage();
  });
  $("nav-tabs").addEventListener("click", () => {
    openPanel("Tabs (" + tabs.length + ")", renderTabs);
  });
  $("nav-menu").addEventListener("click", () => {
    closePanel();
    openSideMenu();
  });

  // URL bar buttons
  $("url-back").addEventListener("click", () => {
    if (activeId) invoke("eval_tab", { id: activeId, js: "history.back()" }).catch(() => {});
  });
  $("url-fwd").addEventListener("click", () => {
    if (activeId) invoke("eval_tab", { id: activeId, js: "history.forward()" }).catch(() => {});
  });
  $("url-go").addEventListener("click", handleUrlGo);
  $("url-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleUrlGo();
    if (e.key === "Escape") {
      ($("url-input") as HTMLInputElement).blur();
      if (activeId) showBrowsingUI();
      else showHomepage();
    }
  });
  $("url-home").addEventListener("click", () => showHomepage());
  $("url-tabs").addEventListener("click", () => {
    openPanel("Tabs (" + tabs.length + ")", renderTabs);
  });
  $("url-menu").addEventListener("click", () => {
    closePanel();
    openSideMenu();
  });

  // Home search pill
  $("home-search").addEventListener("click", openUrlBar);

  // QR button on homepage
  $("qr-btn").addEventListener("click", () => scanQR());

  // Menu backdrop
  $("menu-backdrop").addEventListener("click", closeSideMenu);
  $("menu-exit").addEventListener("click", () => {
    closeSideMenu();
    closePanel();
  });
  $("menu-collapse").addEventListener("click", closeSideMenu);

  // Panel
  $("panel-back").addEventListener("click", closePanel);
  $("panel-backdrop").addEventListener("click", closePanel);

  // Context menu dismiss
  document.addEventListener("click", () => {
    $("context-menu").style.display = "none";
  });

  // Save session on close
  window.addEventListener("beforeunload", () => saveSession());

  updateTabCount();
  console.log("[Via] Boot complete — Via 7.2.1 Desktop");
}

function renderTabs(body: HTMLElement) {
  if (tabs.length === 0) {
    body.innerHTML = '<div class="empty-state">No open tabs</div><div style="padding:16px"><button class="btn primary" id="new-tab-btn">+ New Tab</button></div>';
    body.querySelector("#new-tab-btn")?.addEventListener("click", () => { closePanel(); createTab(); });
    return;
  }
  body.innerHTML = '<div class="pp-list">' + tabs.map(t =>
    `<div class="pp-item${t.id === activeId ? ' selected' : ''}" data-tab="${t.id}">
      <div class="pi-icon">${t.id === activeId ? "▶" : "◻"}</div>
      <div class="pi-info"><div class="pi-title">${esc(t.title || "New Tab")}</div>
      <div class="pi-sub">${esc(t.url || "about:blank")}</div></div>
      <div class="pi-action" data-ctab="${t.id}">✕</div>
    </div>`
  ).join("") + '</div><div style="padding:16px"><button class="btn primary" id="new-tab-btn">+ New Tab</button></div>';

  body.querySelector("#new-tab-btn")?.addEventListener("click", () => { closePanel(); createTab(); });
  body.querySelectorAll(".pp-item[data-tab]").forEach(el => {
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("pi-action")) return;
      closePanel();
      switchTab(parseInt(el.getAttribute("data-tab")!));
    });
  });
  body.querySelectorAll(".pi-action[data-ctab]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(parseInt(el.getAttribute("data-ctab")!));
      renderTabs(body);
    });
  });
}

boot();
