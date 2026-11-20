// src/place.js (0.5.4, P1): the pure placement rule. Synthetic listings only; the sizes are the ones tmux 3.8 gave in spike S-P1.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_COLS, MIN_ROWS, AGENTS_WINDOW, PLACE_FORMAT, COLLECTOR_FIELDS, parsePlaceRows, readPlaceListing, isStrictPaneListing, parentTags, COLLECTOR_PARENT_FIELD, tiledGrid, cell, fitsH, fitsV, tileFits, place, isAgentsWindow } from '../src/place.js';

const KEY = 'k0123456789abcde';
const OTHER = 'z9876543210fedcb';
const tag = (name, key = KEY) => `${key}/${name}`;

/** One window of a synthetic listing: `panes` are overrides of a default row; the window fields are filled into every row. */
// (`cur` is #{pane_active}: the first pane of a window is its active pane unless a test says otherwise)
const win = (id, o, panes) => panes.map((p, i) => ({
  pane: '%1', win: id, index: 0, active: 0, panes: panes.length, zoomed: 0, ww: 200, wh: 50, dead: 0, cur: i === 0 ? 1 : 0, role: '', agent: '', fit: '', ...o, w: 200, h: 50, ...p,
}));
const line = (r) => [r.pane, r.win, r.index, r.active, r.panes, r.zoomed, r.ww, r.wh, r.w, r.h, r.dead, r.cur, r.role, r.agent, r.fit].join('\t');
const text = (...windows) => `${windows.flat().map(line).join('\n')}\n`;
const rowsOf = (...windows) => parsePlaceRows(text(...windows));
const orch = (pane, o = {}) => ({ pane, role: 'orchestrator', agent: tag('orchestrator'), ...o });
const agent = (pane, name, o = {}) => ({ pane, role: 'agent', agent: tag(name), ...o });
const sub = (pane, name, o = {}) => ({ pane, role: 'sub-orchestrator', agent: tag(name), ...o });

const run = (windows, o = {}) => place({ rows: rowsOf(...windows), key: KEY, ...o });
const split = (target, dir, tile, placement, extra = {}) => ({ op: 'split', target, dir, tile, placement, ...extra });
const WINDOW = { op: 'window', placement: 'window' };

// the orchestrator's window: `%1` and one agent, as a first spawn leaves it (orchestrator 100 | agent 99 at 200 x 50)
const FULL_HOME = (o = {}) => win('@1', { active: 1, ...o }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 99 })]);
// an agents window with one agent, 200 x 50: it has room for another (grid 2 x 1)
const AGENTS = (id = '@2', o = {}, panes = [agent('%21', 'a2')]) => win(id, { index: 1, ...o }, panes);

describe('place: the constants and the listing format', () => {
  test('P-0 (+) the floor is 80 x 15, the window is called agents, and the format has 15 fields with the user-written tags last', () => {
    assert.deepEqual([MIN_COLS, MIN_ROWS, AGENTS_WINDOW], [80, 15, 'agents']);
    assert.equal(AGENTS_WINDOW.includes('#'), false, 'tmux format-expands new-window -n');
    const fields = PLACE_FORMAT.split('\t');
    assert.equal(fields.length, 15);
    assert.equal(fields[11], '#{pane_active}', 'the active pane is read as a flag before the three tags');
    assert.deepEqual(fields.slice(-3), ['#{@nika-role}', '#{@nika-agent}', '#{@nika-fit}']);
    assert.ok(fields.every((f) => /^#\{@?[a-z_-]+\}$/.test(f)));
  });

  test('P-0 (+) a valid row parses to its fields; role, tag and fit are kept only as the words nika uses', () => {
    const [r, ...rest] = parsePlaceRows(text(win('@4', { index: 3, active: 1 }, [agent('%12', 'worker', { w: 99, h: 24, fit: 'abc' })])));
    assert.deepEqual(rest, []);
    assert.deepEqual(r, { pane: '%12', win: '@4', index: 3, active: 1, panes: 1, zoomed: 0, ww: 200, wh: 50, w: 99, h: 24, dead: 0, current: 1, role: 'agent', key: KEY, fit: true });
    // a role that is not one of the three words is '', a tag that does not parse has no key: the text itself is never kept
    const [x] = parsePlaceRows(text(win('@1', {}, [{ pane: '%1', role: 'weird\u0007', agent: 'not a tag' }])));
    assert.deepEqual([x.role, x.key, x.fit], ['', null, false]);
  });

  test('P-0 (\u2212) a row that fails any check is dropped: field count, ids, numbers, flags', () => {
    const good = line(win('@1', {}, [{ pane: '%1' }])[0]).split('\t');
    const bad = (i, v) => good.map((f, j) => (j === i ? v : f)).join('\t');
    const cases = [
      good.slice(0, 14).join('\t'), [...good, 'extra'].join('\t'), '', 'junk',
      bad(0, '%x'), bad(0, '%1234567'), bad(0, '1'), bad(1, '@'), bad(1, '@1234567'), bad(1, '%1'),
      bad(2, '-1'), bad(2, '10001'), bad(2, ''), bad(2, '1.5'), bad(4, 'two'), bad(6, '99999'), bad(8, ' 80'), bad(9, '1e2'),
      bad(3, '2'), bad(3, ''), bad(5, 'yes'), bad(10, '2'), bad(10, ''), bad(11, '2'), bad(11, ''), bad(11, 'yes'),
    ];
    for (const c of cases) assert.deepEqual(parsePlaceRows(`${c}\n`), [], JSON.stringify(c));
    assert.equal(parsePlaceRows(`${good.join('\t')}\n`).length, 1);
    assert.equal(parsePlaceRows(bad(2, '10000')).length, 1, 'the upper bound is 10000');
  });

  test('P-0 (\u2212) a tab or a newline in a tag changes the field count, so that row is dropped (a crafted continuation can still parse as a row of its own: see P-7, which makes such a listing untrusted)', () => {
    const a = win('@1', { active: 1 }, [orch('%1'), agent('%2', 'a1')]);
    const forgedTab = a.map((r) => (r.pane === '%2' ? { ...r, agent: `${tag('a1')}\tx` } : r));
    assert.deepEqual(parsePlaceRows(text(forgedTab)).map((r) => r.pane), ['%1']);
    const forgedNewline = a.map((r) => (r.pane === '%2' ? { ...r, agent: `${tag('a1')}\nsplit` } : r));
    assert.deepEqual(parsePlaceRows(text(forgedNewline)).map((r) => r.pane), ['%1'], 'the 14-field first half and the 1-field second half are both dropped');
    // a forged fit text keeps the pane's row, with fit set (the window is then never split into)
    const fit = a.map((r) => (r.pane === '%2' ? { ...r, fit: 'x\ny' } : r));
    assert.deepEqual(parsePlaceRows(text(fit)).map((r) => [r.pane, r.fit]), [['%1', false], ['%2', true]]);
  });
});

describe('place: the tiled grid and the fit tests', () => {
  test('P-1 (+) tiledGrid(n) is tmux\'s grid for n = 1..10 (spike S-P1a, tmux 3.8)', () => {
    const table = { 1: [1, 1], 2: [2, 1], 3: [2, 2], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [3, 3], 8: [3, 3], 9: [3, 3], 10: [4, 3] };
    for (const [n, [rows, cols]] of Object.entries(table)) assert.deepEqual(tiledGrid(Number(n)), { rows, cols }, `n=${n}`);
  });

  test('P-1 (+) cell() is the smallest pane tmux made: 200 x 50 for n = 1..10 and 120 x 40 for n = 1..6 (spike S-P1a)', () => {
    const measure = (w, h, n) => { const g = tiledGrid(n); return [cell(w, g.cols), cell(h, g.rows)]; };
    const at200 = [[200, 50], [200, 24], [99, 24], [99, 24], [99, 16], [99, 16], [66, 16], [66, 16], [66, 16], [66, 11]];
    at200.forEach((want, i) => assert.deepEqual(measure(200, 50, i + 1), want, `200x50 n=${i + 1}`));
    const at120 = [[120, 40], [120, 19], [59, 19], [59, 19], [59, 12], [59, 12]];
    at120.forEach((want, i) => assert.deepEqual(measure(120, 40, i + 1), want, `120x40 n=${i + 1}`));
  });

  test('P-2 (+) fitsH and fitsV at the boundary: both halves keep 80 columns or 15 rows', () => {
    assert.equal(fitsH({ w: 161, h: 15 }), true);
    assert.equal(fitsH({ w: 160, h: 15 }), false, 'a split of 160 leaves 80 and 79');
    assert.equal(fitsH({ w: 161, h: 14 }), false);
    assert.equal(fitsV({ w: 80, h: 31 }), true);
    assert.equal(fitsV({ w: 80, h: 30 }), false, 'a split of 30 leaves 15 and 14');
    assert.equal(fitsV({ w: 79, h: 31 }), false);
    // the pane that is split must itself be wide enough for a vertical split, and tall enough for a horizontal one
    assert.equal(fitsH({ w: 400, h: 14 }), false);
    assert.equal(fitsV({ w: 79, h: 100 }), false);
  });

  test('P-2 (+) tileFits: 200 x 50 takes 6 panes and refuses the 7th; 120 x 40 takes 2 and refuses the 3rd', () => {
    const w = (n, ww, wh) => ({ count: n, w: ww, h: wh });
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => tileFits(w(n, 200, 50))), [true, true, true, true, true]);
    assert.equal(tileFits(w(5, 200, 50)), true, 'the 6th pane: grid 3 x 2, cells 99 x 16');
    assert.equal(tileFits(w(6, 200, 50)), false, 'the 7th: 3 x 3, 66 columns');
    assert.equal(tileFits(w(1, 120, 40)), true);
    assert.equal(tileFits(w(2, 120, 40)), false, 'the 3rd: 2 x 2, 59 columns');
    assert.equal(tileFits(w(1, 200, 31)), true, 'the 2nd: 2 x 1, cells 200 x 15');
    assert.equal(tileFits(w(1, 200, 30)), false, 'cells 200 x 14');
    assert.equal(tileFits(w(1, 159, 50)), true, 'the 2nd of a 2 x 1 grid only needs the width once');
    assert.equal(tileFits(w(1, 79, 50)), false);
    // the boundary of a 2 x 2 grid (the 3rd pane): cells floor((w-1)/2) wide and floor((h-1)/2) high must be 80 x 15 or more
    assert.equal(tileFits(w(2, 161, 31)), true, 'cells 80 x 15 exactly');
    assert.equal(tileFits(w(2, 160, 31)), false, 'cells 79 x 15');
    assert.equal(tileFits(w(2, 161, 30)), false, 'cells 80 x 14');
  });
});

describe('place: the rule order', () => {
  test('P-3 (+) 1. beside: the orchestrator alone at 200 x 50 gets the agent beside it', () => {
    assert.deepEqual(run([win('@1', { active: 1 }, [orch('%1')])], { parent: '%1' }), split('%1', '-h', null, 'beside'));
  });

  test('P-3 (+) 2. the second agent: 100 | 99 has no room beside, so a new window', () => {
    assert.deepEqual(run([FULL_HOME()], { parent: '%1' }), WINDOW);
  });

  test('P-3 (+) 3. the third agent joins the agents window and tiles it (200 >= 2 x 50, so -h)', () => {
    assert.deepEqual(run([FULL_HOME(), AGENTS()], { parent: '%1' }), split('%21', '-h', '@2', 'tiled'));
  });

  test('P-3 (+) 4. at 400 x 50 the split lands on the newest agent pane, never on the orchestrator', () => {
    const home = win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 200 }), agent('%20', 'a1', { w: 199 })]);
    assert.deepEqual(run([home], { parent: '%1' }), split('%20', '-h', null, 'beside'));
    // widest first, the newer pane (higher number) on a tie
    const two = win('@1', { active: 1, ww: 800 }, [orch('%1', { w: 200 }), agent('%20', 'a1', { w: 300 }), agent('%22', 'a2', { w: 300 }), agent('%21', 'a3', { w: 100 })]);
    assert.deepEqual(run([two], { parent: '%1' }), split('%22', '-h', null, 'beside'));
  });

  test('P-3 (+) 5. under-last: the pane .last-pane names, while both halves keep 15 rows', () => {
    const home = win('@1', { active: 1 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 99 })]);
    assert.deepEqual(run([home], { parent: '%1', placement: 'under-last', last: '%20' }), split('%20', '-v', null, 'under'));
    assert.deepEqual(run([home], { parent: '%1', placement: 'beside', last: '%20' }), WINDOW, 'the setting beside ignores .last-pane');
    assert.deepEqual(run([home], { parent: '%1', placement: 'under-last', last: null }), WINDOW, 'no .last-pane: the beside rule');
    assert.deepEqual(run([home], { parent: '%1', placement: 'under-last', last: '%99' }), WINDOW, 'a .last-pane that is not in the listing');
  });

  test('P-3 (+) 6. explicit under with room: -v -t under, no moved flag; without room: placed by the setting, moved', () => {
    const roomy = win('@1', { active: 1 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 99, h: 31 })]);
    assert.deepEqual(run([roomy], { parent: '%1', under: '%20' }), split('%20', '-v', null, 'under'));
    const tight = win('@1', { active: 1 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 80, h: 20 })]);
    assert.deepEqual(run([tight], { parent: '%1', under: '%20' }), { ...WINDOW, moved: true });
    assert.deepEqual(run([win('@1', { active: 1 }, [orch('%1'), agent('%20', 'a1', { w: 80, h: 20 })])], { parent: '%1', under: '%20' }), split('%1', '-h', null, 'beside', { moved: true }),
      'by the setting: beside the parent');
    assert.deepEqual(run([tight], { parent: '%1', under: '%77' }), { ...WINDOW, moved: true }, 'an under pane that is not in the listing');
  });

  test('P-3 (+) 6b. explicit under with no room, setting under-last, a roomy .last-pane: the .last-pane is split and the answer says moved (review S1)', () => {
    const home = win('@1', { active: 1 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 80, h: 20 }), agent('%22', 'a2', { w: 99, h: 31 })]);
    assert.deepEqual(run([home], { parent: '%1', under: '%20', placement: 'under-last', last: '%22' }), split('%22', '-v', null, 'under', { moved: true }));
    assert.deepEqual(run([home], { parent: '%1', under: '%20', placement: 'under-last', last: null }), { ...WINDOW, moved: true }, 'no .last-pane: the beside rule has no room either');
  });

  test('P-3 (\u2212) 6c. a pane with pane_dead 1 is never split below, whatever room it has: an explicit under is moved to a new window, a dead .last-pane falls through (review S2)', () => {
    const home = (dead) => win('@1', { active: 1 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 99, h: 31, dead })]);
    assert.deepEqual(run([home(0)], { parent: '%1', under: '%20' }), split('%20', '-v', null, 'under'), 'control: alive, the same room');
    assert.deepEqual(run([home(1)], { parent: '%1', under: '%20' }), { ...WINDOW, moved: true });
    assert.deepEqual(run([home(0)], { parent: '%1', placement: 'under-last', last: '%20' }), split('%20', '-v', null, 'under'), 'control: alive');
    assert.deepEqual(run([home(1)], { parent: '%1', placement: 'under-last', last: '%20' }), WINDOW);
  });

  test('P-3 (+) 7. two agents windows: the one with the fewest panes; on a tie the lower index', () => {
    const three = AGENTS('@2', { index: 1 }, [agent('%21', 'a2', { w: 99, h: 24 }), agent('%22', 'a3', { w: 99, h: 24 }), agent('%23', 'a4', { w: 99, h: 24 })]);
    const one = AGENTS('@3', { index: 2 }, [agent('%31', 'b1')]);
    assert.deepEqual(run([FULL_HOME(), three, one], { parent: '%1' }), split('%31', '-h', '@3', 'tiled'));
    const tieA = AGENTS('@4', { index: 5 }, [agent('%41', 'c1')]);
    const tieB = AGENTS('@5', { index: 3 }, [agent('%51', 'c2')]);
    assert.deepEqual(run([FULL_HOME(), tieA, tieB], { parent: '%1' }), split('%51', '-h', '@5', 'tiled'));
  });

  test('P-3 (+) 8. a sub-orchestrator is the home of its own agents: it joins its agents window while tileFits, else another window or a new one', () => {
    const own = win('@3', { index: 2 }, [sub('%30', 'sub-1')]); // not active: the main orchestrator\'s window is
    const main = win('@1', { active: 1 }, [orch('%1')]);
    assert.deepEqual(run([main, own], { parent: '%30' }), split('%30', '-h', '@3', 'tiled'));
    const full = win('@3', { index: 2 }, [sub('%30', 'sub-1', { w: 99, h: 16 }), ...[31, 32, 33, 34, 35].map((n) => agent(`%${n}`, `w${n}`, { w: 99, h: 16 }))]);
    assert.deepEqual(run([main, full], { parent: '%30' }), WINDOW, 'the 7th pane would be 66 wide: a new agents window');
    const roomy = AGENTS('@4', { index: 3 }, [agent('%41', 'b1')]);
    assert.deepEqual(run([main, full, roomy], { parent: '%30' }), split('%41', '-h', '@4', 'tiled'));
  });

  test('P-3 (+) 9. no parent ("you"): the active pane of the current window takes the split, today\'s rule with the floor', () => {
    const home = win('@1', { active: 1 }, [orch('%1')]);
    assert.deepEqual(run([home]), split('%1', '-h', null, 'beside'));
    const narrow = win('@1', { active: 1, ww: 150 }, [orch('%1', { w: 150 })]);
    assert.deepEqual(run([narrow]), WINDOW, 'below 161 columns nothing goes beside');
  });

  test('P-3 (+) 10. no parent and several panes: the pane that is active is the one split, the orchestrator\'s or a user\'s; none that fits: an agents window', () => {
    const wide = (a, b) => win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 200, cur: a }), { pane: '%9', w: 199, cur: b }]);
    assert.deepEqual(run([wide(0, 1)]), split('%9', '-h', null, 'beside'), 'the user pane is active');
    assert.deepEqual(run([wide(1, 0)]), split('%1', '-h', null, 'beside'), 'the orchestrator is active');
    assert.deepEqual(run([wide(0, 0)]), WINDOW, 'a window that names no active pane splits none');
    const tight = win('@1', { active: 1 }, [orch('%1', { w: 100, cur: 0 }), { pane: '%9', w: 99, cur: 1 }]);
    assert.deepEqual(run([tight]), WINDOW, 'the active pane has no room');
    assert.deepEqual(run([tight, AGENTS()]), split('%21', '-h', '@2', 'tiled'));
    const gone = win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 200, cur: 0 }), { pane: '%9', w: 199, cur: 1, dead: 1 }]);
    assert.deepEqual(run([gone]), WINDOW, 'a dead pane is never split');
    // a named parent never falls back on the active pane
    assert.deepEqual(run([wide(0, 1)], { parent: '%30' }), WINDOW);
  });

  test('P-3 (+) 11. window_active is read per window: two rows with the active flag are one active window', () => {
    const home = win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 299 })]);
    assert.deepEqual(run([home, AGENTS()]), split('%20', '-h', null, 'beside'), 'the agent pane is the candidate; the window was found by its flag');
    // the first "active" window has room beside its agent (299 columns): a rule that trusted the first active window would split %20 there
    const both = [...win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 299 })]), ...win('@2', { active: 1, index: 1 }, [agent('%21', 'a2')])];
    assert.deepEqual(place({ rows: parsePlaceRows(text(both)), key: KEY }), { op: 'split', target: '%21', dir: '-h', tile: '@2', placement: 'tiled' },
      'two windows both said to be active: none is home, the agents window takes it');
  });

  test('P-3 (+) 12. the home window of a parent is its own, not the session\'s current window (the live case of 2026-11-19)', () => {
    const main = win('@1', { active: 1 }, [orch('%1', { w: 25 })]);
    const mine = win('@3', { index: 2, ww: 300 }, [sub('%30', 'sub-1', { w: 200 }), { pane: '%31', w: 99 }]);
    assert.deepEqual(run([main, mine], { parent: '%30' }), split('%30', '-h', null, 'beside'));
  });

  test('P-3 (\u2212) a parent that is not in the listing (another tmux session): the main orchestrator of the current window is not split for it', () => {
    const main = win('@1', { active: 1 }, [orch('%1')]);
    assert.deepEqual(run([main], { parent: '%30' }), WINDOW);
    assert.deepEqual(run([main, AGENTS()], { parent: '%30' }), split('%21', '-h', '@2', 'tiled'));
  });

  test('P-3 (+) a parent that is not in the listing: the current window is the home, and only this project\'s agents in it can be split', () => {
    const wide = win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 299 })]);
    assert.deepEqual(run([wide], { parent: '%30' }), split('%20', '-h', null, 'beside'), 'the agent pane; never %1, which is not the parent');
    const noRoom = win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 250 }), agent('%20', 'a1', { w: 149 })]);
    assert.deepEqual(run([noRoom], { parent: '%30' }), WINDOW, '%1 would fit, but it is not the parent and not an agent');
  });

  test('P-3 (+) a pane that is split below keeps its own window layout: in an agents window with no room to tile, fitsV decides (no re-tile)', () => {
    // 200 x 50: one pane 200 x 31 on top and five small ones below: the 7th pane would be 66 wide in a grid, but the top pane has room
    const panes = [agent('%21', 'a2', { w: 200, h: 31 }), ...[22, 23, 24, 25, 26].map((n) => agent(`%${n}`, `a${n}`, { w: 38, h: 18 }))];
    const crowded = AGENTS('@2', {}, panes);
    assert.deepEqual(run([FULL_HOME(), crowded], { parent: '%1', under: '%21' }), split('%21', '-v', null, 'under'));
    assert.deepEqual(run([FULL_HOME(), crowded], { parent: '%1', under: '%22' }), { ...WINDOW, moved: true }, 'a small pane of it has no room');
  });

  test('P-3 (+) the pane that is tiled around is the biggest by area, the lowest pane number on a tie; -h when it is at least twice as wide as high', () => {
    const three = AGENTS('@2', {}, [agent('%21', 'a2', { w: 99, h: 24 }), agent('%22', 'a3', { w: 100, h: 24 }), agent('%23', 'a4', { w: 200, h: 25 })]);
    assert.deepEqual(run([FULL_HOME(), three], { parent: '%1' }), split('%23', '-h', '@2', 'tiled'));
    const tie = AGENTS('@2', {}, [agent('%24', 'a2', { w: 99, h: 24 }), agent('%22', 'a3', { w: 99, h: 24 }), agent('%23', 'a4', { w: 60, h: 24 })]);
    assert.deepEqual(run([FULL_HOME(), tie], { parent: '%1' }), split('%22', '-h', '@2', 'tiled'), '99 >= 2 x 24');
    const tall = AGENTS('@2', {}, [agent('%21', 'a2', { w: 99, h: 50 }), agent('%22', 'a3', { w: 99, h: 50 })]);
    assert.deepEqual(run([FULL_HOME(), tall], { parent: '%1' }), split('%21', '-v', '@2', 'tiled'), '99 < 2 x 50: -v');
  });

  test('P-3 (\u2212) a dead pane (remain-on-exit) is never a split target or the pane that gets re-tiled around', () => {
    const dead = win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 299, dead: 1 })]);
    assert.deepEqual(run([dead], { parent: '%1' }), WINDOW);
    const onlyDead = AGENTS('@2', {}, [agent('%21', 'a2', { dead: 1 })]);
    assert.deepEqual(run([FULL_HOME(), onlyDead], { parent: '%1' }), WINDOW, 'no live pane to split in the agents window');
    const deadOrch = win('@1', { active: 1 }, [orch('%1', { dead: 1 })]);
    assert.deepEqual(run([deadOrch], { parent: '%1' }), WINDOW);
  });
});

describe('place: what is never a split target or a re-tile', () => {
  const base = () => win('@1', { active: 1 }, [orch('%1')]);
  const onlyWindow = (rows) => place({ rows, key: KEY, parent: '%1' });

  test('P-4 (\u2212) a zoomed home, a home with @nika-fit, a window whose rows are not its pane count: never a target, falls through', () => {
    assert.deepEqual(onlyWindow(rowsOf(base())), split('%1', '-h', null, 'beside'), 'the control: this window is a target');
    const zoomed = win('@1', { active: 1, zoomed: 1 }, [orch('%1')]);
    const fitted = win('@1', { active: 1 }, [orch('%1', { fit: 'a1b2c3d4e5f60718' })]);
    assert.deepEqual(onlyWindow(rowsOf(zoomed)), WINDOW);
    assert.deepEqual(onlyWindow(rowsOf(fitted)), WINDOW);
    // a pane's row is missing: the window says 2 panes and lists 1
    const missing = win('@1', { active: 1, panes: 2 }, [orch('%1')]).map((r) => ({ ...r, panes: 2 }));
    assert.deepEqual(onlyWindow(rowsOf(missing)), WINDOW);
    // a row with 15 fields (a tab in a tag) and one with 13 (a newline in a tag)
    const two = win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 200 }), agent('%20', 'a1', { w: 199 })]);
    const tab = parsePlaceRows(text(two.map((r) => (r.pane === '%20' ? { ...r, fit: 'x\ty' } : r))));
    assert.deepEqual(onlyWindow(tab), WINDOW, '%20 has 15 fields, is dropped, and the window no longer adds up');
    const nl = parsePlaceRows(text(two.map((r) => (r.pane === '%20' ? { ...r, agent: `${tag('a1')}\nx` } : r))));
    assert.deepEqual(onlyWindow(nl), WINDOW);
    const forged = two.map((r) => (r.pane === '%20' ? { ...r, fit: 'x\ny' } : r));
    assert.deepEqual(onlyWindow(parsePlaceRows(text(forged))), WINDOW, 'a forged fit text sets fit on the window');
  });

  test('P-4 (\u2212) a zoomed or fitted agents window is never split into or re-tiled; a spare window with rows missing neither', () => {
    const control = place({ rows: rowsOf(FULL_HOME(), AGENTS()), key: KEY, parent: '%1' });
    assert.deepEqual(control, split('%21', '-h', '@2', 'tiled'));
    for (const o of [{ zoomed: 1 }, { fit: 'x' }]) {
      const panes = AGENTS('@2', {}, [agent('%21', 'a2', o)]);
      assert.deepEqual(place({ rows: rowsOf(FULL_HOME(), panes.map((r) => ({ ...r, zoomed: o.zoomed ?? 0 }))), key: KEY, parent: '%1' }), WINDOW, JSON.stringify(o));
    }
    const short = AGENTS('@2', {}, [agent('%21', 'a2'), agent('%22', 'a3')]).map((r) => ({ ...r, panes: 3 }));
    assert.deepEqual(place({ rows: rowsOf(FULL_HOME(), short), key: KEY, parent: '%1' }), WINDOW);
    const extra = AGENTS('@2', {}, [agent('%21', 'a2')]).map((r) => ({ ...r, panes: 1 }));
    assert.deepEqual(place({ rows: rowsOf(FULL_HOME(), [...extra, ...win('@2', { index: 1 }, [agent('%22', 'a3', { cur: 0 })])]), key: KEY, parent: '%1' }), WINDOW,
      'two rows for a window that says 1 pane');
  });

  test('P-4 (\u2212) the rows of one window must agree on the window\'s own fields', () => {
    const a = AGENTS('@2', {}, [agent('%21', 'a2'), agent('%22', 'a3')]).map((r, i) => ({ ...r, ww: i ? 199 : 200 }));
    assert.deepEqual(place({ rows: rowsOf(FULL_HOME(), a), key: KEY, parent: '%1' }), WINDOW);
  });

  test('P-4 (\u2212) a window with two active panes is not trusted: never a target, however much room it has', () => {
    const wide = (a, b) => win('@1', { active: 1, ww: 400 }, [orch('%1', { w: 200, cur: a }), { pane: '%9', w: 199, cur: b }]);
    assert.deepEqual(place({ rows: rowsOf(wide(1, 0)), key: KEY, parent: '%1' }), split('%1', '-h', null, 'beside'), 'the control: one active pane');
    assert.deepEqual(place({ rows: rowsOf(wide(1, 1)), key: KEY, parent: '%1' }), WINDOW);
    assert.deepEqual(place({ rows: rowsOf(wide(1, 1)), key: KEY }), WINDOW, 'nor for "you"');
    const twoAgents = AGENTS('@2', {}, [agent('%21', 'a2', { cur: 1 }), agent('%22', 'a3', { cur: 1 })]);
    assert.deepEqual(place({ rows: rowsOf(FULL_HOME(), twoAgents), key: KEY, parent: '%1' }), WINDOW, 'an agents window with two active panes is not re-tiled');
  });

  test('P-4 (\u2212) an explicit under, .last-pane and the parent in a zoomed or fitted window are never split either', () => {
    const zoomed = win('@1', { active: 1, zoomed: 1 }, [orch('%1', { w: 100 }), agent('%20', 'a1', { w: 99, h: 40 })]);
    assert.deepEqual(run([zoomed], { parent: '%1', under: '%20' }), { ...WINDOW, moved: true });
    assert.deepEqual(run([zoomed], { parent: '%1', placement: 'under-last', last: '%20' }), WINDOW);
    const fitted = win('@1', { active: 1 }, [orch('%1', { fit: 'x', w: 100 }), agent('%20', 'a1', { w: 99, fit: 'x' })]);
    assert.deepEqual(run([fitted], { parent: '%1', under: '%20' }), { ...WINDOW, moved: true });
  });

  test('P-5 (\u2212) a window that is not all this project\'s agents is never an agents window: a user pane, another project\'s agent, a bad or missing tag', () => {
    const control = place({ rows: rowsOf(FULL_HOME(), AGENTS()), key: KEY, parent: '%1' });
    assert.equal(control.tile, '@2');
    const variants = {
      'a user pane next to the agent': [agent('%21', 'a2', { w: 99 }), { pane: '%22', w: 100 }],
      "another project's agent": [agent('%21', 'a2', { w: 99 }), { pane: '%22', role: 'agent', agent: tag('x1', OTHER), w: 100 }],
      "only another project's agent": [{ pane: '%21', role: 'agent', agent: tag('x1', OTHER) }],
      'agent role with a malformed tag': [{ pane: '%21', role: 'agent', agent: `${KEY}/UPPER` }],
      'agent role with a tag of three parts': [{ pane: '%21', role: 'agent', agent: `${KEY}/a/b` }],
      'agent role with no tag': [{ pane: '%21', role: 'agent', agent: '' }],
      'a valid tag with no role': [{ pane: '%21', role: '', agent: tag('a2') }],
      'a role that is not one of the three': [{ pane: '%21', role: 'agents', agent: tag('a2') }],
      'the orchestrator': [orch('%21')],
    };
    for (const [what, panes] of Object.entries(variants)) {
      const win2 = win('@2', { index: 1 }, panes);
      const r = place({ rows: rowsOf(FULL_HOME(), win2), key: KEY, parent: '%1' });
      assert.deepEqual([r.op, r.tile ?? null], ['window', null], what);
    }
  });

  test('P-5 (+) a sub-orchestrator of this project in an agents window is an agent for this purpose; another key\'s is not', () => {
    const mixed = AGENTS('@2', {}, [agent('%21', 'a2', { w: 99 }), sub('%22', 'sub-1', { w: 100 })]);
    assert.equal(place({ rows: rowsOf(FULL_HOME(), mixed), key: KEY, parent: '%22' }).tile, '@2'); // 0.5.4 SF (item 12): only the sub-orchestrator's own spawn (was parent %1)
    const foreign = AGENTS('@2', {}, [agent('%21', 'a2', { w: 99 }), { pane: '%22', role: 'sub-orchestrator', agent: tag('sub-1', OTHER), w: 100 }]);
    assert.equal(place({ rows: rowsOf(FULL_HOME(), foreign), key: KEY, parent: '%1' }).op, 'window');
  });
});

// P-6: the re-check doSpawn makes on the second listing of a window, right before `select-layout` (0.5.4)
describe('P-6 isAgentsWindow: is @W still an agents window of this project, and does it include the new pane?', () => {
  const crowd = (o = {}, panes = [agent('%21', 'a2'), agent('%22', 'a3')]) => win('@2', { index: 1, ...o }, panes);
  const yes = (rows, w = '@2', pane = '%22') => isAgentsWindow({ rows: parsePlaceRows(text(rows)), key: KEY, win: w, pane });

  test('P-6 (+) agents of this project only, one active pane, not zoomed, no @nika-fit, as many rows as the window says: yes (sub-orchestrators count as agents)', () => {
    assert.equal(yes(crowd()), true);
    assert.equal(yes(crowd({}, [sub('%21', 'sub-1'), agent('%22', 'a3')])), true);
  });

  test('P-6 (\u2212) every way the window can have changed since the first listing: no', () => {
    assert.equal(yes(crowd(), '@2', '%23'), false, 'the new pane is not in it');
    assert.equal(yes(crowd(), '@3'), false, 'no such window in the listing');
    assert.equal(yes(crowd({}, [agent('%21', 'a2'), { pane: '%22' }])), false, 'a user pane (no tags) is in it');
    assert.equal(yes(crowd({}, [agent('%21', 'a2'), { pane: '%22', role: 'agent', agent: tag('a3', OTHER) }])), false, 'an agent of another project');
    assert.equal(yes(crowd({}, [agent('%21', 'a2'), { pane: '%22', role: 'agent', agent: `${KEY}/a3\tx` }])), false, 'a forged tag breaks the row');
    assert.equal(yes(crowd({}, [agent('%21', 'a2'), orch('%22')])), false, 'an orchestrator is in it');
    assert.equal(yes(crowd({ zoomed: 1 })), false, 'zoomed by the user');
    assert.equal(yes(crowd({}, [agent('%21', 'a2', { fit: 'x' }), agent('%22', 'a3')])), false, 'a Fit lease');
    assert.equal(yes(crowd({ panes: 3 })), false, 'a row is missing');
    assert.equal(yes(crowd({}, [agent('%21', 'a2', { cur: 1 }), agent('%22', 'a3', { cur: 1 })])), false, 'two active panes');
    assert.equal(yes(''), false, 'an empty listing');
  });
});

// P-7: a listing is one piece of evidence (review M1). A tag can hold a newline, and tmux prints it raw, so one tag value can add a whole row.
describe('P-7 readPlaceListing: a listing that cannot be trusted as a whole gives no rows', () => {
  const honest = () => [...FULL_HOME(), ...AGENTS()];
  // a forged row, as a crafted tag value carries it: it claims %1 sits alone in a made-up agents window @99, 400 x 50. It has 14 fields: the real row's own
  // tab and last field (or the payload's own trailing tab) close it. `forgedLine` is the same row whole, as a line of its own.
  const forged = (pane = '%1') => [pane, '@99', '9', '0', '1', '0', '400', '50', '400', '50', '0', '1', 'agent', tag('fake')].join('\t');
  const forgedLine = (pane) => `${forged(pane)}\t`;
  const lines = (rows) => rows.map(line);

  test('P-7 (\u2212) 0.5.4 SF (item 11): a row whose pane id has a leading zero (%050, %00, %0123) does not parse, so the whole listing is untrusted: no rows; (+) %0, %5 and %999999 rows parse', () => {
    for (const pane of ['%050', '%00', '%0123']) {
      const t = text(honest()) + forgedLine(pane) + '\n';
      assert.deepEqual(readPlaceListing(t), { rows: [], trusted: false }, pane);
      assert.equal(parsePlaceRows(forgedLine(pane)).length, 0, pane);
    }
    for (const pane of ['%0', '%5', '%999999']) {
      const r = readPlaceListing(forgedLine(pane) + '\n');
      assert.deepEqual([r.trusted, r.rows.map((x) => x.pane)], [true, [pane]], pane);
    }
  });

  test('P-7 (+) an honest listing (a trailing newline, or none, or no panes at all) is trusted and gives the rows parsePlaceRows gives', () => {
    const t = text(honest());
    assert.deepEqual(readPlaceListing(t), { rows: parsePlaceRows(t), trusted: true });
    assert.equal(readPlaceListing(t).rows.length, 3);
    assert.equal(readPlaceListing(t.replace(/\n$/, '')).trusted, true, 'no trailing newline');
    assert.deepEqual(readPlaceListing(''), { rows: [], trusted: true });
    assert.deepEqual(readPlaceListing('\n'), { rows: [], trusted: true });
  });

  test('P-7 (\u2212) one line that does not parse makes the whole listing untrusted: no rows, not even the good ones', () => {
    const good = lines(honest());
    const bad = [good[0].split('\t').slice(0, 14).join('\t'), `${good[0]}\textra`, 'junk', ' ', good[0].replace('%1', '%x'), '\t'];
    for (const b of bad) {
      const t = `${[good[0], b, ...good.slice(1)].join('\n')}\n`;
      assert.deepEqual(readPlaceListing(t), { rows: [], trusted: false }, JSON.stringify(b));
      assert.equal(parsePlaceRows(t).length, 3, 'the row parser alone still drops just the bad line');
    }
  });

  test('P-7 (\u2212) a pane id on more than one row makes the whole listing untrusted: in one window, across windows, and a row repeated', () => {
    const good = lines(honest());
    assert.deepEqual(readPlaceListing(`${[...good, forgedLine('%1')].join('\n')}\n`), { rows: [], trusted: false }, 'a forged row naming a real pane');
    assert.deepEqual(readPlaceListing(`${[...good, good[1]].join('\n')}\n`), { rows: [], trusted: false }, 'the same row twice');
    assert.deepEqual(readPlaceListing(`${[...good, forgedLine('%21')].join('\n')}\n`), { rows: [], trusted: false }, 'a real pane of another window');
    assert.equal(readPlaceListing(`${[...good, forgedLine('%77')].join('\n')}\n`).trusted, true, 'a made-up pane id parses and is unique: the spawn\'s own check (c) catches it');
  });

  test('P-7 (\u2212) the payloads of the review: a newline in @nika-agent (the first half is a short line) and in @nika-fit (every line parses)', () => {
    const base = honest();
    const viaAgent = base.map((r) => (r.pane === '%21' ? { ...r, agent: `x\n${forged('%1')}` } : r));
    assert.deepEqual(readPlaceListing(text(viaAgent)), { rows: [], trusted: false });
    // the forged row is closed by the real @nika-fit: here empty
    const viaFit = base.map((r) => (r.pane === '%21' ? { ...r, fit: `x\n${forged('%1')}\t` } : r));
    const t = text(viaFit);
    assert.equal(parsePlaceRows(t).length, 4, 'every line parses: four rows, one of them forged');
    assert.deepEqual(readPlaceListing(t), { rows: [], trusted: false });
    // untrusted means no window is usable: place() on no rows is a new agents window, and an explicit under is moved
    assert.deepEqual(place({ rows: readPlaceListing(t).rows, key: KEY, parent: '%1' }), WINDOW);
    assert.deepEqual(place({ rows: readPlaceListing(t).rows, key: KEY, parent: '%1', under: '%20' }), { ...WINDOW, moved: true });
  });
});

// P-8: the collector's `list-panes -a` read as one piece of evidence for doSpawn's check (c) (round 4, review R1-1). The collector's own parse accepts a short
// line and lets the last row of a pane id win; this view refuses both.
describe('P-8 isStrictPaneListing: a short line, or a pane id on two lines, makes the collector\'s read untrusted', () => {
  // the collector's format has 11 fields: id, session, window index, title, command, role, agent, depth, parent, dead, kind
  const row = (id, extra = []) => [id, 'My-App', '0', 'title', 'zsh', '', '', '', '', '0', '', ...extra].join('\t');
  const read = (...rows) => `${rows.join('\n')}\n`;

  test('P-8 (+) an honest read is trusted: with or without the last newline, empty, ids that only share a prefix, and lines with more fields than the format', () => {
    assert.equal(COLLECTOR_FIELDS, 11);
    assert.equal(row('%1').split('\t').length, COLLECTOR_FIELDS);
    assert.equal(isStrictPaneListing(read(row('%1'), row('%20'), row('%2'))), true);
    assert.equal(isStrictPaneListing(read(row('%1'), row('%10'), row('%100'))), true, '%1, %10 and %100 are three ids');
    assert.equal(isStrictPaneListing(read(row('%1'), row('%2')).replace(/\n$/, '')), true, 'no last newline');
    for (const empty of ['', '\n']) assert.equal(isStrictPaneListing(empty), true, JSON.stringify(empty));
    assert.equal(isStrictPaneListing(read(row('%1', ['a tab', 'and more']), row('%2'))), true, 'the last field (the kind) may hold tabs');
    assert.equal(isStrictPaneListing(read(row('%1', ['x']))), true);
  });

  test('P-8 (\u2212) a line with fewer fields than the format makes the whole read untrusted: a cut line, junk, whitespace, a made-up pane, between good lines', () => {
    const cut = row('%1').split('\t').slice(0, COLLECTOR_FIELDS - 1).join('\t');
    for (const bad of [cut, 'junk', ' ', '\t', '%50\tMy-App', '%61\tMy-App\t0\t', '%1']) {
      assert.equal(isStrictPaneListing(read(row('%1'), bad, row('%2'))), false, JSON.stringify(bad));
      assert.equal(isStrictPaneListing(read(bad)), false, `alone: ${JSON.stringify(bad)}`);
    }
  });

  test('P-8 (\u2212) a pane id on more than one line makes the whole read untrusted, whatever else the two lines say', () => {
    assert.equal(isStrictPaneListing(read(row('%1'), row('%2'), row('%1'))), false, 'the same line again');
    assert.equal(isStrictPaneListing(read(row('%50'), row('%1'), row('%50').replace('My-App', 'Aaa'))), false, 'the same pane in two sessions');
    assert.equal(isStrictPaneListing(read(row('%1', ['x']), row('%1'))), false, 'one with more fields');
  });

  test('P-8 (\u2212) the field count is the one passed: a line of 11 fields is short for a format of 12', () => {
    assert.equal(isStrictPaneListing(read(row('%1')), COLLECTOR_FIELDS), true);
    assert.equal(isStrictPaneListing(read(row('%1')), COLLECTOR_FIELDS + 1), false);
  });
});

// P-9: keep trees apart (0.5.4, SF item 12; owner decision 2026-11-20). A window that holds a sub-orchestrator pane of this project is a target of rule 3's tile
// step and of rule 4 only for a spawn whose parent is that pane; a window with two or more of them is a target for neither.
describe('P-9 place: a window with a sub-orchestrator is tiled only for that sub-orchestrator\'s own spawns', () => {
  const MAIN_TIGHT = () => FULL_HOME(); // orchestrator 100 | agent 99: nothing goes beside, so rules 3 and 4 decide
  // sub A and one of its agents, room left (200 x 50 takes a third pane); the biggest pane is the agent, 100 wide
  const WIN_A = (o = {}) => win('@3', { index: 2, ...o }, [sub('%30', 'sub-a', { w: 99 }), agent('%31', 'a1', { w: 100 })]);
  // sub B in a window of its own that has a user pane and no room: B's rule 3 finds nothing, so rule 4 decides (the live check of 2026-11-20)
  const WIN_B = () => win('@4', { index: 3 }, [sub('%40', 'sub-b', { w: 100 }), { pane: '%41', w: 99 }]);
  // a plain agents window with two panes: more panes than WIN_A, a higher index, so only the sub-orchestrator rule can send a spawn there before WIN_A
  const PLAIN = () => win('@5', { index: 4 }, [agent('%51', 'p1', { w: 99, h: 24 }), agent('%52', 'p2', { w: 100, h: 24 })]);
  const INTO_A = split('%31', '-h', '@3', 'tiled');
  const INTO_PLAIN = split('%52', '-h', '@5', 'tiled');

  test('P-9 (\u2212) the live-check shape: sub B (parent %40) is not tiled into sub A\'s window, however much room it has: a new agents window, or another open one', () => {
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), WIN_B()], { parent: '%40' }), WINDOW);
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), WIN_B(), PLAIN()], { parent: '%40' }), INTO_PLAIN, 'rule 4 goes on to the next agents window');
    // the control: without sub A in it the same window is the open one (the fewest panes wins: A\'s window has 2, the plain one 2, the lower index first)
    const noSub = win('@3', { index: 2 }, [agent('%30', 'a0', { w: 99 }), agent('%31', 'a1', { w: 100 })]);
    assert.deepEqual(run([MAIN_TIGHT(), noSub, WIN_B(), PLAIN()], { parent: '%40' }), INTO_A);
  });

  test('P-9 (\u2212) the main orchestrator (parent %1) and "you" (no parent): rule 4 skips a window with a sub-orchestrator', () => {
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A()], { parent: '%1' }), WINDOW);
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A()]), WINDOW);
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), PLAIN()], { parent: '%1' }), INTO_PLAIN);
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), PLAIN()]), INTO_PLAIN);
  });

  test('P-9 (\u2212) rule 3: the home window is not tiled for a spawn whose parent is not its sub-orchestrator ("you" in the active window, a parent that is in another session)', () => {
    const active = WIN_A({ active: 1 });
    assert.deepEqual(run([MAIN_TIGHT().map((r) => ({ ...r, active: 0 })), active]), WINDOW, '"you": the active window is the home');
    assert.deepEqual(run([MAIN_TIGHT().map((r) => ({ ...r, active: 0 })), active], { parent: '%99' }), WINDOW, 'a parent that is not in the listing: the active window is the home');
    assert.deepEqual(run([MAIN_TIGHT().map((r) => ({ ...r, active: 0 })), active, PLAIN()]), INTO_PLAIN, 'and rule 4 goes on to the next window');
  });

  test('P-9 (\u2212) a window holding two sub-orchestrators is a target for neither rule, for either of them or anyone else', () => {
    const both = win('@3', { index: 2 }, [sub('%30', 'sub-a', { w: 99 }), sub('%40', 'sub-b', { w: 100 })]);
    for (const parent of ['%30', '%40', '%1', null]) assert.deepEqual(run([MAIN_TIGHT(), both], { parent }), WINDOW, String(parent));
    for (const parent of ['%30', '%40', '%1', null]) assert.deepEqual(run([MAIN_TIGHT(), both, PLAIN()], { parent }), INTO_PLAIN, `${parent}: the next agents window`);
  });

  test('P-9 (+) sub A (parent %30) is tiled into its own window as today (rule 3); when that window has no room, rule 4 does not pick it either, so A goes on to another agents window', () => {
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A()], { parent: '%30' }), INTO_A);
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), PLAIN()], { parent: '%30' }), INTO_A, 'its own window comes first');
    const full = win('@3', { index: 2 }, [sub('%30', 'sub-a', { w: 99, h: 16 }), ...[31, 32, 33, 34, 35].map((n) => agent(`%${n}`, `w${n}`, { w: 99, h: 16 }))]);
    assert.deepEqual(run([MAIN_TIGHT(), full], { parent: '%30' }), WINDOW);
    assert.deepEqual(run([MAIN_TIGHT(), full, PLAIN()], { parent: '%30' }), INTO_PLAIN);
    // the spawn's parent is the only thing that opens the window: sub B in the same listing still gets nothing from A's
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), WIN_B()], { parent: '%30' }), INTO_A);
  });

  test('P-9 (+) a plain agents window (no sub-orchestrator) is unchanged for every parent: the main orchestrator, a sub-orchestrator, "you", a parent in another session', () => {
    // sub A's window has a user pane: not an agents window at all, so rule 4 takes the plain one for every parent
    const userWin = win('@3', { index: 2 }, [sub('%30', 'sub-a', { w: 100 }), { pane: '%31', w: 99 }]);
    for (const parent of ['%1', '%30', '%99', null]) assert.deepEqual(run([MAIN_TIGHT(), AGENTS(), userWin], { parent }), split('%21', '-h', '@2', 'tiled'), String(parent));
    const home = AGENTS('@2', { active: 1 }, [agent('%21', 'a2')]);
    assert.deepEqual(run([home]), split('%21', '-h', '@2', 'tiled'), '"you" in an active plain agents window: rule 3 tiles it');
    assert.deepEqual(run([home], { parent: '%99' }), split('%21', '-h', '@2', 'tiled'));
    assert.deepEqual(run([MAIN_TIGHT(), AGENTS(), PLAIN()], { parent: '%30' }), split('%21', '-h', '@2', 'tiled'), 'the fewest panes first, as before');
  });

  test('P-9 (\u2212) a dead sub-orchestrator row counts like a live one: its window stays closed to every other spawn', () => {
    const dead = win('@3', { index: 2 }, [sub('%30', 'sub-a', { w: 99, dead: 1 }), agent('%31', 'a1', { w: 100 })]);
    for (const parent of ['%40', '%1', null]) assert.deepEqual(run([MAIN_TIGHT(), dead, WIN_B()], { parent }), WINDOW, String(parent));
    assert.deepEqual(run([MAIN_TIGHT(), dead, WIN_B(), PLAIN()], { parent: '%40' }), INTO_PLAIN);
    assert.deepEqual(run([MAIN_TIGHT(), dead], { parent: '%30' }), INTO_A, 'its own spawn still tiles it, around a live pane');
  });

  test('P-9 (+) rule 1 and rule 3\'s beside steps are not changed by this item; rule 2 (under-last) follows item 14 (P-10): it no longer joins a window that is closed to the spawn', () => {
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), WIN_B()], { parent: '%40', under: '%31' }), split('%31', '-v', '@3', 'tiled'));
    // 0.5.4 SF (item 14, ruling 6): was split('%31', '-v', '@3', 'tiled'), sub B's under-last joining sub A's window; that window is closed to B (it holds sub A), so rule 2 is skipped
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), WIN_B()], { parent: '%40', placement: 'under-last', last: '%31' }), WINDOW);
    assert.deepEqual(run([MAIN_TIGHT(), WIN_A(), WIN_B()], { parent: '%30', placement: 'under-last', last: '%31' }), split('%31', '-v', '@3', 'tiled'), 'sub A\'s own under-last still joins it');
    const wide = win('@3', { index: 2, ww: 400 }, [sub('%30', 'sub-a', { w: 200 }), { pane: '%31', w: 199 }]);
    assert.deepEqual(run([MAIN_TIGHT(), wide], { parent: '%30' }), split('%30', '-h', null, 'beside'));
  });

  test('P-9 (\u2212) another project\'s sub-orchestrator is not this project\'s: it never opens or closes anything here (the window is not an agents window of this key)', () => {
    const foreign = win('@3', { index: 2 }, [{ pane: '%30', role: 'sub-orchestrator', agent: tag('sub-a', OTHER), w: 99 }, agent('%31', 'a1', { w: 100 })]);
    assert.deepEqual(run([MAIN_TIGHT(), foreign, PLAIN()], { parent: '%1' }), INTO_PLAIN);
    assert.deepEqual(run([MAIN_TIGHT(), foreign], { parent: '%1' }), WINDOW);
  });
});

// P-10: whole trees (0.5.4, SF item 14; owner answer P1-Q6 A, 2026-11-20). A window of agents is a target of rule 3's tile step and of rule 4 only when EVERY pane in it is
// the spawn's parent or the child of that parent (by `@nika-parent` of the `-a` read), and (item 12) it holds no sub-orchestrator that is not the spawn's parent. "You" (no
// parent) is the panes with no parent tag. `under-last` follows `.last-pane` only inside the spawn's tree. A pane the read does not list, or whose tag is not exactly the
// parent's pane id, is in nobody's tree. Explicit `under`, rule 3's beside steps and rule 5 are unchanged. `parents` is the Map of parentTags(); without it nothing is checked.
describe('P-10 place: a window of agents is tiled only when every pane in it is the spawn\'s parent or its child', () => {
  // the raw `@nika-parent` of every pane of a synthetic listing: the row's `parent` ('' = no tag), as the `-a` read gives it
  const tags = (...windows) => new Map(windows.flat().map((r) => [r.pane, r.parent ?? '']));
  const go = (windows, o = {}, edit = (m) => m) => place({ rows: rowsOf(...windows), key: KEY, parents: edit(tags(...windows)), ...o });
  const MAIN = () => win('@1', { active: 1 }, [orch('%1', { w: 100 }), agent('%10', 'm0', { w: 99, parent: '%1' })]); // nothing goes beside: rules 3 and 4 decide
  // sub A (a child of the main orchestrator) with five agents of its own: no room left
  const A_FULL = () => win('@3', { index: 2 }, [sub('%30', 'sub-a', { w: 99, h: 16, parent: '%1' }), ...[31, 32, 33, 34, 35].map((n) => agent(`%${n}`, `a${n}`, { w: 99, h: 16, parent: '%30' }))]);
  // sub A's overflow window: only A's agents, no sub pane in it (the live check of 2026-11-20, case 1)
  const A_MORE = () => win('@6', { index: 5 }, [agent('%61', 'o1', { w: 99, h: 24, parent: '%30' }), agent('%62', 'o2', { w: 100, h: 24, parent: '%30' })]);
  // the main orchestrator's own agents window
  const M_MORE = () => win('@7', { index: 6 }, [agent('%71', 'q1', { w: 99, h: 24, parent: '%1' }), agent('%72', 'q2', { w: 100, h: 24, parent: '%1' })]);
  // "you": agents that carry no parent tag
  const U_MORE = () => win('@9', { index: 8 }, [agent('%91', 'u1', { w: 99, h: 24 }), agent('%92', 'u2', { w: 100, h: 24 })]);
  // sub B in a window of its own with a user pane and no room: only rule 4 can place its agent
  const B_HOME = () => win('@4', { index: 3 }, [sub('%40', 'sub-b', { w: 100, parent: '%1' }), { pane: '%41', w: 99 }]);
  const INTO_A_MORE = split('%62', '-h', '@6', 'tiled');
  const INTO_M_MORE = split('%72', '-h', '@7', 'tiled');
  const INTO_U_MORE = split('%92', '-h', '@9', 'tiled');

  test('P-10 (\u2212) the live-check case 1: sub A\'s overflow window (only A\'s agents) is not tiled by sub B\'s or the main orchestrator\'s spawn; sub A\'s own spawn tiles it', () => {
    const all = () => [MAIN(), A_FULL(), A_MORE(), B_HOME()];
    for (const parent of ['%40', '%1']) assert.deepEqual(go(all(), { parent }), WINDOW, `${parent}: a new agents window`);
    assert.deepEqual(go(all(), { parent: '%30' }), INTO_A_MORE, 'A\'s window has no room, so rule 4 finds its overflow window');
    assert.deepEqual(go([MAIN(), A_MORE()], { parent: '%30' }), INTO_A_MORE, 'and with A\'s home window not in the listing');
    // the control: without the parent map nothing is checked, and B\'s agent lands in A\'s window (the mix this item closes)
    assert.deepEqual(place({ rows: rowsOf(...all()), key: KEY, parent: '%40' }), INTO_A_MORE);
    assert.deepEqual(go([...all(), M_MORE()], { parent: '%40' }), WINDOW, 'B has no agents window: the main orchestrator\'s is not its tree either');
  });

  test('P-10 (\u2212) the main orchestrator\'s own agents window is not tiled by sub A\'s spawn (A\'s window is full); the main orchestrator\'s own spawn tiles it', () => {
    const all = () => [MAIN(), A_FULL(), M_MORE(), B_HOME()];
    assert.deepEqual(go(all(), { parent: '%30' }), WINDOW);
    assert.deepEqual(go(all(), { parent: '%40' }), WINDOW);
    assert.deepEqual(go(all(), { parent: '%1' }), INTO_M_MORE, 'A\'s window is closed to it by the sub-orchestrator rule of item 12');
    // rule 3's tile step too: the main orchestrator\'s own agents window as the active home window
    const home = () => win('@7', { index: 6, active: 1 }, [agent('%71', 'q1', { w: 99, h: 24, parent: '%1' }), agent('%72', 'q2', { w: 100, h: 24, parent: '%1' })]);
    assert.deepEqual(go([home(), A_FULL()], { parent: '%99' }), WINDOW, 'a parent that is not in the listing, home = the active window: not its tree');
    assert.deepEqual(go([home(), A_FULL()], { parent: '%1' }), INTO_M_MORE);
  });

  test('P-10 (\u2212) a window with only sub A (a child of the main orchestrator) and the main orchestrator\'s agents: not tiled by the main orchestrator\'s spawn (both rules hold together)', () => {
    const mixed = () => win('@8', { index: 7 }, [sub('%30', 'sub-a', { w: 99, h: 24, parent: '%1' }), agent('%81', 'm1', { w: 100, h: 24, parent: '%1' })]);
    assert.deepEqual(go([MAIN(), mixed()], { parent: '%1' }), WINDOW, 'every pane is the main orchestrator\'s child, but a sub-orchestrator that is not its parent is in it');
    assert.deepEqual(go([MAIN(), mixed()], { parent: '%30' }), WINDOW, 'sub A: the main orchestrator\'s agent is not its child');
    assert.deepEqual(go([MAIN(), mixed()]), WINDOW);
    // the same window without the sub pane is the main orchestrator\'s own
    const plain = () => win('@8', { index: 7 }, [agent('%80', 'm0', { w: 99, h: 24, parent: '%1' }), agent('%81', 'm1', { w: 100, h: 24, parent: '%1' })]);
    assert.deepEqual(go([MAIN(), plain()], { parent: '%1' }), split('%81', '-h', '@8', 'tiled'));
    // sub A with its own agent only: A's
    const own = () => win('@8', { index: 7 }, [sub('%30', 'sub-a', { w: 99, h: 24, parent: '%1' }), agent('%81', 'a1', { w: 100, h: 24, parent: '%30' })]);
    assert.deepEqual(go([MAIN(), own()], { parent: '%30' }), split('%81', '-h', '@8', 'tiled'));
    assert.deepEqual(go([MAIN(), own()], { parent: '%1' }), WINDOW);
  });

  test('P-10 (\u2212) "you" (no parent): a window of agents that carry parent tags is closed, one mixed with untagged agents is closed to everyone; (+) a window of untagged agents is open to "you" only', () => {
    assert.deepEqual(go([MAIN(), M_MORE()]), WINDOW, 'agents of the main orchestrator');
    assert.deepEqual(go([MAIN(), A_MORE()]), WINDOW, 'agents of a sub-orchestrator');
    assert.deepEqual(go([MAIN(), U_MORE()]), INTO_U_MORE, 'untagged agents: the "you" tree');
    assert.deepEqual(go([MAIN(), U_MORE()], { parent: '%1' }), WINDOW, 'and nobody else\'s');
    const mix = () => win('@9', { index: 8 }, [agent('%91', 'u1', { w: 99, h: 24 }), agent('%92', 'u2', { w: 100, h: 24, parent: '%1' })]);
    for (const parent of [null, '%1']) assert.deepEqual(go([MAIN(), mix()], { parent }), WINDOW, String(parent));
    // the active window is the home of "you": rule 3's tile step
    const home = (panes) => win('@2', { index: 1, active: 1 }, panes);
    assert.deepEqual(go([home([agent('%21', 'a2')])]), split('%21', '-h', '@2', 'tiled'));
    assert.deepEqual(go([home([agent('%21', 'a2', { w: 99, parent: '%1' })])]), WINDOW, 'tagged: closed to "you" (a 99 wide pane has no room beside it either)');
  });

  test('P-10 (\u2212) a tag that is not exactly the parent\'s pane id (malformed, a leading zero, a near miss) and a pane the read does not list put the window in nobody\'s tree', () => {
    const w = (tag) => win('@7', { index: 6 }, [agent('%71', 'q1', { w: 99, h: 24, parent: '%1' }), agent('%72', 'q2', { w: 100, h: 24, parent: tag })]);
    for (const bad of ['junk', '%050', '%01', '%1x', '%1 ', ' %1', '%', '%1\u0000', '%1\n', '%9999999', '1']) {
      assert.deepEqual(go([MAIN(), w(bad)], { parent: '%1' }), WINDOW, `parent %1: ${JSON.stringify(bad)}`);
      assert.deepEqual(go([MAIN(), w(bad)]), WINDOW, `"you": ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(go([MAIN(), w('%1')], { parent: '%1' }), INTO_M_MORE, 'the control: the exact id');
    // a pane that the read does not list, and one that is ambiguous (null: a pane id on two lines)
    const drop = (pane) => (m) => { m.delete(pane); return m; };
    const dup = (pane) => (m) => m.set(pane, null);
    assert.deepEqual(go([MAIN(), M_MORE()], { parent: '%1' }, drop('%72')), WINDOW);
    assert.deepEqual(go([MAIN(), M_MORE()], { parent: '%1' }, dup('%72')), WINDOW);
    assert.deepEqual(go([MAIN(), U_MORE()], {}, drop('%92')), WINDOW, '"you": an unlisted pane');
    assert.deepEqual(go([MAIN(), U_MORE()], {}, dup('%92')), WINDOW);
    assert.deepEqual(go([MAIN(), M_MORE()], { parent: '%1' }, (m) => new Map()), WINDOW, 'an empty read lists nothing: every window is closed');
    assert.deepEqual(go([MAIN(), M_MORE()], { parent: '%1' }), INTO_M_MORE, 'the control');
  });

  test('P-10 (\u2212) the tag is compared exactly: a near miss of the parent\'s id (a prefix, a longer id, a contained id) is not its child', () => {
    // parent %30 is not in the listing, so the active window is its home (not an agents window) and rule 4 decides
    const w = (tag) => win('@6', { index: 5 }, [agent('%61', 'o1', { w: 99, h: 24, parent: '%30' }), agent('%62', 'o2', { w: 100, h: 24, parent: tag })]);
    for (const near of ['%300', '%3', '%3000', '%130', '%0', '%1', '%31', '%29', '']) assert.deepEqual(go([MAIN(), w(near)], { parent: '%30' }), WINDOW, JSON.stringify(near));
    assert.deepEqual(go([MAIN(), w('%30')], { parent: '%30' }), INTO_A_MORE, 'the exact id');
    // and for the parent that is a prefix of the other ids: %1 against %10 and %100
    for (const near of ['%10', '%100', '%11']) assert.deepEqual(go([MAIN(), w(near)], { parent: '%1' }), WINDOW, `%1 against ${near}`);
  });

  test('P-10 (\u2212) a dead pane (remain-on-exit) counts like a live one: a window that holds one tagged with another tree\'s parent is closed to this spawn (review S1)', () => {
    const w = (deadTag) => win('@6', { index: 5 }, [agent('%61', 'o1', { w: 99, h: 24, parent: '%30' }), agent('%62', 'o2', { w: 100, h: 24, parent: deadTag, dead: 1 })]);
    for (const other of ['%40', '%1', '', 'junk']) assert.deepEqual(go([MAIN(), w(other)], { parent: '%30' }), WINDOW, `parent %30, the dead pane is tagged ${JSON.stringify(other)}`);
    assert.deepEqual(go([MAIN(), w('%30')], { parent: '%30' }), split('%61', '-h', '@6', 'tiled'), 'the control: a dead pane of its own tree does not close it, and it is never the split target');
    // "you": a dead pane that carries a parent tag closes a window of untagged agents
    const you = (deadTag) => win('@9', { index: 8 }, [agent('%91', 'u1', { w: 99, h: 24 }), agent('%92', 'u2', { w: 100, h: 24, parent: deadTag, dead: 1 })]);
    assert.deepEqual(go([MAIN(), you('%1')]), WINDOW, '"you": the dead pane belongs to the main orchestrator');
    assert.deepEqual(go([MAIN(), you('')]), split('%91', '-h', '@9', 'tiled'), 'the control: an untagged dead pane is in the "you" tree');
  });

  test('P-10 (+) under-last follows .last-pane when it is in the spawn\'s tree and its window is open to the spawn: below it, as today', () => {
    const base = () => [MAIN(), A_FULL(), A_MORE(), B_HOME()];
    assert.deepEqual(go(base(), { parent: '%30', placement: 'under-last', last: '%62' }), split('%62', '-v', '@6', 'tiled'));
    assert.deepEqual(go([MAIN(), M_MORE()], { parent: '%1', placement: 'under-last', last: '%71' }), split('%71', '-v', '@7', 'tiled'));
    assert.deepEqual(go([MAIN(), U_MORE()], { placement: 'under-last', last: '%91' }), split('%91', '-v', '@9', 'tiled'), '"you": an untagged pane is in the tree');
    // in the tree, in a window that is not a window of agents: the plain split below it, as today (no tile)
    const user = () => win('@3', { index: 2 }, [sub('%30', 'sub-a', { parent: '%1' }), { pane: '%31' }]);
    assert.deepEqual(go([MAIN(), user(), B_HOME()], { parent: '%30', placement: 'under-last', last: '%30' }), split('%30', '-v', null, 'under'), 'the parent pane itself is in its tree');
  });

  test('P-10 (\u2212) under-last: the last pane of another tree is skipped (rule 3 onward); so is a last pane in the tree whose window is closed to the spawn', () => {
    const base = () => [MAIN(), A_FULL(), A_MORE(), B_HOME()];
    for (const parent of ['%40', '%1']) assert.deepEqual(go(base(), { parent, placement: 'under-last', last: '%62' }), WINDOW, `${parent}: A's pane is not its tree`);
    assert.deepEqual(go([MAIN(), U_MORE()], { placement: 'under-last', last: '%71', parent: '%40' }), WINDOW, 'a pane that is not in the listing: rule 3 onward');
    // the plain split below a pane (no tile: its window holds a user pane) is checked on the pane alone: sub A is the main orchestrator's child, not sub B's and not "you"'s
    const userWin = () => win('@3', { index: 2 }, [sub('%30', 'sub-a', { parent: '%1' }), { pane: '%31' }]);
    assert.deepEqual(go([MAIN(), userWin(), B_HOME()], { parent: '%40', placement: 'under-last', last: '%30' }), WINDOW, 'sub B: not its pane');
    assert.deepEqual(go([MAIN(), userWin(), B_HOME()], { placement: 'under-last', last: '%30' }), WINDOW, '"you": not its pane');
    assert.deepEqual(go([MAIN(), userWin(), B_HOME()], { parent: '%1', placement: 'under-last', last: '%30' }), split('%30', '-v', null, 'under'), 'the main orchestrator: its child, as today');
    // the last pane is in the spawn's tree (%91 is A's), but its window also holds an agent of B: closed, so rule 2 is skipped and rule 3 tiles A's home window
    const wina = () => win('@3', { index: 2 }, [sub('%30', 'sub-a', { w: 99, parent: '%1' }), agent('%31', 'a1', { w: 100, parent: '%30' })]);
    const crossed = () => win('@5', { index: 4 }, [agent('%91', 'x1', { w: 99, h: 24, parent: '%30' }), agent('%92', 'x2', { w: 100, h: 24, parent: '%40' })]);
    assert.deepEqual(go([MAIN(), wina(), crossed()], { parent: '%30', placement: 'under-last', last: '%91' }), split('%31', '-h', '@3', 'tiled'));
    assert.deepEqual(go([MAIN(), wina(), crossed()], { parent: '%30', placement: 'beside', last: '%91' }), split('%31', '-h', '@3', 'tiled'), 'the setting off: the same place');
    // the sub-orchestrator rule of item 12 closes the window for rule 2 as well
    const subwin = () => win('@3', { index: 2 }, [sub('%30', 'sub-a', { w: 99, parent: '%1' }), agent('%31', 'a1', { w: 100, parent: '%1' })]);
    assert.deepEqual(go([MAIN(), subwin(), B_HOME()], { parent: '%1', placement: 'under-last', last: '%31' }), WINDOW, 'the tree is the main orchestrator\'s, but a sub pane that is not its parent is in the window');
  });

  test('P-10 (+) unchanged: an explicit under into another tree\'s pane, beside in the parent\'s own window, and a plain agents window of one tree for its own parent', () => {
    const all = () => [MAIN(), A_FULL(), A_MORE(), B_HOME()];
    assert.deepEqual(go(all(), { parent: '%40', under: '%62' }), split('%62', '-v', '@6', 'tiled'), 'rule 1 names the pane: not checked');
    assert.deepEqual(go(all(), { parent: '%1', under: '%62' }), split('%62', '-v', '@6', 'tiled'));
    const wide = win('@3', { index: 2, ww: 400 }, [sub('%30', 'sub-a', { w: 200, parent: '%1' }), { pane: '%31', w: 199 }]);
    assert.deepEqual(go([MAIN(), wide], { parent: '%30' }), split('%30', '-h', null, 'beside'));
    assert.deepEqual(go([MAIN(), M_MORE()], { parent: '%1' }), INTO_M_MORE);
    assert.deepEqual(go([MAIN(), A_MORE()], { parent: '%30' }), INTO_A_MORE);
    // rule 5: no window to take it
    assert.deepEqual(go([MAIN()], { parent: '%1' }), WINDOW);
  });

  test('P-10 (\u2212) no parent map, nothing checked (the rules of P-1 to P-9 stand); an empty map closes every window of agents', () => {
    assert.deepEqual(place({ rows: rowsOf(MAIN(), M_MORE()), key: KEY, parent: '%30' }), INTO_M_MORE, 'no map: today\'s behaviour');
    assert.deepEqual(place({ rows: rowsOf(MAIN(), M_MORE()), key: KEY, parent: '%30', parents: new Map() }), WINDOW);
  });
});

// P-10: the collector's `-a` read as the parent map of place(): the raw `@nika-parent` text of every pane, nothing cleaned up
describe('P-10 parentTags: the raw @nika-parent of every pane of the collector\'s read', () => {
  // the collector's format has 11 fields: id, session, window index, title, command, role, agent, depth, parent, dead, kind
  const crow = (id, parent, extra = []) => [id, 'My-App', '0', 'title', 'claude', 'agent', tag('a1'), '2', parent, '0', 'agent', ...extra].join('\t');
  const read = (...rows) => `${rows.join('\n')}\n`;

  test('P-10 (+) the parent field is read: a pane id, \'\' when unset, a malformed value as it is written', () => {
    assert.equal(COLLECTOR_PARENT_FIELD, 8);
    assert.deepEqual([...parentTags(read(crow('%5', '%30'), crow('%6', ''), crow('%7', 'junk'), crow('%8', '%050')))],
      [['%5', '%30'], ['%6', ''], ['%7', 'junk'], ['%8', '%050']]);
    assert.deepEqual([...parentTags('')], []);
    assert.deepEqual([...parentTags('\n')], []);
    assert.deepEqual([...parentTags(read(crow('%5', '%30')).replace(/\n$/, ''))], [['%5', '%30']], 'no last newline');
  });

  test('P-10 (\u2212) a short line and a line with a bad pane id are skipped; a pane id on two lines is null (ambiguous); nothing is cleaned up', () => {
    const cut = crow('%5', '%30').split('\t').slice(0, COLLECTOR_FIELDS - 1).join('\t');
    assert.deepEqual([...parentTags(read(cut, crow('%6', '%1')))], [['%6', '%1']], 'a short line: that pane is not listed');
    assert.deepEqual([...parentTags(read(crow('%x', '%30'), crow('%050', '%30'), crow('6', '%30'), 'junk'))], []);
    assert.deepEqual([...parentTags(read(crow('%5', '%30'), crow('%6', '%1'), crow('%5', '%1')))], [['%5', null], ['%6', '%1']], 'the same pane twice, with another value: ambiguous');
    assert.deepEqual([...parentTags(read(crow('%5', '%30'), crow('%5', '%30')))], [['%5', null]], 'even the same value twice');
    assert.deepEqual([...parentTags(read(crow('%5', ' %30 ')))], [['%5', ' %30 ']]);
  });

  // review S2: a tab in `pane_title` (field 3) shifts every later field, and a tab in the trailing kind makes the line as ambiguous: a line with more fields than the format is unknown
  test('P-10 (\u2212) a line with more fields than the format maps its pane to null (closed), like a pane id on two lines: tabs in the kind, tabs in the title, the forged title of the review', () => {
    // old assertion (round 3, in the (+) test): crow('%9', '%1', ['a tab', 'and more']) read as ['%9', '%1'] (a kind with tabs does not shift the parent)
    assert.deepEqual([...parentTags(read(crow('%9', '%1', ['a tab', 'and more'])))], [['%9', null]], 'tabs in the kind');
    assert.deepEqual([...parentTags(read(crow('%9', '%1', ['x'])))], [['%9', null]], 'one tab more than the format');
    // the title carries k tabs: field 3 + k pieces; the later fields move by k. From k = 5 a piece of the title lands in field 8
    const titled = (id, k, piece) => {
      const f = crow(id, '%1').split('\t');
      f.splice(3, 1, ...[...Array.from({ length: k }, (_, i) => `t${i}`), piece]); // the title is k + 1 pieces, the last one is `piece`
      return f.join('\t');
    };
    for (let k = 1; k <= 8; k += 1) {
      const line = titled('%9', k, '%3');
      assert.equal(line.split('\t').length, COLLECTOR_FIELDS + k, `k = ${k}: ${COLLECTOR_FIELDS + k} fields`);
      assert.deepEqual([...parentTags(read(line))], [['%9', null]], `k = ${k}`);
    }
    assert.equal(titled('%9', 5, '%3').split('\t')[COLLECTOR_PARENT_FIELD], '%3', 'the shape of the review: with 5 tabs the piece %3 is read as the parent');
    // the short and the honest line around it are not affected
    assert.deepEqual([...parentTags(read(crow('%5', '%30'), titled('%9', 5, '%3'), crow('%6', '%1')))], [['%5', '%30'], ['%9', null], ['%6', '%1']]);
  });

  test('P-10 (\u2212) from the read to the placement: the window of a forged-title pane is closed to the parent it names, and so is a window with a tabbed kind', () => {
    const titled = crow('%62', '%1').split('\t');
    titled.splice(3, 1, 't0', 't1', 't2', 't3', 't4', '%3'); // 5 tabs in the title: the piece %3 is read as the parent
    const forged = titled.join('\t');
    const pane = (id, o = {}) => agent(id, `x${id.slice(1)}`, { w: 99, h: 24, ...o });
    const rows = () => rowsOf(win('@1', { active: 1 }, [orch('%1', { w: 100 })]), win('@6', { index: 5 }, [pane('%61'), pane('%62', { w: 100 })]));
    const honest = parentTags(read(crow('%1', ''), crow('%61', '%3'), crow('%62', '%3')));
    assert.deepEqual(place({ rows: rows(), key: KEY, parent: '%3', parents: honest }), split('%62', '-h', '@6', 'tiled'), 'the control: both panes are %3\'s');
    const attacked = parentTags(read(crow('%1', ''), crow('%61', '%3'), forged));
    assert.deepEqual(place({ rows: rows(), key: KEY, parent: '%3', parents: attacked }), WINDOW, 'the forged line claimed %3; it is unknown now');
    const tabbed = parentTags(read(crow('%1', ''), crow('%61', '%3'), crow('%62', '%3', ['a tab', 'and more'])));
    assert.deepEqual(place({ rows: rows(), key: KEY, parent: '%3', parents: tabbed }), WINDOW, 'a kind with tabs: unknown, so closed');
  });
});
