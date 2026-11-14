// The attachment send (0.5, W2, design-W2 section 5; rules constraints 5, 9, 10, 12; threat T38): puts the stored files of a message
// into Claude's input box and presses Enter. It pastes only the absolute path of a file nika stored itself (one bracketed paste per
// file, after the text the page synced), reads the box back after every paste, and presses Enter once, last, after a fresh check.
// Every step fails closed: whatever the screen or the registry shows that is not exactly what the step needs, nothing more is sent
// and the answer is a 409 that says how many pastes already went out. It never types literal text, Escape, C-u, BSpace, Tab, BTab,
// a digit or an arrow, never clears a box it pasted into, and never logs a path, an id, a name or a draft. Keep this file ASCII.
import { ID, PATH_OK, PER_MESSAGE } from './attachments.js';
import { boxSquash } from './draft.js';
import { editMode } from './session-control.js';
import { modeFromRows, promptFromRows, rowText } from './mode.js';

const LOCK_BUSY = 'EPANEBUSY';
const POLL_MS = 150; // between the captures that wait for a paste to show
const IMAGE_WAIT = 10; // 1.5 s: the path is replaced by `[Image #N]` at once (S4); a large PNG needs a read
const TEXT_WAIT = 4; // 0.6 s: a path that stays text
const SIG = /^[0-9a-f]{16}$/;
const IMAGES = new Set(['png', 'jpeg', 'gif', 'webp']);
const PLACEHOLDER = /^\[Image#\d+\]$/; // what a squashed image placeholder reads as (any N)
const squash = (s) => s.replace(/\s+/g, '');
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A node error code only, never the error object: its message could carry a path. */
export const errorCode = (err) => (/^[A-Z0-9_]{1,20}$/.test(err?.code) ? err.code : 'ERR');
export const logCode = (err) => process.stderr.write(`nika: attachments: ${errorCode(err)}\n`);

/** The body of the route, exactly `{ ids, base }`: 1 to 6 unique attachment ids and the 16 hex `sig` the page last synced on. null = fine, else the 400. */
export function checkAttachBody(body) {
  const names = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const ok = names.length === 2 && Object.hasOwn(body, 'ids') && Object.hasOwn(body, 'base')
    && Array.isArray(body.ids) && body.ids.length >= 1 && body.ids.length <= PER_MESSAGE
    && body.ids.every((id) => typeof id === 'string' && ID.test(id)) && new Set(body.ids).size === body.ids.length
    && typeof body.base === 'string' && SIG.test(body.base);
  return ok ? null : { status: 400, body: { error: 'invalid', message: `body must be { ids: 1 to ${PER_MESSAGE} different attachment ids, base: 16 lowercase hex characters }` } };
}

/**
 * The box of a capture with its squash: the reading of readDraft (src/session-control.js: a cursor with integer x and y is needed, the
 * mode line is read with plain spaces so a no-break space inside `-- INSERT --` does not hide the mode) plus boxSquash (src/draft.js).
 * { draft, squash } or null.
 */
function readSeen(seen) {
  if (!Number.isInteger(seen?.cursor?.x) || !Number.isInteger(seen?.cursor?.y)) return null;
  const rows = Array.isArray(seen.rows) ? seen.rows : [];
  const last = rows.findLastIndex((row) => rowText(row).trim() !== '');
  const spaced = (row) => (Array.isArray(row) ? row.map((sp) => (typeof sp?.t === 'string' ? { ...sp, t: sp.t.replace(/\xa0/g, ' ') } : sp)) : row);
  return boxSquash(last < 0 ? rows : rows.map((row, i) => (i === last ? spaced(row) : row)), seen.cursor, seen.cols);
}

/**
 * mirror.capture(pane, undefined, { fresh }) and keys.send(pane, { paste?, keys? }) as in src/mirror.js and src/keys.js; store = the
 * attachment store (src/attachments.js: lookup, markSent); lock(pane, fn) = the controller's per-pane lock (it rejects with an Error whose
 * code is EPANEBUSY after 5 s); keyGap(pane) = true while a Stop or End interrupt runs or its Escape went out < 40 ms ago;
 * stateOf(pane, { fresh: true }) = the registry state; vimOf / plainOf(pane) = what nika remembers of the pane's edit mode.
 * send(pane, { ids, base }) -> { status, body }: 200 { sent, images }; else { error, pasted, ... } with `pasted` = the paste requests that
 * went out before it stopped, and `draft` where the box was readable. A body never carries a path.
 */
export function createAttachSend({ mirror, keys, store, lock, keyGap, stateOf, vimOf, plainOf = () => false, sleep = realSleep, log = logCode }) {
  async function attach(pane, { ids, base }, count) {
    const refuse = (error, extra = {}) => ({ status: 409, body: { error, pasted: count.pasted, ...extra } });
    const passed = (res) => ({ status: res.status, body: { ...res.body, pasted: count.pasted } }); // a capture's or a key send's own answer
    const look = async () => {
      const cap = await mirror.capture(pane, undefined, { fresh: true });
      return cap.status === 200 ? { rows: cap.body.rows, cursor: cap.body.cursor, cols: cap.body.cols } : { res: passed(cap) };
    };
    const state = async () => {
      try {
        return await stateOf(pane, { fresh: true });
      } catch {
        return null; // a failed registry read is never idle
      }
    };
    const view = async (box, rows) => ({ ...box.draft, edit: editMode(rows, (await vimOf(pane)) === true, (await plainOf(pane)) === true) });
    // The one place a key leaves: never while a Stop or End interrupt runs or within 40 ms of its Escape (N-2).
    const press = async (body) => {
      if (keyGap(pane)) return refuse('not-idle');
      const sent = await keys.send(pane, body);
      return sent.status === 200 ? null : passed(sent);
    };

    // 1. every file is still the one nika stored for this pane (the content is never read back)
    const records = [];
    for (const id of ids) {
      const r = await store.lookup(pane, id);
      if (!r) return refuse('attachment-gone', { id });
      if (!PATH_OK.test(r.path) || (!IMAGES.has(r.type) && r.type !== 'pdf' && r.type !== 'text')) return refuse('path-unusable', { id }); // a store bug must not reach tmux
      records.push(r);
    }
    // 2. nothing runs: no Stop/End interrupt and the registry says idle right now
    if (keyGap(pane) || (await state()) !== 'idle') return refuse('not-idle');
    // 3. one fresh capture with no permission prompt (T51: a paste never lands in a prompt)
    let seen = await look();
    if (seen.res) return seen.res;
    if (promptFromRows(seen.rows) !== null) return refuse('not-idle');
    // 4.-9. the box is plain, readable, ours to paste into, and the page synced on exactly this
    const box = readSeen(seen);
    if (box === null) return refuse(modeFromRows(seen.rows) === 'unknown' ? 'mode-unknown' : 'input-unreadable');
    const { draft } = box;
    const withDraft = async (error, extra) => refuse(error, { ...extra, draft: await view(box, seen.rows) });
    if (draft.state === 'unreadable') return withDraft('draft-unreadable', { reason: draft.reason });
    if (draft.mode === 'bash') return withDraft('shell-mode');
    if (draft.sig !== base) return withDraft('draft-changed');
    if (draft.state === 'text' && !draft.cursorAtEnd) return withDraft('cursor-not-at-end'); // vim NORMAL sits one left; a mid-text cursor would split the text
    if (draft.state === 'empty' && editMode(seen.rows, (await vimOf(pane)) === true, (await plainOf(pane)) === true) === 'normal') return withDraft('vim-normal');

    // 10.-12. one paste per file, each after a fresh look and read back before the next
    let expect = box.squash; // what the box must read now (squashed); grows by each piece
    for (let k = 0; k < records.length; k += 1) {
      const r = records[k];
      const image = IMAGES.has(r.type);
      if (k > 0) {
        seen = await look();
        if (seen.res) return seen.res;
      }
      const before = promptFromRows(seen.rows) === null ? readSeen(seen) : null;
      if (before === null || before.squash !== expect) return refuse('screen-changed'); // a prompt, a menu, a search, or the user typed
      const sent = await press({ paste: image || expect === '' ? r.path : ` ${r.path}` });
      if (sent) return sent;
      count.pasted += 1;
      const piece = (s) => (image ? s.startsWith(expect) && PLACEHOLDER.test(s.slice(expect.length)) : s === expect + squash(r.path));
      let last = null;
      let taken = false;
      for (let i = 0; i < (image ? IMAGE_WAIT : TEXT_WAIT) && !taken; i += 1) {
        await sleep(POLL_MS);
        const now = await look();
        if (now.res) return now.res;
        if (promptFromRows(now.rows) !== null) return refuse('screen-changed');
        last = readSeen(now);
        if (last !== null && piece(last.squash)) {
          expect = last.squash;
          taken = true;
        }
      }
      if (!taken) {
        const rest = last?.squash.startsWith(expect) ? last.squash.slice(expect.length) : null;
        return rest === '' || rest === squash(r.path) ? refuse('not-taken', { id: r.id }) : refuse('screen-changed'); // the path still shows as text, or the screen is something else
      }
    }

    // 13. right before Enter: still idle, a fresh capture reads exactly what was built
    if (keyGap(pane) || (await state()) !== 'idle') return refuse('not-idle');
    const final = await look();
    if (final.res) return final.res;
    const closing = promptFromRows(final.rows) === null ? readSeen(final) : null;
    if (closing === null || closing.squash !== expect) return refuse('screen-changed');
    // 14. the one Enter
    const enter = await press({ keys: ['Enter'] });
    if (enter) return enter;
    store.markSent(ids);
    return { status: 200, body: { sent: records.length, images: records.filter((r) => IMAGES.has(r.type)).length } };
  }

  return {
    async send(pane, body) {
      const bad = checkAttachBody(body);
      if (bad) return bad;
      const count = { pasted: 0 };
      try {
        return await lock(pane, () => attach(pane, body, count));
      } catch (err) {
        if (err?.code === LOCK_BUSY) return { status: 409, body: { error: 'busy-switching', pasted: 0 } };
        log(err); // the code only: an error object could carry a path
        return { status: 500, body: { error: 'internal', message: 'internal error', pasted: count.pasted } };
      }
    },
  };
}
