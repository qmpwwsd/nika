# Building and packaging the nika app

Status: 0.2 is in progress and **nothing is published**. You build the app from source. Release packaging (Homebrew
formula, Linux release workflow) is Phase 6 and not done; see the end of this file.

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
- Ubuntu 22.04 is the build baseline (CI and the planned release workflow use it).

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
directly or put it on `PATH` as `nika-app`. Not built on Linux yet: check with `dpkg -L nika | grep desktop` after the
first CI build. The `.deb` dependencies (WebKitGTK 4.1, GTK 3, AppIndicator) are added by the bundler itself.

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

`.github/workflows/ci.yml` runs on push to `master` and `feat/**`, on pull requests and on manual dispatch, with a
read-only token and no secrets:

- `node`: `npm test` on macOS and Ubuntu (Node 22).
- `rust` (macOS and Ubuntu 22.04): in `app/src-tauri`, `cargo test --locked`, `cargo build --locked`, then `cargo audit`
  with `cargo-audit` 0.22.2 installed `--locked`.

CI does not build the bundles. It does not publish anything.

## Phase 6 (not done yet)

- **Homebrew formula** in the separate repo `qmpwwsd/homebrew-tap` (`Formula/nika.rb`): build the app from source
  (`depends_on "rust" => :build`), sign ad hoc, install the CLI and `nika.app`. Not written.
- **`release-linux.yml`**: a `workflow_dispatch` workflow on `ubuntu-22.04` that builds the `.deb` and the AppImage and
  creates a **draft** release. Not written.
- Every publish step (tag, release, tap pull request, workflow dispatch) needs its own approval from the owner.
