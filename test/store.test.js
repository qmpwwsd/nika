// Config store and project registry; temp dirs only, synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir, stateDir, reportsDir, backupsDir } from '../src/paths.js';
import { defaults, loadConfig, saveConfig, addProject, removeProject, listProjects, updateSettings, keyFor } from '../src/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-store-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const fresh = (n) => {
  const env = { NIKA_CONFIG_DIR: path.join(root, n, 'cfg'), XDG_STATE_HOME: path.join(root, n, 'state') };
  fs.mkdirSync(env.NIKA_CONFIG_DIR, { recursive: true });
  return env;
};
const mode = (p) => fs.statSync(p).mode & 0o777;

describe('paths', () => {
  test('(+) config and state dirs follow NIKA_CONFIG_DIR / XDG and end in /nika', () => {
    const env = { NIKA_CONFIG_DIR: '/x/cfg', XDG_STATE_HOME: '/x/state' };
    assert.equal(configDir(env), '/x/cfg/nika');
    assert.equal(stateDir(env), '/x/state/nika');
    assert.equal(configDir({ XDG_CONFIG_HOME: '/x/xdg' }), '/x/xdg/nika');
    assert.equal(configDir({}), path.join(os.homedir(), '.config', 'nika'));
    assert.equal(stateDir({}), path.join(os.homedir(), '.local', 'state', 'nika'));
    assert.equal(reportsDir('0123456789abcdef', env), '/x/state/nika/projects/0123456789abcdef/reports');
    assert.equal(backupsDir('0123456789abcdef', env), '/x/state/nika/backups/0123456789abcdef');
  });

  test('(−) relative NIKA_CONFIG_DIR / XDG values are ignored, never resolved against the cwd', () => {
    assert.equal(configDir({ NIKA_CONFIG_DIR: 'cfg', XDG_CONFIG_HOME: '/x/xdg' }), '/x/xdg/nika');
    assert.equal(configDir({ NIKA_CONFIG_DIR: './cfg', XDG_CONFIG_HOME: 'rel' }), path.join(os.homedir(), '.config', 'nika'));
    assert.equal(stateDir({ XDG_STATE_HOME: 'state' }), path.join(os.homedir(), '.local', 'state', 'nika'));
  });

  test('(−) project dirs refuse a malformed key', () => {
    assert.throws(() => reportsDir('../etc', {}), { code: 'EINVAL' });
    assert.throws(() => backupsDir('0123456789ABCDEF', {}), { code: 'EINVAL' });
  });
});

describe('config load/save', () => {
  test('(+) missing file yields defaults without warnings; save writes 0600 in a 0700 dir', async () => {
    const env = fresh('a');
    const { config, warnings } = await loadConfig(env);
    assert.deepEqual(config, defaults());
    assert.deepEqual(warnings, []);
    const file = await saveConfig(config, env);
    assert.equal(file, path.join(configDir(env), 'config.json'));
    assert.equal(mode(file), 0o600);
    assert.equal(mode(configDir(env)), 0o700);
    assert.deepEqual(fs.readdirSync(configDir(env)), ['config.json']); // no temp file left behind
    assert.deepEqual((await loadConfig(env)).config, defaults());
  });

  test('(−) tampered file: bad JSON, unknown keys, wrong types, __proto__ and bypassPermissions all fall back with warnings', async () => {
    const env = fresh('b');
    const dir = configDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{not json');
    let r = await loadConfig(env);
    assert.deepEqual(r.config, defaults());
    assert.match(r.warnings[0], /unreadable/);

    fs.writeFileSync(file, JSON.stringify({
      models: { orchestrator: 'opus', builder: 'gpt-5', extra: 1 },
      permissionMode: 'bypassPermissions',
      panePlacement: 'floating',
      limits: { maxAgents: 99, maxTurns: '80' },
      plugins: { perProject: { zzzz: ['a@b'], '0123456789abcdef': ['ok@market', 'bad plugin'] } },
      projects: [{ key: 'nope', dir: '/p', name: 'p' }, 'junk'],
      rules: { localTemplate: '../x.md' },
      __proto__: { polluted: true },
      evil: 1,
    }));
    r = await loadConfig(env);
    const d = defaults();
    assert.deepEqual(r.config, { ...d, models: { ...d.models, orchestrator: 'opus' } });
    assert.equal(Object.prototype.hasOwnProperty.call(r.config, '__proto__'), false);
    assert.equal(r.config.polluted, undefined);
    assert.ok(r.warnings.length >= 9, r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => w.includes('permissionMode')));
    assert.ok(r.warnings.some((w) => w.includes('unknown key evil')));
  });

  test('(−) a symlinked config.json is not followed', async () => {
    const env = fresh('c');
    const dir = configDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'c', 'outside.json'), JSON.stringify({ permissionMode: 'auto' }));
    fs.symlinkSync(path.join(root, 'c', 'outside.json'), path.join(dir, 'config.json'));
    const r = await loadConfig(env);
    assert.equal(r.config.permissionMode, 'default');
    assert.equal(r.warnings.length, 1);
  });

  test('(−) saveConfig refuses invalid settings', async () => {
    await assert.rejects(saveConfig({ permissionMode: 'bypassPermissions' }, fresh('d')), { code: 'EINVAL' });
  });
});

describe('project registry', () => {
  test('(+) add (realpath, sha256 key, basename), duplicate returns the same, list, remove', async () => {
    const env = fresh('e');
    const dir = path.join(root, 'e', 'My Repo');
    fs.mkdirSync(dir);
    const link = path.join(root, 'e', 'link');
    fs.symlinkSync(dir, link);
    const p = await addProject(link, env);
    const real = fs.realpathSync(dir);
    assert.equal(p.dir, real);
    assert.equal(p.name, 'My Repo');
    assert.equal(p.key, crypto.createHash('sha256').update(real).digest('hex').slice(0, 16));
    assert.equal(p.key, keyFor(real));
    assert.match(p.addedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await addProject(dir, env), p);
    assert.deepEqual(await listProjects(env), [p]);
    await updateSettings({ plugins: { perProject: { [p.key]: ['x@y'] } } }, env);
    assert.equal(await removeProject(p.key, env), true);
    assert.equal(await removeProject(p.key, env), false);
    const { config } = await loadConfig(env);
    assert.deepEqual(config.projects, []);
    assert.deepEqual(config.plugins.perProject, {});
  });

  test('(−) relative path, missing dir, file and bad key are refused', async () => {
    const env = fresh('f');
    await assert.rejects(addProject('relative/dir', env), { code: 'EPATH' });
    await assert.rejects(addProject(path.join(root, 'f', 'missing'), env), { code: 'ENOENT' });
    fs.writeFileSync(path.join(root, 'f', 'file'), '');
    await assert.rejects(addProject(path.join(root, 'f', 'file'), env), { code: 'ENOTDIR' });
    await assert.rejects(removeProject('../../etc', env), { code: 'EINVAL' });
    assert.deepEqual(await listProjects(env), []);
  });
});

describe('updateSettings', () => {
  test('(+) partial patch merges one level deep, aliases accepted, result reloaded from disk', async () => {
    const env = fresh('g');
    const c = await updateSettings({ models: { scout: 'haiku' }, remoteControl: { enabled: true, prefix: 'team-x' }, limits: { maxAgents: 5 }, permissionMode: 'plan' }, env);
    assert.equal(c.models.scout, 'haiku');
    assert.equal(c.models.orchestrator, 'claude-fable-5-1');
    assert.deepEqual(c.remoteControl, { enabled: true, prefix: 'team-x' });
    assert.deepEqual(c.limits, { maxAgents: 5 });
    assert.equal(c.permissionMode, 'plan');
    assert.deepEqual((await loadConfig(env)).config, c);
    for (const m of ['default', 'manual', 'acceptEdits', 'auto', 'dontAsk']) assert.equal((await updateSettings({ permissionMode: m }, env)).permissionMode, m);
  });

  test('(−) bypassPermissions, bad model, unknown key, projects, bad plugin name and bad prefix are rejected', async () => {
    const env = fresh('h');
    for (const patch of [
      { permissionMode: 'bypassPermissions' },
      { models: { builder: 'gpt-5' } },
      { models: { builder: 'claude-x' } },
      { shell: true },
      { projects: [] },
      { plugins: { perProject: { '0123456789abcdef': ['no-marketplace'] } } },
      { remoteControl: { prefix: '-x' } },
      { panePlacement: 'floating' },
      { limits: { maxAgents: 0 } },
      { limits: { maxTurns: 80 } },
      { models: null },
      { limits: 'x' },
      { plugins: [] },
      'nope',
    ]) await assert.rejects(updateSettings(patch, env), { code: 'EINVAL' }, JSON.stringify(patch));
    assert.deepEqual((await loadConfig(env)).config, defaults());
  });
});

describe('mutation queue', () => {
  const dirs = (env, n) => Array.from({ length: n }, (_, i) => {
    const d = path.join(root, path.basename(path.dirname(env.NIKA_CONFIG_DIR)), `proj-${i}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  });

  test('(+) ten concurrent addProject calls are all saved', async () => {
    const env = fresh('q1');
    const added = await Promise.all(dirs(env, 10).map((d) => addProject(d, env)));
    assert.equal(new Set(added.map((p) => p.key)).size, 10);
    const saved = await listProjects(env);
    assert.deepEqual(saved.map((p) => p.key).sort(), added.map((p) => p.key).sort());
  });

  test('(+) concurrent add, remove and settings changes all land, in call order', async () => {
    const env = fresh('q2');
    const [a, b, c] = dirs(env, 3);
    const first = await addProject(a, env);
    const [, , , removed, settings] = await Promise.all([
      addProject(b, env),
      addProject(c, env),
      updateSettings({ limits: { maxAgents: 4 } }, env),
      removeProject(first.key, env),
      updateSettings({ permissionMode: 'plan' }, env),
    ]);
    assert.equal(removed, true);
    assert.equal(settings.permissionMode, 'plan');
    const { config } = await loadConfig(env);
    assert.deepEqual(config.projects.map((p) => path.basename(p.dir)).sort(), ['proj-1', 'proj-2']);
    assert.equal(config.limits.maxAgents, 4);
    assert.equal(config.permissionMode, 'plan');
  });

  test('(−) a rejected mutation does not block or lose the ones queued after it', async () => {
    const env = fresh('q3');
    const [a, b] = dirs(env, 2);
    const results = await Promise.allSettled([
      addProject(a, env),
      addProject('relative/dir', env),
      updateSettings({ permissionMode: 'bypassPermissions' }, env),
      removeProject('nothere', env),
      saveConfig({ ...defaults(), shell: true }, env),
      addProject(b, env),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'rejected', 'rejected', 'rejected', 'fulfilled']);
    assert.deepEqual(results.slice(1, 5).map((r) => r.reason.code), ['EPATH', 'EINVAL', 'EINVAL', 'EINVAL']);
    assert.equal((await listProjects(env)).length, 2);
  });

  test('(−) updateSettings refuses an own __proto__ key and leaves the prototype and the file alone', async () => {
    const env = fresh('q4');
    await assert.rejects(updateSettings(JSON.parse('{"__proto__":{"limits":{"maxAgents":8}}}'), env), { code: 'EINVAL' });
    assert.equal(({}).limits, undefined);
    assert.deepEqual((await loadConfig(env)).config, defaults());
  });
});
