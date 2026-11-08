// Reads Claude Code's permission mode (footer) and permission prompt from the rows of the pane mirror. Pure: no I/O.
// Phrases and layouts: docs/contracts/claude-tui.md section 1 and 2. When Claude Code changes them these parsers fail
// closed (`unknown` / `null`), so the control hides. Keep this file ASCII: write every symbol as an escape.
import { clean } from './text.js';

export const MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'];
/** Modes the app may switch to; bypassPermissions is never a target in 0.3. */
export const MODE_TARGETS = ['manual', 'acceptEdits', 'plan', 'auto'];
/** A permission prompt must sit within the last PROMPT_ROWS non-blank rows. */
export const PROMPT_ROWS = 15;

/** Footer tokens, case-insensitive. `manual mode` is Claude's positive marker for manual. */
export const FOOTER = [
  { mode: 'auto', match: /auto mode/i },
  { mode: 'manual', match: /manual mode/i },
  { mode: 'acceptEdits', match: /accept edits/i },
  { mode: 'plan', match: /plan mode/i },
  { mode: 'dontAsk', match: /don['\u2019]t ask/i },
];

/** The text of one mirror row: its spans concatenated. */
export function rowText(row) {
  return Array.isArray(row) ? row.map((sp) => (typeof sp?.t === 'string' ? sp.t : '')).join('') : '';
}

/** Texts of the non-blank rows, top to bottom. */
const nonBlank = (rows) => (Array.isArray(rows) ? rows.map(rowText).filter((t) => t.trim()) : []);

// A slash-menu entry such as `/plan  Enter plan mode` can end with a footer token: never a mode line.
const SLASH_ENTRY = /^\s*(?:\u276f\s*)?\//;

/** Mode shown by the mode line, the last non-blank row only; a phrase anywhere else never counts. */
export function modeFromRows(rows) {
  const row = nonBlank(rows).at(-1);
  if (row === undefined || SLASH_ENTRY.test(row)) return 'unknown';
  const hit = FOOTER.find((f) => f.match.test(row));
  if (hit) return hit.mode;
  return /bypass/i.test(row) ? 'bypassPermissions' : 'unknown';
}

// Option row: optional spaces, optional selection marker, `<n>. <label>`.
const OPTION = /^\s*(?:\u276f\s*)?(\d{1,3})\.\s+(.*)$/;

/**
 * Claude's permission prompt from the bottom rows, or null. The closing `Esc to cancel` row anchors it and must be the
 * last non-blank row (a prompt left above a drawn prompt box is stale); the numbered options (1..k, k >= 2, no gaps)
 * sit above it and a question ending in `?` directly above option 1, all within the last PROMPT_ROWS non-blank rows.
 * Any other layout, such as the unnumbered folder-trust dialog, is null so no buttons show.
 */
export function promptFromRows(rows) {
  const win = nonBlank(rows).slice(-PROMPT_ROWS);
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
      if (m[1] !== String(parts.length + 1)) return null;
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
