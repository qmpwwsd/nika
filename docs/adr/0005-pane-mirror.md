# ADR 0005 — Session window: transcript history + tmux pane mirror

Date 2026-11-08 · Status accepted

## Context
The owner wants to watch and drive a Claude Code session from nika without switching terminals. Claude Code renders a
TUI; nika must not become a terminal emulator or a PTY owner.

## Decision
Two panels. History: the transcript paginated from disk (`/api/app/session/:id/history`, `cleanBlock()` text).
Live view: `tmux capture-pane -p -e` polled at ~4 Hz with an ETag, parsed server-side into rows of spans keeping only a
whitelist of SGR codes; the client renders spans with `textContent`. Input: `tmux send-keys -l --` for text and an
allow-list of named keys, only to live Claude panes or nika-started panes, rate-limited.

## Alternatives
- xterm.js over a PTY: a dependency, and nika would own the process. Rejected.
- Screenshots of the pane: not accessible, not selectable. Rejected.
- `tmux pipe-pane` streaming: raw escapes reach nika; parsing a full terminal stream is a terminal emulator. Rejected.

## Consequences
No OSC/DCS/C0/C1 ever reaches the page (T9). Mirror pauses while the user scrolls history. Not a general terminal:
mouse, alternate screens and bracketed paste are out of scope.
