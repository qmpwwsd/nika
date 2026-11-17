//! nika desktop shell (ADR 0001-0003): a tray icon, one window and a supervisor for the private server
//! `node bin/nika serve --app`. The page talks to that server over HTTP with a per-launch secret; the shell talks to
//! it over JSON lines on stdio. No Tauri command, event or capability is exposed to the server's origin.
//!
//! Modules: `secret` (random secret, base64url), `protocol` (JSON lines), `child` (spawn, env, stop ladder,
//! supervisor), `nav` (navigation rules, init script, error-page URLs), `tray` (menu content, icons).

mod child;
#[cfg(target_os = "macos")]
mod mac;
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
use protocol::WindowAction;
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
    /// The open `pick-folder` or `pick-files` request: one dialog at a time, of either kind.
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

const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;
const ZOOM_STEP: f64 = 0.1;

/// The webview zoom after `action`: a tenth up or down, 1.0 on reset, always within `ZOOM_MIN..=ZOOM_MAX`. Any other
/// action leaves the level alone.
fn next_zoom(z: f64, action: WindowAction) -> f64 {
    let raw = match action {
        WindowAction::ZoomIn => z + ZOOM_STEP,
        WindowAction::ZoomOut => z - ZOOM_STEP,
        WindowAction::ZoomReset => 1.0,
        _ => return z,
    };
    ((raw * 10.0).round() / 10.0).clamp(ZOOM_MIN, ZOOM_MAX) // rounding drops float noise: 1.1 + 0.1 is not 1.2
}

/// One zoom level for the macOS View menu and the page's `window` action alike (`Inner::zoom`).
fn zoom(app: &AppHandle, action: WindowAction) {
    let (window, z) = {
        let mut i = shell(app).lock();
        i.zoom = next_zoom(i.zoom, action);
        (i.window.clone(), i.zoom)
    };
    if let Some(w) = window {
        let _ = w.set_zoom(z);
    }
}

/// What the close button does, and the `close` window action: hide the window; a full-screen one (macOS) leaves full
/// screen first.
fn close_window(app: &AppHandle, w: &WebviewWindow) {
    if shell(app).lock().hide_after_fullscreen.is_some() {
        return; // already leaving full screen: the timer below hides it
    }
    let fs = cfg!(target_os = "macos") && w.is_fullscreen().unwrap_or(false);
    match close_step(fs) {
        CloseStep::LeaveFullscreen => {
            let token = {
                let mut i = shell(app).lock();
                i.fs_closes += 1;
                i.hide_after_fullscreen = Some(i.fs_closes);
                i.fs_closes
            };
            let _ = w.set_fullscreen(false);
            let (app, win) = (app.clone(), w.clone());
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
        CloseStep::Hide => hide_window(app, w),
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
        // Tauri's own drag-and-drop handler is off, so a file dropped on the message box reaches the page as an HTML5 drop. nika registers
        // no Tauri drag-drop listener; the page cancels a drop anywhere else, and a file: navigation is denied below.
        .disable_drag_drop_handler()
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
    let closing = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            close_window(&app_h, &closing);
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
        Sup::PickFiles(req_id) => start_pick_files(app, req_id),
        Sup::Window(action) => dispatch(app, action),
        Sup::Failed => show_error(app, Reason::StartFailed),
        Sup::Exited => show_error(app, Reason::Stopped),
    }
}

/// Takes the one dialog slot for `req_id`. `None`: no server to answer. `Some((server, true))`: a dialog is open already, so the
/// caller answers "cancelled" at once; `Some((server, false))`: the slot is this request's, and the caller must free it when done.
fn claim_pick(app: &AppHandle, req_id: &str) -> Option<(Arc<Server>, bool)> {
    let mut i = shell(app).lock();
    let server = i.server.clone()?; // no server, no claim: nothing would ever free the slot
    let busy = i.pick.is_some();
    if !busy {
        i.pick = Some(req_id.to_string());
    }
    Some((server, busy))
}

/// The server's `PICK_PATH_MAX` (src/appio.js): it refuses a longer picked path, so the shell does not send one. The server counts UTF-16
/// units (a JavaScript string's `length`), so this does as well.
const PICK_PATH_MAX: usize = 4096;

/// Held by a dialog thread for the one dialog slot. `answer` sends the real answer; if the thread ends without having sent one (a panic in the
/// dialog or in what follows it, even a thread that never started), `Drop` sends the null answer instead. Either way the slot is freed at the
/// end, so a request can never stay open for ever and block every later dialog (Add project and the paperclip share the slot).
struct PickGuard<S: FnMut(&str), R: FnMut()> {
    send: S,
    release: R,
    null_line: String,
    answered: bool,
}

impl<S: FnMut(&str), R: FnMut()> PickGuard<S, R> {
    fn new(send: S, release: R, null_line: String) -> Self {
        Self { send, release, null_line, answered: false }
    }

    /// The first answer goes out; later ones are ignored.
    fn answer(&mut self, line: &str) {
        if !self.answered {
            self.answered = true;
            (self.send)(line);
        }
    }
}

impl<S: FnMut(&str), R: FnMut()> Drop for PickGuard<S, R> {
    fn drop(&mut self) {
        if !self.answered {
            let line = std::mem::take(&mut self.null_line);
            (self.send)(&line);
        }
        (self.release)();
    }
}

/// The guard of the real slot: answers go to the server's stdin, and releasing clears `Inner::pick`. Call it right after `claim_pick` said the
/// slot is this request's, and move it into the dialog thread.
fn pick_guard(app: &AppHandle, server: Arc<Server>, null_line: String) -> PickGuard<impl FnMut(&str), impl FnMut()> {
    let app = app.clone();
    PickGuard::new(
        move |line: &str| {
            let _ = server.send(line);
        },
        move || shell(&app).lock().pick = None,
        null_line,
    )
}

/// `pick-folder`: one dialog at a time (a second request, of either kind, is answered with "cancelled"); the dialog blocks, so it
/// runs on its own thread. Only an absolute path of an existing directory is sent back.
fn start_pick(app: &AppHandle, req_id: String) {
    let Some((server, busy)) = claim_pick(app, &req_id) else { return };
    if busy {
        let _ = server.send(&protocol::folder_line(&req_id, None));
        return;
    }
    let mut guard = pick_guard(app, server, protocol::folder_line(&req_id, None));
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
        guard.answer(&protocol::folder_line(&req_id, picked.as_deref()));
    });
}

/// `pick-files` (the attachment button): the same single slot as `pick-folder`, and the same thread, because the webview's own file input
/// freezes the app on macOS (wry runs a modal panel inside a WebKit callback). Only absolute paths of existing regular files are sent
/// back (valid UTF-8 only, each within `PICK_PATH_MAX`, at most `MAX_PICKED_FILES`, one line within `MAX_LINE`); none left is "cancelled".
/// The server opens and checks each file itself.
fn start_pick_files(app: &AppHandle, req_id: String) {
    let Some((server, busy)) = claim_pick(app, &req_id) else { return };
    if busy {
        let _ = server.send(&protocol::files_line(&req_id, None));
        return;
    }
    let mut guard = pick_guard(app, server, protocol::files_line(&req_id, None));
    let app = app.clone();
    thread::spawn(move || {
        let picked: Vec<String> = app
            .dialog()
            .file()
            .set_title("Attach files")
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .filter(|p| protocol::valid_file(p))
            .filter_map(|p| p.to_str().map(str::to_owned))
            .collect();
        guard.answer(&files_reply(&req_id, picked));
    });
}

/// The `files` line for the paths a dialog returned: a path longer than `PICK_PATH_MAX` is dropped, at most `MAX_PICKED_FILES` stay, and while
/// the line would pass `MAX_LINE` (serde escapes every control character to six bytes) the last path is dropped as well, so the server's
/// reader never discards the answer. Nothing left is the null answer.
fn files_reply(req_id: &str, paths: Vec<String>) -> String {
    let fits = paths.into_iter().filter(|p| p.encode_utf16().count() <= PICK_PATH_MAX).collect();
    let mut kept = protocol::cap_picked(fits).unwrap_or_default();
    loop {
        let line = protocol::files_line(req_id, (!kept.is_empty()).then_some(&kept[..]));
        if kept.is_empty() || line.trim_end_matches('\n').len() <= protocol::MAX_LINE {
            return line;
        }
        kept.pop();
    }
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

/* ---------- window actions from the page ---------- */

/// What the shell can do to its window and itself; `dispatch` picks one per action (a seam so the mapping is testable
/// without a window).
trait WindowOps {
    fn quit(&self);
    fn close(&self);
    fn minimize(&self);
    fn zoom(&self, action: WindowAction);
}

fn dispatch(ops: &impl WindowOps, action: WindowAction) {
    match action {
        WindowAction::Quit => ops.quit(),
        WindowAction::Close => ops.close(),
        WindowAction::Minimize => ops.minimize(),
        WindowAction::ZoomIn | WindowAction::ZoomOut | WindowAction::ZoomReset => ops.zoom(action),
    }
}

impl WindowOps for AppHandle {
    fn quit(&self) {
        quit(self);
    }
    fn close(&self) {
        let window = shell(self).lock().window.clone();
        if let Some(w) = window {
            close_window(self, &w);
        }
    }
    fn minimize(&self) {
        let window = shell(self).lock().window.clone();
        if let Some(w) = window {
            let _ = w.minimize();
        }
    }
    fn zoom(&self, action: WindowAction) {
        zoom(self, action);
    }
}

/* ---------- menus ---------- */

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_window(app),
        "add" => go(app, "#add-project"),
        "autostart" => toggle_autostart(app),
        "quit" => quit(app),
        "zoom-in" => zoom(app, WindowAction::ZoomIn),
        "zoom-out" => zoom(app, WindowAction::ZoomOut),
        "zoom-reset" => zoom(app, WindowAction::ZoomReset),
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
/// (muda's predefined item: `toggleFullScreen:`, Ctrl+Cmd+F; AppKit retitles it "Exit Full Screen"), Window (muda's
/// predefined Minimize, Cmd+M, and Close Window, Cmd+W: `performClose:` reaches the same `CloseRequested` hide as the
/// close button), and Cmd+Q through the same quit path. Zoom is clamped to `ZOOM_MIN..=ZOOM_MAX`, shared with the page's
/// `window` actions. Linux has no menu: the page catches its keys and asks over stdio.
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
    // macOS: before any window or webview exists, so a held key repeats
    #[cfg(target_os = "macos")]
    mac::disable_press_and_hold();
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
    use super::{applies, close_step, dispatch, files_reply, hide_due, next_zoom, CloseStep, PickGuard, WindowOps, PICK_PATH_MAX};
    use crate::protocol::WindowAction::{self, *};
    use crate::protocol::{MAX_LINE, MAX_PICKED_FILES};
    use std::cell::RefCell;
    use std::sync::{Arc, Mutex};
    use std::thread;

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

    #[test]
    fn zoom_steps_by_a_tenth_and_stays_between_half_and_triple() {
        // (+) one step either way, without float noise (1.1 + 0.1 is 1.2000000000000002 before rounding)
        assert_eq!(next_zoom(1.0, ZoomIn), 1.1);
        assert_eq!(next_zoom(1.1, ZoomIn), 1.2);
        assert_eq!(next_zoom(1.0, ZoomOut), 0.9);
        // (+) reset gives 1.0 from anywhere
        assert_eq!(next_zoom(0.5, ZoomReset), 1.0);
        assert_eq!(next_zoom(3.0, ZoomReset), 1.0);
        // (-) the ends hold (0.5 to 3.0, the range the macOS View menu used before the page could zoom)
        assert_eq!(next_zoom(3.0, ZoomIn), 3.0);
        assert_eq!(next_zoom(0.5, ZoomOut), 0.5);
        // (-) twenty steps up from 1.0 end at 3.0 exactly and a hundred more do not pass it; the same down to 0.5
        let up = (0..120).fold(1.0, |z, _| next_zoom(z, ZoomIn));
        assert_eq!(up, 3.0);
        let down = (0..110).fold(1.0, |z, _| next_zoom(z, ZoomOut));
        assert_eq!(down, 0.5);
        // (-) a level outside the range (an old state) is pulled back in by the next step
        assert_eq!(next_zoom(4.0, ZoomIn), 3.0);
        assert_eq!(next_zoom(0.1, ZoomOut), 0.5);
        // (-) the other actions never change the level
        for a in [Quit, Close, Minimize] {
            assert_eq!(next_zoom(1.3, a), 1.3);
        }
    }

    const REQ: &str = "11111111-1111-4111-8111-111111111111";
    const NULL_LINE: &str = "{\"type\":\"files\",\"reqId\":\"11111111-1111-4111-8111-111111111111\",\"paths\":null}\n";

    /// A guard whose answers and releases are recorded: (sent lines, release count).
    fn recorded(null_line: &str) -> (PickGuard<impl FnMut(&str), impl FnMut()>, Arc<Mutex<Vec<String>>>, Arc<Mutex<u32>>) {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let freed = Arc::new(Mutex::new(0u32));
        let (s, f) = (sent.clone(), freed.clone());
        let guard = PickGuard::new(move |l: &str| s.lock().unwrap().push(l.to_string()), move || *f.lock().unwrap() += 1, null_line.to_string());
        (guard, sent, freed)
    }

    #[test]
    fn a_dialog_thread_that_panics_still_answers_null_and_frees_the_slot() {
        // (-) the body panics before it answered: the guard sends the null answer on the way out, then frees the slot
        let (guard, sent, freed) = recorded(NULL_LINE);
        let h = thread::spawn(move || {
            let _guard = guard;
            panic!("the dialog died");
        });
        assert!(h.join().is_err(), "the thread did panic");
        assert_eq!(*sent.lock().unwrap(), vec![NULL_LINE.to_string()]);
        assert_eq!(*freed.lock().unwrap(), 1);
        // (-) the same for the folder answer: whatever null line the guard was made with is the one that goes
        let folder_null = "{\"type\":\"folder\",\"reqId\":\"11111111-1111-4111-8111-111111111111\",\"path\":null}\n";
        let (guard, sent, freed) = recorded(folder_null);
        assert!(thread::spawn(move || { let _guard = guard; panic!("x"); }).join().is_err());
        assert_eq!((sent.lock().unwrap().clone(), *freed.lock().unwrap()), (vec![folder_null.to_string()], 1));
    }

    #[test]
    fn a_dialog_that_answered_sends_that_answer_once_and_frees_the_slot_once() {
        // (+) the real answer goes out, the null one never does, the slot is freed after it
        let (mut guard, sent, freed) = recorded(NULL_LINE);
        guard.answer("real\n");
        assert_eq!(*freed.lock().unwrap(), 0, "freed only when the guard ends");
        drop(guard);
        assert_eq!(*sent.lock().unwrap(), vec!["real\n".to_string()]);
        assert_eq!(*freed.lock().unwrap(), 1);
        // (-) a second answer is ignored (one request, one answer)
        let (mut guard, sent, freed) = recorded(NULL_LINE);
        guard.answer("first\n");
        guard.answer("second\n");
        drop(guard);
        assert_eq!((sent.lock().unwrap().clone(), *freed.lock().unwrap()), (vec!["first\n".to_string()], 1));
        // (-) a guard dropped without any answer (a thread that never ran) sends null and frees the slot
        let (guard, sent, freed) = recorded(NULL_LINE);
        drop(guard);
        assert_eq!((sent.lock().unwrap().clone(), *freed.lock().unwrap()), (vec![NULL_LINE.to_string()], 1));
    }

    #[test]
    fn a_files_reply_drops_a_path_the_server_would_refuse() {
        let path_of = |units: usize| format!("/{}", "a".repeat(units - 1));
        let parse = |line: &str| serde_json::from_str::<serde_json::Value>(line).unwrap();
        // (+) a path of exactly PICK_PATH_MAX units is sent
        let v = parse(&files_reply(REQ, vec![path_of(PICK_PATH_MAX)]));
        assert_eq!(v["paths"], serde_json::json!([path_of(PICK_PATH_MAX)]));
        // (-) one unit more is dropped, and the paths around it stay in order
        let v = parse(&files_reply(REQ, vec!["/tmp/a".into(), path_of(PICK_PATH_MAX + 1), "/tmp/b".into()]));
        assert_eq!(v["paths"], serde_json::json!(["/tmp/a", "/tmp/b"]));
        // (-) the server counts UTF-16 units, not bytes or characters: "/" plus 2047 astral characters is 4095 units (sent), plus 2048 is 4097 (dropped)
        let astral = |n: usize| format!("/{}", "\u{1F4CE}".repeat(n));
        assert_eq!((astral(2047).encode_utf16().count(), astral(2048).encode_utf16().count()), (PICK_PATH_MAX - 1, PICK_PATH_MAX + 1));
        assert_eq!(parse(&files_reply(REQ, vec![astral(2047)]))["paths"].as_array().unwrap().len(), 1);
        assert!(parse(&files_reply(REQ, vec![astral(2048)]))["paths"].is_null());
        // (-) nothing is left: the null answer, as for a cancel
        assert_eq!(files_reply(REQ, vec![path_of(PICK_PATH_MAX + 1)]), NULL_LINE);
        assert_eq!(files_reply(REQ, Vec::new()), NULL_LINE);
    }

    #[test]
    fn a_files_reply_holds_at_most_six_paths() {
        // (+) seven in, the first six out
        let seven: Vec<String> = (0..7).map(|i| format!("/tmp/f{i}")).collect();
        let v: serde_json::Value = serde_json::from_str(&files_reply(REQ, seven.clone())).unwrap();
        assert_eq!(MAX_PICKED_FILES, 6);
        assert_eq!(v["paths"], serde_json::json!(seven[..6]));
        // (+) six stay six
        let v: serde_json::Value = serde_json::from_str(&files_reply(REQ, seven[..6].to_vec())).unwrap();
        assert_eq!(v["paths"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn a_files_reply_never_passes_the_line_limit() {
        // (-) six longest allowed paths made of control characters serialise to six bytes each: 6 x 4096 x 6 is far over 64 KB, so the tail is dropped
        let heavy = |i: usize| format!("/{}{i}", "\u{1}".repeat(PICK_PATH_MAX - 3));
        let paths: Vec<String> = (0..6).map(heavy).collect();
        assert!(paths.iter().all(|p| p.encode_utf16().count() <= PICK_PATH_MAX));
        let line = files_reply(REQ, paths.clone());
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1, "one line");
        assert!(line.trim_end().len() <= MAX_LINE, "{} bytes", line.len());
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let kept = v["paths"].as_array().unwrap();
        assert!(!kept.is_empty() && kept.len() < 6);
        assert_eq!(kept[0], paths[0].as_str(), "the first paths stay, in order");
        // (+) ordinary paths are untouched
        let v: serde_json::Value = serde_json::from_str(&files_reply(REQ, vec!["/tmp/a.png".into(), "/tmp/b.md".into()])).unwrap();
        assert_eq!(v["paths"], serde_json::json!(["/tmp/a.png", "/tmp/b.md"]));
    }

    #[derive(Default)]
    struct Recorder(RefCell<Vec<String>>);

    impl WindowOps for Recorder {
        fn quit(&self) {
            self.0.borrow_mut().push("quit".into());
        }
        fn close(&self) {
            self.0.borrow_mut().push("close".into());
        }
        fn minimize(&self) {
            self.0.borrow_mut().push("minimize".into());
        }
        fn zoom(&self, action: WindowAction) {
            self.0.borrow_mut().push(format!("zoom:{action:?}"));
        }
    }

    #[test]
    fn each_window_action_reaches_its_own_handler_and_only_that_one() {
        // (+) / (-) exactly one call per action, the right one
        for (action, want) in [
            (Quit, "quit"),
            (Close, "close"),
            (Minimize, "minimize"),
            (ZoomIn, "zoom:ZoomIn"),
            (ZoomOut, "zoom:ZoomOut"),
            (ZoomReset, "zoom:ZoomReset"),
        ] {
            let r = Recorder::default();
            dispatch(&r, action);
            assert_eq!(*r.0.borrow(), vec![want.to_string()], "{action:?}");
        }
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
