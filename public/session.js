// nika session window (app tier): transcript history + live terminal mirror + input composer for one agent, with the permission
// mode switcher, the quick actions (Stop, Compact, Clear, Model, Rewind, End), the permission-prompt buttons, Shell mode and the
// slash-command palette. The message box and Claude's input box mirror each other (draft-sync.js, design W5), and the mirror leaves
// Claude's input box out while the message box carries it (W6). The terminal panel is measured in cells and the mirrored pane is asked to
// fit it, or the text is scaled down when it cannot (fit-ui.js, design W7).
// URL: session.html?session=<UUID>&pane=<%n>&project=<key>   (pane is sent as %25n, i.e. encodeURIComponent('%n')).
// Also the read-only view of one of Claude's own subagents (0.5, design W8): session.html?session=<UUID>&agent=<id>&project=<key>. It shows
// the subagent's transcript only (no pane, no input; the pane parameter is ignored) and a session window lists its subagents (renderSubs).
// Rules: every string from the server is rendered with textContent (h() from dom.js, applyMirror from mirror-render.js);
// no innerHTML, no inline handlers, element.style only for numbers this file computes. Contracts: docs/contracts/api-app.md.
import { h, icon, roleTagEl, ctxEl, subStateEl, subagentItemEl, labelEl, placeMenuX, clearMenuPlacement } from './dom.js';
import { isApp, appFetch, getJSON, applyTheme, windowCommand } from './api.js';
import { roleTag, savedPick, subagentView, subagentHref, SUBAGENT_ID, agentLabelView, subLabelView } from './dash-model.js';
import { toRenderModel, cutCursor, applyMirror, planSend, planPaste, chunkText, keyForEvent, KEY_LABEL, arrowEcho } from './mirror-render.js';
import { createDraftSync, cleanDraft, cutAt, caretAfter, draftSendPlan, suggestionFor, submitResult, submitMessage, STILL_SENDING, STILL_SENDING_MS } from './draft-sync.js';
import { MODE_META, MODE_TARGETS, modeKey, modeEl, bypassTag, switcherState, modeNote, switchFailure } from './modes.js';
import {
  quickState, cleanPrompt, answerOutcome, escOutcome, promptOff, promptNote, commandFailure, commandSaid, problemKind, planShell, sendGate, keysRefusal, stopOutcome, followSession,
  hasAnswerButtons, attnNote, composerKey, SESSION_ID, PANE_ID,
} from './quick-actions.js';
import { MODEL_ID, MODEL_HINT, CUSTOM, fillModelSelect } from './models-ui.js';
import { openEndDialog } from './end-dialog.js';
import { paletteQuery, cleanCommands, paletteView, commandsButton, shouldFetch, sourceLabel, insertion, moveActive } from './palette.js';
import { isMac, isTextEntry, wantsHelp, wantsBack, wantsHistToggle, backHint, helpHint, histHint, passKeyLabel, openShortcuts, wireWindowKeys } from './shortcuts.js';
import { panelSize, createFitPlanner, fitPanelView, stillOffSay, remeasure, hiddenRows, fillSize, drawnScale, roomStep, refitFrom, createRedrawHold, HOLD_POLL_MS, REFIT_MS, GROW_IDLE, growStep, growRebase, growAsk, scaleRows, cutQuestion } from './fit-ui.js';
import { createScrollPlanner, routeFor, wheelRows, scrollGate, viewRowsOf, pageRowsOf, refusalLine, noteView, scrolledSay, NOTE_MS } from './scroll.js';
import { createGlideArm, frameOf, glideFrom, matrixY, paneWriteDisarms, GLIDE_MS } from './glide.js';
import { createAttachTray } from './attach.js';
import { createDialogForm, cleanDialog } from './dialog-form.js';
import { createSurveyPanel, cleanSurvey } from './survey-panel.js';

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

// A page that opens this window can ask for one notice, by a fixed token in the address (`&notice=pick-gone`). The texts are ours;
// nothing from the address is ever shown, and any other value, or more than one `notice`, shows nothing.
const URL_NOTICES = new Map([
  ['notice=pick-gone', 'Started a new orchestrator. The saved one was gone.'],
  ['notice=pick-gone-open', 'The saved orchestrator was gone. Opened the one that is running.'],
]);

/** Shows the requested notice once and takes every `notice` parameter out of the address (the other parameters stay as they were). */
function showUrlNotice() {
  const parts = location.search.replace(/^\?/, '').split('&').filter(Boolean);
  const asked = parts.filter((x) => x === 'notice' || x.startsWith('notice='));
  if (!asked.length) return;
  const rest = parts.filter((x) => !asked.includes(x));
  try {
    history.replaceState(history.state, '', `${location.pathname}${rest.length ? `?${rest.join('&')}` : ''}${location.hash}`);
  } catch {
    // the address stays as it is
  }
  if (asked.length === 1 && URL_NOTICES.has(asked[0])) toast(URL_NOTICES.get(asked[0]));
}

const agentId = param('agent', SUBAGENT_ID); // the read-only subagent view (design W8): a valid `agent` parameter
const SUB = agentId !== null;
const BAD_AGENT = !SUB && new URLSearchParams(location.search).has('agent'); // an `agent` that is not an id: the empty state, never a guess
let sessionId = param('session', SESSION_ID); // follows the pane to its new session after /clear (followSession)
const paneId = SUB ? null : param('pane', PANE_ID); // a subagent has no pane of its own: the parameter is ignored and nothing below can reach a pane route
const projectKey = param('project', PROJECT_KEY);

// F17 (design F17): arm, the matcher of glide.js made by wireScroll (a scroll request arms it; any write to the pane but the scroll, the capture and the fit heartbeat disarms it, see call); timer, the fallback that ends a slide.
// Declared before call(), which reads it from the first request on.
const GL = { arm: null, timer: 0 };

/** appFetch that never throws: { status, body }; status 0 = network failure. A write to the pane (a key, a submit, a command, a dialog answer, Stop, a mode switch, ...) first ends a pending glide (F17): this is the one place they all pass. */
async function call(path, opts = {}) {
  if (paneWriteDisarms(path, opts.method)) GL.arm?.disarm();
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

/**
 * The notes row (#notes) holds four visible parts (the argument hint, the shell hint, the draft note, the problem line) and, screen-reader-only, the echo
 * and the attachment help. It is a grid item of the composer, so even an empty row would cost one gap. While none of the four shows the row is `quiet`
 * (session.css: out of the grid, 1px and clipped, still rendered), so it takes no height and no gap and the echo is still announced.
 */
function syncNotes() {
  const quiet = $('arg-hint').hidden && $('shell-hint').hidden && $('draft-note').hidden && $('problem').textContent === '';
  $('notes').classList.toggle('quiet', quiet);
}

/** Syncs the row now and after every change inside it (a part shown or hidden, the problem line filled or cleared): one place, no call at each toggle. */
function watchNotes() {
  new MutationObserver(syncNotes).observe($('notes'), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  syncNotes();
}

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

// A is what the agent poll said: name, status kind, the attention reason (why a 'Needs you' agent waits), the model id and label, and
// the session's subagents as the last poll listed them (subs: the transcript link names the one it opens). In the subagent view `kind`
// follows the subagent: busy = running, idle = finished (still polled: Claude wakes a subagent again), ended = stopped (its session is gone).
const A = { name: 'the agent', kind: null, attention: '', modelId: '', projectLooked: false, pickId: null, pickAsked: false, subs: [] };

/** The role badge next to the title (design 0.4 section 1.1, the same markup as the rows): orchestrator, sub-orchestrator or, for a session that ended, saved. */
function renderRole(agent) {
  const tag = roleTagEl(roleTag(agent, A.pickId));
  const el = $('sess-role');
  el.replaceChildren(...(tag ? [tag] : []));
  el.hidden = !tag;
}

/** The kind chip next to the role badge (design W9 4.4): a pane the server tagged agent shows its kind; the orchestrator, a sub-orchestrator, a user's own session and an ended one show nothing. Replaced at every poll, never added to. */
function renderKind(agent) {
  const chip = labelEl(agentLabelView(agent));
  const el = $('sess-kind');
  el.replaceChildren(...(chip ? [chip] : []));
  el.hidden = !chip;
}

/** App tier, once per window and only for a session that ended: is it the project's saved orchestrator? (A running one shows its tmux tags.) True when it has just learned the answer. */
async function loadPick(agent) {
  if (!isApp || !projectKey || A.pickAsked || agent.live) return;
  A.pickAsked = true;
  const r = await call('/api/app/projects');
  if (r.status !== 200 || !Array.isArray(r.body?.projects)) return false;
  A.pickId = savedPick(r.body.projects.find((p) => p?.key === projectKey))?.id ?? null;
  return true;
}

/** The Back link names the project only when this window came from one (its href is then /#project/<key>); otherwise it stays "Dashboard". */
function applyBackLabel(group) {
  if (!projectKey || !group?.label) return;
  $('proj').textContent = String(group.label);
  setBack(String(group.label));
}

/** The header meter (design 0.4 section 6.4): hidden until the first poll, then drawn from the polled agent's `context` at every poll. */
function renderContext(agent) {
  const el = $('sess-ctx');
  ctxEl(agent.context, { header: true, el });
  el.hidden = false;
}

// The subagent list of a session window (design W8, 4.3): `show` is the "Show ended" box (own choice, nika.showEndedSession; only the
// stored word "true" is on), `sig` what is drawn, `last` the agent the last poll gave (the box redraws from it without waiting).
const SUBS = { show: storeGet('showEndedSession') === 'true', sig: '', last: null };

/** The list of Claude's own subagents at the top of the Transcript column. Redrawn only when what it shows changes; the disclosure's open state is the reader's. */
function renderSubs(agent) {
  SUBS.last = agent;
  A.subs = Array.isArray(agent.subagents) ? agent.subagents : [];
  const v = subagentView(agent.subagents, SUBS.show);
  $('sess-subs').hidden = !v;
  if (!v) {
    SUBS.sig = '';
    return;
  }
  const sig = JSON.stringify([agent.id, A.name, SUBS.show, v.summary, v.hint, v.shown.map((s) => [s.id, s.state, s.description, s.type, s.label, s.modelLabel])]);
  if (sig === SUBS.sig) return;
  SUBS.sig = sig;
  $('subs-sum').replaceChildren(...(v.hint ? [v.summary, ' ', h('span', { class: 'muted sub-hid', text: v.hint })] : [v.summary]));
  const list = $('subs-list');
  const focused = list.contains(document.activeElement) ? document.activeElement.getAttribute('data-fk') : null; // keep the reader's place across the redraw
  list.setAttribute('aria-label', `Subagents of ${A.name}`);
  list.replaceChildren(...v.shown.map((s) => subagentItemEl(s, { href: subagentHref({ session: agent.id, agent: s.id, project: projectKey }), fk: `sub:${s.id}` })));
  if (focused) [...list.querySelectorAll('a')].find((a) => a.getAttribute('data-fk') === focused)?.focus({ preventScroll: true });
}

/** At boot: the box starts from the stored choice, and a change is remembered and drawn at once. */
function wireSubs() {
  const box = $('subs-ended');
  box.checked = SUBS.show;
  box.addEventListener('change', () => {
    SUBS.show = box.checked;
    storeSet('showEndedSession', String(SUBS.show));
    if (SUBS.last) renderSubs(SUBS.last);
  });
}

function applyAgent(agent, group) {
  if (SUB) {
    applySubagent(agent); // the polled session is the parent of the subagent this window shows (it has no pane: nothing to follow after /clear)
    return;
  }
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
  renderContext(agent);
  const pane = paneId ?? agent.pane?.id;
  $('meta-pane').hidden = !(typeof pane === 'string' && PANE_ID.test(pane));
  $('sess-pane').textContent = typeof pane === 'string' && PANE_ID.test(pane) ? pane : '';
  $('sess-branch').hidden = !agent.gitBranch;
  $('sess-branch').textContent = agent.gitBranch ? String(agent.gitBranch) : '';
  renderRole(agent);
  renderKind(agent);
  loadPick(agent).then((learned) => { if (learned) renderRole(agent); }, () => {});

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
  renderSubs(agent);
  $('composer-label').textContent = `Message to ${A.name}. Enter sends, Shift+Enter adds a line. Escape and Control+C go to Claude; so does Shift+Tab when no question or prompt is open, and the arrow keys and Enter when the box is empty. Control+Shift+Tab moves focus back.`;
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

// ---- the read-only subagent view (design W8, 4.4) ----------------------------------------------------------------------

/** The one place the Back address is set: boot sets the dashboard or the project, the subagent view then sets the parent's window. */
function setBackHref(target) {
  $('back').href = target;
}

/** Subagent mode, at boot: the header says "Subagent" until a poll names it, and the parts that belong to a message box and a pane are out. */
function readOnlyView() {
  document.body.classList.add('sub-view');
  document.querySelector('.skip-2').hidden = true; // "Skip to message input": there is no message box
  $('sess-st').hidden = true; // no state badge until a poll names the state
  $('sess-h').textContent = 'Subagent';
  document.title = `Subagent${MID}nika`;
}

/** What the subagent is called: its description, else its type, else "Subagent" and the start of its id. A blank text counts as none. */
function subTitle(s) {
  for (const v of [s?.description, s?.type]) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return `Subagent ${agentId.slice(0, 8)}`;
}

/** Back goes up to the session that runs the subagent: its window, with its pane while it is live, and the project when this address had one. */
function subBack(parent) {
  const pane = parent.live === true && typeof parent.pane?.id === 'string' && PANE_ID.test(parent.pane.id) ? parent.pane.id : null;
  const q = [`session=${sessionId}`, pane && `pane=${encodeURIComponent(pane)}`, projectKey && `project=${projectKey}`].filter(Boolean);
  setBackHref(`session.html?${q.join('&')}`);
  const name = typeof parent.name === 'string' && parent.name && parent.name !== sessionId.slice(0, 8) ? parent.name : 'untitled session';
  $('proj').textContent = name;
  setBack(name);
}

/** Subagent mode: the agent poll's answer, the parent session (the poll hands over nothing when the snapshot does not list it). */
function applySubagent(parent) {
  if (parent) subBack(parent);
  const s = (Array.isArray(parent?.subagents) ? parent.subagents : []).find((x) => x?.id === agentId) ?? null;
  const badge = s ? subStateEl(s.state, { pill: true }) : null;
  $('sess-st').hidden = !badge;
  $('sess-st').replaceChildren(...(badge ? [badge] : []));
  if (!badge) {
    A.kind = null; // unknown subagent or state: the polls go on and the header keeps what it had
    return;
  }
  const title = subTitle(s);
  A.name = title;
  $('sess-h').textContent = title;
  $('sess-h').title = title;
  document.title = `${title}${MID}nika`;
  const role = roleTagEl('subagent');
  $('sess-role').replaceChildren(...(role ? [role] : []));
  $('sess-role').hidden = !role;
  const chip = labelEl(subLabelView(s)); // never empty: the label is 'agent' at worst, and its title names Claude's own type
  $('sess-kind').replaceChildren(...(chip ? [chip] : []));
  $('sess-kind').hidden = !chip;
  $('sess-model').textContent = typeof s.modelLabel === 'string' ? s.modelLabel : '';
  $('sess-model').hidden = !$('sess-model').textContent;
  const kind = ({ running: 'busy', finished: 'idle', stopped: 'ended' })[s.state]; // finished is still polled: Claude removes it again when the subagent wakes up
  if (kind !== A.kind) {
    if (A.kind !== null) {
      announce(kind === 'busy' ? `${title} is running again` : `${title} ${s.state}`);
      if (kind !== 'busy') refreshHistory(); // one last read at the live edge, before an 'ended' kind stops the poll
    }
    A.kind = kind;
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
// dialog: the capture's question dialog or plan approval as cleanDialog allows it (0.5): the form draws from it, a dialog also counts as promptOpen.
const W = { pane: 'connecting', got: false, mode: 'unknown', confirmed: true, prompt: null, promptOpen: false, dialog: null, survey: null, last: null, msg: null, struck: new Set(), strikeAt: null, tagSig: '', whySig: '' };
const SW = { busy: null, pressed: null, parts: [] };
let DF = null; // the question dialog form (dialog-form.js), built in boot() with the pane
let SV = null; // the feedback survey panel (survey-panel.js), built in boot() with the pane

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
  DF?.render({ pane: W.pane, dialog: W.dialog, name: A.name, attention: A.attention, growing: growing() });
  SV?.render({ pane: W.pane, survey: W.survey, blocked: W.promptOpen || A.kind === 'attn', name: A.name }); // never beside a prompt, a dialog or the attention note
}

/** What a capture says about the mode and the prompt. The tag follows every capture; only a change is announced. */
function noteScreen(body) {
  W.got = true;
  W.pane = 'ok';
  W.mode = modeKey(body.mode);
  W.confirmed = body.modeConfirmed === true;
  W.prompt = cleanPrompt(body.prompt); // null for anything but the contract shape: no panel, no buttons
  W.dialog = cleanDialog(body.dialog); // null only when the capture has none; anything off the contract is { state: 'unreadable' }
  W.promptOpen = Boolean(body.prompt) || W.dialog !== null; // an off-contract prompt or dialog still counts as a prompt for the gates
  W.survey = cleanSurvey(body.survey); // null for anything but the contract shape (0.5, F14): no panel
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
    if (HOLD.active) await HOLD.wait(); // F10: the segment shows busy while the redraw hold runs
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
const Q = { ready: false, b: {}, busy: null, stopping: false, pop: false, catalog: null, loading: false, whySig: null, nameSig: null, queued: false }; // queued: the capture says Claude holds a message of ours (Stop's title says what Stop does with it)
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
  const st = quickState({ pane: W.pane, status: A.kind, prompt: W.promptOpen, dialog: W.dialog !== null, switching: SW.busy !== null || Q.busy !== null || Q.stopping, queued: Q.queued });
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
  if (HOLD.active) await HOLD.wait(); // F10
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
  const out = stopOutcome({ status: r.status, code: r.body?.error, name: A.name, dialog: W.dialog !== null });
  if (out.ok) {
    clearProblem();
    say(out.say);
    return;
  }
  if (r.status === 404) setGone();
  showProblem(out.message, problemKind(r.status));
}

function openEnd() {
  GL.arm?.disarm(); // F17: its own request is sent by end-dialog.js (not through call), and ending the session redraws everything
  const open = () => openEndDialog({
    pane: paneId,
    name: A.name,
    working: A.kind === 'busy',
    promptOpen: W.promptOpen || A.kind === 'attn',
    onEnded: () => {
      toast('Session ended');
      setGone(); // the pane no longer runs Claude: the mirror shows its pane-gone state now instead of at the next capture
    },
  });
  if (HOLD.active) HOLD.wait().then(open); // F10: the dialog's own request is sent by end-dialog.js, so the dialog opens after the redraw hold
  else open();
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
  const panel = W.pane === 'ok' && (W.prompt !== null || DF?.shown() === true);
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

const MAX_ENTRIES = 500; // DOM cap: the oldest entries leave while the reader follows the live tail, the newest after Load older; a reader who scrolled up loses none
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
      subagent: e.kind === 'tool_use' && typeof e.subagent === 'string' && SUBAGENT_ID.test(e.subagent) ? e.subagent : '', // the subagent a call started, when the server linked it
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

/** The link from a tool call to its subagent's transcript (design W8, 4.5): only in a session window, only for an id of the right shape. */
function subLinkEl(e) {
  if (SUB || !e.subagent) return null;
  const href = subagentHref({ session: sessionId, agent: e.subagent, project: projectKey });
  if (!href) return null;
  const known = A.subs.find((x) => x?.id === e.subagent);
  const attrs = { class: 'hx-sub', href, text: 'Open subagent transcript' };
  if (typeof known?.description === 'string' && known.description) attrs['aria-label'] = `Open the transcript of subagent ${known.description}`;
  return h('a', attrs);
}

/** A call already on screen whose subagent got its meta since (the server links it at a later read): the link joins it, once. */
function linkLate(entries) {
  for (const e of entries) {
    if (!e.subagent) continue;
    const it = H.items.find((x) => x.e.id === e.id);
    if (!it || it.e.subagent) continue;
    const link = subLinkEl(e);
    if (!link) continue;
    it.el.append(link);
    it.e.subagent = e.subagent;
  }
}

function entryEl(e) {
  const when = Date.parse(e.at);
  const time = Number.isFinite(when)
    ? h('time', { class: 'hx-at', datetime: new Date(when).toISOString(), title: new Date(when).toLocaleString(), text: new Date(when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : null;
  const who = e.kind === 'tool_result' ? 'Tool' : e.role === 'user' ? (SUB ? 'Parent' : 'You') : 'Claude';
  const li = h('li', { class: 'hx', 'data-role': e.role, 'data-kind': e.kind }, h('div', { class: 'hx-meta' }, h('span', { class: 'hx-who', text: who }), time));
  li.append(...(e.kind === 'text' ? textBlock(e) : [foldBlock(e)]));
  const link = subLinkEl(e);
  if (link) li.append(link);
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
  if (H.older === null && n > 0 && !start) $('hx-list').before(h('p', { class: 'hx-start', text: SUB ? "Start of the subagent's transcript" : 'Start of the session' }));
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
  return call(SUB ? `/api/app/session/${sessionId}/subagents/${agentId}/history?${qs}` : `/api/app/session/${sessionId}/history?${qs}`);
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
    historyNote(SUB ? 'No transcript for this subagent yet. nika keeps looking.' : 'No transcript found for this session yet. nika keeps looking.');
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
    const late = entries.filter((e) => e.subagent);
    if (late.length) linkLate(late); // a call on screen that has its subagent now
    if (H.items.length && !entries.some((e) => H.ids.has(e.id))) {
      resetHistory(entries, nextBefore(r.body?.nextBefore)); // more than one page arrived since the last poll
      return;
    }
    const lastKey = H.items.length ? keyOf(H.items[H.items.length - 1].e.id) : -1;
    const fresh = entries.filter((e) => !H.ids.has(e.id) && keyOf(e.id) > lastKey);
    const sc = scroller();
    const stick = nearBottom(sc);
    if (!fresh.length && !(stick && H.items.length > MAX_ENTRIES)) return; // a reader back at the bottom gets the cap even when nothing is new
    const top = sc.scrollTop;
    mount(fresh, 'end');
    const h0 = sc.scrollHeight;
    if (stick) trim('start'); // only while following the tail: a reader who scrolled up keeps every entry, so the list never moves under them
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

const M = { etag: null, timer: 0, busy: false, gone: false, frozen: false, errors: 0, cols: 0, rows: 0, fatal: false, inputOff: false, sent: 0, waiters: [], body: null, draft: null, cut: null };

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
  renderSuggestion(); // the state class goes with the box being usable
  document.querySelector('.inbox').classList.toggle('off', !on);
  ATT.enable(on);
  if (!on) setPass(false, true);
  else if (refocus.composer) $('composer').focus({ preventScroll: true });
  if (on) refocus.composer = false;
}

function setGone() {
  M.gone = true;
  GR = GROW_IDLE; // F16: the lease is over (the close below gives the window back)
  clearTimeout(M.timer);
  DS.stop();
  FIT.planner?.close(); // the heartbeat stops and the tmux window comes back (one DELETE); the next capture that answers starts a new lease
  SC.planner?.close();
  GL.arm?.disarm(); // F17
  endGlide();
  setLive('off', 'Not live');
  setPaneState('gone');
  setInputEnabled(false, 'Pane is gone');
  showOverlay(`Pane ${paneId} is gone`, 'The agent ended or the pane was closed. The transcript is still readable.', { retry: 'Check again' });
  announce(`Pane ${paneId} is gone`);
}

function setFrozen(on) {
  if (on === M.frozen) return;
  M.frozen = on;
  renderNote();
  if (on) setLive('paused', `Paused${MID}${M.cols} ${TIMES} ${M.rows}`);
  else {
    setLive('live', `Live${MID}${M.cols} ${TIMES} ${M.rows}`);
    kickMirror(0);
  }
}

function recovered() {
  if (M.errors) DS.reset(); // tmux answers again: the first readable capture follows the first-capture rule (no wipe)
  M.errors = 0;
  hideOverlay();
  const pane = W.got ? 'ok' : 'connecting';
  if (W.pane !== pane) setPaneState(pane);
  if (M.inputOff) {
    M.inputOff = false;
    setInputEnabled(true);
  }
}

/**
 * Draws the last capture: every row, or, while the message box carries Claude's input box (a readable draft, Type into pane off), the rows above it and the one-row strip in its place.
 * F11: the cut drawn is kept in M.cut (null with no strip) for the commit points, and an unpaused mirror is pinned to the bottom at once (a Type into pane toggle shows
 * Claude's box and footer, or the strip, without waiting for the next capture).
 */
function drawMirror() {
  const body = M.body;
  if (!body) return;
  const cut = cutAt(M.draft, P.on);
  const on = cut !== null && cut < body.rows.length;
  M.cut = on ? cut : null;
  applyMirror($('term-rows'), toRenderModel(body, { cutAt: on ? cut : null }), cutCursor(body.cursor, on ? cut : null));
  $('term-cut').hidden = !on;
  const term = $('term');
  if (!M.frozen) term.scrollTop = term.scrollHeight;
}

function handleCapture(r) {
  if (r.status === 304) {
    recovered();
    try {
      growTick(); // F16: the screen is the same, but time has passed
    } catch {
      // the mirror keeps working without the grow
    }
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
    const draft = cleanDraft(r.body.draft);
    let glide = null; // F17: the first changed frame after a scroll request, matched with the one drawn (null: nothing to slide)
    try {
      if (GL.arm?.armed()) glide = GL.arm.offer(frameOf(r.body, draft)) ?? null; // a frame is built only inside the window of a scroll request
    } catch {
      glide = null; // the mirror keeps working without the glide
    }
    M.body = r.body;
    M.draft = draft;
    drawMirror();
    if (glide?.act === 'glide') {
      try {
        startGlide(glide);
      } catch {
        endGlide();
      }
    }
    try {
      if (!ATT.sending()) DS.capture(M.draft, cols); // the box holds placeholders for a moment while attachments go in: no paused note then
      renderSuggestion(); // the placeholder follows the screen's draft
    } catch {
      // the mirror keeps working without the sync
    }
    const queued = M.draft?.queued === true; // outside the try: Stop's title follows the last capture even when the sync threw
    if (queued !== Q.queued) { // it says what Stop does with a message Claude holds in its queue
      Q.queued = queued;
      renderQuick();
    }
    setLive(M.frozen ? 'paused' : 'live', `${M.frozen ? 'Paused' : 'Live'}${MID}${cols} ${TIMES} ${M.rows}`); // the pane's real size, not the panel's
    try {
      fitCaptured();
    } catch {
      // the mirror keeps working without the fit
    }
    try {
      scrollCaptured(r.body);
    } catch {
      // the mirror keeps working without scrolling
    }
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
    SC.planner?.close();
    GR = GROW_IDLE; // F16
    GL.arm?.disarm(); // F17
    endGlide();
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

// One request in flight; ~4 Hz while the tab is visible and the view is live (10 Hz during a redraw hold, F10). Paused states re-kick themselves.
async function tickMirror() {
  M.timer = 0;
  if (M.gone || M.fatal || M.busy || document.hidden) return; // a paused mirror keeps polling: the mode and the prompt must stay true
  M.busy = true;
  M.sent += 1;
  const sent = M.sent;
  const t0 = Date.now();
  try {
    const r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/capture`, { headers: M.etag ? { 'If-None-Match': `"${M.etag}"` } : {} });
    let applied = true; // R2 #7: a capture the redraw hold kept back was not drawn, so it is no look at where a mode switch stopped
    try {
      applied = handleHeld(r, sent) !== false;
    } catch {
      M.errors += 1;
      M.inputOff = true;
      setPaneState('tmux');
      setInputEnabled(false, 'tmux is not answering');
      showOverlay('The terminal could not be drawn', 'nika retries every 2 seconds.', { retry: 'Retry now', alert: true });
    }
    if (applied) captureHandled(sent);
  } finally {
    M.busy = false;
  }
  kickMirror(M.errors ? 2000 : Math.max(0, (HOLD.active ? HOLD_POLL_MS : 250) - (Date.now() - t0))); // F10: 100 ms while a redraw hold waits for Claude's repaint
}

function jumpToLive() {
  const term = $('term');
  M.etag = null;
  term.scrollTop = term.scrollHeight;
  term.scrollLeft = 0; // a wide pane: back to column 0 as well
  if (SC.scrolled && !M.gone && !M.fatal) SC.planner?.jump('bottom'); // Claude's own view too (not while the pane is gone or the connection is lost: the route would only refuse)
  setFrozen(false);
  $('composer').focus();
}

// ---- fit (design W7): the panel in cells goes to the server, which fits the pane to it; a pane that stays larger is drawn at a smaller text scale ----

// planner: the request planner of fit-ui.js, made when the window has a pane. panel: the held frame's size, { cols, rows } in cells (null before one).
// frame: the held frame, { cols, rows, width, height, cellW, cellH, iw, ih } (F10: measured only at the commit points of fitCommit). scale: the --fit-scale now
// set. view: the chip's last drawn view (null while there is no chip). ui: the chip panel's own state (F1): pending, a Fit again is on its way; note, it was
// refused or lost. pop: the panel is open. F10: state, the chip state of the latest answer (drawn or held); room, the page asked for the room (33 rows or more, F11) because Claude's
// footer did not fit (kept for this window until Fit again or a new window size); d, the border row (asked rows minus the pane's rows, 0 or 1); sentRows, the
// rows of the request on its way; held, the chip view an answer brought during a redraw hold, { view, opts }; refitTimer, the timer that ends the transition.
// F11: hide and strip, the hidden rows under the strip and its height in px as read at the last commit point; sentCols, the columns of the request on its way (an answer
// with those columns is nika's own size); scaledAt, the pane size { cols, rows } the text scale was last worked out for (null before the first).
// F16: base, the size the fit asks without the grow ({ cols, rows }, the last commit's or room step's; null before the first).
const FIT = { planner: null, panel: null, frame: null, scale: 1, view: null, ui: { pending: false, note: false }, pop: false, state: null, room: false, d: 0, sentRows: 0, held: null, refitTimer: 0, hide: 0, strip: 0, sentCols: 0, scaledAt: null, base: null };
// F16: the grow of a cut-off question (fit-ui.js growStep): more rows for the pane while the question is open, the size back when it closes
let GR = GROW_IDLE;
// F10, design F10 4: after nika's own resize the last good frame stays drawn until a capture at the new size shows Claude's input box, for 1.2 s at most
const HOLD = createRedrawHold({
  after: (fn, ms) => setTimeout(fn, ms),
  cancel: (timer) => clearTimeout(timer),
  timeout: holdTimeout,
  ended: holdEnded,
});

/** The pane's fit route; a window with no pane has none, and asks nothing. */
function fitCall(method, opts = {}) {
  if (!paneId) return Promise.resolve({ status: 0, body: null });
  return call(`/api/app/pane/${encodeURIComponent(paneId)}/fit`, { method, ...opts });
}

/**
 * Whether this window has focus (F9, the focused window wins the pane's size): visible, and document.hasFocus() is the boolean true. Anything unreadable is
 * no focus, so a page that cannot tell never holds the size of a window a terminal shows. The planner reads it fresh on every event, poll and request.
 */
function fitFocused() {
  try {
    return document.visibilityState === 'visible' && typeof document.hasFocus === 'function' && document.hasFocus() === true;
  } catch {
    return false;
  }
}

/**
 * The panel as it is now (F10): the terminal's border box over one glyph cell (the probe: 100 glyphs in the unscaled font), with the window's inner size. null while
 * any number cannot be measured (a hidden tab). Nothing is stored: only fitMeasure holds a frame.
 */
function fitProbe() {
  const rect = $('term').getBoundingClientRect();
  const cell = $('fit-probe').getBoundingClientRect();
  const cellW = cell.width / 100;
  const panel = panelSize({ width: rect.width, height: rect.height, cellW, cellH: cell.height });
  return panel && { ...panel, width: rect.width, height: rect.height, cellW, cellH: cell.height, iw: window.innerWidth, ih: window.innerHeight };
}

/** Holds the frame measured now and its size in cells. A box that cannot be measured (a hidden tab) keeps the last good one. */
function fitMeasure() {
  const frame = fitProbe();
  if (frame) {
    FIT.frame = frame;
    FIT.panel = { cols: frame.cols, rows: frame.rows };
  }
  return FIT.panel;
}

/**
 * F11: the height in CSS px of the one-row strip that stands in for Claude's input box and footer: from the bottom of the rows to the bottom of the strip, both
 * layout values of the same offset parent (.term), so the refit transform does not distort them. 0 while the strip is not shown or the webview gives no
 * usable offsets (fillSize and drawnScale then count 2 cells).
 */
function fitStrip() {
  const cut = $('term-cut');
  const rows = $('term-rows');
  if (!cut || !rows || cut.hidden) return 0;
  const px = cut.offsetTop + cut.offsetHeight - (rows.offsetTop + rows.offsetHeight);
  return px > 0 ? px : 0; // NaN (no offsets) fails the comparison too
}

/** The text scale: 1 while the pane fits the panel, smaller while it is larger (not below fit-ui.js SCALE_MIN, never above 1). Set through CSSOM only: the CSP allows no style attribute. */
function fitScale() {
  const p = FIT.panel;
  if (!p || !M.cols) return;
  FIT.scaledAt = { cols: M.cols, rows: M.rows };
  // F11: the rows actually drawn count (the rows above the cut and the strip), not the hidden ones; with no strip it is F10's scale
  const hide = hiddenRows(M.body?.rows, M.cut);
  // F16: while the pane is taller because of the grow, the text keeps the size it has without it (the mirror overflows, pinned to the bottom); FIT.hide: the base counts the rows hidden at the commit
  const rows = scaleRows({ paneRows: M.rows, G: GR, fitted: FIT.state === 'fitted', baseRows: FIT.base?.rows, d: FIT.d, hide: FIT.hide });
  const s = drawnScale({ frame: FIT.frame ?? p, cols: M.cols, rows, hide, strip: hide > 0 ? fitStrip() || FIT.strip : 0 });
  if (s === FIT.scale) return;
  FIT.scale = s;
  $('term').style.setProperty('--fit-scale', String(s));
}

/**
 * A commit point (F10: the start, a focus, a change of the window, the font or the panel's width, Fit again): the frame is measured and held, its size is
 * asked for (the room size while FIT.room is on), and the text scale follows. A new window size ends the room: it deserves a try at the panel's own size.
 * F11: the hidden rows under the strip and the strip's height are read here, from the frame drawn now, and the size asked counts them (fillSize); never per capture.
 */
function fitCommit() {
  const prev = FIT.frame;
  fitMeasure();
  const frame = FIT.frame;
  if (!frame) return;
  if (FIT.room && prev && (frame.iw !== prev.iw || frame.ih !== prev.ih || Math.abs(frame.width - prev.width) >= prev.cellW)) FIT.room = false;
  FIT.hide = hiddenRows(M.body?.rows, M.cut);
  FIT.strip = FIT.hide > 0 ? fitStrip() : 0;
  const ask = fillSize(frame, FIT.room, FIT.d, FIT.hide, FIT.strip);
  FIT.base = ask;
  GR = growRebase(GR, ask.cols, ask.rows); // F16: a given-up question gets one new try at a new base size
  const want = growAsk(ask, GR); // F16: while a cut-off question is open the grown rows stay asked
  FIT.planner?.size(want.cols, want.rows);
  fitScale();
}

/**
 * The box changed size, or the font arrived. Only a change of the window, the font or the panel's width is a commit; a box that only got taller or shorter (a
 * line, a chip or a panel came or went) asks nothing, scales nothing, and keeps the mirror pinned to the bottom (F10).
 */
function fitResize() {
  const next = fitProbe();
  if (next && !remeasure(FIT.frame, next)) {
    if (!M.frozen) $('term').scrollTop = $('term').scrollHeight;
    return;
  }
  fitCommit();
}

/**
 * After every drawn capture: the first one of a lease starts the fit (the pane answered, so it is live), and the scale follows the pane's size.
 * F11: that first frame is a commit point (its hidden rows go into the start request, which is still one request), and the text is worked out again only when the
 * pane's size is not the one it was worked out for (held between those moments, so a draft growing a line never moves the text).
 */
function fitCaptured() {
  if (FIT.planner?.startable) fitCommit();
  FIT.planner?.start();
  const at = FIT.scaledAt;
  if (!at || at.cols !== M.cols || at.rows !== M.rows) fitScale();
  growTick();
}

/** F16: whether a step of the grow runs and the fit is `fitted`: the dialog form keeps its Reading note while it does. */
function growing() {
  return GR.phase === 'stepping' && FIT.state === 'fitted';
}

/**
 * F16: one look at the drawn capture for the grow of a cut-off question (fit-ui.js growStep): called after every drawn capture and every 304. It may ask
 * more rows, or the base size back, at once. The page is drawn again when a step starts or ends (the form keeps its Reading note while one runs, D11), and
 * the chip's panel when its grow line comes or goes.
 */
function growTick() {
  if (!FIT.planner || !FIT.base || M.gone || M.fatal) return;
  const was = GR.phase === 'stepping' || GR.phase === 'held';
  const before = growing();
  const { G, ask } = growStep(GR, { now: Date.now(), dialog: W.dialog, fitted: FIT.state === 'fitted', paneRows: M.rows, baseRows: FIT.base.rows, baseCols: FIT.base.cols });
  GR = G;
  if (ask) {
    const want = growAsk(FIT.base, GR); // the grown rows, or the base size after a give-up or a close
    FIT.planner.size(want.cols, want.rows, { now: true });
  }
  if ((GR.phase === 'stepping' || GR.phase === 'held') !== was && FIT.pop) drawFitPop();
  if (growing() !== before) renderMode(); // no capture may come for a while (a redraw hold keeps them back): the form must not let its Reading note run out meanwhile
}

// ---- the redraw hold (F10, design F10 4): the last good frame stays up while Claude repaints after nika's own resize ----

/** The planner's word on a 200 answer's pane size: the border row is learned, and a pane that is not the drawn size starts a hold (a first capture is kept for the new size). */
function fitSized(pane) {
  if (pane.cols === FIT.sentCols) { // F11: only nika's own size tells the border row; a terminal's or a zoomed size says nothing about it, so the old one stays
    const d = FIT.sentRows - pane.rows;
    if (d === 0 || d === 1) FIT.d = d;
  }
  if (!M.body) return; // nothing drawn yet: nothing to hold
  if (pane.cols === M.cols && pane.rows === M.rows) { // the drawn frame is the answered size: nothing to wait for
    HOLD.end();
    return;
  }
  // F12: besides the box, did the drawn frame show Claude's mode line (a confirmed, known mode)? Then the hold waits for the mode line too.
  const plainBefore = M.body.alt === true && M.draft !== null;
  const modeBefore = plainBefore && M.body.modeConfirmed === true && modeKey(M.body.mode) !== 'unknown';
  const cutBefore = GR.phase === 'stepping' && cutQuestion(M.body.dialog); // F16: a grow step waits for Claude to repaint the question whole
  HOLD.start({ want: { cols: pane.cols, rows: pane.rows }, plainBefore, modeBefore, cutBefore });
  kickMirror(0);
}

/** The chip sink of the planner: the latest state is kept, and a view that comes during a hold waits for the frame (null hides the chip at once). */
function fitChip(view, opts) {
  FIT.state = view ? view.state : null;
  if (view && HOLD.active) {
    FIT.held = { view, opts };
    return;
  }
  FIT.held = null;
  renderFit(view, opts);
}

/** The hold is over: the chip an answer brought meanwhile is drawn now, in the step of the frame. */
function flushChip() {
  const held = FIT.held;
  FIT.held = null;
  if (held) renderFit(held.view, held.opts);
}

function holdEnded() {
  flushChip();
}

/**
 * One answered capture (`n`: the number of its request): kept back while a hold waits for Claude's repaint; else drawn. A gone pane, a refusal or an error ends
 * the hold at once and is handled as always. Returns false for a capture that was kept back (not drawn), true for any other: only a drawn one tells the
 * waiters of nextCapture (R2 #7); a kept one carries `n`, so that holdTimeout can tell them when it draws it.
 */
function handleHeld(r, n) {
  if (HOLD.active) {
    if (r.status === 200 && Array.isArray(r.body?.rows) && Number.isInteger(r.body.cols)) {
      if (HOLD.offer({ r, body: r.body, draft: cleanDraft(r.body.draft), n }) === 'keep') return false;
      applyHeld(r);
      return true;
    }
    if (r.status !== 304) HOLD.end();
  }
  handleCapture(r);
  return true;
}

/** Draws a capture a hold let through; when it has another size than the drawn one, the new frame fades in (and zooms in when the text grows). */
function applyHeld(r) {
  const was = { cols: M.cols, rows: M.rows, scale: FIT.scale };
  handleCapture(r);
  if (was.cols && (M.cols !== was.cols || M.rows !== was.rows)) {
    GL.arm?.disarm(); // F17: nika's own resize is never a scroll; a slide still running ends before the refit starts
    endGlide();
    refit(was.scale);
  }
}

/** The new frame's transition (F10 6.2): --refit-from through CSSOM, the class restarted; it ends on animationend or, with no animation (reduced motion), after REFIT_MS + 50 ms. */
function refit(oldScale) {
  const rows = $('term-rows');
  rows.style.setProperty('--refit-from', String(refitFrom(oldScale, FIT.scale)));
  rows.classList.remove('refit');
  void rows.offsetWidth; // the animation starts again
  rows.classList.add('refit');
  clearTimeout(FIT.refitTimer);
  FIT.refitTimer = setTimeout(endRefit, REFIT_MS + 50);
}

function endRefit() {
  clearTimeout(FIT.refitTimer);
  FIT.refitTimer = 0;
  $('term-rows').classList.remove('refit');
}

/**
 * The hold ran out (F10 4.4). With the room conditions (fit-ui.js roomStep; F12: also a readable box whose mode line is gone) the page asks once for 33 rows and
 * the hold goes on until that answer; else the latest kept capture is drawn as it is, so the page then shows the truth (the server refuses what it must).
 */
function holdTimeout(pending, ctx) {
  const frame = FIT.frame;
  const ask = frame ? fillSize(frame, true, FIT.d, FIT.hide, FIT.strip) : null; // F11: the room fill size, with the hidden rows of the last commit
  if (pending && frame && roomStep({ room: FIT.room, frameRows: frame.rows, state: FIT.state, plainBefore: ctx.plainBefore, modeBefore: ctx.modeBefore, want: ctx.want, body: pending.body, draft: pending.draft, gain: ask.rows > FIT.sentRows })) {
    FIT.room = true;
    FIT.base = ask; // F16: the grow counts from the size the fit asks without it
    const want = growAsk(ask, GR);
    if (FIT.pop) drawFitPop();
    HOLD.start({ want: null, plainBefore: ctx.plainBefore, modeBefore: ctx.modeBefore });
    FIT.planner?.size(want.cols, want.rows, { now: true });
    return;
  }
  if (pending) {
    applyHeld(pending.r);
    if (Number.isInteger(pending.n)) captureHandled(pending.n); // R2 #7: drawn now, so the waiters that were there before its request see it
  }
}

/**
 * The fit chip, a button (F1): hidden until the server has answered, then one of five states, each with its own colour (data-k), icon and
 * words; the reason is the title and the announcement. The button is named by the label alone (the words and the chevron are decoration).
 * Called on a change of state, so it is announced once (not when `opts.quiet` is true: the planner says so for a change that followed a change of the
 * window's focus, F9; the chip, its title and its name still change); an open panel is drawn again in place. With no view the wrapper hides, the panel
 * closes and focus, if it was in there, goes to the transcript button.
 */
function renderFit(view, opts) {
  const wrap = $('fit-wrap');
  const el = $('fit-chip');
  const inside = !view && wrap.contains(document.activeElement); // asked before the wrapper hides: a hidden element loses focus
  FIT.view = view;
  wrap.hidden = !view;
  if (!view) {
    closeFitPop(false);
    FIT.ui = { pending: false, note: false };
    el.removeAttribute('data-k');
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
    el.replaceChildren();
    if (inside) $('hist-toggle').focus();
    return;
  }
  el.setAttribute('data-k', view.state);
  el.setAttribute('title', view.title);
  el.setAttribute('aria-label', view.label);
  el.replaceChildren(icon(view.icon), h('span', { text: view.text }), icon('chev', 'ic chev'));
  if (FIT.pop) drawFitPop();
  if (opts?.quiet !== true) announce(view.say); // F9: a change that followed the window's own focus is drawn, not announced twice (the status stays readable on the chip)
}

/**
 * The chip's panel from FIT.view and FIT.ui (fit-ui.js fitPanelView): text through textContent and h() only. Focus stays where it is,
 * unless the action button it was on has just gone: then it goes to Close.
 */
function drawFitPop() {
  const v = fitPanelView(FIT.view, { ...FIT.ui, room: FIT.room, grow: GR.phase === 'stepping' || GR.phase === 'held' });
  if (!v) return;
  const again = $('fit-again');
  const held = document.activeElement === again;
  $('fit-pop-h').textContent = v.heading;
  $('fit-pop-why').textContent = v.why;
  const hint = $('fit-pop-hint');
  hint.hidden = v.hint === null;
  hint.replaceChildren(...(v.hint === null ? [] : [v.hint, v.code === null ? null : h('code', { text: v.code })].filter(Boolean)));
  const note = $('fit-pop-note');
  note.hidden = v.note === null;
  note.replaceChildren(...(v.note === null ? [] : [icon('warn'), v.note]));
  again.hidden = v.action === null;
  if (v.action === null) again.removeAttribute('aria-disabled');
  else {
    again.textContent = v.action.text;
    if (FIT.ui.pending) again.setAttribute('aria-disabled', 'true'); // not disabled: focus stays on it
    else again.removeAttribute('aria-disabled');
  }
  if (held && again.hidden) $('fit-pop-close').focus();
}

/** Opens the panel under the chip: drawn, placed by dom.js (it needs to be shown to have a width), focus on the action, else on Close. */
function openFitPop() {
  if (FIT.pop || !FIT.view) return;
  const pop = $('fit-pop');
  const chip = $('fit-chip');
  FIT.pop = true;
  drawFitPop();
  clearMenuPlacement(pop); // measured again on every open
  pop.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  placeMenuX(pop, chip);
  document.addEventListener('pointerdown', fitAway);
  ($('fit-again').hidden ? $('fit-pop-close') : $('fit-again')).focus();
}

/** Closes the panel; `refocus` puts focus on the chip (Esc, Close, the chip again), else it stays where the user went. */
function closeFitPop(refocus) {
  if (!FIT.pop) return;
  FIT.pop = false;
  FIT.ui.note = false;
  $('fit-pop').hidden = true;
  $('fit-chip').setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', fitAway);
  if (refocus) $('fit-chip').focus();
}

/** A pointer went down somewhere: outside the panel and the chip, it closes the panel (and focus stays where the user went). Listens only while the panel is open. */
function fitAway(e) {
  const t = e.target;
  if (t instanceof Node && !$('fit-pop').contains(t) && !$('fit-chip').contains(t)) closeFitPop(false);
}

/**
 * The planner's word on the user's Fit again (fit-ui.js reopen): { pending: true } when it starts, else { pending: false, status, view, changed }
 * when its request was answered. Fitted, zoomed and terminal close the panel; another state or the same one redraws it (the same one is announced here,
 * a new one by renderFit); a refusal shows the note; a 403 has already hidden the chip.
 */
function fitAgainEvent(e) {
  if (e.pending) {
    FIT.ui = { pending: true, note: false };
    if (FIT.pop) drawFitPop();
    return;
  }
  FIT.ui = { pending: false, note: false };
  if (e.status === 403) return;
  if (e.status === 200 && e.view) {
    if (['fitted', 'zoomed', 'terminal'].includes(e.view.state)) closeFitPop(true);
    else {
      if (FIT.pop) drawFitPop();
      if (!e.changed) announce(stillOffSay(e.view));
    }
    return;
  }
  if (FIT.pop) {
    FIT.ui.note = true;
    drawFitPop();
  }
  const p = fitPanelView(FIT.view, { pending: false, note: true });
  if (p) announce(p.note);
}

/** The chip's button, the panel's Close and action, and the ways out: Esc, Tab out, a pointer elsewhere, a resized window. */
function wireFitPop() {
  const chip = $('fit-chip');
  const pop = $('fit-pop');
  chip.addEventListener('click', () => (FIT.pop ? closeFitPop(true) : openFitPop()));
  $('fit-pop-close').addEventListener('click', () => closeFitPop(true));
  $('fit-again').addEventListener('click', () => {
    if ($('fit-again').getAttribute('aria-disabled') === 'true') return; // an ask is on its way
    FIT.room = false; // F10: Fit again tries the panel's own size
    fitCommit();
    FIT.planner?.reopen();
  });
  const onKey = (e) => {
    if (e.key !== 'Escape' || !FIT.pop) return; // shut: Esc is the page's
    e.preventDefault();
    e.stopPropagation(); // the page's own Esc handlers never see it
    closeFitPop(true);
  };
  const onOut = (e) => { // Tab out of the chip or the panel
    const to = e.relatedTarget;
    if (to instanceof Node && !$('fit-wrap').contains(to)) closeFitPop(false);
  };
  for (const el of [chip, pop]) {
    el.addEventListener('keydown', onKey);
    el.addEventListener('focusout', onOut);
  }
  window.addEventListener('resize', () => {
    if (FIT.pop) closeFitPop(pop.contains(document.activeElement));
  });
}

function wireFit() {
  FIT.planner = createFitPlanner({
    send: (body) => {
      FIT.sentCols = body.cols; // F11: an answer with these columns is nika's own size
      FIT.sentRows = body.rows; // F10: with the answer's pane rows it gives the border row
      return fitCall('PUT', { json: body });
    },
    release: () => fitCall('DELETE', { keepalive: true }), // the lease goes back when the page does
    after: (fn, ms) => setTimeout(fn, ms),
    cancel: (timer) => clearTimeout(timer),
    chip: fitChip, // F10: held during a redraw hold
    fitAgain: fitAgainEvent,
    focused: fitFocused, // F9: the focus every request carries
    sized: fitSized, // F10: the pane size of each answer starts the redraw hold
  });
  wireFitPop();
  if (typeof ResizeObserver === 'function') new ResizeObserver(fitResize).observe($('term')); // the app's zoom changes the box too
  document.fonts?.ready.then(fitResize, () => {});
  $('term-rows').addEventListener('animationend', (e) => {
    if (e?.animationName === 'nika-refit') endRefit();
    if (e?.animationName === 'nika-glide') endGlide(); // F17: each sliding row ends one; endGlide is idempotent
  });
  window.addEventListener('pagehide', () => FIT.planner.close());
  // F9: events are only triggers, the planner reads the value itself; hidden (visibilitychange, in boot) is sent at once, these two settle first. e.target is the window
  // itself: the focus and blur of an element inside the page are not the window's
  // F10: a focus is a commit point (the take gets the size of the resting layout of this moment); a blur measures nothing
  window.addEventListener('focus', (e) => { if (e?.target === window) { fitCommit(); FIT.planner.focusChanged(false); } });
  window.addEventListener('blur', (e) => { if (e?.target === window) FIT.planner.focusChanged(false); });
  window.addEventListener('pageshow', (e) => { // back from the back/forward cache: pagehide gave the window back, so this is a new page load (open: true)
    if (!e || e.persisted !== true || M.gone || !M.cols) return; // a first load, a pane that is gone, or no capture yet: nothing to restart
    fitCommit();
    FIT.planner.restart();
  });
  fitCommit();
}

// ---- scroll (design W3): the wheel, PgUp/PgDn/Home/End and Jump to live move Claude's own full-screen view (POST /api/app/pane/:id/scroll) ----

// planner: the request planner of scroll.js, made by wireScroll. scrolled: Claude's own view is not at the bottom (the capture's `scrolled`, or
// the route's answer). lastLine: when a refusal line was last shown (at most one per NOTE_MS).
const SC = { planner: null, scrolled: false, lastLine: 0 };
// PgUp/PgDn are one page; Home/End (and Ctrl+Home/Ctrl+End) are the ends of Claude's view. dir: -1 up, 1 down, for the native-first rule.
const SCROLL_KEYS = new Map([['PageUp', ['page', 'up', -1]], ['PageDown', ['page', 'down', 1]], ['Home', ['jump', 'top', -1]], ['End', ['jump', 'bottom', 1]]]);

/** The scroll route; a window with no pane, or a pane that is gone, has none. A call that does not answer within 10 s is cut off and settles as a lost request (status 0), so the planner is never stuck waiting. */
function scrollCall(body) {
  if (!paneId || M.gone) return Promise.resolve({ status: 0, body: null });
  if (HOLD.active) return HOLD.wait().then(() => scrollCall(body)); // F10: after the redraw hold; the server still decides on its own fresh capture
  const ctl = new AbortController(); // AbortSignal.timeout() is missing in older macOS web views (project.js does the same)
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    if (!lessMotion() && M.body) GL.arm?.arm(body, { scrolled: SC.scrolled, before: frameOf(M.body, M.draft) }); // F17: the frame drawn as the keys go is the base
  } catch {
    // scrolling works without the glide
  }
  return call(`/api/app/pane/${encodeURIComponent(paneId)}/scroll`, { method: 'POST', json: body, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

/** Jump to live and the corner note follow nika's own Paused (M.frozen) and Claude's scrolled-up view (SC.scrolled): each state its own colour (data-k), icon and words. */
function renderNote() {
  const v = noteView({ frozen: M.frozen, scrolled: SC.scrolled });
  const el = $('paused-note');
  $('jump-live').hidden = !v.jump;
  el.hidden = v.note === null;
  if (v.note === null) {
    el.removeAttribute('data-k');
    el.replaceChildren();
    return;
  }
  el.setAttribute('data-k', v.note.kind);
  el.replaceChildren(icon(v.note.icon), h('span', { text: v.note.text }));
}

/** A change of Claude's scrolled-up view: the corner note and Jump to live follow, announced once. */
function setScrolled(on) {
  if (on === SC.scrolled) return;
  SC.scrolled = on;
  renderNote();
  announce(scrolledSay(on));
}

/** After every drawn capture: the pill Claude draws when its view is scrolled up (the server reads it: `scrolled`, only with its full-screen view on). */
function scrollCaptured(body) {
  setScrolled(body.alt === true && body.scrolled === true);
}

/** A refusal in fixed words, at most once per NOTE_MS (design 6.4). */
function scrollLine(answer) {
  const line = refusalLine(answer);
  const t = Date.now();
  if (line === null || t - SC.lastLine < NOTE_MS) return;
  SC.lastLine = t;
  showProblem(line, 'warn', NOTE_MS);
}

/** The route answered (the planner has already dropped what was queued behind a refusal): 200 says where Claude's view is now, 404 the pane is gone, the rest is a line. */
function scrollDone(r) {
  if (r.status !== 200) GL.arm?.drop(); // F17: refused or lost, so no frame of this request will come: it must not leave the arm open for a prompt or for output
  if (r.status === 200) {
    if (typeof r.body?.scrolled === 'boolean') setScrolled(r.body.scrolled);
    GL.arm?.extend(); // F17: the frame comes after the answer, so the window is renewed
    kickMirror(0); // the route refreshed the capture: the mirror shows the new view on its next tick
  } else if (r.status === 404) setGone();
  else scrollLine({ status: r.status, code: r.body?.error });
}

/** F17: the OS asks for less motion (read fresh each time; unreadable counts as no). */
function lessMotion() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  } catch {
    return false;
  }
}

/** F17: slides the conversation rows from where they were; the rows below (Claude's box, footer, task list) stay and cover them. Class and CSSOM only. */
function startGlide(g) {
  if (lessMotion()) return;
  const rows = $('term-rows');
  const els = rows.children;
  const rowPx = $('fit-probe').getBoundingClientRect().height * FIT.scale; // the drawn row height, as the wheel counts it
  const current = rows.classList.contains('glide') && els[0] ? matrixY(getComputedStyle(els[0]).transform) : 0; // a slide still running: continue from where the rows are
  const from = glideFrom({ k: g.k, rowPx, current, maxPx: g.end * rowPx });
  if (from === 0) {
    endGlide();
    return;
  }
  for (let i = 0; i < els.length; i += 1) els[i].classList.toggle('gl', i < g.end);
  rows.style.setProperty('--glide-from', `${from}px`);
  rows.classList.remove('glide');
  void rows.offsetWidth; // the animation starts again
  rows.classList.add('glide');
  clearTimeout(GL.timer);
  GL.timer = setTimeout(endGlide, GLIDE_MS + 50); // the fallback for a web view that gives no animationend
}

function endGlide() {
  clearTimeout(GL.timer);
  GL.timer = 0;
  const rows = $('term-rows');
  if (rows.classList.contains('glide')) rows.classList.remove('glide'); // idempotent: setGone, the 403 branch and every animationend may call it
}

/** After the native check chose Claude: true when a request may go. A pane that is not in its full-screen view, or not read yet, gets nothing at all (no line); a closed gate gets the line. */
function scrollOpen() {
  if (!SC.planner || M.gone || M.fatal || !M.body || M.body.alt !== true) return false;
  const code = scrollGate(M.body, M.draft);
  if (code !== null) scrollLine({ status: 409, code });
  return code === null;
}

/** The wheel over the terminal (design 6.1, 6.2): vertical travel only, the mirror's own overflow first, then Claude's view. A pinch zoom or an app gesture (Ctrl, Meta) and sideways travel (Shift, deltaX) stay with the browser; focus never moves. */
function scrollWheel(e) {
  if (e.ctrlKey || e.metaKey || e.shiftKey || !(Math.abs(e.deltaY) > Math.abs(e.deltaX || 0))) return;
  const term = $('term');
  const rows = wheelRows(e, { cellH: $('fit-probe').getBoundingClientRect().height * FIT.scale, viewRows: viewRowsOf(M.body, M.draft) });
  if (rows === 0 || routeFor({ dir: rows, top: term.scrollTop, height: term.scrollHeight, client: term.clientHeight }) === 'native') return;
  e.preventDefault(); // no overscroll bounce
  if (scrollOpen()) SC.planner.wheel(rows, pageRowsOf(M.body, M.draft));
}

/** PgUp, PgDn, Home, End and Ctrl+Home, Ctrl+End while the terminal has focus and Type into pane is off (the message box keeps its own editing keys; with Type into pane on the keys route sends the user's own keys). */
function scrollKey(e) {
  if (P.on || e.defaultPrevented || e.isComposing || e.altKey || e.metaKey || e.shiftKey || !SCROLL_KEYS.has(e.key)) return;
  const [kind, what, dir] = SCROLL_KEYS.get(e.key);
  if (e.ctrlKey && kind === 'page') return; // Ctrl+PgUp and Ctrl+PgDn belong to the app (tabs)
  const term = $('term');
  if (routeFor({ dir, top: term.scrollTop, height: term.scrollHeight, client: term.clientHeight }) === 'native') return;
  e.preventDefault();
  if (what === 'bottom') term.scrollLeft = 0; // End returns to column 0 like the button (it never moves focus: keys act where focus already is)
  if (!scrollOpen()) return;
  if (kind === 'page') SC.planner.page(what);
  else SC.planner.jump(what);
}

function wireScroll() {
  SC.planner = createScrollPlanner({
    send: scrollCall,
    after: (fn, ms) => setTimeout(fn, ms),
    cancel: (timer) => clearTimeout(timer),
    now: () => Date.now(),
    done: scrollDone,
  });
  GL.arm = createGlideArm({ now: () => Date.now() }); // F17
  const term = $('term');
  term.addEventListener('wheel', scrollWheel, { passive: false }); // not passive: preventDefault must work
  term.addEventListener('keydown', scrollKey);
  window.addEventListener('pagehide', () => SC.planner.close());
}

// ---- sending ------------------------------------------------------------------------------------------------------

const RATE_MSG = 'Too fast: nika sends up to 20 requests a second. Your text is kept.';
let chain = Promise.resolve(); // sends go out in the order they were made, one at a time

/** One POST to a pane route (`keys` or `submit`); a 429 waits a moment and sends again (nothing was sent). */
async function postRetry(tail, payload) {
  GL.arm?.disarm(); // F17: a typed key or Send is not a scroll (Claude jumps to the bottom on submit); the next frame never glides
  let r;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    r = await call(`/api/app/pane/${encodeURIComponent(paneId)}/${tail}`, { method: 'POST', json: payload });
    if (r.status !== 429) break;
    showProblem(RATE_MSG, 'warn'); // busy: wait a moment and send again (nothing was sent)
    await sleep(700 * (attempt + 1));
  }
  return r;
}

/** Send's own typing (`send: true`, T54) refused for a prompt, a dialog, the survey or an unclear screen: the fixed lines of the submit route (draft-sync.js submitMessage). Nothing more is sent and the text stays. null for everything else. */
function sendRefusal(payload, r) {
  const code = r.body?.error;
  return payload.send === true && r.status === 409 && (code === 'prompt-open' || code === 'screen-unclear') ? submitMessage({ status: 409, code }) : null;
}

async function deliver(payload) {
  if (M.gone || !paneId) return { ok: false, message: 'The pane is gone.' };
  const r = await postRetry('keys', payload);
  if (r.status === 200) {
    clearProblem();
    return { ok: true };
  }
  if (r.status === 404) setGone();
  const message = sendRefusal(payload, r)
    ?? keysRefusal({ status: r.status, code: r.body?.error })
    ?? (r.status === 429 ? `${RATE_MSG} Try again in a moment.`
      : r.status === 0 ? 'nika did not answer. Your text is kept.'
        : serverMessage(r, `The pane did not accept this (${r.status}).`));
  showProblem(message, r.status === 429 ? 'warn' : 'error', r.status === 429 ? 3000 : 0);
  return { ok: false, message };
}

/** Sends the bodies in order as one job; the first failure stops the rest (an Enter must not follow a text that never arrived). */
function enqueueJob(run) {
  const job = chain.then(run);
  chain = job.catch(() => {});
  return job;
}
async function deliverAll(payloads) {
  for (const payload of payloads) {
    const r = await deliver(payload);
    if (!r.ok) return r;
  }
  return { ok: true };
}
function enqueueSeq(payloads) {
  return enqueueJob(() => deliverAll(payloads));
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
  renderSuggestion(); // the suggestion shows only while the box is empty
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
  if (ta.disabled) return; // an off box stays silent
  if (sending) { // the last Send is still in flight (Enter, the Send button): say so, send and queue nothing; the text stays in the box
    showProblem(STILL_SENDING, 'warn', STILL_SENDING_MS);
    return;
  }
  const note = SV?.sendNote();
  if (note) {
    // a feedback question is open above the box (0.5, F14): nothing is sent and the text stays in the box
    showProblem(note, 'error');
    return;
  }
  const gate = sendGate({ promptOpen: W.promptOpen, status: A.kind, buttons: (W.pane === 'ok' && hasAnswerButtons(W.prompt)) || DF?.live() === true, bypass: W.prompt?.bypass === true }); // Enter would confirm the prompt's highlighted option: answer with the buttons
  if (!gate.ok) {
    showProblem(gate.message, 'error'); // nothing is sent and the text stays in the box
    return;
  }
  if (ATT.pending()) return ATT.send(composer().value); // chips under the box: the text and the files go together (attach.js)
  const value = ta.value;
  // the box is mirrored in Claude's input box: when the screen already holds this text only Enter goes out, else the text is copied over first (design W5, section 4)
  const route = draftSendPlan({ value, shell: S.on, screen: DS.screen(), cols: M.cols, footerKnown: W.confirmed === true && W.mode !== 'unknown' }); // an unknown footer (a menu, Claude's agent list) and no readable box: refused before any key is typed
  if (route.act === 'refuse') {
    showProblem(route.message, 'error'); // nothing is sent and the text stays in the box
    return;
  }
  if (route.act === 'none') return; // an empty box over an empty Claude input: no request (an Enter there could only take Claude's suggestion)
  const plan = route.act !== 'legacy' ? route : S.on ? planShell(value) : planSend(value);
  if (plan.empty) return; // Shell on and nothing to run: no lone "!"
  if (!plan.ok) {
    showProblem(plan.message, 'error');
    return;
  }
  sending = true;
  DS.beginSend(); // the background sync holds still until this send is over
  $('send').setAttribute('aria-busy', 'true');
  // every Send ends in the one guarded Enter (submitEnter); the text before it is pushed into Claude's input (a synced box) or typed by the keys route (no readable box)
  const r = await enqueueJob(route.act === 'push' ? () => pushThenSubmit(route) : route.act === 'enter' ? () => submitEnter(route.submit.base) : () => typeThenSubmit(plan.payloads));
  sending = false;
  $('send').removeAttribute('aria-busy');
  if (r.ok) { // else the text stays in the box, and Shell stays on so a retry still goes as a command
    say(r.taken === true && A.kind === 'busy' && value.trim() !== '' ? `Queued for Claude: ${route.textSummary ?? plan.summary}` : `Sent ${plan.summary} to ${paneId}`); // Claude takes a message sent while it works at its next step; the echo names the text, not the Enter (a lone Enter queues nothing of ours)
    if (S.on) setShell(false); // like Claude's own ! mode: the next message is a message
    clearBox(value);
  }
  DS.endSend();
}

/** The message box after its text went to Claude: emptied only when it still holds what was sent (the user may have typed on); the sync forgets the unsent text. */
function clearBox(value) {
  const ta = composer();
  if (ta.value !== value) return;
  ta.value = '';
  grow();
  updateChip();
  DS.sent(); // nothing of it is unsent any more
}

/** A synced Send: the text is copied into Claude's input (a non-200 sends no Enter), then the guarded Enter against the sig of that write. One job in the keys chain, so arrows queued before it go first. */
async function pushThenSubmit(route) {
  const p = await DS.send(route.text);
  if (!p.ok) {
    showProblem(p.message, 'error');
    return p;
  }
  return submitEnter(p.sig);
}

/** A Send without a readable box: the text goes through the keys route (Shell: Ctrl-U and "!" + the command; no Enter), then the guarded Enter with no base. */
async function typeThenSubmit(payloads) {
  if (HOLD.active) await HOLD.wait(); // F10: no key is typed on the strength of a held frame
  const r = await deliverAll(payloads);
  return r.ok ? submitEnter() : r;
}

/**
 * Send's one Enter, through the submit route and never the keys route (W13; docs/contracts/api-app.md): the server presses it only on a fresh
 * screen with no prompt or dialog and, with `base` (the draft sig the page last saw), only while Claude's input still reads so. Claude queues
 * it while it works. Returns { ok, taken, message }: not ok keeps the text in the box. The fixed copy is draft-sync.js (submitResult).
 */
async function submitEnter(base) {
  if (HOLD.active) await HOLD.wait(); // F10: the server decides on its own fresh capture; the page only waits for nika's own redraw
  if (M.gone || !paneId) return { ok: false, message: 'The pane is gone.' };
  const r = await postRetry('submit', base ? { base } : {});
  DS.submitted(r); // the answer's draft is the screen after the Enter
  const out = submitResult(r);
  if (out.ok) {
    clearProblem();
    return out;
  }
  if (r.status === 404) setGone();
  showProblem(out.message, r.status === 429 ? 'warn' : 'error', r.status === 429 ? 3000 : 0);
  return out;
}

// ---- draft sync (W5): the message box and Claude's input box mirror each other; the rules and the copy: draft-sync.js ----------

/** A pull: the terminal's draft becomes the box's text. No `input` event fires, so it is not taken for an edit; focus never moves. */
function pullIntoBox(value, shell) {
  const ta = composer();
  const before = ta.value;
  const caret = ta.selectionStart;
  ta.value = value;
  if (document.activeElement === ta) {
    const at = caretAfter(before, value, caret);
    ta.setSelectionRange(at, at);
  }
  setShell(shell);
  grow();
  updateChip();
  if (document.activeElement !== ta) closePalette(); // the list belongs to a box that has focus
}

/** The one note under the box: a paused sync, a long text, a refused replace. Colour from data-k, icon and word in the line. */
function renderDraftNote(view) {
  const el = $('draft-note');
  el.hidden = view === null;
  if (view === null) {
    el.removeAttribute('data-k');
    el.replaceChildren();
    return;
  }
  el.setAttribute('data-k', view.kind);
  el.replaceChildren(icon(view.icon), h('b', { text: view.label }), h('span', { text: ` ${view.text}` }));
}

/** The sync's write into Claude's input (F10: it waits for nika's own redraw hold; the server decides on its own fresh capture). */
async function putDraft(body) {
  if (HOLD.active) await HOLD.wait();
  return call(`/api/app/pane/${encodeURIComponent(paneId)}/draft`, { method: 'PUT', json: body });
}

/** Tab or the right arrow on Claude's suggestion (F10, R2 #3: it waits for nika's own redraw hold like the sync's write; the server decides on its own fresh capture). */
async function suggestDraft(body) {
  if (HOLD.active) await HOLD.wait();
  return call(`/api/app/pane/${encodeURIComponent(paneId)}/suggestion`, { method: 'POST', json: body });
}

/** Resolves at once with no redraw hold, else when it ends (F10, R2 #3): the attachment tray's request goes after it. */
async function waitHold() {
  if (HOLD.active) await HOLD.wait();
}

const DS = createDraftSync({
  now: () => Date.now(),
  after: (fn, ms) => setTimeout(fn, ms),
  cancel: (timer) => clearTimeout(timer),
  box: () => ({ value: composer().value, shell: S.on }),
  setBox: pullIntoBox,
  put: putDraft,
  suggest: suggestDraft,
  note: renderDraftNote,
  problem: (message) => showProblem(message, 'warn', 6000),
  gone: setGone,
});

// ---- attachments (0.5, design W2): chips under the message box; the logic and the copy: attach.js ----------------------------

const ATT = createAttachTray({
  paneId,
  path: (tail) => `/api/app/pane/${encodeURIComponent(paneId)}/${tail}`,
  call,
  appFetch,
  ds: DS,
  enqueueJob,
  waitHold,
  say,
  announce,
  showProblem,
  clearProblem,
  showNotice,
  setGone,
  box: () => ({ value: composer().value, shell: S.on }),
  cols: () => M.cols,
  clearBox,
  focusBox: () => composer().focus(),
});

// ---- Shell mode (spec 9.6): Enter sends Ctrl-U, "!" + the text, Enter; it turns itself off after a successful send -------------

const RSAQUO = String.fromCharCode(0x203a);
const idlePlaceholder = () => (S.on ? `Shell command for Claude's ! mode${DOTS}` : suggestionNow() ?? `Message ${A.name}${DOTS}`);

/** Claude's prompt suggestion while the box is empty, Shell is off and the sync can read the screen's draft (draft-sync.js suggestionFor), else null. */
function suggestionNow() {
  return suggestionFor(DS.screen(), { value: composer().value, shell: S.on });
}

/** The box's placeholder and its "suggest" look: the suggestion in its own colour and italic, with the note under the box saying what accepts it. A disabled box keeps its own text. */
function renderSuggestion() {
  const usable = !composer().disabled;
  const on = usable && suggestionNow() !== null;
  document.querySelector('.inbox').classList.toggle('suggest', on);
  if (usable) composer().placeholder = idlePlaceholder();
}

/** Tab or the right arrow on the suggestion: the guarded route (DS.accept), in the keys chain so arrows typed just before go first. Never a key of its own. */
async function acceptSuggestion(text) {
  const r = await enqueueJob(() => DS.accept(text));
  renderSuggestion();
  if (r.ok) {
    clearProblem();
    say(`Accepted Claude's suggestion: ${text}`);
  } else {
    showProblem(r.message, problemKind(r.status), 6000);
  }
}

function setShell(on) {
  if (on === S.on) return;
  S.on = on;
  const toggle = $('shell-toggle');
  toggle.setAttribute('aria-pressed', String(on));
  toggle.querySelector('.onoff').textContent = on ? 'on' : 'off';
  document.querySelector('.inbox').classList.toggle('shell-on', on);
  document.querySelector('.inbox .prompt').textContent = on ? '!' : RSAQUO;
  renderSuggestion(); // Shell has its own placeholder and no suggestion
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
  DS.edited();
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
    DS.edited();
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
  drawMirror(); // the strip stands in for Claude's input box only while Type into pane is off
  if (on) {
    term.focus();
    announce(`Passthrough on: every key goes to pane ${paneId}. Press Control and ] to leave.`);
  } else {
    announce('Passthrough off: typing goes to the input box');
    if (!keepFocus) composer().focus();
  }
}

/** Ctrl+Shift+C in the mirror: the selected text goes to the clipboard. Only a selection that lies inside the mirror counts. */
async function copySelection() {
  const sel = document.getSelection();
  const term = $('term');
  const text = sel && !sel.isCollapsed && term.contains(sel.anchorNode) && term.contains(sel.focusNode) ? sel.toString() : '';
  if (!text) {
    showProblem('Select text in the terminal first, then press Ctrl+Shift+C to copy it.', 'warn', 3000);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    say(`Copied ${text.length} characters`);
  } catch {
    showProblem('Could not copy the selection.', 'warn', 3000);
  }
}

function wirePassthrough() {
  const term = $('term');
  term.addEventListener('keydown', (e) => {
    if (!P.on) return;
    const k = keyForEvent(e, { mac: MAC });
    if (k.kind === 'leave') {
      e.preventDefault();
      setPass(false);
      return;
    }
    if (k.kind === 'ignore') return; // Cmd shortcuts, IME, paste and the window keys (Ctrl+Q, zoom) stay with the browser, the app and the OS
    e.preventDefault();
    e.stopPropagation(); // in passthrough only Ctrl+] belongs to nika
    if (k.kind === 'text') {
      P.buf += k.text;
      if (P.buf.length >= 1000) flushPass();
      else if (!P.timer) P.timer = setTimeout(flushPass, 120); // batched, so typing stays under the 20 requests/s limit
    } else if (k.kind === 'copy') {
      copySelection();
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
  ta.addEventListener('input', () => { grow(); updateChip(); DS.edited(); });
  ta.addEventListener('compositionstart', () => DS.composition(true));
  ta.addEventListener('compositionend', () => DS.composition(false));
  ta.addEventListener('keydown', (e) => {
    const sug = suggestionNow(); // what the placeholder shows: the text Tab or the right arrow would accept
    const a = composerKey(e, {
      empty: ta.value === '', selection: ta.selectionStart !== ta.selectionEnd, choosing: PL.active >= 0, paletteOpen: PL.open,
      pop: Q.pop, pane: W.pane, status: A.kind, promptOpen: W.promptOpen, dialog: W.dialog !== null,
      buttons: (W.pane === 'ok' && hasAnswerButtons(W.prompt)) || DF?.live() === true, bypass: W.prompt?.bypass === true, switching: SW.busy !== null, suggestion: sug,
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
    else if (a.act === 'accept') acceptSuggestion(sug);
    else if (a.act === 'stop') arrows ? chain.then(stop) : stop(); // Stop is not queued, but it never overtakes arrows typed just before
    else if (a.act === 'refuse') showProblem(a.message, a.kind, a.ms);
    else if (a.act === 'focus-back') $('shell-toggle').focus();
    // 'swallow': a held key acts once
  });
  $('paste-clear').addEventListener('click', () => {
    ta.value = '';
    grow();
    updateChip();
    DS.edited();
    ta.focus();
  });
  $('send').addEventListener('click', () => { endArrows(); sendComposer(); ta.focus(); });
  $('shell-toggle').addEventListener('click', () => { setShell(!S.on); DS.edited(); }); // focus stays on the toggle; the text stays in the box; Shell on or off is another form of the draft
  wirePalette();
}

function wireTerminal() {
  const term = $('term');
  term.addEventListener('scroll', () => setFrozen(term.scrollHeight - term.scrollTop - term.clientHeight >= 8));
  $('jump-live').addEventListener('click', jumpToLive);
  wireScroll();
  $('over-retry').addEventListener('click', () => {
    M.gone = false;
    M.fatal = false;
    M.inputOff = false;
    M.etag = null;
    W.got = false;
    DS.reset();
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

/** The passthrough key is written with the control glyph on a Mac, as in the Keyboard shortcuts window. aria-keyshortcuts stays Control+]. */
function syncPassKeys() {
  const label = passKeyLabel(MAC);
  for (const el of document.querySelectorAll('kbd[data-passkey]')) el.textContent = label;
  $('pass-toggle').title = `Type straight into the pane (${label})`;
}

function openKbd(opener) {
  openShortcuts({ window: SUB ? 'subagent' : 'session', tier: 'app', mac: MAC, singleKey: UI.singleKey, opener });
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
  setBackHref(projectKey ? `/#project/${projectKey}` : '/#dashboard');
  setBack('Dashboard');
  syncKbdHint();
  syncHistHint();
  syncPassKeys();
  watchNotes();
  if (!appMode) {
    $('kbd-open').hidden = true;
    showEmpty('The session window is part of the nika app. This page was opened in a browser, which only shows the read-only dashboard.');
    return;
  }
  if (BAD_AGENT) {
    showEmpty('This link has no valid subagent id. Open the subagent again from its session.');
    return;
  }
  if (SUB && !sessionId) {
    showEmpty('This link has no valid session id. Open the subagent again from its session.');
    return;
  }
  if (!sessionId && !paneId) {
    showEmpty('This link has no valid session id or pane id. Open the agent again from the dashboard.');
    return;
  }
  const bad = [];
  const q = new URLSearchParams(location.search);
  if (q.has('session') && !sessionId) bad.push('session id');
  if (q.has('pane') && !paneId && !SUB) bad.push('pane id'); // a subagent window has no pane: the parameter is ignored, nothing said
  if (bad.length) showNotice(`The link had an invalid ${bad.join(' and ')}; it was ignored.`);
  showUrlNotice();

  if (SUB) readOnlyView();
  else wireTabs();
  wireHistory();
  if (!SUB) {
    wireHist();
    wireTerminal();
    wireComposer();
    ATT.wire();
    wireSubs();
  }
  document.addEventListener('keydown', onPageKey);
  wireWindowKeys({ mac: MAC, passthrough: () => P.on, send: windowCommand }); // Ctrl+Q, Ctrl+W (not while typing into the pane) and zoom off macOS
  $('kbd-open').addEventListener('click', () => openKbd($('kbd-open')));
  loadSettings();
  startAgentPoll();
  document.addEventListener('visibilitychange', () => {
    FIT.planner?.focusChanged(document.hidden); // F9, both ways: hidden gives the size back at once, shown settles (the beat below adopts it)
    if (document.hidden) return;
    kickMirror(0);
    refreshHistory();
    refreshAgent();
    FIT.planner?.beat(); // timers may have been suspended while the window was hidden: one request now, the lease may have lapsed
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
    wireFit();
    DF = createDialogForm({ root: $('dialog-form'), paneId, call, path: (tail) => `/api/app/pane/${encodeURIComponent(paneId)}/${tail}`, announce, say, showProblem, clearProblem, setGone, composer, refresh: renderAttn });
    SV = createSurveyPanel({ root: $('survey-panel'), paneId, call, path: (tail) => `/api/app/pane/${encodeURIComponent(paneId)}/${tail}`, announce, say, clearProblem, setGone, composer });
    $('pb-pane').textContent = paneId;
    $('term').setAttribute('aria-label', `Live terminal of ${A.name}, pane ${paneId}`);
    showOverlay(`Connecting to pane ${paneId}${DOTS}`, '');
    kickMirror(0);
    composer().focus({ preventScroll: true });
  } else {
    split.classList.add('no-term');
    split.dataset.tab = 'hist';
    $('pane-tabs').hidden = true;
    showNotice(SUB ? 'Read-only. A subagent runs inside its parent session: nika shows its transcript, with no pane to mirror and no input.' : 'This session is not in tmux, so nika can show its transcript but cannot mirror or type into it.');
  }
}

boot();
