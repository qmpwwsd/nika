// A disclosure menu (ui.js menuEl / initMenus) stays inside the window: right-aligned to its button when that fits, else aligned to the
// button's left edge, else shifted (and narrowed when the window is narrower than the menu). Owner screenshot 2026-11-15: the project
// page's "..." menu opened past the window's left edge on a narrow window. The browser is exercised by hand; here the real ui.js and
// dom.js run on a small fake page (test/fake-dom.js) with stubbed getBoundingClientRect / offsetWidth / innerWidth. Fixtures are synthetic.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { El, installDom, focus } from './fake-dom.js';
import { menuSpan, MENU_EDGE } from '../public/dom.js';
import * as ui from '../public/ui.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CSS = fs.readFileSync(path.join(PUBLIC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- the pure part --------------------------------------------------------------------------------------------------------------

describe('menuSpan: which placement a menu gets (pure)', () => {
  const r = (left, right) => ({ left, right });

  test('(+) the menu fits to the left of the button\'s right edge: right-aligned, as before', () => {
    assert.deepEqual(menuSpan(r(400, 432), 220, 8, 792), { x: 'end' });
  });

  test('(+) it does not fit on the left but fits on the right: aligned to the button\'s left edge', () => {
    assert.deepEqual(menuSpan(r(20, 52), 220, 8, 792), { x: 'start' });
  });

  test('(+) it fits neither way but the window is wide enough: shifted at its own width, both edges inside', () => {
    const s = menuSpan(r(130, 160), 220, 8, 292);
    assert.deepEqual(s, { x: 'fit', width: 220, left: 8 - 130 });
    const edge = 130 + s.left;
    assert.ok(edge >= 8 && edge + 220 <= 292);
  });

  test('(+) the window is narrower than the menu: width capped to the space, edges on the margins', () => {
    const s = menuSpan(r(150, 182), 220, 8, 192);
    assert.equal(s.x, 'fit');
    assert.equal(s.width, 184);
    const edge = 150 + s.left;
    assert.equal(edge, 8);
    assert.equal(edge + s.width, 192);
  });

  test('(−) the margin is exact: a left edge on the margin fits, one pixel past it does not', () => {
    assert.deepEqual(menuSpan(r(100, 228), 220, 8, 792), { x: 'end' }, 'left edge = 8');
    assert.equal(menuSpan(r(100, 227), 220, 8, 792).x, 'start', 'left edge = 7: the next choice');
    assert.deepEqual(menuSpan(r(8, 40), 220, 8, 228), { x: 'start' }, 'start: right edge = 228, on the margin');
    assert.equal(menuSpan(r(9, 41), 220, 8, 228).x, 'fit', 'start: right edge = 229');
  });

  test('(−) a button whose right edge is past the right margin is not right-aligned (the menu would stick out)', () => {
    const s = menuSpan(r(760, 796), 220, 8, 792);
    assert.equal(s.x, 'fit');
    assert.equal(760 + s.left + 220, 792, 'pulled back to the right margin');
  });

  test('(−) the space is the span the caller gives, not a fixed window: a clipping body narrows it', () => {
    assert.equal(menuSpan(r(310, 340), 220, 308, 772).x, 'start');
    assert.equal(menuSpan(r(310, 340), 220, 8, 792).x, 'end');
  });

  test('(−) the margin constant is 8 px', () => {
    assert.equal(MENU_EDGE, 8);
  });
});

// ---- a small fake page ----------------------------------------------------------------------------------------------------------

class ME extends El {
  constructor(tag) {
    super(tag);
    this.rect = null; this.offsetWidth = 0; this.offsetHeight = 0;
  }

  getBoundingClientRect() { return this.rect ?? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }

  scrollIntoView(o) { this.scrolled = o ?? {}; }

  matches(sel) {
    let ok = true;
    let any = false;
    for (const [, tag, cls, not, attr] of sel.matchAll(/(^[a-z]+)|\.([\w-]+)|:not\(\[([\w-]+)\]\)|\[([\w-]+)\]/g)) {
      any = true;
      if (tag) ok &&= this.tag === tag;
      else if (cls) ok &&= this.className.split(/\s+/).includes(cls);
      else if (not) ok &&= not === 'hidden' ? !this.hidden : !(not in this.attrs);
      else if (attr) ok &&= attr in this.attrs;
    }
    return any && ok;
  }

  closest(sel) {
    for (let x = this; x; x = x.parent) if (x.matches?.(sel)) return x;
    return null;
  }

  contains(n) {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }

  querySelector(sel) {
    const alts = sel.split(',').map((s) => s.trim());
    return this.all((n) => alts.some((a) => n.matches(a)))[0] ?? null;
  }

  get nextElementSibling() { const k = this.parent?.kids ?? []; return k[k.indexOf(this) + 1] ?? null; }

  get previousElementSibling() { const k = this.parent?.kids ?? []; return k[k.indexOf(this) - 1] ?? null; }
}

let page;
let restore;
let savedWindow;
const docL = {}; // document listeners and window listeners live as long as the file: initMenus() runs once, in before()
const winL = {};
before(() => {
  savedWindow = globalThis.window;
  globalThis.window = { innerWidth: 800, innerHeight: 800, addEventListener: (type, fn) => { (winL[type] ??= []).push(fn); } };
  restore = installDom({
    createElement: (tag) => new ME(tag),
    createElementNS: (ns, tag) => new ME(tag),
    createTextNode: (t) => new ME('#text', t),
    querySelector: (sel) => page.root.querySelector(sel),
    querySelectorAll: (sel) => page.root.all((n) => n.matches?.(sel)),
    addEventListener: (type, fn) => { (docL[type] ??= []).push(fn); },
  });
  Object.defineProperty(globalThis.document, 'activeElement', { get: () => focus.el, configurable: true });
  ui.initMenus(); // one set of listeners for the whole file; page.* is swapped for every test
});
after(() => {
  restore();
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
});

const WIDE = 220; // min-width of .menu
const ITEMS = ['Copy folder path', 'Stop using this folder as orchestrator', 'Remove from nika'];

/**
 * A page with one menu. `btn` is the button's rect (left/right/top/bottom), `w` the width the menu measures at, `vw` the window width.
 * `inside`: 'dlg' puts the menu in a scrolling dialog body with rect `box`, 'main' in the content column with rect `box`.
 */
function setup({ vw = 800, vh = 800, btn, w = WIDE, h = 100, inside = null, box = null } = {}) {
  const root = new ME('body');
  page = { root };
  globalThis.window.innerWidth = vw;
  globalThis.window.innerHeight = vh;
  focus.el = null;
  let host = root;
  if (inside) {
    host = new ME('div');
    host.className = inside === 'dlg' ? 'dlg-body' : 'main';
    host.rect = box;
    root.append(host);
  }
  const wrap = ui.menuEl('More actions', ITEMS.map((text) => ({ text, run: () => {} })), 'm');
  host.append(wrap);
  const button = wrap.kids[0];
  const menu = wrap.kids[1];
  button.rect = { ...btn, width: btn.right - btn.left, height: btn.bottom - btn.top };
  menu.offsetWidth = w;
  menu.offsetHeight = h;
  return { wrap, button, menu, items: menu.all((n) => n.tag === 'button') };
}

/** A click as the page sees it: the element's own handlers, then the document-level ones (initMenus). */
const press = (el) => {
  el.click();
  for (const fn of docL.click ?? []) fn({ type: 'click', target: el });
};
const esc = () => {
  let prevented = false;
  for (const fn of docL.keydown ?? []) fn({ key: 'Escape', preventDefault() { prevented = true; } });
  return prevented;
};
const resize = () => { for (const fn of winL.resize ?? []) fn({ type: 'resize' }); };

const btnAt = (left, right, top = 100) => ({ left, right, top, bottom: top + 28 });
/** Where the open menu's edges are on screen, as the browser would lay it out from the placement that was set. */
function edges(menu, button) {
  const p = menu.style.props;
  const x = menu.getAttribute('data-x');
  const width = p.width ? parseFloat(p.width) : menu.offsetWidth;
  const r = button.rect;
  const left = p.left !== undefined ? r.left + parseFloat(p.left) : x === 'start' ? r.left : r.right - width;
  return { left, right: left + width, width };
}

// ---- on open ------------------------------------------------------------------------------------------------------------------------

describe('a menu opens inside the window', () => {
  beforeEach(() => { page = null; });

  test('(+) room on the left of the button: right-aligned as before (no data-x, nothing set inline)', () => {
    const { button, menu } = setup({ btn: btnAt(400, 432) });
    press(button);
    assert.equal(menu.hidden, false);
    assert.equal(menu.getAttribute('data-x'), null);
    assert.deepEqual(menu.style.props, {});
  });

  test('(+) no room on the left, room on the right: aligned to the button\'s left edge (data-x="start")', () => {
    const { button, menu } = setup({ btn: btnAt(20, 52) });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'start');
    assert.deepEqual(menu.style.props, {}, 'the stylesheet does the work, nothing inline');
    const e = edges(menu, button);
    assert.ok(e.left >= MENU_EDGE && e.right <= 800 - MENU_EDGE);
  });

  test('(+) a window narrower than the menu: width capped to the window minus 16 px, both edges inside', () => {
    const { button, menu } = setup({ vw: 200, btn: btnAt(150, 182) });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'fit');
    assert.equal(menu.style.props.width, '184px', 'an explicit width: the wrapper is as narrow as the button, so a max-width alone shrinks to the longest word');
    assert.equal(menu.style.props['min-width'], '0px', 'the 220 px minimum must not win');
    assert.equal(menu.style.props.right, 'auto');
    const e = edges(menu, button);
    assert.ok(e.left >= MENU_EDGE, `left edge ${e.left}`);
    assert.ok(e.right <= 200 - MENU_EDGE, `right edge ${e.right}`);
  });

  test('(+) neither alignment fits but the window is wide enough: shifted without narrowing', () => {
    const { button, menu } = setup({ vw: 300, btn: btnAt(130, 160) });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'fit');
    assert.equal(menu.style.props.width, '220px', 'its own width, set outright so it cannot grow past what was measured');
    const e = edges(menu, button);
    assert.ok(e.left >= MENU_EDGE && e.right <= 300 - MENU_EDGE, `${e.left}..${e.right}`);
  });

  test('(+) a menu on a dialog body uses the body as its space, not the window (a body clips what sticks out of it)', () => {
    const { button, menu } = setup({ btn: btnAt(310, 340), inside: 'dlg', box: { left: 300, right: 780, top: 76, bottom: 800 } });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'start', 'the window has room on the left (120 px) but the body starts at 300');
  });

  test('(+) a menu in the content column keeps off the sidebar', () => {
    const { button, menu } = setup({ btn: btnAt(250, 282), inside: 'main', box: { left: 240, right: 800, top: 0, bottom: 800 } });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'start', 'right-aligned it would start at 62, over the sidebar');
  });

  test('(+) up/down is independent of left/right: a button near the bottom-left flips up and aligns start', () => {
    const { button, menu } = setup({ vh: 480, btn: btnAt(20, 52, 400), h: 120 });
    press(button);
    assert.equal(menu.dataset.up, '1');
    assert.equal(menu.getAttribute('data-x'), 'start');
  });

  test('(+) the menu is measured after the width was settled: a capped menu that wraps is flipped by its final height', () => {
    // 60 px high at its natural width, 150 px once capped to 184 so the items wrap: the flip must use the taller one (the fake measures at the width it has)
    const { button, menu } = setup({ vw: 200, vh: 500, btn: btnAt(150, 182, 360), h: 60 });
    Object.defineProperty(menu, 'offsetHeight', { get: () => (menu.style.props.width === '184px' ? 150 : 60), configurable: true });
    press(button);
    assert.equal(menu.dataset.up, '1', 'room below is 112 px: 60 + 16 would stay below, 150 + 16 does not fit below but fits above');
  });

  test('(−) no measurable window or menu width (not laid out): nothing is placed, the menu opens as before', () => {
    const a = setup({ vw: 0, btn: btnAt(20, 52) });
    press(a.button);
    assert.equal(a.menu.hidden, false);
    assert.equal(a.menu.getAttribute('data-x'), null);
    const b = setup({ btn: btnAt(20, 52), w: 0 });
    press(b.button);
    assert.equal(b.menu.hidden, false);
    assert.equal(b.menu.getAttribute('data-x'), null);
  });

  test('(−) keyboard behaviour is unchanged: focus goes to the first item on open, Esc closes and returns focus to the button', () => {
    const { button, menu, items } = setup({ btn: btnAt(20, 52) });
    press(button);
    assert.equal(focus.el, items[0]);
    assert.equal(esc(), true);
    assert.equal(menu.hidden, true);
    assert.equal(focus.el, button);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
  });
});

// ---- on close -----------------------------------------------------------------------------------------------------------------------

describe('closing a menu clears every placement it set', () => {
  test('(+) Esc: data-x, data-up and the inline width and offset go; the next open measures again', () => {
    const { button, menu } = setup({ vw: 200, vh: 400, btn: btnAt(150, 182, 300), h: 100 });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'fit');
    assert.equal(menu.dataset.up, '1');
    assert.ok(Object.keys(menu.style.props).length > 0);
    esc();
    assert.equal(menu.getAttribute('data-x'), null);
    assert.equal(menu.getAttribute('data-up'), null);
    assert.deepEqual(menu.style.props, {});
    // the window grew and the button moved: the second open must not reuse the first answer
    globalThis.window.innerWidth = 800;
    globalThis.window.innerHeight = 800;
    button.rect = { left: 400, right: 432, top: 100, bottom: 128, width: 32, height: 28 };
    press(button);
    assert.equal(menu.hidden, false);
    assert.equal(menu.getAttribute('data-x'), null, 'right-aligned now');
    assert.equal(menu.getAttribute('data-up'), null);
    assert.deepEqual(menu.style.props, {});
  });

  test('(+) a click elsewhere and a pick of an item close it the same way', () => {
    const { button, menu, items } = setup({ btn: btnAt(20, 52) });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'start');
    press(new ME('p')); // outside
    assert.equal(menu.hidden, true);
    assert.equal(menu.getAttribute('data-x'), null);
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'start');
    press(items[1]);
    assert.equal(menu.hidden, true);
    assert.equal(menu.getAttribute('data-x'), null);
  });

  test('(+) a second click on its own button closes it the same way (found in a real browser: that path set hidden by hand)', () => {
    const { button, menu } = setup({ vw: 200, vh: 400, btn: btnAt(150, 182, 300), h: 100 });
    press(button);
    assert.equal(menu.getAttribute('data-x'), 'fit');
    assert.equal(menu.dataset.up, '1');
    const held = new ME('input');
    held.focus(); // where focus is when the button is pressed again; closing this way must not move it
    press(button);
    assert.equal(menu.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(menu.getAttribute('data-x'), null);
    assert.equal(menu.getAttribute('data-up'), null);
    assert.deepEqual(menu.style.props, {});
    assert.equal(focus.el, held, 'focus was not moved');
    globalThis.window.innerWidth = 800;
    button.rect = { left: 400, right: 432, top: 100, bottom: 128, width: 32, height: 28 };
    press(button);
    assert.equal(menu.getAttribute('data-x'), null, 'the second open measured again');
    assert.equal(menu.getAttribute('data-up'), null, 'and does not keep the first open\'s flip');
  });

  test('(−) closing a menu that never needed a placement leaves nothing behind and throws nothing', () => {
    const { button, menu } = setup({ btn: btnAt(400, 432) });
    press(button);
    esc();
    assert.equal(menu.getAttribute('data-x'), null);
    assert.deepEqual(menu.style.props, {});
  });
});

// ---- a resize while a menu is open ------------------------------------------------------------------------------------------------

describe('a window resize closes an open menu', () => {
  test('(−) resize with a menu open: it closes (aria-expanded false, placement cleared); focus elsewhere stays where it is', () => {
    const { button, menu } = setup({ btn: btnAt(20, 52) });
    const elsewhere = new ME('input');
    page.root.append(elsewhere);
    press(button);
    elsewhere.focus();
    resize();
    assert.equal(menu.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(menu.getAttribute('data-x'), null);
    assert.equal(focus.el, elsewhere, 'focus was not taken');
  });

  test('(−) resize while focus sits on a menu item: the menu closes and focus moves to its button (a hidden control cannot hold focus)', () => {
    const { button, menu, items } = setup({ btn: btnAt(20, 52) });
    press(button);
    assert.equal(focus.el, items[0]);
    resize();
    assert.equal(menu.hidden, true);
    assert.equal(focus.el, button);
  });

  test('(−) resize with no menu open does nothing (no focus change, nothing thrown)', () => {
    const { button } = setup({ btn: btnAt(20, 52) });
    button.focus();
    resize();
    assert.equal(focus.el, button);
  });

  test('(−) the listener is a window listener, registered once by the one initMenus() call', () => {
    assert.equal(winL.resize?.length, 1);
  });
});

// ---- the stylesheet -----------------------------------------------------------------------------------------------------------------

describe('the stylesheet follows the placement', () => {
  const decl = (sel) => {
    const esc2 = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n|\\})\\s*${esc2}\\s*\\{([^}]*)\\}`).exec(CSS);
    return m ? m[1] : null;
  };

  test('(+) .menu is still right-aligned by default; data-x="start" aligns it to the left edge of its wrapper', () => {
    assert.match(decl('.menu') ?? '', /right:\s*0/);
    const start = decl('.menu[data-x="start"]') ?? '';
    assert.match(start, /left:\s*0/);
    assert.match(start, /right:\s*auto/);
  });

  test('(+) in the narrowed placement the items wrap (also the value menus that otherwise do not)', () => {
    const fit = decl('.menu[data-x="fit"] button, .menu[data-x="fit"] a') ?? '';
    assert.match(fit, /white-space:\s*normal/);
    assert.match(fit, /overflow-wrap:\s*anywhere/);
  });

  test('(−) the menu is still absolutely positioned inside its wrapper (no fixed position, no portal)', () => {
    assert.match(decl('.menu') ?? '', /position:\s*absolute/);
    assert.doesNotMatch(decl('.menu') ?? '', /position:\s*fixed/);
  });
});
