// The attachment store (0.5, W2, T38): sniff, upload body check, save, lookup, remove, markSent, prune, start/stop.
// Temp dirs only, synthetic bytes only (headers are built here). Only the minus of the '(-)' test titles (U+2212, as in the other
// test files) is not ASCII.
import { test, describe, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../src/paths.js';
import { updateSettings } from '../src/store.js';
import {
  UPLOAD_CAP, MAX_BYTES, PER_MESSAGE, ID, PATH_OK, sniff, checkUploadBody, isSecretName, createAttachments,
} from '../src/attachments.js';

// A stored path must match PATH_OK (and stay under 200 characters), so the temp root has to be a short plain path; os.tmpdir() may not be.
const tmpBase = (() => {
  const t = fs.realpathSync(os.tmpdir());
  return /^\/[A-Za-z0-9._/+-]{1,80}$/.test(t) ? t : '/tmp';
})();
const root = fs.mkdtempSync(path.join(tmpBase, 'nika-att-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => mock.restoreAll());

const KEY = 'a1b2c3d4e5f6a7b8';
const KEY2 = 'b8a7f6e5d4c3b2a1';
const PANE = '%7';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;
const mode = (p) => fs.lstatSync(p).mode & 0o777;
const b64 = (buf) => Buffer.from(buf).toString('base64');
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

// Headers, each followed by a payload with a NUL, so a one-byte-off header can never pass as text.
const PAYLOAD = [0x00, 0x01, 0x02, 0x03];
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], PAYLOAD);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], PAYLOAD);
const GIF87 = bytes('GIF87a', PAYLOAD);
const GIF89 = bytes('GIF89a', PAYLOAD);
const WEBP = bytes('RIFF', [0x24, 0, 0, 0], 'WEBP', 'VP8 ', PAYLOAD);
const PDF = bytes('%PDF-1.7\n', PAYLOAD, '\n%%EOF\n');

let nth = 0;
const fresh = () => {
  const dir = path.join(root, `e${nth++}`);
  fs.mkdirSync(dir, { recursive: true });
  return { XDG_STATE_HOME: path.join(dir, 'state'), NIKA_CONFIG_DIR: path.join(dir, 'cfg') };
};
const attRoot = (env) => path.join(stateDir(env), 'attachments');
const keyDir = (env, key = KEY) => path.join(attRoot(env), key);

/** A store on a fake clock (starts at the real time, so the mtimes of files it writes agree with it) and a log capture. */
function make(env = fresh(), extra = {}) {
  const clock = { t: Date.now() };
  const logs = [];
  const keep = { days: 7 };
  const att = createAttachments({ env, now: () => clock.t, loadKeepDays: async () => keep.days, log: (l) => logs.push(l), ...extra });
  return { att, env, clock, logs, keep };
}
const upload = (att, buf, name = 'file', extra = {}) => att.save({ pane: PANE, key: KEY, name, data: b64(buf), ...extra });
async function saved(att, buf, name, extra) {
  const r = await upload(att, buf, name, extra);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

let planted = 0;
/** Puts a file into a key folder as if nika had written it `age` ms before the fake clock; `size` > 1 makes a sparse file. */
function plant(env, clock, { key = KEY, name, age = 0, size = 1 } = {}) {
  const dir = keyDir(env, key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name ?? `${(planted++).toString(16).padStart(16, '0')}.png`);
  fs.writeFileSync(file, 'x', { mode: 0o600 });
  if (size > 1) fs.truncateSync(file, size);
  const t = new Date(clock.t - age);
  fs.utimesSync(file, t, t);
  return file;
}
const leftovers = (env, key = KEY) => (fs.existsSync(keyDir(env, key)) ? fs.readdirSync(keyDir(env, key)).sort() : null);
const onlyCodes = (logs) => logs.every((l) => /^nika: attachments: [A-Z0-9_]{1,20}$/.test(l));

describe('constants', () => {
  test('(+) the values the routes and the page share', () => {
    assert.equal(UPLOAD_CAP, 12 * MIB);
    assert.equal(MAX_BYTES, 8 * MIB);
    assert.equal(PER_MESSAGE, 6);
    assert.ok(ID.test('0123456789abcdef'));
    assert.ok(PATH_OK.test('/a/b-c_d.e+f/0123456789abcdef.png'));
  });

  test('(−) ID and PATH_OK refuse what Claude cannot take as one token', () => {
    for (const id of ['0123456789abcde', '0123456789abcdef0', '0123456789ABCDEF', '0123456789abcdeg', '', '../abcdef01234']) assert.ok(!ID.test(id), id);
    for (const p of ['/a b/x.png', '/a"b', "/a'b", '/a\\b', '/a@b', '/a!b', '/a#b', '/a\nb', '/a\u0007b', 'rel/x.png', '/', `/${'a'.repeat(201)}`]) {
      assert.ok(!PATH_OK.test(p), JSON.stringify(p));
    }
    assert.ok(PATH_OK.test(`/${'a'.repeat(200)}`));
  });
});

describe('sniff', () => {
  test('(+) png, jpeg, gif87a, gif89a, webp and pdf come from the first bytes', () => {
    assert.deepEqual(sniff(PNG, 'x'), { type: 'png', ext: 'png' });
    assert.deepEqual(sniff(JPEG, 'x'), { type: 'jpeg', ext: 'jpg' });
    assert.deepEqual(sniff(GIF87, 'x'), { type: 'gif', ext: 'gif' });
    assert.deepEqual(sniff(GIF89, 'x'), { type: 'gif', ext: 'gif' });
    assert.deepEqual(sniff(WEBP, 'x'), { type: 'webp', ext: 'webp' });
    assert.deepEqual(sniff(PDF, 'x'), { type: 'pdf', ext: 'pdf' });
  });

  test('(+) the magic wins over the name: a PNG called notes.txt is a png, a PDF called a.py is a pdf', () => {
    assert.deepEqual(sniff(PNG, 'notes.txt'), { type: 'png', ext: 'png' });
    assert.deepEqual(sniff(PDF, 'a.py'), { type: 'pdf', ext: 'pdf' });
  });

  test('(+) text: tab, LF, CR, a BOM, accents, symbols and CJK are fine; ASCII that only looks like a header is text too', () => {
    for (const s of ['a\tb\nc\r\nd', '\ufeffhello', 'h\u00e9llo \u2713 \u65e5\u672c\u8a9e', 'a', 'GIF88a', '%PDF', 'RIFF']) {
      assert.deepEqual(sniff(Buffer.from(s, 'utf8'), 'n.txt'), { type: 'text', ext: 'txt' }, JSON.stringify(s));
    }
  });

  test('(−) each magic one byte off is not that type (and not text: the payload has a NUL)', () => {
    const off = (buf, i) => {
      const b = Buffer.from(buf);
      b[i] ^= 0x01;
      return b;
    };
    const magic = [[PNG, [0, 1, 2, 3, 4, 5, 6, 7]], [JPEG, [0, 1, 2]], [GIF87, [0, 1, 2, 3, 4, 5]], [GIF89, [0, 1, 2, 3, 4, 5]],
      [WEBP, [0, 1, 2, 3, 8, 9, 10, 11]], [PDF, [0, 1, 2, 3, 4]]]; // the RIFF size bytes 4 to 7 are not part of the magic
    for (const [buf, at] of magic) {
      for (const i of at) assert.deepEqual(sniff(off(buf, i), 'x.png'), { error: 'wrong-type' }, `${buf.subarray(0, 4).toString('latin1')} byte ${i}`);
    }
    assert.deepEqual(sniff(bytes('GIF88a', PAYLOAD), 'x'), { error: 'wrong-type' });
    assert.deepEqual(sniff(bytes('RIFF', [0x24, 0, 0, 0], 'WAVE', 'fmt ', PAYLOAD), 'x'), { error: 'wrong-type' });
  });

  test('(−) NUL, ESC, DEL, a C1 control (U+009B), a lone 0xC3, an overlong 0xC0 0xAF and UTF-16 text are refused', () => {
    const wrong = [
      Buffer.from('a\u0000b'), Buffer.from('\u001b[31mred'), Buffer.from('a\u007fb'), Buffer.from('a\u009bb'), Buffer.from('a\u0008b'),
      Buffer.from('a\u000bb'), Buffer.from('a\u000cb'), Buffer.from('a\u000eb'), Buffer.from('a\u001fb'),
      Buffer.from([0x61, 0xc3]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('hi', 'utf16le'), Buffer.from([0xff]),
    ];
    for (const b of wrong) assert.deepEqual(sniff(b, 'x.txt'), { error: 'wrong-type' }, b.toString('hex'));
  });

  test('(−) empty input is "empty", not a type', () => {
    for (const b of [Buffer.alloc(0), new Uint8Array(0), null, undefined]) assert.deepEqual(sniff(b, 'x'), { error: 'empty' });
  });
});

describe('extension of a text file', () => {
  const ext = (name) => sniff(Buffer.from('hello'), name);
  test('(+) a listed extension is kept, lower-cased; no extension is txt', () => {
    assert.deepEqual(ext('main.PY'), { type: 'text', ext: 'py' });
    assert.deepEqual(ext('notes'), { type: 'text', ext: 'txt' });
    assert.deepEqual(ext('a.b.md'), { type: 'text', ext: 'md' });
    assert.deepEqual(ext('.md'), { type: 'text', ext: 'md' });
    assert.deepEqual(ext('x.ts'), { type: 'text', ext: 'ts' });
    assert.deepEqual(ext('x.patch'), { type: 'text', ext: 'patch' });
  });

  test('(−) env, key, pem, p12 and anything off the list are txt; so are odd names; ../../x.sh keeps only sh', () => {
    for (const n of ['a.env', 'x.key', 'c.pem', 'd.p12', 'e.exe', 'f.tar.gz', 'g.', 'h.verylongextension', 'i.py\n', 'j.py ', '', undefined, null, 5, {}]) {
      assert.deepEqual(ext(n), { type: 'text', ext: 'txt' }, JSON.stringify(n));
    }
    assert.deepEqual(ext('../../x.sh'), { type: 'text', ext: 'sh' });
  });
});

describe('checkUploadBody', () => {
  const ok = { name: 'a.png', data: 'QUJD' };
  test('(+) exactly name and data, standard base64, with 0, 1 or 2 padding characters or none', () => {
    for (const data of ['', 'QUJD', 'QUI=', 'QQ==', 'ab+/', 'AAAAAAAA']) assert.equal(checkUploadBody({ name: '', data }), null, data);
    assert.equal(checkUploadBody({ name: 'x'.repeat(255), data: 'QUJD' }), null);
    assert.equal(checkUploadBody(ok), null);
  });

  test('(−) anything else is 400 invalid: shape, name, data alphabet, padding, length', () => {
    const bad = [
      null, undefined, 'x', 5, [], [ok], {}, { name: 'a' }, { data: 'QUJD' }, { ...ok, mime: 'image/png' }, { ...ok, extra: 1 },
      { name: 'x'.repeat(256), data: 'QUJD' }, { name: 5, data: 'QUJD' }, { name: null, data: 'QUJD' }, { name: 'a', data: 5 }, { name: 'a', data: null },
      { name: 'a', data: 'QUJ' }, { name: 'a', data: 'QUJDQ' }, { name: 'a', data: 'QU!D' }, { name: 'a', data: 'QU-_' }, { name: 'a', data: 'QU D' },
      { name: 'a', data: 'QUJD\n' }, { name: 'a', data: 'QQ=A' }, { name: 'a', data: 'Q===' }, { name: 'a', data: 'QQ==QQ==' }, { name: 'a', data: '=QQQ' },
      { name: 'a', data: 'data:image/png;base64,QUJD' },
    ];
    for (const b of bad) {
      const r = checkUploadBody(b);
      assert.equal(r?.status, 400, JSON.stringify(b));
      assert.equal(r.body.error, 'invalid');
    }
  });

  test('(−) a body that inherits name or data does not count', () => {
    const body = Object.create({ name: 'a', data: 'QUJD' });
    assert.equal(checkUploadBody(body).status, 400);
  });
});

describe('isSecretName and the credential-file refusal (rule 4, the owner\'s "don\'t collect sensitive data")', () => {
  const SECRET = ['.env', '.ENV', '.Env', '.env.dev', '.env.production.stage', '.env.', 'dir/.env', '/a/b/.env.test', 'C:\\proj\\.env', 'server.key', 'SERVER.KEY', 'id.pem', 'cert.PEM',
    '.key', '.pem', 'my.cert.pem', 'a b.key', 'x.key ', 'multi\nline.key', 'dir.key/real.pem'];
  // F3 (owner answer 2026-11-15): also .envrc, the keystores (*.p12, *.pfx, *.jks, *.keystore) and SSH private keys by exact name. Never a .pub file.
  // Fix round 1 (orchestrator ruling): .envrc.* is refused like .env.* (.envrc.dev, .envrc.bak, .envrc. ...).
  const NEW_KINDS = ['.envrc', '.envrc.dev', '.envrc.bak', '.envrc.', 'cert.p12', 'cert.pfx', 'store.jks', 'app.keystore', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk'];
  const mixed = (n) => [...n].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
  const variants = (n) => [n, n.toUpperCase(), mixed(n), `/x/y/${n.toUpperCase()}`, `/x/y/${n}`, `dir\\sub\\${n}`, `${n} `];
  const FINE = ['env.txt', 'notes.md', 'a.env', '.environment', 'keyboard.png', 'monkey.txt', 'pem.txt', 'key', 'pem', 'env', 'x.keys', 'x.pem.txt', 'x.key.txt', 'readme.md', '', 'dir.pem/readme.md', 'a.PNG',
    // F3: the public halves and the look-alikes of the new kinds stay attachable
    'id_rsa.pub', 'id_ed25519.pub', 'ID_ECDSA.PUB', 'id_ecdsa_sk.pub', 'id_rsa_backup.txt', 'id_rsa.txt', 'my_id_rsa', 'id_rsax', 'id_rsa_sk', 'id_', 'id', 'my.keystore.md', 'notes.envrc.txt', 'envrc', 'envrc.dev', 'my.envrc.dev', '.envrcx', '.envrc-old', 'p12.txt', 'p12', 'pfx', 'jks',
    'keystore', 'x.p12x', 'x.pfxs', 'cert.p12.txt', 'store.jks.bak', 'dir.p12/readme.md', '/x/y/id_rsa.pub'];

  test('(+) the names of .env, .env.*, *.key and *.pem files (any case, any directory part) are secret', () => {
    for (const name of SECRET) assert.equal(isSecretName(name), true, JSON.stringify(name));
  });

  test('(−) F3: .envrc, *.p12, *.pfx, *.jks, *.keystore and the SSH private keys are secret, in any case, with a path in front and with a trailing space', () => {
    for (const kind of NEW_KINDS) for (const name of variants(kind)) assert.equal(isSecretName(name), true, JSON.stringify(name));
  });

  test('(+) F3: a .pub file is not secret, whatever key it belongs to (public keys stay attachable)', () => {
    for (const name of ['id_rsa.pub', 'id_dsa.pub', 'id_ecdsa.pub', 'id_ed25519.pub', 'id_ecdsa_sk.pub', 'id_ed25519_sk.pub', '/x/y/ID_RSA.PUB', 'dir\\id_ed25519.pub']) {
      assert.equal(isSecretName(name), false, JSON.stringify(name));
    }
  });

  test('(−) ordinary names are not, and neither is anything that is not a string', () => {
    for (const name of FINE) assert.equal(isSecretName(name), false, JSON.stringify(name));
    for (const name of [undefined, null, 5, {}, ['.env'], true]) assert.equal(isSecretName(name), false, String(name));
  });

  test('(−) checkUploadBody: a secret name with a good body is 400 secret-file; the shape check still comes first (400 invalid)', () => {
    for (const name of SECRET.filter((n) => n.length <= 255)) {
      const r = checkUploadBody({ name, data: 'QUJD' });
      assert.equal(r?.status, 400, JSON.stringify(name));
      assert.equal(r.body.error, 'secret-file', JSON.stringify(name));
    }
    assert.equal(checkUploadBody({ name: '.env' }).body.error, 'invalid', 'no data: the shape is wrong before the name is looked at');
    assert.equal(checkUploadBody({ name: '.env', data: 'QU!D' }).body.error, 'invalid');
  });

  test('(−) F3: checkUploadBody: every new kind (any case, with a path in front) is 400 secret-file with a good body', () => {
    for (const kind of NEW_KINDS) {
      for (const name of variants(kind)) {
        const r = checkUploadBody({ name, data: 'QUJD' });
        assert.deepEqual([r?.status, r?.body.error], [400, 'secret-file'], JSON.stringify(name));
      }
    }
  });

  test('(+) checkUploadBody: every ordinary name passes', () => {
    for (const name of FINE) assert.equal(checkUploadBody({ name, data: 'QUJD' }), null, JSON.stringify(name));
  });

  test('(−) save: a secret name is refused with its content untouched: nothing is written, not even the state folder, and nothing is logged or counted', async () => {
    const { att, env, logs } = make();
    for (const name of ['.env', '.env.dev', 'prod.key', 'cert.pem']) {
      const r = await att.save({ pane: PANE, key: KEY, name, data: b64(Buffer.from('TOKEN=synthetic\n')) });
      assert.deepEqual([r.status, r.body.error], [400, 'secret-file'], name);
    }
    assert.equal(fs.existsSync(stateDir(env)), false);
    assert.deepEqual(logs, []);
    const next = await upload(att, PNG, 'a.png');
    assert.equal(next.status, 200, 'the refused uploads did not use up the rate limit or the one-at-a-time slot');
  });

  test('(−) F3: save: a new kind is refused the same way: nothing is written, nothing is logged or counted', async () => {
    const { att, env, logs } = make();
    for (const kind of NEW_KINDS) {
      for (const name of [kind, kind.toUpperCase(), `/x/y/${kind.toUpperCase()}`]) {
        const r = await att.save({ pane: PANE, key: KEY, name, data: b64(Buffer.from('synthetic\n')) });
        assert.deepEqual([r.status, r.body.error], [400, 'secret-file'], name);
      }
    }
    assert.equal(fs.existsSync(stateDir(env)), false);
    assert.deepEqual(logs, []);
    assert.equal((await upload(att, PNG, 'a.png')).status, 200, 'the refused uploads did not use up the rate limit or the one-at-a-time slot');
  });

  test('(+) save: the same bytes under an ordinary name are stored', async () => {
    const { att } = make();
    assert.equal((await att.save({ pane: PANE, key: KEY, name: 'notes.txt', data: b64(Buffer.from('TOKEN=synthetic\n')) })).status, 200);
  });

  test('(+) F3: save: a public key (id_rsa.pub) and the look-alikes are stored', async () => {
    const { att } = make();
    for (const name of ['id_rsa.pub', 'id_ed25519.pub', 'id_rsa_backup.txt', 'my.keystore.md', 'notes.envrc.txt', 'p12.txt']) {
      assert.equal((await att.save({ pane: PANE, key: KEY, name, data: b64(Buffer.from('synthetic\n')) })).status, 200, name);
    }
  });
});

describe('save', () => {
  test('(+) writes <id>.<ext> 0600 into 0700 folders, answers { id, type, size } and nothing else, and leaves no temp file', async () => {
    const { att, env, logs } = make();
    const r = await upload(att, PNG, 'Holiday Photo.png');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['id', 'size', 'type']);
    assert.match(r.body.id, ID);
    assert.equal(r.body.type, 'png');
    assert.equal(r.body.size, PNG.length);
    assert.deepEqual(leftovers(env), [`${r.body.id}.png`]);
    const file = path.join(keyDir(env), `${r.body.id}.png`);
    assert.equal(mode(file), 0o600);
    assert.equal(mode(keyDir(env)), 0o700);
    assert.equal(mode(attRoot(env)), 0o700);
    assert.deepEqual(fs.readFileSync(file), PNG);
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes('Holiday') && !wire.includes(root), 'neither the name nor a path is answered');
    assert.deepEqual(logs, []);
  });

  test('(+) each type is stored with the extension of its bytes; text takes a listed extension from the name', async () => {
    const { att, env } = make();
    const want = [[PNG, 'a', 'png', 'png'], [JPEG, 'a.png', 'jpeg', 'jpg'], [GIF89, 'a', 'gif', 'gif'], [WEBP, 'a', 'webp', 'webp'], [PDF, 'a.txt', 'pdf', 'pdf'],
      [Buffer.from('print(1)\n'), 'job.PY', 'text', 'py'], [Buffer.from('plain'), 'a.env', 'text', 'txt'], [Buffer.from('x'), '', 'text', 'txt']];
    for (const [buf, name, type, ext] of want) {
      const b = await saved(att, buf, name);
      assert.equal(b.type, type);
      assert.ok(fs.existsSync(path.join(keyDir(env), `${b.id}.${ext}`)), `${name} -> ${ext}`);
    }
  });

  test('(+) the user\'s name is never a path: ../../x.sh and a name with a NUL end up as <id>.sh / <id>.txt in the key folder, nothing outside', async () => {
    const { att, env } = make();
    const a = await saved(att, Buffer.from('echo hi\n'), '../../x.sh');
    const b = await saved(att, Buffer.from('hi\n'), 'a\u0000/b/../c.txt');
    assert.deepEqual(leftovers(env), [`${a.id}.sh`, `${b.id}.txt`].sort());
    assert.deepEqual(fs.readdirSync(attRoot(env)), [KEY]);
    assert.deepEqual(fs.readdirSync(stateDir(env)), ['attachments']);
  });

  test('(+) 8 MiB exactly is accepted', async () => {
    const { att } = make();
    const b = await saved(att, Buffer.alloc(MAX_BYTES, 0x61), 'big.txt');
    assert.equal(b.size, MAX_BYTES);
  });

  test('(−) bad body shapes are 400 and create nothing, not even the state folder', async () => {
    const { att, env } = make();
    for (const data of ['QU!D', 'QQ=A', 'QUJ', 5, null, undefined]) {
      const r = await att.save({ pane: PANE, key: KEY, name: 'a', data });
      assert.equal(r.status, 400, String(data));
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal((await att.save({ pane: PANE, key: KEY, name: 'x'.repeat(256), data: 'QUJD' })).status, 400);
    assert.equal((await att.save({ pane: PANE, key: KEY, name: 7, data: 'QUJD' })).status, 400);
    assert.equal(fs.existsSync(stateDir(env)), false);
  });

  test('(−) 8 MiB + 1 is 413 too-big, empty is 400 empty, other bytes are 415 wrong-type; nothing is written', async () => {
    const { att, env } = make();
    const big = await upload(att, Buffer.alloc(MAX_BYTES + 1, 0x61), 'big.txt');
    assert.deepEqual([big.status, big.body.error], [413, 'too-big']);
    const empty = await att.save({ pane: PANE, key: KEY, name: 'e.txt', data: '' });
    assert.deepEqual([empty.status, empty.body.error], [400, 'empty']);
    for (const buf of [bytes('MZ', PAYLOAD), Buffer.from('<svg onload=alert(1)>\u0000'), Buffer.from('a\u001bb'), bytes('GIF88a', PAYLOAD)]) {
      const r = await upload(att, buf, 'x.png');
      assert.deepEqual([r.status, r.body.error], [415, 'wrong-type']);
    }
    assert.deepEqual(leftovers(env), null, 'no key folder was even needed');
  });

  test('(−) a pane or key that is not nika\'s own shape is refused before any disk access', async () => {
    const { att, env } = make();
    for (const pane of ['7', '%', '%abc', 'pane', 5, null, ['%7']]) {
      assert.equal((await att.save({ pane, key: KEY, name: 'a', data: 'QUJD' })).status, 404, JSON.stringify(pane));
    }
    for (const key of ['../etc', 'ABCDEF0123456789', 'a1b2c3d4e5f6a7b', 'a1b2c3d4e5f6a7b8c', '', null, [KEY]]) {
      const r = await att.save({ pane: PANE, key, name: 'a', data: 'QUJD' });
      assert.deepEqual([r.status, r.body.error], [409, 'no-project'], JSON.stringify(key));
    }
    assert.equal(fs.existsSync(stateDir(env)), false);
  });

  test('(−) a key folder that is a symlink is refused (409 folder-unsafe) and nothing is written through it', async () => {
    const { att, env, logs } = make();
    const outside = path.join(root, 'outside-1');
    fs.mkdirSync(outside);
    fs.mkdirSync(attRoot(env), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, keyDir(env));
    const r = await upload(att, PNG);
    assert.deepEqual([r.status, r.body.error], [409, 'folder-unsafe']);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(logs, ['nika: attachments: ESYMLINK']);
  });

  test('(−) an attachments root that is a symlink, or group-writable, is refused', async () => {
    const a = make();
    const outside = path.join(root, 'outside-2');
    fs.mkdirSync(outside);
    fs.mkdirSync(stateDir(a.env), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, attRoot(a.env));
    assert.equal((await upload(a.att, PNG)).body.error, 'folder-unsafe');
    assert.deepEqual(fs.readdirSync(outside), []);

    const b = make();
    fs.mkdirSync(attRoot(b.env), { recursive: true, mode: 0o700 });
    fs.chmodSync(attRoot(b.env), 0o770);
    assert.deepEqual([(await upload(b.att, PNG)).status, (await upload(b.att, PNG)).body.error], [409, 'folder-unsafe']);
    fs.chmodSync(attRoot(b.env), 0o777);
    assert.equal((await upload(b.att, PNG)).body.error, 'folder-unsafe');
    assert.deepEqual(fs.readdirSync(attRoot(b.env)), []);
  });

  test('(−) a key folder that is group-writable is refused', async () => {
    const { att, env } = make();
    await saved(att, PNG);
    fs.chmodSync(keyDir(env), 0o770);
    const r = await upload(att, PNG);
    assert.deepEqual([r.status, r.body.error], [409, 'folder-unsafe']);
    assert.equal(fs.readdirSync(keyDir(env)).length, 1);
  });

  test('(−) a state path Claude cannot take as one token (a space; longer than 200) is 409 path-unusable and no file is written', async () => {
    for (const sub of ['sp ace', ['d'.repeat(70), 'e'.repeat(70), 'f'.repeat(70)], 'q\'uote']) {
      const dir = path.join(root, `p${nth++}`, ...[sub].flat());
      const { att } = make({ XDG_STATE_HOME: dir });
      const r = await upload(att, PNG);
      assert.deepEqual([r.status, r.body.error], [409, 'path-unusable'], String(sub));
      assert.deepEqual(fs.readdirSync(path.join(dir, 'nika', 'attachments', KEY)), []);
    }
  });

  test('(−) ENOSPC while writing is 507 disk-full and leaves no temp file; the next save works', async () => {
    const { att, env, logs } = make();
    const real = fsp.open;
    mock.method(fsp, 'open', async (p, ...rest) => {
      const handle = await real(p, ...rest);
      if (String(p).endsWith('.tmp')) handle.writeFile = async () => { throw Object.assign(new Error(`no space left at ${p}`), { code: 'ENOSPC' }); };
      return handle;
    });
    const r = await upload(att, PNG);
    assert.deepEqual([r.status, r.body.error], [507, 'disk-full']);
    assert.deepEqual(leftovers(env), []);
    assert.deepEqual(logs, ['nika: attachments: ENOSPC']);
    mock.restoreAll();
    assert.equal((await upload(att, PNG)).status, 200);
  });

  test('(−) EDQUOT is disk-full too; any other write error is 500 write-failed; the log carries the code only, never the path', async () => {
    const { att, env, logs } = make();
    const real = fsp.open;
    let code = 'EDQUOT';
    mock.method(fsp, 'open', async (p, ...rest) => {
      const handle = await real(p, ...rest);
      if (String(p).endsWith('.tmp')) handle.writeFile = async () => { throw Object.assign(new Error(`failed at ${p}`), { code }); };
      return handle;
    });
    assert.deepEqual([(await upload(att, PNG)).status, logs.at(-1)], [507, 'nika: attachments: EDQUOT']);
    code = 'EIO';
    const r = await upload(att, PNG);
    assert.deepEqual([r.status, r.body.error], [500, 'write-failed']);
    code = 'weird code with /a/path';
    assert.equal((await upload(att, PNG)).status, 500);
    assert.deepEqual(logs, ['nika: attachments: EDQUOT', 'nika: attachments: EIO', 'nika: attachments: ERR']);
    assert.deepEqual(leftovers(env), []);
  });

  test('(−) a second save while one is running is 429 busy; the first still succeeds', async () => {
    const { att, env } = make();
    const first = upload(att, PNG);
    const second = upload(att, JPEG);
    const r2 = await second;
    assert.deepEqual([r2.status, r2.body.error], [429, 'busy']);
    assert.equal((await first).status, 200);
    assert.equal(leftovers(env).length, 1);
    assert.equal((await upload(att, JPEG)).status, 200, 'the slot is free again');
  });

  test('(−) the 31st upload within a minute is 429; a minute after the first it works again', async () => {
    const { att, clock } = make();
    for (let i = 0; i < 30; i += 1) assert.equal((await upload(att, Buffer.from(`n${i}`))).status, 200, `upload ${i}`);
    assert.equal((await upload(att, Buffer.from('n30'))).status, 429);
    clock.t += 59_000;
    assert.equal((await upload(att, Buffer.from('n30'))).status, 429, 'still inside the minute');
    clock.t += 2_000;
    assert.equal((await upload(att, Buffer.from('n30'))).status, 200);
  });

  test('(−) uploads that fail a check still count toward the 30 a minute', async () => {
    const { att } = make();
    for (let i = 0; i < 30; i += 1) assert.equal((await upload(att, bytes('MZ', PAYLOAD))).status, 415);
    assert.equal((await upload(att, PNG)).status, 429);
  });
});

// saveBytes (W2-T6): the file chooser reads the bytes itself and hands them over; every rule of save() applies, in the same place.
describe('saveBytes', () => {
  const put = (att, buf, name = 'file', extra = {}) => att.saveBytes({ pane: PANE, key: KEY, name, bytes: buf, ...extra });

  test('(+) stores the bytes like save(): { id, type, size } only, 0600 in a 0700 folder, no name and no path in the answer, no log', async () => {
    const { att, env, logs } = make();
    const r = await put(att, PNG, 'Holiday Photo.png');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['id', 'size', 'type']);
    assert.deepEqual([r.body.type, r.body.size], ['png', PNG.length]);
    const file = path.join(keyDir(env), `${r.body.id}.png`);
    assert.deepEqual(fs.readFileSync(file), PNG);
    assert.equal(mode(file), 0o600);
    assert.equal(mode(keyDir(env)), 0o700);
    assert.deepEqual(leftovers(env), [`${r.body.id}.png`]);
    assert.ok(!JSON.stringify(r.body).includes('Holiday') && !JSON.stringify(r.body).includes(root));
    assert.deepEqual(logs, []);
  });

  test('(+) the stored file is found by lookup for its pane, so a send can use it', async () => {
    const { att } = make();
    const b = (await put(att, Buffer.from('print(1)\n'), 'job.py')).body;
    const found = await att.lookup(PANE, b.id);
    assert.deepEqual([found.id, found.type, found.size], [b.id, 'text', 9]);
    assert.match(found.path, /\.py$/, 'the text extension comes from the name, through the same list');
    assert.equal(await att.lookup('%8', b.id), null, 'another pane cannot send it');
  });

  test('(+) save() is the same code path: a byte-for-byte equal result for the same bytes', async () => {
    const { att, env } = make();
    const a = (await put(att, PDF, 'a.pdf')).body;
    const b = await saved(att, PDF, 'a.pdf');
    assert.deepEqual([a.type, a.size], [b.type, b.size]);
    assert.deepEqual(fs.readFileSync(path.join(keyDir(env), `${a.id}.pdf`)), fs.readFileSync(path.join(keyDir(env), `${b.id}.pdf`)));
  });

  test('(−) 8 MiB + 1 is 413 too-big, empty is 400 empty, other bytes are 415 wrong-type; nothing is written', async () => {
    const { att, env } = make();
    const big = await put(att, Buffer.alloc(MAX_BYTES + 1, 0x61), 'big.txt');
    assert.deepEqual([big.status, big.body.error], [413, 'too-big']);
    const empty = await put(att, Buffer.alloc(0), 'e.txt');
    assert.deepEqual([empty.status, empty.body.error], [400, 'empty']);
    const wrong = await put(att, bytes('MZ', PAYLOAD), 'x.png');
    assert.deepEqual([wrong.status, wrong.body.error], [415, 'wrong-type']);
    assert.deepEqual(leftovers(env), null);
    assert.equal((await put(att, Buffer.alloc(MAX_BYTES, 0x61), 'ok.txt')).status, 200, '8 MiB exactly is accepted');
  });

  test('(−) bytes that are not a Buffer are 400 invalid (a string, a Uint8Array, null); nothing is written', async () => {
    const { att, env } = make();
    for (const v of ['abc', new Uint8Array([1, 2, 3]), null, undefined, 5, {}]) {
      const r = await put(att, v);
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], String(v));
    }
    assert.equal(fs.existsSync(stateDir(env)), false);
  });

  test('(−) a pane or key that is not nika\'s own shape is refused before any disk access', async () => {
    const { att, env } = make();
    for (const pane of ['7', '%abc', 5, null]) assert.equal((await put(att, PNG, 'a', { pane })).status, 404, JSON.stringify(pane));
    for (const key of ['../etc', 'ABCDEF0123456789', '', null]) {
      const r = await put(att, PNG, 'a', { key });
      assert.deepEqual([r.status, r.body.error], [409, 'no-project'], JSON.stringify(key));
    }
    assert.equal(fs.existsSync(stateDir(env)), false);
  });

  test('(−) one save at a time across both doors: a save() and a saveBytes() together make one 429 busy', async () => {
    const { att, env } = make();
    const first = put(att, PNG);
    const second = upload(att, JPEG);
    assert.deepEqual([(await second).status, (await first).status], [429, 200]);
    const third = upload(att, GIF89);
    const fourth = put(att, JPEG);
    assert.deepEqual([(await fourth).body.error, (await third).status], ['busy', 200]);
    assert.equal(leftovers(env).length, 2, 'only the two that held the slot were written');
  });

  test('(−) the 30-a-minute limit counts both doors: 15 + 15 pass, the 31st is 429, and a failed check counts too', async () => {
    const { att } = make();
    for (let i = 0; i < 15; i += 1) {
      assert.equal((await upload(att, Buffer.from(`u${i}`))).status, 200);
      assert.equal((await put(att, Buffer.from(`b${i}`))).status, 200);
    }
    assert.equal((await put(att, Buffer.from('b15'))).status, 429);
    assert.equal((await upload(att, Buffer.from('u15'))).status, 429);
    const other = make();
    for (let i = 0; i < 30; i += 1) assert.equal((await put(other.att, bytes('MZ', PAYLOAD))).status, 415);
    assert.equal((await put(other.att, PNG)).status, 429);
  });

  test('(−) a full store and a failed write answer with the codes of save(); the log has the node code only', async () => {
    const { att, env, logs } = make();
    const real = fsp.open;
    mock.method(fsp, 'open', async (p, ...rest) => {
      const handle = await real(p, ...rest);
      if (String(p).endsWith('.tmp')) handle.writeFile = async () => { throw Object.assign(new Error(`no space left at ${p}`), { code: 'ENOSPC' }); };
      return handle;
    });
    const r = await put(att, PNG);
    assert.deepEqual([r.status, r.body.error], [507, 'disk-full']);
    assert.deepEqual(leftovers(env), []);
    assert.deepEqual(logs, ['nika: attachments: ENOSPC']);
  });

  test('(−) a key folder that is a symlink is refused here too (409 folder-unsafe) and nothing is written through it', async () => {
    const { att, env } = make();
    const outside = path.join(root, 'outside-bytes');
    fs.mkdirSync(outside);
    fs.mkdirSync(attRoot(env), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, keyDir(env));
    const r = await put(att, PNG);
    assert.deepEqual([r.status, r.body.error], [409, 'folder-unsafe']);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

describe('lookup, remove and markSent', () => {
  test('(+) lookup of an own, unsent id gives { id, path, type, size }; the path is the real <key folder>/<id>.<ext>', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG, 'a.png');
    const found = await att.lookup(PANE, b.id);
    assert.deepEqual(found, { id: b.id, path: path.join(fs.realpathSync(keyDir(env)), `${b.id}.png`), type: 'png', size: PNG.length });
    assert.ok(PATH_OK.test(found.path));
    assert.deepEqual(await att.lookup(PANE, b.id), found, 'looking up does not use it up');
    assert.deepEqual(fs.readFileSync(found.path), PNG, 'and does not change the file');
  });

  test('(+) remove deletes an own unsent file now; a second remove and a lookup find nothing', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    assert.equal(await att.remove(PANE, b.id), true);
    assert.deepEqual(leftovers(env), []);
    assert.equal(await att.remove(PANE, b.id), false);
    assert.equal(await att.lookup(PANE, b.id), null);
  });

  test('(+) markSent: the file stays, lookup and remove no longer see it; the other id is untouched', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG);
    const b = await saved(att, JPEG);
    att.markSent([a.id]);
    assert.equal(await att.lookup(PANE, a.id), null);
    assert.equal(await att.remove(PANE, a.id), false);
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), 'a sent file is kept');
    assert.ok(await att.lookup(PANE, b.id));
  });

  test('(−) markSent ignores unknown ids, junk and a missing list without throwing, and marks nothing else', async () => {
    const { att } = make();
    const a = await saved(att, PNG);
    att.markSent(['0000000000000000', 7, null, undefined, {}, '../x']);
    att.markSent(undefined);
    att.markSent([]);
    assert.ok(await att.lookup(PANE, a.id));
    assert.equal(await att.remove(PANE, a.id), true);
  });

  test('(−) another pane, an unknown id and a malformed id find nothing and remove nothing', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    for (const [pane, id] of [['%8', b.id], [PANE, '0000000000000000'], [PANE, ''], [PANE, undefined], [PANE, '../x'], [undefined, b.id], [PANE, ['x']]]) {
      assert.equal(await att.lookup(pane, id), null, `${pane} ${id}`);
      assert.equal(await att.remove(pane, id), false, `${pane} ${id}`);
    }
    assert.deepEqual(leftovers(env), [`${b.id}.png`]);
    assert.ok(await att.lookup(PANE, b.id));
  });

  test('(−) a store that did not issue the id knows nothing of the file on disk (ids live in memory, per process)', async () => {
    const one = make();
    const b = await saved(one.att, PNG);
    const two = make(one.env);
    assert.equal(await two.att.lookup(PANE, b.id), null);
    assert.equal(await two.att.remove(PANE, b.id), false);
    assert.equal(leftovers(one.env).length, 1);
  });

  test('(−) lookup: the file replaced by a symlink, hard-linked, changed in size, or removed behind our back is null', async () => {
    const { att, env, logs } = make();
    const outside = path.join(root, 'outside-3');
    fs.writeFileSync(outside, PNG);
    const swap = await saved(att, PNG);
    const swapFile = path.join(keyDir(env), `${swap.id}.png`);
    fs.rmSync(swapFile);
    fs.symlinkSync(outside, swapFile);
    assert.equal(await att.lookup(PANE, swap.id), null);

    const linked = await saved(att, JPEG);
    fs.linkSync(path.join(keyDir(env), `${linked.id}.jpg`), path.join(root, 'second-link'));
    assert.equal(await att.lookup(PANE, linked.id), null);

    const grown = await saved(att, GIF89);
    fs.appendFileSync(path.join(keyDir(env), `${grown.id}.gif`), 'x');
    assert.equal(await att.lookup(PANE, grown.id), null);

    const gone = await saved(att, PDF);
    fs.rmSync(path.join(keyDir(env), `${gone.id}.pdf`));
    assert.equal(await att.lookup(PANE, gone.id), null);
    assert.ok(onlyCodes(logs), logs.join('|'));
  });

  test('(−) lookup: a folder on the way turned into a symlink is null, although the file opens', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    const moved = `${keyDir(env)}-moved`;
    fs.renameSync(keyDir(env), moved);
    fs.symlinkSync(moved, keyDir(env));
    assert.equal(fs.readFileSync(path.join(keyDir(env), `${b.id}.png`)).length, PNG.length, 'the file is reachable through the link');
    assert.equal(await att.lookup(PANE, b.id), null);
    assert.equal(await att.remove(PANE, b.id), false, 'and remove follows no link either');
    assert.ok(fs.existsSync(path.join(moved, `${b.id}.png`)));
  });

  test('(−) remove of a sent id is false and the file stays', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    att.markSent([b.id]);
    assert.equal(await att.remove(PANE, b.id), false);
    assert.deepEqual(leftovers(env), [`${b.id}.png`]);
  });

  test('(−) remove of a file swapped for a symlink, or hard-linked, is false and both stay', async () => {
    const { att, env } = make();
    const outside = path.join(root, 'outside-4');
    fs.writeFileSync(outside, 'keep');
    const a = await saved(att, PNG);
    const fa = path.join(keyDir(env), `${a.id}.png`);
    fs.rmSync(fa);
    fs.symlinkSync(outside, fa);
    assert.equal(await att.remove(PANE, a.id), false);
    assert.ok(fs.lstatSync(fa).isSymbolicLink());
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');

    const b = await saved(att, JPEG);
    const fb = path.join(keyDir(env), `${b.id}.jpg`);
    fs.linkSync(fb, path.join(root, 'second-link-2'));
    assert.equal(await att.remove(PANE, b.id), false);
    assert.ok(fs.existsSync(fb));
  });

  test('(−) remove of a file whose id was already pruned or deleted by hand is false and forgets the id', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    fs.rmSync(path.join(keyDir(env), `${b.id}.png`));
    assert.equal(await att.remove(PANE, b.id), false);
    assert.equal(await att.lookup(PANE, b.id), null);
  });
});

describe('prune', () => {
  test('(+) files older than keepDays go, younger stay; an emptied key folder goes, a non-empty one stays; the result counts both', async () => {
    const { att, env, clock } = make();
    const old1 = plant(env, clock, { age: 8 * DAY, size: 10 });
    const old2 = plant(env, clock, { age: 7 * DAY + 1000, size: 10 });
    const young = plant(env, clock, { age: 6 * DAY, size: 100 });
    const other = plant(env, clock, { key: KEY2, age: 9 * DAY });
    const r = await att.prune();
    assert.deepEqual(r, { removed: 3, total: 100 });
    assert.ok(!fs.existsSync(old1) && !fs.existsSync(old2) && !fs.existsSync(other));
    assert.ok(fs.existsSync(young));
    assert.equal(fs.existsSync(keyDir(env, KEY2)), false, 'its folder was empty and is gone');
    assert.ok(fs.existsSync(keyDir(env, KEY)));
    assert.deepEqual(await att.prune(), { removed: 0, total: 100 });
  });

  test('(+) a file just under keepDays old stays; a temp file over an hour old goes, a younger one stays and is not counted', async () => {
    const { att, env, clock } = make();
    const edge = plant(env, clock, { age: 7 * DAY - 1000 });
    const tmpOld = plant(env, clock, { name: '.0123456789abcdef.png.0123456789ab.tmp', age: HOUR + 1000 });
    const tmpNew = plant(env, clock, { name: '.0123456789abcdee.png.0123456789ab.tmp', age: HOUR - 1000, size: 50 });
    assert.deepEqual(await att.prune(), { removed: 1, total: 1 });
    assert.ok(fs.existsSync(edge) && fs.existsSync(tmpNew));
    assert.ok(!fs.existsSync(tmpOld));
  });

  test('(+) a prune also drops the record: a pruned id can no longer be looked up', async () => {
    const { att, env, clock } = make();
    const b = await saved(att, PNG);
    assert.ok(await att.lookup(PANE, b.id));
    clock.t += 8 * DAY;
    const file = (await att.lookup(PANE, b.id)).path;
    assert.deepEqual(await att.prune(), { removed: 1, total: 0 });
    assert.equal(await att.lookup(PANE, b.id), null);
    assert.equal(fs.existsSync(keyDir(env)), false);
    fs.mkdirSync(keyDir(env), { mode: 0o700 });
    fs.writeFileSync(file, PNG, { mode: 0o600 }); // same path, same size: the forgotten id must not come back
    assert.equal(await att.lookup(PANE, b.id), null);
  });

  test('(+) a changed keepDays applies at the next prune', async () => {
    const { att, env, clock, keep } = make();
    const f = plant(env, clock, { age: 4 * DAY });
    keep.days = 30;
    assert.equal((await att.prune()).removed, 0);
    keep.days = 3;
    assert.equal((await att.prune()).removed, 1);
    assert.ok(!fs.existsSync(f));
  });

  test('(+) the default keepDays is attachments.keepDays of config.json, read at every prune', async () => {
    const env = fresh();
    const clock = { t: Date.now() };
    const att = createAttachments({ env, now: () => clock.t, log: () => {} });
    const f = plant(env, clock, { age: 10 * DAY });
    assert.equal((await att.prune()).removed, 1, 'default 7 days');
    const g = plant(env, clock, { age: 10 * DAY });
    await updateSettings({ attachments: { keepDays: 30 } }, env);
    assert.equal((await att.prune()).removed, 0);
    assert.ok(fs.existsSync(g) && !fs.existsSync(f));
    await updateSettings({ attachments: { keepDays: 9 } }, env);
    assert.equal((await att.prune()).removed, 1);
  });

  test('(+) over 500 files, the oldest go first, only as many as needed, and need counts for the file about to be written', async () => {
    const { att, env, clock } = make();
    const files = Array.from({ length: 500 }, (_, i) => plant(env, clock, { age: 3 * HOUR + i * 1000 })); // files[499] is the oldest
    assert.deepEqual(await att.prune(), { removed: 0, total: 500 });
    assert.deepEqual(await att.prune({ need: 5 }), { removed: 1, total: 499 });
    assert.ok(!fs.existsSync(files[499]) && fs.existsSync(files[498]));
    assert.deepEqual(await att.prune({ need: 0 }), { removed: 0, total: 499 });
    const extra = plant(env, clock, { age: 30 * 60 * 1000 });
    const extra2 = plant(env, clock, { age: 20 * 60 * 1000 });
    assert.deepEqual(await att.prune(), { removed: 1, total: 500 }, '501 files, one too many');
    assert.ok(!fs.existsSync(files[498]) && fs.existsSync(extra) && fs.existsSync(extra2));
  });

  test('(+) over 256 MiB, the oldest go first until it fits; need counts too', async () => {
    const { att, env, clock } = make();
    const a = plant(env, clock, { age: 5 * HOUR, size: 100 * MIB });
    const b = plant(env, clock, { age: 4 * HOUR, size: 100 * MIB });
    const c = plant(env, clock, { age: 3 * HOUR, size: 100 * MIB });
    assert.deepEqual(await att.prune(), { removed: 1, total: 200 * MIB });
    assert.ok(!fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(c));
    assert.deepEqual(await att.prune({ need: 56 * MIB }), { removed: 0, total: 200 * MIB }, '200 + 56 fits exactly');
    assert.deepEqual(await att.prune({ need: 56 * MIB + 1 }), { removed: 1, total: 100 * MIB });
    assert.ok(!fs.existsSync(b) && fs.existsSync(c));
  });

  test('(+) a save over the cap evicts the oldest old file and succeeds; a first upload into a new key folder keeps that folder', async () => {
    const { att, env, clock } = make();
    const a = plant(env, clock, { key: KEY2, age: 5 * HOUR, size: 150 * MIB });
    const b = plant(env, clock, { key: KEY2, age: 4 * HOUR, size: 150 * MIB });
    fs.mkdirSync(keyDir(env, 'c1c2c3c4c5c6c7c8'), { mode: 0o700 });
    const r = await upload(att, PNG);
    assert.equal(r.status, 200);
    assert.ok(!fs.existsSync(a) && fs.existsSync(b));
    assert.deepEqual(leftovers(env), [`${r.body.id}.png`]);
    assert.equal(fs.existsSync(keyDir(env, 'c1c2c3c4c5c6c7c8')), false, 'another empty folder was tidied away');
  });

  test('(−) a file younger than an hour is never evicted: over the caps a save is 507 storage-full and writes nothing', async () => {
    const { att, env, clock } = make();
    for (let i = 0; i < 500; i += 1) plant(env, clock, { age: 10 * 60 * 1000 + i });
    const r = await upload(att, PNG);
    assert.deepEqual([r.status, r.body.error], [507, 'storage-full']);
    assert.equal(leftovers(env).length, 500);
    const big = make();
    plant(big.env, big.clock, { age: 20 * 60 * 1000, size: 200 * MIB });
    plant(big.env, big.clock, { age: 30 * 60 * 1000, size: 100 * MIB });
    assert.deepEqual(await big.att.prune(), { removed: 0, total: 300 * MIB });
    assert.equal((await upload(big.att, PNG)).status, 507);
  });

  test('(−) eviction stops at the first file younger than an hour: older ones go, the young one behind them stays', async () => {
    const { att, env, clock } = make();
    const old = plant(env, clock, { age: 2 * HOUR, size: 200 * MIB });
    const mid = plant(env, clock, { age: 30 * 60 * 1000, size: 100 * MIB });
    assert.deepEqual(await att.prune(), { removed: 1, total: 100 * MIB });
    assert.ok(!fs.existsSync(old) && fs.existsSync(mid));
  });

  test('(−) symlinks, directories, hard links and foreign names inside a key folder are never followed, counted or deleted', async () => {
    const { att, env, clock } = make();
    const outside = path.join(root, 'outside-5');
    fs.writeFileSync(outside, 'keep');
    const oldTime = new Date(clock.t - 30 * DAY);
    fs.utimesSync(outside, oldTime, oldTime);
    const dir = keyDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const link = path.join(dir, '1111111111111111.png');
    fs.symlinkSync(outside, link);
    const sub = path.join(dir, '2222222222222222.pdf');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'inner.png'), 'keep');
    const foreign = [plant(env, clock, { name: 'notes.txt', age: 30 * DAY }), plant(env, clock, { name: '3333333333333333.exe', age: 30 * DAY }),
      plant(env, clock, { name: '3333333333333333.env', age: 30 * DAY }), plant(env, clock, { name: '.3333333333333333.png.tmp', age: 30 * DAY }),
      plant(env, clock, { name: '3333333333333333', age: 30 * DAY }), plant(env, clock, { name: '3333333333333333.PNG', age: 30 * DAY })];
    const linked = plant(env, clock, { name: '4444444444444444.png', age: 30 * DAY });
    fs.linkSync(linked, path.join(root, 'second-link-3'));
    assert.deepEqual(await att.prune(), { removed: 0, total: 0 });
    assert.ok(fs.lstatSync(link).isSymbolicLink() && fs.existsSync(outside));
    assert.ok(fs.existsSync(path.join(sub, 'inner.png')));
    for (const f of [...foreign, linked]) assert.ok(fs.existsSync(f), f);
    assert.ok(fs.existsSync(dir), 'a folder that still holds anything is never removed');
  });

  test('(−) in the attachments root, a symlink named like a key, a plain file and a differently named folder are never followed or deleted', async () => {
    const { att, env, clock } = make();
    const outside = path.join(root, 'outside-6');
    fs.mkdirSync(outside);
    const stray = path.join(outside, '5555555555555555.png');
    fs.writeFileSync(stray, 'keep');
    const oldTime = new Date(clock.t - 30 * DAY);
    fs.utimesSync(stray, oldTime, oldTime);
    fs.mkdirSync(attRoot(env), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, keyDir(env, KEY));
    fs.writeFileSync(keyDir(env, KEY2), 'a file named like a key');
    const named = plant(env, clock, { key: 'not-a-key', name: '6666666666666666.png', age: 30 * DAY });
    assert.deepEqual(await att.prune(), { removed: 0, total: 0 });
    assert.ok(fs.existsSync(stray) && fs.lstatSync(keyDir(env, KEY)).isSymbolicLink());
    assert.ok(fs.existsSync(named) && fs.statSync(keyDir(env, KEY2)).isFile());
  });

  test('(−) nothing to do: no attachments folder is created; an unsafe root is refused with a code in the log only', async () => {
    const a = make();
    assert.deepEqual(await a.att.prune(), { removed: 0, total: 0 });
    assert.equal(fs.existsSync(stateDir(a.env)), false);

    const b = make();
    const outside = path.join(root, 'outside-7');
    fs.mkdirSync(outside);
    const stray = path.join(outside, KEY);
    fs.mkdirSync(stray);
    const f = path.join(stray, '7777777777777777.png');
    fs.writeFileSync(f, 'keep');
    const oldTime = new Date(b.clock.t - 30 * DAY);
    fs.utimesSync(f, oldTime, oldTime);
    fs.mkdirSync(stateDir(b.env), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, attRoot(b.env));
    assert.deepEqual(await b.att.prune(), { removed: 0, total: 0 });
    assert.ok(fs.existsSync(f));
    assert.deepEqual(b.logs, ['nika: attachments: ESYMLINK']);
  });

  test('(−) an entry that cannot be removed is skipped without an exception; the log has the code only', async () => {
    const { att, env, clock, logs } = make();
    const f = plant(env, clock, { age: 30 * DAY });
    fs.chmodSync(keyDir(env), 0o770); // removeOwnFile refuses a group-writable folder
    assert.deepEqual(await att.prune(), { removed: 0, total: 1 });
    assert.ok(fs.existsSync(f));
    assert.ok(logs.length > 0 && onlyCodes(logs), logs.join('|'));
    assert.ok(logs.every((l) => !l.includes(root)));
  });

  test('(−) a loadKeepDays that fails leaves the files alone, prune still answers, and the log has the code only', async () => {
    const { env, clock, logs } = make();
    const att = createAttachments({
      env, now: () => clock.t, log: (l) => logs.push(l),
      loadKeepDays: async () => { throw Object.assign(new Error(`boom at ${root}`), { code: 'EBOOM' }); },
    });
    const f = plant(env, clock, { age: 30 * DAY });
    assert.deepEqual(await att.prune(), { removed: 0, total: 0 });
    assert.ok(fs.existsSync(f));
    assert.deepEqual(logs, ['nika: attachments: EBOOM']);
  });
});

describe('start and stop', () => {
  const fakeTimers = () => {
    const list = [];
    return {
      list,
      setTimer: (fn, ms) => {
        const h = { fn, ms, unref: 0 };
        h.unref = mock.fn(() => h);
        list.push(h);
        return h;
      },
      clearTimer: (h) => list.splice(list.indexOf(h), 1),
    };
  };

  test('(+) start prunes at once, then every 24 h on an unref\'d timer', async () => {
    const timers = fakeTimers();
    const { att, env, clock } = make(fresh(), timers);
    const first = plant(env, clock, { age: 9 * DAY });
    await att.start();
    assert.ok(!fs.existsSync(first), 'pruned before start() resolved');
    assert.equal(timers.list.length, 1);
    assert.equal(timers.list[0].ms, 24 * HOUR);
    assert.equal(timers.list[0].unref.mock.callCount(), 1);
    const second = plant(env, clock, { age: 9 * DAY });
    await timers.list[0].fn();
    assert.ok(!fs.existsSync(second), 'the timer prunes too');
    att.stop();
  });

  test('(+) the default timers work: start then stop leaves nothing running', async () => {
    const { att, env, clock } = make();
    const f = plant(env, clock, { age: 9 * DAY });
    await att.start();
    att.stop();
    assert.ok(!fs.existsSync(f));
  });

  test('(−) stop clears the timer, twice is fine, and stop before start does nothing; start twice leaves one timer', async () => {
    const timers = fakeTimers();
    const { att } = make(fresh(), timers);
    att.stop();
    assert.equal(timers.list.length, 0);
    await att.start();
    await att.start();
    assert.equal(timers.list.length, 1);
    att.stop();
    assert.equal(timers.list.length, 0);
    att.stop();
    assert.equal(timers.list.length, 0);
  });

  test('(−) a start on a machine with no attachments folder neither throws nor creates one', async () => {
    const { att, env, logs } = make(fresh(), fakeTimers());
    await att.start();
    assert.equal(fs.existsSync(stateDir(env)), false);
    assert.deepEqual(logs, []);
    att.stop();
  });
});

describe('logging (T38)', () => {
  test('(−) a refused save logs nothing about the name, the bytes, the id or the path', async () => {
    const { att, env, logs } = make();
    fs.mkdirSync(attRoot(env), { recursive: true, mode: 0o700 });
    fs.chmodSync(attRoot(env), 0o770);
    const r = await upload(att, PNG, 'secret-name.png');
    assert.equal(r.status, 409);
    const wire = JSON.stringify(r.body) + logs.join('\n');
    for (const leak of ['secret-name', root, stateDir(env), 'attachments/']) assert.ok(!wire.includes(leak), leak);
    assert.ok(onlyCodes(logs));
  });

  test('(−) the default log writes one code line to stderr and nothing else', async () => {
    const env = fresh();
    const writes = [];
    mock.method(process.stderr, 'write', (s) => { writes.push(String(s)); return true; });
    const att = createAttachments({ env });
    fs.mkdirSync(attRoot(env), { recursive: true, mode: 0o700 });
    fs.chmodSync(attRoot(env), 0o770);
    assert.equal((await upload(att, PNG)).status, 409);
    mock.restoreAll();
    assert.deepEqual(writes, ['nika: attachments: EMODE\n']);
  });
});

describe('review fixes (W2-T1, round 1)', () => {
  /** Holds the save at its realpath of the key folder: the folder exists and is empty, the write has not happened. */
  function pauseAtKeyFolder() {
    const real = fsp.realpath;
    let release;
    let reached;
    const gate = new Promise((resolve) => { release = resolve; });
    const at = new Promise((resolve) => { reached = resolve; });
    mock.method(fsp, 'realpath', async (p, ...rest) => {
      if (String(p).endsWith(`/${KEY}`)) {
        reached();
        await gate;
      }
      return real(p, ...rest);
    });
    return { at, release };
  }

  test('(+) M1: the startup prune and the timer prune leave the folder a save is writing into; it is tidied once the save is done', async () => {
    const { att, env } = make();
    const { at, release } = pauseAtKeyFolder();
    const saving = upload(att, PNG);
    try {
      await at;
      assert.deepEqual(leftovers(env), [], 'the folder is there and empty');
      await att.start(); // the startup prune
      assert.deepEqual(leftovers(env), [], 'startup prune');
      await att.prune(); // what the 24 h timer calls
      assert.deepEqual(leftovers(env), [], 'timer prune');
    } finally {
      release();
    }
    const r = await saving;
    att.stop();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(leftovers(env), [`${r.body.id}.png`]);
    assert.equal(await att.remove(PANE, r.body.id), true);
    assert.deepEqual(leftovers(env), [], 'empty again');
    await att.prune();
    assert.equal(fs.existsSync(keyDir(env)), false, 'the skip ended with the save');
  });

  test('(−) M1: a save that fails (wrong type, ENOSPC) does not leave its folder protected', async () => {
    const { att, env } = make();
    fs.mkdirSync(keyDir(env), { recursive: true, mode: 0o700 });
    assert.equal((await upload(att, bytes('MZ', PAYLOAD))).status, 415);
    const real = fsp.open;
    mock.method(fsp, 'open', async (p, ...rest) => {
      const handle = await real(p, ...rest);
      if (String(p).endsWith('.tmp')) handle.writeFile = async () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
      return handle;
    });
    assert.equal((await upload(att, PNG)).status, 507);
    mock.restoreAll();
    await att.prune();
    assert.equal(fs.existsSync(keyDir(env)), false);
  });

  test('(−) M2: when the caps cannot be checked, a save is refused 507 disk-full and writes nothing (fails closed)', async () => {
    const { env, clock, logs } = make();
    const boom = createAttachments({
      env, now: () => clock.t, log: (l) => logs.push(l),
      loadKeepDays: async () => { throw Object.assign(new Error(`boom at ${root}`), { code: 'EBOOM' }); },
    });
    const r = await upload(boom, PNG);
    assert.deepEqual([r.status, r.body.error], [507, 'disk-full']);
    assert.deepEqual(leftovers(env), [], 'nothing was written');
    assert.ok(logs.includes('nika: attachments: EBOOM') && onlyCodes(logs), logs.join('|'));
  });

  test('(−) M2: a key folder nika cannot list also refuses the save (its files would be missing from the total); listing again works', async () => {
    const { att, env, clock } = make();
    plant(env, clock, { key: KEY2, age: 2 * HOUR });
    const real = fsp.readdir;
    mock.method(fsp, 'readdir', async (p, ...rest) => {
      if (String(p).endsWith(`/${KEY2}`)) throw Object.assign(new Error(`cannot list ${p}`), { code: 'EIO' });
      return real(p, ...rest);
    });
    const r = await upload(att, PNG);
    assert.deepEqual([r.status, r.body.error], [507, 'disk-full']);
    assert.deepEqual(leftovers(env), [], 'nothing was written');
    mock.restoreAll();
    assert.equal((await upload(att, PNG)).status, 200);
  });

  test('(+) M2: the public prune keeps its shape when it fails: { removed, total } and nothing else', async () => {
    const { env, clock } = make();
    const boom = createAttachments({ env, now: () => clock.t, log: () => {}, loadKeepDays: async () => { throw new Error('x'); } });
    plant(env, clock, { age: 30 * DAY });
    assert.deepEqual(await boom.prune(), { removed: 0, total: 0 });
  });

  test('(−) M3: remove refuses a file whose attachments folder was swapped for a symlink since the save, as lookup does', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    const moved = `${attRoot(env)}-moved`;
    fs.renameSync(attRoot(env), moved);
    fs.symlinkSync(moved, attRoot(env));
    assert.equal(await att.lookup(PANE, b.id), null);
    assert.equal(await att.remove(PANE, b.id), false);
    assert.ok(fs.existsSync(path.join(moved, KEY, `${b.id}.png`)), 'the file behind the link is not touched');
  });

  test('(+) M3: remove still deletes when nothing moved', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    assert.equal(await att.remove(PANE, b.id), true);
    assert.deepEqual(leftovers(env), []);
  });

  test('(+) M4: src/attachments.js is ASCII; this file has non-ASCII only in the minus of test titles, and says so', () => {
    const asciiOnly = (text) => !/[^\x00-\x7f]/.test(text);
    assert.ok(asciiOnly(fs.readFileSync(new URL('../src/attachments.js', import.meta.url), 'utf8')));
    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const odd = [...new Set([...self].filter((c) => c.charCodeAt(0) > 127))];
    assert.deepEqual(odd, ['\u2212']);
    for (const line of self.split('\n').filter((l) => !asciiOnly(l))) assert.match(line, /^\s*(?:test|describe)\(/, line);
    assert.ok(!/Keep this file ASCII/.test(self.split('\n').slice(0, 4).join('\n')), 'the header must not claim what the titles break');
  });
});
