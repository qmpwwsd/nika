// /api/app/*: the privileged routes of the app tier (contract §2, §3, §9). The security boundary of the desktop app:
// every request passes the guard (secret, Origin, Sec-Fetch-Site, Content-Type, body cap) before any route runs. The
// router only validates, picks the module and sends its { status, body } result; the modules do the work.
// Nothing here takes a file path from a request: ids are checked against ids.js shapes, projects are looked up by key.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { send, json, readBody } from './server.js';
import { loadConfig, removeProject, updateSettings, getProjectConfig, updateProjectConfig, getOrchestrator, setOrchestrator, TEMPLATE_NAME } from './store.js';
import { openRegular, isRealDir } from './fsafe.js';
import { configDir, stateDir } from './paths.js';
import { clean } from './text.js';
import { UUID, SUBAGENT_ID, PANE_ID, PROJECT_KEY, CLAUDE_COMMAND, COMMAND_NAME } from './ids.js';
import { mapLimit } from './util.js';
import { MODE_TARGETS, bypassWindow, modeFromRows, promptFromRows, surveyOrFollowUpShown } from './mode.js';
import { MODEL_CATALOG } from './models.js';
import { matches as etagMatches } from './mirror.js';
import { createSessionControl, promptSig, insertShown, editMode, readDraft, checkDraftBody, checkSubmitBody, checkSuggestionBody, checkDialogBody, checkSurveyBody } from './session-control.js';
import { dialogCapture, dialogOnScreen } from './dialog.js';
import { surveyOf } from './survey.js';
import { badSend } from './keys.js';
import { tagPane, pickState, claudePane, inProject } from './orchestrate.js';
import { createFit, checkFitBody, FIT_RATE } from './fit.js';
import { createScroll, checkScrollBody } from './scroll.js';
import { ID, UPLOAD_CAP, PER_MESSAGE, checkUploadBody } from './attachments.js';
import { createAttachSend, checkAttachBody, logLine } from './attach-send.js';
import { SIG } from './draft.js';

const ELIGIBILITY_TTL_MS = 1000; // pane list + live-agent snapshot, so a 4 Hz capture does not run collect() 4 times a second
const TEMPLATES_MAX = 50;
const MODES_AT_ONCE = 4; // captures in flight for GET /modes
const FIT_WINDOW_MS = 1000; // the window of the per-pane fit rate limit (FIT_RATE requests)
const COMMAND_MAX = 200; // characters of a slash command typed into Claude
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/; // C0, DEL, C1
const WINDOW_ACTIONS = ['quit', 'close', 'minimize', 'zoom-in', 'zoom-out', 'zoom-reset']; // what the shell can do to its window (contract §3, §5)
const CAP = { small: 4 * 1024, submit: 1024, settings: 16 * 1024, keys: 20 * 1024, spawn: 80 * 1024 };
// What can answer a permission prompt: Enter confirms the highlighted option, a digit picks an option, a paste may hold either,
// and Shift-Tab (BTab) can pick "allow for this session".
const answersPrompt = (b) => (Array.isArray(b.keys) && (b.keys.includes('Enter') || b.keys.includes('BTab'))) || (typeof b.text === 'string' && /[0-9]/.test(b.text)) || (b.paste !== undefined && b.paste !== null);
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
 * @param {object} o.ctx     { env, exec, tmuxBin, claudeBin, nikaArgv, claudeDir, now, started, fit (added here: the fit controller, which spawn
 *                           and appio.js use; src/fit.js), registryReadable() → Promise<boolean> (added here: the session registry was read, which
 *                           Start asks before it reads a saved orchestrator; src/orchestrate.js), findSession(id) → { agent, group } | null
 *                           (src/model.js: one session by id whatever its age, live state included; throws EINDEX when the index is unreadable),
 *                           findSessions(ids) → Map id → { agent, group } (src/model.js: ended sessions by id, ONE transcript-index walk for
 *                           all of them, no ps and no tmux; throws EINDEX) }; handed to the modules as is
 * @param {object} o.deps    { version, collect() → snapshot, listPanes() → { panes, error }, readHistory, readSubagentHistory, listPlugins, rulesState,
 *                           preview, apply, spawnAgent, startOrchestrator, mirror, keys, picker (start/status for folders, startFiles/filesStatus for the
 *                           attachment file chooser), listCommands;
 *                           window(action), the shell relay: writes one `window` line (appio.js);
 *                           appCopy { state(), install(), dismiss() } (src/appcopy.js bound to this install);
 *                           createSessionControl, a test seam for the factory in session-control.js;
 *                           createFit, the same for the factory in fit.js;
 *                           createScroll, the same for the factory in scroll.js;
 *                           attachments, the attachment store (src/attachments.js, built by appio.js: save, lookup, remove, markSent);
 *                           createAttachSend, the same seam for the factory in attach-send.js;
 *                           log(line), where the attachment lines (`nika: attachments: <code>`) go: appio's stderr, the same as the store's (default: process.stderr) }
 * @returns {(req, res, url, port) => Promise<boolean>} true when it handled the request (every /api/app/* request)
 */
export function createAppApi({ secret, ctx, deps }) {
  const secretHash = sha256(secret);
  const historyCache = {};
  let eligibility = null; // { at, promise }
  const held = new Map(); // pane id → the last mode read from its footer (shown while a prompt or dialog covers the footer)
  const vim = new Map(); // pane id → true once its mode line has shown -- INSERT -- (Claude's input is in vim mode)
  const plain = new Map(); // pane id → true once a probe `i` landed as text (Claude's input is not in vim mode); the draft route sets and drops it

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
      const e = { panes, error, live, snapshot };
      // a reused pane id starts fresh; a failed tmux list or registry read proves nothing, so one blip keeps the memory
      // (losing vim memory would let End type into a vim normal-mode input without `i` first)
      if (!error && snapshot) for (const id of [...held.keys(), ...vim.keys(), ...plain.keys()]) if (!isEligible(e, id)) { held.delete(id); vim.delete(id); plain.delete(id); }
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
  // can route typed text into a shell pane (a started `_run-agent` pane shows as `node`). A dead pane (tmux's remain-on-exit keeps
  // it, with its tags and a command that still reads as claude) never qualifies (0.5): nothing receives keys there, and its
  // screen is a stale picture; src/collect/tmux.js drops a row whose pane_dead is not exactly 0 or 1
  const isEligible = (e, id) => {
    const pane = e.panes.get(id);
    return Boolean(pane) && pane.dead !== true && CLAUDE_COMMAND.test(String(pane.command ?? '').trim()) && (e.live.has(id) || ctx.started.has(id));
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
    if (insertShown(rows)) { vim.set(id, true); plain.delete(id); }
    if (footer !== 'unknown') held.set(id, footer);
    const mode = footer !== 'unknown' ? footer : (held.get(id) ?? ctx.started.get(id)?.mode ?? 'unknown');
    const prompt = promptFromRows(rows);
    return { mode, modeConfirmed: footer !== 'unknown' || mode === 'unknown', prompt: prompt && { ...prompt, sig: promptSig(rows), bypass: bypassWindow(rows) } };
  }

  // Registry state of a pane's live agent. `{ fresh: true }`: the caller is about to act on the answer (a second Escape, an Enter), so the 1 s snapshot is dropped first.
  const registryState = async (id, o) => {
    if (o?.fresh === true) eligibility = null;
    return (await loadEligibility()).live.get(id) ?? null;
  };

  /**
   * Whether the session registry could be read (the snapshot's `sources.registry` is 'ok'), from a fresh snapshot: Start acts on the answer.
   * Without the registry no session reads live, so a live saved orchestrator would read ended and Start would resume it in a second claude.
   * A snapshot that could not be taken, or has no `sources` at all, is not readable. startOrchestrator asks it through ctx (src/orchestrate.js).
   */
  ctx.registryReadable = async () => {
    eligibility = null;
    const e = await loadEligibility().catch(() => null);
    return e?.snapshot?.sources?.registry === 'ok';
  };

  // One controller for the whole server: its per-pane lock covers mode, answer, command and End together.
  const control = (deps.createSessionControl ?? createSessionControl)({
    mirror: deps.mirror,
    keys: deps.keys,
    // a failed listing throws: it proves nothing about the pane (null would read as "gone"). A dead pane is gone too (0.5): with remain-on-exit
    // tmux keeps it listed after /exit with its command still named claude (from the pane's argv), so only pane_dead says Claude ended
    paneCommand: async (id) => {
      const { panes, error } = await deps.listPanes();
      if (error) throw new Error(error);
      const pane = panes.get(id);
      return pane && pane.dead !== true ? String(pane.command ?? '').trim() : null;
    },
    stateOf: registryState,
    vimOf: (id) => vim.get(id) === true,
    plainOf: (id) => plain.get(id) === true,
    // what the draft route learned about a pane's edit mode: vim (INSERT seen), plain (a probe `i` landed as text) or nothing known
    setEdit: (id, kind) => {
      if (kind === 'vim') { vim.set(id, true); plain.delete(id); } else if (kind === 'plain') { plain.set(id, true); vim.delete(id); } else { vim.delete(id); plain.delete(id); }
    },
    now: () => ctx.now(),
  });

  // One fit controller for the whole server (0.5, W7, ADR 0017): every tmux change it makes runs in the controller's per-pane lock.
  // spawnAgent reads it from ctx (a window is released before a split lands in it) and appio.js recovers and releases through it.
  const fit = (deps.createFit ?? createFit)({ exec: ctx.exec, tmuxBin: ctx.tmuxBin, now: () => ctx.now(), stateDir: stateDir(ctx.env), lock: control.withPaneLock });
  ctx.fit = fit;
  // The scroll controller (0.5, W3, ADR 0018): one lock with every other control action, and no key while a Stop/End interrupt runs (keyGap).
  const scroller = (deps.createScroll ?? createScroll)({ mirror: deps.mirror, keys: deps.keys, lock: control.withPaneLock, keyGap: control.keyGap, now: () => ctx.now() });
  const fitHits = new Map(); // `<METHOD> <pane id>` → timestamps of the fit requests inside the last FIT_WINDOW_MS (PUT and DELETE each have their own bucket)

  /**
   * FIT_RATE requests per method and pane per second, a sliding window like src/keys.js; buckets that went quiet are forgotten on every call.
   * DELETE has its own bucket: a page that closes right after a burst of heartbeats must still give its window back.
   */
  function fitAllowed(method, pane) {
    const id = `${method} ${pane}`;
    const t = ctx.now();
    for (const [k, v] of fitHits) {
      const recent = v.filter((ts) => ts > t - FIT_WINDOW_MS);
      if (recent.length) fitHits.set(k, recent);
      else fitHits.delete(k);
    }
    const recent = fitHits.get(id) ?? [];
    if (recent.length >= FIT_RATE) return false;
    recent.push(t);
    fitHits.set(id, recent);
    return true;
  }

  // Attachments (0.5, W2, ADR 0016): the send runs under the controller's pane lock and keys only while no Stop/End interrupt runs (keyGap).
  const attachLog = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  const attachSend = (deps.createAttachSend ?? createAttachSend)({
    mirror: deps.mirror, keys: deps.keys, store: deps.attachments, lock: control.withPaneLock, keyGap: control.keyGap,
    vimOf: (id) => vim.get(id) === true, plainOf: (id) => plain.get(id) === true, log: attachLog,
  });

  /**
   * The repository key a pane's attachments are filed under: from nika's own snapshot when exactly one live agent claims the pane,
   * else the key of a pane nika started; never from the request. null = unknown or ambiguous (two claims), the route answers 409.
   */
  async function paneKey(id) {
    const claims = [];
    for (const g of (await loadEligibility()).snapshot?.groups ?? []) for (const a of g.agents) if (a.live && a.pane?.id === id) claims.push(g.key);
    const key = claims.length === 0 ? ctx.started.get(id)?.key : claims.length === 1 ? claims[0] : null;
    return typeof key === 'string' && PROJECT_KEY.test(key) ? key : null;
  }

  // --- projects ---

  /**
   * The saved orchestrator of each of `projects` for GET /projects (contract C1): Map project key → { sessionId, state, name, pane } | null.
   * One snapshot and at most ONE transcript-index lookup for the whole request, whatever the number of projects (the page polls this every
   * 3 s): a pick the cached 24 h snapshot (shared with /modes) holds costs nothing, and a live session is always in it; the ones it
   * misses are ended or gone, and findSessions settles all of them in one walk. Each is read with pickState, the reading Start uses
   * (a session of another project reads gone, T47). null = unknown (no snapshot, the session registry could not be read, or the index could not be read): the page keeps what it had.
   */
  async function orchestrators(config, projects) {
    const picks = projects.map((p) => [p, config.perProject[p.key]?.orchestratorSessionId]).filter(([, id]) => id);
    const out = new Map();
    if (!picks.length) return out;
    const snapshot = (await loadEligibility().catch(() => null))?.snapshot;
    // without the snapshot, or with a registry that could not be read (0.5; the sessions folder is unreadable), a live session could not be told
    // from an ended one: every pick is unknown, whatever else the snapshot holds, and the index is not asked
    if (!snapshot || snapshot.sources?.registry !== 'ok') {
      for (const [p] of picks) out.set(p.key, null);
      return out;
    }
    const known = new Map();
    // a session that a background session continues (after /compact; `hostId`) has no row of its own: its pick reads as that row
    for (const group of snapshot.groups ?? []) for (const agent of group.agents) for (const id of [agent.id, agent.hostId]) if (id) known.set(id, { agent, group });
    const missing = [...new Set(picks.map(([, id]) => id).filter((id) => !known.has(id)))];
    let indexed = new Map();
    let unreadable = false;
    if (missing.length) {
      try {
        indexed = await ctx.findSessions(missing);
      } catch {
        unreadable = true;
      }
    }
    for (const [p, id] of picks) {
      const hit = known.get(id) ?? indexed.get(id) ?? null;
      // The pick is a host that a live background session of this project continues (after /compact): the host's transcript ends there and
      // the child's is the conversation, so the pick moves to the child's id (owner decision 2026-11-15; app tier only, T53). Best effort
      // and only while the saved pick is still that host id (a PUT or DELETE since this request began wins); the answer reads the child.
      const child = hit?.agent.hostId === id && hit.agent.live && inProject(hit.group, p) ? hit.agent.id : null;
      if (child) {
        try {
          if ((await getOrchestrator(p.key, ctx.env)) === id) await setOrchestrator(p.key, child, ctx.env);
        } catch {
          // nothing changes and nothing is shown; the next poll tries again
        }
      }
      out.set(p.key, !hit && unreadable ? null : pickState(p, child ?? id, hit));
    }
    return out;
  }

  async function toProject(p, orchestrator = null) {
    return { key: p.key, dir: p.dir, name: p.name, addedAt: p.addedAt ?? null, rules: await deps.rulesState(p), orchestrator };
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

  // --- the desktop window (F2): the page asks, the shell acts; the request names an action and nothing else ---

  route('POST', /^\/api\/app\/window$/, CAP.small, async ({ body }) => {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'action' || !WINDOW_ACTIONS.includes(body.action)) return err(400, 'invalid', `action must be one of ${WINDOW_ACTIONS.join(', ')}`);
    deps.window(body.action);
    return { status: 204, body: null };
  });

  route('GET', /^\/api\/app\/projects$/, 0, async () => {
    const { config } = await loadConfig(ctx.env);
    const picks = await orchestrators(config, config.projects);
    return { status: 200, body: { projects: await Promise.all(config.projects.map((p) => toProject(p, picks.get(p.key) ?? null))) } };
  });

  route('POST', /^\/api\/app\/projects\/pick$/, CAP.small, async () => {
    const reqId = deps.picker.start();
    return reqId ? { status: 202, body: { reqId } } : err(429, 'busy', 'a folder picker is already open');
  });

  route('GET', /^\/api\/app\/projects\/pick\/([^/]+)$/, 0, async ({ params }) => {
    const reqId = param(params[0], UUID);
    const st = reqId && deps.picker.status(reqId);
    if (!st) return err(404, 'not_found', 'no such picker request');
    if (st.state !== 'done') return { status: 200, body: { state: st.state } };
    const picks = await orchestrators((await loadConfig(ctx.env)).config, [st.project]); // a folder added again may already have a pick
    return { status: 200, body: { state: 'done', project: await toProject(st.project, picks.get(st.project.key) ?? null) } };
  });

  route('DELETE', /^\/api\/app\/projects\/([^/]+)$/, CAP.small, async ({ params }) => {
    const key = param(params[0], PROJECT_KEY);
    if (!key || !(await removeProject(key, ctx.env))) return err(404, 'not_found', 'project is not registered');
    return { status: 200, body: { removed: true } };
  });

  // --- the project's orchestrator (0.4): which session is it, saved by id; never a path, only a session nika itself indexed ---

  const adopting = new Set(); // project keys with a PUT in flight: one adoption at a time per project (M3)

  route('PUT', /^\/api\/app\/projects\/([^/]+)\/orchestrator$/, CAP.small, async ({ params, body }) => {
    const { project, failure } = await projectOf({ project: param(params[0], PROJECT_KEY) });
    if (failure) return failure;
    if (Object.keys(body).length !== 1 || typeof body.sessionId !== 'string' || !UUID.test(body.sessionId)) return err(400, 'invalid', 'body must be { sessionId: a session id }');
    // The checks below and the tagging read one state and act on it: two overlapping PUTs (two windows, a double click) could
    // each pass "no other orchestrator runs" and tag two panes. The second waits for nobody; it is told to try again.
    if (adopting.has(project.key)) return err(409, 'busy', "Another change to this project's orchestrator is still running. Try again.");
    adopting.add(project.key);
    try {
      return await adopt(project, body.sessionId);
    } finally {
      adopting.delete(project.key);
    }
  });

  async function adopt(project, id) {
    let found;
    try {
      found = await ctx.findSession(id);
    } catch {
      return err(503, 'index_unavailable', "nika can't read its list of sessions right now. Nothing changed.");
    }
    if (!found) return err(404, 'not_found', "nika can't find that session any more. Its transcript may have been deleted. Nothing changed.");
    const { agent, group } = found;
    // the same reading as the list and Start (pickState): another project's session is gone there, refused here
    if (pickState(project, id, found).state === 'gone') return err(409, 'other_project', "That session belongs to another project, so it can't be this project's orchestrator. Nothing changed.");
    if (agent.live && agent.role === 'agent') return err(409, 'agent_session', "That session is an agent nika started, so it can't be the orchestrator. Nothing changed.");
    if (agent.live && agent.role === 'sub-orchestrator') return err(409, 'agent_session', "That session is a sub-orchestrator nika started, so it can't be the orchestrator. Nothing changed.");
    // another main orchestrator that runs: a pane tagged orchestrator (a sub-orchestrator is tagged differently and never counts), or the saved pick while it runs
    const pick = await getOrchestrator(project.key, ctx.env);
    // a row that continues `id` (hostId, after /compact) or the pick is that session itself, not another one
    const same = (a, x) => Boolean(x) && (a.id === x || a.hostId === x); // x may be null (no pick), and so may hostId
    if (group.agents.some((a) => a.live && !same(a, id) && (a.role === 'orchestrator' || same(a, pick)))) {
      return err(409, 'orchestrator_running', "Another session is running as this project's orchestrator. End it first, then choose another. Nothing changed.");
    }
    // a live session needs a tmux pane that really runs claude: the tags go on that pane
    const pane = claudePane(agent);
    if (agent.live && !pane) return err(409, 'no_pane', "This session isn't running in tmux, so nika can't make it the orchestrator. End it, then use Resume as orchestrator.");
    try {
      await setOrchestrator(project.key, id, ctx.env);
    } catch (e) {
      if (e?.code === 'ENOENT') return err(404, 'not_found', 'project is not registered'); // removed while this request was in flight
      throw e;
    }
    if (pane) {
      await tagPane(ctx, pane.id, 'orchestrator', `${project.key}/orchestrator`, 1);
      ctx.started.set(pane.id, { key: project.key, name: 'orchestrator', sessionId: id, role: 'orchestrator' });
      eligibility = null; // the pane is eligible at once
    }
    return { status: 200, body: { orchestrator: pickState(project, id, found) } };
  }

  // forgets the id only: a live pane keeps its tags until it ends
  route('DELETE', /^\/api\/app\/projects\/([^/]+)\/orchestrator$/, CAP.small, async ({ params }) => {
    const { project, failure } = await projectOf({ project: param(params[0], PROJECT_KEY) });
    if (failure) return failure;
    try {
      await setOrchestrator(project.key, null, ctx.env);
    } catch (e) {
      if (e?.code === 'ENOENT') return err(404, 'not_found', 'project is not registered');
      throw e;
    }
    return { status: 200, body: { orchestrator: null } };
  });

  // --- settings and plugins ---

  const withoutProjects = ({ projects, ...settings }) => settings; // Settings = the config schema without `projects`

  route('GET', /^\/api\/app\/settings$/, 0, async () => ({ status: 200, body: withoutProjects((await loadConfig(ctx.env)).config) }));

  route('PUT', /^\/api\/app\/settings$/, CAP.settings, async ({ body }) => {
    if (body.permissionMode === 'bypassPermissions') return err(400, 'invalid', 'bypassPermissions is never allowed');
    try {
      return { status: 200, body: withoutProjects(await updateSettings(body, ctx.env)) };
    } catch (e) {
      if (e?.code === 'EINVAL') return err(400, 'invalid', clean(e.warnings?.[0] ?? e.message, 200) ?? 'invalid settings');
      throw e;
    }
  });

  // Per-project config (0.3.4): saved on the project page, one project at a time, so the Settings page cannot overwrite it.
  // The body is exactly one field, so the dialogs and menus never overwrite each other: { plugins }, { models } (0.4),
  // { permissionMode }, { panePlacement } or { maxAgents } (0.4.0; a value, or null for "use Settings").
  route('GET', /^\/api\/app\/projects\/([^/]+)\/config$/, 0, async ({ params }) => {
    const { project, failure } = await projectOf({ project: param(params[0], PROJECT_KEY) });
    return failure ?? { status: 200, body: await getProjectConfig(project.key, ctx.env) };
  });

  const ONE_FIELD = new Set(['models', 'permissionMode', 'panePlacement', 'maxAgents']);
  route('PUT', /^\/api\/app\/projects\/([^/]+)\/config$/, CAP.settings, async ({ params, body }) => {
    const { project, failure } = await projectOf({ project: param(params[0], PROJECT_KEY) });
    if (failure) return failure;
    if (body.permissionMode === 'bypassPermissions') return err(400, 'invalid', 'bypassPermissions is never allowed'); // constraint 12: API and store both refuse
    const only = Object.keys(body).length === 1 ? Object.keys(body)[0] : null;
    let patch = body; // for the four below: exactly that one key, its value checked by the store
    if (!ONE_FIELD.has(only)) {
      if (only !== 'plugins' || !Array.isArray(body.plugins) || !body.plugins.every((n) => typeof n === 'string')) return err(400, 'invalid', 'body must be one of { plugins: [plugin names] }, { models: {...} }, { permissionMode }, { panePlacement } or { maxAgents }');
      // a name is allowed when it is installed now or already saved for this project (so a plugin removed since can still be unticked)
      const known = new Set([...(await deps.listPlugins(ctx.claudeDir)), ...(await getProjectConfig(project.key, ctx.env)).plugins]);
      const unknown = body.plugins.find((n) => !known.has(n));
      if (unknown !== undefined) return err(400, 'invalid', `${clean(unknown, 80) ?? '?'} is not installed`);
      patch = { plugins: body.plugins };
    }
    try {
      return { status: 200, body: await updateProjectConfig(project.key, patch, ctx.env) };
    } catch (e) {
      if (e?.code === 'EINVAL') return err(400, 'invalid', clean(e.message, 200) ?? 'invalid config');
      if (e?.code === 'ENOENT') return err(404, 'not_found', 'project is not registered'); // removed while this request was in flight
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

  // 0.5, W8: a subagent's transcript, read like the session's own. The path is never in the request: the module finds the file in nika's own
  // listing of the session's subagents folder.
  route('GET', /^\/api\/app\/session\/([^/]+)\/subagents\/([^/]+)\/history$/, 0, async ({ params, query }) => {
    const id = param(params[0], UUID);
    if (!id) return err(404, 'not_found', 'no such session');
    const agentId = param(params[1], SUBAGENT_ID);
    if (!agentId) return err(404, 'not_found', 'no such subagent');
    return deps.readSubagentHistory(id, agentId, { before: query.get('before') ?? undefined, limit: query.get('limit') ?? undefined }, { claudeDir: ctx.claudeDir, cache: historyCache, now: ctx.now });
  });

  route('GET', /^\/api\/app\/pane\/([^/]+)\/capture$/, 0, async ({ params, req }) => {
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    // The mirror is asked without If-None-Match: the mode shown depends on the held map as well as on the rows, so the ETag
    // folds it in and the 304 is decided here (a changed held mode is never hidden behind a 304 on unchanged rows).
    const r = await deps.mirror.capture(id);
    if (r.status !== 200) return { status: r.status, body: r.body, headers: {} };
    const screen = readScreen(id, r.body.rows);
    // the input box (design W5): null while the screen has no plain box; `edit` is the pane's memory, so it is part of the ETag
    const parsed = readDraft(r.body);
    const draft = parsed && { ...parsed, edit: editMode(r.body.rows, vim.get(id) === true, plain.get(id) === true) };
    // the dialog on screen (design W1 3): read from the rows and the width only, so r.etag already covers it; null while a permission prompt parses
    const dialog = screen.prompt ? null : dialogCapture(r.body.rows, r.body.cols);
    // Claude's feedback survey (0.5, F14); surveyOf is null while a prompt or a dialog owns the slot. It depends on the pane's vim memory (vim NORMAL is not
    // answerable), which r.etag does not cover and the draft's `edit` cannot carry (the draft is null while the survey shows), so it is part of the ETag itself.
    const survey = surveyOf(r.body, { vim: vim.get(id) === true, insert: insertShown(r.body.rows) });
    const etag = crypto.createHash('sha256').update(JSON.stringify([r.etag, screen.mode, screen.modeConfirmed, draft?.edit ?? null, survey])).digest('hex').slice(0, 32);
    const headers = { ETag: `"${etag}"` };
    if (etagMatches(req.headers['if-none-match'], etag)) return { status: 304, body: null, headers };
    // a new object: the mirror's cached body is shared and stays as captured
    return { status: 200, body: { ...r.body, ...screen, draft, dialog, survey, etag }, headers };
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

  /**
   * The fresh look of the keys route (T26, T54): null when the request may go on, else the response that refuses it (nothing is sent). One capture,
   * never the cached one; its own failure is the answer. In order: a bypass window with a permission prompt (409 bypass-prompt) or an unreadable
   * footer (409 screen-unclear), as before. Then, only for Send's own typing (`send`): a permission prompt, any dialog or Claude's feedback survey
   * (409 prompt-open: a digit or text typed there would answer it), and an unreadable footer with no input box (409 screen-unclear, the rule `submit`
   * uses: a dialog nika does not know may be open). A passthrough request (no `send`) never gets the second group: it is the user's own keys.
   */
  async function keysLook(id, { send }) {
    const cap = await deps.mirror.capture(id, undefined, { fresh: true });
    if (cap.status !== 200) return { status: cap.status, body: cap.body };
    const rows = cap.body.rows;
    if (bypassWindow(rows)) {
      if (promptFromRows(rows) !== null) return err(409, 'bypass-prompt', 'Answer this prompt in the terminal');
      if (modeFromRows(rows) === 'unknown') return err(409, 'screen-unclear', "nika can't tell what Claude is showing; use the terminal");
    }
    if (!send) return null;
    if (promptFromRows(rows) !== null || dialogOnScreen(rows) || surveyOrFollowUpShown(rows)) return err(409, 'prompt-open', 'A prompt, a dialog or a survey is open in Claude; answer it first');
    if (modeFromRows(rows) === 'unknown' && readDraft(cap.body) === null) return err(409, 'screen-unclear', "nika can't tell what Claude is showing; use the terminal");
    return null;
  }

  route('POST', /^\/api\/app\/pane\/([^/]+)\/keys$/, CAP.keys, async ({ params, body }) => {
    const bad = badSend(body); // 400 first, as on the other routes: `send` is the boolean true or absent
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    // Enter, BTab, a digit or a paste could answer a permission prompt, and the answer route's bypass refusal does not reach
    // this route: so they look at a fresh screen first, and none is sent while a prompt mentions bypass (409 bypass-prompt) or
    // a dialog nika cannot read (its footer is unreadable) does (409 screen-unclear) (T26). Typing letters, arrows and Escape
    // stay as fast as in 0.2. The page's passthrough posts to this route too, so it is guarded as well: only the terminal itself
    // can answer such a prompt.
    // Send's own typing (`send: true`, the page's legacy text road, T54) always looks first and is also refused while a prompt, a dialog,
    // the survey or an unclear screen is up; each chunk of a long text after the first looks again (keys.js `recheck`).
    const send = body.send === true;
    if (send || answersPrompt(body)) {
      const refused = await keysLook(id, { send });
      if (refused) return refused;
    }
    const request = { text: body.text, paste: body.paste, keys: body.keys };
    return send ? deps.keys.send(id, { ...request, send: true }, { recheck: () => keysLook(id, { send }) }) : deps.keys.send(id, request);
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

  // Draft sync (0.5, W5): makes Claude's input box read the page's text. The controller does the work under the pane lock; nothing
  // of the body is logged here or there.
  route('PUT', /^\/api\/app\/pane\/([^/]+)\/draft$/, CAP.keys, async ({ params, body }) => {
    const bad = checkDraftBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.writeDraft(id, body);
  });

  // Send's Enter (0.5, W13): the one Enter of the page's Send, never the keys route. The controller presses it under the pane lock, only on a fresh screen
  // with no prompt and no dialog (and, with `base`, the box the page synced), in any registry state, and sends no other key. Nothing of the body is logged.
  route('POST', /^\/api\/app\/pane\/([^/]+)\/submit$/, CAP.submit, async ({ params, body }) => {
    const bad = checkSubmitBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.submit(id, body);
  });

  // Fit (0.5, W7): the session window asks for its panel's size, the controller zooms the pane and sizes its tmux window when that is
  // safe, and gives everything back on DELETE, a lapse or a user change. Order: body 400, pane 404, rate 429 (PUT and DELETE count apart), then the controller. Bodies and
  // layouts are never logged, here or there; the log carries only window and pane ids, step names and error codes (design 10.3). App tier only: the browser tier has no such route.
  route('PUT', /^\/api\/app\/pane\/([^/]+)\/fit$/, CAP.small, async ({ params, body }) => {
    const checked = checkFitBody(body);
    if (checked.error) return err(400, 'invalid', checked.error);
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    if (!fitAllowed('PUT', id)) return err(429, 'busy', `at most ${FIT_RATE} fit requests per second per pane`);
    return fit.hold(id, checked.value);
  });

  // Not eligibility-gated: the pane may be gone already, and the user's tmux window must still come back.
  route('DELETE', /^\/api\/app\/pane\/([^/]+)\/fit$/, CAP.small, async ({ params }) => {
    const id = param(params[0], PANE_ID);
    if (!id) return err(400, 'invalid', 'invalid pane id');
    if (!fitAllowed('DELETE', id)) return err(429, 'busy', `at most ${FIT_RATE} fit requests per second per pane`);
    return fit.release(id);
  });

  // Scroll (0.5, W3, ADR 0018): Claude's own full-screen view, by a direction and a count or an end, never a key. Order: body 400, pane 404, then the
  // controller (10 requests/s per pane 429, the lock, the screen checks, the keys). Nothing of the body is logged here or there. App tier only.
  route('POST', /^\/api\/app\/pane\/([^/]+)\/scroll$/, CAP.small, async ({ params, body }) => {
    const bad = checkScrollBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? scroller.scroll(id, body);
  });

  // Attachments (0.5, W2): upload (JSON { name, data }, base64), delete before sending, and the send that pastes the stored paths into Claude's input
  // and presses Enter. App tier only. Order: body 400, pane 404, project 409, then the store or the sender. No route serves a file back, and
  // nothing of name, data, path or id is logged: a store error is logged as its code only.
  route('POST', /^\/api\/app\/pane\/([^/]+)\/attachments$/, UPLOAD_CAP, async ({ params, body }) => {
    const bad = checkUploadBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    const key = await paneKey(id);
    if (key === null) return err(409, 'no-project', "nika can't tell this session's project");
    try {
      return await deps.attachments.save({ pane: id, key, name: body.name, data: body.data });
    } catch (e) {
      attachLog(logLine(e));
      return err(500, 'write-failed', 'write failed');
    }
  });

  // The paperclip's file chooser (0.5, W2-T6): the page never opens a file input (the webview's freezes the app on macOS). It asks, the shell opens
  // its own native dialog, the server reads what the user picked (src/appio.js, through fsafe) and hands the bytes to the store. Order: body 400,
  // pane 404, project 409, then the picker (one chooser of any kind at a time: 429). The answers hold ids, names, sizes, types and codes, never a path.
  route('POST', /^\/api\/app\/pane\/([^/]+)\/attachments\/pick$/, CAP.small, async ({ params, body }) => {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'room' || !Number.isInteger(body.room) || body.room < 1 || body.room > PER_MESSAGE) return err(400, 'invalid', `body must be { room: 1 to ${PER_MESSAGE} }`);
    const { id, failure } = await eligiblePane(params[0]);
    if (failure) return failure;
    const key = await paneKey(id);
    if (key === null) return err(409, 'no-project', "nika can't tell this session's project");
    const reqId = deps.picker.startFiles({ pane: id, key, room: body.room });
    return reqId ? { status: 202, body: { reqId } } : err(429, 'busy', 'a file chooser is already open');
  });

  // Not eligibility-gated, like the folder chooser's poll: the answer belongs to the request, and the pane may have gone while the dialog was open.
  route('GET', /^\/api\/app\/pane\/([^/]+)\/attachments\/pick\/([^/]+)$/, 0, async ({ params }) => {
    const id = param(params[0], PANE_ID);
    const reqId = param(params[1], UUID);
    const answer = id && reqId && deps.picker.filesStatus(id, reqId);
    return answer ? { status: 200, body: answer } : err(404, 'not_found', 'no such chooser request'); // unknown and another pane's read alike
  });

  // Not eligibility-gated: the pane may be gone, and the file must still go. false for an unknown, another pane's or an already sent id (no oracle).
  route('DELETE', /^\/api\/app\/pane\/([^/]+)\/attachments\/([^/]+)$/, CAP.small, async ({ params }) => {
    const id = param(params[0], PANE_ID);
    const att = param(params[1], ID);
    if (!id || !att) return err(400, 'invalid', 'invalid pane or attachment id');
    try {
      return { status: 200, body: { removed: (await deps.attachments.remove(id, att)) === true } };
    } catch (e) {
      attachLog(logLine(e));
      return { status: 200, body: { removed: false } };
    }
  });

  route('POST', /^\/api\/app\/pane\/([^/]+)\/attach-send$/, CAP.small, async ({ params, body }) => {
    const bad = checkAttachBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? attachSend.send(id, body);
  });

  // Accept Claude's prompt suggestion (0.5, W4): the page's Tab or right arrow. Not the plain keys route: a Tab that lands after the
  // suggestion vanished or a prompt opened is the same race as T51, so the controller presses it only on a fresh screen that still shows
  // exactly `text`, and presses nothing else. Nothing of the body is logged here or there.
  route('POST', /^\/api\/app\/pane\/([^/]+)\/suggestion$/, CAP.small, async ({ params, body }) => {
    const bad = checkSuggestionBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.acceptSuggestion(id, body);
  });

  // Answer Claude's question or plan dialog, one step per request, or decline it (0.5, W1). CAP.keys: a body is small, but the cap is the same
  // as the keys route's. checkDialogBody runs before the pane is looked up; nothing of the body (text, picks, sig) is logged here or in the controller.
  route('POST', /^\/api\/app\/pane\/([^/]+)\/dialog$/, CAP.keys, async ({ params, body }) => {
    const bad = checkDialogBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.answerDialog(id, body);
  });

  // Answer Claude's feedback survey with one digit (0.5, F14). Order: body 400 (exactly { n, sig }), pane 404, then the controller (the lock, the screen checks,
  // the registry, the one key). Nothing of the body (the digit or the sig) is logged here or there. App tier only: the browser tier has no such route.
  route('POST', /^\/api\/app\/pane\/([^/]+)\/survey$/, CAP.small, async ({ params, body }) => {
    const bad = checkSurveyBody(body);
    if (bad) return bad;
    const { id, failure } = await eligiblePane(params[0]);
    return failure ?? control.answerSurvey(id, { n: body.n, sig: body.sig });
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
    let applied = []; // the plugins applied to the project (nika's own saved list, never anything from the request): they come before the built-ins
    if (query.has('project')) {
      const { project, failure } = await projectOf({ project: query.get('project') });
      if (failure) return failure;
      projectDir = project.dir;
      applied = (await getProjectConfig(project.key, ctx.env)).plugins;
    }
    return { status: 200, body: { commands: await deps.listCommands({ claudeDir: ctx.claudeDir, projectDir, applied, now: ctx.now() }) } };
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
    if (r.status === 304 || r.status === 204) return send(res, r.status, '', 'application/json; charset=utf-8', r.headers);
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
