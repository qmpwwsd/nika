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
// The empty input row: the prompt character alone, or followed by the placeholder (`Try "..."`).
const EMPTY_INPUT = /^❯(?: Try ".*)?$/;
const INSERT_PREFIX = /^\s{0,2}-- INSERT --/;

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

/** The trimmed rows between the last two rule rows (the input box), or null when the screen has fewer than two. */
function inputBox(rows) {
  const texts = (Array.isArray(rows) ? rows : []).map((row) => rowText(row).trim());
  const rules = texts.flatMap((t, i) => (RULE_ROW.test(t) ? [i] : []));
  return rules.length < 2 ? null : texts.slice(rules.at(-2) + 1, rules.at(-1));
}

const boxIsEmpty = (box) => box !== null && box.length === 1 && EMPTY_INPUT.test(box[0]);
const boxReads = (box, text) => box !== null && box.length === 1 && box[0] === `❯ ${text}`.trim();
const insertShown = (rows) => INSERT_PREFIX.test(lastNonBlank(rows, 1)[0] ?? '');

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

  async function exclusive(pane, action) {
    if (running.has(pane)) return conflict('busy-switching');
    running.add(pane);
    try {
      return await action();
    } finally {
      running.delete(pane);
    }
  }

  /** A fresh capture: { rows } or { res } (the failed capture's own status and body). */
  async function look(pane) {
    const cap = await mirror.capture(pane, undefined, { fresh: true });
    return cap.status === 200 ? { rows: cap.body.rows } : { res: { status: cap.status, body: cap.body } };
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
  async function readIdle(pane) {
    const seen = await look(pane);
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
   * before each, until `matches(rows)`. Returns { rows } of the first match, { res } when a capture fails, {} when none matched.
   */
  async function settled(pane, matches) {
    for (let i = 0; i < Math.max(1, settleTries); i += 1) {
      await sleep(settlePollMs);
      const seen = await look(pane);
      if (seen.res || matches(seen.rows)) return seen;
    }
    return {};
  }

  /**
   * Types `text` into Claude's input and presses Enter, for End and runCommand (claude-tui.md section 5). `rows` is the
   * fresh capture the caller has already checked (idle, footer readable). Returns null when Enter went out,
   * { res } for a 409 (nothing left typed), or { failed } with the status and body of the send or capture that failed.
   */
  async function typeCommand(pane, rows, text) {
    if (!boxIsEmpty(inputBox(rows))) return { res: conflict('input-not-empty') }; // a draft is never sent, extended or cleared
    if ((await vimOf(pane)) && !insertShown(rows)) { // vim normal mode: the keys would be vim commands
      const sent = await keys.send(pane, { text: 'i' });
      if (sent.status !== 200) return { failed: sent };
      const shown = await settled(pane, insertShown);
      if (shown.res) return { failed: shown.res };
      if (!shown.rows) return { res: conflict('mode-unknown') };
    }
    const typed = await keys.send(pane, { text });
    if (typed.status !== 200) return { failed: typed };
    const echoed = await settled(pane, (seen) => boxReads(inputBox(seen), text));
    if (!echoed.rows) {
      await keys.send(pane, { keys: ['C-u'] }); // removes what nika typed: the box was empty
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
    return exclusive(pane, async () => {
      let seen = await readIdle(pane);
      if (seen.res) return seen.res;
      if (!seen.idle) {
        const esc = await keys.send(pane, { keys: ['Escape'] }); // cancels a turn or answers a prompt with No
        if (esc.status !== 200) return ended(await isGone(pane));
        await sleep(escWaitMs);
        seen = await readIdle(pane);
        if (seen.res) return seen.res;
        if (!seen.idle) return conflict('not-idle'); // End never answers a prompt
      }
      if (modeFromRows(seen.rows) === 'unknown') return conflict('mode-unknown'); // a dialog may be open
      const typed = await typeCommand(pane, seen.rows, '/exit');
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
    return exclusive(pane, async () => {
      const seen = await readIdle(pane); // no Escape here: Stop is its own button
      if (seen.res) return seen.res;
      if (!seen.idle) return conflict('not-idle');
      if (modeFromRows(seen.rows) === 'unknown') return conflict('mode-unknown');
      const typed = await typeCommand(pane, seen.rows, text);
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
