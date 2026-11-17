// Claude's feedback survey and its transcript question as buttons in the session window (nika 0.5, design F13 section 2.6 with the F14 changes).
// The server reads the survey off the pane's screen and puts it in the capture's `survey` field; this file draws it as a panel above the message
// box and answers through one route: POST /api/app/pane/:id/survey { n, sig }. Each button posts its own number and the sig it was drawn for;
// the SERVER types the digit. The page presses no key and types nothing itself.
// Rules: every string is text (h() and textContent, never markup); no inline style (classes and data attributes only); the server's own words
// never show (every answer maps to a fixed line below, an unknown code to the generic one); a rating or a transcript question that is not exactly
// the contract shape draws nothing (the user answers it in the terminal, as before). The pure rules come first and are tested alone; the DOM side
// does nothing at import.
// Keep this file ASCII: write every symbol as an escape.
import { h, icon } from './dom.js';
import { problemKind } from './quick-actions.js';

export const LABEL_MAX = 20; // the longest option label the page draws; a longer one is not Claude's survey as nika read it
const SIG = /^[0-9a-f]{16}$/;
const DOTS = String.fromCharCode(0x2026);
const KINDS = new Set(['rating', 'consent']);
const REASONS = new Set(['consent', 'bypass', 'input', 'normal', 'unreadable']);
const NOISE = new RegExp(`[${[[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

// ---- the copy: fixed lines, picked by kind, reason, status and code only -----------------------------------------------------------

export const TRANSCRIPT_LINE = "A yes shares this session's transcript with Anthropic.";
const QUESTION = { rating: 'How is Claude doing this session? (optional)', consent: 'Can Anthropic look at your session transcript?' };
const HINT = 'Each button presses its number in the pane. Claude takes it at once; no Enter.';
const TERMINAL = {
  consent: "Claude asks whether Anthropic may look at this session's transcript. That is your call: answer it in the terminal.",
  bypass: 'This screen mentions bypass, so nika leaves the survey to you: answer it in the terminal.',
  input: "Claude's input box has text, so a number would land there. Answer the survey in the terminal.",
  normal: "Claude's input is in vim normal mode, where a number is a vim count. Answer the survey in the terminal.",
  unreadable: "Claude shows a feedback question nika can't read exactly. Answer it in the terminal.",
};
const GENERIC = "nika couldn't send that answer.";
const UNREACHABLE = "nika couldn't reach tmux.";
// [problem line, the buttons stay off until the sig changes]
const L409 = {
  'survey-changed': ['The survey changed; check the session.', true],
  'already-answered': ['', true],
  'no-survey': ['The survey is gone.', false],
  'busy-switching': ['Another action is running on this session.', false],
  'not-idle': ['Claude is busy; try again in a moment.', false],
  'prompt-open': ['Claude is asking something else first; answer that.', false],
  'input-not-empty': ["Claude's input box has text, so a number would land there. Answer the survey in the terminal.", true],
  'text-mode': ["Claude's input is in vim normal mode. Answer the survey in the terminal.", true],
  'not-taken': ["Claude didn't take the answer. Check the terminal: the number may be in Claude's input box.", true],
};
const L400 = {
  'terminal-only': ['Answer this survey in the terminal.', true],
  invalid: [GENERIC, true],
};

/**
 * What a route answer means for the panel: { ok, phase ('sent' | 'answered' | 'failed'), lock (stay off until the sig changes), message (the problem
 * line, '' = none), kind ('warn' | 'error'), gone (the pane is gone) }. Only the status and the `error` code are read; no text of the response is
 * ever shown. A status or code the table does not know gets the generic line and locks the buttons: the key may have gone out, and a second digit
 * would land in Claude's input box.
 */
export function surveyOutcome({ status, code } = {}) {
  if (status === 200) return { ok: true, phase: 'sent', lock: true, message: '', kind: '', gone: false };
  let row = [GENERIC, true];
  if (status === 409 && typeof code === 'string' && Object.hasOwn(L409, code)) row = L409[code];
  else if (status === 400 && typeof code === 'string' && Object.hasOwn(L400, code)) row = L400[code];
  else if (status === 429) row = ['Too many keys at once; try again.', false];
  else if (status === 404) row = ['The session is gone.', false];
  else if (status === 0 || (Number.isInteger(status) && status >= 500)) row = [UNREACHABLE, false];
  const [message, lock] = row;
  const already = status === 409 && code === 'already-answered'; // someone answered it (a second window): it is answered, not failed
  return { ok: false, phase: already ? 'answered' : 'failed', lock, message, kind: message ? problemKind(status) : '', gone: status === 404 };
}

// ---- the capture's `survey`, cleaned ----------------------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const optionNumber = (n) => Number.isInteger(n) && n >= 0 && n <= 3;

/** The options list of a ready survey, or null: 1 to 4 objects, numbers 0 to 3 once each, labels of 1 to LABEL_MAX characters of text. */
function cleanOptions(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 4) return null;
  const options = [];
  for (const o of list) {
    if (!isObject(o) || !optionNumber(o.n) || options.some((x) => x.n === o.n)) return null;
    if (typeof o.label !== 'string' || o.label.length > LABEL_MAX) return null;
    const label = o.label.replace(NOISE, '').trim();
    if (label === '') return null;
    options.push({ n: o.n, label });
  }
  return options;
}

/**
 * The capture's `survey` as the page may use it: null (no survey, or anything that is not exactly the contract), `{ state: 'terminal', reason }` or
 * `{ state: 'ready', kind ('rating' | 'consent'), sig, options: [{ n, label }] }`. A rating is the four buttons 1, 2, 3 and 0. Anything else fails
 * CLOSED to null: no panel is drawn from a half-valid survey. Copies the data: the capture object is not kept.
 */
export function cleanSurvey(raw) {
  if (!isObject(raw)) return null;
  if (raw.state === 'terminal') return typeof raw.reason === 'string' && REASONS.has(raw.reason) ? { state: 'terminal', reason: raw.reason } : null;
  if (raw.state !== 'ready' || typeof raw.kind !== 'string' || !KINDS.has(raw.kind) || typeof raw.sig !== 'string' || !SIG.test(raw.sig)) return null;
  const options = cleanOptions(raw.options);
  if (options === null) return null;
  if (raw.kind === 'rating' && (options.length !== 4 || ![0, 1, 2, 3].every((n) => options.some((o) => o.n === n)))) return null;
  return { state: 'ready', kind: raw.kind, sig: raw.sig, options };
}

/** The request body for a press of option `n`: exactly { n, sig }, or null when this survey does not show that number. */
export function surveyBody(s, n) {
  if (!s || s.state !== 'ready' || !KINDS.has(s.kind) || typeof s.sig !== 'string' || !SIG.test(s.sig) || !Number.isInteger(n)) return null;
  return Array.isArray(s.options) && s.options.some((o) => o.n === n) ? { n, sig: s.sig } : null;
}

// ---- the words --------------------------------------------------------------------------------------------------------------------

/** What the polite region says when a survey appears. */
export function announcement(s, { name = 'the agent' } = {}) {
  if (!s) return '';
  if (s.state === 'terminal') return `${name}: ${TERMINAL[s.reason]}`;
  const n = s.options.length;
  const base = `${name}: Claude asks for feedback. ${n} ${n === 1 ? 'choice' : 'choices'} above the message box.`;
  return s.kind === 'consent' ? `${base} ${TRANSCRIPT_LINE}` : base;
}

/** The line the message box gives while a survey shows (nothing is sent): answer it above, or the terminal line. null when there is no survey. */
export function gateNote(s) {
  if (!s) return null;
  if (s.state === 'terminal') return TERMINAL[s.reason];
  return s.kind === 'consent' ? "Answer Claude's feedback question above." : "Answer Claude's feedback question above, or Dismiss it.";
}

// ---- the DOM side -----------------------------------------------------------------------------------------------------------------

const kindTag = () => h('span', { class: 'dlg-kind', 'data-k': 'survey' }, icon('info'), 'Feedback');
const head = () => h('div', { class: 'ask-h' }, kindTag(), h('span', { class: 'ask-reason', text: 'Claude asks' }));

function setOff(el, on) {
  if (on) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
}

export function createSurveyPanel(io) {
  const root = io.root;
  let F = null; // the ready panel on screen: { survey, sig, phase, busy, busyN, locked, echo, message, msgKind, parts }
  let drawn = null; // the terminal reason on screen, or null
  let last = null; // the arguments of the last render: the replay after a request uses them
  let visible = false;
  const name = () => last?.name ?? 'the agent';

  const show = (on) => {
    if (on === visible) return;
    visible = on;
    root.hidden = !on;
  };

  /** Redraws what changes without rebuilding: the state word of the panel, the buttons, the echo row and the problem line. */
  function paint() {
    const f = F;
    if (f === null) return;
    const key = f.busy ? 'sending' : f.phase === 'sent' ? 'sent' : f.phase === 'answered' ? 'answered' : f.phase === 'failed' ? 'error' : 'ready';
    root.setAttribute('data-s', key);
    const live = !f.busy && !f.locked;
    for (const b of f.parts.buttons) {
      setOff(b.el, !live);
      const mine = f.busy && f.busyN === b.n;
      if (mine) b.el.setAttribute('aria-busy', 'true');
      else b.el.removeAttribute('aria-busy');
      b.spin.hidden = !mine;
      const label = mine ? `Sending${DOTS}` : b.text;
      if (b.label.textContent !== label) b.label.textContent = label;
    }
    const echo = f.phase === 'sent' ? f.echo : f.phase === 'answered' ? 'Already answered' : '';
    const st = f.parts.status;
    if (st.textContent !== echo) st.replaceChildren(...(echo ? [icon('check'), h('span', { text: echo })] : []));
    st.hidden = echo === '';
    const al = f.parts.alert;
    const problem = f.phase === 'failed' ? f.message : '';
    if (al.textContent !== problem) al.replaceChildren(...(problem ? [icon('warn'), h('span', { text: problem })] : []));
    al.hidden = problem === '';
    if (problem) al.setAttribute('data-k', f.msgKind || 'warn');
  }

  /** One request. The panel is off while it runs; the result is a fixed line, never the response's text. */
  async function act(f, n) {
    if (F !== f || f.busy || f.locked) return;
    const body = surveyBody(f.survey, n);
    if (body === null) return;
    const label = f.survey.options.find((o) => o.n === n).label;
    f.busy = true;
    f.busyN = n;
    paint();
    const r = await io.call(io.path('survey'), { method: 'POST', json: body });
    f.busy = false;
    f.busyN = null;
    const out = surveyOutcome({ status: r.status, code: r.body?.error });
    if (out.ok) {
      io.clearProblem();
      f.echo = `Sent ${n} (${label}) to ${io.paneId}`;
      io.say(f.echo);
    }
    if (F === f) { // else the survey went away or moved on while the request ran
      f.phase = out.phase;
      f.locked = out.lock;
      f.message = out.message;
      f.msgKind = out.kind;
      paint();
    }
    if (out.gone) io.setGone();
    if (last !== null) render(last); // a survey that arrived while the request ran is drawn now
  }

  function build(survey) {
    const prev = F;
    const focused = prev !== null && root.contains(document.activeElement);
    const f = { survey, sig: survey.sig, phase: 'live', busy: false, busyN: null, locked: false, echo: '', message: '', msgKind: '' };
    const heading = h('p', { class: 'ask-q', id: 'svy-q', tabindex: '-1', text: QUESTION[survey.kind] });
    const buttons = survey.options.map((o) => {
      const spin = h('span', { class: 'spin', 'aria-hidden': 'true' });
      spin.hidden = true;
      const label = h('span', { class: 'svy-l', text: o.label });
      const el = h('button', { type: 'button', class: survey.kind === 'rating' && o.n === 0 ? 'pbtn esc' : 'pbtn', 'data-n': String(o.n), onclick: () => act(f, o.n) }, spin, h('kbd', { text: String(o.n) }), label);
      return { n: o.n, text: o.label, el, spin, label };
    });
    const status = h('p', { class: 'svy-st', 'data-k': 'sent' });
    status.hidden = true;
    const alert = h('p', { class: 'svy-problem', role: 'alert', 'data-k': 'warn' });
    alert.hidden = true;
    f.parts = { heading, buttons, status, alert };
    F = f;
    drawn = null;
    root.replaceChildren(
      head(),
      heading,
      h('div', { class: 'svy-btns' }, ...buttons.map((b) => b.el)),
      ...(survey.kind === 'consent' ? [h('p', { class: 'svy-line', text: TRANSCRIPT_LINE })] : []), // always visible under the buttons: a yes shares the transcript
      h('p', { class: 'ask-hint', text: HINT }),
      status,
      alert,
    );
    root.setAttribute('aria-labelledby', 'svy-q');
    root.removeAttribute('aria-label');
    show(true);
    paint();
    io.announce(announcement(survey, { name: name() }));
    if (focused) heading.focus({ preventScroll: true }); // the control that had focus was replaced: the new question, so a held key answers nothing unseen
  }

  function drawTerminal(reason) {
    const focused = root.contains(document.activeElement); // asked before the old content goes: a removed node drops focus to BODY
    F = null;
    drawn = reason;
    root.replaceChildren(
      head(),
      h('div', { class: 'pbtn-off svy-off' }, icon('term'), h('span', { text: 'Terminal only' })),
      h('p', { class: 'svy-reason', text: TERMINAL[reason] }),
    );
    root.setAttribute('data-s', 'terminal');
    root.removeAttribute('aria-labelledby');
    root.setAttribute('aria-label', "Claude's feedback question");
    show(true);
    io.announce(announcement({ state: 'terminal', reason }, { name: name() }));
    if (focused) io.composer().focus({ preventScroll: true }); // the control that had focus is gone and the note has none: the message box (LC21 O1; leave() would find BODY)
  }

  function leave() {
    if (F === null && drawn === null && !visible) return;
    if (visible && root.contains(document.activeElement)) io.composer().focus({ preventScroll: true }); // the control that had focus is gone
    F = null;
    drawn = null;
    root.replaceChildren();
    show(false);
  }

  function step({ pane, survey, blocked }) {
    if (pane !== 'ok' || !survey || blocked === true) leave();
    else if (survey.state === 'terminal') {
      if (F !== null && F.busy) return; // the request finishes first; its end draws the capture again from `last`
      if (drawn !== survey.reason) drawTerminal(survey.reason);
    } else if (F !== null && F.sig === survey.sig && F.survey.kind === survey.kind) { // the same survey: the nodes stay, so focus survives the captures
      F.survey = survey;
      paint();
    } else if (F === null || !F.busy) { // else the request finishes first; its end draws the survey again from `last`
      build(survey);
    }
  }

  /** Draws the capture's survey. `survey` is cleanSurvey's answer; `blocked` is true while a prompt or a dialog shows; a pane that is not 'ok' takes the panel away. */
  function render(args) {
    last = args;
    step(args);
  }

  return { render, shown: () => visible, sendNote: () => (visible ? gateNote(F !== null ? F.survey : drawn !== null ? { state: 'terminal', reason: drawn } : null) : null) };
}
