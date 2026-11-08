// Safe writes (T8, T15); temp dirs only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureDir, writeAtomic, checkComponents, backupFile, verifyInside, pruneBackups } from '../src/fwrite.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-fwrite-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const mode = (p) => fs.lstatSync(p).mode & 0o777;
const sub = (n) => {
  const d = path.join(root, n);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

describe('ensureDir + writeAtomic', () => {
  test('(+) creates 0700 dirs, writes 0600 files atomically, overwrites a regular file, leaves no temp file', async () => {
    const dir = path.join(root, 'a', 'nested', 'deep');
    assert.equal(await ensureDir(dir), dir);
    assert.equal(mode(dir), 0o700);
    assert.equal(await ensureDir(dir), dir); // idempotent
    const target = await writeAtomic(dir, 'config.json', '{"a":1}\n');
    assert.equal(target, path.join(dir, 'config.json'));
    assert.equal(mode(target), 0o600);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}\n');
    await writeAtomic(dir, 'config.json', 'v2', { mode: 0o644 });
    assert.equal(fs.readFileSync(target, 'utf8'), 'v2');
    assert.equal(mode(target), 0o644);
    await writeAtomic(dir, '.last-pane', '%5\n');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.last-pane', 'config.json']);
  });

  test('(−) symlinked dir, group-writable dir, file as dir', async () => {
    const real = sub('b/real');
    fs.symlinkSync(real, path.join(root, 'b', 'link'));
    await assert.rejects(writeAtomic(path.join(root, 'b', 'link'), 'x', ''), { code: 'ESYMLINK' });
    await assert.rejects(ensureDir(path.join(root, 'b', 'link')), { code: 'ESYMLINK' });
    const loose = path.join(root, 'b', 'loose');
    fs.mkdirSync(loose, { mode: 0o777 });
    fs.chmodSync(loose, 0o777);
    await assert.rejects(writeAtomic(loose, 'x', ''), { code: 'EMODE' });
    fs.writeFileSync(path.join(root, 'b', 'file'), '');
    await assert.rejects(writeAtomic(path.join(root, 'b', 'file'), 'x', ''), { code: 'ENOTDIR' });
    await assert.rejects(writeAtomic(path.join(root, 'b', 'missing'), 'x', ''), { code: 'ENOENT' });
  });

  test('(−) symlinked, hard-linked and FIFO targets are never written; decoy untouched', async () => {
    const dir = sub('c');
    const decoy = path.join(root, 'c-decoy');
    fs.writeFileSync(decoy, 'DECOY');
    fs.symlinkSync(decoy, path.join(dir, 'sym'));
    fs.linkSync(decoy, path.join(dir, 'hard'));
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    await assert.rejects(writeAtomic(dir, 'sym', 'owned'), { code: 'ESYMLINK' });
    await assert.rejects(writeAtomic(dir, 'hard', 'owned'), { code: 'ENLINK' });
    await assert.rejects(writeAtomic(dir, 'pipe', 'owned'), { code: 'ENOTREG' });
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'DECOY');
    assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), false);
  });

  test('(−) names with a slash, `.` or `..` are refused', async () => {
    const dir = sub('d');
    for (const name of ['a/b', '../x', '.', '..', '', 'x\0y']) await assert.rejects(writeAtomic(dir, name, ''), { code: 'EPATH' }, name);
  });
});

describe('checkComponents', () => {
  test('(+) absent intermediates and real dirs pass; returns dir, name, abs', async () => {
    const r = sub('e');
    fs.mkdirSync(path.join(r, 'rules'));
    assert.deepEqual(await checkComponents(r, 'rules/orchestration.md'), { dir: path.join(r, 'rules'), name: 'orchestration.md', abs: path.join(r, 'rules', 'orchestration.md') });
    assert.deepEqual(await checkComponents(r, '.claude/settings.local.json'), { dir: path.join(r, '.claude'), name: 'settings.local.json', abs: path.join(r, '.claude', 'settings.local.json') });
    assert.equal((await checkComponents(r, 'CLAUDE.md')).dir, r);
  });

  test('(−) `..`, absolute, empty segment, symlinked component, file component, missing root', async () => {
    const r = sub('f');
    fs.symlinkSync(path.join(root, 'e'), path.join(r, 'rules'));
    fs.writeFileSync(path.join(r, 'CLAUDE.md'), '');
    await assert.rejects(checkComponents(r, '../x/y'), { code: 'EPATH' });
    await assert.rejects(checkComponents(r, 'a/../b'), { code: 'EPATH' });
    await assert.rejects(checkComponents(r, '/etc/passwd'), { code: 'EPATH' });
    await assert.rejects(checkComponents(r, 'a//b'), { code: 'EPATH' });
    await assert.rejects(checkComponents(r, './a'), { code: 'EPATH' });
    await assert.rejects(checkComponents(r, 'rules/orchestration.md'), { code: 'ESYMLINK' });
    await assert.rejects(checkComponents(r, 'CLAUDE.md/x'), { code: 'ENOTDIR' });
    await assert.rejects(checkComponents(path.join(root, 'nope'), 'x'), { code: 'EPATH' });
    await assert.rejects(checkComponents(path.join(r, 'rules'), 'x'), { code: 'EPATH' }); // symlinked root
  });
});

describe('backupFile', () => {
  test('(+) copies the current content under the backup root, null when absent', async () => {
    const repo = sub('g/repo');
    fs.mkdirSync(path.join(repo, 'rules'));
    fs.writeFileSync(path.join(repo, 'rules', 'orchestration.md'), '# old\n');
    const backups = path.join(root, 'g', 'backups', '2026-11-08T00-00-00Z');
    const out = await backupFile(path.join(repo, 'rules', 'orchestration.md'), backups, 'rules/orchestration.md');
    assert.equal(out, path.join(backups, 'rules', 'orchestration.md'));
    assert.equal(fs.readFileSync(out, 'utf8'), '# old\n');
    assert.equal(mode(out), 0o600);
    assert.equal(mode(backups), 0o700);
    assert.equal(await backupFile(path.join(repo, 'CLAUDE.md'), backups, 'CLAUDE.md'), null);
  });

  test('(−) a symlinked source is not copied', async () => {
    const d = sub('h');
    fs.writeFileSync(path.join(root, 'h-secret'), 'SECRET');
    fs.symlinkSync(path.join(root, 'h-secret'), path.join(d, 'CLAUDE.md'));
    await assert.rejects(backupFile(path.join(d, 'CLAUDE.md'), path.join(root, 'h-backups'), 'CLAUDE.md'), { code: 'ELOOP' });
    assert.equal(fs.existsSync(path.join(root, 'h-backups')), false);
  });
});

describe('post-write check (F6): the directory chain is still real and the file is inside the root', () => {
  const proj = (n) => {
    const d = fs.realpathSync(sub(n));
    return d;
  };

  test('(+) a write below the root with root set passes: nested real dirs, the file is where it was meant to be', async () => {
    const p = proj('f6-ok');
    const dir = path.join(p, 'rules', 'deep');
    await ensureDir(dir);
    const target = await writeAtomic(dir, 'a.md', 'x', { root: p });
    assert.equal(target, path.join(dir, 'a.md'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'x');
    await writeAtomic(p, 'top.md', 'y', { root: p }); // directly in the root
    await verifyInside(p, target);
    await verifyInside(p, path.join(p, 'top.md'));
  });

  test('(−) a directory swapped for a symlink before the rename: the write is refused with ESYMLINK and the file outside is unlinked', async () => {
    const p = proj('f6-swap');
    const outside = proj('f6-swap-outside');
    fs.mkdirSync(path.join(outside, 'b'), { mode: 0o700 });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'KEEP');
    fs.symlinkSync(outside, path.join(p, 'a')); // `a` was a real dir when checkComponents looked; now it is a link
    const dir = path.join(p, 'a', 'b'); // lstat of the last component follows `a`: the per-write checkDir cannot see the swap
    await assert.rejects(writeAtomic(dir, 'f', 'owned', { root: p }), { code: 'ESYMLINK' });
    assert.equal(fs.existsSync(path.join(outside, 'b', 'f')), false, 'the file that landed outside is gone');
    assert.deepEqual(fs.readdirSync(path.join(outside, 'b')), [], 'no temp file is left either');
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'KEEP');
    // the premise: without `root` the same call lands outside the project
    await writeAtomic(dir, 'f', 'owned');
    assert.equal(fs.readFileSync(path.join(outside, 'b', 'f'), 'utf8'), 'owned');
  });

  test('(−) verifyInside: a swapped directory, a target that is itself a symlink out, and a target outside the root are all refused and unlinked, never followed', async () => {
    const p = proj('f6-direct');
    const outside = proj('f6-direct-outside');
    fs.writeFileSync(path.join(outside, 'secret'), 'SECRET');
    fs.writeFileSync(path.join(outside, 'landed'), 'x');
    fs.symlinkSync(outside, path.join(p, 'swapped'));
    await assert.rejects(verifyInside(p, path.join(p, 'swapped', 'landed')), { code: 'ESYMLINK' });
    assert.equal(fs.existsSync(path.join(outside, 'landed')), false);
    fs.symlinkSync(path.join(outside, 'secret'), path.join(p, 'link.md'));
    await assert.rejects(verifyInside(p, path.join(p, 'link.md')), { code: 'ESYMLINK' });
    assert.equal(fs.existsSync(path.join(p, 'link.md')), false, 'the link itself is removed');
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'SECRET', 'what it pointed at is untouched');
    fs.writeFileSync(path.join(outside, 'elsewhere'), 'x');
    await assert.rejects(verifyInside(p, path.join(outside, 'elsewhere')), { code: 'ESYMLINK' });
  });

  test('(−) a root that is itself a symlink, or a file where a directory should be, is refused', async () => {
    const real = proj('f6-real');
    fs.writeFileSync(path.join(real, 'f'), 'x');
    const link = path.join(root, 'f6-rootlink');
    fs.symlinkSync(real, link);
    await assert.rejects(verifyInside(link, path.join(link, 'f')), { code: 'ESYMLINK' });
    fs.writeFileSync(path.join(real, 'plain'), '');
    await assert.rejects(verifyInside(real, path.join(real, 'plain', 'f')), { code: 'ESYMLINK' });
  });
});

describe('pruneBackups (F2): keep the newest N stamp folders, touch nothing else', () => {
  const stampDir = (dir, name) => {
    fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, name, 'CLAUDE.md'), name);
  };
  const names = (dir) => fs.readdirSync(dir).sort();

  test('(+) removes exactly the oldest beyond `keep`; the -n suffix orders numerically (-2 before -10); the kept ones keep their files', async () => {
    const dir = sub('f2-order');
    const all = ['20261108T030400Z', '20261108T030405Z', '20261108T030405Z-1', '20261108T030405Z-2', '20261108T030405Z-10', '20261109T000000Z'];
    for (const n of all) stampDir(dir, n);
    assert.deepEqual(await pruneBackups(dir, 3), ['20261108T030400Z', '20261108T030405Z', '20261108T030405Z-1']);
    assert.deepEqual(names(dir), ['20261108T030405Z-10', '20261108T030405Z-2', '20261109T000000Z']);
    assert.equal(fs.readFileSync(path.join(dir, '20261109T000000Z', 'CLAUDE.md'), 'utf8'), '20261109T000000Z');
    assert.deepEqual(await pruneBackups(dir, 3), [], 'nothing beyond the limit: nothing removed');
    assert.deepEqual(await pruneBackups(dir, 10), []);
  });

  test('(+) `current` is never removed, a missing folder is nothing to do', async () => {
    const dir = sub('f2-current');
    for (const n of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']) stampDir(dir, n);
    assert.deepEqual(await pruneBackups(dir, 1, '20260101T000000Z'), ['20260102T000000Z']);
    assert.deepEqual(names(dir), ['20260101T000000Z', '20260103T000000Z']);
    assert.deepEqual(await pruneBackups(path.join(root, 'f2-nowhere'), 10), []);
  });

  test('(−) a symlink, a regular file, a foreign name and a look-alike are never deleted, followed or counted', async () => {
    const dir = sub('f2-hostile');
    const outside = sub('f2-hostile-outside');
    fs.writeFileSync(path.join(outside, 'precious'), 'PRECIOUS');
    for (const n of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']) stampDir(dir, n); // the only real backups
    fs.symlinkSync(outside, path.join(dir, '20250101T000000Z')); // oldest name, but a link to a folder elsewhere
    fs.symlinkSync(path.join(root, 'f2-dangling'), path.join(dir, '20250102T000000Z'));
    fs.writeFileSync(path.join(dir, '20250103T000000Z'), 'a file'); // stamp name, regular file
    for (const n of ['notes', '2025', '20250104', '20250104T000000', 'x20250104T000000Z', '20250104T000000Z-100', '20250104T000000Z.bak', '.hidden']) fs.mkdirSync(path.join(dir, n));
    assert.deepEqual(await pruneBackups(dir, 2), ['20260101T000000Z']);
    assert.deepEqual(await pruneBackups(dir, 1), ['20260102T000000Z']);
    assert.deepEqual(names(dir), [
      '.hidden', '2025', '20250101T000000Z', '20250102T000000Z', '20250103T000000Z', '20250104', '20250104T000000', '20250104T000000Z-100',
      '20250104T000000Z.bak', '20260103T000000Z', 'notes', 'x20250104T000000Z',
    ]);
    assert.equal(fs.lstatSync(path.join(dir, '20250101T000000Z')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'PRECIOUS');
    assert.equal(fs.readFileSync(path.join(dir, '20250103T000000Z'), 'utf8'), 'a file');
  });

  test('(−) a backups folder that is a symlink or group-writable is refused: nothing behind it is deleted', async () => {
    const real = sub('f2-realroot');
    for (const n of ['20260101T000000Z', '20260102T000000Z']) stampDir(real, n);
    const link = path.join(root, 'f2-linkroot');
    fs.symlinkSync(real, link);
    await assert.rejects(pruneBackups(link, 1), { code: 'ESYMLINK' });
    fs.chmodSync(real, 0o770);
    await assert.rejects(pruneBackups(real, 1), { code: 'EMODE' });
    assert.deepEqual(names(real), ['20260101T000000Z', '20260102T000000Z']);
  });
});
