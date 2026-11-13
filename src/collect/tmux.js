// tmux panes on the default server. A pane name is taken only from the spawn convention title "[%<id>] <name>".
import { PANE_ID, parseAgentTag } from '../ids.js';

// The pane options nika sets on a pane it started or adopted, after the title and command, empty when unset: `@nika-role`
// (orchestrator | sub-orchestrator | agent), `@nika-agent` (<project key>/<name>), `@nika-depth` (1 to 3), `@nika-parent` (a pane id).
// Each is read strictly: a value that does not parse is absent, never cleaned up.
const FORMAT = '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}';
const ROLES = new Set(['orchestrator', 'sub-orchestrator', 'agent']);
const SPAWN_TITLE = /^\[%\d+\]\s+(.+)$/;

export function parsePaneLines(stdout) {
  const panes = new Map();
  for (const line of stdout.split('\n')) {
    const [id, session, windowIndex, title = '', command = '', role = '', agent = '', depth = '', parent = ''] = line.split('\t');
    if (!/^%\d+$/.test(id ?? '')) continue;
    const m = SPAWN_TITLE.exec(title.trim());
    const nika = ROLES.has(role); // the other tags mean something only beside a role
    panes.set(id, {
      id, session: session ?? null, windowIndex: windowIndex ?? null, title, command, name: m ? m[1].trim() : null, role: nika ? role : null,
      agent: nika && parseAgentTag(agent) ? agent : null, depth: nika && /^[123]$/.test(depth) ? Number(depth) : null, parent: nika && PANE_ID.test(parent) ? parent : null,
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
