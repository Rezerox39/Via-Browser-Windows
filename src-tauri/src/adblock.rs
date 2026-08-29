use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static FILTERS: OnceLock<FilterBlocker> = OnceLock::new();
static USER_FILTERS: OnceLock<Mutex<FilterBlocker>> = OnceLock::new();

#[derive(Clone, Serialize)]
pub struct BlockResult {
    pub blocked: bool,
    pub rule: String,
}

#[derive(Clone, Debug)]
enum Rule {
    Domain {
        host: String,
        subdomains: bool,
        exception: bool,
    },
    Path {
        needle: String,
        exception: bool,
    },
}

#[derive(Default)]
pub struct FilterBlocker {
    rules: Vec<Rule>,
    cosmetic: Vec<CosmeticRule>,
}

#[derive(Default, Clone)]
struct CosmeticRule {
    domains: Option<Vec<String>>,
    selector: String,
}

fn normalize_host(host: &str) -> String {
    host.trim()
        .trim_start_matches("*.")
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_lowercase()
}

impl FilterBlocker {
    pub fn parse(input: &str) -> Self {
        let mut rules = Vec::new();
        let mut cosmetic = Vec::new();
        for raw in input.lines() {
            let line = raw.trim().trim_start_matches('\u{feff}');
            if line.is_empty() || line.starts_with('!') || (line.starts_with('#') && !line.starts_with("##")) {
                continue;
            }
            let (exception, body) = if line.starts_with("@@") {
                (true, &line[2..])
            } else {
                (false, line)
            };

            if let Some(selector) = body.split("##").nth(1) {
                let selector = selector.trim();
                if !selector.is_empty() {
                    let domains = body.split("##").next().map(|d| {
                        d.split(',')
                            .filter(|x| !x.is_empty())
                            .map(|x| x.trim().trim_start_matches('.').to_lowercase())
                            .collect::<Vec<_>>()
                    }).filter(|v: &Vec<String>| !v.is_empty());
                    cosmetic.push(CosmeticRule { domains, selector: selector.to_string() });
                }
                continue;
            }

            if body.starts_with("||") {
                let rest = &body[2..];
                let (hostpart, pathpart) = match rest.find('/') {
                    Some(i) => (&rest[..i], Some(&rest[i..])),
                    None => (rest, None),
                };
                let host = normalize_host(hostpart);
                if host.is_empty() {
                    continue;
                }
                if let Some(p) = pathpart {
                    if !p.is_empty() {
                        rules.push(Rule::Path { needle: p.to_string(), exception });
                    }
                } else {
                    let subdomains = !host.starts_with("www.");
                    rules.push(Rule::Domain { host, subdomains, exception });
                }
            } else if body.starts_with('/') && body.ends_with('/') && body.len() > 2 {
                let needle = &body[1..body.len() - 1];
                rules.push(Rule::Path { needle: needle.to_string(), exception });
            } else if body.starts_with('|') {
                let needle = body.trim_matches('|');
                if !needle.is_empty() {
                    rules.push(Rule::Path { needle: needle.to_string(), exception });
                }
            } else if body.contains('.') && !body.contains(' ') && !body.contains('=') {
                let parts: Vec<&str> = body.split('/').collect();
                let host = normalize_host(parts[0]);
                if !host.is_empty() {
                    rules.push(Rule::Domain { host, subdomains: true, exception });
                }
            }
        }
        FilterBlocker { rules, cosmetic }
    }

    pub fn block(&self, url: &str) -> Option<BlockResult> {
        let lower = url.to_lowercase();
        let host = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
            .unwrap_or_default();

        for rule in &self.rules {
            let hit = match rule {
                Rule::Domain { host: h, subdomains, .. } => {
                    if host.is_empty() {
                        false
                    } else if *subdomains {
                        host == *h || host.ends_with(&format!(".{}", h))
                    } else {
                        host == *h
                    }
                }
                Rule::Path { needle, .. } => lower.contains(needle),
            };
            if hit {
                let exception = matches!(rule, Rule::Domain { exception: true, .. } | Rule::Path { exception: true, .. });
                if exception {
                    return None;
                }
                let rule_txt = match rule {
                    Rule::Domain { host, .. } => format!("||{host}^"),
                    Rule::Path { needle, .. } => needle.clone(),
                };
                return Some(BlockResult { blocked: true, rule: rule_txt });
            }
        }
        None
    }

    /// Concatenated host suffixes used to build a blocking regex in injected JS.
    pub fn host_list(&self) -> Vec<&str> {
        self.rules
            .iter()
            .filter_map(|r| match r {
                Rule::Domain { host, exception: false, .. } => Some(host.as_str()),
                _ => None,
            })
            .collect()
    }

    pub fn cosmetic_css(&self, url: &str) -> String {
        let host = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
            .unwrap_or_default();
        let mut css = String::new();
        for c in &self.cosmetic {
            match &c.domains {
                None => css.push_str(&format!("{} {{ display: none !important; }}\n", c.selector)),
                Some(doms) => {
                    if doms.iter().any(|d| host == *d || host.ends_with(&format!(".{}", d))) {
                        css.push_str(&format!("{} {{ display: none !important; }}\n", c.selector));
                    }
                }
            }
        }
        css
    }

    /// All cosmetic rules as JSON (domains + selector) so injected JS can apply
    /// them at runtime based on the actual page hostname.
    pub fn cosmetic_rules_json(&self) -> String {
        let rules: Vec<serde_json::Value> = self
            .cosmetic
            .iter()
            .map(|c| {
                serde_json::json!({
                    "domains": c.domains,
                    "selector": c.selector,
                })
            })
            .collect();
        serde_json::to_string(&rules).unwrap_or_else(|_| "[]".into())
    }

    pub fn user_rules(&self) -> Vec<String> {
        self.rules
            .iter()
            .map(|r| match r {
                Rule::Domain { host, .. } => format!("||{host}^"),
                Rule::Path { needle, .. } => needle.clone(),
            })
            .collect()
    }

    /// Mark-as-ad cosmetic rules as human-readable lines: `domain##selector`
    /// or `##selector` (global).
    pub fn marked_ads(&self) -> Vec<String> {
        self.cosmetic
            .iter()
            .map(|c| match &c.domains {
                Some(d) => format!("{}##{}", d.join(","), c.selector),
                None => format!("##{}", c.selector),
            })
            .collect()
    }
}

pub fn load_default_filters() -> &'static FilterBlocker {
    FILTERS.get_or_init(|| FilterBlocker::parse(include_str!("../assets/filters.txt")))
}

/// Load the user-added filter file (e.g. "Mark as ad" rules) from disk.
/// Call once at startup with the app config directory.
pub fn load_user_filters(dir: &std::path::Path) {
    {
        let mut guard = USER_FILTERS
            .get_or_init(|| Mutex::new(FilterBlocker::default()))
            .lock()
            .unwrap();
        let p = dir.join("user-filters.txt");
        if let Ok(data) = std::fs::read_to_string(&p) {
            *guard = FilterBlocker::parse(&data);
        }
    }
}

/// Persist a user-added cosmetic rule (Mark as ad) to the user filter store.
pub fn set_user_filter(dir: Option<&Path>, domain: Option<&str>, selector: &str) {
    let rule = match domain {
        Some(d) if !d.is_empty() => format!("{}##{}", d.trim_start_matches("www."), selector),
        _ => format!("##{}", selector),
    };
    {
        let mut uf = USER_FILTERS.get_or_init(|| Mutex::new(FilterBlocker::default())).lock().unwrap();
        let mut input = uf.user_rules();
        input.extend(uf.marked_ads());
        input.push(rule);
        *uf = FilterBlocker::parse(&input.join("\n"));
    }
    if let Some(dir) = dir {
        if let Some(uf) = USER_FILTERS.get() {
            if let Ok(uf) = uf.lock() {
                let mut lines = uf.user_rules();
                lines.extend(uf.marked_ads());
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::write(dir.join("user-filters.txt"), lines.join("\n"));
            }
        }
    }
}

/// Remove a user-added rule by index (0-based, in file order).
pub fn remove_user_filter(dir: Option<&Path>, index: usize) {
    let mut uf = USER_FILTERS.get_or_init(|| Mutex::new(FilterBlocker::default())).lock().unwrap();
    let mut rules = uf.user_rules();
    if index < rules.len() {
        rules.remove(index);
        *uf = FilterBlocker::parse(&rules.join("\n"));
    }
    drop(uf);
    if let Some(dir) = dir {
        if let Some(uf) = USER_FILTERS.get() {
            if let Ok(uf) = uf.lock() {
                let mut lines = uf.user_rules();
                lines.extend(uf.marked_ads());
                let _ = std::fs::create_dir_all(dir);
                let _ = std::fs::write(dir.join("user-filters.txt"), lines.join("\n"));
            }
        }
    }
}

pub fn user_filter_rules() -> Vec<String> {
    USER_FILTERS
        .get_or_init(|| Mutex::new(FilterBlocker::default()))
        .lock()
        .unwrap()
        .marked_ads()
}

/// Combined cosmetic rules (default + user), as JSON for runtime injection.
pub fn all_cosmetic_rules_json() -> String {
    let base: Vec<serde_json::Value> =
        serde_json::from_str(&load_default_filters().cosmetic_rules_json()).unwrap_or_default();
    let user = USER_FILTERS
        .get_or_init(|| Mutex::new(FilterBlocker::default()))
        .lock()
        .unwrap();
    let user: Vec<serde_json::Value> = serde_json::from_str(&user.cosmetic_rules_json()).unwrap_or_default();
    let all: Vec<serde_json::Value> = base.into_iter().chain(user).collect();
    serde_json::to_string(&all).unwrap_or_else(|_| "[]".into())
}
