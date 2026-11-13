// 0.4, O5: the context indicator, the page side (design 0.4 section 6). The real page code runs against the small fake DOM
// (test/fake-dom.js); the browser itself is exercised by hand. ctxView (the text) is tested in test/ctx.test.js. The copy strings are
// written out here on purpose: the tests must not read them back from the code under test. Names and ids are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, withClass } from './fake-dom.js';
import { h, icon, roleTagEl, ctxEl } from '../public/dom.js';
import { menuEl, sessionHref } from '../public/ui.js';
import { roleTag, parentOf } from '../public/dash-model.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const fn = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} exists`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
};
const NB = '\u00a0';

let restore;
before(() => { restore = installDom(); });
after(() => restore());

const ctx = (over = {}) => ({ tokens: 312000, window: 400000, compactAt: 320000, pct: 78, compaction: 'on', ...over });
const named = (n, cls) => n.all(withClass(cls));
const one = (n, cls) => named(n, cls)[0] ?? null;

describe('ctxEl: the meter (design 6.1, 6.3)', () => {
  test('(+) a row meter: span.ctx with data-lvl and title, the visible number and a quantised bar hidden from assistive tech, then the sr-only text', () => {
    const el = ctxEl(ctx());
    assert.equal(el.tag, 'span');
    assert.equal(el.className, 'ctx');
    assert.equal(el.attrs['data-lvl'], 'warn');
    assert.equal(el.attrs.title, 'Context: 312k of 400k tokens (compacts at 320k)');
    const v = one(el, 'ctx-v');
    assert.equal(v.textContent, `78${NB}%`);
    assert.equal(v.attrs['aria-hidden'], 'true');
    const bar = one(el, 'ctx-bar');
    assert.equal(bar.attrs['data-q'], '8');
    assert.equal(bar.attrs['aria-hidden'], 'true');
    assert.equal(bar.kids.length, 1);
    assert.equal(bar.kids[0].tag, 'i');
    assert.equal(one(el, 'sr-only').textContent, `Context 78${NB}% used, 312k of 400k tokens, compacts at 320k`);
    assert.equal(el.accName, `Context 78${NB}% used, 312k of 400k tokens, compacts at 320k`, 'a screen reader hears the sr text once');
  });

  test('(+) the three states of the title: on, off and none', () => {
    assert.equal(ctxEl(ctx({ compaction: 'off', compactAt: null, window: 1000000, pct: 31 })).attrs.title, "Context: 312k of 1M tokens (the model's window; auto-compact is off)");
    assert.equal(ctxEl(ctx({ compaction: 'none', compactAt: null })).attrs.title, 'Context: 312k of 400k tokens');
  });

  test('(+) full: a warning icon before the number; ok and warn have none', () => {
    const full = one(ctxEl(ctx({ pct: 86 })), 'ctx-v');
    assert.equal(full.kids[0].tag, 'svg');
    assert.equal(full.kids[0].kids[0].attrs.href, '#i-warn');
    assert.equal(full.textContent, `86${NB}%`);
    for (const pct of [41, 63]) assert.equal(one(ctxEl(ctx({ pct })), 'ctx-v').all((n) => n.tag === 'svg').length, 0, String(pct));
  });

  test('(+) unknown and nowin: the dash or the count, muted by data-lvl, no bar', () => {
    const unknown = ctxEl(null);
    assert.equal(unknown.attrs['data-lvl'], 'unknown');
    assert.equal(one(unknown, 'ctx-v').textContent, '–');
    assert.equal(one(unknown, 'ctx-bar'), null);
    assert.equal(unknown.attrs.title, 'Context: no usage yet');
    assert.equal(unknown.accName, 'Context unknown');
    const nowin = ctxEl(ctx({ window: null, pct: null, compactAt: null }));
    assert.equal(nowin.attrs['data-lvl'], 'nowin');
    assert.equal(one(nowin, 'ctx-v').textContent, '312k');
    assert.equal(one(nowin, 'ctx-bar'), null);
    assert.equal(nowin.attrs.title, 'Context: 312k tokens; the window is not known yet');
  });

  test('(+) every level gets its bar step; over 100 % fills the bar', () => {
    for (const [pct, q] of [[0, '0'], [41, '4'], [63, '6'], [86, '9'], [100, '10'], [180, '10']]) assert.equal(one(ctxEl(ctx({ pct })), 'ctx-bar').attrs['data-q'], q, String(pct));
  });

  test('(+) the header meter: the word Context, the long numbers (hidden on narrow windows), the number, the bar, the sr text', () => {
    const el = ctxEl(ctx(), { header: true });
    assert.equal(el.className, 'ctx');
    const parts = el.kids.map((k) => k.className);
    assert.deepEqual(parts, ['ctx-l', 'ctx-t hide-narrow', 'ctx-v', 'ctx-bar', 'sr-only']);
    assert.equal(el.kids[0].textContent, 'Context');
    assert.equal(el.kids[1].textContent, '312k / 400k ·');
    assert.equal(el.kids[2].textContent, `78${NB}%`);
    for (const k of el.kids.slice(0, 4)) assert.equal(k.attrs['aria-hidden'], 'true', k.className);
    assert.equal(el.accName, `Context 78${NB}% used, 312k of 400k tokens, compacts at 320k`);
    assert.equal(el.attrs.title, 'Context: 312k of 400k tokens (compacts at 320k)');
  });

  test('(+) the header with nothing to compare: no long numbers, no bar', () => {
    for (const c of [null, ctx({ window: null, pct: null })]) {
      const el = ctxEl(c, { header: true });
      assert.equal(one(el, 'ctx-t'), null);
      assert.equal(one(el, 'ctx-bar'), null);
      assert.equal(one(el, 'ctx-l').textContent, 'Context');
    }
  });

  test('(+) into an existing element: the same node is filled again at every poll (children replaced, attributes updated)', () => {
    const slot = new El('span');
    slot.className = 'ctx';
    slot.hidden = true;
    const a = ctxEl(ctx({ pct: 41 }), { header: true, el: slot });
    assert.equal(a, slot);
    assert.equal(slot.attrs['data-lvl'], 'ok');
    const before1 = slot.kids.length;
    ctxEl(ctx({ pct: 86 }), { header: true, el: slot });
    assert.equal(slot.attrs['data-lvl'], 'full');
    assert.equal(slot.kids.length, before1, 'replaced, not appended');
    assert.equal(slot.className, 'ctx');
  });

  test('(−) numbers only reach the page as formatted text: a hostile or malformed context renders as the dash or as nowin, never as markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    for (const c of [{ tokens: evil, window: 1, pct: 1 }, { tokens: 5000, window: evil, pct: evil, compaction: evil }, evil, { tokens: 5000, window: 1000, pct: 1, compaction: evil, compactAt: evil }]) {
      const el = ctxEl(c, { header: true });
      const texts = [el.textContent, el.attrs.title];
      for (const t of texts) assert.equal(t.includes('<'), false, JSON.stringify(c));
      assert.equal(el.all((n) => n.tag === 'img').length, 0);
    }
  });

  test('(−) no inline style, no CSSOM write and no markup string in the code that draws the meter', () => {
    const dom = code(read('dom.js'));
    const body = fn(dom, 'export function ctxEl(');
    assert.equal(/\.style\b|style:|innerHTML|insertAdjacentHTML|outerHTML|setAttribute\(['"]style/.test(body), false);
    assert.equal(/\.style\b|innerHTML/.test(code(read('ctx.js'))), false);
    assert.equal(/\bstyle\s*=/.test(read('session.html').replace(/<style[\s\S]*?<\/style>/g, '')), false);
  });
});

describe('the row cell (both tiers, design 6.2)', () => {
  const APP = code(read('app.js'));
  const SHAPE = { uuid: /^[0-9a-f-]{36}$/, pane: /^%\d{1,6}$/, key: /^[a-z0-9]{16}$/, claudeUrl: /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{1,64}$/ };
  function rowOf(a, { isApp }) {
    const sandbox = {
      h, icon, roleTag, roleTagEl, menuEl, hooks: {}, SHAPE, sessionHref, isApp, parentOf, ctxEl,
      state: { modes: { map: {} } }, document: { getSelection: () => ({ isCollapsed: true }) }, location: {},
      sOf: (x) => (x.live ? 'idle' : 'ended'), rowMode: () => null, canEndRow: () => false, endedText: () => 'Ended', reasonOf: () => '', endedScope: (s) => `${s}-e`,
      statusEl: () => new El('span'), modeEl: () => new El('span'), modelEl: () => h('span', { class: 'model', text: 'Sonnet 5.5' }), timeEl: () => new El('span'),
      copyText: () => {}, showReport: () => {}, focusPane: () => {}, endSession: () => {},
    };
    const rowEl = vm.runInNewContext(`${fn(APP, 'function rowEl(')}; rowEl`, sandbox);
    return rowEl(a, { key: 'k', label: 'demo-api', project: null, agents: [] }, { scope: 'g' });
  }
  const agent = (over = {}) => ({ id: '11111111-1111-4111-8111-111111111111', name: 'planner', live: true, pane: { id: '%3' }, resumeCmd: 'claude --resume x', lastActivity: 1, subagents: [], ...over });
  const cells = (li) => li.kids.map((k) => k.className);

  test('(+) browser tier: a c-ctx cell right after c-model, carrying the meter of a.context', () => {
    const li = rowOf(agent({ context: ctx() }), { isApp: false });
    const c = cells(li);
    assert.equal(c.indexOf('c-ctx'), c.indexOf('c-model') + 1);
    assert.deepEqual(c.slice(0, 5), ['c-st', 'c-name', 'c-model', 'c-ctx', 'c-what']);
    const cell = li.kids[c.indexOf('c-ctx')];
    assert.equal(cell.tag, 'div');
    assert.equal(cell.kids[0].className, 'ctx');
    assert.equal(cell.kids[0].attrs['data-lvl'], 'warn');
    assert.equal(one(cell, 'ctx-v').textContent, `78${NB}%`);
  });

  test('(+) app tier: the same cell after c-model (the mode cell is still before the name)', () => {
    const li = rowOf(agent({ context: ctx({ pct: 86 }) }), { isApp: true });
    assert.deepEqual(cells(li).slice(0, 6), ['c-st', 'c-mode', 'c-name', 'c-model', 'c-ctx', 'c-what']);
    assert.equal(one(li, 'ctx').attrs['data-lvl'], 'full');
  });

  test('(+) a session without context (an older server, or no usage yet) still has the cell, as the dash', () => {
    for (const isApp of [false, true]) {
      for (const context of [undefined, null]) {
        const li = rowOf(agent({ context }), { isApp });
        assert.equal(one(li, 'ctx').attrs['data-lvl'], 'unknown');
        assert.equal(one(li, 'ctx-v').textContent, '–');
      }
    }
  });

  test('(+) an ended row keeps its last value (the muting is CSS: data-s="ended" on the row)', () => {
    const li = rowOf(agent({ live: false, context: ctx({ compaction: 'none', compactAt: null }) }), { isApp: false });
    assert.equal(li.attrs['data-s'], 'ended');
    assert.equal(one(li, 'ctx').attrs.title, 'Context: 312k of 400k tokens');
    assert.equal(one(li, 'ctx-v').textContent, `78${NB}%`);
  });

  test('(−) a hostile context never becomes markup in a row', () => {
    const li = rowOf(agent({ context: { tokens: '<b>x</b>', window: '<i>', pct: '<u>' } }), { isApp: false });
    assert.equal(one(li, 'ctx').attrs['data-lvl'], 'unknown');
    assert.equal(li.textContent.includes('<b>'), false);
  });
});

describe('the session header (design 6.4)', () => {
  const SESSION = code(read('session.js'));
  const HTML = read('session.html');

  test('(+) session.html has #sess-ctx: a hidden span.ctx in .sess-meta, after the model and before the pane', () => {
    assert.match(HTML, /<span class="ctx" id="sess-ctx" hidden><\/span>/);
    const at = (s) => HTML.indexOf(s);
    assert.ok(at('id="sess-model"') > 0 && at('id="sess-model"') < at('id="sess-ctx"') && at('id="sess-ctx"') < at('id="meta-pane"'));
    assert.ok(at('class="sess-meta"') < at('id="sess-ctx"'));
  });

  function rig() {
    const slot = new El('span');
    slot.className = 'ctx';
    slot.hidden = true;
    const sandbox = { ctxEl, $: (id) => (id === 'sess-ctx' ? slot : null) };
    const renderContext = vm.runInNewContext(`${fn(SESSION, 'function renderContext(')}; renderContext`, sandbox);
    return { slot, renderContext };
  }

  test('(+) hidden until the first poll; then rendered (the number, the bar, the title), and again at each poll', () => {
    const { slot, renderContext } = rig();
    assert.equal(slot.hidden, true);
    renderContext({ context: ctx() });
    assert.equal(slot.hidden, false);
    assert.equal(one(slot, 'ctx-v').textContent, `78${NB}%`);
    assert.equal(slot.attrs.title, 'Context: 312k of 400k tokens (compacts at 320k)');
    assert.equal(one(slot, 'ctx-t').textContent, '312k / 400k ·');
    renderContext({ context: ctx({ pct: 91, tokens: 364000 }) });
    assert.equal(slot.attrs['data-lvl'], 'full');
    assert.equal(slot.kids.filter((k) => k.className === 'ctx-v').length, 1);
  });

  test('(+) a session with no usage shows "Context –" rather than staying hidden', () => {
    const { slot, renderContext } = rig();
    renderContext({});
    assert.equal(slot.hidden, false);
    assert.equal(slot.attrs['data-lvl'], 'unknown');
    assert.equal(one(slot, 'ctx-v').textContent, '–');
  });

  test('(+) applyAgent draws it from the polled agent; it reads no settings', () => {
    assert.match(fn(SESSION, 'function applyAgent('), /renderContext\(agent\);/);
    assert.equal(/compactPct|compaction\b/.test(fn(SESSION, 'function renderContext(')), false);
  });

  test('(−) a failed poll leaves the header as it was: refreshAgent returns before applyAgent', () => {
    const body = fn(SESSION, 'async function refreshAgent(');
    assert.ok(body.indexOf('return; // the header keeps its last values') < body.indexOf('applyAgent('));
  });
});

describe('the CSS (design 6.2, 6.3)', () => {
  const TOKENS = read('tokens.css');
  const APPCSS = read('app.css');
  const SESSCSS = read('session.css');

  test('(+) tokens.css: the meter, its bar and the ten quantised steps (no inline width, no script)', () => {
    for (const sel of ['.ctx {', '.ctx-v {', '.ctx .ic {', '.ctx-bar {', '.ctx-bar > i {']) assert.ok(TOKENS.includes(sel), sel);
    for (let q = 1; q <= 10; q += 1) assert.ok(TOKENS.includes(`.ctx-bar[data-q="${q}"] > i { width: ${q * 10}%; }`), `q ${q}`);
    assert.ok(TOKENS.includes('.ctx[data-lvl="unknown"], .ctx[data-lvl="nowin"] { color: var(--text-muted); }'));
    assert.match(TOKENS, /\.ctx\[data-lvl="warn"\] \{ color: var\(--idle\); \}/);
    assert.match(TOKENS, /\.ctx\[data-lvl="warn"\] \.ctx-bar > i \{ background: var\(--idle\); \}/);
    assert.match(TOKENS, /\.ctx\[data-lvl="full"\] \{ color: var\(--danger\); \}/);
    assert.match(TOKENS, /\.ctx\[data-lvl="full"\] \.ctx-bar > i \{ background: var\(--danger\); \}/);
  });

  test('(+) ended rows are muted and their bar fill is the neutral line colour at every level', () => {
    assert.ok(TOKENS.includes('.row[data-s="ended"] .ctx { color: var(--text-muted); }'));
    assert.ok(TOKENS.includes('.row[data-s="ended"] .ctx-bar > i { background: var(--line-strong); }'));
  });

  test('(+) app.css: the row grids of section 6.2 at the three widths, both tiers, and the c-ctx cell', () => {
    const rules = [
      '104px minmax(232px, 1.5fr) 88px 64px minmax(0, 2fr) 56px 44px 32px',
      '104px 128px minmax(232px, 1.5fr) 88px 64px minmax(0, 2fr) 56px 44px 32px',
      '22px minmax(208px, 1.1fr) 56px minmax(0, 2fr) 52px 32px',
      '22px 24px minmax(208px, 1.1fr) 56px minmax(0, 2fr) 52px 32px',
      '22px minmax(0, 1fr) 56px 40px 32px',
      '22px 24px minmax(0, 1fr) 56px 40px 32px',
    ];
    for (const r of rules) assert.ok(APPCSS.includes(`grid-template-columns: ${r};`), r);
    assert.ok(APPCSS.includes('.c-ctx { min-width: 0; display: flex; justify-content: flex-end; }'));
    assert.ok(APPCSS.includes('.c-ctx .ctx-bar { display: none; }'));
    assert.ok(APPCSS.includes('.row .c-act { grid-row: 1; grid-column: 4; }'));
    assert.ok(APPCSS.includes('body[data-tier="app"] .row .c-act { grid-row: 1; grid-column: 5; }'));
  });

  test('(−) the 0.3.4 grids without the context column are gone (they would put the cells in the wrong columns)', () => {
    for (const old of [
      '104px minmax(120px, 1.1fr) 88px minmax(0, 2.4fr) 56px 44px 32px', '104px 128px minmax(120px, 1.1fr) 88px minmax(0, 2.4fr) 56px 44px 32px',
      '22px minmax(110px, 1fr) minmax(0, 2fr) 52px 32px', '22px 24px minmax(110px, 1fr) minmax(0, 2fr) 52px 32px', '22px minmax(0, 1fr) 44px 32px', '22px 24px minmax(0, 1fr) 44px 32px',
    ]) assert.equal(APPCSS.includes(`grid-template-columns: ${old};`), false, old);
  });

  test('(−) the first 0.4 grids (a 120px or 110px name column) are gone: the name lost its room to the elbow and the role tag', () => {
    for (const old of [
      '104px minmax(120px, 1.1fr) 88px 64px minmax(0, 2.4fr) 56px 44px 32px', '104px 128px minmax(120px, 1.1fr) 88px 64px minmax(0, 2.4fr) 56px 44px 32px',
      '22px minmax(110px, 1fr) 44px minmax(0, 2fr) 52px 32px', '22px 24px minmax(110px, 1fr) 44px minmax(0, 2fr) 52px 32px',
    ]) assert.equal(APPCSS.includes(`grid-template-columns: ${old};`), false, old);
  });

  test('(−) the narrow grids with a 44px context column are gone: "⚠ 105 %" is 55px wide and spilled 11px into the name or the gap', () => {
    for (const old of [
      '22px minmax(208px, 1.1fr) 44px minmax(0, 2fr) 52px 32px', '22px 24px minmax(208px, 1.1fr) 44px minmax(0, 2fr) 52px 32px',
      '22px minmax(0, 1fr) 44px 44px 32px', '22px 24px minmax(0, 1fr) 44px 44px 32px',
    ]) assert.equal(APPCSS.includes(`grid-template-columns: ${old};`), false, old);
  });

  test('(+) the name cell is a container and the role tag swaps to its short word below 270 px, never clipped; the name keeps a floor of 9ch and the tag never shrinks', () => {
    const css = APPCSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.c-name \{[^}]*container: cname \/ inline-size;[^}]*\}/);
    assert.match(css, /\.c-name \.tag \{ flex: none; \}/);
    const block = /@container cname \(max-width: 269px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    assert.match(block, /\.c-name \.tag \.tag-l \{[^}]*position: absolute;[^}]*clip: rect\(0 0 0 0\)[^}]*\}/, 'the long word stays for screen readers');
    assert.match(block, /\.c-name \.tag \.tag-s \{ display: inline; \}/);
    assert.match(css, /\.name \{[^}]*min-width: 9ch;[^}]*text-overflow: ellipsis;[^}]*\}/);
    assert.match(css, /\.tree-orphan \{[^}]*flex: 0 20 auto;[^}]*text-overflow: ellipsis;[^}]*\}/, 'the orphan mark gives way before the name');
  });

  test('(+) the what cell: the chips give way before the text, an attention row keeps its text whole (14ch at least), the branch chip drops out below 189 px', () => {
    const css = APPCSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.c-what \{[^}]*container: cwhat \/ inline-size;[^}]*\}/);
    assert.match(css, /\.row\[data-s="attn"\] \.what \{ flex: none; max-width: max\(14ch, 60%\); \}/, 'the attention text never shrinks');
    assert.match(css, /\.proj-chip \{ flex: none;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;[^}]*\}/);
    assert.match(css, /\.row\[data-s="attn"\] \.proj-chip \{ flex: 0 100 auto; \}/, 'on a row that needs you the project chip may shrink');
    assert.match(css, /\.row\[data-s="attn"\] \.proj-chip \+ \.proj-chip \{ flex-shrink: 300; \}/, 'the "under <parent>" chip gives way before the project name');
    assert.match(css, /\.branch \{ flex: 0 100 auto; min-width: 10ch; max-width: 22ch;[^}]*text-overflow: ellipsis;[^}]*\}/, 'the branch chip keeps a floor, then ellipsis');
    assert.match(css, /@container cwhat \(max-width: 188px\) \{ \.branch, \.proj-chip \+ \.proj-chip \{ display: none; \} \}/);
  });

  test('(−) the branch chip no longer shrinks at the text\'s rate (it left the attention text 38 px), and the project chip shrinks only on a row that needs you', () => {
    const css = APPCSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/^\.proj-chip \{ flex: 0 100 auto;/m.test(css), false, 'the project chip keeps its size on every row but one that needs you');
    assert.equal(css.includes('.branch { flex: 0 1 auto;'), false);
  });

  test('(+) session.css: the header meter lays out inline, and the label is muted', () => {
    assert.match(SESSCSS, /\.sess-meta \.ctx \{ display: inline-flex; align-items: center; gap: 6px; \}/);
    assert.match(SESSCSS, /\.sess-meta \.ctx-l \{ color: var\(--text-muted\); \}/);
  });
});
