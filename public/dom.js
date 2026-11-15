// Tiny DOM helper shared by every page. Strings become text nodes or textContent, never parsed as markup.
// `on*` keys register event listeners; every other key is a plain attribute (never a style or a URL built from data).
import { ROLE_TAGS, SUB_STATES } from './dash-model.js';
import { ctxView } from './ctx.js';

export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icon instance of a symbol in the page's static SVG sprite (`<symbol id="i-name">`). */
export function icon(name, cls = 'ic') {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG_NS, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

/**
 * The badge next to a session's name: `kind` is dash-model.js roleTag()'s answer ('main', 'sub', 'saved'); anything else gives null.
 * The long word is clipped on narrow rows (still read by screen readers) and the short one, hidden from them, shows instead.
 */
export function roleTagEl(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(ROLE_TAGS, kind)) return null;
  const t = ROLE_TAGS[kind];
  return h('span', { class: t.cls, title: t.title },
    h('span', { class: 'tag-l', text: t.long }),
    h('span', { class: 'tag-s', 'aria-hidden': 'true', text: t.short }));
}

/**
 * The state badge of a Claude subagent (0.5, W8): `span.sst[data-ss][title]` holding a glyph (drawn by the stylesheet, hidden from
 * assistive tech) and the word, so colour is never the only sign. `state` is the server's `running` / `finished` / `stopped`; anything
 * else gives null. `pill` is the session header's rounded form.
 */
export function subStateEl(state, { pill = false } = {}) {
  if (typeof state !== 'string' || !Object.hasOwn(SUB_STATES, state)) return null;
  const t = SUB_STATES[state];
  return h('span', { class: pill ? 'sst pill' : 'sst', 'data-ss': state, title: t.title },
    h('span', { class: 'sst-g', 'aria-hidden': 'true' }),
    h('span', { class: 'sst-l', text: t.label }));
}

/**
 * One subagent line: `li.sub[data-ss]` holding the badge, the description (a link when `href` is given, else plain text; `fk` is the
 * link's focus key so a redraw keeps focus on it), the type, the model label and `time` (a node the page passes, or nothing). Text
 * goes in through h(), never as markup; the page builds `href` with dash-model.js subagentHref() from ids it has checked.
 */
export function subagentItemEl(s, { href = null, fk = null, time = null } = {}) {
  const text = typeof s.description === 'string' && s.description ? s.description : '(no description)';
  const badge = subStateEl(s.state);
  return h('li', { class: 'sub', 'data-ss': badge ? s.state : null },
    badge,
    href
      ? h('a', { class: 'sub-desc sub-link', href, 'data-fk': fk, title: 'Open its transcript (read-only)', text })
      : h('span', { class: 'sub-desc', text }),
    s.type ? h('span', { class: 'sub-type', text: s.type }) : null,
    s.modelLabel ? h('span', { class: 'model', text: s.modelLabel }) : null,
    time);
}

/**
 * The context meter (design 0.4 section 6) drawn from `a.context` through ctxView: `span.ctx[data-lvl][title]` holding the number
 * (a warning icon when nearly full), a bar of quantised steps (`data-q`, no inline style) and an sr-only sentence; the visible parts
 * are hidden from assistive tech so the sentence is read once. `header` adds the word "Context" and the long numbers (hidden on narrow
 * windows). `el` is an existing `.ctx` element to fill again (the session header's #sess-ctx) instead of a new one.
 */
export function ctxEl(context, { header = false, el = null } = {}) {
  const v = ctxView(context);
  const root = el ?? h('span', { class: 'ctx' });
  const hid = { 'aria-hidden': 'true' };
  root.setAttribute('data-lvl', v.lvl);
  root.setAttribute('title', v.title);
  root.replaceChildren(...[
    header ? h('span', { class: 'ctx-l', ...hid, text: 'Context' }) : null,
    header && v.of ? h('span', { class: 'ctx-t hide-narrow', ...hid, text: `${v.of} ·` }) : null,
    h('span', { class: 'ctx-v', ...hid }, v.lvl === 'full' ? icon('warn') : null, v.text),
    v.q === null ? null : h('span', { class: 'ctx-bar', 'data-q': v.q, ...hid }, h('i')),
    h('span', { class: 'sr-only', text: v.sr }),
  ].filter(Boolean));
  return root;
}

/* ---------- where an open disclosure menu goes (ui.js menus; shortcuts.js closes them from the session window) ---------- */

/** The gap, in px, an open menu keeps from the edge of the space it may use. */
export const MENU_EDGE = 8;

/** Everything placeMenuX can set inline; clearMenuPlacement removes exactly these and the two attributes. */
const PLACED_STYLE = ['left', 'right', 'width', 'min-width'];

/**
 * Pure. Where a menu `w` px wide goes when its button is `r` ({ left, right }, window coordinates) and it may use the span lo..hi.
 * The stylesheet anchors a menu to its button's right edge, so that stays when it fits: `{ x: 'end' }`. Else the button's left edge
 * (`{ x: 'start' }`). Else `{ x: 'fit', width, left }`: shifted so both edges are inside, `left` being the offset from the button's left
 * edge, at `width`: the menu's own, or the whole span when that is narrower than the menu.
 */
export function menuSpan(r, w, lo, hi) {
  if (r.right - w >= lo && r.right <= hi) return { x: 'end' };
  if (r.left >= lo && r.left + w <= hi) return { x: 'start' };
  const width = Math.min(w, hi - lo);
  const left = Math.min(Math.max(r.right - width, lo), hi - width);
  return { x: 'fit', width, left: left - r.left };
}

/** Puts the menu back to what the stylesheet says (right-aligned, below): every attribute and inline value a placement set. */
export function clearMenuPlacement(m) {
  m.removeAttribute('data-up');
  m.removeAttribute('data-x');
  for (const p of PLACED_STYLE) m.style.removeProperty(p);
}

/**
 * Keeps the open menu `m` (shown, the list right after its button `btn`) inside the space it may use: the window, less MENU_EDGE on each
 * side, and inside the scrolling body of a dialog or the content column when the button sits in one (a dialog body clips what sticks
 * out of it; the content column ends where the sidebar starts). Sets `data-x` to `start` (CSS does the rest) or `fit` (inline `left`,
 * `right`, and an explicit `width` with no minimum: the menu's wrapper is only as wide as the button, so a width left to the browser
 * would shrink to the longest word; the items wrap when it is narrower than they are); right-aligned sets nothing. A window or menu
 * with no width yet (not laid out) is left alone. closeMenu clears it all through clearMenuPlacement.
 */
export function placeMenuX(m, btn) {
  const vw = window.innerWidth;
  const w = m.offsetWidth;
  if (!(vw > 0 && w > 0)) return;
  const box = (btn.closest('.dlg-body') ?? btn.closest('.main'))?.getBoundingClientRect();
  const lo = Math.max(MENU_EDGE, box ? box.left + MENU_EDGE : 0);
  const hi = Math.min(vw - MENU_EDGE, box ? box.right - MENU_EDGE : vw);
  if (!(hi - lo > 0)) return;
  const s = menuSpan(btn.getBoundingClientRect(), w, lo, hi);
  if (s.x === 'end') return;
  m.setAttribute('data-x', s.x);
  if (s.x === 'start') return;
  m.style.setProperty('right', 'auto');
  m.style.setProperty('left', `${s.left}px`);
  m.style.setProperty('min-width', '0px');
  m.style.setProperty('width', `${s.width}px`);
}
