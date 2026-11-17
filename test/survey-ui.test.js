// The page side of Claude's feedback survey and the transcript question (design F13 sections 2.5 to 2.7, with the F14 changes of the addendum;
// nika 0.5): public/survey-panel.js, with the fake DOM of test/fake-dom.js and a fake of session.js's io (the route answers are scripted).
// Every state has its own colour, icon and word; the capture's `survey` is cleaned to the contract shape or the page draws nothing; every route
// answer maps to a fixed line and the server's own text never shows; a click posts { n, sig } to the survey route and nothing else.
// Fixtures are synthetic (builder-1, %12, repeated hex).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  LABEL_MAX, TRANSCRIPT_LINE, cleanSurvey, surveyBody, surveyOutcome, announcement, gateNote, createSurveyPanel,
} from '../public/survey-panel.js';
import { installDom, El, focus, withClass } from './fake-dom.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ROOT = path.join(PUBLIC, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('public/survey-panel.js');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const DOTS = String.fromCharCode(0x2026);
const SIG = 'a1b2c3d4e5f60718';
const SIG2 = '0f1e2d3c4b5a6978';

// ---- fixtures: the capture's survey field (design 2.5 with the F14 `kind`) -------------------------------------------------------

const rating = (over = {}) => ({
  state: 'ready', kind: 'rating', sig: SIG,
  options: [{ n: 1, label: 'Bad' }, { n: 2, label: 'Fine' }, { n: 3, label: 'Good' }, { n: 0, label: 'Dismiss' }], ...over,
});
const consent = (over = {}) => ({ state: 'ready', kind: 'consent', sig: SIG2, options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], ...over });
const terminal = (reason = 'consent') => ({ state: 'terminal', reason });

const TERMINAL_LINES = {
  consent: "Claude asks whether Anthropic may look at this session's transcript. That is your call: answer it in the terminal.",
  bypass: 'This screen mentions bypass, so nika leaves the survey to you: answer it in the terminal.',
  input: "Claude's input box has text, so a number would land there. Answer the survey in the terminal.",
  normal: "Claude's input is in vim normal mode, where a number is a vim count. Answer the survey in the terminal.",
  unreadable: "Claude shows a feedback question nika can't read exactly. Answer it in the terminal.",
};

// design 2.6 "Responses": [status, code, problem line, buttons stay off until the sig changes, problem kind]
const GENERIC = "nika couldn't send that answer.";
const RESPONSES = [
  [409, 'survey-changed', 'The survey changed; check the session.', true, 'warn'],
  [409, 'no-survey', 'The survey is gone.', false, 'warn'],
  [409, 'busy-switching', 'Another action is running on this session.', false, 'warn'],
  [409, 'not-idle', 'Claude is busy; try again in a moment.', false, 'warn'],
  [409, 'prompt-open', 'Claude is asking something else first; answer that.', false, 'warn'],
  [409, 'input-not-empty', "Claude's input box has text, so a number would land there. Answer the survey in the terminal.", true, 'warn'],
  [409, 'text-mode', "Claude's input is in vim normal mode. Answer the survey in the terminal.", true, 'warn'],
  [409, 'not-taken', "Claude didn't take the answer. Check the terminal: the number may be in Claude's input box.", true, 'warn'],
  [400, 'terminal-only', 'Answer this survey in the terminal.', true, 'warn'],
  [400, 'invalid', GENERIC, true, 'warn'],
  [429, undefined, 'Too many keys at once; try again.', false, 'warn'],
  [404, undefined, 'The session is gone.', false, 'error'],
  [500, undefined, "nika couldn't reach tmux.", false, 'error'],
  [503, undefined, "nika couldn't reach tmux.", false, 'error'],
  [0, undefined, "nika couldn't reach tmux.", false, 'error'],
];

// ---- cleanSurvey ----------------------------------------------------------------------------------------------------------------

describe('cleanSurvey: the capture field as the page may use it', () => {
  test('(+) no survey is null (an older server has no field at all, so undefined too)', () => {
    assert.equal(cleanSurvey(null), null);
    assert.equal(cleanSurvey(undefined), null);
  });

  test('(+) both contract shapes come out as they went in: a rating, a consent question and every terminal reason', () => {
    assert.deepEqual(cleanSurvey(rating()), rating());
    assert.deepEqual(cleanSurvey(consent()), consent());
    for (const reason of Object.keys(TERMINAL_LINES)) assert.deepEqual(cleanSurvey(terminal(reason)), terminal(reason));
  });

  test("(+) the options keep Claude's order (the rating's Dismiss is last because the server sends it last); a consent question may offer one to four", () => {
    assert.deepEqual(cleanSurvey(rating()).options.map((o) => o.n), [1, 2, 3, 0]);
    assert.deepEqual(cleanSurvey(consent({ options: [{ n: 2, label: 'No' }, { n: 1, label: 'Yes' }] })).options.map((o) => o.n), [2, 1]);
    assert.equal(cleanSurvey(consent({ options: [{ n: 1, label: 'Yes' }] })).state, 'ready');
    assert.equal(cleanSurvey(consent({ options: [0, 1, 2, 3].map((n) => ({ n, label: `L${n}` })) })).state, 'ready');
  });

  test('(+) the result is a copy with only the contract keys; extra keys of the capture are dropped', () => {
    const raw = rating({ bypass: true, extra: 'x' });
    raw.options[0].description = 'nope';
    const c = cleanSurvey(raw);
    assert.deepEqual(Object.keys(c).sort(), ['kind', 'options', 'sig', 'state']);
    assert.deepEqual(Object.keys(c.options[0]).sort(), ['label', 'n']);
    raw.options[0].label = 'changed';
    assert.equal(c.options[0].label, 'Bad', 'the capture object is not kept');
    assert.deepEqual(Object.keys(cleanSurvey({ ...terminal('input'), options: [{ n: 1, label: 'x' }] })).sort(), ['reason', 'state']);
  });

  test('(+) a label loses control and bidi characters; a label of exactly the maximum length is fine', () => {
    const c = cleanSurvey(rating({ options: [{ n: 1, label: `Go${String.fromCharCode(0x202e)}od${String.fromCharCode(0)}` }, { n: 2, label: 'Fine' }, { n: 3, label: 'L'.repeat(LABEL_MAX) }, { n: 0, label: 'Dismiss' }] }));
    assert.equal(c.options[0].label, 'Good');
    assert.equal(c.options[2].label.length, LABEL_MAX);
    assert.equal(LABEL_MAX, 20);
  });

  test('(−) a sig that is not 16 lower-case hex digits is refused (no panel)', () => {
    for (const sig of ['', 'A1B2C3D4E5F60718', 'a1b2c3d4e5f6071', 'a1b2c3d4e5f607180', 'g1b2c3d4e5f60718', 'a1b2c3d4 5f60718', 12345678, null, undefined, ['a1b2c3d4e5f60718']]) {
      assert.equal(cleanSurvey(rating({ sig })), null, String(sig));
      assert.equal(cleanSurvey(consent({ sig })), null, String(sig));
    }
  });

  test('(−) an unknown or missing kind is refused', () => {
    for (const kind of ['menu', 'Rating', 'CONSENT', '', null, undefined, 1, ['rating'], 'transcript']) assert.equal(cleanSurvey(rating({ kind })), null, String(kind));
    const noKind = rating();
    delete noKind.kind;
    assert.equal(cleanSurvey(noKind), null, 'a ready survey with no kind (an older server) draws nothing');
  });

  test('(−) five options, none, or not a list are refused', () => {
    const five = [0, 1, 2, 3, 4].map((n) => ({ n, label: `L${n}` }));
    assert.equal(cleanSurvey(rating({ options: five })), null);
    assert.equal(cleanSurvey(consent({ options: five })), null);
    assert.equal(cleanSurvey(consent({ options: [...five.slice(0, 4), { n: 0, label: 'again' }] })), null);
    for (const options of [[], null, undefined, 'Bad', {}, 7]) {
      assert.equal(cleanSurvey(rating({ options })), null);
      assert.equal(cleanSurvey(consent({ options })), null);
    }
  });

  test('(−) an option number outside 0 to 3, not an integer, or used twice is refused', () => {
    for (const n of [4, -1, 9, 1.5, NaN, '3', '1', null, undefined, true, [1]]) {
      assert.equal(cleanSurvey(consent({ options: [{ n, label: 'Yes' }] })), null, String(n));
      assert.equal(cleanSurvey(rating({ options: [{ n: 1, label: 'Bad' }, { n: 2, label: 'Fine' }, { n: 3, label: 'Good' }, { n, label: 'Dismiss' }] })), null, String(n));
    }
    assert.equal(cleanSurvey(consent({ options: [{ n: 1, label: 'Yes' }, { n: 1, label: 'No' }] })), null, 'one number on two buttons');
  });

  test('(−) a label over 20 characters, a label that is not text, or one that is empty after cleaning is refused', () => {
    assert.equal(cleanSurvey(consent({ options: [{ n: 1, label: 'L'.repeat(LABEL_MAX + 1) }] })), null);
    assert.equal(cleanSurvey(rating({ options: [{ n: 1, label: 'x'.repeat(21) }, { n: 2, label: 'Fine' }, { n: 3, label: 'Good' }, { n: 0, label: 'Dismiss' }] })), null);
    for (const label of ['', ' ', String.fromCharCode(0), String.fromCharCode(0x202e), null, undefined, 3, ['Yes'], { t: 'Yes' }]) {
      assert.equal(cleanSurvey(consent({ options: [{ n: 1, label }] })), null, JSON.stringify(label));
    }
    assert.equal(cleanSurvey(consent({ options: [null] })), null);
    assert.equal(cleanSurvey(consent({ options: ['Yes'] })), null);
  });

  test('(−) a rating must be the four buttons 1, 2, 3 and 0; any other set is refused', () => {
    assert.equal(cleanSurvey(rating({ options: rating().options.slice(0, 3) })), null, 'no Dismiss');
    assert.equal(cleanSurvey(rating({ options: rating().options.slice(1) })), null, 'no Bad');
    assert.equal(cleanSurvey(rating({ options: [{ n: 1, label: 'Bad' }, { n: 2, label: 'Fine' }] })), null);
  });

  test('(−) an unknown reason, no reason, an unknown state, or a value that is not an object is refused', () => {
    for (const reason of ['whatever', 'Consent', '', null, undefined, 1, ['input'], 'terminal', 'layout', 'text']) assert.equal(cleanSurvey({ state: 'terminal', reason }), null, String(reason));
    for (const state of ['unreadable', 'ready ', 'READY', '', null, undefined]) assert.equal(cleanSurvey({ ...rating(), state }), null, String(state));
    for (const v of ['rating', 7, true, [], [rating()], () => rating()]) assert.equal(cleanSurvey(v), null);
  });

  test('(−) malformed input never throws', () => {
    for (const v of [{}, { state: 'ready' }, { state: 'ready', kind: 'rating' }, { state: 'ready', kind: 'rating', sig: SIG }, { state: 'ready', kind: 'rating', sig: SIG, options: [undefined] }, { state: 'terminal' }, Object.create(null), new Date()]) {
      assert.doesNotThrow(() => cleanSurvey(v));
      assert.equal(cleanSurvey(v), null);
    }
  });
});

// ---- surveyBody ---------------------------------------------------------------------------------------------------------------

describe('surveyBody: the one request body', () => {
  test('(+) exactly { n, sig }, for each option shown, 0 included', () => {
    const s = cleanSurvey(rating());
    for (const n of [0, 1, 2, 3]) {
      const body = surveyBody(s, n);
      assert.deepEqual(body, { n, sig: SIG });
      assert.deepEqual(Object.keys(body).sort(), ['n', 'sig']);
    }
    assert.deepEqual(surveyBody(cleanSurvey(consent()), 2), { n: 2, sig: SIG2 });
  });

  test('(−) a number the survey does not show, a non-integer, a string, a terminal state or no survey gives no body', () => {
    const s = cleanSurvey(rating());
    const c = cleanSurvey(consent());
    assert.equal(surveyBody(c, 3), null, 'consent shows only 1 and 2 here');
    assert.equal(surveyBody(c, 0), null);
    for (const n of [4, -1, 1.5, NaN, '3', null, undefined, true]) assert.equal(surveyBody(s, n), null, String(n));
    assert.equal(surveyBody(cleanSurvey(terminal('input')), 1), null);
    assert.equal(surveyBody(null, 1), null);
    assert.equal(surveyBody(undefined, 1), null);
    assert.equal(surveyBody({ state: 'ready', kind: 'menu', sig: SIG, options: [{ n: 1, label: 'x' }] }, 1), null, 'only cleanSurvey\'s shapes give a body');
  });
});

// ---- surveyOutcome ------------------------------------------------------------------------------------------------------------

describe('surveyOutcome: every route answer maps to a fixed line (design 2.6 "Responses")', () => {
  test('(+) 200 is answered with no problem line, and the buttons stay off until the panel leaves or the sig changes', () => {
    assert.deepEqual(surveyOutcome({ status: 200, code: undefined }), { ok: true, phase: 'sent', lock: true, message: '', kind: '', gone: false });
  });

  for (const [status, code, message, lock, kind] of RESPONSES) {
    test(`(+) ${status} ${code ?? '(no code)'}: "${message}", ${lock ? 'locked until the sig changes' : 'buttons back on'}, ${kind}`, () => {
      const out = surveyOutcome({ status, code });
      assert.equal(out.ok, false);
      assert.equal(out.message, message);
      assert.equal(out.lock, lock);
      assert.equal(out.kind, kind);
      assert.equal(out.phase, 'failed');
      assert.equal(out.gone, status === 404);
    });
  }

  test('(+) 409 already-answered has no problem line: it counts as answered and stays off until the sig changes', () => {
    assert.deepEqual(surveyOutcome({ status: 409, code: 'already-answered' }), { ok: false, phase: 'answered', lock: true, message: '', kind: '', gone: false });
  });

  test('(−) an unknown code, an unknown status, or a code on the wrong status gets the generic line and stays off (the key may have gone out)', () => {
    for (const [status, code] of [[409, 'whatever'], [409, undefined], [400, 'whatever'], [400, 'survey-changed'], [409, 'invalid'], [418, 'teapot'], [403, undefined], [401, 'no-survey'], [413, undefined], [200.5, undefined], [409, '__proto__'], [409, 'constructor']]) {
      const out = surveyOutcome({ status, code });
      assert.equal(out.message, GENERIC, `${status} ${code}`);
      assert.equal(out.lock, true, `${status} ${code}`);
      assert.equal(out.ok, false);
    }
    assert.equal(surveyOutcome({}).message, GENERIC);
    assert.equal(surveyOutcome().message, GENERIC);
  });

  test("(−) only the status and the code are read: the response's own text never comes out", () => {
    const out = surveyOutcome({ status: 409, code: 'not-taken', message: 'SERVER TEXT', error_description: 'SERVER TEXT', body: { message: 'SERVER TEXT' } });
    assert.ok(!JSON.stringify(out).includes('SERVER TEXT'));
    assert.ok(!JSON.stringify(surveyOutcome({ status: 500, code: 'SERVER TEXT' })).includes('SERVER TEXT'), 'a code is never shown either');
  });
});

// ---- the words ----------------------------------------------------------------------------------------------------------------

describe('announcement and the message-box note', () => {
  test('(+) a rating is announced as in design 2.6: the name, the question, the number of choices, the place', () => {
    assert.equal(announcement(cleanSurvey(rating()), { name: 'builder-1' }), 'builder-1: Claude asks for feedback. 4 choices above the message box.');
  });

  test("(+) a consent question says how many choices and what a yes shares; one choice is singular", () => {
    assert.equal(announcement(cleanSurvey(consent()), { name: 'builder-1' }), `builder-1: Claude asks for feedback. 2 choices above the message box. ${TRANSCRIPT_LINE}`);
    assert.equal(announcement(cleanSurvey(consent({ options: [{ n: 1, label: 'Yes' }] })), { name: 'builder-1' }), `builder-1: Claude asks for feedback. 1 choice above the message box. ${TRANSCRIPT_LINE}`);
  });

  test('(+) a terminal state is announced with its reason line', () => {
    for (const [reason, line] of Object.entries(TERMINAL_LINES)) assert.equal(announcement(cleanSurvey(terminal(reason)), { name: 'builder-1' }), `builder-1: ${line}`);
  });

  test('(+) the message-box note: ready says to answer or dismiss, a consent question to answer it, a terminal state gives its own line', () => {
    assert.equal(gateNote(cleanSurvey(rating())), "Answer Claude's feedback question above, or Dismiss it.");
    assert.equal(gateNote(cleanSurvey(consent())), "Answer Claude's feedback question above.");
    for (const [reason, line] of Object.entries(TERMINAL_LINES)) assert.equal(gateNote(cleanSurvey(terminal(reason))), line);
  });

  test('(−) no survey has no note and no announcement text to speak of', () => {
    assert.equal(gateNote(null), null);
    assert.equal(gateNote(undefined), null);
    assert.equal(announcement(null, { name: 'builder-1' }), '');
  });
});

// ---- the panel: harness -------------------------------------------------------------------------------------------------------

class TEl extends El {
  contains(node) {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
}

let current = null;
afterEach(() => { current?.(); current = null; });

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

/** A panel on a fake page. `reply(path, opts)` scripts the route answer (a value, or a promise to hold the request). */
function rig(opts = {}) {
  current?.();
  const restore = installDom({ createElement: (t) => new TEl(t), createElementNS: (ns, t) => new TEl(t) });
  // What the page sees as the focused element. A browser puts focus on BODY (null here) when the focused node leaves the document or sits in
  // something hidden; the fake DOM keeps the stale pointer, so the getter does that fixup: the node must hang from `page` through its parents'
  // child lists, with nothing hidden on the way.
  const attached = (el) => {
    let top = el;
    for (let n = el; n; n = n.parent) {
      if (n.hidden === true) return false;
      if (n.parent && !n.parent.kids.includes(n)) return false;
      top = n;
    }
    return top === page;
  };
  Object.defineProperty(globalThis.document, 'activeElement', { get: () => (focus.el !== null && attached(focus.el) ? focus.el : null), configurable: true });
  focus.el = null;
  current = restore;
  const page = new TEl('div');
  const root = new TEl('div');
  root.hidden = true;
  const box = new TEl('textarea');
  const other = new TEl('button'); // a control outside the panel: where focus is when the user has clicked elsewhere
  page.append(root, box, other);
  const log = { calls: [], announce: [], say: [], problem: [], gone: 0, boxFocus: 0 };
  const state = { reply: opts.reply ?? (() => ({ status: 200, body: { answered: 3 } })) };
  box.focus = () => { log.boxFocus += 1; focus.el = box; };
  const io = {
    root,
    paneId: '%12',
    path: (tail) => `/pane/${encodeURIComponent('%12')}/${tail}`,
    call: async (p, o = {}) => { log.calls.push({ path: p, method: o.method, json: o.json }); return state.reply(p, o); },
    announce: (m) => log.announce.push(m),
    say: (m) => log.say.push(m),
    clearProblem: () => log.problem.push(''),
    setGone: () => { log.gone += 1; },
    composer: () => box,
  };
  const panel = createSurveyPanel(io);
  const render = (survey, over = {}) => panel.render({ pane: 'ok', survey: survey === null ? null : cleanSurvey(survey), blocked: false, name: 'builder-1', ...over });
  return { panel, io, root, box, other, log, state, render };
}

const q = (root, cls) => root.all(withClass(cls));
const one = (root, cls) => q(root, cls)[0] ?? null;
const hrefs = (node) => node.all((n) => n.tag === 'use').map((n) => n.attrs.href);
const buttons = (root) => root.all((n) => n.tag === 'button');
const byN = (root, n) => buttons(root).find((b) => b.attrs['data-n'] === String(n)) ?? null;
const off = (el) => el.getAttribute('aria-disabled') === 'true';
const sent = (r) => r.log.calls.map((c) => c.json);
const alertRow = (root) => root.all((n) => n.attrs.role === 'alert')[0] ?? null;

// ---- the panel: the states ----------------------------------------------------------------------------------------------------

describe('the panel states (design 2.6): each has its own colour, icon and word', () => {
  test('(+) ready: the Feedback tag with the info icon, the question, four buttons in Claude\'s order with their digit and label, Dismiss last and plain', () => {
    const r = rig();
    r.render(rating());
    assert.equal(r.root.hidden, false);
    assert.equal(r.panel.shown(), true);
    assert.equal(r.root.attrs['data-s'], 'ready');
    const tag = one(r.root, 'dlg-kind');
    assert.equal(tag.attrs['data-k'], 'survey');
    assert.equal(tag.textContent, 'Feedback');
    assert.deepEqual(hrefs(tag), ['#i-info']);
    assert.equal(one(r.root, 'ask-reason').textContent, 'Claude asks');
    const qEl = r.root.all((n) => n.attrs.id === 'svy-q')[0];
    assert.equal(qEl.textContent, 'How is Claude doing this session? (optional)');
    assert.equal(r.root.attrs['aria-labelledby'], 'svy-q');
    const bs = buttons(r.root);
    assert.deepEqual(bs.map((b) => b.attrs['data-n']), ['1', '2', '3', '0']);
    assert.deepEqual(bs.map((b) => b.all((n) => n.tag === 'kbd')[0].textContent), ['1', '2', '3', '0']);
    assert.deepEqual(bs.map((b) => b.all((n) => withClass('svy-l')(n))[0].textContent), ['Bad', 'Fine', 'Good', 'Dismiss']);
    assert.ok(bs.every((b) => b.attrs.type === 'button'));
    assert.deepEqual(bs.map((b) => b.className), ['pbtn', 'pbtn', 'pbtn', 'pbtn esc'], 'Dismiss has the ghost look');
    assert.ok(bs.every((b) => !off(b)));
    assert.equal(r.log.calls.length, 0);
  });

  test('(+) every button is a Tab stop and a native button, so Enter and Space press it: no negative tabindex, no key handler of ours', () => {
    const r = rig();
    r.render(rating());
    for (const b of buttons(r.root)) {
      assert.equal(b.tag, 'button');
      assert.ok(b.attrs.tabindex === undefined || b.attrs.tabindex === '0', `tabindex ${b.attrs.tabindex}`);
      assert.deepEqual(Object.keys(b.listeners), ['click'], 'a click only: Enter and Space reach it through the browser');
    }
    assert.ok(!/addEventListener\(\s*['"]key/.test(code(SRC)) && !/\bon(keydown|keyup|keypress)\b/.test(code(SRC)));
  });

  test('(+) the panel appearing never moves focus and never presses anything', () => {
    const r = rig();
    r.render(rating());
    assert.equal(focus.el, null);
    assert.equal(r.log.boxFocus, 0);
    assert.equal(r.log.calls.length, 0);
  });

  test('(+) the polite line is said once when the survey appears, not again for the same sig, and again for another sig', () => {
    const r = rig();
    r.render(rating());
    assert.deepEqual(r.log.announce, ['builder-1: Claude asks for feedback. 4 choices above the message box.']);
    r.render(rating());
    r.render(rating());
    assert.equal(r.log.announce.length, 1);
    r.render(rating({ sig: SIG2 }));
    assert.equal(r.log.announce.length, 2);
  });

  test('(+) a consent question shows Claude\'s own labels in Claude\'s order and, always visible under its buttons, the transcript line; the tag word stays Feedback', () => {
    const r = rig();
    r.render(consent({ options: [{ n: 2, label: 'No' }, { n: 1, label: 'Yes' }] }));
    assert.deepEqual(buttons(r.root).map((b) => b.attrs['data-n']), ['2', '1']);
    assert.deepEqual(buttons(r.root).map((b) => b.all((n) => withClass('svy-l')(n))[0].textContent), ['No', 'Yes']);
    assert.ok(buttons(r.root).every((b) => b.className === 'pbtn'), 'no ghost look: 0 is not Dismiss here');
    const line = one(r.root, 'svy-line');
    assert.equal(line.textContent, "A yes shares this session's transcript with Anthropic.");
    assert.equal(TRANSCRIPT_LINE, "A yes shares this session's transcript with Anthropic.");
    assert.equal(line.hidden, false);
    assert.equal(r.root.all((n) => n.attrs.id === 'svy-q')[0].textContent, 'Can Anthropic look at your session transcript?');
    assert.equal(one(r.root, 'dlg-kind').textContent, 'Feedback');
    const order = r.root.all((n) => n === line || n.tag === 'button');
    assert.equal(order.at(-1), line, 'the line is below the buttons');
    assert.equal(r.log.announce.at(-1), `builder-1: Claude asks for feedback. 2 choices above the message box. ${TRANSCRIPT_LINE}`);
  });

  test('(+) a rating has no transcript line', () => {
    const r = rig();
    r.render(rating());
    assert.equal(one(r.root, 'svy-line'), null);
    assert.ok(!r.root.textContent.includes('transcript'));
  });

  test('(+) the hint under the buttons says each button presses its number and needs no Enter', () => {
    const r = rig();
    r.render(rating());
    assert.equal(one(r.root, 'ask-hint').textContent, 'Each button presses its number in the pane. Claude takes it at once; no Enter.');
  });

  test('(+) a click posts { n, sig } to the survey route, once, and nothing else; consent posts its own sig', async () => {
    const r = rig();
    r.render(rating());
    byN(r.root, 3).click();
    await settle();
    assert.deepEqual(r.log.calls, [{ path: `/pane/${encodeURIComponent('%12')}/survey`, method: 'POST', json: { n: 3, sig: SIG } }]);
    const c = rig();
    c.render(consent());
    byN(c.root, 2).click();
    await settle();
    assert.deepEqual(sent(c), [{ n: 2, sig: SIG2 }]);
  });

  test('(+) Dismiss posts n 0', async () => {
    const r = rig();
    r.render(rating());
    byN(r.root, 0).click();
    await settle();
    assert.deepEqual(sent(r), [{ n: 0, sig: SIG }]);
  });

  test('(+) sending: the pressed button is busy with a spinner and the word Sending, every button is off, and a second click sends nothing', async () => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const r = rig({ reply: () => hold });
    r.render(rating());
    const pressed = byN(r.root, 2);
    pressed.click();
    await settle();
    assert.equal(r.root.attrs['data-s'], 'sending');
    assert.equal(pressed.attrs['aria-busy'], 'true');
    assert.equal(pressed.all((n) => withClass('svy-l')(n))[0].textContent, `Sending${DOTS}`);
    assert.equal(pressed.all(withClass('spin'))[0].hidden, false);
    assert.ok(buttons(r.root).every(off));
    assert.ok(buttons(r.root).filter((b) => b !== pressed).every((b) => b.attrs['aria-busy'] === undefined));
    byN(r.root, 1).click();
    pressed.click();
    await settle();
    assert.equal(r.log.calls.length, 1, 'one request at a time');
    release({ status: 200, body: { answered: 2 } });
    await settle();
    assert.equal(pressed.attrs['aria-busy'], undefined);
    assert.equal(pressed.all((n) => withClass('svy-l')(n))[0].textContent, 'Fine', 'the label is back');
    assert.equal(pressed.all(withClass('spin'))[0].hidden, true);
  });

  test('(+) sent: an echo row with the check icon says what went where, the buttons stay off, the line goes to the echo region and the old problem line is cleared', async () => {
    const r = rig();
    r.render(rating());
    byN(r.root, 3).click();
    await settle();
    assert.equal(r.root.attrs['data-s'], 'sent');
    const echo = one(r.root, 'svy-st');
    assert.equal(echo.hidden, false);
    assert.equal(echo.textContent, 'Sent 3 (Good) to %12');
    assert.deepEqual(hrefs(echo), ['#i-check']);
    assert.equal(echo.attrs['data-k'], 'sent');
    assert.deepEqual(r.log.say, ['Sent 3 (Good) to %12']);
    assert.deepEqual(r.log.problem, ['']);
    assert.equal(alertRow(r.root)?.hidden ?? true, true, 'no problem line');
    assert.ok(buttons(r.root).every(off));
    byN(r.root, 2).click();
    await settle();
    assert.equal(r.log.calls.length, 1, 'answered once');
  });

  test('(+) sent stays across captures with the same sig (the nodes stay), and a new sig draws a fresh ready panel', async () => {
    const r = rig();
    r.render(rating());
    const b3 = byN(r.root, 3);
    b3.click();
    await settle();
    r.render(rating());
    assert.equal(byN(r.root, 3), b3, 'the same nodes');
    assert.equal(r.root.attrs['data-s'], 'sent');
    assert.ok(buttons(r.root).every(off));
    r.render(consent());
    assert.equal(r.root.attrs['data-s'], 'ready', 'the transcript question that follows is a new survey');
    assert.ok(buttons(r.root).every((b) => !off(b)));
    assert.equal(one(r.root, 'svy-st').hidden, true);
  });

  test('(+) a consent answer is echoed with Claude\'s label: "Sent 2 (No) to %12"', async () => {
    const r = rig();
    r.render(consent());
    byN(r.root, 2).click();
    await settle();
    assert.equal(one(r.root, 'svy-st').textContent, 'Sent 2 (No) to %12');
    assert.deepEqual(r.log.say, ['Sent 2 (No) to %12']);
  });

  test('(+) already-answered: no problem line, the check icon and the word Answered, buttons off until the sig changes', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'already-answered' } }) });
    r.render(rating());
    byN(r.root, 1).click();
    await settle();
    assert.equal(r.root.attrs['data-s'], 'answered');
    assert.equal(alertRow(r.root)?.hidden ?? true, true);
    const row = one(r.root, 'svy-st');
    assert.equal(row.hidden, false);
    assert.equal(row.textContent, 'Already answered');
    assert.deepEqual(hrefs(row), ['#i-check']);
    assert.ok(buttons(r.root).every(off));
    assert.deepEqual(r.log.say, [], 'nothing was sent by this page');
    r.render(rating({ sig: SIG2 }));
    assert.ok(buttons(r.root).every((b) => !off(b)));
  });

  for (const [status, code, message, lock, kind] of RESPONSES) {
    test(`(+) ${status} ${code ?? '(no code)'}: the problem line says "${message}" with the warn icon, buttons ${lock ? 'off until the sig changes' : 'back on'}`, async () => {
      const r = rig({ reply: () => ({ status, body: code ? { error: code, message: 'SERVER TEXT' } : { message: 'SERVER TEXT' } }) });
      r.render(rating());
      byN(r.root, 2).click();
      await settle();
      const row = alertRow(r.root);
      assert.ok(row, 'a problem line with role alert');
      assert.equal(row.hidden, false);
      assert.equal(row.textContent, message);
      assert.deepEqual(hrefs(row), ['#i-warn']);
      assert.equal(row.attrs['data-k'], kind);
      assert.equal(r.root.attrs['data-s'], 'error');
      assert.ok(!r.root.textContent.includes('SERVER TEXT'), "the server's text never shows");
      assert.equal(one(r.root, 'svy-st').hidden, true, 'no "Sent" echo');
      assert.deepEqual(r.log.say, [], 'no echo line for an answer that did not go through');
      assert.equal(r.log.gone, status === 404 ? 1 : 0);
      if (lock) {
        assert.ok(buttons(r.root).every(off));
        byN(r.root, 1).click();
        await settle();
        assert.equal(r.log.calls.length, 1, 'locked: nothing more is sent');
        r.render(rating());
        assert.ok(buttons(r.root).every(off), 'the same sig stays locked');
        r.render(rating({ sig: SIG2 }));
        assert.ok(buttons(r.root).every((b) => !off(b)), 'another sig');
        assert.equal(alertRow(r.root).hidden, true, 'the old problem is gone with the old survey');
      } else {
        assert.ok(buttons(r.root).every((b) => !off(b)));
        byN(r.root, 1).click();
        await settle();
        assert.equal(r.log.calls.length, 2, 'a retry goes out');
      }
    });
  }

  test('(+) an unknown code gets the generic line and locks the buttons', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'brand-new-code' } }) });
    r.render(rating());
    byN(r.root, 2).click();
    await settle();
    assert.equal(alertRow(r.root).textContent, GENERIC);
    assert.ok(buttons(r.root).every(off));
    assert.ok(!r.root.textContent.includes('brand-new-code'));
  });

  test('(+) a problem line after a retry that works is replaced by the echo', async () => {
    let n = 0;
    const r = rig({ reply: () => (++n === 1 ? { status: 409, body: { error: 'not-idle' } } : { status: 200, body: { answered: 2 } }) });
    r.render(rating());
    byN(r.root, 2).click();
    await settle();
    assert.equal(alertRow(r.root).hidden, false);
    byN(r.root, 2).click();
    await settle();
    assert.equal(alertRow(r.root).hidden, true);
    assert.equal(one(r.root, 'svy-st').textContent, 'Sent 2 (Fine) to %12');
    assert.equal(r.root.attrs['data-s'], 'sent');
  });

  test('(+) a survey that changes while a request is running is drawn when it ends', async () => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    const r = rig({ reply: () => hold });
    r.render(rating());
    byN(r.root, 1).click();
    await settle();
    r.render(consent());
    assert.equal(byN(r.root, 1).all((n) => withClass('svy-l')(n))[0].textContent, `Sending${DOTS}`, 'not redrawn mid-request');
    release({ status: 200, body: { answered: 1 } });
    await settle();
    assert.equal(r.root.attrs['data-s'], 'ready');
    assert.ok(one(r.root, 'svy-line'), 'the consent panel is up');
  });

  for (const [reason, line] of Object.entries(TERMINAL_LINES)) {
    test(`(+) terminal / ${reason}: the terminal icon and the words Terminal only, the reason line below, no buttons`, () => {
      const r = rig();
      r.render(terminal(reason));
      assert.equal(r.root.hidden, false);
      assert.equal(r.root.attrs['data-s'], 'terminal');
      const row = one(r.root, 'pbtn-off');
      assert.deepEqual(hrefs(row), ['#i-term']);
      assert.equal(row.textContent, 'Terminal only');
      assert.equal(one(r.root, 'svy-reason').textContent, line);
      assert.equal(one(r.root, 'dlg-kind').textContent, 'Feedback');
      assert.equal(buttons(r.root).length, 0);
      assert.equal(r.root.attrs['aria-label'], "Claude's feedback question");
      assert.equal(r.root.attrs['aria-labelledby'], undefined);
      assert.deepEqual(r.log.announce, [`builder-1: ${line}`]);
      assert.equal(focus.el, null);
    });
  }

  test('(+) a ready panel goes to terminal and back: the labels and the group name follow', () => {
    const r = rig();
    r.render(rating());
    r.render(terminal('input'));
    assert.equal(buttons(r.root).length, 0);
    r.render(rating());
    assert.equal(buttons(r.root).length, 4);
    assert.equal(r.root.attrs['aria-labelledby'], 'svy-q');
    assert.equal(r.root.attrs['aria-label'], undefined);
    assert.equal(r.root.attrs['data-s'], 'ready');
  });
});

describe('where the panel shows (design 2.6 "Placement")', () => {
  test('(+) it is hidden while a prompt or a dialog is up (the page hides it too, whatever the server sent), and comes back after', () => {
    const r = rig();
    r.render(rating());
    assert.equal(r.panel.shown(), true);
    r.render(rating(), { blocked: true });
    assert.equal(r.panel.shown(), false);
    assert.equal(r.root.hidden, true);
    assert.equal(r.root.kids.length, 0);
    assert.equal(r.panel.sendNote(), null);
    r.render(rating());
    assert.equal(r.panel.shown(), true);
  });

  test('(+) no survey, or a pane that is not ok, takes the panel away', () => {
    const r = rig();
    for (const pane of ['connecting', 'tmux', 'gone']) {
      r.render(rating());
      r.render(rating(), { pane });
      assert.equal(r.panel.shown(), false, pane);
      assert.equal(r.root.hidden, true);
    }
    r.render(rating());
    r.render(null);
    assert.equal(r.panel.shown(), false);
    assert.equal(r.root.hidden, true);
  });

  test('(+) an off-contract survey (cleanSurvey said null) draws nothing', () => {
    const r = rig();
    r.render({ state: 'ready', kind: 'menu', sig: SIG, options: [] });
    assert.equal(r.panel.shown(), false);
    assert.equal(r.root.hidden, true);
  });

  test('(+) when the panel leaves while a button had focus, focus goes to the message box; when it leaves untouched, focus stays where it is', () => {
    const r = rig();
    r.render(rating());
    focus.el = byN(r.root, 2);
    r.render(null);
    assert.equal(focus.el, r.box);
    assert.equal(r.log.boxFocus, 1);
    const s = rig();
    s.render(rating());
    focus.el = s.box;
    s.render(null);
    assert.equal(s.log.boxFocus, 0, 'focus was elsewhere');
  });

  test('(+) a new survey replacing a focused button puts focus on its question, so a held key answers nothing unseen', () => {
    const r = rig();
    r.render(rating());
    focus.el = byN(r.root, 2);
    r.render(consent());
    assert.equal(focus.el.attrs.id, 'svy-q');
  });

  test('(+) the message-box note follows the panel: a note while it shows, none when it is gone', () => {
    const r = rig();
    assert.equal(r.panel.sendNote(), null);
    r.render(rating());
    assert.equal(r.panel.sendNote(), "Answer Claude's feedback question above, or Dismiss it.");
    r.render(terminal('bypass'));
    assert.equal(r.panel.sendNote(), TERMINAL_LINES.bypass);
    r.render(null);
    assert.equal(r.panel.sendNote(), null);
  });

  test('(−) a terminal state offers no way to send: no button exists to click', async () => {
    const r = rig();
    for (const reason of Object.keys(TERMINAL_LINES)) {
      r.render(terminal(reason));
      for (const b of buttons(r.root)) b.click();
    }
    await settle();
    assert.equal(r.log.calls.length, 0);
  });

  test('(−) a blocked panel sends nothing even for a click on a button drawn before', async () => {
    const r = rig();
    r.render(rating());
    const b = byN(r.root, 1);
    r.render(rating(), { blocked: true });
    b.click();
    await settle();
    assert.equal(r.log.calls.length, 0);
  });
});

// ---- the page's markup, styles and wiring ---------------------------------------------------------------------------------------

// ---- focus when the panel redraws or leaves under a focused button (live check LC21, O1) --------------------------------------------
// LC21 trace after Tab to "0 Dismiss" and Enter: BUTTON at 3 ms, BODY at 510 ms with the panel still shown, hidden at 562 ms. The answer arrives
// (~500 ms) and draws the capture held back meanwhile, a half-erased survey, which the server reads as `terminal`; drawTerminal() replaced the
// focused button and nothing took its place, so the later leave() found focus on BODY, not inside the panel, and handed nothing over.

describe('focus after a keyboard Dismiss: a redraw or a hide under a focused button never leaves it on BODY (LC21 O1)', () => {
  const REASONS = Object.keys(TERMINAL_LINES);
  const active = () => globalThis.document.activeElement;
  const held = () => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    return { hold, release };
  };

  test('(+) the O1 trace: Tab to Dismiss, Enter, the answer arrives with Terminal only waiting: the panel redraws and focus is on the message box, not BODY; when the survey is gone it hides and focus stays there', async () => {
    const { hold, release } = held();
    const r = rig({ reply: () => hold });
    r.render(rating());
    const dismiss = byN(r.root, 0);
    focus.el = dismiss; // Tab
    dismiss.click(); // Enter on a native button is a click
    await settle();
    assert.equal(active(), dismiss, 'while the request runs the button keeps focus (aria-disabled does not take it away)');
    r.render(terminal('unreadable')); // Claude is half-way through erasing its survey
    assert.equal(r.root.attrs['data-s'], 'sending', 'held back until the request ends');
    assert.equal(active(), dismiss);
    release({ status: 200, body: { answered: 0 } });
    await settle();
    assert.equal(r.root.attrs['data-s'], 'terminal', 'redrawn: no button is left to hold focus');
    assert.equal(buttons(r.root).length, 0);
    assert.equal(r.root.hidden, false, 'the panel is still shown, as in the trace');
    assert.equal(active(), r.box, 'spec 9.5: focus that leaves the panel goes to the message box');
    assert.equal(r.log.boxFocus, 1);
    r.render(null); // the next capture: the survey is gone
    assert.equal(r.root.hidden, true);
    assert.equal(active(), r.box);
    assert.equal(r.log.boxFocus, 1, 'handed over once, not again at the hide');
  });

  for (const reason of REASONS) {
    test(`(+) a focused button and a capture that turns terminal / ${reason}: focus goes to the message box, once, and the same reason again does not move it`, () => {
      const r = rig();
      r.render(rating());
      focus.el = byN(r.root, 2);
      r.render(terminal(reason));
      assert.equal(buttons(r.root).length, 0);
      assert.equal(active(), r.box);
      assert.equal(r.log.boxFocus, 1);
      focus.el = r.other; // the user moves on
      r.render(terminal(reason));
      assert.equal(active(), r.other, 'the same terminal state is not drawn again, so it takes nothing');
      assert.equal(r.log.boxFocus, 1);
    });
  }

  test("(+) focus on the question itself (it took focus when a survey replaced a button) goes to the message box when the panel turns terminal", () => {
    const r = rig();
    r.render(rating());
    focus.el = byN(r.root, 2);
    r.render(consent());
    assert.equal(active().attrs.id, 'svy-q');
    r.render(terminal('consent'));
    assert.equal(active(), r.box);
    assert.equal(r.log.boxFocus, 1);
  });

  test('(−) focus is not moved when it was not in the panel: on another control, on BODY (a mouse press leaves a button unfocused in some browsers), or moved away while the request ran', async () => {
    for (const where of [(r) => r.other, () => null]) {
      const r = rig();
      r.render(rating());
      focus.el = where(r);
      r.render(terminal('unreadable'));
      assert.equal(r.root.attrs['data-s'], 'terminal');
      assert.equal(active(), where(r));
      r.render(null);
      assert.equal(active(), where(r));
      assert.equal(r.log.boxFocus, 0, 'the panel appearing, changing or leaving never takes focus from elsewhere');
    }
    const { hold, release } = held();
    const r = rig({ reply: () => hold });
    r.render(rating());
    focus.el = byN(r.root, 0);
    byN(r.root, 0).click();
    await settle();
    r.render(terminal('unreadable'));
    focus.el = r.other; // the user clicked into another control while the request ran
    release({ status: 200, body: { answered: 0 } });
    await settle();
    assert.equal(r.root.attrs['data-s'], 'terminal');
    assert.equal(active(), r.other);
    assert.equal(r.log.boxFocus, 0);
  });

  test('(−) no move while the panel stays and keeps a focusable button: the answer arrives, the same survey is still on screen, focus stays on Dismiss until the survey is gone', async () => {
    const { hold, release } = held();
    const r = rig({ reply: () => hold });
    r.render(rating());
    const dismiss = byN(r.root, 0);
    focus.el = dismiss;
    dismiss.click();
    await settle();
    release({ status: 200, body: { answered: 0 } });
    await settle();
    assert.equal(r.root.attrs['data-s'], 'sent');
    r.render(rating());
    r.render(rating());
    assert.equal(r.root.hidden, false);
    assert.equal(active(), dismiss);
    assert.equal(r.log.boxFocus, 0);
    r.render(null);
    assert.equal(active(), r.box, 'then the usual hand-over');
    assert.equal(r.log.boxFocus, 1);
  });

  test('(−) a new survey that replaces the focused button keeps focus in the panel, on its question, not in the message box', () => {
    const r = rig();
    r.render(rating());
    focus.el = byN(r.root, 2);
    r.render(consent());
    assert.equal(active().attrs.id, 'svy-q');
    assert.equal(r.log.boxFocus, 0);
  });
});

describe('constraint 6 and the wiring', () => {
  const HTML = read('public/session.html');
  const CSS = read('public/session.css');
  const SESSION = read('public/session.js');
  const SERVER = read('src/server.js');

  test('(−) no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or Function constructor, and no inline style or script, in the module', () => {
    const c = code(SRC);
    assert.doesNotMatch(c, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|\.style\b|setAttribute\(\s*['"]style/);
    assert.doesNotMatch(c, /<script|<style|javascript:/);
  });

  test('(+) the module is ASCII only (symbols are escapes), builds nothing at import, and is served on the static list next to dialog-form.js as JavaScript', () => {
    assert.ok([...SRC].every((ch) => ch.charCodeAt(0) < 128), 'ASCII');
    assert.match(SERVER, /\['\/survey-panel\.js', \['survey-panel\.js', 'text\/javascript; charset=utf-8'\]\]/);
    assert.ok(SERVER.indexOf("'/dialog-form.js'") < SERVER.indexOf("'/survey-panel.js'"));
    assert.ok(fs.existsSync(path.join(PUBLIC, 'survey-panel.js')));
    assert.doesNotMatch(code(SRC), /^(document|window|globalThis)\./m, 'nothing runs at import');
  });

  test('(−) the page presses no key and types no digit itself: the module only calls its own survey route, once per click, and never the keys or answer routes', () => {
    const c = code(SRC);
    assert.doesNotMatch(c, /['"`]keys['"`]|['"`]answer['"`]|['"`]dialog['"`]|sendKeys|send-keys/);
    assert.equal((c.match(/io\.call\(/g) ?? []).length, 1);
    assert.match(c, /io\.path\('survey'\)/);
  });

  test('(+) the markup: div.ask.svy#survey-panel, a group named by #svy-q, hidden, after the dialog form and before the attachment tray, with no inline style', () => {
    const m = HTML.match(/<div class="ask svy" id="survey-panel"[^>]*>/);
    assert.ok(m, 'the panel is in session.html');
    assert.match(m[0], /role="group"/);
    assert.match(m[0], /aria-labelledby="svy-q"/);
    assert.match(m[0], /\bhidden\b/);
    assert.doesNotMatch(m[0], /style=/);
    assert.ok(HTML.indexOf('id="dialog-form"') < HTML.indexOf('id="survey-panel"'));
    assert.ok(HTML.indexOf('id="survey-panel"') < HTML.indexOf('id="att-tray"'));
    assert.equal((HTML.match(/id="survey-panel"/g) ?? []).length, 1);
    assert.doesNotMatch(HTML, /<[^>]+\sstyle=/, 'still no inline style anywhere in the page');
    assert.doesNotMatch(HTML, /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/, 'still no inline script');
  });

  test('(+) session.js imports the module, builds the panel in boot beside the dialog form, feeds it the cleaned capture field, and gates the message box with its note', () => {
    assert.match(SESSION, /import \{ createSurveyPanel, cleanSurvey \} from '\.\/survey-panel\.js';/);
    assert.match(SESSION, /^let SV = null;/m);
    assert.match(SESSION, /SV = createSurveyPanel\(\{ root: \$\('survey-panel'\), paneId,/);
    assert.match(SESSION, /W\.survey = cleanSurvey\(body\.survey\);/);
    assert.match(SESSION, /SV\?\.render\(\{ pane: W\.pane, survey: W\.survey, blocked: W\.promptOpen \|\| A\.kind === 'attn', name: A\.name \}\);/);
    const gate = SESSION.slice(SESSION.indexOf('async function sendComposer()'));
    assert.ok(gate.indexOf('SV?.sendNote()') > 0 && gate.indexOf('SV?.sendNote()') < gate.indexOf('sendGate('), 'the survey note comes before the prompt gate, and nothing is sent');
    assert.match(gate.slice(gate.indexOf('SV?.sendNote()'), gate.indexOf('SV?.sendNote()') + 260), /showProblem\(note, 'error'\);\s*return;/);
  });

  test('(+) the styles: the Feedback tag colour, the panel look per state, the 2 x 2 wrap under a 560 px composer, tokens only', () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.dlg-kind\[data-k="survey"\]\s*\{\s*color:\s*var\(--accent\)/);
    assert.match(css, /\.ask\.svy\s*\{[^}]*background:\s*var\(--accent-soft\)[^}]*box-shadow:\s*inset 3px 0 0 var\(--accent\)/);
    for (const s of ['sent', 'answered', 'error', 'terminal']) assert.match(css, new RegExp(`\\.svy\\[data-s="${s}"\\]`), s);
    assert.match(css, /@container composer \(max-width: 560px\)\s*\{[^}]*\.svy-btns[^}]*grid-template-columns:\s*1fr 1fr/s);
    const mine = css.split('\n').filter((l) => /\.svy|survey/.test(l)).join('\n');
    assert.ok(mine.length > 200, 'rules were found');
    assert.doesNotMatch(mine, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/, 'no colour literal: tokens only');
  });

  test('(+) a pressed (busy) button stays readable while every button is off, and the spinner stops under reduced motion', () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.svy \.pbtn\[aria-busy="true"\]\s*\{[^}]*opacity:\s*1/);
    assert.match(css, /prefers-reduced-motion: reduce\)\s*\{[^}]*\.svy \.spin\s*\{\s*animation:\s*none/s);
  });
});

// ---- session.js: the hooks, run for real in a vm against stubs ----------------------------------------------------------------------

describe('session.js hooks (noteScreen, renderMode, sendComposer), run in a vm', () => {
  const SESSION = code(read('public/session.js'));
  const fnOf = (head) => {
    const at = SESSION.indexOf(head);
    assert.ok(at >= 0, head);
    return SESSION.slice(at, SESSION.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const norm = (v) => JSON.parse(JSON.stringify(v)); // objects built inside the vm have another Object.prototype

  const screenRig = () => {
    const W = { pane: 'connecting', got: false, mode: 'unknown', confirmed: true, prompt: null, promptOpen: false, dialog: null, survey: null, last: null, struck: new Set(), strikeAt: null };
    const ctx = {
      W, SW: { busy: null }, A: { name: 'builder-1' }, modeKey: (m) => m ?? 'unknown', cleanPrompt: () => null, cleanDialog: () => null, cleanSurvey,
      modeNote: () => ({ last: null, msg: '' }), announceMode() {}, renderMode() {},
    };
    return { W, note: mk(['function noteScreen(body)'], ctx).noteScreen };
  };

  test('(+) noteScreen keeps the capture\'s survey as cleanSurvey allows it: a rating, a consent question and a terminal state', () => {
    const r = screenRig();
    r.note({ mode: 'default', modeConfirmed: true, survey: rating() });
    assert.deepEqual(norm(r.W.survey), rating());
    r.note({ mode: 'default', modeConfirmed: true, survey: consent() });
    assert.deepEqual(norm(r.W.survey), consent());
    r.note({ mode: 'default', modeConfirmed: true, survey: terminal('input') });
    assert.deepEqual(norm(r.W.survey), terminal('input'));
  });

  test('(−) noteScreen: no field (an older server), null, or anything off the contract leaves W.survey null, so no panel and no gate', () => {
    const r = screenRig();
    for (const survey of [undefined, null, { state: 'ready', kind: 'menu', sig: SIG, options: [] }, 'rating', 7, rating({ sig: 'x' }), terminal('whatever')]) {
      r.note({ mode: 'default', modeConfirmed: true, survey: rating() });
      assert.notEqual(r.W.survey, null);
      r.note({ mode: 'default', modeConfirmed: true, survey });
      assert.equal(r.W.survey, null, JSON.stringify(survey));
    }
  });

  const modeRig = (over = {}) => {
    const calls = [];
    const W = { pane: 'ok', mode: 'default', confirmed: true, msg: null, promptOpen: false, survey: cleanSurvey(rating()), dialog: null, ...over.W };
    const ctx = {
      paneId: '%12', SW: { parts: [{}], busy: null }, W, A: { kind: 'idle', name: 'builder-1', attention: '', ...over.A }, switcherState: () => ({ reason: '' }),
      renderTag() {}, renderSegments() {}, renderWhy() {}, renderQuick() {}, renderAttn() {}, renderPrompt() {}, DF: null,
      SV: over.SV === undefined ? { render: (a) => calls.push(norm(a)) } : over.SV,
    };
    return { calls, W, render: mk(['function renderMode()'], ctx).renderMode };
  };

  test('(+) renderMode hands the panel the pane state, the cleaned survey, the agent\'s name and whether a prompt, a dialog or the attention note holds the slot', () => {
    const r = modeRig();
    r.render();
    assert.deepEqual(r.calls, [{ pane: 'ok', survey: rating(), blocked: false, name: 'builder-1' }]);
    const p = modeRig({ W: { promptOpen: true } });
    p.render();
    assert.equal(p.calls[0].blocked, true, 'a prompt or a dialog');
    const a = modeRig({ A: { kind: 'attn' } });
    a.render();
    assert.equal(a.calls[0].blocked, true, 'the attention note');
    const g = modeRig({ W: { pane: 'gone', survey: null } });
    g.render();
    assert.deepEqual(g.calls[0], { pane: 'gone', survey: null, blocked: false, name: 'builder-1' });
  });

  test('(−) renderMode before the panel exists (no pane, or boot not done) draws nothing and does not fail', () => {
    const r = modeRig({ SV: null });
    assert.doesNotThrow(() => r.render());
  });

  const NOTE = "Answer Claude's feedback question above, or Dismiss it.";
  const sendRig = (note) => {
    const log = { problems: [], gate: 0, jobs: 0 };
    const ta = { value: 'hello', disabled: false };
    const ctx = {
      sending: false, composer: () => ta, SV: note === undefined ? null : { sendNote: () => note },
      showProblem: (m, k) => log.problems.push([m, k]),
      sendGate: () => { log.gate += 1; throw new Error('past the survey gate'); },
      W: { promptOpen: false, prompt: null, pane: 'ok' }, A: { kind: 'idle' }, DF: null, hasAnswerButtons: () => false,
      enqueueJob: async () => { log.jobs += 1; return { ok: true }; },
    };
    return { log, ta, send: mk(['async function sendComposer()'], ctx).sendComposer };
  };

  test('(+) a survey note stops Send before anything else: the note shows as an error, nothing is sent, the text stays', async () => {
    const r = sendRig(NOTE);
    await r.send();
    assert.deepEqual(r.log.problems, [[NOTE, 'error']]);
    assert.equal(r.log.gate, 0, 'the prompt gate is not even asked');
    assert.equal(r.log.jobs, 0);
    assert.equal(r.ta.value, 'hello');
  });

  test('(+) a terminal survey\'s own line is the note', async () => {
    const r = sendRig(TERMINAL_LINES.input);
    await r.send();
    assert.deepEqual(r.log.problems, [[TERMINAL_LINES.input, 'error']]);
  });

  test('(−) no note (no panel, a hidden panel, or no SV yet) leaves Send to the gates it had: the prompt gate is reached', async () => {
    for (const note of [undefined, null, '']) {
      const r = sendRig(note);
      await assert.rejects(r.send(), /past the survey gate/);
      assert.equal(r.log.gate, 1);
      assert.deepEqual(r.log.problems, []);
    }
  });
});

// ---- colour: WCAG 2.2 AA with the existing tokens ------------------------------------------------------------------------------

describe('contrast (WCAG 2.2 AA, existing tokens only)', () => {
  const TOKENS = read('public/tokens.css');
  const blockAt = (opener) => {
    const at = TOKENS.indexOf(opener);
    assert.ok(at >= 0, `${opener} exists`);
    const open = TOKENS.indexOf('{', at);
    return TOKENS.slice(open + 1, TOKENS.indexOf('}', open));
  };
  const vars = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const light = vars(blockAt(':root {'));
  const THEME = { light, dark: { ...light, ...vars(blockAt(':root:not([data-theme="light"]) {')) }, darkPinned: { ...light, ...vars(blockAt(':root[data-theme="dark"] {')) } };
  const lin = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = (hex) => { const c = lin(hex); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  for (const [name, v] of Object.entries(THEME)) {
    test(`(+) ${name}: the text colours the panel uses are 4.5:1 on its accent-soft fill (ready, sending, sent, error) and on the terminal fill`, () => {
      for (const t of ['--text', '--text-muted', '--accent', '--idle', '--danger']) {
        assert.ok(ratio(v[t], v['--accent-soft']) >= 4.5, `${t} on --accent-soft: ${ratio(v[t], v['--accent-soft']).toFixed(2)}`);
      }
      for (const t of ['--text', '--text-muted']) {
        assert.ok(ratio(v[t], v['--surface-2']) >= 4.5, `${t} on --surface-2: ${ratio(v[t], v['--surface-2']).toFixed(2)}`);
      }
      assert.ok(ratio(v['--accent'], v['--surface']) >= 4.5, 'the pressed button text on its surface');
    });

    test(`(+) ${name}: the state edges (accent, idle, danger, the terminal grey) are 3:1 on the composer's surface and on the terminal fill`, () => {
      for (const edge of ['--accent', '--idle', '--danger', '--text-muted']) {
        for (const ground of ['--bg', '--surface', '--surface-2']) {
          assert.ok(ratio(v[edge], v[ground]) >= 3, `${edge} on ${ground}: ${ratio(v[edge], v[ground]).toFixed(2)}`);
        }
      }
    });
  }

  test('(+) the panel colours are names of tokens that exist in all three theme blocks', () => {
    const css = read('public/session.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const mine = css.split('\n').filter((l) => /\.svy|survey/.test(l)).join('\n');
    for (const [, tok] of mine.matchAll(/var\((--[a-z0-9-]+)\)/g)) for (const [name, v] of Object.entries(THEME)) assert.ok(v[tok], `${tok} in ${name}`);
  });
});
