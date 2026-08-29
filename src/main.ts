import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type TabInfo = { id: number; url: string; title: string; loading: boolean; active: boolean };
type Settings = {
  homepage: string;
  search_engine: string;
  ua_mode: string;
  custom_ua: string;
  adblock_enabled: boolean;
  clear_on_exit: boolean;
  user_css: string;
  user_js: string;
};

const SEARCH_ENGINES = ["Google", "Bing", "DuckDuckGo", "Baidu"];
const UA_MODES = ["Desktop", "Mobile", "Via Android", "Custom"];

const app = document.getElementById("app")!;
app.innerHTML = `
  <div id="tabstrip-bg">
    <div id="tabstrip"></div>
    <button id="newtab" title="New tab (Ctrl+T)">&plus;</button>
    <div id="tabstrip-bg-spacer"></div>
  </div>
  <div id="toolbar">
    <button id="btn-back" title="Back (Alt+Left)">&#x2190;</button>
    <button id="btn-fwd" title="Forward (Alt+Right)">&#x2192;</button>
    <button id="btn-refresh" title="Reload (F5)">&#x21bb;</button>
    <button id="btn-home" title="Home">&#x2302;</button>
    <div id="omnibox-wrap">
      <input id="omnibox" type="text" spellcheck="false" placeholder="Search or enter address" autocomplete="off" />
      <div id="suggest"></div>
    </div>
    <select id="engine" title="Search engine"></select>
    <button id="btn-settings" title="Settings (Ctrl+P)">&#x2699;</button>
  </div>
  <div id="statusbar">
    <span id="blocked-count" title="Ads blocked">&#x1f6ab; 0</span>
    <span id="adblock-toggle" title="Toggle ad blocker">Ad block: ON</span>
  </div>
  <div id="settings-panel" hidden></div>
`;

let tabs: TabInfo[] = [];
let activeTab: number | null = null;
let settings: Settings = {
  homepage: "https://www.bing.com",
  search_engine: "Google",
  ua_mode: "Desktop",
  custom_ua: "",
  adblock_enabled: true,
  clear_on_exit: false,
  user_css: "",
  user_js: "",
};

const els = {
  tabstrip: document.getElementById("tabstrip")!,
  newtab: document.getElementById("newtab")!,
  back: document.getElementById("btn-back") as HTMLButtonElement,
  fwd: document.getElementById("btn-fwd") as HTMLButtonElement,
  refresh: document.getElementById("btn-refresh") as HTMLButtonElement,
  home: document.getElementById("btn-home") as HTMLButtonElement,
  omnibox: document.getElementById("omnibox") as HTMLInputElement,
  suggest: document.getElementById("suggest")!,
  engine: document.getElementById("engine") as HTMLSelectElement,
  settings: document.getElementById("btn-settings") as HTMLButtonElement,
  settingsPanel: document.getElementById("settings-panel")!,
  blockedCount: document.getElementById("blocked-count")!,
  adblockToggle: document.getElementById("adblock-toggle")!,
  statusbar: document.getElementById("statusbar")!,
};

function renderTabs() {
  els.tabstrip.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.active ? " active" : "");
    const title = document.createElement("span");
    title.className = "t-title";
    title.textContent = t.title || t.url || "New tab";
    if (t.loading) title.textContent = "Loading…";
    const close = document.createElement("span");
    close.className = "t-close";
    close.textContent = "×";
    close.addEventListener("click", async (e) => {
      e.stopPropagation();
      await closeTab(t.id);
    });
    el.appendChild(title);
    el.appendChild(close);
    el.addEventListener("click", () => selectTab(t.id));
    els.tabstrip.appendChild(el);
  }
  els.back.disabled = !activeTab;
  els.fwd.disabled = !activeTab;
}

function refreshBlocked() {
  invoke<number>("blocked_total").then((n) => {
    els.blockedCount.textContent = `\u{1f6ab} ${n}`;
  }).catch(() => {});
  els.adblockToggle.textContent = settings.adblock_enabled ? "Ad block: ON" : "Ad block: OFF";
}

async function createTab(url?: string, opts?: { silent?: boolean }) {
  const t: TabInfo = await invoke("create_tab", { url: url ?? null });
  tabs = tabs.filter((x) => x.id !== t.id);
  tabs.push(t);
  for (const x of tabs) x.active = x.id === t.id;
  activeTab = t.id;
  if (!opts?.silent) renderTabs();
  syncOmnibox();
  return t;
}

async function closeTab(id: number) {
  const wasActive = activeTab === id;
  await invoke("close_tab", { id });
  tabs = tabs.filter((x) => x.id !== id);
  if (tabs.length === 0) {
    await createTab(undefined, { silent: true });
  } else if (wasActive) {
    const next = tabs[tabs.length - 1];
    await selectTab(next.id, { silent: true });
  }
  renderTabs();
  refreshBlocked();
}

async function selectTab(id: number, opts?: { silent?: boolean }) {
  const info = await invoke<TabInfo>("select_tab", { id }).catch(() => null);
  if (!info) return;
  for (const x of tabs) x.active = x.id === id;
  activeTab = id;
  if (!opts?.silent) renderTabs();
  syncOmnibox();
}

async function navigateActive(url: string) {
  if (activeTab == null) return;
  await invoke("navigate_tab", { id: activeTab, url });
  updateCurrentUrl(url);
  await selectTab(activeTab, { silent: true });
}

async function back() { if (activeTab != null) await invoke("eval_tab", { id: activeTab, js: "history.back()" }); }
async function fwd() { if (activeTab != null) await invoke("eval_tab", { id: activeTab, js: "history.forward()" }); }
async function reloadTab() { if (activeTab != null) await invoke("eval_tab", { id: activeTab, js: "location.reload()" }); }
async function goHome() { await navigateActive(settings.homepage); }

function searchUrl(engine: string, q: string) {
  const key = encodeURIComponent(q);
  switch (engine) {
    case "Google": return `https://www.google.com/search?q=${key}`;
    case "Bing": return `https://www.bing.com/search?q=${key}`;
    case "DuckDuckGo": return `https://duckduckgo.com/?q=${key}`;
    case "Baidu": return `https://www.baidu.com/s?wd=${key}`;
    default: return `https://www.bing.com/search?q=${key}`;
  }
}

function normalize(input: string): string {
  const t = input.trim();
  if (!t) return settings.homepage;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/:].*)?$/i.test(t) && !t.includes(" ")) return "https://" + t;
  return searchUrl(settings.search_engine, t);
}

function updateCurrentUrl(url: string) {
  const t = tabs.find((x) => x.active);
  if (t) t.url = url;
}

function syncOmnibox() {
  if (document.activeElement === els.omnibox) return;
  const t = tabs.find((x) => x.active);
  els.omnibox.value = t ? t.url : "";
}

let suggestTimer: number | undefined;
async function doSuggest() {
  const q = els.omnibox.value.trim();
  if (!q || document.activeElement !== els.omnibox) { els.suggest.style.display = "none"; return; }
  try {
    const items = await invoke<{ label: string }[]>("search_suggest", { query: q, engine: settings.search_engine });
    els.suggest.innerHTML = "";
    if (items.length === 0) { els.suggest.style.display = "none"; return; }
    for (const it of items) {
      const d = document.createElement("div");
      d.className = "sug";
      d.textContent = it.label;
      d.addEventListener("click", () => {
        els.omnibox.value = it.label;
        navigateActive(searchUrl(settings.search_engine, it.label));
        els.suggest.style.display = "none";
      });
      els.suggest.appendChild(d);
    }
    els.suggest.style.display = "block";
  } catch { els.suggest.style.display = "none"; }
}

function openOmniboxValue() {
  const v = els.omnibox.value;
  if (!v) return;
  navigateActive(normalize(v));
  els.suggest.style.display = "none";
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildSettingsPanel() {
  const s = settings;
  els.settingsPanel.innerHTML = `
    <h2>Settings</h2>
    <label>Homepage
      <input id="set-homepage" type="text" value="${esc(s.homepage)}" />
    </label>
    <label>Search engine
      <select id="set-engine">${SEARCH_ENGINES.map((e) => `<option ${e === s.search_engine ? "selected" : ""}>${e}</option>`).join("")}</select>
    </label>
    <label>User agent
      <select id="set-ua">${UA_MODES.map((u) => `<option ${u === s.ua_mode ? "selected" : ""}>${u}</option>`).join("")}</select>
    </label>
    <label>Custom UA
      <input id="set-custom-ua" type="text" value="${esc(s.custom_ua)}" placeholder="user agent string" />
    </label>
    <label class="check"><input id="set-adblock" type="checkbox" ${s.adblock_enabled ? "checked" : ""}/> Hide ads &amp; trackers (Via filter list)</label>
    <label class="check"><input id="set-clear" type="checkbox" ${s.clear_on_exit ? "checked" : ""}/> Clear browsing data on exit</label>
    <label>Extra site CSS <textarea id="set-css" rows="3" placeholder="example.com selectors">${esc(s.user_css)}</textarea></label>
    <label>Extra site JS <textarea id="set-js" rows="3" placeholder="optional user scripts">${esc(s.user_js)}</textarea></label>
    <div class="settings-actions">
      <button id="btn-clear-data">Clear cache &amp; history now</button>
      <button id="btn-save-settings">Save</button>
    </div>
    <div class="license">Filters: built-in EasyList-derived list from Via Browser 7.2.1 (mark.via.gp)</div>
  `;
  els.settingsPanel.hidden = false;
  document.getElementById("btn-save-settings")!.addEventListener("click", saveSettings);
  document.getElementById("btn-clear-data")!.addEventListener("click", () => {
    invoke("clear_data").then(() => alert("Cleared cache & history."));
  });
}

async function saveSettings() {
  settings = {
    homepage: (document.getElementById("set-homepage") as HTMLInputElement).value.trim() || settings.homepage,
    search_engine: (document.getElementById("set-engine") as HTMLSelectElement).value,
    ua_mode: (document.getElementById("set-ua") as HTMLSelectElement).value,
    custom_ua: (document.getElementById("set-custom-ua") as HTMLInputElement).value,
    adblock_enabled: (document.getElementById("set-adblock") as HTMLInputElement).checked,
    clear_on_exit: (document.getElementById("set-clear") as HTMLInputElement).checked,
    user_css: (document.getElementById("set-css") as HTMLTextAreaElement).value,
    user_js: (document.getElementById("set-js") as HTMLTextAreaElement).value,
  };
  await invoke("set_settings", { settings });
  els.settingsPanel.hidden = true;
  renderTabs();
  els.engine.value = settings.search_engine;
  refreshBlocked();
}

function renderEngineSelect() {
  els.engine.innerHTML = "";
  for (const e of SEARCH_ENGINES) {
    const o = document.createElement("option");
    o.value = e; o.textContent = e;
    els.engine.appendChild(o);
  }
}

async function init() {
  try {
    settings = await invoke<Settings>("get_settings");
  } catch { /* defaults */ }
  renderEngineSelect();
  els.engine.value = settings.search_engine;
  refreshBlocked();
  await createTab();

  els.newtab.addEventListener("click", () => createTab());
  els.omnibox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openOmniboxValue();
    if (e.key === "Escape") { els.omnibox.blur(); els.suggest.style.display = "none"; }
  });
  els.omnibox.addEventListener("input", () => { window.clearTimeout(suggestTimer); suggestTimer = window.setTimeout(doSuggest, 220); });
  els.omnibox.addEventListener("blur", () => window.setTimeout(() => (els.suggest.style.display = "none"), 150));
  els.omnibox.addEventListener("focus", syncOmnibox);
  els.engine.addEventListener("change", () => { settings.search_engine = els.engine.value; });
  els.back.addEventListener("click", back);
  els.fwd.addEventListener("click", fwd);
  els.refresh.addEventListener("click", reloadTab);
  els.home.addEventListener("click", goHome);
  els.settings.addEventListener("click", buildSettingsPanel);
  els.adblockToggle.addEventListener("click", async () => {
    settings.adblock_enabled = !settings.adblock_enabled;
    await invoke("set_settings", { settings });
    refreshBlocked();
  });

  listen<TabInfo>("tab-url", (e) => {
    const t = tabs.find((x) => x.id === e.payload.id);
    if (t) { t.url = e.payload.url; if (t.active && document.activeElement !== els.omnibox) els.omnibox.value = e.payload.url; }
  });
  listen<{ id: number; title: string }>("tab-title", (e) => {
    const t = tabs.find((x) => x.id === e.payload.id);
    if (t) { t.title = e.payload.title; renderTabs(); }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); createTab(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") { e.preventDefault(); if (activeTab != null) closeTab(activeTab); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); buildSettingsPanel(); }
    if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); back(); }
    if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); fwd(); }
    if (e.key === "F5") { e.preventDefault(); reloadTab(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); els.omnibox.select(); }
  });
}

init();
