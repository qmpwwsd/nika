// Reads Claude Code's feedback survey from the rows of the pane mirror (0.5, F14). Pure: no I/O. The layout is the live capture of spike S-F14
// (Claude Code 2.1.325, docs/contracts/claude-tui.md section 10.11): above Claude's input box, below the transcript, three rows that matter:
//
//   (U+25CF bullet) How is Claude doing this session? (optional)           bullet at column 0, the question bold from column 2
//     1: Bad    2: Fine   3: Good   0: Dismiss                options row indented 2
//   <one row, any content: blank, the effort pill, a usage-limit or tmux notice>
//   ------------ <session name> -                             the input box's top rule
//
// A digit typed into the box answers it (Claude takes it after a pause of about 400 ms). Everything here fails closed: a survey nika does not
// read exactly is `terminal` (the page says to answer it in the terminal) and nothing is ever typed for it. Keep this file ASCII: escapes only.
import { createHash } from 'node:crypto';
import { RULE_ROW, boxInput, surveyBox } from './draft.js';
import { bypassWindow, promptFromRows, rowText, surveyShown } from './mode.js';
import { dialogOnScreen } from './dialog.js';

/**
 * How long after a rating (1 to 3) nika sends Claude no Escape. Claude shows `Feedback: <label> <middot> Esc to undo` for about 3 s after the
 * digit (S-F14: from +0.56 s to +3.4 s); an Escape in that window would undo the rating. 4 s covers it; src/session-control.js enforces it.
 */
export const SURVEY_UNDO_MS = 4000;

// The captured rows, exact: the bullet at column 0 (U+25CF), the options row indented by exactly 2 (rows are right-trimmed, no-break spaces read
// as spaces). The gaps between the four items are not read: Claude pads each item to 10 cells, and the digits are what counts.
const RATING_Q = /^\u25cf How is Claude doing this session\? \(optional\)$/;
const RATING_OPT = /^ {2}1: Bad +2: Fine +3: Good +0: Dismiss$/;
/** Rows between the options row and the box's top rule: exactly one, with any content (S-F14: 39 captures out of 39). */
const FREE_ROWS = 1;
/** The follow-up question. Not captured live (S-F14 section 5) and answered with letters (y / n / d), not digits: always the terminal's. */
const CONSENT_Q = /^\s*(?:\u25cf\s+)?Can Anthropic look at your session transcript\b/;
const OPTIONS = [{ n: 1, label: 'Bad' }, { n: 2, label: 'Fine' }, { n: 3, label: 'Good' }, { n: 0, label: 'Dismiss' }];

const terminal = (reason) => ({ state: 'terminal', reason });
const textOf = (row) => rowText(row).replace(/\u00a0/g, ' ').trimEnd();

/** src/mode.js surveyShown on row texts (already read with no-break spaces as spaces): any row that looks like a survey question or options row. */
const shown = (texts) => surveyShown(texts.map((t) => [{ t }]));

/**
 * The index of the question row and of the box's top rule when the screen shows exactly the captured rating survey once, else null: one
 * question row, the options row right below it, no other row of the screen that looks like a survey question or options row, two rule rows,
 * and exactly FREE_ROWS rows between the options row and the upper rule.
 */
function ratingRows(texts) {
  const asks = texts.flatMap((t, i) => (RATING_Q.test(t) ? [i] : []));
  if (asks.length !== 1 || !RATING_OPT.test(texts[asks[0] + 1] ?? '')) return null;
  const q = asks[0];
  if (shown(texts.filter((_, i) => i !== q && i !== q + 1))) return null;
  const rules = texts.flatMap((t, i) => (RULE_ROW.test(t) ? [i] : []));
  if (rules.length < 2) return null;
  const top = rules.at(-2);
  return top - (q + 1) === FREE_ROWS + 1 ? { q, top } : null;
}

/** 16 hex of sha256 over [question row, options row, up to 3 non-blank rows above the question], all trimmed: this occurrence of the survey. */
const sigOf = (texts, q) => createHash('sha256')
  .update(JSON.stringify([texts[q].trim(), texts[q + 1].trim(), texts.slice(0, q).filter((t) => t.trim() !== '').slice(-3).map((t) => t.trim())]))
  .digest('hex').slice(0, 16);

/**
 * What the screen of a capture `{ rows, cursor, cols }` offers of Claude's feedback survey, given how the pane's input is edited
 * (`edit`: `vim` true once the pane's mode line showed `-- INSERT --`, `insert` true while it shows it now):
 *   null                                     no survey on screen, or a permission prompt or a dialog owns the slot (their own gates hold)
 *   { state: 'ready', kind: 'rating', sig, top, options }   exactly the captured rating question: options 1 Bad, 2 Fine, 3 Good, 0 Dismiss.
 *     `top` (0.5.1, E) is the screen row of the question: display only, the page crops the terminal view there. It is not in `sig`.
 *   { state: 'terminal', reason }            a survey nika never answers, or not now: the user answers it in the terminal. In this order:
 *     consent     the transcript question shows (anywhere on the screen, also next to a rating)
 *     bypass      one of the last 15 non-blank rows mentions bypass (the same window every key guard reads)
 *     unreadable  the rows are not exactly the captured pair once, directly above the box (another question, another indent, a wrap, two pairs)
 *     input       the box is not an empty prompt box with the cursor in it (text there, a `!` box, an old history entry, no readable box)
 *     normal      vim NORMAL: a digit there is a vim command and the survey stays
 * `sig` is what the page hands back and the controller compares. Never throws.
 */
export function surveyOf(seen, edit) {
  const rows = Array.isArray(seen?.rows) ? seen.rows : [];
  const texts = rows.map(textOf);
  if (!shown(texts)) return null;
  if (promptFromRows(rows) !== null || dialogOnScreen(rows)) return null;
  if (texts.some((t) => CONSENT_Q.test(t))) return terminal('consent');
  if (bypassWindow(rows)) return terminal('bypass');
  const found = ratingRows(texts);
  if (found === null) return terminal('unreadable');
  const input = boxInput(seen);
  const box = input === null ? null : surveyBox(input.rows, input.cursor, input.cols);
  if (box === null || box.state !== 'empty' || box.mode !== 'prompt' || box.box.top !== found.top) return terminal('input');
  if (edit?.vim === true && edit?.insert !== true) return terminal('normal');
  return { state: 'ready', kind: 'rating', sig: sigOf(texts, found.q), top: found.q, options: OPTIONS.map((o) => ({ ...o })) };
}
