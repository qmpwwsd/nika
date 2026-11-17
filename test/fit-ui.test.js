// The page side of the fit (design W7, sections 5, 8 and 9; docs/contracts/api-app.md, PUT and DELETE /api/app/pane/:id/fit):
// public/fit-ui.js has no DOM and makes no request of its own. The planner runs against a manual clock and a fake route whose
// answers the test gives one by one, so every timing rule (250 ms debounce, 5 s heartbeat, one request in flight, latest wins)
// is asserted exactly. Fixtures are synthetic.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  panelSize, scaleFor, chipView, fitPanelView, stillOffSay, createFitPlanner, BEAT_MS, DEBOUNCE_MS, SCALE_MIN, FOCUS_SETTLE_MS, BLUR_SETTLE_MS, FOCUS_POLL_MS,
  remeasure, askSize, frameReady, roomStep, refitFrom, createRedrawHold, HOLD_MS, HOLD_POLL_MS, ROOM_ROWS, REFIT_MS,
  HIDE_MAX, hiddenRows, fillSize, drawnScale,
  GROW_STEP_MIN, GROW_CAP, GROW_CONFIRM_MS, GROW_SETTLE_MS, GROW_WAIT_MS, GROW_CLOSE_MS, GROW_IDLE, growNext, cutQuestion, growAsk, scaleRows, growStep, growRebase, // F16
} from '../public/fit-ui.js';

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
    'panel-smaller': 'Other panes share this tmux window. With focus nika sizes the window to this panel; without focus it only zooms the pane and scales the text.', // F15 (owner decision 2026-11-16)
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
    assert.equal(chipView(body('zoomed', 'other-panes')).title, SIX['panel-smaller'], 'F15: no second zoomed sentence');
    assert.equal(chipView(body('zoomed', 'other-panes')).key, chipView(body('zoomed', 'panel-smaller')).key);
    assert.equal(chipView(body('fitted', 'user-zoom')).title, chipView(body('fitted')).title);
    assert.equal(chipView(body('other', 'changed')).title, chipView(body('other')).title);
  });

  test('(−) blocked with no reason, or one nika does not know, is still "off" with a plain sentence', () => {
    // F15: `other-panes` (design F13 3.2, dropped by the owner's answers 5 and 6) is no reason either, on any state
    for (const reason of [null, undefined, 'something-new', 42, {}, 'panel-smaller', 'other-panes']) {
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

// ---- F4 (design F4 section 3.5, owner answers of 2026-11-16: Q1 a state of its own, Q2 the 30 s in the copy) ------------------------------
describe('F4: chipView, the state `terminal` (a terminal shows the tmux window, so nika leaves its size alone)', () => {
  const TEXT = `Fit ${DOT} your terminal's size`;
  const LABEL = "Fit: your terminal's size";
  // F9 (design F9 5.2, requirement change, not a weakened test): the sentence now says that this window has no focus, because a focused window gets the size
  const TITLE_PLAIN = 'A terminal shows this tmux window and this window does not have focus, so nika leaves the size to the terminal and scales the text to this panel';
  const TITLE_ZOOM = 'A terminal shows this tmux window and this window does not have focus, so nika only zoomed this pane, leaves the size to the terminal and scales the text to this panel';
  // the shared contract of design F4 section 8: state "terminal", reason null, panes and userZoom as today
  const term = (panes, userZoom = false, reason = null) => ({ fit: { state: 'terminal', reason, pane: { cols: 200, rows: 50 }, panes, userZoom } });

  test('(+) one pane: key "terminal:", icon "term", the words, the label, the title and the announcement', () => {
    assert.deepEqual(chipView(term(1)), {
      key: 'terminal:', state: 'terminal', icon: 'term', text: TEXT, label: LABEL, title: TITLE_PLAIN, say: `${LABEL}. ${TITLE_PLAIN}`,
    });
  });

  test('(+) several panes that nika zoomed (userZoom false): key "terminal:zoom" and the title that says "only zoomed this pane"; the words, icon and label stay', () => {
    const v = chipView(term(3, false));
    assert.deepEqual(v, {
      key: 'terminal:zoom', state: 'terminal', icon: 'term', text: TEXT, label: LABEL, title: TITLE_ZOOM, say: `${LABEL}. ${TITLE_ZOOM}`,
    });
    assert.equal(chipView(term(2, false)).key, 'terminal:zoom', 'two panes are several');
  });

  test('(−) nika did not zoom it, or the pane count is not a count above one: key "terminal:" and the plain title', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    for (const [panes, userZoom] of [[3, true], ['3', false], [undefined, false], [null, false], [0, false], [1, false], [-3, false], [1.5, false], [2.5, false], [NaN, false], [hostile, false], [[3], false], [{}, false]]) {
      const v = chipView(term(panes, userZoom));
      assert.equal(v.key, 'terminal:', `${JSON.stringify(panes)} ${userZoom}`);
      assert.equal(v.title, TITLE_PLAIN, `${JSON.stringify(panes)} ${userZoom}`);
    }
    const noPanes = { fit: { state: 'terminal', reason: null, userZoom: false } };
    assert.equal(chipView(noPanes).key, 'terminal:', 'panes missing altogether');
  });

  // F9 (requirement change): the one reason `terminal` takes is `switching` (own describe below); every other reason is still ignored
  test('(−) any reason on `terminal` but `switching` is ignored: nothing the server puts there changes the key, the title or the words', () => {
    const plain = chipView(term(1));
    const zoom = chipView(term(3));
    for (const reason of ['user-change', 'panel-smaller', 'changed', 'user-zoom', 'terminal-zoom', 'terminal', '<img src=x onerror=alert(1)>', '__proto__', 42, {}]) {
      assert.deepEqual(chipView(term(1, false, reason)), plain, String(reason));
      assert.deepEqual(chipView(term(3, false, reason)), zoom, String(reason));
    }
  });

  test('(−) the zoom sentence is not a reason: a server cannot select it through `blocked`, and no other state takes it', () => {
    for (const reason of ['terminal-zoom', 'terminal']) {
      const v = chipView({ fit: { state: 'blocked', reason, panes: 3, userZoom: false } });
      assert.equal(v.key, 'blocked:', reason);
      assert.equal(v.title, 'nika is not fitting this tmux window', reason);
    }
    for (const state of ['fitted', 'zoomed', 'other']) {
      const v = chipView({ fit: { state, reason: null, panes: 3, userZoom: false } });
      assert.doesNotMatch(JSON.stringify(v), /terminal/i, state);
    }
  });

  test('(+) five states now: each has its own key, state word, icon and text (never colour alone)', () => {
    const views = [
      chipView({ fit: { state: 'fitted', reason: null } }), chipView({ fit: { state: 'zoomed', reason: 'panel-smaller' } }), chipView({ fit: { state: 'blocked', reason: 'user-zoom' } }),
      chipView({ fit: { state: 'other', reason: null } }), chipView(term(1)),
    ];
    for (const k of ['state', 'icon', 'text', 'key', 'label', 'title']) assert.equal(new Set(views.map((x) => x[k])).size, 5, `five states, five different ${k}`);
    assert.equal(views.at(-1).icon, 'term');
  });

  test('(−) the `terminal:zoom` key is a different key from `terminal:` (the chip is redrawn and announced when one becomes the other)', () => {
    assert.notEqual(chipView(term(1)).key, chipView(term(3)).key);
    assert.equal(chipView(term(3, false)).key, chipView(term(7, false)).key, 'the count itself does not matter');
  });

  test('(−) a state name that only looks like `terminal` is still not a fit answer', () => {
    for (const state of ['Terminal', 'TERMINAL', 'terminal ', ' terminal', 'terminal-zoom', 'terminals', 'term']) assert.equal(chipView({ fit: { state, reason: null, panes: 1, userZoom: false } }), null, state);
  });

  test('(+) every string of both terminal views is plain ASCII (the middle dot and the apostrophe are written so in the source)', () => {
    for (const v of [chipView(term(1)), chipView(term(3))]) {
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

/**
 * A planner with a fake route: every body sent waits in `pending` until answer() gives its reply.
 * F9: `page.focus` is what io.focused() reads (change it, then call planner.focusChanged like the page's events do); `page.throws` makes it throw;
 * `focus: false` in the options and `noFocusIo: true` leave io.focused out altogether. log.quiet holds the `quiet` flag of each chip call that got one.
 * F10: io.sized is the optional sink for the pane size of each 200 answer (`noSized: true` leaves it out); log.order is the order of the chip and sized calls.
 */
function rig({ again = true, focus = false, noFocusIo = false, noSized = false } = {}) {
  const clk = clock();
  const log = { sent: [], released: 0, chips: [], again: [], quiet: [], sized: [], order: [] };
  const page = { focus, throws: false };
  const pending = [];
  const io = {
    send: (b) => new Promise((resolve, reject) => { log.sent.push(b); pending.push({ resolve, reject }); }),
    release: () => { log.released += 1; return Promise.resolve({ status: 200, body: { released: true } }); },
    after: clk.after,
    cancel: clk.cancel,
    chip: (v, opts) => { log.order.push('chip'); log.chips.push(v); if (opts !== undefined) log.quiet.push(opts.quiet); },
  };
  if (!noSized) io.sized = (pane) => { log.order.push('sized'); log.sized.push(pane); }; // F10: the pane size of each 200 answer
  if (!noFocusIo) io.focused = () => { if (page.throws) throw new Error('focus unreadable'); return page.focus; };
  if (again) io.fitAgain = (e) => log.again.push(e); // F1: the optional sink for the user's Fit again; a rig without it proves it is optional
  const planner = createFitPlanner(io);
  return {
    planner, clk, log, page,
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
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true, focus: false }]);
  });

  test('(+) later requests are open: false', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    r.planner.size(110, 30);
    await r.clk.advance(DEBOUNCE_MS);
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true, focus: false }, { cols: 110, rows: 30, open: false, focus: false }]);
  });

  test('(+) a start before any measure waits for the first size, then asks at once', async () => {
    const r = rig();
    r.planner.start();
    assert.deepEqual(r.log.sent, []);
    r.planner.size(100, 30);
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true, focus: false }]);
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
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 103, rows: 31, open: false, focus: false }]);
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
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 102, rows: 30, open: false, focus: false }]);
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
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false, focus: false }]);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(r.log.sent.slice(2), [{ cols: 100, rows: 30, open: false, focus: false }]);
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
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false, focus: false }]);
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
    assert.deepEqual(r.log.sent, [{ cols: 40, rows: 10, open: true, focus: false }], 'the smallest legal size goes');
  });

  // F9 (requirement change, not a weakened test): the route takes `focus` too, so a body is cols, rows, open and focus
  test('(+) every body has exactly cols, rows, open and focus (the route takes no other key)', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    for (const b of r.log.sent) assert.deepEqual(Object.keys(b).sort(), ['cols', 'focus', 'open', 'rows']);
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
      assert.deepEqual(r.log.sent.slice(1), [{ cols: 120, rows: 32, open: true, focus: false }], `status ${reply.status}: the heartbeat asks again with the latest size`);
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
    assert.deepEqual(sent[1], { cols: 110, rows: 30, open: true, focus: false }, 'nothing was opened by the thrown one: still open: true');
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
    assert.deepEqual(r.log.sent.at(-1), { cols: 100, rows: 30, open: true, focus: false });
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
    ['zoomed', 'panel-smaller', 'zoomed:', 'Click into this window to fill the panel; the other panes get their size and layout back when you leave it.', null, null],
    // F4 (design F4 3.6, requirement change, not a weakened test): Fit again over a window a terminal shows lands in `terminal`, not "sized to this panel", so the old sentence would be false
    ['blocked', 'user-change', 'blocked:user-change', 'Fit again turns the fit on once more. After a change of your own nika stays off until you ask.', null, 'Fit again'],
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

describe('F4: fitPanelView and the planner for the state `terminal` (design F4 3.6)', () => {
  const body = (panes, userZoom = false) => ({ fit: { state: 'terminal', reason: null, pane: { cols: 200, rows: 50 }, panes, userZoom } });
  const IDLE = { pending: false, note: false };
  const NOTE = 'nika could not fit the window just now. It tries again within 5 seconds.';
  // F9 (design F9 5.2, requirement change): both hints now start with what clicking into this window does
  const HINT_PLAIN = 'Click into this window and nika sizes the tmux window to this panel; your terminal gets its size back when you click into it again. With no terminal on the window for 30 seconds, nika also sizes it to this panel by itself.';
  const HINT_ZOOM = 'Your terminal shows this pane zoomed too, until this session window closes. Click into this window and nika sizes the tmux window to this panel.';
  const ROWS = [['terminal:', body(1), HINT_PLAIN], ['terminal:zoom', body(3), HINT_ZOOM]];

  for (const [key, b, hint] of ROWS) {
    test(`(+) ${key}: heading and why are the chip's label and title; the exact hint; no command; no action (open: true cannot override the terminal)`, () => {
      const view = chipView(b);
      assert.equal(view.key, key);
      const p = fitPanelView(view, IDLE);
      assert.equal(p.heading, view.label);
      assert.equal(p.why, view.title);
      assert.equal(p.hint, hint);
      assert.equal(p.code, null);
      assert.equal(p.action, null);
      assert.equal(p.note, null);
    });

    test(`(−) ${key}: a pending request or a note never gives it a button; the note shows its sentence`, () => {
      const view = chipView(b);
      assert.equal(fitPanelView(view, { pending: true, note: false }).action, null);
      assert.equal(fitPanelView(view, { pending: true, note: true }).action, null);
      assert.equal(fitPanelView(view, { pending: false, note: true }).note, NOTE);
      assert.equal(fitPanelView(view, undefined).note, null);
    });

    test(`(+) ${key}: every string of the panel is plain ASCII`, () => {
      const p = fitPanelView(chipView(b), { pending: true, note: true });
      for (const s of [p.heading, p.why, p.hint, p.note]) assert.equal([...s].every((ch) => ch.codePointAt(0) < 128), true, s);
    });
  }

  // F9 (requirement change): design F9 5.2 words the zoom hint without the 30 s (it names the click only); the plain hint keeps the 30 seconds the owner agreed to (F4 Q2)
  test('(+) the plain hint says the 30 seconds the owner agreed to (F4 Q2); neither hint says how the terminal is told apart', () => {
    assert.match(HINT_PLAIN, /30 seconds/);
    for (const [, , hint] of ROWS) assert.doesNotMatch(hint, /window_active_clients|tmux set-option|control mode/);
  });

  test('(−) the table is looked up by the key: a key it does not know (a made-up terminal variant) has no hint, no code and no action', () => {
    const view = chipView(body(1));
    for (const key of ['terminal', 'terminal:x', 'terminal:zoom:', 'Terminal:', 'terminal: ', 'terminal-zoom']) {
      const p = fitPanelView({ ...view, key }, IDLE);
      assert.deepEqual([p.hint, p.code, p.action], [null, null, null], key);
    }
  });

  test('(−) nothing the server said reaches the panel of a terminal answer', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const p = fitPanelView(chipView({ fit: { state: 'terminal', reason: hostile, message: hostile, pane: { cols: hostile, rows: 1 }, panes: 3, userZoom: false }, message: hostile }), IDLE);
    assert.doesNotMatch(JSON.stringify(p), /img|onerror/);
    assert.equal(p.hint, HINT_ZOOM);
  });

  test('(−) F4 reworded the user-change hint: no panel still says Fit again "sizes the window to this panel", because over a window a terminal shows it lands in `terminal`', () => {
    const states = [['fitted', null], ['zoomed', 'panel-smaller'], ['other', null], ...['user-zoom', 'size-option', 'foreign-tag', 'changed', 'user-change', null].map((r) => ['blocked', r])];
    for (const [state, reason] of states) {
      const p = fitPanelView(chipView({ fit: { state, reason, panes: 3, userZoom: false } }), IDLE);
      assert.doesNotMatch(p.hint ?? '', /sizes the window to this panel once more/, `${state} ${reason}`);
    }
    for (const b of [body(1), body(3)]) assert.doesNotMatch(fitPanelView(chipView(b), IDLE).hint, /Fit again/);
  });

  // the planner treats every fit answer alike; the new state needs nothing there, and these tests keep it so
  test('(+) a `terminal` answer tells the chip once, a change between `terminal:` and `terminal:zoom` tells it again, and the heartbeat stays open: false', async () => {
    const r = rig();
    r.planner.size(120, 39);
    r.planner.start();
    await r.answer({ status: 200, body: body(1) });
    assert.deepEqual(r.log.chips.map((v) => v.key), ['terminal:']);
    await r.clk.advance(5000);
    await r.answer({ status: 200, body: body(1) });
    assert.equal(r.log.chips.length, 1, 'the same key again says nothing');
    await r.clk.advance(5000);
    await r.answer({ status: 200, body: body(3) });
    assert.deepEqual(r.log.chips.map((v) => v.key), ['terminal:', 'terminal:zoom']);
    assert.deepEqual(r.log.sent.map((b) => b.open), [true, false, false]);
  });

  test('(+) a Fit again answered `terminal` reaches fitAgain as a 200 with the terminal view (the page closes the panel on it)', async () => {
    const r = rig();
    r.planner.size(120, 39);
    r.planner.start();
    await r.answer(OK('blocked', 'user-change'));
    assert.equal(r.planner.reopen(), true);
    await r.answer({ status: 200, body: body(1) });
    const done = r.log.again.at(-1);
    assert.deepEqual([done.pending, done.status, done.view.state, done.view.key, done.changed], [false, 200, 'terminal', 'terminal:', true]);
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
    assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true, focus: false }, { cols: 100, rows: 30, open: true, focus: false }], 'no timer needed: it goes out now');
    assert.deepEqual(r.log.again, [{ pending: true }]);
    await r.answer(OK('fitted'));
    assert.equal(r.log.again.length, 2);
    const e = r.log.again[1];
    assert.deepEqual([e.pending, e.status, e.view.key, e.changed], [false, 200, 'fitted:', true]);
    assert.deepEqual(r.log.chips.map((v) => v.key), ['blocked:user-change', 'fitted:'], 'the chip was told first');
    await r.clk.advance(BEAT_MS - 1);
    assert.equal(r.log.sent.length, 2, 'the beat was re-armed 5 s from the ask');
    await r.clk.advance(1);
    assert.deepEqual(r.log.sent[2], { cols: 100, rows: 30, open: false, focus: false });
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

  test('(+) every body of an ask still has exactly cols, rows, open and focus (F9: focus is the fourth key)', async () => {
    const r = await ready();
    r.planner.reopen();
    for (const b of r.log.sent) assert.deepEqual(Object.keys(b).sort(), ['cols', 'focus', 'open', 'rows']);
  });
});

// ---- F9 (design F9 3 and 5, 7.3; owner answers of 2026-11-16): the focused window wins the pane's size -----------------------------------------
describe('F9: chipView, `fitted` with reason `terminal` and `terminal` with reason `switching`', () => {
  const FITTED_TERMINAL = 'nika sized the tmux window to this panel because this window has focus; your terminal shows it too and gets its size back when you click into it';
  const SWITCHING = 'You switched between this window and your terminal often in the last minute, so nika leaves the size to the terminal for now and scales the text to this panel';
  const body = (state, reason, panes = 3, userZoom = false) => ({ fit: { state, reason, pane: { cols: 120, rows: 39 }, panes, userZoom } });

  test('(+) fitted + terminal: key "fitted:terminal", the fitted state, icon and words, the exact title; the announcement is label + title', () => {
    const v = chipView(body('fitted', 'terminal'));
    const plain = chipView(body('fitted', null));
    assert.deepEqual(v, { key: 'fitted:terminal', state: 'fitted', icon: 'fit', text: `Fit ${DOT} fills the panel`, label: 'Fit: fills the panel', title: FITTED_TERMINAL, say: `Fit: fills the panel. ${FITTED_TERMINAL}` });
    assert.deepEqual([v.state, v.icon, v.text, v.label], [plain.state, plain.icon, plain.text, plain.label], 'owner Q1: no new colour (data-k is the state), icon or words');
    assert.notEqual(v.key, plain.key, 'a different key: the chip is redrawn when one becomes the other');
  });

  test('(+) terminal + switching: key "terminal:switching", the terminal state, icon and words, the exact title; panes and userZoom do not matter', () => {
    const plain = chipView(body('terminal', null, 1));
    for (const [panes, userZoom] of [[1, false], [3, false], [3, true], [undefined, false], ['3', false]]) {
      const v = chipView(body('terminal', 'switching', panes, userZoom));
      assert.deepEqual(v, { key: 'terminal:switching', state: 'terminal', icon: 'term', text: `Fit ${DOT} your terminal's size`, label: "Fit: your terminal's size", title: SWITCHING, say: `Fit: your terminal's size. ${SWITCHING}` }, `${panes} ${userZoom}`);
    }
    assert.deepEqual([plain.state, plain.icon, plain.text, plain.label], ['terminal', 'term', `Fit ${DOT} your terminal's size`, "Fit: your terminal's size"]);
  });

  test('(−) fitted with any other reason is plain "fitted:"; terminal with any other reason keeps its F4 key (a reason that only looks like these is ignored)', () => {
    const lookalikes = ['Terminal', 'TERMINAL', ' terminal', 'terminal ', 'terminal\n', 'terminals', 'switching', 'Switching', 'SWITCHING', ' switching', 'switching ', 'switch', '', null, undefined, 42, {}, [], ['terminal'], '__proto__', 'constructor', 'user-change', 'panel-smaller'];
    for (const reason of lookalikes.filter((x) => x !== 'terminal')) {
      assert.deepEqual(chipView(body('fitted', reason)), chipView(body('fitted', null)), `fitted ${JSON.stringify(reason)}`);
    }
    for (const reason of lookalikes.filter((x) => x !== 'switching')) {
      assert.deepEqual(chipView(body('terminal', reason, 1)), chipView(body('terminal', null, 1)), `terminal ${JSON.stringify(reason)}`);
      assert.deepEqual(chipView(body('terminal', reason, 3)), chipView(body('terminal', null, 3)), `terminal zoom ${JSON.stringify(reason)}`);
    }
  });

  test('(−) the two new sentences are selected by the exact pair only: no other state takes them, and `blocked` cannot be pointed at them', () => {
    for (const state of ['zoomed', 'other']) {
      for (const reason of ['terminal', 'switching']) {
        const v = chipView(body(state, reason));
        assert.doesNotMatch(JSON.stringify(v), /shows it too|switched between/, `${state} ${reason}`);
      }
    }
    for (const reason of ['terminal', 'switching']) {
      const v = chipView(body('blocked', reason));
      assert.equal(v.key, 'blocked:', reason);
      assert.equal(v.title, 'nika is not fitting this tmux window', reason);
    }
    assert.doesNotMatch(JSON.stringify(chipView(body('fitted', 'switching'))), /switched between/);
    assert.doesNotMatch(JSON.stringify(chipView(body('terminal', 'terminal', 1))), /shows it too/);
  });

  test('(+) seven keys, five states: the new keys add no state, so no new colour (data-k) and no new icon', () => {
    const views = [
      chipView(body('fitted', null)), chipView(body('fitted', 'terminal')), chipView(body('zoomed', 'panel-smaller')), chipView(body('blocked', 'user-zoom')), chipView(body('other', null)),
      chipView(body('terminal', null, 1)), chipView(body('terminal', null, 3)), chipView(body('terminal', 'switching', 1)),
    ];
    assert.equal(new Set(views.map((x) => x.key)).size, views.length, 'every key is different');
    assert.deepEqual([...new Set(views.map((x) => x.state))].sort(), ['blocked', 'fitted', 'other', 'terminal', 'zoomed']);
    assert.deepEqual([...new Set(views.map((x) => x.icon))].sort(), ['fit', 'off', 'term', 'window', 'zoom']);
  });

  test('(+) every string of the new views is plain ASCII', () => {
    for (const v of [chipView(body('fitted', 'terminal')), chipView(body('terminal', 'switching'))]) {
      assert.equal(v.text.includes(DOT), true);
      for (const s of [v.title, v.say, v.icon, v.key, v.label]) assert.equal([...s].every((ch) => ch.codePointAt(0) < 128), true, s);
    }
  });
});

describe('F9: fitPanelView for the new and the reworded keys (design F9 5.2)', () => {
  const body = (state, reason, panes = 1) => ({ fit: { state, reason, pane: { cols: 120, rows: 39 }, panes, userZoom: false } });
  const IDLE = { pending: false, note: false };
  const NOTE = 'nika could not fit the window just now. It tries again within 5 seconds.';
  const ROWS = [
    ['fitted:terminal', body('fitted', 'terminal'), 'Your terminal shows dots around this tmux window while this window has focus. Click into the terminal and it gets its own size back within a second.'],
    ['terminal:', body('terminal', null, 1), "Click into this window and nika sizes the tmux window to this panel; your terminal gets its size back when you click into it again. With no terminal on the window for 30 seconds, nika also sizes it to this panel by itself."],
    ['terminal:zoom', body('terminal', null, 3), 'Your terminal shows this pane zoomed too, until this session window closes. Click into this window and nika sizes the tmux window to this panel.'],
    ['terminal:switching', body('terminal', 'switching', 1), 'nika sizes the tmux window to this panel again within a minute while this window keeps focus.'],
  ];

  for (const [key, b, hint] of ROWS) {
    test(`(+) ${key}: heading and why are the chip's label and title; the exact hint; no command; no action`, () => {
      const view = chipView(b);
      assert.equal(view.key, key);
      const p = fitPanelView(view, IDLE);
      assert.equal(p.heading, view.label);
      assert.equal(p.why, view.title);
      assert.equal(p.hint, hint);
      assert.equal(p.code, null);
      assert.equal(p.action, null);
      assert.equal(p.note, null);
    });

    test(`(−) ${key}: a pending request never gives it a button; the note shows its sentence; every string is plain ASCII`, () => {
      const view = chipView(b);
      assert.equal(fitPanelView(view, { pending: true, note: true }).action, null);
      assert.equal(fitPanelView(view, { pending: false, note: true }).note, NOTE);
      const p = fitPanelView(view, { pending: true, note: true });
      for (const s of [p.heading, p.why, p.hint, p.note]) assert.equal([...s].every((ch) => ch.codePointAt(0) < 128), true, s);
    });
  }

  test('(−) the hint of `fitted:` stays none: only the new key has the dots line', () => {
    const p = fitPanelView(chipView(body('fitted', null)), IDLE);
    assert.deepEqual([p.hint, p.code, p.action], [null, null, null]);
  });

  test('(−) a made-up variant of the new keys has no hint, no code and no action', () => {
    const view = chipView(body('fitted', 'terminal'));
    for (const key of ['fitted:Terminal', 'fitted:terminal ', 'fitted:switching', 'terminal:Switching', 'terminal:switching:', 'terminal:terminal']) {
      const p = fitPanelView({ ...view, key }, IDLE);
      assert.deepEqual([p.hint, p.code, p.action], [null, null, null], key);
    }
  });

  test('(−) nothing the server said reaches the panel of the new keys', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    for (const [state, reason] of [['fitted', 'terminal'], ['terminal', 'switching']]) {
      const p = fitPanelView(chipView({ fit: { state, reason, message: hostile, pane: { cols: hostile, rows: 1 }, panes: hostile }, message: hostile }), IDLE);
      assert.doesNotMatch(JSON.stringify(p), /img|onerror/, state);
    }
  });
});

describe('F9: createFitPlanner, the focus the page sends (design F9 3.3, 3.4)', () => {
  const focusOf = (r) => r.log.sent.map((b) => b.focus);
  /** Started, with a size, the first request answered fitted; the page has `focus`. */
  const started = async (focus = true, opts = {}) => {
    const r = rig({ focus, ...opts });
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK());
    return r;
  };

  // F10 (requirement change, not a weakened test): the owner's Q2 answer of 2026-11-16 replaces F9's 400 / 200 with 150 / 150
  test('(+) the three timings are the owner\'s F10 Q2: focus 150 ms, blur 150 ms, a poll every second', () => {
    assert.deepEqual([FOCUS_SETTLE_MS, BLUR_SETTLE_MS, FOCUS_POLL_MS], [150, 150, 1000]);
  });

  // -- what the first body carries
  test('(+) the first body carries focus from io.focused(), true and false alike', async () => {
    for (const focus of [true, false]) {
      const r = rig({ focus });
      r.planner.size(100, 30);
      r.planner.start();
      assert.deepEqual(r.log.sent, [{ cols: 100, rows: 30, open: true, focus }]);
    }
  });

  test('(+) io.focused missing, throwing, or answering anything but the boolean true is focus: false (a page that cannot tell holds nothing)', async () => {
    const missing = rig({ noFocusIo: true });
    missing.planner.size(100, 30);
    missing.planner.start();
    assert.deepEqual(missing.log.sent, [{ cols: 100, rows: 30, open: true, focus: false }]);

    const throws = rig({ focus: true });
    throws.page.throws = true;
    throws.planner.size(100, 30);
    assert.doesNotThrow(() => throws.planner.start());
    assert.deepEqual(throws.log.sent, [{ cols: 100, rows: 30, open: true, focus: false }]);

    for (const odd of [1, 'true', {}, [], null, undefined, 'yes']) {
      const r = rig({ focus: odd });
      r.planner.size(100, 30);
      r.planner.start();
      assert.equal(r.log.sent[0].focus, false, JSON.stringify(odd));
    }
  });

  test('(+) every later body carries the settled focus too: a size change and a heartbeat', async () => {
    const r = await started(true);
    r.planner.size(110, 30);
    await r.clk.advance(DEBOUNCE_MS);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS);
    assert.deepEqual(focusOf(r), [true, true, true]);
  });

  // -- blur and focus settle, then go out at once
  test('(+) blur: exactly one PUT focus: false at +150 ms, not waiting for the 5 s beat', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false);
    await r.clk.advance(BLUR_SETTLE_MS - 1);
    assert.equal(r.log.sent.length, 1, '149 ms: still settling');
    await r.clk.advance(1);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false, focus: false }]);
    await r.answer(OK());
    await r.clk.advance(BEAT_MS - BLUR_SETTLE_MS - 1);
    assert.equal(r.log.sent.length, 2, 'and nothing else before the beat');
  });

  test('(+) focus: exactly one PUT focus: true at +150 ms', async () => {
    const r = await started(false);
    r.page.focus = true;
    r.planner.focusChanged(false);
    await r.clk.advance(FOCUS_SETTLE_MS - 1);
    assert.equal(r.log.sent.length, 1, '149 ms: still settling');
    await r.clk.advance(1);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false, focus: true }]);
  });

  test('(−) blur then focus within 150 ms sends nothing, and the settle timer is gone', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false);
    await r.clk.advance(100);
    r.page.focus = true;
    r.planner.focusChanged(false);
    await r.clk.advance(BEAT_MS - 100 - 1);
    assert.equal(r.log.sent.length, 1);
    assert.equal(r.clk.pending, 2, 'only the beat and the poll are left');
  });

  test('(−) focus then blur within 150 ms sends nothing', async () => {
    const r = await started(false);
    r.page.focus = true;
    r.planner.focusChanged(false);
    await r.clk.advance(100);
    r.page.focus = false;
    r.planner.focusChanged(false);
    await r.clk.advance(BEAT_MS - 100 - 1);
    assert.equal(r.log.sent.length, 1);
    assert.equal(r.clk.pending, 2);
  });

  test('(−) a flick the events missed: the settle reads again when it ends, and a value that went back sends nothing', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false); // the blur event
    await r.clk.advance(100);
    r.page.focus = true; // the focus came back with no event at all
    await r.clk.advance(BLUR_SETTLE_MS);
    assert.equal(r.log.sent.length, 1);
  });

  test('(+) a change called twice in the same direction keeps its first settle (150 ms from the first call, not from the second)', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false);
    await r.clk.advance(100);
    r.planner.focusChanged(false);
    await r.clk.advance(50);
    assert.deepEqual(focusOf(r), [true, false]);
  });

  test('(+) a settle that changed direction starts over: blur, focus, blur again sends at 150 ms after the last blur', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false);
    await r.clk.advance(100);
    r.page.focus = true;
    r.planner.focusChanged(false);
    await r.clk.advance(50);
    r.page.focus = false;
    r.planner.focusChanged(false);
    await r.clk.advance(BLUR_SETTLE_MS - 1);
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(focusOf(r), [true, false]);
  });

  test('(+) hidden: focusChanged(true) sends at once, with no settle', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(true);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false, focus: false }]);
  });

  test('(−) hidden while a blur is settling: the immediate send wins and the old settle does not send a second one', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false);
    await r.clk.advance(100);
    r.planner.focusChanged(true);
    assert.equal(r.log.sent.length, 2);
    await r.answer(OK());
    await r.clk.advance(BLUR_SETTLE_MS);
    assert.equal(r.log.sent.length, 2);
  });

  test('(−) a focusChanged with the value the planner already holds sends nothing, immediate or not', async () => {
    const r = await started(true);
    r.planner.focusChanged(false);
    r.planner.focusChanged(true);
    await r.clk.advance(BLUR_SETTLE_MS + FOCUS_SETTLE_MS);
    assert.equal(r.log.sent.length, 1);
  });

  test('(−) focusChanged before start() sends nothing and arms nothing', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.focusChanged(false); // would start a settle
    assert.equal(r.clk.pending, 0, 'no settle timer before start()');
    r.planner.focusChanged(true);
    r.planner.focusChanged(false);
    await r.clk.advance(60000);
    assert.deepEqual(r.log.sent, []);
    assert.equal(r.clk.pending, 0);
  });

  // -- the poll
  test('(+) a change with no event at all: the 1 s poll starts the settle, then the PUT follows', async () => {
    const r = await started(true);
    r.page.focus = false;
    await r.clk.advance(FOCUS_POLL_MS - 1);
    assert.equal(r.log.sent.length, 1, 'before the poll');
    await r.clk.advance(1);
    assert.equal(r.log.sent.length, 1, 'the poll started the settle, it did not send');
    await r.clk.advance(BLUR_SETTLE_MS - 1);
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(focusOf(r), [true, false]);
  });

  test('(+) the poll keeps going: a second missed change is caught a second after the first', async () => {
    const r = await started(true);
    r.page.focus = false;
    await r.clk.advance(FOCUS_POLL_MS + BLUR_SETTLE_MS);
    await r.answer(OK());
    r.page.focus = true;
    await r.clk.advance(FOCUS_POLL_MS + FOCUS_SETTLE_MS);
    assert.deepEqual(focusOf(r), [true, false, true]);
  });

  test('(−) a blur that settled and was acknowledged is not sent again when the poll falls a moment later (no second settle, no early send)', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false); // t = 0, settle ends at 200
    await r.clk.advance(FOCUS_POLL_MS - 1); // the settle has sent by now
    await r.answer(OK());
    await r.clk.advance(1); // the poll: the value is settled and acked
    assert.deepEqual(focusOf(r), [true, false]);
  });

  // -- a request in flight
  test('(+) a focus change while a request is in flight goes out right after its 200 (never two in flight)', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.start(); // in flight
    r.page.focus = false;
    r.planner.focusChanged(true);
    assert.equal(r.log.sent.length, 1, 'nothing overtakes the request in flight');
    assert.equal(r.inFlight, 1);
    await r.answer(OK());
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false, focus: false }]);
    assert.equal(r.inFlight, 1);
  });

  test('(−) a refusal of the request in flight does not drop the waiting focus change: the poll sends it within a second', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.start();
    r.page.focus = false;
    r.planner.focusChanged(true);
    await r.answer({ status: 409, body: { error: 'busy' } });
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(FOCUS_POLL_MS);
    assert.deepEqual(focusOf(r), [true, false]);
  });

  // -- refused or lost focus changes
  test('(+) a focus change that was refused (409, 429, 502, lost) is sent again by the next poll, at most once a second, despite the hold', async () => {
    for (const reply of [{ status: 409, body: { error: 'busy' } }, { status: 429, body: { error: 'busy' } }, { status: 502, body: { error: 'tmux_failed' } }, { status: 0, body: null }]) {
      const r = await started(false);
      r.page.focus = true;
      r.planner.focusChanged(true);
      await r.answer(reply);
      assert.equal(r.log.sent.length, 2, `status ${reply.status}: no instant retry`);
      await r.clk.advance(FOCUS_POLL_MS - 1);
      assert.equal(r.log.sent.length, 2, `status ${reply.status}: not before the poll`);
      await r.clk.advance(1);
      assert.deepEqual(focusOf(r), [false, true, true], `status ${reply.status}`);
      await r.answer(OK());
      await r.clk.advance(FOCUS_POLL_MS * 3);
      assert.equal(r.log.sent.length, 3, `status ${reply.status}: once acknowledged it is not sent again`);
    }
  });

  test('(+) a rejecting send is a lost request for a focus change too: the poll sends it again', async () => {
    const r = await started(false);
    r.page.focus = true;
    r.planner.focusChanged(true);
    await r.fail();
    await r.clk.advance(FOCUS_POLL_MS);
    assert.deepEqual(focusOf(r), [false, true, true]);
  });

  test('(−) a refused size-only request still waits for the beat: the poll does not resend it', async () => {
    const r = await started(true);
    r.planner.size(110, 30);
    await r.clk.advance(DEBOUNCE_MS);
    await r.answer({ status: 409, body: { error: 'busy' } });
    await r.clk.advance(BEAT_MS - DEBOUNCE_MS - 1);
    assert.equal(r.log.sent.length, 2, 'the polls fell and sent nothing');
    await r.clk.advance(1);
    assert.equal(r.log.sent.length, 3, 'the beat asks again');
  });

  test('(−) a first request that was refused is not resent by the poll either: only the beat asks again', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 409, body: { error: 'busy' } });
    await r.clk.advance(BEAT_MS - 1);
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(1);
    assert.equal(r.log.sent.length, 2);
  });

  test('(+) a focus change clears the hold a refused size request left: it goes out at its settle, not at the beat', async () => {
    const r = rig({ focus: false });
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 409, body: { error: 'busy' } });
    r.page.focus = true;
    r.planner.focusChanged(false);
    await r.clk.advance(FOCUS_SETTLE_MS);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: true, focus: true }]);
  });

  // -- the beat
  test('(+) the beat carries a changed hasFocus() with no settle: the window shown again is settled enough', async () => {
    const r = await started(false);
    r.page.focus = true; // no event reached the planner
    r.planner.beat();
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: false, focus: true }]);
  });

  test('(+) the 5 s heartbeat carries it too, and it ends a settle that was running', async () => {
    const r = await started(true);
    await r.clk.advance(BEAT_MS - 100);
    r.page.focus = false;
    r.planner.focusChanged(false); // settles until BEAT_MS + 100
    await r.clk.advance(100);
    assert.deepEqual(focusOf(r), [true, false], 'the beat sent it before the settle ended');
    assert.equal(r.clk.pending, 2, 'the settle timer was cancelled by the beat: only the beat and the poll are left');
    await r.answer(OK());
    await r.clk.advance(BLUR_SETTLE_MS);
    assert.equal(r.log.sent.length, 2, 'and the cancelled settle sends nothing more');
  });

  test('(+) a beat that adopts a new focus while a request is in flight queues it for after the 200', async () => {
    const r = rig({ focus: false });
    r.planner.size(100, 30);
    r.planner.start();
    r.page.focus = true;
    r.planner.beat();
    assert.equal(r.log.sent.length, 1);
    await r.answer(OK());
    assert.deepEqual(focusOf(r), [false, true]);
  });

  // -- the chip is told quietly
  test('(+) the chip of an answer to a focus-change request is told { quiet: true }', async () => {
    const r = await started(true);
    assert.deepEqual(r.log.quiet, [false], 'the first answer');
    r.page.focus = false;
    r.planner.focusChanged(true);
    await r.answer(OK('terminal'));
    assert.deepEqual(r.log.chips.map((v) => v.key), ['fitted:', 'terminal:zoom']);
    assert.deepEqual(r.log.quiet, [false, true]);
    r.page.focus = true;
    r.planner.focusChanged(true);
    await r.answer(OK('fitted'));
    assert.deepEqual(r.log.quiet, [false, true, true]);
  });

  test('(−) the first answer, a size answer and a beat answer are told { quiet: false }', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(OK('fitted'));
    r.planner.size(110, 30);
    await r.clk.advance(DEBOUNCE_MS);
    await r.answer(OK('zoomed', 'panel-smaller'));
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('blocked', 'user-zoom'));
    assert.deepEqual(r.log.chips.map((v) => v.key), ['fitted:', 'zoomed:', 'blocked:user-zoom']);
    assert.deepEqual(r.log.quiet, [false, false, false]);
  });

  test('(−) a state change that arrives with the same focus as the answer before it is not quiet, even right after a focus change', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(true);
    await r.answer(OK('fitted')); // acknowledged, same key: no chip call
    await r.clk.advance(BEAT_MS);
    await r.answer(OK('zoomed', 'panel-smaller')); // a beat at the same focus
    assert.deepEqual(r.log.quiet, [false, false]);
  });

  test('(−) the answer to the user\'s Fit again is never quiet (the user asked, so the chip is announced)', async () => {
    const r = await started(false);
    r.page.focus = true; // the click on the chip gave focus; the settle has not ended
    r.planner.focusChanged(false);
    assert.equal(r.planner.reopen(), true); // the beat adopts the focus, and the ask goes out with it
    assert.equal(r.log.sent.at(-1).open, true);
    assert.equal(r.log.sent.at(-1).focus, true);
    await r.answer(OK('zoomed', 'panel-smaller'));
    assert.deepEqual(r.log.quiet.at(-1), false);
  });

  test('(−) hiding the chip (close, 403) tells io.chip(null) with no options', async () => {
    const r = await started(true);
    r.planner.close();
    assert.equal(r.log.chips.at(-1), null);
    assert.equal(r.log.quiet.length, 1, 'the null call carried no { quiet }');
  });

  // -- over for good
  test('(−) after close(): focus events, the poll and a settle in progress send nothing, and no timer is left', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(false); // a settle is running
    r.planner.close();
    assert.equal(r.clk.pending, 0, 'the settle, the poll and the beat are all cancelled');
    r.planner.focusChanged(true);
    r.planner.focusChanged(false);
    r.page.focus = true;
    await r.clk.advance(60000);
    assert.equal(r.log.sent.length, 1);
    assert.equal(r.clk.pending, 0);
  });

  test('(−) after a 403: focus events, the poll and a settle in progress send nothing, and no timer is left', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.start();
    r.page.focus = false;
    r.planner.focusChanged(false); // a settle is running
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    assert.equal(r.clk.pending, 0, 'the settle, the poll and the beat are all cancelled');
    r.planner.focusChanged(true);
    r.page.focus = true;
    r.planner.focusChanged(false);
    r.planner.beat();
    await r.clk.advance(60000);
    assert.equal(r.log.sent.length, 1);
    assert.equal(r.clk.pending, 0);
  });

  test('(−) a 403 drops the waiting focus change: nothing is sent after the 403 answer', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.start();
    r.page.focus = false;
    r.planner.focusChanged(true); // waits behind the request in flight
    await r.answer({ status: 403, body: { error: 'forbidden' } });
    await r.clk.advance(60000);
    assert.equal(r.log.sent.length, 1);
  });

  test('(−) close() drops the waiting focus change: a start() after it sends the focus it reads then, once', async () => {
    const r = rig({ focus: true });
    r.planner.size(100, 30);
    r.planner.start();
    r.page.focus = false;
    r.planner.focusChanged(true); // due, behind the request in flight
    r.planner.close();
    await r.answer(OK()); // the old lease's answer
    assert.equal(r.log.sent.length, 1);
    r.page.focus = true;
    r.planner.start();
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 100, rows: 30, open: true, focus: true }], 'no 200 had answered the first request, so the new lease opens');
    await r.answer(OK());
    assert.equal(r.log.sent.length, 2, 'the dropped change did not come back');
  });

  test('(+) start() after close() and restart() read the focus fresh, and the poll runs again', async () => {
    const r = await started(true);
    r.planner.close();
    r.page.focus = false;
    r.planner.restart();
    assert.equal(r.log.sent.at(-1).focus, false);
    await r.answer(OK());
    assert.deepEqual(r.log.quiet, [false, false], 'the first answer of the new lease is not quiet, although the focus differs from the old lease\'s last one');
    r.page.focus = true;
    await r.clk.advance(FOCUS_POLL_MS + FOCUS_SETTLE_MS);
    assert.equal(r.log.sent.at(-1).focus, true, 'the poll of the new lease caught a missed change');
  });

  test('(+) a focus change that is acknowledged is not sent again by the poll, however long the page stays', async () => {
    const r = await started(true);
    r.page.focus = false;
    r.planner.focusChanged(true);
    await r.answer(OK());
    await r.clk.advance(FOCUS_POLL_MS * 4);
    assert.equal(r.log.sent.length, 2);
  });

  test('(+) io.focused throwing after the start reads as no focus: the poll sees a blur and sends it', async () => {
    const r = await started(true);
    r.page.throws = true;
    await r.clk.advance(FOCUS_POLL_MS + BLUR_SETTLE_MS);
    assert.deepEqual(focusOf(r), [true, false]);
  });
});

// ---- F10 (design F10 2 to 6, 8.2): steady size, room for the footer, the redraw hold ------------------------------------------------

describe('F10: the constants and the file (design F10 9)', () => {
  test('(+) the new constants have the design\'s values; the transition is at most 150 ms', () => {
    assert.deepEqual([HOLD_MS, HOLD_POLL_MS, ROOM_ROWS, REFIT_MS], [1200, 100, 33, 120]);
    assert.ok(REFIT_MS <= 150);
  });

  test('(+) fit-ui.js stays ASCII and has no DOM', () => {
    const src = readSrc('fit-ui.js');
    assert.equal([...src].every((ch) => ch.codePointAt(0) < 128), true);
    // comments and quoted sentences are not code: F15's chip title says "this tmux window. With focus ..." (the owner's words), which is not a DOM access
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    assert.doesNotMatch(code, /\b(document|window|navigator|globalThis)\s*[.[]|localStorage|getElementById|querySelector|addEventListener|createElement|\bfetch\s*\(/);
    assert.match("x = window.document;", /\b(document|window|navigator|globalThis)\s*[.[]/, 'the pattern still sees real code');
  });
});

describe('F10: remeasure, when the panel is measured again (design F10 2.2)', () => {
  const F = { cols: 100, rows: 30, width: 827, height: 562, cellW: 8, cellH: 18, iw: 1200, ih: 800 };
  const next = (over) => ({ ...F, ...over });

  test('(+) no previous frame: measure', () => {
    assert.equal(remeasure(null, F), true);
    assert.equal(remeasure(undefined, F), true);
  });

  test('(+) the window\'s inner width or height changed', () => {
    assert.equal(remeasure(F, next({ iw: 1201 })), true);
    assert.equal(remeasure(F, next({ ih: 799 })), true);
  });

  test('(+) the cell changed by more than 0.01 px (a font or zoom change)', () => {
    assert.equal(remeasure(F, next({ cellW: 8.02 })), true);
    assert.equal(remeasure(F, next({ cellH: 17.98 })), true);
  });

  test('(+) the width changed by one cell or more, either way (the transcript toggle, the narrow tabs)', () => {
    assert.equal(remeasure(F, next({ width: 827 + 8 })), true);
    assert.equal(remeasure(F, next({ width: 827 - 80 })), true);
  });

  test('(−) a change of the height alone with the same window size is never a commit (a composer line, a banner, a prompt panel, the textarea)', () => {
    for (const height of [562 - 18, 562 + 300, 562 - 400, 1]) assert.equal(remeasure(F, next({ height })), false, String(height));
  });

  test('(−) a width change of less than one cell is not one either; nor is a cell change of 0.01 or less', () => {
    assert.equal(remeasure(F, next({ width: 827 + 7.99 })), false);
    assert.equal(remeasure(F, next({ width: 827 - 7.99 })), false);
    assert.equal(remeasure(F, next({ cellW: 8.005 })), false);
    assert.equal(remeasure(F, next({ cellH: 18.005 })), false);
  });

  test('(−) an identical frame, and a frame that could not be measured, are not commits', () => {
    assert.equal(remeasure(F, { ...F }), false);
    assert.equal(remeasure(F, null), false);
    assert.equal(remeasure(F, undefined), false);
  });
});

describe('F10: askSize, the size the page asks for (design F10 3.3)', () => {
  const frame = { cols: 145, rows: 22 };

  test('(−) the columns never go below the frame\'s, even for a frame wider than the cap (the room only adds rows)', () => {
    assert.deepEqual(askSize({ cols: 500, rows: 20 }, true, 0), { cols: 500, rows: 33 });
    assert.deepEqual(askSize({ cols: 400, rows: 32 }, true, 1), { cols: 400, rows: 33 });
  });

  test('(+) room on, 22 rows, 145 columns, border row 1: 33 rows and 210 columns (the panel\'s proportion)', () => {
    assert.deepEqual(askSize(frame, true, 1), { cols: 210, rows: 33 });
  });

  test('(+) border row 0: 217 columns', () => {
    assert.deepEqual(askSize(frame, true, 0), { cols: 217, rows: 33 });
  });

  test('(+) the columns are capped at 400', () => {
    assert.deepEqual(askSize({ cols: 390, rows: 12 }, true, 1), { cols: 400, rows: 33 });
  });

  test('(−) room off: the frame, whatever d is', () => {
    assert.deepEqual(askSize(frame, false, 1), { cols: 145, rows: 22 });
    assert.deepEqual(askSize(frame, undefined, 0), { cols: 145, rows: 22 });
  });

  test('(−) a frame that already has 33 rows or more: the frame, even with room on', () => {
    assert.deepEqual(askSize({ cols: 145, rows: 33 }, true, 1), { cols: 145, rows: 33 });
    assert.deepEqual(askSize({ cols: 145, rows: 45 }, true, 1), { cols: 145, rows: 45 });
  });

  test('(−) d outside 0..1 (or not a number) is treated as 0', () => {
    for (const d of [2, -1, 1.5, NaN, null, undefined, '1']) assert.deepEqual(askSize(frame, true, d), { cols: 217, rows: 33 }, String(d));
  });

  test('(−) the columns are never below the frame\'s', () => {
    for (const rows of [10, 22, 32]) {
      const out = askSize({ cols: 145, rows }, true, 1);
      assert.ok(out.cols >= 145, String(rows));
      assert.equal(out.rows, 33);
    }
  });

  test('(+) the asked size is always one the route accepts (40..400 columns, 10..200 rows)', () => {
    const out = askSize({ cols: 40, rows: 10 }, true, 1);
    assert.ok(out.cols >= 40 && out.cols <= 400 && out.rows >= 10 && out.rows <= 200);
  });
});

describe('F10: frameReady, a frame that shows Claude\'s input box at the answered size (design F10 4.3)', () => {
  const want = { cols: 210, rows: 32 };
  const rows = new Array(32).fill([]);
  const body = (over = {}) => ({ cols: 210, rows, alt: true, prompt: null, dialog: null, ...over });
  const BOX = { state: 'empty' };

  test('(+) the new size with a readable input box', () => {
    assert.equal(frameReady({ body: body(), draft: BOX, want, plainBefore: true }), true);
  });

  test('(+) the new size with a prompt', () => {
    assert.equal(frameReady({ body: body({ prompt: { question: 'x', options: [] } }), draft: null, want, plainBefore: true }), true);
  });

  test('(+) the new size with a dialog', () => {
    assert.equal(frameReady({ body: body({ dialog: { state: 'unreadable' } }), draft: null, want, plainBefore: true }), true);
  });

  test('(+) the new size, not in the full-screen view (alt false)', () => {
    assert.equal(frameReady({ body: body({ alt: false }), draft: null, want, plainBefore: true }), true);
  });

  test('(+) the new size, no box, but there was no box to wait for (!plainBefore)', () => {
    assert.equal(frameReady({ body: body(), draft: null, want, plainBefore: false }), true);
  });

  test('(−) the old size, even with a box: the resize has not shown yet', () => {
    assert.equal(frameReady({ body: body({ cols: 138 }), draft: BOX, want, plainBefore: true }), false);
    assert.equal(frameReady({ body: body({ rows: new Array(20).fill([]) }), draft: BOX, want, plainBefore: true }), false);
  });

  test('(−) the new size, alt true, no draft, prompt or dialog, plainBefore: Claude has not repainted', () => {
    assert.equal(frameReady({ body: body(), draft: null, want, plainBefore: true }), false);
    assert.equal(frameReady({ body: body(), draft: undefined, want, plainBefore: true }), false);
  });

  test('(−) no want (the room step waits for its answer), no body, rows that are not a list: never ready', () => {
    assert.equal(frameReady({ body: body(), draft: BOX, want: null, plainBefore: false }), false);
    assert.equal(frameReady({ body: null, draft: BOX, want, plainBefore: false }), false);
    assert.equal(frameReady({ body: body({ rows: 'x' }), draft: BOX, want, plainBefore: false }), false);
    assert.equal(frameReady(), false);
  });

  // F12 (owner decision 2026-11-16): Claude's mode line was readable before nika's resize; a frame with the box but without it is not finished
  test('(+) F12: modeBefore, a readable box, but the mode line is gone (modeConfirmed false or not true): not ready; ready once modeConfirmed is true', () => {
    for (const modeConfirmed of [false, undefined, null, 'true', 1]) {
      assert.equal(frameReady({ body: body({ mode: 'auto', modeConfirmed }), draft: BOX, want, plainBefore: true, modeBefore: true }), false, String(modeConfirmed));
    }
    assert.equal(frameReady({ body: body({ mode: 'auto', modeConfirmed: true }), draft: BOX, want, plainBefore: true, modeBefore: true }), true);
  });

  test('(−) F12: without modeBefore (false, absent, anything but true) F10\'s rule holds: a box alone is ready, whatever modeConfirmed says', () => {
    for (const modeBefore of [false, undefined, null, 0, 1, 'true']) {
      for (const modeConfirmed of [false, true, undefined]) {
        assert.equal(frameReady({ body: body({ mode: 'auto', modeConfirmed }), draft: BOX, want, plainBefore: true, modeBefore }), true, `${String(modeBefore)} / ${String(modeConfirmed)}`);
      }
    }
  });

  test('(−) F12: modeBefore changes no other exit: a prompt, a dialog, no full-screen view and !plainBefore are ready with the mode line gone', () => {
    const gone = { mode: 'auto', modeConfirmed: false };
    assert.equal(frameReady({ body: body({ ...gone, prompt: { question: 'x', options: [] } }), draft: null, want, plainBefore: true, modeBefore: true }), true, 'prompt');
    assert.equal(frameReady({ body: body({ ...gone, dialog: { state: 'unreadable' } }), draft: null, want, plainBefore: true, modeBefore: true }), true, 'dialog');
    assert.equal(frameReady({ body: body({ ...gone, alt: false }), draft: null, want, plainBefore: true, modeBefore: true }), true, 'not full-screen');
    assert.equal(frameReady({ body: body(gone), draft: BOX, want, plainBefore: false, modeBefore: true }), true, '!plainBefore');
  });

  test('(−) F12: modeBefore with no readable box is still not ready (as before), and the size rule still comes first', () => {
    assert.equal(frameReady({ body: body({ mode: 'auto', modeConfirmed: true }), draft: null, want, plainBefore: true, modeBefore: true }), false);
    assert.equal(frameReady({ body: body({ cols: 138, mode: 'auto', modeConfirmed: true }), draft: BOX, want, plainBefore: true, modeBefore: true }), false);
  });
});

describe('F10: roomStep, one more resize when the footer did not come back (design F10 3.1)', () => {
  const want = { cols: 138, rows: 20 };
  const base = () => ({
    room: false, frameRows: 22, state: 'fitted', plainBefore: true, want, gain: true, // F11 (requirement change, not a weakened test): the room step needs the extra rows too
    body: { cols: 138, rows: new Array(20).fill([]), alt: true, prompt: null, dialog: null }, draft: null,
  });

  test('(+) every condition true: take the step', () => {
    assert.equal(roomStep(base()), true);
  });

  const each = [
    ['room is already on (at most one step per window)', { room: true }],
    ['the frame already has 33 rows', { frameRows: 33 }],
    ['the frame has more than 33 rows', { frameRows: 45 }],
    ['the chip state is zoomed', { state: 'zoomed' }],
    ['the chip state is terminal', { state: 'terminal' }],
    ['the chip state is blocked', { state: 'blocked' }],
    ['the chip state is other', { state: 'other' }],
    ['no chip state yet', { state: null }],
    ['there was no readable box before (!plainBefore)', { plainBefore: false }],
    ['there is no capture', { body: null }],
    ['the capture is not at the answered size (columns)', { body: { cols: 171, rows: new Array(20).fill([]), alt: true, prompt: null, dialog: null } }],
    ['the capture is not at the answered size (rows)', { body: { cols: 138, rows: new Array(45).fill([]), alt: true, prompt: null, dialog: null } }],
    ['a prompt is on screen', { body: { cols: 138, rows: new Array(20).fill([]), alt: true, prompt: { question: 'x', options: [] }, dialog: null } }],
    ['a dialog is on screen', { body: { cols: 138, rows: new Array(20).fill([]), alt: true, prompt: null, dialog: { state: 'unreadable' } } }],
    ['Claude is not in its full-screen view', { body: { cols: 138, rows: new Array(20).fill([]), alt: false, prompt: null, dialog: null } }],
    ['a readable draft is present (the box is there)', { draft: { state: 'empty' } }],
    ['no answered size', { want: null }],
  ];
  for (const [why, over] of each) {
    test(`(−) not when ${why}`, () => {
      assert.equal(roomStep({ ...base(), ...over }), false);
    });
  }

  test('(−) the frame needs a number of rows', () => {
    assert.equal(roomStep({ ...base(), frameRows: undefined }), false);
    assert.equal(roomStep(), false);
  });

  // F12 (owner decision 2026-11-16): the box is readable, but the mode line Claude showed before nika's resize is off the screen
  describe('F12: the mode line fell off the screen while the box stayed readable', () => {
    const gone = () => ({
      ...base(), modeBefore: true, draft: { state: 'empty' },
      body: { cols: 138, rows: new Array(20).fill([]), alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: false },
    });
    const withBody = (over) => ({ ...gone(), body: { ...gone().body, ...over } });

    test('(+) a readable box, modeBefore, modeConfirmed false or not true: take the step', () => {
      assert.equal(roomStep(gone()), true);
      for (const modeConfirmed of [undefined, null, 'true', 1]) assert.equal(roomStep(withBody({ modeConfirmed })), true, String(modeConfirmed));
    });

    test('(+) the old rule stays: no readable box takes the step with or without modeBefore, whatever the capture says about the mode', () => {
      assert.equal(roomStep({ ...gone(), draft: null }), true);
      assert.equal(roomStep({ ...gone(), draft: null, modeBefore: false, body: { ...gone().body, modeConfirmed: true } }), true);
      assert.equal(roomStep(base()), true);
    });

    const each = [
      ['the mode line is confirmed on the capture', withBody({ modeConfirmed: true })],
      ['modeBefore is false', { ...gone(), modeBefore: false }],
      ['modeBefore is absent', (() => { const g = gone(); delete g.modeBefore; return g; })()],
      ['modeBefore is not exactly true', { ...gone(), modeBefore: 1 }],
      ['room is already on', { ...gone(), room: true }],
      ['gain is false (the room ask adds no rows)', { ...gone(), gain: false }],
      ['gain is not exactly true', { ...gone(), gain: 1 }],
      ['the frame already has 33 rows', { ...gone(), frameRows: 33 }],
      ['the chip state is zoomed', { ...gone(), state: 'zoomed' }],
      ['there was no readable box before (!plainBefore)', { ...gone(), plainBefore: false }],
      ['the capture is not at the answered size (rows)', withBody({ rows: new Array(45).fill([]) })],
      ['the capture is not at the answered size (columns)', withBody({ cols: 171 })],
      ['Claude is not in its full-screen view', withBody({ alt: false })],
      ['a prompt is on screen', withBody({ prompt: { question: 'x', options: [] } })],
      ['a dialog is on screen', withBody({ dialog: { state: 'unreadable' } })],
      ['no capture', { ...gone(), body: null }],
      ['no answered size', { ...gone(), want: null }],
    ];
    for (const [why, args] of each) {
      test(`(−) not when ${why}`, () => {
        assert.equal(roomStep(args), false);
      });
    }
  });
});

describe('F10: refitFrom, where the zoom starts (design F10 6.2)', () => {
  test('(+) text that grows starts from the old size, never below half', () => {
    assert.equal(refitFrom(0.49, 1), 0.5);
    assert.equal(refitFrom(0.8, 1), 0.8);
    assert.ok(Math.abs(refitFrom(0.66, 0.75) - 0.88) < 1e-9);
  });

  test('(−) text that gets smaller or stays: 1 (a fade only, no transform above 1)', () => {
    assert.equal(refitFrom(1, 0.5), 1);
    assert.equal(refitFrom(0.6, 0.6), 1);
  });

  test('(−) a value that is not a positive number gives 1', () => {
    for (const bad of [NaN, 0, -1, Infinity, undefined, null, '0.5']) {
      assert.equal(refitFrom(bad, 1), 1, `old ${String(bad)}`);
      assert.equal(refitFrom(0.5, bad), 1, `new ${String(bad)}`);
    }
  });
});

describe('F10: createRedrawHold, the last good frame stays until Claude has repainted (design F10 4)', () => {
  const WANT = { cols: 210, rows: 32 };
  const rows = new Array(32).fill([]);
  const cap = (over = {}) => ({ body: { cols: 210, rows, alt: true, prompt: null, dialog: null }, draft: null, ...over });
  const ready = () => cap({ draft: { state: 'empty' } });
  const make = (opts = {}) => {
    const clk = clock();
    const log = { timeouts: [], ended: 0 };
    const hold = createRedrawHold({
      after: clk.after,
      cancel: clk.cancel,
      timeout: opts.timeout ?? ((pending, ctx) => log.timeouts.push([pending, ctx])),
      ended: () => { log.ended += 1; },
    });
    return { hold, clk, log, waiter() { const w = { done: false }; hold.wait().then(() => { w.done = true; }); return w; } };
  };

  test('(+) start, then a ready offer: apply, the hold is over, waiters resolve, ended is told once', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true });
    assert.equal(r.hold.active, true);
    const w = r.waiter();
    await flush();
    assert.equal(w.done, false);
    assert.equal(r.hold.offer(ready()), 'apply');
    await flush();
    assert.deepEqual([r.hold.active, w.done, r.log.ended], [false, true, 1]);
  });

  test('(−) ending the hold cancels its timer with the timer it was given: nothing fires later, io.timeout is not called', async () => {
    const clk = clock();
    const cancelled = [];
    const hold = createRedrawHold({ after: clk.after, cancel: (t) => { cancelled.push(t); clk.cancel(t); }, timeout: () => { throw new Error('timeout must not run'); } });
    hold.start({ want: WANT, plainBefore: true });
    hold.end();
    assert.equal(cancelled.length, 1, 'the one timer was cancelled');
    await clk.advance(HOLD_MS * 2);
    assert.equal(hold.active, false);
    hold.start({ want: WANT, plainBefore: true });
    hold.offer(ready());
    assert.equal(cancelled.length, 2, 'a ready offer cancels it too');
  });

  test('(+) wait() with no hold resolves at once', async () => {
    const r = make();
    const w = r.waiter();
    await flush();
    assert.equal(w.done, true);
  });

  test('(+) the timeout at HOLD_MS calls io.timeout with the latest pending capture and the hold\'s want, plainBefore and modeBefore; the hold ends and waiters resolve', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true });
    const w = r.waiter();
    const first = cap();
    const second = cap();
    assert.equal(r.hold.offer(first), 'keep');
    assert.equal(r.hold.offer(second), 'keep');
    await r.clk.advance(HOLD_MS - 1);
    assert.deepEqual([r.log.timeouts.length, w.done, r.hold.active], [0, false, true], 'one millisecond before');
    await r.clk.advance(1);
    assert.equal(r.log.timeouts.length, 1);
    assert.equal(r.log.timeouts[0][0], second, 'the latest capture, not the first');
    // F12 (requirement change, not a weakened test): the timeout's context carries modeBefore too (false when the start gave none)
    // F16 (requirement change, not a weakened test): and cutBefore (false when the start gave none)
    assert.deepEqual(r.log.timeouts[0][1], { want: WANT, plainBefore: true, modeBefore: false, cutBefore: false });
    assert.deepEqual([w.done, r.hold.active, r.log.ended], [true, false, 1]);
  });

  test('(+) the timeout with no capture at all passes null', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true });
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.timeouts[0][0], null);
  });

  test('(+) a second start restarts the timer with the new want, and keeps plainBefore of the first start', async () => {
    const r = make();
    r.hold.start({ want: { cols: 100, rows: 20 }, plainBefore: true });
    await r.clk.advance(600);
    r.hold.start({ want: WANT, plainBefore: false });
    await r.clk.advance(HOLD_MS - 1);
    assert.equal(r.log.timeouts.length, 0, 'the timer began again at the second start');
    await r.clk.advance(1);
    assert.deepEqual(r.log.timeouts[0][1], { want: WANT, plainBefore: true, modeBefore: false, cutBefore: false }); // F12 (requirement change): modeBefore is in the context; F16: cutBefore too
  });

  // F12 (owner decision 2026-11-16)
  test('(+) F12: modeBefore is told to io.timeout, and a second start keeps the first start\'s modeBefore, as it keeps plainBefore', async () => {
    const a = make();
    a.hold.start({ want: { cols: 100, rows: 20 }, plainBefore: true, modeBefore: true });
    await a.clk.advance(600);
    a.hold.start({ want: WANT, plainBefore: false, modeBefore: false });
    await a.clk.advance(HOLD_MS);
    assert.deepEqual(a.log.timeouts[0][1], { want: WANT, plainBefore: true, modeBefore: true, cutBefore: false }, 'true stays true'); // F16 (requirement change): cutBefore is in the context
    const b = make();
    b.hold.start({ want: { cols: 100, rows: 20 }, plainBefore: true, modeBefore: false });
    b.hold.start({ want: WANT, plainBefore: true, modeBefore: true });
    await b.clk.advance(HOLD_MS);
    assert.deepEqual(b.log.timeouts[0][1], { want: WANT, plainBefore: true, modeBefore: false, cutBefore: false }, 'false stays false');
    const c = make();
    c.hold.start({ want: WANT, plainBefore: true, modeBefore: 'yes' });
    await c.clk.advance(HOLD_MS);
    assert.equal(c.log.timeouts[0][1].modeBefore, false, 'only exactly true counts');
  });

  test('(+) F12: with modeBefore a box without the mode line is kept; the next box with it is applied and ends the hold', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true, modeBefore: true });
    const w = r.waiter();
    const noMode = cap({ draft: { state: 'empty' }, body: { cols: 210, rows, alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: false } });
    const withMode = cap({ draft: { state: 'empty' }, body: { cols: 210, rows, alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: true } });
    assert.equal(r.hold.offer(noMode), 'keep');
    await flush();
    assert.deepEqual([r.hold.active, w.done], [true, false]);
    assert.equal(r.hold.offer(withMode), 'apply');
    await flush();
    assert.deepEqual([r.hold.active, w.done, r.log.ended], [false, true, 1]);
  });

  test('(+) F12: a box that never shows the mode line costs the whole HOLD_MS: the timeout is told the last such frame and modeBefore', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true, modeBefore: true });
    const noMode = cap({ draft: { state: 'empty' }, body: { cols: 210, rows, alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: false } });
    r.hold.offer(noMode);
    await r.clk.advance(HOLD_MS - 1);
    assert.equal(r.log.timeouts.length, 0, 'held for the full time');
    await r.clk.advance(1);
    assert.equal(r.log.timeouts[0][0], noMode);
    assert.equal(r.log.timeouts[0][1].modeBefore, true);
  });

  test('(−) F12: without modeBefore a box without the mode line is applied at once, as before', () => {
    for (const modeBefore of [undefined, false]) {
      const r = make();
      r.hold.start({ want: WANT, plainBefore: true, modeBefore });
      assert.equal(r.hold.offer(cap({ draft: { state: 'empty' }, body: { cols: 210, rows, alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: false } })), 'apply', String(modeBefore));
    }
  });

  test('(−) F12: a restart from io.timeout (the room step) keeps modeBefore, and a fresh hold after it starts clean', async () => {
    let n = 0;
    const r = make({ timeout: (pending, ctx) => { n += 1; if (n === 1) r.hold.start({ want: null, plainBefore: ctx.plainBefore, modeBefore: false }); } });
    r.hold.start({ want: WANT, plainBefore: true, modeBefore: true });
    await r.clk.advance(HOLD_MS);
    const noMode = cap({ draft: { state: 'empty' }, body: { cols: 210, rows, alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: false } });
    r.hold.start({ want: WANT, plainBefore: true, modeBefore: false }); // the room answer arrives
    assert.equal(r.hold.offer(noMode), 'keep', 'still waiting for the mode line');
    await r.clk.advance(HOLD_MS);
    assert.equal(r.hold.active, false);
    r.hold.start({ want: WANT, plainBefore: true, modeBefore: false }); // a later resize
    assert.equal(r.hold.offer(noMode), 'apply', 'the next hold has its own modeBefore');
  });

  test('(+) after a restart the new want decides what is ready', () => {
    const r = make();
    r.hold.start({ want: { cols: 100, rows: 20 }, plainBefore: true });
    r.hold.start({ want: WANT, plainBefore: true });
    assert.equal(r.hold.offer(cap({ body: { cols: 100, rows: new Array(20).fill([]), alt: true, prompt: null, dialog: null }, draft: { state: 'empty' } })), 'keep', 'the first want is gone');
    assert.equal(r.hold.offer(ready()), 'apply');
  });

  test('(+) io.timeout may start the hold again (the room step): the hold stays, waiters wait, ended is not told; the next timeout ends it', async () => {
    let n = 0;
    const r = make({ timeout: (pending, ctx) => { n += 1; if (n === 1) r.hold.start({ want: null, plainBefore: ctx.plainBefore }); } });
    r.hold.start({ want: WANT, plainBefore: true });
    const w = r.waiter();
    await r.clk.advance(HOLD_MS);
    assert.deepEqual([n, r.hold.active, w.done, r.log.ended], [1, true, false, 0]);
    assert.equal(r.hold.offer(ready()), 'keep', 'with no want nothing is ready');
    await r.clk.advance(HOLD_MS);
    assert.deepEqual([n, r.hold.active, w.done, r.log.ended], [2, false, true, 1]);
  });

  test('(−) offer while no hold runs: apply, and nothing is kept', async () => {
    const r = make();
    assert.equal(r.hold.offer(cap()), 'apply');
    r.hold.start({ want: WANT, plainBefore: true });
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.timeouts[0][0], null, 'the earlier offer was not stored');
  });

  test('(−) a not-ready offer is kept: the hold goes on and nothing resolves before HOLD_MS', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true });
    const w = r.waiter();
    for (const c of [cap(), cap({ draft: { state: 'empty' }, body: { cols: 138, rows, alt: true, prompt: null, dialog: null } })]) assert.equal(r.hold.offer(c), 'keep');
    await r.clk.advance(HOLD_MS - 1);
    assert.deepEqual([w.done, r.hold.active, r.log.ended, r.log.timeouts.length], [false, true, 0, 0]);
  });

  test('(−) end() resolves the waiters and no timeout follows; ended is told once', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true });
    const w = r.waiter();
    r.hold.end();
    await flush();
    assert.deepEqual([w.done, r.hold.active, r.log.ended], [true, false, 1]);
    await r.clk.advance(HOLD_MS * 3);
    assert.equal(r.log.timeouts.length, 0);
    assert.equal(r.clk.pending, 0, 'the timer is gone');
  });

  test('(−) end() with no hold does nothing (ended is not told)', () => {
    const r = make();
    r.hold.end();
    assert.equal(r.log.ended, 0);
  });

  test('(−) a ready offer cancels the timer: no timeout after it', async () => {
    const r = make();
    r.hold.start({ want: WANT, plainBefore: true });
    r.hold.offer(ready());
    await r.clk.advance(HOLD_MS * 2);
    assert.equal(r.log.timeouts.length, 0);
    assert.equal(r.clk.pending, 0);
  });

  test('(−) an io.timeout that throws still ends the hold and frees the waiters', async () => {
    const r = make({ timeout: () => { throw new Error('boom'); } });
    r.hold.start({ want: WANT, plainBefore: true });
    const w = r.waiter();
    await r.clk.advance(HOLD_MS);
    assert.deepEqual([r.hold.active, w.done], [false, true]);
  });

  test('(−) a hold works with only after and cancel (timeout and ended are optional)', async () => {
    const clk = clock();
    const hold = createRedrawHold({ after: clk.after, cancel: clk.cancel });
    hold.start({ want: WANT, plainBefore: true });
    await clk.advance(HOLD_MS);
    assert.equal(hold.active, false);
  });
});

describe('F10: createFitPlanner, io.sized and size(..., { now }) (design F10 4.2, 3.1)', () => {
  const answer = (pane) => ({ status: 200, body: { fit: { state: 'fitted', reason: null, pane, panes: 1, userZoom: false } } });
  const started = async (opts = {}) => {
    const r = rig(opts);
    r.planner.size(100, 30);
    r.planner.start();
    return r;
  };

  test('(+) a 200 answer with a pane of integers calls io.sized once with { cols, rows }', async () => {
    const r = await started();
    await r.answer(answer({ cols: 138, rows: 20 }));
    assert.deepEqual(r.log.sized, [{ cols: 138, rows: 20 }]);
    r.planner.size(110, 30);
    await r.clk.advance(DEBOUNCE_MS);
    await r.answer(answer({ cols: 110, rows: 29 }));
    assert.deepEqual(r.log.sized, [{ cols: 138, rows: 20 }, { cols: 110, rows: 29 }]);
  });

  test('(+) io.sized is told before the chip of the same answer (so the page can hold the chip in the frame of the mirror)', async () => {
    const r = await started();
    await r.answer(answer({ cols: 138, rows: 20 }));
    assert.deepEqual(r.log.order, ['sized', 'chip']);
  });

  test('(+) an answer that is not a fit answer still tells the pane size when it has one (the chip stays as it was)', async () => {
    const r = await started();
    await r.answer({ status: 200, body: { fit: { state: 'nonsense', pane: { cols: 138, rows: 20 } } } });
    assert.deepEqual(r.log.sized, [{ cols: 138, rows: 20 }]);
    assert.deepEqual(r.log.chips, []);
  });

  const bad = [
    ['no pane', { fit: { state: 'fitted', reason: null } }],
    ['pane null', { fit: { state: 'fitted', reason: null, pane: null } }],
    ['cols not an integer', { fit: { state: 'fitted', reason: null, pane: { cols: 138.5, rows: 20 } } }],
    ['rows not an integer', { fit: { state: 'fitted', reason: null, pane: { cols: 138, rows: '20' } } }],
    ['cols 0', { fit: { state: 'fitted', reason: null, pane: { cols: 0, rows: 20 } } }],
    ['rows 0', { fit: { state: 'fitted', reason: null, pane: { cols: 138, rows: 0 } } }],
    ['rows negative', { fit: { state: 'fitted', reason: null, pane: { cols: 138, rows: -3 } } }],
    ['cols above 10000', { fit: { state: 'fitted', reason: null, pane: { cols: 10001, rows: 20 } } }],
    ['rows above 10000', { fit: { state: 'fitted', reason: null, pane: { cols: 138, rows: 10001 } } }],
    ['no body', null],
  ];
  for (const [why, body] of bad) {
    test(`(−) ${why}: io.sized is not called, nothing throws`, async () => {
      const r = await started();
      await r.answer({ status: 200, body });
      assert.deepEqual(r.log.sized, []);
    });
  }

  test('(−) a non-200 answer (409, 429, 502, a lost request) does not call io.sized', async () => {
    for (const status of [409, 429, 502, 0]) {
      const r = await started();
      await r.answer({ status, body: answer({ cols: 138, rows: 20 }).body });
      assert.deepEqual(r.log.sized, [], String(status));
    }
    const lost = await started();
    await lost.fail();
    assert.deepEqual(lost.log.sized, []);
  });

  test('(−) the answer of a lease that is over (closed meanwhile) does not call io.sized', async () => {
    const r = await started();
    r.planner.close();
    await r.answer(answer({ cols: 138, rows: 20 }));
    assert.deepEqual(r.log.sized, []);
  });

  test('(−) a 403 does not call io.sized', async () => {
    const r = await started();
    await r.answer({ status: 403, body: null });
    assert.deepEqual(r.log.sized, []);
  });

  test('(−) a planner without io.sized throws nothing and the chip is still told', async () => {
    const r = await started({ noSized: true });
    await r.answer(answer({ cols: 138, rows: 20 }));
    assert.equal(r.log.chips.length, 1);
  });

  test('(−) an io.sized that throws does not stop the chip or the planner', async () => {
    const r = rig();
    const io = { send: (b) => { r.log.sent.push(b); return Promise.resolve(answer({ cols: 138, rows: 20 })); }, release() {}, after: r.clk.after, cancel: r.clk.cancel, chip: (v) => r.log.chips.push(v), sized: () => { throw new Error('boom'); } };
    const planner = createFitPlanner(io);
    planner.size(100, 30);
    planner.start();
    await flush();
    await flush();
    assert.equal(r.log.chips.length, 1);
    planner.size(110, 30);
    await r.clk.advance(DEBOUNCE_MS);
    await flush();
    assert.equal(r.log.sent.length, 2);
  });

  test('(+) size(c, r, { now: true }) goes out at once, with no 250 ms wait, open: false', async () => {
    const r = await started();
    await r.answer(answer({ cols: 138, rows: 20 }));
    r.planner.size(210, 33, { now: true });
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 210, rows: 33, open: false, focus: false }]);
    await r.answer(answer({ cols: 210, rows: 32 }));
    await r.clk.advance(DEBOUNCE_MS * 2);
    assert.equal(r.log.sent.length, 2, 'and the debounce found nothing new');
  });

  test('(−) without now the debounce holds: 249 ms nothing, 250 ms one request', async () => {
    const r = await started();
    await r.answer(answer({ cols: 138, rows: 20 }));
    r.planner.size(210, 33);
    await r.clk.advance(DEBOUNCE_MS - 1);
    assert.equal(r.log.sent.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 210, rows: 33, open: false, focus: false }]);
  });

  test('(−) now while a request is in flight goes after it (the latest wins), as size() does', async () => {
    const r = await started();
    r.planner.size(210, 33, { now: true }); // the first request has not been answered
    assert.equal(r.log.sent.length, 1);
    r.planner.size(220, 34, { now: true });
    await r.clk.advance(DEBOUNCE_MS * 2);
    assert.equal(r.log.sent.length, 1, 'one in flight');
    await r.answer(answer({ cols: 138, rows: 20 }));
    await r.clk.advance(DEBOUNCE_MS);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 220, rows: 34, open: false, focus: false }]);
  });

  test('(−) now with the size already answered sends nothing; now before start sends nothing; an invalid size is dropped', async () => {
    const r = rig();
    r.planner.size(210, 33, { now: true });
    assert.deepEqual(r.log.sent, [], 'before start');
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer(answer({ cols: 100, rows: 29 }));
    r.planner.size(100, 30, { now: true });
    r.planner.size(5, 5, { now: true });
    r.planner.size(500, 30, { now: true });
    assert.equal(r.log.sent.length, 1);
  });

  test('(+) the focus settle and a now-size together: one request carries the new size with the focus', async () => {
    const r = await started({ focus: false });
    await r.answer(answer({ cols: 100, rows: 29 }));
    r.page.focus = true;
    r.planner.size(145, 22); // the page measures at the focus event ...
    r.planner.focusChanged(false); // ... and then asks for the focus
    await r.clk.advance(FOCUS_SETTLE_MS);
    assert.deepEqual(r.log.sent.slice(1), [{ cols: 145, rows: 22, open: false, focus: true }]);
    await r.answer(answer({ cols: 145, rows: 21 }));
    await r.clk.advance(DEBOUNCE_MS * 2);
    assert.equal(r.log.sent.length, 2, 'the debounce found the size already sent: one resize per focus');
  });
});

describe('F10: fitPanelView with ui.room (design F10 3.5)', () => {
  const body = (state, reason = null) => ({ fit: { state, reason, pane: { cols: 120, rows: 39 }, panes: 3, userZoom: false } });
  // F11 (owner answer Q3, 2026-11-16; requirement change): "33 rows" is no longer exact, and Fit again asks for full-size text
  const HINT = "Claude's input box and footer did not fit this panel's rows, so nika gave the pane more rows and scaled the text. Fit again tries full-size text.";
  const IDLE = { pending: false, note: false };

  test('(+) fitted: with room the panel has the hint and the action Fit again; the heading and why are the chip\'s', () => {
    const view = chipView(body('fitted'));
    const p = fitPanelView(view, { ...IDLE, room: true });
    assert.equal(p.hint, HINT);
    assert.deepEqual(p.action, { text: 'Fit again' });
    assert.equal(p.heading, view.label);
    assert.equal(p.why, view.title);
  });

  test('(+) fitted:terminal (a terminal shows the window too) gets the same hint and action with room', () => {
    const p = fitPanelView(chipView(body('fitted', 'terminal')), { ...IDLE, room: true });
    assert.equal(p.hint, HINT);
    assert.deepEqual(p.action, { text: 'Fit again' });
  });

  test('(+) the action reads Fitting... while an ask is pending, and the note still shows', () => {
    const p = fitPanelView(chipView(body('fitted')), { pending: true, note: true, room: true });
    assert.equal(p.action.text, 'Fitting…');
    assert.match(p.note, /could not fit/);
  });

  test('(−) without ui.room the panels are as before (no hint, no action for fitted; the terminal hint for fitted:terminal)', () => {
    for (const ui of [IDLE, { ...IDLE, room: false }, { ...IDLE, room: undefined }, { ...IDLE, room: 'yes' }, undefined]) {
      const a = fitPanelView(chipView(body('fitted')), ui);
      assert.deepEqual([a.hint, a.action], [null, null], JSON.stringify(ui));
      const b = fitPanelView(chipView(body('fitted', 'terminal')), ui);
      assert.match(b.hint, /Your terminal shows dots/);
      assert.equal(b.action, null);
    }
  });

  test('(−) every other key ignores ui.room', () => {
    const others = [['zoomed', 'panel-smaller'], ['blocked', 'user-change'], ['blocked', 'changed'], ['blocked', null], ['blocked', 'user-zoom'], ['blocked', 'size-option'], ['blocked', 'foreign-tag'], ['other', null], ['terminal', null], ['terminal', 'switching']];
    for (const [state, reason] of others) {
      const view = chipView(body(state, reason));
      assert.deepEqual(fitPanelView(view, { ...IDLE, room: true }), fitPanelView(view, IDLE), `${state}:${reason}`);
    }
  });

  test('(−) a hint with the word 33 is plain ASCII', () => {
    assert.equal([...HINT].every((ch) => ch.codePointAt(0) < 128), true);
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

// ---- F11 (design F11 2, 3, 6.2, 8.1): the rows nika hides under the input-box strip are filled with more of Claude's conversation ----------------

describe('F11: hiddenRows, the rows Claude draws from the cut row down (design F11 2.1)', () => {
  const ink = [{ t: 'x', s: {} }];
  const blank = [{ t: '   ', s: {} }, { t: '  ', s: {} }]; // spaces and non-breaking spaces only
  const rowsOf = (n, inkedTo = n) => Array.from({ length: n }, (_, i) => (i < inkedTo ? ink : blank));

  test('(+) the limit is pinned: 24 hidden rows, no more', () => {
    assert.equal(HIDE_MAX, 24);
  });

  test('(+) 26 rows with ink to the end, cut 20: the 6 rows from the cut down', () => {
    assert.equal(hiddenRows(rowsOf(26), 20), 6);
  });

  test('(+) trailing blank rows (spaces and U+00A0 only) are not counted: ink in rows 20-23, blank 24-25 gives 4', () => {
    assert.equal(hiddenRows(rowsOf(26, 24), 20), 4);
  });

  test('(+) a span without a string `t` is ignored, a later span with ink counts', () => {
    const odd = [{ t: 5, s: {} }, { s: {} }, null, { t: undefined }, { t: ['x'] }];
    const rows = rowsOf(26, 25); // ink down to row 24
    rows[25] = odd; // nothing readable in the last row
    assert.equal(hiddenRows(rows, 20), 5);
    rows[25] = [{ t: ' ' }, { t: ' x' }];
    assert.equal(hiddenRows(rows, 20), 6, 'ink in the second span of the last row');
  });

  test('(+) the limit itself is allowed: 24 hidden rows give 24', () => {
    assert.equal(hiddenRows(rowsOf(30), 6), 24);
  });

  test('(−) a cut that is not a row 1..rows-1 gives 0: null, 1.5, -1, 0, NaN, a string, undefined, the length, past it', () => {
    for (const cut of [null, 1.5, -1, 0, NaN, '20', undefined, 26, 27, Infinity]) assert.equal(hiddenRows(rowsOf(26), cut), 0, String(cut));
    assert.equal(hiddenRows(rowsOf(10), 0), 0, 'a cut at row 0 hides the whole screen: no strip is drawn, and 10 rows would be under the limit');
  });

  test('(−) no ink at or below the cut gives 0 (rows above it may have ink)', () => {
    assert.equal(hiddenRows(rowsOf(26, 20), 20), 0);
    assert.equal(hiddenRows(rowsOf(26, 0), 20), 0);
  });

  test('(−) more hidden rows than a readable box and a footer can make (25 and up) give 0: the screen is not one the page knows', () => {
    assert.equal(hiddenRows(rowsOf(30), 1), 0, 'cut 1 of 30 inked rows: 29');
    assert.equal(hiddenRows(rowsOf(30), 5), 0, '25');
  });

  test('(−) rows that are not a list give 0', () => {
    for (const rows of [null, undefined, 'abc', 26, {}, { length: 26 }]) assert.equal(hiddenRows(rows, 20), 0, String(rows));
    assert.equal(hiddenRows(), 0);
  });

  test('(−) a row that is not a list (a hole, null, a string) counts as blank', () => {
    const rows = rowsOf(26, 23);
    rows[23] = null;
    rows[24] = 'xxx';
    rows[25] = undefined;
    assert.equal(hiddenRows(rows, 20), 3);
  });
});

describe('F11: fillSize, the size asked at a commit (design F11 2.2, 2.3)', () => {
  const FRAME = { cols: 145, rows: 22, height: 382.88, cellH: 16.2 }; // the design's example panel: 145 x 22 cells, inner height 362.88 px
  const STRIP = 27;

  test('(+) no room, border row 1, 6 hidden rows, a 27 px strip: 145 x 27 (20 rows above the strip + 6 + the border row)', () => {
    assert.deepEqual(fillSize(FRAME, false, 1, 6, STRIP), { cols: 145, rows: 27 });
  });

  test('(+) room on: 210 x 37 (the room columns, 30 rows above the strip at the room text scale + 6 + 1)', () => {
    assert.deepEqual(fillSize(FRAME, true, 1, 6, STRIP), { cols: 210, rows: 37 });
  });

  test('(+) border row 0: one row fewer than with border row 1 (no room: 26)', () => {
    assert.deepEqual(fillSize(FRAME, false, 0, 6, STRIP), { cols: 145, rows: 26 });
    assert.deepEqual(fillSize(FRAME, false, 1, 6, STRIP), { cols: 145, rows: 27 });
  });

  test('(+) a strip of another height changes the rows above it: a measured 40 px strip gives 19 rows above, 26 in all', () => {
    assert.deepEqual(fillSize(FRAME, false, 1, 6, 40), { cols: 145, rows: 26 });
  });

  test('(+) a strip that is not a positive number up to 4 cells (64.8 px) falls back to 2 cells: the same as a 27 px strip here', () => {
    for (const strip of [NaN, 200, 0, -3, Infinity, undefined, null, '27', 64.81]) assert.deepEqual(fillSize(FRAME, false, 1, 6, strip), { cols: 145, rows: 27 }, String(strip));
    assert.deepEqual(fillSize(FRAME, false, 1, 6, 64.8), { cols: 145, rows: 25 }, '4 cells itself is a measured strip: 18 rows above');
  });

  test('(+) the answer is capped at 200 rows, the route\'s limit', () => {
    assert.deepEqual(fillSize({ cols: 145, rows: 190, height: 20 + 190 * 16.2, cellH: 16.2 }, false, 1, 20, STRIP), { cols: 145, rows: 200 });
  });

  test('(−) hide that is not an integer 1..24 asks exactly what F10 asked, with room on and off', () => {
    for (const hide of [0, -1, 2.5, 25, 100, undefined, null, '6', NaN, Infinity]) {
      for (const room of [false, true]) assert.deepEqual(fillSize(FRAME, room, 1, hide, STRIP), askSize(FRAME, room, 1), `${String(hide)} room ${room}`);
    }
  });

  test('(−) a frame with no height or no cell height asks what F10 asked', () => {
    for (const bad of [0, NaN, undefined, null, -5, '16']) {
      assert.deepEqual(fillSize({ ...FRAME, height: bad }, false, 1, 6, STRIP), askSize(FRAME, false, 1), `height ${String(bad)}`);
      assert.deepEqual(fillSize({ ...FRAME, cellH: bad }, true, 1, 6, STRIP), askSize(FRAME, true, 1), `cellH ${String(bad)}`);
    }
  });

  test('(−) a panel with no room for a row above the strip asks what F10 asked', () => {
    for (const hide of [6, 24]) { // 24 hidden rows + the border row is more than the frame's 22: only the base answer is right
      assert.deepEqual(fillSize({ ...FRAME, height: 40 }, false, 1, hide, STRIP), askSize(FRAME, false, 1), String(hide));
      assert.deepEqual(fillSize({ ...FRAME, height: 40 }, true, 1, hide, STRIP), askSize(FRAME, true, 1), String(hide));
    }
  });

  test('(−) never fewer rows than F10 asks, even where the text scale is near its floor (a narrow, short panel with room)', () => {
    const narrow = { cols: 40, rows: 10, height: 200, cellH: 18 };
    const out = fillSize(narrow, true, 1, 1, STRIP);
    assert.equal(out.rows, askSize(narrow, true, 1).rows);
    assert.ok(out.rows >= 33);
  });

  test('(−) the columns are always F10\'s, and the size is always one the route accepts', () => {
    for (const frame of [FRAME, { cols: 40, rows: 10, height: 200, cellH: 18 }, { cols: 390, rows: 12, height: 20 + 12 * 18, cellH: 18 }, { cols: 145, rows: 45, height: 20 + 45 * 18, cellH: 18 }]) {
      for (const room of [false, true]) {
        for (const d of [0, 1]) {
          for (const hide of [1, 6, 24]) {
            const out = fillSize(frame, room, d, hide, STRIP);
            assert.equal(out.cols, askSize(frame, room, d).cols);
            assert.ok(out.rows >= askSize(frame, room, d).rows && out.rows <= 200 && out.cols >= 40 && out.cols <= 400);
          }
        }
      }
    }
  });

  test('(−) a border row outside 0..1 is treated as 0 (as askSize does)', () => {
    for (const d of [2, -1, 1.5, NaN, undefined, '1']) assert.deepEqual(fillSize(FRAME, false, d, 6, STRIP), fillSize(FRAME, false, 0, 6, STRIP), String(d));
  });
});

describe('F11: drawnScale, the text scale from the rows actually drawn (design F11 3.1)', () => {
  const FRAME = { cols: 145, rows: 22, height: 382.88, cellH: 16.2 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} vs ${b}`);

  test('(+) a pane of 145 x 26 with 6 hidden rows and a 27 px strip: 20 rows and the strip fill the panel exactly at full size', () => {
    assert.equal(drawnScale({ frame: FRAME, cols: 145, rows: 26, hide: 6, strip: 27 }), 1);
  });

  test('(+) the room pane 210 x 36: the width decides (145 / 210)', () => {
    near(drawnScale({ frame: FRAME, cols: 210, rows: 36, hide: 6, strip: 27 }), 145 / 210);
  });

  test('(+) the terminal\'s 171 x 45 with 6 hidden rows: 0.5316 (scaleFor gives 0.4889)', () => {
    near(drawnScale({ frame: FRAME, cols: 171, rows: 45, hide: 6, strip: 27 }), 0.5316);
    near(scaleFor({ panelCols: 145, panelRows: 22, cols: 171, rows: 45 }), 0.4889);
  });

  test('(+) a strip that is not usable counts as 2 cells, like in fillSize', () => {
    near(drawnScale({ frame: FRAME, cols: 171, rows: 45, hide: 6, strip: NaN }), (382.88 - 20 - 2 * 16.2) / (39 * 16.2));
  });

  test('(−) no valid hide, or no row left above the cut: exactly scaleFor of the whole pane', () => {
    const plain = scaleFor({ panelCols: 145, panelRows: 22, cols: 171, rows: 45 });
    for (const hide of [0, -1, 2.5, 25, undefined, null, '6', NaN]) assert.equal(drawnScale({ frame: FRAME, cols: 171, rows: 45, hide, strip: 27 }), plain, String(hide));
    assert.equal(drawnScale({ frame: FRAME, cols: 171, rows: 6, hide: 6, strip: 27 }), scaleFor({ panelCols: 145, panelRows: 22, cols: 171, rows: 6 }), 'rows - hide < 1');
    assert.equal(drawnScale({ frame: FRAME, cols: 171, rows: 3, hide: 6, strip: 27 }), scaleFor({ panelCols: 145, panelRows: 22, cols: 171, rows: 3 }));
  });

  test('(−) a frame without a height or cell height is scaleFor of the panel\'s cells', () => {
    const plain = scaleFor({ panelCols: 145, panelRows: 22, cols: 171, rows: 45 });
    for (const frame of [{ cols: 145, rows: 22 }, { ...FRAME, height: 0 }, { ...FRAME, cellH: NaN }]) assert.equal(drawnScale({ frame, cols: 171, rows: 45, hide: 6, strip: 27 }), plain);
  });

  test('(−) never above 1 and never below the floor: a small pane stays at 1, a 10-row panel with a 200-row pane stops at SCALE_MIN', () => {
    assert.equal(drawnScale({ frame: FRAME, cols: 80, rows: 12, hide: 6, strip: 27 }), 1);
    assert.equal(drawnScale({ frame: { cols: 40, rows: 10, height: 200, cellH: 18 }, cols: 40, rows: 200, hide: 6, strip: 27 }), SCALE_MIN);
  });

  test('(−) the width limit still binds when the hidden rows would allow a larger text', () => {
    near(drawnScale({ frame: FRAME, cols: 300, rows: 26, hide: 6, strip: 27 }), 145 / 300);
  });
});

describe('F11: roomStep needs the extra rows (design F11 6.2)', () => {
  const want = { cols: 138, rows: 20 };
  const base = () => ({
    room: false, frameRows: 22, state: 'fitted', plainBefore: true, want, gain: true,
    body: { cols: 138, rows: new Array(20).fill([]), alt: true, prompt: null, dialog: null }, draft: null,
  });

  test('(+) every F10 condition and gain: true takes the step', () => {
    assert.equal(roomStep(base()), true);
  });

  test('(−) gain: false, a missing gain, 1 and the string "true" do not (only the boolean true counts)', () => {
    for (const gain of [false, undefined, null, 1, 'true', 0]) assert.equal(roomStep({ ...base(), gain }), false, String(gain));
    const { gain, ...without } = base();
    assert.equal(gain, true);
    assert.equal(roomStep(without), false);
  });
});

describe('F11: the room hint says "more rows" (owner answer Q3)', () => {
  const OLD = "Claude's input box and footer did not fit this panel's rows, so nika gave the pane 33 rows and scaled the text. Fit again tries the panel's own size.";
  const NEW = "Claude's input box and footer did not fit this panel's rows, so nika gave the pane more rows and scaled the text. Fit again tries full-size text.";
  const body = (state, reason = null) => ({ fit: { state, reason, pane: { cols: 120, rows: 39 }, panes: 3, userZoom: false } });

  test('(+) fitted and fitted:terminal with ui.room show the new words and Fit again', () => {
    for (const reason of [null, 'terminal']) {
      const p = fitPanelView(chipView(body('fitted', reason)), { pending: false, note: false, room: true });
      assert.equal(p.hint, NEW);
      assert.deepEqual(p.action, { text: 'Fit again' });
    }
    assert.equal([...NEW].every((ch) => ch.codePointAt(0) < 128), true);
  });

  test('(−) the old words are gone from the module, and the hint no longer names a number of rows', () => {
    const src = readSrc('fit-ui.js');
    assert.equal(src.includes('gave the pane 33 rows'), false);
    assert.equal(src.includes("Fit again tries the panel's own size"), false);
    const p = fitPanelView(chipView(body('fitted')), { pending: false, note: false, room: true });
    assert.notEqual(p.hint, OLD);
    assert.doesNotMatch(p.hint, /\d/);
  });

  test('(−) without ui.room the panels have no room hint (unchanged cases)', () => {
    assert.equal(fitPanelView(chipView(body('fitted')), { pending: false, note: false }).hint, null);
    assert.equal(fitPanelView(chipView(body('zoomed', 'panel-smaller')), { pending: false, note: false, room: true }).hint.includes('more rows'), false);
  });
});

describe('F11: the planner\'s `startable` (design F11 2.4)', () => {
  test('(+) true before start(), false while started, true again after close()', async () => {
    const r = rig();
    assert.equal(r.planner.startable, true);
    r.planner.size(100, 30);
    r.planner.start();
    assert.equal(r.planner.startable, false);
    await r.answer(OK());
    assert.equal(r.planner.startable, false);
    r.planner.close();
    assert.equal(r.planner.startable, true, 'a new lease starts at the next capture');
    r.planner.start();
    assert.equal(r.planner.startable, false);
  });

  test('(−) false after a 403: nothing starts the planner again', async () => {
    const r = rig();
    r.planner.size(100, 30);
    r.planner.start();
    await r.answer({ status: 403, body: null });
    assert.equal(r.planner.startable, false);
    r.planner.close();
    assert.equal(r.planner.startable, false);
    r.planner.start();
    assert.deepEqual(r.log.sent.length, 1, 'start after a 403 sends nothing');
  });

  test('(−) a getter only: reading it changes nothing and it cannot be set from outside', async () => {
    const r = rig();
    for (let i = 0; i < 3; i += 1) assert.equal(r.planner.startable, true);
    assert.deepEqual(r.log.sent, []);
    assert.throws(() => { 'use strict'; r.planner.startable = false; }, TypeError);
  });
});

// ---- F16 (design F16 4, 11.2): more rows for a question Claude clips at its top ------------------------------------------------

describe('F16: the constants, growNext, cutQuestion, growAsk and scaleRows', () => {
  test('(+) the constants have the design values', () => {
    assert.deepEqual([GROW_STEP_MIN, GROW_CAP, GROW_CONFIRM_MS, GROW_SETTLE_MS, GROW_WAIT_MS, GROW_CLOSE_MS], [12, 120, 200, 800, 6000, 1000]);
    assert.ok(GROW_CAP <= 200, 'the route takes 200 rows at most');
    assert.ok(GROW_SETTLE_MS > 680, 'longer than the slowest repaint of the hold comment (340-680 ms)');
    assert.ok(GROW_WAIT_MS > BEAT_MS, 'longer than a heartbeat: a refused ask is tried again before the page gives up');
    assert.deepEqual(GROW_IDLE, { phase: 'idle', rows: 0, askedAt: 0, settleAt: null, cutSince: null, quietSince: null, base: '' });
    assert.equal(Object.isFrozen(GROW_IDLE), true, 'the state at rest is shared, so it cannot change');
  });

  test('(+) growNext doubles, adds at least 12 and stops at 120: 21 to 42, 10 to 22, 33 to 66, 66 and 100 to 120', () => {
    assert.deepEqual([21, 10, 33, 66, 100, 11, 6].map(growNext), [42, 22, 66, 120, 120, 23, 18]);
  });

  test('(−) growNext has no room at the cap or above it: 120 stays 120, 130 is 120 (the caller gives up)', () => {
    assert.equal(growNext(GROW_CAP), GROW_CAP);
    assert.equal(growNext(130), GROW_CAP);
    assert.equal(growNext(200), GROW_CAP);
    assert.equal(growNext(119), GROW_CAP);
  });

  test('(+) cutQuestion: a question that is unreadable because its top is clipped, raw or cleaned', () => {
    assert.equal(cutQuestion({ state: 'unreadable', kind: 'ask', reason: 'cut' }), true);
    assert.equal(cutQuestion({ kind: 'ask', state: 'unreadable', reason: 'cut', extra: 1 }), true);
  });

  test('(−) cutQuestion: a shortened text (clipped), every other reason, a plan, a ready question, null and a non-object are not', () => {
    for (const reason of ['clipped', 'wide', 'numbers', 'tab', 'layout', 'survey', undefined, 'Cut', 'cut ']) assert.equal(cutQuestion({ state: 'unreadable', kind: 'ask', reason }), false, String(reason));
    assert.equal(cutQuestion({ state: 'unreadable', kind: 'plan', reason: 'cut' }), false, 'plans are not grown (D1)');
    assert.equal(cutQuestion({ state: 'unreadable', kind: null, reason: 'cut' }), false);
    assert.equal(cutQuestion({ state: 'ready', kind: 'ask', reason: 'cut' }), false);
    for (const v of [null, undefined, 'cut', 7, true, []]) assert.equal(cutQuestion(v), false, String(v));
  });

  test('(+) growAsk: while stepping or held with more rows than the base, the grown rows and the base columns', () => {
    const base = { cols: 145, rows: 21 };
    assert.deepEqual(growAsk(base, { ...GROW_IDLE, phase: 'stepping', rows: 42 }), { cols: 145, rows: 42 });
    assert.deepEqual(growAsk(base, { ...GROW_IDLE, phase: 'held', rows: 42 }), { cols: 145, rows: 42 });
    assert.deepEqual(growAsk(base, { ...GROW_IDLE, phase: 'held', rows: 250 }), { cols: 145, rows: 200 }, 'the route takes 200 at most');
  });

  test('(−) growAsk: idle, spent, a state of nothing, rows that are not more than the base or not a number: the base', () => {
    const base = { cols: 145, rows: 21 };
    for (const G of [GROW_IDLE, { ...GROW_IDLE, phase: 'spent', rows: 42 }, undefined, null, { phase: 'stepping', rows: 21 }, { phase: 'stepping', rows: 20 }, { phase: 'held', rows: '42' }, { phase: 'held', rows: 42.5 }, { phase: 'held' }]) {
      assert.deepEqual(growAsk(base, G), { cols: 145, rows: 21 }, JSON.stringify(G));
    }
  });

  test('(+) scaleRows: while grown and fitted, the pane rows without the grow (the base minus the border row), with d 0 and 1', () => {
    const G = { ...GROW_IDLE, phase: 'held', rows: 42 };
    assert.equal(scaleRows({ paneRows: 42, G, fitted: true, baseRows: 21, d: 0 }), 21);
    assert.equal(scaleRows({ paneRows: 41, G, fitted: true, baseRows: 21, d: 1 }), 20);
    assert.equal(scaleRows({ paneRows: 42, G: { ...G, phase: 'stepping' }, fitted: true, baseRows: 21, d: 0 }), 21);
    assert.equal(scaleRows({ paneRows: 18, G, fitted: true, baseRows: 21, d: 0 }), 18, 'never more than the pane has');
    assert.equal(scaleRows({ paneRows: 42, G, fitted: true, baseRows: 21, d: 7 }), 21, 'a border row that is not 0 or 1 is taken as 0');
  });

  test('(−) scaleRows: not fitted, idle, spent, a bad base or no base: the pane rows', () => {
    const G = { ...GROW_IDLE, phase: 'held', rows: 42 };
    assert.equal(scaleRows({ paneRows: 42, G, fitted: false, baseRows: 21, d: 0 }), 42, 'in terminal the pane is the terminal\'s');
    assert.equal(scaleRows({ paneRows: 42, G, fitted: 'fitted', baseRows: 21, d: 0 }), 42, 'only exactly true');
    assert.equal(scaleRows({ paneRows: 42, G: GROW_IDLE, fitted: true, baseRows: 21, d: 0 }), 42);
    assert.equal(scaleRows({ paneRows: 42, G: { ...GROW_IDLE, phase: 'spent' }, fitted: true, baseRows: 21, d: 0 }), 42);
    for (const baseRows of [undefined, null, NaN, 0, 1.5, '21', 1]) assert.equal(scaleRows({ paneRows: 42, G, fitted: true, baseRows, d: baseRows === 1 ? 1 : 0 }), 42, String(baseRows));
  });

  // RV16 I1 (round 1): fillSize adds Claude's hidden input-box rows to the base; no input box is on screen while a question is open, so they are never drawn
  test('(+) scaleRows (I1): the hidden rows of the last commit are taken off the base too, after the border row', () => {
    const G = { ...GROW_IDLE, phase: 'held', rows: 48 };
    assert.equal(scaleRows({ paneRows: 48, G, fitted: true, baseRows: 24, d: 0, hide: 5 }), 19);
    assert.equal(scaleRows({ paneRows: 47, G, fitted: true, baseRows: 24, d: 1, hide: 5 }), 18, 'the border row and the hidden rows');
    assert.equal(scaleRows({ paneRows: 48, G: { ...G, phase: 'stepping' }, fitted: true, baseRows: 30, d: 0, hide: HIDE_MAX }), 6, 'the largest valid hide');
    assert.equal(scaleRows({ paneRows: 15, G, fitted: true, baseRows: 24, d: 0, hide: 5 }), 15, 'never more than the pane has');
  });

  test('(−) scaleRows (I1): a hide that is not valid counts as 0 (as in fillSize), a hide that leaves no row is ignored, and idle, spent, terminal are as before', () => {
    const G = { ...GROW_IDLE, phase: 'held', rows: 48 };
    for (const hide of [undefined, null, 0, -1, HIDE_MAX + 1, 5.5, '5', NaN, Infinity]) assert.equal(scaleRows({ paneRows: 48, G, fitted: true, baseRows: 24, d: 0, hide }), 24, String(hide));
    assert.equal(scaleRows({ paneRows: 48, G, fitted: true, baseRows: 24, d: 0, hide: HIDE_MAX }), 48, 'no row left above the hidden rows: the pane rows');
    assert.equal(scaleRows({ paneRows: 48, G, fitted: true, baseRows: 24, d: 1, hide: 23 }), 48, 'the border row and the hidden rows leave 0');
    assert.equal(scaleRows({ paneRows: 48, G: GROW_IDLE, fitted: true, baseRows: 24, d: 0, hide: 5 }), 48, 'idle');
    assert.equal(scaleRows({ paneRows: 48, G: { ...GROW_IDLE, phase: 'spent' }, fitted: true, baseRows: 24, d: 0, hide: 5 }), 48, 'spent');
    assert.equal(scaleRows({ paneRows: 48, G, fitted: false, baseRows: 24, d: 0, hide: 5 }), 48, 'terminal');
  });

  test('(+) scaleRows (I1): with the base fillSize really gives for hidden rows (panel 145 x 21 or 22, 27 px strip, d 0 and 1) the text never shrinks while grown: the scale is 1 where it was 1 before the question', () => {
    for (const d of [0, 1]) for (const panelRows of [21, 22]) for (const hide of [3, 5, 7]) {
      const frame = { cols: 145, rows: panelRows, height: panelRows * 16.2 + 8, cellH: 16.2 };
      const base = fillSize(frame, false, d, hide, 27);
      const before = drawnScale({ frame, cols: base.cols, rows: base.rows - d, hide, strip: 27 });
      const G = { ...GROW_IDLE, phase: 'held', rows: 2 * base.rows };
      const grown = (h) => drawnScale({ frame, cols: base.cols, rows: scaleRows({ paneRows: G.rows - d, G, fitted: true, baseRows: base.rows, d, hide: h }), hide: 0, strip: 0 });
      const why = `d ${d} panel ${panelRows} hide ${hide} base ${base.rows}`;
      assert.equal(before, 1, why);
      assert.equal(grown(hide), 1, why);
      if (hide >= 5) assert.ok(grown(undefined) < 1, `without the hidden rows the text would shrink: ${why}`);
    }
  });
});

describe('F16: growStep, one test per row of the transition table (design F16 4.5)', () => {
  const CUT = { kind: 'ask', state: 'unreadable', reason: 'cut' };
  const READY = { kind: 'ask', state: 'ready', at: 'question', sig: '0123456789abcdef' };
  const BASE = { baseRows: 21, baseCols: 145 };
  const look = (G, over = {}) => growStep(G, { now: 0, dialog: CUT, fitted: true, paneRows: 21, ...BASE, ...over });
  const stepping = (over = {}) => ({ ...GROW_IDLE, phase: 'stepping', rows: 42, askedAt: 0, ...over });
  const held = (over = {}) => ({ ...GROW_IDLE, phase: 'held', rows: 42, ...over });
  const spent = (over = {}) => ({ ...GROW_IDLE, phase: 'spent', base: '145x21', ...over });

  test('(+) row 1: no question for under a second: the same phase, quietSince set, nothing asked (stepping, held, spent)', () => {
    for (const G of [stepping(), held(), spent()]) {
      const a = look(G, { now: 5000, dialog: null });
      assert.equal(a.G.phase, G.phase);
      assert.equal(a.G.quietSince, 5000);
      assert.equal(a.ask, null);
      const b = look(a.G, { now: 5000 + GROW_CLOSE_MS - 1, dialog: null });
      assert.deepEqual([b.G.phase, b.G.quietSince, b.ask], [G.phase, 5000, null], 'quietSince keeps the first quiet look');
    }
  });

  test('(+) row 2: stepping or held, no question for a second: idle, and the base size is asked back', () => {
    for (const G of [stepping(), held()]) {
      const a = look(G, { now: 5000, dialog: null });
      assert.deepEqual(look(a.G, { now: 5000 + GROW_CLOSE_MS, dialog: null }), { G: GROW_IDLE, ask: { back: true } }, G.phase);
    }
  });

  test('(+) row 3: a given-up question closes the same way, with nothing to ask (it is back already)', () => {
    const a = look(spent(), { now: 5000, dialog: null });
    assert.deepEqual(look(a.G, { now: 5000 + GROW_CLOSE_MS, dialog: null }), { G: GROW_IDLE, ask: null });
  });

  test('(+) row 4: a question and not fitted: a step restarts its clocks, an idle first look is forgotten, the others are as they were', () => {
    assert.deepEqual(look(stepping({ askedAt: 100, settleAt: 900 }), { now: 5000, fitted: false }), { G: stepping({ askedAt: 5000, settleAt: null }), ask: null });
    assert.deepEqual(look({ ...GROW_IDLE, cutSince: 4900 }, { now: 5000, fitted: false }), { G: GROW_IDLE, ask: null });
    assert.deepEqual(look(held(), { now: 5000, fitted: false }), { G: held(), ask: null });
    assert.deepEqual(look(spent(), { now: 5000, fitted: false }), { G: spent(), ask: null });
    for (const fitted of [false, undefined, null, 'fitted', 1]) assert.equal(look({ ...GROW_IDLE, cutSince: 0 }, { now: 5000, fitted }).ask, null, String(fitted));
  });

  test('(+) row 5: idle and the question is not cut: idle, the first look is cleared', () => {
    assert.deepEqual(look({ ...GROW_IDLE, cutSince: 100 }, { now: 150, dialog: READY }), { G: GROW_IDLE, ask: null });
    assert.deepEqual(look(GROW_IDLE, { dialog: READY }), { G: GROW_IDLE, ask: null });
    for (const reason of ['clipped', 'wide', 'tab', 'layout', 'numbers', 'survey']) assert.equal(look(GROW_IDLE, { now: 900, dialog: { kind: 'ask', state: 'unreadable', reason } }).ask, null, reason);
  });

  test('(+) row 6: idle and cut for the first time: only the time is noted', () => {
    assert.deepEqual(look(GROW_IDLE, { now: 700 }), { G: { ...GROW_IDLE, cutSince: 700 }, ask: null });
  });

  test('(−) row 7: idle and cut for under 200 ms: nothing yet, then at 200 ms the step', () => {
    const first = look(GROW_IDLE, { now: 700 }).G;
    assert.deepEqual(look(first, { now: 700 + GROW_CONFIRM_MS - 1 }), { G: first, ask: null });
    assert.equal(look(first, { now: 700 + GROW_CONFIRM_MS }).ask.rows, 42);
  });

  test('(+) row 8: idle and cut for 200 ms: stepping at twice the base rows, asked now', () => {
    const a = look({ ...GROW_IDLE, cutSince: 700 }, { now: 950 });
    assert.deepEqual(a, { G: { ...GROW_IDLE, phase: 'stepping', rows: 42, askedAt: 950 }, ask: { rows: 42 } });
    assert.equal(look({ ...GROW_IDLE, cutSince: 0 }, { now: 300, baseRows: 10 }).ask.rows, 22, 'at least 12 more');
  });

  test('(−) row 9: idle and cut, the base is at the cap: given up at once, nothing asked', () => {
    const a = look({ ...GROW_IDLE, cutSince: 0 }, { now: 300, baseRows: GROW_CAP });
    assert.deepEqual(a, { G: { ...GROW_IDLE, phase: 'spent', base: '145x120' }, ask: null });
    assert.equal(look({ ...GROW_IDLE, cutSince: 0 }, { now: 300, baseRows: 200 }).G.phase, 'spent');
  });

  test('(+) row 10: stepping or held and the question is no longer cut (ready, shortened, too wide, tab): held', () => {
    for (const G of [stepping(), held()]) {
      for (const dialog of [READY, { kind: 'ask', state: 'unreadable', reason: 'clipped' }, { kind: 'ask', state: 'unreadable', reason: 'wide' }, { kind: 'ask', state: 'unreadable', reason: 'tab' }]) {
        const a = look({ ...G, settleAt: 900 }, { now: 5000, dialog, paneRows: 42 });
        assert.deepEqual([a.G.phase, a.G.rows, a.ask], ['held', 42, null], `${G.phase} ${dialog.reason ?? dialog.state}`);
      }
    }
    assert.equal(look(stepping({ settleAt: 900 }), { now: 5000, dialog: READY, paneRows: 42 }).G.settleAt, null, 'the settle is over');
    assert.equal(look(stepping(), { now: 5000, dialog: READY, paneRows: 21 }).G.phase, 'held', 'readable at the old size (a smaller question) is held too');
  });

  test('(+) row 11: held, cut again and the drawn frame is below the grown size: stepping again, the clock restarts', () => {
    assert.deepEqual(look(held({ askedAt: 10 }), { now: 5000, paneRows: 21 }), { G: stepping({ askedAt: 5000, settleAt: null }), ask: null });
  });

  test('(−) row 12: stepping, cut, the frame below the grown size, under 6 s: wait', () => {
    const G = stepping({ askedAt: 1000 });
    assert.deepEqual(look(G, { now: 1000 + GROW_WAIT_MS - 1, paneRows: 21 }), { G, ask: null });
    assert.deepEqual(look(G, { now: 1000, paneRows: 30 }), { G, ask: null }, 'a frame in between');
  });

  test('(−) row 13: stepping, cut, the frame below the grown size for 6 s: given up, the base size back', () => {
    const a = look(stepping({ askedAt: 1000 }), { now: 1000 + GROW_WAIT_MS, paneRows: 21 });
    assert.deepEqual(a, { G: spent(), ask: { back: true } });
  });

  test('(+) row 14: stepping or held, cut, at the grown size, no settle yet: the settle starts', () => {
    for (const G of [stepping(), held()]) {
      assert.deepEqual(look(G, { now: 2000, paneRows: 42 }), { G: stepping({ settleAt: 2000 + GROW_SETTLE_MS }), ask: null }, G.phase);
    }
    assert.equal(look(stepping(), { now: 2000, paneRows: 41 }).G.settleAt, 2800, 'a border row: the pane is one row short of the ask');
  });

  test('(−) row 15: stepping, cut, at the grown size, before the settle ends: wait', () => {
    const G = stepping({ settleAt: 2800 });
    assert.deepEqual(look(G, { now: 2799, paneRows: 42 }), { G, ask: null });
  });

  test('(+) row 16: stepping, cut, at the grown size, the settle over, room left: the next step from the current rows', () => {
    assert.deepEqual(look(stepping({ settleAt: 2800 }), { now: 2800, paneRows: 42 }), { G: stepping({ rows: 84, askedAt: 2800, settleAt: null }), ask: { rows: 84 } });
  });

  test('(−) row 17: stepping, cut, at the grown size, the settle over, at the cap: given up, the base size back', () => {
    const a = look(stepping({ rows: GROW_CAP, settleAt: 2800 }), { now: 2800, paneRows: GROW_CAP });
    assert.deepEqual(a, { G: spent(), ask: { back: true } });
  });

  test('(−) row 18: a given-up question stays given up for any question on screen, cut or not', () => {
    for (const dialog of [CUT, READY, { kind: 'ask', state: 'unreadable', reason: 'wide' }]) {
      for (const now of [0, 300, 99999]) assert.deepEqual(look(spent(), { now, dialog }), { G: spent(), ask: null }, `${dialog.reason ?? dialog.state} ${now}`);
    }
  });

  test('(+) the owner\'s case end to end: 145 x 21 grows to 42, is held while the question is open, and goes back a second after it closes', () => {
    let G = GROW_IDLE;
    const at = (now, over) => { const r = look(G, { now, ...over }); G = r.G; return r.ask; };
    assert.equal(at(0), null, 'the first look');
    assert.deepEqual(at(250), { rows: 42 }, 'confirmed: one step');
    assert.equal(at(330, { paneRows: 21 }), null, 'the redraw hold keeps the old frame');
    assert.equal(at(700, { paneRows: 42 }), null, 'the pane is at 42 and still cut: the settle starts');
    assert.equal(G.settleAt, 1500);
    assert.equal(at(1000, { paneRows: 42, dialog: READY }), null, 'Claude repainted: the question is whole');
    assert.equal(G.phase, 'held');
    assert.equal(at(3000, { paneRows: 42, dialog: READY }), null, 'it stays grown while the question is open');
    assert.equal(at(3250, { paneRows: 42, dialog: null }), null, 'answered: the first quiet look');
    assert.equal(at(4000, { paneRows: 42, dialog: null }), null, 'not yet a second');
    assert.deepEqual(at(4250, { paneRows: 42, dialog: null }), { back: true });
    assert.deepEqual(G, GROW_IDLE);
  });

  test('(+) two steps: still cut after the settle at 42 rows asks 84', () => {
    let G = look({ ...GROW_IDLE, cutSince: 0 }, { now: 250 }).G;
    assert.equal(G.rows, 42);
    G = look(G, { now: 700, paneRows: 42 }).G;
    const r = look(G, { now: 1500, paneRows: 42 });
    assert.deepEqual(r.ask, { rows: 84 });
    assert.equal(look(r.G, { now: 1600, paneRows: 42 }).ask, null, 'the frame is not at 84 yet');
    const done = look(r.G, { now: 2000, paneRows: 84, dialog: READY });
    assert.equal(done.G.phase, 'held');
  });

  test('(+) a give-up at the cap: base 66 asks 120, still cut after the settle, back and spent', () => {
    const a = look({ ...GROW_IDLE, cutSince: 0 }, { now: 300, baseRows: 66 });
    assert.deepEqual(a.ask, { rows: 120 });
    const b = look(look(a.G, { now: 900, paneRows: 120, baseRows: 66 }).G, { now: 1700, paneRows: 120, baseRows: 66 });
    assert.deepEqual(b.ask, { back: true });
    assert.equal(b.G.phase, 'spent');
    assert.equal(b.G.base, '145x66');
  });

  test('(−) a cut seen once and gone before 200 ms asks nothing, and the next cut starts the count again', () => {
    let G = look(GROW_IDLE, { now: 1000 }).G;
    G = look(G, { now: 1100, dialog: READY }).G;
    assert.equal(G.cutSince, null);
    const again = look(G, { now: 1150 });
    assert.deepEqual([again.G.cutSince, again.ask], [1150, null]);
    assert.equal(look(again.G, { now: 1150 + GROW_CONFIRM_MS - 1 }).ask, null);
  });

  test('(−) a cut while not fitted asks nothing and the first look is cleared; fitted again counts from the start', () => {
    let G = look(GROW_IDLE, { now: 0 }).G;
    G = look(G, { now: 500, fitted: false }).G;
    assert.equal(G.cutSince, null);
    for (let t = 1000; t < 40000; t += 250) {
      const r = look(G, { now: t, fitted: false });
      assert.equal(r.ask, null);
      G = r.G;
    }
    const first = look(G, { now: 40000 });
    assert.deepEqual([first.ask, first.G.cutSince], [null, 40000]);
  });

  test('(+) a parked step keeps its clock fresh: 30 s in terminal give nothing up, and after fitted and the settle the next step comes', () => {
    let G = stepping({ askedAt: 0 });
    for (let t = 250; t <= 30000; t += 250) {
      const r = look(G, { now: t, fitted: false, paneRows: 21 });
      assert.equal(r.ask, null);
      G = r.G;
    }
    assert.equal(G.phase, 'stepping');
    assert.equal(G.askedAt, 30000);
    let r = look(G, { now: 30250, paneRows: 21 });
    assert.deepEqual([r.G.phase, r.ask], ['stepping', null], 'fitted again, the frame not at 42 yet: wait');
    r = look(r.G, { now: 30500, paneRows: 42 });
    assert.equal(r.G.settleAt, 31300);
    assert.deepEqual(look(r.G, { now: 31300, paneRows: 42 }).ask, { rows: 84 });
  });

  test('(−) a quiet frame of 600 ms between two tabs does not size back, and the next quiet stretch counts from its own start', () => {
    let G = held();
    G = look(G, { now: 1000, dialog: null }).G;
    const mid = look(G, { now: 1600, dialog: null });
    assert.equal(mid.ask, null);
    G = look(mid.G, { now: 1650, dialog: READY, paneRows: 42 }).G;
    assert.equal(G.quietSince, null);
    G = look(G, { now: 2000, dialog: null }).G;
    assert.equal(G.quietSince, 2000);
    assert.equal(look(G, { now: 2999, dialog: null }).ask, null);
    assert.deepEqual(look(G, { now: 3000, dialog: null }).ask, { back: true });
  });

  test('(+) a plan, a prompt or a dialog of no kind replacing the question counts as closed after a second', () => {
    for (const dialog of [{ kind: 'plan', state: 'unreadable', reason: 'cut' }, { kind: 'plan', state: 'ready' }, { kind: null, state: 'unreadable', reason: 'layout' }, undefined]) {
      const a = look(held(), { now: 1000, dialog });
      assert.equal(a.G.quietSince, 1000);
      assert.deepEqual(look(a.G, { now: 2000, dialog }).ask, { back: true });
    }
  });

  test('(−) a given-up question that is cut again asks nothing, however long it stays', () => {
    let G = spent();
    for (let t = 0; t < 20000; t += 250) {
      const r = look(G, { now: t });
      assert.equal(r.ask, null);
      G = r.G;
    }
    assert.equal(G.phase, 'spent');
  });

  test('(+) growRebase: a given-up question gets a new try when the base changed (rows, or columns alone); (−) not on the same base, and not for any other phase', () => {
    assert.equal(growRebase(spent(), 145, 30), GROW_IDLE);
    assert.equal(growRebase(spent(), 120, 21), GROW_IDLE, 'a width commit (the transcript toggle) is a new situation too');
    const same = spent();
    assert.equal(growRebase(same, 145, 21), same);
    for (const G of [GROW_IDLE, stepping(), held()]) assert.equal(growRebase(G, 80, 10), G, G.phase);
  });

  test('(+) held, then the next tab is cut again: the settle, then a step from the current rows (not from the base)', () => {
    let G = held({ rows: 42 });
    let r = look(G, { now: 1000, paneRows: 42 });
    assert.deepEqual([r.G.phase, r.G.settleAt, r.ask], ['stepping', 1800, null]);
    r = look(r.G, { now: 1800, paneRows: 42 });
    assert.deepEqual(r.ask, { rows: 84 });
    G = held({ rows: 20 });
    assert.deepEqual(look(G, { now: 1000, paneRows: 30 }).G.settleAt, 1800, 'a pane taller than the grown rows (a larger base) counts as at the size');
    r = look(look(G, { now: 1000, paneRows: 30, baseRows: 30 }).G, { now: 1800, paneRows: 30, baseRows: 30 });
    assert.deepEqual(r.ask, { rows: 60 }, 'from max(rows, base)');
  });
});

describe('F16: frameReady, createRedrawHold and fitPanelView for the grow', () => {
  const want = { cols: 145, rows: 42 };
  const rows42 = new Array(42).fill([]);
  const body = (over = {}) => ({ cols: 145, rows: rows42, alt: true, prompt: null, dialog: null, ...over });
  const CUT = { state: 'unreadable', kind: 'ask', reason: 'cut' };
  const WHOLE = { state: 'ready', kind: 'ask', at: 'question', sig: '0123456789abcdef' };

  test('(+) cutBefore: a question that is whole at the size ends the hold, and so does any screen but a clipped question', () => {
    for (const dialog of [WHOLE, null, undefined, { state: 'unreadable', kind: 'ask', reason: 'clipped' }, { state: 'unreadable', kind: 'ask', reason: 'wide' }, { state: 'unreadable', kind: 'plan', reason: 'cut' }]) {
      assert.equal(frameReady({ body: body({ dialog }), draft: null, want, plainBefore: true, cutBefore: true }), true, JSON.stringify(dialog));
    }
    assert.equal(frameReady({ body: body({ prompt: { question: 'x', options: [] } }), draft: null, want, plainBefore: true, cutBefore: true }), true, 'a prompt');
  });

  test('(−) cutBefore: a question still clipped at the top keeps the hold, a wrong size keeps it, and a readable box does not end it', () => {
    assert.equal(frameReady({ body: body({ dialog: CUT }), draft: null, want, plainBefore: true, cutBefore: true }), false);
    assert.equal(frameReady({ body: body({ dialog: CUT }), draft: { state: 'empty' }, want, plainBefore: false, cutBefore: true }), false, 'nothing but the question counts');
    assert.equal(frameReady({ body: body({ dialog: WHOLE, cols: 100 }), draft: null, want, plainBefore: true, cutBefore: true }), false, 'the width');
    assert.equal(frameReady({ body: body({ dialog: WHOLE, rows: new Array(21).fill([]) }), draft: null, want, plainBefore: true, cutBefore: true }), false, 'the rows');
    assert.equal(frameReady({ body: body({ dialog: WHOLE }), draft: null, want: null, plainBefore: true, cutBefore: true }), false, 'no want');
  });

  test('(+) without cutBefore every old case is as it was; only exactly true counts (a string, 1 and undefined do not)', () => {
    assert.equal(frameReady({ body: body({ dialog: CUT }), draft: null, want, plainBefore: true }), true, 'a dialog ends the F10 hold, as before');
    for (const cutBefore of [undefined, false, 'yes', 1, null]) assert.equal(frameReady({ body: body({ dialog: CUT }), draft: null, want, plainBefore: true, cutBefore }), true, String(cutBefore));
    assert.equal(frameReady({ body: body(), draft: null, want, plainBefore: true }), false, 'no dialog, no box: Claude has not repainted');
  });

  const make = () => {
    const clk = clock();
    const log = { timeouts: [] };
    const hold = createRedrawHold({ after: clk.after, cancel: clk.cancel, timeout: (pending, ctx) => log.timeouts.push([pending, ctx]) });
    return { hold, clk, log };
  };
  const cap = (dialog) => ({ body: body({ dialog }), draft: null });

  test('(+) createRedrawHold: a hold started with cutBefore keeps the capture of a clipped question and lets the whole one through', () => {
    const r = make();
    r.hold.start({ want, plainBefore: true, cutBefore: true });
    assert.equal(r.hold.offer(cap(CUT)), 'keep');
    assert.equal(r.hold.offer(cap(CUT)), 'keep');
    assert.equal(r.hold.offer(cap(WHOLE)), 'apply');
    assert.equal(r.hold.active, false);
  });

  test('(+) cutBefore stays that of the first start, like plainBefore, and the timeout context carries it', async () => {
    const r = make();
    r.hold.start({ want: { cols: 100, rows: 20 }, plainBefore: true, cutBefore: true });
    await r.clk.advance(600);
    r.hold.start({ want, plainBefore: false, cutBefore: false });
    assert.equal(r.hold.offer(cap(CUT)), 'keep', 'still the first start\'s');
    await r.clk.advance(HOLD_MS);
    assert.deepEqual(r.log.timeouts[0][1], { want, plainBefore: true, modeBefore: false, cutBefore: true });
    const b = make();
    b.hold.start({ want, plainBefore: true });
    b.hold.start({ want, plainBefore: true, cutBefore: true });
    await b.clk.advance(HOLD_MS);
    assert.equal(b.log.timeouts[0][1].cutBefore, false, 'false stays false');
  });

  test('(−) createRedrawHold: cutBefore is exactly true or nothing, and a new hold forgets the last one\'s', async () => {
    const r = make();
    r.hold.start({ want, plainBefore: true, cutBefore: 'yes' });
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.timeouts[0][1].cutBefore, false);
    r.hold.start({ want, plainBefore: true, cutBefore: true });
    r.hold.end();
    r.hold.start({ want, plainBefore: true });
    assert.equal(r.hold.offer(cap(CUT)), 'apply', 'a dialog ends a hold without cutBefore, as in F10');
  });

  const fit = (state, reason = null) => chipView({ fit: { state, reason, pane: { cols: 120, rows: 39 }, panes: 3, userZoom: false } });
  const IDLE = { pending: false, note: false };
  const hintOf = (view, ui) => fitPanelView(view, ui).hint;

  test('(+) fitPanelView: ui.grow shows the grow line on fitted and fitted:terminal, over the room line, and the room keeps Fit again', () => {
    const line = hintOf(fit('fitted'), { ...IDLE, grow: true });
    assert.match(line, /^Claude's question is taller than this panel, so nika gave the pane more rows while it is open\./);
    assert.match(line, /the size goes back when the question closes\.$/);
    assert.equal(hintOf(fit('fitted', 'terminal'), { ...IDLE, grow: true }), line);
    assert.equal(hintOf(fit('fitted'), { ...IDLE, grow: true, room: true }), line, 'the grow line wins over the room line');
    assert.deepEqual(fitPanelView(fit('fitted'), { ...IDLE, grow: true, room: true }).action, { text: 'Fit again' });
    assert.equal(fitPanelView(fit('fitted'), { ...IDLE, grow: true }).action, null, 'the grow has no action of its own');
  });

  test('(−) fitPanelView: ui.grow is ignored for zoomed, terminal, blocked and other, and a non-boolean grow is ignored everywhere', () => {
    const others = [['zoomed', 'panel-smaller'], ['blocked', 'user-change'], ['blocked', 'changed'], ['blocked', null], ['blocked', 'user-zoom'], ['blocked', 'size-option'], ['blocked', 'foreign-tag'], ['other', null], ['terminal', null], ['terminal', 'switching']];
    for (const [state, reason] of others) assert.deepEqual(fitPanelView(fit(state, reason), { ...IDLE, grow: true }), fitPanelView(fit(state, reason), IDLE), `${state}:${reason}`);
    for (const grow of [undefined, false, 'true', 1, null, {}]) {
      assert.deepEqual(fitPanelView(fit('fitted'), { ...IDLE, grow }), fitPanelView(fit('fitted'), IDLE), String(grow));
      assert.equal(hintOf(fit('fitted', 'terminal'), { ...IDLE, grow }), hintOf(fit('fitted', 'terminal'), IDLE), String(grow));
    }
    assert.deepEqual(fitPanelView(fit('fitted'), undefined).hint, null);
  });

  test('(+) fit-ui.js stays ASCII with the F16 code in it, and the grow line has no "#" and no path', () => {
    const src = readSrc('fit-ui.js');
    assert.equal([...src].every((ch) => ch.codePointAt(0) < 128), true);
    const line = hintOf(fit('fitted'), { ...IDLE, grow: true });
    assert.equal([...line].every((ch) => ch.codePointAt(0) < 128), true);
    assert.doesNotMatch(line, /#|\/|\\|~/);
  });
});
