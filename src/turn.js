// Is a turn running in Claude's main conversation? Read from the screen, never from the registry (0.5.1, item K).
//
// Claude's registry reads `busy` while background agents run and `shell` while a background shell runs, also after the turn ended, and Claude
// still shows its prompt suggestion then and takes Tab. So "the registry is not idle" says nothing about whether a Tab is safe. What does
// is Claude's own running-turn marker (docs/contracts/claude-tui.md section 8), and only while the turn runs in main:
//   - the footer's interrupt hint: the mode line ends in a ` <middot> esc to interrupt` segment (`<mode> (shift+tab to cycle) <middot> esc to
//     interrupt`, `<mode> <middot> esc to interrupt <middot> <arrow> to manage`). It is gone while the box holds text and in vim INSERT in manual
//     mode (claude-tui.md section 8), so it is not the only marker;
//   - the spinner row above the box: one symbol, a verb ending in an ellipsis and a parenthesis whose segments include `esc to interrupt`
//     (`<spinner> Thinking<ellipsis> (12s <middot> esc to interrupt)`, `... (14s <middot> <arrow> 1.2k tokens <middot> esc to interrupt)`).
// What background work draws is NOT a running turn: `<symbol> Crunched for 3s <middot> done 4:43 PM <middot> 1 shell still running`,
// `<symbol> Waiting for 1 background agent to finish`, the footer pills (`1 shell`, `<arrow> to manage`) and the agent list under the footer.
// None of them carries the interrupt hint, and none has a parenthesis after an ellipsis.
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
const SPINNER = /^ {0,2}[\p{S}\p{P}] \S[^()]*\u2026 \(([^()]*)\)\s*$/u;

const plain = (text) => text.replace(/\u00a0/g, ' ');
/** True when one of the middle-dot separated segments of `text` is exactly the interrupt hint (a sentence that merely mentions it is not). */
const hasHint = (text) => plain(text).split('\u00b7').some((part) => part.trim() === HINT);

/** True when the mode line (the screen's footer, a subagent list under it left out) carries the interrupt hint. */
export const footerHint = (rows) => {
  const footer = lastNonBlank(rows, 1)[0];
  return typeof footer === 'string' && hasHint(footer);
};

/**
 * True when a spinner row with the interrupt hint is among the SPINNER_ROWS non-blank rows right above row `top` (the box's top rule).
 * `top` that is not a row index of `rows` finds nothing.
 */
export function spinnerAbove(rows, top) {
  if (!Array.isArray(rows) || !Number.isInteger(top) || top < 1 || top > rows.length) return false;
  const above = rows.slice(0, top).map((row) => plain(rowText(row))).filter((text) => text.trim()).slice(-SPINNER_ROWS);
  return above.some((text) => { const hit = SPINNER.exec(text); return hit !== null && hasHint(hit[1]); });
}

/** True when the screen shows a turn running in main: the footer's interrupt hint or a spinner row above the box (see above). */
export const turnRunning = (rows, top) => footerHint(rows) || spinnerAbove(rows, top);
