// Shared state and widgets for the main page (dashboard, project view, settings). Every data string reaches the
// page through h() / textContent. Nothing here talks to the server; api.js does.
import { h } from './dom.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const MAC = /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');

/** Shapes from src/ids.js; the page validates before it builds a link or a request from data. */
export const SHAPE = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  pane: /^%\d{1,6}$/,
  key: /^[a-z0-9]{16}$/,
  claudeUrl: /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{1,64}$/,
};

/** One object for the whole page; the render functions read it, the poll loop and the app-tier modules write it. */
export const state = {
  since: '7d',
  showEnded: false,
  filter: '',
  data: null, // last /api/agents snapshot
  error: null, // message of the last failed poll, null when the last poll worked
  updatedAt: null,
  me: null, // app tier: /api/app/me
  projects: null, // app tier: /api/app/projects
  settings: null, // app tier: /api/app/settings
  appError: null, // app tier: the private server refused us (403)
  open: new Set(), // disclosure ids the user toggled ("!id" = closed on purpose)
  expanded: new Set(), // group ids whose "show more" was pressed
  route: { name: 'dashboard' },
  pluginProject: null, // project key to preselect in Settings > Plugins (set by the project view)
};

/** Functions the app-tier modules register (project.js, settings.js); empty in the browser tier. */
export const hooks = {};

/* ---------- per-viewer preferences (browser storage may be missing or full) ---------- */
export function load(key, fallback) {
  try {
    const v = localStorage.getItem(`nika.${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function save(key, value) {
  try {
    localStorage.setItem(`nika.${key}`, JSON.stringify(value));
  } catch {
    // storage unavailable: a per-viewer convenience only
  }
}

/* ---------- time ---------- */
/** "now" (under a minute), "N min", "N h", "N d". */
export function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '–';
  const m = Math.max(0, (now - ms) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${Math.floor(m)} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
}
export function timeEl(ms) {
  // an out-of-range number would make toISOString() throw and stop the refresh loop
  const ok = Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime());
  return h('time', {
    'data-ts': ok ? ms : null,
    datetime: ok ? new Date(ms).toISOString() : null,
    title: ok ? new Date(ms).toLocaleString() : null,
    text: ok ? ago(ms) : '–',
  });
}
export function tickTimes() {
  for (const t of $$('time[data-ts]')) t.textContent = ago(Number(t.dataset.ts));
}

/* ---------- live region and toasts ---------- */
export function announce(msg) {
  const r = $('#announce');
  r.textContent = '';
  setTimeout(() => { r.textContent = msg; }, 30);
}

/** Toast at the bottom centre; never takes focus. `ms: 0` keeps it until you call .remove() (the folder picker). */
export function toast(msg, { kind = 'info', action = null, ms = 4200, spin = false } = {}) {
  const box = $('#toasts');
  const t = h('div', { class: 'toast', 'data-kind': kind, role: kind === 'error' ? 'alert' : 'status' },
    h('p', null, spin ? [h('span', { class: 'spin', 'aria-hidden': 'true' }), ' '] : null, msg),
    action ? h('button', { type: 'button', text: action.label, onclick: () => { t.remove(); action.run(); } }) : null);
  while (box.children.length >= 3) box.firstElementChild.remove();
  box.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

export async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${label}`);
  } catch {
    toast(`Could not copy ${label}.`, { kind: 'error' });
  }
}

/** Text of an error response: the server's short message first. */
export function errText(res) {
  return res?.body?.message ?? res?.body?.error ?? `The server answered ${res?.status ?? 'nothing'}.`;
}

/* ---------- status, model and rules badges ---------- */
export const STATUS = {
  attn: { label: 'Needs you', long: 'Needs your attention' },
  idle: { label: 'Waiting', long: 'Waiting for your next prompt' },
  busy: { label: 'Working', long: 'Working' },
  ended: { label: 'Ended', long: 'Ended' },
};
export const ORDER = { attn: 0, idle: 1, busy: 2, ended: 3 };

export function statusEl(s, { compact = false, pill = false } = {}) {
  return h('span', { class: `st${pill ? ' pill-st' : ''}`, 'data-s': s },
    h('span', { class: 'st-g', 'aria-hidden': 'true' }),
    h('span', { class: compact ? 'sr-only' : 'st-l', text: STATUS[s].label }));
}

export function modelEl(a) {
  return h('span', { class: 'model', title: a.model ? `Model: ${a.model}` : 'Model unknown', text: a.modelLabel ?? '–' });
}

const RULES = {
  none: { label: 'No rules', hint: 'No rules/orchestration.md yet', glyph: '–' },
  nika: { label: 'Rules current', hint: 'Written by nika from the current template', glyph: '✓' },
  outdated: { label: 'Rules outdated', hint: 'Written by nika from an older template', glyph: '↻' },
  foreign: { label: 'Rules not by nika', hint: 'rules/orchestration.md was not written by nika', glyph: '!' },
};
export function rulesEl(s) {
  const r = RULES[s] ?? RULES.none;
  return h('span', { class: 'rules', 'data-r': s in RULES ? s : 'none', title: r.hint },
    h('span', { class: 'rules-g', 'aria-hidden': 'true', text: r.glyph }), r.label);
}

/** [["attn", "2 need you"], …] for the non-zero counts. */
export function countsLine(c) {
  const parts = [];
  if (c.attn) parts.push(['attn', `${c.attn} need${c.attn === 1 ? 's' : ''} you`]);
  if (c.idle) parts.push(['idle', `${c.idle} waiting`]);
  if (c.busy) parts.push(['busy', `${c.busy} working`]);
  if (c.ended) parts.push(['ended', `${c.ended} ended`]);
  return parts;
}

/** Link to the session window; null when neither a session id nor a pane id is usable. Every part is shape-checked. */
export function sessionHref({ session, pane, project }) {
  const q = [];
  if (SHAPE.uuid.test(session ?? '')) q.push(`session=${session}`);
  if (SHAPE.pane.test(pane ?? '')) q.push(`pane=${encodeURIComponent(pane)}`);
  if (SHAPE.key.test(project ?? '')) q.push(`project=${project}`);
  return q.some((p) => !p.startsWith('project=')) ? `session.html?${q.join('&')}` : null;
}

/* ---------- forms ---------- */
export const RX = {
  agent: [/^[a-z0-9][a-z0-9-]{0,39}$/, 'Lowercase letters, digits and dashes, up to 40, starting with a letter or digit.'],
  model: [/^(?:claude-[a-z0-9-]{3,60}|opus|sonnet|haiku|fable|best|opusplan)(?:\[1m\])?$/, 'Use a model id such as claude-sonnet-5-5, an alias (opus, sonnet, haiku, fable, best, opusplan), or add [1m] for 1M context.'],
  prefix: [/^(?:[a-z0-9][a-z0-9-]{0,19})?$/, 'Lowercase letters, digits and dashes, up to 20, starting with a letter or digit. Leave empty to use the project name.'],
};

export function fieldError(input, msg) {
  const err = document.getElementById(`${input.id}-err`);
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  if (err) {
    err.textContent = msg;
    err.hidden = !msg;
  }
}

/** Marks the selected radio card of every group under `root` (no :has() in the CSS). */
export function syncRadioCards(root) {
  for (const card of $$('.radio-card', root)) card.dataset.on = String($('input', card).checked);
}

/** Button in its busy state ("Applying…") and back. The original children are restored. */
export function setBusy(btn, busy, label) {
  if (busy) {
    btn._orig = [...btn.childNodes];
    btn.replaceChildren(h('span', { class: 'spin', 'aria-hidden': 'true' }), label);
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  } else {
    btn.replaceChildren(...(btn._orig ?? []));
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

/* ---------- dialogs: native showModal, focus returns to the opener ---------- */
const openers = new Map();

export function openDialog(dlg, { focus } = {}) {
  const el = document.activeElement;
  openers.set(dlg, { el, fk: el?.dataset?.fk ?? null });
  for (const d of $$('dialog[open]')) if (d !== dlg) d.close();
  if (!dlg.open) dlg.showModal();
  (focus ?? $('[autofocus]', dlg) ?? $('h2', dlg))?.focus();
}

function restoreFocus(dlg) {
  if ($('dialog[open]')) return;
  const o = openers.get(dlg);
  openers.delete(dlg);
  let el = o?.el?.isConnected ? o.el : null;
  if (!el && o?.fk) el = $(`[data-fk="${CSS.escape(o.fk)}"]`);
  el ??= $('.screen:not([hidden]) h1');
  el?.focus();
}

/** `dlg.dataset.busy` set: a write is in flight, so Esc and the close buttons do nothing. */
export function initDialogs() {
  for (const dlg of $$('dialog')) {
    dlg.addEventListener('cancel', (e) => { if (dlg.dataset.busy) e.preventDefault(); });
    dlg.addEventListener('close', () => restoreFocus(dlg));
  }
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    const d = c?.closest('dialog');
    if (d && !d.dataset.busy) d.close();
  });
}

/* ---------- disclosure menus: one open at a time, Esc closes and returns focus ---------- */
let menuSeq = 0;

/** items: [{ text, run }] or [{ text, href }] (external links open in the system browser through the shell). */
export function menuEl(label, items, fk) {
  const id = `menu-${++menuSeq}`;
  return h('div', { class: 'menu-wrap' },
    h('button', { type: 'button', class: 'btn icon ghost', 'data-menu-btn': true, 'data-fk': fk, 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': label, title: label },
      h('span', { 'aria-hidden': 'true', text: '⋯' })),
    h('ul', { class: 'menu', id, hidden: true }, items.map((it) => h('li', null, it.href
      ? h('a', { href: it.href, target: '_blank', rel: 'noopener noreferrer', text: it.text })
      : h('button', { type: 'button', text: it.text, onclick: it.run })))));
}

export const menuIsOpen = () => Boolean($('.menu:not([hidden])'));

function closeMenu(m, focus = true) {
  m.hidden = true;
  m.removeAttribute('data-up');
  m.previousElementSibling?.setAttribute('aria-expanded', 'false');
  if (focus) m.previousElementSibling?.focus();
}

export function initMenus() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu-btn]');
    const chosen = e.target.closest('.menu');
    // picking an item closes its menu and puts focus back on the button; any other click just closes
    for (const m of $$('.menu:not([hidden])')) if (!btn || m.previousElementSibling !== btn) closeMenu(m, m === chosen);
    if (!btn) return;
    const m = btn.nextElementSibling;
    const open = m.hidden;
    m.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    // flip above the button when the list would run past the bottom of the window
    if (window.innerHeight - btn.getBoundingClientRect().bottom < m.offsetHeight + 16) m.dataset.up = '1';
    $('button, a', m)?.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = $('.menu:not([hidden])');
    if (m) {
      e.preventDefault();
      closeMenu(m);
    }
  });
}
