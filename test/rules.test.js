// Apply orchestration rules (ADR 0006; T5 settings merge, T8 symlinks and hard links); temp dirs and synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { render, rulesState, preview, apply, TEMPLATE_VERSION } from '../src/rules.js';
import { addProject, loadConfig, saveConfig, updateSettings } from '../src/store.js';
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
  config.plugins.perProject[w.project.key] = list;
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
    assert.match(rules.diff, /^--- a\/rules\/orchestration\.md\n\+\+\+ b\/rules\/orchestration\.md\n@@ -0,0 \+1,\d+ @@\n\+<!-- nika:orchestration v1 sha256:[0-9a-f]{64} -->\n/);
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

  test('(+) a file without enabledPlugins gets one at the end; an empty selection removes every true entry, keeps false ones', async () => {
    const w = await world({ plugins: ['alpha@demo-market'] });
    put(w, '.claude/settings.local.json', '{"model":"opus","env":{"A":"1"}}');
    await go(w, await prev(w));
    assert.deepEqual(JSON.parse(get(w, '.claude/settings.local.json')), { model: 'opus', env: { A: '1' }, enabledPlugins: { 'alpha@demo-market': true } });
    assert.deepEqual(Object.keys(JSON.parse(get(w, '.claude/settings.local.json'))), ['model', 'env', 'enabledPlugins']);
    await setPlugins(w, []);
    await go(w, await prev(w));
    assert.deepEqual(JSON.parse(get(w, '.claude/settings.local.json')), { model: 'opus', env: { A: '1' }, enabledPlugins: {} });
    const v = await world({ plugins: [] });
    put(v, '.claude/settings.local.json', '{"enabledPlugins":{"a@b-c":true,"d@b-c":false}}');
    await go(v, await prev(v));
    assert.deepEqual(JSON.parse(get(v, '.claude/settings.local.json')), { enabledPlugins: { 'd@b-c': false } });
  });

  test('(+) nothing to change keeps the file byte for byte (formatting included); no file and no plugins stays absent', async () => {
    const w = await world({ plugins: ['keep@demo-market'] });
    const odd = '{\n\t"model": "x",   "enabledPlugins": {"keep@demo-market":true}\n}';
    put(w, '.claude/settings.local.json', odd);
    const body = await prev(w);
    assert.equal(entry(body, '.claude/settings.local.json').action, 'unchanged');
    await go(w, body);
    assert.equal(get(w, '.claude/settings.local.json'), odd);
    const v = await world({ plugins: [] });
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
