# ADR 0006 — Project write policy

Date 2026-11-08 · Status accepted

## Context
"Apply rules" is the first time nika writes into a user's repository. Repositories are agent-writable, may contain
symlinks and are often shared through git.

## Decision
nika writes exactly these project files, each through `src/fwrite.js`: `rules/orchestration.md` (template),
`CLAUDE.md` (adds the `@rules/orchestration.md` line) and, when it is a regular file, `AGENTS.md` (the same line; see the
2026-11-14 amendment), `.claude/settings.local.json` (only `enabledPlugins`; every other
key copied verbatim and deep-equal asserted). Optional, unchecked by default: a `.gitignore` line for
`.claude/settings.local.json`. Before writing: preview with per-file diffs, explicit confirmation, hash check (409 on
drift), byte-for-byte backup of each existing target into `${XDG_STATE_HOME}/nika/backups/<key>/<ISO>/` (never inside the repo; the last 10 folders per project are kept).
Project root is the realpath taken at add time and re-checked; `rules` and `.claude` must be absent or real
directories; targets must be absent or regular, user-owned, single-link files; a `rules/orchestration.md` nika did not
write needs the explicit overwrite flag. nika never runs git.

Amendment 2026-11-14 (0.4.0, replaces the 2026-11-13 amendment, owner decision after testing the build): a regular `AGENTS.md`
is a write target next to `CLAUDE.md`, because other coding tools read `AGENTS.md` and Claude reads `CLAUDE.md`. It gets the
same `@rules/orchestration.md` line, through the same safe read, preview, hash check, byte-for-byte backup, modes and
`verifyInside`, and is written before `CLAUDE.md`. Claude must load the rules once: a `CLAUDE.md` with an `@AGENTS.md` import
line beside a regular `AGENTS.md` is left as it is (it gets the rules through the import), a project with only `AGENTS.md`
gets a new `CLAUDE.md` that is just `@AGENTS.md`, and nika never adds the rules line to a `CLAUDE.md` that imports
`AGENTS.md`. A symlink, folder or FIFO named `AGENTS.md` is never followed or opened: skipped (with a note) beside a
`CLAUDE.md`, refused alone (`docs/templates.md`, T50). The earlier amendment (AGENTS.md never written or read) is withdrawn.

## Alternatives
- Writing to global `~/.claude/CLAUDE.md`: changes every project at once; owner wants per-project opt-in. Rejected.
- Committing the change for the user: violates ORCHESTRATION §19. Rejected.
- Backups next to the file (`*.bak`): leak into commits (T15). Rejected.

## Consequences
Every target repo gets a tracked `rules/orchestration.md`; its content is a scrubbed generic template, never a copy of
a private rules file (T14). Projects are referenced by key, never by a path in a request.
