// Three controls on a live Claude pane (api-app.md section 3): switch the permission mode, End the session, answer a
// permission prompt. They type into a real agent session, so every path fails closed: when the screen or the registry
// state is not exactly what the step needs, nothing is sent and the answer is a 409. Keys go only through `keys.send`
// (src/keys.js: fixed argv, KEY_NAME allow-list, rate limit); this module never kills a pane and never signals a process.
import { createHash } from 'node:crypto';
import { CLAUDE_COMMAND } from './ids.js';
import { MODE_TARGETS, PROMPT_ROWS, lastNonBlank, modeFromRows, promptFromRows } from './mode.js';

const EXIT_POLL_MS = 500;
// Same row shape as promptFromRows reads (src/mode.js): optional selection marker, `<n>. `.
const OPTION_ROW = /^\s*(?:❯\s*)?(\d{1,3})\.\s/;

const conflict = (error) => ({ status: 409, body: { error } });
const invalid = (message) => ({ status: 400, body: { error: 'invalid', message } });
const ended = (value) => ({ status: 200, body: { ended: value } });
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The prompt's identity: 16 hex chars of sha256 over the rows promptFromRows reads. Capture publishes it, answer checks it. */
export function promptSig(rows) {
  return createHash('sha256').update(lastNonBlank(rows, PROMPT_ROWS).join('\n')).digest('hex').slice(0, 16);
}

/**
 * The raw rows of option n (wrapped rows included), or null. promptFromRows cuts a label at 80 characters, so a
 * `bypass` further right would go unseen there: the answer route reads the raw rows as well.
 */
function rawOption(rows, n) {
  const win = lastNonBlank(rows, PROMPT_ROWS).slice(0, -1); // without the `Esc to cancel` row
  const first = win.findLastIndex((t) => OPTION_ROW.exec(t)?.[1] === '1');
  if (first < 0) return null;
  const groups = [];
  for (const t of win.slice(first)) {
    if (OPTION_ROW.test(t)) groups.push([t]);
    else groups.at(-1).push(t);
  }
  return groups[n - 1]?.join(' ') ?? null;
}

/**
 * mirror.capture(pane, undefined, { fresh }) → { status, body: { rows } }; keys.send(pane, { text?, keys? }) → { status, body };
 * paneCommand(pane) → Promise<string|null> (null = pane gone); stateOf(pane) → the live session's registry state or null.
 * One control action runs per pane at a time (switch, End and answer share one lock). Every method returns { status, body }.
 */
export function createSessionControl({
  mirror, keys, paneCommand, stateOf, now = Date.now, sleep = realSleep,
  pollMs = 300, settleMs = 1800, maxPresses = 6, escWaitMs = 1000, exitWaitMs = 3000, answerHoldMs = 3000,
}) {
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

  /** Step 4 of the mode route: a fresh capture of a pane whose session is idle and shows no prompt, else { res: 409 not-idle }. */
  async function idleLook(pane) {
    const seen = await look(pane);
    if (seen.res) return seen;
    if ((await stateNow(pane)) !== 'idle' || promptOpen(seen.rows)) return { res: conflict('not-idle') };
    return seen;
  }

  /** True only when the pane is gone or no longer runs claude. A failing lookup proves nothing, so it is false. */
  async function isGone(pane) {
    try {
      const cmd = await paneCommand(pane);
      return cmd === null || (typeof cmd === 'string' && !CLAUDE_COMMAND.test(cmd));
    } catch {
      return false;
    }
  }

  /** After a BTab: poll the footer until it shows a mode other than `before`; unreadable or unchanged at settleMs is mode-unknown. */
  async function settle(pane, before) {
    const t0 = now();
    for (;;) {
      await sleep(pollMs);
      const seen = await look(pane);
      const mode = seen.rows ? modeFromRows(seen.rows) : 'unknown'; // a failed capture reads as unknown: keep polling
      if (mode !== 'unknown' && mode !== before) return { mode };
      if (now() - t0 >= settleMs) return { res: conflict('mode-unknown') };
    }
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
        presses += 1;
        if (sent.status !== 200) return { status: sent.status, body: { ...sent.body, presses } };
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
      let seen = await look(pane);
      if (seen.res) return seen.res;
      if ((await stateNow(pane)) !== 'idle' || promptOpen(seen.rows)) {
        const esc = await keys.send(pane, { keys: ['Escape'] }); // cancels a turn or answers a prompt with No
        if (esc.status !== 200) return ended(await isGone(pane));
        await sleep(escWaitMs);
        seen = await look(pane);
        if (seen.res) return seen.res;
      }
      if (promptOpen(seen.rows)) return conflict('not-idle'); // End never answers a prompt
      if (modeFromRows(seen.rows) === 'unknown') return conflict('mode-unknown'); // a dialog may be open
      for (const body of [{ keys: ['C-u'] }, { text: '/exit' }, { keys: ['Enter'] }]) {
        const sent = await keys.send(pane, body);
        if (sent.status !== 200) return ended(await isGone(pane));
      }
      const t0 = now();
      for (;;) {
        await sleep(EXIT_POLL_MS);
        if (await isGone(pane)) return ended(true);
        if (now() - t0 >= exitWaitMs) return ended(false);
      }
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
      if (/bypass/i.test(`${option.label} ${raw}`)) return invalid('this option is answered in the terminal');
      const sent = await keys.send(pane, { text: String(n) }); // the digit alone answers; no Enter
      if (sent.status !== 200) return { status: sent.status, body: sent.body };
      const t = now();
      for (const [k, v] of answered) if (t - v.at >= answerHoldMs) answered.delete(k);
      answered.set(pane, { sig, at: t });
      return { status: 200, body: { answered: n } };
    });
  }

  return { switchMode, endSession, answer };
}
