// public/plugin-view.js: the pure model behind the project page's "Choose plugins" dialog (rows and their order, the filter, the
// counts, what Save sends). No DOM. Plugin names are synthetic (`<name>@demo-market`). Design: 0.3.4 section 2; docs/design/spec.md 3.15.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pluginView, pluginSave, sortIds, countText, filterNote } from '../public/plugin-view.js';

const A = 'alpha-lint@demo-market';
const B = 'beta-fmt@demo-market';
const C = 'Gamma-ci@other-market';
const D = 'delta@demo-market';
const INSTALLED = [A, B, C, D];
const ids = (v) => v.rows.map((r) => r.id);

describe('pluginView', () => {
  test('(+) rows are the installed plugins, ticked ones first (A to Z), then the rest (A to Z); no tick means plain A to Z', () => {
    assert.deepEqual(ids(pluginView({ installed: INSTALLED, picked: [], query: '' })), [A, B, D, C]);
    assert.deepEqual(ids(pluginView({ installed: INSTALLED, picked: [D, B], query: '' })), [B, D, A, C]);
    assert.deepEqual(ids(pluginView({ installed: [D, C, B, A], picked: new Set([C]), query: '' })), [C, A, B, D], 'a Set works as well as a list');
  });

  test('(+) a row carries the name, the marketplace, the full id and its flags', () => {
    const v = pluginView({ installed: INSTALLED, picked: [B], query: '' });
    assert.deepEqual(v.rows[0], { id: B, name: 'beta-fmt', market: 'demo-market', on: true, installed: true, shown: true });
    assert.deepEqual(v.rows[1], { id: A, name: 'alpha-lint', market: 'demo-market', on: false, installed: true, shown: true });
  });

  test('(+) the order stays where it was at open: ticking later changes `on`, not the position (opened)', () => {
    const opened = [B];
    const first = pluginView({ installed: INSTALLED, picked: opened, opened, query: '' });
    const later = pluginView({ installed: INSTALLED, picked: [B, D], opened, query: '' });
    assert.deepEqual(ids(later), ids(first));
    assert.deepEqual(later.rows.filter((r) => r.on).map((r) => r.id), [B, D]);
    const gone = pluginView({ installed: INSTALLED, picked: [], opened, query: '' });
    assert.deepEqual(ids(gone), ids(first), 'unticking the first row does not move it either');
  });

  test('(+) the filter is a case-insensitive substring of name@market, so it also finds the marketplace and the @ itself', () => {
    const shownIds = (query) => pluginView({ installed: INSTALLED, picked: [], query }).rows.filter((r) => r.shown).map((r) => r.id);
    assert.deepEqual(shownIds('LINT'), [A]);
    assert.deepEqual(shownIds('other-market'), [C]);
    assert.deepEqual(shownIds('gamma'), [C], 'Gamma-ci matches gamma');
    assert.deepEqual(shownIds('demo-market'), [A, B, D]);
    assert.deepEqual(shownIds('fmt@demo'), [B], 'the query may span the @');
    assert.deepEqual(shownIds('  beta  '), [B], 'spaces around the query are ignored');
  });

  test('(+) a ticked plugin that is not installed any more gets a row with installed:false, among the ticked ones', () => {
    const lost = 'lint-kit@demo-market';
    const v = pluginView({ installed: INSTALLED, picked: [lost, B], query: '' });
    assert.deepEqual(ids(v), [B, lost, A, D, C]);
    assert.deepEqual(v.rows.find((r) => r.id === lost), { id: lost, name: 'lint-kit', market: 'demo-market', on: true, installed: false, shown: true });
    assert.deepEqual(v.counts, { shown: 5, total: 5, on: 2, installed: 4 });
  });

  test('(+) the counts: rows shown, all rows, ticked rows (also hidden ones) and installed plugins', () => {
    const v = pluginView({ installed: INSTALLED, picked: [A, C], query: 'beta' });
    assert.deepEqual(v.counts, { shown: 1, total: 4, on: 2, installed: 4 });
    assert.deepEqual(v.rows.filter((r) => r.on).map((r) => [r.id, r.shown]), [[A, false], [C, false]], 'ticks hidden by the filter stay ticked');
  });

  test('(−) an empty or blank query shows every row', () => {
    for (const query of ['', '   ', undefined]) {
      const v = pluginView({ installed: INSTALLED, picked: [], query });
      assert.equal(v.rows.every((r) => r.shown), true, JSON.stringify(query));
      assert.equal(v.counts.shown, 4);
    }
  });

  test('(−) a query with no match shows no row, keeps the rows and their ticks, and counts 0 shown', () => {
    const v = pluginView({ installed: INSTALLED, picked: [A], query: 'zzz' });
    assert.equal(v.rows.length, 4);
    assert.equal(v.rows.some((r) => r.shown), false);
    assert.deepEqual(v.counts, { shown: 0, total: 4, on: 1, installed: 4 });
    assert.equal(v.rows.find((r) => r.id === A).on, true);
  });

  test('(−) no plugins at all gives no rows; duplicates and values that are not strings are ignored', () => {
    assert.deepEqual(pluginView({ installed: [], picked: [], query: '' }), { rows: [], counts: { shown: 0, total: 0, on: 0, installed: 0 } });
    assert.deepEqual(pluginView({}), { rows: [], counts: { shown: 0, total: 0, on: 0, installed: 0 } });
    const v = pluginView({ installed: [A, A, 5, null, {}, B], picked: [A, A, undefined, 7], query: '' });
    assert.deepEqual(ids(v), [A, B]);
    assert.equal(v.counts.on, 1);
  });

  test('(−) a regular expression character in the query is plain text', () => {
    const v = pluginView({ installed: [A, 'a.b@demo-market'], picked: [], query: 'a.b' });
    assert.deepEqual(v.rows.filter((r) => r.shown).map((r) => r.id), ['a.b@demo-market']);
    assert.equal(pluginView({ installed: [A], picked: [], query: '.*' }).counts.shown, 0);
  });
});

describe('pluginSave', () => {
  test('(+) sends the ticked plugins sorted, once', () => {
    assert.deepEqual(pluginSave([], [D, A, B, A]), [A, B, D]);
    assert.deepEqual(pluginSave([A], new Set([B, A])), [A, B]);
  });

  test('(+) unticking everything sends [] when a list was saved', () => {
    assert.deepEqual(pluginSave([A, B], []), []);
  });

  test('(−) the same set (in any order, with repeats) is no change: null, so no request goes out', () => {
    assert.equal(pluginSave([A, B], [B, A]), null);
    assert.equal(pluginSave([A, B, A], new Set([A, B])), null);
    assert.equal(pluginSave([], []), null);
    assert.equal(pluginSave([], new Set()), null);
  });

  test('(−) a different set of the same size is a change', () => {
    assert.deepEqual(pluginSave([A, B], [A, D]), [A, D]);
  });
});

describe('sortIds, countText, filterNote', () => {
  test('(+) sortIds is A to Z without regard to case and leaves its input alone', () => {
    const input = [D, C, B, A];
    assert.deepEqual(sortIds(input), [A, B, D, C]);
    assert.deepEqual(input, [D, C, B, A]);
  });

  test('(+) the count line: "<on> on · <n> installed", filtered "Showing <k> of <n> · <on> on"', () => {
    const all = pluginView({ installed: INSTALLED, picked: [A, B, D], query: '' });
    assert.equal(countText(all, ''), '3 on · 4 installed');
    const some = pluginView({ installed: INSTALLED, picked: [A, B, D], query: 'demo' });
    assert.equal(countText(some, 'demo'), 'Showing 3 of 4 · 3 on');
    assert.equal(countText(pluginView({ installed: INSTALLED, picked: [], query: '' }), ''), '0 on · 4 installed');
  });

  test('(−) a blank query counts as no filter, and a query with no match still reads "Showing 0 of n"', () => {
    const v = pluginView({ installed: INSTALLED, picked: [], query: '  ' });
    assert.equal(countText(v, '  '), '0 on · 4 installed');
    const none = pluginView({ installed: INSTALLED, picked: [A], query: 'zzz' });
    assert.equal(countText(none, 'zzz'), 'Showing 0 of 4 · 1 on');
  });

  test('(+) the spoken note after typing: "<k> plugins shown", "1 plugin shown", "No plugin matches"', () => {
    assert.equal(filterNote(pluginView({ installed: INSTALLED, picked: [], query: 'demo' })), '3 plugins shown');
    assert.equal(filterNote(pluginView({ installed: INSTALLED, picked: [], query: 'beta' })), '1 plugin shown');
    assert.equal(filterNote(pluginView({ installed: INSTALLED, picked: [], query: 'zzz' })), 'No plugin matches');
  });
});
