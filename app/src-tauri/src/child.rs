//! The private server child: `node <root>/bin/nika serve --app`, supervised over stdin/stdout JSON lines.
//! Fixed argv, an environment built from scratch, the secret only on stdin (never argv, env, disk, logs).

use std::ffi::{OsStr, OsString};
use std::io::{self, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{self, Msg, Status};
use crate::secret::Secret;

/// `ready` must arrive within this long after the spawn.
pub const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// Variables copied from the app's own environment when set. Nothing else is inherited.
pub const PASS_THROUGH: [&str; 8] = [
    "CLAUDE_CONFIG_DIR",
    "NIKA_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "TMUX_TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
];

fn is_executable_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// Oldest Node.js major the server runs on (`engines` in package.json).
pub const MIN_NODE_MAJOR: u32 = 22;
/// A candidate's `--version` must answer within this long, or the candidate is skipped.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
/// Total time for all candidates' `--version` runs, spawn, read and kill included. Once it is used up no further
/// candidate is run.
pub const PROBE_BUDGET: Duration = Duration::from_secs(6);
/// After a probe exits, how long its output may still take to arrive (never beyond the probe's own limit).
const READ_GRACE: Duration = Duration::from_millis(500);
/// Bytes of `--version` output kept; a real answer is under 20.
const VERSION_MAX_OUT: u64 = 64;
/// Entries read from one version-manager folder.
const MAX_LISTED: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct NodeVer {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl NodeVer {
    /// `v<major>.<minor>.<patch>` when each number has at most three digits (the form ui/error.js accepts).
    pub fn page_form(self) -> Option<String> {
        (self.major <= 999 && self.minor <= 999 && self.patch <= 999).then(|| format!("v{}.{}.{}", self.major, self.minor, self.patch))
    }
}

/// What the search for a Node.js binary found.
#[derive(Debug, PartialEq, Eq)]
pub enum NodeLookup {
    /// The first candidate that is 22 or newer.
    Found(PathBuf),
    /// At least one candidate ran, none is new enough; the newest version seen.
    TooOld(NodeVer),
    /// No candidate exists, or none of them answered `--version`.
    Missing,
}

/// Leading ASCII digits as a number, and the rest. `None` for no digits or a number that overflows.
fn take_number(s: &str) -> Option<(u32, &str)> {
    let end = s.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(s.len());
    let n = s.get(..end)?.parse().ok()?;
    Some((n, &s[end..]))
}

/// `<major>.<minor>.<patch>` at the start of `s`, and the rest.
fn take_triple(s: &str) -> Option<(NodeVer, &str)> {
    let (major, s) = take_number(s)?;
    let (minor, s) = take_number(s.strip_prefix('.')?)?;
    let (patch, s) = take_number(s.strip_prefix('.')?)?;
    Some((NodeVer { major, minor, patch }, s))
}

/// `node --version` output: `^v(\d+)\.(\d+)\.(\d+)`, anything may follow.
pub fn parse_node_version(out: &str) -> Option<NodeVer> {
    take_triple(out.strip_prefix('v')?).map(|(v, _)| v)
}

/// A version-manager folder name: exactly `<prefix><major>.<minor>.<patch>`, nothing before or after.
fn parse_install_name(name: &str, prefix: &str) -> Option<NodeVer> {
    take_triple(name.strip_prefix(prefix)?).and_then(|(v, rest)| rest.is_empty().then_some(v))
}

/// The system the candidate list is built for: some folders exist on one system only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Linux,
    Other,
}

impl Os {
    pub fn here() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

/// Version-manager layouts under `$HOME`: (folder holding one folder per version, prefix of those names, path of node
/// inside a version folder, macOS only). Directory listing only: no manager config, shim or dotfile is read.
const MANAGERS: [(&str, &str, &str, bool); 5] = [
    (".local/share/mise/installs/node", "", "bin/node", false),
    (".local/share/fnm/node-versions", "v", "installation/bin/node", false),
    ("Library/Application Support/fnm/node-versions", "v", "installation/bin/node", true),
    (".nvm/versions/node", "v", "bin/node", false),
    (".asdf/installs/nodejs", "", "bin/node", false),
];

/// The newest install in one manager folder that has an executable node. Names that do not parse are ignored.
fn newest_install(root: &Path, prefix: &str, tail: &str, list_dir: &impl Fn(&Path) -> Vec<String>, is_exec: &impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut installs: Vec<(NodeVer, String)> = list_dir(root).into_iter().filter_map(|n| parse_install_name(&n, prefix).map(|v| (v, n))).collect();
    installs.sort_by_key(|i| std::cmp::Reverse(i.0));
    installs.into_iter().map(|(_, n)| root.join(n).join(tail)).find(|p| is_exec(p))
}

/// The executable node binaries to try, in order. A valid `NIKA_NODE` (absolute, executable) is the only one. Else:
/// `/opt/homebrew/bin`, `/opt/homebrew/opt/node/bin`, `/usr/local/bin`, on Linux the Linuxbrew prefix, `~/.local/bin`,
/// `~/.volta/bin`, the newest install of mise, fnm (also under `~/Library/Application Support` on macOS), nvm and asdf,
/// `/usr/bin`. The `~` ones are left out when `home` is not absolute.
pub fn node_candidates(nika_node: Option<&OsStr>, home: &Path, os: Os, is_exec: impl Fn(&Path) -> bool, list_dir: impl Fn(&Path) -> Vec<String>) -> Vec<PathBuf> {
    if let Some(n) = nika_node {
        let p = Path::new(n);
        if p.is_absolute() && is_exec(p) {
            return vec![p.to_path_buf()];
        }
    }
    let mut fixed = vec!["/opt/homebrew/bin/node", "/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node"];
    if os == Os::Linux {
        fixed.push("/home/linuxbrew/.linuxbrew/bin/node");
    }
    let mut out: Vec<PathBuf> = fixed.into_iter().map(PathBuf::from).filter(|p| is_exec(p)).collect();
    if home.is_absolute() {
        out.extend([home.join(".local/bin/node"), home.join(".volta/bin/node")].into_iter().filter(|p| is_exec(p)));
        out.extend(MANAGERS.iter().filter(|m| !m.3 || os == Os::Mac).filter_map(|(dir, prefix, tail, _)| newest_install(&home.join(dir), prefix, tail, &list_dir, &is_exec)));
    }
    out.extend([PathBuf::from("/usr/bin/node")].into_iter().filter(|p| is_exec(p)));
    out
}

/// The first candidate whose `--version` says 22 or newer. `version_of(path, timeout)` returns the command's stdout,
/// or `None` when it failed or timed out; a candidate that did not answer, or answered something else, is skipped.
/// Each run gets at most `VERSION_TIMEOUT`, and all runs together at most `PROBE_BUDGET` (measured with `now`): when
/// it is used up the search ends with what is known (a node that qualified has already won; else the newest old
/// version read; else nothing).
pub fn find_node(
    nika_node: Option<&OsStr>,
    home: &Path,
    os: Os,
    is_exec: impl Fn(&Path) -> bool,
    list_dir: impl Fn(&Path) -> Vec<String>,
    now: impl Fn() -> Instant,
    version_of: impl Fn(&Path, Duration) -> Option<String>,
) -> NodeLookup {
    let start = now();
    let mut newest: Option<NodeVer> = None;
    for p in node_candidates(nika_node, home, os, is_exec, list_dir) {
        let spent = now().saturating_duration_since(start);
        if spent >= PROBE_BUDGET {
            break;
        }
        let Some(v) = version_of(&p, VERSION_TIMEOUT.min(PROBE_BUDGET - spent)).as_deref().and_then(parse_node_version) else { continue };
        if v.major >= MIN_NODE_MAJOR {
            return NodeLookup::Found(p);
        }
        newest = newest.max(Some(v));
    }
    newest.map_or(NodeLookup::Missing, NodeLookup::TooOld)
}

/// `<node> --version`: fixed argv, no shell, working directory `/`, an environment of `HOME` alone (a shim such as
/// Volta's needs it to find its tools; nothing else is passed), and a process group of its own so a timeout can end
/// whatever it forked.
fn version_command(node: &Path, home: &Path) -> Command {
    let mut cmd = Command::new(node);
    cmd.arg("--version").env_clear().env("HOME", home).current_dir("/").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    cmd
}

/// SIGKILL to the whole process group of `pid`, which must still be an unreaped group leader: through the fixed-argv
/// `/bin/kill` that `Server::stop` also uses, a forked grandchild holding the stdout pipe goes too.
fn kill_group(pid: u32) {
    let _ = Command::new("/bin/kill").args(["-KILL", "--"]).arg(format!("-{pid}")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// The version probes that are running, so Quit can end them: a probe leads a process group of its own and is not the
/// server child, so without this it would outlive the app (a hung one for good). Every pid in `pids` is a leader
/// that has not been reaped, which is what makes signalling its group safe: a pid is taken out of the list under the
/// lock before it is reaped, and `stop` signals only while holding that lock, so it can never hit a reused pid.
/// `stopped` is set for good by `stop`: no probe starts after it (the lookup would otherwise go on to the next
/// candidate and leave a new one behind).
struct Probes {
    state: Mutex<ProbeState>,
}

struct ProbeState {
    stopped: bool,
    pids: Vec<u32>,
}

/// The probes of this process.
static PROBES: Probes = Probes::new();

impl Probes {
    const fn new() -> Self {
        Probes { state: Mutex::new(ProbeState { stopped: false, pids: Vec::new() }) }
    }

    fn lock(&self) -> MutexGuard<'_, ProbeState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Spawns `cmd` unless stopped; the pid is listed in the same locked step, so `stop` either sees it or came first.
    fn spawn(&self, cmd: &mut Command) -> Option<Child> {
        let mut st = self.lock();
        if st.stopped {
            return None;
        }
        let child = cmd.spawn().ok()?;
        st.pids.push(child.id());
        Some(child)
    }

    /// `try_wait`; a child that was reaped by it leaves the list in the same locked step.
    fn poll(&self, child: &mut Child) -> io::Result<Option<ExitStatus>> {
        let mut st = self.lock();
        let r = child.try_wait();
        if !matches!(r, Ok(None)) {
            st.pids.retain(|p| *p != child.id());
        }
        r
    }

    /// Ends a probe that has not been reaped yet: off the list first, then SIGKILL to its whole group, then to the
    /// child itself, then reap it. The pid cannot be reused before the `wait`.
    fn end(&self, child: &mut Child) {
        self.lock().pids.retain(|p| *p != child.id());
        kill_group(child.id());
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Quit: SIGKILL to the group of every probe still running, and no new probe. The worker reaps them (its next
    /// `poll` sees the exit), or the app exit does.
    fn stop(&self) {
        let mut st = self.lock();
        st.stopped = true;
        for pid in &st.pids {
            kill_group(*pid);
        }
    }
}

/// Quit: ends the version probe that is running, with everything it started, and stops any further probe.
/// Never undone; call it only when the app is going away.
pub fn kill_active_probe() {
    PROBES.stop();
}

fn read_grace(left: Duration) -> Duration {
    READ_GRACE.min(left)
}

/// Runs `version_command`: its stdout (at most `VERSION_MAX_OUT` bytes) when it exits 0. Spawn, run and the wait for
/// the output all happen inside `timeout`, counted from the call; the kill after a timeout comes on top (a few
/// milliseconds). `None` for anything else, and at once after `kill_active_probe`.
pub fn run_node_version(node: &Path, home: &Path, timeout: Duration) -> Option<String> {
    run_node_version_in(&PROBES, node, home, timeout)
}

fn run_node_version_in(probes: &Probes, node: &Path, home: &Path, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    let mut cmd = version_command(node, home);
    let mut child = probes.spawn(&mut cmd)?;
    let Some(mut out) = child.stdout.take() else {
        probes.end(&mut child);
        return None;
    };
    let (tx, rx) = mpsc::channel();
    let reader = thread::Builder::new().spawn(move || {
        let mut kept = Vec::new();
        let _ = out.by_ref().take(VERSION_MAX_OUT).read_to_end(&mut kept);
        let _ = tx.send(kept);
        let _ = io::copy(&mut out, &mut io::sink()); // keep draining: a chatty node must not die of SIGPIPE
    });
    if reader.is_err() {
        // the OS refused a thread: no panic, and the probe is ended and reaped like any other that cannot be used
        probes.end(&mut child);
        return None;
    }
    let status = loop {
        match probes.poll(&mut child) {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                probes.end(&mut child);
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    String::from_utf8(rx.recv_timeout(read_grace(deadline.saturating_duration_since(Instant::now()))).ok()?).ok()
}

/// Runs `work` on a new thread and hands its result to `done` on that thread; returns at once. `done` always runs:
/// with `None` when `work` panicked, so the caller can end on its error page instead of waiting for good.
pub fn in_background<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static, done: impl FnOnce(Option<T>) + Send + 'static) {
    thread::spawn(move || done(std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).ok()));
}

fn list_dir_names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).into_iter().flatten().take(MAX_LISTED).filter_map(|e| e.ok()?.file_name().into_string().ok()).collect()
}

pub fn find_node_here(get: &impl Fn(&str) -> Option<OsString>) -> NodeLookup {
    let Some(home) = get("HOME") else { return NodeLookup::Missing };
    let home = Path::new(&home);
    find_node(get("NIKA_NODE").as_deref(), home, Os::here(), is_executable_file, list_dir_names, Instant::now, |p, timeout| run_node_version(p, home, timeout))
}

/// Where the server files live. Release: the bundle's resource dir (`<resources>/nika`), never an env var.
/// Debug: the repository root next to this crate. `None` when `bin/nika` is not there.
pub fn server_root(resource_dir: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    let root = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
    } else {
        resource_dir()?.join("nika")
    };
    root.join("bin").join("nika").is_file().then_some(root)
}

/// The child's whole environment: `PATH` (node's dir first, then fixed dirs), `HOME`, `NIKA_APP=1` and the
/// pass-through list when set. `None` when `HOME` is missing or not absolute.
pub fn child_env(get: &impl Fn(&str) -> Option<OsString>, node: &Path) -> Option<Vec<(OsString, OsString)>> {
    let home = get("HOME")?;
    if !Path::new(&home).is_absolute() {
        return None;
    }
    let mut path = OsString::new();
    if let Some(dir) = node.parent() {
        path.push(dir);
        path.push(":");
    }
    path.push("/opt/homebrew/bin:/usr/local/bin:");
    path.push(&home);
    path.push("/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin");

    let mut env = vec![("PATH".into(), path), ("HOME".into(), home), ("NIKA_APP".into(), "1".into())];
    for key in PASS_THROUGH {
        if let Some(v) = get(key) {
            env.push((key.into(), v));
        }
    }
    Some(env)
}

/// V8's young generation capped at 4 MB per semi-space: the server's live heap is about 10 MB, and the default
/// (up to 16 MB per semi-space on 64-bit) left it holding about 200 MB RSS, measured; with the cap it holds about 90 MB.
pub const NODE_HEAP_FLAG: &str = "--max-semi-space-size=4";

/// Arguments after the node binary: fixed, nothing from a request, the environment or the secret.
pub fn child_args(root: &Path) -> [OsString; 4] {
    [NODE_HEAP_FLAG.into(), root.join("bin").join("nika").into_os_string(), "serve".into(), "--app".into()]
}

pub enum Event {
    Msg(Msg),
    /// stdout closed: the child is gone (or closed its end).
    Closed,
}

/// What the supervisor reports to the shell.
#[derive(Debug, PartialEq, Eq)]
pub enum Sup {
    Ready(u16),
    Status(Status),
    Pick(String),
    /// No valid `ready` in time, a bad `ready`, an `error` message, or the child exited before `ready`.
    Failed,
    /// The child exited (stdout closed) after `ready`.
    Exited,
}

/// Turns the child's events into `Sup` events: waits for `ready` for at most `ready_timeout`, then forwards until the
/// child goes away. Returns after `Failed` or `Exited`.
pub fn supervise(rx: &Receiver<Event>, ready_timeout: Duration, mut emit: impl FnMut(Sup)) {
    let deadline = Instant::now() + ready_timeout;
    loop {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Event::Msg(Msg::Ready { port })) => {
                emit(Sup::Ready(port));
                break;
            }
            // bad ready, error message, exit before ready, or the timeout / a dropped sender (Err)
            Ok(Event::Msg(Msg::BadReady | Msg::Error { .. })) | Ok(Event::Closed) | Err(_) => {
                emit(Sup::Failed);
                return;
            }
            Ok(Event::Msg(_)) => {} // anything else before ready is ignored
        }
    }
    loop {
        match rx.recv() {
            Ok(Event::Msg(Msg::Status(s))) => emit(Sup::Status(s)),
            Ok(Event::Msg(Msg::PickFolder { req_id })) => emit(Sup::Pick(req_id)),
            Ok(Event::Msg(Msg::Error { .. })) => {
                emit(Sup::Failed);
                return;
            }
            Ok(Event::Msg(Msg::Ready { .. } | Msg::BadReady)) => {} // a second ready is ignored
            Ok(Event::Closed) | Err(_) => {
                emit(Sup::Exited);
                return;
            }
        }
    }
}

#[derive(Clone, Copy)]
pub struct StopTimes {
    /// After closing stdin: how long the child gets to exit on its own.
    pub stdin_grace: Duration,
    /// After SIGTERM: how long before `Child::kill`.
    pub term_grace: Duration,
}

impl Default for StopTimes {
    fn default() -> Self {
        Self { stdin_grace: Duration::from_secs(2), term_grace: Duration::from_secs(2) }
    }
}

pub struct Server {
    pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    proc: Mutex<Child>,
}

pub struct Launched {
    pub server: Arc<Server>,
    pub events: Receiver<Event>,
}

impl Server {
    /// One line to the child's stdin.
    pub fn send(&self, line: &str) -> io::Result<()> {
        let mut guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.as_mut().ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
        stdin.write_all(line.as_bytes())?;
        stdin.flush()
    }

    pub fn close_stdin(&self) {
        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn exited(&self) -> bool {
        !matches!(self.proc.lock().unwrap_or_else(|e| e.into_inner()).try_wait(), Ok(None))
    }

    fn wait_exit(&self, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        loop {
            if self.exited() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    /// Immediate kill, for a child that failed to start or must not linger.
    pub fn kill_now(&self) {
        self.close_stdin();
        let mut p = self.proc.lock().unwrap_or_else(|e| e.into_inner());
        let _ = p.kill();
        let _ = p.wait();
    }

    /// Graceful stop: close stdin (the server exits on EOF); after `stdin_grace` SIGTERM through `/bin/kill`; after
    /// `term_grace` more, `Child::kill`. Blocks up to the sum of both.
    pub fn stop(&self, t: StopTimes) {
        self.close_stdin();
        if self.wait_exit(t.stdin_grace) {
            return;
        }
        let _ = Command::new("/bin/kill").arg("-TERM").arg(self.pid.to_string()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        if self.wait_exit(t.term_grace) {
            return;
        }
        self.kill_now();
    }
}

/// Spawns the server and writes the `hello` line. `secret` is consumed: after this call only the page (through the
/// init script, built by the caller from its own copy) and the child know it.
pub fn spawn(node: &Path, root: &Path, env: Vec<(OsString, OsString)>, secret: &Secret) -> io::Result<Launched> {
    let mut child = Command::new(node)
        .args(child_args(root))
        .env_clear()
        .envs(env)
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let (Some(mut stdin), Some(stdout)) = (stdin, stdout) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("child pipes missing"));
    };
    let hello = protocol::hello_line(secret);
    if let Err(e) = stdin.write_all(hello.as_bytes()).and_then(|()| stdin.flush()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = protocol::read_lines(BufReader::new(stdout), |line| {
            if let Some(m) = protocol::parse_line(line) {
                let _ = tx.send(Event::Msg(m));
            }
        });
        let _ = tx.send(Event::Closed);
    });
    Ok(Launched { server: Arc::new(Server { pid, stdin: Mutex::new(Some(stdin)), proc: Mutex::new(child) }), events: rx })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::mpsc::RecvTimeoutError;

    fn getter<'a>(m: &'a HashMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |k| m.get(k).map(OsString::from)
    }

    const HOME: &str = "/var/fakehome";

    /// Fake `list_dir`: the entries of the listed folders (as written under `HOME`), nothing for any other.
    fn listing<'a>(m: &'a [(&'a str, &'a [&'a str])]) -> impl Fn(&Path) -> Vec<String> + 'a {
        move |p| m.iter().find(|(d, _)| Path::new(&format!("{HOME}/{d}")) == p).map(|(_, names)| names.iter().map(|s| s.to_string()).collect()).unwrap_or_default()
    }

    fn paths(v: &[&str]) -> Vec<PathBuf> {
        v.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn node_candidates_follow_the_fixed_order() {
        let home = Path::new(HOME);
        let none = |_: &Path| Vec::new();
        // (+) the fixed folders in order, no version-manager folder exists
        assert_eq!(
            node_candidates(None, home, Os::Mac, |_| true, none),
            paths(&["/opt/homebrew/bin/node", "/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node", "/var/fakehome/.local/bin/node", "/var/fakehome/.volta/bin/node", "/usr/bin/node"])
        );
        // (+) each one alone is found where it belongs
        for want in ["/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node", "/var/fakehome/.local/bin/node", "/var/fakehome/.volta/bin/node", "/usr/bin/node"] {
            assert_eq!(node_candidates(None, home, Os::Mac, |p| p == Path::new(want), none), paths(&[want]));
        }
        // (-) nothing executable: no candidate
        assert!(node_candidates(None, home, Os::Mac, |_| false, none).is_empty());
    }

    #[test]
    fn version_manager_installs_sit_between_volta_and_usr_bin_newest_first() {
        let home = Path::new(HOME);
        let dirs: &[(&str, &[&str])] = &[
            (".local/share/mise/installs/node", &["20.1.0", "22.9.1", "22.10.0", "9.0.0", "latest", "22"]),
            (".local/share/fnm/node-versions", &["v18.0.0", "v23.1.2"]),
            ("Library/Application Support/fnm/node-versions", &["v22.0.1"]),
            (".nvm/versions/node", &["v22.9.0", "v22.12.1", "v20.19.0"]),
            (".asdf/installs/nodejs", &["22.3.0", "24.0.0"]),
        ];
        // (+) one candidate per manager folder, the numerically newest (22.10.0 beats 22.9.1), tails per manager
        let exec = |p: &Path| p == Path::new("/usr/bin/node") || ["/installs/", "/node-versions/", "/.nvm/"].iter().any(|d| p.to_string_lossy().contains(d));
        let got = node_candidates(None, home, Os::Mac, exec, listing(dirs));
        assert_eq!(
            got,
            paths(&[
                "/var/fakehome/.local/share/mise/installs/node/22.10.0/bin/node",
                "/var/fakehome/.local/share/fnm/node-versions/v23.1.2/installation/bin/node",
                "/var/fakehome/Library/Application Support/fnm/node-versions/v22.0.1/installation/bin/node",
                "/var/fakehome/.nvm/versions/node/v22.12.1/bin/node",
                "/var/fakehome/.asdf/installs/nodejs/24.0.0/bin/node",
                "/usr/bin/node",
            ])
        );
    }

    #[test]
    fn version_manager_folder_names_are_parsed_strictly() {
        let home = Path::new(HOME);
        let mise = ".local/share/mise/installs/node";
        let nvm = ".nvm/versions/node";
        let only_managers = |p: &Path| p.starts_with(HOME);
        // (-) names that are not exactly <prefix><major>.<minor>.<patch> are ignored: aliases, partial versions,
        // prerelease suffixes, the wrong prefix for the manager, files, whitespace, an overflowing number
        let junk: &[&str] = &["latest", "lts", "22", "22.1", "v22.1.0", "22.1.0-rc.1", "22.1.0 ", " 22.1.0", "22.1.x", "22..1", ".22.1.0", "22.1.0.0", "-22.1.0", "+22.1.0", ".DS_Store", "99999999999.0.0", "\u{ff12}\u{ff12}.1.0"];
        assert!(node_candidates(None, home, Os::Mac, only_managers, listing(&[(mise, junk)])).iter().all(|p| !p.starts_with("/var/fakehome/.local/share/mise")));
        let junk_nvm: &[&str] = &["22.1.0", "V22.1.0", "vv22.1.0", "v22.1", "v22.1.0-rc.1", "node", "current"];
        assert!(node_candidates(None, home, Os::Mac, only_managers, listing(&[(nvm, junk_nvm)])).iter().all(|p| !p.starts_with("/var/fakehome/.nvm")));
        // (+) a valid name next to the junk still wins
        let mixed: &[&str] = &["latest", "22.1.0-rc.1", "21.0.0", "v23.0.0"];
        let got = node_candidates(None, home, Os::Mac, only_managers, listing(&[(mise, mixed)]));
        assert!(got.contains(&PathBuf::from("/var/fakehome/.local/share/mise/installs/node/21.0.0/bin/node")), "{got:?}");
        assert!(!got.iter().any(|p| p.to_string_lossy().contains("23.0.0")), "{got:?}");
    }

    #[test]
    fn a_manager_without_an_executable_node_falls_back_to_its_next_newest_install() {
        let home = Path::new(HOME);
        let nvm = ".nvm/versions/node";
        let dirs: &[(&str, &[&str])] = &[(nvm, &["v22.1.0", "v22.5.0", "v24.0.0"])];
        // (+) the newest install has no binary (a half-removed folder): the next newest that has one is used
        let got = node_candidates(None, home, Os::Mac, |p| p == Path::new("/var/fakehome/.nvm/versions/node/v22.5.0/bin/node"), listing(dirs));
        assert_eq!(got, paths(&["/var/fakehome/.nvm/versions/node/v22.5.0/bin/node"]));
        // (-) none has a binary: the manager contributes nothing
        assert!(node_candidates(None, home, Os::Mac, |_| false, listing(dirs)).is_empty());
    }

    #[test]
    fn home_based_candidates_need_an_absolute_home() {
        // (-) a relative HOME would make these paths relative to the app's working directory: only the fixed ones stay
        let got = node_candidates(None, Path::new("relative/home"), Os::Mac, |_| true, |_: &Path| Vec::new());
        assert_eq!(got, paths(&["/opt/homebrew/bin/node", "/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node", "/usr/bin/node"]));
    }

    #[test]
    fn nika_node_is_the_only_candidate_when_valid() {
        let home = Path::new(HOME);
        let none = |_: &Path| Vec::new();
        let only = |want: &'static str| move |p: &Path| p == Path::new(want);
        // (+) absolute and executable: alone, even when the list would also match
        assert_eq!(node_candidates(Some(OsStr::new("/opt/custom/node")), home, Os::Mac, |_| true, none), paths(&["/opt/custom/node"]));
        // (-) relative, not executable or empty falls through to the list
        assert_eq!(node_candidates(Some(OsStr::new("node")), home, Os::Mac, only("/usr/bin/node"), none), paths(&["/usr/bin/node"]));
        assert_eq!(node_candidates(Some(OsStr::new("/opt/custom/node")), home, Os::Mac, only("/usr/bin/node"), none), paths(&["/usr/bin/node"]));
        assert_eq!(node_candidates(Some(OsStr::new("")), home, Os::Mac, only("/usr/bin/node"), none), paths(&["/usr/bin/node"]));
        assert!(node_candidates(Some(OsStr::new("/opt/custom/node")), home, Os::Mac, |_| false, none).is_empty());
    }

    #[test]
    fn node_version_output_is_parsed_strictly_at_the_start() {
        let v = |major, minor, patch| Some(NodeVer { major, minor, patch });
        // (+) what `node --version` prints, with or without trailing text
        assert_eq!(parse_node_version("v22.1.3\n"), v(22, 1, 3));
        assert_eq!(parse_node_version("v20.0.0-nightly20230101"), v(20, 0, 0));
        assert_eq!(parse_node_version("v22.12.0 extra words"), v(22, 12, 0));
        assert_eq!(parse_node_version("v100.20.3"), v(100, 20, 3));
        // (-) anything else is garbage
        for bad in ["", "\n", "22.1.3", "node v22.1.3", " v22.1.3", "V22.1.3", "v22", "v22.1", "v22.1.", "v22..1", "v.1.2", "vx.y.z", "v-1.0.0", "v99999999999.0.0", "Error: nope", "\u{0}v22.1.3"] {
            assert_eq!(parse_node_version(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn versions_order_numerically_and_the_page_form_has_at_most_three_digits() {
        let a = NodeVer { major: 22, minor: 9, patch: 1 };
        let b = NodeVer { major: 22, minor: 10, patch: 0 };
        assert!(b > a && NodeVer { major: 23, minor: 0, patch: 0 } > b && NodeVer { major: 9, minor: 99, patch: 99 } < a);
        // (+) the form the error page accepts
        assert_eq!(a.page_form().as_deref(), Some("v22.9.1"));
        assert_eq!(NodeVer { major: 999, minor: 999, patch: 999 }.page_form().as_deref(), Some("v999.999.999"));
        // (-) a number the page would reject is left out instead of sent
        assert_eq!(NodeVer { major: 1000, minor: 0, patch: 0 }.page_form(), None);
        assert_eq!(NodeVer { major: 22, minor: 0, patch: 1000 }.page_form(), None);
    }

    /// A `find_node` run where every candidate exists and answers `--version` from a table; returns the result and
    /// the paths whose version was asked for, in order.
    fn lookup(nika_node: Option<&str>, exists: &[&str], answers: &[(&str, Option<&str>)]) -> (NodeLookup, Vec<PathBuf>) {
        let asked = std::cell::RefCell::new(Vec::new());
        let r = find_node(
            nika_node.map(OsStr::new),
            Path::new(HOME),
            Os::Mac,
            |p| exists.iter().any(|e| Path::new(e) == p),
            |_| Vec::new(),
            Instant::now,
            |p, _| {
                asked.borrow_mut().push(p.to_path_buf());
                answers.iter().find(|(a, _)| Path::new(a) == p).and_then(|(_, out)| out.map(String::from))
            },
        );
        (r, asked.into_inner())
    }

    fn ver(major: u32, minor: u32, patch: u32) -> NodeVer {
        NodeVer { major, minor, patch }
    }

    #[test]
    fn the_first_node_22_or_newer_wins_and_later_candidates_are_not_run() {
        let exists = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
        // (+) an older earlier candidate does not win over a later 22+
        let (r, asked) = lookup(None, &exists, &[("/opt/homebrew/bin/node", Some("v20.11.1\n")), ("/usr/local/bin/node", Some("v22.3.0\n")), ("/usr/bin/node", Some("v24.0.0\n"))]);
        assert_eq!(r, NodeLookup::Found("/usr/local/bin/node".into()));
        assert_eq!(asked, paths(&["/opt/homebrew/bin/node", "/usr/local/bin/node"]), "/usr/bin/node was never run");
        // (+) the boundary is 22.0.0
        assert_eq!(lookup(None, &exists[..1], &[("/opt/homebrew/bin/node", Some("v22.0.0\n"))]).0, NodeLookup::Found("/opt/homebrew/bin/node".into()));
        // (-) 21.99.99 is too old
        assert_eq!(lookup(None, &exists[..1], &[("/opt/homebrew/bin/node", Some("v21.99.99\n"))]).0, NodeLookup::TooOld(ver(21, 99, 99)));
    }

    #[test]
    fn all_too_old_reports_the_newest_version_seen_and_none_at_all_is_missing() {
        let exists = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
        // (-) every candidate is old: node-old with the newest of them, whatever the order
        let (r, asked) = lookup(None, &exists, &[("/opt/homebrew/bin/node", Some("v18.19.0")), ("/usr/local/bin/node", Some("v20.11.1")), ("/usr/bin/node", Some("v16.20.2"))]);
        assert_eq!(r, NodeLookup::TooOld(ver(20, 11, 1)));
        assert_eq!(asked.len(), 3);
        // (-) nothing exists: node-missing, and nothing is run
        let (r, asked) = lookup(None, &[], &[]);
        assert_eq!(r, NodeLookup::Missing);
        assert!(asked.is_empty());
    }

    #[test]
    fn a_version_that_times_out_fails_or_is_garbage_is_skipped() {
        let exists = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
        // (+) a candidate that answers nothing (timeout or non-zero exit give None) or garbage is skipped for the next
        let (r, _) = lookup(None, &exists, &[("/opt/homebrew/bin/node", None), ("/usr/local/bin/node", Some("segfault\n")), ("/usr/bin/node", Some("v22.1.0\n"))]);
        assert_eq!(r, NodeLookup::Found("/usr/bin/node".into()));
        // (-) skipped ones next to an old one that ran: node-old with that version
        let (r, _) = lookup(None, &exists, &[("/opt/homebrew/bin/node", None), ("/usr/local/bin/node", Some("v20.1.0")), ("/usr/bin/node", Some(""))]);
        assert_eq!(r, NodeLookup::TooOld(ver(20, 1, 0)));
        // (-) candidates exist but none answered: nothing usable was found
        let (r, _) = lookup(None, &exists, &[("/opt/homebrew/bin/node", None), ("/usr/local/bin/node", Some("x")), ("/usr/bin/node", None)]);
        assert_eq!(r, NodeLookup::Missing);
    }

    #[test]
    fn nika_node_alone_decides_even_when_it_is_too_old() {
        let exists = ["/opt/custom/node", "/opt/homebrew/bin/node"];
        let answers = [("/opt/custom/node", Some("v20.0.0")), ("/opt/homebrew/bin/node", Some("v24.0.0"))];
        // (-) a valid NIKA_NODE that is too old is node-old; the good node in the list is not used behind the owner's back
        let (r, asked) = lookup(Some("/opt/custom/node"), &exists, &answers);
        assert_eq!(r, NodeLookup::TooOld(ver(20, 0, 0)));
        assert_eq!(asked, paths(&["/opt/custom/node"]));
        // (+) a valid NIKA_NODE that is new enough is used
        assert_eq!(lookup(Some("/opt/custom/node"), &exists, &[("/opt/custom/node", Some("v22.5.0"))]).0, NodeLookup::Found("/opt/custom/node".into()));
        // (+) an invalid NIKA_NODE is ignored: the list decides
        assert_eq!(lookup(Some("relative/node"), &exists, &answers).0, NodeLookup::Found("/opt/homebrew/bin/node".into()));
    }

    #[test]
    fn find_node_uses_the_version_manager_install_when_the_system_node_is_old() {
        // (+) the end-to-end shape: an old /usr/bin/node and a 22+ nvm install -> the nvm one
        let r = find_node(
            None,
            Path::new(HOME),
            Os::Mac,
            |p| p == Path::new("/usr/bin/node") || p == Path::new("/var/fakehome/.nvm/versions/node/v22.3.0/bin/node"),
            listing(&[(".nvm/versions/node", &["v22.3.0", "v18.0.0"])]),
            Instant::now,
            |p, _| Some(if p == Path::new("/usr/bin/node") { "v18.19.1\n" } else { "v22.3.0\n" }.to_string()),
        );
        assert_eq!(r, NodeLookup::Found("/var/fakehome/.nvm/versions/node/v22.3.0/bin/node".into()));
    }

    /// A `find_node` run with a fake clock: each probe "takes" the milliseconds in `took` (at most the timeout it was
    /// given; a probe that would take longer times out and answers nothing). Returns the result and every probe's
    /// (path, timeout in ms), in order.
    fn timed(exists: &[&str], took: &[(&str, Option<&str>, u64)]) -> (NodeLookup, Vec<(PathBuf, u64)>) {
        let base = Instant::now();
        let spent = std::cell::Cell::new(Duration::ZERO);
        let asked = std::cell::RefCell::new(Vec::new());
        let r = find_node(
            None,
            Path::new(HOME),
            Os::Mac,
            |p| exists.iter().any(|e| Path::new(e) == p),
            |_| Vec::new(),
            || base + spent.get(),
            |p, timeout| {
                asked.borrow_mut().push((p.to_path_buf(), timeout.as_millis() as u64));
                let (_, out, ms) = *took.iter().find(|(a, _, _)| Path::new(a) == p).expect("a probe for a path the test did not plan");
                let ran = Duration::from_millis(ms);
                spent.set(spent.get() + ran.min(timeout));
                if ran > timeout { None } else { out.map(String::from) }
            },
        );
        (r, asked.into_inner())
    }

    const FIVE: [&str; 5] = ["/opt/homebrew/bin/node", "/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node", "/var/fakehome/.local/bin/node", "/usr/bin/node"];

    #[test]
    fn probing_stops_after_six_seconds_in_total_and_decides_with_what_is_known() {
        // (-) three hangs use 3 x 2 s; the fourth candidate would have qualified but is never asked: nothing usable
        let hang = |p| (p, None, 60_000);
        let (r, asked) = timed(&FIVE[..4], &[hang(FIVE[0]), hang(FIVE[1]), hang(FIVE[2]), (FIVE[3], Some("v24.0.0\n"), 10)]);
        assert_eq!(r, NodeLookup::Missing);
        assert_eq!(asked, vec![(PathBuf::from(FIVE[0]), 2000), (PathBuf::from(FIVE[1]), 2000), (PathBuf::from(FIVE[2]), 2000)]);
        // (-) an old version was read before the budget ran out: node-old with it; the last probe only gets what is left
        let (r, asked) = timed(&FIVE, &[(FIVE[0], Some("v20.1.0\n"), 100), hang(FIVE[1]), hang(FIVE[2]), hang(FIVE[3]), (FIVE[4], Some("v24.0.0\n"), 10)]);
        assert_eq!(r, NodeLookup::TooOld(NodeVer { major: 20, minor: 1, patch: 0 }));
        assert_eq!(asked.iter().map(|(_, t)| *t).collect::<Vec<_>>(), vec![2000, 2000, 2000, 1900], "100 + 2000 + 2000 + 1900 = 6000 ms, then stop");
        assert!(!asked.iter().any(|(p, _)| p == Path::new(FIVE[4])));
    }

    #[test]
    fn a_node_that_qualifies_inside_the_budget_wins_even_after_slow_ones() {
        let hang = |p| (p, None, 60_000);
        // (+) two hangs (4 s), then a 22+ that answers: found, the rest never asked
        let (r, asked) = timed(&FIVE, &[hang(FIVE[0]), hang(FIVE[1]), (FIVE[2], Some("v22.0.0\n"), 100), (FIVE[3], Some("v24.0.0\n"), 10), (FIVE[4], Some("v24.0.0\n"), 10)]);
        assert_eq!(r, NodeLookup::Found(FIVE[2].into()));
        assert_eq!(asked.len(), 3);
        // (+) a slow answer inside its own 2 s limit still counts; (-) one that needs longer is cut off at 2 s
        assert_eq!(timed(&FIVE[..1], &[(FIVE[0], Some("v22.1.0\n"), 1900)]).0, NodeLookup::Found(FIVE[0].into()));
        assert_eq!(timed(&FIVE[..1], &[(FIVE[0], Some("v22.1.0\n"), 2500)]).0, NodeLookup::Missing);
        // (+) well inside the budget nothing is cut: six quick answers are all asked
        let quick: Vec<(&str, Option<&str>, u64)> = FIVE.iter().map(|p| (*p, Some("v20.0.0\n"), 500)).collect();
        let (r, asked) = timed(&FIVE, &quick);
        assert_eq!(r, NodeLookup::TooOld(NodeVer { major: 20, minor: 0, patch: 0 }));
        assert_eq!(asked.len(), 5);
    }

    #[test]
    fn the_probe_command_has_a_fixed_argv_and_exactly_one_variable_home() {
        let cmd = version_command(Path::new("/opt/x/node"), Path::new("/var/fakehome"));
        // (+) program, one argument, working directory, and exactly one explicit variable, HOME (env_clear is checked on a real run)
        assert_eq!(cmd.get_program(), OsStr::new("/opt/x/node"));
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), vec![OsStr::new("--version")]);
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/")));
        assert_eq!(cmd.get_envs().collect::<Vec<_>>(), vec![(OsStr::new("HOME"), Some(OsStr::new("/var/fakehome")))]);
    }

    #[test]
    fn linuxbrew_is_a_linux_candidate_right_after_usr_local_bin() {
        let home = Path::new(HOME);
        let none = |_: &Path| Vec::new();
        let linuxbrew = "/home/linuxbrew/.linuxbrew/bin/node";
        // (+) on Linux: after /usr/local/bin, before ~/.local/bin
        assert_eq!(
            node_candidates(None, home, Os::Linux, |_| true, none),
            paths(&["/opt/homebrew/bin/node", "/opt/homebrew/opt/node/bin/node", "/usr/local/bin/node", linuxbrew, "/var/fakehome/.local/bin/node", "/var/fakehome/.volta/bin/node", "/usr/bin/node"])
        );
        assert_eq!(node_candidates(None, home, Os::Linux, |p| p == Path::new(linuxbrew), none), paths(&[linuxbrew]));
        // (-) not on macOS or anywhere else
        for os in [Os::Mac, Os::Other] {
            assert!(!node_candidates(None, home, os, |_| true, none).contains(&PathBuf::from(linuxbrew)), "{os:?}");
        }
        // (-) a Linux without Linuxbrew simply has no such candidate
        assert!(!node_candidates(None, home, Os::Linux, |p| p != Path::new(linuxbrew), none).contains(&PathBuf::from(linuxbrew)));
    }

    #[test]
    fn the_fnm_folder_under_library_is_probed_on_macos_only() {
        let home = Path::new(HOME);
        let dirs: &[(&str, &[&str])] = &[("Library/Application Support/fnm/node-versions", &["v24.0.0"]), (".local/share/fnm/node-versions", &["v22.1.0"])];
        let mac = "/var/fakehome/Library/Application Support/fnm/node-versions/v24.0.0/installation/bin/node";
        let xdg = "/var/fakehome/.local/share/fnm/node-versions/v22.1.0/installation/bin/node";
        // (+) macOS: both fnm folders, the XDG one first
        let fnm = |p: &Path| p.to_string_lossy().contains("/fnm/");
        assert_eq!(node_candidates(None, home, Os::Mac, fnm, listing(dirs)), paths(&[xdg, mac]));
        // (-) Linux and others: only the XDG one, the Library folder is never listed
        for os in [Os::Linux, Os::Other] {
            assert_eq!(node_candidates(None, home, os, fnm, listing(dirs)), paths(&[xdg]), "{os:?}");
        }
    }

    #[test]
    fn work_runs_in_the_background_and_the_caller_returns_at_once() {
        // The work waits for a release the test only sends after in_background has returned: if the work ran on the
        // caller's thread it would have finished (or timed out) before `done` could be checked.
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel();
        in_background(move || release_rx.recv_timeout(Duration::from_secs(5)).map(|()| 42).unwrap_or(-1), move |v| done_tx.send(v).unwrap());
        // (+) back here while the work is still waiting: nothing delivered yet
        assert!(done_rx.try_recv().is_err(), "the work must not have finished before the caller continued");
        release_tx.send(()).unwrap();
        // (+) the result arrives on the worker thread
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(5)), Ok(Some(42)));
        // (-) a worker that panics still reports back, with no result (the caller shows the error page for it), and
        // does not take the caller down
        let (tx2, rx2) = mpsc::channel::<Option<i32>>();
        in_background(|| -> i32 { panic!("boom") }, move |v| tx2.send(v).unwrap());
        assert_eq!(rx2.recv_timeout(Duration::from_secs(5)), Ok(None));
    }

    #[test]
    fn the_read_grace_never_outlasts_the_time_left() {
        // (+) plenty left: the usual grace
        assert_eq!(read_grace(Duration::from_secs(5)), Duration::from_millis(500));
        // (-) less left: only that; nothing left: no wait at all
        assert_eq!(read_grace(Duration::from_millis(120)), Duration::from_millis(120));
        assert_eq!(read_grace(Duration::ZERO), Duration::ZERO);
    }

    #[test]
    fn executable_check_needs_a_regular_executable_file() {
        // (+) / (-) on real files
        let dir = std::env::temp_dir().join(format!("nika-exec-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain");
        fs::write(&plain, "x").unwrap();
        assert!(!is_executable_file(&plain)); // 0644
        fs::set_permissions(&plain, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable_file(&plain));
        assert!(!is_executable_file(&dir)); // a directory is not a node binary
        assert!(!is_executable_file(&dir.join("missing")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_root_is_the_repository() {
        // (+) debug builds use the repo root next to the crate, whatever the env says
        let root = server_root(|| None).expect("bin/nika exists in the repository");
        assert!(root.join("bin").join("nika").is_file());
        assert!(root.join("public").is_dir());
    }

    #[test]
    fn child_env_has_only_the_allowed_keys() {
        // (+) allowed keys present, PATH starts with node's dir
        let mut m = HashMap::new();
        m.insert("HOME", "/var/fakehome");
        m.insert("CLAUDE_CONFIG_DIR", "/cfg/claude");
        m.insert("NIKA_CONFIG_DIR", "/cfg/nika");
        m.insert("XDG_CONFIG_HOME", "/xdg/c");
        m.insert("XDG_STATE_HOME", "/xdg/s");
        m.insert("TMUX_TMPDIR", "/tmp/t");
        m.insert("LANG", "en_US.UTF-8");
        m.insert("LC_ALL", "C");
        m.insert("LC_CTYPE", "UTF-8");
        // (-) everything else is dropped, including anything that could change what runs or leak a credential
        for k in ["NIKA_NODE", "NIKA_TMUX", "NIKA_CLAUDE", "NIKA_PORT", "NIKA_BIN", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "TMUX", "TMUX_PANE", "SHELL", "USER", "TERM", "http_proxy"] {
            m.insert(k, "x");
        }
        let env = child_env(&getter(&m), Path::new("/opt/homebrew/bin/node")).unwrap();
        let mut keys: Vec<String> = env.iter().map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        keys.sort();
        let mut want = vec!["CLAUDE_CONFIG_DIR", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "NIKA_APP", "NIKA_CONFIG_DIR", "PATH", "TMUX_TMPDIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"];
        want.sort();
        assert_eq!(keys, want);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.to_string_lossy().into_owned());
        assert_eq!(get("NIKA_APP").as_deref(), Some("1"));
        assert_eq!(get("HOME").as_deref(), Some("/var/fakehome"));
        assert_eq!(get("PATH").as_deref(), Some("/opt/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/var/fakehome/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"));
        let p = child_env(&getter(&m), Path::new("/var/fakehome/.nvm/v22/bin/node")).unwrap();
        assert!(p[0].1.to_string_lossy().starts_with("/var/fakehome/.nvm/v22/bin:/opt/homebrew/bin:"));
    }

    #[test]
    fn child_env_skips_unset_pass_through_and_needs_an_absolute_home() {
        // (+) only HOME set: just PATH, HOME, NIKA_APP
        let mut m = HashMap::new();
        m.insert("HOME", "/var/fakehome");
        assert_eq!(child_env(&getter(&m), Path::new("/usr/bin/node")).unwrap().len(), 3);
        // (-) no HOME, relative HOME
        assert!(child_env(&getter(&HashMap::new()), Path::new("/usr/bin/node")).is_none());
        let mut m = HashMap::new();
        m.insert("HOME", "relative/home");
        assert!(child_env(&getter(&m), Path::new("/usr/bin/node")).is_none());
    }

    #[test]
    fn child_args_are_fixed() {
        // (+) exactly the heap flag, script, serve, --app; (-) nothing else, whatever the secret is
        let a = child_args(Path::new("/srv/nika"));
        assert_eq!(
            a.to_vec(),
            vec![OsString::from("--max-semi-space-size=4"), "/srv/nika/bin/nika".into(), "serve".into(), "--app".into()]
        );
        let secret = Secret::generate().unwrap();
        assert!(a.iter().all(|x| !x.to_string_lossy().contains(secret.expose())));
    }

    fn feed(events: Vec<Event>, timeout: Duration, keep_open: bool) -> Vec<Sup> {
        let (tx, rx) = mpsc::channel();
        for e in events {
            tx.send(e).unwrap();
        }
        let mut out = Vec::new();
        if keep_open {
            supervise(&rx, timeout, |s| out.push(s));
            drop(tx);
        } else {
            drop(tx);
            supervise(&rx, timeout, |s| out.push(s));
        }
        out
    }

    fn status(busy: u32) -> Status {
        Status { busy, ..Status::default() }
    }

    #[test]
    fn supervise_forwards_after_ready_until_the_child_closes() {
        // (+)
        let out = feed(
            vec![
                Event::Msg(Msg::Status(status(9))), // before ready: ignored
                Event::Msg(Msg::Ready { port: 4321 }),
                Event::Msg(Msg::Status(status(1))),
                Event::Msg(Msg::PickFolder { req_id: "r".into() }),
                Event::Msg(Msg::Ready { port: 1 }), // a second ready: ignored
                Event::Closed,
            ],
            Duration::from_secs(5),
            true,
        );
        assert_eq!(out, vec![Sup::Ready(4321), Sup::Status(status(1)), Sup::Pick("r".into()), Sup::Exited]);
    }

    #[test]
    fn supervise_fails_on_timeout_bad_ready_error_or_early_exit() {
        // (-) nothing arrives in time (the sender stays alive, so this is a real timeout)
        assert_eq!(feed(vec![], Duration::from_millis(60), true), vec![Sup::Failed]);
        // (-) status before ready does not count as ready
        assert_eq!(feed(vec![Event::Msg(Msg::Status(status(1)))], Duration::from_millis(60), true), vec![Sup::Failed]);
        // (-) bad proto or port, error message, exit before ready
        assert_eq!(feed(vec![Event::Msg(Msg::BadReady)], Duration::from_secs(5), true), vec![Sup::Failed]);
        assert_eq!(feed(vec![Event::Msg(Msg::Error { message: "port in use".into() })], Duration::from_secs(5), true), vec![Sup::Failed]);
        assert_eq!(feed(vec![Event::Closed], Duration::from_secs(5), true), vec![Sup::Failed]);
        assert_eq!(feed(vec![], Duration::from_secs(5), false), vec![Sup::Failed]); // reader thread gone
        // (-) an error after ready is a failure too
        let out = feed(vec![Event::Msg(Msg::Ready { port: 1 }), Event::Msg(Msg::Error { message: "x".into() })], Duration::from_secs(5), true);
        assert_eq!(out, vec![Sup::Ready(1), Sup::Failed]);
    }

    /// Whether `pid` is a running process (a zombie awaiting its parent counts as gone).
    fn process_alive(pid: &str) -> bool {
        match Command::new("ps").args(["-o", "stat=", "-p", pid]).output() {
            Ok(o) => {
                let stat = String::from_utf8_lossy(&o.stdout);
                let stat = stat.trim();
                !stat.is_empty() && !stat.starts_with('Z')
            }
            Err(_) => Command::new("/bin/kill").args(["-0", pid]).status().map(|s| s.success()).unwrap_or(false),
        }
    }

    fn fake_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nika-child-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::write(dir.join("bin").join("nika"), "// not run: the fake node ignores it\n").unwrap();
        dir
    }

    /// A script that acts as `node`. It is run once with `--nika-test-warm` (it exits at once) before it is returned:
    /// the first run of a new file can take 200 ms or more on a loaded macOS machine (the system scans it), which
    /// would eat the 300 to 400 ms limits some tests give a probe.
    fn fake_node(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, format!("#!/bin/sh\n[ \"$1\" = --nika-test-warm ] && exit 0\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = Command::new(&p).arg("--nika-test-warm").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        p
    }

    fn wait_for(rx: &Receiver<Event>, pred: impl Fn(&Msg) -> bool) -> Option<Msg> {
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Msg(m)) if pred(&m) => return Some(m),
                Ok(Event::Closed) | Err(RecvTimeoutError::Disconnected) => return None,
                _ => {}
            }
        }
        None
    }

    // Writing a script then executing it while another thread forks can hit ETXTBSY (the forked child holds the write
    // fd for an instant). Every test that writes and runs a script takes this lock, and runs its spawns in sequence.
    static SCRIPTS: Mutex<()> = Mutex::new(());

    #[test]
    fn real_child_hello_env_argv_and_stop_ladder() {
        let _scripts = SCRIPTS.lock().unwrap_or_else(|e| e.into_inner());
        let secret = Secret::generate().unwrap();
        let env = |dir: &Path| {
            let mut m = HashMap::new();
            m.insert("HOME", "/var/fakehome");
            let node = dir.join("node");
            let env = child_env(&getter(&m), &node).unwrap();
            env
        };

        // 1. (+) a well-behaved server: hello on stdin, ready and status on stdout, exits when stdin closes
        let dir = fake_dir("ok");
        let node = fake_node(
            &dir,
            "node",
            r#"d=$(dirname "$0")
read hello
printf '%s\n' "$hello" > "$d/hello.txt"
env > "$d/env.txt"
printf '%s\n' "$@" > "$d/argv.txt"
printf '{"type":"ready","proto":1,"port":4321,"version":"x"}\n'
printf '{"type":"status","busy":1,"idle":2,"other":0,"ended":0,"attention":1,"projects":[]}\n'
cat > /dev/null"#,
        );
        let launched = spawn(&node, &dir, env(&dir), &secret).unwrap();
        assert_eq!(wait_for(&launched.events, |m| matches!(m, Msg::Ready { port: 4321 })), Some(Msg::Ready { port: 4321 }));
        assert!(wait_for(&launched.events, |m| matches!(m, Msg::Status(s) if s.attention == 1)).is_some());
        let hello: serde_json::Value = serde_json::from_str(fs::read_to_string(dir.join("hello.txt")).unwrap().trim()).unwrap();
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["proto"], 1);
        assert_eq!(hello["secret"].as_str(), Some(secret.expose()));
        let argv = fs::read_to_string(dir.join("argv.txt")).unwrap();
        assert_eq!(argv, format!("--max-semi-space-size=4\n{}/bin/nika\nserve\n--app\n", dir.display()));
        assert!(!argv.contains(secret.expose()), "secret in argv");
        let env_dump = fs::read_to_string(dir.join("env.txt")).unwrap();
        assert!(!env_dump.contains(secret.expose()), "secret in env");
        let allowed = ["PATH", "HOME", "NIKA_APP", "PWD", "SHLVL", "_", "OLDPWD"]; // the last four are added by sh itself
        for line in env_dump.lines() {
            let key = line.split('=').next().unwrap();
            assert!(allowed.contains(&key), "unexpected env key {key}");
        }
        let t = Instant::now();
        launched.server.stop(StopTimes::default());
        assert!(launched.server.exited());
        assert!(t.elapsed() < Duration::from_millis(1500), "closing stdin ends a polite server quickly");
        assert!(launched.server.send("late\n").is_err(), "stdin is closed after stop");

        // 2. (-) a server that ignores EOF and SIGTERM is killed after both graces
        let dir = fake_dir("stubborn");
        let node = fake_node(&dir, "node", "trap '' TERM\nread hello\nprintf '{\"type\":\"ready\",\"proto\":1,\"port\":1}\\n'\nwhile :; do sleep 0.1; done");
        let launched = spawn(&node, &dir, env(&dir), &secret).unwrap();
        assert!(wait_for(&launched.events, |m| matches!(m, Msg::Ready { .. })).is_some());
        let t = Instant::now();
        launched.server.stop(StopTimes { stdin_grace: Duration::from_millis(200), term_grace: Duration::from_millis(200) });
        assert!(launched.server.exited());
        assert!(t.elapsed() >= Duration::from_millis(400), "both graces were waited out: {:?}", t.elapsed());
        assert!(t.elapsed() < Duration::from_secs(3));

        // 3. (+) a server that ignores EOF but obeys SIGTERM ends at the second step, before the kill
        let dir = fake_dir("term");
        let node = fake_node(&dir, "node", "read hello\nprintf '{\"type\":\"ready\",\"proto\":1,\"port\":1}\\n'\nexec sleep 30");
        let launched = spawn(&node, &dir, env(&dir), &secret).unwrap();
        assert!(wait_for(&launched.events, |m| matches!(m, Msg::Ready { .. })).is_some());
        let t = Instant::now();
        launched.server.stop(StopTimes { stdin_grace: Duration::from_millis(200), term_grace: Duration::from_secs(3) });
        assert!(launched.server.exited());
        assert!(t.elapsed() < Duration::from_secs(2), "SIGTERM was enough: {:?}", t.elapsed());

        // 4. (+) kill_now ends a child at once; (-) the reader reports Closed
        let dir = fake_dir("kill");
        let node = fake_node(&dir, "node", "exec sleep 30");
        let launched = spawn(&node, &dir, env(&dir), &secret).unwrap();
        launched.server.kill_now();
        assert!(launched.server.exited());
        assert!(wait_for(&launched.events, |_| true).is_none(), "stdout closed, no message");

        // 5. (-) a missing node binary is an error, not a panic
        assert!(spawn(&dir.join("no-such-node"), &dir, env(&dir), &secret).is_err());

        for tag in ["ok", "stubborn", "term", "kill"] {
            let _ = fs::remove_dir_all(std::env::temp_dir().join(format!("nika-child-test-{}-{tag}", std::process::id())));
        }
    }

    #[test]
    fn real_version_probe_runs_node_with_a_cleared_env_and_gives_up_on_a_hang() {
        let _scripts = SCRIPTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = fake_dir("probe");
        let run = |name: &str, body: &str, timeout_ms: u64| {
            let node = fake_node(&dir, name, body);
            run_node_version(&node, Path::new("/var/fakehome"), Duration::from_millis(timeout_ms))
        };
        // (+) a node that prints its version and exits 0
        assert_eq!(run("ok", "echo v22.4.1", 3000).as_deref(), Some("v22.4.1\n"));
        // (+) argv is exactly `--version`, the env is HOME as given and nothing else (not this process's HOME, not a canary), cwd is /
        std::env::set_var("NIKA_PROBE_CANARY", "leak");
        let body = format!("printf '%s\\n' \"$@\" > \"{d}/argv.txt\"\nenv > \"{d}/env.txt\"\npwd > \"{d}/cwd.txt\"\necho v22.4.1", d = dir.display());
        assert_eq!(run("dump", &body, 3000).as_deref(), Some("v22.4.1\n"));
        std::env::remove_var("NIKA_PROBE_CANARY");
        assert_eq!(fs::read_to_string(dir.join("argv.txt")).unwrap(), "--version\n");
        let env_dump = fs::read_to_string(dir.join("env.txt")).unwrap();
        for line in env_dump.lines() {
            let key = line.split('=').next().unwrap();
            assert!(["HOME", "PWD", "SHLVL", "_", "OLDPWD", "PATH"].contains(&key), "unexpected env key {key} in {env_dump:?}");
        }
        assert!(!env_dump.contains("NIKA_PROBE_CANARY"));
        assert_eq!(env_dump.lines().filter(|l| l.starts_with("HOME=")).collect::<Vec<_>>(), vec!["HOME=/var/fakehome"], "HOME is the given home, once");
        assert_eq!(fs::read_to_string(dir.join("cwd.txt")).unwrap().trim(), "/");
        // (-) a non-zero exit is a failure even when it printed something version-like
        assert_eq!(run("fail", "echo v22.4.1\nexit 3", 3000), None);
        // (-) a hang is killed at the timeout and reported as nothing, long before the sleep would end
        let hang = fake_node(&dir, "hang", "exec sleep 30");
        let t = Instant::now();
        assert_eq!(run_node_version(&hang, Path::new("/var/fakehome"), Duration::from_millis(300)), None);
        assert!(t.elapsed() >= Duration::from_millis(300) && t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        // (-) a node that does not exist or is not a program is None, not a panic
        assert_eq!(run_node_version(&dir.join("no-such-node"), Path::new("/var/fakehome"), Duration::from_secs(1)), None);
        // (+) garbage comes back as text (parse_node_version rejects it), output is capped, and a chatty node is not killed
        assert_eq!(run("garbage", "echo segfault", 3000).as_deref(), Some("segfault\n"));
        let chatty = run("chatty", "echo v22.4.1\nhead -c 1000000 /dev/zero | tr '\\0' x\necho tail", 5000).unwrap();
        assert_eq!(chatty.len() as u64, VERSION_MAX_OUT);
        assert!(chatty.starts_with("v22.4.1\nxxx"));

        // (-) a node that forks a hanging grandchild: the timeout kills the whole process group, so the grandchild
        // (which holds the stdout pipe) dies too instead of lingering, and the call still returns at the limit
        let gc_pid = dir.join("gc.pid");
        let body = format!("sleep 30 &\necho $! > \"{}\"\nwait", gc_pid.display());
        let forker = fake_node(&dir, "forker", &body);
        let t = Instant::now();
        assert_eq!(run_node_version(&forker, Path::new("/var/fakehome"), Duration::from_millis(400)), None);
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        let gc: String = fs::read_to_string(&gc_pid).expect("the script recorded its grandchild").trim().to_string();
        assert!(gc.parse::<u32>().is_ok(), "{gc:?}");
        let mut dead = false;
        for _ in 0..50 {
            if !process_alive(&gc) {
                dead = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !dead {
            let _ = Command::new("/bin/kill").arg("-KILL").arg(&gc).status(); // do not leave it behind when the check fails
        }
        assert!(dead, "the grandchild {gc} survived the timeout");
        // (-) a node that exits at once but leaves a background process holding stdout: the read grace is cut to the time
        // left in the probe's own limit (300 ms here), not a flat 500 ms on top of it
        let gc2_pid = dir.join("gc2.pid");
        let body = format!("sleep 30 &\necho $! > \"{}\"\necho v22.4.1", gc2_pid.display());
        let lingerer = fake_node(&dir, "lingerer", &body);
        let t = Instant::now();
        assert_eq!(run_node_version(&lingerer, Path::new("/var/fakehome"), Duration::from_millis(300)), None, "stdout never reached EOF, so there is no answer");
        assert!(t.elapsed() < Duration::from_millis(450), "grace must fit the 300 ms limit: {:?}", t.elapsed());
        let gc2: String = fs::read_to_string(&gc2_pid).unwrap().trim().to_string();
        let _ = Command::new("/bin/kill").arg("-KILL").arg(&gc2).status();

        // (+) the whole lookup on a real folder tree and real fake-node scripts: only paths under a throwaway home count,
        // so the machine's own node never takes part. A space in a folder name, newest install, 22+ wins, old ones named.
        let find = |home: &Path| {
            let under = home.to_path_buf();
            find_node(None, home, Os::Mac, |p| p.starts_with(&under) && is_executable_file(p), list_dir_names, Instant::now, |p, _| run_node_version(p, home, Duration::from_secs(3)))
        };
        let make = |home: &Path, rel: &str, version: &str| {
            let p = home.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fake_node(p.parent().unwrap(), p.file_name().unwrap().to_str().unwrap(), &format!("echo {version}"));
            p
        };
        let home = dir.join("home-a");
        make(&home, ".nvm/versions/node/v20.1.0/bin/node", "v20.1.0");
        let new_nvm = make(&home, ".nvm/versions/node/v22.4.0/bin/node", "v22.4.0");
        make(&home, ".nvm/versions/node/v9.0.0/bin/node", "v9.0.0");
        fs::create_dir_all(home.join(".nvm/versions/node/v23.0.0")).unwrap(); // newest folder, no binary: skipped
        assert_eq!(find(&home), NodeLookup::Found(new_nvm));
        let home = dir.join("home-b");
        let fnm = make(&home, "Library/Application Support/fnm/node-versions/v24.0.0/installation/bin/node", "v24.0.0");
        make(&home, ".nvm/versions/node/v22.4.0/bin/node", "v22.4.0");
        assert_eq!(find(&home), NodeLookup::Found(fnm), "fnm comes before nvm, and a space in the path is fine");
        // (-) only old installs: node-old with the newest version seen; an empty home: node-missing
        let home = dir.join("home-c");
        make(&home, ".asdf/installs/nodejs/20.9.0/bin/node", "v20.9.0");
        make(&home, ".local/share/mise/installs/node/18.0.0/bin/node", "v18.0.0");
        assert_eq!(find(&home), NodeLookup::TooOld(NodeVer { major: 20, minor: 9, patch: 0 }));
        let home = dir.join("home-d");
        fs::create_dir_all(&home).unwrap();
        assert_eq!(find(&home), NodeLookup::Missing);
        // (-) the newest install of a manager hangs: it is skipped at the limit (short here) and, being that manager's
        // only candidate, leaves nothing to use
        let home = dir.join("home-e");
        let hung = home.join(".nvm/versions/node/v25.0.0/bin");
        fs::create_dir_all(&hung).unwrap();
        fake_node(&hung, "node", "exec sleep 30");
        let under = home.clone();
        let started = Instant::now();
        let r = find_node(None, &home, Os::Mac, |p| p.starts_with(&under) && is_executable_file(p), list_dir_names, Instant::now, |p, _| run_node_version(p, &home, Duration::from_millis(300)));
        assert_eq!(r, NodeLookup::Missing);
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());

        let _ = fs::remove_dir_all(std::env::temp_dir().join(format!("nika-child-test-{}-probe", std::process::id())));
    }

    /// Whether the pid is still in the process table at all (a zombie counts: it has not been reaped).
    fn process_listed(pid: &str) -> bool {
        Command::new("ps").args(["-o", "stat=", "-p", pid]).output().map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty()).unwrap_or(false)
    }

    #[test]
    fn stopping_the_probes_kills_the_running_one_with_its_group_and_it_is_reaped() {
        // Never calls `kill_active_probe` (the process-wide registry): that would stop every later probe in this test
        // binary. It uses a registry of its own, the same code.
        let _scripts = SCRIPTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = fake_dir("stopprobe");
        let home = Path::new("/var/fakehome");
        let listed = |p: &Probes| p.state.lock().unwrap().pids.len();

        // (+) a hanging probe that forked a grandchild holding the pipe: stop() ends both at once, the call returns
        // long before its 20 s limit, and the probe is reaped (no longer in the process table, not even as a zombie)
        let probes = Arc::new(Probes::new());
        let pids = dir.join("pids.txt");
        let node = fake_node(&dir, "hang", &format!("sleep 30 &\necho \"$$ $!\" > \"{}\"\nwait", pids.display()));
        let worker = {
            let (probes, node) = (probes.clone(), node.clone());
            thread::spawn(move || run_node_version_in(&probes, &node, home, Duration::from_secs(20)))
        };
        let mut recorded = String::new();
        for _ in 0..100 {
            recorded = fs::read_to_string(&pids).unwrap_or_default();
            if recorded.split_whitespace().count() == 2 && listed(&probes) == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let ids: Vec<&str> = recorded.split_whitespace().collect();
        assert_eq!(ids.len(), 2, "the script recorded its pid and its grandchild's: {recorded:?}");
        assert_eq!(listed(&probes), 1, "the running probe is registered");
        let t = Instant::now();
        probes.stop();
        assert_eq!(worker.join().unwrap(), None);
        assert!(t.elapsed() < Duration::from_secs(5), "stop ends the probe now, not at its limit: {:?}", t.elapsed());
        assert_eq!(listed(&probes), 0, "a reaped probe is no longer registered");
        assert!(!process_listed(ids[0]), "the probe {} was reaped", ids[0]);
        let mut gone = false;
        for _ in 0..50 {
            if !process_alive(ids[1]) {
                gone = true;
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        if !gone {
            let _ = Command::new("/bin/kill").arg("-KILL").arg(ids[1]).status(); // do not leave it behind when the check fails
        }
        assert!(gone, "the grandchild {} survived the stop", ids[1]);

        // (-) once stopped, nothing is spawned any more: a later candidate is not even started (the marker would exist)
        let marker = dir.join("started.txt");
        let late = fake_node(&dir, "late", &format!("touch \"{}\"\necho v22.4.1", marker.display()));
        assert_eq!(run_node_version_in(&probes, &late, home, Duration::from_secs(3)), None);
        assert!(!marker.exists(), "no probe is started after the stop");
        assert_eq!(listed(&probes), 0);
        probes.stop(); // (-) stopping twice, with nothing running, is harmless

        // (-) every way a probe can end leaves nothing registered, so a later stop can never signal a pid that was
        // already reaped (and might have been reused): success, a non-zero exit, a timeout, a missing binary
        let probes = Probes::new();
        let ok = fake_node(&dir, "ok", "echo v22.4.1");
        assert_eq!(run_node_version_in(&probes, &ok, home, Duration::from_secs(3)).as_deref(), Some("v22.4.1\n"));
        assert_eq!(listed(&probes), 0, "after success");
        let bad = fake_node(&dir, "bad", "exit 3");
        assert_eq!(run_node_version_in(&probes, &bad, home, Duration::from_secs(3)), None);
        assert_eq!(listed(&probes), 0, "after a failure");
        let hung = fake_node(&dir, "hung", "exec sleep 30");
        assert_eq!(run_node_version_in(&probes, &hung, home, Duration::from_millis(200)), None);
        assert_eq!(listed(&probes), 0, "after a timeout");
        assert_eq!(run_node_version_in(&probes, &dir.join("no-such-node"), home, Duration::from_secs(1)), None);
        assert_eq!(listed(&probes), 0, "after a spawn failure");
        // (+) and a probe that is still running is registered while it runs
        let slow = fake_node(&dir, "slow", "sleep 0.3\necho v22.4.1");
        let seen = {
            let probes = &probes;
            thread::scope(|sc| {
                let h = sc.spawn(move || run_node_version_in(probes, &slow, home, Duration::from_secs(3)));
                let mut seen = false;
                for _ in 0..40 {
                    if listed(probes) == 1 {
                        seen = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                assert_eq!(h.join().unwrap().as_deref(), Some("v22.4.1\n"));
                seen
            })
        };
        assert!(seen, "a running probe is registered");
        assert_eq!(listed(&probes), 0);

        let _ = fs::remove_dir_all(std::env::temp_dir().join(format!("nika-child-test-{}-stopprobe", std::process::id())));
    }
}
