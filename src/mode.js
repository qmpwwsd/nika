// Reads Claude Code's permission mode (footer) and permission prompt from the rows of the pane mirror. Pure: no I/O.
// Phrases and layouts: docs/contracts/claude-tui.md section 1 and 2. When Claude Code changes them these parsers fail
// closed (`unknown` / `null`), so the control hides. Keep this file ASCII: write every symbol as an escape.
import { clean } from './text.js';

export const MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
/** Modes the app may switch to; bypassPermissions is never a target in 0.3. */
export const MODE_TARGETS = ['manual', 'acceptEdits', 'plan', 'auto'];
/** A permission prompt must sit within the last PROMPT_ROWS non-blank rows. */
export const PROMPT_ROWS = 15;

// A token counts only at the start of the mode line: up to 2 spaces, an optional vim-mode prefix, optional glyphs.
// Anything else (a file name, a sentence, a slash-menu entry, a wrapped description) is not a footer.
const LEAD = String.raw`^\s{0,2}(?:-- (?:INSERT|NORMAL) --\s*)?(?:[\u23f5\u23f8]+\s*)?`;
const atLineStart = (token) => new RegExp(LEAD + token, 'i');

/** Footer tokens, case-insensitive. `manual mode` is Claude's positive marker for manual. */
export const FOOTER = [
  { mode: 'auto', match: atLineStart('auto mode') },
  { mode: 'manual', match: atLineStart('manual mode') },
  { mode: 'acceptEdits', match: atLineStart('accept edits') },
  { mode: 'plan', match: atLineStart('plan mode') },
  { mode: 'dontAsk', match: atLineStart(String.raw`don['\u2019]t ask`) },
];
// The whole word `bypass` or `bypassPermissions` (so `bypass.js` and `bypassing` are not); the exact phrase is not
// verified yet (claude-tui.md 7).
const BYPASS = atLineStart(String.raw`bypass(?:permissions)?(?=\s|$)`);

/** The text of one mirror row: its spans concatenated. */
export function rowText(row) {
  return Array.isArray(row) ? row.map((sp) => (typeof sp?.t === 'string' ? sp.t : '')).join('') : '';
}

/** Texts of the last n non-blank rows, oldest first; empty unless n is a positive integer. */
export function lastNonBlank(rows, n) {
  if (!Array.isArray(rows) || !Number.isInteger(n) || n < 1) return [];
  return rows.map(rowText).filter((t) => t.trim()).slice(-n);
}

/** Mode shown by the mode line, the last non-blank row only; a phrase anywhere else never counts. */
export function modeFromRows(rows) {
  const row = lastNonBlank(rows, 1)[0];
  if (row === undefined) return 'unknown';
  const hit = FOOTER.find((f) => f.match.test(row));
  if (hit) return hit.mode;
  return BYPASS.test(row) ? 'bypassPermissions' : 'unknown';
}

// Option row: optional spaces, optional selection marker, `<n>. <label>`. Matches any number so that a `10.` row is
// seen (and refused) instead of being glued to the previous label as a wrapped row.
const OPTION = /^\s*(?:\u276f\s*)?(\d{1,3})\.\s+(.*)$/;
// A digit answers a prompt without Enter, so Claude's options are numbered 1..9.
const MAX_OPTIONS = 9;

/**
 * Claude's permission prompt from the bottom rows, or null. The closing `Esc to cancel` row anchors it and must be the
 * last non-blank row (a prompt left above a drawn prompt box is stale); the numbered options (1..k, 2 <= k <= 9, no
 * gaps) sit above it and a question ending in `?` directly above option 1, all within the last PROMPT_ROWS non-blank
 * rows. Any other layout, such as the unnumbered folder-trust dialog, is null so no buttons show.
 */
export function promptFromRows(rows) {
  const win = lastNonBlank(rows, PROMPT_ROWS);
  const hint = win.length - 1;
  if (hint < 0 || !win[hint].trimStart().startsWith('Esc to cancel')) return null;
  const first = win.slice(0, hint).findLastIndex((t) => OPTION.exec(t)?.[1] === '1');
  if (first < 1) return null; // no option 1, or no row above it for the question
  const question = win[first - 1].trim();
  if (!question.endsWith('?')) return null;
  const parts = []; // label pieces per option: the first row, then indented continuation rows
  for (const t of win.slice(first, hint)) {
    const m = OPTION.exec(t);
    if (m) {
      if (parts.length === MAX_OPTIONS || m[1] !== String(parts.length + 1)) return null;
      parts.push([m[2]]);
    } else if (/^\s/.test(t)) parts.at(-1).push(t);
    else return null;
  }
  if (parts.length < 2) return null;
  const options = [];
  for (const [i, p] of parts.entries()) {
    const label = clean(p.join(' '), 80);
    if (!label) return null;
    options.push({ n: i + 1, label });
  }
  return { question: clean(question, 200), options };
}
