// Is a turn running in Claude's main conversation? Read from the screen, never from the registry (0.5.1, item K).
//
// Claude's registry reads `busy` while background agents run and `shell` while a background shell runs, also after the turn ended, and Claude
// still shows its prompt suggestion then and takes Tab. So "the registry is not idle" says nothing about whether a Tab is safe. What does
// is Claude's own running-turn marker (docs/contracts/claude-tui.md section 8), and only while the turn runs in main:
//   - the footer's interrupt hint: the mode line ends in a ` <middot> esc to interrupt` segment (`<mode> (shift+tab to cycle) <middot> esc to
//     interrupt`, `<mode> <middot> esc to interrupt <middot> <arrow> to manage`). It is gone while the box holds text and in vim INSERT in manual
//     mode (claude-tui.md section 8), so it is not the only marker;
//   - the spinner row above the box: one symbol, a verb ending in an ellipsis and a parenthesis. Either its segments include `esc to interrupt`
//     (`<spinner> Thinking<ellipsis> (12s <middot> esc to interrupt)`, `... (14s <middot> <arrow> 1.2k tokens <middot> esc to interrupt)`), or
//     (K-vim, Claude 2.1.326) it has no hint at all and one of Claude's own spinner glyphs leads a capitalised verb
//     (`<spinner> Kneading<ellipsis> (35m 42s <middot> <arrow> 103.3k tokens)`, `... Imagining<ellipsis> (11m 41s <middot> thinking with xhigh effort)`):
//     the live spinner draws no hint in its parenthesis, and in vim INSERT the footer never carries one either, so without this path a running
//     turn would read as idle for the owner's vim setup.
// What background work draws is NOT a running turn: `<symbol> Crunched for 3s <middot> done 4:43 PM <middot> 1 shell still running`,
// `<symbol> Waiting for 1 background agent to finish`, the footer pills (`1 shell`, `<arrow> to manage`) and the agent list under the footer.
// None of them carries the interrupt hint, and none is a spinner glyph with a verb, an ellipsis and a parenthesis (a finished line is past
// tense, `<symbol> Worked for 8m 9s <middot> done 4:21 PM`; an agent row leads with its own glyph; the assistant's text leads with its bullet).
//
// Fail-closed: a wrong "running" only refuses a Tab (409 busy, nothing sent); a wrong "not running" is what the screen checks around the
// call (empty box, the exact suggestion, the cursor in the box, no prompt or dialog) still guard.
// shortcut: the spinner row is found in the SPINNER_ROWS non-blank rows right above the box's top rule (a task list, a queued message and a
// tip row can sit between), and only whole in one row: a pane so narrow that the row wraps loses the spinner marker (the footer's hint is
// still read). Upgrade when a wrapped spinner row is seen.
import { lastNonBlank, rowText } from './mode.js';

const HINT = 'esc to interrupt';
const SPINNER_ROWS = 12;
// One symbol (Claude draws a rotating glyph), a space, a verb run that ends in an ellipsis, a space and one parenthesis to the end of the row.
// Group 1 is the symbol, group 2 the first letter of the verb run, group 3 the parenthesis.
const SPINNER = /^ {0,2}([\p{S}\p{P}]) (\S)[^()]*\u2026 \(([^()]*)\)\s*$/u;
// The glyphs Claude's own spinner cycles through (middle dot, asterisk, and four star shapes). Without the interrupt hint a row counts only with one of
// them and a capital letter after it, so a bullet, an agent row's circle or a list item that happens to end in an ellipsis and a parenthesis does not.
const SPINNER_GLYPHS = new Set(['\u00b7', '*', '\u2722', '\u2733', '\u2736', '\u273b', '\u273d']);

const plain = (text) => text.replace(/\u00a0/g, ' ');
/** True when one of the middle-dot separated segments of `text` is exactly the interrupt hint (a sentence that merely mentions it is not). */
const hasHint = (text) => plain(text).split('\u00b7').some((part) => part.trim() === HINT);

/** True when the mode line (the screen's footer, a subagent list under it left out) carries the interrupt hint. */
export const footerHint = (rows) => {
  const footer = lastNonBlank(rows, 1)[0];
  return typeof footer === 'string' && hasHint(footer);
};

/**
 * True when a spinner row is among the SPINNER_ROWS non-blank rows right above row `top` (the box's top rule): one with the interrupt hint in its
 * parenthesis, or one of Claude's spinner glyphs with a capitalised verb, an ellipsis and a parenthesis that has no hint (K-vim, see above).
 * `top` that is not a row index of `rows` finds nothing.
 */
export function spinnerAbove(rows, top) {
  if (!Array.isArray(rows) || !Number.isInteger(top) || top < 1 || top > rows.length) return false;
  const above = rows.slice(0, top).map((row) => plain(rowText(row))).filter((text) => text.trim()).slice(-SPINNER_ROWS);
  return above.some((text) => {
    const hit = SPINNER.exec(text);
    return hit !== null && (hasHint(hit[3]) || (SPINNER_GLYPHS.has(hit[1]) && /^\p{Lu}$/u.test(hit[2])));
  });
}

/** True when the screen shows a turn running in main: the footer's interrupt hint or a spinner row above the box (see above). */
export const turnRunning = (rows, top) => footerHint(rows) || spinnerAbove(rows, top);
