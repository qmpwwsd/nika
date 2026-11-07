# nika project rules

Scope: binding for every session and agent working in this repository. They extend `~/.claude/ORCHESTRATION.md`; on a conflict this file wins.

## What nika is

A local, read-mostly dashboard of Claude Code agents on this machine, grouped by git repository. Installed with Homebrew (`brew install qmpwwsd/tap/nika`), run as a launchd service (`brew services start nika`), served on `127.0.0.1:3335`.

## Stack and commands

- Node >= 22, ES modules, **zero runtime and dev dependencies** (stdlib only). A new dependency needs the owner's approval.
- Tests: `node --test "test/*.test.js"` (`npm test`). Every collector and route has a `(+)` case and a `(−)` case.
- Run locally: `node bin/nika serve`, `node bin/nika status`.
- Formula lives in the separate repo `qmpwwsd/homebrew-tap` (`Formula/nika.rb`).

## Security constraints (never relax)

1. The server binds `127.0.0.1` only and rejects any `Host` header other than `127.0.0.1:<port>` or `localhost:<port>`.
2. State-changing routes (`POST /api/focus`) require `Content-Type: application/json`, the per-process `X-Nika-Token`, and a matching `Origin` when present. No CORS headers.
3. Subprocesses run with `execFile` and fixed argument arrays, never through a shell. A tmux pane id must match `^%\d+$` and exist in the current `list-panes` output.
4. nika never reads `*.key` files, `daemon/control.key`, `.env*` or any credential path. It reads only: `sessions/<pid>.json`, `projects/**/<uuid>.jsonl` (head and tail chunks), `subagents/*.meta.json`, spawn report files (`<name>.session|.md|.rc`) and `.git` / `commondir` files.
5. A file path never comes from a request. Report files are looked up by session id in the index nika built itself.
6. Every transcript-derived string is rendered with `textContent`; the page ships a strict CSP (no inline script or style).
7. Test fixtures are synthetic. Never copy a real transcript, session file, account id or prompt into the repository.
8. No hardcoded user paths: use `os.homedir()`, `CLAUDE_CONFIG_DIR`, `process.getuid()`.
9. Every file under `~/.claude` or a scratchpad is agent-writable: read it through `src/fsafe.js` (O_NOFOLLOW, O_NONBLOCK, regular file owned by the user, bounded size), validate ids at the collector boundary (`src/ids.js`), and pass display text through `clean()` (`src/text.js`).
10. Single-user Mac assumption: any local process can read the dashboard. The README says so; do not add data that would make this worse (no secrets, no full transcripts).

## Git

- Default branch `main`. Commits only with the owner's explicit approval per commit (ORCHESTRATION §19). No AI attribution lines.
- Publishing (repo creation, push, tags, tap updates) needs the owner's approval for that action.
