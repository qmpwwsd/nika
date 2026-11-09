import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MODEL_ID } from '../src/ids.js';
import { MODEL_CATALOG } from '../src/models.js';
import { modelLabel } from '../src/model.js';

const ids = (group) => MODEL_CATALOG.filter((m) => m.group === group).map((m) => m.id);

describe('MODEL_CATALOG', () => {
  test('(+) latest, alias and older lists are exactly the documented ones, in order', () => {
    assert.deepEqual(MODEL_CATALOG.slice(0, 4).map((m) => [m.id, m.label, m.group]), [
      ['claude-fable-5-1', 'Fable 5.1', 'latest'], ['claude-opus-5-5', 'Opus 5.5', 'latest'],
      ['claude-sonnet-5-5', 'Sonnet 5.5', 'latest'], ['claude-haiku-5-5', 'Haiku 5.5', 'latest'],
    ]);
    assert.deepEqual(ids('alias'), ['best', 'fable', 'opus', 'sonnet', 'haiku', 'opusplan', 'opus[1m]', 'sonnet[1m]']);
    assert.deepEqual(ids('older'), [
      'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
    ]);
    assert.equal(MODEL_CATALOG.find((m) => m.id === 'opusplan').note, 'Opus in plan mode, Sonnet otherwise');
    assert.equal(MODEL_CATALOG.find((m) => m.id === 'opus[1m]').label, 'Opus, 1M context');
  });

  test('(+) catalog ids are unique, every group is latest|alias|older, entries are frozen', () => {
    assert.equal(new Set(MODEL_CATALOG.map((m) => m.id)).size, MODEL_CATALOG.length);
    for (const m of MODEL_CATALOG) {
      assert.ok(['latest', 'alias', 'older'].includes(m.group), m.id);
      assert.ok(typeof m.label === 'string' && m.label.length > 0, m.id);
      assert.ok(Object.isFrozen(m), m.id);
    }
    assert.ok(Object.isFrozen(MODEL_CATALOG));
  });

  test('(−) the catalog cannot be changed at runtime', () => {
    assert.throws(() => MODEL_CATALOG.push({ id: 'x', label: 'x', group: 'alias' }), TypeError);
    assert.throws(() => { MODEL_CATALOG[0].label = 'x'; }, TypeError);
  });
});

describe('MODEL_ID', () => {
  test('(+) accepts every catalog id', () => {
    for (const m of MODEL_CATALOG) assert.match(m.id, MODEL_ID, m.id);
  });

  test('(+) accepts opus[1m] and sonnet[1m], and still the old ids', () => {
    for (const id of ['opus[1m]', 'sonnet[1m]', 'haiku[1m]', 'claude-opus-5-5[1m]', 'opus', 'claude-haiku-4-5-20251001']) assert.match(id, MODEL_ID, id);
  });

  test('(−) refuses claude-;rm, #x, -opus, opus[2m], opusplan[1m]x and other shapes', () => {
    for (const id of ['claude-;rm', '#x', '-opus', 'opus[2m]', 'opusplan[1m]x', '[1m]', 'opus[1m][1m]', 'opus [1m]', 'opus[1M]', 'Opus', 'gpt-5', 'claude-', 'opus\n', '']) {
      assert.doesNotMatch(id, MODEL_ID, JSON.stringify(id));
    }
  });
});

describe('modelLabel', () => {
  test('(+) the catalog label wins', () => {
    assert.equal(modelLabel('opusplan'), 'Opus plan, Sonnet build');
    assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelLabel('best'), 'Best available');
    assert.equal(modelLabel('opus[1m]'), 'Opus, 1M context');
    assert.equal(modelLabel('sonnet'), 'Sonnet (latest)');
  });

  test('(+) ids that are not in the catalog keep the old derived label', () => {
    assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(modelLabel('claude-sonnet-5-5-20260101'), 'Sonnet 5.5');
  });

  test('(−) unknown ids stay as they are, empty gives null', () => {
    assert.equal(modelLabel('weird-model'), 'weird-model');
    assert.equal(modelLabel(null), null);
    assert.equal(modelLabel(''), null);
  });

  test('(−) a prototype key is not a catalog hit', () => {
    assert.equal(modelLabel('constructor'), 'constructor');
    assert.equal(modelLabel('__proto__'), '__proto__');
  });
});

// The page's model-id rule is public/models-ui.js MODEL_ID (Settings, the spawn sheet and the session window all use it).
// Task 12 removed the second copy that used to sit in public/ui.js RX.model, so one test pins the page copy to the server rule.
describe('the page copy of MODEL_ID', () => {
  test('(+) public/models-ui.js MODEL_ID equals the server rule, and public/ui.js keeps no copy of its own', async () => {
    const { MODEL_ID: PAGE } = await import('../public/models-ui.js');
    assert.equal(PAGE.source, MODEL_ID.source);
    assert.equal(PAGE.flags, MODEL_ID.flags);
    const ui = fs.readFileSync(new URL('../public/ui.js', import.meta.url), 'utf8');
    assert.doesNotMatch(ui, /\bmodel: \[\//);
  });
});
