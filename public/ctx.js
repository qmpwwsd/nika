// Pure helpers for the context and auto-compact UI (design 0.4 sections 5 and 6), shared by Settings and, from 0.4's context indicator,
// the rows and the session header. No DOM here: every function takes plain values and returns text, so Node tests the whole file
// (test/ctx.test.js). The page never decides what Claude does; compactPreview only previews the form's unsaved values with the
// same rule the server launches with (src/compact.js: a threshold is the window x per cent, never above window - 33000). ctxView formats
// what the server sends in `context` (src/model.js contextOf); it never computes a window, a per cent or a threshold.

const BUFFER = 33000; // tokens Claude Code keeps free below the window (spike S2): the latest a session can compact
const W200 = 200000;
const W1M = 1000000;
const OFF = "Off. nika sets nothing and types no /compact; Claude Code's own setting applies."; // 0.5.4 AC: the app also types /compact now, so Off says it does not

/** Tokens as short text, always rounded down: "999", "8.5k", "124k", "1M", "1.2M". Null for anything that is not a finite, non-negative number. */
export function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const v = Math.floor(n);
  if (v < 1000) return String(v);
  if (v < 10000) return `${Math.floor(v / 100) / 10}k`;
  if (v < W1M) return `${Math.floor(v / 1000)}k`;
  return `${Math.floor(v / 100000) / 10}M`;
}

/** Where a session with window `w` compacts at `p` per cent, in whole thousands of tokens, as text. */
const at = (w, p) => fmtTokens(Math.floor(Math.min(Math.floor((w * p) / 100), w - BUFFER) / 1000) * 1000);

/**
 * The result line under the Auto-compact row for the form's values `{ enabled, pct, window }` (window 200000 | 400000 | 1000000 |
 * 'model'). Null when the line must be hidden: a pct that is not a whole number from 20 to 95, or a window that is not one of the four.
 * Off gives the Off line whatever the other two hold. A window larger than a model's own is cut to it, so 400k means 400k on a
 * 1M model and 200k on a 200k model; the cap (window - 33000) applies to the configured window on every model.
 */
export function compactPreview(form) {
  if (form === null || typeof form !== 'object' || typeof form.enabled !== 'boolean') return null;
  const { enabled, pct: p, window } = form;
  if (!enabled) return OFF;
  if (!Number.isInteger(p) || p < 20 || p > 95) return null;
  const small = at(W200, p);
  switch (window) {
    case 200000: return `Compacts at about ${small} tokens.`;
    case 400000: return `Compacts at about ${at(400000, p)} tokens (about ${small} on 200k-window models).`;
    case W1M: return `Compacts at about ${at(W1M, p)} tokens on 1M-window models (about ${small} on 200k-window models).`;
    case 'model': return `Compacts at ${p} % of each model's window: about ${at(W1M, p)} tokens on 1M-window models, about ${small} on 200k-window models.`;
    default: return null;
  }
}

const NBSP = '\u00a0'; // between the number and "%"
const num = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * The context meter for `a.context` (contract C6: `{ tokens, window, compactAt, pct, compaction }` or null), as plain text:
 * `{ lvl, text, of, long, q, title, sr }`.
 * - `lvl`: 'unknown' (no context, or no tokens), 'nowin' (tokens, but the server sent no window or per cent: no model seen yet),
 *   'ok' under 60 %, 'warn' from 60 %, 'full' from 80 % (fixed on both tiers, design 6.1).
 * - `text`: the visible number ("41 %", the per cent rounded, with a no-break space; "124k" for nowin; "–" for unknown). `of`: "312k / 400k",
 *   `long`: "312k / 400k · 78 %", both null unless there is a window. `q`: the bar step 0 to 10 (round(pct / 10), capped), null for no bar.
 * - `title` (a mouse aid: the cells take no focus) and `sr` (the sr-only span) name both numbers; `compaction` picks the clause:
 *   'on' says where it compacts, 'typed' (0.5.4 AC: the app tier types /compact there) says where nika types it, 'off' says the window is
 *   the model's and auto-compact is off, 'none' (no setting reached the session, or it ended) and anything else say nothing about
 *   compaction. A bad `compactAt` on 'on' or 'typed' also says nothing.
 * `note` (app tier, 0.5.4 AC: the last typed /compact of the pane, see cleanNote) adds one sentence to the title (after " \u00b7 ") and to
 * sr (after ", "), whatever the reading; a note that is not exactly the wire shape adds nothing.
 * Anything malformed reads as unknown (tokens) or nowin (window, per cent); it never throws.
 */
export function ctxView(context, note = null) {
  const v = meter(context);
  const sentence = noteSentence(cleanNote(note));
  if (sentence === null) return v;
  return { ...v, title: `${v.title} \u00b7 ${sentence}`, sr: `${v.sr}, ${sentence}` };
}

function meter(context) {
  const c = context !== null && typeof context === 'object' && !Array.isArray(context) ? context : {};
  if (!num(c.tokens) || c.tokens <= 0) return { lvl: 'unknown', text: '–', of: null, long: null, q: null, title: 'Context: no usage yet', sr: 'Context unknown' };
  const used = fmtTokens(c.tokens);
  if (!num(c.window) || c.window <= 0 || !num(c.pct) || c.pct < 0) {
    return { lvl: 'nowin', text: used, of: null, long: null, q: null, title: `Context: ${used} tokens; the window is not known yet`, sr: `Context ${used} tokens, window unknown` };
  }
  const of = `${used} / ${fmtTokens(c.window)}`;
  const win = `${used} of ${fmtTokens(c.window)} tokens`;
  const text = `${Math.round(c.pct)}${NBSP}%`;
  const lvl = c.pct >= 80 ? 'full' : c.pct >= 60 ? 'warn' : 'ok';
  const point = num(c.compactAt) && c.compactAt > 0;
  const on = c.compaction === 'on' && point;
  const typed = c.compaction === 'typed' && point;
  const off = c.compaction === 'off';
  const title = on ? `Context: ${win} (compacts at ${fmtTokens(c.compactAt)})`
    : typed ? `Context: ${win} (nika types /compact at ${fmtTokens(c.compactAt)})`
      : off ? `Context: ${win} (the model's window; auto-compact is off)` : `Context: ${win}`;
  const sr = `Context ${text} used, ${win}${on ? `, compacts at ${fmtTokens(c.compactAt)}` : typed ? `, nika types /compact at ${fmtTokens(c.compactAt)}` : off ? ', auto-compact off' : ''}${lvl === 'full' ? ', nearly full' : ''}`;
  return { lvl, text, of, long: `${of} · ${text}`, q: Math.min(10, Math.round(c.pct / 10)), title, sr };
}

// ---- the note of a typed /compact (0.5.4 AC, design 6.3, 6.4 and 7.1) ----------------------------------------------------------------

const NOTE_STATES = ['typed', 'compacted', 'stopped'];
const NOTE_FIELDS = 3; // state, at, tokens
const MAX_NOTE_TOKENS = 10000000;

/**
 * Local 24 h "HH:MM" of a time in ms, zero padded, from new Date(ms) (no toLocaleTimeString: the same text on every machine and locale).
 * Null for anything that is not a time the calendar has (not a number, not finite, past the Date range).
 */
export function clockOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The wire note of a typed /compact ({ state, at, tokens }, the app tier's `compacted`) as a clean copy, or null for anything else:
 * exactly those three keys, a state of typed / compacted / stopped, `at` a safe integer time the calendar has, `tokens` an integer
 * from 0 to 10000000. No session id, no text: nothing else is ever read from it.
 */
export function cleanNote(note) {
  if (note === null || typeof note !== 'object' || Array.isArray(note)) return null;
  if (Object.keys(note).length !== NOTE_FIELDS) return null; // three own keys, and the three checks below need those three: nothing else can be there
  const { state, at, tokens } = note;
  if (!NOTE_STATES.includes(state)) return null;
  if (!Number.isSafeInteger(at) || at < 0 || clockOf(at) === null) return null;
  if (!Number.isInteger(tokens) || tokens < 0 || tokens > MAX_NOTE_TOKENS) return null;
  return { state, at, tokens };
}

/** The sentence for a clean note, as it ends the tooltip and the sr text of a meter. Null for no note. */
function noteSentence(n) {
  if (n === null) return null;
  const when = `${clockOf(n.at)}, at ${fmtTokens(n.tokens)}`;
  if (n.state === 'typed') return `nika typed /compact at ${when}`;
  if (n.state === 'compacted') return `nika compacted this session at ${when}`;
  return 'nika stopped typing /compact here after 3 failed tries';
}

/**
 * The session header's /compact line for a wire note: `{ state, icon, long, short }`, or null (the line stays hidden) for no note or a
 * malformed one. `icon` is a sprite name, `long` the sentence a screen reader hears at any width, `short` the words drawn when the
 * window is narrow. Each state has its own icon, colour (session.css) and words: never colour alone.
 */
export function acView(note) {
  const n = cleanNote(note);
  if (n === null) return null;
  const clock = clockOf(n.at);
  if (n.state === 'typed') return { state: 'typed', icon: 'clock', long: noteSentence(n), short: `/compact ${clock}` };
  if (n.state === 'compacted') return { state: 'compacted', icon: 'compact', long: noteSentence(n), short: `Compacted ${clock}` };
  return { state: 'stopped', icon: 'warn', long: `${noteSentence(n)}; it tries again after nika restarts`, short: '/compact stopped' };
}
