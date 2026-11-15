# Changelog

## 0.5.0 (unreleased)

Session window (desktop app):

- **The message box and Claude's input box follow each other.** Type in the terminal and the text shows up in the message
  box once you stop typing for a moment (1.5 seconds). Type in the message box and the text appears in Claude's input a
  quarter of a second after your last key. Both ways work with several lines, pasted text and the Shell toggle: when Claude's
  box is in its `!` mode, Shell turns on, and Shell on puts `!` in front. Text you have not sent is never overwritten by what the
  terminal shows, and a window you reopen with text in the box does not wipe it.
- **Send is smaller.** When Claude's input already holds your message, Send presses only Enter. When it does not, nika copies
  the message into Claude's input first and then presses Enter. If the copy fails, nothing is sent, you see why, and your text
  stays.
- **Claude's input box is no longer drawn twice.** The terminal view now stops above Claude's input box and ends with a thin
  line, "Input box · mirrored in the message box below". Turn on **Type into pane** to see every row again. When nika cannot
  read the box (a menu or a question is open), the view shows every row, too.
- **When nika cannot read Claude's input, it stops syncing and says so** ("Sync paused: Claude's input holds …"): a pasted
  block, a draft longer than 14 rows, text that ends in spaces, an older prompt that you recalled with the up arrow, or text
  nika can't read back exactly (a row it does not know, or a long line that wraps in a way nika cannot tell apart from a
  different text). It never writes over such an input. Edit or clear it in the terminal, and the sync continues. Send is
  refused while it is paused, with the same words.
- **Claude's suggestion shows in the message box.** When Claude offers a suggestion for your next prompt (the grey text in its
  empty input box), the empty message box shows that text as its placeholder, in the accent colour and italic, with a note
  under the box: "Suggestion: Tab or → accepts what Claude suggests." Press **Tab** or **→** to take it: nika checks that Claude
  is waiting and still shows exactly that suggestion, presses Tab in Claude's input once, and the message box fills with the
  text. If anything changed (the suggestion went away, Claude got busy, a question opened), nothing is pressed and you see why.
  Without a suggestion, Tab moves focus and → goes to the pane as before. **Send** with an empty message box and an empty input sends nothing, because what Enter submits on a suggestion has not been verified.
- **Long messages.** Text that does not fit Claude's box (more than 1024 characters, 12 line breaks or 13 rows) is not mirrored
  ("Not mirrored: Long text goes to Claude when you send it"). Send still pastes it into an empty input, as before. If Claude's
  input already holds other text, Send refuses, so the two are never sent together; clear it in the terminal or shorten your
  message.
- **Send works while Claude works.** Press Send while Claude is busy, or while it waits for background agents or shells, and nika
  puts the message into Claude's input and presses Enter, as you would in the terminal. Claude queues the message and takes it at
  its next step; until then the message box shows "Queued: Claude takes your message at its next step". A message queued in the
  middle of a turn can steer that turn, and Stop sends a queued message at once (the Stop button's tooltip says so). Attachments are sent the
  same way. Before every Enter nika takes a fresh look at Claude's screen: when a permission prompt, a question or another dialog
  is open, it presses nothing and says so ("A prompt opened in Claude, so nika did not press Enter. Answer it, then send again.
  Your text is kept."), and Send over an empty message box and an empty input sends nothing.
- **nika no longer presses Esc to change Claude's input while Claude works.** To replace the text in Claude's input it now uses End
  and Ctrl+U, which never interrupt a turn; it uses Esc only when Claude is idle and the cursor sits on an earlier line of the box.
  When Claude works and the cursor in its input is not on the last line, the message box waits instead and says so ("Cursor: …":
  move the cursor to the end in the terminal, or wait). Three new notes, each with its own colour, icon and word, replace "Waiting
  for Claude": "On hold:" (a prompt is open or Stop is running), "Cursor:" and "Queued:".
- **A status line that looks like Claude's input box is left alone.** nika reads a box as Claude's input only when the terminal
  cursor is in it. Otherwise it sees no input box: nothing is mirrored or typed, and End and the commands refuse.
- **End, Compact, Clear and Model read the input box more carefully.** A box in Claude's `!` mode, a pasted block, a long draft
  or an older prompt that is showing now count as "not empty" or "cannot read", and nothing is typed. End and the commands do
  not press Enter when grey completion text is still in the box.
- Known limit: at a few rare line breaks (for example a line break typed exactly where Claude would have wrapped the line anyway)
  the text nika reads back from Claude's box can differ from what you typed by one space or line break. nika then shows what
  Claude holds and sends nothing wrongly; the next copy into Claude's input writes that text back, so one space or line break of
  your draft has really changed. Plain-mode input was checked less than vim mode (nika's typing was run against a stand-in
  there, not against Claude itself), and Tab or Enter on a real Claude suggestion through nika has not been tried yet.
- **The terminal fills its panel.** The session window measures its terminal panel and asks nika to make the pane that size, so
  the mirror shows the whole pane with no empty space and no sideways scroll. nika zooms the pane inside its tmux window and, when
  that cannot squeeze anything, sizes the tmux window to the panel. It resizes a window with several panes only when the panel is at
  least as big as the window; when the panel is smaller, nika zooms the pane, leaves the window at its size and draws the text
  smaller (never larger than normal, never below 0.4 times). A window with one pane is sized to the panel. The header still says
  "Live · 120 × 39", the pane's real size.
- **A "Fit" chip says what nika did to your tmux window**, with its own colour, icon and words: "Fit · fills the panel", "Fit ·
  zoomed, text scaled", "Fit · off" (hover for why: you zoomed another pane, the window has a `window-size` setting nika does not
  change, another program marks the window, the window changed while nika was fitting it, or you changed it) and "Fit · another
  window" (another nika window shows a pane of the same tmux window; the one you opened last fits it).
- **nika gives your tmux window back as it was.** On closing the session window, 15 seconds after the window goes quiet,
  when you quit nika, and at the next start after a crash, nika undoes only what it did: the zoom, the window size, the
  `window-size` setting and, when you have not touched the layout, the layout and the focus. If you unzoom, move, split, kill a
  pane or resize in tmux while the window is fitted, nika sees it within a second, puts the window back right after, and does not
  fit it again until you open the session window again (a resize you make while the window is fitted is also undone: nika puts the
  window back to its old size). A zoom you made yourself is never undone. Spawning an agent into a fitted window puts it back
  first. The restore is exact except for tmux's last-pane order: which pane `last-pane` jumps back to is not restored.
- Known limits: the fit was tried on tmux 3.8, and the `linux-verify` check on CI runs it on the Linux runner's tmux (3.6a on
  ubuntu-latest: a 3-pane and a single-pane window fitted and given back exactly, `select-layout --` accepted, `window-size`
  unset reads empty); tmux 3.2, the lowest supported, and every version other than 3.6a and 3.8 are not checked yet; a crash leaves the window at nika's size until
  nika starts again; with `pane-border-status` on, the mirrored pane has one row fewer than the panel; the reason a fit is off shows as a
  tooltip and one spoken announcement only.

- **Attach images, PDFs and text files to a message.** Paste a file into the message box, drop it on the box, or click the
  paperclip ("Add attachments"; it opens nika's own file chooser, not the webview's, which froze the app on macOS). Up to 6 files
  per message, up to 8 MB each: PNG, JPEG, GIF and WebP images, PDFs, and UTF-8 text. nika checks the bytes, not the file name.
  A chip shows each file; remove it before you send and the copy goes at once. Nothing reaches Claude until Send: then nika
  pastes the stored path of each file into Claude's input after your text, checks the screen after every paste, and presses Enter
  once. Claude shows an image as `[Image #N]` and sends the image itself. A PDF or text file is read by Claude with its Read tool,
  which asks first (the folder is outside the project): the prompt shows in the prompt panel, only you answer it, and after a send
  nika adds one line to say so. Under your own allow rules there may be no prompt. If anything on the screen differs from what
  nika expected, it stops, says how many files went in, and leaves your text and chips; it never clears a box it pasted into.
  Attachments go while Claude works, too (the message is queued like any other).
- **Where attachments live.** nika copies each file into its own state folder, `attachments/<repository key>/`, with folders at
  0700 and files at 0600, never into your project and never served back. The copy goes when you remove the chip, when you close
  the window with the file unsent, and after N days (Settings, Attachments, "Keep attachments for N days": 1 to 30, default 7).
  The store holds at most 256 MiB and 500 files; the oldest go first (never one younger than an hour), and a full store refuses
  the next upload. A state path with a space cannot be pasted as one word, so attachments refuse with a line that names
  `XDG_STATE_HOME`. While a file is decoded, memory rises: on macOS six 7.8 MB uploads took the app's server from about 25 MB
  to about 160 MB right after (RSS 70 to 206 MB), 65 MB a minute later and 36 MB after five (RSS 100 MB).
- **Scroll Claude's view from the session window.** The mouse wheel, the trackpad and PageUp, PageDown, Home and End scroll
  Claude's own full-screen view: tmux keeps no history of it, so nika sends Claude's page keys (Page Up, Page Down, Ctrl+Home
  and Ctrl+End), one page at a time (about half the transcript), up to 8 pages in one go. A note says "Scrolled up in Claude's
  view" while it is up, and Jump to live returns to the bottom. Scrolling works while Claude works and never interrupts it.
  nika scrolls only when it can see a plain input box: with a permission prompt, a dialog, a menu or a draft that starts with `/`
  it sends nothing and says why. PageUp, PageDown, Home and End scroll Claude's view only while Type into pane is off.
- **Answer Claude's questions and plan approvals from the session window.** When Claude asks you something (up to eight
  questions in tabs, then a review) or asks you to approve a plan, the window now shows a form above the message box instead of
  only "needs you". It shows one question at a time, following Claude's own tabs: pick an option (or several), or type your own
  answer under **Other** (up to 300 characters, not starting with a digit), then press **Answer**, or **Send answer** on a
  question that ends the dialog. A review step lists your answers and has **Submit answers**. A plan approval shows Claude's
  choices as buttons ("Read the plan in the terminal view"; the plan text itself is not shown) and **Reject (Esc)**. **Decline**
  presses Esc in the pane: Claude stops and waits for you. nika reads the dialog from the screen, exactly or not at all: when it
  cannot (a narrow pane, a label that wraps, a menu it does not know), the old note stays and you answer in the terminal. Before
  every key it looks at the screen again, and it never moves between Claude's tabs; if you change the dialog in the terminal
  meanwhile, it stops, says how many keys it had pressed, and the form stays locked ("Finish it there"). A step that mentions
  bypass is terminal-only: nika offers only Decline. While a form shows, Send, Stop, the mode switch and the commands wait (Stop's
  tooltip says "Decline is in the question form"). Esc in the message box still goes to Claude, as in the terminal, and declines
  the dialog. See `docs/adr/0015-dialogs-from-the-screen.md`.
- **Long text in the keys route is typed in pieces.** Text of 701 to 1024 characters is sent in chunks of at most 700 characters
  about 300 ms apart, because Claude turns a burst of more than 800 characters into a pasted block and loses part of the text.
- **One row per conversation after `/compact`.** Claude continues a compacted conversation in the background under a new session
  id. nika used to show two rows. It now shows one, with the tmux pane that shows it; a spawned agent keeps its report on that
  row (opened under the id it is filed under); and when the saved orchestrator of a project is the old id of a conversation that
  continues under a new one, nika saves the new id, so Start orchestrator resumes the right session.
- **Open Claude's subagents.** Claude's own subagents (the ones its Agent tool starts inside a session) now show a badge on
  dashboard and project-page rows, each state with its own colour, symbol and word: Running, Finished, Stopped (the browser
  dashboard shows the badges too). In the app the description is a link: it opens the subagent in the session window,
  read-only. You see its transcript, with a "subagent" tag, its state, type and model in the header, no terminal and no
  message box; **Back** returns to the session that runs it, with its terminal. Open one from a dashboard row, from the
  project page, from a new folded list at the top of a session window's Transcript (it has its own **Show ended** box,
  remembered), or from the **Open subagent transcript** link under the call that started it. nika reads the subagent's
  transcript from Claude's own `subagents` folder, in pages, like a session's, and only for a session and a subagent it
  listed itself. The view keeps updating while the session runs, also after a subagent shows Finished: Claude marks a subagent
  Finished when its loop stops and takes the mark away again when the subagent wakes up (for example when its background shell
  ends); it stops when the state reads Stopped (the session is gone). A subagent now shows its model with Claude Code 2.1.325,
  which names it under another key. The view has its own Keyboard shortcuts window (Back and the window keys). See
  `docs/design/spec.md` §9.17 and `docs/security.md` T56.
- **"No subagents running +N ended".** A row whose subagents have all finished used to draw no subagent line. It now says so in
  one muted line, and **Show ended** lists them.

Fixes:

- **Send no longer types into Claude's agent list or onto the shells pill.** With the keyboard selection on a row of the agent list
  or on the `<n> shells` pill, Claude hides its input cursor, and a typed key either left the selection or opened the Background
  dialog. When nika can read no input box and no mode line (a menu, the agent list), Send now refuses before typing anything: "nika
  can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept." That covers text, Shell text
  and the Enter of an empty message box. The Send route's Enter, when the page gives no `sig`, also refuses when the cursor sits
  below the input box (409 `input-unreadable`).
- **Background subagents no longer hide the footer.** While Claude runs background subagents it draws their list under the footer
  line. nika used to read that list as the footer, so the mode showed as unknown and the message box could not mirror Claude's
  input. nika now sees through the list. It also stops mirroring while Claude's feedback survey is on screen, so a draft that
  starts with a digit can never answer it. A permission prompt (or a dialog nika does not know) drawn with the list below it still
  reads as unknown, so nika cannot answer it: answer it in the terminal.
- **The mode no longer flips to "Auto unconfirmed" while the mouse rests on Claude's agent list.** Claude draws a pointer in front of
  the list row under the mouse, and nika used to read that row as the footer, so the mode chip switched to unconfirmed and the
  message box stopped mirroring for as long as the mouse stayed there. nika now reads the list with the pointer on one row. A row
  picked with the arrow keys still reads as unknown on purpose (Claude replaces the mode line with a hint then), so nothing is
  typed there.
- **Send looks at the screen first.** Before Send types your message (and Shell's `!` text) it takes a fresh look at Claude's
  screen, and it types nothing while a permission prompt, a question or plan dialog, the auto-mode notice, Claude's feedback
  survey or a screen nika cannot read (no input box and an unknown footer) is open: a digit or a letter typed there would answer
  it. A long message is typed in pieces, and nika looks again before each later piece; if something opens in between, it stops
  there and keeps your text in the message box. nika also never attaches `.env` files or key and certificate files
  (`*.key`, `*.pem`): paste, drop and the file chooser refuse them by name ("nika doesn't attach .env, key or certificate files.").
- **A pane whose Claude has ended gets no keys and no capture.** With tmux's `remain-on-exit`, the pane of a session that ended stays on
  screen, and tmux still names its command after Claude, so nika took it for a live session. The session window, the mode, End and the
  other pane routes now refuse such a pane ("pane not found"), and the mode list leaves it out. A tmux listing row whose dead-pane
  field is not exactly 0 or 1 is dropped instead of being read as running. (`docs/security.md`, residual risk j, is closed.)
- **Start no longer opens a second orchestrator when tmux's pane list cannot be read.** Start used to treat every failed listing as "no
  tmux server, no orchestrator". Now only tmux's "no server running" answer means that; any other failure ends Start with "tmux failed:
  …" and nothing is started, the way Spawn already behaved.
- **No empty gap under the message box.** The row under the message box (argument hint, Shell hint, sync note, problem line) kept a
  gap of its own even when none of them showed. It now takes no height at all until one of them appears, and the screen-reader
  announcements that live in it still work.
- **The fit works when tmux shows pane titles.** With `pane-border-status` set to `top` or `bottom`, tmux takes one row of every
  pane for the border line, so nika's read-back saw a pane one row shorter than its window, took it for a change by someone else,
  and drew the text smaller instead of fitting. nika now accepts a pane of the window's height or one row less (the width and the
  window size must still match exactly); the mirrored pane has one row fewer than the panel.

## 0.4.0 — 2026-11-13

Orchestration (desktop app):

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
- **Three levels.** The main orchestrator can start sub-orchestrators, and a sub-orchestrator can start agents of its own.
  `nika spawn <name> <model> <brief> --role orchestrator` starts a sub-orchestrator; run from an orchestrator's pane, the
  new session becomes its child. An agent cannot start other agents, and a sub-orchestrator cannot start another
  sub-orchestrator: nika answers "can't start a sub-orchestrator" (409 `depth`) and starts nothing. Only this project's
  orchestrator and its sub-orchestrators can start agents of the project: any other nika session, such as an agent or another
  project's orchestrator, is refused the same way. The name `orchestrator` is reserved for the main orchestrator.
- Spawning under an orchestrator you adopted from your own tmux session opens the agent beside it, in that session. Starting
  the orchestrator with `nika orchestrate` while one you adopted is running in another tmux session switches to it instead of
  starting a second one.
- A sub-orchestrator can run only `nika spawn` and `nika status`; the other nika commands are on its deny list (advisory, like
  the agents' list). It gets its own guard prompt, written for orchestrating.
- **Limits per parent and per project.** **Agents per orchestrator** (Settings, 1 to 8) now bounds the agents and
  sub-orchestrators under each parent, and a project as a whole runs at most three times that number, never more than 24.
  A refusal says which limit it hit (409 `limit`, with `scope`, `running` and `max`).
- **The tree.** On the dashboard and the project page (browser and app), agents now sit under the orchestrator or
  sub-orchestrator that started them, indented a level at a time. A button before a parent's name folds its agents; a folded
  row shows how many are hidden and how many of them need you. A sub-orchestrator whose parent has ended stays in the list
  with a "parent ended" mark. Ended agents, the "Waiting on you" queue and any filter stay flat. In a flat list a row whose
  parent is running says "under <parent>"; an ended agent has no parent, so its row does not. Projects where no agent has a
  parent look the same as before. The sub-orchestrator badge now comes from the session's role, not from its depth. Names stay
  whole at every width: the role badge shows its short word ("orch", "sub-orch") unless the name cell can hold the long one,
  the context column fits the warn icon and a three-digit percent, and on a row that needs you the attention text ("waiting")
  stays whole: the branch and project chips give way first, and the branch chip drops out when the cell is narrow.
- **Spawn a sub-orchestrator (desktop app).** The project page has a **Spawn sub-orchestrator** button next to Spawn agent,
  and the orchestrator's row menu has **Spawn agent under…** and **Spawn sub-orchestrator under…**; a sub-orchestrator's
  menu has **Spawn agent under…**. The spawn sheet shows the parent, lets you choose Agent or Sub-orchestrator (the second
  only under the main orchestrator, with the reason beside it otherwise), and counts "planner: 2 of 3 · demo-api: 5 of 9
  running" when it opens. A spawn that would pass a limit is off before you try, with the reason as its tooltip, and the
  server's refusals (limit, "can't start a sub-orchestrator", "no longer running") show in the sheet in plain words.
- Settings: **Agents per project at once** is now **Agents per orchestrator**, with help on how the limits add up. The
  project page's **New agents** card lists the per-orchestrator limit, how many you have spawned from nika and how many
  the project runs, and says so when a limit is reached.
- **New agents settings per project.** The project page's **New agents** card now sets this project's own **Permission
  mode**, **Pane** and **Per orchestrator** limit: click a value to open its menu, then pick a value or **Use Settings**. A
  value the project takes from Settings is marked "from Settings". nika uses them when it starts or resumes the project's
  orchestrator, when it spawns an agent or sub-orchestrator in the project (the spawn sheet's first permission choice is
  "Use this project's setting"), and in the project's `rules/orchestration.md` when you apply rules. A project's own
  limit N also sets its project cap, min(3 × N, 24), and a limit refusal then points at the project's card instead of
  Settings. `bypassPermissions` is refused for a project too, at the store, the API and spawn; a hand-edited
  `config.json` with a bad value loses only that value, with a warning.
- Remove project now says it also forgets the project's saved orchestrator.
- `rules/orchestration.md` has a new **Sub-orchestrators** section (template version 2): apply rules to a project to get it.
- Every orchestrator nika starts, resumes or adopts is now tagged for its project (`@nika-agent <key>/orchestrator`,
  `@nika-depth 1`). An orchestrator started by 0.3 still counts, as long as it is in the project's own tmux session and window.
- Setting a session as the orchestrator is refused for a sub-orchestrator nika started, like for agents.
- API: `PUT` and `DELETE /api/app/projects/:key/orchestrator` are new; each project in `GET /api/app/projects` gains
  `orchestrator`; `POST /api/app/orchestrator/start` can answer `cleared: "gone"`. `POST /api/app/spawn` takes `role` (`agent`
  or `orchestrator`) and `parent` (a pane id); agents in `GET /api/agents` (both tiers) gain `parent`, `depth` and `children`;
  the role of a sub-orchestrator is `sub-orchestrator`. See `docs/contracts/api-app.md` and
  `docs/adr/0013-nested-orchestration.md`.

Models (desktop app):

- Each project can use its own model for any of the four roles (Orchestrator, Reasoner, Builder, Scout). On the project page,
  **Project setup** has a new **Models** block that lists the roles this project sets, and **Choose models…** opens a window
  with one menu per role: **Use default** (the model from Settings) or a model from the list, or a Custom ID. Save is on
  only while something changed.
- nika uses these models when it starts or resumes the project's orchestrator, in the Roles table of `rules/orchestration.md`,
  and in the spawn sheet's Roles list (marked "(this project)"). Sessions that are already running keep their model, and the
  rules file changes only when you apply rules, so the toast after saving says so.
- API: `PUT /api/app/projects/:key/config` takes exactly one of `{ plugins }`, `{ models }`, `{ permissionMode }`,
  `{ panePlacement }` or `{ maxAgents }` (`null` for the last three means "Use Settings"), and `GET` returns all five. See
  `docs/contracts/api-app.md`.

Auto-compact (desktop app):

- **Compact before the context fills.** Settings has a new **Auto-compact** section: "Auto-compact at [80] % of [400k]", on
  by default. Every claude nika starts from now on compacts at that point: the orchestrator (new or resumed), spawned agents
  and sub-orchestrators. Choose 200k, 400k, 1M or the model's full window, and a number from 20 to 95. The line under the
  row shows the result ("Compacts at about 320k tokens (about 160k on 200k-window models)"); a session never compacts later
  than 33k tokens before the end of its window, so 90 % of 400k reads as about 167k on a 200k-window model.
- It applies only to sessions nika starts, from their next start. Running sessions and sessions you start yourself keep
  Claude Code's own setting. With the switch off, nika sets nothing. The variables live only in the orchestrator's pane and in each
  agent's process: windows you open in the project's tmux session do not get them. Needs tmux 3.2 or newer. Inside a session nika
  started, `/autocompact` is locked to the setting; change it in Settings and restart the session.
- API: `GET` and `PUT /api/app/settings` carry `compaction` (`enabled`, `pct`, `window`), and `GET /api/app/models` gives each
  model a `window`. nika sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for the new claude and
  never the `--autocompact` flag. See `docs/contracts/api-app.md` and `docs/adr/0014-auto-compact-launch-env.md`.

Context (both tiers):

- **How full is each session.** Every row on the dashboard and the project page, in the browser and in the app, has a new
  **Context** column: the percentage of the window the session's context fills, with a thin bar, and "–" when there is no
  usage yet. It turns amber from 60 % and red, with a warning icon, from 80 %. The session window's header shows the same
  meter ("Context 312k / 400k · 78 %"). Hover it for "Context: 312k of 400k tokens (compacts at 320k)"; a screen reader hears
  "Context 78 % used, 312k of 400k tokens, compacts at 320k" and "nearly full" from 80 %.
- The percentage is measured against the window auto-compact uses: your Settings window (cut to the model's own) when
  auto-compact is on, the model's full window when it is off. With the default 80 % setting, 80 % means a session nika started is about to
  compact; the tooltip always says where it compacts. A session you started yourself, or one that has ended, is measured against the same window, but nika's setting
  does not act on it, so its tooltip says nothing about compacting. Narrow rows drop the bar and keep the percentage.
- The numbers come from the `usage` of the last assistant entry in the transcript tail. The browser tier shows them too: it
  now reads the compaction setting from nika's own `config.json`, and sends token counts and the model's window per session,
  numbers only and no text. A model nika does not know counts as 200k.
- API: agents in `GET /api/agents` (both tiers) gain `context` (`tokens`, `window`, `compactAt`, `pct`, `compaction`). See
  `docs/contracts/api-app.md`.

Fixes:

- A session whose turn is over but still runs a background shell (Claude's `shell` status) shows as Working, not as needing you, and you can send it messages.
- **Linux: live sessions no longer show as ended** (issue #14). Claude Code on Linux records a session's start as the
  `starttime` field of `/proc/<pid>/stat`, which never matched the `ps` date nika compared it with. nika now reads that one
  field (at most 4 KB, your own processes only) for the sessions in Claude's registry. A different value means the process
  id was reused, so that session counts as ended.
- **macOS: live sessions nika missed now show.** A session's start time is compared as a moment, not as text. It matches
  when it equals the process start read as UTC or as local time, and ISO dates are compared to the second. A start time
  nika cannot read counts as running while the process runs. An upper-case session id is accepted. Session files nika
  cannot use are no longer dropped silently: the dashboard shows "N session files skipped (unreadable or not in Claude's
  format)" as a muted note, and `nika status` prints the same line.
- Running sessions are never hidden behind "Show N more": the 12-row limit now applies only to the Ended section. The
  sidebar's Detected list shows 8 repositories, then an "N more" button.
- No tmux server running is a normal state, no longer reported as "Some sources are unavailable".
- **Ended and finished are hidden by default.** Ended sessions and Claude's finished or stopped subagents stay out of the
  dashboard, the project page and the browser dashboard until **Show ended** is on. The project page has its own remembered
  **Show ended** box (its Ended section no longer opens by itself). A row's subagent summary adds a muted "+N ended" while
  some are hidden. `nika status` lists no ended agents by default and says how many it hid: `--ended` shows the latest 5
  per project, `--full` shows all of them. It always lists the projects you added to nika, even with only ended sessions
  (you can resume them) and added projects with no sessions yet ("name  folder   no sessions yet" with `--since all`, else
  "no sessions in the last 7d" and so on); a folder you never added shows only while a session runs there, and one line
  counts the others ("… 3 folders not added to nika, with only ended sessions, hidden"). A `config.json` nika cannot use
  is named in a note. `--json` is unchanged.
- The project page's **New agents** card shows the permission mode as a chip with its own colour, icon and short word
  (Default, Manual, Accept edits, Plan, Auto, Don't ask), like the session header, instead of a sentence.
- The session window's permission-mode switcher no longer has a "Mode" word in front of it.
- **Start and spawn without tmux running.** Spawn agent now creates the project's tmux session (first window `agents`) when
  no tmux server or no project session exists, instead of answering "tmux unavailable" or "start the orchestrator first".
  Start orchestrator, Resume and Spawn agent check one second after starting that Claude is still running; if it exited
  right away (for example, it needs a login), the project page says "Claude exited right after it started. Run `claude`
  once in a terminal in this folder to see why (for example, to log in)." (after a resume: "Run `claude --resume <id>`…")
  and stays on the project page. "tmux not
  found" now means only that the tmux program is missing. A dead orchestrator or agent pane kept by tmux's
  `remain-on-exit` no longer counts as running, toward the agent limits or for the duplicate-name check. When tmux
  fails for any other reason than "no server running", Spawn agent refuses with tmux's own message instead of skipping
  the limits.
- **Rules reach `AGENTS.md` as well as `CLAUDE.md`, and Claude loads them once.** Apply rules adds the
  `@rules/orchestration.md` line to `AGENTS.md` too (other coding tools read it), with the same preview, hash check and
  backup as `CLAUDE.md`, and the preview lists both files. Claude Code reads `AGENTS.md` only while a project has no
  `CLAUDE.md`, so a project with only `AGENTS.md` also gets a new `CLAUDE.md` that is just `@AGENTS.md` (Claude Code's own
  way to share one file with other tools); `AGENTS.md` is written first. A `CLAUDE.md` that already imports `@AGENTS.md`
  is left as it is: it gets the rules through the import, and the preview says so. Releases up to 0.3.4 always put the line
  into `CLAUDE.md`, so a `CLAUDE.md` that imports `@AGENTS.md` may have it already: it keeps it (nika never removes a line)
  and the preview then says Claude may read the rules twice and that deleting that line by hand fixes it. A symlinked `AGENTS.md`, or a folder or
  other non-file of that name, is skipped with a note when a `CLAUDE.md` exists and refused when it does not. "Rules
  outdated" now also means that `CLAUDE.md` or `AGENTS.md` lacks the rules line.
- **Linux: the window keys work.** Ctrl+Q quits nika, Ctrl+W closes the window, and Ctrl+Plus (or Ctrl+=), Ctrl+Minus
  and Ctrl+0 zoom, on every page; in Type into pane Ctrl+W still goes to Claude. The page asks the app through a new
  app-tier route, `POST /api/app/window`, which sends the shell one `window` line over stdio; the shell ignores any other
  action. On macOS the app menu keeps these keys (Close Window and Minimize were already there).
- **Copy and paste in Type into pane.** Ctrl+Shift+C copies the text selected in the terminal; Ctrl+Shift+V, and Ctrl+V on
  Linux, paste into Claude as one paste instead of "Not sent: … not on the allow-list". Ctrl+C still sends C-c. In the
  message box Ctrl+Shift+C no longer stops Claude; Ctrl+C is Stop only with nothing selected (with a selection the text
  field keeps it: a copy on Linux). Copy, cut, paste, select all, undo
  and redo work in every text field on both platforms. The Keyboard shortcuts window lists the window and copy keys per
  platform.
- The hint row under the message box is gone (its key tips are in the Keyboard shortcuts window). "Sent … to %N" is still
  read to screen readers; the argument hint, the Shell hint and error messages stay where they were.
- **macOS: a held key repeats** in nika's window instead of opening the accent popup. The app turns the press-and-hold
  popup off for its own process only, in memory; nothing is written to your preferences. Accents still work with the
  Option key. New dependency: `objc2-foundation` 0.3.2 (macOS only, already in the lock file through Tauri).
- **Project page: a Settings drawer on narrow windows.** At 1030 px and narrower the Rules, Project setup and New agents cards no
  longer stack under the agents: a **Settings** button (gear) at the right of the title row, before Show ended, opens them in
  a side drawer (Esc, × or a click outside closes it). Choose plugins…, Choose models… and Preview rules open on top of it and give the focus back to
  their button. Above 1030 px nothing changes. In the drawer, Esc closes an open value menu before the drawer, and a menu that
  does not fit below its button and does not fit above it in a short window opens below and scrolls into view instead of being cut off.
- **Tooltips on icon-only controls.** Every control that shows an icon or a symbol and no words now says what it is on hover: the
  × of each dialog, the − and + of the steppers, the fold button of the agent tree, Copy backup path, the sidebar links and Add
  project when the sidebar is the narrow rail, the status glyph of a narrow row, and the tmux and claude dots. A test reads every
  page and fails on a new icon control without a title.

Packaging:

- The `.deb` now depends on `tmux (>= 3.2)`, the version auto-compact needs, and `nika doctor` warns on its tmux row when tmux
  is older than 3.2 ("tmux 3.1 is older than 3.2: nika's auto-compact needs 3.2 or newer"). A version it cannot read shows
  "version unknown" and no warning.

Docs:

- README has an **Orchestration (0.4)** section, and its requirements, "What nika reads" and "Configuration" cover the new
  settings. New: `docs/adr/0013-nested-orchestration.md` and `docs/adr/0014-auto-compact-launch-env.md`; the design spec has
  new sections for the tree, the spawn sheet, auto-compact and the context column, and the screenshots show them.

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
