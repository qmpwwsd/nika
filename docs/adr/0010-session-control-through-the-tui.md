# ADR 0010 — Session control through the TUI: keys and footer parsing

Date 2026-11-08 · Status accepted

## Context
0.3 lets the owner see and switch Claude's permission mode, answer permission prompts, stop a turn, end a session and
find slash commands from the app. Claude Code runs as its interactive TUI in tmux panes (ADR 0005, 0007), and that TUI
is where the owner works. Claude Code documents no control channel into a running interactive session: the mode,
prompts and commands exist only as screen text and keys.

## Decision
Drive the TUI through the 0.2 pane path. Read: the mirror's `capture-pane` rows go through pure parsers
(`src/mode.js`) that turn the footer into a mode and the bottom rows into a permission prompt. Act: allow-listed keys
through `src/keys.js` (`Escape` = Stop; `C-u`, `/exit`, `Enter` = End session; `BTab` = next mode; a digit answers a
prompt), sequenced by `src/session-control.js`: the mode switch runs only while idle, at most 6 presses, footer re-read
after each; End never kills. Commands: a curated built-in list plus the frontmatter of command and skill files
(first 4 KB). The phrases, layouts and the Claude Code version they were checked against live in
`docs/contracts/claude-tui.md`. Every parser fails closed: unrecognized text is `unknown` or `null`, the control hides
or the switch stops with 409. Manual only on its positive footer marker; any unrecognized footer with `bypass` reads as
bypass.

## Alternatives
- Headless `claude -p --input-format stream-json`: loses the TUI the owner works in and the pane mirror built on it,
  and Claude Code documents no stdin control messages for mode switches or prompt answers. Rejected (spec non-goal).
- Claude Agent SDK: an npm dependency (rule: zero dependencies), and nika would own the agent processes (rule 12:
  nika never kills or owns them). Rejected.

## Consequences
The parsers depend on Claude Code's TUI text. `claude-tui.md` records the checked version (2.1.319); each release
re-checks it, and a changed phrase hides the control ("Not supported with this Claude Code version") instead of
guessing. The bypass phrase is not verified yet, so the substring rule stands until 0.4. Switching passes through
other modes (possibly Auto or Bypass), which is why it is idle-only and re-checks before every press (T23). End relies
on Claude obeying `/exit`; if it does not, nika reports `ended: false` and leaves the pane alone. Prompt labels can hold
folder paths: shown in the app, never logged. Pane actions keep the 0.2 eligibility check (T26); command files are
agent-writable and read as frontmatter only (T22).
