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
`invalid` 400, `unsupported_media` 415, `too_large` 413, `conflict` 409, `busy` 429, `tmux_unavailable` 503,
`claude_unavailable` 503, `tmux_failed` 502 (a tmux call failed unexpectedly), `limit` 409 (maxAgents reached), `foreign` 409 (rules file not written by nika, apply without
`overwriteForeign`), `refused` 409 (a write-safety check failed; `"code"` carries the fwrite/OS code such as `ESYMLINK`),
and for session control (0.3) `not-idle`, `mode-unknown`, `not-in-cycle`, `busy-switching`, `no-prompt`,
`prompt-changed`, `already-answered`, `input-not-empty`, `not-at-prompt`, all 409. The 0.3 codes are hyphenated, as the spec names them; the older codes keep their underscores.

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

### `GET /api/app/templates`
`200 { "templates": [ "<name>.md", … ] }` — file names (`^[A-Za-z0-9_-]{1,64}\.md$`, regular user-owned files via
`fsafe`, ≤ 50, sorted) in `configDir()/templates/`; `[]` when the folder is missing. Names only, never contents or
paths. Users add templates by copying a file into that folder (`nika doctor` prints it).

### Dashboard snapshot additions (`GET /api/agents`, both tiers)
Each group gains `"key": "<keyFor(repo root)>"` (16 hex, matches a registered project's key when the repo is
registered). Each agent gains `"role": "orchestrator" | "agent" | null` (from the pane's `@nika-role`, read with
`list-panes -a -F …\t#{@nika-role}`) and `"attention": "<clean(registry status, 80)>" | null` — set only when a live
agent's state is neither busy nor idle (e.g. waiting on a permission prompt), else null. No paths or transcript text
are added.

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
{ "models": [ { "id": "claude-opus-5-5", "label": "Opus 5.5", "group": "latest" },
              { "id": "opusplan", "label": "Opus plan, Sonnet build", "group": "alias", "note": "Opus in plan mode, Sonnet otherwise" } ] }
```
The static catalog in `src/models.js`, in catalog order; `group` ∈ `latest alias older`; IDs from `claude-tui.md` §6
only. No network call. A custom ID is accepted wherever a model is, when it matches `MODEL_ID`.

### `GET /api/app/session/:id/history?before=<n>&limit=<n>`
`id` must be a `UUID` present in nika's transcript index (never a path from the request). `limit` 1–200 (default 50),
`before` a byte offset returned as `nextBefore` by the previous page (default: end of file). The server reads at most
1 MB per request, 4 requests in flight, and drops any single entry over 32 KB (`"truncated": true`).
```json
{ "entries": [ { "id": "<byte offset of the line>:<block index>", "at": "<ISO>", "role": "user" | "assistant", "kind": "text" | "thinking" | "tool_use" | "tool_result",
                 "text": "<cleanBlock()>", "tool": "<name>?", "truncated": false } ],
  "nextBefore": 123456 | null }
```
Text is passed through `cleanBlock()` (keeps `\n` and `\t`, strips every other control and bidi code point) and the
page renders it with `textContent`.

### `GET /api/app/pane/:id/capture`
`id` `PANE_ID`, must appear in the current `tmux list-panes -a`, be either a live Claude session's pane
(registry `tmux` field) or a pane nika started (`orchestrator/start`, `spawn`), **and** its `pane_current_command` must
look like claude (`CLAUDE_COMMAND`: `claude`, `node`, a version string) at that moment, for a started pane too (tmux can
reuse a pane id after a restart). Else 404. Cached 250 ms per pane,
one capture in flight per pane (others wait for it), `ETag` = hash of the rows; `If-None-Match` → 304.
```json
{ "cols": 120, "rows": [ [ { "t": "text", "s": { "b": true, "fg": 4, "bg": null, "u": false, "i": false, "d": false } } ] ],
  "cursor": { "x": 0, "y": 0, "visible": true }, "etag": "<hex>",
  "mode": "plan", "modeConfirmed": true,
  "prompt": { "question": "Do you want to proceed?", "options": [ { "n": 1, "label": "Yes" }, { "n": 2, "label": "No" } ],
              "sig": "<16 hex>" } }
```
Only SGR codes 0, 1, 2, 3, 4, 7, 22–24, 27, 30–37, 39, 40–47, 49, 90–97, 100–107 and 38/48;5;n or ;2;r;g;b survive
(colours as 0–255 or `[r,g,b]`; reverse video adds `"r": true` to the style only while it is on); everything else (OSC, DCS, other CSI, C0/C1) is dropped server-side (T9).

0.3 fields, parsed server-side from the same rows (`src/mode.js`, phrases and layouts in `claude-tui.md` §1–§2):
- `mode` ∈ `MODES` or `unknown`, read from the last non-blank row only (any number of trailing blank rows are
  skipped; Claude draws the mode line there). A token counts only at the start of that row: after at most 2 leading
  spaces, an optional `-- INSERT --` / `-- NORMAL --` prefix and optional `⏵` / `⏸` glyphs; a token elsewhere in the
  row (a file menu, a help line, a wrapped description) never counts. `manual` only on Claude's positive marker
  (`manual mode`); no recognized phrase → `unknown`, never `manual`; an otherwise unrecognized footer whose first word
  (after that prefix) is `bypass` or `bypassPermissions` (any case) → `bypassPermissions` (fail loud); so the
  slash-command menu (rows starting with `/` or `❯ /`) reads `unknown`, and a permission prompt or dialog covering the
  footer → `unknown`.
- `modeConfirmed` (boolean): `true` when `mode` is the footer reading. When the footer reads `unknown` (a permission
  prompt or dialog covers it, or the text is unrecognized), `mode` is the last mode read from this pane's footer (kept
  in memory per pane id, dropped when the pane leaves the eligible set), else, for a pane nika started, the recorded
  launch mode (`started` entry, §9: the `--permission-mode` passed, `manual` when none), and `modeConfirmed` is
  `false`; with neither, `mode` is `unknown` and `modeConfirmed` is `true`. A held or launch value is display only:
  the mode route reads the footer itself and never uses it. The switcher is disabled while `mode` is `unknown`,
  `modeConfirmed` is `false` or a `prompt` is open (the mode route would answer 409), and the page offers no
  Shift-Tab shortcut while a `prompt` is open.
- `prompt`: `{ "question", "options": [ { "n", "label" } ], "sig" }` when Claude's permission prompt is on screen,
  else `null`. Layout (`claude-tui.md` §2), all within the last 15 non-blank rows: the closing hint row starting with
  `Esc to cancel` is the last non-blank row; the options sit directly above it, at least 2, numbered `1..k` (one digit each) without gaps
  (wrapped rows without a number join the label with one space); the question sits directly above option 1 and ends in
  `?`. Question and labels pass through `clean()`; question ≤ 200 chars, labels ≤ 80 chars. Unknown layouts (such as
  the unnumbered folder-trust dialog) give `null`, so no buttons. `sig` = the first 16 hex chars of sha256 over
  `lastNonBlank(rows, PROMPT_ROWS).join('\n')` (both from `src/mode.js`, so the window cannot drift), computed in
  `src/api-app.js`; the answer route checks it. An option whose label contains `bypass` (any case) gets no button: the
  page shows it as text with "Answer this one in the terminal", and the answer route refuses it (rule 12). Labels can hold the user's folder paths: shown in the app only, never logged.

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
`200 { "sent": { "text": 12, "paste": 0, "keys": 1 } }` (counts of characters / keys sent). Stop in the session
window is this route with `{ "keys": [ "Escape" ] }` (ends the turn; the session stays).

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
   from the pre-press mode; an `unknown` read keeps polling; still `unknown` or unchanged at 1.8 s → 409
   `mode-unknown`. Then: target reached → 200; back at the start mode → 409 `not-in-cycle`; 6 presses used → 409
   `not-in-cycle`; else re-run step 4's idle check with the registry state read again (→ 409 `not-idle`) and press
   again.

The cycle may pass through `bypassPermissions` on the way when Claude's cycle holds it (a session the user launched
with bypass allowed); nika never targets it (rule 12). A 409 or a failed send after some presses leaves Claude in the
mode the last press reached; the page reads it from the next capture.

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
5. `n` is not among the prompt's options, or that option's label contains `bypass` (any case; rule 12: nika never
   moves a session into bypass) → `400 invalid`.
6. Send the digit as literal text through the keys path (`send-keys -l -- <n>`, counts toward its 20 requests/s per
   pane; no Enter, `claude-tui.md` §2) → `200 { "answered": 1 }`; a failed send → that send's status and body.

### `POST /api/app/pane/:id/command` (body ≤ 4 KB, `CAP.small`)
```json
{ "text": "/compact" }
```
Types one slash command into Claude's input and presses Enter, safely; the quick actions (Compact, Clear, Model) use
it. `text` = `/` + a `COMMAND_NAME`, optionally one space and arguments, ≤ 200 chars, no C0/C1 controls, else
`400 invalid`. The composer's own Send stays the keys route (the user's typing passes through as in 0.2).

1. Ineligible pane → `404 not_found`. Another control action running on this pane → 409 `busy-switching`.
2. Fresh capture and registry state: not `idle`, or a `prompt` on screen → 409 `not-idle` (no Escape here; Stop is
   its own button). Footer `unknown` → 409 `mode-unknown`.
3. The input-box, vim and typing checks of End's steps 4–6 with `text` in place of `/exit` (a text that wraps onto a
   second row fails the exact one-row check → `C-u`, 409 `not-at-prompt`) → `200 { "sent": true }`; a failed send
   → that send's status and body.

### `POST /api/app/pane/:id/end` (body ≤ 4 KB, `CAP.small`)
Body `{}`. Steps, in this order:

1. Ineligible pane (same rule as capture) → `404 not_found`. Another control action running on this pane → 409
   `busy-switching`.
2. Fresh capture and registry state. When the state is not `idle` or a `prompt` is on screen: send `Escape` (cancel,
   the "No" path of a prompt), wait 1 s, then take a fresh capture and read the registry state again.
3. The state is still not `idle`, or a `prompt` is still on screen → 409 `not-idle`, nothing typed. Footer `unknown`
   (a dialog may be open) → 409 `mode-unknown`, nothing typed. So End can never answer a prompt or a dialog.
4. Input box (`claude-tui.md` §5: the rows between the last two rule rows made only of `─`; the no-break space after
   `❯` compares as a space): it must be exactly one row reading `❯` alone, or `❯` followed only by dim text (the
   placeholder; a draft is never dim, whatever it says), where the first character may be reverse video (Claude's
   cursor over the placeholder) and whitespace may be plain; anything else (a draft, several rows, no box found) → 409
   `input-not-empty`, nothing typed ("Claude's input has text; clear it first").
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

When any key send fails (for example 429) the sequence stops and the pane is checked once: gone or no longer running
claude → `{ "ended": true }`, else `{ "ended": false }`. Never `kill-pane`, never a signal. The eligibility cache is
reset afterwards.

### `POST /api/app/spawn` (body ≤ 80 KB)
```json
{ "project": "<PROJECT_KEY>", "name": "<AGENT_NAME>", "model": "<MODEL_ID>", "brief": "<≤ 64 KB, more than one word>",
  "permissionMode": "<PERMISSION_MODES>?", "under": "<PANE_ID>?", "session": "<TMUX_SESSION>?", "rc": "off|<RC_PREFIX>?" }
```
A one-word `brief` (no whitespace once trimmed) → 400 `brief must be more than one word`: the brief is claude's positional
prompt after `--`, and a lone `update` or `doctor` could be read as a subcommand; `_run-agent` refuses a stored one-word
brief too (exit 3). `permissionMode` defaults to settings; `bypassPermissions` → 400. `rc` overrides the Remote Control setting for this
agent. `under`: split `-v` below that pane (unknown pane → 404, pane in another session than `session` → 400; the
response `session` is the pane's session). Refused with `409 limit` when the project already has
`limits.maxAgents` live nika-spawned agents, and with `409 conflict` when one already has the same `name`. Both read the
same list, the same on the API and the CLI path: the panes, in any tmux session, that tmux reports with `@nika-role`
`agent` and an `@nika-agent` tag `<project key>/<name>` for this project (§8), plus panes this process started. The name
check compares the exact `<key>/<name>`: the same name in another project is free. `<name>.pane` files never count:
they are agent-writable and display only. Response:
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
    { "path": ".claude/settings.local.json", "action": "update", "diff": "<enabledPlugins block only>", "keysPreserved": true, "keptKeys": 3 },
    { "path": ".gitignore", "action": "update", "diff": "…", "optional": true } ],
  "warnings": [ "settings.local.json is not gitignored" ], "backupDir": "<stateDir>/backups/<key>/<ISO>" }
```
`POST /api/app/rules/apply` `{ "project": "<PROJECT_KEY>", "hash": "<from preview>", "overwriteForeign": false,
"gitignore": false }` recomputes the preview; a different hash → **409 conflict**. Writes go through `src/fwrite.js`
(`checkComponents` → backup → `writeAtomic`) and never touch git. Response `200 { "written": [ "rules/orchestration.md",
"CLAUDE.md", ".claude/settings.local.json" ], "backupDir": "<abs>" }`.

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
| server → shell | `error` | `{"type":"error","message":"<clean()>"}` before a non-zero exit (bad `hello`, port in use) |

Limits: one open `pick-folder` at a time; `status` fields are integers ≥ 0; names are `clean()`ed; `attention` = live
agents whose registry status is neither busy nor idle (e.g. waiting on a permission prompt); `projects[].key` is
`keyFor(repo root)`, never a path. Pane eligibility (§3 capture/keys): a registry pane qualifies only while its
`pane_current_command` is claude-like (`CLAUDE_COMMAND` in `src/ids.js`), because `tmuxPane` is agent-writable; a pane
nika started qualifies only while its command is claude-like too, because tmux can reuse a pane id after a restart
(a spawned agent's pane runs `_run-agent` as `node`). This is a safety net for the user, not a boundary against agents: a same-user agent able to forge the registry can already
run `tmux send-keys` itself; `node` stays accepted because npm-installed Claude Code runs as `node`. The secret never
appears in argv, env, logs, files or HTML; the shell injects it into the page with an `initialization_script` guarded
by `location.origin`, and `public/api.js` copies it to a module constant and deletes the global (ADR 0002).

Child process (desktop shell). Argv is fixed: `<node> <root>/bin/nika serve --app`, where `<root>` is the bundle's
resource directory in release builds and the repository root in debug builds (never an env var). The environment is
built from scratch (`env_clear`) and holds only: `PATH` (the node binary's directory, then
`/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`), `HOME`, `NIKA_APP=1` and, when set
in the app's own environment, `CLAUDE_CONFIG_DIR`, `NIKA_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`TMUX_TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`. `NIKA_NODE` (an absolute path to an executable node) only chooses the
interpreter and is not passed on; without it the shell takes the first executable `node` in `/opt/homebrew/bin`,
`/opt/homebrew/opt/node/bin`, `/usr/local/bin`, `$HOME/.local/bin`, `/usr/bin`. `ready` must arrive within 10 s with
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
| `…/nika/projects/<key>/reports/` | 0700 | per agent: `<name>.brief.md` and `<name>.agent.json` (`{model, permissionMode, rc}`, re-validated on read) written by `spawn`; `<name>.session` (UUID), `<name>.remote` (RC name or empty), `<name>.pane` (`$TMUX_PANE`, display only: never counted) written by `_run-agent` before claude starts and `<name>.rc` (claude's exit code, as in 0.1) after it exits; `<name>.md` written by the agent; `.last-pane` |
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
  "plugins": { "perProject": { "<PROJECT_KEY>": [ "<PLUGIN_NAME>" ] } },
  "projects": [ { "key": "<PROJECT_KEY>", "dir": "<abs realpath>", "name": "<basename>", "addedAt": "<ISO>" } ],
  "rules": { "localTemplate": null },
  "ui": { "theme": "system", "singleKeyShortcuts": true }
}
```
`ui.theme` ∈ `system light dark` (default `system` = follow `prefers-color-scheme`). `ui.singleKeyShortcuts` boolean
(default `true`; a missing or non-boolean value reads as the default): whether `?` opens Keyboard shortcuts (design spec
§4.6). Mod+/ always does.
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
| `nika status [--json] [--since w] [--full]` | unchanged from 0.1 |
| `nika spawn <name> <model> <brief> [--project dir] [--permission-mode m] [--rc prefix\|off] [--under %pane] [--session name]` | spawn an agent in tmux (needs `$TMUX` or `--session`); `brief` is a file path or `-` for stdin |
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
| list panes | `tmux -u list-panes -a -F #{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}` (0.1) |
| session exists | `tmux -u has-session -t =<session>` |
| create session + orchestrator | `tmux -u new-session -d -s <session> -n orchestrator -c <projectDir> -x 200 -y 50 -P -F #{pane_id} -- <claudeBin> <orchestrator flags>` |
| orchestrator in existing session | `tmux -u new-window -t =<session>: -n orchestrator -c <projectDir> -P -F #{pane_id} -- <claudeBin> <orchestrator flags>` |
| tag a pane nika created | `tmux -u set-option -p -t %n @nika-role orchestrator` (after new-session / new-window) or `… @nika-role agent` (after split-window); for an agent also `tmux -u set-option -p -t %n @nika-agent <PROJECT_KEY>/<AGENT_NAME>`; best effort |
| agent panes of a spawn | `tmux -u list-panes -a -F #{pane_id}\t#{@nika-role}\t#{@nika-agent}` → the panes with `@nika-role` = `agent` whose `@nika-agent` is `<key>/<name>` for the project's key: the live agents for `limits.maxAgents` and the duplicate-name check. The tag is parsed strictly (exactly one `/`, `PROJECT_KEY` before it, `AGENT_NAME` after it); anything else is agent-writable noise and is ignored, never trusted |
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

tmux also format-expands `new-session -s <session>`, `new-window -n <name>` and `select-pane -T <title>`. Those values
are passed unescaped and are safe only because they can never contain a `#`: `TMUX_SESSION` and `AGENT_NAME` exclude it,
the window name is the constant `orchestrator`, and the title is `[%n] <AGENT_NAME>` with `%n` a `PANE_ID`. A change that
lets another string reach `-s`, `-n` or `-T` must escape it with `tmuxLiteral()` first. `test/spawn.test.js` ("tmux format
expansion (T6)") asserts it.

Session targets always carry the trailing colon (`=<session>:`) where tmux expects a window or pane: `split-window -t
=name` fails with "can't find pane", `=name:` works.

**Claude argv** (every value a separate element; verified against Claude Code 2.1.319):
- orchestrator flags: `--session-id <UUID>` `--model <models.orchestrator>` `[--permission-mode <m>]` (omitted for
  `default`) `-n <session>` `[--remote-control=<rc name>]`. RC name = `remoteControl.prefix` or the session name,
  reduced to `RC_PREFIX`.
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
- `<nikaBin…>` = `process.execPath` + absolute path of `bin/nika` (no PATH lookup inside tmux).

## 9. Module interfaces (Phase 2)

Handlers return `{ status, body }` like 0.1 `focusPane` / `readReport`; the router only sends. `ctx` =
`{ env, exec, tmuxBin, claudeBin, nikaArgv, claudeDir, now, started }` where `started` is the in-process `Map<paneId,
{ key, name, sessionId, role: "agent" | "orchestrator", mode }>` of panes nika created (`mode`, 0.3: the permission
mode passed at launch, `manual` when none). Pane eligibility (in `list-panes`, running claude, and live Claude or `started`) is
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
| `src/orchestrate.js` (helpers) | `tagPane(ctx, pane, role, agentTag?)` sets `@nika-role` and, for an agent, `@nika-agent` = `<key>/<name>` |
| `src/orchestrate.js` | `startOrchestrator(project, ctx) → { status, body }` |
| `src/appio.js` | `serveApp({ config, env, stdin, stdout, stderr }) → Promise<number>` (handshake, listen, status loop, picker; resolves with the exit code 0/1/2) |
| `src/api-app.js` | `createAppApi({ secret, ctx, deps }) → (req, res, url, port) → Promise<boolean>` (true when it handled the request) |
