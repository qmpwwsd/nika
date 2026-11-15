// The page side of the fit (design W7, sections 5, 8 and 9; docs/contracts/api-app.md, PUT and DELETE /api/app/pane/:id/fit):
// public/fit-ui.js has no DOM and makes no request of its own. The planner runs against a manual clock and a fake route whose
// answers the test gives one by one, so every timing rule (250 ms debounce, 5 s heartbeat, one request in flight, latest wins)
// is asserted exactly. Fixtures are synthetic.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { panelSize, scaleFor, chipView, fitPanelView, stillOffSay, createFitPlanner, BEAT_MS, DEBOUNCE_MS, SCALE_MIN } from '../public/fit-ui.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DOT = '·';
const readSrc = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe('panelSize: the panel in cells (design 8.1)', () => {
  // cell 8 x 18 px; the terminal box has 12 px padding left and right and 10 px top and bottom
  const cell = { cellW: 8, cellH: 18 };

  test('(+) the padding (24 x 20 px) is subtracted, then the cells are floored', () => {
    assert.deepEqual(panelSize({ width: 24 + 8 * 100 + 7, height: 20 + 18 * 30 + 17, ...cell }), { cols: 100, rows: 30 });
    assert.deepEqual(panelSize({ width: 24 + 8 * 100 - 1, height: 20 + 18 * 30 - 1, ...cell }), { cols: 99, rows: 29 }, 'one pixel short is one cell less');
  });

  test('(+) the answer is clamped to 40-400 columns and 10-200 rows, the route\'s range', () => {
    assert.deepEqual(panelSize({ width: 24 + 8 * 10, height: 20 + 18 * 3, ...cell }), { cols: 40, rows: 10 });
    assert.deepEqual(panelSize({ width: 24 + 8 * 40, height: 20 + 18 * 10, ...cell }), { cols: 40, rows: 10 }, 'the minimum itself');
    assert.deepEqual(panelSize({ width: 24 + 8 * 400, height: 20 + 18 * 200, ...cell }), { cols: 400, rows: 200 }, 'the maximum itself');
    assert.deepEqual(panelSize({ width: 24 + 8 * 900, height: 20 + 18 * 900, ...cell }), { cols: 400, rows: 200 });
  });

  test('(+) a box smaller than its own padding is the minimum, not a negative size', () => {
    assert.deepEqual(panelSize({ width: 10, height: 5, ...cell }), { cols: 40, rows: 10 });
  });

  test('(−) an unmeasured box or cell gives null, never a size: zero, negative, NaN, Infinity, a string, nothing', () => {
    for (const bad of [0, -8, NaN, Infinity, '8', null, undefined]) {
      assert.equal(panelSize({ width: 900, height: 600, cellW: bad, cellH: 18 }), null, `cellW ${bad}`);
      assert.equal(panelSize({ width: 900, height: 600, cellW: 8, cellH: bad }), null, `cellH ${bad}`);
      assert.equal(panelSize({ width: bad, height: 600, ...cell }), null, `width ${bad}`);
      assert.equal(panelSize({ width: 900, height: bad, ...cell }), null, `height ${bad}`);
    }
    assert.equal(panelSize({}), null);
  });
});

describe('scaleFor: the text scale (design 8.3)', () => {
  test('(+) a pane larger than the panel scales by the tighter axis', () => {
    assert.equal(scaleFor({ panelCols: 100, panelRows: 39, cols: 120, rows: 39 }), 100 / 120);
    assert.equal(scaleFor({ panelCols: 120, panelRows: 30, cols: 120, rows: 39 }), 30 / 39);
    assert.equal(scaleFor({ panelCols: 100, panelRows: 20, cols: 120, rows: 39 }), 20 / 39, 'rows are the tighter axis here');
  });

  test('(+) exactly 1 when the pane is the panel\'s size', () => {
    assert.equal(scaleFor({ panelCols: 120, panelRows: 39, cols: 120, rows: 39 }), 1);
  });

  test('(+) the scale stops at SCALE_MIN (0.4); below it the page scrolls instead', () => {
    assert.equal(SCALE_MIN, 0.4);
    assert.equal(scaleFor({ panelCols: 40, panelRows: 10, cols: 400, rows: 200 }), 0.4);
    assert.equal(scaleFor({ panelCols: 48, panelRows: 50, cols: 120, rows: 40 }), 0.4, '48 / 120 is exactly 0.4');
    assert.equal(scaleFor({ panelCols: 47, panelRows: 50, cols: 120, rows: 40 }), 0.4);
  });

  test('(−) never above 1: a pane smaller than the panel keeps its normal size (owner answer Q2)', () => {
    assert.equal(scaleFor({ panelCols: 200, panelRows: 80, cols: 80, rows: 24 }), 1);
    assert.equal(scaleFor({ panelCols: 200, panelRows: 24, cols: 80, rows: 24 }), 1);
    assert.equal(scaleFor({ panelCols: 80, panelRows: 100, cols: 80, rows: 24 }), 1);
  });

  test('(−) a size that is missing or not a positive number leaves the text alone (1)', () => {
    for (const bad of [0, -1, NaN, Infinity, '120', null, undefined]) {
      assert.equal(scaleFor({ panelCols: bad, panelRows: 30, cols: 120, rows: 39 }), 1, `panelCols ${bad}`);
      assert.equal(scaleFor({ panelCols: 100, panelRows: bad, cols: 120, rows: 39 }), 1, `panelRows ${bad}`);
      assert.equal(scaleFor({ panelCols: 100, panelRows: 30, cols: bad, rows: 39 }), 1, `cols ${bad}`);
      assert.equal(scaleFor({ panelCols: 100, panelRows: 30, cols: 120, rows: bad }), 1, `rows ${bad}`);
    }
  });
});

describe('chipView: the chip from the PUT body (design 8.4, owner answer Q5, orchestrator ruling 1)', () => {
  const body = (state, reason = null) => ({ fit: { state, reason, pane: { cols: 120, rows: 39 }, panes: 3, userZoom: false } });
  const SIX = {
    'panel-smaller': 'Other panes in this tmux window would be squeezed, so nika zoomed the pane and scaled the text',
    'user-zoom': 'You zoomed another pane in this window; nika leaves it',
    'size-option': 'This tmux window has a window-size setting nika does not change',
    'foreign-tag': 'Another program marks this tmux window',
    changed: 'The tmux window changed while nika was fitting it, so nika put it back',
    'user-change': 'You changed this tmux window, so nika put it back', // F1: the panel's Fit again replaces "Reopen the session window"
  };

  test('(+) the four states each have their own state word, icon and text', () => {
    const v = {
      fitted: chipView(body('fitted')), zoomed: chipView(body('zoomed', 'panel-smaller')), blocked: chipView(body('blocked', 'user-zoom')), other: chipView(body('other')),
    };
    assert.deepEqual(Object.values(v).map((x) => [x.state, x.icon, x.text]), [
      ['fitted', 'fit', `Fit ${DOT} fills the panel`],
      ['zoomed', 'zoom', `Fit ${DOT} zoomed, text scaled`],
      ['blocked', 'off', `Fit ${DOT} off`],
      ['other', 'window', `Fit ${DOT} another window`],
    ]);
    for (const k of ['state', 'icon', 'text', 'key']) assert.equal(new Set(Object.values(v).map((x) => x[k])).size, 4, `four states, four different ${k}`);
  });

  test('(+) each of the six reasons gives its own title sentence (blocked for five of them, zoomed for panel-smaller)', () => {
    for (const [reason, title] of Object.entries(SIX)) {
      const v = chipView(body(reason === 'panel-smaller' ? 'zoomed' : 'blocked', reason));
      assert.equal(v.title, title, reason);
      assert.ok(v.say.endsWith(title), `${reason}: the announcement carries the sentence`);
      assert.match(v.say, /^Fit: /);
    }
  });

  test('(+) fitted and other have a fixed title that says what happens to the tmux window', () => {
    assert.equal(chipView(body('other')).title, 'Another nika window shows a pane of this tmux window');
    assert.match(chipView(body('fitted')).title, /^nika sized the tmux window to this panel and puts it back when this window closes$/);
  });

  test('(+) the key tells one state from another, and one blocked reason from another; the pane\'s size does not matter', () => {
    const keys = ['fitted', 'zoomed', 'other'].map((s) => chipView(body(s)).key);
    for (const r of ['user-zoom', 'size-option', 'foreign-tag', 'changed', 'user-change']) keys.push(chipView(body('blocked', r)).key);
    assert.equal(new Set(keys).size, 8);
    const again = { fit: { state: 'fitted', reason: null, pane: { cols: 80, rows: 24 }, panes: 1, userZoom: true } };
    assert.equal(chipView(again).key, chipView(body('fitted')).key);
  });

  test('(−) zoomed always carries the panel-smaller sentence; fitted and other ignore a reason', () => {
    assert.equal(chipView(body('zoomed')).title, SIX['panel-smaller']);
    assert.equal(chipView(body('fitted', 'user-zoom')).title, chipView(body('fitted')).title);
    assert.equal(chipView(body('other', 'changed')).title, chipView(body('other')).title);
  });

  test('(−) blocked with no reason, or one nika does not know, is still "off" with a plain sentence', () => {
    for (const reason of [null, undefined, 'something-new', 42, {}, 'panel-smaller']) {
      const v = chipView({ fit: { state: 'blocked', reason } });
      assert.equal(v.text, `Fit ${DOT} off`);
      assert.equal(v.title, 'nika is not fitting this tmux window');
    }
  });

  test('(−) a body that is not a fit answer gives null: nothing, a wrong shape, an unknown state, "none" (the DELETE state)', () => {
    for (const bad of [undefined, null, 'fitted', 42, [], {}, { fit: null }, { fit: 'fitted' }, { fit: {} }, { fit: { state: 'none' } }, { fit: { state: 'bogus' } },
      { fit: { state: 7 } }, { fit: { state: {} } }, { fit: { state: ['fitted'] } }, { fit: { state: '__proto__' } }, { fit: { state: 'constructor' } }, { fit: { state: 'toString' } }]) {
      assert.equal(chipView(bad), null, JSON.stringify(bad));
    }
  });

  test('(−) no string of the server reaches the view: a hostile reason is looked up, never copied', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    for (const reason of [hostile, '__proto__', 'constructor', 'hasOwnProperty']) {
      const v = chipView({ fit: { state: 'blocked', reason, pane: { cols: hostile, rows: 1 }, panes: hostile } });
      assert.doesNotMatch(JSON.stringify(v), /img|onerror|__proto__|constructor|hasOwnProperty/, reason);
    }
  });

  // ---- F1 (design F12 section 2): the chip is a button; its name is the label, and the user-change title no longer sends the user away ----
  test('(+) F1: every view carries its label (the button\'s name and the panel\'s heading), and the announcement is label + title', () => {
    const labels = { fitted: 'Fit: fills the panel', zoomed: 'Fit: zoomed, text scaled', blocked: 'Fit: off', other: 'Fit: another window' };
    for (const [state, label] of Object.entries(labels)) {
      const v = chipView(body(state, state === 'zoomed' ? 'panel-smaller' : state === 'blocked' ? 'user-zoom' : null));
      assert.equal(v.label, label, state);
      assert.equal(v.say, `${label}. ${v.title}`, state);
    }
  });

  test('(+) F1: the user-change title says what happened and no longer tells the user to reopen the window', () => {
    assert.equal(chipView(body('blocked', 'user-change')).title, 'You changed this tmux window, so nika put it back');
  });

  test('(−) F1: no title, label or announcement still contains the "Reopen the session window" sentence', () => {
    for (const reason of [...Object.keys(SIX), null]) {
      const v = chipView(body(reason === 'panel-smaller' ? 'zoomed' : 'blocked', reason));
      assert.doesNotMatch(JSON.stringify(v), /reopen/i, String(reason));
    }
  });

  test('(+) every string in a view is plain ASCII (the middle dot is an escape in the source)', () => {
    const states = [body('fitted'), body('other'), ...Object.keys(SIX).map((r) => body(r === 'panel-smaller' ? 'zoomed' : 'blocked', r))];
    for (const b of states) {
      const v = chipView(b);
      assert.equal(typeof v.text, 'string');
      assert.equal(v.text.includes(DOT), true);
      for (const s of [v.title, v.say, v.icon, v.key, v.label]) assert.equal([...s].every((ch) => ch.codePointAt(0) < 128), true, s);
    }
  });
});

/** A manual clock with the after / cancel pair the planner takes: advance(ms) runs every timer due, in order, including the ones they arm. */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    after(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id) { timers.delete(id); },
    get pending() { return timers.size; },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

const OK = (state = 'fitted', reason = null) => ({ status: 200, body: { fit: { state, reason, pane: { cols: 120, rows: 39 }, panes: 3, userZoom: false } } });

/** A planner with a fake route: every body sent waits in `pending` until answer() gives its reply. */
function rig({ again = true } = {}) {
  const clk = clock();
  const log = { sent: [], released: 0, chips: [], again: [] };
  const pending = [];
  const io = {
    send: (b) => new Promise((resolve, reject) => { log.sent.push(b); pending.push({ resolve, reject }); }),
    release: () => { log.released += 1; return Promise.resolve({ status: 200, body: { released: true } }); },
    after: clk.after,
    cancel: clk.cancel,
    chip: (v) => log.chips.push(v),
  };
  if (again) io.fitAgain = (e) => log.again.push(e); // F1: the optional sink for the user's Fit again; a rig without it proves it is optional
  const planner = createFitPlanner(io);
  return {
    planner, clk, log,
    get inFlight() { return pending.length; },
    async answer(reply) { pending.shift().resolve(reply); await flush(); },
    async fail(error = new Error('network down')) { pending.shift().reject(error); await flush(); },
  };
}

describe('createFitPlanner: when a request goes out (design 8.2)', () => {
  test('(+) nothing is sent before start, however the panel changes', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.size(110, 31);
    await r.clk.advance(60000);
    assert.deepEqual(r.log.sent, []);
  });

  test('(+) the first request is open: true and goes out at start at once, not after the debounce', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true }]);
  });

  test('(+) later requests are open: false', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.size(110, 30);
    await r.clk.advance(DEBOUNCE_MS);
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true }, { cols: 110, rows: 30, open: false }]);
  });

  test('(+) a start before any measure waits for the first size, then asks at once', async () => {
    const r = rig();
    r.planner.start();
    assert.deepEqual(r.log.sent, []);
    r.planner.size(100, 30);
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true }]);
  });

  test('(+) a burst of sizes is debounced 250 ms: one request, the last size', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.size(101, 30);
    await r.clk.advance(100);
    r.planner.size(102, 30);
    await r.clk.advance(100);
    r.planner.size(103, 31);
    await r.clk.advance(DEBOUNCE_MS - 1);
    assert.equal(r.log.sent.length, 1, '249 ms after the last size nothing has gone out');
    await r.clk.advance(1);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 103, rows: 31, open: false }]);
  });

  test('(+) a size equal to the last answered one sends nothing (skip unchanged)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.size(100, 30);
    await r.clk.advance(DEBOUNCE_MS * 2);
    assert.equal(r.log.sent.length, 1);
    r.planner.size(100, 31);
    r.planner.size(100, 30); // back to the answered size before the debounce ends
    await r.clk.advance(DEBOUNCE_MS);
    assert.equal(r.log.sent.length, 1, 'a change that was undone is not sent');
  });

  test('(+) one request in flight, the latest size wins: sizes that arrive meanwhile become one request after the answer', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    r.planner.size(101, 30);
    r.planner.size(102, 30);
    await r.clk.advance(DEBOUNCE_MS * 4);
    assert.equal(r.log.sent.length, 1, 'still the first request: nothing overtakes it');
    assert.equal(r.inFlight, 1);
    await r.answer(OK());
    await r.clk.advance(DEBOUNCE_MS);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 102, rows: 30, open: false }]);
    assert.equal(r.inFlight, 1);
  });

  test('(+) the heartbeat is every 5 s with the current size, open: false, even when the size did not change', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    assert.equal(BEAT_MS, 5000);
    await r.clk.advance(BEAT_MS - 1);
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false }]);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.slice(2), [{ cols: 100, rows: 30, open: false }]);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS * 3);
    assert.equal(r.log.sent.length, 4, 'three beats fall, one request goes out, and the two behind it are not stacked: one in flight at a time');
  });

  test('(+) a heartbeat that falls while a request is in flight adds none (the one in flight renews the lease)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.clk.advance(BEAT_MS * 2);
    assert.equal(r.log.sent.length, 1);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    assert.equal(r.log.sent.length, 2);
  });

  test('(+) beat() (the window shows again) sends one request now and moves the next heartbeat 5 s on', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    await r.clk.advance(3000);
    r.planner.beat();
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false }]);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS - 1);
    assert.equal(r.log.sent.length, 2);
    await r.clk.advance(1);
    assert.equal(r.log.sent.length, 3);
  });

  test('(−) beat() before start, or after close, sends nothing', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.beat();
    assert.equal(r.log.sent.length, 0);
    r.planner.start();
    await r.answer(OK());
    r.planner.close();
    r.planner.beat();
    assert.equal(r.log.sent.length, 1);
  });

  test('(−) a size outside 40-400 x 10-200, or not an integer, is never sent', async () => {
    const r = rig();
    r.planner.start();
    for (const [c, w] of [[39, 30], [401, 30], [100, 9], [100, 201], [100.5, 30], [100, 30.5], [NaN, 30], ['100', 30], [null, 30], [undefined, undefined], [0, 0], [-100, 30]]) {
      r.planner.size(c, w);
    }
    await r.clk.advance(BEAT_MS * 2);
    assert.deepEqual(r.log.sent, []);
    r.planner.size(40, 10);
    assert.deepEqual(r.log.sent, [{ cols: 40, rows: 10, open: true }], 'the smallest legal size goes');
  });

  test('(+) every body has exactly cols, rows and open (the route takes no other key)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    for (const b of r.log.sent) assert.deepEqual(Object.keys(b).sort(), ['cols', 'open', 'rows']);
  });
});

describe('createFitPlanner: what the answers do (design 8.5, 9; orchestrator ruling 2)', () => {
  test('(+) the chip is told nothing until an answer, then once per state change', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    assert.deepEqual(r.log.chips, [], 'hidden before the first answer');
    await r.answer(OK('fitted'));
    assert.deepEqual(r.log.chips.map((v) => v.key), ['fitted:']);
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('fitted'));
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('fitted'));
    assert.equal(r.log.chips.length, 1, 'the same state again is not told again');
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('zoomed', 'panel-smaller'));
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('blocked', 'user-zoom'));
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('blocked', 'changed'));
    assert.deepEqual(r.log.chips.map((v) => v.state), ['fitted', 'zoomed', 'blocked', 'blocked']);
    assert.deepEqual(r.log.chips.map((v) => v.key).slice(2), ['blocked:user-zoom', 'blocked:changed']);
  });

  test('(−) an answer that is not a fit answer (an older server, an odd body) leaves the chip as it was and still counts as answered', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 200, body: null });
    assert.deepEqual(r.log.chips, []);
    await r.clk.advance(BEAT_MS);
    assert.equal(r.log.sent[1].open, false, 'the 200 reached the server: open is not repeated');
  });

  test('(+) after blocked / user-change the next heartbeat still sends open: false, and open: true never comes again', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK('blocked', 'user-change'));
    for (let i = 0; i < 3; i += 1) {
      await r.clk.advance(BEAT_MS);
      await r.answer(OK('blocked', 'user-change'));
    }
    assert.equal(r.log.sent.length, 4);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, false, false, false]);
  });

  test('(+) after blocked / changed the heartbeats keep going with open: false', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK('blocked', 'changed'));
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('blocked', 'changed'));
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, false, false]);
  });

  test('(+) open: true is repeated until a 200 has answered it (a 409 or a lost request did not open anything)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 409, body: { error: 'busy' } });
    await r.clk.advance(BEAT_MS);
    await r.fail();
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, true, true]);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, true, true, false]);
  });

  test('(−) 409, 429, 502, 400 and a lost request are not retried before the next heartbeat, even when the panel changes meanwhile', async () => {
    for (const reply of [{ status: 409, body: { error: 'busy' } }, { status: 429, body: { error: 'busy' } }, { status: 502, body: { error: 'tmux_failed' } },
      { status: 400, body: { error: 'invalid' } }, { status: 404, body: { error: 'not_found' } }, { status: 0, body: null }]) {
      const r = rig();
      r.planner.size(100, 30);
      r.planner.start();
      await r.answer(reply);
      r.planner.size(110, 31);
      await r.clk.advance(DEBOUNCE_MS * 3);
      r.planner.size(120, 32);
      await r.clk.advance(BEAT_MS - DEBOUNCE_MS * 3 - 1);
      assert.equal(r.log.sent.length, 1, `status ${reply.status}: nothing before the heartbeat`);
      await r.clk.advance(1);
      assert.deepEqual(r.log.sent.slice(1), [{ cols: 120, rows: 32, open: true }], `status ${reply.status}: the heartbeat asks again with the latest size`);
    }
  });

  test('(−) a request that rejects is a lost request: no throw, no retry before the heartbeat', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.fail(new TypeError('network down'));
    await r.clk.advance(BEAT_MS - 1);
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(1);
    assert.equal(r.log.sent.length, 2);
    assert.deepEqual(r.log.chips, []);
  });

  test('(−) 403 stops everything: no heartbeat, no resize request, no release at close, no restart', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    r.planner.size(120, 40);
    r.planner.beat();
    await r.clk.advance(BEAT_MS * 4);
    r.planner.close();
    r.planner.start();
    r.planner.size(130, 41);
    await r.clk.advance(BEAT_MS * 4);
    assert.equal(r.log.sent.length, 1);
    assert.equal(r.log.released, 0);
    assert.equal(r.clk.pending, 0, 'no timer is left');
  });

  // fix round 2, review minor 1
  test('(+) a 403 after a fitted answer hides the chip: nothing renews the lease any more, so the header must not say it is fitted', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    assert.deepEqual(r.log.chips.map((v) => v && v.state), ['fitted']);
    await r.clk.advance(BEAT_MS);
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    assert.deepEqual(r.log.chips.map((v) => v && v.state), ['fitted', null]);
    await r.clk.advance(BEAT_MS * 3);
    r.planner.close();
    r.planner.restart();
    assert.deepEqual(r.log.chips.map((v) => v && v.state), ['fitted', null], 'the chip is told once, and a dead planner never shows it again');
    assert.equal(r.log.sent.length, 2);
  });

  test('(−) a 403 as the first answer tells the chip nothing (it was never shown)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    assert.deepEqual(r.log.chips, []);
  });

  // fix round 2, review minor 2
  test('(−) a send that throws at once is a lost request: start() does not throw, nothing is stuck busy, the next heartbeat goes out', async () => {
    const clk = clock();
    const sent = [];
    const chips = [];
    const planner = createFitPlanner({
      send: (b) => {
        sent.push(b);
        if (sent.length === 1) throw new Error('sync boom');
        return Promise.resolve(OK());
      },
      release: () => Promise.resolve({ status: 200, body: null }),
      after: clk.after,
      cancel: clk.cancel,
      chip: (v) => chips.push(v && v.state),
    });
    planner.size(100, 30);
    assert.doesNotThrow(() => planner.start());
    await flush();
    planner.size(110, 30); // a resize meanwhile waits like after any refusal
    await clk.advance(DEBOUNCE_MS);
    assert.equal(sent.length, 1, 'a lost request is not retried before the heartbeat');
    await clk.advance(BEAT_MS - DEBOUNCE_MS);
    assert.equal(sent.length, 2, 'the heartbeat goes out');
    assert.deepEqual(sent[1], { cols: 110, rows: 30, open: true }, 'nothing was opened by the thrown one: still open: true');
    assert.deepEqual(chips, ['fitted']);
    await clk.advance(BEAT_MS);
    assert.deepEqual(sent.map((b) => b.open), [true, true, false]);
  });

  test('(+) close() sends one release, drops the timers and the waiting size, and hides the chip', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.size(110, 31);
    r.planner.close();
    assert.equal(r.log.released, 1);
    assert.equal(r.clk.pending, 0);
    await r.clk.advance(BEAT_MS * 3);
    assert.equal(r.log.sent.length, 1, 'neither the debounced size nor a heartbeat goes out');
    assert.equal(r.log.chips.at(-1), null, 'the chip is told to hide');
  });

  test('(+) close() releases while a request is still in flight (the page is leaving)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    r.planner.close();
    assert.equal(r.log.released, 1);
  });

  test('(−) a second close() sends no second release; a close() before start sends none', async () => {
    const r = rig();
    r.planner.close();
    assert.equal(r.log.released, 0);
    r.planner.size(100, 30);
    r.planner.start();
    r.planner.close();
    r.planner.close();
    assert.equal(r.log.released, 1);
  });

  test('(−) an answer that comes after close() is ignored: no chip, no new request', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    r.planner.close();
    const chips = r.log.chips.length;
    await r.answer(OK('fitted'));
    await r.clk.advance(BEAT_MS * 2);
    assert.equal(r.log.chips.length, chips);
    assert.equal(r.log.sent.length, 1);
  });

  test('(+) start() after a close() asks for a new lease with open: false (only a page load opens), and tells the chip again', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.close();
    r.planner.start();
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, false]);
    await r.answer(OK());
    assert.deepEqual(r.log.chips.map((v) => v && v.state), ['fitted', null, 'fitted']);
  });

  test('(+) ... but a close() before any 200 has answered open: true leaves it to be sent again', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    r.planner.close();
    r.planner.start();
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, true]);
  });

  test('(−) the answer of the lease before a close() cannot touch the new one', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    r.planner.close();
    r.planner.start(); // two requests are now out: the old one first
    assert.equal(r.inFlight, 2);
    await r.answer({ status: 403, body: { error: 'forbidden' } }); // the old lease's answer
    await r.clk.advance(BEAT_MS);
    assert.equal(r.log.sent.length, 2, 'the stale 403 stopped nothing and the new lease still waits for its own answer');
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    assert.equal(r.log.sent.length, 3);
  });

  test('(+) start() twice is one start: one first request', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    r.planner.start();
    assert.equal(r.log.sent.length, 1);
    await r.answer(OK());
    r.planner.start();
    await r.clk.advance(DEBOUNCE_MS);
    assert.equal(r.log.sent.length, 1);
  });

  // fix round 1: the page came back from the back/forward cache (pageshow, persisted): a new page load, so a new lease opens with open: true
  test('(+) restart() after a close() is a new page load: open: true again, then open: false, and the chip is told again', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.close();
    r.planner.restart();
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, true]);
    assert.deepEqual(r.log.sent.at(-1), { cols: 100, rows: 30, open: true });
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, true, false], 'the heartbeats go on as always');
    assert.deepEqual(r.log.chips.map((v) => v && v.state), ['fitted', null, 'fitted']);
  });

  test('(+) restart() opens again also after blocked / user-change (the owner left that window; a new page load is the way back)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK('blocked', 'user-change'));
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, false]);
    await r.answer(OK('blocked', 'user-change'));
    r.planner.close();
    r.planner.restart();
    assert.equal(r.log.sent.at(-1).open, true);
  });

  test('(−) restart() while a lease is on sends nothing extra and does not reopen it', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.restart();
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, false], 'the next heartbeat is an ordinary one');
  });

  test('(−) restart() after a 403 does nothing: the page has no right to the route', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    r.planner.close();
    r.planner.restart();
    await r.clk.advance(BEAT_MS * 3);
    assert.equal(r.log.sent.length, 1);
    assert.equal(r.clk.pending, 0);
  });
});

describe('fitPanelView: the panel behind the chip (F1, design F12 2.3)', () => {
  const body = (state, reason = null) => ({ fit: { state, reason, pane: { cols: 120, rows: 39 }, panes: 3, userZoom: false } });
  const IDLE = { pending: false, note: false };
  const panel = (state, reason, ui = IDLE) => fitPanelView(chipView(body(state, reason)), ui);
  const NOTE = 'nika could not fit the window just now. It tries again within 5 seconds.';
  const ROWS = [
    // [state, reason, key, hint, code, action]
    ['fitted', null, 'fitted:', null, null, null],
    ['zoomed', 'panel-smaller', 'zoomed:', 'To fill the panel without scaled text, make this window larger or hide the transcript (Ctrl+Shift+H).', null, null],
    ['blocked', 'user-change', 'blocked:user-change', 'Fit again sizes the window to this panel once more. After a change of your own nika stays off until you ask.', null, 'Fit again'],
    ['blocked', 'changed', 'blocked:changed', 'Fit again tries once more.', null, 'Fit again'],
    ['blocked', null, 'blocked:', null, null, 'Fit again'],
    ['blocked', 'user-zoom', 'blocked:user-zoom', 'Unzoom it in tmux (prefix, then z) and nika fits the window by itself.', null, null],
    ['blocked', 'size-option', 'blocked:size-option', null, null, null],
    ['blocked', 'foreign-tag', 'blocked:foreign-tag', 'If no other nika runs, clear the mark in that tmux window, then nika fits it by itself:', 'tmux set-option -wu @nika-fit', null],
    ['other', null, 'other:', 'The other nika window stops fitting it.', null, 'Fit here'],
  ];

  for (const [state, reason, key, hint, code, action] of ROWS) {
    test(`(+) ${key}: heading and why are the chip's label and title; hint, code and action are the table's`, () => {
      const view = chipView(body(state, reason));
      assert.equal(view.key, key);
      const p = fitPanelView(view, IDLE);
      assert.equal(p.heading, view.label);
      assert.equal(p.why, view.title);
      assert.equal(p.hint, hint);
      assert.equal(p.code, code);
      assert.deepEqual(p.action, action === null ? null : { text: action });
      assert.equal(p.note, null);
    });
  }

  test('(+) the view has exactly heading, why, hint, code, action and note', () => {
    assert.deepEqual(Object.keys(panel('fitted')).sort(), ['action', 'code', 'heading', 'hint', 'note', 'why']);
  });

  test('(+) a pending request turns the action text into "Fitting..." (an ellipsis escape) for the rows that have an action', () => {
    for (const [state, reason, key, , , action] of ROWS) {
      const p = panel(state, reason, { pending: true, note: false });
      assert.deepEqual(p.action, action === null ? null : { text: 'Fitting…' }, key);
    }
  });

  test('(+) the note line shows when ui.note is true, with the exact sentence, and for every row', () => {
    for (const [state, reason, key] of ROWS) {
      assert.equal(panel(state, reason, { pending: false, note: true }).note, NOTE, key);
      assert.equal(panel(state, reason, { pending: false, note: false }).note, null, key);
    }
  });

  test('(−) no action for user-zoom, size-option, foreign-tag, fitted and zoomed: open: true changes nothing there, so a button would only fail', () => {
    for (const [state, reason] of [['blocked', 'user-zoom'], ['blocked', 'size-option'], ['blocked', 'foreign-tag'], ['fitted', null], ['zoomed', 'panel-smaller']]) {
      assert.equal(panel(state, reason).action, null, `${state} ${reason}`);
      assert.equal(panel(state, reason, { pending: true, note: true }).action, null, `${state} ${reason} pending`);
    }
  });

  test('(−) a key the table does not know has no hint, no code and no action; blocked with no or an unknown reason is the "blocked:" row', () => {
    const view = chipView(body('fitted'));
    for (const key of ['fitted:x', 'bogus', '', 'blocked:something-new', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const p = fitPanelView({ ...view, key }, IDLE);
      assert.deepEqual([p.hint, p.code, p.action], [null, null, null], key);
    }
    for (const reason of [undefined, 'something-new', 42, {}]) {
      assert.deepEqual(panel('blocked', reason).action, { text: 'Fit again' }, String(reason));
    }
  });

  test('(−) the table is looked up by the key of the view only: nothing a server said is copied into the panel', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const p = fitPanelView(chipView({ fit: { state: 'blocked', reason: hostile, message: hostile, pane: { cols: hostile, rows: 1 } }, message: hostile }), IDLE);
    assert.doesNotMatch(JSON.stringify(p), /img|onerror/);
    assert.deepEqual(p.action, { text: 'Fit again' });
  });

  test('(−) not a view: null, undefined, a string, a number and an object with no key give null', () => {
    for (const bad of [null, undefined, 'fitted:', 42, [], {}, { key: 7 }]) assert.equal(fitPanelView(bad, IDLE), null, JSON.stringify(bad));
  });

  test('(−) a missing ui is idle: no note and no "Fitting..."', () => {
    const p = fitPanelView(chipView(body('blocked', 'changed')));
    assert.deepEqual([p.note, p.action], [null, { text: 'Fit again' }]);
  });

  test('(+) every string of a panel view is plain ASCII, except the ellipsis, which is an escape in the source and the only non-ASCII character', () => {
    for (const [state, reason] of ROWS) {
      for (const ui of [IDLE, { pending: true, note: true }]) {
        const p = fitPanelView(chipView(body(state, reason)), ui);
        for (const s of [p.heading, p.why, p.hint, p.code, p.note, p.action?.text].filter((x) => typeof x === 'string')) {
          assert.equal([...s.replace('…', '')].every((ch) => ch.codePointAt(0) < 128), true, s);
        }
      }
    }
    assert.doesNotMatch(readSrc('fit-ui.js'), /[^\x00-\x7f]/, 'the module itself is ASCII');
  });

  test('(+) stillOffSay is the announcement when Fit again changed nothing: "Fit is still off. " + the title', () => {
    const view = chipView(body('blocked', 'changed'));
    assert.equal(stillOffSay(view), 'Fit is still off. The tmux window changed while nika was fitting it, so nika put it back');
    assert.equal(stillOffSay(chipView(body('blocked', 'user-change'))), 'Fit is still off. You changed this tmux window, so nika put it back');
  });
});

describe('createFitPlanner: reopen(), the user asks to fit again (F1, design F12 2.8)', () => {
  const FAILED = { status: 502, body: { error: 'tmux_failed' } };
  const opens = (r) => r.log.sent.map((b) => b.open);
  /** A planner that has been answered once with `first`, so a chip exists (a button the user can press). */
  const ready = async (first = OK('blocked', 'user-change'), opts) => {
    const r = rig(opts);
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(first);
    return r;
  };

  test('(+) idle: reopen() sends open: true at once, tells fitAgain pending, then the result with the view; later beats are open: false again', async () => {
    const r = await ready();
    assert.equal(r.planner.reopen(), true);
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true }, { cols: 100, rows: 30, open: true }], 'no timer needed: it goes out now');
    assert.deepEqual(r.log.again, [{ pending: true }]);
    await r.answer(OK('fitted'));
    assert.equal(r.log.again.length, 2);
    const e = r.log.again[1];
    assert.deepEqual([e.pending, e.status, e.view.key, e.changed], [false, 200, 'fitted:', true]);
    assert.deepEqual(r.log.chips.map((v) => v.key), ['blocked:user-change', 'fitted:'], 'the chip was told first');
    await r.clk.advance(BEAT_MS - 1);
    assert.equal(r.log.sent.length, 2, 'the beat was re-armed 5 s from the ask');
    await r.clk.advance(1);
    assert.deepEqual(r.log.sent[2], { cols: 100, rows: 30, open: false });
    await r.answer(OK('fitted'));
    assert.equal(r.log.again.length, 2, 'an ordinary beat is not an ask');
  });

  test('(+) the same state again: fitAgain says changed: false with the view (the chip was not told twice)', async () => {
    const r = await ready(OK('blocked', 'changed'));
    r.planner.reopen();
    await r.answer(OK('blocked', 'changed'));
    const e = r.log.again[1];
    assert.deepEqual([e.status, e.view.key, e.changed], [200, 'blocked:changed', false]);
    assert.equal(r.log.chips.length, 1);
  });

  test('(+) reopen() while a request is in flight sends nothing more; when it settles with 200 the open: true request goes out at once (the older 200 does not cancel the ask)', async () => {
    const r = await ready(OK('fitted'));
    await r.clk.advance(BEAT_MS); // a beat: open: false, in flight
    assert.equal(r.inFlight, 1);
    assert.equal(r.planner.reopen(), true);
    assert.equal(r.log.sent.length, 2, 'nothing more while one is in flight');
    assert.deepEqual(r.log.again, [{ pending: true }]);
    await r.answer(OK('fitted'));
    assert.deepEqual(opens(r), [true, false, true], 'the ask goes out at once, with open: true');
    assert.equal(r.log.again.length, 1);
    await r.answer(OK('fitted'));
    assert.deepEqual(r.log.again.map((e) => e.pending), [true, false]);
  });

  test('(+) reopen() while the very first open: true is still in flight is never stuck: the ask ends with an open: true answer', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    assert.equal(r.planner.reopen(), true);
    await r.answer(OK('fitted'));
    assert.deepEqual(opens(r), [true, true]);
    await r.answer(OK('fitted'));
    assert.deepEqual(r.log.again.map((e) => e.pending), [true, false]);
  });

  test('(+) a non-200 answer to the ask: fitAgain gets that status and no view; the next beat sends open: true again, silently (the note promises a retry within 5 s)', async () => {
    const r = await ready();
    r.planner.reopen();
    await r.answer(FAILED);
    assert.deepEqual(r.log.again[1], { pending: false, status: 502, view: null, changed: false });
    assert.equal(r.log.sent.length, 2, 'nothing before the beat');
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(opens(r), [true, true, true]);
    await r.answer(OK('fitted'));
    assert.equal(r.log.again.length, 2, 'the retry is not reported as an ask');
    assert.equal(r.log.chips.at(-1).key, 'fitted:', 'but the chip follows');
    await r.clk.advance(BEAT_MS);
    assert.equal(opens(r).at(-1), false, 'and it opens only once');
  });

  test('(+) a lost request is status 0; a rejecting send too; a 200 that is not a fit answer is status 200 with no view', async () => {
    for (const [settleIt, expected] of [
      [(r) => r.fail(), { pending: false, status: 0, view: null, changed: false }],
      [(r) => r.answer({ status: 0, body: null }), { pending: false, status: 0, view: null, changed: false }],
      [(r) => r.answer({ status: 200, body: null }), { pending: false, status: 200, view: null, changed: false }],
      [(r) => r.answer({ status: 409, body: { error: 'busy' } }), { pending: false, status: 409, view: null, changed: false }],
    ]) {
      const r = await ready();
      r.planner.reopen();
      await settleIt(r);
      assert.deepEqual(r.log.again[1], expected);
    }
  });

  test('(+) a non-200 to the older request in flight: the ask waits for the next beat and goes out then with open: true', async () => {
    const r = await ready(OK('fitted'));
    await r.clk.advance(BEAT_MS);
    r.planner.reopen();
    await r.answer(FAILED);
    assert.equal(r.log.sent.length, 2);
    assert.deepEqual(r.log.again, [{ pending: true }], 'the ask is still open');
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(opens(r), [true, false, true]);
    await r.answer(OK('fitted'));
    assert.deepEqual(r.log.again.map((e) => e.pending), [true, false]);
  });

  test('(+) reopen() after a refusal that put the planner on hold does not wait for the beat', async () => {
    const r = await ready(OK('fitted'));
    await r.clk.advance(BEAT_MS);
    await r.answer(FAILED); // hold until the next beat
    assert.equal(r.planner.reopen(), true);
    assert.deepEqual(opens(r), [true, false, true]);
  });

  test('(−) reopen() is false and nothing is sent or reported before start()', () => {
    const r = rig();
    r.planner.size(100, 30);
    assert.equal(r.planner.reopen(), false);
    assert.deepEqual([r.log.sent, r.log.again], [[], []]);
  });

  test('(−) reopen() is false after close(): nothing is sent, nothing is reported', async () => {
    const r = await ready();
    r.planner.close();
    assert.equal(r.planner.reopen(), false);
    assert.equal(r.log.sent.length, 1);
    assert.deepEqual(r.log.again, []);
    assert.equal(r.clk.pending, 0, 'no timer was started');
  });

  test('(−) reopen() is false after a 403, and nothing is sent', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK('fitted'));
    await r.clk.advance(BEAT_MS);
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    assert.equal(r.planner.reopen(), false);
    assert.equal(r.log.sent.length, 2);
    assert.deepEqual(r.log.again, []);
    assert.equal(r.clk.pending, 0);
  });

  test('(−) reopen() is false while an ask is pending (queued or in flight): one ask at a time, one request, one fitAgain pending', async () => {
    const r = await ready();
    assert.equal(r.planner.reopen(), true);
    assert.equal(r.planner.reopen(), false, 'in flight');
    assert.equal(r.log.sent.length, 2);
    assert.deepEqual(r.log.again, [{ pending: true }]);
    await r.answer(OK('fitted'));
    assert.equal(r.planner.reopen(), true, 'free again once it ended');
    assert.equal(r.log.sent.length, 3);
  });

  test('(−) 403 as the answer to the ask: fitAgain gets 403 after the chip was told to hide, and nothing renews afterwards', async () => {
    const r = await ready();
    r.planner.reopen();
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    assert.deepEqual(r.log.chips.map((v) => (v === null ? null : v.key)), ['blocked:user-change', null], 'the chip hid before fitAgain was told');
    assert.deepEqual(r.log.again[1], { pending: false, status: 403, view: null, changed: false });
    await r.clk.advance(BEAT_MS * 3);
    assert.equal(r.log.sent.length, 2);
  });

  test('(+) close() while an ask is pending: no fitAgain later, even when the old answer arrives after a start(); the new lease opens with open: false', async () => {
    const r = await ready();
    r.planner.reopen();
    r.planner.close();
    assert.equal(r.log.released, 1);
    r.planner.start();
    assert.deepEqual(opens(r), [true, true, false]);
    await r.answer(OK('fitted')); // the answer of the old lease
    await r.answer(OK('fitted')); // the new lease
    assert.deepEqual(r.log.again, [{ pending: true }], 'nothing was reported after the close');
    assert.equal(r.planner.reopen(), true, 'a new lease can be asked again');
  });

  test('(+) restart() clears a pending ask too', async () => {
    const r = await ready();
    r.planner.reopen();
    r.planner.close();
    r.planner.restart();
    await r.answer(OK('fitted'));
    await r.answer(OK('fitted'));
    assert.deepEqual(r.log.again, [{ pending: true }]);
    assert.deepEqual(opens(r), [true, true, true], 'restart is a page load: open: true');
  });

  test('(+) a planner whose io has no fitAgain still works: reopen() sends open: true and nothing throws', async () => {
    const r = await ready(OK('blocked', 'user-change'), { again: false });
    assert.equal(r.planner.reopen(), true);
    await r.answer(OK('fitted'));
    assert.deepEqual(r.log.chips.map((v) => v.key), ['blocked:user-change', 'fitted:']);
    assert.equal(r.log.again.length, 0);
  });

  test('(+) every body of an ask still has exactly cols, rows and open', async () => {
    const r = await ready();
    r.planner.reopen();
    for (const b of r.log.sent) assert.deepEqual(Object.keys(b).sort(), ['cols', 'open', 'rows']);
  });
});

describe('api.js: appFetch passes keepalive through (design 8.2)', () => {
  const API = pathToFileURL(path.join(PUBLIC, 'api.js')).href;
  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  let n = 0;
  const load = () => {
    globalThis.window = { __NIKA_APP__: { secret: 'unit-test-secret', port: 1 } };
    return import(`${API}?fit=${n++}`);
  };
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  const stub = () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push([url, opts]);
      return { status: 200, headers: new Map(), text: async () => '{"released":true}' };
    };
    return calls;
  };

  test('(+) keepalive: true reaches fetch, and the X-Nika-App header still goes; a DELETE has no body and no content type', async () => {
    const calls = stub();
    const api = await load();
    const r = await api.appFetch('/api/app/pane/%2512/fit', { method: 'DELETE', keepalive: true });
    assert.deepEqual([r.status, r.body], [200, { released: true }]);
    const [url, opts] = calls[0];
    assert.equal(url, '/api/app/pane/%2512/fit');
    assert.equal(opts.method, 'DELETE');
    assert.equal(opts.keepalive, true);
    assert.equal(opts.headers['X-Nika-App'], 'unit-test-secret');
    assert.equal(opts.body, undefined);
    assert.equal(opts.headers['Content-Type'], undefined);
  });

  test('(−) without keepalive the request is an ordinary one; only the value true turns it on', async () => {
    const calls = stub();
    const api = await load();
    await api.appFetch('/api/app/pane/%2512/fit', { method: 'PUT', json: { cols: 100, rows: 30, open: true } });
    for (const odd of ['yes', 1, {}, null]) await api.appFetch('/api/app/pane/%2512/fit', { method: 'DELETE', keepalive: odd });
    assert.equal(calls.length, 5);
    for (const [, opts] of calls) assert.ok(!opts.keepalive, 'keepalive is off');
    assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
    assert.equal(calls[0][1].headers['X-Nika-App'], 'unit-test-secret');
  });

  test('(−) a caller still cannot override the secret header when it asks for keepalive', async () => {
    const calls = stub();
    const api = await load();
    await api.appFetch('/api/app/pane/%2512/fit', { method: 'DELETE', keepalive: true, headers: { 'X-Nika-App': 'forged' } });
    assert.equal(calls[0][1].headers['X-Nika-App'], 'unit-test-secret');
  });
});
