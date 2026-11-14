// The page side of scrolling Claude's view (design W3 sections 2.4, 6 and 12.3): public/scroll.js, with no DOM and no requests of its own.
// The planner runs against a fake route that answers when the test says so and a manual clock, so every timing rule (a request at least
// 100 ms after the last, one in flight) is asserted exactly. The gate has a twin in src/scroll.js: both run on one shared fixture list.
// Fixtures are synthetic (acme-api).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GAP_MS, PAGE_MIN, NOTE_MS, MAX_PAGES, wheelRows, routeFor, viewRowsOf, pageRowsOf, scrollGate, refusalLine, noteView, scrolledSay, createScrollPlanner,
} from '../public/scroll.js';
import { MAX_PAGES as SERVER_MAX_PAGES, scrollGate as serverGate } from '../src/scroll.js';
import { readDraft } from '../src/session-control.js';
import { promptFromRows } from '../src/mode.js';
import { cleanDraft } from '../public/draft-sync.js';
import { boxRows, span } from './helpers.js';

const COLS = 120;

describe('constants', () => {
  test('(+) the page and the server agree on the most pages in one request; the values are the design\'s', () => {
    assert.equal(MAX_PAGES, SERVER_MAX_PAGES);
    assert.deepEqual([GAP_MS, PAGE_MIN, NOTE_MS, MAX_PAGES], [100, 4, 3000, 8]);
  });
});

describe('wheelRows: rows of travel in one wheel event', () => {
  test('(+) pixels are divided by the cell height, lines are rows already, pages are viewRows each; the sign is kept', () => {
    assert.equal(wheelRows({ deltaY: 36, deltaMode: 0 }, { cellH: 18, viewRows: 30 }), 2);
    assert.equal(wheelRows({ deltaY: -36, deltaMode: 0 }, { cellH: 18, viewRows: 30 }), -2);
    assert.equal(wheelRows({ deltaY: 3, deltaMode: 1 }, { cellH: 18, viewRows: 30 }), 3);
    assert.equal(wheelRows({ deltaY: -1, deltaMode: 2 }, { cellH: 18, viewRows: 30 }), -30);
    assert.equal(wheelRows({ deltaY: 36 }, { cellH: 18 }), 2, 'no deltaMode is pixels');
  });

  test('(+) the cell height already carries the text scale: a smaller cell means more rows for the same pixels', () => {
    const full = wheelRows({ deltaY: 36, deltaMode: 0 }, { cellH: 18 });
    const scaled = wheelRows({ deltaY: 36, deltaMode: 0 }, { cellH: 18 * 0.5 });
    assert.equal(scaled, full * 2);
  });

  test('(−) not finite, zero, an unknown mode, or a unit that cannot be measured gives 0 (the event is ignored)', () => {
    for (const dy of [0, -0, NaN, Infinity, -Infinity, undefined, null, '5', {}]) assert.equal(wheelRows({ deltaY: dy, deltaMode: 1 }, { cellH: 18, viewRows: 30 }), 0, String(dy));
    assert.equal(wheelRows({ deltaY: 5, deltaMode: 3 }, { cellH: 18, viewRows: 30 }), 0);
    assert.equal(wheelRows({ deltaY: 5, deltaMode: 0 }, {}), 0, 'no cell height');
    assert.equal(wheelRows({ deltaY: 5, deltaMode: 0 }, { cellH: 0 }), 0);
    assert.equal(wheelRows({ deltaY: 5, deltaMode: 0 }, { cellH: NaN }), 0);
    assert.equal(wheelRows({ deltaY: 5, deltaMode: 2 }, { viewRows: 0 }), 0, 'no view height');
    assert.equal(wheelRows(null), 0);
    assert.equal(wheelRows(undefined, undefined), 0);
  });
});

describe('routeFor: the mirror\'s own overflow scrolls before Claude\'s view', () => {
  const at = (top, extra = {}) => ({ top, height: 1000, client: 400, ...extra });

  test('(+) up is native while the mirror is scrolled down by more than half a pixel, Claude\'s at the top', () => {
    assert.equal(routeFor({ dir: -1, ...at(300) }), 'native');
    assert.equal(routeFor({ dir: -1, ...at(0.6) }), 'native');
    assert.equal(routeFor({ dir: -1, ...at(0.5) }), 'claude', 'half a pixel counts as the top');
    assert.equal(routeFor({ dir: -1, ...at(0) }), 'claude');
  });

  test('(+) down is native while more than half a pixel is left below, Claude\'s at the bottom', () => {
    assert.equal(routeFor({ dir: 1, ...at(0) }), 'native');
    assert.equal(routeFor({ dir: 1, ...at(599.4) }), 'native');
    assert.equal(routeFor({ dir: 1, ...at(599.5) }), 'claude', 'half a pixel counts as the bottom');
    assert.equal(routeFor({ dir: 1, ...at(600) }), 'claude');
  });

  test('(+) a pane that fits the panel (nothing to scroll) is Claude\'s both ways', () => {
    const fit = { top: 0, height: 400, client: 400 };
    assert.equal(routeFor({ dir: -1, ...fit }), 'claude');
    assert.equal(routeFor({ dir: 1, ...fit }), 'claude');
  });

  test('(+) any size of dir counts: a wheel passes its rows as dir', () => {
    assert.equal(routeFor({ dir: -0.3, ...at(0) }), 'claude');
    assert.equal(routeFor({ dir: 7, ...at(600) }), 'claude');
    assert.equal(routeFor({ dir: 7, ...at(0) }), 'native');
  });

  test('(−) a box that cannot be measured, or no direction, is native: the page does nothing', () => {
    for (const bad of [{ top: NaN }, { height: undefined }, { client: null }, { top: '0' }]) assert.equal(routeFor({ dir: 1, ...at(0), ...bad }), 'native', JSON.stringify(bad));
    for (const dir of [0, NaN, undefined, null]) assert.equal(routeFor({ dir, ...at(0) }), 'native', String(dir));
    assert.equal(routeFor(), 'native');
  });
});

describe('viewRowsOf and pageRowsOf: a page is half of the transcript area', () => {
  const draft = (top) => ({ state: 'empty', box: { top, bottom: top + 2 } });
  const body = (n) => ({ rows: Array.from({ length: n }, () => []) });

  test('(+) the transcript area is the rows above the input box\'s top rule; a page is half of it', () => {
    assert.equal(viewRowsOf(body(40), draft(33)), 33);
    assert.equal(pageRowsOf(body(40), draft(33)), 16);
    assert.equal(pageRowsOf(body(40), draft(20)), 10);
    assert.equal(pageRowsOf(body(40), draft(31)), 15);
  });

  test('(+) with no readable box the capture\'s row count stands in', () => {
    assert.equal(viewRowsOf(body(40), null), 40);
    assert.equal(pageRowsOf(body(40), null), 20);
    assert.equal(pageRowsOf(body(41), undefined), 20);
    assert.equal(viewRowsOf(body(40), { state: 'empty', box: { top: 'x' } }), 40);
  });

  test('(+) a page is never fewer than PAGE_MIN rows', () => {
    assert.equal(pageRowsOf(body(40), draft(3)), PAGE_MIN);
    assert.equal(pageRowsOf(body(40), draft(0)), PAGE_MIN);
    assert.equal(pageRowsOf(body(6), null), PAGE_MIN);
    assert.equal(pageRowsOf(body(0), null), PAGE_MIN);
    assert.equal(pageRowsOf(null, null), PAGE_MIN);
    assert.equal(pageRowsOf({}, {}), PAGE_MIN);
  });
});

// ---- the planner -----------------------------------------------------------------------------------------------------------

/**
 * A fake route that answers when the test says so (`answer(r)` resolves the oldest request still open), a manual clock and the handler's
 * log. advance(ms) moves the clock, runs the timers due and lets the promises settle.
 */
function rig() {
  const log = { sent: [], at: [], done: [] };
  const open = [];
  const timers = new Map();
  let t = 1_000_000;
  let next = 1;
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });
  const io = {
    send: (body) => new Promise((resolve, reject) => {
      log.sent.push(body);
      log.at.push(t);
      open.push({ resolve, reject });
    }),
    after: (fn, ms) => { const id = next++; timers.set(id, { at: t + ms, fn }); return id; },
    cancel: (id) => { timers.delete(id); },
    now: () => t,
    done: (r) => log.done.push(r),
  };
  const planner = createScrollPlanner(io);
  const r = {
    planner, log, io, open,
    get now() { return t; },
    get timers() { return timers.size; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await settle();
      }
      t = end;
      await settle();
    },
    async answer(reply = { status: 200, body: { sent: 1, scrolled: true } }) {
      open.shift().resolve(reply);
      await settle();
    },
    async lose() {
      open.shift().reject(new Error('network down'));
      await settle();
    },
  };
  return r;
}
const UP = (pages) => ({ dir: 'up', pages });
const DOWN = (pages) => ({ dir: 'down', pages });

describe('planner: the wheel', () => {
  test('(+) the first page goes at half a page of travel, and not before', () => {
    const r = rig();
    r.planner.wheel(-7.9, 16);
    assert.deepEqual(r.log.sent, []);
    r.planner.wheel(-0.1, 16);
    assert.deepEqual(r.log.sent, [UP(1)]);
  });

  test('(+) the request goes out at once (synchronously), with the pages the travel is worth', () => {
    const r = rig();
    r.planner.wheel(40, 16);
    assert.deepEqual(r.log.sent, [DOWN(3)], '40 rows = 2.5 pages, round to nearest');
  });

  test('(+) on average one page per pageRows: 1 row at a time, pages at 8, 24, 40, 56 rows of travel', async () => {
    const r = rig();
    const pagesAt = [];
    let pages = 0;
    for (let rows = 1; rows <= 60; rows += 1) {
      r.planner.wheel(1, 16);
      await r.advance(GAP_MS); // the gap passes; the route answers as it is asked
      while (r.open.length) await r.answer();
      const sent = r.log.sent.reduce((n, b) => n + b.pages, 0);
      if (sent !== pages) { pages = sent; pagesAt.push(rows); }
    }
    assert.deepEqual(pagesAt, [8, 24, 40, 56]);
  });

  test('(+) a wheel up sends up, a wheel down sends down; the sign of rows is the only thing that picks', () => {
    const a = rig();
    a.planner.wheel(-20, 16);
    assert.deepEqual(a.log.sent, [UP(1)]);
    const b = rig();
    b.planner.wheel(20, 16);
    assert.deepEqual(b.log.sent, [DOWN(1)]);
  });

  test('(+) a change of direction drops the rest: leftover travel and pages not yet sent', async () => {
    const r = rig();
    r.planner.wheel(-8, 16); // one page up, in flight
    r.planner.wheel(-24, 16); // queued: 2 pages up (the travel is 8 short after the first, then 24 more)
    r.planner.wheel(7, 16); // down: drops the queued pages and the travel; 7 rows are not half a page
    await r.answer();
    await r.advance(GAP_MS * 3);
    assert.deepEqual(r.log.sent, [UP(1)], 'nothing up behind it, and nothing down yet');
    r.planner.wheel(1, 16); // 8 rows of travel down since the change
    assert.deepEqual(r.log.sent.at(-1), DOWN(1));
  });

  test('(+) a small reversal does not carry the old travel over', () => {
    const r = rig();
    r.planner.wheel(-7, 16);
    r.planner.wheel(7, 16);
    r.planner.wheel(-7, 16);
    assert.deepEqual(r.log.sent, [], 'each reversal starts from zero, so none reaches half a page');
  });

  test('(+) the queue never holds more than 8 pages, and the excess is dropped with the travel', async () => {
    const r = rig();
    r.planner.wheel(16, 16); // in flight
    r.planner.wheel(16 * 20, 16); // 20 pages worth
    await r.answer();
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [DOWN(1), DOWN(8)]);
    await r.answer();
    await r.advance(GAP_MS * 5);
    assert.equal(r.log.sent.length, 2, 'no backlog behind it');
  });

  test('(+) events during the gap add up into one request, not one each', async () => {
    const r = rig();
    r.planner.wheel(16, 16);
    await r.answer();
    r.planner.wheel(16, 16);
    r.planner.wheel(16, 16);
    r.planner.wheel(16, 16);
    assert.equal(r.log.sent.length, 1, 'still inside the gap');
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [DOWN(1), DOWN(3)]);
  });

  test('(−) not a number, zero, or a pageRows that makes no sense is ignored', () => {
    const r = rig();
    for (const rows of [NaN, 0, Infinity, '8', null, undefined]) r.planner.wheel(rows, 16);
    for (const pageRows of [NaN, 0, 0.5, -16, undefined, null, '16']) r.planner.wheel(40, pageRows);
    assert.deepEqual(r.log.sent, []);
  });
});

describe('planner: pages, jumps, timing', () => {
  test('(+) page(dir) is one page; a second in the same direction joins the queue; a change of direction replaces it', async () => {
    const r = rig();
    r.planner.page('down');
    assert.deepEqual(r.log.sent, [DOWN(1)]);
    r.planner.page('down');
    r.planner.page('down');
    r.planner.page('up'); // replaces the two queued down pages
    await r.answer();
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [DOWN(1), UP(1)]);
  });

  test('(+) held PgUp cannot build a backlog: at most 8 pages per request', async () => {
    const r = rig();
    r.planner.page('up');
    for (let i = 0; i < 40; i += 1) r.planner.page('up');
    await r.answer();
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [UP(1), UP(8)]);
  });

  test('(+) jump(to) sends { to } and drops the queue and the travel', async () => {
    const r = rig();
    r.planner.page('up'); // in flight
    r.planner.page('up'); // queued
    r.planner.wheel(-10, 16);
    r.planner.jump('bottom');
    await r.answer();
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [UP(1), { to: 'bottom' }]);
    await r.answer();
    await r.advance(GAP_MS * 5);
    assert.equal(r.log.sent.length, 2, 'the queued pages were dropped');
  });

  test('(+) a pending jump goes before pages queued after it; one body per request', async () => {
    const r = rig();
    r.planner.page('down'); // in flight
    r.planner.jump('top');
    r.planner.page('down');
    r.planner.page('down');
    await r.answer();
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [DOWN(1), { to: 'top' }]);
    await r.answer();
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [DOWN(1), { to: 'top' }, DOWN(2)]);
    for (const b of r.log.sent) assert.ok(Object.keys(b).length <= 2, 'a jump or a direction with a count, never both');
  });

  test('(+) the last jump wins', () => {
    const r = rig();
    r.planner.page('up'); // in flight
    r.planner.jump('top');
    r.planner.jump('bottom');
    assert.equal(r.log.sent.length, 1);
    assert.equal(r.timers, 0);
  });

  test('(+) one request in flight: nothing more goes until the answer, then the next waits for the gap', async () => {
    const r = rig();
    r.planner.page('up');
    r.planner.page('up');
    await r.advance(GAP_MS * 5);
    assert.equal(r.log.sent.length, 1, 'no answer yet');
    await r.answer();
    assert.equal(r.log.sent.length, 2, 'the answer came after the gap: the next goes at once');
  });

  test('(+) a request goes at least GAP_MS after the last was sent, however fast the answer came', async () => {
    const r = rig();
    r.planner.page('up');
    await r.advance(30);
    await r.answer();
    r.planner.page('up');
    assert.equal(r.log.sent.length, 1, '30 ms after the first');
    await r.advance(GAP_MS - 31);
    assert.equal(r.log.sent.length, 1, 'one ms early');
    await r.advance(1);
    assert.equal(r.log.sent.length, 2);
    assert.equal(r.log.at[1] - r.log.at[0], GAP_MS);
  });

  test('(+) never more than 10 requests in any second of events', async () => {
    const r = rig();
    for (let ms = 0; ms < 3000; ms += 5) {
      r.planner.page(ms % 2 ? 'up' : 'down');
      await r.advance(5);
      while (r.open.length) await r.answer();
    }
    const times = r.log.at;
    assert.ok(times.length > 10);
    for (let i = 10; i < times.length; i += 1) assert.ok(times[i] - times[i - 10] >= 1000 - 0, `requests ${i - 10}..${i}: ${times[i] - times[i - 10]} ms`);
  });

  test('(+) the handler hears every answer', async () => {
    const r = rig();
    r.planner.page('up');
    await r.answer({ status: 200, body: { sent: 1, scrolled: true } });
    assert.deepEqual(r.log.done, [{ status: 200, body: { sent: 1, scrolled: true } }]);
  });

  test('(−) a direction or an end that is not one of the four is ignored', () => {
    const r = rig();
    for (const d of ['left', 'UP', '', null, undefined, 1, -1]) r.planner.page(d);
    for (const to of ['middle', 'Top', '', null, undefined, 0]) r.planner.jump(to);
    assert.deepEqual(r.log.sent, []);
  });
});

describe('planner: refusals and close', () => {
  test('(−) any answer but 200 drops the queue, the travel and the jump: no keys behind a refusal', async () => {
    for (const reply of [{ status: 409, body: { error: 'prompt-open' } }, { status: 429, body: { error: 'busy' } }, { status: 502, body: null }, { status: 404, body: null }, { status: 0, body: null }, { status: 500, body: {} }]) {
      const r = rig();
      r.planner.page('up'); // in flight
      r.planner.page('up');
      r.planner.wheel(-10, 16);
      r.planner.jump('top');
      await r.answer(reply);
      await r.advance(GAP_MS * 5);
      assert.deepEqual(r.log.sent, [UP(1)], `status ${reply.status}`);
      assert.equal(r.timers, 0);
      assert.deepEqual(r.log.done, [reply]);
      r.planner.page('down'); // a later request is not blocked
      assert.equal(r.log.sent.length, 2, `status ${reply.status} does not stop later requests`);
    }
  });

  test('(−) a lost request (the send rejects, answers nothing, or throws) is a refusal with status 0, not a stuck planner', async () => {
    const r = rig();
    r.planner.page('up');
    await r.lose();
    assert.deepEqual(r.log.done, [{ status: 0, body: null }]);
    await r.advance(GAP_MS);
    r.planner.page('up');
    assert.equal(r.log.sent.length, 2, 'not stuck busy');
    await r.answer(null);
    assert.deepEqual(r.log.done.at(-1), { status: 0, body: null });
    const throwing = createScrollPlanner({ send: () => { throw new Error('boom'); }, after: () => 1, cancel() {}, now: () => 0, done: (x) => r.log.done.push(x) });
    throwing.page('up');
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(r.log.done.at(-1), { status: 0, body: null });
  });

  test('(−) 403 stops the planner for good: nothing is sent again, not even after close()', async () => {
    const r = rig();
    r.planner.page('up');
    r.planner.page('up');
    await r.answer({ status: 403, body: null });
    await r.advance(GAP_MS * 5);
    r.planner.wheel(40, 16);
    r.planner.page('down');
    r.planner.jump('top');
    r.planner.close();
    r.planner.page('down');
    assert.equal(r.log.sent.length, 1);
  });

  test('(+) close() drops everything, cancels the timer, ignores the answer still on its way and sends nothing more of it', async () => {
    const r = rig();
    r.planner.page('up'); // in flight
    r.planner.page('up'); // queued
    r.planner.jump('bottom');
    r.planner.close();
    await r.answer({ status: 200, body: { sent: 1, scrolled: true } });
    await r.advance(GAP_MS * 5);
    assert.deepEqual(r.log.sent, [UP(1)]);
    assert.deepEqual(r.log.done, [], 'the late answer is not told to the page');
    assert.equal(r.timers, 0);
  });

  test('(+) fix round 1, M1c: close() keeps the planner busy until the stale request settles, so a new request never overlaps it; the stale answer is dropped', async () => {
    const r = rig();
    r.planner.page('up'); // in flight
    r.planner.close();
    r.planner.page('down'); // asked after the close
    assert.equal(r.log.sent.length, 1, 'the old request is still on its way: nothing overlaps it');
    assert.equal(r.open.length, 1);
    await r.advance(GAP_MS * 3);
    assert.equal(r.log.sent.length, 1, 'waiting does not help while it is open');
    await r.answer({ status: 200, body: { sent: 1, scrolled: true } }); // the stale answer
    assert.deepEqual(r.log.done, [], 'the stale answer is not told to the page');
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [UP(1), DOWN(1)], 'then what was asked after the close goes');
    assert.equal(r.open.length, 1);
    await r.answer();
    assert.equal(r.log.done.length, 1, 'only the new answer is told');
  });

  test('(+) fix round 1, M1c: a stale request that is lost (rejected) also frees the planner, and nothing is told to the page', async () => {
    const r = rig();
    r.planner.page('up');
    r.planner.close();
    r.planner.jump('bottom');
    await r.advance(GAP_MS * 3);
    assert.equal(r.log.sent.length, 1, 'still the old one, however long it takes');
    await r.lose();
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [UP(1), { to: 'bottom' }]);
    assert.deepEqual(r.log.done, []);
  });

  test('(−) fix round 1, M1c: a 403 on the stale request is dropped with the rest of its answer; the new request goes next and gets its own answer', async () => {
    const r = rig();
    r.planner.page('up');
    r.planner.close();
    r.planner.page('down');
    await r.advance(GAP_MS * 3);
    assert.equal(r.log.sent.length, 1, 'still the old one, however long it takes');
    await r.answer({ status: 403, body: null }); // stale
    await r.advance(GAP_MS);
    assert.deepEqual(r.log.sent, [UP(1), DOWN(1)]);
    assert.deepEqual(r.log.done, []);
    await r.answer({ status: 403, body: null }); // the new request's own 403 stops the planner for good
    assert.deepEqual(r.log.done, [{ status: 403, body: null }]);
    r.planner.page('up');
    await r.advance(GAP_MS * 3);
    assert.equal(r.log.sent.length, 2);
  });

  test('(+) close() while waiting out the gap cancels the timer', async () => {
    const r = rig();
    r.planner.page('up');
    await r.answer();
    r.planner.page('up'); // waits for the gap
    assert.equal(r.timers, 1);
    r.planner.close();
    assert.equal(r.timers, 0);
    await r.advance(GAP_MS * 3);
    assert.equal(r.log.sent.length, 1);
  });

  test('(+) after close() the next wheel, page or jump starts afresh (the pane that was gone is back)', async () => {
    const r = rig();
    r.planner.wheel(-6, 16);
    r.planner.close();
    r.planner.wheel(-6, 16);
    assert.equal(r.log.sent.length, 0, 'the old travel was forgotten: 6 rows are not half a page');
    r.planner.wheel(-3, 16);
    assert.equal(r.log.sent.length, 1);
  });

  test('(+) a handler that closes the planner (404 -> the pane is gone) stops the queue from going on', async () => {
    const r = rig();
    const p = createScrollPlanner({ ...r.io, done: (x) => { r.log.done.push(x); if (x.status === 404) p.close(); } });
    p.page('up');
    p.page('up');
    await r.answer({ status: 404, body: null });
    await r.advance(GAP_MS * 3);
    assert.equal(r.log.sent.length, 1);
  });
});

// ---- the gate, a twin of src/scroll.js -------------------------------------------------------------------------------------

const row = (t) => (typeof t === 'string' ? (t ? [span(t)] : []) : t);
function view({ above = ['  Here is the answer.', ''], alt = true, ...box } = {}) {
  const b = boxRows({ cols: COLS, ...box });
  return { cols: COLS, rows: [...above.map(row), ...b.rows], cursor: b.cursor && { ...b.cursor, y: b.cursor.y + above.length }, alt };
}
const PROMPT = ['Bash command', '  run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];
const MODE_LINE = '  ⏵⏵ auto mode on (shift+tab to cycle)';
const RULE = '─'.repeat(COLS);
const THERE = { x: 0, y: 0, visible: true };

/** A history-entry (unreadable) box whose first row is replaced by `text`: the row after the top rule (view() puts two rows above the box). */
function firstRow(text) {
  const v = view({ label: 'History 3/3', lines: ['older entry'] });
  return { ...v, rows: v.rows.map((r, i) => (i === 3 ? [span(text)] : r)) };
}

/** One list for both gates: [name, capture, the code both must give]. The server reads { rows, cursor, cols, alt }; the page reads what the capture route sends. */
const SCREENS = [
  ['empty box', view(), null],
  ['one-line draft', view({ lines: ['fix the build'] }), null],
  ['multi-line draft', view({ lines: ['first line', 'second line', 'third line'] }), null],
  ['a slash command mentioned mid-text', view({ lines: ['run /compact now'] }), null],
  ['bash box with text', view({ mode: 'bash', lines: ['ls -la'] }), null],
  ['empty bash box', view({ mode: 'bash' }), null],
  ['unreadable: history entry that is not a command', view({ label: 'History 3/3', lines: ['older entry'] }), null],
  ['unreadable: pasted text', view({ lines: ['[Pasted text #1 +20 lines]'] }), null],
  ['unreadable: trailing spaces after plain text', view({ lines: ['fix the build  '] }), null],
  ['vim INSERT footer', view({ insert: true, lines: ['x'] }), null],
  ['a turn is running', view({ above: ['  Working on it', '  ✻ Thinking… (12s · esc to interrupt)'] }), null],
  ['already scrolled up (pill on screen)', view({ above: ['  older output', [span(' '.repeat(40)), span(' Jump to bottom: fn+↓ to scroll ', { fg: 231, bg: 237 })]] }), null],
  ['alternate screen off', view({ alt: false }), 'no-view'],
  ['alt missing', (({ alt, ...rest }) => rest)(view()), 'no-view'],
  ['alt not a boolean', { ...view(), alt: '1' }, 'no-view'],
  ['alt off and a prompt', { rows: PROMPT.map(row), cursor: THERE, cols: COLS, alt: false }, 'no-view'],
  ['permission prompt', { rows: PROMPT.map(row), cursor: THERE, cols: COLS, alt: true }, 'prompt-open'],
  ['permission prompt below a plain box', { ...view(), rows: [...view().rows, ...PROMPT.map(row)] }, 'prompt-open'],
  ['AskUserQuestion footer', view({ footer: 'Enter to select · ↑/↓ to navigate · Esc to cancel' }), 'screen-unclear'],
  ['feedback survey', view({ above: ['● How is Claude doing this session? (optional)', '  1: Bad    2: Fine    3: Good    0: Dismiss'] }), 'screen-unclear'],
  ['unknown footer', view({ footer: 'something Claude never drew' }), 'screen-unclear'],
  ['overlay in place of the mode line', view({ footer: '/model · Esc to close' }), 'screen-unclear'],
  ['cursor on the status line below the box', (() => { const v = view(); return { ...v, cursor: { x: 2, y: v.rows.length - 2, visible: true } }; })(), 'screen-unclear'],
  ['cursor on the top rule', (() => { const v = view(); return { ...v, cursor: { x: 2, y: 2, visible: true } }; })(), 'screen-unclear'],
  ['no cursor', view({ cursor: null }), 'screen-unclear'],
  ['no rule rows', { rows: ['  Here is the answer.', MODE_LINE].map(row), cursor: THERE, cols: COLS, alt: true }, 'screen-unclear'],
  ['one rule row', { rows: ['  Here is the answer.', RULE, '❯ ', MODE_LINE].map(row), cursor: { x: 2, y: 2, visible: true }, cols: COLS, alt: true }, 'screen-unclear'],
  ['no rows', { rows: [], cursor: THERE, cols: COLS, alt: true }, 'screen-unclear'],
  ['slash command being typed', view({ lines: ['/com'] }), 'menu-open'],
  ['a lone slash', view({ lines: ['/'] }), 'menu-open'],
  ['multi-line draft that starts with a slash', view({ lines: ['/help', 'more'] }), 'menu-open'],
  ['bash box whose text starts with a slash (fails closed)', view({ mode: 'bash', lines: ['/usr/bin/true'] }), 'menu-open'],
  // rule (b): an unreadable draft has no text, so the first box row is read
  ['unreadable /cmd: a history entry that is a command', view({ label: 'History 3/3', lines: ['/compact'] }), 'menu-open'],
  ['unreadable /com with a trailing space (the slash menu may be open)', view({ lines: ['/com '] }), 'menu-open'],
  ['unreadable /cmd with trailing spaces', view({ lines: ['/compact   '] }), 'menu-open'],
  // fix round 1, M5: the shapes of the first box row around rule (b), each from a real unreadable (history) box with its first row edited
  ['unreadable /cmd, glyph and no-break space', firstRow('❯\u00a0/compact'), 'menu-open'],
  ['unreadable /cmd, two spaces of indent', firstRow('  ❯\u00a0/compact'), 'menu-open'],
  ['unreadable /cmd, three spaces of indent: not an input row, so no plain box', firstRow('   ❯\u00a0/compact'), 'screen-unclear'],
  ['unreadable, a second space before the slash: not "after the glyph and its space"', firstRow('❯\u00a0 /compact'), null],
  ['unreadable, a plain space after the glyph: not Claude\'s box row, so no plain box', firstRow('❯ /compact'), 'screen-unclear'],
  ['unreadable, the slash is not the first character', firstRow('❯\u00a0fix /compact'), null],
  ['unreadable, no slash at all', firstRow('❯\u00a0older entry'), null],
  ['unreadable ! box whose first row starts with a slash: rule (b) is for the glyph box only', view({ mode: 'bash', label: 'History 3/3', lines: ['/usr/bin/true'] }), null],
];

/** What the capture route sends for a capture: the screen's own fields, `prompt` (readScreen) and `draft` (readDraft + edit); then JSON, as on the wire. */
const wire = (cap) => {
  const parsed = readDraft(cap);
  return JSON.parse(JSON.stringify({ ...cap, prompt: promptFromRows(cap.rows), draft: parsed && { ...parsed, edit: 'plain' } }));
};
const pageGate = (cap) => { const b = wire(cap); return scrollGate(b, cleanDraft(b.draft)); };

describe('scrollGate: the page twin of the server\'s gate', () => {
  for (const [name, cap, code] of SCREENS) {
    test(`(${code === null ? '+' : '−'}) ${name}: ${code ?? 'keys may go'}`, () => {
      assert.equal(pageGate(cap), code, 'the page');
      assert.equal(serverGate(cap), code, 'the server (src/scroll.js)');
    });
  }

  test('(+) the twin: both gates agree on every fixture, and the list covers all five answers', () => {
    const seen = new Set();
    for (const [name, cap] of SCREENS) {
      assert.equal(pageGate(cap), serverGate(cap), name);
      seen.add(serverGate(cap));
    }
    assert.deepEqual([...seen].map(String).sort(), ['menu-open', 'no-view', 'null', 'prompt-open', 'screen-unclear']);
  });

  test('(+) the unreadable-draft slash rule reads the first row after the top rule and only after the prompt glyph and its space', () => {
    const box = (first) => {
      const b = boxRows({ cols: COLS, label: 'History 3/3', lines: ['older'] });
      const rows = b.rows.map((r) => r);
      rows[1] = [span(first)]; // the row after the top rule
      return { rows: [row('  answer'), ...rows], cursor: { ...b.cursor, y: b.cursor.y + 1 }, cols: COLS, alt: true };
    };
    const NB = String.fromCharCode(0xa0);
    const gate = (cap) => { const b = wire(cap); return scrollGate(b, { state: 'unreadable', mode: 'prompt', text: '', sig: null, reason: 'history', box: { top: 1, bottom: 3 }, cursorAtEnd: false, suggestion: null }); };
    assert.equal(gate(box(`❯${NB}/compact`)), 'menu-open');
    assert.equal(gate(box('❯ /compact')), 'menu-open', 'a plain space reads the same');
    assert.equal(gate(box(`  ❯${NB}/compact`)), 'menu-open', 'up to two spaces of indent');
    assert.equal(gate(box(`   ❯${NB}/compact`)), null, 'three spaces is not an input row');
    assert.equal(gate(box(`❯${NB}fix /compact`)), null);
    assert.equal(gate(box(`❯${NB} /compact`)), null, 'a second space before the slash: not "after the glyph and its space"');
    assert.equal(gate(box(`!${NB}/usr/bin/true`)), null, 'a ! box is not covered by this rule');
    assert.equal(gate(box('/compact')), null);
  });

  test('(−) no capture yet, or one without the fields, is closed: no-view, never keys', () => {
    for (const body of [null, undefined, {}, { rows: [] }, 'x', 5]) assert.equal(scrollGate(body, null), 'no-view');
  });

  test('(−) alt must be exactly true; a prompt of any shape closes the gate; a draft that is not an object is no box', () => {
    const rows = view().rows;
    const d = cleanDraft(wire(view()).draft);
    assert.equal(scrollGate({ alt: 1, rows }, d), 'no-view');
    assert.equal(scrollGate({ alt: true, rows, prompt: { question: 'x' } }, d), 'prompt-open');
    assert.equal(scrollGate({ alt: true, rows, prompt: { n: 1 } }, null), 'prompt-open', 'the prompt is judged first, like the server');
    for (const draft of [null, undefined, 0, 'x', true]) assert.equal(scrollGate({ alt: true, rows, prompt: null }, draft), 'screen-unclear');
    assert.equal(scrollGate({ alt: true, rows, prompt: null }, d), null);
  });

  test('(−) an unreadable draft whose box or rows are missing falls back to allowed, as the server does for a row that is not there', () => {
    const rows = view().rows;
    assert.equal(scrollGate({ alt: true, rows: undefined, prompt: null }, { state: 'unreadable', box: { top: 1, bottom: 3 } }), null);
    assert.equal(scrollGate({ alt: true, rows, prompt: null }, { state: 'unreadable' }), null);
  });
});

// ---- the lines -------------------------------------------------------------------------------------------------------------

describe('refusalLine: fixed copy chosen by status and code', () => {
  const COPY = {
    'prompt-open': "A prompt is open, so nika doesn't send scroll keys. Answer it first, or scroll in the terminal.",
    'screen-unclear': "A dialog or menu is open in Claude, so nika doesn't send scroll keys. Close it first, or scroll in the terminal.",
    'menu-open': "Claude's / menu may be open, so nika doesn't send scroll keys. Finish or clear the command first.",
    'no-view': "Claude isn't in its full-screen view here, so there is nothing for nika to scroll. The transcript shows the whole conversation.",
    'busy-switching': 'Another action is running on this session. Scroll again in a moment.',
  };

  test('(+) each 409 code has its own words', () => {
    for (const [code, line] of Object.entries(COPY)) assert.equal(refusalLine({ status: 409, code }), line, code);
    assert.equal(new Set(Object.values(COPY)).size, 5);
  });

  test('(+) no connection is "nika did not answer."; any other failure is "nika couldn\'t scroll Claude\'s view."', () => {
    assert.equal(refusalLine({ status: 0 }), 'nika did not answer.');
    for (const status of [400, 500, 502, 503]) assert.equal(refusalLine({ status, code: 'tmux_failed' }), "nika couldn't scroll Claude's view.", String(status));
    assert.equal(refusalLine({ status: 409, code: 'something-new' }), "nika couldn't scroll Claude's view.");
    assert.equal(refusalLine({ status: 409 }), "nika couldn't scroll Claude's view.");
    assert.equal(refusalLine({}), "nika couldn't scroll Claude's view.");
    assert.equal(refusalLine(), "nika couldn't scroll Claude's view.");
  });

  test('(+) 429, 404 and 403 have no line: the next request goes after the window, and the overlays speak for the other two', () => {
    for (const status of [429, 404, 403]) assert.equal(refusalLine({ status, code: 'prompt-open' }), null, String(status));
  });

  test('(−) a code only counts with a 409, and a hostile or inherited code never selects a line', () => {
    assert.equal(refusalLine({ status: 500, code: 'prompt-open' }), "nika couldn't scroll Claude's view.");
    for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '<img src=x onerror=alert(1)>', 7, null, {}]) {
      assert.equal(refusalLine({ status: 409, code }), "nika couldn't scroll Claude's view.", String(code));
    }
  });

  test('(−) the words are the page\'s own: no server text reaches the line', () => {
    const all = [...Object.values(COPY), refusalLine({ status: 0 }), refusalLine({ status: 500 })];
    for (const line of all) assert.doesNotMatch(line, /<|>|&#|tmux/);
    assert.equal(refusalLine({ status: 409, code: 'prompt-open', message: 'A permission prompt is open. Answer it first.' }), COPY['prompt-open']);
  });
});

describe('noteView and scrolledSay: the corner of the mirror', () => {
  test('(+) nothing scrolled: no note, Jump to live hidden', () => {
    assert.deepEqual(noteView({ frozen: false, scrolled: false }), { jump: false, note: null });
    assert.deepEqual(noteView({}), { jump: false, note: null });
    assert.deepEqual(noteView(), { jump: false, note: null });
  });

  test('(+) nika\'s own Paused keeps its words and gains the pause icon; Jump to live is shown', () => {
    assert.deepEqual(noteView({ frozen: true, scrolled: false }), { jump: true, note: { kind: 'paused', icon: 'pause', text: 'Paused while you scroll' } });
  });

  test('(+) Claude\'s view scrolled up has its own kind, the up icon and its own words; Jump to live is shown', () => {
    assert.deepEqual(noteView({ frozen: false, scrolled: true }), { jump: true, note: { kind: 'scrolled', icon: 'up', text: "Scrolled up in Claude's view" } });
  });

  test('(+) both: the note says the more (Claude\'s view), Jump to live is shown once', () => {
    assert.deepEqual(noteView({ frozen: true, scrolled: true }), { jump: true, note: { kind: 'scrolled', icon: 'up', text: "Scrolled up in Claude's view" } });
  });

  test('(+) the two notes differ in kind, icon and words (never colour alone)', () => {
    const a = noteView({ frozen: true }).note;
    const b = noteView({ scrolled: true }).note;
    assert.notEqual(a.kind, b.kind);
    assert.notEqual(a.icon, b.icon);
    assert.notEqual(a.text, b.text);
  });

  test('(−) only exactly true counts', () => {
    for (const v of [1, 'true', {}, null, undefined]) assert.deepEqual(noteView({ frozen: v, scrolled: v }), { jump: false, note: null }, String(v));
  });

  test('(+) the announcements: one for scrolled up, one for back at the bottom', () => {
    assert.equal(scrolledSay(true), "Scrolled up in Claude's view. Jump to live returns to the bottom.");
    assert.equal(scrolledSay(false), 'Back at the live bottom.');
  });
});

describe('the module itself', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'scroll.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  test('(−) no DOM, request, storage or timer of its own, and no key name: it asks for a direction and a count', () => {
    assert.doesNotMatch(code, /\b(document|window|navigator|location)\s*[.[]|\b(fetch|setTimeout|setInterval|clearTimeout|XMLHttpRequest)\s*\(|localStorage|sessionStorage|\/api\//);
    assert.doesNotMatch(code, /PPage|NPage|C-Home|C-End|send-keys/);
  });

  test('(+) ASCII only: every symbol is an escape', () => {
    assert.equal([...src].every((ch) => ch.codePointAt(0) < 128), true);
  });
});
