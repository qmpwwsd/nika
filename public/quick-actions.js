// The session window's quick actions, prompt buttons, End dialog and Shell mode: the rules and the exact copy, with no DOM and
// no requests, so Node tests them (test/quick-actions.test.js). session.js and end-dialog.js only draw what these return.
// Design: docs/design/spec.md section 9.4 (states table, command-route failures), 9.5 (answer results), 9.6 (Shell), 9.8 (End).
// Contract: docs/contracts/api-app.md section 3. Messages are fixed copy: server text never reaches them (the server's `error` code
// picks a line, nothing else is shown).

const DOTS = String.fromCharCode(0x2026);

const WHY = {
  gone: 'The pane is gone.',
  tmux: "nika couldn't reach tmux.",
  connecting: `Connecting to the pane${DOTS}`,
  promptShown: 'Answer the prompt first. Esc = No is in the prompt panel.',
  prompt: 'Answer the prompt first.',
  working: 'Compact, Clear, Model and Rewind are ready when Claude waits for you.',
  text: 'Rewind needs an empty message box.',
};

const TITLE = {
  stop: 'Press Esc in the pane: ends this turn, keeps the work, also stops running subagents',
  stopIdle: 'Nothing to stop: Claude is waiting',
  stopPrompt: 'Esc = No is in the prompt panel',
  stopAttn: 'Answer the prompt first; Esc is in the key row below',
  compact: 'Types /compact and Enter: summarises the conversation to free context',
  clear: 'Types /clear and Enter after you confirm',
  model: 'Switch the model',
  rewind: "Esc Esc on an empty prompt: opens Claude's rewind menu in the terminal",
  idleOnly: 'Available when Claude is waiting for you',
  emptyFirst: 'Empty the message box first',
  end: 'Claude exits and the pane closes',
  endGone: 'The pane is gone',
};

/**
 * Which quick actions are live and why the others are not (spec 9.4, the first matching row wins). Inputs: `pane` ('ok' | 'gone' |
 * 'tmux' | 'connecting'), `status` (the agent's 'attn' | 'idle' | 'busy' | 'ended', null while unknown: the route then decides and
 * answers 409 not-idle), `prompt` (the capture's prompt or null), `composerEmpty`, `switching` (a mode switch from this window is
 * in flight). Output: for each button { off (aria-disabled), title }, and `reason` ('' = no reason line).
 */
export function quickState({ pane = 'ok', status = null, prompt = null, composerEmpty = true, switching = false } = {}) {
  const b = (off, title) => ({ off, title });
  const gated = (live, title) => b(!live, live ? title : TITLE.idleOnly); // live only while Claude waits
  if (pane !== 'ok') {
    const why = WHY[pane] ?? WHY.gone;
    return {
      stop: b(true, why), compact: b(true, why), clear: b(true, why), model: b(true, why), rewind: b(true, why),
      end: b(true, pane === 'gone' ? TITLE.endGone : why), reason: why,
    };
  }
  const end = b(false, TITLE.end);
  const allOff = (stop, reason) => ({
    stop: b(true, stop), compact: gated(false), clear: gated(false), model: gated(false), rewind: gated(false), end, reason,
  });
  if (prompt) return allOff(TITLE.stopPrompt, WHY.promptShown);
  if (status === 'attn') return allOff(TITLE.stopAttn, WHY.prompt);
  if (status === 'busy') return { ...allOff(TITLE.stopIdle, WHY.working), stop: b(false, TITLE.stop) };
  if (status === 'ended') return allOff(TITLE.stopIdle, WHY.working);
  const live = !switching; // idle, or not known yet: the route checks
  const rewindLive = live && composerEmpty;
  return {
    stop: b(true, TITLE.stopIdle),
    compact: gated(live, TITLE.compact),
    clear: gated(live, TITLE.clear),
    model: gated(live, TITLE.model),
    rewind: live && !composerEmpty ? b(true, TITLE.emptyFirst) : gated(rewindLive, TITLE.rewind),
    end,
    reason: live && !composerEmpty ? WHY.text : '',
  };
}

/** An option whose label contains "bypass" (any case) gets no button: nika never answers it (rule 12). */
export const isBypassLabel = (label) => typeof label === 'string' && /bypass/i.test(label);

const SIG = /^[0-9a-f]{16}$/;
const LABEL_MAX = 200;

/**
 * The capture's `prompt` as the page may use it, or null: { question, options: [{ n, label, bypass }], sig }. Anything that is not
 * exactly the contract shape (a 16-hex sig, a string question, options numbered 1-9 with a string label) gives null, and one bad
 * option is dropped. Copies the data: the capture object is not kept.
 */
export function cleanPrompt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { question, options, sig } = raw;
  if (typeof question !== 'string' || typeof sig !== 'string' || !SIG.test(sig) || !Array.isArray(options)) return null;
  const list = options
    .filter((o) => o && typeof o === 'object' && Number.isInteger(o.n) && o.n >= 1 && o.n <= 9 && typeof o.label === 'string')
    .map((o) => ({ n: o.n, label: o.label.slice(0, LABEL_MAX), bypass: isBypassLabel(o.label) })); // the check sees the whole label
  return list.length ? { question: question.slice(0, LABEL_MAX), options: list, sig } : null;
}

/** What the polite region says when a prompt appears (spec 9.5). */
export function promptNote(name, prompt) {
  const n = prompt.options.length;
  return `${name} asks: ${prompt.question} ${n} ${n === 1 ? 'choice' : 'choices'} above the message box.`;
}

const BUSY = 'Another action is running on this session.';
const RATE = 'Too many keys at once; try again.';
const GONE = 'The session is gone.';
const TMUX = WHY.tmux;
const unreachable = (status) => status === 0 || status >= 500;

/** 'error' for what the user cannot fix from here (gone, tmux), 'warn' for what a retry or a look at the session can. */
export const problemKind = (status) => (status === 404 || unreachable(status) ? 'error' : 'warn');

/**
 * The answer route's result (spec 9.5): the message for the problem line ('' = none) and whether the buttons stay off until the
 * question changes (`lock`). 200, prompt-changed and already-answered lock; every other answer re-enables them.
 */
export function answerOutcome({ status, code } = {}) {
  if (status === 200) return { message: '', lock: true };
  if (status === 409 && code === 'prompt-changed') return { message: 'The question changed; check the session.', lock: true };
  if (status === 409 && code === 'already-answered') return { message: '', lock: true };
  if (status === 409 && code === 'no-prompt') return { message: 'The question is gone.', lock: false };
  if (status === 409 && code === 'busy-switching') return { message: BUSY, lock: false };
  if (status === 429) return { message: RATE, lock: false };
  if (status === 404) return { message: GONE, lock: false };
  if (unreachable(status)) return { message: TMUX, lock: false };
  return { message: "nika couldn't send that answer.", lock: false };
}

/** Esc = No goes through the keys route: a 200 locks the question like an answered option; any other result re-enables the buttons. */
export const escOutcome = ({ ok } = {}) => ({ lock: ok === true });

/** The option buttons and Esc = No are off while a request is in flight and for the question that was already answered (`lock` = its sig). */
export const promptOff = ({ pending = false, lock = null, sig = null } = {}) => pending || (lock !== null && lock === sig);

/** The command route's failures (spec 9.4), for Compact, Clear and Model. */
export function commandFailure({ status, code } = {}) {
  if (status === 409) {
    if (code === 'input-not-empty') return "Claude's input has text; clear it first.";
    if (code === 'not-at-prompt') return "Claude's input didn't take the command; nothing was submitted.";
    if (code === 'not-idle') return WHY.working;
    if (code === 'mode-unknown') return "Claude's screen isn't at the prompt; use the terminal.";
    if (code === 'busy-switching') return BUSY;
  }
  if (status === 429) return RATE;
  if (status === 404) return GONE;
  if (unreachable(status)) return TMUX;
  return "nika couldn't send that command.";
}

/** The End route's result (spec 9.8): { ended: true, text: '' } closes the dialog; otherwise `text` goes in the alert slot. */
export function endOutcome({ status, code, ended } = {}) {
  if (status === 200) return ended === true ? { ended: true, text: '' } : { ended: false, text: "Claude didn't exit; use Stop or the terminal." };
  const no = (text) => ({ ended: false, text });
  if (status === 409) {
    if (code === 'not-idle') return no("Claude didn't stop after Esc; use the terminal.");
    if (code === 'mode-unknown') return no("Claude's screen isn't at the prompt; use the terminal.");
    if (code === 'input-not-empty') return no("Claude's input has text; clear it first.");
    if (code === 'not-at-prompt') return no("Claude's input didn't take /exit; nothing was submitted.");
    if (code === 'busy-switching') return no(BUSY);
  }
  if (status === 429) return no(RATE);
  if (status === 404) return no(GONE);
  if (unreachable(status)) return no(TMUX);
  return no("nika couldn't end the session.");
}

/** The muted line under the End dialog's body; a prompt wins over working (Esc there answers No). */
export function endNote({ working = false, promptOpen = false } = {}) {
  if (promptOpen) return 'Claude is asking a question. nika presses Esc first, which answers No.';
  if (working) return 'Claude is working. nika presses Esc first to end the turn, then ends the session.';
  return '';
}

const TEXT_MAX = 1024; // the keys route's `text` limit; the "!" counts
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * What Enter does while Shell is on (spec 9.6), in the shape of planSend: `{ ok: true, empty: true }` (nothing is sent, no lone
 * "!"), `{ ok: false, message }` (the text is kept) or `{ ok: true, payloads, summary }` with the three keys-route bodies in
 * order: Ctrl-U, "!" + the command, Enter. The command is one line: the route refuses control characters in `text`.
 */
export function planShell(value) {
  const v = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (v.trim() === '') return { ok: true, empty: true };
  if (v.includes('\n')) return { ok: false, message: 'Shell mode sends one line. Remove the line breaks or turn Shell off. Your text is kept.' };
  if (CONTROL.test(v)) return { ok: false, message: 'Shell mode cannot send control characters. Your text is kept.' };
  if (v.length + 1 > TEXT_MAX) return { ok: false, message: `A shell command can be at most ${TEXT_MAX - 1} characters. Shorten it. Your text is kept.` };
  return { ok: true, payloads: [{ keys: ['C-u'] }, { text: `!${v}` }, { keys: ['Enter'] }], summary: `a shell command (${v.length} characters) + Enter` };
}
