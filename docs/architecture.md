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
2. The shell finds Node on a worker thread (the window and tray stay alive; the answer is dropped if a newer start, an
   error page or Quit came first): a valid `NIKA_NODE` (absolute, executable) is the only candidate; else
   `/opt/homebrew/bin`, `/opt/homebrew/opt/node/bin`, `/usr/local/bin`, on Linux the Linuxbrew prefix, `~/.local/bin`,
   `~/.volta/bin`, the newest install of mise, fnm (also under `~/Library/Application Support` on macOS), nvm and asdf
   (folder listing only), then `/usr/bin`. Each existing candidate runs `node --version` (fixed argv, an environment of
   `HOME` alone, no shell, its own process group, 2 s limit, 6 s in total); the first that is 22 or newer wins. If some
   ran but none is new enough, the error
   page says `node-old` with the newest version seen; if none exists or answers, `node-missing`
   (`child.rs` `find_node`, [packaging](packaging.md#runtime-requirements-both-systems)).
3. The shell starts `node --max-semi-space-size=4 bin/nika serve --app` with piped stdio (see Memory bounds). The server files come from the app bundle
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
9. If Node is missing or too old, does not send `ready` within 10 s, or exits, the webview shows the local error page
   (`app/src-tauri/ui/error.html`, served as `tauri://localhost/error.html?reason=…`). Its Retry link
   (`tauri://localhost/retry`) is intercepted by the shell, which starts a new child with a new secret and a new port.
10. Quit: the shell closes the child's stdin, sends SIGTERM after 2 s and SIGKILL after 4 s. tmux sessions are never
    touched. Closing the window only hides it (on macOS a full-screen window leaves full screen first). On macOS the
    app is in the Dock and Cmd+Tab while its window is shown (activation policy Regular) and tray-only while it is
    hidden (Accessory); `Info.plist` keeps `LSUIElement`, so a `--hidden` login launch never shows a Dock icon.

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
   action per pane at a time, keys only through `keys.js`. `/stop` (an `Escape`, twice in vim insert mode) takes no lock. Bad input is a 400; a screen that does not match is a 409; either way nothing is typed.
4. The page draws what the routes return (`session.js` with `modes.js`, `quick-actions.js`, `palette.js`,
   `end-dialog.js`); every string is fixed copy or set with `textContent`.

Routes: [`contracts/api-app.md` section 3](contracts/api-app.md). Parsed screen text:
[`contracts/claude-tui.md`](contracts/claude-tui.md). Threats: T22, T23 and T26 in [security](security.md).

## Nesting (0.4)

A main orchestrator can start sub-orchestrators, and a sub-orchestrator can start agents: three levels, never an agent under
an agent ([ADR 0013](adr/0013-nested-orchestration.md)). The only record of who started whom is tmux's own. nika sets four tags
on a pane with `set-option -p` and fixed argv (`@nika-role` `orchestrator`, `sub-orchestrator` or `agent`; `@nika-agent`
`<project key>/<name>`; `@nika-depth` `1` to `3`; `@nika-parent` a pane id; 0.5 adds a fifth, `@nika-kind`, see Labels below), and `collect/tmux.js` reads them back strictly. A
spawn names its parent (the page sends a `parent` pane id; the CLI uses `$TMUX_PANE`), and `spawn.js` resolves the parent and
computes the depth from one fresh `tmux list-panes -a`, never from argv, env or a file. Only this project's orchestrator and
sub-orchestrators can parent; any other nika-tagged pane is refused (409 `depth`). Limits: `limits.maxAgents` (N) bounds the
live agents and sub-orchestrators under each parent, and a project runs at most `min(3 × N, 24)`; a refusal is 409 `limit` with
`{ scope, running, max }`. On the read side `model.js` `linkTree()` turns the tags into `parent`, `depth` and `children` for
each live agent (the depth is the place in the parent chain, not the tag's value), and `dash-model.js` `treeRows()` lays the
rows out as a folding tree on both tiers.

## Labels (0.5, W9)

Each agent row says what kind of agent it is, in one word. A label is display only: nothing in a flag, a prompt, a tool list, a permission or a cap
reads it, and it never reaches claude. A spawn carries an optional `kind`, one of the seven words of `ids.js` `KINDS` (`coder`, `reviewer`, `tester`,
`designer`, `scout`, `writer`, `agent`), checked by the API, the CLI (`--kind`), `spawnAgent` and again by `orchestrate.js` `tagPane`, which sets it
as the last tag, `@nika-kind`, on an agent pane only. Without a `kind`, `spawn.js` derives one at spawn time from its own model and the project's
effective role models (`labels.js` `kindFromModel`: an exact match, builder → coder, reasoner → designer, scout → scout, else agent). `collect/tmux.js`
reads the tag back as the last field of its listing, only beside `@nika-role agent` and only as an exact word; `model.js` puts `label` on every
agent (the kind, `agent` when the tag is missing, `sub-orchestrator` for that role, `null` for an orchestrator, a user's own session or an ended
one) and on every Claude subagent (`labels.js` `subagentLabel`: a table for Claude's built-in types, else the type's own cleaned name, at most 24
characters). On the page, `dash-model.js` (`agentLabelView`, `subLabelView`) decides the chip's text and title and `dom.js` `labelEl()` draws one
neutral pill; `app.js`, `session.js` and `project.js` (the spawn sheet's Kind select) place it. Spec 3.21; threat T57.

## Auto-compact (0.4)

The Settings choice ("Auto-compact at 80 % of 400k", `compaction` in `config.json`) reaches a session only through its launch
environment ([ADR 0014](adr/0014-auto-compact-launch-env.md)). `compact.js` `compactLaunch(model, setting)` computes, for the
model's window, the pair `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (both always, so an
inherited value never stays in force; never the `--autocompact` flag), and `compactEnv` validates it. The orchestrator gets the
pair as tmux `-e` values on its `new-session` or `new-window` (right after a `new-session` nika unsets the pair from the tmux
session environment, so later panes do not inherit it); an agent or sub-orchestrator gets it through `compact` in its
`<name>.agent.json`, which `_run-agent` validates again before adding the pair to the environment of the claude it starts.
tmux 3.2 is the floor (`new-session -e`); `nika doctor` warns below it and the `.deb` depends on it. The context column reads
the other way: `model.js` `contextOf()` turns the last `usage` of a transcript tail and the same setting into each agent's
`context`.

## Fit (0.5)

The session window measures its terminal panel and the app tier makes the mirrored pane that size, then puts the tmux window back
([ADR 0017](adr/0017-fit-lease.md)).

1. `public/fit-ui.js` (pure) turns the panel box into cells, plans the requests (the first `open: true`, a beat every 5 s, a 250 ms
   debounce, one `DELETE` on `pagehide`), scales the text while the pane is larger than the panel and picks the header chip, a button
   whose panel (`fitPanelView`) says why the fit is on or off and, where it helps, offers Fit again: `reopen()` makes the next request
   `open: true` (F1); `session.js` wires it with a probe, a `ResizeObserver` and `visibilitychange`.
2. `api-app.js` has two routes, `PUT` and `DELETE /api/app/pane/:id/fit`; they check the body, the pane and the rate, and hand over to
   `fit.js`.
3. `fit.js` reads tmux's own listing and decides: zoom a window with several panes, resize only when the panel is at least as big as
   the window. It takes a lease on the window (memory, `<state>/fit/fit-<nonce>.json`, the window option `@nika-fit`); a 1 s watch, a
   15 s lapse, `DELETE`, quit and the next start give the window back, and a change by the user ends the lease for good until the
   session window is opened again or the user presses Fit again. A split or an exit of one of nika's own agent panes (the pane tag
   `@nika-role`, the 12th field of the fit's listing, is `agent` or `sub-orchestrator`) is not a change of the user's (F2): the watch
   gives the window back without a mark and fits it again at once, and an untagged new pane gets one tick to be tagged. While a terminal
   shows the window (the 13th field of the listing, `#{window_active_clients}`, above 0) it never resizes it: it zooms and the page scales the text (chip state `terminal`),
   and it sizes the window to the panel again only after 30 s without a terminal (F4). Every change runs under `session-control.js` `withPaneLock`, and so does every read that decides a
   zoom, a resize or a restore: an acquire and a renew that resizes look again after the lock wait and change nothing when the window
   moved on (the renew then releases as a user change), a restore runs wholly inside the lock.
4. `appio.js` runs `recover()` before `ready` and `releaseAll()` at quit; `spawn.js` gives a fitted window back before a split lands in it.

Routes: [`contracts/api-app.md` section 3](contracts/api-app.md). Page: design spec 9.13. Threat: T52 in [security](security.md).

## Send while Claude works (0.5, W13)

Send used to need the registry state `idle`: a replace of Claude's input cleared it with `Escape`, which interrupts a running turn, and
background agents keep the registry at `busy` or `shell` almost all the time. Now Send works the way the terminal does: the text goes into
Claude's input and `Enter` is pressed, and Claude queues the message and takes it at its next step ([ADR 0019](adr/0019-send-while-working.md)).

1. `session-control.js` `writeDraft` clears without `Escape`: with the cursor on the box's last row it sends `End` (only when the cursor is
   not at the end of the text) and `C-u`, one key per request, at least 60 ms apart, in any registry state. Before every key a fresh capture
   must still show the plain box with the cursor in it, no prompt or dialog, and a text that is the start of the text before the press.
   With the cursor on an earlier row and Claude not idle nothing is sent (409 `cursor-not-at-end`); only at idle does the old `Escape` road run.
2. `submit` (`POST /api/app/pane/:id/submit`) presses Send's one `Enter`, in any registry state, only on a fresh screen that shows no
   permission prompt, no dialog and (with `base`) exactly the box the page synced; it reads the box back for a second and answers `taken`.
   The page's Send never posts `Enter` to the keys route any more.
3. `draft.js` reads Claude's queued-messages placeholder as an empty box with `queued: true` (not a suggestion); `draft-sync.js` shows the
   `Queued` note, and the new `On hold` and `Cursor` notes for the two refusals above.
4. `attach-send.js` no longer reads the registry either (below).

Contract: `contracts/api-app.md` (`submit`, `draft`). Page: design spec 9.12. Threat: T54 in [security](security.md).

## Attachments (0.5, W2)

The message box takes images, PDFs and text files ([ADR 0016](adr/0016-attachments-json-upload-state-dir.md)). Nothing reaches Claude before
Send.

1. `public/attach.js` keeps the chips. A file comes in by paste, by drop on the message box, or from the paperclip. The paperclip opens
   no file input (the webview's freezes the app on macOS): `POST …/attachments/pick { room }` makes the server ask the shell for its native
   dialog (`pick-files` / `files` over stdio, the slot Add project's folder chooser uses), and `appio.js` `createPicker` opens each picked
   path itself through `fsafe` (`O_NOFOLLOW`, a regular file you own, at most 8 MiB from the fstat) and stores the bytes. A pasted or
   dropped file is uploaded as JSON (`POST …/attachments { name, data }`, base64).
2. `attachments.js` `save` / `saveBytes` admit one save at a time (30 a minute), check the bytes (type from the magic, never the name), make
   the folders, check the path and the caps (256 MiB, 500 files), and write `<state>/attachments/<key>/<id>.<ext>` with `writeAtomic`. `<key>`
   comes from nika's own snapshot (`api-app.js` `paneKey`), never the request. Pruning runs at start, every 24 h and before each save;
   only names nika writes are removed, through `removeOwnFile`.
3. Send names the chips by id. The page first copies the text into Claude's input (the draft write), then `POST …/attach-send`:
   `attach-send.js` looks each id up (an id this process issued for this pane, the file re-opened with `O_NOFOLLOW`), then, under the pane lock,
   pastes the path of each file as a bracketed paste, reads the box back after every paste, and presses one `Enter` after a last fresh check.
   Any difference stops it with a 409 and the count of pastes that went in; it never clears a box it pasted into.
4. Claude shows a pasted image path as `[Image #N]` and reads any other file with its Read tool, which asks for a path outside the project:
   that prompt shows in the existing prompt panel and only the user answers it (`claude-tui.md` section 11).
5. The shell turns its own drag-and-drop handler off (`disable_drag_drop_handler`), so a dropped file reaches the page as an HTML5 drop.

Contract: `contracts/api-app.md`. Page: design spec 9.14. Threats: T38 and T55 in [security](security.md).

## Scrolling (0.5, W3)

The wheel, the trackpad and the page keys over the terminal mirror scroll Claude's own full-screen view ([ADR 0018](adr/0018-scroll-with-claude-keys.md)).
Claude draws in tmux's alternate screen, so tmux holds no history to read: nika sends Claude's own keys.

1. `mirror.js` reads `#{alternate_on}` with the size and cursor (`alt`), and `mode.js` `pillShown` sets `scrolled` from the pill Claude draws
   while its view is up. Both travel in every capture and only change what the page shows.
2. `public/scroll.js` turns wheel travel into whole pages (half of Claude's transcript area), after the mirror's own overflow has scrolled
   first, and plans the requests (one in flight, 100 ms apart, 8 pages at most). `session.js` wires the wheel and the keys.
3. `POST /api/app/pane/:id/scroll` takes a direction and a count, or an end, never a key; `scroll.js` maps them to `PPage`, `NPage`,
   `C-Home` or `C-End` and sends them in one `keys.send` call, under the pane lock, only when no Stop or End interrupt runs (`keyGap`) and a fresh
   capture shows the alternate screen, no permission prompt, a plain input box and a draft that does not start with `/`.

Contract: `contracts/api-app.md`. Page: design spec 9.15. Threat: T39 in [security](security.md).

## Question dialogs (0.5, W1)

When Claude asks the user a question (`AskUserQuestion`) or asks to approve a plan (`ExitPlanMode`), the session window answers it from a form
([ADR 0015](adr/0015-dialogs-from-the-screen.md)). The call is not in the transcript while the dialog is open, so the screen is the only source.

1. `dialog.js` (pure) reads the dialog from the mirror rows, exactly or not at all: the strip of tabs, the current question with its numbered
   options, the review's pairs, or the plan's choices. Anything cut, too wide, wrapped, oddly numbered, with two current tabs or under a
   feedback survey is `unreadable` with a reason. `sigOf` hashes the parsed step (never raw rows) into the 16 hex `sig`.
2. `api-app.js` puts `dialogCapture` in the capture's `dialog` field (null while a permission prompt parses). `mode.js` lets a dialog's last row end
   the footer's subagent list (`isDialogEnd`), and `draft.js` exports `width` for the text row's read-back.
3. `session-control.js` `promptOpen` counts a dialog like a permission prompt (`dialogOnScreen`), so Stop, the mode switch, the commands, draft
   writes, suggestion accepts and the attachment send refuse with nothing sent, and End declines it first.
4. `POST /api/app/pane/:id/dialog` (`checkDialogBody` in the router, then `answerDialog`) runs under the pane lock, one step per request. It
   reads first (`sig` must match), then presses one key at a time (a digit, `Down`, `Right`, `Enter`, free text through `send-keys -l`, or
   `Escape` for Decline), each after a fresh capture that must show the step in the state the previous key should have left. It never moves between
   Claude's tabs.
5. `public/dialog-form.js` draws one step as a form (`cleanDialog` for the capture, `answerBody` for the request, `dialogOutcome` for the fixed
   copy) and does nothing else: no key of its own, no Esc handler. `session.js` hooks it after `renderPrompt` and counts it in the send gate.

Contract: `contracts/api-app.md`. Screens and keys: `contracts/claude-tui.md` section 13. Page: design spec 9.16. Threat: T37 in [security](security.md).

## One row per conversation (0.5)

Rows are keyed by session id. After `/compact` Claude Code continues the conversation as a background job in a child `claude`: its
registry file says `kind: "bg"` with a `jobId` and has no `tmux` field, while the `claude` in the pane keeps its old session id and
records the job as `parkedJobId`. `collect()` (`model.js` `linkHosts`) joins the two when exactly one live background session and exactly
one live non-background session share that id and both resolve to the same project: the host gets no row, and the child's row takes the
host's pane (so its role, tags and place in the tree follow) and carries `hostId` = the host's session id. State, pid and everything else
stay the child's. Any other shape stays two rows. `findSession(id)` and the saved-orchestrator lookup (`api-app.js` `orchestrators()`,
Start) accept either id; the pane-eligibility map needs no change, because only the child claims the pane. Both registry entries must
carry a `cwd`: two entries without one are not "the same project". The row's `report` is the child's own, else the host's (a spawned
agent's `<name>.session` holds the id claude was launched with, which after `/compact` is the host's), and `report.sessionId` is the id
the report is filed under, which the page opens as `/api/report/<report.sessionId>`. The saved orchestrator moves with the
conversation: `GET /api/app/projects` writes the child's id with `setOrchestrator` when the saved pick is the host id of a live, linked
row of the same project (read again just before the write, best effort), and the pick dropdown (`project.js` `pickItems`) treats a row
whose `hostId` equals the pick as the pick. Threat: T53 in [security](security.md).

## Memory bounds (0.3.4)

Every cache that is keyed by path or id has a cap, so a day-long run does not grow with the number of sessions it has seen.
`util.js` `lru(max)` is a Map that drops its oldest entry past `max` (a read refreshes an entry). The parsed-transcript cache
is an lru that `collect()` resizes to the transcripts on disk plus 64 after each pass, so entries of deleted transcripts leave
and a transcript that is still on disk is never evicted; the command-list cache keeps 16 listings (each is reused for 10 s).
The two history routes (a session's own and a subagent's) share one transcript index (replaced every 10 s) and one limit of 4 reads in flight; the mirror, rate limiter and answer guard sweep their
per-pane entries by age, and `held`, `vim` and `ctx.started` drop a pane when the next pane list no longer has it. In the
page, the transcript column keeps at most 500 entries: while the reader follows the tail the oldest leave from the top
(Load older fetches them again), after Load older the newest leave from the bottom (Jump to latest returns), and a reader
who has scrolled up loses none until they are back at the bottom. Poll timers are single chains, and the mirror timer is
cleared before it is set again.

The server's live heap stays near 10 MB, but with V8's default young generation node kept about 200 MB resident on a
synthetic 5-minute run (200 sessions, history paging, agent polling). The desktop shell therefore starts it with
`--max-semi-space-size=4` (`child.rs` `NODE_HEAP_FLAG`): on the same run it holds about 90 MB, with the same history
latency. `--optimize-for-size` saved about 10 MB more but made history requests about 1 ms slower, so it is not used.

## Module map

### `src/` (Node, ES modules)

| File | Does |
|---|---|
| `actions.js` | The browser tier's only side effects: focus a tmux pane, read an indexed report. |
| `api-app.js` | Router and guard for `/api/app/*`. Validates, picks the module, sends its `{ status, body }`. Keeps the per-pane held mode and vim memory and builds the session controller, the scroller and the attachment sender (`paneKey` gives the attachment routes a pane's repository key from nika's own snapshot, never from the request). |
| `attach-send.js` | The attachment send (0.5, [ADR 0016](adr/0016-attachments-json-upload-state-dir.md)): `createAttachSend()` pastes the stored paths of a message into Claude's input and presses one `Enter`, under the pane lock, re-reading the screen before every paste and fail-closed at every difference. It reads no registry state, so it sends while Claude works (W13). |
| `attachments.js` | The attachment store (0.5): `createAttachments()` checks an upload's bytes (type from the magic, never the name), writes `<state>/attachments/<key>/<id>.<ext>` through `fwrite.js`, looks files up for a send, removes them and prunes by age (`attachments.keepDays`), count and size. Records of issued ids live in memory. App tier only. |
| `appcopy.js` | The macOS copy of `nika.app` in `~/Applications` (ADR 0011): state, install, dismiss and the refresh after an upgrade. Fixed target, source only from this install, built in a temp folder and swapped in with rename. |
| `appio.js` | The app-tier process: stdio handshake, private server, status feed, and the picker relay for both choosers (`createPicker`: one dialog slot for Add project's folder chooser and the attachment button's file chooser; for files it opens each picked path itself through `fsafe` and hands the bytes to the attachment store). It starts the attachment store after `ready` and stops it at the end. |
| `cli.js` | The `nika` command: `serve`, `open`, `app` (`app install`), `status`, `projects`, `rules`, `spawn`, `orchestrate`, `doctor`, `_run-agent`. |
| `commands-builtin.js` | The curated built-in slash commands for the palette, from `claude-tui.md` section 4. Nothing is read from disk. |
| `compact.js` | Auto-compact (ADR 0014): `compactLaunch(model, setting)` turns the Settings choice into the two launch variables for one model, and `compactEnv` validates them. Pure. |
| `config.js` | Defaults from the environment, port and `--since` parsing, `findTmux`, `findClaude`. |
| `diff.js` | Unified diff for the rules preview. |
| `dialog.js` | Claude's question dialogs and plan approvals (0.5, [ADR 0015](adr/0015-dialogs-from-the-screen.md)), pure: `dialogOnScreen` (is a dialog shape on screen), `readDialogScreen` (one step, exactly or `unreadable` with a reason: `cut`, `wide`, `numbers`, `tab`, `layout`, `survey`), `identityOf` / `sigOf` (the 16-hex `sig` over the parsed step), `otherAllowed` and `dialogCapture` (the capture's `dialog` field). The limits (`TEXT_MAX` 300, `STEPS_MAX` 24, the tab, header, label and question maxima) and the verified choices (`MULTI_OTHER`, `PLAN_PICK`, `PLAIN_TEXT`) are constants at the top. |
| `draft.js` | Claude's input box (the draft), pure: `parseDraft` reads it from the mirror rows and fails closed (`null` for no plain box, `unreadable` with a reason for one that must not be written over); `inEnvelope` (≤ 1024 characters, 12 newlines, 13 rows), `chunks` (what is typed, what is pasted; `CHUNK_GAP_MS` 300 ms between typed chunks), `normDraft` / `sameDraft`, `boxSquash` (the box with its whitespace removed, which the attachment send compares against), and the `queued` flag (Claude's "Press up to edit queued messages" placeholder, W13). |
| `exec.js` | `makeExec()`: `execFile` with a timeout and optional stdin input. |
| `fit.js` | The fit (0.5, [ADR 0017](adr/0017-fit-lease.md)): `createFit()` zooms the mirrored pane and sizes its tmux window to the session window's panel only when no other pane would be squeezed, keeps one lease per window (memory, a lease file, the window tag `@nika-fit`) and gives back exactly what it changed; fits the window again at once when only nika's own agent panes (pane tag `@nika-role` `agent` or `sub-orchestrator`) came or went (F2); never resizes a window a terminal shows (`#{window_active_clients}` above 0): it zooms only (state `terminal`) and sizes the window to the panel again after 30 s (`GROW_MS`) without a terminal (F4). Every tmux argv of the fit is built here. App tier only. |
| `fsafe.js` | Safe reads of agent-writable files (no symlink, no FIFO, owned by you, size cap). |
| `fwrite.js` | The only writer: atomic, symlink-safe writes and backups; `removeOwnFile` is the one way nika deletes a file of its own (the fit's lease files and the attachments). |
| `ids.js` | Id shapes (pane, project key, agent name, model, command name, session, key names, with `C-Home` and `C-End` for the scroll route) checked at every boundary, and `KINDS`, the seven words a label can be (0.5, W9). |
| `keys.js` | Keystrokes and bracketed paste into a tmux pane. A text of more than 700 characters is typed in chunks 300 ms apart, because Claude reads a burst of 801 or more as a paste. |
| `labels.js` | Labels (0.5, W9), pure: `isKind`, `kindFromModel(model, models)` (the kind a spawn without `kind` gets from its model's role), `subagentLabel(type)` (Claude's built-in subagent types → a kind, else the type's own cleaned name, at most `LABEL_MAX` 24 code points), and the tables `ROLE_KIND` and `SUBAGENT_KIND`. |
| `mirror.js` | `capture-pane` output turned into rows of whitelisted styled spans; a `fresh` capture skips the 250 ms cache for the control actions. It reads `#{alternate_on}` in the same `display-message` as the size and cursor (`alt`) and sets `scrolled` from Claude's scroll pill (0.5, W3). |
| `mode.js` | Pure parsers over mirror rows: the permission mode from the footer and the permission prompt. They fail closed. The footer is the last non-blank row without a background-subagent list drawn under it (F2, `claude-tui.md` section 1); `surveyShown` spots Claude's feedback survey; `pillShown` spots the pill Claude draws while its view is scrolled up (W3); `isDialogEnd` lets a question, review or plan dialog's last row end the footer's subagent list (W1). |
| `model.js` | `collect()`: merges every source into agent records and groups them by project; `findSession(id)` finds one session of any age in the transcript index (the saved orchestrator's lookup); `findSessions(ids)` does the same for several ids in one index walk, with no ps, tmux or registry (the project list's lookup). `contextOf` turns the last usage, nika's compaction setting (read through `loadConfig`, both tiers) and whether nika started the session into the agent's `context` (contract C6). |
| `models.js` | The static model catalog behind the model dropdowns (`GET /api/app/models`), with each model's context window and `modelWindow(id)`. |
| `orchestrate.js` | Starts or resumes a project's orchestrator in a tmux session (`launchArgv` builds its claude flags in one place) and finds an adopted orchestrator pane. |
| `paths.js` | nika's own config and state dirs (XDG). |
| `rules.js` | Renders, previews, hashes and applies the orchestration rules to a project. |
| `server.js` | The HTTP server both tiers share: Host check, static files with the CSP, the 0.1 routes, a mount hook for the app tier. |
| `scroll.js` | The scroll route's logic (0.5, [ADR 0018](adr/0018-scroll-with-claude-keys.md)): `createScroll()` maps a direction and a count, or an end, to `PPage`, `NPage`, `C-Home` or `C-End` from a fixed table, and sends them only after the screen gate (alternate screen, no prompt, a plain box, no `/` draft) under the pane lock. |
| `session-control.js` | The controls on a live pane: switch the mode, End, run a slash command, answer a prompt; and, since 0.5, the draft write (`writeDraft`: type, append, or replace by `End` and `C-u` in any registry state when the cursor is on the last row, by `Escape` only at idle), `submit` (Send's one guarded `Enter`, [ADR 0019](adr/0019-send-while-working.md)) and the suggestion accept. One lock per pane, keys only through `keys.js`, fail closed, never kills. `withPaneLock` hands the same lock to the fit, scroll and the attachment send, which wait for it (at most 5 s); `keyGap` tells them whether a Stop or End interrupt runs or sent its `Escape` less than 40 ms ago. Since 0.5 (W1) it also answers Claude's question dialogs (`answerDialog`, one step per request, a fresh capture before every key; `checkDialogBody` is the router's body check), and `promptOpen` counts a dialog like a permission prompt. |
| `spawn.js` | `spawnAgent()` splits a pane, or creates the project's tmux session (window `agents`) when there is no server or no session (resolving the parent and depth from tmux's tags and applying the per-parent and per-project limits, ADR 0013); `runAgent()` is the `_run-agent` wrapper that runs `claude` with the safety flags. |
| `store.js` | The validated `config.json`, the project registry and each project's saved orchestrator id. |
| `text.js` | `clean()` and `cleanBlock()`: strip controls and bidi marks from agent-controlled text. |
| `tmuxerr.js` | Maps a failed tmux call to a contract error body. |
| `util.js` | `mapLimit`: bounded concurrency. `lru`: a Map capped in size (see Memory bounds). |

### `src/collect/` (read-only sources)

| File | Reads |
|---|---|
| `commands.js` | Slash commands and skills for the palette: the built-in list plus the frontmatter (first 4 KB, never the body) of command and skill files in the user, project and plugin folders (app tier). |
| `history.js` | A session transcript, paginated from disk, newest page first (app tier). Two routes read through one windowed read (`readPage`) and one limiter (4 reads in flight in all): `readHistory` (the session's own file; an `Agent` / `Task` call entry gains `subagent` when exactly one meta names its tool-use id) and, since 0.5 (W8), `readSubagentHistory` (a subagent's `agent-<id>.jsonl`, found in the listing of the session's `subagents/` folder, never from the request). |
| `plugins.js` | Installed Claude Code plugin names; `listPluginDirs` also returns each plugin's `installPath`, only when it resolves inside the plugins cache. |
| `projects.js` | Groups a working directory under its git repository; worktrees fold under the main repository. Never runs git. |
| `registry.js` | The live session registry, one `<pid>.json` per running Claude Code process. |
| `reports.js` | Spawn report files (`.session`, `.md`, `.rc`) in the scratchpad and in nika's own report dirs. |
| `subagents.js` | Claude's own subagents of a session, in `<session>/subagents/` (both folders must be real directories, checked with `lstat`; every function takes the transcript index entry, never a request value). `readSubagents` reads the `agent-<id>.meta.json` files again on every call (≤ 64 KB each; type, description, model with `pickedEffortModel` as fallback, `finished`, the `agent-<id>.jsonl` mtime, and the `toolUseId` that only the server's link uses); `subagentTranscripts` lists the `agent-<id>.jsonl` names (the route's source of a file path); `subagentDir` is the folder check. The ids come from `SUBAGENT_ID` and `TOOL_USE_ID` in `src/ids.js`. |
| `tmux.js` | tmux panes (`list-panes -a`), pane titles and the pane tags nika sets (`@nika-role`, `@nika-agent`, `@nika-depth`, `@nika-parent` and, since W9, `@nika-kind`, last in the listing and kept only beside role `agent` as one of the seven words), each parsed strictly. |
| `transcripts.js` | Session transcripts: only the head and tail are read; results are cached by path, mtime and size. From the tail it also keeps the context size of the last assistant entry (`usage`: the sum of the input and cache tokens, and the model id; numbers only). |

### `public/` (the page, plain browser modules, strict CSP)

| File | Does |
|---|---|
| `index.html`, `session.html` | The main page and the session window. |
| `tokens.css`, `app.css`, `session.css` | Design tokens and styles (light, dark, system). `tokens.css` also holds what both pages share for Claude's subagents (0.5, W8): the state badge (`.sst`), the list lines and links, and the `subagent` role tag (`.tag.sa`). |
| `attach.js` | The attachment tray, page side (0.5): the pure rules (`formatSize`, `uploadView`, `pickView`, `sendView`: every line is fixed copy chosen by status and code) and `createAttachTray` (chips, the paperclip's chooser, paste and drop, Send). It makes no request of its own; `session.js` hands it the routes. |
| `api.js` | The only client of the app tier: takes the secret once and sends `X-Nika-App`. In the browser tier it refuses to run. |
| `app-copy.js` | The Add to Applications banner: which banner `appCopy` shows and its fixed copy. Pure; the two POSTs live in `project.js`. |
| `dash-model.js` | The Show ended rule of the dashboard and the project page (`endedPlan`, `resetEndedState`, per view; ended sessions and finished subagents stay hidden until it is on), the sidebar's Projects and Detected lists (`sidebarModel`) and the orchestrator's state and badge (`orchState`, `savedPick`, `otherRunning`, `roleTag`, `ROLE_TAGS`), and, since 0.5 (W8), what a subagent list draws (`subagentView`: summary, "+N ended" hint, the lines shown), the link to a subagent's read-only view (`subagentHref`), the three state words (`SUB_STATES`) and the page's copy of `SUBAGENT_ID` (a test compares it with `src/ids.js`). Since W9 also the labels: the copies of `KINDS` and `ROLE_KIND` and of `kindFromModel` (tests compare them with `src/ids.js` and `src/labels.js`), `KIND_TEXT`, and `agentLabelView` / `subLabelView`, which give a chip its text and title. Pure, both tiers. |
| `app.js` | Main page: shell, dashboard (in the app tier: mode tags, the row menu's End and the Add to Applications banner), router, the poll loop and the Keyboard shortcuts keys. Runs in both tiers. |
| `ui.js` | Shared state and widgets for the main page. |
| `dialog-form.js` | Claude's question dialogs and plan approvals as a form, page side (0.5, W1): the pure rules (`cleanDialog`, `answerBody`, `dialogOutcome`: every line is fixed copy chosen by status and code, `stepText`, `announcement`) and `createDialogForm` (one step at a time, the tabs list, option rows, Other, review, plan choices, Decline). It presses no key of its own. |
| `draft-sync.js` | The draft sync, page side (0.5), no DOM and no request of its own: `createDraftSync` pulls a changed screen into the message box after 1.5 s of quiet and pushes a local edit 250 ms after the last key; `draftSendPlan` decides what Send does (Enter alone, copy then Enter, the old paste, refuse, also when the footer is unknown and no box reads: `footerKnown`, F1; no plan carries an `Enter` key, Send's `Enter` always goes through the submit route); the note under the box (paused, long, hold, cursor, queued, suggest) and the fixed copy of the failed copy and the failed `Enter` (`sendMessage`, `submitMessage`, `submitResult`); twins of `src/draft.js` checked by test. |
| `dom.js` | `h()`: builds DOM with `textContent`, never parses markup; `roleTagEl()` draws the orchestrator badge; `subStateEl()` the subagent state badge (glyph, word, title; null for an unknown state) and `subagentItemEl()` one subagent line (badge, description as a link when the page passes an `href`, label chip, model, time), shared by the rows and the session window (0.5, W8); `labelEl()` draws a label chip, `span.agent-kind[title]`, the same neutral pill for every label (0.5, W9). |
| `end-dialog.js` | The End-session dialog, shared by the session window and the dashboard row menu. |
| `fit-ui.js` | The fit, page side (0.5): `panelSize` (the terminal box in cells, 40–400 × 10–200), `scaleFor` (text scale 0.4 to 1), `chipView` (the five chips and their fixed titles), `fitPanelView` (the chip panel's hint, code and action, by the chip's key; F1), `createFitPlanner` (the first `open: true`, a 5 s beat, a 250 ms debounce, one `DELETE` on `pagehide`, and `reopen()` for the user's Fit again). No DOM, no requests of its own; `session.js` wires it. |
| `modes.js` | Permission modes in the UI: labels, icons, the switcher's state and the dashboard's mode map and tag. |
| `ctx.js` | Pure text helpers for token counts, the Auto-compact result line and the context meter (`fmtTokens`, `compactPreview`, `ctxView`). No DOM; `dom.js` `ctxEl` draws the meter. |
| `models-ui.js` | The model dropdown shared by the session window, Settings and the spawn sheet: groups from the catalog, the Custom ID field and its `MODEL_ID` check. |
| `palette.js` | The slash-command palette's rules and copy (ranking, views, insertion). No DOM, no requests. |
| `plugin-view.js` | The "Choose plugins" dialog's model: the rows and their fixed order, the filter, the counts and what Save sends. Pure; the dialog itself lives in `project.js`. |
| `project.js` | App tier only: projects, add project, start orchestrator, project view (the Project setup card and its Choose plugins dialog), spawn sheet, apply-rules dialog, the poll of `/api/app/modes`, the Add to Applications install and dismiss requests. |
| `quick-actions.js` | The quick actions', prompt buttons', End dialog's and Shell mode's rules and fixed copy. No DOM, no requests. |
| `settings.js` | App tier only: the settings screen (defaults for every project; the Save and Discard bar shows only after a real change). |
| `session.js` | App tier only: the session window (history, live mirror, composer, mode switcher, quick actions, prompt buttons, Shell mode, command palette) and, with `agent=<id>` in the address (0.5, W8), the read-only view of one of Claude's subagents: the same page with the transcript only (it reads the subagent history route, builds no pane request and wires no terminal, composer, attachments, switcher, quick actions or fit), a header taken from the parent's snapshot, and a Back link to the parent's window. In a session window it also draws the folded list of the session's subagents (`renderSubs`) and the link from an `Agent` call to its subagent. |
| `scroll.js` | Scrolling Claude's view, page side (0.5): `wheelRows`, `routeFor` (the mirror's own overflow first), `pageRowsOf`, `scrollGate` (the page twin of the server's gate), `refusalLine`, `noteView` and `createScrollPlanner` (whole pages, one request in flight, 100 ms apart, 8 pages at most). No DOM, no requests of its own; `session.js` wires it. |
| `shortcuts.js` | The Keyboard shortcuts window and the key rules around it (`?`, Mod+/, Back). Static copy, both tiers; the table has a `dashboard`, a `session` and (0.5, W8) a `subagent` window. |
| `mirror-render.js` | Pane-mirror helpers: render model, cursor, key handling. Re-validates every value. |

Also: `bin/nika` (launcher), `templates/` (generic rules, brief and guard prompt, written from scratch), `app/src-tauri`
(the Rust shell), `test/` (Node tests, synthetic fixtures), `docs/`.

## Data and storage

nika's own files follow XDG ([ADR 0008](adr/0008-xdg-config-state.md)). Folders are 0700, files 0600.

| Path | Holds |
|---|---|
| `${NIKA_CONFIG_DIR or XDG_CONFIG_HOME or ~/.config}/nika/config.json` | Settings, the project registry and each project's own settings (`perProject`: its plugins, models and saved orchestrator). Validated on load; garbage falls back to defaults with a warning. |
| `…/nika/templates/<name>.md` | Rule templates you imported locally. |
| `${XDG_STATE_HOME or ~/.local/state}/nika/projects/<key>/reports/` | Per spawned agent: brief, settings, session id, pane, exit code, report. |
| `${XDG_STATE_HOME or ~/.local/state}/nika/fit/fit-<nonce>.json` | The fit's lease while a window is held (0.5): written before the first tmux change, removed on release, read back at the app tier's start to restore what a crash left. |
| `${XDG_STATE_HOME or ~/.local/state}/nika/attachments/<key>/<id>.<ext>` | The files attached in the session window (0.5, 0600 in 0700 folders), until the user removes them, the window closes with them unsent, or they expire (`attachments.keepDays` in `config.json`, 1 to 30, default 7) or the store passes 256 MiB or 500 files. Never served back. |
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
  one `@rules/orchestration.md` line in `CLAUDE.md` and in a regular `AGENTS.md` (a `CLAUDE.md` that imports `@AGENTS.md` gets
  the rules through it and is left as it is, a lone `AGENTS.md` gets a new `CLAUDE.md` that is just `@AGENTS.md`; non-regular
  `AGENTS.md` is skipped, never followed; `docs/templates.md`), `enabledPlugins` in
  `.claude/settings.local.json`, and, if you opt in, one `.gitignore` line;
- macOS only, on `nika app install`, the app's Add/Update button, or a launch command refreshing a copy nika made
  earlier: `~/Applications/nika.app`, a `ditto` copy of the app that came with this install. Fixed target, never
  `/Applications`; it is replaced only when it is a real folder you own that is nika's bundle, built in a temp folder
  next to it and swapped in with rename (`src/appcopy.js`; its small state marker goes through `fwrite.js`).
  Policy: [ADR 0011](adr/0011-app-copy-in-applications.md).

nika never runs `git add`, `commit` or `push`. Policy: [ADR 0006](adr/0006-project-write-policy.md).
