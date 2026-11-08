# ADR 0007 — Spawning agents: tmux multi-argument commands + `nika _run-agent`

Date 2026-11-08 · Status accepted

## Context
The owner's current `spawn.sh` builds a shell string for `tmux split-window`. Names, models and briefs now come from
the UI and from other agents, so the command line is attacker-influenced.

## Decision
`nika spawn` calls tmux with `execFile` and a **multi-argument** shell-command (`-- <nikaBin> _run-agent <key> <name>`),
which tmux execs directly without `sh -c`. The hidden `_run-agent` wrapper runs inside the pane: it writes
`<name>.session` and `<name>.rc` into nika's state dir, builds the `claude` argv from the stored brief and settings,
and refuses `bypassPermissions`. Spawned agents get `--disallowedTools` for nested `nika`, `tmux`, `claude`, and
`git add|commit|push`, plus a deny list for `.env*` and `*.key`. Session targets are exact (`=<name>`), pane targets `%n`.

## Alternatives
- Port `spawn.sh` as a shell string: injection surface (T6). Rejected.
- Headless `claude -p` without tmux: no pane to mirror, and the owner's flow is tmux-based. Deferred (not in 0.2).

## Consequences
Argv shapes are frozen in `docs/contracts/api-app.md` §8 and snapshot-tested with an injected exec. nika never kills
or owns agent processes; the orchestrator pane is a normal `claude` in a `tmux` window nika merely created.

The deny lists are advisory, not a boundary (2026-11-08 review): Claude Code matches permission rules against the literal
command text, so a full path, `sh -c` or a script passes; the boundary is the single-user trust model plus the app
secret. A Claude Code sandbox is planned as an optional Settings switch. The agent limit and the duplicate-name check count
the panes tmux reports with `@nika-role` `agent` and `@nika-agent <project key>/<name>` (any session, parsed strictly), not the agent-writable `<name>.pane` files.
