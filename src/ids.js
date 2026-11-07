// Identifier shapes checked at every trust boundary (collectors, API, CLI, store). Reject before use, never clean up.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PANE_ID = /^%\d{1,6}$/;
/** First 16 hex chars of sha256(realpath of the project dir). */
export const PROJECT_KEY = /^[a-z0-9]{16}$/;
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Full model id, or a Claude Code alias. */
export const MODEL_ID = /^(?:claude-[a-z0-9-]{3,60}|opus|sonnet|haiku|fable)$/;
/** tmux session name; never starts with `-` so it cannot be read as an option. */
export const TMUX_SESSION = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;
/** `<plugin>@<marketplace>` as Claude Code lists installed plugins. */
export const PLUGIN_NAME = /^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9._-]{1,100}$/;
/** Remote Control session-name prefix. */
export const RC_PREFIX = /^[a-z0-9][a-z0-9-]{0,19}$/;
/** Named keys `POST /api/app/pane/:id/keys` may send; everything else is refused. */
export const KEY_NAME = new Set([
  'Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage', 'BSpace', 'DC',
  'C-c', 'C-u', 'C-k', 'C-a', 'C-e', 'C-l', 'C-r', 'C-w',
]);
/** `bypassPermissions` is never accepted (T4). */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'];
export const PANE_PLACEMENTS = ['beside', 'under-last'];
