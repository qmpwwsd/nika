// Starts a project's orchestrator: a tmux session whose first window `orchestrator` runs claude (contract §3, §8).
// Leaf module: the router and the CLI call startOrchestrator() with injected deps; every subprocess goes through
// ctx.exec (execFile, fixed argv arrays, never a shell). src/spawn.js reuses the helpers exported here.
import crypto from 'node:crypto';
import { loadConfig, setOrchestrator, effectiveModels } from './store.js';
import { compactLaunch, WINDOW_ENV, PCT_ENV } from './compact.js';
import { clean } from './text.js';
import { PROJECT_KEY, UUID, PANE_ID, TMUX_SESSION, RC_PREFIX, RC_NAME, CLAUDE_COMMAND } from './ids.js';

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
 * Marks a pane nika created: `@nika-role` = orchestrator | sub-orchestrator | agent, so the main orchestrator is never confused
 * with the agents split into its window; `@nika-agent` = `<project key>/<name>` (an orchestrator's name is the constant
 * `orchestrator`), so maxAgents, the caps and the duplicate-name check count tmux's own record instead of agent-writable files (F5);
 * `depth` (1, 2 or 3, a constant) sets `@nika-depth` and `parent` (a pane id) `@nika-parent`, the tree of a nested spawn. Every value
 * is a constant, a validated name or a pane id: none has a `#` (set-option values are not format-expanded either way). Best effort:
 * the pane already runs, an untagged one is just not counted and never reused.
 */
export async function tagPane(ctx, pane, role, agentTag, depth, parent) {
  await tmux(ctx, 'set-option', '-p', '-t', pane, '@nika-role', role).catch(() => {});
  if (agentTag) await tmux(ctx, 'set-option', '-p', '-t', pane, '@nika-agent', agentTag).catch(() => {});
  if ([1, 2, 3].includes(depth)) await tmux(ctx, 'set-option', '-p', '-t', pane, '@nika-depth', String(depth)).catch(() => {});
  if (typeof parent === 'string' && PANE_ID.test(parent)) await tmux(ctx, 'set-option', '-p', '-t', pane, '@nika-parent', parent).catch(() => {});
}

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
/** The mode Claude starts in for that setting: no flag (`default`) starts in manual. Recorded in `started` (capture shows it while the footer is covered). */
export const launchMode = (mode) => (mode === 'default' ? 'manual' : mode);

/**
 * tmux expands formats in `-c start-directory`: `#{…}` is substituted and `#(cmd)` RUNS cmd through the shell
 * (verified on tmux 3.8). A project path is user data, so every `#` is doubled: `##` is tmux's literal `#`.
 */
export const tmuxLiteral = (s) => String(s).replaceAll('#', '##');

/**
 * Whether a session's group (src/model.js `findSession`) is this project's: the registered key, else the project's folder. The
 * same match the page makes (buildGroups) and the PUT route checks, so a saved id of another project's session is refused here too.
 */
export const inProject = (group, project) => Boolean(group) && (group.key === project.key || (group.root != null && group.root === project.dir));

/** A live session's tmux pane when it exists and runs claude (what tagging, opening and keys need), else null. */
export function claudePane(agent) {
  const pane = agent?.live ? agent.pane : null;
  return PANE_ID.test(pane?.id ?? '') && CLAUDE_COMMAND.test(String(pane.command ?? '').trim()) ? pane : null;
}

/**
 * The saved orchestrator `id` of `project` from a lookup hit `{ agent, group }` (null: nika has no transcript for it):
 * `{ sessionId, state: 'live' | 'ended' | 'gone', name, pane }`, the shape of contract C1 and of the PUT answer. The one reading the
 * page and Start share: a session of another project (a hand-edited config.json) reads as gone, so neither shows nor opens it (T47).
 */
export function pickState(project, id, hit) {
  if (!hit || !inProject(hit.group, project)) return { sessionId: id, state: 'gone', name: null, pane: null };
  const { agent } = hit;
  return { sessionId: id, state: agent.live ? 'live' : 'ended', name: agent.name ?? null, pane: agent.live ? agent.pane?.id ?? null : null };
}

/**
 * claude's own arguments for a project's orchestrator (everything after the binary): the one place that builds them. With
 * `resume` the saved session `sessionId` continues (`--resume`); otherwise `sessionId` names the new session (`--session-id`).
 * `--model` is the project's own orchestrator model, else Settings' (`effectiveModels`). Throws EINVAL for an id that is not a
 * UUID (it becomes one argv element and must never read as a flag) and for bypassPermissions (rules constraint 12).
 */
export function launchArgv(config, project, { sessionId, resume = false }) {
  const invalid = (message) => Object.assign(new Error(message), { code: 'EINVAL' });
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw invalid('session id must be a UUID');
  if (config.permissionMode === 'bypassPermissions') throw invalid('bypassPermissions is never allowed');
  const session = sessionNameFor(project);
  const rc = config.remoteControl.enabled ? reduceRc(config.remoteControl.prefix || session, project.key, true) : null;
  return [
    resume ? '--resume' : '--session-id', sessionId, '--model', effectiveModels(config, project.key).orchestrator, ...permissionFlags(config.permissionMode),
    '-n', session, ...(rc ? [`--remote-control=${rc}`] : []),
  ];
}

/**
 * The orchestrator's compaction variables as tmux `-e NAME=value` pairs (ADR 0014): [] when auto-compact is off, else the window and
 * the PCT, always both (`100` above Claude's own cap), so an inherited value never stays in force. W follows the orchestrator model the launch uses (`effectiveModels`, so a
 * project's own model counts). tmux takes `-e` values literally (no format expansion, spike S2 section 3) and compactLaunch has
 * validated them to digits and one dot. Throws EINVAL for a setting outside its ranges.
 */
export function compactArgs(config, project) {
  const launch = compactLaunch(effectiveModels(config, project.key).orchestrator, config.compaction);
  return Object.entries(launch?.env ?? {}).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

/**
 * `new-session -e` puts the variable in the SESSION environment, which every later pane of the project's session inherits (a window you
 * open, an agent spawned after the setting went off, a restarted orchestrator). The orchestrator's own pane already has its copy, so
 * once the session exists the two names are removed from the session environment again (`set-environment -u`, fixed argv, exact
 * target, only the two constant names nika put there). Best effort: the orchestrator runs either way.
 */
async function unsetCompactEnv(ctx, session, run) {
  const sent = run.slice(0, run.indexOf('--')); // the tmux options; claude's own argv follows the --
  for (const name of [WINDOW_ENV, PCT_ENV]) {
    if (!sent.some((a) => a.startsWith(`${name}=`))) continue; // only a name this launch sent with -e
    await tmux(ctx, 'set-environment', '-t', `=${session}`, '-u', name).catch(() => {});
  }
}

// every pane of every tmux session: the pane's own record of who started it (`@nika-role`, `@nika-agent`), then the session and window
// names (free text, so last)
const PANE_LIST = '#{pane_id}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{session_name}\t#{window_name}';

/**
 * Pane of the project's main orchestrator, `{ id, session }`, or null. Only `@nika-role` orchestrator running claude counts (a
 * sub-orchestrator or an agent never does). It is either tagged `<key>/orchestrator` for this project (the 0.4 tag, set on start, resume
 * and adopt) in any session, or it is a 0.3 pane with no `@nika-agent` tag in the project's own `session`, window `orchestrator`. That one,
 * or a tagged pane in the `orchestrator` window of `session`, wins over an adopted one. A tag of another project or another name never matches.
 */
async function findOrchestratorPane(ctx, session, key) {
  let stdout;
  try {
    ({ stdout } = await tmux(ctx, 'list-panes', '-a', '-F', PANE_LIST));
  } catch (err) {
    if (err?.code === 'ENOENT') throw err;
    return null; // no tmux server running: no orchestrator
  }
  let adopted = null;
  for (const line of String(stdout).split('\n')) {
    const [id, command = '', role = '', tag = '', where = '', ...window] = line.split('\t');
    if (!PANE_ID.test(id ?? '') || role.trim() !== 'orchestrator' || !CLAUDE_COMMAND.test(command.trim())) continue;
    const inOrchestratorWindow = where === session && window.join('\t').trim() === 'orchestrator';
    if (tag !== `${key}/orchestrator` && !(tag === '' && inOrchestratorWindow)) continue;
    if (inOrchestratorWindow) return { id, session: where };
    adopted ??= { id, session: where };
  }
  return adopted;
}

/**
 * Starts the project's orchestrator, or answers the one that already runs. The project's saved orchestrator (its pick, a
 * session id) decides which: live → its pane; ended → `claude --resume <id>`; gone (no transcript) → forgotten, a fresh start
 * and `cleared: 'gone'` in the answer. A fresh start saves its own session id as the pick.
 * @param {string} projectKey registered PROJECT_KEY
 * @param {object} ctx { env, exec, tmuxBin, claudeBin, started: Map<paneId, { key, name, sessionId, role, mode }>,
 *                       findSession(id) → { agent, group } | null (src/model.js; needed only while a pick is saved) }
 * @returns {Promise<{ status: number, body: object }>} 200 { pane, session, sessionId, created, cleared? }
 */
export async function startOrchestrator(projectKey, ctx) {
  if (typeof projectKey !== 'string' || !PROJECT_KEY.test(projectKey)) return fail(400, 'invalid', 'invalid project key');
  const missing = binsMissing(ctx);
  if (missing) return missing;
  const { config } = await loadConfig(ctx.env);
  const project = config.projects.find((p) => p.key === projectKey);
  if (!project) return fail(404, 'not_found', 'project is not registered');
  if (config.permissionMode === 'bypassPermissions') return fail(400, 'invalid', 'bypassPermissions is never allowed');

  // the saved orchestrator: a lookup that fails proves nothing (never "gone"), so it ends the request without forgetting anything
  const pick = config.perProject[projectKey]?.orchestratorSessionId ?? null;
  let saved = null;
  if (pick) {
    if (typeof ctx.findSession !== 'function') return fail(500, 'internal', 'session lookup unavailable');
    try {
      saved = await ctx.findSession(pick);
    } catch {
      return fail(503, 'index_unavailable', "nika couldn't check the saved orchestrator, so nothing was started");
    }
  }
  const state = pick ? pickState(project, pick, saved).state : null; // another project's session reads as gone (T47)
  if (state === 'live') {
    const pane = claudePane(saved.agent);
    if (!pane) return fail(409, 'no_pane', 'The saved orchestrator is running outside tmux, so nika cannot open it.');
    return { status: 200, body: { pane: pane.id, session: pane.session, sessionId: pick, created: false } };
  }
  const cleared = state === 'gone' ? { cleared: 'gone' } : {};
  if (cleared.cleared) await setOrchestrator(projectKey, null, ctx.env).catch(() => {}); // best effort: its transcript is gone either way

  const session = sessionNameFor(project);
  const resume = state === 'ended';
  const sessionId = resume ? pick : crypto.randomUUID();
  const run = ['-P', '-F', '#{pane_id}', ...compactArgs(config, project), '--', ctx.claudeBin, ...launchArgv(config, project, { sessionId, resume })];

  try {
    let exists = true;
    try {
      await tmux(ctx, 'has-session', '-t', `=${session}`);
    } catch (err) {
      if (err?.code === 'ENOENT') throw err;
      exists = false; // exit 1: no such session, or no server running at all
    }
    // any session: an orchestrator adopted from the user's own tmux session still runs after "Stop using" cleared the pick (M1)
    const found = await findOrchestratorPane(ctx, session, project.key);
    if (found) return { status: 200, body: { pane: found.id, session: found.session, sessionId: ctx.started?.get(found.id)?.sessionId ?? null, created: false, ...cleared } };
    const { stdout } = await tmux(ctx, ...(exists
      ? ['new-window', '-t', `=${session}:`, '-n', 'orchestrator', '-c', tmuxLiteral(project.dir), ...run]
      : ['new-session', '-d', '-s', session, '-n', 'orchestrator', '-c', tmuxLiteral(project.dir), '-x', '200', '-y', '50', ...run]));
    if (!exists) await unsetCompactEnv(ctx, session, run); // `new-session -e` is session-wide; new-window -e is this pane only
    const pane = String(stdout).trim();
    if (!PANE_ID.test(pane)) return fail(502, 'tmux_failed', 'tmux did not return a pane id');
    ctx.started?.set(pane, { key: projectKey, name: 'orchestrator', sessionId, role: 'orchestrator', mode: launchMode(config.permissionMode) });
    await tagPane(ctx, pane, 'orchestrator', `${projectKey}/orchestrator`, 1);
    // the pane already runs: failing to remember it (the project was removed meanwhile) must not fail the start
    if (!resume) await setOrchestrator(projectKey, sessionId, ctx.env).catch(() => {});
    return { status: 200, body: { pane, session, sessionId, created: true, ...cleared } };
  } catch (err) {
    return tmuxFail(err);
  }
}
