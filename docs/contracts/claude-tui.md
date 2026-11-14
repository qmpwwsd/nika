# Claude Code TUI facts nika parses

Checked against Claude Code 2.1.319 on 2026-11-08 (macOS, tmux), in a throwaway session, plus the official docs:
`code.claude.com/docs/en/commands.md`, `skills.md`, `plugins/components.md`, `plugins/loading.md`, `model-config.md`
and the models overview on `platform.claude.com`. Phrases below are typed by hand; no capture, transcript, path or id
is copied here. When Claude Code changes these texts, nika's parsers fail closed (the control hides) and this file is
updated with the new version.

Sections 1, 5 and 10 were checked again on 2026-11-14 against Claude Code 2.1.321 to 2.1.325 (macOS, tmux 3.8, 120-column
panes), also in throwaway sessions. Every sample text in them is made up.

## 1. Footer (mode line)

The mode line is the last non-blank row of the pane while Claude's prompt box is shown. Around the phrase:

- an optional vim-mode prefix: `-- INSERT --` (fg 246). Vim normal mode draws **no** prefix, and plain (non-vim) mode has none
  either, so the two look the same. `-- NORMAL --` was never drawn (checked 2026-11-14, Claude Code 2.1.321 to 2.1.325);
  nika's mode reader still accepts the text, but nothing relies on it;
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
- A missing `-- INSERT --` therefore does not mean "plain mode". nika never infers plain mode from the missing prefix: it
  remembers per pane what it has seen (`-- INSERT --` shown: vim; a probe `i` that landed as text: plain) and, when it
  knows nothing, probes with a literal `i` before it types or clears anything (§10.7).
- Bash mode: when the input box starts with `!`, the mode line's permission phrase is replaced by `! for shell mode`
  (fg 211, after the optional `-- INSERT --`). The footer then reads `unknown` to the mode reader; only the draft reader
  accepts this footer, and only for a box that starts with `!` (§10.1).
- For a few seconds after a large paste, the mode line is replaced by the hint `paste again to expand` (fg 246). The footer
  reads `unknown` for that time, so no draft is read (§10.1).

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

`/autocompact` (0.4): in a session nika started with Settings > Auto-compact on, the launch environment variables `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` take precedence over this command, so it has no effect there (spike S2; ADR 0014). nika does not use the `--autocompact` flag.

## 5. Ending a session

- `/exit` (alias `/quit`) exits Claude Code. Observed: Claude quit and its tmux pane closed; the tmux session ended
  because it was its last pane.
- The input box is drawn between two rule rows made of `─`; the upper one may carry the session name given with `-n` (or
  set with `/rename`), drawn as `─── <name> ─` (checked 2026-11-09, Claude Code 2.1.3xx), so every session nika starts
  has the session name in its top rule. nika accepts a plain rule (two or more `─`) or a labelled one (two or more `─`,
  a space, a label of 1 to 80 characters with no `─`, no control character and no space at either end, a space, one or
  more `─`). The input row starts with `❯` followed by a no-break space (U+00A0, not U+0020; `capture-pane` and the
  mirror keep it). Empty, it shows a placeholder such as `❯ Try "edit <filepath> to..."`, drawn dim (SGR 2) after the
  `❯`; typed text is never dim, so a draft that starts with `Try "` reads the same but is not dim (checked 2026-11-09).
  The 2.1.319 source draws Claude's own cursor as a reverse-video cell (the first placeholder character in reverse video
  and the rest dim, or a reverse-video space with no placeholder), but no such cell was ever seen live (checked
  2026-11-09 and 2026-11-14): the cursor is the terminal's own, and nika reads it from tmux
  (`display-message -p '#{cursor_x},#{cursor_y}'`, the capture's `cursor`; the column right after the last character
  of the draft, 0-based). nika keeps a first reverse-video character followed only by dim text as a tolerance, and reads
  it as the placeholder. A user status line (free content) and the mode line sit below the lower rule.
- The input box in more detail (all checked 2026-11-14, Claude Code 2.1.321 to 2.1.325; the reading rules are §10):
  - Claude 2.1.325 pads every row of the box with real spaces up to the pane width (the mirror captures with
    `capture-pane -N`, which keeps them). An empty row of a multi-line draft has no padding, and the last row is sometimes
    padded only part of the way. The padding says nothing about spaces the user typed; the cursor column does.
  - Typed text has no colour of its own (only a leading reset). The placeholder and every grey hint are dim (SGR 2).
    A slash command word that Tab completed is fg 153.
  - Bash mode: the glyph `!` (followed by U+00A0 too) replaces `❯`, both rule rows turn fg 211, and the mode line
    reads `! for shell mode`. The box text is what follows the glyph. A draft whose first typed character is `!` switches
    the box to bash mode and the `!` moves to the glyph. `C-u` in bash mode clears the text but stays in bash mode;
    `BSpace` on the empty bash box leaves it.
  - Prompt history: `Up` or `Down` on the first or last row of the draft recalls an older prompt. The top rule becomes
    `─── History 17/17 ───…`, the box shows the old entry, and the real draft is kept aside and returns with `Down`.
  - Large input: `send-keys -l` (and a bracketed paste) of more than 800 characters, or of 3 or more newlines, is shown as
    `[Pasted text #N]` (one line) or `[Pasted text #N +K lines]` (K = the number of newlines). 800 characters and 2 newlines
    stay real text; 801 characters and 3 newlines do not. A trailing newline counts. N counts up over the session. The
    real text cannot be read back from the screen. `[Image #N]` is drawn the same way. A literal `[Pasted text #1 +10
    lines]` typed by the user looks identical. Three `send-keys -l` calls of 384 characters, 300 ms apart, stayed real
    text; one `-l` call of 895 characters did not.
  - A tab in a paste is drawn as 4 spaces.
  - Escape in the box: one `Escape` on a non-empty plain box does not clear it; it shows the hint `Esc again to clear ·`
    (fg 246, in the row above the top rule) for about 800 ms. A second `Escape` at least 60 ms later clears any draft. In
    vim insert mode the first `Escape` leaves insert mode and keeps the draft, and `Escape Escape` never clears it. An
    `Escape` followed by another key within about 20 ms is read as Meta+key and the rest is typed as text; gaps of 40 ms
    and more were safe. On an empty box a second `Escape` may open Rewind (not tested).
  - `C-c` clears any draft with one key, but it arms "exit on the second `C-c`" (`Press Ctrl-C again to exit`, for about
    800 ms) and puts the cleared draft into the prompt history. nika never sends `C-c` to a draft.
  - Window: a draft taller than the box is shown as a window of 14 rows that scrolls with the cursor; the first visible row
    still carries the glyph, and the mode line can fall off the bottom of a 39-row pane.
  - Wrap: the usable width is the pane width minus 4 (116 at 120 columns); continuation rows (after a soft wrap or a hard
    newline) are indented by exactly two spaces; no marker is drawn at a soft wrap (§10.4).
  - Transient hint rows above the top rule (`Ctrl+Y to paste deleted text`, `Esc again to clear`, `ctrl+g to edit in
    Nvim`, `paste again to expand`) sit outside the box and are never read as part of it.
  - `/vim` does not exist (`Unknown command: /vim`). Vim input is the `/config` setting "Editor mode" (`normal` or `vim`).
- After typing `/exit` (no Enter) the box holds one row `❯ /exit`, and the command menu above the box highlights
  `❯ /exit` with `Exit the CLI`; Enter then runs it.
- `C-u` clears only the visual row the cursor is on: on a single line soft-wrapped onto two rows it removed only the
  wrapped tail and left the first row (checked 2026-11-09). With a two-line draft, `C-u` left the first line, and `/exit` typed
  next became the draft's second line (no command menu): Enter would have sent the draft plus `/exit` as a prompt.
  `C-k` acts on the visual row only too, and from the end of an N-line draft `C-u` needs 2N − 1 presses (text, then the
  newline), plus one per extra wrapped row (checked 2026-11-14). No single `C-u`, `C-k`, `End C-u`, `C-e C-u` or `C-a C-k`
  clears a wrapped or multi-line draft.
- Vim input mode: the mode line starts with `-- INSERT --` in insert mode; in normal mode it shows no prefix at all
  (checked 2026-11-09 and 2026-11-14; `-- NORMAL --` is never drawn, §1), and plain mode has no prefix either. The draft
  rows are identical in both vim modes. The terminal cursor is after the last character in insert mode and on the last
  character in normal mode. `Escape` switches insert to normal. Keys typed in normal
  mode are vim commands: after `Escape`, typing `/exit` and Enter did not exit; Claude received a stray prompt.
- Interrupting a turn in vim insert mode (Claude Code 2.1.319, checked 2026-11-09, vim mode on, while Claude worked):
  the last row of the footer starts `-- INSERT --`, and the first `Escape` only leaves insert mode; Claude keeps working.
  A second `Escape` (now normal mode) interrupts. Without vim, or in normal mode, one `Escape` interrupts. nika's Stop
  and End send the first `Escape`, wait for `-- INSERT --` to go and send the second only if the registry still says busy.
- After an interrupt the row right above the input box reads `⎿  Interrupted · What should Claude do instead?`. An
  interrupt during thinking puts the user's prompt back into the input box. The registry went `idle` within 2 s. nika
  does not parse the Interrupted row; it waits for the registry state and the empty-box check.
- `/` typed in vim normal mode with an empty box does not type a slash: it opens a history search (checked 2026-11-09,
  2.1.319). The input box is replaced by a list, a box row `⌕ Filter history…` and a hint row
  `↑/↓ to navigate · Enter to use · Esc to cancel · ctrl+s to scope · Esc i / for slash commands`. One `Escape` closes it
  and the empty input box returns. nika types a command's first character `/` alone when it has no evidence of vim, and
  reads the screen: the box reads `/` (plain input), or a row holds `Esc i / for slash commands` (history search: one
  `Escape`, then `i` and the usual insert road), else it removes its `/` and refuses (contract §3, command).
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

## 8. Registry status

- The `status` of a live session in `sessions/<pid>.json` is one of `busy`, `shell`, `idle` and `waiting` (Claude Code 2.1.321,
  checked 2026-11-13; the list is Claude's own vocabulary list). Claude's agent list labels `busy` and `shell` both "Working"
  and `waiting` as blocked.
- `shell` = the turn is over and a background shell is still running (the footer reads "1 shell still running"). nika reads
  `shell` as `busy` (`src/model.js`): the agent's `state` is `busy` and `attention` is null, so it shows as Working, sending
  is allowed and the quick actions stay off. Session control already treats any non-idle state as busy (Stop, End and the mode
  switch), so it needs no special case.
- `waiting` and any value nika does not know stay as they are: `state` is the cleaned status and `attention` is set (needs you).

## 9. Registry procStart

- `procStart` in `sessions/<pid>.json` identifies the process, so nika can tell a live session from a reused pid. Its format
  depends on the system (checked 2026-11-13, issue #14); nika first compares it with `ps`'s text as is, then as an instant:
  - Digits (Linux): the `starttime` of the process (field 22 of `/proc/<pid>/stat`, in clock ticks since boot), such as `3304488`.
    It never equals the `ps` date, so nika compares it with the `starttime` it reads from `/proc/<pid>/stat` itself
    (`parseStarttime`, `procStarts` in `src/collect/registry.js`), only on Linux and only for the registry pids whose `procStart` is
    digits and that `ps` listed. Field 2
    of that file (the command name) may hold spaces, parentheses and newlines, so the fields are counted from the text after the
    last `)`: field 22 is the 20th token there, and a line with 20 tokens or fewer there is cut short and not trusted.
  - A date string `Www Mmm d hh:mm:ss yyyy` (macOS), such as `Sat Nov  7 18:57:14 2026`: nika takes the instant `ps -o lstart=`
    prints, which it asks for in the C locale with `TZ=UTC`, writes it out in that shape in UTC and in local time, and the
    session is alive when `procStart` (whitespace squashed) equals either text (the writer's clock is not settled). The local
    string is never parsed back, so both passes of a repeated DST hour match. The local form is read in nika's own time zone, so a
    Claude run with a different `TZ` than nika's reads as ended.
  - An ISO 8601 date-time (it starts `YYYY-MM-DDT`, with or without an offset) that `Date.parse` accepts: compared with the `ps`
    instant to the second.
  - Any other string, one `Date.parse` rejects, or a `ps` text that is no date, counts like a missing `procStart`: the session is
    alive when `ps` lists the pid. (V8 also reads text such as `hello 1` as a date; nika does not.)
- A parsed instant (or a readable `/proc` value) that differs from the process is a reused pid: not alive.
- When `/proc/<pid>/stat` cannot be read or parsed (another user's process, a race with exit, a cut line) the session counts as
  alive, because `ps` listed the pid.
- With no `ps` table (`ps` failed or printed nothing) nika uses signal 0 for liveness and does not read `/proc`.
- A registry file that is unreadable, not JSON, over 64 KB or without a `pid` and a UUID `sessionId` is skipped; a file that is
  gone by the time nika reads it (Claude deletes it when the session exits) is not counted. An upper-case
  UUID is accepted and kept in lower case. nika counts the skipped files (`snapshot.skipped.registry`) and says so: `nika status`
  prints "N session files skipped (unreadable or not in Claude's format)" and the dashboard shows the same text as a muted note.

## 10. Input box and draft (0.5)

How nika reads the text in Claude's input box (the draft) and writes it, from `src/draft.js` (reading, pure) and
`writeDraft` in `src/session-control.js` (writing). Facts checked 2026-11-14, Claude Code 2.1.321 to 2.1.325, tmux 3.8, panes
of 100 and 120 columns, with made-up text. The contract of the route is `api-app.md` (`PUT /api/app/pane/:id/draft`);
the reasons are in `docs/security.md` (T51). The reader fails closed: a screen it does not fully understand is
"no plain box" (null) or "unreadable", never a guess.

### 10.1 Where the box is (no plain box: null)

The box is the rows between the **last two** rule rows of the pane (§5 for the rule shapes; a rule row is read at column 0,
so a draft line of dashes, which has two spaces before it, is not a rule). The reader returns null (no draft, the mirror
shows every row) when any of these holds:

| Condition | Why |
|---|---|
| the mode line is unknown: a permission prompt, a dialog or an unknown footer replaces it (§1), including the transient `paste again to expand` hint | a dialog that draws `❯ 1. Yes` between two `─` rows must never be read as a draft |
| the footer is `! for shell mode` but the box does not start with `!` (that footer is accepted only for a bash box) | §1 |
| a permission prompt parses on the screen (§2) | redundant with the footer rule; it is the T51 anchor |
| fewer than two rule rows, or nothing between the last two | no box |
| the terminal cursor lies outside the rows of the box (not between the two rules) | the input is where the cursor is: a box the cursor is not in may be a user's status line, and no write or Enter may go by it (review finding N-1) |
| the first box row does not start, after at most 2 spaces, with `❯` or `!` followed by U+00A0 or by nothing but padding | Claude always draws a no-break space after the glyph. A plain space is not Claude's box: a user's status line such as `❯ main` followed by a rule-shaped row would otherwise be taken for it (review finding I-1) |

The slash menu is drawn above the top rule (about 5 rows) and leaves the mode line (checked 2026-11-14, Claude Code 2.1.325, by a
live look at the open menu), so a draft such as `/com` reads as text and `mode` and `draft` read as usual while the menu is open.
A box that holds `[Image #N]` or `[Pasted text #N]` is readable but unreadable as a draft (§10.6).

### 10.2 Rows

| Row | Shape | Meaning |
|---|---|---|
| top rule | a rule row; a label that matches `History <n>/<m>` | the label means prompt-history recall: unreadable (`history`) |
| first row | up to 2 spaces, `❯` or `!`, U+00A0, the body | the mode is `prompt` (`❯`) or `bash` (`!`); the body is the first visual row of the draft |
| continuation | exactly two spaces, then the body; or only spaces | the next visual row of the draft, or an empty line of it |
| anything else | | unreadable (`layout`) |

The padding Claude adds to every row (§5) is cut off: it is the run of spaces after the last visible character of the row
(ghost text included). A space before a ghost run is not padding (`/compact ` keeps the space that Tab typed).

### 10.3 Ghost text (not part of the draft)

| Run | Rule |
|---|---|
| dim (SGR 2) | ghost: the `Try "…"` placeholder and Claude's other grey hints |
| a first body character in reverse video with only dim text after it | ghost (the cursor drawn over the placeholder; never seen live, a tolerance) |
| fg 246 and not dim, starting at or after the cursor column on the cursor row | ghost: the argument hint Claude draws after Tab completes a slash command (for example `/compact ` followed by a grey hint, checked 2026-11-14) |
| everything else, in any colour (the fg 153 command word included) | real text |

Dim text next to real text is accepted in one place only: a single trailing run that starts exactly at the cursor column
on the cursor row. A dim run anywhere else beside real text would be invisible to nika but sent by Enter, so the draft is
unreadable (`layout`). The draft carries `ghost: true` when any dim, reverse-video or hint cell of the box was dropped.
End and the quick-action commands refuse to press Enter on a box with `ghost: true`, because what Enter does with a
completion ghost is untested. Pasted escape sequences are drawn as caret text (`^[[2m`), never as styling. The column
of a run is the sum of the cell widths before it (wide East Asian characters 2, combining 0); a miscount can only make a
hint survive into the text, which the read-back then refuses.

### 10.4 Joining the rows into the text (the wrap rule)

Usable width `w` = pane columns − 4 (116 at 120 columns, 96 at 100). Claude wraps each hard line like wrap-ansi
(`hard: true, trim: false`) at `w`, and then **draws every wrapped row without its leading whitespace**: when a row is full
to `w`, the space that would start the next row is counted for the break but not drawn (checked 2026-11-14: 100 × `ab` at 120
columns is drawn 116 / 113 / 68 cells, rows 2 and 3 start at `ab`; a short word followed by a 125-letter word is drawn
116 / 20; `x` × 116 followed by ` foo` is drawn 116 / 3 with the space gone). A word longer than `w` is cut at `w` and
continues on the next row with no space. A wide character that does not fit moves to the next row, which leaves the full
row one cell short. A hard line keeps its own leading spaces (`  hello` shows both).

nika joins row `a` and the next row `b` (bodies, after the indent and the padding) with `lost` = 1 when a space dropped
from the start of `a` still counts toward it, else 0, and `wa` = width(`a`) + `lost`:

| Case | Join |
|---|---|
| `b` starts with a space, `a` or `b` is blank, or `wa` > `w` | a newline (a drawn wrap never starts with a space) |
| `a` is full (`wa` + width of `b`'s first character > `w`) and width(last word of `a`) + width(first word of `b`) ≤ `w` | a space (a soft wrap), and `lost` = 1 for `b` when `wa` = `w` |
| `a` is full and the two words together are wider than `w` | a **cut word** (nothing between) when `a` holds no space (one word fills the row) or the junction is a wide character; otherwise the draft is **unreadable** (`layout`, §10.6) |
| `a` is not full and `wa` + 1 + width(first word of `b`) > `w` | a space (a soft wrap) |
| otherwise | a newline |

The unreadable row is the N-3 finding: a word cut at `w` and two long words with a space between them (whose space Claude
dropped from the start of the next row) are drawn as exactly the same two rows, and rows alone cannot tell which was typed.
nika does not guess: it pauses the sync and never writes over the draft. A wide character at the junction is what leaves a row
short, so there a cut word is the only reading.

Rows alone cannot always tell a hard newline from a soft wrap either, and the text that comes out then differs from what was
typed. These cases are read as the other thing on purpose and end in a 409 `draft-mismatch`, never in a wrong key:

- a hard newline typed where the next word would not have fitted anyway (it reads as a soft wrap), including a hard line of
  exactly `w` cells followed by a newline;
- a full row that is one word of exactly `w` followed by a space and a word, and the same at a wide junction (read as a cut
  word: the space is lost);
- a double space at a wrap (it reads as one);
- a full row, a space and a word that does not fit behind it (Claude draws an empty row between them; it reads as newlines).

The page adopts the screen's text after such a 409, so the next replace writes that text back: one character of the draft is
really changed (a space, or a line break).

The number of rows a text needs (the 13-row bound of §10.9) uses the same break model.

### 10.5 Cursor

The cursor comes from tmux (`#{cursor_x},#{cursor_y}`, 0-based); no cursor cell is drawn. `end` = the column right after the last
real character of the last box row.

| Cursor | Result |
|---|---|
| on the last box row, column = `end` | `cursorAtEnd`: plain mode and vim insert mode (the cursor is after the last character) |
| on the last box row, column = `end` − 1 | not at the end (vim normal mode sits on the last character) |
| on the last box row, column > `end` | unreadable (`trailing`): spaces typed at the end are invisible, the cursor column shows them |
| anywhere else, or no cursor | not at the end (a mid-text edit) |

Trailing spaces with the cursor elsewhere cannot be seen; that is accepted. The cursor must also lie on a row **inside** the box
(`box.top` < `cursor.y` < `box.bottom`): the input is where the cursor is, and a box the cursor is not in may be a status line.
A capture whose cursor lies outside the parsed box therefore has no box at all (null, §10.1), and End, the commands, the draft
writer and the suggestion accept all refuse. The writer checks it again before every key. A capture that carries no cursor
position at all has no box either: the capture-side reader (`readDraft`) returns null. `parseDraft` called without a cursor
still reads the rows (pure callers and tests).

The cursor stays inside the box while Claude works (checked 2026-11-14, Claude Code 2.1.325, three turns): with the box empty
the cursor sat at column 2 of the first box row, and with `abc` typed during a turn at column 5, in every sample (8 samples in
each of two turns and 5 in the third, spinner rows above the box); one frame without a spinner row kept it there too. A busy frame
with the cursor outside the box was not seen.

### 10.6 States

| `state` | When |
|---|---|
| `empty` | the joined real text is empty (only ghost text, or nothing) |
| `text` | otherwise, unless unreadable |
| `unreadable` | with the first `reason` that applies, in this order: `history` (a `History n/m` top rule), `layout` (a row shape of §10.2, dim text beside real text, or a wrap that reads two ways, §10.4), `tall` (14 or more box rows: a 14-row box may be a scrolled window), `pasted` (`[Pasted text #N]`, `[Pasted text #N +K lines]` or `[Image #N]` anywhere in the text or in the dim text, wraps and newlines inside it ignored; a typed literal looks the same, so it fails closed), `trailing` (§10.5) |

An unreadable box is never written over. Its `text` is `''` and it has no `sig`. The `sig` of a readable box is the first 16
hex characters of sha256 over the state, the mode and the text, so a redraw with other SGR or another cursor keeps it.

### 10.7 Edit mode (vim or plain)

Vim normal mode and plain mode draw the same screen (§1). nika reports `edit` from the rows and a per-pane memory:

| `edit` | When |
|---|---|
| `insert` | `-- INSERT --` is shown now |
| `normal` | not shown, but INSERT was seen on this pane before |
| `plain` | not shown, and a probe `i` landed as text on this pane before |
| `unknown` | neither |

Seeing `-- INSERT --` sets "vim" and drops "plain"; a probe that lands as text sets "plain" and drops "vim"; a failed clear
drops both. The memory is dropped when the pane leaves the eligible set. A stale memory corrects itself: every write is read
back, and `normal` and `unknown` start with the probe.

**The probe**: one literal `i`. In vim normal mode it is a command and `-- INSERT --` appears with the text unchanged; in plain
mode and in insert mode it is text and the box shows one more `i`. The writer waits up to 4 reads, 150 ms apart.

### 10.8 Replacing a draft (what the writer sends)

A replace needs the registry state `idle` (an `Escape` can interrupt a running turn). Appending to a draft, or typing into an
empty box, sends no `Escape` and may run while Claude works.

| Edit mode | Keys, in order | Waits |
|---|---|---|
| `insert` | `Escape`, the text `ggdG`, the text `i` | after `Escape`, until `-- INSERT --` is gone **and** 40 ms have passed (polling every 20 ms, at most 400 ms; else 409 `mode-unknown`); after `i`, until the box is empty and `-- INSERT --` is back (at most 400 ms) |
| `normal` or `unknown` | the probe `i` first; then as `insert` when INSERT showed, or as `plain` when the `i` landed as text | the probe wait above |
| `plain` | `Escape`, a gap of at least 60 ms, a second `Escape` **only while text still shows** | until the box is empty and 40 ms have passed since the last `Escape` (at most 600 ms) |
| any, empty box, the probe `i` landed in it | one `C-u` (removes the probe's own `i`, one row) | until the box is empty |
| any, the box is an empty `!` box and the new text does not start with `!` | one `BSpace` (leaves bash mode) | until the glyph is `❯` and the box is empty |

Evidence (spike S9): the vim sequence emptied the box in 8 of 8 cases (short, wrapped, three lines, wrapped plus lines,
cursor in the middle; started from insert and from normal mode), about 126 ms median and 138 ms at most; with the `Escape` and the next key
0 ms and 20 ms apart the stray text `gdGi` stayed in the draft in 5 of 5 runs, 40 ms, 60 ms and 100 ms worked in 5 of 5. The plain
sequence emptied any draft in about 168 ms median, 177 ms at most. All 60 timed runs (clear, type, read back) read back
correctly. A draft of 51 lines in vim failed (the mode line was off the screen, so the wait for `-- INSERT --` to go returned at
once): the 14-row bound exists for that.

Slash menu: while Claude's slash menu is open, the first `Escape` of a replace only closes the menu. The write answers 409
`mode-unknown` and nothing is typed; the retry works.

Never sent by the writer: `Enter`, `C-c` (it arms exit and moves the draft to history), `Up` and `Down` (history recall),
`C-k`, `Tab`, `BTab`, a digit as a key, a second `Escape` on an empty box (Rewind), any key within 40 ms of an `Escape` (its own, or the
`Escape` of a Stop or End), and any key at all while Stop or End is interrupting the pane. `C-u` is used for one thing only: removing the writer's own probe `i` from an
empty box.

### 10.9 Typing

- A text is at most 1024 characters, 12 newlines and 13 estimated rows (the sum over its lines of the rows a wrap at `w` needs,
  §10.4), and holds no run of 699 or more spaces and tabs. Trailing spaces and tabs of the whole text are not typed (they would
  make the box unreadable, `trailing`).
- It is split into chunks of at most 700 characters and at most 2 newlines (a chunk ends right after its second newline), never
  inside a surrogate pair, and no chunk ends in a space or a tab (a cut that falls inside such a run moves in front of it).
- A chunk without a newline or tab goes as `send-keys -l -- <text>`; a chunk with one goes as a bracketed paste (at most 2 newlines
  stay real, §5). Chunks go 300 ms apart.
- A text that starts with `!` into a `❯` box is typed as it is (the `!` moves to the glyph); into an empty `!` box it is typed
  without its first `!`.
- Before **every** key or chunk a fresh capture must still show a plain box with the cursor in it, no permission prompt, and
  exactly the text the previous step left.
- Append: when the cursor is at the end, the new text starts with the old one, and Claude is in insert mode (or in remembered plain
  mode and the old text does not end in a newline), only the new part is typed. On an empty last row vim normal mode draws the same cursor as insert mode, so only a shown `-- INSERT --` allows an append there.
- Timing (S9): append about 16 ms plus the read-back, vim replace about 130 ms, plain replace about 170 ms, each further chunk
  plus 300 ms.

### 10.10 Prompt suggestion

Claude can show a suggestion for the next prompt in an empty input box (checked 2026-11-14, Claude Code 2.1.321 to 2.1.325, plain
and vim insert mode, made-up text).

- **Look.** The suggestion is drawn exactly like the `Try "…"` placeholder: dim text (`SGR 2`) right after `❯` and the no-break
  space, with the cursor staying at column 2, before the ghost. The only differences are the text and the time: the example
  `Try "…"` shows only until the first prompt of a session is submitted, and a real draft that starts with `Try "` is not dim.
  nika tells them apart by the text: the draft's `suggestion` is the dim text of an empty box, cut by `clean()` to 200
  characters, and `null` when it starts with `Try "`. A suggestion that wraps onto a second row is joined; a row that holds only
  ghost text is not a line of the draft.
- **When.** It does not appear after trivial turns (two "reply with one word" turns: nothing after 40 s and 45 s). After a turn
  whose reply invites an answer it appeared 2.4 s after Enter, and after a second turn in another session; in a third check,
  three turns (one with letters typed during it) produced none. Whether Claude shows one cannot be relied on.
- **Taking it.** `→` (Right) and `Tab` took the suggestion into the box in plain mode; after that the box holds the text as real
  text with no SGR, and the cursor is at its end. Not tested live: `→` and `Tab` in vim insert mode, and nika's accept route on
  a real suggestion (the owner checks it). What `Enter` submits on an empty box that shows a suggestion is not verified either;
  nika's Send with an empty message box still presses `Enter` alone.
- **Leaving.** Typing one or two characters, or a paste into the empty box, removes the suggestion; emptying the box again brings
  it back until a slash command is run (after `/config` it was gone) or a new turn starts.
- **`Tab` without a suggestion.** On an empty box that shows only the `Try "…"` example (or nothing), `Tab` changes nothing in
  the box, the footer or the mode; it flashes a hint row above the top rule for about 3 s (`Use opt+t to toggle thinking`
  replaced a status row). nika never sends `Tab` unless a fresh capture shows the suggestion it is about to take
  (`api-app.md`, `POST /api/app/pane/:id/suggestion`).
- **Slash command argument hint.** After `Tab` completes a command word (fg 153) and a space, Claude draws a grey argument hint
  in fg 246, not dim, after the cursor; typing any character removes it. It is ghost text (§10.3), not a suggestion.

### 10.11 Not verified

- Plain-mode replace and append were exercised against a fake pane only (the Claude of the checking session was in vim mode).
- `→` and `Tab` in vim insert mode, `Tab` in vim normal mode, and `Tab` and `Enter` on a real suggestion through nika's accept route and Send (the owner checks
  them).
- A very long suggestion (does it wrap or is it cut), a draft that wraps in the middle of a wide character, and `Escape Escape` on
  an empty box (does it open Rewind, and does it save the draft to history).
