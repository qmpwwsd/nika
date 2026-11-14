// Six controls on a live Claude pane (api-app.md section 3): switch the permission mode, End the session, run a slash
// command, answer a permission prompt, write the draft, accept Claude's prompt suggestion (0.5). They type into a real agent session, so every path fails
// closed: when the screen or the registry state is not exactly what the step needs, nothing is sent and the answer is a 409.
// Keys go only through `keys.send` (src/keys.js: fixed argv, KEY_NAME allow-list, rate limit); this module never kills a pane
// and never signals a process. End and the commands type only into an empty input box and press Enter only after the box reads
// exactly what nika typed (claude-tui.md section 5), so a user's draft is never sent, extended or cleared by them. The draft
// route (writeDraft) is the one place that changes a draft, and it never presses Enter; acceptSuggestion presses only Tab.
// The input box is read by src/draft.js.
import { createHash } from 'node:crypto';
import { CLAUDE_COMMAND } from './ids.js';
import { MODE_TARGETS, OPTION, PROMPT_ROWS, bypassWindow, lastNonBlank, modeFromRows, promptFromRows, rowText } from './mode.js';
import { RULE_ROW, parseDraft, normDraft, sameDraft, inEnvelope, chunks } from './draft.js';

const EXIT_POLL_MS = 500;
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

/** The rows (span lists, styles kept) between the last two rule rows (the input box), or null when the screen has fewer than two. */
function inputBox(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const rules = list.flatMap((row, i) => (RULE_ROW.test(rowText(row).trimEnd()) ? [i] : []));
  return rules.length < 2 ? null : list.slice(rules.at(-2) + 1, rules.at(-1));
}

/**
 * The input box (src/draft.js) of a capture `{ rows, cursor, cols }`: a Draft, or null when the screen has no plain box. The mode
 * line is read with plain spaces (insertShown does the same), so a no-break space inside `-- INSERT --` does not hide the mode.
 * The live reader (the capture route, the write checks, End and the commands) needs the cursor (N-1): a capture whose cursor has no
 * integer x and y has no box, because only the cursor says which rules frame the input. tmux always reports one, so this fails closed
 * only; parseDraft alone, given no cursor, still reads as before.
 */
export function readDraft(seen) {
  if (!Number.isInteger(seen?.cursor?.x) || !Number.isInteger(seen?.cursor?.y)) return null;
  const rows = Array.isArray(seen?.rows) ? seen.rows : [];
  const last = rows.findLastIndex((row) => rowText(row).trim() !== '');
  const spaced = (row) => (Array.isArray(row) ? row.map((sp) => (typeof sp?.t === 'string' ? { ...sp, t: plain(sp.t) } : sp)) : row);
  return parseDraft(last < 0 ? rows : rows.map((row, i) => (i === last ? spaced(row) : row)), seen?.cursor, seen?.cols);
}
const draftOf = readDraft;
/** Whether the capture's cursor sits on a row between the two rules of the box that was read: the input is where the box is. */
const cursorInBox = (seen, draft) => Number.isInteger(seen.cursor?.y) && seen.cursor.y > draft.box.top && seen.cursor.y < draft.box.bottom;
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

/** The body of the suggestion route, exactly `{ text }` (the suggestion the page shows): null when it is valid, else the 400 answer. */
export function checkSuggestionBody(body) {
  const names = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  if (names.length !== 1 || names[0] !== 'text') return invalid('body must be { text }');
  const { text } = body;
  if (typeof text !== 'string' || text === '' || text.length > SUGGESTION_MAX) return invalid(`text must be a string of 1 to ${SUGGESTION_MAX} characters`);
  if (SUGGESTION_CONTROL.test(text)) return invalid('text must not contain control characters');
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
 * paneCommand(pane) → Promise<string|null> (null = pane gone); stateOf(pane) → the live session's registry state or null;
 * vimOf(pane) → boolean: this pane's mode line has shown `-- INSERT --` before (Claude's input is in vim mode);
 * plainOf(pane) → boolean (optional, default false): a probe `i` landed as text on this pane, so its input is not in vim mode;
 * setEdit(pane, 'vim' | 'plain' | 'none') (optional): the draft route reports what it learned about the pane's edit mode.
 * One control action runs per pane at a time (switch, End, command, answer and draft write share one lock). Every method returns { status, body }.
 * The draft route's timings: draftPollMs (poll step while it waits for a redraw), escGapMs (plain mode: gap between its two Escapes), chunkGapMs.
 */
export function createSessionControl({
  mirror, keys, paneCommand, stateOf, vimOf, plainOf = () => false, setEdit = () => {}, now = Date.now, sleep = realSleep,
  pollMs = 300, settleMs = 1800, maxPresses = 6, escWaitMs = 1000, exitWaitMs = 3000, answerHoldMs = 3000,
  settleTries = 4, settlePollMs = 150, draftPollMs = 20, escGapMs = 60, chunkGapMs = 300,
}) {
  // Typing without knowing whether the input is in vim normal mode could send stray vim commands, so there is no default.
  if (typeof vimOf !== 'function') throw new TypeError('vimOf must be a function (pane) => boolean');
  const running = new Set(); // panes with a control action in progress
  const interrupting = new Set(); // panes whose Escape sequence is running: Stop and End share it, apart from the control lock
  const answered = new Map(); // pane → { sig, at } of the last successful answer
  const escapedAt = new Map(); // pane → now() when the last Escape of a Stop or an End went out (N-2): a key right behind it would be Meta+key

  /** True while less than VIM_ESC_GAP_MS has passed since an Escape of Stop or End on the pane (N-2); a clock that went back counts as passed. */
  function escapeGap(pane) {
    const at = escapedAt.get(pane);
    if (at === undefined) return false;
    const passed = now() - at;
    if (passed >= 0 && passed < VIM_ESC_GAP_MS) return true;
    escapedAt.delete(pane);
    return false;
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

  const promptOpen = (rows) => promptFromRows(rows) !== null;

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
   */
  async function stop(pane) {
    const seen = await look(pane);
    if (seen.res) return seen.res;
    if (promptOpen(seen.rows)) return conflict('prompt-open');
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
      const t = now();
      for (const [k, v] of answered) if (t - v.at >= answerHoldMs) answered.delete(k);
      answered.set(pane, { sig, at: t });
      return { status: 200, body: { answered: n } };
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
   *                   Escape could interrupt a running turn (claude-tui.md section 5), Tab could accept a suggestion into a busy one
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
   * newline: only the new part is typed), a type (an empty box), or a replace (clear with Escape, then type). Every plan that
   * sends a key needs the cursor on a row of the box that was read (else 409 `input-unreadable`: that box may be a status
   * line). A replace needs the registry state `idle`: Escape interrupts a running turn, and no key goes out while Stop runs.
   * Before EVERY key or chunk a fresh capture must still show the plain box with the cursor in it, no prompt and exactly the
   * text the previous step left (409 `screen-changed` otherwise; T51; `trailing` is no exception). Chunks are at most 700 characters and 2 newlines, `chunkGapMs` apart. Last, the
   * box is read back (409 `draft-mismatch` on any difference). Sent: literal text (`send-keys -l`, or a bracketed paste for a
   * chunk with a newline or tab), `Escape` (idle only, vim: once, then `ggdG` and `i`; plain: twice, `escGapMs` apart),
   * `i` (a probe when nothing shows the edit mode), `C-u` (the probe's own `i` in an empty box) and `BSpace` (leaves a `!` box).
   * Never `Enter`, `C-c`, `Up`, `Down` or `BTab`, and no key within 40 ms after an `Escape`. Every answer that has a box carries
   * `draft` (the parse plus `edit`): 200 { draft, typed }, 409 not-idle | mode-unknown | input-unreadable | draft-unreadable { reason } |
   * draft-changed | screen-changed | draft-mismatch, 400 invalid, or a failed capture or key send's own status and body.
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
        if (second.draft.state !== 'empty' && (res = await press({ keys: ['Escape'] }))) return res;
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
      const state = await stateNow(pane);
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
      if (!empty && !append && state !== 'idle') return reply(409, 'not-idle', seen); // a replace clears with Escape
      let res;

      if (!append) {
        const was = onScreen; // what the box holds before the probe
        if (edit === 'normal' || edit === 'unknown') {
          edit = await probe();
          if (edit.res) return edit.res;
        }
        if (!empty) {
          if ((res = await (edit === 'insert' ? clearVim() : clearPlain()))) return res;
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
   * the plain keys route. Under the per-pane lock: the registry must say idle right now (fresh read) with no interrupt running; then one
   * fresh capture that must show the plain box in prompt mode, no permission prompt, the cursor inside the box, state `empty` and a
   * suggestion equal to `body.text` (anything else: 409 not-idle | mode-unknown | input-unreadable | draft-unreadable { reason } |
   * draft-changed, nothing sent). Then exactly one key, `Tab` (counts toward the per-pane key limit), and a read-back until the box reads
   * `text` equal to the suggestion: 200 { draft }, else 409 draft-mismatch { draft } (the Tab is never repeated). Never any other key:
   * no Enter (the page's Send does that), no Escape, no text. Every answer that has a box carries `draft`.
   */
  function acceptSuggestion(pane, body) {
    const bad = checkSuggestionBody(body);
    if (bad) return Promise.resolve(bad);
    const { text } = body;
    return exclusive(pane, async (ctx) => {
      const { view, reply, intake, press, idleNow } = draftTools(pane, ctx);
      let res = await idleNow();
      if (res) return res;
      const seen = await look(pane, ctx); // the one capture right before the key
      if (seen.res) return seen.res;
      const got = await intake(seen);
      if (got.res) return got.res;
      const { draft } = got;
      if (!cursorInBox(seen, draft)) return reply(409, 'input-unreadable', null); // that box may be a status line: nothing of it goes to the page
      if (draft.state !== 'empty' || draft.mode !== 'prompt' || draft.suggestion !== text) return reply(409, 'draft-changed', seen);
      if ((res = await press({ keys: ['Tab'] }))) return res;
      const back = await settled(pane, (rows, cap) => {
        const d = readDraft(cap);
        return d !== null && d.state === 'text' && d.mode === 'prompt' && sameDraft(d.text, text);
      }, ctx);
      if (back.res) return back.res;
      if (back.rows) return { status: 200, body: { draft: await view(back.seen) } };
      return reply(409, 'draft-mismatch', back.lastSeen);
    });
  }

  return { switchMode, endSession, runCommand, answer, stop, writeDraft, acceptSuggestion };
}
