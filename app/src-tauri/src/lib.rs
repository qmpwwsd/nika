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

use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use tauri::menu::MenuEvent;
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;

use child::{Server, StopTimes, Sup};
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

fn show_window(app: &AppHandle) {
    let window = {
        let mut i = shell(app).lock();
        i.hidden_launch = false;
        i.window.clone()
    };
    if let Some(w) = window {
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

/// One window: the server's page (with the init script) or the local error page. Closing it only hides it.
fn make_window(app: &AppHandle, url: WebviewUrl, port: Option<u16>, init: Option<String>, visible: bool) -> tauri::Result<WebviewWindow> {
    let label = {
        let mut i = shell(app).lock();
        i.windows_made += 1;
        format!("main-{}", i.windows_made)
    };
    let for_nav = app.clone();
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
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide.hide();
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
            shell(app).lock().window = Some(w);
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
    let get = |k: &str| std::env::var_os(k);
    let Some(root) = child::server_root(|| app.path().resource_dir().ok()) else { return show_error(app, Reason::StartFailed) };
    let Some(node) = child::find_node_here(&get) else { return show_error(app, Reason::NodeMissing) };
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
        if i.gen != gen || i.failed || i.quitting {
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

fn stop_server(app: &AppHandle) {
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

/// macOS menu bar (shown while the window is active): Edit for the standard text shortcuts, View for zoom
/// (spec decision 7; done natively because the zoom hotkey polyfill needs a Tauri capability for the page's
/// origin, which rules/project-rules.md section 13 forbids), Window, and Cmd+Q through the same quit path.
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let quit = MenuItemBuilder::with_id("quit", "Quit nika").accelerator("CmdOrCtrl+Q").build(app)?;
    let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In").accelerator("CmdOrCtrl+=").build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out").accelerator("CmdOrCtrl+-").build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size").accelerator("CmdOrCtrl+0").build(app)?;
    let app_sub = SubmenuBuilder::new(app, "nika").hide().hide_others().show_all().separator().item(&quit).build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View").item(&zoom_in).item(&zoom_out).item(&zoom_reset).build()?;
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
            RunEvent::Exit => stop_server(app),
            _ => {}
        });
}
