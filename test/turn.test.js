// src/turn.js (0.5.1, item K): is a turn running in Claude's main conversation, read from the screen. Claude's registry reads busy / shell
// while background work runs after the turn ended, so only Claude's own running-turn marker counts: the footer's `esc to interrupt` segment
// or a spinner row above the box (with the hint, or, K-vim, a present-tense `<glyph> <Verb>... (<anything>)` row without it: Claude 2.1.326 draws
// no hint in the spinner's parentheses and none in the footer in vim INSERT). Background rows and pills are not a running turn. Synthetic screens only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { footerHint, spinnerAbove, turnRunning } from '../src/turn.js';
import { boxRows, span, subagentRows } from './helpers.js';

const COLS = 120;
const row = (t) => (t ? [span(t)] : []);
/** A screen: `above` text rows, then the box (empty, with a suggestion), the status row and the footer, then `below` rows. Returns { rows, top }. */
function screen({ above = [], footer, insert = false, below = [] } = {}) {
  const s = boxRows({ cols: COLS, lines: [''], ghost: 'run the tests in acme-api', insert, footer });
  return { rows: [...above.map(row), ...s.rows, ...below], top: above.length };
}

const SPIN = '✻ Thinking… (12s · esc to interrupt)';
const HINT = '⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt';

describe('footerHint', () => {
  test('(+) the mode line carries the `esc to interrupt` segment: auto, manual with the manage pill, vim INSERT, no-break spaces', () => {
    for (const footer of [HINT, '⏸ manual mode on · esc to interrupt · ↓ to manage', '⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt', '⏸\u00a0manual mode on · esc\u00a0to\u00a0interrupt']) {
      assert.equal(footerHint(screen({ footer }).rows), true, footer);
    }
    assert.equal(footerHint(screen({ footer: HINT, insert: true }).rows), true, 'vim INSERT prefix');
  });

  test('(+) the subagent list under the footer is skipped: the hint is still read on the mode line', () => {
    const s = screen({ footer: HINT, below: subagentRows({ cols: COLS, agents: 2 }) });
    assert.equal(footerHint(s.rows), true);
  });

  test('(−) idle footers and background-work footers have no hint: auto, manual, `1 shell · ↓ to manage`, vim INSERT in manual mode', () => {
    for (const footer of ['⏵⏵ auto mode on (shift+tab to cycle)', '⏸ manual mode on', '⏸ manual mode on · 1 shell · ↓ to manage', '⏵⏵ auto mode on · 2 shells · /tasks to see subagents · ↓ to manage']) {
      assert.equal(footerHint(screen({ footer }).rows), false, footer);
    }
    assert.equal(footerHint(screen({ footer: '⏸ manual mode on', insert: true }).rows), false);
  });

  test('(−) a segment that only mentions the hint, or a label on an agent row below the footer, is not the hint', () => {
    for (const footer of ['⏸ manual mode on · press esc to interrupt later', '⏸ manual mode on · esc to interrupt!', '⏸ manual mode on (esc to interrupt)']) {
      assert.equal(footerHint(screen({ footer }).rows), false, footer);
    }
    const label = screen({ footer: '⏸ manual mode on · 1 shell · ↓ to manage', below: subagentRows({ cols: COLS, agents: [{ label: 'ran · esc to interrupt · ok', elapsed: '5s', tokens: null }] }) });
    assert.equal(footerHint(label.rows), false, 'a model-written label is not Claude\'s hint');
  });

  test('(−) not rows, no rows, a screen without a footer: false', () => {
    for (const rows of [null, undefined, 'x', 7, {}, [], [[]], [[], []]]) assert.equal(footerHint(rows), false, JSON.stringify(rows));
  });
});

describe('spinnerAbove', () => {
  test('(+) the spinner row right above the box: a plain timer, a token count, a todo hint, a longer verb, another glyph, no-break spaces', () => {
    for (const text of [
      SPIN, '✢ Drizzling… (14s · ↓ 1.2k tokens · esc to interrupt)', '✶ Working… (esc to interrupt · ctrl+t to hide todos)', '* Running the tests… (3m 4s · ↑ 20.5k tokens · esc to interrupt)',
      '· Pondering… (1s · esc to interrupt)', ' ✻ Thinking… (12s · esc to interrupt)', '✻\u00a0Thinking…\u00a0(12s\u00a0·\u00a0esc\u00a0to\u00a0interrupt)',
    ]) {
      const s = screen({ above: ['⏺ Working on it', text, ''] });
      assert.equal(spinnerAbove(s.rows, s.top), true, text);
    }
  });

  test('(+) K-vim: a present-tense spinner row without the hint counts: a token count, a thinking effort, a bare timer, every glyph Claude draws', () => {
    for (const text of [
      '✻ Kneading… (35m 42s · ↓ 103.3k tokens)', '✳ Imagining… (11m 41s · thinking with xhigh effort)', '✻ Thinking… (12s)', '✻ Thinking… (12s · ↓ 1.2k tokens)', '✻ Thinking… (12s · press esc to interrupt now)',
      '· Pondering… (1s)', '✢ Drizzling… (14s · ↓ 1.2k tokens)', '✶ Working… (3s)', '* Running the tests… (3m 4s · ↑ 20.5k tokens)', '✽ Brewing… (9s)', ' ✻ Thinking… (12s)',
      '✻\u00a0Kneading…\u00a0(35m\u00a042s\u00a0·\u00a0↓\u00a0103.3k\u00a0tokens)',
    ]) {
      const s = screen({ above: ['⏺ Working on it', text, ''] });
      assert.equal(spinnerAbove(s.rows, s.top), true, text);
    }
  });

  test('(+) a task list, a queued message and a tip row between the spinner and the box are fine (up to 12 non-blank rows)', () => {
    const between = ['  ⎿  ◼ Draft the outline', '     ◻ Check the sample data', '❯ queued earlier', '  ctrl+x ctrl+s to send now', '  Send messages to Claude while it works to steer Claude in real-time'];
    const s = screen({ above: ['⏺ Working on it', SPIN, ...between, ''] });
    assert.equal(spinnerAbove(s.rows, s.top), true);
    const edge = screen({ above: [SPIN, ...Array.from({ length: 11 }, (_, i) => `  row ${i}`), ''] });
    assert.equal(spinnerAbove(edge.rows, edge.top), true, 'the spinner is the 12th non-blank row above the rule');
  });

  test('(−) what background work draws is not a spinner: `Crunched for`, `Waiting for 1 background agent`, a finished-agent row', () => {
    for (const text of ['✻ Crunched for 3s · done 4:43 PM · 1 shell still running', '✻ Waiting for 1 background agent to finish', '⏺ Agent "Sleep 100 seconds" finished · 43s', '✻ Cooked for 2s']) {
      const s = screen({ above: ['⏺ Done', text, ''] });
      assert.equal(spinnerAbove(s.rows, s.top), false, text);
    }
  });

  test('(−) a hint without the spinner shape, a row that is not a whole spinner row, and prose that quotes the hint', () => {
    for (const text of [
      '✻ Thinking (12s · esc to interrupt)', 'Thinking… (12s · esc to interrupt)', '✻ Thinking… (12s · esc to interrupt) and more',
      '  Press esc to interrupt', '⏺ The footer reads "esc to interrupt" while a turn runs', '   ✻ Thinking… (12s · esc to interrupt)',
    ]) {
      const s = screen({ above: [text, ''] });
      assert.equal(spinnerAbove(s.rows, s.top), false, text);
    }
  });

  test('(−) K-vim: the finished line, and a hint-less row that lacks the ellipsis, the parenthesis or the glyph, is not a spinner', () => {
    for (const text of [
      '✻ Worked for 8m 9s · done 4:21 PM', '✻ Worked for 8m 9s', '✻ Kneading (35m 42s)', '✻ Kneading… 35m 42s', '✻ Kneading…', '✻ Kneading… ()x', '✻ Kneading… (35m 42s) and more',
      '✻ Kneading... (35m 42s)', 'Kneading… (35m 42s)', '   ✻ Kneading… (35m 42s)', '✻ kneading… (35m 42s)', '✻  Kneading… (35m 42s)',
    ]) {
      const s = screen({ above: ['⏺ Done', text, ''] });
      assert.equal(spinnerAbove(s.rows, s.top), false, text);
    }
  });

  test('(−) K-vim: rows other than Claude\'s spinner that happen to have an ellipsis and a parenthesis: the assistant\'s bullet, an agent-list row, a list item', () => {
    for (const text of [
      '⏺ Let me check the logs… (this may take a moment)', '◯ general-purpose  Summarize the notes… (12s)', '❯ ⏺ demo-type  Check the links… (3 more)', '  ◯ main  Sort the inbox… (idle)',
      '* sort the inbox… (see below)', '- Sort the inbox… (see below)', '  ⎿  Reading the notes… (2 files)',
    ]) {
      const s = screen({ above: [text, ''] });
      assert.equal(spinnerAbove(s.rows, s.top), false, text);
    }
  });

  test('(−) the spinner is outside the window: 13 non-blank rows above the rule, or below the box', () => {
    const far = screen({ above: [SPIN, ...Array.from({ length: 12 }, (_, i) => `  row ${i}`), ''] });
    assert.equal(spinnerAbove(far.rows, far.top), false, '13th non-blank row');
    const below = screen({ above: [''], below: [SPIN] });
    assert.equal(spinnerAbove(below.rows, below.top), false, 'rows under the footer are not read');
    const hintless = screen({ above: [''], below: ['✻ Kneading… (35m 42s · ↓ 103.3k tokens)'] });
    assert.equal(spinnerAbove(hintless.rows, hintless.top), false, 'K-vim: a hint-less spinner-like row below the box top is ignored too');
    assert.equal(turnRunning(hintless.rows, hintless.top), false);
  });

  test('(−) a `top` that is not a row index, and rows that are not rows: false', () => {
    const s = screen({ above: [SPIN] });
    for (const top of [undefined, null, '1', -1, 0, 1.5, NaN, Infinity, s.rows.length + 1]) assert.equal(spinnerAbove(s.rows, top), false, String(top));
    for (const rows of [null, undefined, 'x', {}]) assert.equal(spinnerAbove(rows, 1), false, String(rows));
  });
});

describe('turnRunning', () => {
  test('(+) either marker is enough: the spinner row alone, the footer hint alone, both', () => {
    const spinner = screen({ above: [SPIN, ''], footer: '⏸ manual mode on', insert: true });
    const hint = screen({ above: ['⏺ Working on it', ''], footer: HINT });
    const both = screen({ above: [SPIN, ''], footer: HINT });
    for (const s of [spinner, hint, both]) assert.equal(turnRunning(s.rows, s.top), true);
  });

  test('(+) K-vim: vim INSERT never shows the hint in the footer; a hint-less spinner row above the box is a running turn', () => {
    for (const above of [['✻ Kneading… (35m 42s · ↓ 103.3k tokens)', ''], ['✳ Imagining… (11m 41s · thinking with xhigh effort)', ''], ['⏺ Working on it', '✻ Thinking… (12s)', '  ⎿  ◼ Draft the outline', '']]) {
      const s = screen({ above, footer: '⏸ manual mode on', insert: true });
      assert.equal(footerHint(s.rows), false, 'the footer carries no hint in vim INSERT');
      assert.equal(turnRunning(s.rows, s.top), true, above.join(' | '));
    }
  });

  test('(−) K-vim: the finished line in vim INSERT, and background rows and pills only (with ellipsis and parentheses in their text): not running', () => {
    const rowsOnly = {
      'finished line': screen({ above: ['✻ Worked for 8m 9s · done 4:21 PM', ''], footer: '⏸ manual mode on', insert: true }),
      'agent row with an ellipsis': screen({ above: ['◯ general-purpose  Summarize the notes… (12s)', ''], footer: '⏸ manual mode on', insert: true }),
      'waiting on a shell': screen({ above: ['✻ Crunched for 3s · done 4:43 PM · 1 shell still running', ''], footer: '⏸ manual mode on · waiting on 1 shell · ↓ to manage', insert: true }),
      'shells pill with an agent list': screen({ above: [''], footer: '⏸ manual mode on · 2 shells · ↓ to manage', insert: true, below: subagentRows({ cols: COLS, agents: 2 }) }),
    };
    for (const [name, s] of Object.entries(rowsOnly)) assert.equal(turnRunning(s.rows, s.top), false, name);
  });

  test('(−) idle, and every shape of background work after the turn ended: not running', () => {
    const shapes = {
      idle: screen({ above: ['⏺ Done', ''] }),
      'background shell': screen({ above: ['✻ Crunched for 3s · done 4:43 PM · 1 shell still running', ''], footer: '⏸ manual mode on · 1 shell · ↓ to manage' }),
      'background agent': screen({ above: ['✻ Waiting for 1 background agent to finish', ''], footer: '⏸ manual mode on · 1 shell · ↓ to manage', below: subagentRows({ cols: COLS, agents: 1 }) }),
      'agent list, vim INSERT': screen({ above: [''], footer: '⏸ manual mode on', insert: true, below: subagentRows({ cols: COLS, agents: 3, more: 2 }) }),
    };
    for (const [name, s] of Object.entries(shapes)) assert.equal(turnRunning(s.rows, s.top), false, name);
  });
});
