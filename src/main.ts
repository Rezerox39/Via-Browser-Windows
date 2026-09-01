import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/* ─── Types ─── */
type Tab = { id: number; url: string; title: string; active: boolean };
type Settings = {
  homepage: string; search_engine: string; ua_mode: string; custom_ua: string;
  adblock_enabled: boolean; clear_on_exit: boolean; user_css: string;
  night_mode: boolean; desktop_mode: boolean; text_size: number;
  show_images: boolean; network_log: boolean; game_mode: boolean;
  search_suggest: boolean; scripts: UserScript[]; sites: SiteConfig[];
  pages_log: string[][]; restore_tabs: boolean; homepage_shortcuts: HomeShortcut[];
};
type UserScript = { id: string; name: string; match_urls: string; code: string; enabled: boolean };
type SiteConfig = { host: string; ua_mode: string; adblock_enabled: boolean };
type HomeShortcut = { label: string; url: string; icon: string };
type Bookmark = { url: string; title: string; folder: string };
type HistItem = { url: string; title: string; ts: number };
type DlItem = { url: string; path: string; title: string; size: number; done: boolean };
type ActiveDl = { url: string; path: string; received: number; total: number; done: boolean; success?: boolean };
type TabInfo = { id: number; url: string; title: string; loading: boolean; active: boolean };
type SessionEntry = { url: string; title: string; active: boolean; order: number };
type ClosedTab = { url: string; title: string; ts: number };

const ENGINES: Record<string, string> = {
  Google: "https://www.google.com/search?q=",
  DuckDuckGo: "https://duckduckgo.com/?q=",
  Bing: "https://www.bing.com/search?q=",
  Baidu: "https://www.baidu.com/s?wd=",
};

const DEFAULT_SHORTCUTS: HomeShortcut[] = [
  { label: "Google", url: "https://www.google.com", icon: "🔍" },
  { label: "YouTube", url: "https://www.youtube.com", icon: "📺" },
  { label: "GitHub", url: "https://github.com", icon: "💻" },
  { label: "Twitter", url: "https://x.com", icon: "🐦" },
];

/* ─── State ─── */
let tabs: Tab[] = [];
let activeId: number | null = null;
let searchEngine = "Google";
let settings: Settings | null = null;
let bookmarks: Bookmark[] = [];
let historyItems: HistItem[] = [];
let downloads: DlItem[] = [];
let activeDl: ActiveDl[] = [];
let overlay: "none" | "panel" = "none";
let panelStack: string[] = [];
let snifferItems: string[] = [];
let nightMode = false;
let desktopMode = true;
let textSize = 1.0;
let showImages = true;
let networkLog = false;
let adblockOn = true;
let incognitoMode = false;
let restoreTabs = false;
let homepageShortcuts: HomeShortcut[] = [...DEFAULT_SHORTCUTS];
let contextMenu: HTMLElement | null = null;
let activeBookmarkFolder = "";

/* ─── DOM Refs ─── */
const $ = (s: string) => document.getElementById(s) as HTMLElement;
const $q = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;
const toastEl = $q<HTMLElement>("#toast") as any;
function showToast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/* ─── Panel System ─── */
function openPanel(title: string, renderFn: (body: HTMLElement) => void, kind: string) {
  overlay = "panel";
  panelStack = [kind];
  $("panel-title").textContent = title;
  const body = $("panel-body");
  body.innerHTML = "";
  renderFn(body);
  $("panel").classList.add("open");
  $("panel-backdrop").classList.add("open");
  hideActiveWebview();
}
function openSubPanel(title: string, renderFn: (body: HTMLElement) => void, kind: string) {
  panelStack.push(kind);
  $("panel-title").textContent = title;
  const body = $("panel-body");
  body.innerHTML = "";
  renderFn(body);
}
function closePanel() {
  overlay = "none";
  panelStack = [];
  $("panel").classList.remove("open");
  $("panel-backdrop").classList.remove("open");
  if (tabs.length > 0) showActiveWebview();
}
function showActiveWebview() {
  if (activeId != null) invoke("show_tab", { id: activeId }).catch(() => {});
}
function hideActiveWebview() {
  if (activeId != null) invoke("hide_tab", { id: activeId }).catch(() => {});
}

/* ─── Tab Management ─── */
async function createTab(url?: string, hidden = false): Promise<TabInfo> {
  const info = await invoke<TabInfo>("create_tab", { url: url || null });
  tabs.push({ id: info.id, url: info.url, title: "New Tab", active: !hidden });
  updateTabCount();
  return info;
}
async function switchTab(id: number) {
  if (activeId === id) return;
  for (const t of tabs) {
    if (t.id !== id && t.active) {
      t.active = false;
      invoke("hide_tab", { id: t.id }).catch(() => {});
    }
  }
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  tab.active = true;
  activeId = id;
  await invoke("show_tab", { id });
  const addrInput = $("tb-input") as HTMLInputElement;
  const homeEl = $("home");
  if (tab.url && tab.url !== "about:blank") {
    homeEl.classList.add("hidden");
    addrInput.value = tab.url;
  } else {
    homeEl.classList.remove("hidden");
    addrInput.value = "";
  }
  updateBackFwd();
  updateTabCount();
}
async function closeTab(id: number, pushToStack = true) {
  const tab = tabs.find(t => t.id === id);
  if (tab && pushToStack) {
    await invoke("push_closed_tab", { url: tab.url, title: tab.title }).catch(() => {});
  }
  await invoke("close_tab", { id });
  tabs = tabs.filter(t => t.id !== id);
  if (activeId === id) {
    activeId = tabs.length ? tabs[tabs.length - 1].id : null;
    if (activeId) await switchTab(activeId);
    else $("home").classList.remove("hidden");
  }
  updateTabCount();
}
async function undoCloseTab() {
  const closed = await invoke<ClosedTab | null>("pop_closed_tab").catch(() => null);
  if (closed && closed.url) {
    const info = await createTab(closed.url);
    switchTab(info.id);
  }
}
async function saveSession() {
  if (!restoreTabs) return;
  const entries: SessionEntry[] = tabs.map((t, i) => ({
    url: t.url || "about:blank",
    title: t.title,
    active: t.id === activeId,
    order: i,
  }));
  await invoke("save_session", { entries }).catch(() => {});
}
function updateTabCount() { $("tb-tab-count").textContent = String(tabs.length || 0); }
async function updateBackFwd() {
  const url = activeId != null ? await invoke<string>("get_tab_url", { id: activeId }).catch(() => "") : "";
  ($("tb-back") as HTMLButtonElement).disabled = !url || url.startsWith("about:");
  ($("tb-fwd") as HTMLButtonElement).disabled = false;
}
function navigate(url: string) {
  if (!url) return;
  if (activeId == null) {
    createTab(url).then(info => {
      switchTab(info.id);
      $("home").classList.add("hidden");
      ($q<HTMLInputElement>("#tb-input")).value = url;
    });
  } else {
    invoke("navigate_tab", { id: activeId, url });
    $("home").classList.add("hidden");
    ($q<HTMLInputElement>("#tb-input")).value = url;
  }
}

/* ─── Address Bar ─── */
function handleAddressGo() {
  const input = $("tb-input") as HTMLInputElement;
  const val = input.value.trim();
  if (!val) return;
  if (/^https?:\/\//i.test(val) || /^[a-z0-9-]+\.[a-z]/i.test(val) || val.includes("://")) {
    navigate(/^https?:\/\//i.test(val) ? val : "https://" + val);
  } else {
    navigate(ENGINES[searchEngine] + encodeURIComponent(val));
  }
}

/* ─── Settings Panel ─── */
function renderSettings(body: HTMLElement) {
  body.innerHTML = `
    <div class="set-section">
      <div class="set-label">General</div>
      <div class="set-row" data-set="engine"><div class="sr-text"><div class="sr-title">Search engine</div></div><div class="sr-val">${searchEngine}</div></div>
      <div class="set-row" data-set="restore"><div class="sr-text"><div class="sr-title">Restore tabs on startup</div><div class="sr-desc">Reopen last session tabs</div></div><div class="switch ${restoreTabs?"on":""}"></div></div>
      <div class="set-row" data-set="suggest"><div class="sr-text"><div class="sr-title">Search suggestions</div></div><div class="switch ${settings?.search_suggest?"on":""}"></div></div>
    </div>
    <div class="set-section">
      <div class="set-label">Appearance</div>
      <div class="set-row" data-set="night"><div class="sr-text"><div class="sr-title">Night mode</div><div class="sr-desc">Invert page colors</div></div><div class="switch ${nightMode?"on":""}"></div></div>
      <div class="set-row" data-set="textsize"><div class="sr-text"><div class="sr-title">Text size</div></div><div class="sr-val">${Math.round(textSize*100)}%</div></div>
      <div class="set-row" data-set="showimages"><div class="sr-text"><div class="sr-title">Show images</div></div><div class="switch ${showImages?"on":""}"></div></div>
    </div>
    <div class="set-section">
      <div class="set-label">Privacy</div>
      <div class="set-row" data-set="adblock"><div class="sr-text"><div class="sr-title">Ad blocking</div><div class="sr-desc">Block ads and trackers</div></div><div class="switch ${adblockOn?"on":""}"></div></div>
      <div class="set-row" data-set="desktop"><div class="sr-text"><div class="sr-title">User-Agent</div></div><div class="sr-val">${settings?.ua_mode || "Default"}</div></div>
    </div>
    <div class="set-section">
      <div class="set-label">Data</div>
      <div class="set-row" data-set="cleardata"><div class="sr-text"><div class="sr-title">Clear data</div><div class="sr-desc">Cache, cookies, history</div></div></div>
      <div class="set-row" data-set="export"><div class="sr-text"><div class="sr-title">Export settings</div></div><div class="sr-val">.via</div></div>
      <div class="set-row" data-set="import"><div class="sr-text"><div class="sr-title">Import settings</div></div><div class="sr-val">.via</div></div>
    </div>
    <div class="set-section">
      <div class="set-label">About</div>
      <div class="set-row"><div class="sr-text"><div class="sr-title">Via Browser for Windows</div><div class="sr-desc">Version 7.2.1 · Tauri 2 + WebView2</div></div></div>
    </div>`;
  body.querySelectorAll(".set-row[data-set]").forEach(el => {
    el.addEventListener("click", () => handleSetting(el.getAttribute("data-set")!));
  });
}
async function handleSetting(key: string) {
  switch (key) {
    case "engine": {
      const engines = Object.keys(ENGINES);
      const idx = engines.indexOf(searchEngine);
      searchEngine = engines[(idx + 1) % engines.length];
      if (settings) settings.search_engine = searchEngine;
      openSubPanel("Settings", renderSettings, "settings");
      showToast("Search: " + searchEngine);
      await saveSettings();
      break;
    }
    case "restore":
      restoreTabs = !restoreTabs;
      if (settings) settings.restore_tabs = restoreTabs;
      openSubPanel("Settings", renderSettings, "settings");
      showToast(restoreTabs ? "Session restore ON" : "Session restore OFF");
      await saveSettings();
      break;
    case "suggest":
      if (settings) settings.search_suggest = !settings.search_suggest;
      openSubPanel("Settings", renderSettings, "settings");
      await saveSettings();
      break;
    case "night":
      nightMode = !nightMode;
      if (settings) settings.night_mode = nightMode;
      if (activeId) invoke("set_night_mode", { id: activeId, enabled: nightMode }).catch(() => {});
      openSubPanel("Settings", renderSettings, "settings");
      await saveSettings();
      break;
    case "textsize": {
      textSize = textSize >= 2.0 ? 0.5 : textSize + 0.25;
      if (settings) settings.text_size = textSize;
      applyTextSize();
      openSubPanel("Settings", renderSettings, "settings");
      await saveSettings();
      break;
    }
    case "showimages":
      showImages = !showImages;
      if (settings) settings.show_images = showImages;
      openSubPanel("Settings", renderSettings, "settings");
      await saveSettings();
      break;
    case "adblock":
      adblockOn = !adblockOn;
      if (settings) settings.adblock_enabled = adblockOn;
      openSubPanel("Settings", renderSettings, "settings");
      await saveSettings();
      break;
    case "desktop": {
      if (!settings) break;
      const modes = ["Default", "Desktop", "Mobile", "Via", "Custom"];
      const cur = modes.indexOf(settings.ua_mode);
      settings.ua_mode = modes[(cur + 1) % modes.length];
      desktopMode = settings.ua_mode !== "Mobile";
      openSubPanel("Settings", renderSettings, "settings");
      showToast("UA: " + settings.ua_mode);
      await saveSettings();
      break;
    }
    case "cleardata":
      await invoke("clear_data").then(() => showToast("Data cleared")).catch(() => showToast("Failed"));
      break;
    case "export":
      await invoke<string>("export_backup").then(p => showToast("Exported: " + p.split(/[\\/]/).pop())).catch(() => showToast("Export failed"));
      break;
    case "import":
      await invoke("import_backup").then(() => showToast("Imported!")).catch(() => showToast("Import failed"));
      break;
  }
}
function applyTextSize() {
  if (!activeId) return;
  invoke("eval_tab", { id: activeId, js: `document.documentElement.style.zoom='${textSize}'` }).catch(() => {});
}
async function saveSettings() {
  if (settings) {
    settings.night_mode = nightMode;
    settings.desktop_mode = desktopMode;
    settings.text_size = textSize;
    settings.show_images = showImages;
    settings.search_engine = searchEngine;
    settings.restore_tabs = restoreTabs;
    await invoke("set_settings", { s: settings }).catch(() => {});
  }
}

/* ─── Bookmarks Panel ─── */
function getBookmarkFolders(): string[] {
  const folders = new Set<string>();
  bookmarks.forEach(b => { if (b.folder) folders.add(b.folder); });
  return Array.from(folders).sort();
}
function renderBookmarks(body: HTMLElement, filter = "", folder = "") {
  activeBookmarkFolder = folder;
  const f = filter.toLowerCase();
  let filtered = bookmarks.filter(b => {
    if (folder && b.folder !== folder) return false;
    if (!f) return true;
    return (b.title + " " + b.url).toLowerCase().includes(f);
  });
  const folders = getBookmarkFolders();
  const folderHeader = folders.length > 0 ? `
    <div class="pp-section-header">Folders</div>
    <div class="pp-folder-list">
      ${folders.map(f => `<div class="pp-item" data-folder="${esc(f)}">
        <div class="pi-icon">📁</div>
        <div class="pi-info"><div class="pi-title">${esc(f)}</div>
        <div class="pi-sub">${bookmarks.filter(b => b.folder === f).length} items</div></div></div>`).join("")}
    </div>` : "";
  const html = `
    <div class="pp-head"><input id="bm-search" placeholder="Search bookmarks…" value="${filter}">
    ${folder ? `<button class="pp-folder-back" data-back-folder>← ${esc(folder)}</button>` : ""}
    </div>
    ${folderHeader}
    ${folder ? '<div class="pp-section-header">Bookmarks in "' + esc(folder) + '"</div>' : ""}
    <div class="pp-list">${filtered.length ? filtered.map(b => `<div class="pp-item" data-url="${esc(b.url)}">
      <div class="pi-icon">🔖</div><div class="pi-info"><div class="pi-title">${esc(b.title || b.url)}</div>
      <div class="pi-sub">${esc(b.url)}</div></div><div class="pi-action" data-rm="${esc(b.url)}">✕</div></div>`).join("") : '<div class="empty-state">No bookmarks</div>'}</div>
    <div style="padding:12px 16px"><button class="mg-item" style="width:100%;border:1px solid var(--bg4)" id="bm-add">+ Add Bookmark</button></div>`;
  body.innerHTML = html;
  body.querySelector("#bm-search")?.addEventListener("input", (e) => renderBookmarks(body, (e.target as HTMLInputElement).value, activeBookmarkFolder));
  body.querySelector("[data-back-folder]")?.addEventListener("click", () => renderBookmarks(body, filter, ""));
  body.querySelectorAll("[data-folder]").forEach(el => {
    el.addEventListener("click", () => renderBookmarks(body, filter, el.getAttribute("data-folder")!));
  });
  body.querySelectorAll(".pp-item[data-url]").forEach(el => {
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("pi-action")) return;
      closePanel();
      navigate(el.getAttribute("data-url")!);
    });
  });
  body.querySelectorAll(".pi-action[data-rm]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const url = el.getAttribute("data-rm")!;
      await invoke("remove_bookmark", { url });
      bookmarks = bookmarks.filter(b => b.url !== url);
      renderBookmarks(body, body.querySelector<HTMLInputElement>("#bm-search")?.value || "", activeBookmarkFolder);
      showToast("Bookmark removed");
    });
  });
  body.querySelector("#bm-add")?.addEventListener("click", async () => {
    if (!activeId) return;
    const url = tabs.find(t => t.id === activeId)?.url || "";
    const title = tabs.find(t => t.id === activeId)?.title || url;
    const folder = activeBookmarkFolder || "home";
    await invoke("add_bookmark", { url, title, folder }).then(() => {
      bookmarks.push({ url, title, folder });
      renderBookmarks(body, "", activeBookmarkFolder);
      showToast("Bookmark added");
    }).catch(() => showToast("Already bookmarked"));
  });
}

/* ─── History Panel ─── */
function renderHistory(body: HTMLElement, filter = "") {
  const f = filter.toLowerCase();
  const filtered = historyItems.slice(0, 300).filter(h => !f || (h.title + " " + h.url).toLowerCase().includes(f));
  body.innerHTML = `<div class="pp-head"><input id="hi-search" placeholder="Search history…" value="${filter}"></div>
    <div class="pp-list">${filtered.length ? filtered.map(h => {
      const age = Date.now() - h.ts;
      const ageStr = age < 86400000 ? "Today" : age < 172800000 ? "Yesterday" : new Date(h.ts * 1000).toLocaleDateString();
      return `<div class="pp-item" data-url="${esc(h.url)}"><div class="pi-icon">🕐</div>
        <div class="pi-info"><div class="pi-title">${esc(h.title || h.url)}</div>
        <div class="pi-sub">${ageStr} · ${esc(h.url.slice(0, 60))}</div></div></div>`;
    }).join("") : '<div class="empty-state">No history</div>'}</div>`;
  body.querySelector("#hi-search")?.addEventListener("input", (e) => renderHistory(body, (e.target as HTMLInputElement).value));
  body.querySelectorAll(".pp-item[data-url]").forEach(el => {
    el.addEventListener("click", () => { closePanel(); navigate(el.getAttribute("data-url")!); });
  });
}

/* ─── Downloads Panel ─── */
function renderDownloads(body: HTMLElement) {
  body.innerHTML = `<div class="pp-list" id="dl-list"></div>`;
  refreshDlList(body.querySelector<HTMLElement>("#dl-list")!);
}
function refreshDlList(listEl: HTMLElement) {
  const rows = [...activeDl].reverse().map(d => {
    const name = d.path.split(/[\\/]/).pop() || d.url.split("?")[0].split("/").pop() || "file";
    const pct = d.total > 0 ? Math.min(100, Math.round(d.received / d.total * 100)) : 0;
    const stat = d.done ? (d.success !== false ? "Complete" : "Failed")
      : d.total > 0 ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)}` : "Downloading…";
    const cls = d.done ? (d.success !== false ? "dl-done" : "dl-fail") : "";
    const barCls = d.done ? (d.success !== false ? "done" : "fail") : "";
    return `<div class="dl-item ${cls}"><div class="dl-name">${esc(name)}</div>
      <div class="dl-meta">${stat}</div>
      <div class="dl-bar ${barCls}"><i style="width:${pct}%"></i></div></div>`;
  });
  const savedRows = downloads.map(d => `<div class="dl-item dl-done">
    <div class="dl-name">${esc(d.title || d.path.split(/[\\/]/).pop() || "file")}</div>
    <div class="dl-meta">Saved</div>
    <div class="dl-bar done"><i></i></div></div>`);
  listEl.innerHTML = [...rows, ...savedRows].join("") || '<div class="empty-state">No downloads</div>';
}

/* ─── Scripts Panel ─── */
function renderScripts(body: HTMLElement) {
  const scripts = settings?.scripts || [];
  body.innerHTML = `<div class="pp-list" id="sc-list">
    ${scripts.length ? scripts.map((sc, i) => `<div class="pp-item" data-idx="${i}">
      <div class="pi-icon" style="font-size:18px">${sc.enabled ? "✓" : "—"}</div>
      <div class="pi-info"><div class="pi-title">${esc(sc.name)}</div>
      <div class="pi-sub">${esc(sc.match_urls || "*")}</div></div>
      <div class="pi-action" data-rm="${i}">✕</div></div>`).join("")
    : '<div class="empty-state">No scripts configured</div>'}</div>
    <div style="padding:12px 16px"><button class="mg-item" style="width:100%;border:1px solid var(--bg4)" id="sc-add">+ New script</button></div>`;
  body.querySelectorAll(".pi-action[data-rm]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = parseInt(el.getAttribute("data-rm")!);
      const sc = scripts[idx];
      if (sc) {
        await invoke("delete_script", { id: sc.id }).catch(() => {});
        if (settings) settings.scripts = settings.scripts.filter(s => s.id !== sc.id);
        renderScripts(body);
        showToast("Script deleted");
      }
    });
  });
}

/* ─── Site Config Panel ─── */
function renderSiteConfig(body: HTMLElement) {
  const configs = settings?.sites || [];
  const currentUrl = tabs.find(t => t.id === activeId)?.url || "";
  const currentHost = currentUrl ? (() => { try { return new URL(currentUrl).hostname; } catch { return ""; } })() : "";
  body.innerHTML = `
    ${currentHost ? `<div class="set-section">
      <div class="set-label">Current Site: ${esc(currentHost)}</div>
      <div class="set-row" data-sc="adblock"><div class="sr-text"><div class="sr-title">Ad blocking</div></div>
        <div class="switch ${(settings?.sites.find(s => s.host === currentHost)?.adblock_enabled ?? settings?.adblock_enabled ?? true) ? 'on' : ''}"></div></div>
      <div class="set-row" data-sc="ua"><div class="sr-text"><div class="sr-title">User-Agent</div></div>
        <div class="sr-val">${settings?.sites.find(s => s.host === currentHost)?.ua_mode || "Default"}</div></div>
    </div>` : ""}
    <div class="set-section">
      <div class="set-label">All Sites</div>
      <div class="pp-list">${configs.length ? configs.map((c, i) => `<div class="pp-item" data-idx="${i}">
        <div class="pi-icon">🌐</div><div class="pi-info"><div class="pi-title">${esc(c.host)}</div>
        <div class="pi-sub">UA: ${c.ua_mode || "Default"} · AdBlock: ${c.adblock_enabled ? "On" : "Off"}</div></div>
        <div class="pi-action" data-rm="${i}">✕</div></div>`).join("")
      : '<div class="empty-state">No site configurations</div>'}</div>
    </div>`;
  body.querySelectorAll("[data-sc]").forEach(el => {
    el.addEventListener("click", async () => {
      if (!currentHost) return;
      const key = el.getAttribute("data-sc")!;
      let cfg = settings?.sites.find(s => s.host === currentHost);
      if (!cfg) {
        cfg = { host: currentHost, ua_mode: "", adblock_enabled: settings?.adblock_enabled ?? true };
        if (settings) settings.sites.push(cfg);
      }
      if (key === "adblock") {
        cfg.adblock_enabled = !cfg.adblock_enabled;
      } else if (key === "ua") {
        const modes = ["", "Desktop", "Mobile", "Via", "Custom"];
        const cur = modes.indexOf(cfg.ua_mode);
        cfg.ua_mode = modes[(cur + 1) % modes.length];
      }
      await invoke("save_site_config", { cfg }).catch(() => {});
      renderSiteConfig(body);
    });
  });
  body.querySelectorAll(".pi-action[data-rm]").forEach(el => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const idx = parseInt(el.getAttribute("data-rm")!);
      const c = configs[idx];
      if (c) {
        await invoke("delete_site_config", { host: c.host }).catch(() => {});
        if (settings) settings.sites = settings.sites.filter(s => s.host !== c.host);
        renderSiteConfig(body);
        showToast("Site config removed");
      }
    });
  });
}

/* ─── Cookie Inspector Panel ─── */
async function renderCookieInspector(body: HTMLElement) {
  const cookies = await invoke<Array<{name:string; value:string; domain:string; path:string; expires:boolean}>>("get_cookies").catch(() => []);
  body.innerHTML = `
    <div class="pp-head"><input id="cookie-search" placeholder="Search cookies…"></div>
    <div class="pp-list">${cookies.length ? cookies.map(c => `<div class="pp-item" data-name="${esc(c.name)}">
      <div class="pi-icon">🍪</div><div class="pi-info"><div class="pi-title">${esc(c.name)}</div>
      <div class="pi-sub">${esc(c.domain)}${c.path !== "/" ? " · " + esc(c.path) : ""}${c.expires ? " · Session" : " · Persistent"}</div></div></div>`).join("")
    : '<div class="empty-state">No cookies found</div>'}</div>
    <div style="padding:12px 16px"><button class="mg-item" style="width:100%;border:1px solid var(--bg4)" id="cookie-clear-all">Clear All Cookies</button></div>`;
  body.querySelector("#cookie-clear-all")?.addEventListener("click", async () => {
    await invoke("clear_cookies").catch(() => {});
    showToast("Cookies cleared");
    renderCookieInspector(body);
  });
}

/* ─── Network Log Panel ─── */
function renderNetworkLog(body: HTMLElement) {
  const rows = settings?.pages_log || [];
  body.innerHTML = `<div class="pp-list">${rows.length ? rows.slice(-200).reverse().map(r => `<div class="pp-item">
    <div class="pi-icon">${r[1] === 'block' ? '🚫' : r[1] === 'img' ? '🖼' : r[1] === 'doc' ? '📄' : '🌐'}</div>
    <div class="pi-info"><div class="pi-title">${esc(r[0]?.slice(0, 80) || "")}</div>
    <div class="pi-sub">${r[1] || ''} ${r[2] || ''}</div></div></div>`).join("")
  : '<div class="empty-state">No network activity captured yet.</div>'}</div>
    <div style="padding:12px 16px"><button class="mg-item" style="width:100%;border:1px solid var(--bg4)" id="nl-clear">Clear Log</button></div>`;
  body.querySelector("#nl-clear")?.addEventListener("click", async () => {
    if (settings) settings.pages_log = [];
    await invoke("network_log", { rows: [], clear: true }).catch(() => {});
    renderNetworkLog(body);
    showToast("Log cleared");
  });
}

/* ─── Menu Grid ─── */
interface MenuItem { id: string; label: string; icon: string; action: () => void }
function getMenuItems(): MenuItem[] {
  return [
    { id: "bookmarks", label: "Bookmarks", icon: "🔖", action: () => { invoke<Bookmark[]>("list_bookmarks").then(b => { bookmarks = b; openPanel("Bookmarks", b => renderBookmarks(b), "bookmarks"); }); } },
    { id: "history", label: "History", icon: "🕐", action: () => { invoke<HistItem[]>("list_history").then(h => { historyItems = h; openPanel("History", b => renderHistory(b), "history"); }); } },
    { id: "downloads", label: "Downloads", icon: "⬇", action: () => { invoke<DlItem[]>("list_downloads").then(d => { downloads = d; openPanel("Downloads", renderDownloads, "downloads"); }); } },
    { id: "scripts", label: "Scripts", icon: "📜", action: () => openPanel("Scripts", renderScripts, "scripts") },
    { id: "siteconfig", label: "Site config", icon: "🌐", action: () => openPanel("Site Configuration", renderSiteConfig, "siteconfig") },
    { id: "cookies", label: "Cookies", icon: "🍪", action: () => openPanel("Cookies", renderCookieInspector, "cookies") },
    { id: "find", label: "Find in page", icon: "🔍", action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "var p=prompt('Find:');if(p)window.find(p)" }); } },
    { id: "desktop", label: desktopMode ? "Desktop site" : "Mobile site", icon: desktopMode ? "🖥" : "📱", action: () => { desktopMode = !desktopMode; if (settings) { settings.desktop_mode = desktopMode; saveSettings(); } if (activeId) { const t = tabs.find(t => t.id === activeId); if (t) invoke("navigate_tab", { id: activeId, url: t.url }); } showToast("Switched to " + (desktopMode ? "Desktop" : "Mobile")); } },
    { id: "night", label: "Night mode", icon: "🌙", action: () => { nightMode = !nightMode; if (activeId) invoke("set_night_mode", { id: activeId, enabled: nightMode }).catch(() => {}); if (settings) { settings.night_mode = nightMode; saveSettings(); } showToast(nightMode ? "Night ON" : "Night OFF"); } },
    { id: "addbook", label: "Bookmark page", icon: "➕", action: () => { if (!activeId) return; const t = tabs.find(t => t.id === activeId); if (!t) return; invoke("add_bookmark", { url: t.url, title: t.title, folder: "home" }).then(() => { bookmarks.push({ url: t.url, title: t.title, folder: "home" }); showToast("Bookmarked!"); }).catch(() => showToast("Already bookmarked")); } },
    { id: "savepage", label: "Save page", icon: "💾", action: () => { if (!activeId) return; const t = tabs.find(t => t.id === activeId); if (!t) return; invoke<string>("eval_tab", { id: activeId, js: "document.documentElement.outerHTML" }).then((html) => {
      invoke<string>("save_page", { url: t.url, html, title: t.title }).then(p => showToast("Saved: " + p.split(/[\\/]/).pop())).catch(() => showToast("Save failed"));
    }).catch(() => showToast("Save failed")); } },
    { id: "viewsrc", label: "View source", icon: "📝", action: () => { if (!activeId) return; invoke<string>("eval_tab", { id: activeId, js: "document.documentElement.outerHTML" }).then((html) => {
      createTab("data:text/html,<pre>" + encodeURIComponent(html.slice(0, 100000))).then(info => switchTab(info.id));
    }).catch(() => showToast("Source unavailable")); } },
    { id: "translate", label: "Translate", icon: "🌍", action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "(function(){var s=document.createElement('script');s.src='https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';document.head.appendChild(s);window.googleTranslateElementInit=function(){new google.translate.TranslateElement({pageLanguage:'auto'},'google_translate_element');};})()" }); showToast("Translate loading…"); } },
    { id: "fullscreen", label: "Fullscreen", icon: "⛶", action: () => { if (activeId) invoke("eval_tab", { id: activeId, js: "document.documentElement.requestFullscreen?.()" }); } },
    { id: "reader", label: "Reader mode", icon: "📖", action: () => { if (activeId) { const js = invoke<string>("reader_bundle").catch(() => ""); js.then(j => { if (j && activeId) invoke("eval_tab", { id: activeId, js: j }); }); showToast("Reader mode activated"); } } },
    { id: "netlog", label: "Network log", icon: "📊", action: () => openPanel("Network Log", renderNetworkLog, "netlog") },
    { id: "clear", label: "Clear data", icon: "🗑", action: () => { openPanel("Clear Data", renderClearData, "cleardata"); } },
    { id: "settings", label: "Settings", icon: "⚙", action: () => openPanel("Settings", renderSettings, "settings") },
    { id: "about", label: "About", icon: "ℹ", action: () => openPanel("About", renderAbout, "about") },
  ];
}

function renderClearData(body: HTMLElement) {
  body.innerHTML = `
    <div class="set-section">
      <div class="set-label">Clear Data</div>
      <div class="set-row" data-clear="all"><div class="sr-text"><div class="sr-title">Clear all browsing data</div><div class="sr-desc">Cache, cookies, history</div></div></div>
    </div>`;
  body.querySelector("[data-clear='all']")?.addEventListener("click", async () => {
    await invoke("clear_data").catch(() => {});
    await invoke("clear_history").catch(() => {});
    showToast("All data cleared");
    closePanel();
  });
}

function renderAbout(body: HTMLElement) {
  body.innerHTML = `
    <div style="text-align:center;padding:40px 20px">
      <img src="/via-logo.svg" alt="Via" style="width:80px;margin-bottom:16px" />
      <div style="font-size:18px;font-weight:600;color:#fff;margin-bottom:4px">Via Browser</div>
      <div style="font-size:12px;color:#888;margin-bottom:24px">Version 7.2.1 · Windows</div>
      <div style="font-size:12px;color:#888;line-height:1.8">
        Tauri 2 + WebView2<br>
        A fast, minimal, customizable browser.<br>
        Inspired by the original Via Browser for Android.
      </div>
    </div>`;
}

function renderMenu(body: HTMLElement) {
  const items = getMenuItems();
  body.innerHTML = `<div class="mg" id="menu-grid">
    ${items.map(m => `<div class="mg-item" data-mid="${m.id}">
      <div class="mg-icon">${m.icon}</div><div class="mg-label">${m.label}</div></div>`).join("")}</div>`;
  const grid = $("menu-grid")!;
  grid.querySelectorAll(".mg-item[data-mid]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-mid")!;
      const item = items.find(m => m.id === id);
      if (item) { closePanel(); item.action(); }
    });
  });
}

/* ─── Context Menu ─── */
function initContextMenu() {
  document.addEventListener("contextmenu", (e) => {
    removeContextMenu();
    const target = e.target as HTMLElement;
    const link = target.closest("a[href]");
    if (!link && !target.closest("img")) return;
    e.preventDefault();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    if (link) {
      const href = link.getAttribute("href") || "";
      const items = [
        { label: "Open in new tab", action: () => createTab(href).then(i => switchTab(i.id)) },
        { label: "Copy link address", action: () => navigator.clipboard.writeText(href).then(() => showToast("Copied")) },
        { label: "Save link as…", action: () => invoke<string>("download_from_js", { url: href, filename: null }).then(p => showToast("Saved: " + p.split(/[\\/]/).pop())).catch(() => showToast("Download failed")) },
      ];
      menu.innerHTML = items.map(i => `<div class="cm-item">${i.label}</div>`).join("");
      menu.querySelectorAll(".cm-item").forEach((el, idx) => {
        el.addEventListener("click", () => { items[idx].action(); removeContextMenu(); });
      });
    } else if (target.closest("img")) {
      const img = target.closest("img") as HTMLImageElement;
      const src = img.src || "";
      const items = [
        { label: "Open image in new tab", action: () => createTab(src).then(i => switchTab(i.id)) },
        { label: "Copy image URL", action: () => navigator.clipboard.writeText(src).then(() => showToast("Copied")) },
        { label: "Save image as…", action: () => invoke<string>("download_from_js", { url: src, filename: null }).then(p => showToast("Saved: " + p.split(/[\\/]/).pop())).catch(() => showToast("Download failed")) },
      ];
      menu.innerHTML = items.map(i => `<div class="cm-item">${i.label}</div>`).join("");
      menu.querySelectorAll(".cm-item").forEach((el, idx) => {
        el.addEventListener("click", () => { items[idx].action(); removeContextMenu(); });
      });
    }
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.appendChild(menu);
    contextMenu = menu;
    setTimeout(() => document.addEventListener("click", removeContextMenu, { once: true }), 50);
  });
}
function removeContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
}

/* ─── Homepage ─── */
function renderHomepage() {
  const shortcutsEl = $("home-shortcuts");
  const sc = homepageShortcuts.length ? homepageShortcuts : DEFAULT_SHORTCUTS;
  shortcutsEl.innerHTML = sc.map(s =>
    `<div class="sc" data-url="${esc(s.url)}"><img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44'><rect width='44' height='44' rx='8' fill='%231a1a1a'/><text x='22' y='28' font-size='20' text-anchor='middle' fill='%23fff'>${encodeURIComponent(s.icon)}</text></svg>" alt="${esc(s.label)}" /><span>${esc(s.label)}</span></div>`
  ).join("");
  shortcutsEl.querySelectorAll(".sc[data-url]").forEach(el => {
    el.addEventListener("click", () => navigate(el.getAttribute("data-url")!));
  });
}

/* ─── Utilities ─── */
function esc(s: string): string { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const u = ["B","KB","MB","GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

/* ─── Keyboard Shortcuts ─── */
document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement && e.key === "Escape") {
    if (overlay === "panel") closePanel();
    ($q<HTMLElement>("#tb-addr input") as HTMLElement).blur();
    return;
  }
  if (e.target instanceof HTMLInputElement) return;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    switch (e.key.toLowerCase()) {
      case "t": e.preventDefault(); undoCloseTab(); break;
      case "n": e.preventDefault(); incognitoMode = !incognitoMode; showToast(incognitoMode ? "Incognito ON" : "Incognito OFF"); break;
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    switch (e.key.toLowerCase()) {
      case "t": e.preventDefault(); createTab().then(info => switchTab(info.id)); break;
      case "w": e.preventDefault(); if (activeId) closeTab(activeId); break;
      case "l": e.preventDefault(); { const inp = $("tb-input") as HTMLInputElement; inp.focus(); inp.select(); break; }
      case "r": e.preventDefault(); if (activeId) { const t = tabs.find(t => t.id === activeId); if (t) invoke("navigate_tab", { id: activeId, url: t.url }); } break;
      case "f": e.preventDefault(); if (activeId) invoke("eval_tab", { id: activeId, js: "var p=prompt('Find:');if(p)window.find(p)" }); break;
      case "d": e.preventDefault(); getMenuItems().find(m => m.id === "addbook")?.action(); break;
      case "h": e.preventDefault(); getMenuItems().find(m => m.id === "history")?.action(); break;
      case "j": e.preventDefault(); getMenuItems().find(m => m.id === "downloads")?.action(); break;
      case "+": case "=": e.preventDefault(); textSize = Math.min(textSize + 0.25, 3.0); if (settings) settings.text_size = textSize; applyTextSize(); saveSettings(); break;
      case "-": e.preventDefault(); textSize = Math.max(textSize - 0.25, 0.5); if (settings) settings.text_size = textSize; applyTextSize(); saveSettings(); break;
    }
  }
  if (e.altKey) {
    if (e.key === "ArrowLeft") { e.preventDefault(); if (activeId) invoke("eval_tab", { id: activeId, js: "history.back()" }); }
    if (e.key === "ArrowRight") { e.preventDefault(); if (activeId) invoke("eval_tab", { id: activeId, js: "history.forward()" }); }
  }
  if (e.key === "Escape" && overlay === "panel") closePanel();
  if (e.key === "F5") { e.preventDefault(); if (activeId) { const t = tabs.find(t => t.id === activeId); if (t) invoke("navigate_tab", { id: activeId, url: t.url }); } }
  if (e.key === "F11") { e.preventDefault(); if (activeId) invoke("eval_tab", { id: activeId, js: "document.documentElement.requestFullscreen?.()" }).catch(() => {}); }
});

/* ─── IPC Listeners ─── */
listen<TabInfo>("tab-url", async (ev) => {
  const { id, url } = ev.payload;
  const tab = tabs.find(t => t.id === id);
  if (tab) { tab.url = url; }
  if (id === activeId) {
    ($q<HTMLInputElement>("#tb-input")).value = url || "";
    updateBackFwd();
    // Add to history
    if (url && url !== "about:blank" && !url.startsWith("data:")) {
      const title = tab?.title || url;
      invoke("add_history", { url, title }).catch(() => {});
      historyItems.unshift({ url, title, ts: Math.floor(Date.now() / 1000) });
    }
  }
  // Save session on navigation
  saveSession();
});
listen<{ id: number; title: string }>("tab-title", (ev) => {
  const tab = tabs.find(t => t.id === ev.payload.id);
  if (tab) { tab.title = ev.payload.title; }
  if (ev.payload.id === activeId) document.title = ev.payload.title ? ev.payload.title + " — Via" : "Via Browser";
});
listen<{ url: string }>("new-window-request", async (ev) => {
  const u = ev.payload.url;
  if (!u || u.startsWith("about:")) return;
  const info = await createTab(u, true);
  switchTab(info.id);
  showToast("Opened in new tab");
});
listen<{ id: number | null; url: string; path: string; total?: number }>("download-started", (ev) => {
  showToast("Download started…");
  const d = ev.payload;
  activeDl.push({ url: d.url, path: d.path, received: 0, total: d.total || 0, done: false });
});
listen<{ id: number | null; url: string; path: string; received?: number; total?: number; done?: boolean; success?: boolean }>("download-progress", (ev) => {
  const d = ev.payload;
  const existing = activeDl.find(x => x.url === d.url);
  if (existing) {
    existing.received = d.received || existing.received;
    existing.total = d.total || existing.total;
    existing.done = !!d.done;
    if (d.success !== undefined) existing.success = d.success;
  } else {
    activeDl.push({ url: d.url, path: d.path, received: d.received || 0, total: d.total || 0, done: !!d.done, success: d.success });
  }
  if (d.done) showToast(d.success === false ? "Download failed" : "Download complete");
  if (overlay === "panel" && panelStack[panelStack.length - 1] === "downloads") {
    refreshDlList($q<HTMLElement>("#dl-list"));
  }
});
listen<{ id: number; msg: string }>("via-msg", async (ev) => {
  let arr: any[] = [];
  try { arr = JSON.parse(ev.payload.msg); } catch { return; }
  const [action, data] = arr;
  if ((action === "download" || action === "startDl") && data?.url) {
    invoke<string>("download_from_js", { url: data.url, filename: data.filename || null })
      .then((path: string) => showToast("Saved: " + path.split(/[\\/]/).pop()))
      .catch(() => showToast("Download failed"));
  } else if (action === "saveBlob" && data?.url && data?.bytes) {
    invoke<string>("save_blob_download", { url: data.url, filename: data.filename || null, bytes: data.bytes })
      .then((path: string) => showToast("Saved: " + path.split(/[\\/]/).pop()))
      .catch(() => showToast("Blob download failed"));
  } else if (action === "dlTotal" && data?.url && data?.len > 0) {
    const dl = activeDl.find(x => x.url === data.url);
    if (dl) dl.total = data.len;
  }
});

/* ─── Boot ─── */
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
    homepageShortcuts = (settings.homepage_shortcuts?.length) ? settings.homepage_shortcuts : [...DEFAULT_SHORTCUTS];
  }
  bookmarks = await invoke<Bookmark[]>("list_bookmarks").catch(() => []);
  historyItems = await invoke<HistItem[]>("list_history").catch(() => []);
  downloads = await invoke<DlItem[]>("list_downloads").catch(() => []);

  // Session restore
  if (restoreTabs) {
    const session = await invoke<SessionEntry[]>("restore_session").catch(() => []);
    if (session.length) {
      for (const entry of session.sort((a, b) => a.order - b.order)) {
        const info = await createTab(entry.url !== "about:blank" ? entry.url : undefined, !entry.active);
        if (entry.active) {
          await switchTab(info.id);
        }
      }
      if (activeId) {
        const t = tabs.find(t => t.id === activeId);
        if (t) {
          $("home").classList.add("hidden");
          ($q<HTMLInputElement>("#tb-input")).value = t.url;
        }
      }
      updateTabCount();
    }
  }

  renderHomepage();
  initContextMenu();

  // toolbar buttons
  $("tb-back").addEventListener("click", () => { if (activeId) invoke("eval_tab", { id: activeId, js: "history.back()" }); });
  $("tb-fwd").addEventListener("click", () => { if (activeId) invoke("eval_tab", { id: activeId, js: "history.forward()" }); });
  $("tb-reload").addEventListener("click", () => { if (activeId) { const tab = tabs.find(t => t.id === activeId); if (tab) invoke("navigate_tab", { id: activeId, url: tab.url }).catch(() => {}); } });
  $("tb-home").addEventListener("click", () => {
    if (activeId) {
      const tab = tabs.find(t => t.id === activeId);
      if (tab && tab.url !== "about:blank") {
        invoke("navigate_tab", { id: activeId, url: "about:blank" }).catch(() => {});
      }
    }
    $("home").classList.remove("hidden");
  });
  $("tb-menu").addEventListener("click", () => openPanel("Menu", renderMenu, "menu"));
  $("tb-tabs").addEventListener("click", () => {
    openPanel("Tabs (" + tabs.length + ")", b => {
      b.innerHTML = `<div class="pp-list">${tabs.length ? tabs.map(t =>
        `<div class="pp-item" data-tab="${t.id}" style="${t.id === activeId ? 'background:var(--bg4)' : ''}">
          <div class="pi-icon">${t.id === activeId ? "▶" : "◻"}</div>
          <div class="pi-info"><div class="pi-title">${esc(t.title || "New Tab")}</div>
          <div class="pi-sub">${esc(t.url || "about:blank")}</div></div>
          <div class="pi-action" data-ctab="${t.id}">✕</div></div>`).join("") : '<div class="empty-state">No tabs</div>'}</div>
      <div style="padding:12px 16px"><button class="mg-item" style="width:100%;border:1px solid var(--bg4)" id="new-tab-btn">+ New Tab</button></div>`;
      b.querySelector("#new-tab-btn")?.addEventListener("click", () => { closePanel(); createTab().then(info => switchTab(info.id)); });
      b.querySelectorAll(".pp-item[data-tab]").forEach(el => {
        el.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).classList.contains("pi-action")) return;
          const id = parseInt(el.getAttribute("data-tab")!);
          closePanel(); switchTab(id);
        });
      });
      b.querySelectorAll(".pi-action[data-ctab]").forEach(el => {
        el.addEventListener("click", (e) => {
          e.stopPropagation(); closeTab(parseInt(el.getAttribute("data-ctab")!));
        });
      });
    }, "tabs");
  });

  // address bar
  $("tb-addr-go").addEventListener("click", handleAddressGo);
  ($q<HTMLInputElement>("#tb-input")).addEventListener("keydown", (e) => { if (e.key === "Enter") handleAddressGo(); });
  ($q<HTMLInputElement>("#home-input")).addEventListener("keydown", (e) => { if (e.key === "Enter") {
    const val = (e.target as HTMLInputElement).value.trim();
    if (val) {
      if (/^https?:\/\//i.test(val) || /^[a-z0-9-]+\.[a-z]/i.test(val) || val.includes("://")) {
        navigate(/^https?:\/\//i.test(val) ? val : "https://" + val);
      } else {
        navigate(ENGINES[searchEngine] + encodeURIComponent(val));
      }
    }
  }});

  // panel back + backdrop
  $("panel-back").addEventListener("click", () => {
    if (panelStack.length > 1) { panelStack.pop(); closePanel(); } else closePanel();
  });
  $("panel-backdrop").addEventListener("click", closePanel);

  // Save session on close
  window.addEventListener("beforeunload", () => { saveSession(); });

  console.log("[Via] Boot complete");
}
boot();
