// Spawns agents in tmux panes (contract §3, §8; ADR 0007). spawnAgent() runs in the nika server or CLI: it validates the
// request, stores the brief and settings in nika's state dir and splits a pane that runs `nika _run-agent <key> <name>`.
// runAgent() is that wrapper: it re-validates what it reads, records the session, and runs claude with the safety flags.
// The brief never passes through tmux argv. Leaf module: every dependency comes in through ctx.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { loadConfig } from './store.js';
import { reportsDir } from './paths.js';
import { ensureDir, writeAtomic } from './fwrite.js';
import { openRegular, readAt, readHead } from './fsafe.js';
import { listPanes } from './collect/tmux.js';
import { clean } from './text.js';
import { PROJECT_KEY, AGENT_NAME, MODEL_ID, TMUX_SESSION, PANE_ID, RC_PREFIX, RC_NAME, PERMISSION_MODES } from './ids.js';
import { fail, binsMissing, tmux, tmuxFail, tagPane, sessionNameFor, reduceRc, permissionFlags, tmuxLiteral } from './orchestrate.js';

const BRIEF_MAX = 64 * 1024;
const AGENT_JSON_MAX = 4096;
const GUARD_TEMPLATE = new URL('../templates/guard-prompt.txt', import.meta.url);
const PANE_FILE = /^([a-z0-9][a-z0-9-]{0,39})\.pane$/;
const DENIED_TOOLS = ['Bash(nika:*)', 'Bash(tmux:*)', 'Bash(claude:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)'];
const DENY_SETTINGS = JSON.stringify({ permissions: { deny: ['Read(**/.env*)', 'Edit(**/.env*)', 'Read(**/*.key)', 'Edit(**/*.key)'] } });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- spawnAgent ---------------------------------------------------------------------------------------------------

const invalid = (message) => ({ failure: fail(400, 'invalid', message) });

/** Request fields → { value } or { failure }. Nothing from the request reaches a path or a shell. */
function parseRequest(req) {
  if (!isPlainObject(req)) return invalid('request must be an object');
  const { project, name, model, brief, permissionMode, under, session, rc } = req;
  if (typeof project !== 'string' || !PROJECT_KEY.test(project)) return invalid('invalid project key');
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) return invalid('invalid agent name');
  if (typeof model !== 'string' || !MODEL_ID.test(model)) return invalid('invalid model');
  if (typeof brief !== 'string' || !brief.trim() || brief.includes('\0')) return invalid('brief must be a non-empty string without NUL');
  if (Buffer.byteLength(brief) > BRIEF_MAX) return invalid(`brief is larger than ${BRIEF_MAX / 1024} KB`);
  if (permissionMode === 'bypassPermissions') return invalid('bypassPermissions is never allowed');
  if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) return invalid('invalid permissionMode');
  if (under !== undefined && (typeof under !== 'string' || !PANE_ID.test(under))) return invalid('invalid under pane');
  if (session !== undefined && (typeof session !== 'string' || !TMUX_SESSION.test(session))) return invalid('invalid session name');
  if (rc !== undefined && rc !== 'off' && (typeof rc !== 'string' || !RC_PREFIX.test(rc))) return invalid('invalid rc');
  return { value: { project, name, model, brief, permissionMode, under, session, rc } };
}

// Spawns of one project run one at a time, so the maxAgents count sees the pane the previous spawn just created.
const queues = new Map();
function serial(key, fn) {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {}).then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
  return run;
}

/** Live nika agents of a project as Map<name, paneId>: `<name>.pane` files (written by _run-agent) and started panes. */
async function liveAgents(dir, key, panes, started) {
  const live = new Map();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const file of names) {
    const m = PANE_FILE.exec(file);
    if (!m) continue;
    const pane = await readHead(path.join(dir, file), 32).then((t) => t.trim(), () => null);
    if (pane && PANE_ID.test(pane) && panes.has(pane)) live.set(m[1], pane);
  }
  for (const [pane, rec] of started ?? []) {
    if (!panes.has(pane)) started.delete(pane);
    else if (rec.key === key && rec.role !== 'orchestrator') live.set(rec.name, pane);
  }
  return live;
}

/** `.last-pane` as a pane id, or null when missing, malformed or not a safe file. */
async function lastPane(dir) {
  const id = await readHead(path.join(dir, '.last-pane'), 32).then((t) => t.trim(), () => null);
  return id && PANE_ID.test(id) ? id : null;
}

async function doSpawn(v, project, config, ctx) {
  const { panes, error } = await listPanes(ctx.exec, ctx.tmuxBin);
  if (error) return fail(503, 'tmux_unavailable', clean(error, 200) ?? 'tmux unavailable');

  // Where the pane goes: -t is `=<session>:` (beside) or a pane id (below another pane).
  const underPane = v.under ? panes.get(v.under) : null;
  if (v.under && !underPane) return fail(404, 'not_found', 'under pane not found');
  if (underPane && v.session && underPane.session !== v.session) return fail(400, 'invalid', 'under pane is in another tmux session');
  const session = v.session ?? underPane?.session ?? sessionNameFor(project);
  if (!underPane && ![...panes.values()].some((p) => p.session === session)) {
    return fail(404, 'not_found', `tmux session ${session} not found (start the orchestrator first)`);
  }

  const dir = reportsDir(project.key, ctx.env);
  const live = await liveAgents(dir, project.key, panes, ctx.started);
  if (live.has(v.name)) return fail(409, 'conflict', `agent ${v.name} is already running`);
  if (live.size >= config.limits.maxAgents) return fail(409, 'limit', `${live.size} of ${config.limits.maxAgents} agents are already running`);

  let target = ['-h', '-t', `=${session}:`];
  if (underPane) target = ['-v', '-t', v.under];
  else if (config.panePlacement === 'under-last') {
    const last = await lastPane(dir);
    if (last && panes.get(last)?.session === session) target = ['-v', '-t', last];
  }

  // Remote Control name: <prefix>-<name>; prefix = req.rc, else the setting, else the project's session name (≤ 20 chars)
  const prefix = v.rc === 'off' ? null : (v.rc ?? (config.remoteControl.enabled ? config.remoteControl.prefix || sessionNameFor(project) : null));
  const rc = prefix ? reduceRc(`${reduceRc(prefix, project.key)}-${v.name}`, '', true) : '';
  await ensureDir(dir);
  await writeAtomic(dir, `${v.name}.brief.md`, v.brief);
  await writeAtomic(dir, `${v.name}.agent.json`, `${JSON.stringify({ model: v.model, permissionMode: v.permissionMode ?? config.permissionMode, rc })}\n`);

  let pane;
  try {
    const { stdout } = await tmux(ctx, 'split-window', ...target, '-c', tmuxLiteral(project.dir), '-P', '-F', '#{pane_id}', '--', ...ctx.nikaArgv, '_run-agent', project.key, v.name);
    pane = stdout.trim();
  } catch (err) {
    return tmuxFail(err);
  }
  if (!PANE_ID.test(pane)) return fail(502, 'tmux_failed', 'tmux did not return a pane id');
  ctx.started?.set(pane, { key: project.key, name: v.name, sessionId: null, role: 'agent' });
  await tagPane(ctx, pane, 'agent');
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
  const { config } = await loadConfig(ctx.env);
  const project = config.projects.find((p) => p.key === parsed.value.project);
  if (!project) return fail(404, 'not_found', 'project is not registered');
  if (config.permissionMode === 'bypassPermissions') return fail(400, 'invalid', 'bypassPermissions is never allowed');
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
    return brief;
  } finally {
    await handle.close();
  }
}

/** `<name>.agent.json` → { model, permissionMode, rc }; every field is checked again, extra keys are refused. */
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
  if (!isPlainObject(j) || Object.keys(j).sort().join() !== 'model,permissionMode,rc') throw refusal('agent.json has unexpected fields');
  if (typeof j.model !== 'string' || !MODEL_ID.test(j.model)) throw refusal('agent.json: invalid model');
  if (j.permissionMode === 'bypassPermissions') throw refusal('bypassPermissions is never allowed');
  if (!PERMISSION_MODES.includes(j.permissionMode)) throw refusal('agent.json: invalid permissionMode');
  if (typeof j.rc !== 'string' || (j.rc !== '' && !RC_NAME.test(j.rc))) throw refusal('agent.json: invalid rc');
  return { model: j.model, permissionMode: j.permissionMode, rc: j.rc };
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
 * @param {object} ctx { env, claudeBin, stderr?, spawn? } (`spawn` is child_process.spawn, injectable for tests)
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
    guard = render(await fs.readFile(GUARD_TEMPLATE, 'utf8'), { name, reportPath: path.join(dir, `${name}.md`) });
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
    '--settings', DENY_SETTINGS, '--disallowedTools', ...DENIED_TOOLS, '--', brief,
  ];
  const code = await runChild(ctx.spawn ?? nodeSpawn, ctx.claudeBin, argv, ctx.env ?? process.env, say);
  // `<name>.rc` is claude's exit code, as in 0.1 (the dashboard shows it); a failed write must not hide the code itself
  await writeAtomic(dir, `${name}.rc`, `${code}\n`).catch((err) => say(`cannot record the exit code: ${err.code ?? err.message}`));
  return code;
}
