// The glide of the mirror after a scroll request (nika 0.5, design F17). Pure: session.js hands it the frames; Node tests every rule
// (test/glide.test.js). Row texts are data: they are compared, never shown. Keep this file ASCII: write every symbol as an escape.
import { rowText, viewRowsOf } from './scroll.js';

export const GLIDE_MS = 150; // the slide; session.css nika-glide must say the same
export const GLIDE_ARM_MS = 700; // a scroll request's frame must come this soon after the send (or the 200 answer)
export const GLIDE_MIN_ROWS = 3; // unique rows that must agree on the shift
export const GLIDE_SHARE = 0.8; // share of all votes the shift must have

const clean = (t) => t.replace(/\u00a0/g, ' ').trimEnd();

/** A frame for the matcher: the conversation rows (above Claude's input box) as texts, with the pane size and whether Claude's view is at its bottom (the capture's `scrolled` is false). */
export function frameOf(body, draft) {
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const end = Math.min(rows.length, viewRowsOf(body, draft));
  return { texts: rows.slice(0, end).map((r) => clean(rowText(r))), end, cols: body?.cols, rows: rows.length, bottom: body?.scrolled === false };
}

/** text -> index for the texts that occur exactly once and are not blank (-1: it occurs more than once). */
function uniques(texts) {
  const seen = new Map();
  texts.forEach((t, i) => {
    if (t !== '') seen.set(t, seen.has(t) ? -1 : i);
  });
  return seen;
}

/** The shift between two frames: { k, votes, total, tie } or null when the frames differ in size. k > 0: the content moved down. */
export function findShift(before, after) {
  if (!before || !after || before.cols !== after.cols || before.rows !== after.rows) return null;
  const a = uniques(before.texts);
  const b = uniques(after.texts);
  const count = new Map();
  let total = 0;
  for (const [t, i] of a) {
    const j = b.get(t);
    if (i < 0 || j === undefined || j < 0) continue;
    count.set(j - i, (count.get(j - i) ?? 0) + 1);
    total += 1;
  }
  let k = 0;
  let votes = 0;
  let second = 0;
  for (const [s, n] of count) {
    if (n > votes) {
      second = votes;
      votes = n;
      k = s;
    } else if (n > second) second = n;
  }
  return { k, votes, total, tie: votes > 0 && votes === second };
}

/**
 * The matcher's arm. arm(req, ctx) after a scroll request is sent: req is the route body ({ dir, pages } or { to }), ctx { scrolled, before }
 * (Claude's view was scrolled up; the frame drawn now). extend() on the route's 200. offer(after) for every drawn capture:
 *   null                    not armed, or the window is over (it disarms)
 *   { act: 'rebase' }       nothing moved our way: the base frame is now `after`, still armed
 *   { act: 'glide', k, end } the shift to slide (consumes one request: the arm ends with the last one; a request merged into the arm
 *                           while its frame was still to come keeps it, rebased on this frame and renewed, for the next frame)
 * disarm(): keys, submit, any other write to the pane, a resize, gone. drop(): the request was refused or lost, so no frame of it will come: it
 * gives up one waiting request, or the arm when none waits. armed(): true while the window is open. A down arm ends on a frame that shows
 * Claude's view at its bottom: from there only output or a submit moves the content up, never a scroll. `now()` is the clock.
 */
export function createGlideArm({ now }) {
  let A = null; // { sign, far, before, until, pending }; pending: requests merged into this arm whose frame has not glided yet
  const live = () => A !== null && now() <= A.until;
  /** A glide has used up one request. With merged requests still waiting the arm stays, rebased on this frame and renewed (a flick: each page glides); else it ends. */
  const glided = (after, g) => {
    if (A.pending > 0) {
      A.pending -= 1;
      A.before = after;
      A.until = now() + GLIDE_ARM_MS;
    } else A = null;
    return g;
  };
  /** What a drawn capture means for the arm (see the header). */
  const decide = (after) => {
    if (!live()) {
      A = null;
      return null;
    }
    const s = findShift(A.before, after);
    if (s === null) { // another size: never a glide (D5)
      A = null;
      return null;
    }
    const ours = Math.sign(s.k) === A.sign;
    if (ours && !s.tie && s.votes >= GLIDE_MIN_ROWS && s.votes >= GLIDE_SHARE * s.total) {
      return glided(after, { act: 'glide', k: s.k, end: after.end });
    }
    if (A.far && s.votes < GLIDE_MIN_ROWS && after.end > 0 && after.texts.join('\n') !== A.before.texts.join('\n')) {
      const k = A.sign * Math.ceil(after.end / 2); // no shared rows: a half-region slide in the request's direction (D6)
      return glided(after, { act: 'glide', k, end: after.end });
    }
    A.before = after; // k = 0, the wrong sign, or mixed: rebase, stay armed (D4)
    return { act: 'rebase' };
  };
  return {
    arm(req, { scrolled, before } = {}) {
      const to = req?.to;
      const dir = req?.dir;
      const sign = to === 'top' || dir === 'up' ? 1 : to === 'bottom' || dir === 'down' ? -1 : 0;
      if (sign === 0 || !before) return false;
      if (sign < 0 && scrolled !== true) { // at the bottom NPage and C-End move nothing (D3)
        if (A !== null && A.sign !== sign) A = null; // an up arm is over; a live down arm is not: its frame, the real scroll, is still to come
        return false;
      }
      const far = to !== undefined || (Number.isInteger(req.pages) && req.pages >= 2);
      if (live() && A.sign === sign) { // keeps the older base: the shifts add up
        A.far = A.far || far;
        A.pending += 1;
        A.until = now() + GLIDE_ARM_MS;
        return true;
      }
      A = { sign, far, before, until: now() + GLIDE_ARM_MS, pending: 0 };
      return true;
    },
    extend() {
      if (live()) A.until = now() + GLIDE_ARM_MS;
    },
    disarm() {
      A = null;
    },
    /** A scroll request was refused or lost: nothing it was armed for will come. Gives up one merged request (an earlier one still glides), else ends the arm. */
    drop() {
      if (A !== null && A.pending > 0) A.pending -= 1;
      else A = null;
    },
    /** True while a request is armed and its window is open: session.js builds a frame for offer() only then (design F17 section 7: a check per capture otherwise). */
    armed() {
      return live();
    },
    offer(after) {
      const r = decide(after);
      if (A !== null && A.sign < 0 && after.bottom === true) A = null; // Claude's view is at its bottom: a down request can move nothing now (this frame still glided)
      return r;
    },
  };
}

const PANE_ROUTE = /^\/api\/app\/pane\/[^/?#]+(?:\/([^/?#]*))?/;
const KEEPS_ARM = new Set(['scroll', 'capture', 'fit']); // the scroll itself, the capture poll and the fit heartbeat

/**
 * Does this request to the app tier end a pending glide? Every write to a pane does (a key, a submit, a command, a dialog or survey answer, Stop,
 * a mode switch, a draft, an attachment, a route added later), because it may type into Claude or redraw its screen and the next frame is then
 * not the scroll's: only the three routes above are left out. Reads (GET, HEAD) and anything that is not a pane route never do. design F17 section 0.3.
 */
export function paneWriteDisarms(path, method) {
  if (typeof path !== 'string') return false;
  const m = PANE_ROUTE.exec(path);
  if (m === null) return false;
  const verb = typeof method === 'string' ? method.toUpperCase() : 'GET';
  if (verb === 'GET' || verb === 'HEAD') return false;
  return !KEEPS_ARM.has(m[1] ?? '');
}

/** Where the slide starts, in px: the rows' running offset `current` minus k rows, clamped to one region. 0 for anything not finite. */
export function glideFrom({ k, rowPx, current = 0, maxPx }) {
  const v = current - k * rowPx;
  if (![v, maxPx].every(Number.isFinite) || maxPx <= 0) return 0;
  return Math.max(-maxPx, Math.min(maxPx, v));
}

/** The y offset in px of a computed transform: 'none' -> 0, matrix(a,b,c,d,tx,ty) -> ty, matrix3d(...) -> its 14th value; anything else 0. */
export function matrixY(t) {
  const m = /^matrix(3d)?\(([^)]*)\)$/.exec(typeof t === 'string' ? t.trim() : '');
  if (!m) return 0;
  const v = m[2].split(',').map(Number);
  const y = m[1] ? v[13] : v[5];
  return Number.isFinite(y) ? y : 0;
}
