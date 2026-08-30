import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

/* ---- Types ---- */
type Tab = { id: number; url: string; title: string; loading: boolean; active: boolean };
type Settings = {
  homepage: string; search_engine: string; ua_mode: string; custom_ua: string;
  adblock_enabled: boolean; clear_on_exit: boolean; user_css: string; user_js: string;
  night_mode: boolean; desktop_mode: boolean;
  text_size: number; show_images: boolean; network_log: boolean; game_mode: boolean;
  read_aloud_enabled: boolean;
  search_suggest: boolean;
  scripts: UserScript[]; sites: SiteConfig[]; pages_log: string[][];
};
type UserScript = { id: string; name: string; match_urls: string; code: string; enabled: boolean };
type SiteConfig = { host: string; ua_mode: string; adblock_enabled: boolean };
type Bookmark = { url: string; title: string; folder: string };
type HistItem = { url: string; title: string; ts: number };
type DlItem = { url: string; path: string; title: string; size: number; done: boolean };
type ActiveDl = { url: string; path: string; received: number; total: number; done: boolean; success?: boolean };

const ENGINES: Record<string, string> = {
  Google: "https://www.google.com/search?q=",
  DuckDuckGo: "https://duckduckgo.com/?q=", Baidu: "https://www.baidu.com/s?wd=",
};

/* ---- State ---- */
let tabs: Tab[] = [];
let activeId: number | null = null;
let nightMode = false;
let desktopMode = true;
let searchEngine = "Google";
let hasNavigated = false;          // true once the user navigates off the homepage
let overlay: "none" | "addr" | "tabs" | "menu" | "panel" = "none";
let panelKind: string | null = null;
let textSize = 1.0, showImages = true, networkLog = false, gameMode = false, readAloud = false;
let adblockOn = true, incognitoMode = false, isFullscreen = false;
let restoreTabs = false;
let userCss = "";                   // custom CSS applied to every page
let scripts: UserScript[] = [];    // cached script store
let sites: SiteConfig[] = [];      // cached site configs
let bookmarks: Bookmark[] = [];
let historyItems: HistItem[] = [];
let downloads: DlItem[] = [];
let activeDl: ActiveDl[] = [];
let snifferItems: string[] = [];   // media URLs captured from active page
let markAdActive = false;          // "Mark as ad" picker mode toggle

const q = (id: string) => document.getElementById(id) as any;

/* ---- Build DOM ---- */
q("app").innerHTML = `
<div id="stage"></div>
<div id="home" class="show">
  <img class="logo" src="/via-logo.svg" alt="Via Browser" draggable="false" />
  <div class="pill" id="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><input id="pill-input" type="text" placeholder="Search or enter address" autocomplete="off" spellcheck="false" /></div>
</div>
<div id="addr">
  <div class="row">
    <button class="cancel" id="acancel">✕</button>
    <input id="ainput" type="text" placeholder="Search or enter address" autocomplete="off" spellcheck="false" />
  </div>
  <div class="sug" id="sug"></div>
</div>
<div id="tabs">
  <div class="body">
    <div class="wrap">
      <button class="x" id="tab-x">✕</button>
      <div class="grid" id="tab-grid"></div>
      <div class="new" id="tab-new">+</div>
    </div>
  </div>
</div>
<div id="menu">
  <div class="sheet">
    <div class="grip"></div>
    <div class="grid" id="menu-grid"></div>
  </div>
</div>
<nav id="nav"><div class="inner">
  <button id="nb" title="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
  <button id="nf" title="Forward"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg></button>
  <button id="nh" title="Home"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m3 9 9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 22V12h6v10"/></svg></button>
  <button id="nt" title="Tabs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="M9 3v18"/></svg><span class="count" id="badge">0</span></button>
  <button id="nm" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
</div></nav>
<div id="toast"></div>`;

/* ---- Refs ---- */
const stage = q("stage"), homeEl = q("home"), pill = q("pill"), pillInput = q("pill-input");
const addr = q("addr"), acancel = q("acancel"), ainput = q("ainput"), sug = q("sug");
const tabsEl = q("tabs"), tabX = q("tab-x"), tabGrid = q("tab-grid"), tabNew = q("tab-new");
const menuEl = q("menu"), menuGrid = q("menu-grid");
const nb = q("nb"), nf = q("nf"), nh = q("nh"), nt = q("nt"), nm = q("nm");
const badge = q("badge"), toastEl = q("toast");

/* ---- Helpers ---- */
function showToast(msg: string) { toastEl.textContent = msg; toastEl.classList.add("show"); setTimeout(() => toastEl.classList.remove("show"), 2200); }
function setHome(on: boolean) {
  homeEl.classList.toggle("show", on);
  // The native webview and the HTML homepage are mutually exclusive layers.
  stage.style.display = on ? "none" : "block";
}

/* ---- Native webview visibility (CSS can't affect native webviews) ---- */
async function hideActiveWebview() { if (activeId != null) await invoke("hide_tab", { id: activeId }).catch(()=>{}); }
async function showActiveWebview() { if (activeId != null) await invoke("show_tab", { id: activeId }).catch(()=>{}); }
function evalInActive(js: string) { if (activeId != null) return invoke("eval_tab", { id: activeId, js }); return Promise.resolve(); }
function locationIt() { const t = tabs.find(x => x.id === activeId); return t && t.url && !t.url.startsWith("about:") ? t.url : "https://www.google.com/"; }

/* ---- Overlays ---- */
let pillSugT: any;
// Live network suggestions are COMPLETELY disabled (no requests while typing:
// they caused CAPTCHA pages and typing lag). The dropdown only shows LOCAL
// history/bookmark matches, filtered synchronously on the client.
function showLocalSuggest(input: HTMLInputElement, to: (v: string) => void) {
  const q2 = input.value.trim().toLowerCase();
  if (q2.length < 2) { sug.classList.remove("open"); return; }
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const h of historyItems) {
    const label = h.title || h.url;
    if (!label || seen.has(label)) continue;
    if (label.toLowerCase().includes(q2)) {
      seen.add(label);
      rows.push(`<div class="item" data-v="${esc(label)}"><span>${esc(label)}</span></div>`);
      if (rows.length >= 6) break;
    }
  }
  if (!rows.length) { sug.classList.remove("open"); return; }
  sug.innerHTML = rows.join("");
  (sug as HTMLElement).querySelectorAll<HTMLElement>(".item").forEach(d => d.onclick = () => { to(d.dataset.v || ""); });
  const r = (input.parentElement as HTMLElement).getBoundingClientRect();
  (sug as HTMLElement).style.position = "fixed";
  (sug as HTMLElement).style.top = (r.bottom + 8) + "px";
  (sug as HTMLElement).style.left = "50%";
  (sug as HTMLElement).style.transform = "translateX(-50%)";
  (sug as HTMLElement).style.maxWidth = "min(420px, 80%)";
  sug.classList.add("open");
}
function pillSuggest() { showLocalSuggest(pillInput, v => { pillInput.value = v; pillInput.focus(); }); }
function openAddr() {
  overlay = "addr"; addr.classList.add("open");
  hideActiveWebview(); // hide native webview so the address overlay is visible
  setTimeout(() => { ainput.focus(); ainput.select(); }, 30);
}
function closeOverlay() {
  const wasOpen = overlay !== "none";
  addr.classList.remove("open"); tabsEl.classList.remove("show"); menuEl.classList.remove("show");
  sug.classList.remove("open");
  overlay = "none"; ainput.value = ""; sug.classList.remove("open");
  if (wasOpen && hasNavigated) showActiveWebview(); // restore webview if we navigated away from home
}

/* ---- URL helpers ---- */
function searchUrl(engine: string, q2: string) { return (ENGINES[engine] || ENGINES.Google) + encodeURIComponent(q2); }
async function goAddr() {
  const v = ainput.value; const wasOpen = overlay === "addr";
  closeOverlay();
  if (v.trim()) {
    // Route through the Rust backend (Via-style URL/search detection).
    const url = await invoke<string>("parse_and_load_url", { input: v }).catch(() => searchUrl(searchEngine, v.trim()));
    await navigate(url);
  } else if (wasOpen) setHome(true);
}
let sugT: any;
function doSuggest() { showLocalSuggest(ainput, v => { ainput.value = v; goAddr(); }); }

/* ---- Tab lifecycle ---- */
async function createTab(url?: string, silent?: boolean) {
  const t: Tab = await invoke("create_tab", { url: url ?? null });
  tabs = tabs.filter(x => x.id !== t.id); tabs.push(t);
  tabs.forEach(x => x.active = x.id === t.id);
  activeId = t.id; updateBadge();
  if (!silent) { openAddr(); }
  else { /* home stays visible, webview stays hidden */ }
  return t;
}
async function closeTab(id: number) {
  await invoke("close_tab", { id }); tabs = tabs.filter(x => x.id !== id);
  if (!tabs.length) { await createTab(); closeOverlay(); return; }
  if (activeId === id) { const last = tabs[tabs.length - 1]; await selectTab(last.id); return; }
  updateBadge(); renderTabGrid();
}
async function selectTab(id: number) {
  const info = await invoke<Tab>("select_tab", { id }).catch(() => null);
  if (!info) return;
  tabs.forEach(x => x.active = x.id === id); activeId = id;
  closeOverlay(); updateBadge(); renderTabGrid();
  // Blank tabs show the black homepage; visited tabs show the webview.
  const t = tabs.find(x => x.id === id);
  const blank = !t || !t.url || t.url === "about:blank" || t.url.startsWith("about:");
  if (blank) { setHome(true); await hideActiveWebview(); }
  else { setHome(false); stage.style.display = "block"; await showActiveWebview(); }
}
async function navigate(url: string) {
  hasNavigated = true;
  sug.classList.remove("open"); pillInput.value = "";
  setHome(false); // hide homepage, show stage
  if (activeId != null) await invoke("navigate_tab", { id: activeId, url });
  await showActiveWebview();
  stage.style.display = "block";
}
async function goHome() {
  hasNavigated = false;
  setHome(true);           // reveal black homepage
  hideActiveWebview();     // hide the native webview
}
async function goBack() { if (activeId != null) await invoke("eval_tab", { id: activeId, js: "history.back()" }); }
async function goFwd() { if (activeId != null) await invoke("eval_tab", { id: activeId, js: "history.forward()" }); }
async function reloadT() { if (hasNavigated && activeId != null) await invoke("eval_tab", { id: activeId, js: "location.reload()" }); }
function updateBadge() { badge.textContent = String(tabs.length); }

/* ---- Tab grid ---- */
function renderTabGrid() {
  tabGrid.innerHTML = "";
  tabs.forEach(t => {
    const c = document.createElement("div"); c.className = "card" + (t.id === activeId ? " on" : "");
    c.innerHTML = `<div class="preview"><div class="txt">${esc(t.url || t.title || "New tab")}</div></div><span class="label">${esc(t.title || t.url || "")}</span><button class="close">✕</button>`;
    (c.querySelector(".close") as HTMLElement).onclick = (e: MouseEvent) => { e.stopPropagation(); closeTab(t.id); };
    c.onclick = () => selectTab(t.id);
    tabGrid.appendChild(c);
  });
}
function esc(s: string) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

/* ---- Menu: 30+ Via features, 4-column scrollable grid ---- */
type MenuDef = { id: string; label: string; svg: string };
const MENUS: MenuDef[] = [
  { id: "m-find",     label: "Find in page",   svg: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M8.5 11h5"/>' },
  { id: "m-save",     label: "Save",            svg: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>' },
  { id: "m-saved",    label: "Saved pages",     svg: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>' },
  { id: "m-trans",    label: "Translate",       svg: '<path d="M4 5h7"/><path d="M9 3v2"/><path d="M5 9c.5 2 3 4 6 4"/><path d="M9 13c-1 2-3 3-4 3"/><path d="m14 5 6 16"/><path d="M18 16h-6"/>' },
  { id: "m-src",      label: "View source",     svg: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>' },
  { id: "m-full",     label: "Full-screen",     svg: '<path d="M8 3H5a2 2 0 00-2 2v3"/><path d="M21 8V5a2 2 0 00-2-2h-3"/><path d="M3 16v3a2 2 0 002 2h3"/><path d="M16 21h3a2 2 0 002-2v-3"/>' },
  { id: "m-imgs",     label: "Show images",     svg: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.3-3.3a2 2 0 00-2.8 0L6 21"/>' },
  { id: "m-sniff",    label: "Resource sniffer",svg: '<circle cx="12" cy="12" r="2"/><path d="M12 2a10 10 0 0110 10 10 10 0 01-10 10 10 10 0 01-10-10A10 10 0 0112 2z"/>' },
  { id: "m-ua",       label: "User-agent",      svg: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8"/><path d="M12 18v4"/>' },
  { id: "m-netlog",   label: "Network log",     svg: '<path d="M5 3v18"/><path d="M5 6h14"/><path d="M5 12h9"/><path d="M5 18h12"/><path d="M19 3v2"/>' },
  { id: "m-qr",       label: "Scan QR code",    svg: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v3M21 21h-4"/>' },
  { id: "m-homeadd",  label: "Add to home screen", svg: '<path d="m3 9 9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 22V12h6v10"/>' },
  { id: "m-readaloud",label: "Read aloud",      svg: '<path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10a7 7 0 01-14 0"/>' },
  { id: "m-ai",       label: "AI",              svg: '<path d="M12 2a10 10 0 0110 10 10 10 0 01-10 10A10 10 0 012 12 10 10 0 0112 2z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/>' },
  { id: "m-orient",   label: "Orientation",     svg: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>' },
  { id: "m-adblock",  label: "Ad blocking",     svg: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/><path d="m9 12 2 2 4-4"/>' },
  { id: "m-ad",       label: "Mark as ad",      svg: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>' },
  { id: "m-textsize", label: "Text size",       svg: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>' },
  { id: "m-clear",    label: "Clear data",      svg: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 15h10l1-15"/>' },
  { id: "m-custommenu",label: "Customize menu", svg: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>' },
  { id: "m-reload",   label: "Reload",          svg: '<path d="M21 12a9 9 0 11-2.6-6.4"/><path d="M21 3v6h-6"/>' },
  { id: "m-sitecfg",  label: "Site configuration", svg: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  { id: "m-scripts",  label: "Scripts",         svg: '<path d="m8 6-6 6 6 6"/><path d="m16 6 6 6-6 6"/>' },
  { id: "m-print",    label: "Print/PDF",       svg: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>' },
  { id: "m-reader",   label: "Reader mode",     svg: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>' },
  { id: "m-openwith", label: "Open with",       svg: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>' },
  { id: "m-game",     label: "Game mode",       svg: '<path d="M6 11h4"/><path d="M8 9v4"/><path d="M15 12h.01M18 10h.01"/><path d="M17.3 5H6.7a4 4 0 00-4 4.6l.8 6a4 4 0 004 3.4h1a3 3 0 002.4-1.2l2-2.6 2 2.6a3 3 0 002.4 1.2h1a4 4 0 004-3.4l.8-6a4 4 0 00-4-4.6z"/>' },
  { id: "m-fav",      label: "Add favorite",    svg: '<path d="M12 20l-7-5V5a2 2 0 012-2h10a2 2 0 012 2v10z"/>' },
  { id: "m-rpt",      label: "Report abuse",    svg: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>' },
  { id: "m-bkm",      label: "Bookmarks",       svg: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>' },
  { id: "m-hist",     label: "History",         svg: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  { id: "m-down",     label: "Downloads",       svg: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>' },
  { id: "m-inco",     label: "Incognito",       svg: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  { id: "m-addbkm",   label: "Add bookmark",    svg: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>' },
  { id: "m-desktop",  label: "Desktop site",    svg: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>' },
  { id: "m-night",    label: "Night mode",      svg: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>' },
  { id: "m-settings", label: "Settings",        svg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>' },
];

function menuHiddenIds(): string[] {
  try { return JSON.parse(localStorage.getItem("via.menuHidden") || "[]"); } catch { return []; }
}
function buildMenuUI() {
  menuGrid.innerHTML = "";
  const hidden = menuHiddenIds();
  MENUS.forEach(m => {
    if (hidden.includes(m.id)) return;
    const d = document.createElement("div"); d.className = "item"; d.id = m.id;
    d.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${m.svg}</svg><span>${m.label}</span>`;
    d.onclick = () => {
      try {
        (MENU_ACTIONS[m.id] || (() => showToast(m.label + ": coming soon")))();
      } catch (err) {
        console.error("[via] menu action failed:", m.id, err);
        showToast("Error loading panel");
        try { closePanel(); } catch {}
        // Restore the browser instead of leaving a black void after a failure.
        showActiveWebview();
        if (!hasNavigated) setHome(true);
      }
    };
    menuGrid.appendChild(d);
  });
  syncMenuUI();
}
function syncMenuUI() {
  const toggles: [string, boolean][] = [
    ["m-desktop", desktopMode], ["m-night", nightMode], ["m-adblock", adblockOn],
    ["m-imgs", showImages], ["m-netlog", networkLog], ["m-game", gameMode],
    ["m-readaloud", readAloud], ["m-inco", incognitoMode], ["m-ad", markAdActive],
    ["m-full", isFullscreen],
  ];
  toggles.forEach(([id, on]) => { const el = q(id); if (el) el.classList.toggle("on", on); });
}
async function openMenu() {
  overlay = "menu"; menuEl.classList.add("show");
  await hideActiveWebview(); // hide native webview behind the dark menu overlay
}
async function openTabs() {
  overlay = "tabs"; renderTabGrid(); tabsEl.classList.add("show");
  await hideActiveWebview();
}

/* ---- Bindings ---- */
pill.onclick = () => { pillInput.focus(); };
pillInput.onkeydown = (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    const v = pillInput.value;
    if (v.trim()) {
      pillInput.blur();
      invoke<string>("parse_and_load_url", { input: v })
        .then(url => navigate(url))
        .catch(() => navigate(searchUrl(searchEngine, v.trim())));
      pillInput.value = "";
    }
  }
};
pillInput.oninput = () => { clearTimeout(pillSugT); pillSugT = setTimeout(pillSuggest, 300); };
acancel.onclick = closeOverlay;
ainput.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter") goAddr(); if (e.key === "Escape") closeOverlay(); };
ainput.oninput = () => { clearTimeout(sugT); sugT = setTimeout(doSuggest, 300); };
tabsEl.onclick = (e: any) => { if (e.target === tabsEl) closeOverlay(); };
menuEl.onclick = (e: any) => { if (e.target === menuEl) closeOverlay(); };
nb.onclick = goBack;
nf.onclick = goFwd;
nh.onclick = goHome;
nt.onclick = () => overlay === "tabs" ? closeOverlay() : openTabs();
nm.onclick = () => overlay === "menu" ? closeOverlay() : openMenu();
tabX.onclick = closeOverlay;
tabNew.onclick = async () => { closeOverlay(); await createTab(undefined, true); setHome(true); };

/* ---- Menu handlers ---- */
// Each menu item id is looked up and bound after buildMenuUI().

function findJs() {
  // Find in page: page-local floating bar using the browser's native search.
  const js = `(()=>{
    var old=document.getElementById('viaFind');
    if(old){old.remove();var b=document.getElementById('viaFindBar');if(b)b.remove();return 'off';}
    var bar=document.createElement('div');
    bar.id='viaFindBar';
    bar.style.cssText='position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:999999;display:flex;gap:8px;align-items:center;background:#16171a;border:1px solid #333;border-radius:24px;padding:8px 14px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:14px system-ui;color:#eee;';
    var inp=document.createElement('input');
    inp.placeholder='Find in page…';
    inp.style.cssText='background:transparent;border:0;outline:none;color:#fff;width:220px;font:14px system-ui;';
    var cnt=document.createElement('span');cnt.style.cssText='color:#9aa0a8;font-size:12px;min-width:40px;text-align:center;';
    var prev=document.createElement('button');prev.textContent='▲';prev.style.cssText='border:0;background:transparent;color:#9aa0a8;cursor:pointer;font-size:16px;';
    var next=document.createElement('button');next.textContent='▼';next.style.cssText='border:0;background:transparent;color:#9aa0a8;cursor:pointer;font-size:16px;';
    var close=document.createElement('button');close.textContent='✕';close.style.cssText='border:0;background:transparent;color:#9aa0a8;cursor:pointer;font-size:14px;';
    bar.appendChild(inp);bar.appendChild(prev);bar.appendChild(cnt);bar.appendChild(next);bar.appendChild(close);
    document.documentElement.appendChild(bar);
    var idx=0,count=0;
    function doFind(dir){
      var q=inp.value;if(!q){cnt.textContent='0/0';return;}
      var found=false;var lim=2000;
      // Use Selection API to walk text nodes.
      var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      var nodes=[];while(walker.nextNode()&&nodes.length<lim)nodes.push(walker.currentNode);
      var matches=[];
      nodes.forEach(function(n){var t=n.nodeValue;var i=0;while((i=t.toLowerCase().indexOf(q.toLowerCase(),i))!==-1){matches.push([n,i,q.length]);i+=q.length;}});
      count=matches.length;
      if(!count){cnt.textContent='0/0';return;}
      idx=(idx+dir+count)%count;
      var m=matches[idx];
      try{
        var range=document.createRange();range.setStart(m[0],m[1]);range.setEnd(m[0],m[1]+m[2]);
        var sel=getSelection();sel.removeAllRanges();sel.addRange(range);
        m[0].parentElement.scrollIntoView({block:'center'});
      }catch(e){}
      cnt.textContent=(idx+1)+'/'+count;
    }
    inp.addEventListener('input',function(){idx=0;doFind(0);});
    inp.addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();doFind(1);}});
    prev.onclick=function(){doFind(-1);};next.onclick=function(){doFind(1);};
    inp.focus();
    return 'on';
  })()`;
  evalInActive(js).catch(()=>{});
  showToast("Find in page");
}
function savePageNow() {
  const t = tabs.find(x => x.id === activeId);
  const url = (t && t.url && !t.url.startsWith("about:")) ? t.url : locationIt();
  const title = t?.title || "page";
  // Grab rendered HTML through the secure bridge (page sets document.title,
  // Rust forwards the payload to the frontend, which saves it to disk).
  (window as any).__viaSavePage = { url, title };
  evalInActive(`window.__viaSend('savePage',{html:document.documentElement.outerHTML,url:location.href,title:document.title})`).catch(() => {
    // fallback: fetch raw source (may miss dynamic DOM)
    fetch(url).then(r => r.text()).then(html => {
      invoke("save_page", { url, html, title }).then(() => showToast("Page saved to Downloads")).catch(()=>showToast("Save failed"));
    }).catch(() => showToast("Save failed"));
  });
}
function translatePage() {
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : "";
  if (!url) { showToast("Open a page first"); return; }
  navigate("https://translate.google.com/translate?sl=auto&tl=en&u=" + encodeURIComponent(url));
}
function viewSource() {
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : "";
  if (!url) { showToast("Open a page first"); return; }
  // WebView2 supports view-source: in a new child window; fallback to fetch-based viewer.
  evalInActive(`window.open('view-source:'+location.href,'_blank')`).catch(() => {
    // Host fallback: fetch raw source into a new tab via a data URL.
    fetch(url).then(r=>r.text()).then(html=>{
      const data = 'data:text/plain;charset=utf-8,' + encodeURIComponent(html);
      createTab(data);
    }).catch(()=>showToast("Unable to load source"));
  });
}
function toggleFullscreen() {
  const fs = getCurrentWindow();
  fs.setFullscreen(!isFullscreen).then(() => {
    isFullscreen = !isFullscreen; syncMenuUI();
    showToast(isFullscreen ? "Full-screen on" : "Full-screen off");
  }).catch(() => showToast("Fullscreen unavailable"));
}
function toggleShowImages() {
  showImages = !showImages;
  const css = showImages ? "" : "img,picture,video{{visibility:hidden!important}}";
  evalInActive(`var s=document.getElementById('via-img');if(s)s.remove();if(${showImages ? "false" : "true"}){s=document.createElement('style');s.id='via-img';s.textContent=${JSON.stringify(css)};document.documentElement.appendChild(s);}`).catch(()=>{});
  persistSettings({ show_images: showImages });
  syncMenuUI(); showToast(showImages ? "Images shown" : "Images hidden");
}
function openSniffer() {
  // Page-local overlay listing captured media resources.
  const js = `(()=>{
    var old=document.getElementById('viaSniff');
    if(old){old.remove();return;}
    var items=(window.__viaSniff?window.__viaSniff():[]);
    var box=document.createElement('div');
    box.id='viaSniff';
    box.style.cssText='position:fixed;right:14px;top:14px;z-index:999999;width:340px;max-height:70vh;overflow:auto;background:rgba(18,19,22,.97);border:1px solid #333;border-radius:16px;padding:14px;font:13px system-ui;color:#eee;box-shadow:0 10px 40px rgba(0,0,0,.6);';
    var h=document.createElement('div');h.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-weight:600;';
    h.innerHTML='<span>Resource sniffer</span><button id="viaSniffX" style="background:none;border:0;color:#9aa0a8;cursor:pointer;font-size:15px;">✕</button>';
    box.appendChild(h);
    var list=document.createElement('div');
    if(!items.length){list.textContent='No media resources detected yet. Play a video or reload the page.';list.style.cssText='color:#9aa0a8;padding:8px 0;';}
    items.forEach(function(u){
      var row=document.createElement('div');row.style.cssText='display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid #23252a;word-break:break-all;';
      var a=document.createElement('a');a.href=u;a.textContent=u.replace(/^https?:\\/\\//,'').slice(0,42);a.target='_blank';a.style.cssText='color:#7aa9ff;text-decoration:none;flex:1;';
      a.onclick=function(e){e.preventDefault();window.open(u,'_blank');};
      row.appendChild(a);list.appendChild(row);
    });
    box.appendChild(list);
    document.documentElement.appendChild(box);
    document.getElementById('viaSniffX').onclick=function(){box.remove();};
  })()`;
  evalInActive(js).catch(()=>showToast("Resource sniffer unavailable here"));
}
function toggleNetworkLog() {
  networkLog = !networkLog;
  persistSettings({ network_log: networkLog });
  syncMenuUI(); showToast(networkLog ? "Network log on" : "Network log off");
  closeOverlay();
  if (networkLog) { openPanel("sniff"); if (hasNavigated) invoke("eval_tab", { id: activeId!, js: "location.reload()" }).catch(()=>{}); }
}
function scanQr() {
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : locationIt();
  openPanel("qr", url);
}
function addToHome() {
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : "";
  if (!url) { showToast("Open a page first"); return; }
  invoke("add_bookmark", { url, title: t?.title || url, folder: "home" }).then(() => showToast("Added to home screen")).catch(() => showToast("Already on home screen"));
}
function toggleReadAloud() {
  readAloud = !readAloud;
  persistSettings({ read_aloud_enabled: readAloud });
  const js = readAloud
    ? `(function(){if(window.__viaSpeech){window.speechSynthesis.resume();return;}var txt=(document.body.innerText||'').trim().slice(0,8000);if(!txt){return false;}var u=new SpeechSynthesisUtterance(txt);u.rate=1;u.pitch=1;window.__viaSpeech=u;window.speechSynthesis.cancel();window.speechSynthesis.speak(u);})()`
    : `window.speechSynthesis.cancel();window.__viaSpeech=null;`;
  evalInActive(js).catch(()=>{});
  syncMenuUI(); showToast(readAloud ? "Reading aloud…" : "Read aloud stopped");
}
function aiPanel() { openPanel("ai"); }
function orientationPick() { openPanel("orient"); }
function uaPanel() { openPanel("ua"); }
function toggleAdblock() {
  adblockOn = !adblockOn;
  persistSettings({ adblock_enabled: adblockOn });
  evalInActive(`var s=document.querySelectorAll('style[data-via]');s.forEach(function(x){x.remove();});location.reload();`).catch(()=>{});
  syncMenuUI(); showToast(adblockOn ? "Ad blocking on" : "Ad blocking off");
}
function markAsAdMode() {
  markAdActive = !markAdActive;
  syncMenuUI(); closeOverlay();
  if (!markAdActive) { evalInActive(`var p=document.getElementById('viaPick');if(p)p.remove();`).catch(()=>{}); showToast("Mark as ad cancelled"); return; }
  const js = `(()=>{
    var old=document.getElementById('viaPick');
    if(old)old.remove();
    var tip=document.createElement('div');
    tip.id='viaPick';
    tip.style.cssText='position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.25);cursor:crosshair;';
    var lab=document.createElement('div');
    lab.style.cssText='position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#16171a;border:1px solid #333;border-radius:20px;padding:8px 16px;color:#fff;font:13px system-ui;z-index:999999;';
    lab.textContent='Click an element to block it (Esc to cancel)';
    tip.appendChild(lab);
    var cur=null;
    function clear(){if(cur){cur.style.outline='';cur=null;}}
    tip.addEventListener('mousemove',function(ev){
      var el=document.elementFromPoint(ev.clientX,ev.clientY);
      if(!el||el===tip||el===lab)return;
      clear();
      cur=el;el.style.outline='2px solid #f44';
    });
    function selectorFor(el){
      if(el.id)return '#'+CSS.escape(el.id);
      var p=[];
      var n=el, c=0;
      while(n&&n.nodeType===1&&c<4){
        var s=CSS.escape(n.tagName.toLowerCase());
        if(n.id)s+=' #'+CSS.escape(n.id);
        else if(n.className&&typeof n.className==='string'){
          var cls=n.className.trim().split(/\\s+/).slice(0,2).map(CSS.escape).join('.');
          if(cls)s+='.'+cls;
        }
        p.unshift(s);n=n.parentElement;c++;
      }
      return p.join(' > ');
    }
    tip.addEventListener('click',function(ev){
      ev.preventDefault();ev.stopPropagation();
      var el=cur||document.elementFromPoint(ev.clientX,ev.clientY);
      if(!el)return;
      var sel=selectorFor(el);
      var host=location.hostname;
      tip.remove();
      window.getSelection().removeAllRanges();
      // Send to host via the secure VIA: message bus.
      try{ window.__viaSend('markAd',{domain:host,selector:sel}); }catch(e){}
      // Also apply immediately via page-local hide + localStorage persistence.
      var style=document.createElement('style');style.textContent=sel+' { display: none !important; }';document.head.appendChild(style);
      var list=JSON.parse(localStorage.getItem('via.marked')||'[]');
      if(list.indexOf(sel)===-1)list.push(sel);
      localStorage.setItem('via.marked',JSON.stringify(list));
      var note=document.createElement('div');note.style.cssText='position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:16px;font:13px system-ui;z-index:999999;';
      note.textContent='Blocked: '+sel;document.documentElement.appendChild(note);
      setTimeout(function(){note.remove();},1800);
    });
    document.addEventListener('keydown',function kd(ev){if(ev.key==='Escape'){tip.remove();document.removeEventListener('keydown',kd);}},{once:false});
    document.documentElement.appendChild(tip);
  })()`;
  evalInActive(js).catch(()=>showToast("Mark as ad unavailable here"));
}
function textSizePick() { openPanel("textsize"); }
function clearDataNow() {
  closeOverlay();
  invoke("clear_data").then(() => showToast("Data cleared")).catch(()=>showToast("Failed to clear"));
}
function customizeMenu() { openPanel("customize"); }
function reloadActive() {
  closeOverlay();
  if (hasNavigated && activeId != null) invoke("eval_tab", { id: activeId, js: "location.reload()" }).catch(()=>{});
  else setHome(true);
}
function siteConfig() { openPanel("sitecfg"); }
function scriptsManager() { openPanel("scripts"); }
function printTab() {
  closeOverlay();
  evalInActive("window.print()").catch(()=>showToast("Print unavailable"));
}
let readerOn = false;
function readerMode() {
  closeOverlay();
  if (readerOn) {
    invoke<string>("reader_close").then(js => evalInActive(js)).catch(()=>{});
    readerOn = false;
    showToast("Reader closed");
    return;
  }
  invoke<string>("reader_bundle").then(js => evalInActive(js)).catch(() => showToast("Reader mode unavailable"));
  readerOn = true;
  showToast("Reader mode");
}
function openWith() {
  closeOverlay();
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : locationIt();
  invoke("open_external", { url }).then(()=>{}).catch(()=>showToast("Open with: choose your default browser"));
}
function toggleGame() {
  gameMode = !gameMode;
  persistSettings({ game_mode: gameMode });
  syncMenuUI(); showToast(gameMode ? "Game mode on — sniffer & extras off" : "Game mode off");
}
function addFavorite() {
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : "";
  if (!url) { showToast("Open a page first"); return; }
  invoke("add_bookmark", { url, title: t?.title || url, folder: "favorites" }).then(() => showToast("Added to favorites")).catch(() => showToast("Already added"));
}
function reportAbuse() {
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : "";
  closeOverlay();
  navigate("https://safebrowsing.google.com/safebrowsing/report_phish/?url=" + encodeURIComponent(url));
}
function openBookmarks() { closeOverlay(); openPanel("bookmarks"); }
function openHistoryPanel() { closeOverlay(); openPanel("history"); }
function openDownloads() { closeOverlay(); openPanel("downloads"); }
function toggleIncognito() {
  incognitoMode = !incognitoMode;
  persistSettings({ clear_on_exit: incognitoMode });
  syncMenuUI(); showToast(incognitoMode ? "Incognito on — no history, auto-clear" : "Incognito off");
}
function addBookmarkNow() {
  const t = tabs.find(x => x.id === activeId);
  const url = t?.url && !t.url.startsWith("about:") ? t.url : "";
  if (!url) { showToast("Open a page first"); return; }
  invoke("add_bookmark", { url, title: t?.title || url, folder: "" }).then(() => showToast("Bookmark added")).catch(() => showToast("Already bookmarked"));
}
function toggleDesktop() {
  desktopMode = !desktopMode;
  const ua = desktopMode ? "Desktop" : "Mobile";
  persistSettings({ desktop_mode: desktopMode, ua_mode: ua });
  if (hasNavigated && activeId != null) invoke("eval_tab", { id: activeId, js: "location.reload()" }).catch(()=>{});
  syncMenuUI(); showToast(desktopMode ? "Desktop site" : "Mobile site"); closeOverlay();
}
function toggleNight() {
  nightMode = !nightMode;
  persistSettings({ night_mode: nightMode });
  invoke("set_night_mode", { enabled: nightMode }).catch(()=>{});
  syncMenuUI(); showToast(nightMode ? "Night mode on" : "Night mode off"); closeOverlay();
}
function openSettingsPanel() { closeOverlay(); openPanel("settings"); }

// Panel handler registry (per menu item id)
const MENU_ACTIONS: Record<string, () => void> = {
  "m-find": findJs, "m-save": savePageNow, "m-saved": () => openDownloads(),
  "m-trans": translatePage, "m-src": viewSource, "m-full": toggleFullscreen,
  "m-imgs": toggleShowImages, "m-sniff": openSniffer, "m-ua": uaPanel,
  "m-netlog": toggleNetworkLog, "m-qr": scanQr, "m-homeadd": addToHome,
  "m-readaloud": toggleReadAloud, "m-ai": aiPanel, "m-orient": orientationPick,
  "m-adblock": toggleAdblock, "m-ad": markAsAdMode, "m-textsize": textSizePick,
  "m-clear": clearDataNow, "m-custommenu": customizeMenu, "m-reload": reloadActive,
  "m-sitecfg": siteConfig, "m-scripts": scriptsManager, "m-print": printTab,
  "m-reader": readerMode, "m-openwith": openWith, "m-game": toggleGame,
  "m-fav": addFavorite, "m-rpt": reportAbuse, "m-bkm": openBookmarks,
  "m-hist": openHistoryPanel, "m-down": openDownloads, "m-inco": toggleIncognito,
  "m-addbkm": addBookmarkNow, "m-desktop": toggleDesktop, "m-night": toggleNight,
  "m-settings": openSettingsPanel,
};

function getDefault(): Settings {
  return {
    homepage: "about:blank", search_engine: searchEngine, ua_mode: desktopMode ? "Desktop" : "Mobile",
    custom_ua: "", adblock_enabled: adblockOn, clear_on_exit: incognitoMode, user_js: "",
    night_mode: nightMode, desktop_mode: desktopMode, text_size: textSize, show_images: showImages,
    network_log: networkLog, search_suggest: false, game_mode: gameMode, read_aloud_enabled: readAloud,
    user_css: userCss, scripts, sites, pages_log: [],
  };
}
function persistSettings(mut?: Partial<Settings>) {
  try { invoke("set_settings", { settings: { ...getDefault(), ...(mut || {}) } }); } catch {}
}

/* ---- Session restore ("Restore tabs on startup") ---- */
function saveSession() {
  try {
    const urls = tabs.map(t => t.url).filter(u => u && u.startsWith("http"));
    localStorage.setItem("via.sessionTabs", JSON.stringify(urls));
  } catch {}
}
function sessionUrls(): string[] {
  try {
    const urls: string[] = JSON.parse(localStorage.getItem("via.sessionTabs") || "[]");
    return urls.filter(u => typeof u === "string" && u.startsWith("http"));
  } catch { return []; }
}

/* ---- Download category helpers ---- */
function dlExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
function dlCategory(name: string): string {
  const e = dlExt(name);
  if (["zip","rar","7z","tar","gz","bz2","xz","iso"].includes(e)) return "archives";
  if (e === "apk") return "apk";
  if (["mp4","mkv","avi","mov","wmv","flv","webm","m4v","ts"].includes(e)) return "video";
  if (["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","md","epub","mobi"].includes(e)) return "docs";
  if (["png","jpg","jpeg","gif","webp","bmp","svg","ico","raw"].includes(e)) return "images";
  if (["mp3","wav","flac","aac","ogg","m4a","opus","wma"].includes(e)) return "audio";
  if (e) return "other";
  return "other";
}
const DL_CATS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "archives", label: "Archives" },
  { id: "apk", label: "APK" },
  { id: "video", label: "Video" },
  { id: "docs", label: "Documents" },
  { id: "images", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "other", label: "Other" },
];
let dlCat = "all";

/* ---- Download helpers ---- */
function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}
function dlName(d: { path: string; url: string }): string {
  const f = d.path.split(/[\\/]/).pop();
  if (f) return f;
  try { return decodeURIComponent(new URL(d.url).pathname.split("/").pop() || d.url); } catch { return d.url; }
}
function dlRow(d: ActiveDl): string {
  const name = dlName(d);
  const done = d.done && d.success !== false;
  const failed = d.done && d.success === false;
  const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
  const bar = d.total > 0
    ? `<span class="dbar"><i style="width:${pct}%"></i></span>`
    : `<span class="dbar indet"><i></i></span>`;
  const stat = failed ? "Failed" : done ? "Completed" : d.total > 0 ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)}` : `${fmtBytes(d.received)} · downloading`;
  return `<div class="prow ${failed ? "failed" : done ? "done" : ""}" data-dl="${esc(d.path)}">
    <span class="ptitle">${esc(name)}</span>
    <div class="dmeta"><small>${esc(d.url)}</small><span class="dstat">${stat}</span></div>
    ${bar}
  </div>`;
}
function refreshDownloadRows() {
  const catsEl = q("dl-cats") as HTMLElement | null;
  if (catsEl) {
    catsEl.innerHTML = "";
    DL_CATS.forEach(c => {
      const b = document.createElement("button");
      b.className = "dl-cat" + (c.id === dlCat ? " on" : "");
      b.dataset.cat = c.id;
      b.textContent = c.label;
      b.onclick = () => { dlCat = c.id; rebuildChipCounts(); rerenderDlList(); };
      catsEl.appendChild(b);
    });
  }
  rebuildChipCounts();
  rerenderDlList();
}
function rebuildChipCounts() {
  const catsEl = q("dl-cats") as HTMLElement | null; if (!catsEl) return;
  const counts: Record<string, number> = {};
  activeDl.forEach(d => { const c = dlCategory(d.path || dlName(d)); counts[c] = (counts[c] || 0) + 1; });
  downloads.forEach(d => { const c = dlCategory(d.path || d.title); counts[c] = (counts[c] || 0) + 1; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  catsEl.querySelectorAll<HTMLElement>(".dl-cat").forEach(b => {
    const id = b.dataset.cat || "other";
    const n = id === "all" ? total : (counts[id] || 0);
    let cnt = b.querySelector(".cnt") as HTMLElement | null;
    if (!cnt) { cnt = document.createElement("span"); cnt.className = "cnt"; b.appendChild(cnt); }
    cnt.textContent = String(n);
    b.classList.toggle("on", id === dlCat);
  });
}
function rerenderDlList() {
  const list = q("dl-list") as HTMLElement | null; if (!list) return;
  const rows: string[] = [];
  activeDl.slice().reverse().forEach(d => {
    if (dlCat !== "all" && dlCategory(d.path || dlName(d)) !== dlCat) return;
    rows.push(dlRow(d));
  });
  downloads.forEach(d => {
    const name = dlName(d);
    if (dlCat !== "all" && dlCategory(d.path || d.title) !== dlCat) return;
    rows.push(`<div class="prow done" data-dl="${esc(d.path)}">
      <span class="ptitle">${esc(d.title || name)}</span>
      <div class="dmeta"><small>${esc(d.path)}</small>
        <button class="dopen" data-open="${esc(d.path)}" title="Open">↗</button>
        <span class="dstat">Completed</span></div>
      <span class="dbar"><i style="width:100%"></i></span>
    </div>`);
  });
  list.innerHTML = rows.join("") || "<div class='empty'>No downloads here yet</div>";
  list.querySelectorAll<HTMLElement>("[data-dl]").forEach(row => row.onclick = () => {
    const path = row.dataset.dl!; invoke("open_download", { path }).catch(() => showToast("File not found"));
  });
  list.querySelectorAll<HTMLElement>("[data-open]").forEach(b => b.onclick = (e: Event) => {
    e.stopPropagation(); invoke("reveal_download", { path: b.dataset.open }).catch(() => showToast("Reveal unavailable"));
  });
}

function renderBookmarks(filter = "") {
  const list = q("bm-list") as HTMLElement | null; if (!list) return;
  const f = filter.trim().toLowerCase();
  const rows = bookmarks.filter(b => !f || (b.title + " " + b.url).toLowerCase().includes(f))
    .map(b => `<div class="prow" data-url="${esc(b.url)}"><span class="ptitle">${esc(b.title || b.url)}</span><small>${esc(b.url)}</small></div>`)
    .join("") || "<div class='empty'>No bookmarks found</div>";
  list.innerHTML = rows;
  list.querySelectorAll<HTMLElement>("[data-url]").forEach(r => r.onclick = () => { closePanel(); navigate(r.dataset.url!); });
}
function renderHistory(filter = "") {
  const list = q("hi-list") as HTMLElement | null; if (!list) return;
  const f = filter.trim().toLowerCase();
  const rows = historyItems.slice(0, 200).filter(h => !f || (h.title + " " + h.url).toLowerCase().includes(f))
    .map(h => `<div class="prow" data-url="${esc(h.url)}"><span class="ptitle">${esc(h.title || h.url)}</span><small>${esc(h.url)}</small></div>`)
    .join("") || "<div class='empty'>No history found</div>";
  list.innerHTML = rows;
  list.querySelectorAll<HTMLElement>("[data-url]").forEach(r => r.onclick = () => { closePanel(); navigate(r.dataset.url!); });
}

/* ---- Panels (bookmarks/history/downloads/settings/etc.) ---- */
function qs<T extends HTMLElement = HTMLElement>(sel: string): T { return document.querySelector(sel) as T; }
function panelHTML(title: string, body: string, page = false): string {
  const ph = page
    ? `<div class="ph"><button class="close" id="p-close" title="Back">‹</button><b>${title}</b><span style="width:34px"></span></div>`
    : `<div class="ph"><span class="grip"></span><b>${title}</b><button class="close" id="p-close">✕</button></div>`;
  // IMPORTANT: returns only the .ph/.pb shell, NOT a .pc wrapper.
  // openPanel() creates a single <div class="pc"> ("p") and injects this
  // shell into it. If panelHTML wrapped the shell in another .pc, the CSS
  // #panel .pc { transform: translateX(100%) } would hide BOTH copies and the
  // inner one (which holds the content) could never slide in -> blank screen.
  return `${ph}<div class="pb">${body}</div>`;
}
function closePanel() {
  const p = q("panel"); if (p) p.remove();
  overlay = "none"; panelKind = null;
  if (hasNavigated) showActiveWebview();
}
async function openPanel(kind: string, arg?: string) {
  closePanel();
  overlay = "panel"; panelKind = kind;
  // Do NOT hide the native webview here: if panel rendering below throws,
  // the user would be stuck on a black void. Hide only after the DOM has
  // appended and all bindings succeeded (end of the try block).
  const body = document.createElement("div"); body.id = "panel";
  const page = ["bookmarks", "history", "downloads", "settings"].includes(kind);
  if (page) body.className = "pg";
  const p = document.createElement("div"); p.className = "pc";
  let title = ""; let content = "";
  const close = () => closePanel();

  const mkBtn = (label: string, act: () => void) => { const b = document.createElement("button"); b.className = "pbtn"; b.textContent = label; b.onclick = act; return b; };

  try {
  if (kind === "bookmarks") {
    title = "Bookmarks";
    bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
    content = `<div class="prow"><input class="pinput" id="bm-search" placeholder="Search bookmarks…"></div>
      <div class="plist" id="bm-list"></div>`;
  } else if (kind === "history") {
    title = "History";
    historyItems = await invoke<HistItem[]>("list_history").catch(() => []);
    content = `<div class="prow"><input class="pinput" id="hi-search" placeholder="Search history…"></div>
      <div class="plist" id="hi-list"></div>
      <button class="pbtn danger" id="hclear">Clear history</button>`;
  } else if (kind === "downloads") {
    title = "Downloads";
    downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);
    content = `<div id="dl-cats"></div>
      <div class="plist" id="dl-list"></div>
      <div class="empty" style="text-align:center">Files are saved to your OS Downloads folder. Hover a row and tap ↗ to reveal it.</div>`;
  } else if (kind === "settings") {
    title = "Settings";
    const sw = (key: string, label: string, desc: string, on: boolean) =>
      `<div class="setrow"><div><div class="lbl">${label}</div>${desc ? `<div class="desc">${desc}</div>` : ""}</div><div class="ctrl"><button class="switch ${on ? "on" : ""}" data-set="${key}"></button></div></div>`;
    const act = (key: string, label: string, desc: string, value: string) =>
      `<div class="setrow"><div><div class="lbl">${label}</div>${desc ? `<div class="desc">${desc}</div>` : ""}</div><div class="ctrl"><button class="pbtn" data-act="${key}">${value}</button></div></div>`;
    content = `
      <div class="settabs">
        <button class="settab on" data-cat="general">General</button>
        <button class="settab" data-cat="custom">Customization</button>
        <button class="settab" data-cat="privacy">Privacy</button>
        <button class="settab" data-cat="advanced">Advanced</button>
        <button class="settab" data-cat="scripts">Scripts</button>
        <button class="settab" data-cat="about">About</button>
      </div>
      <div class="setcat" id="cat-general">
        <div class="setrow"><div><div class="lbl">Search engine</div></div><div class="ctrl">
          <select class="pselect" id="set-engine">
            ${Object.keys(ENGINES).map(e => `<option ${e === searchEngine ? "selected" : ""}>${e}</option>`).join("")}
          </select></div></div>
        ${sw("restore", "Restore tabs on startup", "Reopen last session tabs on launch", restoreTabs)}
        ${sw("clear", "Clear data on exit", "Auto-erase history/cache when closing (Incognito)", incognitoMode)}
      </div>
      <div class="setcat" id="cat-custom" hidden>
        ${sw("night", "Night mode", "Invert page colors with a dark filter", nightMode)}
        ${sw("images", "Show images", "Display images on web pages", showImages)}
        ${act("textsize", "Text size", "", Math.round(textSize * 100) + "%")}
        ${act("ua", "User-Agent", "", desktopMode ? "Desktop" : "Mobile")}
      </div>
      <div class="setcat" id="cat-privacy" hidden>
        ${sw("adb", "Ad blocking", "Block requests/cosmetic ads (EasyList-style)", adblockOn)}
        ${act("cleardata", "Clear browsing data", "Cookies, cache, history and local storage", "Clear now")}
      </div>
      <div class="setcat" id="cat-advanced" hidden>
        ${sw("netlog", "Network log", "Capture requests into the Network log panel", networkLog)}
        <div class="setrow"><div><div class="lbl">Custom CSS</div><div class="desc">Inject a style into every page</div></div></div>
        <textarea class="ptext" id="set-css" placeholder="body { }">${esc(userCss)}</textarea>
        <button class="pbtn primary" data-act="savecss">Apply CSS</button>
      </div>
      <div class="setcat" id="cat-scripts" hidden>
        ${act("scripts", "Userscripts", "Add, edit and delete Tampermonkey-style scripts", "Manage")}
      </div>
      <div class="setcat" id="cat-about" hidden>
        <div class="setrow"><div><div class="lbl">Via Browser</div><div class="desc">PC port 7.2.1 · Tauri 2 + WebView2</div></div><div class="ctrl"><span class="pin">✓</span></div></div>
        <div class="setrow"><div><div class="lbl">Engine</div><div class="desc">OS-native Microsoft Edge WebView2</div></div></div>
        <div class="setrow"><div><div class="lbl">Homepage</div><div class="desc">Local pure-black start screen (no remote site)</div></div></div>
        ${act("export", "Export backup", "Save bookmarks, history, settings and scripts to a .via file", "Export")}
        ${act("import", "Import backup", "Restore from the newest .via file in your Downloads folder", "Import")}
      </div>`;
  } else if (kind === "scripts") {
    title = "Scripts";
    const rows = scripts.map((sc, i) => `<div class="prow"><span class="ptitle">${esc(sc.name || "Script")}</span><small>${esc(sc.match_urls || "all pages")}</small><button class="pbtn" data-del="${i}">Delete</button></div>`).join("") || "<div class='empty'>No scripts yet</div>";
    content = `<div class="plist">${rows}</div>
      <button class="pbtn primary" id="sc-new">+ New script</button>
      <div id="sc-edit"></div>`;
  } else if (kind === "sitecfg") {
    title = "Site configuration";
    const rows = sites.map((sc, i) => `<div class="prow"><span class="ptitle">${esc(sc.host)}</span><small>UA: ${sc.ua_mode || "default"} · Adblock: ${sc.adblock_enabled ? "on" : "off"}</small><button class="pbtn" data-rm="${i}">Remove</button></div>`).join("") || "<div class='empty'>No per-site config</div>";
    content = `<div class="plist">${rows}</div>
      <div class="prow"><input class="pinput" id="sc-host" placeholder="example.com"></div>
      <div class="prow"><select class="pselect" id="sc-ua"><option value="">Default</option><option>Desktop</option><option>Mobile</option></select>
      <label><input type="checkbox" id="sc-adb" checked> Adblock on</label></div>
      <button class="pbtn primary" id="sc-save">Add site config</button>`;
  } else if (kind === "ua") {
    title = "User-agent";
    content = `<div class="plist">
      <div class="prow" data-ua="Desktop"><span class="ptitle">Desktop</span><small>Windows desktop UA</small>${desktopMode ? " <span class='pin'>✓</span>" : ""}</div>
      <div class="prow" data-ua="Mobile"><span class="ptitle">Mobile</span><small>Android phone UA</small>${!desktopMode ? " <span class='pin'>✓</span>" : ""}</div>
      <div class="prow" data-ua="Via"><span class="ptitle">Via Mobile</span><small>Via/7.2.1 UA</small></div>
    </div><button class="pbtn" id="ua-default">Reset to default</button>`;
  } else if (kind === "textsize") {
    title = "Text size";
    content = `
      <div class="prow"><span class="ptitle">${Math.round(textSize * 100)}%</span>
        <input type="range" id="ts-range" min="0.5" max="2" step="0.1" value="${textSize}"></div>
      <div class="prow"><button class="pbtn" id="ts-reset">Reset to 100%</button></div>`;
  } else if (kind === "customize") {
    title = "Customize menu";
    const hidden = menuHiddenIds();
    const ids = Object.keys(MENU_ACTIONS);
    const rows = ids.map(id => {
      const m = MENUS.find(x => x.id === id);
      if (!m) return "";
      const off = hidden.includes(id) ? " off" : "";
      return `<div class="prow${off}" data-cid="${id}"><span class="ptitle">${esc(m.label)}</span><span class="pin">${hidden.includes(id) ? "✕" : "✓"}</span></div>`;
    }).join("");
    content = `<div class="plist" id="cust-list">${rows}</div><div class="empty">Tap an item to show/hide it in the main menu</div>`;
  } else if (kind === "sniff") {
    title = "Network log";
    let logRows: string[][] = [];
    try { logRows = await invoke<string[][]>("network_log", { rows: [], clear: false }); } catch {}
    const all: string[] = [];
    logRows.slice(-200).forEach(r => { if (r[0] && !all.includes(r[0])) all.push(r[0]); });
    snifferItems.forEach(u => { if (u && !all.includes(u)) all.push(u); });
    content = `<div class="plist" id="sniff-list">${all.map(u => `<div class="prow"><a class="ptitle" href="${esc(u)}" target="_blank">${esc(u)}</a></div>`).join("") || "<div class='empty'>Enable Network log, then load a page to capture requests</div>"}</div><button class="pbtn danger" id="log-clear">Clear log</button>`;
  } else if (kind === "qr") {
    title = "QR code";
    content = `<div class="prow"><span class="ptitle">${esc(arg || "")}</span></div>
      <div class="qr" id="qr-box"></div>
      <div class="empty">Install the QR extension or use your camera phone (URL copied to clipboard)</div>`;
  } else if (kind === "orient") {
    title = "Orientation";
    content = `<div class="prow"><button class="pbtn" id="or-port">Portrait (9:16)</button><button class="pbtn" id="or-land">Landscape (16:9)</button><button class="pbtn" id="or-def">Reset</button></div>`;
  } else if (kind === "ai") {
    title = "AI assistant";
    content = `<div class="prow"><span class="ptitle">Select an AI service to open in a new tab</span></div>
      <div class="plist">
        <div class="prow" data-ai="https://chat.openai.com"><span class="ptitle">ChatGPT</span></div>
        <div class="prow" data-ai="https://gemini.google.com"><span class="ptitle">Gemini</span></div>
        <div class="prow" data-ai="https://claude.ai"><span class="ptitle">Claude</span></div>
      </div>`;
  } else {
    title = "Via Browser";
    content = `<div class="empty">Feature panel</div>`;
  }

  p.innerHTML = panelHTML(title, content, page);
  p.className = page ? "pc pg" : "pc";
  body.appendChild(p);
  // Attach the panel to the document BEFORE binding handlers: document-scoped
  // queries (qs) below must be able to find the injected elements, otherwise
  // every panel crashes with a silent null reference.
  document.body.appendChild(body);
  const pc = p as HTMLElement;
  const pbx = p.querySelector(".pb") as HTMLElement;
  qs("#p-close").onclick = () => {
    if (page) { pc.classList.add("out"); setTimeout(close, 180); } else close();
  };
  // slide-in animation
  requestAnimationFrame(() => pc.classList.add("on"));
  if (page) { pbx.style.paddingTop = "16px"; }
  // overlay click to close
  p.addEventListener("mousedown", (e) => { if (e.target === p) close(); });

  // per-panel bindings
  if (kind === "bookmarks") {
    renderBookmarks();
    qs("#bm-search").oninput = (e: any) => renderBookmarks((e.target as HTMLInputElement).value);
  }
  if (kind === "history") {
    renderHistory();
    qs("#hi-search").oninput = (e: any) => renderHistory((e.target as HTMLInputElement).value);
    qs("#hclear").onclick = async () => { invoke("clear_history"); historyItems = []; renderHistory(""); showToast("History cleared"); };
  }
  if (kind === "sniff") {
    const lc = p.querySelector("#log-clear") as HTMLElement; if (lc) lc.onclick = async () => { await invoke("network_log", { rows: [], clear: true }); closePanel(); openPanel("sniff"); };
  }
  if (kind === "downloads") {
    refreshDownloadRows(); // renders category chips + unified live list
  }
  if (kind === "scripts") {
    qs("#sc-new").onclick = () => {
      const sc: UserScript = { id: "sc" + Date.now(), name: "New script", match_urls: "", code: "", enabled: true };
      const ed = qs("#sc-edit");
      ed.innerHTML = `<div class="prow"><input class="pinput" id="ed-name" value="New script" placeholder="name"></div>
        <div class="prow"><input class="pinput" id="ed-match" placeholder="URL pattern (regex, empty=all)"></div>
        <textarea class="ptext" id="ed-code" placeholder="// your JS here"></textarea>
        <button class="pbtn primary" id="ed-save">Save script</button>`;
      qs("#ed-save").onclick = async () => {
        sc.name = (qs("#ed-name") as HTMLInputElement).value || "New script";
        sc.match_urls = (qs("#ed-match") as HTMLInputElement).value;
        sc.code = (qs("#ed-code") as HTMLTextAreaElement).value;
        scripts.push(sc);
        await invoke("save_script", { script: sc }).catch(()=>{});
        persistSettings({ scripts });
        closePanel(); openPanel("scripts"); showToast("Script saved (reload page to apply)");
      };
    };
    (p.querySelectorAll<HTMLElement>("[data-del]")).forEach(b => b.onclick = async () => {
      const i = +b.dataset.del!; const sc = scripts[i]; if (!sc) return;
      scripts.splice(i, 1); await invoke("delete_script", { id: sc.id }).catch(()=>{}); persistSettings({ scripts });
      closePanel(); openPanel("scripts");
    });
  }
  if (kind === "sitecfg") {
    qs("#sc-save").onclick = async () => {
      const host = (qs("#sc-host") as HTMLInputElement).value.trim();
      if (!host) { showToast("Enter a host"); return; }
      const cfg: SiteConfig = { host, ua_mode: (qs("#sc-ua") as HTMLSelectElement).value, adblock_enabled: (qs("#sc-adb") as HTMLInputElement).checked };
      sites = sites.filter(x => x.host !== host); sites.push(cfg);
      await invoke("save_site_config", { cfg }).catch(()=>{}); persistSettings({ sites });
      closePanel(); openPanel("sitecfg"); showToast("Site config saved");
    };
    (p.querySelectorAll<HTMLElement>("[data-rm]")).forEach(b => b.onclick = async () => {
      const i = +b.dataset.rm!; const sc = sites[i]; if (!sc) return;
      sites.splice(i, 1); await invoke("delete_site_config", { host: sc.host }).catch(()=>{}); persistSettings({ sites });
      closePanel(); openPanel("sitecfg");
    });
  }
  if (kind === "ua") {
    (p.querySelectorAll<HTMLElement>("[data-ua]")).forEach(row => row.onclick = () => {
      const mode = row.dataset.ua!;
      desktopMode = mode === "Desktop";
      persistSettings({ desktop_mode: desktopMode, ua_mode: mode });
      if (hasNavigated && activeId != null) invoke("eval_tab", { id: activeId, js: "location.reload()" }).catch(()=>{});
      closePanel(); syncMenuUI(); showToast("User-agent: " + mode);
    });
    qs("#ua-default").onclick = () => { desktopMode = true; persistSettings({ desktop_mode: true, ua_mode: "Desktop" }); closePanel(); showToast("UA reset"); };
  }
  if (kind === "textsize") {
    qs("#ts-range").oninput = (e: any) => { textSize = +e.target.value; (qs(".ptitle") as HTMLElement).textContent = Math.round(textSize*100) + "%"; };
    qs("#ts-reset").onclick = () => { textSize = 1; persistSettings({ text_size: 1 }); showToast("Text size reset"); closePanel(); };
    const range = qs("#ts-range"); const commit = () => { persistSettings({ text_size: textSize }); evalInActive("location.reload()").catch(()=>{}); showToast("Text size set"); closePanel(); };
    range.onchange = commit;
  }
  if (kind === "customize") {
    (p.querySelectorAll<HTMLElement>("#cust-list .prow")).forEach(row => {
      row.onclick = () => {
        const id = row.dataset.cid!;
        let hidden = menuHiddenIds();
        const idx = hidden.indexOf(id);
        if (idx !== -1) hidden.splice(idx, 1); else hidden.push(id);
        localStorage.setItem("via.menuHidden", JSON.stringify(hidden));
        row.classList.toggle("off", idx !== -1);
        (row.querySelector(".pin") as HTMLElement).textContent = idx !== -1 ? "✓" : "✕";
        buildMenuUI();
      };
    });
  }
  if (kind === "sniff") {
    (p.querySelectorAll<HTMLElement>("#sniff-list a")).forEach(a => a.onclick = (e) => { e.preventDefault(); window.open(a.getAttribute("href")!, "_blank"); });
  }
  if (kind === "qr") {
    // Simple clipboard copy + show a QR via external image is not feasible offline; show URL.
    const box = qs("#qr-box");
    box.innerHTML = `<code style="word-break:break-all;font-size:11px;">${esc(arg || "")}</code>`;
    navigator.clipboard?.writeText(arg || "").catch(()=>{});
  }
  if (kind === "orient") {
    const fs = getCurrentWindow();
    qs("#or-port").onclick = () => { fs.setSize(new LogicalSize(450, 900)); closePanel(); };
    qs("#or-land").onclick = () => { fs.setSize(new LogicalSize(1000, 600)); closePanel(); };
    qs("#or-def").onclick = () => { fs.setSize(new LogicalSize(1280, 800)); closePanel(); };
  }
  if (kind === "ai") {
    (p.querySelectorAll<HTMLElement>("[data-ai]")).forEach(row => row.onclick = () => { closePanel(); createTab(row.dataset.ai!); });
  }
  if (kind === "settings") {
    // Tab switching
    (p.querySelectorAll<HTMLElement>(".settab")).forEach(t => t.onclick = () => {
      (p.querySelectorAll<HTMLElement>(".settab")).forEach(x => x.classList.remove("on"));
      t.classList.add("on");
      (p.querySelectorAll<HTMLElement>(".setcat")).forEach(c => (c as HTMLElement).hidden = true);
      (qs("#cat-" + t.dataset.cat) as HTMLElement).hidden = false;
    });
    // Toggle switches (inline so the panel stays open; persists immediately)
    (p.querySelectorAll<HTMLElement>("[data-set]")).forEach(b => b.onclick = () => {
      const k = b.dataset.set!;
      const on = !b.classList.contains("on");
      b.classList.toggle("on", on);
      switch (k) {
        case "restore":
          restoreTabs = on; localStorage.setItem("via.restoreTabs", on ? "1" : "0");
          if (on) saveSession();
          showToast(on ? "Restore tabs on startup: on" : "Restore tabs on startup: off");
          break;
        case "clear":
          incognitoMode = on; persistSettings({ clear_on_exit: on }); syncMenuUI();
          showToast(on ? "Incognito on — clears data on exit" : "Incognito off");
          break;
        case "night":
          nightMode = on; persistSettings({ night_mode: on });
          invoke("set_night_mode", { enabled: on }).catch(()=>{}); syncMenuUI();
          break;
        case "images":
          showImages = on; persistSettings({ show_images: on }); syncMenuUI();
          evalInActive(`var s=document.getElementById('via-img');if(s)s.remove();if(${on ? "false" : "true"}){s=document.createElement('style');s.id='via-img';s.textContent='img,picture,video{{visibility:hidden!important}}';document.documentElement.appendChild(s);}`).catch(()=>{});
          break;
        case "adb":
          adblockOn = on; persistSettings({ adblock_enabled: on }); syncMenuUI();
          evalInActive(`var s=document.querySelectorAll('style[data-via]');s.forEach(function(x){x.remove();});location.reload();`).catch(()=>{});
          break;
        case "netlog":
          networkLog = on; persistSettings({ network_log: on }); syncMenuUI();
          if (on && hasNavigated) invoke("eval_tab", { id: activeId!, js: "location.reload()" }).catch(()=>{});
          break;
      }
      showToast("Saved");
    });
    // Action buttons
    (p.querySelectorAll<HTMLElement>("[data-act]")).forEach(b => b.onclick = () => {
      const k = b.dataset.act!;
      switch (k) {
        case "textsize": closePanel(); openPanel("textsize"); break;
        case "ua": closePanel(); openPanel("ua"); break;
        case "cleardata": closePanel(); clearDataNow(); break;
        case "scripts": closePanel(); openPanel("scripts"); break;
        case "export":
          invoke<string>("export_backup").then(path => showToast("Backup saved: " + path.split(/[\\/]/).pop())).catch(() => showToast("Export failed"));
          break;
        case "import":
          invoke("import_latest_backup").then(() => showToast("Backup restored")).catch(() => showToast("No .via backup found in Downloads"));
          break;
        case "savecss":
          userCss = (qs("#set-css") as HTMLTextAreaElement).value;
          persistSettings({ user_css: userCss });
          evalInActive(`var s=document.getElementById('via-css');if(s)s.remove();if(${JSON.stringify(userCss)}){s=document.createElement('style');s.id='via-css';s.textContent=${JSON.stringify(userCss)};document.documentElement.appendChild(s);}`).catch(()=>{});
          showToast("CSS applied (reload to persist)");
          break;
      }
    });
    // Search engine select persists immediately
    qs("#set-engine").onchange = () => {
      searchEngine = (qs("#set-engine") as HTMLSelectElement).value;
      persistSettings({ search_engine: searchEngine });
      showToast("Search engine: " + searchEngine);
    };
  }

  // Panel DOM is now fully appended and every binding succeeded — only now is
  // it safe to hide the native webview so the HTML overlay is visible.
  await hideActiveWebview();
  } catch (err) {
    // Recovery: never leave the user staring at a black void. Remove the
    // half-built panel and reveal the webview/homepage again.
    console.error("[via] panel render failed:", kind, err);
    const failed = q("panel"); if (failed) failed.remove();
    overlay = "none"; panelKind = null;
    await showActiveWebview();
    if (!hasNavigated) setHome(true);
    showToast("Error loading panel");
  }

}

/* ---- Keyboard ---- */
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); createTab(undefined, true); setHome(true); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") { e.preventDefault(); if (activeId != null) closeTab(activeId); }
  if (e.key === "F5") { e.preventDefault(); reloadT(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); openAddr(); }
});

/* ---- Backend events ---- */
listen<{ id: number; url: string }>("tab-url", ev => {
  const t = tabs.find(x => x.id === ev.payload.id); if (t) { t.url = ev.payload.url; renderTabGrid(); }
  readerOn = false;
  if (!incognitoMode && ev.payload.url && !ev.payload.url.startsWith("about:")) {
    invoke("add_history", { url: ev.payload.url, title: t?.title || ev.payload.url }).catch(()=>{});
  }
  if (restoreTabs) saveSession();
});
listen<{ id: number; title: string }>("tab-title", ev => { const t = tabs.find(x => x.id === ev.payload.id); if (t) { t.title = ev.payload.title; renderTabGrid(); } });

const DL_URL_RE = /\.(apk|xapk|zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|msix|deb|rpm|dmg|pkg|torrent|mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|mpg|mpeg|3gp|mp3|wav|flac|aac|ogg|m4a|opus|wma|pdf|epub|mobi|doc|docx|xls|xlsx|ppt|pptx)([?#]|$)/i;
function isDlUrl(u: string) { try { return !!new URL(u).pathname.match(DL_URL_RE); } catch { return false; } }
function startDl(u: string, filename: string | null = null) {
  showToast("Downloading…");
  invoke<string>("download_from_js", { url: u, filename: filename || null })
    .then((path: string) => showToast("Saved: " + path.split(/[\\/]/).pop()))
    .catch((err: any) => {
      console.error("[via] download failed:", err);
      showToast("Download failed");
    });
}

// target="_blank" / window.open links: WebView2 asks for a new native window.
// Rust denies that OS window and forwards the URL here so we open a real tab
// in THIS window instead. Download links routed this way still trigger the
// active tab's on_download handler (toast + progress + save-to-Downloads).
listen<{ url: string }>("new-window-request", async ev => {
  const u = ev.payload?.url;
  if (!u || u.startsWith("about:")) return;
  // Files opened via target="_blank" are downloads: brute-force them straight
  // to the OS Downloads folder instead of opening a (blank) tab. blob/data
  // URLs are page-local and usually already fired via <a download>.
  if (u.startsWith("blob:") || u.startsWith("data:") || isDlUrl(u)) {
    // Page-local blob/data URLs can't be re-opened in another webview;
    // sites that produce them use <a download> so the download already
    // fired inside the page. Nothing to open here.
    if (isDlUrl(u)) startDl(u);
    else console.log("[via] ignoring page-local new-window URL:", u.slice(0, 64));
    return;
  }
  try {
    await createTab(u, true); // hidden webview created and loading u
    hasNavigated = true;
    setHome(false);
    stage.style.display = "block";
    await showActiveWebview();
    renderTabGrid();
    console.log("[via] target=_blank opened in new tab:", u);
  } catch (err) {
    console.error("[via] new-window-request failed:", u, err);
    showToast("Could not open link");
  }
});

// "Download started" toast + HEAD probe the moment WebView2 requests a file.
listen<{ id: number | null; url: string; path: string }>("download-started", ev => {
  const d = ev.payload;
  showToast("Download started…");
  if (d.url.startsWith("http")) {
    evalInActive(`fetch(${JSON.stringify(d.url)},{method:'HEAD',cache:'no-store'}).then(function(r){var l=+r.headers.get('content-length');if(l>0)window.__viaSend('dlTotal',{url:${JSON.stringify(d.url)},len:l});}).catch(function(){})`).catch(()=>{});
  }
});

// Native WebView2 download events (Requested/Finished) from Rust.
listen<{ id: number | null; url: string; path: string; done: boolean; success?: boolean }>("download-progress", ev => {
  const d = ev.payload;
  const existing = activeDl.find(x => x.url === d.url);
  if (existing) {
    existing.done = d.done || existing.done;
    if (d.success !== undefined) existing.success = d.success;
  } else {
    activeDl.push({ url: d.url, path: d.path, received: 0, total: 0, done: !!d.done, success: d.success });
  }
  if (d.done) showToast(d.success === false ? "Download failed" : "Download complete");
  if (overlay === "panel") refreshDownloadRows();
});

// Host finished streaming a JS-fallback download (download_from_js).
listen<{ id: number | null; url: string; path: string; done: boolean; success?: boolean }>("download-finished", ev => {
  const d = ev.payload;
  const existing = activeDl.find(x => x.url === d.url);
  if (existing) {
    existing.done = true;
    if (d.success !== undefined) existing.success = d.success;
  } else {
    activeDl.push({ url: d.url, path: d.path, received: 0, total: 0, done: true, success: d.success });
  }
  showToast(d.success === false ? "Download failed" : "Download complete");
  if (overlay === "panel") refreshDownloadRows();
});

// Poll disk size for active downloads so the panel shows real byte progress.
// (WebView2 writes to the destination path while downloading.)
setInterval(async () => {
  if (!activeDl.length || overlay !== "panel") return;
  for (const dl of activeDl) {
    if (dl.done) continue;
    if (dl.path) {
      const sz = await invoke<number>("file_size", { path: dl.path }).catch(() => dl.received);
      if (sz >= dl.received) dl.received = sz;
    }
    // Guess a total when unknown: scale dislikes unknown, but we show an
    // indeterminate bar in that case, so only refine when size makes sense.
  }
  refreshDownloadRows();
}, 800);

// Secure page->host bridge messages (VIA: prefix, forwarded by Rust).
listen<{ id: number; msg: string }>("via-msg", async ev => {
  let arr: any[] = [];
  try { arr = JSON.parse(ev.payload.msg); } catch { return; }
  const [action, data] = arr;
  if ((action === "download" || action === "startDl") && data?.url) {
    invoke<string>("download_from_js", { url: data.url, filename: data?.filename || null })
      .then((path: string) => showToast("Saved: " + path.split(/[\\/]/).pop()))
      .catch((err: any) => {
        console.error("[via] download failed:", err);
        showToast("Download failed");
      });
  } else if (action === "saveBlob" && data?.url && data?.bytes) {
    invoke<string>("save_blob_download", { url: data.url, filename: data?.filename || null, bytes: data.bytes })
      .then((path: string) => showToast("Saved: " + path.split(/[\\/]/).pop()))
      .catch((err: any) => {
        console.error("[via] blob download failed:", err);
        showToast("Download failed");
      });
  } else if (action === "dlTotal" && data?.url && data?.len > 0) {
    const dl = activeDl.find(x => x.url === data.url);
    if (dl) { dl.total = data.len; if (overlay === "panel") refreshDownloadRows(); }
  } else if (action === "markAd" && data?.selector) {
    const host = data.domain || "";
    try { await invoke("mark_as_ad", { domain: host, selector: data.selector }); } catch {}
    // Re-inject so the new rule applies immediately.
    await invoke("eval_tab", { id: ev.payload.id, js: "location.reload()" }).catch(()=>{});
    showToast("Marked as ad: " + data.selector);
  } else if (action === "savePage" && data?.html) {
    const wrap = (window as any).__viaSavePage;
    const url = data.url || wrap?.url || locationIt();
    const title = (data.title && data.title.indexOf("VIA:") !== 0 ? data.title : null) || wrap?.title || "page";
    invoke("save_page", { url, html: data.html, title }).then(() => showToast("Page saved to Downloads")).catch(() => showToast("Save failed"));
  } else if (action === "netlog" && data?.url) {
    if (networkLog) {
      const t = tabs.find(x => x.id === ev.payload.id);
      const row = [data.url, data.type || "request", String(Date.now())];
      invoke("network_log", { rows: [row], clear: false }).catch(()=>{});
      snifferItems.push(data.url);
    }
  }
});

/* ---- Boot: show pure-black homepage, webview hidden ---- */
(async () => {
  try {
    const s: Settings = await invoke("get_settings");
    searchEngine = s.search_engine; nightMode = s.night_mode; desktopMode = s.desktop_mode;
    textSize = s.text_size || 1; showImages = s.show_images !== false; networkLog = !!s.network_log;
    gameMode = !!s.game_mode; readAloud = !!s.read_aloud_enabled; adblockOn = s.adblock_enabled !== false;
    scripts = s.scripts || []; sites = s.sites || []; userCss = s.user_css || "";
  } catch {}
  // Load "Restore tabs on startup" preference and reopen last session.
  try { restoreTabs = localStorage.getItem("via.restoreTabs") === "1"; } catch {}
  await createTab(undefined, true); // create a tab; webview stays hidden (about:blank)
  const session = restoreTabs ? sessionUrls() : [];
  if (session.length) {
    hasNavigated = true; setHome(false);
    await navigate(session[0]);
    for (let i = 1; i < session.length; i++) await createTab(session[i], true);
    // Re-select the first restored tab so the visible webview matches the active id
    // (the async tab-url event may not have fired yet, so mirror the URL locally).
    if (tabs[0]) { tabs[0].url = session[0]; renderTabGrid(); await selectTab(tabs[0].id); }
  }
  buildMenuUI();
  setHome(session.length ? false : true); // black homepage (or restored webview)
  hideActiveWebview();
})();
