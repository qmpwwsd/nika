// The End-session dialog (docs/design/spec.md section 9.8), shared by the session window and the dashboard row menu.
// The page holds the markup (<dialog id="end-dlg"> with #end-h, #end-alert, #end-d, #end-note, #end-wait, #end-cancel, #end-go:
// see session.html); this file fills it, runs POST /api/app/pane/:id/end and moves focus. Every line the dialog shows comes from
// quick-actions.js (fixed copy): the response's text is never displayed, only its status, `error` code and `ended` flag are read.
import { h } from './dom.js';
import { appFetch } from './api.js';
import { endOutcome, endNote } from './quick-actions.js';

const PANE_ID = /^%\d{1,6}$/;
const NAME_MAX = 48;
const DOTS = String.fromCharCode(0x2026);
const el = (id) => document.getElementById(id);

// pane: the pane being ended. ending: the request is in flight. handled: the ended path already moved focus, so the close event
// must not. opener: where focus returns when the dialog closes any other way.
const E = { wired: false, pane: null, ending: false, handled: false, opener: null, done: null };

/** Focus the screen heading: the session window's h1, or the dashboard's visible one. Not focusable by default, so it gets tabindex -1. */
function focusHeading() {
  const heading = document.querySelector('.screen:not([hidden]) h1') ?? document.querySelector('h1');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus();
}

/**
 * What the dialog shows. `alert` ('' = none) appears above the body text, which stays (aria-describedby points at it), in the look of `kind`
 * (danger, or warn for a refusal the user fixes in the terminal); `note` is the muted extra line; `busy` is the ending state;
 * `closeOnly` is the failed state, whose footer has only Close.
 */
function draw({ alert = '', kind = 'danger', note = '', busy = false, closeOnly = false }) {
  el('end-alert-text').textContent = alert;
  el('end-alert').dataset.kind = kind;
  el('end-alert').hidden = !alert;
  el('end-note').textContent = alert ? '' : note;
  el('end-note').hidden = Boolean(alert) || !note;
  el('end-wait').textContent = busy ? `Waiting for Claude to exit${DOTS}` : '';
  const go = el('end-go');
  go.hidden = closeOnly;
  go.replaceChildren(...(busy ? [h('span', { class: 'spin', 'aria-hidden': 'true' }), ` Ending${DOTS}`] : ['End session']));
  if (busy) go.setAttribute('aria-busy', 'true');
  else go.removeAttribute('aria-busy');
  go.setAttribute('aria-disabled', String(busy));
  el('end-cancel').textContent = closeOnly ? 'Close' : 'Cancel';
  el('end-cancel').setAttribute('aria-disabled', String(busy));
}

async function run() {
  if (E.ending) return;
  const dlg = el('end-dlg');
  E.ending = true;
  dlg.dataset.busy = '1'; // the dashboard's dialog helper reads this too: Esc and the close buttons do nothing
  draw({ busy: true });
  let answer;
  try {
    const res = await appFetch(`/api/app/pane/${encodeURIComponent(E.pane)}/end`, { method: 'POST', json: {} });
    answer = { status: res.status, code: res.body?.error, ended: res.body?.ended, reason: res.body?.reason };
  } catch {
    answer = { status: 0 }; // the network failed: the same line as a tmux failure
  }
  E.ending = false;
  delete dlg.dataset.busy;
  const out = endOutcome(answer);
  if (out.ended) {
    E.handled = true;
    dlg.close();
    focusHeading(); // the host may move focus again in done()
    E.done?.();
    return;
  }
  draw({ alert: out.text, kind: out.kind, closeOnly: true });
  el('end-alert').focus();
}

function wire(dlg) {
  if (E.wired) return;
  E.wired = true;
  dlg.addEventListener('cancel', (e) => { if (E.ending) e.preventDefault(); });
  dlg.addEventListener('close', () => {
    if (E.handled) return;
    if (E.opener?.isConnected) E.opener.focus();
    else focusHeading();
  });
  el('end-cancel').addEventListener('click', () => { if (!E.ending) dlg.close(); });
  el('end-go').addEventListener('click', run);
}

/**
 * Opens the dialog for the agent whose pane is `pane`. `name` is its display name; `working` (Claude is busy) and `promptOpen`
 * (a permission prompt is on screen) only choose the muted line. `onEnded` runs after the dialog has closed and focus has moved to
 * the screen heading, when Claude really exited (`ended: true`): the host shows its toast and updates its screen.
 */
export function openEndDialog({ pane, name, working = false, promptOpen = false, onEnded } = {}) {
  const dlg = el('end-dlg');
  if (!dlg || typeof pane !== 'string' || !PANE_ID.test(pane) || dlg.open || E.ending) return;
  wire(dlg);
  const who = typeof name === 'string' && name ? (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}${DOTS}` : name) : 'this agent';
  Object.assign(E, { pane, handled: false, opener: document.activeElement, done: typeof onEnded === 'function' ? onEnded : null });
  el('end-h').textContent = `End ${who}'s session?`;
  draw({ note: endNote({ working, promptOpen }) });
  dlg.showModal();
  el('end-cancel').focus(); // initial focus is Cancel: Enter never ends a session by accident
}
