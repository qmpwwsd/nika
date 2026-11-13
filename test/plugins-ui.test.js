// 0.3.4: the project page's "Project setup" card and "Choose plugins" dialog (public/project.js, index.html, app.css), and Settings
// holding defaults only (public/settings.js: no plugin section, Save bar only on a real change; app.js initKeys). The browser is
// exercised by hand; here the real page code runs in a vm against a small fake DOM and recorded requests. Plugin names are
// synthetic (`<name>@demo-market`). Design: 0.3.4 sections 1 to 3; docs/design/spec.md 3.15.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { h, icon } from '../public/dom.js';
import { spawnLimits } from '../public/dash-model.js';
import { pluginView, pluginSave, sortIds, countText, filterNote } from '../public/plugin-view.js';
import { fillModelSelect, CUSTOM, MODEL_ID, MODEL_HINT, ROLES, ROLE_LABEL, modelLabel, fillRoleOverride, effectiveRoleModels } from '../public/models-ui.js';
import { compactPreview } from '../public/ctx.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const HTML = read('index.html');
const APP_CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const plain = (v) => JSON.parse(JSON.stringify(v)); // values built inside a vm have another realm's prototypes

// ---- a small fake DOM: just what dom.js h()/icon() and the page code touch ------------------------------------------------

let focused = null;
class El {
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

  set textContent(v) { this.kids = []; this.own = String(v); }

  get textContent() { return this.own + this.kids.map((k) => k.textContent).join(''); }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }

  fire(type, extra = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }

  click() { if (!this.disabled) this.fire('click'); }

  focus() { focused = this; }

  showModal() { this.open = true; }

  close() { this.open = false; this.fire('close'); }

  /** Text as a screen reader builds a name from it: aria-hidden parts are left out. */
  get accName() {
    return this.attrs['aria-hidden'] === 'true' ? '' : this.own + this.kids.map((k) => k.accName).join('');
  }

  all(pred, out = []) {
    for (const k of this.kids) { if (pred(k)) out.push(k); k.all(pred, out); }
    return out;
  }
}
const withClass = (cls) => (n) => n.className.split(' ').includes(cls);
const rowsOf = (list) => list.all((n) => n.tag === 'label' && withClass('plug-row')(n));
const rowText = (row) => row.accName.replace(/\s+/g, ' ').trim();
const boxOf = (row) => row.all((n) => n.tag === 'input')[0];

let saved;
before(() => {
  saved = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = El;
  globalThis.document = { createElement: (tag) => new El(tag), createTextNode: (t) => new El('#text', t), createElementNS: (ns, tag) => new El(tag) };
});
after(() => {
  globalThis.document = saved.document;
  globalThis.Node = saved.Node;
});

/** Runs a whole page module in a vm: its import lines are dropped (the names come from `ctx`), `export` is dropped, `tail` returns what the test needs. */
function runModule(file, ctx, tail) {
  const src = code(read(file)).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(`${src}\n${tail}`, ctx);
}

const settle = () => new Promise((r) => setImmediate(r));
const KEY = '0123456789abcdef';
const PROJECT = { key: KEY, dir: '/work/demo-api', name: 'demo-api', rules: { state: 'nika' } };
const A = 'alpha-lint@demo-market';
const B = 'beta-fmt@demo-market';
const C = 'gamma-ci@other-market';
const D = 'delta@demo-market';
const GONE = 'lint-kit@demo-market';
const CFG_URL = `/api/app/projects/${KEY}/config`;

// ---- the project page: card and dialog -------------------------------------------------------------------------------------

/** The page module with fake nodes for the dialog's static markup and recorded requests. */
function projectRig({ installed = [A, B, C, D], savedList = [], pluginsStatus = 200, configStatus = 200, put = {}, throwOn = null, hold = false } = {}) {
  const cfg = { pluginsStatus, configStatus };
  const nodes = new Map();
  const kinds = { '#pl-filter': 'input', '#dlg-plugins': 'dialog', '#pl-save': 'button', '#pl-retry': 'button', '#pl-cancel': 'button', '#pl-x': 'button', '#pl-box': 'fieldset' };
  const node = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, new El(kinds[sel] ?? 'div'));
    return nodes.get(sel);
  };
  const calls = [];
  const timers = [];
  const toasts = [];
  const announced = [];
  const renders = [];
  const opened = [];
  const release = { fn: null };
  const state = { settings: { perProject: {}, limits: { maxAgents: 3 }, permissionMode: 'default', panePlacement: 'beside' }, plugins: null, route: { name: 'project', key: KEY } };
  const location = { hashSets: [], set hash(v) { this.hashSets.push(v); }, get hash() { return ''; } };
  const answer = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ method, url, json: opts.json === undefined ? undefined : plain(opts.json) });
    if (throwOn === `${method} ${url}`) throw new Error('down');
    if (method === 'GET' && url === '/api/app/plugins') return cfg.pluginsStatus === 200 ? { status: 200, body: { plugins: installed } } : { status: cfg.pluginsStatus, body: { message: 'nope' } };
    if (method === 'GET' && url === CFG_URL) return cfg.configStatus === 200 ? { status: 200, body: { plugins: savedList } } : { status: cfg.configStatus, body: { message: 'nope' } };
    if (method === 'PUT' && url === CFG_URL) {
      if (hold) await new Promise((r) => { release.fn = r; });
      return { status: put.status ?? 200, body: put.body ?? { plugins: opts.json.plugins } };
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  const ctx = {
    h, icon, $: node, state, hooks: {}, location,
    appFetch: answer,
    toast: (msg, o) => toasts.push({ msg, action: o?.action?.label, run: o?.action?.run }),
    announce: (m) => announced.push(m),
    errText: (r) => r?.body?.message ?? `The server answered ${r?.status}.`,
    setBusy: (b, on, label) => { b.disabled = on; b.busy = on ? label : null; if (on) b.attrs['aria-busy'] = 'true'; else delete b.attrs['aria-busy']; },
    openDialog: (dlg, o) => { opened.push(dlg); dlg.open = true; o?.focus?.focus(); },
    render: (force) => renders.push(force),
    setTimeout: (fn, ms) => { timers.push({ fn, ms, done: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].done = true; },
    pluginView, pluginSave, sortIds, countText, filterNote, spawnLimits,
    ROLES, ROLE_LABEL, modelLabel, fillRoleOverride, effectiveRoleModels,
    rulesEl: () => new El('span'),
  };
  const api = runModule('project.js', ctx, '({ openPlugins, plugSave, plugLoad, wirePlugins, setupCards, pl, rememberPlugins, loadInstalled })');
  api.wirePlugins();
  const dlg = node('#dlg-plugins');
  return {
    api, ctx, cfg, node, dlg, calls, timers, toasts, announced, renders, opened, state, location, release,
    list: () => node('#pl-list'),
    rows: () => rowsOf(node('#pl-list')),
    typeFilter: (text) => { const f = node('#pl-filter'); f.value = text; f.fire('input'); },
    open: async () => { api.openPlugins(PROJECT); await settle(); },
  };
}
const fkOf = (row) => boxOf(row).attrs['data-fk'];

describe('Choose plugins dialog: open', () => {
  test('(+) open loads the installed list and the project config together, orders ticked rows first (A to Z), then the rest, and focuses the filter', async () => {
    const r = projectRig({ savedList: [D, B] });
    r.api.openPlugins(PROJECT);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url}`).sort(), [`GET ${CFG_URL}`, 'GET /api/app/plugins'].sort(), 'both are asked at once, before either answers');
    assert.equal(r.node('#pl-h').textContent, 'Choose plugins for demo-api');
    assert.equal(r.node('#pl-save').disabled, true, 'Save is off while loading');
    assert.match(r.list().textContent, /Loading plugins…/);
    assert.equal(r.list().all(withClass('sk')).length, 6, 'six skeleton lines');
    await settle();
    assert.deepEqual(r.rows().map(fkOf), [`pl-row:${B}`, `pl-row:${D}`, `pl-row:${A}`, `pl-row:${C}`]);
    assert.deepEqual(r.rows().map((x) => boxOf(x).checked), [true, true, false, false]);
    assert.equal(r.node('#pl-count').textContent, '2 on · 4 installed');
    assert.equal(r.node('#pl-save').disabled, false);
    assert.equal(r.node('#pl-save').hidden, false);
    assert.equal(r.node('#pl-retry').hidden, true);
    assert.equal(focused, r.node('#pl-filter'));
    assert.equal(r.dlg.open, true);
    assert.deepEqual(r.state.plugins, [A, B, C, D], 'the card learns which plugins are installed');
  });

  test('(+) a row reads "<name> @<market>"; a ticked row is marked (data-on, the "on" word); an unticked one is not', async () => {
    const r = projectRig({ savedList: [B] });
    await r.open();
    const [first, second] = r.rows();
    assert.equal(rowText(first), 'beta-fmt @demo-market', 'the accessible name has no "on": the checkbox state says it');
    assert.equal(first.attrs['data-on'], 'true');
    assert.equal(boxOf(first).attrs.type, 'checkbox');
    assert.equal(rowText(second), 'alpha-lint @demo-market');
    assert.equal(second.attrs['data-on'], 'false');
    const chip = first.all(withClass('onoff'))[0];
    assert.equal(chip.attrs['aria-hidden'], 'true', 'not read twice: the checkbox already says it');
    assert.equal(chip.textContent, 'on');
    assert.equal(chip.hidden, false);
    assert.equal(second.all(withClass('onoff'))[0].hidden, true, 'an unticked row shows no "on"');
    boxOf(second).checked = true; boxOf(second).fire('change');
    assert.deepEqual([second.attrs['data-on'], second.all(withClass('onoff'))[0].hidden], ['true', false], 'ticking updates the row in place');
    boxOf(second).checked = false; boxOf(second).fire('change');
    assert.deepEqual([second.attrs['data-on'], second.all(withClass('onoff'))[0].hidden], ['false', true]);
  });

  test('(+) a saved plugin that is no longer installed is a ticked row marked "(not installed)" with the warning icon', async () => {
    const r = projectRig({ savedList: [GONE, A] });
    await r.open();
    const row = r.rows().find((x) => fkOf(x) === `pl-row:${GONE}`);
    assert.ok(row, 'the missing plugin has a row');
    assert.equal(boxOf(row).checked, true);
    assert.equal(rowText(row), 'lint-kit @demo-market (not installed)', 'the accessible name carries the warning');
    assert.ok(row.all((n) => n.tag === 'use' && n.attrs.href === '#i-warn').length === 1, 'warning icon');
    const ok = r.rows().find((x) => fkOf(x) === `pl-row:${A}`);
    assert.doesNotMatch(rowText(ok), /not installed/);
    assert.equal(r.node('#pl-count').textContent, '2 on · 4 installed');
  });
});

describe('Choose plugins dialog: Save', () => {
  test('(+) ticking rows and Save sends the ticked plugins sorted, then closes, remembers the list, redraws and offers Apply rules (no navigation)', async () => {
    const r = projectRig({ savedList: [B] });
    await r.open();
    for (const id of [D, A]) { // ticked in reverse order on purpose
      const row = r.rows().find((x) => fkOf(x) === `pl-row:${id}`);
      boxOf(row).checked = true;
      boxOf(row).fire('change');
    }
    assert.equal(r.node('#pl-count').textContent, '3 on · 4 installed');
    r.node('#pl-save').click();
    await settle();
    const puts = r.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0], { method: 'PUT', url: CFG_URL, json: { plugins: [A, B, D] } });
    assert.equal(r.dlg.open, false, 'closed');
    assert.deepEqual(plain(r.state.settings.perProject), { [KEY]: { plugins: [A, B, D] } });
    assert.deepEqual(r.renders, [true], 'the card is redrawn at once');
    assert.equal(r.toasts.length, 1);
    assert.equal(r.toasts[0].msg, 'Plugins saved for demo-api. Apply rules to write them.');
    assert.equal(r.toasts[0].action, 'Apply rules');
    assert.deepEqual(r.location.hashSets, [], 'the dialog never navigates');
  });

  test('(+) unticking everything sends [] and the list is forgotten (the entry is deleted, other keys of it stay)', async () => {
    const r = projectRig({ savedList: [A] });
    r.state.settings.perProject = { [KEY]: { plugins: [A], other: 1 }, fedcba9876543210: { plugins: [B] } };
    await r.open();
    boxOf(r.rows()[0]).checked = false;
    boxOf(r.rows()[0]).fire('change');
    r.node('#pl-save').click();
    await settle();
    assert.deepEqual(r.calls.filter((c) => c.method === 'PUT').map((c) => c.json), [{ plugins: [] }]);
    assert.deepEqual(plain(r.state.settings.perProject), { [KEY]: { other: 1 }, fedcba9876543210: { plugins: [B] } });
    const solo = projectRig({ savedList: [A] });
    solo.state.settings.perProject = { [KEY]: { plugins: [A] } };
    await solo.open();
    boxOf(solo.rows()[0]).checked = false;
    boxOf(solo.rows()[0]).fire('change');
    solo.node('#pl-save').click();
    await settle();
    assert.deepEqual(plain(solo.state.settings.perProject), {}, 'an entry with nothing left is deleted');
  });

  test('(+) Save with no change sends no request, closes the dialog and shows no toast', async () => {
    for (const savedList of [[], [B, A]]) {
      const r = projectRig({ savedList });
      r.state.settings.perProject = savedList.length ? { [KEY]: { plugins: savedList } } : {}; // the card already shows the saved list
      await r.open();
      r.node('#pl-save').click();
      await settle();
      assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), [], JSON.stringify(savedList));
      assert.equal(r.dlg.open, false);
      assert.deepEqual(r.toasts, []);
      assert.deepEqual(r.renders, []);
    }
  });

  test('(+) Save with no change still refreshes the card from the list the dialog loaded (it was changed outside this page)', async () => {
    const r = projectRig({ savedList: [B, A] });
    r.state.settings.perProject = { fedcba9876543210: { plugins: [D] } }; // the card knows nothing about this project's list
    await r.open();
    r.node('#pl-save').click();
    await settle();
    assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), [], 'still no request');
    assert.deepEqual(plain(r.state.settings.perProject), { fedcba9876543210: { plugins: [D] }, [KEY]: { plugins: [B, A] } });
    assert.deepEqual(r.renders, [true], 'the card is redrawn');
    assert.deepEqual(r.toasts, [], 'and nothing is announced');
    const gone = projectRig({ savedList: [] });
    gone.state.settings.perProject = { [KEY]: { plugins: [A], other: 1 } }; // the list was removed elsewhere
    await gone.open();
    gone.node('#pl-save').click();
    await settle();
    assert.deepEqual(plain(gone.state.settings.perProject), { [KEY]: { other: 1 } });
    assert.deepEqual(gone.renders, [true]);
  });

  test('(−) a failed load never touches the card: Cancel after a load error leaves the remembered list as it was', async () => {
    const r = projectRig({ savedList: [A], pluginsStatus: 500 });
    r.state.settings.perProject = { [KEY]: { plugins: [B] } };
    await r.open();
    r.node('#pl-cancel').click();
    await settle();
    assert.deepEqual(plain(r.state.settings.perProject), { [KEY]: { plugins: [B] } });
    assert.deepEqual(r.renders, []);
  });

  test('(+) tick then untick the same row is no change either: Save sends nothing', async () => {
    const r = projectRig({ savedList: [A] });
    await r.open();
    const row = r.rows().find((x) => fkOf(x) === `pl-row:${D}`);
    boxOf(row).checked = true; boxOf(row).fire('change');
    boxOf(row).checked = false; boxOf(row).fire('change');
    r.node('#pl-save').click();
    await settle();
    assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), []);
  });

  test('(+) saving a list that holds a plugin no longer installed keeps it unless it is unticked', async () => {
    const r = projectRig({ savedList: [GONE, A] });
    await r.open();
    const row = r.rows().find((x) => fkOf(x) === `pl-row:${D}`);
    boxOf(row).checked = true; boxOf(row).fire('change');
    r.node('#pl-save').click();
    await settle();
    assert.deepEqual(r.calls.filter((c) => c.method === 'PUT').map((c) => c.json.plugins), [[A, D, GONE]]);
  });

  test('(−) while saving every control is off (Save says "Saving…", Cancel, ×, the filter and the boxes), the dialog is busy and a second click sends nothing', async () => {
    const r = projectRig({ savedList: [], hold: true });
    await r.open();
    boxOf(r.rows()[0]).checked = true; boxOf(r.rows()[0]).fire('change');
    r.node('#pl-save').click();
    await settle();
    assert.equal(r.node('#pl-save').busy, 'Saving…');
    assert.equal(r.node('#pl-cancel').disabled, true);
    assert.equal(r.node('#pl-x').disabled, true);
    assert.equal(r.node('#pl-filter').disabled, true);
    assert.equal(r.node('#pl-box').disabled, true, 'the fieldset disables every box in it');
    assert.equal(r.dlg.attrs['data-busy'], '1');
    r.api.plugSave();
    await settle();
    assert.equal(r.calls.filter((c) => c.method === 'PUT').length, 1);
    r.release.fn();
    await settle();
    assert.equal(r.dlg.open, false);
    assert.equal(r.dlg.attrs['data-busy'], undefined);
    assert.equal(r.node('#pl-filter').disabled, false);
  });

  test('(−) a refused save keeps the ticks, shows the server text in the alert, takes focus there and leaves the dialog open', async () => {
    const r = projectRig({ savedList: [], put: { status: 400, body: { message: `${GONE} is not installed` } } });
    await r.open();
    boxOf(r.rows()[1]).checked = true; boxOf(r.rows()[1]).fire('change');
    r.node('#pl-save').click();
    await settle();
    assert.equal(r.dlg.open, true);
    assert.equal(r.node('#pl-alert').hidden, false);
    assert.equal(r.node('#pl-alert-text').textContent, `${GONE} is not installed`);
    assert.equal(focused, r.node('#pl-alert'));
    assert.equal(boxOf(r.rows()[1]).checked, true, 'the tick is still there');
    assert.equal(r.node('#pl-save').disabled, false, 'it can be tried again');
    assert.equal(r.node('#pl-box').disabled, false);
    assert.deepEqual(plain(r.state.settings.perProject), {}, 'nothing is remembered for a failed save');
    assert.deepEqual(r.toasts, []);
  });

  test('(−) a save that cannot reach the server says so in the alert', async () => {
    const r = projectRig({ savedList: [], throwOn: `PUT ${CFG_URL}` });
    await r.open();
    boxOf(r.rows()[0]).checked = true; boxOf(r.rows()[0]).fire('change');
    r.node('#pl-save').click();
    await settle();
    assert.equal(r.node('#pl-alert-text').textContent, 'Could not reach the nika server.');
    assert.equal(r.dlg.open, true);
  });

  test('(−) Save does nothing while the list is still loading or after a load error', async () => {
    const r = projectRig({ pluginsStatus: 500 });
    r.api.openPlugins(PROJECT);
    r.api.plugSave();
    await settle();
    r.api.plugSave();
    assert.deepEqual(r.calls.filter((c) => c.method === 'PUT'), []);
    assert.equal(r.dlg.open, true);
  });
});

describe('Choose plugins dialog: the filter', () => {
  test('(+) the filter hides rows but a hidden row keeps its tick, which Save still sends', async () => {
    const r = projectRig({ savedList: [A, B] });
    await r.open();
    r.typeFilter('delta');
    assert.deepEqual(r.rows().map(fkOf), [`pl-row:${D}`], 'only delta is drawn');
    assert.equal(r.node('#pl-count').textContent, 'Showing 1 of 4 · 2 on', 'the two hidden ticks still count');
    boxOf(r.rows()[0]).checked = true; boxOf(r.rows()[0]).fire('change');
    assert.equal(r.node('#pl-count').textContent, 'Showing 1 of 4 · 3 on');
    r.typeFilter('');
    assert.deepEqual(r.rows().filter((x) => boxOf(x).checked).map(fkOf).sort(), [A, B, D].map((id) => `pl-row:${id}`).sort(), 'the hidden rows came back ticked');
    r.node('#pl-save').click();
    await settle();
    assert.deepEqual(r.calls.filter((c) => c.method === 'PUT').map((c) => c.json.plugins), [[A, B, D]]);
  });

  test('(+) unticking a visible row while others are hidden leaves the hidden ticks in the payload', async () => {
    const r = projectRig({ savedList: [A, B] });
    await r.open();
    r.typeFilter('alpha');
    boxOf(r.rows()[0]).checked = false; boxOf(r.rows()[0]).fire('change');
    r.node('#pl-save').click();
    await settle();
    assert.deepEqual(r.calls.filter((c) => c.method === 'PUT').map((c) => c.json.plugins), [[B]]);
  });

  test('(+) rows keep the position they had at open when ticks change and the filter redraws them', async () => {
    const r = projectRig({ savedList: [B] });
    await r.open();
    const order = r.rows().map(fkOf);
    const row = r.rows().find((x) => fkOf(x) === `pl-row:${C}`);
    boxOf(row).checked = true; boxOf(row).fire('change');
    assert.deepEqual(r.rows().map(fkOf), order, 'ticking does not move the row');
    r.typeFilter('market');
    assert.deepEqual(r.rows().map(fkOf), order, 'the filter redraws in the same order');
    boxOf(r.rows()[0]).checked = false; boxOf(r.rows()[0]).fire('change');
    r.typeFilter('');
    assert.deepEqual(r.rows().map(fkOf), order, 'unticking the first row does not move it');
  });

  test('(+) a query is announced 400 ms after typing stopped: "<k> plugins shown", "1 plugin shown" or "No plugin matches"', async () => {
    const r = projectRig({});
    await r.open();
    r.typeFilter('d');
    r.typeFilter('de');
    r.typeFilter('delta');
    assert.deepEqual(r.announced, [], 'nothing is spoken while typing');
    const live = r.timers.filter((t) => !t.done);
    assert.equal(live.length, 1, 'earlier timers were cancelled');
    assert.equal(live[0].ms, 400);
    live[0].fn();
    assert.deepEqual(r.announced, ['1 plugin shown']);
    r.typeFilter('market');
    r.timers.filter((t) => !t.done).at(-1).fn();
    r.typeFilter('zzz');
    r.timers.filter((t) => !t.done).at(-1).fn();
    assert.deepEqual(r.announced, ['1 plugin shown', '4 plugins shown', 'No plugin matches']);
  });

  test('(−) no match: the text names the query, there is a "Clear filter" link-button that focuses the filter and brings the rows back; Save still works', async () => {
    const r = projectRig({ savedList: [A] });
    await r.open();
    r.typeFilter('zzz');
    assert.deepEqual(r.rows(), []);
    assert.match(r.list().textContent, /No plugin matches “zzz”\./);
    const clear = r.list().all((n) => n.tag === 'button')[0];
    assert.equal(clear.attrs['data-fk'], 'pl-clear');
    assert.equal(clear.textContent, 'Clear filter');
    assert.ok(withClass('link')(clear) && withClass('btn')(clear));
    clear.click();
    assert.equal(r.node('#pl-filter').value, '');
    assert.equal(focused, r.node('#pl-filter'));
    assert.equal(r.rows().length, 4);
    assert.equal(boxOf(r.rows()[0]).checked, true);
  });

  test('(−) the query text is shown as text, never as markup', async () => {
    const r = projectRig({});
    await r.open();
    r.typeFilter('<img src=x onerror=alert(1)>');
    assert.match(r.list().textContent, /No plugin matches “<img src=x onerror=alert\(1\)>”\./);
    assert.deepEqual(r.list().all((n) => n.tag === 'img'), []);
  });

  test('(+) Esc in a filter with text clears it and the dialog stays open; Esc in an empty filter is left to the dialog', async () => {
    const r = projectRig({});
    await r.open();
    r.typeFilter('delta');
    const f = r.node('#pl-filter');
    const esc = f.fire('keydown', { key: 'Escape' });
    assert.equal(esc.defaultPrevented, true);
    assert.equal(esc.stopped, true);
    assert.equal(f.value, '');
    assert.equal(r.rows().length, 4, 'all rows are back');
    const cancel = r.dlg.fire('cancel');
    assert.equal(cancel.defaultPrevented, true, 'a platform that still sends cancel for that Esc does not close the dialog');
    r.timers.filter((t) => !t.done && t.ms === 0).forEach((t) => t.fn());
    const second = f.fire('keydown', { key: 'Escape' });
    assert.equal(second.defaultPrevented, false);
    assert.equal(r.dlg.fire('cancel').defaultPrevented, false, 'the next Esc closes the dialog');
    assert.equal(f.fire('keydown', { key: 'a' }).defaultPrevented, false);
  });
});

describe('Choose plugins dialog: other states', () => {
  test('(−) a failed load shows the alert, Cancel and Retry (no Save, no filter); Retry loads again and the list appears', async () => {
    const r = projectRig({ pluginsStatus: 500 });
    await r.open();
    assert.equal(r.node('#pl-alert').hidden, false);
    assert.equal(r.node('#pl-alert-text').textContent, 'The plugin list could not be loaded. Check that nika is still running, then try again.');
    assert.equal(focused, r.node('#pl-alert'));
    assert.equal(r.node('#pl-retry').hidden, false);
    assert.equal(r.node('#pl-retry').disabled, false);
    assert.equal(r.node('#pl-save').hidden, true);
    assert.equal(r.node('#pl-save').disabled, true, 'hidden and off, so Mod+Enter cannot reach it');
    assert.equal(r.node('#pl-search').hidden, true);
    assert.equal(r.node('#pl-cancel').textContent, 'Cancel');
    assert.deepEqual(r.rows(), []);
    r.cfg.pluginsStatus = 200; // nika is back
    r.node('#pl-retry').click();
    assert.equal(r.node('#pl-retry').hidden, true, 'loading again');
    assert.match(r.list().textContent, /Loading plugins…/);
    await settle();
    assert.equal(r.rows().length, 4);
    assert.equal(r.node('#pl-alert').hidden, true);
    assert.equal(r.node('#pl-retry').hidden, true);
    assert.equal(r.node('#pl-save').hidden, false);
    assert.equal(r.node('#pl-save').disabled, false);
    assert.equal(r.node('#pl-search').hidden, false);
    assert.equal(focused, r.node('#pl-filter'), 'focus does not stay on the hidden Retry button');
  });

  test('(−) a failed config load, or a network failure, is the same load error', async () => {
    for (const rig of [projectRig({ configStatus: 404 }), projectRig({ throwOn: 'GET /api/app/plugins' }), projectRig({ throwOn: `GET ${CFG_URL}` })]) {
      await rig.open();
      assert.equal(rig.node('#pl-alert').hidden, false);
      assert.equal(rig.node('#pl-retry').hidden, false);
      assert.deepEqual(rig.rows(), []);
    }
  });

  test('(−) nothing installed and nothing ticked: the empty text and its help, no filter, Close only', async () => {
    const r = projectRig({ installed: [], savedList: [] });
    await r.open();
    assert.match(r.list().textContent, /No plugins are installed in Claude Code\./);
    assert.match(r.list().textContent, /Install plugins with Claude Code, then open this again\./);
    assert.equal(r.node('#pl-search').hidden, true);
    assert.equal(r.node('#pl-save').hidden, true);
    assert.equal(r.node('#pl-save').disabled, true);
    assert.equal(r.node('#pl-retry').hidden, true);
    assert.equal(r.node('#pl-cancel').textContent, 'Close');
    assert.equal(r.node('#pl-help').hidden, true);
    assert.equal(r.node('#pl-count').textContent, '');
  });

  test('(−) installed plugins list empty but a saved one exists: its row is shown, so the dialog is not empty', async () => {
    const r = projectRig({ installed: [], savedList: [GONE] });
    await r.open();
    assert.equal(r.rows().length, 1);
    assert.equal(r.node('#pl-search').hidden, false);
    assert.equal(r.node('#pl-count').textContent, '1 on · 0 installed');
  });

  test('(−) closing the dialog while the lists are loading drops the late answer, and reopening starts clean', async () => {
    const r = projectRig({ savedList: [A] });
    r.api.openPlugins(PROJECT);
    r.dlg.open = false;
    await settle();
    assert.deepEqual(r.rows(), [], 'nothing is drawn for a closed dialog');
    r.typeFilter('x');
    await r.open();
    assert.equal(r.node('#pl-filter').value, '', 'the filter starts empty');
    assert.equal(r.rows().length, 4);
  });

  test('(+) a ready dialog shows Cancel and Save; Cancel and × are plain data-close buttons that discard silently', async () => {
    const r = projectRig({ savedList: [] });
    await r.open();
    boxOf(r.rows()[0]).checked = true; boxOf(r.rows()[0]).fire('change');
    assert.equal(r.node('#pl-cancel').textContent, 'Cancel');
    assert.equal(r.node('#pl-cancel').hidden, false);
    assert.equal(r.calls.filter((c) => c.method === 'PUT').length, 0);
    assert.deepEqual(r.toasts, []);
  });
});

describe('Project setup card', () => {
  const cardOf = (rig, picked = [], plugins = null) => {
    rig.state.settings.perProject = picked.length ? { [KEY]: { plugins: picked } } : {};
    rig.state.plugins = plugins;
    return rig.api.setupCards(PROJECT, { project: PROJECT, agents: [] });
  };
  const setup = (cards) => cards[1];

  test('(+) the second card is "Project setup" (replacing "Plugins") with the scope note, the Settings link and the Plugins block', () => {
    const cards = cardOf(projectRig({}), [B, A], [A, B]);
    assert.deepEqual([...cards].map((c) => c.all((n) => n.tag === 'h2')[0].textContent), ['Rules', 'Project setup', 'New agents']);
    const card = setup(cards);
    const help = card.all(withClass('help'));
    assert.equal(help[0].textContent, 'Applies to this project only. Defaults are in Settings.');
    const links = card.all((n) => n.tag === 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].attrs.href, '#settings');
    assert.equal(links[0].textContent, 'Settings');
    assert.equal(card.all((n) => n.tag === 'h3')[0].textContent, 'Plugins 2 on');
    assert.ok(card.all((n) => n.tag === 'p' && n.textContent === 'Written into .claude/settings.local.json when you apply rules.').length === 1);
  });

  test('(+) chips are A to Z, at most 8, then "+N more"; each chip is the plugin id as text', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${String.fromCharCode(106 - i)}@demo-market`); // pj … pa
    const card = setup(cardOf(projectRig({}), ids, ids));
    const chips = card.all(withClass('chip'));
    assert.deepEqual(chips.map((c) => c.textContent), sortIds(ids).slice(0, 8));
    assert.equal(card.all((n) => n.attrs['data-fk'] === 'setup-more')[0].textContent, '+4 more');
    assert.equal(card.all((n) => n.attrs['data-fk'] === 'setup-chips').length, 1);
    assert.equal(card.all((n) => n.tag === 'h3')[0].textContent, 'Plugins 12 on');
    const eight = setup(cardOf(projectRig({}), ids.slice(0, 8), ids));
    assert.equal(eight.all((n) => n.attrs['data-fk'] === 'setup-more').length, 0, 'exactly 8 chips need no "more"');
  });

  test('(+) a saved plugin that is not installed is a dashed chip with the warning icon and "(not installed)"', () => {
    const card = setup(cardOf(projectRig({}), [A, GONE], [A, B]));
    const chips = card.all(withClass('chip'));
    const missing = chips.filter(withClass('missing'));
    assert.equal(missing.length, 1);
    assert.equal(missing[0].accName.replace(/\s+/g, ' ').trim(), 'lint-kit@demo-market (not installed)');
    assert.equal(missing[0].all((n) => n.tag === 'use' && n.attrs.href === '#i-warn').length, 1);
    assert.equal(chips.filter((c) => !withClass('missing')(c)).length, 1);
  });

  test('(−) without the installed list (not loaded yet or it failed) no chip is flagged', () => {
    const card = setup(cardOf(projectRig({}), [A, GONE], null));
    assert.equal(card.all(withClass('missing')).length, 0);
  });

  test('(−) no plugin chosen: the empty sentence, no chips, no count, no "more"', () => {
    const card = setup(cardOf(projectRig({}), [], [A]));
    assert.equal(card.all((n) => n.tag === 'p' && n.textContent === 'No plugins chosen. Agents use only what the project already enables.').length, 1);
    assert.equal(card.all(withClass('chip')).length, 0);
    assert.equal(card.all((n) => n.attrs['data-fk'] === 'setup-more').length, 0);
    assert.equal(card.all((n) => n.tag === 'h3')[0].textContent, 'Plugins');
  });

  test('(+) "Choose plugins…" is a button (never a link) with aria-haspopup="dialog"; pressing it opens the dialog and does not touch the route', async () => {
    const r = projectRig({ savedList: [A] });
    const card = setup(cardOf(r, [A], [A, B]));
    const button = card.all((n) => n.attrs['data-fk'] === 'choose-plugins')[0];
    assert.equal(button.tag, 'button');
    assert.equal(button.attrs.type, 'button');
    assert.equal(button.attrs['aria-haspopup'], 'dialog');
    assert.equal(button.textContent, 'Choose plugins…');
    assert.equal(button.attrs.href, undefined);
    assert.deepEqual(card.all((n) => n.tag === 'a' && n.attrs.href !== '#settings'), []);
    button.click();
    await settle();
    assert.equal(r.dlg.open, true);
    assert.equal(r.node('#pl-h').textContent, 'Choose plugins for demo-api');
    assert.deepEqual(r.location.hashSets, []);
  });

  test('(+) the card carries no row of the other cards: Rules is unchanged, New agents has the 0.4 limit rows', () => {
    const cards = cardOf(projectRig({}), [], null);
    assert.deepEqual(cards[0].all((n) => n.tag === 'h2').map((n) => n.textContent), ['Rules']);
    assert.deepEqual(cards[2].all((n) => n.tag === 'dt').map((n) => n.textContent), ['Permission mode', 'Pane', 'Per orchestrator', 'Spawned from nika', 'This project']);
  });
});

describe('installed plugins for the card (loadInstalled)', () => {
  test('(+) the installed names are kept in state.plugins, so a saved plugin that is gone is flagged', async () => {
    const r = projectRig({ installed: [A, B] });
    await r.api.loadInstalled();
    assert.deepEqual(r.state.plugins, [A, B]);
  });

  test('(−) a refused answer, a network failure or a body without a list leaves state.plugins as it was and never throws', async () => {
    const r = projectRig({ installed: [A] });
    await r.api.loadInstalled();
    r.cfg.pluginsStatus = 500;
    await r.api.loadInstalled();
    assert.deepEqual(r.state.plugins, [A]);
    const down = projectRig({ throwOn: 'GET /api/app/plugins' });
    await down.api.loadInstalled();
    assert.equal(down.state.plugins, null);
    const odd = projectRig({ installed: 'nope' });
    await odd.api.loadInstalled();
    assert.equal(odd.state.plugins, null);
  });

  test('(+) entering a project loads them and redraws; the card is redrawn when they change (they are part of its signature)', () => {
    const src = code(read('project.js'));
    assert.match(src, /hooks\.enterProject = \(\) => \{ loadInstalled\(\)\.then\(\(\) => render\(\)\); \};/);
    assert.match(src, /state\.settings, state\.plugins, state\.models, state\.me\?\.tmux/, 'the catalog too: the Models block shows its labels');
  });
});

describe('page wiring and source checks', () => {
  test('(−) the page code no longer has state.pluginProject, a #settings jump for plugins, or a plugin list in Settings', () => {
    const project = code(read('project.js'));
    const settings = code(read('settings.js'));
    const ui = code(read('ui.js'));
    assert.doesNotMatch(project + settings + ui, /pluginProject/);
    assert.doesNotMatch(settings, /renderPlugins|set-plug|perProject|installed|\/api\/app\/plugins/);
    assert.doesNotMatch(project, /href: '#settings', 'data-fk': 'choose-plugins'/);
  });

  test('(+) the dialog is static markup in index.html: no form, labelled and described, filter, count, list in a fieldset, footer buttons', () => {
    const dlg = /<dialog id="dlg-plugins"[\s\S]*?<\/dialog>/.exec(HTML)?.[0];
    assert.ok(dlg, 'dialog exists');
    assert.match(dlg, /<dialog id="dlg-plugins" class="dlg-plugins" aria-labelledby="pl-h" aria-describedby="pl-d"/);
    assert.doesNotMatch(dlg, /<form\b/, 'Enter in the filter must not submit');
    assert.match(dlg, /<h2 id="pl-h"/);
    assert.match(dlg, /id="pl-d"[^>]*>Ticked plugins are turned on in <code>\.claude\/settings\.local\.json<\/code> the next time you apply rules\./);
    assert.match(dlg, /<input type="search" id="pl-filter" data-fk="pl-filter"/);
    assert.match(dlg, /<fieldset[^>]*id="pl-box"[^>]*><legend class="sr-only">Installed plugins<\/legend>/);
    assert.match(dlg, /id="pl-alert" tabindex="-1" hidden/);
    assert.match(dlg, /id="pl-count"/);
    assert.match(dlg, /id="pl-list"/);
    assert.match(dlg, /Ticked plugins are turned on and other plugins that are on in that file are removed when you apply rules\. Leave all unticked to leave the file's plugins as they are\./);
    for (const [id, cls] of [['pl-cancel', 'btn lg'], ['pl-retry', 'btn primary lg'], ['pl-save', 'btn primary lg'], ['pl-x', 'btn icon ghost']]) {
      assert.match(dlg, new RegExp(`<button[^>]*class="${cls}"[^>]*id="${id}"|<button[^>]*id="${id}"[^>]*class="${cls}"`), id);
      assert.match(dlg, new RegExp(`<button[^>]*id="${id}"[^>]*data-fk="${id}"|<button[^>]*data-fk="${id}"[^>]*id="${id}"`), `${id} has its data-fk`);
    }
    assert.match(dlg, /<button[^>]*id="pl-retry"[^>]*hidden[^>]*disabled|<button[^>]*id="pl-retry"[^>]*disabled[^>]*hidden/, 'Retry starts hidden and off');
    assert.match(dlg, /data-app-only/);
  });

  test('(+) Mod+Enter finds Save: it is the first enabled .btn.primary in the dialog, and Cancel is not primary', () => {
    const dlg = /<dialog id="dlg-plugins"[\s\S]*?<\/dialog>/.exec(HTML)[0];
    const primaries = [...dlg.matchAll(/<button[^>]*class="[^"]*\bprimary\b[^"]*"[^>]*>/g)].map((m) => /id="([^"]+)"/.exec(m[0])[1]);
    assert.deepEqual(primaries.sort(), ['pl-retry', 'pl-save']);
    assert.doesNotMatch(/<button[^>]*id="pl-cancel"[^>]*>/.exec(dlg)[0], /primary/);
  });

  test('(+) the side card region is labelled "Project details" (no second "Project setup") and the Settings screen has no Plugins link or section', () => {
    assert.match(HTML, /<aside aria-label="Project details" id="proj-setup">/);
    assert.doesNotMatch(HTML, /id="s-plugins"|data-jump="s-plugins"|set-plug|Plugins per project/);
    assert.match(HTML, /<p class="sub">Defaults for every project, saved to <code>config\.json<\/code> in nika's config folder\. Plugins are chosen on each project's page\.<\/p>/);
  });

  test('(+) app.css styles the new pieces: .card h3, .chip.missing, the dialog size, a scrolling .plug-list, the row states', () => {
    for (const sel of ['.card h3', '.chip.missing', 'dialog.dlg-plugins', '.plug-list', '.plug-row[data-on="true"]', '.plug-miss']) assert.ok(APP_CSS.includes(sel), `${sel} in app.css`);
    assert.match(APP_CSS, /dialog\.dlg-plugins \{[^}]*width: min\(560px, calc\(100vw - 32px\)\)/);
    assert.match(APP_CSS, /dialog\.dlg-plugins \{[^}]*height: min\(640px, calc\(100vh - 32px\)\)/);
    assert.match(APP_CSS, /\.plug-list \{[^}]*overflow: auto/);
    assert.doesNotMatch(APP_CSS, /\.plug-list \{[^}]*max-height/, 'no fixed height: only the list scrolls inside the dialog');
    assert.match(APP_CSS, /\.plug-row\[data-on="true"\] \{[^}]*background: var\(--accent-soft\)/);
    assert.match(APP_CSS, /\.chip\.missing \{[^}]*border-style: dashed/);
  });

  test('(+) the new module is served: every ./x.js the main page loads has an entry in the server\'s static list', () => {
    const server = read('../src/server.js');
    for (const f of ['app.js', 'project.js', 'settings.js']) {
      for (const m of read(f).matchAll(/from '\.\/([a-z-]+\.js)'/g)) assert.ok(server.includes(`'/${m[1]}'`), `${f} imports ${m[1]}, which the server must serve`);
    }
    assert.match(read('project.js'), /from '\.\/plugin-view\.js'/);
  });
});

// ---- Settings: defaults only; the Save bar shows on a real change -------------------------------------------------------------

function settingsRig({ settings, put = { status: 200 }, templates = ['mine.md'], putHold = false } = {}) {
  const base = {
    ui: { theme: 'system', singleKeyShortcuts: true }, models: { orchestrator: 'opus', reasoner: 'opus', builder: 'claude-sonnet-5-5', scout: 'haiku' },
    remoteControl: { enabled: false, prefix: '' }, permissionMode: 'default', panePlacement: 'beside', limits: { maxAgents: 3 },
    rules: { localTemplate: null }, perProject: {}, compaction: { enabled: true, pct: 80, window: 400000 },
  };
  const radios = {
    theme: ['system', 'light', 'dark'].map((v) => Object.assign(new El('input'), { value: v })),
    perm: ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk'].map((v) => Object.assign(new El('input'), { value: v })),
    place: ['beside', 'under-last'].map((v) => Object.assign(new El('input'), { value: v })),
  };
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, new El(sel.startsWith('#set-model') && !sel.endsWith('-custom') ? 'select' : sel === '#set-tpl' ? 'select' : 'input'));
    return nodes.get(sel);
  };
  const calls = [];
  const announced = [];
  const toasts = [];
  const renders = [];
  const release = { fn: null };
  const state = { settings: { ...base, ...settings }, models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'latest' }, { id: 'opus', label: 'Opus', group: 'alias' }, { id: 'haiku', label: 'Haiku', group: 'alias' }], projects: [PROJECT] };
  const hooks = {};
  const $ = (sel) => {
    const m = /^input\[name="(\w+)"\]:checked$/.exec(sel);
    if (m) return radios[m[1]].find((r) => r.checked) ?? null;
    return node(sel);
  };
  const $$ = (sel) => {
    const m = /^input\[name="(\w+)"\]$/.exec(sel);
    return m ? radios[m[1]] : [];
  };
  const ctx = {
    h, icon, $, $$, state, hooks, CUSTOM, MODEL_ID, MODEL_HINT, fillModelSelect, compactPreview, JSON, Number, Promise, Object, Array, Set,
    RX: { agent: [/^[a-z0-9][a-z0-9-]{0,39}$/, 'x'], prefix: [/^(?:[a-z0-9][a-z0-9-]{0,19})?$/, 'Lowercase letters, digits and dashes, up to 20, starting with a letter or digit. Leave empty to use the project name.'] },
    toast: (msg) => toasts.push(msg), announce: (m) => announced.push(m), errText: (r) => r?.body?.message ?? 'x',
    fieldError: () => {}, syncRadioCards: () => {}, applyTheme: () => {}, render: (f) => renders.push(f),
    setBusy: (b, on, label) => { b.disabled = on; b.busy = on ? label : null; },
    loadSettings: async () => ({ status: 200 }), loadModels: async () => ({ status: 200 }),
    appFetch: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ method, url, json: opts.json === undefined ? undefined : plain(opts.json) });
      if (method === 'GET' && url === '/api/app/templates') return { status: 200, body: { templates } };
      if (method === 'PUT' && url === '/api/app/settings') {
        if (putHold) await new Promise((r) => { release.fn = r; });
        return { status: put.status, body: put.body ?? { ...state.settings, ...opts.json } };
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  };
  node('#set-form'); node('#set-bar').hidden = true; node('#set-sum').hidden = true; node('#set-compact-err').hidden = true;
  const api = runModule('settings.js', ctx, '({ hooks })');
  return {
    api, ctx, node, radios, calls, announced, toasts, renders, release, state,
    form: node('#set-form'),
    enter: async () => { await hooks.enterSettings(); },
    type: (sel, value) => { node(sel).value = value; node('#set-form').fire('input'); },
    pick: (name, value) => { for (const r of radios[name]) r.checked = r.value === value; node('#set-form').fire('change'); },
    submit: () => node('#set-form').fire('submit'),
    bar: () => node('#set-bar'),
  };
}

describe('Settings holds defaults only', () => {
  test('(−) the Settings screen has no plugin section, entering it asks only for templates, and the PUT body has no plugins or perProject', async () => {
    const s = settingsRig({ settings: { perProject: { [KEY]: { plugins: [A] } } } });
    await s.enter();
    assert.deepEqual(s.calls, [{ method: 'GET', url: '/api/app/templates', json: undefined }], 'no /api/app/plugins request');
    s.type('#set-max', '5');
    s.submit();
    await settle();
    const put = s.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(Object.keys(put.json).sort(), ['compaction', 'limits', 'models', 'panePlacement', 'permissionMode', 'remoteControl', 'rules', 'ui']);
    assert.equal('plugins' in put.json, false);
    assert.equal('perProject' in put.json, false);
    assert.equal(put.json.limits.maxAgents, 5);
  });

  test('(+) a saved Settings page shows no unsaved changes: the bar is hidden after the first draw', async () => {
    const s = settingsRig({});
    await s.enter();
    assert.equal(s.bar().hidden, true);
  });
});

describe('Settings Save bar only on a real change', () => {
  test('(+) a change shows the bar and says so once; changing it back hides the bar again', async () => {
    const s = settingsRig({});
    await s.enter();
    s.type('#set-max', '5');
    assert.equal(s.bar().hidden, false);
    assert.deepEqual(s.announced, ['Unsaved changes. Save or discard them at the bottom.']);
    s.type('#set-max', '6');
    assert.deepEqual(s.announced.length, 1, 'still shown: no second announcement');
    s.type('#set-max', '3');
    assert.equal(s.bar().hidden, true, 'back to the saved value');
    s.pick('perm', 'plan');
    assert.equal(s.bar().hidden, false);
    s.pick('perm', 'default');
    assert.equal(s.bar().hidden, true);
    assert.equal(s.announced.length, 2, 'announced again for the second change');
  });

  test('(−) typing the value that is already saved, or only spaces around it, never shows the bar', async () => {
    const s = settingsRig({ settings: { remoteControl: { enabled: true, prefix: 'team' } } });
    await s.enter();
    s.type('#set-max', '3');
    s.type('#set-rc-prefix', 'team');
    s.type('#set-rc-prefix', '  team ');
    s.pick('theme', 'system');
    s.pick('perm', 'default');
    s.pick('place', 'beside');
    assert.equal(s.bar().hidden, true);
    assert.deepEqual(s.announced, []);
  });

  test('(+) every group counts: theme, key shortcuts, a model, Remote Control, mode, placement, limit, template', async () => {
    const edits = [
      (s) => s.pick('theme', 'dark'),
      (s) => { s.node('#set-singlekey').checked = false; s.form.fire('change'); },
      (s) => { s.node('#set-model-scout').value = 'opus'; s.form.fire('change'); },
      (s) => { s.node('#set-rc').checked = true; s.form.fire('change'); },
      (s) => s.type('#set-rc-prefix', 'x1'),
      (s) => s.pick('perm', 'auto'),
      (s) => s.pick('place', 'under-last'),
      (s) => s.type('#set-max', '8'),
      (s) => { s.node('#set-tpl').value = 'mine.md'; s.form.fire('change'); },
    ];
    for (const [i, edit] of edits.entries()) {
      const s = settingsRig({});
      await s.enter();
      edit(s);
      assert.equal(s.bar().hidden, false, `edit ${i}`);
    }
  });

  test('(+) Discard puts the saved values back, hides the bar, moves focus to the heading and says so', async () => {
    const s = settingsRig({});
    await s.enter();
    s.type('#set-max', '7');
    s.pick('theme', 'dark');
    s.node('#set-discard').click();
    assert.equal(String(s.node('#set-max').value), '3');
    assert.equal(s.radios.theme.find((r) => r.checked).value, 'system');
    assert.equal(s.bar().hidden, true);
    assert.equal(focused, s.node('#set-h'));
    assert.equal(s.announced.at(-1), 'Changes discarded.');
    s.type('#set-max', '3');
    assert.equal(s.bar().hidden, true, 'the snapshot is the discarded state');
  });

  test('(+) a saved change: the PUT carries formValue, Save says "Saving…" and Discard is off meanwhile; on 200 the toast shows, the bar hides and focus goes to the heading', async () => {
    const s = settingsRig({ putHold: true });
    await s.enter();
    s.type('#set-max', '4');
    s.submit();
    await settle();
    assert.equal(s.node('#set-save').busy, 'Saving…');
    assert.equal(s.node('#set-discard').disabled, true);
    s.release.fn();
    await settle();
    assert.deepEqual(s.toasts, ['Settings saved']);
    assert.equal(s.bar().hidden, true, 'the saved state is the new snapshot');
    assert.equal(s.node('#set-save').disabled, false);
    assert.equal(s.node('#set-discard').disabled, false);
    assert.equal(focused, s.node('#set-h'));
    assert.deepEqual(s.renders, [true]);
    s.type('#set-max', '4');
    assert.equal(s.bar().hidden, true);
  });

  test('(−) a refused save keeps the bar, shows the summary and focuses it; the edit is still there', async () => {
    const s = settingsRig({ put: { status: 400, body: { message: 'limits.maxAgents must be 1 to 8' } } });
    await s.enter();
    s.type('#set-max', '4');
    s.submit();
    await settle();
    assert.equal(s.bar().hidden, false);
    assert.equal(s.node('#set-sum-text').textContent, 'limits.maxAgents must be 1 to 8');
    assert.equal(s.node('#set-sum').hidden, false);
    assert.equal(focused, s.node('#set-sum'));
    assert.equal(s.node('#set-max').value, '4');
    assert.equal(s.node('#set-save').disabled, false);
    assert.deepEqual(s.toasts, []);
  });

  test('(−) with the bar hidden a submit (Enter in a field) sends nothing', async () => {
    const s = settingsRig({});
    await s.enter();
    const e = s.submit();
    await settle();
    assert.equal(e.defaultPrevented, true, 'the form never navigates');
    assert.deepEqual(s.calls.filter((c) => c.method === 'PUT'), []);
    s.type('#set-max', '4');
    s.type('#set-max', '3');
    s.submit();
    await settle();
    assert.deepEqual(s.calls.filter((c) => c.method === 'PUT'), [], 'changed and changed back is the same');
  });

  test('(−) a field that fails its check blocks the save and the bar stays', async () => {
    const s = settingsRig({});
    await s.enter();
    s.type('#set-max', '99');
    s.submit();
    await settle();
    assert.deepEqual(s.calls.filter((c) => c.method === 'PUT'), []);
    assert.equal(s.bar().hidden, false);
  });
});

describe('Mod+Enter and Enter (app.js initKeys)', () => {
  const rig = ({ route = 'settings', barHidden = true, dialog = null } = {}) => {
    const app = read('app.js');
    const at = app.indexOf('function initKeys() {');
    const src = app.slice(at, app.indexOf('\n}\n', at) + 2);
    let handler;
    const save = new El('button');
    const clicks = [];
    save.click = () => clicks.push('set-save');
    const bar = new El('div');
    bar.hidden = barHidden;
    const dlgGo = new El('button');
    dlgGo.click = () => clicks.push('dialog-primary');
    const ctx = {
      isApp: true, MAC: false, state: { route: { name: route }, settings: {} }, hooks: {}, wantsHelp: () => false, wantsBack: () => false, isTextEntry: () => false,
      singleKey: () => true, location: {}, openKbd() {},
      $: (sel, root) => (sel === 'dialog[open]' ? dialog : sel === '#set-save' ? save : sel === '#set-bar' ? bar : sel === '.btn.primary:not(:disabled)' && root === dialog ? dlgGo : null),
      document: { activeElement: null, addEventListener: (type, fn) => { if (type === 'keydown') handler = fn; } },
    };
    vm.runInNewContext(`${src}\ninitKeys()`, ctx);
    return {
      clicks,
      press: (extra = {}) => {
        const e = { key: 'Enter', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target: new El('input'), preventDefault() { this.prevented = true; }, ...extra };
        handler(e);
        return e;
      },
    };
  };

  test('(+) on Settings with unsaved changes Mod+Enter clicks Save', () => {
    const r = rig({ barHidden: false });
    assert.equal(r.press().prevented, true);
    assert.deepEqual(r.clicks, ['set-save']);
  });

  test('(−) on Settings with the bar hidden Mod+Enter sends nothing', () => {
    const r = rig({ barHidden: true });
    r.press();
    assert.deepEqual(r.clicks, []);
  });

  test('(−) on other screens Mod+Enter does not reach Settings Save', () => {
    const r = rig({ route: 'dashboard', barHidden: false });
    r.press();
    assert.deepEqual(r.clicks, []);
  });

  test('(+) with a dialog open Mod+Enter presses the dialog\'s primary button (the plugin dialog\'s Save), not Settings Save', () => {
    const r = rig({ route: 'project', barHidden: false, dialog: new El('dialog') });
    r.press();
    assert.deepEqual(r.clicks, ['dialog-primary']);
  });
});
