# Claude Code TUI facts nika parses

Checked against Claude Code 2.1.319 on 2026-11-08 (macOS, tmux), in a throwaway session, plus the official docs:
`code.claude.com/docs/en/commands.md`, `skills.md`, `plugins/components.md`, `plugins/loading.md`, `model-config.md`
and the models overview on `platform.claude.com`. Phrases below are typed by hand; no capture, transcript, path or id
is copied here. When Claude Code changes these texts, nika's parsers fail closed (the control hides) and this file is
updated with the new version.

Sections 1, 5 and 10 were checked again on 2026-11-14 against Claude Code 2.1.321 to 2.1.325 (macOS, tmux 3.8, 120-column
panes), also in throwaway sessions. Every sample text in them is made up. The subagent list under the footer (§1) and the
feedback survey rows (§10.1) were checked on 2026-11-14 against 2.1.325, at 120 and 60 columns. §10.12 (input while Claude works) was
checked on 2026-11-15 against 2.1.325 (macOS, tmux 3.8, 120-column panes), also with made-up text. §11 (attachments) and §12 (scrolling
Claude's view) were checked on 2026-11-14 and 2026-11-15 against 2.1.325 (macOS, tmux 3.8, panes of 120 to 130 columns), with synthetic
files and made-up text. §13 (question dialogs and plan approvals) was checked on 2026-11-14 and 2026-11-15 against 2.1.325 (macOS, tmux
3.8, panes of 40 to 130 columns), with made-up questions; the agent-list and `<n> shells` pill facts in §1 were checked again the same days.
§14 (the files of Claude's own subagents) was checked on 2026-11-15 against 2.1.325 (macOS, a private tmux server, a throwaway git project, Haiku),
and it reads only the throwaway session's own `subagents/` folder.

Claude's task list and the session-name rule under a dialog or a permission prompt (§1, F13), the `│ ` bar and the pane-wide rows of a long
question (§13.1, §13.5), the plan approval footer of 2.1.325 (§13.3), a pasted path and `C-u` (§11), the feedback survey's rows (§10.13) and what tmux
answers to the give with a layout (§15) were checked on 2026-11-16 against Claude Code 2.1.325 and tmux 3.8 (macOS, private tmux servers, throwaway
projects, Haiku), with made-up text. The orchestrator's own long-running Claude 2.1.319 was not re-checked.

Claude Code 2.1.326 draws the task list in another form (§1, F13) and the review step's question rows with the `│ ` bar (§13.1, §13.2). Both were checked on
2026-11-17 (spike S-T326, Claude Code 2.1.326, tmux 3.8, macOS, a private tmux server, a throwaway git project, Haiku, 120-column panes, 45 rows unless a
row says otherwise), with made-up text, and found in a live check of the same day (LC17). A second live check of the same day (LC18, a build with the readers
below) read both shapes in a named and an unnamed session and in a pane of 13 rows. Every such paragraph says "2.1.326, spike S-T326".

## 1. Footer (mode line)

The mode line is the last non-blank row of the pane while Claude's prompt box is shown, **not counting a list of background
subagents drawn under it** (below). Around the phrase:

- an optional vim-mode prefix: `-- INSERT --` (fg 246). Vim normal mode draws **no** prefix, and plain (non-vim) mode has none
  either, so the two look the same. `-- NORMAL --` was never drawn (checked 2026-11-14, Claude Code 2.1.321 to 2.1.325);
  nika's mode reader still accepts the text, but nothing relies on it;
- an optional suffix: ` (shift+tab to cycle)`, then ` · ← for agents`; while the parent is busy with background subagents, and
  after they finish, also ` · /tasks to see subagents` (nika ignores suffixes); 2.1.326 (spike S-T326) also drew ` · ctrl+t to hide tasks` and ` · ← <n> agent`
  (F13, below), and they change nothing either;
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

### Subagent list under the footer (F2)

While background subagents run, Claude draws a list of them **below** the footer, so the mode line is no longer the last row:

```
  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)
(one blank row)
  ⏺ main
  ◯ Explore  <label, cut with … when too long>             14s · ↓ 23.3k tokens
  ◯ Explore  <label>                                        3s · ↑ 300 tokens
  ↓ 3 more
```

nika's reader (`footerEnd` in `src/mode.js`, behind `lastNonBlank`, so the mode, the `-- INSERT --` prefix, `! for shell mode` and
the history hint all follow) leaves the block out **only when every one of these holds**; otherwise nothing is cut and the footer
reads `unknown` (fail closed):

1. The last non-blank row may be the overflow row `  ↓ <n> more` (two spaces, `↓`, a number, `more`); it is accepted only there.
2. Above it, one or more agent rows: two spaces (or the hover pointer, below), `◯`, one word (the agent type), two spaces, the
   label, a space, then the elapsed time (`5s`, `1m 11s`, `2h 3m 4s`) and, optionally, ` · ↑ <n> tokens` or ` · ↓ <n> tokens`
   (`<n>` is digits with at most one dot and an optional `k` or `m`). A row is recognised by this fixed prefix and suffix, never
   by the label: the label is text the model writes.
3. Above them, exactly `  ⏺ main` (two spaces, or the hover pointer, below). Across `main` and the agent rows at most one row
   starts with the pointer; two or more leave the block uncut.
4. Above that, exactly one blank row.
5. Above that blank row, a mode line (a footer token of the table above, a `bypass` footer, or `! for shell mode`) **or the last row
   of one of Claude's question, review or plan dialogs** (`isDialogEnd` in `src/mode.js`: the question footer `Enter to select · …
   to navigate`, the review step's `2. Cancel`, the plan approval's `ctrl+g to edit in … · …`). This last gate means a label can never
   stand in for a footer, and a permission prompt (its closing hint `Esc to cancel` alone is not a dialog end) or any other screen with
   something shaped like a list below it is left alone (not cut, so not read, so not guessed).

What was seen live (Claude Code 2.1.325, 120 and 60 columns, made-up tasks): the list appears as soon as a subagent starts, with the
parent idle or busy, and with text in the input box (the cursor stays in the box); a finished agent leaves the list at once and the
whole block goes when none is left; at most five agent rows, then `  ↓ <n> more` (later `  ↓ <n-1> more`), never a sixth row; the
label changes while the agent works; at 60 columns the label and the footer are cut with `…` and no row wraps; `⏺ main` is bold and
the agent rows are fg 246, but nika reads text only. In a pane of 5 to 11 rows tmux clips Claude's bottom, so footer and list are
simply not on the screen.

Hover pointer (Claude Code 2.1.325, 171 x 45 and 120 x 40, spike D1-S): on the `⏺ main` row or an agent row under the mouse, columns
0-1 read `❯` (U+276F) and then a plain space (0x20; the input box uses a no-break space, the list does not) instead of two spaces.
Only that row changes (an agent row loses its grey; `main` stays bold), at most one row at a time, and the mode line, the box and the cursor stay as they were,
so the box keeps the keys. The pointer was never on the overflow row, not with the mouse over it and not with the selection
scrolled past the fifth agent. nika accepts the pointer in gates 2 and 3, on one row at most, so the footer reads the same with or
without it.

Keyboard selection (Down from the box goes to the footer's `<n> shells` pill, then to `main`, then down the agents) draws a selected
row exactly like a hovered one, but the mode line is replaced by a hint (`↑/↓ to select` on `main`; on an agent
`Enter to view · x to stop · ctrl+x ctrl+k to stop all agents`), and the cursor is hidden and parked at column 0 of the last row of
the pane (seen with an idle box and a `<n> shells` pill on the footer). Gate 5 therefore refuses the screen (no mode line above the blank row: nothing is cut, the footer reads `unknown`), and
the box reader refuses a cursor outside the box.

Facts for the three places the keyboard selection can sit (Claude Code 2.1.325, tmux 3.8, a 120-column pane, made-up text; 0.5 fix round F1/F2):

- **On `main` or an agent row** (the list has the focus): the hint row replaces the mode line (`↑/↓ to select · Enter to view · x to stop · ctrl+x ctrl+k to stop all agents`
  on an agent row, `↑/↓ to select` alone on `main`), the cursor is hidden and parked at column 0 of the last row of the pane, and the
  footer reads `unknown`.
- **On the `<n> shells` pill** (one `Down` from the box): the pill is drawn in reverse video (`ESC[7m1 shell ESC[0m` in a colour capture)
  and the mode line is still drawn and still reads (`manual mode on · 1 shell`). The cursor is parked at column 0 of the last row,
  like on the list, so the box reader finds the cursor below the box's bottom rule and the draft is `null`. `BTab` cycled the mode
  correctly from there (manual, accept edits, plan, auto). `Enter` opens the Background dialog and sends nothing.
  **A typed key leaves the pill selection**: on 2.1.325 the typed text went to the input box and Claude ran it as an ordinary message.
- **During a question dialog** (§13) `Down` walks option 1, 2, 3, the free-text row and `Chat about this` and stops there; it never reaches the
  pill or the list.

nika's rules from these facts. The mode line still reads with the pill selected, so a mode switch is allowed (it re-reads the footer after every
press and stops on a footer it does not know). A draft write or a submit without a `base` is refused when the cursor sits **below** the input
box's bottom rule (409 `input-unreadable`, F2, `api-app.md`); a cursor above the top rule keeps its older meaning. The page refuses a Send
while the footer is unknown and no readable box is on screen, and types nothing (F1, spec §9.12).

Not seen, so read as `unknown`: `↑ <n> more`, a wrapped label, a different glyph or a no-break space after the pointer, and a
permission prompt drawn with the list below it. Not tried: keyboard selection during a busy turn or with no `<n> shells` pill. A question
or plan dialog with the list below it was never seen live (§13.5).

**Known limit (fail closed).** A permission prompt, or a dialog whose last row nika does not know, with the subagent list under it
stays `unknown` (its footer is not the last row, and gate 5 does not hold for it). nika then reads no prompt, so it cannot answer it
from the page, and the mode switch, End and the commands stop on the unrecognized footer without typing; the user answers it in the
terminal. This is the intended direction: the alternative, reading a prompt with something below it, is the guess the reader refuses
to make. A question step, the review step or a plan approval with the list under it is the exception: `treeEnd` cuts the list when
the row above the blank row is the dialog's last row (gate 5, `isDialogEnd`), so the dialog's own footer is the last row and the dialog
readers see it as they would without the list. That case is covered by fixtures only (`test/mode.test.js`); it was never seen live
(§10.11). The auto-mode nudge is anchored on its own exact rows (`nudgeFooterAt`), and what hangs under it is cut the same way.

### Claude's task list and the session-name rule under a dialog or a prompt (F13)

Claude draws its task list in the bottom block of the pane. While a question, review or plan dialog or a permission prompt is open, that block sits
**under the dialog's last row** instead of under the input box, so the dialog's own footer is no longer the last row and the readers (§2, §13) used to
fall back to the banner. Checked 2026-11-16 on Claude Code 2.1.325, tmux 3.8 (macOS, a private server, Haiku, made-up task labels), at 30 to 60 rows
and 64 to 120 columns (spike S-F13). A permission prompt in a named session, 120 x 45, four tasks:

```
 Do you want to proceed?
 ❯ 1. Yes
   ...
   4. No
(blank)
 Esc to cancel · Tab to amend
(three blank rows)
──────────────────…──── <name> ─          a rule row at column 0, labelled with the session name (110 dashes + the name in 120 columns)
(blank)
  4 tasks (1 done, 1 in progress, 2 open)
  ✔ Gather flour
  ◼ Mix dough
  ◻ Bake loaves
  ◻ Slice bread
```

- **Where it sits.** Under a permission prompt's footer (`Esc to cancel · Tab to amend`), a question step's footer (either form, §13.1), the review
  step's `2. Cancel` (§13.2) and, in a named session, the plan approval's footer as a lone rule row (§13.3).
- **Blank rows are not a fixed number.** Between the dialog's last row and the rule (or the header) there are 0 blank rows at 36 rows and up to 10 to 11
  at 60 rows (the bottom block is anchored to the bottom of the pane); 3 under the prompt at 45 rows.
- **Named and unnamed sessions.** Started with `-n <name>`, the rule row is labelled `<dashes> <name> ─`, followed by exactly one blank row and the
  header. Started without `-n`, there is **no rule row** under a dialog: the footer, the blank rows, the header. At idle the input box's top rule is
  plain without `-n` and labelled with it.
- **The header (2.1.325)** is `  <T> tasks (<D> done, <P> in progress, <O> open)`: the word is always `tasks` (`1 tasks` is real); the `in progress` part is
  absent when it is 0 (all done reads `8 tasks (8 done, 0 open)`); `done` and `open` are always printed, also at 0. Task rows are `  ◼ ` (in
  progress), `  ✔ ` (done) or `  ◻ ` (open) and a label cut with `…`, in the order in progress, open, done. From the binary only, never seen: a label may
  end with ` › blocked by #n` or ` (@owner)`, and an in-progress task with an owner can add a second row.
- **The overflow row (2.1.325)** is three spaces, `…`, a space and `+<counts>` (`   … +3 completed`); the visible rows plus the hidden ones add up to the
  header's counts. From the binary only: the hidden counts read `N in progress`, `N pending`, `N completed`, only those above 0, in that order, joined by
  `, `; the number of visible rows is 0 up to 10 pane rows, then `min(5, max(3, rows − 14))`, and with 0 visible rows the header stands alone.
- **When it goes.** About 3 to 4 s after the last task completes the block is still there (all `✔`); by 7 s it is gone. While Claude works the list is
  drawn in another form, under the spinner line (`  ⎿  ✔ …`), and not under a dialog. Notification rows (`tmux focus-events off · …`, a usage notice)
  sit between the block and the box's rule at idle; none was seen under a dialog.
- **The plan approval shows no task block at all** (36, 45, 52 and 60 rows, named or not). A named session adds the labelled rule as the very last row,
  directly under the footer; an unnamed one ends at the footer.
- **A permission prompt in an unnamed session** (live check of the 0.5 release candidate, 2.1.325, 106x42): no rule row; after the
  `Esc to cancel · Tab to amend` footer come blank rows (13 there), then the task block. nika read it and answered it from the page.
- **Not verified:** Claude 2.1.319; overflow rows with hidden `pending` or `in progress` tasks; the `blocked by` and owner suffixes; the
  survey together with a task list; vim mode.

**Claude 2.1.326 draws the block in another form (2.1.326, spike S-T326; checked 2026-11-17).** Where it sits is the same as above (under the dialog's last
row or the prompt's footer; blank rows, the labelled rule row, exactly one blank row and the block in a named session; blank rows and the block in an unnamed
one; the block is the last row of the screen). What changed is the text. A made-up block under a question step:

```
  3/6 tasks done · 1 in progress
  ◼ Mix dough
  ◻ Bake loaves
  ◻ Slice bread
  … +3 tasks (3 done)
```

- **Every row is indented by two spaces.** No row has a tab.
- **The header** is `  <D>/<T> tasks done`, then ` · <P> in progress` (U+00B7 with a space on each side) only when P is 1 or more. The word is `task` when
  T is 1 (`0/1 task done`, `1/1 task done`) and `tasks` otherwise. The open count is **not** in the header: open = T − D − P. Other headers seen:
  `0/8 tasks done`, `3/9 tasks done · 4 in progress`, `0/6 tasks done · 6 in progress`, `8/8 tasks done`.
- **Task rows** are the same as in 2.1.325: `  ◼ ` in progress, `  ◻ ` open, `  ✔ ` done and the label. The order is in progress, then open, then done, and
  inside a state by task id. A done task is shown only when there is room after the other two.
- **The overflow row** is `  … +<N> task[s] (<parts>)`: **two** spaces (2.1.325: three), `…`, a space, `+`. N is the number of hidden tasks and the sum of the
  parts; the word is `task` when N is 1, else `tasks`. The parts are only those above 0, in the order `<n> in progress`, `<n> open`, `<n> done`, joined by
  `, `. The words changed from 2.1.325 (`pending` is now `open`, `completed` is now `done`). Seen: `(1 in progress)`, `(5 open)`, `(3 done)`,
  `(1 open, 3 done)`, `(1 in progress, 4 done)`, `(1 in progress, 2 open, 3 done)`. Not seen: `in progress` and `open` without `done`.
- **How many task rows** depends on the pane's height, not on the dialog's size (the dialog was the same size at 45 and at 22 rows and the block did not
  change): 5 rows at 19 rows and up (more tasks than that give the overflow row), 4 at 18, 3 at 14 to 17, and at **12 and 13 rows three rows and no overflow row
  although tasks are hidden** (Claude's bottom edge cuts the block). At 10 rows and fewer only the header is left. The rule of thumb
  `min(5, max(3, rows − 14))` fits all 12 heights tried; it is a fit, not Claude's source.
- **All done.** Completing the last open task makes the header `<T>/<T> task[s] done` and the rows `✔`; the overflow row keeps `(<n> done)`. That frame
  lasts 3 to 4 s, then the **whole block goes**, header included: a named session keeps the lone rule row as its last row (the shape of 2.1.325's plan
  approval, which nika already cuts), an unnamed one ends at the dialog's footer and blank rows. No `all done` text exists; the only signal is D = T.
- **At idle** the block sits above the input box (block, **one** blank row, the box's top rule, `❯`, the bottom rule, the mode line; seen in a named session
  where the box's top rule carries the session name), and the mode line carries
  the hint `· ctrl+t to hide tasks`. nika reads the mode from the start of that row, so the tail changes nothing. A mode line tail `· ← <n> agent` showed up
  in the same session from about the sixth prompt on, with no subagent started by the test; its cause is unknown, and it is a suffix like the others that
  nika ignores (§1).
- **Not tried:** a pane of 11 rows; an unnamed session below 16 rows; the idle block at a small height and the unnamed idle shape; labels that end in
  `blocked by #n` or `(@owner)`; a long or cut label.

nika's rule (`taskEnd` in `src/mode.js`, called by `footerEnd` and by the prompt reader; rule 12 of `rules/project-rules.md` has the approved text for 2.1.325). It
reads **bottom-up on right-trimmed rows** and cuts **exactly one** of the following, otherwise nothing (the footer reads `unknown`, fail closed):

1. The anchor is the last row of a question step (either footer form), the review's `2. Cancel`, the plan approval's footer, or a permission prompt's
   footer, a row starting `Esc to cancel` that counts only when the prompt reader parses a prompt in the 15 non-blank rows that end there.
2. Under it, any number of blank rows, then either a rule row alone at column 0 (plain, or `<dashes> <name> ─`) as the last non-blank row; or, in a named
   session, a rule row at column 0, **exactly one** blank row and the task block; or, in an unnamed session, the task block with at least one blank row above it.
3. The task block is the header, task rows that start `  ◼ `, `  ✔ ` or `  ◻ ` followed by a non-space character (the label is never read for
   meaning), and at most one last overflow row. It has **two forms, and one block is one form**: a header of one version with an overflow row of the other
   is no block, nothing is cut (2.1.326, spike S-T326).
   - *2.1.325:* the header `  <T> tasks (…)` (regex-exact, `1 tasks` accepted, `in progress` only when above 0) and an overflow row `   … +<counts>`. The
     counts must add up: total = done + in progress + open and at least 1; `◼` rows plus hidden in progress = in progress; `◻` rows plus hidden pending = open;
     `✔` rows plus hidden completed = done. Rows and no overflow row: the same sums, exactly.
   - *2.1.326:* the header `  <D>/<T> task[s] done[ · <P> in progress]` is strict: T is 1 or more, `task` exactly when T is 1, D + P is at most T, and
     ` · 0 in progress` is no header. The overflow row `  … +<N> task[s] (<parts>)` is strict: two spaces, N the sum of the parts, `task` exactly when N is
     1, every part above 0, each at most once and in the order `in progress`, `open`, `done`, and only those words (the 2.1.325 words `pending` and `completed`
     are not accepted). The open count is T − D − P. With an overflow row, as in 2.1.325: `◼` rows plus the hidden in progress = P, `◻` rows plus the hidden open
     = T − D − P, `✔` rows plus the hidden done = D, and at least one task row above the overflow row. With task rows and **no** overflow row (the 12 to 13
     row pane), each state's visible rows are at most the header's count for that state: nika cannot tell hidden tasks from none there, and the anchor, the
     blank-row and rule placement and the bottom position still have to hold. nika applies no cap on the number of rows (the numbers bind them).
   - *Either form:* a header with no task row under it (a pane too short for the rows) is read on its own numbers and allows no overflow row.
4. Any other row (a second row under a task, a notification row) means **no cut**. Never under a mode line. A subagent list together with any of this
   is no cut. The bypass guard reads two windows: the 15 non-blank rows that end at the footer and those that end at the screen's last row, so the
   rows nika leaves out are read too, and the prompt's `sig`, options and question are the same with and without the block.

**The block above the input box (0.5, GT; found in the live check LC18, Finding 2).** At idle (the "At idle" bullet above; while Claude works it draws the list another way, under its spinner line) the block is not under the footer: the mode line is
the last row and nika cuts nothing there. nika still finds the block for one purpose, the scroll glide (spec §9.15): `taskBlockAbove(texts, top)` in `src/mode.js` takes the row of the box's top rule and,
right above it, requires exactly **one blank row** and then the block, read by the same function as the block under a dialog (`blockHead`: either form, the same strictness and the same count rules,
so the two readers cannot drift apart). It returns the header row, which `parseDraft` puts in the capture as `draft.box.tasks` (`api-app.md`, the `box` row), or `-1`. It returns `-1`, and the field is
absent, for no block, two blank rows or none, any other row between the block and the blank row (a transient hint row such as `Esc again to clear` counts), a block whose numbers do not add up, a
`top` that is not a rule row, and a block under the mode line. Nothing is cut and no key depends on it.

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
- The closing hint row starts with `Esc to cancel`; on 2.1.325 it reads `Esc to cancel · Tab to amend` and Claude's task list can sit under it (§1).
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
- A message sent with `Enter` is taken at once, not queued, in the two states where the turn is over but background work still runs
  (checked 2026-11-15, Claude Code 2.1.325, §10.12): `shell`, and `busy` while the screen says `Waiting for 1 background agent to
  finish` (the subagent list under the footer, §1). During a running turn (`busy`, the footer ends in `esc to interrupt`) Claude queues
  the message and takes it at its next step. nika's Send presses `Enter` in every registry state and does not tell these apart.

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
| a feedback survey is on screen (`surveyShown` in `src/mode.js`; the rating's question and options rows were captured on 2026-11-16, §10.13; the other questions are binary strings only, §10.11): any row that is exactly `How is Claude doing this session?` with an optional ` (optional)` (and an optional `●` before it), or the options row `1: … 0: Dismiss`; also a row that starts with `How well is Claude following the instructions`, `How was Claude's recollection` or `Can Anthropic look at your session transcript` | the rating answers to the digits 0–3 (the transcript question, from the binary only, to the letters `y`, `n` and `d`), so a draft that starts with a digit must never be typed while one shows. The capture's `draft` is null (the sync pauses), the draft write, End and the commands answer 409 `input-unreadable` with nothing typed. Matched on whole rows, so prose that quotes the question does not trigger it. Since F14 nika answers the **rating** (and only the rating) with one typed digit through its own route, after exact checks (§10.13; `api-app.md`, `POST /api/app/pane/:id/survey`); every other survey question stays the user's. The keys route's passthrough has no such guard (a digit pressed in the mirror is the user's own key); its `send: true` form (Send's typing) refuses a survey with 409 `prompt-open` |
| Claude's post-rating row is on screen (`followUpShown` in `src/mode.js`; M1, 0.5): a whole row that starts **at column 0** with `(Optional) Press [1] to tell us more` and a word boundary (the rest of it, ` · /feedback`, is not read) | a `1` there opens `/feedback` (§10.13), so nika types nothing into Claude's box while it shows. The capture's `draft` is null (the sync pauses), the draft write and the attachment send answer 409 `input-unreadable`, and so does Send's `Enter` when the page names a `base` (with no `base` the submit route still presses its one `Enter` on an empty box, as for a survey), the keys route with `send: true` answers 409 `prompt-open`, and a dialog reads `unreadable / survey`. It is **not** a survey: the capture's `survey` stays null and there is no panel (`src/survey.js` does not read it). Only the start of the row is matched because the row would wrap in a narrow pane (not captured wrapped); prose that quotes the words mid-line does not match, and neither does an indented row such as a reply that quotes the row (Claude indents its own reply rows; RR05 N1, commit `f51f201`). The row above it, `Thanks for the feedback!`, is **not** matched: it always came with this row (10 of 10 captures), and a model's own line with those words would otherwise hold the sync |
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

A replace chooses one of two roads on its first capture (0.5, W13). The **C-u road** applies whenever the terminal cursor is on the
box's last row, in any registry state: it sends `End` (only when the cursor is not at the end of the text) and `C-u`, which never
interrupt a turn (§10.12), so it runs while Claude works too. The **Escape road** (the last three rows of the table) applies only when
the cursor is on an earlier row of the box **and** the registry state, read fresh, is `idle`: an `Escape` with text in the box
interrupts a running turn (§10.12). With the cursor on an earlier row while Claude is not idle there is no safe key (`End` stops at
the end of that visual row; `Up` and `Down` recall history or open the task manager), so the write sends nothing, not even the probe
(409 `cursor-not-at-end`). Appending to a draft, or typing into an empty box, sends no `Escape` and may run while Claude works.

| Edit mode | Keys, in order | Waits |
|---|---|---|
| any, the cursor on the box's last row (C-u road) | the probe `i` first when the mode is `normal` or `unknown` (then the vim or plain row below only decides what the probe saw); `End` once, only when the cursor is not at the end of the text; then `C-u`, one per request, at least 60 ms after the key before it, at most `2 × inner rows + 2` presses | after `End`, until the cursor is at the end of the text (at most 400 ms); after each `C-u`, until the text is strictly shorter, or the same text sits in one row less (the press that removes only a newline), polling every 20 ms (at most 400 ms, else 409 `clear-stopped`); the loop ends when the box is empty |
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

Evidence for the C-u road (W13, checked 2026-11-15, Claude Code 2.1.325, tmux 3.8, on a busy pane running a foreground command; the
registry stayed `busy` and no `Interrupted` row appeared in any run): a one-row draft, three hard lines (`C-u` ×5, the 2N − 1 rule),
a wrapped draft of two visual rows (the first `C-u` left a `trailing` break space, which the road tolerates), vim INSERT and vim NORMAL
(left with one `Escape` while text was in the box, the cursor one column short of the end) were all replaced and read back. The keys
were `i`, `End`, `C-u` and the text, 70 to 80 ms apart (the probe's settle took longer). `End` from the start of the last visual row
of a wrapped line reached the end of the text (it does so from that row only). With the cursor on the first visual row of a wrapped
line the write answered 409 `cursor-not-at-end` and sent no key.

Slash menu: while Claude's slash menu is open, the first `Escape` of a replace only closes the menu. The write answers 409
`mode-unknown` and nothing is typed; the retry works.

Never sent by the writer: `Enter`, `C-c` (it arms exit and moves the draft to history), `Up` and `Down` (history recall),
`DC` (it joins the next line), `C-k`, `Tab`, `BTab`, a digit as a key, a second `Escape` on an empty box (Rewind), an `Escape` while
the registry state is not `idle` (the C-u road sends none), any key within 40 ms of an `Escape` (its own, or the `Escape` of a Stop or
End), and any key at all while Stop or End is interrupting the pane. `C-u` is used for two things only: the C-u road, and removing the
writer's own probe `i` from an empty box. `End` is used only on the C-u road.

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
  a real suggestion (the owner checks it). What `Enter` submits on an empty box that shows a suggestion is not verified either; nika's submit route
  refuses such a box (409 `suggestion-shown`, `api-app.md`) and the page's Send with both boxes empty sends nothing (W13).
- **Leaving.** Typing one or two characters, or a paste into the empty box, removes the suggestion; emptying the box again brings
  it back until a slash command is run (after `/config` it was gone) or a new turn starts.
- **`Tab` without a suggestion.** On an empty box that shows only the `Try "…"` example (or nothing), `Tab` changes nothing in
  the box, the footer or the mode; it flashes a hint row above the top rule for about 3 s (`Use opt+t to toggle thinking`
  replaced a status row). nika never sends `Tab` unless a fresh capture shows the suggestion it is about to take
  (`api-app.md`, `POST /api/app/pane/:id/suggestion`).
- **Slash command argument hint.** After `Tab` completes a command word (fg 153) and a space, Claude draws a grey argument hint
  in fg 246, not dim, after the cursor; typing any character removes it. It is ghost text (§10.3), not a suggestion.

### 10.11 Not verified

- The feedback survey's rating rows were captured on 2026-11-16 (§10.13). The three other question variants (`How well is Claude following the
  instructions`, `How was Claude's recollection`, `Can Anthropic look at your session transcript`) are strings of the 2.1.325 binary only: how and
  where they are drawn, and whether their options row has the same shape, was never captured live (§10.1 matches the start of the row, so a
  different layout may go unnoticed). The transcript question could not be reached: after a rating `2` it did not come (§10.13).
- A permission prompt, or a dialog nika does not know, drawn with the background-subagent list below it (§1): never seen, so it reads
  `unknown` and nika cannot answer it (the user does, in the terminal). A question, review or plan dialog with the list below it is cut
  by `treeEnd` and read (§1, gate 5), but only fixtures cover that; it was not seen live either.
- Plain-mode replace and append were exercised against a fake pane only (the Claude of the checking session was in vim mode).
- `→` and `Tab` in vim insert mode, `Tab` in vim normal mode, and `Tab` and `Enter` on a real suggestion through nika's accept route and Send (the owner checks
  them).
- A very long suggestion (does it wrap or is it cut), a draft that wraps in the middle of a wide character, and `Escape Escape` on
  an empty box (does it open Rewind, and does it save the draft to history).
- While Claude works (W13, §10.12): `C-u` on a box that holds an `[Image #N]` placeholder (such a box is unreadable and nika never
  writes over it); `C-u` inside a `!` box (the idle facts of §10.8 are assumed: `BSpace` leaves `!` mode); `Up` on the queued placeholder
  (Claude says it edits the queued messages; never pressed); what `Escape` does in the "Waiting for a background agent" state (never
  sent); `Down` on an empty box, which Claude's footer hints opens the background-task manager (never pressed).

### 10.12 Input while Claude works (0.5, W13)

How Claude's input box answers keys while a turn runs, and what a sent message does. Checked 2026-11-15, Claude Code 2.1.325, tmux 3.8,
macOS, panes of 120 columns, in throwaway sessions with made-up text; a turn was kept running with a foreground command of about 25
seconds, background work with a longer one. The registry state is `busy` unless a row says otherwise. The writer's C-u road (§10.8) and
the page's Send while Claude works (`api-app.md`, `POST /api/app/pane/:id/submit`; `docs/security.md` T54) rest on these rows.

**Keys into the box while a turn runs**

| Key | Box and mode | Result | Interrupts the turn? |
|---|---|---|---|
| `C-u` | text `alpha beta gamma`, cursor at the end, plain or vim INSERT | the text is gone, the box shows `❯` (redraw 5 to 32 ms) | no |
| `C-u` | empty box | nothing changes | no |
| `C-u` ×5 | three hard lines (`line one`, `line two`, `line three`), cursor at the end | after each press the box reads `line one` / `line two` / (empty row), then `line one` / `line two`, then `line one` / (empty row), then `line one`, then nothing: a line takes two presses (its text, then the newline before it), so N lines take 2N − 1 | no |
| `C-u` ×2 | one hard line wrapped onto two visual rows | the last visual row goes first; the break space of the wrap stays and reads as `trailing` (§10.5), then the box is empty | no |
| `End`, `C-u` | text `abc def ghi`, cursor at column 8 | `End` moves to the end (13), `C-u` empties the box | no |
| `Escape` | text `escape probe text` in the plain box | `⎿ Interrupted · What should Claude do instead?` within 100 ms, registry `idle`, the text is kept | **yes** |
| `Escape` | text in vim INSERT | `-- INSERT --` is gone after 55 ms, registry still `busy` | no |

- After a `C-u`, Claude draws a hint row above the top rule, right-aligned: `Ctrl+Y to paste deleted text`. It lies outside the box by
  construction (§10.1: the box is between the last two rule rows).
- While the box holds text, the footer loses its ` · esc to interrupt` hint (`⏵⏵ auto mode on (shift+tab to cycle)`); with the box
  empty it is shown. At idle, one `Escape` on text only shows `Esc again to clear` for about 800 ms (right-aligned above the top rule).
- So `C-u` never interrupts, in either edit mode, and `Escape` interrupts whenever the plain box holds text. nika's writer clears with
  `End` and `C-u` whenever it can and sends `Escape` only at idle (§10.8).

**`End` and the cursor**

- `End` goes to the end of the **visual row**, not of the text. One row: column 8 → 13, the end of the text. A cursor on the first of
  two visual rows of a wrapped line: `End` goes to column 2 of the next row (its start), not to the end of the text. A cursor on the
  first of two hard lines: `End` goes to the end of that line. `C-End` and `C-e` go no further than `End`.
- Only a cursor on the **last** row of the box reaches the end of the text with one `End` (it also works from the start of the last
  visual row of a wrapped line). Idle, from an earlier row, `End` then `C-u` ×4 leaves the rows after the cursor in the box.
  That is why the writer's C-u road needs the cursor on the box's last row and refuses (409 `cursor-not-at-end`) otherwise while
  Claude works.
- `DC` at the end of a hard line joins the next line (plain and vim INSERT, idle and busy: `row one text` and `row two text` become
  `row one textrow two text`). nika never sends it.

**vim while a turn runs**

- INSERT with two lines of text: one `Escape` leaves INSERT (gone after 55 ms), the registry stays `busy`; `ggdG` and `i` as text then
  give an empty box with INSERT back at 159 ms. A second `Escape` in NORMAL was not sent: in plain terms it is the interrupt key.
- NORMAL with the text `normal probe`: the cursor sits on the last character (column 13, the end is 14). The probe `i` gives INSERT
  with the text unchanged and the cursor still at 13; `End` moves it to 14; `C-u` empties the box. No interrupt, registry `busy`.
- The vim footer while busy in manual mode reads `-- INSERT -- ⏸ manual mode on`, with no `esc to interrupt` hint.

**`Enter` while a turn runs: Claude queues the message**

```
before   ❯ Queued note: reply with the word blue when you see this.            (the box, registry busy)
Enter
+60 ms   ❯ Press up to edit queued messages                                      (the box: the glyph fg 246, the words dim)
         ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt
above the spinner, in the same turn:
         ❯ What color is this image? Answer in one word.[Image #2]             (grey, fg 246)
           ctrl+x ctrl+s to send now
```

- The box shows the dim placeholder `Press up to edit queued messages` in place of the text, so nika reads an **empty** box with
  `queued: true` (§10.3: dim text is ghost; `api-app.md`, `draft.queued`). The same dim row shape is what Claude draws for a prompt
  suggestion (§10.10), so the reader tells them apart by the exact text and never offers the placeholder as a suggestion.
- The queued text shows grey above the spinner (`❯ <text>`), with `ctrl+x ctrl+s to send now` under it.
- Delivery: at the next tool boundary inside the same turn (the transcript records a queued-command attachment; Claude answered the
  queued message in that turn), or, when the turn ends without a tool boundary, as the next user message (two queued messages became
  one turn answering both). A queued message can therefore steer a turn that is already running.
- `Enter` on an empty box while busy does nothing. `C-u` on text typed while messages are queued leaves the box on the dim
  placeholder again.
- A tip row seen while busy: `Send messages to Claude while it works to steer Claude in real-time`.

**Attachments while a turn runs**

- With text in the box, a bracketed paste of an image file's absolute path turns into `[Image #N]` after 43 to 49 ms (`N` counts per
  session). The same paste of a text file's path stays text. `Enter` then queues the message with the image: the queued prompt carries
  the image block, and Claude answered about the image in that turn.
- vim INSERT, busy: text and an image path read `[Image #1]`; the vim clear (`Escape`, `ggdG`, `i`) emptied the box with no interrupt.

**The turn is over, background work still runs**

| Situation | Registry | Rows | `Enter` with text |
|---|---|---|---|
| a background shell is running | `shell` | `✻ Cooked for 2s · … · 1 shell still running`; footer `⏵⏵ auto mode on · 1 shell · ↓ to manage` | submits at once (registry `busy` for about 0.8 s, then `shell` again); Claude answered the message |
| a background subagent runs after the main turn | `busy` | `✻ Waiting for 1 background agent to finish`; footer `… · 1 shell · ↓ to manage`; under the footer the subagent list (§1) | submits at once; Claude answered at once |
| the subagent has finished, the shell still runs | `shell` | `⏺ Agent "<label>" finished · 43s`; footer `… · /tasks to see subagents · ↓ to manage` | not tried |

`↓ to manage` in the footer is Claude's own hint that `Down` on an empty box opens the background-task manager; nika never sends `Down`.

**Stop with a queued message**

```
queued   ❯ Queued before a Stop: reply with the word olive.     /   ctrl+x ctrl+s to send now
Escape   (empty box)
+150 ms  ⎿ Interrupted · What should Claude do instead?          the queued line stays, a spinner row ("Drizzling…"), registry still busy
+1.5 s   ⏺ olive                                                  registry idle
```

The interrupted step ends and the queued message goes to Claude at once as a new turn. It is **not** put back into the input box.

**`!` and long pastes while a turn runs**

- `!echo hello` typed gives the box `!` and the text with a pink rule and the footer `! for shell mode`; `Enter` queues it (`! echo hello`
  and `ctrl+x ctrl+s to send now`), and the command runs after the turn (`⎿ hello`). nika sends it like any other message.
- A paste of more than 800 characters reads `❯ [Pasted text #N]`; `Enter` queues it, and the footer shows `paste again to expand` for a
  moment. nika never writes over such a box (§10.6, `pasted`).

### 10.13 The feedback survey (0.5, spike S-F14)

Claude Code 2.1.325, tmux 3.8, macOS, a private tmux server, Haiku, checked 2026-11-16 at 120, 64 and 40 to 47 columns with Claude in plain mode and in vim
INSERT and NORMAL. The facts here are about Claude; nika reads the rating rows exactly and answers them with one typed digit (F14: `src/survey.js`, `src/session-control.js`
`answerSurvey`), and keeps a draft from answering them (§10.1). One rating `2` (Fine) was sent on a throwaway session; the transcript question was never reached.

- **When it shows.** The binary's default is: at least 10 minutes since the start and 5 user turns, probability 0.005 per check (remote configuration
  `tengu_feedback_survey_config`; the user setting `feedbackSurveyRate` replaces the probability), then at least an hour and 10 turns between two
  surveys. For tests the environment variable `CLAUDE_FORCE_DISPLAY_SURVEY` (`1`, `true`, `yes` or `on`) opens it once per process at once;
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` turns it off. It can be open **while Claude is busy** (it opened during a turn and stayed through `thinking`).
- **Place and rows.** Above the input box's top rule and below the transcript or the spinner, one blank row above the question. Exactly one row sits
  between the options row and the box's top rule (39 of 39 captures); it is **not always blank**: it can hold `◐ medium · /effort`, a usage notice or the
  tmux `focus-events off` notice, so treat it as free text.

```
(blank)
● How is Claude doing this session? (optional)            column 0: ●, a space, the bold text from column 2; the ● is cyan
  1: Bad    2: Fine   3: Good   0: Dismiss                indent 2; the digits are cyan; each item is 10 wide (4, 3 and 3 spaces after the labels)
(one row, free text)
────────────────────────  <name> ─                       the box's top rule
```

- **Width.** 46 columns and more: question and options each on one row (120 and 64 columns identical). 45 down to 42: the question wraps to
  `● How is Claude doing this session?` and `  (optional)`. 41: the options squeeze (`3: Good  0: Dismiss`). 40: `0:` and `Dismiss` split over two rows. A parser that wants
  the two rows directly above each other therefore fails closed below 46 columns.
- **The digit goes into the input box.** It shows there (`❯ 0`, the cursor one column right) and Claude acts on it after a **400 ms pause** (or on
  `Enter`); the digit is visible for about 0.2 to 0.5 s, then the survey rows vanish. A digit within 600 ms after the survey mounted is ignored. It works in
  plain mode, in vim INSERT and while Claude is busy. In vim **NORMAL** the survey stays and the digit does nothing (`0` is a motion). **Any other
  character** in the box hides the survey at once and abandons it, and clearing the box does not bring it back; later digits are plain text. A box holding
  exactly one of `0 1 2 3` keeps the survey open and the digit acts, so a draft that is a single `1`, `2` or `3` followed by a 400 ms pause would rate; a one-shot
  `send-keys -l` of longer text is safe.
- **After the answer.** After `0` (Dismiss) nothing replaces the rows (no confirmation) and the box shows its placeholder again. After `2`: for about 3 s one
  row `Feedback: Fine · Esc to undo` (`Esc` undoes the rating, so no `Escape` may be sent there: nika sends none for 4 s after a rating of 1 to 3, F14), then for about 3 s (10 captures, +3.65 s to +6.2 s after the digit; both rows at column 0, 120 columns only, never wrapped) two rows, `Thanks for the feedback!` and
  `(Optional) Press [1] to tell us more · /feedback` (a `1` there opens `/feedback`; whether Claude reads that `1` from the box after a pause, as the survey does, or as a keypress was not tried; nika types nothing into the box while the second row shows, §10.1), then nothing. No transcript question appeared in 30 captures.
- **The transcript question: its layout is NOT recorded, so nika never answers it.** It was never seen on a screen, and the rows below are a reading of Claude's binary, not a
  capture. nika treats it as `terminal / consent` wherever a row starts `Can Anthropic look at your session transcript` (also beside a rating), offers no button, and has no code
  path that types a letter for it; the approved rule 12 text lets nika answer it only "in the exact layout recorded" in this file, and no layout is recorded. A later round needs a
  live capture of the rows, the screen after `n` and the width behaviour first, and a new request body (its keys are letters, the route's body is `n` 0 to 3).
- **The transcript question (binary only, not seen live).** After a rating Claude asks whether Anthropic may look at the session transcript only when
  the user's `transcriptShareDismissed` flag is not set and a random draw against `tengu_<bad|fine|good>_survey_transcript_ask_config` succeeds; the binary
  default of each probability is 0, and the forced path is stubbed off, so it could not be reached on demand. The layout from the component, **unverified**:
  a blank row, `● Can Anthropic look at your session transcript to help us improve Claude Code?`, a link row indented 2 (possibly an OSC 8 hyperlink with the URL
  as its text), and an options row indented 2, `y: Yes` and `n: No` (each 10 wide) then `d: Don't ask again`. Its keys are **letters**: one typed character,
  lowercased, `y` yes, `n` no, `d` dont-ask-again, through the same input box and 400 ms pause. **`d` writes `transcriptShareDismissed: true` to the user's
  config; nika never presses it.** In vim NORMAL, `y`, `n` and `d` are operators or motions, so a letter answer needs INSERT mode.
- **Other surveys (binary only).** `How well is Claude following the instructions you gave earlier in this conversation? (optional)` (flags
  `tengu_long_context_survey_*`) with the same options row; a memory survey (`Claude recalled a memory:`, a sentence, `How was Claude's recollection?
  (optional)`) whose options row probably gains `4: Unsure`. All share `0: Dismiss`, which `SURVEY_OPTIONS` in `src/mode.js` matches.
- **Not reached:** the transcript question; the memory and long-context surveys; the survey together with a permission prompt, a slash menu or a scrolled-up
  view; what the `bad` and `good` transcript probabilities are for an account.

## 11. Attachments (0.5, W2)

What Claude Code does with a file path pasted into its input box, and what the box shows. Checked 2026-11-14 and 2026-11-15, Claude Code
2.1.325, tmux 3.8, macOS, in throwaway sessions with synthetic files (spike S4, then the live checks of the attachment send). The page
side is `docs/design/spec.md` §9.14 and the route is `POST /api/app/pane/:id/attach-send` (`api-app.md`). The attachment send
(`src/attach-send.js`, [ADR 0016](../adr/0016-attachments-json-upload-state-dir.md)) rests on these rows.

**A pasted path (bracketed paste of one absolute path)**

| File | What the box shows | What Claude does |
|---|---|---|
| PNG, JPEG, GIF, WebP | the path is replaced at once (within 50 ms) by `[Image #N]`; `N` counts per session and keeps counting across clears | no Read call and no prompt: the image travels in the user message itself (the transcript holds it as base64 and records `imagePasteIds`) |
| PDF | the path stays as text, wrapped at the pane width (it may break in the middle of the path) | calls its Read tool on the path |
| text file (`.txt`, `.py`) | the path stays as text, same | calls its Read tool on the path |

- Placeholder spans carry no SGR attributes, so a reader that ignores styling sees them as plain text: `[Image #1]`.
- Consecutive placeholders get a space between them (`[Image #1] [Image #2]`). After typed text, a pasted image path gets **no** space added
  (`look at these[Image #5]`), so nika pastes an image path alone. Every non-image path goes in with **one leading space**, also into an empty box (see the
  next bullets).
- **A pasted path keeps its leading space** (checked 2026-11-16, Claude 2.1.325, tmux 3.8): pasted into an empty box, ` /…` shows as `❯  /…` (two
  spaces after the glyph; the cursor at the end of the text), a PDF path wraps at the pane width, and a pasted `/…` path does **not** open the slash menu
  (a paste without the space into an empty box showed no menu either). Sent with `Enter` after the space, Claude took the message as a **prompt**, read
  the file with its Read tool and answered from it; it was not run as a command. Not tested: the no-space paste followed by `Enter`, a typed (not
  pasted) `/`, vim mode. That is why nika keeps the space for every non-image path: a box that begins with `/` is Claude's slash-command input, and
  nika's send stops (409 `screen-changed`, no `Enter`) when the box was empty at the start and its text begins with `/` after a paste or right before
  the `Enter`.
- `C-u` clears **one wrapped row per press** (a 3-row pasted path needed three presses; the fourth did nothing; same fact as §10.8). End and the
  commands type short text, but cleanup of a longer paste leaves text behind after one `C-u`.
- A large image is converted, not refused: a 7.9 MB PNG still gave `[Image #N]` within 656 ms of the send. Whether Claude accepts the
  message with that image on submit was not tested (the one turn tried used a small PNG).
- vim INSERT: the box takes both kinds. vim NORMAL with an empty box: a paste is inserted as text or placeholder (no history search
  opens). nika still refuses to paste in NORMAL when it remembers the mode (409 `vim-normal`).
- The box with attachments reads as `unreadable` / `pasted` for the draft reader (§10.6), which is why nika pastes them only at Send.

**The Read permission prompt (PDF and text files)**

```
 Read file                                                                                  1 of 2
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Read(<path of the file>)
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, allow reading from <folder> during this session
   3. No
 Esc to cancel · Tab to amend
```

- `N of M` is how queued prompts are shown, one prompt per file; their order can change between runs (parallel tool calls). A long path
  wraps over two rows. The prompt is the permission prompt nika already reads (§2): the page shows it in the prompt panel and the user
  answers it. nika sends no digit for the user.
- Option 2 grants that **folder** for the session only (for a folder under `/tmp` it names both the link and its real path).
- Option 3 ("No") cuts the whole turn: all pending Reads end as errors ("User rejected tool use"), the second pending prompt never
  shows, and Claude does not retry by itself. A digit selects at once; no `Enter` is needed.
- A path outside the working directory prompts wherever it is (a scratchpad folder and `/tmp` behaved the same, and a sibling file in
  the same folder prompted the same way). A file inside the working directory did not prompt. Under the owner's own allow rules none
  of the folders prompted at all. nika therefore cannot assume that a prompt will or will not come; the page says so in one
  fixed line after a send that held a PDF or text file (`public/attach.js`, `READ_NOTICE`).
- A file placed inside the project avoids the question. nika never does that (rule 11: it writes only the rules files into a project).

**The text Claude takes from a send**

- With text in the box, a bracketed paste of an image path then `Enter` gave a message whose text kept the literal `[Image #N]` and
  whose content held the image block. A second meta entry in the transcript keeps the original path. A model answer to the image
  question ("What colour is the circle in this image?") came back correct (Blue).
- While a turn runs the same send is queued like any message (§10.12, Attachments while a turn runs).

**A long text typed with `send-keys -l --`** (checked with the attachment send's sibling, the keys route)

| Length | Result |
|---|---|
| 512, 700, 800 characters in one request | arrive intact |
| 801 and 900 characters | collapse to `[Pasted text #N]` (Claude takes a burst of more than 800 characters as a paste) |
| 1023 and 1024 characters | only the last 1 or 2 characters are kept |

So nika types at most 700 characters or 2 newlines at a time and waits about 300 ms between chunks (`src/draft.js` `CHUNK_CHARS`,
`CHUNK_NEWLINES`, `CHUNK_GAP_MS`; the keys route chunks a text of 701 to 1024 characters the same way). 1023 and 1024 printable
characters sent that way arrived as two chunks about 330 ms apart and read back exactly.

**Not verified**

- A message with a large image (several MB) submitted to a model (only the paste and the box were checked).
- A folder under nika's real state folder: the checks used synthetic folders, so by the rule above it prompts unless the user's own
  allow rules cover it.
- `Tab` in the Read prompt ("amend"): nika never sends it.

## 12. Scrolling Claude's view (0.5, W3)

How Claude Code's full-screen view scrolls, and which keys move it. Checked 2026-11-14 and 2026-11-15, Claude Code 2.1.325, tmux 3.8,
macOS, panes of 120 columns and 40 rows, plain and vim editor modes, with made-up text (spike S5, then the live checks of the scroll route).
The route is `POST /api/app/pane/:id/scroll` (`api-app.md`); the page side is `docs/design/spec.md` §9.15 and
[ADR 0018](../adr/0018-scroll-with-claude-keys.md).

**tmux has nothing to scroll**

- `#{alternate_on}` is `1` and `#{history_size}` is `0` in every state sampled: the trust dialog, idle, an open dialog, during and after
  a 300-line answer, while a local shell command ran. Claude draws its whole interface in tmux's alternate screen, so older output
  exists only in Claude's own view. `capture-pane -S -400` and `-S -` return the same visible 40 rows as a plain capture.
- Claude enables mouse tracking (`#{mouse_any_flag}` is `1`). An SGR wheel report scrolls one row per event, but nika does not send
  them: with Claude's mouse mode off the bytes become input, and a stray report can click the pill or a row.

**The keys**

| Key | Scrolls Claude's view? | Other effect |
|---|---|---|
| `PPage` | up about one half screen | the pill appears |
| `NPage` | down about one half screen; at the bottom a no-op | the pill goes at the bottom |
| `C-Home` | to the very top | the pill |
| `C-End` | **to the bottom** (the "return to live" key) | the pill goes |
| `End`, `Home`, `Down`, `S-Down`, `C-Down`, `M-Down`, `C-b`, `C-f` | no | none visible |
| `Up` | no | recalls the previous prompt into the box (the draft is stashed; `Down` brings it back with the cursor at column 0) |
| `C-u` | no | with the cursor at the end it deletes the draft |
| `C-d` | no | prints `Press Ctrl-D again to exit`; a second press within about a second quits Claude. Never sent |

- A page is about half of the transcript area: 15 to 17 rows of a 33-row area in the first checks, 16 to 17 rows with the box
  starting at row 36 in the live check of the route. Two neighbouring pages overlap by about half. The page side takes half of the rows
  above the input box (`floor(box.top / 2)`, at least 4) as the size of a page.
- The four scroll keys do not change the draft, the sig or the cursor: checked with a one-line draft, a three-line draft with the
  cursor on the last line, a `!` box, a history entry (`History 4/4`) and a pasted draft (`[Pasted text #5 +13 lines]`), in plain mode and in
  vim INSERT and NORMAL (the vim run had no transcript, so only "no effect on the box" is shown).
- Latency from `send-keys` to a changed capture: median 15 ms, at most 18 ms. The scroll route's answer comes in about 50 to 80 ms.
- Claude returns to the bottom by itself when a message is submitted (first sample 258 ms after `Enter`: bottom, no pill).
- Scroll while a turn streams works and does not interrupt it: the view stays where it is while output grows, and the turn finishes.
- On a resize Claude keeps the top row of the view (the top number stayed the same from 120x40 to 100x30 and back); the next page is half of
  the new transcript area.

**The pill (the scrolled-up marker)**

- Claude draws it over the last transcript row while its view is not at the bottom: ` Jump to bottom: fn+↓ to scroll ` in fg 231 on bg 237,
  centred. With tmux `mouse on` Claude's text may read ` Jump to bottom (click) ↓ `; that variant did not appear in the checks (mouse on or off).
- After new output arrives while the view is up, the pill reads `N new message(s): fn+↓ to scroll` (`1 new message: …`), same colours.
- In a dense transcript the pill starts after the last transcript row's own text (`151      Jump to bottom: …`), so nika matches the
  text `Jump to bottom` or `N new message(s)` (N 1 to 999) **anywhere in a row**, with the span that holds its first character in fg 231
  on bg 237 (`pillShown` in `src/mode.js`); a pill alone on its row matches too. Any row of the screen counts, because a dialog may be
  open while the view is up. The page's `scrolled` only decides the "Scrolled up in Claude's view" note and whether Jump to live also
  presses `C-End`; it never gates a key, and a forged pill changes only what the page shows.
- A stale cached capture (the 250 ms cache) can show the pre-scroll view for one tick right after a scroll; at the page's 100 ms cadence
  no stale view was seen, and a flip would last one tick.

**Screens where the keys must not go**

| Screen | What the keys do | nika answers |
|---|---|---|
| a permission prompt | `PPage` and `C-Home` move the prompt rows off the screen (the dialog scrolls with the view); `NPage` and `C-End` bring it back; the highlight stays on option 1 and never moves | 409 `prompt-open` |
| a question dialog | the scroll keys scroll too (pill shows, dialog kept, `C-End` returns) | 409 `screen-unclear` (the dialog's footer is not a plain box, so the draft reader returns null) |
| the slash menu (`/co` typed) | the transcript scrolls under the menu; the highlight never moves | 409 `menu-open` (the draft starts with `/`) |
| the `@` menu | menu rows and styles unchanged | 200 |
| `/model`, `?`, `Ctrl+R`, `Ctrl+O` | a dialog or overlay is open | 409 `screen-unclear` |
| the "paste again to expand" footer, for about 8 s after a long paste | the box is unreadable | 409 `screen-unclear`; after that the state is `unreadable` / `pasted` and all four keys go |
| a Stop or End interrupt running, or its `Escape` sent less than 40 ms ago | a key right after `Escape` can be read as Meta plus that key, and the interrupt would be lost; two `Escape` presses within a second also opened Claude's Rewind dialog on an empty box | 409 `busy-switching` (`keyGap`) |

**Not verified**

- Vim NORMAL with a transcript on screen (only the box was checked there).
- A user's own `keybindings.json`: nika never reads it (rule 4), and a rebound `PPage`, `NPage`, `C-Home` or `C-End` would change what the
  route does. The meanings above are Claude Code 2.1.325 with default keybindings.
- The `Jump to bottom (click) ↓` variant (not reproduced) and a pill drawn in other colours or wrapped over two rows: not seen, so not
  matched.
- A scroll key during the Rewind dialog or with `/config` open: the route refuses on the unknown footer, never tried raw.

## 13. Question dialogs and plan approvals (0.5, W1)

What Claude Code draws when it asks the user a question (`AskUserQuestion`) or asks to approve a plan (`ExitPlanMode`), how nika reads it
(`src/dialog.js`), and which keys answer it. Checked 2026-11-14 and 2026-11-15, Claude Code 2.1.325, tmux 3.8, macOS, in throwaway sessions
with made-up questions (spike S3, then W1-T0, T0b, T0c and the end-to-end check W1-T4 through nika's page). The route is
`POST /api/app/pane/:id/dialog` and the capture's `dialog` field (`api-app.md`); the page is `docs/design/spec.md` §9.16;
[ADR 0015](../adr/0015-dialogs-from-the-screen.md).

**The call is not on disk while the dialog shows.** A 4-question dialog stayed open for 96 s and the session's transcript file did not
change (size and mtime, read at +17, +19, +21 and +60 s). After `Escape` the file grew by 5 lines in one write: the assistant `tool_use`, the
`tool_result` and the user lines. So the screen is the only source while the dialog is open.

### 13.1 A question step

```
────────────────────────────────  (rule, as wide as the pane, column 0)
←  ☐ Project  ☐ Checks  ☐ Mode  ✔ Submit  →            the strip; the current tab's token has a background (fg 16 on bg 153)
(blank)
Which project should I open?                          the question (bold)
(blank)
❯ 1. acme-api                                          the focused row: ❯ in column 0, a space, the number, a dot, the label
     Open the acme-api project.                        a description, indent 5 (single-select) or 9 (multi-select), fg 246
  2. web-shop
  3. demo-api
  4. Type something.                                   Claude's free-text row (k+1); multi-select: "[ ] Type something", no period
     Next                                              multi-select only: the button row, indent 5 (the last tab's reads "Submit")
────────────────────────────────  (a rule)
  5. Chat about this                                   indent 2 (k+2)
(blank)
Enter to select · Tab/Arrow keys to navigate · Esc to cancel      the footer: the last non-blank row
```

- The strip, the question and the footer start at column 0. A **single** tab uses the footer `Enter to select · ↑/↓ to navigate · Esc to cancel`
  and a strip of one token with no arrows and no `Submit`; **several** tabs use `Tab/Arrow keys to navigate` and a strip with `←`, `→` and
  `✔ Submit`. The footer gains `-- INSERT -- · ` in front while a vim text row has INSERT, and ` · ctrl+g to edit in Vim` (any editor name)
  when the focus is on the text row or the button row after it, in plain mode too; `· Esc to cancel` is absent while INSERT shows.
- A tab token is `☐ <header>` (not answered) or `☒ <header>` (answered); tokens sit two spaces apart. The **current** tab is the one drawn
  with a background (or reverse video); nika reads that, not a colour value. Zero or two marked tokens is `unreadable` (`tab`). At narrow widths
  Claude cuts the unfocused headers with `…` (`To…`).
- A multi-select question has `[ ] <label>` / `[✔] <label>` rows; a digit toggles a box and leaves the focus where it is. An answered
  single-select label ends in ` ✔` (nika removes it). Typing in the multi text row ticks its box by itself.
- The tmux cursor sits on the focused row, and parks at column 0 of a row (`0,39`) on the button row and on `Chat about this`.
- Re-entering a tab (`Left` in the terminal) resets the focus to option 1 and keeps ticks and typed text.
- **A long question wears a bar** (2.1.325, checked 2026-11-16 at 64, 70, 80, 90 and 120 columns). When the question text is wider than 80 columns or holds a
  line break, Claude draws every row of the **question** with a dim `│ ` in front (U+2502 then a space; `ESC[2m│ESC[0m `, then the bold text), at any pane width.
  The option descriptions have no bar. A 71-character question wrapped to two rows at 64 columns has no bar; an 89-character one has it at 64 columns (two rows)
  and at 120 (one row, 91 wide). The 80-column boundary itself is from the binary only (`text.includes("\n") || width(text) > 80`); 80 and 81 were not tested.
  nika leaves the bar out of the question's text when **every** question row has it, and reads a screen where only some rows have it as `layout`.
  2.1.326, spike S-T326: the question step draws the bar at column 0, with no leading space, on every row of a 187-character question; a 14-character question
  has none. The bytes are `│` dim (`ESC[2m│ESC[0m`) and a space, then the text. The review step has its own bar (§13.2).
  **Open (M2, not seen live):** a barred question that holds a blank paragraph row (the bar is drawn when the text holds a line break). If Claude draws that row as `│` alone, nika reads it as a question row without the bar (the bar test is `│ `, and the row is not empty), so the dialog is `unreadable / layout` and the user answers it in the terminal. If Claude leaves that row empty it reads fine. A capture of one such question decides whether `│` alone should count as barred.
- **A text row can be as wide as the pane.** The measured limit below (`cols − 1`) held for short questions; with the bar the widest row reached `cols` at 64 (64
  wide: the bar and 62 characters), 70 and 80 columns, and 87 at 90 and 119 at 120 depending on the wrap. A row of that width is a wrap only when the row
  right below it continues the same question paragraph or the same option's description; nika accepts it only then (`wide` otherwise, §13.5). The review step
  has the same exemption for its question rows (§13.2).

### 13.2 The review step

```
←  ☒ Project  ☒ Checks  ☒ Mode  ✔ Submit  →            the Submit token is the current one: a background, and no brackets in 2.1.325
Review your answers
 ⚠ You have not answered all questions                 only while a tab is open
 ● Which project should I open?     →  acme-api        the question; the answer after →, a wrapped row joins the one above
 ● Which checks should I run?       →  lint, build
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel                                            the last non-blank row; there is no footer
```

- The review lists the **answered** questions only; unanswered ones are omitted and the warning row shows. A multi-select answer reads
  `<ticked labels in list order>, <the Other text>`. After Submit, Claude's result lines list the answers in the order they were given.
- `Enter` on the review's `1. Submit answers` submits the dialog. `Enter` on a multi question's button row does **not**: it opens the review.

**The review's bar (2.1.326, spike S-T326 item 9; first seen in the live check LC17; checked 2026-11-17).** Claude draws the `│ ` bar in the review too, and
**per question**: on every row of a long question, on no row of a short one. A made-up review of a short and a long question (blank rows as Claude draws them):

```
←  ☒ Fruit  ☒ Depth  ✔ Submit  →
(blank)
Review your answers
(blank)
 ● Which fruit?                                         a short question: no bar
   → Apple                                              an answer row: never a bar
 │ ● <a question wider than the pane, so it wraps … ,   a long question: the bar on its first row
 │   … and the rest of the question>                    and on every wrapped row
   → Shallow
(blank)
Ready to submit your answers?
(blank)
❯ 1. Submit answers
  2. Cancel
```

- The first row of a barred question is ` │ ● <text>` and each wrapped row is ` │   <text>`: one leading space, `│` (U+2502, dim, `ESC[2m│ESC[0m`), then
  the row as it reads without the bar. The bar goes in after the one-space indent, so taking it out gives the unbarred row back. The continuation row has
  the text aligned under the one after `● `. The long question wraps near the pane's edge (LC17, 147 columns: rows of 138 and 146 columns).
- The answer rows (`   → <answer>`), the `Ready to submit your answers?` row and the option rows never have the bar.
- The threshold was seen at the two ends only: 14 characters have no bar, 187 have it. A question of 100 to 120 characters was not tried. That Claude uses the
  question step's rule here (wider than 80 columns, or a line break; §13.1) is not verified.
- nika reads the bar **per question** (`readReview` in `src/dialog.js`): all rows of one question have it or none do, and different questions of one review may
  differ. It takes the bar out before reading, so the same text has the same `sig` with or without it. These are `layout`: some but not all rows of one
  question barred, a barred answer row or a barred answer continuation, a row that is only the bar, and a bar on `1. Submit answers` or on `Ready to submit
  your answers?`. A bar on the last row (`2. Cancel`) means the review is not recognised at all (as before).
- A question row as wide as the pane is a wrap, not a cut (FXR; live check LC19: two questions of about 330 and 300 characters, at 106 and 147 columns, drew the `●`
  row exactly as wide as the pane with its rest row ` │   <rest>` below). The review has the exemption of the question step (§13.1, §13.5): a `●` row or a
  wrapped rest row that reaches the pane's last column is accepted when the row directly below it is a rest row of the **same** question with the same bar state.
  Still `wide`: the last row of a question, a `●` row with its answer row directly below, a full-width answer row or answer continuation, a full-width
  `Review your answers` heading or `Ready to submit your answers?` row, a blank row between the full row and its rest, and a rest row of the other bar state.
  (Before FXR, build 19, every such review read `unreadable / wide`, so Submit had to be pressed in the terminal.)
- Before this was built (build 17) every barred review row read `unreadable / layout`, so a review of long questions could not be submitted from the page.

### 13.3 The plan approval

```
▔▔▔▔▔▔▔▔▔  ◐ medium · /effort ▔                        a band row above; the effort text is part of it
  ────────────────────────────────  (rule, indent 2, width cols - 4)
   Ready to code?                                      indent 3, bold
(blank)
   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  (dashed rule)
   - Reply with the single word done.
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  (dashed rule; blank rows may follow)
  ────────────────────────────────  (rule)
   Claude has written up a plan and is ready to execute. Would you like to proceed?
(blank)
   ❯ 1. Yes, and use auto mode                         options at indent 3 (the pointer in column 3)
     2. Yes, manually approve edits
     3. Tell Claude what to change                     the free-text option, dim
        shift+tab to approve with this feedback        indent 8, under the free-text option only
(blank)
   ctrl+g to edit in Vim · <plans folder>/<name>.md     the footer (any editor name); the path is never read or shown
```

- **A digit takes effect at once** (spike W1-T0b L5, digit `2` with the focus on option 1: `User approved Claude's plan`, the mode line became
  `-- INSERT -- ⏸ manual mode on`, and the model replied). `Enter` after typed text on the free-text option was never run.
- The footer on 2.1.325 reads `ctrl+g to edit in Vim · <plans folder>/<name>.md` (no `· Esc to cancel`) and is the last row of the screen at 36, 45, 52 and 60
  rows. Claude's task list is **not** drawn under a plan approval; a session started with `-n` draws its labelled rule row directly under the footer as the
  very last row, and an unnamed one has nothing under it (§1, F13). nika reads the footer as a dialog end in both cases.
- The plan dialog **never shows the `-- INSERT --` marker**, even with the free-text option focused. The plan text can be longer than the
  screen and is cut; nika uses the visible plan rows only for the dialog's identity and never shows them.

### 13.4 Shapes nika recognises but never reads

- `Exit plan mode?` (ExitPlanMode with no plan file): two options (`1. Yes, and switch to default (ask each time) for this session`,
  `2. No`), no footer, the last row of the screen is `2. No`. `Escape` rejects it.
- `Teach auto mode about your environment?` (the auto-mode nudge): digit options `1. Yes`, `2. Not now`, `3. Don't show again`, a footer
  `Enter to confirm · Esc to cancel` that is **not** the last non-blank row (an ordinary mode line sits below the box). It appeared once, on the
  first idle screen after a turn, in an auto-mode pane.

Both take a digit or `Enter` that was meant for something else, so every control that needs a plain box treats them as a dialog on screen
(`promptOpen`, `api-app.md`), and the `dialog` field says `unreadable` with `kind: null`. They are never answered by nika.

### 13.5 When nika does not read a dialog (`unreadable`, the page keeps its banner)

| Reason | Seen live / rule |
|---|---|
| `cut` | No top rule directly above the strip, or no strip (a pane shorter than the dialog: the dialog clips from the top, the option list scrolls, and `↑` / `↓` replace the two leading spaces of the first or last visible option row, which no option pattern matches); a plan without `Ready to code?`, either `╌` rule or the prompt row. More rows show it: since F16 (0.5) the page gives a cut-off question more rows (`api-app.md`, "A cut-off question"; never a plan) |
| `clipped` | (0.5, F16; before it this was `cut`) A tab header, an option label (a question's or a plan's), the question, or a review question or answer that ends in `…`: Claude shortened the text to the pane's width. More rows never help. Descriptions and the typed text value are not checked for it |
| `wide` | A row (not a rule, not the free-text row's wrapped value, not a plan row) as wide as the pane: Claude may have cut it. A row under an option row whose first word would **not** have fitted behind the option's last character: a wrapped label looks like a description by its indent, so nika cannot tell them apart unless the row's first word would have fitted behind the label (word wrap at `cols - 1` would then have kept it there, so the row is a description: `src/dialog.js:222-225`). A wrapped footer. Fewer than 20 columns. **Exempt (F13-B):** a row that reaches the pane's last column is accepted when the row right below it continues the same question
paragraph or the same option's description (a question row followed by another question row, a description row followed by another row of the same description; on the review step, a question row followed by a rest row of the same question with the same bar state, FXR, §13.2), because
a long question is drawn that wide (§13.1). At 40 columns Claude wraps the question, the labels, the descriptions and the footer (2 rows, 3 with INSERT), so the old banner shows |
| `numbers` | Option numbers not `1..k+2` without gaps, or above 9 (a digit answers without `Enter`, so `k` is at most 7); the free-text row not `k+1`, the chat row not `k+2`; a button row on a single-select question or none on a multi-select one |
| `tab` | Not exactly one current tab (zero or two marked tokens) |
| `layout` | Some but not all of the question's rows start with Claude's `│ ` bar (§13.1; on the review step, some but not all rows of one question, §13.2, 2.1.326); a barred review answer row, a bar on the review's `1. Submit answers` or `Ready to submit your answers?` row (§13.2); a question row that is only the bar, with no text, reads as no bar (shape unverified); the footer says `↑/↓` with several tabs, or `Tab/Arrow keys` with one tab and no `Submit`; a multi-select question or several tabs without `Submit`; a duplicate label, a label equal to the free-text or chat placeholder, a header, label or question holding `☐`, `☒` or `✔`; a string over its maximum (header 40, question 500, label 200, description 500, answer 500); the button row's name disagreeing with the last-tab rule; any other shape |
| `survey` | Claude's feedback survey is on screen (it takes digits, §10.1) |

- Measured on short questions: the widest text row is `cols - 1` in every capture (119 at 120 columns, 39 at 40); only rule rows reach `cols`. A long question
  with the bar can reach `cols` (§13.1). 300 typed
  characters in the text row read back exactly (3 rows joined with one space: the break space of a wrap disappears).
- At 40 columns the footer wraps, but a wrapped footer is still found (the last one to three non-blank rows joined) so `dialogOnScreen` is
  true and the capture says `unreadable` / `wide`, not `null`.
- A subagent list under a question, review or plan dialog is cut when the row above its blank row is the dialog's last row (`isDialogEnd`,
  §1). Whether Claude draws the list under a dialog at all was **never seen live** (spike L7 did not fit in the budget); the fixtures cover it.

### 13.6 The keys

| Step | Goal | Keys | Verified |
|---|---|---|---|
| question, single-select | pick `p` | `p` (a digit as text) | live; one tab: the dialog ends, several: advances to the next tab |
| question, single-select | Other text `T` | `Down` until the text row, `-l T`, `Enter` | live (plain and vim) |
| question, multi-select | picks | the digit of each box that differs (it toggles and leaves the focus), then `Right` from an option row | live |
| question, multi-select, last tab | Other text | the picks, `Down` to the text row, `-l T`, `Down` to the button row, `Enter` | live (T0c; the review `→` line reads `<ticks>, <text>`) |
| review | submit | `Enter` on `1. Submit answers` | live |
| plan | choice | a digit | live (option 2) |
| any | decline | `Escape`; in vim INSERT the first only leaves INSERT, a second (after a gap) closes the dialog | first: S3, T0, T4; the second: T0b (1.2 s apart) |

- `Right` does **nothing** from the text row or from the button row; it works from an option row (so the multi text road uses `Down` and
  `Enter`, and only the last tab's was verified). `Left` goes to the previous tab and resets the focus to option 1.
- One `Escape` closes the whole dialog at once (`User declined to answer questions`); the model does not continue. After two declines in one
  session the model may refuse to ask a third time.
- vim: the `-- INSERT --` marker shows **only while the text row has the focus**; one `Escape` there leaves INSERT and keeps the dialog and the
  text. nika's own `Down` onto the text row lets vim enter INSERT at once. Plain mode draws the same text-row footer as vim NORMAL, with no
  marker, so nika types there only on a pane it knows is plain or right after its own `Down`.
- A leading digit on an empty free-text row was typed as text in the live check (`4. 2`), not taken as an option; nika still refuses
  free text that starts with 1 to 9 (a precaution: the route says 400 `invalid`).
- Down from the first option walks 1, 2, 3, the text row, `Chat about this`, and stays there; with a dialog open it never reaches the
  `<n> shells` pill.

**Never sent by nika:** `Up`, `Tab`, `BTab`, `Space`, `C-c`, `C-u`, `C-d`, `Left`; a digit while the text row has the focus; anything on
`Chat about this`; `Enter` except as listed; any key after the dialog closed; any key toward another tab.

### 13.7 The live check through nika's page (W1-T4)

Single-select, a 4-question form tab by tab with a review, multi-select, Other (single and multi, plain and vim), a plan choice, Decline (also
on a review) and the refusals (`dialog-touched` after text typed in the terminal, `dialog-focus` after the focus moved to `Chat about this`)
all gave the keys the tables above list, and nothing from "Never sent". At 40 columns the capture said `unreadable` / `wide` and a form already
shown went read-only; a direct `POST` with any `sig` was 409 `dialog-changed` with no key. The browser tier had no route and no `dialog` key.
Scrolling with a dialog open: 409 `screen-unclear`, no key. A vim multi text row left in NORMAL: 409 `text-mode`, nothing typed; after the
user brought the focus back, Claude re-entered INSERT on arrival and the request finished.

**Not verified:** Decline from vim INSERT through nika (two `Escape` presses with `sent: 2`); a digit on the multi-select text row; the 560 px
layout of the form; the first `Down` onto a single-select text row on a plain pane that nika never saw (the live check always typed after an
INSERT or a prior probe); `Enter` after text on the plan's free-text option; Stop and End during a long busy turn with a real subagent list
(only the status line and the shells pill were tried); a taller dialog than the pane at the fit's smallest size (it reads `cut`; since F16 the page asks for more rows then, and how Claude redraws the dialog at 42, 84 or 120 rows, and how
tmux shows a window taller than a terminal that also shows it, are not verified against a real Claude).

## 14. Claude's own subagents: their files while they run (0.5, W8)

Claude Code 2.1.325, checked on 2026-11-15 (live check L1, Haiku, two runs, each with one background subagent). Every name and number below is
from that throwaway session; no id, path or text of it is copied here. nika reads these files in `src/collect/subagents.js` and
`src/collect/history.js`; the contract for what it shows is `api-app.md` (`subagents` in the snapshot, the subagent history route).

**Where.** `<claude dir>/projects/<slug>/<session uuid>/subagents/`, holding for each subagent `agent-<id>.meta.json` and `agent-<id>.jsonl`. The
ids seen are 17 lowercase hex characters (two agents); nika accepts `^[A-Za-z0-9_-]{1,64}$` (`SUBAGENT_ID`) because other builds and fixtures use other
shapes. The parent's tool for starting one is `Agent` in 2.1.325 and `Task` in older builds.

**The meta.** About 270 bytes of JSON with the keys `agentType`, `isBuiltIn`, `launchedWithDefaults`, `description`, `toolUseId`, `spawnDepth`,
`requestShape`, `requestNonInteractive`, `pickedEffortModel` and, only when set, `finished`. There is no `model` key in 2.1.325 (nika reads
`pickedEffortModel` instead). `toolUseId` equals the `id` of the parent's `Agent` tool call: that is the whole link between the call and the
subagent's files (the subagent's own `.jsonl` does not name the parent's call).

| Fact | What the check saw |
|---|---|
| The meta exists from the start of a run | seen 2 to 4 s after the `Agent` call; while the subagent runs it has **no `finished` key** (absent, not `false`) |
| `finished: true` | written, as the last key, when the subagent's loop **stops**; seen within one 5 s poll of the stop |
| `finished` is not final | when the subagent wakes up again (the check: its background shell ended and Claude woke it) the key is **removed** and the file is back to its running size; it is written again when the subagent stops. A subagent can be listed by Claude as waiting on its own background work while its meta already says `finished: true` |
| The meta's mtime | changes at each of those writes |
| `agent-<id>.jsonl` exists from the start | 17 to 23 lines (116 to 229 KB) at the first sample, 0 to 2 s old; the first line is a `user` entry |
| It grows only at message boundaries | during one long tool call (about 85 s) it stayed at the same line count and size, then jumped; its mtime is therefore not a sign that the subagent is alive |
| Escape in the parent | interrupted only the parent's own foreground tool ("Interrupted · What should Claude do instead?"); the background subagent ran to its natural end, and its meta and `.jsonl` did not change at the key |
| `requestShape` | `background` in both runs, also when the parent had asked for a foreground subagent (the parent said so itself) |

What nika does with it: the snapshot's subagent `state` is `finished` when the key is `true`, else `running` while the parent session is live, else
`stopped`; it is read again on every snapshot and every poll of the read-only view, and nothing is latched (`api-app.md`, subagent history route).

**Not covered.** A user stopping a subagent directly (for example from the `↓ to manage` panel), and a foreground subagent (never produced), so what
`finished` reads after either is unknown. Older and newer Claude Code builds were not checked: if the folder moves or the tool is renamed again, the
rows and links go quiet (no rows, no link), nothing worse.

## 15. tmux: giving a squeezed window back with its layout (0.5, F15, spike S-F15)

These are facts about tmux, not about Claude; they sit here because the fit (`src/fit.js`, ADR 0017) reads Claude's pane through them. Checked 2026-11-16
on **tmux 3.8** (macOS, a private server, panes running `sleep`, no Claude), with no client, with a control-mode client (`tmux -C attach`, unsized and sized
to the window) and with a real tty client. tmux 3.2, the floor, the versions in between and 3.6a (the CI runner) were not part of this spike; the
`linux-verify` group `F15a` runs the same sequence on the runner's tmux.

- **The give sequence is exact.** `resize-window -t @W -x <W0> -y <H0>` (R3), `set-option -wu -t @W window-size` (R4), `select-layout -t @W -- <T>`,
  `resize-pane -Z -t %P` restored the stripped layout, the zoom, the active pane, every hidden pane's size, the window size and the unset `window-size` option in
  **870 of 870 cycles** (29 cases × 30 cycles: windows from 64 × 46 to 200 × 50 squeezed to panels from 145 × 28 down to 12 × 20; 4 and 6 panes, side by side and
  stacked, also when the squeeze pushed hidden panes to 1 column or 1 row). The same four commands as one tmux invocation passed 480 of 480 cycles (16 cases × 30).
  Nothing drifts across cycles: the layout read at the start of cycle N equalled cycle 1's in every case.
- **`#{window_layout}` under zoom** still returns the full unzoomed layout, hidden pane sizes included, and `#{window_visible_layout}` returns the single zoomed
  leaf. In tmux 3.8 the layout is JSON (`{"V":2,"L":{…}}`) with `"a":true` (active) and `"l":N` (last) markers, which nika strips before it compares or applies one.
- **Without `select-layout` the layout does not come back.** A plain round trip (`resize-window` there and back) left a different layout in 16 of 29 cases
  (some stacked and some side by side; the other 13 came back unchanged), with the zoomed pane's own size drifting too (one case: 80 → 74 columns); the drift
  appears on the first round trip and then repeats exactly (30 round trips gave one distinct layout). `select-layout` fixed all of them, and it **always unzooms** (32 of 32 runs, also on a window that was unzoomed already), so the pane is zoomed again.
- **`select-layout <T>` on a window that is not exactly T's size** never fails (exit 0, no output). With `window-size` manual it **scales** T to the window and
  leaves the option alone; with the option unset and no sized client it resizes the window to T's size and is exact. The give satisfies this because the resize
  back and the option come first.
- **Clients.** No difference in any measured value between the four client kinds. The one client effect: `set-option -wu window-size` snaps the window to a
  sized client's size at once, where with no (or an unsized) client it leaves the window where it is. A control-mode client's `%layout-change` events carry
  the flags `*` (not zoomed) and `*Z` (zoomed) and alternate per cycle, so the unzoomed moment between `select-layout` and `resize-pane -Z` is visible to a client.
- **Smallest panel.** 6 panes side by side reach 11 columns × 1 row, stacked 1 column × 11 rows (2n − 1 along the split axis, 1 on the other; 4 panes side by
  side: 7 columns). Below the minimum `resize-window` exits 0, prints nothing and leaves the window at the minimum on that axis while keeping the other as
  asked, so the window ends larger than the panel and only a read-back shows it.
- **Not verified:** how long every pane is visible between `select-layout` and `resize-pane -Z`; a user changing focus between the take and the give; a client of
  another size at give time; mixed grids (rows of columns); tmux 3.2; a shell's or editor's redraw (the panes ran `sleep`).

## 16. The "Adding a new directory" question for `--add-dir` (2.1.326, spike S-ADD)

Checked 2026-11-17, Claude Code 2.1.326, tmux 3.8, macOS, a 120 x 40 pane, throwaway folders, no model turn.

- A folder passed with `--add-dir` that Claude has not been started in shows, at start, after the folder trust of the working directory if
  that is new: `Adding a new directory:` and the path, `This session hasn't worked here before. Is this a directory you created or one you
  trust?`, a paragraph ending `Your answer holds for this session.`, then `❯ No, exit` and `Yes, add it` (no numbers; focus on No), footer
  `Enter to confirm · Esc to cancel`. Same in `default` and `auto` permission mode.
- "This session" is the claude process: a restart with the same folder (and the same `--session-id`) asks again.
- `No, exit` and `Esc` end claude with status 1 and print `To go on without it, start again with the same flags but without --add-dir <dir>.`
  An `Enter` that reaches this screen answers No. A typed character selects nothing; the footer then reads `Esc to exit · To add it, press ↓ to
  Yes, then Enter (your text is kept)`. Only `Down` moves to Yes.
- Not asked: a folder inside the working directory; a folder under one Claude was started and trusted in (that trust lasts); a folder given in
  `--settings` as `permissions.additionalDirectories`, which `/permissions` then lists under Workspace like an `--add-dir` folder. With both,
  only the `--add-dir` folder asks.
- The `.claude/commands` of an `--add-dir` folder load into the session; those of a `permissions.additionalDirectories` folder do not.
- nika reads nothing on this screen: the footer is no mode line, `promptFromRows`, `dialogCapture`, `readDraft` and `surveyOf` are null, so
  the page shows no form and plain-input routes answer 409 `screen-unclear`. Since 0.5 (F18) `nika spawn` passes its reports dir in
  `permissions.additionalDirectories` (`agentSettings`, `src/spawn.js`), so its agents never see this question.
