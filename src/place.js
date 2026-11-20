// Where a spawned agent's pane goes (0.5.4, P1, ADR 0021). Pure: no I/O, no clock, no tmux. doSpawn (src/spawn.js) reads one tmux listing
// of the target session (`list-panes -s -t =<session> -F PLACE_FORMAT`), hands its text to readPlaceListing() and the rows of a trusted listing to place(), which
// says which pane to split (and whether to re-tile the window afterwards) or that a new tmux window is needed. Every size and id comes from
// tmux's own listing; nothing here is read from a request. The floor is one number for every pane: MIN_COLS x MIN_ROWS.
import { PANE_ID, WINDOW_ID, parseAgentTag } from './ids.js';

export const MIN_COLS = 80;
export const MIN_ROWS = 15;
/** Name of the tmux windows that hold agents only; a constant without `#` (tmux format-expands `new-session -n` and `new-window -n`; asserted by the T6 test). */
export const AGENTS_WINDOW = 'agents';

/**
 * The listing's format: 15 tab-separated fields (14 in the design; `#{pane_active}` was added for rule 3, "the active pane of the home window"). The tags a user or an
 * agent can write come last, so a plain tab or newline in one of them changes the field count and that row no longer parses. That is not enough on its own: tmux
 * prints a tag raw, so a crafted value can carry a whole forged row after its newline, and `@nika-fit` (the last field) can close one. A listing is therefore read
 * as one piece of evidence (readPlaceListing): a line that does not parse, or a pane id on two rows, makes all of it untrusted.
 */
export const PLACE_FORMAT = [
  '#{pane_id}', '#{window_id}', '#{window_index}', '#{window_active}', '#{window_panes}', '#{window_zoomed_flag}',
  '#{window_width}', '#{window_height}', '#{pane_width}', '#{pane_height}', '#{pane_dead}', '#{pane_active}', '#{@nika-role}', '#{@nika-agent}', '#{@nika-fit}',
].join('\t');

const FIELDS = 15;
const NUMBER = /^\d{1,5}$/;
const LIMIT = 10000;
const ROLES = new Set(['orchestrator', 'sub-orchestrator', 'agent']);

const count = (s) => (NUMBER.test(s) && Number(s) <= LIMIT ? Number(s) : null);
const flag = (s) => (s === '0' ? 0 : s === '1' ? 1 : null);
const paneNumber = (pane) => Number(pane.slice(1));

/** One line -> a row, or null. A row has exactly 15 fields; the pane id and the window id must match PANE_ID / WINDOW_ID, the numbers are digits 0 to 10000, the flags are 0 or 1. */
function parseLine(line) {
  const f = line.split('\t');
  if (f.length !== FIELDS || !PANE_ID.test(f[0]) || !WINDOW_ID.test(f[1])) return null;
  const n = [f[2], f[4], f[6], f[7], f[8], f[9]].map(count);
  const [active, zoomed, dead, current] = [f[3], f[5], f[10], f[11]].map(flag);
  if (n.includes(null) || active === null || zoomed === null || dead === null || current === null) return null;
  const tag = parseAgentTag(f[13]);
  return {
    pane: f[0], win: f[1], index: n[0], active, panes: n[1], zoomed, ww: n[2], wh: n[3], w: n[4], h: n[5], dead, current,
    role: ROLES.has(f[12]) ? f[12] : '', key: tag ? tag[0] : null, fit: f[14] !== '',
  };
}

/**
 * The listing text -> the rows that parse. The role is kept only when it is one of the three words (anything else is ''), the agent tag only
 * as the `[key, name]` of a strict parse, `@nika-fit` only as set or not (its value is never used). A line that fails any check is dropped,
 * and a window with a dropped row no longer adds up to its `#{window_panes}`. Dropping is not trust: doSpawn reads a listing with readPlaceListing.
 * @returns {Array<{pane, win, index, active, panes, zoomed, ww, wh, w, h, dead, current, role, key, fit}>}
 */
export function parsePlaceRows(stdout) {
  return String(stdout).split('\n').map(parseLine).filter(Boolean);
}

/**
 * A listing as one piece of evidence (0.5.4, review M1). tmux prints a tag raw, so one crafted tag value can add a whole forged row; in an honest listing
 * every non-empty line parses and every pane id is on exactly one row. When a line does not parse, or a pane id is on more than one row, none of it is
 * trusted: no rows, and place() then opens a new agents window. A forged row that parses and names a made-up pane is caught by doSpawn's own check
 * before the split (the target must be a pane of the session in the strict listing).
 * @returns {{ rows: Array, trusted: boolean }}
 */
export function readPlaceListing(stdout) {
  const parsed = String(stdout).split('\n').filter((line) => line !== '').map(parseLine);
  const panes = new Set();
  const trusted = parsed.every((row) => row !== null && !panes.has(row.pane) && panes.add(row.pane));
  return trusted ? { rows: parsed, trusted } : { rows: [], trusted };
}

/** Field count of the dashboard collector's `list-panes -a` format (FORMAT in src/collect/tmux.js). A spawn test pins it to the argv the collector sends. */
export const COLLECTOR_FIELDS = 11;

/**
 * The collector's `list-panes -a` read as one piece of evidence for doSpawn's check (c) (0.5.4, round 4, review R1-1). The collector's own parse accepts a
 * short line (the missing fields read as empty) and lets the last row of a pane id win, so a crafted value that only the collector reads can put a pane of
 * another session into this one there. This view is untrusted when a non-empty line has fewer fields than the format, or when a pane id is on more than one
 * line. A line with more fields is fine: the last field (the kind) may hold tabs. It reads no session; when it is trusted, doSpawn takes the session of
 * a pane from the collector's own map.
 * @returns {boolean} true when the read is trusted
 */
export function isStrictPaneListing(stdout, fields = COLLECTOR_FIELDS) {
  const ids = new Set();
  for (const line of String(stdout).split('\n')) {
    if (line === '') continue;
    const f = line.split('\t');
    if (f.length < fields || ids.has(f[0])) return false;
    ids.add(f[0]);
  }
  return true;
}

/** tmux's tiled grid for n panes (layout_set_tiled; spike S-P1a): rows first, columns when the product is still short. */
export function tiledGrid(n) {
  let rows = 1;
  let cols = 1;
  while (rows * cols < n) {
    rows += 1;
    if (rows * cols < n) cols += 1;
  }
  return { rows, cols };
}
/** Size of the smallest of k panes in a length (one border cell between neighbours; spike S-P1a). */
export const cell = (len, k) => Math.floor((len - (k - 1)) / k);
/** `split -h` of this pane leaves both halves at least MIN_COLS wide (new = floor((w-1)/2), old = w-1-new; spike S-P1d). */
export const fitsH = (p) => p.w >= 2 * MIN_COLS + 1 && p.h >= MIN_ROWS;
/** `split -v` of this pane leaves both halves at least MIN_ROWS high. */
export const fitsV = (p) => p.h >= 2 * MIN_ROWS + 1 && p.w >= MIN_COLS;
/** Every pane of the tiled grid keeps the floor after one more pane joins the window. */
export const tileFits = (win) => {
  const g = tiledGrid(win.count + 1);
  return cell(win.w, g.cols) >= MIN_COLS && cell(win.h, g.rows) >= MIN_ROWS;
};

/** Rows -> Map<window id, window> with the three classes of the design: ok, splittable and agents (a split target plus a re-tile). */
function windowsOf(rows, key) {
  const byWindow = new Map();
  for (const r of rows) byWindow.set(r.win, [...(byWindow.get(r.win) ?? []), r]);
  const wins = new Map();
  for (const [id, own] of byWindow) {
    const first = own[0];
    const same = (r) => [r.index, r.active, r.panes, r.zoomed, r.ww, r.wh].join() === [first.index, first.active, first.panes, first.zoomed, first.ww, first.wh].join();
    // the rows parsed for a window must be as many as the window says it has, agree on its own fields, and name at most one active pane
    const ok = own.length === first.panes && own.every(same) && own.filter((r) => r.current === 1).length <= 1;
    const splittable = ok && !first.zoomed && !own.some((r) => r.fit);
    const agents = splittable && own.every((r) => (r.role === 'agent' || r.role === 'sub-orchestrator') && r.key === key);
    wins.set(id, { id, index: first.index, active: first.active === 1, zoomed: first.zoomed === 1, w: first.ww, h: first.wh, rows: own, count: own.length, ok, splittable, agents });
  }
  return wins;
}

/**
 * doSpawn's check on the window's second listing, right before it re-tiles: is `win` still an agents window of this project, and is the new
 * `pane` in it? Any pane a user added, a zoom, a Fit lease or a row that no longer parses makes it no.
 */
export function isAgentsWindow({ rows, key, win, pane }) {
  const w = windowsOf(rows, key).get(win);
  return Boolean(w?.agents && w.rows.some((r) => r.pane === pane));
}

/**
 * Where does the new agent's pane go? `rows` is the rows of readPlaceListing() of the session's listing (none when it is untrusted); `key` the project key; `parent` the parent
 * pane (this project's orchestrator or sub-orchestrator) or null for "you"; `under` an explicit pane to split below; `last` the pane
 * `.last-pane` names (used only for `placement: 'under-last'`); `placement` the setting (`beside` or `under-last`).
 * First match wins: (1) `under`; (2) `last`; (3) the home window, the parent's own (the session's current window when the parent is not
 * in the listing, and when there is none; the parent, or an agent of this project, is split there, and for "you" the active pane); (4) the agents window with the fewest panes that has room; (5) a new window.
 * A dead pane (remain-on-exit) is never split. `moved: true` marks an explicit `under` that had no room.
 * @returns {{ op: 'split', target: string, dir: '-h'|'-v', tile: string|null, placement: 'beside'|'under'|'tiled', moved?: true } | { op: 'window', placement: 'window', moved?: true }}
 */
export function place({ rows, key, parent = null, under = null, last = null, placement = 'beside' }) {
  const wins = windowsOf(rows, key);
  const byPane = new Map();
  for (const r of rows) if (!byPane.has(r.pane)) byPane.set(r.pane, r);
  const winOf = (row) => (row ? wins.get(row.win) : undefined);
  let moved = false;
  const out = (r) => (moved ? { ...r, moved: true } : r);
  const mine = (r) => (r.role === 'agent' || r.role === 'sub-orchestrator') && r.key === key;
  const live = (r) => !r.dead;

  const biggest = (win) => win.rows.filter(live).sort((a, b) => b.w * b.h - a.w * a.h || paneNumber(a.pane) - paneNumber(b.pane))[0];
  const tiled = (win) => {
    const t = biggest(win);
    return t ? { op: 'split', target: t.pane, dir: t.w >= 2 * t.h ? '-h' : '-v', tile: win.id, placement: 'tiled' } : null;
  };
  const beside = (r) => ({ op: 'split', target: r.pane, dir: '-h', tile: null, placement: 'beside' });
  // rules 1 and 2: split below this pane, joining the tile of an agents window that has room, else when both halves keep MIN_ROWS
  const below = (pane) => {
    const row = byPane.get(pane);
    const win = winOf(row);
    if (!row || !live(row) || !win?.splittable) return null;
    if (win.agents && tileFits(win)) return { op: 'split', target: row.pane, dir: '-v', tile: win.id, placement: 'tiled' };
    return fitsV(row) ? { op: 'split', target: row.pane, dir: '-v', tile: null, placement: 'under' } : null;
  };

  if (under) {
    const r = below(under);
    if (r) return r;
    moved = true; // the setting places it, and the answer says so
  }
  if (placement === 'under-last' && last) {
    const r = below(last);
    if (r) return out(r);
  }

  // rule 3: the home window: the parent's own, else the session's current one. A named parent is split only when it is in the home window.
  const parentRow = parent ? byPane.get(parent) : undefined;
  const active = [...wins.values()].filter((w) => w.active);
  const home = parentRow ? winOf(parentRow) : active.length === 1 ? active[0] : undefined;
  if (home?.splittable) {
    if (home.agents && tileFits(home)) {
      const r = tiled(home);
      if (r) return out(r);
    }
    const own = home.rows.filter((r) => live(r) && mine(r)).sort((a, b) => b.w - a.w || paneNumber(b.pane) - paneNumber(a.pane)).find(fitsH);
    if (own) return out(beside(own));
    if (parentRow && live(parentRow) && fitsH(parentRow)) return out(beside(parentRow));
    // only for "you": today's rule, the active pane of the home window, now with the floor
    const current = home.rows.find((r) => r.current === 1);
    if (!parent && current && live(current) && fitsH(current)) return out(beside(current));
  }

  // rule 4: an agents window with room, the one with the fewest panes first, then the lowest index
  const open = [...wins.values()].filter((w) => w.agents && tileFits(w) && biggest(w)).sort((a, b) => a.count - b.count || a.index - b.index)[0];
  if (open) return out(tiled(open));
  return out({ op: 'window', placement: 'window' }); // rule 5
}
