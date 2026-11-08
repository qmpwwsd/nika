import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPlugins } from '../src/collect/plugins.js';

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
