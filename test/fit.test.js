// W7 fit controller (design-W7 §12.1): a scripted in-memory tmux (windows, panes, zoom, sizes, the window-size option, layouts
// with the 3.8 active/last markers, the `@nika-fit` tag) answers only the argv shapes of design §4; any other argv, or a
// mutation outside the pane lock, is recorded in `bad` and fails the test that made it. Synthetic data only.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFit, checkFitBody, LAPSE_MS, WATCH_MS, RELEASE_ALL_MS, LEASE_FILE_MAX, LEASE_FILES_MAX } from '../src/fit.js';
import { FIT_NONCE, WINDOW_ID } from '../src/ids.js';
import { createSessionControl } from '../src/session-control.js';

const TMUX = '/opt/x/tmux';
// spelled out here on purpose: a change of the format in src/fit.js must fail this file
const FMT = ['#{pane_id}', '#{window_id}', '#{window_panes}', '#{window_zoomed_flag}', '#{pane_active}', '#{window_width}', '#{window_height}', '#{pane_width}', '#{pane_height}', '#{pane_current_command}', '#{@nika-fit}'].join('\t');
const WIN = /^@\d{1,6}$/;
const PANE = /^%\d{1,6}$/;
const MUTATING = new Set(['tag', 'untag', 'zoom', 'size', 'optUnset', 'optSet', 'select', 'focus']);
const strip = (s) => s.replace(/,"(a|l)":(true|\d+)/g, '');
const tmuxErr = (stderr, code = 1) => Object.assign(new Error(stderr), { code, stderr: `${stderr}\n` });

/** Name of a design §4 argv shape (argv without the leading -u), or null for anything else. */
function shape(a) {
  const eq = (...x) => a.length === x.length && x.every((v, i) => (v instanceof RegExp ? v.test(a[i]) : v === a[i]));
  if (eq('list-panes', '-a', '-F', FMT)) return 'list';
  if (eq('display-message', '-p', '-t', WIN, '-F', '#{window_layout}')) return 'layout';
  if (eq('show-options', '-w', '-t', WIN, 'window-size')) return 'option';
  if (eq('set-option', '-w', '-t', WIN, '@nika-fit', /^[0-9a-f]{16}$/)) return 'tag';
  if (eq('set-option', '-wu', '-t', WIN, '@nika-fit')) return 'untag';
  if (eq('resize-pane', '-Z', '-t', PANE)) return 'zoom';
  if (eq('resize-window', '-t', WIN, '-x', /^\d{1,5}$/, '-y', /^\d{1,5}$/)) return 'size';
  if (eq('set-option', '-wu', '-t', WIN, 'window-size')) return 'optUnset';
  if (eq('set-option', '-w', '-t', WIN, 'window-size', /^(latest|largest|smallest|manual)$/)) return 'optSet';
  if (eq('select-layout', '-t', WIN, '--', /^[\x20-\x7e]{1,8192}$/)) return 'select';
  if (eq('select-pane', '-t', PANE)) return 'focus';
  return null;
}

function makeWorld() {
  const wins = new Map();
  const world = { wins, calls: [], bad: [], locked: 0, lockIds: [], fail: null, block: null, after: null, junk: [], noServer: false, enoent: false };
  const num = (id) => Number(id.slice(1));
  const paneSize = (w, p) => p.size ?? (w.panes.length === 1 || (w.zoomed && p.id === w.active) ? [w.width, w.height] : [Math.floor(w.width / w.panes.length), w.height]);
  const layoutOf = (w) => w.pinned ?? `{"w":${w.width},"h":${w.height},"s":"${w.arr}","p":[${w.panes.map((p) => `{"i":${num(p.id)}${p.id === w.active ? ',"a":true' : ''}${p.id === w.last ? `,"l":${num(p.id)}` : ''}}`).join(',')}]}`;
  const winOf = (pane) => [...wins.values()].find((w) => w.panes.some((p) => p.id === pane));
  const setActive = (w, id) => { if (w.active !== id) { w.last = w.active; w.active = id; } };
  const win = (id) => { const w = wins.get(id); if (!w) throw tmuxErr(`can't find window: ${id}`); return w; };

  world.add = (id, panes, width, height) => {
    wins.set(id, { id, panes: panes.map(([pid, command]) => ({ id: pid, command })), active: panes[0][0], last: null, zoomed: false, width, height, sizeOpt: null, tag: '', arr: 'even', pinned: undefined });
  };
  world.layoutOf = layoutOf;
  world.paneSize = paneSize;
  world.setActive = setActive;
  /** What a restore must give back exactly: sizes, zoom, focus, the window-size option, the tag and the layout without markers. */
  world.snap = (id) => {
    const w = win(id);
    return { width: w.width, height: w.height, zoomed: w.zoomed, active: w.active, sizeOpt: w.sizeOpt, tag: w.tag, layout: strip(layoutOf(w)), sizes: w.panes.map((p) => paneSize(w, p)) };
  };
  world.lock = async (id, fn) => {
    world.locked += 1;
    world.lockIds.push(id);
    try {
      return await fn();
    } finally {
      world.locked -= 1;
    }
  };

  function apply(name, a) {
    switch (name) {
      case 'list': {
        const lines = [];
        for (const w of wins.values()) {
          for (const p of w.panes) lines.push([p.id, w.id, w.panes.length, w.zoomed ? 1 : 0, p.id === w.active ? 1 : 0, w.width, w.height, ...paneSize(w, p), p.command, w.tag].join('\t'));
        }
        return `${[...lines, ...world.junk].join('\n')}\n`;
      }
      case 'layout': return `${layoutOf(win(a[3]))}\n`;
      case 'option': { const w = win(a[3]); return w.sizeOpt ? `window-size ${w.sizeOpt}\n` : ''; }
      case 'tag': win(a[3]).tag = a[5]; return '';
      case 'untag': win(a[3]).tag = ''; return '';
      case 'optUnset': win(a[3]).sizeOpt = null; return '';
      case 'optSet': win(a[3]).sizeOpt = a[5]; return '';
      case 'size': { const w = win(a[2]); w.width = Number(a[4]); w.height = Number(a[6]); w.sizeOpt = 'manual'; return ''; }
      case 'zoom': { // a toggle on the window, whichever pane is named; a no-op on a single pane (spike S10)
        const w = winOf(a[3]);
        if (!w) throw tmuxErr(`can't find pane: ${a[3]}`);
        if (w.panes.length > 1) {
          if (w.zoomed) w.zoomed = false;
          else { w.zoomed = true; setActive(w, a[3]); }
        }
        return '';
      }
      case 'focus': { // without -Z it also ends a zoom
        const w = winOf(a[2]);
        if (!w) throw tmuxErr(`can't find pane: ${a[2]}`);
        w.zoomed = false;
        setActive(w, a[2]);
        return '';
      }
      case 'select': {
        const w = win(a[2]);
        const L = JSON.parse(a[4]);
        if (L.p.length !== w.panes.length) throw tmuxErr(`have ${w.panes.length} panes but need ${L.p.length}`);
        w.width = L.w; w.height = L.h; w.arr = L.s; w.zoomed = false;
        const on = L.p.find((p) => p.a);
        if (on) setActive(w, `%${on.i}`);
        return '';
      }
      default: throw new Error(`unhandled ${name}`);
    }
  }

  world.exec = async (cmd, args) => {
    const a = args.slice(1);
    const name = cmd === TMUX && args[0] === '-u' ? shape(a) : null;
    world.calls.push({ name, argv: a, locked: world.locked });
    if (!name) {
      world.bad.push(args);
      throw new Error(`unexpected tmux argv: ${args.join(' ')}`);
    }
    if (MUTATING.has(name) && world.locked === 0) world.bad.push(['outside the pane lock', ...a]);
    if (world.enoent) throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    if (world.noServer) throw tmuxErr('no server running on /tmp/tmux-1/default');
    if (world.fail?.(name, a)) throw tmuxErr(`${name} failed`);
    const gate = world.block?.(name, a);
    if (gate) await gate;
    const out = apply(name, a);
    world.after?.(name, a);
    return { stdout: out, stderr: '' };
  };
  return world;
}

const rigs = [];
/** A world with @1 (zsh %1, claude %2, claude %3; 200x50; %1 active) and @2 (claude %4; 80x24), and a controller over a temp state dir. */
function rig(setup) {
  const world = makeWorld();
  world.add('@1', [['%1', 'zsh'], ['%2', 'claude'], ['%3', 'claude']], 200, 50);
  world.add('@2', [['%4', 'claude']], 80, 24);
  setup?.(world);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-fit-'));
  const clock = { t: 1_000_000 };
  const logs = [];
  const sched = { fn: null, ms: null, on: false, starts: 0 };
  const sleepers = [];
  const make = () => createFit({
    exec: world.exec,
    tmuxBin: TMUX,
    now: () => clock.t,
    stateDir: dir,
    lock: world.lock,
    log: (m) => logs.push(m),
    schedule: (fn, ms) => { sched.fn = fn; sched.ms = ms; sched.on = true; sched.starts += 1; return () => { sched.on = false; }; },
    sleep: (ms) => new Promise((res) => { sleepers.push({ ms, res }); }),
  });
  const fitDir = path.join(dir, 'fit');
  const r = {
    world, dir, clock, logs, sched, sleepers, make, fitDir, fit: make(),
    file: (nonce) => path.join(fitDir, `fit-${nonce}.json`),
    lease: (nonce) => JSON.parse(fs.readFileSync(path.join(fitDir, `fit-${nonce}.json`), 'utf8')),
    files: () => (fs.existsSync(fitDir) ? fs.readdirSync(fitDir).sort() : []),
    tag: (w = '@1') => world.wins.get(w).tag,
    tick: () => sched.fn(),
    put: (id, cols, rows, open = true, fit = r.fit) => fit.hold(id, { cols, rows, open }),
    /** index into the call log, to look at "what came after" */
    at: () => world.calls.length,
    names: (from = 0) => world.calls.slice(from).map((c) => c.name),
    argv: (from = 0) => world.calls.slice(from).map((c) => c.argv),
    plant: (name, content, mode = 0o600) => {
      fs.mkdirSync(fitDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(fitDir, 0o700);
      fs.writeFileSync(path.join(fitDir, name), typeof content === 'string' ? content : JSON.stringify(content), { mode });
    },
  };
  rigs.push(r);
  return r;
}

afterEach(() => {
  const all = rigs.splice(0);
  for (const r of all) fs.rmSync(r.dir, { recursive: true, force: true });
  for (const r of all) assert.deepEqual(r.world.bad, [], 'tmux argv outside design section 4 or a mutation outside the lock');
});

/** Polls (event-loop turns, bounded by wall time) until `cond()` holds; throws instead of hanging. */
async function until(cond, ms = 2000) {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error('until: condition not reached');
    await new Promise((res) => setImmediate(res));
  }
}
const ans = (state, reason, cols, rows, panes, userZoom = false) => ({ status: 200, body: { fit: { state, reason, pane: { cols, rows }, panes, userZoom } } });
const NF = { status: 404, body: { error: 'not_found', message: 'pane not found' } };
/** A lease file as the controller writes it; tests overwrite single fields. */
const goodFile = (over = {}) => ({
  v: 1, nonce: '0123456789abcdef', window: '@1', pane: '%2', panes: 3, zoomed0: 0, active0: '%1', width0: 200, height0: 50, size0: null,
  layout0: '{"w":200,"h":50}', layout1: '{"w":220,"h":60}', cols: 220, rows: 60, resized: true, userZoom: false, at: 1_000_000, ...over,
});
const REL_FULL = ['list', 'layout', 'zoom', 'size', 'optUnset', 'select', 'focus', 'untag', 'list'];

describe('checkFitBody', () => {
  test('(+) exactly cols, rows and open; the bounds are inclusive', () => {
    assert.deepEqual(checkFitBody({ cols: 40, rows: 10, open: true }), { value: { cols: 40, rows: 10, open: true } });
    assert.deepEqual(checkFitBody({ cols: 400, rows: 200, open: false }), { value: { cols: 400, rows: 200, open: false } });
  });

  test('(−) other shapes are refused with the contract message', () => {
    const msg = 'cols must be an integer 40–400, rows 10–200, open a boolean';
    for (const bad of [
      null, 'x', [], {}, { cols: 120, rows: 40 }, { cols: 120, rows: 40, open: 'true' }, { cols: 120.5, rows: 40, open: true },
      { cols: '120', rows: 40, open: true }, { cols: 39, rows: 40, open: true }, { cols: 401, rows: 40, open: true },
      { cols: 120, rows: 9, open: true }, { cols: 120, rows: 201, open: true }, { cols: NaN, rows: 40, open: true },
      { cols: 120, rows: 40, open: true, extra: 1 },
    ]) assert.deepEqual(checkFitBody(bad), { error: msg }, JSON.stringify(bad));
  });
});

describe('ids', () => {
  test('(+/−) WINDOW_ID and FIT_NONCE accept only their shapes', () => {
    assert.ok(WINDOW_ID.test('@0') && WINDOW_ID.test('@123456'));
    for (const bad of ['@', '@x', '@1234567', '1', '%1', '@1 ', '@1\n', '../@1']) assert.ok(!WINDOW_ID.test(bad), bad);
    assert.ok(FIT_NONCE.test('0123456789abcdef'));
    for (const bad of ['0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', '0123456789abcdeg', '']) assert.ok(!FIT_NONCE.test(bad), bad);
  });
});

describe('acquire', () => {
  test('(+) 3-pane window, panel at least as big: the exact argv of A1-A5, the lease file, fitted', async () => {
    const r = rig();
    const w = r.world.wins.get('@1');
    const L0 = r.world.layoutOf(w);
    const res = await r.put('%2', 220, 60);
    assert.deepEqual(res, ans('fitted', null, 220, 60, 3));
    const nonce = r.tag();
    assert.match(nonce, /^[0-9a-f]{16}$/);
    assert.deepEqual(r.argv(), [
      ['list-panes', '-a', '-F', FMT],
      ['show-options', '-w', '-t', '@1', 'window-size'],
      ['display-message', '-p', '-t', '@1', '-F', '#{window_layout}'],
      ['list-panes', '-a', '-F', FMT], // read again inside the pane lock, which may have waited (review I1) ...
      ['display-message', '-p', '-t', '@1', '-F', '#{window_layout}'], // ... with the layout and window-size that a restore will put back (fix round 2)
      ['show-options', '-w', '-t', '@1', 'window-size'],
      ['set-option', '-w', '-t', '@1', '@nika-fit', nonce],
      ['resize-pane', '-Z', '-t', '%2'],
      ['resize-window', '-t', '@1', '-x', '220', '-y', '60'],
      ['list-panes', '-a', '-F', FMT],
      ['display-message', '-p', '-t', '@1', '-F', '#{window_layout}'],
    ]);
    assert.deepEqual(r.world.lockIds, ['%2'], 'the three mutations ran in one pane lock for %2');
    assert.deepEqual(r.lease(nonce), goodFile({ nonce, layout0: L0, layout1: r.world.layoutOf(w), cols: 220, rows: 60 }));
    assert.equal(fs.statSync(r.file(nonce)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(r.fitDir).mode & 0o777, 0o700);
    assert.deepEqual([w.zoomed, w.active, w.width, w.height], [true, '%2', 220, 60]);
    assert.equal(r.fit.size(), 1);
    assert.equal(r.sched.on, true);
    assert.equal(r.sched.ms, WATCH_MS);
  });

  test('(+) the lease file is written before the first tmux mutation', async () => {
    const r = rig();
    let seen = null;
    r.world.after = (name) => { if (name === 'tag' && seen === null) seen = r.files(); };
    await r.put('%2', 220, 60);
    assert.deepEqual(seen, [`fit-${r.tag()}.json`]);
  });

  test('(+) single-pane window: no zoom, a resize to the panel, bigger or smaller; equal size runs no resize', async () => {
    for (const [cols, rows, want] of [[100, 30, ['size']], [60, 15, ['size']], [80, 24, []]]) {
      const r = rig();
      const res = await r.put('%4', cols, rows);
      assert.deepEqual(res, ans('fitted', null, cols, rows, 1));
      assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', ...want, 'list', 'layout']);
      assert.ok(!r.names().includes('zoom'));
      assert.deepEqual([r.world.wins.get('@2').width, r.world.wins.get('@2').height], [cols, rows]);
    }
  });

  test('(+) the user had the mirrored pane zoomed: nika neither zooms nor unzooms, and says userZoom', async () => {
    const r = rig((w) => { const x = w.wins.get('@1'); x.zoomed = true; x.active = '%2'; });
    const res = await r.put('%2', 220, 60);
    assert.deepEqual(res, ans('fitted', null, 220, 60, 3, true));
    assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'size', 'list', 'layout']);
    const at = r.at();
    assert.equal((await r.fit.release('%2')).body.released, true);
    assert.deepEqual(r.names(at), ['list', 'layout', 'size', 'optUnset', 'untag', 'list'], 'no unzoom, no layout (it would end the user zoom), no focus');
    const w = r.world.wins.get('@1');
    assert.deepEqual([w.zoomed, w.active, w.width, w.height], [true, '%2', 200, 50]);
  });

  test('(+) multi-pane window, panel smaller: zoom only, no resize-window, zoomed / panel-smaller', async () => {
    const r = rig();
    const res = await r.put('%2', 100, 30);
    assert.deepEqual(res, ans('zoomed', 'panel-smaller', 200, 50, 3));
    assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'list', 'layout']);
    const w = r.world.wins.get('@1');
    assert.deepEqual([w.zoomed, w.width, w.height], [true, 200, 50]);
  });

  test('(+) one dimension smaller is still "smaller": no resize', async () => {
    const r = rig();
    assert.deepEqual(await r.put('%2', 300, 40), ans('zoomed', 'panel-smaller', 200, 50, 3));
    assert.ok(!r.names().includes('size'));
  });

  test('(+) a fresh nonce for every lease', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const first = r.tag();
    await r.fit.release('%2');
    await r.put('%2', 220, 60);
    assert.match(r.tag(), FIT_NONCE);
    assert.notEqual(r.tag(), first);
  });

  test('(+) a window-level size option that is one of the four values is kept for the restore', async () => {
    const r = rig((w) => { w.wins.get('@1').sizeOpt = 'manual'; });
    await r.put('%2', 220, 60);
    assert.equal(r.lease(r.tag()).size0, 'manual');
  });
});

describe('acquire: refusals (nothing is changed)', () => {
  test('(−) a pane that is not a claude pane is 404 after one listing', async () => {
    const r = rig();
    assert.deepEqual(await r.put('%1', 220, 60), NF);
    assert.deepEqual(await r.put('%99', 220, 60), NF);
    assert.deepEqual(r.names(), ['list', 'list']);
    assert.equal(r.fit.size(), 0);
    assert.deepEqual(r.files(), []);
  });

  test('(−) an unknown window-size value: blocked / size-option, no tag, no file, no mutation', async () => {
    const r = rig((w) => { w.wins.get('@1').sizeOpt = 'weird'; });
    assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'size-option', 66, 50, 3));
    assert.deepEqual(r.names(), ['list', 'option']);
    assert.equal(r.tag(), '');
    assert.deepEqual(r.files(), []);
    assert.equal(r.sched.starts, 0);
  });

  test('(−) the user zoomed another pane: blocked / user-zoom, text scaled, nothing changed (owner answer Q1)', async () => {
    const r = rig((w) => { const x = w.wins.get('@1'); x.zoomed = true; x.active = '%3'; });
    const res = await r.put('%2', 220, 60);
    assert.deepEqual(res, ans('blocked', 'user-zoom', 66, 50, 3));
    assert.deepEqual(r.names(), ['list', 'option']);
    assert.deepEqual(r.files(), []);
    assert.equal(r.tag(), '');
    assert.equal(r.world.wins.get('@1').active, '%3');
  });

  test('(−) the size option outranks the user zoom (the first matching row decides)', async () => {
    const r = rig((w) => { const x = w.wins.get('@1'); x.zoomed = true; x.active = '%3'; x.sizeOpt = 'weird'; });
    assert.equal((await r.put('%2', 220, 60)).body.fit.reason, 'size-option');
  });

  test('(−) a layout with #, over 8 KB, with a control character or empty is never applied: blocked / changed', async () => {
    for (const bad of ['{"w":200}#{x}', 'x'.repeat(8193), 'a\u0001b', '', 'café']) {
      const r = rig((w) => { w.wins.get('@1').pinned = bad; });
      const res = await r.put('%2', 220, 60);
      assert.equal(res.body.fit.state, 'blocked', JSON.stringify(bad.slice(0, 20)));
      assert.equal(res.body.fit.reason, 'changed');
      assert.deepEqual(r.names(), ['list', 'option', 'layout']);
      assert.deepEqual(r.files(), []);
      assert.equal(r.tag(), '');
    }
  });

  test('(−) layouts that would make the lease file larger than 16 KB are refused the same way', async () => {
    const big = '"'.repeat(8000); // printable, but every quote is escaped in the file, twice
    const r = rig((w) => { w.wins.get('@1').pinned = big; });
    const res = await r.put('%2', 220, 60);
    assert.equal(res.body.fit.reason, 'changed');
    assert.deepEqual(r.files(), []);
    assert.equal(LEASE_FILE_MAX, 16 * 1024);
    assert.deepEqual(r.names(), ['list', 'option', 'layout']);
  });

  test('(−) cols and rows out of range never reach exec; neither does a malformed pane id', async () => {
    const r = rig();
    for (const body of [
      { cols: 39, rows: 40, open: true }, { cols: 401, rows: 40, open: true }, { cols: 120, rows: 9, open: true }, { cols: 120, rows: 201, open: true },
      { cols: 120.5, rows: 40, open: true }, { cols: '120', rows: 40, open: true }, { cols: 120, rows: 40 }, { cols: 120, rows: 40, open: 1 }, null,
    ]) {
      const res = await r.fit.hold('%2', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, 'invalid');
    }
    for (const id of ['5', '%', '%1;', '%1234567', '', '%2 ', undefined, 7]) {
      assert.equal((await r.fit.hold(id, { cols: 120, rows: 40, open: true })).status, 400, String(id));
      assert.equal((await r.fit.release(id)).status, 400, String(id));
    }
    assert.deepEqual(r.world.calls, []);
  });

  test('(−) tmux not running: 503 tmux_unavailable; tmux missing: 503; another failure: 502', async () => {
    const r = rig((w) => { w.noServer = true; });
    assert.equal((await r.put('%2', 220, 60)).status, 503);
    const e = rig((w) => { w.enoent = true; });
    assert.equal((await e.put('%2', 220, 60)).body.error, 'tmux_unavailable');
    const f = rig((w) => { w.fail = (name) => name === 'list'; });
    assert.deepEqual((await f.put('%2', 220, 60)).status, 502);
  });

  test('(−) a failing zoom: 502, the lease is released best effort, tag and file are gone', async () => {
    const r = rig();
    r.world.fail = (name) => name === 'zoom';
    const res = await r.put('%2', 220, 60);
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'tmux_failed');
    assert.equal(r.tag(), '');
    assert.deepEqual(r.files(), []);
    assert.equal(r.fit.size(), 0);
    assert.equal(r.sched.on, false);
  });

  test('(−) malformed listing rows are dropped; the good rows still work', async () => {
    const r = rig((w) => { w.junk = ['%x\t@1\t1\t0\t1\t1\t1\t1\t1\tclaude\t', '%9\t@1\t1', '%8\t@1\t0\t0\t1\t80\t24\t80\t24\tclaude\t', '%7\t@1\t1\t2\t1\t80\t24\t80\t24\tclaude\t', '', 'junk'].map((l) => l); });
    assert.deepEqual(await r.put('%2', 220, 60), ans('fitted', null, 220, 60, 3));
  });
});

describe('renew', () => {
  test('(+) the same size is a heartbeat: no tmux call at all, and it extends the lapse', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const at = r.at();
    r.clock.t += 10_000;
    assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 3));
    assert.equal(r.at(), at, 'no tmux call');
    r.clock.t += 10_000; // 20 s after acquire, 10 s after the heartbeat
    await r.tick();
    assert.equal(r.fit.size(), 1, 'not lapsed');
  });

  test('(+) a larger panel resizes the window and rewrites the lease file (cols, rows, layout1)', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    const at = r.at();
    assert.deepEqual(await r.put('%2', 240, 70, false), ans('fitted', null, 240, 70, 3));
    assert.deepEqual(r.argv(at), [
      ['list-panes', '-a', '-F', FMT],
      ['list-panes', '-a', '-F', FMT], // read again inside the pane lock, which may have waited (N1)
      ['resize-window', '-t', '@1', '-x', '240', '-y', '70'],
      ['list-panes', '-a', '-F', FMT],
      ['display-message', '-p', '-t', '@1', '-F', '#{window_layout}'],
    ]);
    const f = r.lease(nonce);
    assert.deepEqual([f.cols, f.rows, f.resized], [240, 70, true]);
    assert.equal(f.layout1, r.world.layoutOf(r.world.wins.get('@1')));
    assert.equal(f.layout0.includes('"w":200'), true, 'layout0 is the original');
    assert.equal(r.tag(), nonce, 'the same lease');
  });

  test('(+) a panel that shrinks below the original size resizes back to exactly W0xH0, never below', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    const at = r.at();
    assert.deepEqual(await r.put('%2', 100, 30, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
    assert.deepEqual(r.argv(at)[2], ['resize-window', '-t', '@1', '-x', '200', '-y', '50']);
    assert.equal(r.lease(nonce).resized, false);
    await r.tick();
    assert.equal(r.fit.size(), 1, 'the window is at the size nika expects now');
    assert.deepEqual(await r.put('%2', 100, 30, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
    const at2 = r.at();
    assert.equal((await r.put('%2', 90, 25, false)).body.fit.state, 'zoomed');
    assert.deepEqual(r.names(at2), ['list'], 'a smaller panel at the original size changes nothing in tmux');
  });

  test('(+) a panel that grows again after a shrink fits again', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.put('%2', 100, 30, false);
    assert.deepEqual(await r.put('%2', 250, 80, false), ans('fitted', null, 250, 80, 3));
    assert.deepEqual([r.world.wins.get('@1').width, r.world.wins.get('@1').height], [250, 80]);
  });

  test('(+) single-pane window: any new size resizes', async () => {
    const r = rig();
    await r.put('%4', 100, 30);
    assert.deepEqual(await r.put('%4', 60, 15, false), ans('fitted', null, 60, 15, 1));
    assert.deepEqual([r.world.wins.get('@2').width, r.world.wins.get('@2').height], [60, 15]);
  });

  test('(−) the user unzoomed since the last tick: no resize, the lease is released, blocked / user-change', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').zoomed = false;
    const at = r.at();
    const res = await r.put('%2', 240, 70, false);
    assert.equal(res.body.fit.state, 'blocked');
    assert.equal(res.body.fit.reason, 'user-change');
    assert.deepEqual(r.names(at), ['list', 'list', 'layout', 'size', 'optUnset', 'select', 'focus', 'untag', 'list', 'list'], 'the last list is the one the answer is built from');
    assert.deepEqual(res, ans('blocked', 'user-change', 66, 50, 3));
    assert.deepEqual(r.argv(at)[3], ['resize-window', '-t', '@1', '-x', '200', '-y', '50'], 'the only resize is the restore, not the 240x70 asked for');
    assert.deepEqual(r.world.wins.get('@1').width, 200);
    assert.equal(r.fit.size(), 0);
  });

  test('(−) a read-back mismatch after a renew resize releases: blocked / changed', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.after = (name) => { if (name === 'size') r.world.wins.get('@1').zoomed = false; };
    const res = await r.put('%2', 240, 70, false);
    assert.equal(res.body.fit.reason, 'changed');
    assert.equal(r.fit.size(), 0);
    assert.equal(r.tag(), '');
  });
});

describe('other lease holders', () => {
  test('(+) open:false for another pane of a leased window is "other": one listing, nothing else, the lease untouched', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    const at = r.at();
    assert.deepEqual(await r.put('%3', 120, 40, false), ans('other', null, 73, 60, 3)); // %3 is hidden behind the zoom: its layout size
    assert.deepEqual(r.names(at), ['list']);
    assert.equal(r.tag(), nonce);
    assert.equal(r.fit.size(), 1);
  });

  test('(+) open:true takes the window over: the first lease is fully released, then the second is acquired', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    await r.put('%2', 220, 60);
    const first = r.tag();
    const at = r.at();
    const res = await r.put('%3', 230, 55);
    assert.deepEqual(res, ans('fitted', null, 230, 55, 3));
    assert.deepEqual(r.names(at), ['list', ...REL_FULL, 'list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout']);
    assert.notEqual(r.tag(), first);
    assert.deepEqual(r.files(), [`fit-${r.tag()}.json`]);
    assert.equal(r.lease(r.tag()).pane, '%3');
    assert.equal(r.world.wins.get('@1').active, '%3');
    await r.fit.release('%3');
    assert.deepEqual(r.world.snap('@1'), before, 'both leases left no trace');
  });

  test('(+) leases of different windows are independent', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    assert.equal((await r.put('%4', 100, 30)).body.fit.state, 'fitted');
    assert.equal(r.fit.size(), 2);
  });

  test('(−) a request for a pane of a window another pane\'s request is working on is 409 busy; the same pane waits its turn', async () => {
    const r = rig();
    let open;
    const gate = new Promise((res) => { open = res; });
    r.world.block = (name) => (name === 'zoom' ? gate : undefined);
    const first = r.put('%2', 220, 60);
    await until(() => r.names().includes('zoom'));
    const second = await r.put('%3', 120, 40, false);
    assert.deepEqual(second.status, 409);
    assert.equal(second.body.error, 'busy');
    const same = r.put('%2', 230, 60, false); // waits behind `first`
    r.world.block = null;
    open();
    assert.equal((await first).body.fit.state, 'fitted');
    assert.deepEqual((await same).body.fit.pane, { cols: 230, rows: 60 });
    assert.equal(r.fit.size(), 1);
  });

  test('(−) a tag nika does not hold and no lease file for it: blocked / foreign-tag, the tag is left alone', async () => {
    for (const tag of ['ffffffffffffffff', 'not-a-nonce']) {
      const r = rig((w) => { w.wins.get('@1').tag = tag; });
      const res = await r.put('%2', 220, 60);
      assert.deepEqual(res, ans('blocked', 'foreign-tag', 66, 50, 3));
      assert.deepEqual(r.names(), ['list']);
      assert.equal(r.tag(), tag);
      assert.deepEqual(r.files(), []);
    }
  });

  test('(−) a lease file for that tag that names another window is not applied: blocked / foreign-tag', async () => {
    const r = rig((w) => { w.wins.get('@1').tag = '0123456789abcdef'; });
    r.plant('fit-0123456789abcdef.json', goodFile({ window: '@2', pane: '%4', panes: 1, active0: '%4' }));
    const res = await r.put('%2', 220, 60);
    assert.equal(res.body.fit.reason, 'foreign-tag');
    assert.deepEqual(r.names(), ['list']);
  });

  test('(+) a tag that a lease file of ours explains (a crash left it) is released first, then the window is fitted', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    await r.put('%2', 220, 60);
    const old = r.tag();
    const again = r.make(); // the server restarted: no memory of the lease
    const at = r.at();
    const res = await r.put('%2', 220, 60, true, again);
    assert.equal(res.body.fit.state, 'fitted');
    assert.notEqual(r.tag(), old);
    assert.deepEqual(r.files(), [`fit-${r.tag()}.json`]);
    assert.deepEqual(r.names(at).slice(0, 10), ['list', ...REL_FULL]);
    await again.release('%2');
    assert.deepEqual(r.world.snap('@1'), before);
  });

  test('(−) a lease in memory whose tag is gone is dropped (no tmux mutation) and the window is fitted afresh', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const old = r.tag();
    r.world.wins.get('@1').tag = '';
    const at = r.at();
    const res = await r.put('%2', 250, 70, false);
    assert.equal(res.body.fit.state, 'fitted');
    assert.deepEqual(r.names(at).slice(0, 7), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag']);
    assert.ok(!r.files().includes(`fit-${old}.json`));
  });
});

describe('release', () => {
  test('(−) the lease file goes through removeOwnFile: a file with a second link is not unlinked, the restore still ran and the refusal is logged by code (rule 11)', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    fs.linkSync(r.file(nonce), path.join(r.dir, 'alias.json'));
    assert.deepEqual(await r.fit.release('%2'), { status: 200, body: { released: true } });
    assert.deepEqual(r.world.snap('@1'), before, 'the window is restored all the same');
    assert.ok(fs.existsSync(r.file(nonce)), 'the shared file is left in place');
    assert.deepEqual(r.logs, ['nika: fit lease file unlink failed (ENLINK)']);
  });

  test('(+) the exact restore sequence R0-R9 with the option unset; the window is as before', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    const L0 = r.world.layoutOf(r.world.wins.get('@1'));
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    const at = r.at();
    assert.deepEqual(await r.fit.release('%2'), { status: 200, body: { released: true } });
    assert.deepEqual(r.argv(at), [
      ['list-panes', '-a', '-F', FMT],
      ['display-message', '-p', '-t', '@1', '-F', '#{window_layout}'],
      ['resize-pane', '-Z', '-t', '%2'],
      ['resize-window', '-t', '@1', '-x', '200', '-y', '50'],
      ['set-option', '-wu', '-t', '@1', 'window-size'],
      ['select-layout', '-t', '@1', '--', strip(L0)],
      ['select-pane', '-t', '%1'],
      ['set-option', '-wu', '-t', '@1', '@nika-fit'],
      ['list-panes', '-a', '-F', FMT],
    ]);
    assert.deepEqual(r.world.snap('@1'), before);
    assert.deepEqual(r.files(), []);
    assert.ok(!fs.existsSync(r.file(nonce)));
    assert.equal(r.fit.size(), 0);
    assert.equal(r.sched.on, false, 'the watch stops with the last lease');
    assert.deepEqual(r.logs, []);
  });

  test('(+) the option comes back as its exact value when the window had one', async () => {
    const r = rig((w) => { w.wins.get('@1').sizeOpt = 'smallest'; });
    const before = r.world.snap('@1');
    await r.put('%2', 220, 60);
    const at = r.at();
    await r.fit.release('%2');
    assert.deepEqual(r.argv(at)[4], ['set-option', '-w', '-t', '@1', 'window-size', 'smallest']);
    assert.deepEqual(r.world.snap('@1'), before);
  });

  test('(+) the layout markers are removed before select-layout, and it is passed after --', async () => {
    const r = rig();
    r.world.wins.get('@1').last = '%3';
    const L0m = r.world.layoutOf(r.world.wins.get('@1'));
    assert.match(L0m, /"a":true/);
    assert.match(L0m, /"l":3/);
    await r.put('%2', 220, 60);
    const at = r.at();
    await r.fit.release('%2');
    const sel = r.argv(at).find((a) => a[0] === 'select-layout');
    assert.equal(sel[3], '--');
    assert.doesNotMatch(sel[4], /"(a|l)":/);
    assert.equal(sel[4], strip(L0m));
  });

  test('(+) single-pane window: restored to its size; no unzoom, no focus step', async () => {
    const r = rig();
    const before = r.world.snap('@2');
    await r.put('%4', 100, 30);
    const at = r.at();
    await r.fit.release('%4');
    assert.deepEqual(r.names(at), ['list', 'layout', 'size', 'optUnset', 'select', 'untag', 'list']);
    assert.deepEqual(r.world.snap('@2'), before);
  });

  test('(+) panel smaller (zoom only): unzoom, no size step', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    await r.put('%2', 100, 30);
    const at = r.at();
    await r.fit.release('%2');
    assert.deepEqual(r.names(at), ['list', 'layout', 'zoom', 'optUnset', 'select', 'focus', 'untag', 'list']);
    assert.deepEqual(r.world.snap('@1'), before);
  });

  test('(+) DELETE for a pane without a lease is released:false and runs no tmux call', async () => {
    const r = rig();
    assert.deepEqual(await r.fit.release('%2'), { status: 200, body: { released: false } });
    assert.deepEqual(r.world.calls, []);
  });

  test('(+) DELETE is not eligibility-gated: the pane may already be gone and the window still comes back', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = r.world.wins.get('@1');
    w.panes = w.panes.filter((p) => p.id !== '%2'); // kill-pane: ends the zoom, focus moves
    w.zoomed = false;
    w.active = '%1';
    assert.equal((await r.fit.release('%2')).body.released, true);
    assert.equal(r.tag(), '');
    assert.equal(w.width, 200);
    assert.equal(w.sizeOpt, null);
  });

  test('(+) releaseWindow releases the lease of that window and only that one', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.put('%4', 100, 30);
    assert.equal(await r.fit.releaseWindow('@1'), true);
    assert.equal(r.fit.size(), 1);
    assert.equal(r.tag('@1'), '');
    assert.notEqual(r.tag('@2'), '');
    const at = r.at();
    assert.equal(await r.fit.releaseWindow('@1'), false);
    assert.equal(await r.fit.releaseWindow('@9'), false);
    assert.equal(await r.fit.releaseWindow('../@1'), false);
    assert.equal(r.at(), at, 'no tmux call for a window without a lease');
  });

  test('(−) the user unzoomed: no unzoom (it would zoom again), the layout and size come back', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').zoomed = false; // C-b z
    const at = r.at();
    await r.fit.release('%2');
    assert.deepEqual(r.names(at), ['list', 'layout', 'size', 'optUnset', 'select', 'focus', 'untag', 'list']);
    assert.equal(r.world.wins.get('@1').zoomed, false);
  });

  test('(−) the user changed the layout: the size is restored, select-layout is not run', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = r.world.wins.get('@1');
    w.arr = 'tiled';
    w.zoomed = false;
    const at = r.at();
    await r.fit.release('%2');
    assert.deepEqual(r.names(at), ['list', 'layout', 'size', 'optUnset', 'focus', 'untag', 'list']);
    assert.equal(w.arr, 'tiled', 'the user layout is kept');
    assert.equal(w.width, 200);
  });

  test('(−) the pane count changed: no select-layout, even when the layout string happens to be equal', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = r.world.wins.get('@1');
    w.pinned = r.lease(r.tag()).layout1;
    w.panes.push({ id: '%9', command: 'zsh' });
    w.zoomed = false;
    const at = r.at();
    await r.fit.release('%2');
    assert.ok(!r.names(at).includes('select'));
    assert.ok(r.names(at).includes('size'));
  });

  test('(−) the user zoomed another pane meanwhile: no unzoom, no layout, no focus; the size comes back', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = r.world.wins.get('@1');
    w.active = '%3'; // select-pane -Z -t %3: the zoom moved
    const at = r.at();
    await r.fit.release('%2');
    assert.deepEqual(r.names(at), ['list', 'layout', 'size', 'optUnset', 'untag', 'list']);
    assert.deepEqual([w.zoomed, w.active, w.width], [true, '%3', 200]);
  });

  test('(−) focus the user moved is not taken back', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = r.world.wins.get('@1');
    w.zoomed = false;
    w.active = '%3';
    const at = r.at();
    await r.fit.release('%2');
    assert.ok(!r.names(at).includes('focus'));
    assert.ok(r.names(at).includes('select'), 'moving focus is not a layout change: the markers are ignored when comparing');
    assert.equal(w.active, '%3');
  });

  test('(−) the original active pane is gone: no focus step', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = r.world.wins.get('@1');
    w.panes = w.panes.filter((p) => p.id !== '%1');
    w.zoomed = false;
    w.active = '%2';
    const at = r.at();
    await r.fit.release('%2');
    assert.ok(!r.names(at).includes('focus'));
  });

  test('(−) tag gone, window gone or a different nonce: the lease is dropped, no tmux mutation', async () => {
    for (const how of ['tag', 'window', 'nonce']) {
      const r = rig();
      await r.put('%2', 220, 60);
      const nonce = r.tag();
      if (how === 'tag') r.world.wins.get('@1').tag = '';
      if (how === 'window') r.world.wins.delete('@1');
      if (how === 'nonce') r.world.wins.get('@1').tag = 'ffffffffffffffff';
      const at = r.at();
      assert.equal((await r.fit.release('%2')).body.released, true, how);
      assert.deepEqual(r.names(at), ['list'], how);
      assert.ok(!fs.existsSync(r.file(nonce)), how);
      assert.equal(r.fit.size(), 0);
      if (how === 'nonce') assert.equal(r.tag(), 'ffffffffffffffff', 'a tag that is not ours is never unset');
    }
  });

  test('(−) a failing resize-window does not skip the later steps; the error is logged with its step, not with tmux text', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.fail = (name) => name === 'size';
    const at = r.at();
    assert.equal((await r.fit.release('%2')).body.released, true);
    assert.deepEqual(r.names(at), REL_FULL);
    assert.equal(r.tag(), '', 'R8 always runs');
    assert.deepEqual(r.files(), []);
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /^nika: fit @1 %2 R3 failed/);
    assert.doesNotMatch(r.logs[0], /size failed|layout|"w"/);
  });

  test('(−) when tmux cannot be listed the lease and its file stay, and the error passes through; a later release works', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    r.world.fail = (name) => name === 'list';
    const res = await r.fit.release('%2');
    assert.equal(res.status, 502);
    assert.equal(r.fit.size(), 1);
    assert.ok(fs.existsSync(r.file(nonce)));
    r.world.fail = null;
    assert.equal((await r.fit.release('%2')).body.released, true);
    assert.deepEqual(r.files(), []);
  });

  test('(−) no tmux server any more: the lease is dropped without mutation', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.noServer = true;
    assert.equal((await r.fit.release('%2')).body.released, true);
    assert.deepEqual(r.files(), []);
    assert.equal(r.fit.size(), 0);
  });

  test('(+) a mismatch after the restore is logged once with the window id and no retry', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.after = (name) => { if (name === 'untag') r.world.wins.get('@1').width = 123; };
    const at = r.at();
    await r.fit.release('%2');
    assert.equal(r.names(at).filter((n) => n === 'size').length, 1, 'no retry');
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /^nika: fit restore of @1 differs after /);
  });
});

describe('the lock', () => {
  test('(+) every mutation of acquire, renew and release runs inside the lock of the mirrored pane', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.put('%2', 240, 70, false);
    await r.fit.release('%2');
    assert.ok(r.world.lockIds.length >= 3);
    assert.deepEqual([...new Set(r.world.lockIds)], ['%2']);
    assert.deepEqual(r.world.bad, [], 'the world records a mutation outside the lock');
  });

  test('(+) a lock that is slow delays the mutations; nothing is sent before it hands over', async () => {
    const r = rig();
    let open;
    const gate = new Promise((res) => { open = res; });
    const slow = createFit({
      exec: r.world.exec, tmuxBin: TMUX, now: () => r.clock.t, stateDir: r.dir, log: () => {},
      lock: async (id, fn) => { await gate; return r.world.lock(id, fn); },
      schedule: () => () => {},
    });
    const p = slow.hold('%2', { cols: 220, rows: 60, open: true });
    for (let i = 0; i < 50; i += 1) await new Promise((res) => setImmediate(res)); // lets everything that can run before the lock run
    assert.ok(!r.names().includes('tag'), 'no mutation before the lock is granted');
    open();
    assert.equal((await p).body.fit.state, 'fitted');
  });
});

/** A controller over rig `r` whose lock refuses while `gate.busy` is true, like the session controller's withPaneLock after 5 s. */
function busyRig(r) {
  const gate = { busy: false, refused: 0 };
  const fit = createFit({
    exec: r.world.exec, tmuxBin: TMUX, now: () => r.clock.t, stateDir: r.dir, log: (m) => r.logs.push(m),
    lock: async (id, fn) => {
      if (gate.busy) {
        gate.refused += 1;
        throw Object.assign(new Error('pane is busy'), { code: 'EPANEBUSY' });
      }
      return r.world.lock(id, fn);
    },
    schedule: (fn) => { r.sched.fn = fn; r.sched.on = true; return () => { r.sched.on = false; }; },
    sleep: () => new Promise(() => {}),
  });
  return { fit, gate };
}
const BUSY = { status: 409, body: { error: 'busy', message: 'Claude is busy with another action on this pane. Try again.' } };

describe('the pane lock is busy (EPANEBUSY from withPaneLock, W7-T2 ruling 2)', () => {
  test('(−) acquire: 409 busy, nothing changed on tmux, no lease, no file, no tag', async () => {
    const r = rig();
    const { fit, gate } = busyRig(r);
    gate.busy = true;
    const before = r.world.snap('@1');
    assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: true }), BUSY);
    assert.equal(gate.refused, 1);
    assert.deepEqual(r.world.snap('@1'), before);
    assert.deepEqual(r.files(), []);
    assert.equal(fit.size(), 0);
    assert.ok(!r.names().some((n) => MUTATING.has(n)), 'no mutation ran');
    gate.busy = false;
    assert.equal((await fit.hold('%2', { cols: 220, rows: 60, open: true })).body.fit.state, 'fitted', 'the next request fits as if nothing happened');
  });

  test('(−) renew: 409 busy, the lease and its file stay as they were, a heartbeat at the held size and a watch tick do nothing wrong', async () => {
    const r = rig();
    const { fit, gate } = busyRig(r);
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    const nonce = r.tag();
    const file = fs.readFileSync(r.file(nonce), 'utf8');
    gate.busy = true;
    assert.deepEqual(await fit.hold('%2', { cols: 240, rows: 70, open: false }), BUSY);
    assert.equal(fit.size(), 1, 'the lease is kept');
    assert.equal(fs.readFileSync(r.file(nonce), 'utf8'), file, 'the file still describes the window as nika left it');
    const at = r.at();
    assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: false }), ans('fitted', null, 220, 60, 3), 'the held size is still the held size');
    assert.equal(r.at(), at, 'answered from memory');
    await r.tick();
    assert.equal(fit.size(), 1, 'the watch does not take the unchanged window for a user change');
    assert.equal(r.tag(), nonce);
    gate.busy = false;
    assert.deepEqual(await fit.hold('%2', { cols: 240, rows: 70, open: false }), ans('fitted', null, 240, 70, 3), 'and the renew goes through once the pane is free');
  });

  test('(−) release (DELETE): 409 busy, the lease and the fitted window stay; the next request retries and restores', async () => {
    const r = rig();
    const { fit, gate } = busyRig(r);
    const before = r.world.snap('@1');
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    const nonce = r.tag();
    gate.busy = true;
    assert.deepEqual(await fit.release('%2'), BUSY);
    assert.equal(fit.size(), 1);
    assert.ok(fs.existsSync(r.file(nonce)), 'the file stays for the retry');
    assert.equal(r.tag(), nonce);
    assert.equal(r.sched.on, true, 'the watch keeps running');
    gate.busy = false;
    assert.deepEqual(await fit.release('%2'), { status: 200, body: { released: true } });
    assert.deepEqual(r.world.snap('@1'), before);
    assert.deepEqual(r.files(), []);
  });

  test('(−) the watch: a release that finds the pane busy keeps the lease, and the next tick retries it', async () => {
    const r = rig();
    const { fit, gate } = busyRig(r);
    const before = r.world.snap('@1');
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    r.world.wins.get('@1').zoomed = false; // the user unzoomed
    gate.busy = true;
    await r.tick();
    assert.equal(fit.size(), 1, 'still held');
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /^nika: fit @1 %2 watch failed \(EPANEBUSY\)$/);
    gate.busy = false;
    await r.tick();
    assert.equal(fit.size(), 0);
    assert.equal(r.tag(), '');
    assert.equal(r.world.snap('@1').width, before.width);
  });

  test('(−) a take-over (open:true from another pane) that finds the first pane busy: 409 busy, the first lease is kept', async () => {
    const r = rig();
    const { fit, gate } = busyRig(r);
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    gate.busy = true;
    assert.deepEqual(await fit.hold('%3', { cols: 230, rows: 55, open: true }), BUSY);
    assert.equal(fit.size(), 1);
    assert.equal(r.world.wins.get('@1').tag.length, 16);
  });

  test('(+) a lock that fails for another reason is not a 409: the error still reaches the caller', async () => {
    const r = rig();
    const fit = createFit({ exec: r.world.exec, tmuxBin: TMUX, now: () => r.clock.t, stateDir: r.dir, log: () => {}, lock: async () => { throw Object.assign(new Error('x'), { code: 'EBOOM' }); }, schedule: () => () => {} });
    await assert.rejects(fit.hold('%2', { cols: 220, rows: 60, open: true }), { code: 'EBOOM' });
  });
});

describe('withPaneLock (session-control.js, W7-T2 ruling 2)', () => {
  const idleKeys = () => { const k = { sent: [], send: async (pane, b) => { k.sent.push([pane, b]); return { status: 200, body: {} }; } }; return k; };
  /** A controller whose captures wait on `gate.p`, so an End or a draft write holds the pane lock until the test lets go. */
  function lockRig({ sleep } = {}) {
    const gate = {};
    gate.p = new Promise((res) => { gate.open = res; });
    const entered = [];
    const keys = idleKeys();
    const slept = { n: 0, ms: 0 };
    const control = createSessionControl({
      mirror: { capture: async (pane) => { entered.push(pane); await gate.p; return { status: 503, body: { error: 'tmux_unavailable', message: 'x' } }; } },
      keys,
      paneCommand: async () => 'claude',
      stateOf: async () => 'idle',
      vimOf: () => false,
      sleep: sleep ?? (async (ms) => { slept.n += 1; slept.ms += ms; await new Promise((res) => setImmediate(res)); }),
    });
    return { control, gate, entered, keys, slept };
  }

  test('(+) free pane: it runs fn at once and hands back its result; the pane is free again after, and after a throw', async () => {
    const { control } = lockRig();
    assert.equal(await control.withPaneLock('%6', async () => 42), 42);
    await assert.rejects(control.withPaneLock('%6', async () => { throw new Error('inside'); }), /inside/);
    assert.equal(await control.withPaneLock('%6', () => 'again'), 'again');
  });

  test('(+) it waits while an End or a draft write holds the pane, then runs; another pane is not held up', async () => {
    for (const hold of [(c) => c.endSession('%6'), (c) => c.writeDraft('%6', { text: 'hi', base: '' })]) {
      const { control, gate, entered, slept } = lockRig();
      const holding = hold(control);
      await until(() => entered.length === 1);
      let ran = 0;
      const waiting = control.withPaneLock('%6', async () => { ran += 1; return 'ran'; });
      assert.equal(await control.withPaneLock('%7', async () => 'other pane'), 'other pane');
      await until(() => slept.n >= 3);
      assert.equal(ran, 0, 'not while the End or the write runs');
      gate.open();
      assert.equal(await waiting, 'ran');
      assert.equal(ran, 1);
      await holding;
    }
  });

  test('(+) two waiters run one after the other, never together', async () => {
    const { control, gate, entered } = lockRig();
    const holding = control.endSession('%6');
    await until(() => entered.length === 1);
    let inside = 0;
    let peak = 0;
    const job = () => control.withPaneLock('%6', async () => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((res) => setImmediate(res));
      inside -= 1;
    });
    const both = Promise.all([job(), job()]);
    gate.open();
    await both;
    await holding;
    assert.equal(peak, 1);
  });

  test('(−) it gives up after 5 s with EPANEBUSY and fn never runs (fake sleep)', async () => {
    const { control, entered, slept } = lockRig();
    control.endSession('%6'); // never lets go
    await until(() => entered.length === 1);
    let ran = false;
    await assert.rejects(control.withPaneLock('%6', async () => { ran = true; }), { code: 'EPANEBUSY' });
    assert.equal(ran, false);
    assert.ok(slept.ms >= 5000 && slept.ms < 5100, `waited ${slept.ms} ms in ${slept.n} sleeps`);
  });

  test('(−) hold answers 409 busy when the controller\'s lock gives up, and nothing was changed on tmux', async () => {
    const r = rig();
    const { control, entered } = lockRig();
    control.endSession('%2'); // End holds %2 for good
    await until(() => entered.length === 1);
    const fit = createFit({ exec: r.world.exec, tmuxBin: TMUX, now: () => r.clock.t, stateDir: r.dir, log: () => {}, lock: control.withPaneLock, schedule: () => () => {} });
    assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: true }), BUSY);
    assert.ok(!r.names().some((n) => MUTATING.has(n)));
    assert.equal(r.tag(), '');
  });

  test('(+) a draft write, End and the other controls during a held fit step answer 409 busy-switching and type nothing', async () => {
    const { control, keys, entered, gate } = lockRig();
    let release;
    const held = new Promise((res) => { release = res; });
    const step = control.withPaneLock('%6', () => held); // a fit step in progress
    for (const call of [
      () => control.writeDraft('%6', { text: 'hi', base: '' }),
      () => control.endSession('%6'),
      () => control.runCommand('%6', '/compact'),
      () => control.switchMode('%6', 'plan'),
      () => control.answer('%6', { n: 1, sig: '0123456789abcdef' }),
      () => control.acceptSuggestion('%6', { text: 'go on' }),
    ]) assert.deepEqual(await call(), { status: 409, body: { error: 'busy-switching' } });
    assert.deepEqual(keys.sent, []);
    assert.deepEqual(entered, [], 'not even a capture');
    release();
    await step;
    gate.open();
    assert.equal((await control.endSession('%6')).body.error, 'tmux_unavailable', 'free again: End runs (its capture fails in this rig)');
    assert.deepEqual(entered, ['%6']);
  });
});

describe('the watch', () => {
  test('(+) the watch is scheduled once with WATCH_MS on the first lease and cancelled with the last', async () => {
    const r = rig();
    assert.equal(r.sched.starts, 0);
    await r.put('%2', 220, 60);
    await r.put('%4', 100, 30);
    assert.equal(r.sched.starts, 1);
    assert.equal(r.sched.on, true);
    await r.fit.release('%2');
    assert.equal(r.sched.on, true);
    await r.fit.release('%4');
    assert.equal(r.sched.on, false);
  });

  test('(+) a tick lists once for all leases and does nothing while nothing changed', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.put('%4', 100, 30);
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list']);
    assert.equal(r.fit.size(), 2);
  });

  test('(+) 15 s without a heartbeat releases; 15 s exactly does not; the next request fits again', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    await r.put('%2', 220, 60);
    r.clock.t += LAPSE_MS;
    let at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list']);
    r.clock.t += 1;
    at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list', ...REL_FULL]);
    assert.deepEqual(r.world.snap('@1'), before);
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted', 'a lapse is not a user change');
  });

  test('(−) the user unzoomed (C-b z): released within a tick without a second unzoom; it stays off until open:true (owner answer Q6)', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').zoomed = false;
    const at = r.at();
    await r.tick();
    assert.ok(!r.names(at).includes('zoom'));
    assert.equal(r.fit.size(), 0);
    const off = r.at();
    const res = await r.put('%2', 220, 60, false);
    assert.deepEqual(res, ans('blocked', 'user-change', 66, 50, 3));
    assert.deepEqual(r.names(off), ['list'], 'a heartbeat after a user change touches nothing');
    assert.equal(r.tag(), '');
    assert.equal((await r.put('%2', 220, 60, true)).body.fit.state, 'fitted', 'open:true is the explicit fit-again');
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted');
  });

  test('(−) the user navigated (the active pane is not the mirrored one): released and kept off', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = r.world.wins.get('@1');
    w.zoomed = false;
    w.active = '%3';
    await r.tick();
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(−) a split or a kill (pane count changed), alone or with the unzoom tmux does: released and kept off', async () => {
    for (const unzoom of [false, true]) {
      const r = rig();
      await r.put('%2', 220, 60);
      const w = r.world.wins.get('@1');
      w.panes.push({ id: '%9', command: 'zsh' });
      if (unzoom) w.zoomed = false;
      await r.tick();
      assert.equal(r.fit.size(), 0);
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
    }
  });

  test('(−) the window size is not the size nika set: released and kept off', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').width = 180;
    await r.tick();
    assert.equal(r.fit.size(), 0);
    assert.equal(r.world.wins.get('@1').width, 200, 'the restore sets the original size');
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(−) a single-pane window is not released for "unzoomed"; it is for a size change', async () => {
    const r = rig();
    await r.put('%4', 100, 30);
    await r.tick();
    assert.equal(r.fit.size(), 1);
    r.world.wins.get('@2').height = 31;
    await r.tick();
    assert.equal(r.fit.size(), 0);
  });

  test('(−) the user zoomed another pane: released, the zoom is left alone', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').active = '%3';
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list', 'list', 'layout', 'size', 'optUnset', 'untag', 'list']);
    assert.equal(r.world.wins.get('@1').zoomed, true);
  });

  test('(−) the pane died or no longer runs claude: released, no unzoom and no focus step, and it is not a user change', async () => {
    for (const how of ['dead', 'shell']) {
      const r = rig();
      await r.put('%2', 220, 60);
      const w = r.world.wins.get('@1');
      if (how === 'dead') { w.panes = w.panes.filter((p) => p.id !== '%2'); w.zoomed = false; w.active = '%1'; } else w.panes.find((p) => p.id === '%2').command = 'zsh';
      const at = r.at();
      await r.tick();
      assert.ok(!r.names(at).includes('zoom') || how === 'shell', how);
      assert.equal(r.fit.size(), 0, how);
      assert.equal(r.tag(), '', how);
      assert.equal(w.width, 200, how);
      if (how === 'dead') {
        w.panes.push({ id: '%2', command: 'claude' }); // a new pane that reuses the id
        assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted', 'no user-change mark');
      }
    }
  });

  test('(−) tag gone, window gone or nonce changed: the lease is dropped on the tick, no tmux mutation, not a user change', async () => {
    for (const how of ['tag', 'window', 'nonce']) {
      const r = rig();
      await r.put('%2', 220, 60);
      const nonce = r.tag();
      if (how === 'tag') r.world.wins.get('@1').tag = '';
      if (how === 'window') r.world.wins.delete('@1');
      if (how === 'nonce') r.world.wins.get('@1').tag = 'ffffffffffffffff';
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), ['list'], how);
      assert.equal(r.fit.size(), 0, how);
      assert.ok(!fs.existsSync(r.file(nonce)), how);
      if (how === 'nonce') assert.equal(r.tag(), 'ffffffffffffffff');
    }
  });

  test('(−) no tmux server: every lease is dropped; another listing error keeps the leases for the next tick', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.fail = (name) => name === 'list';
    await r.tick();
    assert.equal(r.fit.size(), 1);
    r.world.fail = null;
    r.world.noServer = true;
    await r.tick();
    assert.equal(r.fit.size(), 0);
    assert.deepEqual(r.files(), []);
  });

  test('(−) a tick does not touch a window whose request is still running (no drop between the tag and the lease)', async () => {
    const r = rig();
    let open;
    const gate = new Promise((res) => { open = res; });
    r.world.block = (name) => (name === 'tag' ? gate : undefined);
    const p = r.put('%2', 220, 60);
    await until(() => r.names().includes('tag'));
    await r.tick(); // the tag is not set yet: the lease must survive
    assert.equal(r.fit.size(), 1);
    r.world.block = null;
    open();
    assert.equal((await p).body.fit.state, 'fitted');
  });

  test('(−) a tick that is still running makes the next one return at once (no pile-up behind a slow tmux)', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    let open;
    const gate = new Promise((res) => { open = res; });
    r.world.block = (name) => (name === 'list' ? gate : undefined);
    const lists = () => r.names().filter((n) => n === 'list').length;
    const first = r.tick();
    const n = lists();
    await r.tick();
    assert.equal(lists(), n, 'the second tick listed nothing');
    r.world.block = null;
    open();
    await first;
    assert.equal(r.fit.size(), 1);
  });
});

describe('releaseAll and recover', () => {
  test('(+) releaseAll restores every window and resolves with the number released', async () => {
    const r = rig();
    const b1 = r.world.snap('@1');
    const b2 = r.world.snap('@2');
    await r.put('%2', 220, 60);
    await r.put('%4', 100, 30);
    assert.equal(await r.fit.releaseAll(), 2);
    assert.deepEqual(r.world.snap('@1'), b1);
    assert.deepEqual(r.world.snap('@2'), b2);
    assert.deepEqual(r.files(), []);
    assert.equal(r.sched.on, false);
  });

  test('(+) releaseAll with nothing leased runs no tmux call', async () => {
    const r = rig();
    assert.equal(await r.fit.releaseAll(), 0);
    assert.deepEqual(r.world.calls, []);
  });

  test('(+) releaseAll resolves within RELEASE_ALL_MS when tmux hangs; the lease file stays for the next start', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    r.world.block = (name) => (name === 'list' ? new Promise(() => {}) : undefined);
    const p = r.fit.releaseAll();
    await until(() => r.sleepers.length > 0);
    assert.equal(r.sleepers[0].ms, RELEASE_ALL_MS);
    assert.equal(RELEASE_ALL_MS, 3000);
    r.sleepers[0].res();
    assert.equal(await p, 0);
    assert.ok(fs.existsSync(r.file(nonce)));
  });

  test('(+) recover releases a valid file left by a crash, in the same order as a release', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    await r.put('%2', 220, 60);
    const again = r.make(); // the new server process
    const at = r.at();
    assert.deepEqual(await again.recover(), { released: 1, dropped: 0 });
    assert.deepEqual(r.names(at), REL_FULL);
    assert.deepEqual(r.world.snap('@1'), before);
    assert.deepEqual(r.files(), []);
    assert.equal(again.size(), 0);
  });

  test('(+) recover drops a file whose window tag differs, without a tmux mutation, and leaves the tag alone', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').tag = 'ffffffffffffffff';
    const again = r.make();
    const at = r.at();
    assert.deepEqual(await again.recover(), { released: 0, dropped: 1 });
    assert.deepEqual(r.names(at), ['list']);
    assert.deepEqual(r.files(), []);
    assert.equal(r.tag(), 'ffffffffffffffff');
  });

  test('(+) recover after the tmux server died (no server): the files are dropped and no mutation is attempted', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.noServer = true;
    const again = r.make();
    assert.deepEqual(await again.recover(), { released: 0, dropped: 1 });
    assert.deepEqual(r.files(), []);
  });

  test('(−) recover with tmux missing keeps the file for the next start and registers nothing', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.enoent = true;
    const again = r.make();
    assert.deepEqual(await again.recover(), { released: 0, dropped: 0 });
    assert.equal(r.files().length, 1);
    assert.equal(again.size(), 0);
  });

  test('(+) recover with no fit folder is a no-op', async () => {
    const r = rig();
    assert.deepEqual(await r.fit.recover(), { released: 0, dropped: 0 });
    assert.deepEqual(r.world.calls, []);
  });

  test('(+) recover is bounded by RELEASE_ALL_MS when tmux hangs', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.block = (name) => (name === 'list' ? new Promise(() => {}) : undefined);
    const again = r.make();
    const p = again.recover();
    await until(() => r.sleepers.length > 0);
    r.sleepers[0].res();
    assert.deepEqual(await p, { released: 0, dropped: 0 });
  });

  test('(−) files that are not valid are unlinked and never applied (path-like window, non-hex nonce, bad ints, extra or missing key, name mismatch, not JSON, too big)', async () => {
    const r = rig();
    const cases = {
      'fit-0000000000000001.json': goodFile({ nonce: '0000000000000001', window: '../x' }),
      'fit-0000000000000002.json': goodFile({ nonce: 'zzzzzzzzzzzzzzzz' }),
      'fit-0000000000000003.json': goodFile({ nonce: '0000000000000003', panes: 0 }),
      'fit-0000000000000004.json': goodFile({ nonce: '0000000000000004', width0: 'ten' }),
      'fit-0000000000000005.json': goodFile({ nonce: '0000000000000005', cols: 5 }),
      'fit-0000000000000006.json': { ...goodFile({ nonce: '0000000000000006' }), extra: 1 },
      'fit-0000000000000007.json': (() => { const f = goodFile({ nonce: '0000000000000007' }); delete f.layout1; return f; })(),
      'fit-0000000000000008.json': goodFile({ nonce: '0000000000000099' }),
      'fit-0000000000000009.json': 'not json {',
      'fit-000000000000000a.json': goodFile({ nonce: '000000000000000a', layout0: 'x#y' }),
      'fit-000000000000000b.json': goodFile({ nonce: '000000000000000b', pane: '%2;ls' }),
      'fit-000000000000000c.json': goodFile({ nonce: '000000000000000c', size0: 'weird' }),
      'fit-000000000000000d.json': goodFile({ nonce: '000000000000000d', resized: 'yes' }),
      'fit-000000000000000e.json': `${JSON.stringify(goodFile({ nonce: '000000000000000e' }))}${' '.repeat(LEASE_FILE_MAX)}`,
      'fit-000000000000000f.json': '[]',
      'fit-0000000000000010.json': '{"__proto__":{"x":1}}',
    };
    for (const [name, content] of Object.entries(cases)) r.plant(name, content);
    const again = r.make();
    const res = await again.recover();
    assert.deepEqual(res, { released: 0, dropped: Object.keys(cases).length });
    assert.deepEqual(r.files(), []);
    assert.deepEqual(r.world.calls, [], 'no tmux call at all');
  });

  test('(−) entries that are not plain files of that exact name are left alone: symlinks, other names, a folder', async () => {
    const r = rig();
    r.plant('notes.txt', 'x');
    r.plant('fit-XYZ.json', 'x');
    r.plant('fit-0123456789abcdef.json.bak', 'x');
    const target = path.join(r.dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify(goodFile()));
    fs.symlinkSync(target, path.join(r.fitDir, 'fit-0000000000000001.json'));
    fs.mkdirSync(path.join(r.fitDir, 'fit-0000000000000002.json'));
    await r.make().recover();
    assert.deepEqual(r.files(), ['fit-0000000000000001.json', 'fit-0000000000000002.json', 'fit-0123456789abcdef.json.bak', 'fit-XYZ.json', 'notes.txt']);
    assert.ok(fs.lstatSync(path.join(r.fitDir, 'fit-0000000000000001.json')).isSymbolicLink());
    assert.ok(fs.existsSync(target), 'the target of a symlink is never touched');
    assert.deepEqual(r.world.calls, []);
  });

  test('(−) a fit folder that is a symlink is not entered', async () => {
    const r = rig();
    const real = path.join(r.dir, 'elsewhere');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.writeFileSync(path.join(real, 'fit-0000000000000001.json'), '{}');
    fs.symlinkSync(real, r.fitDir);
    assert.deepEqual(await r.make().recover(), { released: 0, dropped: 0 });
    assert.ok(fs.existsSync(path.join(real, 'fit-0000000000000001.json')));
  });

  test('(−) a fit folder that is a symlink is not read for a tag either: blocked / foreign-tag', async () => {
    const r = rig((w) => { w.wins.get('@1').tag = '0123456789abcdef'; });
    const real = path.join(r.dir, 'elsewhere');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.writeFileSync(path.join(real, 'fit-0123456789abcdef.json'), JSON.stringify(goodFile()));
    fs.symlinkSync(real, r.fitDir);
    assert.equal((await r.put('%2', 220, 60)).body.fit.reason, 'foreign-tag');
    assert.deepEqual(r.names(), ['list']);
    assert.ok(fs.existsSync(path.join(real, 'fit-0123456789abcdef.json')));
  });

  test('(−) more than LEASE_FILES_MAX files: only 20 are read', async () => {
    const r = rig();
    assert.equal(LEASE_FILES_MAX, 20);
    for (let i = 0; i < 25; i += 1) r.plant(`fit-${String(i).padStart(16, '0')}.json`, '{}');
    const res = await r.make().recover();
    assert.deepEqual(res, { released: 0, dropped: 20 });
    assert.equal(r.files().length, 5);
  });
});

describe('read-back mismatch (a user hook fights nika)', () => {
  test('(−) a hook that undoes the zoom: one release, blocked / changed, no second acquire, off until open:true', async () => {
    const r = rig();
    const before = r.world.snap('@1');
    r.world.after = (name) => { if (name === 'zoom') r.world.wins.get('@1').zoomed = false; };
    const res = await r.put('%2', 220, 60);
    assert.deepEqual(res.body.fit.state, 'blocked');
    assert.equal(res.body.fit.reason, 'changed');
    const n = r.names();
    assert.equal(n.filter((x) => x === 'tag').length, 1);
    assert.equal(n.filter((x) => x === 'zoom').length, 1, 'no unzoom of a zoom that is already gone, no second zoom');
    assert.ok(n.includes('untag'));
    assert.equal(r.fit.size(), 0);
    assert.deepEqual(r.files(), []);
    r.world.after = null;
    const w = r.world.wins.get('@1');
    assert.deepEqual([w.width, w.height, w.tag, w.sizeOpt], [before.width, before.height, '', null]);
    const off = r.at();
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'changed');
    assert.deepEqual(r.names(off), ['list'], 'the heartbeat does not retry');
    assert.equal((await r.put('%2', 220, 60, true)).body.fit.state, 'fitted');
  });

  test('(−) a hook that resizes the window back: the same', async () => {
    const r = rig();
    r.world.after = (name) => { if (name === 'size') r.world.wins.get('@1').width = 199; };
    assert.equal((await r.put('%2', 220, 60)).body.fit.reason, 'changed');
    assert.equal(r.fit.size(), 0);
  });

  test('(−) a pane that vanishes between the request and the read-back: 404 and the lease is released', async () => {
    const r = rig();
    r.world.after = (name) => {
      if (name !== 'size') return;
      const w = r.world.wins.get('@1');
      w.panes = w.panes.filter((p) => p.id !== '%2');
      w.zoomed = false;
      w.active = '%1';
    };
    const res = await r.put('%2', 220, 60);
    assert.equal(res.status, 404);
    assert.equal(r.fit.size(), 0);
    assert.equal(r.tag(), '');
  });
});

describe('Q1/Q2 and the argv guard', () => {
  test('(+) the strict fake rejects every argv outside design section 4', async () => {
    const r = rig();
    for (const a of [
      ['-u', 'resize-pane', '-Z'], ['-u', 'resize-pane', '-Z', '-t', '%2;ls'], ['-u', 'resize-pane', '-Z', '-t', '@1'],
      ['-u', 'select-pane', '-Z', '-t', '%2'], ['-u', 'resize-window', '-t', '@1', '-x', '1e3', '-y', '10'],
      ['-u', 'set-option', '-g', 'window-size', 'manual'], ['-u', 'set-option', '-w', '-t', '@1', '@nika-fit', 'x'],
      ['-u', 'send-keys', '-t', '%2', 'x'], ['-u', 'kill-pane', '-t', '%2'], ['-u', 'select-layout', '-t', '@1', 'x'],
      ['resize-pane', '-Z', '-t', '%2'], ['-u', 'list-panes', '-a'],
    ]) await assert.rejects(() => r.world.exec(TMUX, a), /unexpected tmux argv/);
    await assert.rejects(() => r.world.exec('/bin/sh', ['-u', 'list-panes', '-a', '-F', FMT]));
    assert.equal(r.world.bad.length, 13);
    r.world.bad.length = 0;
  });

  test('(+) a full lifecycle (acquire, renew, other, take-over, tick, release) uses only the section 4 shapes and never a Q1 take-over', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.put('%2', 100, 30, false);
    await r.put('%3', 120, 40, false);
    await r.put('%3', 230, 55);
    await r.tick();
    await r.fit.release('%3');
    await r.put('%4', 100, 30);
    await r.fit.releaseAll();
    assert.deepEqual(r.world.bad, []);
    assert.ok(r.world.calls.every((c) => c.name));
    assert.ok(!r.argv().some((a) => a.includes('-Z') && a[0] === 'select-pane'));
  });
});

// ---- fix round 1 (security review W7-sec) ------------------------------------------------------------------------------------

/** A controller over rig `r` whose pane lock can be held shut: callers wait (`g.waiting`) until `g.open()`, like withPaneLock behind a draft write. */
function gatedFit(r) {
  const g = { p: null, waiting: 0 };
  let open = () => {};
  g.shut = () => { g.waiting = 0; g.p = new Promise((res) => { open = res; }); };
  g.open = () => { g.p = null; open(); };
  const fit = createFit({
    exec: r.world.exec,
    tmuxBin: TMUX,
    now: () => r.clock.t,
    stateDir: r.dir,
    log: (m) => r.logs.push(m),
    lock: async (id, fn) => {
      const shut = g.p;
      if (shut) {
        g.waiting += 1;
        await shut;
      }
      return r.world.lock(id, fn);
    },
    schedule: (fn) => { r.sched.fn = fn; r.sched.on = true; return () => { r.sched.on = false; }; },
    sleep: () => new Promise(() => {}),
  });
  return { fit, g };
}

describe('I1: what decides a zoom toggle is read inside the pane lock, which can wait', () => {
  test('(−) release: the user unzooms while the lock waits; no resize-pane -Z, and the rest of the restore fits the new state', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    const before = r.world.snap('@1');
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    g.shut();
    const at = r.at();
    const done = fit.release('%2');
    await until(() => g.waiting === 1);
    r.world.wins.get('@1').zoomed = false; // C-b z while a draft write holds the lock
    g.open();
    assert.deepEqual(await done, { status: 200, body: { released: true } });
    assert.ok(!r.names(at).includes('zoom'), 'no blind toggle');
    assert.deepEqual(r.names(at), ['list', 'layout', 'size', 'optUnset', 'select', 'focus', 'untag', 'list']);
    assert.deepEqual(r.world.snap('@1'), before);
  });

  test('(−) release: the user zooms another pane while the lock waits; their zoom is left alone, the size comes back', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    g.shut();
    const at = r.at();
    const done = fit.release('%2');
    await until(() => g.waiting === 1);
    r.world.wins.get('@1').active = '%3'; // select-pane -Z -t %3: the zoom moved
    g.open();
    assert.equal((await done).body.released, true);
    assert.deepEqual(r.names(at), ['list', 'layout', 'size', 'optUnset', 'untag', 'list']);
    const w = r.world.wins.get('@1');
    assert.deepEqual([w.zoomed, w.active, w.width, w.tag], [true, '%3', 200, '']);
  });

  test('(−) release: the watch release behind a waiting lock reads the window when it runs, not when it was decided', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    r.clock.t += LAPSE_MS + 1;
    g.shut();
    const at = r.at();
    const tick = r.tick();
    await until(() => g.waiting === 1);
    r.world.wins.get('@1').zoomed = false;
    g.open();
    await tick;
    assert.ok(!r.names(at).includes('zoom'));
    assert.equal(fit.size(), 0);
  });

  test('(+) release without a flip: R0 and R1 and every mutation run inside the lock, R9 after it; the sequence is as before', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const at = r.at();
    await r.fit.release('%2');
    const calls = r.world.calls.slice(at);
    assert.deepEqual(calls.map((c) => c.name), REL_FULL);
    assert.deepEqual(calls.map((c) => c.locked > 0), [true, true, true, true, true, true, true, true, false]);
  });

  const FLIPS = {
    'the user zoomed the active pane (only the zoom differs)': (w) => { w.zoomed = true; },
    'the user moved focus (only the active pane differs)': (w) => { w.active = '%3'; },
    'the user zoomed another pane': (w) => { w.zoomed = true; w.active = '%3'; },
    'a split (only the pane count differs)': (w) => { w.panes.push({ id: '%9', command: 'zsh' }); },
    'the window was resized': (w) => { w.width = 180; },
    'the mirrored pane alone changed size': (w) => { w.panes[1].size = [70, 50]; },
    'a split that leaves the mirrored pane its size (only the count differs)': (w) => { w.panes[1].size = [66, 50]; w.panes.push({ id: '%9', command: 'zsh' }); },
    'the window was resized and the mirrored pane kept its size (only the window differs)': (w) => { w.width = 180; w.panes[1].size = [66, 50]; },
  };
  for (const [what, flip] of Object.entries(FLIPS)) {
    test(`(−) acquire: ${what} while the lock waits: nothing changed, blocked / changed`, async () => {
      const r = rig();
      const { fit, g } = gatedFit(r);
      g.shut();
      const at = r.at();
      const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
      await until(() => g.waiting === 1);
      const w = r.world.wins.get('@1');
      flip(w);
      const flipped = r.world.snap('@1');
      g.open();
      const res = await done;
      assert.equal(res.status, 200);
      assert.equal(res.body.fit.state, 'blocked');
      assert.equal(res.body.fit.reason, 'changed');
      assert.deepEqual(r.names(at), ['list', 'option', 'layout', 'list'], 'only reads: no tag, no zoom, no resize');
      assert.deepEqual(r.world.snap('@1'), flipped);
      assert.equal(fit.size(), 0);
      assert.deepEqual(r.files(), []);
      assert.equal(r.sched.on, false);
      assert.equal(r.tag(), '');
    });
  }

  test('(−) acquire: the pane vanishes while the lock waits: 404, nothing changed', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    g.shut();
    const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
    await until(() => g.waiting === 1);
    const w = r.world.wins.get('@1');
    w.panes = w.panes.filter((p) => p.id !== '%2');
    g.open();
    assert.deepEqual(await done, NF);
    assert.equal(fit.size(), 0);
    assert.deepEqual(r.files(), []);
    assert.equal(r.tag(), '');
  });

  test('(−) acquire: the pane moves to another window while the lock waits: 404, nothing changed', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    g.shut();
    const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
    await until(() => g.waiting === 1);
    const [from, to] = [r.world.wins.get('@1'), r.world.wins.get('@2')];
    to.panes.push(from.panes.splice(1, 1)[0]); // join-pane / break-pane: %2 now sits in @2
    const moved = [r.world.snap('@1'), r.world.snap('@2')];
    g.open();
    assert.deepEqual(await done, NF);
    assert.deepEqual([r.world.snap('@1'), r.world.snap('@2')], moved);
    assert.equal(fit.size(), 0);
    assert.deepEqual(r.files(), []);
  });

  test('(−) acquire: a foreign tag appears while the lock waits: blocked / changed, the tag is not overwritten', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    g.shut();
    const at = r.at();
    const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
    await until(() => g.waiting === 1);
    r.world.wins.get('@1').tag = 'abcdef0123456789'; // another nika (or a user) fitted the window meanwhile
    g.open();
    const res = await done;
    assert.equal(res.body.fit.reason, 'changed');
    assert.deepEqual(r.names(at), ['list', 'option', 'layout', 'list']);
    assert.equal(r.tag(), 'abcdef0123456789');
    assert.equal(fit.size(), 0);
    assert.deepEqual(r.files(), []);
  });

  test('(−) acquire: the refusal is not a user-change mark; the next heartbeat looks at the window as it is then', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    g.shut();
    const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
    await until(() => g.waiting === 1);
    r.world.wins.get('@1').zoomed = true;
    r.world.wins.get('@1').active = '%3';
    g.open();
    assert.equal((await done).body.fit.reason, 'changed');
    assert.equal((await fit.hold('%2', { cols: 220, rows: 60, open: false })).body.fit.reason, 'user-zoom', 'the plain rule for what is there now');
    r.world.wins.get('@1').zoomed = false;
    assert.equal((await fit.hold('%2', { cols: 220, rows: 60, open: false })).body.fit.state, 'fitted');
  });

  test('(+) acquire without a flip: one extra list-panes, layout and window-size read, inside the same single lock, before the tag', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const calls = r.world.calls;
    assert.deepEqual(calls.map((c) => c.name), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout']);
    assert.deepEqual(calls.map((c) => c.locked > 0), [false, false, false, true, true, true, true, true, true, false, false]);
    assert.deepEqual(r.world.lockIds, ['%2']);
  });
});

describe('M1: a heartbeat that arrives after the page closed does not fit the window again', () => {
  test('(−) a late PUT open:false within 2 s of the DELETE: blocked / user-change, no tmux mutation, no lease', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    assert.equal((await r.fit.release('%2')).body.released, true);
    const before = r.world.snap('@1');
    r.clock.t += 500;
    const at = r.at();
    assert.deepEqual(await r.put('%2', 220, 60, false), ans('blocked', 'user-change', 66, 50, 3));
    assert.deepEqual(r.names(at), ['list']);
    assert.equal(r.fit.size(), 0);
    assert.deepEqual(r.world.snap('@1'), before);
    r.clock.t += 1500; // exactly 2 s after the DELETE: still within
    assert.equal((await r.put('%2', 230, 60, false)).body.fit.reason, 'user-change');
  });

  test('(+) open:true within 2 s is the page opening again: it fits, and the note is gone', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.fit.release('%2');
    r.clock.t += 500;
    assert.deepEqual(await r.put('%2', 220, 60, true), ans('fitted', null, 220, 60, 3));
    // the note stays cleared: a release that is not the page's (spawn) is followed by a heartbeat that fits
    assert.equal(await r.fit.releaseWindow('@1'), true);
    r.clock.t += 500;
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted');
  });

  test('(+) open:false after 2 s fits as it always did', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.fit.release('%2');
    r.clock.t += 2001;
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted');
  });

  test('(+) the note belongs to the window and to the page\'s DELETE: another window, a lapse, a spawn release and an empty DELETE leave open:false alone', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    await r.put('%4', 100, 30);
    await r.fit.release('%2');
    assert.equal((await r.put('%4', 100, 30, false)).body.fit.state, 'fitted', 'another window');
    assert.equal(await r.fit.releaseWindow('@2'), true);
    assert.equal((await r.put('%4', 100, 30, false)).body.fit.state, 'fitted', 'a release that is not the page\'s');
    r.clock.t += 5000;
    assert.deepEqual(await r.fit.release('%3'), { status: 200, body: { released: false } });
    assert.equal((await r.put('%3', 220, 60, false)).body.fit.state, 'fitted', 'a DELETE without a lease notes nothing');
  });

  test('(−) a DELETE that could not restore (tmux down) notes nothing and keeps the lease', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.fail = (name) => name === 'list';
    assert.equal((await r.fit.release('%2')).status, 502);
    r.world.fail = null;
    assert.equal(r.fit.size(), 1);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted', 'the held lease answers a heartbeat');
  });

  test('(−) the failed DELETE leaves no note: once the window is given back another way, open:false fits', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.fail = (name) => name === 'list';
    assert.equal((await r.fit.release('%2')).status, 502);
    r.world.fail = null;
    r.clock.t += 500;
    assert.equal(await r.fit.releaseWindow('@1'), true);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted');
  });
});

describe('M3: recover says when it leaves files unread', () => {
  test('(−) more than LEASE_FILES_MAX matching files: one log line with the counts and no names', async () => {
    const r = rig();
    for (let i = 0; i < 25; i += 1) r.plant(`fit-${String(i).padStart(16, '0')}.json`, '{}');
    await r.make().recover();
    assert.deepEqual(r.logs, ['nika: fit recover read 20 of 25 lease files']);
  });

  test('(+) up to LEASE_FILES_MAX files: no line', async () => {
    const r = rig();
    for (let i = 0; i < 20; i += 1) r.plant(`fit-${String(i).padStart(16, '0')}.json`, '{}');
    await r.make().recover();
    assert.deepEqual(r.logs, []);
  });
});

describe('M4: a lease that is dropped at R0 sets no mark', () => {
  test('(−) the window was reused (tag gone) between the decision to release and R0: the next open:false is not blocked', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').zoomed = false; // the renew below sees a user change ...
    let lists = 0;
    r.world.after = (name) => { // ... and the window is a new one by the time R0 looks (tmux restarted, id reused)
      if (name === 'list') { lists += 1; if (lists === 1) r.world.wins.get('@1').tag = ''; }
    };
    const at = r.at();
    const res = await r.put('%2', 240, 70, false);
    assert.equal(res.body.fit.reason, 'user-change', 'this request still says so');
    assert.deepEqual(r.names(at), ['list', 'list', 'list'], 'R0 found the tag gone and touched nothing; the last list builds the answer');
    assert.equal(r.fit.size(), 0);
    assert.deepEqual(r.files(), []);
    r.world.after = null;
    assert.equal((await r.put('%2', 240, 70, false)).body.fit.state, 'fitted', 'no mark: the next heartbeat fits');
  });

  test('(+) a release that does restore still sets the mark', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.wins.get('@1').zoomed = false;
    await r.tick();
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });
});

describe('fix round 2: acquire re-reads what a restore will put back', () => {
  const FLIPS2 = {
    'the user resized other panes (only the layout differs)': [(w) => { w.arr = 'tiled'; }, ['list', 'option', 'layout', 'list', 'layout']],
    'the layout turned into one nika cannot keep': [(w) => { w.pinned = 'x#y'; }, ['list', 'option', 'layout', 'list', 'layout']],
    'the user set window-size (only the option differs)': [(w) => { w.sizeOpt = 'largest'; }, ['list', 'option', 'layout', 'list', 'layout', 'option']],
    'the user set a window-size nika cannot restore': [(w) => { w.sizeOpt = 'weird'; }, ['list', 'option', 'layout', 'list', 'layout', 'option']],
  };
  for (const [what, [flip, want]] of Object.entries(FLIPS2)) {
    test(`(−) ${what} while the lock waits: nothing changed, blocked / changed`, async () => {
      const r = rig();
      const { fit, g } = gatedFit(r);
      g.shut();
      const at = r.at();
      const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
      await until(() => g.waiting === 1);
      flip(r.world.wins.get('@1'));
      const flipped = r.world.snap('@1');
      g.open();
      const res = await done;
      assert.equal(res.body.fit.state, 'blocked');
      assert.equal(res.body.fit.reason, 'changed');
      assert.deepEqual(r.names(at), want, 'only reads: no tag, no zoom, no resize');
      assert.deepEqual(r.world.snap('@1'), flipped);
      assert.equal(fit.size(), 0);
      assert.deepEqual(r.files(), []);
      assert.equal(r.sched.on, false);
      assert.equal(r.tag(), '');
    });
  }

  test('(+) a difference that is only focus history (markers a / l of the layout, as R1 and R5 strip them) is no change: it fits', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    g.shut();
    const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
    await until(() => g.waiting === 1);
    r.world.wins.get('@1').last = '%3'; // focus went to %3 and came back to %2: the same active pane, another "last"
    g.open();
    assert.deepEqual(await done, ans('fitted', null, 220, 60, 3));
    assert.equal(fit.size(), 1);
  });

  test('(−) the refusal leaves no mark: once the window is as it is, the next heartbeat fits and a later release restores it', async () => {
    const r = rig();
    const { fit, g } = gatedFit(r);
    g.shut();
    const done = fit.hold('%2', { cols: 220, rows: 60, open: true });
    await until(() => g.waiting === 1);
    r.world.wins.get('@1').arr = 'tiled';
    g.open();
    assert.equal((await done).body.fit.reason, 'changed');
    const kept = r.world.snap('@1');
    assert.equal((await fit.hold('%2', { cols: 220, rows: 60, open: false })).body.fit.state, 'fitted');
    assert.equal((await fit.release('%2')).body.released, true);
    assert.deepEqual(r.world.snap('@1'), kept, "the user's layout change survives: L0 is the layout read after it");
  });
});

describe('fix round 2: EPANEBUSY from verify through releaseNow after the renew resize ran (the "kept" fields)', () => {
  // The resize ran, then the read-back asks for a release and the pane is busy: releaseNow puts the lease back and renew's catch
  // restores the fields of the previous size. Pinned: that is bookkeeping. The window stays resized, the lease and its (older) file
  // stay, the answer is 409 busy, and the next watch tick releases through the full guarded restore (fresh reads under the lock).
  const CASES = {
    'a hook fought back (the zoom is gone)': [(w) => { w.zoomed = false; }, 0],
    'the layout became one nika cannot keep': [(w) => { w.pinned = 'x#y'; }, 1], // nika's own zoom is still there: R2 takes it off, once
  };
  for (const [what, [hook, zooms]] of Object.entries(CASES)) {
    test(`(−) ${what}: 409 busy, lease and file stay, the next tick restores through R0-R8 and toggles the zoom only when nika's own zoom is still there`, async () => {
      const r = rig();
      const { fit, gate } = busyRig(r);
      const before = r.world.snap('@1');
      await fit.hold('%2', { cols: 220, rows: 60, open: true });
      const nonce = r.tag();
      const file = fs.readFileSync(r.file(nonce), 'utf8');
      r.world.after = (name) => { if (name === 'size') { hook(r.world.wins.get('@1')); gate.busy = true; } };
      assert.deepEqual(await fit.hold('%2', { cols: 240, rows: 70, open: false }), BUSY);
      r.world.after = null;
      assert.equal(fit.size(), 1, 'the lease is registered again');
      assert.equal(r.sched.on, true, 'so the watch keeps looking');
      assert.equal(fs.readFileSync(r.file(nonce), 'utf8'), file, 'the file still holds the older description (crash recovery stays conservative)');
      assert.equal(r.tag(), nonce);
      assert.deepEqual([r.world.wins.get('@1').width, r.world.wins.get('@1').height], [240, 70], 'the resize did happen');
      const stuck = r.at();
      await r.tick(); // still busy: nothing runs, nothing is lost
      assert.equal(fit.size(), 1);
      assert.ok(!r.names(stuck).some((n) => MUTATING.has(n)));
      gate.busy = false;
      const at = r.at();
      await r.tick();
      assert.equal(fit.size(), 0, 'released');
      assert.equal(r.names(at).filter((n) => n === 'zoom').length, zooms, 'a zoom nika made is taken off once (R2, fresh reads); a zoom that is gone is not toggled back');
      assert.equal(r.world.wins.get('@1').zoomed, false);
      assert.equal(r.tag(), '');
      assert.deepEqual([r.world.wins.get('@1').width, r.world.wins.get('@1').height], [before.width, before.height]);
      assert.equal(r.world.wins.get('@1').sizeOpt, null);
      assert.deepEqual(r.files(), []);
      assert.equal((await fit.hold('%2', { cols: 220, rows: 60, open: false })).body.fit.state, 'blocked', 'off until the page opens the session window again');
    });
  }
});

describe('fix round 3: a blocked / changed or user-change answer describes the window after the release (T5 finding F2)', () => {
  const once = (name, fn) => { let armed = true; return (n) => { if (n === name && armed) { armed = false; fn(); } }; };
  const win = (r) => r.world.wins.get('@1');
  const userZoomed = (w) => { const x = w.wins.get('@1'); x.zoomed = true; x.active = '%2'; };

  test('(−) acquire, a hook fights the resize: the answer has the restored pane size, not the fitted one, and userZoom false', async () => {
    const r = rig();
    r.world.after = once('size', () => { win(r).width = 199; });
    const res = await r.put('%2', 220, 60);
    assert.deepEqual(res, ans('blocked', 'changed', 66, 50, 3, false));
    assert.deepEqual(r.names().slice(-3), ['untag', 'list', 'list'], 'R9, then the listing the answer is built from');
    assert.equal(r.tag(), '');
  });

  test('(−) renew, the read-back mismatches after the resize: the same', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    r.world.after = once('size', () => { win(r).zoomed = false; });
    assert.deepEqual(await r.put('%2', 240, 70, false), ans('blocked', 'changed', 66, 50, 3, false));
    assert.equal(r.fit.size(), 0);
  });

  test('(−) renew, the user changed the window (nika\'s zoom is still on): user-change with the restored pane and userZoom false', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    win(r).width = 150; // the user resized the window; the zoom on the mirrored pane is still nika\'s
    assert.deepEqual(await r.put('%2', 240, 70, false), ans('blocked', 'user-change', 66, 50, 3, false));
    assert.equal(r.fit.size(), 0);
    assert.equal(win(r).zoomed, false);
  });

  test('(+) the user had the mirrored pane zoomed: the answer after the release still says userZoom true, with the restored size', async () => {
    const r = rig(userZoomed);
    r.world.after = once('size', () => { win(r).width = 199; });
    assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'changed', 200, 50, 3, true));
    assert.equal(win(r).zoomed, true, 'their zoom is left as it was');
  });

  test('(−) the user\'s zoom is gone when the window is looked at after the release: userZoom false', async () => {
    const r = rig(userZoomed);
    const hook = once('size', () => { win(r).width = 199; });
    r.world.after = (name) => { hook(name); if (name === 'untag') win(r).zoomed = false; }; // C-b z right after the restore
    assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'changed', 66, 50, 3, false));
  });

  test('(−) nika\'s zoom that the release could not take off is still not the user\'s: userZoom false', async () => {
    const r = rig((w) => { w.wins.get('@1').active = '%2'; }); // focus was on %2 already: R6 does not move it, so the window stays zoomed
    let zooms = 0;
    r.world.fail = (name) => name === 'zoom' && (zooms += 1) > 1; // A3 works, R2 does not
    r.world.after = once('size', () => { win(r).width = 199; });
    assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'changed', 200, 50, 3, false));
    assert.equal(win(r).zoomed, true);
    assert.ok(r.logs.some((l) => /R2 failed/.test(l)));
  });

  test('(+) the answer is the window as it is after the release, whatever happened right after it (a split)', async () => {
    const r = rig();
    r.world.after = (name) => {
      if (name === 'size' && win(r).width !== 199 && win(r).width !== 200) win(r).width = 199;
      if (name === 'untag') win(r).panes.push({ id: '%9', command: 'zsh' });
    };
    assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'changed', 50, 50, 4, false));
  });

  describe('when the listing after the release fails, the state nika restored to (the pre-fit snapshot) is used', () => {
    const failAfterUntag = (r, extra) => {
      let ended = false;
      r.world.fail = (name) => ended && name === 'list';
      r.world.after = (name) => { extra?.(name); if (name === 'untag') ended = true; };
    };

    test('(−) acquire: pre-fit pane size, the count the lease holds, userZoom false; one log line without ids of the answer', async () => {
      const r = rig();
      const hook = once('size', () => { win(r).width = 199; });
      failAfterUntag(r, (name) => { hook(name); if (name === 'untag') win(r).panes.push({ id: '%9', command: 'zsh' }); }); // the pane count would show 4 if it were read
      assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'changed', 66, 50, 3, false));
      assert.equal(r.logs.filter((l) => /^nika: fit @1 %2 answer failed \(\w+\)$/.test(l)).length, 1);
    });

    test('(−) acquire, the user had the pane zoomed: userZoom true from the lease, pre-fit size 200x50', async () => {
      const r = rig(userZoomed);
      failAfterUntag(r, once('size', () => { win(r).width = 199; }));
      assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'changed', 200, 50, 3, true));
    });

    test('(−) renew: the pre-fit size, not the size the last read-back saw', async () => {
      const r = rig();
      await r.put('%2', 220, 60); // the last read-back saw 220x60
      failAfterUntag(r, once('size', () => { win(r).zoomed = false; }));
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('blocked', 'changed', 66, 50, 3, false));
    });

    test('(−) the pane is no longer in the window after the release: the snapshot values, not another window\'s row', async () => {
      const r = rig();
      const hook = once('size', () => { win(r).width = 199; });
      r.world.after = (name) => {
        hook(name);
        if (name !== 'untag') return;
        const [from, to] = [win(r), r.world.wins.get('@2')];
        to.panes.push(from.panes.splice(1, 1)[0]);
      };
      assert.deepEqual(await r.put('%2', 220, 60), ans('blocked', 'changed', 66, 50, 3, false));
    });
  });
});

describe('fix round 4 (N1): a renew resizes only a window that is still as nika holds it, judged inside the pane lock', () => {
  const win = (r) => r.world.wins.get('@1');
  /** A fitted window (220x60) held by a gated controller; the next request asks for 240x70 and waits in the lock while `flip` runs. */
  async function renewDuringWait(flip, open = false) {
    const r = rig();
    const { fit, g } = gatedFit(r);
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    g.shut();
    const at = r.at();
    const done = fit.hold('%2', { cols: 240, rows: 70, open });
    await until(() => g.waiting === 1);
    flip(win(r));
    g.open();
    return { r, fit, res: await done, at };
  }
  const resizes = (r, at) => r.argv(at).filter((a) => a[0] === 'resize-window').map((a) => a.slice(3).join(' '));

  const FLIPS = {
    'the user resized the window': (w) => { w.width = 150; },
    'the user unzoomed': (w) => { w.zoomed = false; },
    'the user moved focus': (w) => { w.active = '%3'; },
    'a split': (w) => { w.panes.push({ id: '%9', command: 'zsh' }); },
  };
  for (const [what, flip] of Object.entries(FLIPS)) {
    test(`(−) ${what} during the lock wait: no resize-window to the new panel size, a release, blocked / user-change`, async () => {
      const { r, fit, res, at } = await renewDuringWait(flip);
      assert.equal(res.status, 200);
      assert.equal(res.body.fit.state, 'blocked');
      assert.equal(res.body.fit.reason, 'user-change');
      assert.ok(!resizes(r, at).includes('-x 240 -y 70'), JSON.stringify(resizes(r, at)));
      assert.ok(!r.names(at).includes('tag'), 'never a second acquire');
      assert.equal(fit.size(), 0);
      assert.equal(r.tag(), '');
      assert.deepEqual(r.files(), []);
      assert.equal(r.sched.on, false);
      assert.equal((await fit.hold('%2', { cols: 240, rows: 70, open: false })).body.fit.reason, 'user-change', 'off until the page opens the session window again');
    });
  }

  test('(−) the user resized the window: the only resize-window is the restore to the original size, and the answer is the restored pane', async () => {
    const { r, res, at } = await renewDuringWait(FLIPS['the user resized the window']);
    assert.deepEqual(resizes(r, at), ['-x 200 -y 50']);
    assert.deepEqual(res, ans('blocked', 'user-change', 66, 50, 3, false));
    assert.equal(win(r).zoomed, false);
  });

  test('(−) the tag is gone (the window was reused) during the wait: nothing is touched, no mark, the lease is dropped', async () => {
    const { r, fit, res, at } = await renewDuringWait((w) => { w.tag = ''; });
    assert.equal(res.body.fit.reason, 'user-change');
    assert.ok(!r.names(at).some((n) => MUTATING.has(n)), 'no mutation');
    assert.equal(fit.size(), 0);
    assert.deepEqual(r.files(), []);
    assert.equal((await fit.hold('%2', { cols: 240, rows: 70, open: false })).body.fit.state, 'fitted', 'no mark: the next heartbeat fits');
  });

  test('(−) the release that follows a user change finds the pane busy: 409, the lease is as it was, the tick restores', async () => {
    const r = rig();
    const { fit, gate } = busyRig(r);
    await fit.hold('%2', { cols: 220, rows: 60, open: true });
    const nonce = r.tag();
    const file = fs.readFileSync(r.file(nonce), 'utf8');
    let lists = 0;
    r.world.after = (name) => { // the first list is the one the decision rests on; the user resizes after it, and the lock is granted for the second (the re-list) and busy for the release
      if (name !== 'list') return;
      lists += 1;
      if (lists === 1) win(r).width = 150;
      if (lists === 2) gate.busy = true;
    };
    assert.deepEqual(await fit.hold('%2', { cols: 240, rows: 70, open: false }), BUSY);
    assert.equal(fit.size(), 1, 'the lease is registered again');
    assert.equal(fs.readFileSync(r.file(nonce), 'utf8'), file);
    assert.equal(gate.refused, 1);
    assert.ok(!r.names().includes('size') || r.names().filter((n) => n === 'size').length === 1, 'the renew resize never ran (only nika\'s first fit resized)');
    gate.busy = false;
    await r.tick();
    assert.equal(fit.size(), 0);
    assert.equal(r.tag(), '');
    assert.deepEqual([win(r).width, win(r).height], [200, 50]);
  });

  test('(+) no change during the wait: the renew is one list, one list inside the lock, the resize, then the read-back; only the middle two are locked', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const at = r.at();
    assert.deepEqual(await r.put('%2', 240, 70, false), ans('fitted', null, 240, 70, 3));
    const calls = r.world.calls.slice(at);
    assert.deepEqual(calls.map((c) => c.name), ['list', 'list', 'size', 'list', 'layout']);
    assert.deepEqual(calls.map((c) => c.locked > 0), [false, true, true, false, false]);
  });

  test('(+) no change during a real wait: the resize happens and the lease continues at the new size', async () => {
    const { r, fit, res, at } = await renewDuringWait(() => {});
    assert.deepEqual(res, ans('fitted', null, 240, 70, 3));
    assert.deepEqual(resizes(r, at), ['-x 240 -y 70']);
    assert.equal(fit.size(), 1);
  });

  test('(+) a heartbeat at the held size reads nothing more: still answered from memory', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const at = r.at();
    assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 3));
    assert.equal(r.at(), at);
  });
});
