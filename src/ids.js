// Identifier shapes checked at every trust boundary (collectors, API, CLI, store). Reject before use, never clean up.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PANE_ID = /^%\d{1,6}$/;
/** First 16 hex chars of sha256(realpath of the project dir). */
export const PROJECT_KEY = /^[a-z0-9]{16}$/;
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** nika's pane tag `@nika-agent` = `<project key>/<name>` → [key, name], or null for anything else: the tag is agent-writable and never trusted unparsed. */
export function parseAgentTag(tag) {
  const parts = String(tag).split('/');
  return parts.length === 2 && PROJECT_KEY.test(parts[0]) && AGENT_NAME.test(parts[1]) ? parts : null;
}
/** Full model id, a Claude Code alias, or either with the 1M-context suffix. The brackets are safe: the id is only ever one argv element, never a shell word. */
export const MODEL_ID = /^(?:claude-[a-z0-9-]{3,60}|opus|sonnet|haiku|fable|best|opusplan)(?:\[1m\])?$/;
/** tmux session name; never starts with `-` so it cannot be read as an option. */
export const TMUX_SESSION = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;
/** `<plugin>@<marketplace>` as Claude Code lists installed plugins. */
export const PLUGIN_NAME = /^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9._-]{1,100}$/;
/** Bare name of a listed slash command or skill: no leading `/`, before any `<plugin>:` prefix. Names that miss it are skipped, not cleaned. */
export const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** Remote Control session-name prefix. */
export const RC_PREFIX = /^[a-z0-9][a-z0-9-]{0,19}$/;
/** Full Remote Control session name: `<prefix>-<agent name>` or the orchestrator's session name, lower-cased. */
export const RC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Named keys `POST /api/app/pane/:id/keys` may send; everything else is refused. */
export const KEY_NAME = new Set([
  'Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage', 'BSpace', 'DC',
  'C-c', 'C-u', 'C-k', 'C-a', 'C-e', 'C-l', 'C-r', 'C-w',
]);
/** `#{pane_current_command}` of a pane running Claude Code: `claude`, `node`, or (native builds) its version, e.g. 2.1.319. */
export const CLAUDE_COMMAND = /^(?:claude|node|\d+\.\d+\.\d+[\w.+-]*)$/;
/** `default` = no `--permission-mode` flag; `bypassPermissions` is never accepted (T4). */
export const PERMISSION_MODES = ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'];
export const PANE_PLACEMENTS = ['beside', 'under-last'];
