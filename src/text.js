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

// Same set as UNSAFE but keeps \t (0x09) and \n (0x0a).
const UNSAFE_BLOCK = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Multi-line display text: CRLF/CR become LF, controls (except \t and \n) and bidi marks become spaces, cut to max,
 * trailing whitespace removed; null for non-strings and blank text. The page must still render it with textContent.
 */
export function cleanBlock(s, max = 32768) {
  if (typeof s !== 'string') return null;
  const v = s.replace(/\r\n?/g, '\n').replace(UNSAFE_BLOCK, ' ').slice(0, max).trimEnd();
  return v.trim().length ? v : null;
}
