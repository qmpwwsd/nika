# nika 0.2 contracts — app tier

Source of truth for every builder in 0.2. Routes, messages, schema fields and argv shapes below are fixed; a change
here is a change for every phase and needs the orchestrator's sign-off. Rules: `rules/project-rules.md`; decisions:
`docs/adr/`.

Id shapes come from `src/ids.js`:

| Name | Shape |
|---|---|
| `UUID` | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `PANE_ID` | `^%\d{1,6}$` |
| `PROJECT_KEY` | `^[a-z0-9]{16}$` — first 16 hex chars of `sha256(realpath(project dir))` |
| `AGENT_NAME` | `^[a-z0-9][a-z0-9-]{0,39}$` |
| `MODEL_ID` | `^claude-[a-z0-9-]{3,60}$` or one of `opus sonnet haiku fable` |
| `TMUX_SESSION` | `^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$` (never starts with `-`) |
| `PLUGIN_NAME` | `^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9._-]{1,100}$` |
| `RC_PREFIX` | `^[a-z0-9][a-z0-9-]{0,19}$` |
| `RC_NAME` | `^[a-z0-9][a-z0-9-]{0,63}$` — full Remote Control name, never truncated to the prefix length |
| `KEY_NAME` | set: `Enter Escape Tab BTab Up Down Left Right Home End PPage NPage BSpace DC C-c C-u C-k C-a C-e C-l C-r C-w` |
| `PERMISSION_MODES` | `default manual acceptEdits plan auto dontAsk` — `default` passes no `--permission-mode` flag (Claude Code's own default); `bypassPermissions` is refused everywhere |
| `PANE_PLACEMENTS` | `beside under-last` |

## 1. Two tiers

| Tier | Process | Routes |
|---|---|---|
| browser (read-only) | `nika serve` on `127.0.0.1:3335` (brew/systemd) | 0.1 routes only: `/`, static, `/api/health`, `/api/agents`, `/api/report/:id`, `POST /api/focus`. `/api/app/*` is **not mounted**: 404. |
| app (privileged) | `nika serve --app` on `127.0.0.1:0`, child of the Tauri shell | everything above plus `/api/app/*` |

## 2. Privileged guard (every `/api/app/*` request)

1. Host header check as in 0.1 (`127.0.0.1:<port>` or `localhost:<port>`).
2. `X-Nika-App: <secret>` compared timing-safe (sha256 digests) against the secret received on stdin (`hello`). Missing or wrong → **403** `{"error":"forbidden","message":"forbidden"}` — the same body for every guard failure in 2–3.
3. When `Origin` is present it must equal `http://127.0.0.1:<port>`; when `Sec-Fetch-Site` is present it must be `same-origin` or `none`. Otherwise **403**.
4. Writes (`POST`, `PUT`, `DELETE` with a body) need `Content-Type: application/json` (→ **415**) and a body within the route's cap (→ **413**); invalid JSON or a non-object body → **400**.
5. Every response: `Cache-Control: no-store`, the 0.1 security headers, no CORS headers.

Common error body: `{"error": "<code>", "message": "<short text>"}`; codes used below: `forbidden` 403, `not_found` 404,
`invalid` 400, `unsupported_media` 415, `too_large` 413, `conflict` 409, `busy` 429, `tmux_unavailable` 503,
`claude_unavailable` 503, `tmux_failed` 502 (a tmux call failed unexpectedly), `limit` 409 (maxAgents reached), `foreign` 409 (rules file not written by nika, apply without
`overwriteForeign`), `refused` 409 (a write-safety check failed; `"code"` carries the fwrite/OS code such as `ESYMLINK`).

## 3. Routes

### `GET /api/app/me`
Response `200`:
```json
{ "tier": "app", "version": "0.2.0", "platform": "darwin", "tmux": true, "claude": true, "configDir": "<abs>", "stateDir": "<abs>" }
```

### Projects

| Route | Request | Response |
|---|---|---|
| `GET /api/app/projects` | – | `{ "projects": [Project] }` |
| `POST /api/app/projects/pick` | empty object | `202 { "reqId": "<UUID>" }`; **429 busy** while a picker is open |
| `GET /api/app/projects/pick/:reqId` | reqId `UUID`, must be the open request | `200 { "state": "pending" }` · `200 { "state": "done", "project": Project }` · `200 { "state": "cancelled" }` · 404 unknown |
| `DELETE /api/app/projects/:key` | key `PROJECT_KEY` | `200 { "removed": true }` · 404 |

`Project`:
```json
{ "key": "0123456789abcdef", "dir": "<abs realpath>", "name": "<basename, clean()>", "addedAt": "<ISO>",
  "rules": { "state": "none" | "nika" | "foreign" | "outdated", "settingsIgnored": true, "git": true } }
```
`rules.state`: `none` no `rules/orchestration.md`; `nika` written by nika and current; `outdated` written by nika from an
older template; `foreign` a file nika did not write (apply needs the explicit `overwriteForeign` flag).
`settingsIgnored`: `.claude/settings.local.json` is covered by the project's `.gitignore`.

The picker runs in the shell (`pick-folder` / `folder` messages, §5). The folder must be an absolute existing directory;
the server re-checks (`realpath`, `isDirectory`) before `addProject`. Projects are only added through the picker or
`nika projects add <dir>`; no route accepts a path.

### Settings

`GET /api/app/settings` → `200 Settings`. `PUT /api/app/settings` body ≤ 16 KB: a partial `Settings` (every key except
`projects`; object groups merge one level deep; `plugins.perProject` replaces the whole map) → `200 Settings` (as
re-read from disk) or `400 invalid` with `"message"` naming the first bad field. `permissionMode: "bypassPermissions"`
is always `400`. Per-project plugin names must be ⊂ the installed names from `/api/app/plugins`, else `400`.

`Settings` = the `config.json` schema (§6) without `projects`.

### `GET /api/app/plugins`
`200 { "plugins": [ "<PLUGIN_NAME>", … ] }` — installed plugin names read from Claude Code's config dir (names only,
never settings, hooks or keys), ≤ 200, sorted.

### `GET /api/app/session/:id/history?before=<n>&limit=<n>`
`id` must be a `UUID` present in nika's transcript index (never a path from the request). `limit` 1–200 (default 50),
`before` a byte offset returned as `nextBefore` by the previous page (default: end of file). The server reads at most
1 MB per request, 4 requests in flight, and drops any single entry over 32 KB (`"truncated": true`).
```json
{ "entries": [ { "at": "<ISO>", "role": "user" | "assistant", "kind": "text" | "thinking" | "tool_use" | "tool_result",
                 "text": "<cleanBlock()>", "tool": "<name>?", "truncated": false } ],
  "nextBefore": 123456 | null }
```
Text is passed through `cleanBlock()` (keeps `\n` and `\t`, strips every other control and bidi code point) and the
page renders it with `textContent`.

### `GET /api/app/pane/:id/capture`
`id` `PANE_ID`, must appear in the current `tmux list-panes -a` **and** be either a live Claude session's pane
(registry `tmux` field) or a pane nika started (`orchestrator/start`, `spawn`). Else 404. Cached 250 ms per pane,
one capture in flight per pane (others wait for it), `ETag` = hash of the rows; `If-None-Match` → 304.
```json
{ "cols": 120, "rows": [ [ { "t": "text", "s": { "b": true, "fg": 4, "bg": null, "u": false, "i": false, "d": false } } ] ],
  "cursor": { "x": 0, "y": 0, "visible": true }, "etag": "<hex>" }
```
Only SGR codes 0, 1, 2, 3, 4, 7, 22–24, 27, 30–37, 39, 40–47, 49, 90–97, 100–107 and 38/48;5;n or ;2;r;g;b survive
(colours as 0–255 or `[r,g,b]`; reverse video adds `"r": true` to the style only while it is on); everything else (OSC, DCS, other CSI, C0/C1) is dropped server-side (T9).

### `POST /api/app/pane/:id/keys` (body ≤ 20 KB)
```json
{ "text": "<≤ 1024 chars, no C0/C1 controls>", "paste": "<≤ 16 KB UTF-8, multi-line>", "keys": [ "Enter" ] }
```
At least one of `text`, `paste`, `keys`; `text` and `paste` are mutually exclusive (→ 400). `text` with any C0/C1
control → 400. `paste`: `\r\n` and `\r` become `\n`; every other C0 except `\n` `\t`, DEL, C1 and ESC is stripped (so
the bracketed-paste end marker cannot be forged), then sent with bracketed paste (§8); tmux turns `\n` into CR inside
the paste (no `-r`), as a terminal paste would. Every validation failure, including size, is `400 invalid`. `keys` ≤ 8 entries, each ∈
`KEY_NAME`, sent after the text or paste. Same pane rule as capture. 20 requests/s per pane → **429**. Response
`200 { "sent": { "text": 12, "paste": 0, "keys": 1 } }` (counts of characters / keys sent).

### `POST /api/app/spawn` (body ≤ 80 KB)
```json
{ "project": "<PROJECT_KEY>", "name": "<AGENT_NAME>", "model": "<MODEL_ID>", "brief": "<≤ 64 KB>",
  "permissionMode": "<PERMISSION_MODES>?", "under": "<PANE_ID>?", "session": "<TMUX_SESSION>?", "rc": "off|<RC_PREFIX>?" }
```
`permissionMode` defaults to settings; `bypassPermissions` → 400. `rc` overrides the Remote Control setting for this
agent. `under`: split `-v` below that pane (unknown pane → 404, pane in another session than `session` → 400; the
response `session` is the pane's session). Refused with `409 limit` when the project already has
`limits.maxAgents` live nika-spawned agents. Response:
```json
{ "pane": "%12", "session": "<tmux session>", "sessionId": "<UUID>", "reports": { "dir": "<stateDir>/projects/<key>/reports",
  "session": "<name>.session", "report": "<name>.md", "rc": "<name>.rc", "remote": "<name>.remote" } }
```

### `POST /api/app/orchestrator/start`
`{ "project": "<PROJECT_KEY>" }` → `200 { "pane": "%3", "session": "<name>", "sessionId": "<UUID>|null", "created": true }`.
The tmux session name is the project `name` reduced to `TMUX_SESSION` (fallback: the key). No session → `new-session`
whose first window (`orchestrator`) runs claude. Existing session (`has-session -t =<name>`) → its window named
`orchestrator` is returned when its pane runs claude (`created: false`, `sessionId: null` unless nika started it in
this process); otherwise a `new-window -n orchestrator` is added. The UI opens the session window with `sessionId`.

### Rules

`POST /api/app/rules/preview` `{ "project": "<PROJECT_KEY>" }` →
```json
{ "hash": "<sha256 hex of every planned write>", "files": [
    { "path": "rules/orchestration.md", "action": "create" | "update" | "unchanged", "diff": "<unified>", "foreign": false },
    { "path": "CLAUDE.md", "action": "update", "diff": "…" },
    { "path": ".claude/settings.local.json", "action": "update", "diff": "…", "keysPreserved": true },
    { "path": ".gitignore", "action": "update", "diff": "…", "optional": true } ],
  "warnings": [ "settings.local.json is not gitignored" ], "backupDir": "<stateDir>/backups/<key>/<ISO>" }
```
`POST /api/app/rules/apply` `{ "project": "<PROJECT_KEY>", "hash": "<from preview>", "overwriteForeign": false,
"gitignore": false }` recomputes the preview; a different hash → **409 conflict**. Writes go through `src/fwrite.js`
(`checkComponents` → backup → `writeAtomic`) and never touch git. Response `200 { "written": [ "rules/orchestration.md",
"CLAUDE.md", ".claude/settings.local.json" ], "backupDir": "<abs>" }`.

In `.claude/settings.local.json` only `enabledPlugins` is written; every other key is copied verbatim and deep-equal
asserted before the write; `hooks permissions env apiKeyHelper mcpServers model` are never read or written; invalid
JSON or a `__proto__` key → `400 invalid` (T5).

## 4. Guard on the browser tier
`nika serve` (no `--app`) never mounts §3; a request to `/api/app/*` is `404 not_found` like any unknown route.

## 5. Shell ↔ server stdio protocol (`proto` 1)

JSON lines over the child's stdin/stdout (`\n`-terminated, UTF-8). The server refuses to start when stdin is a TTY
(`--app` needs a pipe) and exits when stdin closes. Lines over 64 KB and unknown `type`s are ignored on both sides.
No other channel exists: no Tauri IPC, no HTTP client in Rust.

| Direction | Message | Fields |
|---|---|---|
| shell → server | `hello` | `{"type":"hello","proto":1,"secret":"<32 random bytes, base64url, 43 chars>"}` — must be the first line; a second `hello` is ignored |
| server → shell | `ready` | `{"type":"ready","proto":1,"port":N,"version":"0.2.0"}` |
| server → shell | `status` (every 3 s and after each `collect()`) | `{"type":"status","busy":n,"idle":n,"other":n,"ended":n,"attention":n,"projects":[{"key":"…","name":"…","busy":n,"idle":n,"attention":n}]}` (≤ 8 projects) |
| server → shell | `pick-folder` | `{"type":"pick-folder","reqId":"<UUID>"}` |
| shell → server | `folder` | `{"type":"folder","reqId":"<UUID>","path":"<abs dir>" \| null}` — the server validates `reqId` (open request) and the path (absolute, existing, real dir) before `addProject` |
| server → shell | `error` | `{"type":"error","message":"<clean()>"}` before a non-zero exit (bad `hello`, port in use) |

Limits: one open `pick-folder` at a time; `status` fields are integers ≥ 0; names are `clean()`ed; `attention` = live
agents whose registry status is neither busy nor idle (e.g. waiting on a permission prompt); `projects[].key` is
`keyFor(repo root)`, never a path. Pane eligibility (§3 capture/keys): a registry pane qualifies only while its
`pane_current_command` is claude-like (`CLAUDE_COMMAND` in `src/ids.js`), because `tmuxPane` is agent-writable. This
is a safety net for the user, not a boundary against agents: a same-user agent able to forge the registry can already
run `tmux send-keys` itself; `node` stays accepted because npm-installed Claude Code runs as `node`. The secret never
appears in argv, env, logs, files or HTML; the shell injects it into the page with an `initialization_script` guarded
by `location.origin`, and `public/api.js` copies it to a module constant and deletes the global (ADR 0002).

## 6. Config and state (`src/paths.js`, `src/store.js`, `src/fwrite.js`)

| Path | Mode | Content |
|---|---|---|
| `${NIKA_CONFIG_DIR \|\| XDG_CONFIG_HOME \|\| ~/.config}/nika/` | 0700 | config dir |
| `…/nika/config.json` | 0600 | schema below |
| `…/nika/templates/<name>.md` | 0600 | locally imported rule templates (copies; never a path into a repo) |
| `${XDG_STATE_HOME \|\| ~/.local/state}/nika/` | 0700 | state dir |
| `…/nika/projects/<key>/reports/` | 0700 | per agent: `<name>.brief.md` and `<name>.agent.json` (`{model, permissionMode, rc}`, re-validated on read) written by `spawn`; `<name>.session` (UUID), `<name>.remote` (RC name or empty), `<name>.pane` (`$TMUX_PANE`) written by `_run-agent` before claude starts and `<name>.rc` (claude's exit code, as in 0.1) after it exits; `<name>.md` written by the agent; `.last-pane` |
| `…/nika/backups/<key>/<ISO>/<relPath>` | 0700 / 0600 | copies taken by `rules apply` before each overwrite |

`config.json` schema and defaults (unknown keys are dropped, wrong types fall back to the default; both produce a
warning in `loadConfig().warnings`; a tampered or unreadable file never throws):
```json
{
  "models": { "orchestrator": "claude-fable-5-1", "reasoner": "claude-opus-5-5", "builder": "claude-sonnet-5-5", "scout": "claude-haiku-5-5" },
  "remoteControl": { "enabled": false, "prefix": "" },
  "permissionMode": "default",
  "panePlacement": "beside",
  "limits": { "maxAgents": 3 },
  "plugins": { "perProject": { "<PROJECT_KEY>": [ "<PLUGIN_NAME>" ] } },
  "projects": [ { "key": "<PROJECT_KEY>", "dir": "<abs realpath>", "name": "<basename>", "addedAt": "<ISO>" } ],
  "rules": { "localTemplate": null }
}
```
Field rules: `models.*` `MODEL_ID`; `remoteControl.prefix` `""` (= project name) or `RC_PREFIX`; `permissionMode` ∈
`PERMISSION_MODES`; `panePlacement` ∈ `PANE_PLACEMENTS`; `limits.maxAgents` 1–8 (there is no turn limit: Claude Code
has no `--max-turns` for interactive sessions); `plugins.perProject` ≤ 200 names per project, keys must be registered
projects (checked by `PUT /api/app/settings`); `projects` ≤ 100 entries, `key` must equal `keyFor(dir)`;
`rules.localTemplate` `null` or a file name `^[A-Za-z0-9_-]{1,64}\.md$` under `templates/`. Store mutations in one
process are serialised (one promise queue in `src/store.js`); across processes the last atomic rename wins.

Project folders (`rules/`, `.claude/`, the repo root) are written with `writeAtomic(…, { project: true })`: a
world-writable folder is always refused; a group-writable one is accepted only on Linux and only when its group is
the user's primary group (`process.getgid()`, the per-user group of a 002 umask). nika's own config and state folders
stay strict (no group or world write). An existing in-project file keeps its mode minus group/other write (never
widened); a new `.claude/settings.local.json` is 0600, other new in-project files 0644; nika's own files 0600.
`enabledPlugins`: selected plugins → `true`; `true` entries not selected → removed; `false` entries of unselected
plugins untouched; a project with no `plugins.perProject` entry leaves `enabledPlugins` untouched.

Store API: `loadConfig(env) → { config, warnings, file }`, `saveConfig(config, env)` (re-validates, throws `EINVAL`),
`addProject(dir, env)`, `removeProject(key, env)`, `listProjects(env)`, `updateSettings(patch, env)` (throws `EINVAL`,
never accepts `projects` or `bypassPermissions`), `keyFor(realDir)`.

Write API (`src/fwrite.js`): `ensureDir(dir, mode = 0o700)`, `writeAtomic(dir, name, content, { mode = 0o600 })`,
`checkComponents(root, relPath) → { dir, name, abs }`, `backupFile(srcAbs, backupRootAbs, relPath)`. Error codes:
`ESYMLINK` `ENOTDIR` `ENOTREG` `EOWNER` `ENLINK` `EMODE` `EPATH` `EFBIG` (plus the OS codes `ENOENT`, `ELOOP`).

## 7. CLI

| Command | Does |
|---|---|
| `nika` | opens the app when installed (macOS `open -b io.github.qmpwwsd.nika`, Linux `nika-app` then `gtk-launch io.github.qmpwwsd.nika`), else the browser dashboard |
| `nika open [--app\|--browser]` | force one of the two |
| `nika app` | launch the desktop app (same lookup as `open --app`, does not block); exit 1 with an install hint when it is missing |
| `nika serve [--app]` | browser tier on `NIKA_PORT` (3335) · app tier on port 0 with the stdio protocol (§5); `--app` refuses a TTY stdin |
| `nika status [--json] [--since w] [--full]` | unchanged from 0.1 |
| `nika spawn <name> <model> <brief> [--project dir] [--permission-mode m] [--rc prefix\|off] [--under %pane] [--session name]` | spawn an agent in tmux (needs `$TMUX` or `--session`); `brief` is a file path or `-` for stdin |
| `nika orchestrate [dir]` | create or reuse the project's tmux session and start the orchestrator pane |
| `nika projects list\|add <dir>\|remove <key>` | project registry |
| `nika rules preview\|apply [dir] [--yes] [--overwrite-foreign] [--gitignore]` | preview prints the diffs; apply asks for confirmation unless `--yes` |
| `nika doctor` | prints node, tmux, claude, app, config and state paths and their modes |
| `nika _run-agent <key> <name>` | hidden pane wrapper: writes `<name>.session` and `<name>.rc`, runs claude |
| `nika --version` | version |

Exit codes: 0 ok · 1 runtime error · 2 usage · 3 refused (validation, limit, foreign file without flag).

## 8. tmux argv shapes (`execFile`, never a shell)

All calls use the resolved `tmuxBin` (`findTmux`), `-u`, exact targets (`=<session>` for sessions, `%n` for panes) and
multi-argument shell-commands (tmux execs them directly, no `sh -c`, T6).

| Purpose | argv |
|---|---|
| list panes | `tmux -u list-panes -a -F #{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}` (0.1) |
| session exists | `tmux -u has-session -t =<session>` |
| create session + orchestrator | `tmux -u new-session -d -s <session> -n orchestrator -c <projectDir> -x 200 -y 50 -P -F #{pane_id} -- <claudeBin> <orchestrator flags>` |
| orchestrator in existing session | `tmux -u new-window -t =<session>: -n orchestrator -c <projectDir> -P -F #{pane_id} -- <claudeBin> <orchestrator flags>` |
| tag a pane nika created | `tmux -u set-option -p -t %n @nika-role orchestrator` (after new-session / new-window) or `… @nika-role agent` (after split-window); best effort |
| find orchestrator pane | `tmux -u list-panes -t =<session>:=orchestrator -F #{pane_id}\t#{pane_current_command}\t#{@nika-role}` → the pane with `@nika-role` = `orchestrator` whose command is claude (`claude`, `node` or a version string); agent panes split into that window never match (`:=` = exact window name; `:orchestrator` also matches `orchestrator-x`) |
| spawn beside | `tmux -u split-window -h -t =<session>: -c <projectDir> -P -F #{pane_id} -- <nikaBin…> _run-agent <key> <name>` |
| spawn under last | `tmux -u split-window -v -t <lastPane> -c <projectDir> -P -F #{pane_id} -- <nikaBin…> _run-agent <key> <name>` |
| pane title | `tmux -u select-pane -t %n -T [%n] <name>` |
| capture | `tmux -u capture-pane -p -e -N -t %n` (plus `-S -<rows>` when more than the visible screen is requested; never more than 2000 rows) |
| pane size + cursor | `tmux -u display-message -p -t %n -F #{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}` |
| send text | `tmux -u send-keys -t %n -l -- <text>` |
| send paste | `tmux -u load-buffer -b nika-<16 hex> -` (paste bytes on stdin; argv over ~16 KB fails with "command too long") then `tmux -u paste-buffer -p -d -b nika-<16 hex> -t %n`; on a paste failure `delete-buffer -b nika-<hex>` |
| send key | `tmux -u send-keys -t %n -- <KEY_NAME>` |
| focus | `tmux -u switch-client -t %n` / `select-window -t %n` / `select-pane -t %n` (0.1) |

`-c <projectDir>` is always passed through `tmuxLiteral()` (every `#` doubled): tmux format-expands start-directory,
and `#(cmd)` in a path would run `cmd` (verified on tmux 3.8). Shell-command argv after `--` is not expanded.

Session targets always carry the trailing colon (`=<session>:`) where tmux expects a window or pane: `split-window -t
=name` fails with "can't find pane", `=name:` works.

**Claude argv** (every value a separate element; verified against Claude Code 2.1.319):
- orchestrator flags: `--session-id <UUID>` `--model <models.orchestrator>` `[--permission-mode <m>]` (omitted for
  `default`) `-n <session>` `[--remote-control=<rc name>]`. RC name = `remoteControl.prefix` or the session name,
  reduced to `RC_PREFIX`.
- `_run-agent <key> <name>` reads `<reportsDir>/<name>.brief.md` (0600, written by `spawn` before `split-window`,
  read through `fsafe`; the brief never passes through tmux argv), writes `<name>.session` (the UUID), `<name>.remote`
  (the RC name or empty) and `<name>.pane`, then runs `claude --session-id <UUID> --model <model> [--permission-mode <m>] -n <name>
  [--remote-control=<prefix>-<name>] --add-dir <reportsDir> --append-system-prompt <templates/guard-prompt.txt
  rendered with name, report path> --settings <deny JSON> --disallowedTools Bash(nika:*) Bash(tmux:*)
  Bash(claude:*) "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)" -- <brief>` with inherited stdio, writes
  claude's exit code to `<name>.rc` and exits with it. RC names match `RC_NAME`. `--disallowedTools` is variadic, so it is always followed by `--`. Deny JSON:
  `{"permissions":{"deny":["Read(**/.env*)","Edit(**/.env*)","Read(**/*.key)","Edit(**/*.key)"]}}` (T3, T4).
- `<nikaBin…>` = `process.execPath` + absolute path of `bin/nika` (no PATH lookup inside tmux).

## 9. Module interfaces (Phase 2)

Handlers return `{ status, body }` like 0.1 `focusPane` / `readReport`; the router only sends. `ctx` =
`{ env, exec, tmuxBin, claudeBin, nikaArgv, claudeDir, now, started }` where `started` is the in-process `Map<paneId,
{ key, name, sessionId, role: "agent" | "orchestrator" }>` of panes nika created. Pane eligibility (in `list-panes` and live Claude or `started`) is
checked by the router before `mirror` / `keys` are called; those modules still validate `PANE_ID`.

| Module | Exports |
|---|---|
| `src/exec.js` | `makeExec()` — adds `opts.input` (string/Buffer written to the child's stdin, then closed) |
| `src/text.js` | `cleanBlock(s, max)` — like `clean()` but keeps `\n` `\t` |
| `src/collect/history.js` | `readHistory(sessionId, { before, limit }, { claudeDir, cache }) → { status, body }` |
| `src/collect/plugins.js` | `listPlugins(claudeDir) → string[]` (keys of `plugins` in `<claudeDir>/plugins/installed_plugins.json`, read through `fsafe` ≤ 1 MB; sorted, ≤ 200, each `PLUGIN_NAME`; `[]` when missing or invalid) |
| `src/mirror.js` | `parseCapture(text, cols) → rows` (pure); `createMirror({ exec, tmuxBin, now }) → { capture(pane, ifNoneMatch) → { status, body, etag } }` |
| `src/keys.js` | `createKeys({ exec, tmuxBin, now }) → { send(pane, { text, paste, keys }) → { status, body } }` |
| `src/rules.js` | `async rulesState(project) → { state, settingsIgnored, git }`; `preview(project, ctx) → { status, body }`; `apply(project, { hash, overwriteForeign, gitignore }, ctx) → { status, body }` |
| `src/diff.js` | `unifiedDiff(oldText, newText, path) → string` |
| `src/spawn.js` | `spawnAgent(req, ctx) → { status, body }`; `runAgent(key, name, ctx) → exit code` |
| `src/orchestrate.js` | `startOrchestrator(project, ctx) → { status, body }` |
| `src/appio.js` | `serveApp({ config, env, stdin, stdout, stderr }) → Promise<number>` (handshake, listen, status loop, picker; resolves with the exit code 0/1/2) |
| `src/api-app.js` | `createAppApi({ secret, ctx, deps }) → (req, res, url, port) → Promise<boolean>` (true when it handled the request) |
