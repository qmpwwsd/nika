import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl, promptSig } from '../src/session-control.js';
import { promptFromRows } from '../src/mode.js';

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
 * lower rule and the mode line (a user status line), `footerTail` the text after the mode phrase.
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
    topRule: RULE, below: [], footerTail: '',
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
    const box = shownBox === null ? [] : ['', w.topRule, ...shownBox.map(toRow), RULE, ...w.below];
    return rowsOf('earlier output', ...box, line);
  };
  w.mirror = {
    async capture(pane, inm, o) {
      w.captures.push({ pane, o });
      if (pane === '%1' && w.hold) await w.hold;
      if (w.captureFail || w.captureFailOn === w.captures.length || (w.captureFailFrom !== null && w.captures.length >= w.captureFailFrom)) return w.captureFail ?? { status: 404, body: { error: 'not_found', message: 'gone' } };
      const res = { status: 200, body: { rows: w.rows() } };
      if (w.lagLeft > 0) w.lagLeft -= 1;
      if (w.boxStale?.left > 0) w.boxStale.left -= 1;
      if (w.insertLeft > 0) w.insertLeft -= 1;
      if (w.escLeft > 0) w.escLeft -= 1;
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

  test('(+) an empty box in other shapes: plain space, prompt character alone, whitespace-only non-dim spans', async () => {
    const boxes = [
      [[sp(`${PROMPT_CHAR} `), sp('Try "x"', true)]],
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

  test('(−) an unknown footer after Escape: 409 mode-unknown, nothing typed', async () => {
    const w = world({ state: 'busy', mode: 'unknown' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['Escape']);
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

  test('(+) the separator may be a plain space or a no-break space', async () => {
    for (const sep of [' ', NB]) {
      const w = world({ afterType: () => { w.box = [[sp(`${PROMPT_CHAR}${sep}`), sp('/exit')]]; } });
      assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    }
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
