import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as mode from '../src/mode.js';
import {
  MODES, MODE_TARGETS, PROMPT_ROWS, FOOTER, OPTION, rowText, lastNonBlank, modeFromRows, promptFromRows, mentionsBypass, bypassWindow,
  surveyShown, followUpShown, surveyOrFollowUpShown, pillShown, SHELL_FOOTER, ASK_FOOTER, PLAN_FOOTER, REVIEW_END, isDialogEnd, nudgeFooterAt, footerEnd, taskBlockAbove,
} from '../src/mode.js';
import { parseCapture } from '../src/mirror.js';
import { dialogCapture } from '../src/dialog.js';
import { promptSig } from '../src/session-control.js';
import { subagentRows, taskRows, taskScreen, taskMisfits } from './helpers.js';

const DEF = { b: false, fg: null, bg: null, u: false, i: false, d: false };
const span = (t, s = DEF) => ({ t, s });
/** One string per row ('' = blank row); an array stays as given (to split a row across spans). */
const rowsOf = (...lines) => lines.map((l) => (Array.isArray(l) ? l : l === '' ? [] : [span(l)]));

// Phrases typed by hand from docs/contracts/claude-tui.md section 1.
const PHRASE = {
  auto: '\u23f5\u23f5 auto mode on',
  manual: '\u23f8 manual mode on',
  acceptEdits: '\u23f5\u23f5 accept edits on',
  plan: '\u23f8 plan mode on',
  dontAsk: '\u23f5\u23f5 don\'t ask on',
};
const BOX = ['\u2502 > \u2502', '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f'];
const SUFFIX = ' (shift+tab to cycle) \u00b7 \u2190 for agents';

describe('constants', () => {
  test('(+) MODES, MODE_TARGETS, PROMPT_ROWS hold the contract values', () => {
    assert.deepEqual(MODES, ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']);
    assert.deepEqual(MODE_TARGETS, ['manual', 'acceptEdits', 'plan', 'auto']);
    assert.equal(PROMPT_ROWS, 15);
  });

  test('(−) bypassPermissions and dontAsk are never a target; FOOTER_ROWS is gone', () => {
    assert.ok(!MODE_TARGETS.includes('bypassPermissions'));
    assert.ok(!MODE_TARGETS.includes('dontAsk'));
    assert.ok(MODE_TARGETS.every((m) => MODES.includes(m)));
    assert.equal('FOOTER_ROWS' in mode, false);
  });
});

describe('OPTION', () => {
  test('(+) is exported and reads the number and the label of an option row, with or without the selection marker', () => {
    assert.deepEqual(OPTION.exec('  2. Yes, and more')?.slice(1), ['2', 'Yes, and more']);
    assert.deepEqual(OPTION.exec('❯ 1. Yes')?.slice(1), ['1', 'Yes']);
    assert.equal(OPTION.exec('10. ten')?.[1], '10', 'a two-digit number is seen so that it can be refused');
  });

  test('(−) a wrapped label row, a number without a dot and prose do not match', () => {
    for (const row of ['      wrapped label', '2 Yes', 'Do you want to proceed?', '1.Yes', '']) assert.equal(OPTION.exec(row), null, row);
  });
});

describe('rowText', () => {
  test('(+) concatenates the spans of a row', () => {
    assert.equal(rowText([span('ab'), span('cd', { ...DEF, b: true })]), 'abcd');
    assert.equal(rowText([]), '');
  });

  test('(−) a malformed row gives an empty string, never throws', () => {
    assert.equal(rowText(null), '');
    assert.equal(rowText(undefined), '');
    assert.equal(rowText([{}, null, span('x')]), 'x');
  });
});

describe('lastNonBlank', () => {
  test('(+) returns the texts of the last n non-blank rows, oldest first, blank rows skipped', () => {
    const rows = rowsOf('a', '', 'b', [span('  ')], [span('c'), span('d')], '');
    assert.deepEqual(lastNonBlank(rows, 2), ['b', 'cd']);
    assert.deepEqual(lastNonBlank(rows, 3), ['a', 'b', 'cd']);
    assert.deepEqual(lastNonBlank(rows, 1), ['cd']);
    assert.deepEqual(lastNonBlank(rows, 99), ['a', 'b', 'cd'], 'n above the row count gives all of them');
    assert.deepEqual(lastNonBlank(rowsOf('  x  '), 1), ['  x  '], 'row text is returned as is, not trimmed');
  });

  test('(+) PROMPT_ROWS gives the window promptFromRows reads', () => {
    const rows = rowsOf(...Array.from({ length: PROMPT_ROWS + 5 }, (_, i) => `row ${i}`));
    const win = lastNonBlank(rows, PROMPT_ROWS);
    assert.equal(win.length, PROMPT_ROWS);
    assert.equal(win[0], 'row 5');
    assert.equal(win.at(-1), `row ${PROMPT_ROWS + 4}`);
  });

  test('(−) n of zero, negative or not a positive integer gives an empty list', () => {
    const rows = rowsOf('a', 'b');
    for (const n of [0, -1, -0, 1.5, NaN, Infinity, '2', null, undefined]) {
      assert.deepEqual(lastNonBlank(rows, n), [], String(n));
    }
  });

  test('(−) empty, all-blank and malformed rows give an empty list, never throw', () => {
    assert.deepEqual(lastNonBlank([], 3), []);
    assert.deepEqual(lastNonBlank(rowsOf('', [span(' ')]), 3), []);
    for (const bad of [null, undefined, 'abc', 7, {}]) assert.deepEqual(lastNonBlank(bad, 3), [], String(bad));
    assert.deepEqual(lastNonBlank([null, [{}], [null], rowsOf('x')[0]], 5), ['x']);
  });
});

describe('modeFromRows: footer', () => {
  test('(+) each FOOTER phrase in the last row maps to its mode', () => {
    const modes = FOOTER.map((f) => f.mode);
    assert.deepEqual([...modes].sort(), ['acceptEdits', 'auto', 'dontAsk', 'manual', 'plan']);
    for (const f of FOOTER) {
      assert.ok(f.match instanceof RegExp && f.match.flags.includes('i'), `${f.mode} is case-insensitive`);
      assert.equal(modeFromRows(rowsOf('some transcript line', ...BOX, PHRASE[f.mode])), f.mode, f.mode);
    }
  });

  test('(+) the positive Manual marker maps to manual', () => {
    assert.equal(modeFromRows(rowsOf(...BOX, PHRASE.manual)), 'manual');
  });

  test('(+) a phrase split across spans still matches', () => {
    const footer = [span('\u23f5\u23f5 ac'), span('cept ed', { ...DEF, fg: 147 }), span('its on')];
    assert.equal(modeFromRows(rowsOf(...BOX, footer)), 'acceptEdits');
  });

  test('(+) the shortest distinctive token alone matches (narrow pane)', () => {
    assert.equal(modeFromRows(rowsOf('auto mode')), 'auto');
    assert.equal(modeFromRows(rowsOf('manual mode')), 'manual');
    assert.equal(modeFromRows(rowsOf('accept edits')), 'acceptEdits');
    assert.equal(modeFromRows(rowsOf('plan mode')), 'plan');
    assert.equal(modeFromRows(rowsOf('don\'t ask')), 'dontAsk');
  });

  test('(+) the vim prefix and the cycle / agents suffix do not disturb matching', () => {
    for (const [m, p] of Object.entries(PHRASE)) {
      assert.equal(modeFromRows(rowsOf(...BOX, `-- INSERT -- ${p}${SUFFIX}`)), m, `${m} insert`);
      assert.equal(modeFromRows(rowsOf(...BOX, `-- NORMAL -- ${p}${SUFFIX}`)), m, `${m} normal`);
    }
  });

  test('(+) a typographic apostrophe in "don\u2019t ask" matches', () => {
    assert.equal(modeFromRows(rowsOf(...BOX, '\u23f5\u23f5 don\u2019t ask on')), 'dontAsk');
  });

  test('(+) matching is case-insensitive', () => {
    assert.equal(modeFromRows(rowsOf('\u23f5\u23f5 AUTO MODE ON')), 'auto');
    assert.equal(modeFromRows(rowsOf('Plan Mode')), 'plan');
  });

  test('(+) trailing blank and whitespace-only rows are skipped', () => {
    assert.equal(modeFromRows(rowsOf(...BOX, PHRASE.plan, '', [span('   ')], '', '')), 'plan');
  });

  test('(+) a status line above the footer is ignored, the footer decides', () => {
    assert.equal(modeFromRows(rowsOf('plan mode \u00b7 main \u2713', ...BOX, PHRASE.auto)), 'auto');
    assert.equal(modeFromRows(rowsOf('auto mode \u00b7 main', ...BOX, PHRASE.manual)), 'manual');
  });

  test('(+) works on rows parsed from a real capture string', () => {
    const rows = parseCapture(`transcript\n${BOX[0]}\n\u001b[38;5;73m${PHRASE.plan}\u001b[0m${SUFFIX}\n\n`, 80);
    assert.equal(modeFromRows(rows), 'plan');
  });

  test('(+) an unrecognized footer containing "bypass" gives bypassPermissions', () => {
    assert.equal(modeFromRows(rowsOf(...BOX, '\u23f5\u23f5 bypass permissions on (shift+tab to cycle)')), 'bypassPermissions');
    assert.equal(modeFromRows(rowsOf('BYPASS')), 'bypassPermissions');
  });

  test('(−) empty or all-blank rows give unknown', () => {
    assert.equal(modeFromRows([]), 'unknown');
    assert.equal(modeFromRows(rowsOf('', [span('  ')], '')), 'unknown');
  });

  test('(−) no phrase and no Manual marker gives unknown, never manual', () => {
    assert.equal(modeFromRows(rowsOf('hello', ...BOX, '? for shortcuts')), 'unknown');
    assert.equal(modeFromRows(rowsOf(...BOX, '\u23f8 mode on')), 'unknown');
    assert.equal(modeFromRows(rowsOf(...BOX, '\u23f5\u23f5 accept on')), 'unknown');
  });

  test('(−) a phrase only above the last non-blank row gives unknown', () => {
    assert.equal(modeFromRows(rowsOf(PHRASE.auto, '? for shortcuts')), 'unknown');
    assert.equal(modeFromRows(rowsOf(PHRASE.plan, ...BOX, 'main \u2713', '', '')), 'unknown');
    assert.equal(modeFromRows(rowsOf('bypass', ...BOX, '? for shortcuts')), 'unknown');
  });

  test('(−) slash-menu overlay rows in place of the footer give unknown', () => {
    const menu = [
      '/model       Switch the model',
      '/permissions Manage allow, ask and deny rules',
      '/plan        Enter plan mode',
    ];
    assert.equal(modeFromRows(rowsOf(...BOX, ...menu)), 'unknown');
    assert.equal(modeFromRows(rowsOf(...BOX, '  /plan        Enter plan mode')), 'unknown');
    assert.equal(modeFromRows(rowsOf(...BOX, '\u276f /plan      Enter plan mode')), 'unknown');
  });

  test('(−) a token that is not at the start of the last row gives unknown', () => {
    const cases = [
      'docs/plan mode notes.md',
      'Press shift+tab to leave plan mode',
      '  ! for bash mode   shift + tab to auto-accept edits',
      '        plan mode', // wrapped description: indented by more than 2 spaces
      '\u2502 /plan  Enter plan mode',
      'see auto mode on the status line',
      '\u2502 \u23f8 manual mode on',
    ];
    for (const row of cases) assert.equal(modeFromRows(rowsOf(...BOX, row)), 'unknown', row);
  });

  test('(−) "bypass" not at the start of the last row, or as part of a file name, gives unknown', () => {
    for (const row of ['bypass.js', 'bypass/list.txt', 'docs bypass notes', '\u2502 bypass permissions on', '        bypass', 'bypassing the check', 'bypassed']) {
      assert.equal(modeFromRows(rowsOf(...BOX, row)), 'unknown', row);
    }
  });

  test('(+) up to two spaces of indent still match; the anchored token decides when two are in a row', () => {
    assert.equal(modeFromRows(rowsOf(...BOX, ' \u23f8 plan mode on')), 'plan');
    assert.equal(modeFromRows(rowsOf(...BOX, '  plan mode')), 'plan');
    assert.equal(modeFromRows(rowsOf(...BOX, `${PHRASE.acceptEdits} (shift+tab to cycle to plan mode)`)), 'acceptEdits');
    assert.equal(modeFromRows(rowsOf(...BOX, `${PHRASE.plan} \u00b7 leave auto mode off`)), 'plan');
    assert.equal(modeFromRows(rowsOf(...BOX, `${PHRASE.plan} \u00b7 bypass`)), 'plan', 'a later "bypass" does not count');
    assert.equal(modeFromRows(rowsOf(...BOX, '\u23f5\u23f5 bypassPermissions on')), 'bypassPermissions');
    assert.equal(modeFromRows(rowsOf(...BOX, `-- NORMAL -- \u23f5\u23f5 bypass permissions on${SUFFIX}`)), 'bypassPermissions');
  });

  test('(−) a phrase quoted in transcript text, not in footer position, gives unknown', () => {
    const rows = rowsOf(
      'The footer shows \u23f5\u23f5 auto mode on when it is active and plan mode otherwise.',
      '', ...BOX, '? for shortcuts',
    );
    assert.equal(modeFromRows(rows), 'unknown');
  });

  test('(−) a permission prompt covering the footer gives unknown', () => {
    const rows = rowsOf(
      'Do you want to proceed?', '\u276f 1. Yes, and switch to auto mode', '  2. No', 'Esc to cancel \u00b7 Tab to amend',
    );
    // The hint is the last row; the option text above it never counts.
    assert.equal(modeFromRows(rows), 'unknown');
  });

  test('(−) malformed input gives unknown, never throws', () => {
    for (const bad of [null, undefined, 'auto mode', 42, {}, [null], [[{}]], [[null]]]) {
      assert.equal(modeFromRows(bad), 'unknown', String(bad));
    }
  });
});

describe('promptFromRows', () => {
  const HINT = 'Esc to cancel \u00b7 Tab to amend';

  test('(+) 4-option prompt as Claude draws it: marker, wrapped label joined with one space, hint', () => {
    const rows = rowsOf(
      'Bash command',
      'Run the build script',
      '\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c',
      'npm run build',
      '\u254c\u254c\u254c\u254c\u254c\u254c\u254c\u254c',
      'Do you want to proceed?',
      '\u276f 1. Yes',
      '  2. Yes, and always allow access to demo from this',
      '     project',
      '  3. Yes, and switch to auto mode \u00b7 auto mode handles these prompts for you',
      '  4. No',
      HINT,
    );
    assert.deepEqual(promptFromRows(rows), {
      question: 'Do you want to proceed?',
      options: [
        { n: 1, label: 'Yes' },
        { n: 2, label: 'Yes, and always allow access to demo from this project' },
        { n: 3, label: 'Yes, and switch to auto mode \u00b7 auto mode handles these prompts for you' },
        { n: 4, label: 'No' },
      ],
    });
  });

  test('(+) 3-option prompt: n = 1..3, labels cleaned and at most 80 chars', () => {
    const long = `Yes, and allow ${'x'.repeat(200)}`;
    const p = promptFromRows(rowsOf('Edit file?', `\u276f 1. ${long}`, '  2. Yes, all edits', '  3. No', HINT));
    assert.deepEqual(p.options.map((o) => o.n), [1, 2, 3]);
    assert.equal(p.options[0].label.length, 80);
    assert.ok(p.options[0].label.startsWith('Yes, and allow xxx'));
    assert.deepEqual(p.options.slice(1), [{ n: 2, label: 'Yes, all edits' }, { n: 3, label: 'No' }]);
  });

  test('(+) 2-option prompt', () => {
    assert.deepEqual(promptFromRows(rowsOf('Proceed?', '\u276f 1. Yes', '  2. No', HINT)), {
      question: 'Proceed?',
      options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }],
    });
  });

  test('(+) the selection marker may sit on any option and indentation varies', () => {
    const p = promptFromRows(rowsOf('Proceed?', '  1. Yes', '\u276f 2. No', 'Esc to cancel'));
    assert.deepEqual(p.options, [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }]);
  });

  test('(+) blank rows after the hint are ignored and the question is cleaned to at most 200 chars', () => {
    const q = `${'Q'.repeat(250)}?`;
    const p = promptFromRows(rowsOf(q, '1. Yes', '2. No', HINT, '', [span('  ')]));
    assert.equal(p.question.length, 200);
    assert.equal(p.options.length, 2);
  });

  test('(+) works on rows parsed from a real capture string', () => {
    const rows = parseCapture(`old\n Proceed?\n \u001b[36m\u276f 1. Yes\u001b[0m\n   2. No\n ${HINT}\n`, 80);
    assert.deepEqual(promptFromRows(rows), { question: 'Proceed?', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] });
  });

  test('(−) a numbered list in the transcript without a question line gives null', () => {
    assert.equal(promptFromRows(rowsOf('Steps:', '1. Install', '2. Build', '', '\u2502 > \u2502', '? for shortcuts')), null);
    // Hint present but the row above option 1 is not a question.
    assert.equal(promptFromRows(rowsOf('Steps:', '1. Install', '2. Build', HINT)), null);
    // Option 1 is the first row: nothing above it.
    assert.equal(promptFromRows(rowsOf('1. Yes', '2. No', HINT)), null);
  });

  test('(−) no closing hint row gives null', () => {
    assert.equal(promptFromRows(rowsOf('Proceed?', '\u276f 1. Yes', '  2. No')), null);
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. Yes', '2. No', 'Tab to amend')), null);
  });

  test('(−) options not consecutive from 1 give null', () => {
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. Yes', '3. No', HINT)), null, 'gap');
    assert.equal(promptFromRows(rowsOf('Proceed?', '2. Yes', '3. No', HINT)), null, 'starts at 2');
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. Yes', '1. No', HINT)), null, 'duplicate');
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. Yes', '3. Maybe', '2. No', HINT)), null, 'out of order');
  });

  test('(−) fewer than two options give null', () => {
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. Yes', HINT)), null);
  });

  test('(−) a question that does not end with "?" gives null', () => {
    assert.equal(promptFromRows(rowsOf('Proceed', '1. Yes', '2. No', HINT)), null);
    assert.equal(promptFromRows(rowsOf('Proceed? yes', '1. Yes', '2. No', HINT)), null);
  });

  test('(−) an unindented row without a number between options gives null', () => {
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. Yes', 'stray', '2. No', HINT)), null);
  });

  test('(−) an empty label gives null', () => {
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. Yes', [span('2.   ')], HINT)), null);
    assert.equal(promptFromRows(rowsOf('Proceed?', '1. \u0007\u202e', '2. No', HINT)), null);
  });

  test('(−) control characters and bidi marks in a label or the question are removed', () => {
    const p = promptFromRows(rowsOf('Run it\u202e\u0007?', '1. Yes\u202e\u0007 proceed\u200b now', '2. N\u001bo', HINT));
    assert.equal(p.question, 'Run it ?');
    assert.deepEqual(p.options, [{ n: 1, label: 'Yes proceed now' }, { n: 2, label: 'N o' }]);
    const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
    for (const o of p.options) assert.doesNotMatch(o.label, unsafe);
  });

  test('(−) the folder-trust dialog (unnumbered options, Enter to confirm) gives null', () => {
    const rows = rowsOf(
      'Do you trust the files in this folder?',
      '\u276f Yes, I trust this folder',
      '  No, exit',
      'Enter to confirm \u00b7 Esc to cancel',
    );
    assert.equal(promptFromRows(rows), null);
  });

  test('(−) a non-blank row below the hint row gives null (stale prompt above a prompt box)', () => {
    const prompt = ['Proceed?', '1. Yes', '2. No', HINT];
    assert.ok(promptFromRows(rowsOf(...prompt)), 'control: the same block as the last rows parses');
    assert.equal(promptFromRows(rowsOf(...prompt, ...BOX, PHRASE.manual)), null, 'prompt box and footer drawn after it');
    assert.equal(promptFromRows(rowsOf(...prompt, 'x')), null, 'a single row below');
    assert.equal(promptFromRows(rowsOf(...prompt, '', 'x', '')), null, 'blank rows do not hide it');
    assert.equal(promptFromRows(rowsOf(...prompt, HINT, 'x')), null, 'a second hint is not last either');
  });

  test('(−) the question must lie within the last PROMPT_ROWS non-blank rows', () => {
    // Question + option 1 + k wrapped rows + option 2 + hint = k + 4 rows.
    const block = (k) => [
      'Proceed?', '1. Yes', ...Array.from({ length: k }, (_, i) => `     wrapped ${i}`), '2. No', HINT,
    ];
    const exact = promptFromRows(rowsOf('older row', ...block(PROMPT_ROWS - 4)));
    assert.equal(exact.options.length, 2, 'exactly PROMPT_ROWS rows parse');
    assert.ok(exact.options[0].label.startsWith('Yes wrapped 0 wrapped 1'));
    // One more row pushes the question out of the window.
    assert.equal(promptFromRows(rowsOf('older row', ...block(PROMPT_ROWS - 3))), null);
    // Blank rows do not count against the window.
    assert.ok(promptFromRows(rowsOf('', ...block(PROMPT_ROWS - 4).flatMap((r) => [r, '']))));
  });

  test('(−) option numbers are one digit: an 11-option list gives null', () => {
    const list = (k, pad = '') => Array.from({ length: k }, (_, i) => `${pad}${i + 1}. Option ${i + 1}`);
    assert.equal(promptFromRows(rowsOf('Proceed?', ...list(9), HINT)).options.length, 9, 'control: 9 options parse');
    assert.equal(promptFromRows(rowsOf('Proceed?', ...list(10), HINT)), null, '10 options');
    assert.equal(promptFromRows(rowsOf('Proceed?', ...list(11), HINT)), null, '11 options');
    assert.equal(promptFromRows(rowsOf('Proceed?', ...list(11, '  '), HINT)), null, '11 indented options');
    // An indented "10." row must not be glued to option 9 as a wrapped label.
    assert.equal(promptFromRows(rowsOf('Proceed?', ...list(9), '  10. Option 10', HINT)), null);
  });

  test('(−) empty or malformed input gives null, never throws', () => {
    assert.equal(promptFromRows([]), null);
    assert.equal(promptFromRows(rowsOf('', '')), null);
    for (const bad of [null, undefined, 'Esc to cancel', 7, {}, [null], [[{}]]]) {
      assert.equal(promptFromRows(bad), null, String(bad));
    }
  });
});

describe('mentionsBypass', () => {
  test('(+) the word in any case, width, spacing, punctuation or invisible characters is found', () => {
    for (const t of ['bypass', 'Yes, and BYPASS permissions', 'b-y-p-a-s-s', 'b y p a s s', '\uff42\uff59\uff50\uff41\uff53\uff53 mode', 'by\u200bpass', 'by\u00adpass', 'BYPASS_permissions']) {
      assert.equal(mentionsBypass(t), true, JSON.stringify(t));
    }
  });

  test('(−) text without the word, and the empty string, are not bypass', () => {
    for (const t of ['', 'Yes', 'Do you want to proceed?', 'allow edits for this session', 'by pas']) {
      assert.equal(mentionsBypass(t), false, JSON.stringify(t));
    }
  });
});

describe('bypassWindow', () => {
  const filler = Array.from({ length: PROMPT_ROWS }, (_, i) => `output row ${i}`);

  test('(+) a bypass word in any of the last PROMPT_ROWS non-blank rows, blank rows skipped, any spelling', () => {
    assert.equal(bypassWindow(rowsOf('Switch to bypass permissions mode?', ...filler.slice(1))), true, 'the oldest row of the window');
    assert.equal(bypassWindow(rowsOf('old', '', 'Yes, and BY-PASS permissions', '', '')), true);
    assert.equal(bypassWindow(rowsOf('b y p a s s')), true);
  });

  test('(−) older than the window, absent, or not rows at all: false, never throws', () => {
    assert.equal(bypassWindow(rowsOf('the word bypass', ...filler)), false, 'one row too old');
    assert.equal(bypassWindow(rowsOf('Do you want to proceed?', '1. Yes', '2. No')), false);
    for (const bad of [null, undefined, 'bypass', 5, [], {}]) assert.equal(bypassWindow(bad), false, String(bad));
  });
});

// ---- F2: the subagent list Claude draws BELOW the footer (live capture, Claude Code 2.1.325) ---------------------------------
describe('subagent list below the footer', () => {
  const head = (footer = PHRASE.auto) => rowsOf('transcript line', ...BOX, '  Haiku 5.5  acme-api  master', footer);
  const BUSY = '⏸ manual mode on · esc to interrupt · ↓ to manage';
  const TASKS = `${PHRASE.auto} (shift+tab to cycle) · /tasks to see subagents`;
  const two = [{ label: 'List project files', elapsed: '0s', tokens: null }, { label: 'Count lines', elapsed: '1m 11s', tokens: '↑ 50' }];

  test('(+) one agent, two agents and the busy / tasks footers: the mode is read through the block', () => {
    for (const n of [1, 2]) assert.equal(modeFromRows([...head(), ...subagentRows({ agents: n })]), 'auto', `${n} agents`);
    assert.equal(modeFromRows([...head(BUSY), ...subagentRows({ agents: 2 })]), 'manual', 'busy parent');
    assert.equal(modeFromRows([...head(TASKS), ...subagentRows({ agents: 1 })]), 'auto', '/tasks variant');
    assert.equal(modeFromRows([...head(`-- INSERT -- ${PHRASE.plan}`), ...subagentRows({ agents: 2 })]), 'plan', 'vim insert prefix');
    assert.equal(modeFromRows([...head(), ...subagentRows({ agents: two })]), 'auto', 'no tokens yet, minutes, up arrow');
  });

  test('(+) the captured shapes: elapsed, tokens, a truncated label at 60 columns, five agents and the overflow row', () => {
    const labels = [{ label: 'Grep the demo project o…', elapsed: '19s' }, { label: 'x', elapsed: '2h 3m 4s', tokens: '↓ 1.2m' }, { label: 'y', elapsed: '3m', tokens: '↑ 300' }];
    assert.equal(modeFromRows([...head(), ...subagentRows({ cols: 60, agents: labels })]), 'auto');
    assert.equal(modeFromRows([...head(), ...subagentRows({ agents: 5, more: 3 })]), 'auto');
    assert.equal(modeFromRows([...head(), ...subagentRows({ agents: 1, more: 12 })]), 'auto');
  });

  test('(+) lastNonBlank skips the block, so every reader of the footer row sees the footer', () => {
    const rows = [...head(), ...subagentRows({ agents: 2, more: 2 }), [], []];
    assert.deepEqual(lastNonBlank(rows, 2), ['  Haiku 5.5  acme-api  master', PHRASE.auto]);
    assert.equal(lastNonBlank(rows, 1)[0], PHRASE.auto);
  });

  test('(+) the bash footer and the vim prefix are read through the block too', () => {
    const rows = [...rowsOf(...BOX, '-- INSERT -- ! for shell mode'), ...subagentRows({ agents: 1 })];
    assert.ok(SHELL_FOOTER.test(lastNonBlank(rows, 1)[0]));
  });

  test('(+) a label shaped like a footer, a rule, a main row or Esc to cancel is only a label', () => {
    const fake = ['⏵⏵ auto mode on', '⏸ manual mode on', '─'.repeat(40), '  ⏺ main', 'Esc to cancel', '-- INSERT --', 'bypass permissions on'];
    for (const label of fake) {
      assert.equal(modeFromRows([...head(PHRASE.plan), ...subagentRows({ agents: [{ label }, { label }] })]), 'plan', label);
      assert.equal(lastNonBlank([...head(PHRASE.plan), ...subagentRows({ agents: [{ label }] })], 1)[0], PHRASE.plan, label);
    }
  });

  test('(−) a label that looks like a footer fakes nothing when no real mode line sits above the block', () => {
    for (const above of ['Esc to cancel', '? for shortcuts', '  some dialog row', '1. Yes']) {
      const rows = [...rowsOf('Do you want to proceed?', above), ...subagentRows({ agents: [{ label: PHRASE.auto }] })];
      assert.equal(modeFromRows(rows), 'unknown', above);
      assert.equal(lastNonBlank(rows, 1)[0].includes('◯'), true, 'the block stays: nothing is hidden above a row that is not a mode line');
    }
  });

  test('(−) the block must be exactly the captured shape; anything else below the footer is unknown', () => {
    const block = subagentRows({ agents: 2 });
    const agent = block.at(-1);
    const bad = {
      'no blank row': subagentRows({ agents: 2, blank: false }),
      'no main row': subagentRows({ agents: 2, main: false }),
      'junk instead of the blank row': [rowsOf('junk')[0], ...block.slice(1)],
      'two blank rows': [[], ...block],
      'a blank row inside': [...block.slice(0, 2), [], ...block.slice(2)],
      'junk after the block': [...block, rowsOf('junk')[0]],
      'junk between main and the agents': [...block.slice(0, 2), rowsOf('junk')[0], ...block.slice(2)],
      'main with a suffix': [block[0], rowsOf('  ⏺ main (selected)')[0], ...block.slice(2)],
      'main with other indent': [block[0], rowsOf('    ⏺ main')[0], ...block.slice(2)],
      'no agent rows': subagentRows({ agents: 0 }),
      'overflow row without agents': subagentRows({ agents: 0, more: 2 }),
      'overflow row before an agent row': [...block.slice(0, 2), rowsOf('  ↓ 2 more')[0], agent],
      'an up arrow overflow row': [...block, rowsOf('  ↑ 2 more')[0]],
      'two overflow rows': [...block, rowsOf('  ↓ 2 more')[0], rowsOf('  ↓ 2 more')[0]],
      'agent glyph changed': [...block.slice(0, 2), rowsOf('  ● Explore  A  5s')[0]],
      'agent indent changed': [...block.slice(0, 2), rowsOf(' ◯ Explore  A  5s')[0]],
      'agent without the two spaces after the type': [...block.slice(0, 2), rowsOf('  ◯ Explore A  5s')[0]],
      // K2 note 1: 'agent without an elapsed time', 'elapsed time not at the end' and 'tokens without the arrow' were (−) rows here; the end of
      // an agent row is no longer read (a live row had none), so they are text now and pinned as such in the K2 note 1 describe below.
      'wrapped label': [...block.slice(0, 2), rowsOf('  ◯ Explore  A very long label that wrapped')[0], rowsOf('  onto a second row  5s')[0]],
    };
    for (const [name, extra] of Object.entries(bad)) {
      const rows = [...head(), ...extra];
      assert.equal(modeFromRows(rows), 'unknown', name);
      assert.notEqual(lastNonBlank(rows, 1)[0], PHRASE.auto, name);
    }
  });

  test('(−) junk below the footer without a block stays unknown, and so does a block under a non-footer row', () => {
    assert.equal(modeFromRows([...head(), ...rowsOf('', 'junk')]), 'unknown');
    assert.equal(modeFromRows([...rowsOf(...BOX, 'main ✓', ''), ...subagentRows({ agents: 1 })]), 'unknown');
    assert.equal(modeFromRows([...rowsOf(PHRASE.auto, 'status line'), ...subagentRows({ agents: 1 })]), 'unknown', 'a footer two rows up does not count');
  });

  test('(−) a block with no row above it, or only blanks above, is not stripped (never throws)', () => {
    assert.equal(modeFromRows(subagentRows({ agents: 1 })), 'unknown');
    assert.equal(modeFromRows([[], ...subagentRows({ agents: 1 })]), 'unknown');
    assert.deepEqual(lastNonBlank(subagentRows({ agents: 1 }), 1).length, 1);
  });
});

// ---- K2 (0.5.1): background-work rows under the input box (live, Claude Code 2.1.326) ------------------------------------------
// An agent whose turn ended but whose own background shell runs is drawn `  <U+25EF> <type>  waiting on <n> shell(s) <U+00B7> <label> <U+00B7> since
// <h:mm AM|PM>`: the label moved into the status and no elapsed time ends the row. AGENT_ROW required that time, so the list was not cut, the
// footer read `unknown` and the capture had `draft: null`. Every text below is made up; only the row shapes follow the live captures.
describe('subagent list: waiting and stopped rows (K2)', () => {
  const head = (footer = PHRASE.manual) => rowsOf('transcript line', ...BOX, '  Haiku 5.5  acme-api  master', footer);
  const pill = (n = 1) => `${PHRASE.manual} · ${n} shell${n === 1 ? '' : 's'} · ↓ to manage`;
  /** The blank row and `  <U+23FA> main`, then the given agent rows (strings). */
  const list = (...agentRows) => [...subagentRows({ agents: 0 }), ...rowsOf(...agentRows)];
  const waiting = (label = 'Tidy the notes', { n = 1, at = '4:48 PM', type = 'general-purpose' } = {}) =>
    `  ◯ ${type}  waiting on ${n} shell${n === 1 ? '' : 's'} · ${label} · since ${at}`;
  const running = '  ◯ Explore  Count the lines                                       3s · ↓ 36.0k tokens';
  const stopped = '  ◯ Explore  Read the log                                          stopped · 1m 52s · ↓ 36.3k tokens';

  const readsThrough = (rows, mode, label) => {
    assert.equal(modeFromRows(rows), mode, label);
    assert.equal(lastNonBlank(rows, 1)[0], rowText(rows.find((r) => /mode on/.test(rowText(r)))), `${label}: the footer is the last row`);
  };

  test('(+) one waiting row, with the shells pill on the footer: the mode is read through the block', () => {
    readsThrough([...head(pill(1)), ...list(waiting())], 'manual', 'one shell');
    readsThrough([...head(pill(2)), ...list(waiting('Tidy the notes', { n: 2 }))], 'manual', 'two shells');
    readsThrough([...head(`-- INSERT -- ${pill(1)}`), ...list(waiting())], 'manual', 'vim insert prefix');
    readsThrough([...head(pill(12)), ...list(waiting('Tidy the notes', { n: 12 }))], 'manual', 'twelve shells');
  });

  test('(+) waiting, running and stopped rows mixed, with the overflow row: one block', () => {
    const rows = [...head(pill(2)), ...list(waiting('Sort the files', { type: 'Explore' }), running, stopped, '  ◯ Explore  Sum the rows  stopped · 57s'), ...rowsOf('  ↓ 2 more')];
    readsThrough(rows, 'manual', 'mixed block');
    assert.equal(footerEnd(rows.map(rowText)), 4, 'footerEnd is the mode line');
  });

  test('(+) the hover pointer on a waiting row, on one row at most; hours and minutes of 1 to 12 and 00 to 59', () => {
    for (const at of ['1:05 AM', '9:59 AM', '12:00 PM', '11:30 PM']) readsThrough([...head(pill(1)), ...list(waiting('Tidy the notes', { at }))], 'manual', at);
    readsThrough([...head(pill(1)), ...list(waiting().replace(/^ {2}/, '❯ '))], 'manual', 'pointer on the waiting row');
    const two = [...head(pill(1)), ...list(waiting().replace(/^ {2}/, '❯ '), waiting('Other').replace(/^ {2}/, '❯ '))];
    assert.equal(modeFromRows(two), 'unknown', 'two pointer rows: not cut');
  });

  test('(+) a label cut with an ellipsis, or shaped like a footer, a main row or a time, is only a label', () => {
    for (const label of ['Grep the demo project o…', '⏵⏵ auto mode on', '⏸ manual mode on', '─'.repeat(30), '  ⏺ main', 'Esc to cancel', 'x · since 1:00 AM', 'sleeps 5s', '-- INSERT --']) {
      const rows = [...head(pill(1)), ...list(waiting(label), waiting(label, { n: 2 }))];
      assert.equal(modeFromRows(rows), 'manual', label);
      assert.equal(lastNonBlank(rows, 1)[0], pill(1), label);
    }
  });

  test('(+) pinned, already read before K2: the elapsed, tokens and stopped rows and the shells pill on every footer', () => {
    for (const [name, rows] of [['elapsed only', list('  ◯ Explore  Count the lines                    0s')], ['elapsed and tokens', list(running)], ['stopped with tokens', list(stopped)],
      ['stopped, time only', list('  ◯ Explore  Sum the rows  stopped · 57s')], ['stopped, pointer', list(stopped.replace(/^ {2}/, '❯ '))]]) {
      readsThrough([...head(pill(1)), ...rows], 'manual', name);
    }
    for (const footer of [pill(1), pill(3), `${PHRASE.manual} · 2 shells · enter to view tasks`, `${PHRASE.manual} · esc to interrupt · ↓ to manage`, `-- INSERT -- ${PHRASE.manual} · 1 shell`]) {
      readsThrough([...head(footer), ...list(running)], 'manual', footer);
    }
  });

  // K2 note 1 superseded the exact reading of the waiting row's ending (since clause, hour and minute ranges, the shell count and its word, the wording):
  // those rows are free text now (see 'the stricter forms of K2\'s first row are only text now' in the K2 note 1 describe). What stays a (−) is the prefix.
  test('(−) a row that only looks like an agent row is no row: the block stays, the footer reads unknown', () => {
    const w = waiting();
    const bad = {
      'one space after the type': '  ◯ general-purpose waiting on 1 shell · Tidy the notes · since 4:48 PM',
      'a type with a space': '  ◯ general purpose  waiting on 1 shell · Tidy the notes · since 4:48 PM',
      'agent glyph changed': w.replace('◯', '●'),
      'agent indent of one': w.slice(1),
      'agent indent of four': `  ${w}`,
      'the text of the row on a second row': ['  ◯ general-purpose  waiting on 1 shell · Tidy the notes', '  · since 4:48 PM'],
    };
    for (const [name, extra] of Object.entries(bad)) {
      const rows = [...head(pill(1)), ...list(...[].concat(extra))];
      assert.equal(modeFromRows(rows), 'unknown', name);
      assert.notEqual(lastNonBlank(rows, 1)[0], pill(1), name);
    }
  });

  test('(−) a waiting row does not weaken the other gates: no blank row, no main row, junk beside it, no mode line above', () => {
    const w = waiting();
    const block = list(w);
    const bad = {
      'no blank row': subagentRows({ agents: 0, blank: false }).concat(rowsOf(w)),
      'no main row': subagentRows({ agents: 0, main: false }).concat(rowsOf(w)),
      'junk instead of the blank row': [rowsOf('junk')[0], ...block.slice(1)],
      'junk after the waiting row': [...block, rowsOf('junk')[0]],
      'junk between main and the waiting row': [block[0], block[1], rowsOf('junk')[0], block[2]],
      'a blank row inside': [block[0], block[1], [], block[2]],
      'a waiting row before main': [block[0], rowsOf(w)[0], block[1]],
    };
    for (const [name, extra] of Object.entries(bad)) {
      const rows = [...head(pill(1)), ...extra];
      assert.equal(modeFromRows(rows), 'unknown', name);
      assert.notEqual(lastNonBlank(rows, 1)[0], pill(1), name);
    }
    for (const above of ['Esc to cancel', '? for shortcuts', '  some dialog row', `2 shells ${'·'} ↓ to manage`]) {
      const rows = [...rowsOf('Do you want to proceed?', above), ...block];
      assert.equal(modeFromRows(rows), 'unknown', above);
      assert.equal(lastNonBlank(rows, 1)[0].includes('◯'), true, `${above}: the block stays`);
    }
  });

  test('(−) the cut hides nothing from the bypass guard: bypassWindow still reads the literal bottom of the screen', () => {
    const rows = [...head(pill(1)), ...list(waiting('bypass the checks'))];
    assert.equal(modeFromRows(rows), 'manual');
    assert.equal(bypassWindow(rows), true, 'a label that mentions bypass is inside the guard window although the block is cut');
    assert.equal(bypassWindow([...head(pill(1)), ...list(waiting())]), false, 'and a label without it is not');
    const real = [...rowsOf('transcript line', ...BOX, '  Haiku 5.5  acme-api  master', 'bypass permissions on · 1 shell'), ...list(waiting())];
    assert.equal(modeFromRows(real), 'bypassPermissions');
  });
});

// ---- K2, note 1 (0.5.1): the activity row, seen live in Claude Code 2.1.326 in a pane 64 columns wide ----------------------------
// Under the mode line `-- INSERT -- <auto mode> · PR #17 · 3 shells` Claude drew `  <U+23FA> main` and `  <U+25EF> general-purpose  <text the agent wrote>`, then
// trailing spaces, and NO elapsed time or status at the end (a narrow pane cuts the suffix, or the row shows the agent's current activity). The row was no
// agent row, so the list was not cut, the footer read `unknown` and the message box said "nika can't read Claude's input box". The row is read by its
// prefix (glyph, indent, type, two spaces, some text) and only inside the block; the text and any suffix are not read. Every text below is made up.
describe('subagent list: the activity row, no suffix (K2, note 1)', () => {
  const NBSP = String.fromCharCode(0xa0);
  const LIVE = '-- INSERT -- ⏵⏵ auto mode on · PR #17 · 3 shells';
  const head = (footer = LIVE) => rowsOf('transcript line', ...BOX, '  Haiku 5.5  acme-api  master', footer);
  /** The blank row and `  <U+23FA> main`, then the given agent rows (strings, kept as given: trailing spaces too). */
  const list = (...agentRows) => [...subagentRows({ agents: 0 }), ...rowsOf(...agentRows)];
  const activity = (text = 'Closing a browser session', type = 'general-purpose') => `  ◯ ${type}  ${text}`;
  const live = (cols = 64, text) => activity(text).padEnd(cols);
  const readsThrough = (rows, mode, footer, label) => {
    assert.equal(modeFromRows(rows), mode, label);
    assert.equal(lastNonBlank(rows, 1)[0], footer, `${label}: the footer is the last row`);
  };

  test('(+) the live shape: the mode line with PR and shells, main, one activity row padded with spaces; the footer is the last row', () => {
    for (const cols of [64, 80, 120]) readsThrough([...head(), ...list(live(cols))], 'auto', LIVE, `${cols} columns`);
    readsThrough([...head(), ...list(activity())], 'auto', LIVE, 'no padding');
    const rows = [...head(), ...list(live())];
    assert.equal(footerEnd(rows.map(rowText)), 4, 'footerEnd is the mode line');
    assert.deepEqual(lastNonBlank(rows, 2), ['  Haiku 5.5  acme-api  master', LIVE]);
  });

  test('(+) the mode line alone reads through "· PR #n · N shells" for every mode, with or without the vim prefix, and through the block', () => {
    const tails = [' · PR #17 · 3 shells', ' · 1 shell', ' · PR #17 · 12 shells', ' · PR #17', ' · 2 shells · ↓ to manage'];
    const modes = [[PHRASE.auto, 'auto'], [PHRASE.manual, 'manual'], [PHRASE.acceptEdits, 'acceptEdits'], [PHRASE.plan, 'plan'], [PHRASE.dontAsk, 'dontAsk'], ['⏵⏵ bypass permissions on', 'bypassPermissions']];
    for (const [phrase, want] of modes) {
      for (const prefix of ['', '-- INSERT -- ', '-- NORMAL -- ']) {
        for (const tail of tails) {
          const footer = `${prefix}${phrase}${tail}`;
          assert.equal(modeFromRows(head(footer)), want, `${footer}: alone`);
          readsThrough([...head(footer), ...list(live())], want, footer, `${footer}: through the block`);
        }
      }
    }
  });

  test('(+) several activity rows, the pointer on one, the other row forms mixed in, and the overflow row: one block', () => {
    const waiting = '  ◯ general-purpose  waiting on 1 shell · Tidy the notes · since 4:48 PM';
    const running = '  ◯ Explore  Count the lines                                       3s · ↓ 36.0k tokens';
    const stopped = '  ◯ Explore  Read the log                                          stopped · 1m 52s · ↓ 36.3k tokens';
    readsThrough([...head(), ...list(live(), live(64, 'Sorting the notes'), live(64, 'Opening a page'))], 'auto', LIVE, 'three rows');
    readsThrough([...head(), ...list(live(), waiting, running, stopped, activity('Reading', 'Explore'))], 'auto', LIVE, 'mixed');
    readsThrough([...head(), ...list(live(), live()), ...rowsOf('  ↓ 4 more')], 'auto', LIVE, 'overflow row');
    readsThrough([...head(), ...list(live().replace(/^ {2}/, '❯ '), live())], 'auto', LIVE, 'pointer on the first row');
    readsThrough([...head(), ...list(live(), live().replace(/^ {2}/, '❯ '))], 'auto', LIVE, 'pointer on the last row');
  });

  test('(+) the text is only a label: a footer, a rule, a main row, a dialog footer, a bypass phrase or an old suffix in it fakes nothing', () => {
    const texts = ['⏵⏵ auto mode on', '⏸ manual mode on', '─'.repeat(30), '⏺ main', 'Esc to cancel', 'Enter to select · ↑/↓ to navigate', 'x · since 1:00 AM', 'waiting on 1 agent', 'stopped',
      '3s', '1. Yes', '-- INSERT --', 'bypass permissions on', 'ends with a dot.', 'a  b  c', 'Closing a browser session   ', 'Grep the demo project o…', 'x'.repeat(200), 'ÄÖ 日本語 🙂'];
    const real = `${PHRASE.plan} · PR #17 · 3 shells`;
    for (const text of texts) {
      readsThrough([...head(real), ...list(live(64, text), live(64, text))], 'plan', real, text);
    }
  });

  test('(+) the stricter forms of K2\'s first row are only text now: the suffix is not read at all', () => {
    const forms = ['waiting on 1 shell · Tidy the notes', 'waiting on 1 shell · Tidy the notes · since 4:48', 'waiting on 1 shell · Tidy the notes · since 16:48',
      'waiting on 0 shells · Tidy the notes · since 4:48 PM', 'waiting on 1 agent · Tidy the notes · since 4:48 PM', 'waiting on 1 shell ·  · since 4:48 PM',
      'Count the lines  tokens', 'Count the lines  5s and more', 'Count the lines  5s · 23 tokens', 'Tidy  waiting on 1 shell · Tidy the notes · since 4:48 PM · x'];
    for (const text of forms) readsThrough([...head(), ...list(live(64, text))], 'auto', LIVE, text);
  });

  test('(−) a row of this shape outside the block is no row: no main row, no blank row above main, junk or a plain row beside it, a row before main', () => {
    const row = live();
    const block = list(row);
    const bad = {
      'no main row': subagentRows({ agents: 0, main: false }).concat(rowsOf(row)),
      'no blank row above main': subagentRows({ agents: 0, blank: false }).concat(rowsOf(row)),
      'no blank row and no main row': rowsOf(row),
      'junk instead of the blank row': [rowsOf('junk')[0], ...block.slice(1)],
      'two blank rows': [[], ...block],
      'a blank row inside': [block[0], block[1], [], block[2]],
      'junk after the row': [...block, rowsOf('junk')[0]],
      'junk between main and the row': [block[0], block[1], rowsOf('junk')[0], block[2]],
      'the row before main': [block[0], rowsOf(row)[0], block[1]],
      'a second screen row of the same text, without the glyph': [...block, rowsOf('  browser session')[0]],
      'the text on two screen rows': [block[0], block[1], ...rowsOf('  ◯ general-purpose  Closing a', '  browser session')],
      'main with a suffix': [block[0], rowsOf('  ⏺ main (selected)')[0], block[2]],
      'main with other indent': [block[0], rowsOf('    ⏺ main')[0], block[2]],
      'two pointer rows': list(row.replace(/^ {2}/, '❯ '), row.replace(/^ {2}/, '❯ ')),
      'a pointer on main and on the row': [block[0], rowsOf('❯ ⏺ main')[0], rowsOf(row.replace(/^ {2}/, '❯ '))[0]],
    };
    for (const [name, extra] of Object.entries(bad)) {
      const rows = [...head(), ...extra];
      assert.equal(modeFromRows(rows), 'unknown', name);
      assert.notEqual(lastNonBlank(rows, 1)[0], LIVE, name);
    }
  });

  test('(−) a block under a row that is not a mode line or a dialog end stays: nothing above it is hidden, the mode is unknown', () => {
    for (const above of ['Esc to cancel', '? for shortcuts', '  some dialog row', '1. Yes', '  Haiku 5.5  acme-api  master', '2 shells · ↓ to manage', '']) {
      const rows = [...rowsOf('Do you want to proceed?', above), ...list(live())];
      assert.equal(modeFromRows(rows), 'unknown', above);
      assert.equal(lastNonBlank(rows, 1)[0].includes('◯'), true, `${above}: the block stays`);
    }
    const twoUp = [...rowsOf(PHRASE.auto, 'status line'), ...list(live())];
    assert.equal(modeFromRows(twoUp), 'unknown', 'a mode line two rows up does not count');
  });

  test('(−) a row in the transcript above the box is only text: nothing is cut and the mode line is still the last row', () => {
    const rows = [...rowsOf(live(), '', '  ⏺ main', live()), ...head()];
    readsThrough(rows, 'auto', LIVE, 'transcript');
  });

  test('(−) the row stays structural: glyph, indent, a type of one word, two spaces, then some text', () => {
    const row = live();
    const bad = {
      'glyph changed': row.replace('◯', '●'),
      'glyph is a letter': row.replace('◯', 'o'),
      'main glyph': row.replace('◯', '⏺'),
      'indent of one': row.slice(1),
      'indent of three': ` ${row}`,
      'indent of four': `  ${row}`,
      'a tab indent': `\t${row.slice(2)}`,
      'a pointer and a no-break space': row.replace(/^ {2}/, `❯${NBSP}`),
      'a pointer and two spaces': row.replace(/^ {2}/, '❯  '),
      'no-break space after the glyph': row.replace('◯ ', `◯${NBSP}`),
      'no type': '  ◯  Closing a browser session',
      'no type, three spaces': '  ◯   Closing a browser session',
      'two spaces and then only a no-break space': `  ◯ general-purpose  ${NBSP}`,
      'a line separator inside the text': `  ◯ general-purpose  Closing${String.fromCharCode(0x2028)} a browser session`,
      'a carriage return inside the text': '  ◯ general-purpose  Closing\r a browser session',
      'type only': '  ◯ general-purpose',
      'type only, padded': '  ◯ general-purpose'.padEnd(64),
      'type and two spaces': '  ◯ general-purpose  ',
      'type and no-break spaces': `  ◯ general-purpose${NBSP}${NBSP}`,
      'one space after the type': '  ◯ general-purpose Closing a browser session',
      'no-break spaces instead of the two spaces': `  ◯ general-purpose${NBSP}${NBSP}Closing a browser session`,
      'a type with a space': '  ◯ general purpose  Closing a browser session',
    };
    for (const [name, one] of Object.entries(bad)) {
      const rows = [...head(), ...list(one)];
      assert.equal(modeFromRows(rows), 'unknown', name);
      assert.notEqual(lastNonBlank(rows, 1)[0], LIVE, name);
    }
  });

  test('(−) the cut hides nothing from the bypass guard: bypassWindow still reads the literal bottom of the screen', () => {
    assert.equal(bypassWindow([...head(), ...list(live(64, 'bypass the checks'))]), true);
    assert.equal(bypassWindow([...head(), ...list(live())]), false);
    assert.equal(modeFromRows([...head('-- INSERT -- ⏵⏵ bypass permissions on · PR #17 · 3 shells'), ...list(live())]), 'bypassPermissions');
  });
});

// ---- D1: Claude's hover pointer on the list (spike D1-S, Claude Code 2.1.325) ---------------------------------------------------
// Hover draws `❯` and a plain space in columns 0-1 of one row under the mouse; nothing else changes. Keyboard selection draws the same
// row but replaces the mode line with a hint, so the block is not cut for it (gate 5).
describe('subagent list: the hover pointer', () => {
  const head = (footer = PHRASE.auto) => rowsOf('transcript line', ...BOX, '  Haiku 5.5  acme-api  master', footer);
  /** The block with the first two columns of row `at` (1 = main, 2.. = agents, last = overflow) replaced by `lead`. */
  const withLead = (block, at, lead) => block.map((r, i) => (i === at ? rowsOf(lead + rowText(r).slice(2))[0] : r));
  const HINT_MAIN = '-- INSERT -- ↑/↓ to select';
  const HINT_AGENT = '-- INSERT -- Enter to view · x to stop · ctrl+x ctrl+k to stop all agents';

  test('(+) a pointer on main, on the first agent or on the last agent row: the mode is read, the footer is the last row', () => {
    for (const cols of [120, 171]) {
      for (const [name, footer] of [['auto', PHRASE.auto], ['manual', PHRASE.manual], ['plan', `-- INSERT -- ${PHRASE.plan}`]]) {
        for (const pointer of ['main', 0, 2]) {
          const top = head(footer);
          const rows = [...top, ...subagentRows({ cols, agents: 3, pointer })];
          const label = `${name} ${cols} cols pointer ${pointer}`;
          assert.equal(modeFromRows(rows), name, label);
          assert.equal(lastNonBlank(rows, 1)[0], footer, label);
          assert.equal(footerEnd(rows.map(rowText)), top.length - 1, `${label}: footerEnd is the mode line`);
        }
      }
    }
  });

  test('(+) a pointer with the overflow row and with a busy footer is read through the block too', () => {
    const busy = '⏸ manual mode on · esc to interrupt · ↓ to manage';
    assert.equal(modeFromRows([...head(), ...subagentRows({ agents: 5, more: 3, pointer: 4 })]), 'auto');
    assert.equal(modeFromRows([...head(busy), ...subagentRows({ agents: 2, pointer: 'main' })]), 'manual');
  });

  test('(−) another glyph, a no-break space, extra indent or a pointer on the overflow row is no pointer: unknown', () => {
    const block = subagentRows({ agents: 3, more: 2 });
    const bad = {
      'main with ›': withLead(block, 1, '› '),
      'main with >': withLead(block, 1, '> '),
      'agent with ›': withLead(block, 2, '› '),
      'agent with >': withLead(block, 3, '> '),
      'main, pointer and a no-break space': withLead(block, 1, '❯ '),
      'agent, pointer and a no-break space': withLead(block, 2, '❯ '),
      'main, pointer and two spaces': withLead(block, 1, '\u276f  '),
      'agent, pointer and two spaces': withLead(block, 2, '\u276f  '),
      'overflow row with the pointer': withLead(block, block.length - 1, '❯ '),
    };
    for (const [name, extra] of Object.entries(bad)) {
      const rows = [...head(), ...extra];
      assert.equal(modeFromRows(rows), 'unknown', name);
      assert.notEqual(lastNonBlank(rows, 1)[0], PHRASE.auto, name);
    }
  });

  test('(−) two rows with the pointer: the block is not cut, fail closed', () => {
    const block = subagentRows({ agents: 3 });
    const two = {
      'main and an agent': withLead(withLead(block, 1, '❯ '), 3, '❯ '),
      'two agents': withLead(withLead(block, 2, '❯ '), 4, '❯ '),
      'all rows': block.map((r, i) => (i === 0 ? r : withLead([r], 0, '❯ ')[0])),
    };
    for (const [name, extra] of Object.entries(two)) {
      const rows = [...head(), ...extra];
      assert.equal(modeFromRows(rows), 'unknown', name);
      assert.notEqual(lastNonBlank(rows, 1)[0], PHRASE.auto, name);
    }
  });

  test('(−) pointer rows with the keyboard hint in place of the mode line stay unknown (keyboard selection)', () => {
    const bare = (h) => h.replace('-- INSERT -- ', '');
    for (const [name, hint] of [['main selected', HINT_MAIN], ['agent selected', HINT_AGENT], ['main selected, no INSERT', bare(HINT_MAIN)], ['agent selected, no INSERT', bare(HINT_AGENT)]]) {
      for (const pointer of ['main', 0, 1]) {
        const rows = [...head(hint), ...subagentRows({ agents: 2, pointer })];
        assert.equal(modeFromRows(rows), 'unknown', `${name} pointer ${pointer}`);
        assert.notEqual(lastNonBlank(rows, 1)[0], hint, `${name} pointer ${pointer}: nothing is cut`);
      }
    }
  });
});

describe('surveyShown', () => {
  const rowsWith = (...lines) => rowsOf('transcript', ...BOX, ...lines, PHRASE.auto);

  test('(+) the question row and the options row of the feedback survey, with or without the bullet', () => {
    assert.equal(surveyShown(rowsWith('● How is Claude doing this session? (optional)')), true);
    assert.equal(surveyShown(rowsWith('  How is Claude doing this session? (optional)')), true);
    assert.equal(surveyShown(rowsWith('  1: Bad    2: Fine    3: Good    0: Dismiss')), true);
    assert.equal(surveyShown(rowsWith('1: Bad 2: Fine 3: Good 0: Dismiss')), true);
    assert.equal(surveyShown([...rowsWith('  1: Bad    2: Fine    3: Good    0: Dismiss'), ...subagentRows({ agents: 1 })]), true);
  });

  test('(+) the other digit-taking questions Claude ships (strings from the binary) count as well', () => {
    assert.equal(surveyShown(rowsWith('Can Anthropic look at your session transcript to help us improve Claude Code?')), true);
    assert.equal(surveyShown(rowsWith('● How well is Claude following the instructions you gave earlier in this conversation? (optional)')), true);
  });

  test('(−) ordinary screens, prose that mentions the survey and a menu that merely has a Dismiss are not the survey', () => {
    assert.equal(surveyShown(rowsWith()), false);
    assert.equal(surveyShown(rowsWith('I asked: how is Claude doing this session? and it said fine')), false);
    assert.equal(surveyShown(rowsWith('The survey row reads "How is Claude doing this session? (optional)" and then options')), false);
    assert.equal(surveyShown(rowsWith('  Dismiss')), false);
    assert.equal(surveyShown(rowsWith('we asked: How is Claude doing this session?')), false, 'mid-row');
    assert.equal(surveyShown(rowsWith('the form says Can Anthropic look at your session transcript?')), false, 'mid-row');
    assert.equal(surveyShown(rowsWith('0: Dismiss')), false, 'no option 1');
    assert.equal(surveyShown(rowsWith('see 1: a list item and later 0: Dismiss')), false, 'prose, not an options row');
  });

  test('(−) malformed input is false, never throws', () => {
    for (const bad of [null, undefined, 'abc', 7, {}, [], [null], [[{}]]]) assert.equal(surveyShown(bad), false, String(bad));
  });
});

// M1 (RR05): the row Claude draws for a few seconds after a rating (spike S-F14 section 4): a `1` there opens /feedback.
describe('followUpShown / surveyOrFollowUpShown (the post-rating row)', () => {
  const rowsWith = (...lines) => rowsOf('transcript', ...BOX, ...lines, PHRASE.auto);
  const THANKS = 'Thanks for the feedback!';
  const ROW = '(Optional) Press [1] to tell us more \u00b7 /feedback';

  test('(−) RR05 N1: the row indented, as a reply of Claude that quotes it is drawn, is not the post-rating row', () => {
    assert.equal(followUpShown(rowsWith(`  ${ROW}`)), false, 'a reply row (indent 2)');
    assert.equal(followUpShown(rowsWith(`   ${ROW}`)), false, 'indent 3');
    assert.equal(followUpShown(rowsWith(`\t${ROW}`)), false, 'a tab');
    assert.equal(surveyOrFollowUpShown(rowsWith(`  ${ROW}`)), false, 'the combined check too');
  });

  test('(+) the captured row (column 0, as drawn), and the first half of it when a narrow pane wraps it', () => {
    assert.equal(followUpShown(rowsWith(THANKS, ROW)), true);
    assert.equal(followUpShown(rowsWith(ROW)), true);
    assert.equal(followUpShown(rowsWith('(Optional) Press [1] to tell us more \u00b7', '/feedback')), true, 'wrapped before the last word');
    assert.equal(followUpShown(rowsWith('(Optional) Press [1] to tell us more')), true, 'the words alone');
    assert.equal(followUpShown([...rowsWith(ROW), ...subagentRows({ agents: 1 })]), true, 'with a subagent list below');
  });

  test('(+) the combined check is true for the follow-up row and for the survey rows, and the survey check stays survey-only', () => {
    assert.equal(surveyOrFollowUpShown(rowsWith(THANKS, ROW)), true);
    assert.equal(surveyOrFollowUpShown(rowsWith('\u25cf How is Claude doing this session? (optional)')), true);
    assert.equal(surveyOrFollowUpShown(rowsWith('  1: Bad    2: Fine   3: Good   0: Dismiss')), true);
    assert.equal(surveyShown(rowsWith(THANKS, ROW)), false, 'the follow-up row is not a survey row: src/survey.js (surveyShown) never sees it');
    assert.equal(followUpShown(rowsWith('\u25cf How is Claude doing this session? (optional)')), false, 'and a survey row is not a follow-up row');
  });

  test('(−) prose that quotes the row mid-line, the Thanks row alone, other digits and look-alikes do not match', () => {
    assert.equal(followUpShown(rowsWith()), false);
    assert.equal(followUpShown(rowsWith(THANKS)), false, 'a model line "Thanks for the feedback!" must not hold the draft sync');
    assert.equal(followUpShown(rowsWith(`Claude said: ${ROW}`)), false, 'mid-row');
    assert.equal(followUpShown(rowsWith('The row reads "(Optional) Press [1] to tell us more" and then a link')), false, 'quoted');
    assert.equal(followUpShown(rowsWith('\u25cf (Optional) Press [1] to tell us more')), false, 'a bullet in front is a model line');
    assert.equal(followUpShown(rowsWith('(Optional) Press [2] to tell us more')), false, 'another digit');
    assert.equal(followUpShown(rowsWith('(Optional) Press [1] to tell us moreover')), false, 'no word boundary');
    assert.equal(followUpShown(rowsWith('Press [1] to tell us more')), false, 'without (Optional)');
    assert.equal(surveyOrFollowUpShown(rowsWith()), false);
    assert.equal(surveyOrFollowUpShown(rowsWith(THANKS, `Claude said: ${ROW}`)), false);
  });

  test('(−) malformed input is false, never throws', () => {
    for (const bad of [null, undefined, 'abc', 7, {}, [], [null], [[{}]]]) {
      assert.equal(followUpShown(bad), false, String(bad));
      assert.equal(surveyOrFollowUpShown(bad), false, String(bad));
    }
  });
});

// Claude's scrolled-up pill (spike S5, Claude Code 2.1.325). Display only: the scroll route never reads it to decide a key.
describe('pillShown', () => {
  const sp = (t, s = {}) => span(t, { ...DEF, ...s });
  const PILL_STYLE = { fg: 231, bg: 237 };
  /** Claude's pill row: what the row holds left of the pill (blank by default), then the words in fg 231 on bg 237 with a pad space each side. */
  const pill = (words = 'Jump to bottom: fn+\u2193 to scroll', left = ' '.repeat(40)) => [sp(left), sp(` ${words} `, PILL_STYLE)];
  const JUMP = 'Jump to bottom: fn+\u2193 to scroll';
  const NEW_ONE = '1 new message: fn+\u2193 to scroll';
  const NEW_MANY = '2 new messages: fn+\u2193 to scroll';

  test('(+) both pill texts of spike S5 match, in any row', () => {
    assert.equal(pillShown(rowsOf('older output', pill('Jump to bottom: fn+\u2193 to scroll'), '', '  input')), true);
    assert.equal(pillShown(rowsOf(pill('Jump to bottom (click) \u2193'))), true);
    assert.equal(pillShown(rowsOf(pill(), 'a', 'b', 'c')), true, 'first row');
    assert.equal(pillShown(rowsOf('a', 'b', pill())), true, 'last row');
  });

  test('(+) the pill may start at column 0 and only the span holding the J is checked', () => {
    assert.equal(pillShown(rowsOf([sp('Jump to bottom', PILL_STYLE)])), true);
    assert.equal(pillShown(rowsOf([sp('Jump to ', PILL_STYLE), sp('bottom: x')])), true, 'the J is in the styled span');
    assert.equal(pillShown(rowsOf([sp(' '), sp('J', PILL_STYLE), sp('ump to bottom')])), true);
    assert.equal(pillShown(rowsOf([sp('  '), sp('Jump to bottom', PILL_STYLE), sp(' ', { fg: 1, bg: 2 })])), true);
  });

  test('(\u2212) the right words without the right colours are not the pill', () => {
    const style = (s) => rowsOf([sp(' '), sp(' Jump to bottom: fn+\u2193 to scroll ', s)]);
    assert.equal(pillShown(style({ fg: 231 })), false, 'no background');
    assert.equal(pillShown(style({ bg: 237 })), false, 'no foreground');
    assert.equal(pillShown(style({ fg: 231, bg: 236 })), false);
    assert.equal(pillShown(style({ fg: 230, bg: 237 })), false);
    assert.equal(pillShown(style({ fg: [255, 255, 255], bg: 237 })), false, 'rgb is another colour');
    assert.equal(pillShown(style({ fg: '231', bg: '237' })), false, 'strings are not colours');
    assert.equal(pillShown(style({})), false);
    assert.equal(pillShown(rowsOf([sp('J'), sp('ump to bottom', PILL_STYLE)])), false, 'the J is in a plain span');
  });

  test('(\u2212) other words, other case, no word boundary and plain text are not the pill', () => {
    const styled = (t) => rowsOf([sp(t, PILL_STYLE)]);
    assert.equal(pillShown(styled('Jump to bottomless')), false, 'a word boundary is required');
    assert.equal(pillShown(styled('xJump to bottom')), false, 'and before the J');
    assert.equal(pillShown(styled('jump to bottom')), false);
    assert.equal(pillShown(styled('Jump  to bottom')), false);
    assert.equal(pillShown(styled('Jump to top')), false);
    assert.equal(pillShown(styled('')), false);
    assert.equal(pillShown(rowsOf('Jump to bottom: fn+\u2193 to scroll')), false, 'plain text');
  });

  // W3-T2b, live (Claude Code 2.1.325, 120 columns): Claude draws the pill over the last transcript row, to the right of whatever that row
  // holds (`  14` + 40 spaces, then the pill), and the span carries fg 231 on bg 237 from its pad space on. Once new output arrives while
  // scrolled the words become `1 new message: fn+<down arrow> to scroll`, then `2 new messages: ...`, in the same colours.
  test('(+) the pill after text on the same row matches, in any row and for the (click) variant', () => {
    assert.equal(pillShown(rowsOf('older output', pill(JUMP, '  14' + ' '.repeat(40)), '', '  input')), true);
    assert.equal(pillShown(rowsOf(pill(JUMP, 'a transcript line that ends well before the pill'))), true);
    assert.equal(pillShown(rowsOf(pill('Jump to bottom (click) ↓', '  151 '))), true);
    assert.equal(pillShown(rowsOf(pill(JUMP, ''))), true, 'pill alone, at column 0');
  });

  test('(+) the new-message pill, singular and plural, alone and after text', () => {
    for (const words of [NEW_ONE, NEW_MANY, '12 new messages: fn+↓ to scroll', '999 new messages: fn+↓ to scroll', '1 new message (click) ↓']) {
      for (const left of ['', ' '.repeat(40), '  13' + ' '.repeat(41), 'text ']) {
        assert.equal(pillShown(rowsOf('older output', pill(words, left), '  input')), true, `${left.length} columns left of: ${words}`);
      }
    }
  });

  test('(+) the words twice in a row: it is the occurrence that sits in the styled span that counts', () => {
    assert.equal(pillShown(rowsOf([sp('Jump to bottom, '), sp(` ${JUMP} `, PILL_STYLE)])), true, 'only the second is styled');
    assert.equal(pillShown(rowsOf([sp(` ${JUMP} `, PILL_STYLE), sp(' and Jump to bottom')])), true, 'only the first is styled');
    assert.equal(pillShown(rowsOf([sp('1 new message and 2 new messages '), sp(` ${NEW_MANY} `, PILL_STYLE)])), true);
    assert.equal(pillShown(rowsOf([sp('Jump to bottom or '), sp(` ${NEW_ONE} `, PILL_STYLE)])), true, 'the two kinds mixed');
  });

  test('(−) the words twice and no occurrence in the pill colours are not the pill', () => {
    assert.equal(pillShown(rowsOf('Jump to bottom, Jump to bottom')), false, 'plain');
    assert.equal(pillShown(rowsOf([sp('Jump to bottom ', { fg: 231 }), sp('Jump to bottom', { bg: 237 })])), false, 'one colour each');
    assert.equal(pillShown(rowsOf([sp('1 new message ', { fg: 231 }), sp('2 new messages', { fg: 231, bg: 236 })])), false);
    assert.equal(pillShown(rowsOf([sp('Jump to bottom'), sp(' x ', PILL_STYLE)])), false, 'a styled span after the words does not hold the J');
  });

  test('(−) the new-message words without the pill colours (transcript text, the divider rule) are not the pill', () => {
    for (const s of [{ fg: 231 }, { bg: 237 }, { fg: 231, bg: 236 }, { fg: 230, bg: 237 }, { fg: 246 }, {}]) {
      assert.equal(pillShown(rowsOf([sp('  13 '), sp(` ${NEW_ONE} `, s)])), false, JSON.stringify(s));
      assert.equal(pillShown(rowsOf([sp('  13 '), sp(` ${NEW_MANY} `, s)])), false, JSON.stringify(s));
    }
    // Claude's divider rule at the first unseen message (live: fg 246 over the whole row, no background).
    assert.equal(pillShown(rowsOf([sp('─'.repeat(52) + ' 1 new message ' + '─'.repeat(52), { fg: 246 })])), false);
    assert.equal(pillShown(rowsOf([sp('─'.repeat(52) + ' 2 new messages ' + '─'.repeat(51), { fg: 246 })])), false);
    assert.equal(pillShown(rowsOf(`  ${NEW_ONE}`, `  ${JUMP}`)), false, 'plain text that quotes both');
  });

  test('(−) counts outside 1 to 999, other words and a pill split across two rows are not the pill', () => {
    const styled = (t) => rowsOf([sp(t, PILL_STYLE)]);
    for (const t of ['0 new messages', '1000 new messages', '01 new message', 'new messages', ' new message', 'x1 new message', '1 new messagesx', '1 new  message', '1 New message', 'Jump to']) {
      assert.equal(pillShown(styled(t)), false, t);
    }
    assert.equal(pillShown(rowsOf([sp(' Jump to', PILL_STYLE)], [sp('bottom: fn+↓ to scroll', PILL_STYLE)])), false, 'Jump to / bottom');
    assert.equal(pillShown(rowsOf([sp(' 1 new', PILL_STYLE)], [sp('message: fn+↓ to scroll', PILL_STYLE)])), false, '1 new / message');
    assert.equal(pillShown(rowsOf([sp(' Jump to bot', PILL_STYLE)], [sp('tom', PILL_STYLE)])), false, 'split inside a word');
  });

  test('(\u2212) rows that are not rows never throw and never match', () => {
    for (const rows of [undefined, null, 5, 'Jump to bottom', {}, [], [null], [undefined], [5], ['Jump to bottom'], [[]], [[null]], [[{}]], [[{ t: 5, s: {} }]], [[{ t: 'Jump to bottom' }]],
      [[{ s: PILL_STYLE }]], [[{ t: '1 new message' }]], [[{ t: 7, s: PILL_STYLE }]], [[{ t: 'text ' }, { t: ' 1 new message ' }]], [[null, { t: 'Jump to bottom' }]]]) {
      assert.equal(pillShown(rows), false, JSON.stringify(rows));
    }
  });
});

// ---- 0.5, W1: Claude's question and plan dialogs (design W1 2.2 and 2.6; spikes S3, W1-T0b) ---------------------------------
describe('dialog ends', () => {
  const ASK = {
    one: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
    many: 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    insert: '-- INSERT -- · Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim',
    normal: 'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Nvim · Esc to cancel',
    bare: 'Enter to select · ↑/↓ to navigate',
  };
  const PLAN = 'ctrl+g to edit in Vim · <plans>/demo-api.md';
  const body = (end) => rowsOf('transcript line', '', 'Which project should I open?', '', '❯ 1. acme-api', '  2. Type something.', end);

  test('(+) isDialogEnd: every footer variant of S3 and T0b, the review end and the plan footer; spaces around and no-break spaces do not matter', () => {
    for (const f of [...Object.values(ASK), PLAN, '2. Cancel', '  2. Cancel', '❯ 2. Cancel', `  ${ASK.many}  `, ASK.many.replace(/ /g, '\u00a0'), `   ${PLAN}`]) {
      assert.equal(isDialogEnd(f), true, JSON.stringify(f));
    }
    assert.equal(ASK_FOOTER.exec(ASK.one)[1], '↑/↓');
    assert.equal(ASK_FOOTER.exec(ASK.many)[1], 'Tab/Arrow keys');
    assert.ok(PLAN_FOOTER.test(PLAN) && REVIEW_END.test('2. Cancel'));
  });

  test('(−) isDialogEnd: Esc to cancel alone (the permission prompt), the trust footer, mode lines, options and junk are not dialog ends', () => {
    for (const f of ['Esc to cancel', 'Enter to confirm · Esc to cancel', PHRASE.auto, '1. Submit answers', '  2. Cancel please', '3. Cancel', 'Enter to select', 'Enter to select · j/k to navigate',
      'xx Enter to select · ↑/↓ to navigate', 'ctrl+g to edit in Vim', 'ctrl+g to edit in Vim ·', '', '   ']) {
      assert.equal(isDialogEnd(f), false, JSON.stringify(f));
    }
    for (const v of [undefined, null, 5, {}, []]) assert.equal(isDialogEnd(v), false);
  });

  test('(+) footerEnd cuts the subagent list under each dialog end: the dialog end is the last row', () => {
    for (const end of [...Object.values(ASK), PLAN, '  2. Cancel']) {
      for (const n of [1, 2]) {
        const rows = [...body(end), ...subagentRows({ agents: n })];
        assert.equal(lastNonBlank(rows, 1)[0], end, `${end} / ${n}`);
        assert.equal(modeFromRows(rows), 'unknown', 'a dialog end is not a mode line');
      }
    }
    const texts = [...body(ASK.many), ...subagentRows({ agents: 1 })].map(rowText);
    assert.equal(texts[footerEnd(texts)], ASK.many);
  });

  test('(+) bypassWindow reads the dialog rows, with and without a subagent list under them', () => {
    const rows = rowsOf('transcript line', 'Which mode should I use?', '❯ 1. bypass permissions', '  2. Type something.', '', ASK.many);
    assert.equal(bypassWindow(rows), true);
    assert.equal(bypassWindow([...rows, ...subagentRows({ agents: 3 })]), true);
    assert.equal(bypassWindow(rowsOf('transcript line', 'Which mode should I use?', '❯ 1. plain', '  2. Type something.', '', ASK.many)), false);
  });

  test('(−) a subagent label that mentions bypass, under a question dialog, is still read by the bypass window: no cut shrinks it (review N1, project rule 12)', () => {
    const tree = subagentRows({ agents: [{ label: 'check the bypass settings' }] });
    const rows = [...body(ASK.many), ...tree];
    assert.equal(lastNonBlank(rows, 1)[0], ASK.many, 'the tree is cut for every other reader');
    assert.equal(mentionsBypass(lastNonBlank(rows, PROMPT_ROWS).join(' ')), false, 'the cut window has no bypass');
    assert.equal(bypassWindow(rows), true, 'the literal bottom of the screen does');
    assert.equal(bypassWindow([...body(ASK.many), ...subagentRows({ agents: 2 })]), false, 'a tree without the word changes nothing');
  });

  test('(−) the tree under an unknown row stays: Esc to cancel, the trust footer, an option row and a half-block are not anchors', () => {
    for (const end of ['Esc to cancel', 'Enter to confirm · Esc to cancel', '  2. No', 'Do you want to proceed?', '1. Submit answers']) {
      const rows = [...body(end), ...subagentRows({ agents: 2 })];
      assert.notEqual(lastNonBlank(rows, 1)[0], end, end);
      assert.equal(lastNonBlank(rows, 1)[0].includes('◯'), true, end);
    }
    for (const bad of [subagentRows({ agents: 2, blank: false }), subagentRows({ agents: 2, main: false }), [...subagentRows({ agents: 2 }), rowsOf('junk')[0]]]) {
      assert.notEqual(lastNonBlank([...body(ASK.many), ...bad], 1)[0], ASK.many);
    }
  });

  test('(−) a dialog end changes nothing for a screen that is not one: modes, prompts and the subagent tree under a mode line read as before', () => {
    const idle = [...rowsOf('transcript line', ...BOX, PHRASE.plan), ...subagentRows({ agents: 2 })];
    assert.equal(modeFromRows(idle), 'plan');
    assert.equal(lastNonBlank(idle, 1)[0], PHRASE.plan);
    assert.equal(promptFromRows(rowsOf('Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel')).options.length, 2);
  });
});

// ---- 0.5.4, QP (O1): the question footer of Claude Code 2.1.328 (notes and tab hints) and the rows Claude wraps it over -----------------------
// Shapes from the live check LC-QP (80 and 52 columns); the text is the footer's own, nothing else of a capture is copied. ASCII source: escapes only.
describe('the question footer with notes and tab hints, and its wrapped rows (0.5.4, QP, O1)', () => {
  const M = '\u00b7';
  const UD = '\u2191/\u2193';
  const FULL = `Enter to select ${M} ${UD} to navigate ${M} n to add notes ${M} Tab to switch questions ${M} Esc to cancel`;
  const OPEN = `Enter to select ${M} ${UD} to navigate ${M} n to add notes ${M} Tab to switch questions ${M} ctrl+g to edit in Vim ${M} Esc to cancel`;
  const WRAP80 = [`Enter to select ${M} ${UD} to navigate ${M} n to add notes ${M} Tab to switch questions ${M}`, 'Esc to cancel'];
  const WRAP52 = [`Enter to select ${M} ${UD} to navigate ${M} n to add notes ${M}`, `Tab to switch questions ${M} Esc to cancel`];
  const THREE = ['Enter to select \u00b7', `${UD} to navigate ${M} n to add notes ${M} Tab to`, 'switch questions \u00b7 Esc to cancel'];
  const RULE = '\u2500'.repeat(30);
  /** A screen: some transcript, a blank row, the Chat row, a blank row, the footer rows. */
  const screen = (...foot) => rowsOf('transcript line', 'Pick a shape', '', '  Chat about this', '', ...foot);
  const texts = (...foot) => screen(...foot).map(rowText);
  const last = (...foot) => screen(...foot).length - 1;

  test('(+) ASK_FOOTER takes the notes and tab hints after the navigation, in that order, and the editor hint after them', () => {
    const m = ASK_FOOTER.exec(FULL);
    assert.deepEqual([m[1], m[2], m[3]], [UD, 'n to add notes', 'Tab to switch questions']);
    const open = ASK_FOOTER.exec(OPEN);
    assert.deepEqual([open[1], open[2], open[3]], [UD, 'n to add notes', 'Tab to switch questions']);
    const notesOnly = ASK_FOOTER.exec(`Enter to select ${M} ${UD} to navigate ${M} n to add notes ${M} Esc to cancel`);
    assert.deepEqual([notesOnly[2], notesOnly[3]], ['n to add notes', undefined]);
    const old = ASK_FOOTER.exec('Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel');
    assert.deepEqual([old[1], old[2], old[3]], ['Tab/Arrow keys', undefined, undefined], 'a plain step keeps its footer');
  });

  test('(\u2212) ASK_FOOTER: the hints in another order, repeated, or with something else between them do not match', () => {
    for (const f of [
      `Enter to select ${M} ${UD} to navigate ${M} Tab to switch questions ${M} n to add notes ${M} Esc to cancel`,
      `Enter to select ${M} ${UD} to navigate ${M} n to add notes ${M} n to add notes ${M} Esc to cancel`,
      `Enter to select ${M} ${UD} to navigate ${M} n to add notes ${M} press q ${M} Esc to cancel`,
      `Enter to select ${M} n to add notes ${M} ${UD} to navigate ${M} Esc to cancel`,
      `${M} n to add notes ${M} Tab to switch questions`,
    ]) assert.equal(ASK_FOOTER.test(f), false, f);
  });

  test('(\u2212) a footer that ends in the editor hint takes no rule row for the editor name: rule rows under it are no wrapped footer', () => {
    const insert = `-- INSERT -- ${M} Enter to select ${M} Tab/Arrow keys to navigate ${M} ctrl+g to edit in Vim`;
    assert.equal(ASK_FOOTER.test(`${insert} ${RULE} ${RULE}`), false, 'rule rows joined to the hint');
    assert.equal(ASK_FOOTER.test(`${insert} ${RULE}`), false);
    assert.equal(ASK_FOOTER.test(insert), true, 'the row alone is still a footer');
    const t = [...texts(insert), RULE, RULE];
    const k = t.length - 1;
    assert.equal(mode.askFooterRows(t, k), 0, 'the last row of the screen is a rule');
    assert.equal(mode.askFooterRows(t, k - 2), 1, 'the footer row itself still counts as one row');
    assert.equal(mode.askFooterRows([...texts(insert), RULE], k - 2), 1, 'one rule under the footer row: the footer row still counts');
    assert.equal(mode.askFooterRows([...texts(insert), RULE], k - 1), 0, 'the rule row itself');
  });

  test('(+) askFooterRows: one row, two rows (80 and 52 columns) and three rows under a blank row, each counted by its rows', () => {
    assert.equal(mode.askFooterRows(texts(FULL), last(FULL)), 1);
    assert.equal(mode.askFooterRows(texts(...WRAP80), last(...WRAP80)), 2);
    assert.equal(mode.askFooterRows(texts(...WRAP52), last(...WRAP52)), 2);
    assert.equal(mode.askFooterRows(texts(...THREE), last(...THREE)), 3);
    assert.equal(mode.askFooterRows(texts(OPEN), last(OPEN)), 1);
    assert.equal(mode.askFooterRows([...WRAP80], 1), 2, 'the footer may start at the top row of the screen');
  });

  test('(\u2212) askFooterRows: a gap row inside, an indented row, a row above that is not blank, four rows and a join that does not match are 0', () => {
    assert.equal(mode.askFooterRows(texts(WRAP80[0], '', WRAP80[1]), last(WRAP80[0], '', WRAP80[1])), 0, 'a blank row inside the footer');
    assert.equal(mode.askFooterRows(texts(WRAP80[0], `  ${WRAP80[1]}`), last(WRAP80[0], `  ${WRAP80[1]}`)), 0, 'the second row is indented');
    assert.equal(mode.askFooterRows(texts(` ${WRAP80[0]}`, WRAP80[1]), last(` ${WRAP80[0]}`, WRAP80[1])), 0, 'the first row is indented');
    const touching = rowsOf('transcript line', '  Chat about this', ...WRAP80).map(rowText);
    assert.equal(mode.askFooterRows(touching, touching.length - 1), 0, 'a non-blank row right above the first footer row');
    const four = ['Enter to select \u00b7', `${UD} to navigate \u00b7`, 'n to add notes \u00b7 Tab to switch', 'questions \u00b7 Esc to cancel'];
    assert.equal(mode.askFooterRows(texts(...four), last(...four)), 0, 'four rows are more than Claude wraps a footer over');
    assert.equal(mode.askFooterRows(texts(WRAP80[0], 'Esc to cancel please'), last(WRAP80[0], 'Esc to cancel please')), 0, 'the join is not the footer');
    assert.equal(mode.askFooterRows(texts('Esc to cancel'), last('Esc to cancel')), 0, 'the tail row alone');
    for (const bad of [[], null, undefined, 'x']) assert.equal(mode.askFooterRows(bad, 3), 0, String(bad));
    for (const k of [-1, 99, 1.5, NaN, undefined]) assert.equal(mode.askFooterRows(texts(FULL), k), 0, String(k));
  });

  test('(+) endsDialog is a dialog end for the last row of a wrapped footer too, and for every old dialog end', () => {
    assert.equal(mode.endsDialog(texts(...WRAP80), last(...WRAP80)), true);
    assert.equal(mode.endsDialog(texts(...WRAP52), last(...WRAP52)), true);
    assert.equal(mode.endsDialog(texts(...THREE), last(...THREE)), true);
    assert.equal(mode.endsDialog(texts(FULL), last(FULL)), true);
    for (const end of ['Enter to select \u00b7 Tab/Arrow keys to navigate \u00b7 Esc to cancel', '  2. Cancel', 'ctrl+g to edit in Vim \u00b7 <plans>/demo-api.md']) assert.equal(mode.endsDialog([end], 0), true, end);
  });

  test('(\u2212) endsDialog: the first row of a wrapped footer, the tail row alone, a gap, and not-rows are not dialog ends', () => {
    assert.equal(mode.endsDialog(texts(...WRAP80), last(...WRAP80) - 1), false, 'the first row alone');
    assert.equal(mode.endsDialog(texts('Esc to cancel'), last('Esc to cancel')), false, 'Esc to cancel alone is the permission prompt');
    assert.equal(mode.endsDialog(texts(WRAP80[0], '', WRAP80[1]), last(WRAP80[0], '', WRAP80[1])), false);
    for (const k of [-1, 99, undefined]) assert.equal(mode.endsDialog(texts(FULL), k), false, String(k));
    assert.equal(mode.endsDialog(undefined, 0), false);
  });

  test('(+) footerEnd cuts a subagent list and a lone rule row hanging under a wrapped footer, as under a one-row one', () => {
    for (const foot of [WRAP80, WRAP52, THREE]) {
      const rows = [...screen(...foot), ...subagentRows({ agents: 2 })];
      const t = rows.map(rowText);
      assert.equal(t[footerEnd(t)], foot.at(-1), 'the subagent list');
      const ruled = [...screen(...foot), ...rowsOf(`${RULE} demo \u2500`)];
      const tr = ruled.map(rowText);
      assert.equal(tr[footerEnd(tr)], foot.at(-1), 'the labelled rule row');
      assert.equal(lastNonBlank(ruled, 1)[0], foot.at(-1));
      assert.equal(modeFromRows(ruled), 'unknown', 'a footer is not a mode line');
    }
  });

  test('(\u2212) footerEnd: a gap inside the footer, an indented tail row or a non-blank row above it cut nothing under it', () => {
    const cases = {
      gap: [WRAP80[0], '', WRAP80[1]],
      indented: [WRAP80[0], `  ${WRAP80[1]}`],
    };
    for (const [name, foot] of Object.entries(cases)) {
      for (const tail of [subagentRows({ agents: 2 }), rowsOf(`${RULE} demo \u2500`)]) {
        const t = [...screen(...foot), ...tail].map(rowText);
        assert.equal(footerEnd(t), t.length - 1, name);
      }
    }
    const touching = [...rowsOf('transcript line', '  Chat about this', ...WRAP80), ...rowsOf(`${RULE} demo \u2500`)].map(rowText);
    assert.equal(footerEnd(touching), touching.length - 1, 'a non-blank row right above the footer');
  });

  test('(\u2212) the tail row of a wrapped footer is never a permission prompt, and a prompt does not take a wrapped footer for its hint', () => {
    assert.equal(promptFromRows(screen(...WRAP80)), null);
    assert.equal(promptFromRows(screen(...WRAP52)), null);
    assert.equal(promptFromRows(rowsOf('Do you want to proceed?', '\u276f 1. Yes', '  2. No', '', ...WRAP80)), null, 'options above a wrapped footer are no prompt');
    assert.equal(mode.promptTopRow(screen(...WRAP80)), null);
  });

  test('(+) bypassWindow reads the rows of a question step whose footer wraps, with a subagent list under it', () => {
    const rows = rowsOf('Which mode should I use?', '\u276f 1. bypass permissions', '', ...WRAP80);
    assert.equal(bypassWindow(rows), true);
    assert.equal(bypassWindow([...rows, ...subagentRows({ agents: 2 })]), true);
    assert.equal(bypassWindow(rowsOf('Which mode should I use?', '\u276f 1. plain', '', ...WRAP80)), false);
  });
});

describe('the auto-mode nudge (orchestrator ruling 4)', () => {
  const TITLE = '  Teach auto mode about your environment?';
  const FOOT = '  Enter to confirm · Esc to cancel';
  const MODE = '  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)';
  const RULE = '─'.repeat(40);
  /** `box`: the input-box rows between the two rules; `status`: a user status line between the lower rule and the mode line. */
  const nudge = (extra = [], { box = ['❯'], status = [], mode = MODE } = {}) => rowsOf('⏺ All done.', '', RULE, TITLE, '', '  Auto mode works better when it knows your environment.', '', '  ❯ 1. Yes', '    2. Not now', "    3. Don't show again", '', FOOT, RULE, ...box, RULE, ...status, mode, ...extra);
  const footIndex = (rows) => rows.findIndex((r) => rowText(r) === FOOT);

  test('(+) the nudge footer becomes the last row: the box and the mode line under it do not count as the footer', () => {
    const rows = nudge();
    assert.equal(lastNonBlank(rows, 1)[0], FOOT);
    assert.equal(modeFromRows(rows), 'unknown', 'the mode line under the box is not read');
    assert.equal(promptFromRows(rows), null);
    assert.equal(lastNonBlank(rows, 3).length, 3);
    assert.equal(nudgeFooterAt(rows.map(rowText), rows.length - 1), rows.findIndex((r) => rowText(r) === FOOT));
  });

  test('(+) a subagent list under the nudge\'s mode line is cut first, then the nudge footer is the last row', () => {
    const rows = nudge(subagentRows({ agents: 2 }));
    assert.equal(lastNonBlank(rows, 1)[0], FOOT);
  });

  test('(+) bypassWindow reads the nudge rows', () => {
    const rows = nudge().map((r) => (rowText(r).includes('2. Not now') ? rowsOf('    2. Allow bypass')[0] : r));
    assert.equal(bypassWindow(rows), true);
    assert.equal(bypassWindow(nudge()), false);
  });

  test('(+) a real nudge above a tall input box (a queued multi-line draft) is still the nudge: 1, 6, 10, 12 and 20 box rows (review I2)', () => {
    for (const n of [1, 6, 10, 12, 20]) {
      const rows = nudge([], { box: ['❯', ...Array.from({ length: n - 1 }, (_, i) => `  draft line ${i + 2}`)] });
      assert.equal(nudgeFooterAt(rows.map(rowText), rows.length - 1), footIndex(rows), `${n} box rows`);
      assert.equal(lastNonBlank(rows, 1)[0], FOOT, `${n} box rows`);
      assert.equal(modeFromRows(rows), 'unknown', `${n} box rows: not an idle screen`);
    }
  });

  test('(+) a user status line (up to 3 rows) between the box and the mode line does not hide the nudge; 4 rows is the documented limit', () => {
    for (const n of [1, 2, 3]) {
      const rows = nudge([], { status: Array.from({ length: n }, (_, i) => `  acme-api  master ${i}`) });
      assert.equal(nudgeFooterAt(rows.map(rowText), rows.length - 1), footIndex(rows), `${n} status rows`);
      assert.equal(modeFromRows(rows), 'unknown');
    }
    const four = nudge([], { status: ['  a', '  b', '  c', '  d'] });
    assert.equal(nudgeFooterAt(four.map(rowText), four.length - 1), -1);
  });

  test('(−) the two nudge rows quoted inside a permission prompt\'s Bash preview cannot hide its bypass option: the prompt and the bypass window are read as before (review I1, probe 1)', () => {
    const rows = rowsOf('Bash command', '', "  echo 'quoted dialog'", '  Teach auto mode about your environment?', '  Enter to confirm · Esc to cancel', '',
      'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and switch to bypass permissions', '  3. No', 'Esc to cancel');
    assert.equal(nudgeFooterAt(rows.map(rowText), rows.length - 1), -1);
    assert.equal(lastNonBlank(rows, 1)[0], 'Esc to cancel');
    assert.notEqual(promptFromRows(rows), null);
    assert.equal(bypassWindow(rows), true);
  });

  test('(−) the two nudge rows quoted in a message above a short question dialog with a bypass option do not hide it (review I1, probe 2)', () => {
    const ASK = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
    const rows = rowsOf('⏺ The dialog reads:', TITLE, FOOT, '', RULE, 'Which mode should I use?', '', '❯ 1. bypass permissions', '    Skip every check.', '  2. Type something.', RULE, '  3. Chat about this', '', ASK);
    assert.equal(nudgeFooterAt(rows.map(rowText), rows.length - 1), -1);
    assert.equal(lastNonBlank(rows, 1)[0], ASK);
    assert.equal(bypassWindow(rows), true);
    assert.equal(modeFromRows(rows), 'unknown');
  });

  test('(−) a cut never shrinks the bypass window: a real nudge whose rows under the footer mention bypass is read as bypass', () => {
    const rows = nudge([], { mode: '  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)' });
    assert.equal(nudgeFooterAt(rows.map(rowText), rows.length - 1), footIndex(rows), 'still the nudge');
    assert.equal(mentionsBypass(lastNonBlank(rows, 15).join(' ')), false, 'the window above the footer has no bypass');
    assert.equal(bypassWindow(rows), true, 'the uncut bottom does');
    assert.equal(bypassWindow(nudge()), false);
  });

  test('(−) the pair quoted in a message, not directly above the box, cuts nothing: the mode, the box and the prompt read as on any idle screen (End, commands and draft keep working)', () => {
    const rows = rowsOf('⏺ I saw this dialog:', TITLE, FOOT, '⏺ Anyway, all done.', '', RULE, '❯', RULE, MODE);
    assert.equal(nudgeFooterAt(rows.map(rowText), rows.length - 1), -1);
    assert.equal(lastNonBlank(rows, 1)[0], MODE);
    assert.equal(modeFromRows(rows), 'auto');
    assert.equal(promptFromRows(rows), null);
    assert.equal(bypassWindow(rows), false);
  });

  test('(−) the pair is a nudge only above the input box that ends the screen: a changed layout cuts nothing', () => {
    const at = (rows) => nudgeFooterAt(rows.map(rowText), rows.length - 1);
    assert.equal(at(rowsOf(TITLE, FOOT, RULE, '❯', RULE, MODE)), 1, 'the base layout');
    assert.equal(at(rowsOf(TITLE, FOOT, RULE, '❯', RULE, 'junk')), -1, 'the last row is not a mode line');
    assert.equal(at(rowsOf(TITLE, FOOT, RULE, '❯', RULE, MODE, 'junk')), -1, 'a row under the mode line');
    assert.equal(at(rowsOf(TITLE, FOOT, '❯', RULE, MODE)), -1, 'no upper rule');
    assert.equal(at(rowsOf(TITLE, FOOT, RULE, '❯', MODE)), -1, 'no lower rule');
    assert.equal(at(rowsOf(TITLE, FOOT, 'a row between', RULE, '❯', RULE, MODE)), -1, 'another row between the footer and the box');
    assert.equal(at(rowsOf(TITLE, 'a row between', FOOT, RULE, '❯', RULE, MODE)), 2, 'a row between the title and the footer is within the span');
    assert.equal(at(rowsOf(FOOT, RULE, '❯', RULE, MODE)), -1, 'no title');
    assert.equal(at(rowsOf(TITLE, FOOT, '', '', RULE, '❯', '', RULE, MODE)), 1, 'blank rows around the box');
    assert.equal(at(rowsOf(TITLE, FOOT, '  ' + RULE, '❯', '  ' + RULE, MODE)), -1, 'an indented rule is not the box\'s rule');
  });

  test('(−) the title without its footer, the footer without its title, or the two too far apart is an ordinary screen', () => {
    const noFooter = nudge().filter((r) => rowText(r) !== FOOT);
    const noTitle = nudge().filter((r) => rowText(r) !== TITLE);
    assert.equal(modeFromRows(noFooter), 'auto');
    assert.equal(modeFromRows(noTitle), 'auto');
    const far = rowsOf(TITLE, ...Array.from({ length: 12 }, (_, i) => `  row ${i}`), FOOT, RULE, '❯', RULE, MODE);
    assert.equal(modeFromRows(far), 'auto', 'more than the nudge span of rows between them');
    assert.equal(nudgeFooterAt(far.map(rowText), far.length - 1), -1);
    const near = rowsOf(TITLE, ...Array.from({ length: 7 }, (_, i) => `  row ${i}`), FOOT, RULE, '❯', RULE, MODE);
    assert.equal(nudgeFooterAt(near.map(rowText), near.length - 1), 8, 'within the span: 7 rows between them');
    assert.equal(nudgeFooterAt(['a', 'b'], 1), -1);
    assert.equal(nudgeFooterAt([], 5), -1);
  });

  test('(−) the folder-trust dialog (same footer, another title) is not the nudge: its footer stays the last row and nothing else changes', () => {
    const trust = rowsOf('Do you trust the files in this folder?', '', '❯ 1. Yes, proceed', '  2. No, exit', '', '  Enter to confirm · Esc to cancel');
    assert.equal(lastNonBlank(trust, 1)[0], '  Enter to confirm · Esc to cancel');
    assert.equal(nudgeFooterAt(trust.map(rowText), trust.length - 1), -1);
    assert.equal(promptFromRows(trust), null);
  });

  test('(−) an idle screen, a busy one and a permission prompt read exactly as before', () => {
    const idle = rowsOf('transcript', ...BOX, PHRASE.auto);
    assert.equal(modeFromRows(idle), 'auto');
    assert.equal(lastNonBlank(idle, 2)[0], BOX[1]);
    assert.equal(promptFromRows(rowsOf('Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel')).question, 'Do you want to proceed?');
  });
});

// ---- 0.5, F13-A v2: Claude's task list (and a lone rule row) under a dialog's or a permission prompt's last row (design F13 v2) --------
describe('task list under a dialog or a permission prompt (F13-A v2)', () => {
  const ASK = {
    one: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
    many: 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    insert: '-- INSERT -- · Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim',
    ctrl: 'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim',
    review: '  2. Cancel',
    pointer: '❯ 2. Cancel',
    plan: '   ctrl+g to edit in Vim · <plans>/demo-api.md',
    prompt: 'Esc to cancel · Tab to amend',
    promptBare: 'Esc to cancel',
  };
  const body = (end) => rowsOf('transcript line', '', 'Which project should I open?', '', '❯ 1. acme-api', '  2. Type something.', end);
  /** The permission prompt of spike S-F13 (a), made-up text: a Bash prompt with four options, the second one wrapped. */
  const PROMPT = rowsOf(
    '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────', ' Bash command', '',
    '   make a made-up file', '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌', ' Do you want to proceed?', ' ❯ 1. Yes',
    '   2. Yes, and always allow access to <dir> from this project', '   3. Yes, and switch to auto mode · auto mode handles these prompts for you', '   4. No', '', ' ' + ASK.prompt,
  );
  const end = (rows) => rows.length - 1;
  const at = (rows) => footerEnd(rows.map(rowText));
  const anchors = { 'one tab': ASK.one, 'several tabs': ASK.many, insert: ASK.insert, 'editor hint': ASK.ctrl, review: ASK.review, 'review with the pointer': ASK.pointer, plan: ASK.plan };
  const screens = { ...Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, () => body(v)])), 'permission prompt': () => PROMPT };

  test('(+) footerEnd is the last row of the dialog or the prompt under the block: named and unnamed, 0, 3 and 11 blank rows, every anchor', () => {
    for (const [name, make] of Object.entries(screens)) {
      for (const named of [true, false]) {
        for (const blank of [named ? 0 : 1, 3, 11]) {
          const dialog = make();
          const rows = [...dialog, ...taskRows({ named, blank })];
          assert.equal(at(rows), end(dialog), `${name} / named ${named} / ${blank} blank rows`);
          assert.equal(lastNonBlank(rows, 1)[0], lastNonBlank(dialog, 1)[0], name);
        }
      }
    }
  });

  test('(+) the same on whole screens of 45 and 60 rows: the rule is directly under the footer at 45 rows and far below it at 60 (named), the header with blank rows above it (unnamed)', () => {
    for (const [name, make] of Object.entries(screens)) {
      for (const rows of [45, 60]) {
        for (const named of [true, false]) {
          const dialog = make();
          const screen = taskScreen(dialog, { rows, named });
          assert.equal(screen.length, rows, `${name} fills ${rows} rows`);
          assert.equal(at(screen), 12 + dialog.length - 1, `${name} / ${rows} / named ${named}`);
        }
      }
    }
  });

  test('(+) a lone rule row as the last row under the dialog is left out too (the plan approval of a named session), plain or labelled, after any blank rows', () => {
    const rule = taskRows({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }).slice(0, 1);
    const plain = taskRows({ rule: 'plain', doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }).slice(0, 1);
    for (const [name, make] of Object.entries(screens)) {
      for (const r of [rule, plain]) {
        for (const blank of [0, 2, 10]) {
          const dialog = make();
          assert.equal(at([...dialog, ...Array.from({ length: blank }, () => []), ...r]), end(dialog), `${name} / ${blank}`);
          assert.equal(at([...dialog, ...Array.from({ length: blank }, () => []), ...r, [], []]), end(dialog), `${name} / ${blank} / trailing blank rows`);
        }
      }
    }
  });

  test('(+) the block shapes of the spike: 1 tasks, no in-progress part, all done, header only, every overflow form, labels with suffixes, four-digit counts', () => {
    const dialog = body(ASK.many);
    const shapes = {
      'plain block': {},
      '1 tasks (one task in progress)': { doing: 1, open: 0, shownDone: 0, hiddenDone: 0 },
      '1 tasks (one task done)': { doing: 0, open: 0, shownDone: 1, hiddenDone: 0 },
      'all done, no in-progress part, overflow': { doing: 0, open: 0, shownDone: 5, hiddenDone: 3 },
      'no overflow row': { hiddenDone: 0 },
      'overflow: in progress': { hiddenDoing: 2, hiddenDone: 0 },
      'overflow: pending': { hiddenOpen: 2, hiddenDone: 0 },
      'overflow: completed': { hiddenDone: 4 },
      'overflow: in progress and pending': { hiddenDoing: 1, hiddenOpen: 2, hiddenDone: 0 },
      'overflow: pending and completed': { hiddenOpen: 2, hiddenDone: 3 },
      'overflow: all three': { hiddenDoing: 1, hiddenOpen: 2, hiddenDone: 3 },
      'header only (a pane too short for the rows)': { doing: 0, open: 0, shownDone: 0, hiddenDone: 0, claim: { total: 5, done: 3, open: 2 } },
      'header only, in progress': { doing: 0, open: 0, shownDone: 0, hiddenDone: 0, claim: { total: 5, done: 3, doing: 1, open: 1 } },
      'mixed order': { order: 'xdxoxo', hiddenDone: 1 },
      'only open': { doing: 0, shownDone: 0, hiddenDone: 0, open: 3 },
      'long list': { doing: 3, open: 2, shownDone: 5, hiddenDone: 1234 },
      'labels with suffixes': { labels: ['A label that was cut by Claude…', 'Review the notes › blocked by #1, #2', 'Tidy the folders (@robin)', '◼ ✔ ◻ inside the label'] },
    };
    for (const [name, opts] of Object.entries(shapes)) {
      for (const named of [true, false]) assert.equal(at([...dialog, ...taskRows({ named, ...opts })]), end(dialog), `${name} / named ${named}`);
    }
  });

  test('(+) padded rows, trailing blank rows and a trailing row of spaces', () => {
    const dialog = body(ASK.one);
    const block = taskRows({ cols: 64, doing: 1, open: 0, shownDone: 4, hiddenDone: 12 });
    const pad = (rows, cols) => rows.map((r) => [...r, span(' '.repeat(Math.max(0, cols - r.map((sp) => sp.t).join('').length)))]);
    assert.equal(at([...dialog, ...block]), end(dialog));
    assert.equal(at(pad([...dialog, ...block], 64)), end(dialog), 'padded');
    assert.equal(at([...dialog, ...block, [], []]), end(dialog), 'trailing blank rows');
    assert.equal(at([...dialog, ...block, [span(' '.repeat(64))]]), end(dialog), 'a trailing row of spaces');
  });

  test('(+) every reader sees the last row of the dialog or the prompt as the last row: lastNonBlank, the mode, the prompt, the nudge', () => {
    for (const [name, make] of Object.entries(screens)) {
      for (const named of [true, false]) {
        const dialog = make();
        const rows = [...dialog, ...taskRows({ named })];
        assert.deepEqual(lastNonBlank(rows, 15), lastNonBlank(dialog, 15), name);
        assert.equal(modeFromRows(rows), modeFromRows(dialog), name);
        assert.deepEqual(promptFromRows(rows), promptFromRows(dialog), name);
        assert.equal(nudgeFooterAt(rows.map(rowText)), -1, 'the nudge needs a mode line at the end, so it never fires on a cut');
      }
    }
  });

  test('(+) the permission prompt reads the same with and without the block: the options, the question, and the sig the answer route checks', () => {
    const plain = promptFromRows(PROMPT);
    assert.deepEqual(plain.options.map((o) => o.n), [1, 2, 3, 4]);
    assert.equal(plain.question, 'Do you want to proceed?');
    for (const named of [true, false]) {
      for (const blank of [named ? 0 : 1, 3]) {
        const rows = [...PROMPT, ...taskRows({ named, blank })];
        assert.deepEqual(promptFromRows(rows), plain);
        assert.equal(promptSig(rows), promptSig(PROMPT));
        assert.equal(bypassWindow(rows), false);
      }
    }
  });

  test('(+) a task label that mentions bypass is still read by the bypass window: the guard reads the literal bottom, the cut window has no bypass', () => {
    for (const [name, make] of Object.entries(screens)) {
      const dialog = make();
      const rows = [...dialog, ...taskRows({ labels: ['Check the bypass settings'] })];
      assert.equal(at(rows), end(dialog), `${name}: the block is cut for every other reader`);
      assert.equal(mentionsBypass(lastNonBlank(rows, PROMPT_ROWS).join(' ')), false, 'the cut window has no bypass');
      assert.equal(bypassWindow(rows), true, `${name}: the literal bottom of the screen does`);
      assert.equal(bypassWindow([...dialog, ...taskRows()]), false, 'a block without the word changes nothing');
    }
  });

  test('(+) a bypass mention that only the cut window reaches is still found: the guard reads the union of the windows, never less', () => {
    const filler = Array.from({ length: 8 }, (_, i) => `  ${i + 3}. Option ${i + 3}`);
    const dialog = rowsOf('Which mode should I use?', '❯ 1. bypass permissions', ...filler, '', ASK.many);
    const rows = [...dialog, ...taskRows()];
    const live = rows.map(rowText).filter((t) => t.trim());
    const mention = live.findIndex((t) => t.includes('bypass'));
    assert.ok(live.length - mention > PROMPT_ROWS, 'the mention lies outside the last 15 non-blank rows of the literal screen');
    assert.equal(mentionsBypass(lastNonBlank(rows, PROMPT_ROWS).join(' ')), true, 'but inside the 15 rows above the dialog end');
    assert.equal(bypassWindow(rows), true);
  });

  test('(−) a block or a rule row in any shape but the captured ones leaves footerEnd at the last row (counts, blank rows, rule, glyphs, overflow row, places)', () => {
    for (const cols of [64, 120]) {
      for (const [name, rows] of Object.entries(taskMisfits(body(ASK.many), { cols }))) assert.equal(at(rows), rows.length - 1, `${name} / ${cols}`);
    }
  });

  test('(−) the same misfits under every other anchor, the permission prompt included, leave footerEnd at the last row', () => {
    for (const [label, make] of Object.entries(screens)) {
      for (const [name, rows] of Object.entries(taskMisfits(make()))) assert.equal(at(rows), rows.length - 1, `${label}: ${name}`);
    }
  });

  test('(−) the trust footer, the nudge footer, an option row and a question are no anchors; Esc to cancel is one only for a permission prompt that parses', () => {
    for (const foot of ['Enter to confirm · Esc to cancel', '  2. No', 'Do you want to proceed?', '1. Submit answers']) {
      const rows = [...body(foot), ...taskRows()];
      assert.equal(at(rows), rows.length - 1, foot);
    }
    for (const foot of [ASK.prompt, ASK.promptBare]) {
      const noPrompt = [...rowsOf('transcript line', 'a message', foot), ...taskRows()];
      assert.equal(at(noPrompt), noPrompt.length - 1, `no prompt above ${foot}`);
      const oneOption = [...rowsOf('Do you want to proceed?', '❯ 1. Yes', foot), ...taskRows()];
      assert.equal(at(oneOption), oneOption.length - 1, `one option above ${foot}`);
      const noQuestion = [...rowsOf('Some text', '❯ 1. Yes', '  2. No', foot), ...taskRows()];
      assert.equal(at(noQuestion), noQuestion.length - 1, `no question above ${foot}`);
    }
  });

  test('(−) a permission prompt taller than the rows nika reads (option 1 more than 15 non-blank rows above the footer) is no prompt, so the block under it is cut by nobody', () => {
    const tall = rowsOf('Do you want to proceed?', '❯ 1. Yes', ...Array.from({ length: PROMPT_ROWS }, () => '     more words of the label'), '  2. No', '', ' ' + ASK.prompt);
    assert.equal(promptFromRows(tall), null);
    assert.equal(promptFromRows(PROMPT) !== null, true, 'control: the normal prompt reads');
    for (const tail of [taskRows(), taskRows({ named: false })]) assert.equal(at([...tall, ...tail]), tall.length + tail.length - 1);
  });

  test('(−) a fake footer in a message above a real input box, with a real block above that box, cuts nothing (the block is not at the bottom)', () => {
    const idle = rowsOf('transcript line', ...BOX, PHRASE.auto);
    const rows = [...body(ASK.many), ...taskRows(), ...idle];
    assert.equal(at(rows), rows.length - 1);
    assert.equal(modeFromRows(rows), 'auto');
  });

  test('(−) a block or a lone rule under a mode line changes nothing for a screen that is not a dialog: the mode, the box and the prompt read as before', () => {
    const top = rowsOf('transcript line', ...BOX, PHRASE.plan);
    for (const tail of [taskRows(), taskRows({ named: false }), taskRows({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }).slice(0, 1)]) {
      const rows = [...top, ...tail];
      assert.equal(at(rows), rows.length - 1);
      assert.equal(modeFromRows(rows), 'unknown', 'the block is the last row: not a mode line, as before');
    }
    assert.equal(modeFromRows(top), 'plan');
  });

  test('(−) the exact count rules, one by one: the same block with one number wrong is not cut, with the numbers right it is', () => {
    const dialog = body(ASK.many);
    const cut = (o) => at([...dialog, ...taskRows(o)]) === end(dialog);
    assert.equal(cut({}), true);
    assert.equal(cut({ hiddenDoing: 2, hiddenOpen: 1 }), true);
    assert.equal(cut({ claim: { total: 8 } }), false, 'total');
    assert.equal(cut({ claim: { done: 6, total: 8 } }), false, 'done');
    assert.equal(cut({ claim: { doing: 2, total: 8 } }), false, 'in progress');
    assert.equal(cut({ claim: { open: 2, total: 8 } }), false, 'open');
    assert.equal(cut({ hiddenDoing: 2, claim: { doing: 4, total: 10 } }), false, 'hidden in progress');
    assert.equal(cut({ hiddenOpen: 2, claim: { open: 4, total: 10 } }), false, 'hidden pending');
  });

  test('(−) footerEnd and the row readers never throw on malformed input', () => {
    assert.equal(footerEnd([]), -1);
    assert.equal(footerEnd(['']), 0);
    assert.equal(footerEnd(['  1 tasks (1 done, 0 open)']), 0);
    assert.equal(footerEnd(['x', '', '  ✔ a', '   … +1 completed']), 3);
    assert.equal(footerEnd(['', '  1 tasks (1 done, 0 open)']), 1);
    assert.equal(footerEnd(['───────', '']), 1);
    assert.equal(footerEnd(['───────']), 0);
    for (const bad of [null, undefined, [], [[]], [[{}]], [[{ t: 5 }]], [null], [[null]], 'x', 5, {}]) {
      assert.doesNotThrow(() => { lastNonBlank(bad, 3); bypassWindow(bad); modeFromRows(bad); promptFromRows(bad); promptSig(bad); }, JSON.stringify(bad));
    }
  });

  // ---- T326 (spike S-T326): Claude 2.1.326 draws the block as `<D>/<T> tasks done · <P> in progress` with the overflow row
  // `  … +<N> task(s) (<n> in progress, <n> open, <n> done)` (two spaces). Every fixture below is made up; none is a captured text. ---------------
  describe('the Claude 2.1.326 form of the task list (T326)', () => {
    const sty = (o) => ({ ...DEF, ...o });
    const DIM = sty({ fg: 246 });
    const ACC = sty({ fg: 153 });
    /** A question dialog that src/dialog.js reads as `ready` (made-up text; two tabs, three options), 120 columns. */
    const QUESTION = [
      [span('⏺ I have a question first.')], [],
      [span('─'.repeat(120), DIM)],
      [span('←'), span(' '), span(' ☐ Project ', sty({ fg: 16, bg: 153 })), span(' '), span(' ☐ Tools '), span(' '), span(' ✔ Submit '), span(' '), span('→')],
      [],
      [span('Which project should I open?', sty({ b: true, fg: 231 }))],
      [],
      [span('❯', ACC), span(' '), span('1.', DIM), span(' acme-api', ACC)], [span('     Open the acme-api project.', DIM)],
      [span('  '), span('2.', DIM), span(' web-shop')], [span('     Open the web-shop project.', DIM)],
      [span('  '), span('3.', DIM), span(' Type something.', sty({ d: true }))],
      [span('─'.repeat(120), DIM)],
      [span('  4. Chat about this')],
      [],
      [span('Enter to select · Tab/Arrow keys to navigate · Esc to cancel', DIM)],
    ];
    const capture = (rows) => dialogCapture(rows, 120);
    const readable = capture(QUESTION);
    const dialogs = { ...screens, 'readable question': () => QUESTION };
    const unread = (c) => c === null || c.state !== 'ready';

    /**
     * The 2.1.326 block under a dialog: taskRows' blank rows, rule row and task rows with this version's header, then its overflow row.
     *   doing, open, done   the task rows shown (in this order of drawing: doing, done, open, as taskRows draws them)
     *   hid                 { doing, open, done }: the hidden tasks, named in the overflow row (none: no overflow row)
     *   claim               overrides of the header numbers { total, done, doing }; head: the whole header; more: the whole overflow row
     * The header numbers are the truth computed from the rows and the hidden counts unless claim overrides them.
     */
    const v2 = ({ doing = 1, open = 1, done = 2, hid = {}, claim = {}, head = null, more = null, ...rest } = {}) => {
      const [hd, ho, hx] = [hid.doing ?? 0, hid.open ?? 0, hid.done ?? 0];
      const n = { total: doing + open + done + hd + ho + hx, done: done + hx, doing: doing + hd, ...claim };
      const headText = head ?? `  ${n.done}/${n.total} ${n.total === 1 ? 'task' : 'tasks'} done${n.doing > 0 ? ` · ${n.doing} in progress` : ''}`;
      const sum = hd + ho + hx;
      const parts = [[hd, 'in progress'], [ho, 'open'], [hx, 'done']].filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`);
      const moreText = more ?? (sum > 0 ? `  … +${sum} ${sum === 1 ? 'task' : 'tasks'} (${parts.join(', ')})` : null);
      return [...taskRows({ ...rest, doing, open, shownDone: done, hiddenDone: 0, head: headText }), ...(moreText === null ? [] : [[span(moreText)]])];
    };
    const forms = (o) => [true, false].map((named) => v2({ named, ...o }));
    /** The block `tail` hangs under every dialog and is cut: footerEnd is the dialog's last row; dialogCapture reads the readable one as without the block. */
    const cutUnder = (name, tail) => {
      for (const [label, make] of Object.entries(dialogs)) {
        const dialog = make();
        assert.equal(at([...dialog, ...tail]), end(dialog), `${name} / ${label}`);
      }
      assert.deepEqual(capture([...QUESTION, ...tail]), readable, `${name}: dialogCapture reads the question`);
      assert.equal(readable.state, 'ready');
    };
    /** The block `tail` is not cut under any dialog (footerEnd stays the last row) and dialogCapture does not read the question through it. */
    const keptUnder = (name, tail) => {
      for (const [label, make] of Object.entries(dialogs)) {
        const rows = [...make(), ...tail];
        assert.equal(at(rows), rows.length - 1, `${name} / ${label}`);
      }
      assert.ok(unread(capture([...QUESTION, ...tail])), `${name}: dialogCapture does not read the question`);
    };
    const keptBoth = (name, o) => forms(o).forEach((tail, i) => keptUnder(`${name} / ${i === 0 ? 'named' : 'unnamed'}`, tail));
    const text = (rows) => rows.map(rowText);

    test('(+) the fixture builder draws the shapes of the spike: header with and without in progress, "task" for one, the overflow row', () => {
      assert.deepEqual(text(v2({ doing: 2, open: 1, done: 2, hid: { open: 3, done: 3 }, named: false })).filter((t) => t.trim()),
        ['  5/11 tasks done · 2 in progress', '  ◼ Draft the outline', '  ◼ Check the sample data', '  ✔ Write the summary', '  ✔ Review the notes', '  ◻ Tidy the folders', '  … +6 tasks (3 open, 3 done)']);
      assert.deepEqual(text(v2({ doing: 0, open: 2, done: 3, hid: { open: 3 }, named: false })).filter((t) => t.trim()).slice(0, 1), ['  3/8 tasks done']);
      assert.deepEqual(text(v2({ doing: 0, open: 1, done: 0, named: false })).filter((t) => t.trim()), ['  0/1 task done', '  ◻ Draft the outline']);
      assert.equal(text(v2({ doing: 2, open: 1, done: 2, hid: { done: 1 } })).at(-1), '  … +1 task (1 done)');
    });

    test('(+) 5 rows and the overflow row, with and without the in-progress part: named and unnamed, every anchor, the permission prompt, a question dialog that is read', () => {
      const shapes = {
        'with in progress': { doing: 2, open: 1, done: 2, hid: { open: 3, done: 3 } },
        'without in progress': { doing: 0, open: 2, done: 3, hid: { open: 3 } },
      };
      for (const [name, o] of Object.entries(shapes)) {
        for (const [i, tail] of forms(o).entries()) cutUnder(`${name} / ${i === 0 ? 'named' : 'unnamed'}`, tail);
      }
    });

    test('(+) every overflow row seen in the spike, one by one (the parts above 0, in the order in progress, open, done; "task" for one)', () => {
      const seen = {
        '(1 in progress)': { hid: { doing: 1 } },
        '(3 open)': { hid: { open: 3 } },
        '(3 done)': { hid: { done: 3 } },
        '(1 open, 3 done)': { hid: { open: 1, done: 3 } },
        '(1 in progress, 4 done)': { hid: { doing: 1, done: 4 } },
        '(1 in progress, 2 open, 3 done)': { hid: { doing: 1, open: 2, done: 3 } },
        '+1 task (1 done)': { hid: { done: 1 } },
        '+1 task (1 open)': { hid: { open: 1 } },
        '(2 in progress, 2 open)': { hid: { doing: 2, open: 2 } },
        'four-digit counts': { hid: { doing: 1, open: 1234, done: 4321 } },
      };
      for (const [name, o] of Object.entries(seen)) {
        for (const [i, tail] of forms({ doing: 2, open: 1, done: 2, ...o }).entries()) cutUnder(`${name} / ${i === 0 ? 'named' : 'unnamed'}`, tail);
      }
    });

    test('(+) the other shapes: all done, one task (0/1 task done, 1/1 task done), three rows and no overflow row at 12-13 rows, the header alone, no hidden tasks', () => {
      const shapes = {
        'all done, overflow': { doing: 0, open: 0, done: 5, hid: { done: 3 } },
        'all done, no overflow': { doing: 0, open: 0, done: 4 },
        '1/1 task done': { doing: 0, open: 0, done: 1 },
        '0/1 task done, open': { doing: 0, open: 1, done: 0 },
        '0/1 task done, in progress': { doing: 1, open: 0, done: 0 },
        '3 rows, tasks hidden, no overflow row (in progress only)': { doing: 3, open: 0, done: 0, claim: { total: 9, done: 3, doing: 4 } },
        '3 rows, tasks hidden, no overflow row (mixed)': { doing: 1, open: 1, done: 1, claim: { total: 10, done: 4, doing: 2 } },
        '3 rows, no in-progress part': { doing: 0, open: 3, done: 0, claim: { total: 9, done: 3 } },
        'header only': { doing: 0, open: 0, done: 0, claim: { total: 9, done: 3, doing: 4 } },
        'header only, no in-progress part': { doing: 0, open: 0, done: 0, claim: { total: 9, done: 3 } },
        'header only, all done': { doing: 0, open: 0, done: 0, claim: { total: 6, done: 6 } },
        'header only, one task': { doing: 0, open: 0, done: 0, claim: { total: 1, done: 0 } },
        'no hidden tasks, no overflow row': {},
        'labels that look like block rows': { labels: ['3/9 tasks done', '… +3 tasks (3 done)', 'Tidy the folders (@robin)', 'Review the notes › blocked by #1', 'A label cut by Claude…'], hid: { done: 3 } },
      };
      for (const [name, o] of Object.entries(shapes)) {
        for (const [i, tail] of forms(o).entries()) cutUnder(`${name} / ${i === 0 ? 'named' : 'unnamed'}`, tail);
      }
    });

    test('(+) a taller pane has more blank rows above the block; padded rows, trailing blank rows and a trailing row of spaces', () => {
      const o = { doing: 2, open: 1, done: 2, hid: { done: 3 } };
      for (const blank of [3, 11, 20]) cutUnder(`${blank} blank rows`, v2({ named: true, blank, ...o }));
      for (const blank of [1, 3, 11]) cutUnder(`${blank} blank rows, unnamed`, v2({ named: false, blank, ...o }));
      const pad = (rows, cols) => rows.map((r) => [...r, span(' '.repeat(Math.max(0, cols - r.map((sp) => sp.t).join('').length)))]);
      for (const [name, make] of Object.entries(dialogs)) {
        const dialog = make();
        const block = v2({ cols: 64, ...o });
        assert.equal(at(pad([...dialog, ...block], 120)), end(dialog), `${name}: padded`);
        assert.equal(at([...dialog, ...block, [], []]), end(dialog), `${name}: trailing blank rows`);
        assert.equal(at([...dialog, ...block, [span(' '.repeat(64))]]), end(dialog), `${name}: a trailing row of spaces`);
      }
    });

    test('(+) the 2.1.325 form is read as before, next to the new one (same dialogs, same anchors)', () => {
      for (const tail of [taskRows(), taskRows({ named: false }), taskRows({ doing: 1, open: 0, shownDone: 4, hiddenDone: 12 }), taskRows({ hiddenOpen: 2, hiddenDone: 0 }),
        taskRows({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0, claim: { total: 5, done: 3, open: 2 } })]) cutUnder('2.1.325 block', tail);
    });

    test('(+) every reader sees the last row of the dialog or the prompt as the last row; the prompt, its sig and the bypass window do not change', () => {
      for (const [name, make] of Object.entries(dialogs)) {
        for (const tail of forms({ doing: 2, open: 1, done: 2, hid: { open: 1, done: 3 } })) {
          const dialog = make();
          const rows = [...dialog, ...tail];
          assert.deepEqual(lastNonBlank(rows, 15), lastNonBlank(dialog, 15), name);
          assert.equal(modeFromRows(rows), modeFromRows(dialog), name);
          assert.deepEqual(promptFromRows(rows), promptFromRows(dialog), name);
          assert.equal(promptSig(rows), promptSig(dialog), name);
          assert.equal(bypassWindow(rows), false, name);
        }
      }
      assert.equal(promptFromRows(PROMPT) !== null, true, 'control: the prompt parses');
      for (const tail of forms()) assert.equal(capture([...PROMPT, ...tail]), null, 'a permission prompt is no dialog, with the block as without it');
      const labelled = [...PROMPT, ...v2({ labels: ['Check the bypass settings'] })];
      assert.equal(at(labelled), end(PROMPT), 'the block is cut for every other reader');
      assert.equal(bypassWindow(labelled), true, 'the literal bottom of the screen mentions bypass, so the guard still sees it');
    });

    test('(−) a block that mixes the two forms is not cut: the 2.1.326 header with a 2.1.325 overflow row, and the 2.1.325 header with a 2.1.326 one', () => {
      const old = (more, o = {}) => { const rows = taskRows({ hiddenDone: 3, ...o }); rows[rows.length - 1] = [span(more)]; return rows; };
      keptBoth('new header, old overflow row (pending, completed, three spaces)', { hid: { open: 1, done: 3 }, more: '   … +1 pending, 3 completed' });
      keptBoth('new header, old overflow row, completed only', { hid: { done: 3 }, more: '   … +3 completed' });
      keptBoth('new header, old overflow row, in progress only', { hid: { doing: 1 }, more: '   … +1 in progress' });
      keptUnder('old header, new overflow row (two spaces)', old('  … +3 tasks (3 done)'));
      keptUnder('old header, new overflow row, unnamed', old('  … +3 tasks (3 done)', { named: false }));
      keptUnder('old header, new overflow row with a state of the old words', old('  … +3 tasks (3 completed)'));
      keptUnder('old header, overflow row of the old shape with the new words (open, done)', old('   … +1 open, 3 done'));
      keptUnder('old header, overflow row of the old shape with the new word done', old('   … +3 done'));
      keptUnder('old header, overflow row of the old words with two spaces', old('  … +3 completed'));
    });

    test('(−) the 2.1.326 header: "1/2 task done", "0/1 tasks done", "1/1 tasks done", done + in progress above the total, "0 in progress", T = 0, other shapes', () => {
      const rowsFor = { doing: 1, open: 0, done: 1 };
      keptBoth('1/2 task done', { ...rowsFor, head: '  1/2 task done · 1 in progress' });
      keptBoth('0/1 tasks done', { doing: 0, open: 1, done: 0, head: '  0/1 tasks done' });
      keptBoth('1/1 tasks done', { doing: 0, open: 0, done: 1, head: '  1/1 tasks done' });
      keptBoth('3/9 task done', { doing: 0, open: 6, done: 3, head: '  3/9 task done' });
      keptBoth('0 in progress, with rows', { doing: 0, open: 2, done: 1, head: '  1/3 tasks done · 0 in progress' });
      for (const [name, head] of Object.entries({
        'header alone: 3 done + 2 in progress of 4': '  3/4 tasks done · 2 in progress',
        'header alone: done above the total': '  5/4 tasks done',
        'header alone: 0 in progress': '  1/3 tasks done · 0 in progress',
        'header alone: 0/0 tasks': '  0/0 tasks done',
        'header alone: 0/0 task': '  0/0 task done',
        'header alone: 1/2 task': '  1/2 task done',
        'header alone: 0/1 tasks': '  0/1 tasks done',
        'header alone: indented by one space': ' 3/9 tasks done',
        'header alone: indented by three spaces': '   3/9 tasks done',
        'header alone: not indented': '3/9 tasks done',
        'header alone: a comma instead of the middle dot': '  3/9 tasks done, 1 in progress',
        'header alone: in progress and open parts': '  3/9 tasks done · 1 in progress · 5 open',
        'header alone: words instead of the slash': '  3 of 9 tasks done',
        'header alone: five digits': '  10000/10000 tasks done',
        'header alone: a negative number': '  -1/3 tasks done',
      })) keptBoth(name, { doing: 0, open: 0, done: 0, head });
    });

    test('(−) the 2.1.326 overflow row: "+2 task", "+1 tasks", a sum that is not N, a leading zero, parts out of order or twice or "0 open", old words, a wrong indent, a wrong shape', () => {
      const o = { doing: 1, open: 1, done: 2 };
      const cases = {
        '+2 task (...)': { hid: { open: 1, done: 1 }, more: '  … +2 task (1 open, 1 done)' },
        '+1 tasks (...)': { hid: { done: 1 }, more: '  … +1 tasks (1 done)' },
        'N above the sum': { hid: { open: 1, done: 3 }, more: '  … +5 tasks (1 open, 3 done)' },
        'N below the sum': { hid: { open: 1, done: 3 }, more: '  … +3 tasks (1 open, 3 done)' },
        'N with a leading zero': { hid: { open: 1, done: 3 }, more: '  … +04 tasks (1 open, 3 done)' },
        'N of zero': { hid: { done: 3 }, more: '  … +0 tasks (3 done)' },
        'done before open': { hid: { open: 1, done: 3 }, more: '  … +4 tasks (3 done, 1 open)' },
        'open before in progress': { hid: { doing: 1, open: 1 }, more: '  … +2 tasks (1 open, 1 in progress)' },
        'done before in progress': { hid: { doing: 1, done: 1 }, more: '  … +2 tasks (1 done, 1 in progress)' },
        'open twice': { hid: { open: 2 }, more: '  … +2 tasks (1 open, 1 open)' },
        'in progress twice': { hid: { doing: 2 }, more: '  … +2 tasks (1 in progress, 1 in progress)' },
        'done twice': { hid: { done: 2 }, more: '  … +2 tasks (1 done, 1 done)' },
        '0 open': { hid: { done: 3 }, more: '  … +3 tasks (0 open, 3 done)' },
        '0 in progress': { hid: { done: 3 }, more: '  … +3 tasks (0 in progress, 3 done)' },
        '0 done': { hid: { open: 3 }, more: '  … +3 tasks (3 open, 0 done)' },
        'pending and completed': { hid: { open: 1, done: 3 }, more: '  … +4 tasks (1 pending, 3 completed)' },
        'completed only': { hid: { done: 3 }, more: '  … +3 tasks (3 completed)' },
        'pending only': { hid: { open: 3 }, more: '  … +3 tasks (3 pending)' },
        'open and completed': { hid: { open: 1, done: 3 }, more: '  … +4 tasks (1 open, 3 completed)' },
        'pending and done': { hid: { open: 1, done: 3 }, more: '  … +4 tasks (1 pending, 3 done)' },
        'three spaces': { hid: { open: 1, done: 3 }, more: '   … +4 tasks (1 open, 3 done)' },
        'one space': { hid: { open: 1, done: 3 }, more: ' … +4 tasks (1 open, 3 done)' },
        'four spaces': { hid: { open: 1, done: 3 }, more: '    … +4 tasks (1 open, 3 done)' },
        'no parentheses': { hid: { open: 1, done: 3 }, more: '  … +4 tasks 1 open, 3 done' },
        'empty parentheses': { hid: { open: 1, done: 3 }, more: '  … +4 tasks ()' },
        'text after the parentheses': { hid: { open: 1, done: 3 }, more: '  … +4 tasks (1 open, 3 done) soon' },
        'parts joined by a space': { hid: { open: 1, done: 3 }, more: '  … +4 tasks (1 open 3 done)' },
        'a word that is not a state': { hid: { open: 1, done: 3 }, more: '  … +4 tasks (1 open, 3 finished)' },
        'no word after the number': { hid: { open: 1, done: 3 }, more: '  … +4 (1 open, 3 done)' },
        'ASCII dots instead of the ellipsis': { hid: { open: 1, done: 3 }, more: '  ... +4 tasks (1 open, 3 done)' },
      };
      for (const [name, c] of Object.entries(cases)) keptBoth(name, { ...o, ...c });
    });

    test('(−) sums that do not add up: with an overflow row (each state, both ways), and more rows of a state than the header counts with no overflow row', () => {
      const base = { doing: 1, open: 1, done: 2, hid: { doing: 1, open: 2, done: 3 } }; // rows 1 / 1 / 2, hidden 1 / 2 / 3: in progress 2, open 3, done 5, total 10
      forms(base).forEach((tail, i) => cutUnder(`control: the true numbers / ${i}`, tail));
      const wrong = {
        'total one too high (open)': { claim: { total: 11 } },
        'total one too low (open)': { claim: { total: 9 } },
        'done one too high': { claim: { done: 6, total: 11 } },
        'done one too low': { claim: { done: 4, total: 9 } },
        'in progress one too high': { claim: { doing: 3, total: 11 } },
        'in progress one too low': { claim: { doing: 1, total: 9 } },
        'no in-progress part though tasks are in progress': { claim: { doing: 0, total: 8 } },
        'hidden in progress one too many': { more: '  … +7 tasks (2 in progress, 2 open, 3 done)' },
        'hidden open one too few': { more: '  … +5 tasks (1 in progress, 1 open, 3 done)' },
        'hidden done one too many': { more: '  … +7 tasks (1 in progress, 2 open, 4 done)' },
      };
      for (const [name, c] of Object.entries(wrong)) keptBoth(name, { ...base, ...c });
      // no overflow row (the 12-13 row pane): a state may show FEWER rows than the header counts, never more
      const noMore = {
        'more in-progress rows than the header counts': { doing: 3, open: 1, done: 1, claim: { doing: 2, total: 5 } },
        'more open rows than the header counts': { doing: 1, open: 3, done: 1, claim: { total: 4 } },
        'more done rows than the header counts': { doing: 1, open: 1, done: 3, claim: { done: 2, total: 4 } },
        'a row for a state the header counts as 0': { doing: 1, open: 0, done: 0, claim: { total: 1, done: 0, doing: 0 } },
      };
      for (const [name, o] of Object.entries(noMore)) keptBoth(name, o);
      keptUnder('2.1.325: fewer rows than the header counts and no overflow row stays exact', taskRows({ hiddenDone: 0, claim: { done: 4, total: 6 } }));
      keptUnder('2.1.325: more in-progress rows than the header counts', taskRows({ hiddenDone: 0, doing: 2, open: 0, shownDone: 1, claim: { doing: 1, total: 3, open: 1 } }));
    });

    test('(−) the places: a rule row with two blank rows or none under it, a text row, an unknown glyph, a second row under a task, a notice, the block not at the bottom, an overflow row with no task row', () => {
      const o = { doing: 2, open: 1, done: 2, hid: { open: 1, done: 3 } };
      const note = [span('  A notice from the shell')];
      const headAt = (rows) => rows.findIndex((r) => /tasks? done/.test(rowText(r)));
      const edit = (change, named = true) => { const rows = v2({ named, ...o }); change(rows); return rows; };
      keptUnder('a rule row followed by two blank rows', v2({ gap: 2, ...o }));
      keptUnder('a rule row followed by no blank row', v2({ gap: 0, ...o }));
      keptUnder('an unnamed block with no blank row above the header', v2({ named: false, blank: 0, ...o }));
      keptUnder('a rule row indented by two spaces', v2({ rule: 'indented', ...o }));
      keptUnder('a text row instead of the blank row between the rule and the header', edit((rows) => { rows[headAt(rows) - 1] = note; }));
      keptUnder('a text row instead of the rule row', edit((rows) => { rows[headAt(rows) - 2] = note; }));
      keptUnder('a text row between the dialog end and an unnamed block', edit((rows) => rows.splice(headAt(rows), 0, note, []), false));
      keptUnder('a row with an unknown glyph', edit((rows) => rows.splice(headAt(rows) + 2, 0, [span('  ● Another thing')])));
      keptUnder('a task row indented by one space', edit((rows) => { rows[headAt(rows) + 1] = [span(' ◼ Draft the outline')]; }));
      keptUnder('a task row indented by three spaces', edit((rows) => { rows[headAt(rows) + 1] = [span('   ◼ Draft the outline')]; }));
      keptUnder('a glyph row without a label', edit((rows) => { rows[headAt(rows) + 1] = [span('  ◼ ')]; }));
      keptUnder('a second row under a task', edit((rows) => rows.splice(headAt(rows) + 2, 0, [span('    rest of the label')])));
      keptUnder('a notice after the last row of the block', [...v2(o), note]);
      keptUnder('a notice between the tasks', edit((rows) => rows.splice(headAt(rows) + 3, 0, note)));
      keptUnder('two overflow rows', [...v2(o), [span('  … +3 tasks (3 done)')]]);
      keptUnder('the overflow row is not the last row', (() => { const rows = v2(o); rows.push(rows.splice(-2, 1)[0]); return rows; })());
      keptUnder('an overflow row and no task row', v2({ doing: 0, open: 0, done: 0, hid: { done: 3 } }));
      keptUnder('an overflow row under the header alone, in progress', v2({ doing: 0, open: 0, done: 0, hid: { doing: 1, done: 2 } }));
      keptUnder('a real block, a later message and a real input box (the block is not at the bottom)', [...v2(o), [span('⏺ A later message.')], ...rowsOf('transcript line', ...BOX, PHRASE.auto)]);
      keptUnder('a subagent list below the block', [...v2(o), ...subagentRows({ agents: 2 })]);
      keptUnder('the block below a subagent list', [...subagentRows({ agents: 2 }), ...v2(o)]);
      for (const tail of forms(o)) {
        const rows = [...rowsOf('transcript line', ...BOX, PHRASE.plan), ...tail];
        assert.equal(at(rows), rows.length - 1, 'the block under a mode line is no block');
        assert.equal(modeFromRows(rows), 'unknown', 'the block is the last row: not a mode line, as before');
      }
      const noAnchor = [...rowsOf('transcript line', 'a message', 'Esc to cancel · Tab to amend'), ...v2(o)];
      assert.equal(at(noAnchor), noAnchor.length - 1, 'Esc to cancel with no prompt above it is no anchor');
    });
  });
});

// ---- 0.5, LC18: Claude's task list pinned ABOVE the input box (taskBlockAbove: the same block reader as the list under a dialog) --------
describe('taskBlockAbove: the task list pinned above the input box (LC18)', () => {
  const FULL = '─'.repeat(120);
  const NAMED_RULE = `${'─'.repeat(104)} demo-session ─`;
  const line = (t) => [span(t)];
  const text = (rows) => rows.map(rowText);
  /** The 2.1.325 block alone (header, task rows, overflow row): taskRows with no rule row and no blank rows. Made-up labels. */
  const v1 = (o = {}) => taskRows({ named: false, blank: 0, ...o });
  /** The 2.1.326 block alone; the same arithmetic as the builder of the T326 tests above (kept here so those tests stay as they are). */
  const v2 = ({ doing = 1, open = 1, done = 2, hid = {}, claim = {}, head = null, more = null } = {}) => {
    const [hd, ho, hx] = [hid.doing ?? 0, hid.open ?? 0, hid.done ?? 0];
    const n = { total: doing + open + done + hd + ho + hx, done: done + hx, doing: doing + hd, ...claim };
    const headText = head ?? `  ${n.done}/${n.total} ${n.total === 1 ? 'task' : 'tasks'} done${n.doing > 0 ? ` · ${n.doing} in progress` : ''}`;
    const sum = hd + ho + hx;
    const parts = [[hd, 'in progress'], [ho, 'open'], [hx, 'done']].filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`);
    const moreText = more ?? (sum > 0 ? `  … +${sum} ${sum === 1 ? 'task' : 'tasks'} (${parts.join(', ')})` : null);
    return [...taskRows({ named: false, blank: 0, doing, open, shownDone: done, hiddenDone: 0, head: headText }), ...(moreText === null ? [] : [line(moreText)])];
  };
  /**
   * A whole screen as Claude draws it: `before` rows of conversation, the block, `mid` (a row between the block and the blank rows, if any), `gap` blank rows,
   * the box's top rule, a one-row box, the lower rule and the mode line. `top` is the top rule's row, `head` where the block's header sits.
   */
  const screen = (block, { before = 3, gap = 1, rule = FULL, mid = null } = {}) => {
    const rows = [
      ...Array.from({ length: before }, (_, i) => line(`transcript line ${i}`)),
      ...block, ...(mid === null ? [] : [mid]),
      ...Array.from({ length: gap }, () => []),
      line(rule), line('❯ '), line(FULL), line('  ⏸ manual mode on'),
    ];
    return { texts: text(rows), top: before + block.length + (mid === null ? 0 : 1) + gap, head: before };
  };
  const edit = (block, change) => { const rows = block.map((r) => [...r]); change(rows); return rows; };
  const headAt = (rows) => rows.findIndex((r) => /tasks? \(|tasks? done/.test(rowText(r)));

  /** Every shape of both versions that is a block (the shapes of the F13-A and T326 tests, made up). */
  const SHAPES = {
    '2.1.325 plain block': v1(),
    '2.1.325 no in-progress part, all done, overflow': v1({ doing: 0, open: 0, shownDone: 5, hiddenDone: 3 }),
    '2.1.325 1 tasks (one in progress)': v1({ doing: 1, open: 0, shownDone: 0, hiddenDone: 0 }),
    '2.1.325 1 tasks (one done)': v1({ doing: 0, open: 0, shownDone: 1, hiddenDone: 0 }),
    '2.1.325 no overflow row': v1({ hiddenDone: 0 }),
    '2.1.325 overflow: in progress': v1({ hiddenDoing: 2, hiddenDone: 0 }),
    '2.1.325 overflow: pending': v1({ hiddenOpen: 2, hiddenDone: 0 }),
    '2.1.325 overflow: all three': v1({ hiddenDoing: 1, hiddenOpen: 2, hiddenDone: 3 }),
    '2.1.325 header only': v1({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0, claim: { total: 5, done: 3, open: 2 } }),
    '2.1.325 header only, in progress': v1({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0, claim: { total: 5, done: 3, doing: 1, open: 1 } }),
    '2.1.325 mixed order': v1({ order: 'xdxoxo', hiddenDone: 1 }),
    '2.1.325 long list': v1({ doing: 3, open: 2, shownDone: 5, hiddenDone: 1234 }),
    '2.1.325 labels with suffixes': v1({ labels: ['A label that was cut by Claude…', 'Review the notes › blocked by #1, #2', 'Tidy the folders (@robin)', '◼ ✔ ◻ inside the label'] }),
    '2.1.326 5 rows and the overflow row, in progress': v2({ doing: 2, open: 1, done: 2, hid: { open: 3, done: 3 } }),
    '2.1.326 5 rows and the overflow row, no in-progress part': v2({ doing: 0, open: 2, done: 3, hid: { open: 3 } }),
    '2.1.326 all done, overflow': v2({ doing: 0, open: 0, done: 5, hid: { done: 3 } }),
    '2.1.326 all done, no overflow': v2({ doing: 0, open: 0, done: 4 }),
    '2.1.326 1/1 task done': v2({ doing: 0, open: 0, done: 1 }),
    '2.1.326 0/1 task done': v2({ doing: 0, open: 1, done: 0 }),
    '2.1.326 +1 task (1 done)': v2({ doing: 2, open: 1, done: 2, hid: { done: 1 } }),
    '2.1.326 three rows, tasks hidden, no overflow row': v2({ doing: 1, open: 1, done: 1, claim: { total: 10, done: 4, doing: 2 } }),
    '2.1.326 header only': v2({ doing: 0, open: 0, done: 0, claim: { total: 9, done: 3, doing: 4 } }),
    '2.1.326 header only, all done': v2({ doing: 0, open: 0, done: 0, claim: { total: 6, done: 6 } }),
    '2.1.326 four-digit counts': v2({ doing: 2, open: 1, done: 2, hid: { doing: 1, open: 1234, done: 4321 } }),
  };
  /** Rows that look like a block and are not one (the numbers do not add up, a shape that is no block row): the same reader refuses them under a dialog. */
  const MISFITS = {
    '2.1.325 the total does not add up': v1({ claim: { total: 8 } }),
    '2.1.325 the done count does not match the rows and the overflow row': v1({ claim: { done: 6, total: 8 } }),
    '2.1.325 the in-progress count does not match the rows': v1({ claim: { doing: 2, total: 8 } }),
    '2.1.325 the open count does not match the rows': v1({ claim: { open: 2, total: 8 } }),
    '2.1.325 the hidden in-progress count does not match': v1({ hiddenDoing: 2, claim: { doing: 4, total: 10 } }),
    '2.1.325 no task at all (total 0)': v1({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }),
    '2.1.325 an overflow row and no task row': v1({ doing: 0, open: 0, shownDone: 0, hiddenDone: 3 }),
    '2.1.325 the header says 0 in progress': v1({ doing: 0, open: 2, shownDone: 2, hiddenDone: 0, head: '  4 tasks (2 done, 0 in progress, 2 open)' }),
    '2.1.325 the header says 1 task': v1({ doing: 0, open: 0, shownDone: 1, hiddenDone: 0, head: '  1 task (1 done, 0 open)' }),
    '2.1.325 the overflow row names a state that does not exist': edit(v1(), (rows) => { rows[rows.length - 1] = line('   … +3 finished'); }),
    '2.1.325 a row with an unknown glyph': edit(v1(), (rows) => rows.splice(2, 0, line('  ● Another thing'))),
    '2.1.325 a task row indented by one space': edit(v1(), (rows) => { rows[1] = line(' ◼ Draft the outline'); }),
    '2.1.325 a task row indented by three spaces': edit(v1(), (rows) => { rows[1] = line('   ◼ Draft the outline'); }),
    '2.1.325 a glyph row without a label': edit(v1(), (rows) => { rows[1] = line('  ◼ '); }),
    '2.1.325 a second row under a task': edit(v1(), (rows) => rows.splice(2, 0, line('    rest of the label'))),
    '2.1.325 a notice between the tasks': edit(v1(), (rows) => rows.splice(3, 0, line('  A notice from the shell'))),
    '2.1.325 a notice after the last row of the block': [...v1(), line('  A notice from the shell')],
    '2.1.326 done + in progress above the total': v2({ doing: 1, open: 1, done: 2, claim: { total: 2 } }),
    '2.1.326 more rows of a state than the header counts, no overflow row': v2({ doing: 1, open: 1, done: 2, claim: { total: 3 } }),
    '2.1.326 +N is not the sum': v2({ hid: { open: 1, done: 3 }, more: '  … +5 tasks (1 open, 3 done)' }),
    '2.1.326 "+1 tasks"': v2({ hid: { done: 1 }, more: '  … +1 tasks (1 done)' }),
    '2.1.326 parts out of order': v2({ hid: { open: 1, done: 3 }, more: '  … +4 tasks (3 done, 1 open)' }),
    '2.1.326 the words of the old version': v2({ hid: { done: 3 }, more: '  … +3 tasks (3 completed)' }),
    '2.1.326 header "1/2 task done"': v2({ doing: 0, open: 1, done: 1, head: '  1/2 task done' }),
    '2.1.326 header "0 in progress"': v2({ doing: 0, open: 2, done: 1, head: '  1/3 tasks done · 0 in progress' }),
    '2.1.326 an overflow row and no task row': v2({ doing: 0, open: 0, done: 0, hid: { done: 3 } }),
    '2.1.326 two overflow rows': [...v2({ hid: { done: 3 } }), line('  … +3 tasks (3 done)')],
    'the 2.1.326 header with a 2.1.325 overflow row': v2({ hid: { open: 1, done: 3 }, more: '   … +1 pending, 3 completed' }),
    'the 2.1.325 header with a 2.1.326 overflow row': edit(v1({ hiddenDone: 3 }), (rows) => { rows[rows.length - 1] = line('  … +3 tasks (3 done)'); }),
  };
  const DIALOG = rowsOf('transcript line', '', 'Which project should I open?', '', '❯ 1. acme-api', '  2. Type something.', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel');

  test('(+) the header row of every shape of both versions, for 0, 3 and 40 conversation rows above it, under a plain or a labelled top rule', () => {
    for (const [name, block] of Object.entries(SHAPES)) {
      for (const before of [0, 3, 40]) {
        for (const rule of [FULL, NAMED_RULE]) {
          const s = screen(block, { before, rule });
          assert.equal(taskBlockAbove(Object.freeze(s.texts), s.top), s.head, `${name} / ${before} rows before / ${rule === FULL ? 'plain' : 'labelled'} rule`);
        }
      }
    }
  });

  test('(+) the answer is a row of the block\'s header: 0 <= index < top, and the row reads as a header', () => {
    for (const [name, block] of Object.entries(SHAPES)) {
      const s = screen(block);
      const at = taskBlockAbove(s.texts, s.top);
      assert.ok(Number.isInteger(at) && at >= 0 && at < s.top, name);
      assert.match(s.texts[at], /^ {2}(?:\d+ tasks \(|\d+\/\d+ tasks? done)/, name);
    }
  });

  test('(+) the same reader as the list under a dialog: every shape is cut under a dialog and found above a box; every misfit is neither', () => {
    for (const [name, block] of Object.entries(SHAPES)) {
      assert.equal(footerEnd(text([...DIALOG, [], ...block])), DIALOG.length - 1, `${name}: cut under a dialog`);
    }
    for (const [name, block] of Object.entries(MISFITS)) {
      const rows = [...DIALOG, [], ...block];
      assert.equal(footerEnd(text(rows)), rows.length - 1, `${name}: not cut under a dialog`);
      const s = screen(block);
      assert.equal(taskBlockAbove(s.texts, s.top), -1, `${name}: not found above a box`);
    }
  });

  test('(+) rows padded with spaces to the pane width, a blank row of spaces or no-break spaces, and rows below the box do not matter', () => {
    for (const [name, block] of Object.entries(SHAPES)) {
      const s = screen(block);
      const padded = s.texts.map((t) => t.padEnd(120, ' '));
      assert.equal(taskBlockAbove(padded, s.top), s.head, `${name}: padded`);
      const spaced = s.texts.map((t, i) => (i === s.top - 1 ? ' '.repeat(120) : t));
      assert.equal(taskBlockAbove(spaced, s.top), s.head, `${name}: a blank row of no-break spaces`);
      assert.equal(taskBlockAbove(s.texts.slice(0, s.top + 1), s.top), s.head, `${name}: only the rows up to the top rule`);
      assert.equal(taskBlockAbove([...s.texts, 'a status line', ''], s.top), s.head, `${name}: more rows below`);
    }
  });

  test('(+) a block quoted in the conversation above the real one is not part of it: the header is the real block\'s', () => {
    const quoted = screen(v1(), { before: 0 }).texts.slice(0, -4); // a whole block (header, rows, overflow) in the conversation
    const s = screen(SHAPES['2.1.326 5 rows and the overflow row, in progress'], { before: 0 });
    const texts = [...quoted, '', ...s.texts];
    assert.equal(taskBlockAbove(texts, s.top + quoted.length + 1), quoted.length + 1);
  });

  test('(−) the places: two or three blank rows, none, a text row in place of the blank row, a row between the block and the blank row', () => {
    for (const [name, block] of Object.entries(SHAPES)) {
      for (const [what, opts] of Object.entries({
        'two blank rows': { gap: 2 },
        'three blank rows': { gap: 3 },
        'no blank row': { gap: 0 },
        'a notice between the block and the blank row': { mid: line('  A notice from the shell') },
        'a conversation row between the block and the blank row': { mid: line('⏺ The old block is above.') },
      })) {
        const s = screen(block, opts);
        assert.equal(taskBlockAbove(s.texts, s.top), -1, `${name} / ${what}`);
      }
      const s = screen(block);
      const noBlank = s.texts.map((t, i) => (i === s.top - 1 ? '  a note' : t));
      assert.equal(taskBlockAbove(noBlank, s.top), -1, `${name} / a text row instead of the blank row`);
    }
  });

  test('(−) block shapes that are no block: the numbers do not add up, an unknown glyph, a wrong indent, a notice, mixed versions, a second overflow row', () => {
    for (const [name, block] of Object.entries(MISFITS)) {
      for (const before of [0, 3]) {
        const s = screen(block, { before });
        assert.equal(taskBlockAbove(s.texts, s.top), -1, `${name} / ${before} rows before`);
      }
    }
  });

  test('(−) `top` must be the box\'s top rule: out of range, not an integer, or a row that is not a rule row (an indented dash row, the blank row, the header, the box row)', () => {
    const s = screen(SHAPES['2.1.325 plain block']);
    assert.equal(taskBlockAbove(s.texts, s.top), s.head, 'control');
    for (const top of [-1, 0, 1, s.texts.length, s.texts.length + 5, 2 ** 31, 1.5, NaN, Infinity, String(s.top), [s.top], null, undefined, {}]) {
      assert.equal(taskBlockAbove(s.texts, top), -1, `top = ${String(top)}`);
    }
    for (const [what, at] of Object.entries({ 'the blank row': s.top - 1, 'the last row of the block': s.top - 2, 'the header': s.head, 'the box row': s.top + 1, 'the mode line': s.texts.length - 1 })) {
      assert.equal(taskBlockAbove(s.texts, at), -1, what);
    }
    const indented = s.texts.map((t, i) => (i === s.top ? `  ${t}` : t));
    assert.equal(taskBlockAbove(indented, s.top), -1, 'a rule row indented by two spaces');
    const single = s.texts.map((t, i) => (i === s.top ? '─' : t));
    assert.equal(taskBlockAbove(single, s.top), -1, 'one dash is no rule row');
  });

  test('(−) the lower rule of the box is no top rule: the row above it is the box row, not a blank row', () => {
    const s = screen(SHAPES['2.1.325 plain block']);
    assert.equal(taskBlockAbove(s.texts, s.top + 2), -1);
  });

  test('(−) texts that are not an array of rows: nothing, a string, an object, an array-like', () => {
    const s = screen(SHAPES['2.1.325 plain block']);
    const arrayLike = { length: s.texts.length, ...s.texts };
    for (const texts of [undefined, null, 'x', 42, {}, arrayLike]) assert.equal(taskBlockAbove(texts, s.top), -1, String(texts));
    assert.equal(taskBlockAbove([], 0), -1);
    assert.equal(taskBlockAbove([FULL], 0), -1, 'a rule row and nothing above it');
    assert.equal(taskBlockAbove(['', FULL], 1), -1, 'a blank row and no block');
    assert.equal(taskBlockAbove([...s.texts.slice(0, 1), null, 5, ...s.texts.slice(3)], s.top), s.head, 'a row that is not a string above the block is ignored');
    for (const at of [s.head, s.head + 1, s.top - 2]) { // in the block: the header, a task row, the last row
      const broken = s.texts.map((t, i) => (i === at ? null : t));
      assert.doesNotThrow(() => taskBlockAbove(broken, s.top));
      assert.equal(taskBlockAbove(broken, s.top), -1, `a row that is not a string inside the block (row ${at}) is no block`);
    }
  });

  test('(−) a block under a mode line, or at the bottom of a screen with no box, is not above a box', () => {
    const under = text([line('transcript line'), line(FULL), line('❯ '), line(FULL), line('  ⏸ manual mode on'), [], ...v1()]);
    for (let top = -1; top <= under.length; top += 1) assert.equal(taskBlockAbove(under, top), -1, `top = ${top}`);
    const noBox = text([line('transcript line'), [], ...v1(), []]);
    for (let top = 0; top <= noBox.length; top += 1) assert.equal(taskBlockAbove(noBox, top), -1, `no box / top = ${top}`);
  });

  test('(+) taskBlockAbove is the only new export of the block reader: blockHead stays private', () => {
    assert.equal(typeof taskBlockAbove, 'function');
    assert.equal('blockHead' in mode, false);
    assert.equal('taskEnd' in mode, false);
  });
});

// ---- 0.5.1 E: promptTopRow, the screen row of the permission prompt's question (display only; the page crops the terminal view there) ---------------
describe('promptTopRow (0.5.1 E)', () => {
  const HINT = 'Esc to cancel · Tab to amend';
  const top = (rows) => mode.promptTopRow(rows);
  const BASH = ['Bash command', 'Run the build script', '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌', 'npm run build', '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌', 'Do you want to proceed?',
    '❯ 1. Yes', '  2. Yes, and always allow access to demo from this', '     project', '  3. No', HINT];
  const QUESTION = 5;
  const questionAt = (rows) => rows.findIndex((r) => rowText(r).trim() === 'Do you want to proceed?');

  test('(+) the row of the question: the row directly above option 1, as promptFromRows reads it', () => {
    const rows = rowsOf(...BASH);
    assert.equal(top(rows), QUESTION);
    assert.equal(rowText(rows[top(rows)]).trim(), promptFromRows(rows).question);
    assert.equal(top(rowsOf('Proceed?', '❯ 1. Yes', '  2. No', HINT)), 0, 'a prompt that starts the screen: row 0 (the page treats 0 as no crop)');
  });

  test('(+) rows above shift it; blank rows between the prompt\'s rows are skipped, so non-blank rows map back to screen rows', () => {
    const above = Array.from({ length: 30 }, (_, i) => `transcript line ${i}`);
    assert.equal(top(rowsOf(...above, ...BASH)), 30 + QUESTION);
    const spread = rowsOf('x', 'Bash command', '', '  npm run build', '', 'Do you want to proceed?', '', '❯ 1. Yes', '', '  2. No', '', HINT);
    assert.equal(top(spread), 5, 'blank rows between the question and option 1 do not move it');
    assert.equal(rowText(spread[top(spread)]).trim(), 'Do you want to proceed?');
    assert.equal(top([...rowsOf(...BASH), [], [span('  ')], []]), QUESTION, 'blank rows under the hint');
  });

  test('(+) the task list or the lone rule row Claude draws under a prompt (F13) does not move it', () => {
    for (const named of [true, false]) {
      for (const blank of [named ? 0 : 1, 3, 11]) {
        const rows = [...rowsOf(...BASH), ...taskRows({ named, blank })];
        assert.equal(top(rows), QUESTION, `named ${named} / ${blank} blank rows`);
      }
    }
    const rule = taskRows({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }).slice(0, 1);
    assert.equal(top([...rowsOf(...BASH), [], ...rule]), QUESTION, 'a lone rule row');
    const screen = taskScreen(rowsOf(...BASH), { rows: 45, named: true });
    assert.equal(top(screen), 12 + QUESTION, 'a whole 45-row screen, the prompt 12 rows down');
    assert.equal(rowText(screen[top(screen)]).trim(), 'Do you want to proceed?');
  });

  test('(+) a prompt whose question row is the oldest row of the window is still found (PROMPT_ROWS non-blank rows)', () => {
    const block = (k) => ['Proceed?', '1. Yes', ...Array.from({ length: k }, (_, i) => `     wrapped ${i}`), '2. No', HINT];
    const rows = rowsOf('older row', '', ...block(PROMPT_ROWS - 4));
    assert.equal(top(rows), 2);
    assert.equal(rowText(rows[top(rows)]).trim(), 'Proceed?');
  });

  test('(+) promptFromRows and lastNonBlank keep their exact output: no new key, same rows (the refactor behind promptTopRow)', () => {
    const rows = rowsOf(...BASH);
    assert.deepEqual(Object.keys(promptFromRows(rows)), ['question', 'options']);
    assert.deepEqual(promptFromRows(rows), {
      question: 'Do you want to proceed?',
      options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, and always allow access to demo from this project' }, { n: 3, label: 'No' }],
    });
    const withBlocks = [...rowsOf('transcript', ...BOX, PHRASE.auto), ...subagentRows({ agents: 2, more: 1 }), [], []];
    assert.deepEqual(lastNonBlank(withBlocks, 3), ['│ > │', '╰──────╯', PHRASE.auto].slice(0, 3));
    assert.deepEqual(lastNonBlank(rows, 99), BASH);
    for (const bad of [0, -1, 1.5, '2', null, undefined]) assert.deepEqual(lastNonBlank(rows, bad), [], String(bad));
  });

  test('(−) null when no prompt parses: nothing there, no question, no hint, a gap in the numbers, fewer than two options', () => {
    for (const rows of [rowsOf('Steps:', '1. Install', '2. Build', HINT), rowsOf('Proceed?', '1. Yes', '3. No', HINT), rowsOf('Proceed?', '1. Yes', HINT),
      rowsOf('Proceed', '1. Yes', '2. No', HINT), rowsOf('Proceed?', '❯ 1. Yes', '  2. No'), rowsOf('1. Yes', '2. No', HINT), rowsOf('transcript', ...BOX, PHRASE.auto)]) {
      assert.equal(top(rows), null);
      assert.equal(promptFromRows(rows), null);
    }
  });

  test('(−) null for a stale prompt, a folder-trust dialog and a prompt that fell out of the window', () => {
    const prompt = ['Proceed?', '1. Yes', '2. No', HINT];
    assert.notEqual(top(rowsOf(...prompt)), null, 'control');
    assert.equal(top(rowsOf(...prompt, ...BOX, PHRASE.manual)), null, 'the box and footer were drawn after it');
    assert.equal(top(rowsOf(...prompt, 'x')), null, 'one row below the hint');
    assert.equal(top(rowsOf('Do you trust the files in this folder?', '❯ Yes, I trust this folder', '  No, exit', 'Enter to confirm · Esc to cancel')), null);
    const old = rowsOf(...prompt, ...Array.from({ length: PROMPT_ROWS }, (_, i) => `line ${i}`), HINT);
    assert.equal(top(old), null, 'the question is more than PROMPT_ROWS non-blank rows above the hint');
  });

  test('(−) not rows at all: null, never throws', () => {
    for (const bad of [null, undefined, 'Esc to cancel', 7, {}, [], [null], [[{}]], rowsOf('', '')]) assert.equal(top(bad), null, String(bad));
  });

  test('(−) it is one more export and nothing else changed: the exports of src/mode.js are the old ones plus promptTopRow', () => {
    assert.equal(typeof mode.promptTopRow, 'function');
    assert.equal(mode.promptTopRow.length, 1);
    assert.equal(/[^\x00-\x7f]/.test(fs.readFileSync(new URL('../src/mode.js', import.meta.url), 'utf8')), false, 'src/mode.js stays ASCII');
  });
});
