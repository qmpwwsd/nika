// 0.4, O4: the Auto-compact section of Settings (design 0.4 section 5; public/settings.js, index.html, app.css). The browser is exercised by
// hand; here the real settings.js runs in a vm against the small fake DOM (test/fake-dom.js) and recorded requests. The copy strings are
// written out here from design 5 on purpose: the tests must not read them back from the code under test. The pure parts (compactPreview,
// fmtTokens) are tested in test/ctx.test.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, focus } from './fake-dom.js';
import { h, icon } from '../public/dom.js';
import { CUSTOM, MODEL_ID, MODEL_HINT, fillModelSelect } from '../public/models-ui.js';
import { compactPreview } from '../public/ctx.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const HTML = read('index.html');
const APP_CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const plain = (v) => JSON.parse(JSON.stringify(v)); // values built inside a vm have another realm's prototypes
const settle = () => new Promise((r) => setImmediate(r));

let restore;
before(() => { restore = installDom(); });
after(() => restore());

const DEFAULT = { enabled: true, pct: 80, window: 400000 };
const ERR = 'Choose a whole number from 20 to 95.';
const OFF_LINE = "Off. nika sets nothing and types no /compact; Claude Code's own setting applies."; // 0.5.4 AC, test 39
const LINE_80_400K = 'Compacts at about 320k tokens (about 160k on 200k-window models).';

// ---- the page code in a vm ---------------------------------------------------------------------------------------------------------

function runModule(file, ctx, tail) {
  const src = code(read(file)).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(`${src}\n${tail}`, ctx);
}

function rig({ compaction = DEFAULT, attachments, put = { status: 200 }, hold = false, fit = { mode: 'auto' } } = {}) {
  const base = {
    ui: { theme: 'system', singleKeyShortcuts: true }, models: { orchestrator: 'opus', reasoner: 'opus', builder: 'claude-sonnet-5-5', scout: 'haiku' },
    remoteControl: { enabled: false, prefix: '' }, permissionMode: 'default', panePlacement: 'beside', limits: { maxAgents: 3 },
    rules: { localTemplate: null }, perProject: {}, compaction, ...(attachments ? { attachments } : {}), ...(fit ? { fit } : {}), // an older server sends no attachments group, and (before 0.5.4) no fit group
  };
  const radios = {
    theme: ['system', 'light', 'dark'].map((v) => Object.assign(new El('input'), { value: v })),
    perm: ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'].map((v) => Object.assign(new El('input'), { value: v })),
    place: ['beside', 'under-last'].map((v) => Object.assign(new El('input'), { value: v })),
    fit: ['auto', 'fill', 'terminal', 'off'].map((v) => Object.assign(new El('input'), { value: v })), // 0.5.4 P2
  };
  const nodes = new Map();
  // a real input's value is always a string, whatever was assigned to it
  const strValue = (n) => {
    let v = '';
    Object.defineProperty(n, 'value', { get: () => v, set: (x) => { v = String(x); }, enumerable: true, configurable: true });
    return n;
  };
  const kinds = { '#set-tpl': 'select', '#set-compact-win': 'select', '#set-compact-st': 'span' };
  const node = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, strValue(new El(kinds[sel] ?? (sel.startsWith('#set-model') && !sel.endsWith('-custom') ? 'select' : 'input'))));
    return nodes.get(sel);
  };
  const step = (n, forId, delta, extra = {}) => Object.assign(new El('button'), { attrs: { 'data-step': String(delta), ...(forId ? { 'data-step-for': forId } : {}), ...extra } });
  const buttons = {
    compactDec: step(null, 'set-compact-pct', -5, { 'data-fk': 'compact-dec' }),
    compactInc: step(null, 'set-compact-pct', 5, { 'data-fk': 'compact-inc' }),
    maxDec: step(null, null, -1),
    maxInc: step(null, null, 1),
    keepDec: step(null, 'set-keep-days', -1),
    keepInc: step(null, 'set-keep-days', 1),
  };
  const form = node('#set-form');
  const pct = node('#set-compact-pct');
  Object.assign(pct, { min: '20', max: '95' });
  Object.assign(node('#set-max'), { min: '1', max: '8' });
  const keepTag = /<input\b[^>]*\bid="set-keep-days"[^>]*>/.exec(HTML)?.[0] ?? ''; // the number's limits are the page's own
  Object.assign(node('#set-keep-days'), { min: /\bmin="([^"]*)"/.exec(keepTag)?.[1], max: /\bmax="([^"]*)"/.exec(keepTag)?.[1] });
  node('#set-bar').hidden = true;
  node('#set-sum').hidden = true;
  node('#set-compact-err').hidden = true;
  node('#set-compact-result').hidden = false;
  for (const n of [pct, node('#set-max'), node('#set-keep-days')]) n.dispatchEvent = (e) => form.fire(e.type, { target: n });
  const calls = [];
  const toasts = [];
  const announced = [];
  const release = { fn: null };
  const state = {
    settings: base,
    models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'latest' }, { id: 'opus', label: 'Opus', group: 'alias' }, { id: 'haiku', label: 'Haiku', group: 'alias' }],
    projects: [],
  };
  const hooks = {};
  const rxFields = []; // the [data-rx] inputs on the page: none unless a test adds the Name prefix (see breakField)
  const RX = {};
  const $ = (sel) => {
    const m = /^input\[name="(\w+)"\]:checked$/.exec(sel);
    if (m) return radios[m[1]].find((r) => r.checked) ?? null;
    return node(sel);
  };
  const $$ = (sel) => {
    const m = /^input\[name="(\w+)"\]$/.exec(sel);
    if (m) return radios[m[1]];
    if (sel === '[data-step]') return Object.values(buttons);
    if (sel === '[aria-invalid="true"]') return [...nodes.values()].filter((n) => n.attrs['aria-invalid'] === 'true');
    if (sel === '[data-step-for="set-compact-pct"]') return [buttons.compactDec, buttons.compactInc];
    if (sel === '[data-rx]') return rxFields;
    return [];
  };
  const ctx = {
    h, icon, $, $$, state, hooks, CUSTOM, MODEL_ID, MODEL_HINT, fillModelSelect, compactPreview, JSON, Number, Promise, Object, Array, Set, Math, String,
    Event: class { constructor(type) { this.type = type; } },
    RX, toast: (msg) => toasts.push(msg), announce: (m) => announced.push(m), errText: (r) => r?.body?.message ?? 'x',
    fieldError: (input, msg) => { input.setAttribute('aria-invalid', msg ? 'true' : 'false'); input.errMsg = msg; }, syncRadioCards: () => {}, applyTheme: () => {}, render: () => {},
    setBusy: (b, on, label) => { b.disabled = on; b.busy = on ? label : null; },
    loadSettings: async () => ({ status: 200 }), loadModels: async () => ({ status: 200 }),
    appFetch: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ method, url, json: opts.json === undefined ? undefined : plain(opts.json) });
      if (method === 'GET' && url === '/api/app/templates') return { status: 200, body: { templates: [] } };
      if (method === 'PUT' && url === '/api/app/settings') {
        if (hold) await new Promise((r) => { release.fn = r; });
        return { status: put.status, body: put.body ?? { ...state.settings, ...opts.json } };
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  };
  runModule('settings.js', ctx, '({ hooks })');
  const r = {
    node, buttons, calls, toasts, announced, state, form, pct, release, rxFields, RX, radios,
    keep: node('#set-keep-days'),
    sw: node('#set-compact'),
    win: node('#set-compact-win'),
    st: node('#set-compact-st'),
    result: node('#set-compact-result'),
    err: node('#set-compact-err'),
    bar: () => node('#set-bar'),
    enter: async () => { await hooks.enterSettings(); },
    type: (v) => { pct.value = v; form.fire('input'); },
    typeKeep: (v) => { r.keep.value = v; form.fire('input'); },
    blur: () => pct.fire('blur'),
    toggle: (on) => { r.sw.checked = on; form.fire('change'); },
    pickFit: (v) => { for (const x of radios.fit) x.checked = x.value === v; form.fire('change'); }, // 0.5.4 P2
    pick: (v) => { r.win.value = v; form.fire('change'); },
    submit: () => form.fire('submit'),
    line: () => (r.result.hidden ? null : r.result.textContent),
    chip: () => ({ on: r.st.attrs['data-on'], text: r.st.textContent, icon: r.st.all((n) => n.tag === 'use')[0]?.attrs.href }),
    puts: () => calls.filter((c) => c.method === 'PUT'),
  };
  return r;
}

// ---- the markup --------------------------------------------------------------------------------------------------------------------

describe('index.html: the Auto-compact section', () => {
  const sec = /<section class="set-sec" id="s-compact"[\s\S]*?<\/section>/.exec(HTML)?.[0];
  const tagOf = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(sec)?.[0];

  test('(+) the section sits right after Models and before Remote Control; the index links in the same order', () => {
    assert.ok(sec, 's-compact exists');
    const at = (s) => HTML.indexOf(s);
    assert.ok(at('id="s-models"') < at('id="s-compact"') && at('id="s-compact"') < at('id="s-rc"'));
    assert.match(HTML, /data-jump="s-models">Models<\/a><a href="#settings" data-jump="s-compact">Auto-compact<\/a><a href="#settings" data-jump="s-rc">/);
    assert.match(sec, /<section class="set-sec" id="s-compact" aria-labelledby="s-compact-h">/);
    assert.match(sec, /<h2 id="s-compact-h">Auto-compact<\/h2>\s*<p>Compacts a session's conversation before it gets too long\.<\/p>/);
  });

  test('(+) the switch: a checkbox with role=switch, the .switch look, its data-fk, described by the result and the scope line, and a label that keeps the visible words', () => {
    const t = tagOf('set-compact');
    assert.match(t, /type="checkbox"/);
    assert.match(t, /role="switch"/);
    assert.match(t, /class="switch"/);
    assert.match(t, /data-fk="compact-on"/);
    assert.match(t, /aria-describedby="set-compact-result set-compact-help"/);
    assert.match(sec, /<label for="set-compact">Auto-compact at<\/label>/);
    assert.match(sec, /<div class="inline compact-row">/);
  });

  test('(+) the stepper: minus and plus step 5 for #set-compact-pct, the number is 20 to 95 with its name and descriptions', () => {
    assert.match(sec, /<button type="button" class="btn" data-fk="compact-dec" data-step="-5" data-step-for="set-compact-pct" aria-label="5 percent less" title="5 percent less">−<\/button>/);
    assert.match(sec, /<button type="button" class="btn" data-fk="compact-inc" data-step="5" data-step-for="set-compact-pct" aria-label="5 percent more" title="5 percent more">\+<\/button>/);
    const t = tagOf('set-compact-pct');
    assert.match(t, /type="number"/);
    assert.match(t, /min="20"/);
    assert.match(t, /max="95"/);
    assert.match(t, /data-fk="compact-pct"/);
    assert.match(t, /aria-label="Auto-compact at, percent of the window"/);
    assert.match(t, /aria-describedby="set-compact-result set-compact-cap set-compact-err"/);
    assert.match(sec, /<span class="stepper">/);
    assert.match(sec, /<span aria-hidden="true">% of<\/span>/);
  });

  test('(+) the window select has the four options in order, a name and the result line as its description', () => {
    const t = tagOf('set-compact-win');
    assert.match(t, /data-fk="compact-win"/);
    assert.match(t, /aria-label="Window the percent applies to"/);
    assert.match(t, /aria-describedby="set-compact-result"/);
    const opts = [...sec.matchAll(/<option value="([^"]+)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(opts, [['200000', '200k'], ['400000', '400k'], ['1000000', '1M'], ['model', "Model's full window"]]);
  });

  test('(+) the chip is hidden from screen readers; the three help lines and the error carry the design\'s copy', () => {
    assert.match(sec, /<span class="onoff-st" id="set-compact-st" aria-hidden="true"><\/span>/);
    assert.match(sec, /<p class="help" id="set-compact-result"><\/p>/);
    assert.match(sec, /<p class="help" id="set-compact-cap">On a model with a 200k window, Claude can't compact later than about 83 %, so a higher % acts as about 83 % on those models\.<\/p>/);
    assert.match(sec, /<p class="help" id="set-compact-help">Sessions nika starts get this point from their next start\. In any other Claude session nika shows, nika types \/compact when the session has waited 60 seconds past this point and you have not typed in nika for it: once each time it grows past the point, at most every 10 minutes\. nika can't type into a session in a plain terminal or another tmux server, types nothing while only the browser dashboard runs, and can't compact a session that keeps working: Claude does that itself, or nika at its next wait\. Compact in the session window works at any time\.<\/p>/); // 0.5.4 AC, test 39 (design 7.4)
    assert.match(sec, /<p class="err" id="set-compact-err" hidden><\/p>/);
  });

  test('(+) the sprite has i-compact and i-compact-off once each; no id is duplicated page-wide; no inline style or handler in the section', () => {
    for (const id of ['i-compact', 'i-compact-off']) assert.equal(HTML.split(`<symbol id="${id}"`).length - 1, 1, id);
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ['s-compact', 'set-compact', 'set-compact-pct', 'set-compact-win', 'set-compact-result', 'set-compact-cap', 'set-compact-help', 'set-compact-err', 'set-compact-st']) assert.ok(ids.includes(id), id);
    assert.doesNotMatch(sec, /\sstyle\s*=|\son[a-z]+\s*=|innerHTML/i);
  });

  test('(+) the max-agents stepper keeps its default target: no data-step-for, so it steps #set-max by 1', () => {
    assert.match(HTML, /<button type="button" class="btn" data-step="-1" aria-label="One fewer" title="One fewer">−<\/button><input type="number" id="set-max" min="1" max="8"/);
    assert.match(HTML, /<button type="button" class="btn" data-step="1" aria-label="One more" title="One more">\+<\/button>/);
  });

  test('(+) app.css: .compact-row wraps and its select is auto width; .onoff-st has an On look (accent) and a dashed Off look (muted)', () => {
    assert.match(APP_CSS, /\.compact-row \{[^}]*flex-wrap: wrap/);
    assert.match(APP_CSS, /\.compact-row select \{[^}]*width: auto/);
    assert.match(APP_CSS, /\.onoff-st \{[^}]*display: inline-flex/);
    assert.match(APP_CSS, /\.onoff-st\[data-on="true"\] \{[^}]*color: var\(--accent\)[^}]*background: var\(--accent-soft\)/);
    assert.match(APP_CSS, /\.onoff-st\[data-on="false"\] \{[^}]*color: var\(--text-muted\)[^}]*dashed var\(--line-strong\)/);
    assert.match(APP_CSS, /\.onoff-st \.ic \{[^}]*width: 14px/);
  });
});

// ---- the page code -----------------------------------------------------------------------------------------------------------------

describe('Auto-compact: filling the form from the saved setting', () => {
  test('(+) the default: switch on, 80, 400k, the 320k line, the On chip; the Save bar is hidden', async () => {
    const s = rig();
    await s.enter();
    assert.deepEqual([s.sw.checked, s.pct.value, s.win.value], [true, '80', '400000']);
    assert.equal(s.line(), LINE_80_400K);
    assert.deepEqual(s.chip(), { on: 'true', text: 'On', icon: '#i-compact' });
    assert.equal(s.bar().hidden, true);
    assert.equal(s.pct.disabled, false);
  });

  test('(+) every saved window comes back in the select, and the line follows it', async () => {
    for (const [window, value, line] of [
      [200000, '200000', 'Compacts at about 160k tokens.'],
      [400000, '400000', LINE_80_400K],
      [1000000, '1000000', 'Compacts at about 800k tokens on 1M-window models (about 160k on 200k-window models).'],
      ['model', 'model', "Compacts at 80 % of each model's window: about 800k tokens on 1M-window models, about 160k on 200k-window models."],
    ]) {
      const s = rig({ compaction: { enabled: true, pct: 80, window } });
      await s.enter();
      assert.equal(s.win.value, value);
      assert.equal(s.line(), line);
    }
  });

  test('(+) a saved Off: the switch is off, the chip says Off, the number and window keep their values but are disabled, the line says Off', async () => {
    const s = rig({ compaction: { enabled: false, pct: 65, window: 1000000 } });
    await s.enter();
    assert.equal(s.sw.checked, false);
    assert.deepEqual(s.chip(), { on: 'false', text: 'Off', icon: '#i-compact-off' });
    assert.deepEqual([s.pct.value, s.win.value], ['65', '1000000']);
    assert.deepEqual([s.pct.disabled, s.win.disabled, s.buttons.compactDec.disabled, s.buttons.compactInc.disabled], [true, true, true, true]);
    assert.equal(s.line(), OFF_LINE);
    assert.equal(s.bar().hidden, true);
  });

  test('(−) a server that sends no compaction group (an older one) still opens the form with the defaults and shows no unsaved changes', async () => {
    const s = rig();
    delete s.state.settings.compaction;
    await s.enter();
    assert.deepEqual([s.sw.checked, s.pct.value, s.win.value], [true, '80', '400000']);
    assert.equal(s.bar().hidden, true);
  });
});

describe('Auto-compact: the switch', () => {
  test('(+) off then on: chip word, icon and colour attribute change together; the controls disable and enable; the values stay', async () => {
    const s = rig();
    await s.enter();
    s.toggle(false);
    assert.deepEqual(s.chip(), { on: 'false', text: 'Off', icon: '#i-compact-off' });
    assert.deepEqual([s.pct.disabled, s.win.disabled, s.buttons.compactDec.disabled, s.buttons.compactInc.disabled], [true, true, true, true]);
    assert.deepEqual([s.pct.value, s.win.value], ['80', '400000']);
    assert.equal(s.line(), OFF_LINE);
    s.toggle(true);
    assert.deepEqual(s.chip(), { on: 'true', text: 'On', icon: '#i-compact' });
    assert.deepEqual([s.pct.disabled, s.win.disabled, s.buttons.compactDec.disabled, s.buttons.compactInc.disabled], [false, false, false, false]);
    assert.equal(s.line(), LINE_80_400K);
  });

  test('(+) the chip text goes in as text nodes through h(): its icon is aria-hidden and the word is a span', async () => {
    const s = rig();
    await s.enter();
    const svg = s.st.all((n) => n.tag === 'svg')[0];
    assert.equal(svg.attrs['aria-hidden'], 'true');
    assert.deepEqual(s.st.kids.map((k) => k.tag), ['svg', 'span']);
  });

  test('(−) the max-agents stepper does not touch the Auto-compact controls, and turning the switch off leaves the other controls enabled', async () => {
    const s = rig();
    await s.enter();
    s.toggle(false);
    assert.equal(s.node('#set-max').disabled, false);
    assert.equal(s.buttons.maxDec.disabled, false);
    assert.equal(s.buttons.maxInc.disabled, false);
  });

  test('(+) turning it off while the number is invalid puts back the saved number and clears the error and the invalid mark', async () => {
    const s = rig({ compaction: { enabled: true, pct: 70, window: 400000 } });
    await s.enter();
    s.type('19');
    s.blur();
    assert.equal(s.err.hidden, false);
    s.toggle(false);
    assert.equal(s.pct.value, '70');
    assert.deepEqual([s.err.hidden, s.err.textContent, s.pct.attrs['aria-invalid']], [true, '', 'false']);
    assert.equal(s.bar().hidden, false, 'the switch itself is a change');
    s.toggle(true);
    assert.equal(s.pct.value, '70');
    assert.equal(s.bar().hidden, true, 'back on with the saved number is no change');
  });

  test('(−) turning it off with a valid typed number keeps that number (not the saved one)', async () => {
    const s = rig();
    await s.enter();
    s.type('55');
    s.toggle(false);
    assert.equal(s.pct.value, '55');
  });
});

describe('Auto-compact: the stepper', () => {
  test('(+) plus and minus move by 5, and a typed in-between value steps from where it is', async () => {
    const s = rig();
    await s.enter();
    s.buttons.compactInc.click();
    assert.equal(s.pct.value, '85');
    s.buttons.compactDec.click();
    s.buttons.compactDec.click();
    assert.equal(s.pct.value, '75');
    s.type('62');
    s.buttons.compactInc.click();
    assert.equal(s.pct.value, '67');
    assert.equal(s.line(), 'Compacts at about 268k tokens (about 134k on 200k-window models).');
  });

  test('(+) a step clamps to the input\'s own min and max: 20 stays 20 going down, 95 stays 95 going up, 93 plus 5 is 95, 22 minus 5 is 20', async () => {
    const s = rig({ compaction: { enabled: true, pct: 20, window: 400000 } });
    await s.enter();
    s.buttons.compactDec.click();
    assert.equal(s.pct.value, '20');
    s.type('22');
    s.buttons.compactDec.click();
    assert.equal(s.pct.value, '20');
    s.type('95');
    s.buttons.compactInc.click();
    assert.equal(s.pct.value, '95');
    s.type('93');
    s.buttons.compactInc.click();
    assert.equal(s.pct.value, '95');
  });

  test('(+) a step fires the input event so the Save bar and the line follow; stepping back to the saved number hides the bar again', async () => {
    const s = rig();
    await s.enter();
    s.buttons.compactInc.click();
    assert.equal(s.bar().hidden, false);
    assert.equal(s.line(), 'Compacts at about 340k tokens (about 167k on 200k-window models).');
    s.buttons.compactDec.click();
    assert.equal(s.bar().hidden, true);
  });

  test('(−) a blank or non-numeric number steps from the minimum, a fraction rounds; the error of the old value goes once the value is valid', async () => {
    const s = rig();
    await s.enter();
    s.type('');
    s.blur();
    assert.equal(s.err.hidden, false);
    s.buttons.compactInc.click();
    assert.equal(s.pct.value, '25');
    assert.equal(s.err.hidden, true);
    s.type('80.4');
    s.buttons.compactInc.click();
    assert.equal(s.pct.value, '85');
  });

  test('(+) the max-agents stepper still steps #set-max by 1 within 1 to 8 (the default target, the input\'s min and max)', async () => {
    const s = rig();
    await s.enter();
    s.buttons.maxInc.click();
    assert.equal(s.node('#set-max').value, '4');
    s.node('#set-max').value = '8';
    s.buttons.maxInc.click();
    assert.equal(s.node('#set-max').value, '8');
    s.node('#set-max').value = '1';
    s.buttons.maxDec.click();
    assert.equal(s.node('#set-max').value, '1');
    s.node('#set-max').value = '';
    s.buttons.maxInc.click();
    assert.equal(s.node('#set-max').value, '2');
    assert.equal(s.pct.value, '80', 'the other stepper is untouched');
  });
});

describe('Auto-compact: the result line redraws on every input and change of the three controls', () => {
  test('(+) number, window and switch each redraw it', async () => {
    const s = rig();
    await s.enter();
    s.type('90');
    assert.equal(s.line(), 'Compacts at about 360k tokens (about 167k on 200k-window models).');
    s.pick('1000000');
    assert.equal(s.line(), 'Compacts at about 900k tokens on 1M-window models (about 167k on 200k-window models).');
    s.pick('200000');
    assert.equal(s.line(), 'Compacts at about 167k tokens.');
    s.pick('model');
    assert.equal(s.line(), "Compacts at 90 % of each model's window: about 900k tokens on 1M-window models, about 167k on 200k-window models.");
    s.toggle(false);
    assert.equal(s.line(), OFF_LINE);
    s.toggle(true);
    assert.equal(s.line().startsWith('Compacts at 90 %'), true);
  });

  test('(+) the line is text content only', async () => {
    const s = rig();
    await s.enter();
    assert.equal(s.result.kids.length, 0);
    assert.equal(typeof s.result.textContent, 'string');
  });

  test('(−) an invalid number hides the line at once (no error yet) and the error shows on blur; a valid number brings both back', async () => {
    const s = rig();
    await s.enter();
    for (const bad of ['', '19', '96', '80.5', 'x']) {
      s.type('64'); // a valid number first: it clears the error the previous round left
      s.type(bad);
      assert.equal(s.line(), null, `"${bad}" hides the line`);
      assert.equal(s.err.hidden, true, `"${bad}" shows no error while typing`);
      s.blur();
      assert.deepEqual([s.err.hidden, s.err.textContent, s.pct.attrs['aria-invalid']], [false, ERR, 'true'], bad);
    }
    s.type('64');
    assert.deepEqual([s.err.hidden, s.pct.attrs['aria-invalid']], [true, 'false'], 'a valid value clears the error as it is typed');
    assert.equal(s.line(), 'Compacts at about 256k tokens (about 128k on 200k-window models).');
  });
});

describe('Auto-compact: the error copy and when it shows', () => {
  test('(+) the exact copy; 20 and 95 and every whole number between are accepted on blur', async () => {
    const s = rig();
    await s.enter();
    for (const ok of ['20', '95', '57', ' 64 ']) {
      s.type(ok);
      s.blur();
      assert.equal(s.err.hidden, true, ok);
    }
    s.type('96');
    s.blur();
    assert.equal(s.err.textContent, 'Choose a whole number from 20 to 95.');
    assert.equal(s.err.hidden, false);
  });

  test('(−) Off skips the check: a blur or a save with the switch off never shows the error', async () => {
    const s = rig({ compaction: { enabled: false, pct: 65, window: 400000 } });
    await s.enter();
    s.blur();
    assert.equal(s.err.hidden, true);
    s.toggle(true);
    s.type('10');
    s.toggle(false);
    s.blur();
    assert.equal(s.err.hidden, true);
    assert.equal(s.pct.value, '65');
  });
});

describe('Auto-compact: Save', () => {
  test('(+) the PUT carries compaction as { enabled, pct: a number, window: a number or "model" } next to the other groups', async () => {
    for (const [value, window] of [['200000', 200000], ['400000', 400000], ['1000000', 1000000], ['model', 'model']]) {
      const s = rig();
      await s.enter();
      s.type('90');
      s.pick(value);
      s.submit();
      await settle();
      const [put] = s.puts();
      assert.deepEqual(put.json.compaction, { enabled: true, pct: 90, window }, value);
      assert.equal(typeof put.json.compaction.pct, 'number');
      assert.deepEqual(Object.keys(put.json).sort(), ['attachments', 'compaction', 'fit', 'limits', 'models', 'panePlacement', 'permissionMode', 'remoteControl', 'rules', 'ui']); // 0.5.4 P2: fit is one more group
    }
  });

  test('(+) Off is saved as enabled: false with the kept number and window', async () => {
    const s = rig({ compaction: { enabled: true, pct: 72, window: 1000000 } });
    await s.enter();
    s.toggle(false);
    s.submit();
    await settle();
    assert.deepEqual(s.puts()[0].json.compaction, { enabled: false, pct: 72, window: 1000000 });
  });

  test('(+) after a 200 the saved state is the new snapshot: the toast shows, the bar hides, focus goes to the heading, the chip and line follow the answer', async () => {
    const s = rig({ hold: true });
    await s.enter();
    s.type('85');
    s.pick('1000000');
    s.submit();
    await settle();
    assert.equal(s.node('#set-save').busy, 'Saving…');
    s.release.fn();
    await settle();
    assert.deepEqual(s.toasts, ['Settings saved']);
    assert.equal(s.bar().hidden, true);
    assert.equal(focus.el, s.node('#set-h'));
    assert.deepEqual([s.pct.value, s.win.value], ['85', '1000000']);
    assert.equal(s.line(), 'Compacts at about 850k tokens on 1M-window models (about 167k on 200k-window models).');
    s.type('85');
    assert.equal(s.bar().hidden, true);
  });

  test('(−) an invalid number blocks the save: nothing is sent, the error and the summary show, the number gets the focus', async () => {
    for (const bad of ['', '19', '96', '80.5']) {
      const s = rig();
      await s.enter();
      s.type(bad);
      s.submit();
      await settle();
      assert.deepEqual(s.puts(), [], bad);
      assert.deepEqual([s.err.hidden, s.err.textContent, s.pct.attrs['aria-invalid']], [false, ERR, 'true'], bad);
      assert.equal(s.node('#set-sum').hidden, false);
      assert.equal(s.node('#set-sum-text').textContent, '1 field needs a fix before saving. Each one is marked below.');
      assert.equal(focus.el, s.pct);
      assert.equal(s.bar().hidden, false);
    }
  });

  test('(−) the same invalid number with the switch off is not a problem: the save goes out with the number put back', async () => {
    const s = rig({ compaction: { enabled: true, pct: 70, window: 400000 } });
    await s.enter();
    s.type('19');
    s.toggle(false);
    s.submit();
    await settle();
    assert.deepEqual(s.puts()[0].json.compaction, { enabled: false, pct: 70, window: 400000 });
  });

  test('(−) a refused save keeps the bar and the edit, shows the server\'s message in the summary and sends nothing twice', async () => {
    const s = rig({ put: { status: 400, body: { message: 'compaction.pct invalid, default used' } } });
    await s.enter();
    s.type('90');
    s.submit();
    await settle();
    assert.equal(s.bar().hidden, false);
    assert.equal(s.pct.value, '90');
    assert.equal(s.node('#set-sum-text').textContent, 'compaction.pct invalid, default used');
    assert.equal(s.puts().length, 1);
  });
});

describe('Auto-compact: the Save bar shows only after a real change', () => {
  test('(+) each of the three controls is a change, and changing it back hides the bar again', async () => {
    const s = rig();
    await s.enter();
    s.type('85');
    assert.equal(s.bar().hidden, false);
    assert.deepEqual(s.announced, ['Unsaved changes. Save or discard them at the bottom.']);
    s.type('80');
    assert.equal(s.bar().hidden, true);
    s.pick('model');
    assert.equal(s.bar().hidden, false);
    s.pick('400000');
    assert.equal(s.bar().hidden, true);
    s.toggle(false);
    assert.equal(s.bar().hidden, false);
    s.toggle(true);
    assert.equal(s.bar().hidden, true);
  });

  test('(−) typing the saved number, or the number with spaces around it, is no change', async () => {
    const s = rig();
    await s.enter();
    s.type('80');
    s.type(' 80 ');
    s.pick('400000');
    assert.equal(s.bar().hidden, true);
    assert.deepEqual(s.announced, []);
  });

  test('(+) Discard puts the saved Auto-compact values back, re-enables the controls and clears the error', async () => {
    const s = rig();
    await s.enter();
    s.toggle(false);
    s.toggle(true);
    s.type('19');
    s.blur();
    s.pick('model');
    s.node('#set-discard').click();
    assert.deepEqual([s.sw.checked, s.pct.value, s.win.value], [true, '80', '400000']);
    assert.deepEqual([s.err.hidden, s.pct.attrs['aria-invalid']], [true, 'false']);
    assert.equal(s.line(), LINE_80_400K);
    assert.equal(s.bar().hidden, true);
  });
});

describe('settings.js source checks for Auto-compact', () => {
  const src = code(read('settings.js'));

  test('(+) values reach the page only through textContent / h(): no innerHTML, no insertAdjacentHTML, no inline style', () => {
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|\.style\b|setAttribute\('style'/);
    assert.match(src, /from '\.\/ctx\.js'/);
  });

  test('(+) the stepper takes its target from data-step-for (default set-max) and its limits from the input\'s min and max', () => {
    assert.match(src, /data-step-for/);
    assert.match(src, /set-max/);
    assert.doesNotMatch(src, /Math\.min\(8, Math\.max\(1,/, 'the old fixed 1 to 8 clamp is gone');
  });

  test('(+) the module is served: the server lists /ctx.js, and the file exports the two pure helpers', () => {
    assert.ok(read('../src/server.js').includes("'/ctx.js'"));
    assert.match(read('ctx.js'), /export function fmtTokens/);
    assert.match(read('ctx.js'), /export function compactPreview/);
  });
});

// ---- 0.5, W2-T4: "Keep attachments for N days" (attachments.keepDays, 1 to 30, default 7) ------------------------------------------

const KEEP_ERR = 'Choose a whole number from 1 to 30.';
const KEEP_HELP = 'nika keeps a copy of each file you attach in its own folder on this computer, never in your project, and deletes it after this many days. A change applies at the next cleanup.';

describe('index.html: the Attachments section', () => {
  const sec = /<section class="set-sec" id="s-attach"[\s\S]*?<\/section>/.exec(HTML)?.[0];
  const tagOf = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(sec)?.[0];

  test('(+) the section sits after Panes and limits and before Rules template; the index links in the same order', () => {
    assert.ok(sec, 's-attach exists');
    const at = (s) => HTML.indexOf(s);
    assert.ok(at('id="s-panes"') < at('id="s-attach"') && at('id="s-attach"') < at('id="s-tpl"'));
    // 0.5.4 P2 (requirement change): the Session window link sits between Panes and limits and Attachments (its own test follows below)
    assert.match(HTML, /data-jump="s-fit">Session window<\/a><a href="#settings" data-jump="s-attach">Attachments<\/a><a href="#settings" data-jump="s-tpl">Rules template<\/a>/);
    assert.match(sec, /<section class="set-sec" id="s-attach" aria-labelledby="s-attach-h">\s*<h2 id="s-attach-h">Attachments<\/h2>/);
  });

  test('(+) one row: the label, a stepper of 1 day, the number 1 to 30 with its descriptions, then the word days', () => {
    assert.match(sec, /<label for="set-keep-days">Keep attachments for<\/label>/);
    assert.match(sec, /<button type="button" class="btn" data-step="-1" data-step-for="set-keep-days" aria-label="1 day less" title="1 day less">−<\/button>/);
    assert.match(sec, /<button type="button" class="btn" data-step="1" data-step-for="set-keep-days" aria-label="1 day more" title="1 day more">\+<\/button>/);
    const t = tagOf('set-keep-days');
    assert.match(t, /type="number"/);
    assert.match(t, /min="1"/);
    assert.match(t, /max="30"/);
    assert.match(t, /aria-describedby="set-keep-days-help set-keep-days-err"/);
    assert.match(sec, /<span class="stepper">/);
    assert.match(sec, /<\/span>\s*<span>days<\/span>/);
  });

  test('(+) the help line carries the owner\'s copy; the error line is hidden and empty; no inline style or handler', () => {
    assert.match(sec, new RegExp(`<p class="help" id="set-keep-days-help">${KEEP_HELP.replace(/[.]/g, '\\.')}</p>`));
    assert.match(sec, /<p class="err" id="set-keep-days-err" hidden><\/p>/);
    assert.doesNotMatch(sec, /\sstyle\s*=|\son[a-z]+\s*=|innerHTML/i);
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ['s-attach', 's-attach-h', 'set-keep-days', 'set-keep-days-help', 'set-keep-days-err']) assert.ok(ids.includes(id), id);
  });
});

describe('Attachments: filling the form from the saved setting', () => {
  test('(+) no saved group (an older server): 7, and no unsaved changes', async () => {
    const s = rig();
    await s.enter();
    assert.equal(s.keep.value, '7');
    assert.equal(s.bar().hidden, true);
  });

  test('(+) a saved 12 comes back as 12 and is no change; 1 and 30 too', async () => {
    for (const keepDays of [12, 1, 30]) {
      const s = rig({ attachments: { keepDays } });
      await s.enter();
      assert.equal(s.keep.value, String(keepDays));
      assert.equal(s.bar().hidden, true, String(keepDays));
    }
  });

  test('(+) Discard puts the saved number back and clears its error', async () => {
    const s = rig({ attachments: { keepDays: 12 } });
    await s.enter();
    s.typeKeep('0');
    s.submit();
    await settle();
    assert.equal(s.keep.attrs['aria-invalid'], 'true');
    s.node('#set-discard').click();
    assert.deepEqual([s.keep.value, s.keep.attrs['aria-invalid'], s.keep.errMsg], ['12', 'false', '']);
    assert.equal(s.bar().hidden, true);
  });
});

describe('Attachments: Save', () => {
  test('(+) 1 and 30 and a value between go out as attachments.keepDays, a number, next to the other groups', async () => {
    for (const [typed, sent] of [['1', 1], ['30', 30], ['14', 14], [' 9 ', 9]]) {
      const s = rig();
      await s.enter();
      s.typeKeep(typed);
      assert.equal(s.bar().hidden, false, typed);
      s.submit();
      await settle();
      const [put] = s.puts();
      assert.deepEqual(put.json.attachments, { keepDays: sent }, typed);
      assert.equal(typeof put.json.attachments.keepDays, 'number');
      assert.equal(s.keep.attrs['aria-invalid'], 'false', typed);
    }
  });

  test('(−) 0, 31, 7.5, empty and text are refused: nothing is sent, the error and the summary show, the number gets the focus', async () => {
    for (const bad of ['0', '31', '7.5', '', 'x', '-3']) {
      const s = rig();
      await s.enter();
      s.typeKeep(bad);
      s.submit();
      await settle();
      assert.deepEqual(s.puts(), [], JSON.stringify(bad));
      assert.deepEqual([s.keep.attrs['aria-invalid'], s.keep.errMsg], ['true', KEEP_ERR], JSON.stringify(bad));
      assert.equal(s.node('#set-sum').hidden, false);
      assert.equal(s.node('#set-sum-text').textContent, '1 field needs a fix before saving. Each one is marked below.');
      assert.equal(focus.el, s.keep, JSON.stringify(bad));
      assert.equal(s.bar().hidden, false);
    }
  });

  test('(−) a bad number next to a bad Auto-compact number: both are marked, the first in the page (Auto-compact) gets the focus', async () => {
    const s = rig();
    await s.enter();
    focus.el = null;
    s.type('10');
    s.typeKeep('0');
    s.submit();
    await settle();
    assert.deepEqual(s.puts(), []);
    assert.equal(s.node('#set-sum-text').textContent, '2 fields need a fix before saving. Each one is marked below.');
    assert.deepEqual([s.pct.attrs['aria-invalid'], s.keep.attrs['aria-invalid']], ['true', 'true'], 'both are marked');
    assert.equal(focus.el, s.pct, 'the Auto-compact row comes before the Attachments row in the page, so it takes the focus');
  });

  test('(−) only the lower field (Attachments) is bad: it gets the focus, and the Auto-compact number is not marked', async () => {
    const s = rig();
    await s.enter();
    focus.el = null;
    s.typeKeep('0');
    s.submit();
    await settle();
    assert.equal(s.node('#set-sum-text').textContent, '1 field needs a fix before saving. Each one is marked below.');
    assert.equal(s.pct.attrs['aria-invalid'], 'false');
    assert.equal(focus.el, s.keep);
  });

  test('(−) a refused save keeps the bar and the edit and shows the server\'s message', async () => {
    const s = rig({ put: { status: 400, body: { message: 'attachments.keepDays invalid, default used' } } });
    await s.enter();
    s.typeKeep('20');
    s.submit();
    await settle();
    assert.equal(s.bar().hidden, false);
    assert.equal(s.keep.value, '20');
    assert.equal(s.node('#set-sum-text').textContent, 'attachments.keepDays invalid, default used');
    assert.equal(s.puts().length, 1);
  });

  test('(+) after a 200 the saved number is the new snapshot: the bar hides and typing it again is no change', async () => {
    const s = rig();
    await s.enter();
    s.typeKeep('20');
    s.submit();
    await settle();
    assert.deepEqual(s.puts().map((p) => p.json.attachments), [{ keepDays: 20 }]);
    assert.equal(s.bar().hidden, true);
    assert.equal(s.keep.value, '20');
    s.typeKeep('20');
    assert.equal(s.bar().hidden, true);
  });
});

describe('Attachments: the stepper', () => {
  test('(+) plus and minus move by 1; a step fires the input event so the Save bar follows, and stepping back hides it', async () => {
    const s = rig();
    await s.enter();
    s.buttons.keepInc.click();
    assert.equal(s.keep.value, '8');
    assert.equal(s.bar().hidden, false);
    s.buttons.keepDec.click();
    assert.equal(s.keep.value, '7');
    assert.equal(s.bar().hidden, true);
    assert.equal(s.pct.value, '80', 'the other steppers are untouched');
    assert.equal(s.node('#set-max').value, '3');
  });

  test('(+) a step clamps to 1 and 30: 1 stays 1 going down, 30 stays 30 going up', async () => {
    const s = rig({ attachments: { keepDays: 1 } });
    await s.enter();
    s.buttons.keepDec.click();
    assert.equal(s.keep.value, '1');
    s.typeKeep('30');
    s.buttons.keepInc.click();
    assert.equal(s.keep.value, '30');
    s.typeKeep('29');
    s.buttons.keepInc.click();
    assert.equal(s.keep.value, '30');
    s.typeKeep('2');
    s.buttons.keepDec.click();
    assert.equal(s.keep.value, '1');
  });

  test('(−) a blank or out-of-range number steps back into range: blank to 2, 99 to 30, 0 to 1', async () => {
    const s = rig();
    await s.enter();
    s.typeKeep('');
    s.buttons.keepInc.click();
    assert.equal(s.keep.value, '2');
    s.typeKeep('99');
    s.buttons.keepDec.click();
    assert.equal(s.keep.value, '30');
    s.typeKeep('0');
    s.buttons.keepDec.click();
    assert.equal(s.keep.value, '1');
  });
});

describe('settings.js source checks for Attachments', () => {
  const src = code(read('settings.js'));

  test('(+) the number is read, validated and saved as attachments.keepDays, 1 to 30, through the same fieldError as the other numbers', () => {
    assert.match(src, /attachments: \{ keepDays: Number\(\$\('#set-keep-days'\)\.value\) \}/);
    assert.match(src, /s\.attachments\?\.keepDays \?\? 7/);
    assert.match(src, /Choose a whole number from 1 to 30\./);
  });
});

// ---- R2 #4 (final review): Save checks the fields in the order of the page and focuses the first bad one ----------------------------

// How a test makes each checked field invalid, in the order the fields appear in index.html (the 'page order' test below pins that order).
// The Name prefix is a [data-rx] input that the rig does not have by default, so it is added here with its own rule (written out, not read back).
const BREAK = {
  model: (s) => {
    const sel = s.node('#set-model-orchestrator');
    sel.value = CUSTOM;
    const custom = s.node('#set-model-orchestrator-custom');
    custom.hidden = false;
    custom.value = 'not an id!';
    s.form.fire('input');
    return custom;
  },
  compact: (s) => { s.type('10'); return s.pct; },
  prefix: (s) => {
    const p = s.node('#set-rc-prefix');
    Object.assign(p, { disabled: false, value: 'Bad Name' });
    p.attrs['data-rx'] = 'prefix';
    s.RX.prefix = [/^(?:[a-z0-9][a-z0-9-]{0,19})?$/, 'Lowercase letters, digits and dashes.'];
    s.rxFields.push(p);
    s.form.fire('input');
    return p;
  },
  max: (s) => {
    const m = s.node('#set-max');
    m.value = '9';
    s.form.fire('input');
    return m;
  },
  keep: (s) => { s.typeKeep('0'); return s.keep; },
};
const PAGE_ORDER = ['model', 'compact', 'prefix', 'max', 'keep'];

describe('Settings: Save focuses the first invalid field in the page', () => {
  test('(+) the checks run in the order of index.html: Models, Auto-compact, Name prefix, Agents per orchestrator, Keep attachments for', () => {
    const at = (id) => HTML.indexOf(`id="${id}"`);
    const ids = ['set-model-orchestrator-custom', 'set-model-scout-custom', 'set-compact-pct', 'set-rc-prefix', 'set-max', 'set-keep-days'];
    for (const id of ids) assert.ok(at(id) > 0, `${id} is on the page`);
    assert.deepEqual([...ids].sort((a, b) => at(a) - at(b)), ids, 'the ids appear in this order in index.html');
  });

  for (const which of PAGE_ORDER) {
    test(`(+) only the ${which} field is bad: it is marked, nothing is sent and it gets the focus`, async () => {
      const s = rig();
      await s.enter();
      focus.el = null;
      const field = BREAK[which](s);
      s.submit();
      await settle();
      assert.deepEqual(s.puts(), []);
      assert.equal(field.attrs['aria-invalid'], 'true');
      assert.equal(s.node('#set-sum-text').textContent, '1 field needs a fix before saving. Each one is marked below.');
      assert.equal(focus.el, field);
    });
  }

  for (let i = 0; i < PAGE_ORDER.length; i++) {
    for (let j = i + 1; j < PAGE_ORDER.length; j++) {
      const [first, second] = [PAGE_ORDER[i], PAGE_ORDER[j]];
      test(`(−) ${first} and ${second} are both bad: both are marked, the ${first} field (higher in the page) gets the focus`, async () => {
        const s = rig();
        await s.enter();
        focus.el = null;
        // break the lower field first, so the order of the edits cannot be what decides
        const lower = BREAK[second](s);
        const upper = BREAK[first](s);
        s.submit();
        await settle();
        assert.deepEqual(s.puts(), []);
        assert.equal(s.node('#set-sum-text').textContent, '2 fields need a fix before saving. Each one is marked below.');
        assert.deepEqual([upper.attrs['aria-invalid'], lower.attrs['aria-invalid']], ['true', 'true']);
        assert.equal(focus.el, upper);
      });
    }
  }
});

// ---- 0.5.4 P2 (design-052d 2.2): the Session window section of Settings: the Fit mode (M-23, M-24) ------------------------------------
// The copy is written out here from the design on purpose (the tests must not read it back from the page).
const FIT_MODES_LIST = ['auto', 'fill', 'terminal', 'off'];
const FIT_CARDS = [
  ['auto', 'fit', 'Auto', 'Fills the panel when it can. When your terminal shows the same tmux window, the window you click into gets the size.'],
  ['fill', 'fit-pin', 'Always fill the panel', 'Sizes the tmux window to the panel while a session window is open, also while you work in your terminal. Your terminal shows dots around it, and other panes in that window shrink.'],
  ['terminal', 'term-pin', "Your terminal's size", "Never resizes a tmux window. nika zooms Claude's pane when the window has others and scales the text to the panel."],
  ['off', 'fit-off', 'Off', 'nika changes nothing in tmux. The session window shows the pane at its own size, with the text scaled down when it is larger than the panel.'],
];
const FIT_HELP = 'Open session windows follow a change within 5 seconds. When a session window closes, nika puts back what it changed in tmux.';

describe('index.html: the Session window section (0.5.4 P2, M-23)', () => {
  const sec = /<section class="set-sec" id="s-fit"[\s\S]*?<\/section>/.exec(HTML)?.[0];
  const SESSION_HTML = read('session.html');
  const symbolOf = (src, n) => new RegExp(`<symbol id="i-${n}" viewBox="0 0 16 16">([\\s\\S]*?)</symbol>`).exec(src)?.[1] ?? null;

  test('(+) the section sits right after Panes and limits and before Attachments; the index links in the same order', () => {
    assert.ok(sec, 's-fit exists');
    const at = (s) => HTML.indexOf(s);
    assert.ok(at('id="s-panes"') < at('id="s-fit"') && at('id="s-fit"') < at('id="s-attach"'));
    assert.match(HTML, /data-jump="s-panes">Panes and limits<\/a><a href="#settings" data-jump="s-fit">Session window<\/a><a href="#settings" data-jump="s-attach">Attachments<\/a>/);
    assert.match(sec, /<section class="set-sec" id="s-fit" aria-labelledby="s-fit-h">\s*<h2 id="s-fit-h">Session window<\/h2>\s*<p>How a session window fits Claude's pane to its panel\. For every project\.<\/p>/);
  });

  test('(+) a fieldset with a visible legend, described by the help, holds the four radios named fit, in the order of the modes', () => {
    assert.match(sec, /<fieldset aria-describedby="set-fit-help"><legend>Fit Claude's pane<\/legend>/);
    assert.deepEqual([...sec.matchAll(/<input type="radio" name="fit" value="([a-z]+)">/g)].map((m) => m[1]), FIT_MODES_LIST);
    assert.equal([...sec.matchAll(/<input\b/g)].length, 4, 'nothing else to fill in');
  });

  test('(+) each card is a radio-card with its own icon (hidden from screen readers), its own title and its own words', () => {
    const cards = [...sec.matchAll(/<label class="radio-card">([\s\S]*?)<\/label>/g)].map((m) => m[1]);
    assert.equal(cards.length, 4);
    FIT_CARDS.forEach(([value, icon, title, words], i) => {
      assert.equal(cards[i], `<input type="radio" name="fit" value="${value}"><span><b><svg class="ic" aria-hidden="true"><use href="#i-${icon}"/></svg> ${title}</b><span>${words}</span></span>`, value);
    });
    assert.equal(new Set(FIT_CARDS.map((c) => c[1])).size, 4, 'four icons');
    assert.equal(new Set(FIT_CARDS.map((c) => c[2])).size, 4, 'four titles');
  });

  test('(+) the help sits under the group with the id the fieldset names; it is a help line, not an error', () => {
    assert.match(sec, new RegExp(`<p class="help" id="set-fit-help">${FIT_HELP.replace(/[.]/g, '\\.')}</p>`));
    assert.equal([...HTML.matchAll(/\bid="set-fit-help"/g)].length, 1);
  });

  test('(+) the sprite of index.html has i-fit, i-fit-pin, i-term-pin and i-fit-off once each, in the stroke style, and they are the drawings session.html has', () => {
    const names = ['fit', 'fit-pin', 'term-pin', 'fit-off'];
    const drawn = names.map((n) => {
      assert.equal(HTML.split(`<symbol id="i-${n}"`).length - 1, 1, n);
      const body = symbolOf(HTML, n);
      assert.ok(body, n);
      assert.doesNotMatch(body, /\b(fill|stroke|style)=/, n);
      assert.equal(body, symbolOf(SESSION_HTML, n), `${n}: one drawing on both pages`);
      return body;
    });
    assert.equal(new Set(drawn).size, 4, 'four different drawings');
  });

  // ---- 0.5.4 SF (N-4, live check LC-P2): the pin dot of i-fit-pin and i-term-pin is its own dot, with a clear gap to the bracket or the frame ----
  /** The segments (x1, y1, x2, y2) of an SVG path of M m H h V v L l commands, and of a rect (its four sides, corners taken sharp: the safe side for a dot inside). */
  const segmentsOf = (body) => {
    const segs = [];
    for (const m of body.matchAll(/<rect\b[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/g)) {
      const [x, y, w, h] = m.slice(1).map(Number);
      segs.push([x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]);
    }
    for (const m of body.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)) {
      let x = 0;
      let y = 0;
      let sx = 0;
      let sy = 0;
      for (const [, cmd, args] of m[1].matchAll(/([MmHhVvLl])([^MmHhVvLl]*)/g)) {
        const n = (args.match(/-?\d*\.?\d+/g) ?? []).map(Number);
        const rel = cmd === cmd.toLowerCase();
        const up = cmd.toUpperCase();
        if (up === 'H') for (const v of n) { const nx = rel ? x + v : v; segs.push([x, y, nx, y]); x = nx; }
        else if (up === 'V') for (const v of n) { const ny = rel ? y + v : v; segs.push([x, y, x, ny]); y = ny; }
        else for (let i = 0; i + 1 < n.length; i += 2) {
          const nx = rel ? x + n[i] : n[i];
          const ny = rel ? y + n[i + 1] : n[i + 1];
          if (up === 'M' && i === 0) { sx = nx; sy = ny; } else segs.push([x, y, nx, ny]);
          x = nx;
          y = ny;
        }
      }
      void sx; void sy;
    }
    return segs;
  };
  const distToSegment = (px, py, [x1, y1, x2, y2]) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  const STROKE = Number(/\.ic\s*\{[^}]*stroke-width:\s*([\d.]+)/.exec(read('app.css'))[1]);
  const dotOf = (body) => {
    const m = /<circle\b[^>]*\bcx="([\d.]+)"[^>]*\bcy="([\d.]+)"[^>]*\br="([\d.]*)"/.exec(body);
    return m && { cx: Number(m[1]), cy: Number(m[2]), r: Number(m[3]), R: Number(m[3]) + STROKE / 2 };
  };

  for (const [where, src] of [['index.html', () => HTML], ['session.html', () => SESSION_HTML]]) {
    for (const n of ['fit-pin', 'term-pin']) {
      test(`(+) N-4 (${where}, i-${n}): the dot is a filled circle of radius 0.75 to 1.25 (a stroke of ${STROKE} drawing it), at least viewBox width / 14 = 1.143 away from every other stroke, and inside the viewBox`, () => {
        const body = symbolOf(src(), n);
        const dot = dotOf(body);
        assert.ok(dot, 'a dot');
        assert.ok(dot.R >= 0.75 && dot.R <= 1.25, `visual radius ${dot.R}`);
        assert.ok(dot.r - STROKE / 2 <= 0, 'a stroke wider than the circle: no hole in the middle, a filled dot');
        const others = segmentsOf(body);
        assert.ok(others.length >= 4, 'the bracket or the frame is there');
        const gap = Math.min(...others.map((seg) => distToSegment(dot.cx, dot.cy, seg))) - STROKE / 2 - dot.R;
        assert.ok(gap >= 16 / 14, `gap ${gap.toFixed(3)} (viewBox units) to the nearest stroke`);
        assert.ok(dot.cx - dot.R >= 1 && dot.cx + dot.R <= 15 && dot.cy - dot.R >= 1 && dot.cy + dot.R <= 15, 'inside the viewBox');
      });
    }
  }

  test('(\u2212) N-4: the geometry check catches the old dot (cx 12.5, cy 3.5, r .75: it overlaps the corner bracket) and a dot that is only 1 unit from the frame', () => {
    const oldFit = '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/><circle cx="12.5" cy="3.5" r=".75"/>';
    const oldDot = dotOf(oldFit);
    const gap = (body, dot) => Math.min(...segmentsOf(body).map((seg) => distToSegment(dot.cx, dot.cy, seg))) - STROKE / 2 - dot.R;
    assert.ok(gap(oldFit, oldDot) < 0, `the old dot overlaps: ${gap(oldFit, oldDot).toFixed(2)}`);
    const tight = '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5"/><circle cx="11.5" cy="5.5" r=".25"/>';
    assert.ok(gap(tight, dotOf(tight)) < 16 / 14, 'one unit from the frame is not enough');
  });

  test('(+) N-4: the pins are still their base icon plus the dot: the same bracket and frame on both pages', () => {
    for (const n of ['fit-pin', 'term-pin']) assert.equal(symbolOf(HTML, n), symbolOf(SESSION_HTML, n), n);
    for (const [pin, base] of [['fit-pin', 'fit'], ['term-pin', 'term']]) {
      const withoutDot = symbolOf(SESSION_HTML, pin).replace(/<circle\b[^>]*\/>/, '');
      assert.equal(withoutDot, symbolOf(SESSION_HTML, base), `${pin} minus its dot is ${base}`);
    }
  });

  // ---- 0.5.4 SF (N-5, live check LC-P2): the icon in a Settings card's title sits on the title's first line, not above it ----
  const APP_CSS = read('app.css');
  test('(+) N-5: the icon in a radio-card title is moved down 3px (13px text, 16px icon: its middle moves from 8px to 5px above the baseline, the middle of the capitals) by one rule that only touches that icon', () => {
    const rules = [...APP_CSS.matchAll(/(^|\})\s*([^{}]*\.radio-card b[^{}]*\.ic[^{}]*)\{([^}]*)\}/g)];
    assert.equal(rules.length, 1, 'one rule');
    assert.equal(rules[0][2].trim(), '.radio-card b .ic');
    assert.match(rules[0][3], /^\s*vertical-align:\s*-3px;\s*$/);
    for (const card of sec.match(/<label class="radio-card">[\s\S]*?<\/label>/g)) assert.match(card, /<b><svg class="ic" aria-hidden="true">/, 'the icon is inline in the title (the rule\'s b)');
  });

  test('(\u2212) N-5: no other icon moves: the base .ic rule has no vertical-align, and nothing else in app.css aligns an .ic inside a title', () => {
    const base = /^\.ic\s*\{([^}]*)\}/m.exec(APP_CSS);
    assert.ok(base, 'the base .ic rule');
    assert.doesNotMatch(base[1], /vertical-align/);
    assert.equal([...APP_CSS.matchAll(/vertical-align:\s*-3px/g)].length, 1, 'one such alignment');
  });

  test('(\u2212) the page keeps its ids unique, and the new section has no inline style, script or handler', () => {
    const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
    assert.doesNotMatch(sec, /\bstyle=|<script|\bon[a-z]+=/);
    assert.equal([...sec].every((ch) => ch.codePointAt(0) < 128), true, 'ASCII');
  });
});

describe('Session window: the Fit mode setting (M-23, M-24)', () => {
  const checked = (s) => s.radios.fit.filter((r) => r.checked).map((r) => r.value);

  test('(+) M-23 populate: each saved mode checks its own card and no other, and the Save bar stays hidden', async () => {
    for (const mode of FIT_MODES_LIST) {
      const s = rig({ fit: { mode } });
      await s.enter();
      assert.deepEqual(checked(s), [mode], mode);
      assert.equal(s.bar().hidden, true, mode);
    }
  });

  test('(+) M-24 populate: a saved config with no fit group (an older server) checks Auto, the Save bar stays hidden, and the first save carries fit: { mode: auto }', async () => {
    const s = rig({ fit: null });
    assert.equal('fit' in s.state.settings, false, 'the premise: no fit group');
    await s.enter();
    assert.deepEqual(checked(s), ['auto']);
    assert.equal(s.bar().hidden, true);
    s.type('90');
    s.submit();
    await settle();
    assert.deepEqual(s.puts()[0].json.fit, { mode: 'auto' });
  });

  test('(+) M-23 choosing a card shows the Save bar once, and Save sends exactly fit: { mode } next to the other groups, unchanged', async () => {
    const s = rig();
    await s.enter();
    s.pickFit('fill');
    assert.equal(s.bar().hidden, false);
    assert.deepEqual(s.announced, ['Unsaved changes. Save or discard them at the bottom.']);
    s.pickFit('terminal');
    assert.equal(s.announced.length, 1, 'said once, while the bar is up');
    s.submit();
    await settle();
    assert.equal(s.puts().length, 1);
    const [put] = s.puts();
    assert.deepEqual(put.json.fit, { mode: 'terminal' });
    assert.deepEqual(Object.keys(put.json.fit), ['mode']);
    assert.equal(put.json.panePlacement, 'beside');
    assert.deepEqual(put.json.limits, { maxAgents: 3 });
    assert.equal(s.bar().hidden, true, 'saved');
    assert.deepEqual(checked(s), ['terminal'], 'the saved card stays checked');
  });

  test('(+) M-23 each of the four modes can be saved, from each of the others', async () => {
    for (const from of FIT_MODES_LIST) {
      for (const to of FIT_MODES_LIST.filter((m) => m !== from)) {
        const s = rig({ fit: { mode: from } });
        await s.enter();
        s.pickFit(to);
        s.submit();
        await settle();
        assert.deepEqual(s.puts().map((p) => p.json.fit), [{ mode: to }], `${from} -> ${to}`);
      }
    }
  });

  test('(\u2212) M-23 choosing another card and then the saved one again hides the Save bar; nothing is sent, and Save does nothing', async () => {
    const s = rig({ fit: { mode: 'fill' } });
    await s.enter();
    s.pickFit('off');
    assert.equal(s.bar().hidden, false);
    s.pickFit('fill');
    assert.equal(s.bar().hidden, true);
    s.submit();
    await settle();
    assert.deepEqual(s.puts(), []);
  });

  test('(\u2212) M-23 Discard puts the saved card back and hides the bar', async () => {
    const s = rig({ fit: { mode: 'terminal' } });
    await s.enter();
    s.pickFit('off');
    assert.equal(s.bar().hidden, false);
    s.node('#set-discard').click();
    assert.deepEqual(checked(s), ['terminal']);
    assert.equal(s.bar().hidden, true);
  });

  test('(\u2212) M-23 a refused save keeps the chosen card and the bar, shows the server\'s message, and sends nothing twice', async () => {
    const s = rig({ put: { status: 400, body: { message: 'fit.mode invalid, default used' } } });
    await s.enter();
    s.pickFit('fill');
    s.submit();
    await settle();
    assert.deepEqual(checked(s), ['fill']);
    assert.equal(s.bar().hidden, false);
    assert.equal(s.node('#set-sum-text').textContent, 'fit.mode invalid, default used');
    assert.equal(s.puts().length, 1);
  });

  test('(\u2212) M-23 a change of another field alone leaves the fit group as saved', async () => {
    const s = rig({ fit: { mode: 'off' } });
    await s.enter();
    s.type('90');
    s.submit();
    await settle();
    assert.deepEqual(s.puts()[0].json.fit, { mode: 'off' });
  });

  test('(+) the code: formValue reads the group and populate sets it, with Auto when the saved config has none', () => {
    const src = code(read('settings.js'));
    assert.match(src, /fit: \{ mode: radio\('fit'\) \},/);
    assert.match(src, /setRadio\('fit', s\.fit\?\.mode \?\? 'auto'\);/);
  });
});

// ---- 0.5.4 AC, test 39: what the Settings text promises ---------------------------------------------------------------------------------------

describe('the Auto-compact help text says what the typed /compact does (0.5.4 AC, test 39)', () => {
  const help = /<p class="help" id="set-compact-help">([^<]*)<\/p>/.exec(HTML)?.[1] ?? '';

  test('(+) it names the 60 s wait, the user\'s own typing, the once-per-crossing and 10 minute rules and the three limits', () => {
    for (const part of ['nika types /compact when the session has waited 60 seconds past this point', 'you have not typed in nika for it', 'once each time it grows past the point',
      'at most every 10 minutes', "nika can't type into a session in a plain terminal or another tmux server", 'types nothing while only the browser dashboard runs',
      "can't compact a session that keeps working: Claude does that itself, or nika at its next wait", 'Compact in the session window works at any time.']) {
      assert.ok(help.includes(part), part);
    }
    assert.ok(help.startsWith('Sessions nika starts get this point from their next start.'));
  });

  test('(\u2212) the 0.4 sentences are gone: it no longer says it applies only to sessions nika starts, or that hand-started ones keep Claude Code\'s setting', () => {
    assert.equal(help.includes('Applies only to sessions nika starts'), false);
    assert.equal(help.includes('sessions you start yourself keep'), false);
  });

  test('(\u2212) it is plain text in an ASCII source, and the paragraph is still described-by the switch', () => {
    assert.equal([...help].every((ch) => ch.codePointAt(0) < 128), true);
    assert.match(HTML, /aria-describedby="set-compact-result set-compact-help"/);
  });
});
