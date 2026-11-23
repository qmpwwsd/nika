import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl, promptSig, boxInput, readDraft, READBACK_TRIES, READBACK_MS } from '../src/session-control.js';
import { promptFromRows, rowText, modeFromRows } from '../src/mode.js';
import { RULE_ROW, parseDraft, boxSquash } from '../src/draft.js';
import { boxRows, subagentRows } from './helpers.js';
import { dialogOnScreen } from '../src/dialog.js';
import { dialogWorld, TAB } from './dialog-fake.js';
import { surveyOf, SURVEY_UNDO_MS } from '../src/survey.js';

// Synthetic screens only. The phrases follow docs/contracts/claude-tui.md sections 1, 2 and 5; symbols are escapes.
const DEF = { b: false, fg: null, bg: null, u: false, i: false, d: false };
const rowsOf = (...lines) => lines.map((l) => (Array.isArray(l) ? l : l === '' ? [] : [{ t: l, s: DEF }]));
const NB = '\xa0'; // Claude draws a no-break space after the prompt character
const sp = (t, d = false, extra = {}) => ({ t, s: { ...DEF, d, ...extra } });
const RULE = '─'.repeat(40);
// A named session (`-n <name>`, or /rename) has its name drawn into the upper rule: `─── <name> ─` (claude-tui.md section 5, checked 2026-11-09).
const labelled = (name, dashes = 19) => `${'─'.repeat(dashes)} ${name} ─`;
const PROMPT_CHAR = '❯';
const PHRASE = {
  auto: '⏵⏵ auto mode on',
  manual: '⏸ manual mode on',
  acceptEdits: '⏵⏵ accept edits on',
  plan: '⏸ plan mode on',
  dontAsk: '⏵⏵ don\'t ask on',
  bypassPermissions: '⏵⏵ bypass permissions on',
  unknown: 'some footer nobody recognises',
};
const CYCLE = ['auto', 'manual', 'acceptEdits', 'plan'];
const OPTIONS = ['Yes', 'Yes, and always allow this for the project', 'No'];
const EMPTY_BOX = PROMPT_CHAR; // the prompt character alone
// Claude Code 2.1.319 (claude-tui.md section 5, F3): `/` typed in vim NORMAL mode opens a history search instead of typing a slash.
const HISTORY_HINT = '↑/↓ to navigate · Enter to use · Esc to cancel · ctrl+s to scope · Esc i / for slash commands';
// Claude's feedback survey (0.5, F14; live capture of spike S-F14): the bullet at column 0, the options row indented 2, one row, the box's top rule.
const SURVEY_Q = '\u25cf How is Claude doing this session? (optional)';
const SURVEY_O = '  1: Bad    2: Fine   3: Good   0: Dismiss';
const FOLLOW_UP_THANKS = 'Thanks for the feedback!'; // the rows after a rating (spike S-F14 section 4): column 0
const FOLLOW_UP_ROW = '(Optional) Press [1] to tell us more \u00b7 /feedback';
// Real-shaped rows (span lists as the mirror delivers them): the prompt character and a no-break space, then a dim placeholder.
const PLACEHOLDER_BOX = [sp(`${PROMPT_CHAR}${NB}`), sp('Try "fix lint errors"', true)];
/** A box row from a string: `❯ text` becomes the real shape (no-break space, then non-dim text); a span list stays as it is. */
const toRow = (r) => {
  if (Array.isArray(r)) return r;
  const m = /^❯ (.*)$/.exec(r);
  return m ? [sp(`${PROMPT_CHAR}${NB}`), sp(m[1])] : r === '' ? [] : [sp(r)];
};

/**
 * A fake pane: it renders an input box between two rule rows and a footer (or a permission prompt) from its fields and
 * reacts to the keys the controller sends. `box` is the rows between the rules (null = no box on screen); `vim` turns
 * on vim input mode (`vimMode` insert shows the `-- INSERT --` prefix, normal shows none, Escape switches to normal and
 * the text `i` back unless `insertWorks` is false); `swallow` drops typed text; `afterType(body)` may change the box
 * after text was typed. `typeLag` / `insertLag` make that many captures after the typed text / the `i` still show the old
 * box / no INSERT prefix (Claude redraws a few hundred ms later). The lone `/` that nika types first to probe a command
 * (Task 14a) skips `afterType` unless `hookSlash` is set; `typeLag` applies to it like to any typed text. `C-u` removes one visual row (the last row of a
 * wrapped box, or the whole text of a single row), unless `cuWorks` is false. Box rows may be strings or span lists.
 * `script` replaces the mode cycle after each BTab (the last entry repeats); `lag` makes the first n captures after a
 * press read `unknown`. In vim NORMAL mode the text `/` opens the history search (`history`: the input box is replaced by a
 * list, a filter row and the hint row); Escape closes it unless `historyStuck`. The clock only moves when the controller sleeps.
 * `topRule` is the upper rule row (a named session draws its name into it, see `labelled`), `below` the rows between the
 * lower rule and the mode line (a user status line), `footerTail` the text after the mode phrase. `spinner` is a row above the
 * upper rule (Claude's running-turn row), `menu` rows drawn above the upper rule after it (Claude's slash menu: above the box, the mode line stays,
 * docs/contracts/claude-tui.md section 5; 0.5.4, AC).
 */
function world(opts = {}) {
  const w = {
    mode: 'manual', state: 'idle', prompt: false, question: 'Do you want to proceed?', options: OPTIONS,
    cycle: CYCLE, script: null, lag: 0, lagLeft: 0, cmd: 'claude', cmdAfter: 'zsh', exitAfter: 1000, enterAt: null,
    t: 1_000_000, slept: [], sent: [], captures: [], stateCalls: 0, cmdCalls: 0, presses: 0, hold: null,
    captureFail: null, captureFailOn: null, failSend: null, stateOf: null, onKeys: null,
    box: [PLACEHOLDER_BOX], vim: false, vimMode: 'insert', insertWorks: true, swallow: false, afterType: null,
    typeLag: 0, boxStale: null, insertLag: 0, insertLeft: 0, cuWorks: true, captureFailFrom: null,
    history: false, historyStuck: false, escLag: 0, escLeft: 0, hookSlash: false,
    topRule: RULE, below: [], footerTail: '', survey: null, surveyLeft: 0, followUp: false, spinner: null, menu: null,
    ...opts,
  };
  w.rows = () => {
    if (w.history) return rowsOf('earlier output', '', '  /compact', '  /clear', RULE, '⌕ Filter history…', RULE, HISTORY_HINT);
    if (w.prompt) {
      return rowsOf('Bash command', 'run the thing', '', w.question,
        ...w.options.flatMap((o, i) => {
          const [first, ...wrapped] = [].concat(o); // an array is one label wrapped over several rows
          return [`${i === 0 ? PROMPT_CHAR : ' '} ${i + 1}. ${first}`, ...wrapped.map((r) => `      ${r}`)];
        }), 'Esc to cancel · Tab to amend');
    }
    const shown = w.lagLeft > 0 ? 'unknown' : w.mode;
    const inserting = w.vim && ((w.vimMode === 'insert' && w.insertLeft <= 0) || w.escLeft > 0);
    const line = `${inserting ? '-- INSERT -- ' : ''}${PHRASE[shown]}${w.footerTail}`;
    const shownBox = w.boxStale?.left > 0 ? w.boxStale.box : w.box;
    // `survey`: { free?, lag?, takes? }; `followUp`: the rows Claude draws for a few seconds after a rating (M1), which are no survey
    const above = [...(w.survey ? ['', SURVEY_Q, SURVEY_O, w.survey.free ?? ''] : w.followUp ? ['', FOLLOW_UP_THANKS, FOLLOW_UP_ROW, ''] : w.spinner ? ['', w.spinner] : ['']), ...(w.menu ?? [])];
    const box = shownBox === null ? [] : [...above, w.topRule, ...shownBox.map(toRow), RULE, ...w.below];
    return rowsOf('earlier output', ...box, line);
  };
  /** Where tmux puts the cursor (readDraft needs one, N-1): on the last row between the last two rule rows, at column 2; else the top-left cell. */
  w.cursorIn = (rows) => {
    const rules = rows.flatMap((row, i) => (RULE_ROW.test(rowText(row).trimEnd()) ? [i] : []));
    return { x: 2, y: rules.length >= 2 ? rules.at(-1) - 1 : 0, visible: true };
  };
  w.mirror = {
    async capture(pane, inm, o) {
      w.captures.push({ pane, o });
      if (pane === '%1' && w.hold) await w.hold;
      if (w.captureFail || w.captureFailOn === w.captures.length || (w.captureFailFrom !== null && w.captures.length >= w.captureFailFrom)) return w.captureFail ?? { status: 404, body: { error: 'not_found', message: 'gone' } };
      const rows = w.rows();
      const res = { status: 200, body: { rows, cursor: w.cursorIn(rows) } };
      if (w.lagLeft > 0) w.lagLeft -= 1;
      if (w.boxStale?.left > 0) w.boxStale.left -= 1;
      if (w.insertLeft > 0) w.insertLeft -= 1;
      if (w.escLeft > 0) w.escLeft -= 1;
      if (w.surveyLeft > 0 && (w.surveyLeft -= 1) === 0) { w.survey = null; w.box = [PLACEHOLDER_BOX]; } // Claude took the digit: the rows and the digit go
      return res;
    },
  };
  w.keys = {
    async send(pane, body) {
      w.sent.push(body);
      const failed = w.failSend?.(body, w.sent.length);
      if (failed) return failed;
      const key = body.keys?.[0];
      if (key === 'BTab') {
        const next = w.script ? w.script[Math.min(w.presses, w.script.length - 1)] : w.cycle[(w.cycle.indexOf(w.mode) + 1) % w.cycle.length];
        w.presses += 1;
        w.mode = next;
        w.lagLeft = w.lag;
        w.afterPress?.(w.presses);
      }
      if (key === 'Enter') w.enterAt ??= w.t;
      if (key === 'Escape' && w.history && !w.historyStuck) w.history = false;
      if (key === 'Escape' && w.vim) {
        if (w.vimMode === 'insert') w.escLeft = w.escLag; // the redraw after the Escape may come late
        w.vimMode = 'normal';
      }
      if (key === 'C-u' && w.box) {
        if (w.cuWorks) w.box = w.box.length > 1 ? w.box.slice(0, -1) : [PLACEHOLDER_BOX];
        w.boxStale = null;
      }
      if (body.text !== undefined) {
        if (w.vim && w.vimMode === 'normal') { // vim commands, not text
          if (body.text === 'i' && w.insertWorks) { w.vimMode = 'insert'; w.insertLeft = w.insertLag; }
          if (body.text === '/') w.history = true;
        } else if (!w.swallow && w.box) {
          const before = w.box.map(toRow);
          w.box = before.slice();
          const last = w.box.at(-1);
          // the placeholder and the cursor cell make way for the typed text; plain whitespace in front of them (typed by the user) stays
          const lead = last.slice(1);
          const stop = lead.findIndex((x) => x.s.d || x.s.r);
          const kept = stop < 0 ? lead : lead.slice(0, stop);
          w.box[w.box.length - 1] = [last[0].t === PROMPT_CHAR ? sp(`${PROMPT_CHAR}${NB}`) : last[0], ...kept, sp(body.text, false, { fg: 153 })];
          if (body.text !== '/' || w.hookSlash) w.afterType?.(body); // the lone `/` probe skips the hook unless `hookSlash`
          if (w.typeLag > 0) w.boxStale = { box: before, left: w.typeLag };
        }
      }
      if (w.survey && w.survey.takes !== false && /^[0-3]$/.test(body.text ?? '') && !(w.vim && w.vimMode === 'normal')) w.surveyLeft = w.survey.lag ?? 1; // captures that still show the digit
      w.onKeys?.(body);
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 1 } } };
    },
  };
  w.paneCommand = async () => {
    w.cmdCalls += 1;
    return w.enterAt !== null && w.t - w.enterAt >= w.exitAfter ? w.cmdAfter : w.cmd;
  };
  w.stateArgs = []; // the second argument of every registry read (`{ fresh: true }` when the cache must be skipped)
  w.stateOf = async (pane, o) => {
    w.stateCalls += 1;
    w.stateArgs.push(o);
    if (w.stateFn) return w.stateFn(w.stateCalls);
    return w.state;
  };
  w.vimOf = () => w.vim;
  w.now = () => w.t;
  w.sleep = async (ms) => { w.t += ms; w.slept.push(ms); };
  w.control = (extra = {}) => createSessionControl({
    mirror: w.mirror, keys: w.keys, paneCommand: w.paneCommand, stateOf: w.stateOf, vimOf: w.vimOf, now: w.now, sleep: w.sleep, ...extra,
  });
  return w;
}

const code = (status, error) => ({ status, body: { error } });
const tick = () => new Promise((r) => setImmediate(r));
const keysOf = (w) => w.sent.map((b) => (b.keys ? b.keys.join('+') : `text:${b.text}`));
/** Holds the captures of pane %1 until release() is called. */
function hold(w) {
  let release;
  w.hold = new Promise((r) => { release = r; });
  return release;
}

describe('promptSig', () => {
  const base = () => rowsOf('old', 'Bash command', 'run the thing', '', 'Do you want to proceed?', `${PROMPT_CHAR} 1. Yes`, '  2. No', 'Esc to cancel');

  test('(+) 16 lowercase hex chars, stable for equal rows, blank rows ignored', () => {
    assert.match(promptSig(base()), /^[0-9a-f]{16}$/);
    assert.equal(promptSig(base()), promptSig(base()));
    assert.equal(promptSig(base()), promptSig([...base(), [], []]), 'trailing blank rows do not matter');
  });

  test('(+) changes when any of the last 15 non-blank rows changes, not for an older one', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    const sig = promptSig(rowsOf(...lines));
    const edit = (i) => rowsOf(...lines.map((l, k) => (k === i ? `${l} x` : l)));
    for (let i = 5; i < 20; i += 1) assert.notEqual(promptSig(edit(i)), sig, `row ${i} is inside the window`);
    for (let i = 0; i < 5; i += 1) assert.equal(promptSig(edit(i)), sig, `row ${i} is outside the window`);
  });

  test('(−) bad input gives a stable hash of nothing, never throws', () => {
    assert.match(promptSig(null), /^[0-9a-f]{16}$/);
    assert.equal(promptSig(undefined), promptSig([]));
  });
});

describe('createSessionControl', () => {
  test('(−) vimOf is required: a missing one is refused at creation, never defaulted', () => {
    const w = world();
    assert.throws(() => createSessionControl({ mirror: w.mirror, keys: w.keys, paneCommand: w.paneCommand, stateOf: w.stateOf }), TypeError);
    assert.throws(() => createSessionControl({ mirror: w.mirror, keys: w.keys, paneCommand: w.paneCommand, stateOf: w.stateOf, vimOf: true }), TypeError);
  });
});

describe('switchMode (+)', () => {
  test('(+) already in the target: 200 presses 0, no keys sent, every capture is fresh', async () => {
    const w = world({ mode: 'plan' });
    const r = await w.control().switchMode('%2', 'plan');
    assert.deepEqual(r, { status: 200, body: { mode: 'plan', presses: 0 } });
    assert.deepEqual(w.sent, []);
    assert.ok(w.captures.length >= 1 && w.captures.every((c) => c.pane === '%2' && c.o?.fresh === true));
  });

  test('(+) manual to plan presses BTab twice (manual, acceptEdits, plan)', async () => {
    const w = world({ mode: 'manual' });
    const r = await w.control().switchMode('%2', 'plan');
    assert.deepEqual(r, { status: 200, body: { mode: 'plan', presses: 2 } });
    assert.deepEqual(w.sent, [{ keys: ['BTab'] }, { keys: ['BTab'] }]);
    assert.ok(w.captures.every((c) => c.o?.fresh === true), 'no read of the cache');
  });

  test('(+) an unknown read right after a press keeps polling until the footer shows the new mode', async () => {
    const w = world({ mode: 'manual', lag: 3 });
    const r = await w.control().switchMode('%2', 'acceptEdits');
    assert.deepEqual(r, { status: 200, body: { mode: 'acceptEdits', presses: 1 } });
    assert.deepEqual(w.slept, [300, 300, 300, 300], 'three unknown reads, then the mode, one poll interval apart');
  });

  test('(+) the state is read before the first press and again before every later press', async () => {
    const w = world({ mode: 'manual' });
    await w.control().switchMode('%2', 'plan'); // two presses
    assert.equal(w.stateCalls, 2);
  });

  test('(+) a switch on another pane does not wait for one that is running', async () => {
    const w = world({ mode: 'manual' });
    const release = hold(w);
    const sc = w.control();
    const first = sc.switchMode('%1', 'plan');
    await tick();
    const other = await sc.switchMode('%2', 'acceptEdits');
    assert.equal(other.status, 200);
    release();
    await first;
  });

  test('(+) the lock is released after a refused switch, so the next one runs', async () => {
    const w = world({ mode: 'manual', state: 'busy' });
    const sc = w.control();
    assert.deepEqual(await sc.switchMode('%2', 'plan'), code(409, 'not-idle'));
    w.state = 'idle';
    assert.equal((await sc.switchMode('%2', 'plan')).status, 200);
  });

  test('(+) a plain (sync) stateOf lookup works too', async () => {
    const w = world({ mode: 'manual' });
    w.stateOf = () => 'idle';
    assert.equal((await w.control().switchMode('%2', 'acceptEdits')).status, 200);
    assert.equal(w.sent.length, 1);
  });
});

describe('switchMode (−)', () => {
  test('(−) a target outside MODE_TARGETS is 400 invalid, before any read or press', async () => {
    const w = world();
    const sc = w.control();
    for (const target of ['dontAsk', 'bypassPermissions', 'default', 'unknown', '', undefined, null, 3, ['plan']]) {
      const r = await sc.switchMode('%2', target);
      assert.equal(r.status, 400, String(target));
      assert.equal(r.body.error, 'invalid');
      assert.equal(typeof r.body.message, 'string');
    }
    assert.equal(w.captures.length, 0);
    assert.deepEqual(w.sent, []);
  });

  test('(−) state busy: 409 not-idle, no keys sent, also when the mode already equals the target', async () => {
    const w = world({ mode: 'manual', state: 'busy' });
    const sc = w.control();
    assert.deepEqual(await sc.switchMode('%2', 'plan'), code(409, 'not-idle'));
    assert.deepEqual(await sc.switchMode('%2', 'manual'), code(409, 'not-idle'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) no live session (state null) or a failing state lookup: 409 not-idle, no keys sent', async () => {
    const w = world({ mode: 'manual' });
    w.stateOf = async () => null;
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'not-idle'));
    w.stateOf = async () => { throw new Error('registry unreadable'); };
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'not-idle'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) a permission prompt on screen: 409 not-idle (before the unknown footer it causes), no keys sent', async () => {
    const w = world({ mode: 'manual', prompt: true });
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'not-idle'));
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), code(409, 'not-idle'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) an unknown first read: 409 mode-unknown and no key sent', async () => {
    const w = world({ mode: 'unknown' });
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'mode-unknown'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) dontAsk start: 409 not-in-cycle, no press', async () => {
    const w = world({ mode: 'dontAsk' });
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'not-in-cycle'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) a failed capture passes its status through and nothing is sent', async () => {
    const w = world({ captureFail: { status: 404, body: { error: 'not_found', message: 'gone' } } });
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(w.sent, []);
  });

  test('(−) becomes busy after the first press: 409 not-idle, one press sent', async () => {
    const w = world({ mode: 'manual' });
    w.afterPress = () => { w.state = 'busy'; };
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), { status: 409, body: { error: 'not-idle', presses: 1 } });
    assert.deepEqual(w.sent, [{ keys: ['BTab'] }]);
  });

  test('(−) a prompt opens after the first press: 409 not-idle, one press sent', async () => {
    const w = world({ mode: 'manual' });
    const base = w.mirror.capture;
    let afterPress = 0;
    w.mirror.capture = async (...a) => { // the poll (1st capture after the press) sees plain acceptEdits, the idle re-check (2nd) a prompt
      if (w.presses === 1 && (afterPress += 1) === 2) w.prompt = true;
      return base(...a);
    };
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), { status: 409, body: { error: 'not-idle', presses: 1 } });
    assert.deepEqual(w.sent, [{ keys: ['BTab'] }]);
  });

  test('(−) returns to the start mode without the target: 409 not-in-cycle', async () => {
    const w = world({ mode: 'manual', script: ['acceptEdits', 'manual'] });
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), { status: 409, body: { error: 'not-in-cycle', presses: 2 } });
    assert.equal(w.sent.length, 2);
  });

  test('(−) the footer goes unknown mid-cycle: 409 mode-unknown after that press, nothing more sent', async () => {
    const w = world({ mode: 'manual', script: ['acceptEdits', 'unknown'] });
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), { status: 409, body: { error: 'mode-unknown', presses: 2 } });
    assert.equal(w.sent.length, 2);
    assert.ok(w.slept.filter((ms) => ms === 300).length >= 6, 'polled up to settleMs');
  });

  test('(−) the mode does not change within settleMs: 409 mode-unchanged (not mode-unknown: the footer read fine) after one press', async () => {
    const w = world({ mode: 'manual', script: ['manual'] });
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), { status: 409, body: { error: 'mode-unchanged', presses: 1 } });
    assert.equal(w.sent.length, 1);
    assert.equal(w.slept.reduce((a, b) => a + b, 0), 1800, 'waited exactly settleMs');
  });

  test('(−) the mode stays put after a later press too: 409 mode-unchanged with both presses counted', async () => {
    const w = world({ mode: 'manual', script: ['acceptEdits', 'acceptEdits'] });
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), { status: 409, body: { error: 'mode-unchanged', presses: 2 } });
    assert.equal(w.sent.length, 2);
  });

  test('(+) a footer that was unreadable at any read of the window stays mode-unknown, even when the rest of the reads equal the start mode', async () => {
    const w = world({ mode: 'manual', script: ['manual'], lag: 1 }); // the first read after the press is unreadable, the next five show manual
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), { status: 409, body: { error: 'mode-unknown', presses: 1 } });
    assert.equal(w.sent.length, 1);
  });

  test('(+) a late redraw inside the window is still a success: the unchanged answer needs the whole window to stay put', async () => {
    const w = world({ mode: 'manual', script: ['plan'], lag: 3 });
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), { status: 200, body: { mode: 'plan', presses: 1 } });
  });

  test('(−) a cycle that never reaches the target stops after 6 presses with 409 not-in-cycle', async () => {
    // passes through bypass on the way (press 3) and lands in plan on the 6th; a cycle that ends in bypass is under A1
    const w = world({ mode: 'manual', script: ['acceptEdits', 'plan', 'bypassPermissions', 'acceptEdits', 'plan', 'acceptEdits', 'plan'] });
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), { status: 409, body: { error: 'not-in-cycle', presses: 6 } });
    assert.equal(w.sent.length, 6, '6 presses and no seventh');
  });

  test('(−) the footer covered by a dialog before a later press: 409 mode-unknown, no blind press', async () => {
    const w = world({ mode: 'manual' });
    const base = w.mirror.capture;
    let n = 0;
    w.mirror.capture = async (pane, inm, o) => { // poll after press 1 reads acceptEdits, the re-check reads unknown
      n += 1;
      if (w.presses === 1 && n >= 3) w.mode = 'unknown';
      return base(pane, inm, o);
    };
    const r = await w.control().switchMode('%2', 'auto');
    assert.deepEqual(r, { status: 409, body: { error: 'mode-unknown', presses: 1 } });
    assert.equal(w.sent.length, 1);
  });

  test('(−) a failed BTab send returns that send\'s status and body plus the presses that did go out', async () => {
    const w = world({ mode: 'manual' });
    w.failSend = (body, n) => (n === 2 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null);
    const r = await w.control().switchMode('%2', 'auto');
    assert.deepEqual(r, { status: 429, body: { error: 'busy', message: 'slow down', presses: 1 } }, 'the failed send is not a press');
    assert.equal(w.sent.length, 2);
    const first = world({ mode: 'manual' });
    first.failSend = () => ({ status: 429, body: { error: 'busy', message: 'slow down' } });
    assert.deepEqual(await first.control().switchMode('%2', 'auto'), { status: 429, body: { error: 'busy', message: 'slow down', presses: 0 } });
  });

  test('(−) the settle wait is bounded by count: a frozen clock still ends after settleMs / pollMs reads', async () => {
    const w = world({ mode: 'manual', script: ['manual'] });
    const r = await w.control({ now: () => 0 }).switchMode('%2', 'plan');
    assert.deepEqual(r, { status: 409, body: { error: 'mode-unchanged', presses: 1 } });
    assert.deepEqual(w.slept, [300, 300, 300, 300, 300, 300]);
  });

  test('(−) second switch on the same pane while one runs: 409 busy-switching, nothing extra sent', async () => {
    const w = world({ mode: 'manual' });
    const release = hold(w);
    const sc = w.control();
    const running = sc.switchMode('%1', 'plan');
    await tick();
    assert.deepEqual(await sc.switchMode('%1', 'auto'), code(409, 'busy-switching'));
    assert.deepEqual(w.sent, []);
    release();
    assert.equal((await running).status, 200);
    assert.equal(w.sent.length, 2, 'only the running switch pressed');
  });

  test('(−) End, command or answer while a switch runs on that pane: 409 busy-switching, nothing sent', async () => {
    const w = world({ mode: 'manual' });
    const release = hold(w);
    const sc = w.control();
    const running = sc.switchMode('%1', 'plan');
    await tick();
    assert.deepEqual(await sc.endSession('%1'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.runCommand('%1', '/compact'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.answer('%1', { n: 1, sig: '0123456789abcdef' }), code(409, 'busy-switching'));
    assert.deepEqual(w.sent, []);
    release();
    await running;
  });

  test('(−) a switch, command or answer while End runs on that pane: 409 busy-switching', async () => {
    const w = world({ mode: 'manual' });
    const release = hold(w);
    const sc = w.control();
    const ending = sc.endSession('%1');
    await tick();
    assert.deepEqual(await sc.switchMode('%1', 'plan'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.runCommand('%1', '/compact'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.answer('%1', { n: 1, sig: '0123456789abcdef' }), code(409, 'busy-switching'));
    release();
    await ending;
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
  });
});

describe('answer', () => {
  const sigOf = (w) => promptSig(w.rows());

  test('(+) a matching sig sends the digit as text, nothing else', async () => {
    const w = world({ prompt: true });
    const r = await w.control().answer('%2', { n: 2, sig: sigOf(w) });
    assert.deepEqual(r, { status: 200, body: { answered: 2 } });
    assert.deepEqual(w.sent, [{ text: '2' }]);
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
  });

  test('(−) no prompt on screen: 409 no-prompt, nothing sent', async () => {
    const w = world({ prompt: false });
    assert.deepEqual(await w.control().answer('%2', { n: 1, sig: '0123456789abcdef' }), code(409, 'no-prompt'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) a different sig: 409 prompt-changed, nothing sent', async () => {
    const w = world({ prompt: true });
    const stale = sigOf(w);
    w.question = 'Do you want to make this edit?';
    assert.deepEqual(await w.control().answer('%2', { n: 1, sig: stale }), code(409, 'prompt-changed'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) n not offered (or not an integer option number): 400 invalid, nothing sent', async () => {
    const w = world({ prompt: true });
    const sig = sigOf(w);
    for (const n of [4, 0, 9, -1, 1.5, '1', null, undefined, NaN]) {
      const r = await w.control().answer('%2', { n, sig });
      assert.equal(r.status, 400, String(n));
      assert.equal(r.body.error, 'invalid');
    }
    assert.deepEqual(w.sent, []);
  });

  test('(−) an option whose label contains bypass (any case) is 400 invalid, and so is every other option of that prompt (the window is read whole)', async () => {
    const w = world({ prompt: true, options: ['Yes', 'Yes, and switch to BypassPermissions mode', 'No'] });
    const sig = sigOf(w);
    const sc = w.control();
    for (const n of [1, 2, 3]) {
      const r = await sc.answer('%2', { n, sig });
      assert.equal(r.status, 400, `option ${n}`);
      assert.equal(r.body.error, 'invalid');
    }
    assert.deepEqual(w.sent, []);
    w.options = ['Yes', 'Yes, with bypass on', 'No'];
    assert.equal((await sc.answer('%2', { n: 2, sig: sigOf(w) })).status, 400);
    w.options = ['Yes', 'Yes, and always allow this', 'No'];
    assert.equal((await sc.answer('%2', { n: 3, sig: sigOf(w) })).status, 200, 'the same prompt without the word is answered');
  });

  test('(−) a bypass beyond the 80-char label cut, or on a wrapped row, is still refused', async () => {
    const long = `Yes, and always allow access to ${'x'.repeat(70)} and then bypass everything`;
    const w = world({ prompt: true, options: ['Yes', long, ['Yes, and then switch', 'to bypass permissions'], 'No'] });
    const sc = w.control();
    const sig = sigOf(w);
    assert.doesNotMatch(promptFromRows(w.rows()).options[1].label, /bypass/i, 'the parsed label is cut before the word');
    for (const n of [2, 3]) {
      const r = await sc.answer('%2', { n, sig });
      assert.equal(r.status, 400, `option ${n}`);
      assert.equal(r.body.error, 'invalid');
    }
    assert.deepEqual(w.sent, []);
    assert.equal((await sc.answer('%2', { n: 4, sig })).status, 400, 'a clean option of the same prompt is refused too');
  });

  test('(−) a bypass hidden by case, width, invisible characters, spacing or punctuation is still refused', async () => {
    const hidden = [
      'Yes, and switch to B-y-p-a-s-s mode',
      'Yes, and switch to by​pass mode', // zero-width space (clean() turns it into a space in the label)
      'Yes, and switch to by­pass mode', // soft hyphen
      'Yes, and switch to ｂｙｐａｓｓ mode', // fullwidth letters
      'Yes, and switch to b y p a s s mode',
      'Yes, and switch to BYPASS_permissions mode',
    ];
    const w = world({ prompt: true, options: ['Yes', ...hidden, 'No'] });
    const sig = sigOf(w);
    const sc = w.control();
    for (let n = 2; n <= hidden.length + 1; n += 1) {
      const r = await sc.answer('%2', { n, sig });
      assert.equal(r.status, 400, `option ${n}: ${JSON.stringify(hidden[n - 2])}`);
    }
    assert.deepEqual(w.sent, []);
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 400, 'a clean option of the same prompt is refused too');
  });

  test('(+) ordinary labels pass the scan, accented and non-Latin letters included', async () => {
    const w = world({ prompt: true, options: ['Yes, édit the file', 'Yes, always allow テスト for this project', 'No'] });
    const sig = sigOf(w);
    const sc = w.control();
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 200);
    w.t += 5000;
    assert.equal((await sc.answer('%2', { n: 2, sig })).status, 200);
  });

  test('(−) the same sig twice within 3 s: 409 already-answered, one digit sent; allowed again after answerHoldMs', async () => {
    const w = world({ prompt: true });
    const sig = sigOf(w);
    const sc = w.control();
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 200);
    w.t += 2999;
    assert.deepEqual(await sc.answer('%2', { n: 1, sig }), code(409, 'already-answered'));
    assert.deepEqual(await sc.answer('%2', { n: 3, sig }), code(409, 'already-answered'), 'any digit, same prompt');
    assert.equal(w.sent.length, 1);
    w.t += 1;
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 200);
    assert.equal(w.sent.length, 2);
  });

  test('(+) already-answered is per pane and per sig: another pane or another prompt is not blocked', async () => {
    const w = world({ prompt: true });
    const sc = w.control();
    const sig = sigOf(w);
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 200);
    assert.equal((await sc.answer('%3', { n: 1, sig })).status, 200, 'another pane');
    w.question = 'Do you want to make this edit?';
    assert.equal((await sc.answer('%2', { n: 1, sig: sigOf(w) })).status, 200, 'another prompt');
    assert.equal(w.sent.length, 3);
  });

  test('(−) a failed send returns that send\'s status and body and is not remembered as answered', async () => {
    const w = world({ prompt: true });
    w.failSend = (body, n) => (n === 1 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null);
    const sig = sigOf(w);
    const sc = w.control();
    assert.deepEqual(await sc.answer('%2', { n: 1, sig }), { status: 429, body: { error: 'busy', message: 'slow down' } });
    assert.deepEqual(await sc.answer('%2', { n: 1, sig }), { status: 200, body: { answered: 1 } });
  });

  test('(−) a failed capture passes its status through and nothing is sent', async () => {
    const w = world({ prompt: true, captureFail: { status: 502, body: { error: 'tmux_failed', message: 'x' } } });
    assert.deepEqual(await w.control().answer('%2', { n: 1, sig: '0123456789abcdef' }), { status: 502, body: { error: 'tmux_failed', message: 'x' } });
    assert.deepEqual(w.sent, []);
  });

  test('(+) answer ignores the registry state (Claude waits on the prompt) and presses no Enter', async () => {
    const w = world({ prompt: true, state: 'busy' });
    const r = await w.control().answer('%2', { n: 1, sig: sigOf(w) });
    assert.equal(r.status, 200);
    assert.equal(w.stateCalls, 0);
    assert.deepEqual(keysOf(w), ['text:1']);
  });
});

describe('endSession (+)', () => {
  test('(+) idle with an empty box: `/` probed, then exit, the capture shows the box reading "/exit", then Enter; pane becomes zsh: ended true', async () => {
    const w = world({ mode: 'manual' });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(w.sent, [{ text: '/' }, { text: 'exit' }, { keys: ['Enter'] }]);
    assert.equal(w.captures.length >= 2, true);
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
    assert.equal(w.stateCalls, 1, 'no Escape, so the state is read once');
    assert.deepEqual(w.slept, [150, 150, 500, 500], 'one settle wait after the slash, one before the check after typing, no escape wait, then two exit checks');
  });

  test('(+) the real-shaped placeholder (no-break space after the prompt character, dim text) counts as an empty box', async () => {
    const w = world({});
    const row = w.rows().find((r) => r[0]?.t.startsWith(PROMPT_CHAR));
    assert.equal(row[0].t, `${PROMPT_CHAR}\xa0`, 'the fake draws what real Claude draws');
    assert.equal(row[1].s.d, true);
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
  });

  test('(+) an empty box in other shapes: prompt character alone, whitespace-only non-dim spans', async () => {
    const boxes = [
      [[sp(PROMPT_CHAR)]],
      [[sp(`${PROMPT_CHAR}\xa0`)]],
      [[sp(`${PROMPT_CHAR}\xa0`), sp('Try "x"', true), sp(' ', false)]],
    ];
    for (const box of boxes) {
      const w = world({ box });
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } }, JSON.stringify(box));
      assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
    }
  });

  test('(−) a prompt character followed by a plain space is not Claude\'s box (it always draws a no-break space; a status line may start with ❯ ): 409, nothing typed (I-1)', async () => {
    const w = world({ box: [[sp(`${PROMPT_CHAR} `), sp('Try "x"', true)]] });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-not-empty'));
    assert.deepEqual(keysOf(w), []);
  });

  test('(+) busy: Escape first, one escWaitMs wait, state and screen read again, then the same sequence', async () => {
    const w = world({ state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'text:/', 'text:exit', 'Enter']);
    assert.equal(w.slept[0], 1000);
    assert.equal(w.stateCalls, 2, 'the registry state is read again after Escape');
  });

  test('(+) a prompt that Escape cancels: then the sequence runs', async () => {
    const w = world({ prompt: true, state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') { w.prompt = false; w.state = 'idle'; } };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'text:/', 'text:exit', 'Enter']);
  });

  test('(+) vim normal mode (vimOf true, no INSERT prefix): text i first, then /exit, then Enter', async () => {
    const w = world({ vim: true, vimMode: 'normal' });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:i', 'text:/exit', 'Enter']);
  });

  test('(+) vim insert mode already (the mode line shows INSERT): no i, no probe', async () => {
    const w = world({ vim: true, vimMode: 'insert' });
    assert.deepEqual((await w.control().endSession('%2')).body, { ended: true });
    assert.deepEqual(keysOf(w), ['text:/exit', 'Enter']);
  });

  test('(+) vim session that was busy: Escape leaves it in normal mode, so i comes before /exit', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'text:i', 'text:/exit', 'Enter']);
  });

  test('(+) pane gone: ended true', async () => {
    const w = world({ cmdAfter: null });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
  });

  test('(+) keys.send fails but the pane is gone already: ended true', async () => {
    const w = world({ cmd: 'zsh' });
    w.failSend = (body, n) => (n === 1 ? { status: 404, body: { error: 'not_found' } } : null);
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.equal(w.sent.length, 1);
    assert.equal(w.cmdCalls, 1);
  });

  test('(+) the pane command is trimmed before the CLAUDE_COMMAND test', async () => {
    const gone = world({ cmdAfter: ' zsh\n', exitAfter: 0 });
    assert.deepEqual((await gone.control().endSession('%2')).body, { ended: true });
    const still = world({ cmdAfter: ' claude\n', exitAfter: 0 });
    assert.deepEqual((await still.control().endSession('%2')).body, { ended: false }, 'padding does not hide a running claude');
    const version = world({ cmdAfter: '2.1.319\n', exitAfter: 0 });
    assert.deepEqual((await version.control().endSession('%2')).body, { ended: false });
  });

  test('(+) the options are honoured: pollMs, settleMs, maxPresses, escWaitMs, exitWaitMs, answerHoldMs', async () => {
    const w = world({ mode: 'manual', script: ['manual'] });
    assert.deepEqual(await w.control({ pollMs: 100, settleMs: 250 }).switchMode('%2', 'plan'), { status: 409, body: { error: 'mode-unchanged', presses: 1 } });
    assert.deepEqual(w.slept, [100, 100, 100], 'ceil(250 / 100) reads');
    const w2 = world({ mode: 'manual', script: ['acceptEdits', 'plan', 'acceptEdits', 'plan'] });
    assert.deepEqual(await w2.control({ maxPresses: 2 }).switchMode('%2', 'auto'), { status: 409, body: { error: 'not-in-cycle', presses: 2 } });
    assert.equal(w2.sent.length, 2);
    const w3 = world({ state: 'busy', exitAfter: Infinity });
    w3.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w3.state = 'idle'; };
    await w3.control({ escWaitMs: 50, exitWaitMs: 1000 }).endSession('%2');
    assert.equal(w3.slept[0], 50);
    assert.deepEqual(w3.slept.slice(1, 3), [150, 150], 'then the settle waits after the slash and after the rest');
    assert.equal(w3.slept.slice(3).reduce((a, b) => a + b, 0), 1000);
    const w4 = world({ prompt: true });
    const sig = promptSig(w4.rows());
    const sc = w4.control({ answerHoldMs: 10 });
    await sc.answer('%2', { n: 1, sig });
    w4.t += 10;
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 200);
  });

  test('(+) the lock is released after a refused End, so the next End runs', async () => {
    const w = world({ mode: 'unknown' });
    const sc = w.control();
    assert.equal((await sc.endSession('%2')).status, 409);
    w.mode = 'manual';
    assert.equal((await sc.endSession('%2')).status, 200);
  });
});

describe('endSession (−)', () => {
  test('(−) a draft in the box, one row or two: 409 input-not-empty, nothing typed', async () => {
    for (const box of [[`${PROMPT_CHAR} half-written note`], [`${PROMPT_CHAR} first line`, '  second line'], [`${PROMPT_CHAR}`, '']]) {
      const w = world({ box });
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-not-empty'), JSON.stringify(box));
      assert.deepEqual(w.sent, [], JSON.stringify(box));
    }
  });

  test('(−) a non-dim draft that starts like the placeholder (Try "npm test" and tell me) is a draft: 409 input-not-empty; dim text next to real text is unreadable (src/draft.js, layout): 409 input-unreadable; nothing typed', async () => {
    const boxes = [
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('Try "npm test" and tell me')]], 'input-not-empty'],
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('Try "npm test"', true), sp(' and tell me')]], 'input-unreadable'], // dim then plain text
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('Try', true), sp('x')]], 'input-unreadable'],
      [[[sp(`${PROMPT_CHAR}${NB}`, true), sp('draft')]], 'input-not-empty'],
    ];
    for (const [box, error] of boxes) {
      const end = world({ box });
      assert.deepEqual(await end.control().endSession('%2'), code(409, error), JSON.stringify(box));
      assert.deepEqual(end.sent, []);
      const cmd = world({ box });
      assert.deepEqual(await cmd.control().runCommand('%2', '/compact'), code(409, error));
      assert.deepEqual(cmd.sent, []);
    }
  });

  test('(−) a box that starts with text but no prompt character (a menu, an empty row) is unreadable: 409 input-unreadable, nothing typed', async () => {
    for (const box of [[[sp('Try "x"', true)]], [[sp('> Try "x"', true)]], [[]], ['  1. Yes', '  2. No'], ['', `${PROMPT_CHAR} draft`]]) {
      const w = world({ box });
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-unreadable'), JSON.stringify(box));
      assert.deepEqual(w.sent, [], JSON.stringify(box));
    }
  });

  test('(−) a prompt character glued to the text is an input row holding text: 409 input-not-empty, nothing typed', async () => {
    const w = world({ box: [[sp(`${PROMPT_CHAR}Try "x"`, true)]] });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-not-empty'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) no input box found (no rule rows, or nothing between them): 409 input-unreadable, nothing typed', async () => {
    for (const box of [null, []]) {
      const w = world({ box });
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-unreadable'), String(box));
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a rule-like row that is not only rule characters does not make a box: 409 input-unreadable, nothing typed', async () => {
    const w = world({ box: [EMPTY_BOX] });
    const base = w.rows;
    w.rows = () => rowsOf('earlier output', 'x'.repeat(5), `${RULE} x`, EMPTY_BOX, `${RULE} x`, PHRASE.manual);
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-unreadable'));
    assert.deepEqual(w.sent, []);
    w.rows = base;
  });

  test('(−) the box does not read exactly "/exit" after typing: 409 not-at-prompt, no Enter, only nika\'s own text is cleaned up', async () => {
    const swallowed = world({ swallow: true });
    assert.deepEqual(await swallowed.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(swallowed), ['text:/'], 'the probe slash never shows: nothing on screen to clean up, so no C-u, and no rest');
    const extraRow = world({ afterType: () => { extraRow.box = [`${PROMPT_CHAR} /exit`, '  more']; } });
    assert.deepEqual(await extraRow.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(extraRow), ['text:/', 'text:exit'], 'the second row is not nika\'s text, so nothing is removed');
    const extraText = world({ afterType: () => { extraText.box = [`${PROMPT_CHAR} /exit now`]; } });
    assert.deepEqual(await extraText.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(extraText), ['text:/', 'text:exit'], '"/exit now" is not a prefix of what nika typed: no C-u, no Enter');
    const partial = world({ afterType: () => { partial.box = [`${PROMPT_CHAR} /ex`]; } });
    assert.deepEqual(await partial.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(partial), ['text:/', 'text:exit', 'C-u'], 'a prefix of nika\'s text is removed with one C-u');
  });

  test('(−) a dim "/exit" (ghost text) is never taken as typed: 409 not-at-prompt, no Enter, no C-u', async () => {
    const w = world({ afterType: () => { w.box = [[sp(`${PROMPT_CHAR}${NB}`), sp('/exit', true)]]; } });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit']);
  });

  test('(−) a failed capture after typing: the cleanup still removes nika\'s text, the sequence stops, the pane is checked once', async () => {
    const w = world({ captureFailOn: 2 }); // 1st capture: before typing, 2nd: the check after the probe slash; the cleanup's capture works
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(w), ['text:/', 'C-u']);
    assert.equal(w.cmdCalls, 1);
    const later = world({ captureFailOn: 3 }); // the check after the rest fails (the slash read fine)
    assert.deepEqual(await later.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(later), ['text:/', 'text:exit', 'C-u'], 'the whole of nika\'s text is removed');
    const dead = world({ captureFailFrom: 2 }); // every capture after the first fails: the cleanup ends at once
    assert.deepEqual(await dead.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(dead), ['text:/']);
    assert.equal(dead.cmdCalls, 1);
  });

  test('(−) vim: i does not bring INSERT: 409 mode-unknown, /exit is never typed', async () => {
    const w = world({ vim: true, vimMode: 'normal', insertWorks: false });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['text:i']);
    assert.equal(w.captures.length, 1 + 4, 'the first read plus exactly settleTries reads after i');
    assert.deepEqual(w.slept, [150, 150, 150, 150]);
  });

  test('(−) vim: a failed i send or a failed capture after it stops the sequence', async () => {
    const w = world({ vim: true, vimMode: 'normal' });
    w.failSend = () => ({ status: 429, body: { error: 'busy', message: 'slow' } });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(w), ['text:i']);
    const cap = world({ vim: true, vimMode: 'normal', captureFailOn: 2 });
    assert.deepEqual(await cap.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(cap), ['text:i']);
  });

  test('(+) vimOf false and no INSERT seen in this action: no i is typed, the command runs', async () => {
    const w = world({ vim: false, vimMode: 'normal' });
    assert.deepEqual((await w.control().endSession('%2')).body, { ended: true });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
  });

  test('(−) still busy after Escape: 409 not-idle, nothing typed, the state was read twice', async () => {
    const w = world({ state: 'busy' });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'));
    assert.deepEqual(keysOf(w), ['Escape']);
    assert.equal(w.stateCalls, 2);
  });

  test('(−) a pane with a prompt: Escape is sent, nothing is typed while the prompt stays, 409 not-idle', async () => {
    const w = world({ prompt: true });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'));
    assert.deepEqual(keysOf(w), ['Escape']);
  });

  // 0.5.1 (T64, design 3.1 item 5): this was "one Escape, then mode-unknown". A screen with no readable footer and no input box may be a subagent's view
  // of the parent's pane, where an Escape stops the viewed subagent; End refuses it before any key, busy or not.
  test('(−) an unknown footer on a busy pane: 409 mode-unknown before any key (no Escape: it may be a subagent view), nothing typed', async () => {
    const w = world({ state: 'busy', mode: 'unknown' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(w.sent, []);
    assert.deepEqual(w.slept, []);
  });

  // Round RV (M9): the test above replaced "an unknown footer after Escape: 409 mode-unknown, nothing typed" and nothing else reached the check that stays after
  // the Escape wait (`unknownScreen(seen)` in endSession). The only way to it now: a permission prompt is on screen (so the check before the Escape is skipped,
  // the Escape is the No path), the Escape lands, and the NEXT capture is a screen with no readable mode line and no input box (a dialog or a subagent view).
  test('(−) M9: a permission prompt, the Escape lands, the next capture has no mode line and no input box: 409 mode-unknown after the one Escape, nothing typed', async () => {
    for (const state of ['busy', 'attn']) {
      const w = world({ prompt: true, state });
      w.onKeys = (b) => {
        if (b.keys?.[0] === 'Escape') Object.assign(w, { prompt: false, state: 'idle', mode: 'unknown', box: null }); // the prompt is answered; what is drawn now is unreadable
      };
      assert.equal(promptFromRows(w.rows()) !== null, true, `${state}: premise, a permission prompt is on screen first`);
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'), state);
      assert.deepEqual(keysOf(w), ['Escape'], `${state}: the Escape that answered the prompt, and nothing typed after it`);
      assert.equal(w.slept.length, 1, `${state}: it waited once after the Escape and read again`);
      assert.equal(modeFromRows(w.rows()), 'unknown', `${state}: premise, no mode line now`);
      assert.equal(readDraft({ rows: w.rows(), cursor: w.cursorIn(w.rows()), cols: 80 }), null, `${state}: premise, no input box now`);
    }
  });

  test('(+) M9, the twin: the same prompt and Escape, but a readable screen after it, goes on to /exit', async () => {
    const w = world({ prompt: true, state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') Object.assign(w, { prompt: false, state: 'idle' }); };
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'text:/', 'text:exit', 'Enter']);
  });

  test('(−) an unknown footer on an idle pane (a dialog): no Escape, nothing typed, 409 mode-unknown', async () => {
    const w = world({ mode: 'unknown' });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(w.sent, []);
    assert.deepEqual(w.slept, []);
  });

  test('(−) no live session (state null) and no prompt: 409 not-idle and no key at all (0.3 pressed Escape here; see A3)', async () => {
    const w = world({});
    w.stateOf = async () => null;
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'));
    assert.deepEqual(keysOf(w), []);
  });

  test('(−) claude still running after exitWaitMs: ended false (checked every 500 ms, six checks, not forever)', async () => {
    const w = world({ exitAfter: Infinity });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
    assert.deepEqual(w.slept, [150, 150, 500, 500, 500, 500, 500, 500]);
    assert.equal(w.cmdCalls, 6);
  });

  test('(−) the exit wait is bounded by count: a frozen clock still ends after exitWaitMs / 500 checks', async () => {
    const w = world({ exitAfter: Infinity });
    const r = await w.control({ now: () => 0 }).endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false } });
    assert.equal(w.cmdCalls, 6);
  });

  test('(−) the pane command fails CLAUDE_COMMAND (zsh) counts as ended; node and a version string do not', async () => {
    for (const [cmd, ended] of [['zsh', true], ['bash', true], ['node', false], ['claude', false], ['2.1.319', false]]) {
      const w = world({ cmdAfter: cmd, exitAfter: 0 });
      assert.deepEqual((await w.control().endSession('%2')).body, { ended }, cmd);
    }
  });

  test('(−) keys.send returns 429 on the text: sequence stopped, paneCommand checked once; claude still running: ended false', async () => {
    const w = world({ exitAfter: 0 }); // would have exited had Enter been sent
    w.failSend = (body) => (body.text === 'exit' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'C-u'], 'Enter is never sent; the probe\'s slash is removed');
    assert.equal(w.cmdCalls, 1);
    const slash = world({ exitAfter: 0 });
    slash.failSend = (body) => (body.text === '/' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await slash.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(slash), ['text:/'], 'the probe slash failed: nothing else is sent');
  });

  test('(−) keys.send returns 429 on Enter: sequence stopped, paneCommand checked once, ended false', async () => {
    const w = world({ exitAfter: Infinity });
    w.failSend = (body) => (body.keys?.[0] === 'Enter' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
    assert.equal(w.cmdCalls, 1);
  });

  test('(+) a failed key send during End: 200 ended false with reason "keys" (a rate limit is not "Claude didn\'t exit")', async () => {
    const text = world({ exitAfter: 0 });
    text.failSend = (body) => (body.text === 'exit' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await text.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    const enter = world({ exitAfter: Infinity });
    enter.failSend = (body) => (body.keys?.[0] === 'Enter' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await enter.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    const esc = world({ state: 'busy' });
    esc.failSend = () => ({ status: 429, body: { error: 'busy', message: 'slow' } });
    assert.deepEqual(await esc.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
  });

  test('(−) no reason where the keys were not the problem: pane gone after a failed send, Claude still running after the wait, a 409', async () => {
    const gone = world({ cmd: 'zsh' });
    gone.failSend = (body) => (body.text === 'exit' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await gone.control().endSession('%2'), { status: 200, body: { ended: true } }, 'the pane no longer runs claude: ended, nothing to retry');
    const waited = world({ exitAfter: Infinity });
    assert.deepEqual(await waited.control().endSession('%2'), { status: 200, body: { ended: false } }, 'every key went out; Claude just did not exit');
    const draft = world({ box: ['❯ a draft'] });
    assert.deepEqual(await draft.control().endSession('%2'), code(409, 'input-not-empty'));
  });

  test('(−) a failed Escape stops the sequence like any failed send', async () => {
    const w = world({ state: 'busy' });
    w.failSend = () => ({ status: 429, body: { error: 'busy', message: 'slow' } });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(w), ['Escape']);
  });

  test('(−) a failing paneCommand never claims the session ended', async () => {
    const w = world({});
    w.paneCommand = async () => { throw new Error('tmux down'); };
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: false } });
  });

  test('(−) a failed capture passes its status through and nothing is sent', async () => {
    const w = world({ captureFail: { status: 404, body: { error: 'not_found', message: 'gone' } } });
    assert.deepEqual(await w.control().endSession('%2'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(w.sent, []);
  });
});

describe('a named session: the upper rule carries the session name', () => {
  // The live screen of an orchestrator started with `-n`: labelled upper rule, input row, plain lower rule, a two-row user status line, mode line.
  const named = (name, opts = {}) => world({
    mode: 'auto', vim: true, vimMode: 'insert', topRule: labelled(name), footerTail: ' (shift+tab to cycle)',
    below: ['  Model-X  proj  branch  | effort: high', '  ░░░░░░░░░░ 9% | $1.64 | 12k tokens'], ...opts,
  });
  const text = (row) => row.map((x) => x.t).join('');

  test('(+) End on the live shape: the box is found, /exit is typed and Enter pressed', async () => {
    const w = named('sprint-planning');
    const rows = w.rows().map(text);
    assert.deepEqual(rows.slice(1, 4), ['', `${'─'.repeat(19)} sprint-planning ─`, `${PROMPT_CHAR}${NB}Try "fix lint errors"`], 'the fake draws what real Claude draws');
    assert.equal(rows.at(-1), '-- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)');
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(w.sent, [{ text: '/exit' }, { keys: ['Enter'] }]);
  });

  test('(+) a hyphenated agent name: Compact types its text and presses Enter', async () => {
    const w = named('review-agent-2');
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 200, body: { sent: true } });
    assert.deepEqual(w.sent, [{ text: '/compact' }, { keys: ['Enter'] }]);
  });

  test('(+) a renamed session with inner spaces, a one-character name and an 80-character name: the box is found', async () => {
    for (const name of ['my session 2', 'x', 'é'.repeat(80), 'q'.repeat(80)]) {
      const w = named(name);
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } }, name);
      assert.deepEqual(w.sent, [{ text: '/exit' }, { keys: ['Enter'] }], name);
    }
  });

  test('(+) a labelled rule with a long dash run on either side, and spaces after it: still a rule', async () => {
    const w = named('x', { topRule: `${'─'.repeat(60)} x ${'─'.repeat(60)}  ` });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 200, body: { sent: true } });
  });

  test('(−) a label that is not exactly one run of text between spaces is not a rule: only the lower rule counts, 409, nothing sent', async () => {
    const bad = [
      '── a─b ──', // the label contains a rule character
      '──  x ──', '── x  ──', // a space inside the dashes before or after the label
      '── ──', // no label
      '──x──', '── x──', '──x ──', // the spaces are missing
      '── x', // no closing dashes
      '─ x ─', // one leading dash only
      '─', // a lone dash is not a rule either
      `── ${'q'.repeat(81)} ─`, // a label of 81 characters
      '── a\x07b ─', '── a\x7fb ─', '── a\x9bb ─', '── a\tb ─', // C0, DEL, C1, tab inside the label
      '──  x ─', '── x  ─', // a no-break space is whitespace too
    ];
    for (const topRule of bad) {
      const end = named('x', { topRule });
      assert.deepEqual(await end.control().endSession('%2'), code(409, 'input-unreadable'), JSON.stringify(topRule));
      assert.deepEqual(end.sent, [], JSON.stringify(topRule));
      const cmd = named('x', { topRule });
      assert.deepEqual(await cmd.control().runCommand('%2', '/compact'), code(409, 'input-unreadable'), JSON.stringify(topRule));
      assert.deepEqual(cmd.sent, [], JSON.stringify(topRule));
    }
  });

  test('(−) only one rule row on screen, labelled or plain: no box, 409, nothing sent', async () => {
    for (const only of [labelled('solo'), RULE]) {
      for (const rows of [[only, ...[PLACEHOLDER_BOX], PHRASE.auto], [PLACEHOLDER_BOX, only, PHRASE.auto]]) {
        const w = named('solo');
        w.rows = () => rowsOf('earlier output', ...rows);
        assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-unreadable'));
        assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'input-unreadable'));
        assert.deepEqual(w.sent, []);
      }
    }
  });

  test('(−) a draft under a labelled rule still refuses: typed text is not dim, 409 input-not-empty, nothing sent', async () => {
    for (const box of [[[sp(`${PROMPT_CHAR}${NB}`), sp('half-written note')]], [[sp(`${PROMPT_CHAR}${NB}`), sp('Try "fix lint errors"')]], [`${PROMPT_CHAR} one`, '  two']]) {
      const end = named('sprint-planning', { box });
      assert.deepEqual(await end.control().endSession('%2'), code(409, 'input-not-empty'), JSON.stringify(box));
      assert.deepEqual(end.sent, []);
      const cmd = named('review-agent-2', { box });
      assert.deepEqual(await cmd.control().runCommand('%2', '/compact'), code(409, 'input-not-empty'), JSON.stringify(box));
      assert.deepEqual(cmd.sent, []);
    }
  });
});

describe('0.3.4: input-not-empty (a draft) and input-unreadable (no input box found) are two answers', () => {
  const named = (name, opts = {}) => world({ mode: 'auto', vim: true, vimMode: 'insert', topRule: labelled(name), ...opts });
  /** Runs End and Compact on the same screen: [code, sent keys] of each. */
  const both = async (make) => {
    const out = [];
    for (const run of [(w) => w.control().endSession('%2'), (w) => w.control().runCommand('%2', '/compact')]) {
      const w = make();
      out.push([await run(w), w.sent]);
    }
    return out;
  };

  test('(+) a draft under a plain rule and under a labelled rule is input-not-empty; nothing is sent', async () => {
    const drafts = [[`${PROMPT_CHAR} half-written note`], [`${PROMPT_CHAR} first line`, '  second line'], [[sp(`${PROMPT_CHAR}${NB}`), sp('Try "fix lint errors"')]]];
    for (const box of drafts) {
      for (const make of [() => world({ box }), () => named('sprint-planning', { box })]) {
        for (const [res, sent] of await both(make)) {
          assert.deepEqual(res, code(409, 'input-not-empty'), JSON.stringify(box));
          assert.deepEqual(sent, [], JSON.stringify(box));
        }
      }
    }
  });

  test('(+) no rule rows, one rule row, or two with nothing between them is input-unreadable; nothing is sent', async () => {
    const screens = {
      'no box at all': () => world({ box: null }),
      'one plain rule row': () => { const w = world({}); w.rows = () => rowsOf('earlier output', RULE, PLACEHOLDER_BOX, PHRASE.manual); return w; },
      'one labelled rule row': () => { const w = world({}); w.rows = () => rowsOf('earlier output', labelled('solo'), PLACEHOLDER_BOX, PHRASE.manual); return w; },
      'two rules, nothing between': () => world({ box: [] }),
    };
    for (const [name, make] of Object.entries(screens)) {
      for (const [res, sent] of await both(make)) {
        assert.deepEqual(res, code(409, 'input-unreadable'), name);
        assert.deepEqual(sent, [], name);
      }
    }
  });

  test('(+) a box whose first row is not a prompt row (a menu, text, a blank row) is input-unreadable under either rule, even with a prompt row further down', async () => {
    const boxes = [['  1. Yes', '  2. No'], ['Select a model', `${PROMPT_CHAR} sonnet`], ['', `${PROMPT_CHAR} draft`], [[sp('> not the prompt character')]], [[]]];
    for (const box of boxes) {
      for (const make of [() => world({ box }), () => named('review-agent-2', { box })]) {
        for (const [res, sent] of await both(make)) {
          assert.deepEqual(res, code(409, 'input-unreadable'), JSON.stringify(box));
          assert.deepEqual(sent, [], JSON.stringify(box));
        }
      }
    }
  });

  test('(−) the split only changes the code: an empty or placeholder box still types, and a draft is still never touched', async () => {
    for (const box of [[EMPTY_BOX], [PLACEHOLDER_BOX]]) {
      const w = named('sprint-planning', { box });
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
      assert.deepEqual(w.sent, [{ text: '/exit' }, { keys: ['Enter'] }]);
    }
  });

  test('(−) T35: a rule-shaped or labelled row in the status line below the lower rule moves the box: 409 input-unreadable, nothing sent', async () => {
    const status = '  Model-X  proj  branch  | effort: high';
    const belows = [
      [RULE, status], [status, RULE], [status, RULE, '  second row'], // a plain rule row above, below or between the status rows
      [labelled('status-line'), status], [status, labelled('status-line')], [RULE],
    ];
    for (const below of belows) {
      for (const make of [() => world({ below }), () => named('sprint-planning', { below })]) {
        for (const [res, sent] of await both(make)) {
          assert.deepEqual(res, code(409, 'input-unreadable'), JSON.stringify(below));
          assert.deepEqual(sent, [], JSON.stringify(below));
        }
      }
    }
  });

  test('(+) the / probe (vim never seen) against a labelled top rule: / alone, the rest, Enter', async () => {
    for (const [run, rest] of [[(w) => w.control().runCommand('%2', '/compact'), 'compact'], [(w) => w.control().endSession('%2'), 'exit']]) {
      const w = named('sprint-planning', { vim: false, below: ['  Model-X  proj  branch  | effort: high'] });
      const res = await run(w);
      assert.equal(res.status, 200, rest);
      assert.deepEqual(w.sent, [{ text: '/' }, { text: rest }, { keys: ['Enter'] }], rest);
    }
  });

  test('(+) the / probe in an unseen vim normal mode against a labelled top rule: history search, Escape, i, INSERT, the whole text, Enter', async () => {
    const w = named('review-agent-2', { vimMode: 'normal' });
    assert.deepEqual(await w.control({ vimOf: () => false }).runCommand('%2', '/compact'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'Escape', 'text:i', 'text:/compact', 'Enter']);
  });

  test('(−) the / probe against a labelled rule when the typed slash never shows: 409 not-at-prompt, only the slash was sent', async () => {
    const w = named('sprint-planning', { vim: false, swallow: true });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/']);
  });
});

describe('runCommand', () => {
  test('(+) /compact on an empty box: text, verified on screen, Enter: 200 sent true; no Escape, no wait, no pane check', async () => {
    const w = world({});
    const r = await w.control().runCommand('%2', '/compact');
    assert.deepEqual(r, { status: 200, body: { sent: true } });
    assert.deepEqual(w.sent, [{ text: '/' }, { text: 'compact' }, { keys: ['Enter'] }]);
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
    assert.deepEqual(w.slept, [150, 150], 'only the settle waits: after the probe slash and before the check after the rest');
    assert.equal(w.cmdCalls, 0);
  });

  test('(+) a command with arguments and the placeholder box', async () => {
    const w = world({ box: [PLACEHOLDER_BOX] });
    const r = await w.control().runCommand('%2', '/model sonnet');
    assert.deepEqual(r, { status: 200, body: { sent: true } });
    assert.deepEqual(w.sent, [{ text: '/' }, { text: 'model sonnet' }, { keys: ['Enter'] }]);
  });

  test('(+) vim normal mode: i first, then the command', async () => {
    const w = world({ vim: true, vimMode: 'normal' });
    assert.deepEqual(await w.control().runCommand('%2', '/clear'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:i', 'text:/clear', 'Enter']);
  });

  test('(+) the lock is released after a refused command', async () => {
    const w = world({ state: 'busy' });
    const sc = w.control();
    assert.deepEqual(await sc.runCommand('%2', '/compact'), code(409, 'not-idle'));
    w.state = 'idle';
    assert.equal((await sc.runCommand('%2', '/compact')).status, 200);
  });

  test('(−) busy: 409 not-idle, nothing sent, no Escape', async () => {
    const w = world({ state: 'busy' });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'not-idle'));
    assert.deepEqual(w.sent, []);
    assert.deepEqual(w.slept, []);
  });

  test('(−) no live session (state null) or a prompt on screen: 409 not-idle, nothing sent', async () => {
    const w = world({});
    w.stateOf = async () => null;
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'not-idle'));
    const p = world({ prompt: true });
    assert.deepEqual(await p.control().runCommand('%2', '/compact'), code(409, 'not-idle'));
    assert.deepEqual(w.sent.concat(p.sent), []);
  });

  test('(−) an unknown footer: 409 mode-unknown, nothing sent', async () => {
    const w = world({ mode: 'unknown' });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'mode-unknown'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) a draft in the box (one row or two): 409 input-not-empty; no box: 409 input-unreadable; nothing sent', async () => {
    for (const [box, error] of [[[`${PROMPT_CHAR} draft`], 'input-not-empty'], [[`${PROMPT_CHAR} one`, '  two'], 'input-not-empty'], [null, 'input-unreadable']]) {
      const w = world({ box });
      assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, error), JSON.stringify(box));
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a text that wraps onto a second row fails the exact check: both rows are cleaned up (two C-u), 409 not-at-prompt, no Enter', async () => {
    const w = world({ afterType: () => { w.box = [`${PROMPT_CHAR} /model aaaa`, '  bbbb']; } });
    assert.deepEqual(await w.control().runCommand('%2', '/model aaaabbbb'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'text:model aaaabbbb', 'C-u', 'C-u']);
    assert.deepEqual(w.box, [PLACEHOLDER_BOX], 'the fake box is empty again');
  });

  test('(−) typed text that never shows: nothing to clean up, 409 not-at-prompt, no Enter', async () => {
    const w = world({ swallow: true });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/'], 'the probe slash never shows, so the rest is not typed');
  });

  test('(−) vim: i does not bring INSERT: 409 mode-unknown, the command is never typed', async () => {
    const w = world({ vim: true, vimMode: 'normal', insertWorks: false });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['text:i']);
  });

  test('(−) a failed send returns that send\'s status and body (text or Enter)', async () => {
    const onText = world({});
    onText.failSend = (b) => (b.text ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await onText.control().runCommand('%2', '/compact'), { status: 429, body: { error: 'busy', message: 'slow' } });
    assert.deepEqual(keysOf(onText), ['text:/'], 'the probe slash failed');
    const onRest = world({});
    onRest.failSend = (b) => (b.text && b.text !== '/' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await onRest.control().runCommand('%2', '/compact'), { status: 429, body: { error: 'busy', message: 'slow' } });
    assert.deepEqual(keysOf(onRest), ['text:/', 'text:compact', 'C-u'], 'nika\'s own slash is removed before the failure is returned');
    assert.deepEqual(onRest.box, [PLACEHOLDER_BOX], 'the fake input is empty again');
    const onEnter = world({});
    onEnter.failSend = (b) => (b.keys?.[0] === 'Enter' ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await onEnter.control().runCommand('%2', '/compact'), { status: 502, body: { error: 'tmux_failed', message: 'x' } });
    assert.deepEqual(keysOf(onEnter), ['text:/', 'text:compact', 'Enter']);
  });

  test('(−) a failed capture passes its status through: before typing nothing is sent, after typing nika\'s text is cleaned up', async () => {
    const before = world({ captureFail: { status: 404, body: { error: 'not_found', message: 'gone' } } });
    assert.deepEqual(await before.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(before.sent, []);
    const after = world({ captureFailOn: 2 });
    assert.deepEqual(await after.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(keysOf(after), ['text:/', 'C-u'], 'the cleanup still removes nika\'s own text');
    const rest = world({ captureFailOn: 3 }); // the read-back after the rest fails
    assert.deepEqual(await rest.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(keysOf(rest), ['text:/', 'text:compact', 'C-u']);
  });

  test('(−) a text that is not a non-empty string is 400 invalid before any read', async () => {
    const w = world({});
    for (const text of [undefined, null, '', 5, ['/compact']]) {
      const r = await w.control().runCommand('%2', text);
      assert.equal(r.status, 400, String(text));
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal(w.captures.length, 0);
    assert.deepEqual(w.sent, []);
  });
});

describe('settle after typing (settleTries, settlePollMs)', () => {
  test('(+) the box reads "/exit" only on the 3rd capture after typing: Enter is sent once', async () => {
    const w = world({ typeLag: 2 });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
    assert.equal(w.sent.filter((b) => b.keys?.[0] === 'Enter').length, 1);
    assert.equal(w.captures.length, 1 + 3 + 3, 'the first read plus three reads after the slash and three after the rest (the lag applies to each), none after Enter');
    assert.deepEqual(w.slept.slice(0, 6), [150, 150, 150, 150, 150, 150], 'one settle wait before each read');
  });

  test('(+) a command settles the same way: the box shows it on the 2nd read', async () => {
    const w = world({ typeLag: 1 });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact', 'Enter']);
    assert.deepEqual(w.slept, [150, 150, 150, 150], 'two reads after the slash and two after the rest');
  });

  test('(−) the box never matches within settleTries: exactly settleTries reads, then the cleanup, 409 not-at-prompt, no Enter', async () => {
    const w = world({ typeLag: 99 }); // the box still looks empty when the cleanup looks: nothing to remove
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/'], 'the probe slash is the only thing typed');
    assert.equal(w.captures.length, 1 + 4 + 2, 'the first read, settleTries reads, one cleanup read and its confirming read');
    assert.deepEqual(w.slept, [150, 150, 150, 150, 150], 'four settle waits, one before the confirming cleanup read');
    const c = world({ typeLag: 99 });
    assert.deepEqual(await c.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(c), ['text:/']);
    assert.equal(c.captures.length, 1 + 4 + 2);
    const part = world({ afterType: () => { part.box = [`${PROMPT_CHAR} /ex`]; } });
    assert.deepEqual(await part.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(part), ['text:/', 'text:exit', 'C-u']);
    assert.equal(part.captures.length, 1 + 1 + 4 + 3, 'the first read, the slash read, settleTries reads, then a cleanup read that finds the remainder, one that finds it gone, its confirming read');
  });

  test('(−) the wrong text on every read (a second row appears) ends in not-at-prompt after settleTries reads, nothing removed', async () => {
    const w = world({ afterType: () => { w.box = [`${PROMPT_CHAR} /exit`, '  more']; } });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.equal(w.captures.length, 1 + 1 + 4 + 1);
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit']);
  });

  test('(+) INSERT appears on the 2nd capture after i: the sequence continues', async () => {
    const w = world({ vim: true, vimMode: 'normal', insertLag: 1 });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:i', 'text:/exit', 'Enter']);
    assert.deepEqual(w.slept.slice(0, 3), [150, 150, 150], 'two reads for INSERT, one for the typed text');
  });

  test('(+) the same settle applies to i and to the typed text in one run, each bounded on its own', async () => {
    const w = world({ vim: true, vimMode: 'normal', insertLag: 3, typeLag: 3 });
    assert.deepEqual(await w.control().runCommand('%2', '/clear'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:i', 'text:/clear', 'Enter']);
    assert.equal(w.captures.length, 1 + 4 + 4);
  });

  test('(−) a failed capture inside the loop ends it: the failure is passed on after one cleanup read, nothing more is read', async () => {
    const w = world({ typeLag: 99, captureFailOn: 3 }); // 1st: before typing, 2nd: first try after typing, 3rd: second try fails
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(keysOf(w), ['text:/']);
    assert.equal(w.captures.length, 5, 'the cleanup read is the 4th, its confirming read the 5th');
    const e = world({ typeLag: 99, captureFailOn: 3 });
    assert.deepEqual(await e.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.equal(e.cmdCalls, 1);
  });

  test('(−) the loop is bounded by count: a frozen clock and a never-matching box still stop after settleTries reads', async () => {
    const w = world({ typeLag: 99 });
    assert.deepEqual(await w.control({ now: () => 0 }).runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.equal(w.captures.length, 1 + 4 + 2);
  });

  test('(+) settleTries and settlePollMs are honoured (and at least one read always happens)', async () => {
    const w = world({ typeLag: 99 });
    await w.control({ settleTries: 2, settlePollMs: 40 }).runCommand('%2', '/compact');
    assert.deepEqual(w.slept, [40, 40, 40], 'two settle waits and the wait before the confirming cleanup read');
    assert.equal(w.captures.length, 1 + 2 + 2, 'including the cleanup read and its confirming read');
    const one = world({});
    assert.equal((await one.control({ settleTries: 0 }).runCommand('%2', '/compact')).status, 200, 'a bad count still reads once');
    assert.equal(one.captures.length, 1 + 1 + 1, 'the first read, one after the slash, one after the rest');
  });
});

describe('cleanup of nika\'s own text', () => {
  const wrapped = (w, first, second) => () => { w.box = [`${PROMPT_CHAR} ${first}`, `  ${second}`]; };

  test('(+) a wrapped two-row remainder is removed with two C-u (one per visual row), then 409 not-at-prompt', async () => {
    const w = world({});
    w.afterType = wrapped(w, '/model aaaa', 'bbbb');
    assert.deepEqual(await w.control().runCommand('%2', '/model aaaabbbb'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'text:model aaaabbbb', 'C-u', 'C-u']);
    assert.ok(!keysOf(w).includes('Enter'));
    assert.equal(w.captures.length, 1 + 1 + 4 + 4, 'cleanup reads: two with a remainder, then an empty box and the confirming read');
  });

  test('(+) the cleanup waits settlePollMs before reading again after a C-u, never before its first read', async () => {
    const w = world({});
    w.afterType = wrapped(w, '/model aaaa', 'bbbb');
    await w.control().runCommand('%2', '/model aaaabbbb');
    assert.deepEqual(w.slept, [150, 150, 150, 150, 150, 150, 150, 150], 'one settle wait after the slash, four after the rest, one before each read that follows a C-u, one before the confirming read');
  });

  test('(+) a word-wrap that drops the space at the break still counts as nika\'s text', async () => {
    const w = world({});
    w.afterType = wrapped(w, '/model aaaa', 'bbbb');
    assert.deepEqual(await w.control().runCommand('%2', '/model aaaa bbbb'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'text:model aaaa bbbb', 'C-u', 'C-u']);
  });

  test('(−) the cleanup stops without C-u when the box holds text that is not a prefix of nika\'s text', async () => {
    for (const rows of [[`${PROMPT_CHAR} /model zzzz`], [`${PROMPT_CHAR} my draft`, '  more'], [`${PROMPT_CHAR} /model aaaa`, '  bbbb extra'], [`${PROMPT_CHAR} /model aaaabbbbcccc`]]) {
      const w = world({});
      w.afterType = () => { w.box = rows; };
      assert.deepEqual(await w.control().runCommand('%2', '/model aaaabbbb'), code(409, 'not-at-prompt'), JSON.stringify(rows));
      assert.deepEqual(keysOf(w), ['text:/', 'text:model aaaabbbb'], JSON.stringify(rows));
    }
  });

  test('(−) a dim-only box (the placeholder) is empty, even when what nika typed starts like it; a row without the prompt character is not nika\'s', async () => {
    const dim = world({ swallow: true }); // the typed text never shows, the dim placeholder stays
    assert.deepEqual(await dim.control().runCommand('%2', 'Try "fix lint errors" now'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(dim), ['text:Try "fix lint errors" now'], 'no C-u: the placeholder is not nika\'s text');
    const bare = world({});
    bare.afterType = () => { bare.box = [[sp('/mod')]]; };
    await bare.control().runCommand('%2', '/model aaaa');
    assert.deepEqual(keysOf(bare), ['text:/', 'text:model aaaa']);
  });

  test('(−) the cleanup is bounded at 6 rounds when C-u does not clear anything', async () => {
    const w = world({ cuWorks: false });
    w.afterType = () => { w.box = [`${PROMPT_CHAR} /ex`]; };
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.equal(keysOf(w).filter((k) => k === 'C-u').length, 6);
    assert.equal(w.captures.length, 1 + 1 + 4 + 6);
    assert.ok(!keysOf(w).includes('Enter'));
  });

  test('(−) a failed C-u send ends the cleanup, a failed capture ends it, neither changes the 409', async () => {
    const send = world({});
    send.afterType = () => { send.box = [`${PROMPT_CHAR} /ex`]; };
    send.failSend = (b) => (b.keys?.[0] === 'C-u' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await send.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.equal(keysOf(send).filter((k) => k === 'C-u').length, 1, 'one attempt, then it stops');
    const cap = world({});
    cap.afterType = () => { cap.box = [`${PROMPT_CHAR} /ex`]; };
    cap.captureFailFrom = 8; // 1st read, the slash read, 4 settle reads, the cleanup's first read works, the next fails
    assert.deepEqual(await cap.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.equal(keysOf(cap).filter((k) => k === 'C-u').length, 1);
  });

  test('(−) no input box on screen during the cleanup: nothing is sent', async () => {
    const w = world({});
    w.afterType = () => { w.box = null; };
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit']);
  });
});

describe('stray i and the vim evidence', () => {
  test('(+) vim off but vimOf says on: the i lands as text, one C-u removes it, then 409 mode-unknown', async () => {
    const w = world({ vim: false });
    assert.deepEqual(await w.control({ vimOf: () => true }).endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['text:i', 'C-u']);
    assert.deepEqual(w.box, [PLACEHOLDER_BOX], 'the fake box is empty again');
    assert.equal(w.captures.length, 1 + 4, 'bounded: the first read plus settleTries reads, no cleanup rounds');
  });

  test('(+) the same for a command', async () => {
    const w = world({ vim: false });
    assert.deepEqual(await w.control({ vimOf: () => true }).runCommand('%2', '/clear'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['text:i', 'C-u']);
  });

  test('(−) i did not land as text (vim normal, i ignored): no C-u, 409 mode-unknown', async () => {
    const w = world({ vim: true, vimMode: 'normal', insertWorks: false });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['text:i']);
  });

  test('(−) the box holds more than a lone i (a draft appeared, a dim i): no C-u, 409 mode-unknown', async () => {
    const draft = world({ vim: true, vimMode: 'normal', insertWorks: false });
    draft.afterType = () => {};
    draft.onKeys = (b) => { if (b.text === 'i') draft.box = [`${PROMPT_CHAR} i love it`]; };
    assert.deepEqual(await draft.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(draft), ['text:i']);
    const dim = world({ vim: true, vimMode: 'normal', insertWorks: false });
    dim.onKeys = (b) => { if (b.text === 'i') dim.box = [[sp(`${PROMPT_CHAR}${NB}`), sp('i', true)]]; };
    assert.deepEqual(await dim.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(dim), ['text:i']);
  });

  test('(+) INSERT seen in End\'s own first capture: i is sent after Escape even though vimOf says false', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
    assert.deepEqual(await w.control({ vimOf: () => false }).endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'text:i', 'text:/exit', 'Enter']);
  });

  test('(−) INSERT still shown after Escape (nika cannot tell what that Escape did): 409 mode-unknown, nothing typed (0.3 went on to type; see A3)', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') { w.state = 'idle'; w.vimMode = 'insert'; } }; // runs after the fake's own Escape handling
    assert.deepEqual(await w.control({ vimOf: () => true }).endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['Escape']);
  });

  test('(−) no INSERT in any capture and vimOf false: no i (a non-vim pane is never touched with i)', async () => {
    const w = world({ vim: false });
    assert.deepEqual(await w.control({ vimOf: () => false }).runCommand('%2', '/clear'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:clear', 'Enter']);
  });

  test('(+) the INSERT prefix is read with a no-break space inside it as well', async () => {
    const w = world({ vim: true, vimMode: 'normal' });
    const base = w.rows;
    w.rows = () => base().map((row) => row.map((x) => (x.t.startsWith('-- INSERT --') ? { ...x, t: x.t.replace('-- INSERT -- ', '--\xa0INSERT\xa0-- ') } : x)));
    assert.deepEqual(await w.control().runCommand('%2', '/clear'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:i', 'text:/clear', 'Enter']);
  });
});

describe('Claude\'s own cursor, the separator and a late redraw', () => {
  const rev = { r: true };
  const cursorOnPlaceholder = [sp(`${PROMPT_CHAR}${NB}`), sp('T', false, rev), sp('ry "fix lint errors"', true)];

  test('(+) the placeholder with a reverse-video, non-dim first character (Claude\'s cursor) is an empty box: End proceeds', async () => {
    const w = world({ box: [cursorOnPlaceholder] });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
    const dimCursor = world({ box: [[sp(`${PROMPT_CHAR}${NB}`), sp('T', true, rev), sp('ry "x"', true)]] });
    assert.deepEqual(await dimCursor.control().runCommand('%2', '/compact'), { status: 200, body: { sent: true } }, 'a dim reverse first character too');
  });

  test('(+) an empty box with only a reverse-video space cursor (or plain whitespace) is empty', async () => {
    const boxes = [
      [[sp(`${PROMPT_CHAR}${NB}`), sp(' ', false, rev)]],
      [[sp(PROMPT_CHAR), sp(NB, false, rev)]],
    ];
    for (const box of boxes) {
      const w = world({ box });
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } }, JSON.stringify(box));
      assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
    }
  });

  test('(−) a reverse-video first character followed by a non-dim character is a draft: 409 input-not-empty (with a dim character in between the row is unreadable: 409 input-unreadable); nothing typed', async () => {
    const boxes = [
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('T', false, rev), sp('ry')]], 'input-not-empty'],
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('T', false, rev), sp('r', true), sp('y')]], 'input-unreadable'],
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('x', false, rev)]], 'input-not-empty'], // a lone reverse character is not a placeholder
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('T', false, rev), sp(' ', false, rev), sp('ry', false)]], 'input-not-empty'],
      [[[sp(`${PROMPT_CHAR}${NB}`), sp('a', false, rev), sp('b', false, rev)]], 'input-not-empty'], // two reverse characters, none dim
    ];
    for (const [box, error] of boxes) {
      const end = world({ box });
      assert.deepEqual(await end.control().endSession('%2'), code(409, error), JSON.stringify(box));
      assert.deepEqual(end.sent, []);
      const cmd = world({ box });
      assert.deepEqual(await cmd.control().runCommand('%2', '/compact'), code(409, error));
      assert.deepEqual(cmd.sent, []);
    }
  });

  test('(−) a reverse-video cell only counts as the first visible character, never later in the row: dim text next to real text is unreadable, 409 input-unreadable, nothing typed', async () => {
    const w = world({ box: [[sp(`${PROMPT_CHAR}${NB}`), sp('Try', true), sp('x', false, rev)]] });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-unreadable'));
    assert.deepEqual(w.sent, []);
  });

  test('(−) a box of typed spaces: after /exit it reads "❯   /exit", so no Enter; nika\'s text is cleaned up with C-u; 409 not-at-prompt', async () => {
    const w = world({ box: [[sp(`${PROMPT_CHAR}${NB}`), sp('  ')]] });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'C-u'], 'already the probe slash reads "  /": nothing more is typed');
    assert.ok(w.captures.length >= 5);
    const cmd = world({ box: [[sp(`${PROMPT_CHAR}${NB}`), sp('   ')]] });
    assert.deepEqual(await cmd.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(cmd), ['text:/', 'C-u']);
  });

  test('(−) exactly one separator: more spaces, a missing space or a tab-like gap before the text never match', async () => {
    const rows = [
      [sp(`${PROMPT_CHAR}${NB}`), sp(' /exit')],
      [sp(`${PROMPT_CHAR}${NB}${NB}`), sp('/exit')],
      [sp(`${PROMPT_CHAR}`), sp('/exit')], // no separator at all
      [sp(`${PROMPT_CHAR}${NB}`), sp('/exit', false), sp('x')],
    ];
    for (const row of rows) {
      const w = world({ afterType: () => { w.box = [row]; } });
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'), JSON.stringify(row));
      assert.ok(!keysOf(w).includes('Enter'), JSON.stringify(row));
    }
  });

  test('(+) typed text with a trailing reverse-video space cursor, or trailing plain spaces, still matches', async () => {
    for (const tail of [[sp(' ', false, rev)], [sp('  ')], [sp(NB, false, rev)], []]) {
      const w = world({ afterType: () => { w.box = [[sp(`${PROMPT_CHAR}${NB}`), sp('/exit', false, { fg: 153 }), ...tail]]; } });
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } }, JSON.stringify(tail));
      assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
    }
  });

  test('(+) the separator is a no-break space; (−) a plain space is not the echo of nika\'s text (I-1): no Enter', async () => {
    const ok = world({ afterType: () => { ok.box = [[sp(`${PROMPT_CHAR}${NB}`), sp('/exit')]]; } });
    assert.deepEqual(await ok.control().endSession('%2'), { status: 200, body: { ended: true } });
    const plain = world({ afterType: () => { plain.box = [[sp(`${PROMPT_CHAR} `), sp('/exit')]]; } });
    assert.deepEqual(await plain.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.ok(!keysOf(plain).includes('Enter'), keysOf(plain).join(','));
  });

  test('(+) late redraw: the first cleanup read is empty, the second shows nika\'s text, so C-u is sent', async () => {
    // typeLag 5: the four settle reads and the first cleanup read still show the old (empty) box; the next read shows nika's "/"
    const w = world({ typeLag: 5 });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'C-u']);
    assert.equal(w.captures.length, 1 + 4 + 2 + 2, 'round 1: empty then the remainder; round 2: empty and confirmed empty');
  });

  test('(−) the box stays empty on the confirming read: nothing is sent', async () => {
    const w = world({ swallow: true });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/']);
    assert.equal(w.captures.length, 1 + 4 + 2);
    assert.deepEqual(w.slept, [150, 150, 150, 150, 150], 'the confirming read follows a settlePollMs wait');
  });

  test('(−) the confirming read that finds no box, or fails, ends the cleanup', async () => {
    const gone = world({ swallow: true });
    const base = gone.mirror.capture;
    let n = 0;
    gone.mirror.capture = async (...a) => { n += 1; if (n === 6) gone.box = null; return base(...a); }; // 6th = the confirming read
    assert.deepEqual(await gone.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(gone), ['text:/']);
    const failed = world({ swallow: true, captureFailOn: 7 });
    assert.deepEqual(await failed.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(failed), ['text:/']);
  });

  test('(−) the cleanup stays bounded when the redraw flickers: at most 6 rounds, so at most 6 C-u and 12 cleanup reads', async () => {
    const w = world({});
    w.afterType = () => { w.box = [`${PROMPT_CHAR} /ex`]; };
    const base = w.mirror.capture;
    let flip = 0;
    w.mirror.capture = async (...a) => { // from the first read after the probe's rest (`exit`) on, every other read shows an empty box
      if (w.sent.some((b) => b.text === 'exit')) { flip += 1; w.box = flip % 2 === 0 ? [PLACEHOLDER_BOX] : [`${PROMPT_CHAR} /ex`]; }
      return base(...a);
    };
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.ok(flip > 0, 'the flicker really ran (the hook is keyed on the send the probe makes)');
    assert.ok(keysOf(w).filter((k) => k === 'C-u').length <= 6);
    assert.ok(w.captures.length - 1 - 1 - 4 <= 12, `cleanup reads: ${w.captures.length - 6}`);
    assert.ok(!keysOf(w).includes('Enter'));
  });
});

// --- Task 14a: hardening after the security review and the checks against Claude Code 2.1.319 ---

describe('A1 (H1): a mode switch never stops silently in bypass', () => {
  const stateIdleOnce = (n) => (n === 1 ? 'idle' : 'busy'); // idle for the first read only, as in the review

  test('(+) plan to manual through bypass, the registry busy after the first press: the next press does not need idle, ends in manual', async () => {
    const w = world({ mode: 'plan', script: ['bypassPermissions', 'manual'], stateFn: stateIdleOnce });
    const r = await w.control().switchMode('%2', 'manual');
    assert.deepEqual(r, { status: 200, body: { mode: 'manual', presses: 2 } });
    assert.deepEqual(w.sent, [{ keys: ['BTab'] }, { keys: ['BTab'] }]);
    assert.equal(w.stateCalls, 1, 'in bypass the registry is not asked: only the screen decides');
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
  });

  test('(+) the pass through bypass without a busy registry still presses on (fresh look, no prompt, footer readable)', async () => {
    const w = world({ mode: 'plan', script: ['bypassPermissions', 'manual'] });
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 200, body: { mode: 'manual', presses: 2 } });
    assert.equal(w.stateCalls, 1, 'the state is read once before the first press and not again while in bypass');
  });

  test('(−) the bypass footer is never readable (lag 99): 409 mode-unknown with presses 1, and nothing more is pressed blind', async () => {
    const w = world({ mode: 'plan', script: ['bypassPermissions', 'manual'], lag: 99, stateFn: stateIdleOnce });
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'mode-unknown', presses: 1 } });
    assert.deepEqual(w.sent, [{ keys: ['BTab'] }]);
  });

  test('(−) a prompt opens while in bypass: 409 stopped-in-bypass with presses, no further key', async () => {
    const w = world({ mode: 'plan', script: ['bypassPermissions', 'manual'] });
    const base = w.mirror.capture;
    let afterPress = 0;
    w.mirror.capture = async (...a) => { // the poll (1st capture after the press) reads bypass, the look before the next press (2nd) a prompt
      if (w.presses === 1 && (afterPress += 1) === 2) w.prompt = true;
      return base(...a);
    };
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
    assert.deepEqual(w.sent, [{ keys: ['BTab'] }]);
  });

  test('(−) the footer is unreadable at the look before the next press while in bypass: 409 stopped-in-bypass, no blind press', async () => {
    const w = world({ mode: 'plan', script: ['bypassPermissions', 'manual'] });
    const base = w.mirror.capture;
    let afterPress = 0;
    w.mirror.capture = async (...a) => {
      if (w.presses === 1 && (afterPress += 1) === 2) w.mode = 'unknown';
      return base(...a);
    };
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
    assert.equal(w.sent.length, 1);
  });

  test('(−) a capture that fails while in bypass ends the switch as stopped-in-bypass too', async () => {
    const w = world({ mode: 'plan', script: ['bypassPermissions', 'manual'] });
    const base = w.mirror.capture;
    let afterPress = 0;
    w.mirror.capture = async (...a) => {
      if (w.presses === 1 && (afterPress += 1) === 2) return { status: 502, body: { error: 'tmux_failed', message: 'x' } };
      return base(...a);
    };
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
  });

  test('(+) a 429 on the press out of bypass: sleep(1000), the press is retried once and goes through', async () => {
    const w = world({ mode: 'plan', script: ['bypassPermissions', 'manual'] });
    w.failSend = (b, n) => (n === 2 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null); // the 2nd send fails once
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 200, body: { mode: 'manual', presses: 2 } });
    assert.equal(w.sent.length, 3, 'press, failed press, retried press');
    assert.ok(w.slept.includes(1000), 'the retry waits one second (injected sleep)');
  });

  test('(−) a second failure of the retried press in bypass is 409 stopped-in-bypass; any other failed send there is the same, with no retry', async () => {
    const twice = world({ mode: 'plan', script: ['bypassPermissions', 'manual'] });
    twice.failSend = (b, n) => (n >= 2 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null);
    assert.deepEqual(await twice.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
    assert.equal(twice.sent.length, 3, 'one press and exactly one retry');
    const other = world({ mode: 'plan', script: ['bypassPermissions', 'manual'] });
    other.failSend = (b, n) => (n >= 2 ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await other.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
    assert.equal(other.sent.length, 2, 'a non-429 failure is not retried');
  });

  test('(−) a 429 outside bypass is not retried and keeps its own status and body, plus presses', async () => {
    const w = world({ mode: 'manual' });
    w.failSend = (b, n) => (n === 2 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null);
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), { status: 429, body: { error: 'busy', message: 'slow down', presses: 1 } });
    assert.equal(w.sent.length, 2);
    assert.ok(!w.slept.includes(1000));
  });

  test('(−) bypass that the cycle never leaves: max presses is 409 stopped-in-bypass, and so is a cycle back to a start that was bypass', async () => {
    const stuck = world({ mode: 'manual', script: ['bypassPermissions'] });
    assert.deepEqual(await stuck.control().switchMode('%2', 'plan'), { status: 409, body: { error: 'stopped-in-bypass', presses: 2 } }, 'the press out of bypass changed nothing, and the footer still reads bypass');
    const six = world({ mode: 'plan', script: ['bypassPermissions', 'acceptEdits', 'bypassPermissions', 'acceptEdits', 'bypassPermissions', 'acceptEdits', 'bypassPermissions'] });
    const r = await six.control({ maxPresses: 5 }).switchMode('%2', 'auto');
    assert.deepEqual(r, { status: 409, body: { error: 'stopped-in-bypass', presses: 5 } }, 'the 5th press landed in bypass');
    assert.equal(six.sent.length, 5);
    const back = world({ mode: 'bypassPermissions', script: ['plan', 'bypassPermissions'] });
    assert.deepEqual(await back.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 2 } });
  });

  test('(+) a switch that starts in bypass presses out of it; a busy registry there is still not-idle (no press was made)', async () => {
    const w = world({ mode: 'bypassPermissions', script: ['manual'] });
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 200, body: { mode: 'manual', presses: 1 } });
    const busy = world({ mode: 'bypassPermissions', state: 'busy' });
    assert.deepEqual(await busy.control().switchMode('%2', 'manual'), code(409, 'not-idle'));
    assert.deepEqual(busy.sent, []);
  });

  test('(−) every non-200 result after a press carries presses: not-idle, prompt, unreadable footer, not-in-cycle, failed capture', async () => {
    const idle = world({ mode: 'manual' });
    idle.afterPress = () => { idle.state = 'busy'; };
    assert.deepEqual(await idle.control().switchMode('%2', 'plan'), { status: 409, body: { error: 'not-idle', presses: 1 } });
    const cycle = world({ mode: 'manual', script: ['acceptEdits', 'manual'] });
    assert.deepEqual(await cycle.control().switchMode('%2', 'auto'), { status: 409, body: { error: 'not-in-cycle', presses: 2 } });
    const unknown = world({ mode: 'manual', script: ['acceptEdits', 'unknown'] });
    assert.deepEqual(await unknown.control().switchMode('%2', 'auto'), { status: 409, body: { error: 'mode-unknown', presses: 2 } });
    const gone = world({ mode: 'manual' });
    const base = gone.mirror.capture;
    let n = 0;
    gone.mirror.capture = async (...a) => ((n += 1) >= 3 && gone.presses === 1 ? { status: 404, body: { error: 'not_found', message: 'gone' } } : base(...a));
    assert.deepEqual(await gone.control().switchMode('%2', 'auto'), { status: 404, body: { error: 'not_found', message: 'gone', presses: 1 } });
  });

  test('(−) with no press made, the 409 bodies stay exactly as in 0.3: no presses key', async () => {
    assert.deepEqual(await world({ state: 'busy' }).control().switchMode('%2', 'plan'), code(409, 'not-idle'));
    assert.deepEqual(await world({ mode: 'unknown' }).control().switchMode('%2', 'plan'), code(409, 'mode-unknown'));
  });
});

describe('A3 (M1, F1): interrupt, End and the Stop route', () => {
  const escOf = (w) => keysOf(w).filter((k) => k === 'Escape').length;
  /** After the n-th Escape the fake turns idle. */
  const idleAfterEscape = (w, n = 1) => { let seen = 0; w.onKeys = (b) => { if (b.keys?.[0] === 'Escape' && (seen += 1) >= n) w.state = 'idle'; }; };

  describe('stop', () => {
    test('(+) busy in vim INSERT: Escape leaves INSERT (checked on screen), the state is read again, the second Escape interrupts: 200 presses 2', async () => {
      const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
      assert.deepEqual(await w.control().stop('%2'), { status: 200, body: { stopped: true, presses: 2 } });
      assert.deepEqual(keysOf(w), ['Escape', 'Escape']);
      assert.equal(w.stateCalls, 2, 'once before the first Escape and once before the second');
      assert.ok(w.captures.every((c) => c.o?.fresh === true));
    });

    test('(+) busy without INSERT (a plain or a vim NORMAL input): one Escape, 200 presses 1', async () => {
      const plain = world({ state: 'busy' });
      assert.deepEqual(await plain.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
      assert.deepEqual(keysOf(plain), ['Escape']);
      const normal = world({ vim: true, vimMode: 'normal', state: 'busy' });
      assert.deepEqual(await normal.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
      assert.deepEqual(keysOf(normal), ['Escape']);
    });

    test('(+) any non-idle string counts as busy (an attention state too)', async () => {
      const w = world({ state: 'attn' });
      assert.deepEqual(await w.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
    });

    test('(+) a session with a background shell (nika sends busy for Claude\'s shell status; shell itself also reads as busy): Stop sends Escape, the mode switch is 409 not-idle', async () => {
      for (const state of ['busy', 'shell']) {
        const stop = world({ state });
        assert.deepEqual(await stop.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } }, state);
        assert.deepEqual(keysOf(stop), ['Escape'], state);
        const sw = world({ mode: 'manual', state });
        assert.deepEqual(await sw.control().switchMode('%2', 'plan'), code(409, 'not-idle'), state);
        assert.deepEqual(sw.sent, [], state);
      }
    });

    test('(+) the turn ends by itself after the first Escape (state idle on the re-read): no second Escape, presses 1', async () => {
      const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
      idleAfterEscape(w);
      assert.deepEqual(await w.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
      assert.deepEqual(keysOf(w), ['Escape']);
    });

    test('(+) INSERT goes only on the 3rd capture after the Escape (a late redraw): the wait polls for it, then two Escapes', async () => {
      const w = world({ vim: true, vimMode: 'insert', state: 'busy', escLag: 2 });
      assert.deepEqual(await w.control().stop('%2'), { status: 200, body: { stopped: true, presses: 2 } });
      assert.deepEqual(keysOf(w), ['Escape', 'Escape']);
      assert.deepEqual(w.slept, [150, 150, 150], 'one settle wait before each of the three reads');
    });

    test('(−) INSERT is still shown after the first Escape: 409 mode-unknown, no second key (settleTries reads, no more)', async () => {
      const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
      w.onKeys = () => { w.vimMode = 'insert'; }; // runs after the fake's own Escape handling: INSERT never goes
      assert.deepEqual(await w.control().stop('%2'), code(409, 'mode-unknown'));
      assert.deepEqual(keysOf(w), ['Escape']);
      assert.equal(w.captures.length, 1 + 4);
      assert.equal(w.stateCalls, 1, 'the state is not re-read: nothing more is sent');
    });

    test('(−) idle: 409 not-busy and no key', async () => {
      const w = world({ state: 'idle' });
      assert.deepEqual(await w.control().stop('%2'), code(409, 'not-busy'));
      assert.deepEqual(w.sent, []);
    });

    test('(−) no live session, an ambiguous pane (state null), a failing or non-string state: 409 not-busy and no key', async () => {
      for (const stateOf of [async () => null, async () => undefined, async () => '', async () => 5, async () => { throw new Error('registry unreadable'); }]) {
        const w = world({});
        const r = await w.control({ stateOf }).stop('%2');
        assert.deepEqual(r, code(409, 'not-busy'), String(stateOf));
        assert.deepEqual(w.sent, []);
      }
    });

    test('(−) a permission prompt on screen: 409 prompt-open and no key, busy or not (Stop never answers a prompt)', async () => {
      for (const state of ['busy', 'idle']) {
        const w = world({ prompt: true, state });
        assert.deepEqual(await w.control().stop('%2'), code(409, 'prompt-open'), state);
        assert.deepEqual(w.sent, []);
      }
    });

    test('(−) a failed capture passes its status and body through and nothing is sent', async () => {
      const w = world({ state: 'busy', captureFail: { status: 404, body: { error: 'not_found', message: 'gone' } } });
      assert.deepEqual(await w.control().stop('%2'), { status: 404, body: { error: 'not_found', message: 'gone' } });
      assert.deepEqual(w.sent, []);
      const later = world({ vim: true, vimMode: 'insert', state: 'busy', captureFailOn: 2 }); // the capture that waits for INSERT to go fails
      assert.deepEqual(await later.control().stop('%2'), { status: 404, body: { error: 'not_found', message: 'gone' } });
      assert.deepEqual(keysOf(later), ['Escape']);
    });

    test('(−) a failed Escape send passes its status and body through; a failed second Escape too', async () => {
      const first = world({ state: 'busy' });
      first.failSend = () => ({ status: 429, body: { error: 'busy', message: 'slow down' } });
      assert.deepEqual(await first.control().stop('%2'), { status: 429, body: { error: 'busy', message: 'slow down' } });
      const second = world({ vim: true, vimMode: 'insert', state: 'busy' });
      second.failSend = (b, n) => (n === 2 ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
      assert.deepEqual(await second.control().stop('%2'), { status: 502, body: { error: 'tmux_failed', message: 'x' } });
      assert.deepEqual(keysOf(second), ['Escape', 'Escape']);
    });

    test('(+) Stop does not take the per-pane lock: it runs while a switch holds it, and the others are still refused', async () => {
      const w = world({ mode: 'manual', state: 'busy' });
      const release = hold(w); // the switch waits in its first capture, with the lock taken
      const sc = w.control();
      const switching = sc.switchMode('%1', 'plan');
      await tick();
      assert.deepEqual(await sc.endSession('%1'), code(409, 'busy-switching'), 'the lock is really held');
      const stopping = sc.stop('%1');
      await tick();
      assert.equal(w.captures.length, 2, 'Stop reached its own capture while the lock was held');
      release();
      assert.deepEqual(await stopping, { status: 200, body: { stopped: true, presses: 1 } });
      assert.deepEqual(await switching, code(409, 'not-idle'));
    });
  });

  describe('End', () => {
    test('(−) no live session (state null) and no prompt: 409 not-idle and not one key (M1)', async () => {
      const w = world({});
      w.stateOf = async () => null;
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'));
      assert.deepEqual(w.sent, []);
      assert.deepEqual(w.slept, []);
      const failing = world({});
      failing.stateOf = async () => { throw new Error('registry unreadable'); };
      assert.deepEqual(await failing.control().endSession('%2'), code(409, 'not-idle'));
      assert.deepEqual(failing.sent, []);
    });

    test('(+) a prompt with no registry state: Escape (the No path) is still sent', async () => {
      const w = world({ prompt: true });
      w.stateOf = async () => null;
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'));
      assert.deepEqual(keysOf(w), ['Escape']);
    });

    test('(+) busy in vim INSERT: Escape, INSERT gone, Escape, then the existing flow (i first, because INSERT was seen), /exit, Enter', async () => {
      const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
      idleAfterEscape(w, 2);
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
      assert.deepEqual(keysOf(w), ['Escape', 'Escape', 'text:i', 'text:/exit', 'Enter']);
    });

    test('(−) busy in vim INSERT and INSERT never goes: 409 mode-unknown after one Escape, nothing typed', async () => {
      const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
      w.onKeys = () => { w.vimMode = 'insert'; };
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
      assert.deepEqual(keysOf(w), ['Escape']);
    });

    test('(+) an attention state (non-idle string) gets the Escape like busy', async () => {
      const w = world({ state: 'attn' });
      idleAfterEscape(w);
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
      assert.deepEqual(keysOf(w).slice(0, 1), ['Escape']);
    });
  });
});

describe('A4 (m1): answer also reads the question and the rest of the prompt window for bypass', () => {
  test('(−) a question that mentions bypass while no option does: 400 invalid, nothing sent', async () => {
    const w = world({ prompt: true, question: 'Switch to bypass permissions mode?', options: ['Yes', 'No'], });
    const sig = promptSig(w.rows());
    for (const n of [1, 2]) {
      const r = await w.control().answer('%2', { n, sig });
      assert.equal(r.status, 400, `option ${n}`);
      assert.equal(r.body.error, 'invalid');
      assert.equal(r.body.message, 'this option is answered in the terminal');
    }
    assert.deepEqual(w.sent, []);
  });

  test('(−) a bypass in a row above the question, inside the 15-row window, is refused too', async () => {
    const w = world({ prompt: true });
    const base = w.rows;
    w.rows = () => [...rowsOf('Claude wants to run: grep -r "BYPASS" src/'), ...base()];
    assert.equal((await w.control().answer('%2', { n: 1, sig: promptSig(w.rows()) })).status, 400);
    assert.deepEqual(w.sent, []);
  });

  test('(+) the same prompt without the word is answered; a bypass older than the 15-row window does not count', async () => {
    const w = world({ prompt: true });
    const base = w.rows;
    w.rows = () => [...rowsOf('old output: bypass', ...Array.from({ length: 16 }, (_, i) => `row ${i}`)), ...base()];
    assert.deepEqual(await w.control().answer('%2', { n: 1, sig: promptSig(w.rows()) }), { status: 200, body: { answered: 1 } });
    assert.deepEqual(w.sent, [{ text: '1' }]);
  });
});

describe('A5 (m2, F3): the first-character probe in typeCommand', () => {
  test('(+) a plain input (vim unknown): `/` alone, the box reads `/`, the rest, the exact read-back of the whole text, Enter once', async () => {
    const w = world({});
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 200, body: { sent: true } });
    assert.deepEqual(w.sent, [{ text: '/' }, { text: 'compact' }, { keys: ['Enter'] }]);
    assert.deepEqual(w.slept, [150, 150], 'one settle wait after the slash and one after the rest');
    assert.equal(w.captures.length, 1 + 1 + 1);
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
  });

  test('(+) End takes the same road: /, exit, Enter', async () => {
    const w = world({});
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
  });

  test('(+) vim NORMAL that nika has never seen: the slash opens the history search, Escape closes it, `i`, INSERT, the whole text, Enter', async () => {
    const w = world({ vim: true, vimMode: 'normal' });
    assert.deepEqual(await w.control({ vimOf: () => false }).runCommand('%2', '/compact'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'Escape', 'text:i', 'text:/compact', 'Enter']);
    assert.equal(w.history, false, 'the history search was closed again');
    assert.equal(w.sent.filter((b) => b.keys?.[0] === 'Enter').length, 1);
  });

  test('(+) the same for End (the history search is closed before /exit is typed)', async () => {
    const w = world({ vim: true, vimMode: 'normal' });
    assert.deepEqual(await w.control({ vimOf: () => false }).endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'Escape', 'text:i', 'text:/exit', 'Enter']);
  });

  test('(+) vim known (the pane memory, or INSERT shown): no probe, today\'s path', async () => {
    const normal = world({ vim: true, vimMode: 'normal' });
    assert.deepEqual(await normal.control().runCommand('%2', '/clear'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(normal), ['text:i', 'text:/clear', 'Enter']);
    const insert = world({ vim: true, vimMode: 'insert' });
    assert.deepEqual(await insert.control({ vimOf: () => false }).runCommand('%2', '/clear'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(insert), ['text:/clear', 'Enter']);
  });

  test('(−) a draft in the box is never touched: the empty-box check runs before the probe, nothing is typed', async () => {
    for (const [box, error] of [[[`${PROMPT_CHAR} half-written note`], 'input-not-empty'], [[`${PROMPT_CHAR}`, '  second line'], 'input-not-empty'], [null, 'input-unreadable']]) {
      const w = world({ box });
      assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, error), JSON.stringify(box));
      assert.deepEqual(w.sent, [], JSON.stringify(box));
    }
  });

  test('(−) an unknown screen after the slash (nothing typed shows, no history search): cleanup, 409 not-at-prompt, no Enter, no rest', async () => {
    const swallowed = world({ swallow: true });
    assert.deepEqual(await swallowed.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(swallowed), ['text:/']);
    const other = world({ hookSlash: true, afterType: () => { other.box = [`${PROMPT_CHAR} /x something else`]; } });
    assert.deepEqual(await other.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(other), ['text:/'], 'text that is not nika\'s slash is not cleaned up');
    assert.equal(other.captures.length, 1 + 4 + 1, 'the first read, settleTries reads, one cleanup read');
  });

  test('(−) the slash never shows within settleTries reads (a stale redraw): nothing to clean up, 409 not-at-prompt, no rest', async () => {
    const w = world({ typeLag: 99 });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/']);
  });

  test('(−) the history search does not close after the Escape: 409 not-at-prompt, no `i`, nothing typed', async () => {
    const w = world({ vim: true, vimMode: 'normal', historyStuck: true });
    assert.deepEqual(await w.control({ vimOf: () => false }).runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/', 'Escape']);
    assert.equal(w.captures.length, 1 + 1 + 4, 'the first read, one read that shows the history, settleTries reads for the empty box');
  });

  test('(−) after the history search, `i` does not bring INSERT: 409 mode-unknown, the command is never typed', async () => {
    const w = world({ vim: true, vimMode: 'normal', insertWorks: false });
    assert.deepEqual(await w.control({ vimOf: () => false }).runCommand('%2', '/compact'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['text:/', 'Escape', 'text:i']);
  });

  test('(−) failed sends and captures on the probe road pass their status through', async () => {
    const slash = world({});
    slash.failSend = (b) => (b.text === '/' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await slash.control().runCommand('%2', '/compact'), { status: 429, body: { error: 'busy', message: 'slow' } });
    assert.deepEqual(keysOf(slash), ['text:/']);
    const esc = world({ vim: true, vimMode: 'normal' });
    esc.failSend = (b) => (b.keys?.[0] === 'Escape' ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await esc.control({ vimOf: () => false }).runCommand('%2', '/compact'), { status: 502, body: { error: 'tmux_failed', message: 'x' } });
    assert.deepEqual(keysOf(esc), ['text:/', 'Escape']);
    const cap = world({ captureFailOn: 2 }); // the read after the slash fails; the cleanup's reads work
    assert.deepEqual(await cap.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(keysOf(cap), ['text:/', 'C-u'], 'nika\'s own slash is removed');
  });

  test('(+) a text that does not start with a slash is typed whole, without a probe (the controller does not assume a command)', async () => {
    const w = world({});
    assert.deepEqual(await w.control().runCommand('%2', 'plain words'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:plain words', 'Enter']);
  });

  test('(+) a lone `/` as the whole text is typed once (no empty second send)', async () => {
    const w = world({});
    assert.deepEqual(await w.control().runCommand('%2', '/'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'Enter']);
  });
});

// --- Task 14a fix round 1: the review of 14a (Important 1-3, Minor 3-5) ---

describe('fix round 1: a footer that stays unreadable after a press out of bypass (Important 1)', () => {
  test('(−) the switch started in bypass and the footer is unreadable after the press (scripted, or lagging): 409 stopped-in-bypass with presses, nothing more pressed', async () => {
    const scripted = world({ mode: 'bypassPermissions', script: ['unknown'] });
    assert.deepEqual(await scripted.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
    assert.deepEqual(scripted.sent, [{ keys: ['BTab'] }]);
    const lagging = world({ mode: 'bypassPermissions', script: ['manual'], lag: 99 });
    assert.deepEqual(await lagging.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
    assert.deepEqual(lagging.sent, [{ keys: ['BTab'] }]);
  });

  test('(−) a footer that reads bypass and does not change after the press is stopped-in-bypass, never mode-unchanged', async () => {
    const w = world({ mode: 'bypassPermissions', script: ['bypassPermissions'] });
    assert.deepEqual(await w.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 1 } });
    const later = world({ mode: 'plan', script: ['bypassPermissions', 'bypassPermissions'] }); // passes into bypass, and the next press changes nothing
    assert.deepEqual(await later.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'stopped-in-bypass', presses: 2 } });
  });

  test('(+) the same unreadable footer after a press that started in another mode stays 409 mode-unknown with presses (the screen never showed bypass)', async () => {
    const lagging = world({ mode: 'plan', script: ['bypassPermissions', 'manual'], lag: 99 });
    assert.deepEqual(await lagging.control().switchMode('%2', 'manual'), { status: 409, body: { error: 'mode-unknown', presses: 1 } });
    const later = world({ mode: 'bypassPermissions', script: ['acceptEdits', 'unknown'] }); // bypass was left; the unreadable press started in acceptEdits
    assert.deepEqual(await later.control().switchMode('%2', 'plan'), { status: 409, body: { error: 'mode-unknown', presses: 2 } });
  });
});

describe('fix round 1: the state read before the second Escape is uncached (Minor 3)', () => {
  test('(+) busy in vim INSERT: the first read is the usual one, the re-read before the second Escape asks for a fresh state', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    assert.deepEqual(await w.control().stop('%2'), { status: 200, body: { stopped: true, presses: 2 } });
    assert.deepEqual(w.stateArgs, [undefined, { fresh: true }]);
  });

  test('(−) the fresh state is idle (the turn ended by itself): the second Escape is skipped, 200 presses 1', async () => {
    const w = world({ vim: true, vimMode: 'insert', stateFn: (n) => (n === 1 ? 'busy' : 'idle') });
    assert.deepEqual(await w.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
    assert.deepEqual(keysOf(w), ['Escape']);
    assert.deepEqual(w.stateArgs, [undefined, { fresh: true }]);
  });

  test('(−) End takes the same road: a fresh state that is idle after the first Escape sends no second one', async () => {
    const w = world({ vim: true, vimMode: 'insert', stateFn: (n) => (n === 1 ? 'busy' : 'idle') });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.equal(keysOf(w).filter((k) => k === 'Escape').length, 1);
    assert.deepEqual(w.stateArgs.slice(0, 2), [undefined, { fresh: true }]);
  });
});

describe('fix round 1: one interrupt per pane at a time (Minor 4)', () => {
  const escapes = (w) => keysOf(w).filter((k) => k === 'Escape').length;
  /** A sleep that waits at its first call (inside the interrupt: the settle after the first Escape) until the test releases it. */
  function gated(w) {
    let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    const reached = new Promise((r) => { entered = r; });
    let first = true;
    const sleep = async (ms) => { w.t += ms; w.slept.push(ms); if (first) { first = false; entered(); await gate; } };
    return { sleep, release, reached };
  }

  test('(−) Stop while another Stop is between its two Escapes: 409 stopping, nothing sent; the first one finishes with presses 2', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    const g = gated(w);
    const ctl = w.control({ sleep: g.sleep });
    const first = ctl.stop('%2');
    await g.reached;
    assert.deepEqual(await ctl.stop('%2'), code(409, 'stopping'));
    assert.equal(escapes(w), 1, 'the second Stop sent nothing');
    g.release();
    assert.deepEqual(await first, { status: 200, body: { stopped: true, presses: 2 } });
    assert.equal(escapes(w), 2);
  });

  test('(−) End in the middle of a Stop: its interrupt finds the pane taken, 409 not-idle, nothing sent (and no lock is needed for Stop)', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    const g = gated(w);
    const ctl = w.control({ sleep: g.sleep });
    const stopping = ctl.stop('%2');
    await g.reached;
    assert.deepEqual(await ctl.endSession('%2'), code(409, 'not-idle'));
    assert.equal(escapes(w), 1);
    g.release();
    assert.equal((await stopping).status, 200);
  });

  test('(−) Stop in the middle of End\'s interrupt: 409 stopping, nothing sent', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    const g = gated(w);
    const ctl = w.control({ sleep: g.sleep });
    const ending = ctl.endSession('%2');
    await g.reached;
    assert.deepEqual(await ctl.stop('%2'), code(409, 'stopping'));
    assert.equal(escapes(w), 1);
    g.release();
    await ending;
  });

  test('(+) it is per pane and always cleared: another pane is not held, a finished, failed or throwing interrupt does not stick', async () => {
    const w = world({ vim: true, vimMode: 'insert', state: 'busy' });
    const g = gated(w);
    const ctl = w.control({ sleep: g.sleep });
    const first = ctl.stop('%2');
    await g.reached;
    assert.equal((await ctl.stop('%3')).status, 200, 'another pane has its own flag');
    g.release();
    await first;
    const failing = world({ state: 'busy' });
    failing.failSend = () => ({ status: 502, body: { error: 'tmux_failed', message: 'x' } });
    const c2 = failing.control();
    assert.equal((await c2.stop('%2')).status, 502);
    failing.failSend = null;
    assert.deepEqual(await c2.stop('%2'), { status: 200, body: { stopped: true, presses: 1 } }, 'a failed send cleared it');
    const throwing = world({ state: 'busy' });
    const send = throwing.keys.send;
    let boom = true;
    throwing.keys.send = async (...a) => { if (boom) { boom = false; throw new Error('tmux'); } return send(...a); };
    const c3 = throwing.control();
    await assert.rejects(() => c3.stop('%2'));
    assert.deepEqual(await c3.stop('%2'), { status: 200, body: { stopped: true, presses: 1 } }, 'a throw cleared it');
  });
});

describe('fix round 1: a failed send of the probe\'s rest removes the slash (Minor 5)', () => {
  test('(−) the rest fails (a command, and End): nika\'s `/` is removed with C-u before the failure is returned', async () => {
    const cmd = world({});
    cmd.failSend = (b) => (b.text && b.text !== '/' ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await cmd.control().runCommand('%2', '/compact'), { status: 502, body: { error: 'tmux_failed', message: 'x' } });
    assert.deepEqual(keysOf(cmd), ['text:/', 'text:compact', 'C-u']);
    assert.deepEqual(cmd.box, [PLACEHOLDER_BOX]);
    const end = world({});
    end.failSend = (b) => (b.text === 'exit' ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await end.control().endSession('%2'), { status: 200, body: { ended: false, reason: 'keys' } });
    assert.deepEqual(keysOf(end), ['text:/', 'text:exit', 'C-u']);
  });

  test('(+) vim known: nothing was typed before the failed text, so no C-u is sent', async () => {
    const w = world({ vim: true, vimMode: 'insert' });
    w.failSend = (b) => (b.text === '/compact' ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 502, body: { error: 'tmux_failed', message: 'x' } });
    assert.deepEqual(keysOf(w), ['text:/compact']);
  });

  test('(−) the cleanup leaves a user\'s text alone: a box that holds something else after the failed send keeps it', async () => {
    const w = world({});
    w.failSend = (b) => {
      if (b.text && b.text !== '/') { w.box = [`${PROMPT_CHAR} my own note`]; return { status: 502, body: { error: 'tmux_failed', message: 'x' } }; }
      return null;
    };
    assert.equal((await w.control().runCommand('%2', '/compact')).status, 502);
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact']);
  });
});

describe('keyGap (0.5, W2 and W3): no key while a Stop or End interrupt runs, nor within 40 ms of its Escape (N-2)', () => {
  test('(+) false on a quiet pane, and the controller exposes it next to withPaneLock', async () => {
    const ctl = world().control();
    assert.equal(typeof ctl.keyGap, 'function');
    assert.equal(ctl.keyGap('%2'), false);
    assert.equal(ctl.keyGap('%9'), false);
  });

  test('(+) Stop: true inside the interrupt (while its Escape is being sent), true right after it, true at 39 ms, false at 40 ms and after', async () => {
    const w = world({ state: 'busy' });
    const ctl = w.control();
    const inside = [];
    w.onKeys = () => inside.push(ctl.keyGap('%2')); // the fake pane calls this from inside keys.send
    assert.deepEqual(await ctl.stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
    assert.deepEqual(inside, [true]);
    assert.equal(ctl.keyGap('%2'), true, 'its Escape went out just now');
    w.t += 39;
    assert.equal(ctl.keyGap('%2'), true);
    w.t += 1;
    assert.equal(ctl.keyGap('%2'), false, '40 ms passed');
    assert.equal(ctl.keyGap('%2'), false, 'and it stays false');
  });

  test('(+) End that interrupts a busy turn: true while it runs; once it is over the gap is the time since its last Escape', async () => {
    const w = world({ state: 'busy' });
    const ctl = w.control();
    const inside = [];
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') { inside.push(ctl.keyGap('%2')); w.state = 'idle'; } };
    await ctl.endSession('%2');
    assert.deepEqual(inside, [true]);
    assert.equal(ctl.keyGap('%2'), false, 'End waited a second after its Escape (escWaitMs): the gap is long over');
  });

  test('(−) another pane is not held back, and a Stop that sent no key (idle) leaves no gap', async () => {
    const w = world({ state: 'busy' });
    const ctl = w.control();
    await ctl.stop('%2');
    assert.equal(ctl.keyGap('%3'), false);
    const idle = world({ state: 'idle' });
    const quiet = idle.control();
    assert.deepEqual(await quiet.stop('%2'), { status: 409, body: { error: 'not-busy' } });
    assert.equal(quiet.keyGap('%2'), false);
  });

  test('(−) a clock that went back counts as passed (never a gap that does not end)', async () => {
    const w = world({ state: 'busy' });
    const ctl = w.control();
    await ctl.stop('%2');
    w.t -= 5000;
    assert.equal(ctl.keyGap('%2'), false);
  });

  test('(−) the flag is cleared when the interrupt fails or throws: a failed Escape send still starts the 40 ms gap, then it ends', async () => {
    const w = world({ state: 'busy' });
    w.failSend = () => ({ status: 429, body: { error: 'busy', message: 'slow down' } });
    const ctl = w.control();
    assert.equal((await ctl.stop('%2')).status, 429);
    assert.equal(ctl.keyGap('%2'), true, 'the Escape may have been delivered');
    w.t += 40;
    assert.equal(ctl.keyGap('%2'), false);
  });
});

describe('boxInput (0.5, W2 fix round 1): the one preparation of a capture for the box readers', () => {
  const vimInsert = (nbsp) => { // the mode line with a no-break space where Claude may draw one: inside `-- INSERT --`
    const s = boxRows({ cols: 80, lines: ['hello'], insert: true, pad: true });
    s.rows[s.rows.length - 1] = s.rows.at(-1).map((sp2) => (sp2.t === '-- INSERT --' && nbsp ? { ...sp2, t: '-- INSERT\u00a0--' } : sp2));
    return s;
  };

  test('(+) rows, cursor and cols come back; the no-break spaces of the LAST non-blank row become plain spaces, no other row changes', () => {
    const s = vimInsert(true);
    const out = boxInput(s);
    assert.equal(out.cursor, s.cursor);
    assert.equal(out.cols, s.cols);
    assert.equal(out.rows.length, s.rows.length);
    assert.equal(rowText(out.rows.at(-1)).includes('\u00a0'), false);
    assert.match(rowText(out.rows.at(-1)), /-- INSERT --/);
    for (let i = 0; i < s.rows.length - 1; i += 1) assert.equal(out.rows[i], s.rows[i], `row ${i} is the same object`);
    assert.equal(rowText(s.rows[1]).includes('\u00a0'), true, 'the prompt row keeps the no-break space Claude draws after the glyph');
  });

  test('(+) readDraft is parseDraft of the prepared capture, and the attachment send\'s boxSquash reads the same draft from it (same sig)', () => {
    for (const s of [vimInsert(true), vimInsert(false), boxRows({ cols: 80, lines: ['a b', 'c'], pad: true }), boxRows({ cols: 80, lines: [''] })]) {
      const input = boxInput(s);
      assert.deepEqual(readDraft(s), parseDraft(input.rows, input.cursor, input.cols));
      assert.deepEqual(boxSquash(input.rows, input.cursor, input.cols).draft, readDraft(s));
    }
    assert.equal(readDraft(vimInsert(true)).state, 'text');
  });

  test('(+) D1: the box reads with Claude\'s hover pointer on a row of the agent list under the footer (the cursor is in the box)', () => {
    const plain = boxRows({ cols: 80, lines: ['hello'], insert: true, pad: true });
    const want = readDraft(plain);
    assert.equal(want.text, 'hello');
    for (const pointer of [null, 'main', 0, 1]) {
      const s = { ...plain, rows: [...plain.rows, ...subagentRows({ cols: 80, agents: 2, pointer })] };
      assert.deepEqual(readDraft(s), want, `pointer ${pointer}`);
    }
  });

  test('(−) D1: the same screen with the cursor parked on the last row (keyboard selection or the footer pill has focus, spike D1-S): no box', () => {
    const plain = boxRows({ cols: 80, lines: ['hello'], insert: true, pad: true });
    for (const pointer of ['main', 0]) {
      const rows = [...plain.rows, ...subagentRows({ cols: 80, agents: 2, pointer })];
      assert.equal(readDraft({ ...plain, rows, cursor: { x: 0, y: rows.length - 1, visible: false } }), null, `pointer ${pointer}`);
    }
    const rows = [...plain.rows, ...subagentRows({ cols: 80, agents: 2 })];
    assert.equal(readDraft({ ...plain, rows, cursor: { x: 0, y: rows.length - 1, visible: false } }), null, 'footer pill focus: no pointer, same cursor');
  });

  test('(−) no integer cursor x and y: null, so readDraft is null too (N-1)', () => {
    const s = boxRows({ cols: 80, lines: ['hello'] });
    for (const cursor of [null, undefined, {}, { x: 1 }, { x: 1.5, y: 2 }, { x: '1', y: '2' }]) {
      assert.equal(boxInput({ ...s, cursor }), null, JSON.stringify(cursor));
      assert.equal(readDraft({ ...s, cursor }), null);
    }
    assert.equal(boxInput(null), null);
    assert.equal(boxInput(undefined), null);
  });

  test('(−) rows that are not an array, or a screen with no non-blank row, do not throw', () => {
    assert.deepEqual(boxInput({ rows: 'x', cursor: { x: 0, y: 0 }, cols: 80 }).rows, []);
    assert.deepEqual(boxInput({ rows: [[], []], cursor: { x: 0, y: 0 }, cols: 80 }).rows, [[], []]);
  });
});

// Claude's question and plan dialogs on screen (0.5, W1, design section 5): every control that is not the dialog route treats them like a
// permission prompt. Nothing is sent to a dialog except by answerDialog (test/dialog-answer.test.js); End answers it with one Escape.
describe('a question or plan dialog on screen (promptOpen)', () => {
  const SHAPES = {
    ask: { phase: 'ask' },
    multi: { phase: 'ask', tabs: [TAB.tools] },
    review: { phase: 'review', tabs: [TAB.project, TAB.tools] },
    plan: { phase: 'plan' },
    exit: { phase: 'exit' }, // "Exit plan mode?": T1 cannot read it, it is still not a plain box
    nudge: { phase: 'nudge' }, // the auto-mode nudge
  };
  /** A world whose screen is the dialog until `w.dialog` is set to null. */
  function withDialog(shape, opts = {}) {
    const w = world({ state: 'attn', ...opts });
    const base = w.rows;
    w.dialog = Array.isArray(shape) ? shape : dialogWorld(typeof shape === 'string' ? SHAPES[shape] : shape).screen().rows;
    w.rows = () => w.dialog ?? base();
    return w;
  }

  test('(−) Stop: 409 prompt-open for every dialog shape (nothing sent), where a plain busy pane is stopped', async () => {
    for (const name of Object.keys(SHAPES)) {
      const w = withDialog(name);
      assert.deepEqual(await w.control().stop('%2'), code(409, 'prompt-open'), name);
      assert.deepEqual(keysOf(w), [], name);
    }
    const busy = world({ state: 'busy' });
    assert.deepEqual((await busy.control().stop('%2')).body, { stopped: true, presses: 1 });
  });

  // The three shapes src/dialog.js parks (W1-T1 review M3): dialogOnScreen is false for them, because the footer is not the last row or the
  // title is clipped away, yet a dialog is open and an Escape would decline it. They have no mode line and no input box.
  const TREE = [[], [sp('  \u23fa main')], [sp('  \u25ef Explore  scan the repo 5s')]]; // a subagent list under the last row
  // 0.5.4 (QP, O1): a wrapped ask footer with an agent list under it is no longer parked: the footer is found by askFooterRows (consecutive rows at column 0 under a
  // blank row), so it is a dialog on screen like any other (WRAPPED_WITH_LIST below). The other two shapes stay parked.
  const PARKED = {
    'Exit plan mode? with an agent list': () => [...dialogWorld({ phase: 'exit' }).screen().rows, ...TREE],
    'a plan clipped above Ready to code?': () => {
      const rows = dialogWorld({ phase: 'plan' }).screen().rows;
      return rows.slice(rows.findIndex((row) => rowText(row).trim() === 'Ready to code?') + 1);
    },
  };

  const WRAPPED_WITH_LIST = () => {
    const rows = dialogWorld({ phase: 'ask' }).screen().rows;
    const foot = rowText(rows.at(-1));
    const at = foot.indexOf('navigate');
    return [...rows.slice(0, -1), [sp(foot.slice(0, at).trimEnd())], [sp(foot.slice(at))], ...TREE];
  };

  test('(+) 0.5.4 (QP, O1): a wrapped ask footer with an agent list under it is a dialog on screen: Stop is 409 prompt-open and End sends one Escape (as for any dialog), not screen-unclear or mode-unknown', async () => {
    const rows = WRAPPED_WITH_LIST();
    assert.equal(dialogOnScreen(rows), true, 'the wrapped footer anchors the dialog');
    for (const state of ['busy', 'attn']) {
      const w = withDialog(WRAPPED_WITH_LIST(), { state });
      assert.deepEqual(await w.control().stop('%2'), code(409, 'prompt-open'), state);
      assert.deepEqual(keysOf(w), [], state);
      const e = withDialog(WRAPPED_WITH_LIST(), { state });
      assert.deepEqual(await e.control().endSession('%2'), code(409, 'not-idle'), `${state}: the Escape does not close the fixture`);
      assert.deepEqual(keysOf(e), ['Escape'], state);
    }
  });

  test('(\u2212) 0.5.4 (QP, O1): the wrapped footer alone is not enough: a footer split with a non-blank row above it or an indented second row, under an agent list, is still parked', async () => {
    for (const bad of [(rows, foot, at) => [...rows.slice(0, -2), [sp(foot.slice(0, at).trimEnd())], [sp(`  ${foot.slice(at)}`)], ...TREE], (rows, foot, at) => [...rows.slice(0, -2), [sp('x')], [sp(foot.slice(0, at).trimEnd())], [sp(foot.slice(at))], ...TREE]]) {
      const rows = dialogWorld({ phase: 'ask' }).screen().rows;
      const foot = rowText(rows.at(-1));
      const made = bad(rows, foot, foot.indexOf('navigate'));
      assert.equal(dialogOnScreen(made), false, 'no footer is found');
    }
  });

  test('(−) I2: Stop is 409 screen-unclear (not prompt-open: no prompt is recognised) on the parked shapes, busy or attn, and not one key goes out (an Escape would decline the dialog)', async () => {
    for (const [name, make] of Object.entries(PARKED)) {
      for (const state of ['busy', 'attn']) {
        const rows = make();
        assert.equal(dialogOnScreen(rows), false, `${name}: premise, nika's recogniser sees no dialog here`);
        assert.equal(promptFromRows(rows), null, `${name}: premise, nor a permission prompt`);
        const w = withDialog(rows, { state });
        assert.deepEqual(await w.control().stop('%2'), code(409, 'screen-unclear'), `${name} / ${state}`);
        assert.deepEqual(keysOf(w), [], `${name} / ${state}`);
        assert.equal(w.stateCalls, 0, `${name} / ${state}: refused before the registry is asked`);
      }
    }
  });

  test('(+) fix 2: a prompt or a dialog nika recognises stays 409 prompt-open, never screen-unclear (the page then says "answer the prompt")', async () => {
    for (const state of ['busy', 'idle']) {
      const w = world({ prompt: true, state });
      assert.deepEqual(await w.control().stop('%2'), code(409, 'prompt-open'), state);
      assert.deepEqual(w.sent, []);
    }
    for (const name of Object.keys(SHAPES)) {
      const w = withDialog(name);
      assert.equal(dialogOnScreen(w.rows()), true, `${name}: premise`);
      assert.deepEqual(await w.control().stop('%2'), code(409, 'prompt-open'), name);
      assert.deepEqual(keysOf(w), [], name);
    }
  });

  test('(+) I2: a busy turn keeps its box and mode line, so Stop still interrupts it: with a subagent list under the mode line, with vim INSERT, in any mode', async () => {
    const tree = world({ state: 'busy' });
    const base = tree.rows;
    tree.rows = () => [...base(), ...TREE];
    assert.deepEqual(await tree.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
    assert.deepEqual(keysOf(tree), ['Escape']);
    const insert = world({ state: 'busy', vim: true, vimMode: 'insert' });
    assert.deepEqual(await insert.control().stop('%2'), { status: 200, body: { stopped: true, presses: 2 } });
    for (const mode of ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
      const w = world({ state: 'busy', mode });
      assert.deepEqual(await w.control().stop('%2'), { status: 200, body: { stopped: true, presses: 1 } }, mode);
    }
  });

  // 0.5.1 (T64): busy or attn used to give one Escape (which declined the parked dialog) and then 409 not-idle. nika cannot tell these three shapes from a
  // subagent view of the parent's pane (no readable mode line, no input box, a subagent list under the last row), where that Escape stops the viewed
  // subagent, so End now refuses all of them before any key, whatever the registry says; the dialog stays open for the person to answer in the terminal.
  test('(−) I2 (0.5.1): End on the parked shapes types nothing and presses nothing, busy, attn or idle: 409 mode-unknown with no key', async () => {
    for (const [name, make] of Object.entries(PARKED)) {
      for (const state of ['busy', 'attn', 'idle']) {
        const w = withDialog(make(), { state });
        assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'), `${name} / ${state}`);
        assert.deepEqual(keysOf(w), [], `${name} / ${state}`);
      }
    }
  });

  test('(−) mode switch and commands: 409 not-idle even when the registry says idle (the screen decides), nothing sent', async () => {
    for (const name of Object.keys(SHAPES)) {
      const w = withDialog(name, { state: 'idle' });
      assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'not-idle'), name);
      assert.deepEqual(await w.control().runCommand('%2', '/model'), code(409, 'not-idle'), name);
      assert.deepEqual(keysOf(w), [], name);
    }
  });

  test('(−) a permission prompt answer and a dialog: /answer finds no prompt on a dialog screen (409 no-prompt), nothing sent', async () => {
    const w = withDialog('ask');
    assert.deepEqual(await w.control().answer('%2', { n: 1, sig: '0123456789abcdef' }), code(409, 'no-prompt'));
    assert.deepEqual(keysOf(w), []);
  });

  test('(+) End on a dialog: exactly one Escape declines it, then the usual /exit sequence runs', async () => {
    for (const name of ['ask', 'review', 'plan']) {
      const w = withDialog(name);
      w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') { w.dialog = null; w.state = 'idle'; } };
      const r = await w.control().endSession('%2');
      assert.deepEqual(r, { status: 200, body: { ended: true } }, name);
      assert.deepEqual(keysOf(w), ['Escape', 'text:/', 'text:exit', 'Enter'], name);
    }
  });

  test('(−) End on a dialog that the Escape does not close (vim INSERT leaves INSERT only): 409 not-idle, no /exit typed', async () => {
    const w = withDialog({ vim: true, focus: 4 }); // the text row of the question, INSERT shown
    assert.ok(w.dialog.some((row) => row.some((c) => /-- INSERT --/.test(c.t))), 'the fake shows the INSERT marker');
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, code(409, 'not-idle'));
    assert.deepEqual(keysOf(w), ['Escape'], 'one Escape and nothing after it');
  });

  test('(−) End on a dialog nika cannot read ("Exit plan mode?", the nudge): one Escape, then nothing typed if it stays', async () => {
    for (const name of ['exit', 'nudge']) {
      const w = withDialog(name);
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'), name);
      assert.deepEqual(keysOf(w), ['Escape'], name);
    }
  });
});

describe('answerSurvey (0.5, F14): one digit into Claude\'s feedback survey', () => {
  const survey = (extra = {}) => world({ survey: {}, ...extra });
  /** The sig the page would hand back: the one src/survey.js reads from the screen as it is now. */
  const sigOf = (w) => {
    const rows = w.rows();
    return surveyOf({ rows, cursor: w.cursorIn(rows) }, { vim: w.vim, insert: w.vim && w.vimMode === 'insert' }).sig;
  };
  const ask = (sc, w, n, extra = {}) => sc.answerSurvey('%2', { n, sig: sigOf(w), ...extra });
  const texts = (w) => w.sent.map((b) => b.text);
  const escapes = (w) => w.sent.filter((b) => b.keys?.includes('Escape')).length;

  describe('(+)', () => {
    test('(+) 3 (Good): exactly one key, the literal text "3", then 200 { answered: 3 }; every capture and the registry read are fresh', async () => {
      const w = survey();
      assert.deepEqual(await ask(w.control(), w, 3), { status: 200, body: { answered: 3 } });
      assert.deepEqual(w.sent, [{ text: '3' }], 'one digit, no Enter, no Escape, no other key');
      assert.ok(w.captures.every((c) => c.o?.fresh === true));
      assert.deepEqual(w.stateArgs, [{ fresh: true }], 'the registry is read once, skipping its cache');
      assert.deepEqual(w.slept, [150, 150], 'the first read-back still shows the digit and the rows, the second is clean');
    });

    test('(+) S1: the registry is read between two captures, and the digit goes out only after the second one: the state is read with one capture behind it, the key with two', async () => {
      const w = survey();
      const order = [];
      w.stateFn = async () => { order.push(`state after ${w.captures.length} capture(s)`); return 'idle'; };
      w.onKeys = (b) => { if (b.text === '3') order.push(`digit after ${w.captures.length} capture(s)`); };
      assert.deepEqual(await ask(w.control(), w, 3), { status: 200, body: { answered: 3 } });
      assert.deepEqual(order, ['state after 1 capture(s)', 'digit after 2 capture(s)']);
      assert.deepEqual(w.sent, [{ text: '3' }], 'the one digit, once');
      assert.ok(w.captures.every((c) => c.o?.fresh === true), 'the second capture is fresh too');
    });

    test('(+) 0 (Dismiss) and 1, 2: the same, each digit as typed text', async () => {
      for (const n of [0, 1, 2]) {
        const w = survey();
        assert.deepEqual(await ask(w.control(), w, n), { status: 200, body: { answered: n } }, String(n));
        assert.deepEqual(w.sent, [{ text: String(n) }], String(n));
      }
    });

    test('(+) vim INSERT, and a vim pane that is not in NORMAL, answer too', async () => {
      const w = survey({ vim: true, vimMode: 'insert' });
      assert.deepEqual(await ask(w.control(), w, 2), { status: 200, body: { answered: 2 } });
      assert.deepEqual(w.sent, [{ text: '2' }]);
    });

    test('(+) a survey that opens mid-turn is answered once the registry says idle; the row between the options and the box may hold a notice', async () => {
      const w = survey({ survey: { free: "You've used 80% of your weekly limit" } });
      assert.equal((await ask(w.control(), w, 1)).status, 200);
    });

    test('(+) the read-back waits for Claude\'s 400 ms pause: a slow redraw (rows still there for 4 reads) is still taken within the 1 s window', async () => {
      const w = survey({ survey: { lag: 4 } });
      assert.deepEqual(await ask(w.control(), w, 3), { status: 200, body: { answered: 3 } });
      assert.deepEqual(w.slept, [150, 150, 150, 150, 150]);
    });

    test('(+) the read-back is bounded: it never sleeps more than 1 s in total', async () => {
      const w = survey({ survey: { takes: false } });
      assert.deepEqual(await ask(w.control(), w, 3), { status: 409, body: { error: 'not-taken', sent: 1 } });
      assert.ok(w.slept.reduce((a, b) => a + b, 0) <= 1000, JSON.stringify(w.slept));
      assert.ok(w.slept.length >= 3, 'and long enough for the 400 ms pause');
    });

    test('(+) the same sig answered under 3 s ago is 409 already-answered with no key; a different survey (another sig) can be answered at once', async () => {
      const w = survey();
      const sc = w.control();
      const sig = sigOf(w);
      assert.equal((await sc.answerSurvey('%2', { n: 3, sig })).status, 200);
      w.survey = {}; // Claude shows the same survey again, same words under the same message
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), code(409, 'already-answered'));
      assert.deepEqual(texts(w), ['3']);
      w.t += 3000;
      assert.equal((await sc.answerSurvey('%2', { n: 1, sig })).status, 200, 'after the hold');
    });
  });

  describe('(−) nothing sent', () => {
    test('(−) a body that is not exactly { n: 0-3, sig } is 400 invalid before anything is read', async () => {
      const w = survey();
      const sig = sigOf(w);
      for (const body of [null, undefined, [], 'x', {}, { n: 3 }, { sig }, { n: 4, sig }, { n: -1, sig }, { n: '3', sig }, { n: 1.5, sig }, { n: 3, sig: 'ABCDEF0123456789' }, { n: 3, sig: 'abc' }, { n: 3, sig, extra: 1 }]) {
        const r = await w.control().answerSurvey('%2', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.error, 'invalid');
      }
      assert.deepEqual(w.sent, []);
      assert.deepEqual(w.captures, [], 'the body is checked before the screen is looked at');
    });

    test('(−) another control action is running on the pane: 409 busy-switching, nothing sent', async () => {
      const w = survey();
      const release = hold(w);
      const sc = w.control();
      const first = sc.switchMode('%1', 'plan');
      await tick();
      assert.deepEqual(await sc.answerSurvey('%1', { n: 3, sig: sigOf(w) }), code(409, 'busy-switching'));
      release();
      await first;
      assert.ok(!texts(w).includes('3'));
    });

    test('(−) a Stop or End interrupt is running, or its Escape went out less than 40 ms ago: 409 not-idle, nothing sent (a digit right behind an Escape is Meta+digit)', async () => {
      const w = survey({ state: 'busy' });
      const sc = w.control();
      const sig = sigOf(w);
      assert.equal((await sc.stop('%2')).status, 200);
      assert.deepEqual(keysOf(w), ['Escape']);
      w.state = 'idle';
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), code(409, 'not-idle'), 'the Escape went out at this very moment');
      assert.deepEqual(keysOf(w), ['Escape'], 'no digit');
      w.t += 40;
      assert.equal((await sc.answerSurvey('%2', { n: 3, sig })).status, 200, 'after the gap');
      // an interrupt that is still running (between its two Escapes)
      const v = survey({ vim: true, vimMode: 'insert', state: 'busy' });
      const sig2 = sigOf(v);
      let release;
      const gate = new Promise((r) => { release = r; });
      let entered;
      const reached = new Promise((r) => { entered = r; });
      let first = true;
      const sleep = async (ms) => { v.t += ms; v.slept.push(ms); if (first) { first = false; entered(); await gate; } };
      const sc2 = v.control({ sleep });
      const stopping = sc2.stop('%2');
      await reached;
      assert.deepEqual(await sc2.answerSurvey('%2', { n: 3, sig: sig2 }), code(409, 'not-idle'));
      release();
      await stopping;
      assert.ok(!texts(v).includes('3'));
    });

    test('(−) the registry does not say idle (busy, an attention state, no state, a failing lookup): 409 not-idle, zero keys, after the screen checks', async () => {
      for (const state of ['busy', 'attn', 'shell', null]) {
        const w = survey({ state });
        assert.deepEqual(await ask(w.control(), w, 3), code(409, 'not-idle'), String(state));
        assert.deepEqual(w.sent, [], String(state));
      }
      const failing = survey();
      failing.stateFn = () => { throw new Error('registry unreadable'); };
      assert.deepEqual(await ask(failing.control(), failing, 3), code(409, 'not-idle'));
      assert.deepEqual(failing.sent, []);
    });

    test('(−) a Stop that goes out while the registry is being read: the last check before the key refuses (not-idle), the digit is never typed', async () => {
      const w = survey();
      const sc = w.control({ sleep: async (ms) => { w.slept.push(ms); } }); // the clock stands still: the Escape is "just now" when the state read returns
      const sig = sigOf(w);
      w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
      w.stateFn = async (calls) => {
        if (calls > 1) return w.state;
        w.state = 'busy';
        assert.equal((await sc.stop('%2')).status, 200);
        return 'idle';
      };
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), code(409, 'not-idle'));
      assert.equal(escapes(w), 1);
      assert.ok(!texts(w).includes('3'), 'a digit right behind an Escape would be Meta+digit');
    });

    test('(−) S1: the screen changes while the registry is read (answered in the terminal, text typed, a prompt opened, a bypass mention): 409 survey-changed, nothing sent, two captures', async () => {
      const changes = {
        'the rows are gone (answered in the terminal)': (w) => { w.survey = null; },
        'text typed into the box': (w) => { w.box = ['❯ half-written note']; },
        'a digit typed into the box': (w) => { w.box = ['❯ 3']; },
        'a permission prompt opened': (w) => { w.prompt = true; },
        'a bypass mention appeared (the sig does not cover that row)': (w) => { w.survey = { free: 'a bypass notice' }; },
        'another row between the options and the box': (w) => { w.survey = { free: SURVEY_O }; },
      };
      for (const [name, change] of Object.entries(changes)) {
        const w = survey();
        const sig = sigOf(w);
        w.stateFn = async () => { change(w); return 'idle'; };
        assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig }), code(409, 'survey-changed'), name);
        assert.deepEqual(w.sent, [], name);
        assert.equal(w.captures.length, 2, `${name}: the second capture is what refused`);
      }
    });

    test('(−) S1: another survey stands there when the registry answers (the sig differs, the words are the same): 409 survey-changed, nothing sent', async () => {
      const w = survey();
      const sig = sigOf(w);
      w.stateFn = async () => { const rows = w.rows; w.rows = () => [...rowsOf('a different message above'), ...rows()]; return 'idle'; };
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig }), code(409, 'survey-changed'));
      assert.deepEqual(w.sent, []);
      assert.equal(w.captures.length, 2);
    });

    test('(−) S1: the second capture fails: its own status and body pass through (nothing was sent, so no `sent`), nothing typed', async () => {
      const w = survey({ captureFailOn: 2 });
      assert.deepEqual(await ask(w.control(), w, 3), { status: 404, body: { error: 'not_found', message: 'gone' } });
      assert.deepEqual(w.sent, []);
      assert.equal(w.captures.length, 2);
    });

    test('(−) S1: the error order is unchanged: a registry that does not say idle refuses (not-idle) before the second capture is even taken', async () => {
      const busy = survey({ state: 'busy' });
      busy.rows = ((rows) => () => (busy.captures.length >= 2 ? rowsOf('changed') : rows()))(busy.rows);
      assert.deepEqual(await ask(busy.control(), busy, 3), code(409, 'not-idle'), 'not idle before the second capture is even taken');
      assert.equal(busy.captures.length, 1);
    });

    test('(−) S1: a Stop that goes out while the screen is read again: the last check before the key refuses (not-idle), the digit is never typed', async () => {
      const w = survey({ state: 'busy' });
      const sc = w.control({ sleep: async (ms) => { w.slept.push(ms); } }); // the clock stands still: the Escape is "just now" when the second read returns
      const sig = sigOf(w);
      w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
      w.stateFn = async (calls) => (calls === 1 ? 'idle' : w.state);
      const capture = w.mirror.capture;
      let stopped = false;
      w.mirror.capture = async (...args) => {
        const res = await capture(...args);
        if (w.captures.length === 2 && !stopped) { // the second look of answerSurvey: Stop begins while it is in flight
          stopped = true;
          assert.equal((await sc.stop('%2')).status, 200);
        }
        return res;
      };
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), code(409, 'not-idle'));
      assert.equal(escapes(w), 1);
      assert.ok(!texts(w).includes('3'), 'a digit right behind an Escape would be Meta+digit');
    });

    test('(−) M1: the rows Claude draws after a rating are no survey: 409 no-survey, nothing sent, however the sig was got', async () => {
      const w = world({ followUp: true });
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 1, sig: '0123456789abcdef' }), code(409, 'no-survey'));
      assert.deepEqual(w.sent, [], 'a 1 there would open /feedback');
      assert.equal(w.stateCalls, 0, 'the registry is not even read');
    });

    test('(−) a failed capture passes through with its own status and body, nothing sent', async () => {
      const w = survey({ captureFail: { status: 404, body: { error: 'not_found', message: 'gone' } } });
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), { status: 404, body: { error: 'not_found', message: 'gone' } });
      assert.deepEqual(w.sent, []);
    });

    test('(−) a permission prompt or a dialog on screen: 409 prompt-open, zero keys', async () => {
      const prompt = survey({ prompt: true });
      assert.deepEqual(await prompt.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'prompt-open'));
      assert.deepEqual(prompt.sent, []);
      const dialog = dialogWorld({});
      assert.equal(dialogOnScreen(dialog.screen().rows), true, 'the fake dialog is one nika sees');
      assert.deepEqual(await dialog.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'prompt-open'));
      assert.deepEqual(dialog.keysLog(), []);
    });

    test('(−) no survey on screen: 409 no-survey, zero keys', async () => {
      const w = world({});
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'no-survey'));
      assert.deepEqual(w.sent, []);
    });

    test('(−) the transcript question or a bypass mention: 400 terminal-only, zero keys (the page says to answer in the terminal)', async () => {
      const consent = survey();
      const rows = consent.rows;
      consent.rows = () => rowsOf(...rows().map((r) => rowText(r)).map((t) => (t === SURVEY_Q ? '● Can Anthropic look at your session transcript to help us improve Claude Code?' : t)));
      assert.deepEqual(await consent.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), { status: 400, body: { error: 'terminal-only', message: 'answer this in the terminal' } });
      const bypass = survey({ survey: { free: 'a bypass notice' } });
      assert.deepEqual(await bypass.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), { status: 400, body: { error: 'terminal-only', message: 'answer this in the terminal' } });
      const mode = survey({ mode: 'bypassPermissions' });
      assert.equal((await mode.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' })).body.error, 'terminal-only');
      for (const w of [consent, bypass, mode]) assert.deepEqual(w.sent, []);
    });

    test('(−) text in the input box (a draft, a typed digit): 409 input-not-empty, zero keys', async () => {
      for (const box of [[`${PROMPT_CHAR} half-written note`], [`${PROMPT_CHAR} 3`]]) {
        const w = survey({ box });
        assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'input-not-empty'), box[0]);
        assert.deepEqual(w.sent, []);
      }
    });

    test('(−) vim NORMAL (the pane was seen in INSERT, no marker now): 409 text-mode, zero keys', async () => {
      const w = survey({ vim: true, vimMode: 'normal' });
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'text-mode'));
      assert.deepEqual(w.sent, []);
    });

    test('(−) rows nika does not read exactly (a second row between, another options row): 409 survey-changed, zero keys', async () => {
      const w = survey({ survey: { free: SURVEY_O } });
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'survey-changed'));
      assert.deepEqual(w.sent, []);
    });

    test('(−) the page\'s sig is not the screen\'s (another survey, or the same one under another message): 409 survey-changed, zero keys', async () => {
      const w = survey();
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'survey-changed'));
      assert.deepEqual(w.sent, []);
      const sig = sigOf(w);
      w.rows = ((rows) => () => [...rowsOf('a different message above'), ...rows()])(w.rows);
      assert.deepEqual(await w.control().answerSurvey('%2', { n: 3, sig }), code(409, 'survey-changed'));
      assert.deepEqual(w.sent, []);
    });

    test('(−) the order of the checks: the screen before the registry (a missing survey is no-survey even when busy), the sig before the registry', async () => {
      const gone = world({ state: 'busy' });
      assert.deepEqual(await gone.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'no-survey'));
      const wrong = survey({ state: 'busy' });
      assert.deepEqual(await wrong.control().answerSurvey('%2', { n: 3, sig: '0123456789abcdef' }), code(409, 'survey-changed'));
      assert.deepEqual(wrong.stateCalls, 0, 'the registry is not even read');
    });
  });

  describe('(−) after the key', () => {
    test('(−) the rows stay (Claude did not take the digit): 409 not-taken with sent 1; nika never removes the digit', async () => {
      const w = survey({ survey: { takes: false } });
      assert.deepEqual(await ask(w.control(), w, 3), { status: 409, body: { error: 'not-taken', sent: 1 } });
      assert.deepEqual(w.sent, [{ text: '3' }], 'no C-u, no BSpace, no Escape to take it back');
    });

    test('(−) the rows are gone but the box still reads exactly the digit: 409 not-taken with sent 1', async () => {
      const w = survey();
      const sc = w.control();
      const sig = sigOf(w);
      w.onKeys = (b) => { if (b.text === '3') { w.survey = null; w.surveyLeft = 0; } }; // the rows vanish, the digit stays in the box
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), { status: 409, body: { error: 'not-taken', sent: 1 } });
      assert.deepEqual(w.sent, [{ text: '3' }]);
    });

    test('(−) a not-taken answer is still held: a second click on the same sig is already-answered, with no second digit (and a digit that stuck in the box is input-not-empty)', async () => {
      const w = survey({ survey: { takes: false }, swallow: true }); // the digit never reached the box
      const sc = w.control();
      const sig = sigOf(w);
      assert.equal((await sc.answerSurvey('%2', { n: 3, sig })).body.error, 'not-taken');
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), code(409, 'already-answered'));
      assert.deepEqual(w.sent, [{ text: '3' }]);
      const stuck = survey({ survey: { takes: false } }); // the digit sits in the box and the rows stay
      const sc2 = stuck.control();
      const sig2 = sigOf(stuck);
      assert.equal((await sc2.answerSurvey('%2', { n: 3, sig: sig2 })).body.error, 'not-taken');
      assert.deepEqual(await sc2.answerSurvey('%2', { n: 3, sig: sig2 }), code(409, 'input-not-empty'));
      assert.deepEqual(stuck.sent, [{ text: '3' }], 'no second digit');
    });

    test('(−) a 429 or any other failure of the key send passes through with its own status and body; nothing is held', async () => {
      const w = survey();
      w.failSend = () => ({ status: 429, body: { error: 'busy', message: 'too many keys' } });
      const sc = w.control();
      const sig = sigOf(w);
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), { status: 429, body: { error: 'busy', message: 'too many keys' } });
      w.failSend = null;
      assert.equal((await sc.answerSurvey('%2', { n: 3, sig })).status, 200, 'not held: a retry goes');
      const down = survey();
      down.failSend = () => ({ status: 502, body: { error: 'tmux', message: 'x' } });
      assert.deepEqual(await ask(down.control(), down, 2), { status: 502, body: { error: 'tmux', message: 'x' } });
    });

    test('(−) a capture that fails after the key passes through with sent 1', async () => {
      const w = survey();
      const sc = w.control();
      const sig = sigOf(w);
      w.onKeys = () => { w.captureFail = { status: 404, body: { error: 'not_found', message: 'gone' } }; };
      assert.deepEqual(await sc.answerSurvey('%2', { n: 3, sig }), { status: 404, body: { error: 'not_found', message: 'gone', sent: 1 } });
    });
  });

  describe('no Escape for Claude\'s "Esc to undo" row (SURVEY_UNDO_MS)', () => {
    test('(+) after a rating (1-3), Stop and End send no Escape for SURVEY_UNDO_MS: 409 survey-undo, then they go as before', async () => {
      const w = survey();
      const sc = w.control();
      assert.equal((await ask(sc, w, 2)).status, 200);
      w.state = 'busy'; // a new turn began right after the rating
      w.t += 100;
      assert.deepEqual(await sc.stop('%2'), code(409, 'survey-undo'));
      assert.deepEqual(await sc.endSession('%2'), code(409, 'survey-undo'));
      assert.equal(escapes(w), 0);
      w.t += SURVEY_UNDO_MS;
      assert.deepEqual(await sc.stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
      assert.equal(escapes(w), 1);
    });

    test('(+) the hold is a guarantee of the one key path: any Escape of this controller is refused inside it (the history search of a command in vim NORMAL), other keys are not', async () => {
      const w = survey();
      const sc = w.control({ vimOf: () => false });
      assert.equal((await ask(sc, w, 1)).status, 200);
      w.vim = true;
      w.vimMode = 'normal'; // the pane turns out to be vim, in NORMAL: `/` opens the history search, which only an Escape closes
      w.t += 100;
      assert.deepEqual(await sc.runCommand('%2', '/compact'), code(409, 'survey-undo'));
      assert.equal(escapes(w), 0);
      assert.equal(w.history, true, 'the search stays open until the hold ends: nika sends no Escape');
    });

    test('(+) keys other than Escape are not held: a mode switch right after the rating presses BTab', async () => {
      const w = survey();
      const sc = w.control();
      assert.equal((await ask(sc, w, 3)).status, 200);
      w.t += 100;
      assert.equal((await sc.switchMode('%2', 'acceptEdits')).status, 200);
      assert.ok(keysOf(w).includes('BTab'));
    });

    test('(−) Dismiss (0) has no undo row: Stop works at once; so does a send that failed', async () => {
      const w = survey();
      const sc = w.control();
      assert.equal((await ask(sc, w, 0)).status, 200);
      w.state = 'busy';
      assert.equal((await sc.stop('%2')).status, 200);
      const f = survey();
      f.failSend = () => ({ status: 429, body: { error: 'busy', message: 'x' } });
      const sc2 = f.control();
      assert.equal((await ask(sc2, f, 3)).status, 429);
      f.failSend = null;
      f.state = 'busy';
      assert.equal((await sc2.stop('%2')).status, 200, 'the digit never went out: no hold');
    });

    test('(−) a digit that fails to go out leaves the hold of an earlier rating as it was', async () => {
      const w = survey();
      const sc = w.control();
      const sig = sigOf(w);
      assert.equal((await sc.answerSurvey('%2', { n: 2, sig })).status, 200);
      w.survey = {}; // shown again, 3 s later (the answered hold is over, the undo hold is not)
      w.t += 3000;
      w.failSend = () => ({ status: 429, body: { error: 'busy', message: 'x' } });
      assert.equal((await sc.answerSurvey('%2', { n: 3, sig })).status, 429);
      w.failSend = null;
      w.state = 'busy';
      assert.deepEqual(await sc.stop('%2'), code(409, 'survey-undo'));
    });

    test('(−) the hold is per pane', async () => {
      const w = survey();
      const sc = w.control();
      assert.equal((await ask(sc, w, 3)).status, 200);
      w.state = 'busy';
      w.t += 100;
      assert.equal((await sc.stop('%3')).status, 200, 'another pane');
      assert.deepEqual(await sc.stop('%2'), code(409, 'survey-undo'));
    });

    test('(−) a clock that went back counts as passed, like the 40 ms gap', async () => {
      const w = survey();
      const sc = w.control();
      assert.equal((await ask(sc, w, 3)).status, 200);
      w.state = 'busy';
      w.t -= 5000;
      assert.equal((await sc.stop('%2')).status, 200);
    });
  });
});

// 0.5.1 (T64): End never presses Escape on a screen it cannot read. With a subagent's view, Claude's subagent list or the shells pill in the parent's pane
// there is no readable mode line and no input box, and an Escape in the viewed subagent's input would stop that subagent (S-AGENTS). Synthetic rows
// after the captured shapes: a labelled rule, the subagent's input, a rule, the footer, a blank row, the list.
describe('End and Stop on a subagent view, the subagent list or the shells pill (0.5.1)', () => {
  const VIEW_RULE = (label) => `${'─'.repeat(20)} ${label} ─`;
  const LIST = (pointer) => [[], [sp('  ◯ main')], [sp(`${pointer ? '❯ ' : '  '}⏺ demo-type  tidy the notes  12s`)]];
  const agentBox = [[sp(VIEW_RULE('tidy the notes'))], [sp(`${PROMPT_CHAR}${NB}`), sp('Message @demo-type…', true)], [sp(RULE)]];
  const SCREENS = {
    'the subagent view, input focus': [...agentBox, [sp('  ⏸ manual mode on · esc to stop')], ...LIST(false)],
    'the subagent view, list focus': [...agentBox, [sp('  ↑/↓ to select')], ...LIST(true)],
    'the shells pill selected': [...agentBox, [sp('  ⏸ manual mode on · 1 shell · enter to view tasks')], ...LIST(false)],
  };
  const showing = (rows, opts = {}) => {
    const w = world({ ...opts });
    w.rows = () => [[sp('earlier output')], ...rows];
    return w;
  };

  test('(−) End on a screen with no mode line and no input box (registry busy, attn or idle): 409 mode-unknown and not one key, not even the Escape that would stop the viewed subagent', async () => {
    for (const [name, rows] of Object.entries(SCREENS)) {
      for (const state of ['busy', 'attn', 'idle']) {
        const w = showing(rows, { state });
        assert.equal(modeFromRows(w.rows()), 'unknown', `${name}: premise, no readable mode line`);
        assert.equal(readDraft({ rows: w.rows(), cursor: w.cursorIn(w.rows()), cols: 80 }), null, `${name}: premise, no readable input box`);
        assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'), `${name} / ${state}`);
        assert.deepEqual(w.sent, [], `${name} / ${state}`);
        assert.deepEqual(w.slept, [], `${name} / ${state}`);
      }
    }
  });

  test('(−) Stop on the same screens: 409 screen-unclear and not one key (the check that was already there)', async () => {
    for (const [name, rows] of Object.entries(SCREENS)) {
      const w = showing(rows, { state: 'busy' });
      assert.deepEqual(await w.control().stop('%2'), code(409, 'screen-unclear'), name);
      assert.deepEqual(w.sent, [], name);
    }
  });

  test('(+) End on a busy pane with a permission prompt still sends Escape first (the No path), where the subagent screens send nothing', async () => {
    const w = world({ prompt: true, state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') { w.prompt = false; w.state = 'idle'; } };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w).slice(0, 2), ['Escape', 'text:/'], 'the Escape answers the prompt, then the probe slash of /exit');
  });

  test('(+) End on an idle main view still types /exit and presses Enter', async () => {
    const w = world({ state: 'idle' });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
  });

  test('(+) the main view with its subagent list under the footer is still a readable screen: End types /exit as before', async () => {
    const w = world({ state: 'idle' });
    const base = w.rows;
    w.rows = () => [...base(), [], [sp('  ⏺ main')], [sp('  ◯ Explore  scan the repo  5s')]];
    assert.equal(modeFromRows(w.rows()), 'manual', 'premise');
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/', 'text:exit', 'Enter']);
  });
});

// 0.5.4 (AC, design sections 3 and 10.1 tests 20 to 30): the controller's autoCompact(pane), the typed /compact of a waiting session. It reuses typeCommand
// (End's and the commands' typing), so these tests cover what is new: the order of the checks, the second capture, the quiet-screen check right before
// Enter, the read-back, the key count and the lock. The existing End and runCommand tests above are the "unchanged" half (test 26).
describe('autoCompact (0.5.4, AC): the typed /compact of a waiting session', () => {
  const SPIN = '\u273b Thinking\u2026 (12s \u00b7 esc to interrupt)'; // Claude's running-turn row: a spinner glyph, a verb, an ellipsis, the interrupt hint
  const MENU = ['  /compact    Clear history but keep a summary', '  /config     Open config panel']; // Claude's slash menu (test/dialog.test.js shape)
  /** Claude takes the Enter: the box empties and the spinner shows. */
  const takes = (w) => {
    w.onKeys = (b) => { if (b.keys?.[0] === 'Enter') { w.box = [PLACEHOLDER_BOX]; w.spinner = SPIN; } };
    return w;
  };
  const refused = (error, keys = 0) => ({ status: 409, body: { error }, keys });

  test('(+) test 20: plain mode: / alone, compact, Enter, read back as a running turn: 200 sent true, keys 3; every capture and the registry read are fresh, none cached', async () => {
    const w = takes(world({}));
    assert.deepEqual(await w.control().autoCompact('%2'), { status: 200, body: { sent: true }, keys: 3 });
    assert.deepEqual(w.sent, [{ text: '/' }, { text: 'compact' }, { keys: ['Enter'] }]);
    assert.ok(w.captures.length >= 2 && w.captures.every((c) => c.o?.fresh === true));
    assert.ok(w.stateArgs.some((o) => o?.fresh === true), 'the registry read that skips its cache');
    assert.equal(w.cmdCalls, 0);
  });

  test('(+) test 27: the read-back also takes an emptied box without a spinner, and a spinner with the box still reading /compact', async () => {
    const empty = world({});
    empty.onKeys = (b) => { if (b.keys?.[0] === 'Enter') empty.box = [PLACEHOLDER_BOX]; };
    assert.deepEqual(await empty.control().autoCompact('%2'), { status: 200, body: { sent: true }, keys: 3 });
    const spin = world({});
    spin.onKeys = (b) => { if (b.keys?.[0] === 'Enter') spin.spinner = SPIN; };
    assert.deepEqual(await spin.control().autoCompact('%2'), { status: 200, body: { sent: true }, keys: 3 });
  });

  test('(+) test 21: vim normal mode that the pane remembers: i, /compact, Enter; the history search of an unseen vim: /, Escape, i, /compact, Enter', async () => {
    const known = takes(world({ vim: true, vimMode: 'normal' }));
    assert.deepEqual(await known.control().autoCompact('%2'), { status: 200, body: { sent: true }, keys: 3 });
    assert.deepEqual(keysOf(known), ['text:i', 'text:/compact', 'Enter']);
    const unseen = takes(world({ vim: true, vimMode: 'normal' }));
    assert.deepEqual(await unseen.control({ vimOf: () => false }).autoCompact('%2'), { status: 200, body: { sent: true }, keys: 5 });
    assert.deepEqual(keysOf(unseen), ['text:/', 'Escape', 'text:i', 'text:/compact', 'Enter']);
  });

  test('(\u2212) test 22: a prompt, the survey, its follow-up rows, a dialog, no readable footer, a running spinner, the interrupt hint: the 409 of the quiet check and not one key', async () => {
    const dialog = dialogWorld({ phase: 'ask' }).screen().rows;
    const cases = [
      ['a permission prompt', world({ prompt: true }), 'prompt-open'],
      ['the feedback survey', world({ survey: {} }), 'prompt-open'],
      ['the rows after a rating', world({ followUp: true }), 'prompt-open'],
      ['a question dialog', Object.assign(world({}), { rows: () => dialog }), 'prompt-open'],
      ['no mode line and no box', world({ box: null, mode: 'unknown' }), 'mode-unknown'],
      ['a spinner above the box', world({ spinner: SPIN }), 'busy'],
      ['the interrupt hint in the footer', world({ footerTail: ' \u00b7 esc to interrupt' }), 'busy'],
      ['a draft in the box (the box check of typeCommand)', world({ box: [`${PROMPT_CHAR} half-written note`] }), 'input-not-empty'],
      ['no input box on a readable footer', world({ box: null }), 'input-unreadable'],
    ];
    for (const [name, w, error] of cases) {
      assert.deepEqual(await w.control().autoCompact('%2'), refused(error), name);
      assert.deepEqual(w.sent, [], name);
    }
  });

  test('(\u2212) test 22 (QP interaction, design 11 item 9): a question step with a preview on screen, notes closed or open and Chat focused: the quiet check still refuses with prompt-open, not one key', async () => {
    const shown = (o, edit = () => {}) => { const d = dialogWorld({ tabs: [TAB.project, TAB.shape, TAB.size], i: 1, ...o }); edit(d); return d.screen().rows; };
    const screens = {
      'a preview step': shown({}),
      'the notes field open': shown({}, (d) => { d.tabs[1].noteOpen = true; }),
      'Chat focused': shown({ focus: 'chat' }),
    };
    for (const [name, rows] of Object.entries(screens)) {
      assert.equal(dialogOnScreen(rows), true, `${name}: the fixture is a dialog`);
      const w = Object.assign(world({}), { rows: () => rows });
      assert.deepEqual(await w.control().autoCompact('%2'), refused('prompt-open'), name);
      assert.deepEqual(w.sent, [], name);
    }
  });

  test('(\u2212) test 22: the registry says busy: 409 not-idle, not one key; and the lock is free again for the next try', async () => {
    const w = takes(world({ state: 'busy' }));
    const sc = w.control();
    assert.deepEqual(await sc.autoCompact('%2'), refused('not-idle'));
    assert.deepEqual(w.sent, []);
    w.state = 'idle';
    assert.equal((await sc.autoCompact('%2')).status, 200);
  });

  test('(\u2212) test 23: the cached registry read says idle but the fresh one says busy: 409 not-idle, not one key', async () => {
    const w = takes(world({}));
    w.stateFn = (n) => (n === 1 ? 'idle' : 'busy');
    assert.deepEqual(await w.control().autoCompact('%2'), refused('not-idle'));
    assert.deepEqual(w.sent, []);
    assert.equal(w.stateArgs[0], undefined, 'the first read may use the cache');
    assert.deepEqual(w.stateArgs[1], { fresh: true }, 'the second one skips it');
  });

  test('(\u2212) test 24: the second capture shows a prompt: 409 prompt-open, not one key (the first capture alone is not enough)', async () => {
    const w = takes(world({}));
    const prompt = world({ prompt: true }).rows();
    const base = w.rows;
    w.rows = () => (w.captures.length === 2 ? prompt : base());
    assert.deepEqual(await w.control().autoCompact('%2'), refused('prompt-open'));
    assert.deepEqual(w.sent, []);
    assert.equal(w.captures.length, 2);
  });

  test('(\u2212) test 24 (round 2, S2): the FIRST capture shows a draft or no readable box while the second is empty: the box codes of typeCommand, not one key, the second capture never taken', async () => {
    const bad = [
      ['a draft in the box', world({ box: [`${PROMPT_CHAR} half-written note`] }), 'input-not-empty'],
      ['a draft of two rows', world({ box: [`${PROMPT_CHAR} first row`, '  second row'] }), 'input-not-empty'],
      ['no input box on a readable footer', world({ box: null }), 'input-unreadable'],
    ];
    for (const [name, shown, error] of bad) {
      const w = takes(world({}));
      const first = shown.rows();
      const base = w.rows;
      w.rows = () => (w.captures.length === 1 ? first : base());
      assert.deepEqual(await w.control().autoCompact('%2'), refused(error), name);
      assert.deepEqual(w.sent, [], name);
      assert.equal(w.captures.length, 1, `${name}: the second capture is never taken`);
      assert.ok(!w.stateArgs.some((o) => o?.fresh === true), `${name}: and the fresh registry read does not run`);
    }
  });

  test('(+) test 24 (round 2, S2): both captures show an empty prompt-mode box: two captures and the fresh registry read before the first key, then the typing as before', async () => {
    const w = takes(world({}));
    const sc = w.control();
    const before = [];
    const send = w.keys.send;
    w.keys.send = async (pane, body) => { if (before.length === 0) before.push([w.captures.length, w.stateArgs.filter((o) => o?.fresh === true).length]); return send(pane, body); };
    assert.deepEqual(await sc.autoCompact('%2'), { status: 200, body: { sent: true }, keys: 3 });
    assert.deepEqual(before, [[2, 1]], 'before the first key: two captures and one fresh registry read');
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact', 'Enter']);
  });

  test('(\u2212) test 25: the echo matches but a spinner shows: no Enter, nika\'s own text is removed with C-u, 409 not-at-prompt', async () => {
    const w = takes(world({}));
    w.afterType = (b) => { if (b.text === 'compact') w.spinner = SPIN; }; // a turn begins right after the text shows
    assert.deepEqual(await w.control().autoCompact('%2'), refused('not-at-prompt', 3));
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact', 'C-u']);
    assert.deepEqual(w.box, [PLACEHOLDER_BOX], 'the fake box is empty again');
  });

  test('(+) test 25b: the echo with Claude\'s slash menu open (drawn above the box, the mode line stays) is a quiet screen: Enter goes', async () => {
    const w = takes(world({}));
    w.afterType = (b) => { if (b.text === 'compact') w.menu = MENU; };
    const onKeys = w.onKeys;
    w.onKeys = (b) => { onKeys(b); if (b.keys?.[0] === 'Enter') w.menu = null; };
    w.menu = MENU; // premise: the menu is no dialog, no prompt and no survey, and the footer still reads
    assert.equal(modeFromRows(w.rows()), 'manual');
    assert.equal(dialogOnScreen(w.rows()), false);
    assert.equal(readDraft({ rows: w.rows(), cursor: w.cursorIn(w.rows()) }).state, 'empty');
    w.menu = null;
    assert.deepEqual(await w.control().autoCompact('%2'), { status: 200, body: { sent: true }, keys: 3 });
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact', 'Enter']);
  });

  test('(\u2212) test 25b: the same menu with a spinner row above the box: no Enter; and a footer that stops reading while the menu is up is no echo either: no Enter, fail closed', async () => {
    const spin = takes(world({}));
    spin.afterType = (b) => { if (b.text === 'compact') { spin.menu = MENU; spin.spinner = SPIN; } };
    assert.deepEqual(await spin.control().autoCompact('%2'), refused('not-at-prompt', 3));
    assert.deepEqual(keysOf(spin), ['text:/', 'text:compact', 'C-u']);
    // the design assumed the menu replaces the footer and the box still reads; src/draft.js reads no box under an unknown footer, so there is no echo and no Enter
    const replaced = takes(world({}));
    replaced.afterType = (b) => { if (b.text === 'compact') replaced.mode = 'unknown'; };
    assert.deepEqual(await replaced.control().autoCompact('%2'), refused('not-at-prompt', 3));
    assert.deepEqual(keysOf(replaced), ['text:/', 'text:compact', 'C-u']);
  });

  test('(\u2212) test 27: the box still reads /compact after READBACK_TRIES reads: C-u removes it, 409 not-taken, keys 4', async () => {
    const w = world({}); // Claude never takes the Enter
    const slept = () => w.slept.filter((ms) => ms === READBACK_MS).length;
    assert.deepEqual(await w.control().autoCompact('%2'), refused('not-taken', 4));
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact', 'Enter', 'C-u']);
    assert.equal(slept(), READBACK_TRIES);
    assert.equal(READBACK_TRIES * READBACK_MS, 2000);
  });

  test('(\u2212) test 27: no readable box after the Enter: 409 not-confirmed, nothing removed; a capture that fails passes through', async () => {
    const gone = world({});
    gone.onKeys = (b) => { if (b.keys?.[0] === 'Enter') gone.box = null; };
    assert.deepEqual(await gone.control().autoCompact('%2'), refused('not-confirmed', 3));
    assert.deepEqual(keysOf(gone), ['text:/', 'text:compact', 'Enter']);
    const down = world({});
    down.onKeys = (b) => { if (b.keys?.[0] === 'Enter') down.captureFail = { status: 404, body: { error: 'not_found', message: 'gone' } }; };
    assert.deepEqual(await down.control().autoCompact('%2'), { status: 404, body: { error: 'not_found', message: 'gone' }, keys: 3 });
  });

  test('(\u2212) test 28: another action runs on the pane: 409 busy-switching and no key of its own', async () => {
    const w = takes(world({}));
    const release = hold(w);
    const sc = w.control();
    const running = sc.runCommand('%1', '/compact');
    await tick();
    assert.deepEqual(await sc.autoCompact('%1'), refused('busy-switching'));
    assert.deepEqual(w.sent, []);
    release();
    await running;
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact', 'Enter'], 'only the command\'s own keys');
  });

  test('(\u2212) test 28: a Stop\'s Escape went out less than 40 ms ago: 409 not-idle, not one key; after the gap it goes', async () => {
    const w = takes(world({ state: 'busy' }));
    const sc = w.control();
    assert.equal((await sc.stop('%2')).status, 200);
    w.state = 'idle';
    const reads = w.captures.length;
    assert.deepEqual(await sc.autoCompact('%2'), refused('not-idle'));
    assert.deepEqual(keysOf(w), ['Escape'], 'only the Stop');
    assert.equal(w.captures.length, reads, 'refused before the screen is read');
    w.t += 40;
    assert.equal((await sc.autoCompact('%2')).status, 200);
  });

  test('(\u2212) test 28: a Stop begins while the fresh registry state is read: 409 not-idle before the second capture; only the Stop\'s Escape went out (and it counts)', async () => {
    const w = takes(world({}));
    const sc = w.control();
    let stopped = false;
    w.stateFn = async (n) => {
      if (n === 2 && !stopped) { // the fresh read of autoCompact: a Stop runs meanwhile
        stopped = true;
        w.state = 'busy';
        assert.equal((await sc.stop('%2')).status, 200);
        w.state = 'idle';
        return 'idle';
      }
      return w.state;
    };
    assert.deepEqual(await sc.autoCompact('%2'), refused('not-idle', 1));
    assert.deepEqual(keysOf(w), ['Escape']);
  });

  test('(\u2212) test 29: a rating\'s undo row is up: the history search of an unseen vim cannot be closed, the Escape is refused (409 survey-undo), keys 1', async () => {
    const w = world({ survey: {} });
    const sc = w.control({ vimOf: () => false });
    const rows = w.rows();
    const sig = surveyOf({ rows, cursor: w.cursorIn(rows) }, { vim: false, insert: false }).sig;
    assert.equal((await sc.answerSurvey('%2', { n: 1, sig })).status, 200);
    w.vim = true;
    w.vimMode = 'normal'; // the pane turns out to be vim, in NORMAL: `/` opens the history search
    w.t += 100;
    w.sent.length = 0;
    assert.deepEqual(await sc.autoCompact('%2'), refused('survey-undo', 1));
    assert.deepEqual(keysOf(w), ['text:/']);
    assert.equal(w.history, true, 'the search stays open until the hold ends: nika sends no Escape');
  });

  test('(+) test 30: keys counts each request handed to the sender, also a refused one (a 429), but not a survey-undo refusal', async () => {
    const w = world({});
    w.failSend = (b) => (b.text === 'compact' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    // the refused `compact` counts (it was handed to the sender), and the probe's slash is removed with one C-u
    assert.deepEqual(await w.control().autoCompact('%2'), { status: 429, body: { error: 'busy', message: 'slow' }, keys: 3 });
    assert.deepEqual(keysOf(w), ['text:/', 'text:compact', 'C-u']);
    const again = takes(world({}));
    const sc = again.control();
    assert.equal((await sc.autoCompact('%2')).keys, 3);
    again.spinner = null;
    again.box = [PLACEHOLDER_BOX];
    assert.equal((await sc.autoCompact('%2')).keys, 3, 'the count is per attempt, not a running total');
  });
});
