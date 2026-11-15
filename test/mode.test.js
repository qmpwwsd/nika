import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as mode from '../src/mode.js';
import {
  MODES, MODE_TARGETS, PROMPT_ROWS, FOOTER, OPTION, rowText, lastNonBlank, modeFromRows, promptFromRows, mentionsBypass, bypassWindow,
  surveyShown, pillShown, SHELL_FOOTER, ASK_FOOTER, PLAN_FOOTER, REVIEW_END, isDialogEnd, nudgeFooterAt, footerEnd,
} from '../src/mode.js';
import { parseCapture } from '../src/mirror.js';
import { subagentRows } from './helpers.js';

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
      'agent without an elapsed time': [...block.slice(0, 2), rowsOf('  ◯ Explore  A  tokens')[0]],
      'elapsed time not at the end': [...block.slice(0, 2), rowsOf('  ◯ Explore  A  5s and more')[0]],
      'tokens without the arrow': [...block.slice(0, 2), rowsOf('  ◯ Explore  A  5s · 23 tokens')[0]],
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

// Claude's scrolled-up pill (spike S5, Claude Code 2.1.325). Display only: the scroll route never reads it to decide a key.
describe('pillShown', () => {
  const sp = (t, s = {}) => span(t, { ...DEF, ...s });
  const PILL_STYLE = { fg: 231, bg: 237 };
  /** Claude's pill row: centred, the words in fg 231 on bg 237. */
  const pill = (words = 'Jump to bottom: fn+\u2193 to scroll') => [sp(' '.repeat(40)), sp(` ${words} `, PILL_STYLE)];

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

  test('(\u2212) the words mid-row, other words, other case and plain text are not the pill', () => {
    const styled = (t) => rowsOf([sp(t, PILL_STYLE)]);
    assert.equal(pillShown(styled('see Jump to bottom')), false, 'after other text');
    assert.equal(pillShown(styled('> Jump to bottom')), false);
    assert.equal(pillShown(styled('Jump to bottomless')), false, 'a word boundary is required');
    assert.equal(pillShown(styled('jump to bottom')), false);
    assert.equal(pillShown(styled('Jump  to bottom')), false);
    assert.equal(pillShown(styled('Jump to top')), false);
    assert.equal(pillShown(styled('')), false);
    assert.equal(pillShown(rowsOf('Jump to bottom: fn+\u2193 to scroll')), false, 'plain text');
  });

  test('(\u2212) rows that are not rows never throw and never match', () => {
    for (const rows of [undefined, null, 5, 'Jump to bottom', {}, [], [null], [undefined], [5], ['Jump to bottom'], [[]], [[null]], [[{}]], [[{ t: 5, s: {} }]], [[{ t: 'Jump to bottom' }]]]) {
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
