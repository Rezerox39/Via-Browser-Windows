import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/* ═══════ Types ═══════ */
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

/* ═══════ State ═══════ */
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

/* ═══════ DOM helpers ═══════ */
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

/* ═══════ Menu item definitions ═══════ */
interface MenuItem { id: string; label: string; icon: string; action: () => void; active?: () => boolean; }
function ic(p: string): string { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${p}</svg>`; }

const MENU_ITEMS: MenuItem[] = [
  { id: "bookmarks", label: "Bookmarks", icon: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>', action: () => openPanel("Bookmarks", renderBookmarks) },
  { id: "history", label: "History", icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', action: () => openPanel("History", renderHistory) },
  { id: "downloads", label: "Downloads", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', action: () => openPanel("Downloads", renderDownloads) },
  { id: "saved", label: "Saved pages", icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>', action: () => openPanel("Saved Pages", renderSavedPages) },
  { id: "night", label: "Night mode", icon: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>', action: () => { nightMode = !nightMode; invoke("set_night_mode", { enabled: nightMode }).catch(() => {}); persistSettings(); showToast(nightMode ? "Night mode on" : "Night mode off"); refreshMenuState(); }, active: () => nightMode },
  { id: "desktop", label: "Desktop mode", icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>', action: () => { desktopMode = !desktopMode; persistSettings(); showToast(desktopMode ? "Desktop UA" : "Mobile UA"); refreshMenuState(); }, active: () => desktopMode },
  { id: "reader", label: "Reader mode", icon: '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>', action: () => activateReader() },
  { id: "qr", label: "QR scanner", icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3z"/><path d="M21 14v7h-7"/>', action: () => scanQR() },
  { id: "find", label: "Find on page", icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>', action: () => activateFind() },
  { id: "fullscreen", label: "Full screen", icon: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>', action: () => toggleFullscreen() },
  { id: "share", label: "Share link", icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>', action: () => shareLink() },
  { id: "addbm", label: "Add bookmark", icon: '<path d="M12 5v14M5 12h14"/>', action: () => addBookmark() },
  { id: "adsb", label: "Ad blocking", icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', action: () => { adblockOn = !adblockOn; persistSettings(); showToast(adblockOn ? "Ad blocking on" : "Ad blocking off"); refreshMenuState(); }, active: () => adblockOn },
  { id: "tracker", label: "No-tracking", icon: '<path d="M18 11V7a6 6 0 00-12 0v4"/><path d="M14 21v-4a2 2 0 00-4 0v4"/>', action: () => { if (activeId) { invoke("eval_tab", { id: activeId, js: "navigator.doNotTrack='1'" }).then(() => showToast("DNT header set")).catch(() => showToast("DNT not supported on this page")); } else showToast("Open a page first"); } },
  { id: "images", label: "Show images", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>', action: () => { showImages = !showImages; persistSettings(); if (activeId) { const js = showImages ? "document.querySelectorAll('img[data-via-hidden]').forEach(i=>{i.style.display='';i.removeAttribute('data-via-hidden')})" : "document.querySelectorAll('img').forEach(i=>{i.setAttribute('data-via-hidden','1');i.style.display='none'})"; invoke("eval_tab", { id: activeId, js }).catch(() => {}); } showToast(showImages ? "Images shown" : "Images hidden"); refreshMenuState(); }, active: () => showImages },
  { id: "scripts", label: "Scripts", icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', action: () => openPanel("Scripts", renderScriptsRoot) },
  { id: "siteconfig", label: "Site config", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>', action: () => openPanel("Site configuration", renderSiteConfig) },
  { id: "cookies", label: "Cookies", icon: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><path d="M12 6a6 6 0 100 12 6 6 0 000-12z"/><circle cx="12" cy="12" r="2"/>', action: () => openPanel("Cookies", renderCookies) },
  { id: "customize", label: "Customize", icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>', action: () => openPanel("Customize menu", renderCustomizeMenu) },
  { id: "settings", label: "Settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/>', action: () => openPanel("Settings", renderSettings) },
  { id: "about", label: "About", icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', action: () => openPanel("About", renderAbout) },
  { id: "incognito", label: "Incognito", icon: '<path d="M17 8h1a4 4 0 110 8h-1"/><path d="M3 8h14v8H3z"/>', action: () => { incognitoMode = !incognitoMode; showToast(incognitoMode ? "Incognito on" : "Incognito off"); refreshMenuState(); }, active: () => incognitoMode },
  { id: "print", label: "Print", icon: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>', action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "window.print()" }).then(() => showToast("Print dialog opened")).catch(() => showToast("Print unavailable")); else showToast("Open a page first"); } },
  { id: "addhome", label: "Add to home", icon: '<path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/>', action: () => addToHomepage() },
  { id: "pageinfo", label: "Page info", icon: '<circle cx="12" cy="12" r="10"/><path d="M12 8h.01"/><path d="M11 12h1v4h1"/>', action: () => showPageInfo() },
  { id: "zoom", label: "Zoom", icon: '<circle cx="11" cy="11" r="4"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>', action: () => adjustZoom() },
  { id: "savepage", label: "Save page", icon: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>', action: () => saveCurrentPage() },
  { id: "copyurl", label: "Copy URL", icon: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>', action: () => shareLink() },
  { id: "export", label: "Export data", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', action: () => invoke<string>("export_backup").then(p => showToast("Exported: " + p.split(/[/\\]/).pop())).catch(() => showToast("Export failed")) },
  { id: "import", label: "Import data", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', action: () => importData() },
];

function getMenuOrder(): string[] {
  const order = settings?.toolbar_layout?.visible;
  if (order && order.length > 0) {
    const valid = order.filter(id => MENU_ITEMS.some(m => m.id === id));
    const missing = MENU_ITEMS.map(m => m.id).filter(id => !valid.includes(id));
    return [...valid, ...missing];
  }
  return MENU_ITEMS.map(m => m.id);
}
function getHiddenMenuIds(): string[] {
  const visible = settings?.toolbar_layout?.visible;
  if (!visible || visible.length === 0) return [];
  const visibleSet = new Set(visible);
  return MENU_ITEMS.map(m => m.id).filter(id => !visibleSet.has(id));
}

/* ═══════ TAB MANAGEMENT — REAL WEBVIEWS ═══════ */

/** Show a tab's webview and hide homepage + all others. */
function showTabWebview(id: number) {
  $("home").classList.add("hidden");
  tabs.forEach(t => {
    if (t.id === id) invoke("show_tab", { id: t.id }).catch(() => {});
    else invoke("hide_tab", { id: t.id }).catch(() => {});
  });
}

/** Show the homepage and hide ALL webviews. */
function showHomePage() {
  activeId = null;
  $("home").classList.remove("hidden");
  tabs.forEach(t => invoke("hide_tab", { id: t.id }).catch(() => {}));
  updateNavButtons();
}

async function createTab(url?: string): Promise<Tab> {
  console.log("[Via] createTab url=", url);
  const info = await invoke<TabInfo>("create_tab", { url: url || null });
  const tab: Tab = { id: info.id, url: info.url && info.url !== "about:blank" ? info.url : "", title: "New Tab", active: true };
  tabs.push(tab);
  activeId = info.id;
  await invoke("select_tab", { id: info.id }).catch(() => {});
  updateTabCount();
  if (url) {
    // Navigate the webview to the URL. The tab-url event will show it when loaded.
    $("home").classList.add("hidden");
    await invoke("navigate_tab", { id: info.id, url }).catch(e => {
      console.error("[Via] navigate_tab failed:", e);
      showToast("Navigation failed: " + String(e));
    });
    // Show the webview immediately so the user sees loading
    await invoke("show_tab", { id: info.id }).catch(() => {});
    tabs.forEach(t => { if (t.id !== info.id) invoke("hide_tab", { id: t.id }).catch(() => {}); });
  } else {
    // New empty tab — show homepage
    showHomePage();
  }
  return tab;
}

async function closeTab(id: number) {
  const tab = tabs.find(t => t.id === id);
  if (tab) await invoke("push_closed_tab", { url: tab.url || "about:blank", title: tab.title }).catch(() => {});
  await invoke("close_tab", { id }).catch(() => {});
  tabs = tabs.filter(t => t.id !== id);
  if (activeId === id) {
    if (tabs.length > 0) {
      const last = tabs[tabs.length - 1];
      await switchTab(last.id);
    } else {
      activeId = null;
      showHomePage();
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
  // Show the webview for this tab, hide others, hide homepage
  showTabWebview(id);
  updateNavButtons();
  updateTabCount();
}

function updateTabCount() {
  $("nav-tab-count").textContent = String(tabs.length || 1);
}
function updateNavButtons() {
  ["nav-back", "nav-fwd"].forEach(id => {
    const el = $(id);
    if (activeId) el.removeAttribute("disabled"); else el.setAttribute("disabled", "");
  });
}

/* ═══════ SEARCH / NAVIGATION ═══════ */

/** Called when user types in the central search pill and presses Enter. */
function handleSearchEnter() {
  const input = $("home-input") as HTMLInputElement;
  const val = input.value.trim();
  if (!val) return;
  input.value = "";
  console.log("[Via] Search:", val);
  // Detect URL vs search query
  let url: string;
  if (/^https?:\/\//i.test(val) || /^localhost(:\d+)?/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(val) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(val) || val.includes("://")) {
    url = /^https?:\/\//i.test(val) || /^localhost/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}/.test(val) ? val : "https://" + val;
  } else {
    url = (ENGINES[searchEngine] || ENGINES.Google) + encodeURIComponent(val);
  }
  handleUrlOpen(url);
}

/** Open a URL — create new tab or navigate existing. */
async function handleUrlOpen(url: string) {
  console.log("[Via] handleUrlOpen:", url);
  if (activeId) {
    // Navigate the active tab
    await invoke("navigate_tab", { id: activeId, url }).catch(e => {
      console.error("[Via] navigate failed:", e);
      showToast("Navigation failed");
    });
    // Ensure the webview is visible
    showTabWebview(activeId);
  } else {
    await createTab(url);
  }
}

/** Open the search pill for browsing navigation (Ctrl+L or Home button). */
function openSearchOverlay() {
  $("home").classList.remove("hidden");
  const input = $("home-input") as HTMLInputElement;
  // If we have an active tab, pre-fill with its URL
  if (activeId) {
    const tab = tabs.find(t => t.id === activeId);
    input.value = tab?.url || "";
  } else {
    input.value = "";
  }
  input.focus();
  input.select();
}

/* ═══════ SIDE MENU ═══════ */
function buildSideMenuGrid() {
  const grid = $("side-menu-grid");
  const order = getMenuOrder();
  const start = menuPage * MENU_PAGE_SIZE;
  const pageIds = order.slice(start, start + MENU_PAGE_SIZE);
  const items = pageIds.map(id => MENU_ITEMS.find(m => m.id === id)).filter(Boolean) as MenuItem[];
  grid.innerHTML = items.map(item => {
    const active = item.active?.() ? " active" : "";
    return `<button class="sheet-item${active}" data-menu-id="${item.id}">${ic(item.icon)}<span>${item.label}</span></button>`;
  }).join("");
  grid.querySelectorAll(".sheet-item").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-menu-id")!;
      const item = MENU_ITEMS.find(m => m.id === id);
      if (item) { closeSideMenu(); item.action(); }
    });
  });
  const totalPages = Math.ceil(order.length / MENU_PAGE_SIZE);
  $("side-menu-pagination").innerHTML = Array.from({ length: totalPages }, (_, i) =>
    `<div class="pg-dot${i === menuPage ? ' active' : ''}" data-p="${i}"></div>`
  ).join("");
  $("side-menu-pagination").querySelectorAll(".pg-dot").forEach(el => {
    el.addEventListener("click", () => { menuPage = parseInt(el.getAttribute("data-p")!); buildSideMenuGrid(); });
  });
}
function refreshMenuState() { buildSideMenuGrid(); }
function openSideMenu() { buildSideMenuGrid(); $("side-menu").classList.add("open"); $("menu-backdrop").classList.add("open"); }
function closeSideMenu() { $("side-menu").classList.remove("open"); $("menu-backdrop").classList.remove("open"); }

/* ═══════ PANEL SYSTEM ═══════ */
function openPanel(title: string, renderFn: (body: HTMLElement) => void) {
  $("panel-title").textContent = title;
  const body = $("panel-body");
  body.innerHTML = "";
  renderFn(body);
  $("panel-backdrop").classList.add("open");
  $("panel").classList.add("open");
}
function closePanel() { $("panel-backdrop").classList.remove("open"); $("panel").classList.remove("open"); }

/* ═══════ PANEL RENDERERS ═══════ */
function renderBookmarks(body: HTMLElement) {
  if (!bookmarks.length) { body.innerHTML = '<div class="empty-state">No bookmarks yet</div>'; return; }
  body.innerHTML = '<div class="pp-list">' + bookmarks.map(b =>
    `<div class="pp-item" data-url="${esc(b.url)}"><div class="pi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg></div><div class="pi-info"><div class="pi-title">${esc(b.title || b.url)}</div><div class="pi-sub">${esc(b.url)}</div></div><button class="pi-action" data-del="${esc(b.url)}">✕</button></div>`
  ).join("") + "</div>";
  body.querySelectorAll(".pp-item").forEach(el => el.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-del]")) { invoke("remove_bookmark", { url: el.getAttribute("data-del")! }).then(() => { bookmarks = bookmarks.filter(b => b.url !== el.getAttribute("data-del")!); renderBookmarks(body); showToast("Removed"); }); return; }
    closePanel(); handleUrlOpen(el.getAttribute("data-url")!);
  }));
}

function renderHistory(body: HTMLElement) {
  if (!historyItems.length) { body.innerHTML = '<div class="empty-state">No history</div>'; return; }
  const grouped: Record<string, HistItem[]> = {};
  historyItems.forEach(h => { const d = new Date(h.ts * 1000).toISOString().slice(0, 10); (grouped[d] = grouped[d] || []).push(h); });
  body.innerHTML = '<div style="padding:8px 16px"><button class="btn" id="chb">Clear history</button></div>' +
    Object.entries(grouped).map(([date, items]) =>
    `<div class="sec-title">${date}</div><div class="pp-list">` + items.map(h =>
      `<div class="pp-item" data-url="${esc(h.url)}"><div class="pi-info"><div class="pi-title">${esc(h.title || h.url)}</div><div class="pi-sub" style="color:var(--accent)">${esc(h.url)}</div></div></div>`
    ).join("") + "</div>").join("");
  body.querySelector("#chb")?.addEventListener("click", async () => { await invoke("clear_history"); historyItems = []; renderHistory(body); showToast("Cleared"); });
  body.querySelectorAll(".pp-item").forEach(el => el.addEventListener("click", () => { closePanel(); handleUrlOpen(el.getAttribute("data-url")!); }));
}

function renderDownloads(body: HTMLElement) {
  if (!downloads.length) { body.innerHTML = '<div class="empty-state">No downloads yet</div>'; return; }
  body.innerHTML = downloads.map(d =>
    `<div class="dl-item"><div class="dl-name">${esc(d.title)}</div><div class="dl-meta">${formatSize(d.size)} ${d.done ? "✓ Done" : "Downloading..."}</div>${d.done ? `<div class="dl-actions"><button data-open="${esc(d.path)}">Open</button><button data-folder="${esc(d.path)}">Folder</button></div>` : ""}</div>`
  ).join("");
  body.querySelectorAll("[data-open]").forEach(el => el.addEventListener("click", () => invoke("open_download", { path: el.getAttribute("data-open")! })));
  body.querySelectorAll("[data-folder]").forEach(el => el.addEventListener("click", () => invoke("reveal_download", { path: el.getAttribute("data-folder")! })));
}

function renderSavedPages(body: HTMLElement) { body.innerHTML = '<div class="empty-state">No saved pages. Use "Save page" from the menu.</div>'; }

/* ═══════ SCRIPTS ═══════ */
function renderScriptsRoot(body: HTMLElement) {
  body.innerHTML = `<div class="mg-list">
    <div class="mg-item" data-sc="mine"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>My Scripts <span class="chev">›</span></div>
    <div class="mg-item" data-sc="store"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>Script Store <span class="chev">›</span></div>
    <div class="mg-item" data-sc="conf"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/></svg>Script Settings <span class="chev">›</span></div>
  </div>`;
  body.querySelector('[data-sc="mine"]')?.addEventListener("click", () => openPanel("My Scripts", renderMyScripts));
  body.querySelector('[data-sc="store"]')?.addEventListener("click", () => openPanel("Script Store", renderScriptStore));
  body.querySelector('[data-sc="conf"]')?.addEventListener("click", () => openPanel("Script Settings", renderScriptSettings));
}

function renderMyScripts(body: HTMLElement) {
  const scripts = settings?.scripts || [];
  if (!scripts.length) { body.innerHTML = '<div class="empty-state">No scripts yet</div><div style="padding:16px"><button class="btn primary" id="asb">+ Add Script</button></div>'; }
  else {
    body.innerHTML = '<div class="pp-list">' + scripts.map(s =>
      `<div class="pp-item"><div class="pi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div><div class="pi-info"><div class="pi-title">${esc(s.name)}</div><div class="pi-sub">${esc(s.match_urls || "All")} · ${s.enabled ? "On" : "Off"}</div></div><button class="pi-action" data-ds="${esc(s.id)}">✕</button></div>`
    ).join("") + '</div><div style="padding:16px"><button class="btn primary" id="asb">+ Add Script</button></div>';
    body.querySelectorAll("[data-ds]").forEach(el => el.addEventListener("click", async () => {
      await invoke("delete_script", { id: el.getAttribute("data-ds")! });
      if (settings) settings.scripts = settings.scripts.filter(s => s.id !== el.getAttribute("data-ds")!);
      renderMyScripts(body); showToast("Deleted");
    }));
  }
  body.querySelector("#asb")?.addEventListener("click", () => {
    const name = prompt("Script name:"); if (!name) return;
    const matchUrls = prompt("Match URLs (semicolon, empty for all):") || "";
    const code = prompt("Script code:"); if (!code) { showToast("Cancelled"); return; }
    const script: UserScript = { id: "s" + Date.now(), name, match_urls: matchUrls, code, enabled: true };
    if (!settings) settings = { ...({} as Settings), scripts: [] };
    settings.scripts.push(script);
    invoke("save_script", { script }).then(() => { showToast("Saved"); renderMyScripts(body); });
  });
}

const SCRIPT_STORE = [
  { name: "AdGuard Extra", author: "adguardteam", desc: "Remove blocked elements", url: "https://greasyfork.org/scripts/38972" },
  { name: "Dark Reader", author: "alexander", desc: "Dark mode for all sites", url: "https://greasyfork.org/scripts/22190" },
  { name: "Bilibili Evolved", author: "the1812", desc: "Enhanced bilibili experience", url: "https://greasyfork.org/scripts/452100" },
  { name: "Search Engine Jump", author: "luke-chang", desc: "Jump between search engines", url: "https://greasyfork.org/scripts/426035" },
  { name: "Remove Google Redirection", author: "tam", desc: "Clean Google search results", url: "https://greasyfork.org/scripts/425019" },
];

function renderScriptStore(body: HTMLElement) {
  const installed = new Set((settings?.scripts || []).map(s => s.name));
  body.innerHTML = '<div style="padding:12px 16px;color:var(--fg-muted);font-size:12px">Popular scripts from Greasy Fork</div>' +
    SCRIPT_STORE.map(s => `<div class="script-store-item"><div class="script-store-name">${esc(s.name)}</div><div class="script-store-author">by ${esc(s.author)}</div><div class="script-store-desc">${esc(s.desc)}</div><div class="script-store-actions"><button class="${installed.has(s.name) ? 'installed' : ''}" data-inst="${esc(s.name)}">${installed.has(s.name) ? "Installed ✓" : "Install"}</button></div></div>`).join("");
  body.querySelectorAll("[data-inst]").forEach(el => el.addEventListener("click", () => {
    const name = el.getAttribute("data-inst")!;
    const script = SCRIPT_STORE.find(s => s.name === name)!;
    if (installed.has(name)) { handleUrlOpen(script.url); closePanel(); return; }
    const us: UserScript = { id: "s" + Date.now(), name, match_urls: "", code: "// ==UserScript==\n// @name " + name + "\n// ==/UserScript==\n", enabled: true };
    if (!settings) settings = { ...({} as Settings), scripts: [] };
    settings.scripts.push(us);
    invoke("save_script", { script: us }).then(() => { showToast("Installed: " + name); renderScriptStore(body); handleUrlOpen(script.url); });
  }));
}

function renderScriptSettings(body: HTMLElement) {
  body.innerHTML = `<div class="mg-list"><div class="mg-item" data-ss="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>Search scripts <span class="chev">›</span></div></div>`;
  body.querySelector('[data-ss="search"]')?.addEventListener("click", () => {
    const q = prompt("Search Greasy Fork:"); if (q) handleUrlOpen("https://greasyfork.org/en/scripts?q=" + encodeURIComponent(q));
  });
}

/* ═══════ SITE CONFIG / COOKIES ═══════ */
function renderSiteConfig(body: HTMLElement) {
  const sites = settings?.sites || [];
  if (!sites.length) { body.innerHTML = '<div class="empty-state">No per-site overrides</div>'; return; }
  body.innerHTML = '<div class="pp-list">' + sites.map(s =>
    `<div class="pp-item"><div class="pi-info"><div class="pi-title">${esc(s.host)}</div><div class="pi-sub">UA: ${esc(s.ua_mode || "Default")} · Ads: ${s.adblock_enabled ? "On" : "Off"}</div></div><button class="pi-action" data-dh="${esc(s.host)}">✕</button></div>`
  ).join("") + "</div>";
  body.querySelectorAll("[data-dh]").forEach(el => el.addEventListener("click", async () => {
    await invoke("delete_site_config", { host: el.getAttribute("data-dh")! });
    if (settings) settings.sites = settings.sites.filter(s => s.host !== el.getAttribute("data-dh")!);
    renderSiteConfig(body); showToast("Removed");
  }));
}

function renderCookies(body: HTMLElement) {
  invoke<any[]>("get_cookies").then(cookies => {
    if (!cookies.length) { body.innerHTML = '<div class="empty-state">No cookies</div>'; return; }
    body.innerHTML = '<div class="pp-list">' + cookies.slice(0, 50).map(c =>
      `<div class="pp-item"><div class="pi-info"><div class="pi-title">${esc(c.name || "?")}</div><div class="pi-sub">${esc(c.domain || "?")}</div></div></div>`
    ).join("") + '</div><div style="padding:16px"><button class="btn" id="ccb">Clear all cookies</button></div>';
    body.querySelector("#ccb")?.addEventListener("click", async () => { await invoke("clear_cookies"); renderCookies(body); showToast("Cleared"); });
  }).catch(() => body.innerHTML = '<div class="empty-state">Could not read cookies</div>');
}

function renderCustomizeMenu(body: HTMLElement) {
  const order = getMenuOrder();
  const hidden = getHiddenMenuIds();
  body.innerHTML = `<div class="sec-title">Drag to reorder</div><div id="cvis">${order.map(id => { const item = MENU_ITEMS.find(m => m.id === id); if (!item) return ""; return `<div class="drag-item" data-mid="${item.id}" draggable="true"><span class="drag-handle">⠿</span><span class="drag-label">${esc(item.label)}</span></div>`; }).join("")}</div><div class="sec-title">Hidden — tap to add</div><div id="chid">${hidden.map(id => { const item = MENU_ITEMS.find(m => m.id === id); if (!item) return ""; return `<div class="drag-item" data-midh="${item.id}"><span class="drag-label">${esc(item.label)}</span><span style="color:var(--accent)">+</span></div>`; }).join("") || '<div style="color:var(--fg-dim);padding:8px 16px">All visible</div>'}</div><div style="padding:16px"><button class="btn" id="rmb">Reset to defaults</button></div>`;
  body.querySelectorAll("#chid [data-midh]").forEach(el => el.addEventListener("click", async () => {
    const current = getMenuOrder(); current.push(el.getAttribute("data-midh")!);
    if (settings?.toolbar_layout) settings.toolbar_layout.visible = current;
    await persistSettings(); renderCustomizeMenu(body); refreshMenuState();
  }));
  const list = body.querySelector("#cvis")!; let dragEl: HTMLElement | null = null;
  list.addEventListener("dragstart", e => { dragEl = (e.target as HTMLElement).closest(".drag-item"); if (dragEl) dragEl.style.opacity = "0.5"; });
  list.addEventListener("dragend", () => { if (dragEl) dragEl.style.opacity = ""; dragEl = null; });
  list.addEventListener("dragover", e => { e.preventDefault(); const t = (e.target as HTMLElement).closest(".drag-item") as HTMLElement; if (t && t !== dragEl && dragEl) { const r = t.getBoundingClientRect(); if (e.clientY < r.top + r.height / 2) list.insertBefore(dragEl, t); else list.insertBefore(dragEl, t.nextSibling); } });
  list.addEventListener("dragend", async () => { const o: string[] = []; list.querySelectorAll(".drag-item").forEach(el => o.push(el.getAttribute("data-mid")!)); if (settings?.toolbar_layout) settings.toolbar_layout.visible = o; await persistSettings(); refreshMenuState(); });
  body.querySelector("#rmb")?.addEventListener("click", async () => { if (settings?.toolbar_layout) settings.toolbar_layout.visible = []; await persistSettings(); renderCustomizeMenu(body); refreshMenuState(); showToast("Reset"); });
}

function renderSettings(body: HTMLElement) {
  const s = settings; if (!s) return;
  body.innerHTML = `<div class="mg-list">
    <div class="sec-title">General</div>
    <div class="mg-item" data-s="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>Search: ${searchEngine} <span class="chev">›</span></div>
    <div class="sec-title">Appearance</div>
    <div class="mg-item" data-s="night"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>Night mode <span class="switch ${nightMode ? 'on' : ''}"></span></div>
    <div class="mg-item" data-s="textsize"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/></svg>Text size <span style="margin-left:auto;color:var(--fg-muted)">${Math.round(s.text_size * 100)}%</span></div>
    <div class="sec-title">Privacy</div>
    <div class="mg-item" data-s="adblock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Ad blocking <span class="switch ${s.adblock_enabled ? 'on' : ''}"></span></div>
    <div class="mg-item" data-s="desktop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/></svg>Desktop mode <span class="switch ${s.desktop_mode ? 'on' : ''}"></span></div>
    <div class="sec-title">Startup</div>
    <div class="mg-item" data-s="restore"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 109-9"/></svg>Restore tabs <span class="switch ${s.restore_tabs ? 'on' : ''}"></span></div>
    <div class="sec-title">Data</div>
    <div class="mg-item" data-s="export"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/></svg>Export backup <span class="chev">›</span></div>
    <div class="mg-item" data-s="import"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/></svg>Import backup <span class="chev">›</span></div>
  </div>`;
  body.querySelectorAll(".mg-item[data-s]").forEach(el => el.addEventListener("click", () => handleSetting(el.getAttribute("data-s")!, body)));
  body.querySelectorAll(".switch").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); el.classList.toggle("on"); }));
}
function handleSetting(key: string, body: HTMLElement) {
  const s = settings!; switch (key) {
    case "search": { const e = Object.keys(ENGINES); searchEngine = e[(e.indexOf(searchEngine) + 1) % e.length]; s.search_engine = searchEngine; persistSettings(); showToast("Search: " + searchEngine); renderSettings(body); break; }
    case "night": nightMode = !nightMode; s.night_mode = nightMode; invoke("set_night_mode", { enabled: nightMode }); persistSettings(); break;
    case "textsize": textSize = textSize >= 2 ? 0.5 : textSize + 0.25; s.text_size = textSize; persistSettings(); showToast("Zoom: " + Math.round(textSize * 100) + "%"); renderSettings(body); break;
    case "adblock": adblockOn = !adblockOn; s.adblock_enabled = adblockOn; persistSettings(); break;
    case "desktop": desktopMode = !desktopMode; s.desktop_mode = desktopMode; persistSettings(); break;
    case "restore": restoreTabs = !restoreTabs; s.restore_tabs = restoreTabs; persistSettings(); break;
    case "export": invoke<string>("export_backup").then(p => showToast("Saved: " + p.split(/[/\\]/).pop())).catch(() => showToast("Failed")); break;
    case "import": importData(); break;
  }
}

function renderAbout(body: HTMLElement) {
  body.innerHTML = `<div style="text-align:center;padding:48px 16px"><img src="/via-logo.svg" style="width:72px;margin-bottom:16px"/><div style="font-size:18px;font-weight:600">Via Browser</div><div style="font-size:12px;color:var(--fg-muted);margin-top:8px">Windows Desktop · Built with Tauri + WebView2</div></div>`;
}

/* ═══════ ACTIONS ═══════ */
function activateReader() {
  if (!activeId) { showToast("Open a page first"); return; }
  invoke<string>("reader_bundle").then(js => invoke("eval_tab", { id: activeId!, js })).then(() => showToast("Reader activated")).catch(() => showToast("Reader failed"));
}
function activateFind() {
  if (!activeId) { showToast("Open a page first"); return; }
  const q = prompt("Find on page:"); if (!q) return;
  invoke("eval_tab", { id: activeId, js: `window.find(${JSON.stringify(q)})` }).catch(() => showToast("Find unavailable"));
}
function toggleFullscreen() {
  const win = (window as any).__TAURI__?.window?.appWindow;
  if (win) win.isFullscreen().then((fs: boolean) => win.setFullscreen(!fs));
  else if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
function shareLink() {
  const tab = tabs.find(t => t.id === activeId);
  if (tab?.url) navigator.clipboard.writeText(tab.url).then(() => showToast("Copied")).catch(() => showToast("Failed"));
  else showToast("No URL to copy");
}
async function addBookmark() {
  const tab = tabs.find(t => t.id === activeId);
  if (!tab?.url) { showToast("Open a page first"); return; }
  await invoke("add_bookmark", { url: tab.url, title: tab.title || tab.url, folder: null });
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => bookmarks);
  showToast("Bookmark added"); refreshMenuState();
}
async function scanQR() {
  try {
    const text = await invoke<string>("qr_pick_and_scan");
    if (text) { if (confirm("QR: " + text + "\n\nOpen?")) handleUrlOpen(/^https?:\/\//i.test(text) ? text : "https://www.google.com/search?q=" + encodeURIComponent(text)); }
  } catch { showToast("QR cancelled"); }
}
async function addToHomepage() {
  const tab = tabs.find(t => t.id === activeId);
  if (!tab?.url) { showToast("Open a page first"); return; }
  const label = prompt("Label:", tab.title || ""); if (!label) return;
  const sc: HomeShortcut[] = settings?.homepage_shortcuts || [];
  sc.push({ label, url: tab.url, icon: "🌐" });
  await invoke("save_homepage_shortcuts", { shortcuts: sc }).catch(() => {});
  showToast("Added to homepage");
}
function showPageInfo() {
  const tab = tabs.find(t => t.id === activeId);
  if (tab) alert("Title: " + (tab.title || "(none)") + "\nURL: " + (tab.url || "(none)"));
  else showToast("Open a page first");
}
function adjustZoom() {
  if (!activeId) { showToast("Open a page first"); return; }
  const z = prompt("Zoom (50-200%):", String(Math.round(textSize * 100))); if (!z) return;
  const v = Math.max(0.5, Math.min(2, parseInt(z) / 100)); if (isNaN(v)) return;
  textSize = v; if (settings) settings.text_size = v; persistSettings();
  invoke("eval_tab", { id: activeId, js: `document.body.style.zoom='${v}'` }).catch(() => {});
  showToast("Zoom: " + Math.round(v * 100) + "%");
}
async function saveCurrentPage() {
  const tab = tabs.find(t => t.id === activeId); if (!tab) { showToast("Open a page first"); return; }
  try {
    await invoke("eval_tab", { id: tab.id, js: "window.__viaHtml=document.documentElement.outerHTML" });
    const html = await invoke<string>("eval_tab", { id: tab.id, js: "window.__viaHtml||''" });
    if (html) { await invoke("save_page", { url: tab.url, html, title: tab.title || "page" }); showToast("Page saved"); }
    else showToast("Could not extract page");
  } catch { showToast("Save failed"); }
}
async function importData() {
  try { await invoke("import_latest_backup"); settings = await invoke<Settings>("get_settings"); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []); historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []); downloads = await invoke<DlItem[]>("list_downloads").catch(() => []); showToast("Imported"); } catch { showToast("No backup found"); }
}

function persistSettings() {
  if (!settings) return;
  settings.search_engine = searchEngine; settings.night_mode = nightMode; settings.desktop_mode = desktopMode;
  settings.text_size = textSize; settings.show_images = showImages; settings.adblock_enabled = adblockOn; settings.restore_tabs = restoreTabs;
  invoke("set_settings", { settings }).catch(() => {});
}

/* ═══════ EVENTS FROM BACKEND ═══════ */
function setupEvents() {
  listen<{ id: number; url: string }>("tab-url", (ev) => {
    console.log("[Via] tab-url:", ev.payload.id, ev.payload.url);
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) {
      tab.url = ev.payload.url;
      // If this is the active tab, show its webview and hide homepage
      if (tab.id === activeId && !ev.payload.url.startsWith("about:")) {
        showTabWebview(tab.id);
      }
      if (!ev.payload.url.startsWith("about:")) {
        invoke("add_history", { url: ev.payload.url, title: tab.title }).catch(() => {});
      }
    }
  });
  listen<{ id: number; title: string }>("tab-title", (ev) => {
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) { tab.title = ev.payload.title; }
  });
  listen<{ url: string }>("new-window-request", (ev) => { createTab(ev.payload.url); });

  // Download events — these come from the Rust on_download handler
  listen<any>("download-started", (ev) => {
    console.log("[Via] download-started:", ev.payload);
    const p = ev.payload;
    downloads.unshift({ url: p.url || "", path: p.path || "", title: p.path?.split(/[/\\]/)?.pop() || "Download", size: 0, done: false });
    showToast("Download started: " + (p.path?.split(/[/\\]/)?.pop() || "file"));
  });
  listen<any>("download-progress", (ev) => {
    const p = ev.payload;
    console.log("[Via] download-progress:", p.url, "done=", p.done);
    if (p.done) {
      const dl = downloads.find(d => d.url === p.url);
      if (dl) { dl.done = true; dl.path = p.path || dl.path; }
      showToast(p.success ? "Download complete" : "Download failed");
      refreshDownloads();
    }
  });
}

function refreshDownloads() {
  invoke<DlItem[]>("list_downloads").then(dl => downloads = dl).catch(() => {});
}

/* ═══════ KEYBOARD SHORTCUTS ═══════ */
function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      if ($("panel").classList.contains("open")) closePanel();
      else if ($("side-menu").classList.contains("open")) closeSideMenu();
      else if (activeId) { closePanel(); closeSideMenu(); }
    }
    else if (ctrl && e.key === "t") { e.preventDefault(); createTab(); }
    else if (ctrl && e.shiftKey && e.key === "T") { e.preventDefault(); reopenClosedTab(); }
    else if (ctrl && e.key === "w") { e.preventDefault(); if (activeId) closeTab(activeId); }
    else if (ctrl && e.key === "l") { e.preventDefault(); openSearchOverlay(); }
    else if (ctrl && e.key === "r") { e.preventDefault(); if (activeId) invoke("eval_tab", { id: activeId, js: "location.reload()" }); }
    else if (ctrl && e.key === "f") { e.preventDefault(); activateFind(); }
    else if (ctrl && e.key === "d") { e.preventDefault(); addBookmark(); }
    else if (ctrl && e.key === "h") { e.preventDefault(); openPanel("History", renderHistory); }
    else if (e.key === "F11") { e.preventDefault(); toggleFullscreen(); }
  });
}
async function reopenClosedTab() {
  const c = await invoke<ClosedTab | null>("pop_closed_tab").catch(() => null);
  if (c) { await createTab(c.url); showToast("Restored"); } else showToast("No closed tabs");
}

/* ═══════ SESSION ═══════ */
async function saveSession() {
  if (!restoreTabs || !tabs.length) return;
  const entries: SessionEntry[] = tabs.map((t, i) => ({ url: t.url || "about:blank", title: t.title, active: t.id === activeId, order: i }));
  await invoke("save_session", { entries }).catch(() => {});
}

/* ═══════ TABS PANEL ═══════ */
function renderTabs(body: HTMLElement) {
  if (tabs.length === 0) {
    body.innerHTML = '<div class="empty-state">No open tabs</div><div style="padding:16px"><button class="btn primary" id="ntb">+ New Tab</button></div>';
    body.querySelector("#ntb")?.addEventListener("click", () => { closePanel(); createTab(); }); return;
  }
  body.innerHTML = '<div class="pp-list">' + tabs.map(t =>
    `<div class="pp-item${t.id === activeId ? ' selected' : ''}" data-tab="${t.id}"><div class="pi-icon">${t.id === activeId ? "▶" : "◻"}</div><div class="pi-info"><div class="pi-title">${esc(t.title || "New Tab")}</div><div class="pi-sub">${esc(t.url || "about:blank")}</div></div><button class="pi-action" data-ct="${t.id}">✕</button></div>`
  ).join("") + '</div><div style="padding:16px"><button class="btn primary" id="ntb">+ New Tab</button></div>';
  body.querySelector("#ntb")?.addEventListener("click", () => { closePanel(); createTab(); });
  body.querySelectorAll(".pp-item[data-tab]").forEach(el => el.addEventListener("click", e => {
    if ((e.target as HTMLElement).closest("[data-ct]")) return;
    closePanel(); switchTab(parseInt(el.getAttribute("data-tab")!));
  }));
  body.querySelectorAll("[data-ct]").forEach(el => el.addEventListener("click", async e => {
    e.stopPropagation(); await closeTab(parseInt(el.getAttribute("data-ct")!)); renderTabs(body);
  }));
}

/* ═══════ BOOT ═══════ */
async function boot() {
  console.log("[Via] Booting...");
  settings = await invoke<Settings>("get_settings").catch(() => null);
  if (settings) { searchEngine = settings.search_engine || "Google"; nightMode = settings.night_mode; desktopMode = settings.desktop_mode; textSize = settings.text_size || 1; showImages = settings.show_images !== false; adblockOn = settings.adblock_enabled !== false; restoreTabs = settings.restore_tabs || false; }
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
  historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []);
  downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);

  setupEvents();
  setupKeyboard();

  // Wire DOM — ONLY ONCE, using addEventListener
  $("nav-back").addEventListener("click", () => { if (activeId) invoke("eval_tab", { id: activeId, js: "history.back()" }); });
  $("nav-fwd").addEventListener("click", () => { if (activeId) invoke("eval_tab", { id: activeId, js: "history.forward()" }); });
  $("nav-home").addEventListener("click", () => showHomePage());
  $("nav-tabs").addEventListener("click", () => openPanel("Tabs (" + tabs.length + ")", renderTabs));
  $("nav-menu").addEventListener("click", () => { closePanel(); openSideMenu(); });

  $("home-search").addEventListener("click", (e) => { e.stopPropagation(); ($("home-input") as HTMLInputElement).focus(); });
  $("home-input").addEventListener("keydown", (e) => { if (e.key === "Enter") handleSearchEnter(); e.stopPropagation(); });
  $("qr-btn").addEventListener("click", () => scanQR());
  $("menu-backdrop").addEventListener("click", closeSideMenu);
  $("menu-exit").addEventListener("click", () => { closeSideMenu(); closePanel(); });
  $("menu-collapse").addEventListener("click", closeSideMenu);
  $("panel-back").addEventListener("click", closePanel);
  $("panel-backdrop").addEventListener("click", closePanel);
  window.addEventListener("beforeunload", () => saveSession());

  // Restore session
  if (restoreTabs) {
    const session = await invoke<SessionEntry[]>("restore_session").catch(() => []);
    if (session.length) {
      for (const entry of [...session].sort((a, b) => a.order - b.order)) {
        if (entry.url && entry.url !== "about:blank") await createTab(entry.url);
      }
      const ae = session.find(s => s.active);
      if (ae) { const t = tabs.find(t => t.url === ae.url); if (t) await switchTab(t.id); }
    }
  }

  updateTabCount();
  showHomePage();
  console.log("[Via] Boot complete");
}
boot();
