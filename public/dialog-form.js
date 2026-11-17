// Claude's question dialogs (AskUserQuestion) and plan approvals (ExitPlanMode) as a form in the session window (nika 0.5, design W1 section 6).
// The server reads the dialog off the pane's screen and puts it in the capture's `dialog` field; this file draws ONE step of it (the current
// question, the review, or the plan's choices), follows Claude's own tabs, and answers through one route, one step per request:
// { sig, picks, text? }, { sig, submit: true }, { sig, choice }, { sig, cancel: true } or (0.5.1) { sig, tab }. The last one is a click on a
// step of the strip: the server moves Claude's dialog there with arrow keys and answers nothing on the way; the form then follows the capture.
// Rules: every string is text (h() and textContent, never markup); no inline style (classes and data attributes only); the server's own words
// never show (every answer maps to a fixed line below); the page presses no key and types no digit itself, and has no Esc handler (Decline
// and Reject are the explicit ways). The pure rules come first and are tested alone; createDialogForm is the DOM side and does nothing at import.
// Keep this file ASCII: write every symbol as an escape.
import { h, icon } from './dom.js';
import { problemKind, SURVEY_UNDO_LINE } from './quick-actions.js';

export const READING_MS = 2000; // how long "Reading" shows for a dialog nika cannot read yet, before the banner takes over
export const TEXT_MAX = 300; // free text nika may type (the route's TEXT_MAX)
const COUNT_FROM = 250; // the counter under Other appears from here
const CLAMP_FROM = 180; // a description longer than this is clamped to 3 lines with More (shortcut: characters, not lines; no layout is read)
const SIG = /^[0-9a-f]{16}$/;
const DOTS = String.fromCharCode(0x2026);
const MID = ` ${String.fromCharCode(0xb7)} `;
const TABS_MAX = 8;
const HEADER_MAX = 40;
const QUESTION_MAX = 500;
const LABEL_MAX = 200;
const DESC_MAX = 500;
const ANSWER_MAX = 500;
const TYPED_MAX = 500;
const KEEP_MAX = 8; // questions whose unsent input is kept while you look at other steps
const STEPS_NOTE = "Opens this step in Claude's dialog. Nothing is answered.";
const AGAIN_NOTE = 'Already answered. Answer again to change it, or choose another step.';
const TYPED_NOTE = 'To change typed text, use the terminal.';
const REASONS = new Set(['cut', 'clipped', 'wide', 'numbers', 'tab', 'layout', 'survey']);

const range = (list) => list.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('');
const CONTROLS = [[0, 0x1f], [0x7f, 0x9f]]; // C0, DEL, C1
const INVISIBLE = [[0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]; // zero-width, bidi marks, line and paragraph separators
const REFUSED = [...CONTROLS, ...INVISIBLE]; // the route refuses all of these in typed text (they are not seen on screen, so its read-back could not prove them)
const CTRL = new RegExp(`[${range(REFUSED)}]`);
const CTRL_G = new RegExp(`[${range(REFUSED)}]`, 'g');
const FORMAT = /\p{Cf}/u; // the other invisible format characters (U+00AD, U+2060, U+180E, U+FEFF ...): the route refuses them anywhere
const FORMAT_G = /\p{Cf}/gu;
const NOISE = new RegExp(`[${range([...CONTROLS, [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]])}]`, 'g'); // plus the bidi marks, for what is shown

// ---- the copy: fixed lines, picked by status and code only ------------------------------------------------------------------------

const TERMINAL_NOTE = 'This mentions bypass, so nika leaves it to you: answer it in the terminal.';
const KEPT_NOTE = "nika can't read Claude's dialog right now. Wait a moment, or answer in the terminal.";
const DECLINE_TITLE = 'Presses Esc in the pane: Claude stops and waits for you';
const LEAD_NOTE = 'Start with a word: Claude can read a first digit as an option.';
const GENERIC = "nika couldn't send this answer. Check it and try again.";
const L409 = {
  'no-dialog': ['The question is gone.', false],
  'dialog-changed': ['The question changed; check the session.', true],
  'dialog-touched': ['This question was changed in the terminal. Finish it there.', true],
  'dialog-focus': ["Claude's selection was moved in the terminal. Finish it there.", true],
  'text-mode': ["nika can't type your answer: Claude's text field isn't ready for typing. Type it in the terminal.", true],
  'text-mismatch': ["Your answer didn't arrive exactly as typed, so nika stopped before sending it. Fix it in the terminal.", true],
  'not-taken': ["Claude didn't take the key. Check the session, then try again.", false],
  'already-answered': ['', true],
  'busy-switching': ['Another action is running on this session.', false],
  'not-idle': ["nika is stopping Claude's turn; try again in a moment.", false],
  'text-focus': ["Claude's text field has the focus. Move off it in the terminal, then try again.", false], // a step move needs the focus off the text row (0.5.1)
  'survey-undo': [SURVEY_UNDO_LINE, false], // Decline is an Escape; the rating's undo row is still up. Nothing is retried; the buttons come back
};
const L400 = {
  'terminal-only': ['Answer this in the terminal.', true],
  invalid: [GENERIC, false],
};
const DONE = {
  next: { word: 'Answered', say: () => 'Answered.' },
  review: { word: 'Answered', say: () => 'Answered.' },
  submitted: { word: 'Submitted', say: (name) => `Submitted ${name}'s answers.` },
  chosen: { word: 'Answered', say: (name) => `Sent your choice to ${name}.` },
  declined: { word: 'Declined', say: () => 'Declined.' },
};

/**
 * What a route answer means for the form: { ok, phase ('answered' | 'failed'), lock (stay off until the sig changes), message (the problem line,
 * '' = none), kind ('warn' | 'error'), gone (the pane is gone), word (the chip word of an answered step), announce (null for a move), sent }. Only the status, the
 * `error` code, `done` and `sent` are read; no text of the response is ever shown (design W1 6.4).
 */
export function dialogOutcome({ status, code, done, sent, name = 'the agent' } = {}) {
  const keys = Number.isInteger(sent) && sent > 0 && sent <= 99 ? sent : 0;
  if (status === 200 && done === 'moved') { // a step move (0.5.1): nothing is answered and nothing is announced; the next capture draws the new step and says it
    return { ok: true, phase: 'moving', lock: true, message: '', kind: '', gone: false, word: '', announce: null, sent: keys };
  }
  if (status === 200) {
    const d = Object.hasOwn(DONE, done) ? DONE[done] : DONE.next;
    return { ok: true, phase: 'answered', lock: true, message: '', kind: '', gone: false, word: d.word, announce: d.say(name), sent: keys };
  }
  let row = [GENERIC, false];
  if (status === 409 && Object.hasOwn(L409, code)) row = L409[code];
  else if (status === 400 && Object.hasOwn(L400, code)) row = L400[code];
  else if (status === 429) row = ['Too many keys at once; try again.', false];
  else if (status === 404) row = ['The session is gone.', false];
  else if (status === 0 || status >= 500) row = ["nika couldn't reach tmux.", false];
  const [line, lock] = row;
  const message = line && keys ? `${line} nika had pressed ${keys} ${keys === 1 ? 'key' : 'keys'} in the pane before it stopped.` : line;
  const already = status === 409 && code === 'already-answered'; // someone answered it (a second window): it is answered, not failed
  return { ok: false, phase: already ? 'answered' : 'failed', lock, message, kind: message ? problemKind(status) : '', gone: status === 404, word: already ? 'Answered' : '', announce: '', sent: keys };
}

// ---- the capture's `dialog`, cleaned ---------------------------------------------------------------------------------------------

const text = (v, max) => (typeof v === 'string' ? v.replace(NOISE, '').slice(0, max) : null);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const unreadableOf = (kind, reason = 'layout') => ({ state: 'unreadable', kind, reason });
const PICK_MAX = 7; // the route takes picks 1 to 7 only (a digit answers without Enter, and two of the nine rows are the text and chat rows)
const optionNumber = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;

function cleanTabs(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > TABS_MAX) return null;
  const tabs = list.map((t) => ({ header: isObject(t) ? text(t.header, HEADER_MAX) : null, answered: isObject(t) && t.answered === true }));
  return tabs.every((t) => t.header) ? tabs : null;
}

/** The text Claude's own text row holds: null, or { text (1 to 500 characters), answered }. Anything else is no typed text. */
function cleanTyped(v) {
  if (!isObject(v) || typeof v.text !== 'string' || v.text.length > TYPED_MAX || typeof v.answered !== 'boolean') return null;
  const t = text(v.text, TYPED_MAX);
  return t ? { text: t, answered: v.answered } : null;
}

function cleanOptions(list, extra, max) {
  if (!Array.isArray(list) || list.length < 1 || list.length > max) return null;
  const options = [];
  for (const o of list) {
    if (!isObject(o) || !optionNumber(o.n, max) || options.some((x) => x.n === o.n)) return null;
    const label = text(o.label, LABEL_MAX);
    if (!label) return null;
    const one = extra(o);
    if (one === null) return null;
    options.push({ n: o.n, label, ...one });
  }
  return options;
}

/**
 * The capture's `dialog` as the page may use it: null (no dialog), `{ state: 'unreadable', kind, reason }` or `{ state: 'ready', kind, at, sig,
 * bypass, ... }`. Anything that is not exactly the contract shape (a 16-hex sig, a kind that fits its step, numbered options with text labels, a
 * current tab that exists) fails CLOSED to `unreadable` with reason `layout`: the page then keeps its banner, and the gates still count a dialog as
 * open. A form is never drawn from a half-valid dialog. Copies the data: the capture object is not kept.
 */
export function cleanDialog(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) return unreadableOf(null);
  const kind = raw.kind === 'ask' || raw.kind === 'plan' ? raw.kind : null;
  if (raw.state === 'unreadable') return unreadableOf(kind, REASONS.has(raw.reason) ? raw.reason : 'layout');
  if (raw.state !== 'ready' || typeof raw.sig !== 'string' || !SIG.test(raw.sig)) return unreadableOf(kind);
  const head = { state: 'ready', kind, at: raw.at, sig: raw.sig, bypass: raw.bypass === true };
  if (kind === 'plan' && raw.at === 'plan') {
    const options = cleanOptions(raw.options, (o) => (typeof o.text === 'boolean' ? { text: o.text } : null), 9);
    return options === null ? unreadableOf(kind) : { ...head, options };
  }
  if (kind !== 'ask') return unreadableOf(kind);
  const tabs = cleanTabs(raw.tabs);
  if (tabs === null) return unreadableOf(kind);
  if (raw.at === 'review') {
    if (!Array.isArray(raw.pairs)) return unreadableOf(kind);
    const pairs = raw.pairs.map((p) => ({ question: isObject(p) ? text(p.question, QUESTION_MAX) : null, answer: isObject(p) ? text(p.answer, ANSWER_MAX) : null }));
    return pairs.every((p) => p.question !== null && p.answer !== null) ? { ...head, tabs, warn: raw.warn === true, pairs } : unreadableOf(kind);
  }
  if (raw.at !== 'question') return unreadableOf(kind);
  const question = text(raw.question, QUESTION_MAX);
  const options = cleanOptions(raw.options, (o) => {
    const description = o.description === null || o.description === undefined ? null : text(o.description, DESC_MAX);
    return o.description !== null && o.description !== undefined && description === null ? null : { description, checked: o.checked === true };
  }, PICK_MAX);
  if (!question || options === null || !Number.isInteger(raw.current) || raw.current < 0 || raw.current >= tabs.length) return unreadableOf(kind);
  return { ...head, tabs, current: raw.current, final: raw.final === true, question, multi: raw.multi === true, other: raw.other === true, options, typed: cleanTyped(raw.typed) };
}

// ---- the request body -----------------------------------------------------------------------------------------------------------

/** The string without its lone surrogates (a high one with no low after it, a low one with no high before it): tmux would type U+FFFD for them. */
function dropLone(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { // a whole pair stays
        out += s.slice(i, i + 2);
        i += 1;
      }
    } else if (c < 0xdc00 || c > 0xdfff) out += s[i];
  }
  return out;
}

/** False for a string with a lone surrogate. */
export const wellFormed = (s) => dropLone(s) === s;

/** What the Other box may hold: the text without what the route refuses (controls, zero-width and bidi marks, U+2028/9, lone surrogates). */
export const typable = (s) => dropLone(s).replace(CTRL_G, '').replace(FORMAT_G, '');

/** The text the route would see: spaces and combining marks dropped at the front (a mark before a digit hides it), spaces at the end. */
const edges = (s) => s.replace(/^[\s\p{M}]+/u, '').trimEnd();

// The route's rule for typed text (design W1 4.1 and the route): 1 to TEXT_MAX UTF-16 units (String.length counts those), none of REFUSED, no lone
// surrogate, and no first 1 to 9 (Claude can read it as an option number; the route answers 400 invalid). The edges are trimmed before this runs,
// so the route's "no space at either end" holds too.
const DIGIT_LEAD = /^[1-9]/;
const validText = (t) => t.length >= 1 && t.length <= TEXT_MAX && !CTRL.test(t) && !FORMAT.test(t) && wellFormed(t) && !/^\p{M}/u.test(t) && !DIGIT_LEAD.test(t);

/**
 * The one request body for what the form holds, or null when there is nothing valid to send (design W1 4.1). `a` is { picks, text } for a question,
 * { submit: true } for the review, { choice } for a plan, { cancel: true } for any step. Single-select takes exactly one of a pick or Other text;
 * multi-select takes picks, and Other text only where the capture allows it. The text is trimmed, 1 to 300 characters, with no control character.
 */
export function answerBody(d, a) {
  if (!d || d.state !== 'ready' || !isObject(a)) return null;
  if (a.cancel === true) return { sig: d.sig, cancel: true };
  if (a.tab !== undefined) { // a step move (0.5.1): any step but this one, Review being the tab count; it carries nothing else
    const here = d.at === 'review' ? d.tabs?.length : d.at === 'question' ? d.current : -1;
    return Object.keys(a).length === 1 && Number.isInteger(a.tab) && a.tab >= 0 && d.tabs?.length >= 2 && a.tab <= d.tabs.length && a.tab !== here ? { sig: d.sig, tab: a.tab } : null;
  }
  if (d.at === 'review') return a.submit === true ? { sig: d.sig, submit: true } : null;
  if (d.at === 'plan') return Number.isInteger(a.choice) && d.options.some((o) => o.n === a.choice && !o.text) ? { sig: d.sig, choice: a.choice } : null;
  if (d.at !== 'question' || !Array.isArray(a.picks)) return null;
  const picks = [...new Set(a.picks)].sort((x, y) => x - y);
  if (!picks.every((n) => d.options.some((o) => o.n === n))) return null;
  const typed = d.other && d.typed ? edges(d.typed.text) : ''; // Claude's own text row: nika never edits it, so a request carries it as it is
  let t = typeof a.text === 'string' ? edges(a.text) : '';
  if (typed !== '') {
    if (d.multi) t = typed; // the route refuses a multi-select answer that leaves the typed text out (dialog-touched)
    else if (t !== '' && t !== typed) return null;
  }
  if (t !== '' && (!d.other || !validText(t))) return null;
  if (d.multi) return picks.length || t ? { sig: d.sig, picks, ...(t ? { text: t } : {}) } : null;
  if (picks.length === 1 && t === '') return { sig: d.sig, picks };
  return picks.length === 0 && t !== '' ? { sig: d.sig, picks, text: t } : null;
}

// ---- the words --------------------------------------------------------------------------------------------------------------------

/**
 * R3 (0.5.2): the review as rows, one per question tab. The capture lists the answered questions only, in tab order, with no tab index, so the k-th answered tab gets
 * the k-th pair; that map is trusted only when the pairs are as many as the answered tabs and Claude's warning is on exactly when a tab is open. Otherwise (`mapped`
 * false) the rows are the pairs alone, with no step, header or Change. A row: { step (tab index, or null), header, question and answer (null when not answered) }.
 */
export function reviewModel(d) {
  const tabs = Array.isArray(d?.tabs) ? d.tabs : [];
  const pairs = (Array.isArray(d?.pairs) ? d.pairs : []).filter((p) => p !== null && typeof p === 'object' && typeof p.question === 'string' && typeof p.answer === 'string');
  const answered = tabs.filter((t) => t?.answered === true).length;
  const mapped = tabs.length > 0 && pairs.length === answered && (d?.warn === true) === (answered < tabs.length);
  if (!mapped) return { mapped: false, total: pairs.length, answered: pairs.length, rows: pairs.map((p) => ({ step: null, header: '', question: p.question, answer: p.answer })) };
  let k = 0;
  const rows = tabs.map((t, i) => {
    const header = typeof t.header === 'string' ? t.header : '';
    if (t.answered !== true) return { step: i, header, question: null, answer: null };
    const p = pairs[k];
    k += 1;
    return { step: i, header, question: p.question, answer: p.answer };
  });
  return { mapped: true, total: tabs.length, answered, rows };
}

/** The narrow strip text: "Question 2 of 4 . Tools", or "Review". */
export const stepText = (d) => (d.at === 'review' ? 'Review' : `Question ${d.current + 1} of ${d.tabs.length}${MID}${d.tabs[d.current].header}`);

/** What the polite region says when a step appears (`first`: no form was on screen before). A step that mentions bypass says it is terminal only. */
export function announcement(d, { name = 'the agent', first = true } = {}) {
  const where = d.bypass ? TERMINAL_NOTE : null;
  if (d.at === 'plan') return `${name} asks you to approve a plan. ${where ?? 'Read it in the terminal view; choices above the message box.'}`;
  if (d.at === 'review') {
    const m = reviewModel(d);
    const n = m.answered;
    const what = m.mapped ? `${n} of ${m.total} answered` : `${n} ${n === 1 ? 'answer' : 'answers'}`;
    return `Review your answers: ${what}${where ? `. ${where}` : ', above the message box.'}`;
  }
  if (!first && d.tabs.length >= 2) return `Question ${d.current + 1} of ${d.tabs.length}: ${d.question}${where ? ` ${where}` : ''}`;
  const place = d.tabs.length >= 2 ? ` Question ${d.current + 1} of ${d.tabs.length}, above the message box.` : ' Above the message box.';
  return `${name} asks: ${d.question}${where ? ` ${where}` : place}`;
}

// ---- the DOM side -----------------------------------------------------------------------------------------------------------------

const CHIP = {
  reading: { icon: 'clock', word: 'Reading' },
  terminal: { icon: 'off', word: 'Terminal only' },
  answering: { spin: true, word: 'Answering' },
  moving: { spin: true, word: 'Moving' },
  answered: { icon: 'check', word: 'Answered' },
  failed: { icon: 'warn', word: 'Not answered' },
};

/** The state chip: colour from data-s, an icon (or the spinner) and a word. The ready state is the existing "Needs you" pill. */
function chipEl(key, word) {
  if (key === 'ready') return h('span', { class: 'st pill', 'data-s': 'attn' }, h('span', { class: 'st-g', 'aria-hidden': 'true' }), 'Needs you');
  const c = CHIP[key];
  return h('span', { class: 'dlg-chip', 'data-s': key }, c.spin ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : icon(c.icon), word || c.word);
}

const kindTag = (kind) => h('span', { class: 'dlg-kind', id: 'dlg-kind', 'data-k': kind }, icon(kind === 'plan' ? 'm-plan' : 'dialog'), kind === 'plan' ? 'Plan approval' : 'Question');

function setOff(el, on) {
  if (on) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
}

/** Where the form is in Claude's strip: the question's tab, or the tab count for the review. */
const hereOf = (d) => (d.at === 'review' ? d.tabs.length : d.current);

/** What a question's unsent input is kept under while you look at other steps. */
const keyOf = (d) => `${d.current}\u0000${d.question}`;

/** What tells one dialog's strip from another's: the tab headers. A new set drops every kept draft. */
const headersOf = (d) => (Array.isArray(d.tabs) ? d.tabs.map((t) => t.header).join('\u0000') : '');

/**
 * The strip of Claude's tabs, as an ordered list of buttons (0.5.1): one per question and one for Review. A button asks the server to move
 * Claude's dialog to that step; it answers nothing. They are plain buttons, not an ARIA tablist: each is one Tab stop. A step that cannot be
 * used now (the current one, or any while the form is busy, locked or terminal-only) is aria-disabled, never `disabled`, so it keeps its name
 * and its focus; `paint` sets that. Returns the nodes (list, its hidden description, the narrow text) and the buttons by step index.
 */
function stripEls(d, onStep) {
  const steps = [];
  const item = (i, kids, extra = {}) => {
    const b = h('button', { type: 'button', class: 'dlg-tab', 'data-tab': String(i), 'aria-current': i === hereOf(d) ? 'step' : null, 'aria-describedby': 'dlg-steps-desc', ...extra, onclick: () => onStep(i) }, ...kids);
    steps.push([i, b]);
    return h('li', null, b);
  };
  const items = d.tabs.map((t, i) => item(i, [
    t.answered ? icon('check') : h('span', { class: 'dlg-ring', 'aria-hidden': 'true' }),
    h('span', { text: t.header }),
    h('span', { class: 'sr-only', text: t.answered ? ', answered' : ', not answered' }),
  ], { 'data-answered': String(t.answered) }));
  items.push(item(d.tabs.length, ['Review']));
  return {
    nodes: [h('ol', { class: 'dlg-tabs', 'aria-label': 'Steps' }, ...items), h('p', { class: 'sr-only', id: 'dlg-steps-desc', text: STEPS_NOTE }), h('p', { class: 'dlg-step', text: stepText(d) })],
    steps,
  };
}

export function createDialogForm(io) {
  const root = io.root;
  const now = io.now ?? (() => Date.now());
  const after = io.after ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = io.cancel ?? ((t) => clearTimeout(t));
  let F = null; // the form on screen: { dialog, sig, phase, word, busy, busyEl, locked, kept, terminal, chipSig, reason, notes, parts }
  let last = null; // the arguments of the last render: the replay after a request and the timer use them
  let reading = null; // { since, timer, expired, drawn }: a dialog nika cannot read yet, with no form shown before it
  let visible = false;
  const keep = new Map(); // unsent input per question while you look at other steps (0.5.1): { picks, other }; memory only, KEEP_MAX questions, oldest out first
  let keepFor = null; // the tab headers the drafts belong to
  const name = () => last?.name ?? 'the agent';

  const show = (on) => {
    if (on === visible) return;
    visible = on;
    root.hidden = !on;
  };

  const stopReading = () => {
    if (reading?.timer != null) cancel(reading.timer);
    reading = null;
  };

  const interactive = (f, body = null) => F === f && !f.busy && !f.locked && !f.kept && (!f.terminal || body?.cancel === true);

  /** Redraws what changes without rebuilding: the chip, the notes, and which controls are live. */
  function paint() {
    const f = F;
    if (f === null) return;
    const key = f.busy ? (f.moving ? 'moving' : 'answering') : f.phase === 'answered' ? 'answered' : f.phase === 'moving' ? 'moving' : f.phase === 'failed' ? 'failed' : f.terminal ? 'terminal' : 'ready';
    const word = key === 'answered' ? f.word : '';
    if (`${key}|${word}` !== f.chipSig) {
      f.chipSig = `${key}|${word}`;
      f.chipHolder.replaceChildren(chipEl(key, word));
      root.setAttribute('data-s', key);
    }
    const attention = last?.attention ?? '';
    if (f.reason.textContent !== attention) f.reason.textContent = attention;
    const idle = !f.busy && !f.locked && !f.kept;
    const live = idle && !f.terminal;
    root.setAttribute('data-inert', String(!live)); // the option rows dim whenever the form cannot take an answer, not only while one is on its way
    f.terminalNote.hidden = !f.terminal;
    f.keptNote.hidden = !f.kept;
    const p = f.parts;
    for (const el of p.inputs) {
      el.disabled = f.terminal; // read-only: the options are shown, not offered
      setOff(el, !live || p.pinned.includes(el));
    }
    for (const [i, el] of p.steps) setOff(el, !live || i === hereOf(f.dialog)); // the current step is never a target; none is while the form is busy, locked or terminal-only
    for (const el of p.choices) setOff(el, !live);
    for (const el of p.texts) {
      if (live) el.removeAttribute('readonly');
      else el.setAttribute('readonly', '');
    }
    if (p.primary) setOff(p.primary, !live || !p.canSend());
    if (p.decline) setOff(p.decline, !idle);
    for (const el of [p.primary, p.decline, ...p.choices]) {
      if (!el) continue;
      if (f.busy && f.busyEl === el) el.setAttribute('aria-busy', 'true');
      else el.removeAttribute('aria-busy');
    }
  }

  /** One request, one step. The form is off while it runs; the result is a fixed line, never the response's text. */
  async function act(f, body, el) {
    if (!body || !interactive(f, body)) return;
    f.busy = true;
    f.busyEl = el;
    f.moving = body.tab !== undefined;
    paint();
    const r = await io.call(io.path('dialog'), { method: 'POST', json: body });
    f.busy = false;
    f.busyEl = null;
    f.moving = false;
    const out = dialogOutcome({ status: r.status, code: r.body?.error, done: r.body?.done, sent: r.body?.sent, name: name() });
    if (out.ok) {
      io.clearProblem();
      if (out.sent > 0) io.say(`Sent ${out.sent} ${out.sent === 1 ? 'key' : 'keys'} to ${io.paneId}`);
      if (out.announce) io.announce(out.announce); // a move says nothing; the step it lands on is announced when it is drawn
      if (body.tab === undefined && f.dialog.at === 'question') keep.delete(keyOf(f.dialog)); // sent: Claude holds it now, an older draft would only be stale
    } else if (out.message) {
      io.showProblem(out.message, out.kind);
    }
    if (F === f) { // else the dialog closed or moved on while the request ran
      f.phase = out.phase;
      f.word = out.word;
      f.locked = out.lock;
      paint();
    }
    if (out.gone) io.setGone();
    if (last !== null) render(last); // a step that arrived while the request ran is drawn now
  }

  const declineEl = (f, cls, label, extra = {}) => h('button', { type: 'button', class: cls, title: DECLINE_TITLE, ...extra, onclick: (e) => act(f, answerBody(f.dialog, { cancel: true }), e.currentTarget) }, label);

  function questionBody(f) {
    const d = f.dialog;
    const boxes = []; // { n, input, row }
    let other = null; // { input, txt, row, count }
    let lead = null; // the warn line under the text field (only with Other)
    const typed = d.other ? d.typed : null; // Claude's own text row: shown, never edited (0.5.1)
    const draft = typed === null ? keep.get(keyOf(d)) : undefined; // unsent input from an earlier visit; Claude's typed text wins over it
    const pinned = []; // inputs that stay aria-disabled whatever the state (the Other box of a multi-select with typed text)
    const picked = (o) => (draft ? draft.picks.includes(o.n) : o.checked);
    const read = () => ({ picks: boxes.filter((b) => b.input.checked).map((b) => b.n), text: other?.input.checked ? other.txt.value : '' });
    const leading = () => typed === null && other?.input.checked === true && DIGIT_LEAD.test(edges(other.txt.value)); // text that would be sent starts with a digit
    const sync = () => {
      for (const b of boxes) b.row.setAttribute('data-on', String(b.input.checked));
      other?.row.setAttribute('data-on', String(other.input.checked));
      if (lead !== null && lead.hidden === leading()) { // the line follows the text; a screen reader hears it once, when it appears
        lead.hidden = !lead.hidden;
        if (lead.hidden) other.txt.removeAttribute('aria-describedby');
        else {
          other.txt.setAttribute('aria-describedby', 'dlg-lead');
          io.announce(LEAD_NOTE);
        }
      }
      paint();
    };
    const guard = (e) => { if (!interactive(f)) e.preventDefault(); };
    const clearPicks = (except) => { // one radio at a time; a checkbox set is the user's own
      if (d.multi) return;
      for (const b of boxes) if (b.input !== except) b.input.checked = false;
      if (other && other.input !== except) other.input.checked = false;
    };
    const rows = d.options.map((o) => {
      const input = h('input', { type: d.multi ? 'checkbox' : 'radio', name: d.multi ? null : 'dlg-pick', value: String(o.n), checked: picked(o), onclick: guard, onchange: () => { if (input.checked) clearPicks(input); sync(); } });
      const long = typeof o.description === 'string' && o.description.length > CLAMP_FROM;
      const desc = o.description ? h('span', { class: long ? 'dlg-desc clamp' : 'dlg-desc', id: `dlg-d-${o.n}`, text: o.description }) : null;
      const on = String(picked(o));
      // A short option is one label and that label is the card. A long one is a card (div.dlg-opt: border, hover, picked look) that holds the
      // label and, under it, More: the button stays outside the label (a button in a label is nested interactive content), so the card, not
      // the label, carries data-on.
      const label = h('label', { class: 'ch', 'data-on': long ? null : on }, input, h('kbd', { text: String(o.n) }), h('span', { class: 'ch-b' }, h('span', { class: 'ch-t', text: o.label }), desc));
      if (!long) {
        boxes.push({ n: o.n, input, row: label });
        return label;
      }
      const more = h('button', { type: 'button', class: 'btn link dlg-more', 'aria-expanded': 'false', 'aria-controls': `dlg-d-${o.n}`, onclick: () => {
        const open = more.getAttribute('aria-expanded') !== 'true';
        more.setAttribute('aria-expanded', String(open));
        desc.className = open ? 'dlg-desc' : 'dlg-desc clamp';
        more.textContent = open ? 'Less' : 'More';
      } }, 'More');
      const card = h('div', { class: 'dlg-opt', 'data-on': on }, label, more);
      boxes.push({ n: o.n, input, row: card });
      return card;
    });
    const texts = [];
    let otherRow;
    if (d.other) {
      const lockedBox = typed !== null && d.multi; // the route needs the typed text in every multi-select answer, so its box stays ticked
      const input = h('input', {
        type: d.multi ? 'checkbox' : 'radio', name: d.multi ? null : 'dlg-pick', value: 'other',
        checked: typed !== null ? lockedBox || typed.answered : draft?.other?.on === true,
        onclick: lockedBox ? (e) => e.preventDefault() : guard, onchange: () => { if (input.checked) clearPicks(input); sync(); },
      });
      if (lockedBox) {
        input.setAttribute('aria-disabled', 'true');
        pinned.push(input);
      }
      const count = h('span', { class: 'dlg-count', hidden: true });
      const txt = h('input', {
        type: 'text', class: 'dlg-text', maxlength: String(TEXT_MAX), placeholder: 'Type your answer', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Other answer',
        oninput: () => {
          const v = txt.value;
          const s = typable(v); // a pasted tab, control, zero-width or bidi mark, or a half of an astral character (a paste cut by maxlength) is not part of an answer
          if (s !== v) txt.value = s;
          if (s !== '') {
            input.checked = true;
            clearPicks(input);
          }
          count.hidden = s.length < COUNT_FROM;
          count.textContent = `${s.length}/${TEXT_MAX}`;
          sync();
        },
        onkeydown: (e) => { // Enter sends, never a newline; the IME owns its own Enter
          if (e.key !== 'Enter' || e.isComposing || e.shiftKey) return;
          e.preventDefault();
          send();
        },
      });
      if (typed !== null) {
        txt.value = typed.text;
        txt.setAttribute('readonly', '');
        txt.setAttribute('aria-describedby', 'dlg-typed-note');
      } else if (draft?.other) {
        txt.value = draft.other.text;
      }
      const row = h('div', { class: 'ch dlg-other', 'data-on': String(input.checked) }, h('label', { class: 'dlg-ol' }, input, h('span', { class: 'ch-t', text: 'Other' })), txt, count);
      other = { input, txt, row, count };
      lead = h('p', { class: 'dlg-warn', id: 'dlg-lead', hidden: true }, icon('warn'), h('span', { text: LEAD_NOTE }));
      if (typed === null) texts.push(txt); // the typed text is Claude's: it stays read-only whatever the state
      otherRow = row;
    } else {
      otherRow = h('div', { class: 'pbtn-off' }, h('span', { text: 'Other answers: use the terminal' }));
    }
    const legend = h('legend', { class: 'ask-q', id: 'dlg-q', tabindex: '-1', text: d.question });
    const primary = h('button', { type: 'button', class: 'btn primary dlg-send', onclick: () => send() }, d.final ? 'Send answer' : 'Answer');
    const decline = declineEl(f, 'btn ghost dlg-decline', 'Decline');
    function send() {
      if (F !== f) return;
      if (leading()) other.txt.focus({ preventScroll: true }); // the line is already under the field; a click on Send moved the focus away from it
      else act(f, answerBody(f.dialog, read()), primary);
    }
    const nodes = [];
    const strip = d.tabs.length >= 2 ? stripEls(d, (j) => onStep(f, j)) : null;
    if (strip !== null) nodes.push(...strip.nodes);
    const again = d.tabs[d.current].answered ? h('p', { class: 'dlg-note' }, icon('info'), h('span', { text: AGAIN_NOTE })) : null; // Claude shows its answer ticked; a new one replaces it
    const typedNote = typed !== null ? h('p', { class: 'dlg-note', id: 'dlg-typed-note' }, icon('info'), h('span', { text: TYPED_NOTE })) : null;
    nodes.push(h('fieldset', { class: 'dlg-fs' }, legend, again, ...rows, otherRow, typedNote, lead), h('div', { class: 'dlg-btns' }, primary, decline));
    return {
      nodes, heading: legend, inputs: [...boxes.map((b) => b.input), ...(other ? [other.input, other.txt] : [])], texts, choices: [], primary, decline,
      steps: strip?.steps ?? [], pinned,
      canSend: () => answerBody(f.dialog, read()) !== null,
      snapshot: () => (typed !== null ? null : { picks: read().picks, other: other ? { on: other.input.checked, text: other.txt.value } : null }), // null: Claude's text row decides
    };
  }

  /**
   * R3 (0.5.2): one card per question (reviewModel), each with a Change button (Answer for a question not answered yet) that moves Claude's dialog to that step and answers
   * nothing. When the tabs and the pairs do not line up the cards are the pairs alone, with Claude's own warning line and no button; a one-question dialog has no button
   * either, because the move is refused for it (answerBody needs two tabs; ruling 3), so the strip, which owns #dlg-steps-desc, is there exactly when the buttons are. The
   * buttons carry data-step, not data-tab, so build() puts the focus on the new step's heading after the move. paint() treats them as steps (aria-disabled unless the form is live).
   */
  function reviewBody(f) {
    const d = f.dialog;
    const m = reviewModel(d);
    const heading = h('h3', { class: 'ask-q', id: 'dlg-q', tabindex: '-1', text: 'Review your answers' });
    const nodes = [];
    const strip = d.tabs.length >= 2 ? stripEls(d, (j) => onStep(f, j)) : null;
    if (strip !== null) nodes.push(...strip.nodes);
    nodes.push(heading);
    if (m.mapped) {
      const all = m.answered === m.total;
      nodes.push(h('p', { class: 'dlg-rv-n', 'data-all': String(all) }, icon(all ? 'check' : 'warn'),
        h('span', { text: all ? `${m.answered} of ${m.total} answered` : `${m.answered} of ${m.total} answered${MID}${m.total - m.answered} not answered` })));
    } else if (d.warn) {
      nodes.push(h('p', { class: 'dlg-warn' }, icon('warn'), h('span', { text: 'You have not answered all questions' })));
    }
    const canMove = m.mapped && d.tabs.length >= 2; // the move needs two tabs, see answerBody
    const changes = []; // [step, button]
    const rows = m.rows.map((r) => {
      const done = r.answer !== null;
      const kids = [];
      if (m.mapped) kids.push(h('p', { class: 'dlg-rv-h' }, icon(done ? 'check' : 'warn'), h('span', { text: r.header }), h('span', { class: 'sr-only', text: done ? ', answered' : ', not answered' })));
      if (done) {
        kids.push(h('p', { class: 'dlg-rv-q', title: r.question, text: r.question }));
        kids.push(h('p', { class: 'dlg-rv-a' }, h('span', { class: 'sr-only', text: 'Answer: ' }), h('span', { text: r.answer })));
      } else {
        kids.push(h('p', { class: 'dlg-rv-a dlg-rv-none', text: 'Not answered' }));
      }
      if (canMove) {
        const b = h('button', { type: 'button', class: 'btn dlg-rv-chg', 'data-step': String(r.step), 'aria-describedby': 'dlg-steps-desc', onclick: () => onStep(f, r.step) },
          done ? 'Change' : 'Answer', h('span', { class: 'sr-only', text: done ? ` answer ${r.step + 1}: ${r.header}` : ` question ${r.step + 1}: ${r.header}` }));
        changes.push([r.step, b]);
        kids.push(b);
      }
      return h('li', { class: 'dlg-rv-row', 'data-state': done ? 'done' : 'none' }, ...kids);
    });
    const primary = h('button', { type: 'button', class: 'btn primary dlg-send', onclick: () => act(f, answerBody(f.dialog, { submit: true }), primary) }, 'Submit answers');
    const decline = declineEl(f, 'btn ghost dlg-decline', 'Decline');
    nodes.push(h('ol', { class: 'dlg-rv', 'aria-label': 'Your answers' }, ...rows), h('div', { class: 'dlg-btns dlg-rv-btns' }, primary, decline));
    return { nodes, heading, inputs: [], texts: [], choices: [], steps: [...(strip?.steps ?? []), ...changes], pinned: [], primary, decline, canSend: () => true };
  }

  function planBody(f) {
    const d = f.dialog;
    const note = h('p', { class: 'dlg-note', tabindex: '-1' }, icon('window'), h('span', { text: 'Read the plan in the terminal view.' }));
    const choices = [];
    const rows = d.options.map((o) => {
      if (o.text) return h('div', { class: 'pbtn-off' }, h('kbd', { text: String(o.n) }), h('span', { text: `${o.label}: use the terminal` })); // its Enter was never verified live
      if (f.terminal) return h('div', { class: 'pbtn-off' }, h('kbd', { text: String(o.n) }), h('span', { text: o.label }));
      const b = h('button', { type: 'button', class: 'pbtn', 'data-n': String(o.n), onclick: (e) => act(f, answerBody(f.dialog, { choice: o.n }), e.currentTarget) }, h('kbd', { text: String(o.n) }), h('span', { text: o.label }));
      choices.push(b);
      return b;
    });
    const decline = declineEl(f, 'pbtn esc', h('span', { text: 'Reject (Esc)' }));
    return { nodes: [note, h('div', { class: 'ask-opts dlg-choices' }, ...rows, decline)], heading: note, inputs: [], texts: [], choices, steps: [], pinned: [], primary: null, decline, canSend: () => false };
  }

  /** A click on a step: remember the unsent input of this question, then ask the server to move Claude's dialog there. Nothing is answered. */
  function onStep(f, j) {
    if (F !== f || !interactive(f)) return;
    const body = answerBody(f.dialog, { tab: j });
    if (body === null) return;
    if (f.dialog.at === 'question') {
      const key = keyOf(f.dialog);
      const mine = f.parts.snapshot();
      keep.delete(key); // a fresh place at the end of the order
      if (mine !== null) keep.set(key, mine);
      while (keep.size > KEEP_MAX) keep.delete(keep.keys().next().value);
    }
    act(f, body, null);
  }

  function build(dialog) {
    const prev = F;
    const focused = prev !== null && root.contains(document.activeElement);
    const onStepTab = focused ? document.activeElement.getAttribute?.('data-tab') ?? null : null; // a step button had the focus: the same step's button gets it back
    const headers = headersOf(dialog);
    if (keepFor !== headers) { // another dialog (other tab headers): the drafts belong to the old one
      keep.clear();
      keepFor = headers;
    }
    const f = { dialog, sig: dialog.sig, phase: 'live', word: '', busy: false, busyEl: null, moving: false, locked: false, kept: false, terminal: dialog.bypass, chipSig: '' };
    f.chipHolder = h('span', { class: 'dlg-chiph' });
    f.reason = h('span', { class: 'ask-reason' });
    f.terminalNote = h('p', { class: 'dlg-note', hidden: true }, icon('info'), h('span', { text: TERMINAL_NOTE }));
    f.keptNote = h('p', { class: 'dlg-note', hidden: true }, icon('info'), h('span', { text: KEPT_NOTE }));
    f.parts = dialog.kind === 'plan' ? planBody(f) : dialog.at === 'review' ? reviewBody(f) : questionBody(f);
    F = f;
    root.replaceChildren(h('div', { class: 'ask-h' }, f.chipHolder, kindTag(dialog.kind), f.reason), f.terminalNote, f.keptNote, ...f.parts.nodes);
    root.setAttribute('aria-labelledby', dialog.kind === 'plan' ? 'dlg-kind' : 'dlg-q');
    root.removeAttribute('aria-label');
    show(true);
    paint();
    io.announce(announcement(dialog, { name: name(), first: prev === null }));
    if (focused) { // the control that had focus was replaced: the same step's button if it was one (it is still in the strip); the form root when that button is gone; else the new question, so a held key answers nothing unseen
      const same = onStepTab === null ? null : f.parts.steps.find(([i]) => String(i) === onStepTab)?.[1];
      (same ?? (onStepTab === null ? f.parts.heading : root)).focus({ preventScroll: true });
    }
  }

  function drawReading(kind) {
    root.replaceChildren(
      h('div', { class: 'ask-h' }, h('span', { class: 'dlg-chiph' }, chipEl('reading')), kind ? kindTag(kind) : null, h('span', { class: 'ask-reason', text: last?.attention ?? '' })),
      h('p', { class: 'dlg-note' }, icon('info'), h('span', { text: `Reading Claude's question${DOTS}` })),
    );
    root.setAttribute('data-s', 'reading');
    root.removeAttribute('aria-labelledby');
    root.setAttribute('aria-label', "Claude's question");
    show(true);
  }

  function leave() {
    stopReading();
    keep.clear(); // the dialog is closed: its drafts go with it
    keepFor = null;
    if (F === null && !visible) return;
    if (visible && root.contains(document.activeElement)) io.composer().focus({ preventScroll: true }); // the control that had focus is gone
    F = null;
    root.replaceChildren();
    show(false);
  }

  /** `growing` (F16): nika is giving Claude's pane more rows for this question, so Reading goes on past READING_MS and the banner waits. */
  function unreadable(dialog, growing) {
    if (F !== null) { // a shown form stays; it only says it cannot read the screen for now
      F.kept = true;
      paint();
      return;
    }
    if (reading === null) reading = { since: now(), timer: null, expired: false, drawn: false };
    const left = READING_MS - (now() - reading.since);
    if (growing === true || (left > 0 && !reading.expired)) {
      if (left > 0 && !reading.expired && reading.timer === null) {
        const mine = reading;
        mine.timer = after(() => {
          mine.timer = null;
          mine.expired = true;
          if (reading === mine && last !== null) render(last);
        }, left);
      }
      if (!reading.drawn || !visible) { // also after the banner took over: a step started again
        reading.drawn = true;
        drawReading(dialog.kind);
      }
      return;
    }
    if (visible) { // the banner takes over from here on
      root.replaceChildren();
      show(false);
    }
  }

  function step({ pane, dialog, growing }) {
    if (pane !== 'ok' || !dialog) leave();
    else if (dialog.state === 'unreadable') unreadable(dialog, growing === true);
    else {
      stopReading();
      if (F !== null && F.sig === dialog.sig) { // the same step: the nodes stay, so typed text and focus survive the captures
        F.dialog = dialog;
        F.terminal = dialog.bypass;
        F.kept = false;
        paint();
      } else if (F === null || !F.busy) { // else the request finishes first; its end draws the step again from `last`
        build(dialog);
      }
    }
  }

  /** Draws the capture's dialog. `dialog` is cleanDialog's answer; a pane that is not 'ok' or no dialog takes the form away. */
  function render(args) {
    last = args;
    const before = visible;
    step(args);
    if (visible !== before) io.refresh?.(); // the attention note and the form never show together
  }

  return { render, shown: () => visible, live: () => F !== null && !F.terminal };
}
