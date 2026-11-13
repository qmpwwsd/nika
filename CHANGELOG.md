# Changelog

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
  per project, `--full` shows all of them. `--json` is unchanged.
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
- **Apply rules also writes `AGENTS.md`.** Claude Code reads `AGENTS.md` only when a project has no `CLAUDE.md`, so
  Apply no longer creates `CLAUDE.md` in a project that has only `AGENTS.md`: the `@rules/orchestration.md` line goes into
  `AGENTS.md` instead, and into both files when both exist (same preview, hash check and backup). A symlinked `AGENTS.md`
  beside `CLAUDE.md` is left alone and shown as skipped in the preview; a symlinked `AGENTS.md` with no `CLAUDE.md` is
  refused. `nika rules apply` says "Nothing to apply." when only a skipped file is left.
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
- **Project page: a Setup drawer on narrow windows.** At 1030 px and narrower the Rules, Project setup and New agents cards no
  longer stack under the agents: a **Setup** button next to Spawn sub-orchestrator opens them in a side drawer (Esc, × or a
  click outside closes it). Choose plugins…, Choose models… and Preview rules open on top of it and give the focus back to
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
