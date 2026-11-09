// src/appcopy.js (ADR 0011): the copy of nika.app in ~/Applications. Everything runs against temp dirs under os.tmpdir()
// with a fake exec: no test touches the real ~/Applications, runs the real ditto or registers anything with
// LaunchServices. Bundles are synthetic (a plist and one file); the only bundle id used besides nika's is a made-up one.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APP_ID, BREW_APPS, DITTO, LSREGISTER, targetPath, readBundle, findSource, appCopyState, installAppCopy, dismissAppCopy, refreshManagedCopy,
} from '../src/appcopy.js';

const UID = process.getuid();
const worlds = [];
after(() => worlds.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const plist = ({ id = APP_ID, version = '0.3.0' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`;

/** A synthetic bundle: Contents/Info.plist and one payload file. */
function bundle(dir, opts = {}) {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), opts.raw ?? plist(opts));
  fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'nika-app'), `payload ${opts.version ?? '0.3.0'}\n`);
  return dir;
}

/**
 * root/home (the fake HOME), root/state/nika (state dir), root/keg/libexec + root/keg/nika.app (a Homebrew keg).
 * `install` is the argument bag of the module functions; `exec` is the fake ditto / lsregister.
 */
function world({ kegVersion = '0.3.0', keg = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nika-appcopy-')));
  worlds.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const stateDir = path.join(root, 'state', 'nika');
  const kegDir = path.join(root, 'keg');
  fs.mkdirSync(path.join(kegDir, 'libexec'), { recursive: true });
  if (keg) bundle(path.join(kegDir, 'nika.app'), { version: kegVersion });
  const apps = path.join(home, 'Applications');
  const target = path.join(apps, 'nika.app');
  const args = { root: path.join(kegDir, 'libexec'), home, platform: 'darwin', stateDir };
  return { root, home, stateDir, kegDir, kegApp: path.join(kegDir, 'nika.app'), apps, target, args, marker: path.join(stateDir, 'app-copy.json') };
}

/** Fake ditto (copies the folder, symlinks verbatim) and lsregister; records every call. `hook(cmd, args)` runs first. */
function fakeExec({ failDitto = false, hook, mutate } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    await hook?.(cmd, args);
    if (cmd === DITTO) {
      if (failDitto) throw Object.assign(new Error('ditto: exit 1 /some/private/path'), { code: 1 });
      fs.cpSync(args[0], args[1], { recursive: true, verbatimSymlinks: true });
      mutate?.(args[1]);
      return { stdout: '', stderr: '' };
    }
    if (cmd === LSREGISTER) return { stdout: '', stderr: '' };
    throw Object.assign(new Error(`unexpected command ${cmd}`), { code: 'ENOENT' });
  };
  exec.calls = calls;
  return exec;
}

/** fs with a spy on rename (and optional failures): fails when `failOn(from, to)` is true. */
function spyFs(failOn = () => false) {
  const ops = [];
  return Object.assign({
    ...fsp,
    mkdtemp: async (p) => { const d = await fsp.mkdtemp(p); ops.push(['mkdtemp', d]); return d; },
    rename: async (from, to) => {
      ops.push(['rename', from, to]);
      if (failOn(from, to)) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      return fsp.rename(from, to);
    },
  }, { ops });
}

/** ~/Applications as macOS makes it (0755); the umask of the machine running the tests must not decide. */
const mkApps = (w) => {
  fs.mkdirSync(w.apps);
  fs.chmodSync(w.apps, 0o755);
};
const leftovers = (apps) => (fs.existsSync(apps) ? fs.readdirSync(apps).filter((n) => n.startsWith('.nika-copy-')) : []);
const versionOf = (dir) => /<string>(\d[^<]*)<\/string>/.exec(fs.readFileSync(path.join(dir, 'Contents', 'Info.plist'), 'utf8').split('CFBundleShortVersionString')[1])?.[1];
const rejectsWith = (p, code) => assert.rejects(p, (e) => e.code === code && e.message === code, `rejects with ${code}`);

describe('constants', () => {
  test('(+) the target is exactly <home>/Applications/nika.app; the fixed Homebrew paths and tools are the ones in the contract', () => {
    assert.equal(targetPath('/h'), path.join('/h', 'Applications', 'nika.app'));
    assert.deepEqual(BREW_APPS, ['/opt/homebrew/opt/nika/nika.app', '/usr/local/opt/nika/nika.app']);
    assert.equal(DITTO, '/usr/bin/ditto');
    assert.ok(path.isAbsolute(LSREGISTER) && LSREGISTER.endsWith('/LaunchServices.framework/Support/lsregister'));
    assert.equal(APP_ID, 'io.github.qmpwwsd.nika');
  });
});

describe('readBundle', () => {
  test('(+) reads the bundle id and version from an XML Info.plist; a commented-out key does not count', async () => {
    const w = world();
    assert.deepEqual(await readBundle(w.kegApp), { id: APP_ID, version: '0.3.0' });
    const dir = bundle(path.join(w.root, 'c.app'), { raw: `<plist><dict><!-- <key>CFBundleIdentifier</key><string>${APP_ID}</string> --><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>` });
    assert.equal(await readBundle(dir), null);
  });

  test('(+) comments are dropped wherever they sit, so the keys around them still count (several comments, between key and value too)', async () => {
    const w = world();
    const raw = `<plist><dict><!-- a --><key>CFBundleIdentifier</key><!-- b -->\n<string>${APP_ID}</string><!--\nmulti\nline\n--><key>CFBundleShortVersionString</key><string>1.2.3</string><!-- c --></dict></plist>`;
    assert.deepEqual(await readBundle(bundle(path.join(w.root, 'm.app'), { raw })), { id: APP_ID, version: '1.2.3' });
  });

  test('(−) an unterminated comment drops the rest of the file: what follows it never counts', async () => {
    const w = world();
    const after = bundle(path.join(w.root, 'u1.app'), { raw: `<plist><dict><key>CFBundleIdentifier</key><string>${APP_ID}</string><!-- never closed <key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>` });
    assert.deepEqual(await readBundle(after), { id: APP_ID, version: null }, 'the id before it is read, the version inside it is not');
    const before = bundle(path.join(w.root, 'u2.app'), { raw: `<plist><dict><!-- never closed <key>CFBundleIdentifier</key><string>${APP_ID}</string></dict></plist>` });
    assert.equal(await readBundle(before), null, 'an id after an unterminated comment is not one');
    const hidden = bundle(path.join(w.root, 'u3.app'), { raw: `<plist><dict><key>CFBundleIdentifier</key><string>${APP_ID}</string><!--></dict></plist>` });
    assert.deepEqual(await readBundle(hidden), { id: APP_ID, version: null }, '<!--> opens a comment that never closes');
  });

  test('(−) 64 KB of repeated comment openers is answered with the right result (linear work, no timing assumed)', async () => {
    const w = world();
    const head = `<plist><dict><key>CFBundleIdentifier</key><string>${APP_ID}</string>`;
    const opens = (n) => '<!--'.repeat(Math.floor(n / 4));
    const withId = bundle(path.join(w.root, 'r1.app'), { raw: head + opens(64 * 1024 - head.length) });
    assert.equal(fs.statSync(path.join(withId, 'Contents', 'Info.plist')).size <= 64 * 1024, true);
    assert.deepEqual(await readBundle(withId), { id: APP_ID, version: null });
    const noId = bundle(path.join(w.root, 'r2.app'), { raw: `<plist><dict>${opens(64 * 1024 - 20)}` });
    assert.equal(await readBundle(noId), null);
    const closedLast = bundle(path.join(w.root, 'r3.app'), { raw: `${opens(32 * 1024)}--><plist><dict><key>CFBundleIdentifier</key><string>${APP_ID}</string></dict></plist>` });
    assert.deepEqual(await readBundle(closedLast), { id: APP_ID, version: null }, 'one close ends the first comment; everything before it is gone');
  });

  test('(+) a version that is not a plain x.y.z is null, the id is still read', async () => {
    const w = world();
    const dir = bundle(path.join(w.root, 'v.app'), { version: '1.2' });
    assert.deepEqual(await readBundle(dir), { id: APP_ID, version: null });
    bundle(dir, { version: '<b>x</b>'.replace(/[<>]/g, '') });
    assert.equal((await readBundle(dir)).version, null);
  });

  test('(−) a missing bundle, a file, a symlinked bundle and a symlinked Contents are null', async () => {
    const w = world();
    assert.equal(await readBundle(path.join(w.root, 'nope.app')), null);
    const file = path.join(w.root, 'file.app');
    fs.writeFileSync(file, 'x');
    assert.equal(await readBundle(file), null);
    const link = path.join(w.root, 'link.app');
    fs.symlinkSync(w.kegApp, link);
    assert.equal(await readBundle(link), null);
    const half = path.join(w.root, 'half.app');
    fs.mkdirSync(half);
    fs.symlinkSync(path.join(w.kegApp, 'Contents'), path.join(half, 'Contents'));
    assert.equal(await readBundle(half), null);
  });

  test('(−) a bundle or Contents folder not owned by the user is null', async () => {
    const w = world();
    assert.equal(await readBundle(w.kegApp, { uid: UID + 1 }), null);
    const foreign = { ...fsp, lstat: async (p) => { const st = await fsp.lstat(p); return p.endsWith('Contents') ? Object.create(st, { uid: { value: UID + 1 } }) : st; } };
    assert.equal(await readBundle(w.kegApp, { fs: foreign }), null);
  });

  test('(−) a plist over 64 KB, a plist without CFBundleIdentifier, a binary plist and a symlinked plist are null', async () => {
    const w = world();
    assert.equal(await readBundle(bundle(path.join(w.root, 'big.app'), { raw: plist() + ' '.repeat(64 * 1024) })), null);
    assert.equal((await readBundle(bundle(path.join(w.root, 'ok.app'), { raw: plist() + ' '.repeat(1000) }))).id, APP_ID);
    assert.equal(await readBundle(bundle(path.join(w.root, 'noid.app'), { raw: '<plist><dict><key>CFBundleName</key><string>x</string></dict></plist>' })), null);
    assert.equal(await readBundle(bundle(path.join(w.root, 'bin.app'), { raw: 'bplist00\u0000\u0001' })), null);
    const sym = bundle(path.join(w.root, 'sym.app'));
    fs.rmSync(path.join(sym, 'Contents', 'Info.plist'));
    fs.symlinkSync(path.join(w.kegApp, 'Contents', 'Info.plist'), path.join(sym, 'Contents', 'Info.plist'));
    assert.equal(await readBundle(sym), null);
  });
});

describe('findSource', () => {
  test('(+) the running bundle: the root ends in <x>.app/Contents/Resources/nika', async () => {
    const w = world();
    const running = bundle(path.join(w.root, 'Running.app'));
    const runRoot = path.join(running, 'Contents', 'Resources', 'nika');
    fs.mkdirSync(runRoot, { recursive: true });
    assert.equal(await findSource({ ...w.args, root: runRoot }, { brewApps: [] }), running);
  });

  test('(+) the keg sibling: root = <keg>/libexec finds <keg>/nika.app', async () => {
    const w = world();
    assert.equal(await findSource(w.args, { brewApps: [] }), w.kegApp);
  });

  test('(+) the fixed Homebrew paths come last, in order; the default list is the two contract paths', async () => {
    const w = world({ keg: false });
    const a = bundle(path.join(w.root, 'brew-a', 'nika.app'));
    const b = bundle(path.join(w.root, 'brew-b', 'nika.app'));
    assert.equal(await findSource(w.args, { brewApps: [a, b] }), a);
    assert.equal(await findSource(w.args, { brewApps: [path.join(w.root, 'none.app'), b] }), b);
    // the running bundle wins over the keg sibling, and the keg sibling over the fixed paths
    assert.equal(await findSource({ ...w.args }, { brewApps: [a] }), a);
    bundle(w.kegApp);
    assert.equal(await findSource(w.args, { brewApps: [a] }), w.kegApp);
  });

  test('(−) the target itself is never a source, not even when the process runs from it', async () => {
    const w = world({ keg: false });
    bundle(w.target);
    const runRoot = path.join(w.target, 'Contents', 'Resources', 'nika');
    fs.mkdirSync(runRoot, { recursive: true });
    assert.equal(await findSource({ ...w.args, root: runRoot }, { brewApps: [] }), null);
    assert.equal(await findSource({ ...w.args, root: runRoot }, { brewApps: [w.target] }), null);
  });

  test('(−) a folder whose plist names another bundle id, has no version, or is a symlink is not a source', async () => {
    const w = world({ keg: false });
    const other = bundle(path.join(w.root, 'o', 'nika.app'), { id: 'com.example.other' });
    const noVer = bundle(path.join(w.root, 'n', 'nika.app'), { version: 'dev' });
    const real = bundle(path.join(w.root, 'r', 'nika.app'));
    const link = path.join(w.root, 'l', 'nika.app');
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(real, link);
    assert.equal(await findSource(w.args, { brewApps: [other, noVer, link] }), null);
    assert.equal(await findSource(w.args, { brewApps: [other, noVer, link, real] }), real);
  });

  test('(−) a root that is neither a bundle nor libexec finds nothing, and the fixed paths are not required to exist', async () => {
    const w = world();
    assert.equal(await findSource({ ...w.args, root: path.join(w.root, 'elsewhere') }, { brewApps: [] }), null);
    assert.equal(await findSource({ ...w.args, root: path.join(w.root, 'elsewhere') }, { brewApps: BREW_APPS.map((p) => path.join(w.root, p)) }), null);
  });
});

describe('appCopyState', () => {
  test('(−) Linux: unsupported, and nothing is read', async () => {
    const w = world();
    const s = await appCopyState({ ...w.args, platform: 'linux' }, { fs: new Proxy({}, { get() { throw new Error('fs touched'); } }) });
    assert.deepEqual(s, { state: 'unsupported', managed: false, dismissed: false, version: null, available: null, running: false });
  });

  test('(+) missing: a source, no ~/Applications/nika.app (also without ~/Applications)', async () => {
    const w = world();
    assert.deepEqual(await appCopyState(w.args, { brewApps: [] }), { state: 'missing', managed: false, dismissed: false, version: null, available: '0.3.0', running: false });
    mkApps(w);
    assert.equal((await appCopyState(w.args, { brewApps: [] })).state, 'missing');
  });

  test('(+) current / stale: nika at the source version / at another version; managed and dismissed come from the marker', async () => {
    const w = world();
    bundle(w.target, { version: '0.3.0' });
    assert.deepEqual(await appCopyState(w.args, { brewApps: [] }), { state: 'current', managed: false, dismissed: false, version: '0.3.0', available: '0.3.0', running: false });
    bundle(w.target, { version: '0.2.0' });
    fs.mkdirSync(w.stateDir, { recursive: true });
    fs.writeFileSync(w.marker, JSON.stringify({ managed: true, version: '0.2.0', dismissed: true }));
    assert.deepEqual(await appCopyState(w.args, { brewApps: [] }), { state: 'stale', managed: true, dismissed: true, version: '0.2.0', available: '0.3.0', running: false });
  });

  test('(+) running is true when the process runs from the copy', async () => {
    const w = world();
    bundle(w.target, { version: '0.2.0' });
    const runRoot = path.join(w.target, 'Contents', 'Resources', 'nika');
    fs.mkdirSync(runRoot, { recursive: true });
    const s = await appCopyState({ ...w.args, root: runRoot }, { brewApps: [w.kegApp] });
    assert.equal(s.running, true);
    assert.equal(s.state, 'stale');
  });

  test('(−) no-source: nothing to copy from (the copy alone does not make a source)', async () => {
    const w = world({ keg: false });
    assert.equal((await appCopyState(w.args, { brewApps: [] })).state, 'no-source');
    bundle(w.target);
    const s = await appCopyState(w.args, { brewApps: [] });
    assert.equal(s.state, 'no-source');
    assert.equal(s.version, '0.3.0');
    assert.equal(s.available, null);
  });

  test('(−) foreign: a symlink, a file, another bundle id, another owner, an unreadable plist, a symlinked ~/Applications', async () => {
    const w = world();
    const state = async (deps = {}) => (await appCopyState(w.args, { brewApps: [], ...deps })).state;
    const decoy = bundle(path.join(w.root, 'decoy.app'));
    mkApps(w);
    fs.symlinkSync(decoy, w.target);
    assert.equal(await state(), 'foreign', 'symlink');
    fs.rmSync(w.target);
    fs.writeFileSync(w.target, 'x');
    assert.equal(await state(), 'foreign', 'file');
    fs.rmSync(w.target);
    bundle(w.target, { id: 'com.example.other' });
    assert.equal(await state(), 'foreign', 'other bundle id');
    fs.rmSync(path.join(w.target, 'Contents', 'Info.plist'));
    assert.equal(await state(), 'foreign', 'unreadable plist');
    fs.rmSync(w.target, { recursive: true });
    bundle(w.target);
    const foreignOwner = { ...fsp, lstat: async (p) => { const st = await fsp.lstat(p); return p === w.target ? Object.create(st, { uid: { value: UID + 1 } }) : st; } };
    assert.equal(await state({ fs: foreignOwner }), 'foreign', 'other owner');
    fs.rmSync(w.apps, { recursive: true });
    fs.symlinkSync(path.join(w.root, 'state'), w.apps);
    assert.equal(await state(), 'foreign', 'symlinked ~/Applications');
  });

  test('(−) a world-writable ~/Applications is foreign too', async () => {
    const w = world();
    mkApps(w);
    bundle(w.target);
    fs.chmodSync(w.apps, 0o777);
    assert.equal((await appCopyState(w.args, { brewApps: [] })).state, 'foreign');
  });

  test('(−) a group-writable ~/Applications (0o020 alone) is foreign too', async () => {
    const w = world();
    mkApps(w);
    bundle(w.target);
    fs.chmodSync(w.apps, 0o775);
    assert.equal((await appCopyState(w.args, { brewApps: [] })).state, 'foreign');
    fs.chmodSync(w.apps, 0o755);
    assert.equal((await appCopyState(w.args, { brewApps: [] })).state, 'current');
  });

  test('(−) a garbage or symlinked marker reads as "not managed, not dismissed"', async () => {
    const w = world();
    fs.mkdirSync(w.stateDir, { recursive: true });
    fs.writeFileSync(w.marker, '{not json');
    assert.deepEqual(pick(await appCopyState(w.args, { brewApps: [] })), { managed: false, dismissed: false });
    fs.rmSync(w.marker);
    const real = path.join(w.root, 'real-marker.json');
    fs.writeFileSync(real, JSON.stringify({ managed: true, dismissed: true }));
    fs.symlinkSync(real, w.marker);
    assert.deepEqual(pick(await appCopyState(w.args, { brewApps: [] })), { managed: false, dismissed: false });
    fs.rmSync(w.marker);
    fs.writeFileSync(w.marker, JSON.stringify({ managed: 'yes', dismissed: 1 }));
    assert.deepEqual(pick(await appCopyState(w.args, { brewApps: [] })), { managed: false, dismissed: false });
  });
});

const pick = ({ managed, dismissed }) => ({ managed, dismissed });

describe('installAppCopy', () => {
  test('(+) a first install: mkdtemp in ~/Applications, ditto <source> <tmp>/nika.app, verify, rename, remove tmp, lsregister -f target, marker', async () => {
    const w = world();
    let tmpMode;
    let tmpAtDitto;
    const exec = fakeExec({ hook: (cmd, args) => {
      if (cmd === DITTO) {
        tmpAtDitto = path.dirname(args[1]);
        tmpMode = fs.statSync(tmpAtDitto).mode & 0o777;
      }
    } });
    const fsx = spyFs();
    const r = await installAppCopy(w.args, { fs: fsx, exec, brewApps: [] });
    assert.deepEqual(r, { state: 'current', version: '0.3.0', restart: false, changed: 'added', recorded: true });
    assert.equal(exec.calls.length, 2);
    assert.deepEqual(exec.calls[0], [DITTO, w.kegApp, path.join(tmpAtDitto, 'nika.app')]);
    assert.deepEqual(exec.calls[1], [LSREGISTER, '-f', w.target]);
    assert.equal(path.dirname(tmpAtDitto), w.apps);
    assert.match(path.basename(tmpAtDitto), /^\.nika-copy-[A-Za-z0-9]{6}$/);
    assert.equal(tmpMode, 0o700);
    assert.deepEqual(fsx.ops, [['mkdtemp', tmpAtDitto], ['rename', path.join(tmpAtDitto, 'nika.app'), w.target]]);
    assert.deepEqual(leftovers(w.apps), []);
    assert.deepEqual(await readBundle(w.target), { id: APP_ID, version: '0.3.0' });
    assert.equal(fs.readFileSync(path.join(w.target, 'Contents', 'MacOS', 'nika-app'), 'utf8'), 'payload 0.3.0\n');
    assert.equal(fs.statSync(w.apps).mode & 0o777, 0o700, '~/Applications is created 0700');
    assert.deepEqual(JSON.parse(fs.readFileSync(w.marker, 'utf8')), { managed: true, version: '0.3.0', dismissed: false });
    assert.equal(fs.statSync(w.marker).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(w.home), ['Applications'], 'nothing else is written in HOME');
    assert.deepEqual(fs.readdirSync(w.apps), ['nika.app']);
  });

  test('(+) an update: the old copy moves into the temp folder, the new one takes its place, then the temp folder goes', async () => {
    const w = world({ kegVersion: '0.3.0' });
    bundle(w.target, { version: '0.2.0' });
    const exec = fakeExec();
    const fsx = spyFs();
    const r = await installAppCopy(w.args, { fs: fsx, exec, brewApps: [] });
    assert.deepEqual(r, { state: 'current', version: '0.3.0', restart: false, changed: 'updated', recorded: true });
    const tmp = fsx.ops[0][1];
    assert.deepEqual(fsx.ops.slice(1), [['rename', w.target, path.join(tmp, 'previous.app')], ['rename', path.join(tmp, 'nika.app'), w.target]]);
    assert.equal(versionOf(w.target), '0.3.0');
    assert.deepEqual(leftovers(w.apps), []);
    assert.equal(JSON.parse(fs.readFileSync(w.marker, 'utf8')).managed, true);
  });

  test('(+) restart is true only when this process runs from the copy it just replaced', async () => {
    const w = world();
    bundle(w.target, { version: '0.2.0' });
    const runRoot = path.join(w.target, 'Contents', 'Resources', 'nika');
    fs.mkdirSync(runRoot, { recursive: true });
    const r = await installAppCopy({ ...w.args, root: runRoot }, { exec: fakeExec(), brewApps: [w.kegApp] });
    assert.equal(r.changed, 'updated');
    assert.equal(r.restart, true);
  });

  test('(+) a current copy nika made is left alone: no temp folder, no ditto, no marker write', async () => {
    const w = world();
    bundle(w.target, { version: '0.3.0' });
    fs.mkdirSync(w.stateDir, { recursive: true });
    const before = JSON.stringify({ managed: true, version: '0.3.0', dismissed: true });
    fs.writeFileSync(w.marker, before);
    const exec = fakeExec();
    const fsx = spyFs();
    const r = await installAppCopy(w.args, { fs: fsx, exec, brewApps: [] });
    assert.deepEqual(r, { state: 'current', version: '0.3.0', restart: false, changed: 'none', recorded: true });
    assert.deepEqual(exec.calls, []);
    assert.deepEqual(fsx.ops, []);
    assert.equal(fs.readFileSync(w.marker, 'utf8'), before, 'the marker file is not rewritten');
  });

  test('(+) an explicit install over a current copy nika did not make takes it over: still no copy, but the marker says managed', async () => {
    const w = world();
    bundle(w.target, { version: '0.3.0' });
    const exec = fakeExec();
    const fsx = spyFs();
    const r = await installAppCopy(w.args, { fs: fsx, exec, brewApps: [] });
    assert.deepEqual(r, { state: 'current', version: '0.3.0', restart: false, changed: 'none', recorded: true });
    assert.deepEqual(exec.calls, [], 'nothing is copied');
    assert.deepEqual(fsx.ops, [], 'nothing is moved');
    assert.deepEqual(JSON.parse(fs.readFileSync(w.marker, 'utf8')), { managed: true, version: '0.3.0', dismissed: false });
    assert.equal(fs.statSync(w.marker).mode & 0o777, 0o600);
    assert.equal((await appCopyState(w.args, { brewApps: [] })).managed, true);
    assert.equal(await refreshManagedCopy({ ...w.args, version: '0.3.0' }, { exec, brewApps: [] }), 'none', 'and a later upgrade can then refresh it');
  });

  test('(−) the take-over never happens for a foreign target or without a source, and a failed marker write is reported as not recorded', async () => {
    const w = world();
    bundle(w.target, { id: 'com.example.other', version: '0.3.0' });
    await rejectsWith(installAppCopy(w.args, { exec: fakeExec(), brewApps: [] }), 'foreign-target');
    assert.equal(fs.existsSync(w.marker), false);
    const v = world();
    bundle(v.target, { version: '0.3.0' });
    fs.mkdirSync(path.dirname(v.stateDir), { recursive: true });
    fs.writeFileSync(v.stateDir, 'a file where the state dir should be');
    const r = await installAppCopy(v.args, { exec: fakeExec(), brewApps: [] });
    assert.equal(r.changed, 'none');
    assert.equal(r.recorded, false);
  });

  test('(+) the exec is only ever ditto and lsregister, by absolute path with a fixed argv (no shell, nothing from outside)', async () => {
    const w = world();
    const exec = fakeExec();
    await installAppCopy(w.args, { exec, brewApps: [] });
    for (const [cmd, ...a] of exec.calls) {
      assert.ok([DITTO, LSREGISTER].includes(cmd), cmd);
      assert.ok(a.every((x) => typeof x === 'string' && path.isAbsolute(x) || x === '-f'), a.join(' '));
    }
  });

  test('(+) the marker keeps an earlier "Not now"', async () => {
    const w = world();
    await dismissAppCopy(w.args);
    await installAppCopy(w.args, { exec: fakeExec(), brewApps: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(w.marker, 'utf8')), { managed: true, version: '0.3.0', dismissed: true });
  });

  test('(−) Linux is unsupported and nothing is written', async () => {
    const w = world();
    const exec = fakeExec();
    await rejectsWith(installAppCopy({ ...w.args, platform: 'linux' }, { exec, brewApps: [] }), 'unsupported');
    assert.deepEqual(exec.calls, []);
    assert.equal(fs.existsSync(w.apps), false);
  });

  test('(−) no source: no-source, and ~/Applications is not even created', async () => {
    const w = world({ keg: false });
    const exec = fakeExec();
    await rejectsWith(installAppCopy(w.args, { exec, brewApps: [] }), 'no-source');
    assert.deepEqual(exec.calls, []);
    assert.equal(fs.existsSync(w.apps), false);
    assert.equal(fs.existsSync(w.marker), false);
  });

  test('(−) a symlink, a file, another bundle id, an unreadable plist at the target: foreign-target, nothing written or moved', async () => {
    const w = world();
    const decoy = bundle(path.join(w.root, 'decoy.app'), { id: 'com.example.other', version: '9.9.9' });
    const exec = fakeExec();
    const fsx = spyFs();
    mkApps(w);
    const cases = {
      symlink: () => fs.symlinkSync(decoy, w.target),
      file: () => fs.writeFileSync(w.target, 'not a bundle'),
      'other bundle id': () => bundle(w.target, { id: 'com.example.other' }),
      'unreadable plist': () => { bundle(w.target); fs.writeFileSync(path.join(w.target, 'Contents', 'Info.plist'), 'bplist00'); },
    };
    for (const [name, make] of Object.entries(cases)) {
      fs.rmSync(w.target, { recursive: true, force: true });
      make();
      const before = fs.lstatSync(w.target);
      await rejectsWith(installAppCopy(w.args, { fs: fsx, exec, brewApps: [] }), 'foreign-target');
      assert.equal(fs.lstatSync(w.target).ino, before.ino, `${name}: untouched`);
      assert.deepEqual(leftovers(w.apps), [], name);
    }
    assert.deepEqual(exec.calls, []);
    assert.deepEqual(fsx.ops, []);
    assert.equal(fs.readFileSync(path.join(decoy, 'Contents', 'MacOS', 'nika-app'), 'utf8'), 'payload 9.9.9\n');
    assert.equal(fs.existsSync(w.marker), false);
  });

  test('(−) a target folder owned by someone else is foreign-target', async () => {
    const w = world();
    bundle(w.target, { version: '0.2.0' });
    const exec = fakeExec();
    const foreignOwner = { ...fsp, lstat: async (p) => { const st = await fsp.lstat(p); return p === w.target ? Object.create(st, { uid: { value: UID + 1 } }) : st; } };
    await rejectsWith(installAppCopy(w.args, { fs: foreignOwner, exec, brewApps: [] }), 'foreign-target');
    assert.deepEqual(exec.calls, []);
    assert.equal(versionOf(w.target), '0.2.0');
  });

  test('(−) a group-writable ~/Applications is refused: nothing is copied, moved or recorded', async () => {
    const w = world();
    mkApps(w);
    fs.chmodSync(w.apps, 0o775);
    const exec = fakeExec();
    const fsx = spyFs();
    await rejectsWith(installAppCopy(w.args, { fs: fsx, exec, brewApps: [] }), 'foreign-target');
    assert.deepEqual(exec.calls, []);
    assert.deepEqual(fsx.ops, []);
    assert.deepEqual(fs.readdirSync(w.apps), []);
    assert.equal(fs.existsSync(w.marker), false);
  });

  test('(−) ~/Applications as a symlink or world-writable folder is refused: nothing is created behind the link', async () => {
    const w = world();
    const elsewhere = path.join(w.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, w.apps);
    const exec = fakeExec();
    await rejectsWith(installAppCopy(w.args, { exec, brewApps: [] }), 'foreign-target');
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.rmSync(w.apps);
    mkApps(w);
    fs.chmodSync(w.apps, 0o777);
    await rejectsWith(installAppCopy(w.args, { exec, brewApps: [] }), 'foreign-target');
    assert.deepEqual(exec.calls, []);
    assert.deepEqual(fs.readdirSync(w.apps), []);
  });

  test('(−) the target swapped for a symlink while ditto runs is caught before the swap: foreign-target, decoy untouched, temp removed', async () => {
    const w = world();
    const decoy = bundle(path.join(w.root, 'decoy.app'), { id: 'com.example.other', version: '9.9.9' });
    const exec = fakeExec({ hook: (cmd) => { if (cmd === DITTO) fs.symlinkSync(decoy, w.target); } });
    await rejectsWith(installAppCopy(w.args, { exec, brewApps: [] }), 'foreign-target');
    assert.equal(fs.lstatSync(w.target).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(w.target), decoy);
    assert.equal(fs.readFileSync(path.join(decoy, 'Contents', 'MacOS', 'nika-app'), 'utf8'), 'payload 9.9.9\n');
    assert.deepEqual(leftovers(w.apps), []);
    assert.equal(fs.existsSync(w.marker), false);
  });

  test('(−) ditto fails: copy-failed, the temp folder is gone, the old copy is untouched, no marker, and no path in the error', async () => {
    const w = world();
    bundle(w.target, { version: '0.2.0' });
    const exec = fakeExec({ failDitto: true });
    await assert.rejects(installAppCopy(w.args, { exec, brewApps: [] }), (e) => e.code === 'copy-failed' && e.message === 'copy-failed');
    assert.equal(versionOf(w.target), '0.2.0');
    assert.deepEqual(leftovers(w.apps), []);
    assert.equal(fs.existsSync(w.marker), false);
    assert.equal(exec.calls.length, 1, 'lsregister is not run');
  });

  test('(−) the copy is wrong (other id, other version, a symlink instead of a folder): copy-failed, old copy untouched, temp gone', async () => {
    const w = world();
    bundle(w.target, { version: '0.2.0' });
    const decoy = bundle(path.join(w.root, 'decoy.app'));
    const cases = {
      'other id': (copy) => fs.writeFileSync(path.join(copy, 'Contents', 'Info.plist'), plist({ id: 'com.example.other' })),
      'other version': (copy) => fs.writeFileSync(path.join(copy, 'Contents', 'Info.plist'), plist({ version: '0.1.0' })),
      'symlink': (copy) => { fs.rmSync(copy, { recursive: true }); fs.symlinkSync(decoy, copy); },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const fsx = spyFs();
      await rejectsWith(installAppCopy(w.args, { fs: fsx, exec: fakeExec({ mutate }), brewApps: [] }), 'copy-failed');
      assert.equal(versionOf(w.target), '0.2.0', name);
      assert.deepEqual(leftovers(w.apps), [], name);
      assert.deepEqual(fsx.ops.filter((o) => o[0] === 'rename'), [], `${name}: nothing was moved`);
    }
    assert.equal(fs.existsSync(path.join(decoy, 'Contents', 'Info.plist')), true, 'the decoy behind the symlink survives the cleanup');
  });

  test('(−) the rename of the new copy fails: the old copy is moved back, the temp folder is removed, copy-failed', async () => {
    const w = world();
    bundle(w.target, { version: '0.2.0' });
    const fsx = spyFs((from, to) => to === w.target && from.endsWith(`${path.sep}nika.app`));
    await rejectsWith(installAppCopy(w.args, { fs: fsx, exec: fakeExec(), brewApps: [] }), 'copy-failed');
    assert.equal(versionOf(w.target), '0.2.0');
    assert.deepEqual(await readBundle(w.target), { id: APP_ID, version: '0.2.0' });
    assert.deepEqual(leftovers(w.apps), []);
    const tmp = fsx.ops[0][1];
    assert.deepEqual(fsx.ops.slice(1), [['rename', w.target, path.join(tmp, 'previous.app')], ['rename', path.join(tmp, 'nika.app'), w.target], ['rename', path.join(tmp, 'previous.app'), w.target]]);
    assert.equal(fs.existsSync(w.marker), false);
  });

  test('(−) the rename fails and the old copy cannot be moved back: the temp folder is kept (it holds the old copy) and copy-failed is reported', async () => {
    const w = world();
    bundle(w.target, { version: '0.2.0' });
    const fsx = spyFs((from, to) => to === w.target);
    await rejectsWith(installAppCopy(w.args, { fs: fsx, exec: fakeExec(), brewApps: [] }), 'copy-failed');
    const [kept] = leftovers(w.apps);
    assert.ok(kept, 'temp folder kept');
    assert.equal(versionOf(path.join(w.apps, kept, 'previous.app')), '0.2.0');
  });

  // After the swap the temp folder is removed only if ~/Applications and the temp folder are still what they were.
  // `afterSwap(w, tmp)` runs right after the new copy was renamed into place (inside the rename window).
  const swapRig = (afterSwap) => {
    const base = spyFs();
    const w = world();
    const fsx = {
      ...base,
      rename: async (from, to) => {
        await base.rename(from, to);
        if (to === w.target && from.endsWith(`${path.sep}nika.app`)) afterSwap(w, path.dirname(from));
      },
    };
    return { w, fsx };
  };

  test('(+) after a normal swap the temp folder is removed (the guard lets it go)', async () => {
    const { w, fsx } = swapRig(() => {});
    const r = await installAppCopy(w.args, { fs: fsx, exec: fakeExec(), brewApps: [] });
    assert.equal(r.changed, 'added');
    assert.deepEqual(leftovers(w.apps), []);
  });

  test('(−) ~/Applications swapped for a symlink inside the rename window: the temp folder is kept, nothing behind the link is touched, the install still succeeds', async () => {
    let moved;
    let decoy; // a folder behind the link with the temp folder's exact name: an unguarded rm of <apps>/<tmp name> would remove it
    const { w, fsx } = swapRig((world, tmp) => {
      moved = `${world.apps}-moved`;
      fs.renameSync(world.apps, moved);
      const elsewhere = path.join(world.root, 'elsewhere');
      decoy = path.join(elsewhere, path.basename(tmp));
      fs.mkdirSync(decoy, { recursive: true });
      fs.writeFileSync(path.join(decoy, 'keep.txt'), 'keep');
      fs.symlinkSync(elsewhere, world.apps);
    });
    const r = await installAppCopy(w.args, { fs: fsx, exec: fakeExec(), brewApps: [] });
    assert.equal(r.changed, 'added');
    assert.equal(fs.readFileSync(path.join(decoy, 'keep.txt'), 'utf8'), 'keep', 'the folder behind the link that has the temp name survives');
    assert.deepEqual(fs.readdirSync(path.join(w.root, 'elsewhere')), [path.basename(decoy)], 'nothing else was written behind the link');
    assert.equal(leftovers(moved).length, 1, 'the temp folder is kept');
    assert.deepEqual(await readBundle(path.join(moved, 'nika.app')), { id: APP_ID, version: '0.3.0' }, 'the copy that was swapped in is in the moved folder');
  });

  test('(−) the temp folder swapped for a symlink or for another folder: it is kept and what the link points at is untouched', async () => {
    const decoyFile = (dir) => {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
      return dir;
    };
    const asLink = swapRig((world, tmp) => {
      fs.renameSync(tmp, `${tmp}-moved`);
      fs.symlinkSync(decoyFile(path.join(world.root, 'decoy-link')), tmp);
    });
    await installAppCopy(asLink.w.args, { fs: asLink.fsx, exec: fakeExec(), brewApps: [] });
    assert.equal(fs.readFileSync(path.join(asLink.w.root, 'decoy-link', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(leftovers(asLink.w.apps).length, 2, 'the symlink and the moved folder both stay');

    const asDir = swapRig((world, tmp) => {
      fs.renameSync(tmp, `${tmp}-moved`);
      decoyFile(tmp);
    });
    await installAppCopy(asDir.w.args, { fs: asDir.fsx, exec: fakeExec(), brewApps: [] });
    const [other] = leftovers(asDir.w.apps).filter((n) => !n.endsWith('-moved'));
    assert.equal(fs.readFileSync(path.join(asDir.w.apps, other, 'keep.txt'), 'utf8'), 'keep', 'a different folder under the same name is not removed (inode changed)');
  });

  test('(−) ~/Applications made group-writable inside the rename window: the temp folder is kept', async () => {
    const { w, fsx } = swapRig((world) => fs.chmodSync(world.apps, 0o775));
    const r = await installAppCopy(w.args, { fs: fsx, exec: fakeExec(), brewApps: [] });
    assert.equal(r.changed, 'added');
    assert.equal(leftovers(w.apps).length, 1);
    fs.chmodSync(w.apps, 0o755);
  });

  test('(−) the old copy (aside) replaced by a non-nika folder inside the window: the temp folder is kept with what is in it, nothing is deleted, the install still succeeds', async () => {
    const { w, fsx } = swapRig((world, tmp) => {
      const aside = path.join(tmp, 'previous.app');
      fs.renameSync(aside, path.join(world.root, 'real-old-copy'));
      fs.mkdirSync(path.join(aside, 'Contents'), { recursive: true });
      fs.writeFileSync(path.join(aside, 'keep.txt'), 'keep');
    });
    bundle(w.target, { version: '0.2.0' });
    const r = await installAppCopy(w.args, { fs: fsx, exec: fakeExec(), brewApps: [] });
    assert.deepEqual(r, { state: 'current', version: '0.3.0', restart: false, changed: 'updated', recorded: true });
    assert.deepEqual(await readBundle(w.target), { id: APP_ID, version: '0.3.0' });
    const [kept] = leftovers(w.apps);
    assert.equal(leftovers(w.apps).length, 1, 'the temp folder stays');
    assert.equal(fs.readFileSync(path.join(w.apps, kept, 'previous.app', 'keep.txt'), 'utf8'), 'keep');
  });

  test('(−) the aside swapped for a symlink or for a bundle with another id: kept as well, and the link target is untouched', async () => {
    const link = swapRig((world, tmp) => {
      const aside = path.join(tmp, 'previous.app');
      const decoy = path.join(world.root, 'decoy');
      fs.mkdirSync(decoy);
      fs.writeFileSync(path.join(decoy, 'keep.txt'), 'keep');
      fs.rmSync(aside, { recursive: true });
      fs.symlinkSync(decoy, aside);
    });
    bundle(link.w.target, { version: '0.2.0' });
    assert.equal((await installAppCopy(link.w.args, { fs: link.fsx, exec: fakeExec(), brewApps: [] })).changed, 'updated');
    assert.equal(fs.readFileSync(path.join(link.w.root, 'decoy', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(leftovers(link.w.apps).length, 1);

    const other = swapRig((world, tmp) => {
      fs.rmSync(path.join(tmp, 'previous.app'), { recursive: true });
      bundle(path.join(tmp, 'previous.app'), { id: 'com.example.other' });
    });
    bundle(other.w.target, { version: '0.2.0' });
    assert.equal((await installAppCopy(other.w.args, { fs: other.fsx, exec: fakeExec(), brewApps: [] })).changed, 'updated');
    assert.equal(leftovers(other.w.apps).length, 1);
    assert.deepEqual(await readBundle(path.join(other.w.apps, leftovers(other.w.apps)[0], 'previous.app')), { id: 'com.example.other', version: '0.3.0' });
  });

  test('(+) the aside still nika\'s own bundle: the temp folder is removed as before (an update leaves nothing behind)', async () => {
    const { w, fsx } = swapRig(() => {});
    bundle(w.target, { version: '0.2.0' });
    assert.equal((await installAppCopy(w.args, { fs: fsx, exec: fakeExec(), brewApps: [] })).changed, 'updated');
    assert.deepEqual(leftovers(w.apps), []);
  });

  test('(−) a second install while one runs is copy-busy; the flag is released afterwards, also after a failure', async () => {
    const w = world();
    let release;
    const gate = new Promise((r) => { release = r; });
    const first = installAppCopy(w.args, { exec: fakeExec({ hook: async (cmd) => { if (cmd === DITTO) await gate; } }), brewApps: [] });
    await new Promise((r) => setTimeout(r, 20));
    const exec2 = fakeExec();
    await rejectsWith(installAppCopy(w.args, { exec: exec2, brewApps: [] }), 'copy-busy');
    assert.deepEqual(exec2.calls, []);
    release();
    assert.equal((await first).changed, 'added');
    assert.equal((await installAppCopy(w.args, { exec: fakeExec(), brewApps: [] })).changed, 'none', 'free again');
    bundle(w.target, { version: '0.1.0' });
    const afterFail = await installAppCopy(w.args, { exec: fakeExec({ failDitto: true }), brewApps: [] }).catch((e) => e.code);
    assert.equal(afterFail, 'copy-failed');
    assert.equal((await installAppCopy(w.args, { exec: fakeExec(), brewApps: [] })).changed, 'updated', 'free again after copy-failed');
  });

  test('(−) the source never comes from the marker or the caller\'s extra fields', async () => {
    const w = world();
    const evil = bundle(path.join(w.root, 'evil', 'nika.app'));
    fs.writeFileSync(path.join(evil, 'Contents', 'MacOS', 'nika-app'), 'EVIL\n');
    fs.mkdirSync(w.stateDir, { recursive: true });
    fs.writeFileSync(w.marker, JSON.stringify({ managed: true, source: evil, path: evil, target: evil, dismissed: false }));
    const exec = fakeExec();
    await installAppCopy({ ...w.args, source: evil, target: evil }, { exec, brewApps: [], source: evil });
    assert.equal(exec.calls[0][1], w.kegApp);
    assert.equal(fs.readFileSync(path.join(w.target, 'Contents', 'MacOS', 'nika-app'), 'utf8'), 'payload 0.3.0\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(w.marker, 'utf8')), { managed: true, version: '0.3.0', dismissed: false }, 'the marker holds no path');
  });

  test('(−) removing the old copy never follows a symlink inside it', async () => {
    const w = world();
    const outside = path.join(w.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    bundle(w.target, { version: '0.2.0' });
    fs.symlinkSync(outside, path.join(w.target, 'Contents', 'Frameworks'));
    await installAppCopy(w.args, { exec: fakeExec(), brewApps: [] });
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(w.target, 'Contents', 'Frameworks')), false);
  });

  test('(−) lsregister failing is ignored; so is a marker that cannot be written (the copy is in place)', async () => {
    const w = world();
    const exec = async (cmd, args) => {
      if (cmd === DITTO) { fs.cpSync(args[0], args[1], { recursive: true }); return {}; }
      throw new Error('lsregister failed');
    };
    fs.mkdirSync(path.dirname(w.stateDir), { recursive: true });
    fs.writeFileSync(w.stateDir, 'a file where the state dir should be');
    const r = await installAppCopy(w.args, { exec, brewApps: [] });
    assert.equal(r.changed, 'added');
    assert.equal(r.recorded, false, 'the caller can say the copy will not be refreshed');
    assert.equal(versionOf(w.target), '0.3.0');
  });
});

describe('dismissAppCopy', () => {
  test('(+) writes { managed, version, dismissed: true }, keeping what the marker said, mode 0600', async () => {
    const w = world();
    await dismissAppCopy(w.args, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(w.marker, 'utf8')), { managed: false, version: null, dismissed: true });
    assert.equal(fs.statSync(w.marker).mode & 0o777, 0o600);
    fs.writeFileSync(w.marker, JSON.stringify({ managed: true, version: '0.2.0', dismissed: false }));
    await dismissAppCopy(w.args);
    assert.deepEqual(JSON.parse(fs.readFileSync(w.marker, 'utf8')), { managed: true, version: '0.2.0', dismissed: true });
    assert.equal(fs.existsSync(w.apps), false, 'dismiss never touches ~/Applications');
  });

  test('(−) a state dir that is a symlink is refused and nothing is written behind it', async () => {
    const w = world();
    const elsewhere = path.join(w.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.dirname(w.stateDir), { recursive: true });
    fs.symlinkSync(elsewhere, w.stateDir);
    await assert.rejects(dismissAppCopy(w.args));
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  });
});

describe('refreshManagedCopy', () => {
  const managed = (w, version = '0.2.0') => {
    bundle(w.target, { version });
    fs.mkdirSync(w.stateDir, { recursive: true });
    fs.writeFileSync(w.marker, JSON.stringify({ managed: true, version, dismissed: false }));
  };

  test('(+) a managed stale copy is updated when the source has this CLI\'s version', async () => {
    const w = world({ kegVersion: '0.3.0' });
    managed(w);
    const exec = fakeExec();
    assert.equal(await refreshManagedCopy({ ...w.args, version: '0.3.0' }, { exec, brewApps: [] }), 'updated');
    assert.equal(versionOf(w.target), '0.3.0');
    assert.equal(exec.calls[0][0], DITTO);
  });

  test('(−) an unmanaged copy, a foreign copy and a missing copy are never touched', async () => {
    const w = world();
    const exec = fakeExec();
    const run = () => refreshManagedCopy({ ...w.args, version: '0.3.0' }, { exec, brewApps: [] });
    assert.equal(await run(), 'none', 'missing');
    assert.equal(fs.existsSync(w.apps), false);
    bundle(w.target, { version: '0.2.0' });
    assert.equal(await run(), 'none', 'unmanaged');
    assert.equal(fs.existsSync(w.marker), false, 'a launch-time refresh never writes the marker for a copy nika did not make');
    fs.mkdirSync(w.stateDir, { recursive: true });
    fs.writeFileSync(w.marker, JSON.stringify({ managed: true, version: '0.2.0', dismissed: false }));
    fs.rmSync(w.target, { recursive: true });
    bundle(w.target, { id: 'com.example.other', version: '0.2.0' });
    assert.equal(await run(), 'none', 'managed marker but another app');
    fs.rmSync(w.target, { recursive: true });
    fs.symlinkSync(path.join(w.root, 'keg'), w.target);
    assert.equal(await run(), 'none', 'managed marker but a symlink');
    assert.deepEqual(exec.calls, []);
    assert.equal(versionOf(w.kegApp), '0.3.0');
  });

  test('(−) nothing happens when the source\'s version is not this CLI\'s, when the copy is current, or on Linux', async () => {
    const w = world({ kegVersion: '0.3.0' });
    managed(w);
    const exec = fakeExec();
    assert.equal(await refreshManagedCopy({ ...w.args, version: '0.4.0' }, { exec, brewApps: [] }), 'none', 'source is not this version');
    assert.equal(await refreshManagedCopy({ ...w.args, version: '0.2.0' }, { exec, brewApps: [] }), 'none', 'source is newer than the CLI');
    assert.equal(await refreshManagedCopy({ ...w.args, platform: 'linux', version: '0.3.0' }, { exec, brewApps: [] }), 'none');
    bundle(w.target, { version: '0.3.0' });
    assert.equal(await refreshManagedCopy({ ...w.args, version: '0.3.0' }, { exec, brewApps: [] }), 'none', 'current');
    assert.deepEqual(exec.calls, []);
    // an unmanaged current copy: the launch path must not take it over (only an explicit install does)
    const u = world();
    bundle(u.target, { version: '0.3.0' });
    assert.equal(await refreshManagedCopy({ ...u.args, version: '0.3.0' }, { exec, brewApps: [] }), 'none');
    assert.equal(fs.existsSync(u.marker), false);
  });

  test('(−) a failing update throws the copy error code and leaves the old copy', async () => {
    const w = world();
    managed(w);
    await rejectsWith(refreshManagedCopy({ ...w.args, version: '0.3.0' }, { exec: fakeExec({ failDitto: true }), brewApps: [] }), 'copy-failed');
    assert.equal(versionOf(w.target), '0.2.0');
  });
});
