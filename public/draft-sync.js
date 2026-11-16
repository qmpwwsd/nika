// Draft sync, the page side (nika 0.5, design W5/W6; the route: docs/contracts/api-app.md, PUT /api/app/pane/:id/draft).
// The session window's message box and Claude's input box mirror each other: a changed screen is pulled into the box after
// 1.5 s of local quiet, a local edit is pushed 250 ms after the last keystroke. This file has no DOM and makes no request of
// its own: session.js hands createDraftSync a box, a PUT function, a clock and a note sink, so Node tests every rule
// (test/draft-sync.test.js). The capture's `draft` and every route answer are data: cleanDraft re-checks the shape, and no
// word of the server ever reaches the page (the notes and problem lines below are fixed copy).
// Keep this file ASCII: write every symbol as an escape.
import { cellWidth } from './mirror-render.js';
import { SURVEY_UNDO_LINE } from './quick-actions.js';

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
  layout: "text nika can't read back exactly",
};
const reasonText = (reason) => REASON_TEXT[Object.hasOwn(REASON_TEXT, reason) ? reason : 'layout'];

// ---- twins of src/draft.js (browser code cannot import src/; test/draft-sync.test.js asserts they answer alike) -----------

/** The form two drafts are compared in: a tab is 4 spaces, a no-break space is a space, trailing spaces of every line go. */
export function normDraft(text) {
  return typeof text === 'string' ? text.replace(/\t/g, '    ').replace(/\u00a0/g, ' ').replace(/ +$/gm, '') : '';
}

export const sameDraft = (a, b) => typeof a === 'string' && typeof b === 'string' && normDraft(a) === normDraft(b);

const width = (s) => { let n = 0; for (const ch of s) n += cellWidth(ch.codePointAt(0)); return n; };

const MAX_CHARS = 1024;
const MAX_NEWLINES = 12;
const MAX_ROWS = 13;
const MAX_RUN = 699; // a run this long of spaces and tabs cannot be cut around when nika types it in chunks of at most 700 characters
const LONG_RUN = new RegExp(`[ \\t]{${MAX_RUN},}`);

/**
 * Rows one hard line needs when Claude wraps it at `w` cells: an exact port of `wrappedRows` in src/draft.js (wrap-ansi with
 * `hard: true, trim: false`; test/draft-sync.test.js fuzzes both against each other). A row that is already `w` wide starts a new row
 * before the next word; one space is appended before every word after the first; a word that does not fit the rest of the row starts a
 * new row; a word longer than `w` starts on the current row unless starting on the next saves a break, then is cut at `w` cell by cell.
 */
function wrappedRows(line, w) {
  let rows = 1;
  let used = 0; // cells of the current row, with the space after its last word
  line.split(' ').forEach((word, i) => {
    if (i > 0) {
      if (used >= w) { rows += 1; used = 0; }
      used += 1;
    }
    const n = width(word);
    if (n > w) {
      if (Math.floor((n - 1) / w) < 1 + Math.floor((n - (w - used) - 1) / w)) { rows += 1; used = 0; }
      const cells = [...word];
      cells.forEach((ch, k) => {
        const c = cellWidth(ch.codePointAt(0));
        if (used + c > w) { rows += 1; used = 0; }
        used += c;
        if (used === w && k < cells.length - 1) { rows += 1; used = 0; }
      });
      return;
    }
    if (used > 0 && used + n > w && n > 0) { rows += 1; used = 0; }
    used += n;
  });
  return rows;
}

/**
 * At most 1024 characters, 12 newlines and 13 estimated rows (a 14-row box may be a window, so it is unreadable), and no run of 699
 * or more spaces and tabs (reason 'chars'). The same answer as `inEnvelope` in src/draft.js, byte for byte (fuzzed in the tests).
 */
export function inEnvelope(text, cols) {
  if (typeof text !== 'string' || !Number.isInteger(cols) || cols <= 4) return { ok: false, reason: 'invalid' };
  if (text.length > MAX_CHARS || LONG_RUN.test(text)) return { ok: false, reason: 'chars' };
  const lines = text.split('\n');
  if (lines.length - 1 > MAX_NEWLINES) return { ok: false, reason: 'newlines' };
  const rows = lines.reduce((n, line) => n + wrappedRows(line.replace(/\t/g, '    '), cols - 4), 0);
  return rows > MAX_ROWS ? { ok: false, reason: 'rows' } : { ok: true };
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
  const { state, mode, text, sig, reason, box, cursorAtEnd, suggestion, queued } = raw;
  if (!STATES.has(state) || !MODES.has(mode) || typeof text !== 'string' || text.length > TEXT_MAX) return null;
  if (!box || !Number.isInteger(box.top) || !Number.isInteger(box.bottom) || box.top < 0 || box.bottom <= box.top) return null;
  const at = { top: box.top, bottom: box.bottom };
  if (state === 'unreadable') {
    return { state, mode, text: '', sig: null, reason: Object.hasOwn(REASON_TEXT, reason) ? reason : 'layout', box: at, cursorAtEnd: false, suggestion: null, queued: false };
  }
  if (typeof sig !== 'string' || !SIG.test(sig)) return null;
  return {
    state, mode, text, sig, box: at, cursorAtEnd: cursorAtEnd === true,
    suggestion: typeof suggestion === 'string' && suggestion.length <= 200 ? suggestion : null,
    queued: queued === true, // Claude shows "Press up to edit queued messages" in an empty box (W13); never a suggestion
  };
}

/**
 * The first mirror row to cut (the box's top rule), or null: only a readable draft with Type into pane off hides Claude's input box.
 * A prompt suggestion in the box is cut with it: the message box shows it as its placeholder (suggestionFor) and Tab accepts it (W4).
 */
export function cutAt(draft, passOn) {
  if (passOn === true || !draft || (draft.state !== 'empty' && draft.state !== 'text')) return null;
  const top = draft.box?.top;
  return Number.isInteger(top) && top >= 0 ? top : null;
}

/**
 * Claude's prompt suggestion as nika's message box shows it (its placeholder) and Tab or the right arrow accepts it (W4), or null.
 * Only while the box is empty and Shell is off, and the screen's draft is a readable, empty prompt box with a suggestion (the
 * parser gives null for the `Try "..."` example; a paused draft is unreadable, so it gives none either). Claude's queued-messages
 * placeholder is no suggestion (W13): the parser gives null for it, and `queued` is checked here as well.
 */
export function suggestionFor(draft, { value = '', shell = false } = {}) {
  if (shell === true || value !== '' || !draft || draft.state !== 'empty' || draft.mode !== 'prompt' || draft.queued === true) return null;
  const s = draft.suggestion;
  return typeof s === 'string' && s !== '' && s.length <= 200 ? s : null;
}

/** Where the caret goes after a pull: text that only grew keeps a caret inside the old text where it was and follows an end caret; anything else, the end. */
export function caretAfter(before, after, caret) {
  const inside = Number.isInteger(caret) && caret >= 0 && caret < before.length;
  return after.startsWith(before) && inside ? caret : after.length;
}

// ---- the note under the box (colour + icon + word per state) -------------------------------------------------------------

/**
 * { kind, icon, label, text } for the one note, or null. kind: paused (the screen's draft cannot be read), long (outside the envelope),
 * hold (a write is refused: a prompt is open or Stop runs), cursor (a write is refused: Claude works and its cursor is not at the end of the
 * input), queued (Claude holds our message and takes it at its next step), suggest (Claude offers a prompt suggestion: Tab accepts it).
 * Every kind has its own colour (session.css), icon and word.
 */
export function noteView(note) {
  if (!note) return null;
  if (note.kind === 'paused') {
    return { kind: 'paused', icon: 'pause', label: 'Sync paused:', text: `Claude's input holds ${reasonText(note.reason)}. Edit or clear it in the terminal.` };
  }
  if (note.kind === 'long') return { kind: 'long', icon: 'info', label: 'Not mirrored:', text: 'Long text goes to Claude when you send it.' };
  if (note.kind === 'hold') {
    return { kind: 'hold', icon: 'dialog', label: 'On hold:', text: "A prompt is open or Stop is running. Your text goes into Claude's input when that is over." };
  }
  if (note.kind === 'cursor') {
    return {
      kind: 'cursor', icon: 'window', label: 'Cursor:',
      text: 'Claude is working and the cursor in its input is not at the end. Move it to the end in the terminal, or wait: your text goes in when Claude waits.',
    };
  }
  if (note.kind === 'queued') return { kind: 'queued', icon: 'send', label: 'Queued:', text: 'Claude takes your message at its next step.' };
  if (note.kind === 'suggest') return { kind: 'suggest', icon: 'kbd', label: 'Suggestion:', text: 'Tab or \u2192 accepts what Claude suggests.' };
  return null;
}

// ---- Send (design 4) ---------------------------------------------------------------------------------------------------------

const LONG_REFUSAL = "Claude's input already holds text; it would be sent together with yours. Clear it in the terminal or shorten your message.";
const pausedLine = (reason) => `Claude's input holds ${reasonText(reason)}. Send or clear it in the terminal.`;
const STALE_SUGGESTION = "Claude's suggestion changed. Nothing was sent.";
const CANT_READ_LINE = "nika can't read Claude's input box right now (a menu may be open). Nothing was sent.";
const CANT_READ = `${CANT_READ_LINE} Your text is kept.`;
const BUSY_SWITCHING = 'Another action is running on this session. Try again in a moment. Your text is kept.';

/** The body of Send's Enter against the screen `s`: its sig as `base` (the route presses Enter only while the box still reads so), or none. */
const submitBase = (s) => (typeof s?.sig === 'string' && SIG.test(s.sig) ? { base: s.sig } : {});

/**
 * What Send does with the box and the screen. `screen` is cleanDraft's answer for the last capture (null: no readable box). `footerKnown`
 * is whether that capture read Claude's mode line (`modeConfirmed` and a mode): with no readable box and no known footer (a menu, Claude's
 * agent list) the legacy road would type the text before the submit route could refuse, so Send refuses and sends nothing. Returns
 *   { act: 'none' }   nothing to send: the box is empty and Claude's input (a readable screen) is empty too. An Enter there could only act
 *                     on Claude's suggestion, which nika never verified, so no request goes out. The attachment tray treats it as "no text".
 *   { act: 'enter', submit, summary, textSummary? }   Enter alone (the screen already equals the box, or the box is empty and Claude's input holds
 *                                       something or cannot be read); `textSummary` (only when the box has text) names that text for the echo; `submit` is the body
 *                                       of the guarded submit route: { base } with the screen's sig, or {} when it has none
 *   { act: 'push', text, summary }   copy the box into Claude's input first; the Enter follows with the sig of that write
 *   { act: 'legacy' }   today's paste / Shell path (no readable box on a known footer, or a long text onto an empty prompt)
 *   { act: 'refuse', message }
 * No plan carries an Enter key: the page's Send presses Enter only through the submit route (W13). The sendGate (a permission prompt)
 * runs before this; Claude working does not gate Send: Claude queues the message, and the route refuses a prompt that opened after the
 * page looked.
 */
export function draftSendPlan({ value, shell = false, screen = null, cols = 0, footerKnown = true } = {}) {
  const v = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (v.trim() === '') {
    if (shell) return { act: 'legacy' };
    if (!screen && !footerKnown) return { act: 'refuse', message: CANT_READ_LINE }; // an empty box: there is no text to keep
    return screen?.state === 'empty' ? { act: 'none' } : { act: 'enter', ok: true, submit: submitBase(screen), summary: 'Enter' };
  }
  if (!screen) return footerKnown ? { act: 'legacy' } : { act: 'refuse', message: CANT_READ };
  if (screen.state === 'unreadable') return { act: 'refuse', message: pausedLine(screen.reason) };
  const want = canon(v, shell);
  const text = pushText(want);
  const n = text.length - (shell ? 1 : 0);
  const textSummary = shell ? `a shell command (${n} characters) + Enter` : `${n} characters + Enter`;
  // `textSummary`: what the message was, for the echo of a message Claude queued (an Enter alone says only "Enter")
  if (sameDraft(screenCanon(screen).replace(/\n+$/, ''), want)) return { act: 'enter', ok: true, submit: submitBase(screen), summary: 'Enter', textSummary };
  if (fits(text, cols)) return { act: 'push', ok: true, text, summary: textSummary, textSummary };
  if (screen.state === 'empty' && screen.mode === 'prompt') return { act: 'legacy' };
  return { act: 'refuse', message: LONG_REFUSAL };
}

/**
 * The line for a Send whose push did not land. Fixed copy: only the status and the server's `error` code pick it. `kept`: the terminal's change was not
 * pulled over the box (the user had edited it since the last capture), so the line says the text is kept instead of saying nika shows Claude's.
 */
function sendMessage({ status, code, reason, kept = false }) {
  if (status === 409) {
    if (code === 'draft-changed' || code === 'screen-changed' || code === 'draft-mismatch') {
      return kept
        ? "Claude's input changed while nika was copying your text. Nothing was sent. Your text is kept."
        : "Claude's input changed while nika was copying your text. nika shows what it holds now. Nothing was sent.";
    }
    if (code === 'draft-unreadable') return pausedLine(reason);
    if (code === 'not-idle') return "A prompt is open in Claude or Stop is running, so nika can't change its input now. Nothing was sent. Your text is kept.";
    if (code === 'cursor-not-at-end') {
      return 'Claude is working and the cursor in its input is not at the end. Move it to the end in the terminal, or send when Claude waits. Nothing was sent. Your text is kept.';
    }
    if (code === 'clear-stopped') return "Claude's input did not clear in time. Nothing was sent. Your text is kept; send again.";
    if (code === 'input-unreadable' || code === 'mode-unknown') return CANT_READ;
    if (code === 'busy-switching') return BUSY_SWITCHING;
    if (code === 'survey-undo') return SURVEY_UNDO_LINE; // the clear needs an Escape, which would undo the rating Claude still shows
  }
  if (status === 400) return "This text can't be copied into Claude's input as it is. Your text is kept.";
  if (status === 404) return 'The session is gone.';
  if (status === 429) return 'Too many keys at once; try again. Your text is kept.';
  if (status === 0) return 'nika did not answer. Your text is kept.';
  return "nika couldn't copy your text into Claude's input. Your text is kept.";
}

const NOT_TAKEN = "nika pressed Enter, but Claude's input still shows your text (a menu may have taken the Enter). Check the terminal. Your text is kept.";

/** The line for a Send whose Enter did not go (the submit route, W13). Fixed copy: only the status and the server's `error` code pick it. */
export function submitMessage({ status, code } = {}) {
  if (status === 409) {
    if (code === 'prompt-open') return 'A prompt opened in Claude, so nika did not press Enter. Answer it, then send again. Your text is kept.';
    if (code === 'bypass-prompt') return 'Answer this prompt in the terminal.';
    if (code === 'not-idle') return 'Stop is running, so nika did not press Enter. Send again in a moment. Your text is kept.';
    if (code === 'draft-changed') return "Claude's input changed before Enter. nika shows what it holds now. Nothing was sent.";
    if (code === 'screen-unclear') return "nika can't tell what Claude is showing, so it did not press Enter. Use the terminal. Your text is kept.";
    if (code === 'suggestion-shown') return "Claude's input is empty and shows a suggestion, so nika did not press Enter. Nothing was sent.";
    if (code === 'input-unreadable' || code === 'mode-unknown') return CANT_READ;
    if (code === 'busy-switching') return BUSY_SWITCHING;
  }
  if (status === 404) return 'The session is gone.';
  if (status === 429) return 'Too many keys at once; try again. Your text is kept.';
  if (status === 0) return "nika did not answer, so it is not known whether Enter was pressed. Check Claude's input in the terminal. Your text is kept.";
  return "nika couldn't press Enter in Claude's input. Check the terminal. Your text is kept.";
}

/**
 * The submit route's answer as Send uses it: { ok: true, taken } (200: `taken` true, or null when the box could not be compared; Claude
 * queues the message while it works) or { ok: false, message } (any refusal, and a 200 whose `taken` is false: the Enter did not take, the text stays).
 */
export function submitResult({ status, body } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (status === 200) return b.taken === false ? { ok: false, message: NOT_TAKEN } : { ok: true, taken: b.taken === true ? true : null };
  return { ok: false, message: submitMessage({ status, code: status === 409 && typeof b.error === 'string' ? b.error : '' }) };
}

/** The line for an accept that did not take. Fixed copy: only the status and the server's `error` code pick it. */
function acceptMessage({ status, code, reason }) {
  if (status === 409) {
    if (code === 'draft-mismatch') return "Claude's input did not take the suggestion. nika shows what it holds now.";
    if (code === 'draft-changed') return STALE_SUGGESTION;
    if (code === 'draft-unreadable') return pausedLine(reason);
    if (code === 'not-idle') return "Claude is working or a prompt is open, so nika can't accept the suggestion now. Nothing was sent.";
    if (code === 'input-unreadable' || code === 'mode-unknown') return "nika can't read Claude's input box right now (a menu may be open). Nothing was sent.";
    if (code === 'busy-switching') return 'Another action is running on this session. Try again in a moment.';
  }
  if (status === 400) return "nika can't accept this suggestion.";
  if (status === 404) return 'The session is gone.';
  if (status === 429) return 'Too many keys at once; try again.';
  if (status === 0) return 'nika did not answer.';
  return "nika couldn't accept the suggestion.";
}

// ---- the controller ------------------------------------------------------------------------------------------------------------

const ADOPT = new Set(['draft-changed', 'screen-changed', 'draft-mismatch']); // 409s whose body carries the screen's draft: the terminal wins
const unreadableDraft = (reason, like) => ({
  state: 'unreadable', mode: like?.mode ?? 'prompt', text: '', sig: null, reason: Object.hasOwn(REASON_TEXT, reason) ? reason : 'layout',
  box: like?.box ?? { top: 0, bottom: 2 }, cursorAtEnd: false, suggestion: null, queued: false,
});

/**
 * io: now() -> ms; after(fn, ms) -> handle; cancel(handle); box() -> { value, shell }; setBox(value, shell) (a pull: no `input` event);
 * put({ text, base }) -> Promise<{ status, body }> (never rejects); suggest({ text }) -> Promise<{ status, body }> (the accept route; never rejects);
 * note(view | null); problem(message); gone() (the route said 404).
 * The page calls capture() with every handled capture, edited() at every edit of the box (typing, the Shell toggle, a palette insert,
 * Clear), composition(on) around an IME composition, reset() when the connection came back, stop() when the pane is gone.
 */
export function createDraftSync(io) {
  // seenSig: the screen's sig at the last time box and screen matched or were pulled (null: none yet on this connection; '' after sent() or an
  // adopted 409, where the next capture wins). adopted: seenSig is '' because a refused write's screen was adopted (the terminal won), not
  // because sent() forgot the screen: only then does a Send keep writing against '' (the route refuses it); after sent() it writes against the
  // screen's own sig (R2 #1). dirty: the box holds text the screen does not. editedAt / sentAt / capturedAt: when the box was last edited / the
  // last write left / the last capture was applied. retryAt: no push before.
  const D = {
    seenSig: null, adopted: false, screen: null, cols: 0, dirty: false, editedAt: -Infinity, sentAt: 0, capturedAt: -Infinity, flight: null, timer: null, composing: false,
    sending: false, stopped: false, retryAt: 0, fails: 0, told: false, held: null, blocked: false, shown: '', // held: null | 'hold' | 'cursor' (the last write was refused); told: the problem line already showed in this run of failures
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
    D.told = false;
    D.held = null;
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
      D.told = false;
      D.held = null;
      D.blocked = false;
      // an empty box over an empty screen: Claude's suggestion (Tab accepts it), or our message that Claude holds in its queue
      show(suggestionFor(d, box) !== null ? { kind: 'suggest' } : d.state === 'empty' && d.queued === true ? { kind: 'queued' } : null);
      return;
    }
    const text = pushText(want);
    const long = !fits(text, D.cols);
    if (D.dirty && (long || D.blocked)) show({ kind: 'long' });
    else if (D.dirty && D.held !== null) show({ kind: D.held });
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

  /** One PUT. Settles the state from the answer and returns { ok, status, code, reason }. `own`: it is Send's push (settle keeps the box on a refusal after a fresh edit). */
  async function write(text, base, own = false) {
    D.sentAt = now();
    D.flight = Promise.resolve().then(() => io.put({ text, base }));
    let r;
    try {
      r = await D.flight;
    } catch {
      r = null;
    }
    D.flight = null;
    return settle(r && typeof r === 'object' ? r : { status: 0, body: null }, own);
  }

  /**
   * A write that failed for good reasons of its own: another try after `wait`; after three nothing is pushed until the next edit. The problem
   * line shows once per run of failures, at the first one that is the `at`-th or later: a mix of kinds (a clear that stopped, then a 500) can
   * never give up without it.
   */
  function fail(status, wait = status === 0 ? 2000 : 3000, at = 1, line = null) {
    D.fails += 1;
    D.retryAt = now() + wait;
    if (D.told || D.fails < at) return;
    D.told = true;
    io.problem(line ?? (status === 0 ? 'nika did not answer. Your text is kept.' : "nika couldn't copy your text into Claude's input. It is kept here."));
  }

  function settle(r, own = false) {
    const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {};
    const code = r.status === 409 && typeof body.error === 'string' ? body.error : '';
    const typedSince = D.editedAt >= D.sentAt; // the user kept typing after the request left
    // R2 #1: Send's own push, refused because the terminal changed: a box the user edited after the last applied capture is newer than anything the screen
    // told the page, so it is kept (never pulled over), whichever way the clock ran against the request
    const keep = typedSince || (own && Number.isFinite(D.editedAt) && D.editedAt >= D.capturedAt);
    const d = cleanDraft(body.draft);
    const out = { ok: r.status === 200, status: r.status, code, reason: body.reason, sig: r.status === 200 && d?.sig ? d.sig : null };
    if (d) D.screen = d; // every answer that carries a draft says where the screen is
    // the note names the last refusal: a later answer of another kind ends it. busy-switching and a 429 are not an answer about the draft: the note stays through them (R2 #6)
    if (code !== 'busy-switching' && r.status !== 429) D.held = code === 'not-idle' ? 'hold' : code === 'cursor-not-at-end' ? 'cursor' : null;
    if (r.status === 200) {
      if (d?.sig) D.seenSig = d.sig;
      D.dirty = typedSince;
      D.fails = 0;
      D.told = false;
      D.blocked = false;
      D.retryAt = 0;
    } else if (ADOPT.has(code) && d) {
      if (!keep) { // the terminal wins: forget the edit; the next step pulls the screen's text
        D.dirty = false;
        D.seenSig = '';
        D.adopted = true;
        D.editedAt = -Infinity;
      } else if (own) {
        out.kept = true; // Send's push was refused and the box stays as it is: the refusal line says so
      }
    } else if (code === 'draft-unreadable') {
      D.screen = unreadableDraft(body.reason, D.screen);
      D.retryAt = now() + 1000;
    } else if (code === 'busy-switching') {
      D.retryAt = now() + 300;
    } else if (code === 'not-idle') { // a prompt is open or Stop runs
      D.retryAt = now() + 3000;
    } else if (code === 'cursor-not-at-end') { // Claude works and its cursor is on an earlier row: only the idle road can write; the answer's draft is already in D.screen
      D.retryAt = now() + 3000;
    } else if (code === 'survey-undo') { // the clear's Escape would undo the rating. Send's own push gets the line from its return value (sendMessage); the background write says it here, once
      if (own) D.retryAt = now() + 3000;
      else fail(r.status, 3000, 1, SURVEY_UNDO_LINE);
    } else if (code === 'clear-stopped') { // nika's own clear stopped half-way: the screen holds a partial text, which is never adopted
      fail(r.status, 1000, 3);
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
    D.told = false;
    D.held = null;
    D.blocked = false;
    step();
  }

  return {
    /** Every handled 200 capture: `draft` is cleanDraft's answer (null: no readable box). */
    capture(draft, cols) {
      D.screen = draft;
      D.capturedAt = now();
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
      D.told = false;
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
        return { ok: false, message: D.screen ? pausedLine(D.screen.reason) : CANT_READ };
      }
      // After sent() the sync has forgotten the screen it matched (seenSig ''): the base is then the screen's own sig, like the background push; ''
      // stays the base only after an adopted 409 (the route refuses it, as it did).
      const base = D.seenSig === '' && !D.adopted ? D.screen.sig : (D.seenSig ?? D.screen.sig);
      const out = await write(text, base, true);
      return out.ok ? { ok: true, sig: out.sig } : { ok: false, message: sendMessage(out) };
    },
    /**
     * Send's Enter was answered (the submit route): its `draft` is where the screen is now, so a step between the Enter and the next
     * capture never works from the screen as it was before. A 200 always says (null: no readable box any more); a refusal only when it
     * carries one (draft-changed: the next step pulls that text into the box, the terminal wins).
     */
    submitted({ status, body } = {}) {
      const d = cleanDraft(body?.draft);
      if (status === 200 || d) D.screen = d;
    },
    /**
     * The text went to Claude and the box was cleared: nothing of it is unsent any more. The sync forgets the screen it last matched
     * (seenSig ''), so the next capture wins: if Claude's input still holds the text (the Enter did not take), it is pulled back into the box.
     */
    sent() {
      D.dirty = false;
      D.held = null;
      D.seenSig = '';
      D.adopted = false;
      cancelTimer();
    },
    endSend() {
      D.sending = false;
      step();
    },
    /**
     * Tab or the right arrow on the suggestion `text` the box shows (W4). The server presses Tab only when a fresh screen still shows exactly
     * that suggestion, so nothing is sent here when the page's own copy is already stale. Returns { ok, status, message }. The answer's
     * draft is the screen: a box that is still empty and unedited takes its text like a pull; a box the user typed into meanwhile keeps
     * its text (nika wins while the user types here). A refusal that carries a draft adopts it, so the terminal's text is pulled by the usual rule.
     */
    async accept(text) {
      if (D.flight) {
        try { await D.flight; } catch { /* write() already took the answer */ }
      }
      if (D.stopped || D.sending || text === '' || suggestionFor(D.screen, io.box()) !== text) return { ok: false, status: null, message: STALE_SUGGESTION }; // nothing was sent: no status
      let r;
      try {
        r = await io.suggest({ text });
      } catch {
        r = null;
      }
      r = r && typeof r === 'object' ? r : { status: 0, body: null };
      const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {};
      const d = cleanDraft(body.draft);
      if (d) D.screen = d;
      if (r.status === 404) {
        D.stopped = true;
        io.gone();
      }
      const box = io.box();
      if (r.status === 200 && d?.state === 'text' && box.value === '' && !box.shell && !D.dirty) pull(d);
      step();
      if (r.status === 200) return { ok: true, status: 200, message: '' };
      const code = r.status === 409 && typeof body.error === 'string' ? body.error : '';
      return { ok: false, status: r.status, message: acceptMessage({ status: r.status, code, reason: body.reason }) };
    },
    screen: () => D.screen,
  };
}
