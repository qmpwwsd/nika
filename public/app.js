// nika dashboard client. All server data is rendered with textContent (never innerHTML).
const REFRESH_MS = 3000;
let TOKEN = document.querySelector('meta[name="nika-token"]')?.content ?? '';
const $ = (id) => document.getElementById(id);

const STATE_LABEL = { busy: 'Working', idle: 'Waiting for input', shell: 'Running shell', ended: 'Ended' };
const SINCE_LABEL = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', all: 'history' };

function load(key, fallback) {
  try {
    const v = localStorage.getItem(`nika.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`nika.${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable: per-viewer convenience only
  }
}

const state = {
  since: ['24h', '7d', '30d', 'all'].includes(load('since', '7d')) ? load('since', '7d') : '7d',
  showEnded: load('showEnded', true) !== false,
  search: '',
  open: new Set(),
  data: null,
  sig: '',
  error: null,
  timer: null,
  seq: 0,
  reportSeq: 0,
  pointerDown: false,
};

/* ---------- tiny DOM helper ---------- */
function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

/* ---------- time ---------- */
function ago(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function timeEl(prefix, ms) {
  // Out-of-range numbers would make toISOString() throw and stop the refresh loop (review F15).
  const ok = Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime());
  return h('time', {
    'data-ts': ok ? ms : null,
    'data-prefix': prefix,
    datetime: ok ? new Date(ms).toISOString() : null,
    title: ok ? new Date(ms).toLocaleString() : null,
    text: `${prefix}${ok ? ago(ms) : '–'}`,
  });
}
function tickTimes() {
  for (const t of document.querySelectorAll('time[data-ts]')) {
    t.textContent = `${t.dataset.prefix}${ago(Number(t.dataset.ts))}`;
  }
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- actions ---------- */
/** The token is per server process: after a restart or upgrade, fetch the page again and re-read it (review F7). */
async function reloadToken() {
  const res = await fetch('/', { cache: 'no-store' });
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  TOKEN = doc.querySelector('meta[name="nika-token"]')?.content ?? TOKEN;
}

async function focusPane(pane, retry = true) {
  try {
    const res = await fetch('/api/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Nika-Token': TOKEN },
      body: JSON.stringify({ pane }),
    });
    if (res.status === 403 && retry) {
      await reloadToken();
      return focusPane(pane, false);
    }
    const body = await res.json().catch(() => ({}));
    toast(res.ok ? `Focused tmux pane ${pane}` : `Could not focus ${pane}: ${body.error ?? res.status}`);
  } catch {
    toast('Could not reach the nika server');
  }
  return undefined;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${label}`);
  } catch {
    window.prompt(`Copy ${label}:`, text);
  }
}

async function showReport(agent) {
  const my = ++state.reportSeq; // a slower earlier response must not land under a later title (review F16)
  const dlg = $('report');
  $('report-title').textContent = `Report · ${agent.report?.name ?? agent.name}`;
  $('report-body').textContent = 'Loading…';
  if (!dlg.open) dlg.showModal();
  let text;
  try {
    const res = await fetch(`/api/report/${encodeURIComponent(agent.id)}`);
    text = res.ok ? await res.text() : `No report (${res.status}): ${await res.text()}`;
  } catch {
    text = 'Could not reach the nika server.';
  }
  if (my === state.reportSeq) $('report-body').textContent = text;
}

/* ---------- rendering ---------- */
function stateClass(a) {
  if (!a.live) return 'ended';
  return a.state === 'busy' || a.state === 'idle' ? a.state : 'other';
}
function modelClass(label) {
  const m = /^(opus|sonnet|haiku|fable)/i.exec(label ?? '');
  return m ? m[1].toLowerCase() : '';
}
function countsChips(c) {
  return [
    c.busy ? h('span', { class: 'pill count-busy', text: `${c.busy} working` }) : null,
    c.idle ? h('span', { class: 'pill count-idle', text: `${c.idle} waiting` }) : null,
    c.other ? h('span', { class: 'pill count-other', text: `${c.other} other` }) : null,
    c.ended ? h('span', { class: 'pill count-ended', text: `${c.ended} ended` }) : null,
  ];
}

/** Disclosure whose body is built only when opened, so a long collapsed "Ended" list costs nothing (review F14). */
function details(id, summaryNodes, buildBody, defaultOpen = false) {
  const isOpen = state.open.has(id) || (defaultOpen && !state.open.has(`!${id}`));
  const d = h('details', { class: id.startsWith('ended:') ? 'ended-list' : 'subs', open: isOpen },
    h('summary', { 'data-fk': `sum:${id}` }, summaryNodes));
  let built = false;
  const build = () => {
    if (!built) {
      built = true;
      d.append(buildBody());
    }
  };
  if (isOpen) build();
  d.addEventListener('toggle', () => {
    if (d.open) {
      build();
      state.open.add(id);
      state.open.delete(`!${id}`);
    } else {
      state.open.delete(id);
      state.open.add(`!${id}`);
    }
  });
  return d;
}

function card(a) {
  const sc = stateClass(a);
  const label = STATE_LABEL[a.live ? a.state : 'ended'] ?? a.state;
  const badges = [
    h('span', { class: `pill ${sc}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), label),
    a.worktree ? h('span', { class: 'tag', title: 'git worktree', text: a.worktree }) : null,
    a.pane ? h('span', { class: 'chip mono', title: `tmux pane ${a.pane.id} · ${a.pane.session ?? ''} · ${a.pane.title ?? ''}`, text: a.pane.id }) : null,
  ];
  const actions = [];
  if (a.live && a.pane) {
    actions.push(h('button', { type: 'button', class: 'btn primary', 'data-fk': `focus:${a.id}`, onclick: () => focusPane(a.pane.id), 'aria-label': `Focus tmux pane ${a.pane.id} of ${a.name}`, text: 'Focus pane' }));
  }
  if (a.bridgeUrl && a.bridgeUrl.startsWith('https://claude.ai/')) {
    actions.push(h('a', { class: 'btn', href: a.bridgeUrl, target: '_blank', rel: 'noopener noreferrer', 'data-fk': `rc:${a.id}`, 'aria-label': `Open ${a.name} in claude.ai (new tab)`, text: 'Open in claude.ai ↗' }));
  }
  actions.push(h('button', { type: 'button', class: 'btn', 'data-fk': `copy:${a.id}`, onclick: () => copyText(a.resumeCmd, 'resume command'), 'aria-label': `Copy resume command for ${a.name}`, text: 'Copy resume' }));
  if (a.report?.hasFile) {
    actions.push(h('button', { type: 'button', class: 'btn', 'data-fk': `report:${a.id}`, onclick: () => showReport(a), 'aria-label': `Show report of ${a.name}`, text: 'Report' }));
  }

  const subs = a.subagents?.length
    ? details(`subs:${a.id}`,
      `${a.subagents.length} subagent${a.subagents.length === 1 ? '' : 's'}${a.subagents.some((s) => s.state === 'running') ? ` · ${a.subagents.filter((s) => s.state === 'running').length} running` : ''}`,
      () => h('ul', null, a.subagents.map((s) => h('li', null,
        h('span', { class: `pill ${s.state === 'running' ? 'busy' : 'ended'}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), s.state),
        h('span', { class: 'sub-desc', text: s.description ?? '(no description)' }),
        s.type ? h('span', { class: 'sub-type', text: s.type }) : null,
        s.modelLabel ? h('span', { class: `chip model ${modelClass(s.modelLabel)}`, text: s.modelLabel }) : null,
        timeEl('', s.lastActivity),
      ))))
    : null;

  return h('article', { class: `card ${sc}`, 'data-id': a.id, 'aria-label': `${a.name}, ${label}` },
    h('div', { class: 'card-top' },
      h('h3', { text: a.name }),
      a.modelLabel ? h('span', { class: `chip model ${modelClass(a.modelLabel)}`, title: a.model, text: a.modelLabel }) : null,
    ),
    h('div', { class: 'badges' }, badges),
    a.title && a.title !== a.name ? h('p', { class: 'card-title', text: a.title }) : null,
    a.gitBranch ? h('p', { class: 'branch' }, h('code', { title: a.gitBranch, text: a.gitBranch })) : null,
    h('div', { class: 'meta' },
      timeEl('started ', a.startedAt),
      h('span', { 'aria-hidden': 'true', text: '·' }),
      timeEl(a.live ? 'active ' : 'last active ', a.lastActivity),
      a.pid ? h('span', { class: 'mono', title: 'process id', text: `pid ${a.pid}` }) : null,
    ),
    a.lastPrompt ? h('p', { class: 'prompt', title: a.lastPrompt, text: a.lastPrompt }) : null,
    a.report?.status ? h('p', { class: 'report-status', text: a.report.status }) : null,
    a.report && a.report.rc !== null && !a.report.status ? h('p', { class: 'meta', text: `report ${a.report.name} · exit ${a.report.rc}` }) : null,
    h('div', { class: 'actions' }, actions),
    subs,
  );
}

function matches(a, q) {
  if (!q) return true;
  const hay = [a.name, a.title, a.gitBranch, a.cwd, a.worktree, a.modelLabel, a.lastPrompt, a.report?.status, a.pane?.id, a.id]
    .filter(Boolean).join('\n').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderGroups() {
  const root = $('groups');
  const data = state.data;
  const q = state.search.trim().toLowerCase();
  const sections = [];
  for (const g of data.groups) {
    const live = g.agents.filter((a) => a.live && matches(a, q));
    const ended = state.showEnded ? g.agents.filter((a) => !a.live && matches(a, q)) : [];
    if (!live.length && !ended.length) continue;
    sections.push(h('section', { class: 'group', 'aria-labelledby': `g-${sections.length}` },
      h('div', { class: 'group-head' },
        h('h2', { id: `g-${sections.length}`, text: g.label }),
        h('span', { class: 'group-root', text: g.root ?? '' }),
        h('div', { class: 'group-counts' }, countsChips(g.counts)),
      ),
      live.length ? h('div', { class: 'cards' }, live.map(card)) : null,
      ended.length
        ? details(`ended:${g.key}`, `Ended (${ended.length})`, () => h('div', { class: 'cards' }, ended.map(card)), Boolean(q) || !live.length)
        : null,
    ));
  }
  if (!sections.length) {
    const none = !data.groups.length;
    sections.push(h('div', { class: 'empty' },
      h('strong', { text: none ? `No agents in the ${SINCE_LABEL[state.since]}` : 'Nothing matches' }),
      none
        ? 'Start a Claude Code session; it shows up here within a few seconds.'
        : (q ? `No agent matches “${state.search.trim()}”.` : 'Only ended agents exist in this window. Turn on “Show ended”.'),
    ));
  }

  const focusKey = document.activeElement?.closest?.('#groups') ? document.activeElement.dataset.fk : null;
  root.replaceChildren(...sections);
  root.setAttribute('aria-busy', 'false');
  if (focusKey) root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function renderChrome() {
  const c = state.data.counts;
  const chips = countsChips(c).filter(Boolean);
  if (!c.total) chips.push(h('span', { class: 'pill count-ended', text: 'no agents' }));
  $('totals').replaceChildren(...chips);
  document.title = c.busy ? `(${c.busy}) nika · Claude agents` : 'nika · Claude agents';

  const banner = $('banner');
  const problems = Object.entries(state.data.sources).filter(([, v]) => v !== 'ok');
  if (state.error) {
    banner.className = 'banner error';
    banner.replaceChildren(`Can't reach the nika server (${state.error}). Showing the last data; retrying every ${REFRESH_MS / 1000} s.`);
    banner.hidden = false;
  } else if (problems.length) {
    banner.className = 'banner';
    banner.replaceChildren('Some sources are unavailable; the list may be incomplete.',
      h('ul', null, problems.map(([k, v]) => h('li', null, h('strong', { text: `${k}: ` }), v))));
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

/** True while the user selects text in the list or holds a pointer down: a rebuild then would drop the selection or the click. */
function interacting() {
  if (state.pointerDown) return true;
  const sel = document.getSelection();
  return Boolean(sel && !sel.isCollapsed && $('groups').contains(sel.anchorNode));
}

function render(force = false) {
  if (!state.data) return;
  renderChrome();
  const sig = JSON.stringify([state.data.groups, state.search, state.showEnded]);
  // While the user interacts, keep the old DOM; the next tick retries because state.sig is unchanged (review F14).
  if (force || (sig !== state.sig && !interacting())) {
    state.sig = sig;
    renderGroups();
  }
  // The stamp names the snapshot the list shows; while a rebuild waits for the user it says so (verify N5).
  $('updated').textContent = sig === state.sig
    ? `Updated ${new Date(state.data.generatedAt).toLocaleTimeString()} · refreshes every ${REFRESH_MS / 1000} s`
    : 'Paused while you select or click · resumes when you let go';
  tickTimes();
}

/* ---------- loop ---------- */
async function refresh() {
  clearTimeout(state.timer);
  const my = ++state.seq; // a response for an older window must not overwrite a newer one (review F16)
  try {
    const res = await fetch(`/api/agents?since=${encodeURIComponent(state.since)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (my !== state.seq) return;
    state.data = data;
    state.error = null;
  } catch (err) {
    if (my !== state.seq) return;
    state.error = err.message;
    if (!state.data) {
      $('groups').setAttribute('aria-busy', 'false');
      $('groups').replaceChildren(h('div', { class: 'empty' }, h('strong', { text: 'Cannot load agents' }), `${err.message}. Retrying…`));
      const banner = $('banner');
      banner.className = 'banner error';
      banner.textContent = "Can't reach the nika server. Is it running? brew services start nika";
      banner.hidden = false;
    }
  } finally {
    if (my === state.seq && !document.hidden) state.timer = setTimeout(refresh, REFRESH_MS);
  }
  try {
    render();
  } catch (err) {
    console.error('nika: render failed', err); // keep polling even if one snapshot cannot be drawn (review F15)
  }
}

function init() {
  const since = $('since');
  since.value = state.since;
  since.addEventListener('change', () => {
    state.since = since.value;
    state.sig = '';
    save('since', state.since);
    refresh();
  });
  const showEnded = $('showEnded');
  showEnded.checked = state.showEnded;
  showEnded.addEventListener('change', () => {
    state.showEnded = showEnded.checked;
    save('showEnded', state.showEnded);
    render(true); // user action: always redraw, even with a selection in the list (verify N5)
  });
  $('search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render(true);
  });
  $('report-close').addEventListener('click', () => $('report').close());
  $('report').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  document.addEventListener('pointerdown', () => { state.pointerDown = true; });
  // pointerup is not always delivered (context menu, native select popup): clear on these too (verify N5)
  for (const ev of ['pointerup', 'pointercancel', 'contextmenu']) document.addEventListener(ev, () => { state.pointerDown = false; });
  window.addEventListener('blur', () => { state.pointerDown = false; });
  document.addEventListener('visibilitychange', () => {
    state.pointerDown = false;
    if (!document.hidden) refresh();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !$('report').open) {
      e.preventDefault();
      $('search').focus();
    }
  });
  refresh();
}

init();
