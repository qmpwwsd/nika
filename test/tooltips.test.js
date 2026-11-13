// 0.4.0, G4: a control that shows an icon or a symbol and no words has a hover tooltip: a `title` equal to its accessible name (its
// aria-label, or the text a breakpoint hides). A control that already has a different title (a disabled item's reason) keeps it.
// Here: an audit of every page in public/ (the markup is read as text), the rail at 900 px and below, and the status glyph. The controls
// that page code builds are asserted in the vm rigs of the tests that already run that code (nesting-ui, dash-model, rules-sheet-ui,
// orch-ui). Names are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './fake-dom.js';
import { statusEl, STATUS } from '../public/ui.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PAGES = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));

const attr = (attrs, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

/** What a sighted person reads on the control: no icons, no screen-reader-only text, nothing marked aria-hidden, no tags. */
function visibleText(inner) {
  let s = inner.replace(/<svg\b[\s\S]*?<\/svg>/g, '');
  s = s.replace(/<(\w+)\b[^>]*\bclass="[^"]*\bsr-only\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, '');
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
    const glyph = /<svg\b|\baria-hidden="true"/.test(inner) || text !== '' || attr(attrs, 'aria-label') !== null;
    const iconOnly = /\bicon\b/.test(attr(attrs, 'class') ?? '') || (glyph && !/[\p{L}\p{N}]/u.test(text));
    if (iconOnly && !(attr(attrs, 'title') ?? '').trim()) out.push({ tag, id: attr(attrs, 'id'), name: attr(attrs, 'aria-label') ?? visibleText(inner) });
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

  test('(−) a control with visible words is not an icon control: it needs no title', () => {
    assert.deepEqual(untitledIconControls(`<button type="button" class="btn">${svg}<span class="lbl">Setup</span></button>`), []);
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
