import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPlugins, listPluginDirs } from '../src/collect/plugins.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-plugins-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh fake config dir whose plugins/installed_plugins.json holds `content` (string or object). */
function claudeDirWith(content) {
  const dir = path.join(root, `c${n += 1}`);
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

describe('listPlugins', () => {
  test('(+) returns the sorted keys of `plugins`, values are ignored', async () => {
    const dir = claudeDirWith({
      version: 2,
      plugins: {
        'zeta@market-one': [{ scope: 'user', installPath: 'SECRET-PATH', version: '1.0.0' }],
        'alpha@market-one': [],
        'mid.dot_x@other-market': { anything: 'SECRET-VALUE' },
      },
    });
    assert.deepEqual(await listPlugins(dir), ['alpha@market-one', 'mid.dot_x@other-market', 'zeta@market-one']);
  });

  test('(+) an empty `plugins` object gives []', async () => {
    assert.deepEqual(await listPlugins(claudeDirWith({ version: 2, plugins: {} })), []);
  });

  test('(+) caps the list at 200 names after sorting', async () => {
    const plugins = {};
    for (let i = 0; i < 250; i += 1) plugins[`p${String(i).padStart(3, '0')}@m`] = [];
    const names = await listPlugins(claudeDirWith({ plugins }));
    assert.equal(names.length, 200);
    assert.equal(names[0], 'p000@m');
    assert.equal(names[199], 'p199@m');
  });

  test('(−) names that do not match PLUGIN_NAME are dropped', async () => {
    const bad = ['noat', '@m', 'p@', 'a b@m', 'p@m/x', '../x@m', 'p@m;rm', '-', 'a@b@c', `${'x'.repeat(101)}@m`, 'p\n@m', ''];
    const plugins = { 'good@m': [] };
    for (const k of bad) plugins[k] = [];
    assert.deepEqual(await listPlugins(claudeDirWith({ plugins })), ['good@m']);
  });

  test('(−) a __proto__ key is just another name that fails PLUGIN_NAME', async () => {
    const dir = claudeDirWith('{"plugins":{"__proto__":{"polluted":true},"ok@m":[]}}');
    assert.deepEqual(await listPlugins(dir), ['ok@m']);
    assert.equal({}.polluted, undefined);
  });

  test('(−) missing file, missing plugins dir and missing config dir give []', async () => {
    assert.deepEqual(await listPlugins(claudeDirWith(undefined)), []);
    const noFile = claudeDirWith({});
    fs.rmSync(path.join(noFile, 'plugins', 'installed_plugins.json'));
    assert.deepEqual(await listPlugins(noFile), []);
    assert.deepEqual(await listPlugins(path.join(root, 'does-not-exist')), []);
  });

  test('(−) invalid JSON, wrong shapes and non-object `plugins` give []', async () => {
    for (const content of ['{not json', '', 'null', '[]', '"text"', '42', '{}', '{"plugins":null}', '{"plugins":[]}', '{"plugins":["a@m"]}', '{"plugins":"a@m"}']) {
      assert.deepEqual(await listPlugins(claudeDirWith(content)), [], content);
    }
  });

  test('(−) a file over 1 MB is not read', async () => {
    const pad = ' '.repeat(1024 * 1024);
    assert.deepEqual(await listPlugins(claudeDirWith(`{"plugins":{"ok@m":[]}}${pad}`)), []);
  });

  test('(−) a symlinked installed_plugins.json is refused (fsafe)', async () => {
    const dir = claudeDirWith({ plugins: {} });
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ plugins: { 'sneaky@m': [] } }));
    fs.rmSync(path.join(dir, 'plugins', 'installed_plugins.json'));
    fs.symlinkSync(target, path.join(dir, 'plugins', 'installed_plugins.json'));
    assert.deepEqual(await listPlugins(dir), []);
  });

  test('(−) a hard-linked installed_plugins.json is refused (fsafe)', async () => {
    const dir = claudeDirWith({ plugins: { 'ok@m': [] } });
    fs.linkSync(path.join(dir, 'plugins', 'installed_plugins.json'), path.join(root, 'second-name.json'));
    assert.deepEqual(await listPlugins(dir), []);
  });

  test('(−) a directory in place of the file is refused', async () => {
    const dir = path.join(root, 'cdir');
    fs.mkdirSync(path.join(dir, 'plugins', 'installed_plugins.json'), { recursive: true });
    assert.deepEqual(await listPlugins(dir), []);
  });
});

describe('listPluginDirs', () => {
  /** A config dir with a plugins cache; `dirs` are created below plugins/cache, `records` become installed_plugins.json. */
  function withCache(records, dirs = []) {
    const dir = claudeDirWith({ version: 2, plugins: records(path.join(root, `c${n + 1}`, 'plugins', 'cache')) });
    for (const d of dirs) fs.mkdirSync(path.join(dir, 'plugins', 'cache', d), { recursive: true });
    return dir;
  }
  const real = (...p) => fs.realpathSync(path.join(...p));

  test('(+) reads names and installPath, sorted by key; other record fields are never returned', async () => {
    const dir = withCache((cache) => ({
      'zeta@market-one': [{ scope: 'user', installPath: path.join(cache, 'market-one', 'zeta', '1.0.0'), version: 'SECRET-VERSION', gitCommitSha: 'SECRET-SHA' }],
      'alpha@market-one': [{ installPath: path.join(cache, 'market-one', 'alpha', '2.0.0') }],
    }), [path.join('market-one', 'zeta', '1.0.0'), path.join('market-one', 'alpha', '2.0.0')]);
    const got = await listPluginDirs(dir);
    assert.deepEqual(got, [
      { name: 'alpha@market-one', installPath: real(dir, 'plugins', 'cache', 'market-one', 'alpha', '2.0.0') },
      { name: 'zeta@market-one', installPath: real(dir, 'plugins', 'cache', 'market-one', 'zeta', '1.0.0') },
    ]);
    assert.ok(!JSON.stringify(got).includes('SECRET'));
  });

  test('(+) takes the first record whose installPath resolves inside the cache; one entry per key', async () => {
    const dir = withCache((cache) => ({
      'p@m': [{ installPath: 7 }, { installPath: path.join(cache, '..', '..', 'outside') }, null, 'text', { installPath: path.join(cache, 'm', 'p', 'v2') }, { installPath: path.join(cache, 'm', 'p', 'v3') }],
    }), [path.join('m', 'p', 'v2'), path.join('m', 'p', 'v3')]);
    fs.mkdirSync(path.join(dir, 'outside'));
    assert.deepEqual(await listPluginDirs(dir), [{ name: 'p@m', installPath: real(dir, 'plugins', 'cache', 'm', 'p', 'v2') }]);
  });

  test('(−) a path outside plugins/cache, the cache root, a sibling prefix, a relative path and a missing dir are dropped', async () => {
    const dir = withCache((cache) => ({
      'out@m': [{ installPath: path.join(cache, '..', '..', 'outside') }],
      'root@m': [{ installPath: cache }],
      'prefix@m': [{ installPath: `${cache}-evil` }],
      'rel@m': [{ installPath: 'plugins/cache/m/rel' }],
      'gone@m': [{ installPath: path.join(cache, 'm', 'gone') }],
      'ok@m': [{ installPath: path.join(cache, 'm', 'ok') }],
    }), [path.join('m', 'rel'), path.join('m', 'ok')]);
    fs.mkdirSync(path.join(dir, 'outside'));
    fs.mkdirSync(path.join(dir, 'plugins', 'cache-evil'));
    assert.deepEqual((await listPluginDirs(dir)).map((e) => e.name), ['ok@m']);
  });

  test('(−) a symlink inside the cache that points outside it is dropped', async () => {
    const dir = withCache((cache) => ({ 'link@m': [{ installPath: path.join(cache, 'm', 'link') }] }), ['m']);
    fs.mkdirSync(path.join(dir, 'outside'));
    fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'plugins', 'cache', 'm', 'link'));
    assert.deepEqual(await listPluginDirs(dir), []);
  });

  test('(−) names that fail PLUGIN_NAME, non-array records and a missing cache dir give no entries', async () => {
    const dir = withCache((cache) => ({
      'bad name@m': [{ installPath: path.join(cache, 'm', 'a') }],
      'obj@m': { installPath: path.join(cache, 'm', 'b') },
      'str@m': 'text',
      'good@m': [{ installPath: path.join(cache, 'm', 'c') }],
    }), [path.join('m', 'a'), path.join('m', 'b'), path.join('m', 'c')]);
    assert.deepEqual((await listPluginDirs(dir)).map((e) => e.name), ['good@m']);
    fs.rmSync(path.join(dir, 'plugins', 'cache'), { recursive: true });
    assert.deepEqual(await listPluginDirs(dir), []);
  });

  test('(−) caps the list at 200 entries', async () => {
    const records = (cache) => Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`p${String(i).padStart(3, '0')}@m`, [{ installPath: path.join(cache, 'm') }]]));
    const got = await listPluginDirs(withCache(records, ['m']));
    assert.equal(got.length, 200);
    assert.equal(got[199].name, 'p199@m');
  });

  test('(−) invalid JSON, wrong shapes, a missing file and a symlinked file give []', async () => {
    for (const content of ['{not json', '', 'null', '[]', '{}', '{"plugins":null}', '{"plugins":[]}']) {
      assert.deepEqual(await listPluginDirs(claudeDirWith(content)), [], content);
    }
    assert.deepEqual(await listPluginDirs(claudeDirWith(undefined)), []);
    const dir = claudeDirWith({ plugins: {} });
    const target = path.join(root, 'elsewhere-dirs.json');
    fs.writeFileSync(target, JSON.stringify({ plugins: { 'sneaky@m': [{ installPath: dir }] } }));
    fs.rmSync(path.join(dir, 'plugins', 'installed_plugins.json'));
    fs.symlinkSync(target, path.join(dir, 'plugins', 'installed_plugins.json'));
    assert.deepEqual(await listPluginDirs(dir), []);
  });
});
