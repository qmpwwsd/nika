// Tiny DOM helper shared by every page. Strings become text nodes or textContent, never parsed as markup.
// `on*` keys register event listeners; every other key is a plain attribute (never a style or a URL built from data).
import { ROLE_TAGS } from './dash-model.js';

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
