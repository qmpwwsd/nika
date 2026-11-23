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
  UPLOAD_CAP, MAX_BYTES, PER_MESSAGE, TRAYS_MAX, ID, PATH_OK, sniff, checkUploadBody, isSecretName, createAttachments,
  KEPT_CAP, keptTextOk, checkKeptBody,
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

// 0.5.4, AT: the tray of a pane (synthetic owner: a made-up pid and a made-up session label, never a real id)
const OWNER = { pid: 4101, session: 'sess-one' };
const bindT = (att, over = {}) => att.bindTray(PANE, { key: KEY, owner: OWNER, ...over });
const listT = (att, over = {}) => att.listTray(PANE, { key: KEY, owner: OWNER, ...over });

describe('constants', () => {
  test('(+) the values the routes and the page share', () => {
    assert.equal(UPLOAD_CAP, 12 * MIB);
    assert.equal(MAX_BYTES, 8 * MIB);
    assert.equal(PER_MESSAGE, 6);
    assert.equal(TRAYS_MAX, 64);
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

describe('sniff: the answers pinned before imageTypeOf moved into src/image.js (0.5.1, C)', () => {
  // Written against the code before the change and kept green through it: the four image signatures are now read by imageTypeOf, and
  // sniff must answer exactly as before at the edges (a bare signature, a header one byte short, ASCII that only looks like a header).
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const table = [
    ['bare PNG signature', Buffer.from(SIG), { type: 'png', ext: 'png' }],
    ['PNG signature, one byte short', Buffer.from(SIG.slice(0, 7)), { error: 'wrong-type' }],
    ['bare JPEG signature', Buffer.from([0xff, 0xd8, 0xff]), { type: 'jpeg', ext: 'jpg' }],
    ['JPEG signature, one byte short', Buffer.from([0xff, 0xd8]), { error: 'wrong-type' }],
    ['bare GIF87a', Buffer.from('GIF87a', 'latin1'), { type: 'gif', ext: 'gif' }],
    ['bare GIF89a', Buffer.from('GIF89a', 'latin1'), { type: 'gif', ext: 'gif' }],
    ['GIF89 without the a', Buffer.from('GIF89', 'latin1'), { type: 'text', ext: 'txt' }],
    ['GIF88a', Buffer.from('GIF88a', 'latin1'), { type: 'text', ext: 'txt' }],
    ['GIF90a', Buffer.from('GIF90a', 'latin1'), { type: 'text', ext: 'txt' }],
    ['exactly 12 bytes of WebP', bytes('RIFF', [0, 0, 0, 0], 'WEBP'), { type: 'webp', ext: 'webp' }],
    ['WebP with any size bytes', bytes('RIFF', [0xff, 0xff, 0xff, 0xff], 'WEBP', 'x'), { type: 'webp', ext: 'webp' }],
    ['11 bytes of WebP (ASCII)', Buffer.from('RIFFsizeWEB', 'latin1'), { type: 'text', ext: 'txt' }],
    ['RIFF WAVE (ASCII)', Buffer.from('RIFFsizeWAVEfmt ', 'latin1'), { type: 'text', ext: 'txt' }],
    ['RIFF WEBP in the wrong place (ASCII)', Buffer.from('xRIFFsizeWEBP', 'latin1'), { type: 'text', ext: 'txt' }],
    ['PNG signature after one byte', bytes([0x20], SIG), { error: 'wrong-type' }],
    ['PDF', Buffer.from('%PDF-1.4', 'latin1'), { type: 'pdf', ext: 'pdf' }],
    ['an SVG is text, never an image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { type: 'text', ext: 'txt' }],
  ];
  test('(+) and (−) each edge answers as it did before', () => {
    for (const [label, buf, want] of table) assert.deepEqual(sniff(buf, 'x'), want, label);
  });

  test('(+) the name never changes an image answer', () => {
    for (const name of ['x.txt', 'x.svg', 'x.png', '', undefined, 'x.PDF']) {
      assert.deepEqual(sniff(Buffer.from(SIG), name), { type: 'png', ext: 'png' }, String(name));
      assert.deepEqual(sniff(bytes('RIFF', [0, 0, 0, 0], 'WEBP'), name), { type: 'webp', ext: 'webp' }, String(name));
    }
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

  // Owner decision 2026-11-16 (final review R1 F4, R3 open question 1): also the credential files `.netrc`, `.git-credentials`, `.pgpass`, `.npmrc`,
  // `credentials` (exact base names) and `*.ovpn` (by extension), any case. Look-alikes stay attachable.
  const CRED_KINDS = ['.netrc', '.git-credentials', '.pgpass', '.npmrc', 'credentials', 'vpn.ovpn', '.ovpn'];
  const CRED_CASES = ['.NETRC', '.Netrc', '.GIT-CREDENTIALS', '.PgPass', '.NPMRC', 'Credentials', 'CREDENTIALS', 'VPN.OVPN', 'Work.Ovpn', '.OVPN'];
  const CRED_FINE = ['netrc', '.netrc.bak', 'credentials.txt', 'my-credentials', 'npmrc', '.pgpass2', 'git-credentials', 'credentials.json', 'credentials.md', 'mycredentials', 'netrc.txt', 'a.netrc',
    '.netrcx', 'x.npmrc', '.npmrc.bak', 'npmrc.txt', 'pgpass', '.pgpass.bak', '.git-credentials.bak', 'git-credentials.txt', 'ovpn', 'vpn.ovpn.txt', 'x.ovpnx', 'vpn.ovpn2', 'ovpn.md', 'my ovpn', 'dir.ovpn/readme.md', 'dir/credentials/readme.md'];

  test('(+) owner 2026-11-16: .netrc, .git-credentials, .pgpass, .npmrc, credentials and *.ovpn are secret, in any case, as the last part of a path (/ and \\), with a trailing space', () => {
    for (const kind of [...CRED_KINDS, ...CRED_CASES]) for (const name of variants(kind)) assert.equal(isSecretName(name), true, JSON.stringify(name));
    for (const name of ['/srv/x/.aws/credentials', '~/.aws/Credentials', 'C:\\Users\\x\\.aws\\credentials', '/srv/x/.netrc', '/srv/x/.git-credentials', '/srv/x/.pgpass', '/srv/x/.npmrc', '/srv/vpn/office.OVPN']) {
      assert.equal(isSecretName(name), true, JSON.stringify(name));
    }
  });

  test('(−) owner 2026-11-16: the near names are not secret: netrc, .netrc.bak, credentials.txt, my-credentials, npmrc, .pgpass2, git-credentials and the rest of the look-alikes', () => {
    for (const name of CRED_FINE) assert.equal(isSecretName(name), false, JSON.stringify(name));
  });

  test('(−) owner 2026-11-16: checkUploadBody: every new credential name (any case, with a path in front) is 400 secret-file with a good body; the near names pass', () => {
    for (const kind of [...CRED_KINDS, ...CRED_CASES]) {
      for (const name of variants(kind)) {
        const r = checkUploadBody({ name, data: 'QUJD' });
        assert.deepEqual([r?.status, r?.body.error], [400, 'secret-file'], JSON.stringify(name));
      }
    }
    for (const name of CRED_FINE) assert.equal(checkUploadBody({ name, data: 'QUJD' }), null, JSON.stringify(name));
  });

  test('(−) owner 2026-11-16: save: a new credential name is refused with nothing written, logged or counted; the near names are stored', async () => {
    const { att, env, logs } = make();
    for (const name of [...CRED_KINDS, ...CRED_CASES, '/srv/x/.aws/credentials']) {
      const r = await att.save({ pane: PANE, key: KEY, name, data: b64(Buffer.from('synthetic\n')) });
      assert.deepEqual([r.status, r.body.error], [400, 'secret-file'], name);
    }
    assert.equal(fs.existsSync(stateDir(env)), false);
    assert.deepEqual(logs, []);
    for (const [i, name] of ['netrc', '.netrc.bak', 'credentials.txt', 'my-credentials', 'npmrc', '.pgpass2', 'git-credentials'].entries()) {
      assert.equal((await att.save({ pane: `%${60 + i}`, key: KEY, name, data: b64(Buffer.from('synthetic\n')) })).status, 200, name); // a pane each: a tray holds six
    }
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
    for (const [i, [buf, name, type, ext]] of want.entries()) {
      const b = await saved(att, buf, name, { pane: `%${50 + i}` }); // a pane each: a tray holds six
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
    const on = (i) => ({ pane: `%${100 + i}` }); // a pane each: a tray holds six
    for (let i = 0; i < 30; i += 1) assert.equal((await upload(att, Buffer.from(`n${i}`), 'file', on(i))).status, 200, `upload ${i}`);
    assert.equal((await upload(att, Buffer.from('n30'), 'file', on(30))).status, 429);
    clock.t += 59_000;
    assert.equal((await upload(att, Buffer.from('n30'), 'file', on(30))).status, 429, 'still inside the minute');
    clock.t += 2_000;
    assert.equal((await upload(att, Buffer.from('n30'), 'file', on(30))).status, 200);
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
    for (let i = 0; i < 15; i += 1) { // a pane for each save: a tray holds six
      assert.equal((await upload(att, Buffer.from(`u${i}`), 'file', { pane: `%${100 + i}` })).status, 200);
      assert.equal((await put(att, Buffer.from(`b${i}`), 'file', { pane: `%${200 + i}` })).status, 200);
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

describe('readImage (0.5.1, C: the one read-back, T61)', () => {
  test('(+) an own, unsent image of the pane comes back as { type, data } with the base64 of the stored bytes, all four types', async () => {
    const { att, logs } = make();
    for (const [buf, type] of [[PNG, 'png'], [JPEG, 'jpeg'], [GIF89, 'gif'], [GIF87, 'gif'], [WEBP, 'webp']]) {
      const b = await saved(att, buf, `x.${type}`);
      const r = await att.readImage(PANE, b.id);
      assert.deepEqual(Object.keys(r), ['type', 'data']);
      assert.deepEqual(r, { type, data: buf.toString('base64') }, type);
    }
    assert.deepEqual(logs, []);
  });

  test('(+) reading it back changes nothing: lookup still finds it, the file is the same, and it can be read again or sent', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    const first = await att.readImage(PANE, b.id);
    assert.deepEqual(await att.readImage(PANE, b.id), first);
    assert.ok(await att.lookup(PANE, b.id));
    assert.deepEqual(fs.readFileSync(path.join(keyDir(env), `${b.id}.png`)), PNG);
    att.markSent([b.id]);
    assert.equal(await att.readImage(PANE, b.id), null, 'and once sent it is gone for good');
  });

  test('(+) the largest upload (8 MiB) is read back whole', async () => {
    const { att } = make();
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES - PNG.length, 5)]);
    const b = await saved(att, big);
    const r = await att.readImage(PANE, b.id);
    assert.equal(r.type, 'png');
    assert.equal(Buffer.from(r.data, 'base64').length, MAX_BYTES);
  });

  test('(−) a PDF, a text file, an unknown id, a malformed id, another pane and a removed file give null, and log nothing', async () => {
    const { att, logs } = make();
    const pdf = await saved(att, PDF, 'a.pdf');
    const txt = await saved(att, Buffer.from('hello'), 'a.txt');
    const png = await saved(att, PNG);
    const gone = await saved(att, JPEG);
    assert.equal(await att.remove(PANE, gone.id), true);
    for (const [pane, id] of [[PANE, pdf.id], [PANE, txt.id], [PANE, '0000000000000000'], [PANE, ''], [PANE, undefined], [PANE, '../x'], [PANE, ['x']], [PANE, '__proto__'],
      [PANE, 'constructor'], ['%8', png.id], [undefined, png.id], [PANE, gone.id]]) {
      assert.equal(await att.readImage(pane, id), null, `${pane} ${id}`);
    }
    assert.deepEqual(logs, []);
    assert.ok(await att.readImage(PANE, png.id));
  });

  test('(−) a store that did not issue the id knows nothing of the file on disk', async () => {
    const one = make();
    const b = await saved(one.att, PNG);
    assert.equal(await make(one.env).att.readImage(PANE, b.id), null);
    assert.ok(await one.att.readImage(PANE, b.id));
  });

  test('(−) the file replaced by a symlink, hard-linked, grown, shrunk or removed behind our back is null, and only codes are logged', async () => {
    const { att, env, logs } = make();
    const outside = path.join(root, 'outside-img-1');
    fs.writeFileSync(outside, PNG);
    const swap = await saved(att, PNG);
    const swapFile = path.join(keyDir(env), `${swap.id}.png`);
    fs.rmSync(swapFile);
    fs.symlinkSync(outside, swapFile);
    assert.equal(await att.readImage(PANE, swap.id), null);

    const linked = await saved(att, JPEG);
    fs.linkSync(path.join(keyDir(env), `${linked.id}.jpg`), path.join(root, 'second-link-img'));
    assert.equal(await att.readImage(PANE, linked.id), null);

    const grown = await saved(att, GIF89);
    fs.appendFileSync(path.join(keyDir(env), `${grown.id}.gif`), 'x');
    assert.equal(await att.readImage(PANE, grown.id), null);

    const shrunk = await saved(att, WEBP);
    fs.truncateSync(path.join(keyDir(env), `${shrunk.id}.webp`), WEBP.length - 1);
    assert.equal(await att.readImage(PANE, shrunk.id), null);

    const gone = await saved(att, PNG);
    fs.rmSync(path.join(keyDir(env), `${gone.id}.png`));
    assert.equal(await att.readImage(PANE, gone.id), null);
    assert.ok(logs.length > 0 && onlyCodes(logs), logs.join('|'));
    assert.ok(logs.every((l) => !l.includes(root) && !l.includes(swap.id)), 'no path and no id in the log');
  });

  test('(−) the same size but other bytes (the magic no longer matches the record) is null', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    const other = Buffer.concat([JPEG, Buffer.alloc(PNG.length - JPEG.length, 0)]);
    assert.equal(other.length, PNG.length);
    fs.writeFileSync(path.join(keyDir(env), `${b.id}.png`), other);
    assert.equal(await att.readImage(PANE, b.id), null);
    const c = await saved(att, WEBP);
    const hdr = Buffer.from(WEBP);
    hdr[8] ^= 1; // WEBP -> VEBP
    fs.writeFileSync(path.join(keyDir(env), `${c.id}.webp`), hdr);
    assert.equal(await att.readImage(PANE, c.id), null);
  });

  test('(−) a folder on the way turned into a symlink is null, although the file opens', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    const moved = `${keyDir(env)}-moved`;
    fs.renameSync(keyDir(env), moved);
    fs.symlinkSync(moved, keyDir(env));
    assert.equal(fs.readFileSync(path.join(keyDir(env), `${b.id}.png`)).length, PNG.length, 'the file is reachable through the link');
    assert.equal(await att.readImage(PANE, b.id), null);
  });

  test('(−) a file that grew past its record and past 8 MiB is null', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    const file = path.join(keyDir(env), `${b.id}.png`);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES - PNG.length + 1, 5)]);
    fs.writeFileSync(file, big);
    assert.equal(await att.readImage(PANE, b.id), null);
  });

  test('(+) at most two read-backs run at once, all of them complete, and every handle is closed', async () => {
    const { att } = make();
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push((await saved(att, PNG)).id);
    const realOpen = fsp.open;
    const stat = { open: 0, peak: 0, opened: 0 };
    fsp.open = async (file, ...rest) => {
      const h = await realOpen.call(fsp, file, ...rest);
      if (!/\.png$/.test(String(file))) return h;
      stat.opened += 1;
      stat.open += 1;
      stat.peak = Math.max(stat.peak, stat.open);
      const realRead = h.read.bind(h);
      const realClose = h.close.bind(h);
      h.read = async (...a) => {
        await new Promise((r) => setTimeout(r, 15));
        return realRead(...a);
      };
      h.close = async () => {
        stat.open -= 1;
        return realClose();
      };
      return h;
    };
    let rs;
    try {
      rs = await Promise.all(ids.map((id) => att.readImage(PANE, id)));
    } finally {
      fsp.open = realOpen;
    }
    assert.ok(rs.every((r) => r?.type === 'png'));
    assert.equal(stat.opened, 6);
    assert.equal(stat.peak, 2);
    assert.equal(stat.open, 0);
  });

  test('(−) a PDF or a text attachment is not even opened', async () => {
    const { att } = make();
    const pdf = await saved(att, PDF, 'a.pdf');
    const txt = await saved(att, Buffer.from('hello'), 'a.txt');
    const realOpen = fsp.open;
    let opened = 0;
    fsp.open = async (file, ...rest) => {
      if (/\.(pdf|txt)$/.test(String(file))) opened += 1;
      return realOpen.call(fsp, file, ...rest);
    };
    try {
      assert.equal(await att.readImage(PANE, pdf.id), null);
      assert.equal(await att.readImage(PANE, txt.id), null);
    } finally {
      fsp.open = realOpen;
    }
    assert.equal(opened, 0);
  });

  test('(−) a file that shrinks while it is read is null, not a zero-padded picture', async () => {
    const { att, env } = make();
    const b = await saved(att, PNG);
    const file = path.join(keyDir(env), `${b.id}.png`);
    const realOpen = fsp.open;
    fsp.open = async (f, ...rest) => {
      const h = await realOpen.call(fsp, f, ...rest);
      if (!/\.png$/.test(String(f))) return h;
      const realRead = h.read.bind(h);
      h.read = async (...a) => {
        fs.truncateSync(file, PNG.length - 1); // the header stays; the tail is gone
        return realRead(...a);
      };
      return h;
    };
    try {
      assert.equal(await att.readImage(PANE, b.id), null);
    } finally {
      fsp.open = realOpen;
    }
  });

  test('(+) a miss does not wait for a slot: with both slots busy, an unknown id answers at once', async () => {
    const { att } = make();
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await saved(att, PNG)).id);
    const realOpen = fsp.open;
    let release;
    const gate = new Promise((r) => { release = r; });
    fsp.open = async (file, ...rest) => {
      const h = await realOpen.call(fsp, file, ...rest);
      if (!/\.png$/.test(String(file))) return h;
      const realRead = h.read.bind(h);
      h.read = async (...a) => {
        await gate;
        return realRead(...a);
      };
      return h;
    };
    try {
      const busy = ids.slice(0, 2).map((id) => att.readImage(PANE, id));
      await new Promise((r) => setTimeout(r, 20));
      const quick = await Promise.race([att.readImage(PANE, '0000000000000000'), new Promise((r) => setTimeout(() => r('waited'), 100))]);
      assert.equal(quick, null);
      assert.equal(await Promise.race([att.readImage('%8', ids[0]), new Promise((r) => setTimeout(() => r('waited'), 100))]), null);
      release();
      await Promise.all(busy);
    } finally {
      release();
      fsp.open = realOpen;
    }
  });

  test('(−) an id sent while its read waits for a slot is not read', async () => {
    const { att } = make();
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await saved(att, PNG)).id);
    const realOpen = fsp.open;
    let release;
    const gate = new Promise((r) => { release = r; });
    let opened = 0;
    fsp.open = async (file, ...rest) => {
      const h = await realOpen.call(fsp, file, ...rest);
      if (!/\.png$/.test(String(file))) return h;
      opened += 1;
      const realRead = h.read.bind(h);
      h.read = async (...a) => {
        await gate;
        return realRead(...a);
      };
      return h;
    };
    let rs;
    try {
      const pending = ids.map((id) => att.readImage(PANE, id)); // two take the slots, the third waits
      await new Promise((r) => setTimeout(r, 20));
      att.markSent([ids[2]]);
      release();
      rs = await Promise.all(pending);
    } finally {
      fsp.open = realOpen;
    }
    assert.equal(rs[0]?.type, 'png');
    assert.equal(rs[1]?.type, 'png');
    assert.equal(rs[2], null);
    assert.equal(opened, 2, 'the third file was never opened');
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

  test('(+) S13 (0.5.4, AT): listTray, bindTray and dropPanes log a code only: no name, id or path, whatever failed', async () => {
    const { att, env, logs } = make();
    const a = await saved(att, PNG, 'secret-name.png');
    const b = await saved(att, JPEG, 'secret-two.jpg');
    const c = await saved(att, GIF89, 'secret-three.gif');
    const swapped = path.join(keyDir(env), `${a.id}.png`);
    fs.rmSync(swapped);
    fs.symlinkSync(path.join(root, 'outside-s13'), swapped); // listTray: a code
    fs.linkSync(path.join(keyDir(env), `${b.id}.jpg`), path.join(root, 'second-link-s13')); // listTray and dropPanes: a code
    await listT(att); // a: ELOOP, b: ENLINK
    await bindT(att, { owner: { pid: 1, session: 'sess-other' } }); // another Claude: the tray is dropped
    const d = await saved(att, PDF, 'secret-four.pdf');
    fs.linkSync(path.join(keyDir(env), `${d.id}.pdf`), path.join(root, 'second-link-s13b'));
    await att.dropPanes(() => true); // d: ENLINK, the removal is refused
    assert.ok(logs.length >= 3, `the scenario must log, or it proves nothing: ${logs.join('|')}`);
    assert.ok(onlyCodes(logs), logs.join('|'));
    const wire = logs.join('\n');
    for (const leak of ['secret-', a.id, b.id, c.id, d.id, root, stateDir(env), 'attachments/']) assert.ok(!wire.includes(leak), leak);
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

  // R3 F4 (ruling: code fix, no rule change): the empty <key> folders go through src/fwrite.js (removeOwnDir), like every other removal.
  test('(+) R3 F4: an emptied key folder is removed through removeOwnDir, and src/attachments.js calls no fs.rmdir itself', () => {
    const src = fs.readFileSync(new URL('../src/attachments.js', import.meta.url), 'utf8');
    assert.match(src, /import \{[^}]*\bremoveOwnDir\b[^}]*\} from '\.\/fwrite\.js'/);
    assert.match(src, /removeOwnDir\(dir\)/);
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, ''), /\brmdir\b/, 'no direct rmdir: the folder goes through fwrite');
  });

  test('(−) R3 F4: a key folder swapped for a symlink to an EMPTY folder after it was listed is refused: the link stays, its target stays, the log has the code only', async () => {
    const { att, env, logs } = make();
    fs.mkdirSync(keyDir(env), { recursive: true, mode: 0o700 }); // an empty key folder
    const victim = path.join(root, 'victim-r3f4');
    fs.mkdirSync(victim);
    const real = fsp.readdir;
    mock.method(fsp, 'readdir', async (p, ...rest) => {
      const names = await real(p, ...rest);
      if (String(p) === keyDir(env)) { // the listing of the key folder is done; the swap lands before the folders are tidied
        fs.rmdirSync(keyDir(env));
        fs.symlinkSync(victim, keyDir(env));
      }
      return names;
    });
    assert.deepEqual(await att.prune(), { removed: 0, total: 0 });
    mock.restoreAll();
    assert.equal(fs.lstatSync(keyDir(env)).isSymbolicLink(), true, 'the link was not removed');
    assert.equal(fs.existsSync(victim), true, 'the folder behind the link was not removed');
    assert.deepEqual(logs, ['nika: attachments: ESYMLINK']);
  });

  test('(+) R3 F4: an empty key folder and a stale one are tidied away by a save into another key; a folder that holds a young file stays', async () => {
    const { att, env, clock } = make();
    fs.mkdirSync(keyDir(env, KEY2), { recursive: true, mode: 0o700 });
    const young = plant(env, clock, { key: 'c1c2c3c4c5c6c7c8', age: HOUR });
    assert.equal((await upload(att, PNG)).status, 200);
    assert.equal(fs.existsSync(keyDir(env, KEY2)), false, 'the empty folder is gone');
    assert.ok(fs.existsSync(young), 'a folder with a young file stays');
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

describe('tray (0.5.4, AT): the unsent files of a pane, kept in memory for the return', () => {
  const ids = (l) => l.files.map((f) => f.id);
  const SPARE = '0123456789abcdef'; // a well-formed id nika never issued
  /** Makes a stored file 8 days old (keepDays is 7), so the next prune takes it and its record. */
  const age = (env, id, ext) => {
    const t = new Date(Date.now() - 8 * DAY);
    fs.utimesSync(path.join(keyDir(env), `${id}.${ext}`), t, t);
  };
  /** One old file (gone after a prune) and one live file on the pane, listed once so the old one is marked gone. */
  async function withGone() {
    const m = make();
    const old = await saved(m.att, PNG, 'old.png');
    age(m.env, old.id, 'png');
    await m.att.prune(); // the old file and its record go
    const live = await saved(m.att, JPEG, 'live.jpg');
    const first = await listT(m.att);
    assert.deepEqual(first, { files: [{ id: live.id, name: 'live.jpg', type: 'jpeg', size: JPEG.length }], gone: ['old.png'] });
    return { ...m, old, live };
  }

  test('(+) S1: save twice, then listTray gives both files in the order stored, as exactly { id, name, type, size }', async () => {
    const { att } = make();
    const a = await saved(att, PNG, 'a.png');
    const b = await saved(att, JPEG, 'b.jpg');
    assert.deepEqual(await listT(att), {
      files: [
        { id: a.id, name: 'a.png', type: 'png', size: PNG.length },
        { id: b.id, name: 'b.jpg', type: 'jpeg', size: JPEG.length },
      ],
      gone: [],
    });
  });

  test('(−) S1: another pane\'s listTray is empty and makes no tray; a malformed pane or key lists nothing', async () => {
    const { att } = make();
    await saved(att, PNG, 'a.png');
    assert.deepEqual(await att.listTray('%8', { key: KEY, owner: OWNER }), { files: [], gone: [] });
    assert.equal(att.hasTray('%8'), false);
    assert.equal(att.hasTray(PANE), true);
    for (const [pane, claim] of [['nope', { key: KEY, owner: OWNER }], [PANE, { key: 'nope', owner: OWNER }], [PANE, null], [undefined, undefined]]) {
      assert.deepEqual(await att.listTray(pane, claim), { files: [], gone: [] });
    }
    assert.equal(att.hasTray(PANE), true, 'junk arguments drop nothing');
  });

  test('(+) S2: saveBytes (the file chooser door) lands in the same tray as save', async () => {
    const { att } = make();
    const a = await saved(att, PNG, 'a.png');
    const r = await att.saveBytes({ pane: PANE, key: KEY, name: 'c.pdf', bytes: PDF });
    assert.equal(r.status, 200);
    const l = await listT(att);
    assert.deepEqual(l.files.map((f) => [f.id, f.name, f.type, f.size]), [[a.id, 'a.png', 'png', PNG.length], [r.body.id, 'c.pdf', 'pdf', PDF.length]]);
  });

  test('(+) S3: the label is the last path part through clean(): a.png stays, ../x/y.png and x\\y.png give y.png, controls become spaces, empty gives file', async () => {
    const cases = [
      ['a.png', 'a.png'], ['../x/y.png', 'y.png'], ['x\\y.png', 'y.png'], ['..\\..\\z.png', 'z.png'], ['a\u0007b.png', 'a b.png'],
      ['x\u202ey.png', 'x y.png'], ['dir/', 'file'], ['   ', 'file'], ['', 'file'], ['  spaced   out.png ', 'spaced out.png'],
    ];
    const { att } = make();
    for (const [i, [name, label]] of cases.entries()) {
      const pane = `%${40 + i}`;
      await saved(att, PNG, name, { pane });
      assert.deepEqual((await att.listTray(pane, { key: KEY, owner: null })).files.map((f) => f.name), [label], JSON.stringify(name));
    }
  });

  test('(−) S3: the name never reaches the disk: no file name under the state dir and no file\'s bytes contain it', async () => {
    const { att, env } = make();
    await saved(att, PNG, 'secret-name.png');
    await saved(att, PDF, '../deep/secret-two.pdf');
    await listT(att);
    const all = fs.readdirSync(stateDir(env), { recursive: true });
    assert.ok(all.length > 0);
    for (const rel of all) {
      assert.ok(!/secret-(?:name|two)/.test(rel), rel);
      const full = path.join(stateDir(env), rel);
      if (fs.statSync(full).isFile()) assert.ok(!/secret-(?:name|two)/.test(fs.readFileSync(full, 'latin1')), rel);
    }
  });

  test('(+) S4: a file past keepDays is listed as gone, a retry lists it again, and the next save clears the note', async () => {
    const { att, old, live, logs } = await withGone();
    assert.deepEqual((await listT(att)).gone, ['old.png'], 'a retry after an abort, or a second page, sees it again');
    assert.deepEqual(logs, [], 'an expired file is normal: nothing is logged, at the first list or at the retry');
    const next = await saved(att, GIF89, 'next.gif');
    assert.deepEqual(await listT(att), {
      files: [
        { id: live.id, name: 'live.jpg', type: 'jpeg', size: JPEG.length },
        { id: next.id, name: 'next.gif', type: 'gif', size: GIF89.length },
      ],
      gone: [],
    });
    assert.ok(old.id);
  });

  test('(+) S4: remove (any id) and markSent clear the note too', async () => {
    const viaRemove = await withGone();
    assert.equal(await viaRemove.att.remove(PANE, SPARE), false);
    assert.deepEqual(await listT(viaRemove.att), { files: [{ id: viaRemove.live.id, name: 'live.jpg', type: 'jpeg', size: JPEG.length }], gone: [] });
    const viaSent = await withGone();
    viaSent.att.markSent([viaSent.live.id]);
    assert.deepEqual(await listT(viaSent.att), { files: [], gone: [] });
  });

  test('(+) S4: gone items never count toward the six: one gone and five live items still take a sixth live save', async () => {
    const { att, env } = make();
    const old = await saved(att, PNG, 'old.png');
    age(env, old.id, 'png');
    await att.prune();
    for (let i = 0; i < 5; i++) await saved(att, PNG, `n${i}.png`);
    assert.deepEqual((await listT(att)).gone, ['old.png']);
    const six = await upload(att, JPEG, 'six.jpg');
    assert.equal(six.status, 200, JSON.stringify(six.body));
    const l = await listT(att);
    assert.deepEqual(l.files.map((f) => f.name), ['n0.png', 'n1.png', 'n2.png', 'n3.png', 'n4.png', 'six.jpg']);
    assert.deepEqual(l.gone, [], 'the save cleared the note, so live plus gone stay at six or fewer');
    assert.equal((await upload(att, JPEG, 'seven.jpg')).status, 409);
  });

  test('(−) S4: a sent id is neither listed nor gone; a removed id is neither', async () => {
    const { att } = make();
    const a = await saved(att, PNG, 'a.png');
    att.markSent([a.id]);
    assert.deepEqual(await listT(att), { files: [], gone: [] });
    const b = await saved(att, PNG, 'b.png');
    assert.equal(await att.remove(PANE, b.id), true);
    assert.deepEqual(await listT(att), { files: [], gone: [] });
  });

  test('(+) S5: a file deleted behind nika\'s back is listed as gone, and ENOENT is not logged', async () => {
    const { att, env, logs } = make();
    const a = await saved(att, PNG, 'a.png');
    const b = await saved(att, JPEG, 'b.jpg');
    fs.rmSync(path.join(keyDir(env), `${a.id}.png`));
    assert.deepEqual(await listT(att), { files: [{ id: b.id, name: 'b.jpg', type: 'jpeg', size: JPEG.length }], gone: ['a.png'] });
    assert.deepEqual(logs, []);
    assert.equal(await att.lookup(PANE, a.id), null, 'and the send no longer finds it');
  });

  test('(−) S5: a file swapped for a symlink, hard-linked, or resized is gone; nothing is followed or removed; another error is logged as a code only', async () => {
    const { att, env, logs } = make();
    const outside = path.join(root, 'outside-s5');
    fs.writeFileSync(outside, 'keep');
    const swap = await saved(att, PNG, 'swapped.png');
    const swapFile = path.join(keyDir(env), `${swap.id}.png`);
    fs.rmSync(swapFile);
    fs.symlinkSync(outside, swapFile);
    const linked = await saved(att, JPEG, 'linked.jpg');
    fs.linkSync(path.join(keyDir(env), `${linked.id}.jpg`), path.join(root, 'second-link-s5'));
    const grown = await saved(att, GIF89, 'grown.gif');
    fs.appendFileSync(path.join(keyDir(env), `${grown.id}.gif`), 'x');
    const l = await listT(att);
    assert.deepEqual(l, { files: [], gone: ['swapped.png', 'linked.jpg', 'grown.gif'] });
    assert.ok(fs.lstatSync(swapFile).isSymbolicLink(), 'the link was not removed');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep', 'and not followed');
    assert.ok(fs.existsSync(path.join(keyDir(env), `${linked.id}.jpg`)) && fs.existsSync(path.join(keyDir(env), `${grown.id}.gif`)), 'no file was touched');
    assert.equal(await att.remove(PANE, grown.id), false, 'a gone item\'s record is forgotten, so even a remove finds nothing to delete');
    assert.ok(fs.existsSync(path.join(keyDir(env), `${grown.id}.gif`)));
    assert.equal(logs.length, 2, 'the link and the second link are logged, the resize is not an error');
    assert.ok(onlyCodes(logs), logs.join('|'));
  });

  test('(−) S5: a folder on the way turned into a symlink makes the file gone, and the moved file stays', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG, 'a.png');
    const moved = `${keyDir(env)}-moved`;
    fs.renameSync(keyDir(env), moved);
    fs.symlinkSync(moved, keyDir(env));
    assert.deepEqual(await listT(att), { files: [], gone: ['a.png'] });
    assert.ok(fs.existsSync(path.join(moved, `${a.id}.png`)));
  });

  test('(+) S6: bindTray with the same key and owner keeps the items; a tray without an owner adopts the first one', async () => {
    const same = make();
    await bindT(same.att);
    const a = await saved(same.att, PNG, 'a.png');
    await bindT(same.att);
    assert.deepEqual(ids(await listT(same.att)), [a.id]);
    // made by a direct save (no owner), adopted by the bind: proven by a later, different owner dropping it
    const adopt = make();
    await saved(adopt.att, PNG, 'x.png');
    await bindT(adopt.att);
    await bindT(adopt.att, { owner: { pid: 9, session: 'sess-two' } });
    assert.deepEqual(await listT(adopt.att, { owner: { pid: 9, session: 'sess-two' } }), { files: [], gone: [] });
    assert.deepEqual(leftovers(adopt.env), []);
  });

  test('(+) S6: a /compact-shaped owner (other pid, same session) and a /clear-shaped one (same pid, other session) keep the items, and the tray follows the chain', async () => {
    const { att, env } = make();
    await bindT(att);
    const a = await saved(att, PNG, 'a.png');
    await bindT(att, { owner: { pid: 4202, session: 'sess-one' } }); // /compact: the child's pid, the pane's session
    await bindT(att, { owner: { pid: 4202, session: 'sess-two' } }); // /clear: the same pid, a new session
    await bindT(att, { owner: { pid: 4303, session: 'sess-two' } }); // /compact again: shares nothing with the first owner
    assert.deepEqual(ids(await listT(att, { owner: { pid: 4303, session: 'sess-two' } })), [a.id]);
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)));
  });

  test('(+) S6: the same chain seen only through listTray (page opens, no upload or bind between them): /compact, /clear and /compact again each keep the file, and the tray follows', async () => {
    const { att, env } = make();
    await bindT(att, { owner: { pid: 4101, session: 'sess-one' } });
    const a = await saved(att, PNG, 'a.png');
    const steps = [
      [{ pid: 4202, session: 'sess-one' }, '/compact: the child pid, the pane session'],
      [{ pid: 4202, session: 'sess-two' }, '/clear: the same pid, a new session'],
      [{ pid: 4303, session: 'sess-two' }, '/compact again: shares nothing with the first owner'],
    ];
    for (const [owner, why] of steps) {
      assert.deepEqual(ids(await listT(att, { owner })), [a.id], `${why}: the file is still listed`);
    }
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), 'after the last open the file is still on disk');
  });

  test('(−) S6: another Claude (other pid and other session) or another project (other key) drops the tray and deletes its unsent files', async () => {
    for (const over of [{ owner: { pid: 9, session: 'sess-two' } }, { key: KEY2 }]) {
      const { att, env } = make();
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      const sent = await saved(att, JPEG, 'b.jpg');
      att.markSent([sent.id]);
      await bindT(att, over);
      assert.deepEqual(leftovers(env), [`${sent.id}.jpg`], `${JSON.stringify(over)}: the unsent file is gone, the sent one is Claude's`);
      assert.equal(await att.lookup(PANE, a.id), null);
      assert.deepEqual(await listT(att, over), { files: [], gone: [] });
    }
  });

  test('(−) S6: bindTray with no known owner keeps the tray\'s owner', async () => {
    const { att, env } = make();
    await bindT(att);
    await saved(att, PNG, 'a.png');
    await bindT(att, { owner: null });
    assert.deepEqual(await listT(att, { owner: { pid: 9, session: 'sess-two' } }), { files: [], gone: [] }, 'the first owner is still the owner');
    assert.deepEqual(leftovers(env), []);
  });

  test('(−) S6: a malformed claim is ignored: no tray, nothing dropped, no throw', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG, 'a.png');
    await att.bindTray('nope', { key: KEY, owner: OWNER });
    await att.bindTray(PANE, { key: 'nope', owner: OWNER });
    await att.bindTray(PANE, null);
    await att.bindTray(undefined, undefined);
    assert.equal(att.hasTray('nope'), false);
    assert.deepEqual(ids(await listT(att)), [a.id]);
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)));
  });

  test('(−) S4: two saves started together at five live files: one lands and the other is 429 busy, so the tray never holds seven; the next one is 409 tray-full', async () => {
    const { att } = make();
    for (let i = 0; i < 5; i += 1) await saved(att, PNG, `f${i}.png`);
    const send = (name) => att.save({ pane: PANE, key: KEY, name, data: b64(PNG) });
    const both = await Promise.all([send('a.png'), send('b.png')]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 429]);
    assert.equal((await listT(att)).files.length, 6);
    assert.deepEqual((await send('c.png')).body.error, 'tray-full');
    assert.equal((await listT(att)).files.length, 6);
  });

  test('(−) S6: a key or a pane that only prints like a valid one (an array, an object) is refused by bindTray and listTray: nothing is made, dropped or deleted', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG, 'a.png');
    const asKey = { toString: () => KEY }; // prints as the project key, is not a string
    await att.bindTray('%99', { key: [KEY], owner: OWNER });
    await att.bindTray('%99', { key: asKey, owner: OWNER });
    assert.equal(att.hasTray('%99'), false, 'no tray under a key that is not a string');
    assert.deepEqual(await att.listTray(PANE, { key: [KEY], owner: OWNER }), { files: [], gone: [] });
    assert.deepEqual(await att.listTray(PANE, { key: asKey, owner: OWNER }), { files: [], gone: [] });
    assert.deepEqual(ids(await listT(att)), [a.id], 'the tray was not dropped by those lists');
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), 'and its file is still there');
    for (const pane of [['%98'], { toString: () => '%97' }]) await att.bindTray(pane, { key: KEY, owner: OWNER }); // prints as a pane id, is not a string
    const seen = [];
    await att.dropPanes((p) => { seen.push(p); return false; });
    assert.deepEqual(seen, [PANE], 'the only tray is the one for the pane that was stored');
  });

  test('(+) S7: listTray with another pid and another session drops the tray and deletes the files before it lists anything', async () => {
    const { att, env } = make();
    await bindT(att);
    const a = await saved(att, PNG, 'a.png');
    assert.deepEqual(await listT(att, { owner: { pid: 9, session: 'sess-two' } }), { files: [], gone: [] });
    assert.deepEqual(leftovers(env), []);
    assert.equal(await att.lookup(PANE, a.id), null);
    assert.equal(att.hasTray(PANE), false);
    const other = make();
    await bindT(other.att);
    await saved(other.att, PNG, 'a.png');
    assert.deepEqual(await listT(other.att, { key: KEY2 }), { files: [], gone: [] }, 'another key drops it too');
    assert.deepEqual(leftovers(other.env), []);
  });

  test('(−) S7: an unknown side never drops; the same session with another pid, or the same pid with another session, does not drop', async () => {
    const owners = [
      null, 'junk', { pid: 'x', session: 7 }, // an owner that does not parse is no owner
      { pid: 77, session: 'sess-one' }, { pid: 4101, session: 'sess-x' }, { pid: null, session: 'sess-one' }, { pid: 4101, session: null },
    ];
    for (const owner of owners) {
      const { att, env } = make();
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      assert.deepEqual(ids(await listT(att, { owner })), [a.id], JSON.stringify(owner));
      assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)));
    }
    const kept = make(); // a list with no known owner leaves the tray's owner as it is
    await bindT(kept.att);
    await saved(kept.att, PNG, 'k.png');
    await listT(kept.att, { owner: null });
    assert.deepEqual(await listT(kept.att, { owner: { pid: 9, session: 'sess-two' } }), { files: [], gone: [] });
    const noOwner = make(); // the tray has no owner yet (a direct save)
    const b = await saved(noOwner.att, PNG, 'b.png');
    assert.deepEqual(ids(await listT(noOwner.att, { owner: { pid: 9, session: 'sess-two' } })), [b.id]);
    assert.deepEqual(await listT(noOwner.att), { files: [], gone: [] }, 'and that first list made it the owner: the next, different one drops the tray');
  });

  test('(−) S7: an owner whose pid or session is not valid (0, negative, fractional, text, infinite; empty, array, object) is no owner: it never drops the tray', async () => {
    const junk = [
      { session: '' }, { session: ['sess-one'] }, { session: { length: 3 } }, { pid: 0 }, { pid: -3 }, { pid: 1.5 }, { pid: '4101' },
      { pid: Infinity }, { pid: 0, session: '' }, { pid: NaN, session: null },
    ];
    for (const owner of junk) {
      const { att, env } = make();
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      assert.deepEqual(ids(await listT(att, { owner })), [a.id], String(JSON.stringify(owner)));
      assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)));
    }
  });

  test('(+) S7: a half-known owner never overwrites a known part: bind or list with { null, sess-a }, or { pid, null }, then /clear (same pid) or /compact (same session) keeps the files', async () => {
    const full = { pid: 4101, session: 'sess-a' };
    const cases = [
      // [how the half-known owner arrives, the half-known owner, the later owner that still shares the part kept, why]
      [bindT, { pid: null, session: 'sess-a' }, { pid: 4101, session: 'sess-b' }, '/clear after a bind that knew only the session'],
      [listT, { pid: null, session: 'sess-a' }, { pid: 4101, session: 'sess-b' }, '/clear after a list that knew only the session'],
      [bindT, { pid: 4101, session: null }, { pid: 4102, session: 'sess-a' }, '/compact after a bind that knew only the pid'],
      [listT, { pid: 4101, session: null }, { pid: 4102, session: 'sess-a' }, '/compact after a list that knew only the pid'],
    ];
    for (const [door, half, later, why] of cases) {
      const { att, env } = make();
      await bindT(att, { owner: full });
      const a = await saved(att, PNG, 'a.png');
      await door(att, { owner: half });
      assert.deepEqual(ids(await listT(att, { owner: later })), [a.id], why);
      assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), why);
    }
  });

  test('(+) S7: a tray with no owner (a direct save) adopts a half-known owner by bind or by list, and the next different Claude drops it', async () => {
    for (const half of [{ pid: null, session: 'sess-a' }, { pid: 4101, session: null }]) {
      for (const door of [bindT, listT]) {
        const { att, env } = make();
        const a = await saved(att, PNG, 'a.png'); // the store made the tray itself: no owner yet
        await door(att, { owner: half });
        assert.deepEqual(ids(await listT(att, { owner: { pid: 9, session: 'sess-z' } })), [], `${JSON.stringify(half)}: the half it knew is the owner now`);
        assert.equal(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), false);
      }
    }
  });

  test('(−) S7: an owner that differs on a known side still drops the tray, whether it knows one part or both', async () => {
    const full = { pid: 4101, session: 'sess-a' };
    for (const owner of [{ pid: null, session: 'sess-b' }, { pid: 4102, session: null }, { pid: 4102, session: 'sess-b' }]) {
      for (const door of [bindT, listT]) {
        const { att, env } = make();
        await bindT(att, { owner: full });
        const a = await saved(att, PNG, 'a.png');
        await door(att, { owner });
        assert.equal(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), false, JSON.stringify(owner));
        assert.deepEqual(await listT(att, { owner }), { files: [], gone: [] }, JSON.stringify(owner));
      }
    }
  });

  test('(+) S7: "null equals null" is not a match: no shared pid or session value means a different Claude', async () => {
    for (const [mine, theirs] of [
      [{ pid: 1, session: null }, { pid: 2, session: null }],
      [{ pid: null, session: 'sess-a' }, { pid: null, session: 'sess-b' }],
      [{ pid: 1, session: 'sess-a' }, { pid: 2, session: 'sess-b' }],
    ]) {
      const { att, env } = make();
      await bindT(att, { owner: mine });
      await saved(att, PNG, 'a.png');
      assert.deepEqual(await listT(att, { owner: theirs }), { files: [], gone: [] }, JSON.stringify([mine, theirs]));
      assert.deepEqual(leftovers(env), []);
    }
  });

  test('(+) S14: hasTray is true after a save', async () => {
    const { att } = make();
    await saved(att, PNG, 'a.png');
    assert.equal(att.hasTray(PANE), true);
  });

  test('(−) S14: a tray with no items (bound, nothing saved) is gone after a list', async () => {
    const { att } = make();
    await bindT(att);
    assert.equal(att.hasTray(PANE), true);
    assert.deepEqual(await listT(att), { files: [], gone: [] });
    assert.equal(att.hasTray(PANE), false);
  });

  test('(−) S14: hasTray is false for a pane never used, after the last item is removed or sent, and after dropPanes', async () => {
    const { att } = make();
    assert.equal(att.hasTray(PANE), false);
    assert.equal(att.hasTray('nope'), false);
    assert.equal(att.hasTray(undefined), false);
    const a = await saved(att, PNG, 'a.png');
    await att.remove(PANE, a.id);
    assert.equal(att.hasTray(PANE), false);
    const b = await saved(att, PNG, 'b.png');
    att.markSent([b.id]);
    assert.equal(att.hasTray(PANE), false);
    await saved(att, PNG, 'c.png');
    assert.equal(att.hasTray(PANE), true);
    await att.dropPanes((p) => p === PANE);
    assert.equal(att.hasTray(PANE), false);
  });

  test('(+) S8: six saves pass; the 7th is 409 tray-full, writes no file and uses no rate slot (24 more saves still pass in the minute)', async () => {
    const { att, env } = make();
    for (let i = 0; i < PER_MESSAGE; i++) await saved(att, PNG, `f${i}.png`);
    const r = await upload(att, PNG, 'seven.png');
    assert.deepEqual(r, { status: 409, body: { error: 'tray-full', message: 'tray full' } });
    assert.equal(leftovers(env).length, PER_MESSAGE, 'no file was written');
    for (let p = 0; p < 4; p++) for (let i = 0; i < 6; i++) await saved(att, PNG, `p${p}-${i}.png`, { pane: `%${20 + p}` });
    const thirtyFirst = await upload(att, PNG, 'x.png', { pane: '%30' });
    assert.equal(thirtyFirst.status, 429, 'the limit is 30 a minute, so the refused 7th used none of it');
  });

  test('(−) S8: a removal frees a place; pane B and another project are not blocked by pane A\'s full tray; the chooser door is refused too', async () => {
    const { att } = make();
    const first = await saved(att, PNG, 'f0.png');
    for (let i = 1; i < PER_MESSAGE; i++) await saved(att, PNG, `f${i}.png`);
    assert.equal((await upload(att, PNG, 'seven.png')).status, 409);
    const viaChooser = await att.saveBytes({ pane: PANE, key: KEY, name: 'seven.png', bytes: PNG });
    assert.deepEqual(viaChooser, { status: 409, body: { error: 'tray-full', message: 'tray full' } });
    assert.equal((await upload(att, PNG, 'b.png', { pane: '%8' })).status, 200);
    assert.equal(await att.remove(PANE, first.id), true);
    assert.equal((await upload(att, PNG, 'seven.png')).status, 200);
    assert.equal((await upload(att, PNG, 'eight.png')).status, 409, 'and it is full again');
    assert.equal((await upload(att, PNG, 'other-key.png', { key: KEY2 })).status, 200, 'a tray of another key does not block');
  });

  test('(+) S8: a save under another key starts a new tray for it; the old tray\'s memory is forgotten and its files stay', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG, 'a.png');
    const r = await upload(att, JPEG, 'k2.jpg', { key: KEY2 });
    assert.equal(r.status, 200);
    assert.deepEqual(await listT(att, { key: KEY2 }), { files: [{ id: r.body.id, name: 'k2.jpg', type: 'jpeg', size: JPEG.length }], gone: [] });
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)));
  });

  test('(+) S9: remove forgets the item even when the removal is refused (a second link); it is neither listed nor gone', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG, 'a.png');
    const b = await saved(att, JPEG, 'b.jpg');
    fs.linkSync(path.join(keyDir(env), `${a.id}.png`), path.join(root, 'second-link-s9'));
    assert.equal(await att.remove(PANE, a.id), false);
    assert.deepEqual(await listT(att), { files: [{ id: b.id, name: 'b.jpg', type: 'jpeg', size: JPEG.length }], gone: [] });
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), 'the file stays for pruning');
  });

  test('(−) S9: another pane\'s remove, an unknown id and a sent id leave this pane\'s items alone', async () => {
    const { att } = make();
    const a = await saved(att, PNG, 'a.png');
    const b = await saved(att, JPEG, 'b.jpg');
    assert.equal(await att.remove('%8', a.id), false);
    assert.equal(await att.remove(PANE, SPARE), false);
    assert.deepEqual(ids(await listT(att)), [a.id, b.id]);
  });

  test('(−) S9: an item removed while the list checks the files is not listed, and not gone either', async () => {
    const { att } = make();
    const a = await saved(att, PNG, 'a.png');
    const b = await saved(att, JPEG, 'b.jpg');
    const listing = listT(att);
    const removal = att.remove(PANE, a.id); // runs while the list waits for its first file check
    assert.deepEqual([await removal, ids(await listing)], [true, [b.id]]);
    assert.deepEqual((await listT(att)).gone, []);
  });

  test('(−) S7: a tray dropped while the list checks the files lists nothing', async () => {
    const { att } = make();
    await bindT(att);
    await saved(att, PNG, 'a.png');
    await saved(att, JPEG, 'b.jpg');
    const listing = listT(att);
    await bindT(att, { owner: { pid: 9, session: 'sess-two' } }); // another Claude takes the pane meanwhile
    assert.deepEqual(await listing, { files: [], gone: [] });
  });

  test('(+) S10: markSent forgets the items; the sent files stay on disk for Claude', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG, 'a.png');
    const b = await saved(att, JPEG, 'b.jpg');
    const c = await saved(att, GIF89, 'c.gif');
    att.markSent([a.id, b.id]);
    assert.deepEqual(ids(await listT(att)), [c.id]);
    assert.deepEqual(leftovers(env), [`${a.id}.png`, `${b.id}.jpg`, `${c.id}.gif`].sort());
  });

  test('(−) S10: markSent with unknown ids or junk forgets nothing', async () => {
    const { att } = make();
    const a = await saved(att, PNG, 'a.png');
    att.markSent([SPARE, 7, null, {}]);
    att.markSent(undefined);
    assert.deepEqual(ids(await listT(att)), [a.id]);
  });

  test('(+) S11: dropPanes deletes the unsent files of the panes the predicate names, forgets their trays and returns how many', async () => {
    const { att, env } = make();
    await saved(att, PNG, 'a.png');
    const sent = await saved(att, JPEG, 'sent.jpg');
    att.markSent([sent.id]);
    const other = await saved(att, GIF89, 'o.gif', { pane: '%8' });
    assert.equal(await att.dropPanes((p) => p === PANE), 1);
    assert.deepEqual(leftovers(env), [`${other.id}.gif`, `${sent.id}.jpg`].sort(), 'only the unsent file of the named pane went');
    assert.equal(att.hasTray(PANE), false);
    assert.equal(att.hasTray('%8'), true);
    assert.deepEqual(ids(await att.listTray('%8', { key: KEY, owner: null })), [other.id]);
  });

  test('(−) S11: a predicate that names no pane drops nothing; a refused removal or a throwing predicate still resolves, with a code in the log', async () => {
    const { att, env, logs } = make();
    const a = await saved(att, PNG, 'a.png');
    assert.equal(await att.dropPanes(() => false), 0);
    assert.equal(await att.dropPanes(undefined), 0);
    assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)));
    fs.linkSync(path.join(keyDir(env), `${a.id}.png`), path.join(root, 'second-link-s11'));
    assert.equal(await att.dropPanes(() => true), 1, 'the tray is forgotten although the removal was refused');
    assert.deepEqual(logs, ['nika: attachments: ENLINK']);
    await saved(att, PNG, 'b.png');
    assert.equal(await att.dropPanes(() => { throw new Error('boom'); }), 0);
    assert.equal(att.hasTray(PANE), true);
    assert.deepEqual(logs.slice(1), ['nika: attachments: ERR']);
  });

  /** One save on each of `n` panes (%1 to %n), a minute apart every 20 saves so the rate limit never trips. */
  async function trays(n) {
    const m = make();
    for (let i = 1; i <= n; i++) {
      if (i % 20 === 0) m.clock.t += 61_000;
      await saved(m.att, PNG, `p${i}.png`, { pane: `%${i}` });
    }
    return m;
  }

  test('(−) S11: a file sent while the drop is still deleting the tray is Claude\'s now and stays', async () => {
    const { att, env } = make();
    const a = await saved(att, PNG, 'a.png');
    const b = await saved(att, JPEG, 'b.jpg');
    const dropping = att.dropPanes(() => true); // deletes a first, and waits
    att.markSent([b.id]); // the Enter lands meanwhile
    assert.equal(await dropping, 1);
    assert.deepEqual(leftovers(env), [`${b.id}.jpg`]);
    assert.ok(a.id);
  });

  test('(+) S12: the 65th tray forgets the oldest from memory only; its files stay on disk', async () => {
    const { att, env } = await trays(TRAYS_MAX + 1);
    assert.equal(att.hasTray('%1'), false);
    assert.equal(att.hasTray('%2'), true);
    assert.equal(att.hasTray(`%${TRAYS_MAX + 1}`), true);
    assert.equal(leftovers(env).length, TRAYS_MAX + 1, 'the forgotten tray\'s file is still there');
  });

  test('(−) S12: a tray replaced by a save under another key becomes the newest, so it is not the next one forgotten', async () => {
    const { att } = await trays(TRAYS_MAX);
    await saved(att, JPEG, 'k2.jpg', { pane: '%2', key: KEY2 }); // %2 starts a new tray (the key changed); no tray is forgotten for it
    assert.equal(att.hasTray('%1'), true);
    await saved(att, PNG, 'extra.png', { pane: `%${TRAYS_MAX + 1}` });
    assert.deepEqual(['%1', '%2', '%3'].map((p) => att.hasTray(p)), [false, true, true], 'the oldest is %1 now, not %2');
  });

  test('(−) S12: 64 trays forget nothing, and a save on the forgotten pane starts a new tray at the cost of the next oldest', async () => {
    const { att } = await trays(TRAYS_MAX);
    assert.equal(att.hasTray('%1'), true);
    assert.equal(att.hasTray(`%${TRAYS_MAX}`), true);
    await saved(att, PNG, 'extra.png', { pane: `%${TRAYS_MAX + 1}` });
    assert.equal(att.hasTray('%1'), false);
    await saved(att, JPEG, 'back.jpg', { pane: '%1' });
    assert.equal(att.hasTray('%1'), true);
    assert.equal(att.hasTray('%2'), false);
    assert.deepEqual((await att.listTray('%1', { key: KEY, owner: null })).files.map((f) => f.name), ['back.jpg']);
  });
});

// ---- 0.5.4 LT: the unsent text of a pane, kept in the same memory tray ------------------------------------------------------------
describe('kept text (0.5.4, LT)', () => {
  const textT = (att, value, over = {}, pane = PANE) => att.keepText(pane, { key: KEY, owner: OWNER, ...over }, value);
  const readT = (att, over = {}, pane = PANE) => att.readText(pane, { key: KEY, owner: OWNER, ...over });
  const MARK = 'zq7-marker-lt-text'; // synthetic text no log line or file may ever hold
  const euros = (n) => '\u20ac'.repeat(n); // 3 bytes each
  const FILL = Array.from({ length: TRAYS_MAX - 1 }, (_, i) => `%${201 + i}`);

  /**
   * Is there a tray left in the Map after `act`, empty or not? Probed by the 64-tray eviction: 63 other trays go in first, `act` runs,
   * then one more tray is made; the oldest of the 63 is forgotten only when `act` left a tray behind.
   */
  async function trayLeft(att, act) {
    for (const p of FILL) assert.equal(await textT(att, { text: `t${p}`, shell: false }, {}, p), true);
    await act();
    assert.equal(await textT(att, { text: 'probe', shell: false }, {}, '%300'), true);
    return (await readT(att, {}, FILL[0])) === null;
  }

  describe('keepText and readText', () => {
    test('(+) K1: keepText then readText gives an equal copy with the Shell flag; changing the copy changes nothing', async () => {
      const { att } = make();
      assert.equal(await textT(att, { text: 'first line\n\tsecond  ', shell: true }), true);
      const a = await readT(att);
      assert.deepEqual(a, { text: 'first line\n\tsecond  ', shell: true });
      a.text = 'changed';
      a.shell = false;
      assert.deepEqual(await readT(att), { text: 'first line\n\tsecond  ', shell: true }, 'the store kept its own copy');
      assert.equal(await textT(att, { text: 'newer', shell: false }), true);
      assert.deepEqual(await readT(att), { text: 'newer', shell: false }, 'the last write wins');
    });

    test('(+) K1: the text a caller passes is copied in: changing the passed object afterwards changes nothing', async () => {
      const { att } = make();
      const value = { text: 'as given', shell: false };
      await textT(att, value);
      value.text = 'mutated';
      value.shell = true;
      assert.deepEqual(await readT(att), { text: 'as given', shell: false });
    });

    test('(−) K1: another pane reads null; a pane never used reads null and makes no tray', async () => {
      const { att } = make();
      await textT(att, { text: 'mine', shell: false });
      assert.equal(await readT(att, {}, '%8'), null);
      assert.equal(att.hasText('%8'), false);
      const probe = make();
      assert.equal(await trayLeft(probe.att, () => readT(probe.att, {}, '%8')), false, 'a read of a pane never used leaves no tray');
    });

    test('(−) K1: a read of a tray that holds chips and no text is null and keeps the chips', async () => {
      const { att } = make();
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      assert.equal(await readT(att), null);
      assert.equal(att.hasText(PANE), false);
      assert.deepEqual((await listT(att)).files.map((f) => f.id), [a.id]);
    });

    test('(+) K2: keepText with null clears: readText is null and a text-only tray is deleted from the Map', async () => {
      const { att } = make();
      await textT(att, { text: 'to clear', shell: false });
      assert.equal(await textT(att, null), false);
      assert.equal(await readT(att), null);
      assert.equal(att.hasText(PANE), false);
      const probe = make();
      assert.equal(await trayLeft(probe.att, async () => {
        await textT(probe.att, { text: 'to clear', shell: false });
        await textT(probe.att, null);
      }), false, 'the cleared text-only tray is gone, not an empty one taking a slot');
    });

    test('(−) K2: a clear with no tray answers false and makes none; a clear on a tray with chips keeps the chips', async () => {
      const { att } = make();
      assert.equal(await textT(att, null), false);
      const probe = make();
      assert.equal(await trayLeft(probe.att, () => textT(probe.att, null)), false, 'a clear makes no tray');
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      await textT(att, { text: 'with a chip', shell: false });
      assert.equal(await textT(att, null), false);
      assert.equal(await readT(att), null);
      assert.deepEqual((await listT(att)).files.map((f) => f.id), [a.id], 'listTray still lists the chip');
    });

    test('(+) K3: the same owner keeps; a null owner adopts one; a /compact-shaped owner and a /clear-shaped one keep', async () => {
      const { att } = make();
      await textT(att, { text: 'kept', shell: false }, { owner: null });
      assert.equal((await readT(att, { owner: { pid: 4101, session: 'sess-one' } })).text, 'kept', 'an unknown owner never differs, and the next one is adopted');
      assert.equal((await readT(att, { owner: { pid: 4202, session: 'sess-one' } })).text, 'kept', '/compact: other pid, same session');
      assert.equal((await readT(att, { owner: { pid: 4202, session: 'sess-two' } })).text, 'kept', '/clear: same pid, other session');
      assert.equal((await readT(att, { owner: { pid: 4303, session: 'sess-two' } })).text, 'kept', '/compact again');
      assert.equal((await readT(att, { owner: null })).text, 'kept', 'a claim with no owner never differs');
    });

    test('(−) K3: another Claude (other pid and other session) or another project (other key) reads null, and the tray\'s unsent files are deleted from disk', async () => {
      for (const over of [{ owner: { pid: 9, session: 'sess-other' } }, { key: KEY2 }]) {
        const { att, env } = make();
        await bindT(att);
        const a = await saved(att, PNG, 'a.png');
        await textT(att, { text: 'kept', shell: false });
        assert.equal(await readT(att, over), null, JSON.stringify(over));
        assert.equal(att.hasText(PANE), false);
        assert.deepEqual(leftovers(env), [], `${JSON.stringify(over)}: the unsent file is gone with the tray`);
        assert.equal(await att.lookup(PANE, a.id), null);
      }
    });

    test('(−) K3: keepText with a differing owner or key drops the old tray (files deleted) and keeps the new text in a new tray', async () => {
      for (const over of [{ owner: { pid: 9, session: 'sess-other' } }, { key: KEY2 }]) {
        const { att, env } = make();
        await bindT(att);
        await saved(att, PNG, 'a.png');
        await textT(att, { text: 'old text', shell: false });
        assert.equal(await textT(att, { text: 'new text', shell: true }, over), true, JSON.stringify(over));
        assert.deepEqual(leftovers(env), [], 'the old tray\'s unsent file was deleted');
        assert.deepEqual(await readT(att, over), { text: 'new text', shell: true }, 'the new text lives in a new tray');
        assert.deepEqual((await listT(att, over)).files, [], 'the new tray holds no chips');
      }
    });

    test('(−) K3: keepText with null and a differing owner drops the old tray (files deleted) and answers false', async () => {
      const { att, env } = make();
      await bindT(att);
      await saved(att, PNG, 'a.png');
      await textT(att, { text: 'old text', shell: false });
      assert.equal(await textT(att, null, { owner: { pid: 9, session: 'sess-other' } }), false);
      assert.deepEqual(leftovers(env), []);
      assert.equal(att.hasText(PANE), false);
      assert.equal(await readT(att), null, 'nothing is left for the old Claude either');
    });

    test('(−) K6: two keeps for different projects that meet while the old tray is being dropped: the one that lost the race stores nothing in the other project\'s tray', async () => {
      const { att } = make();
      await bindT(att, { key: KEY });
      await saved(att, PNG, 'a.png'); // the old tray has a file: dropping it awaits the delete, and the second keep gets in meanwhile
      const [first, second] = await Promise.all([
        textT(att, { text: 'for project two', shell: false }, { key: KEY2, owner: { pid: 7001, session: 'sess-x' } }),
        textT(att, { text: 'for project three', shell: false }, { key: 'c3c3c3c3c3c3c3c3', owner: { pid: 7001, session: 'sess-x' } }),
      ]);
      assert.deepEqual([first, second].sort(), [false, true], 'exactly one of the two stored its text');
      const winner = second ? 'c3c3c3c3c3c3c3c3' : KEY2;
      const loser = second ? KEY2 : 'c3c3c3c3c3c3c3c3';
      assert.deepEqual(await readT(att, { key: winner, owner: { pid: 7001, session: 'sess-x' } }), { text: second ? 'for project three' : 'for project two', shell: false });
      assert.equal(att.hasText(PANE), true);
      assert.equal(await readT(att, { key: loser, owner: { pid: 7001, session: 'sess-x' } }), null, 'the other project reads nothing of it');
    });

    test('(+) K3 (owner doors): a half-known owner never overwrites a known part, at each new door alone (keep, clear, read)', async () => {
      const full = { pid: 4101, session: 'sess-a' };
      const doors = {
        keep: (att, owner) => textT(att, { text: 'kept', shell: false }, { owner }),
        clear: (att, owner) => textT(att, null, { owner }),
        read: (att, owner) => readT(att, { owner }),
      };
      const halves = [
        [{ pid: null, session: 'sess-a' }, { pid: 4101, session: 'sess-b' }, '/clear after a half that knew only the session'],
        [{ pid: 4101, session: null }, { pid: 4102, session: 'sess-a' }, '/compact after a half that knew only the pid'],
      ];
      for (const [name, door] of Object.entries(doors)) {
        for (const [half, later, why] of halves) {
          const { att } = make();
          await bindT(att, { owner: full });
          const a = await saved(att, PNG, 'a.png');
          await textT(att, { text: 'kept', shell: false }, { owner: full });
          await door(att, half);
          const listed = await listT(att, { owner: later });
          assert.deepEqual(listed.files.map((f) => f.id), [a.id], `${name}: ${why}: the tray was not dropped`);
        }
      }
    });

    test('(+) K3 (owner doors): a door that sees the missing half of the owner adopts it, so a later owner that shares only that half still matches (keep, clear, read)', async () => {
      const doors = {
        keep: (att, owner) => textT(att, { text: 'kept', shell: false }, { owner }),
        clear: (att, owner) => textT(att, null, { owner }),
        read: (att, owner) => readT(att, { owner }),
      };
      for (const [name, door] of Object.entries(doors)) {
        const { att } = make();
        await bindT(att, { owner: { pid: 4101, session: null } });
        const a = await saved(att, PNG, 'a.png');
        await door(att, { pid: 4101, session: 'sess-a' }); // the door learns the session
        const listed = await listT(att, { owner: { pid: 9999, session: 'sess-a' } }); // another pid, the same session
        assert.deepEqual(listed.files.map((f) => f.id), [a.id], `${name}: the session was adopted, so the tray matches by it`);
      }
    });

    test('(+) K3 (owner doors): the chain /compact, /clear, /compact seen only through one door keeps the text and the file (keep, clear, read)', async () => {
      const steps = [{ pid: 4202, session: 'sess-one' }, { pid: 4202, session: 'sess-two' }, { pid: 4303, session: 'sess-two' }];
      const doors = {
        keep: (att, owner) => textT(att, { text: 'kept', shell: false }, { owner }),
        clear: (att, owner) => textT(att, null, { owner }),
        read: (att, owner) => readT(att, { owner }),
      };
      for (const [name, door] of Object.entries(doors)) {
        const { att, env } = make();
        await bindT(att, { owner: { pid: 4101, session: 'sess-one' } });
        const a = await saved(att, PNG, 'a.png');
        await textT(att, { text: 'kept', shell: false }, { owner: { pid: 4101, session: 'sess-one' } });
        for (const owner of steps) {
          await door(att, owner);
          assert.deepEqual((await listT(att, { owner })).files.map((f) => f.id), [a.id], `${name}: ${JSON.stringify(owner)}: the chip is still listed`);
        }
        assert.ok(fs.existsSync(path.join(keyDir(env), `${a.id}.png`)), `${name}: the file is still on disk`);
      }
    });

    test('(−) K3 (owner doors): an owner that differs on a known side still drops the tray at each door, whether it knows one part or both', async () => {
      const full = { pid: 4101, session: 'sess-a' };
      const others = [{ pid: 9, session: 'sess-z' }, { pid: 9, session: null }, { pid: null, session: 'sess-z' }];
      const doors = {
        keep: (att, owner) => textT(att, { text: 'new', shell: false }, { owner }),
        clear: (att, owner) => textT(att, null, { owner }),
        read: (att, owner) => readT(att, { owner }),
      };
      for (const [name, door] of Object.entries(doors)) {
        for (const owner of others) {
          const { att, env } = make();
          await bindT(att, { owner: full });
          await saved(att, PNG, 'a.png');
          await textT(att, { text: 'old', shell: false }, { owner: full });
          await door(att, owner);
          assert.deepEqual(leftovers(env), [], `${name} ${JSON.stringify(owner)}: the old tray and its file went`);
          assert.deepEqual((await listT(att, { owner: full })).files, [], `${name} ${JSON.stringify(owner)}: no chip is left to list`);
        }
      }
    });

    test('(+) K4: removing or sending the last chip, or a note that ends, keeps a tray that still holds text', async () => {
      const { att } = make();
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      const b = await saved(att, JPEG, 'b.jpg');
      await textT(att, { text: 'text and chips', shell: false });
      await att.remove(PANE, a.id);
      assert.deepEqual(await readT(att), { text: 'text and chips', shell: false }, 'removing a chip keeps the text');
      att.markSent([b.id]);
      assert.deepEqual(await readT(att), { text: 'text and chips', shell: false }, 'sending the last chip keeps the text');
      assert.deepEqual(await listT(att), { files: [], gone: [] }, 'a text-only tray lists empty');
      assert.deepEqual(await readT(att), { text: 'text and chips', shell: false }, 'and listTray does not delete it');
      await att.remove(PANE, 'ffffffffffffffff'); // the end of the "not restored" note: any id works
      assert.deepEqual(await readT(att), { text: 'text and chips', shell: false }, 'release keeps it too');
    });

    test('(+) K4: a gone chip (its file is missing) leaves the text alone, and the next save clears only the note', async () => {
      const { att, env } = make();
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      await textT(att, { text: 'text', shell: false });
      fs.rmSync(path.join(keyDir(env), `${a.id}.png`));
      assert.deepEqual((await listT(att)).gone, ['a.png']);
      await saved(att, JPEG, 'b.jpg');
      assert.deepEqual(await readT(att), { text: 'text', shell: false });
    });

    test('(−) K4: a save under another key starts a new tray without the old tray\'s text', async () => {
      const { att } = make();
      await textT(att, { text: 'project one text', shell: false });
      await saved(att, PNG, 'other.png', { key: KEY2 });
      assert.equal(await readT(att, { key: KEY }), null, 'the old project\'s text did not follow the pane');
      assert.equal(att.hasText(PANE), false);
    });

    test('(−) K4: dropPanes takes the text with the tray; the 65th tray made by a text save forgets the oldest, whose text is gone and whose files stay on disk', async () => {
      const { att, env } = make();
      await bindT(att);
      await saved(att, PNG, 'a.png');
      await textT(att, { text: 'oldest', shell: false });
      for (const p of [...FILL, '%300']) await textT(att, { text: `t${p}`, shell: false }, {}, p); // 63 more make 64; the 65th forgets the oldest
      assert.equal(att.hasText(PANE), false, 'the 65th tray forgot the oldest one');
      assert.equal(await readT(att), null);
      assert.equal(leftovers(env).length, 1, 'its file stays on disk for pruning');
      assert.equal((await readT(att, {}, FILL[0])).text, `t${FILL[0]}`, 'the others are still there');
      assert.equal(await att.dropPanes((p) => p === FILL[0]), 1);
      assert.equal(att.hasText(FILL[0]), false);
      assert.equal(await readT(att, {}, FILL[0]), null);
      assert.equal(att.hasText(FILL[1]), true, 'only the named pane went');
    });

    test('(+) K5: hasText is true after a keep; hasTray stays false for a text-only tray, is true with a chip, and is still true for a bound tray that holds neither (AT\'s S14)', async () => {
      const { att } = make();
      assert.equal(att.hasText(PANE), false, 'a pane never used');
      await textT(att, { text: 'text only', shell: false });
      assert.equal(att.hasText(PANE), true);
      assert.equal(att.hasTray(PANE), false, 'a text-only tray is no tray of chips: AT\'s GET answers 200 empty for a null claim');
      await saved(att, PNG, 'a.png');
      assert.equal(att.hasTray(PANE), true);
      assert.equal(att.hasText(PANE), true);
      const bound = make();
      await bindT(bound.att);
      assert.equal(bound.att.hasTray(PANE), true, 'a tray that was bound and holds neither a chip nor a text is a tray, as before LT');
      assert.equal(bound.att.hasText(PANE), false);
    });

    test('(−) K5: hasText is false after a clear, after dropPanes, for junk panes; hasTray is true while a chip is gone, false after the chip leaves', async () => {
      const { att, env } = make();
      await textT(att, { text: 'x', shell: false });
      await textT(att, null);
      assert.equal(att.hasText(PANE), false);
      await textT(att, { text: 'x', shell: false });
      await att.dropPanes(() => true);
      assert.equal(att.hasText(PANE), false);
      for (const junk of [undefined, null, 7, 'nope', '%1;x', {}]) assert.equal(att.hasText(junk), false, String(junk));
      await bindT(att);
      const a = await saved(att, PNG, 'a.png');
      await textT(att, { text: 'x', shell: false });
      fs.rmSync(path.join(keyDir(env), `${a.id}.png`));
      await listT(att); // the chip is marked gone and keeps its place
      assert.equal(att.hasTray(PANE), true, 'a gone chip still makes the tray one of chips');
      await att.remove(PANE, a.id);
      assert.equal(att.hasTray(PANE), false, 'the text stays, the chips are gone');
      assert.equal(att.hasText(PANE), true);
    });

    test('(+) K6: exactly 16 384 bytes are kept; U+200D, U+202E, tab, inner newlines, trailing spaces and a valid pair are kept byte for byte', async () => {
      const { att } = make();
      const edge = euros(5461) + 'a';
      assert.equal(Buffer.byteLength(edge), 16384);
      assert.equal(await textT(att, { text: edge, shell: false }), true);
      assert.equal((await readT(att)).text, edge);
      const odd = 'a\u200db\u202ec\td\ne  \n\n\ud83d\ude00f   ';
      assert.equal(await textT(att, { text: odd, shell: true }), true);
      assert.deepEqual(await readT(att), { text: odd, shell: true });
    });

    test('(−) K6: 16 385 bytes, a bell, ESC, CR, DEL, a C1 control, NUL, a lone surrogate, an empty text, a non-string and a non-boolean shell are refused: false, nothing stored, no throw', async () => {
      const { att, logs } = make();
      await textT(att, { text: 'the good text', shell: false });
      const bad = [
        { text: euros(5461) + 'ab', shell: false }, { text: 'a\u0007b', shell: false }, { text: 'a\u001bb', shell: false }, { text: 'a\rb', shell: false },
        { text: 'a\u007fb', shell: false }, { text: 'a\u0085b', shell: false }, { text: 'a\u0000b', shell: false }, { text: 'a\ud800b', shell: false },
        { text: 'a\udc00b', shell: false }, { text: '', shell: false }, { text: 5, shell: false }, { text: null, shell: false }, { text: ['x'], shell: false },
        { text: 'x', shell: 'true' }, { text: 'x', shell: 1 }, { text: 'x', shell: undefined }, { text: 'x' }, { shell: true }, 'plain', 5, undefined, [], true,
      ];
      for (const value of bad) {
        assert.equal(await textT(att, value), false, JSON.stringify(value));
        assert.deepEqual(await readT(att), { text: 'the good text', shell: false }, `${JSON.stringify(value)} stored nothing`);
      }
      assert.ok(onlyCodes(logs), logs.join('|'));
      assert.ok(logs.length >= bad.length, 'every refusal is one code line');
    });

    test('(−) K6: a bad text twice in a row is refused both times (no stateful regex), and a good one still goes in between', async () => {
      const { att } = make();
      for (let i = 0; i < 4; i += 1) {
        assert.equal(await textT(att, { text: 'a\u0007', shell: false }), false, `call ${i + 1}`);
        assert.equal(await textT(att, { text: `ok ${i}`, shell: false }), true);
      }
    });

    test('(−) K6: a pane id or a claim that is not valid keeps nothing, drops nothing and never throws; a claim whose owner throws is refused with one code line', async () => {
      const { att, env, logs } = make();
      await bindT(att);
      const chip = await saved(att, PNG, 'a.png');
      await textT(att, { text: 'already here', shell: false });
      for (const [pane, claim] of [['nope', { key: KEY, owner: null }], ['%7;x', { key: KEY, owner: null }], [undefined, { key: KEY, owner: null }], [PANE, { key: 'short', owner: null }],
        [PANE, { key: undefined }], [PANE, null], [PANE, undefined], [PANE, 'x']]) {
        assert.equal(await att.keepText(pane, claim, { text: 'x', shell: false }), false, JSON.stringify([pane, claim]));
        assert.equal(await att.readText(pane, claim), null);
        assert.equal(await att.keepText(pane, claim, null), false);
      }
      assert.deepEqual(await readT(att), { text: 'already here', shell: false }, 'junk arguments drop and change nothing');
      assert.ok(fs.existsSync(path.join(keyDir(env), `${chip.id}.png`)), 'the chip\'s file is still there');
      assert.deepEqual(logs.filter((l) => !/BAD_TEXT|ERR/.test(l)), [], 'only codes');
      const boom = { key: KEY, get owner() { throw new Error('owner getter fails'); } };
      const before = logs.length;
      assert.equal(await att.keepText(PANE, boom, { text: 'x', shell: false }), false, 'never rejects');
      assert.equal(logs.length - before, 1, 'one code line: the unreadable owner is refused before any tray is touched');
      assert.deepEqual(await readT(att), { text: 'already here', shell: false }, 'nothing was stored');
      assert.equal(await att.readText(PANE, boom), null);
      assert.equal(await att.keepText(PANE, boom, null), false);
      assert.deepEqual(await readT(att), { text: 'already here', shell: false }, 'a throwing claim cleared nothing either');
    });

    test('(−) K6: when binding fails and the pane\'s old tray (another project) is still there, the new project\'s text is not stored in it', async () => {
      const { att } = make();
      await textT(att, { text: 'project one', shell: false });
      const boom = { key: KEY2, get owner() { throw new Error('owner getter fails'); } };
      assert.equal(await att.keepText(PANE, boom, { text: 'project two', shell: false }), false);
      assert.deepEqual(await readT(att), { text: 'project one', shell: false }, 'the old project\'s tray holds the old project\'s text only');
    });

    test('(+) K6: hasText answers for a text kept by a claim whose key is the tray\'s, and readText returns it only for that key', async () => {
      const { att } = make();
      await textT(att, { text: 'for one project', shell: false });
      assert.equal((await readT(att)).text, 'for one project');
      assert.equal(await readT(att, { key: KEY2 }), null);
      assert.equal(att.hasText(PANE), false, 'the other key dropped the tray');
    });

    test('(+) K7: a marker text through keep, read, clear, a bad value and dropPanes leaves no 8-character slice of it in any log line', async () => {
      const { att, logs } = make();
      await textT(att, { text: MARK, shell: false });
      await readT(att);
      await textT(att, { text: `${MARK}\u0007`, shell: false }); // a bad value: a code line
      await textT(att, { text: MARK, shell: true }, { owner: { pid: 9, session: 'sess-other' } });
      await textT(att, null);
      await textT(att, { text: MARK, shell: false });
      await att.dropPanes(() => true);
      assert.ok(logs.length >= 1, 'the scenario must log, or it proves nothing');
      const wire = logs.join('\n');
      for (let i = 0; i + 8 <= MARK.length; i += 1) assert.ok(!wire.includes(MARK.slice(i, i + 8)), MARK.slice(i, i + 8));
      assert.ok(onlyCodes(logs), logs.join('|'));
    });

    test('(−) K7: a store error under keepText or readText is logged as a code only, never the text', async () => {
      const { att, env, logs } = make();
      await bindT(att);
      const a = await saved(att, PNG, 'secret-name.png');
      fs.linkSync(path.join(keyDir(env), `${a.id}.png`), path.join(root, 'second-link-k7')); // the removal of this unsent file is refused: ENLINK
      await textT(att, { text: MARK, shell: false });
      await readT(att, { owner: { pid: 9, session: 'sess-other' } }); // another Claude: dropTray tries the removal
      assert.ok(logs.length >= 1, 'the refusal is logged');
      assert.ok(onlyCodes(logs), logs.join('|'));
      const wire = logs.join('\n');
      for (const leak of [MARK.slice(0, 8), 'secret-name', a.id, root]) assert.ok(!wire.includes(leak), leak);
    });

    test('(+) K8: the text never reaches disk: no file under the state or config dirs holds its bytes', async () => {
      const { att, env } = make();
      await bindT(att);
      await saved(att, PNG, 'a.png');
      await textT(att, { text: `${MARK} line\nsecond ${MARK}`, shell: true });
      await textT(att, { text: `${MARK} newer`, shell: false });
      await readT(att);
      await att.prune();
      const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
      const files = [...walk(env.XDG_STATE_HOME), ...walk(env.NIKA_CONFIG_DIR)];
      assert.ok(files.length >= 1, 'there is a file to look at (the attachment)');
      for (const f of files) assert.ok(!fs.readFileSync(f).includes(Buffer.from(MARK)), f);
      assert.deepEqual(files.filter((f) => !f.includes(`${path.sep}attachments${path.sep}`)), [], 'nothing outside the attachments folder was written');
    });
  });

  describe('keptTextOk, checkKeptBody and KEPT_CAP', () => {
    const MESSAGES = new Set(['body must be { text, shell }', 'shell must be true or false', 'text must be at most 16 KB without control characters other than newline and tab']);

    test('(+) keptTextOk takes plain text, newlines, tabs, joiners, bidi marks, trailing spaces, a valid pair and exactly 16 384 bytes', () => {
      for (const t of ['a', 'two\nlines', 'a\ttab', 'a\u200db', 'a\u202eb', 'ends  ', '\ud83d\ude00', euros(5461) + 'a', ' ', '\n']) assert.equal(keptTextOk(t), true, JSON.stringify(t.slice(0, 20)));
    });

    test('(−) keptTextOk refuses an empty text, a non-string, 16 385 bytes, C0 but tab and newline, CR, DEL, C1 and a lone surrogate; twice in a row alike', () => {
      for (const t of ['', null, undefined, 5, [], {}, euros(5461) + 'ab', euros(5462), 'a\u0000', 'a\u0007', 'a\u001b', 'a\r', 'a\u007f', 'a\u0085', 'a\u009f', 'a\ud800', 'a\udc00', 'a\ud800\ud800']) {
        assert.equal(keptTextOk(t), false, JSON.stringify(typeof t === 'string' ? t.slice(0, 12) : t));
        assert.equal(keptTextOk(t), false, 'the second call answers the same');
      }
    });

    test('(+) checkKeptBody takes { text, shell } with a keepable text, and { text: "", shell } as the clear', () => {
      assert.equal(checkKeptBody({ text: 'x', shell: false }), null);
      assert.equal(checkKeptBody({ text: 'two\nlines\tand tab', shell: true }), null);
      assert.equal(checkKeptBody({ text: euros(5461) + 'a', shell: false }), null);
      assert.equal(checkKeptBody({ text: '', shell: false }), null, 'a clear');
      assert.equal(checkKeptBody({ text: '', shell: true }), null);
    });

    test('(−) checkKeptBody answers 400 invalid with one fixed message that never holds the text, for every wrong body', () => {
      const secret = `${MARK}-in-body`;
      const bodies = [
        null, undefined, 'x', 5, [], {}, { text: 'x' }, { shell: true }, { text: secret, shell: false, extra: 1 }, { text: secret, shell: 'true' }, { text: secret, shell: 1 },
        { text: secret, extra: 1 }, { shell: true, other: 1 }, { text: secret, shell: null }, { text: 5, shell: false }, { text: null, shell: false }, { text: [secret], shell: false }, { text: `${secret}\u0007`, shell: false },
        { text: `${secret}\r`, shell: false }, { text: `${secret}\u001b`, shell: false }, { text: `${secret}\u007f`, shell: false }, { text: `${secret}\u0085`, shell: false },
        { text: `${secret}\ud800`, shell: false }, { text: secret + euros(5462), shell: false }, { text: '', shell: 'no' },
      ];
      for (const body of bodies) {
        const r = checkKeptBody(body);
        assert.equal(r?.status, 400, JSON.stringify(body)?.slice(0, 60));
        assert.equal(r.body.error, 'invalid');
        assert.ok(MESSAGES.has(r.body.message), `a fixed message: ${r.body.message}`);
        assert.ok(!JSON.stringify(r).includes(MARK), 'the answer never echoes the text');
      }
      assert.equal(checkKeptBody({ text: 'x', shell: 'no' }).body.message, 'shell must be true or false');
      assert.equal(checkKeptBody({ text: 'a\u0007', shell: false }).body.message, 'text must be at most 16 KB without control characters other than newline and tab');
      assert.equal(checkKeptBody({ text: 'x' }).body.message, 'body must be { text, shell }');
      assert.equal(checkKeptBody({ shell: true }).body.message, 'body must be { text, shell }');
      assert.equal(checkKeptBody({ text: 'x', extra: 1 }).body.message, 'body must be { text, shell }', 'two keys, but no shell');
      assert.equal(checkKeptBody({ shell: true, other: 1 }).body.message, 'body must be { text, shell }', 'two keys, but no text');
      assert.equal(checkKeptBody([]).body.message, 'body must be { text, shell }');
      // an array that carries both fields as own properties has exactly two keys and both names, so only the array check refuses it
      assert.equal(checkKeptBody(Object.assign([], { text: 'x', shell: false })).body.message, 'body must be { text, shell }');
    });

    test('(+) KEPT_CAP leaves room for 16 KB of JSON-escaped text; (−) it is bigger than the keys route\'s 20 KB cap', () => {
      assert.equal(KEPT_CAP, 34 * 1024);
      const body = JSON.stringify({ text: '"'.repeat(16384), shell: false });
      assert.ok(Buffer.byteLength(body) > 20 * 1024, 'a sendable text that CAP.keys would refuse');
      assert.ok(Buffer.byteLength(body) < KEPT_CAP);
      const worst = JSON.stringify({ text: '\\'.repeat(16384), shell: true });
      assert.ok(Buffer.byteLength(worst) < KEPT_CAP);
    });
  });
});
