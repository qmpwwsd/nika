// Starts a project's orchestrator: a tmux session whose first window `orchestrator` runs claude (contract §3, §8).
// Leaf module: the router and the CLI call startOrchestrator() with injected deps; every subprocess goes through
// ctx.exec (execFile, fixed argv arrays, never a shell). src/spawn.js reuses the helpers exported here.
import crypto from 'node:crypto';
import { loadConfig } from './store.js';
import { clean } from './text.js';
import { PROJECT_KEY, PANE_ID, TMUX_SESSION, RC_PREFIX, RC_NAME, CLAUDE_COMMAND } from './ids.js';

/** `{ status, body }` with the common error body of contract §2. */
export const fail = (status, error, message) => ({ status, body: { error, message } });

/** 503 when tmux or claude cannot be run; null when both are known. */
export function binsMissing(ctx) {
  if (!ctx.tmuxBin) return fail(503, 'tmux_unavailable', 'tmux not found (add it to PATH or set NIKA_TMUX)');
  if (!ctx.claudeBin) return fail(503, 'claude_unavailable', 'claude not found (add it to PATH or set NIKA_CLAUDE)');
  return null;
}

/** `tmux -u <args>`: `-u` keeps UTF-8 titles intact without a UTF-8 locale (launchd has none). */
export const tmux = (ctx, ...args) => ctx.exec(ctx.tmuxBin, ['-u', ...args]);

/**
 * Marks a pane nika created (`@nika-role` = orchestrator | agent) so the orchestrator is never confused with the agents
 * split into its window. Best effort: the pane already runs, an untagged one is just never reused.
 */
export const tagPane = (ctx, pane, role) => tmux(ctx, 'set-option', '-p', '-t', pane, '@nika-role', role).catch(() => {});

/** Maps a failed tmux call to an error response. */
export function tmuxFail(err) {
  if (err?.code === 'ENOENT') return fail(503, 'tmux_unavailable', 'tmux not found (add it to PATH or set NIKA_TMUX)');
  const why = clean(String(err?.stderr || err?.message || 'unknown error').trim().split('\n')[0], 200) ?? 'unknown error';
  return fail(502, 'tmux_failed', `tmux failed: ${why}`);
}

/** The project name reduced to TMUX_SESSION (invalid chars → `-`, no leading `-`, ≤ 48); the key when nothing is left. */
export function sessionNameFor(project) {
  const v = String(project.name).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 48);
  return TMUX_SESSION.test(v) ? v : project.key;
}

/**
 * Any text reduced to RC_PREFIX (lowercase, invalid chars → `-`, starts alphanumeric, ≤ 20), or with `full` to RC_NAME
 * (same, ≤ 64: a whole Remote Control name is never cut to the prefix length). `fallback` when nothing is left.
 */
export function reduceRc(text, fallback, full = false) {
  const v = String(text).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, full ? 64 : 20).replace(/-+$/, '');
  return (full ? RC_NAME : RC_PREFIX).test(v) ? v : fallback;
}

/** `--permission-mode` pair; `default` passes no flag, `bypassPermissions` is refused (rules constraint 12). */
export const permissionFlags = (mode) => (mode === 'default' ? [] : ['--permission-mode', mode]);

/** Pane tagged `orchestrator` in the session's `orchestrator` window that runs claude, or null (agent panes never match). */
async function findOrchestratorPane(ctx, session) {
  let stdout;
  try {
    // `:=orchestrator` is an exact window match; `:orchestrator` would also match a window named `orchestrator-x`
    ({ stdout } = await tmux(ctx, 'list-panes', '-t', `=${session}:=orchestrator`, '-F', '#{pane_id}\t#{pane_current_command}\t#{@nika-role}'));
  } catch (err) {
    if (err?.code === 'ENOENT') throw err;
    return null;
  }
  for (const line of String(stdout).split('\n')) {
    const [id, command = '', role = ''] = line.split('\t');
    if (PANE_ID.test(id ?? '') && role.trim() === 'orchestrator' && CLAUDE_COMMAND.test(command.trim())) return id;
  }
  return null;
}

/**
 * @param {string} projectKey registered PROJECT_KEY
 * @param {object} ctx { env, exec, tmuxBin, claudeBin, started: Map<paneId, { key, name, sessionId, role }> }
 * @returns {Promise<{ status: number, body: object }>} 200 { pane, session, sessionId, created }
 */
export async function startOrchestrator(projectKey, ctx) {
  if (typeof projectKey !== 'string' || !PROJECT_KEY.test(projectKey)) return fail(400, 'invalid', 'invalid project key');
  const missing = binsMissing(ctx);
  if (missing) return missing;
  const { config } = await loadConfig(ctx.env);
  const project = config.projects.find((p) => p.key === projectKey);
  if (!project) return fail(404, 'not_found', 'project is not registered');
  if (config.permissionMode === 'bypassPermissions') return fail(400, 'invalid', 'bypassPermissions is never allowed');

  const session = sessionNameFor(project);
  const sessionId = crypto.randomUUID();
  const rc = config.remoteControl.enabled ? reduceRc(config.remoteControl.prefix || session, projectKey, true) : null;
  const flags = [
    '--session-id', sessionId, '--model', config.models.orchestrator, ...permissionFlags(config.permissionMode),
    '-n', session, ...(rc ? [`--remote-control=${rc}`] : []),
  ];
  const run = ['-P', '-F', '#{pane_id}', '--', ctx.claudeBin, ...flags];

  try {
    let exists = true;
    try {
      await tmux(ctx, 'has-session', '-t', `=${session}`);
    } catch (err) {
      if (err?.code === 'ENOENT') throw err;
      exists = false; // exit 1: no such session, or no server running at all
    }
    if (exists) {
      const pane = await findOrchestratorPane(ctx, session);
      if (pane) return { status: 200, body: { pane, session, sessionId: ctx.started?.get(pane)?.sessionId ?? null, created: false } };
    }
    const { stdout } = await tmux(ctx, ...(exists
      ? ['new-window', '-t', `=${session}:`, '-n', 'orchestrator', '-c', project.dir, ...run]
      : ['new-session', '-d', '-s', session, '-n', 'orchestrator', '-c', project.dir, '-x', '200', '-y', '50', ...run]));
    const pane = String(stdout).trim();
    if (!PANE_ID.test(pane)) return fail(502, 'tmux_failed', 'tmux did not return a pane id');
    ctx.started?.set(pane, { key: projectKey, name: 'orchestrator', sessionId, role: 'orchestrator' });
    await tagPane(ctx, pane, 'orchestrator');
    return { status: 200, body: { pane, session, sessionId, created: true } };
  } catch (err) {
    return tmuxFail(err);
  }
}
