// Terminal mirror helpers for the session window (docs/contracts/api-app.md, section 3: capture and keys).
//
// Part 1, pure (no DOM, tested in Node): toRenderModel / withCursor turn a capture into rows of { text, classes, style }.
// Pane output is attacker-controlled, so every value is re-validated here even though the server already filtered it:
// colours are integers 0-255 or [r,g,b] triples (anything else is dropped), classes come from a fixed set, CSS values are
// built by this file from numbers only, and text loses controls and bidi overrides.
// Part 2, the only DOM writer: applyMirror (textContent, className and element.style.x only; never HTML parsing).
// Part 3, pure: planSend / keyForEvent encode composer text and passthrough keystrokes for POST /api/app/pane/:id/keys.

import { windowAction } from './shortcuts.js';

export const LIMITS = { rows: 2000, rowUnits: 4000, spans: 500, text: 1024, paste: 16 * 1024 };

// C0 (tab included: tmux expands tabs), DEL, C1 and the bidi controls; the server drops them too (defence in depth).
// The classes are assembled from numbers so this source file stays pure ASCII (no raw bidi code points, test/security N2).
const esc = (cp) => '\\u' + cp.toString(16).padStart(4, '0');
const klass = (ranges) => `[${ranges.map(([a, b = a]) => `${esc(a)}-${esc(b)}`).join('')}]`;
const CONTROLS = [[0x00, 0x1f], [0x7f, 0x9f]];
const BIDI = [[0x61c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]];
const UNSAFE = new RegExp(klass([...CONTROLS, ...BIDI]), 'g');
const CONTROL = new RegExp(klass(CONTROLS));
const CUBE = [0, 95, 135, 175, 215, 255];

const isByte = (n) => Number.isInteger(n) && n >= 0 && n <= 255;
const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every(isByte);
const validColour = (c) => (isByte(c) || isRgb(c) ? c : null);

/** Absolute CSS colour for a 256-colour index >= 16 or an [r,g,b] triple. */
function cssColour(c) {
  if (isRgb(c)) return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  if (c < 232) {
    const n = c - 16;
    return `rgb(${CUBE[Math.floor(n / 36)]}, ${CUBE[Math.floor(n / 6) % 6]}, ${CUBE[n % 6]})`;
  }
  const v = 8 + (c - 232) * 10;
  return `rgb(${v}, ${v}, ${v})`;
}

const DEFAULT_BG = 'default-bg'; // reverse video on a default colour: the other side's default
const DEFAULT_FG = 'default-fg';

/** One SGR style object -> { classes, style }. Basic 16 colours become classes (themed), the rest CSSOM values. */
function styleOf(s) {
  const st = s && typeof s === 'object' ? s : {};
  let fg = validColour(st.fg);
  let bg = validColour(st.bg);
  if (st.r === true) [fg, bg] = [bg ?? DEFAULT_BG, fg ?? DEFAULT_FG];
  const classes = [];
  const style = {};
  if (fg === DEFAULT_BG) classes.push('fdb');
  else if (isByte(fg) && fg < 16) classes.push(`f${fg}`);
  else if (fg !== null) style.color = cssColour(fg);
  if (bg === DEFAULT_FG) classes.push('bdf');
  else if (isByte(bg) && bg < 16) classes.push(`b${bg}`);
  else if (bg !== null) style.background = cssColour(bg);
  if (st.b === true) classes.push('sb');
  if (st.d === true) classes.push('sd');
  if (st.i === true) classes.push('si');
  if (st.u === true) classes.push('su');
  return { classes, style };
}

function rowModel(row) {
  const out = [];
  let budget = LIMITS.rowUnits;
  for (const sp of Array.isArray(row) ? row : []) {
    if (out.length >= LIMITS.spans || budget <= 0) break;
    let text = typeof sp?.t === 'string' ? sp.t.replace(UNSAFE, '') : '';
    if (text.length > budget) text = text.slice(0, budget).replace(/[\ud800-\udbff]$/, '');
    if (!text) continue;
    budget -= text.length;
    out.push({ text, ...styleOf(sp.s) });
  }
  return out;
}

/**
 * capture body -> rows (array of span models), at most LIMITS.rows rows. Cursor is added separately by withCursor.
 * `cutAt` (0.5, draft sync): the first row to leave out, the input box's top rule, so Claude's input box is not drawn while the
 * message box mirrors it. A value that is not a row of this capture (not an integer, negative, past the end) cuts nothing.
 */
export function toRenderModel(capture, { cutAt } = {}) {
  const rows = Array.isArray(capture?.rows) ? capture.rows.slice(0, LIMITS.rows) : [];
  const n = Number.isInteger(cutAt) && cutAt >= 0 && cutAt < rows.length ? cutAt : rows.length;
  return rows.slice(0, n).map(rowModel);
}

/** The cursor to draw under a cut: one on or below the cut row sat in the hidden box, so it is dropped (withCursor would pad blank rows for it). */
export function cutCursor(cursor, cutAt) {
  return Number.isInteger(cutAt) && Number.isInteger(cursor?.y) && cursor.y >= cutAt ? null : cursor;
}

/** Terminal cells a code point occupies (wcwidth approximation: combining 0, CJK and emoji 2, else 1). */
export function cellWidth(cp) {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200d) || (cp >= 0x20d0 && cp <= 0x20ff)
    || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

const attrClasses = (classes) => classes.filter((c) => c === 'sb' || c === 'sd' || c === 'si' || c === 'su');

/** Row with the cell at column x drawn as the cursor (class `tc`); pads with spaces when x is past the row text. */
function splitAtCell(row, x) {
  const before = [];
  let col = 0;
  for (let i = 0; i < row.length; i += 1) {
    const sp = row[i];
    let units = 0;
    for (const ch of sp.text) {
      const w = cellWidth(ch.codePointAt(0));
      if (col + w > x && w > 0) {
        const cursor = { text: ch, classes: ['tc', ...attrClasses(sp.classes)], style: {} };
        const head = sp.text.slice(0, units);
        const tail = sp.text.slice(units + ch.length);
        return [...before, ...(head ? [{ ...sp, text: head }] : []), cursor, ...(tail ? [{ ...sp, text: tail }] : []), ...row.slice(i + 1)];
      }
      col += w;
      units += ch.length;
    }
    before.push(sp);
  }
  const pad = x - col;
  return [...before, ...(pad > 0 ? [{ text: ' '.repeat(pad), classes: [], style: {} }] : []), { text: ' ', classes: ['tc'], style: {} }];
}

/** Rows with the cursor cell marked. Pure: only the cursor row is copied. */
export function withCursor(rows, cursor) {
  if (!cursor || cursor.visible !== true) return rows;
  const { x, y } = cursor;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= LIMITS.rowUnits || y < 0 || y >= LIMITS.rows) return rows;
  const out = rows.slice();
  while (out.length <= y) out.push([]);
  out[y] = splitAtCell(out[y], x);
  return out;
}

// ---- DOM writer -------------------------------------------------------------------------------------------------

const drawn = new WeakMap(); // container -> { keys: string[], els: Element[] }

function spanNode(doc, sp) {
  if (!sp.classes.length && !sp.style.color && !sp.style.background) return doc.createTextNode(sp.text);
  const el = doc.createElement('span');
  if (sp.classes.length) el.className = sp.classes.join(' ');
  if (sp.style.color) el.style.color = sp.style.color;
  if (sp.style.background) el.style.background = sp.style.background;
  el.textContent = sp.text;
  return el;
}

/**
 * Draws `model` (toRenderModel output) plus the cursor into `container`, one `div.tl` per row. Only rows whose model
 * changed are rebuilt, so text selection and scroll position survive. Returns the number of rows touched.
 */
export function applyMirror(container, model, cursor) {
  const doc = container.ownerDocument;
  const rows = withCursor(model, cursor);
  let st = drawn.get(container);
  if (!st) {
    st = { keys: [], els: [] };
    drawn.set(container, st);
    container.textContent = '';
  }
  let touched = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const key = JSON.stringify(rows[i]);
    if (st.keys[i] === key) continue;
    let el = st.els[i];
    if (!el) {
      el = doc.createElement('div');
      el.className = 'tl';
      container.appendChild(el);
      st.els[i] = el;
    }
    el.textContent = '';
    for (const sp of rows[i]) el.appendChild(spanNode(doc, sp));
    st.keys[i] = key;
    touched += 1;
  }
  while (st.els.length > rows.length) {
    container.removeChild(st.els.pop());
    st.keys.pop();
    touched += 1;
  }
  return touched;
}

// ---- input encoding ---------------------------------------------------------------------------------------------

const utf8Bytes = (s) => new TextEncoder().encode(s).length;

/**
 * Composer text -> request body for POST /pane/:id/keys, or a refusal. Empty -> just Enter. One plain line of at most
 * 1024 chars -> { text, keys: ['Enter'] }. Anything else (several lines, longer, or with a control such as a tab) ->
 * { paste, keys: ['Enter'] }, at most 16 KB of UTF-8.
 */
export function planSend(value) {
  const v = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (v.trim() === '') return { ok: true, payload: { keys: ['Enter'] }, summary: 'Enter' };
  if (!v.includes('\n') && v.length <= LIMITS.text && !CONTROL.test(v)) {
    return { ok: true, payload: { text: v, keys: ['Enter'] }, summary: `${v.length} characters + Enter` };
  }
  const bytes = utf8Bytes(v);
  if (bytes > LIMITS.paste) {
    return { ok: false, message: `This is ${Math.ceil(bytes / 1024)} KB. A paste can be at most 16 KB. Shorten it or send it in parts. Your text is kept.` };
  }
  const lines = v.split('\n').length;
  return { ok: true, payload: { paste: v, keys: ['Enter'] }, summary: lines > 1 ? `a paste of ${lines} lines + Enter` : `a paste of ${v.length} characters + Enter` };
}

/** Pasted text in passthrough mode (no Enter). null when there is nothing to send, { ok: false, message } when too big. */
export function planPaste(value) {
  const v = String(value ?? '').replace(/\r\n?/g, '\n');
  if (v === '') return null;
  if (!v.includes('\n') && v.length <= LIMITS.text && !CONTROL.test(v)) return { ok: true, payload: { text: v }, summary: `${v.length} characters` };
  const bytes = utf8Bytes(v);
  if (bytes > LIMITS.paste) return { ok: false, message: `The paste is ${Math.ceil(bytes / 1024)} KB. A paste can be at most 16 KB. Nothing was sent.` };
  return { ok: true, payload: { paste: v }, summary: `a paste of ${v.split('\n').length} lines` };
}

/** Splits typed text into pieces the `text` field accepts (at most 1024 UTF-16 units, no surrogate cut). */
export function chunkText(s, size = LIMITS.text) {
  const out = [];
  for (let i = 0; i < s.length;) {
    let end = Math.min(i + size, s.length);
    if (end < s.length && /[\ud800-\udbff]/.test(s[end - 1])) end -= 1;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

const NAMED = {
  Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'BSpace', Delete: 'DC', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage',
};
const CTRL = { c: 'C-c', u: 'C-u', k: 'C-k', a: 'C-a', e: 'C-e', l: 'C-l', r: 'C-r', w: 'C-w' };

/** Human label of a key name for the echo line. */
export const KEY_LABEL = {
  Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', BTab: 'Shift-Tab', BSpace: 'Backspace', DC: 'Delete', Up: 'Up', Down: 'Down',
  Left: 'Left', Right: 'Right', Home: 'Home', End: 'End', PPage: 'Page Up', NPage: 'Page Down',
  'C-c': 'Ctrl-C', 'C-u': 'Ctrl-U', 'C-k': 'Ctrl-K', 'C-a': 'Ctrl-A', 'C-e': 'Ctrl-E', 'C-l': 'Ctrl-L', 'C-r': 'Ctrl-R', 'C-w': 'Ctrl-W',
};

/**
 * The echo line for a run of arrow keys the keys route accepted (message box, 0.3.3): one key, one key name n times, or a mix; '' for none.
 * "Sent Down to %12", "Sent 3 x Down to %12" (x is U+00D7), "Sent 5 arrow keys to %12".
 */
export function arrowEcho(keys, pane) {
  if (!keys.length) return '';
  const label = (k) => KEY_LABEL[k] ?? k;
  if (keys.some((k) => k !== keys[0])) return `Sent ${keys.length} arrow keys to ${pane}`;
  return keys.length === 1 ? `Sent ${label(keys[0])} to ${pane}` : `Sent ${keys.length} \u00d7 ${label(keys[0])} to ${pane}`;
}

/**
 * Passthrough: a keyboard event -> what to do. { kind: 'leave' } for Ctrl+], 'ignore' for meta shortcuts, IME composition and
 * the keys the browser or the window keeps (the app and the OS keep them; the event goes on, nothing is sent), 'copy' for
 * Ctrl+Shift+C, 'key' with an allow-list name, 'text' with one printable character, or 'skip' with the reason for keys that are not
 * on the allow-list. Ignored besides Meta (F2): Ctrl+Q and the zoom keys off macOS (the window handler on the document runs them),
 * Ctrl+Shift+V everywhere and Ctrl+V off macOS (the browser pastes; the `paste` handler sends it as one bracketed paste).
 * Ctrl+C is Claude's C-c, and so is Ctrl+W: Close is not a window key while typing into the pane.
 * `mac`: the page runs on macOS, where Command owns those keys and Ctrl+V is not a paste.
 */
export function keyForEvent(e, { mac = false } = {}) {
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === ']') return { kind: 'leave' };
  if (e.metaKey || e.isComposing || e.key === 'Process' || e.key === 'Dead' || windowAction(e, { mac, passthrough: true })) return { kind: 'ignore' };
  const label = `${e.ctrlKey ? 'Ctrl-' : ''}${e.altKey ? 'Alt-' : ''}${e.shiftKey && e.key.length > 1 ? 'Shift-' : ''}${e.key}`;
  if (e.altKey) return { kind: 'skip', reason: `Not sent: ${label} is not on the allow-list` };
  if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey) return { kind: 'key', name: 'BTab' };
  if (e.ctrlKey) {
    const letter = e.key.length === 1 ? e.key.toLowerCase() : '';
    if (letter === 'c' && e.shiftKey) return { kind: 'copy' };
    if (letter === 'v' && (e.shiftKey || !mac)) return { kind: 'ignore' };
    const name = CTRL[letter];
    return name ? { kind: 'key', name } : { kind: 'skip', reason: `Not sent: ${label} is not on the allow-list` };
  }
  if (NAMED[e.key]) return { kind: 'key', name: NAMED[e.key] };
  if ([...e.key].length === 1 && !CONTROL.test(e.key)) return { kind: 'text', text: e.key };
  return { kind: 'skip', reason: `Not sent: ${label} is not on the allow-list` };
}
