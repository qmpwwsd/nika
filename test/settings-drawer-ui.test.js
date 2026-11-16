// Final review R2 #5 (release 0.5): the project page's cards (Rules, Project setup, New agents) have one home at a time, the page column or the
// Settings drawer. The drawer's own title is the <h2 id="su-h">Settings</h2>, so the cards inside it must be one level below it in a screen
// reader's heading list: real h3 elements for the card titles and h4 for the Plugins and Models headings (no aria-level); in the column they
// stay h2 and h3 as they always were. The real page code (project.js, ui.js, app.js swap) runs against the
// same small fake page as test/setup-drawer.test.js (the page-building part below is a trimmed copy of it, because that file exports nothing)
// and recorded requests. Names and ids are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, focus } from './fake-dom.js';
import { h, icon } from '../public/dom.js';
import * as ui from '../public/ui.js';
import { orchState, roleTag, savedPick, otherRunning, spawnLimits, effectiveAgents } from '../public/dash-model.js';
import { parseModes, modesAfter, settingModeEl, MODE_META } from '../public/modes.js';
import { pluginView, pluginSave, sortIds, countText, filterNote } from '../public/plugin-view.js';
import {
  CUSTOM, MODEL_ID, MODEL_HINT, ROLES, ROLE_LABEL, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels,
} from '../public/models-ui.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const PROJECT_SRC = code(read('project.js')).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
const APP = code(read('app.js'));
const SWAP_SRC = APP.slice(APP.indexOf('export function swap('), APP.indexOf('\n}\n', APP.indexOf('export function swap(')) + 2).replace('export ', '');

// ---- a small fake page: the real ui.js, app.js swap and project.js run on it ------------------------------------------------------

const TOKEN = /(^[a-z][a-z0-9]*)|#([\w-]+)|\.([\w-]+)|:not\(\[([\w-]+)\]\)|\[([\w-]+)(?:="([^"]*)")?\]/g;
class PEl extends El {
  replaceChildren(...nodes) {
    if (focus.el && this.contains(focus.el) && !nodes.some((n) => n.contains?.(focus.el))) focus.el = null; // a browser drops the focus of a control that leaves the page
    for (const k of this.kids) k.parent = null;
    super.replaceChildren(...nodes);
  }

  contains(n) {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }

  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n.attached === true;
  }

  get classList() {
    const el = this;
    const list = () => el.className.split(/\s+/).filter(Boolean);
    const set = (l) => { el.className = l.join(' '); };
    return {
      contains: (c) => list().includes(c),
      add: (c) => set([...new Set([...list(), c])]),
      remove: (c) => set(list().filter((x) => x !== c)),
      toggle: (c, on) => { const has = list().includes(c); const want = on ?? !has; set(want ? [...new Set([...list(), c])] : list().filter((x) => x !== c)); return want; },
    };
  }

  has(a) { return a === 'open' ? this.open : a === 'hidden' ? this.hidden : a in this.attrs; }

  matches(sel) {
    let any = false;
    let ok = true;
    for (const [, tag, id, cls, not, attr, val] of sel.matchAll(TOKEN)) {
      any = true;
      if (tag) ok &&= this.tag === tag;
      else if (id) ok &&= this.attrs.id === id;
      else if (cls) ok &&= this.className.split(/\s+/).includes(cls);
      else if (not) ok &&= !this.has(not);
      else if (attr) ok &&= this.has(attr) && (val === undefined || this.attrs[attr] === val);
    }
    return any && ok;
  }

  closest(sel) {
    for (let x = this; x; x = x.parent) if (x.matches?.(sel)) return x;
    return null;
  }

  querySelector(sel) { return this.all((n) => n.matches(sel))[0] ?? null; }

  get nextElementSibling() {
    const k = this.parent?.kids ?? [];
    return k[k.indexOf(this) + 1] ?? null;
  }

  get previousElementSibling() {
    const k = this.parent?.kids ?? [];
    return k[k.indexOf(this) - 1] ?? null;
  }

  getBoundingClientRect() { return this.rect ?? { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }

  scrollIntoView(o) { this.scrolled = o ?? {}; }

  close() { if (this.open) super.close(); } // a dialog that is not open ignores close(), as in a browser
}

let page = null;
let restore;
let savedCSS;
before(() => {
  savedCSS = globalThis.CSS;
  globalThis.CSS = { escape: (s) => String(s) };
  globalThis.window = { innerHeight: 800, addEventListener() {} }; // ui.js menus ask for the window height (and listen for a resize; the width is left out: no left/right placement here)
  restore = installDom({
    createElement: (tag) => new PEl(tag),
    createElementNS: (ns, tag) => new PEl(tag),
    createTextNode: (t) => new PEl('#text', t),
    querySelector(sel) {
      if (sel === '.screen:not([hidden]) h1') return page.body.querySelector('#proj-h');
      const hit = page.body.querySelector(sel);
      const id = /^#([\w-]+)$/.exec(sel)?.[1];
      if (hit || !id) return hit;
      const e = new PEl(id.startsWith('dlg-') ? 'dialog' : 'div'); // a node the page code asks for that this fake page does not model: a loose div
      e.attrs.id = id;
      page.body.append(e);
      return e;
    },
    querySelectorAll: (sel) => page.body.all((n) => n.matches(sel)),
    addEventListener: (type, fn) => { (page.docL[type] ??= []).push(fn); },
    getSelection: () => null,
  });
  Object.defineProperty(globalThis.document, 'activeElement', { get: () => focus.el, configurable: true });
});
after(() => {
  restore();
  delete globalThis.window;
  if (savedCSS === undefined) delete globalThis.CSS;
  else globalThis.CSS = savedCSS;
});

/** The dialogs in the order of index.html (drawer first), the drawer's own markup, and the project screen's hosts. */
function buildPage() {
  const body = new PEl('body');
  body.attached = true;
  const add = (parent, tag, id, cls = '') => {
    const e = new PEl(tag);
    if (id) e.attrs.id = id;
    e.className = cls;
    parent.append(e);
    return e;
  };
  const dlg = {};
  for (const n of ['setup', 'spawn', 'rules', 'plugins', 'models', 'confirm']) dlg[n] = add(body, 'dialog', `dlg-${n}`, n === 'setup' ? 'sheet' : '');
  const head = add(dlg.setup, 'div', null, 'dlg-head');
  add(head, 'h2', 'su-h').attrs.tabindex = '-1';
  add(head, 'p', 'su-d');
  const x = add(head, 'button', null, 'btn icon ghost');
  x.attrs['data-close'] = '';
  x.attrs['aria-label'] = 'Close';
  add(dlg.setup, 'div', 'su-body', 'dlg-body');
  const main = add(body, 'section', null, 'screen');
  const h1 = add(main, 'h1', 'proj-h');
  h1.attrs.tabindex = '-1';
  for (const id of ['proj-rules', 'proj-settings', 'proj-ended-wrap', 'proj-actions', 'proj-agents', 'proj-setup']) add(main, id === 'proj-setup' ? 'aside' : 'div', id);
  return { body, dlg, x, docL: {} };
}

const KEY = '0123456789abcdef';
const SETTINGS = {
  models: { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-sonnet-5-5', scout: 'claude-haiku-5-5' },
  limits: { maxAgents: 3 }, permissionMode: 'default', panePlacement: 'beside', perProject: {},
};
const CFG_URL = `/api/app/projects/${KEY}/config`;

function rig({ narrow = false, matchMedia = true, rules = 'nika', sub = true } = {}) {
  page = buildPage();
  focus.el = null;
  const proj = { key: KEY, dir: '/work/demo-api', name: 'demo-api', rules: { state: rules }, orchestrator: null };
  const g = { key: KEY, label: 'demo-api', project: proj, agents: [] };
  const mq = { matches: narrow, listeners: [], asked: [], addEventListener(type, fn) { if (type === 'change') this.listeners.push(fn); } };
  const winL = {};
  const window = {
    addEventListener: (type, fn) => { (winL[type] ??= []).push(fn); },
    ...(matchMedia ? { matchMedia: (q) => { mq.asked.push(q); return mq; } } : {}),
  };
  const state = { error: null, me: { tmux: true, claude: true }, projects: [proj], settings: JSON.parse(JSON.stringify(SETTINGS)), modes: { map: {}, misses: 0 }, route: { name: 'project', key: KEY }, open: new Set(), expanded: new Set(), plugins: null, showEnded: false, models: null };
  const calls = [];
  const renders = [];
  const appFetch = async (url, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${url}`);
    if (opts.method === 'PUT' && url === CFG_URL) return { status: 200, body: { plugins: [], models: {}, permissionMode: null, panePlacement: null, maxAgents: null, ...opts.json } };
    throw new Error(`down: ${url}`); // the dialogs opened from the cards show their load error; nothing here needs their data
  };
  const swap = vm.runInNewContext(`${SWAP_SRC}\nswap`, { document: globalThis.document, $: ui.$, CSS: globalThis.CSS });
  const ctx = {
    h, icon, $: ui.$, state, hooks: {}, appFetch, applyTheme: () => {}, menuEl: ui.menuEl, sessionHref: ui.sessionHref, RX: ui.RX, roleTag, orchState, savedPick, otherRunning, spawnLimits, effectiveAgents,
    syncRadioCards: () => {}, parseModes, modesAfter, settingModeEl, MODE_META, pluginView, pluginSave, sortIds, countText, filterNote,
    CUSTOM, MODEL_ID, MODEL_HINT, ROLES, ROLE_LABEL, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels,
    location: { set href(v) {}, get href() { return ''; }, hash: '' }, document: { title: '', getElementById: () => null, get activeElement() { return focus.el; } }, CSS: globalThis.CSS,
    toast: () => ({ remove() {} }), announce: () => {}, errText: (r) => r?.body?.message ?? `The server answered ${r?.status}.`, copyText: () => {},
    setBusy: () => {}, fieldError: () => {}, openDialog: ui.openDialog, closeMenu: ui.closeMenu, render: (force) => renders.push(force),
    buildGroups: () => [g], agentNodes: () => [h('ul')], swap, interacting: () => false, rulesEl: () => h('span', { class: 'rules' }),
    setTimeout, clearTimeout, AbortController, TextEncoder, window,
  };
  const api = vm.runInNewContext(`${PROJECT_SRC}\n({ renderProject, wireSetup, openSetup })`, ctx);
  ui.initDialogs();
  ui.initMenus();
  const q = (id) => page.body.querySelector(`#${id}`);
  const r = {
    api, proj, g, state, calls, renders, mq, winL, window, ...page,
    q, drawer: q('dlg-setup'), column: q('proj-setup'), body: q('su-body'), actions: q('proj-actions'),
    host: q('proj-settings'),
    setupBtn: () => r.host.byFk(`setup:${KEY}`),
    titles: (host) => host.all((n) => n.tag === 'h2').map((n) => n.textContent),
    ids: () => page.body.all((n) => 'id' in n.attrs).map((n) => n.attrs.id),
    /** A click as the page sees it: the element's own handlers, then the document-level ones (initDialogs, initMenus). */
    press(el) {
      el.click();
      for (const fn of page.docL.click ?? []) fn({ type: 'click', target: el });
    },
    /** Esc in a browser: `cancel` first, and the dialog closes unless the page vetoed it. */
    esc(dlg) {
      if (!dlg.fire('cancel').defaultPrevented) dlg.close();
    },
    narrower(on) { // the window crosses 1030 px
      mq.matches = on;
      for (const fn of mq.listeners) fn({ matches: on });
    },
  };
  return r;
}

// ---- heading elements -------------------------------------------------------------------------------------------------------------

const CARDS = ['Rules', 'Project setup', 'New agents'];
const INNER = ['Plugins', 'Models'];
const HEADING = /^h[1-6]$/;
const level = (n) => Number(n.tag.slice(1));
/** Every heading under `host` in document order, as [text, tag]; the little "2 on" / "1 set here" note inside a heading is kept in the text. */
const outline = (host) => host.all((n) => HEADING.test(n.tag)).map((n) => [n.textContent, n.tag]);
/** The card titles: the first child of each card. */
const titlesOf = (host) => host.all((n) => n.className === 'card').map((c) => c.kids[0]);
const titleTags = (host) => titlesOf(host).map((n) => [n.textContent, n.tag]);
const innerTags = (host) => outline(host).filter(([text]) => INNER.some((w) => text.startsWith(w)));
const plain = (host) => host.all((n) => HEADING.test(n.tag) && 'aria-level' in n.attrs).length === 0;
/** What a card sets for this project, so the Plugins and Models headings carry their "2 on" / "1 set here" notes. */
const withChoices = (r) => {
  r.state.settings.perProject[r.proj.key] = { plugins: ['alpha@market', 'beta@market'], models: { builder: 'claude-sonnet-5-5' } };
  return r;
};

describe('the cards inside the Settings drawer are one heading level below its title, as real heading elements', () => {
  test('(+) narrow: the drawer title is an h2, and Rules, Project setup and New agents are h3', () => {
    const r = rig({ narrow: true });
    r.api.renderProject(true);
    assert.equal(r.q('su-h').tag, 'h2', "the drawer's own heading");
    assert.deepEqual(titleTags(r.body), CARDS.map((c) => [c, 'h3']));
  });

  test('(+) narrow: the Plugins and Models headings inside Project setup are h4, one below their card title', () => {
    const r = rig({ narrow: true });
    r.api.renderProject(true);
    assert.deepEqual(innerTags(r.body), INNER.map((c) => [c, 'h4']));
  });

  test('(−) narrow: no aria-level anywhere (the elements carry the level), and no h2 is left in the drawer body', () => {
    const r = withChoices(rig({ narrow: true }));
    r.api.renderProject(true);
    assert.ok(plain(r.body), 'no heading in the drawer has an aria-level');
    assert.ok(plain(r.drawer), 'nor the drawer title');
    assert.equal(r.body.all((n) => n.tag === 'h2').length, 0);
    assert.equal(r.body.all((n) => n.tag === 'h1').length, 0);
  });

  test('(−) narrow: the drawer outline never goes down more than one level, from the title to the last heading', () => {
    for (const choices of [false, true]) {
      const r = rig({ narrow: true });
      if (choices) withChoices(r);
      r.api.renderProject(true);
      const levels = [level(r.q('su-h')), ...r.body.all((n) => HEADING.test(n.tag)).map(level)];
      for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `heading ${i} (level ${levels[i]}) follows level ${levels[i - 1]}: ${levels.join(',')}`);
      assert.ok(levels.slice(1).every((l) => l > 2), `nothing in the drawer body is level 2 or higher up: ${levels.join(',')}`);
    }
  });

  test('(−) wide: the cards in the column are h2 with h3 inside, as before: no h4, no aria-level', () => {
    const r = rig({ narrow: false });
    r.api.renderProject(true);
    assert.deepEqual(titleTags(r.column), CARDS.map((c) => [c, 'h2']));
    assert.deepEqual(innerTags(r.column), INNER.map((c) => [c, 'h3']));
    assert.equal(r.column.all((n) => n.tag === 'h4').length, 0);
    assert.ok(plain(r.column));
  });

  test('(−) without matchMedia the page is wide, so the column keeps h2 / h3 and the drawer body stays empty', () => {
    const r = rig({ matchMedia: false });
    r.api.renderProject(true);
    assert.deepEqual(titleTags(r.column), CARDS.map((c) => [c, 'h2']));
    assert.deepEqual(innerTags(r.column), INNER.map((c) => [c, 'h3']));
    assert.equal(r.body.kids.length, 0);
  });

  test('(+) the same words in both homes: titles and the "2 on" / "1 set here" notes are identical, only the element changes', () => {
    const wide = withChoices(rig({ narrow: false }));
    wide.api.renderProject(true);
    const narrow = withChoices(rig({ narrow: true }));
    narrow.api.renderProject(true);
    const texts = (host) => outline(host).map(([text]) => text);
    assert.deepEqual(texts(narrow.body), texts(wide.column));
    assert.deepEqual(texts(wide.column), ['Rules', 'Project setup', 'Plugins 2 on', 'Models 1 set here', 'New agents']);
    const note = (host, tag) => host.all((n) => n.tag === tag).map((n) => n.all((k) => k.className === 'help').map((k) => k.textContent)).filter((l) => l.length);
    assert.deepEqual(note(narrow.body, 'h4'), [['2 on'], ['1 set here']], 'the note span survives inside the h4');
    assert.deepEqual(note(wide.column, 'h3'), [['2 on'], ['1 set here']]);
  });
});

describe('the heading elements follow the cards when the window crosses the switch width', () => {
  test('(+) wide to narrow: the column is emptied and the drawer has h3 titles with h4 inside', () => {
    const r = rig({ narrow: false });
    r.api.wireSetup();
    r.api.renderProject(true);
    assert.deepEqual(titleTags(r.column), CARDS.map((c) => [c, 'h2']));
    r.narrower(true);
    assert.equal(r.column.kids.length, 0);
    assert.deepEqual(titleTags(r.body), CARDS.map((c) => [c, 'h3']));
    assert.deepEqual(innerTags(r.body), INNER.map((c) => [c, 'h4']));
  });

  test('(+) narrow to wide: the cards leave the drawer and come back to the column as h2 / h3, with no h4 and no aria-level left over', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    assert.deepEqual(titleTags(r.body), CARDS.map((c) => [c, 'h3']));
    r.narrower(false);
    assert.equal(r.body.kids.length, 0, 'the drawer body is emptied');
    assert.deepEqual(titleTags(r.column), CARDS.map((c) => [c, 'h2']));
    assert.deepEqual(innerTags(r.column), INNER.map((c) => [c, 'h3']));
    assert.equal(r.column.all((n) => n.tag === 'h4').length, 0);
    assert.ok(plain(r.column), 'nothing from the drawer is carried back');
  });

  test('(−) narrow, wide, narrow again, wide again: every move gives the elements of its own home and the very same text', () => {
    const r = withChoices(rig({ narrow: true }));
    r.api.wireSetup();
    r.api.renderProject(true);
    const words = (host) => outline(host).map(([text]) => text);
    const first = words(r.body);
    assert.equal(first.length, 5);
    const seen = [];
    for (const on of [false, true, false, true]) {
      r.narrower(on);
      const host = on ? r.body : r.column;
      seen.push([on, outline(host).map(([, tag]) => tag).join(','), words(host).join('|'), (on ? r.column : r.body).kids.length]);
    }
    const wideTags = 'h2,h2,h3,h3,h2';
    const narrowTags = 'h3,h3,h4,h4,h3';
    assert.deepEqual(seen, [[false, wideTags, first.join('|'), 0], [true, narrowTags, first.join('|'), 0], [false, wideTags, first.join('|'), 0], [true, narrowTags, first.join('|'), 0]]);
  });

  test('(+) a second render in the same placement keeps the elements', () => {
    for (const narrow of [true, false]) {
      const r = rig({ narrow });
      r.api.renderProject(true);
      r.api.renderProject(true);
      assert.deepEqual(titleTags(narrow ? r.body : r.column), CARDS.map((c) => [c, narrow ? 'h3' : 'h2']), `narrow=${narrow}`);
      assert.deepEqual(innerTags(narrow ? r.body : r.column), INNER.map((c) => [c, narrow ? 'h4' : 'h3']), `narrow=${narrow}`);
    }
  });
});

describe('a focused control or an open drawer stays usable after the elements change', () => {
  const KEEP = 'choose-plugins';

  test('(+) growing with the drawer open and a card control focused: the drawer closes, the same control in the column has the focus and works', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    assert.equal(r.drawer.open, true);
    r.body.byFk(KEEP).focus();
    r.narrower(false);
    assert.equal(r.drawer.open, false);
    assert.equal(focus.el, r.column.byFk(KEEP), 'the same control, in its new home');
    assert.deepEqual(titleTags(r.column), CARDS.map((c) => [c, 'h2']));
    const before = r.calls.length;
    r.press(focus.el);
    assert.ok(r.calls.length > before, 'its click handler runs: Choose plugins asks the server for the list');
  });

  test('(+) shrinking with a column control focused: the Settings button has the focus, the drawer stays closed, and the button opens it on h3 / h4', () => {
    const r = rig({ narrow: false });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.column.byFk(KEEP).focus();
    r.narrower(true);
    assert.equal(focus.el, r.setupBtn());
    assert.equal(r.drawer.open, false);
    r.press(r.setupBtn());
    assert.equal(r.drawer.open, true);
    assert.deepEqual(titleTags(r.body), CARDS.map((c) => [c, 'h3']));
    assert.equal(focus.el, r.q('su-h'), 'focus goes to the drawer title (still an h2)');
    const before = r.calls.length;
    r.press(r.body.byFk(KEEP));
    assert.ok(r.calls.length > before, 'a control inside the drawer works');
  });

  test('(+) an open drawer that renders again stays open with the same elements, and its title keeps the focus', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    assert.equal(focus.el, r.q('su-h'));
    r.api.renderProject(true);
    assert.equal(r.drawer.open, true);
    assert.equal(focus.el, r.q('su-h'));
    assert.deepEqual(titleTags(r.body), CARDS.map((c) => [c, 'h3']));
    assert.deepEqual(innerTags(r.body), INNER.map((c) => [c, 'h4']));
  });

  test('(−) a round trip with the drawer open at each end: it closes on growing, opens again on the button, and the elements are right each time', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    for (let i = 0; i < 2; i++) {
      r.press(r.setupBtn());
      assert.equal(r.drawer.open, true, `round ${i}: open`);
      assert.deepEqual(titleTags(r.body), CARDS.map((c) => [c, 'h3']), `round ${i}`);
      r.narrower(false);
      assert.equal(r.drawer.open, false, `round ${i}: closed on growing`);
      assert.deepEqual(titleTags(r.column), CARDS.map((c) => [c, 'h2']), `round ${i}`);
      r.narrower(true);
      assert.equal(r.column.kids.length, 0, `round ${i}: the column is empty again`);
    }
  });
});

// ---- the stylesheet: the drawer's h3 / h4 look exactly like the column's h2 / h3 ------------------------------------------------------

describe('app.css: the cards look the same in the drawer as in the column', () => {
  const CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  /** [selector, sorted declarations] of every top-level rule whose selector is exactly one of `selectors`. */
  const rules = (selectors) => [...CSS.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)]
    .filter((m) => selectors.includes(m[1].replace(/\s+/g, ' ')))
    .map((m) => [m[1].replace(/\s+/g, ' '), m[2].split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean).sort().join('; ')]);
  const body = (sel) => Object.fromEntries(rules([sel]).map(([s, d]) => [s, d]))[sel];
  // each column rule and the drawer rule that must carry the same declarations
  const TWINS = [['.card h2', '#su-body .card h3'], ['.card h3', '#su-body .card h4'], ['.card h3 .help', '#su-body .card h4 .help']];

  for (const [column, drawer] of TWINS) {
    test(`(+) ${drawer} has the declarations of ${column}`, () => {
      assert.ok(body(column), `${column} exists`);
      assert.equal(body(drawer), body(column));
    });
  }

  test('(−) the drawer rules are scoped to #su-body: the only rules for .card h3 / h4 are the column pair and the drawer pair', () => {
    const selectors = [...CSS.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{/g)].map((m) => m[1].replace(/\s+/g, ' '));
    assert.deepEqual(selectors.filter((s) => /\.card h[34]\b/.test(s)).sort(),
      ['#su-body .card h3', '#su-body .card h4', '#su-body .card h4 .help', '.card h3', '.card h3 .help']);
  });

  test('(−) every `.card h2` / `.card h3` rule in the stylesheet has a drawer twin (a new column rule without one fails here)', () => {
    const all = [...CSS.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{/g)].map((m) => m[1].replace(/\s+/g, ' ')).filter((s) => /^\.card h[23]\b/.test(s));
    assert.deepEqual(all.sort(), TWINS.map(([c]) => c).sort(), 'the rules this test pairs up are all the column rules there are');
  });

  test('(−) the drawer rules win over the column rules: an id selector against a class selector', () => {
    assert.match(CSS, /#su-body \.card h3 \{/);
    assert.doesNotMatch(CSS, /\[aria-level/);
  });
});
