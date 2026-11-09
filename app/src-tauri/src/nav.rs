//! Where the webview may go, and how the page gets its secret.
//! Rules (rules/project-rules.md section 13): only the private server's own origin and the local error page load;
//! `https://claude.ai/code/session_<id>` opens in the system browser through fixed argv; everything else is blocked.
//! The matchers are hand-written on parsed URLs: no regex, no globbing, no prefix tests on raw strings.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use tauri::Url;

use crate::child::{NodeLookup, NodeVer};

/// Origin of the embedded frontend (`frontendDist`) on macOS and Linux.
pub const APP_ORIGIN: &str = "tauri://localhost";
pub const ERROR_PAGE: &str = "/error.html";
/// The error page's Retry link. The shell intercepts the navigation; the URL never loads.
pub const RETRY_PATH: &str = "/retry";
const MAX_SESSION_ID: usize = 64;

/// Why the error page is showing. `key()` is the whole vocabulary of the page's `?reason=` query (ui/error.js).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    NodeMissing,
    /// The newest Node.js found is older than 22. The version is shown when it has the form the page accepts.
    NodeOld(Option<NodeVer>),
    StartFailed,
    Stopped,
}

impl Reason {
    pub fn key(self) -> &'static str {
        match self {
            Self::NodeMissing => "node-missing",
            Self::NodeOld(_) => "node-old",
            Self::StartFailed => "start-failed",
            Self::Stopped => "stopped",
        }
    }

    /// The page's query: always `reason=<key>`; for `NodeOld` also `node=v<major>.<minor>.<patch>` (at most three
    /// digits each, which is what ui/error.js accepts), left out when the version does not fit that form.
    fn query(self) -> String {
        match self {
            Self::NodeOld(Some(v)) => match v.page_form() {
                Some(form) => format!("reason={}&node={form}", self.key()),
                None => format!("reason={}", self.key()),
            },
            _ => format!("reason={}", self.key()),
        }
    }

    /// Path and query for `WebviewUrl::App`.
    pub fn page(self) -> String {
        format!("error.html?{}", self.query())
    }

    /// Full URL for navigating an existing window to the error page.
    pub fn url(self) -> Url {
        Url::parse(&format!("{APP_ORIGIN}{ERROR_PAGE}?{}", self.query())).expect("constant URL parses")
    }
}

/// The node binary to run, or the reason the error page shows instead. `None` is a lookup that failed to deliver an
/// answer at all (its worker thread panicked): the generic start failure, so the error page and Retry still work.
pub fn node_or_reason(found: Option<NodeLookup>) -> Result<PathBuf, Reason> {
    match found {
        Some(NodeLookup::Found(p)) => Ok(p),
        Some(NodeLookup::TooOld(v)) => Err(Reason::NodeOld(Some(v))),
        Some(NodeLookup::Missing) => Err(Reason::NodeMissing),
        None => Err(Reason::StartFailed),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    /// Load it inside the webview.
    Allow,
    /// The error page's Retry link: restart the server, do not load.
    Retry,
    /// A claude.ai session link: open this exact URL in the system browser, do not load.
    Claude(String),
    Deny,
}

fn no_userinfo(url: &Url) -> bool {
    url.username().is_empty() && url.password().is_none()
}

/// `http://127.0.0.1:<port>/...`: right scheme, literal loopback host, the server's port, no userinfo.
pub fn is_server_url(url: &Url, port: u16) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port_or_known_default() == Some(port) && no_userinfo(url)
}

fn is_app_origin(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none() && no_userinfo(url)
}

/// Exactly `https://claude.ai/code/session_<1-64 ASCII letters or digits>`: no query, fragment, userinfo, port,
/// subdomain, trailing slash or extra path. Returns the normalised URL, which is what gets opened.
pub fn claude_session(url: &Url) -> Option<String> {
    if url.scheme() != "https" || url.host_str() != Some("claude.ai") || url.port().is_some() || !no_userinfo(url) {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let id = url.path().strip_prefix("/code/session_")?;
    let ok = !id.is_empty() && id.len() <= MAX_SESSION_ID && id.bytes().all(|c| c.is_ascii_alphanumeric());
    ok.then(|| url.as_str().to_string())
}

/// `port` is the running server's port, `None` while there is none (error window).
pub fn classify(url: &Url, port: Option<u16>) -> Nav {
    if port.is_some_and(|p| is_server_url(url, p)) {
        return Nav::Allow;
    }
    if is_app_origin(url) {
        return match url.path() {
            ERROR_PAGE => Nav::Allow,
            RETRY_PATH if url.query().is_none() && url.fragment().is_none() => Nav::Retry,
            _ => Nav::Deny,
        };
    }
    claude_session(url).map_or(Nav::Deny, Nav::Claude)
}

/// Fixed argv for opening a URL in the system browser: `/usr/bin/open <url>` on macOS, the first existing
/// `xdg-open` from a fixed list elsewhere. Never a shell.
pub fn open_argv(url: &str, macos: bool, exists: impl Fn(&str) -> bool) -> Option<[String; 2]> {
    let program = if macos {
        Some("/usr/bin/open")
    } else {
        ["/usr/bin/xdg-open", "/usr/local/bin/xdg-open"].into_iter().find(|p| exists(p))
    }?;
    Some([program.to_string(), url.to_string()])
}

/// Opens an already validated claude.ai URL. Failures are ignored: the user clicks again or copies the link.
pub fn open_external(url: &str) {
    let Some([program, url]) = open_argv(url, cfg!(target_os = "macos"), |p| Path::new(p).is_file()) else {
        return;
    };
    if let Ok(mut child) = Command::new(program).arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        thread::spawn(move || {
            let _ = child.wait(); // reap it
        });
    }
}

/// Runs before any page script, in the top frame, on every navigation. It defines `window.__NIKA_APP__` only when
/// the page is the private server's own origin. `configurable: true` is required: public/api.js deletes the global
/// right after copying it. The secret goes in as a JSON string literal, never spliced in raw.
pub fn init_script(port: u16, secret: &str) -> String {
    let secret_js = serde_json::to_string(secret).expect("a string serialises");
    format!(
        "if (location.origin === \"http://127.0.0.1:{port}\") {{ \
Object.defineProperty(window, '__NIKA_APP__', {{ value: Object.freeze({{ secret: {secret_js}, port: {port} }}), \
enumerable: false, configurable: true, writable: false }}); }}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }
    const SID: &str = "AbCdEf0123456789";
    // assembled at runtime so the repo hygiene scan does not mistake userinfo test URLs for email addresses
    const AT: &str = "@";

    #[test]
    fn server_origin_allowed() {
        // (+)
        assert_eq!(classify(&u("http://127.0.0.1:4321/"), Some(4321)), Nav::Allow);
        assert_eq!(classify(&u("http://127.0.0.1:4321/#project/0123456789abcdef"), Some(4321)), Nav::Allow);
        assert_eq!(classify(&u("http://127.0.0.1:4321/api/agents?x=1#a"), Some(4321)), Nav::Allow);
        assert!(is_server_url(&u("http://127.1:4321/"), 4321)); // the URL parser normalises it to 127.0.0.1
    }

    #[test]
    fn other_origins_denied() {
        // (-) other port, localhost, https, userinfo, other host, no server running, odd schemes
        let tricky = format!("http://127.0.0.1:4321{AT}evil.example/"); // the host is evil.example
        for bad in [
            "http://127.0.0.1:4322/",
            "http://127.0.0.1/",
            "http://localhost:4321/",
            "https://127.0.0.1:4321/",
            "http://user@127.0.0.1:4321/",
            "http://user:pw@127.0.0.1:4321/",
            "http://127.0.0.1.evil.example:4321/",
            tricky.as_str(),
            "http://[::1]:4321/",
            "http://0.0.0.0:4321/",
            "ftp://127.0.0.1:4321/",
            "file:///etc/passwd",
            "about:blank",
            "javascript:alert(1)",
            "data:text/html,x",
            "https://example.com/",
        ] {
            assert_eq!(classify(&u(bad), Some(4321)), Nav::Deny, "{bad}");
        }
        // without a running server even the right-looking URL is denied
        assert_eq!(classify(&u("http://127.0.0.1:4321/"), None), Nav::Deny);
    }

    #[test]
    fn default_port_is_compared_as_the_default() {
        // (+) port 80 is the default for http: the parser drops it, the comparison still matches
        assert!(is_server_url(&u("http://127.0.0.1:80/"), 80));
        assert!(is_server_url(&u("http://127.0.0.1/"), 80));
        // (-)
        assert!(!is_server_url(&u("http://127.0.0.1/"), 4321));
    }

    #[test]
    fn error_page_and_retry() {
        // (+) the local error page (with the reason query) loads; the retry sentinel is intercepted
        assert_eq!(classify(&u("tauri://localhost/error.html?reason=stopped"), Some(4321)), Nav::Allow);
        assert_eq!(classify(&u("tauri://localhost/error.html"), None), Nav::Allow);
        assert_eq!(classify(&u("tauri://localhost/retry"), None), Nav::Retry);
        assert_eq!(classify(&u("tauri://localhost/retry"), Some(4321)), Nav::Retry);
        // (-) nothing else on that origin, other schemes and hosts for the same path, retry with extras
        for bad in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "tauri://localhost/error.html/",
            "tauri://localhost/../error.html/x",
            "tauri://localhost:8080/error.html",
            "tauri://evil/error.html",
            "tauri://user@localhost/error.html",
            "http://tauri.localhost/error.html",
            "https://localhost/error.html",
            "tauri://localhost/retry?x=1",
            "tauri://localhost/retry#x",
            "tauri://localhost/retry/",
        ] {
            assert_eq!(classify(&u(bad), None), Nav::Deny, "{bad}");
        }
    }

    #[test]
    fn claude_matcher_accepts_only_session_links() {
        // (+)
        let ok = format!("https://claude.ai/code/session_{SID}");
        assert_eq!(claude_session(&u(&ok)), Some(ok.clone()));
        assert_eq!(classify(&u(&ok), Some(4321)), Nav::Claude(ok.clone()));
        assert!(claude_session(&u(&format!("https://claude.ai/code/session_{}", "a".repeat(64)))).is_some());
        assert!(claude_session(&u("https://claude.ai/code/session_a")).is_some());
        assert!(claude_session(&u("https://CLAUDE.AI/code/session_a")).is_some()); // host is case-insensitive, normalised
        // (-)
        let long = format!("https://claude.ai/code/session_{}", "a".repeat(65));
        for bad in [
            format!("https://claude.ai/code/session_{SID}?x=1"),
            format!("https://claude.ai/code/session_{SID}?"),
            format!("https://claude.ai/code/session_{SID}#frag"),
            format!("https://claude.ai/code/session_{SID}#"),
            format!("http://claude.ai/code/session_{SID}"),
            format!("https://www.claude.ai/code/session_{SID}"),
            format!("https://sub.claude.ai/code/session_{SID}"),
            format!("https://claude.ai.evil.example/code/session_{SID}"),
            format!("https://evilclaude.ai/code/session_{SID}"),
            format!("https://user{AT}claude.ai/code/session_{SID}"),
            format!("https://user:pw{AT}claude.ai/code/session_{SID}"),
            format!("https://claude.ai:8443/code/session_{SID}"),
            format!("https://claude.ai/code/session_{SID}/"),
            format!("https://claude.ai/code/session_{SID}/x"),
            format!("https://claude.ai/code/session_{SID}%2f"),
            format!("https://claude.ai/code/session_{SID}%00"),
            "https://claude.ai/code/session_".to_string(),
            "https://claude.ai/code/session".to_string(),
            "https://claude.ai/code/".to_string(),
            "https://claude.ai/code/sessions_abc".to_string(),
            "https://claude.ai/Code/session_abc".to_string(),
            "https://claude.ai/code/session_ab-c".to_string(),
            "https://claude.ai/code/session_ab_c".to_string(),
            "https://claude.ai/code/session_ab.c".to_string(),
            "https://claude.ai/code/session_\u{e9}\u{e9}".to_string(),
            "https://claude.ai/code/session_a\u{200b}b".to_string(),
            "https://claude.ai./code/session_abc".to_string(),
            "https://claude.ai/code//session_abc".to_string(),
            "https://claude.ai/code/session_abc;x".to_string(),
            "https://claude.ai/".to_string(),
            "https://claude.com/code/session_abc".to_string(),
            long,
        ] {
            assert_eq!(claude_session(&u(&bad)), None, "{bad}");
            assert_eq!(classify(&u(&bad), Some(4321)), Nav::Deny, "{bad}");
        }
    }

    #[test]
    fn error_page_urls_are_allowed_and_carry_a_fixed_reason() {
        // (+) every reason maps to a page the navigation predicate lets through
        for r in [Reason::NodeMissing, Reason::NodeOld(None), Reason::StartFailed, Reason::Stopped] {
            assert_eq!(classify(&r.url(), None), Nav::Allow);
            assert_eq!(r.page(), format!("error.html?reason={}", r.key()));
            assert_eq!(r.url().query(), Some(format!("reason={}", r.key()).as_str()));
        }
        // (-) the keys are exactly the ones ui/error.js knows
        let js = include_str!("../ui/error.js");
        for r in [Reason::NodeMissing, Reason::NodeOld(None), Reason::StartFailed, Reason::Stopped] {
            assert!(js.contains(&format!("'{}'", r.key())) || js.contains(&format!("{}:", r.key())), "{}", r.key());
        }
    }

    #[test]
    fn node_old_carries_the_version_only_in_the_form_the_page_accepts() {
        let v = NodeVer { major: 20, minor: 11, patch: 1 };
        // (+) reason first, then the version, on both the first-window path and the navigate path
        assert_eq!(Reason::NodeOld(Some(v)).key(), "node-old");
        assert_eq!(Reason::NodeOld(Some(v)).page(), "error.html?reason=node-old&node=v20.11.1");
        assert_eq!(Reason::NodeOld(Some(v)).url().query(), Some("reason=node-old&node=v20.11.1"));
        assert_eq!(classify(&Reason::NodeOld(Some(v)).url(), None), Nav::Allow);
        // (-) no version, or one the page would reject (more than three digits): the reason alone
        assert_eq!(Reason::NodeOld(None).page(), "error.html?reason=node-old");
        assert_eq!(Reason::NodeOld(Some(NodeVer { major: 1000, minor: 0, patch: 0 })).page(), "error.html?reason=node-old");
        assert_eq!(Reason::NodeOld(Some(NodeVer { major: 20, minor: 0, patch: 1000 })).url().query(), Some("reason=node-old"));
    }

    #[test]
    fn a_node_lookup_becomes_a_path_or_the_matching_reason() {
        let v = NodeVer { major: 18, minor: 0, patch: 0 };
        // (+) found: the path
        assert_eq!(node_or_reason(Some(NodeLookup::Found("/usr/bin/node".into()))), Ok(PathBuf::from("/usr/bin/node")));
        // (-) too old is node-old with the version (not node-missing); nothing found is node-missing
        assert_eq!(node_or_reason(Some(NodeLookup::TooOld(v))), Err(Reason::NodeOld(Some(v))));
        assert_eq!(node_or_reason(Some(NodeLookup::Missing)), Err(Reason::NodeMissing));
        // (-) no answer at all (the lookup's worker thread panicked): start-failed, a reason like any other, so the
        // caller ends on the error page (which sets `failed`, the state Retry needs) instead of "starting" for good
        assert_eq!(node_or_reason(None), Err(Reason::StartFailed));
    }

    #[test]
    fn open_argv_is_fixed() {
        // (+) macOS: open, whatever exists
        let url = format!("https://claude.ai/code/session_{SID}");
        assert_eq!(open_argv(&url, true, |_| false), Some(["/usr/bin/open".into(), url.clone()]));
        // (+) Linux: first existing of the fixed list
        assert_eq!(open_argv(&url, false, |p| p == "/usr/local/bin/xdg-open"), Some(["/usr/local/bin/xdg-open".into(), url.clone()]));
        assert_eq!(open_argv(&url, false, |_| true), Some(["/usr/bin/xdg-open".into(), url.clone()]));
        // (-) Linux without xdg-open: nothing is run
        assert_eq!(open_argv(&url, false, |_| false), None);
    }

    #[test]
    fn init_script_guards_origin_and_stays_configurable() {
        // (+)
        let s = init_script(4321, "AbC-_123");
        assert!(s.contains(r#"location.origin === "http://127.0.0.1:4321""#));
        assert!(s.contains("Object.defineProperty(window, '__NIKA_APP__'"));
        assert!(s.contains("configurable: true"));
        assert!(s.contains("enumerable: false"));
        assert!(s.contains("writable: false"));
        assert!(s.contains("Object.freeze({ secret: \"AbC-_123\", port: 4321 })"));
        // (-) a hostile value cannot break out of the string literal
        let evil = "a\"b\\c\nd</script>\u{2028}";
        let s = init_script(1, evil);
        let literal = serde_json::to_string(evil).unwrap();
        assert!(s.contains(&format!("secret: {literal},")));
        assert!(!s.contains('\n'), "the script stays on one line");
        assert!(!s.contains(evil));
        // (-) the guard names the port it was built for, not a pattern
        assert!(!init_script(4321, "x").contains("127.0.0.1:4322"));
    }
}
