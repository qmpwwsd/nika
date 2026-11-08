// nika session window (app tier): transcript history + live terminal mirror + input composer for one agent.
// URL: session.html?session=<UUID>&pane=<%n>&project=<key>   (pane is sent as %25n, i.e. encodeURIComponent('%n')).
// Rules: every string from the server is rendered with textContent (h() from dom.js, applyMirror from mirror-render.js);
// no innerHTML, no inline handlers, element.style only for numbers this file computes. Contracts: docs/contracts/api-app.md.
import { h } from './dom.js';
import { isApp, appFetch, getJSON, applyTheme } from './api.js';
import { toRenderModel, applyMirror, planSend, planPaste, chunkText, keyForEvent, KEY_LABEL } from './mirror-render.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PANE_ID = /^%\d{1,6}$/;
const PROJECT_KEY = /^[a-z0-9]{16}$/;
const CLAUDE_SESSION = /^session_[A-Za-z0-9]{1,64}$/;
const ENTRY_ID = /^\d{1,15}:\d{1,5}$/;
const ETAG = /^[0-9a-f]{1,64}$/;
const KINDS = new Set(['text', 'thinking', 'tool_use', 'tool_result']);

const DOTS = String.fromCharCode(0x2026);
const TIMES = String.fromCharCode(0xd7);
const MID = ` ${String.fromCharCode(0xb7)} `;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}${DOTS}` : s);

function storeGet(key) {
  try {
    return localStorage.getItem(`nika.${key}`);
  } catch {
    return null; // storage unavailable: per-viewer convenience only
  }
}
function storeSet(key, value) {
  try {
    localStorage.setItem(`nika.${key}`, value);
  } catch {
    // ignore
  }
}

/** A URL parameter that matches `shape`. The raw query is tried too, so a bare `pane=%12` (not percent-encoded) still works. */
function param(name, shape) {
  const decoded = new URLSearchParams(location.search).get(name);
  if (decoded !== null && shape.test(decoded)) return decoded;
  const raw = new RegExp(`[?&]${name}=([^&#]*)`).exec(location.search)?.[1];
  return raw !== undefined && shape.test(raw) ? raw : null;
}

const sessionId = param('session', UUID);
const paneId = param('pane', PANE_ID);
const projectKey = param('project', PROJECT_KEY);

/** appFetch that never throws: { status, body }; status 0 = network failure. */
async function call(path, opts = {}) {
  try {
    const r = await appFetch(path, opts);
    return { status: r.status, body: r.body ?? null };
  } catch {
    return { status: 0, body: null };
  }
}

const serverMessage = (r, fallback) => {
  const m = r.body?.message;
  return typeof m === 'string' && m ? clip(m, 200) : fallback;
};

// ---- small UI helpers --------------------------------------------------------------------------------------------

let announceTimer = 0;
function announce(msg) {
  const el = $('announcer');
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = msg; }, 30);
}

function say(msg) {
  $('echo').textContent = msg;
}

let problemTimer = 0;
function showProblem(msg, kind = 'warn', ms = 0) {
  const el = $('problem');
  el.textContent = msg;
  el.className = kind === 'error' ? 'problem error' : 'problem';
  clearTimeout(problemTimer);
  if (ms) problemTimer = setTimeout(() => { el.textContent = ''; }, ms);
}
const clearProblem = () => showProblem('');

const notices = [];
function showNotice(msg) {
  notices.push(msg);
  const el = $('notice');
  el.textContent = notices.join(' ');
  el.hidden = false;
}

const STATUS_LABEL = { attn: 'Needs you', idle: 'Waiting', busy: 'Working', ended: 'Ended' };
function statusOf(agent) {
  if (!agent.live) return 'ended';
  if (agent.attention) return 'attn';
  if (agent.state === 'busy') return 'busy';
  return 'idle';
}
function setStatus(kind) {
  $('sess-st').replaceChildren(h('span', { class: 'st pill', 'data-s': kind }, h('span', { class: 'st-g', 'aria-hidden': 'true' }), STATUS_LABEL[kind]));
}

/** `https://claude.ai/code/session_<id>` from data we received, only when the id has the exact shape. */
function claudeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const prefix = 'https://claude.ai/code/';
  const id = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return CLAUDE_SESSION.test(id) ? `${prefix}${id}` : null;
}

// ---- header and agent poll ---------------------------------------------------------------------------------------

const A = { name: 'the agent', kind: null, projectLooked: false };

function applyAgent(agent, group) {
  const untitled = !agent.name || (sessionId && agent.name === sessionId.slice(0, 8));
  A.name = untitled ? 'untitled session' : String(agent.name);
  const h1 = $('sess-h');
  h1.textContent = A.name;
  h1.classList.toggle('untitled', untitled);
  h1.title = A.name;
  document.title = `${A.name}${MID}nika`;
  if (group?.label) {
    $('proj').textContent = String(group.label);
    $('back').title = String(group.label);
  }
  const model = $('sess-model');
  model.textContent = agent.modelLabel || agent.model || '-';
  model.hidden = false;
  const pane = paneId ?? agent.pane?.id;
  $('meta-pane').hidden = !(typeof pane === 'string' && PANE_ID.test(pane));
  $('sess-pane').textContent = typeof pane === 'string' && PANE_ID.test(pane) ? pane : '';
  $('sess-branch').hidden = !agent.gitBranch;
  $('sess-branch').textContent = agent.gitBranch ? String(agent.gitBranch) : '';

  const link = $('claude-link');
  const url = claudeUrl(agent.bridgeUrl);
  link.hidden = !url;
  if (url) link.href = url;

  const kind = statusOf(agent);
  if (kind !== A.kind) {
    if (A.kind !== null && kind !== 'busy') announce(`${A.name} ${kind === 'attn' ? `needs you: ${agent.attention}` : kind === 'idle' ? 'is waiting for your prompt' : 'ended'}`);
    A.kind = kind;
    setStatus(kind);
  }
  const note = $('attn-note');
  note.hidden = kind !== 'attn';
  if (kind === 'attn') $('attn-text').textContent = `${A.name} needs you: ${agent.attention}. Use the arrow keys and Enter to choose, or Esc to refuse.`;
  $('composer-label').textContent = `Message to ${A.name}. Enter sends, Shift+Enter adds a line, Escape goes to the pane.`;
  if (!$('composer').disabled) $('composer').placeholder = `Message ${A.name}${DOTS}`;
  $('pb-pane').textContent = paneId ?? '';
}

async function refreshAgent() {
  let snapshot;
  try {
    snapshot = await getJSON('/api/agents?since=all'); // public route (both tiers), not under /api/app
  } catch {
    return; // the header keeps its last values; the next poll tries again
  }
  if (!Array.isArray(snapshot?.groups)) return;
  let hit = null;
  for (const g of snapshot.groups) {
    for (const a of g.agents ?? []) {
      if (sessionId ? a.id === sessionId : paneId && a.live && a.pane?.id === paneId) hit = { a, g };
    }
  }
  if (hit) {
    applyAgent(hit.a, hit.g);
    return;
  }
  if (projectKey && !A.projectLooked) {
    A.projectLooked = true;
    const p = await call('/api/app/projects');
    const name = p.body?.projects?.find((x) => x.key === projectKey)?.name;
    if (typeof name === 'string') $('proj').textContent = name;
  }
}

function startAgentPoll() {
  const loop = async () => {
    if (!document.hidden) await refreshAgent();
    setTimeout(loop, 3000);
  };
  loop();
}

// ---- history -----------------------------------------------------------------------------------------------------

const MAX_ENTRIES = 600; // DOM cap: older (or newer) entries are dropped from the page when more are loaded
const H = { items: [], ids: new Set(), older: null, liveEdge: true, loaded: false, busy: false };

const keyOf = (id) => {
  const [off, block] = id.split(':').map(Number);
  return off * 100000 + block;
};
const offsetOf = (id) => Number(id.slice(0, id.indexOf(':')));
const nextBefore = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

function cleanEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && ENTRY_ID.test(e.id)
      && (e.role === 'user' || e.role === 'assistant') && KINDS.has(e.kind) && typeof e.text === 'string')
    .map((e) => ({
      id: e.id,
      at: typeof e.at === 'string' ? e.at : '',
      role: e.role,
      kind: e.kind,
      text: e.text.slice(0, 40000),
      tool: typeof e.tool === 'string' ? e.tool.slice(0, 100) : '',
      truncated: e.truncated === true,
    }));
}

function textBlock(e) {
  const body = h('div', { class: 'hx-text', id: `hx-${e.id.replace(':', '-')}`, text: e.text });
  const lines = e.text.split('\n').length;
  if (lines <= 12 && e.text.length <= 1500) return [body];
  body.classList.add('clamped');
  const showAll = lines > 1 ? `Show all ${lines} lines` : 'Show all';
  const more = h('button', { type: 'button', class: 'hx-more', 'aria-expanded': 'false', 'aria-controls': body.id, text: showAll });
  more.addEventListener('click', () => {
    const open = body.classList.toggle('clamped') === false;
    more.textContent = open ? 'Show less' : showAll;
    more.setAttribute('aria-expanded', String(open));
  });
  return [body, more];
}

function foldBlock(e) {
  const label = e.kind === 'thinking' ? 'Thinking' : e.kind === 'tool_use' ? 'Tool' : 'Result';
  const first = e.text.split('\n').find((l) => l.trim()) ?? '';
  const summary = e.kind === 'tool_use' ? clip(`${e.tool || 'tool'}${first ? `: ${first}` : ''}`, 120) : clip(first || '(empty)', 120);
  const det = h('details', { class: 'hx-fold' }, h('summary', {}, h('span', { class: 'hx-kind', text: label }), h('span', { class: 'hx-sum', text: summary })));
  // the body is built on first open, so a long transcript costs one node per folded entry
  det.addEventListener('toggle', () => {
    if (det.open && !det.querySelector('pre')) det.append(h('pre', { class: 'hx-code', tabindex: '0', 'aria-label': `${label} text`, text: e.text }));
  });
  return det;
}

function entryEl(e) {
  const when = Date.parse(e.at);
  const time = Number.isFinite(when)
    ? h('time', { class: 'hx-at', datetime: new Date(when).toISOString(), title: new Date(when).toLocaleString(), text: new Date(when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : null;
  const who = e.kind === 'tool_result' ? 'Tool' : e.role === 'user' ? 'You' : 'Claude';
  const li = h('li', { class: 'hx', 'data-role': e.role, 'data-kind': e.kind }, h('div', { class: 'hx-meta' }, h('span', { class: 'hx-who', text: who }), time));
  li.append(...(e.kind === 'text' ? textBlock(e) : [foldBlock(e)]));
  if (e.truncated) li.append(h('p', { class: 'hx-trunc', text: 'This entry is over 32 KB; nika shows the first part only.' }));
  return li;
}

const scroller = () => $('hist-scroll');
const nearBottom = (el, px = 40) => el.scrollHeight - el.scrollTop - el.clientHeight < px;

/** Adds entries not shown yet at the start or the end of the list. */
function mount(entries, where) {
  const fresh = entries.filter((e) => !H.ids.has(e.id));
  if (!fresh.length) return 0;
  const frag = document.createDocumentFragment();
  const items = fresh.map((e) => {
    const el = entryEl(e);
    frag.append(el);
    H.ids.add(e.id);
    return { e, el };
  });
  if (where === 'start') {
    $('hx-list').prepend(frag);
    H.items.unshift(...items);
  } else {
    $('hx-list').append(frag);
    H.items.push(...items);
  }
  return fresh.length;
}

/** Keeps the list within MAX_ENTRIES, always cutting at a transcript line boundary. 'start' drops the oldest, 'end' the newest. */
function trim(side) {
  const extra = H.items.length - MAX_ENTRIES;
  if (extra <= 0) return;
  let k = side === 'start' ? extra : H.items.length - extra;
  while (k > 0 && k < H.items.length && offsetOf(H.items[k].e.id) === offsetOf(H.items[k - 1].e.id)) k += 1;
  if (k <= 0 || k >= H.items.length) return;
  const removed = side === 'start' ? H.items.splice(0, k) : H.items.splice(k);
  for (const it of removed) {
    it.el.remove();
    H.ids.delete(it.e.id);
  }
  if (side === 'start') H.older = offsetOf(H.items[0].e.id);
  else H.liveEdge = false;
}

function updateHistoryChrome() {
  const btn = $('load-older');
  const hadFocus = document.activeElement === btn;
  $('older').hidden = H.older === null;
  $('newer').hidden = H.liveEdge;
  if (hadFocus && H.older === null) scroller().focus({ preventScroll: true });
  const n = H.items.length;
  $('hist-count').textContent = `${n} ${n === 1 ? 'entry' : 'entries'}`;
  const start = $('hx-list').parentNode.querySelector('.hx-start');
  if (H.older === null && n > 0 && !start) $('hx-list').before(h('p', { class: 'hx-start', text: 'Start of the session' }));
  if (H.older !== null && start) start.remove();
}

function historyNote(msg) {
  const el = $('hist-note');
  el.textContent = msg;
  el.hidden = !msg;
}

const fetchHistory = (before) => {
  const qs = new URLSearchParams({ limit: '50' });
  if (before !== null) qs.set('before', String(before));
  return call(`/api/app/session/${sessionId}/history?${qs}`);
};

function resetHistory(entries, before) {
  for (const it of H.items) it.el.remove();
  H.items = [];
  H.ids.clear();
  mount(entries, 'end');
  H.older = before;
  H.liveEdge = true;
  H.loaded = true;
  const sc = scroller();
  sc.scrollTop = sc.scrollHeight;
  updateHistoryChrome();
}

async function loadNewest() {
  const r = await fetchHistory(null);
  if (r.status === 200) {
    historyNote(r.body?.entries?.length ? '' : 'No messages in this transcript yet.');
    resetHistory(cleanEntries(r.body?.entries), nextBefore(r.body?.nextBefore));
  } else if (r.status === 404) {
    historyNote('No transcript found for this session yet. nika keeps looking.');
  } else {
    historyNote(serverMessage(r, 'The transcript could not be read. nika keeps trying.'));
  }
}

async function refreshHistory() {
  if (H.busy || document.hidden) return;
  H.busy = true;
  try {
    if (!H.loaded) {
      await loadNewest();
      return;
    }
    if (!H.liveEdge || A.kind === 'ended') return;
    const r = await fetchHistory(null);
    if (r.status !== 200) return;
    const entries = cleanEntries(r.body?.entries);
    if (!entries.length) return;
    if (H.items.length && !entries.some((e) => H.ids.has(e.id))) {
      resetHistory(entries, nextBefore(r.body?.nextBefore)); // more than one page arrived since the last poll
      return;
    }
    const lastKey = H.items.length ? keyOf(H.items[H.items.length - 1].e.id) : -1;
    const fresh = entries.filter((e) => !H.ids.has(e.id) && keyOf(e.id) > lastKey);
    if (!fresh.length) return;
    const sc = scroller();
    const stick = nearBottom(sc);
    const top = sc.scrollTop;
    mount(fresh, 'end');
    const h0 = sc.scrollHeight;
    trim('start');
    sc.scrollTop = stick ? sc.scrollHeight : top - (h0 - sc.scrollHeight);
    updateHistoryChrome();
  } finally {
    H.busy = false;
  }
}

async function loadOlder() {
  if (H.busy || H.older === null) return;
  H.busy = true;
  const btn = $('load-older');
  btn.textContent = `Loading${DOTS}`;
  btn.setAttribute('aria-busy', 'true');
  try {
    const r = await fetchHistory(H.older);
    if (r.status !== 200) {
      showProblem(serverMessage(r, 'Older entries could not be loaded.'), 'error', 5000);
      return;
    }
    const sc = scroller();
    const top = sc.scrollTop;
    const h0 = sc.scrollHeight;
    const added = mount(cleanEntries(r.body?.entries), 'start');
    H.older = nextBefore(r.body?.nextBefore);
    sc.scrollTop = top + (sc.scrollHeight - h0); // the entries the reader was looking at stay where they were
    trim('end');
    updateHistoryChrome();
    announce(`${added} older ${added === 1 ? 'entry' : 'entries'} loaded`);
  } finally {
    btn.textContent = 'Load older entries';
    btn.removeAttribute('aria-busy');
    H.busy = false;
  }
}

function startHistoryPoll() {
  const loop = async () => {
    await refreshHistory();
    setTimeout(loop, H.loaded ? 5000 : 3000);
  };
  loop();
}

// ---- terminal mirror ---------------------------------------------------------------------------------------------

const M = { etag: null, timer: 0, busy: false, gone: false, frozen: false, errors: 0, cols: 0, rows: 0, fatal: false, inputOff: false };

function setLive(state, text) {
  $('term-head').dataset.s = state;
  $('live-label').textContent = text;
}

function showOverlay(title, text, { retry = '', alert = false } = {}) {
  const box = $('term-over');
  $('over-title').textContent = title;
  $('over-text').textContent = text;
  const btn = $('over-retry');
  btn.hidden = !retry;
  btn.textContent = retry;
  if (alert) box.setAttribute('role', 'alert');
  else box.removeAttribute('role');
  box.hidden = false;
}
const hideOverlay = () => { $('term-over').hidden = true; };

const refocus = { composer: false };
function setInputEnabled(on, why) {
  const controls = [$('composer'), $('send'), $('pass-toggle'), ...document.querySelectorAll('.key')];
  if (!on) refocus.composer = refocus.composer || document.activeElement === $('composer');
  for (const el of controls) el.disabled = !on;
  $('composer').placeholder = on ? `Message ${A.name}${DOTS}` : why;
  document.querySelector('.inbox').classList.toggle('off', !on);
  if (!on) setPass(false, true);
  else if (refocus.composer) $('composer').focus({ preventScroll: true });
  if (on) refocus.composer = false;
}

function setGone() {
  M.gone = true;
  clearTimeout(M.timer);
  setLive('off', 'Not live');
  setInputEnabled(false, 'Pane is gone');
  showOverlay(`Pane ${paneId} is gone`, 'The agent ended or the pane was closed. The transcript is still readable.', { retry: 'Check again' });
  announce(`Pane ${paneId} is gone`);
}

function setFrozen(on) {
  if (on === M.frozen) return;
  M.frozen = on;
  $('jump-live').hidden = !on;
  $('paused-note').hidden = !on;
  if (on) setLive('paused', `Paused${MID}${M.cols} ${TIMES} ${M.rows}`);
  else {
    setLive('live', `Live${MID}${M.cols} ${TIMES} ${M.rows}`);
    kickMirror(0);
  }
}

function recovered() {
  M.errors = 0;
  hideOverlay();
  if (M.inputOff) {
    M.inputOff = false;
    setInputEnabled(true);
  }
}

function handleCapture(r) {
  if (r.status === 304) {
    recovered();
    return;
  }
  if (r.status === 200 && Array.isArray(r.body?.rows) && Number.isInteger(r.body.cols)) {
    recovered();
    const cols = Math.min(Math.max(r.body.cols, 1), 1000);
    const term = $('term');
    M.cols = cols;
    M.rows = r.body.rows.length;
    M.etag = typeof r.body.etag === 'string' && ETAG.test(r.body.etag) ? r.body.etag : null;
    $('term-rows').style.minWidth = `${cols}ch`;
    applyMirror($('term-rows'), toRenderModel(r.body), r.body.cursor);
    setLive('live', `Live${MID}${cols} ${TIMES} ${M.rows}`);
    term.scrollTop = term.scrollHeight;
    return;
  }
  if (r.status === 404) {
    setGone();
    return;
  }
  if (r.status === 403) {
    M.fatal = true;
    clearTimeout(M.timer);
    setLive('off', 'Not live');
    showOverlay('nika lost its connection to the app', 'The app refused this request. Close this window and open it again from the nika app.', { alert: true });
    return;
  }
  M.errors += 1;
  setLive('off', 'Not live');
  M.inputOff = true; // typing waits until tmux answers again
  setInputEnabled(false, 'tmux is not answering');
  const why = r.status === 0 ? 'nika did not answer' : serverMessage(r, `request failed (${r.status})`);
  showOverlay('tmux did not answer', `${why}. nika retries every 2 seconds.`, { retry: 'Retry now', alert: true });
}

function kickMirror(ms) {
  if (M.gone || M.fatal || !paneId) return;
  clearTimeout(M.timer);
  M.timer = setTimeout(tickMirror, ms);
}

// One request in flight; ~4 Hz while the tab is visible and the view is live. Paused states re-kick themselves.
async function tickMirror() {
  M.timer = 0;
  if (M.gone || M.fatal || M.busy || document.hidden || M.frozen) return;
  M.busy = true;
  const t0 = Date.now();
  try {
    const r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/capture`, { headers: M.etag ? { 'If-None-Match': `"${M.etag}"` } : {} });
    try {
      handleCapture(r);
    } catch {
      M.errors += 1;
      M.inputOff = true;
      setInputEnabled(false, 'tmux is not answering');
      showOverlay('The terminal could not be drawn', 'nika retries every 2 seconds.', { retry: 'Retry now', alert: true });
    }
  } finally {
    M.busy = false;
  }
  kickMirror(M.errors ? 2000 : Math.max(0, 250 - (Date.now() - t0)));
}

function jumpToLive() {
  const term = $('term');
  M.etag = null;
  term.scrollTop = term.scrollHeight;
  term.scrollLeft = 0; // a wide pane: back to column 0 as well
  setFrozen(false);
  $('composer').focus();
}

// ---- sending ------------------------------------------------------------------------------------------------------

const RATE_MSG = 'Too fast: nika sends up to 20 requests a second. Your text is kept.';
let chain = Promise.resolve(); // sends go out in the order they were made, one at a time

async function deliver(payload) {
  if (M.gone || !paneId) return { ok: false, message: 'The pane is gone.' };
  let r;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/keys`, { method: 'POST', json: payload });
    if (r.status !== 429) break;
    showProblem(RATE_MSG, 'warn'); // busy: wait a moment and send again (nothing was sent)
    await sleep(700 * (attempt + 1));
  }
  if (r.status === 200) {
    clearProblem();
    return { ok: true };
  }
  if (r.status === 404) setGone();
  const message = r.status === 429 ? `${RATE_MSG} Try again in a moment.`
    : r.status === 0 ? 'nika did not answer. Your text is kept.'
      : serverMessage(r, `The pane did not accept this (${r.status}).`);
  showProblem(message, r.status === 429 ? 'warn' : 'error', r.status === 429 ? 3000 : 0);
  return { ok: false, message };
}

function enqueue(payload) {
  const job = chain.then(() => deliver(payload));
  chain = job.catch(() => {});
  return job;
}

async function sendKey(name) {
  const r = await enqueue({ keys: [name] });
  if (r.ok) say(`Sent ${KEY_LABEL[name] ?? name} to ${paneId}`);
}

const composer = () => $('composer');
function grow() {
  const ta = composer();
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`; // 8 lines, then it scrolls
}

function updateChip() {
  const v = composer().value;
  const lines = v.split('\n').length;
  const multi = lines > 1 || v.length > 1024;
  $('paste-chip').hidden = !multi;
  if (multi) $('paste-n').textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}${MID}sends as one paste`;
}

let sending = false;
async function sendComposer() {
  const ta = composer();
  if (sending || ta.disabled) return;
  const value = ta.value;
  const plan = planSend(value);
  if (!plan.ok) {
    showProblem(plan.message, 'error');
    return;
  }
  sending = true;
  $('send').setAttribute('aria-busy', 'true');
  const r = await enqueue(plan.payload);
  sending = false;
  $('send').removeAttribute('aria-busy');
  if (!r.ok) return; // the text stays in the box
  say(`Sent ${plan.summary} to ${paneId}`);
  if (ta.value === value) {
    ta.value = '';
    grow();
    updateChip();
  }
}

// ---- passthrough: keys go straight to the pane ----------------------------------------------------------------------

const P = { on: false, buf: '', timer: 0 };

function flushPass() {
  clearTimeout(P.timer);
  P.timer = 0;
  const text = P.buf;
  P.buf = '';
  if (!text) return;
  for (const piece of chunkText(text)) enqueue({ text: piece });
  say(`Sent "${clip(text, 40)}" to ${paneId}`);
}

function setPass(on, keepFocus = false) {
  if (on === P.on) return;
  if (on && (!paneId || M.gone || composer().disabled)) return;
  P.on = on;
  if (!on) flushPass();
  const term = $('term');
  term.classList.toggle('pass', on);
  $('pass-banner').hidden = !on;
  term.setAttribute('role', on ? 'application' : 'region');
  term.setAttribute('aria-label', on
    ? `Terminal passthrough for ${A.name}. Every key goes to pane ${paneId}. Press Control and ] to leave.`
    : `Live terminal of ${A.name}, pane ${paneId}`);
  $('pass-toggle').setAttribute('aria-pressed', String(on));
  if (on) {
    term.focus();
    announce(`Passthrough on: every key goes to pane ${paneId}. Press Control and ] to leave.`);
  } else {
    announce('Passthrough off: typing goes to the input box');
    if (!keepFocus) composer().focus();
  }
}

function wirePassthrough() {
  const term = $('term');
  term.addEventListener('keydown', (e) => {
    if (!P.on) return;
    const k = keyForEvent(e);
    if (k.kind === 'leave') {
      e.preventDefault();
      setPass(false);
      return;
    }
    if (k.kind === 'ignore') return; // Cmd shortcuts and IME stay with the app and the OS
    e.preventDefault();
    e.stopPropagation(); // in passthrough only Ctrl+] belongs to nika
    if (k.kind === 'text') {
      P.buf += k.text;
      if (P.buf.length >= 1000) flushPass();
      else if (!P.timer) P.timer = setTimeout(flushPass, 120); // batched, so typing stays under the 20 requests/s limit
    } else if (k.kind === 'skip') {
      say(k.reason);
      showProblem(k.reason, 'warn', 3000);
    } else {
      flushPass();
      sendKey(k.name);
    }
  });
  term.addEventListener('paste', (e) => {
    if (!P.on) return;
    e.preventDefault();
    const plan = planPaste(e.clipboardData?.getData('text') ?? '');
    if (!plan) return;
    if (!plan.ok) {
      showProblem(plan.message, 'error');
      return;
    }
    flushPass();
    enqueue(plan.payload).then((r) => { if (r.ok) say(`Sent ${plan.summary} to ${paneId}`); });
  });
  term.addEventListener('focusout', () => setPass(false, true)); // focus leaving the mirror ends the mode (WCAG 2.1.2)
  // keep focus in the mirror while the toggle or Leave button is pressed, so focusout does not end the mode first
  for (const id of ['pass-toggle', 'pass-leave']) $(id).addEventListener('mousedown', (e) => { if (P.on) e.preventDefault(); });
  $('pass-toggle').addEventListener('click', () => setPass(!P.on));
  $('pass-leave').addEventListener('click', () => setPass(false));
}

// ---- wiring --------------------------------------------------------------------------------------------------------

function wireComposer() {
  const ta = composer();
  ta.addEventListener('input', () => { grow(); updateChip(); });
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const plain = !e.metaKey && !e.altKey;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendComposer();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      sendKey('Escape');
    } else if (e.ctrlKey && plain && e.key === ']') {
      e.preventDefault();
      setPass(true);
    } else if (e.ctrlKey && plain && e.key.toLowerCase() === 'c' && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault(); // with a selection Ctrl+C stays a copy
      sendKey('C-c');
    }
  });
  $('paste-clear').addEventListener('click', () => {
    ta.value = '';
    grow();
    updateChip();
    ta.focus();
  });
  $('send').addEventListener('click', () => { sendComposer(); ta.focus(); });
  for (const b of document.querySelectorAll('.key')) {
    b.addEventListener('click', async () => {
      await sendKey(b.dataset.key);
      ta.focus();
    });
  }
}

function wireTerminal() {
  const term = $('term');
  term.addEventListener('scroll', () => setFrozen(term.scrollHeight - term.scrollTop - term.clientHeight >= 8));
  $('jump-live').addEventListener('click', jumpToLive);
  $('over-retry').addEventListener('click', () => {
    M.gone = false;
    M.fatal = false;
    M.inputOff = false;
    M.etag = null;
    setInputEnabled(true);
    showOverlay(`Connecting to pane ${paneId}${DOTS}`, '');
    kickMirror(0);
  });
  const set = (surface) => {
    term.dataset.surface = surface;
    for (const b of document.querySelectorAll('[data-surface]')) b.setAttribute('aria-pressed', String(b.dataset.surface === surface));
  };
  const saved = storeGet('mirrorSurface');
  if (saved === 'light' || saved === 'dark') set(saved);
  for (const b of document.querySelectorAll('button[data-surface]')) {
    b.addEventListener('click', () => {
      set(b.dataset.surface);
      storeSet('mirrorSurface', b.dataset.surface);
    });
  }
  wirePassthrough();
}

function wireHistory() {
  $('load-older').addEventListener('click', loadOlder);
  $('jump-latest').addEventListener('click', async () => {
    const r = await fetchHistory(null);
    if (r.status === 200) resetHistory(cleanEntries(r.body?.entries), nextBefore(r.body?.nextBefore));
    else showProblem(serverMessage(r, 'The latest entries could not be loaded.'), 'error', 5000);
  });
}

function wireTabs() {
  const tabs = [$('tab-term'), $('tab-hist')];
  const select = (t) => {
    for (const x of tabs) {
      x.setAttribute('aria-selected', String(x === t));
      x.tabIndex = x === t ? 0 : -1;
    }
    $('split').dataset.tab = t === tabs[1] ? 'hist' : 'term';
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const to = e.key === 'ArrowRight' ? tabs[(i + 1) % 2] : e.key === 'ArrowLeft' ? tabs[(i + 1) % 2] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[1] : null;
      if (!to) return;
      e.preventDefault();
      select(to);
      to.focus();
    });
  });
  const mq = window.matchMedia('(max-width: 1000px)');
  const roles = () => {
    for (const id of ['sess-term', 'sess-hist']) {
      if (mq.matches) $(id).setAttribute('role', 'tabpanel');
      else $(id).removeAttribute('role');
    }
  };
  mq.addEventListener('change', roles);
  roles();
}

async function loadTheme() {
  const r = await call('/api/app/settings');
  const theme = r.body?.ui?.theme;
  if (theme === 'system' || theme === 'light' || theme === 'dark') applyTheme(theme);
}

function showEmpty(text) {
  $('split').hidden = true;
  $('pane-tabs').hidden = true;
  $('empty-text').textContent = text;
  $('empty').hidden = false;
}

function boot() {
  const appMode = typeof isApp === 'function' ? isApp() : Boolean(isApp);
  $('back').href = projectKey ? `/#project/${projectKey}` : '/#dashboard';
  if (!appMode) {
    showEmpty('The session window is part of the nika app. This page was opened in a browser, which only shows the read-only dashboard.');
    return;
  }
  if (!sessionId && !paneId) {
    showEmpty('This link has no valid session id or pane id. Open the agent again from the dashboard.');
    return;
  }
  const bad = [];
  const q = new URLSearchParams(location.search);
  if (q.has('session') && !sessionId) bad.push('session id');
  if (q.has('pane') && !paneId) bad.push('pane id');
  if (bad.length) showNotice(`The link had an invalid ${bad.join(' and ')}; it was ignored.`);

  wireTabs();
  wireHistory();
  wireTerminal();
  wireComposer();
  loadTheme();
  startAgentPoll();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    kickMirror(0);
    refreshHistory();
    refreshAgent();
  });

  const split = $('split');
  if (sessionId) {
    startHistoryPoll();
  } else {
    split.classList.add('no-hist');
    $('pane-tabs').hidden = true;
    showNotice('No transcript for this agent yet: nika has no session id for it. The live terminal still works.');
  }
  if (paneId) {
    $('pb-pane').textContent = paneId;
    $('term').setAttribute('aria-label', `Live terminal of ${A.name}, pane ${paneId}`);
    showOverlay(`Connecting to pane ${paneId}${DOTS}`, '');
    kickMirror(0);
    composer().focus({ preventScroll: true });
  } else {
    split.classList.add('no-term');
    split.dataset.tab = 'hist';
    $('pane-tabs').hidden = true;
    showNotice('This session is not in tmux, so nika can show its transcript but cannot mirror or type into it.');
  }
}

boot();
