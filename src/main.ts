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
  Yahoo: "https://search.yahoo.com/search?p=",
  Startpage: "https://www.startpage.com/sp/search?query=",
  Ecosia: "https://www.ecosia.org/search?q=",
  Yandex: "https://yandex.com/search/?text=",
  Brave: "https://search.brave.com/search?q=",
  Wikipedia: "https://en.wikipedia.org/w/index.php?search=",
  Qwant: "https://www.qwant.com/?q=",
  SearX: "https://searx.be/search?q=",
};

/* ═══════ State ═══════ */
let tabs: Tab[] = [];
let activeId: number | null = null;
let searchEngine = "Google";
let settings: Settings | null = null;
let bookmarks: Bookmark[] = [];
let historyItems: HistItem[] = [];
let downloads: DlItem[] = [];
let nightMode = false, desktopMode = true, textSize = 1.0, showImages = true;
let adblockOn = true, incognitoMode = false, restoreTabs = false;
let menuOpen = false;
let menuPage = 0;
const MENU_PAGE_SIZE = 12;
let nextTabId = 0;
let nextLocalId = -1;
let closedTabs: ClosedTab[] = [];

const $ = (s: string) => document.getElementById(s) as HTMLElement;
function esc(s: string): string { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function showToast(msg: string) {
  const el = $("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout((el as any)._t); (el as any)._t = setTimeout(() => el.classList.remove("show"), 2400);
}
function fmtSize(b: number): string { return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB" : (b / 1073741824).toFixed(1) + " GB"; }
function log(msg: string, ...args: any[]) { console.log("[Via]", msg, ...args); }

/* ═══════ Menu ═══════ */
interface MI { id: string; label: string; icon: string; action: () => void; active?: () => boolean; }
function ic(p: string) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${p}</svg>`; }
const MENU: MI[] = [
  { id: "bookmarks", label: "Bookmarks", icon: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>', action: () => openPanel("Bookmarks", renderBookmarks) },
  { id: "history", label: "History", icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', action: () => openPanel("History", renderHistory) },
  { id: "downloads", label: "Downloads", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', action: () => { refreshDownloads(); openPanel("Downloads", renderDownloads); } },
  { id: "saved", label: "Saved pages", icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>', action: () => openPanel("Saved Pages", b => b.innerHTML = '<div class="empty-state">Use "Save page" from the menu to save pages here.</div>') },
  { id: "night", label: "Night mode", icon: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>', action: () => { nightMode = !nightMode; invoke("set_night_mode", { enabled: nightMode }); persistSettings(); showToast(nightMode ? "Night on" : "Night off"); refreshMenu(); }, active: () => nightMode },
  { id: "desktop", label: "Desktop mode", icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>', action: () => { desktopMode = !desktopMode; persistSettings(); showToast(desktopMode ? "Desktop UA" : "Mobile UA"); refreshMenu(); }, active: () => desktopMode },
  { id: "reader", label: "Reader mode", icon: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>', action: () => { if (activeId && activeId > 0) invoke("reader_bundle", { id: activeId }).then((html: string) => { if (html) { invoke("navigate_tab", { id: activeId!, url: "data:text/html;charset=utf-8," + encodeURIComponent(html) }); showToast("Reader on"); } else showToast("Not supported on this page"); }).catch(() => showToast("Reader failed")); else showToast("Open a page first"); } },
  { id: "qr", label: "QR scanner", icon: '<polyline points="4 4 4 10 10 4"/><polyline points="14 4 14 10 20 4"/><polyline points="4 14 4 20 10 14"/><polyline points="14 14 14 20 20 14"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/>', action: async () => { try { const text = await invoke<string>("qr_pick_and_scan"); if (text) { openUrl(text); } else showToast("No QR code found"); } catch { showToast("QR scan cancelled"); } } },
  { id: "find", label: "Find in page", icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', action: () => { const q = prompt("Find in page:"); if (q && activeId && activeId > 0) invoke("eval_tab", { id: activeId, js: `window.find(${JSON.stringify(q)})` }).catch(() => showToast("Find not supported")); } },
  { id: "fs", label: "Fullscreen", icon: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>', action: async () => { const w = (window as any).__TAURI__?.window?.appWindow; if (w) { const f = await w.isFullscreen(); await w.setFullscreen(!f); showToast(f ? "Windowed" : "Fullscreen"); } } },
  { id: "share", label: "Share link", icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>', action: () => { const t = tabs.find(x => x.id === activeId); if (t?.url) navigator.clipboard.writeText(t.url).then(() => showToast("Copied")).catch(() => {}); else showToast("No URL"); } },
  { id: "addbm", label: "Add bookmark", icon: '<path d="M12 5v14M5 12h14"/>', action: async () => { const t = tabs.find(x => x.id === activeId); if (!t?.url) { showToast("Open a page first"); return; } await invoke("add_bookmark", { url: t.url, title: t.title || t.url, folder: null }); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => bookmarks); showToast("Added"); refreshMenu(); } },
  { id: "adsb", label: "Ad blocking", icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', action: () => { adblockOn = !adblockOn; persistSettings(); showToast(adblockOn ? "Ads blocked" : "Ads unblocked"); refreshMenu(); }, active: () => adblockOn },
  { id: "tracker", label: "No-tracking", icon: '<path d="M18 11V7a6 6 0 00-12 0v4"/><path d="M14 21v-4a2 2 0 00-4 0v4"/>', action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "navigator.doNotTrack='1'" }).then(() => showToast("DNT set")).catch(() => showToast("Not supported")); else showToast("Open a page first"); } },
  { id: "images", label: "Show images", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>', action: () => { showImages = !showImages; persistSettings(); showToast(showImages ? "Images on" : "Images off"); refreshMenu(); }, active: () => showImages },
  { id: "scripts", label: "Scripts", icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', action: () => openPanel("Scripts", renderScriptsRoot) },
  { id: "siteconfig", label: "Site config", icon: '<circle cx="12" cy="12" r="3"/>', action: () => openPanel("Site config", renderSiteConfig) },
  { id: "cookies", label: "Cookies", icon: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><circle cx="12" cy="12" r="2"/>', action: () => openPanel("Cookies", renderCookies) },
  { id: "customize", label: "Customize", icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="20" y1="21" x2="20" y2="16"/>', action: () => openPanel("Customize menu", renderCustomize) },
  { id: "settings", label: "Settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/>', action: () => openPanel("Settings", renderSettings) },
  { id: "about", label: "About", icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', action: () => openPanel("About", b => { b.innerHTML = '<div style="text-align:center;padding:48px 16px"><img src="/via-logo.svg" style="width:72px;margin-bottom:16px"/><div style="font-size:18px;font-weight:600">Via Browser</div><div style="font-size:12px;color:var(--fg-muted);margin-top:8px">Windows · Tauri + WebView2</div></div>'; }) },
  { id: "incognito", label: "Incognito", icon: '<path d="M17 8h1a4 4 0 110 8h-1"/><path d="M3 8h14v8H3z"/>', action: () => { incognitoMode = !incognitoMode; showToast(incognitoMode ? "Incognito on" : "Incognito off"); refreshMenu(); }, active: () => incognitoMode },
  { id: "print", label: "Print", icon: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>', action: () => { if (activeId && activeId > 0) { invoke("eval_tab", { id: activeId, js: "window.print()" }).catch(() => {}); } else showToast("Open a page first"); } },
  { id: "share2", label: "Copy URL", icon: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4"/>', action: () => { const t = tabs.find(x => x.id === activeId); if (t?.url) navigator.clipboard.writeText(t.url).then(() => showToast("Copied")); else showToast("No URL"); } },
  { id: "export", label: "Export data", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/>', action: () => invoke<string>("export_backup").then(p => showToast("Exported: " + p.split(/[/\\]/).pop())).catch(() => showToast("Failed")) },
  { id: "import", label: "Import data", icon: '<polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', action: async () => { try { await invoke("import_latest_backup"); settings = await invoke<Settings>("get_settings"); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []); historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []); downloads = await invoke<DlItem[]>("list_downloads").catch(() => []); showToast("Imported"); } catch { showToast("No backup found"); } } },
  { id: "ext", label: "Extensions", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>', action: () => openPanel("Extensions", b => b.innerHTML = '<div class="empty-state">Chrome extension support:<br><br>Via Browser on Windows uses WebView2 which supports Chrome extensions.<br><br>Install extensions from the Chrome Web Store by navigating to the store and adding them.</div>') },
];
function menuOrder(): string[] {
  const o = settings?.toolbar_layout?.visible;
  if (o?.length) { const v = o.filter(id => MENU.some(m => m.id === id)); const m = MENU.map(x => x.id).filter(id => !v.includes(id)); return [...v, ...m]; }
  return MENU.map(m => m.id);
}

/* ═══════ TAB MANAGEMENT ═══════ */

function showOnlyWebview(id: number) {
  log("showOnlyWebview id=", id, "tabs=", tabs.map(t => t.id));
  for (const t of tabs) {
    if (t.id === id) invoke("show_tab", { id: t.id }).catch(e => log("show_tab error", e));
    else if (t.id > 0) invoke("hide_tab", { id: t.id }).catch(() => {});
  }
}
function hideAllWebviews() {
  for (const t of tabs) { if (t.id > 0) invoke("hide_tab", { id: t.id }).catch(() => {}); }
}
function showHomePage() {
  log("showHomePage");
  $("home").classList.remove("hidden");
  $("bottom-nav").classList.remove("hidden");
}
function hideHomePage() {
  $("home").classList.add("hidden");
  $("bottom-nav").classList.add("hidden");
}

function createTab(url?: string): Promise<Tab> {
  log("createTab url=", url, "activeId=", activeId, "tabs=", tabs.length);
  const targetUrl = url || "about:blank";
  return invoke<TabInfo>("create_tab", { url: targetUrl }).then(info => {
    const tab: Tab = { id: info.id, url: targetUrl, title: url ? "Loading..." : "New Tab", active: true };
    tabs.push(tab);
    activeId = info.id;
    log("TAB CREATED id=", info.id, "total=", tabs.length);
    showToast("Tab " + tabs.length + " created");
    if (url) invoke("navigate_tab", { id: info.id, url }).catch(e => log("navigate_tab failed", e));
    showOnlyWebview(info.id);
    hideHomePage();
    if (url) invoke("add_history", { url, title: url }).catch(() => {});
    updateNavButtons();
    updateTabCount();
    updateInjectedNavCounts();
    return tab;
  }).catch(e => {
    log("createTab FAILED:", e);
    showToast("Tab creation failed: " + String(e).slice(0, 80));
    throw e;
  });
}

async function closeTab(id: number) {
  log("closeTab id=", id);
  const tab = tabs.find(t => t.id === id);
  if (tab) {
    closedTabs.unshift({ url: tab.url || "", title: tab.title, ts: Date.now() });
    if (closedTabs.length > 50) closedTabs.length = 50;
    await invoke("push_closed_tab", { url: tab.url || "", title: tab.title }).catch(() => {});
  }
  if (id > 0) await invoke("close_tab", { id }).catch(() => {});
  tabs = tabs.filter(t => t.id !== id);
  if (activeId === id) {
    if (tabs.length) { await switchTab(tabs[tabs.length - 1].id); }
    else { activeId = null; showHomePage(); }
  }
  updateTabCount();
  updateInjectedNavCounts();
}

async function switchTab(id: number) {
  log("switchTab id=", id);
  tabs.forEach(t => t.active = false);
  const tab = tabs.find(t => t.id === id);
  if (tab) tab.active = true;
  activeId = id;
  if (id < 0) {
    hideAllWebviews();
    $("home").classList.remove("hidden");
    $("bottom-nav").classList.remove("hidden");
  } else {
    await invoke("select_tab", { id }).catch(e => log("select_tab failed", e));
    showOnlyWebview(id);
    hideHomePage();
  }
  updateNavButtons();
  updateTabCount();
}

function updateTabCount() { $("nav-tab-count").textContent = String(tabs.length || 1); }

function updateInjectedNavCounts() {
  const count = String(tabs.length || 1);
  for (const t of tabs) {
    if (t.id > 0) invoke("eval_tab", { id: t.id, js: `var e=document.getElementById('vn-count');if(e)e.textContent='${count}';` }).catch(() => {});
  }
}

function updateNavButtons() {
  if (activeId && activeId < 0) {
    $("nav-back").setAttribute("disabled", "disabled");
    $("nav-fwd").setAttribute("disabled", "disabled");
  } else {
    $("nav-back").removeAttribute("disabled");
    $("nav-fwd").removeAttribute("disabled");
  }
}

/* ═══════ SEARCH / NAVIGATION ═══════ */
function handleSearch() {
  const input = $("home-input") as HTMLInputElement;
  const val = input.value.trim();
  if (!val) { showToast("Type something to search"); return; }
  input.value = "";
  log("handleSearch:", val);
  let url: string;
  if (/^https?:\/\//i.test(val) || /^localhost/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}/.test(val) || (val.includes('.') && !val.includes(' ')))
    url = /^https?:\/\//i.test(val) || /^localhost/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}/.test(val) ? val : "https://" + val;
  else
    url = (ENGINES[searchEngine] || ENGINES.Google) + encodeURIComponent(val);
  log("handleSearch URL:", url);
  openUrl(url).catch(e => {
    log("handleSearch openUrl FAILED:", e);
    showToast("Navigation failed: " + String(e).slice(0, 80));
  });
}

async function openUrl(url: string): Promise<void> {
  log("openUrl", url, "activeId=", activeId, "tabs=", tabs.length);
  if (activeId && activeId < 0) {
    log("openUrl: converting local tab", activeId);
    const emptyTab = tabs.find(t => t.id === activeId);
    try {
      const info = await invoke<TabInfo>("create_tab", { url });
      tabs = tabs.filter(t => t.id !== activeId);
      tabs.push({ id: info.id, url, title: "Loading...", active: true });
      activeId = info.id;
      log("openUrl: converted to webview", info.id);
      invoke("navigate_tab", { id: info.id, url }).catch(e => log("nav failed", e));
      showOnlyWebview(info.id);
      hideHomePage();
      invoke("add_history", { url, title: url }).catch(() => {});
      updateNavButtons();
      updateTabCount();
      updateInjectedNavCounts();
    } catch (e) {
      log("openUrl create_tab FAILED:", e);
      showToast("Navigation failed: " + String(e).slice(0, 80));
    }
  } else if (activeId && activeId > 0) {
    log("openUrl: navigating existing tab", activeId);
    const tab = tabs.find(t => t.id === activeId);
    if (tab) tab.url = url;
    await invoke("navigate_tab", { id: activeId, url }).catch(e => { log("navigate_tab FAILED:", e); showToast("Nav failed"); });
    showOnlyWebview(activeId);
    hideHomePage();
    invoke("add_history", { url, title: url }).catch(() => {});
    updateNavButtons();
  } else {
    log("openUrl: no active tab, creating new");
    await createTab(url);
  }
}

/* ═══════ SIDE MENU ═══════ */
function buildMenu() {
  const grid = $("side-menu-grid"); const order = menuOrder();
  const start = menuPage * MENU_PAGE_SIZE; const page = order.slice(start, start + MENU_PAGE_SIZE);
  const items = page.map(id => MENU.find(m => m.id === id)).filter(Boolean) as MI[];
  grid.innerHTML = items.map(i => `<button class="sheet-item${i.active?.() ? ' active' : ''}" data-m="${i.id}">${ic(i.icon)}<span>${i.label}</span></button>`).join("");
  grid.querySelectorAll(".sheet-item").forEach(el => el.addEventListener("click", () => { const i = MENU.find(m => m.id === el.getAttribute("data-m")!); if (i) { closeMenu(); i.action(); } }));
  $("side-menu-pagination").innerHTML = Array.from({ length: Math.ceil(order.length / MENU_PAGE_SIZE) }, (_, i) => `<div class="pg-dot${i === menuPage ? ' active' : ''}" data-p="${i}"></div>`).join("");
  $("side-menu-pagination").querySelectorAll(".pg-dot").forEach(el => el.addEventListener("click", () => { menuPage = parseInt(el.getAttribute("data-p")!); buildMenu(); }));
}
function refreshMenu() { if (menuOpen) buildMenu(); }
function openMenu() {
  menuOpen = true; buildMenu();
  hideAllWebviews();
  $("side-menu").classList.add("open");
  $("menu-backdrop").classList.add("open");
}
function closeMenu() {
  menuOpen = false;
  $("side-menu").classList.remove("open");
  $("menu-backdrop").classList.remove("open");
  if (activeId && activeId > 0) showOnlyWebview(activeId);
}

/* ═══════ PANEL ═══════ */
function openPanel(title: string, fn: (b: HTMLElement) => void) {
  $("panel-title").textContent = title; const b = $("panel-body"); b.innerHTML = "";
  fn(b);
  $("panel").classList.add("open");
  $("panel-backdrop").classList.add("open");
}
function closePanel() {
  $("panel").classList.remove("open");
  $("panel-backdrop").classList.remove("open");
}

/* ═══════ PANEL RENDERERS ═══════ */
function renderBookmarks(b: HTMLElement) {
  if (!bookmarks.length) { b.innerHTML = '<div class="empty-state">No bookmarks yet</div>'; return; }
  b.innerHTML = '<div class="pp-list">' + bookmarks.map((bm, i) => `<div class="pp-item" data-bi="${i}"><div class="pi-info"><div class="pi-title">${esc(bm.title)}</div><div class="pi-sub">${esc(bm.url)}</div></div><button class="pi-action" data-rb="${i}">✕</button></div>`).join("") + '</div>';
  b.querySelectorAll(".pp-item").forEach(el => el.addEventListener("click", e => { if ((e.target as HTMLElement).closest("[data-rb]")) return; const i = parseInt(el.getAttribute("data-bi")!); closePanel(); openUrl(bookmarks[i].url); }));
  b.querySelectorAll("[data-rb]").forEach(el => el.addEventListener("click", async e => { e.stopPropagation(); const i = parseInt(el.getAttribute("data-rb")!); await invoke("remove_bookmark", { url: bookmarks[i].url }); bookmarks.splice(i, 1); renderBookmarks(b); showToast("Removed"); }));
}
function renderHistory(b: HTMLElement) {
  if (!historyItems.length) { b.innerHTML = '<div class="empty-state">No history yet</div>'; return; }
  b.innerHTML = '<div class="pp-list">' + historyItems.map((h, i) => `<div class="pp-item" data-hi="${i}"><div class="pi-info"><div class="pi-title">${esc(h.title || h.url)}</div><div class="pi-sub">${esc(h.url)}</div></div></div>`).join("") + '</div><div style="padding:16px"><button class="btn" id="clr-hist">Clear history</button></div>';
  b.querySelectorAll(".pp-item").forEach(el => el.addEventListener("click", () => { const i = parseInt(el.getAttribute("data-hi")!); closePanel(); openUrl(historyItems[i].url); }));
  b.querySelector("#clr-hist")?.addEventListener("click", async () => { await invoke("clear_history"); historyItems = []; renderHistory(b); showToast("Cleared"); });
}
function refreshDownloads() { invoke<DlItem[]>("list_downloads").then(d => { downloads = d; }).catch(() => {}); }
function renderDownloads(b: HTMLElement) {
  if (!downloads.length) { b.innerHTML = '<div class="empty-state">No downloads yet</div>'; return; }
  b.innerHTML = downloads.map(d => `<div class="dl-item"><div class="dl-name">${esc(d.title || d.path?.split(/[/\\]/).pop() || "file")}</div><div class="dl-meta">${fmtSize(d.size)} · ${d.done ? "Complete" : "In progress"}</div><div class="dl-actions"><button data-df="${esc(d.path)}">Open</button><button data-dr="${esc(d.url)}">Retry</button></div></div>`).join("");
  b.querySelectorAll("[data-df]").forEach(el => el.addEventListener("click", () => invoke("open_download", { path: el.getAttribute("data-df") }).catch(() => showToast("Cannot open"))));
  b.querySelectorAll("[data-dr]").forEach(el => el.addEventListener("click", () => { closePanel(); openUrl(el.getAttribute("data-dr") || ""); }));
}
function renderScriptsRoot(b: HTMLElement) {
  b.innerHTML = '<div class="mg-list"><div class="mg-item" data-sr="list">My scripts <span class="chev">›</span></div><div class="mg-item" data-sr="store">Script store (Tampermonkey) <span class="chev">›</span></div></div>';
  b.querySelectorAll(".mg-item").forEach(el => el.addEventListener("click", () => { const k = el.getAttribute("data-sr")!; if (k === "list") openPanel("Scripts", renderScripts); else if (k === "store") openPanel("Script store", renderScriptStore); }));
}
function renderScripts(b: HTMLElement) {
  const scripts = settings?.scripts || [];
  if (!scripts.length) { b.innerHTML = '<div class="empty-state">No scripts installed</div>'; return; }
  b.innerHTML = scripts.map(s => `<div class="pp-item"><div class="pi-info"><div class="pi-title">${esc(s.name)}</div><div class="pi-sub">${esc(s.match_urls || "*")}</div></div><button class="pi-action" data-ds="${esc(s.id)}">✕</button></div>`).join("");
  b.querySelectorAll("[data-ds]").forEach(el => el.addEventListener("click", async e => { e.stopPropagation(); const id = el.getAttribute("data-ds")!; if (settings) settings.scripts = settings.scripts.filter(s => s.id !== id); await persistSettings(); renderScripts(b); showToast("Deleted"); }));
}
function renderScriptStore(b: HTMLElement) {
  b.innerHTML = '<div class="empty-state">Tampermonkey-compatible script store<br><br>Navigate to <b>Greasy Fork</b> or <b>OpenUserJS</b> to search and install scripts directly from those sites.</div>';
}
function renderSiteConfig(b: HTMLElement) {
  const configs = settings?.sites || [];
  const host = (activeId && activeId > 0) ? (() => { try { const t = tabs.find(x => x.id === activeId); return t?.url ? new URL(t.url).hostname : ""; } catch { return ""; } })() : "";
  const existing = configs.find(c => c.host === host);
  b.innerHTML = `<div class="field"><label>Host</label><input id="sc-host" value="${esc(host)}" /></div><div class="mg-list"><div class="mg-item" data-sc="ua">UA mode: ${existing?.ua_mode || "Default"} <span class="chev">›</span></div><div class="mg-item" data-sc="ad">Ad blocking: ${existing?.adblock_enabled !== false ? "On" : "Off"} <span class="switch ${existing?.adblock_enabled !== false ? 'on' : ''}"></span></div></div><button class="btn primary" id="sc-save">Save</button>`;
  b.querySelector("#sc-save")?.addEventListener("click", async () => {
    const h = (b.querySelector("#sc-host") as HTMLInputElement)?.value || host;
    const s = settings!; if (!s.sites) s.sites = [];
    const idx = s.sites.findIndex(c => c.host === h);
    const cfg = { host: h, ua_mode: existing?.ua_mode || "", adblock_enabled: existing?.adblock_enabled !== false };
    if (idx >= 0) s.sites[idx] = cfg; else s.sites.push(cfg);
    await persistSettings(); showToast("Saved"); closePanel();
  });
}
function renderCookies(b: HTMLElement) {
  if (!activeId || activeId < 0) { b.innerHTML = '<div class="empty-state">Open a page first</div>'; return; }
  invoke<string>("get_cookies", { id: activeId }).then(c => { b.innerHTML = `<div style="padding:16px;white-space:pre-wrap;font-size:12px;color:var(--fg-muted)">${esc(c || "No cookies")}</div>`; }).catch(() => { b.innerHTML = '<div class="empty-state">Cannot read cookies</div>'; });
}
function renderCustomize(b: HTMLElement) {
  const order = menuOrder();
  b.innerHTML = '<div class="sec-title">Hold and drag to rearrange</div><div id="cv">' + order.map(id => { const i = MENU.find(m => m.id === id); return i ? `<div class="drag-item" data-mid="${i.id}" draggable="true"><span class="drag-handle">⠿</span><span class="drag-label">${esc(i.label)}</span></div>` : ""; }).join("") + '</div><div style="padding:16px"><button class="btn" id="rmb">Reset</button></div>';
  const list = b.querySelector("#cv")!; let d: HTMLElement | null = null;
  list.addEventListener("dragstart", e => { d = (e.target as HTMLElement).closest(".drag-item"); if (d) d.style.opacity = "0.5"; });
  list.addEventListener("dragend", () => { if (d) d.style.opacity = ""; d = null; });
  list.addEventListener("dragover", (e: any) => { e.preventDefault(); const t = (e.target as HTMLElement).closest(".drag-item") as HTMLElement; if (t && t !== d && d) { const r = t.getBoundingClientRect(); e.clientY < r.top + r.height / 2 ? list.insertBefore(d, t) : list.insertBefore(d, t.nextSibling); } });
  list.addEventListener("dragend", async () => { const o: string[] = []; list.querySelectorAll(".drag-item").forEach(el => o.push(el.getAttribute("data-mid")!)); if (settings?.toolbar_layout) settings.toolbar_layout.visible = o; await persistSettings(); refreshMenu(); });
  b.querySelector("#rmb")?.addEventListener("click", async () => { if (settings?.toolbar_layout) settings.toolbar_layout.visible = []; await persistSettings(); renderCustomize(b); refreshMenu(); showToast("Reset"); });
}
function renderSettings(b: HTMLElement) {
  const s = settings; if (!s) return;
  b.innerHTML = `<div class="mg-list">
    <div class="sec-title">General</div><div class="mg-item" data-s="search">Search: ${searchEngine} <span class="chev">›</span></div>
    <div class="sec-title">Appearance</div><div class="mg-item" data-s="night">Night mode <span class="switch ${nightMode ? 'on' : ''}"></span></div><div class="mg-item" data-s="text">Text size <span style="margin-left:auto;color:var(--fg-muted)">${Math.round(s.text_size * 100)}%</span></div>
    <div class="sec-title">Privacy</div><div class="mg-item" data-s="ad">Ad blocking <span class="switch ${s.adblock_enabled ? 'on' : ''}"></span></div><div class="mg-item" data-s="dt">Desktop mode <span class="switch ${s.desktop_mode ? 'on' : ''}"></span></div>
    <div class="sec-title">Startup</div><div class="mg-item" data-s="rt">Restore tabs <span class="switch ${s.restore_tabs ? 'on' : ''}"></span></div>
    <div class="sec-title">Data</div><div class="mg-item" data-s="ex">Export backup <span class="chev">›</span></div><div class="mg-item" data-s="im">Import backup <span class="chev">›</span></div>
  </div>`;
  b.querySelectorAll(".switch").forEach(el => el.addEventListener("click", e => { e.stopPropagation(); el.classList.toggle("on"); }));
  b.querySelectorAll(".mg-item[data-s]").forEach(el => el.addEventListener("click", () => {
    const k = el.getAttribute("data-s")!; const s2 = settings!;
    if (k === "search") { openPanel("Search engine", sb => { const engines = Object.keys(ENGINES); sb.innerHTML = '<div class="pp-list">' + engines.map(name => '<div class="pp-item' + (name === searchEngine ? ' selected' : '') + '" data-eng="' + esc(name) + '"><div class="pi-info"><div class="pi-title">' + esc(name) + '</div><div class="pi-sub">' + esc(ENGINES[name]) + '</div></div></div>').join("") + '</div>'; sb.querySelectorAll(".pp-item").forEach(el => el.addEventListener("click", () => { searchEngine = el.getAttribute("data-eng")!; s2.search_engine = searchEngine; persistSettings(); showToast("Search: " + searchEngine); closePanel(); closePanel(); })); }); }
    else if (k === "night") { nightMode = !nightMode; s2.night_mode = nightMode; invoke("set_night_mode", { enabled: nightMode }); persistSettings(); renderSettings(b); }
    else if (k === "text") { textSize = textSize >= 2 ? 0.5 : textSize + 0.25; s2.text_size = textSize; persistSettings(); showToast(Math.round(textSize * 100) + "%"); renderSettings(b); }
    else if (k === "ad") { adblockOn = !adblockOn; s2.adblock_enabled = adblockOn; persistSettings(); renderSettings(b); }
    else if (k === "dt") { desktopMode = !desktopMode; s2.desktop_mode = desktopMode; persistSettings(); renderSettings(b); }
    else if (k === "rt") { restoreTabs = !restoreTabs; s2.restore_tabs = restoreTabs; persistSettings(); renderSettings(b); }
    else if (k === "ex") invoke<string>("export_backup").then(p => showToast("Saved: " + p.split(/[/\\]/).pop())).catch(() => showToast("Failed"));
    else if (k === "im") { invoke("import_latest_backup").then(async () => { settings = await invoke<Settings>("get_settings"); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []); historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []); downloads = await invoke<DlItem[]>("list_downloads").catch(() => []); showToast("Imported"); }).catch(() => showToast("No backup")); }
  }));
}
function persistSettings() {
  if (!settings) return;
  settings.search_engine = searchEngine; settings.night_mode = nightMode; settings.desktop_mode = desktopMode;
  settings.text_size = textSize; settings.show_images = showImages; settings.adblock_enabled = adblockOn; settings.restore_tabs = restoreTabs;
  invoke("set_settings", { settings }).catch(() => {});
}

/* ═══════ EVENTS ═══════ */
function setupEvents() {
  listen<{ id: number; url: string }>("tab-url", ev => { const tab = tabs.find(t => t.id === ev.payload.id); if (tab) { tab.url = ev.payload.url; if (tab.id === activeId) updateNavButtons(); } });
  listen<{ id: number; title: string }>("tab-title", ev => { const tab = tabs.find(t => t.id === ev.payload.id); if (tab) tab.title = ev.payload.title; });
  listen<string>("nav-action", ev => {
    const action = ev.payload;
    log("nav-action:", action);
    if (action === "home") { if (activeId && activeId > 0) { const tab = tabs.find(t => t.id === activeId); if (tab) { tab.url = ""; tab.title = "New Tab"; } invoke("navigate_tab", { id: activeId, url: "about:blank" }).catch(() => {}); } showHomePage(); updateNavButtons(); }
    else if (action === "tabs") openPanel("Tabs (" + tabs.length + ")", renderTabs);
    else if (action === "menu") openMenu();
  });
  listen<any>("download-started", ev => { const d = ev.payload; showDlNotification("Download started", d.path?.split(/[/\\]/).pop() || "file", 0); });
  listen<any>("download-progress", ev => { const d = ev.payload; updateDlNotification(d.path?.split(/[/\\]/).pop() || "file", d.progress || 0); });
  listen<any>("download-finished", ev => { const d = ev.payload; showDlNotification("Download complete", d.path?.split(/[/\\]/).pop() || "file", 100); refreshDownloads(); });
  listen<{ url: string }>("new-window-request", ev => { createTab(ev.payload.url); });
}

/* ═══════ DOWNLOAD NOTIFICATION ═══════ */
let dlTimer: any = null;
function showDlNotification(status: string, name: string, pct: number) {
  const el = $("dl-toast");
  el.innerHTML = `<div class="dl-toast-name">${esc(name)}</div><div class="dl-toast-meta">${status}</div><div class="dl-toast-bar"><div class="dl-toast-bar-fill" style="width:${pct}%"></div></div>`;
  el.classList.add("show");
  clearTimeout(dlTimer);
  dlTimer = setTimeout(() => el.classList.remove("show"), 5000);
}
function updateDlNotification(name: string, pct: number) {
  const el = $("dl-toast");
  const fill = el.querySelector(".dl-toast-bar-fill") as HTMLElement;
  if (fill) fill.style.width = Math.min(100, pct) + "%";
  const meta = el.querySelector(".dl-toast-meta") as HTMLElement;
  if (meta) meta.textContent = Math.round(pct) + "%";
}

/* ═══════ KEYBOARD ═══════ */
function setupKeyboard() {
  window.addEventListener("keydown", e => {
    const c = e.ctrlKey || e.metaKey;
    if (c && e.key === "t") { e.preventDefault(); createTab(); }
    else if (c && e.key === "w") { e.preventDefault(); if (activeId) closeTab(activeId); }
    else if (c && e.shiftKey && e.key === "T") { e.preventDefault(); const ct = closedTabs.shift(); if (ct) createTab(ct.url === "about:blank" ? undefined : ct.url); }
    else if (c && e.key === "l") { e.preventDefault(); $("home").classList.remove("hidden"); $("bottom-nav").classList.remove("hidden"); const input = $("home-input") as HTMLInputElement; const t = tabs.find(x => x.id === activeId); input.value = t?.url || ""; input.focus(); input.select(); }
    else if (c && e.key === "b") { e.preventDefault(); const t = tabs.find(x => x.id === activeId); if (t?.url) { invoke("add_bookmark", { url: t.url, title: t.title || t.url, folder: null }).then(() => { bookmarks.push({ url: t.url, title: t.title || t.url, folder: "" }); showToast("Bookmarked"); }); } }
    else if (c && e.key === "h") { e.preventDefault(); openPanel("History", renderHistory); }
    else if (e.key === "F11") { e.preventDefault(); const w = (window as any).__TAURI__?.window?.appWindow; if (w) w.isFullscreen().then((f: boolean) => w.setFullscreen(!f)); }
  });
}

/* ═══════ SESSION ═══════ */
function saveSession() {
  if (!restoreTabs || !tabs.length) return;
  const entries = tabs.filter(t => t.url && t.url !== "about:blank").map((t, i) => ({ url: t.url, title: t.title, active: t.id === activeId, order: i }));
  invoke("save_session", { entries }).catch(() => {});
}

/* ═══════ TABS PANEL ═══════ */
function renderTabs(b: HTMLElement) {
  if (!tabs.length) { b.innerHTML = '<div class="empty-state">No open tabs</div><div style="padding:16px"><button class="btn primary" id="ntb">+ New Tab</button></div>'; b.querySelector("#ntb")?.addEventListener("click", () => { closePanel(); createTab(); }); return; }
  b.innerHTML = '<div class="pp-list">' + tabs.map(t => `<div class="pp-item${t.id === activeId ? ' selected' : ''}" data-t="${t.id}"><div class="pi-icon">${t.id === activeId ? "▶" : "◻"}</div><div class="pi-info"><div class="pi-title">${esc(t.title || "New Tab")}</div><div class="pi-sub">${esc(t.url || "about:blank")}</div></div><button class="pi-action" data-ct="${t.id}">✕</button></div>`).join("") + '</div><div style="padding:16px"><button class="btn primary" id="ntb">+ New Tab</button></div>';
  b.querySelector("#ntb")?.addEventListener("click", () => { closePanel(); createTab(); });
  b.querySelectorAll(".pp-item[data-t]").forEach(el => el.addEventListener("click", e => { if ((e.target as HTMLElement).closest("[data-ct]")) return; closePanel(); switchTab(parseInt(el.getAttribute("data-t")!)); }));
  b.querySelectorAll("[data-ct]").forEach(el => el.addEventListener("click", async e => { e.stopPropagation(); await closeTab(parseInt(el.getAttribute("data-ct")!)); renderTabs(b); }));
}

/* ═══════ BOOT ═══════ */
async function boot() {
  log("BOOT STARTING");
  settings = await invoke<Settings>("get_settings").catch(() => null);
  if (settings) { searchEngine = settings.search_engine || "Google"; nightMode = settings.night_mode; desktopMode = settings.desktop_mode; textSize = settings.text_size || 1; showImages = settings.show_images !== false; adblockOn = settings.adblock_enabled !== false; restoreTabs = settings.restore_tabs || false; }
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
  historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []);
  downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);
  setupEvents(); setupKeyboard();

  $("nav-back").addEventListener("click", () => { if (activeId && activeId > 0) invoke("eval_tab", { id: activeId, js: "history.back()" }).catch(() => {}); });
  $("nav-fwd").addEventListener("click", () => { if (activeId && activeId > 0) invoke("eval_tab", { id: activeId, js: "history.forward()" }).catch(() => {}); });
  $("nav-home").addEventListener("click", () => showHomePage());
  $("nav-tabs").addEventListener("click", () => openPanel("Tabs (" + tabs.length + ")", renderTabs));
  $("nav-menu").addEventListener("click", () => { closePanel(); openMenu(); });
  $("home-search").addEventListener("click", e => { e.stopPropagation(); ($("home-input") as HTMLInputElement).focus(); });
  $("home-input").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); handleSearch(); } e.stopPropagation(); });
  $("menu-backdrop").addEventListener("click", closeMenu);
  $("menu-exit").addEventListener("click", () => { closeMenu(); closePanel(); });
  $("menu-collapse").addEventListener("click", closeMenu);
  $("panel-back").addEventListener("click", closePanel);
  $("panel-backdrop").addEventListener("click", closePanel);
  window.addEventListener("beforeunload", () => saveSession());

  setupDraggableNav();

  updateTabCount();
  $("home").classList.remove("hidden");
  log("BOOT COMPLETE, tabs:", tabs.length);
  showToast("Via Browser v7.2.3");
}

function setupDraggableNav() {
  const nav = $("bottom-nav");
  let dragging = false, startY = 0, startBottom = 20;
  nav.addEventListener("mousedown", e => { if ((e.target as HTMLElement).closest("button")) return; dragging = true; startY = e.clientY; startBottom = parseInt(nav.style.bottom) || 20; e.preventDefault(); });
  document.addEventListener("mousemove", e => { if (!dragging) return; const delta = startY - e.clientY; const maxB = window.innerHeight - 70; nav.style.bottom = Math.max(10, Math.min(maxB, startBottom + delta)) + "px"; });
  document.addEventListener("mouseup", () => { dragging = false; });
}

boot();
