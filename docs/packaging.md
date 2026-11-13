# Building and packaging the nika app

Status: released ([GitHub releases](https://github.com/qmpwwsd/nika/releases)). On macOS the Homebrew formula in
`qmpwwsd/homebrew-tap` builds `nika.app` from source (see Homebrew formula); on Linux the `.deb` and the AppImage are
attached to each GitHub release (see Release build). You can still build from source as described below.

Decision record: [ADR 0009](adr/0009-packaging.md). Shell facts: [architecture](architecture.md). Threats:
[security](security.md).

## What you get

- Bundle id `io.github.qmpwwsd.nika`, display name `nika`, Rust binary `nika-app`.
- The app bundle carries the Node server files (`bin`, `src`, `public`, `templates`, `package.json`) as resources. It
  does **not** carry Node itself. `bin/package.json` (`{ "type": "commonjs" }`) keeps the extensionless launcher
  `bin/nika` CommonJS, so its version guard can run (checked on Node.js 10, 12, 18, 20.9 and 20.20; some versions refuse an extensionless
  file inside the root package's `"type": "module"` scope); the whole `bin/` folder ships in the npm package, the app
  bundle and the Homebrew formula.

## Runtime requirements (both systems)

- Node 22 or newer. The app looks for it like this: if `NIKA_NODE` is an absolute path to an executable file, that is the
  only candidate (too old is an error, not a reason to look further). Otherwise the candidates are, in order,
  `/opt/homebrew/bin/node`, `/opt/homebrew/opt/node/bin/node`, `/usr/local/bin/node`, on Linux
  `/home/linuxbrew/.linuxbrew/bin/node` (Linuxbrew), `~/.local/bin/node`,
  `~/.volta/bin/node`, then the newest install (by the version in the folder name, which must be exactly
  `<major>.<minor>.<patch>`, with a leading `v` for nvm and fnm) of mise (`~/.local/share/mise/installs/node/<ver>/bin/node`),
  fnm (`~/.local/share/fnm/node-versions/<v>/installation/bin/node`, on macOS only also under
  `~/Library/Application Support/fnm`), nvm (`~/.nvm/versions/node/<v>/bin/node`) and asdf
  (`~/.asdf/installs/nodejs/<ver>/bin/node`), and last `/usr/bin/node`. Each existing one is asked `node --version`
  (fixed argv, an environment of `HOME` alone, no shell, its own process group, 2 s limit; about 6 s in total across all candidates, spawn and read included and the kill after a timeout on top, after which the search ends with what it has read); the first that answers 22 or newer is used. A run that hangs is killed together with whatever it forked, and so is the run still going when the app quits. The lookup runs on a worker thread, so a slow candidate never freezes the window, the tray or Quit. When some answered
  but none is new enough, the error page says `Node.js is too old` and names the newest version seen; when none
  exists or none answers, it says `Node.js was not found`. Only folder listings and `--version` are used: no shell, dotfile or
  version-manager config is read. Anything else: set `NIKA_NODE`.
- tmux 3.2 or newer (the orchestrator's `new-session -e` needs it) and Claude Code, for the session window, spawn and orchestrator features.

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
find it by bundle id. With the Homebrew install, `nika app install` makes that copy for you (next section).

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
- **tmux** (3.2 or newer; Ubuntu 22.04 ships 3.2a and Debian 12 ships 3.3a) is a declared dependency of the `.deb` (`bundle.linux.deb.depends` is `["tmux (>= 3.2)"]`; the bundler adds the two
  libraries above itself). Node.js is deliberately not declared: apt would install the distribution's `nodejs`, which
  is older than 22 on current Debian and Ubuntu releases. The AppImage cannot declare dependencies, so tmux and Node 22+
  must already be installed (the README says so).
- Node 22+ (see above) and Claude Code.

### Desktop entry

`nika app` starts the Linux app with `nika-app` from `PATH`, then falls back to `gtk-launch io.github.qmpwwsd.nika`.
That needs a desktop entry named **`io.github.qmpwwsd.nika.desktop`** in `$XDG_DATA_HOME/applications`
(`~/.local/share/applications`) or in one of the `$XDG_DATA_DIRS` folders (`/usr/share/applications`). `nika doctor`
looks for the same file name.

Tauri's bundler always names its own entry `<productName>.desktop` (`nika.desktop`). The `.deb` therefore also
installs `/usr/share/applications/io.github.qmpwwsd.nika.desktop` (`bundle.linux.deb.files`), and the generated
`nika.desktop` is marked `NoDisplay=true` so the menu shows nika once. The AppImage carries only `nika.desktop`; run it
directly or put it on `PATH` as `nika-app`. Both entries need a `Categories` line: `appimagetool` refuses a desktop
file without one (`test/packaging.test.js` checks it).

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
| `nika`, `nika open` | first refreshes the copy nika made in `~/Applications` after an upgrade, then `open ~/Applications/nika.app` (that copy, by path) or, without one, `open -b io.github.qmpwwsd.nika`; if the app is missing, the browser dashboard | `nika-app` on `PATH`, then `gtk-launch io.github.qmpwwsd.nika`; if both fail, the browser dashboard |
| `nika app`, `nika open --app` | the same lookup; exit 1 with an install hint when the app is missing | the same |
| `nika app install` | copies the app of this install into `~/Applications` (ADR 0011); prints added, updated or already current | exit 1: the `.deb` or AppImage installs the desktop entry |
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
private session bus. `scripts/shell-probe.mjs` stands in for the Node server (the shell runs
`<NIKA_NODE> --max-semi-space-size=4 <root>/bin/nika serve --app`, so the script writes an executable `node` wrapper at
run time). The probe serves a page with a strict CSP; a real WebKitGTK window loads it and reports back. It checks that:

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

`.github/workflows/release-linux.yml` builds the Linux packages on Ubuntu 22.04. Clean build, no caches. It runs in two
ways:

- **Push of a tag `vX.Y.Z`**: the release path. The `build` job first runs `scripts/release-check.mjs`, which refuses the
  tag unless `package.json`, `app/src-tauri/tauri.conf.json` and `app/src-tauri/Cargo.toml` all carry `X.Y.Z` and
  `CHANGELOG.md` has a non-empty `## X.Y.Z` section. Then it builds. The `draft-release` job downloads the files, checks
  them against `SHA256SUMS` and creates a **draft** GitHub release named `nika X.Y.Z`, with that CHANGELOG section as
  notes and the `.deb`, the `.AppImage` and `SHA256SUMS` attached. It refuses if a release for the tag already exists.
  The script joins the CHANGELOG's wrapped lines (GitHub shows every newline of a release body as a line break), so
  each paragraph and list item is one line; code blocks, tables and quotes stay as written.
- **Manual dispatch** (Actions tab, or `gh workflow run release-linux.yml --ref <branch>`): a test build. Workflow
  artifacts only (`gh run download <run-id> -n nika-linux`), no release, even when dispatched on a tag.

Build steps: install the dependencies, `cargo install tauri-cli --version 2.12.4 --locked`,
`cargo tauri build --verbose --bundles deb,appimage` (verbose, so linuxdeploy and appimagetool errors are in the log),
check the `.deb` with `dpkg-deb` (Depends names WebKitGTK 4.1 and AppIndicator; the package contains the desktop entry
`io.github.qmpwwsd.nika.desktop` and the bundled `nika/bin/nika`), write `SHA256SUMS`, upload the `.deb`, the
`.AppImage` and `SHA256SUMS` as the artifact `nika-linux` (kept 14 days).

Permissions: the workflow token is read-only; only `draft-release` gets `contents: write`, and it checks out no code,
so nothing from the repository or its dependencies runs with write access. There are no secrets. The workflow never
publishes a release, never creates or moves a tag and never touches the tap. `test/release.test.js` asserts these rules
(official `actions/*` pinned by SHA, write access only in `draft-release`, no checkout there).

### Release procedure

1. On a branch: set the version in `package.json`, `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml` and
   `Cargo.lock` (`cargo update -p nika-app --offline` after the `Cargo.toml` edit), and rename `## Unreleased` in
   `CHANGELOG.md` to `## X.Y.Z — <date>`. `node scripts/release-check.mjs vX.Y.Z` must print the notes. Merge through a
   PR.
2. Tag the merge commit on `master` (`git tag -a vX.Y.Z -m "nika X.Y.Z"`) and push the tag. The workflow builds and
   creates the draft (about 10 minutes).
3. Review the draft on GitHub (notes, the three files) and publish it.
4. Update the tap: `url` to the new tag, `sha256` of the tag tarball
   (`curl -sL https://github.com/qmpwwsd/nika/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256`), commit `nika X.Y.Z`,
   push. Check with `brew update && brew upgrade --build-from-source nika`, then `brew services restart nika`.

Steps 2 to 4 each need the owner's approval.

## Homebrew formula

Lives in the separate repo `qmpwwsd/homebrew-tap` as `Formula/nika.rb`, which is the source of truth. The copy below
is its shape: a release changes only `url` (the new tag) and `sha256` (of that tag's tarball, which can only be
computed once the tag exists, so this copy cannot carry it). On macOS it builds `nika.app` from source (ad hoc signed by
the bundler, no Gatekeeper quarantine because it is built locally) and installs it in the keg; on Linux it installs the
CLI only (the desktop app comes from the `.deb` or AppImage). The browser-tier service is unchanged from 0.1.
The `depends_on "tmux"` line came with 0.3.2 and is in the tap since that release, so `brew install nika` installs
tmux too.

```ruby
class Nika < Formula
  desc "Local dashboard and control panel for Claude Code agents"
  homepage "https://github.com/qmpwwsd/nika"
  url "https://github.com/qmpwwsd/nika/archive/refs/tags/vX.Y.Z.tar.gz"
  sha256 "<sha256 of the vX.Y.Z tarball>"
  license "MIT"

  depends_on "node"
  depends_on "tmux"
  on_macos do
    depends_on "rust" => :build
  end

  def install
    # Build the app first: the bundle copies bin, src, public, templates and package.json as resources,
    # and libexec.install below moves them out of the build tree.
    if OS.mac?
      system "cargo", "install", "tauri-cli", "--version", "2.12.4", "--locked", "--root", buildpath/"tools"
      ENV.prepend_path "PATH", buildpath/"tools/bin"
      cd "app/src-tauri" do
        system buildpath/"tools/bin/cargo-tauri", "build", "--bundles", "app"
      end
      prefix.install "app/src-tauri/target/release/bundle/macos/nika.app"
    end

    libexec.install "bin", "src", "public", "templates", "package.json"
    (bin/"nika").write_env_script libexec/"bin/nika", PATH: "#{formula_opt_bin("node")}:$PATH"
  end

  def caveats
    return unless OS.mac?

    <<~EOS
      The desktop app is #{opt_prefix}/nika.app. Spotlight and Launchpad do not look in the
      Homebrew folder, so copy it to ~/Applications once (or press "Add to Applications"
      when the app asks):
        nika app install
      After `brew upgrade`, running `nika` refreshes that copy (quit and reopen nika if it
      was open).
      The read-only browser dashboard still runs with: brew services start nika
    EOS
  end

  service do
    run [opt_bin/"nika", "serve"]
    keep_alive true
    log_path var/"log/nika.log"
    error_log_path var/"log/nika.log"
    environment_variables PATH: std_service_path_env
  end

  test do
    assert_match "nika #{version}", shell_output("#{bin}/nika --version")
    (testpath/"claude/sessions").mkpath
    (testpath/"claude/projects").mkpath
    ENV["CLAUDE_CONFIG_DIR"] = testpath/"claude"
    ENV["NIKA_TMP_ROOT"] = testpath/"tmp"
    assert_match "\"groups\": []", shell_output("#{bin}/nika status --json --since all")
  end
end
```

Verified on 2026-11-08 (V5; macOS on Apple silicon, Homebrew rust 1.99.1): `brew upgrade --build-from-source` from the
tap builds `tauri-cli`, then the app bundle (about 3 minutes for the app), and installs it in the keg; `brew test`
passes. After `open "$(brew --prefix nika)/nika.app"` once (or `nika app install`, which also makes Spotlight and Launchpad find it),
`open -b io.github.qmpwwsd.nika` and `nika app` find it,
and a second launch focuses the running app. Two lessons from that run: the app must be built before
`libexec.install` moves the resource folders out of the build tree, and the build needs free disk space (on a full
disk the linker wrote a broken `cargo-tauri`, which then failed to execute with no other message). After an upgrade,
`brew services restart nika`: the running service still serves the removed old version's files.

Every publish step (tag, GitHub release, tap pull request, `release-linux.yml` dispatch) needs its own approval from
the owner.
