// Tiny DOM helper shared by every page. Strings become text nodes or textContent, never parsed as markup.
// `on*` keys register event listeners; every other key is a plain attribute (never a style or a URL built from data).
import { ROLE_TAGS } from './dash-model.js';
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
