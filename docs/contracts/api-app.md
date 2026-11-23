# nika 0.2–0.3 contracts — app tier

Source of truth for every builder from 0.2 on (0.3 adds session control: mode, prompt answer, end, commands, models; ADR
0010, TUI facts in `docs/contracts/claude-tui.md`). Routes, messages, schema fields and argv shapes below are fixed; a change
here is a change for every phase and needs the orchestrator's sign-off. Rules: `rules/project-rules.md`; decisions:
`docs/adr/`.

Id shapes come from `src/ids.js`:

| Name | Shape |
|---|---|
| `UUID` | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` |
| `PANE_ID` | `^%(?:0\|[1-9]\d{0,5})$` — canonical since 0.5.4 (SF): `%0` or no leading zero, because tmux reads a `%` target by number, so `%07` would be a second spelling of `%7`; checked at every boundary (API, CLI, collectors) |
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
| `KEY_NAME` | set: `Enter Escape Tab BTab Up Down Left Right Home End PPage NPage BSpace DC C-c C-u C-k C-a C-e C-l C-r C-w C-Home C-End` (0.5, W3: the last two are the scroll route's keys; `keys.send` checks every key against this set, so the keys route accepts them too, but nika's pages post them only to `…/scroll`) |
| `PERMISSION_MODES` | `default manual acceptEdits plan auto dontAsk` — `default` passes no `--permission-mode` flag (Claude Code's own default); `bypassPermissions` is refused everywhere |
| `PANE_PLACEMENTS` | `beside under-last` |
| `SUBAGENT_ID` | `^[A-Za-z0-9_-]{1,64}$` (0.5, W8) — the `<id>` of Claude's `subagents/agent-<id>.jsonl` and `.meta.json` (no dot, no slash). The collector builds its file-name patterns from this one pattern; the page keeps a copy in `public/dash-model.js` and a test compares the two `.source` strings |
| `TOOL_USE_ID` | `^[A-Za-z0-9_-]{1,128}$` (0.5, W8) — a `tool_use` block's `id` and a subagent meta's `toolUseId`. Compared for equality inside the server only; never shown, never sent |

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
`invalid` 400, `unsupported_media` 415, `too_large` 413, `conflict` 409, `busy` 429 (the fit routes of 0.5 also answer `busy` 409, see `…/fit`; so does the suggestion route since 0.5.1, with a `draft`, see `…/suggestion`), `tmux_unavailable` 503 (the tmux binary is
missing; since 0.4 a tmux server that is not running is not an error for Start or spawn: they create the session),
`claude_unavailable` 503, `tmux_failed` 502 (a tmux call failed unexpectedly), `claude_exited` 502 (0.4: the new pane was gone or dead
a second after Start, Resume or spawn created it), `limit` 409 (maxAgents reached), `foreign` 409 (rules file not written by nika, apply without
`overwriteForeign`), `refused` 409 (a write-safety check failed; `"code"` carries the fwrite/OS code such as `ESYMLINK`),
and for session control (0.3) `not-idle`, `mode-unknown`, `mode-unchanged`, `not-in-cycle`, `busy-switching`, `no-prompt`,
`prompt-changed`, `already-answered`, `input-not-empty`, `input-unreadable`, `not-at-prompt`, `bypass-prompt`, `screen-unclear`, all 409. The 0.3 codes are hyphenated, as the spec names them; the older codes keep their underscores. Draft sync (0.5) adds `draft-unreadable`, `draft-changed`, `screen-changed` and `draft-mismatch`, all 409 (`PUT /api/app/pane/:id/draft`; the first, second and fourth also `POST /api/app/pane/:id/suggestion`). Sending while Claude works (0.5, W13) adds `cursor-not-at-end` and `clear-stopped` (`PUT /api/app/pane/:id/draft`) and `prompt-open` and `suggestion-shown` (`POST /api/app/pane/:id/submit`; that route also answers `not-idle`, `bypass-prompt`, `screen-unclear`, `input-unreadable`, `draft-changed` and `busy-switching`), all 409. The keys route with `send: true` (Send's own typing) answers `prompt-open` and `screen-unclear`, both 409, besides its `bypass-prompt`. Attachments (0.5, W2) add, on the upload and the file chooser, `empty` and `secret-file` 400, `too-big` 413 (more than 8 MiB decoded; the dispatcher's own `too_large` 413 is a body over the route's cap), `wrong-type` 415, `folder-unsafe`, `path-unusable` and `no-project` 409, `busy` 429, `storage-full` and `disk-full` 507 and `write-failed` 500; and, on `POST /api/app/pane/:id/attach-send`, `attachment-gone`, `path-unusable`, `not-idle`, `mode-unknown`, `input-unreadable`, `draft-unreadable`, `shell-mode`, `draft-changed`, `cursor-not-at-end`, `vim-normal`, `screen-changed`, `not-taken` and `busy-switching`, all 409, and `internal` 500. Scrolling (0.5, W3) adds `no-view`, `prompt-open`, `screen-unclear`, `menu-open` and `busy-switching`, all 409 (`POST /api/app/pane/:id/scroll`). The feedback survey (0.5, F14) adds `no-survey`, `survey-changed`, `text-mode` and `survey-undo`, all 409, and `terminal-only` 400 (`POST /api/app/pane/:id/survey`; `survey-undo` is also an answer of Stop, End, the commands, the draft route and the dialog route, see there). 0.5.4 adds, at their routes: `tray-full` 409 to the upload and the file chooser (the attachment tray, AT), `no-project` 409 to `GET /api/app/pane/:id/attachments` and to `PUT` and `GET /api/app/pane/:id/kept-draft`, and `busy` 429 to the `PUT` of the kept-draft route (LT); `dialog-unread`, `notes-open`, `preview-changed`, `note-mode`, `note-room` and `note-mismatch`, all 409, to `POST /api/app/pane/:id/dialog` (question steps with a preview, QP and QPF; `dialog-unread` also replaces the false `dialog-changed` for any dialog nika cannot read, and `dialog-unread` and `notes-open` are also answers of the move to another step, and `notes-open` of End); `in-tmux` and `registered` 409, `index_unavailable` 503 and `write_failed` 500 to the remove and unhide routes (RM, see "Removed items"). The typed `/compact` (AC), the Fit mode (P2) and the spawn placement (P1) add no error code of their own; the typing stamp (AC) is not a code but a header, see `GET …/capture`.

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
`orchestrator` (0.4, C1; app tier only, never on :3335): `null` (no saved orchestrator, the transcript index could not be read, or, since 0.5, the session
registry could not be read: the snapshot's `sources.registry` is not `ok` or the snapshot has no `sources` at all, so no session reads live, every pick is
unknown and the page keeps what it had) or
```json
{ "sessionId": "<UUID>", "state": "live" | "ended" | "gone", "name": "<clean(name)>" | null, "pane": "%3" | null }
```
It is checked against the transcript index, not the snapshot's window (7 days by default): `live` = the session runs (its `pane` is set when tmux shows it),
`ended` = its transcript exists and it does not run (it can be resumed), `gone` = the id is saved but nika's index has no transcript
for it, **or the session belongs to another project** (the same membership check as Start and the PUT: a hand-edited config cannot make
the page show or open another project's session; `name` and `pane` are `null`). The picker's `project` carries the same field.
A saved id that is the host session of a background row (`hostId`, see Dashboard snapshot additions) reads as that row: `live` with its
pane. Start with such a pick answers `200 { created: false }` with that pane and starts nothing, and the PUT with that id is not refused
as "another session is running". **The pick moves (0.5, owner decision 2026-11-15).** This route, and the picker's `done` answer, save
the row's own id (the child's) as the project's pick when the saved pick is the host id of a live, linked row of the same project, and
answer with that id as `sessionId`: the host's transcript ends at `/compact`, the child's is the conversation that goes on. The write
goes through the store, happens only while the saved pick still equals the host id (read again just before it), and is best effort: an
error changes nothing and is not shown (the answer still reads the row, and the next poll tries again). A second poll writes nothing,
and nothing moves for a pick that is already the child's id, a host with no link, a row of another project or a pick that reads `gone`.
Start and PUT never move it; the PUT with the child's id while the pick is the host id is an ordinary save. The browser tier never moves
a pick.

Cost: the page polls this route every 3 s, so the whole list is built from ONE snapshot (the cached one of the default 7-day window, shared with `/modes`;
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
sessions and sessions the user starts get no environment. Since 0.5.4 (AC) `enabled`, `pct` and `window` also decide when the app tier types `/compact`
into a live session that waits past its compact point, whether nika started it or not (the capture route's `compacted`, below; ADR 0014, amendment
2026-11-19); the browser tier and the CLI never type.

**`fit` (0.5.4, P2)** — `{ "mode": "auto" | "fill" | "terminal" | "off" }`, default `{ "auto" }` (`FIT_MODES`): how a session window fits Claude's pane to its panel, for every
project (§3 `PUT …/fit`, "Fit mode"). A group like the others (a one-key patch keeps the rest). Any other value, a non-string or an unknown inner key is `400 invalid` naming the
field (`fit.mode`). A saved change reaches the running controller at once (`fit.setMode`, after the save succeeded; a refused save never gets there), and every open session window follows
within its next request (5 s at most). A `config.json` with no `fit` reads as `auto` with no warning; an unknown value reads as `auto` with the warning `fit.mode invalid, default used`; a 0.5.1 or
older nika drops the group (`unknown key fit dropped`), which is `auto`, the safe side. The browser tier reads nothing new.

**`attachments` (0.5, W2)** — `{ "keepDays": integer 1–30 }`, default `{ 7 }`: how many days a file attached in the session window stays in
nika's state folder (§6). A group like the others (a one-key patch keeps the rest). A fraction, 0, 31 or a string is `400 invalid` naming
the field (`attachments.keepDays`); an unknown inner key is `400` too. `src/attachments.js` reads the value at every prune (at start, every 24 h
and before each save), so a change applies at the next prune and never shortens the life of a file already pruned. The Settings page
shows it as the section "Attachments", field "Keep attachments for N days".

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

### Removed items (0.5.4, RM; `src/hidden-routes.js`, `src/hidden.js`; ADR 0022)
The user can take a session or a detected folder out of nika's lists, and bring it back. It changes **nika's own list only**: no process is touched and nothing of Claude's is
deleted (the sessions and their transcripts stay; `claude` itself still lists them). Five routes, all under the app guard (§2) and **never mounted on :3335**; every write body is
exactly `{}` (anything else is `400 invalid`, `body must be {}`), a path segment is only a lookup key, and nothing in a request names a path, a label or a time. The error bodies carry fixed
words. Writes are capped at `CAP.small`.

| Route | `200` | Errors (nothing written) |
|---|---|---|
| `POST /api/app/session/:id/remove` (`:id` a `UUID`) | `{ "hidden": true, "dropped": 0 }` | `400 invalid` (body) · `404 not_found` (not a UUID, unknown to nika's index, or a host id: the id of a session that `hostId` folds into another row) · `409 in-tmux` (the row runs in a tmux pane nika sees, `This session runs in a tmux pane, so it stays in the list.`) · `503 index_unavailable` (the index could not be read) · `500 write_failed` |
| `POST /api/app/session/:id/unhide` | `{ "hidden": false }` (also when nothing was stored, and for an id nika has no transcript for) | `400 invalid` · `404 not_found` (not a UUID) · `500 write_failed` |
| `POST /api/app/groups/:key/remove` (`:key` a `PROJECT_KEY`) | `{ "hidden": true, "sessions": n, "dropped": 0 }` (`sessions`: the rows it takes out, without those in a pane; `0` for a key that was already stored and has no folder now) | `400 invalid` · `404 not_found` (not a key, no such folder, or the folder `(unknown)` that has no working folder) · `409 registered` (the folder, by key or by working folder, is a project added to nika: `This folder is a project in nika, so it stays in the list.`) · `503 index_unavailable` · `500 write_failed` |
| `POST /api/app/groups/:key/unhide` | `{ "hidden": false }` | `400 invalid` · `404 not_found` (not a key) · `500 write_failed` |
| `GET /api/app/hidden` | below | never `500` for a bad file (empty lists) |

- The checks run in this order: body `400`, the id or key `404`, the lookup (`503` when the transcript index cannot be read: "no such session" would be a guess), the `409`, then the write.
- **Session remove** finds the session through the unfiltered lookup (`findSession`) and refuses one that is live in a tmux pane (`409 in-tmux`): that one can be ended normally, so it always shows.
- **Group remove** looks the key up in the app tier's eligibility snapshot, which holds the sessions of the last **7 days** (the default window, not 24 h). A folder whose sessions all ended
  earlier is found by an **index-only walk** of every transcript (`findGroup`: no ps, tmux, registry or report read, so nothing is live), so a folder can be removed at any age. A key that is already stored is
  stamped again (`at` is renewed), even when the index cannot be read. A folder that is a project added to nika can never be removed (`409 registered`).
- `dropped` is the number of other entries the write removed (see below). **Show again** works for any id or key, also one nika no longer knows, so a stale entry never stays until it expires.
- `GET /api/app/hidden` answers what is removed, newest first, at most 100 of each list (`more` counts the rest; no `404`, no `503`):
```json
{ "groups":   [ { "key": "<16 hex>", "label": "demo", "root": "<project folder>", "at": 1700000000000 } ],
  "sessions": [ { "id": "<UUID>", "name": "builder-1", "project": "demo", "at": 1700000000000 } ],
  "more": { "groups": 0, "sessions": 0 } }
```
  `label` (`clean`, 120) and `root` (`clean`, 300) come from the folder with that key in the unfiltered snapshot, else from **one** index-only walk for all the folders that snapshot misses
  (`findGroups`; an index that fails after it found some folders keeps those), else `null`; `name` (`clean`, 80) and `project` (`clean`, 120) come from the transcript index, `null` when it cannot
  read or does not know the id. `at` is the time of the removal in ms. The list is app tier only.

**What a removal hides.** A **session** entry hides that session (and the row its host id folds into) from every list. A **folder** entry hides the rows of that folder that started at or before the
removal (a session that starts later brings the folder back, with only the new rows), and only while the folder is not a project added to nika. A row that is **live in a tmux pane nika sees always
shows**, whatever the entries say; every write drops the session entries that run in a pane. The snapshot leaves a hidden row out and counts it (`group.hidden`, `snapshot.hidden`, next section); a folder
that is not a project and has no row left is dropped from the snapshot, and a project's group stays, empty.

**Storage** (`src/hidden.js`; `docs/security.md`, the RM rows; §6): `<state>/hidden.json`, `{ "v": 1, "sessions": { "<UUID>": { "at": <ms> } }, "groups": { "<project key>": { "at": <ms> } } }` and nothing
else (no name, no path), 0600 in a 0700 folder, written atomically through `src/fwrite.js` one write after the other. It is nika's own file, but any local process of the user can edit it, so it is read like
every agent-writable file (through `src/fsafe.js`, 64 KiB at most, parsed strictly): an invalid entry is ignored and a bad file reads as empty, each with one warning on stderr, never a crash. An entry older than
90 days is dropped, and the newest 500 of both lists together are kept. Reads never write. The server's snapshot cache (1.5 s) is keyed by a counter that every successful write of the process moves, so the
refresh right after a Remove or an Undo is fresh (the browser tier, its own process, follows within the 1.5 s).

**Which snapshot is filtered.** The list views are: `GET /api/agents` (both tiers), the app's status line and `nika status`. The app tier's eligibility snapshot (pane eligibility, the orchestrator and the saved-pick states,
`paneKey`) and `findSession(s)` are **not** filtered, so a removed session that runs still has its pane, a saved orchestrator still reads as running, and the session page still opens.

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

0.5 (W12) adds, on both tiers, `"hostId": "<session id>" | null`: after `/compact` Claude Code continues the conversation as a background
job in a child `claude` (registry `kind: "bg"`, a `jobId`, no `tmux`) while the `claude` in the pane keeps its old session id and records
the job as `parkedJobId`. When exactly one live background session and exactly one live non-background session share that id, both
resolve to the same project and the child has no `tmux` of its own, the snapshot has ONE row for the pair: the child's (its `id`,
`state`, `pid`, `attention`, transcript fields), with the host's pane (`pane`, and with it `role`, `parent`, `depth`, `children`), and
`hostId` = the host's session id. The host has no row. Both registry entries must carry a `cwd` (two entries without one are not "the same
project"). The row's `report` is the child's own, else the host's (a spawned agent's `<name>.session` holds the id claude was launched
with, which after `/compact` is the host's). `report.sessionId` is the session id the report is filed under: the row's own id when the
report is its own, the host's id when it was taken from the host, `null` when the row has no report; the page opens
`GET /api/report/<report.sessionId>` (a merged row's own id has no report file). Every other row, and every pair that does not match one to one, has `hostId: null`
(a page that gets no field, from an older server, reads it as null). `GET /api/app/projects`' `orchestrator` and Start accept either id
(see `orchestrator` above). The ids are compared for equality only (`^[A-Za-z0-9_-]{1,64}$`), never used as a path, argv element or text.

0.4 adds the context size, on both tiers (C6), so the rows and the session header can show how full a session's context is:
- `"context": { "tokens": n, "window": n | null, "compactAt": n | null, "pct": n | null, "compaction": "on" | "off" | "typed" | "none" } | null`.
  Numbers and one state word; no transcript text and no model id. `null` when the transcript's last assistant entry carries no usable usage
  (see below).
- `tokens`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the LAST assistant entry in the transcript's tail chunk
  (the same bounded head and tail read as everything else; an entry beyond the tail window is not read, and a head that is far behind the end
  is never used; but see the compact boundary below). A missing or `null` field counts as 0 (the API types allow `null` for the cache counts). A usage with a present, non-null field that is not a whole number from 0 to 10,000,000, or a sum above it, gives
  `null`; so does a last assistant entry with no usage. A synthetic entry (model `<synthetic>`: an interrupt or an API error, usage all zeros)
  is skipped, not read.
- Compact boundary (0.5.4, AC): a `system` entry with `subtype` `compact_boundary` that comes **after** the last assistant entry of the tail ends the
  older reply's size: `tokens` is then its integer `compactMetadata.postTokens` (0 to 10,000,000, else `context` is `null`), and nothing else of that entry
  is read. The model is the nearest earlier real assistant entry's, else the transcript's own. So a size taken before a compaction is never shown after it,
  and a typed `/compact` (below) re-arms only after a real drop. The next assistant entry takes over again.
- `window`: the compaction window in tokens. Auto-compact on: the window the launch uses (`src/compact.js`: the setting's window, cut to the
  model's own, or the model's own for `"model"`; so a 400k setting on a 1M-window model is `400000`). Off: the model's own window. A model id
  the catalog does not know counts as 200k. `null` (with `compactAt` and `pct`) when the entry names no model.
- `pct`: `tokens / window x 100`, one decimal, not capped (over 100 is possible).
- `compactAt`: the launch threshold in tokens (`compactLaunch(model, compaction).compactAt`), for a live session nika started (its pane carries a nika
  `@nika-role`; `"on"`) and, since 0.5.4, for a session nika types into (`"typed"`); `null` otherwise.
- `compaction`: `"off"` when Settings has auto-compact off (every session); else `"on"` for a live session nika started; `"typed"` (0.5.4, AC) for a live
  session nika did not start **on the app tier**: its pane is listed by tmux, not dead, and runs claude (`CLAUDE_COMMAND`), so nika types `/compact` at `compactAt`
  when the session waits past it; and `"none"` for any other (an ended session, a pane nika cannot type into, or any session on the browser tier and in
  `nika status`, which never read `typed`: nika's setting does not act on it there, so its window is only a yardstick). An orchestrator
  nika adopted (O1) carries the tag but was started by the user, so it reads `"on"` until nika resumes it.
- The setting comes from nika's own `config.json` through the validated `loadConfig`, on both tiers; the browser tier (:3335) therefore
  also shows these numbers. The page formats them and never computes a window, a per cent or a threshold.

0.5 (W8) writes down `subagents`, which both tiers already carry (W8 adds no field to it; W9 adds `label`, below):
- `"subagents": [ { "id": "<SUBAGENT_ID>", "type": "<clean(agentType, 80)>" | null, "label": "<label>", "description": "<clean(…, 200)>" | null,
  "model": "<clean(model, 80)>" | null, "modelLabel": "<label>" | null, "state": "running" | "finished" | "stopped", "lastActivity": <ms> | null } ]`:
  Claude's own subagents of the session (the in-process children of its `Agent` tool), one per `agent-<id>.meta.json` in the session's `subagents/`
  folder (≤ 64 KB each, a broken file is skipped); `[]` when there are none, no folder, or the folder is a symlink (`<session id>` and `subagents` must be
  real directories). The meta is read again on every snapshot; nothing is cached.
- `model` is the meta's `model` key, else its `pickedEffortModel` (Claude Code 2.1.325 writes only the second); `modelLabel` is the catalog label or the
  derived one, as for a session.
- `state`: `finished` when the meta holds `finished: true`; else `running` when the parent session is live; else `stopped`. `finished: true` means
  the subagent's loop has stopped, not that it is gone for good: Claude removes the key again when the subagent wakes up (`claude-tui.md` §14), so a
  subagent can go `finished`, then `running` again. A page must read the state at every poll and never latch `finished`.
- `lastActivity`: the mtime of `agent-<id>.jsonl` (`lstat`, the file is not read), or `null` when it does not exist yet. It moves only when the
  subagent writes a message, not while it waits on a long tool call, so it is not a liveness signal.
- Order: `running` first, then newest `lastActivity` first.
- No `toolUseId` (it is parsed from the meta for the history route's link and goes no further), no transcript text and no path. The browser tier gets
  exactly this; it draws the list as plain text (no link) and has no route to open a subagent (§4).

0.5 (W9) adds `label`, on both tiers: what kind of agent a row is. It is display only: no flag, prompt, tool list, permission, cap or route
depends on it, and it never reaches claude.
- An agent record gains `"label": "coder" | "reviewer" | "tester" | "designer" | "scout" | "writer" | "agent" | "sub-orchestrator" | null` (first match wins):
  a live pane tagged `@nika-role sub-orchestrator` → `"sub-orchestrator"` (a `@nika-kind` on it is ignored); a live pane tagged `@nika-role agent`
  → its `@nika-kind` when that is exactly one of the seven words, else `"agent"` (an agent spawned before 0.5, or one whose tag call failed);
  the main orchestrator, a session nika did not start, an ended session (no pane, so no tags) and a pane with no `@nika-role` → `null`. The
  tag is read with the listing of §8 (its last field) and only beside `@nika-role agent`; a value that is padded, in another case or carries a
  tab is not a word of the list (the pane's kind is absent, so the label is `agent`). The orchestrator is never labelled.
- A subagent entry's `label` is always a non-empty string of 1 to 24 code points, from the entry's `type` (Claude's `agentType`, not a path or text
  of a transcript): a built-in type of Claude Code maps to a kind (exact, case-sensitive match); a missing, empty or non-string type gives
  `"agent"`; any other type (a custom or plugin agent, a built-in added later) gives its own name, cleaned (`clean(type, 80)`, so controls,
  escapes and bidi marks are gone), after the last `:` when anything is left there (a plugin's agent `plugin:name` shows `name`; `plugin:` alone
  keeps `plugin:`), cut to 24 code points (23 and `…`, never inside a surrogate pair). `type` stays in the entry (the read-only view's title falls
  back to it). A custom agent that is named like a built-in gets the built-in's label (one rule, the meta's `isBuiltIn` is not read).

  | `type` | `label` |
  |---|---|
  | `Explore`, `claude-code-guide`, `web-fetch` | `scout` |
  | `Plan` | `designer` |
  | `statusline-setup` | `coder` |
  | `general-purpose`, `claude`, `fork` | `agent` |

  `web-fetch` and `fork` are not confirmed built-ins of Claude Code (they were seen only in the Agent tool list of one build, not on its
  documentation page); if they are not Claude's they still map, to harmless words. Lookup is by own property: `constructor` or `__proto__`
  is a name, not a table hit.
- No new field carries a path or a transcript string; the values are the seven words, `sub-orchestrator`, a cleaned type name, or `null`.

0.5.4 (RM) adds the removed counts, on both tiers: each group gains `"hidden": n` (its rows left out by the user's removals, §3 "Removed items") and the snapshot gains `"hidden": n` (all of them, those of
dropped folders included). **Counts only**: no id, key or time of a removed item reaches :3335. A hidden row is in none of the `counts`. `nika status` prints one line when the total is above 0
(`… N removed from the list (Show removed in the nika app)`).

0.5.4 (P1) writes down the agent's `pane` object, which both tiers carry: `"pane": { "id": "%12", "session": "<clean(tmux session, 80)>", "windowIndex": "<digits>" | null, "title": "<clean(title, 200)>",
"command": "<clean(command, 80)>" } | null` (`null` for a session with no pane). `windowIndex` (0.5.4) is the tmux window's index in its session, from `#{window_index}` of the same pane listing (§8): a string of 1 to 6
digits (`WINDOW_INDEX`), else `null`. It is display only (`nika status` shows `<index>:<pane id>`, the app's row hint says `(window <index>)`) and never an argument to tmux. A page that gets no field, from an older server,
reads it as `null`.

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
`source` ∈ `builtin user project plugin`. **Order (0.5, P1; owner request 2026-11-16: yours first):** project entries, then user
(personal) entries, then the entries of the plugins applied to the project, then the built-ins, then the entries of every
other installed plugin; inside a group the scan order stays (built-ins in their curated order, user, project and plugin
entries as found). Built-ins are no longer first. `name` has no leading `/` (the palette inserts
`/<name> `): the bare name for built-in, user and project entries, `<plugin>:<name>` for plugin entries. `argHint` is
`""` when none; `dialog: true` marks a built-in that opens a TUI dialog (`claude-tui.md` §4); `plugin` is set for
plugin entries. Without `project`: built-in, user and plugin entries (plugins install at user level), ordered user,
built-ins, plugins (no project and no applied list, so those two groups are empty); with it, project entries too, and the
plugins in that project's saved plugin list (nika's own config, `perProject[key].plugins`, the list the plugins route reads and
writes) come before the built-ins. The list is read by the route from nika's own config for the project it already
validated; it is never taken from the request, and an entry of the list is matched against an installed plugin's whole
`name@marketplace` key (the same name from another marketplace is "another plugin"; a key that is not installed adds
nothing). A project without a saved list has no applied group. The answer keeps its shape: no key, flag or position field is
added, and no plugin key reaches the body.

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
(built-ins count; the scan order, built-ins then user, project and plugins, decides which entries survive the cap, and the new order
does not change that), cached 10 s per project with one scan in flight per project (0.5, P1: the cache holds the scan; the order above is applied on every
call, after the cache, and kept per applied list for the life of that scan, at most 8 lists, so a repeated call inside the 10 s returns the same
answer and one project's plugin list never reaches another's answer, while a plugin list saved meanwhile shows at once); within the plugin source the first entry
with a given full name wins. Paths are never returned (T22). The page shows the answer as it comes (`PALETTE_MAX` 1000, the server's own bound, so a bare `/`
lists every entry and the header count is the real total); a query still ranks exact name, name prefix, name substring, then description, and the server order
breaks ties inside a tier (spec §9.7).

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
                 "text": "<cleanBlock()>", "tool": "<name>?", "truncated": false, "subagent": "<agent id>?" } ],
  "nextBefore": 123456 | null,
  "cut": true? }          // 0.5.1: only on a long-line page that dropped entries (see "Long lines" below); otherwise the key is absent
```
Text is passed through `cleanBlock()` (first removes whole terminal escape sequences: CSI `ESC [ … final`, OSC
`ESC ] … BEL|ESC \` (an unterminated OSC drops the rest of the text) and two-character `ESC @`–`ESC _`, so `ESC[2mCompactedESC[22m`
reads `Compacted` and a link's text stays while its target goes; a literal `[2m` without ESC is text and stays; then keeps
`\n` and `\t` and strips every other control and bidi code point; `clean()` does the same for one line) and the
page renders it with `textContent`.

**`subagent` (0.5, W8).** A `tool_use` entry gains `"subagent": "<agent id>"` when all four hold: (1) the block's `name` is `Agent` (Claude Code
2.1.325) or `Task` (older builds); (2) the block's `id` matches `TOOL_USE_ID`; (3) exactly one meta in this session's `subagents/` folder has that
`toolUseId` (two or more: no link for any of them); (4) that meta's agent id has an `agent-<id>.jsonl` in nika's own listing of the folder, so the route
below would find it. No other field changes. The tool-use id is used inside the server only: it is compared with the metas' `toolUseId` and is in no
response. The link map is built only when the page holds at least one such call: one `readdir` and the metas (each ≤ 64 KB, 8 at a time), inside the
read's own slot of the shared limiter, read again on every request (no cache; a meta appears a moment after its call is written, so a call can get its
`subagent` on a later read than the one that first returned it, and the session window then adds the link to the entry it already shows). A failure
leaves the page without links, never without entries. A page that gets no field (an older server) draws no link. Entries of the subagent route below
never carry the field.

**Pictures (0.5.1, C; ADR 0020, `docs/security.md` T59).** Images used to be skipped. Now:
- An `image` content block of a message is an entry with `"kind": "image"`, `"text": ""` and two more fields, `"media": "png" | "jpeg" | "gif" | "webp" | null` and
  `"size": <n> | null`. `media` is set only when the block's source is base64 and its `media_type` is exactly one of the four; `size` is the decoded size estimated from the
  length of the base64 string and its `=` padding (null when `media` is null, when the data is not a string, or when its length is not a multiple of 4). Nothing is decoded or
  tested here, so a forged block still lists (and fails on the image route below). The entry's `id` is the `ref` the image routes take.
- A `tool_result` entry whose content is an array gains `"images": [ { "ref": "<offset>:<block>.<part>", "media", "size" } ]` (the `image` parts among the first 1000 parts, at most 8,
  in order) and `"imagesMore": <n>` (image parts not listed). A result with no picture has neither field. The result's text is unchanged (text parts only).
- A block of any other type, and an `image` block inside a `thinking` or `text` block, are skipped as before.

**Long lines (0.5.1, C; T60).** A transcript line over the 1 MB window used to be skipped (a screenshot is one such line). A line is now read whole up to 16 MiB (`LINE_MAX`,
newline included); its start is searched at most 32 MiB back (`SCAN_MAX`); a line beyond either limit is skipped as before, and `nextBefore` steps over it. A long line comes
back as a page of its own (its entries, and `nextBefore` its start). Long reads and image reads share one slot (`longLimited`, always taken inside the 4 in flight above); a
16-entry cache keyed by device, inode and line end keeps the parsed entries of a long line (copies, never bytes), only for a line that ends with a newline. The 32 KB cut per
entry applies as before; picture bytes are in no entry.
- **At most 500 entries per long-line page (`LONG_ENTRIES_MAX`).** A page made from one long line keeps the **last 500 entries of the line**. When it drops some, the body
  carries `"cut": true`; every other page has no `cut` key at all, so a client that does not know the field sees the old shape. `nextBefore` is still the start of that
  line, so the earlier lines stay reachable; the dropped start of that one line is not. A window page made of many short lines is never capped or marked this way. The cap
  bounds the parse result and the response, not only the read: a forged line of a hundred thousand tiny blocks is walked from its end and stops at 500 entries.
- **Never cached:** a cut page, and a page whose entry text adds up to more than 1 MiB (1,048,576 characters); each is read again on the next request. A page under both limits is
  cached as before.

### `GET /api/app/session/:id/subagents/:agentId/history?before=<n>&limit=<n>` (0.5, W8)
The read-only view of one of Claude's own subagents (spec §9.17). The request carries two ids and byte offsets, never a path. `id` must be a `UUID`
present in nika's transcript index (as for the route above); `agentId` must match `SUBAGENT_ID` and be a name in nika's own listing of that session's
`<project dir>/<session id>/subagents/` folder (names `agent-<id>.jsonl` only). The file path is the listing's, never the request's. Both
`<session id>` and `subagents` must be real directories (`lstat`, so a planted symlink cannot move the read to another folder), and the file opens
through `fsafe.openRegular` (O_NOFOLLOW, regular, owned by the user, one link). `limit` and `before` mean what they mean on the route above, and so do
the bounds: at most 1 MB per request, entries over 32 KB cut (`"truncated": true`), and **one limiter shared by both history routes** (4 reads in
flight in all). `GET` only (other methods: 405). App tier only: the browser tier does not mount it (404, §4).

Checks, in this order; the first that fails answers:

| Check | Answer |
|---|---|
| `id` is not a `UUID` | 404 `not_found` "no such session" |
| `agentId` does not match `SUBAGENT_ID` | 404 `not_found` "no such subagent" |
| `limit` is not an integer 1–200 | 400 `invalid` (the text of the route above) |
| `before` is not a byte offset | 400 `invalid` |
| the session is not in nika's transcript index (10 s memo) | 404 "no such session" |
| `agentId` is not in the session's `subagents/` listing, or the folder is missing or not real | 404 "no such subagent" |
| the file cannot be opened through `fsafe` (a symlink, another owner, more than one link, not a regular file) or read | 404 "transcript not readable" |
| `before` is beyond the end of the file | 400 "before is beyond the end of the transcript" |

The malformed ids are refused before `limit` is read: a bad agent id with `limit=0` is 404, not 400. A dot segment in `:agentId` (`..`, `%2E%2E`) never reaches the
handler (the URL parser folds it into the session's own history route, with the same guard); the handler is not called.

200: exactly the history shape, `{ "entries": [ … ], "nextBefore": n | null }` (and `"cut": true` on a long-line page that dropped entries, with the same 500-entry cap and
cache rule as above), oldest first, read from the subagent's own file by the same code as the route
above: `user` and `assistant` lines are entries, every other line type (`attachment`, `api-request*`) is skipped. Text is data: instruction-like text in a
subagent's transcript is shown, never acted on.

**Polling (ruling 2026-11-15).** A page that follows a subagent (the session window's read-only mode) reads the newest page every 5 s once it has one
(3 s until then) and keeps doing so while the parent session is live, **also after the subagent's state reads `finished`**: `finished: true` in the
subagent's meta means its loop has stopped, and Claude removes it again when the subagent wakes up (for example when its background shell ends; Claude Code
as installed, 2026-11-15, `claude-tui.md` §14). The page stops only when the state reads `stopped` (the parent session is gone), after one last read at the live edge. The
state itself comes from the snapshot's `subagents` (below), read again on every poll; nothing is latched. Until the file exists the route answers 404
"no such subagent" and the page keeps asking.

### `GET /api/app/session/:id/image/:ref` and `GET /api/app/session/:id/subagents/:agentId/image/:ref` (0.5.1, C)
The picture a history entry names (ADR 0020, `docs/security.md` T59). The request carries ids and a transcript offset, never a path. `id` must be a `UUID` present in
nika's transcript index and `agentId` a `SUBAGENT_ID` in nika's own listing of that session's `subagents/` folder (both as for the history routes). `ref` is an entry's `id`
(`"<line offset>:<block>"`) or an `images[].ref` (`"<line offset>:<block>.<part>"`): decimal digits only, the offset 1 to 15 digits, the block 1 to 5, the part 1 to 3
(`IMAGE_REF` in `src/ids.js`); the colon may arrive percent-encoded (`%3A`). `GET` only (other methods: 405). App tier only: the browser tier mounts none of them (404, §4). No
body is read and none is sent; the file is found from the index, then the one line that starts at that offset is read whole (up to 16 MiB; the offset must be the start of a line) and
the one block or part is taken from it.

Checks, in this order; the first that fails answers:

| Check | Answer |
|---|---|
| `id` is not a `UUID` | 404 `not_found` "no such session" |
| (subagent route) `agentId` does not match `SUBAGENT_ID` | 404 `not_found` "no such subagent" |
| `ref` does not match `IMAGE_REF` | 404 `not_found` "no such image" |
| the session is not in nika's transcript index | 404 "no such session" |
| (subagent route) `agentId` is not in the session's listing | 404 "no such subagent" |
| no line starts at the offset, the line does not parse, has no such block or part, or the block is not an `image` | 404 "no such image" (one answer for all of them) |
| the file cannot be opened through `fsafe` or read | 404 "no such image" |
| the base64 is longer than 11 184 812 characters, or decodes to more than 8 MiB | 413 `too-large` "image too large" |
| the source is not base64, the declared type is not png, jpeg, gif or webp, the data is not valid base64, or the magic bytes are not the declared type (SVG and every other type included) | 415 `not-image` "not a supported image" |

200: `{ "type": "png" | "jpeg" | "gif" | "webp", "data": "<standard base64>" }`. `data` is the server's own encoding of the decoded bytes (the transcript's string is never relayed, so
unused bits of the last character or any other variation cannot pass through). `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, JSON. No refusal carries a byte, a type
name or a path from the block. The reads take three slots in one fixed order (0.5.4, SF): the image gate (one picture read waits at a time), then a slot of the history limiter (4 in flight, shared with the page reads), then the one long slot; a page read takes the limiter and, only for a window inside one long line, the long slot, never the gate, so queued pictures never hold up a page read and no wait can form a cycle. The page turns the answer into a `data:` URL from a fixed MIME table
(png, jpeg, gif, webp) and a validated base64 string and sets it as an `<img>` source only; there is no `blob:` and no raw image route (an `<img>` cannot send the secret).

### `GET /api/app/pane/:id/attachments/:attId/image` (0.5.1, C)
The picture of an **unsent image attachment** of this pane, for the composer's thumbnail (ADR 0020, `docs/security.md` T61). The one route that serves a stored file back. App tier only
(the browser tier: 404); `GET` only. Order: `id` pane 404 (an eligible Claude pane, as for the other attachment routes), `attId` 404 (16 lowercase hex characters, else
404 `not_found` "no such image"), then the store. The store answers only for a record this process made, for this pane, not yet sent, of type png, jpeg, gif or webp; it opens the
file with `O_NOFOLLOW` (regular, owned by the user, one link), checks that the size is the record's and that the folder's `realpath` did not change, reads it (at most two such reads
at a time) and checks that the magic bytes are still the recorded type. Every other case, and any error, is **one and the same** 404 `not_found` "no such image": an unknown id, another
pane's, a sent one, a PDF or text file, a file that is gone, swapped, resized or retyped.
- 200: `{ "type": "png" | "jpeg" | "gif" | "webp", "data": "<standard base64>" }`, `no-store`, `nosniff`. The route rebuilds the object from those two fields and refuses (404) any
  other store answer, so no path, size or name can leave. A store error is logged as `nika: attachments: <code>` and answered as the 404.
- `/api/app/pane/:id/attachments/pick/image` is the chooser poll route (below), not an attachment: it answers its own 404 "no such chooser request".

### `GET /api/app/pane/:id/capture`
`id` `PANE_ID`, must appear in the current `tmux list-panes -a`, be either a live Claude session's pane
(registry `tmux` field) or a pane nika started (`orchestrator/start`, `spawn`), **and** its `pane_current_command` must
look like claude (`CLAUDE_COMMAND`: `claude`, `node`, a version string) at that moment, for a started pane too (tmux can
reuse a pane id after a restart), **and** the pane must not be dead (0.5: `#{pane_dead}` is `0`; with `remain-on-exit` tmux keeps a
pane whose process ended and still names its command after the pane's argv, so it would otherwise pass). Else 404. A listing row
whose `pane_dead` is neither `0` nor `1` is dropped, so that pane is not in the listing at all. Cached 100 ms per pane (0.5, F10: was 250 ms, so the
page sees Claude's repaint after a resize sooner; this is the mirror's cache, `src/mirror.js` `TTL_MS`, the same one every mention below means),
one capture in flight per pane (others wait for it), `ETag` = hash of the mirror's rows hash **and** the `mode` and `modeConfirmed` the
response shows (so a held mode that changed over unchanged rows is never hidden behind a 304), and (0.5, F14) the `survey` field, which depends on the pane's vim memory;
`If-None-Match` → 304.
```json
{ "cols": 120, "rows": [ [ { "t": "text", "s": { "b": true, "fg": 4, "bg": null, "u": false, "i": false, "d": false } } ] ],
  "cursor": { "x": 0, "y": 0, "visible": true }, "alt": true, "scrolled": false, "etag": "<hex>",
  "mode": "plan", "modeConfirmed": true,
  "prompt": { "question": "Do you want to proceed?", "options": [ { "n": 1, "label": "Yes" }, { "n": 2, "label": "No" } ],
              "sig": "<16 hex>", "bypass": false },
  "draft": { "state": "text", "mode": "prompt", "text": "fix the typo in acme-api", "sig": "<16 hex>",
             "box": { "top": 33, "bottom": 35 }, "cursorAtEnd": true, "suggestion": null, "queued": false, "ghost": false, "edit": "insert" } }
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
  **`top` (0.5.1, E):** the prompt carries `"top": <n>`, the index in `rows` of the row of its question (the row directly above option 1). Display only: the page crops the terminal
  view there while it shows nika's own prompt panel. It is in no `sig`, no guard reads it and no route reads it back.

0.5 fields, scroll state (W3, ADR 0018), read from the capture the route already took:
- `alt` (boolean): Claude draws in tmux's alternate screen, its full-screen view. It comes from `#{alternate_on}` in the same
  `display-message` as the size and cursor (§8: no extra tmux call). `false` for any value but `1`.
- `scrolled` (boolean): `alt` is true and a row on screen holds Claude's own scroll pill, `Jump to bottom` or `N new message(s)` (N 1 to
  999), anywhere in the row, drawn in the pill's colours (foreground 231 on background 237; `pillShown` in `src/mode.js`). It is display only: it
  decides the page's "Scrolled up" note and whether Jump to live also presses `C-End`, never whether a scroll key goes out (`POST …/scroll`
  sends `NPage` either way). `alt` is part of the mirror's ETag hash; `scrolled` follows from the rows and `alt`.

0.5 field, Claude's input box (`draft`), parsed server-side from the same rows by `src/draft.js` (reading rules, row shapes and the
wrap rule in `claude-tui.md` §10); the page mirrors it into the message box (spec §9.12):
- `draft` is `null` while the screen has no plain input box: the footer is not a known mode line (a permission prompt, a dialog,
  the transient `paste again to expand` hint), a permission prompt parses, there are
  a feedback survey is on screen or Claude's post-rating row `(Optional) Press [1] to tell us more` (a digit typed there would answer the survey or open `/feedback`, M1), there are
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
| `box` | `{ top, bottom }`: the row indexes of the two rule rows; the mirror's rows above `top` are the cut of spec §9.12. Plus an optional `tasks` (0.5, GT; LC18 Finding 2): an integer, the row index of the header of Claude's task list when the list is pinned directly above the box, with `0 <= tasks < top`; the field is absent otherwise. The list is exactly the block of `claude-tui.md` §1 (F13; header, task rows, at most one overflow row; either Claude version, the same strictness and count rules as the list under a dialog), then exactly ONE blank row, then the top rule at `top`. It is absent for no list, two or more blank rows or none, any other row between the list and the blank row (a transient hint row such as `Esc again to clear` counts), a list whose numbers do not add up, and a list under the mode line. It is on an `unreadable` draft's `box` too. **Display only:** the page's glide ends its frame there (spec §9.15); no key, write or gate reads it, and the browser tier carries no `draft`. The page keeps it only as an integer with `0 <= tasks < top` (`cleanDraft`), and the glide uses it only when it is also at most the number of rows of the view. Additive: an older page ignores it, and a newer page against an older server sees it absent and behaves as before |
| `cursorAtEnd` | the cursor sits right after the last real character of the last box row (padding does not count); `false` for `unreadable` |
| `ghost` | `true` when any dim, reverse-video or hint cell of the box was dropped as ghost text (the placeholder, a completion, the slash command's argument hint); `false` for plain text and for every `unreadable` draft (nothing was read). End and the commands do not press Enter on a box with `ghost: true` |
| `suggestion` | a string or `null`: Claude's prompt suggestion, the dim text Claude draws in an empty box after a turn (`claude-tui.md` §10.10), cleaned with `clean()` and cut at 200 characters; `null` when the box holds text, has no dim text, or the dim text is the box's own placeholder (it starts with `Try "`) or Claude's queued-messages placeholder (`queued` below). It is not part of `sig` and not of `text`; the page shows it as the message box's placeholder and accepts it through `POST /api/app/pane/:id/suggestion` below |
| `queued` | boolean, always present (`false` for `text`, `unreadable` and every other empty box). `true` for an empty box whose only content is the dim text `Press up to edit queued messages`, which Claude draws after it queued the message the user sent while a turn runs (`claude-tui.md` §10.12). The match is exact (case and wording); the box is `empty`, the text `''`, `suggestion` `null`, and the `sig` is the sig of any empty box (`queued` is not part of it, so a consumer that must tell the two apart reads this field). The page shows a `Queued` note while both of its boxes are empty and this is `true` |
| `edit` | `insert` (`-- INSERT --` shown now), `normal` (INSERT was seen on this pane before), `plain` (a probe `i` landed as text on this pane before) or `unknown`; the pane's memory, shown for display and route-side planning (the route reads the screen again, `claude-tui.md` §10.7). It is part of the ETag |

- The draft comes from the capture the route already took (no extra tmux call). App tier only: `/api/agents` and the browser tier
  never carry it (T51).

0.5 field, Claude's question dialogs and plan approvals (W1, ADR 0015), parsed server-side from the same rows by `src/dialog.js`
(shapes, patterns and the `unreadable` rules in `claude-tui.md` §13); the page draws a form from it (spec §9.16):
- `dialog` is `null` when no dialog is on screen, or when a permission `prompt` parses (the two anchors exclude each other). It is a
  pure function of the rows and the width, which the ETag already covers, so the ETag does not change.
- `{ "state": "unreadable", "kind": "ask" | "plan" | null, "reason": "cut" | "clipped" | "wide" | "numbers" | "tab" | "layout" | "survey" }`:
  a dialog shape is on screen but is not read exactly (checked in that order, the first reason decides). `cut`: no top rule above the
  strip, no strip, or a plan whose opening or closing dashed rule is not on screen (the dialog is taller than the pane and Claude clipped its top: the page may give the pane more rows for a question, F16, and, since 0.5.4 (O2), for a plan too, see "A cut-off question" under `PUT …/fit`; a plan with both dashed rules on screen and no prompt row is `layout`, not `cut`, 0.5.4 QPF F3c);
  `clipped` (0.5, F16): a tab header, an option label (also a plan's), the question, or a review question or answer that ends in `…` (Claude shortened it to the pane's width; more rows never help, so the page never grows for it; before F16 this was `cut`);
  `wide`: a row as wide as the pane (Claude may have cut it), a
  label that may have been word-wrapped, a plan's wrapped footer, a plan's wrapped prompt row (0.5.4, QPF F3: `Claude has written up a plan and is ready to execute. Would you like to proceed?` wraps at 85 columns; such a plan is `wide` at any height, never `cut`, so the page never grows for it), or fewer than 20 columns. A question or review footer wrapped over two or three rows is **read** since 0.5.4 (QP, O1) when each row but the last is too full to take the next row's first word at the pane width (`wrapProven` in `src/dialog.js`), else it is `layout`; `numbers`: option numbers not `1..k+2` without gaps,
  or above 9; `tab`: not exactly one current tab (two marked, or none); `layout`: any other shape (a duplicate label, a header with `☐`,
  `☒` or `✔`, a footer that disagrees with the strip, a string over its maximum); `survey`: a feedback survey is on screen, or Claude's row `(Optional) Press [1] to tell us more` that it draws for a few seconds after a rating (0.5, M1: a digit typed for an option could reach that row's `1`, which opens `/feedback`). `Exit plan
  mode?` and the auto-mode nudge are `unreadable` with `kind: null` and `reason: "layout"`: nika recognises them so that every control
  that needs a plain box fails closed, and never answers them. The page keeps its banner for every `unreadable`, after Reading (2 s, longer while it gives a cut-off question more rows, F16). An unknown `reason` cleans to `layout` on the page.
- `{ "state": "ready", "kind": "ask", "at": "question", "sig", "bypass", "tabs": [ { "header", "answered" } ], "current", "final",
  "question", "multi", "other", "options": [ { "n", "label", "description" | null, "checked" } ], "typed": null | { "text", "answered" } }`:
  one question, the current tab of Claude's strip. `final` is true for a single tab with a single-select question (the answer ends the
  dialog); `other` says whether free text is offered (single-select: always; multi-select: only on the last tab). Options are the real
  ones, `1..k` with `k` at most 7; Claude's free-text row (`k+1`) and `Chat about this` (`k+2`) are not listed.
  - `checked` (a boolean on **every** option since 0.5.1, D) is Claude's own mark: a multi-select box, or, on a single-select question, the
    tick (` ✔`) Claude draws after the option that is the answer already given. Before 0.5.1 it appeared for multi-select only.
  - `typed` (0.5.1, D; question steps only) is what Claude's own text row holds: `null` when the row is empty, else
    `{ "text": <1 to 500 characters, cleaned>, "answered": <boolean> }`. `answered` is the row's own mark: the ticked box on a multi-select
    question, the tick after the text on a single-select one. nika never edits that text; the page shows it read-only. Text over 500
    characters makes the whole step `unreadable` (`layout`), so `typed.text` is never cut.
  - `checked` and `typed` are display only. Neither is in the `sig` or in the step's identity, so `sig` does not change when an answer is
    given, changed or typed in the terminal; the ETag follows the rows as before.
- **A question step with a preview** (0.5.4, QP; Claude Code 2.1.328, `claude-tui.md` §13.10): the same `ready` / `ask` / `question` state as above, with three more keys, `focus`, `preview` and `notes`. There is no text row: `other` is `false`, `typed` is `null`, and every `options[].description` is `null` (`checked` is the answered tick, as on any single-select question); Claude's unnumbered `Chat about this` row is not an option. A digit never answers such a step (it only moves Claude's focus), so the options are `1..k` with `k` at most 7.
  - `focus`: the number of the option that has Claude's pointer, an integer `1..k`, or `"chat"` when the `Chat about this` row has it (Claude also keeps a pointer on one option row then; nika reads `chat`). The focus is not in the `sig`.
  - `preview`: `{ "rows": [<string>], "hidden": <integer>, "fallback": <boolean>, "view": "<16 hex>" }`. `rows` are the lines of the preview box as Claude draws them (at most 120 rows of at most 200 characters, `clean()`ed, the end of each row trimmed and the spaces before it kept), `[]` when `fallback` is true. `hidden` is the number of lines Claude left out of the box (its `✂ … N lines hidden` divider, up to 99999; `0` when there is no divider; the divider itself is read, never shown). `fallback` is true when Claude drew its one-line fallback (`(can't show the full preview · compare the labels and descriptions instead)`) instead of a preview. `view` is the first 16 hex characters of sha256 over the `sig`, the focus, `rows`, `hidden`, `fallback` and the note text: the one thing an answer on this step must not outrun (`POST …/dialog` below). More than 120 preview rows, a row of more than 200 characters, a `hidden` count above 99999, more than 7 options or a row that is not the captured shape make the step `unreadable` (`layout`); nothing is cut.
  - `notes`: `{ "text": null | <string, at most 300 characters>, "editing": <boolean> }`. `text` is `null` while the field is closed (`press n to add notes`), `""` while Claude's field is open and empty (`Add notes on this design…`), else the note Claude holds. `editing` is true while the field is open (the footer then also reads `ctrl+g to edit in <editor>`). A step whose footer carries `n to add notes` but not the up/down hint and `Tab to switch questions` as one set, or that has no strip with its Submit token, is `layout`.
  - The `sig` of a preview step has its own marker, so it differs from a plain step's with the same question and labels, and it does not move with the focus, the preview rows or the note (the `view` does). Server-side only, never in the capture: `noteRoom`, whether Claude's open notes field would still end before the pane's last cell (`POST …/dialog`, `note-room`). `final` is true for a single tab (the answer ends the dialog), as for any single-select question.
- `{ "state": "ready", "kind": "ask", "at": "review", "sig", "bypass", "tabs", "warn", "pairs": [ { "question", "answer" } ] }`: Claude's
  review step (`warn` is its `You have not answered all questions` row, or, since 0.5.4 (QPF F1a), the row `⚠ Some questions are unanswered` that Claude Code 2.1.329 and 2.1.330 draw; the review lists the answered questions only. Since Claude Code 2.1.328 it has no `Ready to submit your answers?` row: nika reads the review from the `1. Submit answers` row at column 0, `claude-tui.md` §13.2). Claude 2.1.326 draws a `│ ` bar in front of the rows of a long review question (and of none
  else); nika reads it per question, and `question`, `answer` and `sig` are the same with or without it (`claude-tui.md` §13.2).
- `{ "state": "ready", "kind": "plan", "at": "plan", "sig", "bypass", "options": [ { "n", "label", "text" } ] }`: the plan approval's
  choices; `text` marks the last option, Claude's free-text one (`Tell Claude what to change`, which nika never answers). The plan text is not
  in the field.
- `top` (0.5.1, E; every `ready` state, not in `unreadable`): the index in `rows` of the row a crop of the terminal view starts at, an integer. Question and review step: the rule
  row directly above the tab strip (row 0 when the dialog fills the pane; **0.5.2, R1:** the page may crop at 0 for a question or review step, and leaves out the blank rows right above the crop line; a plan is cropped from row 1). Plan approval: the single plain rule row under the plan's closing dashed rule (the plan text stays above it). Display only: it is in no `sig` or
  identity, no key is decided on it and no route reads it back; the page uses it only for a dialog it reads exactly and never with bypass in the guard's window.
- `sig` is the first 16 hex characters of sha256 over the parsed step (the strip headers, the current tab, the question, the labels and
  descriptions; or every review pair; or the visible plan rows and the choices), never over raw rows: it does not change with the focus, a tick
  or typed text. `bypass` is true when the step's region, or the prompt window (`bypassWindow`), mentions bypass; the route then answers only
  Decline. Strings pass through `clean()` (header 40, question 500, label 200, description 500, answer 500 characters; longer is `unreadable`).
  Labels and answers can hold the user's folder paths: shown in the app only, never logged. App tier only: `/api/agents` and the browser tier
  never carry it.

0.5 field, Claude's feedback survey (F14; `claude-tui.md` §10.13; the page: spec §9.5). Parsed server-side from the same rows by `src/survey.js` (`surveyOf`):
- `survey` is `null` when no survey is on screen, and also while a permission `prompt` parses or a dialog is on screen (that panel owns the slot, and its own gates hold). It stays `null`
  while Claude's post-rating row `(Optional) Press [1] to tell us more` shows (M1): that row is no survey and offers nothing to answer, so there is no panel; but for those seconds the
  capture's `draft` is `null` too (the draft sync pauses and nothing is typed), the keys route with `send: true` answers `409 prompt-open`, and the dialog reads `unreadable / survey`.
- `{ "state": "ready", "kind": "rating", "sig": "<16 hex>", "top": <n>, "options": [ { "n": 1, "label": "Bad" }, { "n": 2, "label": "Fine" }, { "n": 3, "label": "Good" }, { "n": 0, "label": "Dismiss" } ] }`:
  exactly the captured rating survey and nothing in the way of a digit. All of these must hold: the rows `● How is Claude doing this session? (optional)` (the bullet at column 0)
  and `  1: Bad … 2: Fine … 3: Good … 0: Dismiss` (indent exactly 2) once, the second directly below the first; no other row that looks like a survey question or options
  row; exactly one row (any content) between the options row and the input box's top rule; the box an empty prompt-mode box (ghost text allowed) with the cursor in it; the
  pane not in vim NORMAL (the pane's memory: `-- INSERT --` was seen on it and is not shown now). `kind` is always `rating` in 0.5 (the field is reserved for a later kind, see
  Consent below). `sig` is the first 16 hex characters of sha256 over the trimmed question row, the trimmed options row and the up to 3 non-blank rows above the question: it
  identifies this occurrence and does not change with the cursor or the free row. `top` (0.5.1, E) is the index in `rows` of the question row (0.5.2, R1: the page may crop at 0 for a survey too): display only, the page crops the terminal view there; it is not in `sig` and nothing reads it back.
- `{ "state": "terminal", "reason": "consent" | "bypass" | "unreadable" | "input" | "normal" }`: a survey is on screen and nika does not offer it (the page says to answer it in the
  terminal), checked in this order, the first that holds decides. `consent`: a row starts the transcript question (`Can Anthropic look at your session transcript`, an optional `●`
  before it), anywhere on the screen, also next to a rating. `bypass`: one of the last 15 non-blank rows mentions bypass (`bypassWindow`). `unreadable`: the rows are not exactly the
  captured pair once directly above the box (another question, another indent, a wrapped question below 46 columns, two pairs, a different number of free rows). `input`: the box is
  not an empty prompt-mode box with the cursor in it (text, a `!` box, an older prompt, no readable box). `normal`: vim NORMAL, where a digit is a vim command.
- **Consent is terminal-only in 0.5.** The follow-up question whether Anthropic may look at the session transcript was never captured live (spike S-F14 could not reach it:
  `claude-tui.md` §10.13), so its rows are not recorded, and its keys are the letters `y`, `n` and `d`, not digits. nika therefore never offers it: the `consent` reason has no
  `ready` form, and the body of the survey route cannot carry a letter. Answering it later needs a live capture and a new body shape. **nika never sends `d`** (Don't ask again
  writes `transcriptShareDismissed: true` to the user's Claude config).
- The field is part of the ETag (it depends on the pane's vim memory, which the rows' hash does not cover). App tier only: `/api/agents` and the browser tier never carry it.
  Nothing of it is logged.

0.5.4 field, the note of the typed `/compact` (AC; ADR 0014, amendment 2026-11-19; `src/autocompact.js`): `"compacted": null | { "state": "typed" | "compacted" | "stopped", "at": <ms>, "tokens": n }`,
always present in the capture body of the app tier (`null` when there is no note), keys in that order, **no session id and no text**.
- `typed`: nika typed `/compact` into the pane's session at `at` (the size `tokens` was at or past the compact point). `compacted`: that session's size has dropped
  below the point since (the note of a `typed` one turns into this). Both belong to the session that was typed into, found by its id or its `hostId`: another session in
  the pane (a `/clear`) shows none. `stopped`: nika gave up on the **pane** after 3 failed attempts (a total since the app started; a success never resets it) and types
  nothing more into it until the app restarts; the pane's own note, whatever session is in it. The page draws each with its own icon, colour and words, from the numbers.
- What decides it (the sweep runs on the app's 3 s status timer, at most one pane per tick; none of it is a request): the setting is on; the pane is an eligible pane
  holding exactly one live session; the size is at or past `compactAt`; the registry has read `idle` at each of nika's ticks for at least 60 s with the size and the session
  unchanged (a tick that does not observe the pane restarts the count); no user action named the pane for 60 s (below); a size below the point has been read since the
  last typed `/compact` (the pane is *armed*); at least 10 minutes since the last attempt that sent a key; fewer than 3 failed attempts. A refusal before any key retries after
  30 s; an attempt that sent a key counts as failed unless a turn started or the box no longer read `/compact` within about 2 s after the `Enter` (a box that still reads `/compact` gets nika's own text taken out with `C-u`; one nika cannot read after the `Enter` is not confirmed either). The typing is the Compact quick action's own (`/`, `compact`, `Enter` only when the box reads exactly `❯ /compact` and the screen is quiet; `claude-tui.md` §10),
  inside the pane's control lock, without waiting for it, and nothing else is sent (at most 11 key requests per attempt, through the per-pane key limit). All of it is in memory:
  an app restart arms every pane again and clears the failure count.
- The note is part of the ETag (it changes without the screen changing). App tier only: `/api/agents`, the browser tier and the CLI never carry it.

**Typing stamp (0.5.4, AC).** So that nika never types `/compact` over a user who is typing, a request that names the pane as typed in **stamps** it (in memory; it only delays the
typing, and a holder of the app secret can send it). The stamp is set once the request's body check and pane check have passed, on arrival, before the controller, so a 409 or 429
answer stamps too; a `400`, `413` or `415` body check, or a `404` pane check, stamps nothing. A stamp is forgotten only when a good tmux listing no longer lists the pane.
- The request header `X-Nika-Typing: 1` on this route (exactly the string `1`; any other value is ignored) stamps the pane, also when the capture then fails. The session page sends it
  once, on the first capture after an edit in its message box (some edits make no draft request at all; IME events count).
- Sixteen routes stamp: `POST …/keys`, `POST …/mode`, `PUT …/draft`, `POST …/submit`, `POST …/scroll`, `POST …/attachments`, `POST …/attachments/pick`,
  `DELETE …/attachments/:attId` (it is not eligibility-gated, so the pane may be gone; the stamp of an unlisted pane is dropped at the next refresh), `POST …/attach-send`,
  `POST …/suggestion`, `POST …/dialog`, `POST …/survey`, `POST …/answer`, `POST …/command`, `POST …/end` and `POST …/stop`.
- Not stamped: the fit routes (`PUT`/`DELETE …/fit`, the heartbeat), a capture without the header, `GET …/modes`, the chooser's poll, the image reads, the attachment list
  (`GET …/attachments`) and the kept-draft routes (a save of the unsent text is not a keystroke to Claude).

### `GET /api/app/modes`
`200 { "modes": { "%3": { "mode": "plan", "confirmed": true } }, "compacted": { "%3": { "state": "typed", "at": 1700000000000, "tokens": 330000 } } }` — one entry per eligible pane (same rule as
capture), keyed by `PANE_ID`; `mode` and `confirmed` as capture's `mode` and `modeConfirmed` (the key stays
`confirmed`). Since 0.5.4 (AC) the body also carries `compacted`: always an object, with an entry (the capture's note, above) only for an eligible pane that has one, so the dashboard can
show the notes without a capture per pane. Reads go through the mirror's capture cache (100 ms per pane, one capture in flight per pane), at most 4
captures at once; a pane whose capture fails is left out (of `modes`; its note is still listed). The app-tier dashboard polls it every 3 s. This route is the
"app-tier snapshot" mode of spec §6.1: `/api/agents`, shared by both tiers, stays unchanged and gains no mode.

### `POST /api/app/pane/:id/keys` (body ≤ 20 KB)
```json
{ "text": "<≤ 1024 chars, no C0/C1 controls>", "paste": "<≤ 16 KB UTF-8, multi-line>", "keys": [ "Enter" ], "send": true }
```
At least one of `text`, `paste`, `keys`; `text` and `paste` are mutually exclusive (→ 400). `send` is optional and, when present, the boolean `true`
(`false`, `null`, a number or a string → 400 `invalid`, before the pane check); see "Send's own typing" below. `text` with any C0/C1
control → 400. `paste`: `\r\n` and `\r` become `\n`; every other C0 except `\n` `\t`, DEL, C1 and ESC is stripped (so
the bracketed-paste end marker cannot be forged), then sent with bracketed paste (§8); tmux turns `\n` into CR inside
the paste (no `-r`), as a terminal paste would. Every validation failure, including size, is `400 invalid`. `keys` ≤ 8 entries, each ∈
`KEY_NAME`, sent after the text or paste. Same pane rule as capture. 20 requests/s per pane → **429**. Response
`200 { "sent": { "text": 12, "paste": 0, "keys": 1 } }` (counts of characters / keys sent). Stop is no longer this route:
it is `POST /api/app/pane/:id/stop` below (a bare `Escape` does not interrupt Claude while its input is in vim insert mode).

Chunks (0.5, W13). A `text` of more than 700 characters is typed in chunks (`chunks()` in `src/draft.js`: at most 700 characters each),
one `send-keys -l --` per chunk, `CHUNK_GAP_MS` = 300 ms apart, and the request answers after the last one. Claude reads a burst of 801 or
more characters as a paste (`[Pasted text #N]`) and at 1023 or 1024 keeps only the last one or two (live check L8, `claude-tui.md`
§10.12), so one `send-keys` of up to 1024 characters would lose text. A text of 700 characters or fewer is one call, as before; the cut
adds and drops no character (trailing spaces move to the next chunk). A chunk that fails stops everything: no later chunk, no `paste` and
no named key follows, the answer is the tmux failure, and the chunks already typed stay in Claude's input. The route holds no pane
lock, so for a text of 701 to 1024 characters the time between the guard's capture (if any) and the last chunk grows from a few
milliseconds to about 300 ms (`docs/security.md` T7, T26); with `send: true` every chunk after the first looks at the screen again (below).

Bypass-prompt guard (0.3, T26). `Enter` confirms the highlighted option of a permission prompt, a digit picks one, and
`BTab` (Shift-Tab) can pick "allow for this session", so a request whose `keys` contains `Enter` or `BTab`, whose `text`
contains an ASCII digit `[0-9]`, or that has any `paste`, first takes a fresh capture (never the 100 ms cache) and looks at
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

Send's own typing (0.5, T54). The page marks every body of its legacy text road (`planSend`: `{ text }` or `{ paste }`; `planShell`: `{ keys: ["C-u"] }`
and `{ text: "!<command>" }`) with `"send": true`; the passthrough (arrows, Esc, typed characters, a paste into the pane, Shift+Tab) never does. With
`send: true` the route always takes a fresh capture (never the cache; its own failure is the answer) and, before any key, refuses in this order,
sending nothing:

- the bypass checks above, unchanged (409 `bypass-prompt`, 409 `screen-unclear`);
- a permission prompt, any question, plan or review dialog, the auto-mode nudge, Claude's feedback survey, or (M1) the row `(Optional) Press [1] to tell us more` it draws for a
  few seconds after a rating, on screen → `409 { "error": "prompt-open" }`: a digit or a letter typed there would answer it (a lone `1` on that row opens `/feedback`);
- an unreadable footer and no input box (the rule `submit` uses; a dialog nika does not know may be open) → `409 { "error": "screen-unclear" }`.

A `text` of more than 700 characters is typed in chunks (above); with `send: true` each chunk after the first runs the same look again, after the
300 ms pause. A refusal there stops before that chunk: no later chunk, paste or key, and the 409 body also carries `sent` (`{ "text": n, "paste": 0,
"keys": 0 }`, what was typed already, which stays in Claude's input). The page shows the fixed lines of the submit route for `prompt-open` and
`screen-unclear` and keeps the message text. Without `send` the route behaves as before.

Send of a synced message box (0.5): when Claude's input box already holds the message box's text (`draft` of the capture, spec
§9.12), the page's Send presses `Enter`; when the texts differ, the page first calls `PUT /api/app/pane/:id/draft` below and presses
`Enter` only after a 200. Since W13 that `Enter` is **not** a request to this route any more: it is `POST /api/app/pane/:id/submit`
below, which also works while Claude works and refuses a prompt or a dialog that opened after the page looked. This route keeps the
guard above for the page's passthrough (the user's own keys in the mirror), which is the only `Enter` the page still posts here. An
empty message box whose Claude input shows a suggestion (`draft.suggestion`) sends nothing at all (the page makes no request when both
boxes are empty and nothing is attached); what `Enter` submits on such a box was never verified (`claude-tui.md` §10.10), and `submit` refuses it (409
`suggestion-shown`).

### `PUT /api/app/pane/:id/draft` (body ≤ 20 KB, `CAP.keys`)
Makes Claude's input box hold the page's text, safely (draft sync, 0.5; `docs/security.md` T51). It never presses `Enter`: Send
does that through `POST /api/app/pane/:id/submit` below.
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
   command, End, another draft write or a fit step that holds the pane, `…/fit`) → 409 `busy-switching` (the page's draft sync
   pushes again about 300 ms later; a fit step takes under a second). Stop takes no lock.
3. Fresh capture (never the cache) and registry state. A capture that fails → its status and body.
4. A permission prompt on screen → 409 `not-idle` (T51: a draft write never lands in a prompt).
5. No plain box (`draft` would be `null`, which includes a cursor outside the rows of the box, a box that may be a status line):
   footer unknown → 409 `mode-unknown` (a dialog may be open); otherwise (a survey or the post-rating row included) → 409 `input-unreadable`, with no `draft` key.
6. `state` is `unreadable` → 409 `draft-unreadable` with `reason` (nika never writes over a draft it cannot read).
7. `draft.sig` differs from `base` → 409 `draft-changed` (the terminal changed since the page looked; the page pulls).
8. The trailing spaces and tabs of `text` are removed (they are invisible in the box and would make it unreadable), then the text
   must be inside the envelope for the pane's width: 1024 characters, 12 newlines, 13 estimated rows (`claude-tui.md` §10.9), no
   run of 699 or more spaces and tabs; else `400 invalid` ("text does not fit the input box"). The page runs an exact twin of this
   envelope check (browser code cannot import `src/`; `test/draft-sync.test.js` asserts the twin answers like `src/draft.js`) before it
   calls this route and never sends a text that fails it, so a text the page passes the server passes too. A text that fails it stays in the page; since
0.5.4 (LT) the page keeps it in the server's memory through `PUT /api/app/pane/:id/kept-draft` (below), never through this route.
9. The screen already reads as `text` (spaces at line ends, tabs and no-break spaces compared as `claude-tui.md` §10 says) →
   `200 { draft, typed: 0 }`, nothing sent.
10. Plan: **append** (the cursor is at the end, the new text starts with the old text, the mode (`❯` or `!`) agrees, and Claude is in
    insert mode, or in remembered plain mode with an old text that does not end in a newline: only the new part is typed), **type**
    (the box is empty), or **replace** (clear, then type). An append or a type into an empty box may run while Claude works, as
    typing in the terminal would. A replace chooses its **road** once, on this capture (0.5, W13; `claude-tui.md` §10.8 for the keys):
    - the cursor is on the box's last row (`cursor.y` = `box.bottom − 1`), in any registry state: the **C-u road** (step 11), which
      sends `End` and `C-u` only. Neither key interrupts a turn (`claude-tui.md` §10.12), so it runs while Claude works too;
    - the cursor is on an earlier row and the registry state is `idle`, read fresh (skipping its cache): the **Escape road** of W5,
      unchanged (its own fresh `idle` read before the first `Escape` and again before the second one in plain mode: a turn that
      started since → 409 `not-idle`, that `Escape` not sent);
    - the cursor is on an earlier row and the registry state, read fresh before anything is sent, is anything but `idle` (busy,
      shell, waiting, none) → **409 `cursor-not-at-end`** with `draft`, nothing sent, not even the probe `i`. `End` reaches the end of
      the text from the last row only, and `Escape` can interrupt a running turn, so there is no safe key. The page holds its text and
      asks again (3 s); once Claude is idle the Escape road works from any row.
11. Run the plan (`claude-tui.md` §10.8 for the keys and waits, §10.9 for the chunks). A fresh capture is taken before **every**
    key or chunk and must still show a plain box (so with the cursor in it), no permission prompt or dialog, and exactly the text the
    previous step left: no box (a cursor that left the box counts) or a prompt, or other text (the user typing in the terminal) → 409
    `screen-changed` (`draft: null` when there is no box), nothing more is sent; an unreadable box → 409 `draft-mismatch`; an interrupt
    (Stop's, or End's, which holds the lock first) running on the pane → 409 `not-idle` with that key not sent. A wait that runs out → 409 `draft-mismatch` (and the pane's vim/plain memory is dropped, so the next write probes), or
    409 `mode-unknown` when `-- INSERT --` never went after the first `Escape`. **The C-u road** (a replace, cursor on the last row):
    1. Edit mode `normal` or `unknown`: the probe `i` first (as in W5; safe while busy, it only turns vim normal into INSERT).
    2. `End`, once and only when the cursor is not at the end of the text, then a wait of at most 400 ms for `cursorAtEnd`.
    3. `C-u`, one key per request, at least 60 ms after the key before it (so a clear stays under the 20 requests per second per pane),
       at most `2 × inner rows + 2` presses (inner rows = the rows between the two rules, 13 at most, so at most 28). The pre-key
       capture before each `C-u` must show a plain box with the cursor in it and no prompt or dialog, and its text, whitespace
       squashed, must be the **start** of the text the last press left (a `C-u` only shortens the text; `trailing`, the break space a
       wrapped row keeps after the first press, passes on this road and nowhere else). Text that is not such a start (the user typed in
       the terminal: the terminal wins) → 409 `screen-changed` with `draft`.
    4. A press counts as taken when, within 400 ms (polled every 20 ms), the squashed text is **strictly shorter**, or it is the same
       text with the box **one row less** (the press that removes only a newline: N hard lines need 2N − 1 presses, a wrapped line one
       per visual row). A cursor move alone is no progress. No progress within 400 ms for `End` or a `C-u`, or the presses used up
       with text left → **409 `clear-stopped`** with `draft` (nika's own clear stopped half-way; the pane's vim/plain memory is dropped
       so the next try probes `i`; the page keeps its text, retries after 1 s and never adopts the partial text). The loop ends when
       the box reads `empty` (Claude's queued placeholder counts as empty).
    5. Then the `BSpace` for a `!` box and the typing go as in W5, and step 12 reads the result back.
12. Read back, up to 4 fresh captures 150 ms apart: the box is readable and reads as `text` → `200 { draft, typed }` (`typed` =
    characters typed, not counting a `!` that moved to the glyph); any difference → 409 `draft-mismatch`.

A key send that fails (for example 429, or a tmux error) stops the sequence and answers that status and body plus the `draft` of one
more fresh read (best effort). Every key counts toward the keys route's 20 requests per second per pane.

**`draft` in the answers.** It is the parse the page needs for its next `base` (an object of the capture's shape, with `edit`, or
`null`); it is the only draft-derived data the server returns, and it is the screen's, never the request's text.
- Present: the 200s, 409 `draft-unreadable` (with `reason`), `draft-changed`, `screen-changed` (`null` when the box is gone or the
  cursor left it), `draft-mismatch` (an unreadable draft included, so `draft.state` says so), `mode-unknown` after a wait that ran out,
  `cursor-not-at-end` and `clear-stopped` (step 10 and 11; for `clear-stopped` the last screen read, whose text may be a part of the
  old one), `not-idle` of a refused key while Stop or End interrupts, and a failed key send.
- Absent: 400, 404, 409 `busy-switching`, a failed capture, and `not-idle`, `mode-unknown` and `input-unreadable` of steps 4 and 5
  (nothing was read or nothing is a plain box) and `not-idle` of the registry-state check right before an `Escape`.

The page adopts the `draft` of `draft-changed`, `screen-changed` and `draft-mismatch`: the terminal wins. It does **not** adopt the
`draft` of `clear-stopped` (that text is half-cleared by nika itself): it keeps its text and tries again. For `cursor-not-at-end` it
keeps its text, shows the `Cursor` note and tries again after 3 s.

**Never sent** by this route: `Enter`, `Tab`, `C-c`, `Up`, `Down`, `DC`, `C-k`, `BTab`, a digit as a key (a draft that is one digit goes as literal
text), a second `Escape` on an empty box, any key within 40 ms of an `Escape` (its own, or the `Escape` of a Stop or End: a key right behind an `Escape` would be read as
Meta plus that key), any key while Stop or End interrupts the pane, and an `Escape` while the registry state is not `idle`: the C-u road
sends none at all (a test fails on any `Escape` sent while the registry is not idle). The keys it does send: literal text and bracketed pastes (`send-keys -l --`, at most
700 characters per call, at most 2 newlines per paste, never ending in a space or tab), `End` and `C-u` (the C-u road: `End` once, `C-u` at
least 60 ms apart), `Escape` (only the Escape road, at idle; vim: once, then the text `ggdG` and
`i`; plain: once, and a second one at least 60 ms later only while text still shows), a probe `i`, one `C-u` to remove that probe's
own `i` from an empty box, and one `BSpace` to leave `!` mode (`claude-tui.md` §10.8).

Logging: nothing of the body or of a draft (no text, no `sig`, no `base`) goes to a log or the console; errors carry the pane id and
the code only. The route exists on the app tier only.

### `PUT` and `GET /api/app/pane/:id/kept-draft` (0.5.4, LT; PUT body ≤ 34 KB, `KEPT_CAP`)
The message box's unsent text that the draft sync did not copy into Claude's input, kept for the session window so that it is back when the window opens
again (ADR 0016, amendment 2026-11-20; `docs/security.md`, the LT rows). It is the text outside the sync's envelope (step 8 above: over 1024 characters,
over 12 newlines or 13 rows, a long run of spaces), text the draft route refused with `400`, text that waits (no readable box, a paused sync, a held or
failing write) and text the page itself put back. The text sits in the pane's tray in memory (the attachment store, AT above): **one text and its Shell
flag per pane**, bound to the pane's project key and to the Claude in the pane like the tray's files (pid or session, so `/clear` and `/compact` keep it),
and it goes when the tray goes (the session ends, another Claude or project claims the pane, an app restart, or the 65th tray forgets the oldest). App tier
only (the browser tier answers `404`). **Memory only:** nothing of the text is written to disk, put in argv or env, served on :3335 or logged (a store
error is logged as `nika: attachments: <code>` only, the `400` messages are fixed words that never echo the text), and **the server never types it**:
neither route sends a key, and the text reaches Claude only when the user presses Send, through the draft, keys and submit routes and their limits.
```json
{ "text": "<at most 16 KB of UTF-8; \n and \t allowed, no other control character, well-formed; \"\" clears>", "shell": true }
```
`PUT` body: exactly the keys `text` and `shell` (a boolean: the box was in Shell mode). A non-empty `text` must be well-formed (no lone surrogate), at most
16 KB of UTF-8 (`MAX_PASTE`, Send's paste limit) and hold no C0 control other than `\n` and `\t` (`\r` included), no DEL and no C1 control; the page
removes `\r` and those controls first, as Send's paste would. Order:
1. Body → `400 invalid`, before the pane check, with one of three fixed messages: `body must be { text, shell }`, `shell must be true or false`,
   `text must be at most 16 KB without control characters other than newline and tab`. A body over 34 KB (16 KB of `"` or `\` doubles in JSON) is `413 too_large` and
   another content type `415 unsupported_media`, both from the dispatcher.
2. Ineligible pane (same rule as capture) → `404 not_found`.
3. Rate: more than 8 saves a second on one pane (`KEPT_RATE`, its own bucket; the page saves 500 ms after the last change, one request at a time) → `429 busy`.
4. The pane's repository key and Claude, from nika's own snapshot (never from the request). None, or two claims: a clear (`""`) of a pane that holds no text →
   `200 { "kept": false }`, and anything else → `409 no-project` (`nika can't tell this session's project`), changing nothing.
5. The store: a keep binds the tray first, as the upload does (a tray of another project or Claude is dropped, its unsent files deleted), then stores the text; a clear
   removes it, and drops a tray of another project or Claude; a tray left with neither files nor text is deleted. A store error is logged as its code only and
   answers `500 internal`.

Success `200 { "kept": true }` when the text was stored, `200 { "kept": false }` for a clear (also of a pane with no tray) and when the store kept nothing. It is **not** a
user's action: no typing stamp (it is not a keystroke to Claude; `GET …/capture`, "Typing stamp"), and it never touches Claude's pane.

`GET` has no body and no rate limit (the page asks once per open, and again on a return from the back/forward cache). Order: pane `404`, then the claim as above.
With no claim or two, a pane that holds no text answers `200 { "kept": null }` and one that holds text `409 no-project`, deleting nothing. Otherwise a tray of another
project or Claude is dropped (files and text) and the answer is `{ "kept": null }`. The answer is rebuilt as exactly this shape, never passed through, and
**returned unchanged** (no `clean()`: it would turn a zero-width joiner of an emoji sequence into a space):
```json
{ "kept": null }
{ "kept": { "text": "…", "shell": false } }
```
A text that is not keepable, or a `shell` that is not a boolean, answers `{ "kept": null }`. A store error answers `500 internal`.

**What the page does** (`public/draft-sync.js`, `public/session.js`): it writes the text one request at a time (`keepalive`), 500 ms after the last change and once
more on `pagehide`; it clears the copy at once when its Send succeeds, when the sync shows the text in Claude's input, when the terminal's text is pulled or
adopted, and when the box is emptied. A text over 16 KB is not kept: the page says so with its own line (`Not kept:`, the warning icon, `--danger` colours). When
the window opens it asks `GET`, puts the text back only into an **empty box the user has not typed in** and never clears its box on an empty answer; a page back
from the back/forward cache takes the server's copy when it differs, or keeps a box that still holds the copy this page saved. A put-back text is never copied into
Claude's input by itself while Claude's input holds other text (nika never clears Claude's input to make room, owner decision 2026-11-14): only the user's next
edit or Send does. A restore that ends on a `404` or an error does not clear the server's copy.

**Known limits.**
- A clear that never arrives (the page dies right after Send) brings the sent text back into the box once; two writes reordered at a leave can leave the older text;
  a tray forgotten at the 64-tray cap or an app restart answers empty.
- With two pages of the same pane, a returning page whose box holds text it never saved keeps its box, and its save replaces the other page's copy; nothing tells
  the user.
- While a capture re-try is pending (at most 3 per restore chain, about 2 s apart, then a fixed failure line; up to about 6 s in all), edits are held and a leave keeps
  nothing; text typed in that window is kept only after one more edit, and typing in it can replace Claude's input text that the box does not show (a later release
  may hold the push until the chain ends); a `GET` that hangs holds Send and Tab for up to 3 s per re-try, and Tab on a suggestion is refused with "nika is bringing back
  the text you had not sent. Try again in a moment." for those seconds.
- A save in flight across a Send whose clear fails can delete another page's copy with no line (nothing that was sent comes back).
- Residual of the binding as for the attachments: a reused pane id with no tmux listing in between and no claim on one side can put old text into a new session's box;
  the user sees it and must press Send.

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
3. One fresh capture (never the cache): the only capture before the key. The registry state is **not** read (0.5.1, item K; see "Why the
   screen decides" below). A capture that fails → its status and body. A permission prompt or a dialog on screen → 409 `not-idle`. No
   plain box (`draft` would be `null`: footer unknown → 409 `mode-unknown`; otherwise, a cursor outside the box included, 409
   `input-unreadable`), both without a `draft` key (a second cursor check behind the parser, never reached while the parser holds, would
   answer `draft: null`). `state` is `unreadable` → 409 `draft-unreadable` with `reason` and `draft`.
4. The box must be `empty`, in `prompt` mode, with `draft.suggestion` equal to `text`; anything else (text typed, the suggestion
   changed or gone, a `!` box) → 409 `draft-changed` with `draft` (the page adopts it). Nothing is sent.
5. **No turn may run in main (0.5.1, K and K-vim)** → else 409 `busy` with `draft` (the page adopts it), `Tab` not sent. A turn runs when
   the same capture shows either marker (`src/turn.js`, `claude-tui.md` §8):
   - the mode line (the last non-blank row) has a segment that is exactly `esc to interrupt`, between middle dots; or
   - a spinner row sits in the 12 non-blank rows right above the box's top rule: one symbol, a verb that ends in an ellipsis and one
     parenthesis to the end of the row. It counts when the parenthesis holds the segment `esc to interrupt`, or, because Claude draws no hint in
     vim INSERT (K-vim, Claude 2.1.326), when the symbol is one of Claude's own spinner glyphs (middle dot, `*`, `✢`, `✳`, `✶`, `✻`, `✽`) and
     the verb starts with a capital letter.

   None of these is a running turn, so the `Tab` goes: the finished line (`<symbol> Worked for 8m 9s · done 4:21 PM`, with or without
   `· 1 shell still running`), `Waiting for 1 background agent to finish`, the footer pills (`1 shell`, `↓ to manage`) and the agent list
   under the footer. A bullet of the assistant's text or an agent row never matches the spinner shape. A pane so narrow that the spinner
   row wraps loses the spinner marker (the footer's hint is still read).
6. Exactly one key, `Tab`, through the keys path (it counts toward the 20 requests per second per pane; a 429 or a tmux error stops
   here and answers that status and body plus the `draft` of one more fresh read, best effort). A Stop or End interrupt that is running
   on the pane, or whose `Escape` went out less than 40 ms ago → 409 `not-idle` with `draft`, `Tab` not sent. This is the only
   interrupt check: it is made at the key, not before the capture.
7. Read back, up to 4 fresh captures 150 ms apart: the box is readable, `state` `text`, `prompt` mode, and its text equals `text`
   (compared as the draft write compares, `claude-tui.md` §10) → `200 { draft }`. Else → 409 `draft-mismatch` with the `draft` last
   read (`null` when the box is gone). The `Tab` is never repeated.

**Why the screen decides (0.5.1, K).** Before 0.5.1 step 3 asked the registry for `idle`. Claude's registry reads `busy` while background
agents run and `shell` while a background shell runs, also after the turn that started them has ended, and Claude still shows its
suggestion and takes `Tab` and `→` then. So "the registry is not idle" said nothing about whether a `Tab` is safe, and the route refused
a suggestion Claude would have taken. What a `Tab` must avoid is Claude answering in main, and that is on the screen (step 5). The
failure is closed in one direction only: a wrong "running" refuses a `Tab` (409 `busy`, nothing sent); a wrong "not running" is still
held by the checks of steps 3 and 4 (an empty box, the exact suggestion, the cursor in the box, no prompt or dialog) and by the
read-back of step 7. `not-idle` from this route now means a prompt or dialog is open, or a Stop or End interrupt runs; a server older
than 0.5.1 also answered `not-idle` whenever the registry was not `idle`.

Never sent by this route: anything but that one `Tab`. No `Enter` (the page's Send does that, through `POST …/submit` below), no
`Escape`, no text. Nothing of the body or of a draft is logged (errors carry the pane id and the code only). The route exists on the
app tier only; the browser tier has no draft and no suggestion (T51).

Known limit: a suggestion of exactly 200 characters may be cut by `clean()` in the parse; the page then holds the cut text, Claude
takes the whole suggestion, and the read-back differs, so the answer is 409 `draft-mismatch` although the `Tab` worked. The page
adopts the screen's `draft` and shows what Claude holds.

### `POST /api/app/pane/:id/submit` (body ≤ 1 KB, `CAP.submit`)
Presses the `Enter` of the page's Send (0.5, W13; ADR 0019, `docs/security.md` T54). It is the one `Enter` of Send in every registry
state, so a message sent while Claude works is queued by Claude (`claude-tui.md` §10.12). It is not the plain keys route: while a turn
runs, a permission prompt or a dialog can open at any moment, and an `Enter` that lands in it confirms its highlighted option. nika
presses it only on a fresh screen that shows neither. The page's passthrough (the user's own keys in the mirror) keeps the keys route
and its bypass guard; Send never posts `Enter` there. App tier only: the browser tier has no such route (404).
```json
{ "base": "<16 hex, or \"\">" }
```
`base` is optional: the `sig` of the `draft` the page has just put into Claude's input (the answer of a draft write) or last saw (the
capture). The body is `{}` or `{ "base": … }`; any other key, `base: null` and any other non-string are `400 invalid`. `base: ""` passes
the shape check, matches no screen and so answers 409 `draft-changed` (the page sends `{}` for "no base", the legacy paths below).
Success: `200 { "taken": true | false | null, "draft": { … } | null }`. Same pane rule as capture. Checks and steps, in this order (every
step fails closed: nothing is sent after a refusal; no step reads the registry state):

1. Body invalid → `400 invalid` (over 1 KB → `413 too_large`). This check runs before the pane check.
2. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane (mode switch, answer,
   command, End, a draft write or a fit step that holds the pane) → 409 `busy-switching`. Stop takes no lock.
3. A Stop or End interrupt is running on the pane, or sent its `Escape` less than 40 ms ago → 409 `not-idle`, before any capture. A key
   right behind an `Escape` would be read as Meta plus that key.
4. One fresh capture (never the cache): the only capture before the key. A capture that fails → its status and body.
5. The prompt window (`bypassWindow`, the keys route's test) mentions bypass **and** a permission prompt is on screen or the footer is
   unreadable → 409 `bypass-prompt` (the keys route answers `screen-unclear` for the unreadable-footer case; here both are
   `bypass-prompt`).
6. A permission prompt or a dialog is on screen (a question or plan dialog, the review step, the auto-mode nudge) → 409 `prompt-open`.
   Claude's `Enter` would confirm the highlighted option.
7. The footer is unreadable (mode `unknown`) and there is no recognised box → 409 `screen-unclear`, no `draft` key.
8. With `base`: no recognised box, or the cursor is not in it → 409 `input-unreadable`, no `draft` key (that box may be a status line);
   the box's `sig` differs from `base` (an unreadable box has no `sig`) → 409 `draft-changed` with `draft` (the terminal changed since
   the page looked; the page adopts it and nothing was sent). Without `base` a box nika cannot read does not stop the `Enter`: the
   legacy paths (a screen nika cannot parse, Shell) rely on it, and steps 5 to 7 still refuse every known prompt and an unclear screen.
   One exception: when the screen shows the input box's two rule rows but no readable box (`draft` would be `null`) and the capture's
   cursor (an integer x and y) lies **below the bottom rule**, Claude's focus is on the `<n> shells` pill or in the agent list, where an
   `Enter` opens the Background dialog or an agent view (`claude-tui.md` §1) → 409 `input-unreadable`, no `draft` key, nothing sent. A
   cursor above the top rule (a status line drawn under the real box, `claude-tui.md` §10.5) keeps today's behaviour.
9. The box is `empty` and shows a prompt suggestion (`draft.suggestion` not null), with or without `base` → 409 `suggestion-shown` with
   `draft`: what `Enter` submits then was never verified (`claude-tui.md` §10.10). Claude's queued placeholder is no suggestion
   (`queued: true`, `suggestion: null`) and passes.
10. Exactly one key, `Enter`, through the keys path: it counts toward the 20 requests per second per pane (no other rate limit); a 429
    or a tmux error stops here and answers that status and body plus the `draft` of one more fresh read (best effort). An interrupt that
    started meanwhile → 409 `not-idle` with `draft`, `Enter` not sent. It is never repeated.
11. Read back: a fresh capture every 50 ms, for 1000 ms at most, under the same lock.

`draft` in the answer is the parse of the last screen read after the `Enter` (with `edit`), `null` when the box is gone (a prompt opened
right after, or no capture worked). `taken` says what the read-back saw:
- `true` as soon as one poll shows a recognised box in state `empty`, with or without `queued: true` (Claude took the message, or
  queued it): with or without `base`.
- `false` only when `base` was given and every poll for the whole second was readable and still showed `sig === base`: the `Enter` did
  not take (a menu may have eaten it). The page keeps the text and says so. A read-back capture that fails never counts towards `false`.
- `null` in every other case: no `base` and the box did not empty, a different text, the box vanished, an unreadable poll, or a failed
  read-back capture. The page treats `null` like `true` (it clears its box and lets the next capture win, so a text that is still in
  Claude's input is pulled back, nothing is lost).

The page's Send paths (`public/session.js`): the synced box → `{ base }` of the capture; a push (a draft write that ended in 200) →
`{ base }` of that write's `draft.sig`; a text nika cannot mirror (keys `{ text }` or `{ paste }`, no `Enter`) and Shell (keys `C-u`, then
the `!` text) → `{}`. The page makes no request at all when both boxes are empty and nothing is attached.

Those legacy paths type text through the keys route **before** this route's checks run. Their bodies carry `send: true`, so the keys route
takes a fresh capture and refuses a prompt, a dialog, the survey and an unclear screen itself (above); the page also runs them only while the last
capture's footer reads (a known mode line, `modeConfirmed`). With no readable box **and** an unknown footer (the agent list has the
keyboard focus, a menu is open) the page refuses before any request, for text, Shell text and the Enter of an empty box alike: "nika can't
read Claude's input box right now (a menu may be open). Nothing was sent.", and the text stays in the message box. Attachments already
refuse such a screen (`attach-send`, 409 `mode-unknown` / `input-unreadable`).

**Never sent** by this route: anything but that one `Enter`. Nothing of the body or of a draft (no `base`, no `sig`, no text) is logged;
errors carry the pane id and the code only.

Known limit: the few milliseconds between the capture of step 4 and tmux delivering the `Enter` (the same window as T26 and T51): a
prompt drawn inside it takes the `Enter`.

**Attachments** do not use this route: `POST /api/app/pane/:id/attach-send` (below) pastes the stored files and presses its own single
`Enter`, under the same W13 rule (no step reads the registry state, so it works while Claude works and the message is queued with its
files).

### `PUT /api/app/pane/:id/fit` (body ≤ 4 KB, `CAP.small`)
The session window asks for its terminal panel's size in cells (0.5, W7; ADR 0017, `docs/security.md` T52, the page: spec §9.13; since F10 the page may
instead ask once for 33 rows with the columns in the panel's proportion when Claude's input box and footer do not fit the panel, in the same body and ranges, and since F11 it asks for
the rows its mirror hides under the input-box strip as well, again in the same body and ranges, and since F16 it asks for up to 120 rows while a question dialog is cut off at its top, again in the same body and ranges,
see "The page's size, room for Claude's footer and the redraw hold" below).
The server zooms the mirrored pane and sizes its tmux window to the panel **when that cannot squeeze another pane, or, while the session window has focus,
even when it does** (0.5, F15), and either no terminal shows the window or the session window has focus (0.5, F4 and F9, the focused one wins: while a terminal
shows the window, nika resizes it only for a session window that has focus, and the terminal then shows dots around it; without focus nika never resizes it, and
never squeezes another pane), keeps a lease on that
window, and gives everything back by itself when the page goes quiet or the user changes the window. App tier only.
```json
{ "cols": 120, "rows": 39, "open": false, "focus": true }
```
The body is exactly `cols`, `rows` and `open`, or those three and `focus`: `cols` an integer 40–400, `rows` an integer 10–200, `open` a boolean (`true` on the first
requests of a page load, until one is answered 200, and (0.5, F1) on the one request the user asks for with Fit again or Fit here in the
chip's panel; it is the one thing that clears an "off until the window is opened again" mark, see `user-change` below), and (0.5, F9)
`focus` a boolean, the second value of the request that decides a resize: whether the session window has focus. A body without `focus` reads as
`focus: false` (the safe side: an unfocused page yields to a terminal as in F4, and a page loaded before an update still works); a `focus` that is
not a boolean, or a fourth key that is not `focus`, is `400`. The page always sends it, read fresh as `document.visibilityState === 'visible' &&
document.hasFocus() === true`; anything unreadable is `false`. Everything else (the tmux window, its size, its layout, its zoom) comes from tmux's own listing, never from the request.
Order of checks: body → `400 invalid` (message `cols must be an integer 40–400, rows 10–200, open a boolean, focus a boolean when present`), before the pane
check; ineligible pane (same rule as capture: in the listing, running claude, not dead, live or started by nika) → `404 not_found`; the rate
limit → `429 busy` (`at most 4 fit requests per second per pane`: a sliding second, PUT and DELETE each have their own bucket per
pane, nothing is executed on a refusal); then the controller (`src/fit.js`).

**200 body**
```json
{ "fit": { "state": "fitted", "reason": null, "pane": { "cols": 120, "rows": 39 }, "panes": 3, "userZoom": false, "mode": "auto" } }
```
Since 0.5.4 (P2) every answer carries `mode`, the Fit mode in force (`auto` | `fill` | `terminal` | `off`, "Fit mode" below), and the mode `off` has one more answer, `{ "fit": { "state": "off", "reason": null, "mode": "off" } }`
(no `pane`, `panes` or `userZoom`). `pane` is the mirrored pane's size as tmux reports it (for `fitted` and `zoomed` the read-back after nika's change; for `terminal` the size in
the last listing of that request, the read-back after an acquire or the request's own listing at a beat: the terminal sizes the window, so it
can change between requests, and the capture carries the live size; since F10 the page also reads it as the size nika's own resize is under way to, which starts its redraw hold), `panes` the number of panes in its tmux window, `userZoom` whether the
user had the mirrored pane zoomed. `state` and `reason`:

| `state` | `reason` | Meaning | What nika changed |
|---|---|---|---|
| `fitted` | `null` | the pane is exactly the panel's size | window resized to the panel when it differs (a window with several panes is also zoomed on this pane, unless the user already had it zoomed). **0.5, F15:** with `focus: true` this includes a window with several panes and a panel smaller than the window, whatever the other panes run: the zoom hides them and tmux shrinks them with the window; the window's layout is read right before the resize and kept in server memory for the way back |
| `fitted` | `terminal` | (0.5, F9; owner decision 2026-11-16, Q1: no new state or colour) the same, and a terminal shows the tmux window too (`#{window_active_clients}` above 0): nika sized the window to the panel because the page has focus, and the terminal shows dots around it | the same as `fitted` / `null`; the terminal gets its size back within about a second of the page losing focus (a give, below) |
| `zoomed` | `panel-smaller` | the panel is smaller than a window with several panes and the page has **no focus** (F15: with focus such a window is `fitted`); also the state after the give of a squeezed window when no terminal shows it, and a window whose layout nika could not read at a take | zoom only, window at its own size; the page scales its text |
| `terminal` | `null` | (0.5, F4, F9) a terminal shows the tmux window (`#{window_active_clients}` above 0) and the page has no focus, or the request is a refit inside the 30 s grace of a `terminal` lease that has no focus | the tag, and a zoom on this pane when the window has several panes that nobody zoomed; **no resize**: the terminal sizes the window and the page scales its text |
| `terminal` | `switching` | (0.5, F9) the page has focus, but nika has already taken the size back 12 times in the last 60 s on this window (the cap, "When the server gives the window back by itself" below); the answer to a page without focus never carries it | as `terminal` / `null`; the watch takes the size when the minute frees up |
| `blocked` | `user-zoom` | the user zoomed another pane of this window | nothing |
| `blocked` | `size-option` | the window has a window-level `window-size` that is not unset or one of `latest largest smallest manual` (nika could not put it back exactly) | nothing |
| `blocked` | `foreign-tag` | `@nika-fit` on the window holds a value nika has no lease for (another program, a stale tag with no usable lease file, or a value that is not 16 lowercase hex characters: the listing reads it as foreign, never as an unreadable row that is dropped) | nothing |
| `blocked` | `changed` | something nika read did not hold (a layout nika may not keep, a lease file over 16 KB, no active pane), or the read-back after its own change differed (a tmux hook fought back) | nothing, or everything put back |
| `blocked` | `user-change` | the user changed the window (unzoomed, navigated, split, killed a pane, resized) after nika fitted it. A split or an exit of nika's own agent pane is not one (0.5, F2): it is a refit, see "When the server gives the window back by itself" | everything put back |
| `other` | `null` | another session window of nika holds this tmux window and this request has `open: false` (with `open: true`, the page's Fit here, this window takes it over: row 6) | nothing |
| `off` | `null` | (0.5.4, P2) the Fit mode is `off`: nothing is held in this mode, so nothing is asked of tmux | nothing; a lease this pane still holds (a request that was already running when the mode switched) is given back, with no note |

`user-change` and `changed` (after a read-back mismatch) keep the window **off**: the answer to every later request with
`open: false` is `blocked` with that reason and nothing is changed, until a request with `open: true` arrives (the session window
opened again, or, 0.5 F1, the user pressed Fit again in the chip's panel: the same request). nika never fits a window again behind the
user's back (owner decision 2026-11-14, Q6): only the user's own ask sends `open: true` after the first requests of a page load. The one thing nika
fits again by itself is a window whose own agent pane was split into it or left it (0.5, F2: a refit, which is not a user change and sets no mark). The mark is in memory, for
at most 64 windows. It is set only after the restore found its own tag on the window, inside the pane lock: a lease dropped because
its tag or window was gone sets none (M4), and neither does a refusal of an acquire (see "Reads inside the lock"). `none` is not a state of this route (the page shows no chip before its first answer and after a `DELETE`).

**`terminal` (0.5, F4; owner ruling 2026-11-16) and the focus (0.5, F9; owner ruling 2026-11-16, "the focused one wins").** A terminal client shows
the tmux window when the 13th field of the fit's listing, `#{window_active_clients}` (§8), read as digits 0–9999, is above 0. Every kind of client
counts (a plain terminal, control mode, `ignore-size`, read-only, a linked session's client on this window); a client on another window of the same
session does not; nika itself is never a client. What nika does with it depends on the request's `focus`:

| Page | A terminal shows the window | Lease | tmux |
|---|---|---|---|
| has focus | yes | `fitted` / `terminal` (F15: also for a window with several panes and a smaller panel) | resized to the panel (`window-size` becomes `manual`; the terminal shows dots) |
| has focus | no | `fitted` | resized to the panel, also a smaller one for a window with several panes (F15); zoom only if the window's layout could not be read |
| no focus | yes | `terminal` | never resized; zoom only (several panes) |
| no focus | no, a `terminal` lease within `GROW_MS` | `terminal` (the grace) | as it is |
| no focus | no, otherwise | `fitted` or `zoomed` | as in W7: resized to the panel when that squeezes no pane (a panel at least as wide and as tall as the window), else zoom only (`zoomed / panel-smaller`) |

A page with focus, a terminal and a smaller panel over a window with several panes lands on `fitted / terminal` since F15 (before it, `zoomed /
panel-smaller`): the window is squeezed and the terminal shows dots. For a page without focus `terminal` still wins over
`zoomed / panel-smaller` (both are zoom only; `terminal` names the lasting reason, and its take decides `fitted` or `zoomed` later). The answer to
`terminal` carries `reason: null` (`switching` only to a page with focus); `panes` and `userZoom` tell the page whether nika zoomed the pane (several
panes, not the user's own zoom). The lease is the usual one (memory, file, tag); `focus`, `viewed`, `sized`, `awayAt` and the `terminal` state are
memory only and never in the file (`FILE_KEYS` is unchanged). `focus` is recorded from every request of the pane that holds the lease **before** any
check can refuse the request, so the watch acts on a change of it within a second even if the request is answered `409`; a page that gets `other` changes
nothing. While a lease is `terminal`, a terminal resize is not a user change (the window follows its terminal and its size is not judged), a beat at the
same size and focus takes no lock and makes no tmux call (it keeps the panel's `cols` and `rows`), and the lease turns back into `fitted` or `zoomed` after no
terminal has shown the window for `GROW_MS` = 30 s, or at once when the page gets focus (the watch and the request, below). An unzoom, a focus change in
tmux and a user's split or kill are still user changes; a change of the **session window's** focus is not.

**Fit mode (0.5.4, P2; `docs/security.md`, the P2 rows; ADR 0017).** A global setting (`fit.mode`, §3 Settings) that the controller enforces. It never comes from the request (the body has no `mode`
key, and a fourth key is still `400`): the app passes it at start (before `recover()`, which runs in every mode: it only gives back what an earlier run left), after a Settings save (`PUT /api/app/settings`,
once the save succeeded) and on a fit `PUT` with `open: true` (a page load, or Fit again), which re-reads `config.json` first, after the `400`, `404` and `429` checks, so a hand-edited file is picked up; a hand
edit with no save and no open window waits for the next app start. The page sends the same body at the same times in every mode.

| | `auto` (default) | `fill` (Always fill the panel) | `terminal` (Your terminal's size) | `off` |
|---|---|---|---|---|
| Effective `focus` (what the rows below read) | the page's own | always `true` | always `false` | not read |
| Counts as "a terminal shows the window" | `#{window_active_clients}` above 0 | as `auto` | always | not read |
| Lease (memory, 0600 file, `@nika-fit` tag) | yes | yes | yes (tag; zoom only) | none |
| `resize-window` | as before (F4, F9, F15) | to the panel whenever the window is held: a terminal's presence, a blur and F15's squeeze no longer stop it | **never**; a size nika set before the switch is given back within about 1 s | never |
| Zoom (several panes, nobody zoomed) | yes | yes | yes | never |
| Answers | the states above, `mode: "auto"` | `fitted`, `zoomed`, `blocked`, `other`, `mode: "fill"` | `terminal`, `blocked`, `other`, `mode: "terminal"` | `off`, `mode: "off"` |

The decision table below is the `auto` one; in `fill` and `terminal` its rows read the effective `focus` and the "terminal shows" test of the column, and a lease keeps the page's own `focus` (leaving `fill` or `terminal`
hands the decision back to the page at once). `blocked` and `other` are as in `auto`. In `off` the controller answers before the first row. The page's text scale (at most 1×, at least 0.4×) is the same in every mode, and the page's
room (F10), hidden-rows (F11) and grow (F16) asks run only in `auto` and `fill`. **Changing the mode while leases are held:** to `off`: every lease is given back at once (queued like a release, with no mark and no note, so leaving
`off` never leaves a window blocked), and each page gets `off` on its next request; `auto` or `fill` to `terminal`: memory only, the 1 s watch gives a resized lease back (or views an unresized one in the terminal form);
to `fill`: the watch takes the size (counts toward the 12 per minute cap, "When the server gives the window back by itself"); to `auto`: the page's own focus decides again; from `off`: nothing is held, and the next request
(5 s at most, `open: false`) acquires. A request that was already running when the mode switched resizes nothing in `off`, and a plan made under another mode is stale (nothing is resized; the lease goes on, and the watch or
the next request decides again). `fit.mode` adds no tmux argv: the mode only picks among the moves above.

**What the server decides**, in this order (the first row that matches ends the request):

| # | Condition | Decision |
|---|---|---|
| 1 | this pane already holds the lease for its window with the same `cols`, `rows` and (0.5, F9) `focus` | the lease is renewed (the beat), no tmux call, the held answer. A request with another `focus` is never this row: it is recorded in the lease first, then goes on to row 7 |
| 2 | the pane is not in tmux's listing, or its command is not claude | `404 not_found` |
| 3 | a request for **another pane** of the same tmux window is running | `409 busy` (`another fit request for this tmux window is running`) |
| 4 | the window holds a lease whose tag is gone or differs | the lease is dropped, no tmux call (a restarted tmux server reuses window ids) |
| 5 | `@nika-fit` holds a nonce nika has no lease for | a lease file of that nonce for this window is used to put the window back (a crash), then on; no usable file, or the tag still there: `blocked / foreign-tag` |
| 6 | another pane holds the window | `open: false`: `other`; `open: true`: that lease is released (the last opened window wins) and the request goes on |
| 7 | this pane holds the window with another size or (0.5, F9) another `focus` | renew: the user changed the window since the last look → released, `blocked / user-change`; nika's own agent pane came or went since the last look (0.5, F2) → released without a mark and fitted again in this same request (the watch's `refit`, below); a new pane with no role yet → answered from the lease, nothing resized (`wait`, below); a terminal came to a window nika did not resize and the request has no focus → the lease becomes `terminal` and the request goes on (F4); a terminal shows a window nika resized and the request has no focus → **give**, in this request (F9, below); the request has focus and the lease is `terminal` (or the window followed its terminal to another size), or the 30 s without a terminal of a `terminal` lease are over → **take**, in this request (F9, below); otherwise a `terminal` lease keeps the new `cols` and `rows` with no lock and no tmux call (F4), and any other lease is resized as in rows 13–14 and read back. A renew that has to resize looks again inside the pane lock, before `resize-window` (see "Reads inside the lock") |
| 8 | `open` is `false` and the window is marked off, or this page's own `DELETE` gave the window back 2000 ms ago or less (its last heartbeat in flight) | `blocked` with the mark (`user-change` or `changed`); for the late heartbeat `blocked / user-change`, no tmux call and no mark |
| 9 | the window-level `window-size` is unknown | `blocked / size-option` |
| 10 | the window is zoomed on a pane other than this one | `blocked / user-zoom` |
| 11 | no active pane, or `#{window_layout}` is not printable ASCII of 1–8192 characters without `#`, or the lease file would pass 16 KB | `blocked / changed` |
| 12 | (0.5, F4, F9) a terminal shows the window (`#{window_active_clients}` above 0) **and the request's `focus` is false**, or the request is a refit that keeps the terminal form (a `terminal` lease inside its 30 s grace whose last `focus` is false, see "Refit") | lease (tag); a window with several panes that nobody zoomed is zoomed on this pane; **not resized** → `terminal`. With `focus: true` a terminal does not stop the resize: the request goes on to rows 13–14 |
| 13 | one pane, or the panel is at least as wide **and** as tall as the window, or (0.5, F15) the request has `focus: true` | lease; a window with several panes and no zoom is zoomed on this pane; resized to the panel unless it already is → `fitted` (reason `terminal` when a terminal shows the window too, F9) |
| 14 | several panes, the panel is smaller in either dimension and the request has no focus | lease; zoom only → `zoomed / panel-smaller`. A renew that finds a smaller panel without focus resizes the window back to its original size, never below it |
| 15 | the read-back after rows 13–14 differs from what nika set (a `terminal` lease's read-back checks no size) | released at once → `blocked / changed`, never retried. A read-back that finds a terminal on a window nika just resized, for a request without focus, is not a difference: it is a give (F9, below) |

Rows 1–11 win over row 12 (nothing is changed there), and for a request without focus `terminal` wins over `zoomed / panel-smaller`: both are zoom only,
`terminal` names the lasting reason, and its take decides `fitted` or `zoomed` later. For a request with focus a window with several panes and a smaller
panel is `fitted` (row 13, F15), also when a terminal shows it (`fitted / terminal`). Without focus a window with several panes is never made smaller than it
was: another pane would be squeezed (spike S10); with focus it is, and the way back puts its layout back (F15, below). The lease lives in
three places: server memory, a 0600 file `<state>/fit/fit-<nonce>.json` and the window option `@nika-fit <nonce>` (§8).

**Reads inside the lock (review I1).** Rows 9–11 and 12–14 are decided from reads taken before the lock wait (a listing, the
`window-size` option, `#{window_layout}`), and the wait can be long (a draft write holds the lock). So a fit **reads again with the
lock held, before its first change**: the listing (the pane still in the same window, with the same pane count, zoom flag, active
pane, window size and pane size, and no tag on the window), the layout (compared with tmux 3.8's focus markers stripped) and the
`window-size` option. Any difference → `blocked / changed`; nothing is changed: no tag, zoom or resize, no lease kept, no lease file,
no mark (the next beat looks at the window as it is then). The pane gone, or in another window → `404`. An acquire's calls are
therefore: listing, option, layout, then inside the lock listing, layout, option, tag, zoom (a window nobody zoomed), resize (F4, F9: not while a terminal shows the window and the page has no focus), and
after the lock the read-back (listing, layout; row 15). A pane control lock that stays taken for the whole wait (`409 busy`) before
the step ran drops the lease directly: nothing had been changed, so nothing is given back.

**A terminal in the lock wait, and a terminal after the resize (0.5, F4, F9).** The viewer count is read again inside the lock with the rest. For a
request without focus, a terminal that arrived during the wait while the window kept the size nika planned on is not a difference: the acquire goes
on without the resize and the lease is `terminal`; for a request with focus it goes on and resizes (`fitted` / `terminal`). A terminal that arrived
and also changed the window's size is a difference (`blocked / changed`, no mark; the next beat lands on the answer for the then state). The
read-back of a `terminal` lease checks no size, only the tag, the pane count and, for several panes, the zoom and the active pane. When the
read-back of a lease nika resized finds a viewer (a terminal came between the resize and the read-back) and the request has no focus, nika **gives**
the size back in place, in the same request (below): no release, no second acquire, and the answer is `terminal`. With focus the read-back keeps
the resize (`fitted` / `terminal`). A give ends in the same read-back with nothing resized, so it never gives twice.

A **renew that resizes** (row 7, a panel of another size) does the same before its one `resize-window` (N1): inside the lock it
lists the window again and judges it with the lease as nika holds it (the size and zoom it set before, not the ones it is about to
set). Any difference the watch's rules would act on (the user resized, unzoomed, moved the focus, split or killed a pane, the pane
left the window or stopped being claude, or the tag or window is gone) → no `resize-window`; (0.5, F2) a split or an exit of nika's own agent
pane is not a user change: nothing is resized over it, the lease is released without a mark and this request fits the window again, and a new
pane with no role yet leaves the lease as it was and answers from it. For a user change: the lease is released as a user change
(a separate turn of the lock), the answer is `blocked / user-change` as in "A request that ends in a release" below, and the window
stays off until `open: true`: nika never resizes over a user's resize and never tries again. A tag or window that is gone is dropped
instead (nothing touched, no mark). If that release finds the pane busy, the answer is `409 busy` and the lease stays as it was; the
next beat or the watch tick releases it. A heartbeat at the size and focus nika holds makes no tmux call and takes no lock. (F4, F9) A renew that finds a terminal came during the lock wait resizes
nothing: a window nika did not resize becomes `terminal`, and for a page without focus a window nika resized is given back in place in this request (a give); for a page with focus, a lease in the
terminal form or a window that followed its terminal to another size is planned again at the new panel size in this request (a take). A give and a take adopt the request's `cols` and `rows` only after their own look inside the lock, so a lease is never judged against a size it did not set yet.

A request that ends in a release (`blocked / user-change`, or `blocked / changed` after a read-back mismatch) answers with the
window **as it is after the restore** (T5-F2): `pane` and `panes` come from a listing taken after the release, and `userZoom` is
`true` only when the user had the pane zoomed before the fit and that zoom still holds (the pane is zoomed and active). If that
listing fails, the answer carries the pane size nika read before its change, the lease's pane count and the lease's `userZoom`.

**Errors**
| Status | Code | When |
|---|---|---|
| 400 | `invalid` | the body (above); `invalid pane id` from the controller |
| 403 / 413 / 415 | | the guards of §2 |
| 404 | `not_found` | the pane is not eligible, or gone between the listing and a step |
| 409 | `busy` | another request for the same tmux window is running (row 3: retry at the next beat), or the pane's control lock stayed taken for more than 5 s by a running End, draft write, mode switch or command (`Claude is busy with another action on this pane. Try again.`); the lease, if any, is kept |
| 429 | `busy` | more than 4 PUTs in a second for this pane |
| 502 / 503 | `tmux_failed` / `tmux_unavailable` | a tmux call failed or tmux is not there; a lease taken is given back best effort |
| 500 | `internal` | the lease file could not be written (a change already made in tmux is given back first) |

**One lock.** Every tmux change of a fit (tag, zoom, resize, restore) runs under the pane's control lock (the one of mode, End,
command, answer, draft and suggestion): a resize re-wraps Claude's input box, so a draft write must not read the box across it. A
fit step **waits** for a running action on the pane, at most 5 s (then `409 busy`, above); while a step holds the pane, every other
action that takes the lock answers `409 busy-switching`, nothing sent, and the page's draft sync pushes again about 300 ms later.
Stop and the keys route take no lock. What a fit step holds the lock for (code at `828d52b`), at most:

| Step | Calls inside the lock | After the lock |
|---|---|---|
| restore (`DELETE`, the watch, a lapse, quit, start, spawn, a take-over, a user change found by a renew) | 8: a listing and the layout read, then unzoom, size, option, layout, focus, untag (it decides each step from those two reads) | R9: one listing, to log a difference |
| acquire | 6: a listing, the layout and the `window-size` option read, then tag, zoom (a window nobody zoomed), resize | the read-back: a listing and the layout |
| renew that resizes | 2: a listing, then `resize-window` | the read-back: a listing and the layout |
| give (0.5, F9: the page lost focus, or a terminal came to a window nika resized while the page has none; the watch, or a renew; **F15: a window nika squeezed has 6**: a listing, `resize-window` back, the `window-size` option back, `select-layout` of the layout read at the take, a guard listing, `resize-pane -Z` of the mirrored pane; the read-back checks zoom, size, layout and the pane's place) | 3: a listing, then `resize-window` back to the window's own size (only when nika holds a size and the window is not at it), then `set-option -wu window-size` (or `set-option -w window-size <saved>`); no unzoom, no layout, no focus, no tag call | the read-back: a listing and the layout (lease file written with `resized: false`) |
| take (0.5, F9: the page got focus, or a terminal has been away for `GROW_MS`, or a terminal resized a window nika did not; the watch, or a renew) | 3: a listing, `show-options -w window-size`, then `resize-window` to the panel (only when the plan resizes); no tag, zoom or layout call. **F15: a take that squeezes a window with several panes has 4**: the same listing and option read, then the layout read (`display-message … #{window_layout}`), then the resize | the read-back: a listing and the layout (lease file written with `resized: true` when it resized) |
| refit (0.5, F2: the watch, or a renew that meets nika's own agent pane; the call counts below are for a split or an exit) | two turns of the lock. Restore: 5 after a split (a listing and the layout read, then size, option, untag), 6 after an agent pane exits (also focus). Acquire: 6, as above | R9 after the restore, the read-back after the acquire; 18 tmux calls after a split and 19 after an exit, the watch's own listing included (see "Refit" below) |
| renew at the size nika holds (a heartbeat) | none (no lock) | none |

Steps that find a change release in a separate turn of the lock (a renew that finds the user's change, an acquire that fails its
read-back), so a lock is never held for two steps at once.

**When the server gives the window back by itself** (the watch, one `list-panes` per second while any lease is held; `src/fit.js`
`observe`):

| Observation | Action |
|---|---|
| the window is not in the listing, or `@nika-fit` is not this lease's nonce | the lease is dropped: no tmux call (the window or the server is gone, ids may be reused), the file is removed |
| the pane is gone, left its window, or is not claude any more | released (no mark) |
| only nika's own agent panes came or went (0.5, F2): the window size is what nika set, every row of the window parsed (the row count equals `window_panes`), each pane added has `@nika-role` `agent` or `sub-orchestrator`, and each pane that left was known as such | **refit**: released without a mark and fitted again at once (below) |
| a pane was added, has no `@nika-role` yet, and the rest is explained as above | **wait**: nothing now, the first sighting is remembered; a look at least `WATCH_MS` (1000 ms) later that still sees an untagged new pane is a user change |
| (0.5, F9) the lease's last request had **no focus**, a terminal shows a window nika **resized** (`#{window_active_clients}` above 0), and nothing else changed | **GIVE**: the window's size goes back to the terminal, in place (below) → `terminal`. The lease, the tag and the zoom stay |
| (0.5, F15) the lease's last request had **no focus**, nika squeezed the window below its own size (several panes), and nothing else changed | **GIVE**, whether or not a terminal shows the window; judged before the terminal rows. The size, the `window-size` option **and the layout** go back and the mirrored pane is zoomed again (F15 below) → `terminal` when a terminal shows the window, else `zoomed / panel-smaller`. The lease and the tag stay |
| (0.5, F4) the last request had no focus, a terminal shows a window nika did **not** resize, the lease is not `terminal` yet, and nothing else changed | **VIEW**: the lease becomes `terminal` (memory only, no tmux call) |
| (0.5, F4) a `terminal` lease without focus, no terminal now, `GROW_MS` (30 000 ms) since the first tick without one not over | **AWAY**: the watch notes the first tick without a terminal (`awayAt`); a tick with a terminal clears it |
| (0.5, F9) a `terminal` lease without focus, no terminal for `GROW_MS` | **TAKE**: the window is planned again with the panel's size, in place (below) → `fitted`, or `zoomed / panel-smaller` |
| (0.5, F15) the last request had **focus** and the lease is `zoomed` (the panel was smaller, or the layout could not be read at an earlier take) | **TAKE** at once, in place: a window with several panes is squeezed now (and `fitted`), unless its layout cannot be read again |
| (0.5, F9) the last request had **focus**, and the lease is `terminal` (after a give, or inside its grace), or nika has not resized the window and it is no longer at the size saved as its own (`width0` × `height0`: a terminal resized it), and nothing else changed | **TAKE** at once, in place (no wait for the 30 s) |
| (0.5, F9) a focused lease whose window is at the panel's size nika set, a terminal or not | nothing: the panel wins |
| (0.5, F9) a **TAKE** for a page with focus when 12 focus takes that resized the window have already happened on it in the last 60 000 ms (`TAKE_MAX` / `TAKE_SPAN_MS`) | no take: the lease stays as it is and a `terminal` lease answers `reason: switching` to the page with focus; the watch takes when the oldest of the 12 is 60 s old. A give is never limited; only a take for a page with focus that sent `resize-window` counts (not the unfocused take after `GROW_MS`, not a renew to a new panel size); the counts are in memory for at most 64 windows, the oldest dropped first |
| the window size is not the size nika set (F4: not judged for a window nika did not resize while a terminal shows it or the lease is `terminal`: the window follows its terminal); the same panes but (several panes) the window unzoomed or another pane active; a pane left that was not nika's agent; a new pane still untagged after the grace; a row of the window that did not parse | released, mark `user-change` |
| 15 s without a request for this pane (`LAPSE_MS`: the page is gone without a `DELETE`) | released (no mark); a lapsed lease is only released, never refitted, never waited for, never given a move (give or take) and (F4) never moved to or kept in the terminal form |
| tmux answers that no server runs | every lease is dropped |

**Refit (0.5, F2; owner decisions 2026-11-15).** A pane of nika's own spawn can join a fitted window (since 0.5.4 only through a race between the
spawn's read and its split, or a forged listing: a spawn never picks a window with `@nika-fit`, §3 "Placement"; before 0.5.4 the app's spawn gave
the window back first, and a CLI `nika spawn` never did), and an agent's pane closes when its claude
ends: neither is the user's doing, so neither turns the fit off. The fit's listing (§8) has a 12th field, `#{@nika-role}`, and a pane
counts as nika's own only when that is exactly `agent` or `sub-orchestrator` (`NIKA_PANES`; never `orchestrator`, never another text; a
row with a tab in its role has 14 fields and is dropped, and a dropped row of the window makes the row count differ from
`window_panes`, which is a user change: fail closed). The lease remembers, in memory only (the lease file and its keys are unchanged), which
panes of its window were nika's agents (`known`: set after every read-back that succeeds and refreshed at every watch tick that sees
nothing changed) and when the watch first saw an untagged new pane (`waitAt`). Why the rules read as they do: a split without `-Z`
unzooms the window and makes the new pane active, and a pane that exits unzooms it too, so when panes came or went the zoom and the active
pane say nothing about the user; neither a split nor an exit changes the window size, so a size change is judged first and is always the
user's; a gone pane has no tags to read, so a pane that left is judged by the role nika saw while it lived; a new pane gets one tick of
grace because the spawn tags it with `@nika-role` right after `split-window` returns, well inside one tick.

What a refit does, inside the window queue and the pane lock: the restore without a mark (`releaseNow`), a fresh listing, then the
decision of a page request with `open: false` and the lease's last `cols` and `rows` (`decide`, rows 5–14 above), so a mark, a fresh note of
the page's `DELETE`, a foreign tag or a refusal still wins and nothing is forced. The new lease keeps the old lease's last heartbeat, so only
the page's own request keeps a lease alive and a page that went away still lapses within 15 s of its last request. The refit's tmux calls,
in order: the watch's own listing; the restore (a listing and the layout read, then `resize-window` back, the window's `window-size` back,
the tag off, and one read at the end); a listing; the acquire (the `window-size` option and the layout, then inside the lock a listing, the
layout, the option, the tag, the zoom and the resize, then a listing and the layout as read-back): **18 calls after a split**. There is no
unzoom and no `select-layout` in the restore, because the split or the exit already unzoomed the window and changed the pane count; after
an agent pane **exits** the restore also runs `select-pane -t %A` back to the pane that was active before nika's zoom (the mirrored pane is
still the active one then), so that case is **19 calls**; after a **split** the new pane is active and there is no focus step. A page request
that meets the same change before the watch does (row 7) releases and acquires in that one request and answers `fitted` or `zoomed` for the
new window. A heartbeat at the size the lease holds is answered from the lease without a tmux call (row 1), so right after a split the page
can still get the old answer until the watch's next tick has refitted (at most a second); its chip key is usually unchanged (one pane
becoming two can turn `fitted` into `zoomed`, which the next beat shows and announces).

**F9: give and take in place (0.5, F9; owner ruling 2026-11-16, "the focused one wins"; owner decisions of the same day, Q2: one in place move for every size switch, and Q3: the cap of 12 takes a minute).** The two moves that change who sizes the window are not
refits. They keep the lease, the tag and the zoom; each is one change of the window's size (and, for a give, its `window-size` option) inside the
window queue and the pane lock. Both run in the request that carries the change of `focus` (a blur → give, a focus → take, in that request), and the
watch runs them as the fallback within a second (it reads the `focus` recorded from the last request, even a refused one). tmux resizes the layout
of a zoomed window as a whole, so **every pane of the window** (the hidden agent panes too) gets the new size and its Claude redraws once per move;
no unzoom, no `select-layout` and no focus change happen, so a terminal showing a window with several panes sees no flash of the other panes. **This holds for a
window nika sized without squeezing; the give of a window nika squeezed (F15) does unzoom it, see below.**

- **Give** (the page has no focus and a terminal shows a window nika resized): inside the lock a fresh listing (which refreshes what the lease knows
  of the terminal: a terminal that has left meanwhile is not reported), the same look as the watch's (`observe` must still say give, else
  nothing is changed), `resize-window` back to the window's own size (`width0` × `height0`, only when nika holds a size and the window is not at it),
  and the window's `window-size` option back (unset again when it was unset). Only after both calls does the lease turn `resized: false`,
  `sized: false` and `terminal`, so a failed call leaves the restore's resize back armed. The page's new `cols` and `rows` are adopted after that
  look, never before. `layout0` is **not** refreshed: it stays the user's layout from the acquire, so the final restore puts back the user's
  proportions and not tmux's rounded rescales; the read-back after the move reads `layout1` again.
- **Take** (the page has focus, or a terminal has been away for `GROW_MS`, or a terminal resized a window nika did not): first the cap (below), then
  inside the lock a fresh listing and the same look (must still say take), then `show-options -w window-size`: it must read `manual` when nika holds
  a size it set (it set it itself), else the value saved at the acquire; anything else is a `window-size` the user set while nika held none, and the
  lease is released with the mark `user-change` (`blocked / user-change`). The window's own size is then refreshed as `width0` × `height0`, only when
  nika holds no size of its own (a size nika set is not the window's own, and the restore's target must stay the original), the plan of rows 12–14 is
  made again with the panel's size (a terminal stops the resize only without focus), and `resize-window` is sent only when the plan differs from
  the window; `sized` is set before the call. The page's `cols` and `rows` are adopted after the look, also when the take is held back by the cap
  (the watch then takes with the newest size).
- **The cap.** A take for a page with focus that sent `resize-window` is noted per window (`TAKE_MAX` = 12 in `TAKE_SPAN_MS` = 60 000 ms, memory
  only, 64 windows, the oldest dropped first). A thirteenth is not made: the lease stays `terminal` and says `reason: switching` to the page with
  focus; the watch takes when the minute frees up. A give is never limited.
- **Failures.** A move whose pane is busy (`EPANEBUSY`) keeps the lease and the watch tries again next tick (from a request: `409 busy`). Any other
  failure is not retried: the watch logs one line (`nika: fit @W %P give failed (<code>)` or `take`) and releases the lease with no mark; a request
  releases it the same way and answers `502` / `503`. The final restore of a lease after a give sends no resize back (`sized: false`) and after a take
  sends it to the refreshed `width0` × `height0`.
- **A terminal that arrives.** Without focus, a terminal that arrives at a window nika resized is given the size back at the
  next tick or in the next request; a window nika did not resize only becomes `terminal`. With focus it changes nothing (the answer gains reason
  `terminal`).

A refit of a `terminal` lease that has no focus and is still inside its 30 s grace (an agent's split while the terminal has been away for less than
30 s) takes the window again with `noResize`, so it stays `terminal` and never ends the grace early; a refit of a lease with focus resizes. The watch's
refit carries the grace (`awayAt`) to the new lease; a refit that a page request meets first does not, so the 30 s start over (longer, never
shorter). The F4 and F9 rows of the watch table apply only when nothing else changed, so a user who unzooms in the tick a terminal arrives or the
focus changes stays a user change (W7 Q6). A page that flaps its focus cannot resize without end: the page settles a blur for 150 ms and a focus for
150 ms before it sends them (F10; F9 had 200 and 400 ms; a flick back sends nothing), and the server takes at most 12 times a minute per window.

A `DELETE` of the session window that meets a refit, a give or a take releases the lease the pane holds at its turn (see `DELETE` below).

A restore (`DELETE`, the watch, quit, the next start, a spawn) undoes only what nika did, in this order, each step on its own
(a failing step does not stop the later ones). It starts with a listing inside the lock: the window gone, or its tag no longer this
lease's nonce → the lease is dropped (the file removed) and nothing is touched or marked. Then: unzoom, only when nika zoomed, the
pane is still the active zoomed one; resize the window back to its saved size, but (0.5, F4, F9) only while nika holds a size it set (`sized`:
memory only, set before every call that may resize so that a failed call counts, cleared only by a give whose calls succeeded, and set for a lease
read from a file after a crash), to the window's own size from just before nika's last resize (`width0` × `height0`, which every take that sized the
window refreshes in the lease file), and then **even when the user resized the window during the lease** (the one step that overrides a user
action: the saved size is the only size nika can name, and a lease nika did not release would leave the window at the panel's size; a `terminal`
lease's window follows its terminal, so after a give its restore sends no resize, and a zoom-only window the user resized by hand is left
alone); the saved window-level `window-size` back (unset again when it was unset); the saved layout, only
when the layout is still the one nika left, the pane count is unchanged and the window is unzoomed; focus back to the pane that
had it, only when that pane still exists and the focus still sits on the mirrored pane; the tag off; the lease file removed. One more read at the end logs a
difference (`nika: fit restore of @n differs after <step>`) and never retries. The size is compared only when nika holds a size it set and no
terminal shows the window after the restore (F4, F9: after a give the window follows the terminal, and a window a terminal shows is not compared).

**F15: a focused page squeezes any pane; the give puts the layout back (0.5, F15; owner decision 2026-11-16, "resize while zoomed", asked twice; ADR 0017, the last
amendment).** No route, body key, answer field, reason, lease-file key, tmux command, listing field or argv shape changes (`ARGV` and `FILE_KEYS` are unchanged; the
reason `other-panes` of the design does not exist).

- **Plan.** `fitted` at the panel when the window has one pane, when the panel is at least as wide and as tall as the window, or when the request has `focus: true`;
  otherwise `zoomed / panel-smaller` at the window's own size. A user's zoom of another pane still blocks (`blocked / user-zoom`). The cap of 12 takes a minute per window,
  the rate and the tag are as before.
- **Take that squeezes** (several panes, a target below the window's own size in either dimension; at the acquire, a take and a renew that finds a focused lease at its own
  size and a smaller panel): inside the lock, from the same fresh listing that decides it, one `display-message -p -t @W -F #{window_layout}`; the answer has the focus markers
  stripped and is validated exactly like `layout0` (printable ASCII, 1–8192 characters, no `#`) and is kept in **memory** as `layoutT`; then `resize-window`. A layout that
  cannot be read or validated means no squeeze (fail closed): the pane stays zoomed at the window's size (`zoomed / panel-smaller`) and the watch retries at its next tick while
  the page has focus. `layoutT` is never written to the lease file; a crash while squeezed is recovered from `layout0`.
- **Give of a squeezed window** (the lease's last request had no focus, or a terminal came; in the request that carries the change and in the watch as the fallback; also
  when **no terminal** shows the window; never limited): R3 `resize-window` back to the window's own size (when nika holds a size), R4 the `window-size` option back,
  `select-layout -t @W -- <layoutT>` (tmux unzooms the window), one guard listing, `resize-pane -Z -t %P` **only if** the pane is still in the window and shows unzoomed, then
  one read-back listing: zoom flag 1, the window's own size, the stripped layout equal to `layoutT`, the mirrored pane still in the window. Any mismatch releases the lease
  with `blocked / changed`, once, with no retry. `layoutT` is cleared. The state afterwards is `terminal` when a terminal shows the window, else `zoomed / panel-smaller`.
  For a moment every pane of the window is visible (between `select-layout` and the zoom), and each pane gets two size changes and a redraw.
- **Not squeezed, so the plain give:** a window nika *grew* (a panel bigger than the window) and a later renew squeezes has no own-size layout to read (tmux scaled it): it
  keeps no `layoutT`, its give is the F9 give, and the release's R5 restores `layout0`. A window the user changed while squeezed (layout, size, zoom) is a user change or
  `changed`, and R5 is skipped when the user changed the layout.
- **Page strings** (`public/fit-ui.js`): the `zoomed / panel-smaller` title is "Other panes share this tmux window. With focus nika sizes the window to this panel; without
  focus it only zooms the pane and scales the text." and its hint "Click into this window to fill the panel; the other panes get their size and layout back when you leave
  it." A server that sends `other-panes` with `blocked` is shown as a plain "Fit · off".

### `DELETE /api/app/pane/:id/fit` (no body)
Gives the window back. The page sends it with `keepalive: true` on `pagehide` and when the pane is gone. `id` must match
`PANE_ID` (`400 invalid`). It is **not** eligibility-gated: the pane may be gone already and the user's window must still come
back. The rate limit (`429 busy`) is checked before the controller, in its own bucket of 4 per second per pane, so a close right
after a burst of beats still works. Answer `200 { "released": false }` when the pane holds no lease and no queued operation of any window
names it (no tmux call is made). Otherwise (0.5, F4; owner answer Q5, which fixes F2's leftover) the request waits its turn in the window's
queue behind whatever runs there (a renew, a refit, a release) and releases **the lease the pane holds at its turn**, not the one it found when
it arrived: a refit in front of it replaces the lease, and the new one must not stay held after the page has closed. The answer is then `200
{ "released": true }` (the restore ran, or the lease was dropped because its window was gone, or the pane held none by then). A `DELETE` that
meets a queued operation of its pane (a refit between its restore and its acquire holds no lease) also answers `released: true` and notes the
window, even when that operation ends with no lease, so a late heartbeat within 2 s is blocked. `409 busy` when the pane's control lock stayed
taken for more than 5 s (the lease is kept; the watch or the next request goes on); `502` / `503` when tmux could not be read (the lease is
kept too).

**Late heartbeat (M1).** After a `DELETE` that answered `released: true`, the server remembers the window for 2000 ms, inclusive
(an in-memory map, at most 64 windows, the oldest dropped first): a `PUT` with `open: false` in that time is the page's last
heartbeat in flight, not a page that wants the window, and answers `blocked / user-change` with no tmux call and no mark (row 8). A
`PUT` with `open: true` clears the note and any mark. Nothing is noted by a `DELETE` that held no lease (`released: false`) or
failed (409, 502, 503), by the watch (a refit included, 0.5 F2), by a lapse or by quit.

**What the page does with an answer** (`public/fit-ui.js`): 200 shows the chip for `state` and `reason` (spec §9.13) and nothing
else; 403 stops the fit for good and hides the chip; `404`, `409`, `429`, `502`, `503`, any other status and a lost request change
nothing and wait for the next beat (5 s), so a refusal is never retried faster (0.5, F9: except a change of the page's focus, below). After `blocked / user-change` and
`blocked / changed` the page keeps sending `open: false`; only a page load (or a `pageshow` from the back/forward cache) or the user's
Fit again / Fit here (0.5, F1) sends `open: true` again.

**The page's focus (0.5, F9; owner decisions 2026-11-16, Q3: the settle times (F10, Q2, changed them to 150 ms each, below), and Q4: a hidden window keeps its lease; no route change).** Every request carries `focus`, read fresh from the page (`document.visibilityState === 'visible'
&& document.hasFocus() === true`; a throw, a missing `hasFocus` or any value but the boolean `true` is `false`). The window's `focus` and `blur`
events (only when the event's target is the window itself, not an element inside the page) and `visibilitychange` are triggers only: the planner
reads the value itself on every one of them, on a 1 s poll (`FOCUS_POLL_MS`, so a missed event is caught within a second) and on every request,
because the webviews' focus events differ (WebKit changed them in 2026). A change must hold before it is sent, so a menu or a flick back costs
nothing: a blur 150 ms (`BLUR_SETTLE_MS`), a focus 150 ms (`FOCUS_SETTLE_MS`) (both 150 ms since 0.5 F10, owner decision 2026-11-16, Q2; F9 had 200 and 400 ms),
and a window that was hidden (minimized, closed to the tray) or shown again
none: sent at once. The change goes out as its own request at once, not on the 5 s beat, or right after the request in flight; the server answers it with
the give or the take (above), so the terminal has its size about 0.2 s after a click into it (plus its own repaint) and the panel is filled, as one finished
frame, about 0.55 s after a click into the session window (at most about 0.9 s; the first focus of a window that needs room for Claude's footer, below, takes one more resize, about 1.1–1.4 s). A change that was refused or lost (`409`, `429`, `502`, a lost request) is sent again by the next poll, at most once a second (inside
the route's 4 per second); a refused request that carries no new focus still waits for the beat. After `close()` or a `403` no event or poll sends
anything. Hiding the session window (close button, minimize) is a blur, so it gives the size back; the lease stays until the page is shown again, lapses
(15 s without a request, when the webview stops its timers) or the page leaves.

**The page's size, room for Claude's footer and the redraw hold (0.5, F10; owner decisions 2026-11-16, Q1 to Q4, ADR 0017; the page: spec §9.13).** No route,
body key, answer field, lease-file key, `ARGV` entry or server gate changes; the server only caches a capture for 100 ms instead of 250 ms (the capture route
above). Everything below is the page's behaviour, written here because it decides which sizes the route is asked for and when the page's other requests go out.
- **A steady size.** The page measures its panel (the terminal box's border box, one glyph cell and the window's inner size) only at fixed moments: the start
  (`document.fonts.ready` and, since F11, the first capture of a lease), a window `focus` (measured before the focus settle starts, so the take gets the size of that moment), Fit again and a `pageshow` from the
  back/forward cache, and a `ResizeObserver` change that counts: the window's inner width or height changed, a cell side changed by more than 0.01 px, or the box's width
  moved by one cell or more (the transcript toggle, the narrow tabs, the app's zoom). A change of the box's height alone with the same window size (a header wrap, a chip,
  a banner, a composer line, a prompt panel, the textarea growing) and a width change of less than one cell send no request and change no text size; the mirror stays
  pinned to the bottom (not while it is paused), so the top rows may be hidden while a panel is open. A blur measures nothing. So one focus change is one resize
  (the take carries the size measured at the focus); the one extra resize is the room step below.
  **One more moment since FX2 (0.5, 2026-11-17; page side, no server change):** every commit records whether the prompt panel, the question form, the feedback survey or the attention note was shown when it
  measured (a focus under the form measures a box shorter than the resting one). When the last of them closes, the window has focus and the chip's state is neither absent nor `blocked`, the page takes one
  fresh commit at the next drawn capture or 304, before the grow below asks its size back; with no focus the record ends and the later window `focus` commits. A height change alone is still no commit.
  **One more rule since FX4 (0.5.2, 2026-11-17; page side, no server change):** while one of those four panels is shown, a commit does not measure the terminal box's height (the box hugs its rows, so it says nothing
  about the room): it keeps the measured width, cell size and window size and takes the held frame's height moved by the change of the window's inner height, so the columns and rows asked are the
  size the pane had without the panel (a taller window still grows the pane, a shorter one lowers it by its own change only), and the last commit's hidden rows and strip stay in the ask. With no frame ever
  measured without a panel the page keeps FX2 alone. The same `ResizeObserver` also observes the terminal column, so a window that gets taller under a panel still counts as a change of the window's inner height;
  a change of the box's height alone is still no commit. The size asked stays inside the route's ranges and nothing else about the request changes.
  **One look that is not a moment (FX3, 0.5, 2026-11-17):** when the grow asks the base size back, the page measures the panel once more, without a commit and without a request: with the window focused, the chip neither absent nor `blocked`, no panel shown, and the
  same columns and strictly more rows than the held base, the measurement becomes the base (and the held frame). The way back is the one request that follows, as before.
- **The asked size.** The body is still exactly `{ cols, rows, open, focus }` in the route's ranges (40–400 × 10–200); the server does not know that the page asked
  for more rows than it measured. The page asks for its panel's size, and, once a window needs it, for room: 33 rows (`ROOM_ROWS`) and as many columns as keep the
  panel's proportion, `floor(panel cols × (33 − d) / panel rows)`, never fewer than the panel's, at most 400, where `d` is the border row (the asked rows minus the
  pane rows of nika's own last 200 answer, kept only when 0 or 1; `pane-border-status` makes it 1), and scales the text to the panel (never below 0.4). A panel of 33
  rows or more is asked as it is. These are the sizes without hidden rows (`askSize`); with hidden rows the next bullet applies.
  Since F11 `d` is learned only from nika's own answer, the one whose columns are the columns last sent. An answer with other columns (the terminal's size while the
  window is unfocused, a zoomed window's size) says nothing about the border row, so the earlier `d` stays (F10 reset it to 0, which made the next ask one row short). Before nika's first own answer `d` is 0.
- **More of Claude's conversation (0.5, F11; owner decision 2026-11-16, "More conversation").** While the mirror hides Claude's input box and the footer below it under
  its one-row strip (a readable draft and Type into pane off: it draws the rows above the box's top rule, the cut row, and the strip; spec §9.12), the pane's rows
  under the cut would stay empty panel. The same request asks for them, in the same single resize at each commit point; the text size stays as F10 sets it, and the box and the footer stay on
  Claude's screen (nika reads the draft and the mode from them). The body, its ranges and the answer are unchanged.
  - *Hidden rows K* (`hiddenRows`): from the capture drawn at the commit, the last row with ink + 1 − the cut row; a row has ink when a span holds a character other than a space or U+00A0, so blank rows
    under Claude's footer (its classic view) are not counted. K is 0 with no cut, a cut that is not a row from 1 to rows − 1, no ink at or below the cut, or more than 24 (`HIDE_MAX`: the screen is
    not one nika knows, so nothing is added).
  - *The fill size* (`fillSize`): with K from 1 to 24 it keeps the columns of the sizes above and asks `rows = min(200, max(F10's rows, above + K + d))`, where `above` is the number of
    rows that fit the panel above the strip at F10's text scale s0: `floor((box height − 20 − strip) / (cell height × s0))`, `s0` being F10's scale for that ask (1 without room;
    with the room `min(1, panel cols / room cols, panel rows / (33 − d))`) and `strip` the strip's height in CSS px as measured (`offsetTop` and `offsetHeight` of `#term-cut` against `#term-rows`),
    or 2 cells when that is not a positive number up to 4 cells. Never fewer rows than without hidden rows; with no valid K, no usable box or cell height, or no row left above the strip it is
    exactly the F10 size. Example: a 145 × 22 panel, K 6, a 27 px strip, `d` 1 asks 145 × 27 without the room and 210 × 37 with it (F10: 145 × 22 and 210 × 33).
  - *When K is read.* Only at the commit points: the start, a focus, Fit again and a change of the window, the width or the cell (the list in "A steady size" above). **The first capture of a
    lease is a commit point:** the page measures and reads K from that first frame before the start request, so the start request carries K and is still one request (before F11 the start
    was sent with the size measured at boot, when no frame was drawn). Never per capture, never on a change of K or of the box's height alone, so no resize cascade follows.
  - *The text scale* (`drawnScale`). Since F11 the scale counts the rows actually drawn, the rows above the cut and the strip, not the hidden ones:
    `min(1, panel cols / pane cols, (box height − 20 − strip) / ((pane rows − K) × cell height))`, never below 0.4; with no hidden rows (or no usable box or cell height) it is F10's `min(1, panel cols / pane cols,
    panel rows / pane rows)`. It is worked out at a commit and when an applied capture changes the pane's size, and held in between. At nika's own sizes the width decides and the text is
    F10's (1 without the room, about 0.69 with it). It uses the same rule while the terminal owns the size and nika can add no rows (the 171 × 45 pane of the example: about 0.53 where F10 gave 0.49), so
    the conversation fills the panel there too; no resize.
  - *Between commits* nothing is asked and the text does not change when K does: a cut that turns off (Type into pane, a draft nika cannot read, a prompt or a dialog) shows every row, so K rows minus the strip's
    height overflow at the top (about 4 rows in the example), the mirror staying pinned to the bottom; a cut that moves up (a longer draft) leaves that many empty rows; one that moves down overflows; the next commit corrects it.
- **The room step.** The page asks for room once for a window, at once (no debounce, `size(…, { now: true })`), when the redraw hold below ran out and all of these
  hold: the frame drawn before the resize showed a readable input box; the latest capture is at the answered size, in the full-screen view (`alt`), with no prompt, no
  dialog and no readable draft **or (F12) a readable draft whose capture does not confirm the mode (`modeConfirmed` not `true`) although the frame drawn before the resize
  did (a confirmed mode other than `unknown`: `modeBefore`)**; the chip's state is `fitted` (never `zoomed`, `terminal`, `blocked` or `other`); the panel has fewer than 33 rows; the room is not
  already on; and (F11) the room ask has more rows than the request last sent. The room step asks the room's fill size (at least 33 rows, from the K of the last commit: its pending frame
  has no readable box or no mode line, so K is not read again); when that ask would be the size already sent the step would send nothing and only wait out another hold, so it is not taken and the
  pending frame is applied. At most one room step per window: after its own hold the latest capture is applied whatever it shows. The room stays on across focus changes (each later
  focus is one resize straight to the room size, a take that counts in the 12 a minute like any other) until Fit again, a commit with a new window size or width, or a
  page load; it lives in page memory only. For the route the room step is a request with a larger `cols` and `rows` from a page that holds the lease (a renew of a
  fitted window, not a take, so it is not counted in the cap of 12), and every rule above applies to the asked size: the squeeze rule, the rate of 4 requests a second per
  pane, the lock, the lease. The fit chip's panel says why while the room is on and offers Fit again (spec §9.13); the chip's states, words, colours and icons do not change.
- **The redraw hold.** The planner tells the page the pane size of every 200 answer (`fit.pane`, when both numbers are integers 1–10000; before the chip is told, so the
  chip can wait). When a frame is drawn and the answered size differs from the drawn pane size, nika's own resize is under way, and the page keeps drawing the last good frame
  until a 200 capture at the answered size (columns and row count) shows a readable input box (and, F12, the mode line too when the frame drawn before showed it, see below),
  a prompt, a dialog or no full-screen view (or there was no readable box
  before the resize), for at most 1.2 s (`HOLD_MS`; a grow step for a cut-off question waits for the question instead, F16, see "A cut-off question" above). It reads the capture route at once and then every 100 ms (`HOLD_POLL_MS`; normally every 250 ms). A capture that is not
  ready is kept and not applied: not drawn, not given to the mode chip, the draft sync, the scroll gate, the quick actions or the Live label, which keep the last good state.
  A 304 changes nothing; a 404, a 403 or an error ends the hold at once and is handled as always (a pane that is gone is never hidden). A chip view that arrives during the
  hold is drawn when it ends, in the same frame as the mirror (up to 1.2 s after the answer). When the hold runs out the room step above is taken if its conditions hold,
  else the latest kept capture is drawn as it is and the page shows the truth (the mode "unconfirmed", the scroll refusal `screen-unclear`).
  **F12 (owner decision 2026-11-16, after the build-11 check): the hold waits for the mode line too.** At each start of the hold the page records `modeBefore`: the frame drawn before the
  resize had a readable input box and a capture with `modeConfirmed` `true` and a `mode` other than `unknown` (a restart of the hold, including the room step's, keeps the first
  `modeBefore`, as it keeps the first "readable box before"). With `modeBefore` a capture that shows the box is ready only when it also has `modeConfirmed` `true`; a prompt, a
  dialog, a screen not in the full-screen view and a hold with no readable box before are ready as before, and with `modeBefore` false the rule is exactly the one above. Cause: Claude's
  bottom area (a task list, a notice, the input box and a three-line footer) can be one row too tall for the pane, so Claude lets the footer's last line, the one with the mode, run off
  the screen while the input box stays readable; the capture then answers `modeConfirmed: false` (the remembered mode, not confirmed), the chip reads "unconfirmed" and a mode switch would be
  refused. The cost: a frame whose mode line never comes back after nika's resize keeps the page on the old frame for the full 1.2 s, then the room step is taken once (33 rows or more, the
  text scaled), and if the mode line is still off at that size the second hold waits another 1.2 s and the frame is drawn as it is (the mode "unconfirmed", as before). No route, body key, answer
  field or server gate changes.
- **What waits for the hold, and what does not.** These page requests wait until the hold is over, at most `HOLD_MS` (twice that with a room step), then go out as they
  always do: the scroll route's request, Send's own steps (the copy into Claude's input, the draft write `PUT …/draft`, the `Enter` through `…/submit`), the attachment send
  (`…/attach-send`, on every road, 0.5 final review), the suggestion accept (`…/suggestion`), the mode switch,
  and the quick-action commands. End opens its dialog after the hold (the dialog sends its own request, so that request is not delayed). These do not wait: the user's own
  keys typed into the pane (the passthrough and the arrow keys, `…/keys`), the answers to a prompt or a dialog (a prompt or a dialog ends the hold at once), and Stop.
  **Every server gate is unchanged:** each request takes its own fresh capture under the same lock and refuses on the same rules as before; the page never sends anything on the
  strength of the held frame, and the wait only keeps the page from asking while nika's own resize has the screen half drawn.
- **A cut-off question (0.5, F16; owner decision 2026-11-16, "Grow the pane", questions only 2026-11-17; 0.5.4 adds a cut plan, O2, and a preview with hidden lines, QP; the page: spec §9.13; ADR 0017 amendment; no server change).** Claude clips a question dialog that is taller than the pane
  from the top, and the capture's `dialog` then says `unreadable` with `kind: "ask"` and `reason: "cut"` (above; a text ending in `…` is `clipped`, which rows never fix). Since 0.5.4 the page grows for two more screens (`growWanted` in `public/fit-ui.js`; still no server change): a plan approval that is `unreadable` with `kind: "plan"` and `reason: "cut"` (O2: a plan clipped at the top; a plan that is `wide` or `layout` never grows, QPF F3), and a question step with a preview that Claude drew with lines left out (`ready`, `preview.hidden` above 0 and `preview.fallback` false; owner answer Q1 = A; the fallback has nothing to show, so it never asks). "Cut" below means any of the three. While that holds and the
  chip's state from the last answer is exactly `fitted` (also with a terminal on the window, F4), the page asks for more rows in the same body and ranges (40–400 × 10–200), through the planner's `size(cols, rows, { now: true })`
  (no 250 ms debounce):
  - *Rows.* `min(120, max(rows + 12, 2 × rows))` (`GROW_STEP_MIN` 12, `GROW_CAP` 120), counted from the size the fit asks without the grow (the last commit's `fillSize`, F11), columns unchanged. 120 is the reader's
    reach: it finds a strip only within 100 rows above the footer, plus a rule, the task block under the footer and the border row. 145 × 21 asks 42; a base of 120 or more asks nothing.
  - *When.* A question that reads `cut` on one capture and still reads `cut` 200 ms or more later on the next capture or 304 (`GROW_CONFIRM_MS`); then once per step: the drawn frame must have the asked row count (the border row d, 0 or 1,
    included) and 800 ms (`GROW_SETTLE_MS`, Claude repaints 340–680 ms after a resize) must pass with the question still `cut`, then the next step counts from `max(rows, base)`. At most four steps from a base of 10 rows (22, 44, 88, 120).
  - *Giving up.* Still `cut` at 120 rows, or the asked row count not in the drawn frame for 6 s while `fitted` (`GROW_WAIT_MS`, a refused request): the page asks the base size at once and does not grow again for this question
    (a commit that changes the base size, a width alone included, gives a new try).
  - *Staying.* A question that is no longer `cut` (readable, or unreadable for another reason) keeps the rows: answering takes a fresh capture of the screen, and sizing back first would clip it again. A later tab or the review that is
    `cut` steps again.
  - *Going back.* When no question dialog has been on screen for 1 s (`GROW_CLOSE_MS`; none, a plan or a prompt all count; a shorter gap between two tabs does not), the page asks the base size again. Since FX2 that base is
    measured again first when the last commit was taken under a panel (see "A steady size" above), so the size back is the panel's size, not the short box's. And since FX3 the page looks at the panel once more at this very moment (the look of "A steady size" above, no commit, no extra request): a base that is shorter than the box now measures, with the same columns, is replaced by the measurement, because a commit can have measured a box that no panel explains (LC18 R4b: a terminal that attached after the question opened, a blur and a focus; the window ended 2 rows short).
  - *Not `fitted`.* In `terminal`, `zoomed`, `blocked` and `other` the page takes no step and the step's clocks wait; it keeps the grown rows in what it asks, so a commit or a take that follows already carries them (`max(base, grown)`).
  - *A renew, not a take.* The ask is a renew from a page that holds the lease, so `TAKE_MAX` (12 takes a minute) does not count it; the route's 4 PUT a second per pane, the lock, the lease and every other gate apply. The server cannot tell it from a
    panel of that size.
  - *The redraw hold of a step* (`cutBefore`: a step was asked while the drawn question was `cut`) ends on the first capture at the asked size whose question is no longer `cut`, whatever else is on screen (the F10 and F12 exits do not apply), or
    after the usual 1.2 s, when the latest kept capture is drawn as it is; `io.timeout` is told `{ want, plainBefore, modeBefore, cutBefore }`.
  - *The page.* The text scale stays that of the size without the grow (the base rows less the border row and less the hidden rows of the last commit), so the pane is taller than the panel and the mirror overflows natively, pinned to the bottom;
    the dialog form shows "Reading Claude's question…" past 2 s while a step runs; the chip's panel says why. Answering is unchanged: `POST …/dialog` takes a fresh capture and checks the `sig`, the bypass window and every gate.
- **Unchanged:** the routes and their bodies, the answers, `FILE_KEYS`, the lease file, `ARGV`, `LAPSE_MS`, `GROW_MS`, `TAKE_MAX` 12 and `TAKE_SPAN_MS` 60 s, the rule that hiding
  keeps the lease, the chip's states, words, colours and icons.

**Fit again and Fit here (0.5, F1; no server change).** The chip is a button that opens a panel (spec §9.13). Its action, shown only where
`open: true` can change something (`blocked / user-change`, `blocked / changed`, a `blocked` the page has no reason for, and `other`), makes the
page's next request `open: true`: the same `PUT`, body and answers as above, sent at once (a heartbeat that waits is cleared and the beat
re-armed; a request in flight finishes first, then this one goes out). The page ends that ask in exactly one way: 200 with a fit answer (the
panel closes on `fitted`, `zoomed` or `terminal`, else it is drawn again for the new state), 403 (everything stops, the chip hides), or any other status or
a lost request (the panel shows "nika could not fit the window just now. It tries again within 5 seconds."; the page then treats the window as
not yet opened, so the next heartbeat sends `open: true` again). `user-zoom`, `size-option` and `foreign-tag` have no action: the server refuses
`open: true` again for them (rows 5, 9 and 10 do not look at `open`), so a button would only fail; they recover on the next heartbeat once the
user acts in tmux. `terminal` has no action either (0.5, F4, F9): `open: true` lands on `terminal` again while a terminal shows the window and the page
has no focus (row 12 does not look at `open`); the way to the panel's size is a click into the session window, and the chip's panel says so (and that
nika also sizes the window by itself after 30 s without a terminal). A state that follows a change of the page's focus is drawn but not announced a
second time (`io.chip(view, { quiet: true })`: the chip, its title and its name still change); the answer to the user's own Fit again is always announced.

Logging: nothing of the body, a layout or a nonce goes to a log or the console; errors carry the pane id, the window id, the step
name and the error code only. Both routes exist on the app tier only (the browser tier has no fit route, no tag read and no lease
file).

### `POST /api/app/pane/:id/scroll` (body ≤ 4 KB, `CAP.small`)
Scrolls Claude's own full-screen view (0.5, W3; ADR 0018, `docs/security.md` T39, the page: spec §9.15). The request names a direction
and a count, or an end; it never names a key. App tier only: the browser tier has no such route (404).
```json
{ "dir": "up", "pages": 2 }
```
```json
{ "to": "bottom" }
```
The body is exactly `{ dir: "up" | "down", pages: 1..8 }` or `{ to: "top" | "bottom" }`; anything else (an extra key, a fraction, 0, 9,
a string for `pages`, an array) is `400 invalid` (message `body must be { dir: up|down, pages: 1-8 } or { to: top|bottom }`). A fixed table
in `src/scroll.js` turns it into the keys, sent in **one** `keys.send` call:

| Body | Keys |
|---|---|
| `{ dir: "up", pages: n }` | `PPage` × n |
| `{ dir: "down", pages: n }` | `NPage` × n |
| `{ to: "top" }` | `C-Home` |
| `{ to: "bottom" }` | `C-End` |

A page is what Claude's `PPage` moves: about half of its transcript area (15 to 17 rows in the live checks, `claude-tui.md` §12). These
four keys are the only output of the route. It **never** sends `Escape`, `Enter`, `Tab`, `BTab`, `Space`, `C-c`, `C-d`, `C-u`, `Up`,
`Down`, plain `Home` or `End`, a digit, text, a paste, a mouse report or a tmux copy-mode command.

Checks, in this order (the first that fails answers; nothing is sent after a refusal):
1. Body invalid → `400 invalid`. This runs before the pane check.
2. Ineligible pane (same rule as capture) → `404 not_found`.
3. More than 10 scroll requests in the last second for this pane (`SCROLL_RATE`, a sliding window) → `429 busy` (`at most 10 scroll requests
   per second per pane`), before the lock and before any capture.
4. The pane's control lock (the one End, mode, command, answer, draft, suggestion, submit, the fit steps and attach-send share; waits at most
   5 s) → else `409 busy-switching`, body `{ "error": "busy-switching" }`.
5. A Stop or End interrupt is running on the pane, or sent its `Escape` less than 40 ms ago (`keyGap`) → `409 busy-switching`. A key right
   behind an `Escape` would be read as Meta plus that key and the interrupt could be lost. Stop takes no lock; the check is made again right
   before the keys.
6. One fresh capture (never the cache). A capture that fails → its status and body.
7. The screen gate, in this order. A 409 carries `{ error, message }`:

| `error` | When | `message` |
|---|---|---|
| `no-view` | `alt` is not true: Claude's full-screen layout is off, so there is nothing to scroll | `Claude's full-screen view is off, so there is nothing to scroll.` |
| `prompt-open` | a permission prompt parses (`prompt` not null): Claude binds the page keys to the highlight of its select lists | `A permission prompt is open. Answer it first.` |
| `screen-unclear` | `draft` is `null`: no plain input box (a dialog, a survey, Claude's post-rating row `(Optional) Press [1] to tell us more`, an overlay, an unknown footer, a cursor outside the box, the transient `paste again to expand` hint) | `Claude's input box is not on screen (a dialog, a menu or a survey may be open).` |
| `menu-open` | the draft is text that starts with `/`, or an unreadable draft whose first box row starts with `❯ /`: Claude's slash menu is drawn above the box and leaves the footer readable, so the gate fails closed | `A slash command is being typed. Finish or clear it first.` |

8. The keys, one `keys.send`. Its non-200 answer (`429 busy`: the keys route's 20 requests per second per pane is shared; a tmux failure)
   passes through with its status and body.
9. After 30 ms, one fresh capture, which also refreshes the 100 ms cache the page reads next.

Success: `200 { "sent": n, "scrolled": true | false | null }`. `sent` is the number of keys sent (1 to 8). `scrolled` is the capture's
`scrolled` after the keys, `null` when that capture failed (the keys are out whatever happens next).

What the gate deliberately **allows**: a busy Claude (a turn, a tool, a `!` command: scroll keys never interrupt, and reading older output
while Claude works is the main use), a draft of any length in the box, an unreadable draft (`history`, `pasted`, `tall`, `layout`,
`trailing`: still the plain box, and these keys never edit it), vim insert or normal mode, and Type into pane on (for the wheel only: the
page keeps sending the user's own `PPage`, `NPage`, `Home` and `End` through the keys route). `NPage` is sent even when `scrolled` is
`false` (a no-op at the bottom), so a pill nika fails to recognise never strands the user. Nothing of a request is logged.

### `POST /api/app/pane/:id/attachments` (body ≤ 12 MiB, `UPLOAD_CAP`)
Stores one file for the next Send (0.5, W2; ADR 0016, `docs/security.md` T38). It is the way in for a pasted or dropped file; the
paperclip's file chooser stores through the same store (below). App tier only; the browser tier has no such route (404). Nothing reaches
Claude before Send, and exactly one route serves a stored file back (the image read, `GET …/attachments/:attId/image` below, 0.5.1).
```json
{ "name": "notes.md", "data": "<standard base64>" }
```
The body is exactly these two keys: `name` a string of at most 255 UTF-16 units (used to pick the extension of a text file; it never
reaches the disk or a log: since 0.5.4 (AT) its last part, through `clean()` and cut to 255 characters, is kept in memory as the chip's label and returned only by
`GET …/attachments` below), `data` standard base64 (length a multiple of 4, alphabet `A-Za-z0-9+/`, at most two `=`). Anything
else is `400 invalid`. A body over 12 MiB is `413 too_large` and a content type other than JSON `415 unsupported_media`, both from the
dispatcher. Checks, in this order:
1. Body shape → `400 invalid`; a `name` whose last part is `.env`, `.env.*`, `.envrc`, `.envrc.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.ovpn`,
   one of the credential files `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc` or `credentials` (exact base names; owner decision 2026-11-16) or
   an SSH private key by exact name (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`, `id_ed25519_sk`; a `.pub` file is not one),
   any case → `400 secret-file` (rule 4: nika does not take credential files; nothing is decoded or stored, and the tray refuses such a file
   before it reads it).
2. Ineligible pane (same rule as capture) → `404 not_found`.
3. The pane's repository key, from nika's own snapshot (exactly one live agent claims the pane, else the key of a pane nika started; never
   from the request) → none, or two claims → `409 no-project` (`nika can't tell this session's project`).
4. The pane's tray (0.5.4, AT) already holds 6 unsent files (a file whose copy is gone does not count) → `409 tray-full`. It is checked before the
   rate slot, so a refusal uses none, and it applies to the chooser's saves too (below).
5. Admission: one save at a time (the chooser's reads count too) and at most 30 a minute for the whole server → `429 busy`.
6. The decoded size: more than 8 MiB (`MAX_BYTES`) → `413 too-big`.
7. The type, from the bytes (never the name or the page's file type): PNG, JPEG, GIF (87a or 89a), WebP, PDF, or strict UTF-8 text with no
   C0 control other than tab, LF and CR and no DEL or C1 code point (stored as `text`). No bytes → `400 empty`; anything else →
   `415 wrong-type`.
8. The folders: `<state>/attachments/` and `<key>/` are created 0700 and resolved; not real folders you own → `409 folder-unsafe`; no space
   left → `507 disk-full`.
9. The full path must match `^/[A-Za-z0-9._/+-]{1,200}$` (it will be pasted into Claude as one token) → else `409 path-unusable`.
10. Pruning and the caps (§6): over 256 MiB or 500 files even after everything that may go has gone, or only files younger than 1 h left to
   evict → `507 storage-full`; the caps could not be checked → `507 disk-full`.
11. The write (`writeAtomic`, 0600, the id 16 random hex): no space left → `507 disk-full`; any other failure → `500 write-failed`. An
    exception anywhere in the store is logged as `nika: attachments: <code>` (never a path, name or id) and answered `500 write-failed`.

The route also binds the pane's tray (0.5.4, AT) to this project and this Claude right before the file lands in it (`bindTray`): a tray of another
project, or of a Claude with neither the same pid nor the same session in the pane (`/clear` keeps the pid, `/compact` keeps the session, so both keep it),
is dropped first and its unsent files deleted.

Success: `200 { "id": "<16 hex>", "type": "png" | "jpeg" | "gif" | "webp" | "pdf" | "text", "size": n }` (`size` in bytes). The id is the
only handle: Send and Delete name a file by it, never by a path. The server remembers the ids it issued in memory only (the 500 newest), and, since
0.5.4 (AT), one **tray** per pane: the ids of that pane's unsent files in the order stored, each with its label (the last part of the name through
`clean()`, at most 255 characters), at most 6 per pane (`409 tray-full` above) and 64 trays (the 65th makes the oldest forgotten from memory only; its files
wait for pruning). The tray is bound to the pane's project key and to the Claude in the pane; nothing of it is written to disk. After the app
restarts an old id is unknown (`attachment-gone` at the send, `removed: false` at the delete) and the tray is gone, so the page lists nothing; the files wait
for `attachments.keepDays`. Every answer is
`{ error, message }` for a refusal, where `message` is the code in words and the page never shows it.

The page allows 6 files of at most 8 MB per message and uploads one at a time; the server enforces the 6 at the send and, since 0.5.4, at the upload
(`409 tray-full`).

### `GET /api/app/pane/:id/attachments` (0.5.4, AT)
The pane's unsent attachments, for the session window when it opens or comes back from the back/forward cache, so the chips return after the
page was left (ADR 0016, amendment 2026-11-20; `docs/security.md` residual item "A page that leaves"). App tier only (the browser tier answers `404`);
no body, no rate limit (the page asks once per open), `no-store`, and **not a user's action**: no typing stamp. Order: pane, then the claim.
1. An ineligible pane (same rule as capture) → `404 not_found`.
2. The pane's repository key and Claude, from nika's own snapshot (never from the request). None, or two claims: a pane that has no tray
   answers `200 { "files": [], "gone": [] }` (it can never have stored a file; a tray that holds only kept text, LT below, counts as none), and a pane that has one answers `409 no-project`
   (`nika can't tell this session's project`), listing nothing and deleting nothing.
3. A tray of another project, or of a Claude with neither the same pid nor the same session as the claim's, is dropped (its unsent files deleted) and the
   answer is the empty one above. A tray whose only content is kept text (LT, below) lists empty and stays.
4. Each item gets the send's file check (a record that is this pane's and unsent, and the file opened through `fsafe` and compared; no byte is read).
   A file that fails it is marked **gone**: it keeps its place, is listed under `gone` again and again, and its record is deleted; it never counts toward the
   6 and goes at the next save, remove or send on that pane.
```json
{ "files": [ { "id": "<16 hex>", "name": "notes.md", "type": "text", "size": 2048 } ], "gone": [ "old.png" ] }
```
The answer is rebuilt by the route as exactly this shape, never passed through: `id` 16 lowercase hex, `type` one of `png` · `jpeg` · `gif` · `webp` · `pdf` ·
`text`, `size` an integer 1 to 8 MiB, `name` at most 255 characters, at most 6 entries of each list, and **never a path**; an entry that does not fit is
left out. A store error is logged as its code only (`nika: attachments: <code>`) and answers `500 internal`. The page builds chips that are already
`ready` from `files` (the label through `textContent`) and shows one note for `gone` ("Not restored:", its own colour tokens and icon). It asks once more
after a failed read; add, choose and Send wait while it asks (about 8 s at most), and a `404` is left to the session window's own gone flow. The ids it gets
back are the ones Send and Delete already take.

### `DELETE /api/app/pane/:id/attachments/:attId` (no body)
Removes an unsent file now: the chip's ×, or a chip removed while it uploaded. A page that leaves deletes nothing (0.5.4, AT: the chips come back
when the session window opens again, `GET …/attachments` above); the files go when the user removes or sends them, when the session ends (the pane is gone
from a successful tmux listing or is dead, or another project, or a Claude with neither the same pid nor the same session, claims the pane), and after
`attachments.keepDays`. `id` must
match `PANE_ID` and `attId` `^[0-9a-f]{16}$`, else `400 invalid` (`invalid pane or attachment id`; `DELETE …/attachments/pick` lands here too).
It is **not** eligibility-gated (the pane may be gone and the file must still go). Answer `200 { "removed": true | false }`; `false` for an
id that is unknown, belongs to another pane, was already sent, whose file is already gone, or whose removal was refused (a linked folder or a
second link), all alike, so the route is no oracle. A store error is logged as its code and answers `200 { "removed": false }`. A file
that was never removed is pruned after `attachments.keepDays`. It stamps the pane (a user's action, 0.5.4, AC) on arrival, before the store runs; a stamp of a pane that is not listed is dropped at the next refresh.

### `POST /api/app/pane/:id/attach-send` (body ≤ 4 KB, `CAP.small`)
Puts the stored files of a message into Claude's input and presses `Enter` (0.5, W2; ADR 0016, `docs/security.md` T38, T51, T54). It
sends while Claude works too (W13, ADR 0019, owner decision 2026-11-15): Claude queues the message with its files, so **no step reads the
registry state**. App tier only.
```json
{ "ids": [ "<16 hex>", "<16 hex>" ], "base": "<16 hex>" }
```
The body is exactly these two keys: `ids` 1 to 6 different attachment ids (`PER_MESSAGE`), `base` the `sig` of the draft the page has just put
into Claude's input (the answer of a draft write) or last saw (the capture), also for an empty message (the `sig` of an empty box). Anything
else is `400 invalid` (`body must be { ids: 1 to 6 different attachment ids, base: 16 lowercase hex characters }`), before the pane check.
Ineligible pane → `404 not_found`. The send itself runs under the pane's control lock (a wait of more than 5 s → `409 busy-switching`, `pasted`
0) and fails closed: whatever the screen shows that is not exactly what a step needs, nothing more is sent and the answer is a 409 whose body
is `{ "error": "<code>", "pasted": n, … }`, `pasted` being the number of paste requests that already went out (0 to 6). The page uses it to say
whether anything is in Claude's input. Steps, in this order:
1. Every id is looked up: an id this server did not issue for this pane, an already sent one, a file that changed or is gone, or a folder that
   became a link → `409 attachment-gone` with `id`; a stored path that no longer matches the upload's path rule or a type nika does not
   paste → `409 path-unusable` with `id`.
2. A Stop or End interrupt is running, or sent its `Escape` less than 40 ms ago → `409 not-idle` (the same check runs again before every
   paste and before the `Enter`).
3. One fresh capture (never the cache); a failed capture passes through with `pasted`. A permission prompt on screen → `409 not-idle`
   (T51: a paste never lands in a prompt). `not-idle` therefore means a prompt is open or Stop or End is running, never "Claude is working".
4. The box must be a plain, readable, ours-to-paste-into input box:
   - no readable box: an unreadable draft whose reason nika can name (`history`, `tall`, `layout`, `pasted`, `trailing`) → `409 draft-unreadable`
     with `reason` and `draft`; an unknown footer (a question, review or plan dialog, the auto-mode nudge, a survey, an overlay) →
     `409 mode-unknown`; a footer that reads but no recognised box (also while Claude's post-rating row `(Optional) Press [1] to tell us more` shows, M1) or a cursor outside it → `409 input-unreadable`;
   - a readable box with an unreadable draft → `409 draft-unreadable` with `reason` and `draft`; mode `bash` (Shell) → `409 shell-mode` with
     `draft`; its `sig` differs from `base` → `409 draft-changed` with `draft`; text whose cursor is not at its end (vim normal mode sits one
     to the left) → `409 cursor-not-at-end` with `draft`; an empty box while vim normal mode is the pane's edit mode → `409 vim-normal` with `draft`.
5. One paste per file, in the order of `ids`, each after a fresh look at the screen that must still read exactly what the sequence has built
   so far (spaces and line breaks ignored), in prompt mode, with no prompt (else `409 screen-changed`). The paste is the stored path as one
   bracketed paste (`keys.send { paste }`): an image path alone; any other file's path with **one leading space, also into an empty box** (0.5, final
   review; the box then never begins with `/`, which would be Claude's slash-command input; `claude-tui.md` §11). Then nika reads the box back every 150 ms: for an image up to 10 times (a large PNG needs a read), for a PDF or text file up to 4. An
   image must read as the text so far followed by `[Image #N]` (any N); another file as the text so far followed by its path. Nothing new after
   that → `409 not-taken` with `id` when the box is unchanged or still shows the path as text; any other difference or a prompt →
   `409 screen-changed`. When the box was empty at the start, its text must also **not begin with `/`** after the first paste and again after each later one
   (Claude did not keep the leading space): `409 screen-changed` with `pasted: n`, no `Enter`, and the box is left as it is. A draft the user typed before
   (even one that starts with `/`) is not judged by this check.
6. Right before the `Enter`: no interrupt (`not-idle`), one more fresh capture that shows no prompt, a plain box in prompt mode with **no ghost
   text** and exactly what was built (and, when the box was empty at the start, a text that does not begin with `/`) → else `409 screen-changed`.
7. Exactly one `Enter`, then the files are marked sent (they can no longer be looked up or deleted; pruning still ages them out).

Success: `200 { "sent": n, "images": k }` (files pasted, and how many of them were images). A key request that fails (`429 busy`, a tmux
error) answers that status and body plus `pasted`. An unexpected error is `500 { "error": "internal", "message": "internal error", "pasted": n }`
and is logged as `nika: attachments: <code>` only.

**Never sent** by this route: literal text, `Escape`, `C-u`, `BSpace`, `Tab`, `BTab`, a digit or an arrow. It **never clears** a box it pasted
into (it cannot read the pasted files back to be sure of what it would remove): after a refusal with `pasted` above 0 the page keeps the text
and the chips, says how many files went in and why it stopped, and tells the user to send or clear Claude's input in the terminal (Esc twice)
before sending again. A permission prompt that Claude opens after the `Enter`, for example "Do you want to read this file?", is the user's: it
shows in the existing prompt panel and nothing answers it.

**What the page does** (`public/attach.js`, `sendComposer` in `public/session.js`): chips for the files (six at most, 8 MB each, one upload
at a time, a 429 retried once after a second); Send needs every chip `ready` and refuses Shell, an unreadable Claude input and a message too
long for draft sync ("Send the text first, then the attachments"); it pushes the text with the normal draft write (a push that does not land
sends nothing), takes the `sig` of the screen, posts `{ ids, base }`, and on 200 clears the box and the chips and echoes
`Sent N attachment(s)[ and your message] to %7`. After a send that held a PDF or text file the page shows one notice per page load:
Claude may ask to read the file, which is in nika's attachments folder outside the project (`claude-tui.md` §11). On a refusal it keeps
everything and shows a fixed line for the code (a code the page does not know shows a generic one); a 404 marks the session gone; an
`attachment-gone` also marks that chip `Gone`.

### `POST /api/app/pane/:id/attachments/pick` and `GET /api/app/pane/:id/attachments/pick/:reqId` (0.5, W2)
The attachment button's file chooser. The page opens **no file input of its own** (the webview's freezes the app on macOS: wry runs a modal
open panel inside a WebKit callback): it asks the server, the server asks the desktop shell for its native dialog (`pick-files` / `files`,
§5), reads what the user picked itself and hands the bytes to the attachment store, and the page polls for the outcome. Paste and drop do
not use these routes (they upload through `POST …/attachments`). App tier only; the browser tier has neither route (`404`).

`POST` body (≤ 4 KB, `CAP.small`) is exactly `{ "room": n }`, an integer 1 to 6: the room left in the tray (6 minus its chips). Any other
body, key or value is `400 invalid` (a `room` over 6 or under 1 included). Order: body `400`, pane `404`, project `409`, then the picker.
- `202 { "reqId": "<UUID>" }`: the dialog was asked for. The id is a fresh UUID; the picker keeps the latest request only.
- `404 not_found`: the pane is not an eligible pane (§5, pane eligibility) · `409 no-project`: nika cannot tell the pane's project, the same
  rule and key as the upload.
- `429 busy`: a chooser of either kind (this one, or Add project's folder chooser) is already open; one dialog at a time, nothing is sent
  to the shell.

`GET` answers (`200`, `no-store`), by `state`:
```json
{ "state": "pending" }
{ "state": "cancelled" }
{ "state": "done", "files": [
  { "ok": true, "id": "<16 hex>", "name": "notes.md", "size": 2048, "type": "text" },
  { "ok": false, "name": "big.bin", "error": "too_large" } ] }
```
`pending` covers both the dialog being open and the server still reading the files. `cancelled`: the user closed the dialog, nothing usable was
picked, or the shell's answer was malformed. `done` lists the picked files **in the dialog's order, at most `room` of them** (the rest are
never opened), one entry each, and a failed entry never stops the next one:
- `ok: true`: the file is stored, exactly as an upload would have stored it; `id`, `size` and `type` (`png` · `jpeg` · `gif` · `webp` · `pdf` ·
  `text`) are the upload route's answer, and the id is used the same way (`DELETE …/attachments/:id`, `attach-send`).
- `ok: false`, `error` is one of the chooser's own codes or one of the store's: `invalid` (the path from the shell is not a string, is not
  absolute, is over 4096 characters or holds a NUL) · `secret-file` (the last part of the path is `.env`, `.env.*`, `.envrc`, `.envrc.*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.jks`,
  `*.keystore`, `*.ovpn`, `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`, `credentials` (exact base names) or an SSH private key by exact name, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk` or `id_ed25519_sk`, any case:
  refused by name before anything is opened) · `unreadable` (it could not be opened as a regular file you own with one link, with no
  following of a final symbolic link: a link, a folder, a FIFO, a hard-linked file, another owner's file, a file that is gone) · `too_large`
  (more than 8 MiB, decided from the size of the open file before any byte is read) · and the upload's codes `too-big`, `empty`,
  `wrong-type`, `path-unusable`, `folder-unsafe`, `tray-full` (0.5.4, AT: the pane's tray already holds 6 unsent files; the page never posts a `room` that is
  too big, so only a second page of the same session can hit it), `storage-full`, `disk-full`, `write-failed`, `busy` (another save was running, or 30
  saves in the last minute). An unexpected failure while reading or storing is `write-failed`.
- `name` is the last part of the path only, through `clean()` and at most 255 characters (`file` when nothing is left). **No answer, log or
  error ever holds a path, and nothing logs a name**; the store's own `nika: attachments: <code>` lines stay codes only.

`404 not_found` for a `reqId` that is not a UUID, is unknown, was replaced by a newer request, or was started for another pane (one
answer for all four). The `GET` is not eligibility-gated: the answer belongs to the request, and the pane may have gone while the dialog was
open. A `done` answer stays readable until the next chooser request replaces it. Methods other than `POST` / `GET` on these paths are `405`;
`DELETE …/attachments/pick` stays the delete route and answers `400 invalid` (`pick` is not an attachment id).

**What the page does** (`public/attach.js`): posts `{ room }` (a tray with no room never posts), disables the button with `aria-busy` while the
request is open, polls every 300 ms, and turns a `done` answer into chips that are already `ready` (type icon, size) or `failed` (the upload's
copy for the same code; `Can't read` for `unreadable` and `invalid`), without uploading anything. `429` shows "A file chooser is already open.
Finish or cancel it first."; any other refusal, a `404` on the poll or an answer it does not know ends the wait with a fixed line and nothing is
added.

### `POST /api/app/pane/:id/mode` (body ≤ 4 KB, `CAP.small`)
```json
{ "target": "plan" }
```
Success: `200 { "mode": "plan", "presses": 2 }`. In this route, answer and End a *fresh capture* skips the mirror's
100 ms cache, and one control action (mode switch, answer or End) runs per pane at a time. Checks and steps, in this
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

### `POST /api/app/pane/:id/dialog` (body ≤ 20 KB, `CAP.keys`)
Answers Claude's question dialog (`AskUserQuestion`) or plan approval (`ExitPlanMode`), **one step per request**, or declines it (0.5, W1;
ADR 0015, `docs/security.md` T37). The dialog is read from the screen only (the `dialog` field above); nika follows Claude's own tabs: the
current question, then (for a form with several) the next one under a new `sig`, then Claude's review. Since 0.5.1 (D) the same route also
moves Claude's dialog to another step without answering anything (`tab`, below), and an answered step can be answered again. Since 0.5.4 (QP) it also takes three bodies for a question step with a preview (Claude Code 2.1.328, `claude-tui.md` §13.10). Eight body shapes,
exact key sets (anything else is `400 invalid`, checked before the pane):
```json
{ "sig": "<16 hex>", "picks": [2], "text": "my own answer" }
{ "sig": "<16 hex>", "submit": true }
{ "sig": "<16 hex>", "choice": 2 }
{ "sig": "<16 hex>", "cancel": true }
{ "sig": "<16 hex>", "tab": 1 }
{ "sig": "<16 hex>", "focus": 2 }
{ "sig": "<16 hex>", "view": "<16 hex>", "picks": [2], "note": "my note" }
{ "sig": "<16 hex>", "chat": true }
```
- `picks` (with `text` optional): the current question. 0 to 7 distinct integers 1 to 7. `text`: 1 to 300 UTF-16 units, well formed, no control,
  bidi, zero-width, line-separator or other format character (`\p{Cf}`), no leading combining mark, no space at either end, **and not
  starting with 1 to 9** (the `invalid` message says so). A leading digit is refused as a precaution, because Claude may take it as the option
  shortcut on an empty text row (a live check found it typed as text). `submit: true` is the review's Submit. `choice` is an integer 1 to 9.
  `cancel: true` is Decline, for any step. `tab` (0.5.1, D) is an integer 0 to 8: the index of the step to move to, where the number of
  questions (`tabs.length`) is Claude's Review step. A body with `tab` moves, and does not answer; the rest of this section's answer rules
  do not apply to it (see "Moving to another step" below). The `invalid` message for a body of any other shape names all eight shapes. (The `{ sig, view, picks, note }` shape takes `note` optionally; `view` goes with `picks` alone, never with `text`.)
- A question step **with a preview** (0.5.4, QP; the capture's `dialog` has `preview`, `notes` and `focus`): a digit never answers there (Claude's digits only move its pointer), so none of the shapes above that need one is used. `focus` (an integer 1 to 7, an option of the step) moves Claude's pointer to that option and answers nothing. `{ view, picks: [n], note? }` answers the option the pointer is on: `view` is the capture's `preview.view` (16 lowercase hex characters) and goes with exactly one pick; `note` (optional, only with `view`) follows the rules of `text` above (1 to 300 UTF-16 units, no control, format or bidi character, no leading combining mark, no space at either end, not starting with 1 to 9). `chat: true` presses Claude's `Chat about this` and closes Claude's questions (below). The step takes no `text` (it has no text row), and no other step takes `focus`, `chat`, `view` or `note`: `400 invalid`, after the read, with the message `focus, chat, view and note are for a step with a preview`; a `picks` without `view` on a preview step is `400 invalid` too (`a step with a preview takes { focus }, { picks, view, note? }, { chat } or a Decline`), and so is a `focus` that is not one of the options or a `note` when the step already shows one (`this step already shows a note`; Claude keeps it and the answer carries none).
- Single-select: exactly one pick or one `text` (not both). Multi-select: at least one pick, or `text`; `text` only on the last tab. `picks`
  may not name a number beyond the options; `choice` must be a shown option and not the plan's free-text one; the shape must fit the step
  (`picks` the question, `submit` the review, `choice` the plan). These misfits are `400 invalid`, after the read.

**Read phase** (under the per-pane lock; nothing is sent before it ends; the first match decides):
1. Body invalid → `400 invalid`. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane
   (waits up to 5 s) → 409 `busy-switching`.
2. A fresh capture (never the cache); a failed capture → its own status and body.
3. No dialog on screen and no sign of one → 409 `no-dialog`. A screen with no readable footer and no input box that may hold a dialog nika cannot read
   (`Exit plan mode?`, the auto-mode nudge, an unknown overlay), or a dialog that is `unreadable` (a clipped option, a narrow pane, a cut step) → 409
   `dialog-unread` (0.5.4, QP, O3; before, both were a false `dialog-changed`, which now means only that the screen shows another readable step).
4. The body's shape does not fit the step's kind (`picks`, `focus` or `chat` need a question step, `submit` the review, `choice` a plan; `cancel` fits any) or
   the `sig` differs from the body's → 409 `dialog-changed`.
5. (0.5.4, QP) A preview-step rule of the list above broken (`focus`, `chat`, `view` or `note` on another step; `picks` without `view` on a preview step) → `400 invalid`.
6. Claude's notes field is open on the step (the capture's `notes.editing`: the footer reads `ctrl+g to edit in`) → 409 `notes-open`, a Decline included: nothing
   is sent, because what `Escape` does inside the field was never seen.
7. The body's `view` differs from the step's view as read now → 409 `preview-changed` (the preview rows, the hidden count, the focus or the note changed after
   the page looked).
8. The body has a `note` and the pane is not known to be plain, vim is known for it or INSERT shows → 409 `note-mode` (the text row's two roads to a vim pane
   do not exist in the notes field).
9. The same `sig` was answered on this pane in the last 3 s → 409 `already-answered`.
10. The step (a preview row and the note included) mentions bypass, or `text` or `note` does (any spelling, NFKC), and this is not a Decline → `400 terminal-only`.
11. The body does not fit the step (the misfits above) → `400 invalid`.
12. A `note` on a step that already shows a note → `400 invalid` (above). A `note` when Claude's open notes field would not fit the pane's width (its `Notes:`
    column plus 32 cells must stay under the width; the reader's own `noteRoom`, 0.5.4 QPF F2) → 409 `note-room`, nothing typed.

**Steps** (at most 24 rounds, a backstop that no consistent screen reaches). Each round: a fresh capture whose identity (the parsed step) must
equal the request's, else nothing more is sent (409 `no-dialog` | `dialog-unread` | `dialog-changed`, `400 terminal-only`); the screen the last key was proven on
must not have changed in the terminal since (focus → 409 `dialog-focus`; a box, the text, the INSERT marker or a preview step's note → 409 `dialog-touched`; Claude's notes
field open in the terminal, not opened by nika's own `n` → 409 `notes-open`); the
one key the screen calls for; a Stop or End interrupt running, or its `Escape` sent less than 40 ms ago → 409 `not-idle`; one
`keys.send` (a failure → its status and body); then a settle of up to 4 captures 150 ms apart for the state that key should leave (no match →
409 `not-taken`, or `no-dialog` | `dialog-unread` | `dialog-changed` when the last read shows that, or `text-mismatch` for typed text that does not read back).

| Step | The key the screen calls for | Refused (409, nothing more sent) |
|---|---|---|
| question, single-select, a pick | the digit as text (`send-keys -l`), focus on an option row. An answered tab (☒) is answered again the same way (0.5.1, D); text already in Claude's text row is left alone | `dialog-focus`: the focus is not on an option |
| question, single-select, `text` | `Down` to the text row, then the text (`-l`), then `Enter` once the row reads back exactly the text. If the row already holds exactly this text (answered before, or typed in the terminal): `Down` to the row and `Enter` only, nothing is typed again | `dialog-touched` (other text there); `dialog-focus`; `text-mode`: the focus is on the row and nothing shows vim INSERT or a known plain pane; `text-mismatch` |
| question, multi-select, picks | one digit per box that differs (smallest first; a digit toggles and leaves the focus), then `Right` from an option row | `dialog-focus` (the focus is not on an option row); `dialog-touched` (text in Claude's text row that is not this request's: a request without `text` carries none) |
| question, multi-select, `text` (last tab only) | the picks, `Down` to the text row, the text, `Down` to the button row, `Enter` there (it opens the review, it does not submit) | as above |
| review, `submit` | `Enter`, only with the focus on `1. Submit answers` | `dialog-focus` |
| plan, `choice` | the digit as text, with the focus not on the free-text option | `dialog-touched` (feedback typed in the free-text option); `dialog-focus` |
| `cancel` | `Escape`; in vim INSERT the first only leaves INSERT, and a second goes after 40 ms only once a fresh read shows INSERT gone | `dialog-focus` after two |
| preview step, `focus` | no key when Claude's pointer is already on the option (`200 { "done": "focused" }`); else `Down` or `Up`, one per round, toward the option (from `Chat about this`: `Up`, which lands on the last option); each is proven by the next read (same step, pointer on the next option); a budget of the distance in keys (from Chat: `k − focus + 1`) | `dialog-focus` (budget used up, or the pointer was moved in the terminal); `not-taken` |
| preview step, `{ view, picks: [n] }` | `Enter`, only with the pointer on option `n` (not on Chat) and the step's view equal to the request's `view`, compared again right before the key; it is proven by the strip alone (`moved`, as for any answer) | `dialog-focus` (the pointer is not on `n`, or is on Chat; nothing is moved for an answer: the page sends `focus` first); `preview-changed` |
| preview step, with `note` | `n` as literal text (opens Claude's notes field; proven by a read that shows the field open and empty, the same focus and the same preview rows), the note as one `send-keys -l` (proven by a read-back of the whole note with the focus unmoved), then `Enter` once the step's view equals the view nika computed for the step with this note typed. A note nika did not open itself is `notes-open` | `note-room`; `dialog-touched` (a note is already shown); `note-mismatch` (the note does not read back); `preview-changed`; `dialog-focus` |
| preview step, `chat` | `Down` until the pointer is on `Chat about this` (at most `k − focus + 1` keys), then `Enter` once; proven when no dialog, no permission prompt and no unknown screen is left | `dialog-focus`; `not-taken` |

Free text is typed only when INSERT shows, on a pane nika knows is plain (a probe `i` landed as text, the draft route), or when nika's own
`Down` just brought the focus onto the row and no INSERT came and vim is not known for the pane (vim enters INSERT on that row at once; plain
mode and vim NORMAL draw the same screen, so a request that starts on the row with no INSERT is `text-mode`).

**Answers.** `200 { "done": "next" | "review" | "submitted" | "chosen" | "declined" | "focused" | "chat", "sent": <keys> }`: `next` (another tab is current),
`review` (Claude shows its review), `submitted` (a final question or the review), `chosen` (a plan choice), `declined`, and since 0.5.4 (QP) `focused` (a `focus` request: Claude's
pointer is on the option, `sent` may be 0) and `chat` (a `chat` request: Claude's questions are closed, which nika proves by the dialog being gone). A `focus` request holds nothing;
the 3 s `already-answered` hold of a `sig` starts with every other verdict, `chat` included. Errors: `400`
`invalid`, `terminal-only`; `404 not_found`; `409` `busy-switching`, `no-dialog`, `dialog-unread`, `dialog-changed`, `already-answered`, `dialog-touched`,
`dialog-focus`, `text-mode`, `text-mismatch`, `not-taken`, `not-idle`, and (0.5.4, preview steps) `notes-open`, `preview-changed`, `note-mode`, `note-room`, `note-mismatch`; `429` and `5xx` from `keys.send` or the capture. **Every non-200
after the first key carries `sent`** (the keys already pressed). Nothing is undone: nika never types to clean up (a half-toggled multi
question, a moved focus and typed text stay as they are; the same request again resumes, the xor fixes the boxes).

**Re-answering an answered step (0.5.1, D).** Claude lets the user come back to a question that shows ☒ and answer it again; a pick
replaces the answer and Claude moves to the **next** step (not the next unanswered one, and to Review after the last question), so the
answers `next` and `review` hold. nika used to refuse such a step (`dialog-touched`, "the tab already shows ☒"); it now answers it like any other:
the same keys, under the same `sig`. What does not change: nika never edits text Claude's text row already holds. On a **single-select**
question a pick leaves that text alone (the pick replaces the answer; Claude keeps the text in the row but drops its tick). A `text` request
types nothing when the row already holds exactly that text: it goes `Down` to the row and presses `Enter` once, which answers with that text again.
Other text in the row is `dialog-touched` for a `text` request, and on a **multi-select** question for any request that does not carry that
same text (the page sends the typed text in every multi-select answer for this reason). The 3-second `already-answered` hold of a `sig`
is forgotten when a move succeeds, so a step the user went back to can be answered at once.

**Never sent by an answer:** `Left`, `Tab`, `BTab`, `Space`, `C-c`, `C-u`, `C-d`; `Up` (except by a `focus` request on a preview step, and by a move to another step, below); a digit while the text row has the
focus, and a digit as a key on a preview step (a note may hold digits, but never starts with one); anything on `Chat about this` except the `Down`s and the one `Enter` of a `chat` request on a preview step (and a `Chat about this` on any other step is never
answered); the letter `n`, except as the first key of a preview step's `note`; `Enter` except as listed; any key after the dialog closed; any key toward another tab (moving is its own body, next section). The
named-key allow-list is unchanged.

**Moving to another step (0.5.1, D; `{ sig, tab }`; `docs/security.md` T63).** The body names the step the dialog should show: `tab` is the
index of a question, or `tabs.length` for Claude's Review. The `sig` is the one the page read for the **current** step. Nothing is answered on
the way: a move sends no `Enter`, digit, `Escape`, `Tab`, `BTab` or text. It sends `Left` toward an earlier step and not `BTab`, because a
`BTab` that lands after the dialog closed would cycle the permission mode (T23). Under the per-pane lock (409 `busy-switching`). Facts of
Claude 2.1.326 it relies on (`claude-tui.md` §13.9): `Right` and `Left` move one step from an option row and do nothing on the text row, on
`Chat about this` or on a multi question's `Next` button; there is no wrap at either end; `Up` leaves an input row.

*Read phase, nothing sent* (the first match decides):
1. Body invalid (`tab` not an integer 0 to 8 included) → `400 invalid`. Ineligible pane → `404 not_found`. Lock → `409 busy-switching`.
2. A fresh capture; a failed one → its own status and body.
3. No dialog on screen → `409 no-dialog`; a screen that may hold a dialog nika cannot read, or an `unreadable` dialog → `409 dialog-unread` (0.5.4, QP, O3); a plan approval, or a
   `sig` that is not the body's → `409 dialog-changed`. Claude's notes field open on a preview step → `409 notes-open`, nothing sent. A dialog with fewer than two steps → `400 invalid` ("this dialog has one question").
4. Bypass on the dialog → `400 terminal-only` (checked before the `tab` value). `tab` above `tabs.length` → `400 invalid` ("tab is not one of
   the steps"); `tab` equal to the current step → `400 invalid` ("tab is the current step").

*Steps* (at most 24 rounds; a key budget of the distance plus 3). Each round starts with a **fresh** capture, read for the strip of tabs
only (`stripOf` in `src/dialog.js`, which does not need the options to be readable). It must still be readable as a strip (one nika cannot read while a dialog is on screen → 409 `dialog-unread`; none, the dialog closed → `dialog-changed`), show no open notes field (409 `notes-open`) and show the same tab headers (else 409
`dialog-changed`) and the same answered marks (else 409 `dialog-touched`), no bypass (400 `terminal-only`), and the step our last
`Right` or `Left` should have reached (else 409 `dialog-changed`: the user pressed a key too, or Claude redrew elsewhere). Then:
- the strip shows the asked step → `200 { "done": "moved" }`, plus `sent` (the keys pressed) when any went out;
- else, one key, never two in a round, and none while Stop's or End's `Escape` runs or went out less than 40 ms ago (409 `not-idle`):
  - on an **option row**: `Right` (toward a later step) or `Left` (toward an earlier one). It settles when the strip's step changed;
  - on an **input row** (Claude's text row, `Chat about this`, a multi question's `Next` button; the footer then also reads
    `ctrl+g to edit in <editor>`), where `Right` and `Left` do nothing or only move the text cursor: `Up`, which leaves it (one `Up`
    from the text row, two from `Chat about this`, three from `Next`), in plain mode and in vim INSERT and NORMAL alike. It settles when
    a full read of the same step shows another focus. At most 3 `Up`s, then 409 `text-focus`. An input row of a step **other** than
    the one the request started on → 409 `dialog-focus` (the person moved the focus in the terminal). nika presses no `Up` on a step it
    cannot read whole (409 `dialog-changed`), because it could not prove that the focus changed.
- on a step **with a preview** (0.5.4, QP; the footer carries `n to add notes`): Chat's focus draws no `ctrl+g`, so the strip cannot see it and the step is read whole; one nika cannot read whole → 409 `dialog-unread`.
  With the pointer on `Chat about this`: `Up` (it lands on the last option; at most 3 `Up`s, then 409 `text-focus`; Chat of another step than the request started on → `dialog-focus`), settled when a full read shows the same step with the pointer on the last option.
  On the option rows `Right` and `Left` switch steps as before;
- a key that did not change the step within the settle window (up to 4 captures 150 ms apart), the key budget used up or 24 rounds → 409
  `not-taken` (never repeated); the strip gone or unreadable at the settle read → 409 `dialog-changed`.

Answer: `200 { "done": "moved", "sent": <keys> }`. Errors: `400` `invalid`, `terminal-only`; `404 not_found`; `409` `busy-switching`,
`no-dialog`, `dialog-unread`, `dialog-changed`, `dialog-touched`, `dialog-focus`, `text-focus`, `notes-open`, `not-taken`, `not-idle`; `429` and `5xx` from the capture or
`keys.send`. **Every non-200 after the first key carries `sent`.** Nothing is undone: a move stops where it is. The page follows the
capture: it draws the step Claude now shows, under its own `sig`. Each key counts toward the keys route's 20 requests/s per pane.
Nothing of a body, a dialog string or a `sig` is logged. One action per pane at a time (the lock shared with mode, End, commands, answer, draft,
submit and fit steps); each key counts toward the keys route's 20 requests/s per pane.

**A step with a preview: Chat, notes and known limits (0.5.4, QP and QPF).** `chat` closes Claude's questions and cannot be undone; Claude's tool result then says the questions were declined, and answers already given may not reach Claude (live check, Claude Code 2.1.328; the page's button title says so). Known limits, none fixed in 0.5.4:
- *The focus moves while a note is typed.* If Claude's focus moves while a note is typed on the page (keys pressed in the terminal), the form follows it, and `Enter` in the note field answers the option now checked, with the note. The page text for the owner's answer: "If Claude's focus moves while you type a note, the form follows it; check the selected option before you press Enter." The route checks the `sig` and the `view` and answers exactly what the form shows, so nothing the page never showed is answered (pre-existing since QP).
- *A note that wraps.* A note that wraps onto a second `Notes:` row on a step whose preview is cut can make Claude hide one more preview line; nika then stops before `Enter` (409 `preview-changed`, `sent` 2) and the note stays in Claude's notes field, so every later request answers `notes-open`: finish in the terminal. `Escape` closes Claude's notes field and keeps the note (checked live, Claude Code 2.1.328); nika never sends it. No check can know the room Claude has below the dialog before the note is typed, so `note-room` only covers the width.
- *A plan on a narrow pane.* A plan approval is not read below about 109 columns (its footer's second row, the plan path, is wider than a narrower pane; a longer path raises the number) and not at 85 columns or fewer (Claude wraps the prompt row there): it is `unreadable` with reason `wide`, the grow does not run, and the page says to answer in the terminal.

**Other controls while a dialog shows** (`promptOpen`: a permission prompt, a question step, the review, a plan approval, `Exit plan mode?`
or the auto-mode nudge): Stop → 409 `prompt-open` (a screen with no mode line and no input box where nika recognises no dialog → 409 `screen-unclear`), nothing sent; End sends one
`Escape` first, as for a permission prompt, then the usual re-read (409 `not-idle` if the dialog is still there; on a screen with no mode line
and no input box where nika recognises no dialog, End sends nothing and answers 409 `mode-unknown`, see End step 2). End also refuses 409 `notes-open`, before any key and before the screen-unclear check, while Claude's notes field of a preview step is open (0.5.4, QP: an `Escape` there would land in the field; the footer alone decides, so it holds for a step nika cannot read whole too); the mode switch and the
commands → 409 `not-idle`; a draft write and a suggestion accept → 409 `not-idle`; `submit` → 409 `prompt-open`; the attachment send → 409
(its box read finds no plain box); the scroll route → 409 `screen-unclear`; the keys route and the page's passthrough are unchanged (the
bypass guard of T26); the permission `answer` route is unchanged and sees no prompt.

### `POST /api/app/pane/:id/survey` (body ≤ 4 KB, `CAP.small`)
```json
{ "n": 2, "sig": "<16 hex>" }
```
Answers Claude's feedback survey (0.5, F14; `docs/security.md` T58; rule 12 of `rules/project-rules.md`) with **one typed digit**. Exact key set `{ n, sig }`: `n` an integer 0–3,
`sig` 16 lowercase hex characters, from the capture's `survey` field (`ready`). App tier only: the browser tier has no such route. Nothing of the body (the digit, the `sig`)
is logged. The order: body, pane, then the controller.

1. Body invalid → `400 invalid`, checked before the pane. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane (mode, End,
   command, answer, draft, submit, dialog, fit steps) → `409 busy-switching`.
2. A Stop or End interrupt running on the pane, or its `Escape` sent less than 40 ms ago → `409 not-idle` (a digit right behind an `Escape` would be Meta+digit).
3. One fresh capture; its own failure passes through. A permission prompt or a dialog on screen → `409 prompt-open`.
4. `src/survey.js` on that capture (with the pane's vim memory): no survey → `409 no-survey`; `terminal / consent` or `bypass` → `400 terminal-only` ("answer this in the
   terminal"); `terminal / input` → `409 input-not-empty`; `terminal / normal` → `409 text-mode`; `terminal / unreadable` → `409 survey-changed`.
5. The `sig` is not the screen's → `409 survey-changed`. The same `sig` was answered on this pane in the last 3 s (a double click, or a second window) → `409 already-answered`,
   nothing sent. (`400 invalid` for an `n` that is not among the shown options exists in the controller and cannot fire for the rating, whose options are always 0–3.)
6. The registry state of the session, read fresh (the cache skipped), is not `idle` → `409 not-idle`. Claude itself takes the digit while it works (spike S-F14); the gate is
   stricter than Claude needs, as rule 12 says. An interrupt that began meanwhile → `409 not-idle`.
7. **One more fresh capture** (S1, 0.5: the fresh state read in step 6 runs a whole snapshot, not a few milliseconds, and nothing had looked at the screen since step 3). Its own
   failure passes through, like step 3's. `src/survey.js` on it (with the pane's vim memory) must be `ready` with the same `sig`; a prompt, a dialog, another survey, text in the
   box, anything else → `409 survey-changed`, nothing sent. An interrupt that began during it → `409 not-idle` (the last check before the key). One extra tmux capture per click.
8. **Exactly one key:** the digit as literal text through the controller's keys path (`send-keys -l -- <n>`; it counts toward the 20 requests/s per pane; a `429` or a tmux error
   passes through with its status and body). Never `Enter`, `Escape`, `C-u`, `BSpace` or any other key, and never a letter. Claude takes the digit after a pause of about 400 ms.
9. Read-back, at most 1 s (`SURVEY_READ_MS`, polls 150 ms apart): `200 { "answered": n }` as soon as a fresh capture shows **no survey at all** and a box that does not read
   exactly the digit. Otherwise `409 not-taken` with `sent: 1` (nika never removes the digit: it may still sit in Claude's input box; the page says so). A capture that fails
   after the key answers that status and body plus `sent: 1`. The `sig` is held for 3 s after any key that went out (so a second click is `already-answered`).

Statuses: `200`; `400` `invalid`, `terminal-only`; `404 not_found`; `409` `busy-switching`, `not-idle`, `prompt-open`, `no-survey`, `input-not-empty`, `text-mode`,
`survey-changed`, `already-answered`, `not-taken`; `429` and `5xx` from the key or the capture. **Every non-200 after the digit went out carries `sent: 1`.**

**The Escape hold (409 `survey-undo`).** After a rating **1 to 3** (not Dismiss, `0`) Claude shows `Feedback: <label> · Esc to undo` for about 3 s, and an `Escape` there takes the
rating back (`claude-tui.md` §10.13). For `SURVEY_UNDO_MS` = 4000 ms after such a digit went out, **no `Escape` of nika's own leaves the controller**: every one answers
`409 survey-undo` and is not sent. This covers Stop and End (each says so up front, before it starts, when it would have sent an `Escape`: a busy turn or a prompt or dialog on
screen), the commands' history-search `Escape`, the draft route's `Escape` (Send's clear of the box) and the dialog route's Decline; it is enforced in the controller's one key function, so a later
caller cannot forget it. The hold is set before the digit leaves; a digit that never went out puts back the hold it found. **The user's own keys are not held:** the keys route
and the page's passthrough still send `Escape` (it is Claude's own "Esc to undo"). The hold is memory only, per controller instance: an app-server restart forgets it
(`docs/security.md`, residual q). The page's line for it: spec §9.5.

### `POST /api/app/pane/:id/command` (body ≤ 4 KB, `CAP.small`)
```json
{ "text": "/compact" }
```
Types one slash command into Claude's input and presses Enter, safely; the quick actions (Compact, Clear, Model, and
Rewind, which sends `/rewind`) use it. `text` = `/` + a `COMMAND_NAME`, optionally one space and arguments, ≤ 200 chars, no C0/C1 controls, else
`400 invalid`. The composer's own Send is not this route: its text goes through the keys route or a draft write, and its `Enter` through
`POST /api/app/pane/:id/submit` since 0.5 (W13).

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
2. Fresh capture and registry state. A permission prompt or one of Claude's dialogs on screen (a question, the review, a plan
   approval, `Exit plan mode?`, the auto-mode nudge) → 409 `prompt-open` (Stop never answers a prompt; use the prompt buttons, or the
   dialog form's Decline). A screen with no mode line and no input box where nika recognises no dialog, but one may be open (a dialog
   with a subagent list under it that is not cut, or a plan clipped above its title) → 409 `screen-unclear`, nothing sent. The state is not a non-empty string other than `idle` (idle, no live session, two sessions
   on the pane) → 409 `not-busy`, nothing sent.
3. Interrupt. Without `-- INSERT --` on screen: one `Escape`. With `-- INSERT --` (Claude's vim insert mode; the first
   `Escape` only leaves it, `claude-tui.md` §5): send `Escape`, take fresh captures (up to 4, 150 ms apart) until
   `-- INSERT --` is gone (still shown → 409 `mode-unknown`, no second key), read the registry state again **uncached**
   (the server drops its 1 s eligibility snapshot first), and send a second `Escape` only if it is still busy. Another
   interrupt (a Stop, or End's) already running on the pane → 409 `stopping`, nothing sent. Within 4 s after the survey route rated 1 to 3, this step sends nothing and answers
   409 `survey-undo` (F14, see the survey route).
4. `200 { "stopped": true, "presses": 1 }` (or `2`). A failed capture or key send → its status and body.

### `POST /api/app/pane/:id/end` (body ≤ 4 KB, `CAP.small`)
Body `{}`. Steps, in this order:

1. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane → 409
   `busy-switching`.
2. Fresh capture and registry state. **Before everything else in this step (0.5.4, QP):** Claude's notes field open on a question step with a preview (`notesOpen` in `src/dialog.js`: the footer carries `n to add notes` and `ctrl+g to edit in`; it reads the footer only, so it holds for a step nika cannot read whole too) → 409 `notes-open`, nothing sent: an `Escape` there would land in the field. **Then, before any key (0.5.1, `docs/security.md` T64):** a screen with no readable mode line (footer
   `unknown`) and no input box that `src/draft.js` reads, when no permission prompt and no dialog that nika recognises (`promptOpen`) is on
   screen → 409 `mode-unknown`, nothing sent, whatever the registry says (busy, needs-you or idle) and without the `Escape` below. nika
   cannot tell such a screen from one where an `Escape` does harm: a subagent's view of the parent's pane, Claude's subagent list or the
   shells pill under the box (an `Escape` in a viewed subagent's input stops that subagent; spike S-AGENTS, Claude 2.1.326; the list itself is
   `claude-tui.md` §1), or a dialog that nika parks instead of reading (a wrapped ask footer or `Exit plan mode?` with a subagent list under
   it, a plan clipped above its title; an `Escape` would decline it). The page says "Claude's screen isn't at the prompt; use the
   terminal." A recognised permission prompt or dialog keeps its path below (`Escape` is the "No" path). Stop already refuses the same
   screens with 409 `screen-unclear`.

   After that check: a `prompt` or a dialog on screen (`promptOpen`, the route above): send `Escape` once (cancel, the "No" path; a dialog is declined). A registry state
   that is a non-empty string other than `idle` (busy): interrupt as the stop route above does (in vim insert mode two
   `Escape`s, the second only while the registry still says busy, read uncached; a Stop already interrupting the pane →
   409 `not-idle`, nothing sent). No state at all (no live session on the pane, or two
   claim it) with no prompt on screen → 409 `not-idle`, **no key sent**. Within 4 s after the survey route rated 1 to 3, a step that would send an `Escape` (a prompt or a
   dialog on screen, or a busy state) answers 409 `survey-undo` and sends nothing (0.5, F14; End with an idle state and no prompt sends no `Escape` and is not held). After an `Escape`: wait 1 s, then take a fresh
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
   (`CLAUDE_COMMAND`, after trimming) → `200 { "ended": true }`; else `200 { "ended": false }`. **A dead pane is gone (0.5):** with tmux's `remain-on-exit`
   the pane stays listed after `/exit` with its command still named claude (from its argv), so the check reads `pane_dead`: a pane with `pane_dead` `1`
   answers as no pane, and End reports `ended: true` at once. A live pane that still runs claude after the 3 s is still `ended: false`.

When any key send (or a capture) fails (for example 429) the sequence stops and the pane is checked once: gone or no longer
running claude → `{ "ended": true }`, else `{ "ended": false, "reason": "keys" }`. `reason` appears only here, never on
`ended: true`, never on the plain `ended: false` of step 7 (every key went out and Claude did not exit) and never on a 409:
the page says "nika couldn't send the keys; try again." for `"keys"` and "Claude didn't exit; use Stop or the terminal."
otherwise. Never `kill-pane`, never a signal. The eligibility cache is reset afterwards.

### `POST /api/app/spawn` (body ≤ 80 KB)
```json
{ "project": "<PROJECT_KEY>", "name": "<AGENT_NAME>", "model": "<MODEL_ID>", "brief": "<≤ 64 KB, more than one word>",
  "permissionMode": "<PERMISSION_MODES>?", "under": "<PANE_ID>?", "session": "<TMUX_SESSION>?", "rc": "off|<RC_PREFIX>?",
  "role": "agent|orchestrator?", "kind": "<KINDS>?", "parent": "<PANE_ID>?" }
```
A one-word `brief` (no whitespace once trimmed) → 400 `brief must be more than one word`: the brief is claude's positional
prompt after `--`, and a lone `update` or `doctor` could be read as a subcommand; `_run-agent` refuses a stored one-word
brief too (exit 3). `permissionMode` defaults to settings; `bypassPermissions` → 400. `rc` overrides the Remote Control setting for this
agent. `under`: split `-v` below that pane when both halves keep the placement floor (**Placement** below; unknown pane → 404, pane in
another session than `session` → 400, a pane whose tmux session name is not a `TMUX_SESSION` → `400 invalid` "That pane is in a tmux session nika
cannot target.", checked before any read or write; the response `session` is the pane's session). When that pane has no room, the setting places the
agent instead and the answer says `moved` (below). With neither `under` nor `session`, a spawn under a `parent` (see Nesting) opens beside that
parent, in the parent's own tmux session (read from the tags listing, and only when the name is a valid `TMUX_SESSION`), so an orchestrator
adopted from the user's own tmux session keeps its children with it; an explicit `under` or `session` always wins, and with no parent, or a
parent session name that is not valid, the project's session is used as before.

**No server or no project session (0.4).** When the session to use does not exist, because no tmux server runs or the server has no
session of that name, and it is the project's own (`TMUX_SESSION` reduction of its name, §8), the spawn creates it: one `new-session -d
-s <session> -n agents …` (§8) whose first pane runs the agent, tagged and titled like any spawned pane. There is no placement then
(the answer says `placement: "session"`; the rules of **Placement** apply only to a session that exists). A named `session` that is not the project's own and does not exist is
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
{ "pane": "%12", "session": "<tmux session>", "sessionId": "<UUID>", "kind": "coder", "placement": "beside", "moved": "under"?,
  "reports": { "dir": "<stateDir>/projects/<key>/reports",
  "session": "<name>.session", "report": "<name>.md", "rc": "<name>.rc", "remote": "<name>.remote" } }
```
`kind` (0.5, W9) is only in a spawn's answer: the word nika tagged on the agent's pane, or `null` for a sub-orchestrator. A spawn's `sessionId` is
`null` (only `_run-agent` knows the id); the UUID in the example is what Start and Resume answer.

**Placement (0.5.4, ADR 0021).** `placement` (a spawn's answer only, never Start or Resume) says where the pane went, one of `beside` (split
`-h` next to a pane), `under` (split `-v` below a pane), `tiled` (split into a window of agents only, then re-tiled), `window` (a new tmux
window named `agents`) or `session` (the project's session did not exist and was created with this pane). `moved: "under"` is present only
when the request's `under` pane had no room (or its session read could not be trusted) and the setting placed the agent instead. The
placement setting is `panePlacement` (`beside` or `under-last`, per project or from Settings). Before anything is written a spawn into a session
that exists reads that session once, `list-panes -s -t =<session>` with 15 constant fields (§8), and decides from tmux's own sizes and tags; a
failed listing is `502 tmux_failed` with nothing left behind. The first rule that fits wins:
1. `under`: split below that pane;
2. `under-last` (the setting): split below the pane `.last-pane` names, only inside the spawn's tree (below);
3. the home window: the parent's own window (the session's current window for "you" or a parent that is not listed). When it is a window of
   agents that is open to the spawn and has room, a split of its biggest pane followed by a re-tile; else a split `-h` of the widest agent pane
   of this project in it, else of the parent, else, for "you", of the window's active pane (each only while both halves keep the floor);
4. an agents window of this project that has room, the one with the fewest panes first, then the lowest index;
5. a new window: `new-window -d -t =<session>: -n agents …` (`-d` keeps the user's current window).

Every split must leave both halves at least 80 columns and 15 rows (`MIN_COLS`, `MIN_ROWS` in `src/place.js`), and a split into a window of agents
is made only when tmux's tiled grid for the new pane count keeps every pane at that size. A window is never a split target when tmux lists it as
zoomed, when `@nika-fit` is set on it, when its rows do not add up to `#{window_panes}`, when its rows disagree on the window's own fields or
name two active panes; a dead pane (`remain-on-exit`) is never split. A window of agents is a window whose every pane has `@nika-role` `agent`
or `sub-orchestrator` and an `@nika-agent` tag of this project; only that window is ever re-tiled (`select-layout -t @W tiled`, after a fresh
`list-panes -t @W` that must still show an agents window holding the new pane, and read once more afterwards, the result only logged).
Trees stay apart (0.5.4): a window is open to a spawn only when every pane in it is the spawn's parent or has `@nika-parent` exactly the parent's
pane id (for "you": a pane with no `@nika-parent`), and a window that holds a sub-orchestrator is open only to that sub-orchestrator's own agents;
a pane the `-a` read does not list, or whose tag is not exactly the parent's pane id, closes the window, and `under-last` follows the last
spawned pane only inside the same tree. The two reads are evidence, not trust: a line that does not parse or a pane id on two lines makes the
whole placement listing untrusted (no row is used, a new agents window opens, one line `nika: spawn placement: the session listing could not be
trusted, so a new agents window opened` goes to stderr), and a split goes only to a pane that nika's own `list-panes -a` read (the collector's, §8)
also lists in that session, where that read must have every field on every line and no pane id twice; otherwise a new window opens. A race
between the reads, or a tmux whose tiling differs from the model, can still leave a pane below the floor; the read-back after a re-tile only
logs it (`nika: spawn placement: a pane of the agents window is below 80x15`), and a re-tile that is skipped or fails (`…: the agents window
listing could not be trusted, so it was not re-tiled`, `…: the agents window changed, so it was not re-tiled`, `… failed (<step> <code>)`)
leaves the split's halves as they are. Nothing resizes, moves, swaps or kills a pane except that one re-tile. A spawn no longer gives a fitted
window back first: it never splits into one (the old `releaseWindow` call is gone; `docs/security.md` T65, T52). `nika spawn` prints
`placement: <word>` and, for `moved`, `note: that pane had no room, nika placed it by the setting`.

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
- **a parent whose `pane_dead` tmux did not print as `0` or `1` (0.5) → `409 depth`** ("<name> can't start agents right now: tmux did not say whether
  that session still runs. Nothing was started."; the page and the CLI alike, nothing split). Such a pane still counts toward both caps and the
  duplicate-name check (fail closed: it may be alive); only a pane known dead (`1`) is left out of the live set.
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

**Kind (0.5, W9).** `kind` is the label of the agent's row (spec §3.21); it is optional and display only. Checked in `parseRequest`, after the
`role` check and before anything else runs, so nothing is created on a 400 (no file, no tmux call):

| Input | Answer |
|---|---|
| `kind` absent | fine: nika derives one, below |
| `kind` not exactly one of `coder`, `reviewer`, `tester`, `designer`, `scout`, `writer`, `agent` (`"Coder"`, `"boss"`, `""`, `null`, `5`, `["coder"]`, `"coder "`) | `400 invalid` "invalid kind: use coder, reviewer, tester, designer, scout, writer or agent" |
| `kind` present with `role: "orchestrator"` (even a valid word) | `400 invalid` "kind is for agents: a sub-orchestrator always shows sub-orchestrator" |

The word to tag is decided once, at spawn: the request's `kind`, else the one the spawn's own `model` names among the project's role models
(`kindFromModel`: the project's effective models, its own override over Settings'; `builder` → `coder`, `reasoner` → `designer`, `scout` →
`scout`; the orchestrator's model names none). The comparison is exact on the model id, with no alias resolution (`sonnet` never equals
`claude-sonnet-5-5`); no role with that id, or two roles with different kinds on one id → `agent`. A sub-orchestrator has no kind (`null`). The
word is not stored in `<name>.agent.json` (its keys are unchanged) and never reaches claude. Because it is decided at spawn, a later `/model`
switch does not change it, and the snapshot cannot tell a chosen kind from a derived one.

The new pane is tagged (§8) with its role, `@nika-agent`, `@nika-depth` (1 to 3), with a parent `@nika-parent` and, for an agent, `@nika-kind`
(last; the word above).

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
- the lookup failing (index unreadable) → `503 index_unavailable`, nothing started, the pick kept;
- **the session registry unreadable (0.5, final review) → `503 index_unavailable`** ("nika couldn't check the saved orchestrator, so nothing was started"),
  nothing looked up, no pane, no claude, the pick kept. The pick reads live only through the registry, so without it a live orchestrator would read
  `ended` and be resumed in a second claude. It is asked first and only **while a pick is saved**, from a fresh snapshot (`sources.registry === 'ok'`;
  a snapshot that cannot be taken, or has none, counts as not readable); a start without a saved pick needs no registry and runs. **The CLI follows it:**
  `nika orchestrate` with a saved pick asks `readRegistry` alone (the same question, without ps, tmux or the index) and refuses the same way, exit 1
  (the CLI maps every 5xx to 1), with no tmux command at all and the pick kept. A sessions folder that is missing or unreadable is such a case in both tiers.

A new start saves its own `--session-id` as the project's pick, so Resume is offered after it ends.

**Early exit (0.4).** After the pane is created and tagged, Start and Resume wait 1 s and ask tmux whether the pane still exists and is
not dead (§8; the same check as spawn, one helper, the wait injectable for tests). Gone or dead → `502 claude_exited` (message under
`POST /api/app/spawn`): nothing is saved (a fresh start's pick is not written, a resumed pick stays) and the request is not retried. When
Start resumed a session, the body also carries `"resume": "<session id>"` and the message is "Claude exited right after it started. Run
`claude --resume <session id>` in a terminal in this folder to see why." (a plain `claude` would start a fresh session); the page shows
that sentence when `resume` is a session id, else the plain one. The
pane is tagged before the wait, so a second Start during it finds this orchestrator instead of opening another window; that second Start
answers `200 created: false` with a pane that may still fail the check a moment later. A tmux error or timeout on the check counts as gone (as for
spawn). A pane that is dead (remain-on-exit) is never taken for the orchestrator, and neither is a pane whose `pane_dead` is not exactly `0`. **A listing that fails (0.5).** Start reads the tmux panes of every session before it opens anything (§8, find orchestrator pane). Only tmux's "no server running" answer (`NO_TMUX_SERVER` in `src/tmuxerr.js`, as spawn reads it) means there is no orchestrator; any other failure of that listing (a permission error, a protocol mismatch, a server that exited) is `502 tmux_failed` (`503 tmux_unavailable` when the tmux program is missing) with no window, no session, no keys and nothing saved, because an orchestrator that runs could not be seen and a second one must not open on top of it. The page shows the
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
| server → shell | `pick-files` | `{"type":"pick-files","reqId":"<UUID>"}` — the attachment button's file dialog (0.5, W2); it names no room, type or folder |
| shell → server | `files` | `{"type":"files","reqId":"<UUID>","paths":["<abs file>", …] \| null}` — `null` = cancelled or nothing usable. The shell sends only absolute paths of existing regular files (a link to a file passes; the server refuses it), valid UTF-8, at most 6. The server ignores the message unless it answers the open `pick-files` request (`pending` only; a second answer, another id, or a `files` for a folder request changes nothing), takes at most the request's `room` entries, and opens every path itself (`openRegular`: `O_NOFOLLOW`, a regular file, owned by you, one link, at most 8 MiB) before it reads a byte; a path never reaches the page, a log or a request |
| server → shell | `window` | `{"type":"window","action":"quit"\|"close"\|"minimize"\|"zoom-in"\|"zoom-out"\|"zoom-reset"}` — one line per `POST /api/app/window` (§3); the line names no window, so which window it applies to is the shell's decision; the shell answers nothing. Not a command from the shell: a `window` line on stdin is ignored |
| server → shell | `error` | `{"type":"error","message":"<clean()>"}` before a non-zero exit (bad `hello`, port in use) |

Limits: one open dialog at a time, `pick-folder` or `pick-files` (they share one slot, on the server and in the shell: a second request of either kind is refused by the server with `429 busy`, and answered at once with `null` by the shell if one slips through); `status` fields are integers ≥ 0; names are `clean()`ed; `attention` = live
agents whose registry status is neither busy, shell nor idle (e.g. waiting on a permission prompt; `shell` counts as busy); `projects[].key` is
`keyFor(repo root)`, never a path. Pane eligibility (§3 capture/keys): a registry pane qualifies only while its
`pane_current_command` is claude-like (`CLAUDE_COMMAND` in `src/ids.js`), because `tmuxPane` is agent-writable; a pane
nika started qualifies only while its command is claude-like too, because tmux can reuse a pane id after a restart
(a spawned agent's pane runs `_run-agent` as `node`); and since 0.5 neither kind qualifies while its pane is dead (`#{pane_dead}`). This is a safety net for the user, not a boundary against agents: a same-user agent able to forge the registry can already
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
| `…/nika/fit/fit-<nonce>.json` | 0700 / 0600 | the fit's lease (0.5, W7): exactly the keys `v nonce window pane panes zoomed0 active0 width0 height0 size0 layout0 layout1 cols rows resized userZoom at` (F4, F9: `sized`, `awayAt`, `focus`, `viewed`, the take counts and the `terminal` state are memory only and never in the file), written by `writeAtomic` before the first tmux change and after each resize, removed by `removeOwnFile` on release; `<nonce>` is 16 hex (`FIT_NONCE`); at most 20 files are read back at the app tier's start (when more match, `nika: fit recover read 20 of N lease files` is logged, counts only and never names; the rest stay on disk), each ≤ 16 KB through `fsafe`, every field shape-checked, and a file that does not parse is removed; a symlinked `fit/` folder is not followed |
| `…/nika/attachments/<key>/<id>.<ext>` | 0700 / 0600 | the files of the session window's attachments (0.5, W2; ADR 0016): `<key>` is the pane's `PROJECT_KEY` from nika's own snapshot, `<id>` 16 random hex, `<ext>` `png` `jpg` `gif` `webp` `pdf` or, for a text file, an extension from a fixed list (`txt` when the name's is not on it); the user's file name is never stored. Written by `writeAtomic` (0600) after the bytes were sniffed (type from the magic bytes, never from the name), removed by `removeOwnFile`. The root and each key folder must be real folders you own (`ensureDir`; a link or a foreign owner is `409 folder-unsafe`). The whole path must match `^/[A-Za-z0-9._/+-]{1,200}$` (`409 path-unusable` otherwise: it is pasted into Claude as one token). Pruned at start, every 24 h and before each save: a file older than `attachments.keepDays`, a left-over temp file older than 1 h, then the oldest first while the store holds more than 256 MiB or 500 files in all (a file younger than 1 h is never evicted: the next save refuses with `507 storage-full` instead), and an empty key folder; only names nika writes, in real folders you own, as regular single-link files you own. Unsent files also go at once on `DELETE …/attachments/:id` |

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
  "compaction": { "enabled": true, "pct": 80, "window": 400000 },
  "attachments": { "keepDays": 7 },
  "fit": { "mode": "auto" }
}
```
`ui.theme` ∈ `system light dark` (default `system` = follow `prefers-color-scheme`). `ui.singleKeyShortcuts` boolean
(default `true`; a missing or non-boolean value reads as the default): whether `?` opens Keyboard shortcuts (design spec
§4.6). Mod+/ always does. `compaction` (0.4): `enabled` boolean, `pct` an integer 20–95, `window` one of `200000`,
`400000`, `1000000`, `"model"`; a bad leaf falls back to its default with a warning (`compaction.pct invalid, default used`).
`attachments.keepDays` (0.5, W2) an integer 1–30, default 7 (`attachments.keepDays invalid, default used`). `fit.mode` (0.5.4, P2) one of `auto`, `fill`, `terminal`, `off`, default `auto` (`fit.mode invalid, default used`).
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
| `nika status [--json] [--since w] [--ended] [--full]` | 0.4.0: ended rows only with `--ended` (the latest 5 per project) or `--full` (all, implies `--ended`); otherwise one line says how many are hidden. Every project added to nika is listed, also one with no session in the window (`<name>  <folder>   no sessions yet` for `--since all`, else `no sessions in the last <window>`); a folder never added shows only while a session runs there, or with `--ended`. The project list is read in every text view (a `config.json` nika cannot use gives a `note:` line and no empty projects). `--json` is unchanged (the snapshot only) and carries every agent. 0.5.4 (RM): rows the user removed in the app (§3 "Removed items") are left out here too, and one last line says `… N removed from the list (Show removed in the nika app)`; `--json` carries the counts (`hidden`). 0.5.4 (P1): a row's pane shows as `<window index>:<pane id>` when the index is known |
| `nika spawn <name> <model> <brief> [--project dir] [--permission-mode m] [--rc prefix\|off] [--role agent\|orchestrator] [--kind <kind>] [--under %pane] [--session name]` | spawn an agent in tmux (needs `$TMUX` or `--session`); `brief` is a file path or `-` for stdin. 0.4: `--role orchestrator` starts a sub-orchestrator (only the main orchestrator's pane may; else exit 3, `depth`). The parent is the pane it runs in, `$TMUX_PANE`, when that is a pane id (else none); there is no `--parent` option, and a `$TMUX_PANE` that tmux no longer lists is "no parent". The server reads that pane's role and depth from tmux's tags. 0.5 (W9): `--kind coder\|reviewer\|tester\|designer\|scout\|writer\|agent` is the label on the agent's row (§3, spawn "Kind"); anything else is exit 2 (`--kind must be one of coder, reviewer, tester, designer, scout, writer, agent`), and so is `--kind` with `--role orchestrator` (`--kind is for agents: a sub-orchestrator always shows sub-orchestrator`), before anything runs; without it nika picks one from the model's role. The output gains a `kind: <word>` line after `session:` when the answer carries a kind (an agent; a sub-orchestrator has none, so no line). Its help line reads `--kind <kind>      coder \| reviewer \| tester \| designer \| scout \| writer \| agent: the label on its row (default: from the model's role)`. 0.5.4 (P1): the output has a `placement: <word>` line (`beside`, `under`, `tiled`, `window` or `session`, §3 spawn "Placement") and, when an explicit `--under` pane had no room, `note: that pane had no room, nika placed it by the setting` |
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
| list panes | `tmux -u list-panes -a -F #{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{pane_dead}\t#{@nika-kind}` (0.1; the tags 0.2 and 0.4; each tag is read strictly, a value that does not parse is absent, and the tags of a pane with no nika role are ignored; `pane_dead` last, 0.5: `0` running, `1` dead and kept by `remain-on-exit` (the pane stays in the listing, marked dead, and the eligibility check refuses it), anything else drops the row; `@nika-kind` last, 0.5 W9: the field is free text, so it comes after every other and a tab in a forged value cannot shift one; it counts only beside `@nika-role` `agent` and only as exactly one of the seven words of `KINDS`, else the pane has no kind; a line without the field parses with no kind. This is the only listing that reads it: the spawn's tag listing, Start's listing and the fit's do not) |
| session exists | `tmux -u has-session -t =<session>` |
| create session + orchestrator | `tmux -u new-session -d -s <session> -n orchestrator -c <projectDir> -x 200 -y 50 -P -F #{pane_id} [-e CLAUDE_CODE_AUTO_COMPACT_WINDOW=<W> [-e CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<PCT>]] -- <claudeBin> <orchestrator flags>` |
| remove the pair from the session environment (0.4) | `tmux -u set-environment -t =<session> -u CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then the same for `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: only after a `new-session` that carried `-e`, only for a name it sent; best effort (a failure is ignored) |
| create session + first agent (0.4) | `tmux -u new-session -d -s <session> -n agents -c <projectDir> -x 200 -y 50 -P -F #{pane_id} -- <nikaBin…> _run-agent <key> <name>`: a spawn when the project's session does not exist (no server, or a server without it); no `-e` pair (an agent's compaction travels in `<name>.agent.json`, so nothing is added to the session environment); the pane is tagged as a split-window one |
| early-exit check (0.4) | `tmux -u display-message -p -t %n #{pane_dead}` 1 s after Start, Resume or spawn created pane `%n`: `0` = running; `1`, a tmux error (pane or server gone) or anything else = `502 claude_exited`. A constant format and a pane id nika got from tmux and matched against `PANE_ID`; no request data |
| orchestrator in existing session | `tmux -u new-window -t =<session>: -n orchestrator -c <projectDir> -P -F #{pane_id} [-e … as above] -- <claudeBin> <orchestrator flags>` |
| tag a pane nika created | `tmux -u set-option -p -t %n @nika-role orchestrator` (after new-session / new-window), `… @nika-role agent` or (0.4) `… @nika-role sub-orchestrator` (after split-window), then `@nika-agent <PROJECT_KEY>/<AGENT_NAME>` (0.4: `<PROJECT_KEY>/orchestrator` for an orchestrator), `@nika-depth <1\|2\|3>` (an orchestrator 1) and, for a nested spawn, `@nika-parent <PANE_ID>`, then (0.5, W9), on an agent pane only (never an orchestrator or a sub-orchestrator), `@nika-kind <word>` as the last call, the word being one of the seven constants of `KINDS` (checked again in `tagPane`, so no other text from a request reaches tmux): `tmux -u set-option -p -t %n @nika-kind <word>`; every value is a constant, a validated name or a pane id (no `#`); best effort (a failed `@nika-kind` call leaves the row on `agent`) |
| adopt a live session as orchestrator (0.4) | `tmux -u set-option -p -t %n @nika-role orchestrator`, then `@nika-agent <PROJECT_KEY>/orchestrator`, then `@nika-depth 1` (`PUT …/orchestrator`; the depth is a constant 1, 2 or 3, never request data) |
| resume the orchestrator (0.4) | the orchestrator argv above (the same `-e` pairs) with `--resume <UUID>` instead of `--session-id <UUID>`; the UUID is the stored pick |
| tags of a spawn | `tmux -u list-panes -a -F #{pane_id}\t#{pane_dead}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{session_name}\t#{window_name}` (one fresh listing per spawn; the names are last because they are free text; a pane with `pane_dead` `1`, one that remain-on-exit keeps after claude exited, is skipped, so it is never live, never counts toward a cap or the duplicate-name check and is never a parent: a dead parent reads like a gone one) → (1) the requested parent's role and depth (`POST /spawn`, "Nesting"), and (2) the live set: the panes with `@nika-role` = `agent` or `sub-orchestrator` whose `@nika-agent` is `<key>/<name>` for the project's key, for the duplicate-name check and the two caps. A tag is parsed strictly (exactly one `/`, `PROJECT_KEY` before it, `AGENT_NAME` after it; a depth is exactly `1`, `2` or `3`; a parent is a `PANE_ID`); anything else is agent-writable noise and is ignored, never trusted |
| find orchestrator pane | `tmux -u list-panes -a -F #{pane_id}\t#{pane_current_command}\t#{pane_dead}\t#{@nika-role}\t#{@nika-agent}\t#{session_name}\t#{window_name}` (`-a` = every session, 0.4; only tmux's "no server running" answer (`NO_TMUX_SERVER`) means none, any other listing failure is `502 tmux_failed` and nothing is started (0.5); a pane whose `pane_dead` is not exactly `0` is skipped: `1` is remain-on-exit keeping a dead pane with its tags and a claude-like command, and any other value is unreadable) → the pane with `@nika-role` = `orchestrator` whose command is claude (`claude`, `node` or a version string) and which is the project's main one: tagged `<key>/orchestrator` in any session, or a 0.3 pane with no `@nika-agent` tag in the project's session, window named exactly `orchestrator`. One in the window named `orchestrator` of the project's session wins, else a tagged pane in any other window or session; agent and sub-orchestrator panes, and a tag of another project, never match |
| placement: read the session (0.5.4, ADR 0021) | `tmux -u list-panes -s -t =<session> -F #{pane_id}\t#{window_id}\t#{window_index}\t#{window_active}\t#{window_panes}\t#{window_zoomed_flag}\t#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{pane_active}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-fit}` (`PLACE_FORMAT` in `src/place.js`: exactly 15 fields; the tags a user or an agent can write come last; one call per spawn into a session that exists, before any file is written; the text is read as one piece of evidence, see §3 "Placement"; `@nika-fit` is read as set or not, its value is never used) |
| spawn beside / under / tiled | `tmux -u split-window -h\|-v -t %n -c <projectDir> -P -F #{pane_id} -- <nikaBin…> _run-agent <key> <name>`: `%n` is a pane of that listing (`PANE_ID`) that nika's own `list-panes -a` read also lists in the same session; `-h` for `beside`, `-v` for `under` and for a split below a named pane in a window of agents; for the other `tiled` splits `-h` when the biggest pane is at least twice as wide as high, else `-v`; the old `-t =<session>:` target is gone |
| spawn in a new window (0.5.4) | `tmux -u new-window -d -t =<session>: -n agents -c <projectDir> -P -F #{pane_id} -- <nikaBin…> _run-agent <key> <name>` (`-d` keeps the user's current window; `agents` is a constant without `#`; `<projectDir>` through `tmuxLiteral`); the pane is tagged as a split-window one |
| re-tile a window of agents (0.5.4) | `tmux -u list-panes -t @W -F <PLACE_FORMAT>` right before and once after, and `tmux -u select-layout -t @W tiled` between them: only on a window `@W` (`WINDOW_ID`, from tmux's listing) whose every pane is this project's `agent` or `sub-orchestrator`, whose rows add up to `#{window_panes}`, that is not zoomed and has no `@nika-fit`, and that holds the new pane; the second listing is only logged. No other placement call resizes, moves, swaps or kills a pane |
| pane title | `tmux -u select-pane -t %n -T [%n] <name>` |
| capture | `tmux -u capture-pane -p -e -N -t %n` (the visible rows only: nika reads no tmux scrollback of a pane, W3, ADR 0018) |
| pane size + cursor | `tmux -u display-message -p -t %n -F #{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{alternate_on}` (0.5, W3: the sixth field is the capture's `alt`; run together with the capture, in the same `Promise.all`) |
| send text | `tmux -u send-keys -t %n -l -- <text>` (0.5: one call per chunk of at most 700 characters, 300 ms apart; the draft write and the keys route both chunk) |
| send paste | `tmux -u load-buffer -b nika-<16 hex> -` (paste bytes on stdin; argv over ~16 KB fails with "command too long") then `tmux -u paste-buffer -p -d -b nika-<16 hex> -t %n`; on a paste failure `delete-buffer -b nika-<hex>` |
| send key | `tmux -u send-keys -t %n -- <KEY_NAME>` |
| focus | `tmux -u switch-client -t %n` / `select-window -t %n` / `select-pane -t %n` (0.1) |
| fit: read all panes (0.5) | `tmux -u list-panes -a -F #{pane_id}\t#{window_id}\t#{window_panes}\t#{window_zoomed_flag}\t#{pane_active}\t#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}\t#{@nika-fit}\t#{@nika-role}\t#{window_active_clients}` (one call; the watch's only read; exactly 13 fields (0.5, F2: the 12th is the pane's role, kept as exact text and compared only with `agent` and `sub-orchestrator`; 0.5, F4: the 13th is the window's client count, digits 0–9999, compared only with 0, every kind of client counted), every field parsed strictly, a row that does not parse is dropped, a tag that is not 16 hex reads as foreign) |
| fit: layout | `tmux -u display-message -p -t @W -F #{window_layout}` (one line; kept only when it is printable ASCII, 1–8192 characters, no `#`) |
| fit: window-size option | `tmux -u show-options -w -t @W window-size` → empty (unset) or `window-size <latest\|largest\|smallest\|manual>`; anything else is `blocked / size-option` |
| fit: tag the window | `tmux -u set-option -w -t @W @nika-fit <nonce>` (16 hex from `crypto.randomBytes(8)`; a value, not a format) |
| fit: zoom or unzoom | `tmux -u resize-pane -Z -t %P` (a toggle on the window: run only after the zoom flag and the active pane were read) |
| fit: size | `tmux -u resize-window -t @W -x <C> -y <R>` (digits, 1–10000; the panel's 40–400 × 10–200 or the window's saved size; also the one change of a take and of a give, 0.5 F9: no new argv shape) |
| fit: window-size back | `tmux -u set-option -wu -t @W window-size` (it was unset) or `tmux -u set-option -w -t @W window-size <latest\|largest\|smallest\|manual>` (its saved value); also the second change of a give (0.5, F9) |
| fit: layout back | `tmux -u select-layout -t @W -- <layout>` (the saved layout with the 3.8 `,"a":…` and `,"l":…` markers removed, so focus does not move; only when the layout is still the one nika left; also, 0.5 F15, the give of a squeezed window: the layout read inside the lock right before the squeeze, from tmux's own output, never from a request; no new argv shape) |
| fit: focus back | `tmux -u select-pane -t %A` (the pane that was active before the zoom; also in the restore of a refit after an agent pane exits, not after a split) |
| fit: untag | `tmux -u set-option -wu -t @W @nika-fit` (only in a release that read the tag back as nika's nonce) |

The fit's `@W` is a window id (`WINDOW_ID`, `^@\d{1,6}$`) and `%P`, `%A` are pane ids (`PANE_ID`), all read from tmux's own listing in the
same call and never from a request; the request supplies only `<C>` and `<R>` as integers checked at the route (and again in
`src/fit.js`, whose argv builders refuse anything else). `set-option` values are literal, `-x` and `-y` are digits, and every `-F`
string is a constant, so no `#` reaches a format-expanded argument. `test/fit.test.js` runs the controller against a fake tmux that
fails on any argv outside this table.

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
  Claude Code's rule is `min(floor((W - 20000) x PCT / 100), W - 33000)` (20000 reserved output, 13000 summary buffer). nika sets both variables on every launch, so
  the window is always explicit; an unset window is not "off" in Claude Code 2.1.328, which then compacts from a default window (about 980k effective on a 1M model), so a
  PCT alone would apply to that default (ADR 0014, amendment 2026-11-19; only the `auto` source turns proactive compaction off). Examples (`W`, `P` → PCT, compacts at): 200k, 80 → 88.8889, 160k; 200k, 95 → 100, 167k;
  1M, 80 → 81.6327, 800k; 400k on a 1M model, 80 → 84.2106, 320k; 400k, 95 → 100, 367k. The orchestrator gets them as the two tmux `-e`
  pairs (§8); an agent or sub-orchestrator through the `env` option of the `spawn()` that starts claude (no shell). With the variables
  set, `/autocompact` inside the session is locked to the environment (spike S2).
- `_run-agent <key> <name>` reads `<reportsDir>/<name>.brief.md` (0600, written by `spawn` before `split-window`,
  read through `fsafe`; the brief never passes through tmux argv, but it is claude's own argv, see below), writes `<name>.session` (the UUID), `<name>.remote`
  (the RC name or empty) and `<name>.pane`, then runs `claude --session-id <UUID> --model <model> [--permission-mode <m>] -n <name>
  [--remote-control=<prefix>-<name>] --append-system-prompt <templates/guard-prompt.txt
  rendered with name, report path> --settings <settings JSON> --disallowedTools Bash(nika:*) Bash(tmux:*)
  Bash(claude:*) "Bash(git add:*)" "Bash(git commit:*)" "Bash(git push:*)" -- <brief>` with inherited stdio, writes
  claude's exit code to `<name>.rc` and exits with it. `_run-agent` refuses (exit 3) a brief that is empty, contains NUL
  or is a single word. The brief, the guard prompt and the deny settings are claude's argv, so any local process can
  read them with `ps` (single-user assumption, `docs/security.md` residual risk a); that includes the reports dir in the settings JSON. RC names match `RC_NAME`. `--disallowedTools` is variadic, so it is always followed by `--`. Settings JSON (`agentSettings`):
  `{"permissions":{"deny":["Read(**/.env*)","Edit(**/.env*)","Read(**/*.key)","Edit(**/*.key)"],"additionalDirectories":["<reportsDir>"]}}` (T3, T4).
  The reports dir goes there, not through `--add-dir` (0.5, F18): Claude Code 2.1.326 asks to trust an `--add-dir` folder each time claude
  starts, and "No, exit", Esc or a stray Enter ends the agent (`claude-tui.md` §16). The deny
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
| `src/collect/history.js` | `readHistory(sessionId, { before, limit }, { claudeDir, cache }) → { status, body }` (an `Agent` / `Task` call entry may carry `subagent`); `readSubagentHistory(sessionId, agentId, { before, limit }, { claudeDir, cache }) → { status, body }` (0.5, W8: the same page from `agent-<agentId>.jsonl`; `appio.js` passes both in `deps`); both read through one module-level limiter (4 reads in flight; `createLimiter(max)` lives in `src/limiter.js` since 0.5.4, a leaf module the attachment store shares) |
| `src/collect/subagents.js` | (0.5, W8) every function takes the transcript index entry `{ path, dir, … }`, never a request value: `subagentDir(transcript) → string \| null` (`<dir>/<session>/subagents`, only when both folders are real directories); `subagentTranscripts(transcript) → Map<agentId, path>` (the folder's listing: names `agent-<SUBAGENT_ID>.jsonl`, the path built from the listed name; empty when the folder is missing or not real); `readSubagents(transcript) → [{ id, type, description, model, toolUseId, finished, lastActivity }]` (the metas, ≤ 64 KB each, 8 at a time, read again on every call; `toolUseId` a valid id or `null`; `model` falls back to `pickedEffortModel`). `src/model.js` maps these into the snapshot's `subagents` one field at a time, so `toolUseId` never reaches a response |
| `src/collect/plugins.js` | `listPlugins(claudeDir) → string[]` (keys of `plugins` in `<claudeDir>/plugins/installed_plugins.json`, read through `fsafe` ≤ 1 MB; sorted, ≤ 200, each `PLUGIN_NAME`; `[]` when missing or invalid) |
| `src/mirror.js` | `parseCapture(text, cols) → rows` (pure); `createMirror({ exec, tmuxBin, now }) → { capture(pane, ifNoneMatch) → { status, body, etag } }` |
| `src/keys.js` | `createKeys({ exec, tmuxBin, now, sleep }) → { send(pane, { text, paste, keys, send? }, { recheck? }) → { status, body } }`; `recheck()` is an async `null \| { status, body }` run before each text chunk after the first (the route passes it for `send: true`); `badSend(body)` is the 400 for a `send` that is not `true` |
| `src/attachments.js` | `createAttachments({ env, now, loadKeepDays, setTimer, clearTimer, log }) → { save({ pane, key, name, data }), saveBytes({ pane, key, name, bytes }), lookup(pane, id), remove(pane, id), markSent(ids), prune({ need }), start(), stop() }`: `save`, `saveBytes` resolve `{ status, body }` (`save` is the upload route's, `saveBytes` the file chooser's: the same admission, sniff, caps and write); `lookup` → `{ id, path, type, size }` or `null`; `remove` → boolean; `start()` prunes at once and every 24 h (the timer is unref'd). Pure helpers `sniff(buf, name)`, `checkUploadBody(body)` and `isSecretName(name)`; constants `UPLOAD_CAP`, `MAX_BYTES`, `PER_MESSAGE`, `TRAYS_MAX`, `KEPT_CAP`, `ID`, `PATH_OK`. 0.5.4 (AT, LT), the tray store: `bindTray(pane, claim)` (binds the pane's tray to the project key and the Claude, dropping one of another owner), `listTray(pane, claim)` → `{ files, gone }`, `hasTray(pane)`, `keepText(pane, claim, { text, shell })`, `readText(pane, claim)`, `hasText(pane)`, `dropPanes(isGone)` (the pane sweep of the status timer), `readImage(pane, id)`; pure `checkKeptBody(body)` and `keptTextOk(text)`. The trays are memory only (6 unsent files and one kept text per pane, 64 trays) The records of issued ids live in memory only (the 500 newest): after a restart an old id is `attachment-gone` |
| `src/attach-send.js` | `createAttachSend({ mirror, keys, store, lock, keyGap, vimOf, plainOf, sleep, log }) → { send(pane, { ids, base }) → { status, body } }` and `checkAttachBody(body)` (the 400 shape check shared with the route); `lock` and `keyGap` are the session controller's `withPaneLock` and `keyGap` |
| `src/dialog.js` | pure: `dialogOnScreen(rows)`, `readDialogScreen(rows, cols) → null \| { unreadable, kind } \| S`, `identityOf(S)`, `sigOf(S)`, `otherAllowed(S)`, `dialogCapture(rows, cols)` (the capture's `dialog` field) and the constants (`TEXT_MAX` 300, `STEPS_MAX` 24, `MULTI_OTHER`, `PLAN_PICK`, `PLAIN_TEXT`). 0.5.4 (QP, QPF): `viewOf(S, note?)` (the `view` of a question step with a preview: sha256 over the `sig`, the focus, the preview rows, `hidden`, `fallback` and the note text), `notesOpen(rows)` (the footer alone: `n to add notes` and `ctrl+g to edit in`), `stripOf(rows, cols)` now also gives `notes` and `editing` for a preview step; the reader gives a preview step `preview`, `notes` and (server only, never in the capture) `noteRoom`. `answerDialog(pane, body)` and `checkDialogBody(body)` live in `src/session-control.js`; `autoCompact(pane)` too (the typed `/compact`, no route calls it) |
| `src/survey.js` | pure, ASCII (0.5, F14): `surveyOf(capture, edit) → null \| { state: 'ready', kind: 'rating', sig, options } \| { state: 'terminal', reason }` (`capture` is `{ rows, cursor, cols }`, `edit` is `{ vim, insert }`; never throws), `SURVEY_UNDO_MS` = 4000. The controller's `answerSurvey(pane, { n, sig })` and the exported `checkSurveyBody(body)` live in `src/session-control.js`; `boxInput` moved to `src/draft.js` (re-exported by `src/session-control.js`) and `src/draft.js` gained `surveyBox(rows, cursor, cols)` (the box reader with only the survey gate skipped). |
| `src/scroll.js` | `createScroll({ mirror, keys, lock, keyGap, now, sleep }) → { scroll(pane, body) → { status, body } }`; pure `checkScrollBody(body)`, `scrollKeys(body)` (the fixed table), `scrollGate(capture)` (the 409 code or `null`) and `pillShown(rows)` (re-exported from `src/mode.js`); constants `SCROLL_RATE` (10) and `MAX_PAGES` (8) |
| `src/fit.js` | `createFit({ exec, tmuxBin, now, stateDir, lock, log, schedule, sleep }) → { hold(id, { cols, rows, open, focus }), release(id), releaseAll(), recover(), setMode(m), mode(), size() }`: `hold` and `release` return `{ status, body }`, `setMode(m)` (0.5.4, P2) sets the Fit mode, one of `FIT_MODES` in `src/ids.js` (anything else, and the mode already set, does nothing; `off` gives every lease back) and `mode()` → the mode in force (memory only, never in a lease file or a request), `releaseAll()` → number (bounded by `RELEASE_ALL_MS`, 3 s), `recover()` → `{ released, dropped }` (same bound), `size()` → leases held; `checkFitBody(body)` → `{ value } \| { error }` is shared with the route; `lock(pane, fn)` is `withPaneLock` of `createSessionControl`. `createAppApi` builds one and sets `ctx.fit`; `appio.js` calls `recover()` before `ready` and `releaseAll()` in `finish()` after the server stopped taking requests; `spawnAgent` does not use it since 0.5.4 (a spawn never splits into a fitted window, ADR 0021; `releaseWindow` is gone) |
| `src/rules.js` | `async rulesState(project) → { state, settingsIgnored, git }`; `preview(project, ctx) → { status, body }`; `apply(project, { hash, overwriteForeign, gitignore }, ctx) → { status, body }` |
| `src/diff.js` | `unifiedDiff(oldText, newText, path) → string` |
| `src/spawn.js` | `spawnAgent(req, ctx) → { status, body }`; `runAgent(key, name, ctx) → exit code`; `deniedTools(role, commands) → string[]` (the `--disallowedTools` of a role) |
| `src/orchestrate.js` (helpers) | `tagPane(ctx, pane, role, agentTag?, depth?, parent?)` sets `@nika-role`, `@nika-agent` = `<key>/<name>` (`<key>/orchestrator` for the orchestrator), and (0.4) `@nika-depth` for a depth of 1 to 3 and `@nika-parent` for a pane id; `launchArgv(config, project, { sessionId, resume })` → claude's flags after the binary (the one place the orchestrator argv is built) |
| `src/orchestrate.js` | `startOrchestrator(projectKey, ctx) → { status, body }` (`ctx.findSession(id)` looks a saved orchestrator up in the transcript index); `pickState(project, id, hit)` (the one reading of a saved id, shared by the list, the PUT and Start; another project's session is `gone`), `claudePane(agent)`, `inProject(group, project)` |
| `src/model.js` | `findSession(id, { config, exec, now, cache }) → { agent, group } \| null` (a session of any age; throws `EINDEX` when it is not found and the index could not be read); `findSessions(ids, { config, now, cache }) → Map id → { agent, group }` (index only: one walk for all ids, no registry, ps or tmux, so every hit reads as not running; throws `EINDEX` when an id is missing and the index could not be read); `findGroups(keys, { config, now, cache }) → Map key → group` (0.5.4, RM and SF: index only, one walk for all the keys, the folders whose sessions are older than the snapshot included; throws `EINDEX` with the folders it did find in `found`), `findGroup(key, o)` is `findGroups` of one key |
| `src/limiter.js` | (0.5.4, SF) `createLimiter(max)` — runs at most `max` async tasks at once, the rest in FIFO order, a slot released even when a task throws; a leaf module that imports nothing, shared by the history collector and the attachment store |
| `src/place.js` | (0.5.4, P1, SF; ADR 0021) pure: where a spawned pane goes. `place({ rows, key, parent, under, last, placement, parents })` → `{ op: 'split', target, dir, tile, placement, moved? }` or `{ op: 'window', placement: 'window', moved? }`; `parsePlaceRows`, `readPlaceListing`, `isStrictPaneListing`, `parentTags` (the `@nika-parent` tags of the same `list-panes -a` read), `isAgentsWindow`, `tiledGrid`, `tileFits`; constants `MIN_COLS` 80, `MIN_ROWS` 15, `AGENTS_WINDOW`. It runs no tmux command; `spawn.js` does |
| `src/hidden.js` | (0.5.4, RM; ADR 0022) `hidden.json` in nika's state dir: `readHidden`, `listHidden`, `hideSession`, `hideGroup`, `unhideSession`, `unhideGroup`, `hiddenGeneration()`; constants `HIDDEN_FILE`, `MAX_ENTRIES` 500, `MAX_AGE_MS` 90 days. Read through `fsafe`, written through `fwrite`, one write after the other; ids and keys only, no name and no path |
| `src/hidden-routes.js` | (0.5.4, RM) `hiddenRoutes({ ctx, cap, snapshot })` → the routes of "Removed items" as api-app's `{ method, re, cap, handler }` list |
| `src/autocompact.js` | (0.5.4, AC; ADR 0014 amendment) the sweeper of the typed `/compact`: pure `decide(entry, reading, now)`, `createAutoCompact({ eligibility, isEligible, compact, touchedAt, now, log })` → `{ tick(), noteFor(id, e), stop() }`; constants `WAIT_MS` 60000, `QUIET_MS` 60000, `FLOOR_MS` 600000, `MAX_FAILS` 3, `NOT_NOW_MS` 30000. In memory only; the typing is the controller's `autoCompact(pane)` |
| `src/appio.js` | `serveApp({ config, env, stdin, stdout, stderr }) → Promise<number>` (handshake, listen, status loop, picker; resolves with the exit code 0/1/2) |
| `src/api-app.js` | `createAppApi({ secret, ctx, deps }) → (req, res, url, port) → Promise<boolean>` (true when it handled the request) |
