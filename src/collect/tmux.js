// tmux panes on the default server. A pane name is taken only from the spawn convention title "[%<id>] <name>".
const FORMAT = '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}';
const SPAWN_TITLE = /^\[%\d+\]\s+(.+)$/;

export function parsePaneLines(stdout) {
  const panes = new Map();
  for (const line of stdout.split('\n')) {
    const [id, session, windowIndex, title = '', command = ''] = line.split('\t');
    if (!/^%\d+$/.test(id ?? '')) continue;
    const m = SPAWN_TITLE.exec(title.trim());
    panes.set(id, { id, session: session ?? null, windowIndex: windowIndex ?? null, title, command, name: m ? m[1].trim() : null });
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
