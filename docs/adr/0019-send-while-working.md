# ADR 0019 — Send while Claude works: End and C-u instead of Escape, and one guarded Enter

Date 2026-11-15 · Status accepted (nika 0.5)

## Context
Draft sync (W5) and attachments (W2) held Send back while Claude works, in two places: a replace of Claude's input cleared it with
`Escape`, which interrupts a running turn, so it needed the registry state `idle`; and attachments were sent only at idle. The
owner's own sessions show Working almost all the time, because background agents and shells keep the registry at `busy` or `shell`
(owner recording, 2026-11-15). In practice attachments never went, and nika's message box and Claude's input drifted apart. The owner
asked for Send to work the way the terminal does: the text and the attachment paths go into Claude's input and `Enter` is pressed,
and Claude takes the message at its next step. That raises four questions:

- **How does nika rewrite Claude's input without interrupting the turn?** `Escape` is the one key that does.
- **What does `Enter` do on a busy pane, and how does nika know it was taken?**
- **What if a permission prompt or a dialog opens while the page looks the other way?** Until now Send's `Enter` went through the
  keys route, which only refuses a prompt whose window mentions bypass. While a turn runs, a prompt can open at any moment, and an
  `Enter` that lands in it confirms its highlighted option.
- **What must stay refused?**

The live facts are `docs/contracts/claude-tui.md` §10.12 (spike W13, Claude Code 2.1.325, tmux 3.8). `C-u` never interrupts, in plain
mode and in vim INSERT, and `Escape` with text in the plain box does. `End` reaches the end of the text only from the box's last
row. `Enter` on a busy pane queues the message (the box shows the dim text `Press up to edit queued messages`); with the turn over and
a background shell or agent running it submits at once. An image path pasted while busy turns into `[Image #N]` and is queued with
the message.

## Decision
Owner decision 2026-11-15, "Send now, like the terminal", with the answers to the design's questions Q1 to Q5:

- **Clear with `End` and `C-u`; `Escape` only at idle.** When the terminal cursor is on the box's last row, a replace sends `End`
  (only when the cursor is not at the end of the text) and `C-u`, one key per request at least 60 ms apart, in any registry state.
  Before every key a fresh capture must show the plain box with the cursor in it, no prompt or dialog, and a text that is the start of
  the text before the press; a press must shorten the text (or take a row off) within 400 ms. The W5 `Escape` road stays as a
  fallback for a cursor on an earlier row, and only while the registry state, read fresh, is `idle`. A cursor on an earlier row while
  Claude is not idle sends nothing: 409 `cursor-not-at-end`. Unchanged in vim NORMAL and unknown mode: the probe `i` goes first (safe
  while busy).
- **One guarded `Enter` for every Send, at idle too.** New route `POST /api/app/pane/:id/submit { base? }` (app tier only) under the
  pane lock: no Stop or End interrupt running, one fresh capture, no permission prompt or dialog (409 `prompt-open`), a bypass window
  refused as on the keys route, a readable footer or a box, and with `base` the exact synced box; then exactly one `Enter` in any
  registry state and a read-back of at most 1 s that answers `taken`. The legacy path (a screen nika cannot parse, so no `base`) still
  sends its `Enter` when no prompt, dialog or unknown footer is on screen. The page's Send never posts `Enter` to the keys route; the
  passthrough keeps it.
- **`!` shell commands are sent** like any other message. Claude queues them and runs them after the turn.
- **Claude's queued placeholder is an empty box.** `parseDraft` reads it as `state: 'empty'`, `queued: true`, `suggestion: null`. The
  page shows a `Queued` note and never offers the placeholder as a suggestion.
- **Attachments send while Claude works.** `attach-send` drops its two registry-`idle` checks; every other check stays. Its own
  `Enter` is not routed through `submit` (it pastes and re-checks between its pastes).
- **Two small rulings from the review.** `submit` refuses an empty box that shows a prompt suggestion (409 `suggestion-shown`), because
  what `Enter` submits there was never verified; the page sends nothing when both boxes are empty and nothing is attached.
- **Page.** The `wait` note ("Waiting for Claude") becomes `hold` (a prompt is open or Stop runs); `cursor` and `queued` are new. A
  `clear-stopped` write keeps the page's text and never adopts the half-cleared screen. Stop's title says that a queued message goes to
  Claude at once.
- **Still idle-only:** the mode switch, End session, the quick-action commands and accepting a suggestion with `Tab`.

## Alternatives
- **Refuse while Claude works (the state before).** Safe and simple, and it is the problem: with background agents the registry is
  almost never idle.
- **Hold the message in nika until Claude waits.** Not Claude's queue: the message could never steer the turn, and with background
  agents "waits" may never come.
- **Escape at idle and `C-u` only when busy (design Q1 A).** Keeps today's race on `Escape`: a turn can start between the registry
  read and the key. Rejected: use `Escape` only where there is no other key, and only after a fresh read.
- **Never `Escape`, refuse when the cursor is not on the last row (design Q1 C).** Refuses after any cursor move in the terminal even
  at idle, where the Escape road is safe. Rejected.
- **`BSpace` once per character.** A draft can hold 1024 characters, the key limit is 20 requests per second per pane, and it deletes
  only before the cursor. `C-u` removes a whole visual row per press.
- **Walk to the text end with `Up`, `Down` or `DC`.** `Up` and `Down` recall history or open the task manager, and `DC` joins lines.
  `End` stops at the end of its visual row, so there is no safe key from an earlier row: refuse instead.
- **A stricter guard on the keys route instead of a new route.** The page's passthrough carries the user's own keys, including an
  `Enter` typed in the mirror to answer an ordinary permission prompt, and that must keep working. A Send-only route keeps one
  `Enter` path for Send with one test set (design Q2).

## Consequences
- The only keys the busy clear sends are `i` (probe), `End`, `C-u` and `BSpace`, never `Escape`; a test fails on any `Escape` sent
  while the fake registry is not idle. `docs/security.md` T54 and `rules/project-rules.md` constraint 12 record it, and the W2
  amendment (attachments) reads "also while Claude works".
- A message queued while Claude works is delivered at its next step, so it can steer a turn already under way (Claude's own feature,
  attachments included). Stop with a queued message ends the current step and sends the queued message at once; it is not put back
  into the input box.
- The residual race of T26 and T51 (the few ms between a capture and tmux delivering the key) now applies to Send's `Enter` while a turn
  runs, and to the attachment send's own `Enter`. A user who moves the cursor into the text between two `C-u` presses gets one more
  `C-u` at that cursor before the next check stops the loop. Both are in T54.
- While Claude works and the cursor is on an earlier row, an edit of the message box is held (the `Cursor` note) until the user moves
  the cursor to the end in the terminal or Claude is idle.
- The `queued` reading depends on Claude's exact wording. If a release rewords it, the box reads as an empty box with a suggestion,
  nothing is sent that was not before (accepting a suggestion is idle-only), and only the `Queued` note is missing.
- Verified live on a busy pane (spike W13 and the writer's own check): `C-u` and `End` in plain mode, vim INSERT and vim NORMAL,
  three lines, a wrapped line, `End` from the last visual row of a wrapped line, `Enter` queuing with the queued placeholder, and
  attachments. Not verified live: the Escape road at idle after this change (unit tests only) and an `Enter` meeting a real prompt
  (no safe way to raise one on demand).
- Not built: `Up` on the queued placeholder (Claude edits the queued messages; never pressed), anything that cancels a queued
  message, and any change to the idle-only controls above.
