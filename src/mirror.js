// Pane mirror for the app tier: `tmux capture-pane -p -e` turned into rows of styled spans (ADR 0005).
// Pane content is attacker-controlled (any agent can print anything), so the parser is a whitelist (threat T9): of
// all escape sequences only SGR with the codes of api-app.md §3 survives; OSC, DCS, APC/PM/SOS, every other CSI/ESC
// sequence, C0 (except the row break), DEL, C1 and bidi controls are dropped. The output is bounded in rows, row width
// and span count whatever the input.
import { createHash } from 'node:crypto';
import { PANE_ID } from './ids.js';
import { tmuxFailure } from './tmuxerr.js';

const MAX_ROWS = 2000;
const MAX_SPANS = 20000; // beyond this, style changes are ignored and text coalesces into the last span
const MAX_COLS = 1000;
const MAX_CSI = 128; // parameter + intermediate bytes of one CSI
const TTL_MS = 250;
const SIZE_FORMAT = '#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}';

const fresh = () => ({ b: false, d: false, i: false, u: false, r: false, fg: null, bg: null });
const sameColour = (a, c) => a === c || (Array.isArray(a) && Array.isArray(c) && a.every((v, k) => v === c[k]));
const same = (a, c) => a.b === c.b && a.d === c.d && a.i === c.i && a.u === c.u && a.r === c.r
  && sameColour(a.fg, c.fg) && sameColour(a.bg, c.bg);
// Contract shape; `r` (reverse video, SGR 7) is present only while it is on.
const snap = (s) => ({ b: s.b, fg: s.fg, bg: s.bg, u: s.u, i: s.i, d: s.d, ...(s.r ? { r: true } : {}) });
const isBidi = (c) => c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

/** 0–255 decimal token → number, else null. */
const byte = (t) => (typeof t === 'string' && /^\d{1,3}$/.test(t) && Number(t) <= 255 ? Number(t) : null);

/** Applies the SGR parameter string `params` (digits, `;`, `:` only) to a copy of `style`. */
function applySgr(style, params) {
  const next = { ...style };
  const toks = params === '' ? ['0'] : params.split(';');
  for (let k = 0; k < toks.length; k += 1) {
    const tok = toks[k];
    if (tok.includes(':')) { // sub-parameters: only underline styles (4:n) are understood
      const [head, sub] = tok.split(':');
      if (head === '4') next.u = sub !== '0';
      continue;
    }
    if (!/^\d{0,3}$/.test(tok)) continue;
    const v = tok === '' ? 0 : Number(tok);
    if (v === 38 || v === 48 || v === 58) { // 58 (underline colour) is parsed to skip its arguments, then dropped
      const slot = v === 38 ? 'fg' : v === 48 ? 'bg' : null;
      if (toks[k + 1] === '5') {
        const n = byte(toks[k + 2]);
        k += 2;
        if (n !== null && slot) next[slot] = n;
      } else if (toks[k + 1] === '2') {
        const rgb = [byte(toks[k + 2]), byte(toks[k + 3]), byte(toks[k + 4])];
        k += 4;
        if (slot && rgb.every((n) => n !== null)) next[slot] = rgb;
      } else {
        break; // unknown colour form: the remaining parameters cannot be trusted
      }
    } else if (v === 0) Object.assign(next, fresh());
    else if (v === 1) next.b = true;
    else if (v === 2) next.d = true;
    else if (v === 3) next.i = true;
    else if (v === 4) next.u = true;
    else if (v === 7) next.r = true;
    else if (v === 22) { next.b = false; next.d = false; } else if (v === 23) next.i = false;
    else if (v === 24) next.u = false;
    else if (v === 27) next.r = false;
    else if (v >= 30 && v <= 37) next.fg = v - 30;
    else if (v === 39) next.fg = null;
    else if (v >= 40 && v <= 47) next.bg = v - 40;
    else if (v === 49) next.bg = null;
    else if (v >= 90 && v <= 97) next.fg = v - 90 + 8;
    else if (v >= 100 && v <= 107) next.bg = v - 100 + 8;
    // every other code (blink, conceal, strike, underline colour, ...) is ignored
  }
  return next;
}

/**
 * Pure: text from `capture-pane -p -e -N` → rows, each an array of { t, s } spans (api-app.md §3). `cols` is the pane
 * width; a row keeps at most 2 × cols UTF-16 units (clamped to 1–1000 columns) and at most 2000 rows survive. Style
 * carries over from row to row like on a terminal.
 */
export function parseCapture(text, cols) {
  const width = Number.isFinite(cols) ? Math.min(Math.max(Math.floor(cols), 1), MAX_COLS) : MAX_COLS;
  const rowCap = width * 2;
  const src = typeof text === 'string' ? text : '';
  const n = src.length;
  const rows = [];
  let spans = [];
  let buf = '';
  let rowChars = 0;
  let spanCount = 0;
  let style = fresh();

  const flush = () => {
    if (!buf) return;
    spans.push({ t: buf, s: snap(style) });
    spanCount += 1;
    buf = '';
  };
  const endRow = () => {
    flush();
    rows.push(spans);
    spans = [];
    rowChars = 0;
  };
  const setStyle = (params) => {
    if (spanCount >= MAX_SPANS) return;
    const next = applySgr(style, params);
    if (same(next, style)) return;
    flush();
    style = next;
  };

  // Each skipper takes the index after the introducer and returns the index to continue at.
  const csi = (from) => {
    for (let j = from; j < n && j - from <= MAX_CSI; j += 1) {
      const c = src.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) {
        const params = src.slice(from, j);
        if (c === 0x6d && /^[0-9;:]*$/.test(params)) setStyle(params);
        return j + 1;
      }
      if (c < 0x20 || c > 0x3f) return j; // not a CSI byte: abort, the main loop handles it (a row break, a new ESC, ...)
    }
    return Math.min(n, from + MAX_CSI); // truncated at the end, or too long to be a real CSI
  };
  const str = (from) => { // OSC, DCS, APC, PM, SOS: up to BEL / ST, never past the end of the row
    for (let j = from; j < n; j += 1) {
      const c = src.charCodeAt(j);
      if (c === 0x07 || c === 0x9c) return j + 1;
      if (c === 0x0a) return j;
      if (c === 0x1b) return src[j + 1] === '\\' ? j + 2 : j;
    }
    return n;
  };
  const esc = (at) => {
    if (at + 1 >= n) return n; // truncated escape at the end
    const ch = src[at + 1];
    if (ch === '[') return csi(at + 2);
    if (ch === ']' || ch === 'P' || ch === '_' || ch === '^' || ch === 'X') return str(at + 2);
    let j = at + 1; // other escapes: intermediates 0x20-0x2f, then one final byte 0x30-0x7e
    while (j < n && src.charCodeAt(j) >= 0x20 && src.charCodeAt(j) <= 0x2f) j += 1;
    const c = src.charCodeAt(j);
    return j < n && c >= 0x30 && c <= 0x7e ? j + 1 : j;
  };

  let i = 0;
  while (i < n && rows.length < MAX_ROWS) {
    const c = src.charCodeAt(i);
    if (c === 0x0a) {
      endRow();
      i += 1;
    } else if (c === 0x1b) {
      i = esc(i);
    } else {
      i += 1;
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || isBidi(c)) continue;
      if (rowChars < rowCap) {
        buf += src[i - 1];
        rowChars += 1;
      }
    }
  }
  if (rows.length < MAX_ROWS && (buf || spans.length || rowChars)) endRow(); // last row without a trailing newline
  return rows;
}

const intOf = (v) => (typeof v === 'string' && /^\d{1,5}$/.test(v) ? Number(v) : null);

function matches(header, etag) {
  if (typeof header !== 'string') return false;
  return header.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v.replace(/^W\//, '').replace(/^"|"$/g, '') === etag;
  });
}

/**
 * Pane mirror with a 250 ms cache per pane and one tmux capture in flight per pane (others wait for it).
 * `now` is a () => ms clock. capture(pane, ifNoneMatch, { fresh }) → { status, body, etag }; status 304 has body null.
 * `fresh: true` skips the cache and starts its own tmux capture (it refreshes the cache), for the control actions.
 * The caller has already checked that the pane may be mirrored; the pane id is still validated here.
 */
export function createMirror({ exec, tmuxBin = 'tmux', now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const cache = new Map(); // pane → { at, result }
  const inflight = new Map(); // pane → Promise<result>

  async function fetchPane(pane) {
    try {
      const [cap, info] = await Promise.all([
        exec(tmuxBin, ['-u', 'capture-pane', '-p', '-e', '-N', '-t', pane]),
        exec(tmuxBin, ['-u', 'display-message', '-p', '-t', pane, '-F', SIZE_FORMAT]),
      ]);
      const [w, , x, y, flag] = String(info.stdout).split('\n')[0].split('\t');
      const cols = intOf(w) || 80;
      const cursor = { x: intOf(x) ?? 0, y: intOf(y) ?? 0, visible: flag === '1' };
      const rows = parseCapture(String(cap.stdout), cols);
      const etag = createHash('sha256').update(JSON.stringify([cols, rows, cursor])).digest('hex').slice(0, 32);
      return { status: 200, body: { cols, rows, cursor, etag }, etag };
    } catch (err) {
      return tmuxFailure(err);
    }
  }

  const run = (pane, t) => fetchPane(pane).then((result) => {
    if (result.status === 200) {
      for (const [k, v] of cache) if (t - v.at >= TTL_MS) cache.delete(k);
      cache.set(pane, { at: t, result });
    }
    return result;
  });

  function load(pane, fresh) {
    const t = clock();
    // fresh: a control action must see the screen as it is now, so it never reads the cache or joins a capture that started earlier
    if (fresh) return run(pane, t);
    const hit = cache.get(pane);
    if (hit && t >= hit.at && t - hit.at < TTL_MS) return hit.result;
    let pending = inflight.get(pane);
    if (!pending) {
      pending = run(pane, t).finally(() => inflight.delete(pane));
      inflight.set(pane, pending);
    }
    return pending;
  }

  return {
    async capture(pane, ifNoneMatch, opts) {
      if (typeof pane !== 'string' || !PANE_ID.test(pane)) return { status: 400, body: { error: 'invalid', message: 'invalid pane id' } };
      const result = await load(pane, opts?.fresh === true);
      if (result.status === 200 && matches(ifNoneMatch, result.etag)) return { status: 304, body: null, etag: result.etag };
      return result;
    },
  };
}
