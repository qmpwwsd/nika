# Changelog

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
