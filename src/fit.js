// Fit controller for the app tier (nika 0.5, W7, ADR 0017): zooms the mirrored pane, resizes its tmux window only when that is
// safe, keeps one lease per tmux window and gives back exactly what it changed. The routes (api-app.js) and the page
// (public/session.js) only call it; this module owns every tmux argv of the fit (api-app.md section 8).
//
// Where the truth lives (design-W7 section 3): server memory (`leases`), a 0600 lease file in nika's state dir (crash
// recovery) and the window tag `@nika-fit <nonce>` (proof that the window is the same one and ours). Every tmux target and
// every stored value comes from tmux's own listing in the same call; the request contributes only `cols`, `rows` and `open`.
//
// nika never fights the user: once the window differs from what nika set it releases and stays off (`blocked`) until the
// session window is opened again (`open: true`). It never toggles a zoom it did not make and never applies a saved layout
// when the layout, the pane count or a zoom changed.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PANE_ID, WINDOW_ID, FIT_NONCE, CLAUDE_COMMAND } from './ids.js';
import { ensureDir, writeAtomic, removeOwnFile } from './fwrite.js';
import { openRegular, readAt, isRealDir } from './fsafe.js';
import { tmuxFailure, NO_TMUX_SERVER } from './tmuxerr.js';

export const LAPSE_MS = 15000; // no heartbeat for this long: the page is gone, restore
export const WATCH_MS = 1000; // server tick while any lease is held
export const RELEASE_ALL_MS = 3000; // bound of releaseAll() and recover()
export const LEASE_FILE_MAX = 16 * 1024;
export const LEASE_FILES_MAX = 20;
export const FIT_RATE = 4; // requests per second per pane for each method (PUT and DELETE have separate buckets); enforced by the route
const MARKS_MAX = 64;
const NOTE_MS = 2000; // a PUT open:false this soon after the page's own DELETE is a late heartbeat, not a page that wants the window
const NOTES_MAX = 64;

const SIZE_OPTIONS = new Set(['latest', 'largest', 'smallest', 'manual']);
const LAYOUT = /^[\x20-\x7e]{1,8192}$/; // tmux's own `#{window_layout}`: printable ASCII; `#` is refused separately
const FILE_NAME = /^fit-([0-9a-f]{16})\.json$/;
const FIT_FORMAT = ['#{pane_id}', '#{window_id}', '#{window_panes}', '#{window_zoomed_flag}', '#{pane_active}', '#{window_width}', '#{window_height}',
  '#{pane_width}', '#{pane_height}', '#{pane_current_command}', '#{@nika-fit}'].join('\t');
const FILE_KEYS = ['v', 'nonce', 'window', 'pane', 'panes', 'zoomed0', 'active0', 'width0', 'height0', 'size0', 'layout0', 'layout1', 'cols', 'rows', 'resized', 'userZoom', 'at'];
const BODY_MESSAGE = 'cols must be an integer 40–400, rows 10–200, open a boolean';

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const matches = (re, v) => typeof v === 'string' && re.test(v);
const validLayout = (s) => matches(LAYOUT, s) && !s.includes('#');
/** The 3.8 JSON layout carries `"a":true` (active pane) and `"l":N` (last pane); applying them would move focus (spike S10). A no-op on the older format. */
const strip = (s) => s.replace(/,"(a|l)":(true|\d+)/g, '');
const digits = (s, lo, hi) => (matches(/^\d{1,5}$/, s) && Number(s) >= lo && Number(s) <= hi ? Number(s) : null);
const bit = (s) => (s === '0' ? 0 : s === '1' ? 1 : null);
const codeOf = (e) => (matches(/^[\w-]{1,20}$/, String(e?.code ?? 'error')) ? String(e?.code ?? 'error') : 'error');
const isNoServer = (e) => NO_TMUX_SERVER.test(String(e?.stderr || e?.message || ''));

const invalid = (message) => ({ status: 400, body: { error: 'invalid', message } });
const NOT_FOUND = { status: 404, body: { error: 'not_found', message: 'pane not found' } };
const BUSY = { status: 409, body: { error: 'busy', message: 'another fit request for this tmux window is running' } };
// withPaneLock (session-control.js) gave up waiting for a running End, draft write or other control action on the pane (code EPANEBUSY)
const PANE_BUSY = { status: 409, body: { error: 'busy', message: 'Claude is busy with another action on this pane. Try again.' } };
const paneBusy = (e) => e?.code === 'EPANEBUSY';

/** `{ value: { cols, rows, open } }` for exactly `{ cols, rows, open }` in range, else `{ error: <message> }`. The route and the controller share it. */
export function checkFitBody(body) {
  const ok = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 3
    && isInt(body.cols, 40, 400) && isInt(body.rows, 10, 200) && typeof body.open === 'boolean';
  return ok ? { value: { cols: body.cols, rows: body.rows, open: body.open } } : { error: BODY_MESSAGE };
}

/** `list-panes -a` text → Map pane id → row; a row that does not parse is dropped. A tag that is not a nonce reads `?` (foreign), never trusted. */
function parseRows(stdout) {
  const rows = new Map();
  for (const line of String(stdout).split('\n')) {
    const f = line.split('\t');
    if (f.length !== 11) continue;
    const row = {
      pane: f[0], window: f[1], panes: digits(f[2], 1, 999), zoomed: bit(f[3]), active: bit(f[4]), winW: digits(f[5], 1, 10000), winH: digits(f[6], 1, 10000),
      paneW: digits(f[7], 1, 10000), paneH: digits(f[8], 1, 10000), command: f[9], tag: f[10] === '' || FIT_NONCE.test(f[10]) ? f[10] : '?',
    };
    const numbers = [row.panes, row.zoomed, row.active, row.winW, row.winH, row.paneW, row.paneH];
    if (PANE_ID.test(row.pane) && WINDOW_ID.test(row.window) && numbers.every((v) => v !== null)) rows.set(row.pane, row);
  }
  return rows;
}
const rowsOf = (snap, w) => [...snap.values()].filter((r) => r.window === w);
const claudePane = (snap, id) => {
  const r = snap.get(id);
  return r && CLAUDE_COMMAND.test(r.command.trim()) ? r : null;
};

// The fixed argv lists of design section 4 (without the leading -u). Each builder validates what it embeds, so no other tmux call can be built.
const win_ = (w) => { if (!matches(WINDOW_ID, w)) throw new TypeError('fit: bad window id'); return w; };
const pane_ = (p) => { if (!matches(PANE_ID, p)) throw new TypeError('fit: bad pane id'); return p; };
const nonce_ = (n) => { if (!matches(FIT_NONCE, n)) throw new TypeError('fit: bad nonce'); return n; };
const dim_ = (n) => { if (!isInt(n, 1, 10000)) throw new TypeError('fit: bad size'); return String(n); };
const opt_ = (v) => { if (!SIZE_OPTIONS.has(v)) throw new TypeError('fit: bad window-size'); return v; };
const layout_ = (l) => { if (!validLayout(l)) throw new TypeError('fit: bad layout'); return l; };
const ARGV = {
  list: () => ['list-panes', '-a', '-F', FIT_FORMAT],
  layout: (w) => ['display-message', '-p', '-t', win_(w), '-F', '#{window_layout}'],
  option: (w) => ['show-options', '-w', '-t', win_(w), 'window-size'],
  tag: (w, n) => ['set-option', '-w', '-t', win_(w), '@nika-fit', nonce_(n)],
  untag: (w) => ['set-option', '-wu', '-t', win_(w), '@nika-fit'],
  zoom: (p) => ['resize-pane', '-Z', '-t', pane_(p)],
  size: (w, x, y) => ['resize-window', '-t', win_(w), '-x', dim_(x), '-y', dim_(y)],
  optUnset: (w) => ['set-option', '-wu', '-t', win_(w), 'window-size'],
  optSet: (w, v) => ['set-option', '-w', '-t', win_(w), 'window-size', opt_(v)],
  select: (w, l) => ['select-layout', '-t', win_(w), '--', layout_(l)],
  focus: (p) => ['select-pane', '-t', pane_(p)],
};

/** Shape-checks the content of a lease file; returns the lease (memory shape) or null. Only the known keys are copied. */
function parseLease(text, nonce, at) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length !== FILE_KEYS.length || !FILE_KEYS.every((k) => Object.hasOwn(o, k))) return null;
  const ok = o.v === 1 && o.nonce === nonce && matches(FIT_NONCE, o.nonce) && matches(WINDOW_ID, o.window) && matches(PANE_ID, o.pane) && matches(PANE_ID, o.active0)
    && isInt(o.panes, 1, 999) && (o.zoomed0 === 0 || o.zoomed0 === 1) && isInt(o.width0, 1, 10000) && isInt(o.height0, 1, 10000)
    && (o.size0 === null || SIZE_OPTIONS.has(o.size0)) && validLayout(o.layout0) && validLayout(o.layout1)
    && isInt(o.cols, 40, 400) && isInt(o.rows, 10, 200) && typeof o.resized === 'boolean' && typeof o.userZoom === 'boolean' && Number.isSafeInteger(o.at) && o.at >= 0;
  if (!ok) return null;
  const lease = {};
  for (const k of FILE_KEYS) lease[k] = o[k];
  return { ...lease, lastBeat: at, state: null, reason: null, seen: null, done: false };
}
const fileOf = (l) => Object.fromEntries(FILE_KEYS.map((k) => [k, l[k]]));
const leaseText = (l) => JSON.stringify(fileOf(l));
const leaseName = (nonce) => `fit-${nonce_(nonce)}.json`;
/** The window size nika expects while it holds the lease: the panel's after a resize, else the original. */
const expOf = (l) => (l.resized ? [l.cols, l.rows] : [l.width0, l.height0]);
/** Resize only when it cannot squeeze other panes: one pane, or a panel at least as big as the window (design 2.1 rows 8, 11, 12). */
function plan(panes, C, R, w0, h0) {
  const fits = panes === 1 || (C >= w0 && R >= h0);
  return { fits, target: fits ? [C, R] : [w0, h0] };
}

const defaultLog = (m) => process.stderr.write(`${m}\n`);
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
const defaultSchedule = (fn, ms) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

/**
 * exec(cmd, argv) is the shared execFile wrapper; `lock(paneId, fn)` runs fn as the only control action on the pane (the
 * session controller's per-pane lock) and resolves with fn's result; `stateDir` is nika's state dir (the lease files live in
 * `<stateDir>/fit/`); `schedule(fn, ms)` starts the watch and returns its cancel function; `sleep(ms)` bounds releaseAll and recover.
 * hold(id, { cols, rows, open }) and release(id) return { status, body } like the other controllers; releaseWindow(w) → boolean;
 * releaseAll() → number of leases released; recover() → { released, dropped }; size() → number of leases held.
 */
export function createFit({
  exec, tmuxBin = 'tmux', now = Date.now, stateDir, lock = (id, fn) => fn(), log = defaultLog, schedule = defaultSchedule, sleep = defaultSleep,
} = {}) {
  if (typeof exec !== 'function') throw new TypeError('exec must be a function');
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new TypeError('stateDir must be an absolute path');
  const dir = path.join(stateDir, 'fit');
  const leases = new Map(); // @W → lease
  const queues = new Map(); // @W → { tail, ops: [{ pane }] }: one acquire, renew or release at a time per window
  const marks = new Map(); // @W → 'user-change' | 'changed': the window stays off until the page sends open:true
  const notes = new Map(); // @W → time of the page's own DELETE (M1): a late heartbeat of the closed page must not fit the window again
  let finished = 0; // queued operations finished so far: a listing taken across a change is stale
  let cancel = null;
  let ticking = false;

  const tmux = async (argv) => {
    try {
      return await exec(tmuxBin, ['-u', ...argv]);
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { tmux: true });
    }
  };
  const fail = (l, step, e) => log(`nika: fit ${l.window} ${l.pane} ${step} failed (${codeOf(e)})`);
  const within = (p, ms) => Promise.race([p.catch(() => {}), sleep(ms)]);

  async function listing() {
    return parseRows((await tmux(ARGV.list())).stdout);
  }
  /** The window's layout, or null when it is not one nika may keep and apply later. */
  async function readLayout(w) {
    const line = String((await tmux(ARGV.layout(w))).stdout).split('\n')[0];
    return validLayout(line) ? line : null;
  }
  /** The window-level `window-size`: null (unset), one of the four values, or undefined (anything else: nika cannot restore it exactly). */
  async function readOption(w) {
    const text = String((await tmux(ARGV.option(w))).stdout).trim();
    if (text === '') return null;
    const m = /^window-size (\w+)$/.exec(text);
    return m && SIZE_OPTIONS.has(m[1]) ? m[1] : undefined;
  }

  // ---- lease registry and watch -------------------------------------------------------------------------------------------
  function register(l) {
    leases.set(l.window, l);
    if (!cancel) cancel = schedule(() => tick().catch(() => {}), WATCH_MS);
  }
  function unregister(l) {
    if (leases.get(l.window) === l) leases.delete(l.window);
    if (leases.size === 0 && cancel) {
      cancel();
      cancel = null;
    }
  }
  const byPane = (id) => [...leases.values()].find((l) => l.pane === id);
  function setMark(w, reason) {
    marks.delete(w);
    marks.set(w, reason);
    if (marks.size > MARKS_MAX) marks.delete(marks.keys().next().value);
  }

  // ---- lease files --------------------------------------------------------------------------------------------------------
  async function writeLease(l, text = leaseText(l)) {
    await ensureDir(dir, 0o700);
    await writeAtomic(dir, leaseName(l.nonce), text, { mode: 0o600 });
  }
  async function unlinkLease(nonce) {
    try {
      await removeOwnFile(dir, leaseName(nonce)); // rule 11: a fit folder or a file swapped for a link, or shared, is refused, never followed
    } catch (e) {
      if (e?.code !== 'ENOENT') log(`nika: fit lease file unlink failed (${codeOf(e)})`);
    }
  }
  /** → { lease } | { invalid: true } (nika's own file with bad content: unlinked) | { skip: true } (missing, a symlink or not a plain user-owned file: left alone). */
  async function readLeaseFile(name) {
    const nonce = FILE_NAME.exec(name)[1];
    let opened;
    try {
      if (!(await isRealDir(dir))) return { skip: true };
      opened = await openRegular(path.join(dir, name));
    } catch {
      return { skip: true };
    }
    let lease = null;
    try {
      if (opened.st.size <= LEASE_FILE_MAX) lease = parseLease(await readAt(opened.handle, 0, opened.st.size), nonce, now());
    } finally {
      await opened.handle.close();
    }
    if (lease) return { lease };
    await unlinkLease(nonce);
    return { invalid: true };
  }

  // ---- the window queue ---------------------------------------------------------------------------------------------------
  /** Runs fn(waited) after the operations queued before it on the window. `exclusive`: a request for another pane while one is running is refused (409). */
  function enqueue(w, pane, exclusive, fn) {
    let q = queues.get(w);
    if (q && exclusive && q.ops.some((o) => o.pane !== pane)) return Promise.resolve(BUSY);
    if (!q) {
      q = { tail: Promise.resolve(), ops: [] };
      queues.set(w, q);
    }
    const op = { pane };
    const waited = q.ops.length > 0;
    q.ops.push(op);
    const run = q.tail.then(() => fn(waited)).finally(() => {
      finished += 1;
      q.ops.splice(q.ops.indexOf(op), 1);
      if (q.ops.length === 0 && queues.get(w) === q) queues.delete(w);
    });
    q.tail = run.catch(() => {});
    return run;
  }
  const releaseQueued = (lease, mark) => enqueue(lease.window, lease.pane, false, () => (lease.done ? 'dropped' : releaseNow(lease, mark)));

  // ---- what the watch and a renew look at ---------------------------------------------------------------------------------
  /** null (all as nika left it), { act: 'drop' } (tag or window gone: ids may be reused, touch nothing) or { act: 'release', mark? }. */
  function observe(lease, snap) {
    const win = rowsOf(snap, lease.window);
    if (win.length === 0 || win[0].tag !== lease.nonce) return { act: 'drop' };
    const m = snap.get(lease.pane);
    if (!m || m.window !== lease.window || !CLAUDE_COMMAND.test(m.command.trim())) return { act: 'release' };
    const [ew, eh] = expOf(lease);
    const unzoomed = lease.panes > 1 && (m.zoomed !== 1 || m.active !== 1);
    if (unzoomed || m.panes !== lease.panes || m.winW !== ew || m.winH !== eh) return { act: 'release', mark: 'user-change' };
    return null;
  }
  async function dropLease(l) {
    unregister(l);
    l.done = true;
    await unlinkLease(l.nonce);
  }
  async function tick() {
    if (ticking || leases.size === 0) return;
    ticking = true;
    try {
      const f0 = finished;
      let snap;
      try {
        snap = await listing();
      } catch (e) {
        // no server: the windows are gone with it. Any other error says nothing; the next tick looks again.
        if (isNoServer(e)) for (const l of [...leases.values()]) if (!queues.has(l.window)) await dropLease(l);
        return;
      }
      if (finished !== f0) return; // an operation finished meanwhile: this listing may show half of it
      for (const lease of [...leases.values()]) {
        // a window whose request is still running is left to that request
        if (queues.has(lease.window) || leases.get(lease.window) !== lease) continue;
        let verdict = observe(lease, snap);
        if (!verdict && now() - lease.lastBeat > LAPSE_MS) verdict = { act: 'release' };
        if (!verdict) continue;
        if (verdict.act === 'drop') await dropLease(lease);
        else await releaseQueued(lease, verdict.mark).catch((e) => fail(lease, 'watch', e));
      }
    } finally {
      ticking = false;
    }
  }

  // ---- answers ------------------------------------------------------------------------------------------------------------
  const reply = (state, reason, size, panes, userZoom) => ({ status: 200, body: { fit: { state, reason, pane: { cols: size[0], rows: size[1] }, panes, userZoom } } });
  const fromRow = (state, reason, row) => reply(state, reason, [row.paneW, row.paneH], row.panes, row.zoomed === 1 && row.active === 1);
  const answer = (l) => reply(l.state, l.reason, l.seen, l.panes, l.userZoom);
  /**
   * The answer of a fit that ended in a release (F2): the pane as the window is after it, not as the fit left it. `userZoom` is the user's own
   * zoom only: it needs the lease's and the listing's. If the listing fails, the pre-fit snapshot is what nika restored to.
   */
  async function restored(lease, reason) {
    let size = lease.pre;
    let panes = lease.panes;
    let zoom = lease.userZoom;
    try {
      const row = (await listing()).get(lease.pane);
      if (row && row.window === lease.window) {
        size = [row.paneW, row.paneH];
        panes = row.panes;
        zoom = lease.userZoom && row.zoomed === 1 && row.active === 1;
      }
    } catch (e) {
      fail(lease, 'answer', e);
    }
    return reply('blocked', reason, size, panes, zoom);
  }

  // ---- RELEASE (design 4, R0-R9): idempotent, inside the window queue; → 'released' | 'dropped' -------------------------------
  async function releaseNow(lease, mark) {
    const { window: w, pane: p, nonce } = lease;
    const held = leases.get(w) === lease;
    if (held) unregister(lease); // from here a heartbeat no longer finds it
    const gone = async () => {
      await unlinkLease(nonce);
      lease.done = true;
      return 'dropped';
    };
    let dropped = false;
    let undone = false;
    let step = 'R0';
    const run = async (name, build) => {
      step = name;
      try {
        await tmux(build());
        return true;
      } catch (e) {
        fail(lease, name, e);
        return false;
      }
    };
    try {
      // Everything that decides a zoom toggle is read inside the pane lock (review I1): the lock can wait behind a draft write,
      // and a user's C-b z or focus change in that time must not meet a blind resize-pane -Z built from an older listing.
      await lock(p, async () => {
        let snap;
        try {
          snap = await listing(); // R0
        } catch (e) {
          if (isNoServer(e)) {
            dropped = true;
            return;
          }
          throw e;
        }
        const win = rowsOf(snap, w);
        if (win.length === 0 || win[0].tag !== nonce) { // not our window (any more): touch nothing, and mark nothing (M4)
          dropped = true;
          return;
        }
        if (mark) setMark(w, mark);
        const zoomedNow = win[0].zoomed === 1;
        const activeNow = win.find((r) => r.active === 1)?.pane;
        // R1: is the layout still the one nika left? Judged on nika's size, before anything is undone.
        let unchanged = false;
        try {
          const cur = await readLayout(w);
          unchanged = cur !== null && strip(cur) === strip(lease.layout1) && win[0].panes === lease.panes;
        } catch (e) {
          fail(lease, 'R1', e);
        }
        let unzoomed = !zoomedNow;
        // R2: only a zoom nika made, and only while it still sits on the mirrored pane
        if (lease.zoomed0 === 0 && lease.panes > 1 && zoomedNow && activeNow === p) {
          unzoomed = await run('R2', () => ARGV.zoom(p));
          undone = unzoomed;
        }
        if (win[0].winW !== lease.width0 || win[0].winH !== lease.height0) await run('R3', () => ARGV.size(w, lease.width0, lease.height0));
        await run('R4', () => (lease.size0 === null ? ARGV.optUnset(w) : ARGV.optSet(w, lease.size0)));
        if (unchanged && unzoomed) await run('R5', () => ARGV.select(w, strip(lease.layout0)));
        if (lease.active0 !== p && activeNow === p && win.some((r) => r.pane === lease.active0)) await run('R6', () => ARGV.focus(lease.active0));
        await run('R8', () => ARGV.untag(w));
      });
    } catch (e) {
      if (held) register(lease);
      throw e;
    }
    if (dropped) return gone();
    await gone();
    try { // R9: look once, log a difference, never retry
      const after = rowsOf(await listing(), w);
      if (after.length > 0 && (after[0].tag !== '' || after[0].winW !== lease.width0 || after[0].winH !== lease.height0 || (undone && after[0].zoomed === 1))) {
        log(`nika: fit restore of ${w} differs after ${step}`);
      }
    } catch (e) {
      fail(lease, 'R9', e);
    }
    return 'released';
  }

  // ---- ACQUIRE (design 2.1 rows 6-12, 4 A1-A5) ----------------------------------------------------------------------------
  /** A5: read back what nika did; a mismatch (a user hook fights back) releases once, never loops. */
  async function verify(lease) {
    const snap = await listing();
    const m = snap.get(lease.pane);
    if (!m || m.window !== lease.window) {
      await releaseNow(lease);
      return NOT_FOUND;
    }
    const [ew, eh] = expOf(lease);
    const ok = m.tag === lease.nonce && m.panes === lease.panes && (lease.panes === 1 || (m.zoomed === 1 && m.active === 1))
      && m.winW === ew && m.winH === eh && m.paneW === ew && m.paneH === eh;
    const layout = ok ? await readLayout(lease.window) : null;
    if (layout !== null) lease.layout1 = layout;
    const text = layout !== null ? leaseText(lease) : null;
    if (text === null || Buffer.byteLength(text) > LEASE_FILE_MAX) {
      await releaseNow(lease, 'changed');
      return restored(lease, 'changed');
    }
    await writeLease(lease, text); // the file always describes the window as nika left it
    lease.seen = [m.paneW, m.paneH];
    return answer(lease);
  }

  async function acquire(id, C, R, snap, me) {
    const w = me.window;
    const a0 = rowsOf(snap, w).find((r) => r.active === 1)?.pane;
    const o0 = await readOption(w);
    if (o0 === undefined) return fromRow('blocked', 'size-option', me);
    if (me.zoomed === 1 && a0 !== id) return fromRow('blocked', 'user-zoom', me); // the user zoomed another pane: leave it (owner answer Q1)
    if (!a0) return fromRow('blocked', 'changed', me);
    const layout0 = await readLayout(w);
    if (layout0 === null) return fromRow('blocked', 'changed', me);
    const { fits, target } = plan(me.panes, C, R, me.winW, me.winH);
    const lease = {
      v: 1, nonce: randomBytes(8).toString('hex'), window: w, pane: id, panes: me.panes, zoomed0: me.zoomed, active0: a0, width0: me.winW, height0: me.winH,
      size0: o0, layout0, layout1: layout0, cols: C, rows: R, resized: target[0] !== me.winW || target[1] !== me.winH, userZoom: me.zoomed === 1, at: now(), lastBeat: now(),
      state: fits ? 'fitted' : 'zoomed', reason: fits ? null : 'panel-smaller', seen: [me.paneW, me.paneH], pre: [me.paneW, me.paneH], done: false,
    };
    const text = leaseText(lease);
    if (Buffer.byteLength(text) > LEASE_FILE_MAX) return fromRow('blocked', 'changed', me);
    await writeLease(lease, text); // A1: before the first tmux change
    register(lease);
    let entered = false;
    let refusal = null;
    try {
      await lock(id, async () => {
        entered = true;
        // The listing the decision rests on is older than the lock wait (review I1): look again, and touch nothing when the user moved on.
        const fresh = await listing();
        const m = claudePane(fresh, id);
        if (!m || m.window !== w) {
          refusal = NOT_FOUND;
          return;
        }
        const a = rowsOf(fresh, w).find((r) => r.active === 1)?.pane;
        const same = m.panes === me.panes && m.zoomed === me.zoomed && a === a0 && m.tag === '' && m.winW === me.winW && m.winH === me.winH
          && m.paneW === me.paneW && m.paneH === me.paneH;
        // layout0 and o0 are what a later restore puts back: read after the wait, a user's change in it must not be undone by that restore
        if (!same || strip((await readLayout(w)) ?? '') !== strip(layout0) || (await readOption(w)) !== o0) {
          refusal = fromRow('blocked', 'changed', m);
          return;
        }
        await tmux(ARGV.tag(w, lease.nonce)); // A2
        if (me.panes > 1 && me.zoomed === 0) await tmux(ARGV.zoom(id)); // A3: only a window nobody has zoomed
        if (lease.resized) await tmux(ARGV.size(w, target[0], target[1])); // A4
      });
    } catch (e) {
      if (!entered && paneBusy(e)) { // the lock never ran: nothing was changed, so there is nothing to give back
        await dropLease(lease);
        throw e;
      }
      await releaseNow(lease).catch((x) => fail(lease, 'cleanup', x));
      throw e;
    }
    if (refusal) { // nothing was changed; no mark either: the next heartbeat looks at the window as it is then
      await dropLease(lease);
      return refusal;
    }
    try {
      return await verify(lease); // A5
    } catch (e) {
      await releaseNow(lease).catch((x) => fail(lease, 'cleanup', x));
      throw e;
    }
  }

  /** The page asks again with the lease it holds and a new size (design 2.2). */
  async function renew(lease, C, R, snap, me) {
    if (observe(lease, snap)) { // the user changed the window since the last tick: release, never re-assert
      await releaseNow(lease, 'user-change');
      return restored(lease, 'user-change');
    }
    lease.lastBeat = now();
    const { fits, target } = plan(lease.panes, C, R, lease.width0, lease.height0);
    const [ew, eh] = expOf(lease);
    const kept = { cols: lease.cols, rows: lease.rows, state: lease.state, reason: lease.reason, resized: lease.resized };
    Object.assign(lease, { cols: C, rows: R, state: fits ? 'fitted' : 'zoomed', reason: fits ? null : 'panel-smaller' });
    if (target[0] === ew && target[1] === eh) {
      lease.seen = [me.paneW, me.paneH];
      return answer(lease);
    }
    lease.resized = target[0] !== lease.width0 || target[1] !== lease.height0;
    try {
      await lock(lease.pane, () => tmux(ARGV.size(lease.window, target[0], target[1])));
      return await verify(lease);
    } catch (e) {
      if (paneBusy(e)) { // the step never ran: the window is as it was, so is the lease (the next request or tick goes on from here)
        Object.assign(lease, kept);
        throw e;
      }
      await releaseNow(lease).catch((x) => fail(lease, 'cleanup', x));
      throw e;
    }
  }

  /** Inside the window queue, with a listing that is fresh enough: the decision table of design 2.1, first matching row wins. */
  async function decide(id, C, R, open, snap0, me0) {
    let snap = snap0;
    let me = me0;
    const w = me.window;
    const look = async () => {
      snap = await listing();
      me = claudePane(snap, id);
      return me !== null && me.window === w;
    };
    let lease = leases.get(w);
    if (lease && lease.nonce !== me.tag) { // the tag is gone or not ours: the window is not the one nika fitted
      await dropLease(lease);
      lease = undefined;
    }
    if (!lease && me.tag !== '') { // row 2: a tag nika does not hold
      let rec = null;
      if (FIT_NONCE.test(me.tag)) {
        const read = await readLeaseFile(leaseName(me.tag));
        if (read.lease?.window === w) rec = read.lease;
      }
      if (!rec) return fromRow('blocked', 'foreign-tag', me);
      await releaseNow(rec); // a crash left it: give the window back, then go on
      if (!(await look())) return NOT_FOUND;
      if (me.tag !== '') return fromRow('blocked', 'foreign-tag', me);
    }
    if (lease && lease.pane !== id) { // rows 3-4: the window belongs to another pane's page
      if (!open) return fromRow('other', null, me);
      await releaseNow(lease); // the last opened page wins
      lease = undefined;
      if (!(await look())) return NOT_FOUND;
    }
    if (lease) return renew(lease, C, R, snap, me);
    if (open) {
      marks.delete(w);
      notes.delete(w);
    } else if (marks.has(w)) {
      return fromRow('blocked', marks.get(w), me); // off until the page opens the session window again (owner answer Q6)
    } else if (notes.has(w)) {
      if (now() - notes.get(w) <= NOTE_MS) return fromRow('blocked', 'user-change', me); // M1: the page just closed; this is its last heartbeat in flight
      notes.delete(w);
    }
    return acquire(id, C, R, snap, me);
  }

  // ---- the interface ------------------------------------------------------------------------------------------------------
  async function hold(id, req) {
    const checked = checkFitBody(req);
    if (!matches(PANE_ID, id)) return invalid('invalid pane id');
    if (checked.error) return invalid(checked.error);
    const { cols, rows, open } = checked.value;
    try {
      const mine = byPane(id);
      if (mine && mine.cols === cols && mine.rows === rows) { // a heartbeat at the held size: nothing to ask tmux
        mine.lastBeat = now();
        return answer(mine);
      }
      const f0 = finished;
      const snap = await listing();
      const me = claudePane(snap, id);
      if (!me) return NOT_FOUND;
      return await enqueue(me.window, id, true, async (waited) => {
        if (!waited && f0 === finished) return decide(id, cols, rows, open, snap, me);
        const again = await listing(); // something ran on tmux since the first listing: decide on a fresh one
        const now_ = claudePane(again, id);
        if (!now_) return NOT_FOUND;
        return now_.window === me.window ? decide(id, cols, rows, open, again, now_) : BUSY;
      });
    } catch (e) {
      if (e?.tmux) return tmuxFailure(e);
      if (paneBusy(e)) return PANE_BUSY;
      throw e;
    }
  }

  async function release(id) {
    if (!matches(PANE_ID, id)) return invalid('invalid pane id');
    const lease = byPane(id);
    if (!lease) return { status: 200, body: { released: false } };
    try {
      await releaseQueued(lease);
    } catch (e) {
      if (e?.tmux) return tmuxFailure(e);
      if (paneBusy(e)) return PANE_BUSY; // the lease stays (releaseNow put it back): the page's next request or the watch retries
      throw e;
    }
    notes.delete(lease.window);
    notes.set(lease.window, now());
    if (notes.size > NOTES_MAX) notes.delete(notes.keys().next().value);
    return { status: 200, body: { released: true } };
  }

  /** For spawn: give a window back before a split lands in it. Rejects with tmux's error when the restore could not be read. */
  async function releaseWindow(w) {
    const lease = matches(WINDOW_ID, w) ? leases.get(w) : undefined;
    if (!lease) return false;
    await releaseQueued(lease);
    return true;
  }

  async function releaseAll() {
    if (leases.size === 0) return 0;
    let released = 0;
    const all = [...leases.values()].map((l) => releaseQueued(l).then(() => { released += 1; }, (e) => fail(l, 'releaseAll', e)));
    await within(Promise.all(all), RELEASE_ALL_MS);
    return released;
  }

  /** At app-tier start: restore what a crash left. Lease files are nika's own: read through fsafe, shape-checked, and used only for the window they name. */
  async function recover() {
    const out = { released: 0, dropped: 0 };
    const work = (async () => {
      if (!(await isRealDir(dir))) return;
      const found = (await fs.readdir(dir)).filter((n) => FILE_NAME.test(n)).sort();
      if (found.length > LEASE_FILES_MAX) log(`nika: fit recover read ${LEASE_FILES_MAX} of ${found.length} lease files`); // counts only, never names (M3)
      const names = found.slice(0, LEASE_FILES_MAX);
      for (const name of names) {
        const read = await readLeaseFile(name);
        if (read.invalid) out.dropped += 1;
        if (!read.lease) continue;
        try {
          out[(await releaseQueued(read.lease)) === 'released' ? 'released' : 'dropped'] += 1;
        } catch (e) {
          fail(read.lease, 'recover', e);
        }
      }
    })();
    await within(work, RELEASE_ALL_MS);
    return out;
  }

  return { hold, release, releaseWindow, releaseAll, recover, size: () => leases.size };
}
