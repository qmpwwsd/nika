//! The private server child: `node <root>/bin/nika serve --app`, supervised over stdin/stdout JSON lines.
//! Fixed argv, an environment built from scratch, the secret only on stdin (never argv, env, disk, logs).

use std::ffi::{OsStr, OsString};
use std::io::{self, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
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

/// `NIKA_NODE` when it is an absolute path to an executable file, else the first executable `node` in a fixed list.
pub fn find_node(nika_node: Option<&OsStr>, home: &Path, is_exec: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    if let Some(n) = nika_node {
        let p = Path::new(n);
        if p.is_absolute() && is_exec(p) {
            return Some(p.to_path_buf());
        }
    }
    [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/opt/node/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".local/bin"),
        PathBuf::from("/usr/bin"),
    ]
    .into_iter()
    .map(|d| d.join("node"))
    .find(|p| is_exec(p))
}

pub fn find_node_here(get: &impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let home = PathBuf::from(get("HOME")?);
    find_node(get("NIKA_NODE").as_deref(), &home, is_executable_file)
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

/// Arguments after the node binary: fixed, nothing from a request, the environment or the secret.
pub fn child_args(root: &Path) -> [OsString; 3] {
    [root.join("bin").join("nika").into_os_string(), "serve".into(), "--app".into()]
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

    #[test]
    fn node_lookup_order() {
        let home = Path::new("/var/fakehome");
        let only = |want: &'static str| move |p: &Path| p == Path::new(want);
        // (+) NIKA_NODE wins when absolute and executable
        assert_eq!(find_node(Some(OsStr::new("/opt/custom/node")), home, only("/opt/custom/node")), Some("/opt/custom/node".into()));
        // (+) the fixed list, in order
        assert_eq!(find_node(None, home, |_| true), Some("/opt/homebrew/bin/node".into()));
        assert_eq!(find_node(None, home, only("/opt/homebrew/opt/node/bin/node")), Some("/opt/homebrew/opt/node/bin/node".into()));
        assert_eq!(find_node(None, home, only("/usr/local/bin/node")), Some("/usr/local/bin/node".into()));
        assert_eq!(find_node(None, home, only("/var/fakehome/.local/bin/node")), Some("/var/fakehome/.local/bin/node".into()));
        assert_eq!(find_node(None, home, only("/usr/bin/node")), Some("/usr/bin/node".into()));
        // (-) NIKA_NODE relative, not executable or empty falls through to the list; nothing found is None
        assert_eq!(find_node(Some(OsStr::new("node")), home, only("/usr/bin/node")), Some("/usr/bin/node".into()));
        assert_eq!(find_node(Some(OsStr::new("/opt/custom/node")), home, only("/usr/bin/node")), Some("/usr/bin/node".into()));
        assert_eq!(find_node(Some(OsStr::new("")), home, only("/usr/bin/node")), Some("/usr/bin/node".into()));
        assert_eq!(find_node(None, home, |_| false), None);
        assert_eq!(find_node(Some(OsStr::new("/opt/custom/node")), home, |_| false), None);
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
        // (+) exactly script, serve, --app; (-) nothing else, whatever the secret is
        let a = child_args(Path::new("/srv/nika"));
        assert_eq!(a.to_vec(), vec![OsString::from("/srv/nika/bin/nika"), "serve".into(), "--app".into()]);
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

    fn fake_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nika-child-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::write(dir.join("bin").join("nika"), "// not run: the fake node ignores it\n").unwrap();
        dir
    }

    fn fake_node(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
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

    // One test for all real spawns, run in sequence: writing then executing scripts from parallel threads can hit
    // ETXTBSY (a forked child holds the write fd for an instant).
    #[test]
    fn real_child_hello_env_argv_and_stop_ladder() {
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
        assert_eq!(argv, format!("{}/bin/nika\nserve\n--app\n", dir.display()));
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
}
