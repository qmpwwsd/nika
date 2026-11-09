// A small fake DOM for the page-code tests: just what public/dom.js h() / icon() and the page modules touch. It is not a browser;
// the browser itself is exercised by hand. Install it around a test file with installDom() in before() and the returned
// restore() in after().

export const focus = { el: null };

export class El {
  constructor(tag, text = '') {
    this.tag = tag; this.attrs = {}; this.kids = []; this.listeners = {}; this.parent = null; this.own = text;
    this.className = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.open = false;
  }

  get dataset() {
    return new Proxy(this, { get: (t, k) => t.attrs[`data-${k}`], set: (t, k, v) => { t.attrs[`data-${k}`] = String(v); return true; }, deleteProperty: (t, k) => delete t.attrs[`data-${k}`] });
  }

  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'hidden') this.hidden = true;
    if (k === 'disabled') this.disabled = true;
    if (k === 'checked') this.checked = true;
  }

  getAttribute(k) { return this.attrs[k] ?? null; }

  removeAttribute(k) {
    delete this.attrs[k];
    if (k === 'hidden') this.hidden = false;
    if (k === 'disabled') this.disabled = false;
  }

  hasAttribute(k) { return k in this.attrs; }

  append(...nodes) { for (const n of nodes) this.kids.push(this.adopt(n)); }

  replaceChildren(...nodes) { this.kids = nodes.map((n) => this.adopt(n)); }

  adopt(n) {
    const node = typeof n === 'string' ? new El('#text', n) : n;
    node.parent = this;
    return node;
  }

  remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); }

  get childNodes() { return this.kids; }

  get firstElementChild() { return this.kids[0] ?? null; }

  get children() { return this.kids; }

  set textContent(v) { this.kids = []; this.own = String(v); }

  get textContent() { return this.own + this.kids.map((k) => k.textContent).join(''); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  fire(type, extra = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }

  click() { if (!this.disabled) this.fire('click', { currentTarget: this }); }

  focus() { focus.el = this; }

  /** Text as a screen reader builds a name from it: aria-hidden parts are left out. */
  get accName() {
    return this.attrs['aria-hidden'] === 'true' ? '' : this.own + this.kids.map((k) => k.accName).join('');
  }

  all(pred, out = []) {
    for (const k of this.kids) { if (pred(k)) out.push(k); k.all(pred, out); }
    return out;
  }

  /** The first descendant (or this node) with `data-fk` equal to `fk`. */
  byFk(fk) { return this.all((n) => n.attrs['data-fk'] === fk)[0] ?? null; }
}

export const withClass = (cls) => (n) => n.className.split(' ').includes(cls);

/** Puts the fake `document` and `Node` on globalThis; returns the function that puts the old ones back. */
export function installDom(extra = {}) {
  const saved = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = El;
  globalThis.document = {
    createElement: (tag) => new El(tag),
    createTextNode: (t) => new El('#text', t),
    createElementNS: (ns, tag) => new El(tag),
    ...extra,
  };
  return () => {
    globalThis.document = saved.document;
    globalThis.Node = saved.Node;
  };
}
