// Reads Claude Code's input box (the draft) from the rows of the pane mirror, and the pure helpers that write one back
// (docs: design W5, claude-tui.md section 5, spike S9). Pure: no I/O. Everything here fails closed: a box nika does not
// fully understand is `null` (not a plain box) or `unreadable` (a box that must not be written over), never a guess.
// Keep this file ASCII: write every symbol as an escape.
import { createHash } from 'node:crypto';
import { clean } from './text.js';
import { lastNonBlank, modeFromRows, promptFromRows, rowText } from './mode.js';

// A rule row of Claude's input box (trimmed): two or more box-drawing dashes, plain, or labelled with the session name
// (`-n <name>` or /rename), which Claude draws into the upper rule as `--- <name> -` (claude-tui.md section 5). The label is
// 1 to 80 characters, has no dash, no control character and no space at either end. The box is what lies between the last two.
export const RULE_ROW = /^\u2500{2,}(?: [^\u2500\p{Cc}\s](?:[^\u2500\p{Cc}]{0,78}[^\u2500\p{Cc}\s])? \u2500+)?$/u;
/** The label of the top rule while the box shows an old prompt (`Up` / `Down` recalls history; the real draft is stashed). */
export const HISTORY_LABEL = /^History\s+\d+\s*\/\s*\d+$/;

const LABELLED = /^\u2500{2,} ([^\u2500]+) \u2500+$/u;
// Bash mode (`!`) draws `! for shell mode` instead of the permission-mode phrase (spike S9 Q6), so modeFromRows reads `unknown` there.
const SHELL_FOOTER = /^\s{0,2}(?:-- INSERT --\s*)?! for shell mode/;
// Claude's own stand-ins for content it cannot show as text: a paste (`[Pasted text #4 +3 lines]`) and an image (`[Image #1]`).
const PASTED = /\[(?:Pasted text|Image) #\d+(?: \+\d+ lines)?\]/;
const pastedIn = (text) => PASTED.test(text.replace(/\s+/g, ' ')); // a wrap or a newline may sit anywhere inside it
const GLYPHS = { '\u276f': 'prompt', '!': 'bash' };
const TALL_ROWS = 14; // a box of 14 rows or more may be a scrolled window of a taller draft (S9)
const SUGGESTION_MAX = 200;
const MAX_CHARS = 1024;
const MAX_NEWLINES = 12;
const MAX_ROWS = 13;
const CHUNK_CHARS = 700; // 801 characters or 3 newlines in one burst become `[Pasted text #N]` (S9 Q4)
const CHUNK_NEWLINES = 2;
const MAX_RUN = CHUNK_CHARS - 1; // a run of this many spaces and tabs cannot be cut around, see chunks()
const LONG_RUN = new RegExp(`[ \\t]{${MAX_RUN},}`);

// Terminal cells a code point occupies (wcwidth approximation: combining 0, CJK and emoji 2, else 1). A copy of
// `cellWidth` in public/mirror-render.js (browser code, not importable here): a deliberate DRY exception. A miscount can
// only make a hint survive into `text`, which the read-back then refuses; it never types anything.
function cellWidth(cp) {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200d) || (cp >= 0x20d0 && cp <= 0x20ff)
    || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const width = (text) => { let n = 0; for (const ch of text) n += cellWidth(ch.codePointAt(0)); return n; };

/** The characters of one mirror row with their column, the column their span starts at, their dim / reverse / fg-246 flags and `nb` (it was a no-break space). A no-break space reads as a space. */
function charsOf(row) {
  const out = [];
  let col = 0;
  for (const sp of Array.isArray(row) ? row : []) {
    const s = sp?.s ?? {};
    const spanCol = col;
    for (const ch of typeof sp?.t === 'string' ? sp.t : '') {
      out.push({ ch: ch === '\u00a0' ? ' ' : ch, nb: ch === '\u00a0', col, spanCol, dim: s.d === true, rev: s.r === true, hint: s.fg === 246 && s.d !== true });
      col += cellWidth(ch.codePointAt(0));
    }
  }
  return out;
}

/**
 * Row 0 of the box: up to 2 spaces, the prompt glyph or `!`, then Claude's no-break space (U+00A0) or nothing but the padding
 * (I-1: the raw character decides, before any no-break-space-to-space mapping; a user's status line such as `\u276f main` has a plain
 * space and is not a box). { mode, body, start } or null.
 */
function firstRow(chars) {
  let at = 0;
  while (chars[at]?.ch === ' ') at += 1;
  const mode = at <= 2 ? GLYPHS[chars[at]?.ch] : undefined;
  if (mode === undefined) return null;
  const rest = chars.slice(at + 1);
  if (rest.length > 0 && !rest[0].nb && rest.some((c) => c.ch !== ' ')) return null;
  return { mode, body: chars.slice(at + 2), start: at + 2 };
}

/**
 * Claude pads every row of its screen with real spaces to the pane width (seen live, 2.1.325). The padding is the run of
 * spaces after the last visible (non-space) character of the row, ghost text included; it is not part of the draft, and it
 * cannot tell nika how many spaces the user typed (the cursor column does: a cursor past the text is `trailing`). A space
 * before a ghost run is not padding: `/compact ` keeps the space that Tab typed.
 */
function unpad(body) {
  let n = body.length;
  while (n > 0 && body[n - 1].ch === ' ') n -= 1;
  return body.slice(0, n);
}

/**
 * Marks the characters of a box row that are ghost without being dim: `c.ghost` is 'rev' for the first character in reverse
 * video when everything after it is dim (the cursor drawn over the placeholder; never seen live), 'hint' for an fg-246 run
 * that starts at or after the cursor column on the cursor row (the slash command's argument hint), else null.
 */
function markRow(body, isFirst, cur) {
  const shown = body.filter((c) => c.ch !== ' ');
  const revFirst = isFirst && shown.length > 1 && shown[0].rev && !shown[0].dim && shown.slice(1).every((c) => c.dim) ? shown[0] : null;
  for (const c of body) c.ghost = c === revFirst ? 'rev' : cur !== null && c.hint && c.spanCol >= cur.x ? 'hint' : null;
}

/**
 * Dim (SGR 2) text is ghost in two places only: (a) a box that holds no real text, where it is the placeholder or a prompt
 * suggestion; (b) as ONE trailing run on the cursor row that starts exactly at the cursor column (a completion ghost after typed
 * text). Dim text anywhere else next to real text (a dim row between real rows, dim before real text, dim away from the
 * cursor) would be invisible to nika but submitted by Enter, so the draft is unreadable (the layout reason). Typed text never carries SGR.
 */
function dimIsTrailing(infos, cur) {
  const withDim = infos.filter(({ body }) => body.some((c) => c.dim));
  if (withDim.length === 0) return true;
  if (cur === null || withDim.length > 1 || withDim[0].row !== cur.y) return false;
  const k = withDim[0].body.findIndex((c) => c.dim);
  return withDim[0].body[k].col === cur.x && withDim[0].body.slice(k).every((c) => c.dim);
}

/** Splits a marked box row into real text and ghost text (the dim text is kept for the suggestion and the pasted check; `ghost` says any ghost cell was dropped). */
function splitRow(body, start) {
  const real = [];
  const dim = [];
  let ghost = false;
  for (const c of body) {
    if (c.dim || c.ghost === 'rev') { dim.push(c.ch); ghost = true; } else if (c.ghost !== null) ghost = true;
    else real.push(c);
  }
  const text = real.map((c) => c.ch).join('');
  const last = real.at(-1);
  return {
    text,
    dim: dim.join(''),
    ghostOnly: ghost && text.trim() === '',
    ghost,
    end: last === undefined ? start : last.col + cellWidth(last.ch.codePointAt(0)), // the column right after the last real character
  };
}

/**
 * Joins the box rows (design 1.4); null when two rows can be read two ways. Claude 2.1.325 wraps each hard line like wrap-ansi
 * (`hard: true, trim: false`) at the usable width `w` = cols - 4 (`wrappedRows` is that break model), and then DRAWS every wrapped
 * row without its leading whitespace: the space that a row full to `w` pushes to the start of the next row is not drawn, but it
 * counts for the break (W5-F1 live: 100 x `ab` is drawn 116 / 113 / 68, the real second row is a space plus 38 words). Row `a` into
 * row `b` (bodies, after the indent and unpad), with `lost` = 1 when the space Claude dropped from the start of `a` counts toward it,
 * else 0 (width wa = width(a) + lost):
 *   - `b` starts with a space, `a` or `b` is blank, or wa > w: a hard line break (a drawn wrap never starts with a space);
 *   - `a` is FULL, that is `b`'s first character would not have fitted behind it (wa + width(it) > w; a wide character leaves a
 *     full row one cell short). Y = the last word of `a`, Z = the first word of `b`:
 *       Y + Z <= w: a soft wrap, a space, and `lost` = 1 for `b` when the space did not fit on `a` (wa = w);
 *       Y + Z > w: a cut word YZ (only a word longer than `w` is cut) draws exactly the same two rows as two words Y and Z (N-3:
 *       Claude drops the leading space of the next row). A cut word is the reading when `a` has no space (one word fills the row,
 *       the old T1 guess) or when the junction is a wide character (a wide character is what leaves a row short), else the two
 *       readings cannot be told apart and the draft is unreadable (null: `layout`; nika never overwrites a draft it cannot read);
 *   - otherwise a space when a, a space and b's first word would not have fitted (wa + 1 + width > w), else a newline.
 * Known residuals, all read back as a different text and so end in a 409 `draft-mismatch`, never in a wrong key: a hard newline
 * where the next word would not have fitted (it reads as a soft wrap, the third rule; design 1.4), the same for a hard line of
 * exactly `w` cells followed by a hard newline (the newline reads as a space); a full row that is one word of exactly `w` followed
 * by a space and a word, and the same at a wide junction (read as a cut word: the space is lost); a double space at a wrap (it
 * reads as one); a full row, a space and a word that does not fit behind it (Claude draws an empty row between; it reads as
 * newlines). The page adopts a misread text after the 409, so the next replace writes it back: one character is really changed.
 */
function joinRows(bodies, w) {
  let text = bodies[0];
  let lost = 0;
  for (let i = 1; i < bodies.length; i += 1) {
    const a = bodies[i - 1];
    const b = bodies[i];
    const wa = width(a) + lost;
    let sep = '\n';
    lost = 0;
    if (a.trim() !== '' && b.trim() !== '' && !b.startsWith(' ') && wa <= w) {
      const next = width(/^\S*/.exec(b)[0]);
      if (wa + cellWidth(b.codePointAt(0)) > w) { // full
        if (width(/\S*$/.exec(a)[0]) + next <= w) { sep = ' '; lost = wa === w ? 1 : 0; }
        else if (a.includes(' ') && cellWidth([...a].at(-1).codePointAt(0)) < 2 && cellWidth(b.codePointAt(0)) < 2) return null;
        else sep = '';
      } else if (wa + 1 + next > w) sep = ' ';
    }
    text += sep + b;
  }
  return text;
}

/**
 * Claude's input box from the mirror's rows, or null when the screen has no plain box. `rows` are the capture's span rows,
 * `cursor` is `{ x, y }` from the capture (0-based; anything else reads as no cursor), `cols` the pane width (when it is
 * not a usable number, the width of the lower rule row stands in for it). Returns a Draft:
 *   state     'empty' | 'text' | 'unreadable'
 *   mode      'prompt' | 'bash'   (the glyph: the prompt character, or `!`)
 *   text      the draft, rows joined, ghost text and the padding Claude adds to every row removed; '' for empty and unreadable
 *   sig       16 hex of sha256(`${state}\n${mode}\n${text}`); null when unreadable
 *   reason    unreadable only: 'history' | 'layout' | 'tall' | 'pasted' | 'trailing' (checked in this order; layout also means
 *             dim text next to real text, see dimIsTrailing, and a wrap that reads two ways, see joinRows)
 *   box       { top, bottom }: the row indexes of the two rule rows
 *   cursorAtEnd   the cursor sits right after the last visible real character of the last box row (padding spaces do not count)
 *   suggestion    dim text of an empty box (not the `Try "..."` example), clean() at most 200; else null
 *   ghost         true when any dim, reverse-video or fg-246 hint cell of the box was dropped as ghost text (a suggestion, the
 *                 placeholder, a completion, the slash hint); false for plain text, an empty box and every unreadable draft
 * Null: the footer is not a known mode line (a dialog, a menu, a prompt), a permission prompt parses, fewer than two rule rows,
 * nothing between the last two, or the first box row does not start with the prompt glyph or `!` and Claude's no-break space
 * (U+00A0; a plain space is a status line of the user's, I-1).
 * `rows` must be the capture of the pane from its top row (no scrollback): `cursor.y` is pane-relative. `text` is not cleaned
 * (zero-width characters survive the mirror's filter); it is a textarea value and must never reach an HTML sink.
 */
export function parseDraft(rows, cursor, cols) {
  if (!Array.isArray(rows)) return null;
  const rules = [];
  rows.forEach((row, i) => { if (RULE_ROW.test(rowText(row).trimEnd())) rules.push(i); }); // column 0: a draft line of dashes has two spaces before it
  if (rules.length < 2) return null;
  const top = rules.at(-2);
  const bottom = rules.at(-1);
  if (bottom - top < 2) return null;
  const first = firstRow(charsOf(rows[top + 1]));
  if (first === null) return null;
  const footerKnown = modeFromRows(rows) !== 'unknown' || (first.mode === 'bash' && SHELL_FOOTER.test(lastNonBlank(rows, 1)[0] ?? ''));
  // The prompt gate cannot fire after the footer gate (a prompt owns the last row, so the footer reads unknown); it stays as the
  // documented T51 anchor: a draft is never read from a screen that parses as a permission prompt.
  if (!footerKnown || promptFromRows(rows) !== null) return null;

  const box = { top, bottom };
  const bad = (reason) => ({ state: 'unreadable', mode: first.mode, text: '', sig: null, reason, box, cursorAtEnd: false, suggestion: null, ghost: false });
  const label = LABELLED.exec(rowText(rows[top]).trimEnd())?.[1];
  if (label !== undefined && HISTORY_LABEL.test(label)) return bad('history');

  const cur = Number.isInteger(cursor?.x) && Number.isInteger(cursor?.y) ? cursor : null;
  const infos = [];
  for (let i = top + 1; i < bottom; i += 1) {
    let body = first.body;
    let start = first.start;
    if (i > top + 1) { // a continuation row: exactly two spaces then text, or only spaces (a blank line of the draft)
      const chars = charsOf(rows[i]);
      const line = chars.map((c) => c.ch).join('');
      if (line.startsWith('  ')) body = chars.slice(2);
      else if (/^ *$/.test(line)) body = [];
      else return bad('layout');
      start = 2;
    }
    body = unpad(body);
    markRow(body, i === top + 1, cur !== null && cur.y === i ? cur : null);
    infos.push({ row: i, body, start });
  }
  const hasReal = infos.some(({ body }) => body.some((c) => !c.dim && c.ghost === null && c.ch !== ' '));
  if (hasReal && !dimIsTrailing(infos, cur)) return bad('layout');
  if (infos.length >= TALL_ROWS) return bad('tall');
  const parts = infos.map(({ body, start }) => splitRow(body, start));

  // With no real text, a row that holds only ghost text (a long suggestion that wrapped) is not a line of the draft; with real
  // text it is a line (the cursor sits on a new empty line and the completion ghost starts there).
  const bodies = parts.filter((p, i) => i === 0 || hasReal || !p.ghostOnly).map((p) => p.text);
  const empty = bodies.length === 1 && bodies[0].trim() === '';
  const usable = Number.isInteger(cols) && cols > 4 ? cols : width(rowText(rows[bottom]).trimEnd());
  const text = empty ? '' : joinRows(bodies, Math.max(1, usable - 4));
  if (text === null) return bad('layout'); // two rows that can be read two ways (N-3)
  // A typed literal looks the same as Claude's placeholder: fail closed. Checked on the dim text too (a dim placeholder is ghost).
  if (pastedIn(text) || pastedIn(parts.map((p) => p.dim).join(' '))) return bad('pasted');

  let cursorAtEnd = false;
  if (cur !== null && cur.y === bottom - 1) {
    const end = parts.at(-1).end;
    if (cur.x > end) return bad('trailing'); // spaces the user typed at the end look like Claude's padding; the cursor column shows them
    cursorAtEnd = cur.x === end; // one column left is vim NORMAL on the last character, false like any mid-text cursor
  }

  let suggestion = null;
  if (empty) {
    const ghost = clean(parts.map((p) => p.dim).join(' '), SUGGESTION_MAX);
    suggestion = ghost !== null && !/^Try "/.test(ghost) ? ghost : null;
  }
  const state = empty ? 'empty' : 'text';
  const sig = createHash('sha256').update(`${state}\n${first.mode}\n${text}`).digest('hex').slice(0, 16);
  return { state, mode: first.mode, text, sig, box, cursorAtEnd, suggestion, ghost: parts.some((p) => p.ghost) };
}

/** The form two drafts are compared in: a tab is 4 spaces (Claude draws it so), a no-break space is a space, trailing spaces of every line go. */
export function normDraft(text) {
  return typeof text === 'string' ? text.replace(/\t/g, '    ').replace(/\u00a0/g, ' ').replace(/ +$/gm, '') : '';
}

/** True when both are strings that read the same after normDraft. */
export const sameDraft = (a, b) => typeof a === 'string' && typeof b === 'string' && normDraft(a) === normDraft(b);

/**
 * Rows one hard line needs when Claude wraps it at `w` cells: the same model joinRows reads backwards (wrap-ansi, `hard: true,
 * trim: false`). A row that is already `w` wide starts a new row before the next word; one space is appended before every word
 * after the first; a word that does not fit the rest of the row starts a new row; a word longer than `w` starts on the current
 * row unless starting on the next saves a break (`floor((n - 1) / w) < 1 + floor((n - left - 1) / w)`, `left` the cells still
 * free), then is cut at `w` cell by cell (a wide character that does not fit goes to the next row).
 */
function wrappedRows(line, w) {
  let rows = 1;
  let used = 0; // cells of the current row, with the space after its last word
  line.split(' ').forEach((word, i) => {
    if (i > 0) {
      if (used >= w) { rows += 1; used = 0; }
      used += 1;
    }
    const n = width(word);
    if (n > w) {
      if (Math.floor((n - 1) / w) < 1 + Math.floor((n - (w - used) - 1) / w)) { rows += 1; used = 0; }
      const cells = [...word];
      cells.forEach((ch, k) => {
        const c = cellWidth(ch.codePointAt(0));
        if (used + c > w) { rows += 1; used = 0; }
        used += c;
        if (used === w && k < cells.length - 1) { rows += 1; used = 0; }
      });
      return;
    }
    if (used > 0 && used + n > w && n > 0) { rows += 1; used = 0; }
    used += n;
  });
  return rows;
}

/**
 * Whether nika may sync this text into Claude's box: at most 1024 characters, 12 newlines and 13 estimated rows (the sum over
 * lines of the rows a word wrap at `cols - 4` needs, see wrappedRows; a 14-row box may be a window, so it is unreadable), and no
 * run of 699 or more spaces and tabs in a row (chunks() cannot cut inside it without ending a chunk in a space; reason 'chars').
 * { ok } or { ok: false, reason: 'chars' | 'newlines' | 'rows' | 'invalid' } (invalid: not a string, or cols not an integer above 4).
 */
export function inEnvelope(text, cols) {
  if (typeof text !== 'string' || !Number.isInteger(cols) || cols <= 4) return { ok: false, reason: 'invalid' };
  if (text.length > MAX_CHARS || LONG_RUN.test(text)) return { ok: false, reason: 'chars' };
  const lines = text.split('\n');
  if (lines.length - 1 > MAX_NEWLINES) return { ok: false, reason: 'newlines' };
  const rows = lines.reduce((n, line) => n + wrappedRows(line.replace(/\t/g, '    '), cols - 4), 0);
  return rows > MAX_ROWS ? { ok: false, reason: 'rows' } : { ok: true };
}

/**
 * Splits text for typing: a chunk holds at most 700 characters and 2 newlines (it ends right after its second newline), and a
 * surrogate pair is never split. A chunk never ends in a space or a tab (M-3: Claude pads every row with spaces, so a draft that
 * ends in typed spaces reads as `trailing`): when the 700-character cut falls inside a run of spaces and tabs, the cut moves to
 * before the run and the chunk gets shorter; the run starts the next chunk. Only a cut is moved: the end of the text may end in
 * spaces. A run of 699 or more spaces and tabs fills a whole chunk (or a chunk and one surrogate pair), so no cut is possible
 * there: inEnvelope refuses such a text, and chunks() still returns it whole (cut at the limit) rather than lose characters.
 * The caller types a chunk with a newline or tab as a bracketed paste, any other with `send-keys -l`.
 */
export function chunks(text) {
  const out = [];
  let cur = '';
  let newlines = 0;
  for (const ch of typeof text === 'string' ? text : '') { // by code point
    if (cur.length + ch.length > CHUNK_CHARS) {
      const keep = cur.replace(/[ \t]+$/, '');
      out.push(keep === '' ? cur : keep);
      cur = keep === '' ? '' : cur.slice(keep.length); // the run moves to the next chunk; it holds no newline
      newlines = 0;
    }
    cur += ch;
    if (ch === '\n') {
      newlines += 1;
      if (newlines === CHUNK_NEWLINES) { out.push(cur); cur = ''; newlines = 0; }
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}
