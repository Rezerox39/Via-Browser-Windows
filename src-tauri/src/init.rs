use crate::adblock;
use crate::settings::Settings;

/// Builds the JavaScript injected into every page at document start.
/// It implements:
///  - cosmetic ad hiding (Via filter list + "Mark as ad" user rules)
///  - fetch/XMLHttpRequest blocking against the Via domain list
///  - user scripts (Tampermonkey-style, from the Scripts manager)
///  - text-size zoom + show/hide images
///  - media resource sniffer capture
pub fn build(s: &Settings) -> String {
    let blocker = adblock::load_default_filters();
    let hosts: Vec<&str> = blocker.host_list();
    let hosts_js = hosts.join("|");
    let cosmetic_rules = adblock::all_cosmetic_rules_json();
    let user_css = &s.user_css;
    let adblock = s.adblock_enabled;
    let text_size = s.text_size.clamp(0.5, 3.0);
    let show_images = s.show_images;

    // User scripts with URL matching (empty pattern = all pages).
    let scripts_js: Vec<String> = s
        .scripts
        .iter()
        .filter(|sc| sc.enabled && !sc.code.trim().is_empty())
        .map(|sc| {
            format!(
                r#"{{pattern:{}, body:function(){{{}}}}}"#,
                serde_json::to_string(&sc.match_urls).unwrap_or_default(),
                sc.code.replace("</script", "<\\/script")
            )
        })
        .collect();
    let scripts_js = scripts_js.join(",");

    format!(
        r#"(function () {{
  var ADBLOCK = {adblock};
  var BLOCKED_RE = /(?:^|\.)({hosts_js})$/i;
  var RULES = {cosmetic_rules_json};
  var USER_CSS = {user_css_json};
  var TEXT_SIZE = {text_size};
  var SHOW_IMAGES = {show_images};
  var NETLOG = {network_log};
  // Secure page->host message bus (Via-style): the page may only send small
  // whitelisted payloads by briefly setting document.title to "VIA:" + JSON.
  // Rust's on_document_title_changed handler parses these and forwards to the UI.
  var __viaRealTitle = document.title;
  try {{
    document.addEventListener("DOMContentLoaded", function () {{
      if (document.title.indexOf("VIA:") !== 0) __viaRealTitle = document.title;
    }});
    setInterval(function () {{
      if (document.title.indexOf("VIA:") !== 0) __viaRealTitle = document.title;
    }}, 600);
  }} catch (e) {{}}
  window.__viaSend = function (action, data) {{
    try {{
      document.title = "VIA:" + encodeURIComponent(JSON.stringify([action, data || {{}}]));
      setTimeout(function () {{ document.title = __viaRealTitle; }}, 80);
    }} catch (e) {{}}
  }};

  function blockable(u) {{
    if (!u) return false;
    try {{
      var host = new URL(u, location.href).hostname;
      return BLOCKED_RE.test(host);
    }} catch (e) {{ return false; }}
  }}

  if (ADBLOCK) {{
    var _fetch = window.fetch;
    window.fetch = function (input, init) {{
      var u = typeof input === "string" ? input : (input && input.url) ? input.url : "";
      try {{
        if (blockable(u)) {{
          window.dispatchEvent(new CustomEvent("via-blocked", {{ detail: u }}));
          return Promise.reject(new TypeError("Blocked by Via Browser"));
        }}
      }} catch (e) {{}}
      return _fetch.apply(this, arguments);
    }};
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {{
      try {{
        if (blockable(url)) {{ this.abort(); window.dispatchEvent(new CustomEvent("via-blocked", {{ detail: String(url) }})); return; }}
      }} catch (e) {{}}
      return _open.apply(this, arguments);
    }};
    var _src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (_src) {{
      Object.defineProperty(HTMLImageElement.prototype, "src", {{
        set: function (v) {{
          if (blockable(String(v))) return;
          _src.set.call(this, v);
        }},
        get: function () {{ return _src.get.call(this); }}
      }});
    }}
  }}

  function applyCss() {{
    var css = "";
    try {{
      var host = location.hostname;
      RULES.forEach(function (r) {{
        var match = !r.domains || r.domains.length === 0 || r.domains.some(function (d) {{
          return host === d || host.endsWith("." + d);
        }});
        if (match) css += r.selector + " {{ display: none !important; }}\\n";
      }});
    }} catch (e) {{}}
    css = (ADBLOCK ? css : "") + "\\n" + USER_CSS;
    if (TEXT_SIZE !== 1) css += "html {{ zoom: " + TEXT_SIZE + "; }}\\n";
    if (!SHOW_IMAGES) css += "img, picture, [class*='img'], [class*='thumb'], [class*='banner'], video {{ visibility: hidden !important; }}\\n";
    if (!css) return;
    var style = document.createElement("style");
    style.textContent = css;
    style.setAttribute("data-via", "1");
    (document.head || document.documentElement).appendChild(style);
  }}
  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", applyCss);
  }} else {{
    applyCss();
  }}

  // ---- Media resource sniffer capture ----
  window.__viaMedia = window.__viaMedia || [];
  var MEDIA_RE = /\\.(mp4|m3u8|mp3|webm|ogg|ogv|oga|flac|wav|aac|m4a|m4v|mov|mkv|avi|ts|3gp)([?#]|$)/i;
  (function () {{
    function add(u) {{
      if (!u || window.__viaMedia.indexOf(u) !== -1) return;
      try {{ window.__viaMedia.push(new URL(u, location.href).href); }} catch (e) {{}}
    }}
    function scan() {{
      document.querySelectorAll("video,audio,source").forEach(function (el) {{ add(el.currentSrc || el.src || el.getAttribute("src")); }});
      document.querySelectorAll("a[href]").forEach(function (a) {{ if (MEDIA_RE.test(a.href)) add(a.href); }});
      if (window.performance && performance.getEntriesByType) {{
        performance.getEntriesByType("resource").forEach(function (e) {{ if (MEDIA_RE.test(e.name)) add(e.name); }});
      }}
    }}
    var _desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (_desc) {{
      Object.defineProperty(HTMLMediaElement.prototype, "src", {{
        set: function (v) {{
          if (MEDIA_RE.test(String(v))) add(String(v));
          _desc.set.call(this, v);
        }},
        get: function () {{ return _desc.get.call(this); }}
      }});
    }}
    document.addEventListener("DOMContentLoaded", function () {{ try {{ scan(); }} catch (e) {{}} }});
    setInterval(function () {{ try {{ scan(); }} catch (e) {{}} }}, 2500);
    window.__viaSniff = function () {{ try {{ scan(); }} catch (e) {{}} return window.__viaMedia.slice(); }};
  }})();

  // ---- Download-link capture (HTML5 download attrs, _blank file links) ----
  // WebView2's native DownloadStarting can be unreliable for child webviews;
  // this is the Via-style safety net: intercept obvious download clicks and
  // hand the URL to the host, which downloads it into the OS Downloads folder.
  var DL_RE = /\\.(apk|xapk|zip|rar|7z|tar|gz|bz2|xz|iso|img|exe|msi|msix|deb|rpm|dmg|pkg|torrent|mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|mpg|mpeg|3gp|mp3|wav|flac|aac|ogg|m4a|opus|wma)([?#]|$)/i;
  document.addEventListener("click", function (e) {{
    try {{
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      var dlAttr = a.hasAttribute("download") && a.getAttribute("download") !== "false";
      var isBlob = href.indexOf("blob:") === 0 || href.indexOf("data:") === 0;
      var isFile = DL_RE.test(href);
      if (!dlAttr && !isBlob && !isFile) return;
      // Only swallow left-click navigations that look like downloads. Let the
      // OS/browser handle anything ambiguous normally.
      e.preventDefault();
      e.stopPropagation();
      var u = new URL(href, location.href).href;
      window.__viaSend("download", {{ url: u, filename: dlAttr ? (a.getAttribute("download") || "") : "" }});
    }} catch (err) {{}}
  }}, true);

  // ---- User scripts ----
  var SCRIPTS = [{scripts_js}];
  SCRIPTS.forEach(function (sc) {{
    try {{
      var ok = !sc.pattern || new RegExp(sc.pattern).test(location.href);
      if (ok) sc.body();
    }} catch (e) {{ console.error("[Via] user script error", e); }}
  }});

}})();
"#,
        adblock = if adblock { "true" } else { "false" },
        hosts_js = hosts_js,
        cosmetic_rules_json = cosmetic_rules,
        user_css_json = serde_json::to_string(user_css).unwrap_or_default(),
        text_size = text_size,
        show_images = if show_images { "true" } else { "false" },
        network_log = if s.network_log { "true" } else { "false" },
        scripts_js = scripts_js,
    )
}
