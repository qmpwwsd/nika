// Four controls on a live Claude pane (api-app.md section 3): switch the permission mode, End the session, run a slash
// command, answer a permission prompt. They type into a real agent session, so every path fails closed: when the
// screen or the registry state is not exactly what the step needs, nothing is sent and the answer is a 409. Keys go only
// through `keys.send` (src/keys.js: fixed argv, KEY_NAME allow-list, rate limit); this module never kills a pane and
// never signals a process. Text is typed only into an empty input box and Enter is pressed only after the box reads
// exactly what nika typed (claude-tui.md section 5), so a user's draft is never sent, extended or cleared.
import { createHash } from 'node:crypto';
import { CLAUDE_COMMAND } from './ids.js';
import { MODE_TARGETS, OPTION, PROMPT_ROWS, bypassWindow, lastNonBlank, modeFromRows, promptFromRows, rowText } from './mode.js';
import { RULE_ROW } from './draft.js';

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
  const interrupting = new Set(); // panes whose Escape sequence is running: Stop and End share it, apart from the control lock
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

  /** Registry state; a lookup that fails reads as no live session, which is never idle. `opts` goes to stateOf (`{ fresh: true }`: skip its cache). */
  async function stateNow(pane, opts) {
    try {
      return await stateOf(pane, opts);
    } catch {
      return null;
    }
  }

  const promptOpen = (rows) => promptFromRows(rows) !== null;

  /** A fresh capture plus the registry state: { rows, state, idle } (idle = state idle and no permission prompt) or { res }. */
  async function readIdle(pane, ctx) {
    const seen = await look(pane, ctx);
    if (seen.res) return seen;
    const state = await stateNow(pane);
    return { rows: seen.rows, state, idle: state === 'idle' && !promptOpen(seen.rows) };
  }

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

  /** vim normal mode: types `i` and waits for `-- INSERT --`. Null when it shows, else { failed } or { res } (a stray `i` is removed first). */
  async function enterInsert(pane, ctx) {
    const sent = await keys.send(pane, { text: 'i' });
    if (sent.status !== 200) return { failed: sent };
    const shown = await settled(pane, insertShown, ctx);
    if (shown.res) return { failed: shown.res };
    if (shown.rows) return null;
    // vim was off: the i landed as text, and it is the only thing nika typed
    if (boxReads(inputBox(shown.last), 'i')) await keys.send(pane, { keys: ['C-u'] });
    return { res: conflict('mode-unknown') };
  }

  /**
   * Types `text` into Claude's input and presses Enter, for End and runCommand (claude-tui.md section 5). `rows` is the
   * fresh capture the caller has already checked (idle, footer readable); `ctx.insert` says whether any capture of this
   * action showed `-- INSERT --`. A box that is not found or does not start with a prompt row is 409 `input-unreadable`;
   * a box that holds anything but nothing or the placeholder is 409 `input-not-empty`. Returns null when Enter went out, { res } for a 409, or { failed } with the status and
   * body of the send or capture that failed. After a 409 `not-at-prompt` or a failed capture nika's own text is removed
   * as far as cleanUp can tell it apart from a draft; it may remain when a send fails, a capture fails or the box holds
   * something else. A stray `i` (vim was off) is removed with one C-u before the 409 `mode-unknown`.
   *
   * vim normal mode draws no marker, so when nothing says vim is on, a command (it starts with `/`) is probed: `/` alone
   * first. A plain input shows it, and the rest follows. In vim normal mode `/` opens a history search instead, which is
   * closed with one Escape before the usual vim road (`i`, INSERT, the whole text). Any other screen: nika's `/` is removed
   * and nothing else is sent.
   */
  async function typeCommand(pane, rows, text, ctx) {
    const box = inputBox(rows);
    // no box, or one that does not start with a prompt row (a menu, another screen): nika cannot tell a draft from nothing, so it types nothing
    if (inputRow(box?.[0]) === null) return { res: conflict('input-unreadable') };
    if (!boxIsEmpty(box)) return { res: conflict('input-not-empty') }; // a draft is never sent, extended or cleared
    let rest = text; // what is still to be typed
    // vim normal mode: the keys would be vim commands. Evidence of vim: the pane's memory, or INSERT seen in this action.
    if ((await vimOf(pane)) || ctx.insert) {
      const stopped = insertShown(rows) ? null : await enterInsert(pane, ctx);
      if (stopped) return stopped;
    } else if (text.startsWith('/')) {
      const slash = await keys.send(pane, { text: '/' });
      if (slash.status !== 200) return { failed: slash };
      const probed = await settled(pane, (seen) => boxReads(inputBox(seen), '/') || historyShown(seen), ctx);
      if (!probed.rows) {
        await cleanUp(pane, '/', ctx);
        return probed.res ? { failed: probed.res } : { res: conflict('not-at-prompt') };
      }
      if (boxReads(inputBox(probed.rows), '/')) {
        rest = text.slice(1);
      } else { // the history search: close it, then the usual vim road
        const esc = await keys.send(pane, { keys: ['Escape'] });
        if (esc.status !== 200) return { failed: esc };
        const back = await settled(pane, (seen) => boxIsEmpty(inputBox(seen)), ctx);
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
    const echoed = await settled(pane, (seen) => boxReads(inputBox(seen), text), ctx);
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
      if (modeFromRows(seen.rows) === 'unknown') return conflict('mode-unknown'); // a dialog may be open
      const typed = await typeCommand(pane, seen.rows, '/exit', ctx);
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

  return { switchMode, endSession, runCommand, answer, stop };
}
