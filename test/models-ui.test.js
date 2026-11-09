// public/models-ui.js: the model dropdown's pure parts (groups, catalog membership, id shape) and the select filler on a tiny
// fake DOM. Design: docs/design/spec.md section 9.4 (model popover) and docs/superpowers/specs/2026-11-08-control-panel-design.md 6.9.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_ID as SERVER_MODEL_ID } from '../src/ids.js';
import { MODEL_CATALOG } from '../src/models.js';
import { defaults, effectiveModels } from '../src/store.js';
import { MODEL_ID, CUSTOM, MODEL_HINT, ROLES, ROLE_LABEL, modelGroups, isCatalogId, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels } from '../public/models-ui.js';

class FNode {
  constructor(tag, text = '') {
    this.tag = tag; this.text = text; this.kids = []; this.attrs = {}; this.className = ''; this.value = '';
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return this.attrs[k] ?? null; }

  append(...nodes) { this.kids.push(...nodes); }

  replaceChildren(...nodes) { this.kids = nodes; }

  addEventListener() {}

  set textContent(v) { this.kids = []; this.text = String(v); }

  get textContent() { return this.text + this.kids.map((k) => k.textContent).join(''); }

  find(pred) {
    const out = [];
    const walk = (n) => { if (pred(n)) out.push(n); n.kids.forEach(walk); };
    walk(this);
    return out;
  }
}

let saved;
before(() => {
  saved = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = FNode;
  globalThis.document = { createElement: (tag) => new FNode(tag), createTextNode: (t) => new FNode('#text', t) };
});
after(() => {
  globalThis.document = saved.document;
  globalThis.Node = saved.Node;
});

const m = (id, label, group, note) => (note ? { id, label, group, note } : { id, label, group });
const SMALL = [m('claude-b-1', 'B 1', 'older'), m('opus', 'Opus (latest)', 'alias'), m('claude-a-2', 'A 2', 'latest'), m('best', 'Best', 'alias'), m('claude-a-1', 'A 1', 'latest')];

describe('modelGroups', () => {
  test('(+) keeps catalog order in three groups: Latest, Aliases, Older', () => {
    const g = modelGroups(MODEL_CATALOG);
    assert.deepEqual(g.map((x) => x.label), ['Latest', 'Aliases', 'Older']);
    assert.deepEqual(g.map((x) => x.key), ['latest', 'alias', 'older']);
    assert.deepEqual(g.flatMap((x) => x.models.map((y) => y.id)), MODEL_CATALOG.map((y) => y.id), 'the real catalog is already grouped, so nothing moves');
    assert.deepEqual(g[1].models.map((y) => y.id), ['best', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan', 'opus[1m]', 'sonnet[1m]']);
  });

  test('(+) within a group the catalog order is kept even when the groups are interleaved', () => {
    const g = modelGroups(SMALL);
    assert.deepEqual(g.map((x) => x.models.map((y) => y.id)), [['claude-a-2', 'claude-a-1'], ['opus', 'best'], ['claude-b-1']]);
  });

  test('(−) an empty group is left out, so no empty optgroup is drawn', () => {
    assert.deepEqual(modelGroups([m('opus', 'Opus', 'alias')]).map((x) => x.key), ['alias']);
    assert.deepEqual(modelGroups([]), []);
  });

  test('(−) malformed input never throws: non-arrays, bad entries, unknown groups and ids that are not a model id are dropped', () => {
    for (const bad of [null, undefined, 'x', 7, {}]) assert.deepEqual(modelGroups(bad), [], String(bad));
    const mixed = [null, 'x', { id: 'opus' }, { id: 'opus', label: 'Opus', group: 'nope' }, { id: 'rm -rf', label: 'x', group: 'alias' },
      { id: '__proto__', label: 'x', group: 'alias' }, m('sonnet', 'Sonnet', 'alias')];
    assert.deepEqual(modelGroups(mixed).flatMap((x) => x.models.map((y) => y.id)), ['sonnet']);
  });
});

describe('isCatalogId', () => {
  test("(+) isCatalogId('opus[1m]') and every id of the real catalog", () => {
    assert.equal(isCatalogId('opus[1m]', MODEL_CATALOG), true);
    for (const x of MODEL_CATALOG) assert.equal(isCatalogId(x.id, MODEL_CATALOG), true, x.id);
  });

  test("(−) isCatalogId('claude-foo-9') === false: a valid-looking id that is not listed", () => {
    assert.equal(isCatalogId('claude-foo-9', MODEL_CATALOG), false);
    assert.equal(isCatalogId('claude-foo-9', MODEL_CATALOG.map((x) => x)), false);
  });

  test('(−) empty, non-string, prototype names and a missing catalog are all false', () => {
    for (const bad of ['', null, undefined, 3, {}, ['opus'], '__proto__', 'toString', 'constructor', ' opus', 'Opus']) assert.equal(isCatalogId(bad, MODEL_CATALOG), false, String(bad));
    assert.equal(isCatalogId('opus', null), false);
    assert.equal(isCatalogId('opus', 'opus'), false);
  });
});

describe('MODEL_ID', () => {
  test('(+) is the server rule (src/ids.js), so the page and the route never disagree', () => {
    assert.equal(MODEL_ID.source, SERVER_MODEL_ID.source);
    assert.equal(MODEL_ID.flags, SERVER_MODEL_ID.flags);
  });

  test('(+) accepts ids and aliases, (−) refuses shell-looking and spaced text', () => {
    for (const ok of ['claude-sonnet-5-5', 'opus', 'sonnet[1m]', 'opusplan', 'best']) assert.ok(MODEL_ID.test(ok), ok);
    for (const bad of ['', 'opus plan', 'opus; ls', 'claude-', '$(x)', 'claude-sonnet-5-5\n', 'opus[2m]']) assert.equal(MODEL_ID.test(bad), false, JSON.stringify(bad));
  });

  test('(+) the custom-field hint is the spec copy', () => {
    assert.equal(MODEL_HINT, 'Use a model id such as claude-sonnet-5-5, or an alias such as opus or sonnet[1m].');
  });
});

describe('fillModelSelect', () => {
  const groupsOf = (sel) => sel.kids.filter((k) => k.tag === 'optgroup');

  test('(+) three optgroups in order, then Custom ID last; latest options show label and id, others the id', () => {
    const sel = new FNode('select');
    const custom = fillModelSelect(sel, MODEL_CATALOG, 'claude-sonnet-5-5');
    assert.equal(custom, false);
    const groups = groupsOf(sel);
    assert.deepEqual(groups.map((g) => g.getAttribute('label')), ['Latest', 'Aliases', 'Older']);
    assert.equal(sel.kids.at(-1).tag, 'option');
    assert.equal(sel.kids.at(-1).getAttribute('value'), CUSTOM);
    assert.equal(sel.kids.at(-1).textContent, 'Custom ID…');
    assert.equal(groups[0].kids[2].textContent, 'Sonnet 5.5 (claude-sonnet-5-5)');
    assert.equal(groups[1].kids[0].textContent, 'best');
    assert.equal(groups[2].kids[0].textContent, 'claude-fable-5');
    assert.equal(sel.value, 'claude-sonnet-5-5');
  });

  test('(+) an alias with a note keeps the note as the option title', () => {
    const sel = new FNode('select');
    fillModelSelect(sel, MODEL_CATALOG, 'opusplan');
    const opt = groupsOf(sel)[1].kids.find((o) => o.getAttribute('value') === 'opusplan');
    assert.equal(opt.getAttribute('title'), 'Opus in plan mode, Sonnet otherwise');
    assert.equal(sel.value, 'opusplan');
  });

  test('(−) a model that is not in the catalog selects Custom ID and says so (the caller fills the field)', () => {
    const sel = new FNode('select');
    assert.equal(fillModelSelect(sel, MODEL_CATALOG, 'claude-foo-9'), true);
    assert.equal(sel.value, CUSTOM);
    assert.equal(fillModelSelect(sel, MODEL_CATALOG, null), true, 'no model known: nothing is preselected');
    assert.equal(sel.value, CUSTOM);
  });

  test('(−) an empty or broken catalog still gives the Custom option, and refilling replaces the old options', () => {
    const sel = new FNode('select');
    fillModelSelect(sel, MODEL_CATALOG, 'opus');
    fillModelSelect(sel, null, 'opus');
    assert.deepEqual(sel.kids.map((k) => k.tag), ['option']);
    assert.equal(sel.value, CUSTOM);
  });

  test('(−) server text only ever lands in text nodes and attributes', () => {
    const sel = new FNode('select');
    fillModelSelect(sel, [m('opus', '<img src=x onerror=alert(1)>', 'alias')], 'opus');
    const opt = groupsOf(sel)[0].kids[0];
    assert.equal(opt.textContent, 'opus', 'aliases show the id, never the label');
    const latest = new FNode('select');
    fillModelSelect(latest, [m('claude-a-1', '<b>x</b>', 'latest')], 'claude-a-1');
    assert.equal(groupsOf(latest)[0].kids[0].textContent, '<b>x</b> (claude-a-1)');
    assert.equal(groupsOf(latest)[0].kids[0].kids.every((k) => k.tag === '#text'), true);
  });
});

describe('fillRoleOverride (the project\'s Models dialog)', () => {
  const DEFAULT = 'claude-fable-5-1';
  const first = (sel) => sel.kids[0];

  test('(+) the first option is Use default (<catalog label>) with an empty value, and a null current selects it without Custom ID', () => {
    const sel = new FNode('select');
    assert.equal(fillRoleOverride(sel, MODEL_CATALOG, null, DEFAULT), false);
    assert.equal(first(sel).tag, 'option');
    assert.equal(first(sel).getAttribute('value'), '');
    assert.equal(first(sel).textContent, 'Use default (Fable 5.1)');
    assert.equal(sel.value, '');
    assert.deepEqual(sel.kids.slice(1).map((k) => k.getAttribute('label') ?? `#${k.getAttribute('value')}`), ['Latest', 'Aliases', 'Older', `#${CUSTOM}`]);
  });

  test('(+) a catalog id is selected, an alias too; neither asks for the Custom ID field', () => {
    const sel = new FNode('select');
    assert.equal(fillRoleOverride(sel, MODEL_CATALOG, 'claude-opus-5-5', DEFAULT), false);
    assert.equal(sel.value, 'claude-opus-5-5');
    assert.equal(fillRoleOverride(sel, MODEL_CATALOG, 'sonnet[1m]', DEFAULT), false);
    assert.equal(sel.value, 'sonnet[1m]');
  });

  test('(+) a default that is not in the catalog shows its id, an alias default its catalog label', () => {
    const sel = new FNode('select');
    fillRoleOverride(sel, MODEL_CATALOG, null, 'claude-private-9');
    assert.equal(first(sel).textContent, 'Use default (claude-private-9)');
    fillRoleOverride(sel, MODEL_CATALOG, null, 'opus');
    assert.equal(first(sel).textContent, 'Use default (Opus (latest))');
  });

  test('(−) a current id that is not in the catalog selects Custom ID and says so (the caller fills the field)', () => {
    const sel = new FNode('select');
    assert.equal(fillRoleOverride(sel, MODEL_CATALOG, 'claude-private-9', DEFAULT), true);
    assert.equal(sel.value, CUSTOM);
  });

  test('(−) without a catalog the select offers Use default and Custom ID only; null still selects Use default, and refilling replaces the options', () => {
    const sel = new FNode('select');
    for (const bad of [null, undefined, 'x', {}]) {
      assert.equal(fillRoleOverride(sel, bad, null, DEFAULT), false, String(bad));
      assert.deepEqual(sel.kids.map((k) => k.getAttribute('value')), ['', CUSTOM]);
      assert.equal(sel.value, '');
      assert.equal(first(sel).textContent, 'Use default (claude-fable-5-1)', 'no label to show: the id');
    }
    assert.equal(fillRoleOverride(sel, null, 'opus', DEFAULT), true, 'a saved id with no catalog opens as Custom ID');
  });

  test('(−) catalog text only ever lands in text nodes; an undefined or empty current is the default, not Custom ID', () => {
    const sel = new FNode('select');
    fillRoleOverride(sel, [m('claude-a-1', '<b>x</b>', 'latest')], null, 'claude-a-1');
    assert.equal(first(sel).textContent, 'Use default (<b>x</b>)');
    assert.equal(first(sel).kids.every((k) => k.tag === '#text'), true);
    for (const empty of [undefined, '']) assert.equal(fillRoleOverride(sel, MODEL_CATALOG, empty, DEFAULT), false, JSON.stringify(empty));
  });
});

describe('modelLabel', () => {
  test('(+) the catalog label of an id, (−) null for an id that is not listed, a non-string or a missing catalog', () => {
    assert.equal(modelLabel('claude-opus-5-5', MODEL_CATALOG), 'Opus 5.5');
    assert.equal(modelLabel('opus[1m]', MODEL_CATALOG), 'Opus, 1M context');
    for (const bad of ['claude-private-9', '', null, undefined, 5, '__proto__']) assert.equal(modelLabel(bad, MODEL_CATALOG), null, String(bad));
    assert.equal(modelLabel('opus', null), null);
  });
});

describe('ROLES', () => {
  test('(+) the four roles in the order the page lists them, each with a label; (−) the same set as the server\'s defaults', () => {
    assert.deepEqual(ROLES, ['orchestrator', 'reasoner', 'builder', 'scout']);
    assert.deepEqual(ROLES.map((r) => ROLE_LABEL[r]), ['Orchestrator', 'Reasoner', 'Builder', 'Scout']);
    assert.deepEqual(Object.keys(defaults().models), ROLES);
  });
});

// One table, two implementations: the server's effectiveModels (src/store.js) and the page's effectiveRoleModels must agree on every case.
const DEFAULTS = { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-sonnet-5-5', scout: 'claude-haiku-5-5' };
const KEY = '0123456789abcdef';
const EFFECTIVE_CASES = [
  ['no entry for the project: the defaults', {}, { ...DEFAULTS }],
  ['one role overridden: it wins, the rest stay default', { models: { builder: 'claude-opus-5-5' } }, { ...DEFAULTS, builder: 'claude-opus-5-5' }],
  ['all four overridden', { models: { orchestrator: 'opus', reasoner: 'sonnet[1m]', builder: 'haiku', scout: 'best' } }, { orchestrator: 'opus', reasoner: 'sonnet[1m]', builder: 'haiku', scout: 'best' }],
  ['an entry with no models: the defaults', { plugins: ['a@demo-market'] }, { ...DEFAULTS }],
  ['an override equal to the default changes nothing', { models: { scout: 'claude-haiku-5-5' } }, { ...DEFAULTS }],
  ['a Custom ID outside the catalog is used as it is', { models: { scout: 'claude-private-9' } }, { ...DEFAULTS, scout: 'claude-private-9' }],
];

describe('effectiveRoleModels mirrors the server\'s effectiveModels', () => {
  for (const [name, entry, want] of EFFECTIVE_CASES) {
    test(`(+) ${name}`, () => {
      const config = { models: { ...DEFAULTS }, perProject: Object.keys(entry).length ? { [KEY]: entry } : {} };
      assert.deepEqual(effectiveModels(config, KEY), want, 'server');
      assert.deepEqual(effectiveRoleModels(config, KEY), want, 'page');
    });
  }

  test('(+) another project\'s override never reaches this one, and the settings object is not changed', () => {
    const settings = { models: { ...DEFAULTS }, perProject: { fedcba9876543210: { models: { builder: 'opus' } } } };
    const before = JSON.stringify(settings);
    assert.deepEqual(effectiveRoleModels(settings, KEY), DEFAULTS);
    assert.deepEqual(effectiveModels(settings, KEY), DEFAULTS);
    assert.equal(JSON.stringify(settings), before);
  });

  test('(−) missing pieces never throw: no settings, no models, no perProject, an unknown or odd key', () => {
    for (const bad of [null, undefined, {}, 'x', 5]) assert.deepEqual(effectiveRoleModels(bad, KEY), { orchestrator: null, reasoner: null, builder: null, scout: null }, String(bad));
    assert.deepEqual(effectiveRoleModels({ models: DEFAULTS }, KEY), DEFAULTS, 'no perProject: the defaults');
    assert.deepEqual(effectiveRoleModels({ perProject: { [KEY]: { models: { scout: 'haiku' } } } }, KEY), { orchestrator: null, reasoner: null, builder: null, scout: 'haiku' }, 'no defaults: only the override');
    for (const key of ['__proto__', 'constructor', 'toString', '', undefined, null]) assert.deepEqual(effectiveRoleModels({ models: DEFAULTS, perProject: {} }, key), DEFAULTS, String(key));
  });

  test('(−) a role the project did not set is null, never undefined, and extra roles in the entry are not copied', () => {
    const out = effectiveRoleModels({ models: { orchestrator: 'a-b-c' }, perProject: { [KEY]: { models: { helper: 'opus' } } } }, KEY);
    assert.deepEqual(Object.keys(out), ROLES);
    assert.equal(out.scout, null);
  });
});
