// Four controls on a live Claude pane (api-app.md section 3): switch the permission mode, End the session, run a slash
// command, answer a permission prompt. They type into a real agent session, so every path fails closed: when the
// screen or the registry state is not exactly what the step needs, nothing is sent and the answer is a 409. Keys go only
// through `keys.send` (src/keys.js: fixed argv, KEY_NAME allow-list, rate limit); this module never kills a pane and
// never signals a process. Text is typed only into an empty input box and Enter is pressed only after the box reads
// exactly what nika typed (claude-tui.md section 5), so a user's draft is never sent, extended or cleared.
import { createHash } from 'node:crypto';
import { CLAUDE_COMMAND } from './ids.js';
import { MODE_TARGETS, OPTION, PROMPT_ROWS, lastNonBlank, modeFromRows, promptFromRows, rowText } from './mode.js';

const EXIT_POLL_MS = 500;
// A rule row of Claude's input box: made only of box-drawing dashes. The box is what lies between the last two.
const RULE_ROW = /^─+$/;
const PROMPT_CHAR = '❯';
// Claude draws a no-break space after the prompt character (claude-tui.md section 5): for comparing, it is a space.
const plain = (text) => text.replace(/\xa0/g, ' ');
const INSERT_PREFIX = /^\s{0,2}-- INSERT --/;
const CLEAN_ROUNDS = 6; // C-u clears one visual row, so a wrapped line takes one round per row

const conflict = (error) => ({ status: 409, body: { error } });
const invalid = (message) => ({ status: 400, body: { error: 'invalid', message } });
const ended = (value) => ({ status: 200, body: { ended: value } });
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Number of waits of `stepMs` that cover `totalMs` (at least one): every wait loop is bounded by this count, never by a clock. */
const steps = (totalMs, stepMs) => Math.max(1, Math.ceil(totalMs / stepMs));
// Letters only, after NFKC, lower-cased: case, width, spacing, punctuation and invisible characters cannot hide the word.
const mentionsBypass = (text) => text.normalize('NFKC').replace(/[^\p{L}]/gu, '').toLowerCase().includes('bypass');

/** The prompt's identity: 16 hex chars of sha256 over the rows promptFromRows reads. Capture publishes it, answer checks it. */
export function promptSig(rows) {
  return createHash('sha256').update(lastNonBlank(rows, PROMPT_ROWS).join('\n')).digest('hex').slice(0, 16);
}

/** The rows (span lists, styles kept) between the last two rule rows (the input box), or null when the screen has fewer than two. */
function inputBox(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const rules = list.flatMap((row, i) => (RULE_ROW.test(rowText(row).trim()) ? [i] : []));
  return rules.length < 2 ? null : list.slice(rules.at(-2) + 1, rules.at(-1));
}

/**
 * One input row: after the optional indent it starts with the prompt character. Returns whether exactly one space
 * (no-break spaces count as spaces) follows it (`spaced`), the characters after that separator (`body`, each with its
 * dim and reverse-video flag), their visible (non-space) ones (`shown`), whether any of them is dim, and the text after
 * the prompt character with the surrounding spaces trimmed. Null when the row is not an input row.
 */
function inputRow(row) {
  const chars = [];
  for (const sp of Array.isArray(row) ? row : []) {
    const dim = sp?.s?.d === true;
    const rev = sp?.s?.r === true;
    for (const ch of typeof sp?.t === 'string' ? sp.t : '') chars.push({ ch: plain(ch), dim, rev });
  }
  let at = 0;
  while (chars[at]?.ch === ' ') at += 1;
  if (chars[at]?.ch !== PROMPT_CHAR) return null;
  const rest = chars.slice(at + 1);
  const spaced = rest.length === 0 || rest[0].ch === ' ';
  const body = spaced ? rest.slice(1) : rest;
  const shown = body.filter((c) => c.ch !== ' ');
  return {
    spaced,
    body,
    shown,
    anyDim: shown.some((c) => c.dim),
    text: rest.map((c) => c.ch).join('').replace(/^ +| +$/g, ''),
  };
}

/**
 * Exactly one row: the prompt character, a separator space, then nothing or whitespace (a reverse-video space is
 * Claude's cursor), or the placeholder: dim text, whose first character may be reverse video (the cursor over it) and
 * then not dim. Any other visible character is a draft (typed text is never dim, whatever it says).
 */
function boxIsEmpty(box) {
  const row = box?.length === 1 ? inputRow(box[0]) : null;
  if (row === null || !row.spaced) return false;
  const tail = row.shown[0]?.rev ? row.shown.slice(1) : row.shown;
  return row.shown.length === 0 || (tail.length > 0 && tail.every((c) => c.dim));
}

/** Exactly one row: the prompt character, exactly one separator, then exactly `text` in plain (not dim) characters, then only whitespace. */
function boxReads(box, text) {
  const row = box?.length === 1 ? inputRow(box[0]) : null;
  return row !== null && row.spaced && !row.anyDim && row.body.map((c) => c.ch).join('').replace(/ +$/, '') === plain(text).replace(/ +$/, '');
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
 * mirror.capture(pane, undefined, { fresh }) → { status, body: { rows } }; keys.send(pane, { text?, keys? }) → { status, body };
 * paneCommand(pane) → Promise<string|null> (null = pane gone); stateOf(pane) → the live session's registry state or null;
 * vimOf(pane) → boolean: this pane's mode line has shown `-- INSERT --` before (Claude's input is in vim mode).
 * One control action runs per pane at a time (switch, End, command and answer share one lock). Every method returns { status, body }.
 */
export function createSessionControl({
  mirror, keys, paneCommand, stateOf, vimOf, now = Date.now, sleep = realSleep,
  pollMs = 300, settleMs = 1800, maxPresses = 6, escWaitMs = 1000, exitWaitMs = 3000, answerHoldMs = 3000,
  settleTries = 4, settlePollMs = 150,
}) {
  // Typing without knowing whether the input is in vim normal mode could send stray vim commands, so there is no default.
  if (typeof vimOf !== 'function') throw new TypeError('vimOf must be a function (pane) => boolean');
  const running = new Set(); // panes with a control action in progress
  const answered = new Map(); // pane → { sig, at } of the last successful answer

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

  /** A fresh capture: { rows } or { res } (the failed capture's own status and body). */
  async function look(pane, ctx) {
    const cap = await mirror.capture(pane, undefined, { fresh: true });
    if (cap.status !== 200) return { res: { status: cap.status, body: cap.body } };
    if (ctx && insertShown(cap.body.rows)) ctx.insert = true;
    return { rows: cap.body.rows };
  }

  /** Registry state; a lookup that fails reads as no live session, which is never idle. */
  async function stateNow(pane) {
    try {
      return await stateOf(pane);
    } catch {
      return null;
    }
  }

  const promptOpen = (rows) => promptFromRows(rows) !== null;

  /** A fresh capture plus the registry state: { rows, idle } (idle = state idle and no permission prompt) or { res }. */
  async function readIdle(pane, ctx) {
    const seen = await look(pane, ctx);
    if (seen.res) return seen;
    return { rows: seen.rows, idle: (await stateNow(pane)) === 'idle' && !promptOpen(seen.rows) };
  }

  /** Step 4 of the mode route: an idle pane's fresh capture, else { res: 409 not-idle }. */
  async function idleLook(pane) {
    const seen = await readIdle(pane);
    return seen.res || seen.idle ? seen : { res: conflict('not-idle') };
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

  /** After a BTab: read the footer up to settleMs / pollMs times until it shows a mode other than `before`; unreadable or unchanged is mode-unknown. */
  async function settle(pane, before) {
    for (let i = 0; i < steps(settleMs, pollMs); i += 1) {
      await sleep(pollMs);
      const seen = await look(pane);
      const mode = seen.rows ? modeFromRows(seen.rows) : 'unknown'; // a failed capture reads as unknown: keep polling
      if (mode !== 'unknown' && mode !== before) return { mode };
    }
    return { res: conflict('mode-unknown') };
  }

  /**
   * After a keystroke Claude redraws its input a few hundred ms later: up to settleTries fresh captures, `sleep(settlePollMs)`
   * before each, until `matches(rows)`. Returns { rows, last } for the first match, { res, last } when a capture fails,
   * { last } when none matched (`last` = rows of the last capture that worked).
   */
  async function settled(pane, matches, ctx) {
    let last;
    for (let i = 0; i < Math.max(1, settleTries); i += 1) {
      await sleep(settlePollMs);
      const seen = await look(pane, ctx);
      if (seen.res) return { res: seen.res, last };
      last = seen.rows;
      if (matches(last)) return { rows: last, last };
    }
    return { last };
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
      if (box !== null && boxIsEmpty(box)) { // maybe Claude has not redrawn yet: look once more
        await sleep(settlePollMs);
        seen = await look(pane, ctx);
        if (seen.res) return;
        box = inputBox(seen.rows);
      }
      if (box === null || box.length === 0 || boxIsEmpty(box) || !isRemnant(box, typed)) return;
      if ((await keys.send(pane, { keys: ['C-u'] })).status !== 200) return;
    }
  }

  /**
   * Types `text` into Claude's input and presses Enter, for End and runCommand (claude-tui.md section 5). `rows` is the
   * fresh capture the caller has already checked (idle, footer readable); `ctx.insert` says whether any capture of this
   * action showed `-- INSERT --`. Returns null when Enter went out, { res } for a 409, or { failed } with the status and
   * body of the send or capture that failed. After a 409 `not-at-prompt` or a failed capture nika's own text is removed
   * as far as cleanUp can tell it apart from a draft; it may remain when a send fails, a capture fails or the box holds
   * something else. A stray `i` (vim was off) is removed with one C-u before the 409 `mode-unknown`.
   */
  async function typeCommand(pane, rows, text, ctx) {
    if (!boxIsEmpty(inputBox(rows))) return { res: conflict('input-not-empty') }; // a draft is never sent, extended or cleared
    // vim normal mode: the keys would be vim commands. Evidence of vim: the pane's memory, or INSERT seen in this action.
    if (((await vimOf(pane)) || ctx.insert) && !insertShown(rows)) {
      const sent = await keys.send(pane, { text: 'i' });
      if (sent.status !== 200) return { failed: sent };
      const shown = await settled(pane, insertShown, ctx);
      if (shown.res) return { failed: shown.res };
      if (!shown.rows) {
        // vim was off: the i landed as text, and it is the only thing nika typed
        if (boxReads(inputBox(shown.last), 'i')) await keys.send(pane, { keys: ['C-u'] });
        return { res: conflict('mode-unknown') };
      }
    }
    const sent = await keys.send(pane, { text });
    if (sent.status !== 200) return { failed: sent };
    const echoed = await settled(pane, (seen) => boxReads(inputBox(seen), text), ctx);
    if (!echoed.rows) {
      await cleanUp(pane, text, ctx);
      return echoed.res ? { failed: echoed.res } : { res: conflict('not-at-prompt') };
    }
    const enter = await keys.send(pane, { keys: ['Enter'] });
    return enter.status === 200 ? null : { failed: enter };
  }

  function switchMode(pane, target) {
    if (!MODE_TARGETS.includes(target)) return Promise.resolve(invalid(`target must be one of ${MODE_TARGETS.join(', ')}`));
    return exclusive(pane, async () => {
      let presses = 0;
      let start = null;
      let seen = await idleLook(pane);
      for (;;) { // each round: classify what is on screen now, press once, wait for the footer to change
        if (seen.res) return seen.res;
        const mode = modeFromRows(seen.rows);
        if (mode === 'unknown') return conflict('mode-unknown'); // never press blind
        if (mode === target) return { status: 200, body: { mode, presses } };
        if (mode === 'dontAsk') return conflict('not-in-cycle'); // nika never switches to or from it
        start ??= mode;
        const sent = await keys.send(pane, { keys: ['BTab'] });
        if (sent.status !== 200) return { status: sent.status, body: { ...sent.body, presses } };
        presses += 1;
        const next = await settle(pane, mode);
        if (next.res) return next.res;
        if (next.mode === target) return { status: 200, body: { mode: next.mode, presses } };
        if (next.mode === start || presses >= maxPresses) return conflict('not-in-cycle');
        seen = await idleLook(pane); // the registry state is read again before every press
      }
    });
  }

  function endSession(pane) {
    return exclusive(pane, async (ctx) => {
      let seen = await readIdle(pane, ctx);
      if (seen.res) return seen.res;
      if (!seen.idle) {
        const esc = await keys.send(pane, { keys: ['Escape'] }); // cancels a turn or answers a prompt with No
        if (esc.status !== 200) return ended(await isGone(pane));
        await sleep(escWaitMs);
        seen = await readIdle(pane, ctx);
        if (seen.res) return seen.res;
        if (!seen.idle) return conflict('not-idle'); // End never answers a prompt
      }
      if (modeFromRows(seen.rows) === 'unknown') return conflict('mode-unknown'); // a dialog may be open
      const typed = await typeCommand(pane, seen.rows, '/exit', ctx);
      if (typed?.res) return typed.res;
      if (typed?.failed) return ended(await isGone(pane));
      for (let i = 0; i < steps(exitWaitMs, EXIT_POLL_MS); i += 1) {
        await sleep(EXIT_POLL_MS);
        if (await isGone(pane)) return ended(true);
      }
      return ended(false);
    });
  }

  function runCommand(pane, text) {
    if (typeof text !== 'string' || text.trim() === '') return Promise.resolve(invalid('text must be a non-empty string'));
    return exclusive(pane, async (ctx) => {
      const seen = await readIdle(pane, ctx); // no Escape here: Stop is its own button
      if (seen.res) return seen.res;
      if (!seen.idle) return conflict('not-idle');
      if (modeFromRows(seen.rows) === 'unknown') return conflict('mode-unknown');
      const typed = await typeCommand(pane, seen.rows, text, ctx);
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
      if (mentionsBypass(`${option.label} ${raw}`)) return invalid('this option is answered in the terminal');
      const sent = await keys.send(pane, { text: String(n) }); // the digit alone answers; no Enter
      if (sent.status !== 200) return { status: sent.status, body: sent.body };
      const t = now();
      for (const [k, v] of answered) if (t - v.at >= answerHoldMs) answered.delete(k);
      answered.set(pane, { sig, at: t });
      return { status: 200, body: { answered: n } };
    });
  }

  return { switchMode, endSession, runCommand, answer };
}
