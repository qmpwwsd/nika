// Draft sync, the page side (nika 0.5, design W5/W6; the route: docs/contracts/api-app.md, PUT /api/app/pane/:id/draft).
// The session window's message box and Claude's input box mirror each other: a changed screen is pulled into the box after
// 1.5 s of local quiet, a local edit is pushed 250 ms after the last keystroke. This file has no DOM and makes no request of
// its own: session.js hands createDraftSync a box, a PUT function, a clock and a note sink, so Node tests every rule
// (test/draft-sync.test.js). The capture's `draft` and every route answer are data: cleanDraft re-checks the shape, and no
// word of the server ever reaches the page (the notes and problem lines below are fixed copy).
// Keep this file ASCII: write every symbol as an escape.
import { cellWidth } from './mirror-render.js';

export const QUIET_MS = 1500; // local quiet before the terminal's text is pulled into the box
export const PUSH_MS = 250; // after the last local edit, the box is pushed
const TEXT_MAX = 4096; // a draft the capture can carry is far smaller; anything bigger is not ours
const SIG = /^[0-9a-f]{16}$/;
const STATES = new Set(['empty', 'text', 'unreadable']);
const MODES = new Set(['prompt', 'bash']);
const REASON_TEXT = {
  pasted: "a pasted block nika can't read back",
  tall: 'a draft longer than 14 rows',
  trailing: 'text that ends in spaces',
  history: 'a prompt-history entry',
  layout: "something nika doesn't recognise",
};
const reasonText = (reason) => REASON_TEXT[Object.hasOwn(REASON_TEXT, reason) ? reason : 'layout'];

// ---- twins of src/draft.js (browser code cannot import src/; test/draft-sync.test.js asserts they answer alike) -----------

/** The form two drafts are compared in: a tab is 4 spaces, a no-break space is a space, trailing spaces of every line go. */
export function normDraft(text) {
  return typeof text === 'string' ? text.replace(/\t/g, '    ').replace(/\u00a0/g, ' ').replace(/ +$/gm, '') : '';
}

export const sameDraft = (a, b) => typeof a === 'string' && typeof b === 'string' && normDraft(a) === normDraft(b);

const width = (s) => { let n = 0; for (const ch of s) n += cellWidth(ch.codePointAt(0)); return n; };

/** At most 1024 characters, 12 newlines and 13 estimated rows (a 14-row box may be a window, so it is unreadable). */
export function inEnvelope(text, cols) {
  if (typeof text !== 'string' || !Number.isInteger(cols) || cols <= 4) return { ok: false, reason: 'invalid' };
  if (text.length > 1024) return { ok: false, reason: 'chars' };
  const lines = text.split('\n');
  if (lines.length - 1 > 12) return { ok: false, reason: 'newlines' };
  const rows = lines.reduce((n, line) => n + Math.max(1, Math.ceil(width(line.replace(/\t/g, '    ')) / (cols - 4))), 0);
  return rows > 13 ? { ok: false, reason: 'rows' } : { ok: true };
}

const BAD_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
/** The route's rule for the text it takes: the envelope and no control character but newline and tab. */
export const fits = (text, cols) => typeof text === 'string' && !BAD_CONTROL.test(text) && inEnvelope(text, cols).ok;

// ---- one canonical form: Shell mode is Claude's "!" mode ----------------------------------------------------------------

/** The box as Claude's input would show it: Shell on is a leading "!". */
export const canon = (value, shell) => (shell ? '!' : '') + value;
/** Claude's draft in the same form: a bash box is a leading "!" too. */
export const screenCanon = (draft) => (draft.mode === 'bash' ? '!' : '') + draft.text;
/** Spaces at the very end stay out of Claude's box: a trailing space there makes the box unreadable (the cursor sits past the text). */
const pushText = (text) => text.replace(/[ \t\u00a0]+$/, '');

// ---- the capture's draft ------------------------------------------------------------------------------------------------

/** The capture's `draft` as the page may use it, or null (older server, malformed: no cut, no sync). Copies the fields; nothing else is kept. */
export function cleanDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { state, mode, text, sig, reason, box, cursorAtEnd, suggestion } = raw;
  if (!STATES.has(state) || !MODES.has(mode) || typeof text !== 'string' || text.length > TEXT_MAX) return null;
  if (!box || !Number.isInteger(box.top) || !Number.isInteger(box.bottom) || box.top < 0 || box.bottom <= box.top) return null;
  const at = { top: box.top, bottom: box.bottom };
  if (state === 'unreadable') {
    return { state, mode, text: '', sig: null, reason: Object.hasOwn(REASON_TEXT, reason) ? reason : 'layout', box: at, cursorAtEnd: false, suggestion: null };
  }
  if (typeof sig !== 'string' || !SIG.test(sig)) return null;
  return {
    state, mode, text, sig, box: at, cursorAtEnd: cursorAtEnd === true,
    suggestion: typeof suggestion === 'string' && suggestion.length <= 200 ? suggestion : null,
  };
}

/** The first mirror row to cut (the box's top rule), or null: only a readable draft with Type into pane off hides Claude's input box. */
export function cutAt(draft, passOn) {
  if (passOn === true || !draft || (draft.state !== 'empty' && draft.state !== 'text')) return null;
  const top = draft.box?.top;
  return Number.isInteger(top) && top >= 0 ? top : null;
}

/** Where the caret goes after a pull: text that only grew keeps a caret inside the old text where it was and follows an end caret; anything else, the end. */
export function caretAfter(before, after, caret) {
  const inside = Number.isInteger(caret) && caret >= 0 && caret < before.length;
  return after.startsWith(before) && inside ? caret : after.length;
}

// ---- the note under the box (colour + icon + word per state) -------------------------------------------------------------

/** { kind, icon, label, text } for the one note, or null. kind: paused (the screen's draft cannot be read), long (outside the envelope), wait (a replace is refused while Claude works). */
export function noteView(note) {
  if (!note) return null;
  if (note.kind === 'paused') {
    return { kind: 'paused', icon: 'pause', label: 'Sync paused:', text: `Claude's input holds ${reasonText(note.reason)}. Edit or clear it in the terminal.` };
  }
  if (note.kind === 'long') return { kind: 'long', icon: 'info', label: 'Not mirrored:', text: 'Long text goes to Claude when you send it.' };
  if (note.kind === 'wait') return { kind: 'wait', icon: 'clock', label: 'Waiting for Claude:', text: "Claude is working. Your text goes into its input when it waits." };
  return null;
}

// ---- Send (design 4) ---------------------------------------------------------------------------------------------------------

const ENTER = [{ keys: ['Enter'] }];
const LONG_REFUSAL = "Claude's input already holds text; it would be sent together with yours. Clear it in the terminal or shorten your message.";
const pausedLine = (reason) => `Claude's input holds ${reasonText(reason)}. Send or clear it in the terminal.`;

/**
 * What Send does with the box and the screen. `screen` is cleanDraft's answer for the last capture (null: no readable box). Returns
 *   { act: 'enter', payloads, summary }   Enter alone (the screen already equals the box, or the box is empty)
 *   { act: 'push', text, payloads, summary }   copy the box into Claude's input first, then Enter
 *   { act: 'legacy' }   today's paste / Shell path (no readable box, or a long text onto an empty prompt)
 *   { act: 'refuse', message }
 * The sendGate (a permission prompt) runs before this.
 */
export function draftSendPlan({ value, shell = false, screen = null, cols = 0 } = {}) {
  const v = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (v.trim() === '') return shell ? { act: 'legacy' } : { act: 'enter', ok: true, payloads: ENTER, summary: 'Enter' };
  if (!screen) return { act: 'legacy' };
  if (screen.state === 'unreadable') return { act: 'refuse', message: pausedLine(screen.reason) };
  const want = canon(v, shell);
  if (sameDraft(screenCanon(screen).replace(/\n+$/, ''), want)) return { act: 'enter', ok: true, payloads: ENTER, summary: 'Enter' };
  const text = pushText(want);
  if (fits(text, cols)) {
    const n = text.length - (shell ? 1 : 0);
    return { act: 'push', ok: true, text, payloads: ENTER, summary: shell ? `a shell command (${n} characters) + Enter` : `${n} characters + Enter` };
  }
  if (screen.state === 'empty' && screen.mode === 'prompt') return { act: 'legacy' };
  return { act: 'refuse', message: LONG_REFUSAL };
}

/** The line for a Send whose push did not land. Fixed copy: only the status and the server's `error` code pick it. */
function sendMessage({ status, code, reason }) {
  if (status === 409) {
    if (code === 'draft-changed' || code === 'screen-changed' || code === 'draft-mismatch') {
      return "Claude's input changed while nika was copying your text. nika shows what it holds now. Nothing was sent.";
    }
    if (code === 'draft-unreadable') return pausedLine(reason);
    if (code === 'not-idle') return "Claude is busy or a prompt is open, so nika can't change its input now. Nothing was sent. Your text is kept.";
    if (code === 'input-unreadable' || code === 'mode-unknown') {
      return "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.";
    }
    if (code === 'busy-switching') return 'Another action is running on this session. Try again in a moment. Your text is kept.';
  }
  if (status === 400) return "This text can't be copied into Claude's input as it is. Your text is kept.";
  if (status === 404) return 'The session is gone.';
  if (status === 429) return 'Too many keys at once; try again. Your text is kept.';
  if (status === 0) return 'nika did not answer. Your text is kept.';
  return "nika couldn't copy your text into Claude's input. Your text is kept.";
}

// ---- the controller ------------------------------------------------------------------------------------------------------------

const ADOPT = new Set(['draft-changed', 'screen-changed', 'draft-mismatch']); // 409s whose body carries the screen's draft: the terminal wins
const unreadableDraft = (reason, like) => ({
  state: 'unreadable', mode: like?.mode ?? 'prompt', text: '', sig: null, reason: Object.hasOwn(REASON_TEXT, reason) ? reason : 'layout',
  box: like?.box ?? { top: 0, bottom: 2 }, cursorAtEnd: false, suggestion: null,
});

/**
 * io: now() -> ms; after(fn, ms) -> handle; cancel(handle); box() -> { value, shell }; setBox(value, shell) (a pull: no `input` event);
 * put({ text, base }) -> Promise<{ status, body }> (never rejects); note(view | null); problem(message); gone() (the route said 404).
 * The page calls capture() with every handled capture, edited() at every edit of the box (typing, the Shell toggle, a palette insert,
 * Clear), composition(on) around an IME composition, reset() when the connection came back, stop() when the pane is gone.
 */
export function createDraftSync(io) {
  // seenSig: the screen's sig at the last time box and screen matched or were pulled (null: none yet on this connection). dirty: the
  // box holds text the screen does not. editedAt / sentAt: when the box was last edited / the last write left. retryAt: no push before.
  const D = {
    seenSig: null, screen: null, cols: 0, dirty: false, editedAt: -Infinity, sentAt: 0, flight: null, timer: null, composing: false,
    sending: false, stopped: false, retryAt: 0, fails: 0, waiting: false, blocked: false, shown: '',
  };
  const now = () => io.now();

  const cancelTimer = () => {
    if (D.timer !== null) io.cancel(D.timer);
    D.timer = null;
  };
  const arm = (ms) => {
    cancelTimer();
    D.timer = io.after(() => { D.timer = null; step(); }, Math.max(0, ms));
  };

  /** The one note slot, told to the page only when it changes. */
  function show(note) {
    const key = note ? `${note.kind}:${note.reason ?? ''}` : '';
    if (key === D.shown) return;
    D.shown = key;
    io.note(noteView(note));
  }

  function pull(d) {
    D.dirty = false;
    D.seenSig = d.sig;
    D.fails = 0;
    D.waiting = false;
    io.setBox(d.text, d.mode === 'bash');
  }

  function step() {
    cancelTimer();
    const d = D.screen;
    if (d === null) { show(null); return; } // no box on screen (a prompt, a dialog): the text stays, the push waits
    if (d.state === 'unreadable') { show({ kind: 'paused', reason: d.reason }); return; } // never pulled over, never written over
    const box = io.box();
    const want = canon(box.value, box.shell);
    if (sameDraft(screenCanon(d), want)) { // in sync
      D.dirty = false;
      D.seenSig = d.sig;
      D.fails = 0;
      D.waiting = false;
      D.blocked = false;
      show(null);
      return;
    }
    const text = pushText(want);
    const long = !fits(text, D.cols);
    if (D.dirty && (long || D.blocked)) show({ kind: 'long' });
    else if (D.dirty && D.waiting) show({ kind: 'wait' });
    else show(null);
    if (D.flight || D.composing || D.sending || D.stopped) return; // our own write is landing, an IME is open, a Send runs: its end runs step again
    if (D.seenSig === null) { // the first readable capture of this connection: an empty box takes the screen; text already there is never wiped
      D.seenSig = d.sig;
      if (box.value === '' && !box.shell) { pull(d); return; }
    } else if (d.sig !== D.seenSig && !D.dirty) { // the terminal changed and nothing unsent is here
      const wait = D.editedAt + QUIET_MS - now();
      if (wait <= 0) pull(d);
      else arm(wait);
      return;
    }
    if (!D.dirty || D.fails >= 3 || D.blocked || long) return; // nika wins while the user types here; long text goes on Send
    const due = Math.max(D.editedAt + PUSH_MS, D.retryAt);
    if (due > now()) { arm(due - now()); return; }
    write(text, d.sig);
  }

  /** One PUT. Settles the state from the answer and returns { ok, status, code, reason }. */
  async function write(text, base) {
    D.sentAt = now();
    D.flight = Promise.resolve().then(() => io.put({ text, base }));
    let r;
    try {
      r = await D.flight;
    } catch {
      r = null;
    }
    D.flight = null;
    return settle(r && typeof r === 'object' ? r : { status: 0, body: null });
  }

  function fail(status) {
    D.fails += 1;
    D.retryAt = now() + (status === 0 ? 2000 : 3000);
    if (D.fails === 1) io.problem(status === 0 ? 'nika did not answer. Your text is kept.' : "nika couldn't copy your text into Claude's input. It is kept here.");
  }

  function settle(r) {
    const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {};
    const code = r.status === 409 && typeof body.error === 'string' ? body.error : '';
    const typedSince = D.editedAt >= D.sentAt; // the user kept typing after the request left
    const d = cleanDraft(body.draft);
    const out = { ok: r.status === 200, status: r.status, code, reason: body.reason };
    if (d) D.screen = d; // every answer that carries a draft says where the screen is
    if (r.status === 200) {
      if (d?.sig) D.seenSig = d.sig;
      D.dirty = typedSince;
      D.fails = 0;
      D.waiting = false;
      D.blocked = false;
      D.retryAt = 0;
    } else if (ADOPT.has(code) && d) {
      if (!typedSince) { // the terminal wins: forget the edit; the next step pulls the screen's text
        D.dirty = false;
        D.seenSig = '';
        D.editedAt = -Infinity;
      }
    } else if (code === 'draft-unreadable') {
      D.screen = unreadableDraft(body.reason, D.screen);
      D.retryAt = now() + 1000;
    } else if (code === 'busy-switching') {
      D.retryAt = now() + 300;
    } else if (code === 'not-idle') {
      D.waiting = true;
      D.retryAt = now() + 3000;
    } else if (code === 'input-unreadable' || code === 'mode-unknown' || ADOPT.has(code)) {
      D.retryAt = now() + 1000;
    } else if (r.status === 400) {
      D.blocked = true;
    } else if (r.status === 404) {
      D.stopped = true;
      io.gone();
    } else if (r.status === 429) {
      D.retryAt = now() + 700;
    } else {
      fail(r.status);
    }
    step();
    return out;
  }

  function edited() {
    D.dirty = true;
    D.editedAt = now();
    D.retryAt = 0;
    D.fails = 0;
    D.waiting = false;
    D.blocked = false;
    step();
  }

  return {
    /** Every handled 200 capture: `draft` is cleanDraft's answer (null: no readable box). */
    capture(draft, cols) {
      D.screen = draft;
      D.cols = Number.isInteger(cols) ? cols : 0;
      step();
    },
    edited,
    composition(on) {
      D.composing = on === true;
      if (!D.composing) step();
    },
    /** The connection came back (a retry after tmux failed, a reopened pane): the first readable capture follows the first-capture rule again. */
    reset() {
      cancelTimer();
      D.seenSig = null;
      D.screen = null;
      D.stopped = false;
      D.fails = 0;
      D.retryAt = 0;
      show(null);
    },
    stop() {
      cancelTimer();
      D.stopped = true;
    },
    /** Send starts: the background sync holds still until endSend. */
    beginSend() {
      D.sending = true;
      cancelTimer();
    },
    /** The push before Enter: waits for a write already on its way, then writes against the sig the page last synced on (the terminal's later change is a 409, not an overwrite). */
    async send(text) {
      if (D.flight) {
        try { await D.flight; } catch { /* write() already took the answer */ }
      }
      if (!D.screen || D.screen.state === 'unreadable') {
        return { ok: false, message: D.screen ? pausedLine(D.screen.reason) : "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept." };
      }
      const out = await write(text, D.seenSig ?? D.screen.sig);
      return out.ok ? { ok: true } : { ok: false, message: sendMessage(out) };
    },
    /** The text went to Claude and the box was cleared: nothing of it is unsent any more. */
    sent() {
      D.dirty = false;
      D.waiting = false;
      cancelTimer();
    },
    endSend() {
      D.sending = false;
      step();
    },
    screen: () => D.screen,
  };
}
