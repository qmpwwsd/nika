import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parseDraft, RULE_ROW, HISTORY_LABEL, normDraft, sameDraft, inEnvelope, chunks } from '../src/draft.js';
import { rowText } from '../src/mode.js';
import { boxRows, span } from './helpers.js';

// Synthetic screens only (acme-api, web-shop). The layout follows docs/contracts/claude-tui.md and spike S9 (Claude Code 2.1.321):
// top rule, `glyph + no-break space + text`, two-space continuation rows, bottom rule, status line, mode line.
const NB = '\u00a0';
const PROMPT = '\u276f';
const W = 116; // usable text width at 120 columns: cols - 4

/**
 * boxRows(...) read with parseDraft the way the capture route will (rows, cursor, cols). Claude pads every row with real spaces
 * to the pane width (seen live, 2.1.325), so every fixture is read twice, as drawn and padded, and both must give one Draft.
 */
const read = (opts) => {
  const s = boxRows(opts);
  const draft = parseDraft(s.rows, s.cursor, s.cols);
  const p = boxRows({ ...opts, pad: true });
  assert.deepEqual(parseDraft(p.rows, p.cursor, p.cols), draft, 'the same screen padded with spaces to the width reads the same');
  return draft;
};
const sigOf = (state, mode, text) => createHash('sha256').update(`${state}\n${mode}\n${text}`).digest('hex').slice(0, 16);
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ');
/** n characters of words, ending on a letter. */
function sentence(n) {
  let s = '';
  for (let i = 0; s.length < n; i += 1) s += (s ? ' ' : '') + WORDS[i % WORDS.length];
  s = s.slice(0, n);
  return s.endsWith(' ') ? `${s.slice(0, -1)}x` : s;
}
/** Cells of a string in these fixtures: U+4E00..U+9FFF is wide (2), everything else 1. */
const cellsOf = (text) => [...text].reduce((n, ch) => n + (ch.codePointAt(0) >= 0x4e00 && ch.codePointAt(0) <= 0x9fff ? 2 : 1), 0);
/**
 * The BREAKS Claude makes in ONE hard line: wrap-ansi with `{ hard: true, trim: false }` at `width` cells, copied character by
 * character (an independent oracle for src/draft.js). Words split on single spaces; before each word after the first, a row that
 * is already `width` wide starts a new one; then one space is appended (so a word after a full row starts the next row with a
 * space, and that space counts); a word that does not fit starts a new row (the space stays, unseen, at the end of the row
 * before it); a word longer than `width` starts on the current row unless the next row saves a break, then is cut at `width`.
 * Trailing spaces are dropped from the rows.
 */
function wrapModel(text, width) {
  const rows = [''];
  const last = () => rows.length - 1;
  const used = () => cellsOf(rows[last()]);
  text.split(' ').forEach((word, i) => {
    if (i > 0) {
      if (used() >= width) rows.push('');
      rows[last()] += ' ';
    }
    const n = cellsOf(word);
    if (n > width) {
      const left = width - used();
      if (Math.floor((n - 1) / width) < 1 + Math.floor((n - left - 1) / width)) rows.push('');
      for (const ch of word) {
        if (used() + cellsOf(ch) > width) rows.push('');
        rows[last()] += ch;
      }
      return;
    }
    if (used() + n > width && used() > 0 && n > 0) rows.push('');
    rows[last()] += word;
  });
  return rows.map((r) => r.trimEnd());
}
/**
 * The rows Claude 2.1.325 DRAWS for one hard line (W5-F1 live): the model's rows, but a wrapped row loses its leading
 * whitespace when it is drawn, while that space still counted for the break. `read` tests the padded screen too.
 */
const wrap = (text, width) => wrapModel(text, width).map((r, i) => (i === 0 ? r : r.trimStart()));
const rule = (n = 40) => [span('\u2500'.repeat(n), { fg: 244 })];
const modeLine = [span('  \u23f5\u23f5 auto mode on (shift+tab to cycle)', { fg: 220 })];

describe('parseDraft: readable text', () => {
  test('(+) one line: the whole Draft shape, no `reason`, sig is 16 hex of sha256(state, mode, text)', () => {
    const d = read({ lines: ['fix the retry loop in acme-api'] });
    assert.deepEqual(d, {
      state: 'text',
      mode: 'prompt',
      text: 'fix the retry loop in acme-api',
      sig: sigOf('text', 'prompt', 'fix the retry loop in acme-api'),
      box: { top: 0, bottom: 2 },
      cursorAtEnd: true,
      suggestion: null,
      ghost: false,
    });
    assert.match(d.sig, /^[0-9a-f]{16}$/);
    assert.equal('reason' in d, false);
    assert.equal('edit' in d, false); // `edit` comes from api-app.js, never from the parser
  });

  test('(+) the width comes from `cols`, or from the rule row when `cols` is left out', () => {
    const text = sentence(212);
    const s = boxRows({ lines: wrap(text, W) });
    assert.equal(parseDraft(s.rows, s.cursor, 120).text, text);
    assert.equal(parseDraft(s.rows, s.cursor).text, text);
    assert.equal(parseDraft(s.rows, s.cursor, undefined).text, text);
  });

  test('(+) a wrapped 212-character draft at 120 columns joins its rows with a space', () => {
    const text = sentence(212);
    assert.equal(text.length, 212);
    const lines = wrap(text, W);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.length <= W));
    const d = read({ lines });
    assert.equal(d.state, 'text');
    assert.equal(d.text, text);
    assert.equal(d.cursorAtEnd, true);
  });

  test('(+) 100 short words: a row of exactly 116 characters is followed by a row drawn without its leading space; the join puts it back', () => {
    const text = Array(100).fill('ab').join(' ');
    const lines = wrap(text, W);
    assert.deepEqual(lines.map((l) => l.length), [116, 113, 68]); // 39 words, no spare column; 38 words; 23 words
    assert.deepEqual(wrapModel(text, W).map((l) => l.length), [116, 114, 68]); // the second row really is ' ' + 38 words
    assert.equal(lines[1][0], 'a');
    assert.equal(read({ lines }).text, text);
  });

  test('(+) 300 `x` cut at 116 join without a space', () => {
    const x = (n) => 'x'.repeat(n);
    const d = read({ lines: [x(116), x(116), x(68)] });
    assert.equal(d.text, x(300));
  });

  test('(+) the width follows the pane: 40 columns wrap at 36', () => {
    const text = sentence(100);
    const d = read({ cols: 40, lines: wrap(text, 36) });
    assert.equal(d.text, text);
  });

  test('(+) a space at the end of a row (a break space a capture keeps, or padding) is not text and not doubled', () => {
    const a = `${'a'.repeat(19)} ${'b'.repeat(15)} `; // 36 characters with the break space
    const d = read({ cols: 40, lines: [a, 'ccccc dd'] });
    assert.equal(d.text, `${'a'.repeat(19)} ${'b'.repeat(15)} ccccc dd`);
  });

  test('(+) three hard lines join with newlines', () => {
    const d = read({ lines: ['first line', 'second line', 'third line'] });
    assert.equal(d.text, 'first line\nsecond line\nthird line');
    assert.equal(d.cursorAtEnd, true);
  });

  test('(+) a blank middle line (indent only, or a row the capture shows empty) is an empty line', () => {
    assert.equal(read({ lines: ['first', '', 'third'] }).text, 'first\n\nthird');
    const s = boxRows({ lines: ['first', 'x', 'third'] });
    s.rows[2] = []; // tmux trimmed the row
    assert.equal(parseDraft(s.rows, s.cursor, s.cols).text, 'first\n\nthird');
    assert.equal(read({ lines: ['first', ''] }).text, 'first\n'); // a trailing blank line
    assert.equal(read({ lines: ['', 'second'] }).text, '\nsecond'); // a leading one
  });

  test('(+) leading and double spaces are kept; trailing spaces are padding, unless the cursor is past them', () => {
    assert.equal(read({ lines: ['  indented  and  double'] }).text, '  indented  and  double');
    const padding = read({ lines: ['abc   '], cursor: { x: 5 } }); // the cursor is right after the c: the spaces are Claude's padding
    assert.equal(padding.text, 'abc');
    assert.equal(padding.state, 'text');
    assert.equal(padding.cursorAtEnd, true);
    const typed = read({ lines: ['abc   '] }); // the cursor is three columns further: the user typed the spaces
    assert.equal(typed.state, 'unreadable');
    assert.equal(typed.reason, 'trailing');
  });

  test('(+) unicode: accents, a check mark, wide East Asian characters and an emoji', () => {
    const text = 'h\u00e9llo \u2713 \u65e5\u672c\u8a9e \u{1F600}';
    const d = read({ lines: [text] });
    assert.equal(d.text, text);
    assert.equal(d.cursorAtEnd, true); // the cursor column counts 2 cells per wide character
  });

  test('(+) a no-break space inside the text reads as a space; after the glyph only a no-break space starts a box', () => {
    const s = boxRows({ lines: [`a${NB}b`] });
    assert.equal(parseDraft(s.rows, s.cursor, s.cols).text, 'a b');
    s.rows[1] = [span(`${PROMPT} a b`)];
    assert.equal(parseDraft(s.rows, s.cursor, s.cols), null); // a plain space after the glyph is a user's status line (I-1)
  });

  test('(+) the glyph may sit after up to two spaces; the cursor column shifts with it', () => {
    const s = boxRows({ lines: ['x'] });
    s.rows[1] = [span(`  ${PROMPT}${NB}x`)];
    const d = parseDraft(s.rows, { x: 5, y: 1, visible: true }, s.cols);
    assert.equal(d.text, 'x');
    assert.equal(d.cursorAtEnd, true);
  });

  test('(+) a hint row above the top rule (Esc again to clear, paste again to expand) is outside the box', () => {
    const d = read({ lines: ['hello'], hint: 'Esc again to clear' });
    assert.equal(d.text, 'hello');
    assert.deepEqual(d.box, { top: 1, bottom: 3 });
    assert.equal(d.cursorAtEnd, true);
  });

  test('(+) I-1: a draft line made of rule dashes is a line of the draft, never the top of the box', () => {
    const border = '\u2500'.repeat(10);
    const glyphAfter = read({ lines: ['a', border, '! ls'] }); // a pasted table border, then a line that starts like a prompt row
    assert.equal(glyphAfter.mode, 'prompt');
    assert.equal(glyphAfter.state, 'text');
    assert.equal(glyphAfter.text, `a\n${border}\n! ls`);
    assert.deepEqual(glyphAfter.box, { top: 0, bottom: 4 });
    assert.equal(read({ lines: ['a', border, '\u276f y'] }).text, `a\n${border}\n\u276f y`);
    assert.equal(read({ lines: ['a', border, 'plain'] }).text, `a\n${border}\nplain`); // used to be null: the fake top had no prompt row
    assert.equal(read({ lines: ['a', border] }).text, `a\n${border}`); // used to be null: nothing between the fake top and the bottom
  });

  test('(−) I-1: an indented rule row is not a rule row', () => {
    const s = boxRows({ lines: ['hello'] });
    s.rows[0] = [span(`  ${'\u2500'.repeat(40)}`, { fg: 244 })]; // the top rule, indented by two spaces
    assert.equal(parseDraft(s.rows, s.cursor, s.cols), null); // one rule row is left
  });

  test('(+) I-3: S9 wrap sample (100 x "ab": rows of 116, 113 and 68) reads back as the original text', () => {
    // S9 measured 116 / 113 / 68 and Claude 2.1.325 draws exactly that (W5-F1 live): the second row is the model's ' ' + 38 words,
    // drawn without the leading space, which still counted for the break. So row 2 stops at 113, not at 116.
    const words = Array(100).fill('ab');
    const lines = [words.slice(0, 39).join(' '), words.slice(39, 77).join(' '), words.slice(77).join(' ')];
    assert.deepEqual(lines.map((l) => l.length), [116, 113, 68]);
    assert.deepEqual(wrap(words.join(' '), W), lines);
    const d = read({ lines });
    assert.equal(d.text, words.join(' '));
    assert.equal(d.state, 'text');
  });

  test('(+) F1 rule 3: a short row and a row that starts with a word: a space when the first word would not have fitted, else a newline', () => {
    const a = (n) => 'a'.repeat(n);
    assert.equal(read({ lines: [a(114), 'bb'] }).text, `${a(114)} bb`); // 114 + 1 + 2 = 117 > W
    assert.equal(read({ lines: [a(113), 'bb'] }).text, `${a(113)}\nbb`); // 113 + 1 + 2 = 116 = W: it fitted, so this is a hard newline
    assert.equal(read({ lines: [a(34), 'bb'], cols: 40 }).text, `${a(34)} bb`); // 34 + 1 + 2 = 37 > 36 at 40 columns
    assert.equal(read({ lines: [a(33), 'bb'], cols: 40 }).text, `${a(33)}\nbb`);
    assert.equal(read({ lines: [a(110), 'bbbbb'] }).text, `${a(110)}\nbbbbb`); // T2 live: 110 + 1 + 5 = 116 is a newline
    assert.equal(read({ lines: [a(111), 'bbbbb'] }).text, `${a(111)} bbbbb`); // 117 wraps
    assert.equal(read({ lines: ['x', 'y z'] }).text, 'x\ny z'); // a short row is nowhere near the width
  });

  test('(+) F1 full row: several words fill the row exactly; the next row starts at its word, joined with a space', () => {
    const text = `${'x'.repeat(60)} ${'y'.repeat(55)} zz`; // 116 cells, then zz
    const lines = wrap(text, W);
    assert.deepEqual(lines, [`${'x'.repeat(60)} ${'y'.repeat(55)}`, 'zz']);
    assert.equal(read({ lines }).text, text);
    const small = `${'x'.repeat(50)} ${'y'.repeat(45)} yy zz`; // 100 columns: W = 96, a full row of 96
    assert.deepEqual(wrap(small, 96).map((l) => l.length), [96, 5]);
    assert.equal(read({ lines: wrap(small, 96), cols: 100 }).text, small);
  });

  test('(+) F1 lost: the space Claude dropped from the start of a wrapped row still counts for the row after it', () => {
    const k = (n) => 'k'.repeat(n);
    const text = `${'x'.repeat(60)} ${'y'.repeat(55)} ${'z'.repeat(10)} ${k(102)} ww`;
    const lines = wrap(text, W);
    assert.deepEqual(lines.map((l) => l.length), [116, 113, 2]); // the real second row is ' ' + 113 = 114, and ' ww' would make 117
    assert.equal(read({ lines }).text, text);
    assert.equal(read({ lines: [lines[1], 'ww'] }).text, `${lines[1]}\nww`); // with no full row before it: 113 + 1 + 2 = 116 fits, a newline
  });

  test('(+) F1 lost: a chain of rows that are full only with their dropped space', () => {
    const k = (n) => 'k'.repeat(n);
    const text = `${'x'.repeat(60)} ${'y'.repeat(55)} ${'z'.repeat(10)} ${k(104)} ww ${k(112)} qq`;
    const lines = wrap(text, W);
    assert.deepEqual(lines.map((l) => l.length), [116, 115, 115, 2]); // rows 2 and 3 are 116 with the space Claude did not draw
    assert.equal(read({ lines }).text, text);
  });

  test('(+) F1 rule 2: a full row and a row that continues its last word join with nothing (a cut word)', () => {
    const x = (n) => 'x'.repeat(n);
    assert.equal(read({ lines: [x(116), x(14)] }).text, x(130)); // a 130-character word alone
    assert.deepEqual(wrap(x(130), W).map((l) => l.length), [116, 14]);
    const short = `${'a'.repeat(10)} ${'b'.repeat(125)}`; // T2 live: a short word and a 125-character word
    const lines = wrap(short, W);
    assert.deepEqual(lines.map((l) => l.length), [116, 20]);
    assert.equal(read({ lines }).text, short); // the space is inside the first row: no second one
    const three = `${'a'.repeat(30)} ${'b'.repeat(260)}`; // the word is cut over three rows
    assert.equal(read({ lines: wrap(three, W) }).text, three);
  });

  test('(+) F1: a 100-cell row, then a 232-character word: the word moves to its own rows, joined with a space', () => {
    const text = `${'a'.repeat(100)} ${'b'.repeat(232)}`;
    const lines = wrap(text, W);
    assert.deepEqual(lines.map((l) => l.length), [100, 116, 116]); // starting on row 1 would cost an extra break
    assert.equal(read({ lines }).text, text);
  });

  test('(+) F1: the model at 100 columns (W = 96)', () => {
    const words = Array(100).fill('ab').join(' ');
    const lines = wrap(words, 96);
    assert.equal(lines[0].length, 95); // 32 words; the 33rd would end at 98
    assert.equal(lines[1][0], 'a'); // the row was not yet full when the next word came
    assert.equal(read({ cols: 100, lines }).text, words);
  });

  test('(+) F1 wide characters: a cut word whose next wide character does not fit leaves a row one cell short; it still joins with nothing', () => {
    const wide = '\u65e5';
    const text = `ab ${wide.repeat(70)}`; // live: rows of 115 and 28 cells
    const lines = wrap(text, W);
    assert.deepEqual(lines.map(cellsOf), [115, 28]);
    assert.equal(read({ lines }).text, text);
    const soft = `${'x'.repeat(50)} ${'y'.repeat(64)} ${wide.repeat(2)}`; // 115 cells, the wide word does not fit behind the space: a soft wrap
    const rows = wrap(soft, W);
    assert.deepEqual(rows.map(cellsOf), [115, 4]);
    assert.equal(read({ lines: rows }).text, soft);
    assert.equal(read({ lines: wrap(wide.repeat(80), W) }).text, wide.repeat(80)); // 58 per row: 116 and 44, a full row
  });

  test('(−) F1 residual: a hard line of exactly 116 cells followed by a hard newline reads as a soft wrap (the newline becomes a space)', () => {
    const line = Array(39).fill('ab').join(' ');
    assert.equal(line.length, W);
    // Claude draws the same two rows for `line + "\n" + "cd"` and for `line + " cd"`. nika reads the second; the write's read-back
    // then differs from what was typed, which ends in a safe 409 `draft-mismatch` (never a wrong key).
    assert.equal(read({ lines: [line, 'cd'] }).text, `${line} cd`);
    assert.equal(read({ lines: [wrap(`${line} cd`, W)[0], 'cd'] }).text, `${line} cd`);
  });

  test('(−) F1 residual: a full row that is one word of exactly 116 cells, a space and a word: the space is lost (a cut word)', () => {
    const x = 'x'.repeat(116);
    // x116 + ' foo' and the 119-character word x116foo are drawn alike (live): nika reads the cut word.
    assert.deepEqual(wrap(`${x} foo`, W), [x, 'foo']);
    assert.equal(read({ lines: wrap(`${x} foo`, W) }).text, `${x}foo`);
    assert.equal(read({ lines: wrap(`${'x'.repeat(96)} yy zz`, 96), cols: 100 }).text, `${'x'.repeat(96)}yy zz`);
    const long = `${x} ${'b'.repeat(114)} c`; // live: rows 116 / 114 / 1; the first row is one word, so the second row reads as its continuation
    assert.deepEqual(wrap(long, W).map((l) => l.length), [116, 114, 1]);
    assert.equal(read({ lines: wrap(long, W) }).text, `${x}${'b'.repeat(114)}\nc`); // the lost space of row 2 is lost with it: 114 + 1 + 1 fits, a newline
    assert.equal(read({ lines: wrap(`${x}  foo`, W) }).text, `${x}foo`); // live: both typed spaces are gone
  });

  test('(−) F1 residual: a double space at a wrap becomes one space (Claude draws neither)', () => {
    const full = `${'x'.repeat(60)} ${'y'.repeat(55)}`;
    assert.equal(read({ lines: wrap(`${full}  foo`, W) }).text, `${full} foo`); // the break falls after a full row
    const a = 'a'.repeat(114);
    assert.equal(read({ lines: wrap(`${a}  bb`, W) }).text, `${a} bb`); // the break falls after a short row
  });

  test('(−) F1 residual: a full row, a space and a word that does not fit behind it: Claude draws an empty row between; it reads as newlines', () => {
    const x = 'x'.repeat(116);
    const lines = wrap(`${x} ${'y'.repeat(116)}`, W);
    assert.deepEqual(lines.map((l) => l.length), [116, 0, 116]);
    assert.equal(read({ lines }).text, `${x}\n\n${'y'.repeat(116)}`);
  });

  test('(−) F1 rule 4: anything else breaks with a newline (a blank row, a leading space, a row wider than the width)', () => {
    const full = `${'x'.repeat(60)} ${'y'.repeat(55)}`;
    assert.equal(read({ lines: [full, '  foo'] }).text, `${full}\n  foo`); // a drawn wrap never starts with a space: this is a hard line
    assert.equal(read({ lines: [full, ' foo'] }).text, `${full}\n foo`);
    assert.equal(read({ lines: ['ab', '', 'cd'] }).text, 'ab\n\ncd');
    assert.equal(read({ lines: ['a'.repeat(50), ' b'] }).text, `${'a'.repeat(50)}\n b`);
    assert.equal(read({ lines: [full, ''] }).text, `${full}\n`);
    const x = (n) => 'x'.repeat(n);
    assert.equal(read({ lines: [x(116), x(14)], cols: 100 }).text, `${x(116)}\n${x(14)}`); // at 100 columns a row of 116 cells cannot be a wrap
  });

  test('(+) M-3: without `cols` the width is the lower rule row: a 40-column pane wraps at 36', () => {
    const text = sentence(100);
    const s = boxRows({ cols: 40, lines: wrap(text, 36) });
    assert.equal(parseDraft(s.rows, s.cursor).text, text);
    assert.equal(parseDraft(s.rows, s.cursor, 3).text, text); // an unusable cols falls back too
  });

  test('(+) a session name drawn into the top rule is still the box; vim INSERT in the mode line changes nothing', () => {
    const d = read({ lines: ['hello'], label: 'acme-api', insert: true });
    assert.equal(d.state, 'text');
    assert.equal(d.text, 'hello');
    assert.equal(read({ lines: ['hello'], label: 'History' }).state, 'text'); // not `History n/m`
    assert.equal(read({ lines: ['hello'], label: 'History 3/x' }).state, 'text');
  });

  test('(+) the output above the box and any rule row in it are ignored: the box is between the last two rules', () => {
    const s = boxRows({ lines: ['hello'] });
    const rows = [[span('build ok in web-shop')], rule(), [span('log line')], ...s.rows];
    const d = parseDraft(rows, { ...s.cursor, y: s.cursor.y + 3 }, s.cols);
    assert.equal(d.text, 'hello');
    assert.deepEqual(d.box, { top: 3, bottom: 5 });
  });

  test('(−) a hard newline whose next first word would not fit reads as a soft wrap (accepted ambiguity, design 1.4)', () => {
    const d = read({ lines: ['a'.repeat(110), 'b'.repeat(8)] });
    assert.equal(d.text, `${'a'.repeat(110)} ${'b'.repeat(8)}`);
  });

  test('(−) the parser does not change the rows it reads', () => {
    const s = boxRows({ lines: ['hello', 'world'], ghost: ' ghost' });
    const before = structuredClone(s.rows);
    parseDraft(s.rows, s.cursor, s.cols);
    assert.deepEqual(s.rows, before);
  });
});

describe('parseDraft: empty box and ghost text', () => {
  const EMPTY_AT = (suggestion, text = '', ghost = suggestion !== null) => ({
    state: 'empty', mode: 'prompt', text, sig: sigOf('empty', 'prompt', text), box: { top: 0, bottom: 2 }, cursorAtEnd: true, suggestion, ghost,
  });

  test('(+) the glyph and a no-break space alone is empty', () => {
    assert.deepEqual(read({ lines: [''] }), EMPTY_AT(null));
  });

  test('(+) the glyph alone at the end of the row, and a row of spaces, are empty too', () => {
    const s = boxRows({ lines: [''] });
    s.rows[1] = [span(PROMPT)];
    assert.equal(parseDraft(s.rows, s.cursor, s.cols).state, 'empty');
    assert.equal(read({ lines: ['   '], cursor: { x: 2 } }).state, 'empty'); // spaces are padding while the cursor stays at column 2
    assert.equal(read({ lines: ['   '], cursor: { x: 2 } }).text, '');
    assert.equal(read({ lines: ['   '] }).reason, 'trailing'); // the cursor after three typed spaces
  });

  test('(+) the dim `Try "..."` placeholder is empty and is not a suggestion', () => {
    assert.deepEqual(read({ lines: [''], ghost: 'Try "fix typecheck errors"' }), EMPTY_AT(null, '', true)); // dim text was dropped
  });

  test('(+) a dim one-word suggestion is empty and is returned as `suggestion`', () => {
    assert.deepEqual(read({ lines: [''], ghost: 'yes' }), EMPTY_AT('yes'));
    const d = read({ lines: [''], ghost: '  run the tests in\tacme-api  ' });
    assert.equal(d.suggestion, 'run the tests in acme-api'); // clean(): spaces collapsed
    assert.equal(read({ lines: [''], ghost: 'z'.repeat(300) }).suggestion.length, 200);
  });

  test('(+) a first character in reverse video over a dim rest is the placeholder under the cursor: empty', () => {
    const d = read({ lines: [[span('y', { r: true }), span('es', { d: true })]], cursor: { x: 2 } });
    assert.equal(d.state, 'empty');
    assert.equal(d.text, '');
    assert.equal(d.suggestion, 'yes');
    const t = read({ lines: [[span('T', { r: true }), span('ry "fix lint errors"', { d: true })]], cursor: { x: 2 } });
    assert.equal(t.state, 'empty');
    assert.equal(t.suggestion, null);
  });

  test('(+) a suggestion longer than one row wraps onto a ghost-only row: still empty, whole text as the suggestion', () => {
    const d = read({ lines: [[span('add a test for the retry loop and', { d: true })], [span('check the backoff', { d: true })]] });
    assert.equal(d.state, 'empty');
    assert.equal(d.text, '');
    assert.equal(d.suggestion, 'add a test for the retry loop and check the backoff');
  });

  test('(+) ghost text after real text is dropped from `text`; there is no suggestion for a box that holds text', () => {
    const d = read({ lines: ['hello'], ghost: ' world' });
    assert.equal(d.state, 'text');
    assert.equal(d.text, 'hello');
    assert.equal(d.suggestion, null);
    assert.equal(d.cursorAtEnd, true);
  });

  test('(−) text that merely looks like the placeholder but is not dim is a draft', () => {
    const d = read({ lines: ['Try "edit foo"'] });
    assert.equal(d.state, 'text');
    assert.equal(d.text, 'Try "edit foo"');
    assert.equal(d.suggestion, null);
  });

  test('(−) a reverse-video character with real text after it is real text, not ghost', () => {
    const d = read({ lines: [[span('a', { r: true }), span('bc')]] });
    assert.equal(d.state, 'text');
    assert.equal(d.text, 'abc');
    const only = read({ lines: [[span('T', { r: true })]] });
    assert.equal(only.text, 'T'); // nothing dim after it
  });

  test('(−) a bold, coloured or underlined run is real text', () => {
    const d = read({ lines: [[span('see ', { b: true }), span('web-shop', { fg: 39, u: true })]] });
    assert.equal(d.text, 'see web-shop');
  });
});

describe('parseDraft: dim runs and real text', () => {
  const dim = (t) => span(t, { d: true });
  const layout = (d) => {
    assert.equal(d.state, 'unreadable');
    assert.equal(d.reason, 'layout');
    assert.equal(d.text, '');
    assert.equal(d.sig, null);
  };

  test('(+) (a) a box with no real text: every dim run on every row is ghost', () => {
    const d = read({ lines: [[dim('first half of a long suggestion')], [dim('second half')]] });
    assert.equal(d.state, 'empty');
    assert.equal(d.suggestion, 'first half of a long suggestion second half');
    assert.equal(read({ lines: [''], ghost: 'Try "fix lint errors"' }).state, 'empty');
  });

  test('(+) (b) one trailing dim run that starts at the cursor column on the cursor row is a completion ghost', () => {
    const d = read({ lines: ['hello'], ghost: ' world' });
    assert.equal(d.state, 'text');
    assert.equal(d.text, 'hello');
    assert.equal(d.cursorAtEnd, true);
    assert.equal(d.suggestion, null);
    assert.equal(read({ lines: ['one', 'two'], ghost: ' three' }).text, 'one\ntwo');
    assert.equal(read({ lines: ['hello'], ghost: ' world', insert: true }).text, 'hello');
    const onBlank = read({ lines: ['hello', [dim('more')]] }); // the cursor sits on a new empty line and the ghost starts there
    assert.equal(onBlank.text, 'hello\n');
    assert.equal(onBlank.state, 'text');
  });

  test('(−) a dim row between two rows of real text is unreadable: layout', () => {
    layout(read({ lines: ['one', [dim('hidden')], 'three'] }));
  });

  test('(−) dim text before real text on a row, or in the middle of it, is unreadable: layout', () => {
    layout(read({ lines: [[dim('ab '), span('cd')]] }));
    layout(read({ lines: [[span('abc '), dim('HIDDEN '), span('def')]] }));
    layout(read({ lines: [[span('ab'), dim('XX'), span('cd')]], cursor: { x: 4 } })); // starts at the cursor, but real text follows it
  });

  test('(−) a trailing dim run that does not start at the cursor column, or there is no cursor, is unreadable: layout', () => {
    layout(read({ lines: ['hello'], ghost: ' world', cursor: { dx: -1 } })); // vim NORMAL: the cursor is on the last character
    layout(read({ lines: ['hello'], ghost: ' world', cursor: { dx: 1 } }));
    layout(read({ lines: ['hello'], ghost: ' world', cursor: null }));
    layout(read({ lines: [[span('one'), dim(' x')], 'two'] })); // dim on a row that is not the cursor row
    layout(read({ lines: ['hello'], ghost: ' world', cursor: { y: 0 } }));
  });

  test('(−) two dim runs next to real text are unreadable even when one of them is at the cursor', () => {
    layout(read({ lines: [[dim('x'), span('abc'), dim(' tail')]], cursor: { x: 5 } }));
    layout(read({ lines: [[span('abc'), dim(' one'), span(' '), dim('two')]], cursor: { x: 5 } }));
  });

  test('(−) M-3: a reverse-video first character is ghost only when every later visible character is dim, on the first row only', () => {
    const some = read({ lines: [[span('a', { r: true }), span('b'), dim('c')]] }); // `some`, not `every`: a is real text
    assert.equal(some.text, 'ab');
    assert.equal(some.state, 'text');
    const second = read({ lines: ['abc', [span('d', { r: true }), dim('ef')]] }); // not the first row: d is real
    assert.equal(second.text, 'abc\nd');
    assert.equal(read({ lines: [[span('a', { r: true }), span('b')]] }).text, 'ab');
  });
});

describe('parseDraft: bash mode', () => {
  test('(+) `! ls -la` with fg-211 rules is bash mode, text without the `!`', () => {
    const s = boxRows({ mode: 'bash', lines: ['ls -la'] });
    assert.equal(s.rows[0][0].s.fg, 211);
    const d = parseDraft(s.rows, s.cursor, s.cols);
    assert.equal(d.mode, 'bash');
    assert.equal(d.state, 'text');
    assert.equal(d.text, 'ls -la');
    assert.equal(d.sig, sigOf('text', 'bash', 'ls -la'));
    assert.equal(d.cursorAtEnd, true);
    assert.equal(read({ mode: 'bash', lines: ['ls -la'], insert: true }).text, 'ls -la');
  });

  test('(+) the bash placeholder (dim) is an empty bash box', () => {
    const d = read({ mode: 'bash', lines: [''], ghost: 'Try "npm test"' });
    assert.equal(d.state, 'empty');
    assert.equal(d.mode, 'bash');
    assert.equal(d.suggestion, null);
  });

  test('(+) sig differs by mode for the same text', () => {
    assert.notEqual(read({ lines: ['ls'] }).sig, read({ mode: 'bash', lines: ['ls'] }).sig);
  });

  test('(+) a bash box with an ordinary permission-mode footer is read too', () => {
    const d = read({ mode: 'bash', lines: ['ls'], footer: '\u23f5\u23f5 auto mode on' });
    assert.equal(d.mode, 'bash');
    assert.equal(d.text, 'ls');
  });

  test('(−) the shell-mode footer does not make a `❯` box readable, and a bash box with an unknown footer is not either', () => {
    assert.equal(read({ lines: ['ls'], footer: '! for shell mode' }), null);
    assert.equal(read({ mode: 'bash', lines: ['ls'], footer: 'some footer nobody recognises' }), null);
  });
});

describe('parseDraft: slash commands and the argument hint', () => {
  test('(+) `/com` typed in plain text is text', () => {
    const d = read({ lines: ['/com'] });
    assert.equal(d.state, 'text');
    assert.equal(d.text, '/com');
  });

  test('(+) the command word in fg 153 is real; the fg-246 hint that starts at the cursor column is ghost', () => {
    const lines = [[span('/compact', { fg: 153 }), span(' '), span('<optional custom summarization instructions>', { fg: 246 })]];
    const d = read({ lines });
    assert.equal(d.state, 'text');
    assert.equal(d.text, '/compact ');
    assert.equal(d.cursorAtEnd, true);
    assert.equal(d.suggestion, null);
  });

  test('(+) the column of the hint counts wide characters as two cells', () => {
    const lines = [[span('\u65e5\u672c\u8a9e '), span('<hint>', { fg: 246 })]];
    const d = read({ lines });
    assert.equal(d.text, '\u65e5\u672c\u8a9e ');
    assert.equal(d.cursorAtEnd, true);
  });

  test('(−) the same hint one column left of the cursor is real text (the rule is "at or after")', () => {
    const lines = [[span('/compact', { fg: 153 }), span(' '), span('<optional>', { fg: 246 })]];
    const d = read({ lines, cursor: { dx: 1 } });
    assert.equal(d.text, '/compact <optional>');
    assert.equal(d.cursorAtEnd, false);
  });

  test('(−) an fg-246 run is real text when the cursor is on another row, missing, or the run is not on the cursor row', () => {
    const lines = [[span('note '), span('<x>', { fg: 246 })]];
    assert.equal(read({ lines, cursor: null }).text, 'note <x>');
    assert.equal(read({ lines, cursor: { y: 0 } }).text, 'note <x>');
    const two = read({ lines: ['first', [span('note '), span('<x>', { fg: 246 })]], cursor: { y: 1, x: 7 } });
    assert.equal(two.text, 'first\nnote <x>');
  });

  test('(−) M-3: a run in any other colour at or after the cursor column is real text, only fg 246 is the hint', () => {
    const d = read({ lines: [[span('/compact '), span('<optional>', { fg: 39 })]], cursor: { x: 11 } });
    assert.equal(d.text, '/compact <optional>');
    const dim = read({ lines: [[span('/compact '), span('<optional>', { fg: 246, d: true })]], cursor: { x: 11 } });
    assert.equal(dim.text, '/compact '); // dim and fg 246 is ghost by the dim rule
  });

  test('(−) a dim-less fg-246 run before the cursor is real text', () => {
    const d = read({ lines: [[span('see ', { fg: 246 }), span('web-shop')]], cursor: { x: 14 } });
    assert.equal(d.text, 'see web-shop');
  });
});

describe('parseDraft: ghost flag (M-4)', () => {
  const dim = (t) => span(t, { d: true });

  test('(+) plain typed text and an empty box have no ghost', () => {
    assert.equal(read({ lines: ['hello'] }).ghost, false);
    assert.equal(read({ lines: ['one', 'two'] }).ghost, false);
    assert.equal(read({ lines: [''] }).ghost, false);
    assert.equal(read({ lines: [[span('a', { r: true }), span('bc')]] }).ghost, false); // a reverse-video cursor on real text is text
    assert.equal(read({ lines: [[span('note '), span('<x>', { fg: 246 })]], cursor: null }).ghost, false); // an fg-246 run away from the cursor is text
    assert.equal(read({ lines: ['x'], mode: 'bash' }).ghost, false);
  });

  test('(+) a dim suggestion, the placeholder and a completion ghost are ghost', () => {
    const suggestion = read({ lines: [''], ghost: 'run the tests in acme-api' });
    assert.equal(suggestion.ghost, true);
    assert.equal(suggestion.suggestion, 'run the tests in acme-api');
    assert.equal(read({ lines: [''], ghost: 'Try "fix lint errors"' }).ghost, true);
    const completion = read({ lines: ['hello'], ghost: ' world' });
    assert.equal(completion.ghost, true);
    assert.equal(completion.text, 'hello'); // dropped from the text
    assert.equal(read({ lines: [[dim('first half of a long suggestion')], [dim('second half')]] }).ghost, true);
  });

  test('(+) the slash command argument hint (fg 246 at the cursor) and a reverse-video cursor over the placeholder are ghost', () => {
    const hint = read({ lines: [[span('/compact', { fg: 153 }), span(' '), span('<optional custom summarization instructions>', { fg: 246 })]] });
    assert.equal(hint.ghost, true);
    assert.equal(hint.text, '/compact ');
    assert.equal(read({ lines: [[span('y', { r: true }), span('es', { d: true })]], cursor: { x: 2 } }).ghost, true);
  });

  test('(−) an unreadable box reports no ghost (nothing was read)', () => {
    assert.equal(read({ lines: ['old prompt'], label: 'History 3/3', ghost: ' x' }).ghost, false);
    assert.equal(read({ lines: ['[Pasted text #4 +3 lines]'] }).ghost, false);
  });
});

describe('parseDraft: cursor and sig', () => {
  test('(+) cursorAtEnd is true at the end (plain, vim INSERT), false one column left (vim NORMAL), false mid-text', () => {
    assert.equal(read({ lines: ['hello world'] }).cursorAtEnd, true);
    assert.equal(boxRows({ lines: ['hello world'] }).cursor.x, 13); // S9: 13,34 for 11 characters
    assert.equal(read({ lines: ['hello world'], insert: true }).cursorAtEnd, true);
    const normal = read({ lines: ['hello world'], cursor: { dx: -1 } });
    assert.equal(normal.cursorAtEnd, false);
    assert.equal(normal.state, 'text');
    assert.equal(read({ lines: ['hello world'], cursor: { dx: -6 } }).cursorAtEnd, false);
    assert.equal(read({ lines: ['hello world'], cursor: { x: 2 } }).cursorAtEnd, false);
  });

  test('(−) cursorAtEnd is false when the cursor is on another row, or is missing or not made of integers', () => {
    assert.equal(read({ lines: ['a', 'b'], cursor: { y: 1 } }).cursorAtEnd, false); // first row of two
    assert.equal(read({ lines: ['hello'], cursor: null }).cursorAtEnd, false);
    const s = boxRows({ lines: ['hello'] });
    assert.equal(parseDraft(s.rows, { x: 'a', y: 1 }, s.cols).cursorAtEnd, false);
    assert.equal(parseDraft(s.rows, undefined, s.cols).state, 'text');
  });

  test('(+) an empty box has the cursor at column 2: at the end', () => {
    assert.equal(read({ lines: [''] }).cursorAtEnd, true);
    assert.equal(read({ lines: [''], ghost: 'yes' }).cursorAtEnd, true);
  });

  test('(+) sig is stable across a redraw with other SGR styles and another cursor, and differs by text', () => {
    const plain = read({ lines: ['fix the build'] });
    const styled = read({ lines: [[span('fix ', { fg: 153 }), span('the build', { b: true })]], cursor: { dx: -3 } });
    assert.equal(styled.text, plain.text);
    assert.equal(styled.sig, plain.sig);
    assert.notEqual(read({ lines: ['fix the builds'] }).sig, plain.sig);
    assert.notEqual(read({ lines: ['fix  the build'] }).sig, plain.sig); // raw text, not normalised
  });
});

describe('parseDraft: rows padded with spaces to the pane width (seen live, Claude 2.1.325)', () => {
  test('(+) the padded helper pads every row to the width; the default does not', () => {
    const plain = boxRows({ lines: ['hello world'] });
    assert.equal(rowText(plain.rows[1]).length, 13);
    const padded = boxRows({ lines: ['hello world'], pad: true });
    for (const row of padded.rows) assert.equal(rowText(row).length, 120);
    assert.deepEqual(padded.cursor, plain.cursor); // the cursor does not move
  });

  test('(+) live one-line draft: one span `glyph hello world` plus spaces to 120 columns, cursor 13: text without the padding, cursor at the end', () => {
    const s = boxRows({ lines: ['hello world'], pad: true });
    s.rows[1] = [span(`${PROMPT}${NB}hello world${' '.repeat(120 - 13)}`)];
    assert.equal(rowText(s.rows[1]).length, 120);
    assert.deepEqual(s.cursor, { x: 13, y: 1, visible: true });
    const d = parseDraft(s.rows, s.cursor, s.cols);
    assert.equal(d.state, 'text');
    assert.equal(d.text, 'hello world');
    assert.equal(d.cursorAtEnd, true);
    assert.equal(d.sig, sigOf('text', 'prompt', 'hello world'));
  });

  test('(+) live empty box: the dim placeholder plus padding to 120 columns is empty, cursor 2 is at the end', () => {
    const s = boxRows({ lines: [''], ghost: 'Try "fix typecheck errors"', pad: true });
    assert.equal(rowText(s.rows[1]).length, 120);
    const d = parseDraft(s.rows, s.cursor, s.cols);
    assert.equal(d.state, 'empty');
    assert.equal(d.text, '');
    assert.equal(d.cursorAtEnd, true);
    assert.equal(d.suggestion, null);
    const yes = read({ lines: [''], ghost: 'yes', pad: true });
    assert.equal(yes.suggestion, 'yes');
    assert.equal(yes.cursorAtEnd, true);
  });

  test('(+) padding behind a completion ghost or an argument hint is dropped; the user\'s own space before a hint stays', () => {
    const completion = read({ lines: ['hello'], ghost: ' world', pad: true });
    assert.equal(completion.text, 'hello');
    assert.equal(completion.cursorAtEnd, true);
    const slash = read({ lines: [[span('/compact', { fg: 153 }), span(' '), span('<optional custom summarization instructions>', { fg: 246 })]], pad: true });
    assert.equal(slash.text, '/compact ');
    assert.equal(slash.cursorAtEnd, true);
  });

  test('(+) padding on every row of a wrapped, multi-line draft with a blank line', () => {
    const text = sentence(212);
    assert.equal(read({ lines: wrap(text, W), pad: true }).text, text);
    assert.equal(read({ lines: ['first', '', 'third'], pad: true }).text, 'first\n\nthird');
    assert.equal(read({ lines: ['first', ''], pad: true }).text, 'first\n');
    assert.equal(read({ lines: ['first', ''], pad: true }).cursorAtEnd, true); // the cursor sits on the blank last row
  });

  test('(−) typed trailing spaces are still seen through the cursor, padded or not: trailing', () => {
    const d = read({ lines: ['abc'], cursor: { dx: 3 }, pad: true });
    assert.equal(d.state, 'unreadable');
    assert.equal(d.reason, 'trailing');
    assert.equal(read({ lines: [''], cursor: { x: 5 }, pad: true }).reason, 'trailing');
    assert.equal(read({ lines: ['abc'], cursor: { dx: 0 }, pad: true }).state, 'text');
  });
});

describe('parseDraft: unreadable', () => {
  const unreadable = (reason, mode = 'prompt', bottom = 2) => ({
    state: 'unreadable', mode, text: '', sig: null, reason, box: { top: 0, bottom }, cursorAtEnd: false, suggestion: null, ghost: false,
  });

  test('(−) a `History n/m` rule (prompt-history recall) is unreadable: history, the whole shape', () => {
    assert.deepEqual(read({ lines: ['an old prompt for acme-api'], label: 'History 3/3' }), unreadable('history'));
    assert.deepEqual(read({ lines: ['ls'], label: 'History 17/17', mode: 'bash' }), unreadable('history', 'bash'));
  });

  test('(−) 14 and 15 box rows are unreadable (tall); 13 rows are readable', () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
    assert.equal(read({ lines: rows(13) }).state, 'text');
    assert.equal(read({ lines: rows(13) }).text, rows(13).join('\n'));
    const d14 = read({ lines: rows(14) });
    assert.equal(d14.state, 'unreadable');
    assert.equal(d14.reason, 'tall');
    assert.equal(d14.box.bottom - d14.box.top - 1, 14);
    assert.equal(read({ lines: rows(15) }).reason, 'tall');
  });

  test('(−) `[Pasted text #N]` and `[Pasted text #N +K lines]`, alone or inside text, are unreadable: pasted', () => {
    assert.deepEqual(read({ lines: ['[Pasted text #4 +3 lines]'] }), unreadable('pasted'));
    assert.equal(read({ lines: ['[Pasted text #10]'] }).reason, 'pasted');
    assert.equal(read({ lines: ['look at [Pasted text #4 +3 lines] and fix it'] }).reason, 'pasted');
    assert.equal(read({ lines: ['first', 'then [Pasted text #2] here'] }).reason, 'pasted');
    assert.equal(read({ lines: ['[Pasted text #1 +10 lines]'], ghost: ' x' }).state, 'unreadable');
  });

  test('(−) text that only resembles the placeholder is a draft', () => {
    assert.equal(read({ lines: ['[Pasted text]'] }).state, 'text');
    assert.equal(read({ lines: ['Pasted text #4'] }).state, 'text');
    assert.equal(read({ lines: ['[Pasted text #x]'] }).state, 'text');
  });

  test('(−) I-2: a placeholder broken by a newline or a wrap is still pasted', () => {
    assert.equal(read({ lines: ['look [Pasted text #4 +3', 'lines] ok'] }).reason, 'pasted'); // a hard newline inside it
    assert.equal(read({ lines: ['look [Pasted text #4', '+3 lines] ok'] }).reason, 'pasted');
    assert.equal(read({ lines: ['[Pasted', 'text #4]'] }).reason, 'pasted');
    assert.equal(read({ lines: ['[Pasted  text', '#4  +3\n lines]'] }).reason, 'pasted'); // other white space inside it
    const row0 = `${'a'.repeat(10)} [Pasted text #4 +3`; // 29 wide = W - 7 at 40 columns, the review's probe
    assert.equal(read({ cols: 40, lines: [row0, 'lines] ok'] }).reason, 'pasted');
  });

  test('(−) I-2: a dim placeholder is pasted, not an empty box or a completion ghost', () => {
    assert.equal(read({ lines: [''], ghost: '[Pasted text #1 +10 lines]' }).reason, 'pasted');
    assert.equal(read({ lines: [[span('[Pasted text #4 +3', { d: true })], [span('lines]', { d: true })]] }).reason, 'pasted');
    assert.equal(read({ lines: ['hello'], ghost: ' [Pasted text #2]' }).reason, 'pasted');
  });

  test('(−) M-4: an image placeholder is unreadable too: pasted', () => {
    assert.equal(read({ lines: ['[Image #1]'] }).reason, 'pasted');
    assert.equal(read({ lines: ['see [Image #12] above'] }).reason, 'pasted');
    assert.equal(read({ lines: ['[Image]'] }).state, 'text');
    assert.equal(read({ lines: ['[Image #x]'] }).state, 'text');
  });

  test('(−) M-1: a History label with other spacing or a no-break space is still prompt-history recall', () => {
    assert.equal(read({ lines: ['old'], label: 'History  3/3' }).reason, 'history');
    assert.equal(read({ lines: ['old'], label: 'History 3 / 3' }).reason, 'history');
    assert.equal(read({ lines: ['old'], label: 'History\u00a03/3' }).reason, 'history');
    assert.equal(read({ lines: ['old'], label: 'Histories 3/3' }).state, 'text');
  });

  test('(−) a cursor past the end of the text (invisible trailing spaces) is unreadable: trailing', () => {
    assert.deepEqual(read({ lines: ['abc'], cursor: { dx: 3 } }), unreadable('trailing'));
    assert.equal(read({ lines: ['abc'], cursor: { dx: 1 } }).reason, 'trailing'); // one column is enough
    assert.equal(read({ lines: [''], cursor: { x: 5 } }).reason, 'trailing'); // spaces typed into an empty box
    assert.equal(read({ lines: ['abc'], cursor: { dx: 0 } }).state, 'text'); // exactly at the end is fine
  });

  test('(−) a row with one leading space, or no indent, under the first row is unreadable: layout', () => {
    const s = boxRows({ lines: ['first', 'second'] });
    s.rows[2] = [span(' second')];
    assert.deepEqual(parseDraft(s.rows, s.cursor, s.cols), unreadable('layout', 'prompt', 3)); // two box rows: the bottom rule is row 3
    s.rows[2] = [span('second')];
    assert.equal(parseDraft(s.rows, s.cursor, s.cols).reason, 'layout');
  });

  test('(−) the reasons keep their order: history, layout, tall, pasted, trailing', () => {
    const many = Array.from({ length: 14 }, () => '[Pasted text #1]');
    assert.equal(read({ lines: many, label: 'History 1/2' }).reason, 'history');
    const s = boxRows({ lines: ['[Pasted text #1]', 'x'] });
    s.rows[2] = [span('x')];
    assert.equal(parseDraft(s.rows, s.cursor, s.cols).reason, 'layout');
    assert.equal(read({ lines: many }).reason, 'tall');
    assert.equal(read({ lines: ['[Pasted text #1]'], cursor: { dx: 4 } }).reason, 'pasted');
  });
});

describe('parseDraft: no plain box (null)', () => {
  test('(−) an unknown footer (a dialog, a menu) is null, even with a box-shaped middle', () => {
    assert.equal(read({ lines: ['hello'], footer: 'some footer nobody recognises' }), null);
    assert.equal(read({ lines: ['hello'], footer: '' }), null);
  });

  test('(−) a permission prompt with `❯ 1. Yes` between two rules is null; only its footer stops it from reading as a draft', () => {
    const prompt = [rule(), [span(`${PROMPT} 1. Yes`)], [span('  2. No')], rule(), [span('  Esc to cancel')]];
    assert.equal(parseDraft(prompt, { x: 9, y: 1, visible: true }, 40), null);
    // The control: the same rows with Claude's no-break space after the glyph and a known footer would read as a draft. A real
    // prompt has a plain space there (I-1), so it is null at the glyph already, and its unknown footer stops it a second time.
    const withFooter = [rule(), [span(`${PROMPT}${NB}1. Yes`)], [span('  2. No')], rule(), modeLine];
    const d = parseDraft(withFooter, { x: 7, y: 2, visible: true }, 40);
    assert.equal(d.text, '1. Yes\n2. No');
    assert.equal(parseDraft([...prompt.slice(0, 4), modeLine], { x: 7, y: 2, visible: true }, 40), null);
  });

  test('(−) I-1: a status line that starts with the glyph and a plain space, under the lower rule, is not the box (null, sync pauses)', () => {
    for (const [glyph, label] of [[PROMPT, 'main'], ['!', '3 warnings']]) {
      const s = boxRows({ lines: ['hello'] });
      const status = (sep) => {
        const rows = s.rows.slice();
        rows.splice(3, 0, [span(`${glyph}${sep}${label}`)], rule(s.cols)); // under the lower rule (row 2), above the status line and the mode line
        return rows;
      };
      assert.equal(parseDraft(status(' '), s.cursor, s.cols), null, `${glyph} ${label}`); // a plain space: a user's status line
      assert.equal(parseDraft(status(' '), null, s.cols), null);
      assert.equal(parseDraft(status(NB), s.cursor, s.cols).text, label); // the control: with a no-break space the same rows ARE a box
    }
  });

  test('(+) I-1: the real box still reads: glyph and a no-break space, text or empty, padded or not, prompt and bash', () => {
    assert.equal(read({ lines: ['hello'] }).text, 'hello');
    assert.equal(read({ lines: [''] }).state, 'empty');
    assert.equal(read({ lines: [''], mode: 'bash' }).state, 'empty');
    assert.equal(read({ lines: ['echo hi'], mode: 'bash' }).text, 'echo hi');
    const s = boxRows({ lines: [''] });
    s.rows[1] = [span(`${PROMPT}${NB}`), span(' '.repeat(s.cols - 2))]; // an empty box padded with real spaces
    assert.equal(parseDraft(s.rows, s.cursor, s.cols).state, 'empty');
    s.rows[1] = [span(`${PROMPT} `), span(' '.repeat(s.cols - 2))]; // the glyph and only spaces: the end of the row after the padding is cut
    assert.equal(parseDraft(s.rows, s.cursor, s.cols).state, 'empty');
  });

  test('(−) fewer than two rule rows, or nothing between the last two, is null', () => {
    assert.equal(parseDraft([[span('hello')], modeLine], null, 40), null);
    assert.equal(parseDraft([rule(), [span(`${PROMPT}${NB}hello`)], modeLine], null, 40), null);
    assert.equal(parseDraft([rule(), rule(), modeLine], null, 40), null);
    assert.equal(parseDraft([[span('hello')], rule(), [span('x')], modeLine], null, 40), null);
  });

  test('(−) a first row that is not a prompt row is null: a history search filter, text, a glyph glued to text, three leading spaces', () => {
    const first = (row) => {
      const s = boxRows({ lines: ['x'] });
      s.rows[1] = row;
      return parseDraft(s.rows, s.cursor, s.cols);
    };
    assert.equal(first([span('\u2315 Filter history\u2026')]), null);
    assert.equal(first([span('plain text')]), null);
    assert.equal(first([span(`${PROMPT}x`)]), null);
    assert.equal(first([span('!x')]), null);
    assert.equal(first([span(`   ${PROMPT}${NB}x`)]), null);
    assert.equal(first([]), null);
    assert.notEqual(first([span(`${PROMPT}${NB}x`)]), null);
  });

  test('(−) rows that are not an array of rows are null', () => {
    assert.equal(parseDraft(null, null, 120), null);
    assert.equal(parseDraft(undefined), null);
    assert.equal(parseDraft('rows', null, 120), null);
    assert.equal(parseDraft({}, null, 120), null);
    assert.equal(parseDraft([], null, 120), null);
  });
});

describe('RULE_ROW and HISTORY_LABEL', () => {
  const dashes = (n) => '\u2500'.repeat(n);

  test('(+) a plain rule and a rule with a session name or a history label are rule rows', () => {
    assert.ok(RULE_ROW.test(dashes(40)));
    assert.ok(RULE_ROW.test(dashes(2)));
    assert.ok(RULE_ROW.test(`${dashes(19)} acme-api ${dashes(1)}`));
    assert.ok(RULE_ROW.test(`${dashes(3)} History 3/3 ${dashes(104)}`));
    assert.ok(RULE_ROW.test(`${dashes(3)} two words here ${dashes(10)}`));
  });

  test('(−) one dash, text without a label shape, a label with a dash, controls or edge spaces are not rule rows', () => {
    assert.equal(RULE_ROW.test(dashes(1)), false);
    assert.equal(RULE_ROW.test(`${dashes(5)} no closing`), false);
    assert.equal(RULE_ROW.test(`${dashes(5)} a${dashes(1)}b ${dashes(5)}`), false);
    assert.equal(RULE_ROW.test(`${dashes(5)} a\tb ${dashes(5)}`), false);
    assert.equal(RULE_ROW.test(`${dashes(5)}  spaced ${dashes(5)}`), false);
    assert.equal(RULE_ROW.test(`${dashes(5)} ${'n'.repeat(81)} ${dashes(5)}`), false);
    assert.equal(RULE_ROW.test(''), false);
    assert.equal(RULE_ROW.test(`| ${dashes(10)}`), false);
  });

  test('(+/−) HISTORY_LABEL matches exactly `History n/m`', () => {
    assert.ok(HISTORY_LABEL.test('History 3/3'));
    assert.ok(HISTORY_LABEL.test('History 17/17'));
    for (const yes of ['History  3/3', 'History 3 / 3', 'History\u00a03/3', 'History\t3/3']) assert.ok(HISTORY_LABEL.test(yes), JSON.stringify(yes));
    for (const no of ['History', 'History 3', 'History 3/x', 'history 3/3', 'My History 3/3', 'History 3/3 x', ' History 3/3', '']) {
      assert.equal(HISTORY_LABEL.test(no), false, JSON.stringify(no));
    }
  });
});

describe('normDraft and sameDraft', () => {
  test('(+) normDraft: tab becomes 4 spaces, no-break space becomes a space, trailing spaces of every line go', () => {
    assert.equal(normDraft('col1\tcol2'), 'col1    col2');
    assert.equal(normDraft(`a${NB}b`), 'a b');
    assert.equal(normDraft('abc   '), 'abc');
    assert.equal(normDraft('one  \ntwo \n\nthree   '), 'one\ntwo\n\nthree');
    assert.equal(normDraft('  keep leading  '), '  keep leading');
    assert.equal(normDraft('x\t'), 'x');
    assert.equal(normDraft('a\n'), 'a\n'); // a trailing newline is text
    assert.equal(normDraft(''), '');
  });

  test('(−) normDraft of a non-string is an empty string', () => {
    for (const v of [undefined, null, 5, {}, ['a']]) assert.equal(normDraft(v), '');
  });

  test('(+) sameDraft ignores tab vs 4 spaces, no-break spaces and trailing spaces', () => {
    assert.ok(sameDraft('a\tb', 'a    b'));
    assert.ok(sameDraft('abc  ', 'abc'));
    assert.ok(sameDraft(`a${NB}b`, 'a b'));
    assert.ok(sameDraft('x\ny  \nz', 'x\ny\nz'));
    assert.ok(sameDraft('', '   '));
  });

  test('(−) sameDraft sees a different character, leading space, newline or inner space', () => {
    assert.equal(sameDraft('abc', 'abd'), false);
    assert.equal(sameDraft(' abc', 'abc'), false);
    assert.equal(sameDraft('a b', 'a  b'), false);
    assert.equal(sameDraft('a\nb', 'a b'), false);
    assert.equal(sameDraft('a\n', 'a'), false);
    assert.equal(sameDraft('abc', undefined), false);
    assert.equal(sameDraft(undefined, undefined), false); // a non-string is never the same as anything
    assert.equal(sameDraft('', null), false);
  });
});

describe('inEnvelope', () => {
  test('(+) 1024 characters, 12 newlines and 13 estimated rows are inside', () => {
    assert.deepEqual(inEnvelope('x'.repeat(1024), 120), { ok: true }); // 9 rows
    assert.deepEqual(inEnvelope('\n'.repeat(12), 120), { ok: true }); // 13 lines, 12 newlines
    assert.deepEqual(inEnvelope('', 120), { ok: true });
    assert.deepEqual(inEnvelope('hello', 120), { ok: true });
    assert.deepEqual(inEnvelope('x'.repeat(13 * 36), 40), { ok: true }); // 13 rows at 36 columns
  });

  test('(−) 1025 characters, 13 newlines and 14 estimated rows are outside, each with its reason', () => {
    assert.deepEqual(inEnvelope('x'.repeat(1025), 120), { ok: false, reason: 'chars' });
    assert.deepEqual(inEnvelope('\n'.repeat(13), 120), { ok: false, reason: 'newlines' });
    assert.deepEqual(inEnvelope('x'.repeat(13 * 36 + 1), 40), { ok: false, reason: 'rows' });
    const seven = Array(7).fill('y'.repeat(117)).join('\n'); // 7 lines of 2 rows each = 14 rows, 825 characters
    assert.deepEqual(inEnvelope(seven, 120), { ok: false, reason: 'rows' });
    assert.equal(inEnvelope(Array(6).fill('y'.repeat(117)).join('\n'), 120).ok, true); // 12 rows
  });

  test('(+) the row estimate counts a wide character as two cells and a tab as four', () => {
    assert.equal(inEnvelope('\u65e5'.repeat(18 * 13 + 1), 40).ok, false); // 2 cells each: 18 per 36-cell row, 14 rows
    assert.equal(inEnvelope('\u65e5'.repeat(18 * 13), 40).ok, true); // exactly 13 rows
    assert.equal(inEnvelope('\t'.repeat(9 * 13 + 1), 40).ok, false); // 4 cells per tab
    assert.equal(inEnvelope('\t'.repeat(9 * 13), 40).ok, true);
  });

  test('(−) M-2: the row estimate wraps at words, so a line that breaks into more rows than its length suggests is outside', () => {
    const line = `${'x'.repeat(60)} ${'y'.repeat(60)} ${'z'.repeat(60)}`; // 182 characters: 2 rows by length, 3 by words at 116
    assert.deepEqual(inEnvelope(Array(5).fill(line).join('\n'), 120), { ok: false, reason: 'rows' }); // 15 rows
    assert.equal(inEnvelope(Array(4).fill(line).join('\n'), 120).ok, true); // 12 rows
    assert.equal(inEnvelope(`${'a'.repeat(100)} ${'b'.repeat(100)}`, 120).ok, true);
  });

  test('(+) M-2: a long word that does not fit the rest of a row starts a new row and is cut at the width', () => {
    assert.equal(inEnvelope(`short ${'w'.repeat(36 * 12)}`, 40).ok, true); // 1 row for `short`, 12 for the word: 13
    assert.equal(inEnvelope(`short ${'w'.repeat(36 * 12 + 30)}`, 40).ok, true); // the word starts on row 1 (30 cells left), 12 more rows: 13
    assert.equal(inEnvelope(`short ${'w'.repeat(36 * 12 + 31)}`, 40).ok, false); // 14
    assert.equal(inEnvelope('a b c d e', 120).ok, true);
  });

  test('(+) F1: a word that ends in the very last column fits the row (the wrap model, not a pessimistic guess)', () => {
    const rest = Array(12).fill('c'); // 12 single-row lines
    assert.equal(inEnvelope([...rest, `${'a'.repeat(10)} ${'b'.repeat(25)}`].join('\n'), 40).ok, true); // 11 + 25 = 36 = W: 12 + 1
    assert.deepEqual(inEnvelope([...rest, `${'a'.repeat(10)} ${'b'.repeat(26)}`].join('\n'), 40), { ok: false, reason: 'rows' }); // 12 + 2
  });

  test('(+) F1: wrappedRows follows the wrap model on the cases measured live (W = 116)', () => {
    // rows a line needs, found through the 13-row limit: 13 - k single-row lines plus the line fit exactly when it needs k rows
    const rowsOf = (line, cols = 120) => {
      for (let k = 1; k <= 13; k += 1) if (inEnvelope([...Array(13 - k).fill('c'), line].join('\n'), cols).ok) return k;
      return 14;
    };
    const x = (n) => 'x'.repeat(n);
    assert.equal(rowsOf(Array(100).fill('ab').join(' ')), 3); // 116 / 114 / 68
    assert.equal(rowsOf(Array(39).fill('ab').join(' ')), 1); // 116: a full row
    assert.equal(rowsOf(`${Array(39).fill('ab').join(' ')} ab`), 2); // the next word starts a new row
    assert.equal(rowsOf(x(116)), 1);
    assert.equal(rowsOf(x(117)), 2);
    assert.equal(rowsOf(x(130)), 2); // 116 + 14
    assert.equal(rowsOf(`${x(10)} ${x(125)}`), 2); // 116 + 20
    assert.equal(rowsOf(`${x(100)} ${x(232)}`), 3); // 100 / 116 / 116: the word moves to the next row
    assert.equal(rowsOf(`${x(100)} ${x(116)}`), 2);
    assert.equal(rowsOf(`${x(114)} y`), 1); // 114 + 1 + 1 = 116 = W
    assert.equal(rowsOf(`${x(115)} y`), 2); // 117 > W
    assert.equal(rowsOf(`${x(116)} ${x(116)}`), 3); // a full row, a row of one space (the word does not fit behind it), the word
    assert.equal(rowsOf(`${x(96)} yy zz`, 100), 2); // W = 96: a full row, then ' yy zz'
  });

  test('(−) a non-string text or unusable cols is refused', () => {
    for (const bad of [undefined, null, 5, {}]) assert.deepEqual(inEnvelope(bad, 120), { ok: false, reason: 'invalid' });
    for (const cols of [undefined, null, 0, 4, -1, 1.5, '120', NaN]) assert.deepEqual(inEnvelope('hi', cols), { ok: false, reason: 'invalid' }, String(cols));
  });
});

describe('chunks', () => {
  const lines = (s) => s.split('\n').length - 1;

  test('(+) short text is one chunk; empty text is none', () => {
    assert.deepEqual(chunks('hello'), ['hello']);
    assert.deepEqual(chunks(''), []);
    assert.deepEqual(chunks('a\nb'), ['a\nb']);
    assert.deepEqual(chunks('a\n\n'), ['a\n\n']);
  });

  test('(+) a chunk is cut at 700 characters', () => {
    assert.deepEqual(chunks('x'.repeat(700)).map((c) => c.length), [700]);
    assert.deepEqual(chunks('x'.repeat(701)).map((c) => c.length), [700, 1]);
    assert.deepEqual(chunks('x'.repeat(1024)).map((c) => c.length), [700, 324]);
    assert.deepEqual(chunks('x'.repeat(1400)).map((c) => c.length), [700, 700]);
  });

  test('(+) a chunk ends right after its second newline', () => {
    assert.deepEqual(chunks('a\nb\nc\nd'), ['a\nb\n', 'c\nd']);
    assert.deepEqual(chunks('a\nb\nc\nd\ne\nf'), ['a\nb\n', 'c\nd\n', 'e\nf']);
    assert.deepEqual(chunks('a\n\n\nb'), ['a\n\n', '\nb']);
    assert.deepEqual(chunks('one\ntwo\n'), ['one\ntwo\n']);
    assert.deepEqual(chunks(`${'x'.repeat(690)}\nabc\ndef`), [`${'x'.repeat(690)}\nabc\n`, 'def']);
  });

  test('(+) the newline cut and the character cut combine', () => {
    const text = `${'x'.repeat(650)}\n${'y'.repeat(60)}\nz`;
    const out = chunks(text);
    assert.deepEqual(out.map((c) => c.length), [700, 13]);
    assert.equal(out.join(''), text);
  });

  test('(+) a surrogate pair is never split', () => {
    const emoji = '\u{1F600}';
    assert.deepEqual(chunks(`${'a'.repeat(699)}${emoji}b`), ['a'.repeat(699), `${emoji}b`]);
    const out = chunks(emoji.repeat(400)); // 800 units
    assert.ok(out.every((c) => c.length <= 700 && c.length % 2 === 0));
    assert.equal(out.join(''), emoji.repeat(400));
  });

  test('(+) M-3: a chunk never ends in a space or a tab: the cut moves before the trailing run (the chunk gets shorter)', () => {
    const b = 'b'.repeat(10);
    assert.deepEqual(chunks(`${'a'.repeat(699)} ${b}`), ['a'.repeat(699), ` ${b}`]); // the 700th character is a space
    assert.deepEqual(chunks(`${'a'.repeat(699)}\t${b}`), ['a'.repeat(699), `\t${b}`]); // ... a tab
    assert.deepEqual(chunks(`${'a'.repeat(690)}${' '.repeat(20)}${b}`), ['a'.repeat(690), `${' '.repeat(20)}${b}`]); // inside a run of spaces
    assert.deepEqual(chunks(`${'a'.repeat(600)}${' '.repeat(100)}${b}`), ['a'.repeat(600), `${' '.repeat(100)}${b}`]); // a run that ends on the 700th
    assert.deepEqual(chunks(`${'a'.repeat(695)} \t ${' '.repeat(3)}${b}`), ['a'.repeat(695), ` \t    ${b}`]); // a mixed run
    assert.deepEqual(chunks(`${'a'.repeat(698)} b${b}`), [`${'a'.repeat(698)} b`, b]); // the cut after a letter stays where it was
  });

  test('(+) M-3: only a cut is moved: the end of the text and a newline cut may follow spaces', () => {
    assert.deepEqual(chunks('abc  '), ['abc  ']);
    assert.deepEqual(chunks('abc\t'), ['abc\t']);
    assert.deepEqual(chunks('a  \nb  \nc'), ['a  \nb  \n', 'c']); // a chunk ends after its second newline, not in a space
  });

  test('(+) M-3: no chunk but the last ends in a space or a tab, and they still join back to the text (every shift of the boundary)', () => {
    const base = Array.from({ length: 900 }, (_, i) => (i % 5 === 0 ? ' ' : i % 17 === 0 ? '\t' : 'ab')).join('');
    for (let shift = 0; shift < 12; shift += 1) {
      const text = 'x'.repeat(shift) + base;
      const out = chunks(text);
      assert.ok(out.length > 1);
      assert.equal(out.join(''), text);
      out.slice(0, -1).forEach((c) => { assert.ok(!/[ \t]$/.test(c), `shift ${shift}`); assert.ok(c.length <= 700); });
    }
  });

  test('(−) M-3: a run of 699 or more spaces and tabs cannot be cut: chunks() still joins back, inEnvelope refuses it', () => {
    const text = `a${' '.repeat(698)}\t\u{1F600}`; // a run of 698 spaces and a tab (699), then a surrogate pair: the second chunk cannot be cut
    assert.equal(chunks(text).join(''), text);
    assert.deepEqual(inEnvelope(text, 120), { ok: false, reason: 'chars' });
    assert.deepEqual(inEnvelope(`a${' '.repeat(699)}b`, 120), { ok: false, reason: 'chars' });
    assert.equal(inEnvelope(`a${' '.repeat(698)}b`, 120).ok, true); // one less: 699 + b fits a chunk
    assert.ok(chunks(`a${' '.repeat(698)}b`).every((c) => !/[ \t]$/.test(c)));
  });

  test('(+) the chunks always join back to the text, within 700 characters and 2 newlines each', () => {
    const text = Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? '\n' : i % 11 === 0 ? '\u{1F600}' : 'ab')).join('');
    const out = chunks(text);
    assert.equal(out.join(''), text);
    for (const c of out) {
      assert.ok(c.length <= 700);
      assert.ok(lines(c) <= 2);
    }
  });
});

describe('source', () => {
  test('(−) src/draft.js is pure ASCII and imports no I/O', () => {
    const src = fs.readFileSync(new URL('../src/draft.js', import.meta.url), 'utf8');
    assert.match(src, /^[\x00-\x7f]*$/);
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['./mode.js', './text.js', 'node:crypto']);
  });

  test('(−) session-control.js has no RULE_ROW of its own: it imports the one from draft.js', () => {
    const src = fs.readFileSync(new URL('../src/session-control.js', import.meta.url), 'utf8');
    assert.equal(/^const RULE_ROW\b/m.test(src), false);
    assert.match(src, /import \{[^}]*\bRULE_ROW\b[^}]*\} from '\.\/draft\.js'/);
  });
});
