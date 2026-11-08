//! Tray icon content: the status line (counts only, never agent names), up to 8 project rows, the fixed actions.
//! `View` is everything the menu shows; the shell rebuilds the menu only when the view changes.

use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, Runtime};

use crate::protocol::{ProjectStatus, Status, MAX_PROJECTS};

const MAX_NAME_CHARS: usize = 28;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Running,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub phase: Phase,
    pub line: String,
    /// `attention > 0`: the icon gets its dot (static, never blinking).
    pub attention: bool,
    /// (project key, row label)
    pub projects: Vec<(String, String)>,
}

impl View {
    pub fn starting() -> Self {
        Self { phase: Phase::Starting, line: "Starting…".into(), attention: false, projects: Vec::new() }
    }

    pub fn stopped() -> Self {
        Self { phase: Phase::Stopped, line: "nika is not running".into(), attention: false, projects: Vec::new() }
    }

    pub fn from_status(s: &Status) -> Self {
        Self {
            phase: Phase::Running,
            line: status_line(s),
            attention: s.attention > 0,
            projects: s.projects.iter().take(MAX_PROJECTS).map(|p| (p.key.clone(), project_label(p))).collect(),
        }
    }
}

/// `N need you · N waiting · N working`, without the first part when nothing needs the user.
pub fn status_line(s: &Status) -> String {
    if s.attention > 0 {
        format!("{} need you · {} waiting · {} working", s.attention, s.idle, s.busy)
    } else {
        format!("{} waiting · {} working", s.idle, s.busy)
    }
}

/// At most 28 characters: longer names keep 27 and gain an ellipsis.
pub fn truncate_name(name: &str) -> String {
    if name.chars().count() <= MAX_NAME_CHARS {
        name.to_string()
    } else {
        name.chars().take(MAX_NAME_CHARS - 1).chain(std::iter::once('…')).collect()
    }
}

/// `<name> — N needs you, N waiting, N working`; zero parts are left out.
pub fn project_label(p: &ProjectStatus) -> String {
    let name = if p.name.is_empty() { "untitled" } else { p.name.as_str() };
    let name = truncate_name(name);
    let mut parts = Vec::new();
    if p.attention > 0 {
        parts.push(format!("{} needs you", p.attention));
    }
    if p.idle > 0 {
        parts.push(format!("{} waiting", p.idle));
    }
    if p.busy > 0 {
        parts.push(format!("{} working", p.busy));
    }
    if parts.is_empty() {
        name
    } else {
        format!("{name} — {}", parts.join(", "))
    }
}

/// Monochrome logo. macOS treats it as a template image (the OS recolours it); Linux panels get the light variant.
pub fn icon(attention: bool) -> Image<'static> {
    let bytes: &[u8] = match (cfg!(target_os = "linux"), attention) {
        (false, false) => include_bytes!("../icons/tray-64.png"),
        (false, true) => include_bytes!("../icons/tray-attn-64.png"),
        (true, false) => include_bytes!("../icons/tray-light-64.png"),
        (true, true) => include_bytes!("../icons/tray-light-attn-64.png"),
    };
    Image::from_bytes(bytes).expect("embedded tray icon is a valid png")
}

/// Menu ids: `open`, `add`, `autostart`, `quit`, `project:<key>`; `status` is the disabled first line.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>, v: &View, autostart: bool) -> tauri::Result<Menu<R>> {
    let status = MenuItemBuilder::with_id("status", &v.line).enabled(false).build(app)?;
    let open = MenuItemBuilder::with_id("open", "Open nika").build(app)?;
    let add = MenuItemBuilder::with_id("add", "Add project…").enabled(v.phase == Phase::Running).build(app)?;
    let login = CheckMenuItemBuilder::with_id("autostart", "Start at login").checked(autostart).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit nika").build(app)?;
    let mut menu = MenuBuilder::new(app).item(&status).item(&open).separator();
    if !v.projects.is_empty() {
        for (key, label) in &v.projects {
            menu = menu.item(&MenuItemBuilder::with_id(format!("project:{key}"), label).build(app)?);
        }
        menu = menu.separator();
    }
    menu.item(&add).item(&login).separator().item(&quit).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(attention: u32, idle: u32, busy: u32) -> Status {
        Status { attention, idle, busy, ..Status::default() }
    }

    fn proj(name: &str, attention: u32, idle: u32, busy: u32) -> ProjectStatus {
        ProjectStatus { key: "0123456789abcdef".into(), name: name.into(), busy, idle, attention }
    }

    #[test]
    fn status_line_counts_only() {
        // (+)
        assert_eq!(status_line(&st(2, 1, 3)), "2 need you · 1 waiting · 3 working");
        assert_eq!(status_line(&st(1, 0, 0)), "1 need you · 0 waiting · 0 working");
        // (-) nothing needs the user: that part is dropped
        assert_eq!(status_line(&st(0, 1, 3)), "1 waiting · 3 working");
        assert_eq!(status_line(&st(0, 0, 0)), "0 waiting · 0 working");
        // the line never contains a project name, even when the status has projects
        let mut s = st(1, 1, 1);
        s.projects.push(proj("secret-project-name", 1, 1, 1));
        assert!(!status_line(&s).contains("secret"));
    }

    #[test]
    fn name_truncation() {
        // (+) up to 28 characters unchanged
        assert_eq!(truncate_name("short"), "short");
        let n28 = "a".repeat(28);
        assert_eq!(truncate_name(&n28), n28);
        // (-) 29 and more: 27 characters plus an ellipsis
        let t = truncate_name(&"b".repeat(29));
        assert_eq!(t.chars().count(), 28);
        assert_eq!(t, format!("{}…", "b".repeat(27)));
        assert_eq!(truncate_name(&"c".repeat(500)).chars().count(), 28);
        // counted in characters, not bytes
        let wide = "é".repeat(30);
        assert_eq!(truncate_name(&wide), format!("{}…", "é".repeat(27)));
        assert_eq!(truncate_name(&"é".repeat(28)), "é".repeat(28));
        assert_eq!(truncate_name(""), "");
    }

    #[test]
    fn project_labels() {
        // (+)
        assert_eq!(project_label(&proj("api", 1, 2, 3)), "api — 1 needs you, 2 waiting, 3 working");
        // (-) zero parts omitted
        assert_eq!(project_label(&proj("api", 0, 2, 3)), "api — 2 waiting, 3 working");
        assert_eq!(project_label(&proj("api", 1, 0, 0)), "api — 1 needs you");
        assert_eq!(project_label(&proj("api", 0, 0, 3)), "api — 3 working");
        assert_eq!(project_label(&proj("api", 0, 0, 0)), "api");
        assert_eq!(project_label(&proj("", 0, 1, 0)), "untitled — 1 waiting");
        // the name is truncated before the counts are added
        assert_eq!(project_label(&proj(&"n".repeat(40), 0, 1, 0)), format!("{}… — 1 waiting", "n".repeat(27)));
    }

    #[test]
    fn view_changes_only_when_the_menu_content_changes() {
        // (+) identical content, even with different hidden counts (other, ended): equal views, no rebuild
        let mut a = st(1, 1, 1);
        a.projects.push(proj("p", 1, 1, 1));
        let mut b = a.clone();
        b.other = 7;
        b.ended = 9;
        assert_eq!(View::from_status(&a), View::from_status(&b));
        // (-) any visible change differs: a count, a name, the icon dot
        let mut c = a.clone();
        c.busy = 2;
        assert_ne!(View::from_status(&a), View::from_status(&c));
        let mut d = a.clone();
        d.projects[0].name = "q".into();
        assert_ne!(View::from_status(&a), View::from_status(&d));
        let mut e = st(0, 1, 1);
        e.projects = a.projects.clone();
        assert!(View::from_status(&a).attention);
        assert!(!View::from_status(&e).attention);
        assert_ne!(View::from_status(&a), View::from_status(&e));
    }

    #[test]
    fn view_keeps_at_most_eight_projects_and_starts_as_starting() {
        // (+)
        let v = View::starting();
        assert_eq!((v.phase, v.line.as_str(), v.attention, v.projects.len()), (Phase::Starting, "Starting…", false, 0));
        assert_eq!(View::stopped().phase, Phase::Stopped);
        // (-)
        let mut s = st(0, 0, 0);
        s.projects = (0..12).map(|i| proj(&format!("p{i}"), 0, 0, 1)).collect();
        assert_eq!(View::from_status(&s).projects.len(), MAX_PROJECTS);
    }

    #[test]
    fn embedded_icons_decode_and_differ() {
        // (+) all four are 64 x 64 RGBA; (-) the attention variant is not the plain one
        for attn in [false, true] {
            let i = icon(attn);
            assert_eq!((i.width(), i.height()), (64, 64));
            assert_eq!(i.rgba().len(), 64 * 64 * 4);
        }
        assert_ne!(icon(false).rgba(), icon(true).rgba());
    }
}
