import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeExec } from '../src/exec.js';
import { clean, cleanBlock } from '../src/text.js';

describe('cleanBlock', () => {
  test('(+) keeps newlines and tabs, normalises CRLF and CR, trims trailing whitespace', () => {
    assert.equal(cleanBlock('a\n\tb\r\nc\rd  \n\n'), 'a\n\tb\nc\nd');
    assert.equal(cleanBlock('  indented\nstays'), '  indented\nstays');
  });

  test('(+) clean() still flattens what cleanBlock keeps', () => {
    assert.equal(clean('a\n\tb'), 'a b');
  });

  test('(+) cuts to max characters', () => {
    assert.equal(cleanBlock('abcdef', 3), 'abc');
    assert.equal(cleanBlock('ab\ncd', 4), 'ab\nc');
  });

  test('(−) every other C0, DEL, C1, zero-width and bidi code point becomes a space', () => {
    const hostile = [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x1b, 0x7f, 0x80, 0x9b, 0x9f, 0x061c, 0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069];
    for (const cp of hostile) {
      const out = cleanBlock(`a${String.fromCodePoint(cp)}b`);
      assert.equal(out, 'a b', `U+${cp.toString(16)}`);
    }
    assert.equal(cleanBlock('\u001b[31mred\u001b[0m'), 'red'); // the whole sequence goes, not just the escape byte
  });

  test('(−) non-strings and blank text give null', () => {
    for (const v of [undefined, null, 5, {}, [], '', '   ', '\n\t\n', '\u0000\u001b']) assert.equal(cleanBlock(v), null);
  });
});

describe('escape sequences in transcript text (UI-4)', () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);

  test('(+) CSI sequences (colour, style, cursor) are removed whole by clean() and cleanBlock()', () => {
    assert.equal(clean(`${ESC}[2mCompacted${ESC}[22m`), 'Compacted');
    assert.equal(cleanBlock(`${ESC}[2mCompacted${ESC}[22m\n${ESC}[1;31;40mred${ESC}[0m`), 'Compacted\nred');
    assert.equal(clean(`a${ESC}[?25lb${ESC}[2Kc${ESC}[38;5;12md`), 'abcd');
  });

  test('(+) OSC sequences (BEL or ST terminated) are removed; an OSC 8 link keeps its visible text', () => {
    assert.equal(clean(`${ESC}]8;;https://example.invalid/x${BEL}link text${ESC}]8;;${BEL}`), 'link text');
    assert.equal(clean(`${ESC}]0;window title${ESC}\\after`), 'after');
    assert.equal(cleanBlock(`${ESC}]8;;https://example.invalid/x${ESC}\\two\nlines${ESC}]8;;${ESC}\\`), 'two\nlines');
  });

  test('(+) two-character escapes are removed', () => {
    assert.equal(clean(`a${ESC}Mb${ESC}^c${ESC}\\d`), 'abcd');
  });

  test('(−) the same characters without an ESC byte are ordinary text and stay as written', () => {
    assert.equal(clean('[2mCompacted[22m'), '[2mCompacted[22m');
    assert.equal(cleanBlock('see ]8;;x and [31mred'), 'see ]8;;x and [31mred');
  });

  test('(−) a sequence cut off at the end, or a lone ESC, never leaves the escape byte behind', () => {
    for (const t of [`text${ESC}[31`, `text${ESC}]0;title`, `text${ESC}`, `${ESC}${ESC}[0mtext`]) {
      assert.doesNotMatch(clean(t) ?? '', /\u001b/, JSON.stringify(t));
      assert.doesNotMatch(cleanBlock(t) ?? '', /\u001b/, JSON.stringify(t));
    }
    assert.equal(clean(`${ESC}]0;title`), null, 'an unterminated OSC takes its payload with it');
  });

  test('(−) 100 KB of unterminated prefixes ends in the printable rest (no timing is assumed)', () => {
    const osc = `${ESC}]8;;`.repeat(20_000); // each one ends at the next ESC; the last at the BEL
    assert.equal(clean(`${osc}${BEL} tail`), 'tail');
    assert.equal(cleanBlock(`${osc}${BEL} tail`), ' tail');
    const csi = `${ESC}[`.repeat(50_000);
    assert.equal(clean(`${csi}\n tail`), 'tail');
    assert.equal(cleanBlock(`${csi}\n tail`), '\n tail');
  });
});

describe('exec opts.input', () => {
  const exec = makeExec();

  test('(+) a string is written to stdin, then stdin is closed', async () => {
    const r = await exec('cat', [], { input: 'line one\nline two\n' });
    assert.equal(r.stdout, 'line one\nline two\n');
  });

  test('(+) a Buffer works and bytes survive (UTF-8)', async () => {
    const r = await exec('cat', [], { input: Buffer.from('héllo 日本', 'utf8') });
    assert.equal(r.stdout, 'héllo 日本');
  });

  test('(+) 64 KB of input passes through whole', async () => {
    const big = 'x'.repeat(64 * 1024);
    assert.equal((await exec('cat', [], { input: big })).stdout.length, big.length);
  });

  test('(+) without input nothing changes: env and argv still work', async () => {
    assert.equal((await exec('echo', ['hi'])).stdout, 'hi\n');
    assert.equal((await exec('sh', ['-c', 'printf %s "$NIKA_T"'], { env: { NIKA_T: 'v' } })).stdout, 'v');
  });

  test('(−) a missing binary rejects with ENOENT even when input was given, no unhandled EPIPE', async () => {
    await assert.rejects(exec('nika-no-such-binary', [], { input: 'data' }), (err) => err.code === 'ENOENT');
  });

  test('(−) a child that never reads stdin does not crash us', async () => {
    const r = await exec('true', [], { input: 'y'.repeat(256 * 1024) });
    assert.equal(r.stdout, '');
  });

  test('(−) input that is neither string nor Buffer is refused before spawning', async () => {
    for (const input of [42, {}, ['a'], null]) {
      await assert.rejects(exec('cat', [], { input }), TypeError);
    }
  });

  test('(−) a failing child still rejects with stderr attached', async () => {
    await assert.rejects(exec('sh', ['-c', 'echo boom >&2; exit 3'], { input: 'x' }), (err) => err.code === 3 && /boom/.test(err.stderr));
  });
});
