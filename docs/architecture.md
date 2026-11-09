# nika architecture

nika is a local dashboard and control panel for the Claude Code agents on one machine, grouped by git repository. The
code is Node (stdlib only, no npm dependencies) plus a thin Rust desktop shell (Tauri v2).

Related: [contracts](contracts/api-app.md) (routes, stdio protocol, schemas), [ADRs](adr/), [security](security.md),
[packaging](packaging.md), [rules template](templates.md), [design spec](design/spec.md).

## Processes

| Process | Started by | Role | Ends when |
|---|---|---|---|
| **nika app** (Tauri shell, binary `nika-app`) | you, `nika` / `nika app`, optionally at login | Tray icon and menu, one webview window, the native folder picker. Supervises the private server. Opens `claude.ai` links in the system browser. | you choose Quit nika in the tray |
| **private server**, `node bin/nika serve --app` | the app, as a child with piped stdio | The read routes plus `/api/app/*` on `127.0.0.1:<random port>`. | its stdin closes |
| **service**, `nika serve` on `127.0.0.1:3335` | `brew services` or systemd (optional) | The read-only browser dashboard. Its only action is tmux focus. | you stop the service |
| **agents** (`claude` in tmux panes) | you, `nika spawn`, "Start orchestrator" | The real work. nika never owns, signals or kills them. | you or Claude end them |

## Two tiers

| Tier | Process | Routes | Can do |
|---|---|---|---|
| Browser (read-only) | `nika serve` on :3335 | `/`, static files, `/api/health`, `/api/agents`, `/api/report/:id`, `POST /api/focus` | list agents, focus a tmux pane |
| App (privileged) | `nika serve --app`, child of the app | all of the above plus `/api/app/*` | history, pane mirror and input, session control (mode, answer a prompt, slash commands, models, End), spawn, start orchestrator, add project, settings, apply rules, the app copy in `~/Applications` (macOS) |

`/api/app/*` is not mounted on :3335 (404). The page shows privileged controls only when `/api/app/me` answers. See
[ADR 0004](adr/0004-two-tiers.md).

## Boot sequence (desktop app)

1. The single-instance guard runs first. A second launch focuses the existing window and exits.
2. The shell finds Node: `NIKA_NODE` (an absolute path), else the first `node` in `/opt/homebrew/bin`,
   `/opt/homebrew/opt/node/bin`, `/usr/local/bin`, `~/.local/bin`, `/usr/bin`.
3. The shell starts `node bin/nika serve --app` with piped stdio. The server files come from the app bundle
   (`Contents/Resources/nika/{bin,src,public,templates,package.json}` on macOS). The child env is cleared, then set to
   `PATH`, `HOME`, `NIKA_APP=1`, plus `CLAUDE_CONFIG_DIR`, `NIKA_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
   `TMUX_TMPDIR`, `LANG`, `LC_ALL` and `LC_CTYPE` when they are set.
4. The shell reads 32 bytes from `/dev/urandom`, encodes them as base64url and writes one `hello` line to the child's
   stdin. That is the only place the secret travels.
5. The server refuses a terminal on stdin, checks the `hello`, listens on `127.0.0.1:0` and prints a `ready` line with
   the port.
6. The shell opens the webview at `http://127.0.0.1:<port>/`. An `initialization_script`, guarded by
   `location.origin`, defines the secret as a non-enumerable global.
7. `public/api.js` copies the secret into a module constant, deletes the global and sends it as `X-Nika-App` on every
   privileged request.
8. While running, the server sends a `status` line every 3 s (counts for the tray) and relays the folder picker with
   `pick-folder` / `folder`.
9. If Node is missing, does not send `ready` within 10 s, or exits, the webview shows the local error page
   (`app/src-tauri/ui/error.html`, served as `tauri://localhost/error.html?reason=…`). Its Retry link
   (`tauri://localhost/retry`) is intercepted by the shell, which starts a new child with a new secret and a new port.
10. Quit: the shell closes the child's stdin, sends SIGTERM after 2 s and SIGKILL after 4 s. tmux sessions are never
    touched. Closing the window only hides it.

The stdio protocol (`proto` 1, JSON lines, shapes, limits) is fixed in
[`contracts/api-app.md` section 5](contracts/api-app.md) and [ADR 0003](adr/0003-stdio-protocol.md). The secret flow
is [ADR 0002](adr/0002-private-server-stdin-secret.md).

The shell is deliberately small (ADR 0001): tray, one window, folder picker, "start at login", child supervision. The
webview may load only its own origin; no Tauri capability is granted to it.

## Session control (0.3)

The permission mode, permission prompts, slash commands and End are read from and typed into Claude's TUI in the tmux
pane; Claude Code has no other channel into a running interactive session ([ADR 0010](adr/0010-session-control-through-the-tui.md)).

1. `mirror.js` captures the pane; `mode.js` reads the mode from the last non-blank row and the permission prompt from
   the bottom 15 rows. Unrecognized text is `unknown` / `null`, so a control hides instead of guessing.
2. `api-app.js` adds `mode`, `modeConfirmed` and `prompt` (with its `sig`) to the capture, and serves
   `GET /api/app/modes` for the dashboard's mode tags. While a prompt or dialog covers the footer, they show the last
   mode read from that pane (or the launch mode of a pane nika started) as unconfirmed; that value is display only.
3. `session-control.js` runs the four actions (`/mode`, `/answer`, `/command`, `/end`): a fresh capture first, one
   action per pane at a time, keys only through `keys.js`. Bad input is a 400; a screen that does not match is a 409; either way nothing is typed.
4. The page draws what the routes return (`session.js` with `modes.js`, `quick-actions.js`, `palette.js`,
   `end-dialog.js`); every string is fixed copy or set with `textContent`.

Routes: [`contracts/api-app.md` section 3](contracts/api-app.md). Parsed screen text:
[`contracts/claude-tui.md`](contracts/claude-tui.md). Threats: T22, T23 and T26 in [security](security.md).

## Module map

### `src/` (Node, ES modules)

| File | Does |
|---|---|
| `actions.js` | The browser tier's only side effects: focus a tmux pane, read an indexed report. |
| `api-app.js` | Router and guard for `/api/app/*`. Validates, picks the module, sends its `{ status, body }`. Keeps the per-pane held mode and vim memory and builds the session controller. |
| `appcopy.js` | The macOS copy of `nika.app` in `~/Applications` (ADR 0011): state, install, dismiss and the refresh after an upgrade. Fixed target, source only from this install, built in a temp folder and swapped in with rename. |
| `appio.js` | The app-tier process: stdio handshake, private server, status feed, folder picker relay. |
| `cli.js` | The `nika` command: `serve`, `open`, `app` (`app install`), `status`, `projects`, `rules`, `spawn`, `orchestrate`, `doctor`, `_run-agent`. |
| `commands-builtin.js` | The curated built-in slash commands for the palette, from `claude-tui.md` section 4. Nothing is read from disk. |
| `config.js` | Defaults from the environment, port and `--since` parsing, `findTmux`, `findClaude`. |
| `diff.js` | Unified diff for the rules preview. |
| `exec.js` | `makeExec()`: `execFile` with a timeout and optional stdin input. |
| `fsafe.js` | Safe reads of agent-writable files (no symlink, no FIFO, owned by you, size cap). |
| `fwrite.js` | The only writer: atomic, symlink-safe writes and backups. |
| `ids.js` | Id shapes (pane, project key, agent name, model, command name, session, key names) checked at every boundary. |
| `keys.js` | Keystrokes and bracketed paste into a tmux pane. |
| `mirror.js` | `capture-pane` output turned into rows of whitelisted styled spans; a `fresh` capture skips the 250 ms cache for the control actions. |
| `mode.js` | Pure parsers over mirror rows: the permission mode from the footer and the permission prompt. They fail closed. |
| `model.js` | `collect()`: merges every source into agent records and groups them by project. |
| `models.js` | The static model catalog behind the model dropdowns (`GET /api/app/models`). |
| `orchestrate.js` | Starts a project's orchestrator in a tmux session. |
| `paths.js` | nika's own config and state dirs (XDG). |
| `rules.js` | Renders, previews, hashes and applies the orchestration rules to a project. |
| `server.js` | The HTTP server both tiers share: Host check, static files with the CSP, the 0.1 routes, a mount hook for the app tier. |
| `session-control.js` | The four controls on a live pane: switch the mode, End, run a slash command, answer a prompt. One lock per pane, keys only through `keys.js`, fail closed, never kills. |
| `spawn.js` | `spawnAgent()` splits a pane; `runAgent()` is the `_run-agent` wrapper that runs `claude` with the safety flags. |
| `store.js` | The validated `config.json` and the project registry. |
| `text.js` | `clean()` and `cleanBlock()`: strip controls and bidi marks from agent-controlled text. |
| `tmuxerr.js` | Maps a failed tmux call to a contract error body. |
| `util.js` | `mapLimit`: bounded concurrency. |

### `src/collect/` (read-only sources)

| File | Reads |
|---|---|
| `commands.js` | Slash commands and skills for the palette: the built-in list plus the frontmatter (first 4 KB, never the body) of command and skill files in the user, project and plugin folders (app tier). |
| `history.js` | A session transcript, paginated from disk, newest page first (app tier). |
| `plugins.js` | Installed Claude Code plugin names; `listPluginDirs` also returns each plugin's `installPath`, only when it resolves inside the plugins cache. |
| `projects.js` | Groups a working directory under its git repository; worktrees fold under the main repository. Never runs git. |
| `registry.js` | The live session registry, one `<pid>.json` per running Claude Code process. |
| `reports.js` | Spawn report files (`.session`, `.md`, `.rc`) in the scratchpad and in nika's own report dirs. |
| `subagents.js` | In-process subagents of a session. |
| `tmux.js` | tmux panes (`list-panes -a`), pane titles and the `@nika-role` option. |
| `transcripts.js` | Session transcripts: only the head and tail are read; results are cached by path, mtime and size. |

### `public/` (the page, plain browser modules, strict CSP)

| File | Does |
|---|---|
| `index.html`, `session.html` | The main page and the session window. |
| `tokens.css`, `app.css`, `session.css` | Design tokens and styles (light, dark, system). |
| `api.js` | The only client of the app tier: takes the secret once and sends `X-Nika-App`. In the browser tier it refuses to run. |
| `app-copy.js` | The Add to Applications banner: which banner `appCopy` shows and its fixed copy. Pure; the two POSTs live in `project.js`. |
| `app.js` | Main page: shell, dashboard (in the app tier: mode tags, the row menu's End and the Add to Applications banner), router, the poll loop and the Keyboard shortcuts keys. Runs in both tiers. |
| `ui.js` | Shared state and widgets for the main page. |
| `dom.js` | `h()`: builds DOM with `textContent`, never parses markup. |
| `end-dialog.js` | The End-session dialog, shared by the session window and the dashboard row menu. |
| `modes.js` | Permission modes in the UI: labels, icons, the switcher's state and the dashboard's mode map and tag. |
| `models-ui.js` | The model dropdown shared by the session window, Settings and the spawn sheet: groups from the catalog, the Custom ID field and its `MODEL_ID` check. |
| `palette.js` | The slash-command palette's rules and copy (ranking, views, insertion). No DOM, no requests. |
| `project.js` | App tier only: projects, add project, start orchestrator, project view, spawn sheet, apply-rules dialog, the poll of `/api/app/modes`, the Add to Applications install and dismiss requests. |
| `quick-actions.js` | The quick actions', prompt buttons', End dialog's and Shell mode's rules and fixed copy. No DOM, no requests. |
| `settings.js` | App tier only: the settings screen. |
| `session.js` | App tier only: the session window (history, live mirror, composer, mode switcher, quick actions, prompt buttons, Shell mode, command palette). |
| `shortcuts.js` | The Keyboard shortcuts window and the key rules around it (`?`, Mod+/, Back). Static copy, both tiers. |
| `mirror-render.js` | Pane-mirror helpers: render model, cursor, key handling. Re-validates every value. |

Also: `bin/nika` (launcher), `templates/` (generic rules, brief and guard prompt, written from scratch), `app/src-tauri`
(the Rust shell), `test/` (Node tests, synthetic fixtures), `docs/`.

## Data and storage

nika's own files follow XDG ([ADR 0008](adr/0008-xdg-config-state.md)). Folders are 0700, files 0600.

| Path | Holds |
|---|---|
| `${NIKA_CONFIG_DIR or XDG_CONFIG_HOME or ~/.config}/nika/config.json` | Settings and the project registry. Validated on load; garbage falls back to defaults with a warning. |
| `…/nika/templates/<name>.md` | Rule templates you imported locally. |
| `${XDG_STATE_HOME or ~/.local/state}/nika/projects/<key>/reports/` | Per spawned agent: brief, settings, session id, pane, exit code, report. |
| `${XDG_STATE_HOME or ~/.local/state}/nika/backups/<key>/<ISO>/` | Byte-for-byte copies taken before "apply rules" overwrites a file; the last 10 folders per project are kept. Never inside a repo. |

`<key>` is the first 16 hex characters of `sha256(realpath(project folder))`. A request never carries a path; projects
are referenced by key.

Claude Code's own files (`sessions/`, `projects/`) are read, never written. The exact read list is in
[`rules/project-rules.md`](../rules/project-rules.md) section 4.

### Where writes happen

Only through `src/fwrite.js`, with one exception (the app copy, below): real user-owned folders, targets absent or
regular single-link files, an O_EXCL temp file with fsync, then rename. nika writes:

- its own config and state files (above);
- into a registered project, only after a diff preview, your confirmation and a hash check: `rules/orchestration.md`,
  one `@rules/orchestration.md` line in `CLAUDE.md`, `enabledPlugins` in `.claude/settings.local.json`, and,
  if you opt in, one `.gitignore` line;
- macOS only, on `nika app install`, the app's Add/Update button, or a launch command refreshing a copy nika made
  earlier: `~/Applications/nika.app`, a `ditto` copy of the app that came with this install. Fixed target, never
  `/Applications`; it is replaced only when it is a real folder you own that is nika's bundle, built in a temp folder
  next to it and swapped in with rename (`src/appcopy.js`; its small state marker goes through `fwrite.js`).
  Policy: [ADR 0011](adr/0011-app-copy-in-applications.md).

nika never runs `git add`, `commit` or `push`. Policy: [ADR 0006](adr/0006-project-write-policy.md).
