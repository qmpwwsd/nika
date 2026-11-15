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
/** Bash mode (`!` box) draws `! for shell mode` instead of the permission-mode phrase (spike S9 Q6): a mode line, but no mode. */
export const SHELL_FOOTER = /^\s{0,2}(?:-- INSERT --\s*)?! for shell mode/;
const isModeLine = (text) => FOOTER.some((f) => f.match.test(text)) || BYPASS.test(text) || SHELL_FOOTER.test(text);

// The list of running background subagents that Claude 2.1.325 draws BELOW the footer (spike S15; F2 live, 60 and 120 columns): one
// blank row, `  <U+23FA> main`, one row per agent `  <U+25EF> <type>  <label>  <elapsed>[ <U+00B7> <arrow> <n> tokens]` and, when more than
// five run, `  <U+2193> <n> more`. The rows are recognised by their fixed prefix and suffix, never by the label (the model writes it).
// shortcut: the elapsed forms `1m`, `2h 3m 4s` and tokens such as `1.2m` were not seen (`5s`, `1m 11s`, `20.5k`, `300` were); they are
// accepted by the same formatter's pattern. Upgrade if Claude draws another unit.
const MAIN_ROW = /^ {2}\u23fa main\s*$/;
const AGENT_ROW = /^ {2}\u25ef \S+ {2}.* (?:\d+[dhm](?: \d+[hms])*|\d+s)(?: \u00b7 [\u2191\u2193] \d+(?:\.\d+)?[km]? tokens)?\s*$/;
const MORE_ROW = /^ {2}\u2193 \d+ more\s*$/;

// Claude's question and plan dialogs (0.5, design W1 2.2 and 2.6). Their footers anchor a dialog on the screen. They live here, not in
// src/dialog.js, because dialog.js imports this file and footerEnd needs them. A footer is matched on its trimmed text, no-break spaces read
// as spaces. `Esc to cancel` alone (the permission prompt) is NOT a dialog end.
/** The footer of a question step; group 1 is the navigation hint (up/down arrows for one tab, `Tab/Arrow keys` for several). */
export const ASK_FOOTER = /^(?:-- INSERT -- \u00b7 )?Enter to select \u00b7 (\u2191\/\u2193|Tab\/Arrow keys) to navigate(?: \u00b7 ctrl\+g to edit in [^\u00b7]+)?(?: \u00b7 Esc to cancel)?$/;
/** The footer of a plan approval: the editor hint and the plan file's path (the path is never read). */
export const PLAN_FOOTER = /^ctrl\+g to edit in [^\u00b7]+ \u00b7 .+$/;
/** The last row of the review step (`2. Cancel`, with or without the pointer). */
export const REVIEW_END = /^(?:\u276f )?2\. Cancel$/;
const plain = (text) => (typeof text === 'string' ? text.replace(/\u00a0/g, ' ').trim() : '');
/** True when the text is the last row of a question step, of the review step or of a plan approval. */
export const isDialogEnd = (text) => { const t = plain(text); return ASK_FOOTER.test(t) || REVIEW_END.test(t) || PLAN_FOOTER.test(t); };

// A rule row of Claude's input box (trimmed): two or more box-drawing dashes, plain, or labelled with the session name
// (`-n <name>` or /rename), which Claude draws into the upper rule as `--- <name> -` (claude-tui.md section 5). The label is
// 1 to 80 characters, has no dash, no control character and no space at either end. The box is what lies between the last two.
export const RULE_ROW = /^\u2500{2,}(?: [^\u2500\p{Cc}\s](?:[^\u2500\p{Cc}]{0,78}[^\u2500\p{Cc}\s])? \u2500+)?$/u;

// The auto-mode nudge (spike W1-T0b 3.10): a dialog that takes digits, whose footer is NOT the last row (the input box and its mode line
// are drawn under it). Without this the screen reads as an idle one with a plain box. footerEnd makes its footer the last row, so every
// reader of "the footer" (the mode, the input box, a permission prompt) fails closed on it. Both rows are matched whole, title first.
const NUDGE_TITLE = /^Teach auto mode about your environment\?$/;
const NUDGE_FOOTER = /^Enter to confirm \u00b7 Esc to cancel$/;
const NUDGE_SPAN = 8; // title to footer: at most this many non-blank rows apart
// A user status line (free content, claude-tui.md section 1) may sit between the box's lower rule and the mode line.
// shortcut: at most STATUS_ROWS such rows are skipped; a taller status line leaves a real nudge unrecognised. Upgrade when one is seen.
const STATUS_ROWS = 3;
const skipBlank = (texts, x) => { let at = x; while (at >= 0 && plain(texts[at]) === '') at -= 1; return at; }; // the non-blank row at or above x, else -1
const isRule = (texts, x) => typeof texts[x] === 'string' && RULE_ROW.test(texts[x].trimEnd()); // column 0 only: a draft line of dashes has two spaces before it
/**
 * Index of the nudge's footer row, else -1. The anchor is exact: from the screen's last row (`end`, default the row footerEnd finds
 * after its subagent cut), which must be a mode line, walk up over a status line if any (at most STATUS_ROWS rows) and the input box
 * (RULE_ROW, the box rows, RULE_ROW); the next non-blank
 * row above is the footer, with the title within NUDGE_SPAN non-blank rows above it. The two rows anywhere else (quoted in a message,
 * in a Bash preview, above a prompt or another dialog) are no nudge, so nothing is cut.
 */
export function nudgeFooterAt(texts, end = treeEnd(texts)) {
  let x = skipBlank(texts, Math.min(end, texts.length - 1));
  if (x < 0 || !isModeLine(texts[x])) return -1;
  x = skipBlank(texts, x - 1);
  for (let free = 0; x >= 0 && !isRule(texts, x) && free < STATUS_ROWS; free += 1) x = skipBlank(texts, x - 1); // the status line, if any
  if (!isRule(texts, x)) return -1;
  do x -= 1; while (x >= 0 && !isRule(texts, x)); // the box rows, up to the top rule
  if (x < 0) return -1;
  const foot = skipBlank(texts, x - 1);
  if (foot < 0 || !NUDGE_FOOTER.test(plain(texts[foot]))) return -1;
  let t = skipBlank(texts, foot - 1);
  for (let seen = 0; t >= 0 && seen < NUDGE_SPAN; seen += 1, t = skipBlank(texts, t - 1)) if (NUDGE_TITLE.test(plain(texts[t]))) return foot;
  return -1;
}

/** Index of the last row of `texts` that is not a subagent list hanging under a mode line or a dialog end, else the last row (see footerEnd). */
function treeEnd(texts) {
  let at = texts.length - 1;
  while (at >= 0 && !texts[at].trim()) at -= 1;
  if (at >= 0 && MORE_ROW.test(texts[at])) at -= 1;
  let agents = 0;
  while (at >= 0 && AGENT_ROW.test(texts[at])) { at -= 1; agents += 1; }
  const footer = at - 2;
  const ok = agents > 0 && at >= 2 && MAIN_ROW.test(texts[at]) && texts[at - 1].trim() === '' && (isModeLine(texts[footer]) || isDialogEnd(texts[footer]));
  return ok ? footer : texts.length - 1;
}

/**
 * Index of the last row of `texts` that is not a subagent list hanging under a mode line, else the last row. The list is cut only
 * when it is exactly the captured block (MAIN_ROW after exactly one blank row, then agent rows only, then at most one overflow row)
 * AND the row above the blank row is a mode line or the last row of a dialog (isDialogEnd): anything else below the footer (junk,
 * a dialog, a changed layout) stays, so the footer reads `unknown` (fail closed). A mode line cannot be forged by a label: labels
 * live in agent rows only. The auto-mode nudge (nudgeFooterAt, an exact anchor) makes its own footer the last row, what hangs under it is cut.
 */
export function footerEnd(texts) {
  const end = treeEnd(texts);
  const nudge = nudgeFooterAt(texts, end);
  return nudge >= 0 ? nudge : end;
}

/**
 * True when the text mentions bypass. Letters only, after NFKC, lower-cased: case, width, spacing, punctuation and
 * invisible characters cannot hide the word. Shared by the answer route and the keys route guard.
 */
export const mentionsBypass = (text) => text.normalize('NFKC').replace(/[^\p{L}]/gu, '').toLowerCase().includes('bypass');

/** The text of one mirror row: its spans concatenated. */
export function rowText(row) {
  return Array.isArray(row) ? row.map((sp) => (typeof sp?.t === 'string' ? sp.t : '')).join('') : '';
}

/**
 * Texts of the last n non-blank rows, oldest first; empty unless n is a positive integer. A subagent list under the footer (see
 * footerEnd) is not counted: the footer is the last row, as everywhere nika reads "the footer" (the mode, the INSERT prefix, the
 * `! for shell mode` line, the history hint).
 */
export function lastNonBlank(rows, n) {
  if (!Array.isArray(rows) || !Number.isInteger(n) || n < 1) return [];
  const texts = rows.map(rowText);
  return texts.slice(0, footerEnd(texts) + 1).filter((t) => t.trim()).slice(-n);
}

// Claude's feedback survey takes the digits 0-3 as its answer, and a consent question after it takes 1-3: a draft that starts with a
// digit must never be typed while one shows. The first pattern is the captured row (spike S15); the other questions are strings of the
// 2.1.325 binary whose layout was not captured, so they match on the question's start only. Whole rows, so prose that quotes them does not.
const SURVEY_QUESTION = /^\s*(?:\u25cf\s+)?(?:How is Claude doing this session\?(?:\s+\(optional\))?\s*$|How well is Claude following the instructions\b|How was Claude['\u2019]s recollection\b|Can Anthropic look at your session transcript\b)/;
const SURVEY_OPTIONS = /^\s*1: \S.*\b0: Dismiss\s*$/;
/** True when a row of the screen is a feedback survey question or its options row (any row: the survey's place was not captured). */
export const surveyShown = (rows) => Array.isArray(rows) && rows.some((row) => { const t = rowText(row); return SURVEY_QUESTION.test(t) || SURVEY_OPTIONS.test(t); });

// Claude's scrolled-up pill (spike S5, Claude Code 2.1.325): `Jump to bottom: fn+<down arrow> to scroll`, or `Jump to bottom (click) <down arrow>`
// with tmux `mouse on`. Only the words are matched; the style is checked on the span that holds the `J`.
const PILL = /^\s*Jump to bottom\b/;
const PILL_WORDS = 'Jump to bottom'.length;
const PILL_FG = 231;
const PILL_BG = 237;

/**
 * True when a row of the screen is Claude's pill: its text, trimmed at the start, begins with `Jump to bottom` and the span holding
 * the `J` is fg 231 on bg 237. Any row counts (a dialog may be open while scrolled). Display only: a forged pill changes what the page
 * shows, never whether a key goes out (design W3 section 10.1). Pure row check; src/scroll.js re-exports it.
 */
export function pillShown(rows) {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    if (!Array.isArray(row)) return false;
    const hit = PILL.exec(rowText(row));
    if (hit === null) return false;
    const at = hit[0].length - PILL_WORDS; // UTF-16 offset of the `J`, spans concatenated as rowText does
    let start = 0;
    for (const sp of row) {
      const len = typeof sp?.t === 'string' ? sp.t.length : 0;
      if (at < start + len) return sp.s?.fg === PILL_FG && sp.s?.bg === PILL_BG;
      start += len;
    }
    return false;
  });
}

/** True when any of the last PROMPT_ROWS non-blank rows (the window a permission prompt sits in, and its `sig` covers) mentions bypass. Shared by the keys guard and the answer route. */
export function bypassWindow(rows) {
  if (!Array.isArray(rows)) return false;
  const texts = rows.map(rowText);
  const window = (end) => texts.slice(0, end + 1).filter((t) => t.trim()).slice(-PROMPT_ROWS).join(' ');
  // The window above the nudge's footer (what lastNonBlank reads) AND the one above the subagent cut alone: a cut may add rows to what is
  // read, never take any away (a quoted nudge pair must not hide a bypass option, W1-T1 review I1).
  return mentionsBypass(window(footerEnd(texts))) || mentionsBypass(window(treeEnd(texts)));
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
// seen (and refused) instead of being glued to the previous label as a wrapped row. Exported so that the answer route
// reads the raw option rows with the same pattern.
export const OPTION = /^\s*(?:\u276f\s*)?(\d{1,3})\.\s+(.*)$/;
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
