// src/survey.js: Claude's feedback survey (F14). Pure parser, synthetic screens only. The rows follow the live capture of spike S-F14
// (Claude Code 2.1.325, docs/contracts/claude-tui.md section 10.11): the question's bullet at column 0, the options row indented 2, exactly one
// row between the options row and the input box's top rule. Symbols are escapes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { surveyOf, SURVEY_UNDO_MS } from '../src/survey.js';
import { surveyBox, boxInput, parseDraft } from '../src/draft.js';
import { boxRows } from './helpers.js';

const DEF = { b: false, fg: null, bg: null, u: false, i: false, d: false };
const sp = (t, s = {}) => ({ t, s: { ...DEF, ...s } });
const row = (t) => (t === '' ? [] : [sp(t)]);
const BULLET = '●';
const Q = `${BULLET} How is Claude doing this session? (optional)`;
const O = '  1: Bad    2: Fine   3: Good   0: Dismiss';
const ABOVE = ['Done. Anything else?', ''];
const SIG16 = /^[0-9a-f]{16}$/;
const READY_OPTIONS = [{ n: 1, label: 'Bad' }, { n: 2, label: 'Fine' }, { n: 3, label: 'Good' }, { n: 0, label: 'Dismiss' }];
const GHOST = 'Try "write a test for <filepath>"';
const PROMPT = ['Edit file notes.txt', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session', '   3. No', ' Esc to cancel'];

/**
 * A screen with the survey above the input box. `above` are the transcript rows, `free` the row(s) between the options row and the box's top
 * rule (one row in Claude's layout: a string, or an array to test other counts), `q` / `opt` replace the two rows (a string, or null to drop it).
 * `lines`, `ghost`, `insert`, `label`, `footer`, `cols` go to boxRows. The cursor is shifted to the box row.
 */
function screen({ cols = 120, above = ABOVE, q = Q, opt = O, free = '', lines = [''], ghost = GHOST, insert = false, label = null, footer, cursor, between = [], bottom = [] } = {}) {
  const prefix = [...above.map(row), ...[q, ...between, opt].filter((t) => t !== null).map(row), ...[].concat(free).map(row)];
  const box = boxRows({ cols, lines, ghost, insert, label, footer, cursor });
  const where = box.cursor === null ? null : { ...box.cursor, y: box.cursor.y + prefix.length };
  return { rows: [...prefix, ...box.rows, ...bottom.map(row)], cursor: where, cols };
}
const ready = (s, edit = {}) => surveyOf(s, edit);
const reasonOf = (s, edit = {}) => { const r = surveyOf(s, edit); return r === null ? null : r.reason ?? r.state; };
const sigFor = (above, q = Q, o = O) => createHash('sha256').update(JSON.stringify([q.trim(), o.trim(), above.map((t) => t.trim())])).digest('hex').slice(0, 16);

describe('surveyOf (+): the rating question', () => {
  test('(+) the two exact rows above an empty box: ready, kind rating, four options in Claude\'s order, a 16-hex sig', () => {
    const r = ready(screen());
    assert.deepEqual(Object.keys(r).sort(), ['kind', 'options', 'sig', 'state', 'top']);
    assert.deepEqual([r.state, r.kind], ['ready', 'rating']);
    assert.deepEqual(r.options, READY_OPTIONS);
    assert.match(r.sig, SIG16);
  });

  // 0.5.1 E: `top` is the screen row of the question, display only (the page crops the terminal view there). Never part of the sig.
  test('(+) top is the screen row of the question: after the transcript rows above it, whatever their number', () => {
    for (const above of [[''], ABOVE, ['a', 'b', 'c', 'd', 'e'], ['a', '', '', 'b', '', '']]) {
      const s = screen({ above });
      const r = ready(s);
      assert.equal(r.top, above.length, `${above.length} rows above`);
      assert.equal(s.rows[r.top].map((x) => x.t).join(''), Q, 'the row at top is the question row');
    }
    assert.equal(ready(screen({ cols: 60, free: '                    ◐ medium · /effort' })).top, ABOVE.length, 'width and the free row do not move it');
  });

  test('(−) top is not in the sig: the same survey two rows further down has the same sig and another top', () => {
    const a = ready(screen({ above: ['same line', ''] }));
    const b = ready(screen({ above: ['same line', '', ''] }));
    assert.equal(a.sig, b.sig);
    assert.notEqual(a.top, b.top);
  });

  test('(−) a terminal-only survey, and no survey at all, carry no top', () => {
    const consent = surveyOf(screen({ between: [`${BULLET} Can Anthropic look at your session transcript?`] }));
    assert.deepEqual(consent, { state: 'terminal', reason: 'consent' });
    assert.equal('top' in surveyOf(screen({ footer: '⏵⏵ bypass permissions on (shift+tab to cycle)' })), false);
    assert.equal('top' in surveyOf(screen({ lines: ['hello'], ghost: null })), false, 'text in the box');
    assert.equal('top' in surveyOf(screen(), { vim: true, insert: false }), false, 'vim normal');
    assert.equal(surveyOf(boxRows({ cols: 120 })), null);
  });

  test('(+) the sig is sha256 over [question, options, up to 3 non-blank rows above], trimmed, 16 hex', () => {
    const above = ['line one', 'line two', '', 'line three', 'line four', ''];
    assert.equal(ready(screen({ above })).sig, sigFor(['line two', 'line three', 'line four']));
    assert.equal(ready(screen({ above: [''] })).sig, sigFor([]), 'a survey at the top of the pane has nothing above');
  });

  test('(+) a placeholder, a prompt suggestion and no ghost text at all all read: an empty box with ghost text is empty', () => {
    for (const ghost of [GHOST, 'run the tests', null]) assert.equal(ready(screen({ ghost })).state, 'ready', String(ghost));
  });

  test('(+) the row between the options row and the box can hold anything: blank, the effort pill, a usage notice, a tmux notice', () => {
    for (const free of ['', '                                              ◐ medium · /effort', "You've used 80% of your weekly limit · resets Mon", "tmux focus-events off · add 'set -g focus-events on' to your tmux.conf"]) {
      assert.equal(ready(screen({ free })).state, 'ready', free);
    }
  });

  test('(+) vim INSERT, plain mode and an unknown mode read; the pane\'s memory and the footer only matter for vim NORMAL', () => {
    assert.equal(ready(screen({ insert: true }), { vim: true, insert: true }).state, 'ready');
    assert.equal(ready(screen(), { vim: false, insert: false }).state, 'ready');
    assert.equal(ready(screen()).state, 'ready', 'no edit argument at all');
    assert.equal(ready(screen({ insert: true }), { vim: false, insert: true }).state, 'ready', 'INSERT shown outranks a pane that was not yet known as vim');
  });

  test('(+) a named session (a labelled upper rule), a wide pane and a pane of 46 columns read', () => {
    assert.equal(ready(screen({ label: 'release-notes' })).state, 'ready');
    assert.equal(ready(screen({ cols: 200 })).state, 'ready');
    assert.equal(ready(screen({ cols: 46 })).state, 'ready');
  });

  test('(+) no-break spaces read as spaces, trailing spaces and the padding Claude adds are ignored', () => {
    const nb = (t) => t.replace(/ /g, '\xa0');
    assert.equal(ready(screen({ q: nb(Q), opt: nb(O) })).state, 'ready');
    assert.equal(ready(screen({ q: `${Q}      `, opt: `${O}                ` })).state, 'ready');
  });

  test('(+) the sig is the same after a change below the box (a mode line suffix, a status line, the box\'s ghost text), another after a change above', () => {
    const a = ready(screen()).sig;
    assert.equal(ready(screen({ footer: '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents' })).sig, a);
    assert.equal(ready(screen({ ghost: 'another suggestion' })).sig, a);
    assert.equal(ready(screen({ free: 'You\'ve used 90% of your weekly limit' })).sig, a, 'the free row is not part of the identity');
    assert.notEqual(ready(screen({ above: ['Done. Anything else?!', ''] })).sig, a);
    assert.notEqual(ready(screen({ above: ['a', 'b', 'c', ''] })).sig, ready(screen({ above: ['a', 'b', 'changed', ''] })).sig, 'the third row above counts');
    assert.equal(ready(screen({ above: ['older', 'x', 'y', 'z', ''] })).sig, ready(screen({ above: ['older changed', 'x', 'y', 'z', ''] })).sig, 'a fourth non-blank row above does not');
  });

  test('(+) the answer\'s hold constant covers Claude\'s "Esc to undo" row (about 3.4 s after the digit in the live capture)', () => {
    assert.ok(Number.isInteger(SURVEY_UNDO_MS) && SURVEY_UNDO_MS >= 3500 && SURVEY_UNDO_MS <= 10_000, String(SURVEY_UNDO_MS));
  });
});

describe('surveyOf (−): nothing to answer, or an answer that stays with the user', () => {
  test('(−) no survey on screen: null (a plain screen, an empty one, prose quoting the question, a question inside a longer sentence)', () => {
    assert.equal(surveyOf(screen({ q: 'Claude asked: How is Claude doing this session? (optional)', opt: 'it listed 1: Bad 2: Fine 3: Good 0: Dismiss (quoted)' })), null);
    assert.equal(surveyOf(boxRows({ lines: ['hello'] })), null);
    assert.equal(surveyOf({ rows: [], cursor: null, cols: 80 }), null);
  });

  test('(−) M1: the rows Claude draws after a rating ("Thanks for the feedback!" and "(Optional) Press [1] to tell us more") are no survey: null, never a panel, with a box or without', () => {
    const THANKS = 'Thanks for the feedback!';
    const ROW = '(Optional) Press [1] to tell us more · /feedback';
    assert.equal(surveyOf(screen({ q: THANKS, opt: ROW })), null, 'both rows, over an empty box');
    assert.equal(surveyOf(screen({ q: null, opt: ROW })), null, 'the follow-up row alone');
    assert.equal(surveyOf(screen({ q: THANKS, opt: ROW, lines: ['1'] })), null, 'a lone 1 in the box');
    assert.equal(surveyOf(screen({ q: THANKS, opt: ROW }), { vim: true, insert: true }), null, 'vim INSERT');
    assert.equal(surveyOf(screen({ q: THANKS, opt: ROW, free: 'tmux focus-events off' })), null, 'with a notice row below');
  });

  test('(−) a permission prompt or a dialog owns the slot: null, whatever the survey rows say', () => {
    const prompt = { rows: [...[Q, O].map(row), ...PROMPT.map(row)], cursor: { x: 0, y: 0, visible: true }, cols: 120 };
    assert.equal(surveyOf(prompt), null, 'a prompt under the survey rows');
    const quoted = { rows: [...PROMPT.map(row), ...[Q, O].map(row)], cursor: { x: 0, y: 0, visible: true }, cols: 120 };
    assert.notEqual(surveyOf(quoted)?.state, 'ready', 'prompt rows above the survey rows are no prompt (the footer is not the last row), and with no box nothing is offered');
    const ask = '  Enter to select · ↑/↓ to navigate · Esc to cancel';
    const dialog = { rows: [...[Q, O, '', 'Which project?', ' ❯ 1. acme-api', '   2. web-shop', ask].map(row)], cursor: { x: 0, y: 0, visible: true }, cols: 120 };
    assert.equal(surveyOf(dialog), null, 'a question dialog');
  });

  test('(−) the transcript question: terminal / consent, also next to a rating (the constants are not known: fail closed)', () => {
    const consent = 'Can Anthropic look at your session transcript to help us improve Claude Code?';
    for (const q of [`${BULLET} ${consent}`, `  ${BULLET} ${consent}`, consent]) {
      const s = screen({ q, opt: '  y: Yes    n: No     d: Don\'t ask again' });
      assert.deepEqual(surveyOf(s), { state: 'terminal', reason: 'consent' }, q);
    }
    assert.deepEqual(surveyOf(screen({ between: [`${BULLET} ${consent}`] })), { state: 'terminal', reason: 'consent' }, 'consent row plus a rating pair on one screen');
    assert.deepEqual(surveyOf(screen({ above: [`${BULLET} ${consent}`, ''] })), { state: 'terminal', reason: 'consent' });
  });

  test('(−) bypass: a bypass mode line, a bypass word in the row between, or in the rows above (inside the last 15 non-blank rows): terminal / bypass', () => {
    assert.deepEqual(surveyOf(screen({ footer: '⏵⏵ bypass permissions on (shift+tab to cycle)' })), { state: 'terminal', reason: 'bypass' });
    assert.deepEqual(surveyOf(screen({ free: 'bypass was mentioned here' })), { state: 'terminal', reason: 'bypass' });
    assert.deepEqual(surveyOf(screen({ above: ['we discussed the BYPASS flag', ''] })), { state: 'terminal', reason: 'bypass' });
    assert.deepEqual(surveyOf(screen({ above: ['by​pass', ''] })), { state: 'terminal', reason: 'bypass' }, 'invisible characters do not hide it');
    const far = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    assert.equal(surveyOf(screen({ above: ['a bypass long ago', ...far, ''] })).state, 'ready', 'older than the 15 non-blank rows');
  });

  test('(−) one row only, or the options row not directly below the question: terminal / unreadable', () => {
    assert.equal(reasonOf(screen({ opt: null })), 'unreadable');
    assert.equal(reasonOf(screen({ q: null })), 'unreadable');
    assert.equal(reasonOf(screen({ between: [''] })), 'unreadable', 'a blank row between them');
    assert.equal(reasonOf(screen({ between: ['some notice'] })), 'unreadable');
  });

  test('(−) two question rows, or two options rows: unreadable', () => {
    assert.equal(reasonOf(screen({ above: [Q, O, ''] })), 'unreadable', 'an older pair above the live one');
    assert.equal(reasonOf(screen({ free: [O] })), 'unreadable', 'a second options row under the first');
    assert.equal(reasonOf(screen({ above: [Q, ''] })), 'unreadable', 'a stray second question');
  });

  test('(−) the other survey questions and their options row: unreadable (nika never answers a layout it does not know)', () => {
    const long = 'How well is Claude following the instructions you gave earlier in this conversation? (optional)';
    assert.equal(reasonOf(screen({ q: `${BULLET} ${long}` })), 'unreadable');
    const memory = [`${BULLET} How was Claude's recollection? (optional)`, '  1: Bad    2: Fine   3: Good   4: Unsure 0: Dismiss'];
    assert.equal(reasonOf(screen({ q: memory[0], opt: memory[1] })), 'unreadable');
    assert.equal(reasonOf(screen({ opt: '  1: Bad    2: Fine   3: Good   4: Unsure 0: Dismiss' })), 'unreadable', 'the rating question with a different options row');
    assert.equal(reasonOf(screen({ opt: '  1: Bad    2: Fine   3: Good' })), 'unreadable', 'no Dismiss: not a row nika knows (and not a survey row at all)');
  });

  test('(−) the indents of the live capture are exact: a bullet at column 1 or 2, an options row at 0, 1 or 4, are not the survey', () => {
    for (const lead of [' ', '  ']) assert.equal(reasonOf(screen({ q: `${lead}${Q}` })), 'unreadable', `bullet at ${lead.length}`);
    for (const lead of ['', ' ', '    ']) assert.equal(reasonOf(screen({ opt: `${lead}${O.trim()}` })), 'unreadable', `options at ${lead.length}`);
  });

  test('(−) the question without its bullet, or with another bullet, is not the rating row', () => {
    assert.equal(reasonOf(screen({ q: 'How is Claude doing this session? (optional)' })), 'unreadable');
    assert.equal(reasonOf(screen({ q: '⏺ How is Claude doing this session? (optional)' })), 'unreadable', 'the assistant bullet of macOS: the options row alone shows a survey, and there is no question to pair it with');
  });

  test('(−) a narrow pane that wraps the question (45 to 42 columns) or splits the options row (40 columns): unreadable', () => {
    assert.equal(reasonOf(screen({ cols: 44, q: `${BULLET} How is Claude doing this session?`, between: ['  (optional)'] })), 'unreadable');
    assert.equal(reasonOf(screen({ cols: 40, q: `${BULLET} How is Claude doing this session?`, between: ['  (optional)'], opt: '  1: Bad  2: Fine  3: Good  0:', free: ['  Dismiss'] })), 'unreadable');
  });

  test('(−) the survey rows must sit directly above the box: not zero rows, not two rows, not rows below or inside the box', () => {
    assert.equal(reasonOf(screen({ free: [] })), 'unreadable', 'no row between the options row and the top rule');
    assert.equal(reasonOf(screen({ free: ['', ''] })), 'unreadable', 'two rows between');
    assert.equal(reasonOf(screen({ free: ['', 'notice', ''] })), 'unreadable');
    const below = screen({ q: null, opt: null, above: ['x', ''], bottom: [Q, O] });
    assert.equal(reasonOf(below), 'unreadable', 'the pair under the box');
    const inside = screen({ q: null, opt: null, above: ['x', ''], lines: [Q, `  ${O.trim()}`], ghost: null });
    assert.equal(reasonOf(inside), 'unreadable', 'the pair typed inside the box');
  });

  test('(−) no input box on screen, or a box with fewer than two rules: unreadable', () => {
    const s = screen();
    assert.equal(reasonOf({ rows: s.rows.slice(0, 3), cursor: s.cursor, cols: 120 }), 'unreadable');
    assert.equal(reasonOf({ rows: [...ABOVE.map(row), Q, O].map((r) => (Array.isArray(r) ? r : row(r))), cursor: null, cols: 120 }), 'unreadable');
  });

  test('(−) text in the box (a draft, the digit that is already there): terminal / input', () => {
    for (const lines of [['hello'], ['3'], ['a', 'b'], ['/help']]) assert.deepEqual(surveyOf(screen({ lines, ghost: null })), { state: 'terminal', reason: 'input' }, lines.join('|'));
  });

  test('(−) the cursor outside the box, on a rule row, below it, or missing: terminal / input', () => {
    const s = screen();
    for (const y of [0, s.cursor.y - 1, s.cursor.y + 1, s.cursor.y + 2]) assert.deepEqual(surveyOf({ ...s, cursor: { x: 2, y, visible: true } }), { state: 'terminal', reason: 'input' }, `y ${y}`);
    for (const cursor of [null, {}, { x: 2 }, { x: 2, y: 'a' }, { x: 2.5, y: s.cursor.y }]) assert.deepEqual(surveyOf({ ...s, cursor }), { state: 'terminal', reason: 'input' }, JSON.stringify(cursor));
  });

  test('(−) a bash `!` box, a box showing an old history entry, a footer nika does not know: terminal / input (a digit would land in the wrong place)', () => {
    const bash = (() => { const b = boxRows({ lines: [''], mode: 'bash', ghost: null }); const p = [ABOVE[0], '', Q, O, ''].map(row); return { rows: [...p, ...b.rows], cursor: { ...b.cursor, y: b.cursor.y + p.length }, cols: 120 }; })();
    assert.deepEqual(surveyOf(bash), { state: 'terminal', reason: 'input' });
    assert.deepEqual(surveyOf(screen({ label: 'History 2/9' })), { state: 'terminal', reason: 'input' });
    assert.deepEqual(surveyOf(screen({ footer: 'a footer nobody recognises' })), { state: 'terminal', reason: 'input' });
  });

  test('(−) vim NORMAL (the pane was seen in INSERT, the footer shows none): terminal / normal, whatever else is right', () => {
    assert.deepEqual(surveyOf(screen(), { vim: true, insert: false }), { state: 'terminal', reason: 'normal' });
    assert.equal(surveyOf(screen(), { vim: true, insert: true }).state, 'ready');
  });

  test('(−) the order of the verdicts: consent, then bypass, then unreadable, then input, then normal', () => {
    assert.equal(reasonOf(screen({ lines: ['x'], ghost: null, free: 'bypass' }), { vim: true }), 'bypass');
    assert.equal(reasonOf(screen({ lines: ['x'], ghost: null, opt: null }), { vim: true }), 'unreadable');
    assert.equal(reasonOf(screen({ lines: ['x'], ghost: null }), { vim: true }), 'input');
  });

  test('(−) malformed input never throws: no capture, no rows, rows that are not span lists, spans with a non-string text, a cursor that is not a cell', () => {
    for (const bad of [undefined, null, 0, 'x', [], {}, { rows: null }, { rows: 'x' }, { rows: [null, 3, {}] }, { rows: [[{ t: 5 }], [null], [{ s: {} }]], cursor: {} }]) {
      assert.doesNotThrow(() => surveyOf(bad), JSON.stringify(bad));
      assert.equal(surveyOf(bad), null);
    }
    assert.doesNotThrow(() => surveyOf({ rows: [[{ t: Q }]], cursor: 'x', cols: 'wide' }));
    assert.doesNotThrow(() => surveyOf(screen(), null));
    assert.doesNotThrow(() => surveyOf(screen(), { vim: 'yes', insert: 1 }));
    const odd = screen();
    odd.rows[0] = [{ t: 5 }, null, { t: Q }];
    assert.doesNotThrow(() => surveyOf(odd));
  });

  test('(−) the answer is pure: the same capture gives the same verdict, and the capture is left as it was', () => {
    const s = screen();
    const before = JSON.stringify(s);
    assert.deepEqual(surveyOf(s), surveyOf(s));
    assert.equal(JSON.stringify(s), before);
  });
});

describe('draft.js: surveyBox and the box preparation the survey shares', () => {
  test('(+) surveyBox reads the box with the survey rows on screen, which the normal reader refuses (the digits would answer them)', () => {
    const s = screen();
    const input = boxInput(s);
    assert.equal(parseDraft(input.rows, input.cursor, input.cols), null, 'the draft reader stays shut while the survey shows');
    const draft = surveyBox(input.rows, input.cursor, input.cols);
    assert.deepEqual([draft.state, draft.mode, draft.ghost], ['empty', 'prompt', true]);
    assert.equal(draft.box.bottom - draft.box.top, 2);
  });

  test('(−) surveyBox keeps every other gate: an unknown footer, a permission prompt, a cursor outside the rules, no rules, a non-array', () => {
    const s = screen({ footer: 'a footer nobody recognises' });
    assert.equal(surveyBox(s.rows, s.cursor, s.cols), null);
    const t = screen();
    assert.equal(surveyBox(t.rows, { x: 2, y: 0, visible: true }, t.cols), null);
    assert.equal(surveyBox(t.rows.slice(0, 3), t.cursor, t.cols), null);
    assert.equal(surveyBox(null, t.cursor, t.cols), null);
    assert.equal(surveyBox([...PROMPT.map(row)], { x: 0, y: 0 }, 80), null);
  });

  test('(+) boxInput: a missing or half cursor has no box; the last row\'s no-break spaces become spaces (the mode line reads), nothing else is rewritten', () => {
    const t = screen();
    assert.equal(boxInput({ ...t, cursor: null }), null);
    assert.equal(boxInput({ ...t, cursor: { x: 1 } }), null);
    const out = boxInput(t);
    assert.equal(out.rows.length, t.rows.length);
    assert.equal(out.cursor, t.cursor);
    assert.deepEqual(out.rows.slice(0, -1), t.rows.slice(0, -1));
  });
});
