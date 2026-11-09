# Changelog

## Unreleased

Orchestrator (desktop app):

- **Resume your orchestrator.** nika now remembers each project's orchestrator by its session id. Start orchestrator saves the
  session it starts, so after it ends the project's first button says **Resume orchestrator** and continues that same
  conversation in tmux. If its transcript has been deleted, the project page says so ("The saved orchestrator is gone"), and
  Start orchestrator starts a new one (it also forgets the old one by itself).
- **Use an orchestrator you already run.** A session's row menu has **Set as orchestrator** (for a session that is running in
  tmux, or one that has ended), **Resume as orchestrator** (for an ended one) and **Stop using as orchestrator**. nika refuses
  while another orchestrator of the project is running, and for agents nika started. Stop using only forgets the choice: a
  running session keeps running.
- The orchestrator now has a badge next to its name on the dashboard, the project page and the session window:
  "orchestrator", or a muted "orchestrator" for a saved one that has ended. Narrow rows show "orch".
- Row menus can show an item that is off, with the reason as its tooltip; clicking it says why.
- API: `PUT` and `DELETE /api/app/projects/:key/orchestrator` are new; each project in `GET /api/app/projects` gains
  `orchestrator`; `POST /api/app/orchestrator/start` can answer `cleared: "gone"`. See `docs/contracts/api-app.md`.

Models per project (desktop app):

- Each project can use its own model for any of the four roles (Orchestrator, Reasoner, Builder, Scout). On the project page,
  **Project setup** has a new **Models** block that lists the roles this project sets, and **Choose models…** opens a window
  with one menu per role: **Use default** (the model from Settings) or a model from the list, or a Custom ID. Save is on
  only while something changed.
- nika uses these models when it starts or resumes the project's orchestrator, in the Roles table of `rules/orchestration.md`,
  and in the spawn sheet's Roles list (marked "(this project)"). Sessions that are already running keep their model, and the
  rules file changes only when you apply rules, so the toast after saving says so.
- API: `PUT /api/app/projects/:key/config` takes exactly one of `{ plugins }` or `{ models }`, and `GET` returns both. See
  `docs/contracts/api-app.md`.

Sub-orchestrators and limits (CLI and API; the screens follow):

- **Three levels.** The main orchestrator can start sub-orchestrators, and a sub-orchestrator can start agents of its own.
  `nika spawn <name> <model> <brief> --role orchestrator` starts a sub-orchestrator; run from an orchestrator's pane, the
  new session becomes its child. An agent cannot start other agents, and a sub-orchestrator cannot start another
  sub-orchestrator: nika answers "can't start a sub-orchestrator" (409 `depth`) and starts nothing.
- A sub-orchestrator can run only `nika spawn` and `nika status`; the other nika commands are on its deny list (advisory, like
  the agents' list). It gets its own guard prompt, written for orchestrating.
- **Limits per parent and per project.** **Agents per orchestrator** (Settings, 1 to 8) now bounds the agents and
  sub-orchestrators under each parent, and a project as a whole runs at most three times that number, never more than 24.
  A refusal says which limit it hit (409 `limit`, with `scope`, `running` and `max`).
- `rules/orchestration.md` has a new **Sub-orchestrators** section (template version 2): apply rules to a project to get it.
- Every orchestrator nika starts, resumes or adopts is now tagged for its project (`@nika-agent <key>/orchestrator`,
  `@nika-depth 1`). An orchestrator started by 0.3 still counts, as long as it is in the project's own tmux session and window.
- Setting a session as the orchestrator is refused for a sub-orchestrator nika started, like for agents.
- API: `POST /api/app/spawn` takes `role` (`agent` or `orchestrator`) and `parent` (a pane id); agents in
  `GET /api/agents` (both tiers) gain `parent`, `depth` and `children`; the role of a
  sub-orchestrator is `sub-orchestrator`. See `docs/contracts/api-app.md` and `docs/adr/0013-nested-orchestration.md`.

## 0.3.4 — 2026-11-09

Session window (desktop app):

- A **Transcript** button at the left of the terminal's header (or Cmd+Shift+H, Ctrl+Shift+H on Linux) hides the
  transcript so the terminal has the full width, and shows it again. It is on windows wider than 1000 px; narrower ones
  keep their Terminal and Transcript tabs. The choice is remembered until nika quits.
- Clearer messages when End, Compact, Clear, Model or Rewind cannot type into Claude's input. A draft in the box now says
  "Claude's input has a draft. Send or clear it in the terminal, then try again."; when nika cannot find the input box
  at all (a menu is open, say) it says so and asks you to close the menu, instead of claiming the input has text. In both
  cases nothing is typed. (API: 409 `input-unreadable` is new next to `input-not-empty`.)

Plugins per project, and Settings (desktop app):

- Plugins are chosen on each project's page. The Plugins card there is now **Project setup**; **Choose plugins…** opens a
  window with a filter, a count and one scrolling list (it no longer jumps to Settings, and long plugin names wrap instead of
  overlapping). Ticked plugins are listed first; a plugin you ticked that is no longer installed is marked "(not
  installed)" and can still be unticked. Plugins are written to `.claude/settings.local.json` only when you apply rules,
  as before.
- Settings now holds only the defaults for every project. The plugins section is gone from it, so saving Settings can no
  longer overwrite a project's plugins.
- The Save and Discard bar in Settings appears only after you change something, and goes away when you put the values
  back. While it is hidden, Enter and Cmd/Ctrl+Enter save nothing.
- Existing choices carry over: nika reads the plugin lists from their old place in `config.json` and writes the new shape the
  next time it saves. Going back to 0.3.3 loses the lists only after 0.3.4 has saved. Unticking every plugin removes the
  list, and applying rules then leaves the project's `enabledPlugins` as they are.
- API: `GET` and `PUT /api/app/projects/:key/config`; `PUT /api/app/settings` refuses `perProject`
  ([ADR 0012](docs/adr/0012-per-project-config.md)).

Memory (desktop app):

- The app's server uses about half the memory: the desktop app now starts it with a smaller young-generation heap
  (`--max-semi-space-size=4`). On 200 synthetic sessions over 5 minutes it held about 195 MB before (macOS footprint
  160 MB) and about 90 MB after (footprint 60 MB), with the same history speed.
- The parsed-transcript and command-list caches are capped, and a session window keeps at most 500 transcript entries (it
  was 600; the oldest leave only while you follow the live end, never under a reader who has scrolled up).

## 0.3.3 — 2026-11-09

Session window keys and the macOS window (desktop app):

- Keys in the message box: Esc, Ctrl+C and Shift+Tab go to Claude, and so do the arrow keys and Enter when the box is
  empty. Ctrl+C stops Claude's turn the way Stop does, only while Claude works; with text selected it stops nothing (it
  copies on Linux; on macOS Cmd+C copies). Shift+Tab presses Shift-Tab (the next permission mode), never before the
  window has read the pane and never while Claude asks you something. Tab still moves focus; Ctrl+Shift+Tab moves focus
  back.
- The row of key buttons under the message box is gone; one short hint line names the keys, and the Keyboard
  shortcuts window lists them all.
- The permission-mode switcher moves from the header to just under the message box, with its labels at every width.
  The header keeps the mode tag.
- macOS: nika is in the Dock and in Cmd+Tab while its window is open, and only in the menu bar once you close the
  window. Full screen: the green button, View > Enter Full Screen or Ctrl+Cmd+F. Closing a full-screen window leaves
  full screen, then hides it.

## 0.3.2 — 2026-11-09

Missing and old dependencies (Node.js, tmux):

- A Node.js older than 22 now gets a clear message instead of a crash: `nika` prints `nika: needs Node.js 22 or newer; this
  is <version>.` with a hint and exits 1, and the desktop app shows "Node.js is too old" with the version it found. A
  missing Node.js still shows "Node.js was not found".
- The desktop app finds Node.js installed with Volta, mise, fnm, nvm and asdf (it uses the newest install of each), not only
  in the Homebrew and system folders. It asks each candidate `node --version`, with only `HOME` in its environment, a 2 second
  limit each and 6 seconds in total, and uses the first that is 22 or newer. `NIKA_NODE`, when set to an executable file, is the only candidate.
  The search runs in the background, so a slow or hanging candidate cannot freeze the window or the tray, and a hanging one
  is killed together with anything it started (so is one still running when you quit). On Linux it also looks in Linuxbrew's prefix; the macOS fnm folder is
  looked at on macOS only.
- `nika` can now print that message on the old Node.js versions it was checked on (10, 12, 18, 20.9 and 20.20): the launcher
  is now CommonJS (`bin/package.json`), because some versions (for example 20.9) refuse an extensionless file inside a
  `"type": "module"` package before any code runs.
- The "tmux not found" banner and `nika doctor` name the install command for your system: `brew install tmux` on macOS,
  `sudo apt install tmux` on Linux, and no command elsewhere.
- Packages: the Linux `.deb` now depends on tmux (not on `nodejs`: apt would install an older one than 22), and the
  Homebrew formula in `docs/packaging.md` gains `depends_on "tmux"` (the tap gets it at the next release). The AppImage
  cannot declare dependencies. The Linux release build now fails if the built `.deb` does not depend on tmux. The README lists
  the requirements and how to get Node.js 22 on Linux.
- Docs: README screenshots of the desktop app (light and dark) and the app icon in the title.

## 0.3.1 — 2026-11-09

Dashboard fixes (desktop app; the "Show ended" fix also applies to the browser dashboard on :3335):

- Fix: "Show ended" now hides and shows the ended agents on the dashboard. Unchecked (the default), ended agents are not drawn,
  and a repository with only ended agents shows its header and "No live agents."; checked, every repository with ended agents
  shows its "Ended (n)" section open (one you fold by hand stays folded until the box changes). The project view is unchanged.
- Fix: the sidebar's Projects list is no longer blank without projects: it says "No projects yet." and how to add one, and a
  new Detected list shows repositories that run live agents but are not projects, each with an "Add project" button (the same
  folder picker as before) and a link to its group on the dashboard.
- Fix: the filter's no-match line says when Show ended hides the only matches.

## 0.3.0 — 2026-11-09

Session control (desktop app; the browser dashboard on :3335 stays read-only):

- Permission modes: the session window shows Claude's mode in a tag, a frame along the top and the message-box edge
  (Manual, Accept edits, Plan, Auto, Bypass, Don't ask, or "Mode ?" when nika cannot read it) and switches between
  Manual, Accept edits, Plan and Auto. It switches only while Claude waits for you, never to Bypass or Don't ask, and
  announces each change. While a question covers Claude's footer, the tag shows the last known mode as unconfirmed.
- Prompt buttons: when Claude asks for permission, the session window shows one button per option and an Esc button
  (cancel, same as No). An option that mentions bypass has no button; answer it in the terminal.
- Quick actions: Stop (while Claude works), Compact, Clear (asks first), Model, Rewind and End session. Compact, Clear,
  Model and End type into Claude's input only when it is empty and press Enter only when it reads exactly that
  command; otherwise they refuse ("Claude's input has text; clear it first." when it holds a draft) and leave your draft alone.
  Stop works in vim input mode and has its own route, `POST /api/app/pane/:id/stop`: the first Esc only leaves insert
  mode, so Stop (and End, when Claude is busy) sends a second Esc when the first one did not end the turn. It sends
  nothing when Claude is idle, and gives a clear reason when it refuses (a question is open, Claude is already waiting,
  the input mode is unreadable, or another window is already stopping). A command in flight does not block it. Rewind
  types `/rewind` and Enter through the command route (same rules as Compact) instead of Esc Esc, so it no longer
  depends on the message box being empty in nika.
- End session: asks first, presses Esc when Claude is busy or asking (which answers No), then types `/exit`. It never
  kills the pane. Also in the dashboard row menu.
- Shell mode: a toggle in the message box that sends your line through Claude's `!` mode, then turns itself off.
- Command palette: `/` or the Commands button lists Claude's built-in commands and the commands and skills from
  `~/.claude`, the project and installed plugins, each with a source tag. nika reads only the first 4 KB of each file.
- Dashboard: rows with a live pane carry the same mode tag, and the row menu has End session.
- Model dropdowns in Settings, the spawn sheet and the session's Model action list the current models, aliases (`best`,
  `opusplan`, `opus[1m]`, `sonnet[1m]` and more) and older models, with a Custom ID field.
- Back is a button with a shortcut (`Cmd+[` on macOS, `Alt+Left` on Linux) in the project view and the session window.
- Keyboard shortcuts window: `?` or `Cmd+/` (`Ctrl+/` on Linux; the browser dashboard has only that), or the Keyboard
  shortcuts button. Settings, Appearance has a Single-key shortcuts switch that turns `?` off.
- Add to Applications (macOS): `nika app install` copies the app into `~/Applications` so Spotlight and Launchpad find
  it, and the dashboard offers the same once. After `brew upgrade`, `nika`, `nika open` and `nika app` update a copy
  nika made (the app also offers Update app), and `nika doctor` reports it. nika never writes to `/Applications` and
  never replaces anything in `~/Applications/nika.app` that is not nika's own bundle.
- Send and Shell wait while Claude asks for permission: nothing goes to the pane, the text stays in the box and a line says
  to answer with the buttons or in the terminal (or, when there are no buttons, in the terminal or with Type into pane).
  The Enter and Shift-Tab chips are off too. A prompt that mentions bypass has no answer buttons; the keys route's refusal
  shows a fixed line.
- The session window follows the pane to its new session after `/clear`, when exactly one live session has the pane.
- Switching modes reports a stop in Bypass, or a footer nika could not read after a press, as an alert; a press that
  leaves the mode unchanged says so calmly ("The mode didn't change; try again or use the terminal."); with no readable
  mode the Shift-Tab chip is gone (use the terminal).
- Small fixes: the Back button names the project only when you came from one; the claude.ai link and the shortcuts button
  stay together in the header; the shortcuts window's tables scroll inside their own box at 320 px; a dialog opened from a
  menu item returns focus to the menu's button; the passthrough key reads `⌃]` on a Mac; the message box area no longer
  widens the session window past 320 px.
- Bypass guard: nika's keys route refuses Enter, Shift-Tab, a digit or a paste while a permission prompt that mentions bypass is
  on screen (the question included); answer those in the terminal. When Claude shows something nika cannot read and it
  mentions bypass, the refusal says so ("nika can't tell what Claude is showing; use the terminal."). The prompt buttons read the whole prompt, not only
  the option: the capture's `prompt` carries `bypass`, the same window test the answer route applies, and the page draws no
  answer button when it is true (an answer the route still refuses with 400 says to use the terminal and locks that question).
- Switching modes never stops quietly in Bypass: it keeps pressing while the footer reads Bypass even if Claude looks
  busy, retries once when the key limit hits, and otherwise reports that Claude is still in Bypass.
- App tier API (never mounted on :3335): `GET /api/app/modes`, `/commands` and `/models`; `POST /api/app/pane/:id/mode`,
  `/answer`, `/command`, `/stop` and `/end`; `POST /api/app/app-copy`. The capture gains `mode`, `modeConfirmed` and `prompt`,
  `/api/app/me` gains `appCopy`, and the config gains `ui.singleKeyShortcuts`. `MODEL_ID` accepts `best`, `opusplan` and
  the `[1m]` suffix.
- Docs: ADR 0010 (session control through the TUI) and 0011 (app copy), `docs/contracts/claude-tui.md` (the Claude Code
  screen text nika parses, checked against 2.1.319), threats T22, T23, T26 and T33 in `docs/security.md`.

Other:

- Release notes: `scripts/release-check.mjs` joins the CHANGELOG's hard-wrapped lines, so a draft release no longer
  shows a line break in the middle of each sentence (GitHub renders every newline of a release body as one). Code
  blocks, tables, quotes and list markers are kept; `test/release.test.js` covers both directions.

## 0.2.1 — 2026-11-08

No app changes. This release brings the tag in line with the 0.2.0 Linux packages and adds release automation.

- Packaging: the tag now contains the `Categories` line of the hidden `nika.desktop` entry, which the 0.2.0 Linux
  packages were already built with (0.2.0's "Release fixes").
- Releases: pushing a tag `vX.Y.Z` builds the Linux packages and creates a draft GitHub release with them, the notes
  taken from the tag's CHANGELOG section. `scripts/release-check.mjs` refuses a tag that does not match `package.json`,
  `tauri.conf.json` and `Cargo.toml` or has no CHANGELOG section. Only the draft job can write, and it runs no repository
  code. Manual dispatch stays a test build. Publishing stays manual. Procedure in `docs/packaging.md`.
- Tests: `test/release.test.js` covers the release check and asserts the workflow rules (official actions pinned by
  SHA, write access only in `draft-release`, no checkout there). `test/cli.test.js` reads the expected `--version`
  from `package.json`, so a version bump needs no test edit.
- Docs: `docs/packaging.md` shows the Homebrew formula as a template (`url` and `sha256` change with every release; the
  tap's file is the source of truth) and has the release procedure.

## 0.2.0 — 2026-11-08

Phase 1 (contracts and foundations):

- `docs/contracts/api-app.md`: privileged API, shell ↔ server stdio protocol, config/state schema, CLI table, tmux argv shapes.
- `docs/adr/0001`–`0009`: Tauri shell, private server + stdin secret, stdio protocol, two tiers, pane mirror, project write policy, spawn via tmux, XDG config/state, packaging.
- `rules/project-rules.md`: two tiers, Rust crates approval, app-tier reads, writes, agent control, desktop shell, hygiene, `master` default branch.
- `src/ids.js`: `PROJECT_KEY`, `AGENT_NAME`, `MODEL_ID`, `TMUX_SESSION`, `PLUGIN_NAME`, `RC_PREFIX`, `KEY_NAME`, `PERMISSION_MODES`, `PANE_PLACEMENTS`.
- `src/paths.js`: XDG config and state dirs; `src/fwrite.js`: atomic, symlink-safe writes and backups; `src/store.js`: validated `config.json` and project registry.
- Tests: `store`, `fwrite`, `hygiene` (no private strings in the repo, no outbound connections in `src/`).

Phase 2 (Node backend):

- App tier server: `nika serve --app` stdio handshake (secret over stdin, never argv/env/disk/logs), private `127.0.0.1:<random>` listener, tray status feed, native folder picker relay. `/api/app/*` sits behind a timing-safe secret, Origin and Sec-Fetch-Site checks, JSON-only writes and per-route body caps; it is never mounted on the browser tier (:3335).
- Session window backend: transcript history in byte-offset pages (`cleanBlock()`), live pane mirror through a whitelist-only SGR parser (OSC, DCS, other CSI, C0/C1 and bidi dropped; 250 ms cache, ETag/304), keystrokes via `send-keys -l --` with a named-key allow-list, multi-line paste ≤ 16 KB via tmux bracketed paste with ESC stripped, 20 requests/s per pane. Only live Claude panes (checked by their running command) and panes nika started are reachable.
- Orchestration: `nika orchestrate` creates or reuses the project's tmux session and an `orchestrator` window running claude (exact window match, panes tagged with `@nika-role`); `nika spawn` starts agents through the `_run-agent` wrapper with `--disallowedTools` for nika, tmux, claude and git add/commit/push, a deny list for `.env*` and `*.key`, the brief read from a 0600 file (never tmux argv), `maxAgents` and same-name checks; `bypassPermissions` is refused at every layer. Reports of nika-spawned agents show in the dashboard; `.rc` keeps the 0.1 exit-code meaning.
- Rules: generic orchestration template written from scratch (models, pane placement, agent limit, permission mode, Remote Control, plugins); `preview` with unified diffs and a plan hash; `apply` re-checks the hash, backs up outside the repo, writes only `rules/orchestration.md`, the `@rules/orchestration.md` line, `enabledPlugins` in `.claude/settings.local.json` and an opt-in `.gitignore` line, never widens file modes and never runs git. Project folders: world-writable refused; group-writable only on Linux with the user's own group.
- CLI: `nika` / `nika open` open the desktop app when installed (else the browser), `nika app`, `nika projects list|add|remove`, `nika rules preview|apply`, `nika spawn`, `nika orchestrate [--detached]`, `nika doctor`, `nika serve --app`; exit codes 0/1/2/3.
- Settings: permission modes `default manual acceptEdits plan auto dontAsk` (`default` passes no flag); `limits.maxTurns` dropped (Claude Code has no `--max-turns` for interactive sessions); config mutations serialised in-process; relative `XDG_*` values ignored.

Phase 3 (design):

- `docs/design/spec.md` (tokens, layout, states, session-window keyboard model, WCAG 2.2 AA, light/dark) and three static variants under `docs/design/variants/`; variant A (Console) chosen.

Phase 4 (UI):

- Main window redesigned (Console layout): "Waiting on you" queue, one-line summary, per-project groups, light, dark and system themes (`ui.theme`).
- Project view with rules, plugins and agent-limit cards; spawn sheet; apply-rules dialog with a diff preview (the `enabledPlugins` block only, other kept keys listed by name) and a success state; add project through the native picker; start orchestrator.
- Settings screen: theme, models per role, Remote Control, permission mode, pane placement, agent limit, plugins, rules template; one Save.
- Session window: paginated history with "load older", live pane mirror (ETag polling, frozen while scrolled up), composer with key chips and multi-line paste, pane-closed and narrow-window states.
- Browser tier stays read-only and loads no privileged code; the app tier copies its secret once from the shell into a module constant and deletes the global.
- Backend fields for the UI: history entry `id`, `GET /api/app/templates`, snapshot group `key`, agent `role` and `attention`, settings preview `keptKeys`.
- Tests: no HTML-parsing sinks or inline handlers in `public/`, no inline script or style, every static file served with the unchanged CSP, `api.js` secret handling against a stubbed `window`, mirror renderer, session UI.
- Dev only (not shipped): `scripts/dev-app.mjs` starts `serve --app` with a hello line for browser testing.

Phase 5 (desktop shell):

- Tauri v2 shell under `app/src-tauri` (macOS and Linux): tray icon with status counts and an attention dot, one window, no Dock icon on macOS, a supervised private server; closing the window hides it, a second launch focuses it.
- The shell hands the server a per-launch secret over stdin only (32 bytes from `/dev/urandom`), rebuilds the child env from a fixed list, and injects the secret into the page with an origin-guarded init script; no Tauri capability exists, so the page can call no Tauri command.
- Navigation: only the private server's origin and the local error page load; `https://claude.ai/code/session_<id>` links (also `target=_blank`) open in the system browser through fixed argv; every other navigation and new window is denied.
- Tray menu: counts-only status line, Open nika, up to 8 projects, Add project… (new `#add-project` route), Start at login (off by default), Quit (stdin close, then SIGTERM, then kill; tmux is never touched). A local error page with Retry restarts the server with a new secret and port.
- Packaging: ad-hoc signed `nika.app` carrying the Node server as resources; Linux `.deb` installs `io.github.qmpwwsd.nika.desktop`. Icons generated from scratch by `scripts/make-icons.mjs`.
- CI (`.github/workflows/ci.yml`): `npm test` on macOS and Ubuntu, `cargo test`, `cargo build` and `cargo audit` on macOS and Ubuntu 22.04; SHA-pinned official actions, read-only token. Docs: `docs/security.md`, `docs/architecture.md`, `docs/packaging.md`, `app/README.md`, README desktop section.
- Build tools approved: `tauri-cli` 2.12.4, `cargo-audit` 0.22.2.
- Fix: every scroll container is now a containing block, so hidden row labels no longer stretch the page; the window no longer scrolls as a whole in WebKit (blank band at the bottom, sidebar top cut off). Guarded by a CSS test.

Phase 6 (security review fixes, Linux checks):

- Independent security review of the branch: no Critical or High finding. Fixes below.
- The spawned-agent deny lists are documented as advisory, not a security boundary (Claude Code rules match the literal command); no Claude Code sandbox in 0.2, planned as an optional Settings switch.
- The spawn limit and the duplicate-name check count the panes nika tagged in tmux (`@nika-role agent`, `@nika-agent <project key>/<name>`) instead of agent-writable `<name>.pane` files, on both the API and the CLI.
- Started panes qualify for capture and keys only while they run claude, so a reused pane id no longer qualifies. The `auto` permission mode warns that a classifier approves actions without asking you. A one-word brief is refused, because claude could read it as a subcommand.
- `rules apply` keeps the last 10 backup folders per project (stamp-named real directories only, never following a symlink) and re-checks the folder chain after each write; `nika doctor` prints the backups folder.
- Docs: the brief is claude's argv (visible to local processes); tmux also format-expands `-s`, `-n` and `-T` (safe because names contain no `#`); nika parses but never interprets the other keys of `settings.local.json`.
- Linux checks: `scripts/linux-verify.sh` (tests, `ps` start-time format, `serve --app` handshake, tmux mirror, literal keys and bracketed paste) runs in Docker (`Dockerfile.test`) and in CI; `scripts/gui-smoke.sh` runs the real shell under Xvfb with a probe page and checks the secret handover, denied Tauri commands and blocked navigation on WebKitGTK.
- Release prep: version 0.2.0 in `package.json`, `tauri.conf.json` and `Cargo.toml`; draft Homebrew formula in `docs/packaging.md` (builds `nika.app` from source on macOS, CLI only on Linux).
- CI: push runs only on `master` (pull requests run once); new `linux-verify` and `gui-smoke` jobs. `release-linux.yml` (manual, read-only token) builds the `.deb` and AppImage, checks the package, and uploads them with `SHA256SUMS` as run artifacts.

Release fixes (after the `v0.2.0` tag; the app code is unchanged):

- The hidden `nika.desktop` entry gets the `Categories` line `appimagetool` requires (the first AppImage build failed there); `test/packaging.test.js` checks both desktop entries. The Linux packages of 0.2.0 are built with it.
- `release-linux.yml` builds with `--verbose`, so linuxdeploy and appimagetool errors reach the log.
- Homebrew formula: build the app before `libexec.install` moves the resource folders, and run `cargo-tauri` directly. Verified with `brew upgrade --build-from-source` (V5); README and `docs/packaging.md` describe the published install.

## 0.1.1 — 2026-11-08

- Hide title-only stub transcripts: a transcript with no user or assistant message is listed only while its session is live.

## 0.1.0 — 2026-11-07

- Local dashboard of Claude Code agents grouped by git repository, served on `127.0.0.1:3335`.
- Collectors: session registry, transcripts (head and tail chunks), subagents, tmux panes, spawn reports; worktrees fold under their repository.
- Actions: focus pane, open in claude.ai, copy resume command, show report.
- Hardening after review: safe reads (`src/fsafe.js`), id validation (`src/ids.js`), text cleaning (`src/text.js`), Host check, per-process token, strict CSP.
- CLI: `nika`, `nika open`, `nika serve`, `nika status`.
