import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl, promptSig } from '../src/session-control.js';
import { promptFromRows } from '../src/mode.js';

// Synthetic screens only. The phrases follow docs/contracts/claude-tui.md section 1 and 2; symbols are escapes.
const DEF = { b: false, fg: null, bg: null, u: false, i: false, d: false };
const rowsOf = (...lines) => lines.map((l) => (l === '' ? [] : [{ t: l, s: DEF }]));
const BOX = ['', '│ > │', '╰──────╯'];
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

/**
 * A fake pane: it renders a footer (or a permission prompt) from its fields and reacts to the keys the controller sends.
 * `script` replaces the cycle after each BTab (the last entry repeats); `lag` makes the first n captures after a press
 * read `unknown`. The clock only moves when the controller sleeps.
 */
function world(opts = {}) {
  const w = {
    mode: 'manual', state: 'idle', prompt: false, question: 'Do you want to proceed?', options: OPTIONS,
    cycle: CYCLE, script: null, lag: 0, lagLeft: 0, cmd: 'claude', cmdAfter: 'zsh', exitAfter: 1000, enterAt: null,
    t: 1_000_000, slept: [], sent: [], captures: [], stateCalls: 0, cmdCalls: 0, presses: 0, hold: null,
    captureFail: null, failSend: null, stateOf: null, onKeys: null,
    ...opts,
  };
  w.rows = () => {
    if (w.prompt) {
      return rowsOf('Bash command', 'run the thing', '', w.question,
        ...w.options.map((o, i) => `${i === 0 ? '❯ ' : '  '}${i + 1}. ${o}`), 'Esc to cancel · Tab to amend');
    }
    const shown = w.lagLeft > 0 ? 'unknown' : w.mode;
    return rowsOf('earlier output', ...BOX, PHRASE[shown]);
  };
  w.mirror = {
    async capture(pane, inm, o) {
      w.captures.push({ pane, o });
      if (pane === '%1' && w.hold) await w.hold;
      if (w.captureFail) return w.captureFail;
      const res = { status: 200, body: { rows: w.rows() } };
      if (w.lagLeft > 0) w.lagLeft -= 1;
      return res;
    },
  };
  w.keys = {
    async send(pane, body) {
      w.sent.push(body);
      const failed = w.failSend?.(body, w.sent.length);
      if (failed) return failed;
      if (body.keys?.[0] === 'BTab') {
        const next = w.script ? w.script[Math.min(w.presses, w.script.length - 1)] : w.cycle[(w.cycle.indexOf(w.mode) + 1) % w.cycle.length];
        w.presses += 1;
        w.mode = next;
        w.lagLeft = w.lag;
        w.afterPress?.(w.presses);
      }
      if (body.keys?.[0] === 'Enter') w.enterAt ??= w.t;
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
  w.now = () => w.t;
  w.sleep = async (ms) => { w.t += ms; w.slept.push(ms); };
  w.control = (extra = {}) => createSessionControl({
    mirror: w.mirror, keys: w.keys, paneCommand: w.paneCommand, stateOf: w.stateOf, now: w.now, sleep: w.sleep, ...extra,
  });
  return w;
}

const code = (status, error) => ({ status, body: { error } });
const tick = () => new Promise((r) => setImmediate(r));
const keysOf = (w) => w.sent.map((b) => (b.keys ? b.keys.join('+') : `text:${b.text}`));

describe('promptSig', () => {
  const base = () => rowsOf('old', 'Bash command', 'run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel');

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
    let release;
    w.hold = new Promise((r) => { release = r; });
    const sc = w.control();
    const first = sc.switchMode('%1', 'plan');
    await tick();
    const other = await sc.switchMode('%2', 'acceptEdits');
    assert.equal(other.status, 200);
    release();
    await first;
  });

  test('(+) the lock is released after a failure, so the next action runs', async () => {
    const w = world({ mode: 'manual', state: 'busy' });
    const sc = w.control();
    assert.deepEqual(await sc.switchMode('%2', 'plan'), code(409, 'not-idle'));
    w.state = 'idle';
    assert.equal((await sc.switchMode('%2', 'plan')).status, 200);
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
    w.stateOf = () => 'idle'; // a plain (sync) lookup works too
    assert.equal((await w.control().switchMode('%2', 'acceptEdits')).status, 200);
    assert.equal(w.sent.length, 1);
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
    assert.deepEqual(w.slept.filter((ms) => ms === 300).length >= 6, true, 'polled up to settleMs');
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

  test('(−) a failed BTab send returns that send\'s status and body plus presses', async () => {
    const w = world({ mode: 'manual' });
    w.failSend = (body, n) => (n === 2 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null);
    const r = await w.control().switchMode('%2', 'auto');
    assert.deepEqual(r, { status: 429, body: { error: 'busy', message: 'slow down', presses: 2 } });
    assert.equal(w.sent.length, 2);
  });

  test('(−) second switch on the same pane while one runs: 409 busy-switching, nothing extra sent', async () => {
    const w = world({ mode: 'manual' });
    let release;
    w.hold = new Promise((r) => { release = r; });
    const sc = w.control();
    const running = sc.switchMode('%1', 'plan');
    await tick();
    assert.deepEqual(await sc.switchMode('%1', 'auto'), code(409, 'busy-switching'));
    assert.deepEqual(w.sent, []);
    release();
    assert.equal((await running).status, 200);
    assert.equal(w.sent.length, 2, 'only the running switch pressed');
  });

  test('(−) End or answer while a switch runs on that pane: 409 busy-switching, nothing sent', async () => {
    const w = world({ mode: 'manual' });
    let release;
    w.hold = new Promise((r) => { release = r; });
    const sc = w.control();
    const running = sc.switchMode('%1', 'plan');
    await tick();
    assert.deepEqual(await sc.endSession('%1'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.answer('%1', { n: 1, sig: '0123456789abcdef' }), code(409, 'busy-switching'));
    assert.deepEqual(w.sent, []);
    release();
    await running;
  });

  test('(−) a switch or answer while End runs on that pane: 409 busy-switching', async () => {
    const w = world({ mode: 'manual' });
    let release;
    w.hold = new Promise((r) => { release = r; });
    const sc = w.control();
    const ending = sc.endSession('%1');
    await tick();
    assert.deepEqual(await sc.switchMode('%1', 'plan'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.answer('%1', { n: 1, sig: '0123456789abcdef' }), code(409, 'busy-switching'));
    release();
    await ending;
    assert.deepEqual(keysOf(w), ['C-u', 'text:/exit', 'Enter']);
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

  test('(−) answer does not look at the registry state and presses no Enter', async () => {
    const w = world({ prompt: true, state: 'busy' }); // Claude is busy (waiting for the user) while it asks
    const r = await w.control().answer('%2', { n: 1, sig: sigOf(w) });
    assert.equal(r.status, 200);
    assert.equal(w.stateCalls, 0);
    assert.deepEqual(keysOf(w), ['text:1']);
  });
});

describe('endSession', () => {
  test('(+) idle: keys C-u, text /exit, keys Enter in that order; paneCommand becomes zsh: ended true', async () => {
    const w = world({ mode: 'manual' });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(w.sent, [{ keys: ['C-u'] }, { text: '/exit' }, { keys: ['Enter'] }]);
    assert.ok(w.captures.every((c) => c.o?.fresh === true));
  });

  test('(+) busy: Escape first, one escWaitMs wait, then the same sequence', async () => {
    const w = world({ state: 'busy' });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.state = 'idle'; };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'C-u', 'text:/exit', 'Enter']);
    assert.equal(w.slept[0], 1000);
  });

  test('(+) a prompt that Escape cancels: then the sequence runs', async () => {
    const w = world({ prompt: true });
    w.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w.prompt = false; };
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: true } });
    assert.deepEqual(keysOf(w), ['Escape', 'C-u', 'text:/exit', 'Enter']);
  });

  test('(−) a pane with a prompt: Escape is sent, nothing is typed while the prompt stays, 409 not-idle', async () => {
    const w = world({ prompt: true });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'not-idle'));
    assert.deepEqual(keysOf(w), ['Escape']);
  });

  test('(−) an unknown footer after Escape: 409 mode-unknown, nothing typed', async () => {
    const w = world({ state: 'busy', mode: 'unknown' });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(keysOf(w), ['Escape']);
  });

  test('(−) an unknown footer on an idle pane (a dialog): no Escape, nothing typed, 409 mode-unknown', async () => {
    const w = world({ mode: 'unknown' });
    assert.deepEqual(await w.control().endSession('%2'), code(409, 'mode-unknown'));
    assert.deepEqual(w.sent, []);
    assert.deepEqual(w.slept, []);
  });

  test('(−) no live session (state null): treated as not idle, so Escape first', async () => {
    const w = world({});
    w.stateOf = async () => null;
    const r = await w.control().endSession('%2');
    assert.equal(r.status, 200);
    assert.equal(keysOf(w)[0], 'Escape');
  });

  test('(+) pane gone: ended true', async () => {
    const w = world({ cmdAfter: null });
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
  });

  test('(−) claude still running after exitWaitMs: ended false (polled every 500 ms, not forever)', async () => {
    const w = world({ exitAfter: Infinity });
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['C-u', 'text:/exit', 'Enter']);
    assert.ok(w.slept.every((ms) => ms === 500));
    assert.equal(w.slept.reduce((a, b) => a + b, 0), 3000);
  });

  test('(−) the pane command fails CLAUDE_COMMAND (zsh) counts as ended; node and a version string do not', async () => {
    for (const [cmd, ended] of [['zsh', true], ['bash', true], ['node', false], ['claude', false], ['2.1.319', false]]) {
      const w = world({ cmdAfter: cmd, exitAfter: 0 });
      assert.deepEqual((await w.control().endSession('%2')).body, { ended }, cmd);
    }
  });

  test('(−) keys.send returns 429: sequence stopped, paneCommand checked once; claude still running: ended false', async () => {
    const w = world({ exitAfter: 0 }); // would have exited had Enter been sent
    w.failSend = (body) => (body.text === '/exit' ? { status: 429, body: { error: 'busy', message: 'slow' } } : null);
    const r = await w.control().endSession('%2');
    assert.deepEqual(r, { status: 200, body: { ended: false } });
    assert.deepEqual(keysOf(w), ['C-u', 'text:/exit'], 'Enter is never sent');
    assert.equal(w.cmdCalls, 1);
  });

  test('(+) keys.send fails but the pane is gone already: ended true', async () => {
    const w = world({ cmd: 'zsh' });
    w.failSend = (body, n) => (n === 1 ? { status: 404, body: { error: 'not_found' } } : null);
    assert.deepEqual(await w.control().endSession('%2'), { status: 200, body: { ended: true } });
    assert.equal(w.sent.length, 1);
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

  test('(−) the lock is released after End, so a second End runs', async () => {
    const w = world({ mode: 'unknown' });
    const sc = w.control();
    assert.equal((await sc.endSession('%2')).status, 409);
    w.mode = 'manual';
    assert.equal((await sc.endSession('%2')).status, 200);
  });

  test('(+) the options are honoured: pollMs, settleMs, maxPresses, escWaitMs, exitWaitMs, answerHoldMs', async () => {
    const w = world({ mode: 'manual', script: ['manual'] });
    assert.deepEqual(await w.control({ pollMs: 100, settleMs: 250 }).switchMode('%2', 'plan'), code(409, 'mode-unknown'));
    assert.deepEqual(w.slept, [100, 100, 100], 'reads at 100, 200, 300 ms: stops at the first read past settleMs');
    const w2 = world({ mode: 'manual', script: ['acceptEdits', 'plan', 'acceptEdits', 'plan'] });
    assert.deepEqual(await w2.control({ maxPresses: 2 }).switchMode('%2', 'auto'), code(409, 'not-in-cycle'));
    assert.equal(w2.sent.length, 2);
    const w3 = world({ state: 'busy', exitAfter: Infinity });
    w3.onKeys = (b) => { if (b.keys?.[0] === 'Escape') w3.state = 'idle'; };
    await w3.control({ escWaitMs: 50, exitWaitMs: 1000 }).endSession('%2');
    assert.equal(w3.slept[0], 50);
    assert.equal(w3.slept.slice(1).reduce((a, b) => a + b, 0), 1000);
    const w4 = world({ prompt: true });
    const sig = promptSig(w4.rows());
    const sc = w4.control({ answerHoldMs: 10 });
    await sc.answer('%2', { n: 1, sig });
    w4.t += 10;
    assert.equal((await sc.answer('%2', { n: 1, sig })).status, 200);
  });
});
