// nika main page: shell, dashboard, router and the poll loop. It runs in both tiers. The privileged screens live in
// project.js and settings.js; they are imported only when api.js says this is the app tier, so the browser tier
// (read-only, 127.0.0.1:3335) never loads them. Every server string is rendered through h() (textContent).
import { isApp, getJSON } from './api.js';
import { h, icon } from './dom.js';
import { modeEl, rowMode, canEndRow } from './modes.js';
import { wantsHelp, wantsBack, isTextEntry, openShortcuts, helpHint, backHint } from './shortcuts.js';
import { copyBanner } from './app-copy.js';
import { endedPlan, noMatchText, resetEndedState } from './dash-model.js';
import {
  $, $$, MAC, SHAPE, ORDER, state, hooks, load, save, timeEl, tickTimes, announce, toast, copyText,
  statusEl, modelEl, rulesEl, countsLine, sessionHref, menuEl, menuIsOpen, openDialog, initDialogs, initMenus,
} from './ui.js';

const REFRESH_MS = 3000;
const SINCE = ['24h', '7d', '30d', 'all'];
const ROW_CAP = 12;
const QUEUE_CAP = 6;
let token = $('meta[name="nika-token"]')?.content ?? '';

/* ---------- agent model: one status per agent ---------- */
/** attn = a live agent whose state is neither busy nor idle (the server sets `attention` for exactly those). */
export function sOf(a) {
  if (!a.live) return 'ended';
  if (a.attention) return 'attn';
  return a.state === 'busy' || a.state === 'idle' ? a.state : 'attn';
}
const reasonOf = (a) => a.attention ?? a.state;

function countsOf(list) {
  const c = { attn: 0, idle: 0, busy: 0, ended: 0, live: 0 };
  for (const a of list) {
    const s = sOf(a);
    c[s] += 1;
    if (s !== 'ended') c.live += 1;
  }
  return c;
}

/** Registered projects (app tier) joined with the snapshot's groups: a project without agents still gets a group. */
export function buildGroups() {
  const projects = isApp ? state.projects ?? [] : [];
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const byDir = new Map(projects.map((p) => [p.dir, p]));
  const seen = new Set();
  const out = [];
  for (const [i, g] of (state.data?.groups ?? []).entries()) {
    const project = byKey.get(g.key) ?? byDir.get(g.root) ?? null;
    if (project) seen.add(project.key);
    out.push({ key: project?.key ?? g.key ?? `g${i}`, project, label: project?.name ?? g.label, root: project?.dir ?? g.root, last: g.lastActivity ?? 0, agents: g.agents });
  }
  for (const p of projects) {
    if (!seen.has(p.key)) out.push({ key: p.key, project: p, label: p.name, root: p.dir, last: 0, agents: [] });
  }
  for (const g of out) g.counts = countsOf(g.agents);
  // "needs you" first everywhere, then groups with live agents, then the most recent
  return out.sort((a, b) => Number(b.counts.attn > 0) - Number(a.counts.attn > 0) || Number(b.counts.live > 0) - Number(a.counts.live > 0) || b.last - a.last || a.label.localeCompare(b.label));
}

function matches(a, g, q) {
  if (!q) return true;
  const hay = [a.name, a.title, a.gitBranch, a.cwd, a.worktree, a.modelLabel, a.lastPrompt, a.report?.status, a.pane?.id, g.label, a.attention].filter(Boolean).join('\n').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** A filtered dashboard keeps a group only for an agent that matches and is shown: ended agents count only while "Show ended" is on. */
function groupMatches(g, q) {
  return g.agents.some((a) => matches(a, g, q) && (state.showEnded || sOf(a) !== 'ended'));
}

const byStatus = (a, b) => ORDER[sOf(a)] - ORDER[sOf(b)] || (b.lastActivity ?? 0) - (a.lastActivity ?? 0);

/* ---------- actions that exist in both tiers ---------- */
/** The page token is per server process: after a restart, read the page again for a fresh one. */
async function reloadToken() {
  const res = await fetch('/', { cache: 'no-store' });
  const fresh = /<meta name="nika-token" content="([A-Za-z0-9_-]{8,128})">/.exec(await res.text());
  if (fresh) token = fresh[1];
}

export async function focusPane(pane, retry = true) {
  try {
    const res = await fetch('/api/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Nika-Token': token },
      body: JSON.stringify({ pane }),
    });
    if (res.status === 403 && retry) {
      await reloadToken();
      return focusPane(pane, false);
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) toast(`Focused tmux pane ${pane}`);
    else toast(`Could not focus ${pane}: ${body.error ?? res.status}`, { kind: 'error' });
  } catch {
    toast('Could not reach the nika server', { kind: 'error' });
  }
  return undefined;
}

let reportSeq = 0;
async function showReport(a) {
  const my = ++reportSeq; // a slower earlier answer must not land under a later title
  const dlg = $('#dlg-report');
  $('#report-title').textContent = `Report · ${a.report?.name ?? a.name}`;
  $('#report-body').textContent = 'Loading…';
  openDialog(dlg);
  let text;
  try {
    const res = await fetch(`/api/report/${encodeURIComponent(a.id)}`);
    text = res.ok ? await res.text() : `No report (${res.status}): ${await res.text()}`;
  } catch {
    text = 'Could not reach the nika server.';
  }
  if (my === reportSeq) $('#report-body').textContent = text;
}

/* ---------- rows ---------- */
function subagentsEl(a) {
  const id = `subs:${a.id}`;
  const running = a.subagents.filter((s) => s.state === 'running').length;
  const d = h('details', { class: 'subs', open: state.open.has(id) },
    h('summary', { 'data-fk': `sum:${id}` }, `${a.subagents.length} subagent${a.subagents.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`),
    h('ul', null, a.subagents.map((s) => h('li', null,
      h('span', { class: 'tag muted', text: s.state }),
      h('span', { class: 'sub-desc', text: s.description ?? '(no description)' }),
      s.type ? h('span', { class: 'sub-type', text: s.type }) : null,
      s.modelLabel ? h('span', { class: 'model', text: s.modelLabel }) : null,
      timeEl(s.lastActivity)))));
  d.addEventListener('toggle', () => { if (d.open) state.open.add(id); else state.open.delete(id); });
  return d;
}

function endedText(a) {
  if (a.report?.status) return a.report.status;
  if (a.report && a.report.rc !== null && a.report.rc !== undefined) return `Exited with code ${a.report.rc}`;
  return a.lastPrompt || 'Ended';
}

/** The Ended disclosure draws its rows under this scope, so a row's menu button has a different data-fk once its agent is ended. */
const endedScope = (scope) => `${scope}-e`;

/**
 * "End session..." (app tier): loads the End dialog on first use, puts focus on the row's menu button so Cancel returns there, and
 * opens it. `working` and `promptOpen` only choose the dialog's muted line. A chunk that fails to load or a dialog that throws shows
 * one fixed toast: the error's own text never reaches the page.
 */
async function endSession(a, menuFk, endedFk) {
  if (!isApp) return;
  try {
    const { openEndDialog } = await import('./end-dialog.js');
    $(`[data-fk="${CSS.escape(menuFk)}"]`)?.focus();
    openEndDialog({ pane: a.pane.id, name: a.name, working: a.state === 'busy', promptOpen: Boolean(a.attention), onEnded: () => afterEnd(a, endedFk) });
  } catch {
    toast("Couldn't open the End dialog.", { kind: 'error' });
  }
}

/**
 * Claude exited: toast, read the list again, then focus the row's menu button. /api/agents is cached for 1.5 s, so the list can
 * still show the agent live (its row is about to move into Ended and would drop focus): focus the button only when the agent now
 * shows as ended and its row, in the Ended group, is on screen. Otherwise (still live, gone, or the group is collapsed) the heading.
 */
async function afterEnd(a, endedFk) {
  toast('Session ended');
  await refresh();
  const now = (state.data?.groups ?? []).flatMap((g) => g.agents).find((x) => x.id === a.id);
  const btn = now && sOf(now) === 'ended' ? $(`[data-fk="${CSS.escape(endedFk)}"]`) : null;
  if (btn && btn.offsetParent !== null) btn.focus();
  else $('.screen:not([hidden]) h1')?.focus();
}

function rowEl(a, g, { scope, showProject = false }) {
  const s = sOf(a);
  const mode = isApp ? rowMode(a, state.modes.map) : null;
  const href = isApp ? sessionHref({ session: a.id, pane: a.pane?.id, project: g.project?.key }) : null;
  const fk = (k, sc = scope) => `${k}:${sc}:${a.id}`;
  const what = s === 'attn' ? reasonOf(a) : s === 'ended' ? endedText(a) : a.lastPrompt || '(no prompt yet)';

  const items = [{ text: 'Copy resume command', run: () => copyText(a.resumeCmd, 'resume command') }];
  if (a.report?.hasFile) items.push({ text: 'Show report', run: () => showReport(a) });
  if (a.bridgeUrl && SHAPE.claudeUrl.test(a.bridgeUrl)) items.push({ text: 'Open in claude.ai ↗', href: a.bridgeUrl });
  if (a.live && a.pane) items.push({ text: `Focus pane ${a.pane.id} in tmux`, run: () => focusPane(a.pane.id) });
  if (isApp && canEndRow(a, state.modes.map)) {
    items.push({ text: 'End session…', run: () => endSession(a, fk('m'), fk('m', endedScope(scope))) });
  }

  const li = h('li', { class: 'row', 'data-s': s },
    h('div', { class: 'c-st' }, statusEl(s)),
    isApp ? h('div', { class: 'c-mode' }, mode && modeEl(mode.mode, { confirmed: mode.confirmed, compact: true })) : null,
    h('div', { class: 'c-name' },
      href ? h('a', { class: 'name', href, 'data-fk': fk('n'), title: a.name, text: a.name }) : h('span', { class: 'name', title: a.name, text: a.name }),
      a.role === 'orchestrator' ? h('span', { class: 'tag', text: 'orchestrator' }) : null),
    h('div', { class: 'c-model' }, modelEl(a)),
    h('div', { class: 'c-what' },
      showProject ? h('span', { class: 'proj-chip', title: g.label, text: g.label.length > 18 ? `${g.label.slice(0, 17)}…` : g.label }) : null,
      h('span', { class: 'what', title: a.lastPrompt ?? '', text: what }),
      !showProject && a.gitBranch ? h('code', { class: 'branch', title: a.gitBranch, text: a.gitBranch }) : null),
    h('div', { class: 'c-act num', title: s === 'ended' ? 'Ended' : 'Last activity' }, h('span', { class: 'sr-only', text: 'Last activity: ' }), timeEl(a.lastActivity)),
    h('div', { class: 'c-pane', title: a.pane ? `tmux pane ${a.pane.id}` : 'No tmux pane' }, h('span', { class: 'sr-only', text: 'Pane ' }), a.pane?.id ?? '–'),
    h('div', { class: 'c-actions' }, menuEl(`More actions for ${a.name}`, items, fk('m'))),
    a.subagents?.length ? subagentsEl(a) : null);
  // a click anywhere on the row opens the session, unless the user is selecting text
  if (href) {
    li.addEventListener('click', (e) => {
      if (e.target.closest('a, button, summary, details, .menu-wrap') || !document.getSelection().isCollapsed) return;
      location.href = href;
    });
  }
  return li;
}

const rowsEl = (list, g, opts, label) => h('ul', { class: 'rows', 'aria-label': label }, list.map((a) => rowEl(a, g, opts)));

/**
 * Live rows (first ROW_CAP, then "show more"), the empty box and the "Ended" disclosure of one group (dash-model.js endedPlan).
 * Used by the dashboard and by the project view (`endedOpen`: its Ended section is always there, open).
 */
export function agentNodes(g, q, scope, { endedOpen = false } = {}) {
  const list = g.agents.filter((a) => matches(a, g, q)).sort(byStatus);
  const live = list.filter((a) => sOf(a) !== 'ended');
  const ended = list.filter((a) => sOf(a) === 'ended');
  const id = `ended:${scope}`;
  const plan = endedPlan({ live: live.length, ended: ended.length, showEnded: endedOpen || state.showEnded, collapsed: state.open.has(`!${id}`) });
  const nodes = [];
  const capId = `cap:${scope}`;
  const all = state.expanded.has(capId) || live.length <= ROW_CAP;
  const ul = live.length ? rowsEl(all ? live : live.slice(0, ROW_CAP), g, { scope }, `${g.label} agents`) : null;
  if (ul && !all) {
    ul.append(h('li', { class: 'more-row' }, h('button', { type: 'button', class: 'btn', 'data-fk': `more:${scope}`, text: `Show ${live.length - ROW_CAP} more live agents`, onclick: () => { state.expanded.add(capId); render(true); } })));
  }
  if (ul) nodes.push(ul);
  else if (!q && isApp && g.project && !ended.length) {
    nodes.push(h('div', { class: 'rows no-agents' }, h('span', { text: 'No agents in this project.' }), hooks.groupActions?.(g, { primary: true })));
  } else if (plan.noLiveLine) {
    nodes.push(h('div', { class: 'rows no-agents' }, h('span', { text: 'No live agents.' })));
  }
  if (plan.endedSection) {
    const d = h('details', { class: 'ended', open: plan.open },
      h('summary', { 'data-fk': `sum:${id}`, text: `Ended (${ended.length})` }),
      rowsEl(ended, g, { scope: endedScope(scope) }, `${g.label} ended agents`));
    d.addEventListener('toggle', () => {
      if (d.open) { state.open.add(id); state.open.delete(`!${id}`); } else { state.open.delete(id); state.open.add(`!${id}`); }
    });
    nodes.push(d);
  }
  return nodes;
}

/* ---------- dashboard ---------- */
function plainSummary(c) {
  if (!c.live) return 'No agents are running.';
  const rest = [c.idle ? `${c.idle} waiting for a prompt` : null, c.busy ? `${c.busy} working` : null].filter(Boolean).join(', ');
  const head = c.attn ? `${c.attn} agent${c.attn === 1 ? '' : 's'} need${c.attn === 1 ? 's' : ''} you.` : 'Nothing needs you.';
  return rest ? `${head} ${rest}.` : head;
}

function emptyEl(title, text, actions, iconName) {
  return h('div', { class: 'empty' }, iconName ? icon(iconName) : null, h('h2', { text: title }), h('p', null, text), actions ? h('div', { class: 'row-actions' }, actions) : null);
}

function queueEl(groups, q) {
  const waiting = groups.flatMap((g) => g.agents.filter((a) => ['attn', 'idle'].includes(sOf(a)) && matches(a, g, q)).map((a) => ({ a, g })))
    .sort((x, y) => ORDER[sOf(x.a)] - ORDER[sOf(y.a)] || (x.a.lastActivity ?? 0) - (y.a.lastActivity ?? 0)); // longest wait first
  if (!waiting.length) return null;
  const all = state.expanded.has('queue') || waiting.length <= QUEUE_CAP;
  const ul = h('ul', { class: 'rows', 'aria-label': 'Agents waiting on you' },
    (all ? waiting : waiting.slice(0, QUEUE_CAP)).map(({ a, g }) => rowEl(a, g, { scope: 'q', showProject: true })));
  if (!all) {
    ul.append(h('li', { class: 'more-row' }, h('button', { type: 'button', class: 'btn', 'data-fk': 'more:queue', text: `Show all ${waiting.length}`, onclick: () => { state.expanded.add('queue'); render(true); } })));
  }
  return h('section', { class: 'queue', 'aria-labelledby': 'q-h' },
    h('h2', { id: 'q-h' }, 'Waiting on you', h('small', { text: `${waiting.length} agent${waiting.length === 1 ? '' : 's'} · longest wait first` })), ul);
}

function groupEl(g, q) {
  const c = g.counts;
  return h('section', { class: 'grp', 'aria-labelledby': `g-${g.key}` },
    h('header', { class: 'grp-head' },
      h('h2', { id: `g-${g.key}`, tabindex: '-1', 'data-fk': `gh:${g.key}` }, isApp && g.project
        ? h('a', { href: `#project/${g.project.key}`, 'data-fk': `g:${g.key}`, title: g.label, text: g.label })
        : h('span', { title: g.label, text: g.label })),
      g.root ? h('span', { class: 'path mono', title: g.root, text: g.root }) : null,
      isApp && g.project ? rulesEl(g.project.rules?.state) : null,
      isApp && !g.project ? h('span', { class: 'tag muted', title: 'Agents run here, but the repository is not a nika project', text: 'Not a nika project' }) : null,
      h('p', { class: 'grp-counts' }, countsLine(c).map(([s, t]) => h('span', { 'data-s': s, text: t }))),
      // a project with no agents shows the same actions as the call to action in its body, once
      isApp && g.agents.length ? h('div', { class: 'grp-actions' }, hooks.groupActions?.(g, {})) : null),
    agentNodes(g, q, `g:${g.key}`));
}

function dashboardNodes() {
  const q = state.filter.trim().toLowerCase();
  const groups = buildGroups();
  if (!groups.length) {
    if (isApp) {
      return [emptyEl('Add your first project',
        'nika groups Claude Code agents by git repository. Add a repository to start an orchestrator, spawn agents and set up its rules.',
        [h('button', { type: 'button', class: 'btn primary lg', 'data-fk': 'add-first', onclick: () => hooks.addProject?.() }, icon('plus'), 'Add project…')], 'folder'),
      h('p', { class: 'empty-hint' }, 'Or from a terminal: ', h('code', { text: 'nika projects add <folder>' }))];
    }
    return [emptyEl('No agents in this window', 'Start a Claude Code session; it shows up here within a few seconds.')];
  }
  const nodes = [h('p', { class: 'plain-sum', text: plainSummary(countsOf(groups.flatMap((g) => g.agents))) })];
  const queue = queueEl(groups, q);
  if (queue) nodes.push(queue);
  let any = false;
  for (const g of groups) {
    if (q && !groupMatches(g, q)) continue;
    any = true;
    nodes.push(groupEl(g, q));
  }
  if (q && !any) {
    const endedMatch = !state.showEnded && groups.some((g) => g.agents.some((a) => sOf(a) === 'ended' && matches(a, g, q)));
    nodes.push(emptyEl('No agent matches', noMatchText({ q: state.filter.trim(), showEnded: state.showEnded, endedMatch })));
  }
  return nodes;
}

/* ---------- rebuild gate: never swap the DOM under the user ---------- */
let pointerDown = false;
export function interacting() {
  if (pointerDown || menuIsOpen() || $('dialog[open]')) return true;
  const sel = document.getSelection();
  return Boolean(sel && !sel.isCollapsed && $('.screen:not([hidden])')?.contains(sel.anchorNode));
}

/** Replace `host`'s children, keeping keyboard focus on the same control (matched by data-fk). */
export function swap(host, nodes) {
  const fk = host.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  host.replaceChildren(...nodes.flat().filter(Boolean));
  if (host.hasAttribute('aria-busy')) host.setAttribute('aria-busy', 'false');
  if (fk) $(`[data-fk="${CSS.escape(fk)}"]`, host)?.focus({ preventScroll: true });
}

let dashSig = '';
function renderDashboard(force) {
  const sig = JSON.stringify([state.data.groups, isApp ? state.projects : null, isApp ? state.modes.map : null, state.filter, state.showEnded, [...state.open], [...state.expanded], state.me?.tmux, state.me?.claude, state.error]);
  if (!force && (sig === dashSig || interacting())) return;
  dashSig = sig;
  const body = $('#dash-body');
  swap(body, dashboardNodes());
  body.classList.toggle('stale', Boolean(state.error));
}

/* ---------- chrome: summary, banners, live announcements ---------- */
const shownBanners = new Set();
let bannerSig = '';

function bannerList() {
  const out = [];
  if (!isApp) {
    out.push({ id: 'ro', kind: 'info', title: 'Read-only view', text: 'Starting agents, typing into sessions, rules and settings live in the nika desktop app. To open it, run', cmd: 'nika app' });
  }
  if (state.appError) {
    out.push({ id: 'denied', kind: 'danger', title: 'The app cannot reach its private server', text: 'Quit and open nika again. Agents still update below.' });
  }
  if (state.error && state.data) {
    const at = state.data.generatedAt ? new Date(state.data.generatedAt).toLocaleTimeString() : 'earlier';
    out.push({ id: 'offline', kind: 'danger', title: 'Lost connection to the nika server', text: `Showing the list from ${at}. Retrying every ${REFRESH_MS / 1000} seconds.`, action: { label: 'Retry now', run: () => refresh() } });
  }
  if (isApp && state.me && state.me.tmux === false) {
    out.push({ id: 'tmux', kind: 'danger', title: 'tmux not found', text: 'nika needs tmux to start agents, mirror their panes and type into them. Install it, then check again. The list still updates.', cmd: 'brew install tmux', action: { label: 'Check again', run: () => hooks.checkEnv?.() } });
  }
  if (isApp && state.me && state.me.claude === false) {
    out.push({ id: 'claude', kind: 'warn', title: 'Claude Code not found', text: 'Starting an orchestrator and spawning agents are off until claude is on your PATH. Running agents still show up here.', action: { label: 'Check again', run: () => hooks.checkEnv?.() } });
  }
  // Add to Applications (spec 3.14): macOS app tier, dashboard screen only; the server decides, the page only draws
  const copy = isApp && state.route.name === 'dashboard' ? copyBanner(state.me?.appCopy, state.appCopyUi) : null;
  if (copy) {
    out.push({
      id: 'app-copy', kind: 'info', icon: 'apps', title: copy.title, text: copy.text, busy: state.appCopyUi.busy, error: state.appCopyUi.error,
      actions: [
        { fk: 'primary', label: copy.primary.label, busyLabel: copy.primary.busy, primary: true, run: () => hooks.appCopyInstall?.() },
        { fk: 'ghost', label: copy.ghost.label, run: () => hooks.appCopyDismiss?.() },
      ],
    });
  }
  const problems = Object.entries(state.data?.sources ?? {}).filter(([k, v]) => v !== 'ok' && !(k === 'tmux' && isApp && state.me?.tmux === false));
  if (problems.length) {
    out.push({ id: 'sources', kind: 'warn', title: 'Some sources are unavailable', text: `The list may be incomplete. ${problems.map(([k, v]) => `${k}: ${v}`).join(' · ')}` });
  }
  return out;
}

function bannerEl(b) {
  const busy = b.busy === true;
  const buttons = (b.actions ?? []).map((a) => h('button', {
    type: 'button', class: `btn ${a.primary ? 'primary' : 'ghost'}`, 'data-fk': `banner:${b.id}:${a.fk}`,
    'aria-disabled': busy ? 'true' : null, 'aria-busy': busy && a.primary ? 'true' : null, onclick: () => { if (!busy) a.run(); },
  }, busy && a.primary ? [h('span', { class: 'spin', 'aria-hidden': 'true' }), ' ', a.busyLabel] : a.label));
  return h('div', { class: 'banner', 'data-kind': b.kind, 'data-id': b.id, role: b.kind === 'info' ? 'note' : shownBanners.has(b.id) ? null : 'alert' },
    icon(b.icon ?? (b.kind === 'info' ? 'term' : 'warn')),
    h('p', null, h('strong', { text: b.title }), ' ', b.text, b.cmd ? [' ', h('code', { text: b.cmd })] : null,
      b.error ? h('span', { class: 'banner-err', role: 'alert' }, icon('warn'), h('span', { text: b.error })) : null),
    buttons.length ? h('div', { class: 'acts' }, buttons) : null,
    b.action ? h('button', { type: 'button', class: 'btn', text: b.action.label, onclick: b.action.run }) : null);
}

function renderBanners() {
  const list = bannerList();
  const sig = JSON.stringify(list.map(({ id, kind, title, text, cmd, busy, error }) => [id, kind, title, text, cmd, busy, error]));
  if (sig === bannerSig) return;
  bannerSig = sig;
  swap($('#banners'), list.map(bannerEl));
  shownBanners.clear();
  for (const b of list) shownBanners.add(b.id);
}

const prevStatus = new Map();
let primed = false; // the first snapshot is the baseline, nothing is announced for it
/** One grouped message per refresh, only for changes into "needs you", "waiting" or "ended". */
function announceChanges() {
  const groups = buildGroups();
  const next = new Map();
  const changed = { attn: [], idle: [], ended: [] };
  for (const g of groups) {
    for (const a of g.agents) {
      const s = sOf(a);
      next.set(a.id, s);
      const was = prevStatus.get(a.id);
      if (!primed || was === s || s === 'busy') continue;
      if (was === undefined && s !== 'attn') continue;
      changed[s].push(`${a.name} in ${g.label}`);
    }
  }
  primed = true;
  prevStatus.clear();
  for (const [k, v] of next) prevStatus.set(k, v);
  const list = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));
  const parts = [];
  if (changed.attn.length) parts.push(changed.attn.length === 1 ? `${changed.attn[0]} needs you` : `${changed.attn.length} agents need you: ${list(changed.attn)}`);
  if (changed.idle.length) parts.push(changed.idle.length === 1 ? `${changed.idle[0]} is waiting for your prompt` : `${changed.idle.length} agents are waiting for your prompt: ${list(changed.idle)}`);
  if (changed.ended.length) parts.push(changed.ended.length === 1 ? `${changed.ended[0]} ended` : `${changed.ended.length} agents ended: ${list(changed.ended)}`);
  if (parts.length) announce(parts.join('. '));
}

function renderChrome() {
  const groups = buildGroups();
  const c = countsOf(groups.flatMap((g) => g.agents));
  $('#dash-sum').replaceChildren(...countsLine(c).map(([s, t]) => h('span', { 'data-s': s }, h('span', { class: 'st', 'data-s': s }, h('span', { class: 'st-g', 'aria-hidden': 'true' })), t)));
  if (state.route.name === 'dashboard') document.title = c.attn ? `(${c.attn}) nika · Claude agents` : 'nika · Claude agents';
  renderBanners();
}

export function render(force = false) {
  syncHints();
  if (!state.data) return;
  renderChrome();
  hooks.renderSide?.();
  if (state.route.name === 'dashboard') renderDashboard(force);
  else if (state.route.name === 'project') hooks.renderProject?.(force);
  tickTimes();
}

/* ---------- poll loop ---------- */
let timer = null;
let seq = 0;
export async function refresh() {
  clearTimeout(timer);
  const my = ++seq; // an answer for an older window must not overwrite a newer one
  try {
    const [data] = await Promise.all([
      getJSON(`/api/agents?since=${encodeURIComponent(state.since)}`),
      hooks.pollApp?.(),
    ]);
    if (my !== seq) return;
    state.data = data;
    state.error = null;
    announceChanges();
  } catch (err) {
    if (my !== seq) return;
    state.error = err.message;
    if (!state.data) {
      $('#dash-body').setAttribute('aria-busy', 'false');
      $('#dash-body').replaceChildren(emptyEl('Cannot load agents', `${err.message}. Retrying every ${REFRESH_MS / 1000} seconds.${isApp ? '' : ' Is the service running? brew services start nika'}`));
      renderBanners();
    }
  } finally {
    if (my === seq && !document.hidden) timer = setTimeout(refresh, REFRESH_MS);
  }
  try {
    render();
  } catch (err) {
    console.error('nika: render failed', err); // keep polling even if one snapshot cannot be drawn
  }
}

/* ---------- router (hash routes; nothing in a route is a path or free text) ---------- */
function parseRoute() {
  const hash = location.hash;
  if (isApp) {
    const m = /^#project\/([a-z0-9]{16})$/.exec(hash);
    if (m) return { name: 'project', key: m[1] };
    if (hash === '#settings') return { name: 'settings' };
  }
  return { name: 'dashboard' };
}

function route(initial = false) {
  // the tray's "Add project…" navigates here: act once, then leave no trace in the URL (browser tier: ignored)
  if (isApp && location.hash === '#add-project') {
    history.replaceState(null, '', '#dashboard');
    hooks.addProject?.();
  }
  state.route = parseRoute();
  const name = state.route.name;
  for (const s of $$('[data-screen]')) s.hidden = s.dataset.screen !== name;
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (name === 'dashboard') document.title = 'nika · Claude agents';
  if (name === 'settings') document.title = 'Settings · nika';
  if (name === 'project') hooks.enterProject?.(state.route.key);
  if (name === 'settings') hooks.enterSettings?.();
  render(true);
  if (!initial) $(`[data-screen="${name}"] h1`)?.focus();
}

/* ---------- keyboard shortcuts window (docs/design/spec.md 4.6; the rules and the copy are in shortcuts.js) ---------- */
/** "?" needs the Settings switch, which only the app tier can store: the browser tier never answers to it (Mod+/ still does). */
function singleKey() {
  return isApp && state.settings?.ui?.singleKeyShortcuts !== false;
}

function openKbd(opener) {
  openShortcuts({ window: 'dashboard', tier: isApp ? 'app' : 'browser', mac: MAC, singleKey: singleKey(), opener });
}

let hintSig = null;
/** The buttons' title and aria-keyshortcuts name "?" only while the switch is on; a Settings save redraws through render(). */
function syncHints() {
  const on = singleKey();
  if (on === hintSig) return;
  hintSig = on;
  const hint = helpHint({ mac: MAC, singleKey: on });
  for (const b of $$('[data-kbd-open]')) {
    b.title = hint.title;
    b.setAttribute('aria-keyshortcuts', hint.keys);
  }
}

/* ---------- controls and keyboard ---------- */
function initControls() {
  const since = $('#dash-since');
  since.value = state.since;
  since.addEventListener('change', () => {
    state.since = since.value;
    save('since', state.since);
    dashSig = '';
    refresh();
  });
  const ended = $('#dash-ended');
  ended.checked = state.showEnded;
  ended.addEventListener('change', () => {
    state.showEnded = ended.checked;
    save('showEnded', state.showEnded);
    resetEndedState(state.open); // every Ended section starts open again, folded by hand or not
    render(true); // a user action always redraws, even with a selection in the list
  });
  $('#dash-filter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    render(true);
  });
  $('#dlg-report').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  document.addEventListener('pointerdown', () => { pointerDown = true; });
  // pointerup is not always delivered (context menu, native select popup): clear on these too
  for (const ev of ['pointerup', 'pointercancel', 'contextmenu']) document.addEventListener(ev, () => { pointerDown = false; });
  window.addEventListener('blur', () => { pointerDown = false; });
  document.addEventListener('visibilitychange', () => {
    pointerDown = false;
    if (!document.hidden) refresh();
  });
  window.addEventListener('hashchange', () => route());
  for (const b of $$('[data-kbd-open]')) b.addEventListener('click', () => openKbd(b));
  for (const a of $$('a.back')) {
    const hint = backHint({ label: $('span', a).textContent, mac: MAC });
    a.title = hint.title;
    a.setAttribute('aria-keyshortcuts', hint.keys);
  }
  // key hints in the sidebar follow the platform (Cmd on macOS, Ctrl elsewhere)
  for (const k of $$('kbd[data-mod]')) k.textContent = `${MAC ? '⌘' : 'Ctrl+'}${k.dataset.mod}`;
  for (const a of $$('[data-nav]')) a.setAttribute('aria-keyshortcuts', `${MAC ? 'Meta' : 'Control'}+${a.dataset.nav === 'settings' ? ',' : '1'}`);
}

/** Mod = Cmd on macOS, Ctrl elsewhere. No single-character shortcuts (WCAG 2.1.4). */
function initKeys() {
  document.addEventListener('keydown', (e) => {
    const mod = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const modal = $('dialog[open]');
    if (mod && e.key === 'Enter') {
      const go = modal ? $('.btn.primary:not(:disabled)', modal) : state.route.name === 'settings' ? $('#set-save') : null;
      if (go && go.getAttribute('aria-disabled') !== 'true') {
        e.preventDefault();
        go.click();
      }
      return;
    }
    if (wantsHelp(e, { mac: MAC, singleKey: singleKey(), textEntry: isTextEntry(e.target), passthrough: false, dialogOpen: Boolean(modal) })) {
      e.preventDefault();
      openKbd(document.activeElement);
      return;
    }
    if (!isApp || modal) return;
    if (mod && !e.altKey && !e.shiftKey && e.key === '1') {
      e.preventDefault();
      location.hash = '#dashboard';
    } else if (mod && !e.altKey && !e.shiftKey && e.key === ',') {
      e.preventDefault();
      location.hash = '#settings';
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      hooks.addProject?.();
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && state.route.name === 'dashboard') {
      e.preventDefault();
      $('#dash-filter').focus();
    } else if (wantsBack(e, { mac: MAC }) && state.route.name !== 'dashboard') {
      e.preventDefault();
      location.hash = '#dashboard';
    }
  });
}

/* ---------- start ---------- */
async function boot() {
  const since = load('since', '7d');
  state.since = SINCE.includes(since) ? since : '7d';
  state.showEnded = load('showEnded', false) === true;
  document.body.dataset.tier = isApp ? 'app' : 'browser';
  // the browser tier gets no privileged markup at all (removed, not hidden)
  for (const el of $$(isApp ? '[data-browser-only]' : '[data-app-only]')) el.remove();
  initDialogs();
  initMenus();
  initControls();
  initKeys();
  if (isApp) {
    try {
      const [project] = await Promise.all([import('./project.js'), import('./settings.js')]);
      await project.initApp();
    } catch (err) {
      console.error('nika: app modules failed', err);
    }
  }
  route(true);
  refresh();
}

boot();
