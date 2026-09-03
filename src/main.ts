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
let closedTabs: ClosedTab[] = [];
let defaultTabId: number | null = null;

const $ = (s: string) => document.getElementById(s) as HTMLElement;
function esc(s: string): string { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function showToast(msg: string) {
  const el = $("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout((el as any)._t); (el as any)._t = setTimeout(() => el.classList.remove("show"), 2400);
}
function fmtSize(b: number): string { return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB" : (b / 1073741824).toFixed(1) + " GB"; }
function log(msg: string, ...args: any[]) { console.log("[Via]", msg, ...args); }
const BUILD_ID = "BUILD_2026_09_02_SHELL";
function debugLog(msg: string) {
  console.log("[Via-DIAG]", msg);
  invoke("log_to_file", { msg: `[${BUILD_ID}] ${msg}` }).catch(() => {});
}

/* ═══════ Menu ═══════ */
interface MI { id: string; label: string; icon: string; action: () => void; active?: () => boolean; }
function ic(p: string) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${p}</svg>`; }
const MENU: MI[] = [
  { id: "bookmarks", label: "Bookmarks", icon: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>', action: () => openPanel("Bookmarks", renderBookmarks) },
  { id: "history", label: "History", icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', action: () => openPanel("History", renderHistory) },
  { id: "downloads", label: "Downloads", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', action: () => { refreshDownloads(); openPanel("Downloads", renderDownloads); } },
  { id: "saved", label: "Saved pages", icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>', action: () => openPanel("Saved Pages", b => b.innerHTML = '<div class="empty-state">Use "Save page" from the menu to save pages here.</div>') },
  { id: "night", label: "Night mode", icon: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>', action: () => { nightMode = !nightMode; persistSettings(); showToast(nightMode ? "Night on" : "Night off"); refreshMenu(); }, active: () => nightMode },
  { id: "desktop", label: "Desktop mode", icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>', action: () => { desktopMode = !desktopMode; persistSettings(); showToast(desktopMode ? "Desktop" : "Mobile"); refreshMenu(); }, active: () => desktopMode },
  { id: "reader", label: "Reader mode", icon: '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>', action: () => { if (activeId && activeId > 0) invoke("reader_bundle", { id: activeId }).then((html: string) => { if (html) { invoke("navigate_tab", { id: activeId!, url: "data:text/html;charset=utf-8," + encodeURIComponent(html) }); showToast("Reader on"); } else showToast("Not supported"); }).catch(() => showToast("Reader failed")); else showToast("Open a page first"); } },
  { id: "qr", label: "QR scanner", icon: '<polyline points="4 4 4 10 10 4"/><polyline points="14 4 14 10 20 4"/><polyline points="4 14 4 20 10 14"/><polyline points="14 14 14 20 20 14"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/>', action: async () => { try { const text = await invoke<string>("qr_pick_and_scan"); if (text) openUrl(text); else showToast("No QR code found"); } catch { showToast("QR scan cancelled"); } } },
  { id: "find", label: "Find in page", icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', action: () => { const q = prompt("Find in page:"); if (q && activeId && activeId > 0) invoke("eval_tab", { id: activeId, js: `window.find(${JSON.stringify(q)})` }).catch(() => showToast("Find not supported")); } },
  { id: "fs", label: "Fullscreen", icon: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>', action: async () => { const w = (window as any).__TAURI__?.window?.appWindow; if (w) { const f = await w.isFullscreen(); await w.setFullscreen(!f); showToast(f ? "Windowed" : "Fullscreen"); } } },
  { id: "share", label: "Share link", icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>', action: () => { const t = tabs.find(x => x.id === activeId); if (t?.url) navigator.clipboard.writeText(t.url).then(() => showToast("Copied")).catch(() => {}); else showToast("No URL"); } },
  { id: "addbm", label: "Add bookmark", icon: '<path d="M12 5v14M5 12h14"/>', action: async () => { const t = tabs.find(x => x.id === activeId); if (!t?.url) { showToast("Open a page first"); return; } await invoke("add_bookmark", { url: t.url, title: t.title || t.url, folder: null }); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => bookmarks); showToast("Added"); refreshMenu(); } },
  { id: "adsb", label: "Ad blocking", icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', action: () => { adblockOn = !adblockOn; persistSettings(); showToast(adblockOn ? "Ads blocked" : "Ads unblocked"); refreshMenu(); }, active: () => adblockOn },
  { id: "images", label: "Show images", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>', action: () => { showImages = !showImages; persistSettings(); showToast(showImages ? "Images on" : "Images off"); refreshMenu(); }, active: () => showImages },
  { id: "scripts", label: "Scripts", icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', action: () => openPanel("Scripts", renderScriptsRoot) },
  { id: "siteconfig", label: "Site config", icon: '<circle cx="12" cy="12" r="3"/>', action: () => openPanel("Site config", renderSiteConfig) },
  { id: "cookies", label: "Cookies", icon: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><circle cx="12" cy="12" r="2"/>', action: () => openPanel("Cookies", renderCookies) },
  { id: "settings", label: "Settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/>', action: () => openPanel("Settings", renderSettings) },
  { id: "about", label: "About", icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', action: () => openPanel("About", b => { b.innerHTML = '<div style="text-align:center;padding:48px 16px"><img src="/via-logo.svg" style="width:72px;margin-bottom:16px"/><div style="font-size:18px;font-weight:600">Via Browser</div><div style="font-size:12px;color:var(--fg-muted);margin-top:8px">Windows · Native Shell</div><div style="font-size:11px;color:var(--fg-dim);margin-top:4px">' + BUILD_ID + '</div></div>'; }) },
  { id: "print", label: "Print", icon: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>', action: () => { if (activeId && activeId > 0) invoke("eval_tab", { id: activeId, js: "window.print()" }).catch(() => {}); else showToast("Open a page first"); } },
  { id: "share2", label: "Copy URL", icon: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4"/>', action: () => { const t = tabs.find(x => x.id === activeId); if (t?.url) navigator.clipboard.writeText(t.url).then(() => showToast("Copied")); else showToast("No URL"); } },
  { id: "export", label: "Export data", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/>', action: () => invoke<string>("export_backup").then(p => showToast("Exported: " + p.split(/[/\\]/).pop())).catch(() => showToast("Failed")) },
  { id: "import", label: "Import data", icon: '<polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', action: async () => { try { await invoke("import_latest_backup"); settings = await invoke<Settings>("get_settings"); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []); historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []); downloads = await invoke<DlItem[]>("list_downloads").catch(() => []); showToast("Imported"); } catch { showToast("No backup found"); } } },
  { id: "customize", label: "Customize", icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="20" y1="21" x2="20" y2="16"/>', action: () => openPanel("Customize menu", renderCustomize) },
];
function menuOrder(): string[] {
  const o = settings?.toolbar_layout?.visible;
  if (o?.length) { const v = o.filter(id => MENU.some(m => m.id === id)); const m = MENU.map(x => x.id).filter(id => !v.includes(id)); return [...v, ...m]; }
  return MENU.map(m => m.id);
}

/* ═══════ TAB MANAGEMENT ═══════ */

function showOnlyWebview(id: number) {
  debugLog(`[TAB] showOnlyWebview target=${id}`);
  for (const t of tabs) {
    if (t.id === id && t.id > 0) {
      invoke("show_tab", { id: t.id }).catch(e => debugLog(`[TAB] show_tab ERR ${t.id}: ${e}`));
    } else if (t.id > 0 && t.id !== id) {
      invoke("hide_tab", { id: t.id }).catch(() => {});
    }
  }
}

async function createTab(url?: string): Promise<Tab> {
  debugLog(`[TAB] createTab url=${url ?? '(newtab)'} activeId=${activeId} tabs=${tabs.length}`);
  try {
    const info = await invoke<TabInfo>("create_tab", { url: url || null });
    debugLog(`[TAB] create_tab OK id=${info.id}`);
    const tab: Tab = { id: info.id, url: info.url || "", title: info.title || "New Tab", active: true };
    tabs.push(tab);
    activeId = info.id;
    showOnlyWebview(info.id);
    updateTabCount();
    return tab;
  } catch (e) {
    debugLog(`[TAB] create_tab FAILED: ${e}`);
    showToast("Tab failed: " + String(e).slice(0, 60));
    throw e;
  }
}

async function closeTab(id: number) {
  debugLog(`[TAB] closeTab id=${id}`);
  const tab = tabs.find(t => t.id === id);
  if (tab && id > 0) {
    closedTabs.unshift({ url: tab.url, title: tab.title, ts: Date.now() });
    if (closedTabs.length > 50) closedTabs.length = 50;
    await invoke("push_closed_tab", { url: tab.url || "", title: tab.title }).catch(() => {});
  }
  if (id > 0) await invoke("close_tab", { id }).catch(() => {});
  tabs = tabs.filter(t => t.id !== id);
  if (activeId === id) {
    if (tabs.length) await switchTab(tabs[tabs.length - 1].id);
    else activeId = null;
  }
  updateTabCount();
}

async function switchTab(id: number) {
  debugLog(`[TAB] switchTab id=${id}`);
  tabs.forEach(t => t.active = false);
  const tab = tabs.find(t => t.id === id);
  if (tab) tab.active = true;
  activeId = id;
  if (id > 0) showOnlyWebview(id);
  updateTabCount();
}

async function openUrl(url: string): Promise<void> {
  debugLog(`[NAV] openUrl url="${url}" activeId=${activeId}`);
  if (activeId && activeId > 0) {
    const tab = tabs.find(t => t.id === activeId);
    if (tab) tab.url = url;
    await invoke("navigate_tab", { id: activeId, url }).catch(e => debugLog(`[NAV] ERR: ${e}`));
    showOnlyWebview(activeId);
    invoke("add_history", { url, title: url }).catch(() => {});
  } else if (defaultTabId) {
    const tab = tabs.find(t => t.id === defaultTabId);
    if (tab) { tab.url = url; tab.title = url; }
    activeId = defaultTabId;
    await invoke("navigate_tab", { id: defaultTabId, url }).catch(e => debugLog(`[NAV] ERR: ${e}`));
    showOnlyWebview(defaultTabId);
    invoke("add_history", { url, title: url }).catch(() => {});
    updateTabCount();
  } else {
    await createTab(url);
    invoke("add_history", { url, title: url }).catch(() => {});
  }
}

async function goHome() {
  debugLog(`[HOME] goHome activeId=${activeId} defaultTabId=${defaultTabId}`);
  if (defaultTabId && tabs.find(t => t.id === defaultTabId)) {
    const tab = tabs.find(t => t.id === defaultTabId);
    if (tab) { tab.url = ""; tab.title = "New Tab"; }
    activeId = defaultTabId;
    await invoke("navigate_to_newtab", { id: defaultTabId }).catch(e => debugLog(`[HOME] ERR: ${e}`));
    showOnlyWebview(defaultTabId);
    updateTabCount();
  } else {
    const tab = await createTab();
    defaultTabId = tab.id;
  }
}

function updateTabCount() {
  const count = tabs.length || 1;
  // Update overlay via Rust IPC
  try {
    const overlay = (window as any).__TAURI__?.webview?.Webview?.getByLabel?.("nav-overlay");
    if (overlay) overlay.eval(`if(window.__updateTabCount)window.__updateTabCount(${count});`);
  } catch {}
}

/* ═══════ SEARCH ═══════ */
function handleSearch() {
  const input = $("home-input") as HTMLInputElement;
  const val = input.value.trim();
  if (!val) return;
  input.value = "";
  debugLog(`[SEARCH] query="${val}"`);
  let url: string;
  if (/^https?:\/\//i.test(val) || /^localhost/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}/.test(val) || (val.includes('.') && !val.includes(' ')))
    url = /^https?:\/\//i.test(val) || /^localhost/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}/.test(val) ? val : "https://" + val;
  else
    url = (ENGINES[searchEngine] || ENGINES.Google) + encodeURIComponent(val);
  openUrl(url).catch(e => showToast("Nav failed: " + String(e).slice(0, 60)));
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
function openMenu() { menuOpen = true; buildMenu(); $("side-menu").classList.add("open"); $("menu-backdrop").classList.add("open"); }
function closeMenu() { menuOpen = false; $("side-menu").classList.remove("open"); $("menu-backdrop").classList.remove("open"); }

/* ═══════ PANEL ═══════ */
function openPanel(title: string, fn: (b: HTMLElement) => void) {
  $("panel-title").textContent = title; const b = $("panel-body"); b.innerHTML = ""; fn(b);
  $("panel").classList.add("open"); $("panel-backdrop").classList.add("open");
}
function closePanel() { $("panel").classList.remove("open"); $("panel-backdrop").classList.remove("open"); }

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
  b.querySelectorAll("[data-dr]").forEach(el => el.addEventListener("click", () => { closePanel(); openUrl(el.getAttribute("data-dr")!); }));
}
function renderScriptsRoot(b: HTMLElement) {
  b.innerHTML = '<div class="mg-list"><button class="mg-item" data-sr="store"><div>📦</div><div>Script store</div><div class="chev">›</div></button><button class="mg-item" data-sr="local"><div>📝</div><div>My scripts</div><div class="chev">›</div></button></div>';
  b.querySelectorAll("[data-sr]").forEach(el => el.addEventListener("click", () => { const t = el.getAttribute("data-sr"); if (t === "store") openPanel("Script store", renderScriptStore); else openPanel("My scripts", renderMyScripts); }));
}
function renderScriptStore(b: HTMLElement) {
  b.innerHTML = '<div class="script-store-item"><div class="script-store-name">AdGuard Annoyances</div><div class="script-store-desc">Blocks annoying elements.</div><div class="script-store-actions"><button id="ss-install">Install</button></div></div>';
  b.querySelector("#ss-install")?.addEventListener("click", async () => { await invoke("save_script", { id: "adguard", name: "AdGuard Annoyances", match_urls: "", code: "document.querySelectorAll('.cookie-notice').forEach(e=>e.remove());", enabled: true }); showToast("Installed"); });
}
function renderMyScripts(b: HTMLElement) {
  invoke<{ id: string; name: string; match_urls: string; code: string; enabled: boolean }[]>("list_scripts").then(scripts => {
    if (!scripts.length) { b.innerHTML = '<div class="empty-state">No scripts yet</div>'; return; }
    b.innerHTML = scripts.map(s => `<div class="script-store-item"><div class="script-store-name">${esc(s.name)} ${s.enabled ? '✅' : '⏸'}</div><div class="script-store-desc">${esc(s.match_urls || 'All pages')}</div><div class="script-store-actions"><button data-se="${s.id}">${s.enabled ? 'Disable' : 'Enable'}</button><button data-sd="${s.id}">Delete</button></div></div>`).join("");
    b.querySelectorAll("[data-se]").forEach(el => el.addEventListener("click", async () => { const id = el.getAttribute("data-se")!; const s = scripts.find(x => x.id === id); if (s) { s.enabled = !s.enabled; await invoke("save_script", s); renderMyScripts(b); } }));
    b.querySelectorAll("[data-sd]").forEach(el => el.addEventListener("click", async () => { await invoke("delete_script", { id: el.getAttribute("data-sd") }); renderMyScripts(b); }));
  });
}
function renderSiteConfig(b: HTMLElement) {
  invoke<{ host: string; ua_mode: string; adblock_enabled: boolean }[]>("list_site_configs").then(configs => {
    b.innerHTML = (configs.length ? configs.map(c => `<div class="pp-item"><div class="pi-info"><div class="pi-title">${esc(c.host)}</div><div class="pi-sub">UA: ${esc(c.ua_mode || 'Default')}</div></div></div>`).join("") : '<div class="empty-state">No site configs</div>') + '<div style="padding:16px"><button class="btn" id="add-sc">Add current site</button></div>';
    b.querySelector("#add-sc")?.addEventListener("click", async () => { const t = tabs.find(x => x.id === activeId); if (!t?.url) { showToast("Open a page first"); return; } try { const u = new URL(t.url); await invoke("save_site_config", { host: u.hostname, ua_mode: "", adblock_enabled: true }); showToast("Saved"); renderSiteConfig(b); } catch {} });
  });
}
function renderCookies(b: HTMLElement) {
  invoke<string>("get_cookies").then(c => { b.innerHTML = `<div style="padding:16px;white-space:pre-wrap;font-size:12px;color:var(--fg-muted)">${esc(c || 'No cookies')}</div><div style="padding:0 16px"><button class="btn" id="clr-cookies">Clear cookies</button></div>`; b.querySelector("#clr-cookies")?.addEventListener("click", async () => { await invoke("clear_cookies"); showToast("Cleared"); renderCookies(b); }); });
}
function renderCustomize(b: HTMLElement) {
  const order = settings?.toolbar_layout?.visible || menuOrder();
  b.innerHTML = '<div class="drag-list">' + order.map(id => { const m = MENU.find(x => x.id === id); return m ? `<div class="drag-item" data-mi="${id}"><span class="drag-handle">⠿</span><span class="drag-label">${m.label}</span></div>` : ''; }).join("") + '</div>';
}
function renderSettings(b: HTMLElement) {
  b.innerHTML = `
    <div class="mg-list">
      <div class="field"><label>Homepage</label><input id="s-home" value="${esc(settings?.homepage || '')}"/></div>
      <div class="field"><label>Search engine</label><select id="s-engine">${Object.keys(ENGINES).map(e => `<option${e === searchEngine ? ' selected' : ''}>${e}</option>`).join("")}</select></div>
      <div class="field"><label>User Agent</label><select id="s-ua"><option value="">Default</option><option value="Desktop"${settings?.ua_mode === 'Desktop' ? ' selected' : ''}>Desktop</option><option value="Mobile"${settings?.ua_mode === 'Mobile' ? ' selected' : ''}>Mobile</option></select></div>
      <div class="field"><label>Text size</label><input id="s-ts" type="range" min="0.5" max="3" step="0.1" value="${settings?.text_size || 1}"/></div>
      <button class="btn" id="s-clear">Clear browsing data</button>
    </div>`;
  b.querySelector("#s-home")?.addEventListener("change", (e) => { if (settings) settings.homepage = (e.target as HTMLInputElement).value; persistSettings(); });
  b.querySelector("#s-engine")?.addEventListener("change", (e) => { searchEngine = (e.target as HTMLSelectElement).value; if (settings) settings.search_engine = searchEngine; persistSettings(); });
  b.querySelector("#s-ua")?.addEventListener("change", (e) => { if (settings) settings.ua_mode = (e.target as HTMLSelectElement).value; persistSettings(); });
  b.querySelector("#s-ts")?.addEventListener("input", (e) => { textSize = parseFloat((e.target as HTMLInputElement).value); if (settings) settings.text_size = textSize; persistSettings(); });
  b.querySelector("#s-clear")?.addEventListener("click", async () => { await invoke("clear_data"); showToast("Cleared"); });
}

/* ═══════ SETTINGS PERSISTENCE ═══════ */
function persistSettings() {
  if (!settings) return;
  settings.night_mode = nightMode; settings.desktop_mode = desktopMode;
  settings.text_size = textSize; settings.show_images = showImages;
  settings.adblock_enabled = adblockOn; settings.search_engine = searchEngine;
  invoke("set_settings", { settings }).catch(() => {});
  try { localStorage.setItem('via-settings', JSON.stringify({ search_engine: searchEngine })); } catch {}
}

/* ═══════ SESSION ═══════ */
function saveSession() {
  if (!restoreTabs || !tabs.length) return;
  const entries = tabs.filter(t => t.url).map((t, i) => ({ url: t.url, title: t.title, active: t.id === activeId, order: i }));
  invoke("save_session", { entries }).catch(() => {});
}

/* ═══════ TABS PANEL ═══════ */
function renderTabs(b: HTMLElement) {
  if (!tabs.length) {
    b.innerHTML = '<div class="empty-state">No open tabs</div><div style="padding:16px"><button class="btn primary" id="ntb">+ New Tab</button></div>';
    b.querySelector("#ntb")?.addEventListener("click", () => { closePanel(); createTab(); });
    return;
  }
  b.innerHTML = '<div class="pp-list">' + tabs.map(t => `<div class="pp-item${t.id === activeId ? ' selected' : ''}" data-t="${t.id}"><div class="pi-icon">${t.id === activeId ? "▶" : "◻"}</div><div class="pi-info"><div class="pi-title">${esc(t.title || "New Tab")}</div><div class="pi-sub">${esc(t.url || "newtab")}</div></div><button class="pi-action" data-ct="${t.id}">✕</button></div>`).join("") + '</div><div style="padding:16px"><button class="btn primary" id="ntb">+ New Tab</button></div>';
  b.querySelector("#ntb")?.addEventListener("click", () => { closePanel(); createTab(); });
  b.querySelectorAll(".pp-item[data-t]").forEach(el => el.addEventListener("click", e => { if ((e.target as HTMLElement).closest("[data-ct]")) return; closePanel(); switchTab(parseInt(el.getAttribute("data-t")!)); }));
  b.querySelectorAll("[data-ct]").forEach(el => el.addEventListener("click", async e => { e.stopPropagation(); await closeTab(parseInt(el.getAttribute("data-ct")!)); renderTabs(b); }));
}

/* ═══════ EVENTS (registered ONCE) ═══════ */
function setupEvents() {
  // Tab URL/title updates from native page load
  listen<{ id: number; url: string }>("tab-url", ev => {
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) tab.url = ev.payload.url;
  });
  listen<{ id: number; title: string }>("tab-title", ev => {
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) tab.title = ev.payload.title;
  });
  // Navigation actions from native shell overlay
  listen<string>("nav-action", ev => {
    const action = ev.payload;
    debugLog(`[NAV-ACTION] action="${action}"`);
    if (action === "tabs") {
      openPanel("Tabs (" + tabs.length + ")", renderTabs);
    }
    // "home" and "menu" are now handled natively by shell.rs
  });
  // Menu actions from the menu overlay
  listen<string>("menu-action", ev => {
    const action = ev.payload;
    debugLog(`[MENU-ACTION] action="${action}"`);
    if (action === "bookmarks") {
      openPanel("Bookmarks", renderBookmarks);
    } else if (action === "history") {
      openPanel("History", renderHistory);
    } else if (action === "downloads") {
      refreshDownloads();
      openPanel("Downloads", renderDownloads);
    } else if (action === "night") {
      nightMode = !nightMode;
      persistSettings();
      showToast(nightMode ? "Night on" : "Night off");
    } else if (action === "desktop") {
      desktopMode = !desktopMode;
      persistSettings();
      showToast(desktopMode ? "Desktop UA" : "Mobile UA");
    } else if (action === "find") {
      if (activeId) {
        invoke("eval_tab", { id: activeId, js: "window.__viaSend('findInPage',{})" });
      }
    } else if (action === "refresh") {
      if (activeId) {
        invoke("eval_tab", { id: activeId, js: "location.reload()" });
      }
    } else if (action === "scripts") {
      openPanel("Scripts", renderScriptsRoot);
    } else if (action === "siteconfig") {
      openPanel("Site configuration", renderSiteConfig);
    } else if (action === "reader") {
      if (activeId) {
        invoke("reader_bundle").then(bundle => {
          invoke("eval_tab", { id: activeId, js: bundle });
        });
      }
    } else if (action === "incognito") {
      incognitoMode = !incognitoMode;
      persistSettings();
      showToast(incognitoMode ? "Incognito on" : "Incognito off");
    } else if (action === "images") {
      showImages = !showImages;
      persistSettings();
      showToast(showImages ? "Images on" : "Images off");
      if (activeId) {
        const css = showImages
          ? "document.querySelectorAll('[data-via-img-hide]').forEach(e=>e.remove())"
          : "var s=document.createElement('style');s.setAttribute('data-via-img-hide','1');s.textContent='img,video,picture{visibility:hidden!important}';document.head.appendChild(s)";
        invoke("eval_tab", { id: activeId, js: css });
      }
    } else if (action === "ua") {
      openPanel("User Agent", renderUA);
    } else if (action === "save") {
      if (activeId) {
        invoke("eval_tab", { id: activeId, js: "window.__viaSend('savePage',{})" }).then(() => {
          showToast("Page saved");
        });
      }
    } else if (action === "share") {
      if (activeId) {
        invoke("get_tab_url", { id: activeId }).then(url => {
          if (url) { navigator.clipboard.writeText(url); showToast("URL copied"); }
        });
      }
    } else if (action === "exit") {
      window.close();
    } else if (action === "log") {
      openPanel("Network log", renderNetworkLog);
    } else if (action === "blocklist") {
      openPanel("Block list", renderBlocklist);
    }
  });
  // Download events
  listen<any>("download-started", ev => {
    const d = ev.payload;
    showDlNotification("Download started", d.path?.split(/[/\\]/).pop() || "file", 0);
  });
  listen<any>("download-progress", ev => {
    const d = ev.payload;
    updateDlNotification(d.path?.split(/[/\\]/).pop() || "file", d.progress || 0);
  });
  listen<any>("download-finished", ev => {
    showDlNotification("Download complete", ev.payload.path?.split(/[/\\]/).pop() || "file", 100);
    refreshDownloads();
  });
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

/* ═══════ KEYBOARD (registered ONCE) ═══════ */
function setupKeyboard() {
  window.addEventListener("keydown", e => {
    const c = e.ctrlKey || e.metaKey;
    if (c && e.key === "t") { e.preventDefault(); createTab(); }
    else if (c && e.key === "w") { e.preventDefault(); if (activeId) closeTab(activeId); }
    else if (c && e.shiftKey && (e.key === "T" || e.key === "t")) { e.preventDefault(); const ct = closedTabs.shift(); if (ct) createTab(ct.url || undefined); else showToast("No closed tabs"); }
    else if (c && e.key === "l") {
      e.preventDefault();
      const input = $("home-input") as HTMLInputElement;
      input.value = tabs.find(x => x.id === activeId)?.url || "";
      input.focus(); input.select();
    }
    else if (c && e.key === "b") { e.preventDefault(); const t = tabs.find(x => x.id === activeId); if (t?.url) { invoke("add_bookmark", { url: t.url, title: t.title || t.url, folder: null }).then(() => { bookmarks.push({ url: t.url, title: t.title || t.url, folder: "" }); showToast("Bookmarked"); }); } }
    else if (c && e.key === "h") { e.preventDefault(); openPanel("History", renderHistory); }
    else if (e.key === "F11") { e.preventDefault(); const w = (window as any).__TAURI__?.window?.appWindow; if (w) w.isFullscreen().then((f: boolean) => w.setFullscreen(!f)); }
  });
}

/* ═══════ MENU PANEL RENDERERS ═══════ */
function renderUA(b: HTMLElement) {
  b.innerHTML = `
    <div class="sec-title">User Agent</div>
    <div class="field"><label>Current mode</label><select id="ua-select">
      <option value="">Default</option>
      <option value="Desktop"${settings?.ua_mode === 'Desktop' ? ' selected' : ''}>Desktop (Chrome)</option>
      <option value="Mobile"${settings?.ua_mode === 'Mobile' ? ' selected' : ''}>Mobile (Chrome)</option>
      <option value="Via"${settings?.ua_mode === 'Via' ? ' selected' : ''}>Via Browser</option>
      <option value="Custom"${settings?.ua_mode === 'Custom' ? ' selected' : ''}>Custom</option>
    </select></div>
    <div class="field" id="ua-custom-wrap" style="${settings?.ua_mode === 'Custom' ? '' : 'display:none'}"><label>Custom User Agent</label><input id="ua-custom" value="${esc(settings?.custom_ua || '')}" placeholder="Enter custom user agent"/></div>
    <button class="btn primary" id="ua-save">Save</button>`;
  const sel = b.querySelector('#ua-select') as HTMLSelectElement;
  const wrap = b.querySelector('#ua-custom-wrap') as HTMLElement;
  sel.addEventListener('change', () => { wrap.style.display = sel.value === 'Custom' ? '' : 'none'; });
  b.querySelector('#ua-save')?.addEventListener('click', async () => {
    if (!settings) return;
    settings.ua_mode = sel.value;
    settings.custom_ua = (b.querySelector('#ua-custom') as HTMLInputElement)?.value || '';
    await persistSettings();
    showToast("User agent updated");
  });
}

function renderNetworkLog(b: HTMLElement) {
  b.innerHTML = '<div class="empty-state">Network log captures requests via the resource sniffer.<br>Enable it in Settings → Network log.</div>';
  invoke<{ url: string; title: string; ts: number }[]>("list_history", { q: null }).then(items => {
    if (!items || items.length === 0) return;
    b.innerHTML = '<div class="sec-title">Recent requests</div>' + items.slice(0, 50).map(h =>
      `<div class="dl-item"><div class="dl-name">${esc(h.title || h.url)}</div><div class="dl-meta">${esc(h.url)}</div></div>`
    ).join('');
  });
}

function renderBlocklist(b: HTMLElement) {
  b.innerHTML = '<div class="sec-title">Ad blocker filter rules</div><div class="empty-state">Filter rules are loaded from the built-in list.<br>Use "Mark as ad" from the menu to add custom rules.</div>';
  invoke<string[]>("list_marked_ads").then(rules => {
    if (!rules || rules.length === 0) return;
    b.innerHTML = '<div class="sec-title">Custom rules</div>' + rules.map((r, i) =>
      `<div class="dl-item"><div class="dl-name">${esc(r)}</div><div class="dl-actions"><button data-idx="${i}">Remove</button></div></div>`
    ).join('');
    b.querySelectorAll('.dl-actions button').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.getAttribute('data-idx') || '0');
        await invoke("remove_marked_ad", { index: idx });
        showToast("Rule removed");
        renderBlocklist(b);
      });
    });
  });
}

/* ═══════ BOOT ═══════ */
async function boot() {
  debugLog("[BOOT] Starting build=" + BUILD_ID);

  settings = await invoke<Settings>("get_settings").catch(() => null);
  if (settings) {
    searchEngine = settings.search_engine || "Google";
    nightMode = settings.night_mode; desktopMode = settings.desktop_mode;
    textSize = settings.text_size || 1; showImages = settings.show_images !== false;
    adblockOn = settings.adblock_enabled !== false; restoreTabs = settings.restore_tabs || false;
    try { localStorage.setItem('via-settings', JSON.stringify({ search_engine: searchEngine })); } catch {}
  }
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
  historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []);
  downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);

  setupEvents();
  setupKeyboard();

  // Search bar (on main webview homepage)
  $("home-search").addEventListener("click", e => { e.stopPropagation(); ($("home-input") as HTMLInputElement).focus(); });
  $("home-input").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); handleSearch(); } e.stopPropagation(); });

  // Menu / Panel
  $("menu-backdrop").addEventListener("click", closeMenu);
  $("menu-exit").addEventListener("click", () => { closeMenu(); closePanel(); });
  $("menu-collapse").addEventListener("click", closeMenu);
  $("panel-back").addEventListener("click", closePanel);
  $("panel-backdrop").addEventListener("click", closePanel);

  window.addEventListener("beforeunload", () => saveSession());

  // Restore session or create default tab
  let sessionRestored = false;
  if (restoreTabs) {
    try {
      const saved = await invoke<SessionEntry[]>("restore_session");
      if (saved && saved.length > 0) {
        debugLog(`[BOOT] Restoring ${saved.length} tabs from session`);
        for (const entry of saved) {
          const url = entry.url && entry.url !== "about:blank" ? entry.url : undefined;
          const info = await invoke<TabInfo>("create_tab", { url: url || null });
          const tab: Tab = { id: info.id, url: url || "", title: entry.title || "New Tab", active: false };
          tabs.push(tab);
        }
        // Activate the tab that was active
        const activeEntry = saved.find(s => s.active) || saved[0];
        const activeTab = tabs.find(t => t.url === activeEntry.url) || tabs[0];
        if (activeTab) {
          activeId = activeTab.id;
          await invoke("show_tab", { id: activeTab.id });
          showOnlyWebview(activeTab.id);
        }
        defaultTabId = tabs[0].id;
        sessionRestored = true;
        updateTabCount();
        $("home").classList.add("hidden");
        debugLog(`[BOOT] Session restored: ${tabs.length} tabs, active=${activeId}`);
      }
    } catch (e) {
      debugLog(`[BOOT] Session restore failed: ${e}`);
    }
  }
  if (!sessionRestored) {
    debugLog("[BOOT] Creating default tab");
    try {
      const info = await invoke<TabInfo>("create_tab", { url: null });
      debugLog(`[BOOT] Default tab id=${info.id}`);
      const tab: Tab = { id: info.id, url: "", title: "New Tab", active: true };
      tabs.push(tab);
      activeId = info.id;
      defaultTabId = info.id;
      showOnlyWebview(info.id);
      updateTabCount();
      $("home").classList.add("hidden");
      debugLog(`[BOOT] Done tabs=${tabs.length} active=${activeId}`);
    } catch (e) {
      debugLog(`[BOOT] Failed: ${e}`);
      $("home").classList.remove("hidden");
    }
  }
}

boot();
