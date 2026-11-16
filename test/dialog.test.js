// Tests for src/dialog.js (nika 0.5, W1 T1): Claude's question dialog, review step and plan approval read from the rows of a capture.
// Fixtures are SYNTHETIC rows built from the shapes recorded in spike S3, W1-T0 and W1-T0b/T0c (acme-api, web-shop, demo-api); no real
// capture or path is copied. A fixture is a set of named parts (rowsFrom joins them in order) so that a test can replace or drop one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as dialog from '../src/dialog.js';
import {
  REASONS, TABS_MAX, NUMBER_MAX, HEADER_MAX, QUESTION_MAX, LABEL_MAX, DESC_MAX, ANSWER_MAX, TEXT_MAX, STEPS_MAX, MULTI_OTHER, PLAN_PICK,
  PLAIN_TEXT, PLAN_TEXT_LABEL, dialogOnScreen, readDialogScreen, identityOf, sigOf, otherAllowed, dialogCapture,
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

/** The review step (S3 E, T0c 8.3). */
function reviewParts(o = {}) {
  const { cols = COLS, tabs = ['Project', 'Tools'], answered = [0, 1], warn = false, focus = 1, bracket = false, mark = 'bg', current = 'submit' } = o;
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
    ready: [[span('Ready to submit your answers?', DIM)]],
    gap4: [''],
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
    assert.deepEqual(REASONS, ['cut', 'wide', 'numbers', 'tab', 'layout', 'survey']);
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
      'STEPS_MAX', 'TABS_MAX', 'TEXT_MAX', 'dialogCapture', 'dialogOnScreen', 'identityOf', 'otherAllowed', 'readDialogScreen', 'sigOf',
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
      textRow: { n: 4, value: null, ticked: false }, chat: 5, button: null, focus: 1, insert: false, bypass: false,
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
      focus: 1, insert: false, bypass: false,
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
});

describe('readDialogScreen: the plan approval', () => {
  test('(+) focus 1: options indented 3, the text option marked by its hint, the plan rows between the dashed rules (T0b 3.8)', () => {
    const S = read(rowsFrom(planParts()));
    assert.deepEqual(S, {
      kind: 'plan', at: 'plan',
      options: [{ n: 1, label: 'Yes, and use auto mode', text: false }, { n: 2, label: 'Yes, manually approve edits', text: false }, { n: 3, label: 'Tell Claude what to change', text: true }],
      textRow: { n: 3, value: null }, planRows: ['- Reply with the single word done.', '- Stop.'], focus: 1, insert: false, bypass: false,
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
    assert.deepEqual(read(ask({ above: fakes })), plain);
    assert.deepEqual(read(rowsFrom(planParts({ above: fakes }))), read(rowsFrom(planParts())));
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

  test('(−) cut: a header, a label, the question or a review answer ends in an ellipsis', () => {
    assert.equal(reason(ask({ tabs: ['Project', 'To…'] })), 'cut');
    assert.equal(reason(ask({ options: [{ label: 'acme-ap…', desc: 'x' }, OPTS[1]] })), 'cut');
    assert.equal(reason(ask({ question: 'Which project should I o…' })), 'cut');
    assert.equal(reason(rowsFrom(reviewParts({ pairs: [{ q: 'Which?', a: 'a very long answer that was…' }] }))), 'cut');
    assert.equal(reason(rowsFrom(reviewParts({ pairs: [{ q: 'Which project should…', a: 'x' }] }))), 'cut');
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
    assert.equal(reason(rowsFrom({ ...planParts(), prompt: ['   Claude has written up a plan and is ready to execute. Would you like to p…'] })), 'cut');
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

  test('(−) the T0b 40-column capture: strip headers cut with an ellipsis, wrapped question, label and footer: unreadable, never a form', () => {
    const w = 40;
    const lines = [
      '─'.repeat(w), '←  ☐ Project  ☐ To…  ☐ Mo…  ✔ Submit  →', '', 'Which project should I open for the', 'weekly release review today?', '',
      '❯ 1. acme-api', '     Open the acme-api project.', '  2. web-shop storefront with the long', '     checkout and payments service', '     Open the web-shop project,',
      '     including the checkout service and', '     the payments gateway, with every', '     shared library it needs.', '  3. demo-api', '     Open the demo-api project.',
      '  4. Type something.', '─'.repeat(w), '  5. Chat about this', '', 'Enter to select · Tab/Arrow keys to', 'navigate · Esc to cancel',
    ];
    const rows = [[], ...lines.map((l, i) => (i === 1 ? strip({ tabs: ['Project', 'To…', 'Mo…'], submit: true }) : lineOf(l)))];
    assert.equal(dialogOnScreen(rows), true);
    assert.equal(read(rows, w).unreadable, 'cut');
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
    assert.equal(reason(rowsFrom({ ...reviewParts(), ready: [] })), 'layout');
    const noAnswer = reviewParts();
    assert.equal(reason(rowsFrom({ ...noAnswer, pairs: [[span(' ● Which project should I open?')]] })), 'layout');
    assert.equal(reason(rowsFrom({ ...noAnswer, pairs: [...noAnswer.pairs, [span('stray')]] })), 'layout');
    assert.equal(reason(rowsFrom({ ...noAnswer, submit: ['❯ 1. Send answers'] })), 'layout');
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

  test('(−) the first failing rule decides, in the order of REASONS (cut before wide before numbers before tab before layout before survey)', () => {
    const cutAndWide = ask({ cols: 70, tabs: ['Project', 'To…'], footer: ['Enter to select · Tab/Arrow keys to navigate', '· Esc to cancel'] });
    assert.equal(reason(cutAndWide, 70), 'cut');
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
  test('(+) a question step: the ready shape with the checked marks only for multi', () => {
    const c = dialogCapture(ask(), COLS);
    assert.deepEqual(c, {
      state: 'ready', kind: 'ask', at: 'question', sig: sigOf(read(ask())), bypass: false,
      tabs: [{ header: 'Project', answered: false }, { header: 'Tools', answered: false }], current: 0, final: false, question: 'Which project should I open?', multi: false, other: true,
      options: [{ n: 1, label: 'acme-api', description: 'Open the acme-api project.' }, { n: 2, label: 'web-shop', description: 'Open the web-shop project.' }, { n: 3, label: 'demo-api', description: 'Open the demo-api project.' }],
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
    assert.deepEqual(Object.keys(r), ['state', 'kind', 'at', 'sig', 'bypass', 'tabs', 'warn', 'pairs']);
    assert.equal(r.warn, true);
    const p = dialogCapture(rowsFrom(planParts()), COLS);
    assert.deepEqual(p.options[2], { n: 3, label: 'Tell Claude what to change', text: true });
    assert.deepEqual(Object.keys(p), ['state', 'kind', 'at', 'sig', 'bypass', 'options']);
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
        assert.deepEqual(got, want);
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
