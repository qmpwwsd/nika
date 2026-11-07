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
| `KEY_NAME` | set: `Enter Escape Tab BTab Up Down Left Right Home End PPage NPage BSpace DC C-c C-u C-k C-a C-e C-l C-r C-w` |
| `PERMISSION_MODES` | `default acceptEdits plan auto` — `bypassPermissions` is refused everywhere |
| `PANE_PLACEMENTS` | `beside under-last` |

## 1. Two tiers

| Tier | Process | Routes |
|---|---|---|
| browser (read-only) | `nika serve` on `127.0.0.1:3335` (brew/systemd) | 0.1 routes only: `/`, static, `/api/health`, `/api/agents`, `/api/report/:id`, `POST /api/focus`. `/api/app/*` is **not mounted**: 404. |
| app (privileged) | `nika serve --app` on `127.0.0.1:0`, child of the Tauri shell | everything above plus `/api/app/*` |

## 2. Privileged guard (every `/api/app/*` request)

1. Host header check as in 0.1 (`127.0.0.1:<port>` or `localhost:<port>`).
2. `X-Nika-App: <secret>` compared timing-safe against the secret received on stdin (`hello`). Missing or wrong → **403** `{"error":"forbidden"}`.
3. When `Origin` is present it must equal `http://127.0.0.1:<port>`; when `Sec-Fetch-Site` is present it must be `same-origin` or `none`. Otherwise **403**.
4. Writes (`POST`, `PUT`, `DELETE` with a body) need `Content-Type: application/json` (→ **415**) and a body within the route's cap (→ **413**); invalid JSON or a non-object body → **400**.
5. Every response: `Cache-Control: no-store`, the 0.1 security headers, no CORS headers.

Common error body: `{"error": "<code>", "message": "<short text>"}`; codes used below: `forbidden` 403, `not_found` 404,
`invalid` 400, `unsupported_media` 415, `too_large` 413, `conflict` 409, `busy` 429, `tmux_unavailable` 503,
`claude_unavailable` 503, `limit` 409 (maxAgents reached).

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
(colours as 0–255 or `[r,g,b]`); everything else (OSC, DCS, other CSI, C0/C1) is dropped server-side (T9).

### `POST /api/app/pane/:id/keys` (body ≤ 4 KB)
```json
{ "text": "<≤ 1024 chars, no C0/C1 controls>", "keys": [ "Enter" ] }
```
At least one of `text`, `keys`; `keys` ≤ 8 entries, each ∈ `KEY_NAME`. Same pane rule as capture. 20 requests/s per
pane → **429**. Response `200 { "sent": { "text": 12, "keys": 1 } }`.

### `POST /api/app/spawn` (body ≤ 80 KB)
```json
{ "project": "<PROJECT_KEY>", "name": "<AGENT_NAME>", "model": "<MODEL_ID>", "brief": "<≤ 64 KB>",
  "permissionMode": "default" | "acceptEdits" | "plan" | "auto", "under": "<PANE_ID>?", "session": "<TMUX_SESSION>?" }
```
`permissionMode` defaults to settings; `bypassPermissions` → 400. Refused with `409 limit` when the project already has
`limits.maxAgents` live nika-spawned agents. Response:
```json
{ "pane": "%12", "session": "<tmux session>", "reports": { "dir": "<stateDir>/projects/<key>/reports",
  "session": "<name>.session", "report": "<name>.md", "rc": "<name>.rc" } }
```

### `POST /api/app/orchestrator/start`
`{ "project": "<PROJECT_KEY>" }` → `200 { "pane": "%3", "session": "<name>", "created": true }`. The tmux session name
is the project `name` reduced to `TMUX_SESSION` (fallback: the key); an existing session is reused (`has-session -t =<name>`),
and an existing nika orchestrator pane in it is returned instead of a new one.

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

Limits: one open `pick-folder` at a time; `status` fields are integers ≥ 0; names are `clean()`ed. The secret never
appears in argv, env, logs, files or HTML; the shell injects it into the page with an `initialization_script` guarded
by `location.origin`, and `public/api.js` copies it to a module constant and deletes the global (ADR 0002).

## 6. Config and state (`src/paths.js`, `src/store.js`, `src/fwrite.js`)

| Path | Mode | Content |
|---|---|---|
| `${NIKA_CONFIG_DIR \|\| XDG_CONFIG_HOME \|\| ~/.config}/nika/` | 0700 | config dir |
| `…/nika/config.json` | 0600 | schema below |
| `…/nika/templates/<name>.md` | 0600 | locally imported rule templates (copies; never a path into a repo) |
| `${XDG_STATE_HOME \|\| ~/.local/state}/nika/` | 0700 | state dir |
| `…/nika/projects/<key>/reports/` | 0700 | `<name>.session` `.md` `.rc`, `.last-pane` |
| `…/nika/backups/<key>/<ISO>/<relPath>` | 0700 / 0600 | copies taken by `rules apply` before each overwrite |

`config.json` schema and defaults (unknown keys are dropped, wrong types fall back to the default; both produce a
warning in `loadConfig().warnings`; a tampered or unreadable file never throws):
```json
{
  "models": { "orchestrator": "claude-fable-5-1", "reasoner": "claude-opus-5-5", "builder": "claude-sonnet-5-5", "scout": "claude-haiku-5-5" },
  "remoteControl": { "enabled": false, "prefix": "" },
  "permissionMode": "default",
  "panePlacement": "beside",
  "limits": { "maxAgents": 3, "maxTurns": 80 },
  "plugins": { "perProject": { "<PROJECT_KEY>": [ "<PLUGIN_NAME>" ] } },
  "projects": [ { "key": "<PROJECT_KEY>", "dir": "<abs realpath>", "name": "<basename>", "addedAt": "<ISO>" } ],
  "rules": { "localTemplate": null }
}
```
Field rules: `models.*` `MODEL_ID`; `remoteControl.prefix` `""` (= project name) or `RC_PREFIX`; `permissionMode` ∈
`PERMISSION_MODES`; `panePlacement` ∈ `PANE_PLACEMENTS`; `limits.maxAgents` 1–8, `limits.maxTurns` 1–1000;
`plugins.perProject` ≤ 200 names per project; `projects` ≤ 100 entries, `key` must equal `keyFor(dir)`;
`rules.localTemplate` `null` or a file name `^[A-Za-z0-9_-]{1,64}\.md$` under `templates/`.

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
| `nika app` | start the desktop shell in the foreground |
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
| create session | `tmux -u new-session -d -s <session> -c <projectDir> -x 200 -y 50` |
| orchestrator pane | `tmux -u new-window -t =<session> -n orchestrator -c <projectDir> -P -F #{pane_id} -- <claudeBin> [--permission-mode <m>] [--model <orchestrator>]` |
| spawn beside | `tmux -u split-window -h -t =<session> -c <projectDir> -P -F #{pane_id} -- <nikaBin> _run-agent <key> <name>` |
| spawn under last | `tmux -u split-window -v -t <lastPane> -c <projectDir> -P -F #{pane_id} -- <nikaBin> _run-agent <key> <name>` |
| pane title | `tmux -u select-pane -t %n -T [%n] <name>` |
| capture | `tmux -u capture-pane -p -e -N -t %n` (plus `-S -<rows>` when more than the visible screen is requested; never more than 2000 rows) |
| pane size + cursor | `tmux -u display-message -p -t %n -F #{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}` |
| send text | `tmux -u send-keys -t %n -l -- <text>` (V3 fallback: `-H` with hex bytes) |
| send key | `tmux -u send-keys -t %n -- <KEY_NAME>` |
| focus | `tmux -u switch-client -t %n` / `select-window -t %n` / `select-pane -t %n` (0.1) |

`_run-agent` runs `claude` with: `--model <model>`, `--permission-mode <m>` (never `bypassPermissions`),
`--max-turns <limits.maxTurns>`, the brief as the prompt, and `--disallowedTools "Bash(nika:*)" "Bash(tmux:*)"
"Bash(claude:*)" "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)"` plus a deny list for `.env*` and `*.key`
(T3, T4). `--rc <prefix>` adds `--remote-control --name <prefix>-<name>`. Every value is a separate argv element.
