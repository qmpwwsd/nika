// Permission modes in the UI (docs/design/spec.md section 2.8 and 9.3; contract: docs/contracts/api-app.md section 3).
// Pure parts, tested in Node (test/modes-ui.test.js): MODE_META, switcherState (which segments are live and why not),
// modeNote (what the polite region says when the mode changes), switchFailure (what a failed switch says).
// The dashboard's parts (parseModes, modesAfter, rowMode, canEndRow: the /api/app/modes poll, a row's tag and its End item) are pure too.
// DOM part: modeEl, the tag. Every string is set as a text node or an attribute, never parsed as markup.
// Every mode has its own colour (tokens.css), icon (the #i-m-* symbols in the page's sprite) and word: never colour alone.
import { h, icon } from './dom.js';

const DOTS = String.fromCharCode(0x2026);

/** API mode -> { label, icon: name for icon() (symbol #i-<icon>), cls: class that sets the --mc trio in tokens.css }. */
export const MODE_META = {
  manual: { label: 'Manual', icon: 'm-manual', cls: 'm-manual' },
  acceptEdits: { label: 'Accept edits', icon: 'm-edits', cls: 'm-edits' },
  plan: { label: 'Plan', icon: 'm-plan', cls: 'm-plan' },
  auto: { label: 'Auto', icon: 'm-auto', cls: 'm-auto' },
  bypassPermissions: { label: 'Bypass', icon: 'm-bypass', cls: 'm-bypass' },
  dontAsk: { label: "Don't ask", icon: 'm-dontask', cls: 'm-dontask' },
  unknown: { label: 'Mode ?', icon: 'm-unknown', cls: 'm-unknown' },
};

/** The switcher's segments, in order: what the mode route accepts as a target. Bypass and Don't ask are never targets. */
export const MODE_TARGETS = ['manual', 'acceptEdits', 'plan', 'auto'];

/** A mode from the server, or `unknown` for anything that is not exactly one of ours (also prototype names). */
export const modeKey = (raw) => (typeof raw === 'string' && Object.hasOwn(MODE_META, raw) ? raw : 'unknown');

/* ---------- dashboard (GET /api/app/modes: one { mode, confirmed } per eligible pane) ---------- */
const PANE_ID = /^%\d{1,6}$/;

/** The answer as a clean map { "%3": { mode, confirmed } }, or null when the body is not one (that counts as a failed poll). */
export function parseModes(body) {
  const raw = body?.modes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const map = {};
  for (const [id, e] of Object.entries(raw)) {
    if (PANE_ID.test(id) && e && typeof e === 'object') map[id] = { mode: modeKey(e.mode), confirmed: e.confirmed === true };
  }
  return map;
}

/** The poll state after one poll: `map` is parseModes' result, null for a failed poll. One failure keeps the last map, the next clears it. */
export function modesAfter(prev, map) {
  if (map) return { map, misses: 0 };
  const misses = (prev?.misses ?? 0) + 1;
  return { map: misses > 1 ? {} : prev?.map ?? {}, misses };
}

/** The mode entry of an agent's row: only a live agent whose pane is in the latest answer (an ended agent's old pane id may be reused). */
export function rowMode(agent, map) {
  const id = agent?.live ? agent.pane?.id : null;
  return typeof id === 'string' && map && Object.hasOwn(map, id) ? map[id] : null;
}

/** "End session..." is offered exactly where the row shows a mode: the pane is one nika can type into. */
export const canEndRow = (agent, map) => rowMode(agent, map) !== null;

const BYPASS_NOTE = 'Claude runs every tool without asking.';

/** The Bypass tag, for the loud line of a switch that left Claude in Bypass. The mode is named once, in MODE_META (found by its class). */
export const bypassTag = () => modeEl(Object.keys(MODE_META).find((k) => MODE_META[k].cls === 'm-bypass'));

/**
 * The mode tag: span.mode.<cls>[data-confirmed][title] > icon + sr-only "Permission mode: " + label (+ "unconfirmed").
 * Default: icon + label (+ the word). compact: the word moves to sr-only, after a comma ("Accept edits, unconfirmed"). iconOnly: the label moves to sr-only too.
 */
export function modeEl(mode, { confirmed = true, compact = false, iconOnly = false } = {}) {
  const meta = MODE_META[modeKey(mode)];
  const sure = confirmed === true;
  const title = `Permission mode: ${meta.label}${sure ? '' : " (not confirmed: Claude's footer is covered or not shown yet)"}`;
  const quiet = compact || iconOnly;
  return h('span', { class: `mode ${meta.cls}${iconOnly ? ' icon-only' : ''}`, 'data-confirmed': String(sure), title },
    icon(meta.icon),
    h('span', { class: 'sr-only', text: 'Permission mode: ' }),
    h('span', { class: iconOnly ? 'sr-only' : 'ml', text: meta.label }),
    !sure && (quiet ? h('span', { class: 'sr-only', text: ', unconfirmed' }) : h('span', { class: 'mnote', text: 'unconfirmed' })));
}

// Exact copy of the reason line (spec 9.3). Results of a switch reuse the lines that say the same thing.
const WHY = {
  gone: 'The pane is gone.',
  tmux: "nika couldn't reach tmux.",
  connecting: `Connecting to the pane${DOTS}`,
  prompt: 'Answer the prompt first.',
  working: 'Switch when Claude is waiting for you.',
  unconfirmed: 'Waiting for Claude to confirm the mode.',
  unknown: "nika can't read the mode.",
  unknownUse: "nika can't read the mode. Use the terminal.",
  dontAsk: "Don't ask is on. Change it in the terminal.",
  switching: `Switching${DOTS} up to 6 Shift-Tab presses.`,
  unreadAfterPress: "nika can't read the mode after pressing Shift-Tab. Check the terminal: the session may be in any mode, including Bypass permissions.",
  stoppedInBypass: 'Stopped at Bypass permissions: Claude runs tools without asking. Press Shift-Tab in the terminal to leave it.',
};

/**
 * What the switcher shows (spec 9.3, the first reason that applies wins). Inputs: `pane` ('ok' | 'gone' | 'tmux' |
 * 'connecting'), `status` (the agent's 'attn' | 'idle' | 'busy' | 'ended', null while unknown: the server then decides and
 * answers 409 not-idle), `prompt` (capture field or null), `mode` and `modeConfirmed` (capture fields), `switching` (the
 * target of a switch in flight, else null). Output: `disabled` (every segment aria-disabled), `pressed` and `held` (a
 * target or null; held = dashed, not pressed), `reason` ('' = no reason line), `chip` (always null: nika does not offer
 * Shift-Tab when it cannot read the mode, because that could move a session it knows nothing about), `busy` (the segment with the spinner).
 */
export function switcherState({ pane = 'ok', status = null, prompt = null, mode = 'unknown', modeConfirmed = true, switching = null } = {}) {
  const off = (reason, over) => ({ disabled: true, pressed: null, held: null, reason, chip: null, busy: null, ...over });
  if (pane === 'gone') return off(WHY.gone);
  if (pane === 'tmux') return off(WHY.tmux);
  if (pane === 'connecting') return off(WHY.connecting);
  const key = modeKey(mode);
  const seg = MODE_TARGETS.includes(key) ? key : null; // Bypass, Don't ask and unknown have no segment
  const sure = modeConfirmed === true;
  const shown = sure ? { pressed: seg } : { held: seg };
  if (prompt || status === 'attn') return off(WHY.prompt, { held: seg });
  if (switching) return off(WHY.switching, { ...shown, busy: switching });
  if (status === 'busy' || status === 'ended') return off(WHY.working, shown);
  if (!sure) return off(WHY.unconfirmed, shown);
  if (key === 'unknown') return off(WHY.unknownUse); // no held or launch mode either: no chip, the terminal is the way
  if (key === 'dontAsk') return off(WHY.dontAsk);
  return { disabled: false, pressed: seg, held: null, reason: '', chip: null, busy: null };
}

/**
 * The polite-region message for one capture (spec 2.8.7). `last` is the last real mode seen (null before the first),
 * `next` the capture's { mode, confirmed }. Returns { last, msg } with msg '' for silence: unknown, confirmed <-> unconfirmed
 * of the same mode, and unknown back to the same mode say nothing; a confirmed mode at open says nothing either, but
 * an unconfirmed one and any Bypass do.
 */
export function modeNote(name, last, { mode, confirmed }) {
  const key = modeKey(mode);
  if (key === 'unknown' || key === last) return { last, msg: '' };
  const label = MODE_META[key].label;
  const loud = key === 'bypassPermissions' ? ` ${BYPASS_NOTE}` : '';
  let msg = `${name}: permission mode is now ${label}.${loud}`;
  if (last === null && !loud) msg = confirmed === true ? '' : `${name} started in ${label} mode, not confirmed yet.`;
  return { last: key, msg };
}

/**
 * What a failed switch says once the next capture is in (spec 9.3 results). `mode` / `confirmed` are that capture's,
 * `start` the mode when the switch began, `target` what was asked for, `presses` the route's own count (409 bodies carry it after
 * at least one press). Returns { text, strike, loud?, bypass? }: strike is the target to strike through, only when the cycle came
 * back to the start mode; `loud` asks for the alert region (Claude may be somewhere nika cannot see), and `bypass` for the Bypass
 * tag next to the text. A confirmed mode other than the start mode wins over every answer but 404 (some presses landed and the tag
 * shows where they stopped), except the route's own `stopped-in-bypass`: its last reading was Bypass, so it is always reported loudly.
 */
export function switchFailure({ status, code, start, target, mode, confirmed, presses }) {
  if (status === 404) return { text: 'The session is gone.', strike: null };
  const key = modeKey(mode);
  const read = confirmed === true && key !== 'unknown';
  if (status === 409 && code === 'stopped-in-bypass') return { text: WHY.stoppedInBypass, strike: null, loud: true, bypass: true };
  if (read && key !== start) return { text: `Stopped at ${MODE_META[key].label}.`, strike: null };
  if (status === 409) {
    if (code === 'not-in-cycle') return { text: `${MODE_META[modeKey(target)].label} isn't in this session's Shift-Tab cycle.`, strike: read ? target : null };
    if (code === 'not-idle') return { text: WHY.working, strike: null };
    if (code === 'mode-unknown') {
      return Number.isInteger(presses) && presses >= 1 ? { text: WHY.unreadAfterPress, strike: null, loud: true } : { text: WHY.unknown, strike: null };
    }
    if (code === 'busy-switching') return { text: 'Another action is running on this session.', strike: null };
  }
  if (status === 429) return { text: 'Too many keys at once; try again.', strike: null };
  if (status === 0 || status >= 500) return { text: WHY.tmux, strike: null };
  return { text: "nika couldn't switch the mode.", strike: null };
}
