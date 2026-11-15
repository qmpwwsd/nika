// serveApp: the stdio handshake, status feed, folder picker relay and shutdown, with PassThrough streams (plus one real
// child process for the exit behaviour). Synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serveApp, createPicker, statusLine } from '../src/appio.js';
import { loadConfig } from '../src/store.js';
import { createAttachments, MAX_BYTES } from '../src/attachments.js';
import { makeFixture, cleanup, fakeExec, NOW } from './helpers.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SECRET = 'kQ3vZ9mT1xW7bN5cR2dF8gH4jL6pS0uY-_aE1iO3tAw'.slice(0, 43);
const OTHER = 'zY8xW7vU6tS5rQ4pO3nM2lK1jI0hG9fE8dC7bA6_-Zq'.slice(0, 43);
const REQ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-appio-'));
const fx = makeFixture();
after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  cleanup(fx);
});

let counter = 0;
const hello = (secret = SECRET, extra = {}) => `${JSON.stringify({ type: 'hello', proto: 1, secret, ...extra })}\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** serveApp on PassThrough streams with its own temp config/state dirs. */
function harness({ tty = false, helloMs = 2000, intervalMs = 60_000, secret = SECRET, appCopy, exec = fakeExec(), releaseMs, attachments, state } = {}) {
  counter += 1;
  const base = path.join(ROOT, `h${counter}`);
  fs.mkdirSync(path.join(base, 'cfg'), { recursive: true });
  const env = { NIKA_CONFIG_DIR: path.join(base, 'cfg'), XDG_STATE_HOME: state ?? path.join(base, 'state'), NIKA_TMUX: 'tmux', NIKA_CLAUDE: '/nonexistent/claude' };
  const stdin = new PassThrough();
  stdin.isTTY = tty;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outText = '';
  let errText = '';
  const waiters = [];
  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  const lines = () => outText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  stdout.on('data', (c) => {
    outText += c;
    for (const w of [...waiters]) w();
  });
  stderr.on('data', (c) => { errText += c; });
  // the app copy never looks at the real ~/Applications or the real Homebrew folders here
  const copy = { home: path.join(base, 'home'), brewApps: [], ...appCopy };
  const done = serveApp({ config: fx.config, env, stdin, stdout, stderr, exec, now: () => NOW, intervalMs, helloMs, appCopy: copy, ...(releaseMs ? { releaseMs } : {}), ...(attachments ? { attachments } : {}) });
  const h = {
    env, stdin, secret, base, done,
    lines,
    out: () => outText,
    err: () => errText,
    send: (line) => stdin.write(line.endsWith('\n') ? line : `${line}\n`),
    /** First parsed stdout line (from `from`) that matches. */
    waitFor: (pred, ms = 3000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out; got ${outText}`)), ms);
      const check = () => {
        const hit = lines().find(pred);
        if (hit) {
          clearTimeout(t);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(hit);
        }
      };
      waiters.push(check);
      check();
    }),
    async up() {
      h.send(hello(secret));
      const ready = await h.waitFor((l) => l.type === 'ready');
      h.port = ready.port;
      return ready;
    },
    call: (method, p, { headers = {}, json, body } = {}) => new Promise((resolve, reject) => {
      const payload = json !== undefined ? JSON.stringify(json) : body;
      const hd = { host: `127.0.0.1:${h.port}`, 'x-nika-app': secret, ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers };
      const r = http.request({ host: '127.0.0.1', port: h.port, method, path: p, headers: hd, agent: false }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data && res.headers['content-type']?.includes('json') ? JSON.parse(data) : data }));
      });
      r.on('error', reject);
      if (payload !== undefined) r.write(payload);
      r.end();
    }),
    async close() {
      stdin.end();
      return done;
    },
    noSecret(s = secret) {
      assert.equal(outText.includes(s), false, 'secret on stdout');
      assert.equal(errText.includes(s), false, 'secret on stderr');
    },
  };
  return h;
}

describe('handshake: refusals', () => {
  test('(−) a TTY stdin is refused with a message on stderr and exit code 2; nothing is listened on or written to stdout', async () => {
    const h = harness({ tty: true });
    assert.equal(await h.done, 2);
    assert.match(h.err(), /needs a pipe on stdin/);
    assert.equal(h.out(), '');
  });

  test('(−) a first line that is not a valid hello is an error line and exit 2; the secret is never echoed', async () => {
    const bad = [
      'not json at all',
      `{"type":"hello","proto":1,"secret":"${SECRET}"`, // truncated JSON that still contains the secret
      JSON.stringify({ type: 'hello', proto: 2, secret: SECRET }),
      JSON.stringify({ type: 'hello', proto: '1', secret: SECRET }),
      JSON.stringify({ type: 'hello', proto: 1, secret: SECRET.slice(1) }),
      JSON.stringify({ type: 'hello', proto: 1, secret: `${SECRET.slice(1)}+` }),
      JSON.stringify({ type: 'hello', proto: 1, secret: [SECRET] }),
      JSON.stringify({ type: 'hello', proto: 1 }),
      JSON.stringify({ type: 'status', secret: SECRET }),
      JSON.stringify([SECRET]),
      'x'.repeat(70_000),
    ];
    for (const line of bad) {
      const h = harness();
      h.send(line);
      assert.equal(await h.done, 2, line.slice(0, 40));
      const lines = h.lines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0].type, 'error');
      assert.equal(typeof lines[0].message, 'string');
      h.noSecret();
      assert.equal(h.err(), '');
    }
  });

  test('(−) no hello within the time limit is an error line and exit 2', async () => {
    const h = harness({ helloMs: 40 });
    assert.equal(await h.done, 2);
    assert.deepEqual(h.lines().map((l) => l.type), ['error']);
  });

  test('(−) stdin closing before any hello is an error line and exit 2', async () => {
    const h = harness();
    h.stdin.end();
    assert.equal(await h.done, 2);
    assert.deepEqual(h.lines().map((l) => l.type), ['error']);
  });

  test('(−) a hello that arrives after the time limit does not start a server', async () => {
    const h = harness({ helloMs: 30 });
    assert.equal(await h.done, 2);
    h.send(hello());
    await sleep(50);
    assert.deepEqual(h.lines().map((l) => l.type), ['error']);
  });
});

describe('handshake: a valid hello', () => {
  test('(+) ready line has the contract shape and the server answers on that port with the secret only', async () => {
    const h = harness();
    const ready = await h.up();
    assert.deepEqual(Object.keys(ready), ['type', 'proto', 'port', 'version']);
    assert.equal(ready.proto, 1);
    assert.equal(ready.version, VERSION);
    assert.equal(Number.isInteger(ready.port) && ready.port > 0 && ready.port < 65536, true);
    const me = await h.call('GET', '/api/app/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.version, VERSION);
    const cmds = await h.call('GET', '/api/app/commands'); // listCommands is wired into the real deps
    assert.equal(cmds.status, 200);
    assert.equal(Array.isArray(cmds.body.commands) && cmds.body.commands.length > 0, true);
    const models = await h.call('GET', '/api/app/models');
    assert.equal(models.status, 200);
    assert.equal(models.body.models.length > 0, true);
    assert.equal(me.body.tier, 'app');
    assert.equal((await h.call('GET', '/api/app/me', { headers: { 'x-nika-app': OTHER } })).status, 403);
    assert.equal((await h.call('GET', '/api/health')).status, 200); // the 0.1 routes ride along
    await h.close();
  });

  test('(+) the server listens on 127.0.0.1 only', async () => {
    const h = harness();
    await h.up();
    const other = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (other) {
      await assert.rejects(new Promise((resolve, reject) => {
        const s = net.connect({ host: other.address, port: h.port, timeout: 500 }, () => { s.destroy(); resolve(); });
        s.on('error', reject);
        s.on('timeout', () => { s.destroy(); reject(new Error('timeout')); });
      }));
    }
    await h.close();
  });

  test('(−) a second hello, unknown types, junk and over-long lines are ignored; the first secret keeps working', async () => {
    const h = harness();
    await h.up();
    h.send(hello(OTHER));
    h.send('{"type":"mystery"}');
    h.send('garbage');
    h.send('[1,2]');
    h.send('y'.repeat(70_000));
    h.stdin.write(`{"type":"folder","reqId":"${REQ_A}","path":"/x"}\n`); // no picker is open: ignored
    await sleep(30);
    assert.equal((await h.call('GET', '/api/app/me', { headers: { 'x-nika-app': OTHER } })).status, 403);
    assert.equal((await h.call('GET', '/api/app/me')).status, 200);
    assert.deepEqual(h.lines().map((l) => l.type).filter((t) => t !== 'status'), ['ready']);
    await h.close();
  });

  test('(+) a hello split over several chunks, with CRLF, is accepted', async () => {
    const h = harness();
    const line = hello().trimEnd();
    h.stdin.write(line.slice(0, 10));
    h.stdin.write(line.slice(10, 30));
    h.stdin.write(`${line.slice(30)}\r\n`);
    assert.equal((await h.waitFor((l) => l.type === 'ready')).proto, 1);
    await h.close();
  });
});

describe('app copy wiring (ADR 0011)', () => {
  const APP_ID = 'io.github.qmpwwsd.nika';
  const bundle = (dir, version) => {
    fs.mkdirSync(path.join(dir, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>${APP_ID}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  };
  const dittoOnly = () => {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === '/usr/bin/ditto') fs.cpSync(args[0], args[1], { recursive: true });
      return { stdout: '', stderr: '' };
    };
    exec.calls = calls;
    return exec;
  };

  test('(+) me carries the copy state of this install; install copies from the keg into the (temp) home; dismiss writes the marker', async () => {
    counter += 1;
    const keg = path.join(ROOT, `keg${counter}`);
    fs.mkdirSync(path.join(keg, 'libexec'), { recursive: true });
    bundle(path.join(keg, 'nika.app'), '1.2.3');
    const exec = dittoOnly();
    const home = path.join(ROOT, `home-w${counter}`);
    fs.mkdirSync(home);
    const h = harness({ appCopy: { home, root: path.join(keg, 'libexec'), platform: 'darwin', exec } });
    try {
    await h.up();
    const me = await h.call('GET', '/api/app/me');
    assert.deepEqual(me.body.appCopy, { state: 'missing', managed: false, dismissed: false, version: null, available: '1.2.3', running: false });
    const r = await h.call('POST', '/api/app/app-copy', { json: { action: 'install' } });
    assert.deepEqual(r.body, { state: 'current', version: '1.2.3', restart: false });
    assert.equal(fs.existsSync(path.join(home, 'Applications', 'nika.app', 'Contents', 'Info.plist')), true);
    assert.deepEqual(exec.calls.map((c) => c[0]), ['/usr/bin/ditto', exec.calls[1][0]]);
    assert.equal((await h.call('GET', '/api/app/me')).body.appCopy.state, 'current');
    const d = await h.call('POST', '/api/app/app-copy', { json: { action: 'dismiss' } });
    assert.deepEqual(d.body, { dismissed: true });
    const marker = JSON.parse(fs.readFileSync(path.join(h.env.XDG_STATE_HOME, 'nika', 'app-copy.json'), 'utf8'));
    assert.deepEqual(marker, { managed: true, version: '1.2.3', dismissed: true });
    h.noSecret();
    } finally {
      await h.close();
    }
  });

  test('(−) no source: me says no-source and install is 409; Linux: unsupported and nothing is written to the home', async () => {
    counter += 1;
    const home = path.join(ROOT, `home-n${counter}`);
    fs.mkdirSync(home);
    const h = harness({ appCopy: { home, root: path.join(ROOT, 'elsewhere'), platform: 'darwin', exec: dittoOnly() } });
    const l = harness({ appCopy: { home, platform: 'linux', exec: dittoOnly() } });
    try {
      await h.up();
      assert.equal((await h.call('GET', '/api/app/me')).body.appCopy.state, 'no-source');
      const r = await h.call('POST', '/api/app/app-copy', { json: { action: 'install' } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'no-source');
      await l.up();
      assert.equal((await l.call('GET', '/api/app/me')).body.appCopy.state, 'unsupported');
      assert.equal((await l.call('POST', '/api/app/app-copy', { json: { action: 'install' } })).body.error, 'unsupported');
      assert.deepEqual(fs.readdirSync(home), []);
    } finally {
      await h.close();
      await l.close();
    }
  });
});

describe('status feed', () => {
  test('(+) a status line follows ready and has the contract shape: integers, at most 8 projects, clean names', async () => {
    const h = harness();
    await h.up();
    const s = await h.waitFor((l) => l.type === 'status');
    assert.deepEqual(Object.keys(s), ['type', 'busy', 'idle', 'other', 'ended', 'attention', 'projects']);
    for (const k of ['busy', 'idle', 'other', 'ended', 'attention']) assert.equal(Number.isInteger(s[k]) && s[k] >= 0, true, k);
    assert.equal(s.busy, 1); // fixture: one busy, one idle live session
    assert.equal(s.idle, 1);
    assert.equal(s.projects.length >= 1 && s.projects.length <= 8, true);
    assert.deepEqual(s.projects.map((p) => p.name), ['repo', 'plain']);
    for (const p of s.projects) {
      assert.deepEqual(Object.keys(p), ['key', 'name', 'busy', 'idle', 'attention']);
      assert.match(p.key, /^[a-z0-9]{16}$/);
      assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(p.name), false);
    }
    await h.close();
  });

  test('(+) status repeats on the interval; (−) none is written after stdin closed', async () => {
    const h = harness({ intervalMs: 25 });
    await h.up();
    await h.waitFor((l) => l.type === 'status');
    await sleep(120);
    assert.equal(h.lines().filter((l) => l.type === 'status').length >= 3, true);
    await h.close();
    const n = h.lines().length;
    await sleep(80);
    assert.equal(h.lines().length, n);
  });

  test('(+) statusLine caps the project list at 8, cleans names and counts attention as live agents that are neither busy nor idle', () => {
    const group = (i) => ({ key: `/p/${i}`, root: `/p/${i}`, label: `proj\u001b[31m${i}`, counts: { busy: 1, idle: 2, other: 3, ended: 4, total: 10 } });
    const s = statusLine({ counts: { busy: 5, idle: 6, other: 7, ended: 8, total: 26 }, groups: Array.from({ length: 12 }, (_, i) => group(i)) });
    assert.equal(s.projects.length, 8);
    assert.equal(s.projects[0].name, 'proj0'); // the whole ESC[31m sequence is removed
    assert.equal(s.attention, 7);
    assert.deepEqual(s.projects[0], { key: s.projects[0].key, name: 'proj0', busy: 1, idle: 2, attention: 3 });
    assert.equal(JSON.stringify(s).includes('/p/'), false); // keys are hashes, no paths
    assert.equal(statusLine({ counts: { busy: 0, idle: 0, other: 0, ended: 0, total: 0 }, groups: [{ key: '(unknown)', root: null, label: '(unknown)', counts: { busy: 0, idle: 0, other: 0, ended: 0, total: 0 } }] }).projects[0].name, '(unknown)');
  });
});

describe('window relay (F2): POST /api/app/window writes one `window` line for the shell', () => {
  const ACTIONS = ['quit', 'close', 'minimize', 'zoom-in', 'zoom-out', 'zoom-reset'];
  const windowLines = (h) => h.lines().filter((l) => l.type === 'window');

  test('(+) each action answers 204 and writes exactly one {"type":"window","action":…} line to stdout', async () => {
    const h = harness();
    await h.up();
    for (const action of ACTIONS) {
      const before = windowLines(h).length;
      const r = await h.call('POST', '/api/app/window', { json: { action } });
      assert.equal(r.status, 204, action);
      assert.equal(r.body, '', action);
      const lines = windowLines(h);
      assert.equal(lines.length, before + 1, action);
      assert.deepEqual(lines.at(-1), { type: 'window', action });
    }
    assert.ok(h.out().split('\n').includes('{"type":"window","action":"zoom-reset"}'), 'compact JSON, one line');
    h.noSecret();
    await h.close();
  });

  test('(−) an unknown action is 400 and a body that is not JSON is 415: no line is written', async () => {
    const h = harness();
    await h.up();
    assert.equal((await h.call('POST', '/api/app/window', { json: { action: 'maximize' } })).status, 400);
    assert.equal((await h.call('POST', '/api/app/window', { json: {} })).status, 400);
    assert.equal((await h.call('POST', '/api/app/window', { body: 'action=quit', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await h.call('POST', '/api/app/window', { json: { action: 'quit' }, headers: { 'x-nika-app': OTHER } })).status, 403);
    await sleep(30);
    assert.deepEqual(windowLines(h), []);
    await h.close();
  });

  test('(−) a `window` line from the shell is not a command: the server ignores it', async () => {
    const h = harness();
    await h.up();
    h.send(JSON.stringify({ type: 'window', action: 'quit' }));
    await sleep(30);
    assert.deepEqual(windowLines(h), []);
    assert.equal((await h.call('GET', '/api/app/me')).status, 200);
    await h.close();
  });
});

describe('folder picker', () => {
  const mkdir = (name) => {
    const d = path.join(ROOT, `pick-${counter}-${name}`);
    fs.mkdirSync(d, { recursive: true });
    return fs.realpathSync(d);
  };

  test('(+) round trip: pick-folder line, pending, folder answer, done with the project; the project is registered', async () => {
    const h = harness();
    await h.up();
    const dir = mkdir('round');
    const start = await h.call('POST', '/api/app/projects/pick', { json: {} });
    assert.equal(start.status, 202);
    const { reqId } = start.body;
    assert.match(reqId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await h.waitFor((l) => l.type === 'pick-folder'), { type: 'pick-folder', reqId });
    assert.deepEqual((await h.call('GET', `/api/app/projects/pick/${reqId}`)).body, { state: 'pending' });
    h.send(JSON.stringify({ type: 'folder', reqId, path: dir }));
    for (let i = 0; i < 50 && (await h.call('GET', `/api/app/projects/pick/${reqId}`)).body.state === 'pending'; i += 1) await sleep(10);
    const done = (await h.call('GET', `/api/app/projects/pick/${reqId}`)).body;
    assert.equal(done.state, 'done');
    assert.equal(done.project.dir, dir);
    assert.equal(done.project.name, path.basename(dir));
    assert.deepEqual(done.project.rules, { state: 'none', settingsIgnored: false, git: false });
    assert.deepEqual((await loadConfig(h.env)).config.projects.map((p) => p.dir), [dir]);
    assert.deepEqual((await h.call('GET', '/api/app/projects')).body.projects.map((p) => p.key), [done.project.key]);
    h.send(JSON.stringify({ type: 'folder', reqId, path: mkdir('late') })); // a repeat answer changes nothing
    await sleep(30);
    assert.equal((await loadConfig(h.env)).config.projects.length, 1);
    await h.close();
  });

  test('(+) cancel: a null path closes the request as cancelled and a new pick can start; the old id is then unknown', async () => {
    const h = harness();
    await h.up();
    const a = (await h.call('POST', '/api/app/projects/pick', { json: {} })).body.reqId;
    h.send(JSON.stringify({ type: 'folder', reqId: a, path: null }));
    await sleep(30);
    assert.deepEqual((await h.call('GET', `/api/app/projects/pick/${a}`)).body, { state: 'cancelled' });
    const b = (await h.call('POST', '/api/app/projects/pick', { json: {} })).body.reqId;
    assert.notEqual(a, b);
    assert.equal((await h.call('GET', `/api/app/projects/pick/${a}`)).status, 404);
    assert.deepEqual((await loadConfig(h.env)).config.projects, []);
    await h.close();
  });

  test('(−) only one picker at a time: a second pick while one is open is 429', async () => {
    const h = harness();
    await h.up();
    assert.equal((await h.call('POST', '/api/app/projects/pick', { json: {} })).status, 202);
    const second = await h.call('POST', '/api/app/projects/pick', { json: {} });
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'busy');
    assert.equal(h.lines().filter((l) => l.type === 'pick-folder').length, 1);
    await h.close();
  });

  test('(−) a forged reqId is ignored and leaves the open request pending', async () => {
    const h = harness();
    await h.up();
    const dir = mkdir('forged');
    const { reqId } = (await h.call('POST', '/api/app/projects/pick', { json: {} })).body;
    h.send(JSON.stringify({ type: 'folder', reqId: REQ_A, path: dir }));
    h.send(JSON.stringify({ type: 'folder', path: dir }));
    h.send(JSON.stringify({ type: 'folder', reqId: 5, path: dir }));
    await sleep(40);
    assert.deepEqual((await h.call('GET', `/api/app/projects/pick/${reqId}`)).body, { state: 'pending' });
    assert.deepEqual((await loadConfig(h.env)).config.projects, []);
    await h.close();
  });

  test('(−) an unusable path closes the request as cancelled and registers nothing: relative, missing, a file, NUL, not a string', async () => {
    const h = harness();
    await h.up();
    const file = path.join(mkdir('file'), 'f.txt');
    fs.writeFileSync(file, 'x');
    const paths = ['relative/dir', '../up', '', path.join(ROOT, 'does-not-exist'), file, `${mkdir('nul')}\0x`, 42, { a: 1 }, 'x'.repeat(5000)];
    for (const p of paths) {
      const { reqId } = (await h.call('POST', '/api/app/projects/pick', { json: {} })).body;
      h.send(JSON.stringify({ type: 'folder', reqId, path: p }));
      let state = 'pending';
      for (let i = 0; i < 50 && state === 'pending'; i += 1) {
        await sleep(10);
        state = (await h.call('GET', `/api/app/projects/pick/${reqId}`)).body.state;
      }
      assert.equal(state, 'cancelled', JSON.stringify(p).slice(0, 40));
    }
    assert.deepEqual((await loadConfig(h.env)).config.projects, []);
    await h.close();
  });

  test('(+) a symlink to a directory is stored as its real path', async () => {
    const h = harness();
    await h.up();
    const target = mkdir('target');
    const link = path.join(ROOT, `link-${counter}`);
    fs.symlinkSync(target, link);
    const { reqId } = (await h.call('POST', '/api/app/projects/pick', { json: {} })).body;
    h.send(JSON.stringify({ type: 'folder', reqId, path: link }));
    for (let i = 0; i < 50 && (await h.call('GET', `/api/app/projects/pick/${reqId}`)).body.state === 'pending'; i += 1) await sleep(10);
    assert.equal((await h.call('GET', `/api/app/projects/pick/${reqId}`)).body.project.dir, target);
    await h.close();
  });

  test('(+) createPicker alone: start/status/onFolder with an injected sender', async () => {
    const sent = [];
    const picker = createPicker({ send: (m) => sent.push(m), env: harness({ tty: true }).env });
    const id = picker.start();
    assert.deepEqual(sent, [{ type: 'pick-folder', reqId: id }]);
    assert.equal(picker.start(), null);
    assert.deepEqual(picker.status(id), { state: 'pending', project: undefined });
    assert.equal(picker.status(REQ_A), null);
  });
});

// The attachment chooser (W2-T6): the shell's native file dialog answers with paths, the server reads them itself and hands the bytes to the
// attachment store. The page only ever sees ids, names, sizes and types, never a path.
describe('file chooser', () => {
  // The store refuses a state path Claude cannot take as one token, so these tests keep theirs short and plain (as attachments.test.js does).
  const tmpBase = (() => {
    const t = fs.realpathSync(os.tmpdir());
    return /^\/[A-Za-z0-9._/+-]{1,80}$/.test(t) ? t : '/tmp';
  })();
  const dirRoot = fs.mkdtempSync(path.join(tmpBase, 'nika-pf-'));
  after(() => fs.rmSync(dirRoot, { recursive: true, force: true }));

  const KEY = 'a1b2c3d4e5f60718';
  const KEY2 = 'b8a7f6e5d4c3b2a1';
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
  const MIB = 1024 * 1024;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let nth = 0;

  /** A picker on a real attachment store in its own temp state dir; `sent` = what it wrote to the shell, `logs` = every line the store logged. */
  function rig() {
    nth += 1;
    const base = path.join(dirRoot, `r${nth}`);
    const dir = path.join(base, 'files');
    fs.mkdirSync(dir, { recursive: true });
    const env = { NIKA_CONFIG_DIR: path.join(base, 'cfg'), XDG_STATE_HOME: path.join(base, 'state') };
    const sent = [];
    const logs = [];
    const attachments = createAttachments({ env, loadKeepDays: async () => 7, log: (l) => logs.push(l) });
    const picker = createPicker({ send: (m) => sent.push(m), env, attachments });
    const put = (name, data = 'hello\n') => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, data);
      return p;
    };
    const storeDir = path.join(base, 'state', 'nika', 'attachments');
    const stored = () => (fs.existsSync(storeDir) ? fs.readdirSync(storeDir).flatMap((k) => fs.readdirSync(path.join(storeDir, k))) : []);
    /** Starts a files request, answers it with `paths`, waits for the end; resolves { reqId, answer }. */
    async function pick(paths, { room = 6, pane = '%6', key = KEY } = {}) {
      const reqId = picker.startFiles({ pane, key, room });
      assert.match(reqId, /^[0-9a-f-]{36}$/);
      await picker.onFiles({ type: 'files', reqId, paths });
      return { reqId, answer: picker.filesStatus(pane, reqId) };
    }
    return { picker, sent, logs, dir, put, stored, pick, env, base, attachments };
  }

  test('(+) start sends exactly one pick-files line; the request is pending, and only for its own pane', () => {
    const r = rig();
    const reqId = r.picker.startFiles({ pane: '%6', key: KEY, room: 3 });
    assert.deepEqual(r.sent, [{ type: 'pick-files', reqId }]);
    assert.deepEqual(r.picker.filesStatus('%6', reqId), { state: 'pending' });
    assert.equal(r.picker.filesStatus('%7', reqId), null, 'another pane cannot see it');
    assert.equal(r.picker.filesStatus('%6', REQ_A), null, 'an unknown id');
    assert.equal(r.picker.status(reqId), null, 'the folder reading does not know a files request');
  });

  test('(+) round trip: two picked files are read, stored under the pane key and answered as ready entries in order, with no path', async () => {
    const r = rig();
    const text = r.put('notes.md', '# synthetic\n');
    const png = r.put('shot.png', PNG);
    const { answer } = await r.pick([text, png]);
    assert.equal(answer.state, 'done');
    assert.equal(answer.files.length, 2);
    const [a, b] = answer.files;
    assert.deepEqual(Object.keys(a).sort(), ['id', 'name', 'ok', 'size', 'type']);
    assert.deepEqual([a.ok, a.name, a.size, a.type], [true, 'notes.md', 12, 'text']);
    assert.deepEqual([b.ok, b.name, b.size, b.type], [true, 'shot.png', PNG.length, 'png']);
    assert.match(a.id, /^[0-9a-f]{16}$/);
    assert.equal(r.stored().length, 2);
    const wire = JSON.stringify(answer);
    assert.ok(!wire.includes(r.dir) && !wire.includes(dirRoot) && !wire.includes('/'), 'no path in the answer');
    assert.deepEqual(r.logs, []);
    assert.equal(r.sent.length, 1, 'the shell got one line');
  });

  test('(+) the picked file is a send-ready attachment of that pane: lookup finds it for the pane and not for another', async () => {
    const r = rig();
    const { answer } = await r.pick([r.put('a.md')], { pane: '%6' });
    assert.ok(await r.attachments.lookup('%6', answer.files[0].id));
    assert.equal(await r.attachments.lookup('%7', answer.files[0].id), null);
    const other = await r.pick([r.put('b.md')], { pane: '%9', key: KEY2 });
    assert.ok(fs.readdirSync(path.join(r.base, 'state', 'nika', 'attachments')).includes(KEY2));
    assert.equal(other.answer.files[0].ok, true);
  });

  test('(+) cancel: null closes the request as cancelled, a new one can start, and the old id is then unknown', async () => {
    const r = rig();
    const a = r.picker.startFiles({ pane: '%6', key: KEY, room: 6 });
    await r.picker.onFiles({ type: 'files', reqId: a, paths: null });
    assert.deepEqual(r.picker.filesStatus('%6', a), { state: 'cancelled' });
    const b = r.picker.startFiles({ pane: '%6', key: KEY, room: 6 });
    assert.ok(b && b !== a);
    assert.equal(r.picker.filesStatus('%6', a), null);
    assert.deepEqual(r.stored(), []);
  });

  test('(−) an empty list, or paths that is not a list, closes the request as cancelled and reads nothing', async () => {
    const r = rig();
    for (const paths of [[], 'x', { 0: '/a' }, 7, undefined, true]) {
      const reqId = r.picker.startFiles({ pane: '%6', key: KEY, room: 6 });
      await r.picker.onFiles({ type: 'files', reqId, paths });
      assert.deepEqual(r.picker.filesStatus('%6', reqId), { state: 'cancelled' }, JSON.stringify(paths));
    }
    assert.deepEqual(r.stored(), []);
  });

  test('(−) one slot for both kinds: a folder request while files are open is busy, and files while a folder is open are busy', async () => {
    const r = rig();
    const files = r.picker.startFiles({ pane: '%6', key: KEY, room: 6 });
    assert.equal(r.picker.start(), null);
    assert.equal(r.picker.startFiles({ pane: '%6', key: KEY, room: 6 }), null);
    assert.deepEqual(r.sent, [{ type: 'pick-files', reqId: files }], 'no second line went out');
    await r.picker.onFiles({ type: 'files', reqId: files, paths: null });
    const folder = r.picker.start();
    assert.ok(folder);
    assert.equal(r.picker.startFiles({ pane: '%6', key: KEY, room: 6 }), null);
    assert.deepEqual(r.sent.at(-1), { type: 'pick-folder', reqId: folder });
    assert.equal(r.sent.length, 2);
    assert.equal(r.picker.filesStatus('%6', folder), null, 'a folder request is not a files request');
    await r.picker.onFolder({ type: 'folder', reqId: folder, path: null });
    assert.ok(r.picker.startFiles({ pane: '%6', key: KEY, room: 6 }), 'free again once it ended');
  });

  test('(−) a request that is being read still holds the slot', async () => {
    const r = rig();
    const reqId = r.picker.startFiles({ pane: '%6', key: KEY, room: 6 });
    const reading = r.picker.onFiles({ type: 'files', reqId, paths: [r.put('slow.md')] });
    assert.deepEqual(r.picker.filesStatus('%6', reqId), { state: 'pending' }, 'working reads as pending');
    assert.equal(r.picker.start(), null);
    assert.equal(r.picker.startFiles({ pane: '%6', key: KEY, room: 6 }), null);
    await reading;
    assert.equal(r.picker.filesStatus('%6', reqId).state, 'done');
  });

  test('(−) a files message for another request, for a folder request, with no id or a bad id, or a second answer, changes nothing', async () => {
    const r = rig();
    const good = r.put('good.md');
    const reqId = r.picker.startFiles({ pane: '%6', key: KEY, room: 6 });
    for (const msg of [{ type: 'files', reqId: REQ_A, paths: [good] }, { type: 'files', paths: [good] }, { type: 'files', reqId: 5, paths: [good] }, { type: 'files', reqId: null, paths: null }, { type: 'folder', reqId, path: r.dir }]) {
      await (msg.type === 'folder' ? r.picker.onFolder(msg) : r.picker.onFiles(msg));
    }
    assert.deepEqual(r.picker.filesStatus('%6', reqId), { state: 'pending' });
    assert.deepEqual(r.stored(), []);
    await r.picker.onFiles({ type: 'files', reqId, paths: [good] });
    await r.picker.onFiles({ type: 'files', reqId, paths: [r.put('again.md')] }); // a repeat answer
    await r.picker.onFiles({ type: 'files', reqId, paths: null });
    assert.equal(r.picker.filesStatus('%6', reqId).state, 'done');
    assert.equal(r.stored().length, 1);
    // and a files message with no open request at all
    await r.picker.onFiles({ type: 'files', reqId, paths: [good] });
    assert.equal(r.stored().length, 1);
    // a folder request is not answered by a files message
    const folder = r.picker.start();
    await r.picker.onFiles({ type: 'files', reqId: folder, paths: [good] });
    assert.equal(r.picker.status(folder).state, 'pending');
    assert.equal(r.stored().length, 1);
  });

  test('(+) more paths than room: only the first `room` are read; the rest are never opened', async () => {
    const r = rig();
    const paths = ['a', 'b', 'c', 'd'].map((n) => r.put(`${n}.md`, `text ${n}\n`));
    const { answer } = await r.pick(paths, { room: 2 });
    assert.deepEqual(answer.files.map((f) => f.name), ['a.md', 'b.md']);
    assert.equal(r.stored().length, 2);
    const one = await r.pick(paths, { room: 1 });
    assert.deepEqual(one.answer.files.map((f) => f.name), ['a.md']);
    const six = await r.pick([...paths, ...paths, ...paths], { room: 6 });
    assert.equal(six.answer.files.length, 6);
  });

  // ---- an entry that cannot be read fails alone ----

  test('(−) each unusable entry fails on its own and the good file next to it is still saved', async () => {
    const r = rig();
    const good = r.put('good.md', 'fine\n');
    const target = r.put('target.txt', 'real\n');
    const link = path.join(r.dir, 'link.txt');
    fs.symlinkSync(target, link);
    const folder = path.join(r.dir, 'folder.txt');
    fs.mkdirSync(folder);
    const fifo = path.join(r.dir, 'fifo.txt');
    execFileSync('mkfifo', [fifo]);
    const hardA = r.put('hard-a.txt', 'shared\n');
    const hardB = path.join(r.dir, 'hard-b.txt');
    fs.linkSync(hardA, hardB);
    const huge = path.join(r.dir, 'huge.txt');
    fs.writeFileSync(huge, 'a');
    fs.truncateSync(huge, 9 * MIB);
    const cases = [
      ['relative/dir/file.txt', 'invalid'], ['', 'invalid'], [`${r.dir}/with\0nul.txt`, 'invalid'], [`/${'a'.repeat(5000)}`, 'invalid'],
      [42, 'invalid'], [null, 'invalid'], [{ a: 1 }, 'invalid'], [['/x'], 'invalid'],
      [link, 'unreadable'], [folder, 'unreadable'], [fifo, 'unreadable'], [hardA, 'unreadable'], [hardB, 'unreadable'], [path.join(r.dir, 'missing.txt'), 'unreadable'],
      [huge, 'too_large'],
    ];
    for (const [bad, code] of cases) {
      const label = JSON.stringify(bad).slice(0, 40);
      const { answer } = await r.pick([bad, good], { room: 2 });
      assert.equal(answer.state, 'done', label);
      const [f, g] = answer.files;
      assert.deepEqual([f.ok, f.error], [false, code], label);
      assert.deepEqual(Object.keys(f).sort(), ['error', 'name', 'ok'], label);
      assert.equal(g.ok, true, `the next file still went: ${label}`);
      assert.equal(g.name, 'good.md');
      assert.ok(!JSON.stringify(f).includes(dirRoot), 'no path in a failed entry');
    }
    assert.equal(r.stored().length, cases.length, 'only the good file of each pick was stored');
    assert.equal(fs.readFileSync(target, 'utf8'), 'real\n', 'the link target was not touched');
  });

  test('(−) a failed entry is named by the last part of the path only, a non-string by a placeholder; control characters never reach the answer', async () => {
    const r = rig();
    const { answer } = await r.pick([`${r.dir}/missing\u202e\u0007name.txt`, 'rel/sub/x.md', 7], { room: 3 });
    assert.deepEqual(answer.files.map((f) => f.name), ['missing name.txt', 'x.md', 'file']);
    assert.ok(!JSON.stringify(answer).includes(dirRoot));
  });

  test('(−) an empty file and a file of the wrong type are refused by the store, with the store\'s own codes', async () => {
    const r = rig();
    const empty = r.put('empty.txt', '');
    const bin = r.put('tool.bin', Buffer.from([0x4d, 0x5a, 0, 1, 2, 3]));
    const { answer } = await r.pick([empty, bin], { room: 2 });
    assert.deepEqual(answer.files.map((f) => [f.ok, f.error]), [[false, 'empty'], [false, 'wrong-type']]);
    assert.deepEqual(r.stored(), []);
  });

  // M4 (security review 0.5): rule 4 says nika never reads .env or *.key files. The chooser refuses by name, before the file is opened.
  test('(−) a picked .env, .env.*, *.key or *.pem file (any case) is refused as secret-file before it is opened: nothing stored, no path in the entry', async () => {
    const r = rig();
    const good = r.put('good.md', 'fine\n');
    const names = ['.env', '.ENV', '.env.dev', '.Env.Production', 'server.key', 'SERVER.KEY', 'cert.pem', 'Cert.PEM'];
    for (const name of names) {
      const secret = r.put(name, 'TOKEN=synthetic\n');
      const { answer } = await r.pick([secret, good], { room: 2 });
      const [f, g] = answer.files;
      assert.deepEqual([f.ok, f.error, f.name], [false, 'secret-file', name], name);
      assert.deepEqual(Object.keys(f).sort(), ['error', 'name', 'ok'], name);
      assert.equal(g.ok, true, `the next file still went: ${name}`);
      assert.ok(!JSON.stringify(answer).includes(dirRoot), 'no path in the answer');
    }
    assert.equal(r.stored().length, names.length, 'only the good file of each pick was stored');
    assert.deepEqual(r.logs, []);
  });

  // F3 (owner answer 2026-11-15): .envrc, the keystores and the SSH private keys are refused the same way. The picked path is absolute, so a directory is always in front.
  test('(−) F3: a picked .envrc, *.p12, *.pfx, *.jks, *.keystore or SSH private key (any case) is refused as secret-file before it is opened: nothing stored, no path in the entry', async () => {
    const r = rig();
    const good = r.put('good.md', 'fine\n');
    const kinds = ['.envrc', '.envrc.dev', '.envrc.bak', '.envrc.', 'cert.p12', 'cert.pfx', 'store.jks', 'app.keystore', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk'];
    for (const kind of kinds) { // one pick per kind (the store admits 30 saves a minute): three spellings, then one good file
      const names = [kind, kind.toUpperCase(), [...kind].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('')];
      const { answer } = await r.pick([...names.map((n) => r.put(n, 'synthetic\n')), good], { room: 4 });
      const refused = answer.files.slice(0, 3);
      assert.deepEqual(refused.map((f) => [f.ok, f.error, f.name]), names.map((n) => [false, 'secret-file', n]), kind);
      for (const f of refused) assert.deepEqual(Object.keys(f).sort(), ['error', 'name', 'ok'], kind);
      assert.equal(answer.files[3].ok, true, `the next file still went: ${kind}`);
      assert.ok(!JSON.stringify(answer).includes(dirRoot), 'no path in the answer');
    }
    assert.equal(r.stored().length, kinds.length, 'only the good file of each pick was stored');
    assert.deepEqual(r.logs, []);
  });

  test('(−) F3: the name decides before any open for the new kinds too: a FIFO or a dangling link named id_rsa, *.p12 or .envrc answers secret-file, not unreadable', async () => {
    const r = rig();
    const fifo = path.join(r.dir, 'store.p12');
    execFileSync('mkfifo', [fifo]);
    const dangling = path.join(r.dir, 'id_ed25519');
    fs.symlinkSync(path.join(r.dir, 'nowhere'), dangling);
    const envrc = path.join(r.dir, '.envrc');
    fs.symlinkSync(path.join(r.dir, 'nowhere'), envrc);
    const envrcLocal = path.join(r.dir, '.envrc.dev'); // fix round 1: .envrc.* is refused by name too
    fs.symlinkSync(path.join(r.dir, 'nowhere'), envrcLocal);
    const plainFifo = path.join(r.dir, 'id_ed25519.pub');
    execFileSync('mkfifo', [plainFifo]);
    const { answer } = await r.pick([fifo, dangling, envrc, envrcLocal, plainFifo], { room: 5 });
    assert.deepEqual(answer.files.map((f) => f.error), ['secret-file', 'secret-file', 'secret-file', 'secret-file', 'unreadable'], 'a public key still goes through the open and fails there');
  });

  test('(+) fix round 1: envrc.dev, my.envrc.dev, .envrcx and .envrc-old are picked as before (only .envrc and .envrc.* are refused)', async () => {
    const r = rig();
    const paths = ['envrc.dev', 'my.envrc.dev', '.envrcx', '.envrc-old'].map((n) => r.put(n, `${n}\n`));
    const { answer } = await r.pick(paths, { room: 4 });
    assert.deepEqual(answer.files.map((f) => f.ok), [true, true, true, true]);
  });

  test('(+) F3: a public key and the look-alikes of the new kinds are picked as before: id_rsa.pub, id_ed25519.pub, id_rsa_backup.txt, my.keystore.md, notes.envrc.txt, p12.txt', async () => {
    const r = rig();
    const paths = ['id_rsa.pub', 'id_ed25519.pub', 'id_rsa_backup.txt', 'my.keystore.md', 'notes.envrc.txt', 'p12.txt'].map((n) => r.put(n, `${n}\n`));
    const { answer } = await r.pick(paths, { room: 6 });
    assert.deepEqual(answer.files.map((f) => f.ok), [true, true, true, true, true, true]);
  });

  test('(−) the name decides before any open: a FIFO or a dangling link named .env or *.key answers secret-file, not unreadable', async () => {
    const r = rig();
    const fifo = path.join(r.dir, 'token.key');
    execFileSync('mkfifo', [fifo]);
    const dangling = path.join(r.dir, '.env');
    fs.symlinkSync(path.join(r.dir, 'nowhere'), dangling);
    const plainFifo = path.join(r.dir, 'token.txt');
    execFileSync('mkfifo', [plainFifo]);
    const { answer } = await r.pick([fifo, dangling, plainFifo], { room: 3 });
    assert.deepEqual(answer.files.map((f) => f.error), ['secret-file', 'secret-file', 'unreadable'], 'a non-secret name still goes through the open and fails there');
  });

  test('(+) names that only look similar are picked as before: env.txt, notes.key.txt, monkey.md, .environment', async () => {
    const r = rig();
    const paths = ['env.txt', 'notes.key.txt', 'monkey.md', '.environment', 'keys.md'].map((n) => r.put(n, `${n}\n`));
    const { answer } = await r.pick(paths, { room: 5 });
    assert.deepEqual(answer.files.map((f) => f.ok), [true, true, true, true, true]);
  });

  test('(+) a file of exactly 8 MiB is accepted; one byte more is too_large and is not read', async () => {
    const r = rig();
    const ok = path.join(r.dir, 'edge.txt');
    fs.writeFileSync(ok, Buffer.alloc(MAX_BYTES, 0x61));
    const over = path.join(r.dir, 'over.txt');
    fs.writeFileSync(over, Buffer.alloc(MAX_BYTES + 1, 0x61));
    const { answer } = await r.pick([ok, over], { room: 2 });
    assert.deepEqual(answer.files.map((f) => [f.ok, f.size ?? f.error]), [[true, MAX_BYTES], [false, 'too_large']]);
  });

  test('(−) a file that grows after it was opened is read only up to the size it had (never more than the cap)', async () => {
    const r = rig();
    const p = r.put('grow.txt', 'abc');
    const orig = fs.promises.open;
    let wrapped = 0;
    fs.promises.open = async (...a) => { // appends between the fstat and the read
      const h = await orig(...a);
      if (String(a[0]) === p) {
        const stat = h.stat.bind(h);
        h.stat = async (...x) => {
          const st = await stat(...x);
          fs.appendFileSync(p, 'MORE');
          return st;
        };
        wrapped += 1;
      }
      return h;
    };
    try {
      const { answer } = await r.pick([p], { room: 1 });
      assert.deepEqual([answer.files[0].ok, answer.files[0].size], [true, 3]);
      assert.equal(wrapped, 1, 'the seam really ran');
    } finally {
      fs.promises.open = orig;
    }
  });

  test('(−) a file of another owner is refused (needs root to make one)', { skip: uid !== 0 && 'chown needs root' }, async () => {
    const r = rig();
    const p = r.put('theirs.txt', 'x\n');
    fs.chownSync(p, 12345, 12345);
    const { answer } = await r.pick([p], { room: 1 });
    assert.deepEqual([answer.files[0].ok, answer.files[0].error], [false, 'unreadable']);
  });

  test('(−) nothing logged and nothing sent to the shell carries a path or a name; a store that throws is one entry that failed', async () => {
    const r = rig();
    const named = r.put('very-private-name.md', 'x\n');
    const { answer } = await r.pick([named, path.join(r.dir, 'missing-private.md'), 'rel/private-rel.md'], { room: 3 });
    assert.equal(answer.files.length, 3);
    const seen = JSON.stringify([r.logs, r.sent]);
    for (const needle of [dirRoot, 'private']) assert.equal(seen.includes(needle), false, needle);
    const boom = createPicker({ send: () => {}, env: r.env, attachments: { saveBytes: async () => { throw Object.assign(new Error(`EACCES ${named}`), { code: 'EACCES' }); } } });
    const reqId = boom.startFiles({ pane: '%6', key: KEY, room: 1 });
    await boom.onFiles({ type: 'files', reqId, paths: [named] });
    const f = boom.filesStatus('%6', reqId).files[0];
    assert.deepEqual([f.ok, f.error], [false, 'write-failed']);
    assert.equal(JSON.stringify(f).includes(dirRoot), false);
  });

  test('(+) a pick answers the same GET again and again (the page may ask twice) and a new request replaces the old one', async () => {
    const r = rig();
    const { reqId, answer } = await r.pick([r.put('a.md')]);
    assert.deepEqual(r.picker.filesStatus('%6', reqId), answer);
    const next = r.picker.startFiles({ pane: '%6', key: KEY, room: 1 });
    assert.equal(r.picker.filesStatus('%6', reqId), null);
    assert.deepEqual(r.picker.filesStatus('%6', next), { state: 'pending' });
  });

  // ---- through the real server ----

  test('(+) end to end: POST pick, the pick-files line, a files message, GET until done; the route answers carry ids and names, no path', async () => {
    const h = harness({ state: path.join(dirRoot, 'e2e-state') });
    await h.up();
    const dir = path.join(dirRoot, `e2e-${counter}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'e2e-note.md');
    fs.writeFileSync(file, '# note\n');
    const start = await h.call('POST', '/api/app/pane/%256/attachments/pick', { json: { room: 2 } });
    assert.equal(start.status, 202, JSON.stringify(start.body));
    const { reqId } = start.body;
    assert.deepEqual(await h.waitFor((l) => l.type === 'pick-files'), { type: 'pick-files', reqId });
    assert.deepEqual((await h.call('GET', `/api/app/pane/%256/attachments/pick/${reqId}`)).body, { state: 'pending' });
    assert.equal((await h.call('POST', '/api/app/projects/pick', { json: {} })).status, 429, 'a folder chooser is busy while files are open');
    assert.equal((await h.call('POST', '/api/app/pane/%256/attachments/pick', { json: { room: 1 } })).status, 429);
    h.send(JSON.stringify({ type: 'files', reqId, paths: [file] }));
    let r;
    for (let i = 0; i < 100; i += 1) {
      r = await h.call('GET', `/api/app/pane/%256/attachments/pick/${reqId}`);
      if (r.body.state !== 'pending') break;
      await sleep(10);
    }
    assert.equal(r.status, 200);
    assert.equal(r.body.state, 'done');
    assert.deepEqual(r.body.files.map((f) => [f.ok, f.name, f.type, f.size]), [[true, 'e2e-note.md', 'text', 7]]);
    assert.equal(JSON.stringify(r.body).includes(dir), false, 'no path in the answer');
    assert.equal(h.err().includes('e2e-note'), false, 'no name on stderr');
    assert.equal(h.err().includes(dir), false, 'no path on stderr');
    h.noSecret();
    await h.close();
  });

  test('(−) a files line with no open request, or a bad one, is ignored by the running server; stdin stays usable', async () => {
    const h = harness();
    await h.up();
    h.send(JSON.stringify({ type: 'files', reqId: REQ_A, paths: ['/x'] }));
    h.send(JSON.stringify({ type: 'files', paths: null }));
    h.send('{"type":"files","reqId":');
    await sleep(40);
    const start = await h.call('POST', '/api/app/pane/%256/attachments/pick', { json: { room: 1 } });
    assert.equal(start.status, 202);
    assert.equal(h.err().includes('/x'), false);
    await h.close();
  });

  test('(+) the running server routes a files message to the picker, and builds the picker with the same attachment store the routes use', () => {
    const src = fs.readFileSync(new URL('../src/appio.js', import.meta.url), 'utf8');
    assert.match(src, /if \(msg\.type === 'files'\) picker\.onFiles\(msg\);/);
    assert.match(src, /createPicker\(\{ send: say, env, attachments \}\)/);
    assert.ok(src.indexOf('attachments = createAttachments(') < src.indexOf('createPicker({ send: say'), 'the store exists before the picker takes it');
  });
});

describe('shutdown and secrecy', () => {
  test('(+) stdin closing shuts the server down and resolves with 0; the port stops answering', async () => {
    const h = harness();
    await h.up();
    assert.equal((await h.call('GET', '/api/app/me')).status, 200);
    h.stdin.end();
    assert.equal(await h.done, 0);
    await assert.rejects(h.call('GET', '/api/app/me'), { code: 'ECONNREFUSED' });
  });

  test('(+) stdin closing right after the hello, before the server is up, still ends cleanly', async () => {
    const h = harness();
    h.send(hello());
    h.stdin.end();
    assert.equal(await h.done, 0);
  });

  test('(−) the secret appears nowhere on stdout or stderr across a whole session, including refused requests', async () => {
    const h = harness({ secret: OTHER, intervalMs: 20 });
    await h.up();
    await h.call('GET', '/api/app/me');
    await h.call('GET', '/api/app/me', { headers: { 'x-nika-app': SECRET } });
    await h.call('GET', '/api/app/me', { headers: { 'x-nika-app': null } });
    await h.call('POST', '/api/app/rules/preview', { json: { project: 'nope' } });
    await h.call('PUT', '/api/app/settings', { body: `{"secret":"${OTHER}"` });
    const { reqId } = (await h.call('POST', '/api/app/projects/pick', { json: {} })).body;
    h.send(JSON.stringify({ type: 'folder', reqId, path: `relative-${OTHER}` }));
    h.send(`{"type":"hello","proto":1,"secret":"${OTHER}"`);
    await sleep(80);
    await h.close();
    h.noSecret(OTHER);
    assert.equal(h.out().includes(OTHER.slice(0, 20)), false);
  });

  test('(+) as a real process: ready line, then exit 0 on its own when stdin closes (the status timer does not keep it alive)', async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const script = `
      import { serveApp } from ${JSON.stringify(path.join(root, 'src', 'appio.js'))};
      import { defaultConfig } from ${JSON.stringify(path.join(root, 'src', 'config.js'))};
      const code = await serveApp({ config: defaultConfig(process.env), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
      process.exitCode = code;
    `;
    const base = path.join(ROOT, 'child');
    fs.mkdirSync(base, { recursive: true });
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NIKA_CONFIG_DIR: path.join(base, 'cfg'), XDG_STATE_HOME: path.join(base, 'state'), CLAUDE_CONFIG_DIR: fx.claudeDir, NIKA_TMP_ROOT: fx.tmpRoot, NIKA_TMUX: '/nonexistent/tmux', NIKA_CLAUDE: '/nonexistent/claude' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.stdin.write(hello());
    for (let i = 0; i < 200 && !out.includes('"ready"'); i += 1) await sleep(25);
    assert.match(out, /^\{"type":"ready","proto":1,"port":\d+,"version":"[^"]+"\}/);
    child.stdin.end();
    const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const r = await exited;
    clearTimeout(killer);
    assert.deepEqual(r, { code: 0, signal: null }, err);
    assert.equal(out.includes(SECRET) || err.includes(SECRET), false);
  });
});

// --- the fit (0.5, W7): recovery before ready, release at quit ---------------------------------------------------------------

const NONCE = '0123456789abcdef';
const FIT_FORMAT = ['#{pane_id}', '#{window_id}', '#{window_panes}', '#{window_zoomed_flag}', '#{pane_active}', '#{window_width}', '#{window_height}', '#{pane_width}', '#{pane_height}', '#{pane_current_command}', '#{@nika-fit}', '#{@nika-role}'].join('\t');

/**
 * A tmux with one single-pane window, @1 (pane %6 running claude, as the synthetic machine has it), that answers the fit's argv shapes
 * and hands everything else to `base`. `st.gate(name)` may return a promise that holds a call; every fit call is recorded in `st.calls`.
 */
function fitTmux(base, { tag = '', w = 100, h = 30 } = {}) {
  const st = { tag, w, h, calls: [], gate: () => undefined };
  const exec = async (cmd, args) => {
    const a = args.slice(1);
    const name = cmd !== 'tmux' || args[0] !== '-u' ? null
      : a[0] === 'list-panes' && a[3] === FIT_FORMAT ? 'list'
        : a[0] === 'show-options' ? 'option'
          : a[0] === 'display-message' && a[5] === '#{window_layout}' ? 'layout'
            : a[0] === 'set-option' && a.includes('@nika-fit') ? (a[1] === '-wu' ? 'untag' : 'tag')
              : a[0] === 'set-option' && a[1] === '-wu' ? 'optUnset'
                : a[0] === 'resize-window' ? 'size'
                  : a[0] === 'select-layout' ? 'select'
                    : null;
    if (!name) return base(cmd, args);
    st.calls.push(name);
    const held = st.gate(name);
    if (held) await held;
    switch (name) {
      case 'list': return { stdout: `%6\t@1\t1\t0\t1\t${st.w}\t${st.h}\t${st.w}\t${st.h}\tclaude\t${st.tag}\t\n`, stderr: '' };
      case 'layout': return { stdout: `{"w":${st.w},"h":${st.h}}\n`, stderr: '' };
      case 'tag': st.tag = a[5]; return { stdout: '', stderr: '' };
      case 'untag': st.tag = ''; return { stdout: '', stderr: '' };
      case 'size': st.w = Number(a[4]); st.h = Number(a[6]); return { stdout: '', stderr: '' };
      case 'select': { const L = JSON.parse(a[4]); st.w = L.w; st.h = L.h; return { stdout: '', stderr: '' }; }
      default: return { stdout: '', stderr: '' };
    }
  };
  exec.st = st;
  return exec;
}
const fitDirOf = (h) => path.join(h.base, 'state', 'nika', 'fit');
/** The lease file of a fit that was cut short at 120 x 40 (the window was 100 x 30 before). */
const leaseFile = (over = {}) => ({
  v: 1, nonce: NONCE, window: '@1', pane: '%6', panes: 1, zoomed0: 0, active0: '%6', width0: 100, height0: 30, size0: null,
  layout0: '{"w":100,"h":30}', layout1: '{"w":120,"h":40}', cols: 120, rows: 40, resized: true, userZoom: false, at: 1, ...over,
});
function plant(h, content = leaseFile(), name = `fit-${NONCE}.json`) {
  fs.mkdirSync(fitDirOf(h), { recursive: true, mode: 0o700 });
  fs.chmodSync(fitDirOf(h), 0o700);
  fs.writeFileSync(path.join(fitDirOf(h), name), typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
}
const filesOf = (h) => (fs.existsSync(fitDirOf(h)) ? fs.readdirSync(fitDirOf(h)).sort() : []);
const FIT_PUT = { json: { cols: 120, rows: 40, open: true } };

describe('the fit: recover() at start, releaseAll() at finish (design W7 section 6)', () => {
  test('(+) start() restores the window a crash left (lease file, tag still ours) and only then says ready; the file is gone', async () => {
    const tmux = fitTmux(fakeExec(), { tag: NONCE, w: 120, h: 40 });
    let gate;
    const gated = new Promise((res) => { gate = res; });
    tmux.st.gate = (name) => (name === 'size' ? gated : undefined);
    const h = harness({ exec: tmux });
    plant(h);
    h.send(hello());
    await sleep(150);
    assert.deepEqual(tmux.st.calls.slice(0, 3), ['list', 'layout', 'size'], 'the restore began');
    assert.equal(h.lines().some((l) => l.type === 'ready'), false, 'no ready while the restore runs');
    gate();
    const ready = await h.waitFor((l) => l.type === 'ready');
    h.port = ready.port;
    assert.deepEqual([tmux.st.w, tmux.st.h, tmux.st.tag], [100, 30, ''], 'the window is as before when ready is sent');
    assert.deepEqual(filesOf(h), []);
    assert.equal((await h.call('GET', '/api/app/me')).status, 200);
    await h.close();
  });

  test('(+) a lease file for a window tmux no longer has (a restarted server) is dropped without a tmux change; ready follows', async () => {
    const tmux = fitTmux(fakeExec(), { tag: '', w: 100, h: 30 }); // the tag is not ours: this is another window
    const h = harness({ exec: tmux });
    plant(h);
    await h.up();
    assert.deepEqual(tmux.st.calls, ['list']);
    assert.deepEqual([tmux.st.w, tmux.st.h], [100, 30]);
    assert.deepEqual(filesOf(h), []);
    await h.close();
  });

  test('(−) a hung tmux cannot hold ready back past the bound; the file stays for the next start', async () => {
    const tmux = fitTmux(fakeExec(), { tag: NONCE, w: 120, h: 40 });
    tmux.st.gate = (name) => (name === 'list' ? new Promise(() => {}) : undefined);
    const h = harness({ exec: tmux, releaseMs: 120 });
    plant(h);
    const t0 = Date.now();
    await h.up();
    assert.ok(Date.now() - t0 < 2000, `ready came after ${Date.now() - t0} ms`);
    assert.deepEqual(filesOf(h), [`fit-${NONCE}.json`]);
    tmux.st.gate = () => undefined;
    await h.close();
  });

  test('(+) no fit folder, no tmux call at start', async () => {
    const tmux = fitTmux(fakeExec());
    const h = harness({ exec: tmux });
    await h.up();
    assert.deepEqual(tmux.st.calls, []);
    await h.close();
  });

  test('(−) a lease file that is not a plain valid file does not stop the start: it is unlinked (invalid) or left alone (a link)', async () => {
    const tmux = fitTmux(fakeExec());
    const h = harness({ exec: tmux });
    plant(h, '{not json');
    const outside = path.join(h.base, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(leaseFile()));
    fs.symlinkSync(outside, path.join(fitDirOf(h), 'fit-aaaaaaaaaaaaaaaa.json'));
    await h.up();
    assert.deepEqual(filesOf(h), ['fit-aaaaaaaaaaaaaaaa.json']);
    assert.ok(fs.existsSync(outside));
    assert.deepEqual(tmux.st.calls, []);
    await h.close();
  });

  test('(+) finish() gives every held window back before the exit code resolves, and the file goes', async () => {
    const tmux = fitTmux(fakeExec());
    const h = harness({ exec: tmux });
    await h.up();
    const r = await h.call('PUT', '/api/app/pane/%256/fit', FIT_PUT);
    assert.deepEqual([r.status, r.body.fit.state, r.body.fit.pane], [200, 'fitted', { cols: 120, rows: 40 }], JSON.stringify(r.body));
    assert.deepEqual([tmux.st.w, tmux.st.h, tmux.st.tag === ''], [120, 40, false]);
    assert.equal(filesOf(h).length, 1);
    let gate;
    const gated = new Promise((res) => { gate = res; });
    tmux.st.gate = (name) => (name === 'size' ? gated : undefined);
    let code = null;
    h.done.then((c) => { code = c; });
    h.stdin.end();
    await sleep(150);
    assert.equal(code, null, 'the exit code waits for the restore');
    gate();
    assert.equal(await h.done, 0);
    assert.deepEqual([tmux.st.w, tmux.st.h, tmux.st.tag], [100, 30, ''], 'the window is back at its size, untagged');
    assert.deepEqual(filesOf(h), []);
  });

  test('(+) a quit with no lease runs no tmux call', async () => {
    const quiet = fitTmux(fakeExec());
    const q = harness({ exec: quiet });
    await q.up();
    await q.close();
    assert.deepEqual(quiet.st.calls, []);
  });

  test('(−) a hung tmux cannot hold the exit back past the bound: finish still resolves 0; the file stays for the next start', async () => {
    const tmux = fitTmux(fakeExec());
    const h = harness({ exec: tmux, releaseMs: 150 });
    await h.up();
    assert.equal((await h.call('PUT', '/api/app/pane/%256/fit', FIT_PUT)).status, 200);
    tmux.st.gate = (name) => (name === 'list' ? new Promise(() => {}) : undefined);
    const t0 = Date.now();
    h.stdin.end();
    assert.equal(await h.done, 0);
    assert.ok(Date.now() - t0 < 2000, `exit came after ${Date.now() - t0} ms`);
    assert.equal(filesOf(h).length, 1, 'the lease file is left for recover() at the next start');
  });

  test('(−) once finish() has begun the server takes no new request, so a late heartbeat cannot fit a window again', async () => {
    const tmux = fitTmux(fakeExec());
    const h = harness({ exec: tmux });
    await h.up();
    assert.equal((await h.call('PUT', '/api/app/pane/%256/fit', FIT_PUT)).status, 200);
    tmux.st.gate = (name) => (name === 'size' ? new Promise((res) => setTimeout(res, 300)) : undefined);
    h.stdin.end();
    await sleep(100);
    await assert.rejects(h.call('PUT', '/api/app/pane/%256/fit', { json: { cols: 130, rows: 45, open: true } }), { code: 'ECONNREFUSED' });
    assert.equal(await h.done, 0);
    assert.deepEqual([tmux.st.w, tmux.st.h, tmux.st.tag], [100, 30, '']);
  });

  test('(+) a start that is cut short while it recovers ends cleanly, with no ready line', async () => {
    const tmux = fitTmux(fakeExec(), { tag: NONCE, w: 120, h: 40 });
    let gate;
    tmux.st.gate = (name) => (name === 'size' ? new Promise((res) => { gate = res; }) : undefined);
    const h = harness({ exec: tmux });
    plant(h);
    h.send(hello());
    await sleep(100);
    h.stdin.end();
    await sleep(50);
    gate?.();
    assert.equal(await h.done, 0);
    assert.equal(h.lines().some((l) => l.type === 'ready'), false);
  });
});

describe('the attachment store: started after ready, stopped at finish (0.5, W2)', () => {
  const KEY = 'a1b2c3d4e5f60718';
  const DAY = 24 * 60 * 60 * 1000;
  /** Plants two synthetic attachment files in the harness's own state dir: one older than the default 7 days, one younger. */
  function plantFiles(h) {
    const root = path.join(h.env.XDG_STATE_HOME, 'nika', 'attachments');
    const dir = path.join(root, KEY);
    fs.mkdirSync(dir, { recursive: true });
    for (const d of [path.join(h.env.XDG_STATE_HOME, 'nika'), root, dir]) fs.chmodSync(d, 0o700);
    const old = path.join(dir, '1111111111111111.png');
    const young = path.join(dir, '2222222222222222.png');
    for (const [file, age] of [[old, 8 * DAY], [young, 1 * DAY]]) {
      fs.writeFileSync(file, 'synthetic', { mode: 0o600 });
      fs.utimesSync(file, (NOW - age) / 1000, (NOW - age) / 1000);
    }
    return { old, young, dir };
  }
  const gone = async (file, ms = 3000) => {
    for (let t = 0; t < ms; t += 20) {
      if (!fs.existsSync(file)) return true;
      await sleep(20);
    }
    return false;
  };
  /** A timer seam that records its calls and never fires. */
  const timerSeam = () => {
    const seam = { set: [], cleared: [] };
    seam.setTimer = (fn, ms) => { const handle = { unref() {} }; seam.set.push([ms, handle]); return handle; };
    seam.clearTimer = (handle) => { seam.cleared.push(handle); };
    return seam;
  };

  test('(+) after the ready line the store prunes: a file older than keepDays is removed, a younger one stays', async () => {
    const h = harness({ attachments: timerSeam() });
    const { old, young } = plantFiles(h);
    await sleep(60);
    assert.deepEqual([fs.existsSync(old), fs.existsSync(young)], [true, true], 'nothing is pruned before the handshake');
    await h.up();
    assert.equal(await gone(old), true, 'the old file was pruned');
    assert.equal(fs.existsSync(young), true);
    await h.close();
    h.noSecret();
  });

  test('(+) one daily timer (24 h) is set after ready, and finish() stops that very timer', async () => {
    const seam = timerSeam();
    const h = harness({ attachments: seam });
    assert.deepEqual(seam.set, [], 'no timer before the hello');
    await h.up();
    assert.equal(seam.set.length, 1);
    assert.equal(seam.set[0][0], DAY);
    assert.deepEqual(seam.cleared, [], 'running: nothing stopped');
    assert.equal(await h.close(), 0);
    assert.equal(seam.cleared.length, 1);
    assert.equal(seam.cleared[0], seam.set[0][1]);
  });

  test('(−) a refused start (a bad hello, or no hello in time) never starts the store: no timer, no pruning', async () => {
    const seam = timerSeam();
    const bad = harness({ attachments: seam });
    const { old } = plantFiles(bad);
    bad.send(hello('x'.repeat(10)));
    assert.equal(await bad.done, 2);
    const late = harness({ attachments: seam, helloMs: 80 });
    assert.equal(await late.done, 2);
    await sleep(60);
    assert.deepEqual(seam.set, []);
    assert.equal(fs.existsSync(old), true);
  });

  test('(−) stdin closing while the server is still starting leaves no timer running', async () => {
    const seam = timerSeam();
    const tmux = fakeExec();
    const h = harness({ attachments: seam, exec: tmux });
    h.send(hello());
    h.stdin.end();
    assert.equal(await h.done, 0);
    assert.equal(seam.set.length, seam.cleared.length, 'every timer that was set was cleared');
    for (const [, handle] of seam.set) assert.ok(seam.cleared.includes(handle));
  });

  test('(+) the store\'s log goes to stderr as `nika: attachments: <code>` lines only: a state dir whose attachments folder is a symlink is refused and the line has no path', async () => {
    const h = harness({ attachments: timerSeam() });
    const target = path.join(h.base, 'elsewhere');
    fs.mkdirSync(target, { recursive: true });
    const stateRoot = path.join(h.env.XDG_STATE_HOME, 'nika');
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    fs.symlinkSync(target, path.join(stateRoot, 'attachments'));
    await h.up();
    for (let t = 0; t < 3000 && !/nika: attachments: /.test(h.err()); t += 20) await sleep(20);
    const lines = h.err().split('\n').filter((l) => l.includes('attachments'));
    assert.ok(lines.length >= 1, `a log line: ${JSON.stringify(h.err())}`);
    for (const l of lines) assert.match(l, /^nika: attachments: [A-Z0-9_]{1,20}$/);
    assert.equal(h.err().includes(h.base), false, 'no path of this machine on stderr');
    await h.close();
  });

  test('(+) the app server serves the attachment routes with this store: a delete of an unknown id is { removed: false } and logs nothing; the routes are on the app tier only (no secret: 403)', async () => {
    const h = harness({ attachments: timerSeam() });
    await h.up();
    const r = await h.call('DELETE', '/api/app/pane/%256/attachments/0123456789abcdef');
    assert.deepEqual([r.status, r.body], [200, { removed: false }]);
    assert.equal((await h.call('DELETE', '/api/app/pane/%256/attachments/0123456789abcdef', { headers: { 'x-nika-app': OTHER } })).status, 403);
    assert.equal(h.err().includes('attachments'), false, 'no store error: the store is really wired in');
    await h.close();
  });
  test('(+) the routes and the store share one log sink (M7): appio builds it once, from its own stderr, and hands it to the store and to the router', () => {
    // No behavioral route test is possible here: the real store answers its refusals itself (a symlinked folder is 409 folder-unsafe)
    // and a route logs only when the store throws, which it does not; api-app.test.js covers the routes with a store that throws.
    const src = fs.readFileSync(new URL('../src/appio.js', import.meta.url), 'utf8');
    assert.equal(src.match(/const attachLog = /g).length, 1, 'one sink');
    assert.match(src, /const attachLog = attachOpts\.log \?\? \(\(line\) => stderr\.write\(`\$\{line\}\\n`\)\);/);
    assert.match(src, /createAttachments\(\{ env, now, \.\.\.attachOpts, log: attachLog \}\)/);
    assert.match(src, /^\s+log: attachLog,$/m, 'deps.log of the router');
    assert.doesNotMatch(src, /process\.stderr/);
  });

  test('(+) the store\'s own lines still reach the given sink (the `attachments` seam), and stderr gets none of them', async () => {
    const lines = [];
    const h = harness({ attachments: { ...timerSeam(), log: (line) => lines.push(line) } });
    const target = path.join(h.base, 'elsewhere');
    fs.mkdirSync(target, { recursive: true });
    const stateRoot = path.join(h.env.XDG_STATE_HOME, 'nika');
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    fs.symlinkSync(target, path.join(stateRoot, 'attachments'));
    try {
      await h.up();
      for (let t = 0; t < 3000 && lines.length === 0; t += 20) await sleep(20);
      assert.ok(lines.length >= 1);
      for (const l of lines) assert.match(l, /^nika: attachments: [A-Z0-9_]{1,20}$/);
      assert.equal(h.err().includes('attachments'), false);
    } finally {
      await h.close();
    }
  });
});
