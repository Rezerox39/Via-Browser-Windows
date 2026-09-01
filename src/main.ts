import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/* ═══════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════ */
type Tab = { id: number; url: string; title: string; active: boolean };
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
type ActiveDl = { url: string; path: string; received: number; total: number; done: boolean; success?: boolean };
type ClosedTab = { url: string; title: string; ts: number };
type SessionEntry = { url: string; title: string; active: boolean; order: number };
type ScriptItem = { id: string; name: string; match_urls: string; code: string; enabled: boolean };
type SiteConf = { host: string; ua_mode: string; adblock_enabled: boolean };

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
let activeDl: ActiveDl[] = [];
let nightMode = false;
let desktopMode = true;
let textSize = 1.0;
let showImages = true;
let adblockOn = true;
let incognitoMode = false;
let restoreTabs = false;
let sheetPage = 0;
const SHEET_PAGE_SIZE = 12;

/* ═══════════════════════════════════════════════
   DOM refs
   ═══════════════════════════════════════════════ */
const $ = (s: string) => document.getElementById(s) as HTMLElement;
function showToast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout((el as any)._t);
  (el as any)._t = setTimeout(() => el.classList.remove("show"), 2400);
}

/* ═══════════════════════════════════════════════
   Via bottom sheet menu definition
   (icons + labels match the APK menu grid)
   ═══════════════════════════════════════════════ */
interface MenuItem {
  label: string;
  icon: string; // inline SVG path(s)
  action: () => void;
  active?: () => boolean;
}
const MENU_ITEMS: MenuItem[] = [
  {
    label: "Bookmarks", icon: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>',
    action: () => openPanel("Bookmarks", renderBookmarks, "bookmarks")
  },
  {
    label: "History", icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    action: () => openPanel("History", renderHistory, "history")
  },
  {
    label: "Downloads", icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    action: () => openPanel("Downloads", renderDownloads, "downloads")
  },
  {
    label: "Saved pages", icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    action: () => openPanel("Saved Pages", renderSavedPages, "saved")
  },
  {
    label: "Night mode", icon: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>',
    action: () => { nightMode = !nightMode; showToast("Night mode " + (nightMode ? "on" : "off")); closeSheet(); refreshMenuState(); },
    active: () => nightMode
  },
  {
    label: "Find in page", icon: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "window.__t10?.openFinder?.()" }); closeSheet(); }
  },
  {
    label: "Desktop mode", icon: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    action: () => { desktopMode = !desktopMode; showToast("Desktop mode " + (desktopMode ? "on" : "off")); closeSheet(); refreshMenuState(); },
    active: () => desktopMode
  },
  {
    label: "QR Scanner", icon: '<path d="M3 7V3h4M17 3h4v4M3 17v4h4M17 21h4v-4"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="7" width="4" height="4"/><rect x="7" y="13" width="4" height="4"/>',
    action: () => { handleQR(); closeSheet(); }
  },
  {
    label: "Incognito", icon: '<path d="M12 2C7 2 2 7 2 12s5 10 10 10 10-5 10-10S17 2 12 2z"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    action: () => { incognitoMode = !incognitoMode; showToast(incognitoMode ? "Incognito mode" : "Normal mode"); closeSheet(); refreshMenuState(); },
    active: () => incognitoMode
  },
  {
    label: "Refresh", icon: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>',
    action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "location.reload()" }); closeSheet(); }
  },
  {
    label: "Share", icon: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    action: () => {
      const tab = tabs.find(t => t.id === activeId);
      if (tab) { navigator.clipboard.writeText(tab.url); showToast("URL copied"); }
      closeSheet();
    }
  },
  {
    label: "Network log", icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    action: () => { settings && (settings.network_log = !settings.network_log); showToast("Network log " + (settings?.network_log ? "on" : "off")); closeSheet(); }
  },
  {
    label: "Site settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    action: () => openPanel("Site Settings", renderSiteConfig, "siteconfig")
  },
  {
    label: "Customize", icon: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    action: () => openPanel("Settings", renderSettings, "settings")
  },
  {
    label: "Extensions", icon: '<path d="M20 7h-4l-2-3H10L8 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/>',
    action: () => openPanel("Extensions", renderExtensions, "extensions")
  },
  {
    label: "Settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    action: () => openPanel("Settings", renderSettings, "settings")
  },
  {
    label: "Help", icon: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    action: () => openPanel("About", renderAbout, "about")
  },
];

function makeMenuIcon(path: string, filled = false): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

/* ═══════════════════════════════════════════════
   Panel system
   ═══════════════════════════════════════════════ */
function openPanel(title: string, renderFn: (body: HTMLElement) => void, kind: string) {
  closeSheet();
  $("panel-title").textContent = title;
  const body = $("panel-body");
  body.innerHTML = "";
  renderFn(body);
  $("panel").style.display = "flex";
  $("panel-backdrop").classList.add("open");
  hideActiveWebview();
  $("topbar").style.display = "none";
  $("home").classList.add("hidden");
}
function closePanel() {
  $("panel").style.display = "none";
  $("panel-backdrop").classList.remove("open");
  if (tabs.length > 0 && activeId) showActiveWebview();
  if (tabs.length === 0 || !activeId) {
    $("topbar").style.display = "";
    $("home").classList.remove("hidden");
  }
}
function showActiveWebview() { if (activeId != null) invoke("show_tab", { id: activeId }).catch(() => {}); }
function hideActiveWebview() { if (activeId != null) invoke("hide_tab", { id: activeId }).catch(() => {}); }

/* ═══════════════════════════════════════════════
   Bottom Sheet Menu
   ═══════════════════════════════════════════════ */
function buildSheetGrid() {
  const grid = $("sheet-grid");
  const start = sheetPage * SHEET_PAGE_SIZE;
  const page = MENU_ITEMS.slice(start, start + SHEET_PAGE_SIZE);
  grid.innerHTML = page.map(item => {
    const active = item.active?.() ? " active" : "";
    return `<button class="sheet-item${active}">${makeMenuIcon(item.icon)}<span>${item.label}</span></button>`;
  }).join("");
  grid.querySelectorAll(".sheet-item").forEach((el, i) => {
    el.addEventListener("click", () => page[i].action());
  });
  // pagination
  const pages = Math.ceil(MENU_ITEMS.length / SHEET_PAGE_SIZE);
  $("sheet-pagination").innerHTML = Array.from({ length: pages }, (_, i) =>
    `<div class="pg-dot${i === sheetPage ? ' active' : ''}" data-p="${i}"></div>`
  ).join("");
  $("sheet-pagination").querySelectorAll(".pg-dot").forEach(el => {
    el.addEventListener("click", () => { sheetPage = parseInt(el.getAttribute("data-p")!); buildSheetGrid(); });
  });
}
function refreshMenuState() { buildSheetGrid(); }
function openSheet() { buildSheetGrid(); $("bottom-sheet").classList.add("open"); $("menu-backdrop").classList.add("open"); hideActiveWebview(); }
function closeSheet() { $("bottom-sheet").classList.remove("open"); $("menu-backdrop").classList.remove("open"); if (activeId) showActiveWebview(); }

/* ═══════════════════════════════════════════════
   URL bar
   ═══════════════════════════════════════════════ */
function openUrlBar() {
  $("url-overlay").classList.add("open");
  const inp = $("url-input") as HTMLInputElement;
  if (activeId) {
    const tab = tabs.find(t => t.id === activeId);
    inp.value = tab?.url && tab.url !== "about:blank" ? tab.url : "";
  } else {
    inp.value = "";
  }
  inp.focus();
  inp.select();
  hideActiveWebview();
}
function closeUrlBar() {
  $("url-overlay").classList.remove("open");
  if (activeId) showActiveWebview();
}
function handleUrlGo() {
  const val = ($("url-input") as HTMLInputElement).value.trim();
  closeUrlBar();
  if (!val) return;
  if (/^https?:\/\//i.test(val) || /^[a-z0-9-]+\.[a-z]/i.test(val) || val.includes("://"))
    navigate(/^https?:\/\//i.test(val) ? val : "https://" + val);
  else
    navigate(ENGINES[searchEngine] + encodeURIComponent(val));
}

/* ═══════════════════════════════════════════════
   Tab management
   ═══════════════════════════════════════════════ */
function esc(s: string): string { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
async function createTab(url?: string, hide = false): Promise<Tab> {
  const id = await invoke<number>("create_tab", { url: url || "about:blank", hidden: hide });
  const tab: Tab = { id, url: url || "about:blank", title: "New tab", active: !hide };
  tabs.push(tab);
  updateTabCount();
  return tab;
}
async function closeTab(id: number) {
  const tab = tabs.find(t => t.id === id);
  if (tab) await invoke("push_closed_tab", { url: tab.url, title: tab.title });
  await invoke("close_tab", { id });
  tabs = tabs.filter(t => t.id !== id);
  if (activeId === activeId) {
    activeId = tabs.length ? tabs[tabs.length - 1].id : null;
    if (activeId) await switchTab(activeId);
  }
  updateTabCount();
  if (tabs.length === 0) showHomepage();
}
async function switchTab(id: number) {
  for (const t of tabs) { t.active = false; }
  const tab = tabs.find(t => t.id === id);
  if (tab) tab.active = true;
  activeId = id;
  await invoke("select_tab", { id });
  updateUrlDisplay();
  updateTabCount();
  hideTopbarAndHome();
}
function updateTabCount() {
  const el = $("nav-tab-count");
  el.textContent = String(tabs.length);
  el.classList.toggle("active", tabs.length > 0);
}
function hideTopbarAndHome() {
  $("topbar").style.display = "none";
  $("home").classList.add("hidden");
}
function showHomepage() {
  $("topbar").style.display = "";
  $("home").classList.remove("hidden");
  $("topbar-title").textContent = "Homepage";
  activeId = null;
}
function updateUrlDisplay() {
  const tab = tabs.find(t => t.id === activeId);
  $("topbar-title").textContent = tab?.title || "New tab";
}

/* ═══════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════ */
async function navigate(url: string) {
  if (activeId) {
    await invoke("navigate_tab", { id: activeId, url });
    updateUrlDisplay();
    return;
  }
  const tab = await createTab(url);
  await switchTab(tab.id);
}

/* ═══════════════════════════════════════════════
   Panel renderers
   ═══════════════════════════════════════════════ */
function renderBookmarks(body: HTMLElement) {
  if (!bookmarks.length) {
    body.innerHTML = '<div class="empty-state">No bookmarks</div>';
    return;
  }
  body.innerHTML = '<div class="pp-list">' + bookmarks.map(b =>
    `<div class="pp-item" data-url="${esc(b.url)}">
      <div class="pi-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg></div>
      <div class="pi-info"><div class="pi-title">${esc(b.title)}</div><div class="pi-sub">${esc(b.url)}</div></div>
    </div>`
  ).join("") + "</div>";
  body.querySelectorAll(".pp-item").forEach(el => {
    el.addEventListener("click", () => {
      const url = el.getAttribute("data-url")!;
      closePanel(); navigate(url);
    });
  });
}
function renderHistory(body: HTMLElement) {
  if (!historyItems.length) { body.innerHTML = '<div class="empty-state">No history</div>'; return; }
  const grouped: Record<string, HistItem[]> = {};
  historyItems.forEach(h => {
    const d = new Date(h.ts * 1000).toISOString().slice(0, 10);
    (grouped[d] = grouped[d] || []).push(h);
  });
  body.innerHTML = Object.entries(grouped).map(([date, items]) =>
    `<div class="sec-title">${date}</div><div class="pp-list">` +
    items.map(h =>
      `<div class="pp-item" data-url="${esc(h.url)}">
        <div class="pi-info"><div class="pi-title">${esc(h.title)}</div><div class="pi-sub" style="color:var(--accent)">${esc(h.url)}</div></div>
      </div>`
    ).join("") + "</div>"
  ).join("");
  body.querySelectorAll(".pp-item").forEach(el => {
    el.addEventListener("click", () => { closePanel(); navigate(el.getAttribute("data-url")!); });
  });
}
function renderDownloads(body: HTMLElement) {
  if (!downloads.length) { body.innerHTML = '<div class="empty-state">No downloads</div>'; return; }
  body.innerHTML = downloads.map(d =>
    `<div class="dl-item">
      <div class="dl-name">${esc(d.title)}</div>
      <div class="dl-meta">${formatSize(d.size)} ${d.done ? "✓ Complete" : "In progress"}</div>
      ${d.done ? `<div class="dl-actions"><button data-open="${esc(d.path)}">Open</button><button data-folder="${esc(d.path)}">Folder</button></div>` : ""}
    </div>`
  ).join("");
  body.querySelectorAll("[data-open]").forEach(el => el.addEventListener("click", () => invoke("open_download", { path: el.getAttribute("data-open") })));
  body.querySelectorAll("[data-folder]").forEach(el => el.addEventListener("click", () => invoke("reveal_download", { path: el.getAttribute("data-folder") })));
}
function renderSavedPages(body: HTMLElement) { body.innerHTML = '<div class="empty-state">No saved pages</div>'; }
function renderExtensions(body: HTMLElement) { body.innerHTML = '<div class="empty-state">No extensions installed</div>'; }
function renderAbout(body: HTMLElement) {
  body.innerHTML = `<div style="text-align:center;padding:32px 16px">
    <img src="/via-logo.svg" style="width:60px;margin-bottom:12px" />
    <div style="font-size:18px;margin-bottom:4px">Via Browser</div>
    <div style="font-size:12px;color:var(--fg-muted)">Version 7.2.1 · Windows Desktop</div>
    <div style="font-size:12px;color:var(--fg-muted);margin-top:8px">Lightweight, fast, private browsing</div>
  </div>`;
}

function renderSettings(body: HTMLElement) {
  const s = settings;
  if (!s) return;
  body.innerHTML = `
    <div class="mg-list">
      <div class="sec-title">Basic</div>
      <div class="mg-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Search engine<span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polyline points="9 18 15 12 9 6"/></svg></span></div>
      <div class="mg-item" data-set="night"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg> Night mode <span class="switch${nightMode ? ' on' : ''}" style="margin-left:auto"></span></div>
      <div class="mg-item" data-set="desktop"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Desktop mode <span class="switch${desktopMode ? ' on' : ''}" style="margin-left:auto"></span></div>

      <div class="sec-title">Customize</div>
      <div class="mg-item" data-set="adblock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Ad blocking <span class="switch${adblockOn ? ' on' : ''}" style="margin-left:auto"></span></div>
      <div class="mg-item" data-set="img"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> Show images <span class="switch${showImages ? ' on' : ''}" style="margin-left:auto"></span></div>
      <div class="mg-item" data-set="suggest"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M16 12l-4-4-4 4"/><path d="M12 16V8"/></svg> Search suggestions <span class="switch${s.search_suggest ? ' on' : ''}" style="margin-left:auto"></span></div>
      <div class="field"><label>Text size</label><input type="range" min="0.5" max="2" step="0.1" value="${textSize}" data-set="textsize" /></div>
      <div class="field"><label>User agent</label><select data-set="ua"><option value="" ${!s.ua_mode||s.ua_mode==="Default"?"selected":""}>Default</option><option value="Desktop" ${s.ua_mode==="Desktop"?"selected":""}>Desktop</option><option value="Mobile" ${s.ua_mode==="Mobile"?"selected":""}>Mobile</option><option value="Via" ${s.ua_mode==="Via"?"selected":""}>Via</option><option value="Custom" ${s.ua_mode==="Custom"?"selected":""}>Custom</option></select></div>

      <div class="sec-title">Advanced</div>
      <div class="mg-item" data-set="restore"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-1.85-8.42"/></svg> Restore tabs <span class="switch${restoreTabs ? ' on' : ''}" style="margin-left:auto"></span></div>
      <div class="mg-item" data-action="save"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save settings</div>
    </div>`;
  // wire toggles
  body.querySelectorAll("[data-set]").forEach(el => {
    el.addEventListener("click", () => {
      const key = el.getAttribute("data-set")!;
      const sw = el.querySelector(".switch");
      if (key === "night") { nightMode = !nightMode; sw?.classList.toggle("on"); }
      else if (key === "desktop") { desktopMode = !desktopMode; sw?.classList.toggle("on"); }
      else if (key === "adblock") { adblockOn = !adblockOn; sw?.classList.toggle("on"); }
      else if (key === "img") { showImages = !showImages; sw?.classList.toggle("on"); }
      else if (key === "suggest") { s.search_suggest = !s.search_suggest; sw?.classList.toggle("on"); }
      else if (key === "restore") { restoreTabs = !restoreTabs; sw?.classList.toggle("on"); }
    });
  });
  body.querySelector("[data-action='save']")?.addEventListener("click", async () => {
    s.night_mode = nightMode; s.desktop_mode = desktopMode; s.adblock_enabled = adblockOn;
    s.show_images = showImages; s.restore_tabs = restoreTabs; s.text_size = textSize;
    await invoke("set_settings", { settings: s });
    showToast("Settings saved");
  });
}
function renderSiteConfig(body: HTMLElement) {
  const sites = settings?.sites || [];
  if (!sites.length) { body.innerHTML = '<div class="empty-state">No site rules</div>'; return; }
  body.innerHTML = '<div class="pp-list">' + sites.map(s =>
    `<div class="pp-item">
      <div class="pi-info"><div class="pi-title">${esc(s.host)}</div>
      <div class="pi-sub">UA: ${esc(s.ua_mode || "Default")} · AdBlock: ${s.adblock_enabled ? "On" : "Off"}</div></div>
    </div>`
  ).join("") + "</div>";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

/* ═══════════════════════════════════════════════
   QR Scanner (native fallback)
   ═══════════════════════════════════════════════ */
async function handleQR() {
  try {
    const text = await invoke<string>("qr_pick_and_scan");
    if (text) {
      openUrlBar();
      ($("url-input") as HTMLInputElement).value = text;
    }
  } catch (e) {
    showToast("QR scan cancelled or unavailable");
  }
}

/* ═══════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════ */
async function boot() {
  settings = await invoke<Settings>("get_settings").catch(() => null);
  if (settings) {
    searchEngine = settings.search_engine || "Google";
    nightMode = settings.night_mode;
    desktopMode = settings.desktop_mode;
    textSize = settings.text_size || 1;
    showImages = settings.show_images !== false;
    adblockOn = settings.adblock_enabled !== false;
    restoreTabs = settings.restore_tabs || false;
  }
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
  historyItems = await invoke<HistItem[]>("list_history").catch(() => []);
  downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);

  // Restore session if enabled
  if (restoreTabs) {
    const session = await invoke<SessionEntry[]>("restore_session").catch(() => []);
    if (session.length) {
      for (const entry of session.sort((a, b) => a.order - b.order)) {
        const info = await createTab(entry.url !== "about:blank" ? entry.url : undefined, !entry.active);
        if (entry.active) await switchTab(info.id);
      }
      if (activeId) hideTopbarAndHome();
      updateTabCount();
    }
  }

  // Bottom nav buttons
  $("nav-back").addEventListener("click", () => { if (activeId) invoke("eval_tab", { id: activeId, js: "history.back()" }); });
  $("nav-fwd").addEventListener("click", () => { if (activeId) invoke("eval_tab", { id: activeId, js: "history.forward()" }); });
  $("nav-home").addEventListener("click", () => { if (activeId) { invoke("eval_tab", { id: activeId, js: "history.go(-999)" }); } else { showHomepage(); } });
  $("nav-tabs").addEventListener("click", () => {
    if (tabs.length === 0) { createTab().then(t => switchTab(t.id)); return; }
    openPanel("Tabs (" + tabs.length + ")", b => {
      b.innerHTML = `<div class="pp-list">${tabs.map(t =>
        `<div class="pp-item${t.id === activeId ? ' selected' : ''}" data-tab="${t.id}">
          <div class="pi-icon">${t.id === activeId ? "▶" : "◻"}</div>
          <div class="pi-info"><div class="pi-title">${esc(t.title || "New Tab")}</div>
          <div class="pi-sub">${esc(t.url || "about:blank")}</div></div>
          <div class="pi-action" data-ctab="${t.id}">✕</div>
        </div>`).join("")}</div>
      <div style="padding:12px 16px"><button class="btn" id="new-tab-btn">+ New Tab</button></div>`;
      b.querySelector("#new-tab-btn")?.addEventListener("click", () => { closePanel(); createTab().then(t => switchTab(t.id)); });
      b.querySelectorAll(".pp-item[data-tab]").forEach(el => el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("pi-action")) return;
        closePanel(); switchTab(parseInt(el.getAttribute("data-tab")!));
      }));
      b.querySelectorAll(".pi-action[data-ctab]").forEach(el => el.addEventListener("click", (e) => {
        e.stopPropagation(); closeTab(parseInt(el.getAttribute("data-ctab")!));
      }));
    }, "tabs");
  });
  $("nav-menu").addEventListener("click", () => { closePanel(); openSheet(); });

  // Home search pill
  $("home-search").addEventListener("click", openUrlBar);
  // URL overlay
  $("url-go").addEventListener("click", handleUrlGo);
  $("url-input").addEventListener("keydown", (e) => { if (e.key === "Enter") handleUrlGo(); if (e.key === "Escape") closeUrlBar(); });
  $("url-cancel").addEventListener("click", closeUrlBar);
  // Sheet
  $("menu-backdrop").addEventListener("click", closeSheet);
  $("sheet-exit").addEventListener("click", () => { closeSheet(); closePanel(); });
  $("sheet-collapse").addEventListener("click", closeSheet);
  // Panel
  $("panel-back").addEventListener("click", closePanel);
  $("panel-backdrop").addEventListener("click", closePanel);
  // Back/Fwd state
  $("nav-back").addEventListener("click", () => setTimeout(updateNavState, 200));
  $("nav-fwd").addEventListener("click", () => setTimeout(updateNavState, 200));
  // Context menu
  document.addEventListener("click", () => { $("context-menu").style.display = "none"; });
  window.addEventListener("beforeunload", () => saveSession());
  console.log("[Via] Boot complete — Via 7.2.1 Desktop");
  updateTabCount();
}

function updateNavState() {
  // Called after navigation events; could query history state
  // For now just update URL display
  updateUrlDisplay();
}

async function saveSession() {
  if (!restoreTabs || !tabs.length) return;
  const entries: SessionEntry[] = tabs.map((t, i) => ({
    url: t.url, title: t.title, active: t.id === activeId, order: i
  }));
  await invoke("save_session", { entries }).catch(() => {});
}

boot();
