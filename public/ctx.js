// Pure helpers for the context and auto-compact UI (design 0.4 sections 5 and 6), shared by Settings and, from 0.4's context indicator,
// the rows and the session header. No DOM here: every function takes plain values and returns text, so Node tests the whole file
// (test/ctx.test.js). The page never decides what Claude does; compactPreview only previews the form's unsaved values with the
// same rule the server launches with (src/compact.js: a threshold is the window x per cent, never above window - 33000). ctxView formats
// what the server sends in `context` (src/model.js contextOf); it never computes a window, a per cent or a threshold.

const BUFFER = 33000; // tokens Claude Code keeps free below the window (spike S2): the latest a session can compact
const W200 = 200000;
const W1M = 1000000;
const OFF = "Off. Sessions nika starts keep Claude Code's own setting.";

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
 *   'on' says where it compacts, 'off' says the window is the model's and auto-compact is off, 'none' (nika did not start the session,
 *   or it ended) and anything else say nothing about compaction. A bad `compactAt` on 'on' also says nothing.
 * Anything malformed reads as unknown (tokens) or nowin (window, per cent); it never throws.
 */
export function ctxView(context) {
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
  const on = c.compaction === 'on' && num(c.compactAt) && c.compactAt > 0;
  const off = c.compaction === 'off';
  const title = on ? `Context: ${win} (compacts at ${fmtTokens(c.compactAt)})` : off ? `Context: ${win} (the model's window; auto-compact is off)` : `Context: ${win}`;
  const sr = `Context ${text} used, ${win}${on ? `, compacts at ${fmtTokens(c.compactAt)}` : off ? ', auto-compact off' : ''}${lvl === 'full' ? ', nearly full' : ''}`;
  return { lvl, text, of, long: `${of} · ${text}`, q: Math.min(10, Math.round(c.pct / 10)), title, sr };
}
