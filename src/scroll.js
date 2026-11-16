// Scroll Claude's own full-screen view from the session window (nika 0.5, W3, threat T39). The request names a direction and a count
// (or an end), never a key: a fixed table below maps them to the only four keys this module ever sends, `PPage`, `NPage`, `C-Home`
// and `C-End` (spike S5: they scroll the view and leave the draft and the cursor alone). It sends them only under the pane lock, when
// no Stop/End interrupt runs, and when one fresh capture shows the alternate screen, no permission prompt and a plain input box
// whose draft is not a slash command. Everything else is a 409 and nothing is sent. Keep this file ASCII: write every symbol as an escape.
import { PANE_ID } from './ids.js';
import { promptFromRows, rowText } from './mode.js';
import { readDraft } from './session-control.js';

// The row check for Claude's scrolled-up pill lives in src/mode.js beside surveyShown (the capture parser needs it without this controller).
export { pillShown } from './mode.js';

/** Scroll requests per pane per second (a sliding window, like src/keys.js). */
export const SCROLL_RATE = 10;
/** Most pages one request may move (and so the most keys it sends in its one `keys.send` call). */
export const MAX_PAGES = 8;
const WINDOW_MS = 1000;
const SETTLE_MS = 30; // spike S5: a key shows in the next capture after about 15 ms (18 ms at most)

// The fixed table. Nothing else is ever handed to keys.send by this module.
const DIR_KEY = new Map([['up', 'PPage'], ['down', 'NPage']]);
const END_KEY = new Map([['top', 'C-Home'], ['bottom', 'C-End']]);

const BODY_MESSAGE = 'body must be { dir: up|down, pages: 1-8 } or { to: top|bottom }';
const MESSAGE = {
  'no-view': "Claude's full-screen view is off, so there is nothing to scroll.",
  'prompt-open': 'A permission prompt is open. Answer it first.',
  'screen-unclear': "Claude's input box is not on screen (a dialog, a menu or a survey may be open).",
  'menu-open': 'A slash command is being typed. Finish or clear it first.',
};
const conflict = (error) => ({ status: 409, body: { error } });
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** null when the body is exactly { dir: 'up'|'down', pages: integer 1..8 } or { to: 'top'|'bottom' }, else the 400 answer. */
export function checkScrollBody(body) {
  const names = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join() : '';
  const ok = (names === 'dir,pages' && DIR_KEY.has(body.dir) && Number.isInteger(body.pages) && body.pages >= 1 && body.pages <= MAX_PAGES)
    || (names === 'to' && END_KEY.has(body.to));
  return ok ? null : { status: 400, body: { error: 'invalid', message: BODY_MESSAGE } };
}

/** The keys for a valid body: up -> PPage x pages, down -> NPage x pages, top -> [C-Home], bottom -> [C-End]. Pure, fixed table; an invalid body gives []. */
export function scrollKeys(body) {
  if (checkScrollBody(body) !== null) return [];
  return body.to !== undefined ? [END_KEY.get(body.to)] : Array(body.pages).fill(DIR_KEY.get(body.dir));
}

// The first input-box row of an unreadable draft as Claude draws it: up to 2 spaces, the prompt glyph (U+276F), one space (Claude draws a
// no-break space, mapped to a space first), then the slash.
const SLASH_FIRST_ROW = /^ {0,2}\u276f \//;

/**
 * The screen checks of design W3 section 2.3 (7 to 10) on one capture `{ rows, cursor, cols, alt }`: null when keys may go, else the 409 code.
 * Claude binds PageUp/PageDown/End-like keys to move the highlight of its select lists, so no key goes while a prompt, a dialog, a survey,
 * a menu or an unknown footer is on screen (readDraft is the reading draft sync trusts: it is null for all of them).
 * Slash menu, fail closed (it is drawn above the box and leaves the footer readable): menu-open when (a) the draft state is text and its
 * text starts with `/`, or (b) the draft is unreadable and the first input-box row's text after the `\u276f` glyph and its space starts
 * with `/` (an unreadable draft has no text, so the row is read). It costs only a partly typed command.
 */
export function scrollGate(cap) {
  if (cap?.alt !== true) return 'no-view';
  if (promptFromRows(cap.rows) !== null) return 'prompt-open';
  const draft = readDraft(cap);
  if (draft === null) return 'screen-unclear';
  if (draft.state === 'text' && draft.text.startsWith('/')) return 'menu-open';
  if (draft.state === 'unreadable' && SLASH_FIRST_ROW.test(rowText(cap.rows[draft.box.top + 1]).replace(/\u00a0/g, ' '))) return 'menu-open';
  return null;
}

/**
 * mirror.capture(pane, undefined, { fresh }) -> { status, body: { rows, cursor, cols, alt, scrolled } }; keys.send(pane, { keys }) -> { status, body };
 * lock(pane, fn) is the session controller's per-pane lock (withPaneLock: waits for a running action, throws code EPANEBUSY after 5 s);
 * keyGap(pane) is true while a Stop or End interrupt runs or sent its Escape less than 40 ms ago (an Escape right before PPage reads as
 * Meta+key and the interrupt would be lost); now() -> ms and sleep(ms) are the clock and the pause.
 * scroll(pane, body) -> { status, body }; 200 body is { sent: <keys sent>, scrolled: <boolean after the keys, null when that capture failed> }.
 * Nothing of a request is logged.
 */
export function createScroll({ mirror, keys, lock, keyGap, now = Date.now, sleep = realSleep } = {}) {
  if (typeof mirror?.capture !== 'function') throw new TypeError('mirror.capture must be a function');
  if (typeof keys?.send !== 'function') throw new TypeError('keys.send must be a function');
  if (typeof lock !== 'function') throw new TypeError('lock must be a function (pane, fn) => Promise');
  // Without it a scroll could land right behind a Stop's Escape, so there is no default.
  if (typeof keyGap !== 'function') throw new TypeError('keyGap must be a function (pane) => boolean');
  const clock = typeof now === 'function' ? now : Date.now;
  const hits = new Map(); // pane -> timestamps of requests inside the window

  function allow(pane) {
    const t = clock();
    for (const [k, v] of hits) {
      const recent = v.filter((ts) => ts > t - WINDOW_MS);
      if (recent.length) hits.set(k, recent);
      else hits.delete(k);
    }
    const recent = hits.get(pane) ?? [];
    if (recent.length >= SCROLL_RATE) return false;
    recent.push(t);
    hits.set(pane, recent);
    return true;
  }

  /** Under the lock, with the keys already fixed: gap, one fresh capture, the screen gate, gap again, one keys.send, a short wait, one fresh capture. */
  async function run(pane, list) {
    if (keyGap(pane)) return conflict('busy-switching');
    const cap = await mirror.capture(pane, undefined, { fresh: true });
    if (cap.status !== 200) return { status: cap.status, body: cap.body };
    const code = scrollGate(cap.body);
    if (code !== null) return { status: 409, body: { error: code, message: MESSAGE[code] } };
    // Stop runs outside the lock and may have started during the capture: look once more, right before the keys (no await in between)
    if (keyGap(pane)) return conflict('busy-switching');
    const sent = await keys.send(pane, { keys: list });
    if (sent.status !== 200) return { status: sent.status, body: sent.body };
    let scrolled = null; // the keys are out whatever happens next, so a failed look afterwards is an unknown, not an error
    try {
      await sleep(SETTLE_MS);
      const after = await mirror.capture(pane, undefined, { fresh: true }); // also refreshes the 100 ms cache the page reads next
      if (after.status === 200) scrolled = after.body.scrolled === true;
    } catch {
      // scrolled stays null
    }
    return { status: 200, body: { sent: list.length, scrolled } };
  }

  return {
    async scroll(pane, body) {
      if (typeof pane !== 'string' || !PANE_ID.test(pane)) return { status: 400, body: { error: 'invalid', message: 'invalid pane id' } };
      const bad = checkScrollBody(body);
      if (bad !== null) return bad;
      const list = scrollKeys(body); // fixed here, before any await: a body changed later cannot change the keys
      if (!allow(pane)) return { status: 429, body: { error: 'busy', message: `at most ${SCROLL_RATE} scroll requests per second per pane` } };
      try {
        return await lock(pane, () => run(pane, list));
      } catch (err) {
        if (err?.code === 'EPANEBUSY') return conflict('busy-switching');
        throw err;
      }
    },
  };
}
