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
