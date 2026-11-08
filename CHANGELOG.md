# Changelog

## Unreleased — 0.2.0

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

## 0.1.1 — 2026-11-08

- Hide title-only stub transcripts: a transcript with no user or assistant message is listed only while its session is live.

## 0.1.0 — 2026-11-07

- Local dashboard of Claude Code agents grouped by git repository, served on `127.0.0.1:3335`.
- Collectors: session registry, transcripts (head and tail chunks), subagents, tmux panes, spawn reports; worktrees fold under their repository.
- Actions: focus pane, open in claude.ai, copy resume command, show report.
- Hardening after review: safe reads (`src/fsafe.js`), id validation (`src/ids.js`), text cleaning (`src/text.js`), Host check, per-process token, strict CSP.
- CLI: `nika`, `nika open`, `nika serve`, `nika status`.
