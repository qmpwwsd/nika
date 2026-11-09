// public/models-ui.js: the model dropdown's pure parts (groups, catalog membership, id shape) and the select filler on a tiny
// fake DOM. Design: docs/design/spec.md section 9.4 (model popover) and docs/superpowers/specs/2026-11-08-control-panel-design.md 6.9.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_ID as SERVER_MODEL_ID } from '../src/ids.js';
import { MODEL_CATALOG } from '../src/models.js';
import { MODEL_ID, CUSTOM, MODEL_HINT, modelGroups, isCatalogId, fillModelSelect } from '../public/models-ui.js';

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
