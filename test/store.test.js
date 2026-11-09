// Config store and project registry; temp dirs only, synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir, stateDir, reportsDir, backupsDir } from '../src/paths.js';
import { defaults, loadConfig, saveConfig, addProject, removeProject, listProjects, updateSettings, getProjectConfig, updateProjectConfig, getOrchestrator, setOrchestrator, effectiveModels, keyFor } from '../src/store.js';

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
      perProject: { zzzz: { plugins: ['a@b'] }, '0123456789abcdef': { plugins: ['ok@market', 'bad plugin'] } },
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
    await updateProjectConfig(p.key, { plugins: ['x@y'] }, env);
    assert.equal(await removeProject(p.key, env), true);
    assert.equal(await removeProject(p.key, env), false);
    const { config } = await loadConfig(env);
    assert.deepEqual(config.projects, []);
    assert.deepEqual(config.perProject, {});
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
      { perProject: { '0123456789abcdef': { plugins: ['ok@market'] } } },
      { perProject: {} },
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

describe('ui.theme', () => {
  const dirOf = (env) => { fs.mkdirSync(configDir(env), { recursive: true, mode: 0o700 }); return path.join(configDir(env), 'config.json'); };

  test('(+) default is system; light and dark are saved, merged one level deep and reloaded', async () => {
    const env = fresh('ui1');
    assert.deepEqual(defaults().ui, { theme: 'system', singleKeyShortcuts: true });
    assert.deepEqual((await loadConfig(env)).config.ui, { theme: 'system', singleKeyShortcuts: true });
    assert.equal((await updateSettings({ ui: { theme: 'dark' } }, env)).ui.theme, 'dark');
    assert.equal((await loadConfig(env)).config.ui.theme, 'dark');
    assert.equal((await updateSettings({ permissionMode: 'plan' }, env)).ui.theme, 'dark', 'an unrelated patch keeps the theme');
    assert.equal((await updateSettings({ ui: { theme: 'light' } }, env)).ui.theme, 'light');
    assert.equal((await updateSettings({ ui: { theme: 'system' } }, env)).ui.theme, 'system');
  });

  test('(+) a config.json written before 0.2 (no ui group) loads with the default and no warning', async () => {
    const env = fresh('ui2');
    fs.writeFileSync(dirOf(env), JSON.stringify({ permissionMode: 'plan' }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.ui, { theme: 'system', singleKeyShortcuts: true });
    assert.deepEqual(r.warnings, []);
  });

  test('(−) a bad value in config.json falls back to system with a warning; unknown ui keys are dropped', async () => {
    const env = fresh('ui3');
    for (const bad of ['sepia', 'DARK', '', null, 1, ['dark'], { theme: 'dark' }]) {
      fs.writeFileSync(dirOf(env), JSON.stringify({ ui: { theme: bad } }));
      const r = await loadConfig(env);
      assert.equal(r.config.ui.theme, 'system', JSON.stringify(bad));
      assert.ok(r.warnings.some((w) => w.includes('ui.theme')), JSON.stringify(bad));
    }
    fs.writeFileSync(dirOf(env), JSON.stringify({ ui: { theme: 'light', accent: 'red' } }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.ui, { theme: 'light', singleKeyShortcuts: true });
    assert.ok(r.warnings.some((w) => w.includes('unknown key ui.accent')));
    fs.writeFileSync(dirOf(env), JSON.stringify({ ui: 'dark' }));
    const s = await loadConfig(env);
    assert.deepEqual(s.config.ui, { theme: 'system', singleKeyShortcuts: true });
    assert.ok(s.warnings.some((w) => w.includes('ui invalid')));
  });

  test('(−) updateSettings and saveConfig refuse a bad theme (EINVAL) and leave the file alone', async () => {
    const env = fresh('ui4');
    await updateSettings({ ui: { theme: 'dark' } }, env);
    for (const patch of [{ ui: { theme: 'sepia' } }, { ui: { theme: null } }, { ui: { theme: 5 } }, { ui: 'dark' }, { ui: { accent: 'red' } }, { ui: null }]) {
      await assert.rejects(updateSettings(patch, env), { code: 'EINVAL' }, JSON.stringify(patch));
    }
    await assert.rejects(saveConfig({ ...defaults(), ui: { theme: 'neon' } }, env), { code: 'EINVAL' });
    assert.equal((await loadConfig(env)).config.ui.theme, 'dark');
  });
});

describe('ui.singleKeyShortcuts', () => {
  const fileOf = (env) => { fs.mkdirSync(configDir(env), { recursive: true, mode: 0o700 }); return path.join(configDir(env), 'config.json'); };

  test('(+) defaults to true, also for a config.json written before 0.3, with no warning', async () => {
    const env = fresh('sk1');
    assert.equal(defaults().ui.singleKeyShortcuts, true);
    assert.equal((await loadConfig(env)).config.ui.singleKeyShortcuts, true);
    fs.writeFileSync(fileOf(env), JSON.stringify({ ui: { theme: 'dark' } }));
    const r = await loadConfig(env);
    assert.equal(r.config.ui.singleKeyShortcuts, true);
    assert.deepEqual(r.warnings, []);
  });

  test('(+) false round-trips, merges one level deep with the theme, and survives an unrelated patch', async () => {
    const env = fresh('sk2');
    assert.deepEqual((await updateSettings({ ui: { singleKeyShortcuts: false } }, env)).ui, { theme: 'system', singleKeyShortcuts: false });
    assert.equal((await loadConfig(env)).config.ui.singleKeyShortcuts, false);
    assert.deepEqual((await updateSettings({ ui: { theme: 'dark' } }, env)).ui, { theme: 'dark', singleKeyShortcuts: false }, 'a theme patch keeps the switch');
    assert.equal((await updateSettings({ permissionMode: 'plan' }, env)).ui.singleKeyShortcuts, false);
    assert.equal((await updateSettings({ ui: { singleKeyShortcuts: true } }, env)).ui.singleKeyShortcuts, true);
    assert.equal(JSON.parse(fs.readFileSync(fileOf(env), 'utf8')).ui.singleKeyShortcuts, true);
  });

  test('(−) a non-boolean value in config.json reads as true, with a warning naming the field', async () => {
    const env = fresh('sk3');
    for (const bad of ['false', 'no', 0, 1, null, [], {}, [false]]) {
      fs.writeFileSync(fileOf(env), JSON.stringify({ ui: { singleKeyShortcuts: bad } }));
      const r = await loadConfig(env);
      assert.equal(r.config.ui.singleKeyShortcuts, true, JSON.stringify(bad));
      assert.ok(r.warnings.some((w) => w.includes('ui.singleKeyShortcuts')), JSON.stringify(bad));
    }
  });

  test('(−) updateSettings and saveConfig refuse a non-boolean (EINVAL) and leave the saved value alone', async () => {
    const env = fresh('sk4');
    await updateSettings({ ui: { singleKeyShortcuts: false } }, env);
    for (const bad of ['false', 0, null, [], {}, 'off']) {
      await assert.rejects(updateSettings({ ui: { singleKeyShortcuts: bad } }, env), { code: 'EINVAL' }, JSON.stringify(bad));
    }
    await assert.rejects(saveConfig({ ...defaults(), ui: { theme: 'system', singleKeyShortcuts: 'yes' } }, env), { code: 'EINVAL' });
    assert.equal((await loadConfig(env)).config.ui.singleKeyShortcuts, false);
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

describe('per-project config (0.3.4: perProject[key].plugins)', () => {
  const KEY = '0123456789abcdef';
  const NO_MODELS = { orchestrator: null, reasoner: null, builder: null, scout: null };
  const cfgFile = (env) => { fs.mkdirSync(configDir(env), { recursive: true, mode: 0o700 }); return path.join(configDir(env), 'config.json'); };
  const project = async (env, name = 'repo') => {
    const dir = path.join(root, env.NIKA_CONFIG_DIR.split(path.sep).at(-2), name);
    fs.mkdirSync(dir, { recursive: true });
    return addProject(dir, env);
  };

  test('(+) the default is an empty map and there is no plugins group any more', async () => {
    const d = defaults();
    assert.deepEqual(d.perProject, {});
    assert.equal('plugins' in d, false);
    assert.deepEqual((await loadConfig(fresh('pp0'))).config.perProject, {});
  });

  test('(+) a config with the legacy plugins.perProject loads as perProject[key].plugins, with no warning, and the next save writes only the new shape', async () => {
    const env = fresh('pp1');
    fs.writeFileSync(cfgFile(env), JSON.stringify({ plugins: { perProject: { [KEY]: ['a@demo-market', 'b@demo-market', 'a@demo-market'], fedcba9876543210: [] } } }));
    const r = await loadConfig(env);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.config.perProject, { [KEY]: { plugins: ['a@demo-market', 'b@demo-market'] } }, 'the legacy [] is "none": no entry');
    assert.equal('plugins' in r.config, false);
    await updateSettings({ limits: { maxAgents: 2 } }, env);
    const disk = JSON.parse(fs.readFileSync(cfgFile(env), 'utf8'));
    assert.equal('plugins' in disk, false, 'the legacy key is not written back');
    assert.deepEqual(disk.perProject[KEY], { plugins: ['a@demo-market', 'b@demo-market'] });
  });

  test('(+) when both shapes are present perProject wins and the legacy key is dropped without a warning', async () => {
    const env = fresh('pp2');
    fs.writeFileSync(cfgFile(env), JSON.stringify({ perProject: { [KEY]: { plugins: ['new@demo-market'] } }, plugins: { perProject: { [KEY]: ['old@demo-market'], fedcba9876543210: ['x@demo-market'] } } }));
    const r = await loadConfig(env);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.config.perProject, { [KEY]: { plugins: ['new@demo-market'] } });
  });

  test('(−) a legacy entry that is not a list, or a key that is not a project key, is dropped with a warning', async () => {
    const env = fresh('pp3');
    fs.writeFileSync(cfgFile(env), JSON.stringify({ plugins: { perProject: { [KEY]: 'a@demo-market', zzzz: ['a@demo-market'] } } }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.perProject, {});
    assert.equal(r.warnings.length, 2, r.warnings.join('\n'));
    assert.ok(r.warnings.every((w) => w.startsWith('perProject.')), r.warnings.join('\n'));
  });

  test('(+) get, update (deduplicated, saved), replace and remove through [] (the entry goes when it becomes empty)', async () => {
    const env = fresh('pp4');
    const p = await project(env);
    assert.deepEqual(await getProjectConfig(p.key, env), { plugins: [], models: NO_MODELS });
    assert.deepEqual(await updateProjectConfig(p.key, { plugins: ['b@demo-market', 'a@demo-market', 'b@demo-market'] }, env), { plugins: ['b@demo-market', 'a@demo-market'], models: NO_MODELS });
    assert.deepEqual(await getProjectConfig(p.key, env), { plugins: ['b@demo-market', 'a@demo-market'], models: NO_MODELS });
    assert.deepEqual((await loadConfig(env)).config.perProject, { [p.key]: { plugins: ['b@demo-market', 'a@demo-market'] } });
    assert.equal(fs.statSync(cfgFile(env)).mode & 0o777, 0o600);
    assert.deepEqual(await updateProjectConfig(p.key, { plugins: ['c@demo-market'] }, env), { plugins: ['c@demo-market'], models: NO_MODELS });
    assert.deepEqual(await updateProjectConfig(p.key, { plugins: [] }, env), { plugins: [], models: NO_MODELS });
    assert.deepEqual((await loadConfig(env)).config.perProject, {});
    assert.deepEqual(await getProjectConfig(p.key, env), { plugins: [], models: NO_MODELS });
  });

  test('(+) a project keeps its own list; removeProject deletes it; updateSettings keeps perProject untouched', async () => {
    const env = fresh('pp5');
    const a = await project(env, 'one');
    const b = await project(env, 'two');
    await updateProjectConfig(a.key, { plugins: ['a@demo-market'] }, env);
    await updateProjectConfig(b.key, { plugins: ['b@demo-market'] }, env);
    await updateSettings({ permissionMode: 'plan' }, env);
    assert.deepEqual((await loadConfig(env)).config.perProject, { [a.key]: { plugins: ['a@demo-market'] }, [b.key]: { plugins: ['b@demo-market'] } });
    assert.equal(await removeProject(a.key, env), true);
    assert.deepEqual((await loadConfig(env)).config.perProject, { [b.key]: { plugins: ['b@demo-market'] } });
  });

  test('(+) concurrent updates for two projects both survive (one serial queue)', async () => {
    const env = fresh('pp6');
    const a = await project(env, 'one');
    const b = await project(env, 'two');
    await Promise.all([updateProjectConfig(a.key, { plugins: ['a@demo-market'] }, env), updateProjectConfig(b.key, { plugins: ['b@demo-market'] }, env), updateSettings({ limits: { maxAgents: 4 } }, env)]);
    const { config } = await loadConfig(env);
    assert.deepEqual(Object.keys(config.perProject).sort(), [a.key, b.key].sort());
    assert.equal(config.limits.maxAgents, 4);
  });

  test('(−) a bad project key is EINVAL for get and update', async () => {
    const env = fresh('pp7');
    for (const key of ['', 'short', '0123456789ABCDEF', '../../etc/x', '__proto__', 5, null, undefined]) {
      await assert.rejects(getProjectConfig(key, env), { code: 'EINVAL' }, String(key));
      await assert.rejects(updateProjectConfig(key, { plugins: [] }, env), { code: 'EINVAL' }, String(key));
    }
  });

  test('(−) a key that is not a registered project is ENOENT and nothing is written', async () => {
    const env = fresh('pp8');
    await assert.rejects(updateProjectConfig(KEY, { plugins: ['a@demo-market'] }, env), { code: 'ENOENT' });
    assert.deepEqual((await loadConfig(env)).config.perProject, {});
    assert.equal(fs.existsSync(cfgFile(env)), false, 'no config.json was created for a refused update');
  });

  test('(−) more than 200 plugins, a name that is not PLUGIN_NAME, a non-string and a non-list are EINVAL', async () => {
    const env = fresh('pp9');
    const p = await project(env);
    const many = Array.from({ length: 201 }, (_, i) => `p${i}@demo-market`);
    const ok = Array.from({ length: 200 }, (_, i) => `p${i}@demo-market`);
    assert.deepEqual((await updateProjectConfig(p.key, { plugins: ok }, env)).plugins.length, 200);
    for (const plugins of [many, ['no-marketplace'], ['bad name@demo-market'], [5], [['a@demo-market']], [null], 'a@demo-market', null, {}, ['a@demo-market', '']]) {
      await assert.rejects(updateProjectConfig(p.key, { plugins }, env), { code: 'EINVAL' }, JSON.stringify(plugins).slice(0, 60));
    }
    assert.equal((await getProjectConfig(p.key, env)).plugins.length, 200, 'the saved list is untouched by refused updates');
  });

  test('(−) a patch with another key (not plugins, not models), no key, extra keys, a non-object or an own __proto__ is EINVAL', async () => {
    const env = fresh('pp10');
    const p = await project(env);
    for (const patch of [{ limits: { maxAgents: 2 } }, {}, { plugins: [], models: {} }, [], 'plugins', null, 5, JSON.parse('{"__proto__":{"plugins":["a@demo-market"]}}'), JSON.parse('{"plugins":[],"__proto__":[]}'), Object.create({ plugins: [] })]) {
      await assert.rejects(updateProjectConfig(p.key, patch, env), { code: 'EINVAL' }, JSON.stringify(patch));
    }
    assert.equal(({}).plugins, undefined);
    assert.deepEqual((await loadConfig(env)).config.perProject, {});
  });

  test('(−) updateSettings refuses perProject (it is saved on the project page) and the old plugins group', async () => {
    const env = fresh('pp11');
    await assert.rejects(updateSettings({ perProject: { [KEY]: { plugins: ['a@demo-market'] } } }, env), (e) => e.code === 'EINVAL' && /project page/.test(e.message));
    await assert.rejects(updateSettings({ plugins: { perProject: { [KEY]: ['a@demo-market'] } } }, env), { code: 'EINVAL' });
    assert.deepEqual((await loadConfig(env)).config, defaults());
  });

  test('(+) an empty list is a valid "none": it loads as no entry and no warning, alone or beside other keys of the entry', async () => {
    const env = fresh('pp13');
    fs.writeFileSync(cfgFile(env), JSON.stringify({ perProject: { [KEY]: { plugins: [] }, fedcba9876543210: { plugins: [], colour: 'red' }, '0000000000000000': {} } }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.perProject, {});
    assert.deepEqual(r.warnings, ['unknown key perProject.fedcba9876543210.colour dropped']);
    await updateSettings({ limits: { maxAgents: 2 } }, env);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile(env), 'utf8')).perProject, {}, 'nothing empty is written back');
  });

  test('(−) a hand-edited file: a bad list drops that entry, unknown inner keys drop with a warning, a non-string name never passes', async () => {
    const env = fresh('pp12');
    fs.writeFileSync(cfgFile(env), JSON.stringify({
      perProject: {
        [KEY]: { plugins: ['ok@demo-market'], colour: 'red' },
        fedcba9876543210: { plugins: [['a@demo-market']] },
        '0000000000000000': { plugins: Array.from({ length: 201 }, (_, i) => `p${i}@demo-market`) },
        '1111111111111111': 'a@demo-market',
        '2222222222222222': { plugins: 'a@demo-market' },
        '3333333333333333': { plugins: [] },
        'BAD KEY': { plugins: [] },
      },
    }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.perProject, { [KEY]: { plugins: ['ok@demo-market'] } }, 'an empty list is "none": no entry');
    assert.equal(r.warnings.length, 6, r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => /unknown key perProject\.0123456789abcdef\.colour/.test(w)), r.warnings.join('\n'));
  });
});

describe('per-project orchestrator pick (0.4: perProject[key].orchestratorSessionId)', () => {
  const KEY = '0123456789abcdef';
  const ID = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  const LOWER = 'abababab-abab-4bab-8bab-abababababab'; // has letters, so its upper-case form differs
  const cfgFile = (env) => { fs.mkdirSync(configDir(env), { recursive: true, mode: 0o700 }); return path.join(configDir(env), 'config.json'); };
  const project = async (env, name = 'repo') => {
    const dir = path.join(root, env.NIKA_CONFIG_DIR.split(path.sep).at(-2), name);
    fs.mkdirSync(dir, { recursive: true });
    return addProject(dir, env);
  };

  test('(+) set, get and clear through null: the id is saved at 0600 and the entry goes with it', async () => {
    const env = fresh('op1');
    const p = await project(env);
    assert.equal(await getOrchestrator(p.key, env), null);
    assert.equal(await setOrchestrator(p.key, ID, env), ID);
    assert.equal(await getOrchestrator(p.key, env), ID);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile(env), 'utf8')).perProject, { [p.key]: { orchestratorSessionId: ID } });
    assert.equal(fs.statSync(cfgFile(env)).mode & 0o777, 0o600);
    assert.equal(await setOrchestrator(p.key, ID2, env), ID2, 'replacing a pick is allowed');
    assert.equal(await setOrchestrator(p.key, null, env), null);
    assert.equal(await getOrchestrator(p.key, env), null);
    assert.deepEqual((await loadConfig(env)).config.perProject, {});
  });

  test('(+) an entry that holds only an orchestrator id survives load and save; so does one beside a plugins list', async () => {
    const env = fresh('op2');
    fs.writeFileSync(cfgFile(env), JSON.stringify({ perProject: { [KEY]: { orchestratorSessionId: ID }, fedcba9876543210: { plugins: ['a@demo-market'], orchestratorSessionId: ID2 } } }));
    const r = await loadConfig(env);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.config.perProject, { [KEY]: { orchestratorSessionId: ID }, fedcba9876543210: { plugins: ['a@demo-market'], orchestratorSessionId: ID2 } });
    await updateSettings({ limits: { maxAgents: 2 } }, env);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile(env), 'utf8')).perProject, r.config.perProject, 'written back unchanged');
  });

  test('(+) the pick and the plugin list do not overwrite each other, and an empty plugin list keeps the entry while a pick is set', async () => {
    const env = fresh('op3');
    const p = await project(env);
    await updateProjectConfig(p.key, { plugins: ['a@demo-market'] }, env);
    await setOrchestrator(p.key, ID, env);
    assert.deepEqual((await loadConfig(env)).config.perProject[p.key], { plugins: ['a@demo-market'], orchestratorSessionId: ID });
    await updateProjectConfig(p.key, { plugins: [] }, env);
    assert.deepEqual((await loadConfig(env)).config.perProject, { [p.key]: { orchestratorSessionId: ID } });
    await updateProjectConfig(p.key, { plugins: ['b@demo-market'] }, env);
    await setOrchestrator(p.key, null, env);
    assert.deepEqual((await loadConfig(env)).config.perProject, { [p.key]: { plugins: ['b@demo-market'] } });
  });

  test('(+) removeProject deletes the pick with the entry; concurrent picks for two projects both survive', async () => {
    const env = fresh('op4');
    const a = await project(env, 'one');
    const b = await project(env, 'two');
    await Promise.all([setOrchestrator(a.key, ID, env), setOrchestrator(b.key, ID2, env), updateSettings({ limits: { maxAgents: 4 } }, env)]);
    const { config } = await loadConfig(env);
    assert.deepEqual(config.perProject, { [a.key]: { orchestratorSessionId: ID }, [b.key]: { orchestratorSessionId: ID2 } });
    assert.equal(config.limits.maxAgents, 4);
    assert.equal(await removeProject(a.key, env), true);
    assert.deepEqual((await loadConfig(env)).config.perProject, { [b.key]: { orchestratorSessionId: ID2 } });
  });

  test('(−) an id that is not a lowercase UUID is EINVAL (undefined is not a clear), and nothing is written', async () => {
    const env = fresh('op5');
    const p = await project(env);
    await setOrchestrator(p.key, ID, env);
    for (const bad of ['', 'x', LOWER.toUpperCase(), ID.slice(1), `${ID}0`, '../../etc/passwd', `${ID}\n`, 5, true, [], {}, undefined]) {
      await assert.rejects(setOrchestrator(p.key, bad, env), { code: 'EINVAL' }, JSON.stringify(bad));
    }
    assert.equal(await getOrchestrator(p.key, env), ID, 'the saved pick is untouched by refused updates');
  });

  test('(−) a bad project key is EINVAL for get and set; a key that is not registered is ENOENT and nothing is written', async () => {
    const env = fresh('op6');
    for (const key of ['', 'short', '0123456789ABCDEF', '../../etc/x', '__proto__', 5, null, undefined]) {
      await assert.rejects(getOrchestrator(key, env), { code: 'EINVAL' }, String(key));
      await assert.rejects(setOrchestrator(key, ID, env), { code: 'EINVAL' }, String(key));
    }
    await assert.rejects(setOrchestrator(KEY, ID, env), { code: 'ENOENT' });
    await assert.rejects(setOrchestrator(KEY, null, env), { code: 'ENOENT' }, 'clearing an unregistered project is refused too');
    assert.equal(fs.existsSync(cfgFile(env)), false, 'no config.json was created for a refused update');
  });

  test('(−) a hand-edited file: a bad id is dropped with a warning and the rest of the entry stays; an entry left empty goes', async () => {
    const env = fresh('op7');
    fs.writeFileSync(cfgFile(env), JSON.stringify({
      perProject: {
        [KEY]: { plugins: ['ok@demo-market'], orchestratorSessionId: '../../x' },
        fedcba9876543210: { orchestratorSessionId: LOWER.toUpperCase() },
        '0000000000000000': { orchestratorSessionId: 5 },
      },
    }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.perProject, { [KEY]: { plugins: ['ok@demo-market'] } });
    assert.equal(r.warnings.length, 3, r.warnings.join('\n'));
    assert.ok(r.warnings.every((w) => /orchestratorSessionId/.test(w)), r.warnings.join('\n'));
  });

  test('(+) a bad plugin list drops only the plugin list: a valid pick beside it is kept, with a warning that names the plugins', async () => {
    const env = fresh('op9');
    fs.writeFileSync(cfgFile(env), JSON.stringify({
      perProject: {
        [KEY]: { plugins: ['ok@demo-market', 'bad plugin'], orchestratorSessionId: ID },
        fedcba9876543210: { plugins: 'not-a-list', orchestratorSessionId: ID2 },
      },
    }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.perProject, { [KEY]: { orchestratorSessionId: ID }, fedcba9876543210: { orchestratorSessionId: ID2 } });
    assert.equal(r.warnings.length, 2, r.warnings.join('\n'));
    assert.ok(r.warnings.every((w) => /^perProject\.[0-9a-f]{16}\.plugins invalid, dropped$/.test(w)), r.warnings.join('\n'));
  });

  test('(−) a bad key or an entry that is not an object still drops the whole entry, pick included; a bad plugin list with no pick leaves nothing', async () => {
    const env = fresh('op10');
    fs.writeFileSync(cfgFile(env), JSON.stringify({
      perProject: {
        zzzz: { plugins: ['a@b'], orchestratorSessionId: ID },
        [KEY]: 'junk',
        fedcba9876543210: { plugins: ['bad plugin'] },
      },
    }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.perProject, {});
    assert.ok(r.warnings.some((w) => /^perProject\.zzzz dropped$/.test(w)));
    assert.ok(r.warnings.some((w) => new RegExp(`^perProject\\.${KEY} dropped$`).test(w)));
  });

  test('(−) updateProjectConfig still refuses the pick as a patch key: it is set only through setOrchestrator', async () => {
    const env = fresh('op8');
    const p = await project(env);
    await assert.rejects(updateProjectConfig(p.key, { orchestratorSessionId: ID }, env), { code: 'EINVAL' });
    await assert.rejects(updateSettings({ perProject: { [p.key]: { orchestratorSessionId: ID } } }, env), { code: 'EINVAL' });
    assert.equal(await getOrchestrator(p.key, env), null);
  });
});

describe('per-project models (0.4: perProject[key].models)', () => {
  const KEY = '0123456789abcdef';
  const ID = '11111111-1111-4111-8111-111111111111';
  const NONE = { orchestrator: null, reasoner: null, builder: null, scout: null };
  const cfgFile = (env) => { fs.mkdirSync(configDir(env), { recursive: true, mode: 0o700 }); return path.join(configDir(env), 'config.json'); };
  const project = async (env, name = 'repo') => {
    const dir = path.join(root, env.NIKA_CONFIG_DIR.split(path.sep).at(-2), name);
    fs.mkdirSync(dir, { recursive: true });
    return addProject(dir, env);
  };
  const onDisk = (env) => JSON.parse(fs.readFileSync(cfgFile(env), 'utf8')).perProject;

  test('(+) get answers { plugins, models } with all four roles null for a project without an entry', async () => {
    const env = fresh('pm1');
    const p = await project(env);
    assert.deepEqual(await getProjectConfig(p.key, env), { plugins: [], models: NONE });
  });

  test('(+) set, replace and clear roles: only non-null roles are stored (in role order, 0600); the answer has all four keys', async () => {
    const env = fresh('pm2');
    const p = await project(env);
    const set = await updateProjectConfig(p.key, { models: { scout: 'haiku', builder: 'claude-opus-5-5', reasoner: null, orchestrator: null } }, env);
    assert.deepEqual(set, { plugins: [], models: { orchestrator: null, reasoner: null, builder: 'claude-opus-5-5', scout: 'haiku' } });
    assert.deepEqual(await getProjectConfig(p.key, env), set);
    assert.deepEqual(onDisk(env), { [p.key]: { models: { builder: 'claude-opus-5-5', scout: 'haiku' } } });
    assert.equal(fs.statSync(cfgFile(env)).mode & 0o777, 0o600);
    const next = await updateProjectConfig(p.key, { models: { orchestrator: 'opus[1m]', reasoner: null, builder: null, scout: 'haiku' } }, env);
    assert.deepEqual(next.models, { orchestrator: 'opus[1m]', reasoner: null, builder: null, scout: 'haiku' }, 'a Custom ID that matches MODEL_ID is stored, even outside the catalog');
    assert.deepEqual(onDisk(env), { [p.key]: { models: { orchestrator: 'opus[1m]', scout: 'haiku' } } });
  });

  test('(+) all four null removes the models, and the entry when nothing else is left', async () => {
    const env = fresh('pm3');
    const p = await project(env);
    await updateProjectConfig(p.key, { models: { ...NONE, scout: 'haiku' } }, env);
    assert.deepEqual(await updateProjectConfig(p.key, { models: NONE }, env), { plugins: [], models: NONE });
    assert.deepEqual(onDisk(env), {});
    assert.deepEqual((await loadConfig(env)).config.perProject, {});
  });

  test('(+) models, plugins and the orchestrator pick do not overwrite each other', async () => {
    const env = fresh('pm4');
    const p = await project(env);
    await updateProjectConfig(p.key, { plugins: ['a@demo-market'] }, env);
    await setOrchestrator(p.key, ID, env);
    await updateProjectConfig(p.key, { models: { ...NONE, builder: 'sonnet' } }, env);
    assert.deepEqual(onDisk(env)[p.key], { plugins: ['a@demo-market'], orchestratorSessionId: ID, models: { builder: 'sonnet' } });
    assert.deepEqual(await updateProjectConfig(p.key, { plugins: [] }, env), { plugins: [], models: { ...NONE, builder: 'sonnet' } }, 'a plugins save keeps the models');
    assert.deepEqual(onDisk(env)[p.key], { orchestratorSessionId: ID, models: { builder: 'sonnet' } });
    await updateProjectConfig(p.key, { models: NONE }, env);
    assert.deepEqual(onDisk(env), { [p.key]: { orchestratorSessionId: ID } }, 'a models save keeps the pick');
    await updateProjectConfig(p.key, { models: { ...NONE, scout: 'haiku' } }, env);
    await setOrchestrator(p.key, null, env);
    assert.deepEqual(onDisk(env), { [p.key]: { models: { scout: 'haiku' } } }, 'forgetting the pick keeps the models');
  });

  test('(+) an entry that holds only models survives load and save, with no warning; removeProject deletes it', async () => {
    const env = fresh('pm5');
    fs.writeFileSync(cfgFile(env), JSON.stringify({ perProject: { [KEY]: { models: { scout: 'haiku', orchestrator: 'claude-opus-5-5' } } } }));
    const r = await loadConfig(env);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.config.perProject, { [KEY]: { models: { scout: 'haiku', orchestrator: 'claude-opus-5-5' } } });
    await updateSettings({ limits: { maxAgents: 2 } }, env);
    assert.deepEqual(onDisk(env), r.config.perProject, 'written back unchanged');
    const p = await project(fresh('pm5b'));
    const env2 = { NIKA_CONFIG_DIR: path.join(root, 'pm5b', 'cfg'), XDG_STATE_HOME: path.join(root, 'pm5b', 'state') };
    await updateProjectConfig(p.key, { models: { ...NONE, scout: 'haiku' } }, env2);
    assert.equal(await removeProject(p.key, env2), true);
    assert.deepEqual((await loadConfig(env2)).config.perProject, {});
  });

  test('(+) effectiveModels: the project\'s id wins per role, the Settings default fills the rest; the config is not changed', async () => {
    const env = fresh('pm6');
    const p = await project(env);
    const q = await project(env, 'other');
    await updateProjectConfig(p.key, { models: { ...NONE, builder: 'claude-opus-5-5', scout: 'sonnet[1m]' } }, env);
    const { config } = await loadConfig(env);
    const before = JSON.stringify(config);
    assert.deepEqual(effectiveModels(config, p.key), { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-opus-5-5', scout: 'sonnet[1m]' });
    assert.deepEqual(effectiveModels(config, q.key), config.models, 'a project without an entry uses the defaults');
    assert.deepEqual(effectiveModels(config, KEY), config.models, 'so does a key that is not registered');
    assert.equal(JSON.stringify(config), before);
    assert.deepEqual(effectiveModels({ models: config.models }, p.key), config.models, 'a config without perProject is the defaults');
  });

  test('(−) a hand-edited file: an unknown role and a bad id drop only that role, a non-object drops only models; each with a warning', async () => {
    const env = fresh('pm7');
    fs.writeFileSync(cfgFile(env), JSON.stringify({
      perProject: {
        [KEY]: { plugins: ['ok@demo-market'], models: { builder: 'claude-opus-5-5', helper: 'haiku', scout: 'not a model', reasoner: null, orchestrator: 5 } },
        fedcba9876543210: { models: ['haiku'] },
        '0000000000000000': { models: 'haiku', orchestratorSessionId: ID },
        '1111111111111111': { models: { scout: '--model' } },
        '2222222222222222': JSON.parse('{"models":{"__proto__":"haiku","scout":"haiku"}}'),
      },
    }));
    const r = await loadConfig(env);
    assert.deepEqual(r.config.perProject, {
      [KEY]: { plugins: ['ok@demo-market'], models: { builder: 'claude-opus-5-5' } },
      '0000000000000000': { orchestratorSessionId: ID },
      '2222222222222222': { models: { scout: 'haiku' } },
    });
    const w = r.warnings.join('\n');
    assert.match(w, new RegExp(`unknown key perProject\\.${KEY}\\.models\\.helper dropped`));
    for (const role of ['scout', 'reasoner', 'orchestrator']) assert.match(w, new RegExp(`perProject\\.${KEY}\\.models\\.${role} invalid, dropped`), role);
    assert.match(w, /perProject\.fedcba9876543210\.models invalid, dropped/);
    assert.match(w, /perProject\.0000000000000000\.models invalid, dropped/);
    assert.match(w, /perProject\.1111111111111111\.models\.scout invalid, dropped/);
    assert.match(w, /perProject\.2222222222222222\.models\.__proto__/);
    assert.equal(({}).scout, undefined);
  });

  test('(−) a patch with both plugins and models, with neither, or with a stray key is EINVAL and nothing is written', async () => {
    const env = fresh('pm8');
    const p = await project(env);
    const saved = fs.readFileSync(cfgFile(env), 'utf8');
    for (const patch of [{ plugins: ['a@demo-market'], models: NONE }, {}, { models: NONE, limits: {} }, { model: NONE }, JSON.parse('{"__proto__":{"models":{}}}'), Object.create({ models: NONE })]) {
      await assert.rejects(updateProjectConfig(p.key, patch, env), { code: 'EINVAL' }, JSON.stringify(patch));
    }
    assert.equal(fs.readFileSync(cfgFile(env), 'utf8'), saved, 'a refused update writes nothing');
  });

  test('(−) models must be a plain object with exactly the four role keys, each a MODEL_ID or null', async () => {
    const env = fresh('pm9');
    const p = await project(env);
    await updateProjectConfig(p.key, { models: { ...NONE, scout: 'haiku' } }, env);
    const saved = fs.readFileSync(cfgFile(env), 'utf8');
    const bad = [
      {}, { scout: 'haiku' }, { orchestrator: null, reasoner: null, builder: null }, // roles missing
      { ...NONE, helper: 'haiku' }, JSON.parse('{"orchestrator":null,"reasoner":null,"builder":null,"scout":null,"__proto__":null}'), // a fifth key
      { ...NONE, scout: undefined }, { ...NONE, scout: '' }, { ...NONE, scout: 5 }, { ...NONE, scout: true }, { ...NONE, scout: ['haiku'] }, // not an id and not null
      { ...NONE, scout: 'Haiku' }, { ...NONE, scout: 'haiku ' }, { ...NONE, scout: 'haiku\n' }, { ...NONE, scout: '--model' }, { ...NONE, scout: 'claude-' }, { ...NONE, scout: `claude-${'a'.repeat(61)}` }, { ...NONE, scout: 'gpt-5' }, // MODEL_ID says no
      null, 'haiku', 5, [], [null, null, null, null],
    ];
    for (const models of bad) await assert.rejects(updateProjectConfig(p.key, { models }, env), { code: 'EINVAL' }, JSON.stringify(models));
    assert.equal(fs.readFileSync(cfgFile(env), 'utf8'), saved, 'the saved models are untouched by refused updates');
  });

  test('(−) a key that is not a registered project is ENOENT and nothing is written; a bad key is EINVAL', async () => {
    const env = fresh('pm10');
    await assert.rejects(updateProjectConfig(KEY, { models: { ...NONE, scout: 'haiku' } }, env), { code: 'ENOENT' });
    assert.equal(fs.existsSync(cfgFile(env)), false);
    for (const key of ['', 'short', '0123456789ABCDEF', '__proto__', 5, null, undefined]) {
      await assert.rejects(updateProjectConfig(key, { models: NONE }, env), { code: 'EINVAL' }, String(key));
    }
  });
});
