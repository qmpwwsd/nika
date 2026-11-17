// src/image.js (0.5.1, C): the four image types nika shows, by magic bytes; the size estimate that needs no decoding; the one check
// of a transcript `image` block. Synthetic bytes only (a signature plus a payload with a NUL); no file is read or written.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_MAX, B64_MAX, IMAGE_MEDIA, imageTypeOf, base64Size, checkImageBlock } from '../src/image.js';
import { IMAGE_REF } from '../src/ids.js';

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const PAYLOAD = [0x00, 0x01, 0x02, 0x03];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG = bytes(PNG_SIG, PAYLOAD);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], PAYLOAD);
const GIF87 = bytes('GIF87a', PAYLOAD);
const GIF89 = bytes('GIF89a', PAYLOAD);
const WEBP = bytes('RIFF', [0x24, 0, 0, 0], 'WEBP', 'VP8 ', PAYLOAD);
const block = (media_type, data, type = 'base64') => ({ type: 'image', source: { type, media_type, data } });
const okBlock = (media, buf) => block(`image/${media}`, buf.toString('base64'));
/** Same bytes, byte `i` changed. */
const off = (buf, i) => {
  const c = Buffer.from(buf);
  c[i] ^= 0x01;
  return c;
};

describe('constants', () => {
  test('(+) the caps and the media table', () => {
    assert.equal(IMAGE_MAX, 8 * 1024 * 1024);
    assert.equal(B64_MAX, 11184812);
    assert.equal(B64_MAX, 4 * Math.ceil(IMAGE_MAX / 3));
    assert.deepEqual({ ...IMAGE_MEDIA }, { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' });
    assert.ok(Object.isFrozen(IMAGE_MEDIA));
  });

  test('(−) no SVG, no other type, nothing inherited', () => {
    for (const k of ['image/svg+xml', 'image/bmp', 'image/x-icon', 'image/avif', 'application/pdf', '__proto__', 'constructor', 'toString']) {
      assert.equal(Object.hasOwn(IMAGE_MEDIA, k), false, k);
    }
  });
});

describe('imageTypeOf', () => {
  test('(+) the four types by their magic bytes', () => {
    assert.equal(imageTypeOf(PNG), 'png');
    assert.equal(imageTypeOf(JPEG), 'jpeg');
    assert.equal(imageTypeOf(GIF87), 'gif');
    assert.equal(imageTypeOf(GIF89), 'gif');
    assert.equal(imageTypeOf(WEBP), 'webp');
  });

  test('(+) the bare signature is enough, and a Uint8Array works', () => {
    assert.equal(imageTypeOf(Buffer.from(PNG_SIG)), 'png');
    assert.equal(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff])), 'jpeg');
    assert.equal(imageTypeOf(Buffer.from('GIF89a', 'latin1')), 'gif');
    assert.equal(imageTypeOf(bytes('RIFF', [0, 0, 0, 0], 'WEBP')), 'webp');
    assert.equal(imageTypeOf(new Uint8Array(PNG)), 'png');
  });

  test('(−) a PNG signature with any one byte off is not a PNG', () => {
    for (let i = 0; i < 8; i += 1) assert.equal(imageTypeOf(off(PNG, i)), null, `byte ${i}`);
  });

  test('(−) a JPEG, GIF or WebP header with one byte off, or cut short, is nothing', () => {
    for (let i = 0; i < 3; i += 1) assert.equal(imageTypeOf(off(JPEG, i)), null, `jpeg byte ${i}`);
    assert.equal(imageTypeOf(Buffer.from([0xff, 0xd8])), null);
    for (let i = 0; i < 6; i += 1) assert.equal(imageTypeOf(off(GIF89, i)), null, `gif byte ${i}`);
    assert.equal(imageTypeOf(bytes('GIF88a', PAYLOAD)), null);
    assert.equal(imageTypeOf(bytes('GIF89', PAYLOAD)), null);
    for (const i of [0, 1, 2, 3, 8, 9, 10, 11]) assert.equal(imageTypeOf(off(WEBP, i)), null, `webp byte ${i}`);
    assert.equal(imageTypeOf(bytes('RIFF', [0x24, 0, 0, 0], 'WAVE', 'fmt ', PAYLOAD)), null);
    assert.equal(imageTypeOf(bytes('RIFF', [0, 0, 0, 0], 'WEB')), null); // 11 bytes
  });

  test('(−) other files and non-buffers', () => {
    assert.equal(imageTypeOf(bytes('%PDF-1.7', PAYLOAD)), null);
    assert.equal(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(imageTypeOf(Buffer.from('plain text')), null);
    for (const v of [Buffer.alloc(0), new Uint8Array(0), null, undefined, '', 'GIF89a', 12, {}, []]) assert.equal(imageTypeOf(v), null, String(v));
  });
});

describe('base64Size', () => {
  test('(+) decoded bytes from the length and the padding, nothing decoded', () => {
    assert.equal(base64Size(''), 0);
    assert.equal(base64Size('AAAA'), 3);
    assert.equal(base64Size('AAA='), 2);
    assert.equal(base64Size('AA=='), 1);
    for (const n of [0, 1, 2, 3, 4, 5, 100, 4097]) {
      const buf = Buffer.alloc(n, 7);
      assert.equal(base64Size(buf.toString('base64')), n, String(n));
    }
  });

  test('(+) a string the server never tests: the size follows the length even when the characters are wrong', () => {
    assert.equal(base64Size('!!!!'), 3);
    assert.equal(base64Size('AA!='), 2);
  });

  test('(−) a length that is not a multiple of 4, or not a string, gives null', () => {
    for (const s of ['A', 'AA', 'AAA', 'AAAAA', 'AAAAAA', 'AAAAAAA']) assert.equal(base64Size(s), null, s);
    for (const v of [null, undefined, 12, {}, [], Buffer.from('AAAA'), true]) assert.equal(base64Size(v), null, String(v));
  });

  test('(−) never negative or fractional', () => {
    assert.equal(base64Size('===='), 1);
    for (const s of ['====', 'A===', '=A==']) assert.ok(Number.isInteger(base64Size(s)) && base64Size(s) >= 0, s);
  });
});

describe('checkImageBlock', () => {
  test('(+) each of the four types gives its type and the decoded bytes', () => {
    for (const [media, buf] of [['png', PNG], ['jpeg', JPEG], ['gif', GIF89], ['gif', GIF87], ['webp', WEBP]]) {
      const r = checkImageBlock(okBlock(media, buf));
      assert.deepEqual(Object.keys(r), ['type', 'bytes']);
      assert.equal(r.type, media);
      assert.ok(Buffer.isBuffer(r.bytes));
      assert.ok(r.bytes.equals(buf), media);
    }
  });

  test('(+) every padding length (0, 1 and 2 "=")', () => {
    for (const extra of [0, 1, 2]) {
      const buf = bytes(PNG, Buffer.alloc(extra, 9));
      const data = buf.toString('base64');
      assert.equal(data.endsWith('='), buf.length % 3 !== 0);
      const r = checkImageBlock(block('image/png', data));
      assert.ok(r.bytes?.equals(buf), `extra ${extra}`);
    }
  });

  test('(+) the largest accepted picture: exactly IMAGE_MAX decoded bytes', () => {
    const buf = Buffer.alloc(IMAGE_MAX, 1);
    PNG_SIG.forEach((b, i) => { buf[i] = b; });
    const data = buf.toString('base64');
    assert.ok(data.length <= B64_MAX);
    const r = checkImageBlock(block('image/png', data));
    assert.equal(r.type, 'png');
    assert.equal(r.bytes?.length, IMAGE_MAX);
  });

  test('(−) one decoded byte over IMAGE_MAX is 413 too-large', () => {
    const buf = Buffer.alloc(IMAGE_MAX + 1, 1);
    PNG_SIG.forEach((b, i) => { buf[i] = b; });
    const data = buf.toString('base64');
    assert.ok(data.length <= B64_MAX, 'still within the text cap, so only the decoded check can refuse it');
    const r = checkImageBlock(block('image/png', data));
    assert.deepEqual([r.status, r.error, r.message, r.bytes?.length], [413, 'too-large', 'image too large', undefined]);
  });

  test('(−) base64 text over B64_MAX is 413 before anything else is looked at', () => {
    const over = checkImageBlock(block('image/png', 'A'.repeat(B64_MAX + 4)));
    assert.deepEqual([over.status, over.error, over.message], [413, 'too-large', 'image too large']);
    // not a multiple of 4 and with bad characters, yet over the cap: the size answer comes first
    assert.equal(checkImageBlock(block('image/png', '!'.repeat(B64_MAX + 1))).status, 413);
    // exactly B64_MAX characters of valid base64 decode to IMAGE_MAX + 1 bytes: still 413
    assert.equal(checkImageBlock(block('image/png', 'A'.repeat(B64_MAX))).status, 413);
  });

  test('(−) a source that is not base64 is 415 not-image', () => {
    const want = { status: 415, error: 'not-image', message: 'not a supported image' };
    assert.deepEqual(checkImageBlock(block('image/png', PNG.toString('base64'), 'url')), want);
    assert.deepEqual(checkImageBlock(block('image/png', PNG.toString('base64'), 'file')), want);
    assert.deepEqual(checkImageBlock(block('image/png', PNG.toString('base64'), null)), want);
    assert.deepEqual(checkImageBlock({ type: 'image', source: { media_type: 'image/png', data: PNG.toString('base64') } }), want); // no source.type at all
    for (const part of [{ type: 'image' }, { type: 'image', source: null }, { type: 'image', source: 'x' }, { type: 'image', source: [] }, null, undefined, 'x', 7]) {
      assert.deepEqual(checkImageBlock(part), want, JSON.stringify(part));
    }
  });

  test('(−) a media type outside the four is 415, whatever the bytes are', () => {
    const data = PNG.toString('base64');
    for (const m of ['image/svg+xml', 'image/bmp', 'image/avif', 'application/pdf', 'text/plain', 'image/PNG', 'IMAGE/PNG', ' image/png', 'image/png ', 'image/png; x=1', 'png', '', '__proto__', 'constructor', 'toString', undefined, null, 7, ['image/png']]) {
      assert.equal(checkImageBlock(block(m, data)).status, 415, String(m));
    }
  });

  test('(−) data that is not a string is 415', () => {
    for (const d of [undefined, null, 12, {}, ['AAAA'], PNG, true]) assert.equal(checkImageBlock(block('image/png', d)).status, 415, String(d));
  });

  test('(−) malformed base64 is 415 (length, characters, padding), with the signature itself intact', () => {
    // 48 bytes = 64 characters without padding. Every change is after the signature (the first 11 characters), so a lenient decoder would
    // still hand back a PNG: only the shape check refuses these.
    const good = bytes(PNG_SIG, Buffer.alloc(40, 5)).toString('base64');
    assert.equal(good.length, 64);
    assert.ok(checkImageBlock(block('image/png', good)).bytes, 'the unchanged string is accepted');
    const at = (c) => `${good.slice(0, 40)}${c}${good.slice(41)}`;
    const cases = {
      'one character more': `${good}A`,
      'one character less': good.slice(0, -1),
      'three more': `${good}AAA`,
      'bang': at('!'),
      'url-safe minus': at('-'),
      'url-safe underscore': at('_'),
      'space': at(' '),
      'newline': at('\n'),
      'tab': at('\t'),
      'padding in the middle': at('='),
      'three padding characters': `${good.slice(0, -3)}===`,
      'only padding': '====',
      'trailing newline kept in the length': `${good.slice(0, -1)}\n`,
    };
    for (const [name, d] of Object.entries(cases)) assert.equal(checkImageBlock(block('image/png', d)).status, 415, name);
  });

  test('(−) bytes that do not match the declared type are 415, including an empty payload', () => {
    assert.equal(checkImageBlock(okBlock('png', JPEG)).status, 415);
    assert.equal(checkImageBlock(okBlock('jpeg', PNG)).status, 415);
    assert.equal(checkImageBlock(okBlock('gif', WEBP)).status, 415);
    assert.equal(checkImageBlock(okBlock('webp', GIF89)).status, 415);
    assert.equal(checkImageBlock(okBlock('png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).status, 415);
    assert.equal(checkImageBlock(okBlock('png', off(PNG, 3))).status, 415);
    assert.equal(checkImageBlock(block('image/png', '')).status, 415);
    assert.equal(checkImageBlock(okBlock('webp', bytes('RIFF', [0x24, 0, 0, 0], 'WAVE', 'fmt ', PAYLOAD))).status, 415);
  });

  test('(−) a refusal carries the status, the code and the words only, never bytes or data', () => {
    for (const r of [
      checkImageBlock(okBlock('png', JPEG)),
      checkImageBlock(block('image/svg+xml', 'AAAA')),
      checkImageBlock(block('image/png', 'A'.repeat(B64_MAX + 4))),
    ]) {
      assert.deepEqual(Object.keys(r), ['status', 'error', 'message']);
      assert.ok(!JSON.stringify(r).includes('AAAA'));
    }
  });

  test('(+) the part is not changed', () => {
    const part = okBlock('png', PNG);
    const copy = JSON.stringify(part);
    checkImageBlock(part);
    assert.equal(JSON.stringify(part), copy);
  });
});

describe('IMAGE_REF (ids.js)', () => {
  test('(+) <offset>:<block> and <offset>:<block>.<part>, as the history entries name them', () => {
    for (const ref of ['0:0', '123456:1', '123456:4.0', '123456:4.999', '999999999999999:99999', '1:1.007']) assert.ok(IMAGE_REF.test(ref), ref);
    const m = IMAGE_REF.exec('123456:4.12');
    assert.deepEqual([m[1], m[2], m[3]], ['123456', '4', '12']);
    assert.equal(IMAGE_REF.exec('123456:4')[3], undefined);
  });

  test('(\u2212) anything else: junk around it, sizes past the digit caps, a second dot, a sign, a path', () => {
    const bad = ['', ':', '1:', ':1', 'a:1', '1:a', '1:1.', '1:1.a', '1:1.1.1', '-1:1', '+1:1', '1:-1', ' 1:1', '1:1 ', '1:1\n', '\n1:1', '1e3:1',
      '1234567890123456:1', '1:123456', '1:1.1000', '1.5:1', '1:1/2', '../1:1', '1:1;', '1:1.1,2', '0x1:1', '\uff11:1', '1%3A1', '1:1\u0000'];
    for (const ref of bad) assert.equal(IMAGE_REF.test(ref), false, JSON.stringify(ref));
  });

  test('(\u2212) every accepted offset is a safe integer', () => {
    assert.ok(Number('9'.repeat(15)) <= Number.MAX_SAFE_INTEGER);
  });
});

test('the file is ASCII', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/image.js', import.meta.url), 'utf8');
  assert.equal(/[^\x00-\x7f]/.test(src), false);
});
