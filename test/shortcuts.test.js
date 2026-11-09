// public/shortcuts.js: the Keyboard shortcuts window and the key rules around it (docs/design/spec.md 3.13 and 4.6). The pure parts
// run in Node; openShortcuts runs on a tiny fake page, so the test also proves that every cell is built as text. Fixtures are static
// copy from the spec, nothing from a real session.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORTCUTS, shortcutsFor, isMac, isTextEntry, wantsHelp, wantsBack, backHint, helpHint, passKeyLabel, hintTips, openShortcuts } from '../public/shortcuts.js';
import { initDialogs, initMenus, openDialog } from '../public/ui.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'shortcuts.js'), 'utf8');

// Key glyphs are literal characters in this file; only public/shortcuts.js has to stay plain ASCII (it writes them as escapes).
const CMD = '⌘';
const SHIFT = '⇧';
const CTRL = '⌃';
const LEFT = '←';
const RIGHT = '→';
const UP = '↑';
const DOWN = '↓';

/** What a Shortcut cell reads as: keys joined by "+", alternatives joined by the row's separator. */
const cell = (row) => row.keys.map((combo) => combo.join('+')).join(row.alt);
const table = (groups) => groups.map((g) => [g.group, g.rows.map((r) => [r.name, cell(r), r.description])]);

// ---- fake page (just what dom.js h() and openShortcuts touch) ----------------------------------------------------------

const page = { active: null, ids: {}, h1: null, location: null, dialogs: [], menus: [], docListeners: {}, focusLog: [] };

class FNode {
  constructor(tag, text = '') {
    this.tag = tag; this.text = text; this.kids = []; this.attrs = {}; this.className = ''; this.listeners = {};
    this.isConnected = true; this.open = false; this.shown = 0; this.id = ''; this.hidden = false; this.previousElementSibling = null;
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return this.attrs[k] ?? null; }

  hasAttribute(k) { return k in this.attrs; }

  removeAttribute(k) { delete this.attrs[k]; }

  contains(n) { return this === n || this.kids.some((k) => k.contains(n)); }

  /** Only what ui.js asks: the disclosure menu around this node (the fake keeps no parent pointers; page.menus lists the menus). */
  closest(sel) { return sel === '.menu' ? (page.menus?.find((m) => m.contains(this)) ?? null) : null; }

  append(...nodes) { this.kids.push(...nodes); }

  replaceChildren(...nodes) { this.kids = nodes; }

  addEventListener(type, fn, opts) { (this.listeners[type] ??= []).push({ fn, once: Boolean(opts?.once) }); }

  fire(type) {
    const list = this.listeners[type] ?? [];
    this.listeners[type] = list.filter((l) => !l.once);
    for (const l of list) l.fn({ type });
  }

  focus() { page.active = this; page.focusLog.push(this); }

  showModal() {
    if (this.open) throw new Error('already open');
    this.open = true;
    this.shown += 1;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.fire('close');
  }

  set textContent(v) { this.kids = []; this.text = String(v); }

  get textContent() { return this.text + this.kids.map((k) => k.textContent).join(''); }

  find(pred) {
    const out = [];
    const walk = (n) => { if (pred(n)) out.push(n); n.kids.forEach(walk); };
    walk(this);
    return out;
  }
}

const tagged = (root, tag) => root.find((n) => n.tag === tag);
const button = (root, label) => root.find((n) => n.tag === 'button' && n.textContent === label)[0];

let saved;
before(() => {
  saved = { document: globalThis.document, Node: globalThis.Node, location: globalThis.location };
  globalThis.Node = FNode;
  globalThis.document = {
    createElement: (tag) => new FNode(tag),
    createTextNode: (t) => new FNode('#text', t),
    getElementById: (id) => page.ids[id] ?? null,
    get activeElement() { return page.active; },
    addEventListener: (type, fn) => { (page.docListeners[type] ??= []).push(fn); },
    // the selectors ui.js and shortcuts.js ask for; the screen heading answers both heading lookups
    querySelector: (sel) => {
      if (sel === 'h1' || sel === '.screen:not([hidden]) h1') return page.h1;
      if (sel === 'dialog[open]') return page.dialogs.find((d) => d.open) ?? null;
      if (sel === '.menu:not([hidden])') return page.menus.find((m) => !m.hidden) ?? null;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'dialog') return [...page.dialogs];
      if (sel === 'dialog[open]') return page.dialogs.filter((d) => d.open);
      if (sel === '.menu:not([hidden])') return page.menus.filter((m) => !m.hidden);
      return [];
    },
  };
});
after(() => {
  globalThis.document = saved.document;
  globalThis.Node = saved.Node;
  if (saved.location === undefined) delete globalThis.location;
  else globalThis.location = saved.location;
});

/** A fresh dialog skeleton like the one in index.html and session.html. */
function freshPage() {
  page.active = null;
  page.ids = {};
  page.menus = [];
  page.docListeners = {};
  page.focusLog = [];
  for (const id of ['kbd-dlg', 'kbd-h', 'kbd-sub', 'kbd-body', 'kbd-foot']) {
    page.ids[id] = new FNode(id === 'kbd-dlg' ? 'dialog' : id === 'kbd-h' ? 'h2' : 'div');
    page.ids[id].id = id;
  }
  page.ids['kbd-dlg'].setAttribute('data-own-focus', ''); // as in the markup: openShortcuts returns the focus itself
  page.dialogs = [page.ids['kbd-dlg']];
  page.h1 = new FNode('h1');
  page.location = { hash: '', assigned: [], assign(u) { this.assigned.push(u); } };
  globalThis.location = page.location;
  return page.ids;
}

// ---- shortcutsFor: the spec 4.6 tables as data ---------------------------------------------------------------------------

describe('shortcutsFor: the dashboard, app tier', () => {
  const NAV = [
    ['Dashboard', 'Ctrl+1', 'Show all projects and agents'],
    ['Settings', 'Ctrl+,', 'Open Settings'],
    ['Add project', 'Ctrl+O', 'Choose a folder to add as a project'],
    ['Filter agents', 'Ctrl+F', 'Move to the agent filter (dashboard)'],
    ['Back', `Alt+${LEFT}`, 'Go back to the dashboard (project view, Settings)'],
    ['Keyboard shortcuts', '? or Ctrl+/', 'Show this list'],
  ];
  const DIALOGS = [
    ['Run the main action', 'Ctrl+Enter', 'Spawn, save or apply in the open dialog or in Settings'],
    ['Close', 'Esc', 'Close the open menu or dialog'],
  ];

  test('(+) lists the spec rows in order, in two groups (Linux labels)', () => {
    assert.deepEqual(table(shortcutsFor({ window: 'dashboard', tier: 'app', mac: false })), [['Navigation', NAV], ['Dialogs and menus', DIALOGS]]);
  });

  test('(+) macOS labels use the command glyph, and Back is the command glyph plus [', () => {
    const rows = shortcutsFor({ window: 'dashboard', tier: 'app', mac: true }).flatMap((g) => g.rows);
    const by = Object.fromEntries(rows.map((r) => [r.name, cell(r)]));
    assert.equal(by.Dashboard, `${CMD}+1`);
    assert.equal(by.Settings, `${CMD}+,`);
    assert.equal(by['Add project'], `${CMD}+O`);
    assert.equal(by.Back, `${CMD}+[`);
    assert.equal(by['Keyboard shortcuts'], `? or ${CMD}+/`);
    assert.equal(by['Run the main action'], `${CMD}+Enter`);
    assert.equal(by.Close, 'Esc');
  });

  test('(+) other platforms use Ctrl and Alt plus the left arrow, never the macOS glyphs', () => {
    const text = JSON.stringify(shortcutsFor({ window: 'dashboard', tier: 'app', mac: false }));
    assert.match(text, /Ctrl/);
    assert.match(text, new RegExp(`Alt.*${LEFT}`));
    for (const glyph of [CMD, SHIFT, CTRL]) assert.equal(text.includes(glyph), false, glyph);
  });

  test('(−) no label says "Mod": it is resolved to the platform key', () => {
    for (const mac of [true, false]) for (const win of ['dashboard', 'session']) {
      assert.doesNotMatch(JSON.stringify(shortcutsFor({ window: win, tier: 'app', mac })), /\bMod\b/);
    }
  });
});

describe('shortcutsFor: the dashboard, browser tier', () => {
  test('(+) lists only Keyboard shortcuts (Mod+/) and Close', () => {
    assert.deepEqual(table(shortcutsFor({ window: 'dashboard', tier: 'browser', mac: false })), [
      ['Navigation', [['Keyboard shortcuts', 'Ctrl+/', 'Show this list']]],
      ['Dialogs and menus', [['Close', 'Esc', 'Close the open menu']]],
    ]);
    const mac = shortcutsFor({ window: 'dashboard', tier: 'browser', mac: true }).flatMap((g) => g.rows);
    assert.equal(cell(mac[0]), `${CMD}+/`);
  });

  test('(−) the question mark is app-tier only: the browser tier cannot store the setting that turns it off', () => {
    const rows = shortcutsFor({ window: 'dashboard', tier: 'browser', mac: false }).flatMap((g) => g.rows);
    assert.equal(rows.length, 2);
    assert.doesNotMatch(JSON.stringify(rows), /\?/);
  });
});

describe('shortcutsFor: the session window', () => {
  const EXPECT = [
    ['Window', [
      ['Back', `Alt+${LEFT}`, 'Back to the dashboard'],
      ['Keyboard shortcuts', '? or Ctrl+/', 'Show this list'],
    ]],
    ['Message box', [
      ['Send', 'Enter', 'Send the text, then Enter, to Claude (empty box: Enter only)'],
      ['New line', 'Shift+Enter', 'Start a new line in the message box'],
      ['Press Esc in Claude', 'Esc', "Stop Claude's turn or close Claude's menu (when nothing in nika is open)"],
      ['Interrupt', 'Ctrl+C', "Stop Claude's turn, as Stop does (while Claude works and no text is selected)"],
      ['Next permission mode', 'Shift+Tab', 'Press Shift-Tab in Claude (not before the pane is read, nor while Claude asks you something)'],
      ['Arrow keys in Claude', `${UP} ${DOWN} ${LEFT} ${RIGHT}`, "In an empty box: move through Claude's menus and earlier prompts"],
      ['Move focus back', 'Ctrl+Shift+Tab', 'Leave the message box backward (Shift+Tab goes to Claude)'],
      ['Commands', '/', 'Open the command list (at the start of an empty box)'],
      ['Type into the pane', 'Ctrl+]', "Send every key straight to Claude's terminal"],
    ]],
    ['Typing into the pane', [['Stop typing into the pane', 'Ctrl+]', 'Keys go to the message box again']]],
    ['Mode switcher', [
      ['Move between modes', `${LEFT} ${RIGHT} Home End`, 'Moves focus; does not switch'],
      ['Switch', 'Enter or Space', 'Switch to the focused mode'],
    ]],
    ['Command list', [
      ['Move', `${UP} ${DOWN}`, 'Move through the commands'],
      ['Insert', 'Enter or Tab', 'Put the command in the message box'],
      ['Close', 'Esc', 'Close the list and keep the text'],
    ]],
  ];

  test('(+) lists the spec rows in order, the palette rows included (Linux labels)', () => {
    assert.deepEqual(table(shortcutsFor({ window: 'session', tier: 'app', mac: false })), EXPECT);
  });

  test('(+) macOS shows its own glyphs for Back, Shift+Enter, Ctrl+C and Ctrl+]', () => {
    const by = Object.fromEntries(shortcutsFor({ window: 'session', tier: 'app', mac: true }).flatMap((g) => g.rows).map((r) => [`${r.name}`, cell(r)]));
    assert.equal(by.Back, `${CMD}+[`);
    assert.equal(by['New line'], `${SHIFT}+Enter`);
    assert.equal(by.Interrupt, `${CTRL}+C`);
    assert.equal(by['Next permission mode'], `${SHIFT}+Tab`);
    assert.equal(by['Move focus back'], `${CTRL}+${SHIFT}+Tab`);
    assert.equal(by['Arrow keys in Claude'], `${UP} ${DOWN} ${LEFT} ${RIGHT}`);
    assert.equal(by['Type into the pane'], `${CTRL}+]`);
    assert.equal(by['Keyboard shortcuts'], `? or ${CMD}+/`);
  });

  test('(−) the window is app-tier only: the browser tier gets no session rows', () => {
    assert.deepEqual(shortcutsFor({ window: 'session', tier: 'browser', mac: false }), []);
  });
});

describe('shortcutsFor: filtering and shape', () => {
  test('(−) an unknown window or tier is an empty list, never a throw', () => {
    assert.deepEqual(shortcutsFor({ window: 'nope', tier: 'app', mac: false }), []);
    assert.deepEqual(shortcutsFor({ window: 'dashboard', tier: 'nope', mac: false }), []);
    assert.deepEqual(shortcutsFor({}), []);
  });

  test('(+) a "both" row shows in the app and the browser tier; groups keep first-seen order; the list is a parameter', () => {
    const mk = (tier, group, name) => ({ window: 'dashboard', tier, group, name, keys: { mac: [['a']], other: [['b']] }, description: 'd', alt: ' or ' });
    const list = [mk('both', 'One', 'x'), mk('app', 'Two', 'y'), mk('browser', 'One', 'z')];
    assert.deepEqual(table(shortcutsFor({ window: 'dashboard', tier: 'app', mac: false }, list)).map(([g, rows]) => [g, rows.map((r) => r[0])]), [['One', ['x']], ['Two', ['y']]]);
    assert.deepEqual(table(shortcutsFor({ window: 'dashboard', tier: 'browser', mac: true }, list)).map(([g, rows]) => [g, rows.map((r) => r[0])]), [['One', ['x', 'z']]]);
  });

  test('(+) every row is complete data: both platforms, at least one key, a description', () => {
    assert.equal(SHORTCUTS.length, 27, '10 dashboard rows (8 app, 2 browser) and 17 session rows');
    for (const r of SHORTCUTS) {
      assert.ok(['dashboard', 'session'].includes(r.window), r.name);
      assert.ok(['app', 'browser', 'both'].includes(r.tier), r.name);
      for (const p of ['mac', 'other']) {
        assert.ok(r.keys[p].length > 0 && r.keys[p].every((c) => c.length > 0 && c.every((k) => typeof k === 'string' && k)), `${r.name} ${p}`);
      }
      assert.ok(r.group && r.name && r.description, r.name);
    }
  });
});

// ---- platform and key rules ----------------------------------------------------------------------------------------------

describe('isMac', () => {
  test('(+) macOS from navigator.platform, and from userAgentData.platform first', () => {
    assert.equal(isMac({ platform: 'MacIntel' }), true);
    assert.equal(isMac({ userAgentData: { platform: 'macOS' }, platform: 'Linux x86_64' }), true);
  });

  test('(−) Linux, userAgentData saying Linux, and a missing navigator are not macOS', () => {
    assert.equal(isMac({ platform: 'Linux x86_64' }), false);
    assert.equal(isMac({ userAgentData: { platform: 'Linux' }, platform: 'MacIntel' }), false);
    assert.equal(isMac({}), false);
    assert.equal(isMac(undefined), false);
  });
});

const ev = (key, more = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more });
const CTX = { mac: false, singleKey: true, textEntry: false, passthrough: false, dialogOpen: false };

describe('wantsHelp', () => {
  test('(+) "?" with no modifiers outside text entry opens it; Shift is how "?" is typed, so it is allowed', () => {
    assert.equal(wantsHelp(ev('?'), CTX), true);
    assert.equal(wantsHelp(ev('?', { shiftKey: true }), CTX), true);
    assert.equal(wantsHelp(ev('?'), { ...CTX, mac: true }), true);
  });

  test('(+) Mod+/ opens it: Ctrl on Linux, Command on macOS, with or without Shift', () => {
    assert.equal(wantsHelp(ev('/', { ctrlKey: true }), CTX), true);
    assert.equal(wantsHelp(ev('/', { ctrlKey: true, shiftKey: true }), CTX), true);
    assert.equal(wantsHelp(ev('/', { metaKey: true }), { ...CTX, mac: true }), true);
  });

  test('(+) Mod+/ works in text entry and with the single-key setting off ("?" does not)', () => {
    assert.equal(wantsHelp(ev('/', { ctrlKey: true }), { ...CTX, textEntry: true }), true);
    assert.equal(wantsHelp(ev('/', { ctrlKey: true }), { ...CTX, singleKey: false }), true);
    assert.equal(wantsHelp(ev('?'), { ...CTX, singleKey: false }), false);
  });

  test('(+) Command+/ stays an app shortcut in passthrough on macOS', () => {
    assert.equal(wantsHelp(ev('/', { metaKey: true }), { ...CTX, mac: true, passthrough: true }), true);
  });

  test('(−) "?" is ignored in text entry (input, textarea, select, contenteditable and the mirror), in passthrough, with a dialog open, with the setting off', () => {
    for (const over of [{ textEntry: true }, { passthrough: true }, { dialogOpen: true }, { singleKey: false }]) {
      assert.equal(wantsHelp(ev('?'), { ...CTX, ...over }), false, JSON.stringify(over));
    }
  });

  test('(−) Ctrl+/ in passthrough on Linux is false: Ctrl+] is the only key nika keeps there', () => {
    assert.equal(wantsHelp(ev('/', { ctrlKey: true }), { ...CTX, passthrough: true }), false);
  });

  test('(−) with any dialog open (the shortcuts window included) neither key does anything', () => {
    assert.equal(wantsHelp(ev('?'), { ...CTX, dialogOpen: true }), false);
    assert.equal(wantsHelp(ev('/', { ctrlKey: true }), { ...CTX, dialogOpen: true }), false);
    assert.equal(wantsHelp(ev('/', { metaKey: true }), { ...CTX, mac: true, dialogOpen: true }), false);
  });

  test('(−) Alt+?, Ctrl+? and Command+? are not the shortcut', () => {
    for (const mod of ['altKey', 'ctrlKey', 'metaKey']) assert.equal(wantsHelp(ev('?', { [mod]: true }), CTX), false, mod);
    assert.equal(wantsHelp(ev('?', { metaKey: true }), { ...CTX, mac: true }), false);
  });

  test('(−) the wrong Mod for the platform, Alt on top of Mod, and the bare slash are not the shortcut', () => {
    assert.equal(wantsHelp(ev('/', { metaKey: true }), CTX), false, 'Command on Linux');
    assert.equal(wantsHelp(ev('/', { ctrlKey: true }), { ...CTX, mac: true }), false, 'Ctrl on macOS');
    assert.equal(wantsHelp(ev('/', { ctrlKey: true, altKey: true }), CTX), false);
    assert.equal(wantsHelp(ev('/', { ctrlKey: true, metaKey: true }), CTX), false);
    assert.equal(wantsHelp(ev('/'), CTX), false);
    assert.equal(wantsHelp(ev('a'), CTX), false);
    assert.equal(wantsHelp(ev('Enter', { ctrlKey: true }), CTX), false);
  });
});

describe('wantsBack', () => {
  const B = { mac: false, passthrough: false, dialogOpen: false };

  test('(+) Command+[ on macOS, Alt+Left on Linux', () => {
    assert.equal(wantsBack(ev('[', { metaKey: true }), { ...B, mac: true }), true);
    assert.equal(wantsBack(ev('ArrowLeft', { altKey: true }), B), true);
  });

  test('(−) the other platform\'s key, extra modifiers and other keys are not Back', () => {
    assert.equal(wantsBack(ev('ArrowLeft', { altKey: true }), { ...B, mac: true }), false);
    assert.equal(wantsBack(ev('[', { metaKey: true }), B), false);
    assert.equal(wantsBack(ev('ArrowLeft', { altKey: true, shiftKey: true }), B), false);
    assert.equal(wantsBack(ev('ArrowLeft', { altKey: true, ctrlKey: true }), B), false);
    assert.equal(wantsBack(ev('ArrowLeft'), B), false);
    assert.equal(wantsBack(ev('[', { metaKey: true, shiftKey: true }), { ...B, mac: true }), false);
  });

  test('(−) ignored in passthrough and while a dialog is open', () => {
    assert.equal(wantsBack(ev('ArrowLeft', { altKey: true }), { ...B, passthrough: true }), false);
    assert.equal(wantsBack(ev('[', { metaKey: true }), { mac: true, passthrough: true, dialogOpen: false }), false);
    assert.equal(wantsBack(ev('ArrowLeft', { altKey: true }), { ...B, dialogOpen: true }), false);
  });
});

describe('isTextEntry', () => {
  const el = (tag, more = {}) => ({ tagName: tag, isContentEditable: false, closest: () => null, ...more });

  test('(+) input, textarea, select, contenteditable and the terminal mirror count', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(isTextEntry(el(tag)), true, tag);
    assert.equal(isTextEntry(el('DIV', { isContentEditable: true })), true);
    assert.equal(isTextEntry(el('DIV', { closest: (s) => (s === '#term' ? {} : null) })), true, 'the mirror, or something inside it');
  });

  test('(−) a button, a link, the body, nothing: not text entry', () => {
    for (const tag of ['BUTTON', 'A', 'BODY', 'H1']) assert.equal(isTextEntry(el(tag)), false, tag);
    assert.equal(isTextEntry(null), false);
    assert.equal(isTextEntry(undefined), false);
    assert.equal(isTextEntry({ tagName: 'DIV' }), false, 'an object without closest() does not throw');
  });
});

describe('button and link hints', () => {
  test('(+) the Back title and aria-keyshortcuts follow the platform (spec 3.13)', () => {
    assert.deepEqual(backHint({ label: 'Dashboard', mac: true }), { title: `Back to Dashboard (${CMD}[)`, keys: 'Meta+BracketLeft' });
    assert.deepEqual(backHint({ label: 'demo-api', mac: false }), { title: `Back to demo-api (Alt+${LEFT})`, keys: 'Alt+ArrowLeft' });
  });

  test('(+) the Keyboard shortcuts button names "?" while the setting is on, and both keys in aria-keyshortcuts', () => {
    assert.deepEqual(helpHint({ mac: true, singleKey: true }), { title: 'Keyboard shortcuts (?)', keys: 'Shift+Slash Meta+Slash' });
    assert.deepEqual(helpHint({ mac: false, singleKey: true }), { title: 'Keyboard shortcuts (?)', keys: 'Shift+Slash Control+Slash' });
  });

  test('(−) with the setting off the title and keys name only Mod+/ (the question mark does nothing then)', () => {
    assert.deepEqual(helpHint({ mac: true, singleKey: false }), { title: `Keyboard shortcuts (${CMD}/)`, keys: 'Meta+Slash' });
    assert.deepEqual(helpHint({ mac: false, singleKey: false }), { title: 'Keyboard shortcuts (Ctrl+/)', keys: 'Control+Slash' });
  });
});

// ---- openShortcuts on the fake page --------------------------------------------------------------------------------------------

describe('passKeyLabel (page copy for the passthrough key)', () => {
  test('(+) a Mac shows the control glyph and "]"; the table row uses the same glyph', () => {
    assert.equal(passKeyLabel(true), '\u2303]');
    const row = shortcutsFor({ window: 'session', tier: 'app', mac: true, singleKey: true }).flatMap((g) => g.rows).find((r) => r.keys.some((c) => c.at(-1) === ']'));
    assert.ok(row, 'the passthrough row exists');
    assert.deepEqual(row.keys[0], ['\u2303', ']'], 'the same glyph, as separate key caps');
  });

  test('(−) everywhere else it reads "Ctrl+]" (never the glyph), and the label is plain ASCII there', () => {
    assert.equal(passKeyLabel(false), 'Ctrl+]');
    assert.equal(passKeyLabel(undefined), 'Ctrl+]');
    assert.match(passKeyLabel(false), /^[\x20-\x7e]+$/);
  });
});

describe('openShortcuts', () => {
  const open = (over = {}) => {
    const ids = freshPage();
    const opener = new FNode('button');
    openShortcuts({ window: 'dashboard', tier: 'app', mac: false, singleKey: true, opener, ...over });
    return { ids, opener, dlg: ids['kbd-dlg'], over };
  };

  test('(+) opens the modal, names the window, focuses the heading and builds one table per group', () => {
    const { ids, dlg } = open();
    assert.equal(dlg.open, true);
    assert.equal(ids['kbd-sub'].textContent, 'Dashboard');
    assert.equal(page.active, ids['kbd-h']);
    const sections = tagged(ids['kbd-body'], 'section');
    assert.deepEqual(sections.map((s) => tagged(s, 'h3')[0].textContent), ['Navigation', 'Dialogs and menus']);
    for (const s of sections) {
      const t = tagged(s, 'table')[0];
      assert.equal(tagged(t, 'caption')[0].textContent, tagged(s, 'h3')[0].textContent, 'the hidden caption is the group name');
      assert.match(tagged(t, 'caption')[0].className, /\bsr-only\b/);
      const heads = tagged(t, 'th');
      assert.deepEqual(heads.map((th) => th.textContent), ['Name', 'Shortcut', 'Description']);
      for (const th of heads) assert.equal(th.getAttribute('scope'), 'col');
    }
  });

  test('(+) every table sits in its own scroll wrapper: a focusable region named after the group (a 320 px window scrolls the table, not the page)', () => {
    const { ids } = open();
    for (const s of tagged(ids['kbd-body'], 'section')) {
      const group = tagged(s, 'h3')[0].textContent;
      const wrap = tagged(s, 'div').find((d) => /\btbl-wrap\b/.test(d.className) || d.getAttribute('class') === 'tbl-wrap');
      assert.ok(wrap, `${group}: wrapper exists`);
      assert.equal(wrap.getAttribute('role'), 'region');
      assert.equal(wrap.getAttribute('aria-label'), `${group}, shortcuts`);
      assert.equal(wrap.getAttribute('tabindex'), '0', 'keyboard users can scroll it');
      assert.equal(tagged(wrap, 'table').length, 1, 'the table is inside, and is the only one');
    }
  });

  test('(+) the session window is named in the muted line', () => {
    assert.equal(open({ window: 'session' }).ids['kbd-sub'].textContent, 'Session window');
  });

  test('(+) the Shortcut cell holds one kbd per key joined by "+", and alternatives joined by " or "', () => {
    const { ids } = open();
    const row = tagged(ids['kbd-body'], 'tr').find((tr) => tagged(tr, 'td')[0]?.textContent === 'Keyboard shortcuts');
    const shortcut = tagged(row, 'td')[1];
    assert.deepEqual(tagged(shortcut, 'kbd').map((k) => k.textContent), ['?', 'Ctrl', '/']);
    assert.equal(shortcut.textContent, '? or Ctrl+/');
    const back = tagged(ids['kbd-body'], 'tr').find((tr) => tagged(tr, 'td')[0]?.textContent === 'Back');
    assert.equal(tagged(back, 'td')[1].textContent, `Alt+${LEFT}`);
  });

  test('(+) macOS labels reach the page', () => {
    const { ids } = open({ mac: true });
    const row = tagged(ids['kbd-body'], 'tr').find((tr) => tagged(tr, 'td')[0]?.textContent === 'Dashboard');
    assert.equal(tagged(row, 'td')[1].textContent, `${CMD}+1`);
  });

  test('(+) app tier footer: the single-key state, Change in Settings, then Close', () => {
    const on = open();
    assert.deepEqual(on.ids['kbd-foot'].kids.filter((k) => k.tag === 'span' && k.className !== 'sp').map((k) => k.textContent), ['Single-key shortcuts: On']);
    assert.ok(button(on.ids['kbd-foot'], 'Change in Settings'));
    const labels = tagged(on.ids['kbd-foot'], 'button').map((b) => b.textContent);
    assert.deepEqual(labels, ['Change in Settings', 'Close']);
    assert.equal(open({ singleKey: false }).ids['kbd-foot'].textContent.includes('Single-key shortcuts: Off'), true);
  });

  test('(−) browser tier footer has only Close: nothing to change there', () => {
    const { ids } = open({ tier: 'browser' });
    assert.deepEqual(tagged(ids['kbd-foot'], 'button').map((b) => b.textContent), ['Close']);
    assert.doesNotMatch(ids['kbd-foot'].textContent, /Single-key|Settings/);
  });

  test('(+) Close closes the dialog and focus returns to the opener', () => {
    const { ids, opener, dlg } = open();
    button(ids['kbd-foot'], 'Close').fire('click');
    assert.equal(dlg.open, false);
    assert.equal(page.active, opener);
  });

  test('(+) Esc closes through the dialog\'s own close event and focus returns to the opener', () => {
    const { opener, dlg } = open();
    dlg.close(); // what the browser does after Esc fires cancel
    assert.equal(page.active, opener);
  });

  test('(−) when the opener is gone, focus goes to the screen heading, which becomes focusable', () => {
    const ids = freshPage();
    const opener = new FNode('button');
    openShortcuts({ window: 'dashboard', tier: 'app', mac: false, singleKey: true, opener });
    opener.isConnected = false;
    ids['kbd-dlg'].close();
    assert.equal(page.active, page.h1);
    assert.equal(page.h1.getAttribute('tabindex'), '-1');
  });

  test('(+) Change in Settings on the dashboard goes to #settings, closes, and leaves focus to the new screen', () => {
    const { ids, dlg, opener } = open();
    page.active = null;
    button(ids['kbd-foot'], 'Change in Settings').fire('click');
    assert.equal(dlg.open, false);
    assert.equal(page.location.hash, '#settings');
    assert.deepEqual(page.location.assigned, []);
    assert.notEqual(page.active, opener, 'the route focuses the Settings heading itself');
  });

  test('(+) Change in Settings in the session window opens the dashboard\'s Settings in the same window', () => {
    const { ids, dlg } = open({ window: 'session' });
    button(ids['kbd-foot'], 'Change in Settings').fire('click');
    assert.equal(dlg.open, false);
    assert.deepEqual(page.location.assigned, ['/#settings']);
    assert.equal(page.location.hash, '');
  });

  test('(−) opening while it is already open does nothing (no second showModal, no rebuild)', () => {
    const { ids, dlg } = open();
    const body = ids['kbd-body'].kids;
    openShortcuts({ window: 'session', tier: 'app', mac: true, singleKey: false, opener: new FNode('button') });
    assert.equal(dlg.shown, 1);
    assert.equal(ids['kbd-body'].kids, body);
    assert.equal(ids['kbd-sub'].textContent, 'Dashboard');
  });

  test('(−) a page without the dialog markup is a no-op, not a throw', () => {
    freshPage();
    delete page.ids['kbd-dlg'];
    assert.doesNotThrow(() => openShortcuts({ window: 'dashboard', tier: 'app', mac: false, singleKey: true, opener: null }));
  });

  test('(+) reopening rebuilds the tables for the new platform and window (no duplicated rows)', () => {
    const ids = freshPage();
    openShortcuts({ window: 'dashboard', tier: 'app', mac: false, singleKey: true, opener: null });
    ids['kbd-dlg'].close();
    openShortcuts({ window: 'session', tier: 'app', mac: true, singleKey: false, opener: null });
    assert.equal(ids['kbd-sub'].textContent, 'Session window');
    assert.equal(tagged(ids['kbd-body'], 'section').length, 5);
    assert.equal(ids['kbd-foot'].textContent.includes('Single-key shortcuts: Off'), true);
  });
});

// ---- next to the dashboard's menus and dialogs (the real initMenus / initDialogs of ui.js on the same fake page) ----------

describe('openShortcuts next to menus and dialogs (ui.js)', () => {
  /** A disclosure menu as menuEl() builds it: the button, then the list right after it; `item` is the control focus sits on. */
  const addMenu = () => {
    const btn = new FNode('button');
    btn.setAttribute('aria-expanded', 'true');
    const menu = new FNode('div');
    menu.className = 'menu';
    menu.setAttribute('data-up', '1');
    const item = new FNode('button');
    menu.append(item);
    menu.previousElementSibling = btn;
    page.menus.push(menu);
    return { btn, menu, item };
  };
  /** One Esc as the browser treats it: the page's keydown handlers run, and unless one prevented the default, the open modal closes. */
  const esc = () => {
    let prevented = false;
    for (const fn of page.docListeners.keydown ?? []) fn({ key: 'Escape', preventDefault() { prevented = true; } });
    if (!prevented) page.dialogs.filter((d) => d.open).at(-1)?.close();
    return prevented;
  };
  const show = (opener) => openShortcuts({ window: 'dashboard', tier: 'app', mac: false, singleKey: true, opener });

  test('(+) a menu that was open is closed when the window opens, and one Esc then closes the window', () => {
    const ids = freshPage();
    initMenus();
    initDialogs();
    const { btn, menu, item } = addMenu();
    show(item);
    assert.equal(menu.hidden, true);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(menu.hasAttribute('data-up'), false, 'the flip marker goes too, as closeMenu does');
    assert.equal(esc(), false, 'the menu handler leaves this Esc to the dialog');
    assert.equal(ids['kbd-dlg'].open, false, 'one press is enough');
  });

  test('(+) when focus was inside the closed menu, Close returns it to the menu button, not to the hidden item', () => {
    const ids = freshPage();
    const { btn, item } = addMenu();
    show(item);
    ids['kbd-dlg'].close();
    assert.equal(page.active, btn);
  });

  test('(−) a menu that is already closed and an opener outside any menu are left alone', () => {
    const ids = freshPage();
    const { btn, menu } = addMenu();
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    menu.setAttribute('data-up', '1');
    const opener = new FNode('button');
    show(opener);
    assert.equal(menu.getAttribute('data-up'), '1');
    ids['kbd-dlg'].close();
    assert.equal(page.active, opener);
  });

  test('(+) ui.js: with a dialog open, Esc leaves an open menu to the dialog (nothing prevented, menu untouched)', () => {
    const ids = freshPage();
    initMenus();
    const { menu } = addMenu();
    ids['kbd-dlg'].showModal();
    assert.equal(esc(), false);
    assert.equal(menu.hidden, false);
    assert.equal(ids['kbd-dlg'].open, false, 'the Esc went to the dialog');
  });

  test('(−) ui.js: with no dialog open, Esc still closes the open menu, prevents the default and focuses its button', () => {
    freshPage();
    initMenus();
    const { btn, menu } = addMenu();
    assert.equal(esc(), true);
    assert.equal(menu.hidden, true);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(page.active, btn);
  });

  test('(+) one focus-return path: Close and Esc put focus on the opener once, ui.js restoreFocus stays out of #kbd-dlg', () => {
    for (const close of [(ids) => button(ids['kbd-foot'], 'Close').fire('click'), (ids) => ids['kbd-dlg'].close()]) {
      const ids = freshPage();
      initDialogs();
      const opener = new FNode('button');
      show(opener);
      page.focusLog.length = 0;
      close(ids);
      assert.deepEqual(page.focusLog, [opener]);
    }
  });

  test('(+) a gone opener: the screen heading gets the focus once, and is focusable', () => {
    const ids = freshPage();
    initDialogs();
    const opener = new FNode('button');
    show(opener);
    opener.isConnected = false;
    page.focusLog.length = 0;
    ids['kbd-dlg'].close();
    assert.deepEqual(page.focusLog, [page.h1]);
    assert.equal(page.h1.getAttribute('tabindex'), '-1');
  });

  test('(−) every other dialog still gets its focus back from ui.js restoreFocus', () => {
    freshPage();
    initDialogs();
    const other = new FNode('dialog');
    page.dialogs.push(other);
    other.listeners = {};
    initDialogs();
    const trigger = new FNode('button');
    page.active = trigger;
    openDialog(other, { focus: new FNode('h2') });
    page.focusLog.length = 0;
    other.close();
    assert.equal(page.focusLog.at(-1), trigger);
  });

  test('(+) both pages mark #kbd-dlg data-own-focus, so initDialogs skips it', () => {
    for (const f of ['index.html', 'session.html']) {
      const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', f), 'utf8');
      assert.match(/<dialog\b[^>]*\bid="kbd-dlg"[^>]*>/.exec(html)?.[0] ?? '', /\bdata-own-focus\b/, f);
    }
  });
});

describe('hintTips: the session window\'s hint line (0.3.3)', () => {
  const LINUX = [
    { keys: ['Esc', 'Ctrl+C', 'Shift+Tab'], text: 'go to Claude', more: false },
    { keys: [UP, DOWN, 'Enter'], text: 'too, in an empty box', more: true },
    { keys: ['Ctrl+Shift+Tab'], text: 'moves focus back', more: false },
    { keys: ['Ctrl+/'], text: 'all shortcuts', more: true },
  ];
  const MACOS = [
    { keys: ['Esc', `${CTRL}C`, `${SHIFT}Tab`], text: 'go to Claude', more: false },
    { keys: [UP, DOWN, 'Enter'], text: 'too, in an empty box', more: true },
    { keys: [`${CTRL}${SHIFT}Tab`], text: 'moves focus back', more: false },
    { keys: [`${CMD}/`], text: 'all shortcuts', more: true },
  ];

  test('(+) Linux writes the words joined with "+"', () => {
    assert.deepEqual(hintTips(false), LINUX);
  });

  test('(+) macOS runs the glyphs together in one keycap', () => {
    assert.deepEqual(hintTips(true), MACOS);
  });

  test('(−) only the second and fourth tip hide when the composer is narrow; the first and third always show', () => {
    for (const mac of [true, false]) assert.deepEqual(hintTips(mac).map((t) => t.more), [false, true, false, true]);
  });

  test('(−) the tips name nothing the buttons carry: no send, commands, new line or type into pane', () => {
    for (const mac of [true, false]) {
      for (const t of hintTips(mac)) assert.doesNotMatch(t.text, /send|commands|new line|type into pane/i);
    }
  });

  test('(−) the Linux tips never use a glyph keycap and the macOS tips never spell a Ctrl or Shift word', () => {
    for (const t of hintTips(false)) for (const k of t.keys) assert.doesNotMatch(k, /[\u2303\u21e7\u2318]/);
    for (const t of hintTips(true)) for (const k of t.keys) assert.doesNotMatch(k, /Ctrl|Shift/);
  });
});

describe('shortcuts.js source', () => {
  test('(−) no HTML sinks: every cell is a text node or an attribute', () => {
    const sinks = [/inner\s*HTML/, /insertAdjacent\s*HTML/, /outer\s*HTML/, /document\s*\.\s*write/, /\beval\s*\(/, /new\s+Function\b/, /createContextualFragment/, /DOMParser/, /srcdoc/i];
    for (const re of sinks) assert.doesNotMatch(SRC.replace(/\/\/.*$/gm, ''), re, String(re));
  });

  test('(−) the file is plain ASCII (glyphs are escapes), makes no request and names no app route', () => {
    assert.equal([...SRC].every((ch) => ch.codePointAt(0) < 128), true);
    assert.doesNotMatch(SRC.replace(/\/\/.*$/gm, ''), /\bfetch\s*\(|XMLHttpRequest|\/api\/|__NIKA_APP__/);
  });
});
