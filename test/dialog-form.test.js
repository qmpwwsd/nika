// The page side of Claude's question dialogs and plan approvals (design W1 section 6; nika 0.5): public/dialog-form.js, with the fake DOM of
// test/fake-dom.js and a fake of session.js's io (the route answers are scripted, the clock never runs by itself). Every state has its chip word
// and icon; the capture's dialog is cleaned to the contract shape or fails closed; every route answer maps to a fixed line and the server's own
// text never shows. Fixtures are synthetic (builder-1, %12, repeated hex).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  READING_MS, TEXT_MAX, cleanDialog, answerBody, dialogOutcome, announcement, stepText, createDialogForm, typable, wellFormed,
} from '../public/dialog-form.js';
import { installDom, El, focus, withClass } from './fake-dom.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dialog-form.js'), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const DOTS = String.fromCharCode(0x2026);
const MID = String.fromCharCode(0xb7);
const SIG = 'a1b2c3d4e5f60718';
const SIG2 = '0f1e2d3c4b5a6978';
const SIG3 = '1122334455667788';

// ---- fixtures: the capture's dialog field (design W1 section 3) ------------------------------------------------------------------

const tabs = (n, answered = 0) => ['Tools', 'Project', 'Scope', 'Notes'].slice(0, n).map((header, i) => ({ header, answered: i < answered }));
const head = { state: 'ready', kind: 'ask', sig: SIG, bypass: false };
const ask = (over = {}) => ({
  ...head, at: 'question', tabs: tabs(1), current: 0, final: true, question: 'Which database should I use?', multi: false, other: true,
  options: [{ n: 1, label: 'sqlite', description: 'Embedded, one file.' }, { n: 2, label: 'postgres', description: null }], ...over,
});
const multi = (over = {}) => ask({
  tabs: tabs(4), current: 0, final: false, question: 'Which checks should I run?', multi: true, other: false,
  options: [{ n: 1, label: 'lint', description: 'Run the linter.', checked: false }, { n: 2, label: 'build', description: 'Build the project.', checked: true }, { n: 3, label: 'test', description: null, checked: false }],
  ...over,
});
const review = (over = {}) => ({
  ...head, sig: SIG2, at: 'review', tabs: tabs(2, 2), warn: false,
  pairs: [{ question: 'Which checks should I run?', answer: 'lint, build' }, { question: 'Which database should I use?', answer: 'sqlite' }], ...over,
});
const plan = (over = {}) => ({
  ...head, kind: 'plan', sig: SIG3, at: 'plan',
  options: [{ n: 1, label: 'Yes, and use auto mode', text: false }, { n: 2, label: 'Yes, manually approve edits', text: false }, { n: 3, label: 'Tell Claude what to change', text: true }], ...over,
});
const unreadable = (over = {}) => ({ state: 'unreadable', kind: 'ask', reason: 'wide', ...over });

// ---- cleanDialog ----------------------------------------------------------------------------------------------------------------

describe('cleanDialog: the capture field as the page may use it', () => {
  test('(+) a question option numbered 7 is fine, and a plan keeps its numbers up to 9 (the route takes a choice from 1 to 9)', () => {
    assert.equal(cleanDialog(ask({ options: [{ n: 7, label: 'a', description: null }] })).state, 'ready');
    assert.equal(cleanDialog(plan({ options: [{ n: 9, label: 'a', text: false }] })).state, 'ready');
  });

  test('(+) no dialog is null; the three ready shapes and the unreadable one come out as the contract says', () => {
    assert.equal(cleanDialog(null), null);
    assert.equal(cleanDialog(undefined), null, 'an older server has no field at all');
    assert.deepEqual(cleanDialog(unreadable()), { state: 'unreadable', kind: 'ask', reason: 'wide' });
    const q = cleanDialog(ask());
    assert.equal(q.state, 'ready');
    assert.equal(q.at, 'question');
    assert.equal(q.sig, SIG);
    assert.deepEqual(q.options.map((o) => [o.n, o.label, o.description, o.checked]), [[1, 'sqlite', 'Embedded, one file.', false], [2, 'postgres', null, false]]);
    assert.deepEqual(cleanDialog(multi()).options.map((o) => o.checked), [false, true, false], 'Claude\'s ticks come through');
    assert.deepEqual(cleanDialog(review()).pairs, review().pairs);
    assert.deepEqual(cleanDialog(plan()).options.map((o) => [o.n, o.text]), [[1, false], [2, false], [3, true]]);
  });

  test('(+) strings lose control and bidi characters and are cut at the contract maxima; the result is a copy', () => {
    const raw = ask({ question: `Which${String.fromCharCode(0x202e)} one${String.fromCharCode(0)}?`.padEnd(900, 'x'), options: [{ n: 1, label: 'L'.repeat(300), description: 'D'.repeat(900) }, { n: 2, label: 'b', description: null }], tabs: [{ header: 'H'.repeat(80), answered: false }] });
    const c = cleanDialog(raw);
    assert.equal(c.question.length, 500);
    assert.ok(!c.question.includes(String.fromCharCode(0x202e)) && !c.question.includes(String.fromCharCode(0)));
    assert.equal(c.options[0].label.length, 200);
    assert.equal(c.options[0].description.length, 500);
    assert.equal(c.tabs[0].header.length, 40);
    raw.options[1].label = 'changed';
    assert.equal(c.options[1].label, 'b', 'the capture object is not kept');
  });

  test('(+) bypass is true only for the boolean true; an unknown reason becomes layout; an unknown kind becomes null', () => {
    assert.equal(cleanDialog(ask({ bypass: 'yes' })).bypass, false);
    assert.equal(cleanDialog(ask({ bypass: true })).bypass, true);
    assert.equal(cleanDialog(unreadable({ reason: 'whatever' })).reason, 'layout');
    assert.equal(cleanDialog(unreadable({ kind: 'menu' })).kind, null);
  });

  test('(−) anything that is not exactly the contract fails closed to unreadable, never to a form and never to null', () => {
    const fail = (v, why) => {
      const c = cleanDialog(v);
      assert.equal(c?.state, 'unreadable', why);
      assert.equal(c.reason, 'layout', why);
    };
    fail('dialog', 'a string');
    fail(7, 'a number');
    fail([], 'an array');
    fail({}, 'no state');
    fail(ask({ sig: 'xyz' }), 'a bad sig');
    fail(ask({ sig: undefined }), 'no sig');
    fail(ask({ at: 'tab' }), 'an unknown step');
    fail(ask({ kind: 'plan' }), 'kind and step disagree');
    fail(plan({ kind: 'ask' }), 'kind and step disagree, the other way');
    fail(ask({ options: 'x' }), 'options not a list');
    fail(ask({ options: [] }), 'no option');
    fail(ask({ options: [{ n: 0, label: 'a', description: null }] }), 'option number 0');
    fail(ask({ options: [{ n: 10, label: 'a', description: null }] }), 'option number 10');
    fail(ask({ options: [{ n: 8, label: 'a', description: null }] }), 'a question option above 7: the route takes picks 1 to 7 only');
    fail(multi({ options: [{ n: 9, label: 'a', description: null, checked: false }] }), 'the same for a multi-select');
    fail(ask({ options: [{ n: 1, label: 'a', description: null }, { n: 1, label: 'b', description: null }] }), 'a number twice');
    fail(ask({ options: [{ n: 1, label: 7, description: null }] }), 'a label that is not text');
    fail(ask({ options: [{ n: 1, label: 'a', description: 5 }] }), 'a description that is neither text nor null');
    fail(ask({ tabs: [] }), 'no tab');
    fail(ask({ tabs: tabs(1), current: 3 }), 'a current tab that does not exist');
    fail(ask({ tabs: Array.from({ length: 9 }, (_, i) => ({ header: `t${i}`, answered: false })) }), 'nine tabs');
    fail(ask({ question: 5 }), 'a question that is not text');
    fail(review({ pairs: 'x' }), 'pairs not a list');
    fail(review({ pairs: [{ question: 'q' }] }), 'a pair without an answer');
    fail(plan({ options: [] }), 'no plan option');
    fail(plan({ options: [{ n: 1, label: 'a' }] }), 'a plan option without the text flag');
  });
});

// ---- answerBody -----------------------------------------------------------------------------------------------------------------

describe('answerBody: the one request body for what the form holds (design W1 section 4.1)', () => {
  const single = cleanDialog(ask());
  const multiD = cleanDialog(multi());
  const multiOther = cleanDialog(multi({ other: true }));

  test('(+) single-select: one pick, or Other text with no pick', () => {
    assert.deepEqual(answerBody(single, { picks: [2] }), { sig: SIG, picks: [2] });
    assert.deepEqual(answerBody(single, { picks: [], text: '  my own  ' }), { sig: SIG, picks: [], text: 'my own' }, 'trimmed, as the route insists');
  });

  test('(+) multi: sorted distinct picks; text only where the capture allows Other', () => {
    assert.deepEqual(answerBody(multiD, { picks: [3, 1, 3] }), { sig: SIG, picks: [1, 3] });
    assert.deepEqual(answerBody(multiOther, { picks: [2], text: 'also e2e' }), { sig: SIG, picks: [2], text: 'also e2e' });
    assert.deepEqual(answerBody(multiOther, { picks: [], text: 'only this' }), { sig: SIG, picks: [], text: 'only this' });
  });

  test('(+) review, plan and decline', () => {
    assert.deepEqual(answerBody(cleanDialog(review()), { submit: true }), { sig: SIG2, submit: true });
    assert.deepEqual(answerBody(cleanDialog(plan()), { choice: 2 }), { sig: SIG3, choice: 2 });
    for (const d of [single, multiD, cleanDialog(review()), cleanDialog(plan())]) assert.deepEqual(answerBody(d, { cancel: true }), { sig: d.sig, cancel: true });
  });

  test('(−) nothing to send gives null: no pick, empty or blank text, text and a pick together in single-select', () => {
    assert.equal(answerBody(single, { picks: [] }), null);
    assert.equal(answerBody(single, { picks: [], text: '   ' }), null);
    assert.equal(answerBody(single, { picks: [1], text: 'x' }), null, 'one or the other');
    assert.equal(answerBody(multiD, { picks: [] }), null);
  });

  test('(−) text where Other is off, over the limit, or with a control character gives null', () => {
    assert.equal(answerBody(multiD, { picks: [1], text: 'x' }), null, 'other is false on this capture');
    assert.equal(answerBody(single, { picks: [], text: 'x'.repeat(TEXT_MAX + 1) }), null);
    assert.notEqual(answerBody(single, { picks: [], text: 'x'.repeat(TEXT_MAX) }), null);
    assert.equal(answerBody(single, { picks: [], text: `a${String.fromCharCode(9)}b` }), null);
    assert.equal(answerBody(single, { picks: [], text: `a${String.fromCharCode(0x85)}b` }), null);
  });

  test('(−) a pick that is not an option, a plan choice that is not a button, and a step that does not fit all give null', () => {
    assert.equal(answerBody(single, { picks: [5] }), null);
    assert.equal(answerBody(cleanDialog(plan()), { choice: 3 }), null, 'the text option is terminal only in 0.5');
    assert.equal(answerBody(cleanDialog(plan()), { choice: 9 }), null);
    assert.equal(answerBody(cleanDialog(plan()), { picks: [1] }), null);
    assert.equal(answerBody(cleanDialog(review()), { picks: [1] }), null);
    assert.equal(answerBody(single, { submit: true }), null);
    assert.equal(answerBody(null, { cancel: true }), null);
  });
});

// ---- free text: the route's rule, on the page -----------------------------------------------------------------------------------

describe('free text: the page refuses what the route refuses, so the user never sees a 400 for a character (route rule: 1 to 300 UTF-16 units, no control, zero-width, bidi, U+2028/9 or lone surrogate, nothing at either end)', () => {
  const single = cleanDialog(ask());
  const chr = (...c) => String.fromCharCode(...c);
  const REFUSED = [0x0, 0x1f, 0x7f, 0x85, 0x9f, 0x61c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202d, 0x202e, 0x2066, 0x2069];
  const PAIR = chr(0xd83d, 0xde00); // one astral character, two UTF-16 units

  test('(−) every refused code point inside the text gives null from answerBody (the route would answer 400 invalid)', () => {
    for (const c of REFUSED) assert.equal(answerBody(single, { picks: [], text: `a${chr(c)}b` }), null, `U+${c.toString(16)}`);
  });

  test('(−) a lone high or lone low surrogate gives null; a whole pair does not', () => {
    for (const bad of [`a${chr(0xd83d)}b`, `a${chr(0xde00)}b`, `${chr(0xde00)}${chr(0xd83d)}`, `ab${chr(0xd83d)}`]) assert.equal(answerBody(single, { picks: [], text: bad }), null);
    assert.deepEqual(answerBody(single, { picks: [], text: `ok ${PAIR}` }), { sig: SIG, picks: [], text: `ok ${PAIR}` });
  });

  test('(+) the limit counts UTF-16 units, as the route does: 150 astral characters are 300 units and fit, 151 do not', () => {
    assert.notEqual(answerBody(single, { picks: [], text: PAIR.repeat(150) }), null);
    assert.equal(answerBody(single, { picks: [], text: PAIR.repeat(151) }), null);
    assert.equal(answerBody(single, { picks: [], text: `${'x'.repeat(299)}${PAIR}` }), null);
  });

  test('(+) trimmed, not refused: a space of any kind at either end is cut before the body is made, so the route never sees one', () => {
    for (const sp of [' ', chr(0xa0), chr(0x3000), chr(0xfeff)]) {
      assert.deepEqual(answerBody(single, { picks: [], text: `${sp}${sp}mine${sp}` }), { sig: SIG, picks: [], text: 'mine' });
    }
    assert.equal(answerBody(single, { picks: [], text: chr(0xa0) }), null, 'only spaces is nothing to send');
  });

  test('(+) typable removes exactly what the route refuses and keeps the rest', () => {
    for (const c of REFUSED) assert.equal(typable(`a${chr(c)}b`), 'ab', `U+${c.toString(16)}`);
    assert.equal(typable(`caf${chr(0xe9)} ${PAIR} ok`), `caf${chr(0xe9)} ${PAIR} ok`, 'letters, a space and a whole pair stay');
    assert.equal(typable(`a${chr(0xd83d)}b${chr(0xde00)}c`), 'abc', 'lone surrogates go');
    assert.equal(typable(`${PAIR}${chr(0xd83d)}`), PAIR, 'a pair cut in half at the end leaves the whole one');
    assert.equal(typable(''), '');
  });

  test('(+) wellFormed is false only for a lone surrogate', () => {
    assert.equal(wellFormed(`x${PAIR}y`), true);
    assert.equal(wellFormed(''), true);
    assert.equal(wellFormed(chr(0xd83d)), false);
    assert.equal(wellFormed(chr(0xde00)), false);
    assert.equal(wellFormed(`${chr(0xde00)}${chr(0xd83d)}`), false);
  });

  test('(+) pasted into Other: zero-width, bidi, U+2028/9 and controls are dropped, so the box shows what will be sent', () => {
    const r = rig();
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    text.value = `a${chr(0x200b)}b${chr(0x202e)}c${chr(0x2028)}d${chr(0x2066)}e${chr(0x61c)}f`;
    text.fire('input');
    assert.equal(text.value, 'abcdef');
    assert.equal(one(r.root, 'dlg-count').hidden, true);
  });

  test('(+) a paste cut by the 300 limit in the middle of an astral character loses the half: no lone surrogate is ever sent', async () => {
    const r = rig();
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    text.value = `${'x'.repeat(299)}${chr(0xd83d)}`; // what maxlength leaves of a longer paste
    text.fire('input');
    assert.equal(text.value, 'x'.repeat(299));
    assert.equal(one(r.root, 'dlg-count').textContent, '299/300');
    byText(r.root, 'Send answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [], text: 'x'.repeat(299) }]);
  });

  test('(−) only invisible characters pasted is nothing: Other stays unticked and Send stays off', () => {
    const r = rig();
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    text.value = `${chr(0x200b)}${chr(0x200f)}${chr(0x2029)}`;
    text.fire('input');
    assert.equal(text.value, '');
    assert.equal(inputs(r.root, 'radio').at(-1).checked, false);
    assert.equal(off(byText(r.root, 'Send answer')), true);
  });

  test('(−) the source holds no raw refused character: the ranges are built from code points (the file stays ASCII)', () => {
    assert.equal([...SRC].every((ch) => ch.codePointAt(0) < 128), true);
    assert.match(code(SRC), /0x200b/);
    assert.match(code(SRC), /0x2028/);
  });
});

// ---- dialogOutcome --------------------------------------------------------------------------------------------------------------

describe('dialogOutcome: every route answer is a fixed line (design W1 section 6.4)', () => {
  const o = (status, code, extra = {}) => dialogOutcome({ status, code, name: 'builder-1', ...extra });
  const ROWS = [
    [409, 'no-dialog', 'The question is gone.', false],
    [409, 'dialog-changed', 'The question changed; check the session.', true],
    [409, 'dialog-touched', 'This question was changed in the terminal. Finish it there.', true],
    [409, 'dialog-focus', "Claude's selection was moved in the terminal. Finish it there.", true],
    [409, 'text-mode', "nika can't type your answer: Claude's text field isn't ready for typing. Type it in the terminal.", true],
    [409, 'text-mismatch', "Your answer didn't arrive exactly as typed, so nika stopped before sending it. Fix it in the terminal.", true],
    [409, 'not-taken', "Claude didn't take the key. Check the session, then try again.", false],
    [409, 'already-answered', '', true],
    [409, 'busy-switching', 'Another action is running on this session.', false],
    [409, 'not-idle', "nika is stopping Claude's turn; try again in a moment.", false],
    [400, 'terminal-only', 'Answer this in the terminal.', true],
    [400, 'invalid', "nika couldn't send this answer. Check it and try again.", false],
    [429, undefined, 'Too many keys at once; try again.', false],
    [404, 'not_found', 'The session is gone.', false],
    [500, undefined, "nika couldn't reach tmux.", false],
    [502, 'tmux', "nika couldn't reach tmux.", false],
    [0, undefined, "nika couldn't reach tmux.", false],
  ];
  for (const [status, code, message, lock] of ROWS) {
    test(`(+) ${status} ${code ?? '(no code)'}: ${message || 'no line'}; ${lock ? 'locked' : 'the form is live again'}`, () => {
      const r = o(status, code);
      assert.equal(r.ok, false);
      assert.equal(r.message, message);
      assert.equal(r.lock, lock);
    });
  }

  test('(+) a 404 also says the pane is gone; the other answers do not', () => {
    assert.equal(o(404, 'not_found').gone, true);
    assert.equal(o(409, 'no-dialog').gone, false);
  });

  test('(+) the line is a warning for what a retry or a look can fix, an error for a gone pane or tmux', () => {
    assert.equal(o(409, 'not-taken').kind, 'warn');
    assert.equal(o(404, 'not_found').kind, 'error');
    assert.equal(o(500).kind, 'error');
    assert.equal(o(0).kind, 'error');
  });

  test('(+) keys pressed before it stopped are named after the line, singular and plural', () => {
    assert.equal(o(409, 'text-mismatch', { sent: 3 }).message, `${ROWS[5][2]} nika had pressed 3 keys in the pane before it stopped.`);
    assert.equal(o(409, 'not-taken', { sent: 1 }).message, `${ROWS[6][2]} nika had pressed 1 key in the pane before it stopped.`);
    assert.equal(o(409, 'not-taken', { sent: 0 }).message, ROWS[6][2]);
  });

  test('(+) 200: the chip word and the announcement for each end of a step', () => {
    const w = (done) => { const r = o(200, undefined, { done }); return [r.ok, r.lock, r.word, r.announce]; };
    assert.deepEqual(w('next'), [true, true, 'Answered', 'Answered.']);
    assert.deepEqual(w('review'), [true, true, 'Answered', 'Answered.']);
    assert.deepEqual(w('submitted'), [true, true, 'Submitted', "Submitted builder-1's answers."]);
    assert.deepEqual(w('chosen'), [true, true, 'Answered', 'Sent your choice to builder-1.']);
    assert.deepEqual(w('declined'), [true, true, 'Declined', 'Declined.']);
    assert.deepEqual(w('nonsense'), [true, true, 'Answered', 'Answered.'], 'an unknown end is still an answered step');
    assert.equal(o(200, undefined, { done: 'next' }).message, '');
  });

  test('(−) the server\'s own text never shows: an unknown code gets the generic line, the response body is not an input', () => {
    assert.equal(o(409, 'something-new').message, "nika couldn't send this answer. Check it and try again.");
    assert.equal(o(409, 'something-new').lock, false);
    assert.equal(o(418).message, "nika couldn't send this answer. Check it and try again.");
    assert.doesNotMatch(code(SRC), /\.message\b[^;\n]*\bbody\b|body\??\.message/);
  });
});

// ---- the small pure helpers -----------------------------------------------------------------------------------------------------

describe('stepText and announcement: the words', () => {
  test('(+) the narrow strip text and the review word', () => {
    assert.equal(stepText(cleanDialog(multi({ current: 1 }))), `Question 2 of 4 ${MID} Project`);
    assert.equal(stepText(cleanDialog(review())), 'Review');
  });

  test('(+) a question is announced with its place; later tabs by number; a single question without a count', () => {
    const q = cleanDialog(multi());
    assert.equal(announcement(q, { name: 'builder-1', first: true }), 'builder-1 asks: Which checks should I run? Question 1 of 4, above the message box.');
    assert.equal(announcement(cleanDialog(multi({ current: 1, question: 'Which scope?' })), { name: 'builder-1', first: false }), 'Question 2 of 4: Which scope?');
    assert.equal(announcement(cleanDialog(ask()), { name: 'builder-1', first: true }), 'builder-1 asks: Which database should I use? Above the message box.');
  });

  test('(+) the review and the plan', () => {
    assert.equal(announcement(cleanDialog(review()), { name: 'builder-1', first: false }), 'Review your answers: 2 answers, above the message box.');
    assert.equal(announcement(cleanDialog(review({ pairs: [{ question: 'q', answer: 'a' }] })), { name: 'builder-1', first: true }), 'Review your answers: 1 answer, above the message box.');
    assert.equal(announcement(cleanDialog(plan()), { name: 'builder-1', first: true }), 'builder-1 asks you to approve a plan. Read it in the terminal view; choices above the message box.');
  });

  test('(+) a step that mentions bypass is announced as terminal only, not as buttons above the box', () => {
    const t = announcement(cleanDialog(ask({ bypass: true })), { name: 'builder-1', first: true });
    assert.match(t, /^builder-1 asks: Which database should I use\? This mentions bypass, so nika leaves it to you: answer it in the terminal\.$/);
    assert.doesNotMatch(announcement(cleanDialog(plan({ bypass: true })), { name: 'builder-1', first: true }), /above the message box/);
  });
});

// ---- the form: harness ----------------------------------------------------------------------------------------------------------

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

/** A form on a fake page. `reply(path, opts)` scripts the route answer (a value, or a promise to hold the request). */
function rig(opts = {}) {
  current?.();
  const restore = installDom({ createElement: (t) => new TEl(t), createElementNS: (ns, t) => new TEl(t) });
  Object.defineProperty(globalThis.document, 'activeElement', { get: () => focus.el, configurable: true });
  focus.el = null;
  current = restore;
  const root = new TEl('div');
  root.hidden = true;
  const box = new TEl('textarea');
  const log = { calls: [], announce: [], say: [], problem: [], gone: 0, refresh: 0, boxFocus: 0 };
  const timers = [];
  const clock = { t: 1000 };
  const state = { reply: opts.reply ?? (() => ({ status: 200, body: { done: 'next', sent: 1 } })) };
  box.focus = () => { log.boxFocus += 1; focus.el = box; };
  const io = {
    root,
    paneId: '%12',
    path: (tail) => `/pane/${encodeURIComponent('%12')}/${tail}`,
    call: async (p, o = {}) => { log.calls.push({ path: p, method: o.method, json: o.json }); return state.reply(p, o); },
    announce: (m) => log.announce.push(m),
    say: (m) => log.say.push(m),
    showProblem: (m, kind) => log.problem.push([m, kind]),
    clearProblem: () => log.problem.push(['']),
    setGone: () => { log.gone += 1; },
    composer: () => box,
    refresh: () => { log.refresh += 1; },
    now: () => clock.t,
    after: (fn, ms) => { timers.push({ fn, at: clock.t + ms, live: true }); return timers.length - 1; },
    cancel: (id) => { if (timers[id]) timers[id].live = false; },
  };
  const df = createDialogForm(io);
  const render = (dialog, over = {}) => df.render({ pane: 'ok', dialog: dialog === null ? null : cleanDialog(dialog), name: 'builder-1', attention: 'Claude has a question', ...over });
  const advance = (ms) => {
    clock.t += ms;
    for (const t of timers) if (t.live && t.at <= clock.t) { t.live = false; t.fn(); }
  };
  return { df, io, root, box, log, state, render, advance, clock, timers };
}

const q = (root, cls) => root.all(withClass(cls));
const one = (root, cls) => q(root, cls)[0] ?? null;
const hrefs = (node) => node.all((n) => n.tag === 'use').map((n) => n.attrs.href);
const chip = (root) => root.all((n) => withClass('dlg-chip')(n) || withClass('pill')(n))[0];
const buttons = (root) => root.all((n) => n.tag === 'button');
const byText = (root, text) => buttons(root).find((b) => b.textContent === text) ?? null;
const inputs = (root, type) => root.all((n) => n.tag === 'input' && n.attrs.type === type);
const off = (el) => el.getAttribute('aria-disabled') === 'true';
const sentBodies = (r) => r.log.calls.map((c) => c.json);

// ---- states ---------------------------------------------------------------------------------------------------------------------

describe('the six states (design W1 section 6.2): each has its own chip word and icon', () => {
  test('(+) ready: the "Needs you" pill, live controls, the form is shown, nothing moves focus', () => {
    const r = rig();
    r.render(ask());
    assert.equal(r.root.hidden, false);
    assert.equal(r.df.shown(), true);
    assert.equal(r.df.live(), true);
    assert.equal(chip(r.root).textContent, 'Needs you');
    assert.equal(chip(r.root).attrs['data-s'], 'attn');
    assert.equal(r.root.attrs['data-s'], 'ready');
    assert.equal(off(byText(r.root, 'Decline')), false);
    assert.equal(focus.el, null, 'a form that appears never takes focus');
    assert.equal(one(r.root, 'ask-reason').textContent, 'Claude has a question');
  });

  test('(+) reading: an unreadable dialog with no form yet shows the Reading chip with the clock icon, no controls, for READING_MS', () => {
    const r = rig();
    r.render(unreadable());
    assert.equal(r.df.shown(), true);
    assert.equal(r.df.live(), false);
    const c = one(r.root, 'dlg-chip');
    assert.equal(c.textContent, 'Reading');
    assert.deepEqual(hrefs(c), ['#i-clock']);
    assert.equal(c.attrs['data-s'], 'reading');
    assert.match(r.root.textContent, new RegExp(`Reading Claude's question${DOTS}`));
    assert.equal(buttons(r.root).length, 0);
    assert.equal(r.log.calls.length, 0);
  });

  test('(+) reading ends at READING_MS by itself: the form hides, the page is told to redraw its banner, and nothing is announced', () => {
    const r = rig();
    r.render(unreadable());
    const before = r.log.refresh;
    r.advance(READING_MS - 1);
    assert.equal(r.df.shown(), true);
    r.advance(1);
    assert.equal(r.df.shown(), false, 'the banner takes over');
    assert.equal(r.root.hidden, true);
    assert.ok(r.log.refresh > before, 'refresh redraws the attention note without waiting for a capture');
    assert.deepEqual(r.log.announce, []);
  });

  test('(+) a later unreadable capture keeps the clock running (it is not restarted by every capture)', () => {
    const r = rig();
    r.render(unreadable());
    r.advance(1500);
    r.render(unreadable());
    r.advance(500);
    assert.equal(r.df.shown(), false);
    r.render(unreadable());
    assert.equal(r.df.shown(), false, 'still the banner, not a second Reading');
  });

  test('(+) a readable dialog after reading builds the form at once', () => {
    const r = rig();
    r.render(unreadable());
    r.render(ask());
    assert.equal(chip(r.root).textContent, 'Needs you');
    assert.ok(one(r.root, 'ask-q'));
    r.advance(READING_MS + 10);
    assert.equal(r.df.shown(), true, 'the reading timer died with the reading');
  });

  test('(+) terminal only: the dashed chip with the off icon, the note, read-only options; only Decline is live', () => {
    const r = rig();
    r.render(ask({ bypass: true }));
    const c = chip(r.root);
    assert.equal(c.textContent, 'Terminal only');
    assert.deepEqual(hrefs(c), ['#i-off']);
    assert.equal(r.root.attrs['data-s'], 'terminal');
    assert.match(r.root.textContent, /This mentions bypass, so nika leaves it to you: answer it in the terminal\./);
    for (const i of [...inputs(r.root, 'radio'), ...inputs(r.root, 'text')]) assert.equal(i.disabled, true);
    assert.equal(off(byText(r.root, 'Send answer')), true);
    assert.equal(off(byText(r.root, 'Decline')), false);
    assert.equal(r.df.live(), false, 'no answer buttons: Send still says use the terminal');
    assert.equal(r.df.shown(), true);
  });

  test('(+) answering: the spinner chip, every control aria-disabled, Send aria-busy; the request carries the sig and the pick', async () => {
    let release;
    const r = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    r.render(ask());
    const radio = inputs(r.root, 'radio')[0];
    radio.checked = true;
    radio.fire('change');
    byText(r.root, 'Send answer').click();
    assert.equal(chip(r.root).textContent, 'Answering');
    assert.ok(one(chip(r.root), 'spin'), 'the spinner');
    assert.equal(r.root.attrs['data-s'], 'answering');
    assert.equal(byText(r.root, 'Send answer').getAttribute('aria-busy'), 'true');
    for (const b of buttons(r.root).filter((x) => x.textContent !== 'More')) assert.equal(off(b), true, b.textContent);
    for (const i of inputs(r.root, 'radio')) assert.equal(off(i), true);
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [1] }]);
    assert.deepEqual(r.log.calls.map((c) => [c.path, c.method]), [['/pane/%2512/dialog', 'POST']]);
    release({ status: 200, body: { done: 'submitted', sent: 1 } });
    await settle();
    assert.equal(byText(r.root, 'Send answer').getAttribute('aria-busy'), null);
  });

  test('(+) answered: the check icon with Answered, Submitted or Declined; locked until a new sig; no second request', async () => {
    const run = async (done, word, click) => {
      const r = rig({ reply: () => ({ status: 200, body: { done, sent: 2 } }) });
      r.render(ask());
      const radio = inputs(r.root, 'radio')[0];
      radio.checked = true;
      radio.fire('change');
      click(r).click();
      await settle();
      assert.equal(chip(r.root).textContent, word);
      assert.deepEqual(hrefs(chip(r.root)), ['#i-check']);
      assert.equal(r.root.attrs['data-s'], 'answered');
      byText(r.root, 'Send answer').click();
      byText(r.root, 'Decline').click();
      await settle();
      assert.equal(r.log.calls.length, 1, 'locked');
      assert.deepEqual(r.log.say, ['Sent 2 keys to %12']);
      assert.equal(r.log.problem.at(-1)[0], '', 'the problem line is cleared');
      return r;
    };
    await run('submitted', 'Submitted', (r) => byText(r.root, 'Send answer'));
    await run('next', 'Answered', (r) => byText(r.root, 'Send answer'));
    const d = await run('declined', 'Declined', (r) => byText(r.root, 'Decline'));
    assert.deepEqual(d.log.announce.at(-1), 'Declined.');
  });

  test('(+) failed: the warning icon with "Not answered"; the line is shown; a retryable failure leaves the form live', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'not-taken', message: 'SERVER TEXT', sent: 1 } }) });
    r.render(ask());
    const radio = inputs(r.root, 'radio')[0];
    radio.checked = true;
    radio.fire('change');
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(chip(r.root).textContent, 'Not answered');
    assert.deepEqual(hrefs(chip(r.root)), ['#i-warn']);
    assert.equal(r.root.attrs['data-s'], 'failed');
    assert.deepEqual(r.log.problem.at(-1), ["Claude didn't take the key. Check the session, then try again. nika had pressed 1 key in the pane before it stopped.", 'warn']);
    assert.ok(!JSON.stringify(r.log.problem).includes('SERVER TEXT'));
    assert.equal(off(byText(r.root, 'Send answer')), false, 'try again');
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.log.calls.length, 2);
  });

  test('(+) a failure that locks (the dialog changed) keeps the form off until the sig changes; a new sig re-enables it', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'dialog-changed' } }) });
    r.render(ask());
    inputs(r.root, 'radio')[0].checked = true;
    inputs(r.root, 'radio')[0].fire('change');
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(chip(r.root).textContent, 'Not answered');
    assert.equal(off(byText(r.root, 'Send answer')), true);
    assert.equal(off(byText(r.root, 'Decline')), true);
    byText(r.root, 'Decline').click();
    await settle();
    assert.equal(r.log.calls.length, 1);
    r.render(ask({ sig: SIG2, question: 'Which cache?' }));
    assert.equal(chip(r.root).textContent, 'Needs you');
    assert.equal(off(byText(r.root, 'Decline')), false);
  });

  test('(+) kept, unreadable: a shown form stays, keeps its chip, shows the note, and sends nothing', async () => {
    const r = rig();
    r.render(ask());
    inputs(r.root, 'radio')[0].checked = true;
    inputs(r.root, 'radio')[0].fire('change');
    const form = one(r.root, 'dlg-fs');
    r.render(unreadable({ reason: 'cut' }));
    assert.equal(r.df.shown(), true);
    assert.equal(one(r.root, 'dlg-fs'), form, 'the same form, not rebuilt');
    assert.equal(chip(r.root).textContent, 'Needs you');
    const kept = r.root.all((n) => withClass('dlg-note')(n) && /can't read Claude's dialog/.test(n.textContent))[0];
    assert.equal(kept.textContent, "nika can't read Claude's dialog right now. Wait a moment, or answer in the terminal.");
    assert.equal(kept.hidden, false);
    assert.equal(off(byText(r.root, 'Send answer')), true);
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.log.calls.length, 0);
    r.advance(READING_MS * 3);
    assert.equal(r.df.shown(), true, 'no reading clock for a form that was shown');
    r.render(ask());
    assert.equal(kept.hidden, true, 'the note goes when the screen is readable again');
    assert.equal(off(byText(r.root, 'Send answer')), false, 'readable again, and the pick made before is still there');
    assert.equal(inputs(r.root, 'radio')[0].checked, true);
  });
});

// ---- hysteresis, rebuild, focus -------------------------------------------------------------------------------------------------

describe('hysteresis, the rebuild for the next step, focus and announcements', () => {
  test('(+) the form stays while captures carry a dialog and leaves on null, drops its state, and tells the page', () => {
    const r = rig();
    r.render(ask());
    const refreshed = r.log.refresh;
    r.render(ask());
    assert.equal(r.log.refresh, refreshed, 'a repeat of the same dialog changes nothing');
    r.render(null);
    assert.equal(r.df.shown(), false);
    assert.equal(r.root.hidden, true);
    assert.equal(r.root.kids.length, 0, 'nothing kept after the form leaves');
    assert.ok(r.log.refresh > refreshed);
    assert.equal(r.df.live(), false);
  });

  test('(+) a pane that is not ok also takes the form away', () => {
    const r = rig();
    r.render(ask());
    r.df.render({ pane: 'tmux', dialog: cleanDialog(ask()), name: 'builder-1', attention: '' });
    assert.equal(r.df.shown(), false);
  });

  test('(+) the same sig keeps the same nodes, so typed text and the pick survive the captures', () => {
    const r = rig();
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    text.value = 'my own';
    text.fire('input');
    r.render(ask());
    assert.equal(one(r.root, 'dlg-text'), text);
    assert.equal(text.value, 'my own');
  });

  test('(+) another sig rebuilds the form for the next tab: new question, new tab marks', () => {
    const r = rig();
    r.render(multi());
    assert.equal(q(r.root, 'dlg-tab').filter((t) => t.getAttribute('aria-current') === 'step').length, 1);
    r.render(multi({ sig: SIG2, current: 1, question: 'Which scope?', tabs: tabs(4, 1) }));
    assert.equal(one(r.root, 'ask-q').textContent, 'Which scope?');
    const cur = q(r.root, 'dlg-tab').findIndex((t) => t.getAttribute('aria-current') === 'step');
    assert.equal(cur, 1);
  });

  test('(+) announcements: the first question, then each tab, then the review, as the design words them', () => {
    const r = rig();
    r.render(multi());
    r.render(multi({ sig: SIG2, current: 1, question: 'Which scope?', tabs: tabs(4, 1) }));
    r.render(review({ sig: SIG3 }));
    assert.deepEqual(r.log.announce, [
      'builder-1 asks: Which checks should I run? Question 1 of 4, above the message box.',
      'Question 2 of 4: Which scope?',
      'Review your answers: 2 answers, above the message box.',
    ]);
  });

  test('(+) the plan is announced once, with where to read it', () => {
    const r = rig();
    r.render(plan());
    r.render(plan());
    assert.deepEqual(r.log.announce, ['builder-1 asks you to approve a plan. Read it in the terminal view; choices above the message box.']);
  });

  test('(+) after a 200 the result is announced: Answered, Submitted, a plan choice, Declined', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'chosen', sent: 1 } }) });
    r.render(plan());
    buttons(r.root).find((b) => b.textContent.endsWith('auto mode')).click();
    await settle();
    assert.equal(r.log.announce.at(-1), 'Sent your choice to builder-1.');
    const s = rig({ reply: () => ({ status: 200, body: { done: 'submitted', sent: 1 } }) });
    s.render(review());
    byText(s.root, 'Submit answers').click();
    await settle();
    assert.equal(s.log.announce.at(-1), "Submitted builder-1's answers.");
  });

  test('(+) focus: a rebuild with focus inside goes to the new legend; the review heading for the review', () => {
    const r = rig();
    r.render(multi());
    inputs(r.root, 'checkbox')[0].focus();
    r.render(multi({ sig: SIG2, current: 1, question: 'Which scope?' }));
    assert.equal(focus.el, one(r.root, 'ask-q'));
    assert.equal(focus.el.tag, 'legend');
    assert.equal(focus.el.getAttribute('tabindex'), '-1');
    byText(r.root, 'Answer').focus();
    r.render(review({ sig: SIG3 }));
    assert.equal(focus.el.tag, 'h3');
    assert.equal(focus.el.textContent, 'Review your answers');
  });

  test('(−) a rebuild with focus outside the form moves nothing', () => {
    const r = rig();
    r.render(multi());
    focus.el = r.box;
    r.render(multi({ sig: SIG2, current: 1, question: 'Which scope?' }));
    assert.equal(focus.el, r.box);
  });

  test('(+) leaving with focus inside goes to the message box; leaving with focus elsewhere does not', () => {
    const r = rig();
    r.render(ask());
    byText(r.root, 'Decline').focus();
    r.render(null);
    assert.equal(r.log.boxFocus, 1);
    assert.equal(focus.el, r.box);
    const s = rig();
    s.render(ask());
    focus.el = new TEl('input');
    s.render(null);
    assert.equal(s.log.boxFocus, 0);
  });

  test('(+) a dialog that closes while the request is still in flight takes the form away; the late answer still announces', async () => {
    let release;
    const r = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    r.render(ask());
    inputs(r.root, 'radio')[0].checked = true;
    inputs(r.root, 'radio')[0].fire('change');
    byText(r.root, 'Send answer').click();
    r.render(null);
    assert.equal(r.df.shown(), false);
    release({ status: 200, body: { done: 'submitted', sent: 1 } });
    await settle();
    assert.equal(r.df.shown(), false, 'the answer does not bring the form back');
    assert.equal(r.log.announce.at(-1), "Submitted builder-1's answers.");
  });

  test('(+) the next tab that arrives while a request is in flight waits for the answer, then replaces the form', async () => {
    let release;
    const r = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    r.render(multi());
    byText(r.root, 'Answer').click();
    r.render(multi({ sig: SIG2, current: 1, question: 'Which scope?' }));
    assert.equal(one(r.root, 'ask-q').textContent, 'Which checks should I run?', 'still the first question, still Answering');
    assert.equal(chip(r.root).textContent, 'Answering');
    release({ status: 200, body: { done: 'next', sent: 2 } });
    await settle();
    assert.equal(one(r.root, 'ask-q').textContent, 'Which scope?');
    assert.equal(chip(r.root).textContent, 'Needs you');
  });

  test('(+) refresh tells the page when the form appears and when it goes, and not for every capture', () => {
    const r = rig();
    r.render(ask());
    assert.equal(r.log.refresh, 1);
    r.render(ask());
    r.render(ask({ sig: SIG2, question: 'Next?' }));
    assert.equal(r.log.refresh, 1, 'a rebuild is not a change of visibility');
    r.render(null);
    assert.equal(r.log.refresh, 2);
    r.render(null);
    assert.equal(r.log.refresh, 2);
  });
});

// ---- the question ---------------------------------------------------------------------------------------------------------------

describe('the question step', () => {
  test('(+) the fieldset is labelled by the legend; the group by the same id', () => {
    const r = rig();
    r.render(ask());
    const legend = one(r.root, 'ask-q');
    assert.equal(legend.tag, 'legend');
    assert.equal(legend.attrs.id, 'dlg-q');
    assert.equal(legend.textContent, 'Which database should I use?');
    assert.equal(r.root.getAttribute('aria-labelledby'), 'dlg-q');
    assert.equal(one(r.root, 'dlg-fs').tag, 'fieldset');
  });

  test('(+) single-select: one radio per option with Claude\'s number, label and description; nothing is picked; Send stays off with no answer', async () => {
    const r = rig();
    r.render(ask());
    const rows = q(r.root, 'ch');
    assert.equal(rows.length, 3, 'two options and Other');
    assert.equal(inputs(r.root, 'radio').length, 3);
    assert.deepEqual(q(r.root, 'ch').slice(0, 2).map((l) => l.all((n) => n.tag === 'kbd')[0].textContent), ['1', '2']);
    assert.match(rows[0].textContent, /sqlite/);
    assert.match(rows[0].textContent, /Embedded, one file\./);
    assert.ok(inputs(r.root, 'radio').every((i) => i.checked === false));
    assert.equal(off(byText(r.root, 'Send answer')), true);
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.log.calls.length, 0, 'no answer, no request');
  });

  test('(+) a pick turns Send on, marks the row, and clears the other rows (one radio at a time)', () => {
    const r = rig();
    r.render(ask());
    const [a, b] = inputs(r.root, 'radio');
    a.checked = true;
    a.fire('change');
    b.checked = true;
    b.fire('change');
    assert.equal(a.checked, false);
    assert.equal(off(byText(r.root, 'Send answer')), false);
    const rows = q(r.root, 'ch');
    assert.deepEqual(rows.map((l) => l.getAttribute('data-on')), ['false', 'true', 'false']);
  });

  test('(+) the primary button says Send answer when the answer ends the dialog and Answer when another step follows', () => {
    const r = rig();
    r.render(ask({ final: true }));
    assert.ok(byText(r.root, 'Send answer'));
    r.render(ask({ sig: SIG2, final: false }));
    assert.ok(byText(r.root, 'Answer'));
    assert.equal(byText(r.root, 'Send answer'), null);
    assert.equal(byText(r.root, 'Answer').className.includes('primary'), true);
  });

  test('(+) multi-select: checkboxes start from Claude\'s ticks, Answer is on from the start, and sends the sorted set', async () => {
    const r = rig();
    r.render(multi());
    const boxes = inputs(r.root, 'checkbox');
    assert.deepEqual(boxes.map((b) => b.checked), [false, true, false]);
    assert.equal(off(byText(r.root, 'Answer')), false);
    boxes[2].checked = true;
    boxes[2].fire('change');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [2, 3] }]);
  });

  test('(−) multi-select with every box unticked leaves Answer off', () => {
    const r = rig();
    r.render(multi());
    const boxes = inputs(r.root, 'checkbox');
    boxes[1].checked = false;
    boxes[1].fire('change');
    assert.equal(off(byText(r.root, 'Answer')), true);
  });

  test('(+) Other: a text field of 300 characters; typing selects it and clears the picks; the request carries the text and no pick', async () => {
    const r = rig();
    r.render(ask());
    const [a] = inputs(r.root, 'radio');
    a.checked = true;
    a.fire('change');
    const text = one(r.root, 'dlg-text');
    assert.equal(text.getAttribute('maxlength'), '300');
    assert.equal(text.getAttribute('placeholder'), 'Type your answer');
    assert.equal(text.getAttribute('type'), 'text');
    text.value = '  mariadb  ';
    text.fire('input');
    assert.equal(a.checked, false);
    assert.equal(inputs(r.root, 'radio').at(-1).checked, true);
    assert.equal(off(byText(r.root, 'Send answer')), false);
    byText(r.root, 'Send answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [], text: 'mariadb' }]);
  });

  test('(+) Enter in Other is Send, never a newline; Enter with nothing typed does nothing', async () => {
    const r = rig();
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    const none = text.fire('keydown', { key: 'Enter' });
    assert.equal(none.defaultPrevented, true);
    await settle();
    assert.equal(r.log.calls.length, 0);
    text.value = 'mariadb';
    text.fire('input');
    const e = text.fire('keydown', { key: 'Enter' });
    assert.equal(e.defaultPrevented, true);
    await settle();
    assert.equal(r.log.calls.length, 1);
    const c = rig();
    c.render(ask());
    const t2 = one(c.root, 'dlg-text');
    t2.value = 'x';
    t2.fire('input');
    t2.fire('keydown', { key: 'Enter', isComposing: true });
    await settle();
    assert.equal(c.log.calls.length, 0, 'the IME owns the key');
  });

  test('(+) a control character typed or pasted into Other is dropped', () => {
    const r = rig();
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    text.value = `ab${String.fromCharCode(9)}c${String.fromCharCode(0x85)}`;
    text.fire('input');
    assert.equal(text.value, 'abc');
  });

  test('(+) a counter appears from 250 characters', () => {
    const r = rig();
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    const count = one(r.root, 'dlg-count');
    assert.equal(count.hidden, true);
    text.value = 'x'.repeat(249);
    text.fire('input');
    assert.equal(count.hidden, true);
    text.value = 'x'.repeat(250);
    text.fire('input');
    assert.equal(count.hidden, false);
    assert.equal(count.textContent, '250/300');
  });

  test('(+) multi with Other on the capture: a checkbox with a text field; text alone is an answer; both go together', async () => {
    const r = rig();
    r.render(multi({ other: true }));
    const text = one(r.root, 'dlg-text');
    assert.equal(inputs(r.root, 'checkbox').length, 4);
    inputs(r.root, 'checkbox')[1].checked = false;
    inputs(r.root, 'checkbox')[1].fire('change');
    assert.equal(off(byText(r.root, 'Answer')), true);
    text.value = 'also e2e';
    text.fire('input');
    assert.equal(inputs(r.root, 'checkbox').at(-1).checked, true);
    assert.equal(off(byText(r.root, 'Answer')), false);
    inputs(r.root, 'checkbox')[0].checked = true;
    inputs(r.root, 'checkbox')[0].fire('change');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [1], text: 'also e2e' }]);
  });

  test('(−) other: false shows the off row and no text field, in single and multi', () => {
    for (const d of [ask({ other: false }), multi()]) {
      const r = rig();
      r.render(d);
      assert.equal(one(r.root, 'dlg-text'), null);
      const row = one(r.root, 'pbtn-off');
      assert.ok(row);
      assert.equal(row.textContent, 'Other answers: use the terminal');
      assert.equal(row.tag, 'div', 'not a control');
      assert.equal(row.getAttribute('tabindex'), null);
    }
  });

  test('(+) Decline sends the cancel body with the sig; its title says what it does', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'declined', sent: 1 } }) });
    r.render(ask());
    const d = byText(r.root, 'Decline');
    assert.equal(d.getAttribute('title'), 'Presses Esc in the pane: Claude stops and waits for you');
    d.click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, cancel: true }]);
  });

  test('(+) a long description is clamped with a More button that opens and closes it', () => {
    const r = rig();
    r.render(ask({ options: [{ n: 1, label: 'sqlite', description: 'Embedded. '.repeat(40) }, { n: 2, label: 'postgres', description: 'Short.' }] }));
    const mores = buttons(r.root).filter((b) => b.className.includes('dlg-more'));
    assert.equal(mores.length, 1, 'only the long one');
    const more = mores[0];
    assert.equal(more.textContent, 'More');
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    const desc = r.root.all((n) => n.attrs.id === more.getAttribute('aria-controls'))[0];
    assert.ok(desc.className.includes('clamp'));
    more.click();
    assert.equal(more.getAttribute('aria-expanded'), 'true');
    assert.equal(desc.className.includes('clamp'), false);
    assert.equal(more.textContent, 'Less');
    more.click();
    assert.ok(desc.className.includes('clamp'));
  });

  test('(−) the page types and presses nothing itself: a digit, Enter on a row or Esc sends no request', async () => {
    const r = rig();
    r.render(ask());
    const fs = one(r.root, 'dlg-fs');
    for (const key of ['Escape', '1', 'Enter', 'ArrowDown', ' ']) {
      for (const el of [r.root, fs, one(r.root, 'ask-q'), inputs(r.root, 'radio')[0], buttons(r.root)[0]]) el.fire('keydown', { key });
    }
    await settle();
    assert.equal(r.log.calls.length, 0);
    assert.equal(Object.keys(r.root.listeners).includes('keydown'), false, 'no key handler on the form itself');
  });
});

// ---- the tabs list --------------------------------------------------------------------------------------------------------------

describe('the tabs list: it shows where Claude is and never moves it', () => {
  test('(+) one item per tab plus Review; the current one is aria-current="step"; answered tabs have the check icon and the words', () => {
    const r = rig();
    r.render(multi({ tabs: tabs(4, 1), current: 1 }));
    const ol = one(r.root, 'dlg-tabs');
    assert.equal(ol.tag, 'ol');
    assert.equal(ol.getAttribute('aria-label'), 'Questions');
    const items = q(r.root, 'dlg-tab');
    assert.equal(items.length, 5);
    assert.deepEqual(items.map((i) => i.getAttribute('aria-current')), [null, 'step', null, null, null]);
    assert.deepEqual(hrefs(items[0]), ['#i-check']);
    assert.match(items[0].textContent, /Tools/);
    assert.match(items[0].accName, /answered/);
    assert.match(items[1].textContent, /Project not answered/);
    assert.deepEqual(hrefs(items[1]), [], 'an empty ring is drawn with CSS, not an icon');
    assert.ok(one(items[1], 'dlg-ring'));
    assert.equal(items[4].textContent, 'Review');
  });

  test('(+) on the review step the Review item is the current one', () => {
    const r = rig();
    r.render(review());
    const items = q(r.root, 'dlg-tab');
    assert.equal(items.at(-1).getAttribute('aria-current'), 'step');
    assert.equal(items.filter((i) => i.getAttribute('aria-current') === 'step').length, 1);
  });

  test('(+) the narrow text names the question and the tab', () => {
    const r = rig();
    r.render(multi({ current: 2, tabs: tabs(4, 2) }));
    assert.equal(one(r.root, 'dlg-step').textContent, `Question 3 of 4 ${MID} Scope`);
  });

  test('(−) a single question has no tabs list and no step text', () => {
    const r = rig();
    r.render(ask());
    assert.equal(one(r.root, 'dlg-tabs'), null);
    assert.equal(one(r.root, 'dlg-step'), null);
  });

  test('(−) the items are not buttons, not focusable and listen to nothing', () => {
    const r = rig();
    r.render(multi());
    for (const el of [one(r.root, 'dlg-tabs'), ...q(r.root, 'dlg-tab')]) {
      assert.notEqual(el.tag, 'button');
      assert.equal(el.getAttribute('tabindex'), null);
      assert.equal(el.getAttribute('role'), null);
      assert.deepEqual(Object.keys(el.listeners), []);
    }
    assert.equal(buttons(one(r.root, 'dlg-tabs')).length, 0);
  });
});

// ---- the review -----------------------------------------------------------------------------------------------------------------

describe('the review step', () => {
  test('(+) the heading, a pair list with each question and answer as Claude shows it, Submit answers and Decline', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'submitted', sent: 1 } }) });
    r.render(review());
    assert.equal(one(r.root, 'ask-q').textContent, 'Review your answers');
    assert.equal(r.root.getAttribute('aria-labelledby'), 'dlg-q');
    const dl = one(r.root, 'dlg-review');
    assert.equal(dl.tag, 'dl');
    assert.deepEqual(dl.kids.map((k) => [k.tag, k.textContent]), [
      ['dt', 'Which checks should I run?'], ['dd', 'lint, build'], ['dt', 'Which database should I use?'], ['dd', 'sqlite'],
    ]);
    assert.equal(one(r.root, 'dlg-warn'), null);
    const submit = byText(r.root, 'Submit answers');
    assert.ok(submit.className.includes('primary'));
    submit.click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG2, submit: true }]);
    assert.equal(chip(r.root).textContent, 'Submitted');
  });

  test('(+) the warning row has the warning icon and the words when Claude says not every question is answered', () => {
    const r = rig();
    r.render(review({ warn: true }));
    const w = one(r.root, 'dlg-warn');
    assert.equal(w.textContent, 'You have not answered all questions');
    assert.deepEqual(hrefs(w), ['#i-warn']);
    assert.equal(off(byText(r.root, 'Submit answers')), false, 'it does not block Submit');
  });

  test('(+) Decline on the review sends cancel', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'declined', sent: 1 } }) });
    r.render(review());
    byText(r.root, 'Decline').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG2, cancel: true }]);
  });

  test('(−) a question step has no Submit answers, and the review has no radios or Other', () => {
    const r = rig();
    r.render(ask());
    assert.equal(byText(r.root, 'Submit answers'), null);
    r.render(review());
    assert.equal(inputs(r.root, 'radio').length + inputs(r.root, 'checkbox').length + inputs(r.root, 'text').length, 0);
  });
});

// ---- the plan -------------------------------------------------------------------------------------------------------------------

describe('the plan approval', () => {
  test('(+) the note with the window icon, one button per choice with Claude\'s number and label verbatim, and Reject (Esc)', () => {
    const r = rig();
    r.render(plan());
    assert.equal(chip(r.root).textContent, 'Needs you');
    const kind = one(r.root, 'dlg-kind');
    assert.equal(kind.textContent, 'Plan approval');
    assert.deepEqual(hrefs(kind), ['#i-m-plan']);
    assert.equal(kind.getAttribute('data-k'), 'plan');
    const note = r.root.all((n) => n.tag === 'p' && n.textContent === 'Read the plan in the terminal view.')[0];
    assert.ok(note);
    assert.deepEqual(hrefs(note), ['#i-window']);
    const choices = q(r.root, 'pbtn').filter((b) => b.tag === 'button' && !b.className.includes('esc'));
    assert.deepEqual(choices.map((b) => [b.all((n) => n.tag === 'kbd')[0].textContent, b.textContent.slice(1)]), [['1', 'Yes, and use auto mode'], ['2', 'Yes, manually approve edits']]);
    assert.ok(byText(r.root, 'Reject (Esc)').className.includes('esc'));
  });

  test('(+) a choice sends { sig, choice } with the option number', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'chosen', sent: 1 } }) });
    r.render(plan());
    q(r.root, 'pbtn').filter((b) => b.tag === 'button')[1].click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG3, choice: 2 }]);
    assert.equal(chip(r.root).textContent, 'Answered');
    for (const b of buttons(r.root)) assert.equal(off(b), true, 'locked after the answer');
  });

  test('(+) Reject (Esc) is Decline: { sig, cancel: true }', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'declined', sent: 1 } }) });
    r.render(plan());
    byText(r.root, 'Reject (Esc)').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG3, cancel: true }]);
    assert.equal(chip(r.root).textContent, 'Declined');
  });

  test('(−) the text option is a row that says use the terminal; it is not a button and sends nothing', async () => {
    const r = rig();
    r.render(plan());
    const row = r.root.all((n) => withClass('pbtn-off')(n) && /Tell Claude/.test(n.textContent))[0];
    assert.ok(row);
    assert.equal(row.tag, 'div');
    assert.equal(row.textContent.replace(/^3/, ''), 'Tell Claude what to change: use the terminal');
    row.click();
    await settle();
    assert.equal(r.log.calls.length, 0);
    assert.equal(buttons(r.root).filter((b) => /Tell Claude/.test(b.textContent)).length, 0);
  });

  test('(−) a plan that mentions bypass: the choices are read-only rows, only Reject (Esc) is live', async () => {
    const r = rig();
    r.render(plan({ bypass: true }));
    assert.equal(chip(r.root).textContent, 'Terminal only');
    assert.equal(q(r.root, 'pbtn').filter((b) => b.tag === 'button' && !b.className.includes('esc')).length, 0);
    assert.equal(q(r.root, 'pbtn-off').length, 3);
    assert.equal(off(byText(r.root, 'Reject (Esc)')), false);
    assert.equal(r.df.live(), false);
  });

  test('(+) the plan group is labelled by its kind tag', () => {
    const r = rig();
    r.render(plan());
    assert.equal(r.root.getAttribute('aria-labelledby'), 'dlg-kind');
    assert.equal(one(r.root, 'dlg-kind').attrs.id, 'dlg-kind');
  });
});

// ---- the route outcomes through the form ----------------------------------------------------------------------------------------

describe('route answers through the form (design W1 section 6.4)', () => {
  const answerWith = async (reply) => {
    const r = rig({ reply: () => reply });
    r.render(ask());
    inputs(r.root, 'radio')[0].checked = true;
    inputs(r.root, 'radio')[0].fire('change');
    byText(r.root, 'Send answer').click();
    await settle();
    return r;
  };

  test('(+) a re-enabled failure: no-dialog, not-taken, busy, not-idle, invalid, 429, tmux; the form takes another try', async () => {
    for (const [status, error] of [[409, 'no-dialog'], [409, 'not-taken'], [409, 'busy-switching'], [409, 'not-idle'], [400, 'invalid'], [429, undefined], [500, undefined], [0, undefined]]) {
      const r = await answerWith({ status, body: error ? { error } : null });
      assert.equal(off(byText(r.root, 'Send answer')), false, `${status} ${error}`);
      assert.ok(r.log.problem.at(-1)[0], `${status} ${error} shows a line`);
    }
  });

  test('(+) a locking failure: changed, touched, focus, text-mode, text-mismatch, terminal-only, already-answered', async () => {
    for (const [status, error] of [[409, 'dialog-changed'], [409, 'dialog-touched'], [409, 'dialog-focus'], [409, 'text-mode'], [409, 'text-mismatch'], [400, 'terminal-only'], [409, 'already-answered']]) {
      const r = await answerWith({ status, body: { error } });
      assert.equal(off(byText(r.root, 'Send answer')), true, `${status} ${error}`);
      assert.equal(off(byText(r.root, 'Decline')), true, `${status} ${error}`);
    }
  });

  test('(+) already-answered shows no line and says Answered', async () => {
    const r = await answerWith({ status: 409, body: { error: 'already-answered' } });
    assert.equal(r.log.problem.filter((p) => p[0] !== '').length, 0);
    assert.equal(chip(r.root).textContent, 'Answered');
  });

  test('(+) a 404 shows the line and tells the page the pane is gone', async () => {
    const r = await answerWith({ status: 404, body: { error: 'not_found' } });
    assert.equal(r.log.gone, 1);
    assert.deepEqual(r.log.problem.at(-1), ['The session is gone.', 'error']);
  });

  test('(−) a response with extra fields is not shown: only the fixed line reaches the page', async () => {
    const r = await answerWith({ status: 409, body: { error: 'dialog-touched', message: 'LEAK <b>x</b>', sent: 0 } });
    assert.ok(!JSON.stringify([r.log.problem, r.log.say, r.log.announce, r.root.textContent]).includes('LEAK'));
  });

  test('(−) a second click while a request is in flight sends nothing', async () => {
    let release;
    const r = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    r.render(ask());
    inputs(r.root, 'radio')[0].checked = true;
    inputs(r.root, 'radio')[0].fire('change');
    byText(r.root, 'Send answer').click();
    byText(r.root, 'Send answer').click();
    byText(r.root, 'Decline').click();
    assert.equal(r.log.calls.length, 1);
    release({ status: 200, body: { done: 'next' } });
    await settle();
  });

  test('(−) the terminal-only form refuses an answer even when the click handler is reached, and lets Decline through', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'declined', sent: 1 } }) });
    r.render(ask({ bypass: true }));
    inputs(r.root, 'radio')[0].checked = true; // the browser would not let a disabled radio be picked; the guard must hold even so
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.log.calls.length, 0);
    byText(r.root, 'Decline').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, cancel: true }]);
  });
});

// ---- fix round 1: digit-led text, typed bypass text, inert rows -----------------------------------------------------------------

describe('digit-led free text: the route refuses a first 1 to 9 (400 invalid), so the form says why under the field and sends nothing', () => {
  const LEAD = 'Start with a word: Claude can read a first digit as an option.';
  const single = cleanDialog(ask());
  const multiOther = cleanDialog(multi({ other: true }));
  const lead = (root) => root.all((n) => n.attrs.id === 'dlg-lead')[0] ?? null;
  const typeIn = (r, v) => {
    const t = one(r.root, 'dlg-text');
    t.value = v;
    t.fire('input');
    return t;
  };

  test('(−) answerBody gives null for a trimmed text that starts with 1 to 9, in single-select and in multi-select with Other', () => {
    for (const n of '123456789') {
      assert.equal(answerBody(single, { picks: [], text: `${n} cores` }), null, n);
      assert.equal(answerBody(single, { picks: [], text: `  ${n}` }), null, `${n} after spaces (they are trimmed first)`);
      assert.equal(answerBody(multiOther, { picks: [1], text: `${n}x` }), null, `${n} in multi-select`);
    }
  });

  test('(+) a digit that is not first, a leading 0 and a word all go through: only a first 1 to 9 is refused', () => {
    for (const t of ['use 2 caches', 'v2', '0 retries', 'two', '(3) three', 'a1']) assert.deepEqual(answerBody(single, { picks: [], text: t }), { sig: SIG, picks: [], text: t }, t);
    assert.deepEqual(answerBody(multiOther, { picks: [2], text: 'also 3' }), { sig: SIG, picks: [2], text: 'also 3' });
  });

  test('(+) typing a digit first shows the warn line right under the field: the warning icon and the fixed words; Send is off', () => {
    const r = rig();
    r.render(ask());
    const text = typeIn(r, '2 caches');
    const line = lead(r.root);
    assert.equal(line.hidden, false);
    assert.equal(line.textContent, LEAD);
    assert.deepEqual(hrefs(line), ['#i-warn']);
    assert.ok(withClass('dlg-warn')(line), 'the existing warn style: colour, icon and words');
    assert.equal(one(r.root, 'dlg-fs').kids.at(-1), line, 'directly under the Other row');
    assert.equal(text.getAttribute('aria-describedby'), 'dlg-lead', 'the field is described by it');
    assert.equal(off(byText(r.root, 'Send answer')), true);
  });

  test('(+) Send and Enter send nothing and leave the focus in the field (the click moved it to the button)', async () => {
    const r = rig();
    r.render(ask());
    const text = typeIn(r, '2 caches');
    focus.el = byText(r.root, 'Send answer');
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.log.calls.length, 0);
    assert.equal(focus.el, text, 'focus is back in the field');
    focus.el = byText(r.root, 'Decline');
    const e = text.fire('keydown', { key: 'Enter' });
    await settle();
    assert.equal(e.defaultPrevented, true, 'Enter is still never a newline');
    assert.equal(r.log.calls.length, 0);
    assert.equal(focus.el, text);
    assert.equal(r.log.problem.length, 0, 'the line under the field is the message; no second one');
  });

  test('(+) the line is announced once when it appears, not at every key; it is gone with the digit and the answer then goes', async () => {
    const r = rig();
    r.render(ask());
    const text = typeIn(r, '2');
    typeIn(r, '2 c');
    typeIn(r, '2 caches');
    assert.equal(r.log.announce.filter((m) => m === LEAD).length, 1);
    assert.equal(lead(r.root).hidden, false);
    typeIn(r, 'two caches');
    assert.equal(lead(r.root).hidden, true);
    assert.equal(text.getAttribute('aria-describedby'), null);
    assert.equal(off(byText(r.root, 'Send answer')), false);
    byText(r.root, 'Send answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [], text: 'two caches' }]);
  });

  test('(−) no line for a word, a later digit or a leading 0, or while the field is empty; the line is built hidden', () => {
    const r = rig();
    r.render(ask());
    assert.equal(lead(r.root).hidden, true, 'hidden from the start');
    for (const v of ['mariadb', 'use 2 caches', '0 retries', '']) {
      typeIn(r, v);
      assert.equal(lead(r.root).hidden, true, JSON.stringify(v));
    }
    assert.ok(!r.log.announce.includes(LEAD));
  });

  test('(−) text that is not the answer gives no line: Other unticked (a radio was picked after the typing) and the form without Other', () => {
    const r = rig();
    r.render(ask());
    typeIn(r, '3 databases');
    assert.equal(lead(r.root).hidden, false);
    const [a] = inputs(r.root, 'radio');
    a.checked = true;
    a.fire('change');
    assert.equal(inputs(r.root, 'radio').at(-1).checked, false);
    assert.equal(lead(r.root).hidden, true, 'the text is not part of the answer any more');
    assert.equal(off(byText(r.root, 'Send answer')), false);
    const none = rig();
    none.render(ask({ other: false }));
    assert.equal(lead(none.root), null, 'no text field, no line');
  });

  test('(+) multi-select with Other: the line shows with the box ticked, hides when it is unticked; the Answer button follows', () => {
    const r = rig();
    r.render(multi({ other: true }));
    typeIn(r, '2nd run');
    assert.equal(lead(r.root).hidden, false);
    assert.equal(off(byText(r.root, 'Answer')), true, 'even with a tick elsewhere, the text would be refused');
    const other = inputs(r.root, 'checkbox').at(-1);
    other.checked = false;
    other.fire('change');
    assert.equal(lead(r.root).hidden, true);
    assert.equal(off(byText(r.root, 'Answer')), false);
  });

  test('(−) the line text is a fixed string set as text: it carries nothing of what was typed, and the source holds no markup sink for it', () => {
    const r = rig();
    r.render(ask());
    typeIn(r, '2 <b>x</b>');
    assert.equal(lead(r.root).textContent, LEAD);
    assert.ok(!lead(r.root).textContent.includes('<b>'));
    assert.match(code(SRC), /h\('span',\s*\{\s*text:\s*LEAD_NOTE\s*\}\)/);
  });
});

describe('invisible characters before a digit: the route refuses format characters and a leading combining mark, so the form removes them and the digit warning works on the cleaned text', () => {
  const LEAD = 'Start with a word: Claude can read a first digit as an option.';
  const FORMATS = { 'U+2060 word joiner': '⁠', 'U+00AD soft hyphen': '­', 'U+180E Mongolian vowel separator': '᠎', 'U+FEFF zero width no-break space': '﻿' };
  const MARK = '́'; // a combining acute accent
  const single = cleanDialog(ask());
  const lead = (root) => root.all((n) => n.attrs.id === 'dlg-lead')[0] ?? null;
  const typeIn = (r, v) => {
    const t = one(r.root, 'dlg-text');
    t.value = v;
    t.fire('input');
    return t;
  };

  test('(+) typable removes every format character (the route refuses them anywhere) and keeps a combining mark and a whole emoji', () => {
    for (const [name, c] of Object.entries(FORMATS)) assert.equal(typable(`a${c}b${c}`), 'ab', name);
    assert.equal(typable(`cafe${MARK} ok 😀`), `cafe${MARK} ok 😀`, 'a mark after a letter is an accent, not noise');
  });

  test('(−) answerBody gives null for a format character anywhere, and for a digit hidden behind a leading combining mark', () => {
    for (const [name, c] of Object.entries(FORMATS)) {
      // U+FEFF is white space to trim(), so at an edge it is cut (not refused); the digit behind it is then first and refused
      for (const text of [`${c}2 cores`, `ap${c}ples`, `ap${c}ples 2`]) assert.equal(answerBody(single, { picks: [], text }), null, `${name}: ${JSON.stringify(text)}`);
      if (c !== '\ufeff') assert.equal(answerBody(single, { picks: [], text: `apples${c}` }), null, `${name}: at the end`);
    }
    for (const text of [`${MARK}2 cores`, ` ${MARK} 2 cores`, `${MARK}${MARK}7`]) assert.equal(answerBody(single, { picks: [], text }), null, JSON.stringify(text));
  });

  test('(+) a leading combining mark is dropped when the text is trimmed: the word goes out clean, with a mark inside it kept', () => {
    assert.deepEqual(answerBody(single, { picks: [], text: `${MARK}mine` }), { sig: SIG, picks: [], text: 'mine' });
    assert.deepEqual(answerBody(single, { picks: [], text: ` ${MARK}${MARK} cafe${MARK}  ` }), { sig: SIG, picks: [], text: `cafe${MARK}` });
    assert.equal(answerBody(single, { picks: [], text: `${MARK}` }), null, 'only a mark is nothing to send');
  });

  test('(+) typing a format character before a digit: the field holds the cleaned text and the warn line shows (Send is off)', () => {
    for (const [name, c] of Object.entries(FORMATS)) {
      const r = rig();
      r.render(ask());
      const text = typeIn(r, `${c}2 caches`);
      assert.equal(text.value, '2 caches', `${name}: removed as the user types`);
      assert.equal(lead(r.root).hidden, false, name);
      assert.equal(lead(r.root).textContent, LEAD, name);
      assert.equal(off(byText(r.root, 'Send answer')), true, name);
    }
  });

  test('(+) typing a combining mark before a digit: the warn line shows on the text without the mark, and nothing is sent', async () => {
    const r = rig();
    r.render(ask());
    typeIn(r, `${MARK}2 caches`);
    assert.equal(lead(r.root).hidden, false);
    assert.equal(off(byText(r.root, 'Send answer')), true);
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.log.calls.length, 0, 'the body would start with a digit, so there is none');
  });

  test('(−) no warn line for a word behind a hidden character or a mark, and the word goes out clean', async () => {
    for (const c of [...Object.values(FORMATS), MARK]) {
      const r = rig();
      r.render(ask());
      typeIn(r, `${c}two caches`);
      assert.equal(lead(r.root).hidden, true, JSON.stringify(c));
      assert.equal(off(byText(r.root, 'Send answer')), false, JSON.stringify(c));
      byText(r.root, 'Send answer').click();
      await settle();
      assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [], text: 'two caches' }], JSON.stringify(c));
    }
  });
});

describe('typed text that mentions bypass: the route refuses it before any key (400 terminal-only); the page shows its fixed line', () => {
  test('(+) the answer goes out as typed, then: the fixed line, Not answered, the form locked off; the response text never shows', async () => {
    const r = rig({ reply: () => ({ status: 400, body: { error: 'terminal-only', message: 'LEAK <b>bypass</b>', sent: 0 } }) });
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    text.value = 'enable bypass permissions';
    text.fire('input');
    byText(r.root, 'Send answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [], text: 'enable bypass permissions' }]);
    assert.deepEqual(r.log.problem.at(-1), ['Answer this in the terminal.', 'warn']);
    assert.ok(!JSON.stringify([r.log.problem, r.log.say, r.log.announce, r.root.textContent]).includes('LEAK'));
    assert.equal(chip(r.root).textContent, 'Not answered');
    assert.equal(off(byText(r.root, 'Send answer')), true);
    assert.equal(off(byText(r.root, 'Decline')), true);
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.log.calls.length, 1, 'locked until the dialog changes');
  });

  test('(−) a plain 400 invalid is not that: its own generic line, and the form stays live', async () => {
    const r = rig({ reply: () => ({ status: 400, body: { error: 'invalid', message: 'text must be 1 to 300 characters' } }) });
    r.render(ask());
    const text = one(r.root, 'dlg-text');
    text.value = 'mariadb';
    text.fire('input');
    byText(r.root, 'Send answer').click();
    await settle();
    assert.deepEqual(r.log.problem.at(-1), ["nika couldn't send this answer. Check it and try again.", 'warn']);
    assert.equal(off(byText(r.root, 'Send answer')), false);
  });
});

describe('inert rows: a form that cannot take an answer dims its option rows (data-inert on the form), not only while it answers', () => {
  const pick = (r) => {
    const radio = inputs(r.root, 'radio')[0];
    radio.checked = true;
    radio.fire('change');
    return radio;
  };

  test('(+) ready is live: data-inert false, and a click on a row is not stopped', () => {
    const r = rig();
    r.render(ask());
    assert.equal(r.root.attrs['data-inert'], 'false');
    assert.equal(inputs(r.root, 'radio')[0].fire('click').defaultPrevented, false);
  });

  test('(+) answering, answered, terminal only: inert', async () => {
    let release;
    const a = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    a.render(ask());
    pick(a);
    byText(a.root, 'Send answer').click();
    assert.equal(a.root.attrs['data-inert'], 'true', 'answering');
    release({ status: 200, body: { done: 'next', sent: 1 } });
    await settle();
    assert.equal(a.root.attrs['data-inert'], 'true', 'answered');
    const t = rig();
    t.render(ask({ bypass: true }));
    assert.equal(t.root.attrs['data-inert'], 'true', 'terminal only');
  });

  test('(+) a locking failure leaves the rows inert, and a click on one is stopped, not silently ignored', async () => {
    for (const [status, error] of [[409, 'dialog-changed'], [409, 'dialog-touched'], [409, 'dialog-focus'], [409, 'text-mode'], [409, 'text-mismatch'], [400, 'terminal-only']]) {
      const r = rig({ reply: () => ({ status, body: { error } }) });
      r.render(ask());
      const radio = pick(r);
      byText(r.root, 'Send answer').click();
      await settle();
      assert.equal(r.root.attrs['data-inert'], 'true', `${status} ${error}`);
      assert.equal(r.root.attrs['data-s'], 'failed');
      assert.equal(radio.fire('click').defaultPrevented, true, `${error}: the click is refused`);
    }
  });

  test('(+) kept (the screen is unreadable under a shown form): inert, and live again when it can be read', () => {
    const r = rig();
    r.render(ask());
    r.render(unreadable({ reason: 'cut' }));
    assert.equal(r.root.attrs['data-inert'], 'true');
    r.render(ask());
    assert.equal(r.root.attrs['data-inert'], 'false');
  });

  test('(−) a failure that lets the form try again does not dim it; a new sig after a lock does not either', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'not-taken' } }) });
    r.render(ask());
    pick(r);
    byText(r.root, 'Send answer').click();
    await settle();
    assert.equal(r.root.attrs['data-s'], 'failed');
    assert.equal(r.root.attrs['data-inert'], 'false', 'a retryable failure');
    const l = rig({ reply: () => ({ status: 409, body: { error: 'dialog-changed' } }) });
    l.render(ask());
    pick(l);
    byText(l.root, 'Send answer').click();
    await settle();
    assert.equal(l.root.attrs['data-inert'], 'true');
    l.render(ask({ sig: SIG2, question: 'Which cache?' }));
    assert.equal(l.root.attrs['data-inert'], 'false');
  });
});

// ---- the source -----------------------------------------------------------------------------------------------------------------

describe('public/dialog-form.js source', () => {
  test('(−) pure ASCII, no HTML sink, no style string, no app route named, no secret header', () => {
    assert.equal([...SRC].every((ch) => ch.codePointAt(0) < 128), true);
    const c = code(SRC);
    assert.doesNotMatch(c, /inner\s*HTML|insertAdjacent|outer\s*HTML|document\s*\.\s*write|\beval\s*\(|new\s+Function\b|setAttribute\s*\(\s*['"`]style|css\s*Text|DOMParser/);
    assert.doesNotMatch(c, /\/api\/app|__NIKA_APP__|X-Nika-App/);
    assert.doesNotMatch(c, /\.style\b/);
  });

  test('(+) it imports only the shared DOM helper and the problem-kind rule, and does nothing at import', () => {
    const imports = [...SRC.matchAll(/import \{[^}]+\} from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports, ['./dom.js', './quick-actions.js']);
    assert.doesNotMatch(code(SRC), /^document\.|^window\.|^globalThis\./m);
  });

  test('(−) it sends no key and no digit: the only route it names is the dialog tail', () => {
    const c = code(SRC);
    assert.doesNotMatch(c, /sendKey|'Escape'|"Escape"|keys:/);
    assert.deepEqual([...c.matchAll(/io\.path\('([^']+)'\)/g)].map((m) => m[1]), ['dialog']);
  });
});
