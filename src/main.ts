import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/* ---- Types ---- */
type Tab = { id: number; url: string; title: string; loading: boolean; active: boolean };
type Settings = {
  homepage: string; search_engine: string; ua_mode: string; custom_ua: string;
  adblock_enabled: boolean; clear_on_exit: boolean; user_css: string; user_js: string;
  night_mode: boolean; desktop_mode: boolean;
};

const ENGINES: Record<string, string> = {
  Google: "https://www.google.com/search?q=", Bing: "https://www.bing.com/search?q=",
  DuckDuckGo: "https://duckduckgo.com/?q=", Baidu: "https://www.baidu.com/s?wd=",
};
const QUICS = [
  { n: "Google", u: "https://www.google.com", i: "G" }, { n: "YouTube", u: "https://www.youtube.com", i: "▶" },
  { n: "X", u: "https://x.com", i: "𝕏" }, { n: "Reddit", u: "https://www.reddit.com", i: "R" },
  { n: "Wiki", u: "https://en.wikipedia.org", i: "W" }, { n: "GitHub", u: "https://github.com", i: "⌥" },
  { n: "DDG", u: "https://duckduckgo.com", i: "D" }, { n: "Bing", u: "https://www.bing.com", i: "B" },
];

/* ---- State ---- */
let tabs: Tab[] = [];
let activeId: number | null = null;
let nightMode = false;
let desktopMode = true;
let searchEngine = "Google";
let hasNavigated = false;          // true once the user navigates off the homepage
let overlay: "none" | "addr" | "tabs" | "menu" = "none";

const q = (id: string) => document.getElementById(id) as any;

/* ---- Build DOM ---- */
q("app").innerHTML = `
<div id="stage"></div>
<div id="home" class="show">
  <div class="logo">Via<span class="sub">Browser</span></div>
  <div class="pill" id="pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg><span id="pill-text">Search</span></div>
  <div class="grid" id="quick-grid"></div>
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
const stage = q("stage"), homeEl = q("home"), pill = q("pill"), quickGrid = q("quick-grid");
const addr = q("addr"), acancel = q("acancel"), ainput = q("ainput"), sug = q("sug");
const tabsEl = q("tabs"), tabX = q("tab-x"), tabGrid = q("tab-grid"), tabNew = q("tab-new");
const menuEl = q("menu"), menuGrid = q("menu-grid");
const nb = q("nb"), nf = q("nf"), nh = q("nh"), nt = q("nt"), nm = q("nm");
const badge = q("badge"), toastEl = q("toast");

/* ---- Quick sites ---- */
QUICS.forEach(s => {
  const d = document.createElement("div"); d.className = "tile";
  d.innerHTML = `<div class="ic">${s.i}</div><span>${s.n}</span>`;
  d.onclick = () => navigate(s.u);
  quickGrid.appendChild(d);
});

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

/* ---- Overlays ---- */
function openAddr() {
  overlay = "addr"; addr.classList.add("open");
  hideActiveWebview(); // hide native webview so the address overlay is visible
  setTimeout(() => { ainput.focus(); ainput.select(); }, 30);
}
function closeOverlay() {
  const wasOpen = overlay !== "none";
  addr.classList.remove("open"); tabsEl.classList.remove("show"); menuEl.classList.remove("show");
  overlay = "none"; ainput.value = ""; sug.classList.remove("open");
  if (wasOpen && hasNavigated) showActiveWebview(); // restore webview if we navigated away from home
}

/* ---- URL helpers ---- */
function searchUrl(engine: string, q2: string) { return (ENGINES[engine] || ENGINES.Bing) + encodeURIComponent(q2); }
function norm(input: string): string {
  const t = input.trim(); if (!t) return "https://www.bing.com";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/:].*)?$/i.test(t) && !t.includes(" ")) return "https://" + t;
  return searchUrl(searchEngine, t);
}
async function goAddr() {
  const v = ainput.value; const wasOpen = overlay === "addr";
  closeOverlay();
  if (v.trim()) await navigate(norm(v));
  else if (wasOpen) setHome(true);
}
let sugT: any;
async function doSuggest() {
  const q2 = ainput.value.trim(); if (!q2) { sug.classList.remove("open"); return; }
  try {
    const items: any[] = await invoke("search_suggest", { query: q2, engine: searchEngine });
    sug.innerHTML = "";
    items.slice(0, 8).forEach(it => { const d = document.createElement("div"); d.className = "item"; d.textContent = it.label; d.onclick = () => { ainput.value = it.label; goAddr(); }; sug.appendChild(d); });
    sug.classList.toggle("open", !!sug.innerHTML);
  } catch { sug.classList.remove("open"); }
}

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

/* ---- Menu (8 items, 4 columns) ---- */
const MENUS: { id: string; label: string; svg: string }[] = [
  { id: "m-bkm", label: "Bookmarks", svg: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>' },
  { id: "m-hist", label: "History", svg: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  { id: "m-down", label: "Downloads", svg: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>' },
  { id: "m-inco", label: "Incognito", svg: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  { id: "m-addbkm", label: "Add bookmark", svg: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>' },
  { id: "m-desktop", label: "Desktop", svg: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>' },
  { id: "m-tools", label: "Tools", svg: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>' },
  { id: "m-settings", label: "Settings", svg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>' },
];
function buildMenuUI() {
  menuGrid.innerHTML = "";
  MENUS.forEach(m => {
    const d = document.createElement("div"); d.className = "item"; d.id = m.id;
    d.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${m.svg}</svg><span>${m.label}</span>`;
    menuGrid.appendChild(d);
  });
  syncMenuUI();
}
function syncMenuUI() {
  const md = q("m-desktop"); if (md) md.classList.toggle("on", desktopMode);
  const mn = q("m-night"); if (mn) mn.classList.toggle("on", nightMode);
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
pill.onclick = openAddr;
acancel.onclick = closeOverlay;
ainput.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter") goAddr(); if (e.key === "Escape") closeOverlay(); };
ainput.oninput = () => { clearTimeout(sugT); sugT = setTimeout(doSuggest, 200); };
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
q("m-bkm")!.onclick = () => { closeOverlay(); showToast("Bookmarks: coming soon"); };
q("m-hist")!.onclick = () => { closeOverlay(); showToast("History: coming soon"); };
q("m-down")!.onclick = () => { closeOverlay(); showToast("Downloads: coming soon"); };
q("m-inco")!.onclick = () => { closeOverlay(); showToast("Incognito: auto-clear enabled"); };
q("m-addbkm")!.onclick = () => { closeOverlay(); showToast("Bookmarked current page"); };
q("m-desktop")!.onclick = async () => {
  desktopMode = !desktopMode;
  const ua = desktopMode ? "Desktop" : "Mobile";
  try { await invoke("set_settings", { settings: { ...getDefault(), desktop_mode: desktopMode, ua_mode: ua } }); } catch {}
  if (hasNavigated && activeId != null) await invoke("eval_tab", { id: activeId, js: "location.reload()" }).catch(()=>{});
  syncMenuUI(); showToast(desktopMode ? "Desktop site" : "Mobile site"); closeOverlay();
};
q("m-tools")!.onclick = async () => {
  closeOverlay();
  if (activeId != null) await invoke("eval_tab", { id: activeId, js: "window.open('view-source:'+location.href,'_blank')" }).catch(()=>{});
};
q("m-settings")!.onclick = () => { closeOverlay(); showToast("Settings: coming soon"); };

function getDefault(): Settings {
  return { homepage: "about:blank", search_engine: searchEngine, ua_mode: desktopMode ? "Desktop" : "Mobile", custom_ua: "", adblock_enabled: true, clear_on_exit: false, user_css: "", user_js: "", night_mode: nightMode, desktop_mode: desktopMode };
}

/* ---- Keyboard ---- */
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); createTab(undefined, true); setHome(true); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") { e.preventDefault(); if (activeId != null) closeTab(activeId); }
  if (e.key === "F5") { e.preventDefault(); reloadT(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); openAddr(); }
});

/* ---- Backend events ---- */
listen<{ id: number; url: string }>("tab-url", ev => { const t = tabs.find(x => x.id === ev.payload.id); if (t) { t.url = ev.payload.url; renderTabGrid(); } });
listen<{ id: number; title: string }>("tab-title", ev => { const t = tabs.find(x => x.id === ev.payload.id); if (t) { t.title = ev.payload.title; renderTabGrid(); } });

/* ---- Boot: show pure-black homepage, webview hidden ---- */
(async () => {
  try {
    const s: Settings = await invoke("get_settings");
    searchEngine = s.search_engine; nightMode = s.night_mode; desktopMode = s.desktop_mode;
  } catch {}
  await createTab(undefined, true); // create a tab; webview stays hidden (about:blank)
  buildMenuUI();
  setHome(true); // black homepage, no external site
  hideActiveWebview();
})();
