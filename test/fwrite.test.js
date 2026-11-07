// Safe writes (T8, T15); temp dirs only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureDir, writeAtomic, checkComponents, backupFile } from '../src/fwrite.js';

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
