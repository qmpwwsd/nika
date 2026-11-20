// Tests for src/dialog.js (nika 0.5, W1 T1): Claude's question dialog, review step and plan approval read from the rows of a capture.
// Fixtures are SYNTHETIC rows built from the shapes recorded in spike S3, W1-T0 and W1-T0b/T0c (acme-api, web-shop, demo-api); no real
// capture or path is copied. A fixture is a set of named parts (rowsFrom joins them in order) so that a test can replace or drop one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as dialog from '../src/dialog.js';
import {
  REASONS, TABS_MAX, NUMBER_MAX, HEADER_MAX, QUESTION_MAX, LABEL_MAX, DESC_MAX, ANSWER_MAX, TEXT_MAX, STEPS_MAX, MULTI_OTHER, PLAN_PICK,
  PLAIN_TEXT, PLAN_TEXT_LABEL, dialogOnScreen, readDialogScreen, identityOf, sigOf, otherAllowed, dialogCapture, stripOf,
} from '../src/dialog.js';
import { promptFromRows, modeFromRows, lastNonBlank, bypassWindow, isDialogEnd } from '../src/mode.js';
import { readDraft, promptSig } from '../src/session-control.js';
import { parseDraft } from '../src/draft.js';
import { parseCapture } from '../src/mirror.js';
import { boxRows, subagentRows, span, taskRows, taskScreen, taskMisfits, ansiOf } from './helpers.js';

const COLS = 120;
const DIM = { fg: 246 };
const ACC = { fg: 153 };
const MARK = { bg: { fg: 16, bg: 153 }, rev: { r: true }, both: { fg: 16, bg: 153, r: true }, none: {} };
const ptr = (on) => (on ? '❯' : ' ');
const lineOf = (s) => (Array.isArray(s) ? s : s === '' ? [] : [span(s)]);

/** The tab strip: tab tokens ` <box> <header> `, an optional Submit token (plain or in brackets), arrows. `current`: an index, 'submit' or a list of them. */
function strip({ tabs, current = 0, answered = [], submit = tabs.length > 1, arrows = submit, mark = 'bg', bracket = false }) {
  const mk = MARK[mark];
  const cur = Array.isArray(current) ? current : [current];
  const out = [];
  if (arrows) out.push(span('←'), span(' '));
  tabs.forEach((h, n) => {
    if (n > 0) out.push(span(' '));
    out.push(span(` ${answered.includes(n) ? '☒' : '☐'} ${h} `, cur.includes(n) ? mk : {}));
  });
  const sub = span(' ✔ Submit ', cur.includes('submit') ? mk : {});
  if (submit) out.push(...(bracket ? [span('['), sub, span(']')] : [span(' '), sub]));
  if (arrows) out.push(span(' '), span('→'));
  return out;
}

const OPTS = [
  { label: 'acme-api', desc: 'Open the acme-api project.' },
  { label: 'web-shop', desc: 'Open the web-shop project.' },
  { label: 'demo-api', desc: 'Open the demo-api project.' },
];
const CHECKS = [
  { label: 'lint', desc: 'Run the linter.' },
  { label: 'test', desc: 'Run the tests.' },
  { label: 'build', desc: 'Build the project.' },
];
const footerText = ({ nav = 'Tab/Arrow keys', insert = false, ctrl = false, esc = !insert } = {}) => `${insert ? '-- INSERT -- · ' : ''}Enter to select · ${nav} to navigate${ctrl ? ' · ctrl+g to edit in Vim' : ''}${esc ? ' · Esc to cancel' : ''}`;

/** A question step (the shapes of S3 A-D, T0 section 4, T0b 3.1-3.4, T0c 8.3) as named parts. */
function askParts(o = {}) {
  const {
    cols = COLS, tabs = ['Project', 'Tools'], current = 0, answered = [], mark = 'bg', bracket = false, multi = false,
    question = 'Which project should I open?', options = OPTS, checks = [], ticks = [], text = null, button = 'Next', focus = 1,
    insert = false, above = ['⏺ I have a question first.', ''],
  } = o;
  const submit = o.submit ?? (tabs.length > 1 || multi);
  const k = options.length;
  const nav = o.nav ?? (tabs.length > 1 ? 'Tab/Arrow keys' : '↑/↓');
  const ctrl = o.ctrl ?? (focus === k + 1 || focus === 'button');
  const dIndent = ' '.repeat(multi ? 9 : 5);
  const opts = [];
  options.forEach((opt, j) => {
    const n = j + 1;
    const box = multi ? (checks.includes(n) ? '[✔] ' : '[ ] ') : '';
    const tick = !multi && ticks.includes(n) ? ' ✔' : '';
    opts.push([span(ptr(focus === n), ACC), span(' '), span(`${n}.`, DIM), span(` ${box}${opt.label}${tick}`, focus === n ? ACC : {})]);
    for (const d of [].concat(opt.desc ?? [])) opts.push([span(`${dIndent}${d}`, DIM)]);
  });
  const rowsOfText = text === null ? [null] : [].concat(text);
  const tBox = multi ? (text === null ? '[ ] ' : '[✔] ') : '';
  rowsOfText.forEach((t, j) => {
    if (j === 0) opts.push([span(ptr(focus === k + 1), ACC), span(' '), span(`${k + 1}.`, DIM), span(` ${tBox}`), span(t ?? (multi ? 'Type something' : 'Type something.'), t === null ? { d: true } : {})]);
    else opts.push([span(`${dIndent}${t}`)]);
  });
  if (multi) opts.push(focus === 'button' ? [span('❯', ACC), span('    '), span(button, { b: true, fg: 153 })] : [span(`     ${button}`, { b: true })]);
  return {
    above,
    top: [[span('─'.repeat(cols), DIM)]],
    strip: [strip({ tabs, current, answered, submit, mark, bracket })],
    gap1: [''],
    question: [].concat(question).map((q) => (Array.isArray(q) ? q : [span(q, { b: true, fg: 231 })])),
    gap2: [''],
    options: opts,
    sep: [[span('─'.repeat(cols), DIM)]],
    chat: [`${ptr(focus === k + 2)} ${k + 2}. Chat about this`],
    gap3: [''],
    footer: [].concat(o.footer ?? footerText({ nav, insert, ctrl })).map((f) => [span(f, DIM)]),
  };
}

/** The review step (S3 E, T0c 8.3). `v328`: the Claude Code 2.1.328 shape, with no `Ready to submit your answers?` row (QP1; synthetic, drawn from the described layout). */
function reviewParts(o = {}) {
  const { cols = COLS, tabs = ['Project', 'Tools'], answered = [0, 1], warn = false, focus = 1, bracket = false, mark = 'bg', current = 'submit', v328 = false } = o;
  const pairs = o.pairs ?? [{ q: 'Which project should I open?', a: 'web-shop' }, { q: 'Which checks should I run?', a: 'lint, my custom check' }];
  return {
    above: ['⏺ Reviewing.', ''],
    top: [[span('─'.repeat(cols), DIM)]],
    strip: [strip({ tabs, current, answered, submit: true, mark, bracket })],
    gap1: [''],
    heading: [[span('Review your answers', { b: true, fg: 231 })]],
    gap2: [''],
    warn: warn ? [[span('⚠ You have not answered all questions', { fg: 220 })], ''] : [],
    pairs: pairs.flatMap((p) => [[span(` ● ${p.q}`)], [span(`   → ${p.a}`, { fg: 114 })]]),
    gap3: [''],
    ready: v328 ? [] : [[span('Ready to submit your answers?', DIM)]],
    gap4: v328 ? [] : [''],
    submit: [`${ptr(focus === 1)} 1. Submit answers`],
    cancel: [`${ptr(focus === 2)} 2. Cancel`],
  };
}

/** The plan approval, "Ready to code?" (S3 Q3, T0b 3.8). */
function planParts(o = {}) {
  const { cols = COLS, focus = 1, value = null, hint = true, prose = ['- Reply with the single word done.', '- Stop.'], blanks = 6, labels = ['Yes, and use auto mode', 'Yes, manually approve edits'] } = o;
  const w = cols - 4;
  const n3 = labels.length + 1;
  return {
    above: ['⏺ Here is my plan.', ''],
    band: [[span('▔'.repeat(cols - 20), ACC), span(' ◐ medium · /effort ', {}), span('▔', ACC)]],
    gap0: [''],
    top: [[span(`  ${'─'.repeat(w)}`, { fg: 73 })]],
    title: [[span('   Ready to code?', { b: true, fg: 153 })]],
    gap1: [''],
    intro: ["   Here is Claude's plan:"],
    d1: [[span(`  ${'╌'.repeat(w)}`, { fg: 239 })]],
    prose: prose.map((p) => `   ${p}`),
    d2: [[span(`  ${'╌'.repeat(w)}`, { fg: 239 })]],
    fill: Array(blanks).fill(''),
    rule: [[span(`  ${'─'.repeat(w)}`, { fg: 73 })]],
    prompt: [[span('   Claude has written up a plan and is ready to execute. Would you like to proceed?', DIM)]],
    gap2: [''],
    options: [
      ...labels.map((l, j) => `   ${ptr(focus === j + 1)} ${j + 1}. ${l}`.replace(/^ {3} /, focus === j + 1 ? '   ' : '    ')),
      `   ${ptr(focus === n3)} ${n3}. ${value ?? PLAN_TEXT_LABEL}`,
      ...(hint ? [[span('        shift+tab to approve with this feedback', DIM)]] : []),
    ],
    gap3: [''],
    footer: [[span(o.footer ?? '   ctrl+g to edit in Vim · <plans>/demo-api.md', DIM)]],
  };
}

/** "Exit plan mode?" (T0b 3.9): two options, no footer. */
const exitParts = (focus = 1) => ({
  above: ['⏺ Done planning.', ''],
  top: [`  ${'─'.repeat(116)}`],
  title: ['   Exit plan mode?'],
  gap1: [''],
  text: ['    Claude wants to exit plan mode'],
  gap2: [''],
  one: [`    ${ptr(focus === 1)} 1. Yes, and switch to default (ask each time) for this session`],
  two: [`    ${ptr(focus === 2)} 2. No`],
});

/** "Teach auto mode about your environment?" (T0b 3.10): digit options, the footer is NOT the last row; `box` input-box rows under it. Returns a capture { rows, cursor, cols }. */
function nudgeScreen(cols = COLS, box = 1) {
  const rows = rowsFrom({
    above: ['⏺ All done.', ''],
    top: [[span('─'.repeat(cols), ACC)]],
    title: [[span('  Teach auto mode about your environment?', { b: true, fg: 153 })]],
    gap1: [''],
    text: ['  Auto mode works better when it knows your environment. Takes about a minute.'],
    gap2: [''],
    opts: ['  ❯ 1. Yes', '    2. Not now', "    3. Don't show again"],
    gap3: [''],
    footer: [[span('  Enter to confirm · Esc to cancel', { fg: 246, i: true })]],
    rule1: [[span('─'.repeat(cols), DIM)]],
    box: ['❯', ...Array.from({ length: box - 1 }, (_, i) => `  draft line ${i + 2}`)],
    rule2: [[span('─'.repeat(cols), DIM)]],
    mode: ['  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)'],
  });
  return { rows, cursor: { x: 2, y: rows.findIndex((r) => r.map((s) => s.t).join('') === '❯') }, cols };
}

/** Joins the parts in order into rows; `pad` pads every row with spaces to the pane width (Claude does), `trail` adds blank rows, `tree` a subagent list. */
function rowsFrom(parts, { cols = COLS, pad = false, trail = 0, tree = 0 } = {}) {
  const rows = Object.values(parts).flat(1).map(lineOf);
  const padded = pad ? rows.map((r) => [...r, span(' '.repeat(Math.max(0, cols - r.map((s) => s.t).join('').length)))]) : rows;
  return [...padded, ...Array(trail).fill([]), ...(tree > 0 ? subagentRows({ agents: tree }) : [])];
}
const read = (rows, cols = COLS) => readDialogScreen(rows, cols);
const ask = (o, shape) => rowsFrom(askParts(o), shape);
const reason = (rows, cols = COLS) => read(rows, cols)?.unreadable;
const text = (s) => s.map((sp) => sp.t).join('');
const rowAt = (rows, pred) => rows.findIndex((r) => pred(text(r)));

describe('constants', () => {
  test('(+) hold the design values', () => {
    assert.deepEqual([TABS_MAX, NUMBER_MAX, HEADER_MAX, QUESTION_MAX, LABEL_MAX, DESC_MAX, ANSWER_MAX, TEXT_MAX, STEPS_MAX], [8, 9, 40, 500, 200, 500, 500, 300, 24]);
    assert.deepEqual(REASONS, ['cut', 'clipped', 'wide', 'numbers', 'tab', 'layout', 'survey']);
  });

  test('(+) the switches the live checks decided (T0b run C, T0c run B)', () => {
    assert.equal(PLAN_PICK, 'digit');
    assert.equal(PLAIN_TEXT, true);
    assert.equal(MULTI_OTHER, true);
    assert.equal(PLAN_TEXT_LABEL, 'Tell Claude what to change');
  });

  test('(−) nothing else is exported by accident', () => {
    assert.deepEqual(Object.keys(dialog).sort(), [
      'ANSWER_MAX', 'DESC_MAX', 'HEADER_MAX', 'LABEL_MAX', 'MULTI_OTHER', 'NUMBER_MAX', 'PLAIN_TEXT', 'PLAN_PICK', 'PLAN_TEXT_LABEL', 'QUESTION_MAX', 'REASONS',
      'STEPS_MAX', 'TABS_MAX', 'TEXT_MAX', 'dialogCapture', 'dialogOnScreen', 'identityOf', 'otherAllowed', 'readDialogScreen', 'sigOf', 'stripOf',
    ]);
  });
});

describe('readDialogScreen: a question step', () => {
  test('(+) a 2-tab single-select question with descriptions, focus 1 (T0c 8.3 tab 1)', () => {
    const S = read(ask());
    assert.deepEqual(S, {
      kind: 'ask', at: 'question', tabs: [{ header: 'Project', answered: false }, { header: 'Tools', answered: false }], i: 0, single: false,
      question: 'Which project should I open?', multi: false,
      options: [
        { n: 1, label: 'acme-api', description: 'Open the acme-api project.', ticked: false },
        { n: 2, label: 'web-shop', description: 'Open the web-shop project.', ticked: false },
        { n: 3, label: 'demo-api', description: 'Open the demo-api project.', ticked: false },
      ],
      textRow: { n: 4, value: null, ticked: false }, chat: 5, button: null, focus: 1, insert: false, bypass: false, top: 2,
    });
    assert.match(sigOf(S), /^[0-9a-f]{16}$/);
  });

  test('(+) a one-question single dialog: one tab, no Submit, no arrows, footer with the up/down hint (S3 A)', () => {
    const S = read(ask({ tabs: ['Project'] }));
    assert.equal(S.single, true);
    assert.equal(S.tabs.length, 1);
    assert.equal(S.multi, false);
    assert.equal(S.i, 0);
    assert.equal(dialogCapture(ask({ tabs: ['Project'] }), COLS).final, true);
  });

  test('(+) the current tab is read from the background, from reverse video, or from both, at every position (T0 4-question strip)', () => {
    const tabs = ['Tools', 'Project', 'Name', 'Mode'];
    for (const mark of ['bg', 'rev', 'both']) {
      for (const [i] of tabs.entries()) {
        const S = read(ask({ tabs, current: i, mark, answered: i > 0 ? [0] : [] }));
        assert.equal(S.i, i, `${mark} ${i}`);
        assert.deepEqual(S.tabs.map((t) => t.answered), tabs.map((_, n) => n === 0 && i > 0), `${mark} ${i}`);
      }
    }
  });

  test('(+) a tab with a bg of 0 (black) counts as marked', () => {
    const rows = ask();
    const at = rowAt(rows, (t) => t.includes('Project') && t.includes('Tools'));
    rows[at] = rows[at].map((sp) => (sp.t === ' ☐ Project ' ? span(sp.t, { bg: 0 }) : sp));
    assert.equal(read(rows).i, 0);
  });

  test('(+) a multi-select question: [ ] boxes, descriptions at indent 9, a Next button, [ ] Type something (T0 section 4)', () => {
    const S = read(ask({ tabs: ['Tools', 'Project', 'Name', 'Mode'], multi: true, options: CHECKS, question: 'Which checks should I run?' }));
    assert.equal(S.multi, true);
    assert.deepEqual(S.options.map((o) => [o.n, o.label, o.description, o.checked]), [[1, 'lint', 'Run the linter.', false], [2, 'test', 'Run the tests.', false], [3, 'build', 'Build the project.', false]]);
    assert.deepEqual(S.textRow, { n: 4, value: null, checked: false });
    assert.equal(S.button, 'Next');
    assert.equal(S.chat, 5);
    assert.equal(S.focus, 1);
  });

  test('(+) multi with [✔] marks, an answered tab, and the Next button focused with its footer (T0c 8.3)', () => {
    const S = read(ask({ tabs: ['Project', 'Tools'], current: 1, answered: [1], multi: true, options: CHECKS, checks: [1, 3], focus: 'button', button: 'Submit' }));
    assert.deepEqual(S.options.map((o) => o.checked), [true, false, true]);
    assert.equal(S.tabs[1].answered, true);
    assert.equal(S.button, 'Submit');
    assert.equal(S.focus, 'button');
    assert.equal(S.insert, false);
  });

  test('(+) the last multi tab shows Submit and the first shows Next; a one-question multi shows Submit with the up/down hint', () => {
    assert.equal(read(ask({ tabs: ['Project', 'Tools'], current: 1, multi: true, options: CHECKS, button: 'Submit' })).button, 'Submit');
    assert.equal(read(ask({ tabs: ['Tools'], multi: true, options: CHECKS, button: 'Submit' })).button, 'Submit');
    assert.equal(read(ask({ tabs: ['Tools'], multi: true, options: CHECKS, button: 'Submit', nav: '↑/↓' })).single, true);
  });

  test('(+) the text row focused and empty in vim INSERT: focus k+1, insert, a value of null (T0b 3.2)', () => {
    const S = read(ask({ focus: 4, insert: true }));
    assert.equal(S.focus, 4);
    assert.equal(S.insert, true);
    assert.deepEqual(S.textRow, { n: 4, value: null, ticked: false });
  });

  test('(+) 300 typed characters wrap onto indent-5 rows and read back joined with one space (T0b 3.3, L10b)', () => {
    const typed = `${Array.from({ length: 60 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).join(' ')}x`; // 299 + 1 characters
    const rows = [typed.slice(0, 114), typed.slice(115, 224), typed.slice(225)];
    assert.equal(typed.length, 300);
    assert.equal(`${rows[0]} ${rows[1]} ${rows[2]}`, typed);
    const S = read(ask({ focus: 4, insert: true, text: rows }));
    assert.equal(S.textRow.value, typed);
    assert.equal(S.focus, 4);
  });

  test('(+) after one Escape (vim NORMAL, dialog open, text kept) the footer has Esc to cancel and no INSERT (T0b 3.4)', () => {
    const S = read(ask({ focus: 4, insert: false, text: 'my custom proj' }));
    assert.equal(S.insert, false);
    assert.equal(S.textRow.value, 'my custom proj');
  });

  test('(+) a multi text row with typed text is ticked by the typing alone (T0c L4): [✔] my custom check', () => {
    const S = read(ask({ tabs: ['Project', 'Tools'], current: 1, multi: true, options: CHECKS, checks: [1], focus: 4, text: 'my custom check', button: 'Submit' }));
    assert.deepEqual(S.textRow, { n: 4, value: 'my custom check', checked: true });
  });

  test('(+) an answered single option carries a tick that is removed from the label; so does an answered text row (S3 C)', () => {
    const S = read(ask({ ticks: [2] }));
    assert.equal(S.options[1].label, 'web-shop');
    assert.deepEqual(S.options.map((o) => o.ticked), [false, true, false]);
    const T = read(ask({ ticks: [4], text: 'gamma-x' }).map((r) => (text(r).startsWith('  4.') ? [span('  4. gamma-x ✔')] : r)));
    assert.deepEqual(T.textRow, { n: 4, value: 'gamma-x', ticked: true });
  });

  test('(+) a description wrapped onto two rows joins with one space, at indent 5 and at indent 9', () => {
    const wrapped = [{ label: 'acme-api', desc: ['Open the acme-api project, including the', 'shared libraries.'] }, { label: 'web-shop', desc: 'x' }];
    assert.equal(read(ask({ options: wrapped })).options[0].description, 'Open the acme-api project, including the shared libraries.');
    const wrappedMulti = [{ label: 'lint', desc: ['Run the linter and', 'fix.'] }, { label: 'test', desc: null }];
    const S = read(ask({ multi: true, options: wrappedMulti }));
    assert.equal(S.options[0].description, 'Run the linter and fix.');
    assert.equal(S.options[1].description, null, 'an option may have no description');
  });

  test('(+) a question that wraps onto two rows joins with one space; a label with a description whose first word would have fitted is not a wrapped label', () => {
    assert.equal(read(ask({ question: ['Which project should I open for the', 'weekly release review today?'] })).question, 'Which project should I open for the weekly release review today?');
    // cols 70: a 64-cell option row leaves room for a 4-letter word (64 + 1 + 4 = 69 = cols - 1), so a 4-letter first word is a description
    const row64 = 'x'.repeat(59);
    const S = read(ask({ cols: 70, options: [{ label: row64, desc: 'Open the project.' }, { label: 'web-shop', desc: 'y' }] }), 70);
    assert.equal(S.options[0].label, row64);
    assert.equal(S.options[0].description, 'Open the project.');
  });

  test('(+) the long label of T0b run A (62 characters) with its two-row description reads as one option', () => {
    const long = [
      { label: 'acme-api', desc: 'Open the acme-api project.' },
      { label: 'web-shop storefront with the long checkout and payments service', desc: ['Open the web-shop project, including the checkout service and the payments gateway, with every shared library it', 'needs.'] },
      { label: 'demo-api', desc: 'Open the demo-api project.' },
    ];
    const S = read(ask({ tabs: ['Project', 'Tools', 'Mode'], options: long, question: 'Which project should I open for the weekly release review today?' }));
    assert.equal(S.options[1].label, 'web-shop storefront with the long checkout and payments service');
    assert.match(S.options[1].description, /^Open the web-shop project, including .* every shared library it needs\.$/);
    assert.equal(S.tabs.length, 3);
  });

  test('(+) rows padded with spaces to the pane width, a no-break space instead of a space, and trailing blank rows read the same', () => {
    const plain = read(ask());
    assert.deepEqual(read(ask({}, { pad: true })), plain);
    assert.deepEqual(read(ask({}, { trail: 3 })), plain);
    const nb = ask().map((r) => r.map((sp) => (sp.t === 'Which project should I open?' ? { ...sp, t: 'Which\u00a0project should I open?' } : sp)));
    assert.deepEqual(read(nb), plain);
  });

  test('(+) a subagent list drawn under the footer is cut: the dialog reads the same (M11, S15)', () => {
    const plain = read(ask());
    for (const tree of [1, 2, 5]) assert.deepEqual(read(ask({}, { tree })), plain, `${tree} agents`);
    assert.equal(dialogOnScreen(ask({}, { tree: 2 })), true);
  });

  test('(+) a question whose text mentions bypass sets bypass; so does a label, a description, or a bypass mention within the last 15 rows', () => {
    assert.equal(read(ask({ options: [{ label: 'Bypass permissions', desc: 'x' }, { label: 'b', desc: 'y' }] })).bypass, true);
    assert.equal(read(ask({ options: [{ label: 'a', desc: 'turn off permission checks (bypass mode)' }, { label: 'b', desc: 'y' }] })).bypass, true);
    assert.equal(read(ask({ question: 'Should I BYPASS the checks?' })).bypass, true);
    assert.equal(read(ask({ above: ['', 'the word bypass', ''] })).bypass, true, 'bypassWindow: a row above the strip within the window');
    assert.equal(read(ask()).bypass, false);
  });

  test('(+) the question step is not a permission prompt, not a draft, and not a mode line (S3 Q4)', () => {
    for (const rows of [ask(), ask({ focus: 4, insert: true }), ask({ tabs: ['Tools'], multi: true, options: CHECKS }), ask({}, { tree: 2 })]) {
      assert.equal(promptFromRows(rows), null);
      assert.equal(modeFromRows(rows), 'unknown');
      assert.equal(readDraft({ rows, cursor: { x: 0, y: 5 }, cols: COLS }), null);
      assert.equal(parseDraft(rows, null, COLS), null);
    }
  });
});

describe('readDialogScreen: the review step', () => {
  test('(+) all answered, no warning: the pairs in question order (T0c 8.3)', () => {
    const S = read(rowsFrom(reviewParts()));
    assert.deepEqual(S, {
      kind: 'ask', at: 'review', tabs: [{ header: 'Project', answered: true }, { header: 'Tools', answered: true }], warn: false,
      pairs: [{ question: 'Which project should I open?', answer: 'web-shop' }, { question: 'Which checks should I run?', answer: 'lint, my custom check' }],
      focus: 1, insert: false, bypass: false, top: 2,
    });
  });

  test('(+) the warning row, with no pairs (nothing answered) and with one answered pair (T0c 8.3)', () => {
    const none = read(rowsFrom(reviewParts({ warn: true, answered: [], pairs: [] })));
    assert.equal(none.warn, true);
    assert.deepEqual(none.pairs, []);
    const one = read(rowsFrom(reviewParts({ warn: true, answered: [1], pairs: [{ q: 'Which checks should I run?', a: 'lint, my custom check' }] })));
    assert.equal(one.warn, true);
    assert.equal(one.pairs.length, 1);
    assert.equal(one.tabs[0].answered, false);
  });

  test('(+) the bracketed Submit token of S3 E, and reverse video as the mark', () => {
    assert.equal(read(rowsFrom(reviewParts({ bracket: true }))).at, 'review');
    assert.equal(read(rowsFrom(reviewParts({ mark: 'rev' }))).at, 'review');
  });

  test('(+) focus on Submit answers, on Cancel, or none; the pointer decides', () => {
    assert.equal(read(rowsFrom(reviewParts({ focus: 1 }))).focus, 1);
    assert.equal(read(rowsFrom(reviewParts({ focus: 2 }))).focus, 2);
    assert.equal(read(rowsFrom(reviewParts({ focus: 3 }))).focus, null);
  });

  test('(+) a long question and answer wrap onto continuation rows that join the pair', () => {
    const rows = rowsFrom(reviewParts());
    const at = rowAt(rows, (t) => t.includes('→ web-shop'));
    rows.splice(at + 1, 0, [span('     storefront and payments')]);
    assert.equal(read(rows).pairs[0].answer, 'web-shop storefront and payments');
    const q = rowsFrom(reviewParts());
    q.splice(rowAt(q, (t) => t.includes('● Which project')) + 1, 0, [span('   today?')]);
    assert.equal(read(q).pairs[0].question, 'Which project should I open? today?');
  });

  test('(+) the review has no footer, is a dialog, and a subagent list below its last row is cut', () => {
    const rows = rowsFrom(reviewParts());
    assert.equal(dialogOnScreen(rows), true);
    assert.deepEqual(read(rowsFrom(reviewParts(), { tree: 2 })), read(rows));
    assert.equal(promptFromRows(rows), null);
    assert.equal(readDraft({ rows, cursor: { x: 0, y: 4 }, cols: COLS }), null);
  });

  test('(+) bypass in an answer sets bypass', () => {
    assert.equal(read(rowsFrom(reviewParts({ pairs: [{ q: 'Which mode?', a: 'bypass permissions' }, { q: 'Which checks should I run?', a: 'lint' }] }))).bypass, true);
  });

  // QP1: Claude Code 2.1.328 draws the Review with no `Ready to submit your answers?` row; the options follow the answers.
  test('(+) the 2.1.328 Review (no Ready row) reads like the 2.1.326 one, and both have one sig for the same pairs (QP1)', () => {
    const old = read(rowsFrom(reviewParts()));
    const rows = rowsFrom(reviewParts({ v328: true }));
    assert.equal(rows.some((r) => text(r) === 'Ready to submit your answers?'), false, 'the fixture has no Ready row');
    const S = read(rows);
    assert.equal(S.unreadable, undefined);
    assert.equal(S.at, 'review');
    assert.deepEqual(S.pairs, [{ question: 'Which project should I open?', answer: 'web-shop' }, { question: 'Which checks should I run?', answer: 'lint, my custom check' }]);
    assert.deepEqual(S, old, 'the same reading as the 2.1.326 shape');
    assert.equal(sigOf(S), sigOf(old));
    assert.equal(dialogOnScreen(rows), true);
    assert.deepEqual(dialogCapture(rows, COLS), dialogCapture(rowsFrom(reviewParts()), COLS), 'the capture the page gets is the same too');
    for (const [focus, want] of [[1, 1], [2, 2], [3, null]]) assert.equal(read(rowsFrom(reviewParts({ v328: true, focus }))).focus, want, `focus ${focus}`);
    assert.equal(read(rowsFrom(reviewParts({ v328: true, bracket: true }))).at, 'review');
  });

  test('(+) the 2.1.328 Review with the warning row, and with nothing answered, reads (the warning row there is unverified live, LC-QP-R1)', () => {
    const one = [{ q: 'Which checks should I run?', a: 'lint, my custom check' }];
    const S = read(rowsFrom(reviewParts({ v328: true, warn: true, answered: [1], pairs: one })));
    assert.deepEqual([S.at, S.warn, S.pairs.length, S.tabs[0].answered], ['review', true, 1, false]);
    assert.equal(sigOf(S), sigOf(read(rowsFrom(reviewParts({ warn: true, answered: [1], pairs: one })))), 'the same sig as the 2.1.326 shape');
    const none = read(rowsFrom(reviewParts({ v328: true, warn: true, answered: [], pairs: [] })));
    assert.deepEqual([none.at, none.warn, none.pairs], ['review', true, []]);
  });

  test('(+) the 2.1.328 Review: a wrapped question or answer still joins its pair, and a bar before a question row is still taken out', () => {
    const rows = rowsFrom(reviewParts({ v328: true }));
    rows.splice(rowAt(rows, (t) => t.includes('\u2192 web-shop')) + 1, 0, [span('     storefront and payments')]);
    rows.splice(rowAt(rows, (t) => t.includes('\u25cf Which project')) + 1, 0, [span('   today?')]);
    const S = read(rows);
    assert.deepEqual([S.pairs[0].question, S.pairs[0].answer], ['Which project should I open? today?', 'web-shop storefront and payments']);
    const barred = rowsFrom(reviewParts({ v328: true }));
    const at = rowAt(barred, (t) => t.includes('\u25cf Which project'));
    barred[at] = [span(' \u2502 '), ...barred[at].map((s) => ({ ...s, t: s.t.replace(/^ /, '') }))];
    assert.equal(read(barred).unreadable, undefined, 'a barred question row reads');
    assert.deepEqual(read(barred).pairs, read(rowsFrom(reviewParts({ v328: true }))).pairs);
  });
});

describe('readDialogScreen: the plan approval', () => {
  test('(+) focus 1: options indented 3, the text option marked by its hint, the plan rows between the dashed rules (T0b 3.8)', () => {
    const S = read(rowsFrom(planParts()));
    assert.deepEqual(S, {
      kind: 'plan', at: 'plan',
      options: [{ n: 1, label: 'Yes, and use auto mode', text: false }, { n: 2, label: 'Yes, manually approve edits', text: false }, { n: 3, label: 'Tell Claude what to change', text: true }],
      textRow: { n: 3, value: null }, planRows: ['- Reply with the single word done.', '- Stop.'], focus: 1, insert: false, bypass: false, top: 18,
    });
  });

  test('(+) focus 2 and focus 3 (the text option; no INSERT marker even then)', () => {
    assert.equal(read(rowsFrom(planParts({ focus: 2 }))).focus, 2);
    const S = read(rowsFrom(planParts({ focus: 3 })));
    assert.equal(S.focus, 3);
    assert.equal(S.insert, false);
  });

  test('(+) typed text in the text option is the value; the option label stays the constant', () => {
    const S = read(rowsFrom(planParts({ focus: 3, value: 'also add a test' })));
    assert.equal(S.textRow.value, 'also add a test');
    assert.equal(S.options[2].label, PLAN_TEXT_LABEL);
  });

  test('(+) a plan with no text option (no hint row) has none; the filler rows and a long plan are read', () => {
    const S = read(rowsFrom(planParts({ hint: false, labels: ['Yes', 'No'], value: null })));
    assert.equal(S.options.length, 3, 'the third row is a plain option without its hint');
    assert.equal(S.textRow, null);
    assert.equal(S.options[2].text, false);
    const long = Array.from({ length: 30 }, (_, i) => `- step ${i + 1} of the plan`);
    assert.equal(read(rowsFrom(planParts({ prose: long, blanks: 0 }))).planRows.length, 30);
    assert.equal(read(rowsFrom(planParts({ blanks: 19 }))).planRows.length, 2, 'the filler rows are not part of the plan');
  });

  test('(+) a trailing blank row inside the plan rows and the pane height do not change the plan rows', () => {
    const a = read(rowsFrom(planParts({ prose: ['- one', '', '- two'] })));
    assert.deepEqual(a.planRows, ['- one', '', '- two']);
    const plain = read(rowsFrom(planParts())).planRows;
    assert.deepEqual(read(rowsFrom(planParts({ blanks: 19 }))).planRows, plain, 'a taller pane: more filler rows before the rule');
    assert.deepEqual(read(rowsFrom(planParts({ blanks: 1 }))).planRows, plain, 'a shorter pane');
    assert.deepEqual(read(rowsFrom(planParts(), { trail: 3 })).planRows, plain, 'blank rows under the footer');
  });

  test('(+) bypass in the choice area sets bypass', () => {
    assert.equal(read(rowsFrom(planParts({ labels: ['Yes, and use bypass permissions', 'Yes, manually approve edits'] }))).bypass, true);
  });

  // M6 (security review 0.5): the reader wants exactly one `Ready to code?` row above the footer. A plan text, or the conversation above the dialog,
  // that repeats the title would move where the reading starts, so the sig would cover less of the plan: the plan is unreadable instead.
  const forged = (w = COLS - 4) => ['Ready to code?', "Here is Claude's plan:", '╌'.repeat(w), '- forged step'];

  test('(−) M6: a plan text that repeats the title, the intro and a dashed rule is unreadable (layout), not a shorter plan', () => {
    const rows = rowsFrom(planParts({ prose: [...forged(), '- Stop.'] }));
    assert.deepEqual(read(rows), { unreadable: 'layout', kind: 'plan' });
    assert.deepEqual(dialogCapture(rows, COLS), { state: 'unreadable', kind: 'plan', reason: 'layout' });
  });

  test('(−) M6: a second `Ready to code?` row above the footer (in the text above the dialog, or inside the plan) is unreadable', () => {
    assert.deepEqual(read(rowsFrom({ ...planParts(), above: ['⏺ Here is my plan.', 'Ready to code?', ''] })), { unreadable: 'layout', kind: 'plan' }, 'the real title is the last one: only the count refuses it');
    for (const prose of [['- one', 'Ready to code?', '- two'], ['Ready to code?', 'Ready to code?']]) {
      const got = read(rowsFrom(planParts({ prose }))); // the reading would start inside the plan and find no intro: cut. Unreadable either way
      assert.deepEqual([got.kind, typeof got.unreadable], ['plan', 'string'], JSON.stringify(prose));
    }
  });

  test('(+) M6: the repeat is still a dialog for every control that needs a plain box (unreadable is not invisible)', () => {
    const rows = rowsFrom(planParts({ prose: [...forged(), '- Stop.'] }));
    assert.equal(dialogOnScreen(rows), true);
    assert.equal(promptFromRows(rows), null);
    assert.equal(readDraft({ rows, cursor: { x: 0, y: 5 }, cols: COLS }), null);
  });

  test('(+) M6: exactly one title reads as before, with and without text above it', () => {
    assert.equal(read(rowsFrom(planParts())).kind, 'plan');
    assert.equal(read(rowsFrom({ ...planParts(), above: ['⏺ I will plan this.', 'Let me know when you are ready.', ''] })).kind, 'plan');
  });

  test('(+) the plan approval is a dialog, not a prompt, not a draft', () => {
    const rows = rowsFrom(planParts());
    assert.equal(dialogOnScreen(rows), true);
    assert.equal(promptFromRows(rows), null);
    assert.equal(readDraft({ rows, cursor: { x: 0, y: 5 }, cols: COLS }), null);
    assert.equal(modeFromRows(rows), 'unknown');
  });
});

describe('the two dialogs nika recognises but never reads (orchestrator ruling 4)', () => {
  test('(+) "Exit plan mode?" (2 options, no footer) is a dialog on screen and unreadable', () => {
    for (const focus of [1, 2]) {
      const rows = rowsFrom(exitParts(focus));
      assert.equal(dialogOnScreen(rows), true, `focus ${focus}`);
      assert.deepEqual(read(rows), { unreadable: 'layout', kind: null });
      assert.equal(promptFromRows(rows), null);
      assert.equal(modeFromRows(rows), 'unknown');
      assert.equal(dialogCapture(rows, COLS).state, 'unreadable');
    }
  });

  test('(+) the auto-mode nudge is a dialog on screen although its footer is not the last row; no mode, no draft, no prompt, no form', () => {
    const s = nudgeScreen();
    assert.equal(dialogOnScreen(s.rows), true);
    assert.deepEqual(read(s.rows), { unreadable: 'layout', kind: null });
    assert.equal(modeFromRows(s.rows), 'unknown', 'the mode line under the box does not count');
    assert.equal(readDraft(s), null, 'the box under it is not a plain input box');
    assert.equal(parseDraft(s.rows, s.cursor, s.cols), null);
    assert.equal(promptFromRows(s.rows), null);
    assert.deepEqual(dialogCapture(s.rows, COLS), { state: 'unreadable', kind: null, reason: 'layout' });
    assert.equal(bypassWindow(s.rows), false);
  });

  test('(+) the nudge with a subagent list under its mode line is still the nudge', () => {
    const s = nudgeScreen();
    assert.equal(dialogOnScreen([...s.rows, ...subagentRows({ agents: 2 })]), true);
  });

  test('(+) the nudge above a tall input box (1, 6, 10, 12 and 20 rows) is a dialog on screen: no mode, no draft, no form (review I2)', () => {
    for (const box of [1, 6, 10, 12, 20]) {
      const s = nudgeScreen(COLS, box);
      assert.equal(dialogOnScreen(s.rows), true, `box ${box}`);
      assert.deepEqual(read(s.rows), { unreadable: 'layout', kind: null }, `box ${box}`);
      assert.equal(modeFromRows(s.rows), 'unknown', `box ${box}`);
      assert.equal(lastNonBlank(s.rows, 1)[0].trim(), 'Enter to confirm · Esc to cancel', `box ${box}`);
      assert.equal(readDraft(s), null, `box ${box}`);
    }
  });

  test('(−) the two nudge rows quoted above a short question dialog with a bypass option do not hide it: the dialog is read and bypass is set (review I1, probe 2)', () => {
    const quoted = ['⏺ The dialog reads:', '  Teach auto mode about your environment?', '  Enter to confirm · Esc to cancel', ''];
    const rows = ask({ tabs: ['Mode'], options: [{ label: 'bypass permissions', desc: 'Skip every check.' }, { label: 'default', desc: 'Ask each time.' }], above: quoted });
    assert.equal(dialogOnScreen(rows), true);
    assert.equal(bypassWindow(rows), true);
    const S = read(rows);
    assert.equal(S.kind, 'ask');
    assert.equal(S.bypass, true);
    assert.equal(dialogCapture(rows, COLS).bypass, true);
    assert.equal(modeFromRows(rows), 'unknown');
  });

  test('(−) the nudge rows quoted in a message above an idle input box change nothing: the draft, the mode and the prompt read as on any idle screen (review I1)', () => {
    const idle = boxRows({ cols: COLS, lines: ['hello'] });
    const quoted = [[span('⏺ I saw this dialog:')], [span('  Teach auto mode about your environment?')], [span('  Enter to confirm · Esc to cancel')], [span('⏺ Anyway, done.')], []];
    const seen = { ...idle, rows: [...quoted, ...idle.rows], cursor: { ...idle.cursor, y: idle.cursor.y + quoted.length } };
    assert.equal(dialogOnScreen(seen.rows), false);
    assert.equal(modeFromRows(seen.rows), 'auto');
    assert.equal(promptFromRows(seen.rows), null);
    assert.equal(readDraft(seen).text, 'hello');
    assert.equal(bypassWindow(seen.rows), false);
  });

  test('(−) the same box without the nudge rows is an idle screen: a plain box, a mode, no dialog', () => {
    const s = boxRows({ cols: COLS, lines: [''] });
    assert.equal(dialogOnScreen(s.rows), false);
    assert.equal(modeFromRows(s.rows), 'auto');
    assert.notEqual(readDraft(s), null);
  });

  test('(−) a nudge title without its footer, or its footer without the title, is not a dialog', () => {
    const s = nudgeScreen();
    const noFooter = s.rows.filter((r) => !text(r).includes('Enter to confirm'));
    const noTitle = s.rows.filter((r) => !text(r).includes('Teach auto mode'));
    assert.equal(dialogOnScreen(noFooter), false);
    assert.equal(dialogOnScreen(noTitle), false);
    assert.equal(modeFromRows(noTitle), 'auto', 'nothing else changes for such a screen');
  });

  test('(−) Exit plan mode without its title, or with a third row, is not recognised', () => {
    const noTitle = rowsFrom({ ...exitParts(), title: [] });
    assert.equal(dialogOnScreen(noTitle), false);
    const plainTwo = rowsFrom({ above: ['⏺ x', ''], one: ['  ❯ 1. Yes'], two: ['    2. No'] });
    assert.equal(dialogOnScreen(plainTwo), false);
  });
});

describe('dialogOnScreen', () => {
  test('(+) true for every shape: question, multi, review, plan, wrapped footer, vim footers', () => {
    const wrappedFooter = askParts({ cols: 70, footer: ['Enter to select · Tab/Arrow keys to navigate · ctrl+g to', 'edit in Vim · Esc to cancel'] });
    for (const rows of [ask(), ask({ focus: 4, insert: true }), ask({ tabs: ['Tools'], multi: true, options: CHECKS }), rowsFrom(reviewParts()), rowsFrom(planParts()), rowsFrom(wrappedFooter)]) {
      assert.equal(dialogOnScreen(rows), true);
    }
  });

  test('(−) false on idle, busy, permission prompt, trust dialog, slash menu, an empty screen and non-rows', () => {
    const idle = boxRows({ cols: COLS, lines: ['hello'] }).rows;
    const busy = boxRows({ cols: COLS, lines: [''], footer: '⏸ manual mode on · esc to interrupt' }).rows;
    const permission = [...['Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don\'t ask again', '  3. No', '', 'Esc to cancel'].map(lineOf)];
    const trust = ['Do you trust the files in this folder?', '', '❯ 1. Yes, proceed', '  2. No, exit', '', 'Enter to confirm · Esc to cancel'].map(lineOf);
    const slash = [...boxRows({ cols: COLS, lines: ['/co'] }).rows, lineOf('  /compact    Clear history but keep a summary'), lineOf('  /config     Open config panel')];
    for (const [name, rows] of Object.entries({ idle, busy, permission, trust, slash, empty: [], blank: [[], []] })) assert.equal(dialogOnScreen(rows), false, name);
    for (const bad of [null, undefined, 'x', 5, {}]) assert.equal(dialogOnScreen(bad), false, String(bad));
    assert.equal(read(idle), null);
  });

  test('(−) a lookalike footer ABOVE the real bottom row is not a dialog (the footer is the last row)', () => {
    const rows = [lineOf(footerText()), ...boxRows({ cols: COLS, lines: [''] }).rows];
    assert.equal(dialogOnScreen(rows), false);
    const quoted = [lineOf('ctrl+g to edit in Vim · <plans>/x.md'), lineOf('Ready to code?'), ...boxRows({ cols: COLS, lines: [''] }).rows];
    assert.equal(dialogOnScreen(quoted), false);
  });

  test('(−) the plan footer without Ready to code? above is not a dialog; neither is Review your answers without 2. Cancel last', () => {
    assert.equal(dialogOnScreen([lineOf('hello'), lineOf('   ctrl+g to edit in Vim · <plans>/demo-api.md')]), false);
    const rows = rowsFrom(reviewParts());
    assert.equal(dialogOnScreen(rows.slice(0, -1)), false, 'Cancel row gone');
  });

  test('(−) a lookalike footer, strip or rule in the conversation ABOVE a real dialog does not change what is read', () => {
    const plain = read(ask());
    const fakes = [footerText(), '←  ☐ Fake  ✔ Submit  →', '─'.repeat(COLS), 'ctrl+g to edit in Vim · <plans>/x.md', 'Ready to code?', 'Review your answers'];
    const withoutTop = ({ top, ...rest }) => rest; // the cut (0.5.1 E) moves down with the rows above; nothing else may change
    assert.deepEqual(withoutTop(read(ask({ above: fakes }))), withoutTop(plain));
    // 0.5.4 SF (B1 open question 4): planParts ignores `above`, so the old plan half compared two identical screens. The plan gets its own lookalike list: no `Ready to code?`
    // row (the plan's own title; a second one above it makes the plan refuse as `layout`, by design), and the fakes go in through the parts' `above`.
    const planFakes = fakes.filter((f) => f !== 'Ready to code?');
    assert.notEqual(planFakes.length, fakes.length);
    const planPlain = read(rowsFrom(planParts()));
    const planFaked = read(rowsFrom({ ...planParts(), above: planFakes }));
    assert.notEqual(planPlain, null, 'the plan reads');
    assert.deepEqual(withoutTop(planFaked), withoutTop(planPlain));
    assert.equal(planFaked.top, planPlain.top + planFakes.length - 2, 'moved by the rows added above (the default has two)');
    assert.equal(read(ask({ above: fakes })).top, plain.top + fakes.length - 2, 'moved by the rows added above (the default has two)');
  });

  test('(−) a permission prompt is a prompt: dialogCapture is null while one parses', () => {
    const permission = [lineOf('Do you want to proceed?'), lineOf('❯ 1. Yes'), lineOf('  2. No'), lineOf('Esc to cancel')];
    assert.notEqual(promptFromRows(permission), null);
    assert.equal(dialogCapture(permission, COLS), null);
  });
});

describe('identity and sig (design W1 2.4)', () => {
  const sig = (rows, cols = COLS) => sigOf(read(rows, cols));

  test('(+) stable across focus moves, ticks, answered marks, typed text and INSERT', () => {
    const base = sig(ask({ answered: [], ticks: [] }));
    assert.equal(sig(ask({ focus: 2 })), base);
    assert.equal(sig(ask({ focus: 4, insert: true })), base);
    assert.equal(sig(ask({ focus: 4, text: 'my custom proj' })), base);
    assert.equal(sig(ask({ ticks: [2], answered: [0] })), base);
    assert.equal(sig(ask({ focus: 5 })), base);
    const multi = sig(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS }));
    assert.equal(sig(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS, checks: [1, 2] })), multi);
    assert.equal(sig(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS, focus: 4, text: 'x' })), multi);
    assert.equal(sig(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS, focus: 'button' })), multi);
    const review = sig(rowsFrom(reviewParts()));
    assert.equal(sig(rowsFrom(reviewParts({ focus: 2 }))), review);
    const plan = sig(rowsFrom(planParts()));
    for (const o of [{ focus: 2 }, { focus: 3 }, { focus: 3, value: 'also add a test' }, { blanks: 19 }]) assert.equal(sig(rowsFrom(planParts(o))), plan);
  });

  test('(+) changes with the tab, the question, a label, a description, a header, multi, a review pair, the warning, a plan row or a plan option', () => {
    const base = sig(ask());
    const changed = [
      ask({ current: 1 }), ask({ question: 'Which project should I close?' }), ask({ options: [{ ...OPTS[0], label: 'acme-api2' }, OPTS[1], OPTS[2]] }),
      ask({ options: [{ ...OPTS[0], desc: 'Open it.' }, OPTS[1], OPTS[2]] }), ask({ tabs: ['Project', 'Other'] }), ask({ options: OPTS.slice(0, 2) }),
      ask({ multi: true }),
    ];
    assert.equal(read(changed.at(-1)).multi, true, 'the last fixture only flips multi');
    const seen = new Set([base]);
    for (const rows of changed) seen.add(sig(rows));
    assert.equal(seen.size, changed.length + 1);
    const rv = [rowsFrom(reviewParts()), rowsFrom(reviewParts({ warn: true, answered: [0], pairs: [{ q: 'Which project should I open?', a: 'web-shop' }] })), rowsFrom(reviewParts({ pairs: [{ q: 'Which project should I open?', a: 'acme-api' }, { q: 'Which checks should I run?', a: 'lint' }] }))];
    assert.equal(new Set(rv.map((r) => sig(r))).size, 3);
    const pl = [rowsFrom(planParts()), rowsFrom(planParts({ prose: ['- Do it.'] })), rowsFrom(planParts({ labels: ['Yes', 'No'] }))];
    assert.equal(new Set(pl.map((r) => sig(r))).size, 3);
  });

  test('(+) the plan sig changes when the last option flips between a plain option and the text option: same label, with and without its hint row (review M2)', () => {
    const withHint = read(rowsFrom(planParts({ hint: true })));
    const without = read(rowsFrom(planParts({ hint: false })));
    assert.deepEqual([withHint.options[2].label, without.options[2].label], [PLAN_TEXT_LABEL, PLAN_TEXT_LABEL]);
    assert.deepEqual([withHint.options[2].text, without.options[2].text], [true, false]);
    assert.notEqual(sigOf(withHint), sigOf(without));
  });

  test('(+) the sig is 16 hex over the kind and the identity; a question, a review and a plan never share one', () => {
    const all = [ask(), rowsFrom(reviewParts()), rowsFrom(planParts())].map((r) => read(r));
    for (const S of all) assert.match(sigOf(S), /^[0-9a-f]{16}$/);
    assert.equal(new Set(all.map(sigOf)).size, 3);
    assert.equal(JSON.parse(identityOf(all[0]))[0], 'ask');
    assert.equal(JSON.parse(identityOf(all[2]))[0], 'plan');
    assert.deepEqual(JSON.parse(identityOf(all[0]))[1].slice(0, 3), ['question', ['Project', 'Tools'], 0]);
  });

  test('(−) the sig does not depend on the pane height (more rows above), padding, trailing blank rows, a subagent list or a no-break space', () => {
    const base = sig(ask());
    assert.equal(sig(ask({ above: [...Array(30).fill('⏺ older text'), ''] })), base);
    assert.equal(sig(ask({}, { pad: true, trail: 4 })), base);
    assert.equal(sig(ask({}, { tree: 3 })), base);
    const nb = ask().map((r) => r.map((sp) => (sp.t.includes('Which') || sp.t.includes('acme') ? { ...sp, t: sp.t.replace(/ /g, '\u00a0') } : sp)));
    assert.equal(nb.some((r) => r.some((sp) => sp.t.includes('\u00a0'))), true, 'the fixture holds no-break spaces');
    assert.equal(sig(nb), base);
  });
});

describe('otherAllowed', () => {
  test('(+) single-select: always; multi: only on the last tab', () => {
    assert.equal(otherAllowed(read(ask())), true);
    assert.equal(otherAllowed(read(ask({ tabs: ['Project', 'Tools'], current: 1, multi: true, options: CHECKS, button: 'Submit' }))), true);
    assert.equal(otherAllowed(read(ask({ tabs: ['Tools'], multi: true, options: CHECKS, button: 'Submit' }))), true);
  });

  test('(−) a multi question on a tab that is not the last; a review; a plan', () => {
    assert.equal(otherAllowed(read(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS }))), false);
    assert.equal(otherAllowed(read(rowsFrom(reviewParts()))), false);
    assert.equal(otherAllowed(read(rowsFrom(planParts()))), false);
  });
});

describe('unreadable: every rule of design 2.3 has a fixture', () => {
  test('(−) cut: no top rule above the strip, or no strip at all', () => {
    assert.equal(reason(rowsFrom({ ...askParts(), top: [''] })), 'cut');
    assert.equal(reason(rowsFrom({ ...askParts(), top: [] })), 'cut');
    assert.equal(reason(rowsFrom({ ...askParts(), strip: [] })), 'cut');
    assert.equal(reason(rowsFrom({ ...reviewParts(), top: [''] })), 'cut');
  });

  test('(−) clipped (F16): a header, a label, the question or a review answer ends in an ellipsis (Claude shortened it to the width: more rows never help)', () => {
    assert.equal(reason(ask({ tabs: ['Project', 'To…'] })), 'clipped');
    assert.equal(reason(ask({ options: [{ label: 'acme-ap…', desc: 'x' }, OPTS[1]] })), 'clipped');
    assert.equal(reason(ask({ question: 'Which project should I o…' })), 'clipped');
    assert.equal(reason(rowsFrom(reviewParts({ pairs: [{ q: 'Which?', a: 'a very long answer that was…' }] }))), 'clipped');
    assert.equal(reason(rowsFrom(reviewParts({ pairs: [{ q: 'Which project should…', a: 'x' }] }))), 'clipped');
  });

  test('(−) clipped (F16): a plan option label that ends in an ellipsis is a shortened text too, not a clipped top (plans are never grown, D1)', () => {
    assert.equal(reason(rowsFrom(planParts({ labels: ['Yes, and use auto mo…', 'Yes, manually approve edits'] }))), 'clipped');
    assert.equal(reason(rowsFrom(planParts())), undefined, 'the same plan whole reads');
  });

  test('(−) the top wins over an ellipsis: a clipped strip AND a missing top rule or strip reads cut (rows can show it), never clipped (F16)', () => {
    assert.equal(reason(rowsFrom({ ...askParts({ tabs: ['Project', 'To…'] }), top: [''] })), 'cut');
    assert.equal(reason(rowsFrom({ ...askParts({ question: 'Which project should I o…' }), strip: [] })), 'cut');
    assert.equal(reason(rowsFrom({ ...reviewParts({ pairs: [{ q: 'Which?', a: 'a very long answer that was…' }] }), top: [''] })), 'cut');
  });

  test('(−) cut: a short pane that clipped the strip and the top rule (T0b 3.6, 14 and 10 rows)', () => {
    const rows14 = ['', 'Which project should I open?', '', '❯ 1. acme-api', '     Open the acme-api project.', '  2. web-shop', '     needs.', '↓ 3. demo-api', '     Open the demo-api project.', '─'.repeat(COLS), '  5. Chat about this', '', footerText({ nav: 'Tab/Arrow keys' })].map(lineOf);
    assert.equal(reason(rows14), 'cut');
    const rows10 = [...rowsFrom({ ...askParts({ tabs: ['Project', 'Tools', 'Mode'] }), top: [], options: ['❯ 1. acme-api', '     Open the acme-api project.'] })];
    assert.equal(reason(rows10), 'cut');
  });

  test('(−) cut: a short pane that scrolled the option list (rows start with an up arrow) and lost the top rule', () => {
    const parts = askParts({ tabs: ['Project', 'Tools', 'Mode'], focus: 4 });
    const rows = rowsFrom({ ...parts, top: [], options: ['↑ 2. web-shop', '     Open the web-shop project.', '  3. demo-api', '     Open the demo-api project.', '❯ 4. Type something.'] });
    assert.equal(reason(rows), 'cut');
  });

  test('(−) cut: the plan lacks a dashed rule or the prompt row', () => {
    assert.equal(reason(rowsFrom({ ...planParts(), d1: [] })), 'cut');
    assert.equal(reason(rowsFrom({ ...planParts(), d2: [] })), 'cut');
    assert.equal(reason(rowsFrom({ ...planParts(), prompt: [] })), 'cut');
    assert.equal(reason(rowsFrom({ ...planParts(), prompt: ['   Claude has written up a plan and is ready to execute. Would you like to p…'] })), 'cut', 'a prompt row ending in an ellipsis is "no prompt row": plans are not split (F16)');
  });

  test('(−) wide: a description row, or any region row, as wide as the pane (it may be cut there)', () => {
    const long = [{ label: 'acme-api', desc: `${'d'.repeat(COLS - 5)}` }, OPTS[1]];
    assert.equal(reason(ask({ options: long })), 'wide');
    const fits = [{ label: 'acme-api', desc: `Open ${'d'.repeat(COLS - 11)}` }, OPTS[1]];
    assert.equal(read(ask({ options: fits })).options[0].description.length, COLS - 6, 'one cell less is the widest row Claude draws');
    assert.equal(reason(ask({ question: 'q'.repeat(COLS) })), 'wide');
    assert.equal(reason(rowsFrom({ ...askParts(), strip: [[span(`←  ☐ Project  ${'x'.repeat(COLS)}  ✔ Submit  →`)]] })), 'wide', 'the strip is a region row too');
  });

  test('(−) wide: a label row followed by a row whose first word would not have fitted behind it (a wrapped label)', () => {
    // cols 70: a 64-cell row leaves room for 4 more cells; a 5-letter first word cannot be a description, it may be the rest of the label
    const row64 = 'x'.repeat(59);
    assert.equal(reason(ask({ cols: 70, options: [{ label: row64, desc: 'Opens the project.' }, { label: 'web-shop', desc: 'y' }] }), 70), 'wide');
    const wrapped = [{ label: 'web-shop storefront with the long', desc: ['checkout and payments service', 'Open the web-shop project.'] }, OPTS[1]];
    assert.equal(reason(ask({ cols: 40, options: wrapped, tabs: ['Project'] }), 40), 'wide', 'T0b 3.5: the label continuation at indent 5 looks like a description');
  });

  test('(−) wide: a footer wrapped onto two or three rows is never read (orchestrator ruling 1)', () => {
    const two = askParts({ cols: 70, footer: ['Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim', '· Esc to cancel'], focus: 4 });
    const S2 = read(rowsFrom({ ...two, footer: [two.footer[0], two.footer[1]] }), 70);
    assert.equal(S2.unreadable, 'wide');
    assert.equal(S2.kind, 'ask');
    const three = askParts({ cols: 40, tabs: ['Project'], footer: ['-- INSERT -- · Enter to select ·', '↑/↓ to navigate · ctrl+g to', 'edit in Vim'], focus: 4 });
    assert.equal(reason(rowsFrom(three), 40), 'wide');
    assert.equal(dialogOnScreen(rowsFrom(three)), true, 'still a dialog on screen');
    const t0b = askParts({ cols: 70, focus: 4, footer: ['-- INSERT -- · Enter to select ·', 'Tab/Arrow keys to navigate · ctrl+g to', 'edit in Vim'] });
    assert.equal(reason(rowsFrom(t0b), 70), 'wide', 'the INSERT footer of T0b 3.5, three rows');
    assert.equal(read(rowsFrom(t0b), 70).kind, 'ask');
  });

  test('(−) wide: a plan whose option label wraps onto a second row, or whose footer wraps', () => {
    const rows = rowsFrom({ ...planParts(), options: ['   ❯ 1. Yes, and use auto mode and a very long', '     continuation of that label', '     2. Yes, manually approve edits'] });
    assert.equal(reason(rows), 'wide');
    assert.equal(reason(rowsFrom({ ...planParts({ cols: 60 }), footer: ['   ctrl+g to edit in Vim ·', '   <plans>/demo-api.md'] }), 60), 'wide');
  });

  test('(−) wide: the pane width is unknown or too small to trust', () => {
    for (const cols of [undefined, null, 'x', 19, 0, NaN, 120.5]) assert.equal(readDialogScreen(ask(), cols).unreadable, 'wide', String(cols));
  });

  test('(−) the T0b 40-column capture: strip headers cut with an ellipsis (clipped, F16), wrapped question, label and footer: unreadable, never a form', () => {
    const w = 40;
    const lines = [
      '─'.repeat(w), '←  ☐ Project  ☐ To…  ☐ Mo…  ✔ Submit  →', '', 'Which project should I open for the', 'weekly release review today?', '',
      '❯ 1. acme-api', '     Open the acme-api project.', '  2. web-shop storefront with the long', '     checkout and payments service', '     Open the web-shop project,',
      '     including the checkout service and', '     the payments gateway, with every', '     shared library it needs.', '  3. demo-api', '     Open the demo-api project.',
      '  4. Type something.', '─'.repeat(w), '  5. Chat about this', '', 'Enter to select · Tab/Arrow keys to', 'navigate · Esc to cancel',
    ];
    const rows = [[], ...lines.map((l, i) => (i === 1 ? strip({ tabs: ['Project', 'To…', 'Mo…'], submit: true }) : lineOf(l)))];
    assert.equal(dialogOnScreen(rows), true);
    assert.equal(read(rows, w).unreadable, 'clipped');
    assert.equal(dialogCapture(rows, w).state, 'unreadable');
  });

  test('(−) numbers: an option number above 9 (8 options + the text row + the chat row = 10)', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ label: `opt${i + 1}`, desc: 'd' }));
    assert.equal(reason(ask({ options: eight })), 'numbers');
    const seven = eight.slice(0, 7);
    assert.equal(read(ask({ options: seven })).chat, 9, 'k = 7 is the most: the chat row is 9');
  });

  test('(−) numbers: a gap, a wrong chat row number, a missing chat row, and the text row not being k+1', () => {
    const gap = askParts();
    assert.equal(reason(rowsFrom({ ...gap, options: gap.options.map((r) => (text(r).startsWith('  3.') ? [span('  4. demo-api')] : r)) })), 'numbers');
    assert.equal(reason(rowsFrom({ ...askParts(), chat: ['  7. Chat about this'] })), 'numbers');
    assert.equal(reason(rowsFrom({ ...askParts(), chat: [''] })), 'numbers');
    assert.equal(reason(rowsFrom({ ...askParts(), question: ['Which?'], options: ['❯ 2. acme-api', '  3. web-shop', '  4. Type something.'] })), 'numbers');
  });

  test('(−) numbers: a button row in a single-select question, and a multi question without one', () => {
    const single = askParts();
    assert.equal(reason(rowsFrom({ ...single, options: [...single.options, '     Next'] })), 'numbers');
    const multi = askParts({ multi: true, options: CHECKS });
    assert.equal(reason(rowsFrom({ ...multi, options: multi.options.slice(0, -1) })), 'numbers');
  });

  test('(−) tab: none of the tab tokens is marked, or two are, or a token is marked in part', () => {
    assert.equal(reason(ask({ mark: 'none' })), 'tab');
    assert.equal(reason(ask({ current: [0, 1] })), 'tab');
    assert.equal(reason(ask({ current: [] })), 'tab');
    const rows = ask();
    const at = rowAt(rows, (t) => t.includes('Project') && t.includes('Tools'));
    rows[at] = rows[at].map((sp) => (sp.t === ' ☐ Project ' ? [span(' ☐ Pro', MARK.bg), span('ject ')] : [sp])).flat();
    assert.equal(reason(rows), 'tab');
  });

  test('(−) tab: the Submit token is marked on a question step, or not marked on the review', () => {
    assert.equal(reason(ask({ current: ['submit'] })), 'tab');
    assert.equal(reason(rowsFrom(reviewParts({ current: 0 }))), 'tab');
    assert.equal(reason(rowsFrom(reviewParts({ mark: 'none' }))), 'tab');
  });

  test('(−) layout: duplicate labels, a label that is a placeholder, a glyph in a header or label', () => {
    assert.equal(reason(ask({ options: [OPTS[0], { ...OPTS[1], label: 'acme-api' }] })), 'layout');
    assert.equal(reason(ask({ options: [OPTS[0], { ...OPTS[1], label: 'Chat about this' }] })), 'layout');
    assert.equal(reason(ask({ options: [OPTS[0], { ...OPTS[1], label: 'Type something.' }] })), 'layout');
    assert.equal(reason(ask({ tabs: ['Project', 'A☒B'] })), 'layout');
    assert.equal(reason(ask({ options: [OPTS[0], { ...OPTS[1], label: 'web ☐ shop' }] })), 'layout');
    assert.equal(reason(ask({ tabs: ['Project', 'A ☒ B'] })), 'layout', 'a glyph token one space after another cannot be a second tab');
  });

  test('(−) layout: a status glyph in the question (review M1)', () => {
    for (const q of ['Pick ☐ or ☒ ?', 'Which ✔ project?', 'Which project☒?']) assert.equal(reason(ask({ question: q })), 'layout', q);
    assert.equal(read(ask({ question: 'Which project should I open?' })).question, 'Which project should I open?');
  });

  test('(−) layout: a rule row or a strip-like row among the question rows could be taken for the real ones (review M4)', () => {
    assert.equal(reason(ask({ question: ['Which project should I open?', '─'.repeat(30)] })), 'layout', 'a rule row');
    assert.equal(reason(ask({ question: ['Which project should I open?', '── notes ──'] })), 'layout', 'a labelled rule row');
    assert.equal(reason(ask({ question: ['Which project should I open?', ' ☐ Notes  ☐ More'] })), 'layout', 'a strip-like row');
    assert.equal(reason(ask({ question: ['Which project should I open?', 'It has a dash - in it.'] })), undefined, 'ordinary rows still read');
  });

  test('(−) layout: the footer and the strip disagree, or a multi / several-tab strip has no Submit', () => {
    assert.equal(reason(ask({ nav: '↑/↓' })), 'layout', 'up/down hint with two tabs');
    assert.equal(reason(ask({ tabs: ['Project'], nav: 'Tab/Arrow keys' })), 'layout', 'one tab, no Submit, Tab hint');
    assert.equal(reason(ask({ tabs: ['Tools'], multi: true, options: CHECKS, submit: false })), 'layout', 'multi without Submit');
    assert.equal(reason(ask({ tabs: ['Project', 'Tools'], submit: false })), 'layout', 'two tabs without Submit');
  });

  test('(−) layout: a header, label, question, description or answer over its maximum', () => {
    assert.equal(reason(ask({ tabs: ['Project', 'h'.repeat(HEADER_MAX + 1)] })), 'layout');
    assert.equal(read(ask({ tabs: ['Project', 'h'.repeat(HEADER_MAX)] })).tabs[1].header.length, HEADER_MAX);
    assert.equal(reason(ask({ cols: 400, options: [{ label: 'l'.repeat(LABEL_MAX + 1), desc: 'd' }, OPTS[1]] }), 400), 'layout');
    assert.equal(reason(ask({ cols: 800, question: 'q'.repeat(QUESTION_MAX + 1) }), 800), 'layout');
    assert.equal(reason(ask({ cols: 800, options: [{ label: 'a', desc: 'd'.repeat(DESC_MAX + 1) }, OPTS[1]] }), 800), 'layout');
    assert.equal(reason(rowsFrom(reviewParts({ cols: 800, pairs: [{ q: 'Which?', a: 'a'.repeat(ANSWER_MAX + 1) }] })), 800), 'layout');
    assert.equal(read(ask({ cols: 800, question: 'q'.repeat(QUESTION_MAX) }), 800).question.length, QUESTION_MAX);
  });

  test('(−) layout: a mix of checkbox and plain labels, an unknown row among the options, two pointers, a blank row inside the list', () => {
    const multi = askParts({ multi: true, options: CHECKS });
    assert.equal(reason(rowsFrom({ ...multi, options: multi.options.map((r) => (text(r).includes('[ ] test') ? [span('  2. test')] : r)) })), 'layout');
    const single = askParts();
    assert.equal(reason(rowsFrom({ ...single, options: [...single.options.slice(0, 2), '  stray row at indent two', ...single.options.slice(2)] })), 'layout');
    assert.equal(reason(rowsFrom({ ...single, options: single.options.map((r) => (text(r).startsWith('  2.') ? [span('❯ 2. web-shop')] : r)) })), 'layout');
    assert.equal(reason(rowsFrom({ ...single, options: [...single.options.slice(0, 2), '', ...single.options.slice(2)] })), 'layout');
    assert.equal(reason(rowsFrom({ ...single, options: single.options.map((r) => (text(r).includes('Open the acme-api') ? [span('      Open the acme-api project.')] : r)) })), 'layout', 'a description at the wrong indent');
  });

  test('(−) layout: the button label does not match the tab (Submit belongs to the last tab, Next to any other)', () => {
    assert.equal(reason(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS, button: 'Submit' })), 'layout');
    assert.equal(reason(ask({ tabs: ['Project', 'Tools'], current: 1, multi: true, options: CHECKS, button: 'Next' })), 'layout');
  });

  test('(−) layout: the review disagrees with its strip: a pair count other than the answered tabs, a warning with every tab answered, none with a tab open (review M4)', () => {
    const one = [{ q: 'Which project should I open?', a: 'web-shop' }];
    assert.equal(reason(rowsFrom(reviewParts({ answered: [0, 1], pairs: one }))), 'layout', 'two answered tabs, one pair');
    assert.equal(reason(rowsFrom(reviewParts({ answered: [0], warn: true }))), 'layout', 'one answered tab, two pairs');
    assert.equal(reason(rowsFrom(reviewParts({ answered: [0, 1], warn: true }))), 'layout', 'a warning with every tab answered');
    assert.equal(reason(rowsFrom(reviewParts({ answered: [0], pairs: one }))), 'layout', 'a tab still open and no warning');
    assert.equal(read(rowsFrom(reviewParts({ answered: [0], warn: true, pairs: one }))).at, 'review', 'consistent: read');
    assert.equal(read(rowsFrom(reviewParts())).at, 'review', 'consistent: read');
  });

  test('(−) layout: the review lacks its heading, the question, or has a pair without an answer, or a stray row', () => {
    assert.equal(dialogOnScreen(rowsFrom({ ...reviewParts(), heading: [] })), false, 'without the heading it is not recognised at all');
    // QP1, changed on purpose. Old: `assert.equal(reason(rowsFrom({ ...reviewParts(), ready: [] })), 'layout')`. This fixture is the 2.1.328 shape (no Ready
    // row, the options after the answers), which now reads; the old intent (no Ready row and no column-0 options) is the next test.
    assert.equal(read(rowsFrom({ ...reviewParts(), ready: [] })).at, 'review', 'no Ready row, options at column 0: the 2.1.328 shape');
    const noAnswer = reviewParts();
    assert.equal(reason(rowsFrom({ ...noAnswer, pairs: [[span(' ● Which project should I open?')]] })), 'layout');
    assert.equal(reason(rowsFrom({ ...noAnswer, pairs: [...noAnswer.pairs, [span('stray')]] })), 'layout');
    assert.equal(reason(rowsFrom({ ...noAnswer, submit: ['❯ 1. Send answers'] })), 'layout');
  });

  test('(\u2212) layout (QP1): a Review with no Ready row ends only at a column-0 `1.` option: the options indented, or no Submit answers option, are refused', () => {
    const v = (o) => ({ ...reviewParts({ v328: true }), ...o });
    assert.equal(read(rowsFrom(v())).at, 'review', 'control: the 2.1.328 shape reads');
    assert.equal(reason(rowsFrom(v({ submit: ['    1. Submit answers'], cancel: ['    2. Cancel'] }))), 'layout', 'both options indented 4');
    assert.equal(reason(rowsFrom(v({ submit: ['   1. Submit answers'] }))), 'layout', 'Submit answers indented 3 (an answer continuation, not an option)');
    assert.equal(reason(rowsFrom(v({ submit: ['    \u276f 1. Submit answers'] }))), 'layout', 'Submit answers indented 4 with the pointer');
    assert.equal(reason(rowsFrom(v({ submit: [] }))), 'layout', 'Cancel only (the 2.1.328 shape)');
    assert.equal(reason(rowsFrom(v({ submit: [], cancel: ['\u276f 2. Cancel'] }))), 'layout', 'Cancel only, with the pointer');
    assert.equal(reason(rowsFrom({ ...reviewParts(), submit: [] })), 'layout', 'Cancel only (the 2.1.326 shape, unchanged)');
    assert.equal(reason(rowsFrom(v({ submit: ['\u276f 1. Send answers'] }))), 'layout', 'another label');
    assert.equal(reason(rowsFrom({ ...reviewParts(), ready: [], submit: ['    1. Submit answers'], cancel: ['    2. Cancel'] })), 'layout', 'the old intent of the test above: no Ready row and the options indented');
  });

  test('(\u2212) layout (QP1): an answer continuation row that reads `1. Submit answers` with 3 leading spaces stays an answer, not the end of the pairs', () => {
    for (const v328 of [true, false]) {
      const rows = rowsFrom(reviewParts({ v328 }));
      rows.splice(rowAt(rows, (t) => t.includes('\u2192 web-shop')) + 1, 0, [span('   1. Submit answers')]);
      const S = read(rows);
      assert.equal(S.at, 'review', `v328 ${v328}`);
      assert.deepEqual(S.pairs[0], { question: 'Which project should I open?', answer: 'web-shop 1. Submit answers' }, `v328 ${v328}: the row is part of the answer`);
      assert.equal(S.pairs.length, 2, `v328 ${v328}: the second pair is still read`);
      assert.equal(S.focus, 1, `v328 ${v328}: the real option rows are the ones read`);
    }
  });

  test('(\u2212) QP1: a column-0 `2.` row among the pairs is a stray row (reading goes on), not the end of the pairs', () => {
    // Reading goes on past the stray row (it adds `layout`), so a clipped answer after it still reports `clipped`, which outranks `layout` in REASONS.
    // A reader that ended the pairs at any column-0 option row would stop there and report `layout`.
    const cut = `web-shop and more${String.fromCharCode(0x2026)}`;
    for (const v328 of [true, false]) {
      const rows = rowsFrom(reviewParts({ v328, pairs: [{ q: 'Which project should I open?', a: cut }, { q: 'Which checks should I run?', a: 'lint' }] }));
      assert.equal(reason(rows), 'clipped', `v328 ${v328}: control, no stray row`);
      rows.splice(rowAt(rows, (t) => t.includes(cut)) + 1, 0, [span('  2. Cancel')]);
      assert.equal(reason(rows), 'clipped', `v328 ${v328}: the stray row is refused, and reading went on to the clipped answer`);
      rows.splice(rowAt(rows, (t) => t.includes(cut)), 1, [span('   \u2192 web-shop')]);
      assert.equal(reason(rows), 'layout', `v328 ${v328}: the stray row alone is a layout`);
    }
  });

  test('(−) layout: a plan without its introduction, with a stray row between the rule and the prompt, or with the text option not last', () => {
    assert.equal(reason(rowsFrom({ ...planParts(), intro: [] })), 'layout');
    assert.equal(reason(rowsFrom({ ...planParts(), fill: ['   something unexpected'] })), 'layout');
    const p = planParts();
    assert.equal(reason(rowsFrom({ ...p, options: [p.options[0], p.options[2], p.options[3], p.options[1]] })), 'numbers');
  });

  test('(−) numbers: a plan with a single option, or numbered with a gap', () => {
    assert.equal(reason(rowsFrom({ ...planParts(), options: ['   ❯ 1. Yes, and use auto mode'] })), 'numbers');
    assert.equal(reason(rowsFrom({ ...planParts(), options: ['   ❯ 1. Yes', '     3. No'] })), 'numbers');
  });

  test('(−) survey: a feedback survey on screen (it takes digits) wins over a readable dialog', () => {
    const rows = ask({ above: ['How is Claude doing this session? (optional)', '  1: Bad    2: Fine    3: Good    0: Dismiss'] });
    assert.equal(reason(rows), 'survey');
    assert.equal(dialogCapture(rows, COLS).reason, 'survey');
    assert.equal(reason(rowsFrom({ ...planParts(), above: ['How is Claude doing this session? (optional)'] })), 'survey');
  });

  test('(−) survey (M1): Claude\'s post-rating row "(Optional) Press [1] to tell us more" (a 1 there opens /feedback) also wins over a readable dialog; the Thanks row alone and a quote do not', () => {
    const AFTER = ['Thanks for the feedback!', '(Optional) Press [1] to tell us more · /feedback'];
    assert.equal(reason(ask({ above: AFTER })), 'survey');
    assert.equal(dialogCapture(ask({ above: AFTER }), COLS).reason, 'survey');
    assert.equal(reason(ask({ above: [AFTER[1]] })), 'survey', 'the row alone');
    assert.equal(reason(rowsFrom({ ...planParts(), above: ['(Optional) Press [1] to tell us more'] })), 'survey', 'a plan too, the words alone');
    assert.equal(reason(ask({ above: [AFTER[0]] })), undefined, 'the Thanks row alone is a model line: the dialog reads');
    assert.equal(reason(ask({ above: ['Claude said: (Optional) Press [1] to tell us more'] })), undefined, 'a quote mid-row');
  });

  test('(−) the first failing rule decides, in the order of REASONS (cut before clipped before wide before numbers before tab before layout before survey)', () => {
    const cutAndWide = ask({ cols: 70, tabs: ['Project', 'To…'], footer: ['Enter to select · Tab/Arrow keys to navigate', '· Esc to cancel'] });
    assert.equal(reason(cutAndWide, 70), 'clipped');
    assert.equal(reason(rowsFrom({ ...askParts({ cols: 70, tabs: ['Project', 'To…'] }), top: [''] }), 70), 'cut');
    // RV16 M1 (round 1): a clipped top beats a wrapped footer (`wide`): the page grows only on `cut`, so this decides whether a narrow panel grows
    const wrapped = ['Enter to select · Tab/Arrow keys to navigate', '· Esc to cancel'];
    assert.equal(reason(ask({ cols: 70, footer: wrapped }), 70), 'wide', 'the wrapped footer alone');
    assert.equal(reason(rowsFrom({ ...askParts({ cols: 70, footer: wrapped }), top: [''] }), 70), 'cut', 'with the top clipped too');
    const wideAndTab = ask({ cols: 70, mark: 'none', footer: ['Enter to select · Tab/Arrow keys to navigate', '· Esc to cancel'] });
    assert.equal(reason(wideAndTab, 70), 'wide');
    assert.equal(reason(ask({ mark: 'none', options: [OPTS[0], { ...OPTS[1], label: 'acme-api' }] })), 'tab');
  });

  test('(−) the kind of an unreadable dialog says ask or plan; the shapes nika never reads say null', () => {
    assert.equal(read(ask({ mark: 'none' })).kind, 'ask');
    assert.equal(read(rowsFrom({ ...planParts(), d1: [] })).kind, 'plan');
    assert.equal(read(rowsFrom(exitParts())).kind, null);
  });

  test('(−) never throws on junk rows or an odd span', () => {
    for (const rows of [[], [[]], [[{}]], [[{ t: 5 }]], [[{ t: 'Enter to select · ↑/↓ to navigate', s: null }]], [null, undefined]]) {
      assert.doesNotThrow(() => { readDialogScreen(rows, COLS); dialogCapture(rows, COLS); dialogOnScreen(rows); });
    }
    const odd = ask();
    odd[rowAt(odd, (t) => t.includes('Project') && t.includes('Tools'))] = [{ t: '←  ☐ Project  ☐ Tools  ✔ Submit  →' }];
    assert.equal(reason(odd), 'tab', 'a span without a style marks nothing');
  });
});

describe('dialogCapture (design W1 3)', () => {
  test('(+) a question step: the ready shape, with a checked mark on every option', () => {
    const c = dialogCapture(ask(), COLS);
    assert.deepEqual(c, {
      state: 'ready', kind: 'ask', at: 'question', sig: sigOf(read(ask())), bypass: false, top: 2,
      tabs: [{ header: 'Project', answered: false }, { header: 'Tools', answered: false }], current: 0, final: false, question: 'Which project should I open?', multi: false, other: true,
      options: [{ n: 1, label: 'acme-api', description: 'Open the acme-api project.', checked: false }, { n: 2, label: 'web-shop', description: 'Open the web-shop project.', checked: false }, { n: 3, label: 'demo-api', description: 'Open the demo-api project.', checked: false }],
      typed: null,
    });
    const m = dialogCapture(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS, checks: [2] }), COLS);
    assert.equal(m.multi, true);
    assert.equal(m.other, false, 'a multi question that is not on the last tab');
    assert.deepEqual(m.options.map((o) => o.checked), [false, true, false]);
  });

  test('(+) final: a single tab with a single-select question', () => {
    assert.equal(dialogCapture(ask({ tabs: ['Project'] }), COLS).final, true);
    assert.equal(dialogCapture(ask({ tabs: ['Project', 'Tools'] }), COLS).final, false);
    assert.equal(dialogCapture(ask({ tabs: ['Tools'], multi: true, options: CHECKS, button: 'Submit' }), COLS).final, false);
  });

  test('(+) the review and the plan shapes', () => {
    const r = dialogCapture(rowsFrom(reviewParts({ warn: true, answered: [0], pairs: [{ q: 'Which project should I open?', a: 'web-shop' }] })), COLS);
    assert.deepEqual(Object.keys(r), ['state', 'kind', 'at', 'sig', 'bypass', 'top', 'tabs', 'warn', 'pairs']);
    assert.equal(r.warn, true);
    const p = dialogCapture(rowsFrom(planParts()), COLS);
    assert.deepEqual(p.options[2], { n: 3, label: 'Tell Claude what to change', text: true });
    assert.deepEqual(Object.keys(p), ['state', 'kind', 'at', 'sig', 'bypass', 'top', 'options']);
    assert.equal(p.kind, 'plan');
  });

  test('(+) bypass is carried; the plan prose and the typed text are not', () => {
    assert.equal(dialogCapture(ask({ question: 'Allow bypass?' }), COLS).bypass, true);
    const p = dialogCapture(rowsFrom(planParts({ focus: 3, value: 'typed secret' })), COLS);
    assert.equal(JSON.stringify(p).includes('typed secret'), false);
    assert.equal(JSON.stringify(p).includes('single word'), false);
  });

  test('(−) null with no dialog; unreadable shapes carry the kind and the reason only', () => {
    assert.equal(dialogCapture(boxRows({ cols: COLS }).rows, COLS), null);
    assert.equal(dialogCapture([], COLS), null);
    assert.deepEqual(dialogCapture(ask({ mark: 'none' }), COLS), { state: 'unreadable', kind: 'ask', reason: 'tab' });
    assert.deepEqual(dialogCapture(rowsFrom({ ...planParts(), d1: [] }), COLS), { state: 'unreadable', kind: 'plan', reason: 'cut' });
  });

  test('(−) every string in a ready capture is clean: no control characters, bounded', () => {
    const c = dialogCapture(ask({ question: 'Which\u0007 project\u009b?', options: [{ label: 'acme\u200b-api', desc: 'Open\u001b[31m it.' }, OPTS[1]] }), COLS);
    const all = JSON.stringify(c);
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u200b]/.test(all), false);
    assert.equal(c.options[0].label, 'acme -api');
  });
});

// ---- 0.5.1 E: `top`, the screen row a crop of the terminal view starts at (display only; never part of sig or identity) -------------------------------
describe('dialogCapture: top (0.5.1 E)', () => {
  const isRule = (rows, x) => /^ *─+ *$/.test(text(rows[x]));
  /** The strip row of a question or review fixture: the row with a tab token of the first tab. */
  const stripAt = (rows) => rowAt(rows, (t) => /[☐☒] (?:Project|Tools)/.test(t));
  const planPromptAt = (rows) => rowAt(rows, (t) => t.includes('Claude has written up a plan'));
  // sigOf of the default fixtures as the code computed them before `top` existed: adding the field must not move them.
  const PIN = { question: '5a9df54a8c7b5ef8', review: 'fd92069bce804954', plan: 'e5cec1b227b8a3e7' };

  test('(+) a question step: top is the rule row directly above the tab strip, for every tab shape and any rows around it', () => {
    const shapes = {
      'several tabs': {}, 'one tab': { tabs: ['Project'] }, 'multi, last tab': { tabs: ['Tools', 'Project'], multi: true, options: CHECKS, current: 1, button: 'Submit' },
      'long transcript above': { above: ['⏺ one', '', '⏺ two', '', '⏺ three', ''] }, 'no row above the rule': { above: [] },
    };
    for (const [name, o] of Object.entries(shapes)) {
      for (const shape of [undefined, { pad: true, trail: 3 }, { tree: 2 }]) {
        const rows = ask(o, shape);
        const c = dialogCapture(rows, COLS);
        assert.equal(c.state, 'ready', name);
        assert.equal(c.top, stripAt(rows) - 1, `${name} ${JSON.stringify(shape)}`);
        assert.equal(isRule(rows, c.top), true, `${name}: the row at top is the rule`);
        assert.equal(read(rows).top, c.top, `${name}: the step carries the same row`);
      }
    }
  });

  test('(+) the review step: top is the rule row directly above the strip, with or without the warning and the brackets', () => {
    for (const o of [{}, { warn: true, answered: [0], pairs: [{ q: 'Which project should I open?', a: 'web-shop' }] }, { bracket: true }]) {
      for (const shape of [undefined, { pad: true, trail: 2 }]) {
        const rows = rowsFrom(reviewParts(o), shape);
        const c = dialogCapture(rows, COLS);
        assert.equal(c.at, 'review');
        assert.equal(c.top, stripAt(rows) - 1, JSON.stringify(o));
        assert.equal(isRule(rows, c.top), true);
      }
    }
  });

  test('(+) the plan approval: top is the plain rule row under the closing dashed rule, so the whole plan stays above it', () => {
    for (const o of [{}, { blanks: 0 }, { blanks: 20 }, { prose: ['- one', '- two', '', '- three'] }, { focus: 3, value: 'typed words' }]) {
      for (const shape of [undefined, { pad: true, trail: 4 }, { tree: 1 }]) {
        const rows = rowsFrom(planParts(o), shape);
        const c = dialogCapture(rows, COLS);
        assert.equal(c.at, 'plan', JSON.stringify(o));
        assert.equal(c.top, planPromptAt(rows) - 1, `${JSON.stringify(o)} ${JSON.stringify(shape)}`);
        assert.equal(/^ *─+ *$/.test(text(rows[c.top])), true, 'a plain rule');
        const lastPlanRow = rows.findLastIndex((r, x) => x < c.top && /^ *╌+ *$/.test(text(r)));
        assert.ok(lastPlanRow > 0 && lastPlanRow < c.top, 'the closing dashed rule is above the cut');
        assert.ok(rowAt(rows, (t) => t.includes('Here is Claude')) < c.top, 'the intro is above the cut');
        assert.ok(rowAt(rows, (t) => t.includes('Ready to code?')) < c.top, 'the title is above the cut');
      }
    }
  });

  test('(+) top is an integer from 1 to the last row on every ready fixture (a crop of 0 would draw nothing)', () => {
    for (const rows of [ask(), ask({ tabs: ['Project'] }), rowsFrom(reviewParts()), rowsFrom(planParts())]) {
      const c = dialogCapture(rows, COLS);
      assert.ok(Number.isInteger(c.top) && c.top >= 1 && c.top < rows.length, `${c.at}: ${c.top}`);
    }
  });

  test('(+) top is the second key group of the ready object: after bypass, before the dialog fields', () => {
    assert.deepEqual(Object.keys(dialogCapture(ask(), COLS)).slice(0, 6), ['state', 'kind', 'at', 'sig', 'bypass', 'top']);
    assert.deepEqual(Object.keys(dialogCapture(rowsFrom(reviewParts()), COLS)).slice(0, 6), ['state', 'kind', 'at', 'sig', 'bypass', 'top']);
    assert.deepEqual(Object.keys(dialogCapture(rowsFrom(planParts()), COLS)).slice(0, 6), ['state', 'kind', 'at', 'sig', 'bypass', 'top']);
  });

  test('(−) an unreadable dialog and no dialog carry no top', () => {
    for (const rows of [ask({ mark: 'none' }), rowsFrom({ ...planParts(), d1: [] }), nudgeScreen().rows, ask({ tabs: Array(9).fill('T') })]) {
      const c = dialogCapture(rows, COLS);
      assert.equal(c.state, 'unreadable');
      assert.equal('top' in c, false, c.reason);
      assert.equal('top' in read(rows), false, 'the reader returns no step either');
    }
    assert.equal(dialogCapture(boxRows({ cols: COLS }).rows, COLS), null);
  });

  test('(−) sig and identity do not change: top is in neither, so rows above the dialog never move them', () => {
    assert.equal(sigOf(read(ask())), PIN.question);
    assert.equal(sigOf(read(rowsFrom(reviewParts()))), PIN.review);
    assert.equal(sigOf(read(rowsFrom(planParts()))), PIN.plan);
    const low = ask({ above: ['⏺ I have a question first.', '', '⏺ more', '', '⏺ still more', ''] });
    assert.notEqual(dialogCapture(low, COLS).top, dialogCapture(ask(), COLS).top, 'the cut moved');
    assert.equal(dialogCapture(low, COLS).sig, dialogCapture(ask(), COLS).sig, 'the sig did not');
    assert.equal(identityOf(read(low)), identityOf(read(ask())), 'the identity is the same string');
    for (const rows of [ask(), rowsFrom(reviewParts()), rowsFrom(planParts())]) assert.equal(identityOf(read(rows)).includes('"top"'), false);
  });

  test('(−) a bypass dialog still says so, and top does not stand in for the guard', () => {
    const c = dialogCapture(ask({ question: 'Allow bypass?' }), COLS);
    assert.equal(c.bypass, true);
    assert.ok(Number.isInteger(c.top), 'the page, not the server, decides to withhold a crop from a bypass dialog');
  });
});

describe('source hygiene', () => {
  test('(−) src/dialog.js is pure ASCII, pure (no I/O imports) and holds no home path', () => {
    const src = fs.readFileSync(new URL('../src/dialog.js', import.meta.url), 'utf8');
    assert.equal(/[^\x00-\x7f]/.test(src), false, 'every symbol is an escape');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['node:crypto', './text.js', './draft.js', './mode.js']);
    assert.equal(/\b(?:fs|child_process|net|http)\b/.test(src.replace(/^\/\/.*$/gm, '')), false);
  });

  test('(−) src/mode.js stays ASCII after the dialog additions', () => {
    assert.equal(/[^\x00-\x7f]/.test(fs.readFileSync(new URL('../src/mode.js', import.meta.url), 'utf8')), false);
  });
});

// ---- 0.5.1 D: stripOf (where Claude's dialog stands in its strip) and the capture's `checked` and `typed` ------------------------------------------

describe('stripOf (0.5.1, D)', () => {
  const T3 = ['Project', 'Tools', 'Scope'];
  const strip3 = (o = {}, shape) => stripOf(ask({ tabs: T3, ...o }, shape), COLS);
  const NONE = { input: false, insert: false, bypass: false };

  test('(+) tab 0, 1 and 2 of a 3-tab form: where it stands, the headers, the answered marks, and nothing else', () => {
    for (const at of [0, 1, 2]) {
      const T = strip3({ current: at, answered: at === 0 ? [] : [0] });
      assert.deepEqual(T, { at, n: 3, headers: T3, answered: [at !== 0, false, false], ...NONE }, `tab ${at}`);
    }
  });

  test('(+) the review step: at is the number of questions, with the Submit token marked', () => {
    const rows = rowsFrom(reviewParts({ tabs: T3, answered: [0, 1, 2], pairs: T3.map((h) => ({ q: `Question ${h}?`, a: 'yes' })) }));
    assert.deepEqual(stripOf(rows, COLS), { at: 3, n: 3, headers: T3, answered: [true, true, true], ...NONE });
    const bracket = rowsFrom(reviewParts({ tabs: T3, answered: [0, 1, 2], bracket: true, pairs: T3.map((h) => ({ q: `Question ${h}?`, a: 'yes' })) }));
    assert.equal(stripOf(bracket, COLS)?.at, 3, 'the bracketed Submit token');
  });

  test('(+) input is true while the focus is on the text row, Chat or a multi question\'s Next button (the ctrl+g footer); false on an option row', () => {
    assert.equal(strip3({ focus: 1 }).input, false);
    assert.equal(strip3({ focus: 3 }).input, false, 'the last option');
    assert.equal(strip3({ focus: 4 }).input, true, 'the text row (option k + 1)');
    assert.equal(strip3({ focus: 5, ctrl: true }).input, true, 'Chat about this');
    const multi = { tabs: ['Tools', 'Scope'], multi: true, options: CHECKS };
    assert.equal(stripOf(ask({ ...multi, focus: 1 }), COLS).input, false);
    assert.equal(stripOf(ask({ ...multi, focus: 'button' }), COLS).input, true, 'Next');
  });

  test('(+) insert is true with the vim INSERT prefix in the footer, and false without it', () => {
    const T = strip3({ focus: 4, insert: true });
    assert.deepEqual([T.insert, T.input], [true, true]);
    assert.equal(strip3({ focus: 4 }).insert, false);
    assert.equal(strip3({ focus: 1 }).insert, false);
  });

  test('(+) the answered marks come from the strip, one per tab', () => {
    assert.deepEqual(strip3({ current: 2, answered: [0, 1] }).answered, [true, true, false]);
    assert.deepEqual(strip3({ current: 1, answered: [2] }).answered, [false, false, true]);
  });

  test('(+) a step whose options are clipped (the step itself is unreadable) still gives the strip', () => {
    const rows = ask({ tabs: T3, current: 1, options: [{ label: 'acme-api…', desc: 'Open it.' }, OPTS[1], OPTS[2]] });
    assert.equal(reason(rows), 'clipped', 'premise: the step is not readable');
    assert.deepEqual(stripOf(rows, COLS), { at: 1, n: 3, headers: T3, answered: [false, false, false], ...NONE });
  });

  test('(+) padded rows, trailing blank rows and a subagent list under the footer do not matter', () => {
    for (const shape of [{ pad: true }, { trail: 3 }, { tree: 2 }, { pad: true, tree: 3 }, { pad: true, trail: 2 }]) assert.equal(strip3({ current: 1 }, shape)?.at, 1, JSON.stringify(shape));
  });

  test('(+) bypass uses the dialog\'s rule: a mention in the question', () => {
    assert.equal(strip3({ question: 'Allow bypass permissions?' }).bypass, true);
    assert.equal(strip3({}).bypass, false);
  });

  test('(−) null for no dialog, a plan, a permission prompt, the exit and nudge shapes, an empty screen and non-rows', () => {
    const permission = [lineOf('Do you want to proceed?'), lineOf('❯ 1. Yes'), lineOf('  2. No'), lineOf('Esc to cancel')];
    for (const rows of [boxRows({ cols: COLS }).rows, rowsFrom(planParts()), permission, rowsFrom(exitParts()), nudgeScreen().rows, [], null, undefined, 'x']) {
      assert.equal(stripOf(rows, COLS), null);
    }
  });

  test('(−) null for a one-question form: the single-select one has no strip, the multi one has only itself and the Submit token', () => {
    assert.equal(stripOf(ask({ tabs: ['Project'] }), COLS), null);
    assert.equal(stripOf(ask({ tabs: ['Tools'], multi: true, options: CHECKS, button: 'Submit' }), COLS), null);
    assert.equal(stripOf(rowsFrom(reviewParts({ tabs: ['Project'], answered: [0], pairs: [{ q: 'Which project should I open?', a: 'web-shop' }] })), COLS), null);
  });

  test('(−) null for two marked tokens, none marked, a half-marked token, and a review whose Submit token is not the marked one', () => {
    assert.equal(strip3({ current: [0, 1] }), null, 'two marked');
    assert.equal(strip3({ mark: 'none' }), null, 'none marked');
    assert.equal(strip3({ current: [1, 'submit'] }), null, 'a tab and the Submit token');
    const review = (o) => stripOf(rowsFrom(reviewParts({ tabs: T3, answered: [0, 1, 2], pairs: T3.map((h) => ({ q: `Question ${h}?`, a: 'yes' })), ...o })), COLS);
    assert.equal(review({ current: 0 }), null, 'the review with a question tab marked');
    assert.equal(review({ current: [0, 'submit'] }), null, 'both');
    assert.equal(review({ mark: 'none' }), null, 'none');
  });

  test('(−) null for an unknown footer, a wrapped footer, a footer that disagrees with the strip, and a pane too narrow to read', () => {
    assert.equal(strip3({ footer: 'Enter to select' }), null, 'an unknown footer');
    assert.equal(strip3({ footer: ['Enter to select · Tab/Arrow keys to', 'navigate · Esc to cancel'] }), null, 'wrapped over two rows');
    assert.equal(strip3({ nav: '↑/↓' }), null, 'up/down arrows in the footer mean one question');
    assert.equal(stripOf(ask({ tabs: T3 }), 10), null, 'narrower than the reader reads');
    for (const cols of [undefined, null, '120', NaN]) assert.equal(stripOf(ask({ tabs: T3 }), cols), null, String(cols));
  });

  test('(−) null for a header that is empty, too long, or holds a checkbox glyph; nine tabs', () => {
    assert.equal(stripOf(ask({ tabs: ['Project', 'x'.repeat(HEADER_MAX + 1)] }), COLS), null);
    assert.equal(stripOf(ask({ tabs: ['Project', 'To☐ls'] }), COLS), null);
    const names = (n) => Array.from({ length: n }, (_, i) => `T${i}`);
    assert.equal(stripOf(ask({ tabs: names(TABS_MAX + 1), submit: false }), COLS), null, 'nine tabs');
    assert.equal(stripOf(ask({ tabs: names(TABS_MAX), submit: false }), COLS)?.n, TABS_MAX, 'eight tabs');
  });

  test('(−) null when the rule above the strip is off the screen (the strip is its first row)', () => {
    const rows = ask({ tabs: T3 });
    const x = rows.findIndex((r) => r.some((sp) => sp.t.includes(' \u2610 Project ')));
    assert.equal(stripOf(rows.slice(x - 1), COLS)?.at, 0, 'control: the rule row is kept');
    assert.equal(stripOf(rows.slice(x), COLS), null);
  });

  test('(−) null for a plan or a permission prompt that carries a strip-like row: the strip is read from a question dialog only', () => {
    const withStrip = {};
    for (const [k, v] of Object.entries(planParts())) {
      if (k === 'footer') Object.assign(withStrip, { rule3: [[span('\u2500'.repeat(COLS), DIM)]], strip: [strip({ tabs: T3, current: 0 })] });
      withStrip[k] = v;
    }
    const planRows = rowsFrom(withStrip);
    assert.equal(dialogOnScreen(planRows), true, 'premise: the plan is still a dialog');
    assert.equal(stripOf(planRows, COLS), null, 'a plan');
    const permission = [lineOf('Do you want to proceed?'), lineOf('❯ 1. Yes'), lineOf('  2. No'), lineOf('Esc to cancel')];
    assert.notEqual(promptFromRows([...ask({ tabs: T3 }), ...permission]), null, 'premise: the prompt parses under the dialog');
    assert.equal(stripOf([...ask({ tabs: T3 }), ...permission], COLS), null, 'a permission prompt under the dialog');
  });

  test('(−) null for a tab token that is only partly marked, and a review with no Submit token', () => {
    const half = ask({ tabs: T3, current: 0 }).map((r) => (r.some((sp) => sp.t === ' \u2610 Tools ') ? r.flatMap((sp) => (sp.t === ' \u2610 Tools ' ? [span(' \u2610 ', MARK.bg), span('Tools ')] : [sp])) : r));
    assert.equal(half.some((r) => r.some((sp) => sp.t === 'Tools ')), true, 'premise: the token is split');
    assert.equal(stripOf(half, COLS), null);
    const noSubmit = { ...reviewParts({ tabs: T3, answered: [0, 1, 2], pairs: T3.map((h) => ({ q: `Question ${h}?`, a: 'yes' })) }), strip: [strip({ tabs: T3, current: 'submit', answered: [0, 1, 2], submit: false, mark: 'none' })] };
    assert.equal(stripOf(rowsFrom(noSubmit), COLS), null);
  });

  test('(+) bypass: a mention far above the last 15 rows still counts (the strip-to-footer window), and so does one in a list under the footer (the last-15 window)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `option-${i + 1}`, desc: `Pick option-${i + 1}.` }));
    const tall = ask({ tabs: T3, question: 'Allow bypass permissions?', options: many });
    assert.equal(bypassWindow(tall), false, 'premise: the last 15 rows do not show it');
    assert.equal(stripOf(tall, COLS).bypass, true, 'the question');
    const tree = rowsFrom(askParts({ tabs: T3 }), { tree: 0 }).concat(subagentRows({ agents: [{ label: 'bypass permissions check' }] }));
    assert.equal(bypassWindow(tree), true, 'premise: the last 15 rows show it');
    assert.equal(stripOf(tree, COLS).bypass, true, 'the list under the footer');
  });

  test('(−) the result holds exactly the seven fields and shares nothing with the screen', () => {
    const T = strip3({});
    assert.deepEqual(Object.keys(T), ['at', 'n', 'headers', 'answered', 'input', 'insert', 'bypass']);
    T.headers.push('x');
    assert.deepEqual(strip3({}).headers, T3);
  });
});

describe('dialogCapture: checked on every option and typed (0.5.1, D)', () => {
  const tickedRow = (rows, from, to) => rows.map((r) => r.map((sp) => ({ ...sp, t: sp.t.replace(from, to) })));

  test('(+) single-select options carry checked, true on the ticked one', () => {
    assert.deepEqual(dialogCapture(ask({ ticks: [2] }), COLS).options.map((o) => o.checked), [false, true, false]);
    assert.deepEqual(dialogCapture(ask({ ticks: [] }), COLS).options.map((o) => o.checked), [false, false, false]);
    assert.deepEqual(Object.keys(dialogCapture(ask(), COLS).options[0]), ['n', 'label', 'description', 'checked']);
  });

  test('(+) multi-select options keep Claude\'s checkbox marks', () => {
    assert.deepEqual(dialogCapture(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS, checks: [1, 3] }), COLS).options.map((o) => o.checked), [true, false, true]);
  });

  test('(+) typed on a single-select tab: the text, answered when Claude ticked it', () => {
    assert.deepEqual(dialogCapture(ask({ text: 'kiwi ✔' }), COLS).typed, { text: 'kiwi', answered: true });
    assert.deepEqual(dialogCapture(ask({ text: 'kiwi' }), COLS).typed, { text: 'kiwi', answered: false });
    assert.deepEqual(dialogCapture(ask({ text: ['a long typed answer', 'that wraps onto a second row'] }), COLS).typed, { text: 'a long typed answer that wraps onto a second row', answered: false });
  });

  test('(+) typed on a multi tab: answered when its checkbox is ticked', () => {
    const multi = { tabs: ['Tools', 'Project'], multi: true, options: CHECKS, current: 1, button: 'Submit', text: 'kiwi' };
    assert.deepEqual(dialogCapture(ask(multi), COLS).typed, { text: 'kiwi', answered: true });
    assert.deepEqual(dialogCapture(tickedRow(ask(multi), '[\u2714]', '[ ]'), COLS).typed, { text: 'kiwi', answered: false });
  });

  test('(−) typed is null with an empty text row, on a single and a multi tab', () => {
    assert.equal(dialogCapture(ask(), COLS).typed, null);
    assert.equal(dialogCapture(ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS }), COLS).typed, null);
  });

  test('(−) neither checked nor typed is part of the sig: it does not move with ticks or typed text', () => {
    const base = sigOf(read(ask()));
    assert.equal(sigOf(read(ask({ ticks: [2] }))), base);
    assert.equal(sigOf(read(ask({ text: 'kiwi' }))), base);
    assert.equal(sigOf(read(ask({ text: 'kiwi ✔', ticks: [] }))), base);
    assert.equal(dialogCapture(ask({ text: 'kiwi', ticks: [1] }), COLS).sig, base);
  });

  test('(−) a typed text of 500 characters is kept whole; one over it makes the step unreadable (layout), so there is nothing to send', () => {
    assert.equal(dialogCapture(ask({ text: 'x'.repeat(500) }), COLS).typed.text.length, 500);
    assert.deepEqual(dialogCapture(ask({ text: 'x'.repeat(501) }), COLS), { state: 'unreadable', kind: 'ask', reason: 'layout' });
  });

  test('(−) the review and the plan have no typed and no checked', () => {
    assert.equal('typed' in dialogCapture(rowsFrom(reviewParts()), COLS), false);
    assert.equal('typed' in dialogCapture(rowsFrom(planParts()), COLS), false);
    assert.equal(dialogCapture(rowsFrom(planParts()), COLS).options.some((o) => 'checked' in o), false);
  });
});

// ---- 0.5, F13-A v2: Claude's task list (and a lone rule row) under a dialog's or a permission prompt's last row (design F13 v2) ----------
describe('a task list under the dialog or the prompt (F13-A v2)', () => {
  const block = (o = {}) => taskRows({ cols: COLS, ...o });
  const loneRule = (cols = COLS) => taskRows({ cols, doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }).slice(0, 1);
  const PLAN_325 = '   ctrl+g to edit in Vim · ~/.claude/plans/two-line-plan-calm-river.md';
  const PROMPT = ['Bash command', '', '  make a made-up file', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and always allow access to <dir> from this project', '  3. No', '', ' Esc to cancel · Tab to amend'].map(lineOf);
  const screens = {
    'question (several tabs)': () => ask(),
    'question (one tab)': () => ask({ tabs: ['Project'] }),
    'question (vim insert)': () => ask({ focus: 4, insert: true }),
    'multi-select question': () => ask({ tabs: ['Tools', 'Project'], multi: true, options: CHECKS, question: 'Which checks should I run?' }),
    'question with the editor hint': () => ask({ focus: 4, ctrl: true }),
    'review': () => rowsFrom(reviewParts()),
    'plan approval': () => rowsFrom(planParts()),
    'plan approval (2.1.325 footer)': () => rowsFrom(planParts({ footer: PLAN_325 })),
  };
  const tails = {
    'named, the rule directly under the footer': () => block(),
    'named, 11 blank rows above the rule': () => block({ blank: 11 }),
    'unnamed': () => block({ named: false }),
    'unnamed, 10 blank rows': () => block({ named: false, blank: 10 }),
    'unnamed, 1 tasks, no in-progress part': () => block({ named: false, doing: 0, open: 0, shownDone: 1, hiddenDone: 0 }),
    'named, all done and an overflow row': () => block({ doing: 0, open: 0, shownDone: 5, hiddenDone: 3 }),
    'overflow with pending and in progress': () => block({ hiddenDoing: 1, hiddenOpen: 2, hiddenDone: 0 }),
    'a lone rule row': () => loneRule(),
    'a lone rule row after blank rows': () => [[], [], [], ...loneRule()],
  };
  const withTail = (rows, tail) => [...rows, ...tails[tail]()];

  test('(+) every dialog with the block or the lone rule under it reads as the same step without it, and has the same sig', () => {
    for (const [name, make] of Object.entries(screens)) {
      const plain = read(make());
      assert.equal(plain.unreadable, undefined, name);
      for (const tail of Object.keys(tails)) {
        const S = read(withTail(make(), tail));
        assert.deepEqual(S, plain, `${name} / ${tail}`);
        assert.equal(sigOf(S), sigOf(plain), `${name} / ${tail}`);
        assert.equal(dialogCapture(withTail(make(), tail), COLS).state, 'ready', `${name} / ${tail}`);
      }
    }
  });

  test('(+) padded rows and trailing blank rows read the same', () => {
    const plain = read(ask());
    const pad = (rows) => rows.map((r) => [...r, span(' '.repeat(Math.max(0, COLS - text(r).length)))]);
    assert.deepEqual(read([...rowsFrom(askParts(), { pad: true }), ...pad(block())]), plain);
    assert.deepEqual(read([...rowsFrom(askParts(), { pad: true }), ...pad(block({ named: false }))]), plain);
    assert.deepEqual(read([...ask(), ...block(), [], []]), plain);
    assert.deepEqual(read([...ask(), ...loneRule(), []]), plain);
  });

  test('(+) the plan footer as 2.1.325 draws it (the editor hint and the plan path, no Esc to cancel) is a dialog end today, and the plan reads', () => {
    assert.equal(isDialogEnd(PLAN_325), true);
    const rows = rowsFrom(planParts({ footer: PLAN_325 }));
    const S = read(rows);
    assert.equal(S.kind, 'plan');
    assert.equal(S.unreadable, undefined);
    assert.equal(dialogOnScreen(rows), true);
    assert.equal(dialogCapture(rows, COLS).state, 'ready');
  });

  test('(+) the dialog is on screen and nothing else is: no prompt, no mode, no draft, no plain input box', () => {
    for (const [name, make] of Object.entries(screens)) {
      for (const tail of ['named, the rule directly under the footer', 'unnamed', 'a lone rule row']) {
        const rows = withTail(make(), tail);
        assert.equal(dialogOnScreen(rows), true, name);
        assert.equal(promptFromRows(rows), null, name);
        assert.equal(modeFromRows(rows), 'unknown', name);
        assert.equal(readDraft({ rows, cursor: { x: 0, y: 5 }, cols: COLS }), null, name);
        assert.equal(parseDraft(rows, null, COLS), null, name);
      }
    }
  });

  test('(+) a permission prompt with the block under it is read as the same prompt: the same options, question and sig, and it is no dialog', () => {
    const plain = promptFromRows(PROMPT);
    assert.deepEqual(plain.options.map((o) => o.n), [1, 2, 3]);
    for (const tail of Object.keys(tails)) {
      const rows = withTail(PROMPT, tail);
      assert.deepEqual(promptFromRows(rows), plain, tail);
      assert.equal(promptSig(rows), promptSig(PROMPT), tail);
      assert.equal(dialogOnScreen(rows), false, tail);
      assert.equal(dialogCapture(rows, COLS), null, tail);
      assert.equal(bypassWindow(rows), false, tail);
    }
  });

  test('(+) a task label that mentions bypass sets bypass on the ready dialog (the guard reads the literal bottom), and only then; on a prompt it flags the bypass window', () => {
    const labels = ['Check the bypass settings'];
    for (const [name, make] of Object.entries(screens)) {
      const rows = [...make(), ...block({ labels })];
      assert.equal(read(rows).bypass, true, name);
      assert.equal(dialogCapture(rows, COLS).bypass, true, name);
      assert.equal(dialogCapture(rows, COLS).state, 'ready', name);
      assert.equal(read([...make(), ...block()]).bypass, false, name);
      assert.equal(read(make()).bypass, false, name);
    }
    assert.equal(bypassWindow([...PROMPT, ...block({ labels })]), true);
    assert.notEqual(promptFromRows([...PROMPT, ...block({ labels })]), null);
  });

  test('(+) the full capture path on synthetic 64-column screens shaped like the spike\'s (named and unnamed, 45 and 60 rows) gives a ready dialog with the sig of the screen without the block', () => {
    const cols = 64;
    for (const tabs of [['Project'], ['Project', 'Tools']]) {
      const dialog = rowsFrom(askParts({ cols, tabs }), { cols });
      for (const [rows, named] of [[45, true], [45, false], [60, true], [60, false]]) {
        const screen = taskScreen(dialog, { rows, named, cols, doing: 1, open: 0, shownDone: 4, hiddenDone: 12 });
        assert.equal(screen.length, rows);
        const got = dialogCapture(parseCapture(ansiOf(screen, cols), cols), cols);
        const want = dialogCapture(parseCapture(ansiOf(dialog, cols), cols), cols);
        assert.equal(got.state, 'ready', `${tabs.join()} / ${rows} / ${named}`);
        assert.match(got.sig, /^[0-9a-f]{16}$/);
        assert.equal(got.sig, want.sig);
        const { top: gotTop, ...gotRest } = got;
        const { top: wantTop, ...wantRest } = want;
        assert.deepEqual(gotRest, wantRest);
        assert.equal(gotTop, wantTop + 12, 'taskScreen puts the dialog 12 rows down: the cut moves with it, and the block below does not change it');
        assert.equal(got.bypass, false);
      }
    }
    const head = taskRows({ cols, doing: 1, open: 0, shownDone: 4, hiddenDone: 12 }).map(text);
    assert.deepEqual(head.slice(1, 3), ['', '  17 tasks (16 done, 1 in progress, 0 open)'], 'the header of the shape: 17 tasks');
    assert.equal(head.at(-1), '   … +12 completed');
    assert.equal(head[0].length, cols, 'a labelled rule, as wide as the pane');
  });

  test('(+) a dialog that is unreadable for another reason stays unreadable, with the same reason, when the block sits under it (the cut only shows it to the exact reader)', () => {
    const wide = { options: [{ label: 'a'.repeat(COLS - 4), desc: 'x' }, { label: 'b', desc: 'y' }] };
    const noStrip = () => { const rows = ask(); rows.splice(rowAt(rows, (t) => t.includes('Project') && t.includes('Tools')), 1); return rows; };
    const survey = () => { const rows = ask(); rows.unshift(lineOf('● How is Claude doing this session? (optional)'), lineOf('  1: Bad    2: Fine    3: Good    0: Dismiss')); return rows; };
    for (const [name, make] of Object.entries({ wide: () => ask(wide), noStrip, survey })) {
      const before = reason(make());
      assert.notEqual(before, undefined, name);
      for (const tail of Object.keys(tails)) {
        assert.equal(reason(withTail(make(), tail)), before, `${name} / ${tail}`);
        assert.deepEqual(dialogCapture(withTail(make(), tail), COLS), dialogCapture(make(), COLS), `${name} / ${tail}`);
      }
    }
  });

  test('(−) a block or a rule row in any shape but the captured ones is cut by nobody: no form, and no dialog on screen (the banner stays)', () => {
    for (const [name, make] of Object.entries(screens)) {
      for (const [bad, rows] of Object.entries(taskMisfits(make()))) {
        const cap = dialogCapture(rows, COLS);
        assert.notEqual(cap?.state, 'ready', `${name}: ${bad}`);
        assert.equal(cap === null, !dialogOnScreen(rows), `${name}: ${bad}`);
        // An old quirk (not touched by F13-A): an ask footer that ends in the editor hint without `· Esc to cancel`, and a plan footer, take the next
        // two rows for a wrapped footer (the [^·]+ and .+ of ASK_FOOTER and PLAN_FOOTER). Such a screen is a dialog on screen that is unreadable
        // ('wide'), never a form; every other footer sees no dialog at all.
        if (!['question (vim insert)', 'plan approval', 'plan approval (2.1.325 footer)'].includes(name)) assert.equal(dialogOnScreen(rows), false, `${name}: ${bad}`);
      }
    }
    for (const [bad, rows] of Object.entries(taskMisfits(PROMPT))) assert.equal(dialogCapture(rows, COLS), null, bad);
  });

  test('(−) the block does not make a prompt or hide one: a screen that ends in the block without a prompt above it is no prompt', () => {
    const noPrompt = [lineOf('transcript line'), lineOf('Esc to cancel · Tab to amend')];
    assert.equal(promptFromRows([...noPrompt, ...block()]), null);
    assert.equal(dialogOnScreen([...noPrompt, ...block()]), false);
    assert.equal(promptFromRows([...PROMPT, ...block({ gap: 2 })]), null, 'a misshapen block under a real prompt cuts nothing, so the prompt reads as it did before: not at all');
  });

  test('(−) malformed input never throws', () => {
    for (const bad of [null, undefined, [], [[]], [[{}]], [[{ t: 5 }]], [null], [[null]], 'x', 5, {}]) {
      assert.doesNotThrow(() => { dialogOnScreen(bad); readDialogScreen(bad, COLS); dialogCapture(bad, COLS); dialogCapture(bad, NaN); }, JSON.stringify(bad));
    }
    const rows = [...ask(), ...block()];
    for (const cols of [undefined, null, NaN, 0, -3, 5, 64]) assert.doesNotThrow(() => dialogCapture(rows, cols), String(cols));
  });
});

// ---- 0.5, F13-B: the question's bar and the rows as wide as the pane (design F13 1.4; spike S-F13 (c): Claude 2.1.325 draws both) ----------
describe('the bar and the pane-wide rows of a long question (F13-B)', () => {
  const C = 64;
  // A made-up text of exactly n characters that ends in a letter.
  const words = (n) => { const t = 'amber river quiet maple stone cedar hazel '.repeat(8).slice(0, n); return t.endsWith(' ') ? `${t.slice(0, -1)}x` : t; };
  const bar = (t) => [span('│', { d: true }), span(' '), span(t, { b: true, fg: 231 })];
  const barred = (texts) => texts.map(bar);
  const plainQ = (texts) => texts.map((t) => [span(t, { b: true, fg: 231 })]);
  const QUESTION = [words(62), words(60), words(31)];
  const OPTS_WRAPPED = [{ label: 'Night start', desc: [words(59), words(53)] }, { label: 'Day start', desc: [words(55)] }];
  const make = (o = {}) => rowsFrom(askParts({ cols: C, tabs: ['Plan'], question: barred(QUESTION), options: OPTS_WRAPPED, ...o }), { cols: C });
  const readC = (rows) => readDialogScreen(rows, C);
  const wideOf = (rows) => Math.max(...rows.map((r) => text(r).length));

  test('(+) the fixture has what the spike saw: a bar on every question row, a question row and a description row as wide as the pane', () => {
    const rows = make();
    assert.equal(rowAt(rows, (t) => t.length === C && t.startsWith('│ ')) >= 0, true);
    assert.equal(rowAt(rows, (t) => t.length === C && t.startsWith('     ')) >= 0, true);
    assert.equal(wideOf(rows), C);
  });

  test('(+) a bar on every question row is left out: the question reads as the same text without the bars, with the same sig', () => {
    const S = readC(make());
    assert.equal(S.unreadable, undefined);
    assert.equal(S.question, QUESTION.join(' '));
    const without = readC(make({ question: plainQ([words(40), words(31)]) }));
    const withBars = readC(make({ question: barred([words(40), words(31)]) }));
    assert.equal(sigOf(withBars), sigOf(without));
    assert.deepEqual(withBars, without);
  });

  test('(+) one barred row, as wide as the pane or not (a 90-character question at 120 columns), reads', () => {
    const one = rowsFrom(askParts({ tabs: ['Plan'], question: barred([words(89)]) }));
    assert.equal(read(one).question, words(89));
    const wideOne = rowsFrom(askParts({ cols: 91, tabs: ['Plan'], question: barred([words(89)]) }), { cols: 91 });
    assert.equal(readDialogScreen(wideOne, 91).unreadable, 'wide', 'a single row as wide as the pane has nothing below it');
  });

  test('(+) a question row as wide as the pane is read when the next row continues the question; so is a description row with another description row below it', () => {
    const S = readC(make());
    assert.equal(S.unreadable, undefined);
    assert.equal(S.options[0].description, `${words(59)} ${words(53)}`);
    const plain = readC(make({ question: plainQ(QUESTION) }));
    assert.equal(plain.unreadable, undefined, 'the same without bars: a plain row as wide as the pane with a continuation below');
    assert.equal(plain.question, QUESTION.join(' '));
  });

  test('(+) the full capture path at 64 columns: the barred question, the wide rows and an unnamed block under the footer give a ready dialog with the sig of the screen without the block', () => {
    const dialog = make();
    const tasks = taskRows({ cols: C, named: false, doing: 1, open: 0, shownDone: 0, hiddenDone: 0, labels: ['bake one loaf'] });
    assert.deepEqual(tasks.map(text), ['', '  1 tasks (0 done, 1 in progress, 0 open)', '  ◼ bake one loaf']);
    const got = dialogCapture(parseCapture(ansiOf([...dialog, ...tasks], C), C), C);
    const want = dialogCapture(parseCapture(ansiOf(dialog, C), C), C);
    assert.equal(want.state, 'ready');
    assert.equal(got.state, 'ready');
    assert.equal(got.sig, want.sig);
    assert.deepEqual(got, want);
    assert.equal(got.question, QUESTION.join(' '));
  });

  test('(−) a bar on some question rows only is a layout the reader refuses (first row, last row, the middle one)', () => {
    const rowsFor = (flags) => QUESTION.map((t, n) => (flags[n] ? bar(t) : [span(t, { b: true, fg: 231 })]));
    for (const flags of [[true, false, false], [false, false, true], [false, true, false], [true, true, false], [false, true, true]]) {
      assert.equal(readC(make({ question: rowsFor(flags) })).unreadable, 'layout', flags.join());
    }
    assert.equal(readC(make({ question: rowsFor([true, true, true]) })).unreadable, undefined);
    assert.equal(readC(make({ question: rowsFor([false, false, false]) })).unreadable, undefined);
    const lone = make({ question: [bar(words(40)), [span('│', { d: true })], bar(words(30))] });
    assert.equal(readC(lone).unreadable, 'layout', 'a bar row with no text is not a barred row');
  });

  test('(−) a question row as wide as the pane stays refused when nothing continues it: the last row of the question, a blank row below it, an option row below it', () => {
    assert.equal(readC(make({ question: barred([words(40), words(62)]) })).unreadable, 'wide', 'the last row of the question');
    assert.equal(readC(make({ question: plainQ([words(40), words(64)]) })).unreadable, 'wide', 'plain: the last row of the question');
    assert.equal(readC(make({ question: barred([words(62), '', words(31)].filter((t) => t !== '')) })).unreadable, undefined, 'control: the continuation case reads');
    const withBlank = make({ question: [...barred([words(62)]), [], ...barred([words(31)])] });
    assert.equal(readC(withBlank).unreadable, 'wide', 'a blank row between the wide row and the next question row');
    assert.equal(readC(make({ question: barred([words(62)]) })).unreadable, 'wide', 'a wide row with the first option row below it');
  });

  test('(−) a description row as wide as the pane stays refused when it is the last row of its description (the next row is an option or the separator)', () => {
    assert.equal(readC(make({ options: [{ label: 'Night start', desc: [words(53), words(59)] }, { label: 'Day start', desc: [words(55)] }] })).unreadable, 'wide', 'the last row of the first description');
    assert.equal(readC(make({ options: [{ label: 'Night start', desc: [words(53)] }, { label: 'Day start', desc: [words(55), words(59)] }] })).unreadable, 'wide', 'the last row of the last description');
    assert.equal(readC(make({ options: [{ label: 'Night start', desc: [words(59)] }, { label: 'Day start', desc: [words(55)] }] })).unreadable, 'wide', 'a single wide description row');
  });

  test('(−) an option row as wide as the pane stays refused, with or without a continuation below it; so do the strip, the footer and a review or plan row', () => {
    const optionRow = words(C - 5);
    assert.equal(readC(make({ options: [{ label: optionRow, desc: [words(40)] }, { label: 'Day start', desc: [words(55)] }] })).unreadable, 'wide');
    assert.equal(readC(make({ options: [{ label: optionRow, desc: [] }, { label: 'Day start', desc: [] }] })).unreadable, 'wide');
    assert.equal(readC(rowsFrom(reviewParts({ cols: C, pairs: [{ q: words(C - 3), a: 'x' }, { q: 'Which checks should I run?', a: 'lint' }] }), { cols: C })).unreadable, 'wide');
    assert.equal(readC(rowsFrom(planParts({ cols: C, prose: ['x'], labels: [words(C - 8), 'Yes, manually approve edits'] }), { cols: C })).unreadable, 'wide');
  });

  test('(−) the bar changes nothing outside a question step: a barred line in a review pair or above the strip is just text, and the sig of a question depends on the text, not on the bar', () => {
    const base = readC(make({ question: plainQ(['Which step comes next?']) }));
    const barredOne = readC(make({ question: barred(['Which step comes next?']) }));
    assert.equal(sigOf(base), sigOf(barredOne));
    assert.notEqual(sigOf(readC(make({ question: barred(['Which step comes first?']) }))), sigOf(barredOne));
  });
});

// ---- 0.5, FX2 (live check LC17 K1b, Claude 2.1.326): the review step draws the bar in front of its question rows -----------------------------
// The shape recorded in K1b: a space, a dim bar and a space in front of the `●` row (` │ ● <question>`) and of its wrapped rest (` │   <rest>`), the
// answer row `   → <answer>` without it. The text below is made up; no captured text is copied.
describe('the bar in front of the review step\'s question rows (FX2)', () => {
  const C = 100;
  const bar = (t) => [span(' '), span('│', { d: true }), span(' '), span(t)];
  const Q1 = ['Which colour should the lighthouse lamp use during the first week of the festival,', 'given that the guide mentions amber twice?'];
  const Q2 = ['How many keepers should stand watch on each night shift?'];
  const Q3 = ['Which flag goes up first when the fog clears over the harbour, and who raises it,', 'given that the crew rota changes every week and the old signal book is out of date,', 'so the keepers must agree beforehand?'];
  /** The rows of the pairs: each question's rows barred or not (`flags`, per question), then its answer row and the rest of the answer (indent 5). */
  const pairRows = (items, flags = items.map(() => true)) => items.flatMap(({ q, a }, n) => [
    ...q.map((t, j) => (flags[n] ? bar(j === 0 ? `● ${t}` : `  ${t}`) : [span(j === 0 ? ` ● ${t}` : `   ${t}`)])),
    ...[].concat(a).map((t, j) => [span(j === 0 ? `   → ${t}` : `     ${t}`, { fg: 114 })]),
  ]);
  const ITEMS = [{ q: Q1, a: 'amber' }, { q: Q2, a: 'two' }];
  const review = (pairs, o = {}) => rowsFrom({ ...reviewParts({ cols: C, pairs: [], ...o }), pairs }, { cols: C });
  const readC = (rows) => readDialogScreen(rows, C);
  const widest = (rows) => Math.max(...rows.map(text).filter((t) => !/^─+$/.test(t)).map((t) => t.length)); // the rules are exactly as wide as the pane
  /** The rows with the row `at` replaced by `make(row)`. */
  const swap = (rows, at, make) => rows.map((r, n) => (n === at ? make(r) : r));

  test('(+) the captured shape: barred question rows (a wrapped one and a one-row one), unbarred answer rows, read as the pairs the text says', () => {
    const rows = review(pairRows(ITEMS));
    assert.equal(rowAt(rows, (t) => t.startsWith(' │ ● Which colour')) >= 0, true, 'the fixture has the bar in front of the pair rows');
    assert.equal(rowAt(rows, (t) => t.startsWith(' │   given that the guide')) >= 0, true, 'and in front of the wrapped rest');
    assert.equal(rowAt(rows, (t) => t.startsWith('   → amber')) >= 0, true, 'but not in front of an answer');
    assert.equal(widest(rows) < C, true, 'no row reaches the pane width');
    const S = readC(rows);
    assert.equal(S.unreadable, undefined);
    assert.deepEqual(S.pairs, [{ question: `${Q1[0]} ${Q1[1]}`, answer: 'amber' }, { question: Q2[0], answer: 'two' }]);
    assert.deepEqual(S.tabs.map((t) => t.answered), [true, true]);
    assert.equal(S.focus, 1);
  });

  test('(+) the same text without the bars reads as the same step with the same sig (as in the question step); other text has another sig', () => {
    const barred = readC(review(pairRows(ITEMS)));
    const plain = readC(review(pairRows(ITEMS, [false, false])));
    assert.equal(plain.unreadable, undefined);
    assert.deepEqual(barred, plain);
    assert.equal(sigOf(barred), sigOf(plain));
    assert.notEqual(sigOf(barred), sigOf(readC(review(pairRows([{ q: Q1, a: 'green' }, { q: Q2, a: 'two' }])))), 'the sig still depends on the text');
  });

  test('(+) a question wrapped onto three barred rows, and a wrapped answer under a barred question, join with one space', () => {
    const S = readC(review(pairRows([{ q: Q3, a: ['the signal book', 'on the quay'] }, { q: Q2, a: 'two' }])));
    assert.equal(S.unreadable, undefined);
    assert.equal(S.pairs[0].question, Q3.join(' '));
    assert.equal(S.pairs[0].answer, 'the signal book on the quay');
  });

  test('(+) the full capture path: barred review rows give a ready review with the pairs, and the sig of the unbarred drawing', () => {
    const rows = review(pairRows(ITEMS));
    const got = dialogCapture(parseCapture(ansiOf(rows, C), C), C);
    assert.equal(got.state, 'ready');
    assert.equal(got.at, 'review');
    assert.deepEqual(got.pairs.map((p) => p.answer), ['amber', 'two']);
    assert.equal(got.pairs[0].question, `${Q1[0]} ${Q1[1]}`);
    assert.equal(got.sig, dialogCapture(parseCapture(ansiOf(review(pairRows(ITEMS, [false, false])), C), C), C).sig);
    assert.equal(dialogOnScreen(rows), true);
  });

  test('(+) the warning row with a tab still open and a barred pair read together', () => {
    const S = readC(review(pairRows([{ q: Q1, a: 'amber' }]), { warn: true, answered: [0] }));
    assert.equal(S.unreadable, undefined);
    assert.equal(S.warn, true);
    assert.equal(S.pairs.length, 1);
  });

  // Round 1 (a rule change from new evidence, spike S-T326 item 9, not a weakened test): Claude bars the long question of a review and not the short one, so the bar is
  // all-or-none per question. The two assertions of the old test that mixed ACROSS questions ([true, false], [false, true]) described a refusal that is now accepted
  // behaviour; they became the (+) test below. What mixes inside ONE question stays refused.
  test('(+) a short unbarred question and a long barred one in the same review (either order) read both pairs, with the texts of the rows, as without any bar', () => {
    const SHORT = { q: Q2, a: 'two' };
    const LONG = { q: Q1, a: 'amber' };
    for (const [items, flags] of [[[SHORT, LONG], [false, true]], [[LONG, SHORT], [true, false]]]) {
      const rows = review(pairRows(items, flags));
      assert.equal(rowAt(rows, (x) => x.startsWith(' ● How many keepers')) >= 0 || rowAt(rows, (x) => x.startsWith(' │ ● How many keepers')) >= 0, true);
      const S = readC(rows);
      assert.equal(S.unreadable, undefined, JSON.stringify(flags));
      assert.deepEqual(S.pairs, items.map(({ q, a }) => ({ question: q.join(' '), answer: a })));
      assert.equal(sigOf(S), sigOf(readC(review(pairRows(items, [false, false])))), 'the sig does not depend on which question has the bar');
      assert.equal(sigOf(S), sigOf(readC(review(pairRows(items, [true, true])))));
      const got = dialogCapture(parseCapture(ansiOf(rows, C), C), C);
      assert.equal(got.state, 'ready');
      assert.deepEqual(got.pairs.map((p) => p.answer), items.map((i) => i.a));
    }
    const three = readC(review(pairRows([{ q: Q3, a: 'x' }, SHORT, LONG], [true, false, true]), { tabs: ['A', 'B', 'C'], answered: [0, 1, 2] }));
    assert.equal(three.unreadable, undefined, 'three questions: barred, unbarred, barred');
    assert.deepEqual(three.pairs.map((p) => p.answer), ['x', 'two', 'amber']);
  });

  test('(−) a mix of barred and unbarred rows inside ONE question is a layout: the rest of a question, the first row of one, the middle of three, also in a mixed review', () => {
    const rows = review(pairRows(ITEMS));
    const rest = rowAt(rows, (t) => t.startsWith(' │   given that the guide'));
    assert.equal(readC(swap(rows, rest, (r) => [span(`   ${text(r).slice(5)}`)])).unreadable, 'layout', 'a barred first row with an unbarred rest');
    assert.equal(readC(swap(rows, rest - 1, (r) => [span(` ● ${text(r).slice(5)}`)])).unreadable, 'layout', 'an unbarred first row with a barred rest');
    const three = review(pairRows([{ q: Q3, a: 'x' }, { q: Q2, a: 'two' }]));
    const mid = rowAt(three, (t) => t.startsWith(' │   given that the crew rota'));
    assert.equal(readC(swap(three, mid, (r) => [span(`   ${text(r).slice(5)}`)])).unreadable, 'layout', 'the middle row of three');
    const mixed = review(pairRows([{ q: Q2, a: 'two' }, { q: Q1, a: 'amber' }], [false, true]));
    assert.equal(readC(mixed).unreadable, undefined, 'control: a short unbarred and a long barred question read');
    const mrest = rowAt(mixed, (t) => t.startsWith(' │   given that the guide'));
    assert.equal(readC(swap(mixed, mrest, (r) => [span(`   ${text(r).slice(5)}`)])).unreadable, 'layout', 'the long question: barred first row, unbarred rest');
    assert.equal(readC(swap(mixed, mrest - 1, (r) => [span(` ● ${text(r).slice(5)}`)])).unreadable, 'layout', 'the long question: unbarred first row, barred rest');
    const short = rowAt(mixed, (t) => t.startsWith(' ● How many keepers'));
    assert.equal(readC(swap(mixed, short, (r) => bar(`● ${text(r).slice(3)}`))).unreadable, undefined, 'a one-row question may carry the bar (every one of its rows)');
    const wrappedShort = review(pairRows([{ q: Q3, a: 'x' }, { q: Q1, a: 'amber' }], [false, true]));
    const wrest = rowAt(wrappedShort, (t) => t.startsWith('   given that the crew rota'));
    assert.equal(readC(swap(wrappedShort, wrest, (r) => bar(`  ${text(r).slice(3)}`))).unreadable, 'layout', 'an unbarred question of three rows with one barred row, next to a barred question');
  });

  test('(−) a bar in front of an answer row or the rest of an answer is a layout; so is a bar row with no text', () => {
    const rows = review(pairRows(ITEMS));
    const at = rowAt(rows, (t) => t.startsWith('   → amber'));
    assert.equal(readC(swap(rows, at, () => bar('  → amber'))).unreadable, 'layout', 'a barred answer row (the bar after the indent, as for a question row)');
    assert.equal(readC(swap(rows, at, () => bar('→ amber'))).unreadable, 'layout', 'a barred answer row with the bar in the place of its indent');
    const wrapped = review(pairRows([{ q: Q1, a: ['the signal book', 'on the quay'] }, { q: Q2, a: 'two' }]));
    assert.equal(readC(wrapped).unreadable, undefined, 'control: the wrapped answer without a bar reads');
    const rest = rowAt(wrapped, (t) => t.startsWith('     on the quay'));
    assert.equal(readC(swap(wrapped, rest, () => bar('  on the quay'))).unreadable, 'layout', 'a barred answer continuation');
    assert.equal(readC(swap(rows, at + 1, () => [span(' │')])).unreadable, 'layout', 'a bar with no text is not a barred row');
  });

  test('(−) a bar in front of the Submit answers row is not read as a pair; nor is one in front of the question line or the Cancel row', () => {
    const rows = review(pairRows(ITEMS));
    const barredAt = (find) => swap(rows, rowAt(rows, find), (r) => [span(' │ '), ...r]);
    assert.equal(readC(rows).focus, 1, 'control');
    assert.equal(readC(barredAt((t) => t.includes('1. Submit answers'))).unreadable, 'layout', 'the Submit answers row');
    assert.equal(readC(barredAt((t) => t.includes('Ready to submit'))).unreadable, 'layout', 'the question line');
    assert.equal(readC(barredAt((t) => t.includes('2. Cancel'))), null, 'the Cancel row: no review is on screen any more');
    const plain = review(pairRows(ITEMS, [false, false]));
    const submit = rowAt(plain, (t) => t.includes('1. Submit answers'));
    assert.equal(readC(swap(plain, submit, (r) => [span(' │ '), ...r])).unreadable, 'layout', 'the same without any bar on the pairs');
  });

  test('(−) a barred review row as wide as the pane with no rest row under it stays refused (the exemption needs a wrapped rest row, LC19 F2)', () => {
    const rows = review(pairRows([{ q: ['Which colour?'], a: 'amber' }]), { warn: true, answered: [0] });
    const at = rowAt(rows, (t) => t.startsWith(' │ ● Which colour?'));
    const filled = swap(rows, at, () => bar(`● ${'a'.repeat(C - 5)}`));
    assert.equal(widest(filled), C);
    assert.equal(readC(filled).unreadable, 'wide');
    assert.equal(readC(swap(rows, at, () => bar(`● ${'a'.repeat(C - 6)}`))).unreadable, undefined, 'control: one cell narrower reads');
  });

  // ---- LC19 F2 (live check LC19, 147 columns): a long question wrapped at the pane width draws its `●` row, and the rows after it, exactly as wide as the pane, -----
  // each followed by its wrapped rest. That is a wrap, not a cut: like the question step, the review exempts a question row that has a rest row of the SAME
  // question (same bar state) directly below it. Nothing else is exempt. The words below are made up; no captured text is copied.
  describe('a review question wrapped at the pane width (LC19 F2)', () => {
    const WORDS = ['lantern', 'harbour', 'keepers', 'rota', 'signal', 'quay', 'beacon', 'tide', 'ferry', 'mast', 'cargo', 'dock'];
    /** A made-up sentence of exactly `n` characters: whole words from `from` on, then a filler word that closes the gap. */
    const sentence = (n, from = 0) => {
      let s = '';
      for (let i = from; ; i += 1) {
        const next = s === '' ? WORDS[i % WORDS.length] : `${s} ${WORDS[i % WORDS.length]}`;
        if (next.length > n) break;
        s = next;
      }
      const gap = n - s.length;
      return gap === 0 ? s : gap === 1 ? `${s}z` : `${s} ${'z'.repeat(gap - 1)}`;
    };
    const BARRED = C - 5; // the text after ` │ ● ` or ` │   ` that makes a barred row exactly C columns
    const PLAIN = C - 3; // the text after ` ● ` or `   ` that makes an unbarred row exactly C columns
    const REST = 'so that the keepers can agree beforehand?';
    const isFull = (t) => t.length === C && !/^─+$/.test(t);
    const fullRows = (rows) => rows.map(text).filter(isFull).length;
    const unbar = (r) => [span(`   ${text(r).slice(5)}`)]; // a barred rest row without its bar
    const rebar = (r) => bar(`  ${text(r).slice(3)}`); // an unbarred rest row with its bar

    test('(+) a barred `●` row exactly as wide as the pane with its wrapped rest reads: the pairs, the texts joined without the bar, and the sig of the same text wrapped elsewhere', () => {
      const A = sentence(BARRED);
      const rows = review(pairRows([{ q: [A, REST], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(rowAt(rows, (t) => t.startsWith(' │ ● ') && isFull(t)) >= 0, true, 'the fixture has a barred ● row as wide as the pane');
      assert.equal(rowAt(rows, (t) => t === ` │   ${REST}`) >= 0, true, 'with its barred rest right below');
      const S = readC(rows);
      assert.equal(S.unreadable, undefined);
      assert.deepEqual(S.pairs, [{ question: `${A} ${REST}`, answer: 'amber' }, { question: Q2[0], answer: 'two' }]);
      assert.deepEqual(S.tabs.map((t) => t.answered), [true, true]);
      assert.equal(S.focus, 1);
      const at = A.lastIndexOf(' '); // the same text, wrapped one word earlier: no row reaches the pane
      const narrow = review(pairRows([{ q: [A.slice(0, at), `${A.slice(at + 1)} ${REST}`], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(fullRows(narrow), 0);
      assert.deepEqual(readC(narrow), S);
      assert.equal(sigOf(S), sigOf(readC(narrow)), 'the sig is over the text, not the wrapping');
      const got = dialogCapture(parseCapture(ansiOf(rows, C), C), C);
      assert.equal(got.state, 'ready');
      assert.equal(got.at, 'review');
      assert.equal(got.sig, sigOf(S));
      assert.deepEqual(got.pairs, S.pairs);
    });

    test('(+) the same shape without the bar (an unbarred long question), and next to a barred one', () => {
      const A = sentence(PLAIN, 3);
      const items = [{ q: [A, REST], a: 'amber' }, { q: Q2, a: 'two' }];
      const rows = review(pairRows(items, [false, false]));
      assert.equal(rowAt(rows, (t) => t.startsWith(' ● ') && isFull(t)) >= 0, true, 'the fixture has an unbarred ● row as wide as the pane');
      const S = readC(rows);
      assert.equal(S.unreadable, undefined);
      assert.deepEqual(S.pairs, items.map(({ q, a }) => ({ question: q.join(' '), answer: a })));
      const mixed = [{ q: [A, REST], a: 'amber' }, { q: [sentence(BARRED, 6), 'is the second rest?'], a: 'two' }];
      const both = review(pairRows(mixed, [false, true]));
      assert.equal(fullRows(both), 2, 'an unbarred and a barred question, each with a row as wide as the pane');
      const T = readC(both);
      assert.equal(T.unreadable, undefined);
      assert.deepEqual(T.pairs, mixed.map(({ q, a }) => ({ question: q.join(' '), answer: a })));
      assert.equal(sigOf(T), sigOf(readC(review(pairRows(mixed, [false, false])))), 'the sig does not depend on which question has the bar');
    });

    test('(+) both questions as wide as the pane and wrapped, one of them over three rows with two rows as wide as the pane', () => {
      const long = [sentence(BARRED, 0), sentence(BARRED, 4), 'and who confirms it?'];
      const short = [sentence(BARRED, 7), 'is the rest of the second one?'];
      const rows = review(pairRows([{ q: long, a: 'amber' }, { q: short, a: ['two', 'on the quay'] }]));
      assert.equal(fullRows(rows), 3, 'three rows as wide as the pane');
      const S = readC(rows);
      assert.equal(S.unreadable, undefined);
      assert.deepEqual(S.pairs, [{ question: long.join(' '), answer: 'amber' }, { question: short.join(' '), answer: 'two on the quay' }]);
      const got = dialogCapture(parseCapture(ansiOf(rows, C), C), C);
      assert.equal(got.state, 'ready');
      assert.deepEqual(got.pairs, S.pairs);
    });

    test('(−) a row as wide as the pane with no rest row under it is wide: a one-row question, in a review whose other question is exempt; barred or not', () => {
      for (const flags of [[true, true], [false, false], [true, false], [false, true]]) {
        const fit = (n, delta = 0) => sentence((flags[n] ? BARRED : PLAIN) + delta, n * 2); // question n's only or first row, `delta` cells off the pane width
        const build = (delta) => review(pairRows([{ q: [fit(0), REST], a: 'amber' }, { q: [fit(1, delta)], a: 'two' }], flags));
        assert.equal(fullRows(build(0)), 2, `${flags}: the fixture has two rows as wide as the pane`);
        assert.equal(readC(build(0)).unreadable, 'wide', `${flags}: the second question's only row`);
        assert.equal(readC(build(-1)).unreadable, undefined, `${flags}: control: one cell narrower reads`);
      }
      const single = review(pairRows([{ q: [sentence(BARRED)], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(readC(single).unreadable, 'wide', 'a full row directly followed by its answer row is not exempt');
    });

    test('(−) a row as wide as the pane that is the last row of its question is wide, though the row above it is exempt', () => {
      const rows = review(pairRows([{ q: [sentence(BARRED), sentence(BARRED, 5)], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(fullRows(rows), 2);
      assert.equal(readC(rows).unreadable, 'wide', 'the second of two full rows is the last row of the question');
      const control = review(pairRows([{ q: [sentence(BARRED), sentence(BARRED - 1, 5)], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(readC(control).unreadable, undefined, 'control: the last row one cell narrower reads');
      const plain = review(pairRows([{ q: [sentence(PLAIN), sentence(PLAIN, 5)], a: 'amber' }, { q: Q2, a: 'two' }], [false, false]));
      assert.equal(readC(plain).unreadable, 'wide', 'unbarred');
      const three = review(pairRows([{ q: ['Which flag goes up first?', sentence(BARRED, 8)], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(readC(three).unreadable, 'wide', 'a short first row and a full last row');
    });

    test('(−) a full-width answer row, a wrapped answer under it, and a full-width heading or question line stay wide, though the question above is exempt', () => {
      const exempt = [{ q: [sentence(BARRED), REST], a: 'amber' }, { q: Q2, a: 'two' }];
      assert.equal(readC(review(pairRows(exempt))).unreadable, undefined, 'control: the exempt question alone reads');
      assert.equal(readC(review(pairRows([{ q: exempt[0].q, a: sentence(BARRED, 1) }, exempt[1]]))).unreadable, 'wide', 'an answer row as wide as the pane');
      assert.equal(readC(review(pairRows([{ q: exempt[0].q, a: sentence(BARRED - 1, 1) }, exempt[1]]))).unreadable, undefined, 'control: one cell narrower reads');
      assert.equal(readC(review(pairRows([{ q: exempt[0].q, a: [sentence(BARRED, 1), 'on the quay'] }, exempt[1]]))).unreadable, 'wide', 'a full answer row with its wrapped rest below');
      assert.equal(readC(review(pairRows([exempt[0], { q: Q2, a: [sentence(BARRED, 1), 'on the quay'] }]))).unreadable, 'wide', 'the same in the second pair');
      const rows = review(pairRows(exempt));
      const pad = (find, t) => swap(rows, rowAt(rows, find), () => [span(`${' '.repeat(C - t.length)}${t}`)]);
      assert.equal(readC(pad((t) => t === 'Ready to submit your answers?', 'Ready to submit your answers?')).unreadable, 'wide', 'the question line, indented to the pane width');
      assert.equal(readC(pad((t) => t === 'Review your answers', 'Review your answers')).unreadable, 'wide', 'the heading, indented to the pane width');
      assert.equal(readC(swap(rows, rowAt(rows, (t) => t === 'Ready to submit your answers?'), () => [span(`${' '.repeat(C - 30)}Ready to submit your answers?`)])).unreadable, undefined, 'control: one cell narrower reads');
    });

    test('(−) a row as wide as the pane followed by a rest row with the other bar state is not read (wide: the exemption needs the same bar state)', () => {
      const barred = review(pairRows([{ q: [sentence(BARRED), REST], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(readC(barred).unreadable, undefined, 'control: both rows barred');
      assert.equal(readC(swap(barred, rowAt(barred, (t) => t === ` │   ${REST}`), unbar)).unreadable, 'wide', 'a barred full row, an unbarred rest');
      const plain = review(pairRows([{ q: [sentence(PLAIN), REST], a: 'amber' }, { q: Q2, a: 'two' }], [false, false]));
      assert.equal(readC(plain).unreadable, undefined, 'control: both rows unbarred');
      assert.equal(readC(swap(plain, rowAt(plain, (t) => t === `   ${REST}`), rebar)).unreadable, 'wide', 'an unbarred full row, a barred rest');
      const three = review(pairRows([{ q: [sentence(BARRED), sentence(BARRED, 5), REST], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(readC(three).unreadable, undefined, 'control: three barred rows, two of them as wide as the pane');
      assert.equal(readC(swap(three, rowAt(three, (t) => t === ` │   ${REST}`), unbar)).unreadable, 'wide', 'the second full row has an unbarred rest');
      assert.equal(readC(swap(three, rowAt(three, (t) => isFull(t) && t.startsWith(' │   ')), unbar)).unreadable, 'wide', 'an unbarred second row: the first full row has a rest of the other bar state');
    });

    test('(−) a blank row between a row as wide as the pane and its rest means the rest is not directly below it: wide', () => {
      const rows = review(pairRows([{ q: [sentence(BARRED), REST], a: 'amber' }, { q: Q2, a: 'two' }]));
      assert.equal(readC(rows).unreadable, undefined, 'control');
      const at = rowAt(rows, (t) => t.startsWith(' │ ● ') && isFull(t));
      const gap = [...rows.slice(0, at + 1), [], ...rows.slice(at + 1)];
      assert.equal(readC(gap).unreadable, 'wide');
    });
  });
});
