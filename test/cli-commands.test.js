// The 0.2 CLI commands, run in process through main(argv, env, io) with injected stdin, cwd, platform, exec, spawn and
// serveApp. Temp dirs and an in-memory tmux only; synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { reportsDir } from '../src/paths.js';
import { listProjects } from '../src/store.js';
import { fakeTmux, makeWorld, TMUX } from './tmux-fake.js';

const APP_ID = 'io.github.qmpwwsd.nika';
const NIKA_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nika');
const PANE_1 = { id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator' };
const OK = { stdout: '', stderr: '' };

const worlds = [];
after(() => worlds.forEach((w) => w.cleanup()));

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
  const code = await main(argv, env, { out, err, in: stdin ?? input(), cwd, ...io });
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
      { model: 'opus', permissionMode: 'plan', rc: 'team-planner' });
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
    assert.equal((await cli(['orchestrate'], at(w, { exec: tmuxExec([]), spawn: spawnLog(1), tty: true }))).code, 1, 'a failed attach is exit 1');
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
