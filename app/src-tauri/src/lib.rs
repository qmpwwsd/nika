//! nika desktop shell (ADR 0001-0003): a tray icon, one window and a supervisor for the private server
//! `node bin/nika serve --app`. The page talks to that server over HTTP with a per-launch secret; the shell talks to
//! it over JSON lines on stdio. No Tauri command, event or capability is exposed to the server's origin.
//!
//! Modules: `secret` (random secret, base64url), `protocol` (JSON lines), `child` (spawn, env, stop ladder,
//! supervisor), `nav` (navigation rules, init script, error-page URLs), `tray` (menu content, icons).

mod child;
mod nav;
mod protocol;
mod secret;
mod tray;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use tauri::menu::MenuEvent;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;

use child::{NodeLookup, Server, StopTimes, Sup};
use nav::{Nav, Reason};
use secret::Secret;
use tray::View;

struct Inner {
    /// Generation of the current server child; events and navigations from older ones are ignored.
    gen: u64,
    server: Option<Arc<Server>>,
    port: Option<u16>,
    /// The current generation already showed the error page.
    failed: bool,
    quitting: bool,
    /// Launched with `--hidden` (start at login): the first window is created hidden.
    hidden_launch: bool,
    window: Option<WebviewWindow>,
    windows_made: u64,
    tray: Option<TrayIcon>,
    view: View,
    /// The open `pick-folder` request, one at a time.
    pick: Option<String>,
    zoom: f64,
    /// macOS: the full-screen close whose timer will hide the window once it has left full screen
    /// (`FULLSCREEN_EXIT_WAIT`), by its number in `fs_closes`. Cleared by `hide_window`, `show_window` and a
    /// replaced window (`on_ready`), which cancels that timer.
    hide_after_fullscreen: Option<u64>,
    /// Full-screen closes so far; each timer carries its own number.
    fs_closes: u64,
}

struct Shell(Mutex<Inner>);

impl Shell {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn shell(app: &AppHandle) -> &Shell {
    app.state::<Shell>().inner()
}

/// Runs `f` on the main thread (windows, menus and the tray belong there).
fn on_main(app: &AppHandle, f: impl FnOnce(&AppHandle) + Send + 'static) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || f(&a));
}

/* ---------- tray ---------- */

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Replaces the view and rebuilds menu, tooltip and icon only when something changed (or `force`).
fn refresh_tray(app: &AppHandle, new_view: Option<View>, force: bool) {
    let (tray, view, icon_changed) = {
        let mut i = shell(app).lock();
        let view = new_view.unwrap_or_else(|| i.view.clone());
        if view == i.view && !force {
            return;
        }
        let icon_changed = view.attention != i.view.attention;
        i.view = view.clone();
        (i.tray.clone(), view, icon_changed)
    };
    let Some(tray) = tray else { return };
    match tray::build_menu(app, &view, autostart_enabled(app)) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => eprintln!("nika: tray menu: {e}"),
    }
    let _ = tray.set_tooltip(Some(&view.line));
    if icon_changed {
        let _ = tray.set_icon(Some(tray::icon(view.attention)));
        let _ = tray.set_icon_as_template(true);
    }
}

fn toggle_autostart(app: &AppHandle) {
    let launch = app.autolaunch();
    let result = if launch.is_enabled().unwrap_or(false) { launch.disable() } else { launch.enable() };
    if let Err(e) = result {
        eprintln!("nika: start at login: {e}");
    }
    refresh_tray(app, None, true); // the check mark follows what is really registered
}

/* ---------- windows ---------- */

/// macOS: the activation policy that goes with a shown or a hidden window.
#[cfg(target_os = "macos")]
fn policy(shown: bool) -> tauri::ActivationPolicy {
    if shown { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory }
}

/// macOS: in the Dock and Cmd+Tab while a window is shown, tray only while it is hidden (owner decision 2026-11-09).
fn set_shown(app: &AppHandle, shown: bool) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(policy(shown));
    #[cfg(not(target_os = "macos"))]
    let _ = (app, shown);
}

#[derive(Debug, PartialEq, Eq)]
enum CloseStep {
    Hide,
    LeaveFullscreen,
}

/// A full-screen window leaves full screen before it hides: hiding it in its own Space would leave an empty Space.
fn close_step(fullscreen: bool) -> CloseStep {
    if fullscreen { CloseStep::LeaveFullscreen } else { CloseStep::Hide }
}

/// macOS: how long a window gets to leave full screen (the AppKit animation) before it is hidden. A timer, not a
/// `Resized` event: tao clears its full-screen flag in `set_fullscreen(false)` itself, so a resize that comes while
/// the animation still runs would already read "not full screen".
const FULLSCREEN_EXIT_WAIT: Duration = Duration::from_millis(1200);

/// Whether the timer of full-screen close `token` still applies: that close is the pending one (not cancelled by a
/// tray Open or a Retry, not replaced by a newer close).
fn hide_due(pending: Option<u64>, token: u64) -> bool {
    pending == Some(token)
}

/// Hides the window; on macOS the Dock icon and Cmd+Tab entry go with it.
fn hide_window(app: &AppHandle, w: &WebviewWindow) {
    shell(app).lock().hide_after_fullscreen = None;
    let _ = w.hide();
    set_shown(app, false);
}

fn show_window(app: &AppHandle) {
    let window = {
        let mut i = shell(app).lock();
        i.hidden_launch = false;
        i.hide_after_fullscreen = None;
        i.window.clone()
    };
    if let Some(w) = window {
        set_shown(app, true);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Shows the window and, while the server runs, points it at `/<hash>` of the private server (`#project/<key>`,
/// `#add-project`). `hash` is built from constants and a validated key only.
fn go(app: &AppHandle, hash: &str) {
    show_window(app);
    let (window, port) = {
        let i = shell(app).lock();
        (i.window.clone(), i.port)
    };
    if let (Some(w), Some(port)) = (window, port) {
        if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/{hash}")) {
            let _ = w.navigate(url);
        }
    }
}

fn zoom(app: &AppHandle, step: impl FnOnce(f64) -> f64) {
    let (window, z) = {
        let mut i = shell(app).lock();
        i.zoom = ((step(i.zoom) * 10.0).round() / 10.0).clamp(0.5, 3.0);
        (i.window.clone(), i.zoom)
    };
    if let Some(w) = window {
        let _ = w.set_zoom(z);
    }
}

/// One window: the server's page (with the init script) or the local error page. Closing it only hides it (a
/// full-screen one leaves full screen first, macOS).
fn make_window(app: &AppHandle, url: WebviewUrl, port: Option<u16>, init: Option<String>, visible: bool) -> tauri::Result<WebviewWindow> {
    let label = {
        let mut i = shell(app).lock();
        i.windows_made += 1;
        format!("main-{}", i.windows_made)
    };
    let for_nav = app.clone();
    let app_h = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, label, url)
        .title("nika")
        .inner_size(1100.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .visible(visible)
        .on_navigation(move |url| match nav::classify(url, port) {
            Nav::Allow => true,
            Nav::Retry => {
                retry(&for_nav);
                false
            }
            Nav::Claude(link) => {
                nav::open_external(&link);
                false
            }
            Nav::Deny => false,
        })
        .on_new_window(|url, _features| {
            if let Nav::Claude(link) = nav::classify(&url, None) {
                nav::open_external(&link);
            }
            NewWindowResponse::Deny
        });
    if let Some(script) = init {
        builder = builder.initialization_script(script);
    }
    let window = builder.build()?;
    if visible {
        set_shown(app, true);
    }
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if shell(&app_h).lock().hide_after_fullscreen.is_some() {
                return; // already leaving full screen: the timer below hides it
            }
            let fs = cfg!(target_os = "macos") && hide.is_fullscreen().unwrap_or(false);
            match close_step(fs) {
                CloseStep::LeaveFullscreen => {
                    let token = {
                        let mut i = shell(&app_h).lock();
                        i.fs_closes += 1;
                        i.hide_after_fullscreen = Some(i.fs_closes);
                        i.fs_closes
                    };
                    let _ = hide.set_fullscreen(false);
                    let (app, win) = (app_h.clone(), hide.clone());
                    thread::spawn(move || {
                        thread::sleep(FULLSCREEN_EXIT_WAIT);
                        on_main(&app, move |a| {
                            // a tray Open, a Retry or a newer close meanwhile: this timer is stale
                            let due = hide_due(shell(a).lock().hide_after_fullscreen, token);
                            if due {
                                hide_window(a, &win);
                            }
                        });
                    });
                }
                CloseStep::Hide => hide_window(&app_h, &hide),
            }
        }
    });
    Ok(window)
}

fn on_ready(app: &AppHandle, port: u16, secret: &Secret) {
    let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) else { return show_error(app, Reason::StartFailed) };
    let (old, visible, z) = {
        let mut i = shell(app).lock();
        i.port = Some(port);
        let old = i.window.take();
        let visible = old.as_ref().map_or(!i.hidden_launch, |w| w.is_visible().unwrap_or(true));
        i.hidden_launch = false;
        (old, visible, i.zoom)
    };
    match make_window(app, WebviewUrl::External(url), Some(port), Some(nav::init_script(port, secret.expose())), visible) {
        Ok(w) => {
            let _ = w.set_zoom(z);
            {
                let mut i = shell(app).lock();
                i.window = Some(w);
                i.hide_after_fullscreen = None; // the window a pending full-screen close was for is replaced
            }
            if let Some(o) = old {
                let _ = o.destroy();
            }
        }
        Err(e) => {
            shell(app).lock().window = old;
            eprintln!("nika: window: {e}");
            show_error(app, Reason::StartFailed);
        }
    }
}

/// The local error page, in the existing window or a new one. The child is killed: a failed server must not linger.
fn show_error(app: &AppHandle, reason: Reason) {
    let (server, window, hidden) = {
        let mut i = shell(app).lock();
        if i.quitting {
            return;
        }
        i.failed = true;
        i.port = None;
        (i.server.take(), i.window.clone(), i.hidden_launch)
    };
    if let Some(s) = server {
        s.kill_now();
    }
    refresh_tray(app, Some(View::stopped()), false);
    match window {
        Some(w) => {
            let _ = w.navigate(reason.url());
        }
        None => match make_window(app, WebviewUrl::App(reason.page().into()), None, None, !hidden) {
            Ok(w) => shell(app).lock().window = Some(w),
            Err(e) => eprintln!("nika: error window: {e}"),
        },
    }
}

/* ---------- server child ---------- */

/// Starts a server child: a new generation, then the node lookup on a worker thread (it runs `node --version` and
/// may wait on a slow candidate, which must never block the main thread: window, tray and Quit), then
/// `continue_start` back on the main thread.
fn start_server(app: &AppHandle) {
    let gen = {
        let mut i = shell(app).lock();
        if i.quitting {
            return;
        }
        i.gen += 1;
        i.failed = false;
        i.port = None;
        i.server = None;
        i.gen
    };
    refresh_tray(app, Some(View::starting()), false);
    let Some(root) = child::server_root(|| app.path().resource_dir().ok()) else { return show_error(app, Reason::StartFailed) };
    let app = app.clone();
    child::in_background(
        || child::find_node_here(&|k: &str| std::env::var_os(k)),
        move |found| on_main(&app, move |a| continue_start(a, gen, root, found)),
    );
}

/// Whether a decision made for generation `gen` still applies: no newer start, no error page for it yet, not quitting.
fn applies(current_gen: u64, failed: bool, quitting: bool, gen: u64) -> bool {
    current_gen == gen && !failed && !quitting
}

/// The rest of `start_server`, on the main thread with the lookup's answer (`None`: the lookup's thread panicked,
/// which ends on the start-failed page like any other failure, so Retry works). Dropped when a newer start, a
/// failure or Quit came in while the lookup ran (the same check as `handle`).
fn continue_start(app: &AppHandle, gen: u64, root: PathBuf, found: Option<NodeLookup>) {
    {
        let i = shell(app).lock();
        if !applies(i.gen, i.failed, i.quitting, gen) {
            return;
        }
    }
    let get = |k: &str| std::env::var_os(k);
    let node = match nav::node_or_reason(found) {
        Ok(node) => node,
        Err(reason) => return show_error(app, reason),
    };
    let Some(env) = child::child_env(&get, &node) else { return show_error(app, Reason::StartFailed) };
    let Ok(secret) = Secret::generate() else { return show_error(app, Reason::StartFailed) };
    let secret = Arc::new(secret);
    match child::spawn(&node, &root, env, &secret) {
        Ok(launched) => {
            shell(app).lock().server = Some(launched.server);
            let app = app.clone();
            thread::spawn(move || {
                child::supervise(&launched.events, child::READY_TIMEOUT, |ev| {
                    let secret = secret.clone();
                    on_main(&app, move |a| handle(a, gen, ev, &secret));
                });
            });
        }
        Err(e) => {
            eprintln!("nika: could not start the server: {}", e.kind());
            show_error(app, Reason::StartFailed);
        }
    }
}

/// An event from the supervisor, on the main thread. Anything from an older child, or after a failure, is dropped.
fn handle(app: &AppHandle, gen: u64, ev: Sup, secret: &Secret) {
    {
        let i = shell(app).lock();
        if !applies(i.gen, i.failed, i.quitting, gen) {
            return;
        }
    }
    match ev {
        Sup::Ready(port) => on_ready(app, port, secret),
        Sup::Status(s) => refresh_tray(app, Some(View::from_status(&s)), false),
        Sup::Pick(req_id) => start_pick(app, req_id),
        Sup::Failed => show_error(app, Reason::StartFailed),
        Sup::Exited => show_error(app, Reason::Stopped),
    }
}

/// `pick-folder`: one at a time (a second request is answered with "cancelled"); the dialog blocks, so it runs on
/// its own thread. Only an absolute path of an existing directory is sent back.
fn start_pick(app: &AppHandle, req_id: String) {
    let (server, busy) = {
        let mut i = shell(app).lock();
        let busy = i.pick.is_some();
        if !busy {
            i.pick = Some(req_id.clone());
        }
        (i.server.clone(), busy)
    };
    let Some(server) = server else { return };
    if busy {
        let _ = server.send(&protocol::folder_line(&req_id, None));
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let picked = app
            .dialog()
            .file()
            .set_title("Choose a project folder")
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .filter(|p| protocol::valid_folder(p))
            .and_then(|p| p.to_str().map(str::to_owned));
        let _ = server.send(&protocol::folder_line(&req_id, picked.as_deref()));
        shell(&app).lock().pick = None;
    });
}

/// The error page's Retry: a new child with a new secret and port, then a new window. Once per failure.
fn retry(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        {
            let mut i = shell(&app).lock();
            if !i.failed || i.quitting {
                return;
            }
            i.failed = false;
        }
        on_main(&app, start_server);
    });
}

/// Quit and exit only. Ends a node version probe that is still running (and stops any further one) before the server.
fn stop_server(app: &AppHandle) {
    child::kill_active_probe();
    let server = shell(app).lock().server.take();
    if let Some(s) = server {
        s.stop(StopTimes::default());
    }
}

/// Quit: stdin closes, then SIGTERM, then kill (2 s each), then exit. Off the main thread so the UI stays alive.
fn quit(app: &AppHandle) {
    {
        let mut i = shell(app).lock();
        if i.quitting {
            return;
        }
        i.quitting = true;
    }
    let app = app.clone();
    thread::spawn(move || {
        stop_server(&app);
        app.exit(0);
    });
}

/* ---------- menus ---------- */

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_window(app),
        "add" => go(app, "#add-project"),
        "autostart" => toggle_autostart(app),
        "quit" => quit(app),
        "zoom-in" => zoom(app, |z| z + 0.1),
        "zoom-out" => zoom(app, |z| z - 0.1),
        "zoom-reset" => zoom(app, |_| 1.0),
        id => {
            if let Some(key) = id.strip_prefix("project:").filter(|k| protocol::valid_project_key(k)) {
                go(app, &format!("#project/{key}"));
            }
        }
    }
}

/// macOS menu bar (shown while nika is the active app: activation policy Regular, window shown): Edit for the
/// standard text shortcuts, View for zoom (spec decision 7; done natively because the zoom hotkey polyfill needs a
/// Tauri capability for the page's origin, which rules/project-rules.md section 13 forbids) and native full screen
/// (muda's predefined item: `toggleFullScreen:`, Ctrl+Cmd+F; AppKit retitles it "Exit Full Screen"), Window, and
/// Cmd+Q through the same quit path.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let quit = MenuItemBuilder::with_id("quit", "Quit nika").accelerator("CmdOrCtrl+Q").build(app)?;
    let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In").accelerator("CmdOrCtrl+=").build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out").accelerator("CmdOrCtrl+-").build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size").accelerator("CmdOrCtrl+0").build(app)?;
    let app_sub = SubmenuBuilder::new(app, "nika").hide().hide_others().show_all().separator().item(&quit).build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .fullscreen_with_text("Enter Full Screen")
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().close_window().build()?;
    MenuBuilder::new(app).items(&[&app_sub, &edit, &view, &window]).build()
}

/* ---------- entry ---------- */

pub fn run() {
    let hidden_launch = std::env::args().any(|a| a == "--hidden");
    let builder = tauri::Builder::default()
        // single-instance first: a second launch must exit before it creates anything
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| on_main(app, show_window)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .on_menu_event(on_menu_event)
        .manage(Shell(Mutex::new(Inner {
            gen: 0,
            server: None,
            port: None,
            failed: false,
            quitting: false,
            hidden_launch,
            window: None,
            windows_made: 0,
            tray: None,
            view: View::starting(),
            pick: None,
            zoom: 1.0,
            hide_after_fullscreen: None,
            fs_closes: 0,
        })))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            let view = View::starting();
            let menu = tray::build_menu(&handle, &view, autostart_enabled(&handle))?;
            let tray = TrayIconBuilder::with_id("nika")
                .icon(tray::icon(false))
                .icon_as_template(true)
                .tooltip(&view.line)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .build(app)?;
            shell(&handle).lock().tray = Some(tray);
            start_server(&handle);
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .build(tauri::generate_context!())
        .expect("error while building the nika app")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, code, .. } => {
                // closing the last window (code None) must not end the app: the tray keeps it alive
                if code.is_none() && !shell(app).lock().quitting {
                    api.prevent_exit();
                }
            }
            // Dock icon menu > Quit (and logout) is `terminate:`: tao turns it into `Exit` without an `ExitRequested`
            RunEvent::Exit => stop_server(app),
            // Dock icon click, Finder or Spotlight launch of the running app
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{applies, close_step, hide_due, CloseStep};

    #[test]
    fn a_decision_applies_only_to_the_current_healthy_generation() {
        // (+) the generation that asked, no error page yet, not quitting
        assert!(applies(3, false, false, 3));
        // (-) a newer start (Retry) happened while the lookup ran
        assert!(!applies(4, false, false, 3));
        // (-) this generation already showed the error page
        assert!(!applies(3, true, false, 3));
        // (-) Quit was pressed meanwhile
        assert!(!applies(3, false, true, 3));
        // (-) an event from a generation that does not exist yet is not trusted either
        assert!(!applies(3, false, false, 4));
    }

    #[test]
    fn a_full_screen_window_leaves_full_screen_before_it_hides() {
        // (+) a window in its own Space: leave full screen first
        assert_eq!(close_step(true), CloseStep::LeaveFullscreen);
        // (-) a windowed one (and every Linux window) hides at once, never waits for a full-screen exit
        assert_eq!(close_step(false), CloseStep::Hide);
        // (-) the full-screen answer is never a plain hide
        assert_ne!(close_step(true), CloseStep::Hide);
    }

    #[test]
    fn a_hide_timer_acts_only_for_the_close_that_is_still_pending() {
        // (+) its close is the pending one
        assert!(hide_due(Some(2), 2));
        // (-) a tray Open or a Retry cleared the pending close
        assert!(!hide_due(None, 2));
        // (-) a newer close replaced it (close, Open, full screen, close again): the older timer is stale
        assert!(!hide_due(Some(3), 2));
        // (-) a pending number from an older close does not match a newer timer either
        assert!(!hide_due(Some(1), 2));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_shown_window_is_in_the_dock_and_a_hidden_one_is_not() {
        use super::policy;
        use tauri::ActivationPolicy;
        // (+) shown: Dock icon and Cmd+Tab
        assert!(matches!(policy(true), ActivationPolicy::Regular));
        // (-) hidden: tray only
        assert!(matches!(policy(false), ActivationPolicy::Accessory));
    }
}
