# Claude Code TUI facts nika parses

Checked against Claude Code 2.1.319 on 2026-11-08 (macOS, tmux), in a throwaway session, plus the official docs:
`code.claude.com/docs/en/commands.md`, `skills.md`, `plugins/components.md`, `plugins/loading.md`, `model-config.md`
and the models overview on `platform.claude.com`. Phrases below are typed by hand; no capture, transcript, path or id
is copied here. When Claude Code changes these texts, nika's parsers fail closed (the control hides) and this file is
updated with the new version.

## 1. Footer (mode line)

The mode line is the last non-blank row of the pane while Claude's prompt box is shown. Around the phrase:

- an optional vim-mode prefix: `-- INSERT --` or `-- NORMAL --`;
- an optional suffix: ` (shift+tab to cycle)`, then ` · ← for agents`;
- a user status line may sit in the rows above it (free content: ignore it).

| Mode | Phrase | Token nika matches (case-insensitive) | Color (xterm-256) |
|---|---|---|---|
| auto | `⏵⏵ auto mode on` | `auto mode` | 220 |
| manual (Claude's `default`) | `⏸ manual mode on` | `manual mode` | 246 |
| acceptEdits | `⏵⏵ accept edits on` | `accept edits` | 147 |
| plan | `⏸ plan mode on` | `plan mode` | 73 |
| dontAsk | `⏵⏵ don't ask on` | `don't ask` | 211 |
| bypassPermissions | not observed (§7) | the word `bypass` or `bypassPermissions` | — |

- nika matches a token only at the start of the mode line: after at most 2 leading spaces, the optional vim-mode
  prefix and the optional `⏵` / `⏸` glyphs. A token anywhere else in the row (a file menu, a help line, a wrapped
  description) does not count.
- Manual has a positive marker: `manual mode`. A footer row with none of the tokens is `unknown`.
- Observed Shift+Tab cycle (account with auto available, not launched with bypass): auto → manual → acceptEdits →
  plan → auto.
- While a permission prompt or another dialog is open, the prompt box and its mode line are replaced: the mode is
  `unknown` until the dialog closes.

## 2. Permission prompt

Bottom of the pane while Claude asks (labels here are examples):

```
 Bash command
 <what the command does>
 ╌╌╌╌╌╌╌╌
 <the command>
 ╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to <folder> from this
      project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
```

- The question line ends with `?` and sits directly above option 1.
- Option rows: optional selection marker `❯`, then `<n>. <label>`, numbered from 1 without gaps (4 options observed).
- A long label wraps onto indented rows without a number; they join the label with one space.
- The closing hint row starts with `Esc to cancel`.
- Pressing the digit alone answers the prompt; no Enter is needed. Esc cancels (the "No" path).
- Labels can contain the user's folder paths: show them in the app only, never log them.
- Other dialogs (the folder-trust question at startup) use `❯` with unnumbered options and
  `Enter to confirm · Esc to cancel`. They are not permission prompts: no buttons; the user answers with the arrow
  keys and Enter.

## 3. Commands, skills and plugins

- A skill folder `<dir>/SKILL.md` becomes `/<name>`, where name is the frontmatter `name` or else the folder name.
- `commands/<file>.md` becomes `/<file>`; a subfolder adds a colon segment (`frontend/component.md` →
  `/frontend:component`). nika 0.3 lists top-level command files only.
- Plugin skills are `/<plugin>:<skill>` and plugin commands `/<plugin>:<file>`; the bare `/<skill>` also works unless
  another command has that name. The plugin name is the part of the `installed_plugins.json` key before `@`.
- The docs only list refused characters for names (control, bidi, private-use and unassigned characters, `<`, `>`,
  blanks other than one space between words). nika lists names matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` and
  skips the rest; they still work when typed.
- `installed_plugins.json` (observed shape): `{ version: number, plugins: { "<name>@<marketplace>": [ { scope,
  installPath, version, installedAt, lastUpdated, gitCommitSha } ] } }`. Each key maps to an array of install
  records. `installPath` points inside `<claude dir>/plugins/cache/`; a plugin folder holds `.claude-plugin/`,
  `commands/`, `skills/` and `agents/`.
- Command menu: typing `/name` highlights the matching command and Enter runs the highlighted one (Claude Code
  2.1.236 and later), so `/ex` + Enter can run `/exit`. After a typo nothing is highlighted and Enter submits the text
  as typed.

## 4. Built-in commands

Name, aliases, what it does (paraphrased from the commands page), argument hint, and whether it opens a dialog or
picker in the terminal (`dialog`). Bundled skills shipped with Claude Code are included because they appear in the
same menu. Removed and hidden commands are left out.

| Command | Aliases | Description | Args | Dialog |
|---|---|---|---|---|
| /add-dir | | Add a working directory to the session | `<path>` | yes |
| /advisor | | Turn the advisor tool on or off | `[model\|off]` | yes |
| /autocompact | | Set the auto-compact window | `[auto\|<tokens>]` | yes |
| /background | /bg | Detach the session to run in the background | `[prompt]` | |
| /branch | | Branch the conversation | `[name]` | |
| /btw | | Ask a side question without adding it to the conversation | `[question]` | |
| /bug | /share | Report a bug or share the conversation | `[report]` | yes |
| /cd | | Move the session to another working directory | `<path>` | |
| /clear | /reset, /new | Start a new conversation with empty context | `[name]` | |
| /code-review | /review | Review the diff, a PR, a branch or a path | `[level] [target]` | |
| /color | | Set the prompt bar color | `[color\|default]` | |
| /compact | | Summarize the conversation to free context | `[instructions]` | |
| /config | /settings | Open settings; `key=value` sets one directly | `[key=value]` | yes |
| /context | | Show context usage | `[all]` | |
| /copy | | Copy the last response | `[N]` | yes |
| /debug | | Turn on debug logging and troubleshoot | `[description]` | |
| /diff | | Review working-tree changes | | |
| /doctor | /checkup | Check the setup and offer fixes | | |
| /effort | | Set the effort level | `[level]` | |
| /exit | /quit | Exit Claude Code | | |
| /export | | Export the conversation as text | `[filename]` | yes |
| /fast | | Toggle fast mode | `[on\|off]` | |
| /feedback | | Send product feedback | `[report]` | yes |
| /fork | | Copy the conversation into a new background session | `[prompt]` | |
| /goal | | Set a goal Claude pursues across turns | `[condition\|clear]` | |
| /help | | Show help and commands | | |
| /hooks | | View hook configurations | | |
| /ide | | Manage IDE integrations | | |
| /init | | Create a CLAUDE.md for the project | | |
| /keybindings | | Open the keyboard shortcuts file | | |
| /list-agents | /peers | List agents and sessions Claude can message | | |
| /login | | Sign in | | |
| /logout | | Sign out | | |
| /loop | /proactive | Run a prompt on an interval | `[interval] [prompt]` | |
| /mcp | | Manage MCP servers and their sign-in | `[reconnect\|enable\|disable [server]]` | yes |
| /memory | | Edit memory files | | |
| /model | | Switch the model | `[model]` | yes |
| /output-style | | List or switch output styles | `[style]` | |
| /permissions | /allowed-tools | Manage allow, ask and deny rules | | yes |
| /plan | | Enter plan mode | `[description]` | |
| /plugin | | Manage plugins | `[subcommand]` | yes |
| /recap | | One-line summary of the session | | |
| /release-notes | | View the changelog | | yes |
| /reload-plugins | | Reload plugins | | |
| /reload-skills | | Re-scan skill and command folders | | |
| /remote-control | /rc | Make the session reachable from claude.ai | | |
| /rename | | Rename the session | `[name]` | |
| /resume | /continue | Resume a session | `[session]` | yes |
| /rewind | /checkpoint, /undo | Rewind the conversation or the code | | yes |
| /sandbox | | Toggle sandbox mode | | |
| /security-review | | Security review of the branch diff | | |
| /simplify | | Review changed code for cleanups and apply them | `[target]` | |
| /skills | | List skills | | yes |
| /stats | | Usage statistics | | yes |
| /status | | Show the status tab of settings | | yes |
| /statusline | | Configure the status line | `[description]` | |
| /stop | | Stop an attached background session | | |
| /subtask | | Start a forked subagent for a side task | `<task>` | |
| /tasks | /bashes | View background work | | |
| /theme | | Change the color theme | | yes |
| /usage | /cost | Cost, plan limits and activity | | |
| /voice | | Toggle voice dictation | `[hold\|tap\|off]` | |

## 5. Ending a session

- `/exit` (alias `/quit`) exits Claude Code. Observed: Claude quit and its tmux pane closed; the tmux session ended
  because it was its last pane.
- The input box is drawn between two rule rows made only of `─`; the input row starts with `❯` followed by a no-break
  space (U+00A0, not U+0020; `capture-pane` and the mirror keep it). Empty, it shows a placeholder such as
  `❯ Try "edit <filepath> to..."`, drawn dim (SGR 2) after the `❯`; typed text is never dim, so a draft that starts
  with `Try "` reads the same but is not dim (checked 2026-11-09). When Claude draws its own cursor (native cursor off
  and the terminal focused, which is the default in tmux), the first placeholder character is drawn in reverse video
  (SGR 7) and the rest dim; with no placeholder the cursor is a reverse-video space (read from the 2.1.319 source, not
  yet seen live: the 2026-11-09 check showed no cursor cell). nika reads a first reverse-video character followed only by
  dim text as the placeholder too. A user status line (free content) and the mode line sit below
  the lower rule.
- After typing `/exit` (no Enter) the box holds one row `❯ /exit`, and the command menu above the box highlights
  `❯ /exit` with `Exit the CLI`; Enter then runs it.
- `C-u` clears only the visual row the cursor is on: on a single line soft-wrapped onto two rows it removed only the
  wrapped tail and left the first row (checked 2026-11-09). With a two-line draft, `C-u` left the first line, and `/exit` typed
  next became the draft's second line (no command menu): Enter would have sent the draft plus `/exit` as a prompt.
- Vim input mode: the mode line starts with `-- INSERT --` in insert mode; in normal mode it shows no prefix at all
  (checked 2026-11-09; §1's `-- NORMAL --` was not seen). `Escape` switches insert to normal. Keys typed in normal
  mode are vim commands: after `Escape`, typing `/exit` and Enter did not exit; Claude received a stray prompt.
- So nika types `/exit` only into an empty input box in insert mode and presses Enter only when the box reads exactly
  `❯ /exit` (contract §3, End).
- A pane nika spawned runs `_run-agent` (node), which writes `.rc` after claude exits and then exits, so the pane
  closes too.
- tmux: `capture-pane -t '=<session>'` fails ("can't find pane"); nika targets panes by `%<n>` only.

## 6. Models

- Latest: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`.
- Older, confirmed in the docs: `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-6`,
  `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`.
- Aliases: `best`, `fable`, `opus`, `sonnet`, `haiku`, `opusplan`, `opus[1m]`, `sonnet[1m]`. What an alias resolves to
  depends on the provider (for example `sonnet` is Sonnet 4.5 on some cloud providers).

## 7. Not verified yet

- The bypassPermissions phrase: starting a bypass session for the check was refused by the checking session's safety
  classifier. nika treats a mode line that starts with the word `bypass` or `bypassPermissions` as
  bypassPermissions; the exact phrase is checked in 0.4.
- Whether transcripts record the permission mode (V12): moved to the 0.4 plan.
- Whether don't-ask is part of the Shift+Tab cycle: nika never switches to or from it.
