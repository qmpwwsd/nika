// App tier only (imported by app.js when api.js says isApp): environment, project list, add project, start
// orchestrator, the project view, the spawn sheet, the apply-rules dialog and remove project.
// Every privileged request goes through appFetch(); every server string is rendered through h() (textContent).
import { appFetch, applyTheme } from './api.js';
import { h, icon } from './dom.js';
import {
  $, state, hooks, RX, save, toast, announce, errText, copyText, setBusy, fieldError, openDialog, rulesEl, sessionHref, menuEl, closeMenu, syncRadioCards,
} from './ui.js';
import { parseModes, modesAfter, settingModeEl, MODE_META } from './modes.js';
import { copyBanner, copyErrorText, copyToast } from './app-copy.js';
import {
  CUSTOM, MODEL_ID, MODEL_HINT, ROLES, ROLE_LABEL, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels,
} from './models-ui.js';
import { buildGroups, agentNodes, swap, interacting, render } from './app.js';
import { DETECTED_MAX, sidebarModel, orchState, savedPick, otherRunning, roleTag, spawnLimits, effectiveAgents, resetEndedState } from './dash-model.js';
import { pluginView, pluginSave, sortIds, countText, filterNote } from './plugin-view.js';

const PERM_LABEL = {
  default: 'Claude Code default (no flag)',
  manual: 'Manual: ask every time',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto: a classifier approves actions without asking you',
  dontAsk: "Don't ask",
};
const PLACE_LABEL = { beside: 'Beside', 'under-last': 'Under the last agent' };
const BRIEF_MAX = 64 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ---------- data ---------- */
export async function loadMe() {
  const r = await appFetch('/api/app/me');
  if (r.status === 200) state.me = r.body;
  return r;
}
export async function loadProjects() {
  const r = await appFetch('/api/app/projects');
  if (r.status === 200) state.projects = r.body.projects;
  return r;
}
export async function loadSettings() {
  const r = await appFetch('/api/app/settings');
  if (r.status === 200) {
    state.settings = r.body;
    applyTheme(r.body.ui?.theme);
  }
  return r;
}

/** The installed plugin names, so the Project setup card can flag a saved plugin that is gone. A failed load leaves state.plugins as it was. */
async function loadInstalled() {
  try {
    const r = await appFetch('/api/app/plugins');
    if (r.status === 200 && Array.isArray(r.body?.plugins)) state.plugins = r.body.plugins;
  } catch {
    // the card then flags nothing
  }
}

/** The model catalog for the pickers. A failed load leaves state.models as it was (null): the pickers then offer only Custom ID. */
export async function loadModels() {
  const r = await appFetch('/api/app/models');
  if (r.status === 200 && Array.isArray(r.body?.models)) state.models = r.body.models;
  return r;
}

let modesBusy = false;
/**
 * GET /api/app/modes (the mode tags and the End item of every row), at the poll loop's pace, one request at a time. Not awaited by
 * pollApp: a slow tmux must not hold the list back. A failed or hung poll goes through modesAfter (old tags stay one more cycle).
 */
function pollModes() {
  if (modesBusy) return;
  modesBusy = true;
  const ctl = new AbortController(); // AbortSignal.timeout() is missing in older macOS web views
  const timer = setTimeout(() => ctl.abort(), 4000);
  appFetch('/api/app/modes', { signal: ctl.signal })
    .then((r) => (r.status === 200 ? parseModes(r.body) : null))
    .catch(() => null)
    .then((map) => {
      clearTimeout(timer);
      modesBusy = false;
      const before = JSON.stringify(state.modes.map);
      state.modes = modesAfter(state.modes, map);
      if (JSON.stringify(state.modes.map) !== before) render();
    });
}

let tick = 0;
/** Called by the poll loop next to /api/agents; never rejects (the agents request reports connectivity). */
async function pollApp() {
  pollModes();
  try {
    const results = await Promise.all([loadProjects(), tick++ % 10 === 0 ? loadMe() : null]);
    state.appError = results.some((r) => r?.status === 403);
  } catch {
    // network trouble shows up through the /api/agents request
  }
}

/** Reason an action that needs only the server is off right now, or null. */
const offlineReason = () => (state.error ? 'Offline. nika is reconnecting.' : null);

/** Reason the privileged actions are off right now, or null. */
function blockedReason() {
  if (offlineReason()) return offlineReason();
  if (state.me?.tmux === false) return 'Needs tmux. Install it, then check again.';
  if (state.me?.claude === false) return 'Needs Claude Code (claude) on your PATH.';
  return null;
}

/* ---------- limits (design 0.4 section 2.4): the page counts from its snapshot, the server's count is the one that decides ---------- */
const LIMIT_TAIL = 'Wait for one to finish, or raise “Agents per orchestrator” in Settings.';
const LIMIT_TAIL_OWN = 'Wait for one to finish, or raise “Per orchestrator” on this project’s New agents card.'; // the project sets its own limit: Settings would not help

/** The counts for a spawn under the pane `parentPane` (null = you): `{ max, parent: { running, max }, project: { running, cap } }`; `max` is the project's own limit, else Settings'. */
function limitsOf(g, parentPane) {
  const max = effectiveAgents(state.settings, g.project?.key).maxAgents;
  return { max, ...spawnLimits(g, parentPane, max) };
}

/** True when the project of group `g` sets its own agent limit (so the limit copy points at its card, not at Settings). */
const ownLimit = (g) => state.settings?.perProject?.[g.project?.key]?.maxAgents !== undefined;

/** The fixed copy of a limit, by scope; used for a disabled opener and for the server's 409 `limit`. `parent` = the parent's name, or null for "you". `own`: the project sets its own limit. */
function limitCopy({ scope, parent, project, running, max, own = false }) {
  if (scope === 'project') return `${project} already runs ${running} of ${max} agents, the most one project can run. Wait for one to finish.`;
  const tail = own ? LIMIT_TAIL_OWN : LIMIT_TAIL;
  return parent
    ? `${parent} already runs ${running} of ${max} agents of its own. ${tail}`
    : `You already run ${running} of ${max} agents spawned from nika in ${project}. ${tail}`;
}

/** Why no spawn can start under `parent` (an agent row, or null for you) right now, or null: the parent's limit, then the project's. */
function limitReason(g, parent) {
  const l = limitsOf(g, parent?.pane?.id ?? null);
  const project = trunc(g.label, 40);
  if (l.parent.running >= l.parent.max) return limitCopy({ scope: 'parent', parent: parent && trunc(parent.name, 40), project, running: l.parent.running, max: l.parent.max, own: ownLimit(g) });
  if (l.project.running >= l.project.cap) return limitCopy({ scope: 'project', project, running: l.project.running, max: l.project.cap });
  return null;
}

/** The main orchestrator the project's sub-orchestrators run under: `{ id, name, role, pane }` or null (it needs a live session with a pane). */
function mainOrchestrator(g) {
  const st = g.project ? orchState(g.project, g) : null;
  return st?.kind === 'live' && st.pane ? { id: st.id, name: st.name ?? 'the orchestrator', role: 'orchestrator', pane: { id: st.pane } } : null;
}

/* ---------- sidebar and environment ---------- */
/** One sidebar row's link: initials, name and the attention or live count (shared by the project list and the Detected list). */
function sideLink(attrs, r) {
  return h('a', attrs,
    h('span', { class: 'mono-av', 'aria-hidden': 'true', text: r.name.split(/[-_ .]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?' }),
    h('span', { class: 'label', text: r.name }),
    r.attn ? h('span', { class: 'cnt', 'data-s': 'attn' }, h('span', { class: 'sr-only', text: ', needs you: ' }), String(r.attn))
      : r.live ? h('span', { class: 'cnt' }, h('span', { class: 'sr-only', text: ', live agents: ' }), String(r.live)) : null);
}

/** A Detected row opens the dashboard and puts focus on that repository's group heading (focus scrolls it into view). */
function showGroup(key) {
  const focus = () => document.getElementById(`g-${key}`)?.focus();
  if (state.route.name === 'dashboard') {
    focus();
    return;
  }
  window.addEventListener('hashchange', focus, { once: true }); // after the router has drawn the dashboard
  location.hash = '#dashboard';
}

let sideSig = '';
function renderSide() {
  const { empty, rows, detected, detectedMore } = sidebarModel({ projects: state.projects, groups: buildGroups(), showAll: state.expanded.has('detected') });
  const cur = state.route.name === 'project' ? state.route.key : '';
  const env = [state.me?.tmux, state.me?.claude, state.me?.version];
  const sig = JSON.stringify([rows, detected, detectedMore, cur, env]);
  if (sig === sideSig) return;
  sideSig = sig;
  // the count as the row's link is read to a screen reader, and so in its tooltip (the rail shows only the badge): ", needs you: 2", ", live agents: 1" or nothing
  const sideCount = (r) => (r.attn ? `, needs you: ${r.attn}` : r.live ? `, live agents: ${r.live}` : '');
  swap($('#side-projects'), rows.map((r) => h('li', null,
    sideLink({ href: `#project/${r.key}`, 'data-fk': `side:${r.key}`, title: `${r.name}${sideCount(r)}`, 'aria-current': r.key === cur ? 'page' : null }, r))));
  $('#side-projects').hidden = empty;
  $('#side-hint').hidden = !empty;
  swap($('#side-detected'), [
    detected.map((r) => h('li', { class: 'has-act' },
      sideLink({ href: '#dashboard', 'data-fk': `det:${r.key}`, title: `Show ${r.name} on the dashboard${sideCount(r)}`, onclick: (e) => { e.preventDefault(); showGroup(r.key); } }, r),
      h('button', { type: 'button', class: 'btn icon ghost', 'data-fk': `detadd:${r.key}`, 'aria-label': `Add ${r.name} as a project`, title: `Add ${r.name} as a project`, onclick: () => addProject() }, icon('plus')))),
    detectedMore ? h('li', { class: 'side-more' }, h('button', {
      type: 'button', class: 'btn ghost', 'data-fk': 'det-more', 'aria-label': `Show ${detectedMore} more detected ${detectedMore === 1 ? 'repository' : 'repositories'}`, text: `${detectedMore} more`,
      onclick: () => { state.expanded.add('detected'); renderSide(); $(`#side-detected li:nth-child(${DETECTED_MAX + 1}) a`)?.focus(); }, // focus: the first row that was behind the button
    })) : null,
  ]);
  $('#side-det').hidden = !detected.length;
  const me = state.me;
  $('#brand-ver').textContent = me?.version ? me.version.split('.').slice(0, 2).join('.') : '';
  const envWord = (name, ok) => `${name} ${ok ? 'ready' : 'missing'}`; // the rail shows only the dot: the title says which one it is
  swap($('#env'), me ? [
    h('span', { class: me.tmux ? 'env-ok' : 'env-bad', title: envWord('tmux', me.tmux) }, h('span', { class: 'long', text: envWord('tmux', me.tmux) })),
    h('span', { class: me.claude ? 'env-ok' : 'env-bad', title: envWord('claude', me.claude) }, h('span', { class: 'long', text: envWord('claude', me.claude) })),
    h('span', { class: 'long', text: `nika ${me.version} · app` }),
  ] : []);
}

/* ---------- add project (native folder picker in the shell) ---------- */
let picking = false;
async function addProject() {
  if (picking) {
    toast('A folder picker is already open. Finish or cancel it first.', { kind: 'error' });
    return;
  }
  picking = true;
  const wait = toast('Choose a folder in the system dialog…', { ms: 0, spin: true });
  try {
    const start = await appFetch('/api/app/projects/pick', { method: 'POST', json: {} });
    if (start.status === 429) {
      toast('A folder picker is already open. Finish or cancel it first.', { kind: 'error' });
      return;
    }
    if (start.status !== 202) {
      toast(errText(start), { kind: 'error' });
      return;
    }
    for (;;) {
      await sleep(500);
      const r = await appFetch(`/api/app/projects/pick/${encodeURIComponent(start.body.reqId)}`);
      if (r.status === 404) {
        toast('The folder picker closed. Nothing was added.');
        return;
      }
      if (r.status !== 200) {
        toast(errText(r), { kind: 'error' });
        return;
      }
      if (r.body.state === 'pending') continue;
      if (r.body.state === 'cancelled') {
        toast('No folder chosen. Nothing was added.');
        return;
      }
      const p = r.body.project;
      await pollApp();
      render(true);
      const fresh = p.rules?.state !== 'nika';
      toast(`Added ${p.name}.${fresh ? ' Its rules are not set up yet.' : ''}`, fresh ? { action: { label: 'Apply rules', run: () => openRules(p) } } : {});
      return;
    }
  } catch {
    toast('Could not reach the nika server.', { kind: 'error' });
  } finally {
    wait.remove();
    picking = false;
  }
}

/* ---------- the orchestrator: start, resume, pick (docs/design/spec.md 3.16) ---------- */
let starting = false; // Start / Resume runs
let orchBusy = false; // Set / Stop using runs
const savedName = (name) => (name ? trunc(name, 40) : 'the saved session');
const NO_TMUX_ORCH = "This session isn't running in tmux, so nika can't make it the orchestrator. End it, then use Resume as orchestrator.";
const runningText = (other) => `${other?.name ? trunc(other.name, 40) : 'Another session'} is running as this project's orchestrator. End it first, then choose another.`;
const PICK_ERRORS = {
  not_found: "nika can't find that session any more. Its transcript may have been deleted. Nothing changed.",
  other_project: "That session belongs to another project, so it can't be this project's orchestrator. Nothing changed.",
  no_pane: NO_TMUX_ORCH,
};

/** Fixed copy by error code (design 1.5); anything else is the server's own message. `other` = who runs, for orchestrator_running. */
function pickError(r, other) {
  const code = r?.body?.error;
  if (r?.status === 409 && code === 'orchestrator_running') return runningText(other);
  if (typeof code === 'string' && Object.hasOwn(PICK_ERRORS, code)) return PICK_ERRORS[code];
  return errText(r);
}

const CLAUDE_EXITED = 'Claude exited right after it started. Run `claude` once in a terminal in this folder to see why (for example, to log in).';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A resumed session that claude ended at once: the same `--resume` shows why (the server names the id it resumed). */
const resumeExited = (id) => `Claude exited right after it started. Run \`claude --resume ${id}\` in a terminal in this folder to see why.`;
const LAUNCH_TOAST_MS = 10000; // these sentences name the next step: longer than a toast's usual 4 s

/**
 * The sentence, with the next step, for a Start, Resume or spawn that tmux or claude stopped (contract §3), chosen by code and not by
 * the server's wording; null for any other failure (the server's own message then applies).
 */
function launchError(r) {
  const b = r?.body;
  if (b?.error === 'tmux_unavailable') return 'tmux not found. Install tmux 3.2 or newer, then try again.';
  if (b?.error === 'tmux_failed') {
    const why = String(b.message ?? '').replace(/^tmux failed:\s*/, '').trim();
    return why ? `tmux failed: ${why}` : 'tmux failed';
  }
  if (b?.error !== 'claude_exited') return null;
  return typeof b.resume === 'string' && SESSION_ID.test(b.resume) ? resumeExited(b.resume) : CLAUDE_EXITED;
}

/**
 * Start a new orchestrator, or (`resume`) resume the saved one: the server decides from the saved id (POST orchestrator/start).
 * `resume` = { name } only words the toasts. `save` = { id, other } saves that session as the orchestrator first (a row's
 * "Resume as orchestrator" on a session that is not the saved one yet); when the start then fails the pick stays, and the toast says so.
 */
async function startOrchestrator(project, { resume = null, save = null } = {}) {
  if (starting || orchBusy) return;
  starting = true;
  const who = savedName(resume?.name);
  const wait = toast(resume ? `Resuming ${who} as the orchestrator for ${project.name}…` : `Starting the orchestrator for ${project.name}…`, { ms: 0, spin: true });
  try {
    if (save) {
      const put = await appFetch(`/api/app/projects/${encodeURIComponent(project.key)}/orchestrator`, { method: 'PUT', json: { sessionId: save.id } });
      if (put.status !== 200) {
        toast(pickError(put, save.other), { kind: 'error' });
        return;
      }
    }
    const r = await appFetch('/api/app/orchestrator/start', { method: 'POST', json: { project: project.key } });
    if (r.status !== 200) {
      const launch = launchError(r);
      const why = launch ?? errText(r);
      toast(save ? `${who} is saved as the orchestrator, but it didn't start: ${why} Try Resume orchestrator in the header.` : why, { kind: 'error', ...(launch ? { ms: LAUNCH_TOAST_MS } : {}) });
      if (save) {
        await pollApp();
        render(true);
      }
      return;
    }
    const gone = r.body.cleared === 'gone';
    const created = r.body.created !== false; // false: an orchestrator was already running and was opened
    const link = sessionHref({ session: r.body.sessionId, pane: r.body.pane, project: project.key });
    // This page is about to go, so a toast here would die with it: the session window shows the notice, asked for with a fixed token (never text).
    const href = link && gone ? `${link}&notice=${created ? 'pick-gone' : 'pick-gone-open'}` : link;
    if (gone && !href) toast(created ? 'Started a new orchestrator. The saved one was gone.' : 'The saved orchestrator was gone. Opened the one that is running.');
    if (href) {
      location.href = href;
      return;
    }
    if (!gone) toast(resume ? `Resumed ${who} as the orchestrator for ${project.name}.` : `Started the orchestrator for ${project.name}.`);
    await pollApp();
    render(true);
  } catch {
    toast('Could not reach the nika server.', { kind: 'error' });
  } finally {
    wait.remove();
    starting = false;
  }
}

/** Set a session as the project's orchestrator (PUT). A live one is tagged by the server; an ended one is only remembered. */
async function setPick(a, g) {
  if (orchBusy || starting) return;
  orchBusy = true;
  const project = g.project;
  const before = savedPick(project);
  const wait = toast('Saving…', { ms: 0, spin: true });
  try {
    const r = await appFetch(`/api/app/projects/${encodeURIComponent(project.key)}/orchestrator`, { method: 'PUT', json: { sessionId: a.id } });
    if (r.status !== 200) {
      toast(pickError(r, otherRunning(g, before?.id, a.id)), { kind: 'error' });
      return;
    }
    const name = savedName(a.name);
    const was = before && before.id !== a.id ? ` (was ${savedName(before.name)})` : '';
    const reply = r.body?.orchestrator?.state;
    const live = reply === 'live' || reply === 'ended' ? reply === 'live' : a.live === true;
    if (live) {
      const href = sessionHref({ session: a.id, pane: r.body?.orchestrator?.pane ?? a.pane?.id, project: project.key });
      toast(`${name} is now the orchestrator for ${project.name}${was}.`, href ? { action: { label: 'Open', run: () => { location.href = href; } } } : {});
    } else {
      toast(`${name} is the orchestrator for ${project.name}${was}. Resume it from the header when you need it.`, { action: { label: 'Resume now', run: () => startOrchestrator(project, { resume: { name: a.name } }) } });
    }
    await pollApp();
    render(true);
  } catch {
    toast('Could not reach the nika server.', { kind: 'error' });
  } finally {
    wait.remove();
    orchBusy = false;
  }
}

/** Forget the saved orchestrator's id (DELETE). A pane that still runs keeps its tags until it ends. */
async function forgetPick(project, pick, { fromAlert = false } = {}) {
  if (orchBusy || starting) return;
  orchBusy = true;
  const wait = toast('Saving…', { ms: 0, spin: true });
  try {
    const r = await appFetch(`/api/app/projects/${encodeURIComponent(project.key)}/orchestrator`, { method: 'DELETE' });
    if (r.status !== 200) {
      toast(errText(r), { kind: 'error' });
      return;
    }
    toast(pick?.state === 'live'
      ? `${savedName(pick.name)} is no longer the saved orchestrator. It keeps running until you end it.`
      : `${project.name} has no saved orchestrator now. Start orchestrator starts a new one.`);
    await pollApp();
    render(true);
    if (fromAlert) $('#proj-h')?.focus(); // the alert that held focus is gone
  } catch {
    toast('Could not reach the nika server.', { kind: 'error' });
  } finally {
    wait.remove();
    orchBusy = false;
  }
}

/**
 * The orchestrator items of a session's row menu (app tier; hooks.rowItems, called by app.js rowEl), design 1.2:
 * Set as orchestrator, Resume as orchestrator, Stop using as orchestrator. A live nika agent or sub-orchestrator gets none.
 */
function rowItems(a, g, scope) {
  if (!g.project) return [];
  const fk = (k) => `${k}:${scope}:${a.id}`;
  const items = a.live && a.role != null && a.role !== 'orchestrator' ? [] : pickItems(a, g, fk);
  // spawn items (design 1.2): a running orchestrator or sub-orchestrator can parent agents, only the main one sub-orchestrators
  if (a.live && a.pane?.id && (a.role === 'orchestrator' || a.role === 'sub-orchestrator')) {
    const why = blockedReason() ?? limitReason(g, a);
    const name = trunc(a.name, 40);
    const spawn = [{ text: `Spawn agent under ${name}…`, fk: fk('spawn-under'), reason: why, run: () => openSpawn(g, { parent: a, role: 'agent' }) }];
    if (a.role === 'orchestrator') spawn.push({ text: `Spawn sub-orchestrator under ${name}…`, fk: fk('spawn-sub'), reason: why, run: () => openSpawn(g, { parent: a, role: 'orchestrator' }) });
    if (items.length) spawn[0].group = true;
    items.push(...spawn);
  }
  return items;
}

/** Set, Resume and Stop using for a row (design 1.2); a live nika agent or sub-orchestrator gets none (the caller checks). */
function pickItems(a, g, fk) {
  const project = g.project;
  const pick = savedPick(project);
  const isPick = pick?.id === a.id;
  const other = otherRunning(g, pick?.id, a.id); // R1
  const r1 = other ? runningText(other) : null;
  const items = [];
  if (!isPick) {
    items.push({
      text: 'Set as orchestrator', fk: fk('orch-set'), run: () => setPick(a, g),
      reason: (a.live ? blockedReason() : offlineReason()) ?? r1 ?? (a.live && !a.pane ? NO_TMUX_ORCH : null),
    });
  }
  if (!a.live) {
    items.push({
      text: 'Resume as orchestrator', fk: fk('orch-resume'), reason: blockedReason() ?? r1,
      run: () => startOrchestrator(project, { resume: { name: a.name }, save: isPick ? null : { id: a.id, other } }),
    });
  }
  if (isPick) items.push({ text: 'Stop using as orchestrator', fk: fk('orch-stop'), reason: offlineReason(), run: () => forgetPick(project, pick) });
  return items;
}

/* ---------- group actions (dashboard group header, empty box, project header) ---------- */
function act(label, iconName, run, { primary = false, fk, reason = null, title = null } = {}) {
  const why = blockedReason() ?? reason;
  return h('button', {
    type: 'button', class: `btn${primary ? ' primary' : ''}`, 'data-fk': fk, 'aria-disabled': why ? 'true' : null, title: why ?? title ?? label,
    onclick: (e) => (why ? toast(why, { kind: 'error' }) : run(e.currentTarget)),
  }, icon(iconName), h('span', { class: 'lbl', text: label }));
}

/** primary: true = "Start orchestrator" is the primary button, 'spawn' = "Spawn agent" is. `sub`: add Spawn sub-orchestrator (the project page's header only). */
function groupActions(g, { primary = false, sub = false } = {}) {
  if (!g.project) {
    return [h('button', { type: 'button', class: 'btn', 'data-fk': `add:${g.key}`, title: 'Add project', onclick: () => addProject() }, icon('plus'), h('span', { class: 'lbl', text: 'Add project' }))]; // the label is hidden below 900 px: the title is the tooltip
  }
  const st = orchState(g.project, g);
  const key = g.project.key;
  const href = st.kind === 'live' ? sessionHref({ session: st.id, pane: st.pane, project: key }) : null;
  return [
    href
      ? h('a', { class: 'btn', href, 'data-fk': `orch:${g.key}`, title: st.name ? `Open ${trunc(st.name, 40)}` : 'Open orchestrator' }, icon('term'), h('span', { class: 'lbl', text: 'Open orchestrator' }))
      : st.kind === 'ended'
        ? act('Resume orchestrator', 'resume', () => startOrchestrator(g.project, { resume: { name: st.name } }), { primary: primary === true, fk: `resume:${g.key}`, title: `Resume ${savedName(st.name)} in tmux` })
        : act('Start orchestrator', 'play', () => startOrchestrator(g.project), {
          primary: primary === true, fk: `start:${g.key}`, title: st.kind === 'gone' ? 'The saved orchestrator is gone. Starts a new one.' : null,
        }),
    act('Spawn agent', 'spawn', () => openSpawn(g), { primary: primary === 'spawn', fk: `spawn:${g.key}`, reason: limitReason(g, null) }),
    ...(sub ? [subButton(g)] : []),
  ];
}

/** The header's Spawn sub-orchestrator (design 2.3): it runs under the main orchestrator, so it is off without one. Icon only below 760 px, so the name is an aria-label. */
function subButton(g) {
  const main = mainOrchestrator(g);
  const btn = act('Spawn sub-orchestrator', 'sub-spawn', () => openSpawn(g, { parent: main, role: 'orchestrator' }), {
    fk: `spawn-sub:${g.key}`, reason: main ? limitReason(g, main) : 'Start the orchestrator first: sub-orchestrators run under it.',
  });
  btn.setAttribute('aria-label', 'Spawn sub-orchestrator');
  return btn;
}

/* ---------- project view ---------- */
const RULE_TEXT = {
  nika: 'rules/orchestration.md matches the current template.',
  outdated: 'Written from an older template, or CLAUDE.md or AGENTS.md lacks the rules line. Update rules to bring it current.',
  foreign: 'rules/orchestration.md exists but nika did not write it. Applying replaces it after you confirm; a backup is kept.',
  none: 'This project has no rules/orchestration.md yet. Agents start without orchestration rules.',
};

let projSig = '';
function renderProject(force) {
  const key = state.route.key;
  const p = state.projects?.find((x) => x.key === key) ?? null;
  const g = buildGroups().find((x) => x.project?.key === key) ?? null;
  const sig = JSON.stringify([p, g?.agents, state.modes.map, state.settings, state.plugins, state.models, state.me?.tmux, state.me?.claude, state.error, state.showEndedProject, [...state.open], [...state.expanded], key]);
  if (!force && (sig === projSig || interacting())) return;
  projSig = sig;
  const body = $('#proj-body');
  if (!state.projects) return;
  body.setAttribute('aria-busy', 'false');
  if (!p || !g) {
    $('#proj-h').textContent = 'Project not found';
    $('#proj-h').removeAttribute('title');
    $('#proj-ended-wrap').hidden = true; // nothing to show
    document.title = 'Project not found · nika';
    swap($('#proj-rules'), []);
    swap($('#proj-actions'), []);
    swap($('#proj-settings'), []);
    swap($('#proj-setup'), []);
    swap($('#su-body'), []);
    swap($('#proj-agents'), [h('div', { class: 'empty' }, h('h2', { text: 'This project is not registered' }), h('p', { text: 'It may have been removed. Add it again from the dashboard.' }), h('a', { class: 'btn', href: '#dashboard', text: 'Back to the dashboard' }))]);
    return;
  }
  $('#proj-h').textContent = p.name;
  $('#proj-h').title = p.name;
  $('#proj-ended-wrap').hidden = false;
  document.title = `${p.name} · nika`;
  swap($('#proj-rules'), [rulesEl(p.rules?.state)]);
  const pick = savedPick(p);
  swap($('#proj-settings'), [setupButton(g)]); // the title row, right before Show ended; app.css shows it up to 1030 px
  swap($('#proj-actions'), [
    ...groupActions(g, { primary: 'spawn', sub: true }),
    menuEl(`More actions for ${p.name}`, [
      { text: 'Copy folder path', run: () => copyText(p.dir, 'folder path') },
      ...(pick ? [{
        text: pick.state === 'gone' ? 'Stop using the saved orchestrator' : `Stop using ${savedName(pick.name)} as orchestrator`,
        fk: 'orch-stop-proj', reason: offlineReason(), run: () => forgetPick(p, pick),
      }] : []),
      { text: 'Remove from nika…', run: () => confirmRemove(p) },
    ], 'proj-menu'),
  ]);
  swap($('#proj-agents'), [...(orchState(p, g).kind === 'gone' ? [goneAlert(p, pick)] : []), ...agentNodes(g, '', `pv:${key}`, { showEnded: state.showEndedProject === true })]);
  placeSetup(p, g);
}

/* ---------- Settings drawer (0.4.0): up to 1030 px wide the cards live in a drawer that the title row's Settings button opens ---------- */
const NARROW = '(max-width: 1030px)'; // the stylesheet's query: app.css hides #proj-setup and shows the Settings button under it
const isNarrow = () => window.matchMedia?.(NARROW)?.matches === true;
/** A click handler that puts focus on the button first: some web views do not focus a clicked button, and a dialog it opens gives focus back to the element that had it. */
const focusing = (run) => (e) => { e?.currentTarget?.focus?.(); run(); };
/** Options for a dialog opened from a card: it stacks on the open drawer instead of closing it. */
const overSetup = () => ({ keep: $('#dlg-setup') });

/** The data-fk of the control that has focus inside `host` ('' when it has none), or null when the focus is elsewhere. */
function focusKey(host) {
  const el = document.activeElement; // null when nothing has the focus
  return el && host.contains(el) ? el.dataset.fk ?? '' : null;
}

/**
 * Puts the focus back after a flip emptied the home that held it: on the same card control when its new home is on screen (the
 * column), else on the Settings button (the drawer is closed and a resize does not open it), else on the project heading.
 */
function landFocus(fk, key) {
  const target = isNarrow() ? $(`[data-fk="setup:${key}"]`) : fk && $(`[data-fk="${CSS.escape(fk)}"]`, $('#proj-setup'));
  (target || $('#proj-h'))?.focus();
}

/** The cards have one home: the drawer's body when narrow, the page column otherwise. Never both, so no id appears twice. */
function placeSetup(p, g) {
  const narrow = isNarrow();
  const from = $(narrow ? '#proj-setup' : '#su-body'); // the home that is emptied
  const fk = focusKey(from); // not null: the window crossed 1030 px under a focused card control (in any other render the focus is in the new home, which swap keeps)
  $('#su-d').textContent = p.name;
  swap($(narrow ? '#su-body' : '#proj-setup'), setupCards(p, g));
  swap(from, []);
  if (fk !== null) landFocus(fk, g.key);
}

function openSetup() {
  openDialog($('#dlg-setup'));
  $('#su-body').scrollTop = 0; // a drawer that was scrolled last time starts at its first card
}

/** The word stays at every width (no .lbl for a breakpoint to hide), so it is the accessible name as well: no aria-label, no tooltip. */
function setupButton(g) {
  return h('button', {
    type: 'button', class: 'btn setup-open', 'data-fk': `setup:${g.key}`, 'aria-haspopup': 'dialog', 'aria-controls': 'dlg-setup', onclick: focusing(openSetup),
  }, icon('gear'), 'Settings');
}

/** Backdrop click, hash change and the window crossing 1030 px (matchMedia is missing in old web views and in the test rigs: then the page is wide). */
function wireSetup() {
  const dlg = $('#dlg-setup');
  let down = null; // where the press began: a drag that ends on the backdrop (a text selection) is not a click on it
  dlg.addEventListener('pointerdown', (e) => { down = e.target; });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && down === dlg) dlg.close();
    down = null;
  });
  // Esc: an open value menu is the innermost layer, so it closes first and the drawer stays. The key is stopped at keydown (no close request
  // starts), and `cancel` covers focus outside the drawer and a web view that sends it after a prevented keydown (as plugFilterKey does).
  let swallow = false;
  const closeOpenMenu = (e) => {
    const m = $('.menu:not([hidden])', dlg);
    if (!m) return false;
    e.preventDefault();
    closeMenu(m);
    return true;
  };
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !closeOpenMenu(e)) return;
    swallow = true;
    setTimeout(() => { swallow = false; }, 0);
  });
  dlg.addEventListener('cancel', (e) => {
    if (swallow) e.preventDefault();
    else closeOpenMenu(e);
  });
  window.addEventListener('hashchange', () => { if (dlg.open) dlg.close(); }); // the Settings link in a card, or a way back
  window.matchMedia?.(NARROW)?.addEventListener?.('change', () => {
    const grew = dlg.open && !isNarrow();
    const fk = grew ? focusKey($('#su-body')) : null; // read before the close below takes the focus away
    if (grew) dlg.close(); // the cards go back to the column, and the Settings button is hidden again
    if (state.route.name === 'project') renderProject(true);
    if (grew) landFocus(fk ?? '', state.route.key); // the opener is hidden now: the card control that had the focus, else the heading
  });
}

/** The project page's alert for a saved orchestrator whose transcript is gone (design 1.4): state, not an event, so no role="alert". */
function goneAlert(p, pick) {
  return h('div', { class: 'alert', 'data-kind': 'warn', 'data-fk': 'orch-gone' },
    icon('warn'),
    h('p', { text: "The saved orchestrator is gone: its transcript was deleted, so it can't be resumed. Start orchestrator starts a new one." }),
    h('button', { type: 'button', class: 'btn link', 'data-fk': 'orch-forget', text: 'Stop using it', onclick: () => forgetPick(p, pick, { fromAlert: true }) }));
}

const CHIPS_MAX = 8;

/** The card's note once a limit is reached (design 2.5): the project's cap first, else the agents you spawn from nika. */
function limitNote(lim) {
  const text = lim.project.running >= lim.project.cap
    ? `Limit reached: ${lim.project.running} of ${lim.project.cap} agents are running in this project. Spawning is off until one ends.`
    : lim.parent.running >= lim.max
      ? `Limit reached: you run ${lim.parent.running} of ${lim.max} agents spawned from nika. Spawn from an orchestrator's row, or wait for one to end.`
      : null;
  return text ? h('p', { class: 'limit', id: 'limit-note' }, icon('warn'), h('span', { text })) : null;
}

/* ---------- New agents: this project's permission mode, pane and agent limit, or "Use Settings" (0.4.0) ---------- */
const modeWord = (m) => (Object.hasOwn(MODE_META, m) ? MODE_META[m].label : MODE_META.unknown.label);
// PERM_LABEL has every mode Settings can hold and never the bypass mode, so no menu can offer it
const AGENT_ITEMS = {
  permissionMode: { label: 'Permission mode', choices: Object.keys(PERM_LABEL), word: (m) => (m === 'default' ? 'Default' : modeWord(m)) },
  panePlacement: { label: 'Pane', choices: Object.keys(PLACE_LABEL), word: (v) => PLACE_LABEL[v] ?? v },
  maxAgents: { label: 'Per orchestrator', choices: [1, 2, 3, 4, 5, 6, 7, 8], word: (n) => `${n} at once` },
};
const settingsValue = (s, field) => (field === 'maxAgents' ? s.limits?.maxAgents ?? 3 : s[field]);
const agentSaving = new Set(); // "<project key>:<field>" of the saves on the way: a second pick of the same item is ignored until the first answers

/** One New agents value: a menu button with the current value, and "from Settings" after it while the project has no value of its own. */
function agentItemEl(p, field, s, mine) {
  const it = AGENT_ITEMS[field];
  const inherited = mine[field] === undefined;
  const fallback = settingsValue(s, field);
  const now = inherited ? fallback : mine[field];
  const label = `${it.label} for ${trunc(p.name, 40)}: ${it.word(now)}, ${inherited ? 'from Settings' : 'set for this project'}`;
  // a mode is always shown as its own chip (colour, icon, word), in the menu as on the button; the words read the same either way
  const chip = field === 'permissionMode' ? (v) => settingModeEl(v) : null;
  // a mode whose long label says more than its word (Default, Manual, and Auto's classifier warning) carries it as the item's tooltip, as in the spawn sheet
  const tip = (m) => (chip && Object.hasOwn(PERM_LABEL, m) && PERM_LABEL[m] !== it.word(m) ? PERM_LABEL[m] : undefined);
  const items = [
    { text: chip ? `Use Settings: ${it.word(fallback)}` : `Use Settings (${it.word(fallback)})`, content: chip ? ['Use Settings', h('span', { class: 'sr-only', text: ': ' }), chip(fallback)] : undefined, title: tip(fallback), current: inherited, fk: `agent-${field}:settings`, run: () => saveAgentItem(p, field, null) },
    ...it.choices.map((c, i) => ({ text: it.word(c), content: chip ? chip(c) : undefined, title: tip(c), current: !inherited && mine[field] === c, group: i === 0, fk: `agent-${field}:${c}`, run: () => saveAgentItem(p, field, c) })),
  ];
  return [
    menuEl(label, items, `agent-${field}`, [field === 'permissionMode' ? settingModeEl(now) : it.word(now), icon('chev')]),
    inherited ? h('span', { class: 'muted from-set', text: 'from Settings' }) : null,
  ];
}

/** Saves one field (a value, or null for "Use Settings"); a refusal or a lost connection is an error toast and the old value stays. */
async function saveAgentItem(p, field, value) {
  const id = `${p.key}:${field}`;
  if (agentSaving.has(id)) return;
  agentSaving.add(id);
  let r = null;
  try {
    r = await appFetch(`/api/app/projects/${encodeURIComponent(p.key)}/config`, { method: 'PUT', json: { [field]: value } });
  } catch {
    // handled below as "could not reach"
  }
  agentSaving.delete(id);
  if (r?.status !== 200) {
    toast(r ? errText(r) : 'Could not reach the nika server.', { kind: 'error' });
    return;
  }
  const saved = r.body?.[field] ?? value;
  rememberField(p.key, field, saved);
  render(true);
  const it = AGENT_ITEMS[field];
  const name = trunc(p.name, 40);
  const rules = (state.projects?.find((x) => x.key === p.key) ?? p).rules?.state; // a rules file nika wrote lists these values, and only Apply updates it
  const tail = ` Sessions nika starts from now on use it.${rules === 'nika' || rules === 'outdated' ? ' Apply rules to update rules/orchestration.md.' : ''}`;
  toast(saved === null ? `${it.label} for ${name} now follows Settings: ${it.word(settingsValue(state.settings ?? {}, field))}.${tail}` : `${it.label} saved for ${name}: ${it.word(saved)}.${tail}`);
}

function setupCards(p, g) {
  const rs = p.rules?.state ?? 'none';
  const picked = sortIds(state.settings?.perProject?.[p.key]?.plugins ?? []);
  const lim = limitsOf(g, null);
  const s = state.settings;
  const mine = s?.perProject?.[p.key] ?? {}; // everything this project sets itself
  const own = mine.models ?? {};
  const set = ROLES.filter((r) => own[r]); // only the roles this project sets; the rest use Settings
  const modelRow = (r, id) => {
    const label = modelLabel(id, state.models);
    return [h('dt', { text: ROLE_LABEL[r] }), h('dd', { class: label ? null : 'mono', title: id, text: label ?? id })];
  };
  const chip = (id) => {
    const gone = Array.isArray(state.plugins) && !state.plugins.includes(id);
    return h('li', { class: `chip${gone ? ' missing' : ''}` }, gone ? [icon('warn'), id, ' (not installed)'] : id);
  };
  return [
    h('div', { class: 'card' },
      h('h2', { text: 'Rules' }), rulesEl(rs), h('p', { text: RULE_TEXT[rs] ?? RULE_TEXT.none }),
      p.rules && !p.rules.settingsIgnored ? h('p', { class: 'muted', text: '.claude/settings.local.json is not in .gitignore.' }) : null,
      p.rules?.git === false ? h('p', { class: 'muted', text: 'No .git folder here: this is not a git repository.' }) : null,
      h('div', null, h('button', {
        type: 'button', class: `btn${rs === 'nika' ? '' : ' primary'}`, 'data-fk': 'rules-open',
        onclick: focusing(() => openRules(p)), text: rs === 'nika' ? 'Preview rules' : rs === 'none' ? 'Set up rules…' : 'Update rules…',
      }))),
    h('div', { class: 'card' },
      h('h2', { text: 'Project setup' }),
      h('p', { class: 'help' }, 'Applies to this project only. Defaults are in ', h('a', { href: '#settings', text: 'Settings' }), '.'),
      h('h3', null, picked.length ? ['Plugins ', h('span', { class: 'help', text: `${picked.length} on` })] : 'Plugins'),
      picked.length
        ? h('ul', { class: 'chips', 'data-fk': 'setup-chips', 'aria-label': 'Plugins turned on' }, picked.slice(0, CHIPS_MAX).map(chip))
        : h('p', { class: 'muted', text: 'No plugins chosen. Agents use only what the project already enables.' }),
      picked.length > CHIPS_MAX ? h('p', { class: 'help', 'data-fk': 'setup-more', text: `+${picked.length - CHIPS_MAX} more` }) : null,
      h('p', { class: 'muted', text: 'Written into .claude/settings.local.json when you apply rules.' }),
      h('div', null, h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', 'data-fk': 'choose-plugins', onclick: focusing(() => openPlugins(p)), text: 'Choose plugins…' })),
      h('h3', null, set.length ? ['Models ', h('span', { class: 'help', text: `${set.length} set here` })] : 'Models'),
      !s ? h('p', { class: 'muted', text: 'Not loaded yet.' })
        : set.length ? h('dl', { class: 'kv', 'data-fk': 'setup-models' }, set.flatMap((r) => modelRow(r, own[r])))
          : h('p', { class: 'muted', text: 'All roles use the defaults from Settings.' }),
      h('p', { class: 'muted', text: "Used when nika starts this project's orchestrator or spawns its agents." }),
      h('div', null, h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'dialog', 'data-fk': 'choose-models', onclick: focusing(() => openModels(p)), text: 'Choose models…' }))),
    h('div', { class: 'card' },
      h('h2', { text: 'New agents' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Permission mode' }), h('dd', null, s ? agentItemEl(p, 'permissionMode', s, mine) : '–'),
        h('dt', { text: 'Pane' }), h('dd', null, s ? agentItemEl(p, 'panePlacement', s, mine) : '–'),
        h('dt', { text: 'Per orchestrator' }), h('dd', { class: 'num' }, s ? agentItemEl(p, 'maxAgents', s, mine) : `${lim.max} at once`),
        h('dt', { text: 'Spawned from nika' }), h('dd', { class: 'num', text: `${lim.parent.running} of ${lim.max}` }),
        h('dt', { text: 'This project' }), h('dd', { class: 'num', text: `${lim.project.running} of ${lim.project.cap} running` })),
      limitNote(lim)),
  ];
}

/* ---------- choose plugins (dialog; docs/design/spec.md 3.15) ---------- */
const LOAD_ERROR = 'The plugin list could not be loaded. Check that nika is still running, then try again.';
// phase: loading | ready | empty (nothing installed, nothing ticked) | error. Ticks live in `picked` (a set of ids), never in the
// boxes, so a row the filter hides keeps its tick; `opened` fixes the row order for as long as the dialog is open.
const pl = { project: null, phase: 'loading', installed: [], saved: [], opened: [], picked: new Set(), query: '', alert: '', saving: false, seq: 0, timer: null, swallow: false };

const plugView = () => pluginView({ installed: pl.installed, picked: pl.picked, opened: pl.opened, query: pl.query });

function plugAlert(text) {
  pl.alert = text;
  $('#pl-alert-text').textContent = text;
  $('#pl-alert').hidden = !text;
}

function plugCount() {
  $('#pl-count').textContent = pl.phase === 'ready' ? countText(plugView(), pl.query) : '';
}

/** A tick changes its row in place (no redraw, so focus stays) and the count. */
function plugToggle(row, chip, id, on) {
  if (on) pl.picked.add(id);
  else pl.picked.delete(id);
  row.dataset.on = String(on);
  chip.hidden = !on;
  plugCount();
}

function plugRow(r) {
  const chip = h('span', { class: 'onoff', 'aria-hidden': 'true', hidden: !r.on, text: 'on' });
  const box = h('input', { type: 'checkbox', 'data-fk': `pl-row:${r.id}`, checked: r.on, onchange: () => plugToggle(row, chip, r.id, box.checked) });
  const row = h('label', { class: 'check plug-row', 'data-on': String(r.on) }, box,
    h('span', { class: 'plug-n' }, r.name, h('span', { class: 'muted', text: ` @${r.market}` }),
      r.installed ? null : h('span', { class: 'plug-miss' }, icon('warn'), ' (not installed)')),
    chip);
  return row;
}

/** Draws what depends on the phase, the filter and the ticks. Only here are rows rebuilt (the filter calls it). */
function plugRender() {
  const view = plugView();
  const { phase } = pl;
  const show = (b, on) => { // hidden and off together, so Mod+Enter (the first enabled primary button) never presses a button that is not shown
    b.hidden = !on;
    b.disabled = !on;
  };
  let body;
  if (phase === 'loading') body = [h('span', { class: 'sr-only', text: 'Loading plugins…' }), [1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'sk sk-line', 'aria-hidden': 'true' }))];
  else if (phase === 'empty') body = [h('p', { text: 'No plugins are installed in Claude Code.' }), h('p', { class: 'help', text: 'Install plugins with Claude Code, then open this again.' })];
  else if (phase === 'ready' && view.counts.shown === 0) body = [h('p', { text: `No plugin matches “${pl.query.trim()}”.` }), h('button', { type: 'button', class: 'btn link', 'data-fk': 'pl-clear', onclick: plugClear, text: 'Clear filter' })];
  else body = view.rows.filter((r) => r.shown).map(plugRow);
  $('#pl-list').replaceChildren(...body.flat());
  $('#pl-list').setAttribute('aria-busy', String(phase === 'loading'));
  $('#pl-search').hidden = phase === 'error' || phase === 'empty';
  $('#pl-help').hidden = phase !== 'ready';
  plugCount();
  plugAlert(pl.alert);
  show($('#pl-save'), phase === 'loading' || phase === 'ready');
  $('#pl-save').disabled = phase !== 'ready';
  show($('#pl-retry'), phase === 'error');
  $('#pl-cancel').textContent = phase === 'empty' ? 'Close' : 'Cancel';
}

function plugFilter(value) {
  pl.query = value;
  plugRender();
  clearTimeout(pl.timer);
  if (pl.phase === 'ready') pl.timer = setTimeout(() => announce(filterNote(plugView())), 400);
}

function plugClear() {
  $('#pl-filter').value = '';
  plugFilter('');
  $('#pl-filter').focus();
}

/** Esc in a filter that has text clears it; with no text it is left to the dialog, which closes. */
function plugFilterKey(e) {
  if (e.key !== 'Escape' || !e.target.value) return;
  e.preventDefault();
  e.stopPropagation();
  pl.swallow = true; // a web view that still sends "cancel" for this Esc must not close the dialog either
  setTimeout(() => { pl.swallow = false; }, 0);
  e.target.value = '';
  plugFilter('');
}

function openPlugins(p) {
  Object.assign(pl, { project: p, phase: 'loading', installed: [], saved: [], opened: [], picked: new Set(), query: '', alert: '' });
  $('#pl-filter').value = '';
  $('#pl-h').textContent = `Choose plugins for ${trunc(p.name, 32)}`;
  plugRender();
  openDialog($('#dlg-plugins'), { focus: $('#pl-filter'), ...overSetup() });
  plugLoad();
}

/** The installed plugins and this project's saved list, asked together; the ticks come from the saved list. */
async function plugLoad() {
  const my = ++pl.seq;
  Object.assign(pl, { phase: 'loading', alert: '' });
  plugRender();
  let r = null;
  try {
    r = await Promise.all([appFetch('/api/app/plugins'), appFetch(`/api/app/projects/${encodeURIComponent(pl.project.key)}/config`)]);
  } catch {
    // shown as the load error
  }
  if (my !== pl.seq || !$('#dlg-plugins').open) return;
  const [list, cfg] = r ?? [];
  if (list?.status === 200 && cfg?.status === 200 && Array.isArray(list.body?.plugins) && Array.isArray(cfg.body?.plugins)) {
    state.plugins = list.body.plugins;
    Object.assign(pl, { installed: list.body.plugins, saved: cfg.body.plugins, opened: cfg.body.plugins, picked: new Set(cfg.body.plugins) });
    pl.phase = plugView().rows.length ? 'ready' : 'empty';
  } else {
    Object.assign(pl, { phase: 'error', alert: LOAD_ERROR });
  }
  plugRender();
  if (pl.phase === 'error') $('#pl-alert').focus();
  else if (pl.phase === 'empty') $('#pl-cancel').focus();
  else $('#pl-filter').focus();
}

/** Everything a save in flight turns off, and back. */
function plugBusy(on) {
  const dlg = $('#dlg-plugins');
  pl.saving = on;
  if (on) {
    dlg.dataset.busy = '1';
    plugAlert('');
  } else delete dlg.dataset.busy;
  $('#pl-box').disabled = on; // a disabled fieldset disables every box in it
  for (const id of ['#pl-filter', '#pl-cancel', '#pl-x']) $(id).disabled = on;
  setBusy($('#pl-save'), on, 'Saving…');
}

/** The settings copy of one project's saved `field` (a plugin list, a models map, or a mode, placement or limit), so the card is right before the next load. Empty or null drops it (and the entry when it was the only key). */
function rememberField(key, field, value) {
  const s = state.settings;
  if (!s) return;
  const map = { ...s.perProject };
  const entry = { ...map[key], [field]: value };
  if (value === null || (typeof value === 'object' && !Object.keys(value).length)) delete entry[field];
  if (Object.keys(entry).length) map[key] = entry;
  else delete map[key];
  s.perProject = map;
}

const rememberPlugins = (key, plugins) => rememberField(key, 'plugins', plugins);

async function plugSave() {
  if (pl.phase !== 'ready' || pl.saving) return;
  const dlg = $('#dlg-plugins');
  const p = pl.project;
  const next = pluginSave(pl.saved, pl.picked);
  if (next === null) { // nothing changed: nothing to send. The card still learns the list the dialog loaded, in case it was changed elsewhere
    dlg.close();
    if (pluginSave(state.settings?.perProject?.[p.key]?.plugins, pl.saved) !== null) {
      rememberPlugins(p.key, pl.saved);
      render(true);
    }
    return;
  }
  plugBusy(true);
  let r = null;
  try {
    r = await appFetch(`/api/app/projects/${encodeURIComponent(p.key)}/config`, { method: 'PUT', json: { plugins: next } });
  } catch {
    // handled below as "could not reach"
  }
  plugBusy(false);
  if (r?.status === 200) {
    rememberPlugins(p.key, Array.isArray(r.body?.plugins) ? r.body.plugins : next);
    dlg.close();
    render(true);
    toast(`Plugins saved for ${trunc(p.name, 40)}. Apply rules to write them.`, { action: { label: 'Apply rules', run: () => openRules(p) } });
    return;
  }
  plugAlert(r ? errText(r) : 'Could not reach the nika server.');
  $('#pl-alert').focus();
}

function wirePlugins() {
  const filter = $('#pl-filter');
  filter.addEventListener('input', () => plugFilter(filter.value));
  filter.addEventListener('keydown', plugFilterKey);
  $('#dlg-plugins').addEventListener('cancel', (e) => { if (pl.swallow) e.preventDefault(); });
  $('#pl-save').addEventListener('click', plugSave);
  $('#pl-retry').addEventListener('click', plugLoad);
}

/* ---------- choose models (dialog; docs/design/spec.md 3.15) ---------- */
const MODELS_LOAD_ERROR = 'The model settings could not be loaded. Check that nika is still running, then try again.';
// phase: loading | ready | error. The draft lives in the selects and Custom ID fields; `loaded` is what the server held when the
// dialog opened ({ role: id | null }), and Save is on only while the draft differs from it.
const md = { project: null, phase: 'loading', loaded: null, alert: '', saving: false, seq: 0 };
const mdSel = (r) => $(`#md-model-${r}`);
const mdCustom = (r) => $(`#md-model-${r}-custom`);

/** Each role's draft: a model id (a Custom ID's text is trimmed and may still be invalid), or null for "use the default". */
function mdDraft() {
  return Object.fromEntries(ROLES.map((r) => [r, mdSel(r).value === '' ? null : mdSel(r).value === CUSTOM ? mdCustom(r).value.trim() : mdSel(r).value]));
}

const mdChanged = () => {
  const draft = mdDraft();
  return ROLES.filter((r) => draft[r] !== md.loaded[r]);
};

function mdAlert(text) {
  md.alert = text;
  $('#md-alert-text').textContent = text;
  $('#md-alert').hidden = !text;
}

/** The footer count and Save: on only when the draft differs from what was loaded (changed back, off again). */
function mdSync() {
  const n = md.phase === 'ready' ? mdChanged().length : 0;
  if (!md.saving) $('#md-save').disabled = n === 0;
  $('#md-dirty').textContent = md.phase !== 'ready' ? '' : n ? `${n} role${n === 1 ? '' : 's'} changed` : 'No changes yet.';
}

function mdRender() {
  const { phase } = md;
  const show = (b, on) => { // hidden and off together, so Mod+Enter (the first enabled primary button) never presses a button that is not shown
    b.hidden = !on;
    b.disabled = !on;
  };
  $('#md-skel').replaceChildren(...(phase === 'loading'
    ? [h('span', { class: 'sr-only', text: 'Loading models…' }), [1, 2, 3, 4].map(() => h('div', { class: 'sk sk-line', 'aria-hidden': 'true' }))].flat()
    : []));
  $('#md-skel').hidden = phase !== 'loading';
  $('#md-fields').hidden = phase !== 'ready';
  $('#md-note').hidden = phase !== 'ready' || Boolean(state.models);
  show($('#md-retry'), phase === 'error');
  show($('#md-save'), phase !== 'error');
  mdAlert(md.alert);
  mdSync();
}

/** Each select reads "Use default (<Settings model>)" or the project's model; a saved id the catalog lacks opens as Custom ID, filled. */
function mdFill() {
  for (const r of ROLES) {
    const custom = fillRoleOverride(mdSel(r), state.models, md.loaded[r], state.settings.models?.[r]);
    mdCustom(r).value = custom ? md.loaded[r] : '';
    mdCustom(r).hidden = !custom;
    fieldError(mdCustom(r), '');
  }
}

function openModels(p) {
  Object.assign(md, { project: p, phase: 'loading', loaded: null, alert: '' });
  $('#md-h').textContent = `Models for ${trunc(p.name, 32)}`;
  mdRender();
  openDialog($('#dlg-models'), overSetup());
  mdLoad();
}

/** The settings (for the defaults), the catalog and this project's saved models, asked together. No catalog is not an error: Custom ID still works. */
async function mdLoad() {
  const my = ++md.seq;
  Object.assign(md, { phase: 'loading', alert: '' });
  mdRender();
  let r = null;
  try {
    r = await Promise.all([loadSettings(), loadModels().catch(() => null), appFetch(`/api/app/projects/${encodeURIComponent(md.project.key)}/config`)]);
  } catch {
    // shown as the load error
  }
  if (my !== md.seq || !$('#dlg-models').open) return;
  const [set, , cfg] = r ?? [];
  if (set?.status === 200 && cfg?.status === 200 && cfg.body?.models && typeof cfg.body.models === 'object') {
    md.loaded = Object.fromEntries(ROLES.map((role) => [role, typeof cfg.body.models[role] === 'string' ? cfg.body.models[role] : null]));
    mdFill();
    md.phase = 'ready';
  } else Object.assign(md, { phase: 'error', alert: MODELS_LOAD_ERROR });
  mdRender();
  if (md.phase === 'error') $('#md-alert').focus();
  else mdSel('orchestrator').focus();
}

/** Everything a save in flight turns off, and back. */
function mdBusy(on) {
  const dlg = $('#dlg-models');
  md.saving = on;
  if (on) {
    dlg.dataset.busy = '1';
    mdAlert('');
  } else delete dlg.dataset.busy;
  for (const r of ROLES) {
    mdSel(r).disabled = on;
    mdCustom(r).disabled = on;
  }
  for (const id of ['#md-cancel', '#md-x']) $(id).disabled = on;
  setBusy($('#md-save'), on, 'Saving…');
  mdSync();
}

async function mdSave() {
  if (md.phase !== 'ready' || md.saving || !mdChanged().length) return;
  const p = md.project;
  const bad = ROLES.filter((r) => !mdCustom(r).hidden && !MODEL_ID.test(mdCustom(r).value.trim()));
  for (const r of ROLES) fieldError(mdCustom(r), bad.includes(r) ? MODEL_HINT : '');
  if (bad.length) {
    mdAlert(`${bad.length} field${bad.length === 1 ? ' needs' : 's need'} a fix before saving.`);
    mdCustom(bad[0]).focus();
    return;
  }
  const models = mdDraft();
  mdBusy(true);
  let r = null;
  try {
    r = await appFetch(`/api/app/projects/${encodeURIComponent(p.key)}/config`, { method: 'PUT', json: { models } });
  } catch {
    // handled below as "could not reach"
  }
  mdBusy(false);
  if (r?.status === 200) {
    const saved = r.body?.models ?? models;
    rememberField(p.key, 'models', Object.fromEntries(ROLES.filter((role) => saved[role]).map((role) => [role, saved[role]])));
    $('#dlg-models').close();
    render(true);
    const rules = (state.projects?.find((x) => x.key === p.key) ?? p).rules?.state; // a rules file nika wrote lists the models, and only Apply updates it
    toast(`Models saved for ${trunc(p.name, 40)}. Sessions nika starts from now on use them.${rules === 'nika' || rules === 'outdated' ? ' Apply rules to update the models in rules/orchestration.md.' : ''}`);
    return;
  }
  mdAlert(r ? errText(r) : 'Could not reach the nika server.');
  $('#md-alert').focus();
}

function wireModels() {
  for (const r of ROLES) {
    mdSel(r).addEventListener('change', () => { // Custom ID shows its field; any other choice hides it and drops its error
      mdCustom(r).hidden = mdSel(r).value !== CUSTOM;
      fieldError(mdCustom(r), '');
      mdSync();
    });
    mdCustom(r).addEventListener('input', mdSync);
    mdCustom(r).addEventListener('blur', () => {
      if (!mdCustom(r).hidden) fieldError(mdCustom(r), MODEL_ID.test(mdCustom(r).value.trim()) ? '' : MODEL_HINT);
    });
    mdCustom(r).addEventListener('keydown', (e) => { // no <form>: Enter saves only when there is something to save
      if (e.key !== 'Enter') return;
      e.preventDefault();
      mdSave();
    });
  }
  $('#md-save').addEventListener('click', mdSave);
  $('#md-retry').addEventListener('click', mdLoad);
}

/* ---------- remove project ---------- */
let confirmCtl = null; // the confirm dialog is reused: drop the previous opening's click handler
function confirmRemove(p) {
  const dlg = $('#dlg-confirm');
  $('#cf-h').textContent = `Remove ${trunc(p.name, 40)} from nika?`;
  $('#cf-d').textContent = 'nika stops listing this project and forgets its plugin, model, permission mode, pane and agent limit choices and its saved orchestrator. No files change and running agents keep running.';
  $('#cf-ok').textContent = 'Remove project';
  confirmCtl?.abort();
  confirmCtl = new AbortController();
  $('#cf-ok').addEventListener('click', async () => {
    const ok = $('#cf-ok');
    dlg.dataset.busy = '1';
    setBusy(ok, true, 'Removing…');
    let r = null;
    try {
      r = await appFetch(`/api/app/projects/${encodeURIComponent(p.key)}`, { method: 'DELETE' });
    } catch {
      // handled below as "could not reach"
    }
    delete dlg.dataset.busy;
    setBusy(ok, false);
    if (r && (r.status === 200 || r.status === 404)) {
      dlg.close();
      await pollApp();
      location.hash = '#dashboard';
      toast(`Removed ${p.name} from nika.`);
    } else {
      toast(r ? errText(r) : 'Could not reach the nika server.', { kind: 'error' });
    }
  }, { signal: confirmCtl.signal });
  openDialog(dlg, { focus: $('#cf-cancel'), ...overSetup() });
}

/* ---------- spawn sheet (design 0.4 section 3) ---------- */
// parent = the agent row the sheet was opened under (the main orchestrator, or a sub-orchestrator), null = you; role = agent | orchestrator
// (a sub-orchestrator); autoName = the last default name the sheet filled; touched = the user picked a model, so a role switch leaves it.
const sp = { group: null, busy: false, under: null, parent: null, role: 'agent', autoName: '', touched: false };
const spawnPrefs = new Map(); // per project and role (`<key>:<role>`): last model, permission mode and placement (kept for this window only)
const SP_PREFIX = { agent: 'builder', orchestrator: 'lead' };
const SP_TITLE = { agent: 'Spawn agent', orchestrator: 'Spawn sub-orchestrator' };
const SP_BRIEF = {
  agent: "The agent's first message: more than one word. It never passes through the tmux command line.",
  orchestrator: "The sub-orchestrator's first message: the part of the work it plans and hands out. More than one word. It never passes through the tmux command line.",
};
const SP_WHY = {
  none: "Sub-orchestrators run under the orchestrator. Use Spawn sub-orchestrator in the header, or the orchestrator's row menu.",
  sub: 'Only the main orchestrator can start sub-orchestrators: nika allows three levels.',
};

function spawnName(g, role = 'agent') {
  const used = new Set(g.agents.map((a) => a.name));
  for (let i = 1; i < 100; i += 1) if (!used.has(`${SP_PREFIX[role]}-${i}`)) return `${SP_PREFIX[role]}-${i}`;
  return '';
}

/** The Roles group of the model select: the project's effective models (design 4), or the four aliases while Settings has not loaded. */
function spawnRoles(key) {
  const s = state.settings;
  const own = s?.perProject?.[key]?.models ?? {}; // the roles this project sets itself
  const m = effectiveRoleModels(s, key);
  return (s?.models
    ? ['builder', 'reasoner', 'scout', 'orchestrator'].map((r) => [`${ROLE_LABEL[r]} · ${m[r]}${own[r] ? ' (this project)' : ''}`, m[r]])
    : [['Opus', 'opus'], ['Sonnet', 'sonnet'], ['Haiku', 'haiku'], ['Fable', 'fable']]
  ).map(([text, value]) => ({ value, text }));
}

/** Fill the model select: `remembered` (this window's last choice for the role), else Roles › Builder, or › Orchestrator for a sub-orchestrator. */
function fillSpawnModel(role, remembered) {
  const roles = spawnRoles(sp.group.project.key);
  const value = remembered ?? roles[role === 'orchestrator' ? 3 : 0].value;
  const custom = fillModelSelect($('#sp-model'), state.models, value, roles);
  $('#sp-model-custom').value = custom ? value : '';
  $('#sp-model-custom').hidden = !custom;
  fieldError($('#sp-model-custom'), '');
}

/** What the role changes in the sheet's words: the title, the button, the brief help and the selected card. */
function paintRole(role) {
  $('#sp-h').textContent = SP_TITLE[role];
  $('#sp-go').textContent = SP_TITLE[role];
  $('#sp-brief-help').textContent = SP_BRIEF[role];
  syncRadioCards($('#sp-role'));
}

/** The role the radios say. */
const spawnRole = () => ($('#sp-role-orch').checked ? 'orchestrator' : 'agent');

/** A role switch inside the open sheet: the name and the model follow only while the user has not changed them. */
function changeRole() {
  const role = spawnRole();
  if (sp.busy || !sp.group || role === sp.role) return;
  sp.role = role;
  if ($('#sp-name').value === sp.autoName) {
    sp.autoName = spawnName(sp.group, role);
    $('#sp-name').value = sp.autoName;
  }
  if (!sp.touched) fillSpawnModel(role, spawnPrefs.get(`${sp.group.project.key}:${role}`)?.model);
  paintRole(role);
}

/** Open the sheet for `g`. `parent` = the agent row it runs under (null = you), `role` = agent or orchestrator (a sub-orchestrator, only under the main one). */
function openSpawn(g, { parent = null, role = 'agent' } = {}) {
  const why = limitReason(g, parent);
  if (why) {
    toast(why, { kind: 'error' });
    return;
  }
  const canSub = parent?.role === 'orchestrator';
  const start = role === 'orchestrator' && canSub ? 'orchestrator' : 'agent';
  Object.assign(sp, { group: g, parent, role: start, touched: false });
  const pref = spawnPrefs.get(`${g.project.key}:${start}`) ?? {};
  const s = state.settings;
  const eff = effectiveAgents(s, g.project.key); // this project's own values, else Settings'
  const l = limitsOf(g, parent?.pane?.id ?? null);
  $('#sp-d').textContent = `In ${g.label}. Opens a new tmux pane and starts Claude Code with your brief.`;
  $('#sp-parent').textContent = parent ? `${parent.name} · ${parent.role === 'sub-orchestrator' ? 'sub-orchestrator' : 'orchestrator'} · pane ${parent.pane.id}` : 'None. You start it from nika.';
  $('#sp-role-agent').checked = start === 'agent';
  $('#sp-role-orch').checked = start === 'orchestrator';
  $('#sp-role-orch').disabled = !canSub;
  $('#sp-role-orch-d').textContent = `Plans the work and spawns up to ${l.max} agents of its own. It may run only nika spawn and nika status.`;
  if (canSub) {
    delete $('#sp-role-orch-card').dataset.off;
    $('#sp-role-orch').removeAttribute('aria-describedby');
  } else {
    $('#sp-role-orch-card').dataset.off = 'true';
    $('#sp-role-orch').setAttribute('aria-describedby', 'sp-role-why');
  }
  $('#sp-role-why').textContent = canSub ? '' : parent ? SP_WHY.sub : SP_WHY.none;
  $('#sp-role-why').hidden = canSub;
  sp.autoName = spawnName(g, start);
  $('#sp-name').value = sp.autoName;
  $('#sp-brief').value = '';
  fillSpawnModel(start, pref.model);
  paintRole(start);
  $('#sp-perm').replaceChildren(
    h('option', { value: '', text: `Use this project's setting: ${s ? PERM_LABEL[eff.permissionMode] ?? eff.permissionMode : 'default'}` }),
    ...Object.entries(PERM_LABEL).map(([v, t]) => h('option', { value: v, text: t })));
  $('#sp-perm').value = pref.perm ?? '';
  const under = g.agents.filter((a) => a.live && a.role === 'agent' && a.pane).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  sp.under = under?.pane.id ?? null;
  const mode = eff.panePlacement;
  const ownPlace = s?.perProject?.[g.project.key]?.panePlacement !== undefined;
  $('#sp-place').replaceChildren(...[
    h('label', { class: 'check' }, h('input', { type: 'radio', name: 'sp-place', value: 'settings' }), `${PLACE_LABEL[mode] ?? 'Beside'} (${ownPlace ? 'set for this project' : 'from Settings'})`),
    under ? h('label', { class: 'check' }, h('input', { type: 'radio', name: 'sp-place', value: 'under' }), `Under ${under.name} (${under.pane.id})`) : null,
  ].filter(Boolean)); // replaceChildren would turn null into the text "null"
  const want = pref.place === 'under' && under ? 'under' : 'settings';
  $(`input[name="sp-place"][value="${want}"]`).checked = true;
  // counted once, when the sheet opens: not live while it is open
  $('#sp-note').textContent = `${parent ? trunc(parent.name, 24) : 'Spawned from nika'}: ${l.parent.running} of ${l.max} · ${trunc(g.label, 24)}: ${l.project.running} of ${l.project.cap} running`;
  for (const id of ['sp-name', 'sp-brief']) fieldError($(`#${id}`), '');
  $('#sp-alert').hidden = true;
  briefCount();
  openDialog($('#dlg-spawn'), { focus: $('#sp-name') });
}

function briefCount() {
  const n = new TextEncoder().encode($('#sp-brief').value).length;
  $('#sp-count').textContent = `${n.toLocaleString()} / ${BRIEF_MAX.toLocaleString()} bytes`;
  return n;
}

/** The problem with a brief, or '' (the rules of src/spawn.js: not empty, more than one word, at most 64 KB). */
function briefProblem(text, bytes) {
  if (!text.trim()) return 'Write the first message for the agent.';
  if (!/\s/.test(text.trim())) return 'The brief must be more than one word.';
  return bytes > BRIEF_MAX ? 'The brief is over 64 KB.' : '';
}

/** The model id the sheet would send: the select's value, or the Custom ID field's text (trimmed) when Custom ID is selected. */
function spawnModel() {
  return $('#sp-model').value === CUSTOM ? $('#sp-model-custom').value.trim() : $('#sp-model').value;
}

function validateSpawn() {
  const bad = [];
  const name = $('#sp-name');
  const okName = RX.agent[0].test(name.value);
  fieldError(name, okName ? '' : RX.agent[1]);
  if (!okName) bad.push(name);
  const model = $('#sp-model-custom');
  const okModel = model.hidden || MODEL_ID.test(model.value.trim());
  fieldError(model, okModel ? '' : MODEL_HINT);
  if (!okModel) bad.push(model);
  const brief = $('#sp-brief');
  const n = briefCount();
  const msg = briefProblem(brief.value, n);
  fieldError(brief, msg);
  if (msg) bad.push(brief);
  return bad;
}

function spawnAlert(text) {
  $('#sp-alert-text').textContent = text;
  $('#sp-alert').hidden = false;
}

async function submitSpawn(e) {
  e.preventDefault();
  if (sp.busy || !sp.group) return;
  const g = sp.group;
  const bad = validateSpawn();
  if (bad.length) {
    spawnAlert(`${bad.length} field${bad.length === 1 ? ' needs' : 's need'} a fix before spawning.`);
    bad[0].focus();
    return;
  }
  $('#sp-alert').hidden = true;
  const name = $('#sp-name').value;
  const place = $('input[name="sp-place"]:checked')?.value ?? 'settings';
  const model = spawnModel();
  const role = spawnRole();
  const parent = sp.parent;
  const req = { project: g.project.key, name, model, brief: $('#sp-brief').value, role };
  if (parent) req.parent = parent.pane.id;
  if ($('#sp-perm').value) req.permissionMode = $('#sp-perm').value;
  if (place === 'under' && sp.under) req.under = sp.under;
  const dlg = $('#dlg-spawn');
  const go = $('#sp-go');
  sp.busy = true;
  dlg.dataset.busy = '1';
  $('#sp-cancel').disabled = true;
  $('#sp-role').disabled = true;
  setBusy(go, true, `Starting ${name}…`);
  let r = null;
  try {
    r = await appFetch('/api/app/spawn', { method: 'POST', json: req });
  } catch {
    // handled below as "could not reach"
  }
  sp.busy = false;
  delete dlg.dataset.busy;
  $('#sp-cancel').disabled = false;
  $('#sp-role').disabled = false;
  setBusy(go, false);
  if (r?.status === 200) {
    spawnPrefs.set(`${g.project.key}:${role}`, { model: req.model, perm: $('#sp-perm').value, place });
    dlg.close();
    const href = sessionHref({ session: r.body.sessionId, pane: r.body.pane, project: g.project.key });
    const who = parent ? ` under ${trunc(parent.name, 40)}` : '';
    toast(`Spawned ${role === 'orchestrator' ? 'sub-orchestrator ' : ''}${name}${who} in pane ${r.body.pane}`, href ? { action: { label: 'Open session', run: () => { location.href = href; } } } : {});
    await pollApp();
    render(true);
    return;
  }
  spawnAlert(spawnFailure(r, req, g, parent));
  $('#sp-alert').focus();
}

/** The sheet's alert for a refused or failed spawn: the fixed copy of design 2.4 by code, else the server's own message. */
function spawnFailure(r, req, g, parent) {
  if (!r) return 'Could not reach the nika server.';
  const b = r.body ?? {};
  const who = parent ? trunc(parent.name, 40) : null;
  if (r.status === 409 && b.error === 'limit' && (b.scope === 'parent' || b.scope === 'project') && Number.isInteger(b.running) && Number.isInteger(b.max)) {
    return limitCopy({ scope: b.scope, parent: who, project: trunc(g.label, 40), running: b.running, max: b.max, own: ownLimit(g) });
  }
  if (r.status === 409 && b.error === 'depth' && req.role === 'orchestrator') {
    return `${who ?? 'That session'} can't start a sub-orchestrator. Only the main orchestrator can: nika allows three levels (orchestrator, sub-orchestrators, their agents). Nothing was started.`;
  }
  if (r.status === 404 && b.error === 'not_found' && req.parent && !req.under) { // with `under` the pane that is gone may be that one: the server's words then
    return `${who} is no longer running, so nothing was started. Close this and spawn from a session that is running.`;
  }
  return launchError(r) ?? errText(r);
}

/* ---------- apply rules ---------- */
const ru = { project: null, phase: 'loading', preview: null, sel: 0, gitignore: false, foreignOk: false, message: '', result: null, seq: 0 };
const ACT_MARK = { create: '+', update: '~', unchanged: '=', skipped: '–' };
// nothing is written for these (either may carry the server's note, shown in the detail pane in place of the default line)
const inert = (f) => f.action === 'unchanged' || f.action === 'skipped';

function openRules(project) {
  Object.assign(ru, { project, preview: null, sel: 0, gitignore: false, foreignOk: false, message: '', result: null });
  openDialog($('#dlg-rules'), overSetup());
  rulesPreview();
}

async function rulesPreview() {
  const my = ++ru.seq;
  ru.phase = 'loading';
  ru.message = '';
  rulesRender();
  let r = null;
  try {
    r = await appFetch('/api/app/rules/preview', { method: 'POST', json: { project: ru.project.key } });
  } catch {
    // handled below as "could not reach"
  }
  if (my !== ru.seq || !$('#dlg-rules').open) return;
  if (r?.status === 200) {
    ru.preview = r.body;
    ru.phase = 'preview';
    ru.foreignOk = false;
    const first = r.body.files.findIndex((f) => !inert(f) && !f.optional);
    ru.sel = Math.max(0, first);
  } else {
    ru.phase = 'error';
    ru.message = r ? errText(r) : 'Could not reach the nika server.';
  }
  rulesRender();
  if (ru.phase === 'error') $('#ru-alert')?.focus();
}

async function rulesApply() {
  const dlg = $('#dlg-rules');
  ru.phase = 'applying';
  ru.message = '';
  dlg.dataset.busy = '1';
  rulesRender();
  let r = null;
  try {
    r = await appFetch('/api/app/rules/apply', {
      method: 'POST',
      json: { project: ru.project.key, hash: ru.preview.hash, overwriteForeign: ru.foreignOk, gitignore: ru.gitignore },
    });
  } catch {
    // handled below as "could not reach"
  }
  delete dlg.dataset.busy;
  const body = r?.body ?? {};
  if (r?.status === 200) {
    ru.phase = 'success';
    ru.result = body;
    announce(`Rules applied. ${(body.written ?? []).length} files written.`);
    pollApp().then(() => render(true));
  } else if (r?.status === 409 && body.error === 'conflict') {
    ru.phase = 'conflict';
  } else if (r?.status === 409 && body.error === 'refused') {
    ru.phase = 'refused';
    ru.message = `${errText(r)}${body.code ? ` (${body.code})` : ''}`;
  } else {
    ru.phase = 'preview';
    const done = Array.isArray(body.written) && body.written.length ? ` Written before the error: ${body.written.join(', ')}.${body.backupDir ? ` Backups are in ${body.backupDir}.` : ''}` : '';
    ru.message = `${r ? errText(r) : 'Could not reach the nika server.'}${done}`;
  }
  rulesRender();
  if (['conflict', 'refused'].includes(ru.phase) || ru.message) $('#ru-alert')?.focus();
  else if (ru.phase === 'success') $('#ru-done')?.focus();
}

function diffEl(text) {
  const pre = h('pre', { class: 'diff', tabindex: '0', 'aria-label': 'Changes' });
  const lines = text.split('\n');
  let o = 0;
  let n = 0;
  let inHunk = false;
  const cap = 1500;
  for (const [i, line] of lines.entries()) {
    if (i >= cap) {
      pre.append(h('span', { class: 'dl d-note' }, `… ${lines.length - cap} more lines are not shown.`));
      break;
    }
    if (line === '' || (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ')))) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        o = Number(m[1]);
        n = Number(m[2]);
      }
      pre.append(h('span', { class: 'dl d-hunk' }, h('span', { class: 'dn' }), h('span', { class: 'dn' }), h('span', { class: 'dm' }), h('span', { text: line })));
      continue;
    }
    if (line.startsWith('\\')) {
      pre.append(h('span', { class: 'dl d-hunk' }, h('span', { class: 'dn' }), h('span', { class: 'dn' }), h('span', { class: 'dm' }), h('span', { text: line })));
      continue;
    }
    const k = line[0];
    pre.append(h('span', { class: `dl ${k === '+' ? 'd-add' : k === '-' ? 'd-del' : 'd-ctx'}` },
      h('span', { class: 'dn', text: k === '+' ? '' : String(o) }),
      h('span', { class: 'dn', text: k === '-' ? '' : String(n) }),
      h('span', { class: 'dm', text: k === '+' ? '+' : k === '-' ? '−' : '' }),
      h('span', { text: line.slice(1) || ' ' })));
    if (k !== '+') o += 1;
    if (k !== '-') n += 1;
  }
  return pre;
}

const keptText = (f) => (f.keptKeys === undefined ? 'other keys are kept as they are (values not shown)'
  : f.keptKeys === 0 ? 'no other keys in this file' : `${f.keptKeys} other key${f.keptKeys === 1 ? '' : 's'} kept (values not shown)`);

function filesPhase() {
  const { files, warnings, backupDir } = ru.preview;
  const busy = ru.phase === 'applying';
  const foreign = files.some((f) => f.foreign);
  const gi = files.find((f) => f.path === '.gitignore' && f.optional);
  const label = (f) => (f.foreign ? 'replace (not by nika)' : f.optional && !ru.gitignore ? 'optional, not written' : f.action);
  const badge = (f) => h('span', { class: 'act', 'data-a': f.foreign ? 'foreign' : f.action, 'aria-hidden': 'true', text: f.foreign ? '!' : ACT_MARK[f.action] ?? '?' });
  const f = files[ru.sel] ?? files[0];
  const out = [];
  if (ru.message || ru.phase === 'conflict' || ru.phase === 'refused') {
    const text = ru.phase === 'conflict' ? 'These files changed after the preview, so nothing was written. Reload the preview to see the current changes, then apply again.'
      : ru.phase === 'refused' ? `nika refused to write: ${ru.message}. Nothing was changed.` : ru.message;
    out.push(h('div', { class: 'alert', 'data-kind': 'danger', role: 'alert', id: 'ru-alert', tabindex: '-1' }, icon('warn'), h('p', { text })));
  }
  out.push(h('div', { class: 'rules-body' },
    h('nav', { class: 'files', 'aria-label': 'Files to change' }, files.map((x, i) => h('button', {
      type: 'button', 'data-fk': `ruf:${i}`, 'aria-current': i === ru.sel ? 'true' : null, disabled: busy, onclick: () => { ru.sel = i; rulesRender(); },
    }, badge(x), h('span', { class: 'fp', text: x.path }), h('span', { class: 'fa', text: label(x) })))),
    h('section', { class: 'file-view', 'aria-label': `Changes to ${f.path}` },
      h('div', { class: 'file-head' }, h('code', { text: f.path }), badge(f), h('span', { class: 'help', text: label(f) }),
        f.keysPreserved ? h('span', { class: 'help', text: `· only enabledPlugins changes; ${keptText(f)}` }) : null),
      inert(f) ? h('p', { class: 'diff d-note', text: (typeof f.note === 'string' && f.note) || (f.action === 'unchanged' ? 'Unchanged. Not touched.' : 'Skipped. Not touched.') }) // the server's note, as text
        : diffEl(f.diff ?? ''))));
  out.push(h('div', { class: 'rules-notes' },
    warnings?.length ? h('div', { class: 'alert', 'data-kind': 'warn' }, icon('warn'), h('div', null, warnings.map((w) => h('p', { text: w })))) : null,
    gi ? h('label', { class: 'check' }, h('input', {
      type: 'checkbox', id: 'ru-gi', 'data-fk': 'ru-gi', checked: ru.gitignore, disabled: busy,
      onchange: (e) => { ru.gitignore = e.target.checked; rulesRender(); },
    }), h('span', null, 'Also add ', h('code', { text: '.claude/settings.local.json' }), ' to ', h('code', { text: '.gitignore' }))) : null,
    foreign ? h('label', { class: 'check' }, h('input', {
      type: 'checkbox', id: 'ru-fo', 'data-fk': 'ru-fo', checked: ru.foreignOk, disabled: busy,
      onchange: (e) => { ru.foreignOk = e.target.checked; rulesRender(); },
    }), h('span', null, 'Replace ', h('code', { text: 'rules/orchestration.md' }), ', which nika did not write. A backup is kept.')) : null,
    h('p', { class: 'muted' }, 'Backup folder: ', h('code', { text: backupDir }))));
  return out;
}

function successPhase() {
  const written = ru.result?.written ?? [];
  return [h('div', { class: 'success', role: 'status' },
    h('div', { class: 'alert', 'data-kind': 'ok' }, icon('check'), h('p', null, h('strong', { text: `Rules applied to ${ru.project.name}.` }), ` ${written.length} file${written.length === 1 ? '' : 's'} written. Review and commit them yourself; nika did not run git.`)),
    written.length ? h('ul', null, written.map((w) => h('li', null, icon('check'), w))) : null,
    ru.result?.backupDir ? [h('p', { class: 'help', text: 'Previous versions are in the backup folder:' }),
      h('div', { class: 'pathbox' }, h('span', { text: ru.result.backupDir }),
        h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Copy backup path', title: 'Copy backup path', onclick: () => copyText(ru.result.backupDir, 'backup path') }, icon('copy')))] : null)];
}

function rulesRender() {
  const name = ru.project.name;
  $('#ru-h').textContent = `Apply rules to ${trunc(name, 32)}`;
  $('#ru-x').disabled = ru.phase === 'applying';
  const main = $('#ru-main');
  const foot = $('#ru-foot');
  const close = (label = 'Cancel') => h('button', { type: 'button', class: 'btn lg', 'data-close': true, disabled: ru.phase === 'applying', text: label });
  let body;
  let buttons;
  if (ru.phase === 'loading') {
    body = [h('div', { class: 'rules-load', 'aria-busy': 'true' }, h('span', { class: 'sr-only', text: 'Preparing the preview…' }), [1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'sk sk-line', 'aria-hidden': 'true' })))];
    buttons = [close()];
  } else if (ru.phase === 'error') {
    body = [h('div', { class: 'alert', 'data-kind': 'danger', role: 'alert', id: 'ru-alert', tabindex: '-1' }, icon('warn'), h('p', { text: `Preview failed: ${ru.message}` }))];
    buttons = [close(), h('button', { type: 'button', class: 'btn primary lg', onclick: () => rulesPreview(), text: 'Retry' })];
  } else if (ru.phase === 'success') {
    body = successPhase();
    buttons = [h('button', { type: 'button', class: 'btn primary lg', id: 'ru-done', 'data-close': true, text: 'Done' })];
  } else {
    body = filesPhase();
    const files = ru.preview.files;
    const changing = files.filter((f) => !inert(f) && !f.optional).length;
    const skipped = files.filter((f) => f.action === 'skipped').length;
    const note = `${changing} file${changing === 1 ? '' : 's'} change · ${files.filter((f) => f.action === 'unchanged').length} unchanged${skipped ? ` · ${skipped} skipped` : ''}`;
    const foreign = files.some((f) => f.foreign);
    if (ru.phase === 'conflict') buttons = [close(), h('button', { type: 'button', class: 'btn primary lg', onclick: () => rulesPreview(), text: 'Reload preview' })];
    else if (ru.phase === 'refused') buttons = [close('Close')];
    else {
      const busy = ru.phase === 'applying';
      const apply = h('button', { type: 'button', class: 'btn primary lg', id: 'ru-apply', disabled: busy || (foreign && !ru.foreignOk), onclick: () => rulesApply(), text: 'Apply rules' });
      if (busy) setBusy(apply, true, 'Applying…');
      buttons = [h('span', { class: 'help', text: foreign && !ru.foreignOk ? `${note} · tick the replace box to enable Apply` : note }), h('span', { class: 'sp' }), close(), apply];
    }
  }
  swap(main, body);
  swap(foot, buttons);
  main.classList.toggle('is-success', ru.phase === 'success');
}

/* ---------- Add to Applications (spec 3.14, ADR 0011): the two POSTs behind the dashboard notice ---------- */
/** The copy the notice is offering (what was on screen when the button was pressed), or null. */
function offered() {
  return copyBanner(state.me?.appCopy, state.appCopyUi)?.mode ?? null;
}

/** Focus must not fall to <body> when the banner that held it leaves. */
function keepFocus(hadFocus) {
  if (hadFocus && !$('#banners').contains(document.activeElement)) $('#main')?.focus({ preventScroll: true });
}

async function appCopyInstall() {
  const ui = state.appCopyUi;
  const mode = offered();
  if (!mode || ui.busy) return;
  const hadFocus = $('#banners').contains(document.activeElement);
  ui.busy = true;
  ui.error = null;
  render(true);
  let res = null;
  try {
    res = await appFetch('/api/app/app-copy', { method: 'POST', json: { action: 'install' } });
  } catch {
    // a network failure reads as the generic line below
  }
  ui.busy = false;
  if (res?.status === 200 && res.body?.state === 'current') {
    toast(copyToast(mode, res.body));
    await loadMe().catch(() => {}); // the banner follows the server's answer
  } else {
    ui.error = copyErrorText(res);
  }
  render(true);
  keepFocus(hadFocus);
}

async function appCopyDismiss() {
  const ui = state.appCopyUi;
  const mode = offered();
  if (!mode || ui.busy) return;
  const hadFocus = $('#banners').contains(document.activeElement);
  ui.hidden = true; // gone for this launch whatever the server says; Update posts nothing
  render(true);
  keepFocus(hadFocus);
  if (mode !== 'add') return;
  try {
    if ((await appFetch('/api/app/app-copy', { method: 'POST', json: { action: 'dismiss' } })).status === 200) await loadMe();
  } catch {
    // not asked again this launch either way
  }
}

/* ---------- start ---------- */
/** The project page's own "Show ended" checkbox (default off, remembered): ended sessions and finished subagents of this page. */
function wireEnded() {
  const box = $('#proj-ended');
  box.checked = state.showEndedProject;
  box.addEventListener('change', () => {
    state.showEndedProject = box.checked;
    save('showEndedProject', state.showEndedProject);
    resetEndedState(state.open, 'pv'); // every Ended section starts open again, folded by hand or not
    render(true); // a user action always redraws, even with a selection in the list
  });
}

export async function initApp() {
  hooks.pollApp = pollApp;
  hooks.appCopyInstall = appCopyInstall;
  hooks.appCopyDismiss = appCopyDismiss;
  hooks.renderSide = renderSide;
  hooks.renderProject = renderProject;
  hooks.enterProject = () => { loadInstalled().then(() => render()); };
  hooks.groupActions = groupActions;
  hooks.rowItems = rowItems;
  hooks.addProject = addProject;
  hooks.checkEnv = async () => {
    await loadMe().catch(() => {});
    render(true);
  };
  $('#side-add').addEventListener('click', () => addProject());
  wireEnded();
  wirePlugins();
  wireModels();
  wireSetup();
  $('#spawn-form').addEventListener('submit', submitSpawn);
  $('#sp-brief').addEventListener('input', briefCount);
  $('#sp-model').addEventListener('change', () => { // Custom ID shows its field; any other choice hides it and drops its error
    sp.touched = true;
    $('#sp-model-custom').hidden = $('#sp-model').value !== CUSTOM;
    fieldError($('#sp-model-custom'), '');
  });
  $('#sp-model-custom').addEventListener('input', () => { sp.touched = true; });
  for (const id of ['#sp-role-agent', '#sp-role-orch']) $(id).addEventListener('change', changeRole);
  for (const [id, key] of [['sp-name', 'agent']]) {
    $(`#${id}`).addEventListener('blur', () => fieldError($(`#${id}`), RX[key][0].test($(`#${id}`).value) ? '' : RX[key][1]));
  }
  const results = await Promise.all([loadSettings(), loadMe(), loadProjects(), loadModels()].map((p) => p.catch(() => null)));
  state.appError = results.some((r) => r?.status === 403);
  renderSide();
}

