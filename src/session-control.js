// Nine controls on a live Claude pane (api-app.md section 3): switch the permission mode, End the session, run a slash
// command, answer a permission prompt, write the draft, accept Claude's prompt suggestion (0.5), answer Claude's question and plan
// dialogs (0.5, W1, answerDialog), press Send's Enter (0.5, W13, submit) and answer Claude's feedback survey with one digit (0.5, F14, answerSurvey). They type into a real agent session, so every path fails
// closed: when the screen or the registry state is not exactly what the step needs, nothing is sent and the answer is a 409.
// Keys go only through `keys.send` (src/keys.js: fixed argv, KEY_NAME allow-list, rate limit); this module never kills a pane
// and never signals a process. End and the commands type only into an empty input box and press Enter only after the box reads
// exactly what nika typed (claude-tui.md section 5), so a user's draft is never sent, extended or cleared by them. The draft
// route (writeDraft) is the one place that changes a draft, and it never presses Enter; acceptSuggestion presses only Tab; submit
// presses only Enter, the one Enter of the page's Send; answerSurvey types one digit and never presses a key.
// The input box is read by src/draft.js.
import { createHash } from 'node:crypto';
import { CLAUDE_COMMAND } from './ids.js';
import { clean } from './text.js';
import { MODE_TARGETS, OPTION, PROMPT_ROWS, bypassWindow, lastNonBlank, mentionsBypass, modeFromRows, promptFromRows, rowText } from './mode.js';
import { RULE_ROW, SIG, parseDraft, boxSquash, boxInput, normDraft, sameDraft, inEnvelope, chunks, CHUNK_GAP_MS } from './draft.js';
import { TEXT_MAX, STEPS_MAX, PLAIN_TEXT, PLAN_PICK, dialogOnScreen, readDialogScreen, identityOf, sigOf, otherAllowed } from './dialog.js';
import { surveyOf, SURVEY_UNDO_MS } from './survey.js';
import { turnRunning } from './turn.js';

const EXIT_POLL_MS = 500;
const LOCK_POLL_MS = 20; // withPaneLock: poll step and the longest wait (5 s) for a running control action
const LOCK_WAIT_MS = 5000;
const PROMPT_CHAR = '❯';
// Claude draws a no-break space after the prompt character (claude-tui.md section 5): for comparing, it is a space.
const plain = (text) => text.replace(/\xa0/g, ' ');
const INSERT_PREFIX = /^\s{0,2}-- INSERT --/;
const CLEAN_ROUNDS = 6; // C-u clears one visual row, so a wrapped line takes one round per row
const BYPASS_RETRY_MS = 1000; // wait before the one retry of a press out of bypass that was rate limited
// The hint row of Claude's history search, which `/` opens in vim normal mode (claude-tui.md section 5, Claude Code 2.1.319).
// It sits at the bottom of that screen, so only the last rows are read: older output cannot pose as it.
const HISTORY_HINT = 'Esc i / for slash commands';
// Draft route (design W5 section 3): the largest text it takes, the control characters it allows, and the timings of the
// clear sequences (spike S9: after Escape in vim a key needs at least 40 ms, plain mode wants two Escapes at least 60 ms apart).
const DRAFT_MAX_CHARS = 1024;
const DRAFT_MAX_NEWLINES = 12;
const DRAFT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/; // C0, DEL, C1, except \t and \n
const DRAFT_BASE = /^(?:[0-9a-f]{16})?$/;
const SUGGESTION_MAX = 200; // src/draft.js cuts a suggestion to this
const SUGGESTION_CONTROL = /[\u0000-\u001f\u007f-\u009f]/; // a suggestion is one clean() line: no control at all
const VIM_ESC_GAP_MS = 40;
const VIM_CLEAR_MS = 400; // wait for INSERT to go after Escape, and for the empty INSERT box after `ggdG` + `i`
const PLAIN_CLEAR_MS = 600; // wait for the empty box after the second Escape
const EMPTY = ['', '!']; // an empty box in the page's form: prompt glyph, `!` glyph
// The C-u road (design W13 section 1): End and C-u never interrupt a turn (spike W13), so they clear the box while Claude works. One key per
// request, at least KEY_GAP_MS apart (20 requests a second per pane is the keys limit), each waiting up to CLEAR_WAIT_MS for the redraw.
const KEY_GAP_MS = 60;
const CLEAR_WAIT_MS = 400;
// Submit (design W13 section 2): after the Enter, the box is read every SUBMIT_POLL_MS for SUBMIT_READ_MS to see whether Claude took it.
const SUBMIT_POLL_MS = 50;
const SUBMIT_READ_MS = 1000;
// Survey (0.5, F14): after the digit the screen is read back for at most this long (Claude acts after a 400 ms pause, S-F14).
const SURVEY_READ_MS = 1000;

const conflict = (error) => ({ status: 409, body: { error } });
const invalid = (message) => ({ status: 400, body: { error: 'invalid', message } });
// `reason: 'keys'` marks a sequence that stopped on a failed key send while the pane still runs claude: a plain retry may work
const ended = (value, reason) => ({ status: 200, body: value || !reason ? { ended: value } : { ended: false, reason } });
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Number of waits of `stepMs` that cover `totalMs` (at least one): every wait loop is bounded by this count, never by a clock. */
const steps = (totalMs, stepMs) => Math.max(1, Math.ceil(totalMs / stepMs));
/** A registry state that means a turn is running or waiting: any non-empty string but `idle` (null and undefined are no state at all). */
const isBusy = (state) => typeof state === 'string' && state !== '' && state !== 'idle';
const historyShown = (rows) => lastNonBlank(rows, 3).some((t) => plain(t).includes(HISTORY_HINT));

/** The prompt's identity: 16 hex chars of sha256 over the rows promptFromRows reads. Capture publishes it, answer checks it. */
export function promptSig(rows) {
  return createHash('sha256').update(lastNonBlank(rows, PROMPT_ROWS).join('\n')).digest('hex').slice(0, 16);
}

/** The row indexes of every rule row of the screen. */
const ruleRows = (rows) => (Array.isArray(rows) ? rows : []).flatMap((row, i) => (RULE_ROW.test(rowText(row).trimEnd()) ? [i] : []));

/** The rows (span lists, styles kept) between the last two rule rows (the input box), or null when the screen has fewer than two. */
function inputBox(rows) {
  const rules = ruleRows(rows);
  return rules.length < 2 ? null : rows.slice(rules.at(-2) + 1, rules.at(-1));
}

// boxInput (the one preparation of a capture for the box readers) lives in src/draft.js since 0.5, F14, where src/survey.js needs it too; it is
// re-exported here because the attachment send and the tests import it from the controller.
export { boxInput };

/**
 * The input box (src/draft.js) of a capture `{ rows, cursor, cols }`: a Draft, or null when the screen has no plain box (see boxInput
 * for the cursor and no-break space rules). The live reader (the capture route, the write checks, End and the commands) needs the
 * cursor (N-1); tmux always reports one, so this fails closed only; parseDraft alone, given no cursor, still reads as before.
 */
export function readDraft(seen) {
  const input = boxInput(seen);
  return input === null ? null : parseDraft(input.rows, input.cursor, input.cols);
}
const draftOf = readDraft;
/** The box of a capture with its whitespace-blind text (src/draft.js boxSquash, the attachment send's reader): { draft, squash, ghost } or null. */
function boxOf(seen) {
  const input = boxInput(seen);
  return input === null ? null : boxSquash(input.rows, input.cursor, input.cols);
}
/** Whether the capture's cursor sits on a row between the two rules of the box that was read: the input is where the box is. */
const cursorInBox = (seen, draft) => Number.isInteger(seen.cursor?.y) && seen.cursor.y > draft.box.top && seen.cursor.y < draft.box.bottom;
/** Whether the capture shows the input box's two rule rows and its cursor (integer x and y) below the bottom one: Claude's focus is not in the box (the shells pill or an agent list under it). */
const cursorBelowBox = (seen) => {
  const rules = ruleRows(seen.rows);
  return rules.length >= 2 && Number.isInteger(seen.cursor?.x) && Number.isInteger(seen.cursor?.y) && seen.cursor.y > rules.at(-1);
};
/** The draft as the screen holds it, in the form the page sends: a `!` box reads `!` + its text (Shell mode). */
const canonOf = (draft) => (draft.mode === 'bash' ? `!${draft.text}` : draft.text);

/**
 * Claude's current way of editing the input, from the rows and the pane's memory: `insert` (vim, `-- INSERT --` shown),
 * `normal` (INSERT seen on this pane before), `plain` (a probe `i` landed as text before), else `unknown`: plain mode and
 * vim normal mode draw the same screen (spike S9).
 */
export const editMode = (rows, vim, plain) => (insertShown(rows) ? 'insert' : vim ? 'normal' : plain ? 'plain' : 'unknown');

/** An empty box in prompt mode (an empty `!` box is not one: End and the commands never type into it). */
function emptyBox(seen) {
  const draft = draftOf(seen);
  return draft !== null && draft.state === 'empty' && draft.mode === 'prompt';
}

/**
 * Exactly one box row in prompt mode, readable, holding exactly `text` (trailing spaces and tabs as normDraft sees them) and no ghost
 * text: End and the commands press Enter after this read, and what Enter does with a ghost completion is untested (M-4).
 */
function readsAs(seen, text) {
  const draft = draftOf(seen);
  return draft !== null && draft.state !== 'unreadable' && draft.mode === 'prompt' && draft.ghost !== true && draft.box.bottom - draft.box.top === 2 && sameDraft(draft.text, text);
}

/**
 * One input row, for isRemnant only (the box itself is read by src/draft.js): after the optional indent it starts with the
 * prompt character. Returns whether exactly one space (no-break spaces count as spaces) follows it (`spaced`) and the text
 * after the prompt character with the surrounding spaces trimmed. Null when the row is not an input row.
 */
function inputRow(row) {
  const chars = [];
  for (const sp of Array.isArray(row) ? row : []) for (const ch of typeof sp?.t === 'string' ? sp.t : '') chars.push(plain(ch));
  let at = 0;
  while (chars[at] === ' ') at += 1;
  if (chars[at] !== PROMPT_CHAR) return null;
  const rest = chars.slice(at + 1);
  return { spaced: rest.length === 0 || rest[0] === ' ', text: rest.join('').replace(/^ +| +$/g, '') };
}

/**
 * The box holds only (the start of) what nika typed: its text with the prompt character, indents and spaces removed
 * (rows joined; a word-wrap may drop the space at the break) is a non-empty prefix of `typed` without spaces.
 */
function isRemnant(box, typed) {
  const first = inputRow(box[0]);
  if (first === null || !first.spaced) return false;
  const joined = [first.text, ...box.slice(1).map((row) => plain(rowText(row)))].join('').replace(/ /g, '');
  return joined !== '' && plain(typed).replace(/ /g, '').startsWith(joined);
}

export const insertShown = (rows) => INSERT_PREFIX.test(plain(lastNonBlank(rows, 1)[0] ?? ''));

/** The body of the draft route, `{ text, base }`: null when it is valid, else the 400 answer. The router and writeDraft both call it. */
export function checkDraftBody(body) {
  const names = body !== null && typeof body === 'object' ? Object.keys(body) : [];
  if (names.length !== 2 || !names.includes('text') || !names.includes('base')) return invalid('body must be { text, base }');
  const { text, base } = body;
  if (typeof text !== 'string' || text.length > DRAFT_MAX_CHARS) return invalid(`text must be a string of at most ${DRAFT_MAX_CHARS} characters`);
  if (DRAFT_CONTROL.test(text)) return invalid('text must not contain control characters other than newline and tab');
  if (text.split('\n').length - 1 > DRAFT_MAX_NEWLINES) return invalid(`text may hold at most ${DRAFT_MAX_NEWLINES} newlines`);
  if (typeof base !== 'string' || !DRAFT_BASE.test(base)) return invalid('base must be 16 lowercase hex characters, or empty');
  return null;
}

/** The body of the submit route, `{ base? }` (the sig the page last saw, the same shape as the draft route's `base`): null when it is valid, else the 400 answer. */
export function checkSubmitBody(body) {
  const names = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  if (names === null || names.some((n) => n !== 'base')) return invalid('body must be { base? }');
  if (names.length === 1 && !(typeof body.base === 'string' && DRAFT_BASE.test(body.base))) return invalid('base must be 16 lowercase hex characters, or empty');
  return null;
}

/** The body of the suggestion route, exactly `{ text }` (the suggestion the page shows): null when it is valid, else the 400 answer. */
export function checkSuggestionBody(body) {
  const names = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  if (names.length !== 1 || names[0] !== 'text') return invalid('body must be { text }');
  const { text } = body;
  if (typeof text !== 'string' || text === '' || text.length > SUGGESTION_MAX) return invalid(`text must be a string of 1 to ${SUGGESTION_MAX} characters`);
  if (SUGGESTION_CONTROL.test(text)) return invalid('text must not contain control characters');
  return null;
}

/** The body of the survey route, exactly `{ n, sig }` (n an integer from 0 to 3, sig 16 lowercase hex): null when it is valid, else the 400 answer. The router and answerSurvey both call it. */
export function checkSurveyBody(body) {
  const names = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join() : '';
  if (names !== 'n,sig' || !Number.isInteger(body.n) || body.n < 0 || body.n > 3 || typeof body.sig !== 'string' || !SIG.test(body.sig)) return invalid('body must be { n, sig }: n an integer from 0 to 3, sig 16 lowercase hex characters');
  return null;
}

// Dialog route (design W1 4.1): free text may hold no control, bidi or zero-width character (they are not seen on screen, so the read-back could
// not prove them) and no lone surrogate (tmux would type U+FFFD). It may not start with 1-9 either: on an EMPTY text row Claude may take that
// digit as the option shortcut (not seen live, W1-T4), which would answer a different option and leave the rest of the text in the input box.
// Any other invisible format character (\p{Cf}: U+00AD, U+2060, U+180E, U+FEFF ...) is refused anywhere, and a combining mark may not lead, so
// neither can sit in front of that digit (W1-T2 re-review, I1 residual).
const DIALOG_TEXT_REFUSED = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]|\p{Cf}|^\p{M}/u;
const DIALOG_PICKS_MAX = 7; // a digit answers without Enter, so options are numbered 1-9 and two of them are the text and chat rows
const DIALOG_SHAPES = new Map([['picks,sig', 'picks'], ['picks,sig,text', 'picks'], ['sig,submit', 'submit'], ['choice,sig', 'choice'], ['cancel,sig', 'cancel']]);
const DIALOG_BODY = 'body must be { sig, picks, text? }, { sig, submit: true }, { sig, choice } or { sig, cancel: true }';
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** The body of the dialog route: exactly one of the four shapes (see DIALOG_BODY): null when it is valid, else the 400 answer. The router and answerDialog both call it. */
export function checkDialogBody(body) {
  const names = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort().join() : '';
  const shape = DIALOG_SHAPES.get(names);
  if (shape === undefined || typeof body.sig !== 'string' || !SIG.test(body.sig)) return invalid(DIALOG_BODY);
  if (shape === 'submit' || shape === 'cancel') return body[shape] === true ? null : invalid(DIALOG_BODY);
  if (shape === 'choice') return whole(body.choice, 1, 9) ? null : invalid('choice must be an integer from 1 to 9');
  const { picks, text } = body;
  const listed = Array.isArray(picks) && picks.length <= DIALOG_PICKS_MAX && Array.from(picks, (p) => whole(p, 1, DIALOG_PICKS_MAX)).every(Boolean) && new Set(picks).size === picks.length;
  if (!listed) return invalid(`picks must be at most ${DIALOG_PICKS_MAX} distinct integers from 1 to ${DIALOG_PICKS_MAX}`);
  if (text !== undefined && !(typeof text === 'string' && text.length >= 1 && text.length <= TEXT_MAX && text.isWellFormed() && !DIALOG_TEXT_REFUSED.test(text) && text === text.trim() && !/^[1-9]/.test(text) && clean(text) !== null)) {
    return invalid(`text must be 1 to ${TEXT_MAX} characters without control characters, and must not start with a digit from 1 to 9 or start or end with a space`);
  }
  return null;
}

/** Why a valid body does not fit the dialog on screen (400 invalid), else null (design W1 4.1, after the read). */
function bodyMisfit(S, want, target) {
  if (want.cancel || want.submit) return null;
  if (want.choice !== undefined) {
    const o = S.options.find((x) => x.n === want.choice);
    if (o === undefined) return 'choice is not one of the options';
    return o.text ? "the plan's text option is answered in the terminal" : null;
  }
  const k = S.options.length;
  if (want.picks.some((p) => p > k)) return 'a pick is not one of the options';
  if (want.text !== undefined && target === null) return 'text is empty once spaces are collapsed';
  if (want.text !== undefined && !otherAllowed(S)) return 'free text is not offered on this question';
  if (!S.multi && (want.picks.length === 1) === (want.text !== undefined)) return 'a single-select question takes exactly one pick or one text';
  if (S.multi && want.picks.length === 0 && want.text === undefined) return 'pick at least one option or give text';
  return null;
}

/** `after` is `before` with exactly one `i` added somewhere: what a probe `i` that landed as text leaves in the box. */
const oneIAdded = (before, after) => after.length === before.length + 1 && [...after].some((ch, k) => ch === 'i' && after.slice(0, k) + after.slice(k + 1) === before);

/**
 * The raw rows of option n (wrapped rows included), or null. promptFromRows cuts a label at 80 characters, so a
 * `bypass` further right would go unseen there: the answer route reads the raw rows as well.
 */
function rawOption(rows, n) {
  const win = lastNonBlank(rows, PROMPT_ROWS).slice(0, -1); // without the `Esc to cancel` row
  const first = win.findLastIndex((t) => OPTION.exec(t)?.[1] === '1');
  if (first < 0) return null;
  const groups = [];
  for (const t of win.slice(first)) {
    if (OPTION.test(t)) groups.push([t]);
    else groups.at(-1).push(t);
  }
  return groups[n - 1]?.join(' ') ?? null;
}

/**
 * mirror.capture(pane, undefined, { fresh }) → { status, body: { rows, cursor, cols } }; keys.send(pane, { text?, paste?, keys? }) → { status, body };
 * paneCommand(pane) → Promise<string|null> (null = pane gone, or dead: a remain-on-exit pane keeps its command named claude); stateOf(pane) → the live session's registry state or null;
 * vimOf(pane) → boolean: this pane's mode line has shown `-- INSERT --` before (Claude's input is in vim mode);
 * plainOf(pane) → boolean (optional, default false): a probe `i` landed as text on this pane, so its input is not in vim mode;
 * setEdit(pane, 'vim' | 'plain' | 'none') (optional): the draft route reports what it learned about the pane's edit mode.
 * One control action runs per pane at a time (switch, End, command, answer and draft write share one lock). Every method returns { status, body },
 * except withPaneLock(pane, fn), the same lock for the fit controller (src/fit.js): it waits for a running action and resolves with fn's result.
 * The draft route's timings: draftPollMs (poll step while it waits for a redraw), escGapMs (plain mode: gap between its two Escapes), chunkGapMs.
 */
export function createSessionControl({
  mirror, keys: rawKeys, paneCommand, stateOf, vimOf, plainOf = () => false, setEdit = () => {}, now = Date.now, sleep = realSleep,
  pollMs = 300, settleMs = 1800, maxPresses = 6, escWaitMs = 1000, exitWaitMs = 3000, answerHoldMs = 3000,
  settleTries = 4, settlePollMs = 150, draftPollMs = 20, escGapMs = 60, chunkGapMs = CHUNK_GAP_MS,
}) {
  // Typing without knowing whether the input is in vim normal mode could send stray vim commands, so there is no default.
  if (typeof vimOf !== 'function') throw new TypeError('vimOf must be a function (pane) => boolean');
  const running = new Set(); // panes with a control action in progress
  const interrupting = new Set(); // panes whose Escape sequence is running: Stop and End share it, apart from the control lock
  const answered = new Map(); // pane → { sig, at } of the last successful answer
  const escapedAt = new Map(); // pane → now() when the last Escape of a Stop or an End went out (N-2): a key right behind it would be Meta+key

  const ratedAt = new Map(); // pane → now() when the digit of a rating (1 to 3) was sent: Claude shows `Feedback: <label> · Esc to undo` for a few seconds

  /** True while less than SURVEY_UNDO_MS has passed since a rating's digit on the pane; a clock that went back counts as passed. */
  function undoHold(pane) {
    const at = ratedAt.get(pane);
    if (at === undefined) return false;
    const passed = now() - at;
    if (passed >= 0 && passed < SURVEY_UNDO_MS) return true;
    ratedAt.delete(pane);
    return false;
  }

  // The one place a key leaves this controller. An Escape is refused (409 survey-undo, never sent) while a rating's "Esc to undo" row shows
  // (0.5, F14): Claude would undo the rating with it. Every Escape of Stop, End, a command's history search, the draft route and a dialog's
  // Decline goes through this function, so the guarantee does not depend on each caller remembering it; Stop and End also say so before they start.
  const keys = {
    send: (pane, body) => (Array.isArray(body?.keys) && body.keys.includes('Escape') && undoHold(pane) ? Promise.resolve(conflict('survey-undo')) : rawKeys.send(pane, body)),
  };

  /** True while less than VIM_ESC_GAP_MS has passed since an Escape of Stop or End on the pane (N-2); a clock that went back counts as passed. */
  function escapeGap(pane) {
    const at = escapedAt.get(pane);
    if (at === undefined) return false;
    const passed = now() - at;
    if (passed >= 0 && passed < VIM_ESC_GAP_MS) return true;
    escapedAt.delete(pane);
    return false;
  }

  /**
   * Runs `fn()` as the only control action on the pane, like `exclusive`, but WAITS for a running one instead of refusing: the fit
   * controller (src/fit.js) resizes a window under this lock. Polls every LOCK_POLL_MS through `sleep`; after LOCK_WAIT_MS of waits it
   * gives up with an Error whose code is EPANEBUSY and fn never runs. While fn runs the pane is in `running`, so every other action
   * answers 409 busy-switching. Resolves with fn's result; the pane is freed when fn throws too.
   */
  async function withPaneLock(pane, fn) {
    for (let waited = 0; running.has(pane); waited += LOCK_POLL_MS) {
      if (waited >= LOCK_WAIT_MS) throw Object.assign(new Error('another action is running on this pane'), { code: 'EPANEBUSY' });
      await sleep(LOCK_POLL_MS);
    }
    running.add(pane);
    try {
      return await fn();
    } finally {
      running.delete(pane);
    }
  }

  /** Runs `action(ctx)` as the only control action on the pane; `ctx.insert` turns true once any capture of the action shows INSERT. */
  async function exclusive(pane, action) {
    if (running.has(pane)) return conflict('busy-switching');
    running.add(pane);
    try {
      return await action({ insert: false });
    } finally {
      running.delete(pane);
    }
  }

  /** A fresh capture: { rows, cursor, cols } or { res } (the failed capture's own status and body). */
  async function look(pane, ctx) {
    const cap = await mirror.capture(pane, undefined, { fresh: true });
    if (cap.status !== 200) return { res: { status: cap.status, body: cap.body } };
    if (ctx && insertShown(cap.body.rows)) ctx.insert = true;
    return { rows: cap.body.rows, cursor: cap.body.cursor, cols: cap.body.cols };
  }

  /** Registry state; a lookup that fails reads as no live session, which is never idle. `opts` goes to stateOf (`{ fresh: true }`: skip its cache). */
  async function stateNow(pane, opts) {
    try {
      return await stateOf(pane, opts);
    } catch {
      return null;
    }
  }

  // A permission prompt, or one of Claude's dialogs (W1: a question step, its review, a plan approval, and the two shapes nika never reads):
  // every control that types or interrupts treats both the same way (a digit or Enter would answer them).
  const promptOpen = (rows) => promptFromRows(rows) !== null || dialogOnScreen(rows);

  /** A fresh capture plus the registry state: { rows, cursor, cols, state, idle } (idle = state idle and no permission prompt) or { res }. */
  async function readIdle(pane, ctx) {
    const seen = await look(pane, ctx);
    if (seen.res) return seen;
    const state = await stateNow(pane);
    return { ...seen, state, idle: state === 'idle' && !promptOpen(seen.rows) };
  }

  /** The footer is unreadable and no input box (src/draft.js) explains it: a dialog may be open. A `!` box reads unknown in modeFromRows and is not one. */
  const unknownScreen = (seen) => modeFromRows(seen.rows) === 'unknown' && draftOf(seen) === null;

  /** Step 4 of the mode route: an idle pane's fresh capture, else { res: 409 not-idle }. */
  async function idleLook(pane) {
    const seen = await readIdle(pane);
    return seen.res || seen.idle ? seen : { res: conflict('not-idle') };
  }

  /** While the footer reads bypass the next press does not wait for the registry: a fresh look, and a prompt on screen is a { res }. */
  async function bypassLook(pane) {
    const seen = await look(pane);
    return seen.res || (promptOpen(seen.rows) ? { res: conflict('prompt-open') } : seen);
  }

  /** True only when the pane is gone or no longer runs claude. A failing lookup proves nothing, so it is false. */
  async function isGone(pane) {
    try {
      const cmd = await paneCommand(pane);
      return cmd === null || (typeof cmd === 'string' && !CLAUDE_COMMAND.test(cmd.trim()));
    } catch {
      return false;
    }
  }

  /**
   * After a BTab: read the footer up to settleMs / pollMs times until it shows a mode other than `before`: { mode }. Otherwise
   * { res, mode } with what the last read showed (`before` when it never changed, else `unknown`): 409 mode-unchanged when every
   * read was readable and equal to `before` (the key did not register, or Claude redrew late), else 409 mode-unknown.
   */
  async function settle(pane, before) {
    let mode = 'unknown';
    let unchanged = true;
    for (let i = 0; i < steps(settleMs, pollMs); i += 1) {
      await sleep(pollMs);
      const seen = await look(pane);
      mode = seen.rows ? modeFromRows(seen.rows) : 'unknown'; // a failed capture reads as unknown: keep polling
      if (mode !== 'unknown' && mode !== before) return { mode };
      unchanged &&= mode === before;
    }
    return { res: conflict(unchanged && mode === before ? 'mode-unchanged' : 'mode-unknown'), mode };
  }

  /**
   * After a keystroke Claude redraws its input a few hundred ms later: up to settleTries fresh captures, `sleep(settlePollMs)`
   * before each, until `matches(rows, seen)` (`seen` = the whole capture: rows, cursor, cols). Returns { rows, last, seen,
   * lastSeen } for the first match, { res, last, lastSeen } when a capture fails, { last, lastSeen } when none matched (`last` /
   * `lastSeen` = rows / capture of the last capture that worked). `tries` and `ms` replace settleTries and settlePollMs.
   */
  async function settled(pane, matches, ctx, tries = settleTries, ms = settlePollMs) {
    let lastSeen;
    for (let i = 0; i < Math.max(1, tries); i += 1) {
      await sleep(ms);
      const seen = await look(pane, ctx);
      if (seen.res) return { res: seen.res, last: lastSeen?.rows, lastSeen };
      lastSeen = seen;
      if (matches(seen.rows, seen)) return { rows: seen.rows, last: seen.rows, seen, lastSeen };
    }
    return { last: lastSeen?.rows, lastSeen };
  }

  /**
   * Removes what nika typed once the box did not read exactly that. `C-u` clears one visual row, so: up to CLEAN_ROUNDS
   * rounds of a fresh capture; no box, or text that is not (the start of) what nika typed (a user's draft), ends it
   * without sending anything; otherwise one `C-u`. An empty box may be a late redraw, so it is read once more after
   * settlePollMs (a round takes at most two reads, so at most 2 * CLEAN_ROUNDS reads and CLEAN_ROUNDS C-u); still
   * empty ends it. A failed capture or send ends it.
   */
  async function cleanUp(pane, typed, ctx) {
    for (let round = 0; round < CLEAN_ROUNDS; round += 1) {
      if (round > 0) await sleep(settlePollMs); // let Claude redraw after the C-u
      let seen = await look(pane, ctx);
      if (seen.res) return;
      let box = inputBox(seen.rows);
      if (box !== null && emptyBox(seen)) { // maybe Claude has not redrawn yet: look once more
        await sleep(settlePollMs);
        seen = await look(pane, ctx);
        if (seen.res) return;
        box = inputBox(seen.rows);
      }
      if (box === null || box.length === 0 || emptyBox(seen) || !isRemnant(box, typed)) return;
      if ((await keys.send(pane, { keys: ['C-u'] })).status !== 200) return;
    }
  }

  /** vim normal mode: types `i` and waits for `-- INSERT --`. Null when it shows, else { failed } or { res } (a stray `i` is removed first). */
  async function enterInsert(pane, ctx) {
    const sent = await keys.send(pane, { text: 'i' });
    if (sent.status !== 200) return { failed: sent };
    const shown = await settled(pane, insertShown, ctx);
    if (shown.res) return { failed: shown.res };
    if (shown.rows) return null;
    // vim was off: the i landed as text, and it is the only thing nika typed
    if (readsAs(shown.lastSeen, 'i')) await keys.send(pane, { keys: ['C-u'] });
    return { res: conflict('mode-unknown') };
  }

  /**
   * Types `text` into Claude's input and presses Enter, for End and runCommand (claude-tui.md section 5). `first` is the
   * fresh capture the caller has already checked (idle, footer readable); `ctx.insert` says whether any capture of this
   * action showed `-- INSERT --`. The box is read by src/draft.js: one that is not found, whose first row is not a prompt
   * row, whose rule is `History n/m` (an old entry) or whose rows nika does not know (dim text next to real text included) is
   * 409 `input-unreadable`; one that holds anything but nothing or the placeholder (a `!` box, a pasted block, a tall draft,
   * trailing spaces) is 409 `input-not-empty` (a `!` box says so in its message). Returns null when Enter went out, { res } for a 409, or { failed } with the status and
   * body of the send or capture that failed. After a 409 `not-at-prompt` or a failed capture nika's own text is removed
   * as far as cleanUp can tell it apart from a draft; it may remain when a send fails, a capture fails or the box holds
   * something else. A stray `i` (vim was off) is removed with one C-u before the 409 `mode-unknown`.
   *
   * vim normal mode draws no marker, so when nothing says vim is on, a command (it starts with `/`) is probed: `/` alone
   * first. A plain input shows it, and the rest follows. In vim normal mode `/` opens a history search instead, which is
   * closed with one Escape before the usual vim road (`i`, INSERT, the whole text). Any other screen: nika's `/` is removed
   * and nothing else is sent.
   */
  async function typeCommand(pane, first, text, ctx) {
    const rows = first.rows;
    const draft = draftOf(first);
    // no box, or one nika cannot read (a menu, another screen, an old entry of the history): it cannot tell a draft from nothing, so it types nothing
    if (draft === null) return { res: conflict(inputRow(inputBox(rows)?.[0]) === null ? 'input-unreadable' : 'input-not-empty') }; // a prompt character glued to text is a row holding text
    if (draft.reason === 'history' || draft.reason === 'layout') return { res: conflict('input-unreadable') }; // an old entry shows, or rows nika does not know (dim text next to real text included)
    if (draft.mode === 'bash') return { res: { status: 409, body: { error: 'input-not-empty', message: "Claude's input is in ! mode" } } };
    if (draft.state !== 'empty') return { res: conflict('input-not-empty') }; // a draft is never sent, extended or cleared
    let rest = text; // what is still to be typed
    // vim normal mode: the keys would be vim commands. Evidence of vim: the pane's memory, or INSERT seen in this action.
    if ((await vimOf(pane)) || ctx.insert) {
      const stopped = insertShown(rows) ? null : await enterInsert(pane, ctx);
      if (stopped) return stopped;
    } else if (text.startsWith('/')) {
      const slash = await keys.send(pane, { text: '/' });
      if (slash.status !== 200) return { failed: slash };
      const probed = await settled(pane, (seen, cap) => readsAs(cap, '/') || historyShown(seen), ctx);
      if (!probed.rows) {
        await cleanUp(pane, '/', ctx);
        return probed.res ? { failed: probed.res } : { res: conflict('not-at-prompt') };
      }
      if (readsAs(probed.seen, '/')) {
        rest = text.slice(1);
      } else { // the history search: close it, then the usual vim road
        const esc = await keys.send(pane, { keys: ['Escape'] });
        if (esc.status !== 200) return { failed: esc };
        const back = await settled(pane, (seen, cap) => emptyBox(cap), ctx);
        if (back.res) return { failed: back.res };
        if (!back.rows) return { res: conflict('not-at-prompt') };
        const stopped = insertShown(back.rows) ? null : await enterInsert(pane, ctx);
        if (stopped) return stopped;
      }
    }
    if (rest !== '') {
      const sent = await keys.send(pane, { text: rest });
      if (sent.status !== 200) {
        if (rest !== text) await cleanUp(pane, '/', ctx); // the probe's slash is nika's own text
        return { failed: sent };
      }
    }
    const echoed = await settled(pane, (seen, cap) => readsAs(cap, text), ctx);
    if (!echoed.rows) {
      await cleanUp(pane, text, ctx);
      return echoed.res ? { failed: echoed.res } : { res: conflict('not-at-prompt') };
    }
    const enter = await keys.send(pane, { keys: ['Enter'] });
    return enter.status === 200 ? null : { failed: enter };
  }

  /**
   * Interrupts Claude's turn or answers a prompt with No, with as few Escapes as possible; `rows` and `state` are a fresh
   * capture and the registry state read with it. A prompt on screen: one Escape. A busy state (a non-empty string but `idle`):
   * one Escape, except in vim INSERT, where the first Escape only leaves INSERT (claude-tui.md section 5): then it waits for
   * `-- INSERT --` to go (still shown: 409 mode-unknown, no second key), reads the state again, and sends the second
   * Escape only if it is still busy. Otherwise (idle, no state, an ambiguous pane) no key at all.
   * The state read before the second Escape skips the registry cache. One interrupt per pane at a time (Stop and End share
   * the flag, apart from the control lock): a second one finds it taken and answers 409 with the caller's code (Stop `stopping`, End `not-idle`), sending nothing.
   * Returns { presses } (Escapes sent), { res } (a 409 or a failed capture) or { failed } (the send that failed).
   */
  async function interrupt(pane, rows, state, ctx, taken = 'not-idle') {
    if (interrupting.has(pane)) return { res: conflict(taken) };
    // An Escape would undo the rating Claude still shows (F14). The keys wrapper refuses it too, but End would turn that refusal into ended: false; say it plainly.
    if ((promptOpen(rows) || isBusy(state)) && undoHold(pane)) return { res: conflict('survey-undo') };
    interrupting.add(pane);
    try {
      const escape = async (n) => {
        const sent = await keys.send(pane, { keys: ['Escape'] });
        escapedAt.set(pane, now()); // also after a failed send: it may have been delivered
        return sent.status === 200 ? { presses: n } : { failed: sent };
      };
      if (promptOpen(rows)) return await escape(1);
      if (!isBusy(state)) return { presses: 0 };
      const first = await escape(1);
      if (first.failed || !insertShown(rows)) return first;
      const gone = await settled(pane, (seen) => !insertShown(seen), ctx);
      if (gone.res) return { res: gone.res };
      if (!gone.rows) return { res: conflict('mode-unknown') };
      return isBusy(await stateNow(pane, { fresh: true })) ? await escape(2) : first;
    } finally {
      interrupting.delete(pane);
    }
  }

  function switchMode(pane, target) {
    if (!MODE_TARGETS.includes(target)) return Promise.resolve(invalid(`target must be one of ${MODE_TARGETS.join(', ')}`));
    return exclusive(pane, async () => {
      let presses = 0;
      let start = null;
      let last = null; // the mode the footer showed last, or null/unknown when it showed none since the last press
      // Every failure after a press carries the press count (the route then forgets its held mode). While the footer last read
      // bypassPermissions every ending is the loud one: stopping there would leave Claude running every tool without asking.
      const fail = (res, always = false) => {
        const out = last === 'bypassPermissions' ? conflict('stopped-in-bypass') : res;
        return presses > 0 || always ? { status: out.status, body: { ...out.body, presses } } : out;
      };
      let seen = await idleLook(pane);
      for (;;) { // each round: classify what is on screen now, press once, wait for the footer to change
        if (seen.res) return fail(seen.res);
        const mode = modeFromRows(seen.rows);
        if (mode === 'unknown') return fail(conflict('mode-unknown')); // never press blind
        last = mode;
        if (mode === target) return { status: 200, body: { mode, presses } };
        if (mode === 'dontAsk') return fail(conflict('not-in-cycle')); // nika never switches to or from it
        start ??= mode;
        let sent = await keys.send(pane, { keys: ['BTab'] });
        if (sent.status === 429 && mode === 'bypassPermissions') { // the one press worth a second try: it leaves bypass
          await sleep(BYPASS_RETRY_MS);
          sent = await keys.send(pane, { keys: ['BTab'] });
        }
        if (sent.status !== 200) return fail({ status: sent.status, body: sent.body }, true);
        presses += 1;
        const next = await settle(pane, mode);
        // a footer that stays unreadable after the press that left bypass may still read bypass: keep the loud ending
        last = next.mode === 'unknown' && mode === 'bypassPermissions' ? mode : next.mode;
        if (next.res) return fail(next.res);
        if (next.mode === target) return { status: 200, body: { mode: next.mode, presses } };
        if (next.mode === start || presses >= maxPresses) return fail(conflict('not-in-cycle'));
        // the registry state is read again before every press, except in bypass: leaving it must not wait for a busy registry
        seen = next.mode === 'bypassPermissions' ? await bypassLook(pane) : await idleLook(pane);
      }
    });
  }

  function endSession(pane) {
    return exclusive(pane, async (ctx) => {
      let seen = await readIdle(pane, ctx);
      if (seen.res) return seen.res;
      if (!seen.idle) {
        const stopped = await interrupt(pane, seen.rows, seen.state, ctx); // cancels a turn or answers a prompt with No
        if (stopped.res) return stopped.res;
        if (stopped.failed) return ended(await isGone(pane), 'keys');
        if (stopped.presses === 0) return conflict('not-idle'); // no live session, or two claim the pane: nothing is sent
        await sleep(escWaitMs);
        seen = await readIdle(pane, ctx);
        if (seen.res) return seen.res;
        if (!seen.idle) return conflict('not-idle'); // End never answers a prompt
      }
      if (unknownScreen(seen)) return conflict('mode-unknown'); // a dialog may be open (a `!` box is read by typeCommand)
      const typed = await typeCommand(pane, seen, '/exit', ctx);
      if (typed?.res) return typed.res;
      if (typed?.failed) return ended(await isGone(pane), 'keys');
      for (let i = 0; i < steps(exitWaitMs, EXIT_POLL_MS); i += 1) {
        await sleep(EXIT_POLL_MS);
        if (await isGone(pane)) return ended(true);
      }
      return ended(false);
    });
  }

  /**
   * Stop (api-app.md section 3). It does not take the per-pane lock: it must work while a switch or a command waits, and it
   * sends nothing but Escape. Only a busy pane with no prompt on screen is interrupted (a prompt is answered, never Stopped).
   * A screen nika cannot read at all (no mode line and no input box: a busy turn keeps both) may hold a dialog that src/dialog.js
   * parks as unreadable ("Exit plan mode?" or a wrapped ask footer with a subagent list under it, a plan clipped above its title):
   * an Escape there would decline it, so that is a 409 too, `screen-unclear` (W1-T2 review I2; kept apart from `prompt-open` so the page
   * does not say a prompt is open when none is).
   */
  async function stop(pane) {
    const seen = await look(pane);
    if (seen.res) return seen.res;
    if (promptOpen(seen.rows)) return conflict('prompt-open');
    if (unknownScreen(seen)) return conflict('screen-unclear');
    const state = await stateNow(pane);
    if (!isBusy(state)) return conflict('not-busy');
    const stopped = await interrupt(pane, seen.rows, state, undefined, 'stopping');
    if (stopped.res) return stopped.res;
    if (stopped.failed) return { status: stopped.failed.status, body: stopped.failed.body };
    return { status: 200, body: { stopped: true, presses: stopped.presses } };
  }

  function runCommand(pane, text) {
    if (typeof text !== 'string' || text.trim() === '') return Promise.resolve(invalid('text must be a non-empty string'));
    return exclusive(pane, async (ctx) => {
      const seen = await readIdle(pane, ctx); // no Escape here: Stop is its own button
      if (seen.res) return seen.res;
      if (!seen.idle) return conflict('not-idle');
      if (unknownScreen(seen)) return conflict('mode-unknown');
      const typed = await typeCommand(pane, seen, text, ctx);
      if (typed?.res) return typed.res;
      if (typed?.failed) return { status: typed.failed.status, body: typed.failed.body };
      return { status: 200, body: { sent: true } };
    });
  }

  /** Remembers the answer just given (`answered`) and forgets the ones older than answerHoldMs. */
  function holdAnswer(pane, sig) {
    const t = now();
    for (const [k, v] of answered) if (t - v.at >= answerHoldMs) answered.delete(k);
    answered.set(pane, { sig, at: t });
  }

  function answer(pane, body) {
    const n = body?.n;
    const sig = body?.sig;
    return exclusive(pane, async () => {
      const seen = await look(pane);
      if (seen.res) return seen.res;
      const prompt = promptFromRows(seen.rows);
      if (prompt === null) return conflict('no-prompt');
      if (promptSig(seen.rows) !== sig) return conflict('prompt-changed');
      const last = answered.get(pane);
      if (last?.sig === sig && now() - last.at < answerHoldMs) return conflict('already-answered');
      const option = prompt.options.find((o) => o.n === n);
      const raw = option ? rawOption(seen.rows, n) : null;
      if (!option || raw === null) return invalid('n is not one of the prompt options');
      // the whole prompt window is read, not only the options (the label and its wrapped rows lie inside it): a question such
      // as "Switch to bypass ...?" has plain options
      if (bypassWindow(seen.rows)) return invalid('this option is answered in the terminal');
      const sent = await keys.send(pane, { text: String(n) }); // the digit alone answers; no Enter
      if (sent.status !== 200) return { status: sent.status, body: sent.body };
      holdAnswer(pane, sig);
      return { status: 200, body: { answered: n } };
    });
  }

  /**
   * Answers Claude's feedback survey with ONE digit (0.5, F14; design F13 section 2.4, docs/contracts/claude-tui.md section 10.11). `body` is
   * checkSurveyBody's `{ n, sig }`: n one of the shown options (0 to 3), sig the identity the capture handed out (src/survey.js). Under the per-pane
   * lock (409 busy-switching), in this order, nothing sent until the last check: no Stop/End interrupt running and no Escape of one less than 40 ms
   * ago (409 not-idle: a digit right behind an Escape is Meta+digit); one fresh capture (its own failure passes through); a permission prompt or a
   * dialog (409 prompt-open); src/survey.js on that capture: no survey (409 no-survey), the transcript question or a bypass mention (400
   * terminal-only), text in the box (409 input-not-empty), vim NORMAL (409 text-mode), rows nika does not read exactly (409 survey-changed); `sig`
   * not the screen's (409 survey-changed); the same sig answered under answerHoldMs ago (409 already-answered); n not among the shown options (400
   * invalid); the registry state read fresh and not idle (409 not-idle); an interrupt that began meanwhile (409 not-idle); then one more fresh capture (S1: the state
   * read is a whole snapshot) that must show the same survey, ready, with the same sig, else 409 survey-changed (a failed capture passes through); and an
   * interrupt that began during it (409 not-idle). Then exactly one key:
   * the digit as literal text (`keys.send(pane, { text })`, counted in the per-pane rate; a 429 or any failure passes through), never Enter,
   * Escape, C-u or any other. The screen is read back for at most SURVEY_READ_MS: 200 { answered: n } at the first read that shows no survey
   * rows at all and a box that does not hold exactly the digit; else 409 not-taken (nika never takes the digit back; the page says where it may
   * be). Every non-200 after the key carries `sent: 1`, and the sig is held (answered) after any key that went out. After a rating (1 to 3) no
   * Escape leaves this controller for SURVEY_UNDO_MS (see `keys` above). Nothing of the body is logged.
   */
  function answerSurvey(pane, body) {
    const bad = checkSurveyBody(body);
    if (bad) return Promise.resolve(bad);
    const { n, sig } = body;
    return exclusive(pane, async (ctx) => {
      if (keyGap(pane)) return conflict('not-idle');
      const seen = await look(pane, ctx);
      if (seen.res) return seen.res;
      if (promptOpen(seen.rows)) return conflict('prompt-open');
      const editOf = async (cap) => ({ vim: (await vimOf(pane)) === true || ctx.insert, insert: insertShown(cap.rows) });
      const edit = await editOf(seen);
      const found = surveyOf(seen, edit);
      if (found === null) return conflict('no-survey');
      if (found.state === 'terminal') {
        if (found.reason === 'consent' || found.reason === 'bypass') return { status: 400, body: { error: 'terminal-only', message: 'answer this in the terminal' } };
        return conflict(found.reason === 'input' ? 'input-not-empty' : found.reason === 'normal' ? 'text-mode' : 'survey-changed');
      }
      if (found.sig !== sig) return conflict('survey-changed');
      const last = answered.get(pane);
      if (last?.sig === sig && now() - last.at < answerHoldMs) return conflict('already-answered');
      if (!found.options.some((o) => o.n === n)) return invalid('n is not one of the survey options');
      if ((await stateNow(pane, { fresh: true })) !== 'idle') return conflict('not-idle');
      if (keyGap(pane)) return conflict('not-idle'); // a Stop began while the state was read
      // S1 (RR05): the fresh state read above runs a whole snapshot (registry, ps, tmux, transcripts), not a few milliseconds, and nothing has read the
      // screen since the capture at the top. One more capture: the digit goes out only onto the very survey the page showed (surveyOf is null for a
      // prompt or a dialog, and ready only for the captured rows once, an empty box and the same sig). Its own failure passes through, like the first.
      const again = await look(pane, ctx);
      if (again.res) return again.res;
      const still = surveyOf(again, await editOf(again));
      if (still?.state !== 'ready' || still.sig !== sig) return conflict('survey-changed');
      if (keyGap(pane)) return conflict('not-idle'); // a Stop began while the screen was read again: the last check before the key
      const before = ratedAt.get(pane);
      if (n !== 0) ratedAt.set(pane, now()); // set before the key leaves, so no Escape can slip in behind it
      const sent = await keys.send(pane, { text: String(n) });
      if (sent.status !== 200) {
        if (before === undefined) ratedAt.delete(pane);
        else ratedAt.set(pane, before); // the digit never went out: the hold of an earlier rating stays as it was
        return { status: sent.status, body: sent.body };
      }
      holdAnswer(pane, sig);
      const taken = await settled(pane, (rows, cap) => surveyOf(cap, edit) === null && !readsAs(cap, String(n)), ctx, Math.max(1, Math.floor(SURVEY_READ_MS / settlePollMs)));
      if (taken.res) return { status: taken.res.status, body: { ...taken.res.body, sent: 1 } };
      return taken.rows ? { status: 200, body: { answered: n } } : { status: 409, body: { error: 'not-taken', sent: 1 } };
    });
  }

  /**
   * The pieces the two draft controls share (writeDraft, acceptSuggestion), bound to a pane and the action's ctx. Every answer that has a
   * box carries `draft` (the parse plus `edit`, the pane's memory of how its input is edited).
   *   view(seen) / reply(status, error, seen, extra) / refused(res)   the draft for an answer; a 409 body; a failed send's own body plus the draft
   *   intake(seen)    the first reading of a screen: { draft } for a readable box, else { res }: 409 not-idle (a permission prompt is open,
   *                   T51), mode-unknown (the footer is not a mode line: a dialog), input-unreadable (no plain box) or draft-unreadable { reason }
   *   check(accept)   the pre-key check: a fresh capture with the plain box, no prompt, the cursor in the box and one of the `accept` texts,
   *                   else { res } (409 screen-changed | draft-mismatch). { seen, draft } or { res }
   *   press(keyBody)  one key request; null when it went out, else the answer. Refused (409 not-idle, nothing sent) while Stop's or End's Escape
   *                   runs, apart from the lock, and for VIM_ESC_GAP_MS after it went out: a key right behind an Escape would be read as
   *                   Meta+key (M-2, N-2)
   *   idleNow()       null only when the registry says idle right now (a fresh read, skipping its cache) and no interrupt runs, else 409 not-idle:
   *                   Escape could interrupt a running turn (claude-tui.md section 5). acceptSuggestion does not use it (item K: its Tab is a
   *                   screen question, answered by turnRunning)
   */
  function draftTools(pane, ctx) {
    const view = async (seen) => {
      const draft = seen ? readDraft(seen) : null;
      return draft && { ...draft, edit: editMode(seen.rows, (await vimOf(pane)) === true, (await plainOf(pane)) === true) };
    };
    const reply = async (status, error, seen, extra = {}) => ({ status, body: { error, ...extra, draft: await view(seen) } });
    const refused = async (res) => ({ status: res.status, body: { ...res.body, draft: await view(await look(pane, ctx)) } });
    const intake = async (seen) => {
      if (promptOpen(seen.rows)) return { res: conflict('not-idle') }; // T51: a draft write never lands in a prompt
      const draft = readDraft(seen);
      if (draft === null) return { res: conflict(modeFromRows(seen.rows) === 'unknown' ? 'mode-unknown' : 'input-unreadable') };
      if (draft.state === 'unreadable') return { res: await reply(409, 'draft-unreadable', seen, { reason: draft.reason }) };
      return { draft };
    };
    const check = async (accept) => {
      const seen = await look(pane, ctx);
      if (seen.res) return { res: seen.res };
      const draft = promptOpen(seen.rows) ? null : readDraft(seen);
      if (draft === null) return { res: await reply(409, 'screen-changed', seen) };
      // no tolerance for `trailing`: chunks() never ends a chunk in a space or tab, so nika's own text never reads that way (M-3)
      if (draft.state === 'unreadable') return { res: await reply(409, 'draft-mismatch', seen) };
      if (!cursorInBox(seen, draft)) return { res: await reply(409, 'screen-changed', null) }; // the box that reads is not where the input is: its text is not shown to the page
      if (!accept.some((t) => sameDraft(canonOf(draft), t))) return { res: await reply(409, 'screen-changed', seen) };
      return { seen, draft };
    };
    const press = async (keyBody) => {
      if (interrupting.has(pane) || escapeGap(pane)) return refused({ status: 409, body: { error: 'not-idle' } });
      const sent = await keys.send(pane, keyBody);
      return sent.status === 200 ? null : refused({ status: sent.status, body: sent.body }); // a failed send stops everything; the draft is read once more, best effort
    };
    const idleNow = async () => (interrupting.has(pane) || (await stateNow(pane, { fresh: true })) !== 'idle' ? conflict('not-idle') : null);
    return { view, reply, refused, intake, check, press, idleNow };
  }

  /**
   * Draft write (design W5 section 3): makes Claude's input box read `body.text`, a draft the page edited in nika's message box.
   * The only control that changes a user's draft, so every step fails closed and nothing is sent after a refusal. Under the
   * per-pane lock: a fresh capture (no prompt on screen, a readable box, its `sig` equal to `base`, the text inside the
   * envelope); then either nothing (the box already reads the text), an append (the cursor is at the end of the text, the new
   * text starts with the old, and the input is in vim INSERT, or in remembered plain mode with a text that does not end in a
   * newline: only the new part is typed), a type (an empty box), or a replace (clear, then type). Every plan that
   * sends a key needs the cursor on a row of the box that was read (else 409 `input-unreadable`: that box may be a status
   * line). The road of a replace is chosen once, on the first capture (0.5, W13): the cursor on the box's LAST row, in any registry
   * state, is the C-u road (End when the cursor is not at the text end, then C-u, one key per request, KEY_GAP_MS apart: neither key
   * interrupts a turn, so this works while Claude works); the cursor on an EARLIER row needs the registry state `idle` (read fresh
   * before anything is sent, again before each Escape) and clears with Escape as in W5, else 409 `cursor-not-at-end` and nothing is sent, not
   * even the probe. No key goes out
   * while Stop or End interrupts.
   * Before EVERY key or chunk a fresh capture must still show the plain box with the cursor in it, no prompt and exactly the
   * text the previous step left (409 `screen-changed` otherwise; T51; `trailing` is no exception). On the C-u road the text may only
   * shrink: it must be the start of the text before the last press, whitespace aside (`trailing` is an intermediate state there,
   * the break space a wrapped row keeps), and every C-u must make the text shorter, or put the same text in one row less (the press
   * that removes only a newline), within CLEAR_WAIT_MS (else 409 `clear-stopped`, and the pane's edit memory is dropped so the next try probes;
   * a cursor move is no progress), at most twice the box's rows plus two C-u presses. Chunks are at most 700 characters and 2 newlines, `chunkGapMs` apart. Last, the
   * box is read back (409 `draft-mismatch` on any difference). Sent: literal text (`send-keys -l`, or a bracketed paste for a
   * chunk with a newline or tab), `End` and `C-u` (the C-u road), `Escape` (idle only, earlier row; vim: once, then `ggdG` and `i`;
   * plain: twice, `escGapMs` apart), `i` (a probe when nothing shows the edit mode), `C-u` (the probe's own `i` in an empty box) and
   * `BSpace` (leaves a `!` box). Never `Enter`, `C-c`, `Up`, `Down`, `DC`, `C-k` or `BTab`, and no key within 40 ms after an `Escape`.
   * Every answer that has a box carries `draft` (the parse plus `edit`): 200 { draft, typed }, 409 not-idle | mode-unknown |
   * input-unreadable | draft-unreadable { reason } | draft-changed | screen-changed | draft-mismatch | cursor-not-at-end |
   * clear-stopped, 400 invalid, or a failed capture or key send's own status and body.
   */
  function writeDraft(pane, body) {
    const bad = checkDraftBody(body);
    if (bad) return Promise.resolve(bad);
    const { base } = body;
    const text = body.text.replace(/[ \t]+$/, ''); // trailing spaces are invisible on screen and never read back: they are not typed
    return exclusive(pane, async (ctx) => {
      const { view, reply, refused, check, press, idleNow, intake } = draftTools(pane, ctx);
      let typed = 0;
      let onScreen = ''; // what the box should hold now, in the page's form (a `!` box reads `!` + its text)

      // Waits up to `ms` (steps of draftPollMs, counted by the sleeps, not by a clock): every poll is a pre-key check;
      // `done(seen, draft, waited)` ends it. { seen, draft }, { res } or { timeout, seen }.
      const poll = async (ms, accept, done) => {
        let waited = 0;
        let last;
        for (let i = 0; i < steps(ms, draftPollMs); i += 1) {
          await sleep(draftPollMs);
          waited += draftPollMs;
          const got = await check(accept);
          if (got.res) return got;
          last = got.seen;
          if (done(got.seen, got.draft, waited)) return got;
        }
        return { timeout: true, seen: last };
      };
      // poll() until `done`, then the box is what the screen shows. Null when it got there, else the answer: a timeout is
      // 409 draft-mismatch, and `forget` also drops the pane's memory of its edit mode (the road that was assumed did not work).
      const reach = async (ms, accept, done, forget = true) => {
        const got = await poll(ms, accept, done);
        if (got.res) return got.res;
        if (got.timeout) {
          if (forget) setEdit(pane, 'none');
          return reply(409, 'draft-mismatch', got.seen);
        }
        onScreen = canonOf(got.draft);
        return null;
      };
      // A key after its own pre-key check (the capture right before it). Null when it went out, else the answer.
      const send = async (accept, keyBody) => (await check(accept)).res ?? press(keyBody);
      const isEmpty = (cap, d) => d.state === 'empty';

      // vim INSERT: Escape, wait until INSERT is gone and 40 ms passed, `ggdG`, `i`, wait for the empty INSERT box
      const clearVim = async () => {
        let res = await idleNow();
        if (res) return res;
        if ((res = await send([onScreen], { keys: ['Escape'] }))) return res;
        const gone = await poll(VIM_CLEAR_MS, [onScreen], (cap, d, waited) => !insertShown(cap.rows) && waited >= VIM_ESC_GAP_MS);
        if (gone.res) return gone.res;
        if (gone.timeout) return reply(409, 'mode-unknown', gone.seen);
        if ((res = await press({ text: 'ggdG' }))) return res; // the last poll was this key's pre-key check
        // the redraw after ggdG may be late: the old text or the empty box
        if ((res = await send([onScreen, ...EMPTY], { text: 'i' }))) return res;
        return reach(VIM_CLEAR_MS, [onScreen, ...EMPTY], (cap, d) => insertShown(cap.rows) && d.state === 'empty');
      };
      // plain: Escape, escGapMs, Escape (a second one on an already empty box would open Rewind, so only while text shows)
      const clearPlain = async () => {
        let res = await idleNow();
        if (res) return res;
        if ((res = await send([onScreen], { keys: ['Escape'] }))) return res;
        await sleep(Math.max(escGapMs, VIM_ESC_GAP_MS));
        const second = await check([onScreen, ...EMPTY]);
        if (second.res) return second.res;
        // the registry is read again: a turn that started since the first Escape would be interrupted by this one (W13: Escape only while idle)
        if (second.draft.state !== 'empty' && ((res = await idleNow()) || (res = await press({ keys: ['Escape'] })))) return res;
        // the next key follows the last Escape by at least 40 ms: a key right behind an Escape is read as Alt+key
        return reach(PLAIN_CLEAR_MS, [onScreen, ...EMPTY], (cap, d, waited) => d.state === 'empty' && waited >= VIM_ESC_GAP_MS);
      };
      // Nothing shows which edit mode the input is in: `i` is a vim command in normal mode (INSERT appears) and text otherwise.
      // Returns 'insert' (vim), 'plain' (the `i` landed in the box and stays there; the caller removes it) or { res }.
      const probe = async () => {
        const from = onScreen;
        const res = await send([onScreen], { text: 'i' });
        if (res) return { res };
        const landed = (cap) => { const d = readDraft(cap); return d !== null && d.state !== 'unreadable' && oneIAdded(normDraft(from), normDraft(canonOf(d))); };
        const after = await settled(pane, (rows, cap) => insertShown(rows) || promptOpen(rows) || landed(cap), ctx);
        if (after.res) return { res: after.res };
        const cap = after.seen ?? after.lastSeen;
        const draft = promptOpen(cap.rows) ? null : readDraft(cap);
        if (draft === null) return { res: await reply(409, 'screen-changed', cap) };
        if (draft.state === 'unreadable') return { res: await reply(409, 'draft-mismatch', cap) };
        if (insertShown(cap.rows) && sameDraft(canonOf(draft), from)) { // vim: INSERT shown, the text did not change
          setEdit(pane, 'vim');
          return 'insert';
        }
        if (!landed(cap)) return { res: await reply(409, 'screen-changed', cap) };
        setEdit(pane, 'plain');
        onScreen = canonOf(draft);
        return 'plain';
      };
      // The C-u road (design W13 1.2): empties the box with End (once, only when the cursor is not at the text end) and C-u, none of which
      // interrupts a turn. Each key is its own request after a pause that makes it KEY_GAP_MS since the key before and a fresh pre-key check; a
      // check passes when the plain box is on screen with the cursor in it, no prompt or dialog, and its text (whitespace aside) is the start of the
      // text before the last press; `trailing` passes too (a wrapped row keeps its break space). A C-u counts as taken once the text is shorter, or
      // the same text sits in one row less (the press that removes only a newline); a cursor move alone is no progress. 400 ms without progress is
      // 409 clear-stopped, which also drops the pane's edit memory (the next try probes). Null when the box is empty (Claude's queued placeholder is
      // empty too), else the answer. `onScreen` is the box when it returns.
      const clearUp = async () => {
        const first = await check([onScreen]); // exactly the text the previous step left (after the probe, so its row may be one more)
        if (first.res) return first.res;
        const limit = 2 * (first.draft.box.bottom - first.draft.box.top - 1) + 2;
        const rowsOf = (d) => d.box.bottom - d.box.top;
        let at = boxOf(first.seen);
        let got = { seen: first.seen, draft: first.draft, len: at.squash.length, rows: rowsOf(first.draft) };
        const stopped = async (seen) => { setEdit(pane, 'none'); return reply(409, 'clear-stopped', seen); };
        let lastKey = null;
        let res;
        const fire = async (key) => {
          const refused = await press({ keys: [key] });
          lastKey = now();
          return refused;
        };
        const pause = async () => {
          const wait = lastKey === null ? 0 : KEY_GAP_MS - (now() - lastKey);
          if (wait > 0) await sleep(wait);
        };
        const peek = async () => {
          const seen = await look(pane, ctx);
          if (seen.res) return { res: seen.res };
          const box = promptOpen(seen.rows) ? null : boxOf(seen);
          if (box === null || (box.draft.state === 'unreadable' && box.draft.reason !== 'trailing')) return { res: await reply(409, 'screen-changed', seen) };
          if (!cursorInBox(seen, box.draft)) return { res: await reply(409, 'screen-changed', null) }; // not where the input is: nothing of it goes to the page
          if (!at.squash.startsWith(box.squash)) return { res: await reply(409, 'screen-changed', seen) }; // someone typed: the terminal wins
          return { seen, draft: box.draft, len: box.squash.length, rows: rowsOf(box.draft), box };
        };
        // polls every draftPollMs, at most CLEAR_WAIT_MS, until `done(got)`; the baseline for the prefix check moves to the box that was seen
        const redraw = async (done) => {
          let last = got.seen;
          for (let i = 0; i < steps(CLEAR_WAIT_MS, draftPollMs); i += 1) {
            await sleep(draftPollMs);
            const next = await peek();
            if (next.res) return next;
            last = next.seen;
            if (done(next)) { at = next.box; return next; }
          }
          return { res: await stopped(last) };
        };
        for (let pressed = 0, endPressed = false; ; ) { // `got` is the pre-key check of the next key
          if (got.draft.state === 'empty') {
            await pause(); // the text that follows is a key too
            onScreen = canonOf(got.draft);
            return null;
          }
          if (pressed === 0 && !endPressed && !got.draft.cursorAtEnd) {
            endPressed = true;
            if ((res = await fire('End'))) return res;
            got = await redraw((next) => next.draft.cursorAtEnd);
          } else {
            if (pressed >= limit) return stopped(got.seen);
            const before = got;
            if ((res = await fire('C-u'))) return res;
            pressed += 1;
            got = await redraw((next) => next.draft.state === 'empty' || next.len < before.len || (next.len === before.len && next.rows < before.rows));
          }
          if (got.res) return got.res;
          if (got.draft.state !== 'empty') {
            await pause();
            got = await peek(); // the pre-key check right before the next key
            if (got.res) return got.res;
          }
        }
      };
      // types `part` in chunks: each one after a pre-key check, chunkGapMs apart
      const typeIn = async (part) => {
        const parts = chunks(part);
        for (let k = 0; k < parts.length; k += 1) {
          if (k > 0) await sleep(chunkGapMs);
          const res = await send([onScreen], /[\n\t]/.test(parts[k]) ? { paste: parts[k] } : { text: parts[k] });
          if (res) return res;
          onScreen += parts[k];
          typed += [...parts[k]].length;
        }
        return null;
      };

      // --- the checks, in order (nothing is sent before the plan) ---
      const seen = await look(pane, ctx);
      if (seen.res) return seen.res;
      const got = await intake(seen);
      if (got.res) return got.res;
      const { draft } = got;
      if (draft.sig !== base) return reply(409, 'draft-changed', seen);
      if (!inEnvelope(text, seen.cols).ok) return invalid('text does not fit the input box');
      onScreen = canonOf(draft);
      if (sameDraft(onScreen, text)) return { status: 200, body: { draft: await view(seen), typed: 0 } };
      // second layer behind the parser (I-1): a box the cursor is not in may be a user's status line, never Claude's input
      if (!cursorInBox(seen, draft)) return reply(409, 'input-unreadable', null); // no draft: the page must not adopt what may be a status line

      let edit = editMode(seen.rows, (await vimOf(pane)) === true, (await plainOf(pane)) === true);
      if (edit === 'insert') setEdit(pane, 'vim');
      const empty = draft.state === 'empty';
      // `plain` is memory: on an empty last row (the text ends in a newline) vim NORMAL draws the same cursor, so only a shown INSERT may append there (M-1)
      const append = !empty && (edit === 'insert' || (edit === 'plain' && !onScreen.endsWith('\n'))) && draft.cursorAtEnd && (draft.mode === 'bash') === text.startsWith('!') && text.startsWith(onScreen);
      // A replace is cleared by one of two roads, chosen here and not again (design W13 1.1): the cursor on the box's last row (End reaches the
      // text end from there only) is the C-u road, in any registry state; on an earlier row only Escape clears, and Escape interrupts a running turn.
      const lastRow = seen.cursor.y === draft.box.bottom - 1;
      // the registry is read fresh: a stale `idle` must not let the probe `i` out on a busy pane
      if (!empty && !append && !lastRow && (await stateNow(pane, { fresh: true })) !== 'idle') return reply(409, 'cursor-not-at-end', seen);
      let res;

      if (!append) {
        const was = onScreen; // what the box holds before the probe
        if (edit === 'normal' || edit === 'unknown') {
          edit = await probe();
          if (edit.res) return edit.res;
        }
        if (!empty) {
          if ((res = await (lastRow ? clearUp() : edit === 'insert' ? clearVim() : clearPlain()))) return res;
        } else if (onScreen !== was) { // the probe's `i` landed as text in an empty box: one C-u removes it (one row)
          if ((res = await send([onScreen], { keys: ['C-u'] }))) return res;
          if ((res = await reach(PLAIN_CLEAR_MS, [onScreen, was], isEmpty))) return res;
        }
        if (onScreen === '!' && !text.startsWith('!')) { // a `!` box and a text that is not one: BSpace leaves it
          if ((res = await send([onScreen], { keys: ['BSpace'] }))) return res;
          if ((res = await reach(PLAIN_CLEAR_MS, ['!', ''], (cap, d) => d.mode === 'prompt' && d.state === 'empty', false))) return res;
        }
      }
      // an empty `!` box already holds the text's own `!`
      if ((res = await typeIn(append ? text.slice(onScreen.length) : onScreen === '!' ? text.slice(1) : text))) return res;

      const back = await settled(pane, (rows, cap) => {
        const d = readDraft(cap);
        return d !== null && d.state !== 'unreadable' && sameDraft(canonOf(d), text);
      }, ctx);
      if (back.res) return back.res;
      if (back.rows) return { status: 200, body: { draft: await view(back.seen), typed } };
      return reply(409, 'draft-mismatch', back.lastSeen);
    });
  }

  /**
   * Accept Claude's prompt suggestion (design W4): the page's Tab or right arrow in an empty message box that shows `body.text`
   * as its placeholder. Claude draws a suggestion as dim text in an empty input box; Tab takes it into the box. The page's copy can be
   * stale (the suggestion changed, vanished, a prompt opened), and a Tab sent then would land in the wrong place (T51), so this is not
   * the plain keys route. Under the per-pane lock: one fresh capture that must show the plain box in prompt mode, no permission prompt or
   * dialog, the cursor inside the box, state `empty` and a suggestion equal to `body.text` (anything else: 409 not-idle | mode-unknown |
   * input-unreadable | draft-unreadable { reason } | draft-changed, nothing sent) and no turn running in main (409 busy: the spinner row or
   * the footer's interrupt hint, src/turn.js). The registry is NOT asked (item K, 0.5.1): Claude reads `busy` while background agents run
   * and `shell` while a background shell runs, also after the turn ended, and shows the suggestion and takes Tab then. No Stop/End
   * interrupt may run and no Escape of one may be < 40 ms old (press: 409 not-idle). Then exactly one key, `Tab` (counts toward the
   * per-pane key limit), and a read-back until the box reads `text` equal to the suggestion: 200 { draft }, else 409 draft-mismatch { draft }
   * (the Tab is never repeated). Never any other key:
   * no Enter (the page's Send does that), no Escape, no text. Every answer that has a box carries `draft`.
   */
  function acceptSuggestion(pane, body) {
    const bad = checkSuggestionBody(body);
    if (bad) return Promise.resolve(bad);
    const { text } = body;
    return exclusive(pane, async (ctx) => {
      const { view, reply, intake, press } = draftTools(pane, ctx);
      const seen = await look(pane, ctx); // the one capture right before the key
      if (seen.res) return seen.res;
      const got = await intake(seen);
      if (got.res) return got.res;
      const { draft } = got;
      if (!cursorInBox(seen, draft)) return reply(409, 'input-unreadable', null); // that box may be a status line: nothing of it goes to the page
      if (draft.state !== 'empty' || draft.mode !== 'prompt' || draft.suggestion !== text) return reply(409, 'draft-changed', seen);
      // Item K: the screen, not the registry, says whether Claude answers right now. Background agents or a background shell keep the registry
      // busy / shell after the turn ended, with the suggestion shown; a turn in main draws the spinner row or the footer's interrupt hint.
      if (turnRunning(seen.rows, draft.box.top)) return reply(409, 'busy', seen);
      const res = await press({ keys: ['Tab'] });
      if (res) return res;
      const back = await settled(pane, (rows, cap) => {
        const d = readDraft(cap);
        return d !== null && d.state === 'text' && d.mode === 'prompt' && sameDraft(d.text, text);
      }, ctx);
      if (back.res) return back.res;
      if (back.rows) return { status: 200, body: { draft: await view(back.seen) } };
      return reply(409, 'draft-mismatch', back.lastSeen);
    });
  }

  /**
   * Send's Enter (design W13 section 2.2): the one Enter of the page's Send, never the keys route. `body` is checkSubmitBody's, `{ base? }`:
   * `base` is the draft sig the page last synced on. Under the per-pane lock (409 busy-switching), in this order and with nothing sent before the
   * last check: no Stop/End interrupt and no Escape of one < 40 ms ago (409 not-idle); one fresh capture (its own failure passes through); a
   * bypass window with a permission prompt or an unreadable footer (409 bypass-prompt, as the keys route, T26); a permission prompt or a dialog
   * (409 prompt-open: an Enter would confirm its highlighted option); an unreadable footer and no input box (409 screen-unclear); with a `base`,
   * a plain box with the cursor in it (409 input-unreadable) whose `sig` is `base` (409 draft-changed { draft }; an unreadable box has no sig,
   * and `''` matches nothing); with no `base`, no box that reads, the box's two rule rows on screen and the cursor below the bottom one (409
   * input-unreadable: Claude's focus is on the shells pill or an agent list; a cursor above the top rule, a status line under the box, goes on); an
   * empty box that shows a prompt suggestion, with or without a `base` (409 suggestion-shown { draft }: what Enter
   * does with one is unverified, claude-tui.md; Claude's queued placeholder is not a suggestion). Then exactly one `Enter`, in any registry state (Claude queues a message sent while it works), and no other key
   * ever. Read-back every SUBMIT_POLL_MS for SUBMIT_READ_MS: 200 { taken: true, draft } at the first poll that shows a plain box in state `empty`
   * (the queued placeholder included); taken false when `base` was given and every poll still showed that sig (the Enter did not take; it is never
   * repeated); taken null otherwise (no `base`, a prompt opened, the box vanished or changed, or any read-back capture failed: a failed read
   * proves nothing, so it never counts towards false). A failed Enter send answers its own status and body.
   */
  function submit(pane, body) {
    const bad = checkSubmitBody(body);
    if (bad) return Promise.resolve(bad);
    const { base } = body;
    return exclusive(pane, async (ctx) => {
      const { view, reply, press } = draftTools(pane, ctx);
      if (interrupting.has(pane) || escapeGap(pane)) return conflict('not-idle');
      const seen = await look(pane, ctx);
      if (seen.res) return seen.res;
      if (bypassWindow(seen.rows) && (promptFromRows(seen.rows) !== null || modeFromRows(seen.rows) === 'unknown')) return conflict('bypass-prompt');
      if (promptOpen(seen.rows)) return conflict('prompt-open');
      if (unknownScreen(seen)) return conflict('screen-unclear');
      const box = readDraft(seen);
      if (base !== undefined) {
        if (box === null || !cursorInBox(seen, box)) return conflict('input-unreadable');
        if (box.sig !== base) return reply(409, 'draft-changed', seen);
      } else if (box === null && cursorBelowBox(seen)) {
        return conflict('input-unreadable'); // Claude's focus is on the shells pill or an agent list: an Enter there opens the Background dialog or an agent view
      }
      // Enter on an empty box with a suggestion was never verified (claude-tui.md): refused, base or not
      if (box?.state === 'empty' && box.suggestion !== null) return reply(409, 'suggestion-shown', seen);
      const sent = await press({ keys: ['Enter'] });
      if (sent) return sent;
      let last = null;
      let other = false; // a poll that did not show the text of `base` any more (or never could be compared)
      for (let i = 0; i < steps(SUBMIT_READ_MS, SUBMIT_POLL_MS); i += 1) {
        await sleep(SUBMIT_POLL_MS);
        const cap = await look(pane, ctx);
        if (cap.res) { other = true; continue; } // the Enter is out: a failed read proves nothing either way
        last = cap;
        const draft = promptOpen(cap.rows) ? null : readDraft(cap);
        if (draft?.state === 'empty') return { status: 200, body: { taken: true, draft: await view(cap) } };
        if (base === undefined || draft === null || draft.sig !== base) other = true;
      }
      return { status: 200, body: { taken: base !== undefined && !other ? false : null, draft: await view(last) } };
    });
  }

  /**
   * Answers Claude's question dialog (AskUserQuestion: the current tab, or the review step) or plan approval (ExitPlanMode), ONE STEP per
   * request (design W1 4, ADR 0015), or declines it. `body` is checkDialogBody's: { sig, picks, text? } answers the current question,
   * { sig, submit: true } presses Submit on the review, { sig, choice } picks a plan choice, { sig, cancel: true } declines. The screen is the
   * only source (src/dialog.js reads it exactly or not at all).
   *
   * Under the per-pane lock (409 busy-switching). Read phase, nothing sent: a fresh capture (its own failure passes through), no dialog on
   * screen (409 no-dialog; a screen that may hold a dialog nika cannot read is 409 dialog-changed), the dialog unreadable / not the body's
   * shape / not `sig` (409 dialog-changed), the same sig answered under answerHoldMs ago (409 already-answered), bypass (400 terminal-only;
   * not for a Decline), a body that does not fit the screen (400 invalid: single-select takes one pick or one text, multi takes a pick or
   * text and text only on the last tab, a pick beyond the options, the plan's text option). Then at most STEPS_MAX rounds of: a FRESH capture
   * whose step identity must equal the request's (else nothing more is sent, 409 no-dialog | dialog-changed | terminal-only), the one key the
   * screen calls for, `settled` on the state that key should leave (no match: 409 not-taken, or no-dialog | dialog-changed when the last read
   * shows that; typed text that does not read back: 409 text-mismatch). The screen a key was proven on (`settled`) is kept: the next fresh
   * read must show the same focus, boxes, text and INSERT marker, else nothing more is sent (409 dialog-focus | dialog-touched). Free text
   * that starts with 1-9 is 400 invalid and text that mentions bypass is 400 terminal-only, both before any key. Every non-200 after a key
   * carries `sent`.
   *
   * Keys, each one keys.send: a digit as literal text (only on a numbered option with the focus on one of them), `Down`, `Right` (from an
   * option row), `Enter` (the text row that reads back exactly the typed text, the multi question's button row after its Other text, the
   * review's `1. Submit answers`), the free text as one `send-keys -l` (vim INSERT shown, a pane known to be plain, or the focus brought to
   * the text row by nika's own Down with no INSERT coming; a request that starts on the text row with no INSERT is 409 text-mode),
   * `Escape` for a Decline only (a second one only after a fresh read shows vim INSERT gone). Never Up, Left, Tab, BTab, Space, C-c or C-u,
   * a key on `Chat about this`, or any key after the dialog closed; nika never moves between Claude's tabs. Nothing of a body, a dialog
   * string or a sig is logged. 200 { done: 'next' | 'review' | 'submitted' | 'chosen' | 'declined', sent }.
   */
  function answerDialog(pane, body) {
    const bad = checkDialogBody(body);
    if (bad) return Promise.resolve(bad);
    // fixed here, before any await: a body changed later cannot change the keys
    const want = { sig: body.sig, picks: body.picks === undefined ? undefined : [...body.picks], text: body.text, submit: body.submit === true, choice: body.choice, cancel: body.cancel === true };
    const target = want.text === undefined ? undefined : clean(want.text); // the text as the screen shows it (whitespace collapsed)
    return exclusive(pane, async (ctx) => {
      let sent = 0; // keys.send calls that went out
      let escapes = 0;
      const out = (status, b) => ({ status, body: sent > 0 ? { ...b, sent } : b });
      const refuse = (error) => out(409, { error });
      const relay = (res) => out(res.status, res.body); // a failed capture or key send, with its own status and body
      const terminalOnly = () => out(400, { error: 'terminal-only', message: 'answer this in the terminal' });
      const view = (seen) => (promptFromRows(seen.rows) !== null ? null : readDialogScreen(seen.rows, seen.cols));
      // The reason a screen is not a readable dialog, else null. No dialog and no sign of one is `no-dialog`; a screen with no readable footer and
      // no input box may hold a dialog nika cannot read (a wrapped footer, "Exit plan mode?", the auto-mode nudge): `dialog-changed`, never "plain box".
      const lost = (seen, S) => {
        if (S === null) return promptFromRows(seen.rows) === null && unknownScreen(seen) ? 'dialog-changed' : 'no-dialog';
        return S.unreadable === undefined ? null : 'dialog-changed';
      };

      // --- read phase: nothing is sent ---
      const first = await look(pane, ctx);
      if (first.res) return relay(first.res);
      const S0 = view(first);
      const gone0 = lost(first, S0);
      if (gone0) return refuse(gone0);
      const fits = want.picks !== undefined ? S0.at === 'question' : want.submit ? S0.at === 'review' : want.choice !== undefined ? S0.at === 'plan' : true;
      if (!fits || sigOf(S0) !== want.sig) return refuse('dialog-changed');
      const held = answered.get(pane);
      if (held?.sig === want.sig && now() - held.at < answerHoldMs) return refuse('already-answered');
      // bypass on the dialog, or in the free text itself (typed first and refused after it would leave the text in Claude's field): terminal only
      if (!want.cancel && (S0.bypass || (want.text !== undefined && mentionsBypass(want.text)) || (S0.at === 'plan' && PLAN_PICK !== 'digit'))) return terminalOnly();
      const unfit = bodyMisfit(S0, want, target);
      if (unfit) return invalid(unfit);
      const id0 = identityOf(S0);

      const same = (S2) => S2 !== null && S2.unreadable === undefined && identityOf(S2) === id0; // still this step, readable
      const drift = (seen, S) => lost(seen, S) ?? (identityOf(S) === id0 ? null : 'dialog-changed');
      const gone = (S2, kind) => S2 === null || S2.kind !== kind; // the dialog of that kind is no longer on screen
      const tabs = (S) => JSON.stringify(S.tabs.map((t) => t.header));
      // where a question step goes once its tab is answered: a one-question single-select form is done, the others show the review or the next tab
      const moved = (S, S2) => {
        if (S.single && !S.multi) return gone(S2, 'ask') && 'submitted';
        if (!same(S2) && (S2 === null || S2.unreadable !== undefined || S2.kind !== 'ask' || tabs(S2) !== tabs(S))) return false;
        if (S2.at === 'review') return 'review';
        return S2.at === 'question' && S2.i === S.i + 1 && S2.tabs[S.i].answered && 'next';
      };

      // What a person can change in the terminal between two of our reads: the focus, the boxes, the typed text, the INSERT marker.
      const mutable = (S) => JSON.stringify([S.insert, S.options?.map((o) => [o.checked, o.ticked]), S.textRow]);
      const shifted = (A, B) => (A.focus !== B.focus ? 'dialog-focus' : mutable(A) !== mutable(B) ? 'dialog-touched' : null);
      let settledS = null; // the screen the last key was proven on (the settle read): the next fresh read must still be this one
      let arrived = false; // the last key was nika's own Down and it put the focus on the text row with no INSERT shown (M4)

      /** The one key the screen calls for: { send, hit(S2) -> false | true (go on) | a done name, miss? } or { error } (a 409 code). */
      const decide = async (S) => {
        if (want.cancel) {
          if (escapes >= 2) return { error: 'dialog-focus' };
          const declined = (S2) => gone(S2, S.kind) && 'declined';
          // vim INSERT: the first Escape only leaves it (the dialog stays); the second goes only once a fresh read shows INSERT gone
          return { send: { keys: ['Escape'] }, hit: S.insert ? (S2) => declined(S2) || (same(S2) && !S2.insert) : declined };
        }
        if (S.at === 'review') return S.focus === 1 ? { send: { keys: ['Enter'] }, hit: (S2) => gone(S2, 'ask') && 'submitted' } : { error: 'dialog-focus' };
        if (S.at === 'plan') {
          if (S.textRow?.value != null) return { error: 'dialog-touched' }; // feedback typed in the text option would be lost by a digit
          const focused = S.options.find((o) => o.n === S.focus);
          return focused === undefined || focused.text ? { error: 'dialog-focus' } : { send: { text: String(want.choice) }, hit: (S2) => gone(S2, 'plan') && 'chosen' };
        }
        const k = S.options.length;
        const onOption = Number.isInteger(S.focus) && S.focus >= 1 && S.focus <= k;
        const onText = S.focus === k + 1;
        const value = S.textRow.value;
        if (!S.multi && S.tabs[S.i].answered) return { error: 'dialog-touched' }; // someone came back to this tab in the terminal
        if (value !== null && value !== target) return { error: 'dialog-touched' }; // text the user typed there, not this request's
        const down = () => {
          const next = onText && S.button !== null ? 'button' : S.focus + 1;
          return { send: { keys: ['Down'] }, hit: (S2) => same(S2) && S2.focus === next };
        };
        const type = async () => {
          const vim = (await vimOf(pane)) === true || ctx.insert; // INSERT shown in any read of this request is proof of vim
          // Plain mode and vim NORMAL draw the same screen (T0b 3.4, T0c), so on a pane not known to be plain the text goes only when INSERT shows
          // or when nika's own Down just brought the focus here and no INSERT came (vim enters INSERT on this row at once, T0b): a request that
          // starts on the text row with no INSERT is text-mode.
          if (!(S.insert || (await plainOf(pane)) === true || (PLAIN_TEXT && arrived && !vim))) return { error: 'text-mode' };
          return { send: { text: want.text }, hit: (S2) => same(S2) && S2.textRow.value === target, miss: 'text-mismatch' };
        };
        const enter = { send: { keys: ['Enter'] }, hit: (S2) => moved(S, S2) };
        if (!S.multi) {
          if (target === undefined) return onOption ? { send: { text: String(want.picks[0]) }, hit: (S2) => moved(S, S2) } : { error: 'dialog-focus' };
          if (value === target) return onText ? enter : { error: 'dialog-focus' };
          if (onOption) return down();
          return onText ? type() : { error: 'dialog-focus' };
        }
        const have = new Set(S.options.filter((o) => o.checked).map((o) => o.n));
        const flip = [...new Set([...have, ...want.picks])].filter((n) => have.has(n) !== want.picks.includes(n)).sort((a, b) => a - b)[0];
        if (flip !== undefined) { // one digit toggles one box and leaves the focus where it is
          const flipped = (S2) => same(S2) && S2.focus === S.focus && S2.options.every((o, j) => o.checked === (o.n === flip ? !S.options[j].checked : S.options[j].checked));
          return onOption ? { send: { text: String(flip) }, hit: flipped } : { error: 'dialog-focus' };
        }
        if (target === undefined) return onOption ? { send: { keys: ['Right'] }, hit: (S2) => moved(S, S2) } : { error: 'dialog-focus' }; // Right works from an option row only (T0c)
        // Other text on the last tab: Down to the text row, the text, Down to the button row, Enter there opens the review (T0c)
        if (value === null) return onOption ? down() : onText ? type() : { error: 'dialog-focus' };
        if (S.focus === 'button') return enter;
        return onOption || onText ? down() : { error: 'dialog-focus' };
      };

      // --- one key per round, each after a fresh capture of the same step ---
      for (let round = 0; round < STEPS_MAX; round += 1) {
        const seen = await look(pane, ctx);
        if (seen.res) return relay(seen.res);
        const S = view(seen);
        const code = drift(seen, S);
        if (code) return refuse(code);
        const changed = settledS === null ? null : shifted(settledS, S); // changed in the terminal since the key took: nothing more is sent
        if (changed) return refuse(changed);
        if (S.bypass && !want.cancel) return terminalOnly();
        const act = await decide(S);
        if (act.error) return refuse(act.error);
        if (interrupting.has(pane) || escapeGap(pane)) return refuse('not-idle'); // a key right behind a Stop/End Escape would be Meta+key
        const res = await keys.send(pane, act.send);
        if (res.status !== 200) return relay(res);
        sent += 1;
        const escape = act.send.keys?.[0] === 'Escape';
        if (escape) escapes += 1;
        let verdict = false;
        const got = await settled(pane, (rows, cap) => { verdict = act.hit(view(cap)) || false; return verdict !== false; }, ctx);
        if (got.res) return relay(got.res);
        if (!got.rows) return refuse((got.lastSeen && drift(got.lastSeen, view(got.lastSeen))) || act.miss || 'not-taken');
        if (typeof verdict === 'string') {
          holdAnswer(pane, want.sig);
          return out(200, { done: verdict });
        }
        settledS = view(got.seen); // verdict true: the step is still this one and readable (hit checked it)
        arrived = act.send.keys?.[0] === 'Down' && settledS.at === 'question' && settledS.focus === settledS.options.length + 1 && !settledS.insert;
        if (escape) await sleep(VIM_ESC_GAP_MS);
      }
      return refuse('not-taken'); // STEPS_MAX rounds and still not done
    });
  }

  /** True while no key may go: a Stop or End interrupt runs, or its Escape went out less than 40 ms ago (N-2). The scroll route (src/scroll.js) checks it inside the lock. */
  const keyGap = (pane) => interrupting.has(pane) || escapeGap(pane);

  return { switchMode, endSession, runCommand, answer, answerSurvey, stop, writeDraft, submit, acceptSuggestion, answerDialog, withPaneLock, keyGap };
}
