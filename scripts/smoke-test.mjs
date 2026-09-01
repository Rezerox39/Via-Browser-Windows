import { JSDOM } from "jsdom";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const html = readFileSync("index.html", "utf8");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
const { window } = dom; const { document } = window;
let tabId = 0;
const store = { tabs: [], bookmarks: [{ url: "https://a.com", title: "A", folder: "home" }], history: [], downloads: [] };
const settings = { homepage: "about:blank", search_engine: "Google", ua_mode: "Desktop", custom_ua: "", adblock_enabled: true, clear_on_exit: false, user_css: "", night_mode: false, desktop_mode: true, text_size: 1, show_images: true, network_log: false, search_suggest: false, game_mode: false, scripts: [], sites: [], pages_log: [], restore_tabs: false, homepage_shortcuts: [], toolbar_layout: { placement: "bottom", visible: [], compact_two_row: false } };
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
await new Promise(r => setTimeout(r, 200));
const results = [];
const pass = (name, ok, extra = {}) => results.push({ name, ok, ...extra });

// 1) Static containers
for (const id of ["home", "bottomNav", "nav-back", "nav-fwd", "nav-url", "nav-tabs", "nav-menu", "url-overlay", "url-input", "panel", "panel-backdrop", "toast", "home-input", "home-logo", "home-shortcuts", "panel-body", "panel-title"]) {
  pass("container-" + id, !!document.getElementById(id), { ok: !!document.getElementById(id) });
}

// 2) Bottom nav exists
pass("bottom-nav-exists", !!document.getElementById("bottomNav"));

// 3) Menu opens from bottom nav
document.getElementById("nav-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 150));
const panel = document.getElementById("panel");
pass("menu-opens", panel && panel.classList.contains("open"));
pass("menu-grid-renders", !!panel?.querySelector("#menu-grid"));

// 4) Close menu
document.getElementById("panel-backdrop").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
pass("menu-closes", !panel.classList.contains("open"));

// 5) URL overlay opens
document.getElementById("nav-url").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 100));
pass("url-overlay-opens", document.getElementById("url-overlay")?.classList.contains("open"));
document.getElementById("url-cancel")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 100));
pass("url-overlay-closes", !document.getElementById("url-overlay")?.classList.contains("open"));

// 6) IPC listeners registered
for (const evt of ["download-started", "download-progress", "tab-url", "tab-title", "via-msg", "new-window-request"]) {
  pass("ipc-" + evt, registeredEvents.has(evt));
}

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) { console.log(`SMOKE TEST FAILED (${failed} failures)`); process.exit(1); }
else { console.log("SMOKE TEST PASSED"); }
