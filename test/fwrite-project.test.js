// Project-folder write policy (ADR 0006): world-writable always refused, group-writable only on Linux with the user's own
// group. Platform and gid are injected so the result does not depend on the host OS; temp dirs only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, writeAtomic } from '../src/fwrite.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-fwproj-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const mode = (p) => fs.lstatSync(p).mode & 0o777;
const dirWith = (name, m) => {
  const d = path.join(root, name);
  fs.mkdirSync(d);
  fs.chmodSync(d, m);
  return d;
};
const gidOf = (d) => fs.lstatSync(d).gid;

describe('project: true', () => {
  test('(+) a 0755 project folder is accepted on every platform; files are written 0644', async () => {
    const d = dirWith('plain', 0o755);
    for (const platform of ['linux', 'darwin', 'win32']) {
      assert.equal(await ensureDir(d, 0o755, { project: true, platform }), d);
      await writeAtomic(d, `f-${platform}`, 'x', { mode: 0o644, project: true, platform });
      assert.equal(mode(path.join(d, `f-${platform}`)), 0o644);
    }
  });

  test('(+) created project folders get the requested 0755', async () => {
    const d = path.join(root, 'made', 'rules');
    assert.equal(await ensureDir(d, 0o755, { project: true }), d);
    assert.equal(mode(d), 0o755);
  });

  test('(+) group-writable is accepted on linux when the folder group is the injected primary group', async () => {
    const d = dirWith('grp-ok', 0o775);
    const opts = { project: true, platform: 'linux', gid: gidOf(d) };
    assert.equal(await ensureDir(d, 0o755, opts), d);
    await writeAtomic(d, 'rules.md', 'x', { mode: 0o644, ...opts });
    assert.equal(fs.readFileSync(path.join(d, 'rules.md'), 'utf8'), 'x');
  });

  test('(−) group-writable is refused on linux when the group is not the primary group', async () => {
    const d = dirWith('grp-other', 0o775);
    const opts = { project: true, platform: 'linux', gid: gidOf(d) + 1 };
    await assert.rejects(ensureDir(d, 0o755, opts), { code: 'EMODE' });
    await assert.rejects(writeAtomic(d, 'x', '', opts), { code: 'EMODE' });
    assert.deepEqual(fs.readdirSync(d), []);
  });

  test('(−) group-writable is refused off linux, and when the gid is unknown', async () => {
    const d = dirWith('grp-mac', 0o775);
    for (const opts of [{ platform: 'darwin', gid: gidOf(d) }, { platform: 'win32', gid: gidOf(d) }, { platform: 'linux', gid: null }]) {
      await assert.rejects(ensureDir(d, 0o755, { project: true, ...opts }), { code: 'EMODE' }, JSON.stringify(opts));
      await assert.rejects(writeAtomic(d, 'x', '', { project: true, ...opts }), { code: 'EMODE' }, JSON.stringify(opts));
    }
  });

  test('(−) world-writable is refused on every platform, even with the matching group', async () => {
    const d = dirWith('world', 0o777);
    for (const platform of ['linux', 'darwin']) {
      const opts = { project: true, platform, gid: gidOf(d) };
      await assert.rejects(ensureDir(d, 0o755, opts), { code: 'EMODE' }, platform);
      await assert.rejects(writeAtomic(d, 'x', '', opts), { code: 'EMODE' }, platform);
    }
    const o = dirWith('world-only', 0o757);
    await assert.rejects(ensureDir(o, 0o755, { project: true, platform: 'linux', gid: gidOf(o) }), { code: 'EMODE' });
  });

  test('(−) nika\'s own folders stay strict: without project: true a group-writable folder is refused even on linux', async () => {
    const d = dirWith('strict', 0o775);
    await assert.rejects(ensureDir(d, 0o700, { platform: 'linux', gid: gidOf(d) }), { code: 'EMODE' });
    await assert.rejects(writeAtomic(d, 'x', '', { platform: 'linux', gid: gidOf(d) }), { code: 'EMODE' });
    await assert.rejects(ensureDir(d), { code: 'EMODE' });
    await assert.rejects(writeAtomic(d, 'x', ''), { code: 'EMODE' });
  });

  test('(−) project: true still refuses symlinked and non-directory folders', async () => {
    const real = dirWith('real', 0o755);
    fs.symlinkSync(real, path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'file'), '');
    await assert.rejects(ensureDir(path.join(root, 'link'), 0o755, { project: true }), { code: 'ESYMLINK' });
    await assert.rejects(writeAtomic(path.join(root, 'link'), 'x', '', { project: true }), { code: 'ESYMLINK' });
    await assert.rejects(writeAtomic(path.join(root, 'file'), 'x', '', { project: true }), { code: 'ENOTDIR' });
  });
});
