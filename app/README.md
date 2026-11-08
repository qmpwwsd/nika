# nika desktop shell

A thin Tauri v2 shell (macOS and Linux): a tray icon, one window, and a supervisor for the private server
`node bin/nika serve --app`. All dashboard logic stays in Node (`src/`, `public/`); the shell only starts the server,
hands it a per-launch secret over stdin, hosts one webview pointed at it, and shows the status in the tray.
Decisions: `docs/adr/0001` to `0003` and `0009`. Protocol: `docs/contracts/api-app.md` section 5. Rules:
`rules/project-rules.md` section 13.

## Rust dependencies (owner approval, 2026-11-08)

Versions are pinned (`=x.y.z` in `Cargo.toml`) and `Cargo.lock` is committed. Any other crate is a new approval.

| Crate | Version | Features | Why |
|---|---|---|---|
| `tauri` | 2.12.5 | `tray-icon`, `image-png` | window, webview, tray, menus |
| `tauri-build` | 2.7.4 | | build script |
| `tauri-plugin-single-instance` | 2.5.5 | | a second launch shows the existing window |
| `tauri-plugin-dialog` | 2.8.4 | | native folder picker (Rust API only, no page access) |
| `tauri-plugin-autostart` | 2.7.0 | | "Start at login" (macOS LaunchAgent, Linux autostart entry) |
| `serde` | 1.0.229 | `derive` | protocol messages |
| `serde_json` | 1.0.154 | | protocol messages |

Build tools (not compiled into the app; `cargo install <name> --version <v> --locked`):

| Tool | Version | Use |
|---|---|---|
| `tauri-cli` | 2.12.4 | `cargo tauri build` (bundles), `cargo tauri icon` |
| `cargo-audit` | 0.22.2 | `cargo audit` in CI |

Small pieces are written by hand instead of adding crates: base64url, the `/dev/urandom` read, the claude.ai link
matcher, the line reader. No `regex`, `rand`, `libc`, `base64` or opener/shell plugin.

## Build, test, run

`cargo` is not always on `PATH` (Homebrew rustup): `export PATH=/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH`.

```sh
cd app/src-tauri
cargo test --locked                  # unit tests, including a real child process with a fake node
cargo build --locked                 # debug binary: target/debug/nika-app
cargo audit                          # advisories for Cargo.lock
cargo tauri build --bundles app      # macOS: target/release/bundle/macos/nika.app (ad-hoc signed, identity "-")
cargo tauri build --bundles deb,appimage   # Linux only
```

Run a debug build against throwaway data (it uses the repository's `bin/`, `src/` and `public/`):

```sh
NIKA_CONFIG_DIR=/path/to/cfg XDG_STATE_HOME=/path/to/state CLAUDE_CONFIG_DIR=/path/to/claude \
  TMUX_TMPDIR=/path/to/empty-dir ./target/debug/nika-app
```

Environment the app reads: `NIKA_NODE` (absolute path to a node binary; otherwise the first executable `node` in
`/opt/homebrew/bin`, `/opt/homebrew/opt/node/bin`, `/usr/local/bin`, `$HOME/.local/bin`, `/usr/bin`). Which JS runs is
never an env var: release builds load `<resources>/nika`, debug builds the repository root. `--hidden` (passed by
"Start at login") keeps the window closed until it is opened from the tray.

Icons are drawn by `node scripts/make-icons.mjs` (stdlib only) into `src-tauri/icons/`; the bundle icons were derived
from `icons/source-1024.png` with `cargo tauri icon` and the unused mobile and Windows outputs removed.

## Module map (`src-tauri/src`)

| File | Role |
|---|---|
| `main.rs`, `lib.rs` | entry point; app state, window and tray wiring, quit, menus, retry, folder picker thread |
| `child.rs` | node lookup, server root, child env and argv, spawn, supervisor (10 s `ready` timeout), stop ladder (stdin close, `/bin/kill -TERM`, `kill`, 2 s each) |
| `protocol.rs` | JSON-lines parser and writer (64 KB line bound, validated ids and counts), `hello` and `folder` lines |
| `secret.rs` | 32 random bytes as base64url; `Debug` prints `***` |
| `nav.rs` | navigation predicate, claude.ai session-link matcher, fixed `open` / `xdg-open` argv, init script, error-page URLs |
| `tray.rs` | status line, project rows, menu, icons |
| `ui/` | local error page (`error.html`, `error.css`, `error.js`): no inline script or style, no IPC; Retry is a link the shell intercepts |
| `linux/` | `.desktop` files for the deb (see below) |

## Security notes

- No capability file exists: the webview has no Tauri permission for any origin. `withGlobalTauri` is false, so the
  page has no `window.__TAURI__`. Tauri still defines `window.__TAURI_INTERNALS__` on every page; every command is
  refused ("not allowed") because nothing grants a capability.
- The secret is written to the child's stdin once and injected by the init script only when
  `location.origin` equals the server's origin. It is never in argv, the environment, a file or a log.
- Zoom (Cmd and +, -, 0) is a native macOS View menu, because the zoom hotkey polyfill would need a capability for the
  page's origin. On Linux the menu bar is not shown, so there is no zoom shortcut yet.

## Linux packaging

The deb bundler names the desktop entry `<productName>.desktop` (`nika.desktop`) and cannot be told otherwise, while
`gtk-launch io.github.qmpwwsd.nika` (used by `nika app` and `nika doctor`) needs `io.github.qmpwwsd.nika.desktop`.
`linux/io.github.qmpwwsd.nika.desktop` is therefore added to the deb as an extra file, and the generated
`nika.desktop` is hidden with `NoDisplay=true` (`linux/nika.desktop` is its template). The AppImage keeps the default
`nika.desktop` inside the image. The AppIndicator, WebKitGTK and GTK dependencies of the deb are added by
`cargo tauri build` itself from the features and the build host; the CI image needs `libayatana-appindicator3-dev`.
