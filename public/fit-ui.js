// The fit, the page side (nika 0.5, design W7 sections 5, 8 and 9; the routes: docs/contracts/api-app.md, PUT and DELETE
// /api/app/pane/:id/fit). The session window measures its terminal panel in cells, asks the server to fit the mirrored pane to it,
// keeps that lease alive, gives it back on close, scales the text while the pane is larger than the panel, and shows the state in a
// header chip. This file has no DOM and makes no request of its own: session.js hands createFitPlanner a route, a clock and a chip
// sink, so Node tests every rule (test/fit-ui.test.js). A server answer is data: chipView looks its words up in fixed tables, so no
// string of the server ever reaches the page.
// Keep this file ASCII: write every symbol as an escape.

export const BEAT_MS = 5000; // heartbeat; the server lets a lease lapse after 15 s without one
export const DEBOUNCE_MS = 250; // a resized panel is asked for this long after the last change
export const SCALE_MIN = 0.4; // below this the text stops shrinking and the terminal scrolls instead
const COLS = [40, 400]; // the route's range (design 5)
const ROWS = [10, 200];
const PAD_X = 24; // .term padding: 12 px left and right
const PAD_Y = 20; // 10 px top and bottom
const DOT = '\u00b7';

const finite = (n) => Number.isFinite(n) && n > 0;
const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, Math.floor(n)));

/** The panel in cells from the terminal box and one glyph cell, both in CSS px; null while any of them is not a positive number (nothing measured yet). */
export function panelSize({ width, height, cellW, cellH }) {
  if (![width, height, cellW, cellH].every(finite)) return null;
  return { cols: clamp((width - PAD_X) / cellW, COLS), rows: clamp((height - PAD_Y) / cellH, ROWS) };
}

/** The text scale: 1 while the pane fits the panel, smaller while it is larger, never below SCALE_MIN and never above 1. */
export function scaleFor({ panelCols, panelRows, cols, rows }) {
  if (![panelCols, panelRows, cols, rows].every(finite)) return 1;
  return Math.min(1, Math.max(SCALE_MIN, Math.min(panelCols / cols, panelRows / rows)));
}

// ---- the chip --------------------------------------------------------------------------------------------------------------

// The reason sentences are the title of the chip and part of its announcement. panel-smaller belongs to `zoomed`, the other five to `blocked`.
const TITLE = {
  'panel-smaller': 'Other panes in this tmux window would be squeezed, so nika zoomed the pane and scaled the text',
  'user-zoom': 'You zoomed another pane in this window; nika leaves it',
  'size-option': 'This tmux window has a window-size setting nika does not change',
  'foreign-tag': 'Another program marks this tmux window',
  changed: 'The tmux window changed while nika was fitting it, so nika put it back',
  'user-change': 'You changed this tmux window, so nika put it back. Reopen the session window to fit again',
};
const BLOCKED_PLAIN = 'nika is not fitting this tmux window';

// Each state has its own word, icon (a symbol of session.html's sprite) and colour (session.css, data-k), never colour alone.
const STATE = {
  fitted: { icon: 'fit', text: `Fit ${DOT} fills the panel`, label: 'Fit: fills the panel', title: 'nika sized the tmux window to this panel and puts it back when this window closes' },
  zoomed: { icon: 'zoom', text: `Fit ${DOT} zoomed, text scaled`, label: 'Fit: zoomed, text scaled', title: TITLE['panel-smaller'] },
  blocked: { icon: 'off', text: `Fit ${DOT} off`, label: 'Fit: off', title: BLOCKED_PLAIN },
  other: { icon: 'window', text: `Fit ${DOT} another window`, label: 'Fit: another window', title: 'Another nika window shows a pane of this tmux window' },
};

/** What the chip shows for a PUT answer: { key, state, icon, text, title, say }, or null when the body is not a fit answer (the chip stays as it was). */
export function chipView(body) {
  const fit = body?.fit;
  const state = fit?.state;
  if (typeof state !== 'string' || !Object.hasOwn(STATE, state)) return null;
  const reason = typeof fit.reason === 'string' && fit.reason !== 'panel-smaller' && Object.hasOwn(TITLE, fit.reason) ? fit.reason : '';
  const v = STATE[state];
  const title = state === 'blocked' && reason ? TITLE[reason] : v.title;
  return { key: `${state}:${state === 'blocked' ? reason : ''}`, state, icon: v.icon, text: v.text, title, say: `${v.label}. ${title}` };
}

// ---- the requests ------------------------------------------------------------------------------------------------------------

const validSize = (cols, rows) => Number.isInteger(cols) && cols >= COLS[0] && cols <= COLS[1] && Number.isInteger(rows) && rows >= ROWS[0] && rows <= ROWS[1];
const same = (a, b) => a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;

/**
 * The page's fit requests. `io.send(body)` -> Promise<{ status, body }> (PUT), `io.release()` (DELETE, fire and forget), `io.after(fn, ms)`
 * / `io.cancel(timer)`, `io.chip(view | null)` (told on a change of state only; null hides it).
 * - One request in flight; a newer size waits and the latest wins. A resized panel is asked for after DEBOUNCE_MS; an unchanged size is
 *   not asked for; a heartbeat every BEAT_MS always is (it renews the lease), unless a request is already in flight.
 * - The first request of a page load is open: true, and stays so until the server has answered one with 200. Every later one is
 *   open: false, also after blocked / user-change or blocked / changed (the server keeps it off; only a new page load opens again),
 *   and also after a close() and a start() (the pane was gone and came back): a lease is acquired by open: false when none is held.
 * - 409, 429, 502, a lost request or any other refusal waits for the next heartbeat. 403 stops everything for good.
 * - close() (the page leaves, the pane is gone) gives the window back with one release; start() after it is a new lease, and restart()
 *   (the page is back from the back/forward cache) is a new lease that opens like a page load.
 */
export function createFitPlanner(io) {
  const P = { on: false, dead: false, gen: 0, want: null, sent: null, opened: false, busy: false, hold: false, debounce: null, beat: null, key: null };

  const clear = (name) => {
    if (P[name] !== null) io.cancel(P[name]);
    P[name] = null;
  };
  const halt = () => {
    P.on = false;
    clear('debounce');
    clear('beat');
  };
  const unchip = () => {
    if (P.key === null) return;
    P.key = null;
    io.chip(null);
  };
  const arm = () => {
    clear('beat');
    P.beat = io.after(() => { P.beat = null; beat(); }, BEAT_MS);
  };
  const schedule = () => {
    clear('debounce');
    P.debounce = io.after(() => { P.debounce = null; flush(false); }, DEBOUNCE_MS);
  };

  function flush(renew) {
    if (!P.on || P.hold || P.busy || P.want === null) return;
    if (!renew && same(P.want, P.sent)) return; // skip unchanged
    const want = P.want;
    const gen = P.gen;
    P.busy = true;
    // the executor runs at once, so the request still goes out synchronously; a send that throws is a lost request, not a stuck busy
    new Promise((resolve) => { resolve(io.send({ cols: want.cols, rows: want.rows, open: !P.opened })); }).then((r) => settle(gen, want, r), () => settle(gen, want, null));
  }

  function settle(gen, want, r) {
    if (gen !== P.gen || !P.on) return; // the lease it belonged to is over (closed, stopped or started again)
    P.busy = false;
    const status = r?.status;
    if (status === 403) { // the page has no right to the route: nothing renews the lease any more, so the chip must not claim one
      P.dead = true;
      halt();
      unchip();
      return;
    }
    if (status !== 200) { // busy, rate limit, tmux failure, a lost request: the next heartbeat asks again
      P.hold = true;
      return;
    }
    P.opened = true;
    P.sent = want;
    const view = chipView(r.body);
    if (view && view.key !== P.key) {
      P.key = view.key;
      io.chip(view);
    }
    if (!same(P.want, P.sent)) schedule(); // the panel changed while this request was in flight
  }

  function beat() {
    if (!P.on) return;
    P.hold = false;
    arm();
    flush(true);
  }

  function start() {
    if (P.on || P.dead) return;
    P.gen += 1;
    Object.assign(P, { on: true, sent: null, busy: false, hold: false });
    arm();
    flush(true);
  }

  return {
    /** The first capture answered: the pane is live, so the lease is asked for now. A no-op while started, and after a 403; after a close() it asks again. */
    start,
    /** The page came back from the back/forward cache: a new page load, so after a close() the lease opens like the first one (open: true). A no-op while started and after a 403. */
    restart() {
      if (P.on || P.dead) return;
      P.opened = false;
      start();
    },
    /** The panel is cols x rows now. Remembered before start; asked for at once while nothing has been answered, else after the debounce. */
    size(cols, rows) {
      if (!validSize(cols, rows)) return;
      P.want = { cols, rows };
      if (!P.on) return;
      if (P.sent === null) flush(true);
      else schedule();
    },
    /** The window shows again (timers may have been suspended): one request now, and the next heartbeat 5 s on. */
    beat,
    /** The page leaves or the pane is gone: the window comes back (one release), the timers stop, the chip hides. */
    close() {
      if (!P.on) return;
      halt();
      io.release();
      unchip();
    },
  };
}
