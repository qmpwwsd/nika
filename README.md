# nika

A local dashboard of every Claude Code agent on your Mac: live sessions (working, waiting for input, running a shell) and recently ended ones, grouped by git repository, with their subagents nested inside.

- Groups by repository; git worktrees fold under their main repository and carry a worktree tag.
- Shows model, branch, tmux pane, last prompt, start and last-activity time, and the `STATUS:` line of orchestrator spawn reports.
- Actions per agent: **Focus pane** (switches tmux to it), **Open in claude.ai** (Remote Control sessions), **Copy resume** (`cd … && claude --resume <id>`), **Report** (spawn report file).
- Read-only apart from Focus pane. Zero dependencies (Node stdlib). Binds `127.0.0.1` only.

## Install

```sh
brew install qmpwwsd/tap/nika
brew services start nika     # runs at login on http://127.0.0.1:3335
nika                         # opens the dashboard in your browser
```

## Commands

| Command | Does |
|---|---|
| `nika` / `nika open` | open the dashboard (the server must be running) |
| `nika serve` | run the server in the foreground (what `brew services` runs) |
| `nika status` | print agents grouped by project; `--json`, `--since 24h\|7d\|30d\|all`, `--full` |
| `nika --version` | print the version |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NIKA_PORT` | `3335` | port on 127.0.0.1 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config dir |
| `NIKA_TMP_ROOT` | `/private/tmp/claude-<uid>` | Claude scratchpad root searched for spawn reports |
| `NIKA_REPORT_DIRS` | – | extra report dirs, colon-separated |
| `NIKA_TMUX` | first `tmux` on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` | tmux binary |

With `brew services`, set variables in the service environment (for example with `launchctl setenv`) or run `nika serve` yourself.

## What nika reads

| Source | Used for |
|---|---|
| `~/.claude/sessions/<pid>.json` | live sessions: cwd, status, tmux pane, Remote Control id |
| `ps -A -o pid=,lstart=` | is the process still alive (and not a reused pid) |
| `~/.claude/projects/*/<session>.jsonl` | first 64 KB and last 256 KB only: cwd, branch, model, title, last prompt |
| `…/<session>/subagents/agent-*.meta.json` | subagent type, description, model, finished |
| `tmux list-panes -a` | pane titles (`[%id] name` convention) |
| `<scratchpad>/reports/<name>.session\|.md\|.rc` | agent role name, `STATUS:` line, report text |
| `<cwd>/.git`, `commondir` | repository root for grouping |

It never reads `*.key` files, credentials or `.env` files, and it never writes anything.

A transcript with no user or assistant message (Claude Code sometimes leaves a one-line title stub) is not an agent: nika lists it only while its session is live.

## Security

**Assumption: a single-user Mac.** Browsers on other sites cannot read or drive nika, but any local process or any other user account on the same machine can open `http://127.0.0.1:3335` and read what it shows: last prompts, directories, branches, session ids, Remote Control links and report text. Do not run nika on a shared machine.

- Listens on `127.0.0.1` only and rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
- `POST /api/focus` needs JSON, a per-process token embedded in the page, and a same-origin `Origin`; the pane id must look like `%<n>` and exist in tmux; tmux runs via `execFile`, never a shell.
- Report files are looked up by session id in nika's own index; no request carries a file path.
- Files in agent-writable dirs are opened without following symlinks, never block on FIFOs, must be regular files owned by you, and are read with a size cap.
- Text from transcripts, reports and tmux is stripped of control and bidi characters before it reaches the page or your terminal.
- Strict Content-Security-Policy; all session text is rendered as text, never HTML.

## 0.2 (in progress)

0.2 adds a desktop app (macOS and Linux, tray icon) with a privileged tier: session window with history and a live pane
mirror, spawning agents in tmux, starting the orchestrator, adding projects and applying orchestration rules. The
browser dashboard above stays read-only. Contracts: [docs/contracts/api-app.md](docs/contracts/api-app.md); decisions:
[docs/adr/](docs/adr/); progress: [CHANGELOG.md](CHANGELOG.md).

## Development

```sh
npm test                  # node --test, no dependencies
node bin/nika serve       # http://127.0.0.1:3335
node bin/nika status
```

## Uninstall

```sh
brew services stop nika
brew uninstall nika
```

## License

MIT
