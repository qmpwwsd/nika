// 0.4, O3: per-project models, the page side (design 0.4 section 4): the Models block on the Project setup card, the "Choose models"
// dialog (public/project.js, index.html, app.css), and the spawn sheet's Roles group. The browser is exercised by hand; here the
// real page code runs in a vm against a small fake DOM (test/fake-dom.js) and recorded requests. Names and ids are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, focus } from './fake-dom.js';
import { MODEL_CATALOG } from '../src/models.js';
import { h, icon } from '../public/dom.js';
import { menuEl, sessionHref } from '../public/ui.js';
import { orchState, roleTag, savedPick, otherRunning, spawnLimits } from '../public/dash-model.js';
import { parseModes, modesAfter, settingModeEl } from '../public/modes.js';
import { pluginView, pluginSave, sortIds, countText, filterNote } from '../public/plugin-view.js';
import {
  CUSTOM, MODEL_ID, MODEL_HINT, ROLES, ROLE_LABEL, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels,
} from '../public/models-ui.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const plain = (v) => JSON.parse(JSON.stringify(v)); // values built inside a vm have another realm's prototypes
const settle = () => new Promise((r) => setImmediate(r));
const PROJECT_SRC = code(read('project.js')).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
const HTML = read('index.html');
const APP_CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');

let restore;
const realSetTimeout = globalThis.setTimeout;
before(() => {
  restore = installDom();
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSetTimeout(fn, ms, ...a); t.unref?.(); return t; };
});
after(() => {
  globalThis.setTimeout = realSetTimeout;
  restore();
});

const KEY = '0123456789abcdef';
const CFG_URL = `/api/app/projects/${KEY}/config`;
const DEFAULTS = { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-sonnet-5-5', scout: 'claude-haiku-5-5' };
const NONE = { orchestrator: null, reasoner: null, builder: null, scout: null };
const SYNTH = MODEL_CATALOG.map((x) => ({ ...x }));
const settingsWith = (models) => ({
  models: { ...DEFAULTS }, limits: { maxAgents: 3 }, permissionMode: 'default', panePlacement: 'beside',
  perProject: models ? { [KEY]: { models } } : {},
});

/**
 * The page module with fake nodes for the dialog's static markup and recorded requests. `loaded`: what the page already holds in
 * `state.settings` (the card); `server`: what the server answers (settings, catalog, config).
 */
function rig({
  loaded = settingsWith(null), serverSettings = loaded, catalog = SYNTH, config = { plugins: [], models: { ...NONE } }, rules = 'nika', name = 'demo-api',
  settingsStatus = 200, modelsStatus = 200, configStatus = 200, put = {}, hold = false, throwOn = null, stateModels = null,
} = {}) {
  const proj = { key: KEY, dir: '/work/demo-api', name, rules: { state: rules }, orchestrator: null };
  const g = { key: KEY, label: name, project: proj, agents: [] };
  const nodes = new Map();
  const kind = (sel) => (/^#md-model-\w+-custom$/.test(sel) ? 'input' : /^#md-model-\w+$/.test(sel) ? 'select' : /^#md-(save|retry|cancel|x)$/.test(sel) ? 'button' : sel === '#dlg-models' ? 'dialog' : 'div');
  const node = (sel) => {
    if (!nodes.has(sel)) {
      const el = new El(kind(sel));
      el.id = sel.slice(1);
      nodes.set(sel, el);
    }
    return nodes.get(sel);
  };
  const calls = [];
  const toastLog = [];
  const renders = [];
  const errors = new Map();
  const release = { fn: null };
  const state = { error: null, me: { tmux: true, claude: true }, projects: [proj], settings: loaded, modes: { map: {}, misses: 0 }, route: { name: 'project', key: KEY }, open: new Set(), expanded: new Set(), plugins: null, showEnded: false, models: stateModels };
  const appFetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ method, url, json: opts.json === undefined ? undefined : plain(opts.json) });
    if (throwOn === `${method} ${url}`) throw new Error('down');
    const bad = (status) => ({ status, body: { message: 'nope' } });
    if (method === 'GET' && url === '/api/app/settings') return settingsStatus === 200 ? { status: 200, body: plain(serverSettings) } : bad(settingsStatus);
    if (method === 'GET' && url === '/api/app/models') return modelsStatus === 200 ? { status: 200, body: { models: catalog } } : bad(modelsStatus);
    if (method === 'GET' && url === CFG_URL) return configStatus === 200 ? { status: 200, body: plain(config) } : bad(configStatus);
    if (method === 'PUT' && url === CFG_URL) {
      if (hold) await new Promise((r) => { release.fn = r; });
      return { status: put.status ?? 200, body: put.body ?? { plugins: [], models: opts.json.models } };
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  const ctx = {
    h, icon, $: node, state, hooks: {}, appFetch, applyTheme: () => {}, menuEl, sessionHref, roleTag, orchState, savedPick, otherRunning, spawnLimits, syncRadioCards: () => {}, parseModes, modesAfter, settingModeEl,
    pluginView, pluginSave, sortIds, countText, filterNote,
    CUSTOM, MODEL_ID, MODEL_HINT, ROLES, ROLE_LABEL, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels,
    location: { set href(v) {}, get href() { return ''; }, hash: '' },
    document: { title: '' },
    toast: (msg, o) => { toastLog.push({ msg, kind: o?.kind ?? 'info', action: o?.action }); },
    announce: () => {}, errText: (r) => r?.body?.message ?? `The server answered ${r?.status}.`, copyText: () => {},
    setBusy: (b, on, label) => { b.disabled = on; b.busy = on ? label : null; if (on) b.attrs['aria-busy'] = 'true'; else delete b.attrs['aria-busy']; },
    fieldError: (input, msg) => { errors.set(input.id, msg); input.attrs['aria-invalid'] = msg ? 'true' : 'false'; },
    openDialog: (dlg, o) => { dlg.open = true; (o?.focus ?? dlg).focus(); },
    render: (force) => renders.push(force), buildGroups: () => [g], agentNodes: () => [new El('ul')], swap: (host, list) => host.replaceChildren(...list), interacting: () => false,
    rulesEl: () => new El('span'), setTimeout, clearTimeout, AbortController, TextEncoder, window: { addEventListener: () => {} },
  };
  const api = vm.runInNewContext(`${PROJECT_SRC}\n({ setupCards, openModels, mdLoad, wireModels, md, rememberPlugins, renderProject, openSpawn })`, ctx);
  api.wireModels();
  return {
    api, ctx, proj, g, state, calls, toastLog, renders, errors, release, node,
    dlg: node('#dlg-models'),
    sel: (r) => node(`#md-model-${r}`),
    custom: (r) => node(`#md-model-${r}-custom`),
    puts: () => calls.filter((c) => c.method === 'PUT'),
    card: () => api.setupCards(proj, g)[1],
    open: async () => { api.openModels(proj); await settle(); },
    pick: (r, value) => { const s = node(`#md-model-${r}`); s.value = value; s.fire('change'); },
    type: (r, text) => { const i = node(`#md-model-${r}-custom`); i.value = text; i.fire('input'); },
  };
}

const modelsHead = (card) => card.all((n) => n.tag === 'h3').find((n) => n.textContent.startsWith('Models'));
const roleRows = (card) => {
  const dl = card.byFk('setup-models');
  if (!dl) return null;
  const dts = dl.all((n) => n.tag === 'dt');
  const dds = dl.all((n) => n.tag === 'dd');
  return dts.map((dt, i) => ({ role: dt.textContent, text: dds[i].textContent, title: dds[i].attrs.title, cls: dds[i].className }));
};

// ---- the card (design 4.1) ------------------------------------------------------------------------------------------------------

describe('Project setup card: the Models block', () => {
  test('(+) lists only the overridden roles, in role order, with the catalog label, the id in the title and a count', () => {
    const r = rig({ loaded: settingsWith({ scout: 'claude-haiku-5-5', builder: 'claude-opus-5-5' }), stateModels: SYNTH });
    const card = r.card();
    assert.equal(modelsHead(card).textContent, 'Models 2 set here');
    assert.deepEqual(roleRows(card), [
      { role: 'Builder', text: 'Opus 5.5', title: 'claude-opus-5-5', cls: '' },
      { role: 'Scout', text: 'Haiku 5.5', title: 'claude-haiku-5-5', cls: '' },
    ]);
    assert.match(card.textContent, /Used when nika starts this project's orchestrator or spawns its agents\./);
    const btn = card.byFk('choose-models');
    assert.equal(btn.tag, 'button');
    assert.equal(btn.textContent, 'Choose models…');
    assert.equal(btn.attrs['aria-haspopup'], 'dialog');
  });

  test('(+) a Custom ID (not in the catalog) shows as the id itself, in the mono class, and an override of one role says "1 set here"', () => {
    const r = rig({ loaded: settingsWith({ orchestrator: 'claude-private-9' }), stateModels: SYNTH });
    const card = r.card();
    assert.equal(modelsHead(card).textContent, 'Models 1 set here');
    assert.deepEqual(roleRows(card), [{ role: 'Orchestrator', text: 'claude-private-9', title: 'claude-private-9', cls: 'mono' }]);
  });

  test('(+) without a catalog every override shows as its id', () => {
    const r = rig({ loaded: settingsWith({ scout: 'claude-haiku-5-5' }), stateModels: null });
    assert.deepEqual(roleRows(r.card()), [{ role: 'Scout', text: 'claude-haiku-5-5', title: 'claude-haiku-5-5', cls: 'mono' }]);
  });

  test('(−) nothing overridden: "All roles use the defaults from Settings." and no list, no count', () => {
    const r = rig({ loaded: settingsWith(null) });
    const card = r.card();
    assert.equal(modelsHead(card).textContent, 'Models');
    assert.equal(card.byFk('setup-models'), null);
    assert.match(card.textContent, /All roles use the defaults from Settings\./);
    assert.ok(card.byFk('choose-models'), 'the button is there all the same');
  });

  test('(−) another project\'s override does not show here; settings not loaded yet says so and keeps the button', () => {
    const other = settingsWith(null);
    other.perProject = { fedcba9876543210: { models: { scout: 'opus' } } };
    const a = rig({ loaded: other }).card();
    assert.match(a.textContent, /All roles use the defaults/);
    assert.equal(a.byFk('setup-models'), null);
    const b = rig({ loaded: null }).card();
    assert.match(b.textContent, /Not loaded yet\./);
    assert.doesNotMatch(b.textContent, /All roles use the defaults/);
    assert.ok(b.byFk('choose-models'));
  });

  test('(+) the button opens the dialog for this project', async () => {
    const r = rig();
    r.card().byFk('choose-models').click();
    await settle();
    assert.equal(r.dlg.open, true);
    assert.equal(r.node('#md-h').textContent, 'Models for demo-api');
  });
});

// ---- the dialog: open and load (design 4.2) --------------------------------------------------------------------------------------

const lines = (r) => r.node('#md-skel').all((n) => n.className.includes('sk-line'));
const optionTexts = (sel) => sel.all((n) => n.tag === 'option').map((o) => o.textContent);

describe('Choose models dialog: open and load', () => {
  test('(+) open asks for the settings, the catalog and the config together; while they load: the title, four skeleton lines, Save off', async () => {
    const r = rig({ name: 'x'.repeat(40) });
    r.api.openModels(r.proj);
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url}`).sort(), ['GET /api/app/models', 'GET /api/app/settings', `GET ${CFG_URL}`].sort(), 'all three before any answers');
    assert.equal(r.node('#md-h').textContent, `Models for ${'x'.repeat(31)}…`);
    assert.equal(lines(r).length, 4);
    assert.match(r.node('#md-skel').textContent, /Loading models…/);
    assert.equal(r.node('#md-skel').hidden, false);
    assert.equal(r.node('#md-fields').hidden, true);
    assert.equal(r.node('#md-save').disabled, true);
    assert.equal(r.node('#md-retry').hidden, true);
    assert.equal(r.node('#md-dirty').textContent, '');
    await settle();
  });

  test('(+) loaded: the fields show, each select reads Use default (<label>) or the saved model, the footer says "No changes yet.", focus goes to the Orchestrator select', async () => {
    const r = rig({ config: { plugins: [], models: { ...NONE, builder: 'claude-opus-5-5' } } });
    await r.open();
    assert.equal(r.node('#md-skel').hidden, true);
    assert.equal(r.node('#md-fields').hidden, false);
    assert.equal(r.node('#md-note').hidden, true);
    assert.equal(optionTexts(r.sel('orchestrator'))[0], 'Use default (Fable 5.1)');
    assert.equal(optionTexts(r.sel('reasoner'))[0], 'Use default (Opus 5.5)');
    assert.equal(optionTexts(r.sel('scout'))[0], 'Use default (Haiku 5.5)');
    assert.deepEqual(ROLES.map((role) => r.sel(role).value), ['', '', 'claude-opus-5-5', '']);
    assert.deepEqual(ROLES.map((role) => r.custom(role).hidden), [true, true, true, true]);
    assert.equal(r.node('#md-dirty').textContent, 'No changes yet.');
    assert.equal(r.node('#md-save').disabled, true);
    assert.equal(focus.el, r.sel('orchestrator'));
  });

  test('(+) a saved id that is not in the catalog opens as Custom ID with its field filled, and is not a change', async () => {
    const r = rig({ config: { plugins: [], models: { ...NONE, scout: 'claude-private-9' } } });
    await r.open();
    assert.equal(r.sel('scout').value, CUSTOM);
    assert.equal(r.custom('scout').hidden, false);
    assert.equal(r.custom('scout').value, 'claude-private-9');
    assert.equal(r.node('#md-save').disabled, true);
    assert.equal(r.node('#md-dirty').textContent, 'No changes yet.');
  });

  test('(+) the defaults come from the fresh settings the dialog just loaded, not from the page\'s older copy', async () => {
    const r = rig({ loaded: settingsWith(null), serverSettings: { ...settingsWith(null), models: { ...DEFAULTS, scout: 'claude-sonnet-5-5' } } });
    await r.open();
    assert.equal(optionTexts(r.sel('scout'))[0], 'Use default (Sonnet 5.5)');
  });

  test('(−) no catalog (the list call failed and the page has none): the note shows and each select offers Use default and Custom ID only', async () => {
    const r = rig({ modelsStatus: 500, stateModels: null });
    await r.open();
    assert.equal(r.node('#md-note').hidden, false);
    for (const role of ROLES) assert.deepEqual(optionTexts(r.sel(role)), [`Use default (${DEFAULTS[role]})`, 'Custom ID…'], role);
    assert.equal(r.dlg.open, true, 'not a load error: the dialog works');
    assert.equal(r.node('#md-alert').hidden, true);
  });

  test('(−) a catalog the page already had is kept when the new list call fails', async () => {
    const r = rig({ modelsStatus: 500, stateModels: SYNTH });
    await r.open();
    assert.equal(r.node('#md-note').hidden, true);
    assert.ok(optionTexts(r.sel('builder')).includes('Sonnet 5.5 (claude-sonnet-5-5)'));
  });

  test('(−) load error: the config call fails, or the settings call, or a call throws: the alert, Retry instead of Save, focus on the alert', async () => {
    for (const opts of [{ configStatus: 500 }, { settingsStatus: 500 }, { throwOn: `GET ${CFG_URL}` }, { throwOn: 'GET /api/app/settings' }]) {
      const r = rig(opts);
      await r.open();
      const label = JSON.stringify(opts);
      assert.equal(r.node('#md-alert').hidden, false, label);
      assert.equal(r.node('#md-alert-text').textContent, 'The model settings could not be loaded. Check that nika is still running, then try again.', label);
      assert.equal(r.node('#md-retry').hidden, false, label);
      assert.equal(r.node('#md-retry').disabled, false, label);
      assert.equal(r.node('#md-save').hidden, true, label);
      assert.equal(r.node('#md-save').disabled, true, label);
      assert.equal(r.node('#md-fields').hidden, true, label);
      assert.equal(focus.el, r.node('#md-alert'), label);
    }
  });

  test('(+) Retry loads again and, when it works, shows the fields with Save back and Retry gone', async () => {
    const r = rig({ configStatus: 500 });
    await r.open();
    const calls = r.calls.length;
    r.node('#md-retry').click();
    assert.equal(r.calls.length, calls + 3, 'Retry asks for all three again');
    await settle();
    assert.equal(r.node('#md-alert').hidden, false, 'still failing: still the alert');
    assert.equal(r.node('#md-retry').hidden, false);
  });

  test('(−) a load that finishes after the dialog was closed changes nothing', async () => {
    const r = rig();
    r.api.openModels(r.proj);
    r.dlg.open = false;
    await settle();
    assert.equal(r.node('#md-skel').hidden, false, 'still the skeleton: the late answer was dropped');
    assert.equal(r.api.md.loaded, null);
  });
});

// ---- the dialog: dirty, validation, save (design 4.2) ----------------------------------------------------------------------------

describe('Choose models dialog: dirty rule', () => {
  test('(+) a change enables Save and counts it; changing it back disables Save again; two roles say "2 roles changed"', async () => {
    const r = rig();
    await r.open();
    r.pick('builder', 'claude-opus-5-5');
    assert.equal(r.node('#md-save').disabled, false);
    assert.equal(r.node('#md-dirty').textContent, '1 role changed');
    r.pick('scout', 'opus');
    assert.equal(r.node('#md-dirty').textContent, '2 roles changed');
    r.pick('builder', '');
    r.pick('scout', '');
    assert.equal(r.node('#md-save').disabled, true);
    assert.equal(r.node('#md-dirty').textContent, 'No changes yet.');
  });

  test('(+) Custom ID shows its field; typing the saved text back is clean; any other choice hides the field and drops its error', async () => {
    const r = rig({ config: { plugins: [], models: { ...NONE, scout: 'claude-haiku-5-5' } } });
    await r.open();
    r.pick('scout', CUSTOM);
    assert.equal(r.custom('scout').hidden, false);
    assert.equal(r.node('#md-save').disabled, false, 'Custom ID with no text yet differs from the saved model');
    r.type('scout', ' claude-haiku-5-5 ');
    assert.equal(r.node('#md-save').disabled, true, 'the trimmed text equals what was loaded');
    r.type('scout', 'nope nope');
    r.custom('scout').fire('blur');
    assert.equal(r.errors.get('md-model-scout-custom'), MODEL_HINT);
    r.pick('scout', '');
    assert.equal(r.custom('scout').hidden, true);
    assert.equal(r.errors.get('md-model-scout-custom'), '');
  });

  test('(−) a blur with a good id or a hidden field shows no error', async () => {
    const r = rig();
    await r.open();
    r.custom('builder').fire('blur');
    assert.notEqual(r.errors.get('md-model-builder-custom'), MODEL_HINT);
    r.pick('builder', CUSTOM);
    r.type('builder', 'claude-private-9');
    r.custom('builder').fire('blur');
    assert.equal(r.errors.get('md-model-builder-custom'), '');
  });
});

describe('Choose models dialog: save', () => {
  test('(+) the payload has all four keys, null for "Use default"; the card, the dialog and the page follow; the toast is the plain one when no rules were applied', async () => {
    const r = rig({ rules: 'none', config: { plugins: [], models: { ...NONE, scout: 'claude-haiku-5-5' } } });
    await r.open();
    r.pick('builder', 'claude-opus-5-5');
    r.pick('scout', '');
    r.node('#md-save').click();
    await settle();
    assert.deepEqual(r.puts().map((c) => [c.url, c.json]), [[CFG_URL, { models: { orchestrator: null, reasoner: null, builder: 'claude-opus-5-5', scout: null } }]]);
    assert.deepEqual(Object.keys(r.puts()[0].json.models), ROLES);
    assert.equal(r.dlg.open, false);
    assert.deepEqual(plain(r.state.settings.perProject[KEY]), { models: { builder: 'claude-opus-5-5' } });
    assert.deepEqual(r.renders, [true]);
    assert.deepEqual(r.toastLog.map((t) => [t.msg, t.kind]), [['Models saved for demo-api. Sessions nika starts from now on use them.', 'info']]);
  });

  test('(+) a Custom ID is sent trimmed', async () => {
    const r = rig();
    await r.open();
    r.pick('reasoner', CUSTOM);
    r.type('reasoner', '  claude-private-9 ');
    r.node('#md-save').click();
    await settle();
    assert.equal(r.puts()[0].json.models.reasoner, 'claude-private-9');
    assert.deepEqual(plain(r.state.settings.perProject[KEY].models), { reasoner: 'claude-private-9' });
  });

  test('(+) the toast adds the Apply rules sentence when the project\'s rules are current or outdated', async () => {
    for (const rules of ['nika', 'outdated']) {
      const r = rig({ rules });
      await r.open();
      r.pick('scout', 'opus');
      r.node('#md-save').click();
      await settle();
      assert.deepEqual(r.toastLog.map((t) => t.msg), ['Models saved for demo-api. Sessions nika starts from now on use them. Apply rules to update the models in rules/orchestration.md.'], rules);
    }
  });

  test('(−) the plain toast for a project with no rules file or one nika did not write', async () => {
    for (const rules of ['none', 'foreign', null]) {
      const r = rig({ rules });
      await r.open();
      r.pick('scout', 'opus');
      r.node('#md-save').click();
      await settle();
      assert.deepEqual(r.toastLog.map((t) => t.msg), ['Models saved for demo-api. Sessions nika starts from now on use them.'], String(rules));
    }
  });

  test('(+) all roles back to "Use default" drops the models from the page copy, and the entry with it', async () => {
    const r = rig({ loaded: settingsWith({ scout: 'opus' }), config: { plugins: [], models: { ...NONE, scout: 'opus' } } });
    await r.open();
    r.pick('scout', '');
    r.node('#md-save').click();
    await settle();
    assert.deepEqual(r.puts()[0].json, { models: NONE });
    assert.deepEqual(plain(r.state.settings.perProject), {});
  });

  test('(+) the page copy keeps the project\'s plugins when only the models change, and the other roles', async () => {
    const loaded = settingsWith({ builder: 'sonnet' });
    loaded.perProject[KEY].plugins = ['alpha-lint@demo-market'];
    const r = rig({ loaded, config: { plugins: ['alpha-lint@demo-market'], models: { ...NONE, builder: 'sonnet' } } });
    await r.open();
    r.pick('scout', 'haiku');
    r.node('#md-save').click();
    await settle();
    assert.deepEqual(plain(r.state.settings.perProject[KEY]), { plugins: ['alpha-lint@demo-market'], models: { builder: 'sonnet', scout: 'haiku' } });
  });

  test('(−) an invalid Custom ID: no request; the alert counts the fields, the field shows MODEL_HINT and takes focus; a second bad one is counted too', async () => {
    const r = rig();
    await r.open();
    r.pick('scout', CUSTOM);
    r.type('scout', 'has space');
    r.node('#md-save').click();
    await settle();
    assert.equal(r.puts().length, 0);
    assert.equal(r.node('#md-alert').hidden, false);
    assert.equal(r.node('#md-alert-text').textContent, '1 field needs a fix before saving.');
    assert.equal(r.errors.get('md-model-scout-custom'), MODEL_HINT);
    assert.equal(focus.el, r.custom('scout'));
    r.pick('builder', CUSTOM);
    r.type('builder', '');
    r.node('#md-save').click();
    assert.equal(r.node('#md-alert-text').textContent, '2 fields need a fix before saving.');
    assert.equal(focus.el, r.custom('builder'), 'the first bad field in role order');
    assert.equal(r.dlg.open, true);
  });

  test('(−) saving: the dialog is busy (Esc and × do nothing), the controls are off, Save says "Saving…"; afterwards they are back', async () => {
    const r = rig({ hold: true });
    await r.open();
    r.pick('scout', 'opus');
    r.node('#md-save').click();
    await settle();
    assert.equal(r.dlg.dataset.busy, '1');
    assert.equal(r.node('#md-save').busy, 'Saving…');
    assert.equal(r.node('#md-save').disabled, true);
    for (const id of ['#md-cancel', '#md-x', ...ROLES.flatMap((role) => [`#md-model-${role}`, `#md-model-${role}-custom`])]) assert.equal(r.node(id).disabled, true, id);
    r.node('#md-save').click();
    assert.equal(r.puts().length, 1, 'a second click while saving sends nothing');
    r.release.fn();
    await settle();
    assert.equal(r.dlg.dataset.busy, undefined);
    assert.equal(r.node('#md-cancel').disabled, false);
    assert.equal(r.sel('scout').disabled, false);
  });

  test('(−) a failed save keeps the draft and shows the server\'s words in the alert, with focus on it; Save is on again', async () => {
    const r = rig({ put: { status: 400, body: { message: 'models must have orchestrator, reasoner, builder and scout, each a model id or null' } } });
    await r.open();
    r.pick('scout', 'opus');
    r.node('#md-save').click();
    await settle();
    assert.equal(r.dlg.open, true);
    assert.equal(r.node('#md-alert').hidden, false);
    assert.match(r.node('#md-alert-text').textContent, /^models must have/);
    assert.equal(focus.el, r.node('#md-alert'));
    assert.equal(r.sel('scout').value, 'opus', 'the draft is kept');
    assert.equal(r.node('#md-save').disabled, false);
    assert.equal(r.node('#md-dirty').textContent, '1 role changed');
    assert.deepEqual(plain(r.state.settings.perProject), {}, 'the page copy is not changed by a failed save');
    assert.equal(r.toastLog.length, 0);
    assert.equal(r.renders.length, 0);
  });

  test('(−) a save that cannot reach the server says so', async () => {
    const r = rig({ throwOn: `PUT ${CFG_URL}` });
    await r.open();
    r.pick('scout', 'opus');
    r.node('#md-save').click();
    await settle();
    assert.equal(r.node('#md-alert-text').textContent, 'Could not reach the nika server.');
    assert.equal(r.dlg.open, true);
  });

  test('(−) with nothing changed Save sends nothing, by click or by Enter in a Custom ID field; with a change Enter saves', async () => {
    const r = rig({ config: { plugins: [], models: { ...NONE, scout: 'claude-private-9' } } });
    await r.open();
    r.node('#md-save').click();
    const clean = r.custom('scout').fire('keydown', { key: 'Enter' });
    assert.equal(r.puts().length, 0);
    assert.equal(clean.defaultPrevented, true);
    r.type('scout', 'claude-private-10');
    r.custom('scout').fire('keydown', { key: 'Enter' });
    await settle();
    assert.equal(r.puts().length, 1);
    assert.equal(r.puts()[0].json.models.scout, 'claude-private-10');
    r.custom('scout').fire('keydown', { key: 'a' });
    assert.equal(r.puts().length, 1, 'other keys do nothing');
  });

  test('(−) server text is only ever shown as text: a project name with markup lands in the title as text, an id in a title attribute', async () => {
    const r = rig({ name: '<img src=x onerror=alert(1)>', loaded: settingsWith({ scout: '<b>x</b>' }), stateModels: SYNTH });
    const dd = r.card().byFk('setup-models').all((n) => n.tag === 'dd')[0];
    assert.equal(dd.textContent, '<b>x</b>');
    assert.equal(dd.kids.every((k) => k.tag === '#text'), true);
    await r.open();
    assert.equal(r.node('#md-h').textContent, 'Models for <img src=x onerror=alert(1)>');
    assert.equal(r.node('#md-h').kids.length, 0);
  });
});

// ---- the spawn sheet's Roles group (design 3, "Roles optgroup uses the project's effective models") -----------------------------

describe('spawn sheet: the Roles group follows the project\'s effective models', () => {
  const rows = (r) => r.node('#sp-model').all((n) => n.tag === 'optgroup').find((o) => o.attrs.label === 'Roles').kids.map((o) => [o.attrs.value, o.textContent]);
  const spawnRig = (loaded) => rig({ loaded, stateModels: SYNTH });

  test('(+) an overridden role reads "<Role> · <id> (this project)" with the project\'s id; the others keep the Settings model', () => {
    const r = spawnRig(settingsWith({ builder: 'claude-opus-5-5', scout: 'sonnet[1m]' }));
    r.api.openSpawn(r.g);
    assert.deepEqual(rows(r), [
      ['claude-opus-5-5', 'Builder · claude-opus-5-5 (this project)'],
      ['claude-opus-5-5', 'Reasoner · claude-opus-5-5'],
      ['sonnet[1m]', 'Scout · sonnet[1m] (this project)'],
      ['claude-fable-5-1', 'Orchestrator · claude-fable-5-1'],
    ]);
    assert.equal(r.node('#sp-model').value, 'claude-opus-5-5', 'the first role (Builder) is chosen, with its project model');
  });

  test('(−) no override for this project: as before, with no marker; another project\'s override does not show', () => {
    const settings = settingsWith(null);
    settings.perProject = { fedcba9876543210: { models: { builder: 'opus' } } };
    const r = spawnRig(settings);
    r.api.openSpawn(r.g);
    assert.deepEqual(rows(r).map((x) => x[1]), ['Builder · claude-sonnet-5-5', 'Reasoner · claude-opus-5-5', 'Scout · claude-haiku-5-5', 'Orchestrator · claude-fable-5-1']);
  });

  test('(−) settings not loaded: the four aliases stand in, as before', () => {
    const r = spawnRig(null);
    r.api.openSpawn(r.g);
    assert.deepEqual(rows(r).map((x) => x[0]), ['opus', 'sonnet', 'haiku', 'fable']);
  });
});

// ---- the static markup and CSS ---------------------------------------------------------------------------------------------------

describe('index.html and app.css: the dialog', () => {
  const dlg = /<dialog id="dlg-models"[\s\S]*?<\/dialog>/.exec(HTML)?.[0] ?? '';
  const ids = [...dlg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

  test('(+) a static dialog with the class, labelled and described, app tier only, with no form', () => {
    assert.ok(dlg, '#dlg-models exists');
    assert.match(dlg, /<dialog id="dlg-models" class="dlg-models" aria-labelledby="md-h" aria-describedby="md-d" data-app-only>/);
    assert.doesNotMatch(dlg, /<form/);
    assert.match(dlg, /Used when nika starts this project's orchestrator or spawns its agents\. Running sessions keep their model\./);
    assert.match(dlg, /Defaults are in Settings\./);
    assert.match(dlg, /<p class="help" id="md-note" hidden>The model list did not load\. Choose Use default, or type a model ID\.<\/p>/);
  });

  test('(+) every id the page code asks for is in the markup, with the design\'s fk hooks on the buttons', () => {
    const asked = [...PROJECT_SRC.matchAll(/'#(md-[\w-]+)'/g)].map((m) => m[1]);
    const rolePattern = [...PROJECT_SRC.matchAll(/`#(md-model-\$\{r\}(?:-custom)?)`/g)];
    assert.ok(rolePattern.length >= 2, 'the role fields are asked through a template');
    for (const id of new Set(asked)) assert.ok(ids.includes(id), `#${id}`);
    for (const role of ROLES) for (const suffix of ['', '-custom', '-custom-err']) assert.ok(ids.includes(`md-model-${role}${suffix}`), `md-model-${role}${suffix}`);
    for (const fk of ['md-x', 'md-cancel', 'md-retry', 'md-save']) assert.match(dlg, new RegExp(`data-fk="${fk}"`), fk);
    assert.equal(new Set(ids).size, ids.length, 'no id twice');
  });

  test('(+) each custom field is hidden at first, labelled for screen readers and wired to its error line', () => {
    for (const role of ROLES) {
      const re = new RegExp(`<input[^>]*id="md-model-${role}-custom"[^>]*>`);
      const input = re.exec(dlg)?.[0] ?? '';
      assert.match(input, /\bhidden\b/, role);
      assert.match(input, /aria-label="Custom model ID for the /, role);
      assert.match(input, new RegExp(`aria-describedby="md-model-${role}-custom-err"`), role);
      assert.match(dlg, new RegExp(`<label for="md-model-${role}">${ROLE_LABEL[role]}</label>`), role);
    }
    assert.match(dlg, /<div class="alert" data-kind="danger" role="alert" id="md-alert" tabindex="-1" hidden>/);
  });

  test('(−) no inline style or script in the dialog, and the Retry button starts hidden and off', () => {
    assert.doesNotMatch(dlg, /\sstyle=|<script|\son\w+=/);
    assert.match(dlg, /<button[^>]*id="md-retry"[^>]*\bhidden\b[^>]*\bdisabled\b|<button[^>]*id="md-retry"[^>]*\bdisabled\b[^>]*\bhidden\b/);
  });

  test('(+) the CSS sizes the dialog as the design says and lets the body scroll', () => {
    assert.match(APP_CSS, /dialog\.dlg-models\s*\{\s*width:\s*min\(480px,\s*calc\(100vw - 32px\)\);\s*\}/);
    assert.match(APP_CSS, /dialog\.dlg-models\[open\]\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*\}/);
    assert.match(APP_CSS, /\.kv dd\.mono\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });
});
