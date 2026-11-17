# ADR 0015 — Claude's question dialogs and plan approvals, read from the screen and answered one step at a time

Date 2026-11-15 · Status accepted (nika 0.5, W1)

## Context
When Claude asks the user a question (`AskUserQuestion`: one to eight questions in tabs, a review step, then Submit) or asks to
approve a plan (`ExitPlanMode`), it draws a full-screen dialog in its pane. Until 0.5 the session window showed only a banner
("`<name>` needs you ... Answer it in the terminal"). The owner wants to answer these from the window, with the same care as the
permission-prompt buttons (ADR 0010, rule 12).

The facts that shaped the design:

- **The call is not on disk while the dialog shows** (spike W1-T0, L1). The transcript gets the `tool_use` and its `tool_result` in one
  write, after the dialog ends. A 4-question dialog was open for 96 s and the file did not change. The plan's first design (read the
  pending call from the transcript, bind the answer to its call id) cannot work.
- **The screen shows one question at a time.** Only the current tab's question, labels and descriptions are drawn; the other tabs show
  their header in the strip. The review step shows every answer. Long text is wrapped or cut at the pane width, and Claude gives
  no sign of which (`claude-tui.md` §13).
- **The keys are known.** A digit picks (and, on a single tab, submits) or toggles a box; `Down` moves the focus; `Right` leaves a
  multi-select tab from an option row; `Enter` on the free-text row, on the multi button row or on the review's `1. Submit answers`
  moves on; `Escape` declines the whole dialog; the plan approval takes a digit. Typing a leading digit on the free-text row typed as text
  in the live check, but that is a precaution nika keeps (below).
- **There are lookalikes.** `Exit plan mode?` (no footer) and the auto-mode nudge (digit options) are digit-taking dialogs nika does not
  answer.

## Decision
- **The screen is the only source.** `src/dialog.js` reads the dialog from the rows of a capture, exactly or not at all: a dialog that is
  cut off, may be cut at the pane's last column, may have a wrapped label, has an option number above 9 or a gap, has no single current
  tab, any other shape, or a feedback survey on screen is `unreadable`, and the page keeps the old banner. The capture's `dialog` field is
  `null`, `{ state: "unreadable", kind, reason }` or `{ state: "ready", kind, at, sig, bypass, ... }`.
- **`sig` binds the parsed step**, never raw rows: 16 hex of sha256 over the strip headers, the current tab, the question, the labels and
  descriptions; or every review pair; or the visible plan rows and the choices. Focus, ticks, the typed text and the answered marks are
  not in it, because they change during a request.
- **One route, one step per request.** `POST /api/app/pane/:id/dialog` takes `{ sig, picks, text? }` (the current question),
  `{ sig, submit: true }` (the review), `{ sig, choice }` (a plan choice) or `{ sig, cancel: true }` (Decline). nika follows Claude's tabs
  and never moves between them: after an answer the next question shows with a new `sig`.
- **Under the pane lock, a fresh capture before every key.** The step identity must equal the request's, the state must be the one the
  previous key should have left, and nothing a person could change in the terminal (the focus, the boxes, the typed text, the INSERT
  marker) may differ from the screen the last key was proven on. Else nothing more is sent (409) and the answer says how many keys went out.
- **Keys.** A digit 1 to 9 as literal text on a numbered option, `Down`, `Right` (from an option row), `Enter` (the free-text row that reads
  back exactly the typed text, the multi question's button row after its Other text, the review's `1. Submit answers`), free text through
  `send-keys -l`, and `Escape` for Decline. Never `Up`, `Left`, `Tab`, `BTab`, `Space`, `C-c`, `C-u`, a key on `Chat about this`, or a key
  after the dialog closed. The named-key allow-list is unchanged.
- **Free text** is 1 to 300 characters, with no control, bidi, zero-width or other format character, no space at either end, and **no
  leading digit 1 to 9** (the route says 400 `invalid`). It is typed only in vim INSERT, on a pane nika knows is plain, or right after
  nika's own `Down` brought the focus onto the text row with no INSERT coming. In a multi-select question it is offered only on the last tab
  (the text, `Down` to the button row, `Enter` opens the review); elsewhere "Other answers: use the terminal".
- **The plan choice is a digit** (spike W1-T0b L5). The plan's own text option ("Tell Claude what to change") stays in the terminal, and the
  plan text is never shown: "Read the plan in the terminal view" (owner).
- **Bypass means terminal only** (owner, Q1). A step whose region, or typed text, mentions bypass is answered only in the terminal; Decline
  stays.
- **Decline is `Escape`.** One closes the whole dialog; in vim INSERT the first only leaves INSERT, and a second goes only after a fresh
  read shows INSERT gone, 40 ms later.
- **Other controls while a dialog shows.** Stop is 409 `prompt-open` (a recognised dialog) or `screen-unclear` (a screen nika cannot read),
  nothing sent. The mode switch, the commands, draft writes, suggestion accepts and the attachment send refuse with nothing sent. End
  declines it first, like a permission prompt. The keys route and the page's passthrough are unchanged (rule 12 guard).
- **The form stays locked after 409 `dialog-touched` and `dialog-focus`** (ruling 2026-11-15). The user changed the dialog in the terminal;
  the problem line sends them there to finish it. A new `sig` or `dialog: null` unlocks the form.
- **`Escape` in the message box is a passthrough**, as in the terminal and as for a permission prompt: it declines the dialog without the
  form's `sig` check (ruling 2026-11-15; threat T37, residual p).
- **App tier only.** No route and no `dialog` field on :3335.

## Alternatives
- **Read the pending call from the transcript** (the first design). Not on disk while the dialog shows (T0 L1).
- **A `PreToolUse` hook that reports the call.** Rule 4 forbids reading Claude's `hooks` key, and nika never edits Claude's settings.
- **The banner only.** The owner chose forms.
- **One request with every answer** (`{ kind, sig, toolUseId, answers }`). Only the current tab is visible; the form follows Claude's tabs.
- **`sig` over the last 20 rows.** Rows change with every focus move, tick and typed character, and carry the subagent timers.
- **Navigating Claude's tabs** (`Left`, skipping). A key toward a tab nika did not read would answer an unseen question.
- **Cancel through the keys route.** A stray `Escape` on a busy Claude interrupts a turn, and INSERT needs two; `/dialog` checks the `sig`.
- **`Space` in the allow-list.** Digits toggle, so it is not needed.
- **"Chat about this"** (owner: not in 0.5) and **free text in multi-select on every tab** (`Right` does nothing from the text or button row;
  only the last tab's `Down` + `Enter` road was verified).

## Consequences
- One question at a time. A several-tab form is answered tab by tab and ends on Claude's review; Submit binds to the pairs the user saw.
- No plan text in nika. A taller dialog than the pane, a narrow pane (the footer wraps) or a long label is `unreadable` and keeps the banner.
- Residual: an identical dialog asked again between the page's capture and the request is answered as the first would have been, and tmux has
  no compare-and-send, so a dialog closed in the few ms between the last check and a key can receive that key (`docs/security.md` T37).
- Under a subagent list, an `AskUserQuestion`, review or plan dialog is read (the list is cut when the row above is a dialog end); a permission
  prompt or an unknown dialog with the list below stays `unknown`.
- Not built (YAGNI): "Chat about this", the plan's text option, navigating tabs, plan text, anything on the browser tier.

## Amendment 2026-11-16 (0.5, final review, F13 and Design B): a task list under the dialog, and long questions

**Context.** Claude 2.1.325 (spike S-F13) draws its task list under a dialog and under a permission prompt: a header `N tasks (D done, …)`, one row per
task, and in a named session a labelled rule row above it. A long question or option description is drawn with a bar `│ ` in front of each row, and a row can be
exactly as wide as the pane. Round 1 read some of these shapes; the owner approved the exact grammar below (rule text v2 for constraint 12, 2026-11-16).

**Decision.**
- **The block is cut only when it matches exactly** (`taskEnd` in `src/mode.js`, read from the bottom, rows right-trimmed). Anchors above it: the two ask footers, the
  review's `2. Cancel`, the plan footer (also as 2.1.325 draws it, `ctrl+g to edit in Vim · <path>`) and a permission prompt's `Esc to cancel` footer, the last
  only when `promptOf` parses a prompt in the 15 non-blank rows ending there. The cut is either a rule row alone as the last non-blank row (plain or labelled), or, in a
  named session, a rule row at column 0, exactly one blank row and the task block, or, in an unnamed session, the task block with at least one blank row above it. The
  header is `  N tasks (D done, [P in progress, ]O open)` (`0 in progress` is no cut, `1 tasks` is real); the rows are `  ◼|✔|◻ <label>`; an optional last row
  `   … +N in progress, N pending, N completed`; the counts must add up. A label is never read, shown or sent. Any mismatch cuts nothing, and the dialog stays the banner.
- **A permission prompt keeps its answer path.** `promptSig`, the options and the question are the same with and without the block (the cut precedes `lastNonBlank`).
  The bypass guard (constraint 12) reads the 15 non-blank rows ending at the footer **and** those ending at the screen's last row, so a task label that mentions
  bypass still stops the keys route (409 `bypass-prompt`) and the buttons ("answered in the terminal").
- **Design B (`src/dialog.js`).** A bar `│ ` on every question row (left out of the text) or on none; some rows with it is `layout`. A row as wide as the pane is accepted
  only when the row below continues the same question or the same option's description; every other pane-wide row stays `wide`.

**Alternatives.** Cutting any rows under the dialog (it could hide a prompt or a warning; rejected). Reading the task labels (never needed, and they are agent text).
Waiting for Claude to hide the list (no signal for it). Matching other Claude versions' shapes without a capture (fail closed instead).

**Consequences.** The shapes come from Claude 2.1.325 and the strings in its binary; another version that draws something else is `unreadable` and keeps the banner. The
subagent list is still cut only under a mode line or a dialog end, not under a permission prompt. A question row that is only `│` reads as no bar, so `layout` (a shape
never seen; open question). `docs/security.md` T37 and `docs/contracts/claude-tui.md` (the section on the task list under a dialog, §13.1, §13.5) carry the details.

**Open point (M2, from the 2026-11-16 re-review; not seen live).** Claude draws the bar when the question text holds a line break, so a question with a paragraph break has a
blank row inside it. If that row is drawn as `│` alone, nika reads it as a question row without the bar, so the dialog is `unreadable / layout` and the user answers in the
terminal (a missed feature, not a safety problem: it fails closed). A probe on synthetic rows shows `layout` for that shape and a normal read for the same question without the
blank row. Whether Claude draws `│` on the blank row is for the next live capture; only then should a row that is exactly `│` count as barred and stay out of the question's text.
`docs/contracts/claude-tui.md` §13.1 carries the same line.

## Amendment 2026-11-17 (0.5, F16): `cut` and `clipped`

**Context.** The reason `cut` meant two things: the dialog's top is clipped (Claude cuts a dialog taller than the pane from the top, so more rows show it), and a header, label, question or answer ends in `…` (Claude shortened the text
to the pane's width, so rows never help). F16 lets the page ask for more rows while a question is `cut` (ADR 0017, amendment of the same date); with one word for both, the page would grow to the cap and back, three or four resizes
and about 5 s, every time a question with a shortened label opens.

**Decision.** `src/dialog.js` reports a text that ends in `…` as the new reason **`clipped`**; `cut` keeps "no top rule above the strip, no strip, a plan without its rules". `REASONS` is now
`['cut', 'clipped', 'wide', 'numbers', 'tab', 'layout', 'survey']`: `cut` returns early in `readAsk`, so `clipped` right after it keeps every old precedence among the others, and a clipped top still wins over a shortened text. `clipped` is
produced for tab headers, option labels (a question's and a plan's), the question, and a review question or answer; descriptions and the typed text value never were checked for it. `public/dialog-form.js` knows the new word (an unknown
reason still cleans to `layout`, so an old page with a new server fails closed). The capture's ETag is unchanged (the field is a pure function of the rows), no copy shows the reason, and the banner is the same for both.

**Alternatives.** Keeping `cut` for both: the cost above, every time such a question opens.

**Consequences.** Only the page's grow reads the difference. A plan's option label ending in `…` now reads `clipped` (it read `cut`); plans are never grown, so the page shows the same banner. `docs/contracts/claude-tui.md` §13.5 and
`docs/contracts/api-app.md` (the capture's `dialog` field) list both reasons.

## Amendment 2026-11-17 (0.5, T326 and FX2): Claude 2.1.326's task list, and the bar on the review step

**Context.** The live check LC17 (build 17) found two things with Claude Code 2.1.326. (1) Claude draws its task list in another form: the header `  D/T tasks done`
(with ` · P in progress` when P is above 0) and an overflow row `  … +N task[s] (…)` with two spaces and the words `in progress`, `open`, `done`. `taskEnd` knew only the 2.1.325 form,
so a question, review, plan or permission prompt with the list under it read as no dialog at all (`dialog: null`, no form, no banner, no grow). The follow-up spike S-T326 fed its captures
to the old reader: every block under a dialog or a prompt (14 of 14) was wrong; only idle and the lone rule row read right. (2) The review step draws the bar `│ ` in front of the rows of a long question
(` │ ● <question>`, ` │   <rest>`) and not in front of a short question or of any answer row, so a review of long questions read `unreadable / layout` and could not be submitted from the page.
Both came from spike evidence only; nothing is copied from a private session (`claude-tui.md` §1 and §13.2 have the made-up shapes).

**Decision.**
- **T326, two forms (`src/mode.js`: `taskEnd`, with `headOf`, `moreOf`, `partsOf`).** `taskEnd` reads the 2.1.325 form and the 2.1.326 form, and **one block is one form**: a header of one version with an
  overflow row of the other is no block. The 2.1.326 header is strict (T at least 1, `task` exactly when T is 1, D + P at most T, no ` · 0 in progress`), and so is its overflow row (two spaces, N the sum of the parts,
  `task` exactly when N is 1, parts above 0 once each and in the order `in progress`, `open`, `done`, those words only). The counts rule of the 2026-11-16 amendment holds: with an overflow row the visible rows plus
  the hidden parts equal the header's counts, state by state. One addition for the pane of 12 to 13 rows, where Claude draws three task rows and no overflow row although tasks are hidden: a 2.1.326 block with task
  rows and no overflow row is read when no state has more visible rows than the header counts; a 2.1.325 block without an overflow row stays exact. A header with no row under it is read on its own numbers and allows
  no overflow row. Nothing else changed: the anchors, the placement (rule row, exactly one blank row in a named session, at least one blank row in an unnamed one), the lone rule row, the bottom position, the 15-row
  prompt window, the bypass windows and the fail-closed `-1` (nothing cut, the footer reads `unknown`). No cap on the number of rows is applied; the numbers bind them.
- **FX2, the review's bar (`src/dialog.js`: `BAR_ROW`, `readReview`).** The review step accepts the bar on a question's rows and takes it out before reading, **per question**: every row of one question (the `●` row
  and each wrapped row) is barred or none is, and different questions of one review may differ. These are `layout`: a mix inside one question, a barred answer row or answer continuation, a row that is only the bar,
  and a bar on `1. Submit answers` or on `Ready to submit your answers?`; a bar on the last row (`2. Cancel`) leaves the review unrecognised, as before. The text is stored without the bar, so `sig` is the same with or
  without it (the question step already worked this way). A review question row as wide as the pane is accepted when a rest row of the same question with the same bar state is directly below it, as on the question step (FXR, found in the live check LC19: two long questions drew the `●` row exactly as wide as the pane and the review read `wide`); any other full-width review row stays `wide`. FX2 first built the rule per step (all question rows of the review barred or none); spike S-T326 item 9 then showed
  a short question without the bar next to a long one with it, so the rule is per question (a rule change on new evidence; the one test that mixed across questions became a `(+)` case, the mix inside one question stays a `(−)` case).

**Alternatives.** *Dropping the 2.1.325 form:* not done, a session on an older Claude still draws it. *Reading the 2.1.326 header and overflow row without the "one block, one form" rule:* a mixed block matches no
captured drawing, so it stays uncut. *A bar rule per review step:* rejected by the evidence above. *Capping the task rows at 5:* not done; the counts already bind the rows, and a cap would break on a Claude that
shows more.

**Consequences.** (1) Under 2.1.326 the form, the banner, the grow (ADR 0017, F16) and the permission prompt's buttons read as they do without the list; the prompt's `sig` and options are unchanged. (2) In the 12 to 13 row pane the
2.1.326 rule accepts fewer rows than the header counts, so a block cut by something else would also read; the anchor, the placement and the bottom position still have to hold. (3) The block's all-done frame
(`N/N tasks done`, 3 to 4 s) reads like any other, and what is left after it (a lone rule row, or blank rows) is cut as before. (4) Both fixes are tested on synthetic rows built from the spike, and were re-checked live in LC18 (2026-11-17, Claude Code 2.1.326): the form, grow and prompt panel with a task list under them in a named and an unnamed session, a pane
of 13 rows, and the review of two long questions as a form with Submit working from the page. (5) The task-list sentence of rule 12 in `rules/project-rules.md` (owner-approved 2026-11-17) and threat T37 in `docs/security.md` name both forms;
this amendment itself changes no rule text.
`docs/contracts/claude-tui.md` (§1, F13; §13.1, §13.2, §13.5), `docs/design/spec.md` §9.16 and `docs/contracts/api-app.md` (the capture's `dialog` field) carry the details.
