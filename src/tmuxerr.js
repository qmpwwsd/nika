// Maps a failed tmux call to a contract error body (api-app.md §2). Shared by the pane mirror and the keystroke sender.
import { clean } from './text.js';

/** tmux binary missing or no server → 503 tmux_unavailable; unknown pane → 404 not_found; anything else → 502 tmux_failed. */
export function tmuxFailure(err) {
  const first = String(err?.stderr || err?.message || '').trim().split('\n')[0];
  if (err?.code === 'ENOENT') return { status: 503, body: { error: 'tmux_unavailable', message: 'tmux not found' } };
  if (/can't find (pane|window|session)/i.test(first)) return { status: 404, body: { error: 'not_found', message: 'pane not found' } };
  if (/no server running|error connecting|server exited|failed to connect|lost server/i.test(first)) {
    return { status: 503, body: { error: 'tmux_unavailable', message: clean(first, 200) ?? 'tmux unavailable' } };
  }
  return { status: 502, body: { error: 'tmux_failed', message: clean(first, 200) ?? 'tmux failed' } };
}
