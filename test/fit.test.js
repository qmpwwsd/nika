// W7 fit controller (design-W7 §12.1): a scripted in-memory tmux (windows, panes, zoom, sizes, the window-size option, layouts
// with the 3.8 active/last markers, the `@nika-fit` tag) answers only the argv shapes of design §4; any other argv, or a
// mutation outside the pane lock, is recorded in `bad` and fails the test that made it. Synthetic data only.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFit, checkFitBody, LAPSE_MS, WATCH_MS, GROW_MS, RELEASE_ALL_MS, LEASE_FILE_MAX, LEASE_FILES_MAX } from '../src/fit.js';
import { FIT_NONCE, WINDOW_ID } from '../src/ids.js';
import { createSessionControl } from '../src/session-control.js';

const TMUX = '/opt/x/tmux';
// spelled out here on purpose: a change of the format in src/fit.js must fail this file
const FMT = ['#{pane_id}', '#{window_id}', '#{window_panes}', '#{window_zoomed_flag}', '#{pane_active}', '#{window_width}', '#{window_height}', '#{pane_width}', '#{pane_height}', '#{pane_current_command}', '#{@nika-fit}', '#{@nika-role}', '#{window_active_clients}'].join('\t');
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
  // `border`: rows tmux takes from every pane for `pane-border-status top|bottom` (0 = off). tmux 3.8 reserves them on a zoomed pane and
  // on the only pane of a window too (layout_fix_panes has no check on either), so a pane that fills a window of height H is H-border tall.
  // F15: `drift` = a resize-window of a window with several panes changes the arrangement (tmux's layout after a squeeze does not come back with the size;
  // only select-layout puts it back); `minSize` = [cols, rows] the smallest size tmux can give a window (a window it cannot shrink that far keeps the minimum)
  const world = { wins, calls: [], bad: [], locked: 0, lockIds: [], fail: null, block: null, after: null, junk: [], noServer: false, enoent: false, border: 0, drift: false, minSize: null };
  const num = (id) => Number(id.slice(1));
  const paneSize = (w, p) => p.size ?? (w.panes.length === 1 || (w.zoomed && p.id === w.active) ? [w.width, w.height - world.border] : [Math.floor(w.width / w.panes.length), w.height - world.border]);
  const layoutOf = (w) => w.pinned ?? `{"w":${w.width},"h":${w.height},"s":"${w.arr}","p":[${w.panes.map((p) => `{"i":${num(p.id)}${p.id === w.active ? ',"a":true' : ''}${p.id === w.last ? `,"l":${num(p.id)}` : ''}}`).join(',')}]}`;
  const winOf = (pane) => [...wins.values()].find((w) => w.panes.some((p) => p.id === pane));
  const setActive = (w, id) => { if (w.active !== id) { w.last = w.active; w.active = id; } };
  const win = (id) => { const w = wins.get(id); if (!w) throw tmuxErr(`can't find window: ${id}`); return w; };

  // F4: `clients` is the window's `#{window_active_clients}`, `client` the size of the terminal that shows it (null: unknown)
  world.add = (id, panes, width, height) => {
    wins.set(id, { id, panes: panes.map(([pid, command, role]) => ({ id: pid, command, role })), active: panes[0][0], last: null, zoomed: false, width, height, sizeOpt: null, tag: '', arr: 'even', pinned: undefined, clients: 0, client: null });
  };
  /** A window that is not `manual` follows the terminal that shows it (spike S16 Q4); a `manual` one keeps its size. */
  const follow = (w) => { if (w.sizeOpt !== 'manual' && w.clients > 0 && w.client) [w.width, w.height] = w.client; };
  /** `n` terminals show the window (0: none), the first of them `size` = [cols, rows]. A terminal that resizes is `view(id, 1, newSize)`. */
  world.view = (id, n, size) => {
    const w = win(id);
    w.clients = n;
    if (size) w.client = size;
    follow(w);
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
          for (const p of w.panes) lines.push([p.id, w.id, w.panes.length, w.zoomed ? 1 : 0, p.id === w.active ? 1 : 0, w.width, w.height, ...paneSize(w, p), p.command, w.tag, p.role ?? '', p.clientsRaw ?? w.clients].join('\t'));
        }
        return `${[...lines, ...world.junk].join('\n')}\n`;
      }
      case 'layout': return `${layoutOf(win(a[3]))}\n`;
      case 'option': { const w = win(a[3]); return w.sizeOpt ? `window-size ${w.sizeOpt}\n` : ''; }
      case 'tag': win(a[3]).tag = a[5]; return '';
      case 'untag': win(a[3]).tag = ''; return '';
      case 'optUnset': win(a[3]).sizeOpt = null; follow(win(a[3])); return '';
      case 'optSet': win(a[3]).sizeOpt = a[5]; follow(win(a[3])); return '';
      case 'size': {
        const w = win(a[2]);
        w.width = Math.max(Number(a[4]), world.minSize?.[0] ?? 0);
        w.height = Math.max(Number(a[6]), world.minSize?.[1] ?? 0);
        w.sizeOpt = 'manual';
        if (world.drift && w.panes.length > 1) w.arr = `drift${w.width}x${w.height}`;
        return '';
      }
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
        // a window that follows a terminal keeps the terminal's size: tmux refits the layout to it (spike S16 Q4)
        if (!(w.sizeOpt !== 'manual' && w.clients > 0 && w.client)) { w.width = L.w; w.height = L.h; }
        w.arr = L.s; w.zoomed = false;
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
    /** F9: the page's request with its `focus` (`put` sends no focus key, which the controller reads as false). */
    putf: (id, cols, rows, focus, open = true, fit = r.fit) => fit.hold(id, { cols, rows, open, focus }),
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

const BODY_MSG = 'cols must be an integer 40–400, rows 10–200, open a boolean, focus a boolean when present';

describe('checkFitBody', () => {
  // F9 (requirement changed): the value always carries the boolean `focus`; a body without it reads as focus false
  test('(+) cols, rows and open, and focus when present; the bounds are inclusive; no focus key reads as false', () => {
    assert.deepEqual(checkFitBody({ cols: 40, rows: 10, open: true }), { value: { cols: 40, rows: 10, open: true, focus: false } });
    assert.deepEqual(checkFitBody({ cols: 400, rows: 200, open: false }), { value: { cols: 400, rows: 200, open: false, focus: false } });
  });

  test('(+) F9: focus true and focus false are carried', () => {
    assert.deepEqual(checkFitBody({ cols: 120, rows: 40, open: true, focus: true }), { value: { cols: 120, rows: 40, open: true, focus: true } });
    assert.deepEqual(checkFitBody({ cols: 120, rows: 40, open: false, focus: false }), { value: { cols: 120, rows: 40, open: false, focus: false } });
  });

  test('(−) other shapes are refused with the contract message', () => {
    for (const bad of [
      null, 'x', [], {}, { cols: 120, rows: 40 }, { cols: 120, rows: 40, open: 'true' }, { cols: 120.5, rows: 40, open: true },
      { cols: '120', rows: 40, open: true }, { cols: 39, rows: 40, open: true }, { cols: 401, rows: 40, open: true },
      { cols: 120, rows: 9, open: true }, { cols: 120, rows: 201, open: true }, { cols: NaN, rows: 40, open: true },
      { cols: 120, rows: 40, open: true, extra: 1 },
    ]) assert.deepEqual(checkFitBody(bad), { error: BODY_MSG }, JSON.stringify(bad));
  });

  test('(−) F9: a focus that is not a boolean, four keys without focus, and five keys are refused with the new message', () => {
    const base = { cols: 120, rows: 40, open: true };
    for (const focus of ['true', 'false', 'yes', 1, 0, null, undefined, [], {}, NaN]) {
      assert.deepEqual(checkFitBody({ ...base, focus }), { error: BODY_MSG }, String(focus));
    }
    assert.deepEqual(checkFitBody({ ...base, extra: 1 }), { error: BODY_MSG }, 'four keys, none of them focus');
    assert.deepEqual(checkFitBody({ ...base, focus: true, extra: 1 }), { error: BODY_MSG }, 'five keys');
    assert.deepEqual(checkFitBody({ ...base, focusX: true }), { error: BODY_MSG }, 'a key that only looks like focus');
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
    // 13 fields each (the tag and the role empty, the count 0), so every row fails on its own value: a bad pane id, a short row, zero panes, a zoom flag of 2
    const r = rig((w) => { w.junk = ['%x\t@1\t1\t0\t1\t1\t1\t1\t1\tclaude\t\t\t0', '%9\t@1\t1', '%8\t@1\t0\t0\t1\t80\t24\t80\t24\tclaude\t\t\t0', '%7\t@1\t1\t2\t1\t80\t24\t80\t24\tclaude\t\t\t0', '', 'junk'].map((l) => l); });
    assert.deepEqual(await r.put('%2', 220, 60), ans('fitted', null, 220, 60, 3));
  });

  // F4 narrowed this test (design-F4 §2.1): the listing has 13 fields now, so the rows of the 11- and 12-field formats and a 14-field row are the ones that drop
  test('(−) a row of the old 11- or 12-field format or with a 14th field is dropped, even when every value is good (F4: exactly 13 fields)', async () => {
    const r = rig((w) => { w.junk = ['%7\t@1\t1\t0\t1\t80\t24\t80\t24\tclaude\t', '%8\t@1\t1\t0\t1\t80\t24\t80\t24\tclaude\t\t', '%9\t@1\t1\t0\t1\t80\t24\t80\t24\tclaude\t\t\t0\t']; });
    assert.deepEqual(await r.put('%2', 220, 60), ans('fitted', null, 220, 60, 3));
    assert.equal((await r.put('%7', 220, 60)).status, 404, 'a pane that only an 11-field row names is not listed');
    assert.equal((await r.put('%8', 220, 60)).status, 404, 'nor one that only a 12-field row names');
    assert.equal((await r.put('%9', 220, 60)).status, 404, 'nor one that only a 14-field row names');
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

  // F2 narrowed this test (design-F12 §3.3): a new pane with no nika role (a user's split) is given one watch tick for nika's spawn to tag it
  // before it counts as a user change, so the first tick waits and the second, WATCH_MS later, releases. A kill of a pane that was not
  // nika's agent is a user change at once.
  test('(−) a split or a kill (pane count changed), alone or with the unzoom tmux does: released and kept off', async () => {
    for (const how of ['split', 'split+unzoom', 'kill+unzoom']) {
      const r = rig();
      await r.put('%2', 220, 60);
      const w = r.world.wins.get('@1');
      if (how === 'kill+unzoom') w.panes = w.panes.filter((p) => p.id !== '%3');
      else w.panes.push({ id: '%9', command: 'zsh' });
      if (how !== 'split') w.zoomed = false;
      if (how !== 'kill+unzoom') {
        await r.tick();
        assert.equal(r.fit.size(), 1, `${how}: the untagged new pane gets one tick of grace`);
        r.clock.t += WATCH_MS;
      }
      await r.tick();
      assert.equal(r.fit.size(), 0, how);
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change', how);
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

// Owner's tmux has `pane-border-status top`: tmux reserves one row for the border line on every pane, a zoomed pane and the only pane
// of a window included, so a pane that fills a window of height H reads back H-1 tall (owner screenshot 2026-11-15: window 171x46,
// panes 41x45, 64x45, 64x45). The read-back accepts that one row; the window size and the pane width stay exact.
describe('pane-border-status: the read-back accepts a pane one row shorter than the window', () => {
  const RELEASE = ['untag', 'select', 'focus', 'optUnset', 'optSet'];

  test('(+) 3-pane window, panel smaller (zoom only): the pane reads back W0 x (H0-1): zoomed / panel-smaller, lease held, no release argv', async () => {
    const r = rig((w) => { w.border = 1; });
    assert.deepEqual(await r.put('%2', 100, 30), ans('zoomed', 'panel-smaller', 200, 49, 3));
    assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'list', 'layout']);
    assert.ok(!r.names().some((n) => RELEASE.includes(n)), 'no release argv');
    assert.equal(r.fit.size(), 1);
    assert.match(r.tag(), FIT_NONCE);
    assert.equal(r.files().length, 1);
    const w = r.world.wins.get('@1');
    assert.deepEqual([w.zoomed, w.width, w.height], [true, 200, 50]);
  });

  test('(+) 3-pane window, panel at least as big (zoom + resize): the pane reads back C x (R-1): fitted', async () => {
    const r = rig((w) => { w.border = 1; });
    assert.deepEqual(await r.put('%2', 220, 60), ans('fitted', null, 220, 59, 3));
    assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout']);
    assert.ok(!r.names().some((n) => RELEASE.includes(n)), 'no release argv');
    assert.equal(r.fit.size(), 1);
    const w = r.world.wins.get('@1');
    assert.deepEqual([w.zoomed, w.width, w.height], [true, 220, 60]);
  });

  test('(+) 1-pane window resized to C x R: the pane reads back C x (R-1): fitted', async () => {
    const r = rig((w) => { w.border = 1; });
    assert.deepEqual(await r.put('%4', 100, 30), ans('fitted', null, 100, 29, 1));
    assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'size', 'list', 'layout']);
    assert.ok(!r.names().some((n) => RELEASE.includes(n)), 'no release argv');
    assert.equal(r.fit.size(), 1);
    assert.deepEqual([r.world.wins.get('@2').width, r.world.wins.get('@2').height], [100, 30]);
  });

  test('(+) a renew resize whose pane reads back C\' x (R\'-1) stays held: no release, and the watch keeps it', async () => {
    const r = rig((w) => { w.border = 1; });
    await r.put('%2', 220, 60);
    const nonce = r.tag();
    const at = r.at();
    assert.deepEqual(await r.put('%2', 240, 70, false), ans('fitted', null, 240, 69, 3));
    assert.deepEqual(r.names(at), ['list', 'list', 'size', 'list', 'layout']);
    assert.ok(!r.names(at).some((n) => RELEASE.includes(n)), 'no release argv');
    assert.equal(r.fit.size(), 1);
    assert.equal(r.tag(), nonce, 'the same lease');
    await r.tick(); // the watch compares the window, not the pane
    assert.equal(r.fit.size(), 1);
    assert.equal(r.tag(), nonce);
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

  test('(−) a pane two rows shorter than the window (H-2) is no border line: one release, blocked / changed, off until open:true', async () => {
    for (const [cols, rows] of [[100, 30], [220, 60]]) { // zoom only, then zoom + resize
      const r = rig((w) => { w.border = 2; });
      const before = r.world.snap('@1');
      const res = await r.put('%2', cols, rows);
      assert.equal(res.body.fit.state, 'blocked', `${cols}x${rows}`);
      assert.equal(res.body.fit.reason, 'changed', `${cols}x${rows}`);
      const n = r.names();
      assert.equal(n.filter((x) => x === 'tag').length, 1);
      assert.equal(n.filter((x) => x === 'untag').length, 1, 'released once');
      assert.equal(n.filter((x) => x === 'zoom').length, 2, 'the zoom of the acquire and the one unzoom of the restore, nothing more');
      assert.equal(r.fit.size(), 0);
      assert.deepEqual(r.files(), []);
      const w = r.world.wins.get('@1');
      assert.deepEqual([w.width, w.height, w.zoomed, w.tag, w.sizeOpt], [before.width, before.height, false, '', null]);
      const off = r.at();
      assert.equal((await r.put('%2', cols, rows, false)).body.fit.reason, 'changed');
      assert.deepEqual(r.names(off), ['list'], 'the heartbeat does not retry');
    }
  });

  test('(−) a pane one column narrower than the window (W-1, with H-1) is a mismatch: one release, blocked / changed', async () => {
    for (const [cols, rows, hook] of [[100, 30, 'zoom'], [220, 60, 'size']]) { // a hook narrows the pane after the last change of the acquire
      const r = rig((w) => { w.border = 1; });
      const [W, H] = hook === 'zoom' ? [200, 50] : [cols, rows];
      r.world.after = (name) => { if (name === hook) r.world.wins.get('@1').panes.find((p) => p.id === '%2').size = [W - 1, H - 1]; };
      const res = await r.put('%2', cols, rows);
      assert.equal(res.body.fit.state, 'blocked', `${cols}x${rows}`);
      assert.equal(res.body.fit.reason, 'changed', `${cols}x${rows}`);
      const n = r.names();
      assert.equal(n.filter((x) => x === 'untag').length, 1, 'released once');
      assert.equal(r.fit.size(), 0);
      assert.deepEqual(r.files(), []);
      assert.equal(r.tag(), '');
      r.world.after = null;
      const off = r.at();
      assert.equal((await r.put('%2', cols, rows, false)).body.fit.reason, 'changed');
      assert.deepEqual(r.names(off), ['list'], 'the heartbeat does not retry');
    }
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
    // 'a split' lived here: F2 (design-F12 §3.5) makes a new pane with no nika role a wait, not a user change; see the F2 tests below
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

// ---- F2 (design-F12 §3, §6): nika's own agent panes never turn the fit off -----------------------------------------------------

describe('F2: a split or an exit of nika\'s own agent panes is not a user change (the watch refits at once)', () => {
  const win = (r) => r.world.wins.get('@1');
  /** What tmux does for `split-window` (without -Z) in a fitted window: the new pane joins it, the zoom ends and the new pane is active. */
  function split(r, id = '%9', role = 'agent', over = {}) {
    const w = win(r);
    w.panes.push({ id, command: 'node', role, ...over });
    w.zoomed = false;
    r.world.setActive(w, id);
  }
  /** What tmux does when a pane exits: it leaves the window, the zoom ends. */
  function exit(r, id) {
    const w = win(r);
    w.panes = w.panes.filter((p) => p.id !== id);
    w.zoomed = false;
  }
  const withRole = (id, role) => (w) => { w.wins.get('@1').panes.find((p) => p.id === id).role = role; };
  const resizes = (r, at) => r.argv(at).filter((a) => a[0] === 'resize-window').map((a) => a.slice(3).join(' '));
  /** All tmux calls of one tick that refits: its own list, a release without zoom, select or focus (the window is unzoomed, the pane count changed), a list, then an acquire. */
  const REFIT = ['list', 'list', 'layout', 'size', 'optUnset', 'untag', 'list', 'list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout'];
  /** All tmux calls of one tick that only gives the window back (a user change or a lapse): its own list, then the same release, no acquire. */
  const GIVE_BACK = ['list', 'list', 'layout', 'size', 'optUnset', 'untag', 'list'];
  // After a pane exit the mirrored pane is still the active one, so the restore also puts focus back on the pane that was active before nika's zoom.
  const withFocus = (names) => [...names.slice(0, 5), 'focus', ...names.slice(5)];

  for (const role of ['agent', 'sub-orchestrator']) {
    test(`(+) a pane tagged ${role} joins the fitted window: one refit (release, then acquire), no mark, the window is fitted again`, async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      const first = r.tag();
      split(r, '%9', role);
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), REFIT);
      const second = r.tag();
      assert.match(second, /^[0-9a-f]{16}$/);
      assert.notEqual(second, first, 'a new lease');
      assert.deepEqual(r.files(), [`fit-${second}.json`], 'the old file is gone');
      assert.equal(r.fit.size(), 1);
      assert.deepEqual(resizes(r, at), ['-x 200 -y 50', '-x 220 -y 60'], 'the restore first, then the fit with the size the page asked for');
      const w = win(r);
      assert.deepEqual([w.zoomed, w.active, w.width, w.height], [true, '%2', 220, 60]);
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 4), 'the next heartbeat is fitted, not blocked');
      assert.equal(r.lease(second).panes, 4);
    });
  }

  test('(+) the page\'s next heartbeat after a refit is answered from the new lease: no tmux call', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r);
    await r.tick();
    const at = r.at();
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted');
    assert.equal(r.at(), at);
  });

  test('(+) race: the new pane is untagged at the first tick (one tick of grace, no tmux call), tagged at the next → refit', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r, '%9', '');
    const nonce = r.tag();
    let at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list'], 'waiting: only the listing');
    assert.equal(r.fit.size(), 1);
    assert.equal(r.tag(), nonce);
    win(r).panes.find((p) => p.id === '%9').role = 'agent'; // nika's spawn tagged it
    r.clock.t += WATCH_MS;
    at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), REFIT);
    assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 4));
  });

  test('(−) race lost: the new pane is still untagged WATCH_MS later → released with the mark user-change, and it stays off', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r, '%9', '');
    await r.tick();
    r.clock.t += WATCH_MS;
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), GIVE_BACK, 'the tick\'s list, then the release');
    assert.equal(r.fit.size(), 0);
    assert.equal(r.tag(), '');
    const res = await r.put('%2', 220, 60, false);
    assert.equal(res.body.fit.state, 'blocked');
    assert.equal(res.body.fit.reason, 'user-change');
    assert.equal((await r.put('%2', 220, 60, true)).body.fit.state, 'fitted', 'open:true is Fit again');
  });

  test('(−) race: 1 ms short of the grace the untagged pane is still waited for; at WATCH_MS it is a user change', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r, '%9', '');
    await r.tick(); // waitAt = now
    r.clock.t += WATCH_MS - 1;
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list']);
    assert.equal(r.fit.size(), 1);
    r.clock.t += 1;
    await r.tick();
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(+) the grace restarts for a window that was quiet in between (the untagged pane went away again)', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r, '%9', '');
    await r.tick(); // waitAt set
    win(r).panes = win(r).panes.filter((p) => p.id !== '%9');
    win(r).zoomed = true; // as if it had never been there
    r.world.setActive(win(r), '%2');
    r.clock.t += 400;
    await r.tick(); // unchanged window: waitAt cleared
    split(r, '%10', '');
    r.clock.t += 400;
    await r.tick(); // waitAt = now again
    r.clock.t += WATCH_MS - 1;
    await r.tick();
    assert.equal(r.fit.size(), 1, 'a stale waitAt would have released here');
  });

  for (const role of ['agent', 'sub-orchestrator']) {
    test(`(+) a pane that was tagged ${role} when the window was fitted exits (row gone, window unzoomed) → refit, no mark`, async () => {
      const r = rig(withRole('%3', role));
      await r.put('%2', 220, 60);
      exit(r, '%3');
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), withFocus(REFIT));
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 2));
      assert.equal(r.fit.size(), 1);
    });
  }

  for (const role of ['', 'orchestrator', 'Agent']) {
    test(`(−) a pane that was not nika's agent (role "${role}") exits → released with the mark user-change`, async () => {
      const r = rig(withRole('%3', role));
      await r.put('%2', 220, 60);
      exit(r, '%3');
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), withFocus(GIVE_BACK));
      assert.equal(r.fit.size(), 0);
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
    });
  }

  test('(+) an agent pane exits and another one is added in the same tick → refit', async () => {
    const r = rig(withRole('%3', 'agent'));
    await r.put('%2', 220, 60);
    exit(r, '%3');
    split(r, '%9', 'agent');
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), REFIT);
    assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 3));
  });

  test('(−) a pane is swapped for another one (same count, the zoom untouched) → the set differs, so it is a user change', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    const w = win(r);
    w.panes = w.panes.map((p) => (p.id === '%3' ? { id: '%9', command: 'zsh', role: '' } : p));
    assert.deepEqual([w.zoomed, w.active, w.panes.length], [true, '%2', 3], 'only the set differs: the zoom, the active pane and the count are as nika left them');
    await r.tick();
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(+) one agent pane is swapped for another one (same count, the zoom untouched) → refit', async () => {
    const r = rig(withRole('%3', 'agent'));
    await r.put('%2', 220, 60);
    const first = r.tag();
    const w = win(r);
    w.panes = w.panes.map((p) => (p.id === '%3' ? { id: '%9', command: 'node', role: 'agent' } : p));
    assert.deepEqual([w.zoomed, w.active, w.panes.length], [true, '%2', 3], 'only the set differs: the zoom, the active pane and the count are as nika left them');
    await r.tick();
    assert.equal(r.fit.size(), 1);
    assert.notEqual(r.tag(), first, 'given back and fitted again');
    assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 3));
    assert.equal(w.zoomed, true);
  });

  test('(−) an agent is added while a pane that was not nika\'s exits in the same tick → the user\'s exit decides: mark', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    exit(r, '%3');
    split(r, '%9', 'agent');
    await r.tick();
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(−) the same panes, the window unzoomed (C-b z) or another pane active: still a user change, even with agent panes in the window', async () => {
    for (const how of ['unzoom', 'navigate']) {
      const r = rig(withRole('%3', 'agent'));
      await r.put('%2', 220, 60);
      if (how === 'unzoom') win(r).zoomed = false;
      else win(r).active = '%3';
      await r.tick();
      assert.equal(r.fit.size(), 0, how);
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change', how);
    }
  });

  test('(−) an agent split and a size change in the same tick: the size is someone else\'s → released with the mark, nothing fitted again', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r);
    win(r).width = 180;
    const at = r.at();
    await r.tick();
    assert.ok(!r.names(at).includes('tag'), 'no acquire');
    assert.equal(r.fit.size(), 0);
    assert.equal(win(r).width, 200, 'the restore sets the original size');
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(−) two panes are added, one tagged agent and one untagged: past the grace it is a user change, and nothing is fitted again', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r, '%9', 'agent');
    split(r, '%10', '');
    let at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list'], 'the untagged one is waited for');
    r.clock.t += WATCH_MS;
    at = r.at();
    await r.tick();
    assert.ok(!r.names(at).includes('tag'));
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(−) role values that are not exactly "agent" or "sub-orchestrator" are not nika\'s: waited for once, then a user change', async () => {
    for (const role of ['Agent', 'AGENT', 'agent ', ' agent', 'sub-orchestrator ', 'orchestrator', 'agents', '']) {
      const r = rig();
      await r.put('%2', 220, 60);
      split(r, '%9', role);
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), ['list'], JSON.stringify(role));
      r.clock.t += WATCH_MS;
      await r.tick();
      assert.ok(!r.names(at).includes('tag'), JSON.stringify(role));
      assert.equal(r.fit.size(), 0, JSON.stringify(role));
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change', JSON.stringify(role));
    }
  });

  test('(−) a role with a tab in it makes a row of 14 fields: dropped, so the window shows fewer panes than tmux counts → user change at once (fail closed)', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r, '%9', 'agent'); // a good agent pane next to it: the dropped row must not hide behind it
    split(r, '%10', 'agent\tx');
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), GIVE_BACK);
    assert.ok(!r.names(at).includes('tag'));
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(−) a row of the window that does not parse (the pane count differs) → user change at once, even for an agent pane', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    split(r, '%9', 'agent'); // a good agent pane next to it: the dropped row must not hide behind it
    split(r, '%10', 'agent', { size: [0, 0] }); // pane_width 0: the row is dropped
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), GIVE_BACK);
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(+) known refresh: a pane untagged when the window was fitted that is tagged later counts as nika\'s when it exits', async () => {
    const r = rig(); // %3 has no role at verify
    await r.put('%2', 220, 60);
    win(r).panes.find((p) => p.id === '%3').role = 'agent'; // nika tags it later; the row set does not change
    r.clock.t += 500;
    const at = r.at();
    await r.tick();
    assert.deepEqual(r.names(at), ['list'], 'an unchanged window: the watch only looks');
    exit(r, '%3');
    await r.tick();
    assert.equal(r.fit.size(), 1, 'refit, not a user change');
    assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 2));
  });

  test('(−) the control of the refresh: without a tick in between the untagged pane\'s exit is the user\'s', async () => {
    const r = rig();
    await r.put('%2', 220, 60);
    win(r).panes.find((p) => p.id === '%3').role = 'agent';
    exit(r, '%3');
    await r.tick();
    assert.equal(r.fit.size(), 0);
    assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
  });

  test('(+) a single-pane window: the agent that splits beside the orchestrator is a refit (no zoom to undo, then zoom and size)', async () => {
    const r = rig();
    await r.put('%4', 100, 30);
    const w = r.world.wins.get('@2');
    w.panes.push({ id: '%9', command: 'node', role: 'agent' });
    r.world.setActive(w, '%9');
    await r.tick();
    assert.equal(r.fit.size(), 1);
    assert.deepEqual(await r.put('%4', 100, 30, false), ans('fitted', null, 100, 30, 2));
    assert.deepEqual([w.zoomed, w.active, w.width, w.height], [true, '%4', 100, 30]);
  });

  test('(+) the last agent exits and the orchestrator stays alone: refit as a single-pane window', async () => {
    const r = rig((w) => w.add('@3', [['%7', 'claude'], ['%8', 'node', 'agent']], 120, 40));
    await r.put('%7', 150, 45);
    const w = r.world.wins.get('@3');
    w.panes = w.panes.filter((p) => p.id !== '%8');
    w.zoomed = false;
    await r.tick();
    assert.equal(r.fit.size(), 1);
    assert.deepEqual(await r.put('%7', 150, 45, false), ans('fitted', null, 150, 45, 1));
    assert.deepEqual([w.width, w.height], [150, 45]);
  });

  test('(+) a refit uses only the existing argv shapes, and its listing is the 13-field format', async () => {
    const r = rig(withRole('%3', 'agent'));
    await r.put('%2', 220, 60);
    split(r, '%9', 'sub-orchestrator');
    exit(r, '%3');
    await r.tick();
    assert.ok(r.argv().every((a) => shape(a) !== null), 'every argv is one of the section 4 shapes');
    assert.deepEqual(r.argv().filter((a) => a[0] === 'list-panes').every((a) => a.join(' ') === ['list-panes', '-a', '-F', FMT].join(' ')), true);
    assert.equal(FMT.split('\t').length, 13);
    assert.equal(FMT.split('\t')[11], '#{@nika-role}');
    assert.equal(FMT.split('\t')[12], '#{window_active_clients}');
  });

  test('(−) the lease file keys are unchanged: the lease memory (known, waitAt) is never written', async () => {
    const r = rig(withRole('%3', 'agent'));
    await r.put('%2', 220, 60);
    const KEYS = ['v', 'nonce', 'window', 'pane', 'panes', 'zoomed0', 'active0', 'width0', 'height0', 'size0', 'layout0', 'layout1', 'cols', 'rows', 'resized', 'userZoom', 'at'];
    assert.deepEqual(Object.keys(r.lease(r.tag())), KEYS);
    split(r, '%9', '');
    await r.tick(); // waitAt set
    assert.deepEqual(Object.keys(r.lease(r.tag())), KEYS);
    win(r).panes.find((p) => p.id === '%9').role = 'agent';
    r.clock.t += WATCH_MS;
    await r.tick(); // refit: a new lease, a new file
    assert.deepEqual(Object.keys(r.lease(r.tag())), KEYS);
    assert.ok(!fs.readFileSync(r.file(r.tag()), 'utf8').match(/known|waitAt/));
  });

  describe('the watch\'s limits on a refit', () => {
    test('(−) a lease whose page is gone (no heartbeat for more than LAPSE_MS) is only released: no acquire, no mark', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      r.clock.t += LAPSE_MS + 1;
      split(r);
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), GIVE_BACK);
      assert.ok(!r.names(at).includes('tag'));
      assert.equal(r.fit.size(), 0);
      assert.equal(r.tag(), '');
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted', 'a lapse is not a user change: no mark');
    });

    test('(−) the same for a pane that is waited for: a lapsed lease is released, not kept waiting', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      r.clock.t += LAPSE_MS + 1;
      split(r, '%9', '');
      await r.tick();
      assert.equal(r.fit.size(), 0);
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted', 'no mark either');
    });

    test('(+) the new lease keeps the old heartbeat: a page that went away still lapses on time', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      const t0 = r.clock.t;
      r.clock.t = t0 + 5000;
      split(r);
      await r.tick(); // refit at t0 + 5 s
      assert.equal(r.fit.size(), 1);
      r.clock.t = t0 + LAPSE_MS;
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), ['list'], '15 s after the last heartbeat: not lapsed yet');
      r.clock.t += 1;
      await r.tick();
      assert.equal(r.fit.size(), 0, 'lapsed 15 s + 1 ms after the page\'s last heartbeat, not after the refit');
      assert.equal(r.tag(), '');
    });

    // F4 (owner answer Q5) replaced this test: it asserted the F2 leftover (the DELETE found its lease already replaced and the new lease
    // stayed held up to 15 s, so a second refit met the note). The DELETE now releases the new lease; see 'a DELETE that meets a refit'.
    test('(+) a DELETE queued behind a renew that refits releases the lease the refit made; the note then blocks the late heartbeat', async () => {
      const r = rig();
      const { fit, g } = gatedFit(r);
      await fit.hold('%2', { cols: 220, rows: 60, open: true });
      g.shut();
      const put = fit.hold('%2', { cols: 240, rows: 70, open: false }); // a renew waiting in the pane lock
      await until(() => g.waiting === 1);
      const del = fit.release('%2'); // queued behind it, for the lease the renew is about to replace
      split(r);
      g.open();
      assert.deepEqual((await put).body.fit.state, 'fitted', 'the renew refitted');
      assert.deepEqual((await del).body, { released: true });
      assert.equal(fit.size(), 0, 'the DELETE released the lease the refit made');
      assert.equal(r.tag(), '');
      assert.deepEqual(r.files(), []);
      assert.equal(win(r).width, 200, 'the window is back at its size');
      assert.equal((await fit.hold('%2', { cols: 240, rows: 70, open: false })).body.fit.reason, 'user-change', 'the late heartbeat of the closed page is blocked by the note');
      r.clock.t += 2500; // 2.5 s after the DELETE: the note is old, the next heartbeat fits as it always did
      assert.equal((await fit.hold('%2', { cols: 240, rows: 70, open: false })).body.fit.state, 'fitted');
    });

    test('(−) a refit that fails in tmux (the zoom of the acquire) logs one line, leaves no lease, file or tag, and the tick does not throw', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      split(r);
      r.world.fail = (name) => name === 'zoom';
      await r.tick();
      assert.equal(r.fit.size(), 0);
      assert.deepEqual(r.files(), []);
      assert.equal(r.tag(), '');
      assert.equal(win(r).width, 200, 'the window is back at its size');
      assert.equal(r.logs.filter((l) => /^nika: fit @1 %2 (refit|zoom|cleanup) failed \(\w+\)$/.test(l)).length >= 1, true);
      r.world.fail = null;
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted', 'no mark: the page\'s next heartbeat fits the window');
    });

    test('(−) a refit that finds the pane busy keeps the lease; the next tick tries again', async () => {
      const r = rig();
      const { fit, gate } = busyRig(r);
      await fit.hold('%2', { cols: 220, rows: 60, open: true });
      split(r);
      gate.busy = true;
      await r.tick();
      assert.equal(fit.size(), 1, 'registered again');
      assert.equal(gate.refused, 1);
      gate.busy = false;
      const at = r.at();
      await r.tick();
      assert.ok(r.names(at).includes('tag'), 'refitted');
      assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: false }), ans('fitted', null, 220, 60, 4));
    });
  });

  describe('a page request (renew) meets nika\'s own split before the watch does', () => {
    test('(+) a PUT with a new size and an agent split the watch has not seen: release and acquire in the same request, answered fitted for the new window', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      split(r);
      const at = r.at();
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('fitted', null, 240, 70, 4));
      assert.deepEqual(resizes(r, at), ['-x 200 -y 50', '-x 240 -y 70']);
      assert.equal(r.fit.size(), 1);
      assert.equal(r.lease(r.tag()).panes, 4);
    });

    test('(+) the same request with open:true', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      split(r);
      assert.deepEqual(await r.put('%2', 240, 70, true), ans('fitted', null, 240, 70, 4));
    });

    test('(+) an untagged new pane: answered from the lease, no resize, waitAt untouched (the watch alone starts the grace)', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      split(r, '%9', '');
      const t0 = r.clock.t;
      const at = r.at();
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('fitted', null, 220, 60, 3));
      assert.deepEqual(r.names(at), ['list'], 'one listing, no resize');
      assert.equal(r.fit.size(), 1);
      r.clock.t = t0 + 500;
      await r.tick(); // waitAt = t0 + 500 (had renew set it, it would be t0)
      r.clock.t = t0 + 1000;
      const at2 = r.at();
      await r.tick();
      assert.deepEqual(r.names(at2), ['list'], 'still inside the grace of the tick that started it');
      assert.equal(r.fit.size(), 1);
      r.clock.t = t0 + 1500;
      await r.tick();
      assert.equal(r.fit.size(), 0);
    });

    test('(−) an untagged new pane past the grace that the watch started: the request releases with the mark, no resize', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      split(r, '%9', '');
      await r.tick(); // grace starts
      r.clock.t += WATCH_MS;
      const res = await r.put('%2', 240, 70, false);
      assert.equal(res.body.fit.reason, 'user-change');
      assert.equal(res.body.fit.state, 'blocked');
      assert.ok(!resizes(r, 0).includes('-x 240 -y 70'));
      assert.equal(r.fit.size(), 0);
    });
  });

  describe('N1: the split lands while the renew waits for the pane lock', () => {
    async function renewDuringWait(flip) {
      const r = rig();
      const { fit, g } = gatedFit(r);
      await fit.hold('%2', { cols: 220, rows: 60, open: true });
      g.shut();
      const at = r.at();
      const done = fit.hold('%2', { cols: 240, rows: 70, open: false });
      await until(() => g.waiting === 1);
      flip(r);
      g.open();
      return { r, fit, res: await done, at };
    }

    test('(+) an agent split: the refit path; the first resize-window is the restore, the window is never resized over the split', async () => {
      const { r, fit, res, at } = await renewDuringWait((r) => split(r));
      assert.deepEqual(res, ans('fitted', null, 240, 70, 4));
      assert.deepEqual(resizes(r, at), ['-x 200 -y 50', '-x 240 -y 70']);
      assert.equal(fit.size(), 1);
    });

    test('(+) an untagged new pane: no resize at all, the lease continues at the old size, answered from the lease', async () => {
      const { r, fit, res, at } = await renewDuringWait((r) => split(r, '%9', ''));
      assert.deepEqual(res, ans('fitted', null, 220, 60, 3));
      assert.deepEqual(resizes(r, at), []);
      assert.ok(!r.names(at).includes('untag'), 'nothing released');
      assert.equal(fit.size(), 1);
      assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: false }), ans('fitted', null, 220, 60, 3), 'the lease still holds the old size');
    });

    test('(−) an agent split together with a resize by someone else: released with the mark, no resize to the new size', async () => {
      const { r, fit, res, at } = await renewDuringWait((r) => { split(r); win(r).width = 150; });
      assert.equal(res.body.fit.reason, 'user-change');
      assert.ok(!resizes(r, at).includes('-x 240 -y 70'));
      assert.ok(!r.names(at).includes('tag'));
      assert.equal(fit.size(), 0);
    });
  });
});

// ---- F4 (design-F4, nika 0.5): nika never resizes a tmux window that a terminal shows ---------------------------------------
// `world.view(window, n, size)` is "n terminals show the window"; a window that is not `manual` follows the terminal (spike S16).

describe('F4: nika never resizes a tmux window that a terminal shows', () => {
  const win = (r, id = '@1') => r.world.wins.get(id);
  /** single pane, no zoom, no resize-window: the acquire of a window nika leaves to the terminal */
  const ACQ1 = ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'list', 'layout'];
  /** three panes: the same with the zoom */
  const ACQ3 = ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'list', 'layout'];
  const sizesOf = (r, at) => r.argv(at).filter((a) => a[0] === 'resize-window').map((a) => a.slice(3).join(' '));
  const KEYS = ['v', 'nonce', 'window', 'pane', 'panes', 'zoomed0', 'active0', 'width0', 'height0', 'size0', 'layout0', 'layout1', 'cols', 'rows', 'resized', 'userZoom', 'at'];
  /** What tmux does for `split-window` (without -Z) in a fitted window: the new pane joins it, the zoom ends and the new pane is active. */
  function split(r, id = '%9', role = 'agent') {
    const w = win(r);
    w.panes.push({ id, command: 'node', role });
    w.zoomed = false;
    r.world.setActive(w, id);
  }
  /** The page's heartbeat at the held size (no tmux call), `ms` after the last step, then one watch tick; → the names of the tmux calls the tick made. */
  async function step(r, ms, pane = '%2', cols = 220, rows = 60) {
    r.clock.t += ms;
    await r.put(pane, cols, rows, false);
    const at = r.at();
    await r.tick();
    return r.names(at);
  }
  /** A `terminal` lease on the 3-pane window @1: a terminal of the window's own size shows it, panel 220x60, mirrored pane %2. */
  async function termLease(r) {
    r.world.view('@1', 1, [200, 50]);
    assert.deepEqual(await r.put('%2', 220, 60), ans('terminal', null, 200, 50, 3));
    return r.tag();
  }
  /**
   * What the tick of a GROW does to the 3-pane window @1. F9 (requirement changed, Q2): a take in place on the same lease, no release and no new
   * zoom: the tick's listing, the take's in-lock listing, the window-size check, the resize to the panel, the read-back. (F4: a refit of ~20 calls.)
   */
  const GROW_TICK = ['list', 'list', 'option', 'size', 'list', 'layout'];

  test('(+) GROW_MS is 30 s', () => {
    assert.equal(GROW_MS, 30000);
  });

  describe('the 13th field of the listing, #{window_active_clients}', () => {
    test('(+) the count is read from the mirrored pane\'s own window: 0 is no terminal, 1 and 9999 are one', async () => {
      for (const [n, state] of [[0, 'fitted'], [1, 'terminal'], [9999, 'terminal']]) {
        const r = rig((w) => w.view('@2', n, [80, 24]));
        assert.equal((await r.put('%4', 100, 30)).body.fit.state, state, String(n));
      }
    });

    test('(−) a terminal on another window does not count: this window is fitted and resized as before', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      assert.deepEqual(await r.put('%2', 220, 60), ans('fitted', null, 220, 60, 3));
      assert.deepEqual(sizesOf(r, 0), ['-x 220 -y 60']);
    });

    test('(−) a count that is not 1 to 5 digits in 0..9999 drops the row: the mirrored pane is 404, nothing is changed', async () => {
      for (const bad of ['x', '-1', '', '1.5', '123456', '10000', ' 1', '1 ', '0x1', '1e2']) {
        const r = rig((w) => { w.wins.get('@1').panes.find((p) => p.id === '%2').clientsRaw = bad; });
        assert.deepEqual(await r.put('%2', 220, 60), NF, JSON.stringify(bad));
        assert.deepEqual(r.names(), ['list'], JSON.stringify(bad));
        assert.equal(r.tag(), '', JSON.stringify(bad));
      }
    });

    test('(−) a bad count on another pane of a held window: that row is gone, so the window shows fewer panes than tmux counts → user change at once (fail closed)', async () => {
      for (const bad of ['x', '-1', '', '1.5', '123456', '10000', '0\tx']) { // the last makes a row of 14 fields
        const r = rig();
        await r.put('%2', 220, 60);
        win(r).panes.find((p) => p.id === '%3').clientsRaw = bad;
        await r.tick();
        assert.equal(r.fit.size(), 0, JSON.stringify(bad));
        assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change', JSON.stringify(bad));
      }
    });
  });

  describe('acquire', () => {
    test('(+) one pane, a terminal shows it: the tag only (no resize-window, no zoom), terminal / null, the window keeps its size, the file says resized:false', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      assert.deepEqual(await r.put('%4', 100, 30), ans('terminal', null, 80, 24, 1));
      assert.deepEqual(r.names(), ACQ1);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height, win(r, '@2').sizeOpt], [80, 24, null]);
      const f = r.lease(r.tag('@2'));
      assert.deepEqual([f.resized, f.cols, f.rows, f.width0, f.height0], [false, 100, 30, 80, 24]);
    });

    test('(+) three panes, a terminal shows the window: zoom, no resize-window, terminal for a panel bigger and for a panel smaller (not zoomed / panel-smaller)', async () => {
      for (const [cols, rows] of [[220, 60], [100, 30]]) {
        const r = rig((w) => w.view('@1', 1, [200, 50]));
        assert.deepEqual(await r.put('%2', cols, rows), ans('terminal', null, 200, 50, 3), `${cols}x${rows}`);
        assert.deepEqual(r.names(), ACQ3);
        assert.deepEqual([win(r).zoomed, win(r).active, win(r).width, win(r).height], [true, '%2', 200, 50]);
      }
    });

    test('(+) the user had the mirrored pane zoomed and a terminal shows it: no zoom and no resize argv, terminal with userZoom', async () => {
      const r = rig((w) => { const x = w.wins.get('@1'); x.zoomed = true; x.active = '%2'; w.view('@1', 1, [200, 50]); });
      assert.deepEqual(await r.put('%2', 220, 60), ans('terminal', null, 200, 50, 3, true));
      assert.deepEqual(r.names(), ACQ1);
    });

    test('(−) no terminal: the same windows are fitted with a resize, or zoomed / panel-smaller, exactly as before', async () => {
      const a = rig((w) => w.view('@1', 0));
      assert.deepEqual(await a.put('%2', 220, 60), ans('fitted', null, 220, 60, 3));
      assert.deepEqual(sizesOf(a, 0), ['-x 220 -y 60']);
      const b = rig();
      assert.deepEqual(await b.put('%2', 100, 30), ans('zoomed', 'panel-smaller', 200, 50, 3));
      const c = rig();
      assert.deepEqual(await c.put('%4', 100, 30), ans('fitted', null, 100, 30, 1));
    });

    test('(−) size-option, user-zoom and foreign-tag refusals still win over a terminal, and so does a user-change mark with open:false', async () => {
      const so = rig((w) => { w.wins.get('@1').sizeOpt = 'weird'; w.view('@1', 1, [200, 50]); });
      assert.equal((await so.put('%2', 220, 60)).body.fit.reason, 'size-option');
      const uz = rig((w) => { const x = w.wins.get('@1'); x.zoomed = true; x.active = '%3'; w.view('@1', 1, [200, 50]); });
      assert.equal((await uz.put('%2', 220, 60)).body.fit.reason, 'user-zoom');
      const ft = rig((w) => { w.wins.get('@1').tag = 'ffffffffffffffff'; w.view('@1', 1, [200, 50]); });
      assert.equal((await ft.put('%2', 220, 60)).body.fit.reason, 'foreign-tag');
      for (const x of [so, uz, ft]) assert.ok(!x.names().some((n) => MUTATING.has(n)), 'nothing was changed');
      const r = rig();
      await r.put('%2', 220, 60);
      win(r).zoomed = false; // the user unzooms
      await r.tick(); // user-change mark
      r.world.view('@1', 1, [200, 50]);
      const at = r.at();
      const res = await r.put('%2', 220, 60, false);
      assert.equal(res.body.fit.state, 'blocked');
      assert.equal(res.body.fit.reason, 'user-change');
      assert.deepEqual(r.names(at), ['list']);
    });

    test('(+) Fit again (open:true) with a terminal: terminal, never a resize', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      win(r).zoomed = false;
      await r.tick(); // user-change mark
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
      r.world.view('@1', 1, [200, 50]);
      const at = r.at();
      assert.deepEqual(await r.put('%2', 220, 60, true), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(r.names(at), ACQ3);
      assert.deepEqual(sizesOf(r, at), []);
    });

    test('(+) a terminal arrives while the acquire waits for the pane lock (the window keeps its size, option manual): no resize-window, terminal', async () => {
      const r = rig((w) => { w.wins.get('@2').sizeOpt = 'manual'; });
      const { fit, g } = gatedFit(r);
      g.shut();
      const p = fit.hold('%4', { cols: 100, rows: 30, open: true }); // plan: a resize to 100x30
      await until(() => g.waiting === 1);
      r.world.view('@2', 1, [80, 24]);
      g.open();
      assert.deepEqual(await p, ans('terminal', null, 80, 24, 1));
      assert.deepEqual(sizesOf(r, 0), []);
      assert.equal(r.lease(r.tag('@2')).resized, false, 'verify rewrote the file');
    });

    test('(+) a terminal is there when the acquire decides and gone when the lock is granted: still terminal and no resize (the watch grows it after GROW_MS)', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      const { fit, g } = gatedFit(r);
      g.shut();
      const p = fit.hold('%4', { cols: 100, rows: 30, open: true });
      await until(() => g.waiting === 1);
      r.world.view('@2', 0);
      g.open();
      assert.deepEqual(await p, ans('terminal', null, 80, 24, 1));
      assert.deepEqual(sizesOf(r, 0), []);
    });

    test('(+) the terminal resizes the window between the tag and the read-back: terminal, not blocked / changed (a terminal lease\'s size is the terminal\'s)', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      r.world.after = (name) => { if (name === 'tag') r.world.view('@2', 1, [100, 30]); };
      assert.deepEqual(await r.put('%4', 100, 30), ans('terminal', null, 100, 30, 1));
      assert.equal(r.fit.size(), 1);
      assert.deepEqual(sizesOf(r, 0), []);
      assert.equal(r.tag('@2').length, 16);
    });

    test('(−) a terminal arrives while the acquire waits and the window takes its size: blocked / changed, nothing changed, no mark; the next request is terminal', async () => {
      const r = rig();
      const { fit, g } = gatedFit(r);
      g.shut();
      const p = fit.hold('%4', { cols: 100, rows: 30, open: true });
      await until(() => g.waiting === 1);
      r.world.view('@2', 1, [120, 30]); // option not manual: the window follows
      g.open();
      assert.deepEqual(await p, ans('blocked', 'changed', 120, 30, 1));
      assert.ok(!r.names().some((n) => MUTATING.has(n)));
      assert.equal(r.tag('@2'), '');
      assert.deepEqual(r.files(), []);
      assert.deepEqual(await fit.hold('%4', { cols: 100, rows: 30, open: false }), ans('terminal', null, 120, 30, 1), 'no mark');
    });

    // F9 (requirement changed, Q2): F4 released the lease and acquired it again without a resize (a retry); the move is now a give in place
    test('(+) a terminal arrives between the resize and the read-back (page without focus): given back in place in the same request, no release and no retry → terminal; a lapse then releases with no mark', async () => {
      const r = rig();
      let n = 0;
      r.world.after = (name) => { if (name === 'size') { n += 1; if (n === 1) r.world.view('@2', 1, [100, 30]); } };
      assert.deepEqual(await r.put('%4', 100, 30), ans('terminal', null, 100, 30, 1));
      assert.deepEqual(r.names(), [
        'list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'size', 'list', 'layout', // the acquire, A4 and the read-back that sees the terminal
        'list', 'size', 'optUnset', 'list', 'layout', // given back in place: nika's size off, the window follows the terminal, read back; no untag, no new tag
      ]);
      assert.equal(n, 2, 'the resize of A4 and the give\'s resize back: no other resize-window');
      assert.equal(r.names().filter((x) => x === 'tag').length, 1, 'one acquire, no retry');
      assert.equal(r.fit.size(), 1);
      r.clock.t += LAPSE_MS + 1;
      await r.tick(); // the page is gone: released without a mark
      assert.equal(r.fit.size(), 0);
      r.world.view('@2', 0);
      assert.equal((await r.put('%4', 100, 30, false)).body.fit.state, 'fitted', 'no user-change mark was set');
    });

    // F9 (requirement changed, Q2): there is no retry any more, so "the retry never resizes" (F4) became "the give looks again and gives nothing when the terminal has left"
    test('(−) the same, and the terminal leaves again before the give looks: nothing is given back (no resize back, no option change), fitted at the panel size, and nothing is tried again', async () => {
      const r = rig();
      let armed = false;
      r.world.after = (name) => {
        if (name === 'size') { r.world.view('@2', 1, [100, 30]); armed = true; } // the terminal comes after nika's resize ...
        else if (name === 'layout' && armed) { armed = false; r.world.view('@2', 0); } // ... and is gone when the give looks
      };
      assert.deepEqual(await r.put('%4', 100, 30), ans('fitted', null, 100, 30, 1));
      assert.deepEqual(sizesOf(r, 0), ['-x 100 -y 30'], 'no resize back');
      assert.ok(!r.names().includes('optUnset'));
      assert.equal(r.names().filter((x) => x === 'tag').length, 1, 'one acquire');
      assert.equal(r.fit.size(), 1);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height, win(r, '@2').sizeOpt], [100, 30, 'manual']);
      assert.equal(r.lease(r.tag('@2')).resized, true);
    });
  });

  describe('the watch', () => {
    // F9 (requirement changed, Q2): F4 gave the window back and took it again (a refit of ~17 calls); the give is now one move in place on the same lease
    test('(+) a fitted (resized) lease, a terminal comes: the next tick gives the size back in place (the lease and the tag stay); no mark; the next request says terminal', async () => {
      const r = rig();
      await r.put('%4', 100, 30);
      const nonce = r.tag('@2');
      r.world.view('@2', 1, [90, 25]); // manual: still 100x30
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), [
        'list', // the tick
        'list', 'size', 'optUnset', // the give: nika's size off, the option back; no relayout, no untag, no new tag
        'list', 'layout', // read back
      ]);
      assert.deepEqual(sizesOf(r, at), ['-x 80 -y 24'], 'the only resize-window is the way back');
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height, win(r, '@2').sizeOpt], [90, 25, null], 'the window follows the terminal');
      assert.equal(r.tag('@2'), nonce, 'the same lease');
      assert.deepEqual(r.logs, [], 'R9 does not call the terminal\'s size a difference');
      assert.equal(r.fit.size(), 1);
      assert.deepEqual(await r.put('%4', 100, 30, false), ans('terminal', null, 90, 25, 1));
    });

    test('(+) a zoomed (never resized) lease, a terminal comes and the window takes its size: no tmux call; the next request says terminal', async () => {
      const r = rig();
      await r.put('%2', 100, 30);
      r.world.view('@1', 1, [180, 45]);
      assert.deepEqual([win(r).width, win(r).height], [180, 45]);
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), ['list']);
      assert.equal(r.fit.size(), 1);
      assert.equal((await r.put('%2', 100, 30, false)).body.fit.state, 'terminal', 'the heartbeat at the held size is answered from the lease, which the tick moved to the terminal form');
      assert.deepEqual(await r.put('%2', 110, 35, false), ans('terminal', null, 180, 45, 3));
      assert.deepEqual(r.names(at), ['list', 'list']);
    });

    test('(−) the same lease, no terminal and the window resized by the user: still a user change (the size of a lease that was never viewed is judged)', async () => {
      const r = rig();
      await r.put('%2', 100, 30);
      win(r).width = 180;
      await r.tick();
      assert.equal(r.fit.size(), 0);
      assert.equal((await r.put('%2', 100, 30, false)).body.fit.reason, 'user-change');
    });

    test('(+) a terminal lease, the terminal resizes: no call, no mark, still terminal', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 1, [150, 40]);
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), ['list']);
      assert.equal(r.fit.size(), 1);
      assert.deepEqual(await r.put('%2', 230, 65, false), ans('terminal', null, 150, 40, 3));
    });

    test('(+) a terminal lease, no terminal: nothing for GROW_MS - 1 after the first tick that saw none; at GROW_MS the window is taken again in place, with a resize (F9: requirement changed, Q2; F4 gave it back and fitted it again)', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      assert.deepEqual(await step(r, 1000), ['list'], 'awayAt = now');
      assert.deepEqual(await step(r, 10_000), ['list']);
      assert.deepEqual(await step(r, 10_000), ['list']);
      assert.deepEqual(await step(r, GROW_MS - 1 - 20_000), ['list'], 'GROW_MS - 1 ms after awayAt');
      assert.deepEqual(await step(r, 1), GROW_TICK, 'GROW_MS after awayAt');
      assert.deepEqual([win(r).width, win(r).height], [220, 60]);
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 3));
    });

    test('(−) the terminal is back after 20 s and gone again: the 30 s start over (no grow 30 s after the first leave)', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      await step(r, 1000); // awayAt = A
      await step(r, 10_000);
      await step(r, 10_000); // A + 20 s
      r.world.view('@1', 1, [200, 50]);
      assert.deepEqual(await step(r, 100), ['list'], 'back: awayAt cleared');
      r.world.view('@1', 0);
      assert.deepEqual(await step(r, 100), ['list'], 'gone again: awayAt = A + 20.2 s');
      assert.deepEqual(await step(r, 9_900), ['list'], 'A + 30.1 s: the first leave\'s 30 s are over, the new ones are not');
      assert.deepEqual(await step(r, 10_000), ['list']);
      assert.deepEqual(await step(r, 9_900), ['list'], 'the new awayAt + 29.8 s');
      assert.deepEqual(await step(r, 200), GROW_TICK, 'the new awayAt + GROW_MS');
    });

    test('(−) a terminal lease: the user unzooms → user-change mark (W7 Q6), and a user\'s untagged split past the grace is a user change too', async () => {
      const a = rig();
      await termLease(a);
      win(a).zoomed = false;
      await a.tick();
      assert.equal(a.fit.size(), 0);
      assert.equal((await a.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
      const b = rig();
      await termLease(b);
      split(b, '%9', '');
      await b.tick();
      assert.equal(b.fit.size(), 1, 'one tick of grace');
      b.clock.t += WATCH_MS;
      await b.tick();
      assert.equal(b.fit.size(), 0);
      assert.equal((await b.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
    });

    test('(+) a terminal lease, an agent splits while a terminal shows the window: a refit that lands terminal, and no resize-window at all', async () => {
      const r = rig();
      const first = await termLease(r);
      split(r);
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), [
        'list', 'list', 'layout', 'optUnset', 'untag', 'list', // given back: no size (nika never sized it), no layout (it changed)
        'list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'list', 'layout',
      ]);
      assert.notEqual(r.tag(), first);
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('terminal', null, 200, 50, 4));
    });

    test('(+) a terminal lease, an agent splits while the terminal is away for less than GROW_MS: terminal again without a resize, and the grace goes on where it was', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      await step(r, 1000); // awayAt = A
      r.clock.t += 19_000; // A + 19 s
      await r.put('%2', 220, 60, false);
      split(r);
      const at = r.at();
      await r.tick();
      assert.deepEqual(sizesOf(r, at), [], 'the refit did not end the grace early');
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('terminal', null, 200, 50, 4));
      assert.deepEqual(await step(r, 10_999), ['list'], 'A + 29.999 s');
      const grow = await step(r, 1); // A + 30 s: the same awayAt as before the refit
      assert.ok(grow.includes('size'), 'GROW_MS after the first leave');
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 4));
    });

    test('(+) the same refit after the grace is over: it fits the window with a resize', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      await step(r, 1000); // awayAt = A
      r.clock.t += GROW_MS; // A + 30 s
      await r.put('%2', 220, 60, false); // the page's heartbeat
      split(r);
      const at = r.at();
      await r.tick();
      assert.deepEqual(sizesOf(r, at), ['-x 220 -y 60']);
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 4));
    });

    test('(−) a resized lease, the terminal comes AND the user unzooms in the same tick: a user change, no re-zoom', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      r.world.view('@1', 1, [200, 50]);
      win(r).zoomed = false;
      const at = r.at();
      await r.tick();
      assert.ok(!r.names(at).includes('tag'), 'not fitted again');
      assert.ok(!r.names(at).includes('zoom'), 'no unzoom and no re-zoom');
      assert.equal(r.fit.size(), 0);
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change');
    });

    test('(−) a lapsed lease (no heartbeat for more than LAPSE_MS) with a view, an away, a give or a take pending is only released: no acquire, no mark', async () => {
      const view = rig(); // VIEW: zoomed lease, terminal comes
      await view.put('%2', 100, 30);
      view.world.view('@1', 1, [180, 45]);
      const away = rig(); // AWAY: terminal lease, terminal gone
      await termLease(away);
      away.world.view('@1', 0);
      const shrink = rig(); // a give (F4: SHRINK): resized lease, terminal comes
      await shrink.put('%4', 100, 30);
      shrink.world.view('@2', 1, [90, 25]);
      for (const [name, x] of [['view', view], ['away', away], ['shrink', shrink]]) {
        x.clock.t += LAPSE_MS + 1;
        const at = x.at();
        await x.tick();
        assert.ok(x.names(at).includes('untag'), name);
        assert.ok(!x.names(at).includes('tag'), name);
        assert.equal(x.fit.size(), 0, name);
      }
      const grow = rig(); // GROW: the grace is over but the page has been silent for more than LAPSE_MS
      await termLease(grow);
      grow.world.view('@1', 0);
      await step(grow, 1000); // awayAt
      grow.clock.t += 30_000; // no heartbeat for 30 s
      const at = grow.at();
      await grow.tick();
      assert.ok(grow.names(at).includes('untag'));
      assert.ok(!grow.names(at).includes('tag'));
      assert.equal(grow.fit.size(), 0);
      grow.world.view('@1', 0);
      assert.equal((await grow.put('%2', 220, 60, false)).body.fit.state, 'fitted', 'a lapse sets no mark');
    });
  });

  describe('the restore resizes back only a size nika set (R3, R9)', () => {
    test('(+) a terminal lease whose window the terminal resized: no resize-window, the option comes back, R9 logs nothing', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      await r.put('%4', 100, 30);
      r.world.view('@2', 1, [120, 40]); // the terminal resizes
      const at = r.at();
      assert.deepEqual(await r.fit.release('%4'), { status: 200, body: { released: true } });
      assert.deepEqual(r.names(at), ['list', 'layout', 'optUnset', 'untag', 'list']);
      assert.deepEqual(r.logs, []);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height], [120, 40]);
    });

    test('(−) a resized lease: the resize back is sent as before (also when the window\'s size is the original one the terminal asked for)', async () => {
      const r = rig();
      await r.put('%4', 100, 30);
      const at = r.at();
      await r.fit.release('%4');
      assert.deepEqual(sizesOf(r, at), ['-x 80 -y 24']);
      assert.deepEqual(r.logs, []);
    });

    test('(+) a renew that resizes a lease that only zoomed before: the restore sends the size back (sized is set where the resize happens)', async () => {
      const r = rig();
      await r.put('%2', 100, 30); // zoomed / panel-smaller: never resized
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('fitted', null, 240, 70, 3));
      const at = r.at();
      await r.fit.release('%2');
      assert.deepEqual(sizesOf(r, at), ['-x 200 -y 50']);
      assert.deepEqual([win(r).width, win(r).height], [200, 50]);
      assert.deepEqual(r.logs, []);
    });

    test('(−) a lease that comes from a file after a crash is taken for resized: its restore sends the resize back, even if the file says resized:false', async () => {
      const r = rig();
      const w = win(r);
      w.tag = '0123456789abcdef';
      w.width = 150; // not the original 200x50
      r.plant('fit-0123456789abcdef.json', goodFile({ resized: false, layout0: r.world.layoutOf(w), layout1: r.world.layoutOf(w) }));
      const out = await r.fit.recover();
      assert.deepEqual(out, { released: 1, dropped: 0 });
      assert.ok(r.names().includes('size'), 'R3 ran: sized is true for a lease read from a file');
    });

    test('(−) a zoomed lease (never resized) whose window the user resized: a user change, and the restore sends no resize-window (requirement changed: it used to resize back)', async () => {
      const r = rig();
      await r.put('%2', 100, 30);
      win(r).width = 180;
      const at = r.at();
      await r.tick();
      assert.equal(r.fit.size(), 0);
      assert.deepEqual(sizesOf(r, at), []);
      assert.deepEqual(r.logs, [], 'R9 does not call the user\'s size a difference of nika\'s restore');
      assert.equal(win(r).width, 180, 'the user\'s size is left alone');
      assert.equal((await r.put('%2', 100, 30, false)).body.fit.reason, 'user-change');
    });
  });

  describe('a page request meets the change before the watch', () => {
    test('(+) a terminal lease, a request with a new panel size: no lock, no tmux call but the listing; the size is kept for the grow', async () => {
      const r = rig();
      await termLease(r);
      const at = r.at();
      const locks = r.world.lockIds.length;
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(r.names(at), ['list']);
      assert.equal(r.world.lockIds.length, locks, 'no pane lock');
      r.world.view('@1', 0);
      await step(r, 1000, '%2', 240, 70);
      const grow = await step(r, GROW_MS, '%2', 240, 70);
      assert.deepEqual(sizesOf(r, 0).slice(-1), ['-x 240 -y 70'], 'the grow uses the newest panel');
      assert.deepEqual(grow, GROW_TICK, 'F9 (requirement changed, Q2): the grow is a take in place, not a release and a new acquire (no tag)');
    });

    test('(+) a terminal lease, the terminal is away within the grace: a request with a new size is answered terminal, nothing resized', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      await step(r, 1000);
      const at = r.at();
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(r.names(at), ['list']);
    });

    test('(+) a terminal lease, the grace is over and the watch has not run: the request gives the window back and fits it with the new panel in the same request', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      await step(r, 1000);
      r.clock.t += GROW_MS;
      await r.put('%2', 220, 60, false); // the page's heartbeat keeps the lease alive
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('fitted', null, 240, 70, 3));
      assert.deepEqual(sizesOf(r, 0).slice(-1), ['-x 240 -y 70']);
    });

    test('(+) an agent splits inside the grace and a request meets it before the watch: release and acquire in the same request, terminal, no resize', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      await step(r, 1000); // awayAt
      split(r);
      const at = r.at();
      assert.deepEqual(await r.put('%2', 240, 70, false), ans('terminal', null, 200, 50, 4));
      assert.deepEqual(sizesOf(r, at), []);
      assert.equal(r.fit.size(), 1);
    });

    test('(+) a resized lease, a terminal comes, and a request arrives before the watch: release and acquire in the same request, answered terminal', async () => {
      const r = rig();
      await r.put('%4', 100, 30);
      r.world.view('@2', 1, [90, 25]);
      const at = r.at();
      assert.deepEqual(await r.put('%4', 110, 35, false), ans('terminal', null, 90, 25, 1));
      assert.deepEqual(sizesOf(r, at), ['-x 80 -y 24'], 'the restore only; 110x35 is never set');
      assert.equal(r.fit.size(), 1);
    });

    test('(+) a growing renew of a zoomed lease; a terminal comes while it waits for the lock → no resize-window, terminal', async () => {
      const r = rig();
      const { fit, g } = gatedFit(r);
      await fit.hold('%2', { cols: 100, rows: 30, open: true }); // zoomed / panel-smaller
      g.shut();
      const at = r.at();
      const done = fit.hold('%2', { cols: 240, rows: 70, open: false }); // would resize to 240x70
      await until(() => g.waiting === 1);
      r.world.view('@1', 1, [200, 50]);
      g.open();
      assert.deepEqual(await done, ans('terminal', null, 200, 50, 3));
      assert.deepEqual(sizesOf(r, at), []);
      assert.equal(fit.size(), 1);
    });

    test('(+) a growing renew of a resized lease; a terminal comes while it waits → the new size is never set; the restore only, then terminal', async () => {
      const r = rig();
      const { fit, g } = gatedFit(r);
      await fit.hold('%4', { cols: 100, rows: 30, open: true });
      g.shut();
      const at = r.at();
      const done = fit.hold('%4', { cols: 110, rows: 35, open: false });
      await until(() => g.waiting === 1);
      r.world.view('@2', 1, [90, 25]);
      g.open();
      assert.deepEqual(await done, ans('terminal', null, 90, 25, 1));
      assert.deepEqual(sizesOf(r, at), ['-x 80 -y 24']);
    });

    test('(+) a terminal comes between the renew\'s resize and its read-back: given back, taken again without a resize, terminal', async () => {
      const r = rig();
      await r.put('%4', 100, 30);
      let n = 0;
      r.world.after = (name) => { if (name === 'size') { n += 1; if (n === 1) r.world.view('@2', 1, [110, 35]); } };
      const at = r.at();
      assert.deepEqual(await r.put('%4', 110, 35, false), ans('terminal', null, 110, 35, 1));
      assert.deepEqual(sizesOf(r, at), ['-x 110 -y 35', '-x 80 -y 24']);
      assert.equal(r.fit.size(), 1);
    });

    test('(−) a resized lease whose panel shrinks while the user changes the window during the lock wait: the restore sends nika\'s size back to W0 x H0 (sized), the user change is marked', async () => {
      const r = rig();
      const { fit, g } = gatedFit(r);
      await fit.hold('%2', { cols: 220, rows: 60, open: true });
      g.shut();
      const at = r.at();
      const done = fit.hold('%2', { cols: 100, rows: 30, open: false }); // plan: back to 200x50
      await until(() => g.waiting === 1);
      win(r).zoomed = false; // the user unzooms
      g.open();
      assert.equal((await done).body.fit.reason, 'user-change');
      assert.deepEqual(sizesOf(r, at), ['-x 200 -y 50']);
      assert.deepEqual([win(r).width, win(r).height], [200, 50]);
    });
  });

  describe('a DELETE that meets a refit (owner answer Q5)', () => {
    // (+) "a DELETE queued behind a refit releases the new lease" is the converted F2 test 'a DELETE queued behind a renew that refits ...'
    test('(+) between the refit\'s restore and its acquire: it waits for the refit, releases the new lease, and the note blocks the late heartbeat', async () => {
      const r = rig();
      await r.put('%2', 220, 60);
      split(r);
      let armed = false;
      let reached = false;
      let letGo;
      const gate = new Promise((res) => { letGo = res; });
      r.world.after = (name) => { if (name === 'untag') armed = true; };
      r.world.block = (name) => { if (armed && name === 'option') { armed = false; reached = true; return gate; } return undefined; };
      const t = r.tick(); // the refit: restored, now at the first read of the acquire
      await until(() => reached);
      assert.equal(r.fit.size(), 0, 'between the restore and the acquire the pane holds no lease');
      let settled = false;
      const del = r.fit.release('%2').then((x) => { settled = true; return x; });
      for (let i = 0; i < 20; i += 1) await new Promise((res) => setImmediate(res));
      assert.equal(settled, false, 'the DELETE waits behind the refit');
      r.world.block = null;
      letGo();
      assert.deepEqual((await del).body, { released: true });
      await t;
      assert.equal(r.fit.size(), 0, 'no lease is left');
      assert.equal(r.tag(), '');
      assert.deepEqual(r.files(), []);
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.reason, 'user-change', 'the note blocks the late heartbeat');
      r.clock.t += 2500;
      assert.equal((await r.put('%2', 220, 60, false)).body.fit.state, 'fitted');
    });

    test('(−) a pane with no lease and no queued operation of its own: released:false, no tmux call, no note (also while another pane of the window is busy)', async () => {
      const r = rig();
      assert.deepEqual(await r.fit.release('%2'), { status: 200, body: { released: false } });
      assert.deepEqual(r.world.calls, []);
      const { fit, g } = gatedFit(r);
      g.shut();
      const p = fit.hold('%2', { cols: 220, rows: 60, open: true }); // %2's acquire waits for the lock
      await until(() => g.waiting === 1);
      assert.deepEqual(await fit.release('%3'), { status: 200, body: { released: false } }, 'another pane of the same window');
      g.open();
      assert.equal((await p).body.fit.state, 'fitted');
      assert.equal(fit.size(), 1, 'the other pane\'s DELETE released nothing');
      assert.equal((await fit.hold('%2', { cols: 240, rows: 70, open: false })).body.fit.state, 'fitted', 'and set no note');
    });
  });

  describe('what is unchanged', () => {
    test('(−) the lease file keys are the old ones, and the memory fields (sized, awayAt, state, clients) are never written', async () => {
      const r = rig();
      const nonce = await termLease(r);
      assert.deepEqual(Object.keys(r.lease(nonce)), KEYS);
      r.world.view('@1', 0);
      await step(r, 1000);
      await step(r, GROW_MS); // grow: a new lease
      const text = fs.readFileSync(r.file(r.tag()), 'utf8');
      assert.deepEqual(Object.keys(JSON.parse(text)), KEYS);
      assert.ok(!text.match(/"sized"|awayAt|"state"|clients|"reason"/));
    });

    test('(+) a whole life with a terminal uses only the design section 4 argv shapes, and its listing is the 13-field format', async () => {
      const r = rig();
      await termLease(r);
      r.world.view('@1', 0);
      await step(r, 1000);
      await step(r, GROW_MS);
      r.world.view('@1', 1, [200, 50]);
      await step(r, 1000);
      await r.fit.release('%2');
      assert.ok(r.argv().every((a) => shape(a) !== null), 'every argv is one of the section 4 shapes');
      assert.ok(r.argv().filter((a) => a[0] === 'list-panes').every((a) => a.join(' ') === ['list-panes', '-a', '-F', FMT].join(' ')));
      assert.deepEqual(r.world.bad, []);
    });
  });
});

// ---- F9 (design-F9, nika 0.5): the focused window wins the pane's size; give and take in place -----------------------------------
// The page sends `focus`; while it has focus nika resizes the window even when a terminal shows it (the terminal shows dots). Every size
// switch is one in-place move: GIVE (`resize-window` back to the window's own size, then its `window-size` option back) and TAKE
// (`resize-window` to the panel). The lease, the tag and the zoom stay. `r.put(...)` sends no focus (= false); `r.putf(...)` sends it.
describe('F9: the focused window wins the pane\'s size (give and take in place)', () => {
  const win = (r, id = '@1') => r.world.wins.get(id);
  const sizesOf = (r, at) => r.argv(at).filter((a) => a[0] === 'resize-window').map((a) => a.slice(3).join(' '));
  const KEYS = ['v', 'nonce', 'window', 'pane', 'panes', 'zoomed0', 'active0', 'width0', 'height0', 'size0', 'layout0', 'layout1', 'cols', 'rows', 'resized', 'userZoom', 'at'];
  const FORBIDDEN = ['zoom', 'select', 'focus', 'untag', 'tag'];
  /** nothing that unzooms, zooms, relays out, moves focus or changes the tag */
  const inPlace = (r, at) => assert.deepEqual(r.names(at).filter((n) => FORBIDDEN.includes(n)), [], 'no zoom, relayout, refocus, tag or untag');
  /** a request or tick that gives: its own listing, the in-lock listing, the resize back, the option back, the read-back */
  const GIVE = ['list', 'list', 'size', 'optUnset', 'list', 'layout'];
  /** a request or tick that takes with a resize: its own listing, the in-lock listing, the option check, the resize, the read-back */
  const TAKE = ['list', 'list', 'option', 'size', 'list', 'layout'];
  /** What tmux does for `split-window` (without -Z) in a fitted window. */
  function split(r, id = '%9', role = 'agent') {
    const w = win(r);
    w.panes.push({ id, command: 'node', role });
    w.zoomed = false;
    r.world.setActive(w, id);
  }
  /** One pane @2 (80x24), a terminal of the window's size shows it, the page has focus and asks for 100x30 → fitted / terminal, window 100x30. */
  async function one() {
    const r = rig((w) => w.view('@2', 1, [80, 24]));
    assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1));
    return r;
  }
  /** Three panes @1 (200x50), a terminal shows it, the page has focus and asks for 220x60 → zoomed, resized, fitted / terminal. */
  async function three() {
    const r = rig((w) => w.view('@1', 1, [200, 50]));
    assert.deepEqual(await r.putf('%2', 220, 60, true), ans('fitted', 'terminal', 220, 60, 3));
    return r;
  }
  /** The page's heartbeat (same size, `focus`), `ms` after the last step, then one watch tick; → the names of the tmux calls the tick made. */
  async function step(r, ms, focus = false, pane = '%4', cols = 100, rows = 30) {
    r.clock.t += ms;
    await r.putf(pane, cols, rows, focus, false);
    const at = r.at();
    await r.tick();
    return r.names(at);
  }

  describe('acquire with focus', () => {
    test('(+) one pane, a terminal shows it, focus true: resized to the panel (size argv), fitted / terminal, the file says resized:true', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1));
      assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'size', 'list', 'layout']);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height, win(r, '@2').sizeOpt], [100, 30, 'manual']);
      const f = r.lease(r.tag('@2'));
      assert.deepEqual([f.resized, f.cols, f.rows, f.width0, f.height0], [true, 100, 30, 80, 24]);
    });

    // F15 (requirement change, owner decision 2026-11-16): the smaller panel is squeezed too while the page has focus; it used to stay zoomed / panel-smaller
    test('(+) three panes, a terminal, focus true: zoom and resize for a panel as big as the window, and (F15) for a smaller one too', async () => {
      const a = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await a.putf('%2', 220, 60, true), ans('fitted', 'terminal', 220, 60, 3));
      assert.deepEqual(a.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout']);
      assert.deepEqual([win(a).zoomed, win(a).width, win(a).height], [true, 220, 60]);
      const b = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await b.putf('%2', 100, 30, true), ans('fitted', 'terminal', 100, 30, 3));
      assert.deepEqual(b.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout']);
      assert.deepEqual([win(b).zoomed, win(b).width, win(b).height], [true, 100, 30]);
    });

    test('(−) focus false, or no focus key, with a terminal: terminal and no resize-window (F4)', async () => {
      for (const body of [{ cols: 100, rows: 30, open: true, focus: false }, { cols: 100, rows: 30, open: true }]) {
        const r = rig((w) => w.view('@2', 1, [80, 24]));
        assert.deepEqual(await r.fit.hold('%4', body), ans('terminal', null, 80, 24, 1), JSON.stringify(body));
        assert.deepEqual(sizesOf(r, 0), [], JSON.stringify(body));
        assert.equal(win(r, '@2').sizeOpt, null);
      }
    });

    test('(+) focus true, a terminal arrives while the acquire waits for the lock (the window keeps its size): still resized → fitted / terminal', async () => {
      const r = rig((w) => { w.wins.get('@2').sizeOpt = 'manual'; });
      const { fit, g } = gatedFit(r);
      g.shut();
      const p = fit.hold('%4', { cols: 100, rows: 30, open: true, focus: true });
      await until(() => g.waiting === 1);
      r.world.view('@2', 1, [80, 24]);
      g.open();
      assert.deepEqual(await p, ans('fitted', 'terminal', 100, 30, 1));
      assert.deepEqual(sizesOf(r, 0), ['-x 100 -y 30']);
    });

    test('(+) focus false, a terminal comes between the resize and the read-back: given back in this request (resize back, option off), one lease, terminal; no untag, zoom or layout', async () => {
      const r = rig();
      let n = 0;
      r.world.after = (name) => { if (name === 'size') { n += 1; if (n === 1) r.world.view('@2', 1, [100, 30]); } };
      assert.deepEqual(await r.putf('%4', 100, 30, false), ans('terminal', null, 100, 30, 1));
      assert.deepEqual(r.names(), [
        'list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'size', 'list', 'layout', // the acquire, A4, the read-back that sees the terminal
        'list', 'size', 'optUnset', 'list', 'layout', // given back in place: nika's size off, the window follows the terminal; read back
      ]);
      assert.deepEqual(sizesOf(r, 0), ['-x 100 -y 30', '-x 80 -y 24']);
      assert.deepEqual(r.names().slice(10).filter((n) => FORBIDDEN.includes(n)), [], 'the give runs no zoom, relayout, refocus, tag or untag');
      assert.equal(r.names().filter((x) => x === 'tag').length, 1, 'one acquire, no retry');
      assert.equal(r.fit.size(), 1);
      assert.equal(r.lease(r.tag('@2')).resized, false, 'the file describes the window as nika left it');
    });

    test('(−) the same with focus true: no give, fitted / terminal at the panel size', async () => {
      const r = rig();
      r.world.after = (name) => { if (name === 'size') r.world.view('@2', 1, [100, 30]); };
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1));
      assert.deepEqual(sizesOf(r, 0), ['-x 100 -y 30'], 'no resize back');
      assert.ok(!r.names().includes('optUnset'));
      assert.equal(r.lease(r.tag('@2')).resized, true);
    });
  });

  describe('a change of focus in a request', () => {
    test('(+) fitted (resized, focused) with a terminal, the page loses focus: in that request the size goes back to the terminal, in place (exact argv)', async () => {
      const r = await one();
      const nonce = r.tag('@2');
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, false), ans('terminal', null, 80, 24, 1));
      assert.deepEqual(r.names(at), GIVE);
      assert.deepEqual(r.argv(at).slice(2, 4), [['resize-window', '-t', '@2', '-x', '80', '-y', '24'], ['set-option', '-wu', '-t', '@2', 'window-size']]);
      assert.equal(r.tag('@2'), nonce, 'the lease and the tag stay');
      assert.equal(r.fit.size(), 1);
      assert.equal(r.lease(nonce).resized, false);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height, win(r, '@2').sizeOpt], [80, 24, null]);
      assert.deepEqual(r.logs, []);
    });

    test('(+) then focus again: in that request the size goes to the panel; width0/height0 in the file are the window\'s size just before this resize', async () => {
      const r = await one();
      await r.putf('%4', 100, 30, false);
      r.world.view('@2', 1, [90, 25]); // the terminal was resized meanwhile: the window follows it
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1));
      assert.deepEqual(r.names(at), TAKE);
      assert.deepEqual(sizesOf(r, at), ['-x 100 -y 30']);
      const f = r.lease(r.tag('@2'));
      assert.deepEqual([f.width0, f.height0, f.resized], [90, 25, true]);
      assert.deepEqual(r.logs, []);
    });

    test('(+) three panes: give and take never unzoom, zoom, relay out, refocus, tag or untag; the pane stays zoomed', async () => {
      const r = await three();
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 220, 60, false), ans('terminal', null, 200, 50, 3));
      assert.equal(win(r).zoomed, true);
      assert.deepEqual(await r.putf('%2', 220, 60, true), ans('fitted', 'terminal', 220, 60, 3));
      assert.equal(win(r).zoomed, true);
      assert.deepEqual(r.names(at), [...GIVE, ...TAKE]);
      inPlace(r, at);
      assert.equal(win(r).active, '%2');
    });

    test('(−) focus false with no terminal: no tmux call but the listing, and the window stays fitted', async () => {
      const r = rig();
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', null, 100, 30, 1));
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, false), ans('fitted', null, 100, 30, 1));
      assert.deepEqual(r.names(at), ['list']);
      assert.equal(win(r, '@2').width, 100);
    });

    test('(−) a heartbeat at the same size and the same focus is answered from memory; the same size with the focus flipped is not', async () => {
      const r = await one();
      let at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, true, false), ans('fitted', 'terminal', 100, 30, 1));
      assert.equal(r.at(), at, 'no tmux call');
      assert.deepEqual(await r.putf('%4', 100, 30, false, false), ans('terminal', null, 80, 24, 1));
      assert.notEqual(r.at(), at, 'not the fast path');
      at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, false, false), ans('terminal', null, 80, 24, 1));
      assert.equal(r.at(), at, 'the same focus again: the fast path');
    });

    test('(+) a blur refused at the pane lock (409 busy): the focus was recorded first, so the next tick gives', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      const { fit, gate } = busyRig(r);
      await fit.hold('%4', { cols: 100, rows: 30, open: true, focus: true });
      gate.busy = true;
      assert.deepEqual(await fit.hold('%4', { cols: 100, rows: 30, open: false, focus: false }), BUSY);
      assert.equal(fit.size(), 1);
      assert.equal(win(r, '@2').width, 100, 'nothing changed yet');
      gate.busy = false;
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), GIVE);
      assert.equal(win(r, '@2').width, 80);
    });

    test('(+) a take that finds a window-size the user set while nika held none: released with the user-change mark', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      assert.deepEqual(await r.putf('%4', 100, 30, false), ans('terminal', null, 80, 24, 1));
      win(r, '@2').sizeOpt = 'manual'; // the user
      const res = await r.putf('%4', 100, 30, true);
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'user-change']);
      assert.equal(r.fit.size(), 0);
      assert.equal(r.tag('@2'), '');
      assert.deepEqual(sizesOf(r, 0), [], 'nika sized nothing');
      assert.equal((await r.putf('%4', 100, 30, false, false)).body.fit.reason, 'user-change', 'the mark');
    });

    // F15 (requirement change, owner decision 2026-11-16): a focused page squeezes a smaller panel, so a focused lease that was never resized has the panel of the
    // window's size (200x50 here); the tests below used a 100x30 panel, which is now a squeeze (see the F15 describe at the end of this file)
    test('(+) a focused lease that was never resized (the panel is as big as the window): the terminal shrinks the window → the next tick takes, resized, fitted / terminal', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await r.putf('%2', 200, 50, true), ans('fitted', 'terminal', 200, 50, 3));
      r.world.view('@1', 1, [190, 45]); // the window (not manual) follows
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), TAKE);
      inPlace(r, at);
      assert.deepEqual(await r.putf('%2', 200, 50, true, false), ans('fitted', 'terminal', 200, 50, 3));
      assert.equal(r.lease(r.tag()).width0, 190);
    });

    test('(+) F15: a take with a panel smaller than the window (several panes) squeezes it: fitted / terminal, the layout read inside the lock before the resize', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await r.put('%2', 100, 30), ans('terminal', null, 200, 50, 3));
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('fitted', 'terminal', 100, 30, 3));
      assert.deepEqual(r.names(at), ['list', 'list', 'option', 'layout', 'size', 'list', 'layout']);
      assert.deepEqual(sizesOf(r, at), ['-x 100 -y 30']);
    });

    test('(+) a focused lease that was never resized, the page loses focus while a terminal shows the window: terminal, memory only (no tmux call but the listing)', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await r.putf('%2', 200, 50, true), ans('fitted', 'terminal', 200, 50, 3));
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 200, 50, false), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(r.names(at), ['list']);
    });

    test('(−) the user unzooms before a focus change reaches the lease: user-change (W7 Q6), no take and no give', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await r.putf('%2', 220, 60, false), ans('terminal', null, 200, 50, 3));
      win(r).zoomed = false;
      const at = r.at();
      const res = await r.putf('%2', 220, 60, true);
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'user-change']);
      assert.ok(!r.names(at).includes('option'), 'no take was tried');
      assert.deepEqual(sizesOf(r, at), []);
      const g = await three();
      win(g).zoomed = false;
      const at2 = g.at();
      assert.equal((await g.putf('%2', 220, 60, false)).body.fit.reason, 'user-change');
      assert.deepEqual(sizesOf(g, at2).slice(0, 1), ['-x 200 -y 50'], 'only the restore: no give of its own');
    });

    test('(−) only the page that holds the lease sets its focus: another pane asking with focus true gets other and changes nothing', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await r.putf('%2', 220, 60, false), ans('terminal', null, 200, 50, 3));
      const at = r.at();
      assert.equal((await r.putf('%3', 220, 60, true, false)).body.fit.state, 'other');
      await r.tick();
      assert.deepEqual(sizesOf(r, at), []);
      assert.deepEqual(await r.putf('%2', 220, 60, false, false), ans('terminal', null, 200, 50, 3));
    });

    test('(+) a take of a lease nika sized earlier (renewed back to the original size, then a terminal came): the option nika set is not a user change', async () => {
      const r = rig();
      assert.deepEqual(await r.put('%4', 100, 30), ans('fitted', null, 100, 30, 1)); // unfocused, no terminal: resized, sized
      assert.deepEqual(await r.put('%4', 80, 24, false), ans('fitted', null, 80, 24, 1)); // renewed back to the original size: resized false, sized true, option manual
      r.world.view('@2', 1, [80, 24]); // a terminal comes: VIEW at the next tick
      await r.tick();
      assert.deepEqual(await r.put('%4', 80, 24, false), ans('terminal', null, 80, 24, 1));
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 90, 30, true), ans('fitted', 'terminal', 90, 30, 1));
      assert.deepEqual(sizesOf(r, at), ['-x 90 -y 30']);
      assert.equal(r.lease(r.tag('@2')).width0, 80, 'the window\'s own size is kept: nika\'s manual size is not it');
      assert.deepEqual(r.logs, []);
      const back = r.at();
      await r.fit.release('%4');
      assert.deepEqual(sizesOf(r, back), ['-x 80 -y 24']);
    });

    test('(+) the focus and the panel size change in one request: a give is not a user change and keeps the new size for the next take; a take uses the size of its own request', async () => {
      const r = await one();
      assert.deepEqual(await r.putf('%4', 110, 35, false), ans('terminal', null, 80, 24, 1));
      assert.equal(r.fit.size(), 1, 'the lease stays: the window was looked at against the size it held');
      assert.deepEqual(r.logs, []);
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 120, 40, true), ans('fitted', 'terminal', 120, 40, 1));
      assert.deepEqual(sizesOf(r, at), ['-x 120 -y 40']);
      const t = r.at();
      await r.putf('%4', 120, 40, false); // and the size it gave with is the one a later take (the watch, say) plans with
      await r.putf('%4', 130, 45, false, false);
      assert.deepEqual(await r.putf('%4', 130, 45, true), ans('fitted', 'terminal', 130, 45, 1));
      assert.deepEqual(sizesOf(r, t).slice(-1), ['-x 130 -y 45']);
    });

    test('(+) N1: the terminal shrinks the window of a focused lease that was never resized while a renew with a bigger panel waits for the lock → no resize in that turn; the take of this same request uses the new window size and the new panel', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      const { fit, g } = gatedFit(r);
      assert.deepEqual(await fit.hold('%2', { cols: 200, rows: 50, open: true, focus: true }), ans('fitted', 'terminal', 200, 50, 3));
      g.shut();
      const at = r.at();
      const done = fit.hold('%2', { cols: 230, rows: 60, open: false, focus: true }); // would resize to 230x60
      await until(() => g.waiting === 1);
      r.world.view('@1', 1, [210, 55]);
      g.open();
      assert.deepEqual(await done, ans('fitted', 'terminal', 230, 60, 3));
      assert.deepEqual(sizesOf(r, at), ['-x 230 -y 60'], 'one resize, taken against the window as it is now');
      assert.equal(fit.size(), 1);
      assert.equal(r.lease(r.tag()).width0, 210);
    });

    test('(−) the user unzooms in the same tick as a blur that the lock refused: user-change, no give', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      const { fit, gate } = busyRig(r);
      assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: true, focus: true }), ans('fitted', 'terminal', 220, 60, 3));
      gate.busy = true;
      assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: false, focus: false }), BUSY);
      gate.busy = false;
      win(r).zoomed = false;
      const at = r.at();
      await r.tick();
      assert.equal(fit.size(), 0);
      assert.deepEqual(sizesOf(r, at), ['-x 200 -y 50'], 'only the restore: no give of its own');
      assert.equal((await fit.hold('%2', { cols: 220, rows: 60, open: false, focus: false })).body.fit.reason, 'user-change');
    });
  });

  describe('the cap: at most 12 focus takes per window in 60 s', () => {
    /** Twelve blur/focus cycles, a second apart; → the time of the first and of the last focus take. */
    async function twelve(r) {
      const t0 = r.clock.t;
      for (let i = 0; i < 12; i += 1) {
        r.clock.t = t0 + 1000 * (2 * i + 1);
        await r.putf('%4', 100, 30, false);
        r.clock.t = t0 + 1000 * (2 * i + 2);
        assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1), `take ${i + 1}`);
      }
      return { t0, first: t0 + 2000, last: t0 + 24000 };
    }

    test('(+) after 12 takes the 13th focus is terminal / switching and sends no resize; at first + 60 s the watch takes', async () => {
      const r = await one();
      const { t0, first } = await twelve(r);
      r.clock.t = t0 + 25000;
      await r.putf('%4', 100, 30, false); // the give is never limited
      r.clock.t = t0 + 26000;
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('terminal', 'switching', 80, 24, 1));
      assert.deepEqual(r.names(at), ['list'], 'no lock, no resize');
      for (const t of [t0 + 36000, t0 + 46000, t0 + 56000, first + 59999]) {
        r.clock.t = t;
        await r.putf('%4', 100, 30, true, false); // the heartbeat keeps the lease
        const mark = r.at();
        await r.tick();
        assert.deepEqual(r.names(mark), ['list'], `the watch waits at ${t - first} ms after the first take`);
      }
      assert.deepEqual(await r.putf('%4', 100, 30, true, false), ans('terminal', 'switching', 80, 24, 1), 'a heartbeat says why');
      r.clock.t = first + 60000;
      await r.putf('%4', 100, 30, true, false);
      const mark = r.at();
      await r.tick();
      assert.deepEqual(r.names(mark), TAKE, 'the minute is free: the watch takes');
      assert.deepEqual(await r.putf('%4', 100, 30, true, false), ans('fitted', 'terminal', 100, 30, 1));
    });

    test('(−) the give is never capped: with 12 takes in the minute a blur still gives at once', async () => {
      const r = await one();
      await twelve(r);
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, false), ans('terminal', null, 80, 24, 1));
      assert.deepEqual(r.names(at), GIVE);
    });

    test('(−) switching is said only to a page with focus: after the cap, a blur answers terminal with no reason', async () => {
      const r = await one();
      const { t0 } = await twelve(r);
      r.clock.t = t0 + 25000;
      await r.putf('%4', 100, 30, false);
      r.clock.t = t0 + 26000;
      assert.equal((await r.putf('%4', 100, 30, true)).body.fit.reason, 'switching');
      assert.deepEqual(await r.putf('%4', 100, 30, false), ans('terminal', null, 80, 24, 1));
      assert.deepEqual(await r.putf('%4', 100, 30, false, false), ans('terminal', null, 80, 24, 1), 'also from the heartbeat');
    });

    test('(−) the acquire, a renew to a new panel size and the unfocused grow are not takes: 12 of them, then the first focus take is not capped', async () => {
      const r = await one(); // the acquire
      for (let i = 1; i <= 12; i += 1) assert.equal((await r.putf('%4', 100 + i, 30, true, false)).body.fit.state, 'fitted'); // 12 renews that resize
      await r.putf('%4', 112, 30, false, false);
      assert.deepEqual(await r.putf('%4', 112, 30, true, false), ans('fitted', 'terminal', 112, 30, 1), 'not capped');
      // 13 unfocused grows on another rig
      const g = rig();
      assert.equal((await g.put('%4', 100, 30)).body.fit.state, 'fitted');
      for (let i = 0; i < 13; i += 1) {
        g.world.view('@2', 1, [80, 24]);
        assert.deepEqual(await step(g, 1000), GIVE, `give ${i + 1}`); // the terminal comes: a give in place
        g.world.view('@2', 0);
        await step(g, 1000); // away
        const grow = await step(g, GROW_MS);
        assert.deepEqual(grow, TAKE, `grow ${i + 1}`);
      }
      g.world.view('@2', 1, [80, 24]);
      await step(g, 1000); // give
      assert.deepEqual(await g.putf('%4', 100, 30, true, false), ans('fitted', 'terminal', 100, 30, 1), 'the unfocused grows were not counted');
    });

    test('(+) a focused lease held back by the cap (terminal / switching) meets an agent split: the refit resizes (a focused page never keeps the terminal form)', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await r.putf('%2', 220, 60, true), ans('fitted', 'terminal', 220, 60, 3));
      const t0 = r.clock.t;
      for (let i = 0; i < 12; i += 1) { // twelve takes in the minute
        r.clock.t = t0 + 1000 * (2 * i + 1);
        await r.putf('%2', 220, 60, false);
        r.clock.t = t0 + 1000 * (2 * i + 2);
        assert.equal((await r.putf('%2', 220, 60, true)).body.fit.state, 'fitted');
      }
      r.clock.t = t0 + 25000;
      await r.putf('%2', 220, 60, false);
      r.clock.t = t0 + 26000;
      assert.deepEqual(await r.putf('%2', 220, 60, true), ans('terminal', 'switching', 200, 50, 3));
      split(r);
      const at = r.at();
      await r.tick();
      assert.deepEqual(sizesOf(r, at).slice(-1), ['-x 220 -y 60'], 'the refit resized');
      assert.deepEqual(await r.putf('%2', 220, 60, true, false), ans('fitted', 'terminal', 220, 60, 4));
    });

    test('(−) the cap is per window and keeps at most 64 windows: the oldest is forgotten first', async () => {
      const r = rig((w) => {
        w.view('@2', 1, [80, 24]);
        for (let n = 10; n < 74; n += 1) { w.add(`@${n}`, [[`%${n}`, 'claude']], 80, 24); w.view(`@${n}`, 1, [80, 24]); }
      });
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1));
      await twelve(r);
      r.clock.t += 1000;
      await r.putf('%4', 100, 30, false);
      assert.equal((await r.putf('%4', 100, 30, true)).body.fit.reason, 'switching', 'window @2 is capped');
      for (let n = 10; n < 74; n += 1) { // 64 other windows, one take each: 65 windows are asked about
        const id = `%${n}`;
        assert.equal((await r.putf(id, 100, 30, true)).body.fit.state, 'fitted', id);
        await r.putf(id, 100, 30, false);
        assert.deepEqual(await r.putf(id, 100, 30, true), ans('fitted', 'terminal', 100, 30, 1), `${id}: another window is not capped`);
      }
      await r.putf('%4', 100, 30, false);
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1), '@2 was dropped from the 64: forgotten');
    });

    test('(−) only focus takes count: 11 focus takes and one unfocused grow in the minute, then the 12th focus take is not capped', async () => {
      const r = await one();
      const t0 = r.clock.t;
      for (let i = 0; i < 11; i += 1) {
        r.clock.t = t0 + 1000 * (2 * i + 1);
        await r.putf('%4', 100, 30, false);
        r.clock.t = t0 + 1000 * (2 * i + 2);
        assert.equal((await r.putf('%4', 100, 30, true)).body.fit.state, 'fitted', `take ${i + 1}`);
      }
      r.clock.t = t0 + 23000;
      await r.putf('%4', 100, 30, false); // give
      r.world.view('@2', 0);
      await step(r, 1000); // away
      assert.deepEqual(await step(r, GROW_MS), TAKE, 'the unfocused grow resizes (at 54 s)');
      r.world.view('@2', 1, [80, 24]);
      assert.deepEqual(await step(r, 1000), GIVE);
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1), 'the 12th focus take: the grow did not count');
    });

    test('(−) the 64 windows are kept by recency: a window that takes again is the newest, the one quiet longest is forgotten first', async () => {
      const r = rig((w) => {
        w.view('@2', 1, [80, 24]);
        for (let n = 10; n < 74; n += 1) { w.add(`@${n}`, [[`%${n}`, 'claude']], 80, 24); w.view(`@${n}`, 1, [80, 24]); }
      });
      const open = async (id) => assert.equal((await r.putf(id, 100, 30, true)).body.fit.state, 'fitted', id); // the acquire: not a take
      const cycle = async (id) => { // one take
        await r.putf(id, 100, 30, false);
        assert.equal((await r.putf(id, 100, 30, true)).body.fit.state, 'fitted', id);
      };
      await open('%4'); // the first window remembered: @2
      for (let i = 0; i < 11; i += 1) { r.clock.t += 1000; await cycle('%4'); }
      await open('%10'); // the second: @10, capped after 12 takes
      for (let i = 0; i < 12; i += 1) { r.clock.t += 1000; await cycle('%10'); }
      for (let n = 11; n < 73; n += 1) { await open(`%${n}`); await cycle(`%${n}`); } // 62 more: 64 windows are remembered
      r.clock.t += 1000;
      await cycle('%4'); // @2 takes the 12th time: it is the newest now, and capped
      await open('%73');
      await cycle('%73'); // the 65th window: @10 (quiet longest), not @2 (first noted), is forgotten
      await r.putf('%10', 100, 30, false);
      assert.deepEqual(await r.putf('%10', 100, 30, true), ans('fitted', 'terminal', 100, 30, 1), '@10 was forgotten: its 12 takes do not count');
      await r.putf('%4', 100, 30, false);
      assert.equal((await r.putf('%4', 100, 30, true)).body.fit.reason, 'switching', '@2 is remembered: 12 takes');
    });

    test('(+) a take held back by the cap keeps the page\'s newest size: when the minute frees up the watch takes with it', async () => {
      const r = await one();
      const { t0, first } = await twelve(r);
      r.clock.t = t0 + 25000;
      await r.putf('%4', 100, 30, false);
      r.clock.t = t0 + 26000;
      assert.deepEqual(await r.putf('%4', 120, 40, true), ans('terminal', 'switching', 80, 24, 1));
      r.clock.t = first + 60000;
      await r.putf('%4', 120, 40, true, false); // the heartbeat at the newest size: nothing to ask tmux
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), TAKE);
      assert.deepEqual(sizesOf(r, at), ['-x 120 -y 40']);
    });

    test('(+) the watch under the cap says why: a focus the request could not carry (its listing failed) is taken up by the tick; the next heartbeat answers terminal / switching from memory', async () => {
      const r = await one();
      const { t0 } = await twelve(r);
      r.clock.t = t0 + 25000;
      await r.putf('%4', 100, 30, false);
      r.clock.t = t0 + 26000;
      r.world.fail = (name) => name === 'list';
      assert.equal((await r.putf('%4', 100, 30, true)).status, 502); // the focus was recorded before the listing failed
      r.world.fail = null;
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), ['list'], 'capped: no resize, no lock');
      assert.deepEqual(await r.putf('%4', 100, 30, true, false), ans('terminal', 'switching', 80, 24, 1));
    });
  });

  describe('the watch', () => {
    test('(+) a focused terminal lease inside its 30 s grace (the terminal is away): the next tick takes, no waiting', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      const { fit, gate } = busyRig(r);
      assert.deepEqual(await fit.hold('%4', { cols: 100, rows: 30, open: true, focus: false }), ans('terminal', null, 80, 24, 1));
      r.world.view('@2', 0);
      r.clock.t += 1000;
      await r.tick(); // away: the grace starts
      gate.busy = true;
      assert.deepEqual(await fit.hold('%4', { cols: 100, rows: 30, open: false, focus: true }), BUSY, 'the take is refused, the focus is recorded');
      gate.busy = false;
      r.clock.t += 1000;
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), TAKE);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height], [100, 30]);
    });

    test('(+) an unfocused fitted (resized) lease, a terminal comes: the next tick gives in place (exact argv), no mark, the lease stays', async () => {
      for (const [id, pane, cols, rows, size, panes] of [['@2', '%4', 100, 30, [90, 25], 1], ['@1', '%2', 220, 60, [200, 50], 3]]) {
        const r = rig();
        await r.put(pane, cols, rows);
        const nonce = r.tag(id);
        r.world.view(id, 1, size); // manual: the window keeps the panel's size for now
        const at = r.at();
        await r.tick();
        assert.deepEqual(r.names(at), GIVE, id);
        inPlace(r, at);
        assert.deepEqual([win(r, id).width, win(r, id).height, win(r, id).sizeOpt], [...size, null], id);
        assert.equal(r.tag(id), nonce, 'the same lease');
        assert.deepEqual(r.logs, []);
        assert.deepEqual(await r.put(pane, cols, rows, false), ans('terminal', null, size[0], size[1], panes), id);
      }
    });

    test('(+) an unfocused terminal lease, no terminal for GROW_MS: the watch takes in place (exact argv), the same lease, not counted', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      await r.put('%2', 220, 60);
      const nonce = r.tag();
      r.world.view('@1', 0);
      assert.deepEqual(await step(r, 1000, false, '%2', 220, 60), ['list']);
      assert.deepEqual(await step(r, GROW_MS - 1, false, '%2', 220, 60), ['list']);
      const grow = await step(r, 1, false, '%2', 220, 60);
      assert.deepEqual(grow, TAKE);
      assert.ok(!grow.some((n) => FORBIDDEN.includes(n)));
      assert.equal(r.tag(), nonce, 'the same lease');
      assert.deepEqual([win(r).width, win(r).height, win(r).zoomed], [220, 60, true]);
      assert.deepEqual(await r.put('%2', 220, 60, false), ans('fitted', null, 220, 60, 3));
    });

    test('(−) a focused fitted (resized) lease with a terminal: no tmux call but the listing for ten ticks', async () => {
      const r = await three();
      for (let i = 0; i < 10; i += 1) assert.deepEqual(await step(r, 1000, true, '%2', 220, 60), ['list'], `tick ${i + 1}`);
      assert.deepEqual(await r.putf('%2', 220, 60, true, false), ans('fitted', 'terminal', 220, 60, 3));
    });

    test('(−) a lapsed lease (more than LAPSE_MS without a heartbeat) with a give or a take pending is only released: no give, no take, no mark', async () => {
      const g = rig();
      await g.put('%4', 100, 30);
      g.world.view('@2', 1, [90, 25]); // a give is due
      const t = rig((w) => w.view('@2', 1, [80, 24]));
      await t.put('%4', 100, 30); // terminal
      t.world.view('@2', 0);
      await step(t, 1000);
      for (const [name, x, pend] of [['give', g, 0], ['take', t, GROW_MS]]) {
        x.clock.t += LAPSE_MS + 1 + pend;
        const at = x.at();
        await x.tick();
        assert.ok(x.names(at).includes('untag'), name);
        assert.ok(!x.names(at).includes('option'), `${name}: no take`);
        assert.equal(x.fit.size(), 0, name);
        assert.equal(x.tag('@2'), '', name);
      }
      g.world.view('@2', 0);
      assert.equal((await g.put('%4', 100, 30, false)).body.fit.state, 'fitted', 'a lapse sets no mark');
    });

    test('(−) a give that fails in tmux: one log line, the lease is released with no mark, no second attempt', async () => {
      const r = rig();
      await r.put('%4', 100, 30);
      r.world.view('@2', 1, [90, 25]);
      let n = 0;
      r.world.fail = (name) => name === 'size' && (n += 1) === 1; // the give's resize back fails once
      await r.tick();
      assert.deepEqual(r.logs.filter((l) => /^nika: fit @2 %4 give failed \(\w+\)$/.test(l)).length, 1, JSON.stringify(r.logs));
      assert.equal(r.fit.size(), 0);
      assert.equal(r.tag('@2'), '');
      assert.deepEqual(r.files(), []);
      assert.equal(n, 2, 'the restore\'s own resize back, no third: nothing was tried again');
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), []);
      assert.notEqual((await r.put('%4', 100, 30, false)).body.fit.state, 'blocked', 'no mark');
    });

    test('(−) a take that fails in tmux: one log line, the lease is released with no mark, no second attempt', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      await r.put('%4', 100, 30); // terminal
      r.world.view('@2', 0);
      await step(r, 1000);
      r.world.fail = (name) => name === 'size';
      r.clock.t += GROW_MS;
      await r.put('%4', 100, 30, false);
      await r.tick();
      assert.equal(r.logs.filter((l) => /^nika: fit @2 %4 take failed \(\w+\)$/.test(l)).length, 1, JSON.stringify(r.logs));
      assert.equal(r.fit.size(), 0);
      assert.equal(r.tag('@2'), '');
      r.world.fail = null;
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), []);
      assert.equal((await r.put('%4', 100, 30, false)).body.fit.state, 'fitted', 'no mark');
    });

    test('(−) a give or a take that finds the pane busy keeps the lease; the next tick tries again', async () => {
      const g = rig();
      const gb = busyRig(g);
      await gb.fit.hold('%4', { cols: 100, rows: 30, open: true });
      g.world.view('@2', 1, [90, 25]);
      gb.gate.busy = true;
      await g.tick();
      assert.equal(gb.fit.size(), 1, 'kept');
      assert.equal(g.logs.filter((l) => /give failed \(EPANEBUSY\)/.test(l)).length, 1);
      gb.gate.busy = false;
      const at = g.at();
      await g.tick();
      assert.deepEqual(g.names(at), GIVE);
      const t = rig((w) => w.view('@2', 1, [80, 24]));
      const tb = busyRig(t);
      await tb.fit.hold('%4', { cols: 100, rows: 30, open: true });
      t.world.view('@2', 0);
      t.clock.t += 1000;
      await t.tick();
      t.clock.t += GROW_MS;
      await tb.fit.hold('%4', { cols: 100, rows: 30, open: false });
      tb.gate.busy = true;
      await t.tick();
      assert.equal(tb.fit.size(), 1, 'kept');
      assert.equal(t.logs.filter((l) => /take failed \(EPANEBUSY\)/.test(l)).length, 1);
      tb.gate.busy = false;
      const at2 = t.at();
      await t.tick();
      assert.deepEqual(t.names(at2), TAKE);
    });

    test('(+) F2: an agent splits a focused, resized window a terminal shows → the refit lands fitted / terminal with a resize; unfocused it lands terminal with none', async () => {
      const a = await three();
      split(a);
      const at = a.at();
      await a.tick();
      assert.deepEqual(sizesOf(a, at), ['-x 200 -y 50', '-x 220 -y 60'], 'the restore, then the fit');
      assert.deepEqual(await a.putf('%2', 220, 60, true, false), ans('fitted', 'terminal', 220, 60, 4));
      const b = rig((w) => w.view('@1', 1, [200, 50]));
      assert.deepEqual(await b.putf('%2', 220, 60, false), ans('terminal', null, 200, 50, 3));
      split(b);
      const at2 = b.at();
      await b.tick();
      assert.deepEqual(sizesOf(b, at2), []);
      assert.deepEqual(await b.putf('%2', 220, 60, false, false), ans('terminal', null, 200, 50, 4));
    });

    test('(+) a DELETE queued behind a give, and behind a take, releases the lease at its turn', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      const { fit, g } = gatedFit(r);
      await fit.hold('%4', { cols: 100, rows: 30, open: true, focus: true });
      g.shut();
      const put = fit.hold('%4', { cols: 100, rows: 30, open: false, focus: false }); // the give waits in the pane lock
      await until(() => g.waiting === 1);
      const del = fit.release('%4');
      g.open();
      assert.equal((await put).body.fit.state, 'terminal');
      assert.deepEqual((await del).body, { released: true });
      assert.equal(fit.size(), 0);
      assert.equal(r.tag('@2'), '');
      assert.deepEqual(r.files(), []);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height], [80, 24]);
      const t = rig((w) => w.view('@2', 1, [80, 24]));
      const x = gatedFit(t);
      await x.fit.hold('%4', { cols: 100, rows: 30, open: true, focus: false }); // terminal
      x.g.shut();
      const put2 = x.fit.hold('%4', { cols: 100, rows: 30, open: false, focus: true }); // the take waits
      await until(() => x.g.waiting === 1);
      const del2 = x.fit.release('%4');
      x.g.open();
      assert.equal((await put2).body.fit.state, 'fitted');
      assert.deepEqual((await del2).body, { released: true });
      assert.equal(x.fit.size(), 0);
      assert.equal(t.tag('@2'), '');
      assert.deepEqual([win(t, '@2').width, win(t, '@2').height], [80, 24], 'the window is back at its size');
    });
  });

  describe('the restore after a give or a take', () => {
    test('(+) closing after a give: no resize-window back (nika holds no size), the option is unset, R9 is silent', async () => {
      const r = await three();
      await r.putf('%2', 220, 60, false);
      const at = r.at();
      assert.deepEqual(await r.fit.release('%2'), { status: 200, body: { released: true } });
      assert.deepEqual(sizesOf(r, at), []);
      assert.ok(r.names(at).includes('optUnset'));
      assert.deepEqual(r.logs, []);
      assert.equal(r.tag(), '');
    });

    test('(+) closing after a take: the resize back goes to the window size the take saw, then the option; R9 is silent while the terminal shows the window', async () => {
      const r = await one();
      await r.putf('%4', 100, 30, false);
      r.world.view('@2', 1, [90, 25]);
      await r.putf('%4', 100, 30, true); // take
      const at = r.at();
      assert.deepEqual(await r.fit.release('%4'), { status: 200, body: { released: true } });
      assert.deepEqual(sizesOf(r, at), ['-x 90 -y 25']);
      assert.ok(r.names(at).indexOf('size') < r.names(at).indexOf('optUnset'), 'the resize back first, then the option');
      assert.deepEqual(r.logs, []);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height, win(r, '@2').sizeOpt], [90, 25, null]);
    });

    test('(−) a lease that comes from a file after a crash: the resize back goes to the file\'s width0/height0, whatever the lease did since', async () => {
      const r = rig();
      const w = win(r);
      w.tag = '0123456789abcdef';
      w.width = 150;
      r.plant('fit-0123456789abcdef.json', goodFile({ width0: 160, height0: 45, layout0: r.world.layoutOf(w), layout1: r.world.layoutOf(w) }));
      assert.deepEqual(await r.fit.recover(), { released: 1, dropped: 0 });
      assert.deepEqual(sizesOf(r, 0), ['-x 160 -y 45']);
    });
  });

  describe('answers and guards', () => {
    test('(+) fitted with a terminal says reason terminal, also from the heartbeat fast path once the watch saw the terminal; (−) without a terminal the reason is null', async () => {
      const r = rig();
      assert.deepEqual(await r.putf('%4', 100, 30, true), ans('fitted', null, 100, 30, 1));
      r.world.view('@2', 1, [80, 24]); // manual: the window keeps 100x30
      const seen = r.at();
      await r.tick(); // the watch refreshes what it knows about the terminal, and does nothing else: the focused page keeps the size
      assert.deepEqual(r.names(seen), ['list']);
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, true, false), ans('fitted', 'terminal', 100, 30, 1));
      assert.equal(r.at(), at, 'answered from memory');
      r.world.view('@2', 0);
      await r.tick();
      assert.deepEqual(await r.putf('%4', 100, 30, true, false), ans('fitted', null, 100, 30, 1));
    });

    test('(−) the lease file keeps its keys, and focus, viewed and the takes are never written', async () => {
      const r = await one();
      await r.putf('%4', 100, 30, false);
      for (const f of [false, true]) {
        const text = fs.readFileSync(r.file(r.tag('@2')), 'utf8');
        assert.deepEqual(Object.keys(JSON.parse(text)), KEYS, `focus ${f}`);
        assert.ok(!text.match(/focus|viewed|takes|"sized"|awayAt|"state"/), text);
        await r.putf('%4', 100, 30, true);
      }
    });

    test('(+) a whole life with give, take and the cap uses only the design section 4 argv shapes and the 13-field listing', async () => {
      const r = await three();
      await r.putf('%2', 220, 60, false);
      await r.putf('%2', 220, 60, true);
      split(r);
      await r.tick();
      await r.fit.release('%2');
      assert.ok(r.argv().every((a) => shape(a) !== null));
      assert.ok(r.argv().filter((a) => a[0] === 'list-panes').every((a) => a.join(' ') === ['list-panes', '-a', '-F', FMT].join(' ')));
      assert.deepEqual(r.world.bad, []);
    });
  });

  describe('what the move looks at again, what it keeps, and how it fails', () => {
    test('(−) closing a lease nika resized while a terminal of another size shows the window: R9 does not compare the size (the window follows that terminal)', async () => {
      const r = rig();
      await r.put('%4', 100, 30); // fitted, resized, width0 80x24
      r.world.view('@2', 1, [90, 25]); // manual: still 100x30, no tick yet
      assert.deepEqual(await r.fit.release('%4'), { status: 200, body: { released: true } });
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height, win(r, '@2').sizeOpt], [90, 25, null]);
      assert.deepEqual(r.logs, []);
    });

    test('(+) the focus comes to a fitted window a terminal came to meanwhile (no tick yet): the request refreshes what it knows → fitted / terminal, no tmux change', async () => {
      const r = rig();
      assert.deepEqual(await r.putf('%4', 100, 30, false), ans('fitted', null, 100, 30, 1));
      r.world.view('@2', 1, [80, 24]); // manual: keeps 100x30
      const at = r.at();
      assert.deepEqual(await r.putf('%4', 100, 30, true, false), ans('fitted', 'terminal', 100, 30, 1));
      assert.deepEqual(r.names(at), ['list']);
    });

    test('(+) a give in a request with a new panel size: the lease file describes the window with that size', async () => {
      const r = await one();
      await r.putf('%4', 110, 35, false);
      const f = r.lease(r.tag('@2'));
      assert.deepEqual([f.cols, f.rows, f.resized], [110, 35, false]);
    });

    test('(−) a take of a lease nika sized earlier keeps the window\'s own size (width0/height0): a size set by hand is not the window\'s own', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      await r.putf('%4', 100, 30, true); // fitted, resized, width0 80x24
      await r.putf('%4', 80, 24, true, false); // the panel is the window's own size again: nika sets 80x24 (resized false, sized true)
      const nonce = r.tag('@2');
      assert.equal(r.lease(nonce).resized, false);
      Object.assign(win(r, '@2'), { width: 90, height: 28 }); // someone ran resize-window by hand
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), TAKE);
      assert.deepEqual(sizesOf(r, at), ['-x 80 -y 24']);
      const f = r.lease(nonce);
      assert.deepEqual([f.width0, f.height0, f.resized], [80, 24, false]);
    });

    test('(−) the watch\'s give meets a busy pane: the lease and the window stay, one log line, and the next tick gives', async () => {
      const r = rig();
      const { fit, gate } = busyRig(r);
      await fit.hold('%4', { cols: 100, rows: 30, open: true, focus: false });
      r.world.view('@2', 1, [90, 25]); // a terminal comes; no tick yet
      gate.busy = true;
      const at = r.at();
      await r.tick();
      assert.equal(fit.size(), 1);
      assert.deepEqual(sizesOf(r, at), []);
      assert.notEqual(r.tag('@2'), '');
      assert.equal(r.logs.length, 1, 'exactly one line: no release was tried (it would need the busy lock too and log its own failure)');
      assert.match(r.logs[0], /give failed \(EPANEBUSY\)$/);
      gate.busy = false;
      const next = r.at();
      await r.tick();
      assert.deepEqual(r.names(next), GIVE);
    });

    test('(−) a request that gives meets a busy pane: 409 busy, the lease and the window stay; the watch gives on the focus the request recorded', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      const { fit, gate } = busyRig(r);
      await fit.hold('%4', { cols: 100, rows: 30, open: true, focus: true });
      gate.busy = true;
      const at = r.at();
      assert.deepEqual(await fit.hold('%4', { cols: 100, rows: 30, open: false, focus: false }), BUSY);
      assert.equal(fit.size(), 1);
      assert.deepEqual(sizesOf(r, at), []);
      assert.deepEqual(r.logs, [], 'no release was tried (it would need the busy lock too and log its own failure)');
      assert.notEqual(r.tag('@2'), '');
      gate.busy = false;
      const next = r.at();
      await r.tick();
      assert.deepEqual(r.names(next), GIVE);
      assert.deepEqual([win(r, '@2').width, win(r, '@2').height], [80, 24]);
    });

    test('(−) a request that gives and fails in tmux: 502, the lease is released with no mark, nothing is tried again', async () => {
      const r = await one();
      let n = 0;
      r.world.fail = (name) => name === 'size' && (n += 1) === 1; // the give's resize back fails once
      assert.equal((await r.putf('%4', 100, 30, false)).status, 502);
      assert.equal(r.fit.size(), 0);
      assert.equal(r.tag('@2'), '');
      assert.deepEqual(r.files(), []);
      r.world.fail = null;
      assert.notEqual((await r.putf('%4', 100, 30, false)).body.fit.state, 'blocked', 'no mark');
    });

    test('(−) the give looks again inside the lock: the user resizes the window while it waits → user-change, no give', async () => {
      const r = rig((w) => w.view('@2', 1, [80, 24]));
      const { fit, g } = gatedFit(r);
      assert.deepEqual(await fit.hold('%4', { cols: 100, rows: 30, open: true, focus: true }), ans('fitted', 'terminal', 100, 30, 1));
      g.shut();
      const p = fit.hold('%4', { cols: 100, rows: 30, open: false, focus: false });
      await until(() => g.waiting === 1);
      Object.assign(win(r, '@2'), { width: 120, height: 35 }); // the user resizes the window
      g.open();
      const res = await p;
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'user-change']);
      assert.equal(fit.size(), 0);
    });

    test('(−) the take looks again inside the lock: the user unzooms while it waits → user-change, nothing resized', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      const { fit, g } = gatedFit(r);
      assert.deepEqual(await fit.hold('%2', { cols: 220, rows: 60, open: true, focus: true }), ans('fitted', 'terminal', 220, 60, 3));
      assert.equal((await fit.hold('%2', { cols: 220, rows: 60, open: false, focus: false })).body.fit.state, 'terminal'); // give
      g.shut();
      const at = r.at();
      const p = fit.hold('%2', { cols: 220, rows: 60, open: false, focus: true }); // take
      await until(() => g.waiting === 1);
      win(r).zoomed = false;
      g.open();
      const res = await p;
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'user-change']);
      assert.equal(fit.size(), 0);
      assert.deepEqual(sizesOf(r, at), [], 'no resize at all');
    });

    test('(−) the take looks again inside the lock: nika\'s own agent pane arrives while it waits → nothing is resized in that turn', async () => {
      const r = rig((w) => w.view('@1', 1, [200, 50]));
      const { fit, g } = gatedFit(r);
      await fit.hold('%2', { cols: 220, rows: 60, open: true, focus: true });
      await fit.hold('%2', { cols: 220, rows: 60, open: false, focus: false }); // give
      g.shut();
      const at = r.at();
      const p = fit.hold('%2', { cols: 220, rows: 60, open: false, focus: true }); // take
      await until(() => g.waiting === 1);
      split(r);
      g.open();
      assert.equal((await p).status, 200);
      assert.deepEqual(sizesOf(r, at), [], 'no resize in this turn');
      assert.equal(fit.size(), 1);
    });
  });
});

describe('F15: any pane may be squeezed while the session window has focus; the blur gives size and layout back (design F13 section 3 as changed by the addendum)', () => {
  const win = (r, id = '@1') => r.world.wins.get(id);
  const sizesOf = (r, at) => r.argv(at).filter((a) => a[0] === 'resize-window').map((a) => a.slice(3).join(' '));
  const count = (r, name, at = 0) => r.names(at).filter((n) => n === name).length;
  const KEYS = ['v', 'nonce', 'window', 'pane', 'panes', 'zoomed0', 'active0', 'width0', 'height0', 'size0', 'layout0', 'layout1', 'cols', 'rows', 'resized', 'userZoom', 'at'];
  const CHANGES = new Set(['size', 'optUnset', 'optSet', 'select', 'zoom', 'tag', 'untag', 'focus']);
  /** every tmux change of a stretch of the call log, in order, as argv */
  const changes = (r, at = 0) => r.world.calls.slice(at).filter((c) => CHANGES.has(c.name)).map((c) => c.argv);
  /** a take of a squeezed window: its own listing, the in-lock listing, the option check, the layout (the one to put back), the resize, the read-back */
  const TAKE_SQ = ['list', 'list', 'option', 'layout', 'size', 'list', 'layout'];
  /** a give of a squeezed window: its own listing, the in-lock listing, R3, R4, the layout, a look at the zoom, the zoom, the read-back */
  const GIVE_SQ = ['list', 'list', 'size', 'optUnset', 'select', 'list', 'zoom', 'list', 'layout'];
  /** the plain give (no layout to put back) */
  const GIVE_PLAIN = ['list', 'list', 'size', 'optUnset', 'list', 'layout'];
  /**
   * @1: zsh %1 (no role), claude %2 (the mirrored pane), claude %3; 200x50; a resize of it drifts the arrangement. The page has no focus and no terminal shows
   * the window: zoomed / panel-smaller. `ref` is what a give must bring back exactly.
   */
  async function zoomedRig(setup) {
    const r = rig((x) => { x.drift = true; setup?.(x); });
    const before = r.world.snap('@1');
    assert.deepEqual(await r.put('%2', 100, 30), ans('zoomed', 'panel-smaller', 200, 50, 3));
    return { r, before, ref: r.world.snap('@1') };
  }
  /** zoomedRig, then the focus: the take squeezes the window to 100x30. */
  async function squeezed(setup) {
    const z = await zoomedRig(setup);
    assert.deepEqual(await z.r.putf('%2', 100, 30, true), ans('fitted', null, 100, 30, 3));
    return z;
  }

  describe('the squeeze (acquire and take)', () => {
    test('(+) acquire with focus: an untagged shell beside, a smaller panel → resize-window to the panel, the zoom kept, fitted; the hidden pane is squeezed with the window; no new key in the lease file', async () => {
      const r = rig((x) => { x.drift = true; });
      const L0 = r.world.layoutOf(win(r));
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('fitted', null, 100, 30, 3));
      assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout']);
      assert.deepEqual(sizesOf(r, 0), ['-x 100 -y 30']);
      const w = win(r);
      assert.deepEqual([w.zoomed, w.active, w.width, w.height, w.sizeOpt], [true, '%2', 100, 30, 'manual']);
      assert.deepEqual(r.world.paneSize(w, w.panes[0]), [33, 30], 'the hidden shell shrank with the window');
      assert.deepEqual(r.world.lockIds, ['%2']);
      const f = r.lease(r.tag());
      assert.deepEqual(Object.keys(f), KEYS, 'the layout to put back lives in memory: no new key in the file');
      assert.deepEqual([f.resized, f.cols, f.rows, f.width0, f.height0, f.layout0], [true, 100, 30, 200, 50, L0]);
    });

    test('(+) whatever the other panes run or carry as a tag, a focused page squeezes them (shell, editor, agent running node, sub-orchestrator, orchestrator, foreign text)', async () => {
      for (const [command, role] of [['zsh', undefined], ['vim', ''], ['node', 'agent'], ['claude', 'sub-orchestrator'], ['node', 'orchestrator'], ['bash', '?'], ['zsh', 'something']]) {
        const r = rig((x) => x.add('@5', [['%5', 'claude'], ['%6', command, role]], 200, 50));
        assert.deepEqual(await r.putf('%5', 100, 30, true), ans('fitted', null, 100, 30, 2), `${command} ${role}`);
        assert.deepEqual(sizesOf(r, 0), ['-x 100 -y 30'], `${command} ${role}`);
      }
    });

    test('(−) one dimension smaller is a squeeze too (its give puts the layout back); a panel as big as the window in both is not (its give is the plain F9 one)', async () => {
      const a = rig((x) => { x.drift = true; });
      const ref = strip(a.world.layoutOf(win(a)));
      assert.deepEqual(await a.putf('%2', 300, 40, true), ans('fitted', null, 300, 40, 3));
      assert.deepEqual(sizesOf(a, 0), ['-x 300 -y 40']);
      const at = a.at();
      assert.deepEqual(await a.putf('%2', 300, 40, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.deepEqual(a.names(at), GIVE_SQ);
      assert.equal(a.world.snap('@1').layout, ref);
      const b = rig((x) => { x.view('@1', 1, [200, 50]); });
      assert.deepEqual(await b.putf('%2', 220, 60, true), ans('fitted', 'terminal', 220, 60, 3));
      assert.deepEqual(b.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'size', 'list', 'layout']);
      const bt = b.at();
      assert.deepEqual(await b.putf('%2', 220, 60, false), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(b.names(bt), GIVE_PLAIN, 'a grown window gets no select-layout: F9 as before');
    });

    test('(−) unfocused (no focus key, or focus false) with a smaller panel: zoom only, no resize-window, zoomed / panel-smaller', async () => {
      for (const send of [(r) => r.put('%2', 100, 30), (r) => r.putf('%2', 100, 30, false)]) {
        const r = rig((x) => { x.drift = true; });
        assert.deepEqual(await send(r), ans('zoomed', 'panel-smaller', 200, 50, 3));
        assert.deepEqual(sizesOf(r, 0), []);
        assert.deepEqual(r.names(), ['list', 'option', 'layout', 'list', 'layout', 'option', 'tag', 'zoom', 'list', 'layout']);
      }
    });

    test('(−) a user\'s zoom of another pane still blocks with focus: blocked / user-zoom, nothing resized', async () => {
      const r = rig((x) => { const w = x.wins.get('@1'); w.zoomed = true; w.active = '%3'; });
      const res = await r.putf('%2', 100, 30, true);
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'user-zoom']);
      assert.deepEqual(changes(r), []);
      assert.equal(r.fit.size(), 0);
    });

    test('(+) renew with focus on a zoomed lease: the take runs in the same request, the layout is read inside the lock right before the resize (exact argv)', async () => {
      const { r } = await zoomedRig();
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('fitted', null, 100, 30, 3));
      assert.deepEqual(r.names(at), TAKE_SQ);
      assert.deepEqual(changes(r, at), [['resize-window', '-t', '@1', '-x', '100', '-y', '30']]);
      assert.deepEqual(r.world.calls.slice(at).filter((c) => c.name === 'layout').map((c) => c.locked), [1, 0], 'the layout to put back is read in the lock; the read-back after it');
      assert.deepEqual(r.world.calls.slice(at).filter((c) => c.name === 'size').map((c) => c.locked), [1]);
    });

    test('(+) the watch takes for a focused zoomed lease (a focus change that the lock refused first): TAKE also when the state is zoomed', async () => {
      const r = rig((x) => { x.drift = true; });
      const { fit, gate } = busyRig(r);
      assert.deepEqual(await fit.hold('%2', { cols: 100, rows: 30, open: true, focus: false }), ans('zoomed', 'panel-smaller', 200, 50, 3));
      gate.busy = true;
      assert.deepEqual(await fit.hold('%2', { cols: 100, rows: 30, open: false, focus: true }), BUSY);
      assert.equal(win(r).width, 200, 'nothing changed yet');
      gate.busy = false;
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), TAKE_SQ);
      assert.deepEqual([win(r).width, win(r).height], [100, 30]);
      assert.deepEqual(await fit.hold('%2', { cols: 100, rows: 30, open: false, focus: true }), ans('fitted', null, 100, 30, 3));
    });

    test('(−) the layout cannot be read when the take wants to squeeze (a layout with a #): fail closed, no resize-window, zoomed / panel-smaller', async () => {
      const { r } = await zoomedRig();
      win(r).pinned = '{"w":200,"h":50,"s":"x#y"}';
      r.world.after = (name) => { if (name === 'layout') win(r).pinned = undefined; }; // only the read inside the take is bad
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.deepEqual(sizesOf(r, at), []);
      assert.equal(r.fit.size(), 1);
    });

    test('(−) a renew that wants to squeeze a window at its own size but cannot keep its layout (a layout with a #): fail closed, no resize-window, zoomed / panel-smaller; the next take squeezes', async () => {
      const r = rig((x) => { x.drift = true; });
      assert.deepEqual(await r.putf('%2', 200, 50, true), ans('fitted', null, 200, 50, 3));
      win(r).pinned = '{"w":200,"h":50,"s":"x#y"}';
      r.world.after = (name) => { if (name === 'layout') win(r).pinned = undefined; }; // only the read inside the renew is bad
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.deepEqual(sizesOf(r, at), []);
      assert.equal(r.fit.size(), 1);
      const t = r.at();
      await r.tick(); // focus and zoomed: the watch takes, and this time the layout reads
      assert.deepEqual(r.names(t), TAKE_SQ);
      assert.deepEqual(await r.putf('%2', 100, 30, true, false), ans('fitted', null, 100, 30, 3));
    });

    test('(+) the take counts: 12 focus takes per window in a minute, the 13th waits (zoomed / panel-smaller, never "switching"), the watch takes when the minute frees up', async () => {
      const { r } = await zoomedRig();
      const t0 = r.clock.t;
      for (let i = 0; i < 12; i += 1) {
        r.clock.t = t0 + 2000 * i + 1000;
        assert.deepEqual(await r.putf('%2', 100, 30, true), ans('fitted', null, 100, 30, 3), `take ${i + 1}`);
        r.clock.t = t0 + 2000 * i + 2000;
        assert.deepEqual(await r.putf('%2', 100, 30, false), ans('zoomed', 'panel-smaller', 200, 50, 3), `give ${i + 1}`);
      }
      const first = t0 + 1000;
      r.clock.t = t0 + 25000;
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('zoomed', 'panel-smaller', 200, 50, 3), 'the 13th take waits');
      assert.deepEqual(r.names(at), ['list'], 'no lock, no resize');
      for (const t of [t0 + 35000, t0 + 45000, t0 + 55000, first + 59999]) {
        r.clock.t = t;
        await r.putf('%2', 100, 30, true, false); // the heartbeat keeps the lease
        const mark = r.at();
        await r.tick();
        assert.deepEqual(r.names(mark), ['list'], `the watch waits at ${t - first} ms after the first take`);
      }
      r.clock.t = first + 60000;
      await r.putf('%2', 100, 30, true, false);
      const mark = r.at();
      await r.tick();
      assert.deepEqual(r.names(mark), TAKE_SQ, 'the minute is free: the watch takes');
      assert.deepEqual(await r.putf('%2', 100, 30, true, false), ans('fitted', null, 100, 30, 3));
    });

    test('(+) a renew to a smaller panel under focus keeps the layout of the first squeeze: one resize-window in the lock, the give brings the original back', async () => {
      const { r, ref } = await zoomedRig();
      assert.deepEqual(await r.putf('%2', 150, 40, true), ans('fitted', null, 150, 40, 3));
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true, false), ans('fitted', null, 100, 30, 3));
      assert.deepEqual(r.names(at), ['list', 'list', 'size', 'list', 'layout']);
      assert.deepEqual(sizesOf(r, at), ['-x 100 -y 30']);
      assert.deepEqual(await r.putf('%2', 100, 30, false, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.deepEqual(r.world.snap('@1'), ref);
    });

    test('(+) a renew that squeezes a window at its own size (a focused lease whose panel was as big as the window) reads the layout in the lock right before the resize', async () => {
      const r = rig((x) => { x.drift = true; });
      const ref = strip(r.world.layoutOf(win(r)));
      assert.deepEqual(await r.putf('%2', 200, 50, true), ans('fitted', null, 200, 50, 3)); // the panel is the window's size: nothing resized, nothing to put back yet
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true, false), ans('fitted', null, 100, 30, 3));
      assert.deepEqual(r.names(at), ['list', 'list', 'layout', 'size', 'list', 'layout']);
      assert.deepEqual(r.world.calls.slice(at).filter((c) => c.name === 'layout').map((c) => c.locked), [1, 0]);
      const g = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, false, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.deepEqual(r.names(g), GIVE_SQ);
      assert.deepEqual(changes(r, g)[2], ['select-layout', '-t', '@1', '--', ref]);
      assert.equal(r.world.snap('@1').layout, ref);
    });

    test('(+) a give clears the layout it put back: a later take that grows the window keeps none, and its give is the plain one', async () => {
      const r = rig((x) => { x.drift = true; x.view('@1', 1, [200, 50]); });
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('fitted', 'terminal', 100, 30, 3));
      const a = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, false), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(r.names(a), GIVE_SQ);
      const t = r.at();
      assert.deepEqual(await r.putf('%2', 220, 60, true), ans('fitted', 'terminal', 220, 60, 3)); // a take that grows: nothing to squeeze, no layout read
      assert.deepEqual(r.names(t), ['list', 'list', 'option', 'size', 'list', 'layout']);
      const g = r.at();
      assert.deepEqual(await r.putf('%2', 220, 60, false), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(r.names(g), GIVE_PLAIN, 'the layout of the first squeeze is not put back a second time');
    });

    test('(+) a renew that squeezes a window nika had grown has no own-size layout to read: no layout call, the give is the plain one, the release\'s R5 puts layout0 back', async () => {
      const r = rig((x) => { x.drift = true; });
      const before = r.world.snap('@1');
      assert.deepEqual(await r.putf('%2', 220, 60, true), ans('fitted', null, 220, 60, 3)); // grown: no squeeze, nothing to put back
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true, false), ans('fitted', null, 100, 30, 3));
      assert.deepEqual(r.names(at), ['list', 'list', 'size', 'list', 'layout'], 'no layout read in the lock');
      const g = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, false, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.deepEqual(r.names(g), GIVE_PLAIN);
      const rel = r.at();
      assert.equal((await r.fit.release('%2')).body.released, true);
      assert.deepEqual(r.names(rel), REL_FULL.filter((n) => n !== 'size'), 'the plain give left the window at its own size: no R3');
      assert.deepEqual(r.world.snap('@1'), before);
    });
  });

  describe('the give: size and layout back, the pane zoomed again', () => {
    test('(+) blur with no terminal: R3, R4, select-layout of the layout read before the squeeze, resize-pane -Z, in that order; zoomed / panel-smaller; the window is as before the squeeze', async () => {
      const { r, ref } = await squeezed();
      const nonce = r.tag();
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.deepEqual(r.names(at), GIVE_SQ);
      assert.deepEqual(changes(r, at), [
        ['resize-window', '-t', '@1', '-x', '200', '-y', '50'], // R3
        ['set-option', '-wu', '-t', '@1', 'window-size'], // R4
        ['select-layout', '-t', '@1', '--', ref.layout], // unzooms the window
        ['resize-pane', '-Z', '-t', '%2'], // the mirrored pane again
      ]);
      assert.equal(r.world.calls.slice(at).filter((c) => CHANGES.has(c.name)).every((c) => c.locked === 1), true, 'every change inside the pane lock');
      assert.deepEqual(r.world.snap('@1'), ref, 'size, option, arrangement, zoom, active pane and the hidden panes\' sizes as before the squeeze');
      assert.equal(r.tag(), nonce, 'the lease and the tag stay');
      assert.equal(r.fit.size(), 1);
      assert.equal(r.lease(nonce).resized, false);
      assert.deepEqual(r.logs, []);
    });

    test('(+) blur with a terminal: the same order, then terminal; focus again takes again', async () => {
      const r = rig((x) => { x.drift = true; x.view('@1', 1, [200, 50]); });
      const L0 = strip(r.world.layoutOf(win(r)));
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('fitted', 'terminal', 100, 30, 3));
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, false), ans('terminal', null, 200, 50, 3));
      assert.deepEqual(r.names(at), GIVE_SQ);
      assert.deepEqual(changes(r, at).map((a) => a[0]), ['resize-window', 'set-option', 'select-layout', 'resize-pane']);
      assert.deepEqual(changes(r, at)[2], ['select-layout', '-t', '@1', '--', L0]);
      const w = win(r);
      assert.deepEqual([w.width, w.height, w.zoomed, w.active, w.sizeOpt, strip(r.world.layoutOf(w))], [200, 50, true, '%2', null, L0]);
      const t = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, true), ans('fitted', 'terminal', 100, 30, 3));
      assert.deepEqual(r.names(t), TAKE_SQ);
    });

    test('(+) the watch gives for a blur that the lock refused, with no terminal (the hidden panes get their size back on blur whether or not a terminal shows the window)', async () => {
      const r = rig((x) => { x.drift = true; });
      const { fit, gate } = busyRig(r);
      assert.deepEqual(await fit.hold('%2', { cols: 100, rows: 30, open: true, focus: false }), ans('zoomed', 'panel-smaller', 200, 50, 3));
      const ref = r.world.snap('@1');
      assert.deepEqual(await fit.hold('%2', { cols: 100, rows: 30, open: false, focus: true }), ans('fitted', null, 100, 30, 3));
      gate.busy = true;
      assert.deepEqual(await fit.hold('%2', { cols: 100, rows: 30, open: false, focus: false }), BUSY);
      assert.equal(win(r).width, 100, 'nothing changed yet');
      gate.busy = false;
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), GIVE_SQ);
      assert.deepEqual(r.world.snap('@1'), ref);
      assert.deepEqual(await fit.hold('%2', { cols: 100, rows: 30, open: false, focus: false }), ans('zoomed', 'panel-smaller', 200, 50, 3));
    });

    test('(+) the layout is read again at every take: a layout the window had at the next take is the one the next give puts back', async () => {
      const { r } = await squeezed();
      await r.putf('%2', 100, 30, false); // first give
      win(r).arr = 'tall'; // the window now has another arrangement
      const L1 = r.world.snap('@1').layout;
      await r.putf('%2', 100, 30, true); // second take
      assert.notEqual(win(r).arr, 'tall');
      const at = r.at();
      await r.putf('%2', 100, 30, false); // second give
      assert.deepEqual(changes(r, at)[2], ['select-layout', '-t', '@1', '--', L1]);
      assert.equal(win(r).arr, 'tall');
    });

    test('(+) release after five cycles (and while squeezed): R5 select-layout of layout0, markers stripped; the window is as before the lease', async () => {
      const r = rig((x) => { x.drift = true; });
      const before = r.world.snap('@1');
      await r.put('%2', 100, 30);
      for (let i = 0; i < 5; i += 1) {
        r.clock.t += 1000;
        assert.equal((await r.putf('%2', 100, 30, true)).body.fit.state, 'fitted');
        assert.equal((await r.putf('%2', 100, 30, false)).body.fit.state, 'zoomed');
      }
      assert.equal((await r.putf('%2', 100, 30, true)).body.fit.state, 'fitted');
      const at = r.at();
      assert.equal((await r.fit.release('%2')).body.released, true);
      assert.deepEqual(r.names(at), REL_FULL);
      assert.deepEqual(changes(r, at).find((a) => a[0] === 'select-layout'), ['select-layout', '-t', '@1', '--', before.layout]);
      assert.deepEqual(r.world.snap('@1'), before);
      assert.deepEqual(r.logs, []);
    });

    test('(+) a crash while squeezed: recover puts the window back with layout0 (the layout of the take is memory only)', async () => {
      const { r, before } = await squeezed();
      const fresh = r.make();
      const at = r.at();
      assert.deepEqual(await fresh.recover(), { released: 1, dropped: 0 });
      assert.deepEqual(r.names(at), REL_FULL);
      assert.deepEqual(changes(r, at).find((a) => a[0] === 'select-layout'), ['select-layout', '-t', '@1', '--', before.layout]);
      assert.deepEqual(r.world.snap('@1'), before);
    });

    test('(−) a layout the user changed during the squeeze: R5 skipped at the release (unchanged rule)', async () => {
      const { r } = await squeezed((x) => { x.drift = false; });
      win(r).arr = 'mine';
      const at = r.at();
      assert.equal((await r.fit.release('%2')).body.released, true);
      assert.equal(count(r, 'select', at), 0);
      assert.equal(win(r).arr, 'mine');
    });

    test('(−) 3 panes, no focus, a panel bigger than the window and no terminal: no give, the grown window stays (the F9 rule for a grown window is unchanged)', async () => {
      const r = rig();
      assert.deepEqual(await r.put('%2', 220, 60), ans('fitted', null, 220, 60, 3));
      const at = r.at();
      await r.tick();
      assert.deepEqual(r.names(at), ['list']);
      assert.deepEqual(await r.putf('%2', 220, 60, false, false), ans('fitted', null, 220, 60, 3));
      assert.deepEqual([win(r).width, win(r).height], [220, 60]);
    });
  });

  describe('the read-back of a give: any mismatch releases with changed, once', () => {
    test('(−) another layout → blocked / changed, one select-layout, the lease released', async () => {
      const { r } = await squeezed();
      r.world.after = (name) => { if (name === 'select') win(r).arr = 'other'; };
      const at = r.at();
      const res = await r.putf('%2', 100, 30, false);
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'changed']);
      assert.equal(r.fit.size(), 0);
      assert.equal(r.tag(), '');
      assert.equal(count(r, 'select', at), 1, 'no retry');
      assert.equal((await r.putf('%2', 100, 30, false, false)).body.fit.reason, 'changed', 'the mark: off until the page opens again');
    });

    test('(−) no zoom after the give → blocked / changed, the lease released (with a terminal the pane sizes are not judged: the zoom flag alone decides)', async () => {
      for (const terminal of [false, true]) {
        const r = rig((x) => { x.drift = true; if (terminal) x.view('@1', 1, [200, 50]); });
        assert.equal((await r.putf('%2', 100, 30, true)).body.fit.state, 'fitted');
        r.world.after = (name) => { if (name === 'zoom') win(r).zoomed = false; };
        const at = r.at();
        const res = await r.putf('%2', 100, 30, false);
        assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'changed'], `terminal ${terminal}`);
        assert.equal(r.fit.size(), 0);
        assert.equal(count(r, 'select', at), 1);
      }
    });

    test('(−) another window size (the layout string is the right one) → blocked / changed, with and without a terminal', async () => {
      for (const terminal of [false, true]) {
        const r = rig((x) => { x.drift = true; if (terminal) x.view('@1', 1, [200, 50]); });
        const ref = strip(r.world.layoutOf(win(r)));
        assert.equal((await r.putf('%2', 100, 30, true)).body.fit.state, 'fitted');
        r.world.after = (name) => {
          if (name !== 'zoom') return;
          if (terminal) r.world.view('@1', 1, [199, 50]); // the terminal was resized meanwhile: the window follows it
          else win(r).width = 199;
          win(r).pinned = ref; // the layout text is the right one; only the size differs
        };
        const res = await r.putf('%2', 100, 30, false);
        assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'changed'], `terminal ${terminal}`);
        assert.equal(r.fit.size(), 0);
      }
    });

    test('(−) the mirrored pane left the window: 404, no zoom toggle, the lease released', async () => {
      const { r } = await squeezed();
      r.world.after = (name) => {
        if (name !== 'select') return;
        const w = win(r);
        w.panes = w.panes.filter((p) => p.id !== '%2');
        w.active = '%1';
      };
      const at = r.at();
      const res = await r.putf('%2', 100, 30, false);
      assert.equal(res.status, 404);
      assert.equal(count(r, 'zoom', at), 0, 'a pane that left is not zoomed');
      assert.equal(r.fit.size(), 0);
    });

    test('(−) select-layout left the window zoomed: no resize-pane -Z (it would end the zoom), the give still verifies', async () => {
      const { r } = await squeezed();
      r.world.after = (name) => { if (name === 'select') win(r).zoomed = true; };
      const at = r.at();
      assert.deepEqual(await r.putf('%2', 100, 30, false), ans('zoomed', 'panel-smaller', 200, 50, 3));
      assert.equal(count(r, 'zoom', at), 0);
      assert.equal(win(r).zoomed, true);
    });
  });

  describe('what else still holds', () => {
    test('(−) a user resize during a focused squeeze releases with user-change; the window is put back', async () => {
      const { r } = await squeezed();
      win(r).width = 90; // the user
      const res = await r.putf('%2', 100, 31, true, false);
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'user-change']);
      assert.equal(r.fit.size(), 0);
      assert.deepEqual([win(r).width, win(r).height], [200, 50]);
      assert.equal(win(r).zoomed, false, 'the zoom nika made is undone, as before');
    });

    test('(−) the user unzooms during a focused squeeze: user-change, no give of its own', async () => {
      const { r } = await squeezed();
      win(r).zoomed = false;
      const at = r.at();
      const res = await r.putf('%2', 100, 30, false);
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'user-change']);
      assert.deepEqual(changes(r, at).map((a) => a[0]), ['resize-window', 'set-option', 'select-layout', 'select-pane', 'set-option'], 'only the restore (R3, R4, R5, R6, R8): no give of its own, no zoom');
    });

    test('(−) a window tmux cannot shrink to the panel: the take is read back, released with changed, no retry loop', async () => {
      const { r } = await zoomedRig((x) => { x.minSize = [150, 40]; });
      const at = r.at();
      const res = await r.putf('%2', 100, 30, true);
      assert.deepEqual([res.body.fit.state, res.body.fit.reason], ['blocked', 'changed']);
      assert.equal(r.fit.size(), 0);
      assert.deepEqual(sizesOf(r, at), ['-x 100 -y 30', '-x 200 -y 50'], 'the resize, then the restore: nothing else');
      const mark = r.at();
      assert.equal((await r.putf('%2', 100, 30, true, false)).body.fit.reason, 'changed');
      await r.tick();
      assert.deepEqual(changes(r, mark), [], 'blocked until the page opens again: no second try');
    });
  });
});
