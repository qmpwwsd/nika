// serveApp: the stdio handshake, status feed, folder picker relay and shutdown, with PassThrough streams (plus one real
// child process for the exit behaviour). Synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serveApp, createPicker, statusLine } from '../src/appio.js';
import { loadConfig } from '../src/store.js';
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
function harness({ tty = false, helloMs = 2000, intervalMs = 60_000, secret = SECRET, appCopy } = {}) {
  counter += 1;
  const base = path.join(ROOT, `h${counter}`);
  fs.mkdirSync(path.join(base, 'cfg'), { recursive: true });
  const env = { NIKA_CONFIG_DIR: path.join(base, 'cfg'), XDG_STATE_HOME: path.join(base, 'state'), NIKA_TMUX: 'tmux', NIKA_CLAUDE: '/nonexistent/claude' };
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
  const done = serveApp({ config: fx.config, env, stdin, stdout, stderr, exec: fakeExec(), now: () => NOW, intervalMs, helloMs, appCopy: copy });
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
