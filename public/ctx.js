// Pure helpers for the context and auto-compact UI (design 0.4 sections 5 and 6), shared by Settings and, from 0.4's context indicator,
// the rows and the session header. No DOM here: every function takes plain values and returns text, so Node tests the whole file
// (test/ctx.test.js). The page never decides what Claude does; compactPreview only previews the form's unsaved values with the
// same rule the server launches with (src/compact.js: a threshold is the window x per cent, never above window - 33000).

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
