// Draft sync, the page side (nika 0.5, design W5/W6; the route: docs/contracts/api-app.md, PUT /api/app/pane/:id/draft).
// The session window's message box and Claude's input box mirror each other: a changed screen is pulled into the box after
// 1.5 s of local quiet, a local edit is pushed 250 ms after the last keystroke. This file has no DOM and makes no request of
// its own: session.js hands createDraftSync a box, a PUT function, a clock and a note sink, so Node tests every rule
// (test/draft-sync.test.js). The capture's `draft` and every route answer are data: cleanDraft re-checks the shape, and no
// word of the server ever reaches the page (the notes and problem lines below are fixed copy).
// 0.5.4 (LT): the unsent text that this sync does not mirror into Claude's input (too long, refused, or waiting for a box) is also kept on the server for the
// pane (PUT .../kept-draft), and put back into the box when the window opens again (restore). The same rules live here, so Node tests them too.
// Keep this file ASCII: write every symbol as an escape.
import { cellWidth, LIMITS, utf8Bytes } from './mirror-render.js';
import { SURVEY_UNDO_LINE } from './quick-actions.js';

export const QUIET_MS = 1500; // local quiet before the terminal's text is pulled into the box
export const PUSH_MS = 250; // after the last local edit, the box is pushed
export const KEEP_MS = 500; // after the last change of what should be kept; above PUSH_MS, so a text the sync pushes is never kept
const KEEP_MAX = LIMITS.paste; // 16 KB of UTF-8, Send's paste limit: a copy that Send could not send is not kept
const KEEP_RETRY_MS = 2000; // after a failed keep write
const RESTORE_RETRY_MS = 2000; // between the two tries of the restore, and between two capture re-tries after a 404
const RESTORE_AGAIN_MAX = 3; // capture re-tries of a restore that never saw the server's copy (a 404), then it ends as a failure
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

// ---- the kept text (0.5.4, LT) ------------------------------------------------------------------------------------------------

const KEEP_STRIP = new RegExp(BAD_CONTROL.source, 'g');

/** `s` with every lone surrogate replaced by U+FFFD. No regex: a lookbehind is missing in older web views, and a regex without it misses two lone surrogates in a row. */
function wellFormed(s) {
  if (typeof s.toWellFormed === 'function') return s.toWellFormed();
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      out += s[i] + s[i + 1];
      i += 1;
    } else {
      out += c >= 0xd800 && c <= 0xdfff ? '\ufffd' : s[i];
    }
  }
  return out;
}

/**
 * The box's text as Send's paste would deliver it, which is what is kept: CRLF and CR are a newline, every character the keys route strips (C0 but tab and newline, DEL,
 * C1) is gone, a lone surrogate is U+FFFD, trailing newlines go (planSend trims them). Bidi marks, joiners, tabs, inner newlines and trailing spaces stay as typed.
 */
export function keepForm(value) {
  return wellFormed(String(value ?? '').replace(/\r\n?/g, '\n').replace(KEEP_STRIP, '')).replace(/\n+$/, '');
}

/** The server's `kept` as the page may use it, or null: a plain object with a non-empty text that is already in its kept form and at most 16 KB, and a boolean `shell`. Copies the two fields. */
export function cleanKept(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { text, shell } = raw;
  if (typeof text !== 'string' || text === '' || typeof shell !== 'boolean') return null;
  if (keepForm(text) !== text || utf8Bytes(text) > KEEP_MAX) return null;
  return { text, shell };
}

/** The text is above the 16 KB that Send can send and nika can keep. `text` is in its kept form. */
const isOver = (text) => utf8Bytes(text) > KEEP_MAX;

/** What a copy is called when two are compared: '' for nothing, else the text with a mark for the Shell flag. */
export const keyOf = (k) => (k === null ? '' : (k.shell ? '!' : '-') + k.text);

export const RESTORING_TEXT = 'nika is bringing back the text you had not sent. Try again in a moment.';
export const RESTORED_TEXT = 'Restored the text you had not sent.';
export const RESTORE_TEXT_FAILED = "nika couldn't bring back the text you had not sent. Leave this session and open it again to try once more.";
export const RESTORE_TEXT_SKIPPED = 'You started typing before nika could bring back the text you had not sent, so it was not put back.';
export const KEEP_FAILED = "nika couldn't keep the text you have not sent. It is lost if you leave this session before you send it.";
export const KEEP_NO_PROJECT = "nika can't keep unsent text for this session because it can't tell the session's project. It is lost if you leave before you send it.";

// ---- the capture's draft ------------------------------------------------------------------------------------------------

/** The capture's `draft` as the page may use it, or null (older server, malformed: no cut, no sync). Copies the fields; nothing else is kept. */
export function cleanDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { state, mode, text, sig, reason, box, cursorAtEnd, suggestion, queued } = raw;
  if (!STATES.has(state) || !MODES.has(mode) || typeof text !== 'string' || text.length > TEXT_MAX) return null;
  if (!box || !Number.isInteger(box.top) || !Number.isInteger(box.bottom) || box.top < 0 || box.bottom <= box.top) return null;
  const at = { top: box.top, bottom: box.bottom };
  if (Number.isInteger(box.tasks) && box.tasks >= 0 && box.tasks < box.top) at.tasks = box.tasks; // Claude's task list pinned above the box (LC18): the glide's frame ends there (public/glide.js)
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
 * over (the text is above 16 KB: Send cannot send it and nika cannot keep it; 0.5.4 LT). Every kind has its own colour (session.css), icon and word.
 */
export function noteView(note) {
  if (!note) return null;
  if (note.kind === 'paused') {
    return { kind: 'paused', icon: 'pause', label: 'Sync paused:', text: `Claude's input holds ${reasonText(note.reason)}. Edit or clear it in the terminal.` };
  }
  if (note.kind === 'long') return { kind: 'long', icon: 'info', label: 'Not mirrored:', text: 'This text goes to Claude when you send it.' };
  if (note.kind === 'over') {
    return { kind: 'over', icon: 'warn', label: 'Not kept:', text: "Over 16 KB: Send can't send it, and nika can't keep it if you leave. Shorten it or send it in parts." };
  }
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

/** A Send pressed while the last one is still in flight (session.js sendComposer, attach.js send): this fixed line as a warn (not an error), shown STILL_SENDING_MS like the rate-limit line. Nothing is sent or queued; the text stays in the box. */
export const STILL_SENDING = 'Still sending your last message; press Send again in a moment.';
export const STILL_SENDING_MS = 3000;

const NOT_TAKEN = "nika pressed Enter, but Claude's input still shows your text (a menu may have taken the Enter). Check the terminal. Your text is kept.";

// 0.5.4 (final, S5): nika's own paste is in Claude's input, so a screen nika cannot read for Enter (Claude's `paste again to expand` hint shows for a few seconds) must not read as "your text is kept in the box" alone.
const PASTED_SCREEN_UNCLEAR = "Your text is in Claude's input. Press Enter in the terminal to send it.";

/** The line for a Send whose Enter did not go (the submit route, W13). Fixed copy: only the status and the server's `error` code pick it. `pasted`: this Send put its text into Claude's input before the Enter. */
export function submitMessage({ status, code, pasted = false } = {}) {
  if (status === 409) {
    if (code === 'prompt-open') return 'A prompt opened in Claude, so nika did not press Enter. Answer it, then send again. Your text is kept.';
    if (code === 'bypass-prompt') return 'Answer this prompt in the terminal.';
    if (code === 'not-idle') return 'Stop is running, so nika did not press Enter. Send again in a moment. Your text is kept.';
    if (code === 'draft-changed') return "Claude's input changed before Enter. nika shows what it holds now. Nothing was sent.";
    if (code === 'screen-unclear') return pasted === true ? PASTED_SCREEN_UNCLEAR : "nika can't tell what Claude is showing, so it did not press Enter. Use the terminal. Your text is kept.";
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
 * `pasted` (true only when this Send typed or pushed its text into Claude's input first) picks the line for 409 `screen-unclear` and nothing else.
 */
export function submitResult({ status, body } = {}, { pasted = false } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (status === 200) return b.taken === false ? { ok: false, message: NOT_TAKEN } : { ok: true, taken: b.taken === true ? true : null };
  return { ok: false, message: submitMessage({ status, code: status === 409 && typeof b.error === 'string' ? b.error : '', pasted }) };
}

/** The line for an accept that did not take. Fixed copy: only the status and the server's `error` code pick it. */
function acceptMessage({ status, code, reason }) {
  if (status === 409) {
    if (code === 'draft-mismatch') return "Claude's input did not take the suggestion. nika shows what it holds now.";
    if (code === 'draft-changed') return STALE_SUGGESTION;
    if (code === 'draft-unreadable') return pausedLine(reason);
    // 0.5.1 (item K): a turn that runs in main is `busy`; background agents or a shell do not stop the accept. `not-idle` from this route now means a
    // prompt or dialog is open, or Stop/End is running. The text keeps "Claude is working" for a server older than 0.5.1, which sent `not-idle` whenever
    // Claude's registry was not idle (also during background work).
    if (code === 'busy') return "Claude is answering right now, so nika can't accept the suggestion. Nothing was sent.";
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
 * note(view | null); problem(message, ms?); gone() (the route said 404).
 * 0.5.4 (LT): keep({ text, shell }) -> Promise<{ status, body }> (the kept-text PUT; never rejects); fetchKept() -> Promise<{ status, body }> (the bounded GET; never
 * rejects); announce(message) (for screen readers).
 * The page calls capture() with every handled capture, edited() at every edit of the box (typing, the Shell toggle, a palette insert,
 * Clear), composition(on) around an IME composition, reset() when the connection came back, stop() when the pane is gone, restore() when the window opens
 * (and on a back/forward return), flushKeep() when it is left.
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
    // The kept text (0.5.4, LT). keeping: the latch (what is kept stays kept until the text is mirrored, pulled, sent or emptied); kept: the copy the server holds ('' nothing,
    // keyOf of a copy, null unknown); keepTimer / keepFor: the armed write and the copy it is armed for; keepFlight / keepSoon: a write is on its way / a clear was asked meanwhile;
    // keepFails / keepTold / keepRetryAt: failures in a row, the problem line was shown, no write before; keepOff: the route cannot be used (404, 409); keepHold: a restore failed, no
    // write until the first edit (the server's copy stays); restoring: the GET runs; restoreAgain: the last restore ended on 404 or a throw, so the next reset() asks again; restored: the box holds put-back text; edits: edited() calls so far.
    // The copies this page wrote itself (MF-2, owner answer A): own: the keys of its writes, the newest 6 (a write that failed or whose answer is lost may have landed, so it counts as its own);
    // saved: the last copy the page knows the server held for its box: its own confirmed write, a leave-time write that answered 200, or what a restore found and settled on ('' at the start: an empty box matches it);
    // after a Send the copy this page knew the server held joins own, and saved is the empty copy the Send's clear writes (SF-1).
    // A restore that never saw the server's copy (404, stopped, throw) leaves a chain (SF-4): restoreAgain (reset() asks again), againEdits (the edit count of the first try: typing since is "typed before nika could bring
    // back"), restoreAt (a capture re-try is due from then on; Infinity: none pending; 404 and stopped only; while one is pending Claude's input is not pulled into the box, F-1), againTries (capture re-tries of this
    // chain, at most RESTORE_AGAIN_MAX). returnEdits (F-2): null, or the edit count of the back/forward return that came while a restore ran: it runs, as a first try with that count, when that restore ends.
    keeping: false, kept: null, keepTimer: null, keepFor: '', keepFlight: false, keepSoon: false, keepFails: 0, keepTold: false, keepRetryAt: 0, keepOff: false, keepHold: false,
    restoring: false, restoreAgain: false, restored: false, edits: 0, own: [], saved: '', againEdits: 0, restoreAt: Infinity, againTries: 0, returnEdits: null,
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

  /** One look at the sync (pull, push, notes) and one at the kept text. Every caller keeps calling this. */
  function step() {
    syncStep();
    keepStep();
  }

  function syncStep() {
    cancelTimer();
    if (D.restoring) return; // no pull, no push, no note change while the kept text is being brought back
    const over = D.dirty && isOver(keepForm(io.box().value)); // a text over 16 KB can be neither kept nor sent: its note wins in every state of the screen (SF-5)
    const d = D.screen;
    if (d === null) { show(over ? { kind: 'over' } : null); return; } // no box on screen (a prompt, a dialog): the text stays, the push waits
    if (d.state === 'unreadable') { show(over ? { kind: 'over' } : { kind: 'paused', reason: d.reason }); return; } // never pulled over, never written over
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
    // put-back text (0.5.4, LT) is pushed by itself only into an empty Claude input: over Claude's other text it waits for the user's first edit, and for Send
    const hold = D.blocked || (D.restored && d.state !== 'empty');
    if (D.dirty && (long || hold)) show({ kind: over ? 'over' : 'long' }); // over: its own note, recomputed at every step (0.5.4, LT)
    else if (D.dirty && D.held !== null) show({ kind: D.held });
    else show(null);
    if (D.flight || D.composing || D.sending || D.stopped) return; // our own write is landing, an IME is open, a Send runs: its end runs step again
    // A capture re-try is pending (F-1): the server's copy was never seen, and Claude's text pulled into an empty box would make the re-try skip that copy and the next keep step clear it. So
    // nothing is pulled, the first capture and a later one alike; this branch does not set seenSig, so after a boot or reset() the first readable capture after the chain ends follows the first-capture
    // rule, and a screen that changed meanwhile is pulled by the rule below.
    const chain = D.restoreAt !== Infinity;
    if (D.seenSig === null) { // the first readable capture of this connection: an empty box takes the screen; text already there is never wiped
      if (!chain) {
        D.seenSig = d.sig;
        if (box.value === '' && !box.shell) { pull(d); return; }
      }
    } else if (d.sig !== D.seenSig && !D.dirty && !chain) { // the terminal changed and nothing unsent is here
      const wait = D.editedAt + QUIET_MS - now();
      if (wait <= 0) pull(d);
      else arm(wait);
      return;
    }
    if (!D.dirty || D.fails >= 3 || hold || long) return; // nika wins while the user types here; long text goes on Send
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
    D.edits += 1;
    D.retryAt = 0;
    D.fails = 0;
    D.told = false;
    D.held = null;
    D.blocked = false;
    D.restored = false; // after the user's own edit the normal rules apply again
    D.keepFails = 0; // a new text gets fresh tries, and the first edit after a failed restore releases the hold
    D.keepRetryAt = 0;
    if (D.restoreAt === Infinity) D.keepHold = false; // a capture re-try pending: the server's copy was never seen, so no write may reach it before the re-try answers
    step();
  }

  // ---- the kept text (0.5.4, LT) -----------------------------------------------------------------------------------------------

  const cancelKeep = () => {
    if (D.keepTimer !== null) io.cancel(D.keepTimer);
    D.keepTimer = null;
  };

  /**
   * What the server should hold now: { want: { text, shell } } or { want: null }; { over: true } for a text above 16 KB (it is not kept). Only unsent text is kept (dirty), and only
   * text the sync does not mirror: one outside the envelope or refused (400), put back, or waiting (no box, a paused box, a refused write, three failures). The latch makes save
   * and clear asymmetric: keeping starts when the text is not mirrored and stops only when dirty goes false or the box is emptied, so a leave while a shortened text is on its
   * way to Claude still brings back the newest text.
   */
  function wantKeep() {
    if (!D.dirty) return { want: null };
    const box = io.box();
    const text = keepForm(box.value);
    if (text.trim() === '') return { want: null };
    const waiting = D.screen === null || D.screen.state === 'unreadable' || D.held !== null || D.fails >= 3;
    const notMirrored = !fits(pushText(canon(box.value, box.shell)), D.cols) || D.blocked || D.restored || waiting;
    if (!D.keeping && !notMirrored) return { want: null };
    if (isOver(text)) return { want: null, over: true };
    return { want: { text, shell: box.shell === true } };
  }

  function keepStep(immediate = false) {
    if (D.stopped || D.restoring || D.keepOff || D.keepHold) return;
    const { want, over } = wantKeep();
    D.keeping = want !== null || over === true;
    const key = keyOf(want);
    if (D.keepFlight) { if (immediate) D.keepSoon = true; return; } // a write is on its way, so what the server holds is not known yet: its answer runs keepStep again (at once if asked)
    if (D.kept !== null && key === D.kept) { cancelKeep(); return; } // the server already holds exactly this (or nothing)
    if (D.keepFails >= 3 && !immediate) return; // three failures wait for an edit; a send's clear still goes
    if (immediate) { cancelKeep(); keepWrite(want); return; }
    if (D.keepTimer !== null && D.keepFor === key) return; // already armed for this text
    cancelKeep();
    D.keepFor = key;
    D.keepTimer = io.after(() => { D.keepTimer = null; keepStep(true); }, Math.max(KEEP_MS, D.keepRetryAt - now()));
  }

  /** One keep write at a time. A copy is `want`, or null for the clear. */
  async function keepWrite(want) {
    D.keepFlight = true;
    const wrote = keyOf(want);
    if (!D.own.includes(wrote)) { D.own.push(wrote); if (D.own.length > 6) D.own.shift(); } // bounded: the newest 6 distinct keys (a clear is the key '')
    let r;
    try {
      r = await io.keep({ text: want?.text ?? '', shell: want?.shell ?? false });
    } catch {
      r = null;
    }
    D.keepFlight = false;
    r = r && typeof r === 'object' ? r : { status: 0, body: null };
    if (r.status === 200) {
      D.kept = wrote;
      D.saved = wrote;
      D.keepFails = 0;
      D.keepTold = false;
      D.keepRetryAt = 0;
    } else if (r.status === 404) {
      D.keepOff = true; // the pane is gone: the sync's own 404 flow speaks
    } else if (r.status === 409) {
      D.keepOff = true; // no project: nothing can be kept for this pane
      io.problem(KEEP_NO_PROJECT, 8000);
    } else if (r.status === 429) {
      D.kept = null;
      D.keepRetryAt = now() + 1000;
    } else {
      D.kept = null;
      D.keepFails += 1;
      D.keepRetryAt = now() + KEEP_RETRY_MS;
      if (D.keepFails >= 2 && !D.keepTold) { D.keepTold = true; io.problem(KEEP_FAILED, 8000); }
    }
    const soon = D.keepSoon;
    D.keepSoon = false;
    keepStep(soon); // a send's clear that was asked during this write goes at once
  }

  /** The window is being left: what is pending goes now (the PUT outlives the page). It does not wait for a write on its way. */
  function flushKeep() {
    if (D.stopped || D.restoring || D.keepOff || D.keepHold) return;
    const { want } = wantKeep();
    if (!D.keepFlight && D.kept !== null && keyOf(want) === D.kept) return; // D.kept is the copy from before a write that is on its way: it says nothing then
    cancelKeep();
    const was = D.saved;
    const key = keyOf(want);
    try { // the copy counts as saved only on its own 200, and only if nothing newer was saved meanwhile (MF-2b: an unanswered or failed write is not a save)
      Promise.resolve(io.keep({ text: want?.text ?? '', shell: want?.shell ?? false })).then((r) => { if (r?.status === 200 && D.saved === was) D.saved = key; }).catch(() => {});
    } catch { /* the page is leaving */ }
  }

  /** The GET's answer as the page may use it: { ok: true, kept: null | { text, shell } } or { ok: false, status }. */
  async function readKept() {
    let r;
    try {
      r = await io.fetchKept();
    } catch {
      r = null;
    }
    const status = r && typeof r === 'object' && Number.isInteger(r.status) ? r.status : 0;
    const body = r && typeof r === 'object' ? r.body : null;
    if (status === 200 && body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'kept')) {
      if (body.kept === null) return { ok: true, kept: null };
      const kept = cleanKept(body.kept);
      if (kept !== null) return { ok: true, kept };
    }
    return { ok: false, status };
  }

  /**
   * Brings back the text the server kept: at boot and on a back/forward return (first tries, each starting a new chain), and again (`retry`) from reset() and, after a 404, from captures. While it runs nothing is pulled,
   * pushed or written. The page refuses a Send while the GET is out (restoring()); a capture re-try waits for a Send that runs (F-4). A return that comes while a restore runs is not dropped (F-2): it is remembered
   * (one, with the edit count of that moment) and runs as a first try, `since` being that count, when the running restore ends; a return while the page is stopped is a no-op (reset() asks again only for an open chain). One retry after 2 s unless the pane is gone (404). The box is never cleared: nothing kept (an evicted or dropped
   * tray) leaves it as it is. A copy that differs from a box with text goes in only when another page wrote it and the box still holds what this page saved (MF-2, below). It never
   * rejects. A try that does not end on a known answer (404, a failure, a throw) leaves the server's copy unknown and holds every keep write until the user's first edit: the text on
   * the server is never cleared for a restore that did not see it.
   */
  async function restore(retry = false, since = null) { // retry: a capture re-try or reset() asking again; the boot restore and a back/forward return are first tries and start a new chain; since: only for a return that waited (F-2)
    if (D.stopped) return;
    if (D.restoring) { // F-2: a return waits for the running restore (one is enough: the first edit count stays); a re-try is never recorded
      if (!retry && D.returnEdits === null) D.returnEdits = D.edits;
      return;
    }
    D.restoring = true;
    if (!retry) D.againTries = 0; // a new chain
    const edits = retry ? D.againEdits : since ?? D.edits; // taken before any wait (an edit made while a write is on its way is seen too); a re-try keeps the first try's count: typing since is "typed before nika could bring back"
    D.restoreAgain = false;
    D.restoreAt = Infinity; // no capture re-try is pending while this try runs
    cancelTimer();
    cancelKeep();
    const unknown = () => { D.kept = null; D.keepHold = true; };
    const again = (fromCapture) => { D.restoreAgain = true; D.againEdits = edits; if (fromCapture) D.restoreAt = now() + RESTORE_RETRY_MS; }; // reset() asks again; the next capture too, when the pane may answer at once
    try {
      if (D.flight) {
        try { await D.flight; } catch { /* write() already took the answer */ }
      }
      let k = await readKept();
      if (!k.ok && k.status !== 404) {
        await new Promise((res) => { io.after(res, RESTORE_RETRY_MS); });
        k = await readKept();
      }
      if (D.stopped) { // the answer was never used (MF-1b): the server's copy is still unseen, so the next reset() asks again
        unknown();
        again(true);
        return;
      }
      if (!k.ok && k.status === 404) { // the pane is gone, or nika's tmux list could not be read: the capture's own flow speaks; reset() and the next captures ask again, at most RESTORE_AGAIN_MAX times
        unknown();
        if (D.againTries >= RESTORE_AGAIN_MAX) { io.problem(RESTORE_TEXT_FAILED, 8000); return; } // the chain ends as a failure: nothing asks again, the first edit lifts the hold
        again(true);
        return;
      }
      if (!k.ok) { // the server's copy stays for the next try: nothing is written until the user's first edit
        io.problem(RESTORE_TEXT_FAILED, 8000);
        unknown();
        return;
      }
      D.keepHold = false; // an answer: what the server holds is known from here on
      if (k.kept === null) { D.kept = ''; return; }
      const box = io.box();
      const mine = keepForm(box.value);
      const key = keyOf(k.kept);
      const boxKey = keyOf(mine.trim() === '' ? null : { text: mine, shell: box.shell === true });
      if (key === boxKey) { D.kept = key; D.saved = key; return; }
      if (D.edits !== edits) { // the user typed before the answer: their box wins, and the next keep step saves it or clears the old copy
        io.problem(RESTORE_TEXT_SKIPPED, 8000);
        D.kept = key;
        return;
      }
      // MF-2 (owner answer A): the server's copy goes into a box only when it came from another page and the box still holds the copy this page saved (an empty box at the start matches
      // the empty start). A copy this page wrote itself (an old one when the leave-time write did not land, or one whose answer was lost), or a box with text this page never saved,
      // keeps the box: the next keep step saves it (or clears the old copy). No line: the user typed nothing during the restore.
      if (D.own.includes(key) || boxKey !== D.saved) { D.kept = key; return; }
      io.setBox(k.kept.text, k.kept.shell); // the pull path: no input event, the caret at the end; focus never moves
      D.dirty = true;
      D.editedAt = now();
      D.restored = true;
      D.blocked = false;
      D.fails = 0;
      D.held = null;
      D.keeping = true;
      D.kept = key;
      D.saved = key; // the box holds exactly what the server holds
      io.announce(RESTORED_TEXT);
    } catch {
      unknown(); // a throw inside (the box, the put-back, the live region): same as a failure, and reset() tries again (no capture re-try)
      again(false);
      try { io.problem(RESTORE_TEXT_FAILED, 8000); } catch { /* the page is going away */ }
    } finally {
      D.restoring = false;
      const since = D.returnEdits;
      D.returnEdits = null; // cleared before the return runs
      if (since !== null) restore(false, since); // F-2: before any step can pull or push; it sets restoring at once, so the step below is a no-op then, and its own end runs a step
      step();
    }
  }

  /**
   * A restore that never saw the server's copy asks again when the pane answers (one GET per RESTORE_RETRY_MS at most, RESTORE_AGAIN_MAX in all): from a capture (a 200) or a tick (a 304). Not while stopped,
   * and not under a Send that runs (F-4): the first capture or tick after it does. Returns true when a re-try started.
   */
  function runDueRetry() {
    if (D.restoreAt === Infinity || D.stopped || D.sending || now() < D.restoreAt) return false;
    D.againTries += 1;
    restore(true);
    return true;
  }

  return {
    /** Every handled 200 capture: `draft` is cleanDraft's answer (null: no readable box). */
    capture(draft, cols) {
      D.screen = draft;
      D.capturedAt = now();
      D.cols = Number.isInteger(cols) ? cols : 0;
      if (runDueRetry()) return; // a due re-try started (it ends in its own step)
      step();
    },
    /** A screen answer with no change (a 304): runs a due capture re-try; nothing else. */
    tick() {
      runDueRetry();
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
      D.keepOff = false; // a 404 while tmux was down must not switch the keeping off for good
      D.fails = 0;
      D.told = false;
      D.retryAt = 0;
      show(null);
      if (D.restoreAgain) { // the last restore never saw the server's text (404, stopped, or a throw): ask again now that the pane answers, with a new count of capture re-tries
        D.againTries = 0;
        if (D.sending) D.restoreAt = Math.min(D.restoreAt, now()); // not under a Send that runs (SF-3): the first capture after it asks again (F-4)
        else restore(true);
      }
    },
    stop() {
      cancelTimer();
      cancelKeep();
      D.stopped = true;
    },
    restore,
    flushKeep,
    /** The kept text is being brought back (the page refuses Send meanwhile). */
    restoring: () => D.restoring,
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
      if (D.saved !== '' && !D.own.includes(D.saved)) { D.own.push(D.saved); if (D.own.length > 6) D.own.shift(); } // the copy this page knew the server held is what was just sent: it never comes back (SF-1)
      D.saved = ''; // the box is empty now, as the clear below will make the server's copy: another page's copy still comes back into it
      keepStep(true); // the kept copy is cleared at once, not after KEEP_MS
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
      if (D.restoring || D.restoreAt !== Infinity) return { ok: false, status: null, message: RESTORING_TEXT }; // a suggestion must not land in a box the restore then replaces, nor under a capture re-try that is still due (SF-2)
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
