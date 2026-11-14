// Scrolling Claude's whole view, the page side (nika 0.5, design W3 sections 2.4, 6 and 8; the route: docs/contracts/api-app.md, POST
// /api/app/pane/:id/scroll). The wheel, the trackpad and PgUp/PgDn/Home/End in the mirror move Claude's own full-screen view in whole
// pages (about half a screen), after the mirror's own overflow has scrolled first. This file has no DOM and makes no request of its
// own: session.js hands createScrollPlanner a route, a clock and a handler, so Node tests every rule (test/scroll-ui.test.js). A server
// answer is data: refusalLine looks its words up in a fixed table, so no string of the server ever reaches the page.
// Keep this file ASCII: write every symbol as an escape.

export const GAP_MS = 100; // at least this long between two requests, so at most 10 a second (the route allows 10)
export const PAGE_MIN = 4; // rows of wheel travel per page, never fewer
export const NOTE_MS = 3000; // one refusal line per this long
export const MAX_PAGES = 8; // the route's most pages in one request

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// ---- input -> rows, native first -------------------------------------------------------------------------------------------

/**
 * Rows of travel in one wheel event (negative: up), or 0 for an event to ignore. deltaMode 0 is pixels (a row is `cellH` px, the fit
 * probe's height times the text scale), 1 is lines (rows already), 2 is pages (`viewRows` rows each). Not finite, or 0, gives 0.
 */
export function wheelRows(e, { cellH, viewRows } = {}) {
  const dy = e?.deltaY;
  if (!finite(dy) || dy === 0) return 0;
  const mode = e.deltaMode ?? 0;
  let rows = 0;
  if (mode === 0) rows = finite(cellH) && cellH > 0 ? dy / cellH : 0;
  else if (mode === 1) rows = dy;
  else if (mode === 2) rows = finite(viewRows) && viewRows > 0 ? dy * viewRows : 0;
  return finite(rows) ? rows : 0;
}

/**
 * Who scrolls first, the browser's nested-scroll rule: the mirror's own overflow (`.term`) while it has room in that direction, else
 * Claude. `dir` < 0 is up (and Home), > 0 is down (and End); top/height/client are scrollTop/scrollHeight/clientHeight. An edge within
 * half a pixel counts as reached. Anything that cannot be measured is `native`: the page then does nothing.
 */
export function routeFor({ dir, top, height, client } = {}) {
  if (![top, height, client].every(finite) || !(dir < 0 || dir > 0)) return 'native';
  if (dir < 0) return top > 0.5 ? 'native' : 'claude';
  return height - client - top > 0.5 ? 'native' : 'claude';
}

/** The transcript area of the last capture in rows: the top rule of Claude's input box (draft.box.top), else the capture's row count, else 0. */
export function viewRowsOf(body, draft) {
  const top = draft?.box?.top;
  if (Number.isInteger(top) && top >= 0) return top;
  const n = body?.rows?.length;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Rows of wheel travel for one page: half the transcript area, at least PAGE_MIN (spike S5: a page is 15, 16, 16 rows of a 33-row area). */
export const pageRowsOf = (body, draft) => Math.max(PAGE_MIN, Math.floor(viewRowsOf(body, draft) / 2));

// ---- the gate, a twin of src/scroll.js scrollGate on what the last capture carried ------------------------------------------

const rowText = (row) => (Array.isArray(row) ? row.map((sp) => (typeof sp?.t === 'string' ? sp.t : '')).join('') : '');
// The first input-box row of an unreadable draft: up to 2 spaces, the prompt glyph, its space (no-break spaces read as spaces), then a slash.
const SLASH_FIRST_ROW = /^ {0,2}\u276f \//;

/**
 * Why no request should go for the last capture `body` (the capture body, with `alt`, `prompt`, `rows`) and its cleaned `draft`
 * (draft-sync.js cleanDraft, null when the screen has no plain input box), else null. The same order and codes as the server, which
 * decides for real: alternate screen off -> no-view; a permission prompt -> prompt-open; no plain box -> screen-unclear; a draft that
 * starts with `/` (text, or an unreadable one whose first box row does) -> menu-open (the slash menu leaves the footer readable).
 */
export function scrollGate(body, draft) {
  if (body?.alt !== true) return 'no-view';
  if (body.prompt) return 'prompt-open';
  if (!draft || typeof draft !== 'object') return 'screen-unclear';
  if (draft.state === 'text' && typeof draft.text === 'string' && draft.text.startsWith('/')) return 'menu-open';
  if (draft.state === 'unreadable' && Number.isInteger(draft.box?.top) && SLASH_FIRST_ROW.test(rowText(body.rows?.[draft.box.top + 1]).replace(/\u00a0/g, ' '))) return 'menu-open';
  return null;
}

// ---- the lines -------------------------------------------------------------------------------------------------------------

// Fixed copy chosen by status and code (design 6.4); the server's own text is never shown.
const LINE = {
  'prompt-open': "A prompt is open, so nika doesn't send scroll keys. Answer it first, or scroll in the terminal.",
  'screen-unclear': "A dialog or menu is open in Claude, so nika doesn't send scroll keys. Close it first, or scroll in the terminal.",
  'menu-open': "Claude's / menu may be open, so nika doesn't send scroll keys. Finish or clear the command first.",
  'no-view': "Claude isn't in its full-screen view here, so there is nothing for nika to scroll. The transcript shows the whole conversation.",
  'busy-switching': 'Another action is running on this session. Scroll again in a moment.',
};
const NO_ANSWER = 'nika did not answer.';
const OTHER = "nika couldn't scroll Claude's view.";

/**
 * The line to show for a refusal `{ status, code }` (the route's answer, or the page's own gate as `{ status: 409, code }`), or null for
 * none: 429 (the next request goes after the window), 404 and 403 (the gone-pane overlay and the lost-connection overlay speak). Status 0
 * is a lost request.
 */
export function refusalLine({ status, code } = {}) {
  if (status === 429 || status === 404 || status === 403) return null;
  if (status === 0) return NO_ANSWER;
  if (status === 409 && typeof code === 'string' && Object.hasOwn(LINE, code)) return LINE[code];
  return OTHER;
}

// ---- the note and Jump to live ---------------------------------------------------------------------------------------------

/**
 * What the corner of the mirror shows for nika's own Paused (`frozen`: the mirror's overflow is scrolled up) and Claude's scrolled-up
 * view (`scrolled`): { jump, note }. Jump to live shows while either holds. The note is { kind, icon, text } (icon: a symbol of
 * session.html's sprite), or null; Claude's view being scrolled says more than Paused, so it wins. Each state has its own colour
 * (session.css, data-k), icon and words, never colour alone.
 */
export function noteView({ frozen, scrolled } = {}) {
  if (scrolled === true) return { jump: true, note: { kind: 'scrolled', icon: 'up', text: "Scrolled up in Claude's view" } };
  if (frozen === true) return { jump: true, note: { kind: 'paused', icon: 'pause', text: 'Paused while you scroll' } };
  return { jump: false, note: null };
}

/** The polite announcement for a change of `scrolled`. */
export const scrolledSay = (on) => (on ? "Scrolled up in Claude's view. Jump to live returns to the bottom." : 'Back at the live bottom.');

// ---- the requests ----------------------------------------------------------------------------------------------------------

/**
 * The page's scroll requests. `io.send(body)` -> Promise<{ status, body }> (the route), `io.after(fn, ms)` / `io.cancel(timer)`,
 * `io.now()` -> ms, `io.done(r)` (told every answer, after the planner has dealt with it).
 * - wheel(rows, pageRows): rows of travel (negative: up). A change of direction drops the rest (the leftover travel and the queued
 *   pages); then the travel adds up, and a page is queued each time it reaches half a page (round to nearest: the first page goes at
 *   half a page, on average one page per `pageRows`), the rest stays as leftover.
 * - page(dir): one page, 'up' or 'down'; a change of direction replaces the queue.
 * - jump(to): 'top' or 'bottom'; drops the queue and the leftover and goes before any page.
 * - The queue never holds more than MAX_PAGES (the excess is dropped and the leftover with it): never a backlog.
 * - One request in flight, at least GAP_MS after the last was sent, one body per request: a jump, or the queued pages as one
 *   { dir, pages }.
 * - Any answer but 200 drops the queue, the leftover and the jump (never keys behind a refusal); 403 stops the planner for good.
 * - close() (the pane is gone, the page leaves) drops everything, cancels the timer and ignores an answer still on its way; nothing
 *   more is sent until the next wheel, page or jump, and that waits until the request still on its way has settled (never two at once).
 */
export function createScrollPlanner(io) {
  const P = { gen: 0, dead: false, acc: 0, dir: null, q: null, jump: null, busy: false, last: null, timer: null };

  const unwait = () => {
    if (P.timer !== null) io.cancel(P.timer);
    P.timer = null;
  };
  const drop = () => {
    P.acc = 0;
    P.dir = null;
    P.q = null;
    P.jump = null;
    unwait();
  };

  function pump() {
    if (P.dead || P.busy || P.timer !== null) return;
    const body = P.jump !== null ? { to: P.jump } : P.q !== null ? { dir: P.q.dir, pages: P.q.n } : null;
    if (body === null) return;
    const wait = P.last === null ? 0 : GAP_MS - (io.now() - P.last);
    if (wait > 0) {
      P.timer = io.after(() => { P.timer = null; pump(); }, wait);
      return;
    }
    if (P.jump !== null) P.jump = null;
    else P.q = null;
    P.busy = true;
    P.last = io.now();
    const gen = P.gen;
    // the executor runs at once, so the request still goes out synchronously; a send that throws is a lost request, not a stuck busy
    new Promise((resolve) => { resolve(io.send(body)); }).then((r) => settle(gen, r), () => settle(gen, null));
  }

  function settle(gen, r) {
    P.busy = false;
    if (gen !== P.gen) { // closed meanwhile: its answer is dropped, and what was asked since goes now
      pump();
      return;
    }
    const answer = r && typeof r === 'object' ? r : { status: 0, body: null };
    if (answer.status === 403) P.dead = true;
    if (answer.status !== 200) drop();
    io.done(answer);
    if (gen === P.gen) pump();
  }

  function push(dir, n) {
    const same = P.q !== null && P.q.dir === dir;
    const total = (same ? P.q.n : 0) + n;
    if (total > MAX_PAGES) P.acc = 0;
    P.q = { dir, n: Math.min(MAX_PAGES, total) };
    pump();
  }

  return {
    wheel(rows, pageRows) {
      if (P.dead || !finite(rows) || rows === 0 || !finite(pageRows) || pageRows < 1) return;
      const dir = rows < 0 ? 'up' : 'down';
      const sign = rows < 0 ? -1 : 1;
      if (P.dir !== dir) { // a change of direction drops the rest
        P.acc = 0;
        if (P.q !== null && P.q.dir !== dir) P.q = null;
      }
      P.dir = dir;
      P.acc += rows;
      const n = Math.floor((P.acc * sign + pageRows / 2) / pageRows); // the travel along this direction; a page sent at half a page leaves the travel half a page short
      if (n < 1) return;
      P.acc -= sign * n * pageRows;
      push(dir, n);
    },
    page(dir) {
      if (P.dead || (dir !== 'up' && dir !== 'down')) return;
      P.acc = 0;
      P.dir = dir;
      if (P.q !== null && P.q.dir !== dir) P.q = null;
      push(dir, 1);
    },
    jump(to) {
      if (P.dead || (to !== 'top' && to !== 'bottom')) return;
      P.acc = 0;
      P.dir = null;
      P.q = null;
      P.jump = to;
      pump();
    },
    close() {
      P.gen += 1; // busy stays up until the request on its way settles, so a new request never overlaps it
      drop();
    },
  };
}
