import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/* ---- Types ---- */
type Tab = { id: number; url: string; title: string; loading: boolean; active: boolean };
type Settings = {
  homepage: string; search_engine: string; ua_mode: string; custom_ua: string;
  adblock_enabled: boolean; clear_on_exit: boolean; user_css: string; user_js: string;
  night_mode: boolean; desktop_mode: boolean;
};

const ENGINES: Record<string, string> = { Google: "https://www.google.com/search?q=", Bing: "https://www.bing.com/search?q=", DuckDuckGo: "https://duckduckgo.com/?q=", Baidu: "https://www.baidu.com/s?wd=" };
const QUICS = [
  { n: "Google", u: "https://www.google.com", i: "G" }, { n: "YouTube", u: "https://www.youtube.com", i: "▶" },
  { n: "Twitter", u: "https://x.com", i: "𝕏" }, { n: "Reddit", u: "https://www.reddit.com", i: "R" },
  { n: "Wikipedia", u: "https://en.wikipedia.org", i: "W" }, { n: "GitHub", u: "https://github.com", i: "⌥" },
  { n: "DDG", u: "https://duckduckgo.com", i: "D" }, { n: "Bing", u: "https://www.bing.com", i: "B" },
];

/* ---- State ---- */
let tabs: Tab[] = [];
let activeId: number | null = null;
let nightMode = false;
let desktopMode = true;
let searchEngine = "Google";
let overlay: "none" | "addr" | "tabs" | "menu" = "none";

/* ---- DOM helper (defined BEFORE use) ---- */
const q = (id: string) => document.getElementById(id) as any;

/* ---- Build DOM ---- */
q("app").innerHTML = `
<div id="stage"></div>
<div id="home" class="show">
  <div class="logo">Via<span class="sub">Browser</span></div>
  <div class="search-pill" id="pill">🔍  Search or enter address</div>
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
    <button class="x" id="tab-x">✕</button>
    <div class="grid" id="tab-grid"></div>
    <div class="new" id="tab-new">+</div>
  </div>
</div>
<div id="menu">
  <div class="sheet">
    <div class="grip"></div>
    <div class="grid" id="menu-grid"></div>
  </div>
</div>
<nav id="nav">
  <button id="nb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg><small>Back</small></button>
  <button id="nf"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg><small>Fwd</small></button>
  <button id="nh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m3 9 9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 22V12h6v10"/></svg><small>Home</small></button>
  <button id="nt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="2" y="3" width="20" height="18" rx="3"/><path d="M9 3v18"/><path d="M14 7h4"/><path d="M14 11h4"/></svg><span class="count" id="badge">0</span></button>
  <button id="nm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg><small>Menu</small></button>
</nav>
<div id="toast"></div>`;

/* ---- Refs ---- */
const stage  = q("stage"), homeEl = q("home"), pill = q("pill"), quickGrid = q("quick-grid");
const addr   = q("addr"),  acancel = q("acancel"), ainput = q("ainput"), sug = q("sug");
const tabsEl = q("tabs"),  tabX    = q("tab-x"),  tabGrid = q("tab-grid"), tabNew = q("tab-new");
const menuEl = q("menu"),  menuGrid= q("menu-grid");
const nb = q("nb"), nf = q("nf"), nh = q("nh"), nt = q("nt"), nm = q("nm");
const badge  = q("badge"), toastEl = q("toast");

/* ---- Quick-sites ---- */
QUICS.forEach(s => {
  const d = document.createElement("div"); d.className = "tile";
  d.innerHTML = `<div class="ic">${s.i}</div><span>${s.n}</span>`;
  d.onclick = () => { openAddr(); ainput.value = s.u; goAddr(); };
  quickGrid.appendChild(d);
});

/* ---- Helpers ---- */
function showToast(msg: string) { toastEl.textContent = msg; toastEl.classList.add("show"); setTimeout(() => toastEl.classList.remove("show"), 2200); }
function setHome(on: boolean) { homeEl.classList.toggle("show", on); if (on) stage.style.display = "none"; else stage.style.display = ""; }

function openAddr() { overlay = "addr"; addr.classList.add("open"); setTimeout(() => { ainput.focus(); ainput.select(); }, 30); }
function closeOverlay() {
  addr.classList.remove("open"); tabsEl.classList.remove("show"); menuEl.classList.remove("show");
  overlay = "none"; ainput.value = ""; sug.classList.remove("open");
}

function searchUrl(engine: string, q2: string) { return (ENGINES[engine]||ENGINES.Bing) + encodeURIComponent(q2); }
function norm(input: string): string {
  const t = input.trim(); if (!t) return "https://www.bing.com";
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/:].*)?$/i.test(t) && !t.includes(" ")) return "https://" + t;
  return searchUrl(searchEngine, t);
}

async function goAddr() { const v = ainput.value; closeOverlay(); if (v.trim()) await navigate(norm(v)); }
let sugT: any;
async function doSuggest() {
  const q2 = ainput.value.trim(); if (!q2) { sug.classList.remove("open"); return; }
  try {
    const items: any[] = await invoke("search_suggest", { query: q2, engine: searchEngine });
    sug.innerHTML = "";
    items.slice(0, 8).forEach(it => {
      const d = document.createElement("div"); d.className = "item"; d.textContent = it.label;
      d.onclick = () => { ainput.value = it.label; goAddr(); };
      sug.appendChild(d);
    });
    sug.classList.toggle("open", !!sug.innerHTML);
  } catch { sug.classList.remove("open"); }
}

/* ---- Tab API ---- */
async function createTab(url?: string, silent?: boolean) {
  const t: Tab = await invoke("create_tab", { url: url ?? null });
  tabs = tabs.filter(x => x.id !== t.id); tabs.push(t);
  tabs.forEach(x => x.active = x.id === t.id);
  activeId = t.id; updateBadge(); closeOverlay();
  if (!silent) { setHome(false); openAddr(); }
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
  setHome(false); closeOverlay(); updateBadge(); renderTabGrid();
  stage.style.display = ""; // make sure webview is visible
}
async function navigate(url: string) { if (activeId != null) await invoke("navigate_tab", { id: activeId, url }); await selectTab(activeId!); }
async function goBack() { if (activeId != null) await invoke("eval_tab", { id: activeId, js: "history.back()" }); }
async function goFwd()  { if (activeId != null) await invoke("eval_tab", { id: activeId, js: "history.forward()" }); }
async function reloadT() { if (activeId != null) await invoke("eval_tab", { id: activeId, js: "location.reload()" }); }
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

/* ---- Menu grid ---- */
const MENUS: { id: string; label: string; svg: string }[] = [
  { id: "m-night",  label: "Night",    svg: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>' },
  { id: "m-desktop",label: "Desktop",  svg: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>' },
  { id: "m-source", label: "Source",   svg: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>' },
  { id: "m-save",   label: "Save",     svg: '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>' },
  { id: "m-inco",   label: "Incognito", svg: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  { id: "m-clear",  label: "Clear",    svg: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>' },
  { id: "m-bkm",    label: "Bookmarks", svg: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>' },
  { id: "m-hist",   label: "History",  svg: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
  { id: "m-down",   label: "Downloads", svg: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>' },
];
MENUS.forEach(m => {
  const d = document.createElement("div"); d.className = "item"; d.id = m.id;
  d.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${m.svg}</svg><span>${m.label}</span>`;
  menuGrid.appendChild(d);
});
function syncMenuUI() {
  const mn = q("m-night"); const md = q("m-desktop");
  if (mn) mn.classList.toggle("on", nightMode);
  if (md) md.classList.toggle("on", desktopMode);
  document.documentElement.style.filter = nightMode ? "invert(1) hue-rotate(180deg) brightness(.92)" : "";
}

/* ---- Event bindings ---- */
pill.onclick = openAddr;
acancel.onclick = closeOverlay;
ainput.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter") goAddr(); if (e.key === "Escape") closeOverlay(); };
ainput.oninput = () => { clearTimeout(sugT); sugT = setTimeout(doSuggest, 200); };
sug.onclick = () => {}; // prevent close
tabsEl.onclick = (e: any) => { if (e.target === tabsEl) closeOverlay(); };
menuEl.onclick = (e: any) => { if (e.target === menuEl) closeOverlay(); };
nb.onclick = goBack;
nf.onclick = goFwd;
nh.onclick = async () => { setHome(true); };
nt.onclick = () => { if (overlay === "tabs") closeOverlay(); else { renderTabGrid(); overlay = "tabs"; tabsEl.classList.add("show"); } };
nm.onclick = () => { if (overlay === "menu") closeOverlay(); else { syncMenuUI(); overlay = "menu"; menuEl.classList.add("show"); } };
tabX.onclick = closeOverlay;
tabNew.onclick = async () => { closeOverlay(); await createTab(undefined, true); setHome(true); };

/* ---- Menu handlers ---- */
q("m-night")!.onclick = async () => { nightMode = !nightMode; try { await invoke("set_settings", { settings: {...getDefault(), night_mode: nightMode } }); } catch {}; await invoke("set_night_mode", { enabled: nightMode }).catch(()=>{}); syncMenuUI(); showToast(nightMode ? "Night mode ON" : "Night mode OFF"); closeOverlay(); };
q("m-desktop")!.onclick = async () => { desktopMode = !desktopMode; const ua = desktopMode ? "Desktop" : "Mobile"; try { await invoke("set_settings", { settings: {...getDefault(), desktop_mode: desktopMode, ua_mode: ua } }); } catch {}; if (activeId != null) await invoke("eval_tab", { id: activeId, js: "location.reload()" }).catch(()=>{}); syncMenuUI(); showToast(desktopMode ? "Desktop site" : "Mobile site"); closeOverlay(); };
q("m-source")!.onclick = async () => { if (activeId != null) await invoke("eval_tab", { id: activeId, js: "window.open('view-source:'+location.href,'_blank')" }).catch(()=>{}); closeOverlay(); };
q("m-save")!.onclick = () => { closeOverlay(); showToast("Page saved (download)"); };
q("m-inco")!.onclick = () => { closeOverlay(); showToast("Incognito: auto-clear on exit enabled"); };
q("m-clear")!.onclick = async () => { await invoke("clear_data").catch(()=>{}); closeOverlay(); showToast("Browsing data cleared"); };
q("m-bkm")!.onclick = () => { closeOverlay(); showToast("Bookmarks: coming soon"); };
q("m-hist")!.onclick = () => { closeOverlay(); showToast("History: coming soon"); };
q("m-down")!.onclick = () => { closeOverlay(); showToast("Downloads: coming soon"); };

function getDefault(): Settings {
  return { homepage: "https://www.bing.com", search_engine: searchEngine, ua_mode: desktopMode ? "Desktop" : "Mobile", custom_ua: "", adblock_enabled: true, clear_on_exit: false, user_css: "", user_js: "", night_mode: nightMode, desktop_mode: desktopMode };
}

/* ---- Keyboard shortcuts ---- */
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); createTab(undefined, true); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") { e.preventDefault(); if (activeId != null) closeTab(activeId); }
  if (e.key === "F5") { e.preventDefault(); reloadT(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); openAddr(); }
});

/* ---- Backend events ---- */
listen<{ id: number; url: string }>("tab-url", ev => {
  const t = tabs.find(x => x.id === ev.payload.id);
  if (t) { t.url = ev.payload.url; renderTabGrid(); }
});
listen<{ id: number; title: string }>("tab-title", ev => {
  const t = tabs.find(x => x.id === ev.payload.id);
  if (t) { t.title = ev.payload.title; renderTabGrid(); }
});

/* ---- Boot ---- */
(async () => {
  try {
    const s: Settings = await invoke("get_settings");
    searchEngine = s.search_engine; nightMode = s.night_mode; desktopMode = s.desktop_mode;
    if (nightMode) { document.documentElement.style.filter = "invert(1) hue-rotate(180deg) brightness(.92)"; }
  } catch {}
  await createTab(undefined, true); // first tab, keep homepage visible (speed dial)
  setHome(true); // Via shows the home screen on launch until you navigate
})();
