// tmux panes on the default server. A pane name is taken only from the spawn convention title "[%<id>] <name>".
import { PANE_ID, parseAgentTag } from '../ids.js';
import { isKind } from '../labels.js';

// The pane options nika sets on a pane it started or adopted, after the title and command, empty when unset: `@nika-role`
// (orchestrator | sub-orchestrator | agent), `@nika-agent` (<project key>/<name>), `@nika-depth` (1 to 3), `@nika-parent` (a pane id)
// and `@nika-kind` (one of KINDS, only on an agent).
// Each is read strictly: a value that does not parse is absent, never cleaned up.
// `#{pane_dead}` follows (0.5): `1` for a pane whose process ended and that tmux keeps (`remain-on-exit`) with its tags and a command that still
// reads as claude (tmux falls back to the pane's argv). The app tier's eligibility check refuses such a pane.
// `@nika-kind` is last (0.5, W9): one of the seven words of KINDS beside role `agent`, else absent. It is free text, so it comes last and a tab in a
// forged value cannot shift another field.
const FORMAT = '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{pane_dead}\t#{@nika-kind}';
const ROLES = new Set(['orchestrator', 'sub-orchestrator', 'agent']);
const SPAWN_TITLE = /^\[%\d+\]\s+(.+)$/;

/**
 * `#{pane_dead}` as tmux prints it: exactly `0` (running) → false, exactly `1` (dead) → true, anything else → null. The one parse rule of
 * this listing and of Start's orchestrator listing (src/orchestrate.js): a value that is not 0 or 1 is never read as "running".
 */
export const paneDead = (value) => (value === '0' ? false : value === '1' ? true : null);

/**
 * One pane per line. A row whose `pane_dead` is present but not exactly 0 or 1 is dropped (fail closed: it would otherwise read as running).
 * A line that stops before that field (an older shape: only fixtures) parses as running, like the tag fields that are absent.
 */
export function parsePaneLines(stdout) {
  const panes = new Map();
  for (const line of stdout.split('\n')) {
    const [id, session, windowIndex, title = '', command = '', role = '', agent = '', depth = '', parent = '', deadField, ...kindParts] = line.split('\t');
    if (!/^%\d+$/.test(id ?? '')) continue;
    const dead = deadField === undefined ? false : paneDead(deadField);
    if (dead === null) continue;
    const m = SPAWN_TITLE.exec(title.trim());
    const nika = ROLES.has(role); // the other tags mean something only beside a role
    panes.set(id, {
      id, session: session ?? null, windowIndex: windowIndex ?? null, title, command, dead, name: m ? m[1].trim() : null, role: nika ? role : null,
      agent: nika && parseAgentTag(agent) ? agent : null, depth: nika && /^[123]$/.test(depth) ? Number(depth) : null, parent: nika && PANE_ID.test(parent) ? parent : null,
      kind: nika && role === 'agent' && isKind(kindParts.join('\t')) ? kindParts.join('\t') : null, // an exact word, only beside role agent; a value with a tab is not one
    });
  }
  return panes;
}

/** `-u` makes tmux send UTF-8 even without a UTF-8 locale (launchd has none), so non-ASCII titles survive (F10). */
export async function listPanes(exec, bin = 'tmux') {
  try {
    const { stdout } = await exec(bin, ['-u', 'list-panes', '-a', '-F', FORMAT]);
    return { panes: parsePaneLines(stdout), error: null };
  } catch (err) {
    const why = err.code === 'ENOENT'
      ? `${bin} not found (add it to PATH or set NIKA_TMUX)`
      : (err.stderr || err.message || '').trim().split('\n')[0];
    return { panes: new Map(), error: `tmux unavailable: ${why}` };
  }
}
