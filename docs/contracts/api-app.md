# nika 0.2–0.3 contracts — app tier

Source of truth for every builder from 0.2 on (0.3 adds session control: mode, prompt answer, end, commands, models; ADR
0010, TUI facts in `docs/contracts/claude-tui.md`). Routes, messages, schema fields and argv shapes below are fixed; a change
here is a change for every phase and needs the orchestrator's sign-off. Rules: `rules/project-rules.md`; decisions:
`docs/adr/`.

Id shapes come from `src/ids.js`:

| Name | Shape |
|---|---|
| `UUID` | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `PANE_ID` | `^%\d{1,6}$` |
| `PROJECT_KEY` | `^[a-z0-9]{16}$` — first 16 hex chars of `sha256(realpath(project dir))` |
| `AGENT_NAME` | `^[a-z0-9][a-z0-9-]{0,39}$` |
| `MODEL_ID` | `^(?:claude-[a-z0-9-]{3,60}\|opus\|sonnet\|haiku\|fable\|best\|opusplan)(?:\[1m\])?$` (0.3; brackets are argv only, never a shell, and contain no `#`) |
| `MODES` | `manual acceptEdits plan auto bypassPermissions dontAsk` — a pane's mode as read from Claude's footer (`manual` = Claude's `default`); `unknown` when unreadable |
| `MODE_TARGETS` | `manual acceptEdits plan auto` — what the mode switch accepts (`dontAsk` is not a target; whether it is in Claude's Shift+Tab cycle is unverified, `claude-tui.md` §7; `bypassPermissions` is never a target in 0.3, spec §6.3: only panes nika launched with bypass allowed, which arrives in 0.4) |
| `COMMAND_NAME` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` — the bare name of a listed slash command or skill (no leading `/`, before any `<plugin>:` prefix) |
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
`invalid` 400, `unsupported_media` 415, `too_large` 413, `conflict` 409, `busy` 429, `tmux_unavailable` 503 (the tmux binary is
missing; since 0.4 a tmux server that is not running is not an error for Start or spawn: they create the session),
`claude_unavailable` 503, `tmux_failed` 502 (a tmux call failed unexpectedly), `claude_exited` 502 (0.4: the new pane was gone or dead
a second after Start, Resume or spawn created it), `limit` 409 (maxAgents reached), `foreign` 409 (rules file not written by nika, apply without
`overwriteForeign`), `refused` 409 (a write-safety check failed; `"code"` carries the fwrite/OS code such as `ESYMLINK`),
and for session control (0.3) `not-idle`, `mode-unknown`, `mode-unchanged`, `not-in-cycle`, `busy-switching`, `no-prompt`,
`prompt-changed`, `already-answered`, `input-not-empty`, `input-unreadable`, `not-at-prompt`, `bypass-prompt`, `screen-unclear`, all 409. The 0.3 codes are hyphenated, as the spec names them; the older codes keep their underscores. Draft sync (0.5) adds `draft-unreadable`, `draft-changed`, `screen-changed` and `draft-mismatch`, all 409 (`PUT /api/app/pane/:id/draft`; the first, second and fourth also `POST /api/app/pane/:id/suggestion`).

## 3. Routes

### `GET /api/app/me`
Response `200`:
```json
{ "tier": "app", "version": "0.2.0", "platform": "darwin", "tmux": true, "claude": true, "configDir": "<abs>", "stateDir": "<abs>",
  "appCopy": { "state": "missing", "managed": false, "dismissed": false, "version": null, "available": "0.3.0", "running": false } }
```
`appCopy` (0.3, macOS; ADR 0011): the copy of the app in `~/Applications`. `state` ∈ `unsupported` (not macOS) ·
`no-source` (no nika.app to copy from) · `missing` (no `~/Applications/nika.app`) · `current` (it is nika at the
source's version) · `stale` (it is nika at another version) · `foreign` (`~/Applications` is not a plain folder you own, or
that path is a symlink, not a folder you own, or not nika's bundle id). `version` = the copy's version, `available` = the source's version, `managed` = nika made the
copy (state marker), `dismissed` = "Not now" was chosen on the Add prompt, `running` = this server runs from the copy.

### `POST /api/app/app-copy` (body ≤ 4 KB, `CAP.small`)
`{ "action": "install" }` copies or updates the app in `~/Applications`; `{ "action": "dismiss" }` records "Not now"
(the Add prompt is not shown again; the command still works). Any other body → `400 invalid`. One copy at a time → 409
`copy-busy`. Not macOS → 409 `unsupported`; no source → 409 `no-source`; the target is not nika (or `~/Applications`
is not a plain folder you own) → 409 `foreign-target` (nothing written); the copy failed → `500 copy-failed` (temp copy removed,
the old copy left in place); `dismiss` could not record the choice → `500 dismiss-failed` ("nika could not record your choice"). Success →
`200 { "state": "current", "version": "0.3.0", "restart": false }`; `restart: true` when this server runs from the copy it
just replaced (the page says to quit and reopen nika). `dismiss` → `200 { "dismissed": true }`. The error body is the common
`{ "error": "<code>", "message": "<fixed text>" }` with the code above (never a path or OS text), and the body must be exactly
`{ "action": … }` (extra keys → `400 invalid`). Steps and checks: §6 "App copy".

### `POST /api/app/window` (body ≤ 4 KB, `CAP.small`)
The page asks the desktop shell to act on its window (0.4, F2). Body: exactly `{ "action": "quit" | "close" | "minimize" |
"zoom-in" | "zoom-out" | "zoom-reset" }`. Any other action, a missing or non-string one, or an extra key → `400 invalid` and
nothing is sent; a body that is not `application/json` → `415`, over the cap → `413`, no secret → `403` (§2). Success: the server
writes one `window` line to the shell (§5) and answers `204` with no body. The server does not know whether the shell acted:
`204` means the line was written. The page sends it from the keys the OS has no menu for (Linux: Ctrl+Q quit, Ctrl+W close —
not while "Type into pane" is on, where Ctrl+W goes to Claude — and Ctrl+= / Ctrl++, Ctrl+-, Ctrl+0 for zoom); on macOS the app
menu owns Command+Q/W/M and zoom and the page does not call this route. Not rate limited: the page sends at key-repeat
speed, and the shell clamps zoom to 0.5–3.0 (`docs/security.md`, residual risk k). Never mounted on the browser tier (§4).

### Projects

| Route | Request | Response |
|---|---|---|
| `GET /api/app/projects` | – | `{ "projects": [Project] }` |
| `POST /api/app/projects/pick` | empty object | `202 { "reqId": "<UUID>" }`; **429 busy** while a picker is open |
| `GET /api/app/projects/pick/:reqId` | reqId `UUID`, must be the open request | `200 { "state": "pending" }` · `200 { "state": "done", "project": Project }` · `200 { "state": "cancelled" }` · 404 unknown |
| `DELETE /api/app/projects/:key` | key `PROJECT_KEY` | `200 { "removed": true }` · 404 |
| `PUT /api/app/projects/:key/orchestrator` (0.4) | `{ "sessionId": "<UUID>" }`, JSON only, `CAP.small` | `200 { "orchestrator": Orchestrator }` · errors below |
| `DELETE /api/app/projects/:key/orchestrator` (0.4) | – | `200 { "orchestrator": null }` · 404 `not_found` (project not registered) |

`Project`:
```json
{ "key": "0123456789abcdef", "dir": "<abs realpath>", "name": "<basename, clean()>", "addedAt": "<ISO>",
  "rules": { "state": "none" | "nika" | "foreign" | "outdated", "settingsIgnored": true, "git": true } }
```
`orchestrator` (0.4, C1; app tier only, never on :3335): `null` (no saved orchestrator, or the transcript index could not be read) or
```json
{ "sessionId": "<UUID>", "state": "live" | "ended" | "gone", "name": "<clean(name)>" | null, "pane": "%3" | null }
```
It is checked against the transcript index, not the 24 h window: `live` = the session runs (its `pane` is set when tmux shows it),
`ended` = its transcript exists and it does not run (it can be resumed), `gone` = the id is saved but nika's index has no transcript
for it, **or the session belongs to another project** (the same membership check as Start and the PUT: a hand-edited config cannot make
the page show or open another project's session; `name` and `pane` are `null`). The picker's `project` carries the same field.

Cost: the page polls this route every 3 s, so the whole list is built from ONE snapshot (the cached 24 h one, shared with `/modes`;
a live session is always in it) and at most ONE transcript-index walk per request, whatever the number of projects: the picks
the snapshot does not hold are ended or gone, and `findSessions` settles all of them together (ids de-duplicated). It never runs a
full collect per project. With no snapshot, or an index that cannot be read, the field is `null` for the picks that could not be
settled (never a guess).

`rules.state`: `none` no `rules/orchestration.md`; `nika` written by nika and current, **and** every regular instruction file
carries the rules (see "AGENTS.md and CLAUDE.md" under Rules); `outdated` written by nika from an older template, or current but a regular
`CLAUDE.md` / `AGENTS.md` that Apply would still change; `foreign` a file nika did not write (apply needs the explicit
`overwriteForeign` flag). An instruction file nika cannot read safely (hard link, oversized, not UTF-8, a folder or other non-regular
`CLAUDE.md`, or a lone non-regular `AGENTS.md`) is never covered: the state is `outdated`, so Apply shows the reason. A
`CLAUDE.md` that is a symlink is ignored by the state (the rules file and a regular `AGENTS.md` decide); preview and apply
still refuse it with `ESYMLINK`.
`settingsIgnored`: `.claude/settings.local.json` is covered by the project's `.gitignore`.

**Saved orchestrator (0.4).** `PUT …/orchestrator` saves one session of the project as its orchestrator
(`perProject.<key>.orchestratorSessionId`, a lowercase UUID). The id is never a path: it must be a session nika itself indexed
(`findSession`: the transcript index, not the window). Order of checks, each answered before anything is written or any tmux
command runs:

| Status | `error` | When |
|---|---|---|
| 415 / 413 | `unsupported_media` / `too_large` | not `application/json`, or a body over `CAP.small` |
| 400 | `invalid` | the project key is malformed, or the body is not exactly `{ sessionId }` with a lowercase UUID |
| 404 | `not_found` | no such project, or the session is not in nika's index (transcript deleted) |
| 503 | `index_unavailable` | the index could not be read (never treated as "not found") |
| 409 | `other_project` | the session belongs to another project, or to none |
| 409 | `agent_session` | a live session whose pane is tagged `@nika-role agent` ("That session is an agent nika started, so it can't be the orchestrator. Nothing changed.") or `sub-orchestrator` (0.4: "That session is a sub-orchestrator nika started, so it can't be the orchestrator. Nothing changed.") |
| 409 | `orchestrator_running` | another session of the project runs as orchestrator (a live pane tagged `orchestrator`, or the live saved one; a sub-orchestrator is tagged `sub-orchestrator` and never counts) |
| 409 | `no_pane` | the session is live but has no tmux pane that runs claude |
| 409 | `busy` | another `PUT` for the same project is still running ("Another change to this project's orchestrator is still running. Try again."); answered right after the body check, before any lookup, tmux command or write |

One adoption at a time per project: the checks and the tagging run under an in-flight guard, so two overlapping `PUT`s (two
windows, a double click) cannot both pass "no other orchestrator runs" and tag two panes. The guard is released when the request
ends, whatever its answer. Other projects are not blocked.

Live with a pane: the pane gets `@nika-role orchestrator`, `@nika-agent <key>/orchestrator` and `@nika-depth 1` (`tagPane`, fixed argv, constant values; a start or a resume sets the same three), is recorded
as a nika pane (keys and mode control work) and the id is stored. Ended: only the id is stored. `Orchestrator` =
`{ sessionId, state: "live"|"ended", name, pane }` (the same reading as `GET /projects`, `orchestrate.js` `pickState`). `DELETE` forgets the id only: a live pane keeps its tags until it ends, and
nothing is retagged or killed. A project that is removed while a `PUT` runs answers 404.

The picker runs in the shell (`pick-folder` / `folder` messages, §5). The folder must be an absolute existing directory;
the server re-checks (`realpath`, `isDirectory`) before `addProject`. Projects are only added through the picker or
`nika projects add <dir>`; no route accepts a path.

### Settings

`GET /api/app/settings` → `200 Settings`. `PUT /api/app/settings` body ≤ 16 KB: a partial `Settings` (every key except
`projects` and `perProject`; object groups merge one level deep) → `200 Settings` (as re-read from disk) or
`400 invalid` with `"message"` naming the first bad field. `permissionMode: "bypassPermissions"` is always `400`. A body
with `perProject` is `400` ("per-project settings are saved on the project page"), and so is the old `plugins` group
(0.3.3 and older): it is an unknown key. Settings holds defaults for every project; the page's PUT carries the form and
nothing else, so it can never overwrite a project's saved choices.

`Settings` = the `config.json` schema (§6) without `projects`. It does include `perProject` (read only here), so a page can
show a project's saved plugins and models without a second request.

**`compaction` (0.4, C7)** — `{ "enabled": boolean, "pct": integer 20–95, "window": 200000 | 400000 | 1000000 | "model" }`,
default `{ true, 80, 400000 }`. It is a group like the others: a one-key patch (`{ "compaction": { "pct": 85 } }`) keeps the other two.
A fraction, 19, 96, a string, an unknown window (`300000`, `"400000"`, `"auto"`) or a non-boolean `enabled` is `400 invalid` naming the field
(`compaction.pct`, `compaction.window`, `compaction.enabled`); an unknown inner key is `400` too. It decides the launch environment of
every claude nika starts from then on: the orchestrator (fresh or resumed) and spawned agents and sub-orchestrators (§8). Running
sessions and sessions the user starts are untouched.

### `GET|PUT /api/app/projects/:key/config` (PUT body ≤ 16 KB, `CAP.settings`)
One project's own settings, saved on its page (0.3.4; models 0.4; permission mode, pane and agent limit 0.4.0). `:key` must match `^[a-z0-9]{16}$`, else `400 invalid`; a key
that is not a registered project is `404 not_found`.
- `GET` → `200 { "plugins": [ "<PLUGIN_NAME>", … ], "models": { "orchestrator": <id|null>, "reasoner": <id|null>, "builder": <id|null>, "scout": <id|null> }, "permissionMode": <mode|null>, "panePlacement": <placement|null>, "maxAgents": <1–8|null> }`.
  `plugins` are the names to turn on (`[]` when none). `models` always has the four role keys: the project's own `MODEL_ID`, or
  `null` for "use the default from Settings" (C5). `permissionMode`, `panePlacement` and `maxAgents` are always present: the
  project's own value, or `null` for "use Settings" (0.4.0).
- `PUT` takes **exactly one** of `{ "plugins": [ … ] }`, `{ "models": { … } }`, `{ "permissionMode": … }`, `{ "panePlacement": … }`
  or `{ "maxAgents": … }`, so the dialogs and the menus never overwrite each other. Two keys, an unknown key or neither is
  `400 invalid`. The answer is `200` with the project's new config (the `GET` shape), whichever key was sent; the others are
  left as they were.
  - `{ "plugins": [ "<PLUGIN_NAME>", … ] }`: `[]` removes the list (and the project's entry when nothing else is left):
    `enabledPlugins` is then left as it is when rules are applied. Each name must be installed now (the names from
    `/api/app/plugins`) **or already saved for this project** (so a plugin removed since can still be unticked); any other name
    is `400 invalid` naming it. More than 200 names or a name that is not a `PLUGIN_NAME` is `400 invalid`.
  - `{ "models": { "orchestrator", "reasoner", "builder", "scout" } }`: all four keys, each a `MODEL_ID` string or `null` (= use
    the default). A missing or extra role, a non-object, or an id that does not match `MODEL_ID` is `400 invalid`. An id need not
    be in the catalog (`GET /api/app/models`): a Custom ID is allowed. `null` removes that role; four nulls remove `models`
    (and the entry when nothing else is left). Only non-null roles are stored.
  - `{ "permissionMode": "<mode>" | null }`: one of `PERMISSION_MODES` (`default`, `manual`, `acceptEdits`, `plan`, `auto`,
    `dontAsk`). `bypassPermissions` is `400 invalid` ("bypassPermissions is never allowed") before the store sees it, like the
    same value in `PUT /api/app/settings` (rules constraint 12), and nothing is saved. Any other string, a non-string or `undefined`
    is `400 invalid` too.
  - `{ "panePlacement": "beside" | "under-last" | null }`: any other value is `400 invalid`.
  - `{ "maxAgents": <integer 1–8> | null }`: 0, 9, a fraction, a string or a boolean is `400 invalid`.
  - For these three, `null` removes the project's value ("Use Settings"; the entry goes when nothing else is left in it), and
    the answer shows that field as `null`. A value equal to the Settings one is still stored: the project keeps it when Settings
    changes later.
  - Non-JSON is `415`, a body over 16 KB is `413`.
The effective model of a role is the project's id where set, else `models.<role>` from Settings (`effectiveModels` in
`src/store.js`). It is what `nika` passes to `--model` when it starts the project's orchestrator (fresh start and resume) and
what the rules file's Roles table lists. Sessions already running keep their model. `nika spawn` keeps its explicit `<model>`
argument.
The effective permission mode, pane placement and agent limit are the project's value where set, else `permissionMode`,
`panePlacement` and `limits.maxAgents` from Settings (`effectiveAgents` in `src/store.js`). They decide the orchestrator's
`--permission-mode` (fresh start and resume), the default mode, the placement and the per-parent limit (and the project cap
`min(3 × N, 24)`) of a spawn, and the values the rules file shows, so "Rules current/outdated" follows a change. An explicit
`permissionMode` in a spawn request (the sheet, the CLI) still wins over the default. Sessions already running are untouched.
The route reads and writes only this project's entry, in the store's one serial queue, so two pages saving different
projects (or Settings and a project page) cannot overwrite each other.

### `GET /api/app/templates`
`200 { "templates": [ "<name>.md", … ] }` — file names (`^[A-Za-z0-9_-]{1,64}\.md$`, regular user-owned files via
`fsafe`, ≤ 50, sorted) in `configDir()/templates/`; `[]` when the folder is missing. Names only, never contents or
paths. Users add templates by copying a file into that folder (`nika doctor` prints it).

### Dashboard snapshot additions (`GET /api/agents`, both tiers)
Each group gains `"key": "<keyFor(repo root)>"` (16 hex, matches a registered project's key when the repo is
registered). Each agent gains `"role": "orchestrator" | "sub-orchestrator" | "agent" | null` (from the pane's `@nika-role`, read with
`list-panes -a -F …\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}`) and `"attention": "<clean(registry status, 80)>" | null` — set only when a live
agent's state is neither busy nor idle (e.g. waiting on a permission prompt), else null. The registry status `shell` (the turn is
over and a background shell still runs) counts as busy: `state` is `busy` and `attention` null (`claude-tui.md` §8). No paths or transcript text
are added.

0.4 adds the tree, on both tiers (the values are tmux tags nika itself set, read strictly: a value that does not parse is absent,
and the tags of a pane with no nika role are ignored):
- `"parent": "<session id>" | "<pane id>" | null`: the parent's session id when its pane maps to a live session in the snapshot, else
  the pane id (`%n`); `null` for a root, an ended agent, and for the main orchestrator and sessions nika did not start. Only agents and
  sub-orchestrators have a parent.
- `"depth": 1 | 2 | 3 | null`: the place in the parent chain, not the agent's own `@nika-depth` tag: a root (the main orchestrator, a
  session with no parent) is 1 and each parent above adds one, a parent pane that maps to no session counting as one; `null` for an
  ended agent. Never above 3.
- `"children": ["<session id>", …]`: the live agents whose parent it is (`[]` for an ended agent or a leaf).
A self-parent or a loop of parents is cut: every member becomes a root at depth 1. A page that gets a missing field (an older
server, a 0.3 pane) treats the agent as a root at depth 1.

0.4 adds the context size, on both tiers (C6), so the rows and the session header can show how full a session's context is:
- `"context": { "tokens": n, "window": n | null, "compactAt": n | null, "pct": n | null, "compaction": "on" | "off" | "none" } | null`.
  Numbers and one state word; no transcript text and no model id. `null` when the transcript's last assistant entry carries no usable usage
  (see below).
- `tokens`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the LAST assistant entry in the transcript's tail chunk
  (the same bounded head and tail read as everything else; an entry beyond the tail window is not read, and a head that is far behind the end
  is never used). A missing or `null` field counts as 0 (the API types allow `null` for the cache counts). A usage with a present, non-null field that is not a whole number from 0 to 10,000,000, or a sum above it, gives
  `null`; so does a last assistant entry with no usage. A synthetic entry (model `<synthetic>`: an interrupt or an API error, usage all zeros)
  is skipped, not read.
- `window`: the compaction window in tokens. Auto-compact on: the window the launch uses (`src/compact.js`: the setting's window, cut to the
  model's own, or the model's own for `"model"`; so a 400k setting on a 1M-window model is `400000`). Off: the model's own window. A model id
  the catalog does not know counts as 200k. `null` (with `compactAt` and `pct`) when the entry names no model.
- `pct`: `tokens / window x 100`, one decimal, not capped (over 100 is possible).
- `compactAt`: the launch threshold in tokens (`compactLaunch(model, compaction).compactAt`), and only for a live session nika started
  (its pane carries a nika `@nika-role`); `null` otherwise.
- `compaction`: `"off"` when Settings has auto-compact off (every session); else `"on"` for a live session nika started, and `"none"` for any
  other (a session nika did not start, or an ended one: nika's setting does not act on it, so its window is only a yardstick). An orchestrator
  nika adopted (O1) carries the tag but was started by the user, so it reads `"on"` until nika resumes it.
- The setting comes from nika's own `config.json` through the validated `loadConfig`, on both tiers; the browser tier (:3335) therefore
  also shows these numbers. The page formats them and never computes a window, a per cent or a threshold.

### `GET /api/app/plugins`
`200 { "plugins": [ "<PLUGIN_NAME>", … ] }` — installed plugin names read from Claude Code's config dir (names only,
never settings, hooks or keys), ≤ 200, sorted.

### `GET /api/app/commands?project=<key>`
`project` is optional; a malformed key → `400 invalid`, a key that is not a registered project → `404 not_found`.
```json
{ "commands": [ { "name": "compact", "description": "Summarize the conversation to free context", "argHint": "[instructions]", "source": "builtin" },
                { "name": "config", "description": "…", "argHint": "[key=value]", "source": "builtin", "dialog": true },
                { "name": "demo:lint", "description": "…", "argHint": "", "source": "plugin", "plugin": "demo" } ] }
```
`source` ∈ `builtin user project plugin`; built-ins come first. `name` has no leading `/` (the palette inserts
`/<name> `): the bare name for built-in, user and project entries, `<plugin>:<name>` for plugin entries. `argHint` is
`""` when none; `dialog: true` marks a built-in that opens a TUI dialog (`claude-tui.md` §4); `plugin` is set for
plugin entries. Without `project`: built-in, user and plugin entries (plugins install at user level); with it, project
entries too.

| Source | Files (top-level only) | Name |
|---|---|---|
| builtin | none: curated list in `src/commands-builtin.js` from `claude-tui.md` §4 | as listed |
| user | `<claude dir>/commands/*.md`, `<claude dir>/skills/*/SKILL.md` | command: file name without `.md`; skill: frontmatter `name`, else the folder name |
| project | `<project>/.claude/commands/*.md`, `<project>/.claude/skills/*/SKILL.md` | same |
| plugin | per `installed_plugins.json` key, one install record: the first whose `installPath` resolves inside `<claude dir>/plugins/cache`; then `<installPath>/commands/*.md`, `<installPath>/skills/*/SKILL.md` | `<plugin>:<name>`, `<plugin>` = the key part before `@` |

Reads: the first 4 KB of each file through `fsafe` (no symlinks, regular user-owned files); only the YAML frontmatter
(between a leading `---` line and the next `---`, `key: value` scalars; `description` may also be a `>`, `>-`, `|` or
`|-` block scalar, its lines joined with one space); a frontmatter that opens but does not close inside the 4 KB head
skips the file (the hide flag could lie past the cut); keys `name`, `description`, `argument-hint`, `user-invocable`
(`false` hides the entry); bodies are never read. Containment: a plugin's `commands/` and `skills/` folders and each
skill folder must resolve inside the plugins cache; a project's `.claude/commands` and `.claude/skills` must be real
folders and each skill folder must resolve inside the project; the user's own folders may be links (dotfile managers
link them). The check runs before the read (a swap in between needs write access to that folder, as `docs/security.md`
T8). A plugin key with no install record inside the
cache is skipped. `COMMAND_NAME` applies to the bare name (before the `<plugin>:` prefix); names that miss it and
command files in subfolders are skipped (they still work when typed). Text through `clean()`, description ≤ 200
chars; the page renders with `textContent`. Same name within one source: a skill wins over a command. Across sources
every entry is kept, each with its `source`. Bounds: ≤ 200 files per folder, ≤ 2000 files opened per scan, ≤ 1000 entries in total
(built-ins count), cached 10 s per project with one scan in flight per project; within the plugin source the first entry
with a given full name wins. Paths are never returned (T22).

### `GET /api/app/models`
```json
{ "models": [ { "id": "claude-opus-5-5", "label": "Opus 5.5", "group": "latest", "window": 1000000 },
              { "id": "opusplan", "label": "Opus plan, Sonnet build", "group": "alias", "window": 1000000, "note": "Opus in plan mode, Sonnet otherwise" } ] }
```
The static catalog in `src/models.js`, in catalog order; `group` ∈ `latest alias older`; IDs from `claude-tui.md` §6
only. No network call. A custom ID is accepted wherever a model is, when it matches `MODEL_ID`. `window` (0.4) is the model's
context window in tokens as Claude Code 2.1.319 believes it (spike S2): 1000000 for the 5.x ids and the aliases that resolve to
them, 200000 for the 4.x ids. `modelWindow(id)` drops one trailing `-YYYYMMDD` date suffix (transcripts record the dated id), then returns the catalog value, else 1000000 for
an id ending in `[1m]`, else 200000 (an unknown or custom id is treated as 200k, the conservative side). The page ignores `window`; the server uses it for auto-compact.

### `GET /api/app/session/:id/history?before=<n>&limit=<n>`
`id` must be a `UUID` present in nika's transcript index (never a path from the request). `limit` 1–200 (default 50),
`before` a byte offset returned as `nextBefore` by the previous page (default: end of file). The server reads at most
1 MB per request, 4 requests in flight, and drops any single entry over 32 KB (`"truncated": true`).
```json
{ "entries": [ { "id": "<byte offset of the line>:<block index>", "at": "<ISO>", "role": "user" | "assistant", "kind": "text" | "thinking" | "tool_use" | "tool_result",
                 "text": "<cleanBlock()>", "tool": "<name>?", "truncated": false } ],
  "nextBefore": 123456 | null }
```
Text is passed through `cleanBlock()` (first removes whole terminal escape sequences: CSI `ESC [ … final`, OSC
`ESC ] … BEL|ESC \` (an unterminated OSC drops the rest of the text) and two-character `ESC @`–`ESC _`, so `ESC[2mCompactedESC[22m`
reads `Compacted` and a link's text stays while its target goes; a literal `[2m` without ESC is text and stays; then keeps
`\n` and `\t` and strips every other control and bidi code point; `clean()` does the same for one line) and the
page renders it with `textContent`.

### `GET /api/app/pane/:id/capture`
`id` `PANE_ID`, must appear in the current `tmux list-panes -a`, be either a live Claude session's pane
(registry `tmux` field) or a pane nika started (`orchestrator/start`, `spawn`), **and** its `pane_current_command` must
look like claude (`CLAUDE_COMMAND`: `claude`, `node`, a version string) at that moment, for a started pane too (tmux can
reuse a pane id after a restart). Else 404. Cached 250 ms per pane,
one capture in flight per pane (others wait for it), `ETag` = hash of the mirror's rows hash **and** the `mode` and `modeConfirmed` the
response shows (so a held mode that changed over unchanged rows is never hidden behind a 304); `If-None-Match` → 304.
```json
{ "cols": 120, "rows": [ [ { "t": "text", "s": { "b": true, "fg": 4, "bg": null, "u": false, "i": false, "d": false } } ] ],
  "cursor": { "x": 0, "y": 0, "visible": true }, "etag": "<hex>",
  "mode": "plan", "modeConfirmed": true,
  "prompt": { "question": "Do you want to proceed?", "options": [ { "n": 1, "label": "Yes" }, { "n": 2, "label": "No" } ],
              "sig": "<16 hex>", "bypass": false },
  "draft": { "state": "text", "mode": "prompt", "text": "fix the typo in acme-api", "sig": "<16 hex>",
             "box": { "top": 33, "bottom": 35 }, "cursorAtEnd": true, "suggestion": null, "ghost": false, "edit": "insert" } }
```
Only SGR codes 0, 1, 2, 3, 4, 7, 22–24, 27, 30–37, 39, 40–47, 49, 90–97, 100–107 and 38/48;5;n or ;2;r;g;b survive
(colours as 0–255 or `[r,g,b]`; reverse video adds `"r": true` to the style only while it is on); everything else (OSC, DCS, other CSI, C0/C1) is dropped server-side (T9).

0.3 fields, parsed server-side from the same rows (`src/mode.js`, phrases and layouts in `claude-tui.md` §1–§2):
- `mode` ∈ `MODES` or `unknown`, read from the last non-blank row only (any number of trailing blank rows are
  skipped; Claude draws the mode line there). A token counts only at the start of that row: after at most 2 leading
  spaces, an optional `-- INSERT --` / `-- NORMAL --` prefix and optional `⏵` / `⏸` glyphs; a token elsewhere in the
  row (a file menu, a help line, a wrapped description) never counts. `manual` only on Claude's positive marker
  (`manual mode`); no recognized phrase → `unknown`, never `manual`; an otherwise unrecognized footer whose first word
  (after that prefix) is `bypass` or `bypassPermissions` (any case) → `bypassPermissions` (fail loud); so a permission
  prompt or dialog covering the footer → `unknown`. Claude's slash-command menu does not: checked 2026-11-14 (Claude Code
  2.1.325), the menu is drawn above the input box's top rule and the mode line stays, so `mode` and `draft` read as usual while it
  is open (`claude-tui.md` §10.1).
- `modeConfirmed` (boolean): `true` when `mode` is the footer reading. When the footer reads `unknown` (a permission
  prompt or dialog covers it, or the text is unrecognized), `mode` is the last mode read from this pane's footer (kept
  in memory per pane id, dropped when the pane leaves the eligible set), else, for a pane nika started, the recorded
  launch mode (`started` entry, §9: the `--permission-mode` passed, `manual` when none), and `modeConfirmed` is
  `false`; with neither, `mode` is `unknown` and `modeConfirmed` is `true`. A held or launch value is display only:
  the mode route reads the footer itself and never uses it. The switcher is disabled while `mode` is `unknown`,
  `modeConfirmed` is `false` or a `prompt` is open (the mode route would answer 409), and the page offers no
  Shift-Tab shortcut while a `prompt` is open.
- `prompt`: `{ "question", "options": [ { "n", "label" } ], "sig", "bypass" }` when Claude's permission prompt is on screen,
  else `null`. Layout (`claude-tui.md` §2), all within the last 15 non-blank rows: the closing hint row starting with
  `Esc to cancel` is the last non-blank row; the options sit directly above it, at least 2, numbered `1..k` (one digit each) without gaps
  (wrapped rows without a number join the label with one space); the question sits directly above option 1 and ends in
  `?`. Question and labels pass through `clean()`; question ≤ 200 chars, labels ≤ 80 chars. Unknown layouts (such as
  the unnumbered folder-trust dialog) give `null`, so no buttons. `sig` = the first 16 hex chars of sha256 over
  `lastNonBlank(rows, PROMPT_ROWS).join('\n')` (both from `src/mode.js`, so the window cannot drift), computed in
  `src/api-app.js`; the answer route checks it. `bypass` (boolean) = `bypassWindow(rows)`, the test the answer route and the
  keys guard apply: the prompt window (the same last 15 non-blank rows as `sig`, so also the tool-call lines above the
  question) mentions bypass (NFKC, letters only, any case). When `true` the page draws no answer button at all (every
  option as text with "Answer this one in the terminal"; Esc stays), because the answer route refuses every option
  with 400 then. An option whose label contains `bypass` (any case) also gets no button when `bypass` is `false` (rule 12). Labels can hold the user's folder paths: shown in the app only, never logged.

0.5 field, Claude's input box (`draft`), parsed server-side from the same rows by `src/draft.js` (reading rules, row shapes and the
wrap rule in `claude-tui.md` §10); the page mirrors it into the message box (spec §9.12):
- `draft` is `null` while the screen has no plain input box: the footer is not a known mode line (a permission prompt, a dialog,
  the transient `paste again to expand` hint), a permission prompt parses, there are
  fewer than two rule rows or nothing between the last two, the first box row is not the glyph `❯` or `!` followed by a
  no-break space, or the terminal cursor lies outside the rows of the box (`claude-tui.md` §10.1, §10.5: the box that parsed
  may be a status line, not the input). The page then shows every row of the mirror and does not sync. A capture with no cursor
  position at all has no box either (`draft: null`, `claude-tui.md` §10.5).
- Otherwise it is an object (all fields always present):

| Field | Value |
|---|---|
| `state` | `empty` (nothing but ghost text), `text`, or `unreadable` (never written over, §10.6) |
| `mode` | `prompt` (glyph `❯`) or `bash` (glyph `!`: Claude's `!` mode, the page's Shell toggle) |
| `text` | the draft with its rows joined (§10.4), ghost text and Claude's row padding removed; `''` for `empty` and `unreadable`. Not cleaned of zero-width characters: a textarea value only, never an HTML sink |
| `sig` | first 16 hex characters of sha256 over `state`, `mode` and `text`; `null` when `unreadable` |
| `reason` | present only when `unreadable`: `history`, `layout` (also a full row that reads two ways: one cut word, or two long words with a hidden space, §10.4), `tall`, `pasted` or `trailing` (checked in this order) |
| `box` | `{ top, bottom }`: the row indexes of the two rule rows; the mirror's rows above `top` are the cut of spec §9.12 |
| `cursorAtEnd` | the cursor sits right after the last real character of the last box row (padding does not count); `false` for `unreadable` |
| `ghost` | `true` when any dim, reverse-video or hint cell of the box was dropped as ghost text (the placeholder, a completion, the slash command's argument hint); `false` for plain text and for every `unreadable` draft (nothing was read). End and the commands do not press Enter on a box with `ghost: true` |
| `suggestion` | a string or `null`: Claude's prompt suggestion, the dim text Claude draws in an empty box after a turn (`claude-tui.md` §10.10), cleaned with `clean()` and cut at 200 characters; `null` when the box holds text, has no dim text, or the dim text is the box's own placeholder (it starts with `Try "`). It is not part of `sig` and not of `text`; the page shows it as the message box's placeholder and accepts it through `POST /api/app/pane/:id/suggestion` below |
| `edit` | `insert` (`-- INSERT --` shown now), `normal` (INSERT was seen on this pane before), `plain` (a probe `i` landed as text on this pane before) or `unknown`; the pane's memory, shown for display and route-side planning (the route reads the screen again, `claude-tui.md` §10.7). It is part of the ETag |

- The draft comes from the capture the route already took (no extra tmux call). App tier only: `/api/agents` and the browser tier
  never carry it (T51).

### `GET /api/app/modes`
`200 { "modes": { "%3": { "mode": "plan", "confirmed": true } } }` — one entry per eligible pane (same rule as
capture), keyed by `PANE_ID`; `mode` and `confirmed` as capture's `mode` and `modeConfirmed` (the key stays
`confirmed`). Reads go through the mirror's capture cache (250 ms per pane, one capture in flight per pane), at most 4
captures at once; a pane whose capture fails is left out. The app-tier dashboard polls it every 3 s. This route is the
"app-tier snapshot" mode of spec §6.1: `/api/agents`, shared by both tiers, stays unchanged and gains no mode.

### `POST /api/app/pane/:id/keys` (body ≤ 20 KB)
```json
{ "text": "<≤ 1024 chars, no C0/C1 controls>", "paste": "<≤ 16 KB UTF-8, multi-line>", "keys": [ "Enter" ] }
```
At least one of `text`, `paste`, `keys`; `text` and `paste` are mutually exclusive (→ 400). `text` with any C0/C1
control → 400. `paste`: `\r\n` and `\r` become `\n`; every other C0 except `\n` `\t`, DEL, C1 and ESC is stripped (so
the bracketed-paste end marker cannot be forged), then sent with bracketed paste (§8); tmux turns `\n` into CR inside
the paste (no `-r`), as a terminal paste would. Every validation failure, including size, is `400 invalid`. `keys` ≤ 8 entries, each ∈
`KEY_NAME`, sent after the text or paste. Same pane rule as capture. 20 requests/s per pane → **429**. Response
`200 { "sent": { "text": 12, "paste": 0, "keys": 1 } }` (counts of characters / keys sent). Stop is no longer this route:
it is `POST /api/app/pane/:id/stop` below (a bare `Escape` does not interrupt Claude while its input is in vim insert mode).

Bypass-prompt guard (0.3, T26). `Enter` confirms the highlighted option of a permission prompt, a digit picks one, and
`BTab` (Shift-Tab) can pick "allow for this session", so a request whose `keys` contains `Enter` or `BTab`, whose `text`
contains an ASCII digit `[0-9]`, or that has any `paste`, first takes a fresh capture (never the 250 ms cache) and looks at
the screen:

- the capture fails → that status and body, nothing sent;
- the prompt window, `bypassWindow(rows)` in `src/mode.js` (the last 15 non-blank rows, the same window the `sig` covers;
  `mentionsBypass`: NFKC, letters only, any case, so `By-pass` and full-width letters count), mentions bypass **and** a
  permission prompt is on screen (`prompt` non-null) → `409 { "error": "bypass-prompt", "message": "Answer this prompt in
  the terminal" }`, nothing sent;
- the window mentions bypass, no prompt parses, **and** the footer is unreadable (`mode` would be `unknown`: a dialog nika
  does not parse, with another hint row, may be open) → `409 { "error": "screen-unclear",
  "message": "nika can't tell what Claude is showing; use the terminal" }`, nothing sent. This is the unreadable-footer
  case of the guard, with its own code so the page does not call a dialog that merely mentions "bypass" a
  bypass prompt;
- a readable footer, whatever it says, is not a prompt: a session that runs in bypass can still be typed to (and leave it
  with Shift-Tab), and the word in plain output does not block;
- else the request goes out as before.

A request with none of those (letters without digits, arrows, `Escape` and the other named keys except `Enter` and `BTab`) skips the capture and
is as fast as in 0.2. The mode route's own presses go through `keys.send` directly, not this route, so mode switching is
unaffected. The page's passthrough posts to this route as well (Shift+Tab maps to `{ "keys": ["BTab"] }`), so it is
guarded like Send: nothing in nika can answer such a prompt, only the terminal itself (outside nika) can. nika never moves a session into bypass (rule 12). The guard's
capture runs before the per-pane rate limit (T11).

Send of a synced message box (0.5): when Claude's input box already holds the message box's text (`draft` of the capture, spec
§9.12), the page's Send is `{ "keys": [ "Enter" ] }` on this route and passes the same guard, unchanged (Enter is a guarded key).
When the texts differ, the page first calls `PUT /api/app/pane/:id/draft` below and sends that `Enter` only after a 200. An empty
message box whose Claude input shows a suggestion (`draft.suggestion`) still sends `Enter` alone; what Claude submits then is
not verified (`claude-tui.md` §10.11).

### `PUT /api/app/pane/:id/draft` (body ≤ 20 KB, `CAP.keys`)
Makes Claude's input box hold the page's text, safely (draft sync, 0.5; `docs/security.md` T51). It never presses `Enter`: Send
does that through the keys route.
```json
{ "text": "<at most 1024 characters; \n and \t allowed, no other control character>", "base": "<16 hex, or \"\">" }
```
`base` is the `sig` of the `draft` the page last saw (or `""` before its first capture, which no screen matches). The body is
exactly these two keys. Success: `200 { "draft": { … }, "typed": 12 }`. The pane check, the guard and the one-lock rule are as for
the other control routes. Checks and steps, in this order (every step fails closed: nothing is sent after a refusal):

1. Body invalid → `400 invalid`: not exactly the keys `text` and `base`; `text` not a string, over 1024 characters, holding a C0
   control other than `\n` and `\t` (`\r` included), DEL or a C1 control, or more than 12 newlines; `base` neither 16 lowercase hex
   characters nor `""`. This check runs before the pane check.
2. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane (mode switch, answer,
   command, End or another draft write) → 409 `busy-switching` (the page retries after its next capture). Stop takes no lock.
3. Fresh capture (never the cache) and registry state. A capture that fails → its status and body.
4. A permission prompt on screen → 409 `not-idle` (T51: a draft write never lands in a prompt).
5. No plain box (`draft` would be `null`, which includes a cursor outside the rows of the box, a box that may be a status line):
   footer unknown → 409 `mode-unknown` (a dialog may be open); otherwise → 409 `input-unreadable`, with no `draft` key.
6. `state` is `unreadable` → 409 `draft-unreadable` with `reason` (nika never writes over a draft it cannot read).
7. `draft.sig` differs from `base` → 409 `draft-changed` (the terminal changed since the page looked; the page pulls).
8. The trailing spaces and tabs of `text` are removed (they are invisible in the box and would make it unreadable), then the text
   must be inside the envelope for the pane's width: 1024 characters, 12 newlines, 13 estimated rows (`claude-tui.md` §10.9), no
   run of 699 or more spaces and tabs; else `400 invalid` ("text does not fit the input box"). The page runs an exact twin of this
   envelope check (browser code cannot import `src/`; `test/draft-sync.test.js` asserts the twin answers like `src/draft.js`) before it
   calls this route and never sends a text that fails it, so a text the page passes the server passes too.
9. The screen already reads as `text` (spaces at line ends, tabs and no-break spaces compared as `claude-tui.md` §10 says) →
   `200 { draft, typed: 0 }`, nothing sent.
10. Plan: **append** (the cursor is at the end, the new text starts with the old text, the mode (`❯` or `!`) agrees, and Claude is in
    insert mode, or in remembered plain mode with an old text that does not end in a newline: only the new part is typed), **type**
    (the box is empty), or **replace** (clear, then type). A replace needs the registry state `idle`, else 409 `not-idle`
    (`Escape` can interrupt a running turn); an append or a type into an empty box may run while Claude works, as typing in the
    terminal would.
11. Run the plan (`claude-tui.md` §10.8 for the keys and waits, §10.9 for the chunks). A fresh capture is taken before **every**
    key or chunk and must still show a plain box (so with the cursor in it), no permission prompt, and exactly the text the previous
    step left: no box (a cursor that left the box counts) or a prompt, or other text (the user typing in the terminal) → 409
    `screen-changed` (`draft: null` when there is no box), nothing more is sent; an unreadable box → 409 `draft-mismatch`; an interrupt
    (Stop's, or End's, which holds the lock first) running on the pane → 409 `not-idle` with that key not sent. A wait that runs out → 409 `draft-mismatch` (and the pane's vim/plain memory is dropped, so the next write probes), or
    409 `mode-unknown` when `-- INSERT --` never went after the first `Escape`.
12. Read back, up to 4 fresh captures 150 ms apart: the box is readable and reads as `text` → `200 { draft, typed }` (`typed` =
    characters typed, not counting a `!` that moved to the glyph); any difference → 409 `draft-mismatch`.

A key send that fails (for example 429, or a tmux error) stops the sequence and answers that status and body plus the `draft` of one
more fresh read (best effort). Every key counts toward the keys route's 20 requests per second per pane.

**`draft` in the answers.** It is the parse the page needs for its next `base` (an object of the capture's shape, with `edit`, or
`null`); it is the only draft-derived data the server returns, and it is the screen's, never the request's text.
- Present: the 200s, 409 `draft-unreadable` (with `reason`), `draft-changed`, `screen-changed` (`null` when the box is gone or the
  cursor left it), `draft-mismatch` (an unreadable draft included, so `draft.state` says so), `mode-unknown` after a wait that ran out,
  `not-idle` of step 10 (a replace while Claude is busy) or of a refused key while Stop or End interrupts, and a failed key send.
- Absent: 400, 404, 409 `busy-switching`, a failed capture, and `not-idle`, `mode-unknown` and `input-unreadable` of steps 4 and 5
  (nothing was read or nothing is a plain box) and `not-idle` of the registry-state check right before an `Escape`.

The page adopts the `draft` of `draft-changed`, `screen-changed` and `draft-mismatch`: the terminal wins.

**Never sent** by this route: `Enter`, `Tab`, `C-c`, `Up`, `Down`, `C-k`, `BTab`, a digit as a key (a draft that is one digit goes as literal
text), a second `Escape` on an empty box, any key within 40 ms of an `Escape` (its own, or the `Escape` of a Stop or End: a key right behind an `Escape` would be read as
Meta plus that key), any key while Stop or End interrupts the pane, and an `Escape` while the registry state is not `idle`. The keys it does send: literal text and bracketed pastes (`send-keys -l --`, at most
700 characters per call, at most 2 newlines per paste, never ending in a space or tab), `Escape` (vim: once, then the text `ggdG` and
`i`; plain: once, and a second one at least 60 ms later only while text still shows), a probe `i`, one `C-u` to remove that probe's
own `i` from an empty box, and one `BSpace` to leave `!` mode (`claude-tui.md` §10.8).

Logging: nothing of the body or of a draft (no text, no `sig`, no `base`) goes to a log or the console; errors carry the pane id and
the code only. The route exists on the app tier only.

### `POST /api/app/pane/:id/suggestion` (body ≤ 4 KB, `CAP.small`)
Takes Claude's prompt suggestion into Claude's input box: the page's `Tab` (or `→`) in an empty message box that shows the
suggestion as its placeholder (spec §9.12; the suggestion itself is `draft.suggestion`, `claude-tui.md` §10.10). Draft sync, 0.5
(W4; `docs/security.md` T51). It is not the plain keys route: a `Tab` that lands after the suggestion went away, or after a
permission prompt opened, goes where the user did not mean, so nika presses it only on a fresh screen that still shows exactly the
suggestion the page shows, and presses nothing else.
```json
{ "text": "<the suggestion the page shows, 1 to 200 characters, no control character>" }
```
The body is exactly the one key `text`. Success: `200 { "draft": { … } }` (the parse of the screen after the `Tab`, with `edit`, the
capture's shape). Same pane rule as capture and the same one-lock rule as the other control routes. Checks and steps, in this order
(every step fails closed: nothing is sent after a refusal):

1. Body invalid → `400 invalid`: not exactly `{ text }`; `text` not a string, empty, over 200 characters, or holding any C0
   control (`\n` and `\t` included), DEL or a C1 control. This check runs before the pane check.
2. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane (mode switch, answer,
   command, End or a draft write) → 409 `busy-switching`. Stop takes no lock.
3. The registry state, read fresh (skipping its cache), is not `idle`, or Stop's or End's interrupt is running on the pane → 409
   `not-idle`, no `draft` key (a `Tab` could take a suggestion into a box while Claude works).
4. One fresh capture (never the cache): the only capture before the key. A capture that fails → its status and body. A permission
   prompt on screen → 409 `not-idle`. No plain box (`draft` would be `null`: footer unknown → 409 `mode-unknown`; otherwise, a cursor
   outside the box included, 409 `input-unreadable`), both without a `draft` key (a second cursor check behind the parser, never
   reached while the parser holds, would answer `draft: null`). `state` is `unreadable` → 409 `draft-unreadable`
   with `reason` and `draft`.
5. The box must be `empty`, in `prompt` mode, with `draft.suggestion` equal to `text`; anything else (text typed, the suggestion
   changed or gone, a `!` box) → 409 `draft-changed` with `draft` (the page adopts it). Nothing is sent.
6. Exactly one key, `Tab`, through the keys path (it counts toward the 20 requests per second per pane; a 429 or a tmux error stops
   here and answers that status and body plus the `draft` of one more fresh read, best effort). A Stop or End interrupt that started
   meanwhile, or whose `Escape` went out less than 40 ms ago → 409 `not-idle` with `draft`, `Tab` not sent.
7. Read back, up to 4 fresh captures 150 ms apart: the box is readable, `state` `text`, `prompt` mode, and its text equals `text`
   (compared as the draft write compares, `claude-tui.md` §10) → `200 { draft }`. Else → 409 `draft-mismatch` with the `draft` last
   read (`null` when the box is gone). The `Tab` is never repeated.

Never sent by this route: anything but that one `Tab`. No `Enter` (the page's Send does that, through the keys route), no
`Escape`, no text. Nothing of the body or of a draft is logged (errors carry the pane id and the code only). The route exists on the
app tier only; the browser tier has no draft and no suggestion (T51).

Known limit: a suggestion of exactly 200 characters may be cut by `clean()` in the parse; the page then holds the cut text, Claude
takes the whole suggestion, and the read-back differs, so the answer is 409 `draft-mismatch` although the `Tab` worked. The page
adopts the screen's `draft` and shows what Claude holds.

### `POST /api/app/pane/:id/mode` (body ≤ 4 KB, `CAP.small`)
```json
{ "target": "plan" }
```
Success: `200 { "mode": "plan", "presses": 2 }`. In this route, answer and End a *fresh capture* skips the mirror's
250 ms cache, and one control action (mode switch, answer or End) runs per pane at a time. Checks and steps, in this
order:

1. `target` ∉ `MODE_TARGETS` (`bypassPermissions`, `dontAsk`, `default`, missing, …) → `400 invalid`.
2. Ineligible pane (same rule as capture) → `404 not_found`.
3. Another control action (mode switch, answer or End) is running on this pane → 409 `busy-switching`.
4. Fresh capture. The registry state of the live session on that pane is not `idle` (a pane with no live session, or one
   claimed by two live sessions, is never idle; the state comes from the eligibility snapshot, at most 1 s old), or a `prompt` is on screen → 409 `not-idle`, also when the mode already equals the target.
5. Footer `unknown` → 409 `mode-unknown`, no press (an unreadable footer can mean a dialog is open; the recorded launch
   mode is never used to press blind).
6. Mode equals `target` → `200 { "mode", "presses": 0 }`. Mode `dontAsk` → 409 `not-in-cycle`, no press (nika never
   switches to or from it, `claude-tui.md` §7).
7. Loop: press `BTab` through the keys path (presses count toward its 20 requests/s per pane); a failed send → that
   send's status and body plus `"presses"`. Re-read the footer (fresh captures) every 300 ms for up to 1.8 s until the mode differs
   from the pre-press mode; an `unknown` read keeps polling; at 1.8 s: every read was readable and equal to the pre-press
   mode (the key did not register, or Claude redrew late) → 409 `mode-unchanged` (`presses`); any read was `unknown` → 409
   `mode-unknown`. Then: target reached → 200; back at the start mode → 409 `not-in-cycle`; 6 presses used → 409
   `not-in-cycle`; else re-run step 4's idle check with the registry state read again (→ 409 `not-idle`) and press
   again.

The cycle may pass through `bypassPermissions` on the way when Claude's cycle holds it (a session the user launched
with bypass allowed); nika never targets it (rule 12). A 409 or a failed send after some presses leaves Claude in the
mode the last press reached; the page reads it from the next capture. Bypass is never left behind silently (0.3, T23):

- **`presses` in every failure.** Every non-200 answer after at least one press carries `"presses": <n>` in its body, the
  409s of the footer wait and the idle re-check included (a failed send carries it also with 0).
- **The held mode is forgotten.** When such an answer comes back, the route sets the pane's held mode to `unknown`
  (it was the last footer reading, and the footer has changed since), so the next capture whose footer cannot be read
  reports `mode: "unknown"` instead of a mode that is no longer true, and a started pane's launch mode no longer stands in.
- **No registry wait inside bypass.** When the footer read after a press is `bypassPermissions`, the next press does not
  need registry state `idle` (Claude in bypass runs its tools unasked, and a busy registry must not stop the switch from
  leaving it): a fresh capture is taken, a permission prompt on screen or an unreadable footer ends the switch with
  409 `{ "error": "stopped-in-bypass", "presses": n }`, otherwise the loop presses again within the same 6-press limit.
- **One retry of the press that leaves bypass.** A key send answering 429 while the footer last read
  `bypassPermissions` waits 1 s and is tried once more; a second failure is `stopped-in-bypass`.
- **Every other ending in bypass is loud.** Not in the cycle, 6 presses used, a failed send, an unchanged footer
  (`mode-unchanged` becomes `stopped-in-bypass` when that unchanged mode is `bypassPermissions`), or a
  footer that stays unreadable after a press that started in `bypassPermissions` (that press may have changed nothing),
  while the last footer reading is `bypassPermissions` → 409 `stopped-in-bypass` with `presses` (the page tells the user
  Claude may still be in Bypass). A footer that stays unreadable after a press that started in any other mode (the screen
  never showed bypass) is 409 `mode-unknown` with `presses`; a footer that stayed readable and equal to that mode is 409
  `mode-unchanged` with `presses` (the page says "The mode didn't change; try again or use the terminal." in a calm line,
  with no Bypass alert).

### `POST /api/app/pane/:id/answer` (body ≤ 4 KB, `CAP.small`)
```json
{ "n": 1, "sig": "<16 hex>" }
```
Answers a permission prompt with a fresh parse (T26); "Esc = No" stays the keys route with `{ "keys": [ "Escape" ] }`.

1. `n` not an integer 1–9, or `sig` not 16 lowercase hex chars → `400 invalid`.
2. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane → 409
   `busy-switching`.
3. Fresh capture. No `prompt` on screen → 409 `no-prompt`.
4. The prompt's `sig` differs from the body's → 409 `prompt-changed`. The same `sig` was answered on this pane in the
   last 3 s (a double click, or a second window, before Claude redraws) → 409 `already-answered`, nothing sent.
5. `n` is not among the prompt's options, or the prompt mentions bypass anywhere in its window: the last 15 non-blank
   rows (question included, not only the option's label), the option's label or its full wrapped text (`mentionsBypass`,
   any case; rule 12: nika never moves a session into bypass) → `400 invalid`, "this option is answered in the terminal".
6. Send the digit as literal text through the keys path (`send-keys -l -- <n>`, counts toward its 20 requests/s per
   pane; no Enter, `claude-tui.md` §2) → `200 { "answered": 1 }`; a failed send → that send's status and body.

### `POST /api/app/pane/:id/command` (body ≤ 4 KB, `CAP.small`)
```json
{ "text": "/compact" }
```
Types one slash command into Claude's input and presses Enter, safely; the quick actions (Compact, Clear, Model, and
Rewind, which sends `/rewind`) use it. `text` = `/` + a `COMMAND_NAME`, optionally one space and arguments, ≤ 200 chars, no C0/C1 controls, else
`400 invalid`. The composer's own Send stays the keys route (the user's typing passes through as in 0.2).

1. Ineligible pane → `404 not_found`. Another control action running on this pane → 409 `busy-switching`.
2. Fresh capture and registry state: not `idle`, or a `prompt` on screen → 409 `not-idle` (no Escape here; Stop is
   its own button). Footer `unknown` → 409 `mode-unknown`.
3. The input-box, vim and typing checks of End's steps 4–6 with `text` in place of `/exit` (a text that wraps onto a
   second row fails the exact one-row check → `C-u`, 409 `not-at-prompt`) → `200 { "sent": true }`; a failed send
   → that send's status and body.

First-character probe (End's step 5 and this route, 0.3). Vim normal mode draws no marker, and a `/` typed there
opens a history search instead of a slash (`claude-tui.md` §5). So when nothing says vim is on (no remembered
`-- INSERT --` for the pane, none seen in this action) and `-- INSERT --` is not shown, nika types `/` alone (every
command text starts with `/`) and takes fresh captures (up to 4, 150 ms apart) until one of three things shows:

- the input box reads exactly `❯ /`: the plain input; nika types `text` without its first character and goes on to the
  exact read-back of the whole text and Enter;
- a row of the last 3 non-blank rows holds `Esc i / for slash commands` (the history search): nika sends `Escape`, waits
  until the empty input box is back, then takes the vim road (`i`, require `-- INSERT --`, which records vim for this action only; the pane's own memory is the capture route's)
  and types the whole `text`; the box not coming back is 409 `not-at-prompt`;
- anything else, or nothing within the reads: nika's `/` is removed as far as cleanup can tell it from a draft
  (`C-u` rounds) and the answer is 409 `not-at-prompt`; no Enter.

A failed send of the rest (after the `/` went in) removes nika's `/` the same way before that send's status and body are
returned. A draft in the box is never touched: the empty-box check of step 3 comes first (409 `input-not-empty`; a box
nika cannot find or read is 409 `input-unreadable`, End's step 4).

### `POST /api/app/pane/:id/stop` (body ≤ 4 KB, `CAP.small`)
Body `{}` (a JSON object, `Content-Type: application/json`). Interrupts Claude's turn; the session stays. Same guard and
pane rule as the other control routes. It does **not** take the per-pane lock (a mode switch, command or End that is
waiting must not block Stop), but there is one interrupt per pane at a time (End's interrupt shares it). The session window's Stop button and Ctrl+C in its message box (0.3.3) post here. Steps:

1. Ineligible pane → `404 not_found`.
2. Fresh capture and registry state. A permission prompt on screen → 409 `prompt-open` (Stop never answers a prompt; use
   the prompt buttons or Esc). The state is not a non-empty string other than `idle` (idle, no live session, two sessions
   on the pane) → 409 `not-busy`, nothing sent.
3. Interrupt. Without `-- INSERT --` on screen: one `Escape`. With `-- INSERT --` (Claude's vim insert mode; the first
   `Escape` only leaves it, `claude-tui.md` §5): send `Escape`, take fresh captures (up to 4, 150 ms apart) until
   `-- INSERT --` is gone (still shown → 409 `mode-unknown`, no second key), read the registry state again **uncached**
   (the server drops its 1 s eligibility snapshot first), and send a second `Escape` only if it is still busy. Another
   interrupt (a Stop, or End's) already running on the pane → 409 `stopping`, nothing sent.
4. `200 { "stopped": true, "presses": 1 }` (or `2`). A failed capture or key send → its status and body.

### `POST /api/app/pane/:id/end` (body ≤ 4 KB, `CAP.small`)
Body `{}`. Steps, in this order:

1. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane → 409
   `busy-switching`.
2. Fresh capture and registry state. A `prompt` on screen: send `Escape` once (cancel, the "No" path). A registry state
   that is a non-empty string other than `idle` (busy): interrupt as the stop route above does (in vim insert mode two
   `Escape`s, the second only while the registry still says busy, read uncached; a Stop already interrupting the pane →
   409 `not-idle`, nothing sent). No state at all (no live session on the pane, or two
   claim it) with no prompt on screen → 409 `not-idle`, **no key sent**. After an `Escape`: wait 1 s, then take a fresh
   capture and read the registry state again.
3. The state is still not `idle`, or a `prompt` is still on screen → 409 `not-idle`, nothing typed. Footer `unknown`
   (a dialog may be open) → 409 `mode-unknown`, nothing typed. So End can never answer a prompt or a dialog.
4. Input box (`claude-tui.md` §5: the rows between the last two rule rows, each a plain rule of `─` or one that carries
   the session name, `─── <name> ─`; the no-break space after `❯` compares as a space). Two answers, both with nothing
   typed (0.3.4):
   - `input-unreadable`: no box found (fewer than two rule rows, or nothing between them), or its first row is not an
     input row (no `❯` where the box should start: a menu or another screen is drawn there). nika cannot tell a draft
     from nothing, so it types nothing; the page says it cannot find Claude's input box and to close any menu.
   - `input-not-empty`: the box starts with an input row and holds anything but the empty or placeholder state. It must be
     exactly one row reading `❯` alone, or `❯` followed only by dim text (the placeholder; a draft is never dim,
     whatever it says), where the first character may be reverse video (Claude's cursor over the placeholder) and
     whitespace may be plain; anything else (typed text, a `Try "..."` that is not dim, several rows) is a draft, and
     the page says to send or clear it in the terminal.
   - 0.5: the box is read by `src/draft.js` (`claude-tui.md` §10), the reader the capture's `draft` uses, which sharpens the two
     answers. `input-unreadable` also covers a `History n/m` top rule (an old prompt is showing, the real draft is kept aside),
     rows nika does not know (dim text beside real text included) and a box the terminal cursor is not in (N-1: it may be a
     status line, so there is no box at all). `input-not-empty` also covers a `!` box (message "Claude's
     input is in ! mode"), a pasted block (`[Pasted text #N]`, `[Image #N]`), a box of 14 rows or more and trailing spaces at the
     cursor. An empty box is `❯` and nothing, or `❯` and ghost text (dim, or the grey argument hint after the cursor); the
     reverse-video first character is a tolerance. Enter goes out only when the box reads exactly the typed text on one row,
     in `❯` mode, with `ghost: false`.
5. Vim: when this pane's mode line has shown `-- INSERT --` before (remembered per pane id by the capture route, like
   the held mode, or seen in any capture this action took) and the current mode line lacks it, Claude's input is in
   vim normal mode: send the text `i`, take a fresh capture, and require `-- INSERT --` now. If it does not show and
   the box reads exactly `❯ i` (vim was turned off; the `i` landed as text), remove it with one `C-u`; then 409
   `mode-unknown`.
6. Send the text `/exit` (`send-keys -l -- /exit`), take fresh captures (up to 4, 150 ms apart, stopping at a match):
   the input box must be exactly one row `❯ /exit` (one separator space after `❯`, then the text, then only
   whitespace). If not, clean up and answer 409 `not-at-prompt`, no Enter. Clean
   up = up to 6 rounds, 150 ms apart, of: fresh capture; box empty → read once more after 150 ms (a late redraw), still empty → done; the box's text (rows joined, `❯` and row indents removed)
   is a non-empty prefix of what nika typed (spaces ignored: a word-wrap can drop one) → send `C-u`; anything else → stop and leave it (it is not only nika's
   text). `C-u` clears one visual row (`claude-tui.md` §5), hence the rounds. Else send `Enter`.
7. Check the pane every 500 ms for up to 3 s (by count, not by clock): gone or no longer running claude
   (`CLAUDE_COMMAND`, after trimming) → `200 { "ended": true }`; else `200 { "ended": false }`.

When any key send (or a capture) fails (for example 429) the sequence stops and the pane is checked once: gone or no longer
running claude → `{ "ended": true }`, else `{ "ended": false, "reason": "keys" }`. `reason` appears only here, never on
`ended: true`, never on the plain `ended: false` of step 7 (every key went out and Claude did not exit) and never on a 409:
the page says "nika couldn't send the keys; try again." for `"keys"` and "Claude didn't exit; use Stop or the terminal."
otherwise. Never `kill-pane`, never a signal. The eligibility cache is reset afterwards.

### `POST /api/app/spawn` (body ≤ 80 KB)
```json
{ "project": "<PROJECT_KEY>", "name": "<AGENT_NAME>", "model": "<MODEL_ID>", "brief": "<≤ 64 KB, more than one word>",
  "permissionMode": "<PERMISSION_MODES>?", "under": "<PANE_ID>?", "session": "<TMUX_SESSION>?", "rc": "off|<RC_PREFIX>?",
  "role": "agent|orchestrator?", "parent": "<PANE_ID>?" }
```
A one-word `brief` (no whitespace once trimmed) → 400 `brief must be more than one word`: the brief is claude's positional
prompt after `--`, and a lone `update` or `doctor` could be read as a subcommand; `_run-agent` refuses a stored one-word
brief too (exit 3). `permissionMode` defaults to settings; `bypassPermissions` → 400. `rc` overrides the Remote Control setting for this
agent. `under`: split `-v` below that pane (unknown pane → 404, pane in another session than `session` → 400; the
response `session` is the pane's session). With neither `under` nor `session`, a spawn under a `parent` (see Nesting) opens beside that
parent, in the parent's own tmux session (read from the tags listing, and only when the name is a valid `TMUX_SESSION`), so an orchestrator
adopted from the user's own tmux session keeps its children with it; an explicit `under` or `session` always wins, and with no parent, or a
parent session name that is not valid, the project's session is used as before.

**No server or no project session (0.4).** When the session to use does not exist, because no tmux server runs or the server has no
session of that name, and it is the project's own (`TMUX_SESSION` reduction of its name, §8), the spawn creates it: one `new-session -d
-s <session> -n agents …` (§8) whose first pane runs the agent, tagged and titled like any spawned pane. There is no placement then
(`beside` and `under last` apply only to a session that exists). A named `session` that is not the project's own and does not exist is
still `404 not_found` (`tmux session <name> not found`, nothing started): nika creates only the project's session. A failed `new-session` is
`502 tmux_failed`; `503 tmux_unavailable` now means only that the tmux binary is missing (no binary, or ENOENT when it is run). A failing
listing counts as "no server" only when tmux says so (`NO_TMUX_SERVER` in `src/tmuxerr.js`: `no server running`, or `error connecting to …`
ending in `(No such file or directory)` or `(Connection refused)`); any other listing failure, and two listings that disagree, are `502
tmux_failed` with nothing created, because the parent, the depth and both caps are read from that listing.

**Early exit (0.4).** Once the pane is created and tagged, nika waits 1 s and asks tmux whether the pane still exists and is not dead
(§8, `display-message … #{pane_dead}`; a tmux error or a timeout on this call counts as gone too, even if the pane is in fact still alive). A pane that is gone or dead means claude died at launch (a login
needed, a broken install) and took the pane, and a server nika had just started, with it: nothing is recorded (`.last-pane`, the title) and the
answer is `502 claude_exited`, message "Claude exited right after it started. Run `claude` once in a terminal in this folder to see why (for
example, to log in)." The same check runs for Start and Resume. One check at 1 s: a claude that dies later is not caught here. Response:
```json
{ "pane": "%12", "session": "<tmux session>", "sessionId": "<UUID>", "reports": { "dir": "<stateDir>/projects/<key>/reports",
  "session": "<name>.session", "report": "<name>.md", "rc": "<name>.rc", "remote": "<name>.remote" } }
```

**Nesting (0.4, ADR 0013).** `role` defaults to `agent`; `orchestrator` starts a *sub-orchestrator* (its pane is tagged
`sub-orchestrator`). Both values are checked: anything else is 400 `invalid`, as is a `parent` that is not a pane id. The parent is
the pane the request names (`parent`; the CLI sends `$TMUX_PANE`, §7) and **only its tags in tmux decide what it is**; depth and
role are never read from the request, argv, env or a file. From one fresh `tmux list-panes -a` (the format in §8):
- no `parent`, or a pane with no `@nika-role` at all (a shell, the page's header) → the parent is "you": the child is depth 1 and
  its role can only be `agent`. For the CLI, a `$TMUX_PANE` that is absent, not a pane id, or not listed is "you" too;
- a parent that is this project's **main orchestrator** (role `orchestrator` with `@nika-agent <key>/orchestrator`, or a 0.3 pane
  with no `@nika-agent` tag in the project's tmux session and the window named `orchestrator`; `@nika-depth` absent or `1`) →
  depth 2, role `agent` or `orchestrator`;
- a parent that is this project's **sub-orchestrator** (`@nika-agent <key>/<name>` for this project and `@nika-depth 2`) → depth 3,
  role `agent` only;
- **any other pane that carries a nika `@nika-role` → `409 depth`**: an agent (of any project), an orchestrator or sub-orchestrator of
  another project (a 0.3 orchestrator outside this project's session and window included), a tag that does not parse, a depth that
  does not fit the role, or a role value nika never writes. Such a pane is never "you". Message: "<name> can't start agents for this
  project: only this project's orchestrator and its sub-orchestrators can. Nothing was started.", with the name from the pane's
  `@nika-agent` tag when it parses (cleaned), else the pane id.
`role: "orchestrator"` with "you" or under a sub-orchestrator → `409 depth` ("That session can't start a sub-orchestrator. Only the
main orchestrator can: nika allows three levels (orchestrator, sub-orchestrators, their agents). Nothing was started."). A `parent`
pane that is no longer listed → `404 not_found` for a page request; the CLI treats its gone `$TMUX_PANE` as "you". The name
`orchestrator` is reserved for the main orchestrator's tag: a spawn named `orchestrator` is 400 `invalid` (`orchestrator is reserved`).

**Limits.** `N` = `limits.maxAgents` (1 to 8). The live set is the panes, in any tmux session, with `@nika-role` `agent` or
`sub-orchestrator` and an `@nika-agent` tag `<project key>/<name>` for this project (§8), plus the panes this process started (its
own record of a pane wins over the tags on it); the main orchestrator is not in it. `<name>.pane` files never count: they are
agent-writable and display only. The same name in another project is free. Checked in this order, each refusal starting nothing:
1. `409 conflict` when a live entry has the same `name` (an agent and a sub-orchestrator share the names);
2. `409 limit` `{ "scope": "project", "running": r, "max": min(3 × N, 24) }` when the live set already has that many;
3. `409 limit` `{ "scope": "parent", "running": r, "max": N }` when the live entries whose `@nika-parent` is this parent pane
   (for "you": the entries with no valid `@nika-parent`) already number `N`.
The `409 limit` body is `{ "error": "limit", "message": …, "scope", "running", "max" }`. A sub-orchestrator counts as one of its
parent's agents and toward the project cap. The checks and the split run in one queue per project; a CLI process and the app
server have a queue each and can race by one pane (T36).

The new pane is tagged (§8) with its role, `@nika-agent`, `@nika-depth` (1 to 3) and, with a parent, `@nika-parent`.

### `POST /api/app/orchestrator/start`
`{ "project": "<PROJECT_KEY>" }` → `200 { "pane": "%3", "session": "<name>", "sessionId": "<UUID>|null", "created": true, "cleared"?: "gone" }`.
The tmux session name is the project `name` reduced to `TMUX_SESSION` (fallback: the key). The orchestrator's claude argv is built in
one place (`launchArgv`): `--session-id <UUID>` for a new session or `--resume <UUID>` for the saved one, then `--model`, the
permission flags and `-n <name>` (bypass is refused here too). The id is a UUID nika generated or validated at the store and
the API, and must be a session of that project in nika's own index (T47).

With a saved orchestrator (0.4) the server looks it up in the transcript index first:
- **live** → `200` with its pane (`created: false`, no new session); `409 no_pane` when it runs outside tmux;
- **ended** → `claude --resume <id>` in the same way as a new start, tagged `orchestrator`, `created: true`; the pick stays;
- **gone** (no transcript, or a session of another project) → the pick is forgotten, a new orchestrator starts, and the answer carries `"cleared": "gone"`;
- the lookup failing (index unreadable) → `503 index_unavailable`, nothing started, the pick kept.

A new start saves its own `--session-id` as the project's pick, so Resume is offered after it ends.

**Early exit (0.4).** After the pane is created and tagged, Start and Resume wait 1 s and ask tmux whether the pane still exists and is
not dead (§8; the same check as spawn, one helper, the wait injectable for tests). Gone or dead → `502 claude_exited` (message under
`POST /api/app/spawn`): nothing is saved (a fresh start's pick is not written, a resumed pick stays) and the request is not retried. When
Start resumed a session, the body also carries `"resume": "<session id>"` and the message is "Claude exited right after it started. Run
`claude --resume <session id>` in a terminal in this folder to see why." (a plain `claude` would start a fresh session); the page shows
that sentence when `resume` is a session id, else the plain one. The
pane is tagged before the wait, so a second Start during it finds this orchestrator instead of opening another window; that second Start
answers `200 created: false` with a pane that may still fail the check a moment later. A tmux error or timeout on the check counts as gone (as for
spawn). A pane that is dead (remain-on-exit) is never taken for the orchestrator. The page shows the
sentence as an error toast and stays on the project page; it never opens the session window after an error. The page words
`tmux_unavailable` as "tmux not found. Install tmux 3.2 or newer, then try again.", `tmux_failed` as "tmux failed: <reason>" and `claude_exited` as the message
above, by code, in the Start and Resume toast and in the spawn sheet's alert; any other code keeps the server's message.

The page words its toast from `created`: `cleared: "gone"` with `created: true` → "Started a new orchestrator. The saved one was
gone."; with `created: false` (an orchestrator was already running and is opened) → "The saved orchestrator was gone. Opened the
one that is running." A toast on the project page would die with the page, so when the page opens the session window it shows none
and adds a fixed token to the address instead: `notice=pick-gone` (`created: true`) or `notice=pick-gone-open` (`created: false`).
The window shows the matching text once, only for exactly one `notice` that equals one of the two tokens, ignores any other value,
and removes the parameter (`history.replaceState`). The texts are constants of the window, never taken from the address. When there
is no usable link the page stays, and its own toast carries the text.

Without a saved orchestrator (never saved, or cleared with Stop using), the server first looks for the project's main orchestrator in
every tmux session (`list-panes -a`, §8) and answers it when it exists (`created: false`, `session` = that pane's session, `sessionId:
null` unless nika started or adopted it in this process, so a CLI start never opens a second main orchestrator beside one the user adopted
in their own session). It is the pane tagged `orchestrator` that runs claude in the window named `orchestrator` of the project's session
(a 0.3 pane with no `@nika-agent` tag counts there), else (0.4) a pane tagged `orchestrator` with `@nika-agent <key>/orchestrator` for this
project that runs claude, in any session (an adopted one). A sub-orchestrator, an agent, a tag of another project and a pane that no longer
runs claude never match. Otherwise: no session of the project (`has-session -t =<name>`) → `new-session` whose first window
(`orchestrator`) runs claude; the session exists → a `new-window -n orchestrator` is added. The UI opens the session window with `sessionId`.
The answer's `session` is the pane's real tmux session name (display only, through `clean()`); `nika orchestrate` targets it with
`=<name>:` (switch-client) or `=<name>` (attach-session) only when it matches `TMUX_SESSION`, else with the pane id (`-t %n`, tmux
resolves it to that pane's session), else exits 1 ("cannot attach: …") and runs nothing.

### Rules

`POST /api/app/rules/preview` `{ "project": "<PROJECT_KEY>" }` →
```json
{ "hash": "<sha256 hex of every planned write>", "files": [
    { "path": "rules/orchestration.md", "action": "create" | "update" | "unchanged", "diff": "<unified>", "foreign": false },
    { "path": "AGENTS.md", "action": "update" | "unchanged" | "skipped", "diff": "…", "note": "<only when skipped>" },
    { "path": "CLAUDE.md", "action": "create" | "update" | "unchanged", "diff": "…", "note": "<only on the unchanged via-AGENTS.md case>" },
    { "path": ".claude/settings.local.json", "action": "update", "diff": "<enabledPlugins block only>", "keysPreserved": true, "keptKeys": 3 },
    { "path": ".gitignore", "action": "update", "diff": "…", "optional": true } ],
  "warnings": [ "settings.local.json is not gitignored" ], "backupDir": "<stateDir>/backups/<key>/<ISO>" }
```
`POST /api/app/rules/apply` `{ "project": "<PROJECT_KEY>", "hash": "<from preview>", "overwriteForeign": false,
"gitignore": false }` recomputes the preview; a different hash → **409 conflict**. Writes go through `src/fwrite.js`
(`checkComponents` → backup → `writeAtomic`) and never touch git. Response `200 { "written": [ "rules/orchestration.md",
"AGENTS.md", "CLAUDE.md", ".claude/settings.local.json" ], "backupDir": "<abs>" }` (in write order).

**AGENTS.md and CLAUDE.md (0.4.0, G7).** Other coding tools read `AGENTS.md`, Claude Code reads `CLAUDE.md`, so both carry
the rules, both are listed in `files`, and Claude must load the rules once. Let L be the line `@rules/orchestration.md` and
an *import line* a line that, trimmed, is exactly `@AGENTS.md` or `@./AGENTS.md` and is not inside a fenced code block (``` or ~~~; Claude Code ignores imports in code; inline spans and indented blocks are not tracked, and a fence never closed counts as text):

| The project has | `files` |
|---|---|
| only a regular `AGENTS.md` | `AGENTS.md` `update` (adds L); a new `CLAUDE.md` `create` whose whole content is `@AGENTS.md\n` |
| both, `CLAUDE.md` has no import line | both get L |
| both, `CLAUDE.md` has an import line (outside a code fence) | `AGENTS.md` gets L; `CLAUDE.md` is `unchanged` with `note: "Gets the rules through @AGENTS.md."` (even when it lacks L: nika never adds L there and never removes a line). When it has its own L too (0.3.x), the note is "Gets the rules through @AGENTS.md. It also has its own @rules/orchestration.md line (from an earlier apply), so Claude may read the rules twice; nika never removes a line, so delete that line by hand if you want them once." |
| only `CLAUDE.md` (an import line with no `AGENTS.md` on disk counts as this) | `CLAUDE.md` gets L |
| neither | a new `CLAUDE.md` with `@rules/orchestration.md\n` |
| `AGENTS.md` is a symlink, folder, FIFO or other non-regular file, and a `CLAUDE.md` exists | `AGENTS.md` `skipped` with a `note` (a symbolic link: nika does not follow links; not a regular file); `CLAUDE.md` gets L (the via-`AGENTS.md` row never applies) |
| a lone non-regular `AGENTS.md` | `409 refused`, `code: "ESYMLINK"` (symlink) or `"ENOTREG"` (other), nothing written |

Entry shape: `{ path, action: "create" | "update" | "unchanged" | "skipped", diff?, note? }`; `note` appears only on the
`unchanged` via-`AGENTS.md` `CLAUDE.md` and on a `skipped` entry, and a `skipped` entry has an empty `diff` and is never written.
The `AGENTS.md` entry exists only when the project folder has an `AGENTS.md`; nika never creates one. The order of `files` is the order of the writes: rules file, `AGENTS.md`, `CLAUDE.md`, settings, `.gitignore`. `AGENTS.md` is read
only when it is a regular file, through the same safe read as `CLAUDE.md` (no follow, user-owned, single link, 1 MiB, UTF-8;
an oversized, non-UTF-8 or hard-linked one is refused like `CLAUDE.md`: `409 refused` `EFBIG` / `ENLINK`, `400 invalid`). Both files get the
same checks as every other target (hash, byte-for-byte backup, modes, `verifyInside`). The plan `hash` covers `AGENTS.md`'s
content and type (and a skipped entry's note), so any change after the preview is a `409 conflict`. Before its first write,
apply re-checks `AGENTS.md`'s type against the plan before it writes `CLAUDE.md`, and re-reads `AGENTS.md` before writing it; a
change is `409 conflict` ("AGENTS.md changed while applying; preview again", or "AGENTS.md changed while reading" in the plan) or
`409 refused` `ESYMLINK` when it became a link, and nothing is written.

The preview `diff` for `.claude/settings.local.json` is computed between `{"enabledPlugins": <old>}` and
`{"enabledPlugins": <new>}` (pretty JSON) only, plus `keptKeys` = the number of other top-level keys; the values of
other keys (`env`, `permissions`, `hooks`, …) never reach the page. The plan `hash` still covers the full file.
In `.claude/settings.local.json` only `enabledPlugins` is written; every other key is copied verbatim and deep-equal
asserted before the write; the file is parsed as JSON for that, but `hooks permissions env apiKeyHelper mcpServers model`
(and every other key) are never interpreted, shown or sent; invalid JSON or a `__proto__` key → `400 invalid` (T5).
The backup of each overwritten file is byte-for-byte (§6); after a successful apply only the newest 10 backup folders of
the project are kept.

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
| server → shell | `window` | `{"type":"window","action":"quit"\|"close"\|"minimize"\|"zoom-in"\|"zoom-out"\|"zoom-reset"}` — one line per `POST /api/app/window` (§3); the line names no window, so which window it applies to is the shell's decision; the shell answers nothing. Not a command from the shell: a `window` line on stdin is ignored |
| server → shell | `error` | `{"type":"error","message":"<clean()>"}` before a non-zero exit (bad `hello`, port in use) |

Limits: one open `pick-folder` at a time; `status` fields are integers ≥ 0; names are `clean()`ed; `attention` = live
agents whose registry status is neither busy, shell nor idle (e.g. waiting on a permission prompt; `shell` counts as busy); `projects[].key` is
`keyFor(repo root)`, never a path. Pane eligibility (§3 capture/keys): a registry pane qualifies only while its
`pane_current_command` is claude-like (`CLAUDE_COMMAND` in `src/ids.js`), because `tmuxPane` is agent-writable; a pane
nika started qualifies only while its command is claude-like too, because tmux can reuse a pane id after a restart
(a spawned agent's pane runs `_run-agent` as `node`). This is a safety net for the user, not a boundary against agents: a same-user agent able to forge the registry can already
run `tmux send-keys` itself; `node` stays accepted because npm-installed Claude Code runs as `node`. The secret never
appears in argv, env, logs, files or HTML; the shell injects it into the page with an `initialization_script` guarded
by `location.origin`, and `public/api.js` copies it to a module constant and deletes the global (ADR 0002).

Child process (desktop shell). Argv is fixed: `<node> --max-semi-space-size=4 <root>/bin/nika serve --app` (the flag caps
V8's young generation; architecture, Memory bounds), where `<root>` is the bundle's resource directory in release builds
and the repository root in debug builds (never an env var). The environment is
built from scratch (`env_clear`) and holds only: `PATH` (the node binary's directory, then
`/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), `HOME`, `NIKA_APP=1` and, when set
in the app's own environment, `CLAUDE_CONFIG_DIR`, `NIKA_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`TMUX_TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`. `NIKA_NODE` (an absolute path to an executable node) only chooses the
interpreter and is not passed on; without it the shell takes the first candidate (Homebrew, `/usr/local/bin`, on Linux
Linuxbrew, `$HOME/.local/bin`, Volta, the newest mise, fnm, nvm and asdf install, `/usr/bin`; the list is in
`docs/packaging.md`) whose `node --version` (fixed argv, an environment of `HOME` alone, no shell, 2 s limit, 6 s in
total) is 22 or newer; it looks on a worker thread, never on the main one. `ready` must arrive within 10 s with
`proto` 1 and a port in 1-65535, otherwise the shell kills the child and shows its local error page.

Tray navigation (shell to page). The tray rows and "Add project…" point the window at the server's origin with a
fragment: `#project/<key>` (key `^[a-z0-9]{16}$`, checked by the shell) opens that project, and `#add-project` starts
the folder-picker flow once (`hooks.addProject()` in `public/app.js`), then the page replaces the hash with
`#dashboard`. The browser tier (:3335) ignores `#add-project`.

## 6. Config and state (`src/paths.js`, `src/store.js`, `src/fwrite.js`)

| Path | Mode | Content |
|---|---|---|
| `${NIKA_CONFIG_DIR \|\| XDG_CONFIG_HOME \|\| ~/.config}/nika/` | 0700 | config dir |
| `…/nika/config.json` | 0600 | schema below |
| `…/nika/templates/<name>.md` | 0600 | locally imported rule templates (copies; never a path into a repo) |
| `${XDG_STATE_HOME \|\| ~/.local/state}/nika/` | 0700 | state dir |
| `…/nika/projects/<key>/reports/` | 0700 | per agent: `<name>.brief.md` and `<name>.agent.json` (`{model, permissionMode, rc, role, parent, depth, compact}`, re-validated on read) written by `spawn`; `<name>.session` (UUID), `<name>.remote` (RC name or empty), `<name>.pane` (`$TMUX_PANE`, display only: never counted) written by `_run-agent` before claude starts and `<name>.rc` (claude's exit code, as in 0.1) after it exits; `<name>.md` written by the agent; `.last-pane` |
| `…/nika/backups/<key>/<ISO>/<relPath>` | 0700 / 0600 | byte-for-byte copies taken by `rules apply` before each overwrite (`<ISO>` = `YYYYMMDDTHHMMSSZ`, plus `-<n>` for a second apply in the same second); the newest 10 folders per project are kept: after a successful apply `pruneBackups` removes the older ones, touching only stamp-named real directories owned by the user |

`config.json` schema and defaults (unknown keys are dropped, wrong types fall back to the default; both produce a
warning in `loadConfig().warnings`; a tampered or unreadable file never throws):
```json
{
  "models": { "orchestrator": "claude-fable-5-1", "reasoner": "claude-opus-5-5", "builder": "claude-sonnet-5-5", "scout": "claude-haiku-5-5" },
  "remoteControl": { "enabled": false, "prefix": "" },
  "permissionMode": "default",
  "panePlacement": "beside",
  "limits": { "maxAgents": 3 },
  "perProject": { "<PROJECT_KEY>": { "plugins": [ "<PLUGIN_NAME>" ], "orchestratorSessionId": "<UUID>", "models": { "<role>": "<MODEL_ID>" }, "permissionMode": "<mode>", "panePlacement": "<placement>", "maxAgents": 1 } },
  "projects": [ { "key": "<PROJECT_KEY>", "dir": "<abs realpath>", "name": "<basename>", "addedAt": "<ISO>" } ],
  "rules": { "localTemplate": null },
  "ui": { "theme": "system", "singleKeyShortcuts": true },
  "compaction": { "enabled": true, "pct": 80, "window": 400000 }
}
```
`ui.theme` ∈ `system light dark` (default `system` = follow `prefers-color-scheme`). `ui.singleKeyShortcuts` boolean
(default `true`; a missing or non-boolean value reads as the default): whether `?` opens Keyboard shortcuts (design spec
§4.6). Mod+/ always does. `compaction` (0.4): `enabled` boolean, `pct` an integer 20–95, `window` one of `200000`,
`400000`, `1000000`, `"model"`; a bad leaf falls back to its default with a warning (`compaction.pct invalid, default used`).
Field rules: `models.*` `MODEL_ID`; `remoteControl.prefix` `""` (= project name) or `RC_PREFIX`; `permissionMode` ∈
`PERMISSION_MODES`; `panePlacement` ∈ `PANE_PLACEMENTS`; `limits.maxAgents` 1–8 (there is no turn limit: Claude Code
has no `--max-turns` for interactive sessions); `perProject` keys are `PROJECT_KEY`s and each entry holds `plugins` (≤ 200 names, deduplicated), `orchestratorSessionId` (a
lowercase UUID), `models` (a partial map of the roles `orchestrator`, `reasoner`, `builder`, `scout` to a `MODEL_ID`; a role
that is not set uses `models.*`) and, 0.4.0, `permissionMode` (`PERMISSION_MODES`, never `bypassPermissions`), `panePlacement`
(`PANE_PLACEMENTS`) and `maxAgents` (1–8); a key that is not set uses the Settings value. A bad key or an entry that is not an
object drops that entry with a warning; a bad plugin list, a bad id or a `models` that is not an object drops just that field; an
unknown role or a bad model id drops just that role; a bad `permissionMode` (also `bypassPermissions`), `panePlacement` or
`maxAgents` drops just that key; any other inner key is dropped, each with a warning. An empty `plugins` list, an empty `models` map, and an entry left empty are
"none": dropped on load without a warning, so `[]` and "no entry" are the same thing. Written only by `PUT
/api/app/projects/:key/config` (and `…/orchestrator` for the id), which check the project is registered;
`projects` ≤ 100 entries, `key` must equal `keyFor(dir)`;
`rules.localTemplate` `null` or a file name `^[A-Za-z0-9_-]{1,64}\.md$` under `templates/`. Store mutations in one
process are serialised (one promise queue in `src/store.js`); across processes the last atomic rename wins.
**Migration (0.3.4):** a `config.json` written by 0.3.3 or older holds the lists in `plugins.perProject: { key: [names] }`.
`loadConfig` reads it as `perProject[key] = { plugins: names }` with no warning (when both shapes are present `perProject`
wins and the old group is dropped silently); the old group is never written back, so the next save persists the new shape.

Project folders (`rules/`, `.claude/`, the repo root) are written with `writeAtomic(…, { project: true })`: a
world-writable folder is always refused; a group-writable one is accepted only on Linux and only when its group is
the user's primary group (`process.getgid()`, the per-user group of a 002 umask). nika's own config and state folders
stay strict (no group or world write). An existing in-project file keeps its mode minus group/other write (never
widened); a new `.claude/settings.local.json` is 0600, other new in-project files 0644; nika's own files 0600.
`enabledPlugins`: selected plugins → `true`; `true` entries not selected → removed; `false` entries of unselected
plugins untouched; a project with no `perProject[key].plugins` list leaves `enabledPlugins` untouched.

Store API: `loadConfig(env) → { config, warnings, file }`, `saveConfig(config, env)` (re-validates, throws `EINVAL`),
`addProject(dir, env)`, `removeProject(key, env)` (also drops the project's `perProject` entry), `listProjects(env)`,
`updateSettings(patch, env)` (throws `EINVAL`, never accepts `projects`, `perProject` or `bypassPermissions`),
`getProjectConfig(key, env) → { plugins, models, permissionMode, panePlacement, maxAgents }` (`EINVAL` on a bad key; `models` has the
four roles, each an id or `null`; the last three are the project's value or `null`),
`updateProjectConfig(key, patch, env)` (the patch is a plain object whose only own key is `plugins`, `models`, `permissionMode`,
`panePlacement` or `maxAgents`, else `EINVAL`; `models` must have exactly the four roles, each a `MODEL_ID` or `null`;
`bypassPermissions` is `EINVAL`; `ENOENT` for a project that is not registered; `[]`, four nulls and a null item remove their
field; returns the `getProjectConfig` shape), `effectiveModels(config, key)` (pure: the project's id per
role, else `config.models`), `effectiveAgents(config, key)` (pure: `{ permissionMode, panePlacement, maxAgents }`, the project's
value per item, else Settings'), `keyFor(realDir)`.

Write API (`src/fwrite.js`): `ensureDir(dir, mode = 0o700)`, `writeAtomic(dir, name, content, { mode = 0o600, root })`,
`checkComponents(root, relPath) → { dir, name, abs }`, `backupFile(srcAbs, backupRootAbs, relPath)`,
`verifyInside(root, target)`, `pruneBackups(root, keep, current) → removed names`. With `root` (a project folder)
`writeAtomic` calls `verifyInside` after the rename: every directory from `root` down must still be a real directory and
`realpath(target)` must be inside `root`, else the target is unlinked and the write refused (`ESYMLINK`). Error codes:
`ESYMLINK` `ENOTDIR` `ENOTREG` `EOWNER` `ENLINK` `EMODE` `EPATH` `EFBIG` (plus the OS codes `ENOENT`, `ELOOP`).

### App copy (`src/appcopy.js`, macOS only, ADR 0011)
- Target: exactly `<home>/Applications/nika.app` (`os.homedir()`); never `/Applications`, never sudo, never a path from a
  request or a file. `~/Applications` is created 0700 when absent; when present it must be a real folder you own.
- Source (never from a request or the state marker), first match: the app bundle this process runs from (its root is
  `<x>.app/Contents/Resources/nika`) unless that is the target; the Homebrew keg app next to this install
  (`<root>/../nika.app` when `<root>` is `libexec`); the fixed Homebrew paths `/opt/homebrew/opt/nika/nika.app`,
  `/usr/local/opt/nika/nika.app`. A source counts only when it is a real folder whose `Contents/Info.plist` (read through
  `fsafe`, ≤ 64 KB, XML) names `CFBundleIdentifier` `io.github.qmpwwsd.nika`; its `CFBundleShortVersionString` is the
  `available` version.
- The target counts as nika only when it is a real folder (not a symlink) you own whose Info.plist names the same bundle id;
  anything else is `foreign` and is never touched.
- Copy: a fresh temp folder `~/Applications/.nika-copy-XXXXXX` (`mkdtemp`, 0700); `/usr/bin/ditto <source>
  <tmp>/nika.app` (`execFile`, fixed argv; keeps the ad hoc signature, adds no quarantine); the copy's Info.plist must
  name the bundle id and the source's version; then rename the old target (if any) into the temp folder, rename the new
  copy to the target, and remove the temp folder (it holds only what nika made). A failed step removes the temp folder
  and moves the old copy back. Then `lsregister -f <target>` (`execFile`, fixed path; failure ignored) so LaunchServices
  and Spotlight see it at once.
- After the swap the temp folder is removed only if `~/Applications` is still a real folder you own, not group/world-writable,
  and the temp folder is still the very directory `mkdtemp` made (not a symlink, same device and inode); otherwise it is
  left where it is and the install still reports success (the copy is in place).
- Marker: `<state>/app-copy.json` `{ "managed": true, "version": "0.3.0", "dismissed": false }` (0600, `fwrite`), written
  after a successful copy, a dismiss, or an explicit install over a current copy nika did not make (nothing is copied then;
  the copy is only recorded as managed, `dismissed` kept). A launch command never writes it for an unmanaged copy. If the
  marker write fails after a copy, the route still returns 200 and `nika app install` prints one stderr line ("could not
  record the copy as managed; nika won't refresh it"). It never holds a path.
- Refresh: `nika`, `nika open` and `nika app` refresh a **managed** copy whose version differs from this CLI's version
  when the source has this CLI's version (that is, after `brew upgrade`), then launch the copy with `open <target>`;
  an unmanaged or foreign copy is never touched. They print "updated the nika app in ~/Applications to X.Y.Z (if nika
  was open, quit and reopen it)".

## 7. CLI

| Command | Does |
|---|---|
| `nika` | opens the app when installed (macOS `open -b io.github.qmpwwsd.nika`, Linux `nika-app` then `gtk-launch io.github.qmpwwsd.nika`), else the browser dashboard |
| `nika open [--app\|--browser]` | force one of the two |
| `nika app` | launch the desktop app (same lookup as `open --app`, does not block); exit 1 with an install hint when it is missing |
| `nika app install` | macOS: copy or update the app in `~/Applications` (§6 "App copy"); prints "added nika X.Y.Z to ~/Applications (find it with Spotlight)", "updated …" or "already current"; exit 1 with the reason for `no-source` / `foreign-target` / `copy-failed`; Linux: exit 1, "the .deb or AppImage installs the desktop entry" |
| `nika serve [--app]` | browser tier on `NIKA_PORT` (3335) · app tier on port 0 with the stdio protocol (§5); `--app` refuses a TTY stdin |
| `nika status [--json] [--since w] [--ended] [--full]` | 0.4.0: ended rows only with `--ended` (the latest 5 per project) or `--full` (all, implies `--ended`); otherwise one line says how many are hidden. Every project added to nika is listed, also one with no session in the window (`<name>  <folder>   no sessions yet` for `--since all`, else `no sessions in the last <window>`); a folder never added shows only while a session runs there, or with `--ended`. The project list is read in every text view (a `config.json` nika cannot use gives a `note:` line and no empty projects). `--json` is unchanged (the snapshot only) and carries every agent |
| `nika spawn <name> <model> <brief> [--project dir] [--permission-mode m] [--rc prefix\|off] [--role agent\|orchestrator] [--under %pane] [--session name]` | spawn an agent in tmux (needs `$TMUX` or `--session`); `brief` is a file path or `-` for stdin. 0.4: `--role orchestrator` starts a sub-orchestrator (only the main orchestrator's pane may; else exit 3, `depth`). The parent is the pane it runs in, `$TMUX_PANE`, when that is a pane id (else none); there is no `--parent` option, and a `$TMUX_PANE` that tmux no longer lists is "no parent". The server reads that pane's role and depth from tmux's tags |
| `nika orchestrate [dir]` | create or reuse the project's tmux session and start the orchestrator pane |
| `nika projects list\|add <dir>\|remove <key>` | project registry |
| `nika rules preview\|apply [dir] [--yes] [--overwrite-foreign] [--gitignore]` | preview prints the diffs; apply asks for confirmation unless `--yes` |
| `nika doctor` | prints node, tmux, claude, app, config, state and backups paths and their modes |
| `nika _run-agent <key> <name>` | hidden pane wrapper: writes `<name>.session` and `<name>.rc`, runs claude |
| `nika --version` | version |

Exit codes: 0 ok · 1 runtime error · 2 usage · 3 refused (validation, limit, foreign file without flag).

## 8. tmux argv shapes (`execFile`, never a shell)

All calls use the resolved `tmuxBin` (`findTmux`), `-u`, exact targets (`=<session>` for sessions, `%n` for panes) and
multi-argument shell-commands (tmux execs them directly, no `sh -c`, T6).

| Purpose | argv |
|---|---|
| list panes | `tmux -u list-panes -a -F #{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}` (0.1; the tags 0.2 and 0.4; each tag is read strictly, a value that does not parse is absent, and the tags of a pane with no nika role are ignored) |
| session exists | `tmux -u has-session -t =<session>` |
| create session + orchestrator | `tmux -u new-session -d -s <session> -n orchestrator -c <projectDir> -x 200 -y 50 -P -F #{pane_id} [-e CLAUDE_CODE_AUTO_COMPACT_WINDOW=<W> [-e CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<PCT>]] -- <claudeBin> <orchestrator flags>` |
| remove the pair from the session environment (0.4) | `tmux -u set-environment -t =<session> -u CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then the same for `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: only after a `new-session` that carried `-e`, only for a name it sent; best effort (a failure is ignored) |
| create session + first agent (0.4) | `tmux -u new-session -d -s <session> -n agents -c <projectDir> -x 200 -y 50 -P -F #{pane_id} -- <nikaBin…> _run-agent <key> <name>`: a spawn when the project's session does not exist (no server, or a server without it); no `-e` pair (an agent's compaction travels in `<name>.agent.json`, so nothing is added to the session environment); the pane is tagged as a split-window one |
| early-exit check (0.4) | `tmux -u display-message -p -t %n #{pane_dead}` 1 s after Start, Resume or spawn created pane `%n`: `0` = running; `1`, a tmux error (pane or server gone) or anything else = `502 claude_exited`. A constant format and a pane id nika got from tmux and matched against `PANE_ID`; no request data |
| orchestrator in existing session | `tmux -u new-window -t =<session>: -n orchestrator -c <projectDir> -P -F #{pane_id} [-e … as above] -- <claudeBin> <orchestrator flags>` |
| tag a pane nika created | `tmux -u set-option -p -t %n @nika-role orchestrator` (after new-session / new-window), `… @nika-role agent` or (0.4) `… @nika-role sub-orchestrator` (after split-window), then `@nika-agent <PROJECT_KEY>/<AGENT_NAME>` (0.4: `<PROJECT_KEY>/orchestrator` for an orchestrator), `@nika-depth <1\|2\|3>` (an orchestrator 1) and, for a nested spawn, `@nika-parent <PANE_ID>`; every value is a constant, a validated name or a pane id (no `#`); best effort |
| adopt a live session as orchestrator (0.4) | `tmux -u set-option -p -t %n @nika-role orchestrator`, then `@nika-agent <PROJECT_KEY>/orchestrator`, then `@nika-depth 1` (`PUT …/orchestrator`; the depth is a constant 1, 2 or 3, never request data) |
| resume the orchestrator (0.4) | the orchestrator argv above (the same `-e` pairs) with `--resume <UUID>` instead of `--session-id <UUID>`; the UUID is the stored pick |
| tags of a spawn | `tmux -u list-panes -a -F #{pane_id}\t#{pane_dead}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{session_name}\t#{window_name}` (one fresh listing per spawn; the names are last because they are free text; a pane with `pane_dead` `1`, one that remain-on-exit keeps after claude exited, is skipped, so it is never live, never counts toward a cap or the duplicate-name check and is never a parent: a dead parent reads like a gone one) → (1) the requested parent's role and depth (`POST /spawn`, "Nesting"), and (2) the live set: the panes with `@nika-role` = `agent` or `sub-orchestrator` whose `@nika-agent` is `<key>/<name>` for the project's key, for the duplicate-name check and the two caps. A tag is parsed strictly (exactly one `/`, `PROJECT_KEY` before it, `AGENT_NAME` after it; a depth is exactly `1`, `2` or `3`; a parent is a `PANE_ID`); anything else is agent-writable noise and is ignored, never trusted |
| find orchestrator pane | `tmux -u list-panes -a -F #{pane_id}\t#{pane_current_command}\t#{pane_dead}\t#{@nika-role}\t#{@nika-agent}\t#{session_name}\t#{window_name}` (`-a` = every session, 0.4; a failing listing, e.g. no server, means none; a pane with `pane_dead` `1` is skipped: remain-on-exit keeps it with its tags and a claude-like command) → the pane with `@nika-role` = `orchestrator` whose command is claude (`claude`, `node` or a version string) and which is the project's main one: tagged `<key>/orchestrator` in any session, or a 0.3 pane with no `@nika-agent` tag in the project's session, window named exactly `orchestrator`. One in the window named `orchestrator` of the project's session wins, else a tagged pane in any other window or session; agent and sub-orchestrator panes, and a tag of another project, never match |
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

tmux also format-expands `new-session -s <session>`, `new-window -n <name>` and `select-pane -T <title>`. Those values
are passed unescaped and are safe only because they can never contain a `#`: `TMUX_SESSION` and `AGENT_NAME` exclude it,
the window names are the constants `orchestrator` and `agents`, and the title is `[%n] <AGENT_NAME>` with `%n` a `PANE_ID`. A change that
lets another string reach `-s`, `-n` or `-T` must escape it with `tmuxLiteral()` first. `test/spawn.test.js` ("tmux format
expansion (T6)") asserts it.

tmux `new-session -e NAME=value` and `new-window -e NAME=value` (0.4, auto-compact) set one variable each. Unlike `-c`, `-s`, `-n` and `-T`
the value is **literal**: `#{pane_id}` is not expanded, spaces and `#` are kept (spike S2, tmux 3.8). The scope differs: `new-window -e` is
the new pane's environment only, but `new-session -e` sets the **session** environment, which every later pane of that session inherits
(verified on tmux 3.8), so nika unsets the two names with `set-environment -t =<session> -u <NAME>` right after the `new-session` (table
above; best effort; the first pane keeps its copy, since a process environment is fixed when it starts). `-e` exists from tmux 3.0 on
new-window and 3.2 on new-session: **tmux 3.2 or newer is required**. nika passes exactly two names, each as its own `-e` pair before `--`,
and a value only after `compactLaunch` has made it digits and at most one dot. `test/orchestrate.test.js` asserts the shape and the unset.

Session targets always carry the trailing colon (`=<session>:`) where tmux expects a window or pane: `split-window -t
=name` fails with "can't find pane", `=name:` works.

**Claude argv** (every value a separate element; verified against Claude Code 2.1.319):
- orchestrator flags: `--session-id <UUID>` `--model <models.orchestrator>` `[--permission-mode <m>]` (omitted for
  `default`) `-n <session>` `[--remote-control=<rc name>]`. RC name = `remoteControl.prefix` or the session name,
  reduced to `RC_PREFIX`. The model is the project's own orchestrator model, else Settings'.
- **Auto-compact environment (0.4, ADR 0014; `src/compact.js`).** When `compaction.enabled`, every claude nika starts gets two environment
  variables; when it is off, none (the environment inherited from the tmux server or the CLI is passed through unchanged, and
  Claude's own settings apply). Never the `--autocompact` flag. For the model the session runs and the setting `{ pct: P, window }`:
  `W` = the model's window (`modelWindow`) when `window` is `"model"`, else `min(window, modelWindow)`; `limit` = `W - 33000`; `target` =
  `floor(W x P / 100)`; the session compacts at `min(target, limit)`.
  - `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<W>` (an integer, 100000–1000000), always;
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<PCT>`, always (a string of digits and at most one dot, 4 decimals, above 0 and at most 100):
    `PCT = ceil4(100 x target / (W - 20000))` when `target <= limit`, else `100`, which Claude Code caps at `W - 33000`, the same number
    (so a value inherited from the environment can never stay in force).
  Claude Code's rule is `min(floor((W - 20000) x PCT / 100), W - 33000)` (20000 reserved output, 13000 summary buffer); the window must be set
  explicitly or proactive compaction is off. Examples (`W`, `P` → PCT, compacts at): 200k, 80 → 88.8889, 160k; 200k, 95 → 100, 167k;
  1M, 80 → 81.6327, 800k; 400k on a 1M model, 80 → 84.2106, 320k; 400k, 95 → 100, 367k. The orchestrator gets them as the two tmux `-e`
  pairs (§8); an agent or sub-orchestrator through the `env` option of the `spawn()` that starts claude (no shell). With the variables
  set, `/autocompact` inside the session is locked to the environment (spike S2).
- `_run-agent <key> <name>` reads `<reportsDir>/<name>.brief.md` (0600, written by `spawn` before `split-window`,
  read through `fsafe`; the brief never passes through tmux argv, but it is claude's own argv, see below), writes `<name>.session` (the UUID), `<name>.remote`
  (the RC name or empty) and `<name>.pane`, then runs `claude --session-id <UUID> --model <model> [--permission-mode <m>] -n <name>
  [--remote-control=<prefix>-<name>] --add-dir <reportsDir> --append-system-prompt <templates/guard-prompt.txt
  rendered with name, report path> --settings <deny JSON> --disallowedTools Bash(nika:*) Bash(tmux:*)
  Bash(claude:*) "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)" -- <brief>` with inherited stdio, writes
  claude's exit code to `<name>.rc` and exits with it. `_run-agent` refuses (exit 3) a brief that is empty, contains NUL
  or is a single word. The brief, the guard prompt and the deny settings are claude's argv, so any local process can
  read them with `ps` (single-user assumption, `docs/security.md` residual risk a). RC names match `RC_NAME`. `--disallowedTools` is variadic, so it is always followed by `--`. Deny JSON:
  `{"permissions":{"deny":["Read(**/.env*)","Edit(**/.env*)","Read(**/*.key)","Edit(**/*.key)"]}}` (T3, T4). The deny
  lists are advisory, not a boundary: Claude Code matches the literal command text, so `/opt/homebrew/bin/tmux …`,
  `sh -c 'tmux …'`, `git -C . commit` or a script written with Write and run with Bash all pass, and Read/Edit denies do
  not cover subprocesses. They stop the common invocation and honest mistakes; the boundary is the single-user trust
  model plus the app secret (`docs/security.md`). No Claude Code sandbox in 0.2; planned as an optional Settings switch.
- 0.4 `<name>.agent.json` is exactly `{ model, permissionMode, rc, role, parent, depth, compact }` (keys asserted, every value checked again,
  exit 3 on any mismatch): `compact` is `null` (auto-compact off at spawn time) or exactly `{ window, pct }` with `window` an integer 100000–1000000 and `pct` a
  string of digits and at most one dot (above 0, at most 100; never `null`, so `{ window, pct: null }` is exit 3); spawn computes it from this spawn's own model (`compactLaunch`), and `_run-agent` turns it into
  the two variables above, added to a copy of its own environment (`ctx.env`, never written to); `role` is `agent` or `sub-orchestrator`, `parent` a pane id or `null`, `depth` 1 to 3, and they must
  agree (`parent` is `null` exactly at depth 1; a sub-orchestrator is depth 2). A **sub-orchestrator** (`role` = `sub-orchestrator`)
  is run with `templates/guard-orchestrator.txt` as its system prompt and `--disallowedTools Bash(tmux:*) Bash(claude:*)
  "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)" Bash(nika) "Bash(nika <command>:*)" …` in place of `Bash(nika:*)`: one
  rule for bare `nika` and one for every name in the CLI's command table (`COMMAND_NAMES` in `src/cli.js`, handed to `runAgent` as
  `ctx.commands`) except `spawn` and `status`, so a command added to the table is denied by default. Without a usable table the
  list falls back to `Bash(nika:*)` (all of nika). An agent's guard and list are unchanged. The lists stay advisory.
- `<nikaBin…>` = `process.execPath` + absolute path of `bin/nika` (no PATH lookup inside tmux).

## 9. Module interfaces (Phase 2)

Handlers return `{ status, body }` like 0.1 `focusPane` / `readReport`; the router only sends. `ctx` =
`{ env, exec, tmuxBin, claudeBin, nikaArgv, claudeDir, now, started }` where `started` is the in-process `Map<paneId,
{ key, name, sessionId, role: "agent" | "sub-orchestrator" | "orchestrator", parent?, depth?, mode }>` of panes nika created (`mode`, 0.3: the permission
mode passed at launch, `manual` when none; 0.4 `parent` / `depth`: the pane id and the depth a spawn resolved, `null` / 1 for "you"). `ctx.lenientParent`
(the CLI sets it) turns a `parent` pane that is no longer listed into "no parent" instead of 404, and `runAgent`'s `ctx.commands` is
the CLI's command table. Pane eligibility (in `list-panes`, running claude, and live Claude or `started`) is
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
| `src/spawn.js` | `spawnAgent(req, ctx) → { status, body }`; `runAgent(key, name, ctx) → exit code`; `deniedTools(role, commands) → string[]` (the `--disallowedTools` of a role) |
| `src/orchestrate.js` (helpers) | `tagPane(ctx, pane, role, agentTag?, depth?, parent?)` sets `@nika-role`, `@nika-agent` = `<key>/<name>` (`<key>/orchestrator` for the orchestrator), and (0.4) `@nika-depth` for a depth of 1 to 3 and `@nika-parent` for a pane id; `launchArgv(config, project, { sessionId, resume })` → claude's flags after the binary (the one place the orchestrator argv is built) |
| `src/orchestrate.js` | `startOrchestrator(projectKey, ctx) → { status, body }` (`ctx.findSession(id)` looks a saved orchestrator up in the transcript index); `pickState(project, id, hit)` (the one reading of a saved id, shared by the list, the PUT and Start; another project's session is `gone`), `claudePane(agent)`, `inProject(group, project)` |
| `src/model.js` | `findSession(id, { config, exec, now, cache }) → { agent, group } \| null` (a session of any age; throws `EINDEX` when it is not found and the index could not be read); `findSessions(ids, { config, now, cache }) → Map id → { agent, group }` (index only: one walk for all ids, no registry, ps or tmux, so every hit reads as not running; throws `EINDEX` when an id is missing and the index could not be read) |
| `src/appio.js` | `serveApp({ config, env, stdin, stdout, stderr }) → Promise<number>` (handshake, listen, status loop, picker; resolves with the exit code 0/1/2) |
| `src/api-app.js` | `createAppApi({ secret, ctx, deps }) → (req, res, url, port) → Promise<boolean>` (true when it handled the request) |
