# ADR 0008 — nika's own files: XDG config and state dirs

Date 2026-11-08 · Status accepted

## Context
0.1 wrote nothing. 0.2 stores settings, a project registry, spawn reports and backups. 0.1 found spawn reports under
Claude's scratchpad (`/private/tmp/claude-<uid>`), which is world-readable territory and macOS-specific.

## Decision
Config: `${NIKA_CONFIG_DIR || XDG_CONFIG_HOME || ~/.config}/nika/` (`config.json`, `templates/`). State:
`${XDG_STATE_HOME || ~/.local/state}/nika/` (`projects/<key>/reports/`, `backups/<key>/<ISO>/`). Dirs 0700, files 0600,
written only via `src/fwrite.js` (atomic temp + rename, symlink/hardlink/FIFO refusals). `config.json` is validated on
load against a fixed schema; unknown keys are dropped and bad values replaced by defaults with a warning, never an
exception. Paths come from `src/paths.js`, pure functions of `env` (`os.homedir()` only, no hardcoded user paths).

## Alternatives
- `~/.nika`: not XDG, clutters `$HOME`. Rejected.
- Inside `~/.claude`: agent-writable, mixed with Claude's files. Rejected.
- Inside each project: leaks into commits. Rejected (T15).

## Consequences
Linux and macOS share one layout. Tests point `NIKA_CONFIG_DIR` / `XDG_STATE_HOME` at temp dirs. 0.1's scratchpad
report discovery stays as a read-only source for agents spawned by other tools.
