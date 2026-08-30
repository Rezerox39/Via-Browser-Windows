// Headless DOM smoke test for panel rendering + key bindings.
import { JSDOM } from "jsdom";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const html = readFileSync("index.html", "utf8");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
const { window } = dom; const { document } = window;
let tabId = 0; const store = { tabs: [], bookmarks: [], history: [], downloads: [] };
const settings = { homepage: "about:blank", search_engine: "Google", ua_mode: "Desktop", custom_ua: "", adblock_enabled: true, clear_on_exit: false, user_css: "", user_js: "", night_mode: false, desktop_mode: true, text_size: 1, show_images: true, network_log: false, game_mode: false, read_aloud_enabled: false, scripts: [], sites: [], pages_log: [] };
const listeners = new Map();
const invoke = async (cmd, args = {}) => {
  switch (cmd) {
    case "get_settings": return { ...settings };
    case "set_settings": return null;
    case "create_tab": return { id: ++tabId, url: args.url || "about:blank", title: "", loading: false, active: true };
    case "select_tab": case "close_tab": case "navigate_tab": case "eval_tab": case "hide_tab": case "show_tab": return null;
    case "list_bookmarks": return store.bookmarks;
    case "list_history": return store.history;
    case "list_downloads": return store.downloads;
    case "file_size": return 0;
    case "search_suggest": return [];
    case "parse_and_load_url": return "https://example.com/";
    case "network_log": return [];
    default: return null;
  }
};
const listen = (n, h) => { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(h); return Promise.resolve(() => { }); };
window.__TAURI_INTERNALS__ = { invoke, transformCallback: () => "cb0", unregisterCallback: () => { }, convertFileSrc: s => s, metadata: { currentWindow: { label: "main" } } };
window.requestAnimationFrame = cb => setTimeout(cb, 0);
window.getSelection = () => ({ removeAllRanges() { } });
window.NodeFilter = { SHOW_TEXT: 4 };
window.speechSynthesis = { speak() { }, cancel() { }, resume() { } };
window.fetch = async () => ({ text: async () => "<html></html>", ok: true });

const distDir = join(process.cwd(), "dist", "assets");
const jsFile = readdirSync(distDir).find(f => f.endsWith(".js") && f.startsWith("index-"));
await window.eval(readFileSync(join(distDir, jsFile), "utf8"));
await new Promise(r => setTimeout(r, 150));
const click = id => document.getElementById(id)?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

async function openPanel(id) { click(id); await new Promise(r => setTimeout(r, 120)); }
const results = [];
for (const id of ["m-down", "m-bkm", "m-hist", "m-settings"]) {
  await openPanel(id);
  const panel = document.getElementById("panel");
  const pcs = panel ? panel.querySelectorAll(".pc") : [];
  const pc = panel ? panel.querySelector(".pc") : null;
  const pb = panel ? panel.querySelector(".pb") : null;
  results.push({
    id, opened: !!panel,
    page: !!(panel && panel.classList.contains("pg")),
    title: panel ? (panel.querySelector(".ph b") || {}).textContent : null,
    hasContent: panel ? pb.children.length > 0 : false,
    // Visibility guard: exactly ONE .pc (no nested wrapper). That single .pc
    // must carry .on (slide-in transform), otherwise content sits off-screen.
    singlePcVisible: pcs.length === 1 && !!pc && pc.classList.contains("on"),
  });
  // close via back button
  const back = panel && panel.querySelector("#p-close");
  if (back) { back.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); await new Promise(r => setTimeout(r, 250)); }
  const stillOpen = !!document.getElementById("panel");
  results[results.length - 1].closes = !stillOpen;
}

// Settings: switch to Customization tab and verify rows still render
await openPanel("m-settings");
const customTab = document.querySelector(".settab[data-cat='custom']");
if (customTab) customTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 30));
const customVisible = !document.getElementById("cat-custom").hidden;
results.push({ id: "settings-custom-tab", opened: true, customVisible, nightSwitch: !!document.querySelector("[data-set='night']") });

// Text-size sub-menu (uses qs binds + slider)
document.querySelector("#p-close")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 250));
click("m-textsize"); await new Promise(r => setTimeout(r, 120));
const tsPanel = document.getElementById("panel");
results.push({ id: "m-textsize", opened: !!tsPanel, range: !!tsPanel?.querySelector("#ts-range") });

console.log(JSON.stringify(results, null, 2));
const fails = results.filter(r => r.opened === false || r.closes === false || (r.id === "settings-custom-tab" && (!r.customVisible || !r.nightSwitch)) || (r.id === "m-textsize" && !r.range));
if (results.some(r => r.singlePcVisible === false && r.opened)) {
  console.error("FAIL: panel .pc nesting/visibility guard", JSON.stringify(results));
  process.exit(1);
}
if (fails.length) { console.error("FAIL:", JSON.stringify(fails)); process.exit(1); }
console.log("SMOKE TEST PASSED");
process.exit(0);
