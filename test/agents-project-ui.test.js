// 0.4.0, G1: the permission mode, the pane placement and the per-orchestrator agent limit can be set for one project (the New agents
// card on the project page, public/project.js, ui.js menuEl, app.css) or left on "Use Settings". The browser is exercised by hand; here
// the real page code runs in a vm against a small fake DOM (test/fake-dom.js) and recorded requests. Names and ids are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, withClass } from './fake-dom.js';
import { h, icon } from '../public/dom.js';
import { menuEl, sessionHref } from '../public/ui.js';
import { orchState, roleTag, savedPick, otherRunning, spawnLimits, effectiveAgents } from '../public/dash-model.js';
import { parseModes, modesAfter, settingModeEl, MODE_META } from '../public/modes.js';
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
const APP_CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');

let restore;
const realSetTimeout = globalThis.setTimeout;
const toastBox = new El('div');
before(() => {
  restore = installDom({ querySelector: (sel) => (sel === '#toasts' ? toastBox : null) }); // menuEl raises its own toast for an item with a reason
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSetTimeout(fn, ms, ...a); t.unref?.(); return t; };
});
after(() => {
  globalThis.setTimeout = realSetTimeout;
  restore();
});

const KEY = '0123456789abcdef';
const CFG_URL = `/api/app/projects/${KEY}/config`;
const NONE = { orchestrator: null, reasoner: null, builder: null, scout: null };
const SETTINGS = {
  models: { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-sonnet-5-5', scout: 'claude-haiku-5-5' },
  limits: { maxAgents: 3 }, permissionMode: 'default', panePlacement: 'beside', perProject: {},
};
/** Settings as the page holds them after GET /api/app/settings, with `own` as this project's perProject entry. */
const settingsWith = (own = null, over = {}) => ({ ...plain(SETTINGS), ...over, perProject: own ? { [KEY]: own } : {} });

function rig({ loaded = settingsWith(), put = {}, throwOn = null, rules = 'nika', hold = false } = {}) {
  const proj = { key: KEY, dir: '/work/demo-api', name: 'demo-api', rules: { state: rules }, orchestrator: null };
  const g = { key: KEY, label: 'demo-api', project: proj, agents: [] };
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) {
      const el = new El(/^#sp-perm$|^#sp-model$/.test(sel) ? 'select' : 'div');
      el.id = sel.slice(1);
      if (sel === 'input[name="sp-place"]:checked') el.value = 'settings';
      nodes.set(sel, el);
    }
    return nodes.get(sel);
  };
  const calls = [];
  const toastLog = [];
  const renders = [];
  const release = { fn: null };
  const state = { error: null, me: { tmux: true, claude: true }, projects: [proj], settings: loaded, modes: { map: {}, misses: 0 }, route: { name: 'project', key: KEY }, open: new Set(), expanded: new Set(), plugins: null, showEnded: false, models: null };
  const appFetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ method, url, json: opts.json === undefined ? undefined : plain(opts.json) });
    if (throwOn === `${method} ${url}`) throw new Error('down');
    if (method === 'PUT' && url === CFG_URL) {
      if (hold) await new Promise((r) => { release.fn = r; });
      // the server's answer: the whole project config, the one field changed
      return { status: put.status ?? 200, body: put.body ?? { plugins: [], models: { ...NONE }, permissionMode: null, panePlacement: null, maxAgents: null, ...opts.json } };
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  const ctx = {
    h, icon, $: node, state, hooks: {}, appFetch, applyTheme: () => {}, menuEl, sessionHref, roleTag, orchState, savedPick, otherRunning, spawnLimits, effectiveAgents,
    syncRadioCards: () => {}, parseModes, modesAfter, settingModeEl, MODE_META,
    pluginView, pluginSave, sortIds, countText, filterNote,
    CUSTOM, MODEL_ID, MODEL_HINT, ROLES, ROLE_LABEL, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels,
    location: { set href(v) {}, get href() { return ''; }, hash: '' },
    document: { title: '' },
    toast: (msg, o) => { toastLog.push({ msg, kind: o?.kind ?? 'info', action: o?.action }); },
    announce: () => {}, errText: (r) => r?.body?.message ?? `The server answered ${r?.status}.`, copyText: () => {},
    setBusy: () => {}, fieldError: () => {}, openDialog: (dlg) => { dlg.open = true; },
    render: (force) => renders.push(force), buildGroups: () => [g], agentNodes: () => [new El('ul')], swap: (host, list) => host.replaceChildren(...list), interacting: () => false,
    rulesEl: () => new El('span'), setTimeout, clearTimeout, AbortController, TextEncoder, window: { addEventListener: () => {} },
  };
  const api = vm.runInNewContext(`${PROJECT_SRC}\n({ setupCards, openSpawn, limitCopy, limitReason })`, ctx);
  const card = () => api.setupCards(proj, g).find((c) => c.all((n) => n.tag === 'h2')[0]?.textContent === 'New agents');
  return { api, proj, g, state, calls, toastLog, renders, release, node, card, puts: () => calls.filter((c) => c.method === 'PUT') };
}

// ---- the card ---------------------------------------------------------------------------------------------------------------------

const ROW_NAMES = ['Permission mode', 'Pane', 'Per orchestrator'];
const rowOf = (card, name) => {
  const dl = card.all((n) => n.tag === 'dl')[0];
  const i = dl.kids.findIndex((k) => k.tag === 'dt' && k.textContent === name);
  return dl.kids[i + 1];
};
const triggerOf = (card, name) => rowOf(card, name).all((n) => n.attrs['data-menu-btn'] !== undefined)[0];
const menuOf = (trigger) => trigger.parent.all((n) => n.tag === 'ul')[0];
const itemsOf = (card, name) => menuOf(triggerOf(card, name)).all((n) => n.tag === 'li').map((li) => li.kids[0]);
const texts = (btns) => btns.map((b) => b.textContent);
const fromSettings = (card, name) => rowOf(card, name).all(withClass('muted')).map((n) => n.textContent);

describe('New agents card: three values as menu buttons', () => {
  test('(+) every value from Settings: a menu button with the value, a muted "from Settings" after it, and the aria-label says both', () => {
    const card = rig().card();
    for (const name of ROW_NAMES) assert.deepEqual(fromSettings(card, name), ['from Settings'], name);
    assert.equal(triggerOf(card, 'Permission mode').attrs['aria-label'], 'Permission mode for demo-api: Default, from Settings');
    assert.equal(triggerOf(card, 'Pane').attrs['aria-label'], 'Pane for demo-api: Beside, from Settings');
    assert.equal(triggerOf(card, 'Per orchestrator').attrs['aria-label'], 'Per orchestrator for demo-api: 3 at once, from Settings');
    assert.equal(triggerOf(card, 'Per orchestrator').textContent, '3 at once');
    assert.equal(triggerOf(card, 'Pane').textContent, 'Beside');
    for (const name of ROW_NAMES) assert.match(triggerOf(card, name).className, /\bmenu-val\b/, name);
  });

  test('(+) the permission mode keeps its chip (class, icon, word) inside the button, for every mode', () => {
    const CHIPS = { default: ['m-default', 'Default'], manual: ['m-manual', 'Manual'], acceptEdits: ['m-edits', 'Accept edits'], plan: ['m-plan', 'Plan'], auto: ['m-auto', 'Auto'], dontAsk: ['m-dontask', "Don't ask"] };
    for (const [mode, [cls, word]] of Object.entries(CHIPS)) {
      const card = rig({ loaded: settingsWith({ permissionMode: mode }) }).card();
      const chip = triggerOf(card, 'Permission mode').all(withClass('mode'))[0];
      assert.equal(chip.className, `mode ${cls}`, mode);
      assert.equal(chip.all(withClass('ml'))[0].textContent, word, mode);
      assert.ok(chip.all((n) => n.tag === 'use').length === 1, `${mode}: an icon`);
      assert.equal(triggerOf(card, 'Permission mode').attrs['aria-label'], `Permission mode for demo-api: ${word}, set for this project`, mode);
    }
  });

  test('(+) a value the project sets itself shows without "from Settings"; the other two still say it', () => {
    const card = rig({ loaded: settingsWith({ panePlacement: 'under-last' }, { permissionMode: 'plan', limits: { maxAgents: 5 } }) }).card();
    assert.equal(triggerOf(card, 'Pane').textContent, 'Under the last agent');
    assert.deepEqual(fromSettings(card, 'Pane'), []);
    assert.equal(triggerOf(card, 'Pane').attrs['aria-label'], 'Pane for demo-api: Under the last agent, set for this project');
    assert.deepEqual(fromSettings(card, 'Permission mode'), ['from Settings']);
    assert.equal(triggerOf(card, 'Permission mode').all(withClass('mode'))[0].className, 'mode m-plan', 'Settings\' plan');
    assert.equal(triggerOf(card, 'Per orchestrator').textContent, '5 at once');
    assert.deepEqual(fromSettings(card, 'Per orchestrator'), ['from Settings']);
  });

  test('(+) the project\'s value beats Settings\': mode, pane and limit; another project\'s entry does not show', () => {
    const loaded = settingsWith({ permissionMode: 'auto', panePlacement: 'under-last', maxAgents: 2 }, { permissionMode: 'plan', panePlacement: 'beside', limits: { maxAgents: 6 } });
    loaded.perProject.fedcba9876543210 = { permissionMode: 'dontAsk', maxAgents: 8 };
    const card = rig({ loaded }).card();
    assert.equal(triggerOf(card, 'Permission mode').all(withClass('mode'))[0].className, 'mode m-auto');
    assert.equal(triggerOf(card, 'Pane').textContent, 'Under the last agent');
    assert.equal(triggerOf(card, 'Per orchestrator').textContent, '2 at once');
    for (const name of ROW_NAMES) assert.deepEqual(fromSettings(card, name), [], name);
  });

  test('(+) the counts below follow the project\'s limit: "0 of 2" and a cap of 6', () => {
    const card = rig({ loaded: settingsWith({ maxAgents: 2 }, { limits: { maxAgents: 6 } }) }).card();
    assert.equal(rowOf(card, 'Spawned from nika').textContent, '0 of 2');
    assert.equal(rowOf(card, 'This project').textContent, '0 of 6 running');
  });

  test('(−) before Settings has loaded: dashes for the mode and the pane (no menu), the default limit of 3 as plain text', () => {
    const card = rig({ loaded: null }).card();
    assert.deepEqual([rowOf(card, 'Permission mode').textContent, rowOf(card, 'Pane').textContent, rowOf(card, 'Per orchestrator').textContent], ['–', '–', '3 at once']);
    assert.equal(card.all((n) => n.attrs['data-menu-btn'] !== undefined).length, 0);
  });
});

describe('New agents card: the menus', () => {
  const WORDS = ['Default', 'Manual', 'Accept edits', 'Plan', 'Auto', "Don't ask"];

  test('(+) each menu starts with "Use Settings (<Settings value>)", then every choice', () => {
    const r = rig({ loaded: settingsWith(null, { permissionMode: 'plan', panePlacement: 'under-last', limits: { maxAgents: 5 } }) });
    const card = r.card();
    assert.deepEqual(texts(itemsOf(card, 'Permission mode')), ['Use Settings: Plan', ...WORDS], 'the mode item shows the chip, so no brackets; the colon is for screen readers');
    assert.deepEqual(texts(itemsOf(card, 'Pane')), ['Use Settings (Under the last agent)', 'Beside', 'Under the last agent']);
    assert.deepEqual(texts(itemsOf(card, 'Per orchestrator')), ['Use Settings (5 at once)', ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${n} at once`)]);
  });

  test('(+) every mode item, "Use Settings" included, shows that mode\'s own chip (colour class, icon, word): owner rule for mode states', () => {
    const card = rig({ loaded: settingsWith(null, { permissionMode: 'auto' }) }).card();
    const want = ['m-auto', 'm-default', 'm-manual', 'm-edits', 'm-plan', 'm-auto', 'm-dontask'];
    const chips = itemsOf(card, 'Permission mode').map((b) => b.all(withClass('mode')));
    assert.deepEqual(chips.map((c) => c.length), want.map(() => 1), 'one chip per item');
    assert.deepEqual(chips.map((c) => c[0].className), want.map((cls) => `mode ${cls}`));
    assert.ok(chips.every((c) => c[0].all((n) => n.tag === 'use').length === 1), 'each with its icon');
    assert.deepEqual(texts(itemsOf(card, 'Permission mode')), ['Use Settings: Auto', ...WORDS], 'the words read the same');
    assert.equal(itemsOf(card, 'Permission mode')[0].all(withClass('sr-only'))[0]?.textContent, ': ', 'the colon is screen-reader only');
  });

  test('(+) a mode item whose long label says more carries it as a tooltip (Auto: the classifier warning); (−) Plan and the other rows get none', () => {
    const card = rig({ loaded: settingsWith(null, { permissionMode: 'auto' }) }).card();
    const items = itemsOf(card, 'Permission mode');
    assert.deepEqual(items.map((b) => b.attrs.title), [
      'Auto: a classifier approves actions without asking you', // Use Settings, while Settings says Auto
      'Claude Code default (no flag)', 'Manual: ask every time', undefined, undefined, 'Auto: a classifier approves actions without asking you', undefined,
    ]);
    for (const name of ['Pane', 'Per orchestrator']) assert.ok(itemsOf(card, name).every((b) => b.attrs.title === undefined), name);
  });

  test('(−) no menu offers bypass, and the card never says it', () => {
    for (const permissionMode of ['default', 'plan', 'dontAsk']) {
      const card = rig({ loaded: settingsWith({ permissionMode }, { permissionMode: 'auto' }) }).card();
      for (const name of ROW_NAMES) assert.doesNotMatch(texts(itemsOf(card, name)).join('|'), /bypass/i, name);
      assert.doesNotMatch(card.textContent, /bypass/i);
    }
  });

  test('(+) the current choice carries a check icon and aria-current="true", and only it: "Use Settings" while inherited, the choice once the project sets it', () => {
    const marked = (btns) => btns.filter((b) => b.attrs['aria-current'] === 'true');
    const inherited = rig({ loaded: settingsWith(null, { limits: { maxAgents: 5 } }) }).card();
    for (const name of ROW_NAMES) {
      const m = marked(itemsOf(inherited, name));
      assert.equal(m.length, 1, name);
      assert.match(m[0].textContent, /^Use Settings/, name);
      assert.equal(m[0].all((n) => n.tag === 'use' && n.attrs.href === '#i-check').length, 1, name);
      const checks = (b) => b.all((n) => n.tag === 'use' && n.attrs.href === '#i-check').length; // the mode items also carry their chip's icon
      assert.equal(itemsOf(inherited, name).filter(checks).length, 1, `${name}: one check`);
    }
    const own = rig({ loaded: settingsWith({ permissionMode: 'acceptEdits', panePlacement: 'beside', maxAgents: 7 }) }).card();
    assert.deepEqual(marked(itemsOf(own, 'Permission mode')).map((b) => b.textContent), ['Accept edits']);
    assert.deepEqual(marked(itemsOf(own, 'Pane')).map((b) => b.textContent), ['Beside']);
    assert.deepEqual(marked(itemsOf(own, 'Per orchestrator')).map((b) => b.textContent), ['7 at once']);
  });

  test('(+) a menu button is a disclosure menu: aria-expanded false, aria-controls its list, data-fk for focus keeping', () => {
    const card = rig().card();
    for (const [name, fk] of [['Permission mode', 'agent-permissionMode'], ['Pane', 'agent-panePlacement'], ['Per orchestrator', 'agent-maxAgents']]) {
      const t = triggerOf(card, name);
      assert.equal(t.attrs['aria-expanded'], 'false');
      assert.equal(t.attrs['aria-controls'], menuOf(t).attrs.id);
      assert.equal(t.attrs['data-fk'], fk);
      assert.equal(menuOf(t).hidden, true);
    }
  });
});

describe('New agents card: picking an item', () => {
  const pick = async (r, name, text) => {
    const item = itemsOf(r.card(), name).find((b) => b.textContent === text);
    assert.ok(item, `${name}: ${text}`);
    item.fire('click');
    await settle();
  };

  test('(+) a pick sends exactly one field, saves the answer for the card and draws it again', async () => {
    const r = rig();
    await pick(r, 'Permission mode', 'Plan');
    await pick(r, 'Pane', 'Under the last agent');
    await pick(r, 'Per orchestrator', '2 at once');
    assert.deepEqual(r.puts().map((c) => [c.url, c.json]), [
      [CFG_URL, { permissionMode: 'plan' }], [CFG_URL, { panePlacement: 'under-last' }], [CFG_URL, { maxAgents: 2 }],
    ]);
    assert.deepEqual(plain(r.state.settings.perProject[KEY]), { permissionMode: 'plan', panePlacement: 'under-last', maxAgents: 2 });
    assert.deepEqual(r.renders, [true, true, true]);
    const card = r.card();
    assert.equal(triggerOf(card, 'Per orchestrator').textContent, '2 at once');
    assert.deepEqual(fromSettings(card, 'Per orchestrator'), []);
    assert.equal(rowOf(card, 'Spawned from nika').textContent, '0 of 2');
    assert.deepEqual(plain(r.state.settings.limits), { maxAgents: 3 }, 'Settings itself is not changed');
  });

  test('(+) every mode, every placement and every limit from 1 to 8 goes out as the value itself (a number for the limit)', async () => {
    const r = rig();
    for (const [mode, word] of [['default', 'Default'], ['manual', 'Manual'], ['acceptEdits', 'Accept edits'], ['plan', 'Plan'], ['auto', 'Auto'], ['dontAsk', "Don't ask"]]) {
      await pick(r, 'Permission mode', word);
      assert.deepEqual(r.puts().at(-1).json, { permissionMode: mode });
    }
    for (let n = 1; n <= 8; n += 1) {
      await pick(r, 'Per orchestrator', `${n} at once`);
      assert.deepEqual(r.puts().at(-1).json, { maxAgents: n });
      assert.equal(r.state.settings.perProject[KEY].maxAgents, n);
    }
    await pick(r, 'Pane', 'Beside');
    assert.deepEqual(r.puts().at(-1).json, { panePlacement: 'beside' }, 'a value equal to the Settings one is still the project\'s own');
    assert.equal(r.state.settings.perProject[KEY].panePlacement, 'beside');
  });

  test('(+) "Use Settings" sends null for that field and the project\'s value is forgotten (and the entry when nothing is left)', async () => {
    const r = rig({ loaded: settingsWith({ permissionMode: 'plan', maxAgents: 2 }, { permissionMode: 'auto' }) });
    await pick(r, 'Permission mode', 'Use Settings: Auto');
    assert.deepEqual(r.puts().map((c) => c.json), [{ permissionMode: null }]);
    assert.deepEqual(plain(r.state.settings.perProject[KEY]), { maxAgents: 2 });
    assert.deepEqual(fromSettings(r.card(), 'Permission mode'), ['from Settings']);
    await pick(r, 'Per orchestrator', 'Use Settings (3 at once)');
    assert.deepEqual(r.puts().at(-1).json, { maxAgents: null });
    assert.equal(KEY in r.state.settings.perProject, false);
  });

  test('(+) the toast says what was saved, and mentions Apply rules only when a rules file written by nika exists', async () => {
    const r = rig();
    await pick(r, 'Permission mode', 'Plan');
    assert.equal(r.toastLog.at(-1).kind, 'info');
    assert.match(r.toastLog.at(-1).msg, /^Permission mode saved for demo-api: Plan\./);
    assert.match(r.toastLog.at(-1).msg, /Apply rules to update rules\/orchestration\.md\./);
    const none = rig({ rules: 'none' });
    await pick(none, 'Pane', 'Under the last agent');
    assert.match(none.toastLog.at(-1).msg, /^Pane saved for demo-api: Under the last agent\./);
    assert.doesNotMatch(none.toastLog.at(-1).msg, /Apply rules/);
    await pick(none, 'Pane', 'Use Settings (Beside)');
    assert.match(none.toastLog.at(-1).msg, /^Pane for demo-api now follows Settings: Beside\./);
  });

  test('(−) a refused save shows the server\'s message as an error toast and keeps the old value; no redraw', async () => {
    const r = rig({ loaded: settingsWith({ maxAgents: 4 }), put: { status: 400, body: { error: 'invalid', message: 'maxAgents must be a whole number from 1 to 8, or null' } } });
    await pick(r, 'Per orchestrator', '2 at once');
    assert.deepEqual(r.toastLog.map((t) => [t.kind, t.msg]), [['error', 'maxAgents must be a whole number from 1 to 8, or null']]);
    assert.deepEqual(plain(r.state.settings.perProject[KEY]), { maxAgents: 4 });
    assert.deepEqual(r.renders, []);
    assert.equal(triggerOf(r.card(), 'Per orchestrator').textContent, '4 at once');
  });

  test('(−) an unreachable server is an error toast too, and nothing changes', async () => {
    const r = rig({ throwOn: `PUT ${CFG_URL}` });
    await pick(r, 'Permission mode', 'Plan');
    assert.deepEqual(r.toastLog.map((t) => [t.kind, t.msg]), [['error', 'Could not reach the nika server.']]);
    assert.deepEqual(plain(r.state.settings.perProject), {});
    assert.deepEqual(r.renders, []);
  });

  test('(−) a second pick of the same item while a save is on the way sends nothing', async () => {
    const r = rig({ hold: true });
    const item = itemsOf(r.card(), 'Pane').find((b) => b.textContent === 'Under the last agent');
    item.fire('click');
    item.fire('click');
    await settle();
    assert.equal(r.puts().length, 1);
    r.release.fn();
    await settle();
    assert.equal(r.state.settings.perProject[KEY].panePlacement, 'under-last');
    itemsOf(r.card(), 'Pane').find((b) => b.textContent === 'Beside').fire('click'); // free again
    await settle();
    r.release.fn?.();
    await settle();
    assert.equal(r.puts().length, 2);
  });
});

// ---- the limit copy and the spawn sheet ------------------------------------------------------------------------------------------

describe('the limit copy and the spawn sheet follow the project\'s values', () => {
  const TAIL_SETTINGS = 'Wait for one to finish, or raise “Agents per orchestrator” in Settings.';
  const TAIL_PROJECT = 'Wait for one to finish, or raise “Per orchestrator” on this project’s New agents card.';

  test('(+) limitCopy points at Settings, or at the card when the project sets its own limit', () => {
    const r = rig();
    const args = { scope: 'parent', parent: null, project: 'demo-api', running: 2, max: 2 };
    assert.equal(r.api.limitCopy(args), `You already run 2 of 2 agents spawned from nika in demo-api. ${TAIL_SETTINGS}`);
    assert.equal(r.api.limitCopy({ ...args, own: true }), `You already run 2 of 2 agents spawned from nika in demo-api. ${TAIL_PROJECT}`);
    assert.equal(r.api.limitCopy({ ...args, parent: 'planner', own: true }), `planner already runs 2 of 2 agents of its own. ${TAIL_PROJECT}`);
    assert.equal(r.api.limitCopy({ scope: 'project', project: 'demo-api', running: 6, max: 6, own: true }), 'demo-api already runs 6 of 6 agents, the most one project can run. Wait for one to finish.');
  });

  test('(+) a full bucket reads the project\'s limit: with maxAgents 1 of its own, one agent is enough, and the copy names the card', () => {
    const live = { id: 'a1', name: 'builder-1', live: true, role: 'agent', parent: null, pane: { id: '%9', command: 'claude' } };
    const r = rig({ loaded: settingsWith({ maxAgents: 1 }, { limits: { maxAgents: 5 } }) });
    r.g.agents = [live];
    assert.equal(r.api.limitReason(r.g, null), `You already run 1 of 1 agents spawned from nika in demo-api. ${TAIL_PROJECT}`);
    const roomy = rig({ loaded: settingsWith(null, { limits: { maxAgents: 5 } }) });
    roomy.g.agents = [live];
    assert.equal(roomy.api.limitReason(roomy.g, null), null);
    const settingsFull = rig({ loaded: settingsWith(null, { limits: { maxAgents: 1 } }) });
    settingsFull.g.agents = [live];
    assert.equal(settingsFull.api.limitReason(settingsFull.g, null), `You already run 1 of 1 agents spawned from nika in demo-api. ${TAIL_SETTINGS}`);
  });

  test('(+) the sheet\'s first mode option names the project\'s effective mode, and its pane choice the effective placement', () => {
    const own = rig({ loaded: settingsWith({ permissionMode: 'auto', panePlacement: 'under-last' }, { permissionMode: 'plan' }) });
    own.api.openSpawn(own.g);
    const options = own.node('#sp-perm').kids.map((o) => o.textContent);
    assert.equal(options[0], "Use this project's setting: Auto: a classifier approves actions without asking you");
    assert.match(own.node('#sp-place').kids[0].textContent, /^Under the last agent \(set for this project\)$/);
    const inherited = rig({ loaded: settingsWith(null, { permissionMode: 'plan', panePlacement: 'under-last' }) });
    inherited.api.openSpawn(inherited.g);
    assert.equal(inherited.node('#sp-perm').kids[0].textContent, "Use this project's setting: Plan");
    assert.match(inherited.node('#sp-place').kids[0].textContent, /^Under the last agent \(from Settings\)$/);
  });

  test('(−) settings not loaded: the sheet still opens with the old fallbacks', () => {
    const r = rig({ loaded: null });
    r.api.openSpawn(r.g);
    assert.equal(r.node('#sp-perm').kids[0].textContent, "Use this project's setting: default");
    assert.match(r.node('#sp-place').kids[0].textContent, /^Beside \(from Settings\)$/);
  });
});

// ---- effectiveAgents (public/dash-model.js, the page's copy of src/store.js effectiveAgents) -------------------------------------

describe('effectiveAgents: the page\'s view of what nika uses for a project', () => {
  test('(+) the project\'s value per item, Settings\' for the rest', () => {
    const s = settingsWith({ permissionMode: 'auto', maxAgents: 2 }, { panePlacement: 'under-last' });
    assert.deepEqual(effectiveAgents(s, KEY), { permissionMode: 'auto', panePlacement: 'under-last', maxAgents: 2 });
    assert.deepEqual(effectiveAgents(s, 'fedcba9876543210'), { permissionMode: 'default', panePlacement: 'under-last', maxAgents: 3 });
  });

  test('(−) no Settings yet, no project, or no perProject: the fixed defaults and Settings\' values', () => {
    assert.deepEqual(effectiveAgents(null, KEY), { permissionMode: 'default', panePlacement: 'beside', maxAgents: 3 });
    assert.deepEqual(effectiveAgents(undefined, undefined), { permissionMode: 'default', panePlacement: 'beside', maxAgents: 3 });
    assert.deepEqual(effectiveAgents({ permissionMode: 'plan', panePlacement: 'beside', limits: { maxAgents: 4 } }, KEY), { permissionMode: 'plan', panePlacement: 'beside', maxAgents: 4 });
  });
});

// ---- menuEl: a trigger with content, and a current item (ui.js) --------------------------------------------------------------------

describe('menuEl: optional trigger content and a current flag', () => {
  const noop = () => {};
  const button = (menu) => menu.all((n) => n.attrs['data-menu-btn'] !== undefined)[0];
  const lis = (menu) => menu.all((n) => n.tag === 'li');

  test('(+) a trigger replaces the "⋯" icon: its content is the button\'s, the label stays its aria-label, the class says it shows a value', () => {
    const menu = menuEl('Pane for demo-api: Beside', [{ text: 'Beside', run: noop }], 'agent-panePlacement', [h('span', { text: 'Beside' }), icon('chev')]);
    const b = button(menu);
    assert.equal(b.textContent, 'Beside');
    assert.equal(b.all((n) => n.tag === 'use')[0].attrs.href, '#i-chev');
    assert.equal(b.attrs['aria-label'], 'Pane for demo-api: Beside');
    assert.equal(b.attrs['data-fk'], 'agent-panePlacement');
    assert.equal(b.attrs['aria-expanded'], 'false');
    assert.equal(b.className, 'btn ghost menu-val');
    assert.equal(menu.all((n) => n.tag === 'ul')[0].className, 'menu menu-vals', 'a value menu gets its own class (no wrapping)');
  });

  test('(+) an item title becomes its tooltip; (−) a reason still wins over it', () => {
    const menu = menuEl('M', [{ text: 'A', run: noop, title: 'Long A', current: true }, { text: 'B', run: noop, title: 'Long B', reason: 'Not now.' }, { text: 'C', run: noop }], 'm', [h('span', { text: 'x' })]);
    assert.deepEqual(lis(menu).map((li) => li.kids[0].attrs.title), ['Long A', 'Not now.', undefined]);
  });

  test('(−) without a trigger the button is what it was: the "⋯" icon button, and no item is marked or given a check slot', () => {
    const menu = menuEl('More', [{ text: 'One', run: noop }, { text: 'Two', run: noop }], 'm');
    const b = button(menu);
    assert.equal(b.className, 'btn icon ghost');
    assert.equal(menu.all((n) => n.tag === 'ul')[0].className, 'menu', 'a row menu keeps the plain class');
    assert.equal(b.textContent, '⋯');
    assert.equal(b.all((n) => n.attrs['aria-hidden'] === 'true')[0].textContent, '⋯');
    for (const li of lis(menu)) {
      assert.equal(li.kids[0].attrs['aria-current'], undefined);
      assert.equal(li.all(withClass('menu-chk')).length, 0);
      assert.equal(li.all((n) => n.tag === 'use').length, 0);
    }
    assert.deepEqual(lis(menu).map((li) => li.kids[0].textContent), ['One', 'Two']);
  });

  test('(+) current: true marks that item (aria-current, a check icon); the others get an empty slot so the words line up', () => {
    const menu = menuEl('Pane', [{ text: 'Use Settings (Beside)', run: noop, current: false }, { text: 'Beside', run: noop, current: true }, { text: 'Under', run: noop }], 'm', [h('span', { text: 'x' })]);
    const [a, b, c] = lis(menu).map((li) => li.kids[0]);
    assert.deepEqual([a, b, c].map((x) => x.attrs['aria-current']), [undefined, 'true', undefined]);
    assert.deepEqual([a, b, c].map((x) => x.all((n) => n.tag === 'use').length), [0, 1, 0]);
    assert.equal(b.all((n) => n.tag === 'use')[0].attrs.href, '#i-check');
    assert.deepEqual([a, b, c].map((x) => x.all(withClass('menu-chk')).length), [1, 1, 1], 'a slot on every item once one item is flagged');
    assert.deepEqual([a, b, c].map((x) => x.textContent), ['Use Settings (Beside)', 'Beside', 'Under']);
    assert.equal(b.all(withClass('menu-chk'))[0].attrs['aria-hidden'], 'true');
  });

  test('(+) a click on a current-flagged item still runs it, and a reason still wins over run', () => {
    let ran = 0;
    const menu = menuEl('M', [{ text: 'A', run: () => { ran += 1; }, current: true }, { text: 'B', run: () => { ran += 10; }, reason: 'Not now.', current: false }], 'm');
    const [a, b] = lis(menu).map((li) => li.kids[0]);
    a.fire('click');
    assert.equal(ran, 1);
    b.fire('click');
    assert.equal(ran, 1);
    assert.equal(b.attrs['aria-disabled'], 'true');
  });
});

describe('app.css: the value menu', () => {
  test('(+) .menu-val and the check slot are styled; the existing menu rules are still there', () => {
    assert.match(APP_CSS, /\.menu-val\s*\{/);
    assert.match(APP_CSS, /\.menu-chk\s*\{/);
    assert.match(APP_CSS, /\.menu button, \.menu a \{/);
    assert.match(APP_CSS, /\.menu-vals button \{[^}]*white-space: nowrap/, 'a value-menu item never wraps: "Use Settings" and its chip stay on one line');
    assert.doesNotMatch(APP_CSS, /\.menu button, \.menu a \{[^}]*white-space: nowrap/, 'row menus (⋯) still wrap a long item');
    assert.match(APP_CSS, /\.kv dd \.from-set \{[^}]*display: block/, '"from Settings" is its own line under the value, never broken mid-phrase');
  });

  test('(+) "from Settings" carries the from-set class (its own line) and stays muted', () => {
    const card = rig({ loaded: settingsWith() }).card();
    for (const name of ROW_NAMES) assert.equal(rowOf(card, name).all(withClass('from-set'))[0]?.className, 'muted from-set', name);
  });
});

describe('index.html: Settings says a project can set its own', () => {
  const html = read('index.html');
  test('(+) the Permission mode and Panes and limits sections point at the project page', () => {
    assert.match(html, /<p>What new agents may do without asking\. A project can set its own on its page \(New agents\), and you can override it per agent when you spawn one\.<\/p>/);
    assert.match(html, /<h2 id="s-panes-h">Panes and limits<\/h2>\s*<p>Defaults for every project\. A project can set its own on its page \(New agents\)\.<\/p>/);
  });
  test('(−) Settings still offers no bypass mode', () => {
    assert.doesNotMatch(html, /name="perm" value="bypassPermissions"/);
  });
});
