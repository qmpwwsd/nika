// nika session window (app tier): transcript history + live terminal mirror + input composer for one agent, with the permission
// mode switcher, the quick actions (Stop, Compact, Clear, Model, Rewind, End), the permission-prompt buttons, Shell mode and the
// slash-command palette.
// URL: session.html?session=<UUID>&pane=<%n>&project=<key>   (pane is sent as %25n, i.e. encodeURIComponent('%n')).
// Rules: every string from the server is rendered with textContent (h() from dom.js, applyMirror from mirror-render.js);
// no innerHTML, no inline handlers, element.style only for numbers this file computes. Contracts: docs/contracts/api-app.md.
import { h, icon } from './dom.js';
import { isApp, appFetch, getJSON, applyTheme } from './api.js';
import { toRenderModel, applyMirror, planSend, planPaste, chunkText, keyForEvent, KEY_LABEL, arrowEcho } from './mirror-render.js';
import { MODE_META, MODE_TARGETS, modeKey, modeEl, bypassTag, switcherState, modeNote, switchFailure } from './modes.js';
import {
  quickState, cleanPrompt, answerOutcome, escOutcome, promptOff, promptNote, commandFailure, commandSaid, problemKind, planShell, sendGate, keysRefusal, stopOutcome, followSession,
  hasAnswerButtons, attnNote, composerKey, SESSION_ID, PANE_ID,
} from './quick-actions.js';
import { MODEL_ID, MODEL_HINT, CUSTOM, fillModelSelect } from './models-ui.js';
import { openEndDialog } from './end-dialog.js';
import { paletteQuery, cleanCommands, paletteView, commandsButton, shouldFetch, sourceLabel, insertion, moveActive } from './palette.js';
import { isMac, isTextEntry, wantsHelp, wantsBack, wantsHistToggle, backHint, helpHint, histHint, passKeyLabel, hintTips, openShortcuts } from './shortcuts.js';

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

let sessionId = param('session', SESSION_ID); // follows the pane to its new session after /clear (followSession)
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

/** A polite live region: cleared first, then filled a moment later, so a repeated message is read again. */
function liveRegion(get) {
  let timer = 0;
  return (msg) => {
    const el = get();
    el.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(() => { el.textContent = msg; }, 30);
  };
}
const announce = liveRegion(() => $('announcer'));
const announceMode = liveRegion(() => $('mode-live')); // permission-mode messages only, so a status message cannot swallow them

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

// A is what the agent poll said: name, status kind, the attention reason (why a 'Needs you' agent waits), the model id and label.
const A = { name: 'the agent', kind: null, attention: '', modelId: '', projectLooked: false };

/** The Back link names the project only when this window came from one (its href is then /#project/<key>); otherwise it stays "Dashboard". */
function applyBackLabel(group) {
  if (!projectKey || !group?.label) return;
  $('proj').textContent = String(group.label);
  setBack(String(group.label));
}

function applyAgent(agent, group) {
  const untitled = !agent.name || (sessionId && agent.name === sessionId.slice(0, 8));
  A.name = untitled ? 'untitled session' : String(agent.name);
  const h1 = $('sess-h');
  h1.textContent = A.name;
  h1.classList.toggle('untitled', untitled);
  h1.title = A.name;
  document.title = `${A.name}${MID}nika`;
  applyBackLabel(group);
  const model = $('sess-model');
  model.textContent = agent.modelLabel || agent.model || '-';
  model.hidden = false;
  A.modelId = typeof agent.model === 'string' ? agent.model : '';
  renderModelName(agent.modelLabel || agent.model || '');
  const pane = paneId ?? agent.pane?.id;
  $('meta-pane').hidden = !(typeof pane === 'string' && PANE_ID.test(pane));
  $('sess-pane').textContent = typeof pane === 'string' && PANE_ID.test(pane) ? pane : '';
  $('sess-branch').hidden = !agent.gitBranch;
  $('sess-branch').textContent = agent.gitBranch ? String(agent.gitBranch) : '';

  const link = $('claude-link');
  const url = claudeUrl(agent.bridgeUrl);
  link.hidden = !url;
  if (url) link.href = url;

  A.attention = agent.attention ? String(agent.attention) : '';
  const kind = statusOf(agent);
  if (kind !== A.kind) {
    if (A.kind !== null && kind !== 'busy') announce(`${A.name} ${kind === 'attn' ? `needs you: ${agent.attention}` : kind === 'idle' ? 'is waiting for your prompt' : 'ended'}`);
    A.kind = kind;
    setStatus(kind);
    renderMode();
  }
  renderAttn();
  renderPrompt();
  $('composer-label').textContent = `Message to ${A.name}. Enter sends, Shift+Enter adds a line. Escape, Control+C and Shift+Tab go to Claude, and so do the arrow keys and Enter when the box is empty. Control+Shift+Tab moves focus back.`;
  if (!$('composer').disabled) $('composer').placeholder = idlePlaceholder();
  $('pb-pane').textContent = paneId ?? '';
}

/** The window now shows `id`: the address (same shape, new session), an empty transcript that loads from its start at the next poll. */
function followPane(id) {
  sessionId = id;
  const q = [`session=${id}`, `pane=${encodeURIComponent(paneId)}`, projectKey && `project=${projectKey}`].filter(Boolean);
  history.replaceState(null, '', `?${q.join('&')}`);
  resetHistory([], null);
  H.loaded = false;
  historyNote('');
  refreshHistory();
}

async function refreshAgent() {
  let snapshot;
  try {
    snapshot = await getJSON('/api/agents?since=all'); // public route (both tiers), not under /api/app
  } catch {
    return; // the header keeps its last values; the next poll tries again
  }
  if (!Array.isArray(snapshot?.groups)) return;
  const all = snapshot.groups.flatMap((g) => (g.agents ?? []).map((a) => ({ a, g })));
  const find = (id) => all.findLast(({ a }) => (id ? a.id === id : paneId && a.live && a.pane?.id === paneId)) ?? null;
  let hit = find(sessionId);
  const next = followSession({ sessionId, paneId, agents: all.map(({ a }) => a) }); // the pane's Claude started a new conversation (/clear)
  if (next) {
    followPane(next);
    hit = find(next);
  }
  if (hit) {
    applyAgent(hit.a, hit.g);
    if (next) announce('Claude started a new conversation in this pane.'); // after applyAgent, whose status message would replace it
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

// ---- permission mode: tag, frame, switcher (docs/design/spec.md 2.8 and 9.1-9.3) --------------------------------------

// W is what the last capture said. pane: 'connecting' until one answers, 'ok' while they do, 'tmux' when they fail, 'gone'
// on 404. last: the last real mode announced as current. msg: the result of the last switch ({ text, mode }). struck: targets
// the Shift-Tab cycle does not hold, struck at strikeAt. SW: the switch in flight (its target) and the four segments.
// prompt: the capture's prompt as cleanPrompt allows it, for drawing the buttons only. promptOpen: the capture has a prompt at all
// (even an off-contract one), for every gate: the switcher, the quick actions, the message box keys (composerKey) and the End note.
const W = { pane: 'connecting', got: false, mode: 'unknown', confirmed: true, prompt: null, promptOpen: false, last: null, msg: null, struck: new Set(), strikeAt: null, tagSig: '', whySig: '' };
const SW = { busy: null, pressed: null, parts: [] };

function renderTag() {
  const key = W.pane === 'ok' ? modeKey(W.mode) : '';
  const sig = key ? `${key}:${W.confirmed}` : '';
  if (sig === W.tagSig) return;
  W.tagSig = sig;
  const body = document.body;
  for (const m of Object.values(MODE_META)) body.classList.remove(m.cls);
  if (key) {
    body.classList.add(MODE_META[key].cls);
    body.dataset.mode = key;
    body.dataset.confirmed = String(W.confirmed);
  } else { // no pane, pane gone, no capture yet: no frame, no edge, no tag
    delete body.dataset.mode;
    delete body.dataset.confirmed;
  }
  const slot = $('sess-mode');
  slot.hidden = !key;
  slot.replaceChildren(...(key ? [modeEl(key, { confirmed: W.confirmed })] : []));
}

/** One Tab stop for the toolbar: the segment that has focus, else the pressed one, else the first. */
function tabStops() {
  const at = SW.parts.findIndex((p) => p.b === document.activeElement);
  const stop = at >= 0 ? at : Math.max(0, MODE_TARGETS.indexOf(SW.pressed));
  SW.parts.forEach((p, i) => { p.b.tabIndex = i === stop ? 0 : -1; });
}

function renderSegments(st) {
  SW.pressed = st.pressed;
  MODE_TARGETS.forEach((t, i) => {
    const { b, ico, spin } = SW.parts[i];
    const label = MODE_META[t].label;
    const busy = st.busy === t;
    const struck = W.struck.has(t);
    b.setAttribute('aria-pressed', String(st.pressed === t));
    b.setAttribute('aria-disabled', String((st.disabled && !busy) || struck));
    if (busy) b.setAttribute('aria-busy', 'true');
    else b.removeAttribute('aria-busy');
    b.classList.toggle('held', st.held === t);
    b.classList.toggle('out', struck);
    ico.toggleAttribute('hidden', busy);
    spin.toggleAttribute('hidden', !busy);
    b.title = struck ? `${label} isn't in this session's Shift-Tab cycle` : st.held === t ? `${label}, not confirmed` : busy ? `Switching to ${label}` : `Switch to ${label}`;
  });
  tabStops();
}

/**
 * The reason line: why the switcher cannot act, or the result of the last switch. Not a live region (a loud result also goes to the alert
 * line). A mode with no segment (Bypass, Don't ask: `st.tag`) or a switch that left Claude in Bypass leads with its tag, not the info icon.
 */
function renderWhy(st) {
  const err = !st.reason && W.msg !== null;
  const text = st.reason || W.msg?.text || st.note || '';
  const bypassed = err && W.msg.bypass === true; // Claude was left in Bypass: its tag (colour, icon, word) leads the line
  const tag = err ? null : st.tag ?? null;
  const sig = `${text}|${err}|${bypassed}|${tag}|${W.confirmed}`;
  if (sig === W.whySig) return;
  W.whySig = sig;
  const why = $('msw-why');
  why.hidden = !text;
  why.className = err ? 'msw-why err' : 'msw-why';
  const lead = bypassed ? bypassTag() : tag ? modeEl(tag, { confirmed: W.confirmed }) : text && icon(err ? 'warn' : 'info');
  why.replaceChildren(...[lead, text && h('span', { text })].filter(Boolean));
}

function renderMode() {
  if (!paneId || !SW.parts.length) return;
  const st = switcherState({ pane: W.pane, status: A.kind, prompt: W.promptOpen, mode: W.mode, modeConfirmed: W.confirmed, switching: SW.busy });
  // a reason, or the pane reaching another mode, ends the last result
  if (st.reason || (W.msg && W.confirmed && W.mode !== 'unknown' && W.mode !== W.msg.mode)) W.msg = null;
  renderTag();
  renderSegments(st);
  renderWhy(st);
  renderQuick();
  renderAttn();
  renderPrompt();
}

/** What a capture says about the mode and the prompt. The tag follows every capture; only a change is announced. */
function noteScreen(body) {
  W.got = true;
  W.pane = 'ok';
  W.mode = modeKey(body.mode);
  W.confirmed = body.modeConfirmed === true;
  W.prompt = cleanPrompt(body.prompt); // null for anything but the contract shape: no panel, no buttons
  W.promptOpen = Boolean(body.prompt); // but an off-contract prompt still counts as a prompt for the gates
  if (W.struck.size && W.confirmed && W.mode !== 'unknown' && W.mode !== W.strikeAt) W.struck.clear();
  if (!SW.busy) { // a switch announces its end result once, when the route answers
    const n = modeNote(A.name, W.last, { mode: W.mode, confirmed: W.confirmed });
    W.last = n.last;
    if (n.msg) announceMode(n.msg);
  }
  renderMode();
}

function setPaneState(state) {
  W.pane = state;
  renderMode();
}

/** Resolves when a capture that started after this call has been handled (or after `ms`). */
function nextCapture(ms = 2500) {
  return new Promise((resolve) => {
    const w = { after: M.sent, done: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { M.waiters = M.waiters.filter((x) => x !== w); resolve(); }, ms);
    M.waiters.push(w);
    kickMirror(0);
  });
}

function captureHandled(n) {
  const waiting = M.waiters;
  M.waiters = waiting.filter((w) => w.after >= n);
  for (const w of waiting) if (w.after < n) w.done();
}

/** A failed switch, once the next capture shows where the cycle stopped. */
function failSwitch(r, start, target) {
  const f = switchFailure({ status: r.status, code: r.body?.error, start, target, mode: W.mode, confirmed: W.confirmed, presses: r.body?.presses });
  if (f.strike) {
    W.struck.add(f.strike);
    W.strikeAt = W.mode;
  }
  W.msg = { text: f.text, mode: W.mode, bypass: f.bypass === true };
  if (W.confirmed && W.mode !== 'unknown') W.last = W.mode; // the captures on the way were silent
  if (f.loud) showProblem(f.text, 'error'); // Claude may be in Bypass or any other mode: the alert line says so at once, not the polite region
  else if (r.status !== 404) announceMode(`${A.name}: ${f.text}`); // a gone pane is announced once, by the pane-gone state
}

async function switchTo(target) {
  if (SW.busy || M.gone || !paneId || W.struck.has(target)) return;
  const st = switcherState({ pane: W.pane, status: A.kind, prompt: W.promptOpen, mode: W.mode, modeConfirmed: W.confirmed, switching: null });
  if (st.disabled || st.pressed === target) return; // the pressed segment and a disabled one do nothing
  const start = W.mode;
  SW.busy = target;
  W.msg = null;
  renderMode();
  try {
    const r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/mode`, { method: 'POST', json: { target } });
    const presses = r.body?.presses; // the echo only, never a live count
    if (Number.isInteger(presses) && presses > 0 && presses <= 6) say(`Sent ${presses} ${TIMES} Shift-Tab to ${paneId}`);
    if (r.status === 200) {
      const final = modeKey(r.body?.mode); // the route read a fresh footer
      if (final !== 'unknown') {
        W.mode = final;
        W.confirmed = true;
        if (final !== start) announceMode(modeNote(A.name, start, { mode: final, confirmed: true }).msg);
        W.last = final;
      }
    } else {
      if (r.status === 404) setGone();
      else await nextCapture();
      failSwitch(r, start, target);
    }
  } finally {
    SW.busy = null;
    renderMode();
  }
}

function wireSwitcher() {
  const bar = $('mode-switch');
  SW.parts = MODE_TARGETS.map((t) => {
    const meta = MODE_META[t];
    const ico = icon(meta.icon);
    const spin = h('span', { class: 'spin', 'aria-hidden': 'true', hidden: true });
    const b = h('button', { type: 'button', class: meta.cls, 'aria-pressed': 'false', 'aria-label': meta.label, title: `Switch to ${meta.label}`, onclick: () => switchTo(t) },
      ico, spin, h('span', { class: 'lbl', text: meta.label }));
    return { b, ico, spin };
  });
  bar.append(...SW.parts.map((p) => p.b));
  bar.addEventListener('focusin', tabStops);
  roveKeys(bar, () => SW.parts.map((p) => p.b)); // moving never switches; Enter and Space on a button do
  bar.addEventListener('mousedown', (e) => { if (document.activeElement === composer()) e.preventDefault(); }); // a click leaves focus in the message box, so typing goes on
  $('mode-row').hidden = false;
  bar.hidden = false;
  renderMode();
}

/** Left / Right / Home / End move focus along a toolbar and wrap; moving never activates (spec 9.3, 9.4). */
function roveKeys(bar, buttons) {
  bar.addEventListener('keydown', (e) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement);
    if (i < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const n = list.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    list[to].focus();
  });
}

// ---- quick actions, prompt buttons, Shell (docs/design/spec.md 9.4-9.6; rules and copy: quick-actions.js) ----------------

// Q: the six toolbar buttons, the command in flight (busy: 'compact' | 'clear' | 'model' | 'rewind'; Stop has its own flag, stopping: the route takes no
// control lock, so Stop must work while a command waits), the model popover (pop: open?, catalog:
// null until GET /api/app/models answered), the reason line shown (whySig). PA: the prompt panel's question (sig), a request in
// flight (pending) and the question that was answered (lock: its sig; the buttons stay off until a capture shows another one).
const Q = { ready: false, b: {}, busy: null, stopping: false, pop: false, catalog: null, loading: false, whySig: null, nameSig: null };
const PA = { sig: null, pending: false, lock: null, esc: null, btns: [] };
const S = { on: false }; // Shell mode
// PL: the command palette (spec 9.7). open: is the list on screen; list: null until GET /api/app/commands answered; failed: the first load
// did not; at: when the last good answer came; busy: a request is in flight; shown: the options on screen; active: the active option's
// index (-1 = none); said: the last announcement; argFor / argHint: the text just inserted and its argument line; noProject: the project
// key got a 404, so this window asks without it from now on.
const PL = { open: false, list: null, failed: false, at: null, busy: false, shown: [], active: -1, said: null, sayTimer: 0, argFor: '', argHint: '', noProject: false };

const aria = (b) => b.getAttribute('aria-disabled') === 'true';

/** The "Model: <name>" label of the Model button. */
function renderModelName(name) {
  if (name === Q.nameSig) return;
  Q.nameSig = name;
  $('qa-model-lbl').textContent = name ? 'Model:' : 'Model';
  $('qa-model-name').textContent = name;
}

function renderQuick() {
  if (!Q.ready) return;
  const st = quickState({ pane: W.pane, status: A.kind, prompt: W.promptOpen, switching: SW.busy !== null || Q.busy !== null || Q.stopping });
  for (const id of Object.keys(Q.b)) {
    const b = Q.b[id];
    b.setAttribute('aria-disabled', String(st[id].off));
    b.title = st[id].title;
    if (id === 'stop' ? Q.stopping : Q.busy === id) b.setAttribute('aria-busy', 'true');
    else b.removeAttribute('aria-busy');
  }
  Q.b.stop.classList.toggle('on', !st.stop.off);
  if (st.reason !== Q.whySig) { // not rebuilt at every capture
    Q.whySig = st.reason;
    const why = $('qa-why');
    why.hidden = !st.reason;
    why.replaceChildren(...(st.reason ? [icon('info'), h('span', { text: st.reason })] : []));
  }
  // the popover has nothing to send once Claude is busy or asks something; focus inside it moves to the Model button, not to the page
  if (Q.pop && st.model.off) closeModelPop($('model-pop').contains(document.activeElement));
}

/** Sends one slash command through the command route, which types it only into an empty input and presses Enter when it reads exactly that. */
async function sendCommand(text) {
  if (Q.busy || M.gone || !paneId) return;
  Q.busy = text.slice(1).split(' ')[0]; // compact | clear | model | rewind: the button that shows it is busy
  renderQuick();
  const r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/command`, { method: 'POST', json: { text } });
  Q.busy = null;
  renderQuick();
  if (r.status === 200 && r.body?.sent === true) {
    clearProblem();
    say(commandSaid(text, paneId));
    return;
  }
  if (r.status === 404) setGone();
  showProblem(commandFailure({ status: r.status, code: r.body?.error }), problemKind(r.status));
}

/** Stop: its own route, which handles Claude's vim insert mode (two Escapes) and never answers a prompt. Not queued behind typed keys or the control lock, so only a Stop in flight blocks a second click (Ctrl+C right after arrows waits for them, wireComposer). */
async function stop() {
  if (Q.stopping || M.gone || !paneId) return;
  Q.stopping = true;
  renderQuick();
  const r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/stop`, { method: 'POST', json: {} });
  Q.stopping = false;
  renderQuick();
  const out = stopOutcome({ status: r.status, code: r.body?.error, name: A.name });
  if (out.ok) {
    clearProblem();
    say(out.say);
    return;
  }
  if (r.status === 404) setGone();
  showProblem(out.message, problemKind(r.status));
}

function openEnd() {
  openEndDialog({
    pane: paneId,
    name: A.name,
    working: A.kind === 'busy',
    promptOpen: W.promptOpen || A.kind === 'attn',
    onEnded: () => {
      toast('Session ended');
      setGone(); // the pane no longer runs Claude: the mirror shows its pane-gone state now instead of at the next capture
    },
  });
}

/** Short-lived status message at the bottom of the window (polite, never takes focus). */
function toast(msg) {
  const box = $('toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  const t = h('div', { class: 'toast', role: 'status' }, h('p', { text: msg }));
  box.append(t);
  setTimeout(() => t.remove(), 4200);
}

// -- Clear: a confirm dialog first (spec 9.4)
function wireClear() {
  const dlg = $('clear-dlg');
  let opener = null;
  Q.openClear = () => {
    opener = document.activeElement;
    $('clear-h').textContent = `Clear ${A.name}'s conversation?`;
    dlg.showModal();
    $('clear-cancel').focus(); // initial focus is Cancel
  };
  $('clear-cancel').addEventListener('click', () => dlg.close());
  $('clear-go').addEventListener('click', () => {
    dlg.close();
    sendCommand('/clear');
  });
  dlg.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); });
}

// -- Model: a disclosure with the model select; only Switch model sends (a change event never does)
function chosenModel() {
  const v = $('model-sel').value;
  return v === CUSTOM ? $('model-custom').value.trim() : v;
}

function setCustomError(msg) {
  const err = $('model-custom-err');
  err.hidden = !msg;
  err.replaceChildren(...(msg ? [icon('warn'), h('span', { text: msg })] : []));
  $('model-custom').setAttribute('aria-invalid', String(Boolean(msg)));
}

/** The select decides whether the custom field shows; the muted line always names the exact command. */
function syncModelPop() {
  $('model-custom-wrap').hidden = $('model-sel').value !== CUSTOM;
  setCustomError('');
  $('model-cmd').textContent = `/model ${chosenModel() || '<id>'}`;
}

function closeModelPop(refocus) {
  if (!Q.pop) return;
  Q.pop = false;
  $('model-pop').hidden = true;
  Q.b.model.setAttribute('aria-expanded', 'false');
  if (refocus) Q.b.model.focus();
}

async function openModelPop() {
  if (Q.loading) return;
  if (!Q.catalog) {
    Q.loading = true;
    const r = await call('/api/app/models');
    Q.loading = false;
    if (r.status === 200 && Array.isArray(r.body?.models)) Q.catalog = r.body.models;
    if (aria(Q.b.model)) return; // Claude became busy while the list loaded
  }
  const custom = fillModelSelect($('model-sel'), Q.catalog, A.modelId); // a model outside the catalog selects Custom ID with its text in the field
  $('model-custom').value = custom ? A.modelId : '';
  $('model-label').textContent = `Model for ${A.name}`;
  $('model-note').hidden = Q.catalog !== null;
  syncModelPop();
  Q.pop = true;
  $('model-pop').hidden = false;
  Q.b.model.setAttribute('aria-expanded', 'true');
  $('model-sel').focus();
}

function switchModel() {
  const id = chosenModel();
  if (!MODEL_ID.test(id)) {
    setCustomError(MODEL_HINT);
    $('model-custom').focus();
    return;
  }
  closeModelPop(true);
  sendCommand(`/model ${id}`);
}

function wireModelPop() {
  const pop = $('model-pop');
  $('model-sel').addEventListener('change', syncModelPop); // never sends: arrow keys on a closed select would send several /model
  $('model-custom').addEventListener('input', syncModelPop);
  $('model-custom').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    switchModel();
  });
  $('model-cancel').addEventListener('click', () => closeModelPop(true));
  $('model-go').addEventListener('click', switchModel);
  pop.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeModelPop(true);
  });
  pop.addEventListener('focusout', (e) => { // Tab out of the popover closes it
    const to = e.relatedTarget;
    if (to instanceof Node && !pop.contains(to) && to !== Q.b.model) closeModelPop(false);
  });
}

function wireQuick() {
  Q.b = { stop: $('qa-stop'), compact: $('qa-compact'), clear: $('qa-clear'), model: $('qa-model'), rewind: $('qa-rewind'), end: $('qa-end') };
  const bar = $('qa');
  const on = (id, run) => Q.b[id].addEventListener('click', () => {
    Q.b[id].focus(); // a click does not focus a button in every webview; dialogs and the popover return focus here
    if (!aria(Q.b[id])) run();
  });
  on('stop', stop);
  on('compact', () => sendCommand('/compact'));
  on('clear', () => Q.openClear());
  on('model', () => (Q.pop ? closeModelPop(true) : openModelPop()));
  on('rewind', () => sendCommand('/rewind'));
  on('end', openEnd);
  const stops = () => Object.values(Q.b);
  bar.addEventListener('focusin', () => { for (const b of stops()) b.tabIndex = b === document.activeElement ? 0 : -1; });
  roveKeys(bar, stops);
  wireClear();
  wireModelPop();
  Q.ready = true;
  renderMode();
}

// -- the prompt panel: one button per option, "Esc = No", and a bypass option as text only (spec 9.5)

/** The attention note (0.2) for a 'Needs you' agent whose layout has no prompt panel; the panel replaces it. */
function renderAttn() {
  const note = $('attn-note');
  const panel = W.pane === 'ok' && W.prompt !== null;
  note.hidden = A.kind !== 'attn' || panel;
  if (!note.hidden) $('attn-text').textContent = attnNote(A.name, A.attention, passKeyLabel(MAC));
}

function optionRow(o) {
  if (o.bypass) { // no button, not focusable: nika never answers a bypass option
    return h('div', { class: 'pbtn-off' }, h('kbd', { text: String(o.n) }), h('span', {}, o.label, h('span', { class: 'pnote', text: 'Answer this one in the terminal' })));
  }
  return h('button', { type: 'button', class: 'pbtn', 'data-n': o.n, onclick: () => answer(o.n) }, h('kbd', { text: String(o.n) }), h('span', { text: o.label }));
}

function buildPrompt(p) {
  PA.sig = p.sig;
  PA.btns = [];
  const rows = p.options.map((o) => {
    const row = optionRow(o);
    if (!o.bypass) PA.btns.push(row);
    return row;
  });
  PA.esc = h('button', { type: 'button', class: 'pbtn esc', onclick: escNo }, h('kbd', { text: 'Esc' }), h('span', { text: 'Cancel, same as No' }));
  $('ask-q').textContent = p.question;
  $('ask-opts').replaceChildren(...rows, PA.esc);
  $('prompt-btns').hidden = false;
  announce(promptNote(A.name, p));
}

function renderPrompt() {
  if (!Q.ready) return;
  const p = W.pane === 'ok' ? W.prompt : null;
  const panel = $('prompt-btns');
  if (!p) {
    PA.lock = null; // no prompt on screen: whatever was answered is over
    if (panel.hidden) return;
    const focused = panel.contains(document.activeElement);
    panel.hidden = true;
    PA.sig = null;
    PA.btns = [];
    if (focused) composer().focus({ preventScroll: true }); // the button that had focus is gone
    return;
  }
  if (p.sig !== PA.sig) { // rebuilt only for a new question, so focus and hover survive the captures
    const focused = panel.contains(document.activeElement);
    buildPrompt(p);
    if (focused) $('ask-q').focus({ preventScroll: true }); // the button that had focus was replaced; the question text, so a held Enter answers nothing unseen
  }
  const reason = $('ask-reason');
  if (reason.textContent !== A.attention) reason.textContent = A.attention;
  const off = promptOff({ pending: PA.pending, lock: PA.lock, sig: p.sig });
  for (const b of [...PA.btns, PA.esc]) b.setAttribute('aria-disabled', String(off));
  $('ask-lock').hidden = PA.lock !== p.sig;
}

async function answer(n) {
  const p = W.prompt;
  if (!p || promptOff({ pending: PA.pending, lock: PA.lock, sig: p.sig }) || M.gone) return;
  PA.pending = true;
  renderPrompt();
  const r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/answer`, { method: 'POST', json: { n, sig: p.sig } });
  PA.pending = false;
  const out = answerOutcome({ status: r.status, code: r.body?.error });
  if (out.lock) PA.lock = p.sig; // the question that was answered; a new one is another sig
  if (r.status === 200) {
    clearProblem();
    say(`Sent ${n} to ${paneId}`);
  } else if (out.message) {
    showProblem(out.message, problemKind(r.status));
  }
  if (r.status === 404) setGone();
  renderPrompt();
}

/** "Esc = No": the keys route with Escape, like Esc in the message box. A 200 locks the question like an answered option (no second Escape). */
async function escNo() {
  const p = W.prompt;
  if (!p || promptOff({ pending: PA.pending, lock: PA.lock, sig: p.sig }) || M.gone) return;
  PA.pending = true;
  renderPrompt();
  const ok = await sendKey('Escape');
  PA.pending = false;
  if (escOutcome({ ok }).lock) PA.lock = p.sig; // the question that was refused; a new one is another sig
  renderPrompt();
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

const M = { etag: null, timer: 0, busy: false, gone: false, frozen: false, errors: 0, cols: 0, rows: 0, fatal: false, inputOff: false, sent: 0, waiters: [] };

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
  const controls = [$('composer'), $('send'), $('cmd-btn'), $('pass-toggle'), $('shell-toggle')];
  if (!on) refocus.composer = refocus.composer || document.activeElement === $('composer');
  if (!on) closePalette(); // a disabled box fires no blur in every webview
  if (!on) { AR.buf = []; clearTimeout(AR.timer); } // arrows not yet sent are dropped with the box
  for (const el of controls) el.disabled = !on;
  $('composer').placeholder = on ? idlePlaceholder() : why;
  document.querySelector('.inbox').classList.toggle('off', !on);
  if (!on) setPass(false, true);
  else if (refocus.composer) $('composer').focus({ preventScroll: true });
  if (on) refocus.composer = false;
}

function setGone() {
  M.gone = true;
  clearTimeout(M.timer);
  setLive('off', 'Not live');
  setPaneState('gone');
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
  const pane = W.got ? 'ok' : 'connecting';
  if (W.pane !== pane) setPaneState(pane);
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
    noteScreen(r.body);
    const cols = Math.min(Math.max(r.body.cols, 1), 1000);
    const term = $('term');
    M.cols = cols;
    M.rows = r.body.rows.length;
    M.etag = typeof r.body.etag === 'string' && ETAG.test(r.body.etag) ? r.body.etag : null;
    $('term-rows').style.minWidth = `${cols}ch`;
    applyMirror($('term-rows'), toRenderModel(r.body), r.body.cursor);
    setLive(M.frozen ? 'paused' : 'live', `${M.frozen ? 'Paused' : 'Live'}${MID}${cols} ${TIMES} ${M.rows}`);
    if (!M.frozen) term.scrollTop = term.scrollHeight; // a paused mirror still applies captures but keeps the reader's place
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
    setPaneState('tmux');
    showOverlay('nika lost its connection to the app', 'The app refused this request. Close this window and open it again from the nika app.', { alert: true });
    return;
  }
  M.errors += 1;
  setLive('off', 'Not live');
  setPaneState('tmux');
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
  if (M.gone || M.fatal || M.busy || document.hidden) return; // a paused mirror keeps polling: the mode and the prompt must stay true
  M.busy = true;
  M.sent += 1;
  const sent = M.sent;
  const t0 = Date.now();
  try {
    const r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/capture`, { headers: M.etag ? { 'If-None-Match': `"${M.etag}"` } : {} });
    try {
      handleCapture(r);
    } catch {
      M.errors += 1;
      M.inputOff = true;
      setPaneState('tmux');
      setInputEnabled(false, 'tmux is not answering');
      showOverlay('The terminal could not be drawn', 'nika retries every 2 seconds.', { retry: 'Retry now', alert: true });
    }
    captureHandled(sent);
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
  const message = keysRefusal({ status: r.status, code: r.body?.error })
    ?? (r.status === 429 ? `${RATE_MSG} Try again in a moment.`
      : r.status === 0 ? 'nika did not answer. Your text is kept.'
        : serverMessage(r, `The pane did not accept this (${r.status}).`));
  showProblem(message, r.status === 429 ? 'warn' : 'error', r.status === 429 ? 3000 : 0);
  return { ok: false, message };
}

/** Sends the bodies in order as one job; the first failure stops the rest (an Enter must not follow a text that never arrived). */
function enqueueSeq(payloads) {
  const job = chain.then(async () => {
    for (const payload of payloads) {
      const r = await deliver(payload);
      if (!r.ok) return r;
    }
    return { ok: true };
  });
  chain = job.catch(() => {});
  return job;
}
const enqueue = (payload) => enqueueSeq([payload]);

async function sendKey(name) {
  const r = await enqueue({ keys: [name] });
  if (r.ok) say(`Sent ${KEY_LABEL[name] ?? name} to ${paneId}`);
  return r.ok;
}

// Arrow keys from an empty message box (spec 4.2, 0.3.3): batched so a held key stays under the route's 20 requests a second.
const AR = { buf: [], timer: 0, waiting: 0, sent: [], quiet: 0 };
function queueArrow(key, repeat) {
  if (repeat && AR.waiting >= 2) return; // the pane is behind: drop the repeat, never build a backlog
  AR.buf.push(key);
  if (AR.buf.length >= 8) flushArrows();
  else if (AR.buf.length === 1) AR.timer = setTimeout(flushArrows, 120);
}
function flushArrows() {
  clearTimeout(AR.timer);
  if (!AR.buf.length) return;
  const keys = AR.buf;
  AR.buf = [];
  AR.waiting += 1;
  enqueue({ keys }).then((r) => { AR.waiting -= 1; if (r.ok) AR.sent.push(...keys); });
  clearTimeout(AR.quiet);
  AR.quiet = setTimeout(echoArrows, 400);
}
function echoArrows() {
  chain.then(() => { if (AR.sent.length) say(arrowEcho(AR.sent, paneId)); AR.sent = []; });
}
function endArrows() { // before any other action from the box: the arrows go first, then their echo; true when a run was pending
  if (!AR.buf.length && !AR.waiting && !AR.sent.length) return false;
  flushArrows();
  clearTimeout(AR.quiet);
  echoArrows();
  return true;
}

const composer = () => $('composer');
function grow() {
  const ta = composer();
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`; // 8 lines, then it scrolls
}

/** Everything that depends on what is in the message box: the Commands button, the argument hint, the palette and the paste chip. */
function updateChip() {
  renderCmdBtn();
  renderArgHint();
  syncPalette(); // the text may have become (or stopped being) a command query; also closes the list after a send, a clear or an insert
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
  const gate = sendGate({ promptOpen: W.promptOpen, status: A.kind, buttons: W.pane === 'ok' && hasAnswerButtons(W.prompt), bypass: W.prompt?.bypass === true }); // Enter would confirm the prompt's highlighted option: answer with the buttons
  if (!gate.ok) {
    showProblem(gate.message, 'error'); // nothing is sent and the text stays in the box
    return;
  }
  const value = ta.value;
  const plan = S.on ? planShell(value) : planSend(value);
  if (plan.empty) return; // Shell on and nothing to run: no lone "!"
  if (!plan.ok) {
    showProblem(plan.message, 'error');
    return;
  }
  sending = true;
  $('send').setAttribute('aria-busy', 'true');
  const r = await enqueueSeq(plan.payloads ?? [plan.payload]);
  sending = false;
  $('send').removeAttribute('aria-busy');
  if (!r.ok) return; // the text stays in the box, and Shell stays on so a retry still goes as a command
  say(`Sent ${plan.summary} to ${paneId}`);
  if (S.on) setShell(false); // like Claude's own ! mode: the next message is a message
  if (ta.value === value) {
    ta.value = '';
    grow();
    updateChip();
  }
}

// ---- Shell mode (spec 9.6): Enter sends Ctrl-U, "!" + the text, Enter; it turns itself off after a successful send -------------

const RSAQUO = String.fromCharCode(0x203a);
const idlePlaceholder = () => (S.on ? `Shell command for Claude's ! mode${DOTS}` : `Message ${A.name}${DOTS}`);

function setShell(on) {
  if (on === S.on) return;
  S.on = on;
  const toggle = $('shell-toggle');
  toggle.setAttribute('aria-pressed', String(on));
  toggle.querySelector('.onoff').textContent = on ? 'on' : 'off';
  document.querySelector('.inbox').classList.toggle('shell-on', on);
  document.querySelector('.inbox .prompt').textContent = on ? '!' : RSAQUO;
  if (!composer().disabled) composer().placeholder = idlePlaceholder();
  $('shell-hint').hidden = !on;
  if (on) closePalette(); // a "/" in Shell mode is shell text
  renderCmdBtn();
  announce(on ? 'Shell mode on' : 'Shell mode off');
}

// ---- command palette (spec 9.7; rules and copy: palette.js) ------------------------------------------------------------------------
// Opens above the message box while the text is "/" + a word, or from the Commands button. Focus never leaves the textarea: the arrow
// keys move the active option (aria-activedescendant), Enter or Tab inserts it, Esc closes it and keeps the text. Never in Shell mode.

/** The Commands button: aria-disabled (still focusable) while Shell is on or the box holds text. */
function renderCmdBtn() {
  const st = commandsButton({ shell: S.on, empty: composer().value === '' });
  const btn = $('cmd-btn');
  btn.setAttribute('aria-disabled', String(st.off));
  btn.title = st.title;
}

/** "Arguments: [model]" in the hint line, only while the box still starts with the text the palette inserted. */
function renderArgHint() {
  const el = $('arg-hint');
  const show = PL.argFor !== '' && composer().value.startsWith(PL.argFor);
  el.textContent = show ? PL.argHint : '';
  el.hidden = !show;
}

async function loadCommands() {
  if (PL.busy) return;
  PL.busy = true;
  if (PL.list === null) PL.failed = false; // a retry after a failed first load shows "Loading" again
  const path = (on) => `/api/app/commands${on ? `?project=${projectKey}` : ''}`;
  let r = await call(path(projectKey && !PL.noProject));
  if (r.status === 404 && projectKey && !PL.noProject) { // a key the app does not know: the built-in, user and plugin commands still work
    PL.noProject = true;
    r = await call(path(false));
  }
  PL.busy = false;
  if (r.status === 200 && Array.isArray(r.body?.commands)) {
    PL.list = cleanCommands(r.body.commands);
    PL.failed = false;
    PL.at = Date.now();
  } else if (PL.list === null) {
    PL.failed = true; // a failed refresh keeps the list already held
  }
  if (PL.open) renderPalette(PL.shown[PL.active]?.name ?? null);
}

/** Polite, debounced 400 ms, said again only when the text changes (the count) and not at all once the list is closed. */
function sayPalette(msg) {
  if (msg === PL.said) return;
  PL.said = msg;
  clearTimeout(PL.sayTimer);
  PL.sayTimer = setTimeout(() => announce(msg), 400);
}

function optionEl(c, i) {
  const tag = sourceLabel(c);
  return h('li', { id: `pal-o-${i}`, class: 'pal-o', role: 'option', 'aria-selected': 'false', onclick: () => choose(i) },
    h('span', { class: 'pal-n mono' }, h('b', { text: `/${c.name}` }), c.argHint ? h('span', { class: 'pal-a', text: ` ${c.argHint}` }) : null),
    tag ? h('span', { class: 'pal-s', text: tag }) : null,
    c.description ? h('span', { class: 'pal-d', text: c.description, title: c.description }) : null,
    c.dialog ? h('span', { class: 'pal-dlg' }, icon('dialog'), 'Opens a dialog in the terminal') : null);
}

/** Marks option `i` active (-1 = none) for the eye (aria-selected) and for the screen reader (aria-activedescendant on the box). */
function setActive(i) {
  const items = $('palette').children;
  PL.active = i >= 0 && i < items.length ? i : -1;
  for (let k = 0; k < items.length; k += 1) items[k].setAttribute('aria-selected', String(k === PL.active));
  if (PL.active >= 0) {
    composer().setAttribute('aria-activedescendant', `pal-o-${i}`);
    items[i].scrollIntoView({ block: 'nearest' });
  } else {
    composer().removeAttribute('aria-activedescendant');
  }
}

/** Draws the list for the current text. The first option is active, unless `keep` (an option name) is still in the list. */
function renderPalette(keep = null) {
  const v = paletteView({ list: PL.list, failed: PL.failed, query: paletteQuery(composer().value) ?? '' });
  PL.shown = v.items;
  $('pal-count').textContent = v.head;
  const note = $('pal-note');
  note.textContent = v.note;
  note.hidden = v.note === '';
  const ul = $('palette');
  ul.replaceChildren(...v.items.map(optionEl));
  ul.hidden = v.items.length === 0;
  setActive(v.items.length === 0 ? -1 : Math.max(0, v.items.findIndex((c) => c.name === keep)));
  sayPalette(v.say);
}

function closePalette() {
  if (!PL.open) return;
  PL.open = false;
  clearTimeout(PL.sayTimer);
  PL.said = null;
  PL.shown = [];
  $('pal').hidden = true;
  $('palette').replaceChildren();
  setActive(-1);
}

/** Open, refresh or close the list for what the box holds now. Called at every change of the text (updateChip). */
function syncPalette() {
  const q = S.on || composer().disabled ? null : paletteQuery(composer().value);
  if (q === null) {
    closePalette();
    return;
  }
  if (!PL.open) {
    PL.open = true;
    PL.said = null;
    $('pal').hidden = false;
    if (shouldFetch({ loadedAt: PL.at, now: Date.now(), busy: PL.busy })) loadCommands();
  }
  renderPalette();
}

/** Puts "/<name> " in the box; the space closes the list. Focus stays in the box. */
function insertActive() {
  const c = PL.shown[PL.active];
  if (!c) return;
  const ins = insertion(c);
  const ta = composer();
  PL.argFor = ins.hint ? ins.text : '';
  PL.argHint = ins.hint;
  ta.value = ins.text;
  ta.focus();
  grow();
  updateChip();
  announce(ins.hint ? `Inserted ${ins.text.trim()}. ${ins.hint}` : `Inserted ${ins.text.trim()}`);
}

function choose(i) {
  setActive(i);
  insertActive();
}

function wirePalette() {
  const ta = composer();
  const btn = $('cmd-btn');
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // the box keeps focus, so the list opens under the caret
  btn.addEventListener('click', () => {
    if (aria(btn)) return; // stays focusable and does nothing; its title says why
    ta.value = '/';
    grow();
    updateChip(); // "/" is a query: this opens the list
    ta.focus();
  });
  $('pal').addEventListener('mousedown', (e) => e.preventDefault()); // a click in the list does not blur the box
  ta.addEventListener('blur', closePalette);
  ta.addEventListener('focus', syncPalette); // back in the box with "/co" still in it: the list returns (never in Shell mode)
  renderCmdBtn();
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
  if (on) endArrows(); // the Type into pane button too: arrows typed just before go first
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
  $('pass-onoff').textContent = on ? 'on' : 'off';
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
    const a = composerKey(e, {
      empty: ta.value === '', selection: ta.selectionStart !== ta.selectionEnd, choosing: PL.active >= 0, paletteOpen: PL.open,
      pop: Q.pop, pane: W.pane, status: A.kind, promptOpen: W.promptOpen,
      buttons: W.pane === 'ok' && hasAnswerButtons(W.prompt), bypass: W.prompt?.bypass === true, switching: SW.busy !== null,
    });
    if (a.act === 'none') return;
    e.preventDefault();
    if (a.act === 'arrow') {
      queueArrow(a.key, e.repeat);
      return;
    }
    const arrows = endArrows(); // the arrows already typed go first
    if (a.act === 'passthrough') setPass(true);
    else if (a.act === 'close-pop') closeModelPop(true); // the Esc ladder (spec 9.10): the model popover, then the palette (text kept), then the pane
    else if (a.act === 'close-palette') closePalette();
    else if (a.act === 'palette-move') setActive(moveActive(PL.active, a.dir, PL.shown.length));
    else if (a.act === 'palette-insert') insertActive();
    else if (a.act === 'send') sendComposer();
    else if (a.act === 'key') sendKey(a.key);
    else if (a.act === 'stop') arrows ? chain.then(stop) : stop(); // Stop is not queued, but it never overtakes arrows typed just before
    else if (a.act === 'refuse') showProblem(a.message, a.kind, a.ms);
    else if (a.act === 'focus-back') $('shell-toggle').focus();
    // 'swallow': a held key acts once
  });
  $('paste-clear').addEventListener('click', () => {
    ta.value = '';
    grow();
    updateChip();
    ta.focus();
  });
  $('send').addEventListener('click', () => { endArrows(); sendComposer(); ta.focus(); });
  $('shell-toggle').addEventListener('click', () => setShell(!S.on)); // focus stays on the toggle; the text stays in the box
  wirePalette();
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
    W.got = false;
    setPaneState('connecting');
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

// ---- the transcript toggle (docs/design/spec.md 4.1 and 6; the key rule: shortcuts.js) ---------------------------------------------

/** The toggle does something only where the split exists: a transcript and a terminal, and a window wider than 1000 px (session.css; below that the tabs choose). */
function histToggleable() {
  const split = $('split');
  return !split.classList.contains('no-hist') && !split.classList.contains('no-term') && !window.matchMedia('(max-width: 1000px)').matches;
}

const HIST = { at: null }; // where the reader was in the transcript when it was hidden: { top, bottom }; a hidden column loses its scroll offset

/** Shows or hides the transcript column and draws the button to match. `user`: also remember the choice, say it, and keep focus out of the hidden column. */
function setHist(on, user = false) {
  const sc = $('hist-scroll');
  const wasOff = $('split').classList.contains('hist-off');
  const inHist = $('sess-hist').contains(document.activeElement); // before the flip: a browser drops focus from a column that stops rendering
  if (!on && !wasOff) HIST.at = { top: sc.scrollTop, bottom: nearBottom(sc) };
  $('split').classList.toggle('hist-off', !on);
  if (on && wasOff && HIST.at) {
    sc.scrollTop = HIST.at.bottom ? sc.scrollHeight : HIST.at.top;
    HIST.at = null;
  }
  $('hist-toggle').setAttribute('aria-pressed', String(on));
  $('hist-use').setAttribute('href', on ? '#i-hist-on' : '#i-hist-off');
  $('hist-onoff').textContent = on ? 'on' : 'off';
  if (!user) return;
  storeSet('transcript', on ? 'shown' : 'hidden');
  announce(on ? 'Transcript shown' : 'Transcript hidden');
  if (!on && inHist) $('hist-toggle').focus();
}

/** The button and Mod+Shift+H. */
function toggleHist() {
  if (histToggleable()) setHist($('split').classList.contains('hist-off'), true);
}

/** At boot: the saved choice (anything but the exact word "hidden", or no storage, means shown) and the click. */
function wireHist() {
  $('hist-toggle').addEventListener('click', toggleHist);
  setHist(storeGet('transcript') !== 'hidden');
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

// ---- Back key and the Keyboard shortcuts window (docs/design/spec.md 3.13 and 4.6; the rules and the copy: shortcuts.js) ------------

const MAC = isMac(navigator);
const UI = { singleKey: true }; // ui.singleKeyShortcuts, read once at load; a failed read leaves the default (on)

function setBack(label) {
  const hint = backHint({ label, mac: MAC });
  $('back').title = hint.title;
  $('back').setAttribute('aria-keyshortcuts', hint.keys);
}

function syncHistHint() {
  const hint = histHint({ mac: MAC });
  $('hist-toggle').title = hint.title;
  $('hist-toggle').setAttribute('aria-keyshortcuts', hint.keys);
}

function syncKbdHint() {
  const hint = helpHint({ mac: MAC, singleKey: UI.singleKey });
  $('kbd-open').title = hint.title;
  $('kbd-open').setAttribute('aria-keyshortcuts', hint.keys);
}

/** The hint line's tips (spec 3.10), before the hints, the problem line and the echo; written once, with the platform's key names. */
function renderTips() {
  $('hintline').prepend(...hintTips(MAC).map((t) => h('span', { class: t.more ? 'tip more' : 'tip' },
    t.keys.map((k, i) => [i ? ' ' : null, h('kbd', { text: k })]), ` ${t.text}`)));
}

/** The passthrough key is written with the control glyph on a Mac, as in the Keyboard shortcuts window. aria-keyshortcuts stays Control+]. */
function syncPassKeys() {
  const label = passKeyLabel(MAC);
  for (const el of document.querySelectorAll('kbd[data-passkey]')) el.textContent = label;
  $('pass-toggle').title = `Type straight into the pane (${label})`;
}

function openKbd(opener) {
  openShortcuts({ window: 'session', tier: 'app', mac: MAC, singleKey: UI.singleKey, opener });
}

/** Document-level, so it also runs for the message box and the buttons; the mirror in passthrough stops its own keys first. */
function onPageKey(e) {
  const dialogOpen = Boolean(document.querySelector('dialog[open]'));
  if (wantsHelp(e, { mac: MAC, singleKey: UI.singleKey, textEntry: isTextEntry(e.target), passthrough: P.on, dialogOpen })) {
    e.preventDefault();
    openKbd(document.activeElement);
  } else if (wantsBack(e, { mac: MAC, passthrough: P.on, dialogOpen })) {
    e.preventDefault();
    $('back').click();
  } else if (wantsHistToggle(e, { mac: MAC, passthrough: P.on, dialogOpen })) {
    e.preventDefault();
    if (!e.repeat) toggleHist(); // holding the keys must not flicker the column
  }
}

async function loadSettings() {
  const r = await call('/api/app/settings');
  const ui = r.body?.ui;
  if (ui?.theme === 'system' || ui?.theme === 'light' || ui?.theme === 'dark') applyTheme(ui.theme);
  UI.singleKey = ui?.singleKeyShortcuts !== false;
  syncKbdHint();
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
  setBack('Dashboard');
  syncKbdHint();
  syncHistHint();
  syncPassKeys();
  renderTips();
  if (!appMode) {
    $('kbd-open').hidden = true;
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
  wireHist();
  wireTerminal();
  wireComposer();
  document.addEventListener('keydown', onPageKey);
  $('kbd-open').addEventListener('click', () => openKbd($('kbd-open')));
  loadSettings();
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
    $('hist-toggle').hidden = true;
    $('pane-tabs').hidden = true;
    showNotice('No transcript for this agent yet: nika has no session id for it. The live terminal still works.');
  }
  if (paneId) {
    wireSwitcher();
    wireQuick();
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
