// Fit controller for the app tier (nika 0.5, W7, ADR 0017): zooms the mirrored pane, resizes its tmux window only when that is
// safe, keeps one lease per tmux window and gives back exactly what it changed. The routes (api-app.js) and the page
// (public/session.js) only call it; this module owns every tmux argv of the fit (api-app.md section 8).
//
// Where the truth lives (design-W7 section 3): server memory (`leases`), a 0600 lease file in nika's state dir (crash
// recovery) and the window tag `@nika-fit <nonce>` (proof that the window is the same one and ours). Every tmux target and
// every stored value comes from tmux's own listing in the same call; the request contributes only `cols`, `rows`, `open` and (F9)
// the boolean `focus`.
//
// nika never fights the user: once the window differs from what nika set it releases and stays off (`blocked`) until the
// session window is opened again or the user presses Fit again (both `open: true`). It never toggles a zoom it did not make and
// never applies a saved layout when the layout, the pane count or a zoom changed. The one exception is nika's own doing (F2,
// design-F12 section 3): a split or an exit of a pane tagged `@nika-role` agent or sub-orchestrator is not the user's, so the
// window is given back and fitted again at once ("refit"); a new pane with no role yet gets one watch tick to be tagged.
// F4 (design-F4): while the session window has no focus nika never resizes a window that a terminal shows (`#{window_active_clients}` above 0).
// It only zooms the pane and the page scales the text (state `terminal`). A `terminal` lease is sized to the panel again only after no terminal
// showed the window for GROW_MS. The restore resizes back only a size nika set.
// F9 (design-F9, owner ruling 2026-11-16, "the focused one wins"): the page sends its focus with every request (`focus`, a boolean, false when
// absent). A page with focus gets the panel's size even while a terminal shows the window (the terminal shows dots); a page without focus yields
// as in F4. Every size switch is one in place move on the same lease, with no release and no change of tag or zoom: GIVE (the window's own size
// back, then its `window-size` option) and TAKE (the panel's size). At most TAKE_MAX focus takes per window in TAKE_SPAN_MS; a give is never limited.
// F15 (design F13 section 3 as changed by the owner's answers, 2026-11-16, "resize while zoomed"): while the page has focus any pane may be squeezed, whatever the
// other panes of the window run: the zoom hides them and tmux shrinks them with the window. A take that sizes a window with several panes below its own size reads
// the window's layout in the same locked listing right before the resize and keeps it in memory (`layoutT`, never in the lease file). The give then does R3, R4,
// `select-layout` of that layout (which unzooms) and `resize-pane -Z` of the mirrored pane again, and reads the window back; any mismatch releases with `changed`.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PANE_ID, WINDOW_ID, FIT_NONCE, CLAUDE_COMMAND } from './ids.js';
import { ensureDir, writeAtomic, removeOwnFile } from './fwrite.js';
import { openRegular, readAt, isRealDir } from './fsafe.js';
import { tmuxFailure, NO_TMUX_SERVER } from './tmuxerr.js';

export const LAPSE_MS = 15000; // no heartbeat for this long: the page is gone, restore
export const WATCH_MS = 1000; // server tick while any lease is held
export const GROW_MS = 30000; // F4: a terminal lease is sized to the panel again only after no terminal showed its window for this long
export const RELEASE_ALL_MS = 3000; // bound of releaseAll() and recover()
export const LEASE_FILE_MAX = 16 * 1024;
export const LEASE_FILES_MAX = 20;
export const FIT_RATE = 4; // requests per second per pane for each method (PUT and DELETE have separate buckets); enforced by the route
export const TAKE_MAX = 12; // F9: at most this many focus takes that resize, per window, in TAKE_SPAN_MS
export const TAKE_SPAN_MS = 60000;
const TAKES_MAX = 64; // F9: windows remembered by `takes` (the oldest is dropped first), like MARKS_MAX
const MARKS_MAX = 64;
const NOTE_MS = 2000; // a PUT open:false this soon after the page's own DELETE is a late heartbeat, not a page that wants the window
const NOTES_MAX = 64;

const SIZE_OPTIONS = new Set(['latest', 'largest', 'smallest', 'manual']);
const LAYOUT = /^[\x20-\x7e]{1,8192}$/; // tmux's own `#{window_layout}`: printable ASCII; `#` is refused separately
const FILE_NAME = /^fit-([0-9a-f]{16})\.json$/;
const FIT_FORMAT = ['#{pane_id}', '#{window_id}', '#{window_panes}', '#{window_zoomed_flag}', '#{pane_active}', '#{window_width}', '#{window_height}',
  '#{pane_width}', '#{pane_height}', '#{pane_current_command}', '#{@nika-fit}', '#{@nika-role}', '#{window_active_clients}'].join('\t');
/** The `@nika-role` values of the panes nika's own spawn splits into a window (F2). Never `orchestrator`; any other text is no role. */
const NIKA_PANES = new Set(['agent', 'sub-orchestrator']);
const FILE_KEYS = ['v', 'nonce', 'window', 'pane', 'panes', 'zoomed0', 'active0', 'width0', 'height0', 'size0', 'layout0', 'layout1', 'cols', 'rows', 'resized', 'userZoom', 'at'];
const BODY_MESSAGE = 'cols must be an integer 40–400, rows 10–200, open a boolean, focus a boolean when present';

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

/**
 * `{ value: { cols, rows, open, focus } }` for exactly `{ cols, rows, open }` or `{ cols, rows, open, focus }` in range (F9: `focus` a boolean; absent
 * reads as false, the safe side: an unfocused page yields to a terminal as in F4), else `{ error: <message> }`. The route and the controller share it.
 */
export function checkFitBody(body) {
  const keys = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  const hasFocus = keys !== null && Object.hasOwn(body, 'focus');
  const ok = keys !== null && keys.length === (hasFocus ? 4 : 3)
    && isInt(body.cols, 40, 400) && isInt(body.rows, 10, 200) && typeof body.open === 'boolean' && (!hasFocus || typeof body.focus === 'boolean');
  return ok ? { value: { cols: body.cols, rows: body.rows, open: body.open, focus: body.focus === true } } : { error: BODY_MESSAGE };
}

/** `list-panes -a` text → Map pane id → row; a row that does not parse is dropped. A tag that is not a nonce reads `?` (foreign), never trusted. */
function parseRows(stdout) {
  const rows = new Map();
  for (const line of String(stdout).split('\n')) {
    const f = line.split('\t');
    if (f.length !== 13) continue;
    const row = {
      pane: f[0], window: f[1], panes: digits(f[2], 1, 999), zoomed: bit(f[3]), active: bit(f[4]), winW: digits(f[5], 1, 10000), winH: digits(f[6], 1, 10000),
      paneW: digits(f[7], 1, 10000), paneH: digits(f[8], 1, 10000), command: f[9], tag: f[10] === '' || FIT_NONCE.test(f[10]) ? f[10] : '?',
      role: f[11], // exact text; compared only with NIKA_PANES
      clients: digits(f[12], 0, 9999), // F4: the window's terminals; compared only with 0
    };
    const numbers = [row.panes, row.zoomed, row.active, row.winW, row.winH, row.paneW, row.paneH, row.clients];
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
  // F4: a lease read from a file may have resized its window before the crash, so its restore sends the resize back (`sized`); `awayAt` is memory only.
  // F9: `focus` and `viewed` are memory only too (a lease from a file is only released, never moved)
  // F15: `layoutT` is memory only too (a crash recovery puts layout0 back)
  return { ...lease, lastBeat: at, state: null, reason: null, seen: null, done: false, known: null, waitAt: null, sized: true, awayAt: null, focus: false, viewed: false, layoutT: null };
}
const fileOf = (l) => Object.fromEntries(FILE_KEYS.map((k) => [k, l[k]]));
const leaseText = (l) => JSON.stringify(fileOf(l));
const leaseName = (nonce) => `fit-${nonce_(nonce)}.json`;
/** The window size nika expects while it holds the lease: the panel's after a resize, else the original. */
const expOf = (l) => (l.resized ? [l.cols, l.rows] : [l.width0, l.height0]);
/**
 * F4 + F9: `yields` = a terminal shows the window and the page has no focus (or a refit keeps the terminal form): then nika never resizes it. Else
 * resize only when it cannot squeeze other panes: one pane, or a panel at least as big as the window (design 2.1 rows 8, 11, 12; design-F4 section 3.1).
 * F15: or when the page has focus (`focus`): then the panel's size wins over the other panes too.
 */
function plan(panes, C, R, w0, h0, yields = false, focus = false) {
  if (yields) return { target: [w0, h0], state: 'terminal', reason: null };
  const fits = panes === 1 || (C >= w0 && R >= h0) || focus; // F15: a page with focus gets the panel's size even when that squeezes the other panes
  return { target: fits ? [C, R] : [w0, h0], state: fits ? 'fitted' : 'zoomed', reason: fits ? null : 'panel-smaller' };
}
/** F15: the target is smaller than the window's own size in either direction, with several panes: the others are squeezed (the zoom hides them). */
const squeezes = (panes, target, w0, h0) => panes > 1 && (target[0] < w0 || target[1] < h0);
/** F15: the layout a give puts back: tmux's own text for the window (already checked by readLayout), markers stripped (they would move focus, spike S10), checked again like layout0. null: not one nika may apply. */
const turnBack = (raw) => {
  const text = raw === null ? '' : strip(raw);
  return validLayout(text) ? text : null;
};
/** F4: the lease is in the terminal form: a terminal sizes the window, nika only keeps the tag and the zoom. Memory only, never in the lease file. */
const toTerminal = (l) => { l.state = 'terminal'; l.reason = null; l.awayAt = null; };
/** F4 + F9: the lease keeps the terminal form: the page has no focus, the lease has the form, and no terminal has been away for GROW_MS yet. */
const holdsTerminal = (l, at) => !l.focus && l.state === 'terminal' && !(l.awayAt !== null && at - l.awayAt >= GROW_MS);

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
 * hold(id, { cols, rows, open, focus }) and release(id) return { status, body } like the other controllers; releaseWindow(w) → boolean;
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
  const takes = new Map(); // F9: @W → times of the last focus takes that sent resize-window (memory only, TAKES_MAX windows)
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
  /**
   * F2: nika's own agent panes came or went. Give the window back (no mark) and fit it again at once with the size the page asked for last,
   * through the same decision table as a page request (a mark, a fresh note of the page's DELETE, a foreign tag or a refusal still wins).
   * The new lease keeps the old heartbeat: only the page's own request keeps a lease alive, so a page that went away still lapses on time.
   */
  const refitQueued = (lease) => enqueue(lease.window, lease.pane, false, async () => {
    if (lease.done) return 'dropped';
    const stay = holdsTerminal(lease, now()); // F4: a refit (an agent's split, say) never ends the GROW_MS grace early: it takes the window again without a resize
    const out = await releaseNow(lease);
    if (out !== 'released') return out;
    const snap = await listing();
    const me = claudePane(snap, lease.pane);
    if (!me || me.window !== lease.window) return out;
    await decide(lease.pane, lease.cols, lease.rows, false, lease.focus, snap, me, stay);
    const next = leases.get(lease.window);
    if (next && next !== lease && next.pane === lease.pane) {
      next.lastBeat = lease.lastBeat;
      if (stay && next.state === 'terminal') next.awayAt = lease.awayAt; // the grace goes on where it was
    }
    return out;
  });
  /**
   * F9: one in place move (`give` or `take`) from the watch, inside the window queue like a refit. A move that cannot start because the pane is busy keeps
   * the lease (the next tick tries again); any other failure logs one line and gives the window back with no mark: never a retry loop.
   */
  const moveQueued = (lease, act) => enqueue(lease.window, lease.pane, false, async () => {
    if (lease.done || leases.get(lease.window) !== lease) return 'dropped';
    try {
      return await (act === 'give' ? give(lease) : take(lease));
    } catch (e) {
      fail(lease, act, e);
      if (!paneBusy(e)) await releaseNow(lease).catch((x) => fail(lease, 'cleanup', x));
      return 'failed';
    }
  });
  /** F9: the same move from a page request (inside the window queue already): a failure other than a busy pane gives the window back, then reaches the caller. */
  async function inPlace(lease, act, size) {
    try {
      return await (act === 'give' ? give(lease, size) : take(lease, size));
    } catch (e) {
      if (!paneBusy(e)) await releaseNow(lease).catch((x) => fail(lease, 'cleanup', x));
      throw e;
    }
  }

  // ---- what the watch and a renew look at ---------------------------------------------------------------------------------
  const USER = { act: 'release', mark: 'user-change' };
  const AGAIN = Symbol('again'); // renew gave the window back for F2's refit: decide goes on to acquire
  // F4 verdicts (design-F4 section 4.1). VIEW and AWAY only change memory.
  const VIEW = { act: 'view' }; // a terminal shows a window nika did not resize: the lease becomes `terminal`, no tmux call
  const AWAY = { act: 'away' }; // terminal lease, no terminal now, the GROW_MS grace is not over: the watch notes when it started
  // F9 verdicts (replace F4's SHRINK and GROW refits): in place moves on the same lease
  const GIVE = { act: 'give' }; // the page has no focus and a terminal shows a window nika resized: the window's size goes back to the terminal
  const TAKE = { act: 'take' }; // the page has focus (or the terminal has been away for GROW_MS): plan the window again with the panel's size
  /** F2: the panes of the lease's window as nika last saw them: true for a pane whose role is one of NIKA_PANES. Memory only, never in the lease file. */
  const remember = (lease, snap) => { lease.known = new Map(rowsOf(snap, lease.window).map((r) => [r.pane, NIKA_PANES.has(r.role)])); };
  /**
   * null (all as nika left it), { act: 'drop' } (tag or window gone: ids may be reused, touch nothing), { act: 'release', mark? },
   * { act: 'refit' } (only nika's own agent panes came or went: give the window back and fit it again), { act: 'wait' } (a new pane has no role
   * yet: nika's spawn tags it right after the split, so look again at the next tick), (F4) { act: 'view' } / { act: 'away' } (memory only, see VIEW
   * and AWAY), or (F9) { act: 'give' } / { act: 'take' } (an in place move, see GIVE and TAKE). `at` is now().
   */
  function observe(lease, snap, at) {
    const win = rowsOf(snap, lease.window);
    if (win.length === 0 || win[0].tag !== lease.nonce) return { act: 'drop' };
    const m = snap.get(lease.pane);
    if (!m || m.window !== lease.window || !CLAUDE_COMMAND.test(m.command.trim())) return { act: 'release' };
    const viewed = m.clients > 0;
    const [ew, eh] = expOf(lease);
    // F4: a size nika set is always judged (no terminal can resize a `manual` window: a change of it is the user's). A window nika did not
    // resize follows its terminal while one shows it or while the lease is in the terminal form: its size is not judged then.
    const sizeOk = (!lease.resized && (viewed || lease.state === 'terminal')) || (m.winW === ew && m.winH === eh);
    const unzoomed = lease.panes > 1 && (m.zoomed !== 1 || m.active !== 1);
    const sameSet = !lease.known || (win.length === lease.known.size && win.every((r) => lease.known.has(r.pane)));
    if (!unzoomed && m.panes === lease.panes && sizeOk && sameSet) {
      // Judged here, inside "nothing else changed": a user who unzooms in the tick a terminal arrives or the focus changes stays a user change (W7 Q6)
      if (lease.focus) { // F9: the page has focus: the panel wins over any terminal
        if (lease.resized) return null; // the window has the panel's size (manual): nothing to do
        // the terminal form, a window that followed its terminal to another size, or (F15) a zoomed one the others of which the page may squeeze now: plan it again
        return lease.state === 'terminal' || lease.state === 'zoomed' || m.winW !== lease.width0 || m.winH !== lease.height0 ? TAKE : null;
      }
      // F15: the page has no focus and nika squeezed the window below its own size: the other panes get their size and layout back, whether or not a terminal
      // shows the window. Judged before the viewed rule.
      if (lease.resized && squeezes(lease.panes, [lease.cols, lease.rows], lease.width0, lease.height0)) return GIVE;
      if (viewed) return lease.resized ? GIVE : lease.state === 'terminal' ? null : VIEW;
      if (lease.state !== 'terminal') return null;
      return holdsTerminal(lease, at) ? AWAY : TAKE;
    }
    // Something changed. Only nika's own agent panes coming or going keeps the fit on. A split (without -Z) unzooms the window and
    // makes the new pane active, and so does a pane that exits: when panes came or went, the zoom and the active pane say nothing about the user.
    if (!sizeOk) return USER; // neither a split nor an exit resizes the window: a size change is someone else's (not a terminal's, F4)
    if (!lease.known || win.length !== m.panes) return USER; // nothing to compare with, or a row of the window did not parse (fail closed)
    const ids = new Set(win.map((r) => r.pane));
    const added = win.filter((r) => !lease.known.has(r.pane));
    const removed = [...lease.known.keys()].filter((p) => !ids.has(p));
    if (added.length === 0 && removed.length === 0) return USER; // the same panes: an unzoom, a focus change or a count that does not add up
    if (removed.some((p) => lease.known.get(p) !== true)) return USER; // a pane that was not nika's agent went away (a gone pane has no tags to read)
    if (added.every((r) => NIKA_PANES.has(r.role))) return { act: 'refit' };
    return lease.waitAt === null || at - lease.waitAt < WATCH_MS ? { act: 'wait' } : USER; // one tick of grace for the spawn to tag its split
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
        const row = snap.get(lease.pane);
        if (row) lease.viewed = row.clients > 0; // F9: the answer of a heartbeat says `terminal` for a fitted window a terminal shows; it reads this
        let verdict = observe(lease, snap, now());
        // a page that is gone (no heartbeat for LAPSE_MS) is never kept waiting for, never refitted, given a move or moved to the terminal form: its window is only given back
        if (now() - lease.lastBeat > LAPSE_MS && (!verdict || ['wait', 'refit', 'view', 'away', 'give', 'take'].includes(verdict.act))) verdict = { act: 'release' };
        if (verdict?.act === 'take' && lease.focus && capped(lease.window, now())) { // F9: 12 focus takes in the last minute: wait for it to free up (memory only)
          if (lease.state === 'terminal') lease.reason = 'switching';
          verdict = null;
        }
        if (!verdict || verdict.act === 'view' || verdict.act === 'away') {
          remember(lease, snap); // the roles may have been set since the last look
          lease.waitAt = null;
          if (verdict?.act === 'view') toTerminal(lease); // F4: memory only, no tmux call
          else if (verdict?.act === 'away') lease.awayAt ??= now(); // F4: the grace of GROW_MS starts at the first tick that sees no terminal
          else lease.awayAt = null; // a terminal shows it again (or nothing changed): the grace starts over next time
          continue;
        }
        if (verdict.act === 'wait') {
          lease.waitAt ??= now();
          continue;
        }
        if (verdict.act === 'drop') await dropLease(lease);
        else if (verdict.act === 'refit') await refitQueued(lease).catch((e) => fail(lease, 'refit', e));
        else if (verdict.act === 'give' || verdict.act === 'take') await moveQueued(lease, verdict.act);
        else await releaseQueued(lease, verdict.mark).catch((e) => fail(lease, 'watch', e));
      }
    } finally {
      ticking = false;
    }
  }

  // ---- answers ------------------------------------------------------------------------------------------------------------
  const reply = (state, reason, size, panes, userZoom) => ({ status: 200, body: { fit: { state, reason, pane: { cols: size[0], rows: size[1] }, panes, userZoom } } });
  const fromRow = (state, reason, row) => reply(state, reason, [row.paneW, row.paneH], row.panes, row.zoomed === 1 && row.active === 1);
  /**
   * F9: `fitted` says when a terminal shows the window too (nika sized it to the panel because the page has focus; the terminal shows dots), and
   * `switching` is said only to a page with focus (a blur after the cap leaves a plain `terminal`).
   */
  const reasonOf = (l) => (l.state === 'fitted' && l.viewed ? 'terminal' : l.state === 'terminal' ? (l.focus && l.reason === 'switching' ? 'switching' : null) : l.reason);
  const answer = (l) => reply(l.state, reasonOf(l), l.seen, l.panes, l.userZoom);
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
        // R3 (F4): the resize back only for a size nika set (or may have set, before a crash): a terminal lease's window follows its terminal
        if (lease.sized && (win[0].winW !== lease.width0 || win[0].winH !== lease.height0)) await run('R3', () => ARGV.size(w, lease.width0, lease.height0));
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
      // R9 (F4): the size is compared only for a lease nika resized, and not while a terminal shows the window (it follows that terminal now)
      const sizeBack = (row) => !lease.sized || row.clients > 0 || (row.winW === lease.width0 && row.winH === lease.height0);
      if (after.length > 0 && (after[0].tag !== '' || !sizeBack(after[0]) || (undone && after[0].zoomed === 1))) {
        log(`nika: fit restore of ${w} differs after ${step}`);
      }
    } catch (e) {
      fail(lease, 'R9', e);
    }
    return 'released';
  }

  // ---- ACQUIRE (design 2.1 rows 6-12, 4 A1-A5) ----------------------------------------------------------------------------
  /**
   * A5: read back what nika did; a mismatch (a user hook fights back) releases once, never loops. F15: `back` = the layout a give has just put back: the
   * window must also have its own size and exactly that layout (markers stripped), else it is released with `changed`.
   */
  async function verify(lease, back = null) {
    const snap = await listing();
    const m = snap.get(lease.pane);
    if (!m || m.window !== lease.window) {
      await releaseNow(lease);
      return NOT_FOUND;
    }
    const [ew, eh] = expOf(lease);
    const term = lease.state === 'terminal'; // F4: the terminal sizes the window: only the tag, the pane count and the zoom are nika's to check
    // The pane height may be eh or eh-1: tmux reserves one row for `pane-border-status top|bottom` even on a zoomed or only pane.
    const ok = m.tag === lease.nonce && m.panes === lease.panes && (lease.panes === 1 || (m.zoomed === 1 && m.active === 1))
      && (term || (m.winW === ew && m.winH === eh && m.paneW === ew && (m.paneH === eh || m.paneH === eh - 1)))
      && (back === null || (m.winW === lease.width0 && m.winH === lease.height0));
    const read = ok ? await readLayout(lease.window) : null;
    const layout = read !== null && (back === null || strip(read) === back) ? read : null;
    if (layout !== null) lease.layout1 = layout;
    const text = layout !== null ? leaseText(lease) : null;
    if (text === null || Buffer.byteLength(text) > LEASE_FILE_MAX) {
      await releaseNow(lease, 'changed');
      return restored(lease, 'changed');
    }
    await writeLease(lease, text); // the file always describes the window as nika left it
    lease.seen = [m.paneW, m.paneH];
    remember(lease, snap); // F2: the panes of the window as nika left it
    lease.waitAt = null;
    lease.viewed = m.clients > 0;
    // F9 (spike S16 race): a terminal came between nika's resize and this read-back while the page has no focus: give the size back in place, in this
    // request. `give` ends in this function with `resized` false, so it can never come back here to give again.
    if (lease.resized && m.clients > 0 && !lease.focus) return give(lease);
    return answer(lease);
  }

  // ---- GIVE and TAKE (F9): in place, inside the window queue; each tmux change inside the pane lock --------------------------------
  const capped = (w, at) => (takes.get(w) ?? []).filter((t) => at - t < TAKE_SPAN_MS).length >= TAKE_MAX;
  function noteTake(w, at) {
    const t = (takes.get(w) ?? []).filter((x) => at - x < TAKE_SPAN_MS);
    t.push(at);
    takes.delete(w);
    takes.set(w, t.slice(-TAKE_MAX));
    if (takes.size > TAKES_MAX) takes.delete(takes.keys().next().value);
  }
  /**
   * Plan the window again with the panel's size: focus came, the terminal has been away for GROW_MS, or a terminal resized a window nika did not.
   * No release, no tag change, no zoom change. A page with focus is held to TAKE_MAX resizing takes per window in TAKE_SPAN_MS; a take that is
   * not allowed answers `terminal / switching` and the watch takes when the minute frees up.
   */
  async function take(lease, size = null) {
    const w = lease.window;
    // `size` = [cols, rows] of the request that asked for the move: kept only once the move is allowed to go on (the lease is judged against the
    // size it holds, so a new panel size is never written before the window has been looked at)
    const adopt = () => { if (size) Object.assign(lease, { cols: size[0], rows: size[1] }); };
    if (lease.focus && capped(w, now())) {
      if (lease.state === 'terminal') lease.reason = 'switching';
      adopt(); // a take that is not allowed: nothing is resized or judged, and the watch takes with the newest panel size when the minute frees up
      return answer(lease);
    }
    let out = 'skip';
    await lock(lease.pane, async () => {
      const snap = await listing();
      const v = observe(lease, snap, now());
      if (v?.act !== 'take') {
        out = v?.act === 'release' && v.mark ? 'user' : 'skip';
        return;
      }
      // a window-size the user set while nika held none is the user's: while nika holds a size it set, the option is `manual` (its own resize-window)
      if ((await readOption(w)) !== (lease.sized ? 'manual' : lease.size0)) {
        out = 'user';
        return;
      }
      const m = snap.get(lease.pane);
      adopt();
      if (!lease.sized) { // the window's own size now (it followed its terminal): the restore's R3 target. A size nika set is not the window's own.
        lease.width0 = m.winW;
        lease.height0 = m.winH;
      }
      lease.viewed = m.clients > 0;
      let { target, state, reason } = plan(lease.panes, lease.cols, lease.rows, m.winW, m.winH, lease.viewed && !lease.focus, lease.focus);
      if (squeezes(lease.panes, target, m.winW, m.winH)) {
        // F15: the layout to put back on the give, read in this lock, from the listing that decided the take, right before the resize. If it cannot be kept
        // there is nothing to put back: fail closed, the pane is zoomed and the text scaled as without focus.
        const layoutT = turnBack(await readLayout(w));
        if (layoutT === null) ({ target, state, reason } = plan(lease.panes, lease.cols, lease.rows, m.winW, m.winH, false, false));
        else lease.layoutT = layoutT;
      }
      Object.assign(lease, { state, reason, awayAt: null, resized: target[0] !== lease.width0 || target[1] !== lease.height0 });
      if (target[0] !== m.winW || target[1] !== m.winH) {
        lease.sized = true; // set before the call, as in A4: a call that failed may still have resized the window
        if (lease.focus) noteTake(w, now());
        await tmux(ARGV.size(w, target[0], target[1]));
      }
      out = 'done';
    });
    if (out === 'user') {
      await releaseNow(lease, 'user-change');
      return restored(lease, 'user-change');
    }
    return out === 'done' ? verify(lease) : answer(lease);
  }
  /**
   * Give the window's size back to the terminal that shows it: the page lost focus, or a terminal came to a window nika resized while the page has none.
   * The lease, the tag and the zoom stay. The resize back goes to the window's own size from just before nika's last resize (width0/height0).
   * F15: a window nika squeezed (several panes, below its own size) gets its layout back too, whether or not a terminal shows it: after R3 and R4 the layout
   * the take read (`layoutT`) is applied, which unzooms the window, and the mirrored pane is zoomed again; the read-back must show that layout, the window's own
   * size and the zoom (verify). Without a terminal such a lease is `zoomed / panel-smaller` afterwards.
   */
  async function give(lease, size = null) {
    const w = lease.window;
    let out = 'skip';
    let back = null; // F15: the layout put back
    await lock(lease.pane, async () => {
      const snap = await listing();
      const row = snap.get(lease.pane);
      if (row) lease.viewed = row.clients > 0; // the terminal may have left since the verdict: the answer below must not say it still shows the window
      const v = observe(lease, snap, now());
      if (v?.act !== 'give') {
        out = v?.act === 'release' && v.mark ? 'user' : 'skip';
        return;
      }
      const m = snap.get(lease.pane);
      if (lease.sized && (m.winW !== lease.width0 || m.winH !== lease.height0)) await tmux(ARGV.size(w, lease.width0, lease.height0)); // R3
      await tmux(lease.size0 === null ? ARGV.optUnset(w) : ARGV.optSet(w, lease.size0)); // R4: the window follows its terminal again
      const alone = !lease.viewed && squeezes(lease.panes, [lease.cols, lease.rows], lease.width0, lease.height0); // F15: squeezed, and nobody else shows the window
      if (lease.layoutT !== null) {
        await tmux(ARGV.select(w, lease.layoutT)); // F15: the layout from before the squeeze; tmux unzooms the window (spike S10)
        // toggle the zoom only on a window that shows unzoomed now, never one that is still (or again) zoomed or whose pane left
        const after = (await listing()).get(lease.pane);
        if (after?.window === w && after.zoomed === 0) await tmux(ARGV.zoom(lease.pane));
        back = lease.layoutT;
      }
      lease.resized = false;
      lease.sized = false; // only after the calls: a call that failed leaves the restore's R3 armed
      lease.layoutT = null;
      if (alone) Object.assign(lease, { state: 'zoomed', reason: 'panel-smaller', awayAt: null });
      else {
        lease.viewed = true;
        toTerminal(lease);
      }
      if (size) Object.assign(lease, { cols: size[0], rows: size[1] }); // only now: while the lease was resized, its cols and rows are the size the window must have
      out = 'done';
    });
    if (out === 'user') {
      await releaseNow(lease, 'user-change');
      return restored(lease, 'user-change');
    }
    return out === 'done' ? verify(lease, back) : answer(lease);
  }

  /** `noResize`: the caller already knows a terminal has the window (a refit inside the terminal grace). `focus`: the page has focus (F9). */
  async function acquire(id, C, R, snap, me, noResize = false, focus = false) {
    const w = me.window;
    const a0 = rowsOf(snap, w).find((r) => r.active === 1)?.pane;
    const o0 = await readOption(w);
    if (o0 === undefined) return fromRow('blocked', 'size-option', me);
    if (me.zoomed === 1 && a0 !== id) return fromRow('blocked', 'user-zoom', me); // the user zoomed another pane: leave it (owner answer Q1)
    if (!a0) return fromRow('blocked', 'changed', me);
    const layout0 = await readLayout(w);
    if (layout0 === null) return fromRow('blocked', 'changed', me);
    const { target, state, reason } = plan(me.panes, C, R, me.winW, me.winH, noResize || (me.clients > 0 && !focus), focus);
    const lease = {
      v: 1, nonce: randomBytes(8).toString('hex'), window: w, pane: id, panes: me.panes, zoomed0: me.zoomed, active0: a0, width0: me.winW, height0: me.winH,
      size0: o0, layout0, layout1: layout0, cols: C, rows: R, resized: target[0] !== me.winW || target[1] !== me.winH, userZoom: me.zoomed === 1, at: now(), lastBeat: now(),
      state, reason, seen: [me.paneW, me.paneH], pre: [me.paneW, me.paneH], done: false, known: null, waitAt: null, sized: false, awayAt: null,
      focus, viewed: me.clients > 0, layoutT: null, // F9 and F15: memory only
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
        let now0 = null;
        if (!same || (now0 = await readLayout(w)) === null || strip(now0) !== strip(layout0) || (await readOption(w)) !== o0) {
          refusal = fromRow('blocked', 'changed', m);
          return;
        }
        if (squeezes(me.panes, target, me.winW, me.winH)) { // F15: this is the layout right before the resize; a give puts it back
          lease.layoutT = turnBack(now0);
          if (lease.layoutT === null) {
            refusal = fromRow('blocked', 'changed', m);
            return;
          }
        }
        if (m.clients > 0 && !focus) { // F4: a terminal came during the wait (the window still has the size nika planned on) and the page has no focus: no resize
          toTerminal(lease);
          lease.resized = false;
        }
        await tmux(ARGV.tag(w, lease.nonce)); // A2
        if (me.panes > 1 && me.zoomed === 0) await tmux(ARGV.zoom(id)); // A3: only a window nobody has zoomed
        if (lease.resized) { // A4
          lease.sized = true; // set before the call: a call that failed may still have resized the window
          await tmux(ARGV.size(w, target[0], target[1]));
        }
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
    const v = observe(lease, snap, now());
    lease.viewed = me.clients > 0;
    if (v?.act === 'refit') { // nika's own agent pane came or went before the watch saw it: give the window back, decide() fits it again
      await releaseNow(lease);
      return AGAIN;
    }
    if (v?.act === 'wait') { // an untagged new pane: no resize this time (only the watch starts and ends the grace)
      lease.lastBeat = now();
      return answer(lease);
    }
    if (v?.act === 'give' || v?.act === 'take') { // F9: the focus changed, a terminal came or left: the move runs in this request, at the page's size
      lease.lastBeat = now();
      return inPlace(lease, v.act, [C, R]);
    }
    if (v && v.act !== 'view' && v.act !== 'away') { // the user changed the window since the last tick: release, never re-assert
      await releaseNow(lease, 'user-change');
      return restored(lease, 'user-change');
    }
    if (v?.act === 'view') toTerminal(lease); // F4: a terminal shows a window nika did not resize (an 'away' goes on: only the watch sets awayAt)
    lease.lastBeat = now();
    if (lease.state === 'terminal') { // F4: the terminal sizes the window: no lock, no tmux call; the panel size is kept for the grow
      Object.assign(lease, { cols: C, rows: R });
      lease.seen = [me.paneW, me.paneH];
      return answer(lease);
    }
    const { state, reason, target } = plan(lease.panes, C, R, lease.width0, lease.height0, false, lease.focus);
    const [ew, eh] = expOf(lease);
    const kept = { cols: lease.cols, rows: lease.rows, state: lease.state, reason: lease.reason, resized: lease.resized, layoutT: lease.layoutT };
    Object.assign(lease, { cols: C, rows: R, state, reason });
    if (target[0] === ew && target[1] === eh) {
      lease.seen = [me.paneW, me.paneH];
      return answer(lease);
    }
    lease.resized = target[0] !== lease.width0 || target[1] !== lease.height0;
    try {
      let changed = false;
      let refit = false;
      let waiting = false;
      let viewing = false;
      let move = null; // F9: 'give' | 'take'
      let bare = false; // F15: the window is to be squeezed, but its layout cannot be kept: nothing is resized
      await lock(lease.pane, async () => {
        // N1: `snap` is older than the lock wait; a window the user changed meanwhile is released, never resized over. Judged against
        // the size nika holds (`kept`), not the one it is about to set. Nika's own agent split or exit (F2) is never resized over either,
        // and neither is a window a terminal came to meanwhile (F4: a resized lease is given back, a zoomed one becomes `terminal`).
        const v2 = observe({ ...lease, ...kept }, await listing(), now());
        if (v2) {
          if (v2.act === 'refit') refit = true;
          else if (v2.act === 'wait') waiting = true;
          else if (v2.act === 'view') viewing = true;
          else if (v2.act === 'give' || v2.act === 'take') move = v2.act;
          else changed = true; // 'away' needs a terminal lease, which returned above: only a user change is left
          return;
        }
        // F15: a window at its own size that is about to be squeezed: the layout to put back is read here, right before the resize. A window nika had grown
        // has no own-size layout to read (tmux scaled it), so it keeps none: its give is the plain one and the release's R5 puts layout0 back.
        if (lease.layoutT === null && !kept.resized && squeezes(lease.panes, target, lease.width0, lease.height0)) {
          lease.layoutT = turnBack(await readLayout(lease.window));
          if (lease.layoutT === null) { // fail closed, as the take does: nothing to put back, so nothing is squeezed
            bare = true;
            return;
          }
        }
        lease.sized = true; // set before the call, as in A4
        await tmux(ARGV.size(lease.window, target[0], target[1]));
      });
      if (waiting) { // an untagged new pane appeared during the wait: nothing was resized, the lease goes on as it was
        Object.assign(lease, kept);
        return answer(lease);
      }
      if (viewing) { // a terminal came during the wait to a window nika did not resize: nothing was resized, the lease is `terminal` at the panel's size
        Object.assign(lease, kept);
        toTerminal(lease);
        Object.assign(lease, { cols: C, rows: R });
        return answer(lease);
      }
      if (bare) { // F15: the pane stays zoomed at the window's own size, the text is scaled; the watch tries again as a take (focus and zoomed)
        Object.assign(lease, kept, { cols: C, rows: R, state: 'zoomed', reason: 'panel-smaller', seen: [me.paneW, me.paneH] });
        return answer(lease);
      }
      if (move) { // F9: nothing was resized in this turn; the lease goes on as it was, and the move runs in this same request with the page's size
        Object.assign(lease, kept);
        return await (move === 'give' ? give(lease, [C, R]) : take(lease, [C, R]));
      }
      if (refit) {
        Object.assign(lease, kept); // the lease must describe what nika did, not what it was about to do
        await releaseNow(lease);
        return AGAIN;
      }
      if (changed) {
        Object.assign(lease, kept);
        await releaseNow(lease, 'user-change');
        return await restored(lease, 'user-change');
      }
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
  async function decide(id, C, R, open, focus, snap0, me0, noResize = false) {
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
    if (lease) {
      const stay = holdsTerminal(lease, now()); // F4: judged before renew can change the lease
      const r = await renew(lease, C, R, snap, me);
      if (r !== AGAIN) return r;
      if (!(await look())) return NOT_FOUND;
      lease = undefined; // nika's own split or exit: falls through to the open / mark / note rows and acquire, in this same request
      noResize ||= stay; // a refit inside the terminal grace takes the window again without a resize
    }
    if (open) {
      marks.delete(w);
      notes.delete(w);
    } else if (marks.has(w)) {
      return fromRow('blocked', marks.get(w), me); // off until the page opens the session window again (owner answer Q6)
    } else if (notes.has(w)) {
      if (now() - notes.get(w) <= NOTE_MS) return fromRow('blocked', 'user-change', me); // M1: the page just closed; this is its last heartbeat in flight
      notes.delete(w);
    }
    return acquire(id, C, R, snap, me, noResize, focus);
  }

  // ---- the interface ------------------------------------------------------------------------------------------------------
  async function hold(id, req) {
    const checked = checkFitBody(req);
    if (!matches(PANE_ID, id)) return invalid('invalid pane id');
    if (checked.error) return invalid(checked.error);
    const { cols, rows, open, focus } = checked.value;
    try {
      const mine = byPane(id);
      const moved = mine !== undefined && mine.focus !== focus;
      if (mine) mine.focus = focus; // F9: memory only, recorded before anything can refuse the request: the watch acts on it within a second
      if (mine && !moved && mine.cols === cols && mine.rows === rows) { // a heartbeat at the held size and focus: nothing to ask tmux
        mine.lastBeat = now();
        return answer(mine);
      }
      const f0 = finished;
      const snap = await listing();
      const me = claudePane(snap, id);
      if (!me) return NOT_FOUND;
      return await enqueue(me.window, id, true, async (waited) => {
        if (!waited && f0 === finished) return decide(id, cols, rows, open, focus, snap, me);
        const again = await listing(); // something ran on tmux since the first listing: decide on a fresh one
        const now_ = claudePane(again, id);
        if (!now_) return NOT_FOUND;
        return now_.window === me.window ? decide(id, cols, rows, open, focus, again, now_) : BUSY;
      });
    } catch (e) {
      if (e?.tmux) return tmuxFailure(e);
      if (paneBusy(e)) return PANE_BUSY;
      throw e;
    }
  }

  async function release(id) {
    if (!matches(PANE_ID, id)) return invalid('invalid pane id');
    // F4 (owner answer Q5, the F2 DELETE-vs-refit race): the window is the lease's, or that of a queued operation of this pane (a refit between
    // its restore and its acquire holds no lease). The DELETE waits its turn and releases whatever lease the pane holds THEN, not the one it
    // found: a refit in front of it replaces the lease, and the new one must not stay held after the page closed.
    const w = byPane(id)?.window ?? [...queues].find(([, q]) => q.ops.some((o) => o.pane === id))?.[0];
    if (!w) return { status: 200, body: { released: false } };
    try {
      await enqueue(w, id, false, () => {
        const lease = byPane(id);
        return lease ? releaseNow(lease) : 'dropped';
      });
    } catch (e) {
      if (e?.tmux) return tmuxFailure(e);
      if (paneBusy(e)) return PANE_BUSY; // the lease stays (releaseNow put it back): the page's next request or the watch retries
      throw e;
    }
    notes.delete(w);
    notes.set(w, now());
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
