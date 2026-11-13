// Apply orchestration rules (ADR 0006; T5 settings merge, T8 symlinks and hard links); temp dirs and synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { render, rulesState, preview, apply, TEMPLATE_VERSION } from '../src/rules.js';
import { addProject, loadConfig, saveConfig, updateSettings, updateProjectConfig } from '../src/store.js';
import { configDir, backupsDir } from '../src/paths.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nika-rules-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 8, 3, 4, 5);
const STAMP = '20261108T030405Z';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mode = (p) => fs.lstatSync(p).mode & 0o777;
const IMPORT = '@rules/orchestration.md';

let counter = 0;
/** A fresh fake machine: config and state dirs, one registered project folder, optional plugin selection. */
async function world({ git = false, plugins } = {}) {
  const base = path.join(root, `w${counter++}`);
  const env = { NIKA_CONFIG_DIR: path.join(base, 'cfg'), XDG_STATE_HOME: path.join(base, 'state') };
  const dir = path.join(base, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  if (git) fs.mkdirSync(path.join(dir, '.git'));
  const project = await addProject(dir, env);
  if (plugins) await setPlugins({ env, project }, plugins);
  return { base, env, dir, project, ctx: { env, now: () => NOW } };
}
async function setPlugins(w, list) {
  const { config } = await loadConfig(w.env);
  config.perProject[w.project.key] = { plugins: list };
  await saveConfig(config, w.env);
}
const put = (w, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(w.dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(w.dir, rel), text);
};
const get = (w, rel) => fs.readFileSync(path.join(w.dir, rel), 'utf8');
const has = (w, rel) => fs.existsSync(path.join(w.dir, rel));

/** Every file and folder below dir with its content: equal snapshots mean nothing was written. */
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        out[`${r}/`] = null;
        walk(r);
      } else if (e.isSymbolicLink()) out[r] = `-> ${fs.readlinkSync(path.join(dir, r))}`;
      else if (e.isFile()) out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
      else out[r] = 'special'; // a FIFO must never be opened here
    }
  };
  walk('');
  return out;
}
const prev = async (w) => {
  const r = await preview(w.project, w.ctx);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const go = (w, body, extra = {}) => apply(w.project, { hash: body.hash, ...extra }, w.ctx);
const entry = (body, rel) => body.files.find((f) => f.path === rel);
const rulesMarker = (body, version = TEMPLATE_VERSION) => `<!-- nika:orchestration v${version} sha256:${sha(body)} -->\n${body}`;

describe('render', () => {
  test('(+) replaces dotted keys, tolerates spaces, accepts numbers', () => {
    assert.equal(render('a {{x.y}} b {{ z }} c {{x.n}}', { x: { y: 'Y', n: 3 }, z: 'Z' }), 'a Y b Z c 3');
    assert.equal(render('no placeholders\n', {}), 'no placeholders\n');
  });

  test('(−) unknown keys, objects, prototype keys, malformed and stray braces throw EPLACEHOLDER', () => {
    for (const t of ['{{nope}}', '{{x.nope}}', '{{x}}', '{{x.y.z}}', '{{constructor}}', '{{x.__proto__}}', '{{toString}}', '{{ 1a }}', '{{x y}}', 'a {{ b', 'a }} b', '{{}}']) {
      assert.throws(() => render(t, { x: { y: 'Y' } }), { code: 'EPLACEHOLDER' }, t);
    }
  });
});

describe('built-in template', () => {
  test('(+) uses exactly the documented placeholders and renders with the defaults', async () => {
    const src = fs.readFileSync(new URL('../templates/orchestration.md', import.meta.url), 'utf8');
    const keys = new Set([...src.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]));
    assert.deepEqual([...keys].sort(), [
      'limits.maxAgents', 'models.builder', 'models.orchestrator', 'models.reasoner', 'models.scout', 'panePlacement', 'permissionMode', 'plugins', 'remoteControl',
    ]);
    const w = await world();
    const body = await prev(w);
    await go(w, body);
    const text = get(w, 'rules/orchestration.md');
    assert.doesNotMatch(text, /\{\{|\}\}/);
    for (const v of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'beside', 'nika spawn <name> <model> <brief>']) assert.ok(text.includes(v), v);
    assert.match(text, /Permission mode for spawned agents: `default`\./);
    assert.match(text, /Remote Control: off\./);
    assert.match(text, /Plugins enabled for this project: none\./);
    assert.match(text, /At most 3 spawned agents/);
  });

  test('(+) template version 2 adds a Sub-orchestrators section: when to use one, the spawn command, the three levels, the limit from the settings', async () => {
    assert.equal(TEMPLATE_VERSION, 2);
    const w = await world();
    await updateSettings({ limits: { maxAgents: 4 } }, w.env);
    await go(w, await prev(w));
    const text = get(w, 'rules/orchestration.md');
    assert.ok(text.startsWith('<!-- nika:orchestration v2 sha256:'));
    const section = /^## Sub-orchestrators\n([\s\S]*?)(?=^## )/m.exec(text)?.[1] ?? '';
    assert.match(section, /nika spawn <name> <model> <brief> --role orchestrator/);
    assert.match(section, /three levels/);
    assert.match(section, /Only the main orchestrator/);
    assert.match(section, /at most 4 agents of its own/i);
    assert.match(section, /`nika spawn` and `nika status`/);
    assert.match(text, /At most 4 spawned agents are live at a time under each orchestrator/);
  });

  test('(−) a file written by template version 1 reads as outdated, not current: applying it offers the new section', async () => {
    const w = await world();
    put(w, 'rules/orchestration.md', rulesMarker('# old rules\n', 1));
    const body = await prev(w);
    const rules = entry(body, 'rules/orchestration.md');
    assert.equal(rules.action, 'update');
    assert.notEqual(rules.foreign, true);
    await go(w, body);
    assert.match(get(w, 'rules/orchestration.md'), /^## Sub-orchestrators$/m);
  });

  test('(+) settings flow into the rendered file: models, limit, placement, permission mode, Remote Control, plugins', async () => {
    const w = await world({ plugins: ['alpha@demo-market', 'beta_x@demo-market'] });
    await updateSettings({ models: { builder: 'sonnet' }, limits: { maxAgents: 5 }, panePlacement: 'under-last', permissionMode: 'plan', remoteControl: { enabled: true, prefix: 'demo' } }, w.env);
    await go(w, await prev(w));
    const text = get(w, 'rules/orchestration.md');
    assert.match(text, /\| Builder \| `sonnet` \|/);
    assert.match(text, /At most 5 spawned agents/);
    assert.match(text, /Pane placement: `under-last`/);
    assert.match(text, /Permission mode for spawned agents: `plan`\./);
    assert.match(text, /Remote Control: on \(name prefix: demo\)\./);
    assert.match(text, /Plugins enabled for this project: `alpha@demo-market`, `beta_x@demo-market`\./);
    await updateSettings({ remoteControl: { prefix: '' } }, w.env);
    await go(w, await prev(w));
    assert.match(get(w, 'rules/orchestration.md'), /on \(name prefix: the project name\)/);
  });

  test('(+) the project\'s models override the defaults in the Roles table; the roles left alone keep the Settings value', async () => {
    const w = await world();
    await updateSettings({ models: { builder: 'sonnet' } }, w.env);
    await go(w, await prev(w));
    await updateProjectConfig(w.project.key, { models: { orchestrator: null, reasoner: 'opus[1m]', builder: 'claude-opus-5-5', scout: null } }, w.env);
    const body = await prev(w);
    const rules = entry(body, 'rules/orchestration.md');
    assert.equal(rules.action, 'update', 'saved models make the applied file out of date');
    assert.match(rules.diff, /^-\| Builder \| `sonnet` \|/m);
    assert.match(rules.diff, /^\+\| Builder \| `claude-opus-5-5` \|/m);
    await go(w, body);
    const text = get(w, 'rules/orchestration.md');
    assert.match(text, /\| Orchestrator \| `claude-fable-5-1` \|/);
    assert.match(text, /\| Reasoner \| `opus\[1m\]` \|/);
    assert.match(text, /\| Builder \| `claude-opus-5-5` \|/);
    assert.match(text, /\| Scout \| `claude-haiku-5-5` \|/);
  });

  test('(−) another project\'s override does not leak into this one, and a Settings change still shows through where nothing is overridden', async () => {
    const w = await world();
    const other = await addProject(fs.mkdtempSync(path.join(w.base, 'other-')), w.env);
    await updateProjectConfig(other.key, { models: { orchestrator: 'opus', reasoner: 'opus', builder: 'opus', scout: 'opus' } }, w.env);
    await go(w, await prev(w));
    const text = get(w, 'rules/orchestration.md');
    assert.doesNotMatch(text, /`opus`/);
    assert.match(text, /\| Scout \| `claude-haiku-5-5` \|/);
    await updateSettings({ models: { scout: 'haiku' } }, w.env);
    assert.match(entry(await prev(w), 'rules/orchestration.md').diff, /^\+\| Scout \| `haiku` \|/m);
  });

  test('(+) the project\'s permission mode, pane placement and agent limit are rendered in place of Settings\'; the rules go out of date with a change and back with a clear', async () => {
    const w = await world();
    await updateSettings({ limits: { maxAgents: 5 }, panePlacement: 'under-last', permissionMode: 'plan' }, w.env);
    await go(w, await prev(w));
    assert.equal((await rulesState(w.project)).state, 'nika');
    await updateProjectConfig(w.project.key, { permissionMode: 'acceptEdits' }, w.env);
    await updateProjectConfig(w.project.key, { panePlacement: 'beside' }, w.env);
    await updateProjectConfig(w.project.key, { maxAgents: 2 }, w.env);
    const body = await prev(w);
    const rules = entry(body, 'rules/orchestration.md');
    assert.equal(rules.action, 'update', 'saved values make the applied file out of date');
    assert.match(rules.diff, /^-- Permission mode for spawned agents: `plan`\./m);
    assert.match(rules.diff, /^\+- Permission mode for spawned agents: `acceptEdits`\./m);
    await go(w, body);
    const text = get(w, 'rules/orchestration.md');
    assert.match(text, /Pane placement: `beside`/);
    assert.match(text, /At most 2 spawned agents/);
    assert.match(text, /Permission mode for spawned agents: `acceptEdits`\./);
    assert.doesNotMatch(text, /Pane placement: `under-last`|At most 5 spawned|mode for spawned agents: `plan`/, 'no Settings value is left in the file');
    assert.equal((await rulesState(w.project)).state, 'nika');
    await updateProjectConfig(w.project.key, { maxAgents: null }, w.env);
    await updateProjectConfig(w.project.key, { permissionMode: null }, w.env);
    const back = entry(await prev(w), 'rules/orchestration.md');
    assert.equal(back.action, 'update', 'clearing is a change too');
    assert.match(back.diff, /^\+- At most 5 spawned agents/m);
    assert.match(back.diff, /^\+- Permission mode for spawned agents: `plan`\./m);
  });

  test('(−) another project\'s values do not leak into this one; a Settings change still shows where nothing is overridden', async () => {
    const w = await world();
    const other = await addProject(fs.mkdtempSync(path.join(w.base, 'other-')), w.env);
    await updateProjectConfig(other.key, { permissionMode: 'dontAsk' }, w.env);
    await updateProjectConfig(other.key, { panePlacement: 'under-last' }, w.env);
    await updateProjectConfig(other.key, { maxAgents: 7 }, w.env);
    await go(w, await prev(w));
    const text = get(w, 'rules/orchestration.md');
    assert.match(text, /Pane placement: `beside`/);
    assert.match(text, /At most 3 spawned agents/);
    assert.match(text, /Permission mode for spawned agents: `default`\./);
    await updateProjectConfig(w.project.key, { maxAgents: 4 }, w.env);
    await updateSettings({ permissionMode: 'plan', limits: { maxAgents: 6 } }, w.env);
    const diff = entry(await prev(w), 'rules/orchestration.md').diff;
    assert.match(diff, /^\+- Permission mode for spawned agents: `plan`\./m, 'Settings shows through');
    assert.match(diff, /^\+- At most 4 spawned agents/m, 'the project\'s own limit still wins over a changed Settings one');
  });
});

describe('rulesState', () => {
  test('(+) none → nika after apply; outdated for an older unmodified marker; git flag', async () => {
    const w = await world({ git: true });
    assert.deepEqual(await rulesState(w.project), { state: 'none', settingsIgnored: false, git: true });
    await go(w, await prev(w));
    assert.equal((await rulesState(w.project)).state, 'nika');
    put(w, 'rules/orchestration.md', rulesMarker('older template\n', TEMPLATE_VERSION - 1));
    assert.equal((await rulesState(w.project)).state, 'outdated');
    const plain = await world();
    assert.equal((await rulesState(plain.project)).git, false);
  });

  test('(+) .git as a file (worktree) counts as git', async () => {
    const w = await world();
    put(w, '.git', 'gitdir: elsewhere\n');
    assert.equal((await rulesState(w.project)).git, true);
  });

  test('(−) foreign: no marker, edited body, bad hash, newer version, symlinked rules folder, unreadable target', async () => {
    const w = await world();
    put(w, 'rules/orchestration.md', '# my own rules\n');
    assert.equal((await rulesState(w.project)).state, 'foreign');
    put(w, 'rules/orchestration.md', `${rulesMarker('body\n')}edited\n`);
    assert.equal((await rulesState(w.project)).state, 'foreign');
    put(w, 'rules/orchestration.md', `<!-- nika:orchestration v${TEMPLATE_VERSION} sha256:${'0'.repeat(64)} -->\nbody\n`);
    assert.equal((await rulesState(w.project)).state, 'foreign');
    put(w, 'rules/orchestration.md', rulesMarker('body\n', TEMPLATE_VERSION + 1));
    assert.equal((await rulesState(w.project)).state, 'foreign');
    fs.writeFileSync(path.join(w.base, 'decoy'), rulesMarker('body\n'));
    fs.rmSync(path.join(w.dir, 'rules/orchestration.md'));
    fs.symlinkSync(path.join(w.base, 'decoy'), path.join(w.dir, 'rules/orchestration.md'));
    assert.equal((await rulesState(w.project)).state, 'foreign');
    fs.rmSync(path.join(w.dir, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(w.base, 'elsewhere'));
    fs.writeFileSync(path.join(w.base, 'elsewhere/orchestration.md'), rulesMarker('body\n'));
    fs.symlinkSync(path.join(w.base, 'elsewhere'), path.join(w.dir, 'rules'));
    assert.equal((await rulesState(w.project)).state, 'foreign');
  });

  test('(+) settingsIgnored recognises the documented .gitignore lines', async () => {
    const yes = ['.claude/settings.local.json', '/.claude/settings.local.json', '.claude/', '/.claude', '*.local.json', 'settings.local.json', '**/settings.local.json', '  .claude/  \r'];
    for (const line of yes) {
      const w = await world();
      put(w, '.gitignore', `node_modules\n${line}\n`);
      assert.equal((await rulesState(w.project)).settingsIgnored, true, JSON.stringify(line));
    }
  });

  test('(−) settingsIgnored is false for comments, look-alikes, negations, a symlinked or missing .gitignore', async () => {
    for (const line of ['# .claude/', '.claude-old/', 'local.json', 'settings.local.json.bak', '!.claude/settings.local.json', 'docs/.claude/', '']) {
      const w = await world();
      put(w, '.gitignore', `${line}\n`);
      assert.equal((await rulesState(w.project)).settingsIgnored, false, JSON.stringify(line));
    }
    const w = await world();
    assert.equal((await rulesState(w.project)).settingsIgnored, false);
    fs.writeFileSync(path.join(w.base, 'ignore-all'), '.claude/\n');
    fs.symlinkSync(path.join(w.base, 'ignore-all'), path.join(w.dir, '.gitignore'));
    assert.equal((await rulesState(w.project)).settingsIgnored, false);
  });
});

describe('preview', () => {
  test('(+) a fresh project: shape, order, create actions, hash, backup folder, warnings', async () => {
    const w = await world();
    const body = await prev(w);
    assert.deepEqual(Object.keys(body).sort(), ['backupDir', 'files', 'hash', 'warnings']);
    assert.match(body.hash, /^[0-9a-f]{64}$/);
    assert.equal(body.backupDir, path.join(backupsDir(w.project.key, w.env), STAMP));
    assert.deepEqual(body.files.map((f) => [f.path, f.action]), [['rules/orchestration.md', 'create'], ['CLAUDE.md', 'create'], ['.claude/settings.local.json', 'unchanged']]);
    const rules = entry(body, 'rules/orchestration.md');
    assert.equal(rules.foreign, false);
    assert.match(rules.diff, /^--- a\/rules\/orchestration\.md\n\+\+\+ b\/rules\/orchestration\.md\n@@ -0,0 \+1,\d+ @@\n\+<!-- nika:orchestration v2 sha256:[0-9a-f]{64} -->\n/);
    assert.equal(entry(body, 'CLAUDE.md').diff, `--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -0,0 +1 @@\n+${IMPORT}\n`);
    assert.equal(entry(body, '.claude/settings.local.json').diff, '');
    assert.ok(body.warnings.some((x) => /not a git repository/.test(x)));
    assert.equal(has(w, 'rules'), false, 'preview writes nothing');
    assert.deepEqual(fs.readdirSync(w.dir), []);
  });

  test('(+) the hash is stable for the same state and changes with the project files and the settings', async () => {
    const w = await world();
    const a = await prev(w);
    assert.equal((await prev(w)).hash, a.hash);
    put(w, 'CLAUDE.md', '# t\n');
    const b = await prev(w);
    assert.notEqual(b.hash, a.hash);
    await updateSettings({ limits: { maxAgents: 4 } }, w.env);
    assert.notEqual((await prev(w)).hash, b.hash);
  });

  test('(+) a project without .git has a warning, one with .git does not', async () => {
    const w = await world({ git: true, plugins: ['alpha@demo-market'] });
    const body = await prev(w);
    assert.equal(body.warnings.some((x) => /git repository/.test(x)), false);
    assert.deepEqual(body.warnings, ['settings.local.json is not gitignored']);
  });

  test('(+) selected plugins plan a settings.local.json create with keysPreserved and an optional .gitignore entry', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    const body = await prev(w);
    const s = entry(body, '.claude/settings.local.json');
    assert.equal(s.action, 'create');
    assert.equal(s.keysPreserved, true);
    assert.equal(s.diff, '--- a/.claude/settings.local.json\n+++ b/.claude/settings.local.json\n@@ -0,0 +1,5 @@\n+{\n+  "enabledPlugins": {\n+    "alpha@demo-market": true\n+  }\n+}\n');
    const g = entry(body, '.gitignore');
    assert.deepEqual([g.action, g.optional], ['create', true]);
    assert.equal(g.diff, '--- a/.gitignore\n+++ b/.gitignore\n@@ -0,0 +1 @@\n+.claude/settings.local.json\n');
  });

  test('(+) CLAUDE.md: appended import, spacing, already imported is untouched', async () => {
    const cases = [
      ['# Title\n\nText\n', '# Title\n\nText\n\n@rules/orchestration.md\n'],
      ['Text', 'Text\n\n@rules/orchestration.md\n'],
      ['Text\n\n', 'Text\n\n@rules/orchestration.md\n'],
      ['', '@rules/orchestration.md\n'],
    ];
    for (const [before, after_] of cases) {
      const w = await world();
      put(w, 'CLAUDE.md', before);
      await go(w, await prev(w));
      assert.equal(get(w, 'CLAUDE.md'), after_, JSON.stringify(before));
    }
    for (const same of [`# T\n${IMPORT}\n`, `# T\r\n  ${IMPORT}  \r\n`, `${IMPORT}`]) {
      const w = await world();
      put(w, 'CLAUDE.md', same);
      const body = await prev(w);
      assert.equal(entry(body, 'CLAUDE.md').action, 'unchanged', JSON.stringify(same));
      await go(w, body);
      assert.equal(get(w, 'CLAUDE.md'), same);
    }
  });

  test('(−) a look-alike import (inline mention, another file) does not count as the import line', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', 'see @rules/orchestration.md.bak and @rules/other.md\n');
    assert.equal(entry(await prev(w), 'CLAUDE.md').action, 'update');
  });

  test('(−) a bad project is rejected: 400 for malformed objects, 409 when the folder is gone or behind a symlink', async () => {
    const w = await world();
    for (const bad of [null, {}, { key: 'x', dir: w.dir }, { key: w.project.key, dir: 'relative' }, { key: '0'.repeat(16), dir: w.dir }, { ...w.project, dir: `${w.dir}/` }]) {
      const r = await preview(bad, w.ctx);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.error, 'invalid');
    }
    fs.renameSync(w.dir, `${w.dir}-moved`);
    const gone = await preview(w.project, w.ctx);
    assert.deepEqual([gone.status, gone.body.error], [409, 'conflict']);
    fs.symlinkSync(`${w.dir}-moved`, w.dir);
    const linked = await preview(w.project, w.ctx);
    assert.deepEqual([linked.status, linked.body.error], [409, 'conflict']);
    assert.deepEqual((await apply(w.project, { hash: '0'.repeat(64) }, w.ctx)).status, 409);
    assert.deepEqual(fs.readdirSync(`${w.dir}-moved`), []);
  });

  test('(−) oversized and non-UTF-8 files are refused, not rewritten', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', 'x'.repeat(1024 * 1024 + 1));
    const big = await preview(w.project, w.ctx);
    assert.deepEqual([big.status, big.body.error, big.body.code], [409, 'refused', 'EFBIG']);
    const v = await world();
    fs.writeFileSync(path.join(v.dir, 'CLAUDE.md'), Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
    const bin = await preview(v.project, v.ctx);
    assert.deepEqual([bin.status, bin.body.error], [400, 'invalid']);
    assert.deepEqual([...fs.readFileSync(path.join(v.dir, 'CLAUDE.md'))], [0x23, 0x20, 0xe9, 0x0a]);
  });
});

describe('AGENTS.md and CLAUDE.md (G7): both carry the rules import, and Claude loads it once', () => {
  const AGENTS_LINE = '@AGENTS.md';
  const VIA = 'Gets the rules through @AGENTS.md.';
  /** What must stay the same for a file nika must not touch: type, inode, mtime, size, mode, content or link target. */
  const identity = (w, rel = 'AGENTS.md') => {
    const p = path.join(w.dir, rel);
    const st = fs.lstatSync(p);
    return { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, mode: st.mode, link: st.isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p, 'latin1') };
  };
  const shape = (body) => body.files.map((f) => [f.path, f.action]);
  const outsideFile = (w) => {
    fs.mkdirSync(path.join(w.base, 'outside'));
    const f = path.join(w.base, 'outside', 'secret.txt');
    fs.writeFileSync(f, 'SECRET');
    return f;
  };

  test('(+) only AGENTS.md: it gets the import, a new CLAUDE.md is just @AGENTS.md, AGENTS.md is written before CLAUDE.md and backed up', async () => {
    const w = await world();
    const original = '# acme-api agents\n\nRun npm test.\n';
    put(w, 'AGENTS.md', original);
    fs.chmodSync(path.join(w.dir, 'AGENTS.md'), 0o664);
    const body = await prev(w);
    assert.deepEqual(shape(body), [['rules/orchestration.md', 'create'], ['AGENTS.md', 'update'], ['CLAUDE.md', 'create'], ['.claude/settings.local.json', 'unchanged']]);
    const a = entry(body, 'AGENTS.md');
    assert.match(a.diff, /^--- a\/AGENTS\.md\n\+\+\+ b\/AGENTS\.md\n@@ /);
    assert.match(a.diff, /^\+@rules\/orchestration\.md$/m, 'the diff adds the import line');
    assert.equal(entry(body, 'CLAUDE.md').diff, `--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -0,0 +1 @@\n+${AGENTS_LINE}\n`);
    for (const f of body.files) assert.equal('note' in f, false, `${f.path}: a note only on a skipped or via-AGENTS.md entry`);

    const r = await go(w, body);
    assert.deepEqual([r.status, r.body.written], [200, ['rules/orchestration.md', 'AGENTS.md', 'CLAUDE.md']], 'AGENTS.md lands before CLAUDE.md');
    assert.equal(get(w, 'AGENTS.md'), `${original}\n${IMPORT}\n`);
    assert.equal(get(w, 'CLAUDE.md'), `${AGENTS_LINE}\n`);
    assert.equal(mode(path.join(w.dir, 'AGENTS.md')), 0o644, 'group write dropped like any target');
    assert.equal(mode(path.join(w.dir, 'CLAUDE.md')), 0o644);
    assert.equal(fs.readFileSync(path.join(r.body.backupDir, 'AGENTS.md'), 'utf8'), original, 'byte-for-byte backup outside the repo');
    assert.equal(r.body.backupDir.startsWith(w.base), true);
    assert.equal(fs.existsSync(path.join(r.body.backupDir, 'CLAUDE.md')), false, 'a new file has nothing to back up');

    // idempotent: CLAUDE.md imports AGENTS.md, which has the import, so the rules load once and nothing is left to do
    const again = await prev(w);
    assert.deepEqual(shape(again), [['rules/orchestration.md', 'unchanged'], ['AGENTS.md', 'unchanged'], ['CLAUDE.md', 'unchanged'], ['.claude/settings.local.json', 'unchanged']]);
    assert.equal(entry(again, 'CLAUDE.md').note, VIA);
    assert.deepEqual((await go(w, again)).body.written, []);
    assert.equal(get(w, 'AGENTS.md'), `${original}\n${IMPORT}\n`);
    assert.equal(get(w, 'CLAUDE.md'), `${AGENTS_LINE}\n`);
  });

  test('(+) both files and CLAUDE.md does not import AGENTS.md: both get the import, AGENTS.md first', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', '# web-shop\n');
    put(w, 'AGENTS.md', 'Agents read this.');
    const body = await prev(w);
    assert.deepEqual(shape(body), [['rules/orchestration.md', 'create'], ['AGENTS.md', 'update'], ['CLAUDE.md', 'update'], ['.claude/settings.local.json', 'unchanged']]);
    for (const f of body.files) assert.equal('note' in f, false, f.path);
    const r = await go(w, body);
    assert.deepEqual(r.body.written, ['rules/orchestration.md', 'AGENTS.md', 'CLAUDE.md']);
    assert.equal(get(w, 'AGENTS.md'), `Agents read this.\n\n${IMPORT}\n`);
    assert.equal(get(w, 'CLAUDE.md'), `# web-shop\n\n${IMPORT}\n`);
    assert.equal(fs.readFileSync(path.join(r.body.backupDir, 'AGENTS.md'), 'utf8'), 'Agents read this.');
    assert.equal(fs.readFileSync(path.join(r.body.backupDir, 'CLAUDE.md'), 'utf8'), '# web-shop\n');
    const again = await prev(w);
    assert.deepEqual(again.files.map((f) => f.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    assert.deepEqual((await go(w, again)).body.written, []);
  });

  test('(+) both files and CLAUDE.md imports @AGENTS.md (or @./AGENTS.md): AGENTS.md gets the import, CLAUDE.md is left byte for byte with a note', async () => {
    const claudes = [`# web-shop\n\n${AGENTS_LINE}\n`, '@./AGENTS.md\n', `# web-shop\r\n  ${AGENTS_LINE}  \r\n`, AGENTS_LINE, `${AGENTS_LINE}\n${IMPORT}\n`];
    for (const claude of claudes) {
      const w = await world();
      put(w, 'CLAUDE.md', claude);
      put(w, 'AGENTS.md', '# acme-api agents\n');
      const before = identity(w, 'CLAUDE.md');
      const body = await prev(w);
      assert.deepEqual(shape(body), [['rules/orchestration.md', 'create'], ['AGENTS.md', 'update'], ['CLAUDE.md', 'unchanged'], ['.claude/settings.local.json', 'unchanged']], JSON.stringify(claude));
      assert.deepEqual(entry(body, 'CLAUDE.md'), { path: 'CLAUDE.md', action: 'unchanged', diff: '', note: VIA }, JSON.stringify(claude));
      assert.equal('note' in entry(body, 'AGENTS.md'), false);
      const r = await go(w, body);
      assert.deepEqual(r.body.written, ['rules/orchestration.md', 'AGENTS.md'], JSON.stringify(claude));
      assert.equal(get(w, 'AGENTS.md'), `# acme-api agents\n\n${IMPORT}\n`);
      assert.deepEqual(identity(w, 'CLAUDE.md'), before, `CLAUDE.md untouched: ${JSON.stringify(claude)}`);
      assert.equal(fs.existsSync(path.join(r.body.backupDir, 'CLAUDE.md')), false);
      const again = await prev(w);
      assert.deepEqual(again.files.map((f) => f.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged'], JSON.stringify(claude));
      assert.equal(entry(again, 'CLAUDE.md').note, VIA);
      assert.deepEqual((await go(w, again)).body.written, []);
    }
  });

  test('(+) CLAUDE.md imports @AGENTS.md and AGENTS.md already has the import: only the rules file is written', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', `${AGENTS_LINE}\n`);
    put(w, 'AGENTS.md', `# acme-api agents\n\n${IMPORT}\n`);
    const body = await prev(w);
    assert.deepEqual(shape(body), [['rules/orchestration.md', 'create'], ['AGENTS.md', 'unchanged'], ['CLAUDE.md', 'unchanged'], ['.claude/settings.local.json', 'unchanged']]);
    assert.deepEqual((await go(w, body)).body.written, ['rules/orchestration.md']);
  });

  test('(−) a look-alike @AGENTS.md (inline mention, extra text, another file) is no import: CLAUDE.md gets the line itself', async () => {
    for (const claude of ['see @AGENTS.md for more\n', '@AGENTS.md.bak\n', '@AGENTS.md and more\n', '@docs/AGENTS.md\n', '# @AGENTS.md\n']) {
      const w = await world();
      put(w, 'CLAUDE.md', claude);
      put(w, 'AGENTS.md', '# a\n');
      const body = await prev(w);
      assert.equal(entry(body, 'CLAUDE.md').action, 'update', JSON.stringify(claude));
      assert.equal('note' in entry(body, 'CLAUDE.md'), false, JSON.stringify(claude));
      assert.equal(entry(body, 'AGENTS.md').action, 'update');
    }
  });

  test('(+) an @AGENTS.md line in a CLAUDE.md with no AGENTS.md on disk counts as "only CLAUDE.md": it gets the import itself', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', `${AGENTS_LINE}\n`);
    const body = await prev(w);
    assert.deepEqual(shape(body), [['rules/orchestration.md', 'create'], ['CLAUDE.md', 'update'], ['.claude/settings.local.json', 'unchanged']]);
    assert.equal(entry(body, 'AGENTS.md'), undefined);
    await go(w, body);
    assert.equal(get(w, 'CLAUDE.md'), `${AGENTS_LINE}\n\n${IMPORT}\n`);
    assert.equal(has(w, 'AGENTS.md'), false, 'nika never creates an AGENTS.md');
  });

  test('(+) only CLAUDE.md and neither file keep working as before', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', '# web-shop\n');
    const only = await prev(w);
    assert.deepEqual(shape(only), [['rules/orchestration.md', 'create'], ['CLAUDE.md', 'update'], ['.claude/settings.local.json', 'unchanged']]);
    await go(w, only);
    assert.equal(get(w, 'CLAUDE.md'), `# web-shop\n\n${IMPORT}\n`);
    const v = await world();
    const none = await prev(v);
    assert.deepEqual(shape(none), [['rules/orchestration.md', 'create'], ['CLAUDE.md', 'create'], ['.claude/settings.local.json', 'unchanged']]);
    assert.equal(entry(none, 'CLAUDE.md').diff, '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -0,0 +1 @@\n+@rules/orchestration.md\n');
    await go(v, none);
    assert.equal(get(v, 'CLAUDE.md'), `${IMPORT}\n`);
    assert.equal(has(v, 'AGENTS.md'), false);
  });

  test('(+) existing modes: a 0600 AGENTS.md stays 0600, a 0664 one loses group write, a new CLAUDE.md is 0644', async () => {
    for (const [from, to] of [[0o600, 0o600], [0o664, 0o644], [0o640, 0o640]]) {
      const w = await world();
      put(w, 'AGENTS.md', '# a\n');
      fs.chmodSync(path.join(w.dir, 'AGENTS.md'), from);
      await go(w, await prev(w));
      assert.equal(mode(path.join(w.dir, 'AGENTS.md')), to, from.toString(8));
      assert.equal(mode(path.join(w.dir, 'CLAUDE.md')), 0o644);
    }
  });

  test('(−) a symlink, folder or FIFO named AGENTS.md beside a CLAUDE.md is skipped with a note: never followed, CLAUDE.md gets the import itself', async () => {
    const makers = {
      'a link to CLAUDE.md': { make: (w) => fs.symlinkSync('CLAUDE.md', path.join(w.dir, 'AGENTS.md')), note: /symbolic link/ },
      'a link to a file elsewhere': { make: (w) => fs.symlinkSync(outsideFile(w), path.join(w.dir, 'AGENTS.md')), note: /symbolic link/ },
      'a dangling link': { make: (w) => fs.symlinkSync(path.join(w.base, 'no-such-file'), path.join(w.dir, 'AGENTS.md')), note: /symbolic link/ },
      'a folder': { make: (w) => fs.mkdirSync(path.join(w.dir, 'AGENTS.md')), note: /not a regular file/ },
      'a FIFO': { make: (w) => execFileSync('mkfifo', [path.join(w.dir, 'AGENTS.md')]), note: /not a regular file/ },
    };
    for (const [label, { make, note }] of Object.entries(makers)) {
      const w = await world();
      put(w, 'CLAUDE.md', '# web-shop\n');
      make(w);
      const body = await prev(w); // must not block on a FIFO
      assert.deepEqual(shape(body), [['rules/orchestration.md', 'create'], ['AGENTS.md', 'skipped'], ['CLAUDE.md', 'update'], ['.claude/settings.local.json', 'unchanged']], label);
      const s = entry(body, 'AGENTS.md');
      assert.deepEqual(Object.keys(s).sort(), ['action', 'diff', 'note', 'path'], label);
      assert.equal(s.diff, '', label);
      assert.match(s.note, note, label);
      assert.match(s.note, /does not follow|left it as it is/, label);
      assert.equal('note' in entry(body, 'CLAUDE.md'), false, label);
      const before = fs.lstatSync(path.join(w.dir, 'AGENTS.md'));
      const r = await go(w, body);
      assert.deepEqual([r.status, r.body.written], [200, ['rules/orchestration.md', 'CLAUDE.md']], label);
      assert.equal(get(w, 'CLAUDE.md'), `# web-shop\n\n${IMPORT}\n`, label);
      const after = fs.lstatSync(path.join(w.dir, 'AGENTS.md'));
      assert.deepEqual([after.ino, after.mode, after.isSymbolicLink()], [before.ino, before.mode, before.isSymbolicLink()], label);
      if (label === 'a link to CLAUDE.md') assert.equal(fs.readlinkSync(path.join(w.dir, 'AGENTS.md')), 'CLAUDE.md');
      if (label === 'a link to a file elsewhere') assert.equal(fs.readFileSync(path.join(w.base, 'outside', 'secret.txt'), 'utf8'), 'SECRET');
      if (label === 'a dangling link') assert.equal(fs.existsSync(path.join(w.base, 'no-such-file')), false, 'never created through the link');
      assert.equal(fs.existsSync(path.join(r.body.backupDir, 'AGENTS.md')), false, label);
      const again = await prev(w);
      assert.deepEqual(again.files.map((f) => f.action), ['unchanged', 'skipped', 'unchanged', 'unchanged'], label);
      assert.deepEqual((await go(w, again)).body.written, [], label);
    }
  });

  test('(−) a CLAUDE.md with an @AGENTS.md line beside a symlinked AGENTS.md gets the import itself: the via-AGENTS.md row never applies', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', `${AGENTS_LINE}\n`);
    fs.symlinkSync(path.join(w.base, 'no-such-file'), path.join(w.dir, 'AGENTS.md'));
    const body = await prev(w);
    assert.equal(entry(body, 'AGENTS.md').action, 'skipped');
    assert.equal(entry(body, 'CLAUDE.md').action, 'update');
    assert.equal('note' in entry(body, 'CLAUDE.md'), false);
    await go(w, body);
    assert.equal(get(w, 'CLAUDE.md'), `${AGENTS_LINE}\n\n${IMPORT}\n`);
  });

  test('(−) a lone symlinked AGENTS.md (live or dangling) is refused 409 ESYMLINK; a lone folder or FIFO is refused 409 ENOTREG; nothing is written', async () => {
    for (const target of ['elsewhere.md', 'no-such-file']) {
      const w = await world();
      fs.writeFileSync(path.join(w.base, 'elsewhere.md'), 'SECRET');
      fs.symlinkSync(path.join(w.base, target), path.join(w.dir, 'AGENTS.md'));
      const before = snapshot(w.dir);
      const p = await preview(w.project, w.ctx);
      assert.deepEqual([p.status, p.body.error, p.body.code], [409, 'refused', 'ESYMLINK'], target);
      assert.match(p.body.message, /AGENTS\.md is a symlink/);
      assert.match(p.body.message, /no CLAUDE\.md/);
      const a = await apply(w.project, { hash: '0'.repeat(64) }, w.ctx);
      assert.deepEqual([a.status, a.body.error, a.body.code], [409, 'refused', 'ESYMLINK'], target);
      assert.deepEqual(snapshot(w.dir), before, target);
      assert.equal(fs.readFileSync(path.join(w.base, 'elsewhere.md'), 'utf8'), 'SECRET');
      assert.equal(fs.existsSync(path.join(w.base, 'no-such-file')), false, 'never created through the link');
    }
    const dirIn = await world();
    fs.mkdirSync(path.join(dirIn.dir, 'AGENTS.md'));
    const d = await preview(dirIn.project, dirIn.ctx);
    assert.deepEqual([d.status, d.body.error, d.body.code], [409, 'refused', 'ENOTREG']);
    assert.equal(has(dirIn, 'CLAUDE.md'), false);
    const f = await world();
    execFileSync('mkfifo', [path.join(f.dir, 'AGENTS.md')]);
    const fifo = await preview(f.project, f.ctx); // must not block on an open
    assert.deepEqual([fifo.status, fifo.body.error, fifo.body.code], [409, 'refused', 'ENOTREG']);
    const fa = await apply(f.project, { hash: '0'.repeat(64) }, f.ctx);
    assert.deepEqual([fa.status, fa.body.code], [409, 'ENOTREG']);
    assert.equal(fs.lstatSync(path.join(f.dir, 'AGENTS.md')).isFIFO(), true);
    assert.equal(has(f, 'rules'), false);
  });

  test('(−) a symlinked CLAUDE.md still refuses, with or without an AGENTS.md beside it, and AGENTS.md is left alone', async () => {
    for (const agents of [null, 'file', 'link']) {
      const w = await world();
      fs.writeFileSync(path.join(w.base, 'elsewhere.md'), 'SECRET');
      fs.symlinkSync(path.join(w.base, 'elsewhere.md'), path.join(w.dir, 'CLAUDE.md'));
      if (agents === 'file') put(w, 'AGENTS.md', '# a\n');
      if (agents === 'link') fs.symlinkSync(path.join(w.base, 'elsewhere.md'), path.join(w.dir, 'AGENTS.md'));
      const before = snapshot(w.dir);
      const p = await preview(w.project, w.ctx);
      assert.deepEqual([p.status, p.body.error, p.body.code], [409, 'refused', 'ESYMLINK'], String(agents));
      assert.match(p.body.message, /CLAUDE\.md/);
      assert.deepEqual(snapshot(w.dir), before, String(agents));
    }
  });

  test('(−) AGENTS.md is read as safely as CLAUDE.md: oversized, non-UTF-8 and hard-linked files are refused, nothing is written or leaked', async () => {
    const makers = {
      oversized: { make: (w) => put(w, 'AGENTS.md', 'x'.repeat(1024 * 1024 + 1)), status: 409, code: 'EFBIG' },
      'non-UTF-8': { make: (w) => fs.writeFileSync(path.join(w.dir, 'AGENTS.md'), Buffer.from([0x23, 0x20, 0xe9, 0x0a])), status: 400, error: 'invalid' },
      'hard-linked': { make: (w) => fs.linkSync(outsideFile(w), path.join(w.dir, 'AGENTS.md')), status: 409, code: 'ENLINK' },
    };
    for (const [label, { make, status, code, error }] of Object.entries(makers)) {
      for (const withClaude of [false, true]) {
        const w = await world();
        if (withClaude) put(w, 'CLAUDE.md', '# web-shop\n');
        make(w);
        const before = snapshot(w.dir);
        const p = await preview(w.project, w.ctx);
        assert.equal(p.status, status, `${label} ${withClaude}`);
        if (code) assert.equal(p.body.code, code, label);
        if (error) assert.equal(p.body.error, error, label);
        assert.match(p.body.message, /AGENTS\.md|hard-linked/, label);
        const a = await apply(w.project, { hash: '0'.repeat(64) }, w.ctx);
        assert.equal(a.status, status, label);
        assert.deepEqual(snapshot(w.dir), before, `${label}: nothing written`);
        if (label === 'hard-linked') assert.equal(fs.readFileSync(path.join(w.base, 'outside', 'secret.txt'), 'utf8'), 'SECRET');
      }
    }
  });

  test('(−) the hash covers AGENTS.md: a change of its text or type after the preview is a conflict (or a refusal) and nothing is written', async () => {
    const edits = {
      'text changes': { start: (w) => put(w, 'AGENTS.md', 'before\n'), change: (w) => put(w, 'AGENTS.md', 'after\n'), left: ['AGENTS.md'] },
      'text gets the import': { start: (w) => put(w, 'AGENTS.md', 'before\n'), change: (w) => put(w, 'AGENTS.md', `before\n${IMPORT}\n`), left: ['AGENTS.md'] },
      appears: { start: () => {}, change: (w) => put(w, 'AGENTS.md', 'arrived later\n'), left: ['AGENTS.md'] },
      disappears: { start: (w) => put(w, 'AGENTS.md', 'was here\n'), change: (w) => fs.rmSync(path.join(w.dir, 'AGENTS.md')), left: [] },
      'becomes a link': {
        start: (w) => put(w, 'AGENTS.md', '# swapped\n'),
        change: (w) => { fs.rmSync(path.join(w.dir, 'AGENTS.md')); fs.symlinkSync(path.join(w.base, 'no-such-file'), path.join(w.dir, 'AGENTS.md')); },
        left: ['AGENTS.md'],
      },
    };
    for (const [label, step] of Object.entries(edits)) {
      const w = await world();
      step.start(w);
      const body = await prev(w);
      step.change(w);
      const r = await go(w, body);
      assert.equal(r.status, 409, label);
      assert.ok(['conflict', 'refused'].includes(r.body.error), label);
      assert.deepEqual(Object.keys(snapshot(w.dir)), step.left, `${label}: no rules/, no CLAUDE.md`);
      assert.equal(fs.existsSync(backupsDir(w.project.key, w.env)), false, label);
    }
    // beside a CLAUDE.md the hash sees it too, including a link turning into a folder (the note changes)
    const w = await world();
    put(w, 'CLAUDE.md', '# web-shop\n');
    fs.symlinkSync(path.join(w.base, 'no-such-file'), path.join(w.dir, 'AGENTS.md'));
    const linked = await prev(w);
    fs.rmSync(path.join(w.dir, 'AGENTS.md'));
    fs.mkdirSync(path.join(w.dir, 'AGENTS.md'));
    assert.notEqual((await prev(w)).hash, linked.hash);
    assert.deepEqual([(await go(w, linked)).status], [409]);
    assert.equal(get(w, 'CLAUDE.md'), '# web-shop\n');
  });

  test('(−) AGENTS.md appearing, disappearing or changing inside the apply, after the hash check: 409, nothing written', async () => {
    const steps = {
      'appears as a file (none planned)': { start: () => {}, change: (w) => put(w, 'AGENTS.md', '# arrived in the gap\n'), left: ['AGENTS.md'], msg: /^AGENTS\.md changed while applying; preview again$/ },
      'appears as a link (none planned)': { start: () => {}, change: (w) => fs.symlinkSync(path.join(w.base, 'no-such-file'), path.join(w.dir, 'AGENTS.md')), left: ['AGENTS.md'], msg: /^AGENTS\.md changed while applying; preview again$/ },
      'appears beside an existing CLAUDE.md': { start: (w) => put(w, 'CLAUDE.md', '# web-shop\n'), change: (w) => put(w, 'AGENTS.md', '# arrived\n'), left: ['AGENTS.md', 'CLAUDE.md'], msg: /^AGENTS\.md changed while applying; preview again$/ },
      disappears: { start: (w) => put(w, 'AGENTS.md', '# leaving\n'), change: (w) => fs.rmSync(path.join(w.dir, 'AGENTS.md')), left: [], msg: /^AGENTS\.md changed while applying; preview again$/ },
      'text changes': { start: (w) => put(w, 'AGENTS.md', '# before\n'), change: (w) => put(w, 'AGENTS.md', '# after\n'), left: ['AGENTS.md'], msg: /^AGENTS\.md changed while applying; preview again$/ },
      'becomes a link': {
        start: (w) => put(w, 'AGENTS.md', '# swapped\n'),
        change: (w) => { fs.rmSync(path.join(w.dir, 'AGENTS.md')); fs.symlinkSync(path.join(w.base, 'no-such-file'), path.join(w.dir, 'AGENTS.md')); },
        left: ['AGENTS.md'],
        msg: /symlink/,
      },
    };
    for (const [label, step] of Object.entries(steps)) {
      const w = await world();
      step.start(w);
      const body = await prev(w);
      let calls = 0;
      const ctx = {
        env: w.env,
        now: () => { // called once, at the end of the apply's own plan: after the hash matched, before any write
          if (++calls === 1) step.change(w);
          return NOW;
        },
      };
      const r = await apply(w.project, { hash: body.hash }, ctx);
      assert.equal(r.status, 409, label);
      assert.match(r.body.message, step.msg, label);
      assert.deepEqual(Object.keys(snapshot(w.dir)), step.left, `${label}: no rules/, nothing written`);
      assert.equal(fs.existsSync(backupsDir(w.project.key, w.env)), false, label);
    }
  });

  test('(+) rules state: current needs the rules file and every regular instruction file covered', async () => {
    const current = {
      'the import in both': (w) => { put(w, 'CLAUDE.md', `${IMPORT}\n`); put(w, 'AGENTS.md', `${IMPORT}\n`); },
      'CLAUDE.md imports @AGENTS.md, AGENTS.md has the import': (w) => { put(w, 'CLAUDE.md', `${AGENTS_LINE}\n`); put(w, 'AGENTS.md', `# a\n\n${IMPORT}\n`); },
      'the same with @./AGENTS.md': (w) => { put(w, 'CLAUDE.md', '@./AGENTS.md\n'); put(w, 'AGENTS.md', `${IMPORT}\n`); },
      'only CLAUDE.md with the import': (w) => put(w, 'CLAUDE.md', `${IMPORT}\n`),
      'a symlinked AGENTS.md beside a CLAUDE.md with the import is ignored': (w) => { put(w, 'CLAUDE.md', `${IMPORT}\n`); fs.symlinkSync(path.join(w.base, 'no-such-file'), path.join(w.dir, 'AGENTS.md')); },
      'a folder named AGENTS.md beside a CLAUDE.md with the import is ignored': (w) => { put(w, 'CLAUDE.md', `${IMPORT}\n`); fs.mkdirSync(path.join(w.dir, 'AGENTS.md')); },
    };
    for (const [label, make] of Object.entries(current)) {
      const w = await world();
      make(w);
      await go(w, await prev(w), {}); // writes the rules file; the instruction files above already cover it, so they are not changed
      assert.equal((await rulesState(w.project)).state, 'nika', label);
    }
    // what Apply itself writes reads as current, in every layout
    for (const setup of [() => {}, (w) => put(w, 'CLAUDE.md', '# a\n'), (w) => put(w, 'AGENTS.md', '# a\n'), (w) => { put(w, 'CLAUDE.md', '# a\n'); put(w, 'AGENTS.md', '# b\n'); }, (w) => { put(w, 'CLAUDE.md', '@AGENTS.md\n'); put(w, 'AGENTS.md', '# b\n'); }]) {
      const w = await world();
      setup(w);
      assert.equal((await rulesState(w.project)).state, 'none');
      await go(w, await prev(w));
      assert.equal((await rulesState(w.project)).state, 'nika');
    }
  });

  test('(−) rules state: outdated when a regular instruction file does not carry the rules, though the rules file is current', async () => {
    const outdated = {
      'CLAUDE.md imports @AGENTS.md, AGENTS.md lacks the import': (w) => { put(w, 'CLAUDE.md', `${AGENTS_LINE}\n`); put(w, 'AGENTS.md', '# a\n'); },
      'AGENTS.md has the import, no CLAUDE.md': (w) => put(w, 'AGENTS.md', `${IMPORT}\n`),
      'CLAUDE.md has the import, AGENTS.md lacks it': (w) => { put(w, 'CLAUDE.md', `${IMPORT}\n`); put(w, 'AGENTS.md', '# a\n'); },
      'AGENTS.md has the import, CLAUDE.md has neither': (w) => { put(w, 'CLAUDE.md', '# a\n'); put(w, 'AGENTS.md', `${IMPORT}\n`); },
      'CLAUDE.md lacks the import, no AGENTS.md': (w) => put(w, 'CLAUDE.md', '# a\n'),
      'neither file exists': () => {},
    };
    for (const [label, make] of Object.entries(outdated)) {
      const w = await world();
      await go(w, await prev(w)); // a current rules file ...
      for (const rel of ['CLAUDE.md', 'AGENTS.md']) fs.rmSync(path.join(w.dir, rel), { force: true });
      make(w); // ... beside instruction files that do not all cover it
      assert.equal((await rulesState(w.project)).state, 'outdated', label);
    }
    // the rules file's own state wins where it is worse: foreign stays foreign, and no rules file stays none
    const f = await world();
    put(f, 'rules/orchestration.md', '# my own rules\n');
    put(f, 'AGENTS.md', '# a\n');
    assert.equal((await rulesState(f.project)).state, 'foreign');
    const n = await world();
    put(n, 'AGENTS.md', '# a\n');
    assert.equal((await rulesState(n.project)).state, 'none');
    // an instruction file nika cannot read safely is not something Apply could fix by writing: the rules file decides
    const u = await world();
    await go(u, await prev(u));
    put(u, 'AGENTS.md', 'x'.repeat(1024 * 1024 + 1));
    assert.equal((await rulesState(u.project)).state, 'nika');
  });
});

describe('settings.local.json merge (T5)', () => {
  const ORIGINAL = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo synthetic' }] }] },
    permissions: { allow: ['Bash(ls:*)'], deny: ['Read(.env)'] },
    enabledPlugins: { 'old-one@demo-market': true, 'off-one@demo-market': false, 'keep@demo-market': true },
    env: { SYNTHETIC: '1' },
    apiKeyHelper: 'echo synthetic-helper',
    mcpServers: { demo: { command: 'demo', args: ['--x'] } },
    model: 'sonnet',
    extra: { n: 1.5, big: 1e21, nested: [1, [2, { a: null }]], s: 'café', t: true },
  };

  test('(+) other keys survive deep-equal and in order; enabledPlugins: selected true, stale true removed, false kept', async () => {
    const w = await world({ plugins: ['keep@demo-market', 'new-one@demo-market'] });
    put(w, '.claude/settings.local.json', JSON.stringify(ORIGINAL));
    const body = await prev(w);
    const s = entry(body, '.claude/settings.local.json');
    assert.deepEqual([s.action, s.keysPreserved], ['update', true]);
    const result = await go(w, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const text = get(w, '.claude/settings.local.json');
    const out = JSON.parse(text);
    assert.deepEqual(out.enabledPlugins, { 'off-one@demo-market': false, 'keep@demo-market': true, 'new-one@demo-market': true });
    assert.deepEqual(Object.keys(out), Object.keys(ORIGINAL));
    const { enabledPlugins: _a, ...restOut } = out;
    const { enabledPlugins: _b, ...restIn } = ORIGINAL;
    assert.deepEqual(restOut, restIn);
    assert.equal(text, `${JSON.stringify(out, null, 2)}\n`);
    assert.equal(fs.readFileSync(path.join(backupsDir(w.project.key, w.env), STAMP, '.claude/settings.local.json'), 'utf8'), JSON.stringify(ORIGINAL), 'the original is backed up');
  });

  test('(+) a file without enabledPlugins gets one at the end', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, '.claude/settings.local.json', '{"model":"opus","env":{"A":"1"}}');
    await go(w, await prev(w));
    assert.deepEqual(JSON.parse(get(w, '.claude/settings.local.json')), { model: 'opus', env: { A: '1' }, enabledPlugins: { 'alpha@demo-market': true } });
    assert.deepEqual(Object.keys(JSON.parse(get(w, '.claude/settings.local.json'))), ['model', 'env', 'enabledPlugins']);
  });

  test('(+) a selection of other plugins removes every true entry that is not selected, keeps false ones', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, '.claude/settings.local.json', '{"enabledPlugins":{"a@b-c":true,"d@b-c":false}}');
    await go(w, await prev(w));
    assert.deepEqual(JSON.parse(get(w, '.claude/settings.local.json')), { enabledPlugins: { 'd@b-c': false, 'alpha@demo-market': true } });
  });

  test('(+) nothing to change keeps the file byte for byte (formatting included); no file and no plugins stays absent', async () => {
    const w = await world({ plugins: ['keep@demo-market'] });
    const odd = '{\n\t"model": "x",   "enabledPlugins": {"keep@demo-market":true}\n}';
    put(w, '.claude/settings.local.json', odd);
    const body = await prev(w);
    assert.equal(entry(body, '.claude/settings.local.json').action, 'unchanged');
    await go(w, body);
    assert.equal(get(w, '.claude/settings.local.json'), odd);
    const v = await world();
    await go(v, await prev(v));
    assert.equal(has(v, '.claude'), false);
  });

  test('(+) a project nika has no plugin selection for keeps enabledPlugins as it is, even if the file is not valid JSON', async () => {
    const w = await world();
    put(w, '.claude/settings.local.json', '{"enabledPlugins":{"a@b-c":true}}');
    assert.equal(entry(await prev(w), '.claude/settings.local.json').action, 'unchanged');
    put(w, '.claude/settings.local.json', 'not json');
    const body = await prev(w);
    assert.equal(entry(body, '.claude/settings.local.json').action, 'unchanged');
    await go(w, body);
    assert.equal(get(w, '.claude/settings.local.json'), 'not json');
  });

  test('(+) the selected plugins come from perProject[key].plugins, as the project page saves them', async () => {
    const w = await world();
    await updateProjectConfig(w.project.key, { plugins: ['zed@demo-market', 'alpha@demo-market'] }, w.env);
    put(w, '.claude/settings.local.json', '{"model":"x","enabledPlugins":{"old@demo-market":true,"off@demo-market":false}}');
    const body = await prev(w);
    await go(w, body);
    assert.deepEqual(JSON.parse(get(w, '.claude/settings.local.json')), { model: 'x', enabledPlugins: { 'off@demo-market': false, 'zed@demo-market': true, 'alpha@demo-market': true } });
    assert.match(get(w, 'rules/orchestration.md'), /`zed@demo-market`, `alpha@demo-market`/, 'the rules text lists them too');
  });

  test('(−) removing the list on the project page (or an entry without plugins) leaves enabledPlugins as it is', async () => {
    const w = await world();
    const file = '{"enabledPlugins":{"keep@demo-market":true}}';
    await updateProjectConfig(w.project.key, { plugins: ['alpha@demo-market'] }, w.env);
    await updateProjectConfig(w.project.key, { plugins: [] }, w.env);
    put(w, '.claude/settings.local.json', file);
    assert.equal(entry(await prev(w), '.claude/settings.local.json').action, 'unchanged');
    const v = await world();
    const { config } = await loadConfig(v.env);
    config.perProject[v.project.key] = {};
    await saveConfig(config, v.env);
    put(v, '.claude/settings.local.json', file);
    assert.equal(entry(await prev(v), '.claude/settings.local.json').action, 'unchanged');
    assert.match(await (async () => { await go(v, await prev(v)); return get(v, 'rules/orchestration.md'); })(), /none/);
  });

  test('(+) an empty list ([] saved by hand or by 0.3.3) is "no entry": the preview leaves enabledPlugins alone', async () => {
    const file = '{"enabledPlugins":{"keep@demo-market":true,"off@demo-market":false}}';
    for (const shape of ['0.3.3', '0.3.4']) {
      const w = await world();
      const cfg = path.join(configDir(w.env), 'config.json');
      const raw = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      delete raw.perProject;
      if (shape === '0.3.3') raw.plugins = { perProject: { [w.project.key]: [] } };
      else raw.perProject = { [w.project.key]: { plugins: [] } };
      fs.writeFileSync(cfg, JSON.stringify(raw));
      put(w, '.claude/settings.local.json', file);
      const body = await prev(w);
      assert.equal(entry(body, '.claude/settings.local.json').action, 'unchanged', shape);
      await go(w, body);
      assert.equal(get(w, '.claude/settings.local.json'), file, shape);
      assert.match(get(w, 'rules/orchestration.md'), /none/, shape);
    }
  });

  test('(+) an install upgraded from 0.3.3 (plugins.perProject, no perProject) keeps its plugin choices when rules are applied', async () => {
    const w = await world();
    const file = path.join(configDir(w.env), 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.perProject;
    raw.plugins = { perProject: { [w.project.key]: ['legacy@demo-market'] } };
    fs.writeFileSync(file, JSON.stringify(raw));
    put(w, '.claude/settings.local.json', '{}');
    await go(w, await prev(w));
    assert.deepEqual(JSON.parse(get(w, '.claude/settings.local.json')), { enabledPlugins: { 'legacy@demo-market': true } });
  });

  test('(−) invalid JSON, non-objects, empty file, bad enabledPlugins and __proto__ / constructor / prototype keys are 400 invalid, nothing written', async () => {
    const bad = [
      '{ nope', '', '[]', 'null', '"s"', '3', '{"a":1,}',
      '{"__proto__":{"x":1}}', '{"a":{"b":[{"__proto__":{}}]}}', '{"constructor":{}}', '{"deep":{"prototype":1}}', '{"enabledPlugins":{"__proto__":true}}',
      '{"enabledPlugins":[]}', '{"enabledPlugins":"x"}', '{"enabledPlugins":null}',
    ];
    for (const text of bad) {
      const w = await world({ plugins: ['alpha@demo-market'] });
      put(w, '.claude/settings.local.json', text);
      const before = snapshot(w.dir);
      const p = await preview(w.project, w.ctx);
      assert.deepEqual([p.status, p.body.error], [400, 'invalid'], JSON.stringify(text));
      const a = await apply(w.project, { hash: '0'.repeat(64), overwriteForeign: true, gitignore: true }, w.ctx);
      assert.deepEqual([a.status, a.body.error], [400, 'invalid'], JSON.stringify(text));
      assert.deepEqual(snapshot(w.dir), before, JSON.stringify(text));
    }
  });

  test('(−) a value that cannot survive a rewrite is refused instead of silently changed', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, '.claude/settings.local.json', '{"n":1e999}');
    const r = await preview(w.project, w.ctx);
    assert.deepEqual([r.status, r.body.error], [400, 'invalid']);
    assert.equal(get(w, '.claude/settings.local.json'), '{"n":1e999}');
  });
});

describe('settings.local.json preview: enabledPlugins block only (contract §3)', () => {
  const settings = '.claude/settings.local.json';
  const SECRETS = ['SYNTH-SECRET-ENV-VALUE', 'SYNTH-SECRET-ALLOW', 'SYNTH-SECRET-DENY', 'SYNTH-SECRET-HOOK', 'SYNTH-SECRET-HELPER', 'SYNTH-SECRET-MCP', 'SYNTH-SECRET-MODEL'];
  const WITH_SECRETS = {
    env: { TOKEN: SECRETS[0] },
    permissions: { allow: [`Bash(${SECRETS[1]}:*)`], deny: [`Read(${SECRETS[2]})`] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `echo ${SECRETS[3]}` }] }] },
    enabledPlugins: { 'old-one@demo-market': true, 'off-one@demo-market': false, 'keep@demo-market': true },
    apiKeyHelper: `echo ${SECRETS[4]}`,
    mcpServers: { demo: { command: 'demo', args: [SECRETS[5]] } },
    model: SECRETS[6],
  };
  const leaks = (body) => SECRETS.filter((x) => JSON.stringify(body).includes(x));

  test('(+) update: the diff is the enabledPlugins block before and after, keptKeys counts the other keys', async () => {
    const w = await world({ plugins: ['keep@demo-market', 'new-one@demo-market'] });
    put(w, settings, JSON.stringify({ ...WITH_SECRETS }));
    const s = entry(await prev(w), settings);
    assert.deepEqual(Object.keys(s), ['path', 'action', 'diff', 'keysPreserved', 'keptKeys']);
    assert.deepEqual([s.action, s.keysPreserved, s.keptKeys], ['update', true, 6]);
    assert.equal(s.diff, [
      '--- a/.claude/settings.local.json', '+++ b/.claude/settings.local.json', '@@ -1,7 +1,7 @@',
      ' {', '   "enabledPlugins": {', '-    "old-one@demo-market": true,', '     "off-one@demo-market": false,',
      '-    "keep@demo-market": true', '+    "keep@demo-market": true,', '+    "new-one@demo-market": true', '   }', ' }', '',
    ].join('\n'));
  });

  test('(+) a file without enabledPlugins: before is {} and the block is added; a new file has an empty before and keptKeys 0', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, settings, '{"model":"x","env":{"A":"1"}}');
    const s = entry(await prev(w), settings);
    assert.deepEqual([s.action, s.keptKeys], ['update', 2]);
    assert.equal(s.diff, '--- a/.claude/settings.local.json\n+++ b/.claude/settings.local.json\n@@ -1 +1,5 @@\n-{}\n+{\n+  "enabledPlugins": {\n+    "alpha@demo-market": true\n+  }\n+}\n');
    const v = await world({ plugins: ['alpha@demo-market'] });
    const created = entry(await prev(v), settings);
    assert.deepEqual([created.action, created.keptKeys], ['create', 0]);
    assert.match(created.diff, /^--- a\/\.claude\/settings\.local\.json\n\+\+\+ b\/\.claude\/settings\.local\.json\n@@ -0,0 \+1,5 @@\n/);
  });

  test('(+) unchanged: empty diff, keptKeys still counts the other keys; a missing file gives 0', async () => {
    const w = await world({ plugins: ['keep@demo-market'] });
    put(w, settings, '{"enabledPlugins":{"keep@demo-market":true},"env":{"A":"1"},"model":"x"}');
    const s = entry(await prev(w), settings);
    assert.deepEqual([s.action, s.diff, s.keptKeys], ['unchanged', '', 2]);
    const v = await world();
    assert.deepEqual([entry(await prev(v), settings).action, entry(await prev(v), settings).keptKeys], ['unchanged', 0]);
  });

  test('(−) no value of env, permissions, hooks, apiKeyHelper, mcpServers or model appears anywhere in the preview response', async () => {
    for (const plugins of [['keep@demo-market', 'new-one@demo-market'], [], undefined]) {
      const w = await world({ plugins, git: true });
      put(w, settings, JSON.stringify(WITH_SECRETS));
      const body = await prev(w);
      assert.deepEqual(leaks(body), [], JSON.stringify(plugins));
      for (const key of ['env', 'permissions', 'hooks', 'apiKeyHelper', 'mcpServers', 'model', 'TOKEN']) {
        assert.equal(entry(body, settings).diff.includes(`"${key}"`), false, `${key} in the diff`);
      }
    }
  });

  test('(−) the secrets stay out of an error response too, and a settings file that is not valid JSON never has its text echoed', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, settings, `{"env":{"TOKEN":"${SECRETS[0]}"},"enabledPlugins":[]}`);
    const r = await preview(w.project, w.ctx);
    assert.equal(r.status, 400);
    assert.deepEqual(leaks(r.body), []);
    const v = await world();
    put(v, settings, `not json ${SECRETS[0]}`);
    const none = await prev(v);
    assert.deepEqual([entry(none, settings).action, entry(none, settings).diff, entry(none, settings).keptKeys], ['unchanged', '', 0]);
    assert.deepEqual(leaks(none), []);
  });

  test('(+) the plan hash still covers the full file: a change to a hidden value is a different hash and apply refuses the stale one', async () => {
    const w = await world({ plugins: ['keep@demo-market'] });
    put(w, settings, JSON.stringify(WITH_SECRETS));
    const a = await prev(w);
    put(w, settings, JSON.stringify({ ...WITH_SECRETS, env: { TOKEN: 'SYNTH-OTHER-VALUE' } }));
    const b = await prev(w);
    assert.equal(entry(a, settings).diff, entry(b, settings).diff, 'the page cannot tell the two files apart');
    assert.notEqual(a.hash, b.hash);
    const before = snapshot(w.dir);
    const stale = await go(w, a);
    assert.deepEqual([stale.status, stale.body.error], [409, 'conflict']);
    assert.deepEqual(snapshot(w.dir), before);
    const ok = await go(w, b);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const out = JSON.parse(get(w, settings));
    assert.deepEqual(out.env, { TOKEN: 'SYNTH-OTHER-VALUE' });
    assert.deepEqual(out.hooks, WITH_SECRETS.hooks);
    assert.deepEqual(out.enabledPlugins, { 'off-one@demo-market': false, 'keep@demo-market': true });
  });
});

describe('apply', () => {
  test('(+) writes exactly the allowed files with the right modes; the repo gets nothing else; no git', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    const body = await prev(w);
    const r = await go(w, body, { gitignore: true });
    assert.deepEqual([r.status, r.body.written], [200, ['rules/orchestration.md', 'CLAUDE.md', '.claude/settings.local.json', '.gitignore']]);
    assert.equal(r.body.backupDir, body.backupDir);
    assert.deepEqual(Object.keys(snapshot(w.dir)).sort(), ['.claude/', '.claude/settings.local.json', '.gitignore', 'CLAUDE.md', 'rules/', 'rules/orchestration.md']);
    for (const f of ['rules/orchestration.md', 'CLAUDE.md', '.gitignore']) assert.equal(mode(path.join(w.dir, f)), 0o644, f);
    assert.equal(mode(path.join(w.dir, '.claude/settings.local.json')), 0o600, 'a new settings file is user-local');
    for (const d of ['rules', '.claude']) assert.equal(mode(path.join(w.dir, d)) & 0o700, 0o700, d);
    assert.equal(get(w, 'CLAUDE.md'), `${IMPORT}\n`);
    assert.equal(get(w, '.gitignore'), '.claude/settings.local.json\n');
    assert.equal(has(w, '.git'), false);
    assert.equal(fs.existsSync(body.backupDir), false, 'nothing existed, so nothing was backed up');
  });

  test('(+) an existing 0600 settings.local.json stays 0600; an existing 0664 CLAUDE.md becomes 0644', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, '.claude/settings.local.json', '{"model":"x"}');
    put(w, 'CLAUDE.md', '# Mine\n');
    fs.chmodSync(path.join(w.dir, '.claude/settings.local.json'), 0o600);
    fs.chmodSync(path.join(w.dir, 'CLAUDE.md'), 0o664);
    const r = await go(w, await prev(w));
    assert.deepEqual(r.body.written, ['rules/orchestration.md', 'CLAUDE.md', '.claude/settings.local.json']);
    assert.equal(mode(path.join(w.dir, '.claude/settings.local.json')), 0o600);
    assert.equal(mode(path.join(w.dir, 'CLAUDE.md')), 0o644);
    assert.equal(mode(path.join(w.dir, 'rules/orchestration.md')), 0o644, 'a new rules file is 0644');
  });

  test('(−) modes are never widened: 0600 and 0640 files stay as they are, group/other write bits are dropped, other bits kept', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, 'CLAUDE.md', '# Mine\n');
    put(w, 'rules/orchestration.md', rulesMarker('older\n', TEMPLATE_VERSION - 1));
    put(w, '.gitignore', 'node_modules\n');
    for (const [rel, m] of [['CLAUDE.md', 0o600], ['rules/orchestration.md', 0o640], ['.gitignore', 0o775]]) fs.chmodSync(path.join(w.dir, rel), m);
    await go(w, await prev(w), { gitignore: true });
    assert.equal(mode(path.join(w.dir, 'CLAUDE.md')), 0o600, '0600 is not widened to 0644');
    assert.equal(mode(path.join(w.dir, 'rules/orchestration.md')), 0o640, '0640 is not widened');
    assert.equal(mode(path.join(w.dir, '.gitignore')), 0o755, '0775 loses group write, keeps the rest');
    assert.equal(mode(path.join(w.dir, '.claude/settings.local.json')), 0o600, 'new settings file');
  });

  test('(+) idempotent: the second preview is all unchanged, a second apply writes nothing and makes no backup', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    await go(w, await prev(w), { gitignore: true });
    const again = await prev(w);
    assert.deepEqual(again.files.map((f) => f.action), ['unchanged', 'unchanged', 'unchanged']);
    assert.deepEqual(again.files.map((f) => f.diff), ['', '', '']);
    assert.deepEqual(again.warnings, ['no .git in the project folder: not a git repository (or a subfolder of one)']);
    const before = snapshot(w.dir);
    const r = await go(w, again, { gitignore: true });
    assert.deepEqual([r.status, r.body.written], [200, []]);
    assert.deepEqual(snapshot(w.dir), before);
    assert.equal(fs.existsSync(backupsDir(w.project.key, w.env)), false);
    const bare = await world();
    await go(bare, await prev(bare));
    assert.deepEqual((await prev(bare)).files.map((f) => f.action), ['unchanged', 'unchanged', 'unchanged']);
  });

  test('(+) existing files are backed up (0600 files, 0700 folders) outside the repo before being overwritten', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, 'CLAUDE.md', '# Mine\n');
    put(w, '.claude/settings.local.json', '{"model":"x"}');
    put(w, 'rules/orchestration.md', rulesMarker('older\n', TEMPLATE_VERSION - 1));
    const body = await prev(w);
    const r = await go(w, body);
    assert.deepEqual(r.body.written, ['rules/orchestration.md', 'CLAUDE.md', '.claude/settings.local.json']);
    const b = path.join(backupsDir(w.project.key, w.env), STAMP);
    assert.equal(r.body.backupDir, b);
    assert.equal(fs.readFileSync(path.join(b, 'CLAUDE.md'), 'utf8'), '# Mine\n');
    assert.equal(fs.readFileSync(path.join(b, '.claude/settings.local.json'), 'utf8'), '{"model":"x"}');
    assert.equal(fs.readFileSync(path.join(b, 'rules/orchestration.md'), 'utf8'), rulesMarker('older\n', TEMPLATE_VERSION - 1));
    assert.equal(mode(path.join(b, 'CLAUDE.md')), 0o600);
    assert.equal(mode(b), 0o700);
    assert.equal(b.startsWith(w.dir), false, 'backups live outside the project');
    assert.equal((await rulesState(w.project)).state, 'nika');
    assert.deepEqual(fs.readdirSync(w.dir).filter((f) => f.endsWith('.bak') || f.endsWith('.tmp')), []);
  });

  test('(+) two applies in the same second keep both backups (suffix), the first is not overwritten', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', 'first\n');
    await go(w, await prev(w));
    put(w, 'CLAUDE.md', 'second\n');
    const r = await go(w, await prev(w));
    const b = path.join(backupsDir(w.project.key, w.env), STAMP);
    assert.equal(r.body.backupDir, `${b}-1`);
    assert.equal(fs.readFileSync(path.join(b, 'CLAUDE.md'), 'utf8'), 'first\n');
    assert.equal(fs.readFileSync(path.join(`${b}-1`, 'CLAUDE.md'), 'utf8'), 'second\n');
  });

  /** One apply per second; CLAUDE.md exists with new content each time, so every apply makes a backup folder. */
  async function applyTimes(w, from, to) {
    const out = [];
    for (let i = from; i < to; i += 1) {
      const ctx = { env: w.env, now: () => NOW + i * 1000 };
      put(w, 'CLAUDE.md', `v${i}\n`);
      const r = await apply(w.project, { hash: (await preview(w.project, ctx)).body.hash }, ctx);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      out.push(path.basename(r.body.backupDir));
    }
    return out;
  }

  test('(+) the 11th apply prunes exactly the oldest backup folder; the newest ten and their files stay', async () => {
    const w = await world();
    const base = backupsDir(w.project.key, w.env);
    const stamps = await applyTimes(w, 0, 10);
    assert.deepEqual(fs.readdirSync(base).sort(), [...stamps].sort(), 'ten applies keep all ten');
    stamps.push(...(await applyTimes(w, 10, 11)));
    assert.deepEqual(fs.readdirSync(base).sort(), stamps.slice(1).sort(), 'the 11th removes the oldest only');
    assert.equal(fs.existsSync(path.join(base, stamps[0])), false);
    assert.equal(fs.readFileSync(path.join(base, stamps[1], 'CLAUDE.md'), 'utf8'), 'v1\n');
    assert.equal(fs.readFileSync(path.join(base, stamps[10], 'CLAUDE.md'), 'utf8'), 'v10\n', 'the backup just made is among the kept');
    stamps.push(...(await applyTimes(w, 11, 13)));
    assert.deepEqual(fs.readdirSync(base).sort(), stamps.slice(3).sort(), 'every further apply removes one more');
  });

  test('(−) pruning never deletes or follows a symlink, a regular file or a foreign-named entry in the backups folder', async () => {
    const w = await world();
    const base = backupsDir(w.project.key, w.env);
    const outside = path.join(w.base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'precious'), 'PRECIOUS');
    const stamps = await applyTimes(w, 0, 10);
    fs.symlinkSync(outside, path.join(base, '20200101T000000Z')); // older than everything, a link out
    fs.writeFileSync(path.join(base, '20200102T000000Z'), 'a file');
    fs.mkdirSync(path.join(base, 'notes'));
    fs.writeFileSync(path.join(base, 'notes', 'mine.txt'), 'mine');
    const added = await applyTimes(w, 10, 11);
    assert.deepEqual(fs.readdirSync(base).sort(), ['20200101T000000Z', '20200102T000000Z', 'notes', ...stamps.slice(1), ...added].sort());
    assert.equal(fs.lstatSync(path.join(base, '20200101T000000Z')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'PRECIOUS');
    assert.equal(fs.readFileSync(path.join(base, 'notes', 'mine.txt'), 'utf8'), 'mine');
    assert.equal(fs.readFileSync(path.join(base, '20200102T000000Z'), 'utf8'), 'a file');
  });

  test('(+) .gitignore is opt-in: skipped without the flag, appended after a newline-less last line, not offered when already ignored', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    const body = await prev(w);
    const r = await go(w, body);
    assert.deepEqual(r.body.written, ['rules/orchestration.md', 'CLAUDE.md', '.claude/settings.local.json']);
    assert.equal(has(w, '.gitignore'), false);
    put(w, '.gitignore', 'node_modules');
    const second = await prev(w);
    assert.equal(entry(second, '.gitignore').action, 'update');
    await go(w, second, { gitignore: true });
    assert.equal(get(w, '.gitignore'), 'node_modules\n.claude/settings.local.json\n');
    const v = await world({ plugins: ['alpha@demo-market'] });
    put(v, '.gitignore', '.claude/\n');
    const vb = await prev(v);
    assert.equal(entry(vb, '.gitignore'), undefined);
    assert.deepEqual(vb.warnings.filter((x) => /gitignored/.test(x)), []);
    await go(v, vb, { gitignore: true });
    assert.equal(get(v, '.gitignore'), '.claude/\n');
  });

  test('(−) a foreign rules file: preview flags it, apply needs overwriteForeign, then it is backed up and replaced', async () => {
    const w = await world();
    put(w, 'rules/orchestration.md', '# hand written\n');
    const body = await prev(w);
    const rules = entry(body, 'rules/orchestration.md');
    assert.deepEqual([rules.action, rules.foreign], ['update', true]);
    const before = snapshot(w.dir);
    for (const extra of [{}, { overwriteForeign: false }]) {
      const refused = await go(w, body, extra);
      assert.deepEqual([refused.status, refused.body.error], [409, 'foreign']);
    }
    assert.deepEqual(snapshot(w.dir), before, 'CLAUDE.md was not created either');
    const ok = await go(w, body, { overwriteForeign: true });
    assert.equal(ok.status, 200);
    assert.equal(fs.readFileSync(path.join(ok.body.backupDir, 'rules/orchestration.md'), 'utf8'), '# hand written\n');
    assert.equal((await rulesState(w.project)).state, 'nika');
  });

  test('(−) an edited nika file is foreign too (hand edits are not silently overwritten)', async () => {
    const w = await world();
    await go(w, await prev(w));
    put(w, 'rules/orchestration.md', `${get(w, 'rules/orchestration.md')}\nmy addition\n`);
    const body = await prev(w);
    assert.equal(entry(body, 'rules/orchestration.md').foreign, true);
    assert.equal((await go(w, body)).body.error, 'foreign');
  });

  test('(−) a stale hash is 409 conflict and writes nothing (file edited, config changed, malformed hash is 400)', async () => {
    const w = await world();
    const body = await prev(w);
    put(w, 'CLAUDE.md', 'changed after the preview\n');
    const before = snapshot(w.dir);
    const r = await go(w, body);
    assert.deepEqual([r.status, r.body.error], [409, 'conflict']);
    assert.deepEqual(snapshot(w.dir), before);
    const fresh = await prev(w);
    await updateSettings({ limits: { maxAgents: 2 } }, w.env);
    assert.equal((await go(w, fresh)).body.error, 'conflict');
    for (const hash of [undefined, '', 'abc', 'G'.repeat(64), 'A'.repeat(64), 5]) {
      const bad = await apply(w.project, { hash }, w.ctx);
      assert.deepEqual([bad.status, bad.body.error], [400, 'invalid'], String(hash));
    }
    for (const opts of [null, 'x', [], { hash: fresh.hash, overwriteForeign: 'yes' }, { hash: fresh.hash, gitignore: 1 }]) {
      assert.equal((await apply(w.project, opts, w.ctx)).status, 400, JSON.stringify(opts));
    }
    assert.deepEqual(snapshot(w.dir), before);
  });

  test('(−) a target that changes between the plan and the write is a conflict, not an overwrite', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', 'before\n');
    const body = await prev(w);
    let calls = 0;
    const ctx = { env: w.env, now: () => { if (++calls === 1) put(w, 'CLAUDE.md', 'sneaky edit\n'); return NOW; } };
    const r = await apply(w.project, { hash: body.hash }, ctx);
    assert.deepEqual([r.status, r.body.error], [409, 'conflict']);
    assert.equal(get(w, 'CLAUDE.md'), 'sneaky edit\n');
    assert.equal(has(w, 'rules'), false);
  });

  test('(+) a group-writable project folder follows the Linux-only policy (platform and gid injected)', async () => {
    const w = await world();
    fs.chmodSync(w.dir, 0o775);
    const gid = fs.lstatSync(w.dir).gid;
    const body = await prev(w);
    const mac = await apply(w.project, { hash: body.hash }, { ...w.ctx, platform: 'darwin', gid });
    assert.deepEqual([mac.status, mac.body.error, mac.body.code], [409, 'refused', 'EMODE']);
    const other = await apply(w.project, { hash: body.hash }, { ...w.ctx, platform: 'linux', gid: gid + 1 });
    assert.equal(other.body.code, 'EMODE');
    assert.deepEqual(fs.readdirSync(w.dir), []);
    const linux = await apply(w.project, { hash: body.hash }, { ...w.ctx, platform: 'linux', gid });
    assert.deepEqual([linux.status, linux.body.written], [200, ['rules/orchestration.md', 'CLAUDE.md']]);
    assert.equal(get(w, 'CLAUDE.md'), `${IMPORT}\n`);
  });

  test('(−) a world-writable project folder is refused before anything is created, on linux too', async () => {
    const w = await world();
    const body = await prev(w);
    fs.chmodSync(w.dir, 0o777);
    const gid = fs.lstatSync(w.dir).gid;
    for (const ctx of [w.ctx, { ...w.ctx, platform: 'linux', gid }]) {
      const r = await apply(w.project, { hash: body.hash }, ctx);
      assert.deepEqual([r.status, r.body.error, r.body.code], [409, 'refused', 'EMODE']);
      assert.deepEqual(fs.readdirSync(w.dir), []);
    }
    fs.chmodSync(w.dir, 0o755);
  });
});

describe('symlinks and hard links (T8)', () => {
  /** Preview and apply must both refuse with `code`, and nothing inside the project or the decoy may change. */
  async function refused(w, code, decoy, label) {
    const before = snapshot(w.dir);
    const decoyBefore = decoy ? snapshot(decoy) : null;
    const p = await preview(w.project, w.ctx);
    assert.deepEqual([p.status, p.body.error, p.body.code], [409, 'refused', code], `${label} preview`);
    const a = await apply(w.project, { hash: '0'.repeat(64), overwriteForeign: true, gitignore: true }, w.ctx);
    assert.deepEqual([a.status, a.body.error, a.body.code], [409, 'refused', code], `${label} apply`);
    assert.deepEqual(snapshot(w.dir), before, `${label}: project untouched`);
    if (decoy) assert.deepEqual(snapshot(decoy), decoyBefore, `${label}: decoy untouched`);
  }
  const outside = (w) => {
    const d = path.join(w.base, 'outside');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'secret.txt'), 'SECRET');
    return d;
  };

  test('(−) a symlinked rules/ folder', async () => {
    const w = await world();
    const d = outside(w);
    fs.symlinkSync(d, path.join(w.dir, 'rules'));
    await refused(w, 'ESYMLINK', d, 'rules/');
    assert.equal(fs.existsSync(path.join(d, 'orchestration.md')), false);
    assert.equal(has(w, 'CLAUDE.md'), false);
  });

  test('(−) a symlinked .claude/ folder', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    const d = outside(w);
    fs.symlinkSync(d, path.join(w.dir, '.claude'));
    await refused(w, 'ESYMLINK', d, '.claude/');
    assert.equal(fs.existsSync(path.join(d, 'settings.local.json')), false);
  });

  test('(−) a symlinked target file: CLAUDE.md, rules/orchestration.md, settings.local.json, .gitignore', async () => {
    for (const rel of ['CLAUDE.md', 'rules/orchestration.md', '.claude/settings.local.json']) {
      const w = await world({ plugins: ['alpha@demo-market'] });
      const d = outside(w);
      const file = path.join(d, 'secret.txt');
      fs.mkdirSync(path.dirname(path.join(w.dir, rel)), { recursive: true });
      fs.symlinkSync(file, path.join(w.dir, rel));
      await refused(w, 'ESYMLINK', d, rel);
      assert.equal(fs.readFileSync(file, 'utf8'), 'SECRET');
    }
    // an unreadable .gitignore only drops the optional entry; the symlink is never followed or written
    const w = await world({ plugins: ['alpha@demo-market'] });
    const d = outside(w);
    fs.symlinkSync(path.join(d, 'secret.txt'), path.join(w.dir, '.gitignore'));
    const body = await prev(w);
    assert.equal(entry(body, '.gitignore'), undefined);
    assert.ok(body.warnings.some((x) => /\.gitignore cannot be read safely/.test(x)));
    await go(w, body, { gitignore: true });
    assert.equal(fs.readFileSync(path.join(d, 'secret.txt'), 'utf8'), 'SECRET');
  });

  test('(−) a symlinked AGENTS.md (live, dangling, or planted after the preview) is refused and never followed', async () => {
    const w = await world();
    const d = outside(w);
    fs.symlinkSync(path.join(d, 'secret.txt'), path.join(w.dir, 'AGENTS.md'));
    await refused(w, 'ESYMLINK', d, 'AGENTS.md live');
    assert.equal(fs.readFileSync(path.join(d, 'secret.txt'), 'utf8'), 'SECRET');
    assert.equal(has(w, 'CLAUDE.md'), false);
    const v = await world();
    fs.symlinkSync(path.join(v.base, 'no-such-file'), path.join(v.dir, 'AGENTS.md'));
    await refused(v, 'ESYMLINK', null, 'AGENTS.md dangling');
    assert.equal(fs.existsSync(path.join(v.base, 'no-such-file')), false, 'a dangling link is not created through');
    const u = await world();
    put(u, 'AGENTS.md', '# same\n');
    const body = await prev(u);
    const e = outside(u);
    fs.writeFileSync(path.join(e, 'copy.md'), '# same\n');
    fs.rmSync(path.join(u.dir, 'AGENTS.md'));
    fs.symlinkSync(path.join(e, 'copy.md'), path.join(u.dir, 'AGENTS.md'));
    const r = await go(u, body);
    assert.deepEqual([r.status, r.body.error, r.body.code], [409, 'refused', 'ESYMLINK']);
    assert.equal(fs.readFileSync(path.join(e, 'copy.md'), 'utf8'), '# same\n');
    assert.equal(has(u, 'rules'), false);
  });

  test('(−) a hard-linked target file', async () => {
    for (const rel of ['CLAUDE.md', 'rules/orchestration.md', '.claude/settings.local.json']) {
      const w = await world({ plugins: ['alpha@demo-market'] });
      const d = outside(w);
      fs.mkdirSync(path.dirname(path.join(w.dir, rel)), { recursive: true });
      fs.linkSync(path.join(d, 'secret.txt'), path.join(w.dir, rel));
      await refused(w, 'ENLINK', d, rel);
      assert.equal(fs.readFileSync(path.join(d, 'secret.txt'), 'utf8'), 'SECRET');
    }
  });

  test('(−) a FIFO or a directory in place of a target, and a file in place of a folder', async () => {
    const w = await world();
    execFileSync('mkfifo', [path.join(w.dir, 'CLAUDE.md')]);
    await refused(w, 'ENOTREG', null, 'fifo');
    const v = await world();
    fs.mkdirSync(path.join(v.dir, 'CLAUDE.md'));
    await refused(v, 'ENOTREG', null, 'directory');
    const u = await world();
    put(u, 'rules', 'a file where the folder should be');
    await refused(u, 'ENOTDIR', null, 'rules is a file');
  });

  test('(−) a symlink planted after the preview is refused by apply (the hash alone would not catch an identical copy)', async () => {
    const w = await world();
    put(w, 'CLAUDE.md', '# same\n');
    const body = await prev(w);
    const d = outside(w);
    fs.writeFileSync(path.join(d, 'copy.md'), '# same\n');
    fs.rmSync(path.join(w.dir, 'CLAUDE.md'));
    fs.symlinkSync(path.join(d, 'copy.md'), path.join(w.dir, 'CLAUDE.md'));
    const r = await go(w, body);
    assert.deepEqual([r.status, r.body.error, r.body.code], [409, 'refused', 'ESYMLINK']);
    assert.equal(fs.readFileSync(path.join(d, 'copy.md'), 'utf8'), '# same\n');
    assert.equal(has(w, 'rules'), false);
  });
});

describe('post-write check (F6) is wired into every project write', () => {
  test('(+) each writeAtomic call in src/rules.js passes the project root, so a directory swapped for a symlink is caught after the rename', () => {
    const src = fs.readFileSync(new URL('../src/rules.js', import.meta.url), 'utf8');
    const calls = src.match(/writeAtomic\(c\.dir[^\n]*/g) ?? [];
    assert.ok(calls.length >= 1);
    for (const c of calls) assert.match(c, /root: dir/, c);
  });

  test('(+) a normal apply passes the check: files land where planned, nothing is unlinked', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    const r = await go(w, await prev(w));
    assert.deepEqual(r.body.written, ['rules/orchestration.md', 'CLAUDE.md', '.claude/settings.local.json']);
    for (const f of r.body.written) assert.equal(has(w, f), true, f);
  });
});

describe('local template', () => {
  async function withTemplate(w, name, text) {
    const dir = path.join(configDir(w.env), 'templates');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (text !== undefined) fs.writeFileSync(path.join(dir, name), text);
    const { config } = await loadConfig(w.env);
    config.rules.localTemplate = name;
    await saveConfig(config, w.env);
    return dir;
  }

  test('(+) rules.localTemplate replaces the built-in template; the marker and placeholders still apply', async () => {
    const w = await world();
    await withTemplate(w, 'mine.md', '# Mine\nOrchestrator: {{models.orchestrator}}\nMax: {{limits.maxAgents}}\n');
    await go(w, await prev(w));
    const text = get(w, 'rules/orchestration.md');
    const body = '# Mine\nOrchestrator: claude-fable-5-1\nMax: 3\n';
    assert.equal(text, rulesMarker(body));
    assert.equal((await rulesState(w.project)).state, 'nika');
    const { config } = await loadConfig(w.env);
    config.rules.localTemplate = null;
    await saveConfig(config, w.env);
    const back = await prev(w);
    assert.equal(entry(back, 'rules/orchestration.md').action, 'update');
    assert.equal(entry(back, 'rules/orchestration.md').foreign, false);
  });

  test('(+) a local template without a final newline gets one', async () => {
    const w = await world();
    await withTemplate(w, 'nonl.md', 'only line');
    await go(w, await prev(w));
    assert.equal(get(w, 'rules/orchestration.md'), rulesMarker('only line\n'));
  });

  test('(−) unknown placeholders, stray braces and unresolved objects are 400 invalid', async () => {
    for (const t of ['x {{nope}}\n', 'x {{models}}\n', '{{ broken\n', 'x {{models.orchestrator.deep}}\n']) {
      const w = await world();
      await withTemplate(w, 'bad.md', t);
      const r = await preview(w.project, w.ctx);
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], t);
      assert.match(r.body.message, /^template: /);
      assert.deepEqual(fs.readdirSync(w.dir), []);
    }
  });

  test('(−) a missing, oversized, symlinked or non-UTF-8 template, or a symlinked templates folder, is refused', async () => {
    const w = await world();
    await withTemplate(w, 'missing.md');
    const miss = await preview(w.project, w.ctx);
    assert.deepEqual([miss.status, miss.body.error, miss.body.code], [409, 'refused', 'ENOENT']);

    const big = await world();
    await withTemplate(big, 'big.md', 'x'.repeat(256 * 1024 + 1));
    assert.equal((await preview(big.project, big.ctx)).body.code, 'EFBIG');

    const sym = await world();
    const dir = await withTemplate(sym, 'link.md');
    fs.writeFileSync(path.join(sym.base, 'elsewhere.md'), '# x\n');
    fs.symlinkSync(path.join(sym.base, 'elsewhere.md'), path.join(dir, 'link.md'));
    assert.equal((await preview(sym.project, sym.ctx)).body.code, 'ESYMLINK');

    const bin = await world();
    const bdir = await withTemplate(bin, 'bin.md');
    fs.writeFileSync(path.join(bdir, 'bin.md'), Buffer.from([0xff, 0xfe, 0x0a]));
    assert.equal((await preview(bin.project, bin.ctx)).status, 400);

    const dirLink = await world();
    const real = path.join(dirLink.base, 'real-templates');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'a.md'), '# a\n');
    fs.mkdirSync(configDir(dirLink.env), { recursive: true });
    fs.symlinkSync(real, path.join(configDir(dirLink.env), 'templates'));
    const { config } = await loadConfig(dirLink.env);
    config.rules.localTemplate = 'a.md';
    await saveConfig(config, dirLink.env);
    assert.deepEqual((await preview(dirLink.project, dirLink.ctx)).body.code, 'ENOENT');
    for (const x of [w, big, sym, bin, dirLink]) assert.deepEqual(fs.readdirSync(x.dir), []);
  });
});
