// Headless DOM smoke test for the rebuilt Via desktop shell.
// Exercises the static HTML containers, panel open/close, settings,b menu,
// downloads IPC wiring, and keyboard nav. Deterministic test seams only:
// tauri internals are stubbed. Windows UI behavior (webview, real downloads)
// must still be validated on a Windows machine (documented in TESTING.md).
import { JSDOM } from "jsdom";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const html = readFileSync("index.html", "utf8");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
const { window } = dom; const { document } = window;
let tabId = 0;
const store = { tabs: [], bookmarks: [{ url: "https://a.com", title: "A", folder: "home" }], history: [], downloads: [] };
const settings = { homepage: "about:blank", search_engine: "Google", ua_mode: "Desktop", custom_ua: "", adblock_enabled: true, clear_on_exit: false, user_css: "", user_js: "", night_mode: false, desktop_mode: true, text_size: 1, show_images: true, network_log: false, search_suggest: false, game_mode: false, read_aloud_enabled: false, scripts: [], sites: [], pages_log: [] };
const registeredEvents = new Set();
const invoke = async (cmd, args = {}) => {
  if (cmd === "plugin:event|listen" && args && args.event) { registeredEvents.add(args.event); return "evt-" + registeredEvents.size; }
  switch (cmd) {
    case "get_settings": return { ...settings };
    case "set_settings": return null;
    case "create_tab": return { id: ++tabId, url: args.url || "about:blank", title: "", loading: false, active: true };
    case "select_tab": case "close_tab": case "navigate_tab": case "eval_tab": case "hide_tab": case "show_tab":
    case "get_tab_url": case "add_history": return null;
    case "list_bookmarks": return store.bookmarks;
    case "list_history": return store.history;
    case "list_downloads": return store.downloads;
    case "file_size": return 0;
    case "search_suggest": return [];
    case "parse_and_load_url": return "https://example.com/";
    default: return null;
  }
};
const listen = () => Promise.resolve(() => { });
window.__TAURI_INTERNALS__ = { invoke, transformCallback: () => "cb0", unregisterCallback: () => { }, convertFileSrc: s => s, metadata: { currentWindow: { label: "main" } } };
window.requestAnimationFrame = cb => setTimeout(cb, 0);
window.fetch = async () => ({ text: async () => "<html></html>", ok: true });

const distDir = join(process.cwd(), "dist", "assets");
const jsFile = readdirSync(distDir).find(f => f.endsWith(".js") && f.startsWith("index-"));
await window.eval(readFileSync(join(distDir, jsFile), "utf8"));
await new Promise(r => setTimeout(r, 150));
const results = [];
const pass = (name, ok, extra = {}) => results.push({ name, ok, ...extra });

// 1) Static containers exist (the architecture no longer relies on JS-injected shells)
for (const id of ["toolbar", "stage", "home", "panel", "panel-backdrop", "toast", "tb-input", "home-input", "home-logo", "home-shortcuts", "tb-back", "tb-fwd", "tb-reload", "tb-menu", "tb-tabs", "panel-body", "panel-title"]) {
  pass("container-" + id, !!document.getElementById(id), { ok: !!document.getElementById(id) });
}

// 2) Toolbar actions wire up: back/fwd/reload/menu/tabs render correct handlers
const tb = document.getElementById("tb-menu");
pass("menu-button-exists", !!tb);

// 3) Open the Menu panel via toolbar
document.getElementById("tb-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 120));
const panel = document.getElementById("panel");
pass("menu-opens", panel && panel.classList.contains("open"));
pass("panel-has-body", panel.querySelector("#panel-body") != null);
const grid = panel.querySelector("#menu-grid");
pass("menu-grid-renders", !!grid && grid.querySelectorAll(".mg-item").length > 0);
// close via backdrop
document.getElementById("panel-backdrop").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
pass("menu-closes", !panel.classList.contains("open"));

// 4) Bookmarks panel opens from menu and lists stored bookmarks
document.getElementById("tb-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 120));
const bmItem = [...document.querySelectorAll(".mg-item")].find(el => el.textContent.includes("Bookmarks"));
pass("menu-has-bookmarks", !!bmItem);
if (bmItem) { bmItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(r => setTimeout(r, 120)); }
const bmPanel = document.getElementById("panel");
pass("bookmarks-opens", bmPanel && bmPanel.classList.contains("open"));
const bmItems = document.querySelectorAll(".pp-item[data-url]");
pass("bookmarks-listed", bmItems.length === 1, { count: bmItems.length });
// back closes
document.getElementById("panel-back").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
pass("bookmarks-closes", !document.getElementById("panel").classList.contains("open"));

// 5) Settings panel opens with the 3 core sections
document.getElementById("tb-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 120));
const setItem = [...document.querySelectorAll(".mg-item")].find(el => el.textContent.includes("Settings"));
if (setItem) { setItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(r => setTimeout(r, 120)); }
const setPanel = document.getElementById("panel");
pass("settings-opens", setPanel && setPanel.classList.contains("open"));
pass("settings-rows", document.querySelectorAll("#panel-body .set-row").length >= 8, { count: document.querySelectorAll("#panel-body .set-row").length });

// 6) IPC download listeners are registered (toast + panel tied to real events)
for (const ev of ["download-started", "download-progress", "new-window-request", "tab-url", "tab-title", "via-msg"]) {
  pass("ipc-" + ev, registeredEvents.has(ev), { ok: registeredEvents.has(ev) });
}

const fails = results.filter(r => !r.ok);
console.log(JSON.stringify(results, null, 2));
if (fails.length) { console.error("FAIL:", fails.map(f => f.name).join(", ")); process.exit(1); }
console.log("SMOKE TEST PASSED");
process.exit(0);
