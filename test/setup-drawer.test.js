// 0.4.0, G3: on a window 1030 px wide or narrower the project page no longer stacks the Rules, Project setup and New agents cards under
// the agents list; a "Setup" button opens them in a right-hand drawer (a <dialog class="sheet">, like the Spawn sheet). The browser is
// exercised by hand; here the real page code (project.js, ui.js, app.js swap) runs against a small fake page (test/fake-dom.js plus the
// selector matching below) and recorded requests, and the markup and the stylesheet are read as text. Names and ids are synthetic.
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
const settle = () => new Promise((r) => setImmediate(r));
const PROJECT_SRC = code(read('project.js')).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
const APP = code(read('app.js'));
const SWAP_SRC = APP.slice(APP.indexOf('export function swap('), APP.indexOf('\n}\n', APP.indexOf('export function swap(')) + 2).replace('export ', '');
const HTML = read('index.html');
const CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- source checks: the markup and the stylesheet ---------------------------------------------------------------------------------

/** The text between the braces of the first block that starts with `head` (an @media line), nested braces counted. */
function block(css, head) {
  const at = css.indexOf(head);
  assert.ok(at >= 0, `${head} exists`);
  const open = css.indexOf('{', at);
  for (let i = open, depth = 0; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`${head} is not closed`);
}
/** The stylesheet without its @media blocks. */
function outsideMedia(css) {
  let out = css;
  for (let at = out.indexOf('@media'); at >= 0; at = out.indexOf('@media')) {
    const open = out.indexOf('{', at);
    let end = open;
    for (let depth = 0; end < out.length; end++) {
      if (out[end] === '{') depth += 1;
      else if (out[end] === '}' && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
}
const decl = (css, selector) => new RegExp(`(?:^|[}\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? null;

describe('the drawer markup (index.html)', () => {
  const dlg = /<dialog\b[^>]*\bid="dlg-setup"[^>]*>[\s\S]*?<\/dialog>/.exec(HTML)?.[0] ?? '';

  test('(+) a labelled <dialog class="sheet"> for the app tier, titled Setup, with the project name as a muted subtitle and a body to scroll', () => {
    assert.ok(dlg, '#dlg-setup exists');
    const open = /<dialog\b[^>]*>/.exec(dlg)[0];
    assert.match(open, /\bclass="sheet\b/);
    assert.match(open, /\baria-labelledby="su-h"/);
    assert.match(open, /\bdata-app-only\b/);
    assert.match(dlg, /<h2 id="su-h" tabindex="-1">Setup<\/h2>/);
    assert.match(dlg, /<p id="su-d"><\/p>/);
    assert.match(dlg, /<div class="dlg-body" id="su-body"><\/div>/);
  });

  test('(+) an × button closes it: data-close, an accessible name and a tooltip', () => {
    const x = /<button\b[^>]*\bdata-close\b[^>]*>/.exec(dlg)?.[0] ?? '';
    assert.match(x, /\baria-label="Close"/);
    assert.match(x, /\btitle="Close"/);
  });

  test('(+) it sits before the other dialogs, so the first open dialog in the page is the drawer when it is under another one', () => {
    const at = (id) => HTML.indexOf(`<dialog id="${id}"`);
    assert.ok(at('dlg-setup') >= 0);
    for (const id of ['dlg-spawn', 'dlg-rules', 'dlg-plugins', 'dlg-models', 'dlg-confirm']) assert.ok(at('dlg-setup') < at(id), id);
  });

  test('(−) the page column keeps its place and its name; the browser tier gets nothing new (the whole project screen is app-only)', () => {
    assert.match(HTML, /<aside aria-label="Project details" id="proj-setup"><\/aside>/);
    assert.match(HTML, /<section class="screen" data-screen="project"[^>]*\bdata-app-only\b/);
    assert.equal((HTML.match(/id="proj-setup"/g) ?? []).length, 1);
    assert.equal((HTML.match(/id="su-body"/g) ?? []).length, 1);
  });

  test('(+) the panel icon exists in the sprite', () => {
    assert.match(HTML, /<symbol id="i-panel" viewBox="0 0 16 16">/);
  });
});

describe('the stylesheet: the breakpoint is 1030 px', () => {
  const narrow = block(CSS, '@media (max-width: 1030px)');
  const wide = outsideMedia(CSS);

  test('(+) inside the 1030 px query the cards column is hidden from the grid and the Setup button shows', () => {
    assert.match(decl(narrow, '#proj-setup') ?? '', /display:\s*none/);
    assert.match(decl(narrow, '.btn.setup-open') ?? '', /display:\s*inline-flex/);
    assert.match(decl(narrow, '.proj-grid') ?? '', /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  test('(−) outside it the Setup button is display: none and the column is not hidden', () => {
    assert.match(decl(wide, '.btn.setup-open') ?? '', /display:\s*none/);
    assert.doesNotMatch(decl(wide, '#proj-setup') ?? '', /display:\s*none/);
  });

  test('(−) no smaller query re-hides or re-shows the column or the button (one switch only)', () => {
    for (const q of ['@media (max-width: 900px)', '@media (max-width: 760px)']) {
      const b = block(CSS, q);
      assert.equal(decl(b, '#proj-setup'), null, q);
      assert.equal(decl(b, '.btn.setup-open'), null, q);
    }
  });

  test('(+) the drawer reuses the Spawn sheet: the class .sheet gives the width, the slide-in and the full height', () => {
    assert.match(decl(wide, 'dialog.sheet') ?? '', /margin:\s*0 0 0 auto/);
    assert.match(decl(wide, 'dialog.sheet[open]') ?? '', /animation:\s*sheet-in/);
  });

  test('(+) the cards in the drawer sit in the body grid, so the card-to-card margin of the column is not added to its gap', () => {
    assert.match(decl(wide, '#su-body .card + .card') ?? '', /margin-top:\s*0/);
  });
});

// ---- a small fake page: the real ui.js, app.js swap and project.js run on it ------------------------------------------------------

const TOKEN = /(^[a-z][a-z0-9]*)|#([\w-]+)|\.([\w-]+)|:not\(\[([\w-]+)\]\)|\[([\w-]+)(?:="([^"]*)")?\]/g;
class PEl extends El {
  replaceChildren(...nodes) {
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
  globalThis.window = { innerHeight: 800 }; // ui.js menus ask for the window height
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
  for (const id of ['proj-rules', 'proj-actions', 'proj-ended-wrap', 'proj-agents', 'proj-setup']) add(main, id === 'proj-setup' ? 'aside' : 'div', id);
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
    location: { set href(v) {}, get href() { return ''; }, hash: '' }, document: { title: '', getElementById: () => null },
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
    setupBtn: () => r.actions.byFk(`setup:${KEY}`),
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

const CARDS = ['Rules', 'Project setup', 'New agents'];

// ---- the Setup button -------------------------------------------------------------------------------------------------------------

describe('the Setup button in the project header', () => {
  test('(+) the word Setup and a panel icon, announced as a dialog opener for the drawer, with a focus key like the other header buttons', () => {
    const r = rig();
    r.api.renderProject(true);
    const b = r.setupBtn();
    assert.ok(b, 'a button with data-fk setup:<key>');
    assert.equal(b.tag, 'button');
    assert.equal(b.attrs.type, 'button');
    assert.match(b.className, /\bbtn\b/);
    assert.match(b.className, /\bsetup-open\b/);
    assert.equal(b.attrs['aria-haspopup'], 'dialog');
    assert.equal(b.attrs['aria-controls'], 'dlg-setup');
    assert.equal(b.attrs['aria-label'], 'Setup');
    assert.equal(b.attrs.title, 'Setup', 'icon only below 760 px: the name is also its tooltip');
    assert.equal(b.textContent, 'Setup');
    assert.deepEqual(b.all((n) => n.tag === 'use').map((n) => n.attrs.href), ['#i-panel']);
    assert.equal(b.all((n) => n.className === 'lbl')[0].textContent, 'Setup', 'the .lbl span is what the narrowest rule hides');
  });

  test('(+) it sits right after Spawn sub-orchestrator and before the More actions menu', () => {
    const r = rig();
    r.api.renderProject(true);
    const kids = r.actions.kids;
    const at = (fk) => kids.findIndex((k) => k.attrs['data-fk'] === fk);
    assert.ok(at(`spawn-sub:${KEY}`) >= 0, 'the header has Spawn sub-orchestrator');
    assert.equal(at(`setup:${KEY}`), at(`spawn-sub:${KEY}`) + 1);
    assert.match(kids[at(`setup:${KEY}`) + 1].className, /\bmenu-wrap\b/);
  });

  test('(−) the dashboard group actions do not get one (the cards exist only on the project page)', () => {
    assert.doesNotMatch(PROJECT_SRC.slice(PROJECT_SRC.indexOf('function groupActions('), PROJECT_SRC.indexOf('function subButton(')), /setup/i);
  });

  test('(−) it works while the server is unreachable (it is not gated like Start and Spawn)', () => {
    const r = rig({ narrow: true });
    r.state.me = { tmux: false, claude: false };
    r.api.renderProject(true);
    assert.notEqual(r.setupBtn().attrs['aria-disabled'], 'true');
    r.press(r.setupBtn());
    assert.equal(r.drawer.open, true);
  });
});

// ---- where the cards live ---------------------------------------------------------------------------------------------------------

describe('one home for the cards: the column when wide, the drawer when narrow', () => {
  test('(+) narrow: Rules, Project setup and New agents are in the drawer body; the column holds nothing', () => {
    const r = rig({ narrow: true });
    r.api.renderProject(true);
    assert.deepEqual(r.titles(r.body), CARDS);
    assert.equal(r.column.kids.length, 0);
    assert.deepEqual(r.mq.asked, ['(max-width: 1030px)'], 'the same query as the stylesheet');
  });

  test('(−) wide: the cards are in the column and the drawer body is empty', () => {
    const r = rig({ narrow: false });
    r.api.renderProject(true);
    assert.deepEqual(r.titles(r.column), CARDS);
    assert.equal(r.body.kids.length, 0);
  });

  test('(−) without matchMedia the page is wide: the column, as before', () => {
    const r = rig({ matchMedia: false });
    r.api.renderProject(true);
    assert.deepEqual(r.titles(r.column), CARDS);
    assert.equal(r.body.kids.length, 0);
  });

  test('(−) no id appears twice in the document, in either layout and after a second render', () => {
    for (const narrow of [true, false]) {
      const r = rig({ narrow });
      r.api.renderProject(true);
      r.api.renderProject(true);
      const ids = r.ids();
      assert.ok(ids.length > 5, 'the page has ids to compare');
      assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `narrow=${narrow}`);
    }
  });

  test('(+) the drawer subtitle is the project name, as text', () => {
    const r = rig({ narrow: true });
    r.proj.name = 'web-shop <b>';
    r.api.renderProject(true);
    assert.equal(r.q('su-d').textContent, 'web-shop <b>');
    assert.equal(r.q('su-d').kids.length, 0, 'textContent only: no child nodes');
  });

  test('(−) a project that is not registered leaves both homes empty', () => {
    const r = rig({ narrow: true });
    r.api.renderProject(true);
    r.state.route = { name: 'project', key: 'ffffffffffffffff' };
    r.api.renderProject(true);
    assert.equal(r.body.kids.length, 0);
    assert.equal(r.column.kids.length, 0);
  });
});

// ---- opening and closing -----------------------------------------------------------------------------------------------------------

describe('opening and closing the drawer', () => {
  const open = (r) => {
    r.api.wireSetup();
    r.api.renderProject(true);
    r.setupBtn().focus();
    r.press(r.setupBtn());
  };

  test('(+) Setup opens the drawer as a modal with the three cards, and focus moves into it (its heading)', () => {
    const r = rig({ narrow: true });
    open(r);
    assert.equal(r.drawer.open, true);
    assert.deepEqual(r.titles(r.body), CARDS);
    assert.equal(focus.el, r.q('su-h'));
  });

  test('(+) it opens at the top, even if the body was scrolled last time; (−) a render while it is open leaves the scroll position alone', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.body.scrollTop = 240; // left over from the last opening
    r.press(r.setupBtn());
    assert.equal(r.body.scrollTop, 0);
    r.body.scrollTop = 80;
    r.api.renderProject(true);
    assert.equal(r.body.scrollTop, 80);
  });

  test('(−) the page column then holds no card', () => {
    const r = rig({ narrow: true });
    open(r);
    assert.equal(r.titles(r.column).length, 0);
  });

  test('(+) the × button closes it and focus returns to the Setup button', () => {
    const r = rig({ narrow: true });
    open(r);
    r.press(r.x);
    assert.equal(r.drawer.open, false);
    assert.equal(focus.el, r.setupBtn());
  });

  test('(+) Esc closes it and focus returns to the Setup button', () => {
    const r = rig({ narrow: true });
    open(r);
    r.esc(r.drawer);
    assert.equal(r.drawer.open, false);
    assert.equal(focus.el, r.setupBtn());
  });

  test('(+) a click on the backdrop (the dialog itself, pressed and released there) closes it and focus returns to the Setup button', () => {
    const r = rig({ narrow: true });
    open(r);
    r.drawer.fire('pointerdown', { target: r.drawer });
    r.drawer.fire('click', { target: r.drawer });
    assert.equal(r.drawer.open, false);
    assert.equal(focus.el, r.setupBtn());
  });

  test('(−) a click inside the drawer does not close it', () => {
    const r = rig({ narrow: true });
    open(r);
    const card = r.body.kids[0];
    r.drawer.fire('pointerdown', { target: card });
    r.drawer.fire('click', { target: card });
    assert.equal(r.drawer.open, true);
  });

  test('(−) a press that starts inside and is released on the backdrop (a text selection dragged out) does not close it', () => {
    const r = rig({ narrow: true });
    open(r);
    r.drawer.fire('pointerdown', { target: r.body.kids[0] });
    r.drawer.fire('click', { target: r.drawer }); // the browser reports the common ancestor
    assert.equal(r.drawer.open, true);
    r.drawer.fire('pointerdown', { target: r.drawer }); // and a later real backdrop click still works
    r.drawer.fire('click', { target: r.drawer });
    assert.equal(r.drawer.open, false);
  });

  test('(+) Esc with a value menu open closes the menu first (the drawer stays), focus is on the menu button; the next Esc closes the drawer', () => {
    const r = rig({ narrow: true });
    open(r);
    const trigger = r.body.byFk('agent-panePlacement');
    r.press(trigger);
    const menu = trigger.nextElementSibling;
    assert.equal(menu.hidden, false, 'the menu is open inside the drawer');
    r.esc(r.drawer);
    assert.equal(menu.hidden, true);
    assert.equal(trigger.attrs['aria-expanded'], 'false');
    assert.equal(r.drawer.open, true, 'Esc was used up by the menu');
    assert.equal(focus.el, trigger);
    r.esc(r.drawer);
    assert.equal(r.drawer.open, false);
    assert.equal(focus.el, r.setupBtn());
  });

  test('(+) the Esc key itself (keydown inside the drawer) closes an open menu and is prevented, so no close request starts; a "cancel" that still follows in the same tick is vetoed', async () => {
    const r = rig({ narrow: true });
    open(r);
    const trigger = r.body.byFk('agent-maxAgents');
    r.press(trigger);
    const menu = trigger.nextElementSibling;
    const item = menu.all((n) => n.tag === 'button')[0];
    const e = r.drawer.fire('keydown', { key: 'Escape', target: item });
    assert.equal(e.defaultPrevented, true);
    assert.equal(menu.hidden, true);
    assert.equal(focus.el, trigger);
    assert.equal(r.drawer.fire('cancel').defaultPrevented, true, 'a web view that sends cancel after a prevented keydown');
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(r.drawer.fire('cancel').defaultPrevented, false, 'the next Esc is the drawer\'s own');
  });

  test('(−) other keys and an Esc keydown with no menu open are left alone', () => {
    const r = rig({ narrow: true });
    open(r);
    assert.equal(r.drawer.fire('keydown', { key: 'Escape', target: r.body }).defaultPrevented, false);
    const trigger = r.body.byFk('agent-maxAgents');
    r.press(trigger);
    const menu = trigger.nextElementSibling;
    assert.equal(r.drawer.fire('keydown', { key: 'ArrowDown', target: menu }).defaultPrevented, false);
    assert.equal(menu.hidden, false, 'only Esc closes it');
  });

  test('(−) Esc with no menu open is not vetoed: the drawer closes at once', () => {
    const r = rig({ narrow: true });
    open(r);
    const e = r.drawer.fire('cancel');
    assert.equal(e.defaultPrevented, false);
  });

  test('(−) a menu elsewhere on the page does not keep the drawer open on Esc', () => {
    const r = rig({ narrow: true });
    open(r);
    const outside = h('ul', { class: 'menu' }); // e.g. a row menu left open behind the modal
    r.q('proj-agents').append(outside);
    r.esc(r.drawer);
    assert.equal(r.drawer.open, false);
  });

  test('(+) focus goes back to the Setup button even when a render replaced it while the drawer was open', () => {
    const r = rig({ narrow: true });
    open(r);
    const old = r.setupBtn();
    r.api.renderProject(true);
    assert.notEqual(r.setupBtn(), old, 'the header was rebuilt');
    r.esc(r.drawer);
    assert.equal(focus.el, r.setupBtn(), 'found again by its data-fk');
  });

  test('(+) following the Settings link inside the drawer (a hash change) closes it', () => {
    const r = rig({ narrow: true });
    open(r);
    assert.equal(r.winL.hashchange?.length, 1, 'wireSetup listens for hashchange');
    r.winL.hashchange[0]();
    assert.equal(r.drawer.open, false);
  });

  test('(−) a hash change with the drawer closed does nothing', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    const before = focus.el;
    r.winL.hashchange[0]();
    assert.equal(r.drawer.open, false);
    assert.equal(focus.el, before);
  });
});

// ---- menus inside the drawer ---------------------------------------------------------------------------------------------------------

describe('a value menu inside the drawer is not clipped by the drawer\'s scrolling', () => {
  const LIST = 263; // seven items of the permission menu, as measured in Chrome
  /** The body of the drawer starts at y = 76; the trigger sits at `top`; the window is `h` high. */
  const openAt = (h, top) => {
    const r = rig({ narrow: true });
    globalThis.window.innerHeight = h;
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    r.body.rect = { top: 76, bottom: h, left: 0, right: 480, width: 480, height: h - 76 };
    const trigger = r.body.byFk('agent-permissionMode');
    trigger.rect = { top, bottom: top + 28, left: 0, right: 100, width: 100, height: 28 };
    const menu = trigger.nextElementSibling;
    menu.offsetHeight = LIST;
    r.press(trigger);
    return { r, trigger, menu };
  };

  test('(+) near the bottom with room above inside the body: the list flips above the button, as before', () => {
    const { menu } = openAt(480, 400);
    assert.equal(menu.hidden, false);
    assert.equal(menu.dataset.up, '1');
  });

  test('(+) too low to fit below and too high to fit above inside the body: it stays below and the body scrolls to show all of it', () => {
    const { menu } = openAt(480, 250);
    assert.equal(menu.hidden, false);
    assert.equal(menu.dataset.up, undefined, 'above it would be cut off by the top of the scrolling body');
    assert.deepEqual(menu.scrolled, { block: 'nearest' });
  });

  test('(−) with room below it opens below and is left where it is (nothing flips, nothing is asked to scroll beyond "nearest")', () => {
    const { menu } = openAt(900, 150);
    assert.equal(menu.dataset.up, undefined);
    assert.deepEqual(menu.scrolled, { block: 'nearest' }, 'a no-op in a browser when the list is already visible');
  });

  test('(−) outside a dialog the top bound is the window: a list with room above flips as it always did', () => {
    const r = rig({ narrow: false });
    globalThis.window.innerHeight = 400;
    r.api.renderProject(true);
    const trigger = r.column.byFk('agent-permissionMode');
    trigger.rect = { top: 300, bottom: 328, left: 0, right: 100, width: 100, height: 28 };
    const menu = trigger.nextElementSibling;
    menu.offsetHeight = LIST;
    r.press(trigger);
    assert.equal(menu.dataset.up, '1');
  });

  test('(+) the menu is a child of its button\'s wrapper inside the drawer body, so the body is the box that scrolls (no portal, no fixed position)', () => {
    const { trigger, menu } = openAt(700, 100);
    assert.equal(menu.parent, trigger.parent);
    assert.ok(trigger.closest('.dlg-body'));
    assert.match(decl(CSS, '.menu') ?? '', /position:\s*absolute/);
  });
});

// ---- a render while the drawer is open or closed -----------------------------------------------------------------------------------

describe('a re-render', () => {
  test('(+) while the drawer is open: it stays open, the cards are rebuilt inside it, and focus stays on the control that survives', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    const trigger = r.body.byFk('agent-permissionMode');
    trigger.focus();
    r.state.settings.perProject = { [KEY]: { panePlacement: 'under-last' } }; // what a save changes
    r.api.renderProject(true);
    assert.equal(r.drawer.open, true);
    assert.deepEqual(r.titles(r.body), CARDS);
    assert.equal(r.column.kids.length, 0);
    const again = r.body.byFk('agent-permissionMode');
    assert.notEqual(again, trigger, 'rebuilt');
    assert.equal(focus.el, again, 'focus kept by data-fk');
    assert.match(r.body.byFk('agent-panePlacement').textContent, /Under the last agent/, 'and it shows the new value');
  });

  test('(−) while it is closed and the window is narrow: the cards are in the drawer (not visible), never in the column', () => {
    const r = rig({ narrow: true });
    r.api.renderProject(true);
    r.api.renderProject(true);
    assert.equal(r.drawer.open, false);
    assert.deepEqual(r.titles(r.body), CARDS);
    assert.equal(r.column.kids.length, 0);
  });

  test('(−) wide: a re-render puts them in the column', () => {
    const r = rig({ narrow: false });
    r.api.renderProject(true);
    r.api.renderProject(true);
    assert.deepEqual(r.titles(r.column), CARDS);
    assert.equal(r.body.kids.length, 0);
  });

  test('(+) a value picked from a menu inside the drawer saves, and the drawer shows the new value without closing', async () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    const trigger = r.body.byFk('agent-panePlacement');
    const item = r.body.byFk('agent-panePlacement:under-last');
    assert.ok(item, 'the menu lives in the drawer');
    trigger.focus();
    item.click();
    await settle();
    assert.deepEqual(r.calls.filter((c) => c.startsWith('PUT')), [`PUT ${CFG_URL}`]);
    assert.equal(r.drawer.open, true);
    assert.deepEqual(r.renders, [true], 'the save asks the page to render again');
  });
});

// ---- the window crosses 1030 px ------------------------------------------------------------------------------------------------------

describe('the window width changes', () => {
  test('(+) growing past 1030 px with the drawer open closes it, puts the cards back in the column and focuses the project heading', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    assert.equal(r.mq.listeners.length, 1, 'one change listener');
    r.narrower(false);
    assert.equal(r.drawer.open, false);
    assert.deepEqual(r.titles(r.column), CARDS);
    assert.equal(r.body.kids.length, 0);
    assert.equal(focus.el, r.q('proj-h'), 'the Setup button is hidden now: the heading takes the focus');
  });

  test('(+) shrinking below it moves the cards from the column into the drawer', () => {
    const r = rig({ narrow: false });
    r.api.wireSetup();
    r.api.renderProject(true);
    assert.deepEqual(r.titles(r.column), CARDS);
    r.narrower(true);
    assert.deepEqual(r.titles(r.body), CARDS);
    assert.equal(r.column.kids.length, 0);
    assert.equal(r.drawer.open, false);
  });

  test('(−) growing with the drawer closed does not steal the focus', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    const before = focus.el;
    r.narrower(false);
    assert.equal(focus.el, before);
    assert.deepEqual(r.titles(r.column), CARDS);
  });

  test('(−) on another screen the change only moves nothing: the project page is drawn when you get there', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.state.route = { name: 'dashboard' };
    r.narrower(false);
    assert.deepEqual(r.titles(r.body), CARDS, 'untouched until the project page renders again');
  });

  test('(−) without matchMedia nothing throws and nothing is listened to', () => {
    const r = rig({ matchMedia: false });
    assert.doesNotThrow(() => r.api.wireSetup());
    assert.equal(r.mq.listeners.length, 0);
    r.api.renderProject(true);
    assert.deepEqual(r.titles(r.column), CARDS);
  });

  test('(−) a matchMedia without addEventListener (an old web view) does not throw either', () => {
    const r = rig();
    r.window.matchMedia = () => ({ matches: false });
    assert.doesNotThrow(() => r.api.wireSetup());
  });
});

// ---- dialogs opened from inside the drawer ------------------------------------------------------------------------------------------

describe('dialogs opened from the cards in the drawer stack on top of it', () => {
  const CASES = [['rules-open', 'rules'], ['choose-plugins', 'plugins'], ['choose-models', 'models']];

  for (const [fk, name] of CASES) {
    test(`(+) ${fk}: its dialog opens on top, the drawer stays open, and closing it returns focus to that button`, async () => {
      const r = rig({ narrow: true });
      r.api.wireSetup();
      r.api.renderProject(true);
      r.press(r.setupBtn());
      const btn = r.body.byFk(fk);
      assert.ok(btn, `${fk} is in the drawer`);
      r.press(btn);
      await settle();
      assert.equal(r.dlg[name].open, true, `${name} dialog is open`);
      assert.equal(r.drawer.open, true, 'the drawer is still open under it');
      r.esc(r.dlg[name]);
      assert.equal(r.dlg[name].open, false);
      assert.equal(r.drawer.open, true, 'Esc closed only the top dialog');
      assert.equal(focus.el, btn, 'focus is back on the opener inside the drawer');
    });
  }

  test('(+) the opener was rebuilt by a render while its dialog was open: focus goes to the new button with the same data-fk', async () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    const btn = r.body.byFk('choose-plugins');
    r.press(btn);
    await settle();
    r.api.renderProject(true);
    const fresh = r.body.byFk('choose-plugins');
    assert.notEqual(fresh, btn);
    r.esc(r.dlg.plugins);
    assert.equal(focus.el, fresh);
  });

  test('(+) wide, with no drawer: the same buttons open the same dialogs and focus returns to the button in the column', async () => {
    const r = rig({ narrow: false });
    r.api.renderProject(true);
    const btn = r.column.byFk('choose-plugins');
    btn.focus();
    r.press(btn);
    await settle();
    assert.equal(r.dlg.plugins.open, true);
    r.esc(r.dlg.plugins);
    assert.equal(focus.el, btn);
  });

  test('(−) any other dialog pair still closes the previous dialog, as today', () => {
    page = buildPage();
    ui.initDialogs();
    const { dlg } = page;
    const a = new PEl('button');
    page.body.append(a);
    a.focus();
    ui.openDialog(dlg.rules);
    ui.openDialog(dlg.models); // no keep: the first one closes
    assert.equal(dlg.rules.open, false);
    assert.equal(dlg.models.open, true);
    dlg.models.close();
  });

  test('(−) a dialog opened without asking to keep the drawer closes it, even from a button inside it', () => {
    const r = rig({ narrow: true });
    r.api.wireSetup();
    r.api.renderProject(true);
    r.press(r.setupBtn());
    r.body.byFk('choose-plugins').focus();
    ui.openDialog(r.dlg.spawn);
    assert.equal(r.drawer.open, false);
    assert.equal(r.dlg.spawn.open, true);
  });

  test('(−) closing a dialog while another unrelated one is open still leaves the focus alone (restoreFocus is unchanged for them)', () => {
    page = buildPage();
    ui.initDialogs();
    const { dlg } = page;
    const a = new PEl('button');
    page.body.append(a);
    a.focus();
    ui.openDialog(dlg.rules);
    const b = new PEl('button');
    page.body.append(b);
    b.focus();
    ui.openDialog(dlg.confirm, { keep: dlg.rules }); // rules stays open under confirm...
    focus.el = null;
    dlg.rules.close(); // ...and when it goes first, confirm's restore must wait for confirm itself
    assert.equal(focus.el, null);
    dlg.confirm.close();
    assert.equal(focus.el, b);
  });

  test('(+) the drawer marks the dialogs that may stack on it in the source: project.js passes keep, ui.js skips only that one', () => {
    const uiSrc = code(read('ui.js'));
    assert.match(uiSrc, /export function openDialog\(dlg, \{ focus, keep \} = \{\}\)/);
    assert.match(uiSrc, /if \(d !== dlg && d !== keep\) d\.close\(\)/);
    assert.match(PROJECT_SRC, /const overSetup = \(\) => \(\{ keep: \$\('#dlg-setup'\) \}\)/);
    for (const opener of ['openRules', 'openPlugins', 'openModels', 'confirmRemove']) {
      const src = PROJECT_SRC.slice(PROJECT_SRC.indexOf(`function ${opener}(`));
      assert.match(src.slice(0, src.indexOf('\n}\n')), /openDialog\([^;]*\boverSetup\(\)/, opener);
    }
  });
});
