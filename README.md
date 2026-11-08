# nika

A local dashboard of every Claude Code agent on your Mac: live sessions (working, waiting for input, running a shell) and recently ended ones, grouped by git repository, with their subagents nested inside.

- Groups by repository; git worktrees fold under their main repository and carry a worktree tag.
- Shows model, branch, tmux pane, last prompt, start and last-activity time, and the `STATUS:` line of orchestrator spawn reports.
- Actions per agent: **Focus pane** (switches tmux to it), **Open in claude.ai** (Remote Control sessions), **Copy resume** (`cd … && claude --resume <id>`), **Report** (spawn report file).
- Read-only apart from Focus pane. Zero dependencies (Node stdlib). Binds `127.0.0.1` only.

## Install (browser dashboard)

```sh
brew install qmpwwsd/tap/nika
brew services start nika     # runs at login on http://127.0.0.1:3335
nika                         # opens the dashboard in your browser
```

This is the browser tier. It stays read-only: it lists agents and can only focus a tmux pane. The privileged features of
the [desktop app](#desktop-app-02-in-progress) are never available on `http://127.0.0.1:3335`.

## Commands

| Command | Does |
|---|---|
| `nika` / `nika open` | open the desktop app when it is installed, else the browser dashboard (the server must be running); see [CLI (0.2)](#cli-02) |
| `nika serve` | run the server in the foreground (what `brew services` runs) |
| `nika status` | print agents grouped by project; `--json`, `--since 24h\|7d\|30d\|all`, `--full` |
| `nika --version` | print the version |

## CLI (0.2)

`nika` and `nika open` start the desktop app when it is installed and fall back to the browser dashboard (the 0.1 behaviour: `nika serve` must be running). `nika open --app` fails with an install hint when the app is missing; `nika open --browser` skips the app. macOS looks the app up by bundle id (`open -b io.github.qmpwwsd.nika`); Linux runs `nika-app` from `PATH`, then `gtk-launch io.github.qmpwwsd.nika`.

| Command | Does |
|---|---|
| `nika app` | open the desktop app; fails with an install hint when it is missing |
| `nika serve --app` | the app tier's private server on a random port; the app starts it and talks to it over stdin/stdout, so it refuses a terminal on stdin (exit 2) |
| `nika projects list` | registered projects: key, name, rules state, folder |
| `nika projects add <dir>` / `remove <key>` | register a folder (stored as its real path) or unregister it; project files are never touched |
| `nika rules preview [dir]` | print the diffs of the orchestration rules nika would write into the project, plus warnings |
| `nika rules apply [dir]` | preview, ask `Apply? [y/N]`, then write; `--yes` skips the question (required without a terminal), `--overwrite-foreign` replaces a `rules/orchestration.md` nika did not write, `--gitignore` also adds `.claude/settings.local.json` to `.gitignore`. Backups go to nika's state folder, never into the repository; nika never runs git |
| `nika spawn <name> <model> <brief>` | start an agent in a tmux pane. Needs `$TMUX` (run it inside tmux) or `--session <name>`. `<brief>` is a file (at most 64 KB) or `-` for stdin. Options: `--project <dir>`, `--permission-mode <mode>` (`bypassPermissions` is refused), `--rc <prefix\|off>`, `--under <%pane>`. Prints pane, session and report path |
| `nika orchestrate [dir]` | create or reuse the project's tmux session and start the orchestrator pane. On a terminal it then attaches (inside tmux: switches the client to the session; otherwise `tmux attach-session`); `--detached`, or output that is not a terminal, only prints the session and pane |
| `nika doctor` | node, tmux, claude and app status, nika's config and state folders with their modes, and config warnings |

`[dir]` is optional: it defaults to the registered project that contains the current directory (an explicit `dir` must be the project folder itself). Register a folder first with `nika projects add <dir>`.

Exit codes: `0` ok, `1` runtime error, `2` usage, `3` refused (invalid input, limit reached, foreign rules file without `--overwrite-foreign`, declined confirmation).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NIKA_PORT` | `3335` | port on 127.0.0.1 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config dir |
| `NIKA_TMP_ROOT` | `/private/tmp/claude-<uid>` | Claude scratchpad root searched for spawn reports |
| `NIKA_REPORT_DIRS` | – | extra report dirs, colon-separated |
| `NIKA_TMUX` | first `tmux` on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` | tmux binary |

With `brew services`, set variables in the service environment (for example with `launchctl setenv`) or run `nika serve` yourself.

## What nika reads

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | live sessions: cwd, status, tmux pane, Remote Control id |
| `ps -A -o pid=,lstart=` | is the process still alive (and not a reused pid) |
| `~/.claude/projects/*/<session>.jsonl` | first 64 KB and last 256 KB only: cwd, branch, model, title, last prompt |
| `…/<session>/subagents/agent-*.meta.json` | subagent type, description, model, finished |
| `tmux list-panes -a` | pane titles (`[%id] name` convention) |
| `<scratchpad>/reports/<name>.session\|.md\|.rc` | agent role name, `STATUS:` line, report text |
| `<cwd>/.git`, `commondir` | repository root for grouping |

It never reads `*.key` files, credentials or `.env` files. The browser tier never writes anything; what the app tier and the CLI write is listed in [docs/architecture.md](docs/architecture.md#where-writes-happen).

A transcript with no user or assistant message (Claude Code sometimes leaves a one-line title stub) is not an agent: nika lists it only while its session is live.

## Security

**Assumption: a single-user Mac.** Browsers on other sites cannot read or drive nika, but any local process or any other user account on the same machine can open `http://127.0.0.1:3335` and read what it shows: last prompts, directories, branches, session ids, Remote Control links and report text. Do not run nika on a shared machine.

- Listens on `127.0.0.1` only and rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
- `POST /api/focus` needs JSON, a per-process token embedded in the page, and a same-origin `Origin`; the pane id must look like `%<n>` and exist in tmux; tmux runs via `execFile`, never a shell.
- Report files are looked up by session id in nika's own index; no request carries a file path.
- Files in agent-writable dirs are opened without following symlinks, never block on FIFOs, must be regular files owned by you, and are read with a size cap.
- Text from transcripts, reports and tmux is stripped of control and bidi characters before it reaches the page or your terminal.
- Strict Content-Security-Policy; all session text is rendered as text, never HTML.

The desktop app's privileged tier is a separate, locked-down server; its threat model and residual risks are in [docs/security.md](docs/security.md).

## Desktop app (0.2, in progress)

0.2 adds a desktop app (macOS and Linux, tray icon) with a privileged tier: session window with history and a live pane
mirror, spawning agents in tmux, starting the orchestrator, adding projects and applying orchestration rules. The
browser dashboard above stays read-only.

**The app is not released yet.** There is no Homebrew formula, download or package for it today. You build it from a
checkout of this repository.

You need Node 22 or newer, tmux and Claude Code on the machine. The app does not bundle Node.

### macOS

```sh
brew install rustup
export PATH="$(brew --prefix rustup)/bin:$HOME/.cargo/bin:$PATH"   # the Homebrew rustup is keg-only
rustup default stable
cargo install tauri-cli --version 2.12.4 --locked
cd app/src-tauri && cargo tauri build --bundles app
```

The bundle is `app/src-tauri/target/release/bundle/macos/nika.app`. Copy it to `~/Applications` and open it once. It is
signed ad hoc and not notarized, so a copy moved to another Mac is blocked by Gatekeeper (details in
[docs/packaging.md](docs/packaging.md)).

### Linux

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev      # Debian and Ubuntu build dependencies
cargo install tauri-cli --version 2.12.4 --locked   # with Rust installed through rustup
cd app/src-tauri && cargo tauri build --bundles deb,appimage
```

At runtime the app needs WebKitGTK 4.1 and AppIndicator (`libayatana-appindicator3-1`) for the tray icon.

### Run it

```sh
nika app      # or just: nika
```

`nika` opens the app when it is installed and falls back to the browser dashboard. A tray icon appears (no Dock icon on
macOS). Closing the window only hides it. **Quit nika** in the tray menu stops the app and its private server; your tmux
sessions and agents keep running. "Start at login" is off by default.

More: [docs/packaging.md](docs/packaging.md) (build details, signing, Linux packages),
[docs/security.md](docs/security.md) (threat model, residual risks, how to report a vulnerability),
[docs/architecture.md](docs/architecture.md) (processes, boot sequence, module map). Contracts:
[docs/contracts/api-app.md](docs/contracts/api-app.md); decisions: [docs/adr/](docs/adr/); progress:
[CHANGELOG.md](CHANGELOG.md).

### Using the app

- **Dashboard.** One line says how many agents need you, are waiting or are working. Agents that need you are listed first
  under "Waiting on you", then every project with its agents (needs you, waiting, working, ended). Filter by text, change the
  time window, show or hide ended agents. Click a row to open its session window.
- **Add a project.** The sidebar "+" (or `Mod+O`) opens the native folder picker. The project page notes when the folder is
  not a git repository. A new project has no orchestration rules yet: use **Apply rules** to preview the exact diffs, then
  confirm. nika writes only the files shown in the preview, keeps a backup outside the repository and never runs git.
- **Start an orchestrator / spawn an agent.** From a project: **Start orchestrator** opens its tmux session and pane;
  **Spawn agent** opens a side sheet (name, model, brief up to 64 KB, permission mode, pane placement). A project at its
  agent limit shows why and what to do. `bypassPermissions` is not offered.
- **Settings** (`Mod+,`). Appearance (System, Light, Dark), model names per role, Remote Control, default permission mode and
  pane placement, the per-project agent limit, plugins per project and the rules template. One Save button; invalid fields
  are marked in place.
- **Keyboard.** `Mod+1` dashboard, `Mod+,` settings, `Mod+O` add project, `Mod+F` filter, `Mod+[` (macOS) or `Alt+Left`
  (Linux) back to the dashboard, `Mod+Enter` confirm the open dialog or save settings. `Mod` is Command on macOS and Control on Linux.

The browser dashboard at `http://127.0.0.1:3335` shows the same list without any of these controls; its only action is
**Focus pane**.

## Development

```sh
npm test                  # node --test, no dependencies
node bin/nika serve       # http://127.0.0.1:3335
node bin/nika status
(cd app/src-tauri && cargo test --locked)   # the desktop shell, needs Rust
```

## Uninstall

```sh
brew services stop nika
brew uninstall nika
```

## License

MIT
