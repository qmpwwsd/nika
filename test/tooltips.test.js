// 0.4.0, G4: a control that shows an icon or a symbol and no words has a hover tooltip: a `title` equal to its accessible name (its
// aria-label, or the text a breakpoint hides). A control that already has a different title (a disabled item's reason) keeps it.
// Here: an audit of every page in public/ (the markup is read as text), a text scan of the controls that public/*.js builds, the rail at
// 900 px and below, and the status glyph. Other controls that page code builds are asserted in the vm rigs of the tests that already run
// that code (nesting-ui, dash-model, rules-sheet-ui, orch-ui). Names are synthetic.
//
// What the audits count as "no words": the markup audit leaves out svg icons, screen-reader-only text, aria-hidden parts and every
// `.lbl` span (app.css and session.css hide `.lbl` at 760 and 900 px, so a control whose only words sit in one is an icon at that width).
// Limits, on purpose (a text scan, not a browser): the markup audit reads <button> and <a> elements only, not [role=button] or an
// <input type=button>; the JS scan reads calls of the exact form h('button' | 'a', { ...attributes }, ...children) with an object
// literal as the attributes and flags one whose attributes have a class `icon` (as a word of the class, in any string of the class
// expression) or whose children include h(..., { class: 'lbl' ... }), when no `title` key is in the same object. It does not follow an
// attribute object kept in a variable or spread in (`h('a', attrs, ...)`, `...rest`), a class built from a variable, or a control made
// by a helper; a control it cannot read to the end is reported, not skipped. Comments are blanked first. The rail's per-row titles are
// asserted by their own tests (they come through such a variable).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { installDom } from './fake-dom.js';
import { statusEl, STATUS } from '../public/ui.js';
import { h, icon } from '../public/dom.js';
import { DETECTED_MAX, sidebarModel } from '../public/dash-model.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PAGES = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));

const attr = (attrs, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/** What a sighted person reads on the control at every width: no icons, no screen-reader-only text, no .lbl span, nothing marked aria-hidden, no tags. */
function visibleText(inner) {
  let s = inner.replace(/<svg\b[\s\S]*?<\/svg>/g, '');
  s = s.replace(/<(\w+)\b[^>]*\bclass="[^"]*\b(?:sr-only|lbl)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ''); // .lbl: hidden by a breakpoint
  s = s.replace(/<(\w+)\b[^>]*\baria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, '');
  return s.replace(/<[^>]+>/g, '').trim();
}

/**
 * Every <button> and <a> in `html` that shows an icon or a symbol and no words (a class `icon`, or an svg, an aria-label or a glyph and no
 * visible letter or digit) and has no non-empty title: [{ tag, id, name }]. A button that is empty in the markup and filled by page code
 * (the confirm dialog's) is not an icon control.
 */
export function untitledIconControls(html) {
  const out = [];
  for (const m of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs, inner] = m;
    const text = visibleText(inner);
    const glyph = /<svg\b|\baria-hidden="true"|\bclass="[^"]*\blbl\b/.test(inner) || text !== '' || attr(attrs, 'aria-label') !== null;
    const iconOnly = /\bicon\b/.test(attr(attrs, 'class') ?? '') || (glyph && !/[\p{L}\p{N}]/u.test(text));
    const lblText = /<(\w+)\b[^>]*\bclass="[^"]*\blbl\b[^"]*"[^>]*>([^<]*)</.exec(inner)?.[2] ?? '';
    if (iconOnly && !(attr(attrs, 'title') ?? '').trim()) out.push({ tag, id: attr(attrs, 'id'), name: attr(attrs, 'aria-label') ?? (visibleText(inner) || lblText) });
  }
  return out;
}

/** Every <a> and <button> of the first <nav class="side"> that has no non-empty title: the rail shows only their icons at 900 px and below. */
export function untitledRailControls(html) {
  const nav = /<nav\b[^>]*\bclass="side"[^>]*>[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  const out = [];
  for (const m of nav.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    if (!(attr(m[2], 'title') ?? '').trim()) out.push({ tag: m[1], id: attr(m[2], 'id'), name: attr(m[2], 'aria-label') ?? visibleText(m[3]) });
  }
  return out;
}


/** The comments of a JS source blanked out (newlines kept, so a line number still counts). */
const blankComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, (m, lead) => lead + ' '.repeat(m.length - lead.length));

/** Index of the closing quote of the string or template literal that opens at `src[at]` (a `${…}` in a template is skipped whole). */
function endOfString(src, at) {
  for (let i = at + 1; i < src.length; i++) {
    if (src[i] === '\\') i += 1;
    else if (src[i] === src[at]) return i;
    else if (src[at] === '`' && src[i] === '$' && src[i + 1] === '{') i = closing(src, i + 1);
  }
  return src.length;
}

/** Index of the bracket that closes the one at `src[at]`; strings are skipped. -1 when it never closes. */
function closing(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') i = endOfString(src, i);
    else if (c === '(' || c === '{' || c === '[') depth += 1;
    else if ((c === ')' || c === '}' || c === ']') && --depth === 0) return i;
  }
  return -1;
}

/** The top-level entries of the object literal `src[open..close]`: [{ key, value }]. A spread entry has no key and is left out. */
function objectEntries(src, open, close) {
  const parts = [];
  let from = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') i = endOfString(src, i);
    else if (c === '(' || c === '{' || c === '[') i = closing(src, i);
    else if (c === ',' || i === close) {
      parts.push(src.slice(from, i));
      from = i + 1;
    }
  }
  return parts.flatMap((part) => {
    const m = /^\s*(?:'([^']*)'|"([^"]*)"|([\w$]+))\s*(?::([\s\S]*))?$/.exec(part);
    return m ? [{ key: m[1] ?? m[2] ?? m[3], value: m[4] ?? m[3] }] : [];
  });
}

/**
 * The calls h('button' | 'a', { … }, …) in a JS source that build an icon or .lbl-only control: [{ tag, line, why, title }], `why` 'icon'
 * (a class word `icon`) or 'lbl' (a child h(…, { class: 'lbl' … })), `title` whether the attribute object has a non-empty `title` key. A
 * call it cannot read to the end comes back with why 'unreadable' and no title. See the limits in the file header.
 */
export function jsControls(source) {
  const src = blankComments(source);
  const out = [];
  for (const m of src.matchAll(/\bh\(\s*'(button|a)'\s*,\s*(?=\{)/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    const open = m.index + m[0].length;
    const close = closing(src, open);
    const end = closing(src, src.indexOf('(', m.index));
    if (close < 0 || end < 0) {
      out.push({ tag: m[1], line, why: 'unreadable', title: false });
      continue;
    }
    const attrs = objectEntries(src, open, close);
    const icon = attrs.some((e) => e.key === 'class' && /(?<![\w-])icon(?![\w-])/.test(e.value));
    const lbl = /\bclass:\s*['"`]lbl['"`]/.test(src.slice(close + 1, end));
    const title = attrs.some((e) => e.key === 'title' && !/^\s*(?:''|""|``|null|undefined|false)\s*$/.test(e.value));
    if (icon || lbl) out.push({ tag: m[1], line, why: icon ? 'icon' : 'lbl', title });
  }
  return out;
}
export const untitledJsControls = (src) => jsControls(src).filter((c) => !c.title);

describe('the checker itself', () => {
  const svg = '<svg class="ic" aria-hidden="true"><use href="#i-x"/></svg>';

  test('(−) an icon button without a title is reported, however it is named (class icon, aria-label only, a symbol, sr-only words)', () => {
    assert.deepEqual(untitledIconControls('<button type="button" class="btn danger" id="cf-ok"></button>'), [], 'empty in the markup, filled by page code');
    const cases = {
      'class icon': `<button type="button" class="btn icon ghost" aria-label="Close">${svg}</button>`,
      'aria-label and an svg': `<button type="button" aria-label="Close">${svg}</button>`,
      'a symbol': '<button type="button" class="btn" aria-label="One more">+</button>',
      'sr-only words only': `<button type="button">${svg}<span class="sr-only">Close</span></button>`,
      'an aria-hidden glyph': '<button type="button"><span aria-hidden="true">⋯</span></button>',
      'an empty title': `<button type="button" class="btn icon" title="">${svg}</button>`,
      'a link': `<a href="#x" class="btn icon">${svg}</a>`,
    };
    for (const [name, html] of Object.entries(cases)) assert.equal(untitledIconControls(html).length, 1, name);
  });

  test('(+) a title, on the control, makes it pass; so does any other title (it keeps its own words)', () => {
    assert.deepEqual(untitledIconControls(`<button type="button" class="btn icon" aria-label="Close" title="Close">${svg}</button>`), []);
    assert.deepEqual(untitledIconControls(`<button type="button" class="btn icon" aria-label="Compact" title="Types /compact and Enter">${svg}</button>`), []);
    assert.deepEqual(untitledIconControls('<button type="button" aria-label="One fewer" title="One fewer">−</button>'), []);
  });

  test('(−) a control whose only words sit in a .lbl span (hidden by a breakpoint) is an icon control: it needs a title', () => {
    const lbl = `<button type="button" class="btn">${svg}<span class="lbl">Setup</span></button>`;
    assert.equal(untitledIconControls(lbl).length, 1, 'with an icon');
    assert.equal(untitledIconControls(lbl)[0].name, 'Setup', 'the report names it by its hidden words');
    assert.equal(untitledIconControls('<button type="button" class="btn"><span class="lbl">Setup</span></button>').length, 1, 'with no icon at all');
    assert.equal(untitledIconControls(`<a class="btn" href="#x">${svg}<span class="lbl">Open</span><span class="sr-only">(opens)</span></a>`).length, 1, 'a link, with sr-only words too');
  });

  test('(+) the same control with a title passes, and so does one that has words outside the .lbl span', () => {
    assert.deepEqual(untitledIconControls(`<button type="button" class="btn" title="Setup">${svg}<span class="lbl">Setup</span></button>`), []);
    assert.deepEqual(untitledIconControls(`<button type="button" class="btn">${svg}<span class="lbl">Model</span> <span class="mono">sonnet</span></button>`), []);
  });

  test('(−) a control with visible words is not an icon control: it needs no title', () => {
    assert.deepEqual(untitledIconControls('<button type="button" class="btn">Cancel</button>'), []);
    assert.deepEqual(untitledIconControls(`<a class="back" href="#dashboard">${svg}<span>Dashboard</span></a>`), []);
    assert.deepEqual(untitledIconControls('<a class="skip" href="#main">Skip to content</a>'), []);
  });

  test('(+) the report names the control', () => {
    const [hit] = untitledIconControls(`<button type="button" class="btn icon" id="x-btn" aria-label="Close">${svg}</button>`);
    assert.deepEqual(hit, { tag: 'button', id: 'x-btn', name: 'Close' });
  });

  test('(−) the rail checker reports a link that has words but no title (the words are hidden at 900 px)', () => {
    const nav = (a) => `<nav class="side" aria-label="Main"><div class="nav">${a}</div></nav>`;
    assert.equal(untitledRailControls(nav(`<a href="#dashboard">${svg}<span class="label">Dashboard</span></a>`)).length, 1);
    assert.deepEqual(untitledRailControls(nav(`<a href="#dashboard" title="Dashboard">${svg}<span class="label">Dashboard</span></a>`)), []);
    assert.deepEqual(untitledRailControls('<nav class="set-index"><a href="#a">A</a></nav>'), [], 'only the sidebar is the rail');
  });
});

describe('every page in public/: an icon or symbol control has a title', () => {
  test('(+) there are pages to audit', () => {
    assert.deepEqual(PAGES.sort(), ['index.html', 'session.html']);
  });

  for (const f of PAGES) {
    test(`(+) ${f}: none without one`, () => {
      assert.deepEqual(untitledIconControls(fs.readFileSync(path.join(PUBLIC, f), 'utf8')), []);
    });
  }

  test('(+) the five Close buttons of the dialogs, the Auto-compact and agent-limit steppers and the new drawer\'s × are all in the audit and carry a title', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    const close = [...html.matchAll(/<button\b[^>]*\bdata-close\b[^>]*>/g)].map((m) => m[0]).filter((b) => /aria-label="Close"/.test(b));
    assert.equal(close.length, 6, 'spawn, rules, plugins, models, report and the Setup drawer');
    for (const b of close) assert.match(b, /\btitle="Close"/);
    for (const [name, label] of [['data-fk="compact-dec"', '5 percent less'], ['data-fk="compact-inc"', '5 percent more'], ['data-step="-1"', 'One fewer'], ['data-step="1"', 'One more']]) {
      const b = new RegExp(`<button\\b[^>]*${name}[^>]*>`).exec(html)?.[0] ?? '';
      assert.match(b, new RegExp(`aria-label="${label}"`), name);
      assert.match(b, new RegExp(`\\btitle="${label}"`), name);
    }
  });
});

describe('the controls that public/*.js builds: the text scan', () => {
  const flagged = (src) => untitledJsControls(src).length;

  test('(−) an icon button, a .lbl-only button and a .lbl-only link without a title are each reported', () => {
    assert.equal(flagged("h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Close' }, icon('x'))"), 1, 'class icon');
    assert.equal(flagged("h('button', { type: 'button', class: wide ? 'btn' : 'btn icon' }, icon('x'))"), 1, 'class icon inside a conditional');
    assert.equal(flagged("h('button', { type: 'button', class: 'btn' }, icon('panel'), h('span', { class: 'lbl', text: 'Setup' }))"), 1, 'a .lbl child');
    assert.equal(flagged("h('a', { class: 'btn', href }, icon('term'), h('span', { class: 'lbl', text: 'Open' }))"), 1, 'a link');
  });

  test('(−) strings and template literals with brackets in them do not end the attribute object early', () => {
    const src = [
      "h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': `Add ${r.name} as a project ) }`, onclick: () => add({ a: [1] }) },",
      "  icon('plus'))",
    ].join('\n');
    assert.equal(flagged(src), 1);
    assert.equal(flagged(src.replace("onclick:", "title: `Add ${r.name}`, onclick:")), 0, 'and a title after them is seen');
  });

  test('(+) a title in the same attribute object passes: a string, a template, a variable, the shorthand', () => {
    assert.equal(flagged("h('button', { class: 'btn icon', title: 'Close' }, icon('x'))"), 0);
    assert.equal(flagged("h('button', { class: 'btn icon', title: `Add ${name}` }, icon('x'))"), 0);
    assert.equal(flagged("h('button', { class: 'btn icon', 'aria-label': label, title: label }, icon('x'))"), 0);
    assert.equal(flagged("h('button', { class: 'btn icon', title }, icon('x'))"), 0);
    assert.equal(flagged("h('button', { class: 'btn', title: 'Setup' }, icon('panel'), h('span', { class: 'lbl', text: 'Setup' }))"), 0);
  });

  test('(−) a title that is only in a comment, in a string or in a child does not count', () => {
    assert.equal(flagged("h('button', { class: 'btn icon' /* title: 'Close' */ }, icon('x'))"), 1, 'block comment');
    assert.equal(flagged("h('button', { class: 'btn icon' }, icon('x')) // title: 'Close'"), 1, 'line comment');
    assert.equal(flagged("h('button', { class: 'btn icon', 'aria-label': 'a title: b' }, icon('x'))"), 1, 'inside a string');
    assert.equal(flagged("h('button', { class: 'btn icon' }, h('span', { title: 'Close' }))"), 1, 'on a child');
  });

  test('(−) a control with words, a class that only starts with icon, and a non-control are not reported', () => {
    assert.equal(flagged("h('button', { type: 'button', class: 'btn', text: 'Cancel' })"), 0);
    assert.equal(flagged("h('button', { type: 'button', class: 'btn icon-row', text: 'Cancel' })"), 0);
    assert.equal(flagged("h('span', { class: 'lbl', text: 'Setup' })"), 0, 'a .lbl span outside a button or link');
    assert.equal(flagged("h('div', { class: 'btn icon' })"), 0);
  });

  test('(+) the report names the control and its line', () => {
    const [hit, ...more] = untitledJsControls("const a = 1;\nconst b = h('a', { class: 'btn icon', href }, icon('x'));\n");
    assert.deepEqual(more, []);
    assert.deepEqual([hit.tag, hit.line, hit.why], ['a', 2, 'icon']);
  });

  test('(−) a call it cannot read to the end is reported, not skipped', () => {
    assert.equal(flagged("h('button', { class: 'btn', onclick: () => go( }, icon('x'))"), 1);
    assert.equal(untitledJsControls("h('button', { class: 'btn', onclick: () => go( }, icon('x'))")[0].why, 'unreadable');
  });

  test('(−) an attribute object kept in a variable is out of reach (stated limit): nothing is reported for it', () => {
    assert.equal(flagged("h('a', attrs, h('span', { class: 'lbl', text: r.name }))"), 0);
  });

  for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.js')).sort()) {
    test(`(+) ${f}: no icon or .lbl-only control without a title`, () => {
      assert.deepEqual(untitledJsControls(fs.readFileSync(path.join(PUBLIC, f), 'utf8')), []);
    });
  }

  test('(+) the scan sees the controls it is meant to: the menu trigger (icon) and the project page buttons (.lbl)', () => {
    const seen = (f) => jsControls(fs.readFileSync(path.join(PUBLIC, f), 'utf8'));
    assert.ok(seen('ui.js').some((c) => c.why === 'icon' && c.title), 'ui.js menu trigger');
    assert.ok(seen('project.js').filter((c) => c.why === 'lbl' && c.title).length >= 3, 'project.js: Setup, Add project, Open orchestrator and the group actions');
  });
});

describe('the rail (900 px and below): every sidebar link and button has a title', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

  test('(+) the static ones: the two nav links, the Add project button, the shortcuts button', () => {
    assert.deepEqual(untitledRailControls(html), []);
    const nav = /<nav\b[^>]*\bclass="side"[^>]*>[\s\S]*?<\/nav>/.exec(html)[0];
    assert.match(nav, /<a href="#dashboard" data-nav="dashboard" title="Dashboard">/);
    assert.match(nav, /<a href="#settings" data-nav="settings" title="Settings">/);
  });

  test('(−) the app.css rail rule still hides the words, so the titles are what is left', () => {
    const css = fs.readFileSync(path.join(PUBLIC, 'app.css'), 'utf8');
    assert.match(css, /@media \(max-width: 900px\) \{[\s\S]*?\.side \.label[\s\S]*?\.side-foot \.long/);
  });
});

describe('the rail: a project row\'s title is its accessible name, count included', () => {
  // project.js renderSide and sideLink run in a vm on the fake page; `accName` is the text a screen reader builds from the row's link.
  const PROJECT = blankComments(fs.readFileSync(path.join(PUBLIC, 'project.js'), 'utf8'));
  const fnSrc = (head) => {
    const at = PROJECT.indexOf(head);
    assert.ok(at >= 0, `${head} exists`);
    return PROJECT.slice(at, PROJECT.indexOf('\n}\n', at) + 2);
  };
  let restore;
  before(() => { restore = installDom(); });
  after(() => restore());

  /** Draws the sidebar for `projects` / `detected`: [{ name, attn, live }]; returns the links of both lists. */
  function rail({ projects = [], detected = [] }) {
    const hosts = {};
    const host = (sel) => (hosts[sel] ??= { sel, nodes: [], hidden: false, textContent: '' });
    const regs = projects.map((p, i) => ({ key: `p${i}`, name: p.name, dir: `/work/${p.name}` }));
    const groups = [
      ...projects.map((p, i) => ({ key: `p${i}`, label: p.name, root: regs[i].dir, project: regs[i], counts: { attn: p.attn, live: p.live } })),
      ...detected.map((d, i) => ({ key: `d${i}`, label: d.name, root: `/other/${d.name}`, project: null, counts: { attn: d.attn, live: d.live } })),
    ];
    const ctx = {
      state: { projects: regs, route: { name: 'dashboard' }, me: null, expanded: new Set() },
      DETECTED_MAX, sidebarModel, buildGroups: () => groups, showGroup() {}, addProject() {}, h, icon, $: host,
      swap: (el, nodes) => { el.nodes = nodes.flat().filter(Boolean); },
    };
    const src = ["let sideSig = '';", fnSrc('function sideLink('), fnSrc('function renderSide(')].join('\n');
    const { renderSide } = vm.runInNewContext(`${src}\n({ renderSide })`, ctx);
    renderSide();
    const links = (sel) => host(sel).nodes.map((li) => li.all((n) => n.tag === 'a')[0]);
    return { projects: links('#side-projects'), detected: links('#side-detected'), host };
  }

  test('(+) a project that needs you: "name, needs you: N", the words the link is read with', () => {
    const [a] = rail({ projects: [{ name: 'acme-api', attn: 2, live: 3 }] }).projects;
    assert.equal(a.attrs.title, 'acme-api, needs you: 2');
    assert.equal(a.attrs.title, a.accName);
  });

  test('(+) a project with live agents and nobody waiting: "name, live agents: N"', () => {
    const [a] = rail({ projects: [{ name: 'web-shop', attn: 0, live: 1 }] }).projects;
    assert.equal(a.attrs.title, 'web-shop, live agents: 1');
    assert.equal(a.attrs.title, a.accName);
  });

  test('(−) a project with no count has just its name, and no count text of any kind', () => {
    const [a] = rail({ projects: [{ name: 'demo-api', attn: 0, live: 0 }] }).projects;
    assert.equal(a.attrs.title, 'demo-api');
    assert.equal(a.attrs.title, a.accName);
    assert.doesNotMatch(a.attrs.title, /needs you|live agents|:|\d/);
  });

  test('(+) each row of a mixed list gets its own title, and keeps its href and focus key', () => {
    const r = rail({ projects: [{ name: 'acme-api', attn: 1, live: 1 }, { name: 'web-shop', attn: 0, live: 4 }, { name: 'demo-api', attn: 0, live: 0 }] });
    assert.deepEqual(r.projects.map((a) => a.attrs.title), ['acme-api, needs you: 1', 'web-shop, live agents: 4', 'demo-api']);
    assert.deepEqual(r.projects.map((a) => a.attrs['data-fk']), ['side:p0', 'side:p1', 'side:p2']);
    assert.deepEqual(r.projects.map((a) => a.attrs.href), ['#project/p0', '#project/p1', '#project/p2']);
  });

  test('(+) a Detected row keeps "Show … on the dashboard" and adds the count the same way', () => {
    const r = rail({ detected: [{ name: 'orbit-app', attn: 1, live: 2 }, { name: 'lamp-api', attn: 0, live: 3 }] });
    const [needs, live] = r.detected;
    assert.equal(needs.attrs.title, 'Show orbit-app on the dashboard, needs you: 1');
    assert.equal(live.attrs.title, 'Show lamp-api on the dashboard, live agents: 3');
    assert.equal(needs.attrs.title, `Show ${'orbit-app'} on the dashboard${needs.accName.slice('orbit-app'.length)}`, 'the tail is what the link is read with');
  });

  test('(−) a Detected row without waiting agents does not say "needs you"; its Add button keeps its own title', () => {
    const r = rail({ detected: [{ name: 'lamp-api', attn: 0, live: 3 }] });
    assert.doesNotMatch(r.detected[0].attrs.title, /needs you/);
    const add = r.host('#side-detected').nodes[0].all((n) => n.tag === 'button')[0];
    assert.equal(add.attrs.title, 'Add lamp-api as a project');
    assert.equal(add.attrs['aria-label'], add.attrs.title);
  });
});

describe('the status glyph (rows show only it at narrow widths)', () => {
  let restore;
  before(() => { restore = installDom(); });
  after(() => restore());

  test('(+) each status carries its word as the title, equal to its text for a screen reader', () => {
    for (const s of ['attn', 'idle', 'busy', 'ended']) {
      const el = statusEl(s);
      assert.equal(el.attrs.title, STATUS[s].label, s);
      assert.equal(el.all((n) => n.className === 'st-l')[0].textContent, STATUS[s].label, s);
    }
  });

  test('(−) the compact and pill variants keep it too; the glyph itself stays hidden from screen readers', () => {
    assert.equal(statusEl('busy', { compact: true }).attrs.title, 'Working');
    assert.equal(statusEl('attn', { pill: true }).attrs.title, 'Needs you');
    assert.equal(statusEl('idle').all((n) => n.className === 'st-g')[0].attrs['aria-hidden'], 'true');
  });
});
