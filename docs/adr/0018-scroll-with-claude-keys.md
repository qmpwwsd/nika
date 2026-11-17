# ADR 0018 — Scroll Claude's own view with its keys

Date 2026-11-14 · Status accepted (nika 0.5, W3)

## Context
The session window mirrors the pane. Claude Code draws its whole interface (transcript, input box, footer) in tmux's alternate screen,
so the pane shows only what fits, and Claude's own view scrolls inside that screen. The owner wants to read older output from the
window with the wheel, the trackpad and the page keys, the way the terminal does it.

Spike S5 (`docs/contracts/claude-tui.md` §12, Claude Code 2.1.325) gives the facts:

- `#{alternate_on}` is `1` and `#{history_size}` is `0` in every state sampled, and `capture-pane -S` returns the visible rows only. tmux
  holds no history of Claude's output.
- `PPage` and `NPage` move Claude's view by about half a screen. `C-Home` goes to the top and `C-End` back to the bottom. None of the
  four touches the draft or the cursor.
- `Up`, `Down`, `C-u`, `C-d`, plain `Home` and plain `End` do not scroll: they recall history, delete the draft, arm exit or move the
  cursor in the box.
- Claude draws a pill over the last transcript row while its view is not at the bottom (`Jump to bottom: fn+↓ to scroll`).
- SGR mouse wheel reports work only while Claude's mouse mode is on; with it off the bytes become input, and the leading `ESC` can
  interrupt a turn.

The questions: which keys, through which route, and under which guard.

## Decision
- **A dedicated route.** `POST /api/app/pane/:id/scroll` takes `{ dir: "up"|"down", pages: 1..8 }` or `{ to: "top"|"bottom" }`. The
  server maps them through a fixed table in `src/scroll.js` to `PPage`, `NPage`, `C-Home` and `C-End`: the only keys the route ever
  sends, at most 8 in one `keys.send` call. The request names a direction and a count, never a key. App tier only.
- **A guard under the pane lock.** The route sends only when one fresh capture shows the alternate screen, no permission prompt and
  a plain input box whose draft does not start with `/` (the slash menu), and when no Stop or End interrupt runs or sent its `Escape`
  less than 40 ms ago. Anything else is a 409 and nothing is sent. Claude may be busy: a scroll key never interrupts a turn, and
  reading older output while Claude works is the main use.
- **`NPage` is always sent**, even at the bottom (a no-op there), so a pill nika fails to recognise never leaves the user stranded.
- **The capture gains `alt` and `scrolled`.** `alt` comes from `#{alternate_on}` in the same `display-message` as the size and cursor
  (no extra tmux call). `scrolled` is Claude's pill, read from the capture nika already took. It is display only: it changes the
  "Scrolled up in Claude's view" note and whether Jump to live also presses `C-End`, never whether a key goes out.
- **The page** (`public/scroll.js`) turns wheel travel into whole Claude pages, native scroll first (the mirror's own overflow moves
  before Claude's view), one request in flight, at least 100 ms apart, at most 8 pages. PageUp, PageDown, Home and End scroll Claude's
  view when Type into pane is off; with it on they stay the user's own keys on the keys route.
- **No scrollback route.** The planned `capture-pane -S` road is not built: it would return only the visible rows. With `alt` off nika
  sends no scroll keys (409 `no-view`) and the transcript column stays the way to read history.

## Alternatives
- **tmux scrollback (`capture-pane -S`).** Empty for Claude (`history_size=0`).
- **tmux copy-mode (`send-keys -X`).** It would scroll tmux's empty history, not Claude's view.
- **SGR mouse wheel reports.** They scroll, but with Claude's mouse mode off the bytes become input and the `ESC` can interrupt a turn.
- **The keys route with `C-Home` and `C-End` added.** The keys route is unguarded by design (latency, and Type into pane must stay raw).
  A scroll guard keyed on key names would change it. `C-Home` and `C-End` still join the key allow-list, because `keys.send` validates
  every key against it, but nika's pages post them only to the scroll route.
- **Line-by-line scroll.** Claude's main view binds no single-row key.

## Consequences
- Scrolling moves in page-sized steps (about half the transcript area, 15 to 17 rows in the live runs).
- No scrolling while a permission prompt, a dialog, a menu or an unrecognised footer shows. The page says so in a short fixed line.
- A missed pill only hides the pill. A pill drawn by Claude in other colours, or one that wraps, is not seen.
- The key meanings are those of Claude Code 2.1.325 and its default keybindings. A user's own `keybindings.json` can rebind them; nika
  never reads that file (rule 4).
- Residual risks are in `docs/security.md` T39 and residual n.
- Not built: a scrollback route, mouse reports, tmux copy-mode, line scrolling, an automatic `C-End` before or after Send, a setting,
  anything on the browser tier.

## Amendment 2026-11-17 (0.5, F17): the page glides each jump

**Context.** The owner reported that a wheel or trackpad flick moves the view by a jump of about 16 rows (a Claude page): the next capture replaces the mirror's rows in place, so the text jumps. The owner decided **"Glide the jumps"**
(2026-11-16): each jump slides over about 150 ms, off with "reduce motion", page-only, no security change. On 2026-11-17 the owner also chose (design-F17 Q1), for a jump in which no rows can be matched, a slide of half the conversation's height in the scroll's direction.

**Decision.** Page-only (`public/glide.js`, `public/session.js`, `public/session.css`, one static-file row in `src/server.js`, and `rowText` exported from `public/scroll.js`); the scroll route, its keys and its gate are unchanged.
- After a scroll request the page arms a matcher for 700 ms (renewed by the route's 200). The next changed capture is compared with the frame drawn when the keys went: the rows above Claude's input box that occur exactly once and are not
  blank each vote for the shift `k = new index − old index`. A shift is accepted when it has at least 3 votes, at least 80 % of all votes, no tie, and the request's sign (up and top: the content moved down; down and bottom: up).
  The new frame is drawn at once and the conversation rows slide from `translateY(−k × row height)` to none over 150 ms, `ease-out`, transform only (compositor); the rows below (the input box, the footer, the task list with Type into pane on)
  stay and cover them.
- A frame with no shift, a shift of the wrong sign or a mixed shift **rebases** (it becomes the base frame, the arm stays), so a spinner tick or streaming output at the bottom between the send and the keys does not use the arm up.
- Fewer than 3 matching rows after a request of 2 to 8 pages or a jump (`top`, `bottom`): the half-height slide, `k = ±ceil(conversation rows / 2)`. One page with no match does not slide (a page overlaps its neighbour by about half, so no match
  means the screen is not a scroll result).
- A second jump during a slide starts from the running offset (read from the computed transform, clamped to one region). Requests sent before the first frame is drawn are counted (`pending`): each gets its own slide, rebased on the previous
  frame, so a flick is one motion.
- The matcher is dropped by: every write to a pane except `/scroll`, `/capture` and `/fit` (one choke point, the page's `call()`, with the End dialog's own request covered where it opens; the default for a new route is to disarm), a resize of the pane,
  a gone pane or a 403, and a scroll request that was refused or lost (`drop`). A down arm also ends on a frame that shows Claude's view at its bottom (the frame itself still slides). Down and bottom arm only while Claude's view is scrolled up.
- `#term-rows` gets `overflow: hidden; overflow: clip`, so a translated row never changes the mirror's scroll area, "Paused while you scroll" or the pin to the bottom. `prefers-reduced-motion: reduce` arms nothing, computes nothing and has
  `animation: none` as a second guard. The class and one CSSOM custom property holding a number the page computes (`--glide-from: <n>px`) are the only styling; row texts are compared, never rendered by `glide.js`.

**Alternatives.** Row-by-row scrolling with Claude's mouse-wheel input: turned down in this ADR (with Claude's mouse mode off the bytes become typed text and the leading `ESC` can interrupt a turn); it would need a spike, a security-rule
change and its own ADR. Glide now and study row-by-row for 0.6: the owner chose the glide alone. A fixed slide for every jump without matching: it would also slide frames that are not a scroll. No slide when no rows match: the owner chose the
half-height slide, which shows the direction without claiming a distance.

**Consequences.** No route, key, rule, argv, file or threat changes (`docs/security.md` needs no new entry; rule 6 already allows a CSSOM custom property with a number the page computes). A frame that is not a pure shift is drawn as before.
A multi-page jump shows its direction, not its distance. For the first instant of a one-page slide the half of the conversation area away from the scroll direction shows the terminal background and fills as the rows arrive (the new frame is drawn at
once and slid from where the shared rows were; a shorter slide or a fade is the fallback if it reads badly in the live check). A far slide can fire on a frame that changed for another reason inside the 700 ms window (Claude cleared the screen right after a
jump): a 150 ms slide of an unrelated frame, rare and with no safety effect. `overflow: clip` needs WebKit 16 (Safari 16, WebKitGTK 2.38); `overflow: hidden` before it clips the same way in older web views. A new pane write that reaches `appFetch`
without `call()` would bypass the choke point; a test lists the only module that does so today (`end-dialog.js`) and fails when another appears. Nothing was run in a browser for this amendment: animation events, `overflow: clip` painting and
the z-order of the rows below are asserted on source and fakes only; the live check (design-F17 §9) is the proof.

## Amendment 2026-11-17 (0.5, GT): the glide leaves Claude's pinned task list out of its frame

The live check LC18 (Finding 2, R5a) found that no glide started while Claude's task list was pinned above its input box: the matcher counted the static list rows as votes for "no shift" (14 of 23 rows voted the shift, 0.61 against `GLIDE_SHARE` 0.8), so the arm rebased and the view jumped, and a session with a task list is the owner's usual state. The capture's `draft.box` now carries an optional `tasks`, the row index of the list's header (`parseDraft` in `src/draft.js`, found by `taskBlockAbove` in `src/mode.js`: the block, exactly ONE blank row, then the box's top rule), and the page's `cleanDraft` keeps it only as an integer with `0 <= tasks < top`; `frameOf` in `public/glide.js` ends the frame there when it is also at most the view's rows, so the list neither votes nor slides while the conversation above it does. `taskBlockAbove` shares `blockHead` with `taskEnd`, the reader of the list under a dialog (ADR 0015), so the two cannot drift apart and the grammar of both Claude versions is the same. The field is display only (no key, write or gate reads it), additive (an older page ignores it, a newer page against an older server sees it absent and glides as before) and fails closed: two blank rows, a transient hint row, a list whose numbers do not add up, or a list under the mode line leave it absent, and that frame jumps as before. No security constraint changes: no new input source, file or subprocess. A model's own text that quotes a whole block, one blank row and the box's rule would only stop those rows from sliding. `docs/contracts/api-app.md` (the `box` row) and `docs/design/spec.md` §9.15 carry the details. Checked live (LC19, 2026-11-17): with a three-task list pinned, five of five scroll actions glided and the list did not move.
