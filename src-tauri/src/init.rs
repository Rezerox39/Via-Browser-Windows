use crate::adblock::load_default_filters;
use crate::settings::Settings;

/// Builds the JavaScript injected into every page at document start.
/// It implements:
///  - cosmetic ad hiding (from the Via filter list + user CSS)
///  - fetch/XMLHttpRequest blocking against the Via domain list
///  - user JS execution
pub fn build(s: &Settings) -> String {
    let blocker = load_default_filters();
    let hosts: Vec<&str> = blocker.host_list();
    let hosts_js = hosts.join("|");
    let cosmetic = blocker.global_cosmetic_css();
    let user_css = &s.user_css;
    let user_js = &s.user_js;
    let adblock = s.adblock_enabled;

    format!(
        r#"(function () {{
  var ADBLOCK = {adblock};
  var BLOCKED_RE = /(?:^|\.)({hosts_js})$/i;
  var COSMETIC_CSS = {cosmetic_css_json};
  var USER_CSS = {user_css_json};
  var USER_JS = {user_js_json};

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
        if (blockable(u)) return Promise.reject(new TypeError("Blocked by Via Browser"));
      }} catch (e) {{}}
      return _fetch.apply(this, arguments);
    }};
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {{
      try {{
        if (blockable(url)) {{ this.abort(); return; }}
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
    var css = (ADBLOCK ? COSMETIC_CSS : "") + "\n" + USER_CSS;
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

  if (USER_JS) {{
    try {{ new Function(USER_JS)(); }} catch (e) {{ console.error("[Via] user JS error", e); }}
  }}
}})();
"#,
        adblock = if adblock { "true" } else { "false" },
        hosts_js = hosts_js,
        cosmetic_css_json = serde_json::to_string(&cosmetic).unwrap_or_default(),
        user_css_json = serde_json::to_string(user_css).unwrap_or_default(),
        user_js_json = serde_json::to_string(user_js).unwrap_or_default(),
    )
}
