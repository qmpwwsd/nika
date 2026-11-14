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
  const paneSize = (w, p) => (w.panes.length === 1 || (w.zoomed && p.id === w.active) ? [w.width, w.height] : [Math.floor(w.width / w.panes.length), w.height]);
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
    world.calls.push({ name, argv: a });
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
      assert.deepEqual(r.names(), ['list', 'option', 'layout', 'tag', ...want, 'list', 'layout']);
      assert.ok(!r.names().includes('zoom'));
      assert.deepEqual([r.world.wins.get('@2').width, r.world.wins.get('@2').height], [cols, rows]);
    }
  });

  test('(+) the user had the mirrored pane zoomed: nika neither zooms nor unzooms, and says userZoom', async () => {
    const r = rig((w) => { const x = w.wins.get('@1'); x.zoomed = true; x.active = '%2'; });
    const res = await r.put('%2', 220, 60);
    assert.deepEqual(res, ans('fitted', null, 220, 60, 3, true));
    assert.deepEqual(r.names(), ['list', 'option', 'layout', 'tag', 'size', 'list', 'layout']);
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
    assert.deepEqual(r.names(), ['list', 'option', 'layout', 'tag', 'zoom', 'list', 'layout']);
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
    assert.deepEqual(r.argv(at)[1], ['resize-window', '-t', '@1', '-x', '200', '-y', '50']);
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
    assert.deepEqual(r.names(at), ['list', 'list', 'layout', 'size', 'optUnset', 'select', 'focus', 'untag', 'list']);
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
    assert.deepEqual(r.names(at), ['list', ...REL_FULL, 'list', 'option', 'layout', 'tag', 'zoom', 'size', 'list', 'layout']);
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
    assert.deepEqual(r.names(at).slice(0, 4), ['list', 'option', 'layout', 'tag']);
    assert.ok(!r.files().includes(`fit-${old}.json`));
  });
});

describe('release', () => {
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
