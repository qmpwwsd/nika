# Building and packaging the nika app

Status: 0.2 is in progress and **nothing is published**. You build the app from source. The Linux release workflow
exists and builds artifacts only (see Release build); the Homebrew formula is Phase 6 and not done.

Decision record: [ADR 0009](adr/0009-packaging.md). Shell facts: [architecture](architecture.md). Threats:
[security](security.md).

## What you get

- Bundle id `io.github.qmpwwsd.nika`, display name `nika`, Rust binary `nika-app`.
- The app bundle carries the Node server files (`bin`, `src`, `public`, `templates`, `package.json`) as resources. It
  does **not** carry Node itself.

## Runtime requirements (both systems)

- Node 22 or newer. The app looks for it in this order: `NIKA_NODE` (an absolute path), else the first `node` in
  `/opt/homebrew/bin`, `/opt/homebrew/opt/node/bin`, `/usr/local/bin`, `~/.local/bin`, `/usr/bin`.
- tmux and Claude Code, for the session window, spawn and orchestrator features.

## macOS: build from source

Needs the Xcode Command Line Tools (`xcode-select --install`). Full Xcode is not needed: the bundle was built and
ad-hoc signed with the Command Line Tools only.

```sh
brew install rustup
export PATH="$(brew --prefix rustup)/bin:$HOME/.cargo/bin:$PATH"
rustup default stable
cargo install tauri-cli --version 2.12.4 --locked
cd app/src-tauri
cargo tauri build --bundles app
```

- The Homebrew `rustup` formula is **keg-only**: it is not linked into the default `PATH`, so the `export` line is
  needed in every new shell (put it in your shell profile). `~/.cargo/bin` is where `cargo install` puts `cargo-tauri`.
- `tauri-cli` is a build tool. It is installed with `--locked` at a pinned version and never compiled into the app.
- The bundle lands in `app/src-tauri/target/release/bundle/macos/nika.app`.

Install it by copying `nika.app` to `~/Applications` (or `/Applications`) and opening it once. `nika` and `nika app`
find it by bundle id.

### Signing and Gatekeeper

- The bundle is signed **ad hoc** (identity `-`). That gives it a valid code signature without an Apple identity. Apple
  Silicon refuses to run completely unsigned code, so this is the minimum. It says nothing about who built the app.
- The app is **not notarized**. Notarization needs a paid Apple Developer identity; none is planned for 0.2.
- A bundle you built yourself has no quarantine flag, so macOS opens it without a Gatekeeper prompt.
- A copy that arrived by download, AirDrop or a browser gets the `com.apple.quarantine` flag, and Gatekeeper blocks it
  because it is not notarized. Open System Settings, Privacy & Security, and press "Open Anyway". On macOS 15 and later
  the Control-click "Open" shortcut no longer bypasses the block. You can also clear the flag with
  `xattr -dr com.apple.quarantine <path to nika.app>`; do that only for a bundle you built or trust.

## Linux: build from source

Debian and Ubuntu build dependencies (the Tauri v2 prerequisites, including the AppIndicator dev package):

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Other distributions: see the Tauri v2 prerequisites page (`https://v2.tauri.app/start/prerequisites/`).

```sh
# install Rust with rustup (https://rustup.rs), then:
export PATH="$HOME/.cargo/bin:$PATH"
cargo install tauri-cli --version 2.12.4 --locked
cd app/src-tauri
cargo tauri build --bundles deb,appimage
```

- The packages land in `app/src-tauri/target/release/bundle/deb/` and `…/bundle/appimage/`.
- The AppImage bundler fetches its helper tools at build time, so the build needs network access.
- Ubuntu 22.04 is the build baseline (CI and the release workflow use it).

### Linux runtime dependencies

- **WebKitGTK 4.1** (Debian and Ubuntu: `libwebkit2gtk-4.1-0`).
- **AppIndicator** for the tray icon (`libayatana-appindicator3-1`). Some desktops, such as stock GNOME, need an
  AppIndicator extension to show the icon. Without a tray icon the window still works; starting the app again focuses
  the existing window.
- Node 22+, tmux and Claude Code (see above).

### Desktop entry

`nika app` starts the Linux app with `nika-app` from `PATH`, then falls back to `gtk-launch io.github.qmpwwsd.nika`.
That needs a desktop entry named **`io.github.qmpwwsd.nika.desktop`** in `$XDG_DATA_HOME/applications`
(`~/.local/share/applications`) or in one of the `$XDG_DATA_DIRS` folders (`/usr/share/applications`). `nika doctor`
looks for the same file name.

Tauri's bundler always names its own entry `<productName>.desktop` (`nika.desktop`). The `.deb` therefore also
installs `/usr/share/applications/io.github.qmpwwsd.nika.desktop` (`bundle.linux.deb.files`), and the generated
`nika.desktop` is marked `NoDisplay=true` so the menu shows nika once. The AppImage carries only `nika.desktop`; run it
directly or put it on `PATH` as `nika-app`.

Verified on a local Debian 12 build (`cargo tauri build --bundles deb`, arm64): `dpkg-deb -I` shows `Depends:
libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0` (the bundler adds them itself), and `dpkg-deb -c` lists
`usr/bin/nika-app`, both desktop entries under `usr/share/applications/`, and the server files under
`usr/lib/nika/nika/` (`bin/nika` and the rest of the resource folder). The AppImage was not built in that run: its helper
download (`AppRun-aarch64` from `tauri-apps/binary-releases`) answered HTTP 503. `release-linux.yml` checks the `.deb`
the same way on every run.

## How `nika` finds the app

From the CLI contract ([`contracts/api-app.md` section 7](contracts/api-app.md)):

| Command | macOS | Linux |
|---|---|---|
| `nika`, `nika open` | `open -b io.github.qmpwwsd.nika`; if the app is missing, the browser dashboard | `nika-app` on `PATH`, then `gtk-launch io.github.qmpwwsd.nika`; if both fail, the browser dashboard |
| `nika app`, `nika open --app` | the same lookup; exit 1 with an install hint when the app is missing | the same |
| `nika open --browser` | skips the app lookup | skips the app lookup |

The browser dashboard needs `nika serve` to be running (for example `brew services start nika`). The app does not: it
starts its own private server.

## Continuous integration

`.github/workflows/ci.yml` runs on push to `master`, on pull requests (a PR branch runs once, through the pull request
trigger) and on manual dispatch, with a read-only token and no secrets:

- `node`: `npm test` on macOS and Ubuntu (Node 22).
- `rust` (macOS and Ubuntu 22.04): in `app/src-tauri`, `cargo test --locked`, `cargo build --locked`, then `cargo audit`
  with `cargo-audit` 0.22.2 installed `--locked`.
- `linux-verify` (Ubuntu, Node 22, tmux): `scripts/linux-verify.sh`.
- `gui-smoke` (Ubuntu 22.04): `scripts/gui-smoke.sh`.

CI does not build the bundles. It does not publish anything.

## Linux checks

Two scripts prove the Linux side. Both refuse to run on macOS and exit non-zero on any failure.

**`scripts/linux-verify.sh`** (the Node side). It runs in a throwaway `HOME`, `CLAUDE_CONFIG_DIR`, `NIKA_CONFIG_DIR`,
`XDG_STATE_HOME` and `TMUX_TMPDIR`, on a private tmux server (`tmux -L nika-verify`), and prints a PASS/FAIL table:

- `npm test`;
- `ps -o lstart` on Linux through the real parser in `src/collect/registry.js`: the start time of a fresh process parses
  to within 2 minutes of now even when the caller's `TZ` is not UTC, and `isAlive` matches it;
- the `serve --app` handshake: `ready` arrives, `/api/app/me` answers 200 with the secret and 403 without it, with a
  wrong one and with a foreign `Host`, the listener is on 127.0.0.1 only (`ss -ltn`), and closing stdin ends the server
  with exit code 0;
- tmux, through nika's own `mirror.js` and `keys.js`: SGR colours survive the mirror, OSC 52, OSC 8 and DCS do not,
  `send-keys -l -- '-x text'` arrives literally, a multi-line paste through `load-buffer -` and `paste-buffer -p -d`
  arrives bracketed, and no tmux buffer is left behind;
- cleanup: the tmux server, background jobs and the temp dir are gone.

Run it in Docker (the image is the pinned `node:22-bookworm-slim` plus tmux, procps and iproute2; it holds a copy of the
repository and nothing else, so never mount your home folder or `~/.claude` into it):

```sh
docker build -f Dockerfile.test -t nika-verify . && docker run --rm nika-verify
```

**`scripts/gui-smoke.sh`** (the shell). It builds the debug shell (`cargo build --locked`) and runs it under Xvfb on a
private session bus. `scripts/shell-probe.mjs` stands in for the Node server (the shell runs `<NIKA_NODE> <root>/bin/nika
serve --app`, so the script writes an executable `node` wrapper at run time). The probe serves a page with a strict CSP;
a real WebKitGTK window loads it and reports back. It checks that:

- the shell starts the child with the fixed argv and the minimal environment;
- `window.__NIKA_APP__` exists on the server origin only as `{secret, port}` (frozen, non-enumerable, configurable, not
  writable), carries the right secret (compared as a SHA-256 hash) and can be deleted;
- there is no `window.__TAURI__`, and `plugin:app|version`, `plugin:autostart|is_enabled` and
  `plugin:webview|get_all_webviews` are refused through `__TAURI_INTERNALS__`;
- navigation to `http://localhost:<port>/`, to another loopback port and to `file:///etc/hosts` is blocked (the probe sees no
  request and the page stays alive), `window.open` returns null, and a same-origin navigation still works.

The probe prints one JSON result line; the script prints it and a PASS/FAIL list. To run it in Docker (the first build
compiles the shell; a default container has no user namespaces, so the WebKit sandbox is switched off for this run
only):

```sh
docker build -f Dockerfile.test --target gui -t nika-gui . && docker run --rm -e NIKA_SMOKE_NO_SANDBOX=1 nika-gui
```

The shell ran with no StatusNotifier host (no desktop, Xvfb only): the tray did not fail, nothing was printed, and the
window loaded. Without a tray host the icon is simply not shown.

## Release build

`.github/workflows/release-linux.yml` builds the Linux packages. It is manual (`workflow_dispatch`), runs on Ubuntu 22.04
with a read-only token and **produces workflow artifacts only**: it never creates a tag, a release or a release asset.
Clean build, no caches. Steps: install the dependencies, `cargo install tauri-cli --version 2.12.4 --locked`,
`cargo tauri build --bundles deb,appimage`, check the `.deb` with `dpkg-deb` (Depends names WebKitGTK 4.1 and
AppIndicator; the package contains the desktop entry `io.github.qmpwwsd.nika.desktop` and the bundled `nika/bin/nika`),
write `SHA256SUMS`, upload the `.deb`, the `.AppImage` and `SHA256SUMS` as the artifact `nika-linux` (kept 14 days).

The owner starts it: Actions tab, `release-linux`, "Run workflow" (or `gh workflow run release-linux.yml --ref <branch>`).
Download the artifact (`gh run download <run-id> -n nika-linux`), check `sha256sum -c SHA256SUMS`, and publish by hand if
wanted.

## Phase 6 (not done yet)

- **Homebrew formula** in the separate repo `qmpwwsd/homebrew-tap` (`Formula/nika.rb`): build the app from source
  (`depends_on "rust" => :build`), sign ad hoc, install the CLI and `nika.app`. Not written.
- Every publish step (tag, release, tap pull request, workflow dispatch) needs its own approval from the owner.
