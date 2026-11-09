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
const OFF_LINE = "Off. Sessions nika starts keep Claude Code's own setting.";
const LINE_80_400K = 'Compacts at about 320k tokens (about 160k on 200k-window models).';

// ---- the page code in a vm ---------------------------------------------------------------------------------------------------------

function runModule(file, ctx, tail) {
  const src = code(read(file)).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(`${src}\n${tail}`, ctx);
}

function rig({ compaction = DEFAULT, put = { status: 200 }, hold = false } = {}) {
  const base = {
    ui: { theme: 'system', singleKeyShortcuts: true }, models: { orchestrator: 'opus', reasoner: 'opus', builder: 'claude-sonnet-5-5', scout: 'haiku' },
    remoteControl: { enabled: false, prefix: '' }, permissionMode: 'default', panePlacement: 'beside', limits: { maxAgents: 3 },
    rules: { localTemplate: null }, perProject: {}, compaction,
  };
  const radios = {
    theme: ['system', 'light', 'dark'].map((v) => Object.assign(new El('input'), { value: v })),
    perm: ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'].map((v) => Object.assign(new El('input'), { value: v })),
    place: ['beside', 'under-last'].map((v) => Object.assign(new El('input'), { value: v })),
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
  };
  const form = node('#set-form');
  const pct = node('#set-compact-pct');
  Object.assign(pct, { min: '20', max: '95' });
  Object.assign(node('#set-max'), { min: '1', max: '8' });
  node('#set-bar').hidden = true;
  node('#set-sum').hidden = true;
  node('#set-compact-err').hidden = true;
  node('#set-compact-result').hidden = false;
  for (const n of [pct, node('#set-max')]) n.dispatchEvent = (e) => form.fire(e.type, { target: n });
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
  const $ = (sel) => {
    const m = /^input\[name="(\w+)"\]:checked$/.exec(sel);
    if (m) return radios[m[1]].find((r) => r.checked) ?? null;
    return node(sel);
  };
  const $$ = (sel) => {
    const m = /^input\[name="(\w+)"\]$/.exec(sel);
    if (m) return radios[m[1]];
    if (sel === '[data-step]') return Object.values(buttons);
    if (sel === '[data-step-for="set-compact-pct"]') return [buttons.compactDec, buttons.compactInc];
    return [];
  };
  const ctx = {
    h, icon, $, $$, state, hooks, CUSTOM, MODEL_ID, MODEL_HINT, fillModelSelect, compactPreview, JSON, Number, Promise, Object, Array, Set, Math, String,
    Event: class { constructor(type) { this.type = type; } },
    RX: {}, toast: (msg) => toasts.push(msg), announce: (m) => announced.push(m), errText: (r) => r?.body?.message ?? 'x',
    fieldError: (input, msg) => input.setAttribute('aria-invalid', msg ? 'true' : 'false'), syncRadioCards: () => {}, applyTheme: () => {}, render: () => {},
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
    node, buttons, calls, toasts, announced, state, form, pct, release,
    sw: node('#set-compact'),
    win: node('#set-compact-win'),
    st: node('#set-compact-st'),
    result: node('#set-compact-result'),
    err: node('#set-compact-err'),
    bar: () => node('#set-bar'),
    enter: async () => { await hooks.enterSettings(); },
    type: (v) => { pct.value = v; form.fire('input'); },
    blur: () => pct.fire('blur'),
    toggle: (on) => { r.sw.checked = on; form.fire('change'); },
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
    assert.match(sec, /<button type="button" class="btn" data-fk="compact-dec" data-step="-5" data-step-for="set-compact-pct" aria-label="5 percent less">−<\/button>/);
    assert.match(sec, /<button type="button" class="btn" data-fk="compact-inc" data-step="5" data-step-for="set-compact-pct" aria-label="5 percent more">\+<\/button>/);
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
    assert.match(sec, /<p class="help" id="set-compact-help">Applies only to sessions nika starts: the orchestrator, a resumed orchestrator and spawned agents, from their next start\. Running sessions and sessions you start yourself keep Claude Code's own setting\. Compact in the session window works at any time\.<\/p>/);
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
    assert.match(HTML, /<button type="button" class="btn" data-step="-1" aria-label="One fewer">−<\/button><input type="number" id="set-max" min="1" max="8"/);
    assert.match(HTML, /<button type="button" class="btn" data-step="1" aria-label="One more">\+<\/button>/);
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
      assert.deepEqual(Object.keys(put.json).sort(), ['compaction', 'limits', 'models', 'panePlacement', 'permissionMode', 'remoteControl', 'rules', 'ui']);
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
