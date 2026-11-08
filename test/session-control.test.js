import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl, promptSig } from '../src/session-control.js';
import { promptFromRows } from '../src/mode.js';

// Synthetic screens only. The phrases follow docs/contracts/claude-tui.md sections 1, 2 and 5; symbols are escapes.
const DEF = { b: false, fg: null, bg: null, u: false, i: false, d: false };
const rowsOf = (...lines) => lines.map((l) => (l === '' ? [] : [{ t: l, s: DEF }]));
const RULE = '─'.repeat(40);
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
const EMPTY_BOX = PROMPT_CHAR;
const PLACEHOLDER_BOX = `${PROMPT_CHAR} Try "edit a file to..."`;

/**
 * A fake pane: it renders an input box between two rule rows and a footer (or a permission prompt) from its fields and
 * reacts to the keys the controller sends. `box` is the rows between the rules (null = no box on screen); `vim` turns
 * on vim input mode (`vimMode` insert shows the `-- INSERT --` prefix, normal shows none, Escape switches to normal and
 * the text `i` back unless `insertWorks` is false); `swallow` drops typed text; `afterType(body)` may change the box
 * after text was typed. `typeLag` / `insertLag` make that many captures after the typed text / the `i` still show the old
 * box / no INSERT prefix (Claude redraws a few hundred ms later). `script` replaces the mode cycle after each BTab (the last entry repeats); `lag` makes the first
 * n captures after a press read `unknown`. The clock only moves when the controller sleeps.
 */
function world(opts = {}) {
  const w = {
    mode: 'manual', state: 'idle', prompt: false, question: 'Do you want to proceed?', options: OPTIONS,
    cycle: CYCLE, script: null, lag: 0, lagLeft: 0, cmd: 'claude', cmdAfter: 'zsh', exitAfter: 1000, enterAt: null,
    t: 1_000_000, slept: [], sent: [], captures: [], stateCalls: 0, cmdCalls: 0, presses: 0, hold: null,
    captureFail: null, captureFailOn: null, failSend: null, stateOf: null, onKeys: null,
    box: [EMPTY_BOX], vim: false, vimMode: 'insert', insertWorks: true, swallow: false, afterType: null,
    typeLag: 0, boxStale: null, insertLag: 0, insertLeft: 0,
    ...opts,
  };
  w.rows = () => {
    if (w.prompt) {
      return rowsOf('Bash command', 'run the thing', '', w.question,
        ...w.options.flatMap((o, i) => {
          const [first, ...wrapped] = [].concat(o); // an array is one label wrapped over several rows
          return [`${i === 0 ? PROMPT_CHAR : ' '} ${i + 1}. ${first}`, ...wrapped.map((r) => `      ${r}`)];
        }), 'Esc to cancel · Tab to amend');
    }
    const shown = w.lagLeft > 0 ? 'unknown' : w.mode;
    const line = `${w.vim && w.vimMode === 'insert' && w.insertLeft <= 0 ? '-- INSERT -- ' : ''}${PHRASE[shown]}`;
    const shownBox = w.boxStale?.left > 0 ? w.boxStale.box : w.box;
    const box = shownBox === null ? [] : ['', RULE, ...shownBox, RULE];
    return rowsOf('earlier output', ...box, line);
  };
  w.mirror = {
    async capture(pane, inm, o) {
      w.captures.push({ pane, o });
      if (pane === '%1' && w.hold) await w.hold;
      if (w.captureFail || w.captureFailOn === w.captures.length) return w.captureFail ?? { status: 404, body: { error: 'not_found', message: 'gone' } };
      const res = { status: 200, body: { rows: w.rows() } };
      if (w.lagLeft > 0) w.lagLeft -= 1;
      if (w.boxStale?.left > 0) w.boxStale.left -= 1;
      if (w.insertLeft > 0) w.insertLeft -= 1;
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
      if (key === 'Escape' && w.vim) w.vimMode = 'normal';
      if (key === 'C-u' && w.box) { w.box[w.box.length - 1] = w.box.length === 1 ? EMPTY_BOX : ''; w.boxStale = null; }
      if (body.text !== undefined) {
        if (w.vim && w.vimMode === 'normal') { // vim commands, not text
          if (body.text === 'i' && w.insertWorks) { w.vimMode = 'insert'; w.insertLeft = w.insertLag; }
        } else if (!w.swallow && w.box) {
          const before = [...w.box];
          const last = w.box.at(-1);
          w.box[w.box.length - 1] = last === EMPTY_BOX || last.startsWith(`${PROMPT_CHAR} Try `) ? `${PROMPT_CHAR} ${body.text}` : last + body.text;
          w.afterType?.(body);
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
  w.stateOf = async () => {
    w.stateCalls += 1;
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
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'not-idle'));
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
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'not-idle'));
    assert.deepEqual(w.sent, [{ keys: ['BTab'] }]);
  });

  test('(−) returns to the start mode without the target: 409 not-in-cycle', async () => {
    const w = world({ mode: 'manual', script: ['acceptEdits', 'manual'] });
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), code(409, 'not-in-cycle'));
    assert.equal(w.sent.length, 2);
  });

  test('(−) the footer goes unknown mid-cycle: 409 mode-unknown after that press, nothing more sent', async () => {
    const w = world({ mode: 'manual', script: ['acceptEdits', 'unknown'] });
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), code(409, 'mode-unknown'));
    assert.equal(w.sent.length, 2);
    assert.ok(w.slept.filter((ms) => ms === 300).length >= 6, 'polled up to settleMs');
  });

  test('(−) the mode does not change within settleMs: 409 mode-unknown after one press', async () => {
    const w = world({ mode: 'manual', script: ['manual'] });
    assert.deepEqual(await w.control().switchMode('%2', 'plan'), code(409, 'mode-unknown'));
    assert.equal(w.sent.length, 1);
    assert.equal(w.slept.reduce((a, b) => a + b, 0), 1800, 'waited exactly settleMs');
  });

  test('(−) a cycle that never reaches the target stops after 6 presses with 409 not-in-cycle', async () => {
    const w = world({ mode: 'manual', script: ['acceptEdits', 'plan', 'bypassPermissions', 'acceptEdits', 'plan', 'bypassPermissions', 'acceptEdits'] });
    assert.deepEqual(await w.control().switchMode('%2', 'auto'), code(409, 'not-in-cycle'));
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
    assert.deepEqual(r, code(409, 'mode-unknown'));
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
    assert.deepEqual(r, code(409, 'mode-unknown'));
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
    assert.deepEqual(keysOf(w), ['text:/exit', 'Enter']);
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

  test('(−) an option whose label contains bypass (any case) is 400 invalid; the other options still work', async () => {
    const w = world({ prompt: true, options: ['Yes', 'Yes, and switch to BypassPermissions mode', 'No'] });
    const sig = sigOf(w);
    const sc = w.control();
    const r = await sc.answer('%2', { n: 2, sig });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid');
    assert.deepEqual(w.sent, []);
    assert.deepEqual(await sc.answer('%2', { n: 3, sig }), { status: 200, body: { answered: 3 } });
    w.options = ['Yes', 'Yes, with bypass on', 'No'];
    assert.equal((await sc.answer('%2', { n: 2, sig: sigOf(w) })).status, 400);
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
    assert.deepEqual(await sc.answer('%2', { n: 4, sig }), { status: 200, body: { answered: 4 } }, 'a clean option next to them works');
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
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 200, 'a clean option still works');
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
  test('(+) idle with an empty box: text /exit, the capture shows the box reading "/exit", then Enter; pane becomes zsh: ended true', async () => {
    const w = world({ mode: 'manual' });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(w.sent, [{ text: '/exit' }, { keys: ['Enter'] }]);
    assert.equal(w.captures.length >= 2, true);
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
    assert.equal(w.stateCalls, 1, 'no Escape, so the state is read once');
    assert.deepEqual(w.slept, [150, 500, 500], 'one settle wait before the check after typing, no escape wait, then two exit checks');
  });

  test('(+) the placeholder counts as an empty box', async () => {
    const w = world({ box: [PLACEHOLDER_BOX] });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:/exit', 'Enter']);
  });

  test('(+) busy: Escape first, one escWaitMs wait, state and screen read again, then the same sequence', async () => {
    const w = world({ state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'text:/exit', 'Enter']);
    assert.equal(w.slept[0], 1000);
    assert.equal(w.stateCalls, 2, 'the registry state is read again after Escape');
  });

  test('(+) a prompt that Escape cancels: then the sequence runs', async () => {
    const w = world({ prompt: true, state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') { w.prompt = false; w.state = 'idle'; } };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'text:/exit', 'Enter']);
  });

  test('(+) vim normal mode (vimOf true, no INSERT prefix): text i first, then /exit, then Enter', async () => {
    const w = world({ vim: true, vimMode: 'normal' });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['text:i', 'text:/exit', 'Enter']);
  });

  test('(+) vim insert mode already (the mode line shows INSERT): no i', async () => {
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
    assert.deepEqual(await w.control({ pollMs: 100, settleMs: 250 }).switchMode('%2', 'plan'), code(409, 'mode-unknown'));
    assert.deepEqual(w.slept, [100, 100, 100], 'ceil(250 / 100) reads');
    const w2 = world({ mode: 'manual', script: ['acceptEdits', 'plan', 'acceptEdits', 'plan'] });
    assert.deepEqual(await w2.control({ maxPresses: 2 }).switchMode('%2', 'auto'), code(409, 'not-in-cycle'));
    assert.equal(w2.sent.length, 2);
    const w3 = world({ state: 'busy', exitAfter: Infinity });
    w3.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w3.state = 'idle'; };
    await w3.control({ escWaitMs: 50, exitWaitMs: 1000 }).endSession('%2');
    assert.equal(w3.slept[0], 50);
    assert.equal(w3.slept[1], 150, 'then the settle wait after typing');
    assert.equal(w3.slept.slice(2).reduce((a, b) => a + b, 0), 1000);
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

  test('(−) no input box found (no rule rows, or nothing between them): 409 input-not-empty, nothing typed', async () => {
    for (const box of [null, []]) {
      const w = world({ box });
      assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-not-empty'), String(box));
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a rule-like row that is not only rule characters does not make a box', async () => {
    const w = world({ box: [EMPTY_BOX] });
    const base = w.rows;
    w.rows = () => rowsOf('earlier output', 'x'.repeat(5), `${RULE} x`, EMPTY_BOX, `${RULE} x`, PHRASE.manual);
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'input-not-empty'));
    assert.deepEqual(w.sent, []);
    w.rows = base;
  });

  test('(−) the box does not read exactly "/exit" after typing: C-u sent, 409 not-at-prompt, no Enter', async () => {
    const swallowed = world({ swallow: true });
    assert.deepEqual(await swallowed.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(swallowed), ['text:/exit', 'C-u']);
    const extraRow = world({ afterType: () => { extraRow.box = [`${PROMPT_CHAR} /exit`, '  more']; } });
    assert.deepEqual(await extraRow.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(extraRow), ['text:/exit', 'C-u']);
    const extraText = world({ afterType: () => { extraText.box = [`${PROMPT_CHAR} /exit now`]; } });
    assert.deepEqual(await extraText.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.ok(!keysOf(extraText).includes('Enter'));
  });

  test('(−) a failed capture after typing: C-u is tried, the sequence stops, the pane is checked once', async () => {
    const w = world({ captureFailOn: 2 }); // 1st capture: before typing, 2nd: the check after typing
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['text:/exit', 'C-u']);
    assert.equal(w.cmdCalls, 1);
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
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['text:i']);
    const cap = world({ vim: true, vimMode: 'normal', captureFailOn: 2 });
    assert.deepEqual(await cap.control().endSession('%2'), { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(cap), ['text:i']);
  });

  test('(−) without vimOf a missing INSERT prefix is not vim: no i is typed', async () => {
    const w = world({ vim: false, vimMode: 'normal' });
    assert.deepEqual((await w.control().endSession('%2')).body, { ended: true });
    assert.deepEqual(keysOf(w), ['text:/exit', 'Enter']);
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

  test('(−) no live session (state null): treated as not idle, so Escape first, then still not idle', async () => {
    const w = world({});
    w.stateOf = async () => null;
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'));
    assert.deepEqual(keysOf(w), ['Escape']);
  });

  test('(−) claude still running after exitWaitMs: ended false (checked every 500 ms, six checks, not forever)', async () => {
    const w = world({ exitAfter: Infinity });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['text:/exit', 'Enter']);
    assert.deepEqual(w.slept, [150, 500, 500, 500, 500, 500, 500]);
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
    w.failSend = (body) => (body.text === '/exit' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['text:/exit'], 'Enter is never sent');
    assert.equal(w.cmdCalls, 1);
  });

  test('(−) keys.send returns 429 on Enter: sequence stopped, paneCommand checked once, ended false', async () => {
    const w = world({ exitAfter: Infinity });
    w.failSend = (body) => (body.keys?.[0] === 'Enter' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['text:/exit', 'Enter']);
    assert.equal(w.cmdCalls, 1);
  });

  test('(−) a failed Escape stops the sequence like any failed send', async () => {
    const w = world({ state: 'busy' });
    w.failSend = () => ({ status: 429, body: { error: 'busy', message: 'slow' } });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: false } });
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

describe('runCommand', () => {
  test('(+) /compact on an empty box: text, verified on screen, Enter: 200 sent true; no Escape, no wait, no pane check', async () => {
    const w = world({});
    const r = await w.control().runCommand('%2', '/compact');
    assert.deepEqual(r, { status: 200, body: { sent: true } });
    assert.deepEqual(w.sent, [{ text: '/compact' }, { keys: ['Enter'] }]);
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
    assert.deepEqual(w.slept, [150], 'only the settle wait before the check after typing');
    assert.equal(w.cmdCalls, 0);
  });

  test('(+) a command with arguments and the placeholder box', async () => {
    const w = world({ box: [PLACEHOLDER_BOX] });
    const r = await w.control().runCommand('%2', '/model sonnet');
    assert.deepEqual(r, { status: 200, body: { sent: true } });
    assert.deepEqual(w.sent, [{ text: '/model sonnet' }, { keys: ['Enter'] }]);
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

  test('(−) a draft in the box (one row or two) or no box: 409 input-not-empty, nothing sent', async () => {
    for (const box of [[`${PROMPT_CHAR} draft`], [`${PROMPT_CHAR} one`, '  two'], null]) {
      const w = world({ box });
      assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'input-not-empty'), JSON.stringify(box));
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a text that wraps onto a second row fails the exact check: C-u, 409 not-at-prompt, no Enter', async () => {
    const w = world({ afterType: () => { w.box = [`${PROMPT_CHAR} /model aaaa`, '  bbbb']; } });
    assert.deepEqual(await w.control().runCommand('%2', '/model aaaabbbb'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/model aaaabbbb', 'C-u']);
  });

  test('(−) typed text that never shows: C-u, 409 not-at-prompt, no Enter', async () => {
    const w = world({ swallow: true });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/compact', 'C-u']);
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
    assert.deepEqual(keysOf(onText), ['text:/compact']);
    const onEnter = world({});
    onEnter.failSend = (b) => (b.keys?.[0] === 'Enter' ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await onEnter.control().runCommand('%2', '/compact'), { status: 502, body: { error: 'tmux_failed', message: 'x' } });
    assert.deepEqual(keysOf(onEnter), ['text:/compact', 'Enter']);
  });

  test('(−) a failed capture passes its status through: before typing nothing is sent, after typing C-u is tried', async () => {
    const before = world({ captureFail: { status: 404, body: { error: 'not_found', message: 'gone' } } });
    assert.deepEqual(await before.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(before.sent, []);
    const after = world({ captureFailOn: 2 });
    assert.deepEqual(await after.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(keysOf(after), ['text:/compact', 'C-u']);
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
    assert.deepEqual(keysOf(w), ['text:/exit', 'Enter']);
    assert.equal(w.sent.filter((b) => b.keys?.[0] === 'Enter').length, 1);
    assert.equal(w.captures.length, 1 + 3, 'the first read plus three reads after typing, none after Enter');
    assert.deepEqual(w.slept.slice(0, 3), [150, 150, 150], 'one settle wait before each read');
  });

  test('(+) a command settles the same way: the box shows it on the 2nd read', async () => {
    const w = world({ typeLag: 1 });
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 200, body: { sent: true } });
    assert.deepEqual(keysOf(w), ['text:/compact', 'Enter']);
    assert.deepEqual(w.slept, [150, 150]);
  });

  test('(−) the box never matches within settleTries: exactly settleTries reads, then C-u, 409 not-at-prompt, no Enter', async () => {
    const w = world({ typeLag: 99 });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(w), ['text:/exit', 'C-u']);
    assert.equal(w.captures.length, 1 + 4, 'default settleTries is 4');
    assert.deepEqual(w.slept, [150, 150, 150, 150]);
    const c = world({ typeLag: 99 });
    assert.deepEqual(await c.control().runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.deepEqual(keysOf(c), ['text:/compact', 'C-u']);
    assert.equal(c.captures.length, 1 + 4);
  });

  test('(−) the wrong text on every read (a draft row appears) still ends in C-u, not-at-prompt after settleTries reads', async () => {
    const w = world({ afterType: () => { w.box = [`${PROMPT_CHAR} /exit`, '  more']; } });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-at-prompt'));
    assert.equal(w.captures.length, 1 + 4);
    assert.ok(!keysOf(w).includes('Enter'));
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

  test('(−) a failed capture inside the loop ends it: C-u is tried, the failure is passed on, nothing more is read', async () => {
    const w = world({ typeLag: 99, captureFailOn: 3 }); // 1st: before typing, 2nd: first try after typing, 3rd: second try fails
    assert.deepEqual(await w.control().runCommand('%2', '/compact'), { status: 404, body: { error: 'not_found', message: 'gone' } });
    assert.deepEqual(keysOf(w), ['text:/compact', 'C-u']);
    assert.equal(w.captures.length, 3);
    const e = world({ typeLag: 99, captureFailOn: 3 });
    assert.deepEqual(await e.control().endSession('%2'), { status: 200, body: { ended: false } });
    assert.equal(e.cmdCalls, 1);
  });

  test('(−) the loop is bounded by count: a frozen clock and a never-matching box still stop after settleTries reads', async () => {
    const w = world({ typeLag: 99 });
    assert.deepEqual(await w.control({ now: () => 0 }).runCommand('%2', '/compact'), code(409, 'not-at-prompt'));
    assert.equal(w.captures.length, 1 + 4);
  });

  test('(+) settleTries and settlePollMs are honoured (and at least one read always happens)', async () => {
    const w = world({ typeLag: 99 });
    await w.control({ settleTries: 2, settlePollMs: 40 }).runCommand('%2', '/compact');
    assert.deepEqual(w.slept, [40, 40]);
    assert.equal(w.captures.length, 1 + 2);
    const one = world({});
    assert.equal((await one.control({ settleTries: 0 }).runCommand('%2', '/compact')).status, 200, 'a bad count still reads once');
    assert.equal(one.captures.length, 1 + 1);
  });
});
