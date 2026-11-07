// Strings from transcripts, reports and tmux are agent-controlled: strip C0/C1 controls (terminal escapes) and
// zero-width and bidi marks before they reach a terminal or the page (review F4, verify N2).
// Keep this file ASCII: write every code point as an escape, never raw.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Single-line display text: controls → space, whitespace collapsed, trimmed, cut to max; null for empty. */
export function clean(s, max = 500) {
  if (typeof s !== 'string') return null;
  const v = s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return v.length ? v : null;
}
