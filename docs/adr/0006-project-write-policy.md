# ADR 0006 — Project write policy

Date 2026-11-08 · Status accepted

## Context
"Apply rules" is the first time nika writes into a user's repository. Repositories are agent-writable, may contain
symlinks and are often shared through git.

## Decision
nika writes exactly three project files, each through `src/fwrite.js`: `rules/orchestration.md` (template),
`CLAUDE.md` (adds the `@rules/orchestration.md` line), `.claude/settings.local.json` (only `enabledPlugins`; every other
key copied verbatim and deep-equal asserted). Optional, unchecked by default: a `.gitignore` line for
`.claude/settings.local.json`. Before writing: preview with per-file diffs, explicit confirmation, hash check (409 on
drift), backup of each existing target into `${XDG_STATE_HOME}/nika/backups/<key>/<ISO>/` (never inside the repo).
Project root is the realpath taken at add time and re-checked; `rules` and `.claude` must be absent or real
directories; targets must be absent or regular, user-owned, single-link files; a `rules/orchestration.md` nika did not
write needs the explicit overwrite flag. nika never runs git.

## Alternatives
- Writing to global `~/.claude/CLAUDE.md`: changes every project at once; owner wants per-project opt-in. Rejected.
- Committing the change for the user: violates ORCHESTRATION §19. Rejected.
- Backups next to the file (`*.bak`): leak into commits (T15). Rejected.

## Consequences
Every target repo gets a tracked `rules/orchestration.md`; its content is a scrubbed generic template, never a copy of
a private rules file (T14). Projects are referenced by key, never by a path in a request.
