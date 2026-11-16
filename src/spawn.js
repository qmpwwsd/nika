// Spawns agents in tmux panes (contract §3, §8; ADR 0007). spawnAgent() runs in the nika server or CLI: it validates the
// request, stores the brief and settings in nika's state dir and splits a pane that runs `nika _run-agent <key> <name>`.
// runAgent() is that wrapper: it re-validates what it reads, records the session, and runs claude with the safety flags.
// The brief never passes through tmux argv. Nesting (0.4, ADR 0013): a spawn may name a parent pane; its role and depth come only from
// tmux's own tags on that pane, never from the request, argv, env or a file. Leaf module: every dependency comes in through ctx.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { loadConfig, effectiveAgents } from './store.js';
import { reportsDir } from './paths.js';
import { ensureDir, writeAtomic } from './fwrite.js';
import { openRegular, readAt, readHead } from './fsafe.js';
import { listPanes } from './collect/tmux.js';
import { clean } from './text.js';
import { NO_TMUX_SERVER } from './tmuxerr.js';
import { compactLaunch, compactEnv, PCT_ENV } from './compact.js';
import { PROJECT_KEY, AGENT_NAME, parseAgentTag, MODEL_ID, TMUX_SESSION, PANE_ID, RC_PREFIX, RC_NAME, PERMISSION_MODES } from './ids.js';
import { fail, binsMissing, tmux, tmuxFail, tagPane, earlyExit, sessionNameFor, reduceRc, permissionFlags, launchMode, tmuxLiteral } from './orchestrate.js';

const BRIEF_MAX = 64 * 1024;
const AGENT_JSON_MAX = 4096;
const GUARD_TEMPLATE = new URL('../templates/guard-prompt.txt', import.meta.url);
const GUARD_ORCHESTRATOR = new URL('../templates/guard-orchestrator.txt', import.meta.url);
// tmux's record of nika's panes: pane id, whether the pane is dead (remain-on-exit keeps it, tags and all), the tags tagPane sets
// (`@nika-role`, `@nika-agent` = `<project key>/<name>`, `@nika-depth`, `@nika-parent`), then the session and window names (free text, so last)
const AGENT_LIST = '#{pane_id}\t#{pane_dead}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{session_name}\t#{window_name}';
const DENIED_TOOLS = ['Bash(nika:*)', 'Bash(tmux:*)', 'Bash(claude:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)'];
// A sub-orchestrator may run `nika spawn` and `nika status` and nothing else of nika (advisory, like every list here: rules constraint 12)
const SUB_ALLOWED = new Set(['spawn', 'status']);
const SUB_ROLE = 'sub-orchestrator';
const MAX_DEPTH = 3;
// First window of a project session that a spawn had to create (a constant, no `#`: tmux format-expands `new-session -n`; asserted by the T6 test)
const AGENTS_WINDOW = 'agents';

/**
 * The `--disallowedTools` of a role. An agent keeps the whole list. A sub-orchestrator keeps it except `Bash(nika:*)`, which becomes
 * one rule for bare `nika` and one `Bash(nika <sub>:*)` per command of the CLI's table (`commands`, from src/cli.js) other than spawn and
 * status, so a command added to the table is denied by default. Without a table it falls back to denying all of nika.
 */
export function deniedTools(role, commands) {
  const table = Array.isArray(commands) && commands.length && commands.every((c) => typeof c === 'string' && /^[\w-]+$/.test(c));
  if (role !== SUB_ROLE || !table) return DENIED_TOOLS;
  return [...DENIED_TOOLS.slice(1), 'Bash(nika)', ...commands.filter((c) => !SUB_ALLOWED.has(c)).map((c) => `Bash(nika ${c}:*)`)];
}
const DENY_SETTINGS = JSON.stringify({ permissions: { deny: ['Read(**/.env*)', 'Edit(**/.env*)', 'Read(**/*.key)', 'Edit(**/*.key)'] } });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// The brief is claude's positional prompt after `--`; a lone word such as `update` or `doctor` can be read as a subcommand.
const isOneWord = (brief) => !/\s/.test(brief.trim());

// --- spawnAgent ---------------------------------------------------------------------------------------------------

const invalid = (message) => ({ failure: fail(400, 'invalid', message) });

/** Request fields → { value } or { failure }. Nothing from the request reaches a path or a shell. */
function parseRequest(req) {
  if (!isPlainObject(req)) return invalid('request must be an object');
  const { project, name, model, brief, permissionMode, under, session, rc, role = 'agent', parent } = req;
  if (typeof project !== 'string' || !PROJECT_KEY.test(project)) return invalid('invalid project key');
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) return invalid('invalid agent name');
  if (name === 'orchestrator') return invalid('orchestrator is reserved'); // the main orchestrator's tag is `<key>/orchestrator`: keep the two forms apart
  if (typeof model !== 'string' || !MODEL_ID.test(model)) return invalid('invalid model');
  if (typeof brief !== 'string' || !brief.trim() || brief.includes('\0')) return invalid('brief must be a non-empty string without NUL');
  if (isOneWord(brief)) return invalid('brief must be more than one word');
  if (Buffer.byteLength(brief) > BRIEF_MAX) return invalid(`brief is larger than ${BRIEF_MAX / 1024} KB`);
  if (permissionMode === 'bypassPermissions') return invalid('bypassPermissions is never allowed');
  if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) return invalid('invalid permissionMode');
  if (under !== undefined && (typeof under !== 'string' || !PANE_ID.test(under))) return invalid('invalid under pane');
  if (session !== undefined && (typeof session !== 'string' || !TMUX_SESSION.test(session))) return invalid('invalid session name');
  if (rc !== undefined && rc !== 'off' && (typeof rc !== 'string' || !RC_PREFIX.test(rc))) return invalid('invalid rc');
  if (role !== 'agent' && role !== 'orchestrator') return invalid('invalid role');
  if (parent !== undefined && (typeof parent !== 'string' || !PANE_ID.test(parent))) return invalid('invalid parent pane');
  return { value: { project, name, model, brief, permissionMode, under, session, rc, role, parent } };
}

// Spawns of one project run one at a time, so the caps count the pane the previous spawn just created (a CLI process and the app
// server each have their own queue: they can still race by one pane, T36).
const queues = new Map();
function serial(key, fn) {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {}).then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
  return run;
}

/**
 * `tmux list-panes -a` in AGENT_LIST form → Map<paneId, tags>. Every tag is kept as tmux wrote it: only an exact match is trusted later.
 * A dead pane (remain-on-exit) is left out, so it is never live (the caps, the duplicate-name check) and never a parent.
 */
async function readTags(ctx) {
  const { stdout } = await tmux(ctx, 'list-panes', '-a', '-F', AGENT_LIST);
  const tags = new Map();
  for (const line of String(stdout).split('\n')) {
    const [pane, dead = '', role = '', agent = '', depth = '', parent = '', session = '', ...window] = line.split('\t');
    if (PANE_ID.test(pane ?? '') && dead.trim() !== '1') tags.set(pane, { role, agent, depth, parent, session, window: window.join('\t') });
  }
  return tags;
}

/**
 * Live agents and sub-orchestrators of a project as [{ pane, name, role, parent, depth }]: the panes in any tmux session with
 * `@nika-role` agent or sub-orchestrator and an `@nika-agent` tag `<key>/<name>` for this key (F5), plus the panes this process started
 * (nika's own record of a pane wins over the tags on it). `<name>.pane` files are agent-writable and display-only: they never count.
 * A `@nika-parent` that is not a pane id is no parent.
 */
function liveAgents(ctx, key, tags, panes) {
  const live = new Map();
  for (const [pane, t] of tags) {
    const parsed = t.role === 'agent' || t.role === SUB_ROLE ? parseAgentTag(t.agent) : null;
    if (parsed?.[0] === key) live.set(pane, { pane, name: parsed[1], role: t.role, parent: PANE_ID.test(t.parent) ? t.parent : null, depth: /^[123]$/.test(t.depth) ? Number(t.depth) : null });
  }
  for (const [pane, rec] of ctx.started ?? []) {
    if (!panes.has(pane)) ctx.started.delete(pane);
    else if (!tags.has(pane)) continue; // dead (remain-on-exit): readTags left it out, so it is not live even though this process started it
    else if (rec.key === key && (rec.role === 'agent' || rec.role === SUB_ROLE)) live.set(pane, { pane, name: rec.name, role: rec.role, parent: rec.parent ?? null, depth: rec.depth ?? null });
  }
  return [...live.values()];
}

/**
 * What a parent pane is to `project`, from its tags alone: 'main' (the project's main orchestrator), 'sub' (one of its
 * sub-orchestrators), or null for any other pane that carries a nika role: an agent, anything of another project, a tag that does not
 * parse, a depth that does not fit the role, an unknown role value. `@nika-depth` is only a consistency check here.
 */
function kindOf(t, project) {
  switch (t.role) {
    case 'orchestrator': {
      // tagged `<key>/orchestrator` (0.4: start, resume, adopt), or a 0.3 pane with no tag at all in the project's session, window `orchestrator`
      const main = t.agent === `${project.key}/orchestrator` || (t.agent === '' && t.session === sessionNameFor(project) && t.window === 'orchestrator');
      return main && (t.depth === '' || t.depth === '1') ? 'main' : null;
    }
    case SUB_ROLE:
      return parseAgentTag(t.agent)?.[0] === project.key && t.depth === '2' ? 'sub' : null;
    default:
      return null;
  }
}

const LEVELS = 'nika allows three levels (orchestrator, sub-orchestrators, their agents). Nothing was started.';

/**
 * Who the new pane's parent is and how deep it sits: { parent: paneId | null, depth: 1 | 2 | 3 } or { failure }. The depth follows the
 * parent's role in tmux's record (main orchestrator → 2, sub-orchestrator → 3, "you" → 1); nothing about it is read from the request,
 * argv, env or a file. "You" is only: no parent named, a pane with no `@nika-role` at all (a shell, the page's header), or, for the CLI
 * (`ctx.lenientParent`, its parent is `$TMUX_PANE`), a pane that tmux does not list. A page request naming a pane that is gone is 404.
 * Any other pane that carries a nika role and is not this project's orchestrator or sub-orchestrator is 409 `depth`: an agent can't
 * parent, and neither can anything of another project or with a tag that does not agree. A sub-orchestrator is started only under
 * the main orchestrator.
 */
function resolveParent(v, project, tags, ctx) {
  const t = v.parent ? tags.get(v.parent) : undefined;
  if (v.parent && !t && !ctx.lenientParent) return { failure: fail(404, 'not_found', 'The parent session is no longer running, so nothing was started.') };
  const kind = t && t.role !== '' ? kindOf(t, project) : null;
  if (t && t.role !== '' && !kind) {
    const who = clean(parseAgentTag(t.agent)?.[1], 48) ?? v.parent;
    return { failure: fail(409, 'depth', `${who} can't start agents for this project: only this project's orchestrator and its sub-orchestrators can. Nothing was started.`) };
  }
  const depth = kind === 'main' ? 2 : kind === 'sub' ? 3 : 1;
  if (v.role === 'orchestrator' && depth !== 2) return { failure: fail(409, 'depth', `That session can't start a sub-orchestrator. Only the main orchestrator can: ${LEVELS}`) };
  return { parent: kind ? v.parent : null, depth };
}

const limitFail = (scope, running, max, message) => ({ status: 409, body: { error: 'limit', message, scope, running, max } });

/** `.last-pane` as a pane id, or null when missing, malformed or not a safe file. */
async function lastPane(dir) {
  const id = await readHead(path.join(dir, '.last-pane'), 32).then((t) => t.trim(), () => null);
  return id && PANE_ID.test(id) ? id : null;
}

async function doSpawn(v, project, config, ctx) {
  const { panes, error } = await listPanes(ctx.exec, ctx.tmuxBin);
  // A failed listing is "no panes yet" only when tmux says no server runs (NO_TMUX_SERVER): the spawn then creates the project session below.
  // Any other failure fails closed (502 tmux_failed, nothing created): the parent, the depth and both caps are read from this listing, and
  // an unreadable listing is not an empty one. listPanes keeps only a string, so the raw error comes from the tag listing: ENOENT is "tmux unavailable".
  let tags = null;
  if (error) {
    let raw = null;
    try {
      await readTags(ctx);
    } catch (err) {
      raw = err;
    }
    if (!raw) return tmuxFail({ message: error.replace(/^tmux unavailable: /, '') }); // the two listings disagree: trust neither
    if (raw.code === 'ENOENT' || !NO_TMUX_SERVER.test(String(raw.stderr || raw.message || ''))) return tmuxFail(raw);
    tags = new Map();
  }

  // Where the pane goes: -t is `=<session>:` (beside) or a pane id (below another pane).
  const underPane = v.under ? panes.get(v.under) : null;
  if (v.under && !underPane) return fail(404, 'not_found', 'under pane not found');
  if (underPane && v.session && underPane.session !== v.session) return fail(400, 'invalid', 'under pane is in another tmux session');

  const dir = reportsDir(project.key, ctx.env);
  if (!tags) {
    try {
      tags = await readTags(ctx);
    } catch (err) {
      return tmuxFail(err);
    }
  }
  const who = resolveParent(v, project, tags, ctx);
  if (who.failure) return who.failure;
  // With nothing asked for, the agent opens beside its parent, so an orchestrator adopted from the user's own tmux session keeps its
  // children with it; a parent session name that is not a valid TMUX_SESSION is not used (today's rule: the project's session).
  const parentSession = who.parent ? tags.get(who.parent)?.session : undefined;
  const session = v.session ?? underPane?.session ?? (TMUX_SESSION.test(parentSession ?? '') ? parentSession : sessionNameFor(project));
  // No such session: the project's own is created below with this agent's pane; a session someone else named is not nika's to create.
  const exists = Boolean(underPane) || [...panes.values()].some((p) => p.session === session);
  if (!exists && session !== sessionNameFor(project)) return fail(404, 'not_found', `tmux session ${session} not found`);
  const live = liveAgents(ctx, project.key, tags, panes);
  if (live.some((e) => e.name === v.name)) return fail(409, 'conflict', `agent ${v.name} is already running`);
  // the project's cap first, then the parent's own: sub-orchestrators and agents count the same
  const { maxAgents: max, panePlacement, permissionMode: defaultMode } = effectiveAgents(config, project.key);
  const cap = Math.min(3 * max, 24);
  const own = live.filter((e) => e.parent === who.parent).length;
  const name = clean(project.name, 60) ?? 'This project';
  const more = config.perProject[project.key]?.maxAgents === undefined
    ? 'Wait for one to finish, or raise “Agents per orchestrator” in Settings.'
    : 'Wait for one to finish, or raise “Per orchestrator” on this project’s New agents card.'; // the project's own limit beats Settings'
  if (live.length >= cap) return limitFail('project', live.length, cap, `${name} already runs ${live.length} of ${cap} agents, the most one project can run. Wait for one to finish.`);
  if (own >= max) {
    return limitFail('parent', own, max, who.parent
      ? `That session already runs ${own} of ${max} agents of its own. ${more}`
      : `You already run ${own} of ${max} agents spawned from nika in ${name}. ${more}`);
  }

  // Placement (beside, under the last agent) applies only when the session exists; otherwise the pane is the session's first.
  let target = ['-h', '-t', `=${session}:`];
  if (underPane) target = ['-v', '-t', v.under];
  else if (exists && panePlacement === 'under-last') {
    const last = await lastPane(dir);
    if (last && panes.get(last)?.session === session) target = ['-v', '-t', last];
  }

  // Remote Control name: <prefix>-<name>; prefix = req.rc, else the setting, else the project's session name (≤ 20 chars)
  const prefix = v.rc === 'off' ? null : (v.rc ?? (config.remoteControl.enabled ? config.remoteControl.prefix || sessionNameFor(project) : null));
  const rc = prefix ? reduceRc(`${reduceRc(prefix, project.key)}-${v.name}`, '', true) : '';
  await ensureDir(dir);
  await writeAtomic(dir, `${v.name}.brief.md`, v.brief);
  const permissionMode = v.permissionMode ?? defaultMode;
  const role = v.role === 'orchestrator' ? SUB_ROLE : 'agent';
  // auto-compact (ADR 0014): decided now from this spawn's own model; _run-agent re-checks it and turns it into the env of claude
  const launch = compactLaunch(v.model, config.compaction);
  const compact = launch ? { window: launch.window, pct: launch.env[PCT_ENV] } : null;
  await writeAtomic(dir, `${v.name}.agent.json`, `${JSON.stringify({ model: v.model, permissionMode, rc, role, parent: who.parent, depth: who.depth, compact })}\n`);

  let pane;
  try {
    const wrapper = ['-P', '-F', '#{pane_id}', '--', ...ctx.nikaArgv, '_run-agent', project.key, v.name];
    const { stdout } = await tmux(ctx, ...(exists
      ? ['split-window', ...target, '-c', tmuxLiteral(project.dir), ...wrapper]
      : ['new-session', '-d', '-s', session, '-n', AGENTS_WINDOW, '-c', tmuxLiteral(project.dir), '-x', '200', '-y', '50', ...wrapper]));
    pane = stdout.trim();
  } catch (err) {
    return tmuxFail(err);
  }
  if (!PANE_ID.test(pane)) return fail(502, 'tmux_failed', 'tmux did not return a pane id');
  ctx.started?.set(pane, { key: project.key, name: v.name, sessionId: null, role, parent: who.parent, depth: who.depth, mode: launchMode(permissionMode) });
  await tagPane(ctx, pane, role, `${project.key}/${v.name}`, who.depth, who.parent);
  const exited = await earlyExit(ctx, pane);
  if (exited) {
    ctx.started?.delete(pane);
    return exited;
  }
  // The agent is already running: a failure below only costs the title or the under-last placement.
  await writeAtomic(dir, '.last-pane', `${pane}\n`).catch(() => {});
  await tmux(ctx, 'select-pane', '-t', pane, '-T', `[${pane}] ${v.name}`).catch(() => {});
  return {
    status: 200,
    body: { pane, session, sessionId: null, reports: { dir, session: `${v.name}.session`, report: `${v.name}.md`, rc: `${v.name}.rc`, remote: `${v.name}.remote` } },
  };
}

/**
 * @param {object} req  POST /api/app/spawn body (contract §3); optional `rc`: "off" or an RC_PREFIX overriding the setting
 * @param {object} ctx  { env, exec, tmuxBin, claudeBin, nikaArgv, started }
 * @returns {Promise<{ status: number, body: object }>} `sessionId` is null: only _run-agent knows it
 */
export async function spawnAgent(req, ctx) {
  const parsed = parseRequest(req);
  if (parsed.failure) return parsed.failure;
  const missing = binsMissing(ctx);
  if (missing) return missing;
  if (!Array.isArray(ctx.nikaArgv) || !ctx.nikaArgv.length || !ctx.nikaArgv.every((a) => typeof a === 'string' && a && !a.includes('\0'))) {
    return fail(500, 'internal', 'nikaArgv must be a non-empty array of strings');
  }
  const { config } = await (ctx.loadConfig ?? loadConfig)(ctx.env); // ctx.loadConfig: tests only, to pin the bypass check below on a config load would never give
  const project = config.projects.find((p) => p.key === parsed.value.project);
  if (!project) return fail(404, 'not_found', 'project is not registered');
  if (effectiveAgents(config, project.key).permissionMode === 'bypassPermissions') return fail(400, 'invalid', 'bypassPermissions is never allowed');
  try {
    return await serial(project.key, () => doSpawn(parsed.value, project, config, ctx));
  } catch (err) {
    return fail(500, 'internal', `${err.code ?? 'error'}: ${clean(err.message, 200) ?? 'failed'}`);
  }
}

// --- runAgent -----------------------------------------------------------------------------------------------------

// Exit codes of contract §7: 3 = refused (the stored files are not what spawn wrote), 1 = runtime error.
const refusal = (message) => Object.assign(new Error(message), { code: 'EREFUSED' });
const REFUSED = new Set(['EREFUSED', 'ENOTREG', 'EOWNER', 'ENLINK', 'ELOOP']);

async function readBrief(file) {
  const { handle, st } = await openRegular(file);
  try {
    if (st.size > BRIEF_MAX) throw refusal(`brief is larger than ${BRIEF_MAX / 1024} KB`);
    const brief = await readAt(handle, 0, st.size);
    if (!brief.trim() || brief.includes('\0')) throw refusal('brief is empty or contains NUL');
    if (isOneWord(brief)) throw refusal('brief must be more than one word');
    return brief;
  } finally {
    await handle.close();
  }
}

/**
 * `<name>.agent.json` → { model, permissionMode, rc, role, parent, depth, compact }; every field is checked again, extra keys are
 * refused. The values must agree: depth 1 is a root (no parent), anything deeper has a parent pane, and a sub-orchestrator is depth 2.
 * `compact` is null (auto-compact off) or exactly { window, pct } with the checks of src/compact.js; it comes back as the env to add.
 */
async function readAgentJson(file) {
  const { handle, st } = await openRegular(file);
  let raw;
  try {
    if (st.size > AGENT_JSON_MAX) throw refusal('agent.json is too large');
    raw = await readAt(handle, 0, st.size);
  } finally {
    await handle.close();
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw refusal('agent.json is not valid JSON');
  }
  if (!isPlainObject(j) || Object.keys(j).sort().join() !== 'compact,depth,model,parent,permissionMode,rc,role') throw refusal('agent.json has unexpected fields');
  if (typeof j.model !== 'string' || !MODEL_ID.test(j.model)) throw refusal('agent.json: invalid model');
  if (j.permissionMode === 'bypassPermissions') throw refusal('bypassPermissions is never allowed');
  if (!PERMISSION_MODES.includes(j.permissionMode)) throw refusal('agent.json: invalid permissionMode');
  if (typeof j.rc !== 'string' || (j.rc !== '' && !RC_NAME.test(j.rc))) throw refusal('agent.json: invalid rc');
  if (j.role !== 'agent' && j.role !== SUB_ROLE) throw refusal('agent.json: invalid role');
  if (!Number.isInteger(j.depth) || j.depth < 1 || j.depth > MAX_DEPTH) throw refusal('agent.json: invalid depth');
  if (j.parent !== null && (typeof j.parent !== 'string' || !PANE_ID.test(j.parent))) throw refusal('agent.json: invalid parent');
  if ((j.parent === null) !== (j.depth === 1) || (j.role === SUB_ROLE && j.depth !== 2)) throw refusal('agent.json: role, parent and depth do not agree');
  return { model: j.model, permissionMode: j.permissionMode, rc: j.rc, role: j.role, parent: j.parent, depth: j.depth, compact: compactOf(j.compact) };
}

/** The `compact` field of agent.json → the env to add (`null` when off); refuses anything but null or exactly { window, pct } that compactEnv accepts. */
function compactOf(c) {
  if (c === null) return null;
  if (!isPlainObject(c) || Object.keys(c).sort().join() !== 'pct,window') throw refusal('agent.json: invalid compact');
  try {
    return compactEnv(c.window, c.pct);
  } catch {
    throw refusal('agent.json: invalid compact');
  }
}

const render = (template, vars) => template.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));

/** Runs the child with inherited stdio; resolves with its exit code (128 + signal when killed). SIGINT is left to claude. */
function runChild(spawnFn, bin, argv, env, say) {
  return new Promise((resolve) => {
    const ignore = () => {};
    const done = (code) => {
      process.off('SIGINT', ignore);
      resolve(code);
    };
    let child;
    try {
      child = spawnFn(bin, argv, { stdio: 'inherit', shell: false, env });
    } catch (err) {
      say(`cannot run claude: ${err.code ?? err.message}`);
      resolve(1);
      return;
    }
    process.on('SIGINT', ignore);
    child.once('error', (err) => {
      say(`cannot run claude: ${err.code ?? err.message}`);
      done(1);
    });
    child.once('exit', (code, signal) => done(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });
}

/**
 * The hidden pane wrapper `nika _run-agent <key> <name>` (contract §8).
 * @param {object} ctx { env, claudeBin, commands?, stderr?, spawn? } (`commands` = the CLI's command names, for a sub-orchestrator's
 *                     deny list; `spawn` is child_process.spawn, injectable for tests)
 * @returns {Promise<number>} claude's exit code; 3 when the stored files are refused, 1 on any other failure
 */
export async function runAgent(key, name, ctx) {
  const say = (m) => (ctx.stderr ?? process.stderr).write(`nika: ${m}\n`);
  if (typeof key !== 'string' || !PROJECT_KEY.test(key) || typeof name !== 'string' || !AGENT_NAME.test(name)) {
    say('invalid project key or agent name');
    return 3;
  }
  if (!ctx.claudeBin) {
    say('claude not found (add it to PATH or set NIKA_CLAUDE)');
    return 1;
  }
  const dir = reportsDir(key, ctx.env);
  const sessionId = crypto.randomUUID();
  let brief;
  let meta;
  let guard;
  try {
    brief = await readBrief(path.join(dir, `${name}.brief.md`));
    meta = await readAgentJson(path.join(dir, `${name}.agent.json`));
    guard = render(await fs.readFile(meta.role === SUB_ROLE ? GUARD_ORCHESTRATOR : GUARD_TEMPLATE, 'utf8'), { name, reportPath: path.join(dir, `${name}.md`) });
    await writeAtomic(dir, `${name}.session`, `${sessionId}\n`);
    await writeAtomic(dir, `${name}.remote`, meta.rc ? `${meta.rc}\n` : '');
    await writeAtomic(dir, `${name}.rc`, ''); // clears the exit code of an earlier run until claude exits
    const pane = ctx.env?.TMUX_PANE;
    if (typeof pane === 'string' && PANE_ID.test(pane)) await writeAtomic(dir, `${name}.pane`, `${pane}\n`);
  } catch (err) {
    say(`${err.code ?? 'error'}: ${clean(err.message, 200) ?? 'failed'}`);
    return REFUSED.has(err.code) ? 3 : 1;
  }
  const argv = [
    '--session-id', sessionId, '--model', meta.model, ...permissionFlags(meta.permissionMode), '-n', name,
    ...(meta.rc ? [`--remote-control=${meta.rc}`] : []), '--add-dir', dir, '--append-system-prompt', guard,
    '--settings', DENY_SETTINGS, '--disallowedTools', ...deniedTools(meta.role, ctx.commands), '--', brief,
  ];
  // the inherited env, plus the two compaction variables when auto-compact is on (a new object: ctx.env itself is never written to)
  const env = ctx.env ?? process.env;
  const code = await runChild(ctx.spawn ?? nodeSpawn, ctx.claudeBin, argv, meta.compact ? { ...env, ...meta.compact } : env, say);
  // `<name>.rc` is claude's exit code, as in 0.1 (the dashboard shows it); a failed write must not hide the code itself
  await writeAtomic(dir, `${name}.rc`, `${code}\n`).catch((err) => say(`cannot record the exit code: ${err.code ?? err.message}`));
  return code;
}
