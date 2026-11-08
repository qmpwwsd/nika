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
    assert.equal(cleanBlock('\u001b[31mred\u001b[0m'), ' [31mred [0m'); // the escape byte is gone, the printable rest stays
  });

  test('(−) non-strings and blank text give null', () => {
    for (const v of [undefined, null, 5, {}, [], '', '   ', '\n\t\n', '\u0000\u001b']) assert.equal(cleanBlock(v), null);
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
