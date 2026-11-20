// 0.5.4 RM: Remove from the list, on the page (design-053-rm 2 and 6.6). A removed session or detected folder is only hidden from nika's lists
// (hidden.json in nika's own state folder): nothing is deleted and no process is touched. This module is loaded on both tiers (app.js imports it
// statically for the removed line); everything that sends a request checks isApp first, and appFetch refuses to run outside the app tier anyway.
// The server's own message text is never shown: the status and the error code pick one of the fixed texts below. Every string that came from the
// server is set as text (h() text attribute or text node), never as markup.
import { appFetch, isApp } from './api.js';
import { h, icon, timeEl } from './dom.js';
import { $, toast, setBusy, openDialog, SHAPE } from './ui.js';

const SLOW_MS = 400; // a request slower than this shows a spinner toast
const UNDO_MS = 10000; // how long the Undo toast stays (WCAG 2.2.1: Show removed is the second way back)
const NAME_MAX = 40; // names in a toast
const ROWS_MAX = 100; // rows per list in the dialog
const COUNT_MAX = 999999;
const ELL = '\u2026';

const COPY = {
  gone: "It's no longer in nika's list.",
  'in-tmux': 'This session runs in tmux. End it first.',
  registered: 'This folder is a nika project now. Remove it on its project page.',
  write: "Couldn't save the change. Nothing was removed.",
  index: "nika can't read its list of sessions right now. Nothing was removed.",
  net: "Couldn't reach nika. Nothing was removed.",
};
const UNDO_FAILED = "Couldn't undo. Use Show removed to bring it back.";
const AGAIN_FAILED = "Couldn't show it again. Nothing changed.";
const NO_LABEL = 'Folder with no recent sessions';

const pending = new Set(); // 's:<id>' and 'g:<key>' of the requests in flight: a second click sends nothing

const cut = (s, n) => {
  const chars = [...String(s ?? '')];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}${ELL}` : chars.join('');
};
const text = (v) => (typeof v === 'string' && v.length ? v : null);
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

/** A response of a remove route as `{ kind, text }`: `ok`, or one of the fixed copies by status and error code. Anything unexpected reads as the network case. */
export function removeOutcome(res) {
  const status = res?.status;
  const error = res?.body?.error;
  if (status === 200 && res.body?.hidden === true) return { kind: 'ok', text: null };
  let kind = 'net';
  if (status === 404) kind = 'gone';
  else if (status === 409 && error === 'in-tmux') kind = 'in-tmux';
  else if (status === 409 && error === 'registered') kind = 'registered';
  else if (status === 500 && error === 'write_failed') kind = 'write';
  else if (status === 503 && error === 'index_unavailable') kind = 'index';
  return { kind, text: COPY[kind] };
}

/** POST `{}` to an app route: the answer, or null when the network failed. With a `label`, a request slower than 400 ms shows a spinner toast until it ends. */
async function post(url, label) {
  let spin = null;
  const timer = label ? setTimeout(() => { spin = toast(label, { spin: true, ms: 0 }); }, SLOW_MS) : null;
  try {
    return await appFetch(url, { method: 'POST', json: {} });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    spin?.remove();
  }
}

/** Focus after a Remove: the group's heading while the group still shows, else the heading of the screen (dashboard or project page). */
function focusAfter(g) {
  const key = typeof g?.key === 'string' && /^[a-z0-9]+$/.test(g.key) ? g.key : null;
  const heading = key ? $(`#g-${key}`) : null;
  // the dashboard's headings stay in the page while the project screen shows: a hidden one cannot take focus (offsetParent is null, as in afterEnd of app.js)
  ((heading && heading.offsetParent !== null ? heading : null) ?? $('.screen:not([hidden]) h1'))?.focus();
}

async function undo(url, refresh) {
  const res = await post(url, null);
  if (res?.status === 200 && res.body?.hidden === false) {
    toast('Back in the list.');
    await refresh();
  } else {
    toast(UNDO_FAILED, { kind: 'error' });
  }
}

/** The end of a remove: the fixed toast for a failure (a 404 also reads the list again), else the Undo toast, the refresh and the focus. */
async function finish(out, done, undoUrl, g, refresh) {
  if (out.kind !== 'ok') {
    toast(out.text, out.kind === 'gone' ? {} : { kind: 'error' });
    if (out.kind === 'gone') await refresh();
    return;
  }
  toast(done, { ms: UNDO_MS, action: { label: 'Undo', run: () => undo(undoUrl, refresh) } });
  await refresh();
  focusAfter(g);
}

/** Remove the session row `a` of group `g` from the list. App tier; one request per row at a time. */
export async function removeRow(a, g, { refresh }) {
  const id = a?.id;
  if (!isApp || typeof id !== 'string' || !SHAPE.uuid.test(id)) return;
  const mark = `s:${id}`;
  if (pending.has(mark)) return;
  pending.add(mark);
  try {
    const res = await post(`/api/app/session/${id}/remove`, `Removing from the list${ELL}`);
    await finish(removeOutcome(res), `Removed ${cut(a.name, NAME_MAX) || 'session'} from the list.`, `/api/app/session/${id}/unhide`, g, refresh);
  } finally {
    pending.delete(mark);
  }
}

/** Remove the detected folder `g` from the list. App tier; one request per folder at a time. */
export async function removeGroup(g, { refresh }) {
  const key = g?.key;
  if (!isApp || typeof key !== 'string' || !SHAPE.key.test(key)) return;
  const mark = `g:${key}`;
  if (pending.has(mark)) return;
  pending.add(mark);
  try {
    const res = await post(`/api/app/groups/${key}/remove`, `Removing from the list${ELL}`);
    const out = removeOutcome(res);
    const n = out.kind === 'ok' ? res.body.sessions : null;
    const rows = Number.isSafeInteger(n) && n > 0 && n <= COUNT_MAX ? ` (${n} session${n === 1 ? '' : 's'})` : '';
    await finish(out, `Removed ${cut(g.label, NAME_MAX) || 'folder'} from the list${rows}.`, `/api/app/groups/${key}/unhide`, g, refresh);
  } finally {
    pending.delete(mark);
  }
}

/** The removed line of the dashboard (`where: 'dash'`) or a project page (`'project'`): null for no count; the Show button only in the app tier. */
export function removedLineEl(n, { where, refresh } = {}) {
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const line = !isApp ? `${n} removed from the list in the nika app` : where === 'project' ? `${n} removed from this project's list` : `${n} removed from the list`;
  return h('p', { class: 'rm-line' },
    isApp ? icon('eye-off') : null,
    h('span', { class: 'rm-text', text: line }),
    isApp ? h('button', { type: 'button', class: 'btn', 'data-fk': 'rm-show', 'aria-label': `Show ${n} removed`, onclick: () => openRemovedList({ refresh }) }, 'Show') : null);
}

/** The answer of GET /api/app/hidden as rows for the dialog, or null when it does not have the route's shape (the dialog then shows its error state). */
export function removedView(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.groups) || !Array.isArray(body.sessions)) return null;
  const groups = body.groups
    .filter((g) => g !== null && typeof g === 'object' && typeof g.key === 'string' && SHAPE.key.test(g.key) && Number.isFinite(g.at))
    .map((g) => ({ key: g.key, name: text(g.label) ?? NO_LABEL, path: text(g.root), at: g.at }));
  const sessions = body.sessions
    .filter((s) => s !== null && typeof s === 'object' && typeof s.id === 'string' && SHAPE.uuid.test(s.id) && Number.isFinite(s.at))
    .map((s) => ({ id: s.id, name: text(s.name) ?? s.id.slice(0, 8), project: text(s.project), at: s.at }));
  const more = { groups: count(body.more?.groups) + Math.max(0, groups.length - ROWS_MAX), sessions: count(body.more?.sessions) + Math.max(0, sessions.length - ROWS_MAX) };
  const shown = { groups: groups.slice(0, ROWS_MAX), sessions: sessions.slice(0, ROWS_MAX) };
  return { ...shown, empty: !shown.groups.length && !shown.sessions.length, more };
}

// ---- the dialog ----------------------------------------------------------------------------------------------------------------------

/** Draws the view; resolves the Show again buttons in the order of the rows (groups, then sessions). */
function paint(body, view, refresh) {
  const buttons = [];
  if (view.empty) {
    body.replaceChildren(h('p', { class: 'muted', text: 'Nothing is removed from the list.' }));
    return buttons;
  }
  const item = (entry, meta, url) => {
    const btn = h('button', { type: 'button', class: 'btn', 'data-fk': `rm-again:${entry.key ?? entry.id}`, 'aria-label': `Show ${entry.name} again` }, 'Show again');
    btn.addEventListener('click', () => showAgain(btn, entry, url, body, view, refresh));
    buttons.push(btn);
    return h('li', { class: 'rm-item' },
      h('div', { class: 'rm-text' },
        h('span', { class: 'rm-name', title: entry.name, text: entry.name }),
        ...meta,
        h('span', { class: 'rm-meta' }, 'Removed ', timeEl(entry.at))),
      btn);
  };
  const section = (title, list, more) => [
    h('h3', { text: title }),
    h('ul', { class: 'rm-list', 'aria-label': title }, list),
    ...(more > 0 ? [h('p', { class: 'muted rm-more', text: `and ${more} more (oldest)` })] : []),
  ];
  body.replaceChildren(
    ...(view.groups.length ? section('Folders', view.groups.map((g) => item(g, g.path ? [h('span', { class: 'rm-path mono', title: g.path, text: g.path })] : [], `/api/app/groups/${g.key}/unhide`)), view.more.groups) : []),
    ...(view.sessions.length ? section('Sessions', view.sessions.map((s) => item(s, s.project ? [h('span', { class: 'rm-proj', title: s.project, text: s.project })] : [], `/api/app/session/${s.id}/unhide`)), view.more.sessions) : []));
  return buttons;
}

/** Show again: unhide, then the row leaves the list and focus moves to the next row's button (else the heading). A failure keeps the row. */
async function showAgain(btn, entry, url, body, view, refresh) {
  if (btn.disabled) return;
  setBusy(btn, true, `Showing${ELL}`);
  const res = await post(url, null);
  if (!(res?.status === 200 && res.body?.hidden === false)) {
    setBusy(btn, false);
    toast(AGAIN_FAILED, { kind: 'error' });
    return;
  }
  const at = [...view.groups, ...view.sessions].indexOf(entry);
  view.groups = view.groups.filter((g) => g !== entry);
  view.sessions = view.sessions.filter((s) => s !== entry);
  view.empty = !view.groups.length && !view.sessions.length;
  const buttons = paint(body, view, refresh);
  (buttons[at] ?? $('#rm-h'))?.focus();
  toast('Back in the list.');
  await refresh();
}

function showError(body, refresh) {
  const retry = h('button', { type: 'button', class: 'btn', 'data-fk': 'rm-retry', text: 'Try again', onclick: () => load(body, refresh) });
  const alert = h('div', { class: 'alert', 'data-kind': 'danger', role: 'alert', tabindex: '-1' }, icon('warn'), h('p', { text: "Couldn't load the removed items." }), retry);
  body.replaceChildren(alert);
  alert.focus();
}

async function load(body, refresh) {
  body.setAttribute('aria-busy', 'true');
  body.replaceChildren(h('p', { class: 'muted', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), ` Loading${ELL}`));
  let view = null;
  try {
    const res = await appFetch('/api/app/hidden');
    if (res.status === 200) view = removedView(res.body);
  } catch {
    // the error state below
  }
  body.setAttribute('aria-busy', 'false');
  if (view) paint(body, view, refresh);
  else showError(body, refresh);
}

/** Opens the Show removed dialog and fills it from GET /api/app/hidden (app tier). */
export async function openRemovedList({ refresh }) {
  const dlg = $('#dlg-removed');
  const body = $('#rm-body');
  if (!isApp || !dlg || !body) return;
  openDialog(dlg);
  await load(body, refresh);
}
