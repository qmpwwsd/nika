// The fit, the page side (nika 0.5, design W7 sections 5, 8 and 9; the routes: docs/contracts/api-app.md, PUT and DELETE
// /api/app/pane/:id/fit). The session window measures its terminal panel in cells, asks the server to fit the mirrored pane to it,
// keeps that lease alive, gives it back on close, scales the text while the pane is larger than the panel, and shows the state in a
// header chip, a button that opens a panel with the reason and, where it helps, Fit again (F1, design F12). F10 (design F10): the panel is measured
// only at fixed moments (remeasure), the page may ask once for room for Claude's footer (askSize, roomStep) and keeps drawing the last good frame
// until Claude has repainted at the new size (frameReady, createRedrawHold). F11 (design F11): while the mirror hides Claude's input box and footer under its
// one-row strip, the size asked also counts those hidden rows (hiddenRows, fillSize) and the text scale counts only the rows drawn (drawnScale). F16 (design F16): while a
// question Claude draws taller than the pane is cut off at its top and the fit is `fitted`, the page asks for more rows, one step at a time (growStep, growNext, growAsk), keeps
// the text scale of the size without the grow (scaleRows) and holds the last frame until the question is whole (frameReady, cutBefore). This file has no DOM and makes no request of its own: session.js hands
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
export const HIDE_MAX = 24; // more hidden rows than a readable box (13 + 2 rules) and a footer can make: the screen is not one F11 knows, so nothing is added
export const GROW_STEP_MIN = 12; // F16: a step adds at least this many rows
export const GROW_CAP = 120; // F16: the most window rows a grow asks (the reader finds a strip within 100 rows of the footer, plus a rule, the task block and the border row)
export const GROW_CONFIRM_MS = 200; // F16: a cut question must still be cut this long after it was first seen (the next capture or 304)
export const GROW_SETTLE_MS = 800; // F16: after the pane shows the grown size, Claude's repaint (340-680 ms) has this long before "still cut" counts
export const GROW_WAIT_MS = 6000; // F16: a step whose size the drawn frame never reaches in this long (while fitted) is given up (more than BEAT_MS)
export const GROW_CLOSE_MS = 1000; // F16: no question on screen for this long: it is closed and the size goes back
/** F16: the grow's state at rest. phase: idle, stepping, held or spent; rows: the window rows asked (0 when none); askedAt: when the last step was asked; settleAt: when "still cut" counts (null: not started); cutSince: when a cut was first seen while idle; quietSince: when the question went off the screen; base: the base size a given-up grow gave up at, `<cols>x<rows>`. */
export const GROW_IDLE = Object.freeze({ phase: 'idle', rows: 0, askedAt: 0, settleAt: null, cutSince: null, quietSince: null, base: '' });
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

// F11: a row has ink when some span of it holds a character other than a space or U+00A0
const inked = (row) => Array.isArray(row) && row.some((span) => span !== null && typeof span === 'object' && typeof span.t === 'string' && /[^ \u00a0]/.test(span.t));

/**
 * F11: the rows Claude draws from the cut row down (its input box and footer, which the mirror hides under a one-row strip): the last row with ink + 1 - cut.
 * `rows` is the capture's rows (arrays of spans { t, s }), `cut` the cut drawn. 0 with no cut, a cut that is not an integer 1..rows-1, no ink at or below it, or
 * more than HIDE_MAX. Trailing blank rows are not counted: in Claude's classic view a short session leaves blank rows under the footer, and counting them would
 * ask for rows that only add more blank rows.
 */
export function hiddenRows(rows, cut) {
  if (!Array.isArray(rows) || !Number.isInteger(cut) || cut < 1 || cut >= rows.length) return 0;
  let last = -1;
  for (let i = rows.length - 1; i >= cut; i -= 1) {
    if (inked(rows[i])) {
      last = i;
      break;
    }
  }
  const k = last + 1 - cut;
  return k >= 1 && k <= HIDE_MAX ? k : 0;
}

const validHide = (hide) => Number.isInteger(hide) && hide >= 1 && hide <= HIDE_MAX;
/** F11: the strip's height in CSS px as measured; a value that is not a positive number up to 4 cells counts as 2 cells (a conservative fallback: never overfills). */
const stripPx = (strip, cellH) => (typeof strip === 'number' && strip > 0 && strip <= 4 * cellH ? strip : 2 * cellH);

/**
 * F11: the size asked at a commit. Without hidden rows it is askSize (F10). With `hide` rows (1..HIDE_MAX) under the strip it keeps askSize's columns and
 * text scale s0 and asks the rows that fill the panel above the strip at s0, plus the hidden rows, plus the border row: never fewer rows than askSize, at most 200.
 * `frame` is the held frame ({ cols, rows, height, cellH }), `strip` the strip's height in CSS px (see stripPx).
 */
export function fillSize(frame, room, d, hide, strip) {
  const base = askSize(frame, room, d);
  if (!validHide(hide) || !finite(frame.height) || !finite(frame.cellH)) return base;
  const border = d === 0 || d === 1 ? d : 0;
  const s0 = scaleFor({ panelCols: frame.cols, panelRows: frame.rows, cols: base.cols, rows: base.rows - border });
  const above = Math.floor((frame.height - PAD_Y - stripPx(strip, frame.cellH)) / (frame.cellH * s0));
  if (!(above >= 1)) return base;
  return { cols: base.cols, rows: Math.min(ROWS[1], Math.max(base.rows, above + hide + border)) };
}

/**
 * F11: the text scale while `hide` rows of a cols x rows pane are cut off the bottom and the strip (`strip` px) is drawn in their place: the rows above the cut and
 * the strip fill the panel's height (exact px), the columns its width; never above 1, never below SCALE_MIN. With no valid hide (0, not an integer, more than
 * HIDE_MAX, or no row left above the cut), or a frame without a height or cell height, it is scaleFor of the panel's cells (F10).
 */
export function drawnScale({ frame, cols, rows, hide, strip }) {
  const plain = () => scaleFor({ panelCols: frame.cols, panelRows: frame.rows, cols, rows });
  if (!validHide(hide) || !finite(frame.height) || !finite(frame.cellH) || ![frame.cols, cols, rows].every(finite) || !(rows - hide >= 1)) return plain();
  const byHeight = (frame.height - PAD_Y - stripPx(strip, frame.cellH)) / ((rows - hide) * frame.cellH);
  return Math.min(1, Math.max(SCALE_MIN, Math.min(frame.cols / cols, byHeight)));
}

/**
 * F10: whether a capture is a finished frame at the size nika asked for. `body` is the capture, `draft` its cleaned draft (null when no input box is
 * readable), `want` the answered pane size { cols, rows }, `plainBefore` whether the frame drawn before the resize showed a readable input box. The
 * size must match, and then at least one of: a readable box, a prompt, a dialog, no full-screen view, or nothing to wait for (!plainBefore).
 * F12: with `modeBefore` exactly true (Claude's mode line was readable before the resize) a readable box counts only when the capture also has
 * `modeConfirmed` exactly true; the other four exits are as they were.
 * F16: with `cutBefore` exactly true (a grow step for a question clipped at the top) the frame is ready at the size when its question is no longer clipped at the top
 * (cutQuestion), whatever else is on screen: nothing but the repaint of that question is waited for.
 */
export function frameReady({ body, draft, want, plainBefore, modeBefore, cutBefore } = {}) {
  if (!body || !want || body.cols !== want.cols || !Array.isArray(body.rows) || body.rows.length !== want.rows) return false;
  if (cutBefore === true) return !cutQuestion(body.dialog);
  const box = hasBox(draft) && (modeBefore !== true || body.modeConfirmed === true);
  return box || Boolean(body.prompt) || body.dialog != null || body.alt !== true || plainBefore !== true;
}

/**
 * F10: whether the redraw hold, ending by its timeout, takes the room step (one more resize, to ROOM_ROWS rows). Every one of these must hold: room is not on
 * yet, the panel has fewer than ROOM_ROWS rows (`frameRows`), the chip says `fitted` (nika resized the window), the frame before the resize showed a readable box
 * (`plainBefore`), and the latest capture `body` is at the answered size `want`, in the full-screen view, with no prompt, no dialog and no readable `draft`.
 * F11: and `gain` is exactly true: the room ask has more rows than the request last sent (else the step would send nothing and only wait out another hold).
 * F12: a readable box does not stop the step when `modeBefore` is exactly true (Claude's mode line was readable before the resize) and the capture's `modeConfirmed`
 * is not exactly true (the mode line fell off the screen); every other condition is as it was.
 */
export function roomStep({ room, frameRows, state, plainBefore, want, body, draft, gain, modeBefore } = {}) {
  if (gain !== true || room === true || !Number.isInteger(frameRows) || frameRows >= ROOM_ROWS || state !== 'fitted' || plainBefore !== true) return false;
  if (!body || !want || body.cols !== want.cols || !Array.isArray(body.rows) || body.rows.length !== want.rows) return false;
  return body.alt === true && !body.prompt && body.dialog == null && (!hasBox(draft) || (modeBefore === true && body.modeConfirmed !== true));
}

// ---- F16: more rows for a question Claude clips at its top ---------------------------------------------------------------------

/** F16: the next step's window rows: double, at least GROW_STEP_MIN more, at most GROW_CAP (equal to `rows` or less when there is no room left). */
export const growNext = (rows) => Math.min(GROW_CAP, Math.max(rows + GROW_STEP_MIN, rows * 2));

/** F16: a question clipped at the top (a raw capture dialog or a cleanDialog answer): rows can show it. A plan, a text shortened with an ellipsis (`clipped`) and every other reason are not. */
export const cutQuestion = (d) => d !== null && typeof d === 'object' && d.kind === 'ask' && d.state === 'unreadable' && d.reason === 'cut';

const isGrown = (G) => G?.phase === 'stepping' || G?.phase === 'held';

/** F16: the size asked: `base` ({ cols, rows }, the commit's fillSize) or, while grown, the grow's rows when they are more (never above the route's 200). */
export function growAsk(base, G) {
  return isGrown(G) && Number.isInteger(G.rows) && G.rows > base.rows ? { cols: base.cols, rows: Math.min(ROWS[1], G.rows) } : { cols: base.cols, rows: base.rows };
}

/**
 * F16: the rows the text scale counts: while grown and fitted, the pane rows without the grow, else the pane's. Those are the `baseRows` window rows minus the
 * border row `d` and minus the `hide` rows of the last commit (fillSize adds Claude's hidden input-box rows to the base, but no input box is on screen while a
 * question is open, so they are never drawn: D8, the text never shrinks while grown). A `hide` that is not valid (validHide) counts as 0, as in fillSize.
 */
export function scaleRows({ paneRows, G, fitted, baseRows, d, hide }) {
  const own = Number.isInteger(baseRows) ? baseRows - (d === 1 ? 1 : 0) - (validHide(hide) ? hide : 0) : 0;
  return isGrown(G) && fitted === true && own >= 1 ? Math.min(paneRows, own) : paneRows;
}

/**
 * F16: one look at the screen. `G` is the grow's state (GROW_IDLE at rest), input { now, dialog, fitted, paneRows, baseRows, baseCols }:
 *   dialog   cleanDialog's answer for the capture drawn last (null: none)
 *   fitted   the chip state of the latest fit answer is exactly 'fitted'
 *   paneRows the drawn capture's row count
 *   baseRows, baseCols the size the fit asks without the grow
 * Returns { G, ask }: ask null (nothing to send), { rows } (ask that many window rows now) or { back: true } (ask the base size now).
 */
export function growStep(G, { now, dialog, fitted, paneRows, baseRows, baseCols }) {
  const spent = { ...GROW_IDLE, phase: 'spent', base: `${baseCols}x${baseRows}` };
  const cut = cutQuestion(dialog);
  if (dialog?.kind !== 'ask') { // no question on screen (none, a plan, a prompt, kind null)
    if (G.phase === 'idle') return { G: G.cutSince === null ? G : { ...G, cutSince: null }, ask: null };
    const quietSince = G.quietSince ?? now;
    if (now - quietSince < GROW_CLOSE_MS) return { G: { ...G, quietSince }, ask: null };
    return { G: GROW_IDLE, ask: isGrown(G) ? { back: true } : null }; // closed: a grown pane goes back, a spent one already is
  }
  const g = G.quietSince === null ? G : { ...G, quietSince: null };
  if (fitted !== true) { // parked: nothing moves, a step's clocks wait for `fitted`
    if (g.phase === 'stepping') return { G: { ...g, askedAt: now, settleAt: null }, ask: null };
    if (g.phase === 'idle' && g.cutSince !== null) return { G: { ...g, cutSince: null }, ask: null };
    return { G: g, ask: null };
  }
  if (g.phase === 'spent') return { G: g, ask: null };
  if (g.phase === 'idle') {
    if (!cut) return { G: g.cutSince === null ? g : { ...g, cutSince: null }, ask: null };
    if (g.cutSince === null) return { G: { ...g, cutSince: now }, ask: null };
    if (now - g.cutSince < GROW_CONFIRM_MS) return { G: g, ask: null };
    const rows = growNext(baseRows);
    if (!(rows > baseRows)) return { G: spent, ask: null }; // the panel is at the cap already
    return { G: { ...GROW_IDLE, phase: 'stepping', rows, askedAt: now }, ask: { rows } };
  }
  if (!cut) return { G: g.phase === 'held' ? g : { ...g, phase: 'held', settleAt: null }, ask: null }; // readable, or the top is on screen
  if (paneRows < g.rows - 1) { // the drawn frame is not at the grown size yet (the border row d is 0 or 1)
    if (g.phase === 'held') return { G: { ...g, phase: 'stepping', askedAt: now, settleAt: null }, ask: null };
    if (now - g.askedAt >= GROW_WAIT_MS) return { G: spent, ask: { back: true } };
    return { G: g, ask: null };
  }
  if (g.settleAt === null) return { G: { ...g, phase: 'stepping', settleAt: now + GROW_SETTLE_MS }, ask: null };
  if (now < g.settleAt) return { G: g, ask: null };
  const from = Math.max(g.rows, baseRows);
  const rows = growNext(from);
  if (!(rows > from)) return { G: spent, ask: { back: true } }; // still cut at the cap
  return { G: { ...g, phase: 'stepping', rows, askedAt: now, settleAt: null }, ask: { rows } };
}

/** F16: a commit changed the base size: a given-up question gets one new try at the new size (a resize by the user is a new situation). */
export const growRebase = (G, cols, rows) => (G.phase === 'spent' && G.base !== `${cols}x${rows}` ? GROW_IDLE : G);

/** F10: where the zoom of a new frame starts, as a scale: the old text scale over the new one when the text grows (never below 0.5), else 1 (a fade only). */
export function refitFrom(oldScale, newScale) {
  if (!finite(oldScale) || !finite(newScale)) return 1;
  const k = oldScale / newScale;
  return k >= 1 ? 1 : Math.max(0.5, k);
}

const validPane = (p) => p !== null && typeof p === 'object' && Number.isInteger(p.cols) && p.cols >= 1 && p.cols <= 10000 && Number.isInteger(p.rows) && p.rows >= 1 && p.rows <= 10000;

/**
 * F10, design F10 4: the redraw hold. After nika's own resize the page keeps drawing the last good frame until a capture shows Claude's input box at the
 * new size, for HOLD_MS at most. `io.after(fn, ms)` / `io.cancel(timer)` are the clock; `io.timeout(pending, { want, plainBefore, modeBefore, cutBefore })` (optional) is told when
 * the time is up, with the latest capture that was kept (or null), and may start the hold again from inside (the room step), which keeps it going; if it
 * does not, the hold is over. `io.ended()` (optional) is told every time a hold stops (a ready frame, end(), a timeout that did not start it again).
 * - start({ want, plainBefore, modeBefore, cutBefore }): a hold begins (or, while one runs, goes on with the new `want` and a restarted timer; plainBefore,
 *   modeBefore and cutBefore stay those of the first start). `want` is the answered pane size { cols, rows }, or null while the answer is awaited (nothing is ready then).
 *   F12: modeBefore (exactly true counts) says Claude's mode line was readable in the frame drawn before the resize; the hold then waits for it too.
 *   F16: cutBefore (exactly true counts) says this resize is a grow step for a question clipped at the top; the hold then waits for the question to be whole (frameReady).
 * - offer(capture = { body, draft, ... }): 'apply' with no hold, or when the capture is ready (the hold ends); else 'keep' (it becomes the pending one).
 * - wait(): a promise that resolves when no hold runs (at once when none does). end(): the hold stops now; active: whether one runs.
 */
export function createRedrawHold(io) {
  const H = { on: false, want: null, plainBefore: false, modeBefore: false, cutBefore: false, pending: null, timer: null, waiters: [] };

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
      try { io.timeout?.(H.pending, { want: H.want, plainBefore: H.plainBefore, modeBefore: H.modeBefore, cutBefore: H.cutBefore }); } catch { /* the hold ends below all the same */ }
      if (H.on && H.timer === null) stop(); // io.timeout did not start it again
    }, HOLD_MS);
  };

  return {
    start({ want, plainBefore, modeBefore, cutBefore } = {}) {
      if (!H.on) {
        H.on = true;
        H.plainBefore = plainBefore === true;
        H.modeBefore = modeBefore === true;
        H.cutBefore = cutBefore === true;
        H.pending = null;
      }
      H.want = validPane(want) ? { cols: want.cols, rows: want.rows } : null;
      arm();
    },
    offer(capture) {
      if (!H.on) return 'apply';
      if (frameReady({ body: capture?.body, draft: capture?.draft, want: H.want, plainBefore: H.plainBefore, modeBefore: H.modeBefore, cutBefore: H.cutBefore })) {
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
  // F15 (owner decision 2026-11-16, resize while zoomed): with focus nika sizes the window to the panel whatever the other panes run, so `zoomed` now means the page has no focus
  'panel-smaller': 'Other panes share this tmux window. With focus nika sizes the window to this panel; without focus it only zooms the pane and scales the text.',
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
// F10: the panel of a fitted view while the page asked for the room (the hint replaces the view's own; Fit again clears the room and asks for full-size text).
// F11 (owner answer Q3): "33 rows" is no longer exact, the room ask can carry more
const ROOM_HINT = "Claude's input box and footer did not fit this panel's rows, so nika gave the pane more rows and scaled the text. Fit again tries full-size text.";
// F16: the panel of a fitted view while a cut-off question has more rows (replaces the view's hint and the room hint; no action of its own)
const GROW_HINT = "Claude's question is taller than this panel, so nika gave the pane more rows while it is open. Scroll the terminal up to see all of it; the size goes back when the question closes.";
const FITTING = 'Fitting\u2026';
// Looked up by the key of a chipView, never by a word of the server. `action` is the button's text: only where open: true can change
// something (the server refuses it again for user-zoom, size-option and foreign-tag, and those recover once the user acts in tmux).
const PANEL = {
  'fitted:': {},
  // F15: a click into this window is the way to the size (the other panes get their size and layout back when the page loses focus)
  'zoomed:': { hint: 'Click into this window to fill the panel; the other panes get their size and layout back when you leave it.' },
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
 * F16: `ui.grow` (exactly true) turns the hint into GROW_HINT for the same two keys, over the room hint; the action is the room's alone; every other key ignores it.
 */
export function fitPanelView(view, ui) {
  if (view === null || typeof view !== 'object' || typeof view.key !== 'string') return null;
  const row = Object.hasOwn(PANEL, view.key) ? PANEL[view.key] : {};
  const room = ui?.room === true && (view.key === 'fitted:' || view.key === 'fitted:terminal');
  const grow = ui?.grow === true && (view.key === 'fitted:' || view.key === 'fitted:terminal');
  const action = room ? 'Fit again' : row.action;
  return {
    heading: typeof view.label === 'string' ? view.label : '',
    why: typeof view.title === 'string' ? view.title : '',
    hint: grow ? GROW_HINT : room ? ROOM_HINT : row.hint ?? null,
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
    /** F11: whether start() would start a lease now (not started, and no 403 has ended the fit): the page measures the first frame of a lease before it starts. */
    get startable() { return !P.on && !P.dead; },
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
