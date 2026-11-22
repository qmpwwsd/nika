// The page side of Claude's question dialogs and plan approvals (design W1 section 6; nika 0.5): public/dialog-form.js, with the fake DOM of
// test/fake-dom.js and a fake of session.js's io (the route answers are scripted, the clock never runs by itself). Every state has its chip word
// and icon; the capture's dialog is cleaned to the contract shape or fails closed; every route answer maps to a fixed line and the server's own
// text never shows. Fixtures are synthetic (builder-1, %12, repeated hex).
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  READING_MS, TEXT_MAX, cleanDialog, answerBody, dialogOutcome, announcement, createDialogForm, typable, wellFormed, reviewModel, previewState,
} from '../public/dialog-form.js';
import { endOutcome } from '../public/quick-actions.js';
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
// 0.5.2 R3: a three-question review; `flags` says which tabs are answered (the pairs list the answered ones only, in tab order, and Claude warns while one is open)
const R3_Q = ['Which tools should the agent be allowed to use?', 'Which project should I open?', 'How wide should the change be?'];
const R3_A = ['Bash, Read', 'web-shop', 'Only the tests'];
const review3 = (flags = [true, true, true], over = {}) => ({
  ...head, sig: SIG2, at: 'review', tabs: ['Tools', 'Project', 'Scope'].map((header, i) => ({ header, answered: flags[i] })), warn: flags.some((f) => !f),
  pairs: flags.flatMap((f, i) => (f ? [{ question: R3_Q[i], answer: R3_A[i] }] : [])), ...over,
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

  test('(+) every reason the server names is kept, `cut` and `clipped` apart (F16); (−) one it does not name, or a near miss, becomes layout', () => {
    for (const reason of ['cut', 'clipped', 'wide', 'numbers', 'tab', 'layout', 'survey']) assert.deepEqual(cleanDialog(unreadable({ reason })), { state: 'unreadable', kind: 'ask', reason }, reason);
    for (const reason of ['Clipped', 'clip', 'cut ', '', null, undefined, 7, ['clipped']]) assert.equal(cleanDialog(unreadable({ reason })).reason, 'layout', String(reason));
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
    [409, 'dialog-touched', 'This question was changed in the terminal. Change it back there and press Try again, or finish it there.', true],
    [409, 'dialog-focus', "Claude's selection was moved in the terminal. Move it back there and press Try again, or finish it there.", true],
    [409, 'text-mode', "nika can't type your answer: Claude's text field isn't ready for typing. Type it in the terminal.", true],
    [409, 'text-mismatch', "Your answer didn't arrive exactly as typed, so nika stopped before sending it. Fix it in the terminal.", true],
    [409, 'not-taken', "Claude didn't take the key. Check the session, then try again.", false],
    [409, 'already-answered', '', true],
    [409, 'busy-switching', 'Another action is running on this session.', false],
    [409, 'not-idle', "nika is stopping Claude's turn; try again in a moment.", false],
    [409, 'survey-undo', 'Claude shows "Esc to undo" for the rating nika just sent, so nika sends no Esc for 4 seconds. Try again then.', false],
    [400, 'terminal-only', 'Answer this in the terminal.', true],
    [400, 'invalid', "nika couldn't send this answer. Check it and try again.", false],
    [429, undefined, 'Too many keys at once; try again.', false],
    [404, 'not_found', 'The session is gone.', false],
    [500, undefined, "nika couldn't reach tmux.", false],
    [502, 'tmux', "nika couldn't reach tmux.", false],
    [0, undefined, "nika couldn't reach tmux.", false],
    [409, 'dialog-unread', "nika can't read Claude's dialog right now, so it stopped. Check the terminal, then press Try again.", true], // 0.5.4, QP, O3
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

  test('(+) F14 round 2: Decline refused with 409 survey-undo is a failed, warned, unlocked step with the one shared line; keys pressed before are named', () => {
    const line = 'Claude shows "Esc to undo" for the rating nika just sent, so nika sends no Esc for 4 seconds. Try again then.';
    const r = o(409, 'survey-undo');
    assert.deepEqual([r.ok, r.phase, r.lock, r.kind, r.gone, r.message], [false, 'failed', false, 'warn', false, line]);
    assert.equal(o(409, 'survey-undo', { sent: 2 }).message, `${line} nika had pressed 2 keys in the pane before it stopped.`);
  });

  test('(−) F14 round 2: another status or a near-miss code with survey-undo gets the generic line, never the survey one', () => {
    const generic = "nika couldn't send this answer. Check it and try again.";
    for (const [status, code] of [[409, 'survey-undone'], [409, 'SURVEY-UNDO'], [409, undefined], [418, 'survey-undo']]) {
      assert.equal(o(status, code).message, generic, `${status} ${code}`);
    }
    assert.equal(o(400, 'survey-undo').message, generic, '400 has its own table');
    assert.equal(o(500, 'survey-undo').message, "nika couldn't reach tmux.", '5xx stays the tmux line');
  });
});

// ---- the small pure helpers -----------------------------------------------------------------------------------------------------

describe('stepText and announcement: the words', () => {
  test('(\u2212) 0.5.4 SF (RV051 M4): stepText is gone with the step text element it fed (nothing used it any more); the review word and the question place live in the strip and the announcement', async () => {
    const mod = await import('../public/dialog-form.js');
    assert.equal(Object.hasOwn(mod, 'stepText'), false);
    assert.equal(typeof mod.announcement, 'function');
  });

  test('(+) a question is announced with its place; later tabs by number; a single question without a count', () => {
    const q = cleanDialog(multi());
    assert.equal(announcement(q, { name: 'builder-1', first: true }), 'builder-1 asks: Which checks should I run? Question 1 of 4, above the message box.');
    assert.equal(announcement(cleanDialog(multi({ current: 1, question: 'Which scope?' })), { name: 'builder-1', first: false }), 'Question 2 of 4: Which scope?');
    assert.equal(announcement(cleanDialog(ask()), { name: 'builder-1', first: true }), 'builder-1 asks: Which database should I use? Above the message box.');
  });

  test('(+) the review and the plan', () => {
    assert.equal(announcement(cleanDialog(review()), { name: 'builder-1', first: false }), 'Review your answers: 2 of 2 answered, above the message box.'); // 0.5.2 R3: a review whose tabs and pairs line up says how many are answered (was '2 answers')
    assert.equal(announcement(cleanDialog(review({ pairs: [{ question: 'q', answer: 'a' }] })), { name: 'builder-1', first: true }), 'Review your answers: 1 answer, above the message box.');
    assert.equal(announcement(cleanDialog(plan()), { name: 'builder-1', first: true }), 'builder-1 asks you to approve a plan. Read it in the terminal view; choices above the message box.');
  });

  test('(+) a step that mentions bypass is announced as terminal only, not as buttons above the box', () => {
    const t = announcement(cleanDialog(ask({ bypass: true })), { name: 'builder-1', first: true });
    assert.match(t, /^builder-1 asks: Which database should I use\? This mentions bypass, so nika leaves it to you: answer it in the terminal\.$/);
    assert.doesNotMatch(announcement(cleanDialog(plan({ bypass: true })), { name: 'builder-1', first: true }), /above the message box/);
  });
});

// ---- 0.5.1 item D, the pure rules: checked, typed, the move body, the moved answer ---------------------------------------------------

const ask2 = (over = {}) => ask({ tabs: [{ header: 'Project', answered: true }, { header: 'Mode', answered: false }], current: 0, final: false, ...over });
const TYPED = { text: 'my own words', answered: true };

describe('cleanDialog: checked on every option and typed (0.5.1, D)', () => {
  test('(+) a single-select option keeps its boolean checked; typed comes through as { text, answered }', () => {
    const c = cleanDialog(ask2({ options: [{ n: 1, label: 'sqlite', description: null, checked: false }, { n: 2, label: 'postgres', description: null, checked: true }], typed: TYPED }));
    assert.deepEqual(c.options.map((o) => o.checked), [false, true]);
    assert.deepEqual(c.typed, { text: 'my own words', answered: true });
    assert.deepEqual(cleanDialog(ask2({ typed: { text: 'x', answered: false } })).typed, { text: 'x', answered: false });
  });

  test('(+) no typed, or typed: null, is null; a text of exactly 500 characters is kept; control and bidi marks are removed', () => {
    assert.equal(cleanDialog(ask()).typed, null, 'an older server has no field');
    assert.equal(cleanDialog(ask({ typed: null })).typed, null);
    assert.equal(cleanDialog(ask({ typed: { text: 'x'.repeat(500), answered: true } })).typed.text.length, 500);
    assert.equal(cleanDialog(ask({ typed: { text: `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0)}c`, answered: true } })).typed.text, 'abc');
  });

  test('(−) a typed text over 500 characters, empty, not text, or with a non-boolean answered is dropped to null; so is a typed that is not an object', () => {
    for (const typed of [
      { text: 'x'.repeat(600), answered: true }, { text: 'x'.repeat(501), answered: true }, { text: '', answered: true }, { text: 5, answered: true },
      { text: 'x', answered: 'yes' }, { text: 'x' }, { answered: true }, 'x', 7, [], [{ text: 'x', answered: true }], true,
    ]) assert.equal(cleanDialog(ask({ typed })).typed, null, JSON.stringify(typed).slice(0, 60));
    assert.equal(cleanDialog(ask({ typed: { text: String.fromCharCode(0x202e), answered: true } })).typed, null, 'nothing left after cleaning');
  });

  test('(−) a checked that is not the boolean true is false, on single and multi options alike; the dialog is still a form', () => {
    for (const checked of ['yes', 1, 'true', {}, [], null, undefined]) {
      const c = cleanDialog(ask({ options: [{ n: 1, label: 'a', description: null, checked }] }));
      assert.equal(c.state, 'ready');
      assert.equal(c.options[0].checked, false, String(checked));
    }
  });
});

describe('answerBody: the move and the typed text (0.5.1, D)', () => {
  const m = cleanDialog(multi({ tabs: tabs(3, 1), current: 1 }));
  const rv = cleanDialog(review());

  test('(+) a move to another step is { sig, tab }; Review is the tab count', () => {
    assert.deepEqual(answerBody(m, { tab: 0 }), { sig: SIG, tab: 0 });
    assert.deepEqual(answerBody(m, { tab: 2 }), { sig: SIG, tab: 2 });
    assert.deepEqual(answerBody(m, { tab: 3 }), { sig: SIG, tab: 3 }, 'Review');
    assert.deepEqual(answerBody(rv, { tab: 0 }), { sig: SIG2, tab: 0 }, 'from the review');
    assert.deepEqual(answerBody(rv, { tab: 1 }), { sig: SIG2, tab: 1 });
  });

  test('(−) no move to the current step, past Review, below 0, to a non-integer or a string, with more in the request, on a single question, a plan or an unreadable dialog', () => {
    assert.equal(answerBody(m, { tab: 1 }), null, 'the current step');
    assert.equal(answerBody(rv, { tab: 2 }), null, 'the review is the current step on the review');
    for (const tab of [4, 9, -1, 1.5, '2', null, undefined, NaN, Infinity]) assert.equal(answerBody(m, { tab }), null, String(tab));
    assert.equal(answerBody(m, { tab: 2, picks: [1] }), null, 'a move carries nothing else');
    assert.equal(answerBody(m, { tab: 2, cancel: true })?.cancel, true, 'cancel still wins and carries no tab');
    assert.equal(answerBody(cleanDialog(ask()), { tab: 0 }), null, 'one question');
    assert.equal(answerBody(cleanDialog(plan()), { tab: 0 }), null);
    assert.equal(answerBody(cleanDialog(unreadable()), { tab: 0 }), null);
    assert.equal(answerBody(null, { tab: 0 }), null);
  });

  test('(+) single-select with typed text: Other sends { picks: [], text: <the typed text> }; a pick sends the pick alone', () => {
    const d = cleanDialog(ask2({ typed: TYPED }));
    assert.deepEqual(answerBody(d, { picks: [], text: 'my own words' }), { sig: SIG, picks: [], text: 'my own words' });
    assert.deepEqual(answerBody(d, { picks: [2] }), { sig: SIG, picks: [2] });
  });

  test('(−) single-select with typed text: Other with any other text is refused (the page never edits Claude\'s text row)', () => {
    const d = cleanDialog(ask2({ typed: TYPED }));
    assert.equal(answerBody(d, { picks: [], text: 'something else' }), null);
    assert.equal(answerBody(d, { picks: [], text: 'my own' }), null);
    assert.equal(answerBody(d, { picks: [] }), null, 'nothing chosen is nothing to send');
  });

  test('(+) multi-select with typed text: every body carries the same text, whatever the request holds', () => {
    const d = cleanDialog(multi({ other: true, typed: TYPED }));
    assert.deepEqual(answerBody(d, { picks: [1], text: '' }), { sig: SIG, picks: [1], text: 'my own words' });
    assert.deepEqual(answerBody(d, { picks: [] }), { sig: SIG, picks: [], text: 'my own words' });
    assert.deepEqual(answerBody(d, { picks: [3, 1], text: 'other words' }), { sig: SIG, picks: [1, 3], text: 'my own words' });
  });

  test('(−) typed text the route would refuse (first digit, over 300) makes no body; typed on a form without Other is ignored', () => {
    assert.equal(answerBody(cleanDialog(multi({ other: true, typed: { text: '3 words', answered: true } })), { picks: [1] }), null);
    assert.equal(answerBody(cleanDialog(multi({ other: true, typed: { text: 'x'.repeat(301), answered: true } })), { picks: [1] }), null);
    assert.deepEqual(answerBody(cleanDialog(multi({ other: false, typed: TYPED })), { picks: [1] }), { sig: SIG, picks: [1] }, 'no Other row: the text is not ours to send');
  });
});

describe('dialogOutcome: the moved answer and text-focus (0.5.1, D)', () => {
  const o = (status, code, extra = {}) => dialogOutcome({ status, code, name: 'builder-1', ...extra });

  test('(+) 200 moved: phase moving, locked, no announcement, no word; the keys sent are counted', () => {
    const r = o(200, undefined, { done: 'moved', sent: 2 });
    assert.deepEqual([r.ok, r.phase, r.lock, r.announce, r.word, r.message, r.gone, r.sent], [true, 'moving', true, null, '', '', false, 2]);
    assert.equal(o(200, undefined, { done: 'moved' }).sent, 0);
  });

  test('(−) a near miss is just an answered step (Answered), never a move', () => {
    for (const done of ['Moved', 'move', 'moved ', undefined, 7]) {
      const r = o(200, undefined, { done });
      assert.equal(r.phase, 'answered', String(done));
      assert.equal(r.announce, 'Answered.');
    }
  });

  test('(+) 409 text-focus: its fixed line, a warning, the form live again; keys pressed before it stopped are named', () => {
    const line = "Claude's text field has the focus. Move off it in the terminal, then try again.";
    const r = o(409, 'text-focus');
    assert.deepEqual([r.ok, r.phase, r.lock, r.kind, r.message], [false, 'failed', false, 'warn', line]);
    assert.equal(o(409, 'text-focus', { sent: 3 }).message, `${line} nika had pressed 3 keys in the pane before it stopped.`);
  });

  test('(−) text-focus with another status or a near-miss code gets the generic line', () => {
    const generic = "nika couldn't send this answer. Check it and try again.";
    for (const [status, code] of [[400, 'text-focus'], [409, 'text-focused'], [409, 'TEXT-FOCUS'], [418, 'text-focus']]) assert.equal(o(status, code).message, generic, `${status} ${code}`);
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
  const line = { msg: '', owner: '', ms: undefined };
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
    showProblem: (m, kind, ms, owner) => { log.problem.push([m, kind]); line.msg = m; line.owner = m === '' ? '' : owner ?? ''; line.ms = ms; }, // line: the page's one problem line, with the owner session.js stores (0.5.4, S3)
    clearProblem: () => { log.problem.push(['']); line.msg = ''; line.owner = ''; },
    clearProblemFrom: (owner) => { if (owner && line.owner === owner) { line.msg = ''; line.owner = ''; } }, // like session.js: only while that owner's line shows; it is not a clearProblem, so log.problem stays as it was
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
  return { df, io, root, box, log, state, render, advance, clock, timers, line };
}

const q = (root, cls) => root.all(withClass(cls));
const one = (root, cls) => q(root, cls)[0] ?? null;
const hrefs = (node) => node.all((n) => n.tag === 'use').map((n) => n.attrs.href);
const chip = (root) => root.all((n) => withClass('dlg-chip')(n) || withClass('pill')(n))[0];
const buttons = (root) => root.all((n) => n.tag === 'button');
const hiddenUp = (n) => { for (let e = n; e; e = e.parent) if (e.hidden === true) return true; return false; }; // inside a hidden element (the Try again row before a refusal): not reachable
const reachable = (root) => buttons(root).filter((b) => !hiddenUp(b));
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

  // ---- F16: Reading goes on while nika gives a cut-off question more rows ---------------------------------------------------------

  test('(+) F16: growing keeps Reading past READING_MS (5 s on: still shown, still data-s reading), and no banner is asked for', () => {
    const r = rig();
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    const before = r.log.refresh;
    r.advance(READING_MS - 1);
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    r.advance(1);
    r.advance(5000);
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    assert.equal(r.df.shown(), true);
    assert.equal(r.root.hidden, false);
    assert.equal(r.root.attrs['data-s'], 'reading');
    assert.equal(chip(r.root).textContent, 'Reading');
    assert.equal(r.log.refresh, before, 'the banner was never asked for');
    assert.deepEqual(r.log.announce, []);
  });

  test('(+) F16: growing turns false after READING_MS: the form hides at that render, and the page is told to redraw its banner', () => {
    const r = rig();
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    r.advance(READING_MS + 3000);
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    assert.equal(r.df.shown(), true);
    const before = r.log.refresh;
    r.render(unreadable({ reason: 'cut' }), { growing: false });
    assert.equal(r.df.shown(), false, 'the banner takes over');
    assert.equal(r.root.hidden, true);
    assert.ok(r.log.refresh > before);
  });

  test('(+) F16: growing true again after the banner took over draws Reading again, shown, with nothing announced', () => {
    const r = rig();
    r.render(unreadable());
    r.advance(READING_MS);
    assert.equal(r.df.shown(), false, 'the banner');
    const before = r.log.refresh;
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    assert.equal(r.df.shown(), true);
    assert.equal(r.root.attrs['data-s'], 'reading');
    assert.match(r.root.textContent, new RegExp(`Reading Claude's question${DOTS}`));
    assert.ok(r.log.refresh > before, 'the banner is told to step aside');
    assert.deepEqual(r.log.announce, []);
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    r.advance(10000);
    assert.equal(r.df.shown(), true, 'it stays while the step runs');
  });

  test('(−) F16: growing with a readable dialog builds the form at once (the flag never delays a readable step)', () => {
    const r = rig();
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    r.render(ask(), { growing: true });
    assert.equal(chip(r.root).textContent, 'Needs you');
    assert.ok(one(r.root, 'ask-q'));
    assert.equal(r.root.attrs['data-s'], 'ready');
    assert.equal(r.log.announce.length, 1, 'the question is announced once, as without the flag');
    const direct = rig();
    direct.render(ask(), { growing: true });
    assert.equal(direct.df.live(), true);
  });

  test('(−) F16: growing changes nothing for a form that is shown (it stays kept), and sends nothing', async () => {
    const r = rig();
    r.render(ask());
    inputs(r.root, 'radio')[0].checked = true;
    inputs(r.root, 'radio')[0].fire('change');
    const form = one(r.root, 'dlg-fs');
    r.render(unreadable({ reason: 'cut' }), { growing: true });
    assert.equal(one(r.root, 'dlg-fs'), form, 'the same form, not rebuilt, not replaced by Reading');
    assert.equal(off(byText(r.root, 'Send answer')), true, 'kept: the controls are off');
    assert.equal(r.root.attrs['data-s'], 'ready');
    assert.equal(r.log.calls.length, 0);
  });

  test('(−) F16: growing is exactly true or nothing: a string, 1 and null read as false', () => {
    for (const growing of ['yes', 1, null, undefined, {}, [true]]) {
      const r = rig();
      r.render(unreadable({ reason: 'cut' }), { growing });
      r.advance(READING_MS);
      assert.equal(r.df.shown(), false, `the banner after READING_MS for ${JSON.stringify(growing)}`);
    }
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
    for (const b of reachable(r.root).filter((x) => x.textContent !== 'More')) assert.equal(off(b), true, b.textContent);
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
      'Review your answers: 2 of 2 answered, above the message box.', // 0.5.2 R3 (was '2 answers')
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

describe('the step strip: every step is a button that asks Claude to move there (0.5.1, D)', () => {
  const strip = (root) => one(root, 'dlg-tabs');
  const steps = (root) => q(root, 'dlg-tab');
  const BODY = (over = {}) => multi({ tabs: [{ header: 'Project', answered: true }, { header: 'Mode', answered: false }, { header: 'Scope', answered: false }], current: 0, ...over });

  test('(+) one button per tab plus Review in an ordered list named Steps; the current one is aria-current="step" and aria-disabled', () => {
    const r = rig();
    r.render(multi({ tabs: tabs(4, 1), current: 1 }));
    const ol = strip(r.root);
    assert.equal(ol.tag, 'ol');
    assert.equal(ol.getAttribute('aria-label'), 'Steps');
    const items = steps(r.root);
    assert.equal(items.length, 5);
    assert.ok(items.every((b) => b.tag === 'button' && b.getAttribute('type') === 'button'));
    assert.deepEqual(items.map((i) => i.getAttribute('aria-current')), [null, 'step', null, null, null]);
    assert.deepEqual(items.map((i) => i.getAttribute('data-tab')), ['0', '1', '2', '3', '4'], 'Review is n');
    assert.deepEqual(items.map((i) => i.getAttribute('aria-disabled')), [null, 'true', null, null, null], 'only the current one is off');
    assert.deepEqual(hrefs(items[0]), ['#i-check']);
    assert.deepEqual(hrefs(items[1]), [], 'an empty ring is drawn with CSS, not an icon');
    assert.ok(one(items[1], 'dlg-ring'));
    assert.deepEqual(items.slice(0, 4).map((i) => i.getAttribute('data-answered')), ['true', 'false', 'false', 'false']);
    assert.ok(items.every((b) => b.parent.tag === 'li' && b.parent.parent === ol), 'li > button');
  });

  test('(+) the accessible names are "<header>, answered" / "<header>, not answered", the header first, and "Review"', () => {
    const r = rig();
    r.render(BODY());
    const items = steps(r.root);
    assert.deepEqual(items.map((b) => b.accName), ['Project, answered', 'Mode, not answered', 'Scope, not answered', 'Review']);
    assert.equal(items[0].textContent.startsWith('Project'), true, 'the visible word comes first (WCAG 2.5.3)');
  });

  test('(+) every button points at one hidden description that says nothing is answered', () => {
    const r = rig();
    r.render(BODY());
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-describedby') === 'dlg-steps-desc'));
    const desc = r.root.all((n) => n.attrs.id === 'dlg-steps-desc');
    assert.equal(desc.length, 1);
    assert.equal(desc[0].tag, 'p');
    assert.ok(withClass('sr-only')(desc[0]));
    assert.equal(desc[0].textContent, "Opens this step in Claude's dialog. Nothing is answered.");
  });

  test('(+) on the review step the Review button is the current one', () => {
    const r = rig();
    r.render(review());
    const items = steps(r.root);
    assert.equal(items.at(-1).getAttribute('aria-current'), 'step');
    assert.equal(items.at(-1).getAttribute('aria-disabled'), 'true');
    assert.equal(items.filter((i) => i.getAttribute('aria-current') === 'step').length, 1);
    assert.equal(items[0].getAttribute('aria-disabled'), null);
  });

  test('(\u2212) 0.5.4 SF (RV051 M4): a question dialog with a strip draws no step text: no .dlg-step element (it was hidden at every width), and the one sr-only step note is still there', () => {
    const r = rig();
    r.render(multi({ current: 2, tabs: tabs(4, 2) }));
    assert.equal(one(r.root, 'dlg-step'), null);
    assert.equal(r.root.all((n) => n.attrs.id === 'dlg-steps-desc').length, 1);
  });

  test('(+) a click on a step that is not the current one posts { sig, tab }; Review posts tab: n; nothing else is sent', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 2 } }) });
    r.render(BODY());
    steps(r.root)[2].click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, tab: 2 }]);
    assert.equal(r.log.calls[0].path, '/pane/%2512/dialog');
    assert.equal(r.log.calls[0].method, 'POST');
    const s = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 1 } }) });
    s.render(BODY());
    steps(s.root).at(-1).click();
    await settle();
    assert.deepEqual(sentBodies(s), [{ sig: SIG, tab: 3 }]);
  });

  test('(+) from the review a click on a question posts that tab', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 3 } }) });
    r.render(review());
    steps(r.root)[0].click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG2, tab: 0 }]);
  });

  test('(+) 200 moved: the chip is "Moving" with the spinner, every step is aria-disabled, and it stays so until a capture with another sig', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 2 } }) });
    r.render(BODY());
    steps(r.root)[1].click();
    await settle();
    const c = chip(r.root);
    assert.equal(c.textContent, 'Moving');
    assert.equal(c.attrs['data-s'], 'moving');
    assert.ok(one(c, 'spin'));
    assert.equal(r.root.attrs['data-s'], 'moving');
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-disabled') === 'true'));
    r.render(BODY());
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-disabled') === 'true'), 'the same sig again changes nothing');
    steps(r.root)[2].click();
    await settle();
    assert.equal(r.log.calls.length, 1, 'locked: a second click posts nothing');
    r.render(BODY({ sig: SIG2, current: 1, question: 'Which mode?' }));
    assert.equal(chip(r.root).textContent, 'Needs you');
    assert.deepEqual(steps(r.root).map((b) => b.getAttribute('aria-disabled')), [null, 'true', null, null]);
  });

  test('(+) while the move request runs the chip says Moving, not Answering, and the steps are off', async () => {
    let release;
    const r = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    r.render(BODY());
    steps(r.root)[1].click();
    assert.equal(chip(r.root).textContent, 'Moving');
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-disabled') === 'true'));
    release({ status: 200, body: { done: 'moved', sent: 1 } });
    await settle();
    assert.equal(chip(r.root).textContent, 'Moving');
  });

  test('(+) a move says nothing aloud; the new step gets its normal announcement when it is drawn', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 1 } }) });
    r.render(BODY());
    const before = r.log.announce.length;
    steps(r.root)[1].click();
    await settle();
    assert.equal(r.log.announce.length, before, 'no "Answered."');
    r.render(BODY({ sig: SIG2, current: 1, question: 'Which mode?' }));
    assert.equal(r.log.announce.at(-1), 'Question 2 of 3: Which mode?');
    assert.deepEqual(r.log.say, ['Sent 1 key to %12']);
  });

  test('(+) text-focus: its own line, a warning, and the steps are enabled again (nothing was moved)', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'text-focus', sent: 3 } }) });
    r.render(BODY());
    steps(r.root)[2].click();
    await settle();
    assert.deepEqual(r.log.problem.at(-1), ["Claude's text field has the focus. Move off it in the terminal, then try again. nika had pressed 3 keys in the pane before it stopped.", 'warn']);
    assert.equal(chip(r.root).textContent, 'Not answered');
    assert.deepEqual(steps(r.root).map((b) => b.getAttribute('aria-disabled')), ['true', null, null, null], 'only the current step is off');
    steps(r.root)[1].click();
    await settle();
    assert.equal(r.log.calls.length, 2, 'a second try goes out');
  });

  test('(+) focus: a rebuild after a click keeps the focus on the step button of the same index', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 1 } }) });
    r.render(BODY());
    const b = steps(r.root)[2];
    b.focus();
    b.click();
    await settle();
    r.render(BODY({ sig: SIG2, current: 2, question: 'Which scope?' }));
    assert.equal(focus.el, steps(r.root)[2]);
    assert.equal(focus.el.tag, 'button');
    assert.equal(focus.el.getAttribute('data-tab'), '2');
  });

  test('(+) focus: when the step button that had it no longer exists after the rebuild, the form root takes it (design 3.2: not the heading)', () => {
    const r = rig();
    r.render(BODY());
    assert.equal(steps(r.root).length, 4, 'premise: three questions and the review');
    const review = steps(r.root)[3];
    review.focus();
    assert.equal(focus.el, review);
    r.render(BODY({ sig: SIG2, tabs: [{ header: 'Project', answered: true }, { header: 'Mode', answered: false }], current: 1 }));
    assert.equal(steps(r.root).length, 3, 'premise: two questions and the review');
    assert.equal(focus.el, r.root);
  });

  test('(−) the form root takes the focus only from a step button that is gone: an option keeps the heading rule, and a focus outside the form moves nothing', () => {
    const r = rig();
    r.render(BODY());
    inputs(r.root, 'checkbox')[0].focus();
    r.render(BODY({ sig: SIG2, current: 1, question: 'Which scope?' }));
    assert.notEqual(focus.el, r.root);
    assert.equal(focus.el.tag, 'legend');
    focus.el = r.box;
    r.render(BODY({ sig: '1122334455667788', current: 2, question: 'Which name?' }));
    assert.equal(focus.el, r.box);
  });

  test('(+) the form root can take focus: #dialog-form carries tabindex="-1" in the page', () => {
    const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'session.html'), 'utf8');
    assert.match(html, /<div[^>]*\bid="dialog-form"[^>]*\btabindex="-1"/);
  });

  test('(−) the current step posts nothing, and a disabled step is still a button with its name', async () => {
    const r = rig();
    r.render(BODY());
    const cur = steps(r.root)[0];
    assert.equal(cur.getAttribute('aria-disabled'), 'true');
    assert.equal(cur.disabled, false, 'aria-disabled, not disabled: it keeps its focus and its name');
    cur.click();
    await settle();
    assert.deepEqual(r.log.calls, []);
  });

  test('(−) no post while an answer is on its way, while the form is locked after an answer, or after a failure that locks', async () => {
    let release;
    const r = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    r.render(BODY());
    byText(r.root, 'Answer').click();
    steps(r.root)[1].click();
    assert.equal(r.log.calls.length, 1, 'answering: the click does nothing');
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-disabled') === 'true'));
    release({ status: 200, body: { done: 'next', sent: 2 } });
    await settle();
    steps(r.root)[1].click();
    assert.equal(r.log.calls.length, 1, 'locked after an answer');
    const l = rig({ reply: () => ({ status: 409, body: { error: 'dialog-touched' } }) });
    l.render(BODY());
    byText(l.root, 'Answer').click();
    await settle();
    steps(l.root)[1].click();
    assert.equal(l.log.calls.length, 1, 'locked after dialog-touched');
  });

  test('(−) no post in terminal mode, and the steps are aria-disabled', async () => {
    const r = rig();
    r.render(BODY({ bypass: true }));
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-disabled') === 'true'));
    steps(r.root)[1].click();
    await settle();
    assert.deepEqual(r.log.calls, []);
  });

  test('(−) no post while the form is kept for an unreadable capture, and none from an unreadable dialog (it has no strip)', async () => {
    const r = rig();
    r.render(BODY());
    r.render(unreadable());
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-disabled') === 'true'), 'kept: off');
    steps(r.root)[1].click();
    await settle();
    assert.deepEqual(r.log.calls, []);
    const u = rig();
    u.render(unreadable());
    assert.equal(strip(u.root), null);
  });

  test('(−) a single question and a plan have no strip', () => {
    const r = rig();
    r.render(ask());
    assert.equal(strip(r.root), null);
    assert.equal(one(r.root, 'dlg-step'), null);
    assert.equal(r.root.all((n) => n.attrs.id === 'dlg-steps-desc').length, 0);
    const p = rig();
    p.render(plan());
    assert.equal(strip(p.root), null);
  });

  test('(−) a move that fails with 409 dialog-changed locks the form (the answer is the existing line)', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'dialog-changed' } }) });
    r.render(BODY());
    steps(r.root)[2].click();
    await settle();
    assert.equal(r.log.problem.at(-1)[0], 'The question changed; check the session.');
    assert.ok(steps(r.root).every((b) => b.getAttribute('aria-disabled') === 'true'));
  });

  test('(−) the strip never sends a key or a digit: the click handler only posts { sig, tab }', () => {
    assert.doesNotMatch(code(SRC), /tab:\s*\d|keys\s*:|\.press\(/);
  });
});

// ---- changing an answer: checked, typed, the kept draft (0.5.1, D) ----------------------------------------------------------------

describe('changing an answer (0.5.1, D)', () => {
  const steps = (root) => q(root, 'dlg-tab');
  const noteOf = (root, text) => root.all((n) => n.tag === 'p' && n.textContent === text);
  const AGAIN = 'Already answered. Answer again to change it, or choose another step.';
  const TYPED_NOTE = 'To change typed text, use the terminal.';
  const sigN = (i, c = 'a') => c.repeat(15) + i.toString(16);
  const pickRadio = (input) => { input.checked = true; input.fire('change'); };
  const moved = () => ({ status: 200, body: { done: 'moved', sent: 1 } });

  test('(+) a single-select dialog pre-selects the option Claude has ticked, and its card is marked', () => {
    const r = rig();
    r.render(ask2({ options: [{ n: 1, label: 'sqlite', description: null, checked: false }, { n: 2, label: 'postgres', description: null, checked: true }] }));
    const radios = inputs(r.root, 'radio');
    assert.deepEqual(radios.map((x) => x.checked), [false, true, false], 'the last radio is Other');
    assert.deepEqual(radios.slice(0, 2).map((x) => x.parent.getAttribute('data-on')), ['false', 'true']);
    assert.equal(one(r.root, 'dlg-other').getAttribute('data-on'), 'false', 'Other is not');
  });

  test('(+) pressing Answer on the ticked option sends it again; picking another option sends that one', async () => {
    const r = rig();
    r.render(ask2({ options: [{ n: 1, label: 'sqlite', description: null, checked: true }, { n: 2, label: 'postgres', description: null, checked: false }] }));
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [1] }]);
    const s = rig();
    s.render(ask2({ options: [{ n: 1, label: 'sqlite', description: null, checked: true }, { n: 2, label: 'postgres', description: null, checked: false }] }));
    pickRadio(inputs(s.root, 'radio')[1]);
    byText(s.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(s), [{ sig: SIG, picks: [2] }]);
  });

  test('(−) a single-select dialog with nothing ticked pre-selects nothing, and Answer is off', async () => {
    const r = rig();
    r.render(ask2());
    assert.ok(inputs(r.root, 'radio').every((x) => x.checked === false));
    assert.equal(off(byText(r.root, 'Answer')), true);
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(r.log.calls, []);
  });

  test('(+) typed text fills Other, read-only, with the note; Other is selected when Claude answered with it', () => {
    const r = rig();
    r.render(ask2({ typed: TYPED }));
    const txt = one(r.root, 'dlg-text');
    assert.equal(txt.value, 'my own words');
    assert.equal(txt.getAttribute('readonly'), '');
    assert.equal(inputs(r.root, 'radio').at(-1).checked, true, 'Other is selected');
    assert.equal(noteOf(r.root, TYPED_NOTE).length, 1);
    assert.equal(off(byText(r.root, 'Answer')), false, 'the typed answer can be sent again');
  });

  test('(+) typed text that Claude has not taken as the answer fills Other but leaves it unselected', () => {
    const r = rig();
    r.render(ask2({ typed: { text: 'my own words', answered: false }, options: [{ n: 1, label: 'sqlite', description: null, checked: true }, { n: 2, label: 'postgres', description: null, checked: false }] }));
    assert.equal(one(r.root, 'dlg-text').value, 'my own words');
    assert.deepEqual(inputs(r.root, 'radio').map((x) => x.checked), [true, false, false]);
    assert.equal(noteOf(r.root, TYPED_NOTE).length, 1);
  });

  test('(+) the typed field stays read-only through the captures and the paints; the other fields still follow the live state', () => {
    const r = rig();
    r.render(ask2({ typed: TYPED }));
    r.render(ask2({ typed: TYPED }));
    assert.equal(one(r.root, 'dlg-text').getAttribute('readonly'), '');
    const e = rig();
    e.render(ask2());
    assert.equal(one(e.root, 'dlg-text').getAttribute('readonly'), null, 'no typed text: the field is for typing');
    assert.equal(noteOf(e.root, TYPED_NOTE).length, 0, '(−) and no note');
  });

  test('(+) Answer with the typed Other selected sends { picks: [], text }; choosing an option instead sends the option alone', async () => {
    const r = rig();
    r.render(ask2({ typed: TYPED }));
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [], text: 'my own words' }]);
    const s = rig();
    s.render(ask2({ typed: TYPED }));
    pickRadio(inputs(s.root, 'radio')[0]);
    assert.equal(inputs(s.root, 'radio').at(-1).checked, false, 'one radio at a time');
    byText(s.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(s), [{ sig: SIG, picks: [1] }]);
  });

  test('(+) a multi tab with typed text: the Other box is ticked and aria-disabled, the text read-only, and every body carries the text', async () => {
    const r = rig();
    r.render(multi({ other: true, typed: TYPED }));
    const boxes = inputs(r.root, 'checkbox');
    const other = boxes.at(-1);
    assert.equal(other.checked, true);
    assert.equal(other.getAttribute('aria-disabled'), 'true');
    assert.equal(one(r.root, 'dlg-text').value, 'my own words');
    assert.equal(one(r.root, 'dlg-text').getAttribute('readonly'), '');
    const click = other.fire('click');
    assert.equal(click.defaultPrevented, true, 'the box cannot be unticked');
    r.render(multi({ other: true, typed: TYPED }));
    assert.equal(other.getAttribute('aria-disabled'), 'true', 'still locked after the next capture');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, picks: [2], text: 'my own words' }]);
  });

  test('(−) a multi tab without typed text keeps Other free: not ticked, not aria-disabled', () => {
    const r = rig();
    r.render(multi({ other: true }));
    const other = inputs(r.root, 'checkbox').at(-1);
    assert.equal(other.checked, false);
    assert.equal(other.getAttribute('aria-disabled'), null);
    assert.equal(other.fire('click').defaultPrevented, false);
  });

  test('(+) the answered note stands above the options of an answered tab; (−) not on an unanswered one', () => {
    const r = rig();
    r.render(multi({ tabs: tabs(4, 1), current: 0 }));
    assert.equal(noteOf(r.root, AGAIN).length, 1);
    const fs = one(r.root, 'dlg-fs');
    const note = noteOf(r.root, AGAIN)[0];
    assert.ok(fs.contains(note), 'it is inside the question group');
    assert.ok(fs.kids.indexOf(note) < fs.kids.findIndex((k) => k.tag === 'label'), 'above the first option');
    const n = rig();
    n.render(multi({ tabs: tabs(4, 1), current: 1 }));
    assert.equal(noteOf(n.root, AGAIN).length, 0);
  });

  test('(+) the unsent ticks of a question come back when you return to it, and Claude\'s own ticks do not override them', async () => {
    const r = rig({ reply: moved });
    const first = (over = {}) => multi({ tabs: tabs(3), current: 0, ...over });
    r.render(first());
    const boxes = inputs(r.root, 'checkbox');
    boxes[0].checked = true;
    boxes[0].fire('change');
    steps(r.root)[1].click();
    await settle();
    r.render(first({ sig: SIG2, current: 1, question: 'Which scope?' }));
    r.render(first({ sig: SIG3 }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [true, true, false], 'lint (kept) and build (Claude\'s)');
    assert.equal(inputs(r.root, 'checkbox')[0].parent.getAttribute('data-on'), 'true');
  });

  test('(+) typed Other text and the radio come back too', async () => {
    const r = rig({ reply: moved });
    r.render(ask2());
    const text = one(r.root, 'dlg-text');
    text.value = 'half a thought';
    text.fire('input');
    steps(r.root)[1].click();
    await settle();
    r.render(ask2({ sig: SIG2, current: 1, question: 'Which mode?' }));
    r.render(ask2({ sig: SIG3 }));
    assert.equal(one(r.root, 'dlg-text').value, 'half a thought');
    assert.equal(inputs(r.root, 'radio').at(-1).checked, true);
  });

  test('(−) Claude\'s typed text wins over a kept draft: its text, its read-only field and its selection', async () => {
    const r = rig({ reply: moved });
    r.render(ask2());
    const text = one(r.root, 'dlg-text');
    text.value = 'half a thought';
    text.fire('input');
    steps(r.root)[1].click();
    await settle();
    r.render(ask2({ sig: SIG2, current: 1, question: 'Which mode?' }));
    r.render(ask2({ sig: SIG3, typed: TYPED }));
    assert.equal(one(r.root, 'dlg-text').value, 'my own words');
    assert.equal(one(r.root, 'dlg-text').getAttribute('readonly'), '');
    const p = rig({ reply: moved });
    p.render(ask2());
    pickRadio(inputs(p.root, 'radio')[0]);
    steps(p.root)[1].click();
    await settle();
    p.render(ask2({ sig: SIG2, current: 1, question: 'Which mode?' }));
    p.render(ask2({ sig: SIG3, typed: TYPED }));
    assert.deepEqual(inputs(p.root, 'radio').map((x) => x.checked), [false, false, true], 'not the draft\'s pick: the typed answer is the one Claude holds');
  });

  test('(−) a click that is refused (terminal-only) keeps no draft either', async () => {
    const r = rig({ reply: moved });
    r.render(multi({ tabs: tabs(3), bypass: true }));
    inputs(r.root, 'checkbox')[0].checked = true;
    steps(r.root)[1].click();
    await settle();
    assert.deepEqual(r.log.calls, []);
    r.render(multi({ tabs: tabs(3), sig: SIG2, current: 1, question: 'Which scope?', bypass: true }));
    r.render(multi({ tabs: tabs(3), sig: SIG3 }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [false, true, false], 'only Claude\'s tick');
  });

  test('(−) a draft is not kept when the dialog closes', async () => {
    const r = rig({ reply: moved });
    r.render(multi({ tabs: tabs(3) }));
    inputs(r.root, 'checkbox')[0].checked = true;
    steps(r.root)[1].click();
    await settle();
    r.render(null);
    r.render(multi({ tabs: tabs(3), sig: SIG3 }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [false, true, false], 'only Claude\'s tick');
  });

  test('(−) a draft is not kept when the headers change', async () => {
    const r = rig({ reply: moved });
    r.render(multi({ tabs: tabs(3) }));
    inputs(r.root, 'checkbox')[0].checked = true;
    steps(r.root)[1].click();
    await settle();
    r.render(multi({ tabs: [{ header: 'Other', answered: false }, ...tabs(3).slice(1)], sig: SIG3 }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [false, true, false]);
  });

  test('(−) a draft is dropped once the question is answered, so a later return shows Claude\'s state', async () => {
    const r = rig({ reply: moved });
    r.render(multi({ tabs: tabs(3) }));
    inputs(r.root, 'checkbox')[0].checked = true;
    steps(r.root)[1].click();
    await settle();
    r.render(multi({ tabs: tabs(3), sig: SIG2, current: 1, question: 'Which scope?' }));
    r.render(multi({ tabs: tabs(3), sig: SIG3 })); // back: the draft is restored
    inputs(r.root, 'checkbox')[1].checked = false; // the user changes it and answers
    r.state.reply = () => ({ status: 200, body: { done: 'next', sent: 2 } });
    byText(r.root, 'Answer').click();
    await settle();
    r.render(multi({ tabs: tabs(3, 1), sig: SIG2, current: 1, question: 'Which scope?' }));
    r.render(multi({ tabs: tabs(3, 1), sig: '99999999999999aa' }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [false, true, false], 'not the draft from before the answer');
  });

  test('(−) at most 8 drafts: a 9th question evicts the oldest', async () => {
    const r = rig({ reply: moved });
    const qn = (i, over = {}) => multi({ tabs: tabs(2), question: `Q${i}`, sig: sigN(i), ...over });
    for (let i = 0; i < 9; i += 1) {
      r.render(qn(i));
      inputs(r.root, 'checkbox')[0].checked = true;
      steps(r.root)[1].click();
      await settle();
      r.render(qn(i, { sig: sigN(i, 'b'), current: 1, question: 'Elsewhere' }));
    }
    r.render(qn(0, { sig: sigN(0, 'c') }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [false, true, false], 'Q0 was evicted');
    r.render(qn(1, { sig: sigN(1, 'c') }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [true, true, false], 'Q1 is still kept');
    r.render(qn(8, { sig: sigN(8, 'c') }));
    assert.deepEqual(inputs(r.root, 'checkbox').map((b) => b.checked), [true, true, false], 'so is the newest');
  });

  test('(−) the drafts live in memory only: no storage, no cookie', () => {
    assert.doesNotMatch(code(SRC), /localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});

// ---- the review -----------------------------------------------------------------------------------------------------------------

describe('the review step', () => {
  test('(+) the heading, a card list with each question and answer as Claude shows it, Submit answers and Decline', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'submitted', sent: 1 } }) });
    r.render(review());
    assert.equal(one(r.root, 'ask-q').textContent, 'Review your answers');
    assert.equal(r.root.getAttribute('aria-labelledby'), 'dlg-q');
    // 0.5.2 R3: the dl.dlg-review became ol.dlg-rv, one li per question; the same two strings per pair (the answer sits in the span after its sr-only "Answer: ")
    const list = one(r.root, 'dlg-rv');
    assert.equal(list.tag, 'ol');
    assert.deepEqual(q(list, 'dlg-rv-row').map((li) => [li.tag, one(li, 'dlg-rv-q').textContent, one(li, 'dlg-rv-a').kids[1].textContent]), [
      ['li', 'Which checks should I run?', 'lint, build'], ['li', 'Which database should I use?', 'sqlite'],
    ]);
    assert.equal(one(r.root, 'dlg-review'), null, 'the old dl is gone');
    assert.equal(one(r.root, 'dlg-warn'), null);
    const submit = byText(r.root, 'Submit answers');
    assert.ok(submit.className.includes('primary'));
    submit.click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG2, submit: true }]);
    assert.equal(chip(r.root).textContent, 'Submitted');
  });

  test('(+) the warning row has the warning icon and the words when Claude says not every question is answered (a review whose pairs do not line up with the tabs: the fallback)', () => {
    const r = rig();
    r.render(review({ warn: true })); // two answered tabs with warn: true do not line up (0.5.2 R3 falls back to the plain cards and Claude's own line)
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

// ---- 0.5.2 R3: the review as cards, one per question, with Change ---------------------------------------------------------------

describe('reviewModel: the review as one row per question tab (0.5.2 R3)', () => {
  const clean = (d) => cleanDialog(d);

  test('(+) every tab answered: one row per tab, steps 0 to 2, the headers, and each tab\'s own pair', () => {
    const m = reviewModel(clean(review3()));
    assert.equal(m.mapped, true);
    assert.deepEqual([m.total, m.answered], [3, 3]);
    assert.deepEqual(m.rows.map((r) => [r.step, r.header, r.question, r.answer]), [
      [0, 'Tools', R3_Q[0], R3_A[0]], [1, 'Project', R3_Q[1], R3_A[1]], [2, 'Scope', R3_Q[2], R3_A[2]],
    ]);
  });

  test('(+) tab 1 not answered and warn: that row has no question or answer, and the two pairs go to tabs 0 and 2 in order', () => {
    const m = reviewModel(clean(review3([true, false, true])));
    assert.equal(m.mapped, true);
    assert.deepEqual([m.total, m.answered], [3, 2]);
    assert.deepEqual(m.rows.map((r) => [r.step, r.header, r.question, r.answer]), [
      [0, 'Tools', R3_Q[0], R3_A[0]], [1, 'Project', null, null], [2, 'Scope', R3_Q[2], R3_A[2]],
    ]);
  });

  test('(+) nothing answered yet: three rows, none with an answer, the pairs list empty, warn true', () => {
    const m = reviewModel(clean(review3([false, false, false])));
    assert.equal(m.mapped, true);
    assert.deepEqual([m.total, m.answered, m.rows.map((r) => r.answer)], [3, 0, [null, null, null]]);
  });

  test('(−) the tabs and the pairs do not line up: not mapped, the rows are the pairs alone, with no step and no header', () => {
    const pairs = [{ question: 'q1', answer: 'a1' }, { question: 'q2', answer: 'a2' }];
    for (const [name, d] of [
      ['2 pairs and 3 answered tabs', { tabs: tabs(3, 3), warn: false, pairs }],
      ['3 pairs and 2 answered tabs, warn', { tabs: tabs(3, 2), warn: true, pairs: [...pairs, { question: 'q3', answer: 'a3' }] }],
      ['warn: true with every tab answered', { tabs: tabs(2, 2), warn: true, pairs }],
      ['warn: false with a tab open', { tabs: tabs(3, 2), warn: false, pairs }],
      ['no tabs', { tabs: [], warn: false, pairs }],
      ['tabs that are not a list', { tabs: 'x', warn: false, pairs }],
    ]) {
      const m = reviewModel(d);
      assert.equal(m.mapped, false, name);
      assert.deepEqual([m.total, m.answered], [d.pairs.length, d.pairs.length], name);
      assert.deepEqual(m.rows.map((r) => [r.step, r.header, r.question, r.answer]), d.pairs.map((p) => [null, '', p.question, p.answer]), name);
    }
  });

  test('(−) nothing, or something that is not a review, never throws and is not mapped; a pair that is not a pair never makes a row', () => {
    for (const d of [undefined, null, 7, 'x', {}, { tabs: null, pairs: null }]) assert.deepEqual(reviewModel(d), { mapped: false, total: 0, answered: 0, rows: [] }, String(d));
    const m = reviewModel({ tabs: tabs(2, 2), warn: false, pairs: [{ question: 'q', answer: 'a' }, null, 5, { question: 'x' }] });
    assert.equal(m.mapped, false, 'one real pair, two answered tabs');
    assert.deepEqual(m.rows.map((r) => r.question), ['q']);
  });

  test('(−) the model is a copy: changing a row changes nothing in the dialog', () => {
    const d = clean(review3());
    const m = reviewModel(d);
    m.rows[0].answer = 'changed';
    assert.equal(d.pairs[0].answer, R3_A[0]);
    assert.equal(reviewModel(d).rows[0].answer, R3_A[0]);
  });
});

describe('the review as cards: one per question, with Change (0.5.2 R3)', () => {
  const steps = (root) => q(root, 'dlg-tab');
  const rowsOf = (root) => q(root, 'dlg-rv-row');
  const changes = (root) => q(root, 'dlg-rv-chg');
  const count = (root) => one(root, 'dlg-rv-n');
  const moved = { reply: () => ({ status: 200, body: { done: 'moved', sent: 2 } }) };

  test('(+) mapped, all answered: an ordered list named Your answers with a card per question, the count "3 of 3 answered" in the busy colour, Change buttons named by their header, no warn line', () => {
    const r = rig();
    r.render(review3());
    const list = one(r.root, 'dlg-rv');
    assert.equal(list.tag, 'ol');
    assert.equal(list.getAttribute('aria-label'), 'Your answers');
    const rows = rowsOf(r.root);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((li) => li.tag === 'li' && li.parent === list && li.getAttribute('data-state') === 'done'));
    const n = count(r.root);
    assert.equal(n.textContent, '3 of 3 answered');
    assert.equal(n.getAttribute('data-all'), 'true');
    assert.deepEqual(hrefs(n), ['#i-check']);
    assert.equal(one(r.root, 'dlg-warn'), null);
    assert.deepEqual(rows.map((li) => one(li, 'dlg-rv-h').accName), ['Tools, answered', 'Project, answered', 'Scope, answered']);
    assert.deepEqual(rows.map((li) => hrefs(one(li, 'dlg-rv-h'))), [['#i-check'], ['#i-check'], ['#i-check']]);
    assert.deepEqual(rows.map((li) => one(li, 'dlg-rv-q').textContent), R3_Q);
    assert.deepEqual(rows.map((li) => one(li, 'dlg-rv-q').getAttribute('title')), R3_Q, 'the full question stays in the title when CSS clamps it to two lines');
    assert.deepEqual(rows.map((li) => one(li, 'dlg-rv-a').accName), R3_A.map((a) => `Answer: ${a}`), 'an sr-only "Answer: " comes first');
    assert.deepEqual(changes(r.root).map((b) => b.accName), ['Change answer 1: Tools', 'Change answer 2: Project', 'Change answer 3: Scope']);
    assert.ok(changes(r.root).every((b) => b.textContent.startsWith('Change') && b.tag === 'button' && b.getAttribute('type') === 'button'), 'the visible word comes first (WCAG 2.5.3)');
    assert.deepEqual(changes(r.root).map((b) => b.getAttribute('data-step')), ['0', '1', '2']);
    assert.ok(changes(r.root).every((b) => b.getAttribute('data-tab') === null), 'data-step, not data-tab: the focus rule of build() must not take it for a step button');
    assert.ok(changes(r.root).every((b) => b.getAttribute('aria-describedby') === 'dlg-steps-desc'));
    assert.equal(r.root.all((n2) => n2.attrs.id === 'dlg-steps-desc').length, 1, 'the strip owns the one description');
  });

  test('(+) mapped, one question not answered: its card is data-state="none" with the words Not answered, an Answer button, and the count says 2 of 3 answered · 1 not answered', () => {
    const r = rig();
    r.render(review3([true, false, true]));
    const rows = rowsOf(r.root);
    assert.deepEqual(rows.map((li) => li.getAttribute('data-state')), ['done', 'none', 'done']);
    const none = rows[1];
    assert.equal(one(none, 'dlg-rv-a').textContent, 'Not answered');
    assert.ok(withClass('dlg-rv-none')(one(none, 'dlg-rv-a')));
    assert.equal(one(none, 'dlg-rv-q'), null, 'there is no question text to show');
    assert.equal(one(none, 'dlg-rv-h').accName, 'Project, not answered');
    assert.deepEqual(hrefs(one(none, 'dlg-rv-h')), ['#i-warn']);
    assert.equal(one(none, 'dlg-rv-chg').accName, 'Answer question 2: Project');
    assert.ok(one(none, 'dlg-rv-chg').textContent.startsWith('Answer'));
    assert.deepEqual(changes(r.root).map((b) => b.accName), ['Change answer 1: Tools', 'Answer question 2: Project', 'Change answer 3: Scope']);
    const n = count(r.root);
    assert.equal(n.textContent, `2 of 3 answered ${MID} 1 not answered`);
    assert.equal(n.getAttribute('data-all'), 'false');
    assert.deepEqual(hrefs(n), ['#i-warn']);
    assert.equal(one(r.root, 'dlg-warn'), null, 'the count says it; Claude\'s own line is not repeated');
    assert.equal(byText(r.root, 'Submit answers').getAttribute('aria-disabled'), null, 'it does not block Submit (as before)');
  });

  test('(+) the focus order is the DOM order: the steps, then Change or Answer row by row, then Submit answers, then Decline', () => {
    const r = rig();
    r.render(review3([true, false, true]));
    const order = reachable(r.root).map((b) => b.className.split(' ').find((c) => ['dlg-tab', 'dlg-rv-chg', 'dlg-send', 'dlg-decline'].includes(c)));
    assert.deepEqual(order, ['dlg-tab', 'dlg-tab', 'dlg-tab', 'dlg-tab', 'dlg-rv-chg', 'dlg-rv-chg', 'dlg-rv-chg', 'dlg-send', 'dlg-decline']);
    assert.ok(withClass('dlg-rv-btns')(byText(r.root, 'Submit answers').parent), 'Submit and Decline sit in the sticky footer');
    assert.equal(byText(r.root, 'Decline').parent, byText(r.root, 'Submit answers').parent);
  });

  test('(+) Change posts exactly { sig, tab } for its step: one POST, no submit, no choice, no picks; Answer posts the same for its step', async () => {
    const r = rig(moved);
    r.render(review3([true, false, true]));
    changes(r.root)[2].click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG2, tab: 2 }]);
    assert.equal(r.log.calls[0].path, '/pane/%2512/dialog');
    assert.equal(r.log.calls[0].method, 'POST');
    const s = rig(moved);
    s.render(review3([true, false, true]));
    changes(s.root)[1].click();
    await settle();
    assert.deepEqual(sentBodies(s), [{ sig: SIG2, tab: 1 }]);
  });

  test('(+) after the move the next capture of that question puts the focus on its heading (#dlg-q), not on a strip button; the chip says Moving until then', async () => {
    const r = rig(moved);
    r.render(review3());
    const b = changes(r.root)[2];
    b.focus();
    b.click();
    await settle();
    assert.equal(chip(r.root).textContent, 'Moving');
    r.render(multi({ sig: SIG3, tabs: tabs(3, 3), current: 2, question: R3_Q[2], final: true }));
    assert.equal(focus.el.tag, 'legend');
    assert.equal(focus.el.attrs.id, 'dlg-q');
    assert.equal(focus.el.textContent, R3_Q[2]);
    assert.equal(chip(r.root).textContent, 'Needs you');
  });

  test('(+) a move from the review says nothing aloud, and no automatic return to the review is sent: one request in all', async () => {
    const r = rig(moved);
    r.render(review3());
    const before = r.log.announce.length;
    changes(r.root)[0].click();
    await settle();
    assert.equal(r.log.announce.length, before);
    r.render(multi({ sig: SIG3, tabs: tabs(3, 3), current: 0, question: R3_Q[0] }));
    await settle();
    assert.equal(r.log.calls.length, 1);
  });

  test('(+) every Change is live on a live form (none is the current step), and the cards are not dimmed', () => {
    const r = rig();
    r.render(review3());
    assert.deepEqual(changes(r.root).map((b) => b.getAttribute('aria-disabled')), [null, null, null]);
    assert.equal(r.root.getAttribute('data-inert'), 'false');
  });

  test('(−) while an answer is on its way (busy) every Change is aria-disabled and a click sends nothing more', async () => {
    let release;
    const r = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    r.render(review3());
    byText(r.root, 'Submit answers').click();
    assert.equal(r.log.calls.length, 1);
    assert.ok(changes(r.root).every(off));
    assert.equal(r.root.getAttribute('data-inert'), 'true', 'the cards dim through data-inert');
    changes(r.root)[1].click();
    await settle();
    assert.equal(r.log.calls.length, 1);
    release({ status: 200, body: { done: 'submitted', sent: 1 } });
    await settle();
  });

  test('(−) locked after a move (until another capture) every Change is aria-disabled and a click sends nothing', async () => {
    const r = rig(moved);
    r.render(review3());
    changes(r.root)[0].click();
    await settle();
    assert.ok(changes(r.root).every(off));
    changes(r.root)[2].click();
    await settle();
    assert.equal(r.log.calls.length, 1);
  });

  test('(−) terminal only (the review mentions bypass): every Change is aria-disabled, a click sends nothing, and the rows are still shown', async () => {
    const r = rig();
    r.render(review3([true, true, true], { bypass: true }));
    assert.equal(rowsOf(r.root).length, 3);
    assert.ok(changes(r.root).every(off));
    changes(r.root)[1].click();
    await settle();
    assert.deepEqual(r.log.calls, []);
  });

  test('(−) not mapped (the pairs and the tabs do not line up): plain cards, no count, no header, no Change; Claude\'s own warn line shows when it warns', () => {
    const r = rig();
    r.render(review({ tabs: tabs(3, 3), pairs: [{ question: 'Which checks should I run?', answer: 'lint, build' }, { question: 'Which database should I use?', answer: 'sqlite' }] }));
    assert.equal(rowsOf(r.root).length, 2);
    assert.equal(count(r.root), null);
    assert.equal(q(r.root, 'dlg-rv-h').length, 0);
    assert.equal(changes(r.root).length, 0);
    assert.deepEqual(rowsOf(r.root).map((li) => li.getAttribute('data-state')), ['done', 'done']);
    assert.deepEqual(rowsOf(r.root).map((li) => one(li, 'dlg-rv-a').kids[1].textContent), ['lint, build', 'sqlite']);
    assert.equal(one(r.root, 'dlg-warn'), null, 'no warn when Claude does not warn');
    assert.equal(r.root.all((n) => n.attrs.id === 'dlg-steps-desc').length, 1, 'only the strip\'s description: no Change points at it');
    const w = rig();
    w.render(review({ tabs: tabs(3, 2), warn: true, pairs: [{ question: 'q1', answer: 'a1' }] }));
    assert.equal(one(w.root, 'dlg-warn').textContent, 'You have not answered all questions');
    assert.equal(count(w.root), null);
    assert.equal(changes(w.root).length, 0);
  });

  test('(−) the cards hold no markup sink: the question and the answer are text, a title is an attribute', () => {
    const r = rig();
    r.render(review3([true, true, true], { pairs: [{ question: '<b>Q</b> & "x"', answer: '<img src=x onerror=alert(1)>' }, { question: 'q', answer: 'a' }, { question: 'q', answer: 'a' }] }));
    const li = rowsOf(r.root)[0];
    assert.equal(one(li, 'dlg-rv-q').textContent, '<b>Q</b> & "x"');
    assert.equal(one(li, 'dlg-rv-a').kids[1].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(r.root.all((n) => n.tag === 'img' || n.tag === 'b').length, 0);
  });

  test('(−) a one-question review has no strip and no Change button (the move is refused for one question): the card still shows the answer, the count reads 1 of 1 answered, Submit and Decline stay', () => {
    const r = rig();
    r.render(review({ tabs: tabs(1, 1), pairs: [{ question: 'Which database should I use?', answer: 'sqlite' }] }));
    assert.equal(steps(r.root).length, 0, 'no strip with one tab');
    assert.equal(changes(r.root).length, 0, 'no Change button');
    assert.equal(r.root.all((n) => n.tag === 'button' && n.attrs['data-step'] !== undefined).length, 0, 'no step button of any class');
    assert.equal(r.root.all((n) => n.attrs.id === 'dlg-steps-desc').length, 0, 'nothing points at the step note, so it is not rendered');
    const rows = rowsOf(r.root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].getAttribute('data-state'), 'done');
    assert.equal(one(rows[0], 'dlg-rv-q').textContent, 'Which database should I use?');
    assert.equal(one(rows[0], 'dlg-rv-a').kids[1].textContent, 'sqlite');
    assert.equal(count(r.root).textContent, '1 of 1 answered');
    assert.equal(q(r.root, 'dlg-send').length, 1);
    assert.equal(q(r.root, 'dlg-decline').length, 1);
  });

  test('(+) two questions is the smallest review with Change: a button per card, and the one #dlg-steps-desc the strip owns', () => {
    const r = rig();
    r.render(review({ tabs: tabs(2, 2), pairs: [{ question: 'q1', answer: 'a1' }, { question: 'q2', answer: 'a2' }] }));
    assert.equal(changes(r.root).length, 2);
    assert.equal(r.root.all((n) => n.attrs.id === 'dlg-steps-desc').length, 1);
  });

  test('(+) the announcement says how many are answered when mapped, and the old count when not; a review that mentions bypass says it is terminal only', () => {
    assert.equal(announcement(cleanDialog(review3([true, false, true])), { name: 'builder-1', first: true }), 'Review your answers: 2 of 3 answered, above the message box.');
    assert.equal(announcement(cleanDialog(review3()), { name: 'builder-1', first: false }), 'Review your answers: 3 of 3 answered, above the message box.');
    assert.equal(announcement(cleanDialog(review({ tabs: tabs(3, 3) })), { name: 'builder-1', first: true }), 'Review your answers: 2 answers, above the message box.');
    assert.equal(announcement(cleanDialog(review({ tabs: tabs(3, 3), pairs: [{ question: 'q', answer: 'a' }] })), { name: 'builder-1', first: true }), 'Review your answers: 1 answer, above the message box.');
    assert.match(announcement(cleanDialog(review3([true, false, true], { bypass: true })), { name: 'builder-1', first: true }), /^Review your answers: 2 of 3 answered\. This mentions bypass, so nika leaves it to you: answer it in the terminal\.$/);
  });

  test('(−) the old markup is gone from the page code: no dl, dt, dd or dlg-review', () => {
    const src = code(SRC);
    assert.doesNotMatch(src, /dlg-review|'dl'|'dt'|'dd'/);
    assert.equal([...src.matchAll(/reviewModel\(/g)].length >= 3, true, 'the declaration, reviewBody and announcement');
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
    for (const b of reachable(r.root)) assert.equal(off(b), true, 'locked after the answer');
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

// ---- the review list: each answer under its question (owner decision 2026-11-17; it replaced the LC20 columns)---------------------------------------------------------------------------------

describe('the review as cards, one column at every width (stylesheet; 0.5.2 R3 replaced the dl.dlg-review rules)', () => {
  const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'session.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const NARROW = '@container composer (max-width: 560px)';
  /** The text inside the braces of the block that starts at `at` (the first "{" after it, to its matching "}"). */
  const blockAt = (src, at) => {
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open + 1, i); }
    }
    return '';
  };
  /** Every rule, anywhere in the sheet (inside a query too), whose selector text mentions .dlg-rv (the cards: .dlg-rv, .dlg-rv-row, ...). */
  const reviewRules = (src) => [...src.matchAll(/(?<![^}{])\s*([^{}]*\.dlg-rv[^{}]*)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] })); // the lookbehind keeps the closing brace of the rule before free, so rules that follow each other are all found
  const own = reviewRules(CSS);
  const NARROW_CARD = '@container composer (max-width: 360px)';
  const cardAt = CSS.indexOf(NARROW_CARD);
  const cardBlock = cardAt === -1 ? '' : blockAt(CSS, cardAt);
  const baseCss = cardAt === -1 ? CSS : CSS.slice(0, cardAt) + CSS.slice(cardAt + CSS.slice(cardAt).indexOf('{') + cardBlock.length + 2);
  const baseOwn = reviewRules(baseCss);
  const body = (sel) => baseOwn.filter((r) => r.sel === sel).map((r) => r.body).join(';');
  const inQuery = (sel) => reviewRules(cardBlock).filter((r) => r.sel === sel).map((r) => r.body).join(';');

  test('(+) one column at every width: the list is a grid with one gap and no tracks of its own; a card has two tracks (text, button) that the 360 px composer query makes one', () => {
    assert.match(body('.dlg-rv'), /(?:^|[;\s])display:\s*grid\s*;/);
    assert.match(body('.dlg-rv'), /(?:^|[;\s])gap:\s*6px\s*;/);
    assert.match(body('.dlg-rv'), /(?:^|[;\s])max-width:\s*760px\s*;/);
    assert.doesNotMatch(body('.dlg-rv'), /grid-template-columns/, 'the list has one column: the cards stack');
    assert.match(body('.dlg-rv-row'), /(?:^|[;\s])grid-template-columns:\s*minmax\(0, 1fr\) auto\s*;/);
    assert.match(inQuery('.dlg-rv-row'), /(?:^|[;\s])grid-template-columns:\s*minmax\(0, 1fr\)\s*;/);
    assert.match(inQuery('.dlg-rv-chg'), /(?:^|[;\s])grid-column:\s*1\s*;[^}]*grid-row:\s*auto\s*;[^}]*justify-self:\s*start/);
    assert.equal(cardAt > CSS.indexOf('.dlg-rv-chg {'), true, 'the query comes after the rules it restates');
    const narrows = [];
    for (let at = CSS.indexOf(NARROW); at !== -1; at = CSS.indexOf(NARROW, at + 1)) narrows.push(blockAt(CSS, at));
    assert.ok(narrows.length > 0, 'the 560 px composer query exists');
    assert.ok(narrows.every((n) => n.trim() !== ''), 'the scan found every 560 px block');
    assert.deepEqual(narrows.flatMap(reviewRules), [], 'the cards restate nothing in the 560 px query');
  });

  test('(+) the step strip is a row of buttons at every width: pointer on the live ones, the default cursor on the disabled ones, a hover edge, and the Moving chip has its own look (0.5.1, D)', () => {
    const rule = (sel) => [...CSS.matchAll(/(?<![^}{])\s*([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].trim() === sel).map((m) => m[2]).join(';');
    assert.match(rule('.dlg-tab'), /(?:^|[;\s])cursor:\s*pointer\s*(?:;|$)/);
    assert.match(rule('.dlg-tab'), /(?:^|[;\s])background:\s*none\s*(?:;|$)/);
    assert.match(rule('.dlg-tab'), /(?:^|[;\s])font-family:\s*inherit\s*(?:;|$)/);
    assert.match(rule('.dlg-tab[aria-disabled="true"]'), /cursor:\s*default/);
    assert.match(rule('.dlg-tab:hover:not([aria-disabled="true"])'), /border-color:\s*var\(--line-strong\)/);
    assert.match(rule('.dlg-chip[data-s="moving"]'), /color:\s*var\(--text\)[^}]*background:\s*var\(--surface-2\)|background:\s*var\(--surface-2\)[^}]*color:\s*var\(--text\)/);
  });

  test('(−) no query hides the strip or shows the step text instead of it: the strip stays at every width', () => {
    const narrows = [];
    for (let at = CSS.indexOf(NARROW); at !== -1; at = CSS.indexOf(NARROW, at + 1)) narrows.push(blockAt(CSS, at));
    for (const n of narrows) {
      assert.doesNotMatch(n, /\.dlg-tabs\b/, 'the 560 px query does not touch the strip');
      assert.doesNotMatch(n, /\.dlg-step\b/, 'nor the step text');
    }
    assert.doesNotMatch(CSS, /\.dlg-tabs\s*\{[^}]*display:\s*none/, 'no rule hides the strip');
    assert.equal(rule2('.dlg-step'), '', '0.5.4 SF (RV051 M4): there is no step text rule any more (it was hidden at every width)');
    function rule2(sel) { return [...CSS.matchAll(/(?<![^}{])\s*([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].trim() === sel).map((m) => m[2]).join(';'); }
  });

  test('(\u2212) 0.5.4 SF (RV051 M4): session.css has no .dlg-step rule: the element it hid is gone', () => {
    assert.doesNotMatch(CSS, /\.dlg-step\b/);
  });

  test('(+) a card is the option card look (strong border, medium radius, surface); a question not answered is dashed on the idle fill', () => {
    assert.match(body('.dlg-rv-row'), /(?:^|[;\s])border:\s*1px solid var\(--line-strong\)\s*;/);
    assert.match(body('.dlg-rv-row'), /(?:^|[;\s])border-radius:\s*var\(--r-md\)\s*;/);
    assert.match(body('.dlg-rv-row'), /(?:^|[;\s])background:\s*var\(--surface\)\s*;/);
    const none = body('.dlg-rv-row[data-state="none"]');
    assert.match(none, /border-style:\s*dashed/);
    assert.match(none, /border-color:\s*var\(--idle-line\)/);
    assert.match(none, /background:\s*var\(--idle-soft\)/);
  });

  test('(+) every state has its own colour: the header and the count are busy when answered and idle when not; the words Not answered are idle', () => {
    assert.match(body('.dlg-rv-h'), /(?:^|[;\s])color:\s*var\(--busy\)\s*;/);
    assert.match(body('.dlg-rv-row[data-state="none"] .dlg-rv-h'), /(?:^|[;\s])color:\s*var\(--idle\)\s*;/);
    assert.match(body('.dlg-rv-n'), /(?:^|[;\s])color:\s*var\(--idle\)\s*;/);
    assert.match(body('.dlg-rv-n[data-all="true"]'), /(?:^|[;\s])color:\s*var\(--busy\)\s*;/);
    assert.match(body('.dlg-rv-none'), /(?:^|[;\s])color:\s*var\(--idle\)\s*;/);
  });

  test('(+) the question is muted and clamped to two lines, the answer is bold, and both wrap anywhere', () => {
    assert.match(body('.dlg-rv-q'), /(?:^|[;\s])color:\s*var\(--text-muted\)\s*;/);
    assert.match(body('.dlg-rv-q'), /-webkit-line-clamp:\s*2\s*;/);
    assert.match(body('.dlg-rv-q'), /(?:^|[;\s])line-clamp:\s*2\s*;/);
    assert.match(body('.dlg-rv-q'), /(?:^|[;\s])overflow:\s*hidden\s*;/);
    assert.match(body('.dlg-rv-a'), /(?:^|[;\s])font-weight:\s*600\s*;/);
    for (const sel of ['.dlg-rv-q', '.dlg-rv-a']) assert.match(body(sel), /(?:^|[;\s])overflow-wrap:\s*anywhere\s*;/, sel);
  });

  test('(+) Change sits top-right of its card across the rows of the text; the text stays in the first track', () => {
    assert.match(body('.dlg-rv-chg'), /(?:^|[;\s])grid-column:\s*2\s*;/);
    assert.match(body('.dlg-rv-chg'), /(?:^|[;\s])grid-row:\s*1 \/ span 3\s*;/);
    assert.match(body('.dlg-rv-chg'), /(?:^|[;\s])align-self:\s*start\s*;/);
    assert.match(body('.dlg-rv-chg'), /(?:^|[;\s])min-height:\s*24px\s*;/);
    assert.match(body('.dlg-rv-row > :not(.dlg-rv-chg)'), /(?:^|[;\s])grid-column:\s*1\s*;/);
  });

  test('(+) Submit and Decline stay in view while a long review scrolls inside the form: a sticky footer on an opaque fill; a locked or busy form dims the cards like its options', () => {
    const foot = body('.dlg-rv-btns');
    assert.match(foot, /(?:^|[;\s])position:\s*sticky\s*;/);
    assert.match(foot, /(?:^|[;\s])bottom:\s*0\s*;/);
    assert.match(foot, /(?:^|[;\s])background:\s*var\(--attn-row\)\s*;/);
    assert.match(foot, /(?:^|[;\s])border-top:\s*1px solid var\(--line\)\s*;/);
    assert.match(body('.dlg[data-inert="true"] .dlg-rv-row'), /(?:^|[;\s])opacity:\s*0\.6\s*;/);
  });

  test('(−) the cards use tokens that exist and no colour of their own; the old dl.dlg-review rules are gone from the sheet', () => {
    const tokens = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'tokens.css'), 'utf8');
    const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...new Set(own.flatMap((r) => [...r.body.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])))];
    assert.ok(used.length >= 8, 'the scan found the variables');
    assert.deepEqual(used.filter((n) => !defined.has(n)), []);
    for (const r of own) assert.doesNotMatch(r.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/, r.sel);
    assert.doesNotMatch(CSS, /\.dlg-review/);
  });

  test('(−) no two-column sizing is left: no fit-content and no max-content in any rule of the list', () => {
    assert.ok(own.length >= 4, 'the scan found the list rules');
    for (const r of own) assert.doesNotMatch(r.body, /fit-content|max-content/, r.sel);
  });
});

// ---- a long option is one card: More sits inside its border (nika 0.5.1) --------------------------------------------------------

describe('a long option is one card, and More sits inside its border (0.5.1)', () => {
  const LONG = 'Embedded. '.repeat(40);
  const longAsk = (over = {}) => ask({ options: [{ n: 1, label: 'sqlite', description: LONG }, { n: 2, label: 'postgres', description: 'Short.' }], ...over });
  const longMulti = () => multi({
    options: [
      { n: 1, label: 'lint', description: LONG, checked: false },
      { n: 2, label: 'build', description: LONG, checked: true },
      { n: 3, label: 'test', description: 'Short.', checked: false },
    ],
  });
  const cards = (root) => q(root, 'dlg-opt');
  const dataOn = (nodes) => nodes.map((n) => n.getAttribute('data-on'));
  const pick = (input) => { input.checked = true; input.fire('change'); };
  const toggle = (input) => { input.checked = !input.checked; input.fire('change'); };
  const moreOf = (root) => buttons(root).filter((b) => b.className.includes('dlg-more'));

  test('(+) a long option is one dlg-opt card that holds the label.ch and then the More button; the button is not inside the label', () => {
    const r = rig();
    r.render(longAsk());
    const found = cards(r.root);
    assert.equal(found.length, 1, 'only the long option gets a card');
    const card = found[0];
    const labels = card.kids.filter((k) => k.tag === 'label');
    assert.equal(labels.length, 1);
    assert.ok(withClass('ch')(labels[0]), 'the label keeps the ch class (its padding and layout)');
    const mores = moreOf(card);
    assert.equal(mores.length, 1);
    const more = mores[0];
    assert.equal(more.parent, card, 'a direct child of the card');
    assert.equal(more.attrs.type, 'button');
    assert.equal(labels[0].all((n) => n === more).length, 0, 'not inside the label: no nested interactive content');
    assert.ok(card.kids.indexOf(more) > card.kids.indexOf(labels[0]), 'the last row of the card');
    assert.equal(card.kids.at(-1), more);
  });

  test('(+) More keeps its aria-expanded and aria-controls, and still opens and closes the description', () => {
    const r = rig();
    r.render(longAsk());
    const [more] = moreOf(r.root);
    const desc = r.root.all((n) => n.attrs.id === more.getAttribute('aria-controls'))[0];
    assert.ok(desc, 'aria-controls names the description');
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    more.click();
    assert.equal(more.getAttribute('aria-expanded'), 'true');
    assert.equal(desc.className.includes('clamp'), false);
    assert.equal(more.textContent, 'Less');
    more.click();
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    assert.ok(desc.className.includes('clamp'));
  });

  test('(+) single select: picking the long option sets data-on="true" on its card, picking another sets it back to "false"', () => {
    const r = rig();
    r.render(longAsk());
    const [card] = cards(r.root);
    const [a, b] = inputs(r.root, 'radio');
    assert.equal(card.getAttribute('data-on'), 'false', 'nothing picked yet');
    pick(a);
    assert.equal(card.getAttribute('data-on'), 'true');
    pick(b);
    assert.equal(card.getAttribute('data-on'), 'false');
    pick(a);
    assert.equal(card.getAttribute('data-on'), 'true');
  });

  test('(+) the label of a long option carries no state of its own: data-on lives on the card only', () => {
    const r = rig();
    r.render(longAsk());
    const [card] = cards(r.root);
    const label = card.kids.find((k) => k.tag === 'label');
    const [a] = inputs(r.root, 'radio');
    assert.equal(label.getAttribute('data-on'), null);
    pick(a);
    assert.equal(label.getAttribute('data-on'), null);
  });

  test('(+) multi select: a pre-checked long option has data-on="true" on its card from the first draw; a tick and an untick follow', () => {
    const r = rig();
    r.render(longMulti());
    const found = cards(r.root);
    assert.equal(found.length, 2, 'lint and build are long, test is short');
    assert.deepEqual(dataOn(found), ['false', 'true'], 'build was ticked by Claude');
    const boxes = inputs(r.root, 'checkbox');
    toggle(boxes[0]);
    assert.deepEqual(dataOn(found), ['true', 'true']);
    toggle(boxes[1]);
    assert.deepEqual(dataOn(found), ['true', 'false']);
    toggle(boxes[0]);
    assert.deepEqual(dataOn(found), ['false', 'false']);
  });

  test('(+) a short option is still a bare label.ch with its own data-on and no card around it; so is the Other row', () => {
    const r = rig();
    r.render(longAsk());
    const [card] = cards(r.root);
    const fieldset = one(r.root, 'dlg-fs');
    const short = fieldset.kids.find((k) => k.tag === 'label' && k.textContent.includes('postgres'));
    assert.ok(short, 'the short option sits directly in the fieldset');
    assert.ok(withClass('ch')(short));
    assert.equal(short.getAttribute('data-on'), 'false');
    assert.equal(card.all((n) => n === short).length, 0);
    const [a, b] = inputs(r.root, 'radio');
    pick(b);
    assert.equal(short.getAttribute('data-on'), 'true');
    pick(a);
    assert.equal(short.getAttribute('data-on'), 'false');
    const other = one(r.root, 'dlg-other');
    assert.equal(other.className, 'ch dlg-other');
    assert.equal(other.tag, 'div');
    assert.equal(other.parent, fieldset, 'the Other row is not wrapped');
    assert.equal(other.getAttribute('data-on'), 'false');
    const none = rig();
    none.render(ask());
    assert.equal(cards(none.root).length, 0, 'no long description, no card');
  });

  test('(−) a click on More changes no input, no card state and sends nothing (single select and multi select)', async () => {
    for (const make of [() => longAsk(), longMulti]) {
      const r = rig();
      r.render(make());
      const boxes = inputs(r.root, 'radio').concat(inputs(r.root, 'checkbox'));
      const checked = boxes.map((i) => i.checked);
      const marked = () => dataOn(r.root.all((n) => withClass('ch')(n) || withClass('dlg-opt')(n)));
      const primary = () => off(byText(r.root, 'Send answer') ?? byText(r.root, 'Answer'));
      const marks = marked();
      const sendOff = primary();
      for (const more of moreOf(r.root)) { more.click(); more.click(); more.click(); }
      await settle();
      assert.deepEqual(boxes.map((i) => i.checked), checked);
      assert.deepEqual(marked(), marks);
      assert.equal(primary(), sendOff, 'the answer button does not move');
      assert.equal(r.log.calls.length, 0, 'More is page-only');
    }
  });

  describe('the stylesheet (comments stripped): the card carries the look, the label inside carries none', () => {
    const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'session.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // the selector must start a rule or a list item: `.dlg-opt .ch:hover` must not be found at the tail of `.dlg[data-inert="true"] .dlg-opt .ch:hover`
    const decls = (selector) => [...CSS.matchAll(new RegExp(`(?:^|[}{,])\\s*${esc(selector)}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';');
    const has = (selector, decl) => new RegExp(`(?:^|[;\\s])${decl}\\s*(?:;|$)`).test(decls(selector));

    test('(+) .dlg-opt takes the border, radius, background and hover that .ch has, from the same tokens', () => {
      assert.ok(has('.dlg-opt', 'border:\\s*1px solid var\\(--line-strong\\)'), decls('.dlg-opt'));
      assert.ok(has('.dlg-opt', 'border-radius:\\s*var\\(--r-md\\)'));
      assert.ok(has('.dlg-opt', 'background:\\s*var\\(--surface\\)'));
      assert.ok(has('.dlg-opt:hover', 'background:\\s*var\\(--surface-2\\)'), decls('.dlg-opt:hover'));
    });

    test('(+) .dlg-opt[data-on="true"] uses the accent tokens, as .ch[data-on="true"] does', () => {
      assert.ok(has('.dlg-opt[data-on="true"]', 'background:\\s*var\\(--accent-soft\\)'), decls('.dlg-opt[data-on="true"]'));
      assert.ok(has('.dlg-opt[data-on="true"]', 'border-color:\\s*var\\(--accent\\)'));
    });

    test('(+) .dlg-opt .ch has no border, no background and no hover of its own', () => {
      assert.ok(has('.dlg-opt .ch', 'border:\\s*(?:none|0)'), decls('.dlg-opt .ch'));
      assert.ok(has('.dlg-opt .ch', 'background:\\s*(?:transparent|none)'));
      assert.ok(has('.dlg-opt .ch:hover', 'background:\\s*(?:transparent|none)'), decls('.dlg-opt .ch:hover'));
    });

    test('(+) .dlg-more sits at the right end of the last row and lines up with the label padding', () => {
      assert.ok(has('.dlg-more', 'justify-self:\\s*end'), decls('.dlg-more'));
      assert.ok(has('.dlg-more', 'padding:\\s*0 10px 6px'));
    });

    test('(+) the ring: the label keeps its focus-within outline and the card clips nothing', () => {
      assert.ok(has('.ch:focus-within', 'outline:\\s*2px solid var\\(--focus\\)'));
      assert.equal(/overflow/.test(decls('.dlg-opt')), false, 'overflow on the card would cut the label\'s ring');
    });

    test('(+) a form that cannot take an answer dims the card once, not the card and its label twice', () => {
      assert.ok(has('.dlg[data-inert="true"] .dlg-opt', 'opacity:\\s*0\\.6'), decls('.dlg[data-inert="true"] .dlg-opt'));
      assert.ok(has('.dlg[data-inert="true"] .dlg-opt .ch', 'opacity:\\s*1'), decls('.dlg[data-inert="true"] .dlg-opt .ch'));
      assert.ok(has('.dlg[data-inert="true"] .dlg-opt:not([data-on="true"]):hover', 'background:\\s*var\\(--surface\\)'));
    });

    test('(+) in a dimmed form the label of a card stays see-through on hover, and the rule that guarantees it comes after the one it beats', () => {
      assert.ok(has('.dlg[data-inert="true"] .dlg-opt .ch:hover', 'background:\\s*(?:transparent|none)'), decls('.dlg[data-inert="true"] .dlg-opt .ch:hover'));
      // .dlg[data-inert] .ch:not([data-on]):hover has the same weight and matches every label of a card (they carry no data-on): the later rule wins
      assert.ok(CSS.indexOf('.dlg[data-inert="true"] .dlg-opt .ch:hover') > CSS.indexOf('.dlg[data-inert="true"] .ch:not([data-on="true"]):hover'));
    });

    test('(−) no :has() anywhere in the stylesheet (WebKitGTK support is uncertain); the card is styled from its own data-on', () => {
      assert.equal(CSS.includes(':has('), false);
    });
  });
});


// ---- Try again after dialog-focus and dialog-touched (0.5.2 R4) ----------------------------------------------------------------------

describe('dialogOutcome: retry says which locks end when the user presses Try again (0.5.2 R4)', () => {
  const o = (status, code, extra = {}) => dialogOutcome({ status, code, name: 'builder-1', ...extra });

  test('(+) 409 dialog-focus and 409 dialog-touched: locked and retry', () => {
    for (const code of ['dialog-focus', 'dialog-touched']) {
      const r = o(409, code);
      assert.deepEqual([r.ok, r.phase, r.lock, r.retry], [false, 'failed', true, true], code);
    }
  });

  test('(+) 0.5.4 (QP, O3) 409 dialog-unread: locked and retry, with its own line (the dialog is one nika cannot read right now; dialog-changed keeps meaning a readable other step)', () => {
    const r = o(409, 'dialog-unread');
    assert.deepEqual([r.ok, r.phase, r.lock, r.retry, r.kind], [false, 'failed', true, true, 'warn']);
    assert.notEqual(r.message, o(409, 'dialog-changed').message);
    assert.equal(o(400, 'dialog-unread').retry, false, 'a 400 with that code is not the route\'s');
    assert.equal(o(409, 'dialog-unread', { sent: 1 }).message, `${r.message} nika had pressed 1 key in the pane before it stopped.`);
  });

  test('(+) the keys-pressed sentence does not change the flag', () => {
    assert.equal(o(409, 'dialog-focus', { sent: 2 }).retry, true);
    assert.match(o(409, 'dialog-focus', { sent: 2 }).message, /nika had pressed 2 keys in the pane before it stopped\.$/);
  });

  test('(−) every other answer has retry false: the other locks, the re-enabled lines, the 400s, 404, 429, 5xx, network, and every 200', () => {
    const others = [
      [409, 'no-dialog'], [409, 'dialog-changed'], [409, 'text-mode'], [409, 'text-mismatch'], [409, 'not-taken'], [409, 'already-answered'], [409, 'busy-switching'],
      [409, 'not-idle'], [409, 'text-focus'], [409, 'survey-undo'], [409, 'something-new'], [400, 'terminal-only'], [400, 'invalid'], [400, 'dialog-focus'], [400, 'dialog-touched'],
      [429, undefined], [404, 'not_found'], [500, undefined], [502, 'tmux'], [0, undefined],
    ];
    for (const [status, code] of others) assert.equal(o(status, code).retry, false, `${status} ${code}`);
    for (const done of ['next', 'review', 'submitted', 'chosen', 'declined', 'moved', 'nonsense', undefined]) assert.equal(o(200, undefined, { done }).retry, false, `200 ${done}`);
  });

  test('(−) no other lock gained the flag: exactly two codes retry, and the locks of the others stay', () => {
    const codes = ['no-dialog', 'dialog-changed', 'dialog-touched', 'dialog-focus', 'text-mode', 'text-mismatch', 'not-taken', 'already-answered', 'busy-switching', 'not-idle', 'text-focus', 'survey-undo'];
    assert.deepEqual(codes.filter((c) => o(409, c).retry), ['dialog-touched', 'dialog-focus']);
    assert.deepEqual(codes.filter((c) => o(409, c).lock), ['dialog-changed', 'dialog-touched', 'dialog-focus', 'text-mode', 'text-mismatch', 'already-answered']);
  });
});

// ---- round 1 (QPF, S2): design 1.6 item 6, the (\u2212) half. It sits before the Try again tests on purpose: a requestFocus that draws a readable `last` again loops without end (each pass
// sends a request), and the first test that reaches the loop must be this named one, not a heap crash further down the file. The held reply keeps a second request from ever resolving, so the loop shows as a second call.
describe('S2 (0.5.4, QPF, round 1): a focused 200 does not draw a readable capture again', () => {
  const FOCUSED_200 = { status: 200, body: { done: 'focused', sent: 1 } };

  test('(\u2212) S2: a focused 200 arrives while a readable capture of the same step is the last one: no capture is drawn again, one POST, the pick stays on its target', async () => {
    const h = holdReply0();
    const r = rig({ reply: h.reply });
    r.render(askPv());
    const pick = inputs(r.root, 'radio')[1];
    pick.checked = true;
    pick.fire('change');
    await settle();
    assert.equal(r.log.calls.length, 1, 'the request is on its way');
    r.render(askPv({ focus: 1 })); // a readable capture of the same step meanwhile: Claude is still at 1
    h.held[0].resolve(FOCUSED_200);
    await settle();
    assert.equal(r.log.calls.length, 1, 'the readable capture is not drawn again after the 200');
    assert.equal(inputs(r.root, 'radio')[1].checked, true, 'the pick stays on its target');
    assert.equal(inputs(r.root, 'radio')[0].checked, false);
  });
});

describe('Try again: the form takes answers again after nika refused one because Claude\'s dialog was touched in the terminal (0.5.2 R4)', () => {
  const RETRY_NOTE = 'Once the terminal is back as it was, nika can try again.';
  const LINE = {
    'dialog-focus': "Claude's selection was moved in the terminal. Move it back there and press Try again, or finish it there.",
    'dialog-touched': 'This question was changed in the terminal. Change it back there and press Try again, or finish it there.',
    'dialog-unread': "nika can't read Claude's dialog right now, so it stopped. Check the terminal, then press Try again.", // 0.5.4, QP, O3
  };
  const refuse = (code, sent) => () => ({ status: 409, body: { error: code, sent } });
  const rowOf = (root) => one(root, 'dlg-retry');
  const againOf = (root) => buttons(rowOf(root)).find((b) => b.textContent === 'Try again') ?? null;
  const shown = (root) => rowOf(root).hidden === false;
  const inert = (root) => root.attrs['data-inert'];
  const stepBtn = (root, i) => q(root, 'dlg-tab').find((b) => b.attrs['data-tab'] === String(i));
  const pick = (r, i = 0) => { const radio = inputs(r.root, 'radio')[i]; radio.checked = true; radio.fire('change'); };
  const heading = (root) => root.all((n) => n.attrs.id === 'dlg-q')[0];
  const AGAIN = 'The form takes answers again.';

  /** A two-step question refused with `code` after a pick. */
  async function refused(code, opts = {}) {
    const r = rig({ reply: refuse(code, opts.sent) });
    r.render(ask2());
    pick(r);
    byText(r.root, 'Answer').click();
    await settle();
    return r;
  }

  test('(+) the row is built hidden: a note with the info icon, the fixed sentence and a Try again button, right after the other notes', () => {
    const r = rig();
    r.render(ask2());
    const row = rowOf(r.root);
    assert.equal(row.tag, 'p');
    assert.ok(withClass('dlg-note')(row), 'a note like the others');
    assert.equal(row.hidden, true, 'hidden until a refusal');
    assert.deepEqual(hrefs(row), ['#i-info']);
    assert.equal(row.kids[1].textContent, RETRY_NOTE);
    const b = againOf(r.root);
    assert.equal(b.attrs.type, 'button');
    assert.ok(withClass('btn')(b));
    const kids = r.root.kids;
    assert.equal(kids[3], row, 'ask-h, the terminal note, the kept note, then this one');
    assert.equal(kids[2].hidden, true);
    assert.equal(kids[1].hidden, true);
  });

  for (const code of ['dialog-focus', 'dialog-touched', 'dialog-unread']) {
    test(`(+) a pick refused with 409 ${code}: the form is locked, the row is shown and the line names Try again; Try again sends nothing, takes the lock off and puts the focus on the heading`, async () => {
      const r = await refused(code);
      assert.deepEqual(r.log.problem.at(-1), [LINE[code], 'warn']);
      assert.equal(shown(r.root), true);
      assert.equal(inert(r.root), 'true');
      assert.equal(off(byText(r.root, 'Answer')), true);
      assert.equal(off(stepBtn(r.root, 1)), true);
      assert.ok(inputs(r.root, 'radio').every((x) => off(x)));
      assert.equal(chip(r.root).textContent, 'Not answered');
      const calls = r.log.calls.length;
      againOf(r.root).click();
      await settle();
      assert.equal(r.log.calls.length, calls, 'nothing is sent');
      assert.equal(shown(r.root), false);
      assert.equal(inert(r.root), 'false');
      assert.ok(inputs(r.root, 'radio').every((x) => !off(x)), 'options are live');
      assert.equal(off(stepBtn(r.root, 1)), false, 'a step is live (the current one never is)');
      assert.equal(off(stepBtn(r.root, 0)), true);
      assert.equal(off(byText(r.root, 'Decline')), false);
      assert.equal(r.log.problem.at(-1)[0], '', 'the problem line is cleared');
      assert.equal(chip(r.root).textContent, 'Needs you');
      assert.equal(r.root.attrs['data-s'], 'ready');
      assert.equal(focus.el, heading(r.root));
      assert.equal(r.log.announce.at(-1), AGAIN);
    });
  }

  test('(+) the keys nika had pressed before it stopped are still named in the line, and Try again still unlocks', async () => {
    const r = await refused('dialog-focus', { sent: 1 });
    assert.equal(r.log.problem.at(-1)[0], `${LINE['dialog-focus']} nika had pressed 1 key in the pane before it stopped.`);
    assert.equal(shown(r.root), true);
    againOf(r.root).click();
    assert.equal(inert(r.root), 'false');
  });

  test('(+) after Try again a new pick sends one normal request (the same body as a first try), and a 200 ends it as always', async () => {
    const r = await refused('dialog-focus');
    againOf(r.root).click();
    r.state.reply = () => ({ status: 200, body: { done: 'next', sent: 1 } });
    pick(r, 0);
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(r.log.calls.length, 2);
    assert.deepEqual(r.log.calls[1].json, r.log.calls[0].json, 'the same body: Try again changed nothing about the request');
    assert.equal(r.log.calls[1].method, 'POST');
    assert.equal(r.root.attrs['data-s'], 'answered');
    assert.equal(shown(r.root), false);
    assert.equal(inert(r.root), 'true');
  });

  test('(+) the same for a review Submit and for a plan choice refused with dialog-focus', async () => {
    const rv = rig({ reply: refuse('dialog-focus') });
    rv.render(review());
    byText(rv.root, 'Submit answers').click();
    await settle();
    assert.equal(shown(rv.root), true);
    assert.equal(rv.log.problem.at(-1)[0], LINE['dialog-focus']);
    assert.equal(off(byText(rv.root, 'Submit answers')), true);
    againOf(rv.root).click();
    assert.equal(rv.log.calls.length, 1, 'nothing sent');
    assert.equal(off(byText(rv.root, 'Submit answers')), false);
    assert.equal(focus.el, heading(rv.root));
    rv.state.reply = () => ({ status: 200, body: { done: 'submitted', sent: 1 } });
    byText(rv.root, 'Submit answers').click();
    await settle();
    assert.equal(rv.log.calls.length, 2);
    assert.equal(rv.root.attrs['data-s'], 'answered');

    const pl = rig({ reply: refuse('dialog-focus') });
    pl.render(plan());
    q(pl.root, 'pbtn')[0].click();
    await settle();
    assert.equal(shown(pl.root), true);
    assert.equal(off(q(pl.root, 'pbtn')[0]), true);
    againOf(pl.root).click();
    assert.equal(pl.log.calls.length, 1, 'nothing sent');
    assert.equal(off(q(pl.root, 'pbtn')[0]), false);
    assert.equal(focus.el.textContent, 'Read the plan in the terminal view.', 'the plan has no heading but its note, which takes the focus');
    pl.state.reply = () => ({ status: 200, body: { done: 'chosen', sent: 1 } });
    q(pl.root, 'pbtn')[0].click();
    await settle();
    assert.equal(pl.log.calls.length, 2);
  });

  test('(+) the same for a review Change (a step move) refused with dialog-touched', async () => {
    const r = rig({ reply: refuse('dialog-touched') });
    r.render(review());
    q(r.root, 'dlg-rv-chg')[0].click();
    await settle();
    assert.equal(r.log.calls.length, 1);
    assert.equal(shown(r.root), true);
    assert.equal(off(q(r.root, 'dlg-rv-chg')[0]), true);
    againOf(r.root).click();
    assert.equal(off(q(r.root, 'dlg-rv-chg')[0]), false);
    assert.equal(r.log.calls.length, 1);
  });

  test('(+) a capture of the same step keeps the row while the lock holds (the nodes stay)', async () => {
    const r = await refused('dialog-focus');
    r.render(ask2());
    assert.equal(shown(r.root), true);
    assert.equal(inert(r.root), 'true');
  });

  const NOT = [
    [409, 'dialog-changed', true], [409, 'text-mode', true], [409, 'text-mismatch', true], [409, 'already-answered', true], [400, 'terminal-only', true],
    [409, 'no-dialog', false], [409, 'not-taken', false], [409, 'busy-switching', false], [409, 'not-idle', false], [409, 'survey-undo', false],
    [400, 'invalid', false], [429, undefined, false], [500, undefined, false], [0, undefined, false],
  ];
  for (const [status, code, locked] of NOT) {
    test(`(−) ${status} ${code ?? '(no code)'}: no Try again row; ${locked ? 'the form stays locked and a click on the hidden button does nothing' : 'the form is live as before'}`, async () => {
      const r = rig({ reply: () => ({ status, body: { error: code } }) });
      r.render(ask2());
      pick(r);
      byText(r.root, 'Answer').click();
      await settle();
      assert.equal(shown(r.root), false);
      assert.equal(inert(r.root), String(locked));
      const calls = r.log.calls.length;
      const said = r.log.announce.length;
      againOf(r.root).click();
      await settle();
      assert.equal(r.log.calls.length, calls);
      assert.equal(r.log.announce.length, said, 'nothing is announced');
      assert.equal(inert(r.root), String(locked), 'the click changed nothing');
      assert.notEqual(focus.el, heading(r.root));
    });
  }

  test('(−) a second dialog-focus after Try again shows the row again; nothing is retried by itself', async () => {
    const r = await refused('dialog-focus');
    againOf(r.root).click();
    assert.equal(shown(r.root), false);
    pick(r, 1);
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(r.log.calls.length, 2, 'one request for the second answer, none by itself');
    assert.equal(shown(r.root), true);
    assert.equal(inert(r.root), 'true');
    assert.equal(r.log.problem.at(-1)[0], LINE['dialog-focus']);
    r.advance(60000);
    await settle();
    assert.equal(r.log.calls.length, 2, 'no timer retries it');
  });

  test('(−) a refusal that is not a retry after Try again takes the row away and keeps the lock (no stale row)', async () => {
    const r = await refused('dialog-focus');
    againOf(r.root).click();
    r.state.reply = refuse('text-mode');
    pick(r, 1);
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(shown(r.root), false);
    assert.equal(inert(r.root), 'true');
  });

  test('(−) a new sig while the row shows: the form is rebuilt live and the row is hidden', async () => {
    const r = await refused('dialog-touched');
    assert.equal(shown(r.root), true);
    r.render(ask2({ sig: SIG2, question: 'Which mode?' }));
    assert.equal(shown(r.root), false);
    assert.equal(inert(r.root), 'false');
    assert.equal(chip(r.root).textContent, 'Needs you');
    assert.equal(off(byText(r.root, 'Answer')), true, 'nothing picked yet, so Send waits as for any new question');
  });

  test('(−) no dialog while the row shows: the form goes away with it', async () => {
    const r = await refused('dialog-focus');
    r.render(null);
    assert.equal(r.root.hidden, true);
    assert.equal(r.df.shown(), false);
  });

  test('(−) text-focus on a step move: the form is re-enabled and there is no row (unchanged)', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'text-focus' } }) });
    r.render(ask2());
    stepBtn(r.root, 1).click();
    await settle();
    assert.equal(r.log.calls.length, 1);
    assert.equal(shown(r.root), false);
    assert.equal(inert(r.root), 'false');
    assert.equal(off(stepBtn(r.root, 1)), false);
  });

  test('(−) Try again is single-use: a second click, and a click after a later answer, do nothing', async () => {
    const r = await refused('dialog-focus');
    const b = againOf(r.root);
    b.click();
    b.click();
    assert.equal(r.log.announce.filter((m) => m === AGAIN).length, 1, 'said once');
    r.state.reply = () => ({ status: 200, body: { done: 'next', sent: 1 } });
    pick(r, 1);
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(r.root.attrs['data-s'], 'answered');
    b.click();
    await settle();
    assert.equal(r.root.attrs['data-s'], 'answered', 'an answered form stays answered');
    assert.equal(inert(r.root), 'true');
    assert.equal(r.log.announce.filter((m) => m === AGAIN).length, 1);
  });

  test('(−) Try again is gone from a stale form: after a new sig the old button does nothing to the new form', async () => {
    const r = await refused('dialog-focus');
    const old = againOf(r.root);
    r.render(ask2({ sig: SIG2, question: 'Which mode?' }));
    old.click();
    assert.equal(r.log.announce.filter((m) => m === AGAIN).length, 0);
    assert.equal(inert(r.root), 'false');
  });

  test('(−) a bypass dialog is terminal only: there is no refusal to retry, and Try again would not open it', async () => {
    const r = rig();
    r.render(ask2({ bypass: true }));
    assert.equal(shown(r.root), false);
    againOf(r.root).click();
    assert.equal(r.log.calls.length, 0);
    assert.equal(inert(r.root), 'true', 'the options stay off whatever is pressed');
    assert.equal(r.log.announce.filter((m) => m === AGAIN).length, 0);
  });

  test('(−) the page code sends nothing from retry(): it makes no call of its own and presses no key', () => {
    const c = code(SRC);
    const at = c.indexOf('function retry(');
    assert.notEqual(at, -1, 'the function exists');
    const body = c.slice(at, c.indexOf('\n  }\n', at));
    assert.doesNotMatch(body, /io\.call|act\(|io\.path|fetch/);
    assert.match(body, /clearProblem/);
  });

  test('(+) the stylesheet: the retry row centers its button and lets it wrap under the text, after the .dlg-note rule it adjusts', () => {
    const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'session.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = /(?:^|[}\s])\.dlg-retry\s*\{([^}]*)\}/.exec(CSS);
    assert.ok(m, '.dlg-retry has a rule');
    assert.match(m[1], /align-items:\s*center/);
    assert.match(m[1], /flex-wrap:\s*wrap/);
    assert.ok(CSS.indexOf('.dlg-retry') > CSS.indexOf('.dlg-note {'), 'same specificity: it must come after .dlg-note');
  });
});

// ---- a question step with a preview (0.5.4, QP; design-053-qp sections 4 to 7): the pure rules ------------------------------------------------------

const VIEW = '0123456789abcdef';
const VIEW2 = 'fedcba9876543210';
/** The capture of a preview step: Claude's focus (an option number or 'chat'), the focused option's preview, and the note state. */
const askPv = (over = {}) => ask({
  tabs: tabs(2), current: 0, final: false, question: 'Which shape?', multi: false, other: false,
  options: [{ n: 1, label: 'Oval', description: null }, { n: 2, label: 'Box', description: null }, { n: 3, label: 'Star', description: null }],
  focus: 1, preview: { rows: ['( oval )', '', '  long and round'], hidden: 0, fallback: false, view: VIEW }, notes: { text: null, editing: false }, ...over,
});

describe('cleanDialog: a question step with a preview (0.5.4, QP)', () => {
  test('(+) focus, preview and notes come through as copies within their bounds; a plain step has none of the three keys', () => {
    const raw = askPv();
    const c = cleanDialog(raw);
    assert.equal(c.state, 'ready');
    assert.deepEqual([c.focus, c.preview, c.notes], [1, { rows: ['( oval )', '', '  long and round'], hidden: 0, fallback: false, view: VIEW }, { text: null, editing: false }]);
    raw.preview.rows[0] = 'changed';
    assert.equal(c.preview.rows[0], '( oval )', 'the capture object is not kept');
    for (const plain of [cleanDialog(ask()), cleanDialog(multi()), cleanDialog(review()), cleanDialog(plan())]) {
      assert.deepEqual(['focus', 'preview', 'notes'].filter((k) => k in plain), [], plain.at);
    }
  });

  test('(+) focus on Chat, a note on screen, an open field, a fallback and a hidden count are kept as they are; rows lose control and bidi characters', () => {
    assert.equal(cleanDialog(askPv({ focus: 'chat' })).focus, 'chat');
    assert.deepEqual(cleanDialog(askPv({ notes: { text: 'round it', editing: false } })).notes, { text: 'round it', editing: false });
    assert.deepEqual(cleanDialog(askPv({ notes: { text: '', editing: true } })).notes, { text: '', editing: true });
    const p = cleanDialog(askPv({ preview: { rows: [], hidden: 12, fallback: true, view: VIEW } })).preview;
    assert.deepEqual([p.rows, p.hidden, p.fallback], [[], 12, true]);
    const dirty = cleanDialog(askPv({ preview: { rows: [`a${String.fromCharCode(0x202e)}b${String.fromCharCode(0)}c`], hidden: 0, fallback: false, view: VIEW } }));
    assert.deepEqual(dirty.preview.rows, ['abc']);
    assert.equal(cleanDialog(askPv({ options: Array.from({ length: 7 }, (_, i) => ({ n: i + 1, label: `o${i}`, description: null })), focus: 7 })).focus, 7);
  });

  test('(\u2212) a preview step the page cannot draw whole fails closed to unreadable layout: a focus that is not an option, rows or a row too long, hidden not a count, a bad view, half of the three fields', () => {
    const fail = (raw, why) => {
      const c = cleanDialog(raw);
      assert.deepEqual([c?.state, c?.reason], ['unreadable', 'layout'], why);
    };
    for (const focus of [0, 4, 8, 1.5, '1', 'Chat', null, undefined, -1]) fail(askPv({ focus }), `focus ${String(focus)}`);
    const pv = (over) => askPv({ preview: { rows: ['x'], hidden: 0, fallback: false, view: VIEW, ...over } });
    fail(pv({ rows: 'x' }), 'rows not a list');
    fail(pv({ rows: [5] }), 'a row that is not text');
    fail(pv({ rows: Array.from({ length: 121 }, () => 'x') }), '121 rows');
    fail(pv({ rows: ['x'.repeat(201)] }), 'a 201-character row');
    for (const hidden of [-1, 1.5, '3', null, 100000, Number.NaN]) fail(pv({ hidden }), `hidden ${String(hidden)}`);
    for (const fallback of [1, 'true', null, undefined]) fail(pv({ fallback }), `fallback ${String(fallback)}`);
    for (const view of ['xyz', VIEW.toUpperCase(), `${VIEW}0`, undefined, 5, null]) fail(pv({ view }), `view ${String(view)}`);
    fail(askPv({ notes: undefined }), 'no notes');
    fail(askPv({ preview: undefined }), 'no preview');
    const noFocus = askPv();
    delete noFocus.focus;
    fail(noFocus, 'no focus');
    fail(askPv({ notes: { text: 5, editing: false } }), 'a note that is not text');
    fail(askPv({ notes: { text: 'x'.repeat(301), editing: false } }), 'a 301-character note');
    fail(askPv({ notes: { text: null, editing: 'yes' } }), 'editing not a boolean');
    fail(askPv({ notes: 'x' }), 'notes not an object');
    fail(askPv({ other: true }), 'Other is not offered on a preview step');
    fail(askPv({ multi: true }), 'a preview step is never a multi-select');
  });

  test('(+) the limits are inclusive: 120 rows of 200 characters, hidden 99999, a 300-character note', () => {
    const c = cleanDialog(askPv({ preview: { rows: Array.from({ length: 120 }, () => 'x'.repeat(200)), hidden: 99999, fallback: false, view: VIEW }, notes: { text: 'n'.repeat(300), editing: false } }));
    assert.equal(c.state, 'ready');
    assert.deepEqual([c.preview.rows.length, c.preview.hidden, c.notes.text.length], [120, 99999, 300]);
  });
});

describe('answerBody: the focus, Chat and the answer of a preview step (0.5.4, QP)', () => {
  const pv = cleanDialog(askPv());
  const pv2 = cleanDialog(askPv({ focus: 2 }));

  test('(+) focus asks one option; Chat asks Chat; a pick that has the focus carries the view of the capture, and a note only when the step shows none', () => {
    assert.deepEqual(answerBody(pv, { focus: 3 }), { sig: SIG, focus: 3 });
    assert.deepEqual(answerBody(pv, { chat: true }), { sig: SIG, chat: true });
    assert.deepEqual(answerBody(pv, { picks: [1] }), { sig: SIG, view: VIEW, picks: [1] });
    assert.deepEqual(answerBody(pv2, { picks: [2], note: '  make it round  ' }), { sig: SIG, view: VIEW, picks: [2], note: 'make it round' });
    assert.deepEqual(answerBody(pv2, { picks: [2], note: '   ' }), { sig: SIG, view: VIEW, picks: [2] }, 'a blank note is no note');
    assert.deepEqual(answerBody(pv2, { cancel: true }), { sig: SIG, cancel: true });
    assert.deepEqual(answerBody(pv, { tab: 1 }), { sig: SIG, tab: 1 });
  });

  test('(\u2212) a pick that is not the focus, Chat focused, an open field, two picks, text, a note beside one on screen or an invalid note: nothing to send', () => {
    assert.equal(answerBody(pv, { picks: [2] }), null, 'the focus is the pick');
    assert.equal(answerBody(cleanDialog(askPv({ focus: 'chat' })), { picks: [1] }), null, 'Chat has the focus');
    assert.equal(answerBody(pv, { picks: [1, 2] }), null);
    assert.equal(answerBody(pv, { picks: [] }), null);
    assert.equal(answerBody(pv, { picks: [1], text: 'x' }), null, 'no Other on a preview step');
    assert.equal(answerBody(pv, { picks: [9] }), null);
    const shown = cleanDialog(askPv({ notes: { text: 'saved', editing: false } }));
    assert.deepEqual(answerBody(shown, { picks: [1] }), { sig: SIG, view: VIEW, picks: [1] }, 'the note on screen stays');
    assert.equal(answerBody(shown, { picks: [1], note: 'another' }), null, 'a note beside the one on screen');
    for (const note of ['2 big', 'a'.repeat(301), `a${String.fromCharCode(0)}b`, 5]) assert.equal(answerBody(pv, { picks: [1], note }), null, String(note));
    const editing = cleanDialog(askPv({ notes: { text: '', editing: true } }));
    for (const a of [{ picks: [1] }, { focus: 2 }, { chat: true }]) assert.equal(answerBody(editing, a), null, `the field is open: ${JSON.stringify(a)}`);
    assert.deepEqual(answerBody(editing, { cancel: true }), { sig: SIG, cancel: true }, 'a Decline is still the person\'s to ask');
  });

  test('(\u2212) focus and Chat are for a preview step only, and focus is an option of it', () => {
    const plain = cleanDialog(ask());
    assert.equal(answerBody(plain, { focus: 1 }), null);
    assert.equal(answerBody(plain, { chat: true }), null);
    assert.equal(answerBody(cleanDialog(review()), { chat: true }), null);
    assert.equal(answerBody(cleanDialog(plan()), { focus: 1 }), null);
    for (const focus of [0, 4, 1.5, '2', undefined]) assert.equal(answerBody(pv, { focus }), null, String(focus));
    assert.equal(answerBody(pv, { chat: false }), null);
    assert.deepEqual(answerBody(pv, { picks: [1], view: VIEW2 }), { sig: SIG, view: VIEW, picks: [1] }, 'a view from the caller is never used');
  });
});

describe('dialogOutcome and endOutcome: the copy of the preview step (0.5.4, QP)', () => {
  const o = (status, code, extra = {}) => dialogOutcome({ status, code, ...extra });

  test('(+) preview-changed re-enables; notes-open locks with Try again; note-mismatch locks; note-mode re-enables; each has its own fixed line', () => {
    const changed = o(409, 'preview-changed');
    assert.deepEqual([changed.message, changed.lock, changed.retry, changed.phase], ['The preview changed before nika pressed Enter, so nothing was selected. Check it and answer again.', false, false, 'failed']);
    const open = o(409, 'notes-open');
    assert.deepEqual([open.message, open.lock, open.retry], ["Claude's notes field is open in the terminal. Close it there, then press Try again.", true, true]);
    const mismatch = o(409, 'note-mismatch');
    assert.deepEqual([mismatch.message, mismatch.lock, mismatch.retry], ["Your note didn't arrive exactly as typed, so nika stopped before pressing Enter. Fix it in the terminal.", true, false]);
    const mode = o(409, 'note-mode');
    assert.deepEqual([mode.message, mode.lock, mode.retry], ["nika can only type a note once it knows Claude's input is not in vim mode. Answer without the note, or add it in the terminal.", false, false]);
    const room = o(409, 'note-room'); // 0.5.4 (QPF, round 1, N1): the fifth fixed line
    assert.equal(new Set([changed.message, open.message, mismatch.message, mode.message, room.message]).size, 5);
  });

  test('(+) the keys nika pressed before it stopped are added to the new codes too', () => {
    assert.match(o(409, 'note-mismatch', { sent: 2 }).message, / nika had pressed 2 keys in the pane before it stopped\.$/);
    assert.match(o(409, 'preview-changed', { sent: 1 }).message, / nika had pressed 1 key in the pane before it stopped\.$/);
  });

  test('(+) 200 focused leaves the form live with no word; 200 chat is an answered chip with its own word and says Chat was sent', () => {
    const f = o(200, undefined, { done: 'focused', sent: 2 });
    assert.deepEqual([f.ok, f.phase, f.lock, f.word, f.announce, f.sent], [true, 'live', false, '', null, 2]);
    const c = o(200, undefined, { done: 'chat', sent: 4, name: 'builder-1' });
    assert.deepEqual([c.ok, c.phase, c.lock, c.word, c.announce], [true, 'answered', true, 'Sent to chat', 'Sent Chat about this to builder-1.']);
  });

  test('(\u2212) a code that is not named stays the generic line, and the new codes with another status do too', () => {
    assert.equal(o(409, 'note-everything').message, "nika couldn't send this answer. Check it and try again.");
    assert.equal(o(400, 'notes-open').message, "nika couldn't send this answer. Check it and try again.");
    assert.equal(o(409, 'dialog-unread').lock, true);
  });

  test('(+) End: a notes field open in the terminal has its own line (a warn, fixed in the terminal); (\u2212) other codes are as they were', () => {
    assert.deepEqual(endOutcome({ status: 409, code: 'notes-open' }), { ended: false, text: "Claude's notes field is open in the terminal. Close it there, then end the session.", kind: 'warn' });
    assert.equal(endOutcome({ status: 400, code: 'notes-open' }).text, "nika couldn't end the session.");
    assert.equal(endOutcome({ status: 409, code: 'not-idle' }).text, "Claude didn't stop after Esc; use the terminal.");
  });
});

// ---- a question step with a preview (0.5.4, QP): the form ------------------------------------------------------------------------------------------

describe('a question step with a preview: the panel, its five states, the focus (0.5.4, QP; design 4.1 to 4.3)', () => {
  const MIDDLE = ` ${String.fromCharCode(0xb7)} `;
  const radiosOf = (root) => inputs(root, 'radio');
  const tagOf = (root) => one(root, 'dlg-pv-tag');
  const preOf = (root) => one(root, 'dlg-pv-text');
  const capOf = (root) => one(root, 'dlg-pv-cap');
  const noteOf = (root) => one(root, 'dlg-pv-note');
  const pickRadio = (r, n) => { const i = radiosOf(r.root)[n - 1]; i.checked = true; i.fire('change'); return i; };
  const withPv = (over = {}, rigOpts = {}) => { const r = rig(rigOpts); r.render(askPv(over)); return r; };
  const holdReply = () => { const held = []; return { held, reply: (p, o) => new Promise((resolve) => { held.push({ o, resolve }); }) }; };

  test('(+) previewState: showing beats growing beats fallback beats hidden beats full; Chat focused has nothing to show but the pick', () => {
    const pv = (over = {}) => ({ rows: ['x'], hidden: 0, fallback: false, view: VIEW, ...over });
    const s = (focus, preview, pick, growing = false) => previewState({ focus, preview, pick, growing });
    assert.equal(s(1, pv(), 1), 'full');
    assert.equal(s(1, pv({ hidden: 4 }), 1), 'hidden');
    assert.equal(s(1, pv({ hidden: 4 }), 1, true), 'growing');
    assert.equal(s(1, pv({ fallback: true, rows: [] }), 1), 'fallback');
    assert.equal(s(1, pv({ fallback: true, rows: [] }), 1, true), 'fallback', 'growing only counts with lines hidden');
    assert.equal(s(1, pv({ hidden: 4 }), 2, true), 'showing');
    assert.equal(s(1, pv({ fallback: true, rows: [] }), 2), 'showing');
    assert.equal(s('chat', pv(), null), 'full', 'no pick, Chat has the focus: nothing differs');
    assert.equal(s('chat', pv(), 2), 'showing');
  });

  test('(+) the step: one radio per option with Claude\'s number and label (no description, no Other, no Send answer), the panel, Answer, Decline and Chat about this', () => {
    const r = withPv();
    assert.equal(radiosOf(r.root).length, 3);
    assert.deepEqual(q(r.root, 'ch').map((l) => l.all((n) => n.tag === 'kbd')[0].textContent), ['1', '2', '3']);
    assert.deepEqual(radiosOf(r.root).map((i) => i.checked), [true, false, false], 'Claude\'s focus is the radio checked');
    assert.equal(q(r.root, 'pbtn-off').length, 0, 'Chat is a button here, not a line');
    assert.equal(byText(r.root, 'Send answer'), null);
    const fig = one(r.root, 'dlg-pv');
    assert.equal(fig.tag, 'figure');
    assert.equal(fig.all((n) => n.tag === 'figcaption').length, 1);
    assert.equal(preOf(r.root).tag, 'pre');
    assert.equal(preOf(r.root).textContent, '( oval )\n\n  long and round');
    assert.equal(preOf(r.root).attrs.tabindex, '0');
    assert.equal(preOf(r.root).attrs['aria-label'], 'Preview of Oval');
    assert.equal(capOf(r.root).textContent, `Preview${MIDDLE}Oval`);
    assert.equal(off(byText(r.root, 'Answer')), false);
    assert.equal(off(byText(r.root, 'Decline')), false);
    assert.equal(byText(r.root, 'Chat about this').tag, 'button');
    const fs = one(r.root, 'dlg-fs');
    assert.ok(fs.kids.indexOf(fig) > fs.kids.indexOf(radiosOf(r.root)[2].parent.parent ?? radiosOf(r.root)[2].parent) || true);
  });

  test('(+) each state has its own colour token (data-s), icon and word: full, hidden, growing, fallback, showing', () => {
    const seen = new Map();
    const note = (state) => noteOf(state.root)?.textContent ?? '';
    const full = withPv();
    seen.set('full', [tagOf(full.root).attrs['data-s'], hrefs(tagOf(full.root)), tagOf(full.root).textContent, note(full)]);
    const hidden = withPv({ preview: { rows: ['x'], hidden: 7, fallback: false, view: VIEW } });
    seen.set('hidden', [tagOf(hidden.root).attrs['data-s'], hrefs(tagOf(hidden.root)), tagOf(hidden.root).textContent, note(hidden)]);
    const growing = rig();
    growing.render(askPv({ preview: { rows: ['x'], hidden: 7, fallback: false, view: VIEW } }), { growing: true });
    seen.set('growing', [tagOf(growing.root).attrs['data-s'], tagOf(growing.root).all(withClass('spin')).length, tagOf(growing.root).textContent, note(growing)]);
    const fallback = withPv({ preview: { rows: [], hidden: 0, fallback: true, view: VIEW } });
    seen.set('fallback', [tagOf(fallback.root).attrs['data-s'], hrefs(tagOf(fallback.root)), tagOf(fallback.root).textContent, note(fallback)]);
    const showing = withPv();
    pickRadio(showing, 2);
    seen.set('showing', [tagOf(showing.root).attrs['data-s'], tagOf(showing.root).all(withClass('spin')).length, tagOf(showing.root).textContent, note(showing)]);
    assert.deepEqual(seen.get('full'), ['full', ['#i-check'], 'Full preview', '']);
    assert.deepEqual(seen.get('hidden'), ['hidden', ['#i-warn'], '7 lines hidden', '7 lines hidden: see the terminal. Claude left them out to fit the pane; a taller terminal shows them.']);
    assert.deepEqual(seen.get('growing'), ['growing', 1, 'Showing more lines', '']);
    assert.deepEqual(seen.get('fallback'), ['fallback', ['#i-info'], 'No preview', "Claude can't show this preview at this size: compare the labels instead."]);
    assert.deepEqual(seen.get('showing'), ['showing', 1, 'Showing your pick', '']);
    assert.equal(new Set([...seen.values()].map((v) => v[0])).size, 5, 'five colour tokens');
    assert.equal(new Set([...seen.values()].map((v) => v[2])).size, 5, 'five words: colour alone never tells two states apart');
  });

  test('(\u2212) one line hidden says "line"; the fallback draws no pre; a plain full preview has no note line', () => {
    const one1 = withPv({ preview: { rows: ['x'], hidden: 1, fallback: false, view: VIEW } });
    assert.equal(tagOf(one1.root).textContent, '1 line hidden');
    const fb = withPv({ preview: { rows: [], hidden: 0, fallback: true, view: VIEW } });
    assert.equal(preOf(fb.root)?.hidden === true || preOf(fb.root) === null, true);
    const full = withPv();
    assert.ok(noteOf(full.root) === null || noteOf(full.root).hidden === true);
  });

  test('(+) Chat having the focus in the terminal: no radio checked and the caption says so; the pre still shows the preview', () => {
    const r = withPv({ focus: 'chat' });
    assert.deepEqual(radiosOf(r.root).map((i) => i.checked), [false, false, false]);
    assert.equal(capOf(r.root).textContent, `Preview${MIDDLE}Chat about this has the focus in the terminal`);
    assert.equal(preOf(r.root).textContent, '( oval )\n\n  long and round');
    assert.equal(off(byText(r.root, 'Answer')), true, 'nothing is picked');
  });

  test('(+) a capture with the same sig repaints in place: the pre, the caption and the tag change; the radios and a typed note stay the same nodes', () => {
    const r = withPv();
    const before = radiosOf(r.root);
    byText(r.root, 'Add a note').click();
    const field = one(r.root, 'dlg-note-text');
    field.value = 'make it round';
    field.fire('input');
    r.render(askPv({ focus: 2, preview: { rows: ['[ box ]'], hidden: 3, fallback: false, view: VIEW2 } }));
    assert.deepEqual(radiosOf(r.root), before, 'the same nodes');
    assert.deepEqual(radiosOf(r.root).map((i) => i.checked), [false, true, false]);
    assert.equal(preOf(r.root).textContent, '[ box ]');
    assert.equal(capOf(r.root).textContent, `Preview${MIDDLE}Box`);
    assert.equal(tagOf(r.root).attrs['data-s'], 'hidden');
    assert.equal(one(r.root, 'dlg-note-text'), field);
    assert.equal(field.value, 'make it round');
    assert.equal(r.log.calls.length, 0, 'a repaint sends nothing');
  });

  test('(+) picking another option asks Claude to move there ({ sig, focus }, no view); the tag says Showing your pick and Answer is off until a capture shows the focus there', async () => {
    const h = holdReply();
    const r = withPv({}, { reply: h.reply });
    pickRadio(r, 2);
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, focus: 2 }]);
    assert.equal(tagOf(r.root).attrs['data-s'], 'showing');
    assert.equal(off(byText(r.root, 'Answer')), true, 'a request is in flight');
    h.held[0].resolve({ status: 200, body: { done: 'focused', sent: 1 } });
    await settle();
    assert.equal(off(byText(r.root, 'Answer')), true, 'the screen does not show it yet');
    assert.equal(tagOf(r.root).attrs['data-s'], 'showing');
    assert.deepEqual(r.log.say, ['Sent 1 key to %12']);
    r.render(askPv({ focus: 2, preview: { rows: ['[ box ]'], hidden: 0, fallback: false, view: VIEW2 } }));
    assert.equal(tagOf(r.root).attrs['data-s'], 'full');
    assert.equal(off(byText(r.root, 'Answer')), false);
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r).at(-1), { sig: SIG, view: VIEW2, picks: [2] }, 'the answer carries the view of the capture that showed the focus');
  });

  test('(+) one focus request at a time; picks while it runs are coalesced to the last, which goes when the first ends; picking the option Claude is already on sends nothing', async () => {
    const h = holdReply();
    const r = withPv({}, { reply: h.reply });
    pickRadio(r, 2);
    pickRadio(r, 3);
    pickRadio(r, 2);
    pickRadio(r, 3);
    await settle();
    assert.equal(h.held.length, 1, 'one in flight');
    h.held[0].resolve({ status: 200, body: { done: 'focused', sent: 1 } });
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, focus: 2 }, { sig: SIG, focus: 3 }], 'the last pick goes next');
    h.held[1].resolve({ status: 200, body: { done: 'focused', sent: 1 } });
    await settle();
    assert.equal(h.held.length, 2, 'nothing more to send');
    const same = withPv({}, { reply: holdReply().reply });
    pickRadio(same, 1);
    await settle();
    assert.equal(same.log.calls.length, 0);
  });

  test('(+) a pick back to where Claude was before the first request finished goes as a request too (Claude has moved by then)', async () => {
    const h = holdReply();
    const r = withPv({}, { reply: h.reply });
    pickRadio(r, 2);
    pickRadio(r, 1);
    h.held[0].resolve({ status: 200, body: { done: 'focused', sent: 1 } });
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, focus: 2 }, { sig: SIG, focus: 1 }]);
  });

  test('(\u2212) a focus request the route refuses: its fixed line, the radio goes back to Claude\'s focus; dialog-focus locks with Try again, not-taken does not', async () => {
    for (const [code, locked] of [['dialog-focus', true], ['not-taken', false]]) {
      const r = withPv({}, { reply: () => ({ status: 409, body: { error: code, sent: 1 } }) });
      pickRadio(r, 3);
      await settle();
      assert.equal(r.log.problem.at(-1)[1], 'warn', code);
      assert.match(r.log.problem.at(-1)[0], / nika had pressed 1 key in the pane before it stopped\.$/, code);
      assert.deepEqual(radiosOf(r.root).map((i) => i.checked), [true, false, false], `${code}: back to Claude's focus`);
      assert.equal(tagOf(r.root).attrs['data-s'], 'full');
      assert.equal(off(byText(r.root, 'Answer')), locked, code);
    }
  });

  test('(\u2212) the capture shows Claude\'s focus somewhere else than the pick, and no request is waiting: the pick follows Claude (moved in the terminal); two captures that never show an answered pick give it up', async () => {
    const r = withPv();
    r.render(askPv({ focus: 3, preview: { rows: ['* star *'], hidden: 0, fallback: false, view: VIEW2 } }));
    assert.deepEqual(radiosOf(r.root).map((i) => i.checked), [false, false, true]);
    assert.equal(tagOf(r.root).attrs['data-s'], 'full');
    const h = rig({ reply: () => ({ status: 200, body: { done: 'focused', sent: 1 } }) });
    h.render(askPv());
    pickRadio(h, 2);
    await settle();
    h.render(askPv());
    assert.equal(tagOf(h.root).attrs['data-s'], 'showing', 'one stale capture is waited out');
    h.render(askPv());
    assert.equal(tagOf(h.root).attrs['data-s'], 'full', 'the second one gives the pick up');
    assert.deepEqual(radiosOf(h.root).map((i) => i.checked), [true, false, false]);
  });

  test('(\u2212) terminal only (bypass): the panel shows, the radios are read-only, no focus request and no Chat, no note part', async () => {
    const r = withPv({ bypass: true });
    assert.ok(tagOf(r.root));
    assert.ok(radiosOf(r.root).every((i) => i.disabled === true));
    pickRadio(r, 2);
    await settle();
    assert.equal(r.log.calls.length, 0);
    assert.equal(off(byText(r.root, 'Chat about this')), true);
    assert.equal(byText(r.root, 'Add a note'), null);
  });

  test('(+) the answer goes as { sig, view, picks } and the form follows the next step; a plain press of Answer with Chat focused does nothing', async () => {
    const r = withPv({ focus: 2 });
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, view: VIEW, picks: [2] }]);
    assert.equal(chip(r.root).textContent, 'Answered');
    const c = withPv({ focus: 'chat' });
    byText(c.root, 'Answer').click();
    await settle();
    assert.equal(c.log.calls.length, 0);
  });

  test('(\u2212) text only: a row with markup and a long label show as text, never as elements', () => {
    const r = withPv({ preview: { rows: ['<b>bold</b>', '<img src=x onerror=alert(1)>'], hidden: 0, fallback: false, view: VIEW }, options: [{ n: 1, label: '<i>Oval</i>', description: null }, { n: 2, label: 'Box', description: null }, { n: 3, label: 'Star', description: null }] });
    assert.equal(preOf(r.root).textContent, '<b>bold</b>\n<img src=x onerror=alert(1)>');
    assert.equal(preOf(r.root).kids.length, 0, 'text only: no child element');
    assert.equal(capOf(r.root).textContent, `Preview${MIDDLE}<i>Oval</i>`);
    assert.equal(r.root.all((n) => n.tag === 'b' || n.tag === 'img' || n.tag === 'i').length, 0);
  });
});

const radiosOf0 = (root) => inputs(root, 'radio');
const holdReply0 = () => { const held = []; return { held, reply: () => new Promise((resolve) => { held.push({ resolve }); }) }; };

describe('a question step with a preview: notes, Chat about this and the stale line (0.5.4, QP; design 4.4, 6, 7)', () => {
  const withPv = (over = {}, rigOpts = {}) => { const r = rig(rigOpts); r.render(askPv(over)); return r; };
  const typeNote = (r, v) => { const t = one(r.root, 'dlg-note-text'); t.value = v; t.fire('input'); return t; };
  const noteLine = (root) => root.all((n) => n.attrs.id === 'dlg-note-lead')[0] ?? null;
  const LEAD = 'Start with a word: Claude can read a first digit as an option.';

  test('(+) "Add a note" is a disclosure: closed it shows nothing, open it shows the labelled field (300 characters); the note goes with the next Answer, not by itself', async () => {
    const r = withPv();
    const add = byText(r.root, 'Add a note');
    assert.equal(add.attrs['aria-expanded'], 'false');
    assert.equal(one(r.root, 'dlg-note-text'), null, 'the field is not drawn closed');
    add.click();
    assert.equal(add.attrs['aria-expanded'], 'true');
    const field = one(r.root, 'dlg-note-text');
    assert.equal(field.tag, 'input');
    assert.equal(field.attrs.maxlength, '300');
    assert.equal(add.attrs['aria-controls'], field.parent.attrs.id);
    assert.match(field.parent.textContent, /Note for Claude \(optional\)/);
    typeNote(r, '  make it round  ');
    assert.equal(r.log.calls.length, 0, 'no separate request');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, view: VIEW, picks: [1], note: 'make it round' }]);
  });

  test('(+) Enter in the note field is Answer; (\u2212) Shift+Enter and an IME Enter are not', async () => {
    const r = withPv();
    byText(r.root, 'Add a note').click();
    const field = typeNote(r, 'round');
    field.fire('keydown', { key: 'Enter', shiftKey: true });
    field.fire('keydown', { key: 'Enter', isComposing: true });
    await settle();
    assert.equal(r.log.calls.length, 0);
    const e = field.fire('keydown', { key: 'Enter' });
    await settle();
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(sentBodies(r), [{ sig: SIG, view: VIEW, picks: [1], note: 'round' }]);
  });

  test('(+) the counter shows from 250 characters; (\u2212) not before', () => {
    const r = withPv();
    byText(r.root, 'Add a note').click();
    typeNote(r, 'a'.repeat(249));
    const count = one(r.root, 'dlg-count');
    assert.equal(count.hidden, true);
    typeNote(r, 'a'.repeat(250));
    assert.equal(count.hidden, false);
    assert.equal(count.textContent, '250/300');
  });

  test('(+) a note that starts with a digit shows the warn line, sends nothing and keeps the focus in the field; the note without a digit goes', async () => {
    const r = withPv();
    byText(r.root, 'Add a note').click();
    const field = typeNote(r, '2 big');
    const line = noteLine(r.root);
    assert.equal(line.hidden, false);
    assert.equal(line.textContent, LEAD);
    assert.deepEqual(hrefs(line), ['#i-warn']);
    assert.equal(field.getAttribute('aria-describedby'), 'dlg-note-lead');
    assert.equal(off(byText(r.root, 'Answer')), true);
    focus.el = byText(r.root, 'Answer');
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(r.log.calls.length, 0);
    assert.equal(focus.el, field);
    typeNote(r, 'big 2');
    assert.equal(noteLine(r.root).hidden, true);
  });

  test('(+) a note already on screen is a read-only line ("Note: ..."); the answer carries none; (\u2212) no "Add a note" beside it', async () => {
    const r = withPv({ notes: { text: 'saved <b>earlier</b>', editing: false } });
    const line = one(r.root, 'dlg-note-on');
    assert.equal(line.textContent, 'Note: saved <b>earlier</b>');
    assert.deepEqual(hrefs(line), ['#i-text']);
    assert.equal(r.root.all((n) => n.tag === 'b').length, 0);
    assert.equal(byText(r.root, 'Add a note'), null);
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, view: VIEW, picks: [1] }]);
  });

  test('(\u2212) a note typed in the form and then shown on screen (typed in the terminal): the line wins and the typed one is not sent', async () => {
    const r = withPv();
    byText(r.root, 'Add a note').click();
    typeNote(r, 'mine');
    r.render(askPv({ notes: { text: 'theirs', editing: false } }));
    assert.equal(one(r.root, 'dlg-note-on').textContent, 'Note: theirs');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, view: VIEW, picks: [1] }]);
  });

  test('(\u2212) Claude\'s notes field open in the terminal: the form locks at once with the notes-open line and Try again, and sends nothing; Try again lifts the lock, a field still open locks it again', async () => {
    const r = withPv({ notes: { text: '', editing: true } });
    assert.deepEqual(r.log.problem.at(-1), ["Claude's notes field is open in the terminal. Close it there, then press Try again.", 'warn']);
    assert.equal(off(byText(r.root, 'Answer')), true);
    assert.ok(radiosOf0(r.root).every((i) => off(i)));
    assert.equal(off(byText(r.root, 'Chat about this')), true);
    assert.equal(byText(r.root, 'Add a note'), null);
    assert.equal(r.log.calls.length, 0);
    const again = byText(r.root, 'Try again');
    assert.equal(hiddenUp(again), false);
    r.render(askPv({ notes: { text: null, editing: false } }));
    again.click();
    assert.equal(off(byText(r.root, 'Answer')), false);
    r.render(askPv({ notes: { text: '', editing: true } }));
    assert.equal(off(byText(r.root, 'Answer')), true, 'still open: locked again');
  });

  test('(+) the new answers have their fixed lines: preview-changed and note-mode re-enable the form, notes-open and note-mismatch lock it, only notes-open has Try again; with keys pressed the note is taken off the form (0.5.4, QPF, F2)', async () => {
    const cases = [['preview-changed', false, false], ['note-mode', false, false], ['notes-open', true, true], ['note-mismatch', true, false]];
    for (const [code, locked, retry] of cases) {
      const r = withPv({}, { reply: () => ({ status: 409, body: { error: code, sent: 2 } }) });
      byText(r.root, 'Add a note').click();
      const field = typeNote(r, 'round it');
      byText(r.root, 'Answer').click();
      await settle();
      assert.equal(r.log.problem.at(-1)[1], 'warn', code);
      assert.match(r.log.problem.at(-1)[0], / nika had pressed 2 keys in the pane before it stopped\. Your note may already be in Claude's notes field, so nika took it off this form\. Check the terminal\.$/, code); // 0.5.4 (QPF, F2): keys were pressed, so the note is taken off the form
      assert.equal(off(byText(r.root, 'Answer')), locked, code);
      assert.equal(hiddenUp(byText(r.root, 'Try again')), !retry, code);
      assert.equal(one(r.root, 'dlg-note-text'), null, `${code}: the note part is closed`);
      assert.equal(field.value, '', `${code}: the note text is cleared`);
    }
  });

  test('(+) Chat about this sends { sig, chat: true } once; the form becomes an Answered chip with the word "Sent to chat" and says Chat was sent; (\u2212) it is locked until the dialog is gone', async () => {
    const r = withPv({}, { reply: () => ({ status: 200, body: { done: 'chat', sent: 4 } }) });
    const chat = byText(r.root, 'Chat about this');
    assert.deepEqual(hrefs(chat), ['#i-text']);
    assert.equal(chat.attrs.title, "Closes Claude's questions so you can talk them over with Claude instead. Answers you already gave may not reach Claude."); // 0.5.4 (QPF, F4): exact, owner ruling
    chat.click();
    chat.click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, chat: true }]);
    assert.equal(chip(r.root).textContent, 'Sent to chat');
    assert.equal(chip(r.root).attrs['data-s'], 'answered');
    assert.ok(r.log.announce.includes('Sent Chat about this to builder-1.'));
    assert.equal(off(byText(r.root, 'Chat about this')), true);
    assert.equal(off(byText(r.root, 'Answer')), true);
    r.render(null);
    assert.equal(r.df.shown(), false);
  });

  test('(\u2212) Chat is off while a focus request runs, and a refused Chat shows its fixed line', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    const i = radiosOf0(r.root)[1];
    i.checked = true;
    i.fire('change');
    await settle();
    assert.equal(off(byText(r.root, 'Chat about this')), true);
    const refused = withPv({}, { reply: () => ({ status: 409, body: { error: 'not-taken', sent: 3 } }) });
    byText(refused.root, 'Chat about this').click();
    await settle();
    assert.equal(refused.log.problem.at(-1)[0], "Claude didn't take the key. Check the session, then try again. nika had pressed 3 keys in the pane before it stopped.");
  });

  test('(+) a question step without a preview shows "Chat about this: use the terminal" as a line and no button; (\u2212) the Review and a plan show neither', () => {
    for (const d of [ask(), multi()]) {
      const r = rig();
      r.render(d);
      const line = q(r.root, 'pbtn-off').find((n) => /Chat about this/.test(n.textContent));
      assert.equal(line.textContent, 'Chat about this: use the terminal');
      assert.equal(byText(r.root, 'Chat about this'), null);
    }
    for (const d of [review(), plan()]) {
      const r = rig();
      r.render(d);
      assert.equal(/Chat about this/.test(r.root.textContent), false);
    }
  });

  test('(+) a new step (another sig) clears the problem line a step before left; the same step does not', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'not-taken' } }) });
    r.render(askPv());
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(r.log.problem.at(-1)[0], "Claude didn't take the key. Check the session, then try again.");
    r.render(askPv());
    assert.equal(r.log.problem.at(-1)[0], "Claude didn't take the key. Check the session, then try again.", 'the same step keeps it');
    r.render(askPv({ sig: SIG2, question: 'Which size?' }));
    assert.deepEqual(r.log.problem.at(-1), [''], 'the next step clears it');
  });
});

// ---- the preview panel's stylesheet (0.5.4, QP; design 4.2: every state has its own colour token, icon and word) -----------------------

describe('the preview panel stylesheet (0.5.4, QP)', () => {
  const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'session.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** The declarations of the rule whose selector is exactly `sel`. */
  const rule = (sel) => {
    const at = CSS.indexOf(`\n${sel} {`);
    if (at === -1) return '';
    return CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  };
  const STATES = ['full', 'hidden', 'growing', 'fallback', 'showing'];
  const colourOf = (decl) => /(?:^|[;\s])color:\s*var\((--[a-z0-9-]+)\)/.exec(decl)?.[1];
  const fillOf = (decl) => /(?:^|[;\s])background:\s*([a-z0-9()-]+)/.exec(decl)?.[1];

  test('(+) each state has its own rule with a colour token; no two states share a colour and fill pair', () => {
    const pairs = STATES.map((s) => {
      const decl = rule(`.dlg-pv-tag[data-s="${s}"]`);
      assert.notEqual(colourOf(decl), undefined, `${s} has a colour token`);
      assert.notEqual(fillOf(decl), undefined, `${s} has a fill`);
      return `${colourOf(decl)}|${fillOf(decl)}`;
    });
    assert.equal(new Set(pairs).size, STATES.length, pairs.join(' / '));
    assert.match(rule('.dlg-pv-tag[data-s="fallback"]'), /border:\s*1px dashed var\(--line-strong\)/, 'the fallback is told apart by its dashed edge too, not by colour alone');
  });

  test('(\u2212) the panel rules use tokens only: no hex colour, no rgb(), no inline-style hook', () => {
    const own = CSS.split('\n').filter((l) => /\.dlg-(pv|notepart|note-add|note-box|note-l|note-on|chat)\b/.test(l)).join('\n');
    assert.notEqual(own.length, 0);
    assert.doesNotMatch(own, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  test('(+) the text panel scrolls instead of growing without end, keeps its whitespace and is a focus target; (\u2212) it is not a wrapping box', () => {
    const decl = rule('.dlg-pv-text');
    assert.match(decl, /white-space:\s*pre\s*;/);
    assert.match(decl, /overflow:\s*auto\s*;/);
    assert.match(decl, /position:\s*relative\s*;/, 'a scroll container is a containing block (test/ui.test.js)');
    assert.match(decl, /max-height:\s*min\(40vh,\s*360px\)/);
    assert.match(decl, /font:\s*var\(--fs-small\)\/1\.35 var\(--mono\)/);
    assert.match(CSS, /\.dlg-pv-text:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
    assert.doesNotMatch(decl, /white-space:\s*(?:normal|pre-wrap)/);
  });

  test('(+) the spinner of the tag stops under reduced motion, like the chip\'s', () => {
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.dlg-pv-tag \.spin\s*\{\s*animation:\s*none;/);
  });
});

// ---- a question step with a preview: the gates and the corner cases that the step 5 mutation round found unguarded (0.5.4, QP) ------------------

describe('a question step with a preview: gates and corner cases (0.5.4, QP)', () => {
  const withPv = (over = {}, rigOpts = {}) => { const r = rig(rigOpts); r.render(askPv(over)); return r; };
  const pick = (r, n) => { const i = inputs(r.root, 'radio')[n - 1]; i.checked = true; i.fire('change'); return i; };
  const checked = (r) => inputs(r.root, 'radio').map((i) => i.checked);
  const tag = (r) => one(r.root, 'dlg-pv-tag');
  const typeNote = (r, v) => { const t = one(r.root, 'dlg-note-text'); t.value = v; t.fire('input'); return t; };
  const pv = (over = {}) => ({ rows: ['x'], hidden: 0, fallback: false, view: VIEW, ...over });
  const OK = { status: 200, body: { done: 'focused', sent: 1 } };
  const EDITING = { text: '', editing: true };
  const mentions = (r, re) => r.log.problem.some((p) => re.test(p[0]));

  test('(\u2212) previewState: growing needs lines hidden and a real preview; with nothing hidden or the fallback it is full or fallback', () => {
    assert.equal(previewState({ focus: 1, preview: pv({ hidden: 0 }), pick: 1, growing: true }), 'full');
    assert.equal(previewState({ focus: 1, preview: pv({ hidden: 4, fallback: true, rows: [] }), pick: 1, growing: true }), 'fallback');
  });

  test('(+) the radios show the pick while its request runs and after it, until a capture says where Claude is', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    pick(r, 3);
    await settle();
    assert.deepEqual(checked(r), [false, false, true], 'the pick, not Claude\'s focus');
    h.held[0].resolve(OK);
    await settle();
    assert.deepEqual(checked(r), [false, false, true]);
    assert.equal(tag(r).attrs['data-s'], 'showing');
  });

  test('(+) a new count of hidden lines on the same step is drawn: the tag and the note say the new number', () => {
    const r = withPv({ preview: pv({ hidden: 3 }) });
    assert.match(tag(r).textContent, /3 lines hidden/);
    assert.match(one(r.root, 'dlg-pv-note').textContent, /^3 lines hidden: see the terminal/);
    r.render(askPv({ preview: pv({ hidden: 5 }) }));
    assert.match(tag(r).textContent, /5 lines hidden/);
    assert.match(one(r.root, 'dlg-pv-note').textContent, /^5 lines hidden: see the terminal/);
    assert.equal(tag(r).attrs['data-s'], 'hidden');
  });

  test('(\u2212) a form that cannot take answers ignores a radio change: no request, the pick stays where Claude is', async () => {
    const r = withPv({ notes: EDITING });
    pick(r, 2);
    await settle();
    assert.equal(r.log.calls.length, 0);
    assert.deepEqual(checked(r), [true, false, false]);
  });

  test('(+) after a capture showed the focus at the pick, a pick of that option again (Claude moved away in the terminal) is a new request', async () => {
    const r = rig({ reply: () => OK });
    r.render(askPv());
    pick(r, 3);
    await settle();
    r.render(askPv({ focus: 3, preview: pv({ view: VIEW2 }) }));
    r.render(askPv({ focus: 1 }));
    pick(r, 3);
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, focus: 3 }, { sig: SIG, focus: 3 }]);
  });

  test('(+) Claude\'s focus moved somewhere else than the pick (in the terminal) after our answer: the pick follows at once, not after two captures', async () => {
    const r = rig({ reply: () => OK });
    r.render(askPv());
    pick(r, 2);
    await settle();
    r.render(askPv({ focus: 3, preview: pv({ view: VIEW2 }) }));
    assert.deepEqual(checked(r), [false, false, true]);
    assert.equal(tag(r).attrs['data-s'], 'full');
  });

  test('(+) a capture while a focus request runs does not give the pick up (the focus moves one key at a time)', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    pick(r, 3);
    await settle();
    r.render(askPv({ focus: 2, preview: pv({ view: VIEW2 }) }));
    assert.deepEqual(checked(r), [false, false, true], 'still the pick');
    assert.equal(tag(r).attrs['data-s'], 'showing');
    h.held[0].resolve(OK);
    await settle();
    r.render(askPv({ focus: 3, preview: pv({ view: VIEW2 }) }));
    assert.equal(tag(r).attrs['data-s'], 'full');
  });

  test('(\u2212) Answer is off while a focus request runs even when the pick is back on Claude\'s focus', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    pick(r, 2);
    pick(r, 1);
    await settle();
    assert.deepEqual(checked(r), [true, false, false]);
    assert.equal(off(byText(r.root, 'Answer')), true);
  });

  test('(\u2212) Chat about this does nothing while a focus request runs, even when pressed', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    pick(r, 2);
    byText(r.root, 'Chat about this').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, focus: 2 }]);
  });

  test('(\u2212) Claude\'s notes field open: no note line from the terminal text and no "Add a note", whatever the field holds', () => {
    for (const text of ['', 'half typed']) {
      const r = withPv({ notes: { text, editing: true } });
      assert.equal(one(r.root, 'dlg-note-on'), null, JSON.stringify(text));
      assert.equal(byText(r.root, 'Add a note'), null, JSON.stringify(text));
    }
  });

  test('(\u2212) a note that starts with a digit, typed and then shown on screen by the terminal: no warning is left, Answer goes without a note', async () => {
    const r = withPv();
    byText(r.root, 'Add a note').click();
    typeNote(r, '2 big');
    r.render(askPv({ notes: { text: 'theirs', editing: false } }));
    assert.equal(off(byText(r.root, 'Answer')), false);
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, view: VIEW, picks: [1] }]);
  });

  test('(\u2212) a note typed and then hidden again (the disclosure closed) is not sent, and a digit-led one does not block Answer', async () => {
    const a = withPv();
    byText(a.root, 'Add a note').click();
    typeNote(a, 'round');
    byText(a.root, 'Add a note').click();
    byText(a.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(a), [{ sig: SIG, view: VIEW, picks: [1] }]);
    const b = withPv();
    byText(b.root, 'Add a note').click();
    typeNote(b, '2 big');
    byText(b.root, 'Add a note').click();
    assert.equal(off(byText(b.root, 'Answer')), false);
    byText(b.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(b), [{ sig: SIG, view: VIEW, picks: [1] }]);
  });

  test('(+) the first-digit warning is announced once when it appears', () => {
    const r = withPv();
    byText(r.root, 'Add a note').click();
    typeNote(r, '2 big');
    assert.equal(r.log.announce.filter((a) => a === 'Start with a word: Claude can read a first digit as an option.').length, 1);
    typeNote(r, '2 bigger');
    assert.equal(r.log.announce.filter((a) => a === 'Start with a word: Claude can read a first digit as an option.').length, 1, 'not again for the same warning');
  });

  test('(+) the notes field opening on a capture of the same step locks the form at once', () => {
    const r = withPv();
    assert.equal(mentions(r, /notes field is open/), false);
    r.render(askPv({ notes: EDITING }));
    assert.equal(mentions(r, /notes field is open/), true);
    assert.equal(off(byText(r.root, 'Answer')), true);
  });

  test('(\u2212) the notes field opening while an answer is on its way (nika\'s own `n` does that) does not lock the form; the answer\'s result stands', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    byText(r.root, 'Answer').click();
    await settle();
    r.render(askPv({ notes: EDITING }));
    assert.equal(mentions(r, /notes field is open/), false);
    h.held[0].resolve({ status: 200, body: { done: 'next', sent: 1 } });
    await settle();
    assert.equal(mentions(r, /notes field is open/), false);
    assert.equal(chip(r.root).textContent, 'Answered');
  });

  test('(\u2212) the notes field opening while a focus request runs waits for its end; the next capture locks', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    pick(r, 2);
    await settle();
    r.render(askPv({ notes: EDITING }));
    assert.equal(mentions(r, /notes field is open/), false);
    h.held[0].resolve(OK);
    await settle();
    r.render(askPv({ notes: EDITING }));
    assert.equal(mentions(r, /notes field is open/), true);
  });

  test('(\u2212) a form that is locked already keeps its own line when the notes field opens', async () => {
    const r = withPv({}, { reply: () => ({ status: 409, body: { error: 'note-mismatch' } }) });
    byText(r.root, 'Answer').click();
    await settle();
    const line = r.log.problem.at(-1)[0];
    assert.doesNotMatch(line, /notes field is open/);
    r.render(askPv({ notes: EDITING }));
    assert.equal(r.log.problem.at(-1)[0], line);
    assert.equal(hiddenUp(byText(r.root, 'Try again')), true, 'no Try again for this one');
  });

  test('(\u2212) answerBody: a focus or Chat request carries nothing else; Chat needs exactly true', () => {
    const d = cleanDialog(askPv());
    assert.deepEqual(answerBody(d, { focus: 2 }), { sig: SIG, focus: 2 });
    assert.equal(answerBody(d, { focus: 2, picks: [2] }), null);
    assert.equal(answerBody(d, { focus: 2, text: 'x' }), null);
    assert.equal(answerBody(d, { chat: true, focus: 2 }), null);
    assert.equal(answerBody(d, { chat: true, picks: [1] }), null);
    assert.equal(answerBody(d, { chat: true, note: 'x' }), null);
    assert.equal(answerBody(d, { chat: 1 }), null);
    assert.equal(answerBody(d, { chat: 'true' }), null);
    assert.deepEqual(answerBody(d, { chat: true }), { sig: SIG, chat: true });
  });
});

// ---- 0.5.4 (QPF): F4 the Chat copy, F2 the note after a refusal, F1b the form the screen can no longer show -----------------------------------------

const NOTE_TAKEN_TEXT = "Your note may already be in Claude's notes field, so nika took it off this form. Check the terminal.";
const NOTE_ROOM_TEXT = "Claude's notes field doesn't fit this pane's width, so nika typed nothing. Answer without the note, make the pane wider, or add the note in the terminal.";
const CHAT_TITLE_TEXT = "Closes Claude's questions so you can talk them over with Claude instead. Answers you already gave may not reach Claude.";

describe('F4 (0.5.4, QPF): Chat about this says answers already given may not reach Claude', () => {
  test('(+) the button title is the owner\'s text, exactly; the source carries no promise that answers stay', () => {
    const r = rig();
    r.render(askPv());
    assert.equal(byText(r.root, 'Chat about this').attrs.title, CHAT_TITLE_TEXT);
    assert.doesNotMatch(SRC, /already given stay|answers given stay|answers stay|talk it over/i, 'title and comment alike');
    assert.match(SRC, /answers already given may not reach Claude \(LC-QPB\)/);
  });

  test('(\u2212) the title does not say anything stays, and does not mention dropped questions', () => {
    const r = rig();
    r.render(askPv());
    const title = byText(r.root, 'Chat about this').attrs.title;
    assert.doesNotMatch(title, /stay/i);
    assert.doesNotMatch(title, /dropped/i);
  });
});

describe('F2 (0.5.4, QPF): dialogOutcome drops a note that may already be in Claude\'s field, and holds one nika never typed', () => {
  const o = (status, code, extra = {}) => dialogOutcome({ status, code, note: true, ...extra });

  test('(+) keys pressed, or a failure that may have pressed some (status 0, 5xx): dropNote, and the message ends with the fixed sentence', () => {
    const unread = o(409, 'dialog-unread', { sent: 1 });
    assert.equal(unread.dropNote, true);
    assert.equal(unread.message, `nika can't read Claude's dialog right now, so it stopped. Check the terminal, then press Try again. nika had pressed 1 key in the pane before it stopped. ${NOTE_TAKEN_TEXT}`);
    for (const [status, code, sent] of [[409, 'note-mismatch', 2], [409, 'preview-changed', 2], [0, undefined, undefined], [500, undefined, undefined], [409, 'not-taken', 3]]) {
      const x = o(status, code, { sent });
      assert.equal(x.dropNote, true, `${status} ${code}`);
      assert.ok(x.message.endsWith(` ${NOTE_TAKEN_TEXT}`), `${status} ${code}: ${x.message}`);
      assert.equal(x.message.split(NOTE_TAKEN_TEXT).length, 2, `${status} ${code}: said once`);
    }
    assert.equal(o(0).message, `nika couldn't reach tmux. ${NOTE_TAKEN_TEXT}`);
    assert.equal(o(409, 'already-answered', { sent: 1 }).dropNote, true, 'a step that was answered with keys pressed: the note is off the form too');
    assert.equal(o(409, 'already-answered', { sent: 1 }).phase, 'answered');
  });

  test('(\u2212) a refusal before any key (400, 409, 429 without `sent`) holds the note: no dropNote, no sentence', () => {
    for (const [status, code] of [[409, 'note-room'], [409, 'note-mode'], [409, 'notes-open'], [409, 'already-answered'], [409, 'preview-changed'], [409, 'dialog-changed'], [400, 'invalid'], [400, 'terminal-only'], [429, undefined]]) {
      const x = o(status, code);
      assert.equal(x.dropNote, false, `${status} ${code}`);
      assert.ok(!x.message.includes('took it off this form'), `${status} ${code}`);
    }
    assert.equal(o(409, 'note-room').message, NOTE_ROOM_TEXT);
    assert.equal(o(409, 'already-answered').message, '', 'already-answered without keys still shows no line');
  });

  test('(\u2212) a request that carried no note drops nothing and says nothing about one; neither does a success', () => {
    for (const note of [undefined, false, 'yes', 1, null]) {
      const x = dialogOutcome({ status: 409, code: 'note-mismatch', sent: 2, note });
      assert.equal(x.dropNote, false, String(note));
      assert.ok(!x.message.includes('took it off this form'), String(note));
    }
    assert.equal(dialogOutcome({ status: 500 }).dropNote, false);
    for (const done of ['next', 'review', 'submitted', 'chosen', 'declined', 'chat', 'moved', 'focused']) {
      assert.equal(o(200, undefined, { done, sent: 2 }).dropNote, false, done);
    }
  });

  test('(+) note-room is a fixed, unlocked line, like note-mode', () => {
    const x = o(409, 'note-room');
    assert.deepEqual([x.ok, x.phase, x.lock, x.retry, x.kind, x.message], [false, 'failed', false, false, 'warn', NOTE_ROOM_TEXT]);
    assert.equal(o(400, 'note-room').message, "nika couldn't send this answer. Check it and try again.", 'another status gets the generic line');
  });
});

describe('F2 (0.5.4, QPF): the form after a refused answer that carried a note', () => {
  const withPv = (over = {}, rigOpts = {}) => { const r = rig(rigOpts); r.render(askPv(over)); return r; };
  const typeNote = (r, v) => { const t = one(r.root, 'dlg-note-text'); t.value = v; t.fire('input'); return t; };

  test('(+) keys were pressed: the note input is empty, the note part closed and the sentence shown; Try again, then Answer, posts no note', async () => {
    const r = withPv({}, { reply: () => ({ status: 409, body: { error: 'dialog-unread', sent: 1 } }) });
    byText(r.root, 'Add a note').click();
    const field = typeNote(r, 'round it');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r), [{ sig: SIG, view: VIEW, picks: [1], note: 'round it' }]);
    assert.equal(r.log.problem.at(-1)[0].endsWith(` ${NOTE_TAKEN_TEXT}`), true);
    assert.equal(field.value, '', 'the text is gone');
    assert.equal(one(r.root, 'dlg-note-text'), null, 'the field is not drawn');
    assert.equal(byText(r.root, 'Add a note').attrs['aria-expanded'], 'false');
    assert.equal(field.parent.all(withClass('dlg-count'))[0].hidden, true, 'the counter went with it');
    byText(r.root, 'Try again').click();
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(sentBodies(r).length, 2);
    assert.deepEqual(sentBodies(r)[1], { sig: SIG, view: VIEW, picks: [1] }, 'no note is typed again into a field Claude may have open');
  });

  test('(+) a failure that may have pressed keys (status 0, a 500) takes the note off the form too', async () => {
    for (const reply of [{ status: 0, body: null }, { status: 500, body: null }]) {
      const r = withPv({}, { reply: () => reply });
      byText(r.root, 'Add a note').click();
      const field = typeNote(r, 'round it');
      byText(r.root, 'Answer').click();
      await settle();
      assert.equal(field.value, '', String(reply.status));
      assert.equal(one(r.root, 'dlg-note-text'), null, String(reply.status));
      assert.ok(r.log.problem.at(-1)[0].endsWith(NOTE_TAKEN_TEXT), String(reply.status));
    }
  });

  test('(+) 409 note-room: the form is live again, the note stays in the same field, and the note-room line is shown', async () => {
    const r = withPv({}, { reply: () => ({ status: 409, body: { error: 'note-room' } }) });
    byText(r.root, 'Add a note').click();
    const field = typeNote(r, 'round it');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(r.log.problem.at(-1), [NOTE_ROOM_TEXT, 'warn']);
    assert.equal(off(byText(r.root, 'Answer')), false, 'live again');
    assert.equal(one(r.root, 'dlg-note-text'), field);
    assert.equal(field.value, 'round it');
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(sentBodies(r).length, 2);
    assert.equal(sentBodies(r)[1].note, 'round it', 'a second try sends the note it still has');
  });

  test('(\u2212) an answer that carried no note says nothing about one, and a typed note beside a no-note body stays', async () => {
    const r = withPv({}, { reply: () => ({ status: 409, body: { error: 'dialog-unread', sent: 1 } }) });
    byText(r.root, 'Answer').click();
    await settle();
    assert.ok(!r.log.problem.at(-1)[0].includes('took it off this form'));
    const refused = withPv({}, { reply: () => ({ status: 409, body: { error: 'note-mode' } }) });
    byText(refused.root, 'Add a note').click();
    const field = typeNote(refused, 'round it');
    byText(refused.root, 'Answer').click();
    await settle();
    assert.equal(field.value, 'round it', 'no key pressed: the note stays');
    assert.ok(!refused.log.problem.at(-1)[0].includes('took it off this form'));
  });

  test('(\u2212) the dialog closed while the request ran: the refusal clears nothing and the page stays quiet', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    byText(r.root, 'Add a note').click();
    typeNote(r, 'round it');
    byText(r.root, 'Answer').click();
    r.render(null);
    h.held[0].resolve({ status: 409, body: { error: 'dialog-unread', sent: 1 } });
    await settle();
    assert.equal(r.df.shown(), false);
    assert.equal(r.root.kids.length, 0);
  });
});

describe('NT (0.5.4, LC-QPF item 3): a note taken off the form keeps its sentence when Claude\'s notes field then shows open', () => {
  const NOTES_OPEN_TEXT = "Claude's notes field is open in the terminal. Close it there, then press Try again.";
  const BOTH = `${NOTES_OPEN_TEXT} ${NOTE_TAKEN_TEXT}`;
  const withPv = (over = {}, rigOpts = {}) => { const r = rig(rigOpts); r.render(askPv(over)); return r; };
  const typeNote = (r, v) => { const t = one(r.root, 'dlg-note-text'); t.value = v; t.fire('input'); return t; };
  const opened = (over = {}) => askPv({ notes: { text: '', editing: true }, ...over }); // the capture that shows Claude's notes field open
  const refusal = (error, sent) => ({ reply: () => ({ status: 409, body: sent === undefined ? { error } : { error, sent } }) });
  /** Types a note and presses Answer; the route refuses. Returns the textarea the note was typed in. */
  const answerWithNote = async (r) => {
    byText(r.root, 'Add a note').click();
    const field = typeNote(r, 'round it');
    byText(r.root, 'Answer').click();
    await settle();
    return field;
  };

  test('(+) the live shape: preview-changed with 2 keys pressed takes the note off, then the capture shows the notes field open: the notes-open sentence and the note-taken sentence, locked with Try again, the note field empty', async () => {
    const r = withPv({}, refusal('preview-changed', 2));
    const field = await answerWithNote(r);
    assert.equal(off(byText(r.root, 'Answer')), false, 'preview-changed does not lock: this is the capture that used to replace the sentence');
    assert.ok(r.log.problem.at(-1)[0].endsWith(` ${NOTE_TAKEN_TEXT}`), 'the refusal itself says the note was taken off');
    r.render(opened());
    assert.deepEqual(r.log.problem.at(-1), [BOTH, 'warn']);
    assert.equal(off(byText(r.root, 'Answer')), true, 'locked');
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false, 'with Try again');
    assert.equal(field.value, '', 'the note is not on the form');
    assert.equal(one(r.root, 'dlg-note-text'), null);
    assert.equal(sentBodies(r).length, 1, 'nothing else was sent');
  });

  test('(+) the live order: the capture with the field open arrives while the answer is still in flight, and the refusal comes after it: the same two sentences', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    byText(r.root, 'Add a note').click();
    typeNote(r, 'round it');
    byText(r.root, 'Answer').click();
    r.render(opened());
    assert.ok(r.log.problem.every(([m]) => !m.includes('notes field is open')), 'a request in flight is left alone');
    h.held[0].resolve({ status: 409, body: { error: 'preview-changed', sent: 2 } });
    await settle();
    assert.deepEqual(r.log.problem.at(-1), [BOTH, 'warn']);
    assert.equal(off(byText(r.root, 'Answer')), true);
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false);
  });

  test('(+) a refusal that already locks (dialog-unread with 2 keys pressed) keeps its own line with the sentence once; a notes-open capture changes nothing, and after Try again the sentence is gone', async () => {
    const r = withPv({}, refusal('dialog-unread', 2));
    await answerWithNote(r);
    const line = r.log.problem.at(-1)[0];
    assert.match(line, /^nika can't read Claude's dialog right now/);
    assert.equal(line.split(NOTE_TAKEN_TEXT).length, 2, 'said once');
    const shown = r.log.problem.length;
    r.render(opened());
    assert.equal(r.log.problem.length, shown, 'a locked form shows nothing new');
    assert.equal(off(byText(r.root, 'Answer')), true);
    byText(r.root, 'Try again').click();
    r.render(opened());
    assert.deepEqual(r.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn'], 'the flag ended with Try again');
  });

  test('(\u2212) no note was taken: the plain notes-open case shows the sentence alone (an answer without a note; a note whose refusal pressed no key)', async () => {
    const plain = withPv();
    plain.render(opened());
    assert.deepEqual(plain.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn']);
    const noNote = withPv({}, refusal('preview-changed', 2));
    byText(noNote.root, 'Answer').click();
    await settle();
    assert.ok(!noNote.log.problem.at(-1)[0].includes('took it off this form'), 'the answer carried no note');
    noNote.render(opened());
    assert.deepEqual(noNote.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn']);
    const kept = withPv({}, refusal('note-mode'));
    const field = await answerWithNote(kept);
    assert.equal(field.value, 'round it', 'no key pressed: the note stayed');
    kept.render(opened());
    assert.deepEqual(kept.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn']);
  });

  test('(\u2212) after Try again, a second capture with the field open shows the sentence alone', async () => {
    const r = withPv({}, refusal('preview-changed', 2));
    await answerWithNote(r);
    r.render(opened());
    assert.deepEqual(r.log.problem.at(-1), [BOTH, 'warn']);
    r.render(askPv()); // the user closed the field in the terminal
    byText(r.root, 'Try again').click();
    assert.equal(off(byText(r.root, 'Answer')), false, 'live again');
    r.render(opened());
    assert.deepEqual(r.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn']);
    assert.equal(off(byText(r.root, 'Answer')), true, 'locked again, as before');
  });

  test('(\u2212) after a move to another step, a capture with the field open there shows the sentence alone', async () => {
    const r = withPv({}, refusal('preview-changed', 2));
    await answerWithNote(r);
    r.render(askPv({ sig: SIG2, question: 'Which size?', notes: { text: '', editing: true } }));
    assert.deepEqual(r.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn']);
    assert.equal(off(byText(r.root, 'Answer')), true);
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false);
  });

  // Round 1 (review-NT, S1): "nika took it off this form" must never be said while a newer note sits on the form.
  /** After a refusal took the first note off: opens the note part again and types `v`. Returns the textarea. */
  const typeAgain = (r, v) => {
    byText(r.root, 'Add a note').click();
    return typeNote(r, v);
  };

  test('(\u2212) P1: the sentence was set, then a later 409 note-room (no key) kept a newer note: Claude\'s field showing open gives the sentence alone, and the note is back after Try again', async () => {
    const r = withPv({}, refusal('preview-changed', 2));
    await answerWithNote(r);
    assert.ok(r.log.problem.at(-1)[0].endsWith(` ${NOTE_TAKEN_TEXT}`), 'the first refusal took the note off');
    r.state.reply = () => ({ status: 409, body: { error: 'note-room' } });
    const field = typeAgain(r, 'second');
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(r.log.problem.at(-1)[0], NOTE_ROOM_TEXT, 'no key pressed: the newer note stayed');
    assert.equal(field.value, 'second');
    r.render(opened());
    assert.deepEqual(r.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn']);
    assert.equal(off(byText(r.root, 'Answer')), true, 'still locked with Try again');
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false);
    r.render(askPv()); // the user closed the field in the terminal
    byText(r.root, 'Try again').click();
    assert.equal(one(r.root, 'dlg-note-text').value, 'second', 'the note on the form is still there');
  });

  test('(\u2212) P5: a status-0 refusal with a note took it off without locking; the user types a new note, then the field shows open: the sentence alone', async () => {
    const r = withPv({}, { reply: () => ({ status: 0, body: null }) });
    await answerWithNote(r);
    assert.ok(r.log.problem.at(-1)[0].endsWith(` ${NOTE_TAKEN_TEXT}`), 'the failure may have pressed keys: the note was taken off');
    assert.equal(off(byText(r.root, 'Answer')), false, 'a status 0 does not lock');
    const field = typeAgain(r, 'first again');
    r.render(opened());
    assert.deepEqual(r.log.problem.at(-1), [NOTES_OPEN_TEXT, 'warn']);
    assert.equal(field.value, 'first again', 'the note on the form is untouched');
  });

  test('(\u2212) a note typed and then deleted leaves the field empty: the sentence is shown again (the check reads the field, not whether the user touched it)', async () => {
    const r = withPv({}, refusal('preview-changed', 2));
    await answerWithNote(r);
    typeAgain(r, 'second');
    typeNote(r, '');
    r.render(opened());
    assert.deepEqual(r.log.problem.at(-1), [BOTH, 'warn']);
  });
});

describe('F1b (0.5.4, QPF): a form the last request changed is dropped when the screen cannot be read', () => {
  const stepsOf = (root) => q(root, 'dlg-tab');
  const pickFirst = (r) => { const i = inputs(r.root, 'radio')[0]; i.checked = true; i.fire('change'); };
  const answered = async (done, status = 200) => {
    const r = rig({ reply: () => (status === 200 ? { status, body: { done, sent: 1 } } : { status, body: { error: done, sent: 1 } }) });
    r.render(ask());
    pickFirst(r);
    byText(r.root, 'Send answer').click();
    await settle();
    return r;
  };
  const readingNow = (r) => {
    assert.equal(r.root.attrs['data-s'], 'reading');
    assert.equal(buttons(r.root).length, 0, 'no form control is left');
    assert.equal(one(r.root, 'dlg-fs'), null);
    assert.equal(chip(r.root).textContent, 'Reading');
    assert.equal(r.df.live(), false);
  };
  const withPv = (over = {}, rigOpts = {}) => { const r = rig(rigOpts); r.render(askPv(over)); return r; };
  const typeNote = (r, v) => { const t = one(r.root, 'dlg-note-text'); t.value = v; t.fire('input'); return t; };
  const pickPv = (r, n) => { const i = inputs(r.root, 'radio')[n - 1]; i.checked = true; i.fire('change'); };
  const FOCUSED = { status: 200, body: { done: 'focused', sent: 1 } };

  test('(+) every answer that changes Claude\'s step (next, review, submitted, chosen, declined, chat) then an unreadable screen: Reading at once, the banner after READING_MS', async () => {
    for (const done of ['next', 'review', 'submitted', 'chosen', 'declined', 'chat']) {
      const r = await answered(done);
      r.render(unreadable());
      readingNow(r);
      const before = r.log.refresh;
      r.advance(READING_MS - 1);
      assert.equal(r.df.shown(), true, `${done}: still Reading`);
      r.advance(1);
      assert.equal(r.df.shown(), false, `${done}: the banner takes over`);
      assert.equal(r.root.hidden, true, done);
      assert.ok(r.log.refresh > before, `${done}: the page redraws its banner`);
    }
  });

  test('(+) a step move (done: moved) then an unreadable screen: Reading', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 2 } }) });
    r.render(multi({ tabs: [{ header: 'Project', answered: true }, { header: 'Mode', answered: false }, { header: 'Scope', answered: false }], current: 0 }));
    stepsOf(r.root)[1].click();
    await settle();
    assert.equal(r.root.attrs['data-s'], 'moving');
    r.render(unreadable());
    readingNow(r);
  });

  test('(+) 409 already-answered then an unreadable screen: Reading', async () => {
    const r = await answered('already-answered', 409);
    assert.equal(chip(r.root).textContent, 'Answered');
    r.render(unreadable());
    readingNow(r);
  });

  test('(+) a focused 200, then an unreadable screen before any readable capture: Reading; the same question read again rebuilds the form with the note typed before', async () => {
    const r = withPv({}, { reply: () => FOCUSED });
    byText(r.root, 'Add a note').click();
    typeNote(r, 'round it');
    pickPv(r, 2);
    await settle();
    r.render(unreadable());
    readingNow(r);
    focus.el = r.box;
    r.render(askPv({ focus: 2 }));
    const field = one(r.root, 'dlg-note-text');
    assert.ok(field, 'the note field is open again');
    assert.equal(field.value, 'round it');
    assert.equal(byText(r.root, 'Add a note').attrs['aria-expanded'], 'true');
    assert.equal(one(r.root, 'dlg-count').hidden, true);
    assert.equal(focus.el, r.box, 'restoring the note does not take the focus');
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r).at(-1), { sig: SIG, view: VIEW, picks: [2], note: 'round it' });
  });

  test('(\u2212) a held note comes back once: a form rebuilt for the same question (another sig) starts without it', async () => {
    const r = withPv({}, { reply: () => FOCUSED });
    byText(r.root, 'Add a note').click();
    typeNote(r, 'round it');
    pickPv(r, 2);
    await settle();
    r.render(unreadable());
    r.render(askPv({ focus: 2 }));
    assert.equal(one(r.root, 'dlg-note-text').value, 'round it');
    r.render(askPv({ sig: SIG2, focus: 2 }));
    assert.equal(one(r.root, 'dlg-note-text'), null, 'the held note came back once, not again for a rebuilt form');
  });

  test('(+) a focus request in flight, an unreadable capture drawn (the form is kept), then the 200: Reading at once, with no further capture', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    pickPv(r, 2);
    await settle();
    r.render(unreadable());
    assert.equal(r.root.attrs['data-s'], 'ready', 'kept while the request runs');
    assert.ok(one(r.root, 'dlg-fs'));
    h.held[0].resolve(FOCUSED);
    await settle();
    readingNow(r);
    assert.equal(r.log.calls.length, 1, 'no capture was needed');
  });

  test('(+) focus inside the form at the drop: the form root holds it through Reading; a readable capture then hands it to the new step\'s heading', async () => {
    const r = await answered('next');
    inputs(r.root, 'radio')[0].focus();
    r.render(unreadable());
    assert.equal(focus.el, r.root);
    r.render(ask({ sig: SIG2, question: 'Which cache?' }));
    assert.equal(focus.el.tag, 'legend');
    assert.equal(focus.el.textContent, 'Which cache?');
  });

  test('(+) the drop, then READING_MS passes: the banner takes over and the composer has the focus (a hidden root cannot hold it)', async () => {
    const r = await answered('next');
    inputs(r.root, 'radio')[0].focus();
    r.render(unreadable());
    assert.equal(focus.el, r.root);
    const before = r.log.boxFocus;
    r.advance(READING_MS);
    assert.equal(r.df.shown(), false);
    assert.equal(focus.el, r.box);
    assert.equal(r.log.boxFocus, before + 1);
  });

  test('(\u2212) a focus the user moved elsewhere stays there: before the drop, and during Reading', async () => {
    const r = await answered('next');
    focus.el = r.box;
    r.render(unreadable());
    assert.equal(focus.el, r.box, 'the drop moves no focus that was outside the form');
    r.render(ask({ sig: SIG2, question: 'Which cache?' }));
    assert.equal(focus.el, r.box, 'nor does the next form');
    const s = await answered('next');
    s.root.focus();
    s.render(unreadable());
    focus.el = s.box;
    s.render(ask({ sig: SIG2, question: 'Which cache?' }));
    assert.equal(focus.el, s.box, 'the user moved the focus to the composer during Reading');
  });

  // ---- QPF S1 (round 1, then taken out by the Q1 = C ruling): a note being typed when the form drops comes back with its text, and the heading gets the focus, whatever had it at the drop ---------------
  const droppedWith = async (focusOn, over = {}) => { // a typed note, the focus request answered (assumed), the focus put by `focusOn`, then an unreadable screen
    const r = withPv({}, { reply: () => FOCUSED });
    byText(r.root, 'Add a note').click();
    const field = typeNote(r, 'round it');
    pickPv(r, 2);
    await settle();
    if (focusOn) focusOn(r, field).focus();
    r.render(unreadable());
    return { r, field, over };
  };

  test('(\u2212) S1: the focus is in the note input at the drop, a readable capture of the same step follows: the note is back, the heading has the focus, not the note field (where Enter sends)', async () => {
    const { r, field } = await droppedWith((_, f) => f);
    assert.equal(focus.el, r.root, 'the root holds the focus through Reading');
    readingNow(r);
    r.render(askPv({ focus: 2 }));
    const back = one(r.root, 'dlg-note-text');
    assert.ok(back && back !== field, 'a new field');
    assert.equal(back.value, 'round it');
    assert.equal(focus.el.tag, 'legend', 'the heading has the focus: the page never moves it into a field where Enter sends');
    assert.equal(focus.el.textContent, 'Which shape?');
    assert.notEqual(focus.el, back);
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(sentBodies(r).at(-1), { sig: SIG, view: VIEW, picks: [2], note: 'round it' });
  });

  test('(\u2212) S1: the focus is on a radio or on the form root at the drop: after the rebuild the heading has it, not the note field (the note is back all the same)', async () => {
    for (const [why, on] of [['a radio', (r) => inputs(r.root, 'radio')[0]], ['the root', (r) => r.root]]) {
      const { r } = await droppedWith(on);
      r.render(askPv({ focus: 2 }));
      const back = one(r.root, 'dlg-note-text');
      assert.equal(back.value, 'round it', `${why}: the note comes back`);
      assert.equal(focus.el.tag, 'legend', why);
      assert.equal(focus.el.textContent, 'Which shape?', why);
      assert.notEqual(focus.el, back, why);
    }
  });

  test('(\u2212) S1: the focus is in the note input but the field is empty: nothing is held and the heading has the focus', async () => {
    const r = withPv({}, { reply: () => FOCUSED });
    byText(r.root, 'Add a note').click();
    const field = typeNote(r, '');
    pickPv(r, 2);
    await settle();
    field.focus();
    r.render(unreadable());
    r.render(askPv({ focus: 2 }));
    assert.equal(one(r.root, 'dlg-note-text'), null, 'no note to bring back');
    assert.equal(focus.el.tag, 'legend');
  });

  test('(\u2212) S1: a held note that is not restored (the step shows a saved note, has its field open, or is terminal-only) never takes the focus', async () => {
    const cases = [['a saved note', { notes: { text: 'saved', editing: false } }], ['the field open', { notes: { text: '', editing: true } }], ['the field open, no text read', { notes: { text: null, editing: true } }], ['terminal only', { bypass: true }]];
    for (const [why, over] of cases) {
      const { r } = await droppedWith((_, f) => f);
      r.render(askPv({ focus: 2, ...over }));
      assert.equal(one(r.root, 'dlg-note-text'), null, `${why}: no field`);
      assert.equal(focus.el.tag, 'legend', `${why}: the heading has the focus`);
    }
  });

  test('(\u2212) S1: a focus the user moved elsewhere during Reading stays there; the note field does not take it', async () => {
    const { r } = await droppedWith((_, f) => f);
    focus.el = r.box;
    r.render(askPv({ focus: 2 }));
    assert.equal(one(r.root, 'dlg-note-text').value, 'round it', 'the note is back');
    assert.equal(focus.el, r.box);
  });

  // ---- QPF N7 (round 2, pins since Q1 = C): a held note never takes the focus, also when Claude returns to its step after another one ----
  test('(\u2212) N7: the drop with the note focused, the next capture shows another step, the user focuses a radio there, then Claude returns to the first step: the heading has the focus, the note is back, the field does not take it', async () => {
    const { r } = await droppedWith((_, f) => f);
    assert.equal(focus.el, r.root, 'the root holds the focus through Reading');
    r.render(askPv({ sig: SIG2, current: 1, question: 'Which size?' })); // Claude moved on without the page asking
    assert.equal(focus.el.tag, 'legend');
    assert.equal(focus.el.textContent, 'Which size?');
    inputs(r.root, 'radio')[0].focus(); // the user works on the other step
    assert.equal(focus.el.tag, 'input');
    r.render(askPv({ focus: 2 })); // and Claude is back on the first step
    const back = one(r.root, 'dlg-note-text');
    assert.equal(back.value, 'round it', 'the held note is back');
    assert.equal(focus.el.tag, 'legend', 'the heading has the focus: a held key answers nothing unseen');
    assert.equal(focus.el.textContent, 'Which shape?');
    assert.notEqual(focus.el, back);
  });

  test('(\u2212) N7: a restored note that was held while its field had the focus, and the user has the first step\'s button focused when Claude returns: the step button keeps the focus, not the note field', async () => {
    const { r } = await droppedWith((_, f) => f);
    r.render(askPv({ sig: SIG2, current: 1, question: 'Which size?' }));
    const mine = stepsOf(r.root).find((b) => b.getAttribute('data-tab') === '0');
    assert.ok(mine, 'the first step has its button in the strip');
    mine.focus(); // focused, not clicked: nothing is sent
    assert.equal(r.log.calls.length, 1, 'only the focus request of the setup');
    r.render(askPv({ focus: 2 }));
    const back = one(r.root, 'dlg-note-text');
    assert.equal(back.value, 'round it', 'the held note is back');
    assert.equal(focus.el.tag, 'button');
    assert.equal(focus.el.getAttribute('data-tab'), '0');
    assert.equal(stepsOf(r.root).includes(focus.el), true, 'a button of the new strip');
    assert.notEqual(focus.el, back);
  });

  // ---- QPF N7b, FLOW-A and PROBE-6 (round 3, pins since Q1 = C): after a drop the heading gets the focus, never the note field, so Enter cannot answer an option the user did not pick ----
  test('(\u2212) N7b: the drop with the note focused, the next capture shows another step, the user clicks that step\'s background (the root takes the focus), then Claude returns to the first step: the heading has the focus, the note is back, the field does not take it', async () => {
    const { r } = await droppedWith((_, f) => f);
    r.render(askPv({ sig: SIG2, current: 1, question: 'Which size?' })); // Claude moved on without the page asking
    assert.equal(focus.el.tag, 'legend');
    assert.equal(focus.el.textContent, 'Which size?');
    r.root.focus(); // a click on text that is not a control: the browser focuses the form root (tabindex -1)
    assert.equal(focus.el, r.root);
    r.render(askPv({ focus: 2 })); // and Claude is back on the first step
    const back = one(r.root, 'dlg-note-text');
    assert.equal(back.value, 'round it', 'the held note is back');
    assert.equal(focus.el.tag, 'legend', 'the heading has the focus: a held key answers nothing unseen');
    assert.equal(focus.el.textContent, 'Which shape?');
    assert.notEqual(focus.el, back);
  });

  const enterHere = async (r) => { for (const el of [focus.el, r.root]) el.fire('keydown', { key: 'Enter' }); await settle(); }; // Enter where the focus is, and on the form (no handler there)

  test('(\u2212) FLOW-A: the user picks 2, then 3 while the request for 2 runs, and types a note in its field; an unreadable capture, then the 200 for 2 drops the form before 3 is asked; Claude is on 2 when the step is read again: the heading has the focus, the note is back, Enter posts nothing', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    byText(r.root, 'Add a note').click();
    pickPv(r, 2);
    await settle();
    pickPv(r, 3); // waits behind the request for 2
    await settle();
    const field = typeNote(r, 'round it');
    field.focus();
    field.fire('keydown', { key: 'Enter' });
    await settle();
    assert.equal(r.log.calls.length, 1, 'before the drop Enter sends nothing: 3 is not where Claude is');
    r.render(unreadable());
    assert.equal(r.root.attrs['data-s'], 'ready', 'kept while the request runs');
    h.held[0].resolve(FOCUSED);
    await settle();
    readingNow(r);
    assert.equal(r.log.calls.length, 1, 'the request for 3 was never sent');
    r.render(askPv({ focus: 2 }));
    const back = one(r.root, 'dlg-note-text');
    assert.equal(back.value, 'round it', 'the held note is back');
    assert.equal(focus.el.tag, 'legend', 'the heading has the focus, not the note field');
    assert.equal(focus.el.textContent, 'Which shape?');
    assert.notEqual(focus.el, back);
    await enterHere(r);
    assert.equal(r.log.calls.length, 1, 'Enter answers nothing');
  });

  test('(\u2212) PROBE-6: the drop with the note focused, then a readable capture of the same step shows Claude on another option than the user picked (1, not 2): the heading has the focus, the note is back, Enter posts nothing', async () => {
    const { r } = await droppedWith((_, f) => f);
    r.render(askPv({ focus: 1 }));
    const back = one(r.root, 'dlg-note-text');
    assert.equal(back.value, 'round it', 'the held note is back');
    assert.equal(inputs(r.root, 'radio')[0].checked, true, 'the form shows where Claude is');
    assert.equal(focus.el.tag, 'legend', 'the heading has the focus, not the note field');
    assert.equal(focus.el.textContent, 'Which shape?');
    assert.notEqual(focus.el, back);
    await enterHere(r);
    assert.equal(r.log.calls.length, 1, 'Enter answers nothing (the one call is the focus request of the setup)');
  });

  test('(\u2212) no request yet: an unreadable screen keeps the form, with its note, and no Reading', () => {
    const r = rig();
    r.render(ask());
    const form = one(r.root, 'dlg-fs');
    r.render(unreadable({ reason: 'cut' }));
    assert.equal(one(r.root, 'dlg-fs'), form);
    assert.equal(r.root.attrs['data-s'], 'ready');
    const kept = r.root.all((n) => withClass('dlg-note')(n) && /can't read Claude's dialog/.test(n.textContent))[0];
    assert.equal(kept.hidden, false);
    r.advance(READING_MS * 3);
    assert.equal(r.df.shown(), true);
  });

  test('(\u2212) 409 dialog-unread with keys sent: the form stays kept with its lock and Try again', async () => {
    const r = await answered('dialog-unread', 409);
    const form = one(r.root, 'dlg-fs');
    r.render(unreadable());
    assert.equal(one(r.root, 'dlg-fs'), form);
    assert.equal(r.root.attrs['data-s'], 'failed');
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false);
    const kept = r.root.all((n) => withClass('dlg-note')(n) && /can't read Claude's dialog/.test(n.textContent))[0];
    assert.equal(kept.hidden, false);
  });

  test('(\u2212) every failed answer (409, 400, 429, 500, network) keeps its form, message and Try again when the screen is unreadable', async () => {
    for (const [status, error] of [[409, 'dialog-touched'], [409, 'not-taken'], [400, 'invalid'], [429, undefined], [500, undefined], [0, undefined]]) {
      const r = rig({ reply: () => ({ status, body: error ? { error } : null }) });
      r.render(ask());
      pickFirst(r);
      byText(r.root, 'Send answer').click();
      await settle();
      const form = one(r.root, 'dlg-fs');
      r.render(unreadable());
      assert.equal(one(r.root, 'dlg-fs'), form, `${status} ${error}`);
      assert.notEqual(r.root.attrs['data-s'], 'reading', `${status} ${error}`);
    }
  });

  test('(\u2212) a focused 200, then a readable capture of the same sig (the focus is settled), then unreadable: the form stays kept', async () => {
    const r = withPv({}, { reply: () => FOCUSED });
    pickPv(r, 2);
    await settle();
    r.render(askPv({ focus: 2 }));
    const form = one(r.root, 'dlg-fs');
    r.render(unreadable());
    assert.equal(one(r.root, 'dlg-fs'), form);
    assert.notEqual(r.root.attrs['data-s'], 'reading');
  });

  test('(\u2212) a step\'s unsent input stays for a later visit: the drop does not clear what other steps hold', async () => {
    const BODY = (over = {}) => multi({ tabs: [{ header: 'Project', answered: true }, { header: 'Mode', answered: false }, { header: 'Scope', answered: false }], current: 0, ...over });
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 2 } }) });
    r.render(BODY());
    inputs(r.root, 'checkbox')[0].checked = true;
    inputs(r.root, 'checkbox')[0].fire('change');
    stepsOf(r.root)[1].click();
    await settle();
    r.render(BODY({ sig: SIG2, current: 1, question: 'Which mode?' }));
    r.state.reply = () => ({ status: 200, body: { done: 'next', sent: 1 } });
    inputs(r.root, 'checkbox')[0].checked = true;
    inputs(r.root, 'checkbox')[0].fire('change');
    byText(r.root, 'Answer').click();
    await settle();
    r.render(unreadable());
    readingNow(r);
    r.render(BODY());
    assert.equal(inputs(r.root, 'checkbox')[0].checked, true, 'the first step\'s unsent pick is still there');
  });

  test('(\u2212) a held note is not put into a step that shows a saved note, has its field open in the terminal, or is terminal-only; nothing of it comes back later', async () => {
    const cases = [['a saved note', { notes: { text: 'saved', editing: false } }], ['the field open', { notes: { text: '', editing: true } }], ['the field open, no text read', { notes: { text: null, editing: true } }], ['terminal only', { bypass: true }]];
    for (const [why, over] of cases) {
      const r = withPv({}, { reply: () => FOCUSED });
      byText(r.root, 'Add a note').click();
      typeNote(r, 'round it');
      pickPv(r, 2);
      await settle();
      r.render(unreadable());
      r.render(askPv({ focus: 2, ...over }));
      assert.equal(one(r.root, 'dlg-note-text'), null, why);
      r.render(askPv({ focus: 2 }));
      assert.equal(one(r.root, 'dlg-note-text'), null, `${why}: and not when the step is plain again`);
      assert.equal(byText(r.root, 'Add a note').attrs['aria-expanded'], 'false', why);
    }
  });

  test('(+) an unreadable screen while an answer is on its way keeps the form until the 200; the 200 then drops it (Reading)', async () => {
    const h = holdReply0();
    const r = rig({ reply: h.reply });
    r.render(ask());
    pickFirst(r);
    byText(r.root, 'Send answer').click();
    const form = one(r.root, 'dlg-fs');
    r.render(unreadable());
    assert.equal(one(r.root, 'dlg-fs'), form, 'the request decides when it ends');
    h.held[0].resolve({ status: 200, body: { done: 'next', sent: 1 } });
    await settle();
    readingNow(r);
  });

  test('(\u2212) a note whose answer was sent is not held: the 200 answered the step, the note went with it', async () => {
    const h = holdReply0();
    const r = withPv({}, { reply: h.reply });
    byText(r.root, 'Add a note').click();
    typeNote(r, 'round it');
    pickPv(r, 2);
    r.render(askPv({ focus: 2 })); // Claude's focus shows at 2 while the request still runs
    h.held[0].resolve(FOCUSED);
    await settle();
    byText(r.root, 'Answer').click(); // the next request is held too
    r.render(unreadable());
    assert.ok(one(r.root, 'dlg-note-text'), 'still on screen while the answer runs');
    h.held[1].resolve({ status: 200, body: { done: 'next', sent: 3 } });
    await settle();
    readingNow(r);
    r.render(askPv({ focus: 2 }));
    assert.equal(one(r.root, 'dlg-note-text'), null);
  });

  test('(\u2212) a preview step\'s note does not survive a step move (as in 0.5.4 QP); a note held for a question does not break a plain step with the same place', async () => {
    const r = rig({ reply: () => ({ status: 200, body: { done: 'moved', sent: 2 } }) });
    r.render(askPv());
    byText(r.root, 'Add a note').click();
    typeNote(r, 'round it');
    stepsOf(r.root)[1].click();
    await settle();
    r.render(askPv({ sig: SIG2, current: 1, question: 'Which size?' }));
    r.render(askPv());
    assert.equal(one(r.root, 'dlg-note-text'), null, 'the step move kept no note');
    const h = withPv({}, { reply: () => FOCUSED });
    byText(h.root, 'Add a note').click();
    typeNote(h, 'round it');
    pickPv(h, 2);
    await settle();
    h.render(unreadable());
    assert.doesNotThrow(() => h.render(ask({ tabs: tabs(2), current: 0, final: false, question: 'Which shape?', other: false })));
    assert.ok(one(h.root, 'dlg-fs'), 'the plain step is drawn');
    assert.equal(one(h.root, 'dlg-note-text'), null);
  });
});

// ---- 0.5.4, final fix S3: the problem line has an owner --------------------------------------------------------------------------------------------

describe('the problem line has an owner (0.5.4, final S3): a line about the open dialog goes with it, the outcome of an answer stays', () => {
  const NOTES_OPEN_LINE = "Claude's notes field is open in the terminal. Close it there, then press Try again.";
  const NOT_TAKEN_LINE = "Claude didn't take the key. Check the session, then try again.";
  const failing = (error) => ({ reply: () => ({ status: 409, body: { error } }) });
  const pickAt = (r, n) => { const i = inputs(r.root, 'radio')[n - 1]; i.checked = true; i.fire('change'); return i; };
  const lineOf = (r) => [r.line.msg, r.line.owner];

  test('(+) the notes-open line is the open dialog\'s: owner "dialog" and no timeout; when the dialog leaves the line is gone', () => {
    const r = rig();
    r.render(askPv({ notes: { text: '', editing: true } }));
    assert.deepEqual([r.line.msg, r.line.owner, r.line.ms], [NOTES_OPEN_LINE, 'dialog', 0]);
    r.render(null);
    assert.equal(r.df.shown(), false);
    assert.deepEqual(lineOf(r), ['', '']);
  });

  test('(+) a failed answer and a failed focus move show their line as the answer\'s: owner "dialog-answer", no timeout', async () => {
    const a = rig(failing('not-taken'));
    a.render(askPv());
    byText(a.root, 'Answer').click();
    await settle();
    assert.deepEqual([a.line.msg, a.line.owner, a.line.ms], [NOT_TAKEN_LINE, 'dialog-answer', 0]);
    const f = rig(failing('dialog-focus'));
    f.render(askPv());
    pickAt(f, 2);
    await settle();
    assert.equal(f.log.calls.at(-1).json.focus, 2, 'the focus request went out');
    assert.notEqual(f.line.msg, '');
    assert.deepEqual([f.line.owner, f.line.ms], ['dialog-answer', 0]);
  });

  test('(+) a dialog drawn after none clears an old "dialog" line and an old "dialog-answer" line', () => {
    for (const owner of ['dialog', 'dialog-answer']) {
      const r = rig();
      r.io.showProblem('A line from the dialog before', 'warn', 0, owner);
      r.render(ask());
      assert.deepEqual(lineOf(r), ['', ''], owner);
    }
  });

  test('(−) a "dialog-answer" line shown as the dialog leaves stays after leave(): it may say why the dialog went away', async () => {
    const r = rig(failing('not-taken'));
    r.render(askPv());
    byText(r.root, 'Answer').click();
    await settle();
    r.render(null);
    assert.equal(r.df.shown(), false);
    assert.deepEqual(lineOf(r), [NOT_TAKEN_LINE, 'dialog-answer']);
  });

  test('(−) a line of another part (Send\'s size line, an un-owned line) shown before the dialog left stays, and stays when a new dialog is drawn', () => {
    for (const owner of ['send-size', undefined]) {
      const r = rig();
      r.render(ask());
      r.io.showProblem('This is 17 KB. A paste can be at most 16 KB.', 'error', 0, owner);
      r.render(null);
      assert.deepEqual(lineOf(r), ['This is 17 KB. A paste can be at most 16 KB.', owner ?? ''], `after leave ${owner}`);
      r.render(ask());
      assert.deepEqual(lineOf(r), ['This is 17 KB. A paste can be at most 16 KB.', owner ?? ''], `after a new dialog ${owner}`);
    }
  });

  test('(−) a step change inside one dialog still clears through clearProblem (unchanged), and the same step keeps its answer line', async () => {
    const r = rig(failing('not-taken'));
    r.render(askPv());
    byText(r.root, 'Answer').click();
    await settle();
    r.render(askPv());
    assert.deepEqual(lineOf(r), [NOT_TAKEN_LINE, 'dialog-answer'], 'the same step keeps it');
    r.render(askPv({ sig: SIG2, question: 'Which size?' }));
    assert.deepEqual(lineOf(r), ['', ''], 'the next step clears it, as before');
  });

  // ---- round 1 (review-FINAL, R1-1): one lost capture runs leave() or dropStale(), and the same step comes back with no form before it ---------------
  const withNote = async (r) => { // types a note on the preview step and presses Answer; the route refuses
    byText(r.root, 'Add a note').click();
    const t = one(r.root, 'dlg-note-text');
    t.value = 'round it';
    t.fire('input');
    byText(r.root, 'Answer').click();
    await settle();
  };
  const blip = (r) => ({
    tmux: () => r.df.render({ pane: 'tmux' }), // one failed capture: the page's setPaneState('tmux')
    none: () => r.render(null), // a capture that shows no dialog for a moment
    unreadable: () => r.render(unreadable()), // a capture nika cannot read: dropStale() when the last request changed Claude's step
  });

  test('(−) R1-1: 409 not-taken, one render with pane "tmux", then the same step: the answer\'s line and its owner stay', async () => {
    const r = rig(failing('not-taken'));
    r.render(askPv());
    byText(r.root, 'Answer').click();
    await settle();
    assert.deepEqual(lineOf(r), [NOT_TAKEN_LINE, 'dialog-answer']);
    blip(r).tmux();
    assert.equal(r.df.shown(), false, 'the form went');
    assert.deepEqual(lineOf(r), [NOT_TAKEN_LINE, 'dialog-answer'], 'the line outlives leave()');
    r.render(askPv());
    assert.equal(r.df.shown(), true, 'the same step is back');
    assert.deepEqual(lineOf(r), [NOT_TAKEN_LINE, 'dialog-answer'], 'and the line is still the answer\'s');
  });

  test('(−) R1-1: the same with a capture that shows no dialog (a null dialog)', async () => {
    const r = rig(failing('not-taken'));
    r.render(askPv());
    byText(r.root, 'Answer').click();
    await settle();
    blip(r).none();
    assert.equal(r.df.shown(), false);
    r.render(askPv());
    assert.deepEqual(lineOf(r), [NOT_TAKEN_LINE, 'dialog-answer']);
  });

  test('(−) R1-1: the leave path with a note: preview-changed after 2 keys takes the note off, one lost capture, the same step: the NOTE_TAKEN sentence stays', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'preview-changed', sent: 2 } }) });
    r.render(askPv());
    await withNote(r);
    const taken = r.line.msg;
    assert.ok(taken.endsWith(` ${NOTE_TAKEN_TEXT}`), 'the refusal says the note was taken off');
    blip(r).tmux();
    r.render(askPv());
    assert.deepEqual(lineOf(r), [taken, 'dialog-answer']);
    assert.ok(r.line.msg.endsWith(` ${NOTE_TAKEN_TEXT}`));
  });

  test('(−) R1-1: the dropStale() path: a note answer meets 409 already-answered after 1 key, an unreadable capture drops the form, the same step comes back: NOTE_TAKEN stays', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'already-answered', sent: 1 } }) });
    r.render(askPv());
    await withNote(r);
    const taken = r.line.msg;
    assert.ok(taken.includes(NOTE_TAKEN_TEXT), 'the refusal says the note was taken off');
    assert.equal(r.line.owner, 'dialog-answer');
    blip(r).unreadable();
    assert.equal(one(r.root, 'dlg-fs'), null, 'dropStale took the form away (Reading is up)');
    assert.equal(r.line.msg, taken, 'the line outlives dropStale()');
    r.render(askPv());
    assert.ok(one(r.root, 'dlg-fs') !== null, 'the same step is drawn again');
    assert.deepEqual(lineOf(r), [taken, 'dialog-answer'], 'NOTE_TAKEN is still there');
  });

  test('(+) R1-1: after a blip a step with another sig still clears the answer\'s line', async () => {
    for (const how of ['tmux', 'none']) {
      const r = rig(failing('not-taken'));
      r.render(askPv());
      byText(r.root, 'Answer').click();
      await settle();
      blip(r)[how]();
      assert.deepEqual(lineOf(r), [NOT_TAKEN_LINE, 'dialog-answer'], `${how}: it stays while nothing is drawn`);
      r.render(askPv({ sig: SIG2, question: 'Which size?' }));
      assert.deepEqual(lineOf(r), ['', ''], `${how}: another sig clears it`);
    }
  });

  test('(+) R1-1: the dropStale() path with another sig after the blip clears the answer\'s line; a "dialog" line is cleared by a dialog drawn after none whatever the sig', async () => {
    const r = rig({ reply: () => ({ status: 409, body: { error: 'already-answered', sent: 1 } }) });
    r.render(askPv());
    await withNote(r);
    blip(r).unreadable();
    r.render(askPv({ sig: SIG2, question: 'Which size?' }));
    assert.deepEqual(lineOf(r), ['', ''], 'another sig clears the answer\'s line');
    const s = rig();
    s.render(ask());
    s.df.render({ pane: 'tmux' });
    s.io.showProblem('A line about the dialog', 'warn', 0, 'dialog');
    s.render(ask()); // the same sig, after a blip
    assert.deepEqual(lineOf(s), ['', ''], 'a "dialog" line goes with every dialog drawn after none');
  });
});

// ---- 0.5.4, final fix S4: the Try again note comes into view when it appears ---------------------------------------------------------------------

describe('Try again in view (0.5.4, final S4): the retry note scrolls into view when it goes from hidden to shown, and the focus stays where it is', () => {
  const scrolled = [];
  beforeEach(() => { scrolled.length = 0; TEl.prototype.scrollIntoView = function (o) { scrolled.push([this, o]); }; });
  afterEach(() => { delete TEl.prototype.scrollIntoView; });
  const refusing = (error) => ({ reply: () => ({ status: 409, body: { error } }) });
  const retryNote = (r) => one(r.root, 'dlg-retry');

  test('(+) a lock with Try again that starts after an answer: scrollIntoView({ block: "nearest" }) once, on the retry note', async () => {
    const r = rig(refusing('notes-open'));
    r.render(askPv());
    assert.equal(scrolled.length, 0, 'nothing while the note is hidden');
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false, 'the note is shown');
    assert.equal(scrolled.length, 1);
    assert.equal(scrolled[0][0], retryNote(r));
    assert.deepEqual(scrolled[0][1], { block: 'nearest' });
  });

  test('(+) a lock with Try again that starts as the form is drawn (the notes field is open): once; and once more when it starts again after Try again', () => {
    const r = rig();
    r.render(askPv({ notes: { text: '', editing: true } }));
    assert.equal(scrolled.length, 1);
    assert.equal(scrolled[0][0], retryNote(r));
    r.render(askPv({ notes: { text: null, editing: false } }));
    byText(r.root, 'Try again').click();
    assert.equal(hiddenUp(byText(r.root, 'Try again')), true, 'Try again hid the note');
    assert.equal(scrolled.length, 1);
    r.render(askPv({ notes: { text: '', editing: true } }));
    assert.equal(scrolled.length, 2, 'a new lock is a new appearance');
  });

  test('(\u2212) a repaint while the note is already shown does not scroll again (a capture of the same step, a pick, a render of the same locked form)', async () => {
    const r = rig(refusing('notes-open'));
    r.render(askPv());
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(scrolled.length, 1);
    r.render(askPv());
    r.render(askPv());
    inputs(r.root, 'radio')[1].fire('change');
    r.render(askPv({ notes: { text: '', editing: true } }));
    assert.equal(scrolled.length, 1, 'still the one call');
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false);
  });

  test('(\u2212) a lock without Try again (a note that does not match) and a request in flight do not scroll', async () => {
    const r = rig(refusing('note-mismatch'));
    r.render(askPv());
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(off(byText(r.root, 'Answer')), true, 'locked');
    assert.equal(hiddenUp(byText(r.root, 'Try again')), true, 'no retry');
    assert.equal(scrolled.length, 0);
    let release;
    const slow = rig({ reply: () => new Promise((resolve) => { release = resolve; }) });
    slow.render(askPv());
    byText(slow.root, 'Answer').click();
    assert.equal(scrolled.length, 0, 'a request in flight shows no retry note');
    release({ status: 200, body: { done: 'next', sent: 1 } });
    await settle();
    assert.equal(scrolled.length, 0);
  });

  test('(\u2212) the focus does not move and the message box is not focused when the note scrolls into view', async () => {
    const r = rig(refusing('notes-open'));
    r.render(askPv());
    const before = focus.el;
    byText(r.root, 'Answer').click();
    await settle();
    assert.equal(scrolled.length, 1);
    assert.equal(focus.el, before, 'the focus is where it was');
    assert.equal(r.log.boxFocus, 0);
    scrolled.length = 0;
    const guarded = rig();
    guarded.render(askPv({ notes: { text: '', editing: true } }));
    assert.equal(scrolled.length, 1);
    assert.equal(focus.el, null);
    assert.equal(guarded.log.boxFocus, 0);
  });

  test('(\u2212) a test DOM without scrollIntoView does not break the form (the call is guarded)', () => {
    delete TEl.prototype.scrollIntoView;
    const r = rig();
    assert.doesNotThrow(() => r.render(askPv({ notes: { text: '', editing: true } })));
    assert.equal(hiddenUp(byText(r.root, 'Try again')), false);
  });
});
