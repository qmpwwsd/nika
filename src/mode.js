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
// blank row, `  <U+23FA> main`, one row per agent `  <U+25EF> <type>  <text>` and, when more than five run, `  <U+2193> <n> more`. The rows are
// recognised by their fixed prefix, never by the text (the model writes it, and Claude puts an elapsed time, a status or nothing at its end).
// Columns 0-1 of `main` and of an agent row are two spaces, or, on the one row under the mouse (hover) or the one picked with the arrow
// keys, the pointer U+276F and a plain space (spike D1-S, 2.1.325: no-break space was not seen there). Picking with the keys also
// replaces the mode line with a hint, which gate 5 refuses; the overflow row never carries the pointer.
const POINTER = '\u276f';
const LIST_LEAD = `(?: {2}|${POINTER} )`;
const MAIN_ROW = new RegExp(String.raw`^${LIST_LEAD}\u23fa main\s*$`);
// An agent row is `<lead><U+25EF> <type>  <text>`: the glyph, ONE word as the type (no space in it), exactly two spaces, and at least one
// character that is not a space somewhere after them; trailing spaces are padding. What follows the two spaces is not read, so every end Claude
// has drawn is accepted without being listed: `<label>  <elapsed>[ <U+00B7> <arrow> <n> tokens]` (2.1.325), `<label>  stopped <U+00B7> <elapsed>[...]`,
// `waiting on <n> shell(s) <U+00B7> <label> <U+00B7> since <h:mm> AM|PM` (K2, 2.1.326: the label moves into the status, no elapsed time) and, K2
// note 1 (2.1.326, a pane 64 columns wide), the agent's current activity with nothing after it (a narrow pane cuts the suffix, or the row shows
// the activity). Reading only the prefix is safe because the row counts only inside the block subagentEnd anchors from the bottom of the screen:
// the last rows are agent rows, above them `<U+23FA> main`, above that one blank row, above that a mode line or a dialog end. A similar row anywhere
// else is not cut. An earlier K2 draft read the waiting and elapsed endings exactly (hour 1 to 12, a count that agrees with its word); the owner's
// live capture showed rows with no ending, so that strictness was dropped and the structural gates carry the check.
const AGENT_ROW = new RegExp(String.raw`^${LIST_LEAD}\u25ef \S+ {2}.*\S\s*$`);
const MORE_ROW = /^ {2}\u2193 \d+ more\s*$/;

// Claude's question and plan dialogs (0.5, design W1 2.2 and 2.6). Their footers anchor a dialog on the screen. They live here, not in
// src/dialog.js, because dialog.js imports this file and footerEnd needs them. A footer is matched on its trimmed text, no-break spaces read
// as spaces. `Esc to cancel` alone (the permission prompt) is NOT a dialog end.
/** The footer of a question step; group 1 is the navigation hint (up/down arrows for one tab, `Tab/Arrow keys` for several). Claude Code 2.1.328 adds, on a step with a preview
 *  (0.5.4, QP), `n to add notes` (group 2) and `Tab to switch questions` (group 3) right after the navigation hint, in that order; the editor hint and `Esc to cancel` follow them. */
export const ASK_FOOTER = /^(?:-- INSERT -- \u00b7 )?Enter to select \u00b7 (\u2191\/\u2193|Tab\/Arrow keys) to navigate(?: \u00b7 (n to add notes))?(?: \u00b7 (Tab to switch questions))?(?: \u00b7 ctrl\+g to edit in [^\u00b7\u2500-\u257f]+)?(?: \u00b7 Esc to cancel)?$/;
/** The footer of a plan approval: the editor hint and the plan file's path (the path is never read). */
export const PLAN_FOOTER = /^ctrl\+g to edit in [^\u00b7]+ \u00b7 .+$/;
/** The last row of the review step (`2. Cancel`, with or without the pointer). */
export const REVIEW_END = /^(?:\u276f )?2\. Cancel$/;
const plain = (text) => (typeof text === 'string' ? text.replace(/\u00a0/g, ' ').trim() : '');
/** True when the text is the last row of a question step, of the review step or of a plan approval. */
export const isDialogEnd = (text) => { const t = plain(text); return ASK_FOOTER.test(t) || REVIEW_END.test(t) || PLAN_FOOTER.test(t); };

/**
 * How many rows the question footer ending at texts[k] takes, else 0 (0.5.4, QP, O1). Claude wraps the footer of a step with a preview over two rows at 80 and 52 columns
 * (LC-QP), so the last row alone (`Esc to cancel`, `Tab to switch questions \u00b7 Esc to cancel`) is no footer. For n = 1 to 3: the rows k-n+1 to k are all non-blank, start
 * at column 0 (no-break spaces read as spaces), the row above the first is blank (or the first is row 0), and their texts joined with one space are ASK_FOOTER. Pure shape:
 * the reader (src/dialog.js) checks the wrap itself, since it knows the pane width and this file does not.
 */
export function askFooterRows(texts, k) {
  if (!Array.isArray(texts) || !Number.isInteger(k) || k < 0 || k >= texts.length) return 0;
  for (let n = 1; n <= 3 && k - n + 1 >= 0; n += 1) {
    const rows = texts.slice(k - n + 1, k + 1);
    if (rows.some((t) => typeof t !== 'string' || plain(t) === '' || plain(t) !== t.replace(/\u00a0/g, ' ').trimEnd())) return 0; // a blank row, or a row that does not start at column 0
    const above = k - n >= 0 ? texts[k - n] : '';
    // the row above the first is blank (a missing row above the screen's top counts as blank); with another row above, a longer footer may still start higher
    if (typeof above === 'string' && plain(above) === '' && ASK_FOOTER.test(rows.map((t) => plain(t)).join(' '))) return n;
  }
  return 0;
}
/** True when texts[k] is the last row of a question step, of the review step or of a plan approval: a footer row alone (isDialogEnd), or the last row of a wrapped question footer (askFooterRows). */
export const endsDialog = (texts, k) => Array.isArray(texts) && Number.isInteger(k) && k >= 0 && k < texts.length && (isDialogEnd(texts[k]) || askFooterRows(texts, k) > 0);

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
export function nudgeFooterAt(texts, end = blockEnd(texts)) {
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
function subagentEnd(texts) {
  let at = texts.length - 1;
  while (at >= 0 && !texts[at].trim()) at -= 1;
  if (at >= 0 && MORE_ROW.test(texts[at])) at -= 1;
  let agents = 0;
  while (at >= 0 && AGENT_ROW.test(texts[at])) { at -= 1; agents += 1; }
  const footer = at - 2;
  const ok = agents > 0 && at >= 2 && MAIN_ROW.test(texts[at]) && texts[at - 1].trim() === '' && (isModeLine(texts[footer]) || endsDialog(texts, footer))
    && texts.slice(at, at + 1 + agents).filter((t) => t.startsWith(POINTER)).length <= 1; // one pointer row at most (spike D1-S)
  return ok ? footer : texts.length - 1;
}

// Claude's task list and the rule row under a dialog (0.5, F13; spikes S-F13, Claude 2.1.325, the 2.1.319 capture of an open question dialog, and S-T326, 2.1.326).
// Claude anchors this block to the bottom of the screen, under the last row of a question, review or plan dialog or of a permission prompt:
// any number of blank rows (a taller pane has more), then ONE of
//   - a rule row alone (plain, or labelled with the session name) as the last row: the plan approval of a named session;
//   - the task block: in a named session a rule row at column 0, exactly one blank row, the block; in an unnamed one (no rule row) just
//     the block, with at least one blank row above it. With the input box shown the list sits ABOVE the box instead.
// The block has two forms, and ONE block is one form (a header of one version with an overflow row of the other is no block):
//   - Claude 2.1.325: the header `  <T> tasks (<D> done, <P> in progress, <O> open)` (the in-progress part only when P is above 0; the word is
//     "tasks" for one task too) and at most one last row of three spaces, U+2026, ` +<n> in progress, <n> pending, <n> completed` naming the
//     hidden tasks (only the parts above 0, in that order);
//   - Claude 2.1.326: the header `  <D>/<T> tasks done` followed by ` \u00b7 <P> in progress` only when P is above 0 (the word is "task" when T is 1,
//     else "tasks"; the open count is T - D - P) and at most one last row of TWO spaces, U+2026, ` +<N> task(s) (<n> in progress, <n> open, <n> done)`
//     (N is the sum of the parts, "task" only when N is 1, the parts above 0 only, in that order). Claude draws 5, 4 or 3 task rows by pane height
//     and, at 12 or 13 rows, three task rows and NO overflow row although tasks are hidden; at 10 rows or fewer the header alone.
// Both forms list one row per task `  <glyph> <label>` (U+25FC in progress, U+2714 done, U+25FB open; a label may end in U+2026, ` U+203A blocked
// by #n` or ` (@owner)`). Rows are rtrimmed and recognised by their fixed prefix, never by the label, which is model-controlled text.
const TASK_HEAD = /^ {2}(\d{1,4}) tasks \((\d{1,4}) done, (?:(\d{1,4}) in progress, )?(\d{1,4}) open\)$/; // 2.1.325
const TASK_HEAD_V2 = /^ {2}(\d{1,4})\/(\d{1,4}) (task|tasks) done(?: \u00b7 (\d{1,4}) in progress)?$/; // 2.1.326: done/total
const TASK_ROW = /^ {2}([\u25fc\u2714\u25fb]) \S.*$/;
const TASK_MORE = /^ {3}\u2026 \+(.+)$/; // 2.1.325
const TASK_MORE_V2 = /^ {2}\u2026 \+(\d{1,5}) (task|tasks) \((.+)\)$/; // 2.1.326
const MORE_PART = /^([1-9]\d{0,3}) (in progress|pending|completed|open|done)$/;
const MORE_WORDS = { 1: ['in progress', 'pending', 'completed'], 2: ['in progress', 'open', 'done'] }; // by version; one list is one version's words

/** The hidden counts [in progress, open, done] of the parts of an overflow row (each part above 0, once, in the order of `words`), else null. */
function partsOf(list, words) {
  const hidden = [0, 0, 0];
  let last = -1;
  for (const part of list.split(', ')) {
    const p = MORE_PART.exec(part);
    if (p === null) return null;
    const state = words.indexOf(p[2]); // -1 for a word of the other version: caught below, as the first part or after another one
    if (state <= last) return null;
    last = state;
    hidden[state] = Number(p[1]);
  }
  return hidden;
}

/** { v: 1 | 2, hidden: [in progress, open, done] } for an overflow row of either version, else null. */
function moreOf(text) {
  const old = TASK_MORE.exec(text);
  if (old !== null) {
    const hidden = partsOf(old[1], MORE_WORDS[1]);
    return hidden === null ? null : { v: 1, hidden };
  }
  const m = TASK_MORE_V2.exec(text);
  if (m === null) return null;
  const hidden = partsOf(m[3], MORE_WORDS[2]);
  if (hidden === null) return null;
  const sum = hidden[0] + hidden[1] + hidden[2];
  return String(sum) === m[1] && m[2] === (sum === 1 ? 'task' : 'tasks') ? { v: 2, hidden } : null;
}

/** { v: 1 | 2, total, done, doing, open } for the header of either version when its own numbers hold together, else null. */
function headOf(text) {
  const old = TASK_HEAD.exec(text);
  if (old !== null) {
    const [total, done, open] = [old[1], old[2], old[4]].map(Number);
    const doing = old[3] === undefined ? 0 : Number(old[3]);
    return (old[3] !== undefined && doing < 1) || total < 1 || total !== done + doing + open ? null : { v: 1, total, done, doing, open };
  }
  const m = TASK_HEAD_V2.exec(text);
  if (m === null) return null;
  const [done, total] = [m[1], m[2]].map(Number);
  const doing = m[4] === undefined ? 0 : Number(m[4]);
  if ((m[4] !== undefined && doing < 1) || total < 1 || m[3] !== (total === 1 ? 'task' : 'tasks') || done + doing > total) return null;
  return { v: 2, total, done, doing, open: total - done - doing };
}

/** True when texts[k] is the last row of what a task block or a lone rule row may hang under: a dialog end, or the footer of a permission prompt that parses. */
function blockAnchor(texts, k) {
  if (k < 0 || typeof texts[k] !== 'string') return false;
  if (endsDialog(texts, k)) return true;
  return plain(texts[k]).startsWith('Esc to cancel') && promptOf(texts.slice(0, k + 1).filter((t) => t.trim()).slice(-PROMPT_ROWS)) !== null;
}

/**
 * Index of the header row of the task block whose last row is texts[last], else -1. Read bottom-up: at most one overflow row, the task rows,
 * the header; the header and the overflow row are of the same version. The counts must add up (headOf checks the header alone: total >= 1, and
 * for 2.1.325 total = done + in progress + open, for 2.1.326 done + in progress <= total): with an overflow row (either version) the \u25fc rows
 * plus the hidden in-progress tasks = in progress, the \u25fb rows plus the hidden open ones = open, the \u2714 rows plus the hidden done ones
 * = done; a 2.1.325 block with task rows and no overflow row adds up exactly too, a 2.1.326 one (the pane of 12 or 13 rows) when no state has
 * more rows than the header counts; a header with no row under it (a pane too short for the rows) is read on its own numbers but allows no
 * overflow row. One reader for the block under a dialog (taskEnd) and the block above the input box (taskBlockAbove).
 */
function blockHead(texts, last) {
  const text = (x) => (typeof texts[x] === 'string' ? texts[x].trimEnd() : '');
  let at = last;
  const more = moreOf(text(at));
  if (more !== null) at -= 1;
  const seen = { '\u25fc': 0, '\u2714': 0, '\u25fb': 0 };
  let rows = 0;
  const rowAt = (x) => (x >= 0 ? TASK_ROW.exec(text(x)) : null);
  for (let m = rowAt(at); m !== null; m = rowAt(at)) { seen[m[1]] += 1; rows += 1; at -= 1; }
  const head = at >= 0 ? headOf(text(at)) : null;
  if (head === null || (more !== null && (more.v !== head.v || rows === 0))) return -1;
  if (rows > 0 || more !== null) {
    const hidden = more === null ? [0, 0, 0] : more.hidden;
    const exact = more !== null || head.v === 1; // 2.1.326 without an overflow row: rows may be fewer than the header counts
    const states = [[seen['\u25fc'], hidden[0], head.doing], [seen['\u25fb'], hidden[1], head.open], [seen['\u2714'], hidden[2], head.done]];
    if (states.some(([shown, hid, counted]) => (exact ? shown + hid !== counted : shown > counted))) return -1;
  }
  return at;
}

/**
 * Index of the last row of the dialog or the permission prompt when `texts` end in what Claude draws under it (see above), else -1. Read bottom-up: a rule
 * row alone as the last non-blank row; or the block (blockHead: at most one overflow row, the task rows, the header), the blank rows (exactly one under a
 * rule row, at least one otherwise), the optional rule row, more blank rows if any, and the anchor (blockAnchor). Anything else (a second row under a task,
 * a notification row, an unknown glyph, a rule row followed by two blank rows, the block under a mode line, not at the bottom) returns -1, so nothing is
 * cut and the footer reads `unknown`.
 */
function taskEnd(texts) {
  const last = skipBlank(texts, texts.length - 1);
  if (last < 0) return -1;
  if (isRule(texts, last)) { // the lone rule row
    const k = skipBlank(texts, last - 1);
    return blockAnchor(texts, k) ? k : -1;
  }
  const at = blockHead(texts, last);
  if (at < 0) return -1;
  const above = skipBlank(texts, at - 1);
  const blanks = at - 1 - above;
  if (blanks < 1) return -1;
  if (!isRule(texts, above)) return blockAnchor(texts, above) ? above : -1; // an unnamed session
  const k = skipBlank(texts, above - 1);
  return blanks === 1 && blockAnchor(texts, k) ? k : -1; // a named one: the rule row, exactly one blank row
}

/**
 * Index of the header row of the task block Claude pins above its input box (0.5, LC18), else -1. `top` is the row of the box's top rule (a rule
 * row, isRule); right above it are exactly ONE blank row and the block, read by the same reader as the block under a dialog (blockHead: both
 * versions, the same strictness and count rules). Two blank rows, none, a row that is not part of the block, a block whose numbers do not add
 * up, a `top` that is not a rule row or lies outside `texts` give -1. Pure shape check: nothing is cut here; the page keeps the rows from the
 * header down still while the conversation above slides (public/glide.js).
 */
export function taskBlockAbove(texts, top) {
  if (!Array.isArray(texts) || !Number.isInteger(top) || !isRule(texts, top)) return -1; // isRule is false for a row outside `texts`
  if (plain(texts[top - 1]) !== '') return -1; // one blank row; with two, the row above it is blank and blockHead finds no block there
  return blockHead(texts, top - 2);
}

/**
 * Index of the last row of `texts` that is not a subagent list hanging under a mode line or a dialog end, nor the task list or the lone rule row that hangs under
 * a dialog end or a permission prompt (taskEnd), else the last row. The two are exclusive: one hanging under the other is never cut.
 */
function blockEnd(texts) {
  const agents = subagentEnd(texts);
  if (agents !== texts.length - 1) return agents;
  const tasks = taskEnd(texts);
  return tasks >= 0 ? tasks : agents;
}

/**
 * Index of the last row of `texts` that is not a subagent list hanging under a mode line, else the last row. The list is cut only
 * when it is exactly the captured block (MAIN_ROW after exactly one blank row, then agent rows only, then at most one overflow row)
 * AND the row above the blank row is a mode line or the last row of a dialog (isDialogEnd): anything else below the footer (junk,
 * a dialog, a changed layout) stays, so the footer reads `unknown` (fail closed). A mode line cannot be forged by a label: labels
 * live in agent rows only. `main` and the agent rows may start with Claude's hover pointer instead of two spaces, on one row at most
 * (spike D1-S). Claude's task list, or a rule row alone, under the last row of a dialog or of a permission prompt (taskEnd, 0.5 F13) is cut the
 * same way, only when it is exactly one of the captured shapes, never under a mode line. The auto-mode nudge (nudgeFooterAt, an exact anchor) makes
 * its own footer the last row, what hangs under it is cut.
 */
export function footerEnd(texts) {
  const end = blockEnd(texts);
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
 * Texts of the last n non-blank rows, oldest first; empty unless n is a positive integer. A subagent list or a task list under the footer (see
 * footerEnd) is not counted: the footer is the last row, as everywhere nika reads "the footer" (the mode, the INSERT prefix, the
 * `! for shell mode` line, the history hint).
 */
export function lastNonBlank(rows, n) {
  return nonBlankAt(rows, n).texts;
}

/**
 * The last n non-blank rows, as lastNonBlank selects them, with the screen row index of each: `{ texts, at }`, oldest first, `at[i]` the index in
 * `rows` of `texts[i]`. Empty unless n is a positive integer. One selection for the texts and for their places (promptTopRow).
 */
function nonBlankAt(rows, n) {
  if (!Array.isArray(rows) || !Number.isInteger(n) || n < 1) return { texts: [], at: [] };
  const texts = rows.map(rowText);
  const end = footerEnd(texts);
  const at = [];
  for (let x = 0; x <= end && x < texts.length; x += 1) if (texts[x].trim()) at.push(x);
  const kept = at.slice(-n);
  return { texts: kept.map((x) => texts[x]), at: kept };
}

// Claude's feedback survey takes the digits 0-3 as its answer, and a consent question after it takes 1-3: a draft that starts with a
// digit must never be typed while one shows. The first pattern is the captured row (spike S15); the other questions are strings of the
// 2.1.325 binary whose layout was not captured, so they match on the question's start only. Whole rows, so prose that quotes them does not.
const SURVEY_QUESTION = /^\s*(?:\u25cf\s+)?(?:How is Claude doing this session\?(?:\s+\(optional\))?\s*$|How well is Claude following the instructions\b|How was Claude['\u2019]s recollection\b|Can Anthropic look at your session transcript\b)/;
const SURVEY_OPTIONS = /^\s*1: \S.*\b0: Dismiss\s*$/;
/** True when a row of the screen is a feedback survey question or its options row (any row: the survey's place was not captured). */
export const surveyShown = (rows) => Array.isArray(rows) && rows.some((row) => { const t = rowText(row); return SURVEY_QUESTION.test(t) || SURVEY_OPTIONS.test(t); });

// After a rating (1 to 3) Claude draws, for a few seconds (S-F14: from about +3.65 s to +6.5 s after the digit), `Thanks for the feedback!` and under it the row `(Optional) Press [1] to tell us more <middot> /feedback`;
// a `1` there opens /feedback (spike S-F14 section 4, 10 of 10 captures, both rows at column 0). It is NOT a survey: nothing in it can be answered by nika, so
// src/survey.js never reads it and the capture's `survey` stays null. Only the start of the row is matched (the row wraps in a narrow pane, and the words that
// follow are not needed), as a whole row: prose that quotes it mid-line does not match. The `Thanks` row is not matched: it always comes with this row,
// and alone a model's own line `Thanks for the feedback!` would hold the draft sync for as long as it stays on screen.
// Column 0 only, as captured (spike S-F14 section 4, 10 of 10): Claude indents its own reply rows, so a reply that quotes the row never matches (RR05 N1).
const FOLLOW_UP = /^\(Optional\) Press \[1\] to tell us more\b/;
/** True when a row of the screen is Claude's post-rating row `(Optional) Press [1] to tell us more` (any row: its place was not pinned down). */
export const followUpShown = (rows) => Array.isArray(rows) && rows.some((row) => FOLLOW_UP.test(rowText(row)));
/**
 * True while a digit typed into the input box could answer something of Claude's feedback flow: the survey's own rows (surveyShown) or the
 * post-rating row (followUpShown). The draft box, Send's typing and the dialog reader treat both as "no box now": nika types nothing.
 * src/survey.js uses surveyShown alone, so the follow-up row never becomes a survey panel.
 */
export const surveyOrFollowUpShown = (rows) => surveyShown(rows) || followUpShown(rows);

// Claude's scrolled-up pill (spike S5, W3-T2b; Claude Code 2.1.325): `Jump to bottom: fn+<down arrow> to scroll`, or `Jump to bottom (click)
// <down arrow>` with tmux `mouse on`; once new output arrives while scrolled, `1 new message: fn+<down arrow> to scroll`, `2 new messages: ...`.
// All of them are drawn over the last transcript row, to the right of whatever that row holds, in one span of fg 231 on bg 237 that starts at
// a pad space before the words. Only the words are matched, anywhere in a row; the style is checked on the span that holds the first
// character of the occurrence (the divider rule `--- 1 new message ---` that Claude draws at the first unseen message is fg 246, so it never counts).
// shortcut: counts above 999 are not matched, nor are words split across a row break; a pill that wide or that wrapped has not been seen.
const PILL = /\b(?:Jump to bottom|[1-9]\d{0,2} new messages?)\b/g;
const PILL_FG = 231;
const PILL_BG = 237;

/**
 * True when a row of the screen holds Claude's pill: `Jump to bottom` or `N new message(s)` (N 1 to 999) anywhere in the row's text, and
 * the span holding the first character of that occurrence is fg 231 on bg 237 (any one occurrence in the row will do). Any row counts (a
 * dialog may be open while scrolled). Display only: a forged pill changes what the page shows, never whether a key goes out (design W3
 * section 10.1). Pure row check; src/scroll.js re-exports it.
 */
export function pillShown(rows) {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => Array.isArray(row) && [...rowText(row).matchAll(PILL)].some(({ index }) => {
    let start = 0; // UTF-16 offset of the span, spans concatenated as rowText does
    for (const sp of row) {
      const len = typeof sp?.t === 'string' ? sp.t.length : 0;
      if (index < start + len) return sp.s?.fg === PILL_FG && sp.s?.bg === PILL_BG;
      start += len;
    }
    return false;
  }));
}

/** True when any of the last PROMPT_ROWS non-blank rows (the window a permission prompt sits in, and its `sig` covers) mentions bypass. Shared by the keys guard and the answer route. */
export function bypassWindow(rows) {
  if (!Array.isArray(rows)) return false;
  const texts = rows.map(rowText);
  const window = (end) => texts.slice(0, end + 1).filter((t) => t.trim()).slice(-PROMPT_ROWS).join(' ');
  // The window above the nudge's footer (what lastNonBlank reads), the one above the subagent or task cut alone, AND the literal bottom of the
  // screen: no cut of any kind may shrink what the guard reads (a quoted nudge pair, a subagent label or a task label must not hide a bypass option,
  // W1-T1 review I1 and N1; project rule 12: the last 15 non-blank rows of the screen).
  return [footerEnd(texts), blockEnd(texts), texts.length - 1].some((end) => mentionsBypass(window(end)));
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
export const promptFromRows = (rows) => promptOf(lastNonBlank(rows, PROMPT_ROWS));

/**
 * The screen row (an index into `rows`) of the permission prompt's question, the row directly above option `1.` that promptFromRows reads as its
 * `question`, or null when no prompt parses (0.5.1, E). Display only: the page crops the terminal view there while nika shows its own prompt panel.
 * It is never part of a sig, an identity or a guard, and no route reads it back. Same window and same cuts as promptFromRows (nonBlankAt).
 */
export function promptTopRow(rows) {
  const { texts, at } = nonBlankAt(rows, PROMPT_ROWS);
  const parts = promptParts(texts);
  return parts === null ? null : at[parts.first - 1];
}

/** The permission prompt in `win`, the last PROMPT_ROWS non-blank rows ending at its `Esc to cancel` row (see promptFromRows), or null. */
function promptOf(win) {
  const parts = promptParts(win);
  return parts === null ? null : { question: parts.question, options: parts.options };
}

/** promptOf plus `first`, the index in `win` of option 1 (the question is the row above it). */
function promptParts(win) {
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
  return { question: clean(question, 200), options, first };
}
