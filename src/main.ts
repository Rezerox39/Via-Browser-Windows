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
const ENGINES: Record<string, string> = { Google: "https://www.google.com/search?q=", DuckDuckGo: "https://duckduckgo.com/?q=", Bing: "https://www.bing.com/search?q=", Baidu: "https://www.baidu.com/s?wd=" };

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
let menuPage = 0;
const MENU_PAGE_SIZE = 12;
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
  { id: "reader", label: "Reader mode", icon: '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>', action: () => { if (!activeId) { showToast("Open a page first"); return; } invoke<string>("reader_bundle").then(js => invoke("eval_tab", { id: activeId!, js })).then(() => showToast("Reader on")).catch(() => showToast("Reader failed")); } },
  { id: "qr", label: "QR scanner", icon: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>', action: async () => { try { const t = await invoke<string>("qr_pick_and_scan"); if (t && confirm("QR: " + t + "\nOpen?")) openUrl(/^https?:\/\//i.test(t) ? t : "https://www.google.com/search?q=" + encodeURIComponent(t)); } catch { showToast("QR cancelled"); } } },
  { id: "find", label: "Find on page", icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', action: () => { if (!activeId) { showToast("Open a page first"); return; } const q = prompt("Find:"); if (q) invoke("eval_tab", { id: activeId, js: `window.find(${JSON.stringify(q)})` }).catch(() => {}); } },
  { id: "fullscreen", label: "Full screen", icon: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>', action: () => { const w = (window as any).__TAURI__?.window?.appWindow; if (w) w.isFullscreen().then((f: boolean) => w.setFullscreen(!f)); else if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } },
  { id: "share", label: "Share link", icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>', action: () => { const t = tabs.find(x => x.id === activeId); if (t?.url) navigator.clipboard.writeText(t.url).then(() => showToast("Copied")).catch(() => {}); else showToast("No URL"); } },
  { id: "addbm", label: "Add bookmark", icon: '<path d="M12 5v14M5 12h14"/>', action: async () => { const t = tabs.find(x => x.id === activeId); if (!t?.url) { showToast("Open a page first"); return; } await invoke("add_bookmark", { url: t.url, title: t.title || t.url, folder: null }); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => bookmarks); showToast("Added"); refreshMenu(); } },
  { id: "adsb", label: "Ad blocking", icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', action: () => { adblockOn = !adblockOn; persistSettings(); showToast(adblockOn ? "Ads blocked" : "Ads unblocked"); refreshMenu(); }, active: () => adblockOn },
  { id: "tracker", label: "No-tracking", icon: '<path d="M18 11V7a6 6 0 00-12 0v4"/><path d="M14 21v-4a2 2 0 00-4 0v4"/>', action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "navigator.doNotTrack='1'" }).then(() => showToast("DNT set")).catch(() => showToast("Not supported")); else showToast("Open a page first"); } },
  { id: "images", label: "Show images", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>', action: () => { showImages = !showImages; persistSettings(); if (activeId) { const js = showImages ? "document.querySelectorAll('img[data-v-i]').forEach(i=>{i.style.display='';i.removeAttribute('data-v-i')})" : "document.querySelectorAll('img').forEach(i=>{i.setAttribute('data-v-i','1');i.style.display='none'})"; invoke("eval_tab", { id: activeId, js }).catch(() => {}); } showToast(showImages ? "Images on" : "Images off"); refreshMenu(); }, active: () => showImages },
  { id: "scripts", label: "Scripts", icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', action: () => openPanel("Scripts", renderScriptsRoot) },
  { id: "siteconfig", label: "Site config", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>', action: () => openPanel("Site config", renderSiteConfig) },
  { id: "cookies", label: "Cookies", icon: '<path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><circle cx="12" cy="12" r="2"/>', action: () => openPanel("Cookies", renderCookies) },
  { id: "customize", label: "Customize", icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="20" y1="21" x2="20" y2="16"/>', action: () => openPanel("Customize menu", renderCustomize) },
  { id: "settings", label: "Settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/>', action: () => openPanel("Settings", renderSettings) },
  { id: "about", label: "About", icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', action: () => openPanel("About", b => { b.innerHTML = '<div style="text-align:center;padding:48px 16px"><img src="/via-logo.svg" style="width:72px;margin-bottom:16px"/><div style="font-size:18px;font-weight:600">Via Browser</div><div style="font-size:12px;color:var(--fg-muted);margin-top:8px">Windows · Tauri + WebView2</div></div>'; }) },
  { id: "incognito", label: "Incognito", icon: '<path d="M17 8h1a4 4 0 110 8h-1"/><path d="M3 8h14v8H3z"/>', action: () => { incognitoMode = !incognitoMode; showToast(incognitoMode ? "Incognito on" : "Incognito off"); refreshMenu(); }, active: () => incognitoMode },
  { id: "print", label: "Print", icon: '<polyline points="6 9 6 2 18 2 18 9"/><rect x="6" y="14" width="12" height="8"/>', action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "window.print()" }).then(() => showToast("Print dialog")).catch(() => showToast("Unavailable")); else showToast("Open a page first"); } },
  { id: "addhome", label: "Add to home", icon: '<path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/>', action: async () => { const t = tabs.find(x => x.id === activeId); if (!t?.url) { showToast("Open a page first"); return; } const l = prompt("Label:", t.title || ""); if (!l) return; const sc: HomeShortcut[] = settings?.homepage_shortcuts || []; sc.push({ label: l, url: t.url, icon: "🌐" }); await invoke("save_homepage_shortcuts", { shortcuts: sc }).catch(() => {}); showToast("Added"); } },
  { id: "pageinfo", label: "Page info", icon: '<circle cx="12" cy="12" r="10"/><path d="M12 8h.01"/><path d="M11 12h1v4h1"/>', action: () => { const t = tabs.find(x => x.id === activeId); if (t) alert("Title: " + (t.title || "(none)") + "\nURL: " + (t.url || "(none)")); else showToast("Open a page first"); } },
  { id: "zoom", label: "Zoom", icon: '<circle cx="11" cy="11" r="4"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', action: () => { if (!activeId) { showToast("Open a page first"); return; } const z = prompt("Zoom (50-200%):", String(Math.round(textSize * 100))); if (!z) return; const v = Math.max(0.5, Math.min(2, parseInt(z) / 100)); if (isNaN(v)) return; textSize = v; if (settings) settings.text_size = v; persistSettings(); invoke("eval_tab", { id: activeId, js: `document.body.style.zoom='${v}'` }).catch(() => {}); showToast("Zoom: " + Math.round(v * 100) + "%"); } },
  { id: "savepage", label: "Save page", icon: '<path d="M23 4v6h-6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/>', action: async () => { const t = tabs.find(x => x.id === activeId); if (!t) { showToast("Open a page first"); return; } try { await invoke("eval_tab", { id: t.id, js: "window.__vh=document.documentElement.outerHTML" }); const h = await invoke<string>("eval_tab", { id: t.id, js: "window.__vh||''" }); if (h) { await invoke("save_page", { url: t.url, html: h, title: t.title || "page" }); showToast("Saved"); } } catch { showToast("Save failed"); } } },
  { id: "copyurl", label: "Copy URL", icon: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4"/>', action: () => { const t = tabs.find(x => x.id === activeId); if (t?.url) navigator.clipboard.writeText(t.url).then(() => showToast("Copied")); else showToast("No URL"); } },
  { id: "export", label: "Export data", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/>', action: () => invoke<string>("export_backup").then(p => showToast("Exported: " + p.split(/[/\\]/).pop())).catch(() => showToast("Failed")) },
  { id: "import", label: "Import data", icon: '<polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', action: async () => { try { await invoke("import_latest_backup"); settings = await invoke<Settings>("get_settings"); bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []); historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []); downloads = await invoke<DlItem[]>("list_downloads").catch(() => []); showToast("Imported"); } catch { showToast("No backup found"); } } },
];
function menuOrder(): string[] {
  const o = settings?.toolbar_layout?.visible;
  if (o?.length) { const v = o.filter(id => MENU.some(m => m.id === id)); const m = MENU.map(x => x.id).filter(id => !v.includes(id)); return [...v, ...m]; }
  return MENU.map(m => m.id);
}

/* ═══════ TABS — REAL WEBVIEWS ═══════ */

/** Show ONLY the given tab's webview. Hide all others. */
function showOnlyWebview(id: number) {
  log("showOnlyWebview", id);
  for (const t of tabs) {
    if (t.id === id) invoke("show_tab", { id: t.id }).catch(e => log("show_tab error", e));
    else invoke("hide_tab", { id: t.id }).catch(() => {});
  }
}

/** Hide ALL tab webviews. */
function hideAllWebviews() {
  for (const t of tabs) invoke("hide_tab", { id: t.id }).catch(() => {});
}

function showHomePage() {
  log("showHomePage");
  $("home").classList.remove("hidden");
  hideAllWebviews();
}
function hideHomePage() {
  $("home").classList.add("hidden");
}

function createTab(url?: string): Promise<Tab> {
  log("createTab url=", url, "tabs before=", tabs.length, "activeId before=", activeId);
  return invoke<TabInfo>("create_tab", { url: url || null }).then(info => {
    const tab: Tab = { id: info.id, url: url || "", title: "New Tab", active: true };
    tabs.push(tab);
    activeId = info.id;
    log("created tab", info.id, "webview label", "tab-" + info.id, "tabs after=", tabs.length, "activeId after=", activeId);
    if (url) {
      // Navigate the webview to the URL
      invoke("navigate_tab", { id: info.id, url }).catch(e => log("navigate_tab failed", e));
      // Show only this webview, hide homepage
      showOnlyWebview(info.id);
      hideHomePage();
    } else {
      // Empty tab — show the homepage, hide all webviews
      showHomePage();
    }
    updateTabCount();
    return tab;
  });
}

async function closeTab(id: number) {
  log("closeTab", id);
  const tab = tabs.find(t => t.id === id);
  if (tab) await invoke("push_closed_tab", { url: tab.url || "about:blank", title: tab.title }).catch(() => {});
  await invoke("close_tab", { id }).catch(() => {});
  tabs = tabs.filter(t => t.id !== id);
  if (activeId === id) {
    if (tabs.length) {
      const last = tabs[tabs.length - 1];
      log("restoring to tab", last.id);
      await switchTab(last.id);
    } else {
      activeId = null;
      log("last tab closed, showing homepage");
      showHomePage();
    }
  }
  updateTabCount();
}

async function switchTab(id: number) {
  log("switchTab", id);
  tabs.forEach(t => t.active = false);
  const tab = tabs.find(t => t.id === id);
  if (tab) tab.active = true;
  activeId = id;
  await invoke("select_tab", { id }).catch(e => log("select_tab failed", e));
  // Show only this tab's webview, hide homepage
  showOnlyWebview(id);
  hideHomePage();
  updateNavButtons();
  updateTabCount();
}

function updateTabCount() { $("nav-tab-count").textContent = String(tabs.length || 1); }

/** Always enable back/forward — let the webview handle history state internally. */
function updateNavButtons() {
  $("nav-back").removeAttribute("disabled");
  $("nav-fwd").removeAttribute("disabled");
}

/* ═══════ SEARCH / NAVIGATION ═══════ */
function handleSearch() {
  const input = $("home-input") as HTMLInputElement;
  const val = input.value.trim();
  if (!val) return;
  input.value = "";
  log("search:", val);
  let url: string;
  if (/^https?:\/\//i.test(val) || /^localhost/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}/.test(val) || (val.includes('.') && !val.includes(' ')))
    url = /^https?:\/\//i.test(val) || /^localhost/i.test(val) || /^\d{1,3}(\.\d{1,3}){3}/.test(val) ? val : "https://" + val;
  else
    url = (ENGINES[searchEngine] || ENGINES.Google) + encodeURIComponent(val);
  openUrl(url);
}

async function openUrl(url: string) {
  log("openUrl", url);
  if (activeId) {
    await invoke("navigate_tab", { id: activeId, url }).catch(() => showToast("Nav failed"));
    showOnlyWebview(activeId);
    hideHomePage();
  } else {
    await createTab(url);
  }
}

function openSearch() {
  $("home").classList.remove("hidden");
  const input = $("home-input") as HTMLInputElement;
  if (activeId) { const tab = tabs.find(t => t.id === activeId); input.value = tab?.url || ""; } else input.value = "";
  input.focus(); input.select();
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
function refreshMenu() { buildMenu(); }
function openMenu() { buildMenu(); $("side-menu").classList.add("open"); $("menu-backdrop").classList.add("open"); }
function closeMenu() { $("side-menu").classList.remove("open"); $("menu-backdrop").classList.remove("open"); }

/* ═══════ PANEL ═══════ */
function openPanel(title: string, fn: (b: HTMLElement) => void) {
  $("panel-title").textContent = title; const b = $("panel-body"); b.innerHTML = ""; fn(b);
  $("panel-backdrop").classList.add("open"); $("panel").classList.add("open");
}
function closePanel() { $("panel-backdrop").classList.remove("open"); $("panel").classList.remove("open"); }

/* ═══════ PANEL RENDERERS ═══════ */
function renderBookmarks(b: HTMLElement) {
  if (!bookmarks.length) { b.innerHTML = '<div class="empty-state">No bookmarks yet</div>'; return; }
  b.innerHTML = '<div class="pp-list">' + bookmarks.map(x => `<div class="pp-item" data-u="${esc(x.url)}"><div class="pi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg></div><div class="pi-info"><div class="pi-title">${esc(x.title || x.url)}</div><div class="pi-sub">${esc(x.url)}</div></div><button class="pi-action" data-d="${esc(x.url)}">✕</button></div>`).join("") + "</div>";
  b.querySelectorAll(".pp-item").forEach(el => el.addEventListener("click", e => {
    if ((e.target as HTMLElement).closest("[data-d]")) { invoke("remove_bookmark", { url: el.getAttribute("data-d")! }).then(() => { bookmarks = bookmarks.filter(x => x.url !== el.getAttribute("data-d")!); renderBookmarks(b); showToast("Removed"); }); return; }
    closePanel(); openUrl(el.getAttribute("data-u")!);
  }));
}
function renderHistory(b: HTMLElement) {
  if (!historyItems.length) { b.innerHTML = '<div class="empty-state">No history</div>'; return; }
  const g: Record<string, HistItem[]> = {};
  historyItems.forEach(h => { const d = new Date(h.ts * 1000).toISOString().slice(0, 10); (g[d] = g[d] || []).push(h); });
  b.innerHTML = '<div style="padding:8px 16px"><button class="btn" id="chb">Clear</button></div>' + Object.entries(g).map(([d, items]) => `<div class="sec-title">${d}</div><div class="pp-list">${items.map(h => `<div class="pp-item" data-u="${esc(h.url)}"><div class="pi-info"><div class="pi-title">${esc(h.title || h.url)}</div><div class="pi-sub" style="color:var(--accent)">${esc(h.url)}</div></div></div>`).join("")}</div>`).join("");
  b.querySelector("#chb")?.addEventListener("click", async () => { await invoke("clear_history"); historyItems = []; renderHistory(b); showToast("Cleared"); });
  b.querySelectorAll(".pp-item").forEach(el => el.addEventListener("click", () => { closePanel(); openUrl(el.getAttribute("data-u")!); }));
}
function renderDownloads(b: HTMLElement) {
  if (!downloads.length) { b.innerHTML = '<div class="empty-state">No downloads yet</div>'; return; }
  b.innerHTML = downloads.map(d => `<div class="dl-item"><div class="dl-name">${esc(d.title)}</div><div class="dl-meta">${fmtSize(d.size)} ${d.done ? "✓ Done" : "Downloading…"}</div>${d.done ? `<div class="dl-actions"><button data-o="${esc(d.path)}">Open</button><button data-f="${esc(d.path)}">Folder</button></div>` : ""}</div>`).join("");
  b.querySelectorAll("[data-o]").forEach(el => el.addEventListener("click", () => invoke("open_download", { path: el.getAttribute("data-o")! })));
  b.querySelectorAll("[data-f]").forEach(el => el.addEventListener("click", () => invoke("reveal_download", { path: el.getAttribute("data-f")! })));
}
function renderScriptsRoot(b: HTMLElement) {
  b.innerHTML = `<div class="mg-list"><div class="mg-item" data-sc="m">My Scripts <span class="chev">›</span></div><div class="mg-item" data-sc="s">Script Store <span class="chev">›</span></div><div class="mg-item" data-sc="c">Script Settings <span class="chev">›</span></div></div>`;
  b.querySelector('[data-sc="m"]')?.addEventListener("click", () => openPanel("My Scripts", renderMyScripts));
  b.querySelector('[data-sc="s"]')?.addEventListener("click", () => openPanel("Script Store", renderScriptStore));
  b.querySelector('[data-sc="c"]')?.addEventListener("click", () => openPanel("Script Settings", b2 => { b2.innerHTML = '<div style="padding:16px"><button class="btn" id="sss">Search Greasy Fork</button></div>'; b2.querySelector("#sss")?.addEventListener("click", () => { const q = prompt("Search:"); if (q) openUrl("https://greasyfork.org/en/scripts?q=" + encodeURIComponent(q)); }); }));
}
function renderMyScripts(b: HTMLElement) {
  const sc = settings?.scripts || [];
  if (!sc.length) { b.innerHTML = '<div class="empty-state">No scripts</div><div style="padding:16px"><button class="btn primary" id="asb">+ Add</button></div>'; } else {
    b.innerHTML = '<div class="pp-list">' + sc.map(s => `<div class="pp-item"><div class="pi-info"><div class="pi-title">${esc(s.name)}</div><div class="pi-sub">${esc(s.match_urls || "All")}</div></div><button class="pi-action" data-ds="${esc(s.id)}">✕</button></div>`).join("") + '</div><div style="padding:16px"><button class="btn primary" id="asb">+ Add</button></div>';
    b.querySelectorAll("[data-ds]").forEach(el => el.addEventListener("click", async () => { await invoke("delete_script", { id: el.getAttribute("data-ds")! }); if (settings) settings.scripts = settings.scripts.filter(s => s.id !== el.getAttribute("data-ds")!); renderMyScripts(b); showToast("Deleted"); }));
  }
  b.querySelector("#asb")?.addEventListener("click", () => { const n = prompt("Name:"); if (!n) return; const mu = prompt("Match URLs (empty=all):") || ""; const c = prompt("Code:"); if (!c) return; const s: UserScript = { id: "s" + Date.now(), name: n, match_urls: mu, code: c, enabled: true }; if (!settings) settings = { ...({} as Settings), scripts: [] }; settings.scripts.push(s); invoke("save_script", { script: s }).then(() => { showToast("Saved"); renderMyScripts(b); }); });
}
const STORE = [{ name: "AdGuard Extra", url: "https://greasyfork.org/scripts/38972", desc: "Remove blocked elements" }, { name: "Dark Reader", url: "https://greasyfork.org/scripts/22190", desc: "Dark mode for all sites" }, { name: "Search Engine Jump", url: "https://greasyfork.org/scripts/426035", desc: "Jump between engines" }, { name: "Bilibili Evolved", url: "https://greasyfork.org/scripts/452100", desc: "Enhanced bilibili" }];
function renderScriptStore(b: HTMLElement) {
  const installed = new Set((settings?.scripts || []).map(s => s.name));
  b.innerHTML = STORE.map(s => `<div class="script-store-item"><div class="script-store-name">${esc(s.name)}</div><div class="script-store-desc">${esc(s.desc)}</div><div class="script-store-actions"><button class="${installed.has(s.name) ? 'installed' : ''}" data-i="${esc(s.name)}">${installed.has(s.name) ? "Installed ✓" : "Install"}</button></div></div>`).join("");
  b.querySelectorAll("[data-i]").forEach(el => el.addEventListener("click", () => { const s = STORE.find(x => x.name === el.getAttribute("data-i")!); if (!s) return; if (installed.has(s.name)) { openUrl(s.url); closePanel(); return; } const us: UserScript = { id: "s" + Date.now(), name: s.name, match_urls: "", code: "", enabled: true }; if (!settings) settings = { ...({} as Settings), scripts: [] }; settings.scripts.push(us); invoke("save_script", { script: us }).then(() => { showToast("Installed: " + s.name); renderScriptStore(b); openUrl(s.url); }); }));
}
function renderSiteConfig(b: HTMLElement) {
  const sites = settings?.sites || [];
  if (!sites.length) { b.innerHTML = '<div class="empty-state">No per-site overrides</div>'; return; }
  b.innerHTML = '<div class="pp-list">' + sites.map(s => `<div class="pp-item"><div class="pi-info"><div class="pi-title">${esc(s.host)}</div><div class="pi-sub">UA: ${esc(s.ua_mode || "Default")} · Ads: ${s.adblock_enabled ? "On" : "Off"}</div></div><button class="pi-action" data-dh="${esc(s.host)}">✕</button></div>`).join("") + "</div>";
  b.querySelectorAll("[data-dh]").forEach(el => el.addEventListener("click", async () => { await invoke("delete_site_config", { host: el.getAttribute("data-dh")! }); if (settings) settings.sites = settings.sites.filter(s => s.host !== el.getAttribute("data-dh")!); renderSiteConfig(b); showToast("Removed"); }));
}
function renderCookies(b: HTMLElement) {
  invoke<any[]>("get_cookies").then(c => { if (!c.length) { b.innerHTML = '<div class="empty-state">No cookies</div>'; return; } b.innerHTML = '<div class="pp-list">' + c.slice(0, 50).map(x => `<div class="pp-item"><div class="pi-info"><div class="pi-title">${esc(x.name || "?")}</div><div class="pi-sub">${esc(x.domain || "?")}</div></div></div>`).join("") + '</div><div style="padding:16px"><button class="btn" id="ccb">Clear all</button></div>'; b.querySelector("#ccb")?.addEventListener("click", async () => { await invoke("clear_cookies"); renderCookies(b); showToast("Cleared"); }); }).catch(() => b.innerHTML = '<div class="empty-state">Could not read cookies</div>');
}
function renderCustomize(b: HTMLElement) {
  const order = menuOrder();
  b.innerHTML = `<div class="sec-title">Drag to reorder</div><div id="cv">${order.map(id => { const i = MENU.find(m => m.id === id); return i ? `<div class="drag-item" data-mid="${i.id}" draggable="true"><span class="drag-handle">⠿</span><span class="drag-label">${esc(i.label)}</span></div>` : ""; }).join("")}</div><div style="padding:16px"><button class="btn" id="rmb">Reset</button></div>`;
  const list = b.querySelector("#cv")!; let d: HTMLElement | null = null;
  list.addEventListener("dragstart", e => { d = (e.target as HTMLElement).closest(".drag-item"); if (d) d.style.opacity = "0.5"; });
  list.addEventListener("dragend", () => { if (d) d.style.opacity = ""; d = null; });
  list.addEventListener("dragover", e => { e.preventDefault(); const t = (e.target as HTMLElement).closest(".drag-item") as HTMLElement; if (t && t !== d && d) { const r = t.getBoundingClientRect(); e.clientY < r.top + r.height / 2 ? list.insertBefore(d, t) : list.insertBefore(d, t.nextSibling); } });
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
    if (k === "search") { const e = Object.keys(ENGINES); searchEngine = e[(e.indexOf(searchEngine) + 1) % e.length]; s2.search_engine = searchEngine; persistSettings(); showToast("Search: " + searchEngine); renderSettings(b); }
    else if (k === "night") { nightMode = !nightMode; s2.night_mode = nightMode; invoke("set_night_mode", { enabled: nightMode }); persistSettings(); }
    else if (k === "text") { textSize = textSize >= 2 ? 0.5 : textSize + 0.25; s2.text_size = textSize; persistSettings(); showToast(Math.round(textSize * 100) + "%"); renderSettings(b); }
    else if (k === "ad") { adblockOn = !adblockOn; s2.adblock_enabled = adblockOn; persistSettings(); }
    else if (k === "dt") { desktopMode = !desktopMode; s2.desktop_mode = desktopMode; persistSettings(); }
    else if (k === "rt") { restoreTabs = !restoreTabs; s2.restore_tabs = restoreTabs; persistSettings(); }
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
  listen<{ id: number; url: string }>("tab-url", ev => {
    log("tab-url", ev.payload.id, ev.payload.url);
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) {
      tab.url = ev.payload.url;
      // Page loaded — hide homepage, ensure this webview is visible
      if (tab.id === activeId) {
        hideHomePage();
      }
      if (!ev.payload.url.startsWith("about:")) invoke("add_history", { url: ev.payload.url, title: tab.title }).catch(() => {});
    }
  });
  listen<{ id: number; title: string }>("tab-title", ev => {
    const tab = tabs.find(t => t.id === ev.payload.id);
    if (tab) tab.title = ev.payload.title;
  });
  listen<{ url: string }>("new-window-request", ev => createTab(ev.payload.url));
  listen<any>("download-started", ev => {
    log("download-started", ev.payload);
    const name = ev.payload.path?.split(/[/\\]/)?.pop() || "file";
    downloads.unshift({ url: ev.payload.url || "", path: ev.payload.path || "", title: name, size: 0, done: false });
    showToast("⬇ Download: " + name);
  });
  listen<any>("download-progress", ev => {
    const p = ev.payload;
    if (p.done) {
      const dl = downloads.find(d => d.url === p.url);
      if (dl) { dl.done = true; dl.path = p.path || dl.path; }
      showToast(p.success ? "✓ Complete" : "✗ Failed");
      refreshDownloads();
    }
  });
}
function refreshDownloads() { invoke<DlItem[]>("list_downloads").then(dl => downloads = dl).catch(() => {}); }

/* ═══════ KEYBOARD ═══════ */
function setupKeyboard() {
  document.addEventListener("keydown", e => {
    const c = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") { if ($("panel").classList.contains("open")) closePanel(); else if ($("side-menu").classList.contains("open")) closeMenu(); }
    else if (c && e.key === "t") { e.preventDefault(); log("Ctrl+T"); createTab(); }
    else if (c && e.shiftKey && e.key === "T") { e.preventDefault(); invoke<ClosedTab | null>("pop_closed_tab").then(c => { if (c) { createTab(c.url); showToast("Restored"); } else showToast("No closed tabs"); }); }
    else if (c && e.key === "w") { e.preventDefault(); if (activeId) closeTab(activeId); }
    else if (c && e.key === "l") { e.preventDefault(); openSearch(); }
    else if (c && e.key === "r") { e.preventDefault(); if (activeId) invoke("eval_tab", { id: activeId, js: "location.reload()" }); }
    else if (c && e.key === "f") { e.preventDefault(); if (activeId) { const q = prompt("Find:"); if (q) invoke("eval_tab", { id: activeId, js: `window.find(${JSON.stringify(q)})` }).catch(() => {}); } }
    else if (c && e.key === "d") { e.preventDefault(); const t = tabs.find(x => x.id === activeId); if (t?.url) { invoke("add_bookmark", { url: t.url, title: t.title || t.url, folder: null }).then(() => { bookmarks.push({ url: t.url, title: t.title || t.url, folder: "" }); showToast("Bookmarked"); }); } }
    else if (c && e.key === "h") { e.preventDefault(); openPanel("History", renderHistory); }
    else if (e.key === "F11") { e.preventDefault(); const w = (window as any).__TAURI__?.window?.appWindow; if (w) w.isFullscreen().then((f: boolean) => w.setFullscreen(!f)); }
  });
}

/* ═══════ SESSION ═══════ */
function saveSession() {
  if (!restoreTabs || !tabs.length) return;
  invoke("save_session", { entries: tabs.map((t, i) => ({ url: t.url || "about:blank", title: t.title, active: t.id === activeId, order: i })) }).catch(() => {});
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
  settings = await invoke<Settings>("get_settings").catch(() => null);
  if (settings) { searchEngine = settings.search_engine || "Google"; nightMode = settings.night_mode; desktopMode = settings.desktop_mode; textSize = settings.text_size || 1; showImages = settings.show_images !== false; adblockOn = settings.adblock_enabled !== false; restoreTabs = settings.restore_tabs || false; }
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
  historyItems = await invoke<HistItem[]>("list_history", { q: null }).catch(() => []);
  downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);
  setupEvents(); setupKeyboard();

  $("nav-back").addEventListener("click", () => { if (activeId) { log("nav-back click, activeId=", activeId); invoke("eval_tab", { id: activeId, js: "history.back()" }).catch(() => {}); } });
  $("nav-fwd").addEventListener("click", () => { if (activeId) { log("nav-fwd click, activeId=", activeId); invoke("eval_tab", { id: activeId, js: "history.forward()" }).catch(() => {}); } });
  $("nav-home").addEventListener("click", () => showHomePage());
  $("nav-tabs").addEventListener("click", () => openPanel("Tabs (" + tabs.length + ")", renderTabs));
  $("nav-menu").addEventListener("click", () => { closePanel(); openMenu(); });
  $("home-search").addEventListener("click", e => { e.stopPropagation(); ($("home-input") as HTMLInputElement).focus(); });
  $("home-input").addEventListener("keydown", e => { if (e.key === "Enter") handleSearch(); e.stopPropagation(); });
  $("qr-btn").addEventListener("click", async () => { try { const t = await invoke<string>("qr_pick_and_scan"); if (t && confirm("QR: " + t + "\nOpen?")) openUrl(/^https?:\/\//i.test(t) ? t : "https://www.google.com/search?q=" + encodeURIComponent(t)); } catch { } });
  $("menu-backdrop").addEventListener("click", closeMenu);
  $("menu-exit").addEventListener("click", () => { closeMenu(); closePanel(); });
  $("menu-collapse").addEventListener("click", closeMenu);
  $("panel-back").addEventListener("click", closePanel);
  $("panel-backdrop").addEventListener("click", closePanel);
  window.addEventListener("beforeunload", () => saveSession());

  if (restoreTabs) {
    const session = await invoke<SessionEntry[]>("restore_session").catch(() => []);
    if (session.length) { for (const e of [...session].sort((a, b) => a.order - b.order)) { if (e.url && e.url !== "about:blank") await createTab(e.url); } const ae = session.find(s => s.active); if (ae) { const t = tabs.find(x => x.url === ae.url); if (t) await switchTab(t.id); } }
  }
  updateTabCount();
  // Show homepage on boot
  $("home").classList.remove("hidden");
  log("Boot complete, tabs:", tabs.length);
}
boot();
