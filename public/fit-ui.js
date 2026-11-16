// The fit, the page side (nika 0.5, design W7 sections 5, 8 and 9; the routes: docs/contracts/api-app.md, PUT and DELETE
// /api/app/pane/:id/fit). The session window measures its terminal panel in cells, asks the server to fit the mirrored pane to it,
// keeps that lease alive, gives it back on close, scales the text while the pane is larger than the panel, and shows the state in a
// header chip, a button that opens a panel with the reason and, where it helps, Fit again (F1, design F12). F10 (design F10): the panel is measured
// only at fixed moments (remeasure), the page may ask once for room for Claude's footer (askSize, roomStep) and keeps drawing the last good frame
// until Claude has repainted at the new size (frameReady, createRedrawHold). This file has no DOM and makes no request of its own: session.js hands
// createFitPlanner a route, a clock and a chip sink, so Node tests every rule (test/fit-ui.test.js). A server answer is data: chipView looks its
// words up in fixed tables, so no string of the server ever reaches the page.
// Keep this file ASCII: write every symbol as an escape.

export const BEAT_MS = 5000; // heartbeat; the server lets a lease lapse after 15 s without one
export const DEBOUNCE_MS = 250; // a resized panel is asked for this long after the last change
export const SCALE_MIN = 0.4; // below this the text stops shrinking and the terminal scrolls instead
export const FOCUS_SETTLE_MS = 150; // focus must hold this long before nika takes the size (a glance at nika costs nothing); F10, owner answer Q2 (F9: 400)
export const BLUR_SETTLE_MS = 150; // blur must hold this long before nika gives it back (a menu or a flick back costs nothing); F10, owner answer Q2 (F9: 200)
export const FOCUS_POLL_MS = 1000; // hasFocus() is read this often while started: a missed event is caught within a second
export const HOLD_MS = 1200; // after nika's own resize the last good frame stays up this long at most (Claude repaints within 340-680 ms)
export const HOLD_POLL_MS = 100; // the mirror polls this often while a hold runs (normal: 250 ms)
export const ROOM_ROWS = 33; // the rows asked for once when Claude's input box and footer did not fit the panel (a pane of 32 holds a 7-line task list)
export const REFIT_MS = 120; // the new frame fades (and zooms) in over this long; none with prefers-reduced-motion
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

const isFrame = (f) => f !== null && typeof f === 'object';
const hasBox = (draft) => draft !== null && typeof draft === 'object'; // cleanDraft's answer: an object when Claude's input box is readable

/**
 * F10: whether the panel is measured again. `prev` is the held frame, `next` a frame just taken, both { width, height, cellW, cellH, iw, ih } (the
 * terminal box's border box and one glyph cell in CSS px, the window's inner size). True with no `prev`, when the window's inner width or height
 * differs, when a cell side differs by more than 0.01 px, or when the width moved by one cell or more. A change of the height alone is never a
 * reason (a header wrap, a banner, a composer line, a prompt panel, the textarea), nor is a width change of less than one cell.
 */
export function remeasure(prev, next) {
  if (!isFrame(next)) return false;
  if (!isFrame(prev)) return true;
  if (next.iw !== prev.iw || next.ih !== prev.ih) return true;
  if (Math.abs(next.cellW - prev.cellW) > 0.01 || Math.abs(next.cellH - prev.cellH) > 0.01) return true;
  return Math.abs(next.width - prev.width) >= prev.cellW;
}

/**
 * F10: the size the page asks the route for. `frame` is the held frame ({ cols, rows }); without `room`, or when it already has ROOM_ROWS rows or more, that
 * is the frame. With `room` it is ROOM_ROWS rows and as many columns as keep the panel's proportion once the border row `d` is taken off (0 or 1, else 0),
 * so the scaled text fills the panel's width too: never fewer than the frame's columns, never more than the route's 400.
 */
export function askSize(frame, room, d) {
  const { cols, rows } = frame;
  if (room !== true || rows >= ROOM_ROWS) return { cols, rows };
  const border = d === 0 || d === 1 ? d : 0;
  return { cols: Math.max(cols, Math.min(COLS[1], Math.floor((cols * (ROOM_ROWS - border)) / rows))), rows: ROOM_ROWS };
}

/**
 * F10: whether a capture is a finished frame at the size nika asked for. `body` is the capture, `draft` its cleaned draft (null when no input box is
 * readable), `want` the answered pane size { cols, rows }, `plainBefore` whether the frame drawn before the resize showed a readable input box. The
 * size must match, and then at least one of: a readable box, a prompt, a dialog, no full-screen view, or nothing to wait for (!plainBefore).
 */
export function frameReady({ body, draft, want, plainBefore } = {}) {
  if (!body || !want || body.cols !== want.cols || !Array.isArray(body.rows) || body.rows.length !== want.rows) return false;
  return hasBox(draft) || Boolean(body.prompt) || body.dialog != null || body.alt !== true || plainBefore !== true;
}

/**
 * F10: whether the redraw hold, ending by its timeout, takes the room step (one more resize, to ROOM_ROWS rows). Every one of these must hold: room is not on
 * yet, the panel has fewer than ROOM_ROWS rows (`frameRows`), the chip says `fitted` (nika resized the window), the frame before the resize showed a readable box
 * (`plainBefore`), and the latest capture `body` is at the answered size `want`, in the full-screen view, with no prompt, no dialog and no readable `draft`.
 */
export function roomStep({ room, frameRows, state, plainBefore, want, body, draft } = {}) {
  if (room === true || !Number.isInteger(frameRows) || frameRows >= ROOM_ROWS || state !== 'fitted' || plainBefore !== true) return false;
  if (!body || !want || body.cols !== want.cols || !Array.isArray(body.rows) || body.rows.length !== want.rows) return false;
  return body.alt === true && !body.prompt && body.dialog == null && !hasBox(draft);
}

/** F10: where the zoom of a new frame starts, as a scale: the old text scale over the new one when the text grows (never below 0.5), else 1 (a fade only). */
export function refitFrom(oldScale, newScale) {
  if (!finite(oldScale) || !finite(newScale)) return 1;
  const k = oldScale / newScale;
  return k >= 1 ? 1 : Math.max(0.5, k);
}

const validPane = (p) => p !== null && typeof p === 'object' && Number.isInteger(p.cols) && p.cols >= 1 && p.cols <= 10000 && Number.isInteger(p.rows) && p.rows >= 1 && p.rows <= 10000;

/**
 * F10, design F10 4: the redraw hold. After nika's own resize the page keeps drawing the last good frame until a capture shows Claude's input box at the
 * new size, for HOLD_MS at most. `io.after(fn, ms)` / `io.cancel(timer)` are the clock; `io.timeout(pending, { want, plainBefore })` (optional) is told when
 * the time is up, with the latest capture that was kept (or null), and may start the hold again from inside (the room step), which keeps it going; if it
 * does not, the hold is over. `io.ended()` (optional) is told every time a hold stops (a ready frame, end(), a timeout that did not start it again).
 * - start({ want, plainBefore }): a hold begins (or, while one runs, goes on with the new `want` and a restarted timer; plainBefore stays that of the first
 *   start). `want` is the answered pane size { cols, rows }, or null while the answer is awaited (nothing is ready then).
 * - offer(capture = { body, draft, ... }): 'apply' with no hold, or when the capture is ready (the hold ends); else 'keep' (it becomes the pending one).
 * - wait(): a promise that resolves when no hold runs (at once when none does). end(): the hold stops now; active: whether one runs.
 */
export function createRedrawHold(io) {
  const H = { on: false, want: null, plainBefore: false, pending: null, timer: null, waiters: [] };

  const stop = () => {
    if (H.timer !== null) io.cancel(H.timer);
    H.timer = null;
    H.on = false;
    H.want = null;
    H.pending = null;
    const waiting = H.waiters;
    H.waiters = [];
    for (const resolve of waiting) resolve();
    try { io.ended?.(); } catch { /* a sink that throws must not strand the page */ }
  };
  const arm = () => {
    if (H.timer !== null) io.cancel(H.timer);
    H.timer = io.after(() => {
      H.timer = null;
      if (!H.on) return;
      try { io.timeout?.(H.pending, { want: H.want, plainBefore: H.plainBefore }); } catch { /* the hold ends below all the same */ }
      if (H.on && H.timer === null) stop(); // io.timeout did not start it again
    }, HOLD_MS);
  };

  return {
    start({ want, plainBefore } = {}) {
      if (!H.on) {
        H.on = true;
        H.plainBefore = plainBefore === true;
        H.pending = null;
      }
      H.want = validPane(want) ? { cols: want.cols, rows: want.rows } : null;
      arm();
    },
    offer(capture) {
      if (!H.on) return 'apply';
      if (frameReady({ body: capture?.body, draft: capture?.draft, want: H.want, plainBefore: H.plainBefore })) {
        stop();
        return 'apply';
      }
      H.pending = capture;
      return 'keep';
    },
    wait() {
      return H.on ? new Promise((resolve) => { H.waiters.push(resolve); }) : Promise.resolve();
    },
    end() {
      if (H.on) stop();
    },
    get active() { return H.on; },
  };
}

// ---- the chip --------------------------------------------------------------------------------------------------------------

// The reason sentences are the title of the chip and part of its announcement. panel-smaller belongs to `zoomed`, the other five to `blocked`.
// The sentences of the terminal chip when nika zoomed the pane (F4), of the filled chip a terminal also shows (F9) and of the capped terminal chip (F9) are not
// reasons, so they live outside this table: a server reason can never select them, only the exact pair of state and reason does (chipView).
const TITLE = {
  'panel-smaller': 'Other panes in this tmux window would be squeezed, so nika zoomed the pane and scaled the text',
  'user-zoom': 'You zoomed another pane in this window; nika leaves it',
  'size-option': 'This tmux window has a window-size setting nika does not change',
  'foreign-tag': 'Another program marks this tmux window',
  changed: 'The tmux window changed while nika was fitting it, so nika put it back',
  'user-change': 'You changed this tmux window, so nika put it back', // the panel's Fit again is the way back (F1)
};
const BLOCKED_PLAIN = 'nika is not fitting this tmux window';
const TERMINAL_ZOOM = 'A terminal shows this tmux window and this window does not have focus, so nika only zoomed this pane, leaves the size to the terminal and scales the text to this panel';
const FITTED_TERMINAL = 'nika sized the tmux window to this panel because this window has focus; your terminal shows it too and gets its size back when you click into it';
const TERMINAL_SWITCHING = 'You switched between this window and your terminal often in the last minute, so nika leaves the size to the terminal for now and scales the text to this panel';

// Each state has its own word, icon (a symbol of session.html's sprite) and colour (session.css, data-k), never colour alone.
const STATE = {
  fitted: { icon: 'fit', text: `Fit ${DOT} fills the panel`, label: 'Fit: fills the panel', title: 'nika sized the tmux window to this panel and puts it back when this window closes' },
  zoomed: { icon: 'zoom', text: `Fit ${DOT} zoomed, text scaled`, label: 'Fit: zoomed, text scaled', title: TITLE['panel-smaller'] },
  blocked: { icon: 'off', text: `Fit ${DOT} off`, label: 'Fit: off', title: BLOCKED_PLAIN },
  other: { icon: 'window', text: `Fit ${DOT} another window`, label: 'Fit: another window', title: 'Another nika window shows a pane of this tmux window' },
  // F4: a terminal shows the tmux window, so nika leaves its size to the terminal and only scales the text (one pane or several: one chip)
  // F9: only a window without focus leaves its size to the terminal (a focused one gets the size, `fitted`), which the title says
  terminal: { icon: 'term', text: `Fit ${DOT} your terminal's size`, label: "Fit: your terminal's size", title: 'A terminal shows this tmux window and this window does not have focus, so nika leaves the size to the terminal and scales the text to this panel' },
};

/** What the chip shows for a PUT answer: { key, state, icon, text, label, title, say }, or null when the body is not a fit answer (the chip stays as it was). label is the button's name and the panel's heading. */
export function chipView(body) {
  const fit = body?.fit;
  const state = fit?.state;
  if (typeof state !== 'string' || !Object.hasOwn(STATE, state)) return null;
  const reason = typeof fit.reason === 'string' && fit.reason !== 'panel-smaller' && Object.hasOwn(TITLE, fit.reason) ? fit.reason : '';
  const v = STATE[state];
  // F9: the one reason `terminal` takes is `switching` (the page has focus, but nika took the size back too often in the last minute), and the one `fitted` takes
  // is `terminal` (the page has focus and a terminal shows the window too); any other reason on either is ignored, and the comparison is exact
  const term = state === 'terminal' && fit.reason === 'switching';
  // F4: with several panes (and not the user's own zoom) nika zoomed the pane, which the title says; `panes` and `userZoom` are read as data and never shown
  const zoom = state === 'terminal' && !term && Number.isInteger(fit.panes) && fit.panes > 1 && fit.userZoom !== true;
  const shared = state === 'fitted' && fit.reason === 'terminal';
  const sub = state === 'blocked' ? reason : term ? 'switching' : zoom ? 'zoom' : shared ? 'terminal' : '';
  const title = state === 'blocked' && reason ? TITLE[reason] : term ? TERMINAL_SWITCHING : zoom ? TERMINAL_ZOOM : shared ? FITTED_TERMINAL : v.title;
  return { key: `${state}:${sub}`, state, icon: v.icon, text: v.text, label: v.label, title, say: `${v.label}. ${title}` };
}

// ---- the panel behind the chip (F1, design F12 2.3) ----------------------------------------------------------------------------

const PANEL_NOTE = 'nika could not fit the window just now. It tries again within 5 seconds.';
// F10: the panel of a fitted view while the page asked for ROOM_ROWS rows (the hint replaces the view's own; Fit again clears the room and asks for the panel's size)
const ROOM_HINT = "Claude's input box and footer did not fit this panel's rows, so nika gave the pane 33 rows and scaled the text. Fit again tries the panel's own size.";
const FITTING = 'Fitting\u2026';
// Looked up by the key of a chipView, never by a word of the server. `action` is the button's text: only where open: true can change
// something (the server refuses it again for user-zoom, size-option and foreign-tag, and those recover once the user acts in tmux).
const PANEL = {
  'fitted:': {},
  'zoomed:': { hint: 'To fill the panel without scaled text, make this window larger or hide the transcript (Ctrl+Shift+H).' },
  // F4: Fit again over a window a terminal shows lands in `terminal`, so the hint no longer promises a size
  'blocked:user-change': { hint: 'Fit again turns the fit on once more. After a change of your own nika stays off until you ask.', action: 'Fit again' },
  'blocked:changed': { hint: 'Fit again tries once more.', action: 'Fit again' },
  'blocked:': { action: 'Fit again' },
  'blocked:user-zoom': { hint: 'Unzoom it in tmux (prefix, then z) and nika fits the window by itself.' },
  'blocked:size-option': {},
  'blocked:foreign-tag': { hint: 'If no other nika runs, clear the mark in that tmux window, then nika fits it by itself:', code: 'tmux set-option -wu @nika-fit' },
  'other:': { hint: 'The other nika window stops fitting it.', action: 'Fit here' },
  // F9: a terminal shows the window and this window has focus: the panel is filled and the terminal shows dots (no action: nothing to press)
  'fitted:terminal': { hint: 'Your terminal shows dots around this tmux window while this window has focus. Click into the terminal and it gets its own size back within a second.' },
  // F4: no action: the terminal rule cannot be overridden (open: true lands here again); the 30 s are the owner's answer Q2 (GROW_MS on the server).
  // F9: a click into this window is the way to the size now (owner decision 2026-11-16: the focused one wins)
  'terminal:': { hint: 'Click into this window and nika sizes the tmux window to this panel; your terminal gets its size back when you click into it again. With no terminal on the window for 30 seconds, nika also sizes it to this panel by itself.' },
  'terminal:zoom': { hint: 'Your terminal shows this pane zoomed too, until this session window closes. Click into this window and nika sizes the tmux window to this panel.' },
  'terminal:switching': { hint: 'nika sizes the tmux window to this panel again within a minute while this window keeps focus.' },
};

/**
 * What the chip's panel shows: { heading, why, hint, code, action, note } for a chipView and the panel's own state `ui` ({ pending, note }),
 * or null when `view` is not one. heading and why are the view's label and title; hint, code (a command shown as text) and action
 * ({ text }, "Fitting..." while pending) come from a fixed table by the view's key, and a key it does not know has none of them.
 * F10: `ui.room` (exactly true) turns the hint into ROOM_HINT and the action into Fit again for `fitted:` and `fitted:terminal`; every other key ignores it.
 */
export function fitPanelView(view, ui) {
  if (view === null || typeof view !== 'object' || typeof view.key !== 'string') return null;
  const row = Object.hasOwn(PANEL, view.key) ? PANEL[view.key] : {};
  const room = ui?.room === true && (view.key === 'fitted:' || view.key === 'fitted:terminal');
  const action = room ? 'Fit again' : row.action;
  return {
    heading: typeof view.label === 'string' ? view.label : '',
    why: typeof view.title === 'string' ? view.title : '',
    hint: room ? ROOM_HINT : row.hint ?? null,
    code: row.code ?? null,
    action: action ? { text: ui?.pending === true ? FITTING : action } : null,
    note: ui?.note === true ? PANEL_NOTE : null,
  };
}

/** The announcement when Fit again was answered and nothing changed (the chip is not told, so its own announcement does not come). */
export const stillOffSay = (view) => `Fit is still off. ${view.title}`;

// ---- the requests ------------------------------------------------------------------------------------------------------------

const validSize = (cols, rows) => Number.isInteger(cols) && cols >= COLS[0] && cols <= COLS[1] && Number.isInteger(rows) && rows >= ROWS[0] && rows <= ROWS[1];
const same = (a, b) => a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;

/**
 * The page's fit requests. `io.send(body)` -> Promise<{ status, body }> (PUT), `io.release()` (DELETE, fire and forget), `io.after(fn, ms)`
 * / `io.cancel(timer)`, `io.chip(view | null, { quiet })` (told on a change of state only; null hides it; quiet: the change followed a change of
 * the page's focus, so it is not announced again, F9), `io.fitAgain(event)` (optional, see below), `io.focused()` (optional, F9, see below).
 * - One request in flight; a newer size waits and the latest wins. A resized panel is asked for after DEBOUNCE_MS; an unchanged size is
 *   not asked for; a heartbeat every BEAT_MS always is (it renews the lease), unless a request is already in flight.
 * - The first request of a page load is open: true, and stays so until the server has answered one with 200. Every later one is
 *   open: false, also after blocked / user-change or blocked / changed (the server keeps it off; only a new page load or reopen()
 *   opens again), and also after a close() and a start() (the pane was gone and came back): a lease is acquired by open: false when
 *   none is held.
 * - reopen() is the user's Fit again (F1): the next request is open: true. It is told to `io.fitAgain` (optional): { pending: true } at
 *   once, then { pending: false, status, view, changed } when the answer to that request came (view is the chipView of a 200 that was
 *   a fit answer, changed: the chip was told this time). A refused or lost ask is tried again by the next heartbeat, silently.
 * - 409, 429, 502, a lost request or any other refusal waits for the next heartbeat. 403 stops everything for good.
 * - close() (the page leaves, the pane is gone) gives the window back with one release; start() after it is a new lease, and restart()
 *   (the page is back from the back/forward cache) is a new lease that opens like a page load.
 * - F10: `io.sized({ cols, rows })` (optional) is told the pane size of every 200 answer that carries one (`fit.pane`, integers 1 to 10000), before the chip of
 *   that answer, so the page can hold the chip until the new frame is drawn. A stale answer, a refusal and a body of another shape tell nothing.
 * - F9, the focused window wins the pane's size: every body carries `focus`, the boolean `io.focused()` answers (anything but the boolean true, a throw
 *   and a missing io.focused all read as false: a page that cannot tell holds nothing). The page tells the planner of a possible change with
 *   focusChanged(immediate); the value is always read fresh from io.focused(), so an event is only a trigger. A change must hold for a moment before it is
 *   sent (BLUR_SETTLE_MS for a blur, FOCUS_SETTLE_MS for a focus; a flick back sends nothing), unless the window was hidden (immediate: sent at once), and
 *   it is sent at once, not on the heartbeat. A poll every FOCUS_POLL_MS reads io.focused() too (a missed event is caught within a second) and sends a
 *   focus change that was refused or lost again, without waiting for the heartbeat. A change that arrives while a request is in flight goes out right after it.
 */
export function createFitPlanner(io) {
  // ask: the user's Fit again: null, 'queued' (the next request is open: true) or 'sent' (that request is in flight)
  // F9 focus: the settled value the requests carry; acked: the focus of the last request answered 200 (null before one); settle / settleTo: the timer of a
  // change that has not held long enough yet and the value it moves to; poll: the timer of the focus poll; due: a change waits for the request in flight
  const P = {
    on: false, dead: false, gen: 0, want: null, sent: null, opened: false, ask: null, busy: false, hold: false, debounce: null, beat: null, key: null,
    focus: false, acked: null, settle: null, settleTo: null, poll: null, due: false,
  };

  /** The page's focus, read fresh: only the boolean true counts (anything else, a throw and a missing io.focused are no focus). */
  const read = () => {
    try { return io.focused?.() === true; } catch { return false; }
  };

  const clear = (name) => {
    if (P[name] !== null) io.cancel(P[name]);
    P[name] = null;
  };
  const halt = () => {
    P.on = false;
    P.due = false;
    clear('debounce');
    clear('beat');
    clear('settle');
    clear('poll');
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
  const armPoll = () => {
    clear('poll');
    P.poll = io.after(() => { P.poll = null; poll(); }, FOCUS_POLL_MS);
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
    const focus = P.focus;
    const open = !P.opened || P.ask === 'queued';
    const asked = P.ask === 'queued';
    if (asked) P.ask = 'sent';
    P.busy = true;
    // the executor runs at once, so the request still goes out synchronously; a send that throws is a lost request, not a stuck busy
    new Promise((resolve) => { resolve(io.send({ cols: want.cols, rows: want.rows, open, focus })); }).then((r) => settle(gen, want, r, asked, focus), () => settle(gen, want, null, asked, focus));
  }

  /** The request of the user's ask ended: one fitAgain call, whatever the outcome. */
  function answered(status, view, changed) {
    P.ask = null;
    io.fitAgain?.({ pending: false, status: Number.isInteger(status) ? status : 0, view, changed });
  }

  function settle(gen, want, r, asked, focus) {
    if (gen !== P.gen || !P.on) return; // the lease it belonged to is over (closed, stopped or started again)
    P.busy = false;
    const status = r?.status;
    if (status === 403) { // the page has no right to the route: nothing renews the lease any more, so the chip must not claim one
      P.dead = true;
      halt();
      unchip();
      if (asked) answered(status, null, false);
      return;
    }
    if (status !== 200) { // busy, rate limit, tmux failure, a lost request: the next heartbeat asks again
      P.hold = true;
      if (asked) { // and that asking is open: true again, so the retry is not lost
        P.opened = false;
        answered(status, null, false);
      }
      return;
    }
    P.opened = true;
    P.sent = want;
    const pane = r.body?.fit?.pane;
    if (validPane(pane)) { // F10: the page learns what the pane is now (before the chip: it may hold both until the new frame is ready)
      try { io.sized?.({ cols: pane.cols, rows: pane.rows }); } catch { /* the planner goes on without the page's hold */ }
    }
    // F9: a state change that follows a change of the page's focus is not announced again (the user made it); the user's own Fit again always is
    const quiet = !asked && P.acked !== null && focus !== P.acked;
    P.acked = focus;
    const view = chipView(r.body);
    let changed = false;
    if (view && view.key !== P.key) {
      P.key = view.key;
      changed = true;
      io.chip(view, { quiet });
    }
    if (asked) answered(status, view, changed);
    if (!same(P.want, P.sent)) schedule(); // the panel changed while this request was in flight
    if (P.due) { // a change of focus came while this request was in flight: it goes out now
      P.due = false;
      flush(true);
    }
    if (P.ask === 'queued') flush(true); // an ask made while this request was in flight goes out now
  }

  /** The focus the requests carry is now `f`: sent at once, or right after the request in flight. */
  function apply(f) {
    P.focus = f;
    P.hold = false;
    if (P.busy) P.due = true;
    else flush(true);
  }

  /** The page may have gained or lost focus (an event, or `immediate`: the window was hidden or shown, which needs no settling). */
  function focusChanged(immediate) {
    if (!P.on || P.dead) return;
    const f = read();
    if (f === P.focus) { // nothing to say, and a change that went back is forgotten
      clear('settle');
      return;
    }
    if (immediate === true) {
      clear('settle');
      apply(f);
      return;
    }
    if (P.settle !== null && P.settleTo === f) return; // already settling towards it
    clear('settle');
    P.settleTo = f;
    P.settle = io.after(() => {
      P.settle = null;
      if (!P.on) return;
      const g = read(); // the settle ends: the value now, not the one that started it
      if (g !== P.focus) apply(g);
    }, f ? FOCUS_SETTLE_MS : BLUR_SETTLE_MS);
  }

  /** Every FOCUS_POLL_MS: a change no event told of starts its settle; a focus change that was refused or lost is sent again (at most once a second). */
  function poll() {
    if (!P.on) return;
    armPoll();
    if (P.settle === null && read() !== P.focus) {
      focusChanged(false);
      return;
    }
    if (!P.busy && (P.due || (P.acked !== null && P.acked !== P.focus))) {
      P.due = false;
      P.hold = false;
      flush(true);
    }
  }

  function beat() {
    if (!P.on) return;
    const f = read();
    if (f !== P.focus) { // a heartbeat, or a window shown again, is settled enough
      clear('settle');
      P.focus = f;
      if (P.busy) P.due = true;
    }
    P.hold = false;
    arm();
    flush(true);
  }

  function start() {
    if (P.on || P.dead) return;
    P.gen += 1;
    Object.assign(P, { on: true, sent: null, ask: null, busy: false, hold: false, due: false, acked: null, settleTo: null, focus: read() });
    clear('settle');
    arm();
    armPoll();
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
    /**
     * The panel is cols x rows now. Remembered before start; asked for at once while nothing has been answered, else after the debounce.
     * F10: `opts.now` (exactly true) asks at once even after an answer (the room step), unless a request is in flight or a refusal waits for the heartbeat:
     * then it goes after them like any size.
     */
    size(cols, rows, opts) {
      if (!validSize(cols, rows)) return;
      P.want = { cols, rows };
      if (!P.on) return;
      if (P.sent === null) flush(true);
      else if (opts?.now === true && !P.busy && !P.hold) {
        clear('debounce');
        flush(false);
      } else schedule();
    },
    /** The window shows again (timers may have been suspended): one request now, and the next heartbeat 5 s on. It carries the focus read now (F9). */
    beat,
    /**
     * F9: the page's focus may have changed (a window focus or blur event, or visibilitychange). The value is read from io.focused(), not taken from the
     * caller. `immediate`: true when the window was hidden or shown (sent at once); else the change must hold BLUR_SETTLE_MS / FOCUS_SETTLE_MS first.
     * A no-op before start(), after close() and after a 403.
     */
    focusChanged,
    /**
     * The user asks to fit again (F1): the next request is open: true, sent now (a hold is cleared and the heartbeat re-armed), or at once
     * when the one in flight has ended. false, and nothing happens, before start(), after close(), after a 403 and while an ask is pending.
     */
    reopen() {
      if (!P.on || P.dead || P.ask !== null) return false;
      P.ask = 'queued';
      io.fitAgain?.({ pending: true });
      if (!P.busy) beat();
      return true;
    },
    /** The page leaves or the pane is gone: the window comes back (one release), the timers stop, the chip hides. A pending ask is dropped without a word. */
    close() {
      if (!P.on) return;
      halt();
      P.ask = null;
      io.release();
      unchip();
    },
  };
}
