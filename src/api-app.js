// /api/app/*: the privileged routes of the app tier (contract §2, §3, §9). The security boundary of the desktop app:
// every request passes the guard (secret, Origin, Sec-Fetch-Site, Content-Type, body cap) before any route runs. The
// router only validates, picks the module and sends its { status, body } result; the modules do the work.
// Nothing here takes a file path from a request: ids are checked against ids.js shapes, projects are looked up by key.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { send, json, readBody } from './server.js';
import { loadConfig, removeProject, updateSettings, TEMPLATE_NAME } from './store.js';
import { openRegular, isRealDir } from './fsafe.js';
import { configDir, stateDir } from './paths.js';
import { clean } from './text.js';
import { UUID, PANE_ID, PROJECT_KEY, CLAUDE_COMMAND, COMMAND_NAME } from './ids.js';
import { mapLimit } from './util.js';
import { MODE_TARGETS, bypassWindow, modeFromRows, promptFromRows } from './mode.js';
import { MODEL_CATALOG } from './models.js';
import { createSessionControl, promptSig, insertShown } from './session-control.js';

const ELIGIBILITY_TTL_MS = 1000; // pane list + live-agent snapshot, so a 4 Hz capture does not run collect() 4 times a second
const TEMPLATES_MAX = 50;
const MODES_AT_ONCE = 4; // captures in flight for GET /modes
const COMMAND_MAX = 200; // characters of a slash command typed into Claude
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/; // C0, DEL, C1
const SIG = /^[0-9a-f]{16}$/;
const CAP = { small: 4 * 1024, settings: 16 * 1024, keys: 20 * 1024, spawn: 80 * 1024 };
// What can answer a permission prompt: Enter confirms the highlighted option, a digit picks an option, a paste may hold either.
const answersPrompt = (b) => (Array.isArray(b.keys) && b.keys.includes('Enter')) || (typeof b.text === 'string' && /[0-9]/.test(b.text)) || (b.paste !== undefined && b.paste !== null);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const err = (status, error, message) => ({ status, body: { error, message } });
// App copy (ADR 0011): fixed codes and texts only, never a path or OS error text (the module's errors carry just a code)
const COPY_ERRORS = {
  unsupported: [409, 'the app copy is for macOS'],
  'no-source': [409, 'nika cannot find its own app to copy'],
  'foreign-target': [409, "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace"],
  'copy-busy': [409, 'nika is already copying the app'],
  'copy-failed': [500, 'nika could not copy the app to Applications'],
  'dismiss-failed': [500, 'nika could not record your choice'],
};
const NO_COPY = { state: 'no-source', managed: false, dismissed: false, version: null, available: null, running: false };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** A path segment as a value of the given shape (the raw and the percent-decoded form are tried: `%5` or `%255`), else null. */
function param(raw, shape) {
  const candidates = [raw];
  try {
    candidates.unshift(decodeURIComponent(raw));
  } catch {
    // not a valid escape sequence: the raw form is all there is
  }
  return candidates.find((c) => shape.test(c)) ?? null;
}

/** `/` + a COMMAND_NAME, optionally followed by one space and arguments; at most COMMAND_MAX characters, no control characters. */
function isCommandText(text) {
  if (typeof text !== 'string' || !text.startsWith('/') || [...text].length > COMMAND_MAX || CONTROL.test(text)) return false;
  const space = text.indexOf(' ');
  return COMMAND_NAME.test(text.slice(1, space < 0 ? undefined : space));
}

/** Names (never contents) of the local rule templates in `dir`: regular files owned by the user (fsafe), sorted, at most 50. */
async function listTemplates(dir) {
  if (!(await isRealDir(dir))) return [];
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => TEMPLATE_NAME.test(n)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (out.length === TEMPLATES_MAX) break;
    try {
      await (await openRegular(path.join(dir, name))).handle.close();
      out.push(name);
    } catch {
      // a symlink, FIFO, hard link or foreign-owned file is not a template
    }
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.secret  the 43-char secret received on stdin
 * @param {object} o.ctx     { env, exec, tmuxBin, claudeBin, nikaArgv, claudeDir, now, started }; handed to the modules as is
 * @param {object} o.deps    { version, collect() → snapshot, listPanes() → { panes, error }, readHistory, listPlugins, rulesState,
 *                           preview, apply, spawnAgent, startOrchestrator, mirror, keys, picker, listCommands;
 *                           appCopy { state(), install(), dismiss() } (src/appcopy.js bound to this install);
 *                           createSessionControl, a test seam for the factory in session-control.js }
 * @returns {(req, res, url, port) => Promise<boolean>} true when it handled the request (every /api/app/* request)
 */
export function createAppApi({ secret, ctx, deps }) {
  const secretHash = sha256(secret);
  const historyCache = {};
  let eligibility = null; // { at, promise }
  const held = new Map(); // pane id → the last mode read from its footer (shown while a prompt or dialog covers the footer)
  const vim = new Map(); // pane id → true once its mode line has shown -- INSERT -- (Claude's input is in vim mode)

  const guard = (req, port) => {
    const given = req.headers['x-nika-app'];
    if (typeof given !== 'string' || !crypto.timingSafeEqual(sha256(given), secretHash)) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  };

  // --- pane eligibility (contract §3): in the current tmux list, running claude, AND a live Claude session's pane or one nika started ---

  function loadEligibility() {
    const t = ctx.now();
    if (eligibility && t >= eligibility.at && t - eligibility.at < ELIGIBILITY_TTL_MS) return eligibility.promise;
    const promise = (async () => {
      const [{ panes, error }, snapshot] = await Promise.all([deps.listPanes(), deps.collect().catch(() => null)]);
      // pane ids restart with the tmux server: a stale `started` entry must not make a stranger's pane eligible
      if (!error) for (const id of [...ctx.started.keys()]) if (!panes.has(id)) ctx.started.delete(id);
      // pane id → registry state of its live agent; two live agents claiming one pane is ambiguous, so never idle (null)
      const live = new Map();
      for (const g of snapshot?.groups ?? []) for (const a of g.agents) if (a.live && a.pane?.id) live.set(a.pane.id, live.has(a.pane.id) ? null : (a.state ?? null));
      const e = { panes, error, live };
      // a reused pane id starts fresh; a failed tmux list or registry read proves nothing, so one blip keeps the memory
      // (losing vim memory would let End type into a vim normal-mode input without `i` first)
      if (!error && snapshot) for (const id of [...held.keys(), ...vim.keys()]) if (!isEligible(e, id)) { held.delete(id); vim.delete(id); }
      return e;
    })();
    eligibility = { at: t, promise };
    promise.catch(() => {
      if (eligibility?.promise === promise) eligibility = null;
    });
    return promise;
  }

  // the registry's `tmuxPane` is agent-writable, and tmux can reuse a pane id after a restart: a pane qualifies, through
  // the registry or because nika started it, only while it really runs claude, so neither a forged entry nor a stale id
  // can route typed text into a shell pane (a started `_run-agent` pane shows as `node`)
  const isEligible = (e, id) => {
    const pane = e.panes.get(id);
    return Boolean(pane) && CLAUDE_COMMAND.test(String(pane.command ?? '').trim()) && (e.live.has(id) || ctx.started.has(id));
  };

  async function eligiblePane(raw) {
    const id = param(raw, PANE_ID);
    if (!id) return { failure: err(404, 'not_found', 'pane not found') };
    const e = await loadEligibility();
    if (isEligible(e, id)) return { id };
    return { failure: err(404, 'not_found', e.error ? clean(e.error, 200) : 'pane not found') };
  }

  /**
   * { mode, modeConfirmed, prompt } of a pane's screen (contract §3). A footer that reads is shown and remembered; when it
   * does not (a prompt or dialog covers it) the last remembered mode, else the mode a nika-started pane was launched with,
   * is shown with modeConfirmed false; with neither the mode is `unknown`. The prompt carries the sig the answer route checks and
   * `bypass`, the answer route's own window test, so the page hides the buttons exactly when the route would refuse them.
   */
  function readScreen(id, rows) {
    const footer = modeFromRows(rows);
    if (insertShown(rows)) vim.set(id, true);
    if (footer !== 'unknown') held.set(id, footer);
    const mode = footer !== 'unknown' ? footer : (held.get(id) ?? ctx.started.get(id)?.mode ?? 'unknown');
    const prompt = promptFromRows(rows);
    return { mode, modeConfirmed: footer !== 'unknown' || mode === 'unknown', prompt: prompt && { ...prompt, sig: promptSig(rows), bypass: bypassWindow(rows) } };
  }

  // One controller for the whole server: its per-pane lock covers mode, answer, command and End together.
  const control = (deps.createSessionControl ?? createSessionControl)({
    mirror: deps.mirror,
    keys: deps.keys,
    // a failed listing throws: it proves nothing about the pane (null would read as "gone")
    paneCommand: async (id) => {
      const { panes, error } = await deps.listPanes();
      if (error) throw new Error(error);
      const pane = panes.get(id);
      return pane ? String(pane.command ?? '').trim() : null;
    },
    // `{ fresh: true }`: the caller is about to act on the answer (a second Escape), so the 1 s snapshot is dropped first
    stateOf: async (id, o) => {
      if (o?.fresh === true) eligibility = null;
      return (await loadEligibility()).live.get(id) ?? null;
    },
    vimOf: (id) => vim.get(id) === true,
    now: () => ctx.now(),
  });

  // --- projects ---

  async function toProject(p) {
    return { key: p.key, dir: p.dir, name: p.name, addedAt: p.addedAt ?? null, rules: await deps.rulesState(p) };
  }

  async function projectOf(body) {
    const key = body.project;
    if (typeof key !== 'string' || !PROJECT_KEY.test(key)) return { failure: err(400, 'invalid', 'project must be a project key') };
    const project = (await loadConfig(ctx.env)).config.projects.find((p) => p.key === key);
    return project ? { project } : { failure: err(404, 'not_found', 'project is not registered') };
  }

  // --- handlers: ({ params, query, body, req }) → { status, body, headers? } ---

  const routes = [];
  const route = (method, re, cap, handler) => routes.push({ method, re, cap, handler });

  route('GET', /^\/api\/app\/me$/, 0, async () => ({
    status: 200,
    body: {
      tier: 'app',
      version: deps.version,
      platform: process.platform,
      tmux: path.isAbsolute(String(ctx.tmuxBin)), // findTmux() answers a bare "tmux" when it found none
      claude: Boolean(ctx.claudeBin),
      configDir: configDir(ctx.env),
      stateDir: stateDir(ctx.env),
      appCopy: await deps.appCopy.state().catch(() => NO_COPY), // display only: a failing check must not take the whole page down
    },
  }));

  // --- the copy of the app in ~/Applications (ADR 0011): the request names an action and nothing else, never a path ---

  route('POST', /^\/api\/app\/app-copy$/, CAP.small, async ({ body }) => {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'action' || !['install', 'dismiss'].includes(body.action)) return err(400, 'invalid', 'action must be install or dismiss');
    try {
      if (body.action === 'dismiss') {
        await deps.appCopy.dismiss();
        return { status: 200, body: { dismissed: true } };
      }
      const { state, version, restart } = await deps.appCopy.install(); // the contract's three fields; `changed` is for the CLI
      return { status: 200, body: { state, version, restart } };
    } catch (e) {
      const code = body.action === 'dismiss' ? 'dismiss-failed' : Object.hasOwn(COPY_ERRORS, e?.code) && e.code !== 'dismiss-failed' ? e.code : 'copy-failed';
      return err(COPY_ERRORS[code][0], code, COPY_ERRORS[code][1]);
    }
  });

  route('GET', /^\/api\/app\/projects$/, 0, async () => ({
    status: 200,
    body: { projects: await Promise.all((await loadConfig(ctx.env)).config.projects.map(toProject)) },
  }));

  route('POST', /^\/api\/app\/projects\/pick$/, CAP.small, async () => {
    const reqId = deps.picker.start();
    return reqId ? { status: 202, body: { reqId } } : err(429, 'busy', 'a folder picker is already open');
  });

  route('GET', /^\/api\/app\/projects\/pick\/([^/]+)$/, 0, async ({ params }) => {
    const reqId = param(params[0], UUID);
    const st = reqId && deps.picker.status(reqId);
    if (!st) return err(404, 'not_found', 'no such picker request');
    return { status: 200, body: st.state === 'done' ? { state: 'done', project: await toProject(st.project) } : { state: st.state } };
  });

  route('DELETE', /^\/api\/app\/projects\/([^/]+)$/, CAP.small, async ({ params }) => {
    const key = param(params[0], PROJECT_KEY);
    if (!key || !(await removeProject(key, ctx.env))) return err(404, 'not_found', 'project is not registered');
    return { status: 200, body: { removed: true } };
  });

  // --- settings and plugins ---

  const withoutProjects = ({ projects, ...settings }) => settings; // Settings = the config schema without `projects`

  route('GET', /^\/api\/app\/settings$/, 0, async () => ({ status: 200, body: withoutProjects((await loadConfig(ctx.env)).config) }));

  route('PUT', /^\/api\/app\/settings$/, CAP.settings, async ({ body }) => {
    if (body.permissionMode === 'bypassPermissions') return err(400, 'invalid', 'bypassPermissions is never allowed');
    const perProject = body.plugins?.perProject;
    if (perProject !== undefined) {
      if (!isPlain(perProject)) return err(400, 'invalid', 'plugins.perProject must be an object');
      const registered = new Set((await loadConfig(ctx.env)).config.projects.map((p) => p.key));
      const installed = new Set(await deps.listPlugins(ctx.claudeDir));
      for (const [key, names] of Object.entries(perProject)) {
        if (!registered.has(key)) return err(400, 'invalid', `plugins.perProject.${clean(key, 40) ?? '?'} is not a registered project`);
        if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return err(400, 'invalid', `plugins.perProject.${key} must be a list of plugin names`);
        const missing = names.find((n) => !installed.has(n));
        if (missing !== undefined) return err(400, 'invalid', `plugins.perProject.${key}: ${clean(missing, 80) ?? '?'} is not installed`);
      }
    }
    try {
      return { status: 200, body: withoutProjects(await updateSettings(body, ctx.env)) };
    } catch (e) {
      if (e?.code === 'EINVAL') return err(400, 'invalid', clean(e.warnings?.[0] ?? e.message, 200) ?? 'invalid settings');
      throw e;
    }
  });

  route('GET', /^\/api\/app\/plugins$/, 0, async () => ({ status: 200, body: { plugins: await deps.listPlugins(ctx.claudeDir) } }));

  route('GET', /^\/api\/app\/templates$/, 0, async () => ({
    status: 200,
    body: { templates: await listTemplates(path.join(configDir(ctx.env), 'templates')) },
  }));

  // --- sessions and panes ---

  route('GET', /^\/api\/app\/session\/([^/]+)\/history$/, 0, async ({ params, query }) => {
    const id = param(params[0], UUID);
    if (!id) return err(404, 'not_found', 'no such session');
    return deps.readHistory(id, { before: query.get('before') ?? undefined, limit: query.get('limit') ?? undefined }, { claudeDir: ctx.claudeDir, cache: historyCache, now: ctx.now });
  });

  route('GET', /^\/api\/app\/pane\/([^/]+)\/capture$/, 0, async ({ params, req }) => {
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    const r = await deps.mirror.capture(id, req.headers['if-none-match']);
    const headers = r.etag ? { ETag: `"${r.etag}"` } : {};
    if (r.status === 304) return { status: 304, body: null, headers };
    // a new object: the mirror's cached body is shared and stays as captured
    return { status: r.status, body: r.status === 200 ? { ...r.body, ...readScreen(id, r.body.rows) } : r.body, headers };
  });

  route('GET', /^\/api\/app\/modes$/, 0, async () => {
    const e = await loadEligibility();
    const ids = [...e.panes.keys()].filter((id) => isEligible(e, id));
    const read = await mapLimit(ids, MODES_AT_ONCE, async (id) => {
      const r = await deps.mirror.capture(id).catch(() => null);
      if (r?.status !== 200) return null; // a pane whose capture fails is left out
      const { mode, modeConfirmed } = readScreen(id, r.body.rows);
      return [id, { mode, confirmed: modeConfirmed }];
    });
    return { status: 200, body: { modes: Object.fromEntries(read.filter(Boolean)) } };
  });

  route('POST', /^\/api\/app\/pane\/([^/]+)\/keys$/, CAP.keys, async ({ params, body }) => {
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    // Enter, a digit or a paste could answer a permission prompt, and the answer route's bypass refusal does not reach this
    // route: so they look at a fresh screen first, and none is sent while a prompt (or a dialog nika cannot read: its footer
    // is unreadable) mentions bypass (T26). Typing letters, arrows, Escape and BTab stay as fast as in 0.2. The page's
    // passthrough posts to this route too, so it is guarded as well: only the terminal itself can answer such a prompt.
    if (answersPrompt(body)) {
      const cap = await deps.mirror.capture(id, undefined, { fresh: true });
      if (cap.status !== 200) return { status: cap.status, body: cap.body };
      const rows = cap.body.rows;
      if (bypassWindow(rows) && (promptFromRows(rows) !== null || modeFromRows(rows) === 'unknown')) return err(409, 'bypass-prompt', 'Answer this prompt in the terminal');
    }
    return deps.keys.send(id, { text: body.text, paste: body.paste, keys: body.keys });
  });

  // --- session control (0.3): each route validates, checks the pane, then hands over to the shared controller ---

  route('POST', /^\/api\/app\/pane\/([^/]+)\/mode$/, CAP.small, async ({ params, body }) => {
    if (!MODE_TARGETS.includes(body.target)) return err(400, 'invalid', `target must be one of ${MODE_TARGETS.join(', ')}`);
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    const r = await control.switchMode(id, body.target);
    // Presses went out but the switch did not finish: the footer may now show a mode other than the one held, or none that
    // nika can read (a bypass footer it does not know), so the held mode (and a started pane's launch mode) must not stand in for it
    if (r.status !== 200 && r.body?.presses > 0) held.set(id, 'unknown');
    return r;
  });

  route('POST', /^\/api\/app\/pane\/([^/]+)\/answer$/, CAP.small, async ({ params, body }) => {
    const { n, sig } = body;
    if (!Number.isInteger(n) || n < 1 || n > 9 || typeof sig !== 'string' || !SIG.test(sig)) return err(400, 'invalid', 'n must be an integer 1-9 and sig 16 lowercase hex characters');
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.answer(id, { n, sig });
  });

  route('POST', /^\/api\/app\/pane\/([^/]+)\/command$/, CAP.small, async ({ params, body }) => {
    if (!isCommandText(body.text)) return err(400, 'invalid', `text must be / and a command name, optionally one space and arguments (at most ${COMMAND_MAX} characters, no control characters)`);
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.runCommand(id, body.text);
  });

  route('POST', /^\/api\/app\/pane\/([^/]+)\/end$/, CAP.small, async ({ params }) => {
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    try {
      return await control.endSession(id);
    } finally {
      eligibility = null; // the pane may be gone
    }
  });

  // Stop does not take the controller's per-pane lock, so it works while a switch or a command waits
  route('POST', /^\/api\/app\/pane\/([^/]+)\/stop$/, CAP.small, async ({ params }) => {
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.stop(id);
  });

  route('GET', /^\/api\/app\/commands$/, 0, async ({ query }) => {
    let projectDir;
    if (query.has('project')) {
      const { project, failure } = await projectOf({ project: query.get('project') });
      if (failure) return failure;
      projectDir = project.dir;
    }
    return { status: 200, body: { commands: await deps.listCommands({ claudeDir: ctx.claudeDir, projectDir, now: ctx.now() }) } };
  });

  route('GET', /^\/api\/app\/models$/, 0, async () => ({ status: 200, body: { models: MODEL_CATALOG } }));

  // --- agents ---

  route('POST', /^\/api\/app\/spawn$/, CAP.spawn, async ({ body }) => {
    if (body.permissionMode === 'bypassPermissions') return err(400, 'invalid', 'bypassPermissions is never allowed');
    const r = await deps.spawnAgent(body, ctx);
    if (r.status === 200) eligibility = null; // the new pane is eligible at once
    return r;
  });

  route('POST', /^\/api\/app\/orchestrator\/start$/, CAP.small, async ({ body }) => {
    const { project, failure } = await projectOf(body);
    if (failure) return failure;
    const r = await deps.startOrchestrator(project.key, ctx);
    if (r.status === 200) eligibility = null;
    return r;
  });

  // --- rules ---

  route('POST', /^\/api\/app\/rules\/preview$/, CAP.small, async ({ body }) => {
    const { project, failure } = await projectOf(body);
    return failure ?? deps.preview(project, ctx);
  });

  route('POST', /^\/api\/app\/rules\/apply$/, CAP.small, async ({ body }) => {
    const { project, failure } = await projectOf(body);
    return failure ?? deps.apply(project, { hash: body.hash, overwriteForeign: body.overwriteForeign, gitignore: body.gitignore }, ctx);
  });

  // --- dispatch ---

  const hasBody = (req) => (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'] !== undefined;

  /** Body of a write: JSON content type (415), within the cap (413), a JSON object (400). */
  async function readJson(req, cap) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return { failure: err(415, 'unsupported_media', 'Content-Type must be application/json') };
    const raw = await readBody(req, cap);
    if (raw === null) return { failure: err(413, 'too_large', `body is larger than ${cap / 1024} KB`) };
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { failure: err(400, 'invalid', 'body is not valid JSON') };
    }
    if (!isPlain(body) || Object.hasOwn(body, '__proto__')) return { failure: err(400, 'invalid', 'body must be a JSON object') };
    return { body };
  }

  function reply(res, r) {
    if (r.status === 304) return send(res, 304, '', 'application/json; charset=utf-8', r.headers);
    return send(res, r.status, JSON.stringify(r.body), 'application/json; charset=utf-8', r.headers);
  }

  return async function handle(req, res, url, port) {
    const p = url.pathname;
    if (p !== '/api/app' && !p.startsWith('/api/app/')) return false;
    try {
      if (!guard(req, port)) {
        json(res, 403, { error: 'forbidden', message: 'forbidden' }); // one body for every guard failure: nothing to tell apart
        return true;
      }
      const matches = routes.map((r) => ({ r, m: r.re.exec(p) })).filter((x) => x.m);
      if (!matches.length) {
        reply(res, err(404, 'not_found', 'no such route'));
        return true;
      }
      const hit = matches.find((x) => x.r.method === req.method);
      if (!hit) {
        const allow = matches.map((x) => x.r.method).join(', ');
        send(res, 405, JSON.stringify({ error: 'method_not_allowed', message: `use ${allow}` }), 'application/json; charset=utf-8', { Allow: allow });
        return true;
      }
      let body = {};
      if (hit.r.method !== 'GET' && (hit.r.method !== 'DELETE' || hasBody(req))) {
        const parsed = await readJson(req, hit.r.cap);
        if (parsed.failure) {
          reply(res, parsed.failure);
          return true;
        }
        body = parsed.body;
      }
      reply(res, await hit.r.handler({ params: hit.m.slice(1), query: url.searchParams, body, req }));
    } catch (e) {
      console.error(`nika: ${req.method} ${p.slice(0, 200)} failed:`, e);
      if (!res.headersSent) reply(res, err(500, 'internal', 'internal error'));
      else res.destroy(e);
    }
    return true;
  };
}
