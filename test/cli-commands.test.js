// The 0.2 CLI commands, run in process through main(argv, env, io) with injected stdin, cwd, platform, exec, spawn and
// serveApp. Temp dirs and an in-memory tmux only; synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, COMMAND_NAMES } from '../src/cli.js';
import { deniedTools } from '../src/spawn.js';
import { reportsDir } from '../src/paths.js';
import { listProjects, getOrchestrator, setOrchestrator } from '../src/store.js';
import { fakeTmux, makeWorld, TMUX } from './tmux-fake.js';

const APP_ID = 'io.github.qmpwwsd.nika';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const NIKA_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nika');
const PANE_1 = { id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator' };
const OK = { stdout: '', stderr: '' };

const worlds = [];
// The macOS app copy (ADR 0011) must never look at the real ~/Applications or the real Homebrew folders: every call gets an
// empty temp HOME and no fixed Homebrew paths unless a test passes its own.
const COPY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-cli-home-'));
after(() => {
  worlds.forEach((w) => w.cleanup());
  fs.rmSync(COPY_HOME, { recursive: true, force: true });
});

/** A temp world (config dir, state dir, project "My App") plus a fake claude executable and a ready-made env. */
async function world(settings, extraEnv = {}) {
  const w = await makeWorld(settings);
  worlds.push(w);
  fs.mkdirSync(path.join(w.root, 'bin'));
  w.claude = path.join(w.root, 'bin', 'claude');
  fs.writeFileSync(w.claude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  w.cliEnv = { ...w.env, PATH: '', CLAUDE_CONFIG_DIR: path.join(w.root, 'claude'), NIKA_TMUX: TMUX, NIKA_CLAUDE: w.claude, NO_COLOR: '1', ...extraEnv };
  w.nested = path.join(w.project.dir, 'sub', 'deep');
  fs.mkdirSync(w.nested, { recursive: true });
  return w;
}

class Sink extends Writable {
  constructor(isTTY = false) {
    super();
    this.isTTY = isTTY;
    this.text = '';
  }

  _write(chunk, enc, cb) {
    this.text += chunk;
    cb();
  }
}
const input = (text = '', isTTY = false) => Object.assign(Readable.from(text ? [text] : []), { isTTY });

/** main() with captured output. `tty` makes stdout a terminal; `stdin` defaults to an empty pipe. */
async function cli(argv, { env, cwd, stdin, tty = false, ...io } = {}) {
  const out = new Sink(tty);
  const err = new Sink();
  const code = await main(argv, env, { out, err, in: stdin ?? input(), cwd, home: COPY_HOME, brewApps: [], ...io });
  return { code, out: out.text, err: err.text };
}

/** exec double: handlers[cmd](args) answers; any other command fails like a missing binary. */
function execLog(handlers = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (handlers[cmd]) return handlers[cmd](args, cmd);
    throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
  };
  fn.calls = calls;
  return fn;
}

/** spawn double: a child that starts, then exits with `code`. */
function spawnLog(code = 0) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    setImmediate(() => {
      child.emit('spawn');
      child.emit('exit', code, null);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

/** Fake tmux server behind an execLog; `switch-client` and `attach-session` are answered here, the rest by the fake. */
function tmuxExec(panes = [PANE_1], opts = {}) {
  const tmux = fakeTmux({ panes, ...opts });
  const exec = execLog({ [TMUX]: (args, cmd) => (args[1] === 'switch-client' ? OK : tmux(cmd, args)) });
  exec.tmux = tmux;
  return exec;
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function healthServer() {
  const srv = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

describe('help', () => {
  test('(+) lists every public command and hides _run-agent', async () => {
    const r = await cli(['help'], { env: {} });
    assert.equal(r.code, 0);
    for (const c of ['open', 'app', 'serve', 'status', 'projects list', 'projects add', 'projects remove', 'rules preview', 'rules apply', 'spawn', 'orchestrate', 'doctor', '--version']) {
      assert.ok(r.out.includes(c), `help mentions ${c}`);
    }
    assert.ok(!r.out.includes('_run-agent'));
  });
});

describe('open and app', () => {
  test('(+) no arguments open the app (macOS: open -b <bundle id>) and leave the browser alone', async () => {
    const exec = execLog({ open: () => OK });
    const r = await cli([], { env: {}, platform: 'darwin', exec });
    assert.equal(r.code, 0);
    assert.deepEqual(exec.calls, [['open', '-b', APP_ID]]);
    assert.match(r.out, /opened the nika app/);
  });

  test('(+) the default falls back to the browser dashboard when the app lookup fails', async () => {
    const srv = await healthServer();
    try {
      const exec = execLog({ open: (args) => (args[0] === '-b' ? Promise.reject(new Error('exit 1')) : OK) });
      const r = await cli([], { env: { NIKA_PORT: String(srv.port) }, platform: 'darwin', exec });
      const url = `http://127.0.0.1:${srv.port}/`;
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(exec.calls, [['open', '-b', APP_ID], ['open', url]]);
      assert.equal(r.out.trim(), url);
    } finally {
      await srv.close();
    }
  });

  test('(−) the browser fallback with no server running exits 1 and says how to start it', async () => {
    const exec = execLog({ open: (args) => (args[0] === '-b' ? Promise.reject(new Error('exit 1')) : OK) });
    const r = await cli(['open'], { env: { NIKA_PORT: String(await freePort()) }, platform: 'darwin', exec });
    assert.equal(r.code, 1);
    assert.match(r.err, /not running/);
    assert.match(r.err, /brew services start nika/);
  });

  test('(+) open --browser skips the app lookup', async () => {
    const srv = await healthServer();
    try {
      const exec = execLog({ open: () => OK });
      const r = await cli(['open', '--browser'], { env: { NIKA_PORT: String(srv.port) }, platform: 'darwin', exec });
      assert.equal(r.code, 0);
      assert.deepEqual(exec.calls, [['open', `http://127.0.0.1:${srv.port}/`]]);
    } finally {
      await srv.close();
    }
  });

  test('(−) open --app fails with an install hint when the app is missing, and never opens the browser', async () => {
    const exec = execLog({ open: () => Promise.reject(new Error('exit 1')) });
    const r = await cli(['open', '--app'], { env: {}, platform: 'darwin', exec });
    assert.equal(r.code, 1);
    assert.match(r.err, /not installed/);
    assert.match(r.err, /nika open --browser/);
    assert.deepEqual(exec.calls, [['open', '-b', APP_ID]]);
  });

  test('(−) conflicting flags and stray arguments exit 2', async () => {
    assert.equal((await cli(['open', '--app', '--browser'], { env: {} })).code, 2);
    assert.equal((await cli(['open', 'extra'], { env: {} })).code, 2);
    assert.equal((await cli(['open', '--bogus'], { env: {} })).code, 2);
    assert.equal((await cli(['app', 'extra'], { env: {} })).code, 2);
  });

  test('(+) Linux: nika-app on PATH is started detached, without exec', async () => {
    const w = await world();
    const bin = path.join(w.root, 'bin', 'nika-app');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const exec = execLog();
    const spawn = spawnLog();
    const r = await cli(['app'], { env: { PATH: path.join(w.root, 'bin') }, platform: 'linux', exec, spawn });
    assert.equal(r.code, 0, r.err);
    assert.equal(exec.calls.length, 0);
    assert.equal(spawn.calls[0].cmd, bin);
    assert.equal(spawn.calls[0].opts.detached, true);
    assert.equal(spawn.calls[0].opts.shell, false);
    assert.equal(spawn.calls[0].opts.stdio, 'ignore');
  });

  test('(+/−) Linux: without nika-app, gtk-launch decides; a failure means not installed', async () => {
    const yes = execLog({ 'gtk-launch': () => OK });
    assert.equal((await cli(['app'], { env: { PATH: '' }, platform: 'linux', exec: yes })).code, 0);
    assert.deepEqual(yes.calls, [['gtk-launch', APP_ID]]);
    const no = execLog({ 'gtk-launch': () => Promise.reject(new Error('exit 1')) });
    const r = await cli(['app'], { env: { PATH: '' }, platform: 'linux', exec: no });
    assert.equal(r.code, 1);
    assert.match(r.err, /not installed/);
  });
});

// ---- the copy of the app in ~/Applications (ADR 0011) -------------------------------------------------------------------
describe('app install and the managed copy', () => {
  const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const DITTO = '/usr/bin/ditto';
  const plist = (version, id = APP_ID) => `<plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`;
  const bundle = (dir, version, id) => {
    fs.mkdirSync(path.join(dir, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), plist(version, id));
  };
  const versionOf = (dir) => /<string>(\d[^<]*)<\/string>/.exec(fs.readFileSync(path.join(dir, 'Contents', 'Info.plist'), 'utf8').split('CFBundleShortVersionString')[1])?.[1];

  /** A temp HOME, a keg with libexec and nika.app (at `kegVersion`), and exec doubles for ditto, lsregister and open. */
  async function copyWorld(kegVersion = VERSION) {
    const w = await world();
    w.home = path.join(w.root, 'home');
    fs.mkdirSync(w.home);
    w.keg = path.join(w.root, 'keg');
    fs.mkdirSync(path.join(w.keg, 'libexec'), { recursive: true });
    if (kegVersion) bundle(path.join(w.keg, 'nika.app'), kegVersion);
    w.target = path.join(w.home, 'Applications', 'nika.app');
    w.marker = path.join(w.env.XDG_STATE_HOME, 'nika', 'app-copy.json');
    w.io = (over = {}) => ({ env: w.cliEnv, platform: 'darwin', home: w.home, root: path.join(w.keg, 'libexec'), brewApps: [], ...over });
    return w;
  }
  const copyExec = ({ failDitto = false, open } = {}) => execLog({
    [DITTO]: (args) => {
      if (failDitto) return Promise.reject(Object.assign(new Error('ditto failed at /some/private/path'), { code: 1 }));
      fs.cpSync(args[0], args[1], { recursive: true });
      return OK;
    },
    open: open ?? (() => OK),
    [LSREGISTER]: () => OK,
  });
  const managedMarker = (w, version) => {
    fs.mkdirSync(path.dirname(w.marker), { recursive: true });
    fs.writeFileSync(w.marker, JSON.stringify({ managed: true, version, dismissed: false }));
  };

  test('(+) app install prints added, then "already current"; the copy is in the temp HOME, the exec is ditto and lsregister only', async () => {
    const w = await copyWorld('1.2.3');
    const exec = copyExec();
    const r = await cli(['app', 'install'], { ...w.io(), exec });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'added nika 1.2.3 to ~/Applications (find it with Spotlight)\n');
    assert.equal(versionOf(w.target), '1.2.3');
    assert.deepEqual(exec.calls.map((c) => c[0]), [DITTO, LSREGISTER]);
    assert.deepEqual(exec.calls[1], [LSREGISTER, '-f', w.target]);
    const again = await cli(['app', 'install'], { ...w.io(), exec: copyExec() });
    assert.equal(again.code, 0);
    assert.match(again.out, /^already current: nika 1\.2\.3 is in ~\/Applications$/m);
  });

  test('(+) app install over a current copy nika did not make says "already current" and records it as managed', async () => {
    const w = await copyWorld('1.2.3');
    bundle(w.target, '1.2.3');
    const exec = copyExec();
    const r = await cli(['app', 'install'], { ...w.io(), exec });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^already current: nika 1\.2\.3 is in ~\/Applications$/m);
    assert.equal(r.err, '');
    assert.deepEqual(exec.calls, []);
    assert.equal(JSON.parse(fs.readFileSync(w.marker, 'utf8')).managed, true);
  });

  test('(−) a copy that cannot be recorded as managed still succeeds (exit 0) with one stderr line saying nika will not refresh it', async () => {
    const w = await copyWorld('1.2.3');
    fs.mkdirSync(w.env.XDG_STATE_HOME, { recursive: true });
    fs.writeFileSync(path.join(w.env.XDG_STATE_HOME, 'nika'), 'a file where the state dir should be');
    const r = await cli(['app', 'install'], { ...w.io(), exec: copyExec() });
    assert.equal(r.code, 0);
    assert.equal(r.out, 'added nika 1.2.3 to ~/Applications (find it with Spotlight)\n');
    assert.equal(r.err, "nika: could not record the copy as managed; nika won't refresh it\n");
    assert.equal(versionOf(w.target), '1.2.3');
  });

  test('(+) app install prints updated when an older nika is there', async () => {
    const w = await copyWorld('1.2.3');
    bundle(w.target, '1.0.0');
    const r = await cli(['app', 'install'], { ...w.io(), exec: copyExec() });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'updated nika in ~/Applications to 1.2.3 (if nika was open, quit and reopen it)\n');
    assert.equal(versionOf(w.target), '1.2.3');
  });

  test('(−) Linux: exit 1 with the desktop-entry hint, nothing run or written', async () => {
    const w = await copyWorld();
    const exec = copyExec();
    const r = await cli(['app', 'install'], { ...w.io({ platform: 'linux' }), exec });
    assert.equal(r.code, 1);
    assert.match(r.err, /\.deb or AppImage installs the desktop entry/);
    assert.deepEqual(exec.calls, []);
    assert.deepEqual(fs.readdirSync(w.home), []);
  });

  test('(−) no source, a foreign target and a failed copy exit 1 with a fixed reason; no path or OS text is printed', async () => {
    const none = await copyWorld(null);
    const a = await cli(['app', 'install'], { ...none.io(), exec: copyExec() });
    assert.equal(a.code, 1);
    assert.match(a.err, /can't find its own app/);
    assert.match(a.err, /brew reinstall nika/);

    const foreign = await copyWorld();
    fs.mkdirSync(path.dirname(foreign.target));
    fs.chmodSync(path.dirname(foreign.target), 0o755);
    fs.writeFileSync(foreign.target, 'not nika');
    const exec = copyExec();
    const b = await cli(['app', 'install'], { ...foreign.io(), exec });
    assert.equal(b.code, 1);
    assert.match(b.err, /~\/Applications or ~\/Applications\/nika\.app isn't a folder nika can safely replace\. Move it away/);
    assert.deepEqual(exec.calls, []);
    assert.equal(fs.readFileSync(foreign.target, 'utf8'), 'not nika');

    const broken = await copyWorld();
    const c = await cli(['app', 'install'], { ...broken.io(), exec: copyExec({ failDitto: true }) });
    assert.equal(c.code, 1);
    assert.match(c.err, /couldn't copy the app to ~\/Applications/);
    for (const text of [a.err, b.err, c.err]) {
      assert.equal(text.includes(os.tmpdir()), false);
      assert.equal(text.includes('private'), false);
    }
    assert.equal(fs.existsSync(broken.target), false);
  });

  test('(−) usage: app install takes no arguments; unknown subcommands are exit 2', async () => {
    assert.equal((await cli(['app', 'install', 'extra'], { env: {} })).code, 2);
    assert.equal((await cli(['app', 'bogus'], { env: {} })).code, 2);
    assert.equal((await cli(['app', 'install', '--bogus'], { env: {} })).code, 2);
  });

  test('(+) help documents app install', async () => {
    const r = await cli(['help'], { env: {} });
    assert.match(r.out, /app install\s+copy the app into ~\/Applications/);
  });

  test('(+) a managed copy is launched by path: nika, nika open and nika app run open <target>', async () => {
    const w = await copyWorld();
    bundle(w.target, VERSION);
    managedMarker(w, VERSION);
    for (const argv of [[], ['open'], ['app']]) {
      const exec = copyExec();
      const r = await cli(argv, { ...w.io(), exec });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(exec.calls, [['open', w.target]], argv.join(' '));
      assert.match(r.out, /opened the nika app/);
    }
  });

  test('(−) an unmanaged copy (no marker) is launched by bundle id, never by path; open --browser launches nothing', async () => {
    const w = await copyWorld();
    bundle(w.target, VERSION);
    const exec = copyExec();
    assert.equal((await cli([], { ...w.io(), exec })).code, 0);
    assert.deepEqual(exec.calls, [['open', '-b', APP_ID]]);
  });

  test('(−) a managed marker with a foreign target falls back to the bundle id and never runs open on it', async () => {
    const w = await copyWorld();
    managedMarker(w, VERSION);
    fs.mkdirSync(path.dirname(w.target));
    fs.chmodSync(path.dirname(w.target), 0o755);
    fs.writeFileSync(w.target, 'x');
    const exec = copyExec();
    await cli([], { ...w.io(), exec });
    assert.deepEqual(exec.calls, [['open', '-b', APP_ID]]);
  });

  test('(−) a managed copy that open cannot start falls back to the bundle id', async () => {
    const w = await copyWorld();
    bundle(w.target, VERSION);
    managedMarker(w, VERSION);
    const exec = copyExec({ open: (args) => (args[0] === '-b' ? OK : Promise.reject(new Error('exit 1'))) });
    const r = await cli([], { ...w.io(), exec });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(exec.calls, [['open', w.target], ['open', '-b', APP_ID]]);
  });

  /** A brewApps list that counts how often it is read: one appCopyState (or one install) reads it once through findSource. */
  const countedBrew = () => {
    const hits = { n: 0 };
    const brewApps = new Proxy([], { get: (t, p, r) => { if (p === Symbol.iterator) hits.n += 1; return Reflect.get(t, p, r); } });
    return { brewApps, hits };
  };

  test('(+) a launch reads the state of the copy once and reuses it: managed current = 1 read, then open <target>', async () => {
    const w = await copyWorld();
    bundle(w.target, VERSION);
    managedMarker(w, VERSION);
    for (const argv of [[], ['open'], ['app']]) {
      const { brewApps, hits } = countedBrew();
      const exec = copyExec();
      const r = await cli(argv, { ...w.io({ brewApps }), exec });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(exec.calls, [['open', w.target]], argv.join(' '));
      assert.equal(hits.n, 1, `${argv.join(' ') || 'nika'}: one appCopyState read per launch`);
    }
  });

  test('(+) a refresh launch reads once for the state and once inside the install, not a third time to decide what to open', async () => {
    const w = await copyWorld(VERSION);
    bundle(w.target, '0.0.1');
    managedMarker(w, '0.0.1');
    const { brewApps, hits } = countedBrew();
    const exec = copyExec();
    const r = await cli(['app'], { ...w.io({ brewApps }), exec });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(exec.calls.map((c) => c[0]), [DITTO, LSREGISTER, 'open']);
    assert.deepEqual(exec.calls[2], ['open', w.target]);
    assert.equal(hits.n, 2);
  });

  test('(−) the other launch shapes read the state at most once: unmanaged (open -b), a failed refresh (the old copy is opened), --browser and Linux read nothing', async () => {
    const unmanaged = await copyWorld(VERSION);
    bundle(unmanaged.target, VERSION);
    const a = countedBrew();
    const e1 = copyExec();
    await cli([], { ...unmanaged.io({ brewApps: a.brewApps }), exec: e1 });
    assert.deepEqual(e1.calls, [['open', '-b', APP_ID]]);
    assert.equal(a.hits.n, 1);

    const failing = await copyWorld(VERSION);
    bundle(failing.target, '0.0.1');
    managedMarker(failing, '0.0.1');
    const b = countedBrew();
    const e2 = copyExec({ failDitto: true });
    const r2 = await cli(['app'], { ...failing.io({ brewApps: b.brewApps }), exec: e2 });
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(e2.calls.at(-1), ['open', failing.target], 'the old copy is still opened, on the state read before the failed refresh');
    assert.equal(b.hits.n, 2, 'the state once, the install once');

    const browser = await copyWorld(VERSION);
    const c = countedBrew();
    const srv = await healthServer();
    try {
      await cli(['open', '--browser'], { ...browser.io({ brewApps: c.brewApps }), env: { ...browser.cliEnv, NIKA_PORT: String(srv.port) }, exec: copyExec() });
    } finally {
      await srv.close();
    }
    await cli(['app'], { ...browser.io({ brewApps: c.brewApps, platform: 'linux', env: { ...browser.cliEnv, PATH: '' } }), exec: execLog({ 'gtk-launch': () => OK }) });
    assert.equal(c.hits.n, 0);
  });

  test('(+) after brew upgrade a launch command refreshes a managed stale copy, says so, and opens the copy', async () => {
    const w = await copyWorld(VERSION);
    bundle(w.target, '0.0.1');
    managedMarker(w, '0.0.1');
    const exec = copyExec();
    const r = await cli(['app'], { ...w.io(), exec });
    assert.equal(r.code, 0, r.err);
    assert.equal(versionOf(w.target), VERSION);
    assert.deepEqual(exec.calls.map((c) => c[0]), [DITTO, LSREGISTER, 'open']);
    assert.deepEqual(exec.calls[2], ['open', w.target]);
    assert.match(r.out, new RegExp(`^updated the nika app in ~/Applications to ${VERSION.replace(/\./g, '\\.')} \\(if nika was open, quit and reopen it\\)$`, 'm'));
    assert.equal(r.err, '');
    assert.equal(JSON.parse(fs.readFileSync(w.marker, 'utf8')).version, VERSION);
  });

  test('(−) no refresh for an unmanaged copy, for a source that is not this version, or with --browser', async () => {
    const unmanaged = await copyWorld(VERSION);
    bundle(unmanaged.target, '0.0.1');
    const e1 = copyExec();
    await cli([], { ...unmanaged.io(), exec: e1 });
    assert.equal(versionOf(unmanaged.target), '0.0.1');
    assert.deepEqual(e1.calls, [['open', '-b', APP_ID]]);

    const other = await copyWorld('9.9.9');
    bundle(other.target, '0.0.1');
    managedMarker(other, '0.0.1');
    const e2 = copyExec();
    const r2 = await cli([], { ...other.io(), exec: e2 });
    assert.equal(versionOf(other.target), '0.0.1');
    assert.deepEqual(e2.calls, [['open', other.target]]);
    assert.equal(r2.out.includes('updated the nika app'), false);

    const browser = await copyWorld(VERSION);
    bundle(browser.target, '0.0.1');
    managedMarker(browser, '0.0.1');
    const srv = await healthServer();
    try {
      const e3 = copyExec();
      await cli(['open', '--browser'], { ...browser.io(), env: { ...browser.cliEnv, NIKA_PORT: String(srv.port) }, exec: e3 });
      assert.equal(versionOf(browser.target), '0.0.1');
      assert.deepEqual(e3.calls, [['open', `http://127.0.0.1:${srv.port}/`]]);
    } finally {
      await srv.close();
    }
  });

  test('(−) a refresh that fails prints one line on stderr and the launch continues; Linux never refreshes', async () => {
    const w = await copyWorld(VERSION);
    bundle(w.target, '0.0.1');
    managedMarker(w, '0.0.1');
    const exec = copyExec({ failDitto: true });
    const r = await cli(['app'], { ...w.io(), exec });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err.trim().split('\n').length, 1);
    assert.match(r.err, /^nika: could not update the app in ~\/Applications \(copy-failed\)$/m);
    assert.equal(r.err.includes('private'), false);
    assert.equal(versionOf(w.target), '0.0.1');
    assert.deepEqual(exec.calls.at(-1), ['open', w.target], 'the old copy is still opened');

    const linux = execLog({ 'gtk-launch': () => OK });
    await cli(['app'], { ...w.io({ platform: 'linux', env: { ...w.cliEnv, PATH: '' } }), exec: linux });
    assert.deepEqual(linux.calls, [['gtk-launch', APP_ID]]);
  });

  test('(+) doctor shows the copy state on the app row (macOS); (−) nothing extra on Linux or without a source', async () => {
    const w = await copyWorld('1.2.3');
    const doctor = async (over = {}) => (await cli(['doctor'], { ...w.io(over), exec: execLog({ mdfind: () => ({ stdout: 'x\n', stderr: '' }) }) })).out;
    assert.match(await doctor(), /^app\s+installed {2}\(not in ~\/Applications: run nika app install\)$/m);
    bundle(w.target, '1.2.3');
    assert.match(await doctor(), /^app\s+installed {2}\(~\/Applications copy: 1\.2\.3, not managed by nika\)$/m);
    managedMarker(w, '1.2.3');
    assert.match(await doctor(), /^app\s+installed {2}\(~\/Applications copy: 1\.2\.3, managed by nika\)$/m);
    bundle(w.target, '1.0.0');
    assert.match(await doctor(), /^app\s+installed {2}\(~\/Applications copy is 1\.0\.0, 1\.2\.3 is available: run nika app install\)$/m);
    fs.rmSync(w.target, { recursive: true });
    fs.writeFileSync(w.target, 'x');
    assert.match(await doctor(), /^app\s+installed {2}\(~\/Applications or ~\/Applications\/nika\.app isn't a folder nika can safely replace\)$/m);
    assert.match(await doctor({ platform: 'linux' }), /^app\s+not installed$/m);
    fs.rmSync(w.target);
    assert.match(await doctor({ root: path.join(w.root, 'elsewhere') }), /^app\s+installed$/m);
  });
});

describe('serve --app', () => {
  test('(−) a terminal on stdin is refused with exit 2 and the app server never starts', async () => {
    let started = false;
    const r = await cli(['serve', '--app'], { env: {}, stdin: input('', true), serveApp: async () => { started = true; } });
    assert.equal(r.code, 2);
    assert.match(r.err, /pipe on stdin/);
    assert.equal(started, false);
  });

  test('(+) a pipe on stdin hands config, env, stdin and the streams to serveApp', async () => {
    let got;
    const stdin = input();
    const env = { NIKA_PORT: 'not-a-port' }; // the app tier ignores NIKA_PORT
    const r = await cli(['serve', '--app'], { env, stdin, serveApp: async (o) => { got = o; } });
    assert.equal(r.code, 0, r.err);
    assert.equal(got.stdin, stdin);
    assert.equal(got.env, env);
    assert.ok(got.stdout && got.stderr && got.config);
  });

  test('(+) serveApp\'s exit code is passed on: 0 or nothing → 0, 1 and 2 as given', async () => {
    assert.equal((await cli(['serve', '--app'], { env: {}, serveApp: async () => 0 })).code, 0);
    assert.equal((await cli(['serve', '--app'], { env: {}, serveApp: async () => 1 })).code, 1);
    assert.equal((await cli(['serve', '--app'], { env: {}, serveApp: async () => 2 })).code, 2);
  });

  test('(−) a failing serveApp is a runtime error (exit 1); unknown flags and arguments exit 2', async () => {
    const r = await cli(['serve', '--app'], { env: {}, serveApp: async () => { throw new Error('port in use'); } });
    assert.equal(r.code, 1);
    assert.match(r.err, /port in use/);
    assert.equal((await cli(['serve', '--bogus'], { env: {} })).code, 2);
    assert.equal((await cli(['serve', 'extra'], { env: {} })).code, 2);
  });
});

describe('projects', () => {
  test('(+) add, list (key, name, dir, rules state) and remove', async () => {
    const w = await world();
    const other = path.join(w.root, 'other');
    fs.mkdirSync(other);
    const add = await cli(['projects', 'add', other], { env: w.cliEnv });
    assert.equal(add.code, 0, add.err);
    const key = (await listProjects(w.env)).find((p) => p.name === 'other').key;
    const list = await cli(['projects', 'list'], { env: w.cliEnv });
    assert.equal(list.code, 0);
    assert.match(list.out, new RegExp(`${key}\\s+other\\s+none\\s+.*other`));
    assert.match(list.out, new RegExp(`${w.project.key}\\s+My App`));
    const rm = await cli(['projects', 'remove', key], { env: w.cliEnv });
    assert.equal(rm.code, 0, rm.err);
    assert.equal((await listProjects(w.env)).some((p) => p.key === key), false);
    assert.ok(fs.existsSync(other), 'the folder itself is untouched');
  });

  test('(+) a relative dir resolves against the cwd; an empty registry prints a hint', async () => {
    const w = await world();
    assert.equal((await cli(['projects', 'add', 'sub'], { env: w.cliEnv, cwd: w.project.dir })).code, 0);
    assert.ok((await listProjects(w.env)).some((p) => p.dir === fs.realpathSync(path.join(w.project.dir, 'sub'))));
    const empty = await world();
    for (const p of await listProjects(empty.env)) await cli(['projects', 'remove', p.key], { env: empty.cliEnv });
    assert.match((await cli(['projects', 'list'], { env: empty.cliEnv })).out, /nika projects add/);
  });

  test('(−) usage errors exit 2, a missing dir or unknown key exits 3', async () => {
    const w = await world();
    for (const argv of [['projects'], ['projects', 'frob'], ['projects', 'add'], ['projects', 'remove'], ['projects', 'list', 'x'], ['projects', 'remove', 'short']]) {
      assert.equal((await cli(argv, { env: w.cliEnv })).code, 2, argv.join(' '));
    }
    const gone = await cli(['projects', 'add', path.join(w.root, 'missing')], { env: w.cliEnv });
    assert.equal(gone.code, 3);
    assert.match(gone.err, /cannot add/);
    const unknown = await cli(['projects', 'remove', '0000000000000000'], { env: w.cliEnv });
    assert.equal(unknown.code, 3);
  });
});

describe('rules', () => {
  test('(+) preview from a nested cwd finds the project and prints a diff per file', async () => {
    const w = await world();
    const r = await cli(['rules', 'preview'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^My App\s/);
    assert.match(r.out, /^rules\/orchestration\.md \(create\)$/m);
    assert.match(r.out, /^CLAUDE\.md \(create\)$/m);
    assert.match(r.out, /^\+@rules\/orchestration\.md$/m);
    assert.equal(fs.existsSync(path.join(w.project.dir, 'rules')), false, 'preview writes nothing');
  });

  test('(+) preview marks the .gitignore entry as opt-in and warns when settings.local.json is not ignored', async () => {
    const w = await world();
    fs.mkdirSync(path.join(w.project.dir, '.claude'));
    fs.writeFileSync(path.join(w.project.dir, '.claude', 'settings.local.json'), '{"theme":"dark"}\n');
    const r = await cli(['rules', 'preview'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^\.gitignore \(create, only with --gitignore\)$/m);
    assert.match(r.out, /^warning: settings\.local\.json is not gitignored$/m);
  });

  test('(+) preview takes an explicit dir', async () => {
    const w = await world();
    const r = await cli(['rules', 'preview', w.project.dir], { env: w.cliEnv, cwd: w.root });
    assert.equal(r.code, 0, r.err);
  });

  test('(−) a cwd outside every project, an unknown dir and a bad subcommand are refused or rejected', async () => {
    const w = await world();
    const outside = await cli(['rules', 'preview'], { env: w.cliEnv, cwd: w.root });
    assert.equal(outside.code, 3);
    assert.match(outside.err, /nika projects add/);
    assert.equal((await cli(['rules', 'preview', w.nested], { env: w.cliEnv })).code, 3, 'an explicit dir must be the project itself');
    assert.equal((await cli(['rules', 'preview', path.join(w.root, 'missing')], { env: w.cliEnv })).code, 3);
    assert.equal((await cli(['rules'], { env: w.cliEnv })).code, 2);
    assert.equal((await cli(['rules', 'frob'], { env: w.cliEnv })).code, 2);
    assert.equal((await cli(['rules', 'preview', '--yes'], { env: w.cliEnv, cwd: w.nested })).code, 2, '--yes belongs to apply');
  });

  test('(−) apply without --yes on a non-terminal exits 3 after the preview and writes nothing', async () => {
    const w = await world();
    const r = await cli(['rules', 'apply'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(r.code, 3);
    assert.match(r.out, /rules\/orchestration\.md \(create\)/);
    assert.match(r.err, /--yes/);
    assert.equal(fs.existsSync(path.join(w.project.dir, 'rules')), false);
    assert.equal(fs.existsSync(path.join(w.project.dir, 'CLAUDE.md')), false);
  });

  test('(+) apply --yes writes the files, keeps a backup folder in the state dir and is idempotent', async () => {
    const w = await world();
    const r = await cli(['rules', 'apply', '--yes'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /written: rules\/orchestration\.md, CLAUDE\.md/);
    assert.match(fs.readFileSync(path.join(w.project.dir, 'rules', 'orchestration.md'), 'utf8'), /^<!-- nika:orchestration v\d+ sha256:[0-9a-f]{64} -->\n/);
    assert.equal(fs.readFileSync(path.join(w.project.dir, 'CLAUDE.md'), 'utf8'), '@rules/orchestration.md\n');
    assert.equal(fs.existsSync(path.join(w.project.dir, '.gitignore')), false, 'the .gitignore line is opt-in');
    const again = await cli(['rules', 'apply', '--yes'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(again.code, 0);
    assert.match(again.out, /Nothing to apply/);
    fs.mkdirSync(path.join(w.project.dir, '.claude'));
    fs.writeFileSync(path.join(w.project.dir, '.claude', 'settings.local.json'), '{"theme":"dark"}\n');
    const git = await cli(['rules', 'apply', '--yes', '--gitignore'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(git.code, 0, git.err);
    assert.match(fs.readFileSync(path.join(w.project.dir, '.gitignore'), 'utf8'), /^\.claude\/settings\.local\.json$/m);
  });

  test('(+) on a terminal, apply asks first: y writes, n and end of input do not', async () => {
    const w = await world();
    const no = await cli(['rules', 'apply'], { env: w.cliEnv, cwd: w.nested, tty: true, stdin: input('n\n', true) });
    assert.equal(no.code, 3);
    assert.match(no.out, /Apply\? \[y\/N\] /);
    assert.match(no.err, /declined/);
    const eof = await cli(['rules', 'apply'], { env: w.cliEnv, cwd: w.nested, tty: true, stdin: input('', true) });
    assert.equal(eof.code, 3);
    assert.equal(fs.existsSync(path.join(w.project.dir, 'rules')), false);
    const yes = await cli(['rules', 'apply'], { env: w.cliEnv, cwd: w.nested, tty: true, stdin: input('y\n', true) });
    assert.equal(yes.code, 0, yes.err);
    assert.equal(fs.existsSync(path.join(w.project.dir, 'rules', 'orchestration.md')), true);
  });

  test('(−) a rules file nika did not write needs --overwrite-foreign, then a backup is kept; escapes are stripped from the diff', async () => {
    const w = await world();
    const file = path.join(w.project.dir, 'rules', 'orchestration.md');
    fs.mkdirSync(path.dirname(file));
    const mine = '# my own rules\n\u001b[31mred\u001b[0m\n';
    fs.writeFileSync(file, mine);
    const refused = await cli(['rules', 'apply', '--yes'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(refused.code, 3);
    assert.match(refused.err, /--overwrite-foreign/);
    assert.match(refused.out, /not written by nika/);
    assert.equal(refused.out.includes('\u001b'), false, 'no terminal escapes from project files');
    assert.equal(fs.readFileSync(file, 'utf8'), mine);
    const done = await cli(['rules', 'apply', '--yes', '--overwrite-foreign'], { env: w.cliEnv, cwd: w.nested });
    assert.equal(done.code, 0, done.err);
    const backupDir = /^backups: (.+)$/m.exec(done.out)[1];
    assert.equal(fs.readFileSync(path.join(backupDir, 'rules', 'orchestration.md'), 'utf8'), mine);
    assert.ok(backupDir.startsWith(w.env.XDG_STATE_HOME), 'backups live in nika\'s state dir, not in the repo');
  });
});

describe('spawn', () => {
  const brief = 'Write the summary.\n';
  const base = (w, extra = {}) => ({ env: { ...w.cliEnv, TMUX: 'x,1,0' }, cwd: w.nested, ...extra });

  test('(+) a brief file starts the agent: pane, session and report are printed, the brief is stored for _run-agent', async () => {
    const w = await world();
    const exec = tmuxExec();
    const file = path.join(w.root, 'brief.md');
    fs.writeFileSync(file, brief);
    const r = await cli(['spawn', 'builder-1', 'sonnet', file], base(w, { exec }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pane: %\d+$/m);
    assert.match(r.out, /^session: My-App$/m);
    assert.ok(r.out.trim().endsWith(`${path.join(reportsDir(w.project.key, w.env), 'builder-1.md')}`));
    assert.equal(fs.readFileSync(path.join(reportsDir(w.project.key, w.env), 'builder-1.brief.md'), 'utf8'), brief);
    const split = exec.tmux.of('split-window')[0];
    const tail = split.slice(split.indexOf('--') + 1);
    assert.deepEqual(tail, [process.execPath, NIKA_BIN, '_run-agent', w.project.key, 'builder-1']);
  });

  test('(+) a relative brief path resolves against the cwd; - reads stdin', async () => {
    const w = await world();
    fs.writeFileSync(path.join(w.nested, 'b.md'), brief);
    const rel = await cli(['spawn', 'a-one', 'haiku', 'b.md'], base(w, { exec: tmuxExec() }));
    assert.equal(rel.code, 0, rel.err);
    const piped = await cli(['spawn', 'a-two', 'haiku', '-'], base(w, { exec: tmuxExec(), stdin: input('From stdin.\n') }));
    assert.equal(piped.code, 0, piped.err);
    assert.equal(fs.readFileSync(path.join(reportsDir(w.project.key, w.env), 'a-two.brief.md'), 'utf8'), 'From stdin.\n');
  });

  test('(+) --session works outside tmux; --permission-mode and --rc reach the agent settings', async () => {
    const w = await world();
    const exec = tmuxExec();
    const r = await cli(['spawn', 'planner', 'opus', '-', '--session', 'My-App', '--permission-mode', 'plan', '--rc', 'team', '--project', w.project.dir],
      { env: w.cliEnv, cwd: w.root, exec, stdin: input(brief) });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reportsDir(w.project.key, w.env), 'planner.agent.json'), 'utf8')),
      { model: 'opus', permissionMode: 'plan', rc: 'team-planner', role: 'agent', parent: null, depth: 1, compact: { window: 400000, pct: '84.2106' } });
    assert.equal(exec.tmux.of('split-window')[0][3], '=My-App:');
  });

  test('(−) without $TMUX and --session it is a usage error (2) and tmux is never called', async () => {
    const w = await world();
    const exec = tmuxExec();
    const r = await cli(['spawn', 'builder-1', 'sonnet', '-'], { env: w.cliEnv, cwd: w.nested, exec, stdin: input(brief) });
    assert.equal(r.code, 2);
    assert.match(r.err, /--session/);
    assert.equal(exec.calls.length, 0);
  });

  test('(−) missing or surplus arguments and unknown options exit 2', async () => {
    const w = await world();
    for (const argv of [['spawn'], ['spawn', 'a', 'sonnet'], ['spawn', 'a', 'sonnet', 'b', 'c'], ['spawn', 'a', 'sonnet', '-', '--bogus']]) {
      assert.equal((await cli(argv, base(w, { exec: tmuxExec() }))).code, 2, argv.join(' '));
    }
  });

  test('(−) --permission-mode bypassPermissions is refused (3) before anything is read or run', async () => {
    const w = await world();
    const exec = tmuxExec();
    const r = await cli(['spawn', 'builder-1', 'sonnet', '-', '--permission-mode', 'bypassPermissions'], base(w, { exec, stdin: input(brief) }));
    assert.equal(r.code, 3);
    assert.match(r.err, /bypassPermissions/);
    assert.equal(exec.calls.length, 0);
    assert.equal(fs.existsSync(reportsDir(w.project.key, w.env)), false);
  });

  test('(−) a bad brief is refused (3): missing file, symlink, over 64 KB from a file or from stdin', async () => {
    const w = await world();
    const exec = tmuxExec();
    const real = path.join(w.root, 'real.md');
    fs.writeFileSync(real, brief);
    fs.symlinkSync(real, path.join(w.root, 'link.md'));
    fs.writeFileSync(path.join(w.root, 'big.md'), 'x'.repeat(64 * 1024 + 1));
    for (const file of ['missing.md', path.join(w.root, 'link.md'), path.join(w.root, 'big.md')]) {
      const r = await cli(['spawn', 'builder-1', 'sonnet', path.resolve(w.root, file)], base(w, { exec }));
      assert.equal(r.code, 3, file);
    }
    const big = await cli(['spawn', 'builder-1', 'sonnet', '-'], base(w, { exec, stdin: input('x'.repeat(64 * 1024 + 1)) }));
    assert.equal(big.code, 3);
    assert.match(big.err, /64 KB/);
    const empty = await cli(['spawn', 'builder-1', 'sonnet', '-'], base(w, { exec, stdin: input('  \n') }));
    assert.equal(empty.code, 3);
    assert.equal(exec.calls.length, 0, 'tmux is not called for a refused brief');
  });

  test('(−) a one-word brief is refused (3) from stdin and from a file before tmux is called; (+) two words pass', async () => {
    const w = await world();
    const exec = tmuxExec();
    fs.writeFileSync(path.join(w.root, 'one.md'), 'update\n');
    const fromFile = await cli(['spawn', 'builder-1', 'sonnet', path.join(w.root, 'one.md')], base(w, { exec }));
    assert.equal(fromFile.code, 3);
    assert.match(fromFile.err, /brief must be more than one word/);
    const fromStdin = await cli(['spawn', 'builder-1', 'sonnet', '-'], base(w, { exec, stdin: input(' doctor ') }));
    assert.equal(fromStdin.code, 3);
    assert.match(fromStdin.err, /more than one word/);
    assert.equal(exec.calls.length, 0, 'tmux is not called for a refused brief');
    assert.equal(fs.existsSync(reportsDir(w.project.key, w.env)), false);
    const two = await cli(['spawn', 'builder-1', 'sonnet', '-'], base(w, { exec, stdin: input('update docs') }));
    assert.equal(two.code, 0, two.err);
  });

  test('(−) the limit and the name check read the agent panes tmux has tagged <key>/<name>, not <name>.pane files (same count as the API)', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const agent = (id, tag, session = 'My-App') => ({ id, session, window: 0, windowName: 'zsh', command: 'node', role: 'agent', agent: tag });
    // forged files: three .pane files pointing at panes that exist but are not agents
    const dir = reportsDir(w.project.key, w.env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const n of ['x', 'y', 'builder-1']) fs.writeFileSync(path.join(dir, `${n}.pane`), '%1\n');
    const free = await cli(['spawn', 'builder-1', 'sonnet', '-'], base(w, { exec: tmuxExec([PANE_1, agent('%31', `${w.project.key}/a`)]), stdin: input(brief) }));
    assert.equal(free.code, 0, free.err);
    // tagged panes and no files: the limit applies, in any session, and so does the name check
    const w2 = await world({ limits: { maxAgents: 2 } });
    const k = w2.project.key;
    const full = await cli(['spawn', 'builder-2', 'sonnet', '-'], base(w2, { exec: tmuxExec([PANE_1, agent('%31', `${k}/a`), agent('%32', `${k}/b`, 'elsewhere')]), stdin: input(brief) }));
    assert.equal(full.code, 3);
    assert.match(full.err, /limit: You already run 2 of 2 agents spawned from nika/);
    const dup = await cli(['spawn', 'a', 'sonnet', '-'], base(w2, { exec: tmuxExec([PANE_1, agent('%31', `${k}/a`)]), stdin: input(brief) }));
    assert.equal(dup.code, 3);
    assert.match(dup.err, /conflict: agent a is already running/);
    // another project's agents (same session) and malformed tags are not this project's
    const others = [agent('%31', '0123456789abcdef/a'), agent('%32', '0123456789abcdef/b'), agent('%33', 'a'), agent('%34', `${k}/a/b`)];
    const fine = await cli(['spawn', 'a', 'sonnet', '-'], base(w2, { exec: tmuxExec([PANE_1, ...others]), stdin: input(brief) }));
    assert.equal(fine.code, 0, fine.err);
  });

  test('(−) an invalid name or model, an unregistered cwd and an unknown tmux session are refused (3)', async () => {
    const w = await world();
    assert.equal((await cli(['spawn', 'Bad Name', 'sonnet', '-'], base(w, { exec: tmuxExec(), stdin: input(brief) }))).code, 3);
    assert.equal((await cli(['spawn', 'a', 'gpt-4', '-'], base(w, { exec: tmuxExec(), stdin: input(brief) }))).code, 3);
    const outside = await cli(['spawn', 'a', 'sonnet', '-'], base(w, { exec: tmuxExec(), stdin: input(brief), cwd: w.root }));
    assert.equal(outside.code, 3);
    assert.match(outside.err, /nika projects add/);
    const noSession = await cli(['spawn', 'a', 'sonnet', '-', '--session', 'Nope'], base(w, { exec: tmuxExec(), stdin: input(brief) }));
    assert.equal(noSession.code, 3);
    assert.match(noSession.err, /not found/);
  });

  test('(−) tmux or claude missing is a runtime error (1)', async () => {
    const w = await world();
    const noTmux = await cli(['spawn', 'a', 'sonnet', '-'], base(w, { exec: tmuxExec([PANE_1], { enoent: true }), stdin: input(brief) }));
    assert.equal(noTmux.code, 1);
    assert.match(noTmux.err, /tmux/);
    const noClaude = await cli(['spawn', 'a', 'sonnet', '-'], base(w, { env: { ...w.cliEnv, TMUX: 'x', NIKA_CLAUDE: path.join(w.root, 'nope') }, exec: tmuxExec(), stdin: input(brief) }));
    assert.equal(noClaude.code, 1);
    assert.match(noClaude.err, /claude/);
  });
});

describe('orchestrate', () => {
  const at = (w, extra = {}) => ({ env: w.cliEnv, cwd: w.nested, ...extra });

  test('(+) --detached starts the orchestrator, prints session and pane, and does not attach', async () => {
    const w = await world();
    const exec = tmuxExec([]);
    const spawn = spawnLog();
    const r = await cli(['orchestrate', '--detached'], at(w, { exec, spawn, tty: true }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^session: My-App$/m);
    assert.match(r.out, /^pane: %\d+$/m);
    assert.equal(exec.tmux.of('new-session').length, 1);
    assert.equal(spawn.calls.length, 0);
    assert.equal(exec.calls.some((c) => c.includes('switch-client')), false);
  });

  test('(+) without a terminal on stdout it never attaches', async () => {
    const w = await world();
    const spawn = spawnLog();
    const r = await cli(['orchestrate', w.project.dir], at(w, { exec: tmuxExec([]), spawn, tty: false }));
    assert.equal(r.code, 0, r.err);
    assert.equal(spawn.calls.length, 0);
  });

  test('(+) inside tmux on a terminal it switches the client to the session', async () => {
    const w = await world();
    const exec = tmuxExec([]);
    const spawn = spawnLog();
    const r = await cli(['orchestrate'], at(w, { env: { ...w.cliEnv, TMUX: 'x,1,0' }, exec, spawn, tty: true }));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(exec.calls.at(-1), [TMUX, '-u', 'switch-client', '-t', '=My-App:']);
    assert.equal(spawn.calls.length, 0);
  });

  test('(+) outside tmux on a terminal it attaches with inherited stdio and no shell', async () => {
    const w = await world();
    const spawn = spawnLog();
    const r = await cli(['orchestrate'], at(w, { exec: tmuxExec([]), spawn, tty: true }));
    assert.equal(r.code, 0, r.err);
    assert.equal(spawn.calls.length, 1);
    assert.equal(spawn.calls[0].cmd, TMUX);
    assert.deepEqual(spawn.calls[0].args, ['-u', 'attach-session', '-t', '=My-App']);
    assert.equal(spawn.calls[0].opts.stdio, 'inherit');
    assert.equal(spawn.calls[0].opts.shell, false);
    const w2 = await world(); // a start saves its session as the pick: the second run needs a project of its own
    assert.equal((await cli(['orchestrate'], at(w2, { exec: tmuxExec([]), spawn: spawnLog(1), tty: true }))).code, 1, 'a failed attach is exit 1');
  });

  test('(+) a running orchestrator is reused', async () => {
    const w = await world();
    const exec = tmuxExec();
    const r = await cli(['orchestrate', '--detached'], at(w, { exec }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^pane: %1$/m);
    assert.match(r.out, /already running/);
    assert.equal(exec.tmux.of('new-session').length + exec.tmux.of('new-window').length, 0);
  });

  describe('the saved orchestrator (0.4)', () => {
    const PICK = '11111111-1111-4111-8111-111111111111';
    /** A transcript of `id` under the world's Claude dir, so nika's index knows the session (it is not running: no registry entry). */
    const transcript = (w, id) => {
      const dir = path.join(w.root, 'claude', 'projects', '-synthetic-project');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd: w.project.dir, sessionId: id, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'synthetic' } })}\n`);
    };

    test('(+) a fresh start saves the session it passes to claude as the project\'s pick', async () => {
      const w = await world();
      const exec = tmuxExec([]);
      assert.equal((await cli(['orchestrate', '--detached'], at(w, { exec }))).code, 0);
      const argv = exec.tmux.of('new-session')[0];
      const id = argv[argv.indexOf('--session-id') + 1];
      assert.equal(await getOrchestrator(w.project.key, w.env), id);
    });

    test('(+) an ended pick is resumed with claude --resume <id>', async () => {
      const w = await world();
      await setOrchestrator(w.project.key, PICK, w.env);
      transcript(w, PICK);
      const exec = tmuxExec([]);
      const r = await cli(['orchestrate', '--detached'], at(w, { exec }));
      assert.equal(r.code, 0, r.err);
      const argv = exec.tmux.of('new-session')[0];
      assert.deepEqual(argv.slice(argv.indexOf('--') + 2, argv.indexOf('--') + 4), ['--resume', PICK]);
      assert.equal(await getOrchestrator(w.project.key, w.env), PICK);
    });

    test('(−) a pick nika cannot check (the transcript index is unreadable) is exit 1: nothing starts and the pick stays', async () => {
      const w = await world();
      await setOrchestrator(w.project.key, PICK, w.env);
      const exec = tmuxExec([]);
      const r = await cli(['orchestrate', '--detached'], at(w, { exec }));
      assert.equal(r.code, 1);
      assert.match(r.err, /saved orchestrator/);
      assert.deepEqual(exec.tmux.calls.map((c) => c[2]), ['list-panes'], 'only the read-only listing of the lookup: nothing is created or tagged');
      assert.equal(await getOrchestrator(w.project.key, w.env), PICK);
    });

    test('(−) a pick whose transcript is gone (the index is readable) is forgotten and a new orchestrator starts', async () => {
      const w = await world();
      await setOrchestrator(w.project.key, PICK, w.env);
      transcript(w, '22222222-2222-4222-8222-222222222222');
      const exec = tmuxExec([]);
      const r = await cli(['orchestrate', '--detached'], at(w, { exec }));
      assert.equal(r.code, 0, r.err);
      const argv = exec.tmux.of('new-session')[0];
      assert.equal(argv.includes('--session-id'), true);
      assert.notEqual(await getOrchestrator(w.project.key, w.env), PICK);
    });
  });

  test('(−) an unregistered cwd is refused (3), two directories are a usage error (2), missing tmux or claude is exit 1', async () => {
    const w = await world();
    assert.equal((await cli(['orchestrate', '--detached'], at(w, { cwd: w.root, exec: tmuxExec([]) }))).code, 3);
    assert.equal((await cli(['orchestrate', 'a', 'b'], at(w, { exec: tmuxExec([]) }))).code, 2);
    assert.equal((await cli(['orchestrate', '--bogus'], at(w, { exec: tmuxExec([]) }))).code, 2);
    assert.equal((await cli(['orchestrate', '--detached'], at(w, { exec: tmuxExec([], { enoent: true }) }))).code, 1);
    const noClaude = await cli(['orchestrate', '--detached'], at(w, { env: { ...w.cliEnv, NIKA_CLAUDE: path.join(w.root, 'nope') }, exec: tmuxExec([]) }));
    assert.equal(noClaude.code, 1);
  });
});

describe('doctor', () => {
  test('(+) reports node, tmux, claude, the app, folder modes and config warnings, but no config contents', async () => {
    const w = await world();
    const cfg = path.join(w.env.NIKA_CONFIG_DIR, 'nika');
    const state = path.join(w.env.XDG_STATE_HOME, 'nika');
    fs.mkdirSync(cfg, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.chmodSync(cfg, 0o700);
    fs.chmodSync(state, 0o755);
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ bogusKey: 'SECRET-VALUE-123', permissionMode: 'plan' }));
    const exec = execLog({
      [TMUX]: () => ({ stdout: 'tmux 3.4\n', stderr: '' }),
      [w.claude]: () => ({ stdout: '9.9.9 (Claude Code)\nsecond line\n', stderr: '' }),
      mdfind: () => ({ stdout: `${w.root}/nika.app\n`, stderr: '' }),
    });
    const r = await cli(['doctor'], { env: w.cliEnv, platform: 'darwin', exec });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^node\\s+${process.version.replace(/\./g, '\\.')}`, 'm'));
    assert.match(r.out, /^tmux\s+\S+\s+tmux 3\.4$/m);
    assert.match(r.out, /^claude\s+\S+\s+9\.9\.9 \(Claude Code\)$/m);
    assert.match(r.out, /^app\s+installed$/m);
    assert.match(r.out, /^config\s+.*mode 0700$/m);
    assert.match(r.out, /^state\s+.*mode 0755\s+\(should be 0700\)$/m);
    assert.match(r.out, /^warning\s+config\.json: unknown key bogusKey dropped$/m);
    assert.equal(r.out.includes('SECRET-VALUE-123'), false);
    assert.equal(r.out.includes('second line'), false, 'first line of --version only');
    assert.ok(exec.calls.some((c) => c[0] === TMUX && c[1] === '-V'));
  });

  test('(+) prints the backups folder with its mode and how many are kept; (−) says so when it does not exist yet', async () => {
    const w = await world();
    const backups = path.join(w.env.XDG_STATE_HOME, 'nika', 'backups');
    const before = await cli(['doctor'], { env: w.cliEnv, platform: 'darwin', exec: execLog({ mdfind: () => OK }) });
    assert.match(before.out, /^backups\s+.*backups\s+not created yet\s+\(rules apply keeps the last 10 per project\)$/m);
    fs.mkdirSync(backups, { recursive: true });
    fs.chmodSync(backups, 0o700);
    const r = await cli(['doctor'], { env: w.cliEnv, platform: 'darwin', exec: execLog({ mdfind: () => OK }) });
    assert.match(r.out, /^backups\s+.*nika\/backups\s+mode 0700\s+\(rules apply keeps the last 10 per project\)$/m);
    fs.chmodSync(backups, 0o755);
    const loose = await cli(['doctor'], { env: w.cliEnv, platform: 'darwin', exec: execLog({ mdfind: () => OK }) });
    assert.match(loose.out, /^backups\s+.*mode 0755\s+\(should be 0700\)/m);
  });

  test('(−) missing tmux, claude and app are reported, not fatal; the app on Linux is found by its desktop entry', async () => {
    const w = await world();
    const r = await cli(['doctor'], { env: { ...w.cliEnv, NIKA_CLAUDE: path.join(w.root, 'nope') }, platform: 'darwin', exec: execLog({ mdfind: () => OK }) });
    assert.equal(r.code, 0);
    assert.match(r.out, /^tmux\s+not found/m);
    assert.match(r.out, /^claude\s+not found/m);
    assert.match(r.out, /^app\s+not installed$/m);
    assert.match(r.out, /^state\s+.*not created yet$/m);
    const share = path.join(w.root, 'share');
    fs.mkdirSync(path.join(share, 'applications'), { recursive: true });
    fs.writeFileSync(path.join(share, 'applications', `${APP_ID}.desktop`), '[Desktop Entry]\n');
    const linux = await cli(['doctor'], { env: { ...w.cliEnv, XDG_DATA_DIRS: share }, platform: 'linux', exec: execLog() });
    assert.match(linux.out, /^app\s+installed$/m);
    assert.equal((await cli(['doctor', 'extra'], { env: w.cliEnv })).code, 2);
  });
});

describe('doctor: tmux install hint per platform', () => {
  const tmuxRow = async (platform, exec) => {
    const w = await world();
    const r = await cli(['doctor'], { env: w.cliEnv, platform, exec: exec ?? execLog({ mdfind: () => OK }) });
    assert.equal(r.code, 0, r.err);
    return r.out.split('\n').find((l) => /^tmux\s/.test(l));
  };

  test('(+) macOS names brew, Linux names apt; both keep the NIKA_TMUX escape hatch', async () => {
    assert.match(await tmuxRow('darwin'), /^tmux\s+not found \(install: brew install tmux; or set NIKA_TMUX\)$/);
    assert.match(await tmuxRow('linux'), /^tmux\s+not found \(install: sudo apt install tmux; or set NIKA_TMUX\)$/);
  });

  test('(−) any other platform gets no install command; a tmux that is found gets no hint at all', async () => {
    for (const platform of ['win32', 'freebsd', 'sunos']) {
      const row = await tmuxRow(platform);
      assert.match(row, /^tmux\s+not found \(add it to PATH or set NIKA_TMUX\)$/, platform);
      assert.doesNotMatch(row, /brew|apt/, platform);
    }
    for (const platform of ['darwin', 'linux']) {
      const row = await tmuxRow(platform, execLog({ [TMUX]: () => ({ stdout: 'tmux 3.4\n', stderr: '' }), mdfind: () => OK }));
      assert.match(row, /^tmux\s+\S+\s+tmux 3\.4$/, platform);
      assert.doesNotMatch(row, /install|not found/, platform);
    }
  });
});

describe('spawn: nesting from $TMUX_PANE and --role (0.4)', () => {
  const brief = 'Write the summary.\n';
  const main = (w, over = {}) => ({ ...PANE_1, agent: `${w.project.key}/orchestrator`, depth: '1', ...over });
  const at = (w, pane, extra = {}) => ({ env: { ...w.cliEnv, TMUX: 'x,1,0', ...(pane === undefined ? {} : { TMUX_PANE: pane }) }, cwd: w.nested, stdin: input(brief), ...extra });
  const stored = (w, name) => JSON.parse(fs.readFileSync(path.join(reportsDir(w.project.key, w.env), `${name}.agent.json`), 'utf8'));

  test('(+) --role orchestrator from the main orchestrator\'s pane ($TMUX_PANE) starts a sub-orchestrator at depth 2 under that pane', async () => {
    const w = await world();
    const exec = tmuxExec([main(w)]);
    const r = await cli(['spawn', 'planner', 'opus', '-', '--role', 'orchestrator'], at(w, '%1', { exec }));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(stored(w, 'planner'), { model: 'opus', permissionMode: 'default', rc: '', role: 'sub-orchestrator', parent: '%1', depth: 2, compact: { window: 400000, pct: '84.2106' } });
    const p = exec.tmux.panes.find((x) => x.id === '%20');
    assert.deepEqual([p.role, p.depth, p.parent], ['sub-orchestrator', '2', '%1']);
  });

  test('(+) an agent spawned from the orchestrator\'s pane is its child (depth 2); from a sub-orchestrator\'s pane, depth 3; the default role is agent', async () => {
    const w = await world();
    const sub = { id: '%2', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'node', role: 'sub-orchestrator', agent: `${w.project.key}/planner`, depth: '2', parent: '%1' };
    const exec = tmuxExec([main(w), sub]);
    assert.equal((await cli(['spawn', 'one', 'haiku', '-'], at(w, '%1', { exec }))).code, 0);
    assert.equal((await cli(['spawn', 'two', 'haiku', '-', '--role', 'agent'], at(w, '%2', { exec }))).code, 0);
    assert.deepEqual([stored(w, 'one').parent, stored(w, 'one').depth, stored(w, 'one').role], ['%1', 2, 'agent']);
    assert.deepEqual([stored(w, 'two').parent, stored(w, 'two').depth, stored(w, 'two').role], ['%2', 3, 'agent']);
  });

  test('(−) a bad --role is a usage error (2) and tmux is never called; there is no --parent option', async () => {
    const w = await world();
    for (const args of [['--role', 'admin'], ['--role', 'sub-orchestrator'], ['--role', 'Agent'], ['--role', ''], ['--role'], ['--parent', '%1'], ['--parent=%1']]) {
      const exec = tmuxExec([main(w)]);
      const r = await cli(['spawn', 'x', 'haiku', '-', ...args], at(w, '%1', { exec }));
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(exec.calls.length, 0, args.join(' '));
    }
    assert.equal(fs.existsSync(reportsDir(w.project.key, w.env)), false);
  });

  test('(−) a $TMUX_PANE that is not a pane id is no parent: depth 1, and --role orchestrator is refused (3, depth) with nothing started', async () => {
    const w = await world();
    for (const pane of ['%x', '%', '1', '$(id)', '%1;%2', '%1234567', '%1\n', ' %1', '']) {
      const exec = tmuxExec([main(w)]);
      const ok = await cli(['spawn', 'child', 'haiku', '-'], at(w, pane, { exec }));
      assert.equal(ok.code, 0, `${JSON.stringify(pane)} ${ok.err}`);
      assert.deepEqual([stored(w, 'child').parent, stored(w, 'child').depth], [null, 1], JSON.stringify(pane));
      fs.rmSync(reportsDir(w.project.key, w.env), { recursive: true });
      const e2 = tmuxExec([main(w)]);
      const refused = await cli(['spawn', 'planner', 'haiku', '-', '--role', 'orchestrator'], at(w, pane, { exec: e2 }));
      assert.equal(refused.code, 3, JSON.stringify(pane));
      assert.match(refused.err, /depth: /);
      assert.equal(e2.tmux.of('split-window').length, 0);
    }
  });

  test('(−) a $TMUX_PANE that is not in tmux\'s listing (or no $TMUX_PANE at all) is "you" for the CLI: it spawns at depth 1', async () => {
    const w = await world();
    const exec = tmuxExec([main(w)]);
    assert.equal((await cli(['spawn', 'child', 'haiku', '-'], at(w, '%77', { exec }))).code, 0);
    assert.deepEqual([stored(w, 'child').parent, stored(w, 'child').depth], [null, 1]);
    assert.equal((await cli(['spawn', 'other', 'haiku', '-'], at(w, undefined, { exec }))).code, 0);
    assert.deepEqual([stored(w, 'other').parent, stored(w, 'other').depth], [null, 1]);
  });

  test('(−) a sub-orchestrator cannot start another one, and an agent\'s pane cannot parent anything (3, depth)', async () => {
    const w = await world();
    const sub = { id: '%2', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'node', role: 'sub-orchestrator', agent: `${w.project.key}/planner`, depth: '2', parent: '%1' };
    const leaf = { id: '%3', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'node', role: 'agent', agent: `${w.project.key}/leaf`, depth: '3', parent: '%2' };
    const exec = tmuxExec([main(w), sub, leaf]);
    const a = await cli(['spawn', 'deeper', 'haiku', '-', '--role', 'orchestrator'], at(w, '%2', { exec }));
    assert.equal(a.code, 3);
    assert.match(a.err, /depth: That session can't start a sub-orchestrator/);
    const b = await cli(['spawn', 'child', 'haiku', '-'], at(w, '%3', { exec }));
    assert.equal(b.code, 3);
    assert.match(b.err, /depth: leaf can't start agents for this project: only this project's orchestrator and its sub-orchestrators can\. Nothing was started\./);
    assert.equal(exec.tmux.of('split-window').length, 0);
  });

  test('(−) the main orchestrator or a sub-orchestrator of ANOTHER project, running nika in this project (--project / its folder), is refused (3, depth): nothing sent', async () => {
    const w = await world();
    const other = '0123456789abcdef';
    const orch = { ...PANE_1, session: 'Other', agent: `${other}/orchestrator`, depth: '1' };
    const sub = { id: '%2', session: 'Other', window: 0, windowName: 'orchestrator', command: 'node', role: 'sub-orchestrator', agent: `${other}/planner`, depth: '2', parent: '%1' };
    const exec = tmuxExec([orch, sub, { id: '%9', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }]);
    for (const pane of ['%1', '%2']) {
      for (const args of [['spawn', 'child', 'haiku', '-'], ['spawn', 'planner', 'haiku', '-', '--role', 'orchestrator'], ['spawn', 'child', 'haiku', '-', '--project', w.project.dir]]) {
        const r = await cli(args, at(w, pane, { exec }));
        assert.equal(r.code, 3, `${pane} ${args.join(' ')}: ${r.err}`);
        assert.match(r.err, /depth: /);
      }
    }
    assert.equal(exec.tmux.of('split-window').length, 0);
    assert.equal(exec.tmux.of('set-option').length, 0);
    assert.equal(fs.existsSync(reportsDir(w.project.key, w.env)), false);
  });

  test('(+) a pane that carries no nika role (a human\'s shell) is "you": depth 1, no parent; so is a pane that tmux does not list', async () => {
    const w = await world();
    const shell = { id: '%4', session: 'My-App', window: 1, windowName: 'zsh', command: 'zsh' };
    const exec = tmuxExec([main(w), shell]);
    assert.equal((await cli(['spawn', 'fromshell', 'haiku', '-'], at(w, '%4', { exec }))).code, 0);
    assert.deepEqual([stored(w, 'fromshell').parent, stored(w, 'fromshell').depth, stored(w, 'fromshell').role], [null, 1, 'agent']);
    assert.equal((await cli(['spawn', 'stale', 'haiku', '-'], at(w, '%88', { exec }))).code, 0);
    assert.deepEqual([stored(w, 'stale').parent, stored(w, 'stale').depth], [null, 1]);
  });
});

describe('the command table and a sub-orchestrator\'s deny list (0.4)', () => {
  test('(+) COMMAND_NAMES is the table nika dispatches on, and the sub-orchestrator deny list built from it is pinned', () => {
    assert.deepEqual([...COMMAND_NAMES].sort(), ['--help', '--version', '-h', '-v', '_run-agent', 'app', 'doctor', 'help', 'open', 'orchestrate', 'projects', 'rules', 'serve', 'spawn', 'status', 'version']);
    assert.deepEqual(deniedTools('sub-orchestrator', COMMAND_NAMES), [
      'Bash(tmux:*)', 'Bash(claude:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(nika)',
      'Bash(nika --version:*)', 'Bash(nika -v:*)', 'Bash(nika version:*)', 'Bash(nika help:*)', 'Bash(nika -h:*)', 'Bash(nika --help:*)',
      'Bash(nika serve:*)', 'Bash(nika open:*)', 'Bash(nika app:*)', 'Bash(nika projects:*)', 'Bash(nika rules:*)', 'Bash(nika orchestrate:*)',
      'Bash(nika doctor:*)', 'Bash(nika _run-agent:*)',
    ]);
  });

  test('(−) every command the CLI answers to is in the table (a command outside it would not be denied); unknown words are a usage error', async () => {
    const dispatch = fs.readFileSync(path.join(path.dirname(NIKA_BIN), '..', 'src', 'cli.js'), 'utf8');
    assert.equal(/switch \(cmd\)/.test(dispatch), false, 'dispatch goes through the table, not a switch');
    for (const bad of ['nope', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      const r = await cli([bad], { env: {} });
      assert.equal(r.code, 2, bad);
      assert.match(r.err, /unknown command/);
    }
  });

  test('(+) _run-agent hands the table to runAgent: a sub-orchestrator started through the CLI denies every other nika command', async () => {
    const w = await world();
    const main = { ...PANE_1, agent: `${w.project.key}/orchestrator`, depth: '1' };
    const made = await cli(['spawn', 'planner', 'opus', '-', '--role', 'orchestrator'], { env: { ...w.cliEnv, TMUX: 'x', TMUX_PANE: '%1' }, cwd: w.nested, exec: tmuxExec([main]), stdin: input('Plan the work.\n') });
    assert.equal(made.code, 0, made.err);
    const spawn = spawnLog(0);
    const r = await cli(['_run-agent', w.project.key, 'planner'], { env: { ...w.cliEnv, TMUX_PANE: '%5' }, spawn });
    assert.equal(r.code, 0, r.err);
    const args = spawn.calls[0].args;
    const denied = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--'));
    assert.deepEqual(denied, deniedTools('sub-orchestrator', COMMAND_NAMES));
    assert.ok(!denied.includes('Bash(nika spawn:*)') && !denied.includes('Bash(nika status:*)') && !denied.includes('Bash(nika:*)'));
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /sub-orchestrator/);
  });
});


describe('_run-agent', () => {
  test('(+) passes key and name to runAgent and returns claude\'s exit code', async () => {
    const w = await world();
    const file = path.join(w.root, 'brief.md');
    fs.writeFileSync(file, 'Do the thing.\n');
    const made = await cli(['spawn', 'builder-1', 'sonnet', file], { env: { ...w.cliEnv, TMUX: 'x' }, cwd: w.nested, exec: tmuxExec() });
    assert.equal(made.code, 0, made.err);
    const spawn = spawnLog(7);
    const r = await cli(['_run-agent', w.project.key, 'builder-1'], { env: { ...w.cliEnv, TMUX_PANE: '%5' }, spawn });
    assert.equal(r.code, 7, r.err);
    assert.equal(spawn.calls[0].cmd, w.claude);
    assert.ok(spawn.calls[0].args.includes('--session-id'));
    assert.equal(spawn.calls[0].args[spawn.calls[0].args.indexOf('-n') + 1], 'builder-1');
    assert.equal(spawn.calls[0].args.at(-1), 'Do the thing.\n');
    assert.equal(fs.readFileSync(path.join(reportsDir(w.project.key, w.env), 'builder-1.rc'), 'utf8'), '7\n');
  });

  test('(−) a wrong key or name is refused (3), a wrong argument count is a usage error (2)', async () => {
    const w = await world();
    const bad = await cli(['_run-agent', 'not-a-key', 'builder-1'], { env: w.cliEnv, spawn: spawnLog() });
    assert.equal(bad.code, 3);
    assert.match(bad.err, /invalid project key or agent name/);
    const missing = await cli(['_run-agent', w.project.key, 'never-spawned'], { env: w.cliEnv, spawn: spawnLog() });
    assert.notEqual(missing.code, 0, 'no stored brief, nothing runs');
    assert.equal((await cli(['_run-agent', w.project.key], { env: w.cliEnv })).code, 2);
    assert.equal((await cli(['_run-agent'], { env: w.cliEnv })).code, 2);
  });
});
