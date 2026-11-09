// App tier only (imported by app.js when api.js says isApp): environment, project list, add project, start
// orchestrator, the project view, the spawn sheet, the apply-rules dialog and remove project.
// Every privileged request goes through appFetch(); every server string is rendered through h() (textContent).
import { appFetch, applyTheme } from './api.js';
import { h, icon } from './dom.js';
import {
  $, state, hooks, RX, toast, announce, errText, copyText, setBusy, fieldError, openDialog, rulesEl, sessionHref, menuEl,
} from './ui.js';
import { parseModes, modesAfter } from './modes.js';
import { CUSTOM, MODEL_ID, MODEL_HINT, fillModelSelect } from './models-ui.js';
import { buildGroups, agentNodes, swap, interacting, render } from './app.js';

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

/** Reason the privileged actions are off right now, or null. */
function blockedReason() {
  if (state.error) return 'Offline. nika is reconnecting.';
  if (state.me?.tmux === false) return 'Needs tmux. Install it, then check again.';
  if (state.me?.claude === false) return 'Needs Claude Code (claude) on your PATH.';
  return null;
}

function limitInfo(g) {
  const max = state.settings?.limits?.maxAgents ?? 3;
  const running = g.agents.filter((a) => a.live && a.role === 'agent').length;
  return { max, running, reached: running >= max };
}

/* ---------- sidebar and environment ---------- */
let sideSig = '';
function renderSide() {
  const projects = state.projects ?? [];
  const groups = new Map(buildGroups().filter((g) => g.project).map((g) => [g.project.key, g]));
  const rows = projects.map((p) => {
    const c = groups.get(p.key)?.counts;
    return [p.key, p.name, c?.attn ?? 0, c?.live ?? 0];
  });
  const cur = state.route.name === 'project' ? state.route.key : '';
  const env = [state.me?.tmux, state.me?.claude, state.me?.version];
  const sig = JSON.stringify([rows, cur, env]);
  if (sig === sideSig) return;
  sideSig = sig;
  swap($('#side-projects'), rows.map(([key, name, attn, live]) => h('li', null,
    h('a', { href: `#project/${key}`, 'data-fk': `side:${key}`, title: name, 'aria-current': key === cur ? 'page' : null },
      h('span', { class: 'mono-av', 'aria-hidden': 'true', text: name.split(/[-_ .]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?' }),
      h('span', { class: 'label', text: name }),
      attn ? h('span', { class: 'cnt', 'data-s': 'attn' }, h('span', { class: 'sr-only', text: ', needs you: ' }), String(attn))
        : live ? h('span', { class: 'cnt' }, h('span', { class: 'sr-only', text: ', live agents: ' }), String(live)) : null))));
  $('#side-projects').hidden = !rows.length;
  const me = state.me;
  $('#brand-ver').textContent = me?.version ? me.version.split('.').slice(0, 2).join('.') : '';
  swap($('#env'), me ? [
    h('span', { class: me.tmux ? 'env-ok' : 'env-bad' }, h('span', { class: 'long', text: me.tmux ? 'tmux ready' : 'tmux missing' })),
    h('span', { class: me.claude ? 'env-ok' : 'env-bad' }, h('span', { class: 'long', text: me.claude ? 'claude ready' : 'claude missing' })),
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

/* ---------- start orchestrator ---------- */
let starting = false;
async function startOrchestrator(project) {
  if (starting) return;
  starting = true;
  const wait = toast(`Starting the orchestrator for ${project.name}…`, { ms: 0, spin: true });
  try {
    const r = await appFetch('/api/app/orchestrator/start', { method: 'POST', json: { project: project.key } });
    if (r.status !== 200) {
      toast(errText(r), { kind: 'error' });
      return;
    }
    const href = sessionHref({ session: r.body.sessionId, pane: r.body.pane, project: project.key });
    if (href) location.href = href;
    else toast(`Started the orchestrator for ${project.name}.`);
  } catch {
    toast('Could not reach the nika server.', { kind: 'error' });
  } finally {
    wait.remove();
    starting = false;
  }
}

/* ---------- group actions (dashboard group header, empty box, project header) ---------- */
function act(label, iconName, run, { primary = false, fk, reason = null } = {}) {
  const why = blockedReason() ?? reason;
  return h('button', {
    type: 'button', class: `btn${primary ? ' primary' : ''}`, 'data-fk': fk, 'aria-disabled': why ? 'true' : null, title: why ?? label,
    onclick: (e) => (why ? toast(why, { kind: 'error' }) : run(e.currentTarget)),
  }, icon(iconName), h('span', { class: 'lbl', text: label }));
}

/** primary: true = "Start orchestrator" is the primary button, 'spawn' = "Spawn agent" is. */
function groupActions(g, { primary = false } = {}) {
  if (!g.project) {
    return [h('button', { type: 'button', class: 'btn', 'data-fk': `add:${g.key}`, onclick: () => addProject() }, icon('plus'), h('span', { class: 'lbl', text: 'Add project' }))];
  }
  const orch = g.agents.find((a) => a.live && a.role === 'orchestrator');
  const href = orch ? sessionHref({ session: orch.id, pane: orch.pane?.id, project: g.project.key }) : null;
  const lim = limitInfo(g);
  return [
    href
      ? h('a', { class: 'btn', href, 'data-fk': `orch:${g.key}` }, icon('term'), h('span', { class: 'lbl', text: 'Open orchestrator' }))
      : act('Start orchestrator', 'play', () => startOrchestrator(g.project), { primary: primary === true, fk: `start:${g.key}` }),
    act('Spawn agent', 'spawn', () => openSpawn(g), {
      primary: primary === 'spawn', fk: `spawn:${g.key}`,
      reason: lim.reached ? `${lim.running} of ${lim.max} agents are already running in ${g.label}. Wait for one to finish, or raise “Agents per project” in Settings.` : null,
    }),
  ];
}

/* ---------- project view ---------- */
const RULE_TEXT = {
  nika: 'rules/orchestration.md matches the current template.',
  outdated: 'Written by nika from an older template. Update to bring it current.',
  foreign: 'rules/orchestration.md exists but nika did not write it. Applying replaces it after you confirm; a backup is kept.',
  none: 'This project has no rules/orchestration.md yet. Agents start without orchestration rules.',
};

let projSig = '';
function renderProject(force) {
  const key = state.route.key;
  const p = state.projects?.find((x) => x.key === key) ?? null;
  const g = buildGroups().find((x) => x.project?.key === key) ?? null;
  const sig = JSON.stringify([p, g?.agents, state.modes.map, state.settings, state.me?.tmux, state.me?.claude, state.error, state.showEnded, [...state.open], [...state.expanded], key]);
  if (!force && (sig === projSig || interacting())) return;
  projSig = sig;
  const body = $('#proj-body');
  if (!state.projects) return;
  body.setAttribute('aria-busy', 'false');
  if (!p || !g) {
    $('#proj-h').textContent = 'Project not found';
    $('#proj-h').removeAttribute('title');
    document.title = 'Project not found · nika';
    swap($('#proj-rules'), []);
    swap($('#proj-actions'), []);
    swap($('#proj-setup'), []);
    swap($('#proj-agents'), [h('div', { class: 'empty' }, h('h2', { text: 'This project is not registered' }), h('p', { text: 'It may have been removed. Add it again from the dashboard.' }), h('a', { class: 'btn', href: '#dashboard', text: 'Back to the dashboard' }))]);
    return;
  }
  $('#proj-h').textContent = p.name;
  $('#proj-h').title = p.name;
  document.title = `${p.name} · nika`;
  swap($('#proj-rules'), [rulesEl(p.rules?.state)]);
  swap($('#proj-actions'), [
    ...groupActions(g, { primary: 'spawn' }),
    menuEl(`More actions for ${p.name}`, [
      { text: 'Copy folder path', run: () => copyText(p.dir, 'folder path') },
      { text: 'Remove from nika…', run: () => confirmRemove(p) },
    ], 'proj-menu'),
  ]);
  swap($('#proj-agents'), agentNodes(g, '', `pv:${key}`, { endedOpen: true }));
  swap($('#proj-setup'), setupCards(p, g));
}

function setupCards(p, g) {
  const rs = p.rules?.state ?? 'none';
  const picked = state.settings?.plugins?.perProject?.[p.key] ?? [];
  const lim = limitInfo(g);
  const s = state.settings;
  return [
    h('div', { class: 'card' },
      h('h2', { text: 'Rules' }), rulesEl(rs), h('p', { text: RULE_TEXT[rs] ?? RULE_TEXT.none }),
      p.rules && !p.rules.settingsIgnored ? h('p', { class: 'muted', text: '.claude/settings.local.json is not in .gitignore.' }) : null,
      p.rules?.git === false ? h('p', { class: 'muted', text: 'No .git folder here: this is not a git repository.' }) : null,
      h('div', null, h('button', {
        type: 'button', class: `btn${rs === 'nika' ? '' : ' primary'}`, 'data-fk': 'rules-open',
        onclick: () => openRules(p), text: rs === 'nika' ? 'Preview rules' : rs === 'none' ? 'Set up rules…' : 'Update rules…',
      }))),
    h('div', { class: 'card' },
      h('h2', { text: 'Plugins' }),
      picked.length ? h('div', { class: 'chips' }, picked.map((x) => h('span', { class: 'chip', text: x }))) : h('p', { class: 'muted', text: 'No plugins chosen. Agents use only what the project already enables.' }),
      h('p', { class: 'muted', text: 'Written into .claude/settings.local.json when you apply rules.' }),
      h('div', null, h('a', { class: 'btn', href: '#settings', 'data-fk': 'choose-plugins', onclick: () => { state.pluginProject = p.key; }, text: 'Choose plugins…' }))),
    h('div', { class: 'card' },
      h('h2', { text: 'New agents' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Permission mode' }), h('dd', { text: s ? PERM_LABEL[s.permissionMode] ?? s.permissionMode : '–' }),
        h('dt', { text: 'Pane' }), h('dd', { text: s ? PLACE_LABEL[s.panePlacement] ?? s.panePlacement : '–' }),
        h('dt', { text: 'Running' }), h('dd', { class: 'num', text: `${lim.running} of ${lim.max}` })),
      lim.reached ? h('p', { class: 'limit', id: 'limit-note' }, icon('warn'), h('span', { text: `Limit reached: ${lim.running} of ${lim.max} agents are running. Spawning is off until one ends.` })) : null),
  ];
}

/* ---------- remove project ---------- */
let confirmCtl = null; // the confirm dialog is reused: drop the previous opening's click handler
function confirmRemove(p) {
  const dlg = $('#dlg-confirm');
  $('#cf-h').textContent = `Remove ${trunc(p.name, 40)} from nika?`;
  $('#cf-d').textContent = 'nika stops listing this project and forgets its plugin choices. No files change and running agents keep running.';
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
  openDialog(dlg, { focus: $('#cf-cancel') });
}

/* ---------- spawn sheet ---------- */
const sp = { group: null, busy: false, under: null };
const spawnPrefs = new Map(); // per project: last model, permission mode and placement (kept for this window only)

function spawnName(g) {
  const used = new Set(g.agents.map((a) => a.name));
  for (let i = 1; i < 100; i += 1) if (!used.has(`builder-${i}`)) return `builder-${i}`;
  return '';
}

function openSpawn(g) {
  const lim = limitInfo(g);
  if (lim.reached) {
    toast(`${lim.running} of ${lim.max} agents are already running in ${g.label}.`, { kind: 'error' });
    return;
  }
  sp.group = g;
  const pref = spawnPrefs.get(g.project.key) ?? {};
  const s = state.settings;
  $('#sp-d').textContent = `In ${g.label}. Opens a new tmux pane and starts Claude Code with your brief.`;
  $('#sp-name').value = spawnName(g);
  $('#sp-brief').value = '';
  const m = s?.models;
  const roles = (m
    ? [['Builder', m.builder], ['Reasoner', m.reasoner], ['Scout', m.scout], ['Orchestrator', m.orchestrator]].map(([role, id]) => [`${role} · ${id}`, id])
    : [['Opus', 'opus'], ['Sonnet', 'sonnet'], ['Haiku', 'haiku'], ['Fable', 'fable']]
  ).map(([text, value]) => ({ value, text }));
  const custom = fillModelSelect($('#sp-model'), state.models, pref.model ?? roles[0].value, roles);
  $('#sp-model-custom').value = custom ? pref.model : '';
  $('#sp-model-custom').hidden = !custom;
  fieldError($('#sp-model-custom'), '');
  $('#sp-perm').replaceChildren(
    h('option', { value: '', text: `Use my setting: ${s ? PERM_LABEL[s.permissionMode] ?? s.permissionMode : 'default'}` }),
    ...Object.entries(PERM_LABEL).map(([v, t]) => h('option', { value: v, text: t })));
  $('#sp-perm').value = pref.perm ?? '';
  const under = g.agents.filter((a) => a.live && a.role === 'agent' && a.pane).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  sp.under = under?.pane.id ?? null;
  const mode = s?.panePlacement ?? 'beside';
  $('#sp-place').replaceChildren(...[
    h('label', { class: 'check' }, h('input', { type: 'radio', name: 'sp-place', value: 'settings' }), `${PLACE_LABEL[mode] ?? 'Beside'} (from Settings)`),
    under ? h('label', { class: 'check' }, h('input', { type: 'radio', name: 'sp-place', value: 'under' }), `Under ${under.name} (${under.pane.id})`) : null,
  ].filter(Boolean)); // replaceChildren would turn null into the text "null"
  const want = pref.place === 'under' && under ? 'under' : 'settings';
  $(`input[name="sp-place"][value="${want}"]`).checked = true;
  $('#sp-note').textContent = `${lim.running} of ${lim.max} agents running in ${g.label}`;
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
  const model = $('#sp-model').value === CUSTOM ? $('#sp-model-custom').value.trim() : $('#sp-model').value;
  const req = { project: g.project.key, name, model, brief: $('#sp-brief').value };
  if ($('#sp-perm').value) req.permissionMode = $('#sp-perm').value;
  if (place === 'under' && sp.under) req.under = sp.under;
  const dlg = $('#dlg-spawn');
  const go = $('#sp-go');
  sp.busy = true;
  dlg.dataset.busy = '1';
  $('#sp-cancel').disabled = true;
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
  setBusy(go, false);
  if (r?.status === 200) {
    spawnPrefs.set(g.project.key, { model: req.model, perm: $('#sp-perm').value, place });
    dlg.close();
    const href = sessionHref({ session: r.body.sessionId, pane: r.body.pane, project: g.project.key });
    toast(`Spawned ${name} in pane ${r.body.pane}`, href ? { action: { label: 'Open session', run: () => { location.href = href; } } } : {});
    await pollApp();
    render(true);
    return;
  }
  spawnAlert(r ? errText(r) : 'Could not reach the nika server.');
  $('#sp-alert').focus();
}

/* ---------- apply rules ---------- */
const ru = { project: null, phase: 'loading', preview: null, sel: 0, gitignore: false, foreignOk: false, message: '', result: null, seq: 0 };
const ACT_MARK = { create: '+', update: '~', unchanged: '=' };

function openRules(project) {
  Object.assign(ru, { project, preview: null, sel: 0, gitignore: false, foreignOk: false, message: '', result: null });
  openDialog($('#dlg-rules'));
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
    const first = r.body.files.findIndex((f) => f.action !== 'unchanged' && !f.optional);
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
      f.action === 'unchanged' ? h('p', { class: 'diff d-note', text: 'Unchanged. Not touched.' }) : diffEl(f.diff ?? ''))));
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
        h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Copy backup path', onclick: () => copyText(ru.result.backupDir, 'backup path') }, icon('copy')))] : null)];
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
    const changing = files.filter((f) => f.action !== 'unchanged' && !f.optional).length;
    const note = `${changing} file${changing === 1 ? '' : 's'} change · ${files.filter((f) => f.action === 'unchanged').length} unchanged`;
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

/* ---------- start ---------- */
export async function initApp() {
  hooks.pollApp = pollApp;
  hooks.renderSide = renderSide;
  hooks.renderProject = renderProject;
  hooks.groupActions = groupActions;
  hooks.addProject = addProject;
  hooks.checkEnv = async () => {
    await loadMe().catch(() => {});
    render(true);
  };
  $('#side-add').addEventListener('click', () => addProject());
  $('#spawn-form').addEventListener('submit', submitSpawn);
  $('#sp-brief').addEventListener('input', briefCount);
  $('#sp-model').addEventListener('change', () => { // Custom ID shows its field; any other choice hides it and drops its error
    $('#sp-model-custom').hidden = $('#sp-model').value !== CUSTOM;
    fieldError($('#sp-model-custom'), '');
  });
  for (const [id, key] of [['sp-name', 'agent']]) {
    $(`#${id}`).addEventListener('blur', () => fieldError($(`#${id}`), RX[key][0].test($(`#${id}`).value) ? '' : RX[key][1]));
  }
  const results = await Promise.all([loadSettings(), loadMe(), loadProjects(), loadModels()].map((p) => p.catch(() => null)));
  state.appError = results.some((r) => r?.status === 403);
  renderSide();
}

