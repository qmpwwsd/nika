// src/place.js (0.5.4, P1): the pure placement rule. Synthetic listings only; the sizes are the ones tmux 3.8 gave in spike S-P1.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_COLS, MIN_ROWS, AGENTS_WINDOW, PLACE_FORMAT, COLLECTOR_FIELDS, parsePlaceRows, readPlaceListing, isStrictPaneListing, tiledGrid, cell, fitsH, fitsV, tileFits, place, isAgentsWindow } from '../src/place.js';

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
    assert.equal(place({ rows: rowsOf(FULL_HOME(), mixed), key: KEY, parent: '%1' }).tile, '@2');
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
