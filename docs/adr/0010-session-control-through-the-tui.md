# ADR 0010 — Session control through the TUI: keys and footer parsing

Date 2026-11-08 · Status accepted

## Context
0.3 lets the owner see and switch Claude's permission mode, answer permission prompts, stop a turn, end a session and
find slash commands from the app. Claude Code runs as its interactive TUI in tmux panes (ADR 0005, 0007), and that TUI
is where the owner works. Claude Code documents no control channel into a running interactive session: the mode,
prompts and commands exist only as screen text and keys.

## Decision
Drive the TUI through the 0.2 pane path. Read: the mirror's `capture-pane` rows go through pure parsers
(`src/mode.js`) that turn the last non-blank row into a mode and the bottom rows into a permission prompt. Act through
`src/keys.js`: allow-listed named keys (`Escape` = interrupt, which the Stop route sends once, or twice while Claude's input is in vim insert mode; `BTab` = next mode; `Enter`, `C-u`) and, to answer a prompt, one digit sent as literal text (`send-keys -l --`), not as a named
key. `src/session-control.js` sequences them: the mode switch runs only while idle, at most 6 presses, footer re-read
after each. End takes a fresh capture, cancels a busy turn or an open prompt with `Escape`, and types `/exit` only when
no prompt or dialog is left on screen, so it can never answer one; it never kills. End and the quick-action commands
(`/compact`, `/clear`, `/model <id>`) share one typing path: the input box must be empty (vim normal mode is turned to
insert with `i` first), nika types the command, and presses `Enter` only when the box reads exactly `❯ <command>`, else it
removes its own text with `C-u` and refuses. A user's draft is never sent and never cleared. A prompt answer needs a fresh capture
whose prompt signature (`sig`, a hash of the last 15 non-blank rows) matches the one the page showed. Commands: a curated built-in list plus the frontmatter of command and skill files
(first 4 KB). The phrases, layouts and the Claude Code version they were checked against live in
`docs/contracts/claude-tui.md`. Every parser fails closed: unrecognized text is `unknown` or `null`, the control hides
or the switch stops with 409. Manual only on its positive footer marker; any unrecognized footer with `bypass` reads as
bypass.

## Alternatives
- Headless `claude -p --input-format stream-json`: loses the TUI the owner works in and the pane mirror built on it,
  and the CLI's stream-json input documents no control messages for mode switches or prompt answers. Rejected (spec
  non-goal).
- Claude Agent SDK: it has such controls, but it is an npm dependency (rule: zero dependencies), it runs without the
  TUI the owner works in, and nika would own the agent processes (rule 12: nika never kills or owns them). Rejected.

## Consequences
The parsers depend on Claude Code's TUI text. `claude-tui.md` records the checked version (2.1.319); each release
re-checks it, and a changed phrase hides the control ("Not supported with this Claude Code version") instead of
guessing. The bypass phrase is not verified yet, so the substring rule stands until 0.4. Switching passes through
other modes (possibly Auto or Bypass), which is why it is idle-only and re-checks before every press (T23). End relies
on Claude obeying `/exit`; if it does not, nika reports `ended: false` and leaves the pane alone. Prompt labels can hold
folder paths: shown in the app, never logged. Pane actions keep the 0.2 eligibility check, and prompt answers add the
fresh parse and signature check (T26); command files are
agent-writable and read as frontmatter only (T22).
