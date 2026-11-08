import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCommands, parseFrontmatter } from '../src/collect/commands.js';
import { BUILTIN_COMMANDS } from '../src/commands-builtin.js';

// Synthetic fixtures only (rules/project-rules.md section 7).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-commands-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh fake machine: claude config dir and project dir. */
function machine() {
  const base = path.join(root, `m${n += 1}`);
  return { base, claudeDir: path.join(base, 'claude'), projectDir: path.join(base, 'project') };
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A markdown file with a frontmatter block built from `fields`. */
function doc(fields, body = 'Body text.') {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${body}\n`;
}

const command = (dir, name, fields = {}) => write(path.join(dir, 'commands', `${name}.md`), doc(fields));
const skill = (dir, folder, fields = {}) => write(path.join(dir, 'skills', folder, 'SKILL.md'), doc(fields));

/** Registers plugins as `{ key: installPathOrRecords }` in installed_plugins.json. */
function registerPlugins(claudeDir, plugins) {
  const out = {};
  for (const [key, v] of Object.entries(plugins)) out[key] = Array.isArray(v) ? v : [{ scope: 'user', installPath: v, version: '1.0.0' }];
  write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: out }));
}

const cacheDir = (claudeDir, ...p) => path.join(claudeDir, 'plugins', 'cache', ...p);

let clock = 0;
/** Each call gets its own `now`, 1 minute apart, so the 10 s cache never serves another test's result. */
const list = (m, { project = false, now = (clock += 60_000) } = {}) =>
  listCommands({ claudeDir: m.claudeDir, projectDir: project ? m.projectDir : undefined, now });

const nonBuiltin = (entries) => entries.filter((e) => e.source !== 'builtin');
const names = (entries) => entries.map((e) => e.name);

describe('parseFrontmatter', () => {
  test('(+) reads key: value scalars between the leading --- and the next ---, quotes stripped', () => {
    const text = '---\nname: demo\ndescription: "Say \'hi\' to: everyone"\nargument-hint: \'[who]\'\nempty:\nuser-invocable: false\n---\nname: not-this\n';
    assert.deepEqual(parseFrontmatter(text), {
      name: 'demo', description: 'Say \'hi\' to: everyone', 'argument-hint': '[who]', empty: '', 'user-invocable': 'false',
    });
  });

  test('(+) CRLF line endings work', () => {
    assert.deepEqual(parseFrontmatter('---\r\nname: demo\r\ndescription: text\r\n---\r\nbody\r\n'), { name: 'demo', description: 'text' });
  });

  test('(+) a description written as a folded or literal block joins its indented lines with one space', () => {
    for (const header of ['>', '>-', '|', '|-']) {
      const text = `---\ndescription: ${header}\n  first line\n\n    second  line\n\tthird\nname: demo\n---\nbody\n`;
      assert.deepEqual(parseFrontmatter(text), { description: 'first line second  line third', name: 'demo' }, header);
    }
    assert.deepEqual(parseFrontmatter('---\nname: demo\ndescription: |\n  last one\n---\n'), { name: 'demo', description: 'last one' });
  });

  test('(−) a block header on any other key gives an empty value, and its lines are ignored', () => {
    assert.deepEqual(parseFrontmatter('---\nargument-hint: >\n  [text]\nname: |-\n  other\ndescription: ok\n---\n'), { 'argument-hint': '', name: '', description: 'ok' });
  });

  test('(−) no leading --- gives {}', () => {
    for (const text of ['', 'name: demo\n', '\n---\nname: demo\n---\n', ' ---\nname: demo\n---\n', '# Title\n---\nname: demo\n---\n', '--- x\nname: demo\n---\n']) {
      assert.deepEqual(parseFrontmatter(text), {}, JSON.stringify(text));
    }
  });

  test('(−) a frontmatter block that is never closed gives null (the caller skips the file)', () => {
    assert.equal(parseFrontmatter('---\nname: demo\ndescription: text\n'), null);
    assert.equal(parseFrontmatter('---\n'), null);
    assert.equal(parseFrontmatter('---'), null);
  });

  test('(−) indented lines, list items, comments and lines without a key are ignored', () => {
    const text = '---\nname: demo\n  nested: x\n- item\n# comment\njust words\nkey:value\n1bad: x\n---\n';
    assert.deepEqual(parseFrontmatter(text), { name: 'demo' });
  });

  test('(−) a __proto__ key becomes an own property and pollutes nothing', () => {
    const fm = parseFrontmatter('---\n__proto__: polluted\nname: demo\n---\n');
    assert.equal({}.polluted, undefined);
    assert.equal(Object.getPrototypeOf(fm), Object.prototype);
    assert.equal(fm.name, 'demo');
  });

  test('(−) non-string input gives {}', () => {
    for (const v of [undefined, null, 42, {}, []]) assert.deepEqual(parseFrontmatter(v), {});
  });
});

describe('listCommands', () => {
  test('(+) user, project and plugin commands and skills are listed with their source', async () => {
    const m = machine();
    command(m.claudeDir, 'ship', { description: 'Ship it', 'argument-hint': '[branch]' });
    skill(m.claudeDir, 'tidy', { description: 'Tidy up' });
    command(path.join(m.projectDir, '.claude'), 'lint', { description: 'Lint the project' });
    skill(path.join(m.projectDir, '.claude'), 'review', { name: 'review-pr', description: 'Review a PR' });
    const install = cacheDir(m.claudeDir, 'market-one', 'demo', '1.0.0');
    command(install, 'fmt', { description: 'Format files' });
    skill(install, 'audit', { description: 'Audit things' });
    registerPlugins(m.claudeDir, { 'demo@market-one': install });

    const got = nonBuiltin(await list(m, { project: true }));
    assert.deepEqual(got, [
      { name: 'tidy', description: 'Tidy up', argHint: '', source: 'user' },
      { name: 'ship', description: 'Ship it', argHint: '[branch]', source: 'user' },
      { name: 'review-pr', description: 'Review a PR', argHint: '', source: 'project' },
      { name: 'lint', description: 'Lint the project', argHint: '', source: 'project' },
      { name: 'demo:audit', description: 'Audit things', argHint: '', source: 'plugin', plugin: 'demo' },
      { name: 'demo:fmt', description: 'Format files', argHint: '', source: 'plugin', plugin: 'demo' },
    ]);
  });

  test('(+) without projectDir the project entries are left out; user and plugin entries stay', async () => {
    const m = machine();
    command(m.claudeDir, 'mine');
    command(path.join(m.projectDir, '.claude'), 'theirs');
    const install = cacheDir(m.claudeDir, 'market-one', 'demo', '1.0.0');
    command(install, 'fmt');
    registerPlugins(m.claudeDir, { 'demo@market-one': install });
    assert.deepEqual(names(nonBuiltin(await list(m))), ['mine', 'demo:fmt']);
    assert.deepEqual(names(nonBuiltin(await list(m, { project: true }))), ['mine', 'theirs', 'demo:fmt']);
  });

  test('(+) the skill folder name is the name when frontmatter has none; frontmatter name wins otherwise', async () => {
    const m = machine();
    skill(m.claudeDir, 'folder-name', { description: 'a' });
    skill(m.claudeDir, 'other-folder', { name: 'from-frontmatter', description: 'b' });
    write(path.join(m.claudeDir, 'skills', 'no-frontmatter', 'SKILL.md'), '# Just a body\n');
    assert.deepEqual(names(nonBuiltin(await list(m))).sort(), ['folder-name', 'from-frontmatter', 'no-frontmatter']);
  });

  test('(+) skill wins over a command with the same name in one source; other sources keep their entry', async () => {
    const m = machine();
    command(m.claudeDir, 'deploy', { description: 'user command' });
    skill(m.claudeDir, 'deploy', { description: 'user skill' });
    command(path.join(m.projectDir, '.claude'), 'deploy', { description: 'project command' });
    const got = nonBuiltin(await list(m, { project: true }));
    assert.deepEqual(got.map((e) => [e.source, e.description]), [['user', 'user skill'], ['project', 'project command']]);
  });

  test('(+) user-invocable: false hides a skill and a command', async () => {
    const m = machine();
    skill(m.claudeDir, 'hidden-skill', { 'user-invocable': 'false' });
    command(m.claudeDir, 'hidden-command', { 'user-invocable': '"false"' });
    skill(m.claudeDir, 'shown-skill', { 'user-invocable': 'true' });
    command(m.claudeDir, 'shown-command');
    assert.deepEqual(names(nonBuiltin(await list(m))).sort(), ['shown-command', 'shown-skill']);
  });

  test('(+) builtins come first and carry dialog flags', async () => {
    const m = machine();
    command(m.claudeDir, 'compact', { description: 'user compact' });
    const got = await list(m);
    const head = got.slice(0, BUILTIN_COMMANDS.length);
    assert.ok(head.every((e) => e.source === 'builtin'));
    assert.deepEqual(names(head), BUILTIN_COMMANDS.map((c) => c.name));
    assert.equal(got.slice(BUILTIN_COMMANDS.length).some((e) => e.source === 'builtin'), false);
    const by = Object.fromEntries(head.map((e) => [e.name, e]));
    assert.deepEqual(by.config, { name: 'config', description: by.config.description, argHint: '[key=value]', source: 'builtin', dialog: true });
    assert.equal('dialog' in by.compact, false);
    assert.equal(by.compact.argHint, '[instructions]');
    assert.equal(by.diff.argHint, '');
    assert.ok(head.every((e) => typeof e.description === 'string' && e.description.length > 0));
    // a user command may share a built-in's name: both are kept, each with its source
    assert.deepEqual(got.filter((e) => e.name === 'compact').map((e) => e.source), ['builtin', 'user']);
  });

  test('(+) BUILTIN_COMMANDS follows claude-tui.md section 4: aliases, args and dialog column', () => {
    const by = Object.fromEntries(BUILTIN_COMMANDS.map((c) => [c.name, c]));
    assert.equal(BUILTIN_COMMANDS.length, 62);
    assert.deepEqual(by.exit.aliases, ['quit']);
    assert.deepEqual(by.clear.aliases, ['reset', 'new']);
    assert.equal(by.advisor.argHint, '[model|off]');
    assert.equal(by.model.dialog, true);
    assert.equal(by.hooks.dialog, undefined);
    assert.equal(BUILTIN_COMMANDS.filter((c) => c.dialog).length, 19);
    assert.equal(new Set(BUILTIN_COMMANDS.map((c) => c.name)).size, BUILTIN_COMMANDS.length);
  });

  test('(+) a plugin uses the first install record whose installPath resolves inside the cache', async () => {
    const m = machine();
    const outside = path.join(m.base, 'elsewhere', 'demo');
    command(outside, 'stolen');
    const inside = cacheDir(m.claudeDir, 'market-one', 'demo', '2.0.0');
    command(inside, 'fmt');
    registerPlugins(m.claudeDir, {
      'demo@market-one': [
        { scope: 'user', installPath: 42 },
        { scope: 'user', installPath: outside },
        { scope: 'user', installPath: inside },
        { scope: 'user', installPath: cacheDir(m.claudeDir, 'market-one', 'demo', 'later') },
      ],
    });
    assert.deepEqual(names(nonBuiltin(await list(m))), ['demo:fmt']);
  });

  test('(−) an installPath outside plugins/cache is ignored', async () => {
    const m = machine();
    const outside = path.join(m.base, 'elsewhere');
    command(outside, 'a');
    const sibling = path.join(m.claudeDir, 'plugins', 'cache-evil', 'x');
    command(sibling, 'b');
    const viaLink = path.join(m.base, 'link-source');
    command(viaLink, 'c');
    fs.mkdirSync(cacheDir(m.claudeDir, 'market-one'), { recursive: true });
    fs.symlinkSync(viaLink, cacheDir(m.claudeDir, 'market-one', 'linked'));
    command(cacheDir(m.claudeDir, 'market-one', 'relative'), 'd');
    command(cacheDir(m.claudeDir), 'e'); // the cache root itself is not a plugin folder
    registerPlugins(m.claudeDir, {
      'outside@market-one': outside,
      'sibling@market-one': sibling,
      'linked@market-one': cacheDir(m.claudeDir, 'market-one', 'linked'),
      'dotdot@market-one': `${cacheDir(m.claudeDir, 'market-one')}/../../../../elsewhere`,
      'relative@market-one': path.join('plugins', 'cache', 'market-one', 'relative'),
      'root@market-one': cacheDir(m.claudeDir),
      'missing@market-one': cacheDir(m.claudeDir, 'market-one', 'nope'),
    });
    assert.deepEqual(nonBuiltin(await list(m)), []);
  });

  test('(−) a missing cache dir, bad installed_plugins.json and missing dirs give builtins only', async () => {
    const m = machine();
    assert.deepEqual(names(await list(m, { project: true })), BUILTIN_COMMANDS.map((c) => c.name));
    write(path.join(m.claudeDir, 'plugins', 'installed_plugins.json'), '{not json');
    assert.deepEqual(names(await list(m, { project: true })), BUILTIN_COMMANDS.map((c) => c.name));
    registerPlugins(m.claudeDir, { 'demo@market-one': path.join(m.claudeDir, 'plugins', 'cache', 'x') });
    assert.deepEqual(nonBuiltin(await list(m, { project: true })), []);
  });

  test('(−) a symlinked SKILL.md and a symlinked command file are skipped', async () => {
    const m = machine();
    const target = path.join(m.base, 'target.md');
    write(target, doc({ description: 'via link' }));
    skill(m.claudeDir, 'real', { description: 'regular' });
    fs.mkdirSync(path.join(m.claudeDir, 'skills', 'linked'), { recursive: true });
    fs.symlinkSync(target, path.join(m.claudeDir, 'skills', 'linked', 'SKILL.md'));
    command(m.claudeDir, 'plain');
    fs.symlinkSync(target, path.join(m.claudeDir, 'commands', 'linked.md'));
    assert.deepEqual(names(nonBuiltin(await list(m))).sort(), ['plain', 'real']);
  });

  test('(+) a symlinked skill folder is followed; the SKILL.md inside must still be regular', async () => {
    const m = machine();
    skill(path.join(m.base, 'dotfiles'), 'shared', { description: 'linked folder' });
    const trap = path.join(m.base, 'dotfiles', 'skills', 'trap');
    fs.mkdirSync(trap, { recursive: true });
    fs.symlinkSync(path.join(m.base, 'dotfiles', 'skills', 'shared', 'SKILL.md'), path.join(trap, 'SKILL.md'));
    fs.mkdirSync(path.join(m.claudeDir, 'skills'), { recursive: true });
    fs.symlinkSync(path.join(m.base, 'dotfiles', 'skills', 'shared'), path.join(m.claudeDir, 'skills', 'shared'));
    fs.symlinkSync(trap, path.join(m.claudeDir, 'skills', 'trap'));
    assert.deepEqual(nonBuiltin(await list(m)), [{ name: 'shared', description: 'linked folder', argHint: '', source: 'user' }]);
  });

  test('(−) only top-level .md command files are listed: subfolders, other extensions and directories named .md are skipped', async () => {
    const m = machine();
    command(m.claudeDir, 'top');
    write(path.join(m.claudeDir, 'commands', 'frontend', 'component.md'), doc({}));
    write(path.join(m.claudeDir, 'commands', 'notes.txt'), doc({}));
    write(path.join(m.claudeDir, 'commands', 'readme'), doc({}));
    fs.mkdirSync(path.join(m.claudeDir, 'commands', 'dir.md'));
    write(path.join(m.claudeDir, 'skills', 'loose.md'), doc({}));
    fs.mkdirSync(path.join(m.claudeDir, 'skills', 'empty'), { recursive: true });
    assert.deepEqual(names(nonBuiltin(await list(m))), ['top']);
  });

  test('(−) a file larger than 4 KB is read only to 4 KB; frontmatter past it is ignored', async () => {
    const m = machine();
    // closes inside the head: the body past 4 KB is never needed
    write(path.join(m.claudeDir, 'commands', 'closed.md'), `${doc({ description: 'early text' }, 'x'.repeat(10_000))}`);
    // the closing --- lies past 4 KB, so a hide flag may sit in the part that was not read: the file is skipped
    write(path.join(m.claudeDir, 'commands', 'open.md'), `---\ndescription: early text\nfiller: ${'y'.repeat(5000)}\nuser-invocable: false\n---\nbody\n`);
    write(path.join(m.claudeDir, 'skills', 'open-skill', 'SKILL.md'), `---\nname: open-skill\nfiller: ${'y'.repeat(5000)}\n---\nbody\n`);
    // an opening --- that never closes, however short the file
    write(path.join(m.claudeDir, 'commands', 'unclosed.md'), '---\ndescription: text\n');
    // no frontmatter at all: listed with an empty description
    write(path.join(m.claudeDir, 'commands', 'plain.md'), '# Just a body\n');
    const got = Object.fromEntries(nonBuiltin(await list(m)).map((e) => [e.name, e.description]));
    assert.deepEqual(got, { closed: 'early text', plain: '' });
  });

  test('(−) a name with spaces, <, or a leading dash or dot is skipped; 100 chars fit, 101 do not', async () => {
    const m = machine();
    const bad = ['bad name', 'a<b', '-dash', '.dot', 'caf\u00e9'];
    bad.forEach((name, i) => {
      write(path.join(m.claudeDir, 'commands', `${name}.md`), doc({}));
      skill(m.claudeDir, `folder-${i}`, { name });
    });
    skill(m.claudeDir, 'slashed', { name: 'a/b' });
    skill(m.claudeDir, 'a folder with spaces');
    command(m.claudeDir, 'a'.repeat(100));
    command(m.claudeDir, 'a'.repeat(101));
    command(m.claudeDir, 'ok.v2_x:y');
    skill(m.claudeDir, 'fine');
    assert.deepEqual(names(nonBuiltin(await list(m))).sort(), ['a'.repeat(100), 'fine', 'ok.v2_x:y']);
  });

  test('(−) markup in description stays plain text; controls and bidi marks become spaces', async () => {
    const m = machine();
    const markup = '<img src=x onerror=alert(1)> &amp; <script>x</script>';
    command(m.claudeDir, 'markup', { description: markup, 'argument-hint': '<b>[arg]</b>' });
    command(m.claudeDir, 'escapes', { description: 'x\u001b[2J\u202ey\u200bz' });
    command(m.claudeDir, 'long', { description: 'w'.repeat(300) });
    const by = Object.fromEntries(nonBuiltin(await list(m)).map((e) => [e.name, e]));
    assert.equal(by.markup.description, markup);
    assert.equal(by.markup.argHint, '<b>[arg]</b>');
    assert.equal(by.escapes.description, 'x [2J y z');
    assert.equal(by.long.description.length, 200);
  });

  test('(+) a block-scalar description is listed as one line, cut at 200 chars', async () => {
    const m = machine();
    write(path.join(m.claudeDir, 'commands', 'folded.md'), '---\ndescription: >-\n  Review the\n  open changes\nargument-hint: [target]\n---\nbody\n');
    write(path.join(m.claudeDir, 'skills', 'literal', 'SKILL.md'), `---\nname: literal\ndescription: |\n  ${'word '.repeat(80)}\n---\nbody\n`);
    const by = Object.fromEntries(nonBuiltin(await list(m)).map((e) => [e.name, e]));
    assert.equal(by.folded.description, 'Review the open changes');
    assert.equal(by.folded.argHint, '[target]');
    assert.equal(by.literal.description.length, 200);
    assert.ok(by.literal.description.startsWith('word word word'));
  });

  test('(+) a hidden skill does not shadow a command of the same name', async () => {
    const m = machine();
    skill(m.claudeDir, 'deploy', { 'user-invocable': 'false' });
    command(m.claudeDir, 'deploy', { description: 'the command' });
    assert.deepEqual(nonBuiltin(await list(m)).map((e) => [e.name, e.description]), [['deploy', 'the command']]);
  });

  test('(−) the 1001st entry is dropped; built-ins count and come first', async () => {
    const m = machine();
    const pad = (i) => String(i).padStart(3, '0');
    for (let i = 0; i < 200; i += 1) {
      command(m.claudeDir, `u${pad(i)}`);
      command(path.join(m.projectDir, '.claude'), `p${pad(i)}`);
    }
    const keys = {};
    for (const p of ['a', 'b', 'c', 'd']) {
      const install = cacheDir(m.claudeDir, 'market-one', p, '1.0.0');
      for (let i = 0; i < 200; i += 1) command(install, `c${pad(i)}`);
      keys[`${p}@market-one`] = install;
    }
    registerPlugins(m.claudeDir, keys);
    const got = await list(m, { project: true });
    assert.equal(got.length, 1000);
    assert.equal(got[0].source, 'builtin');
    assert.ok(got.some((e) => e.name === 'u199') && got.some((e) => e.name === 'p199'));
    assert.equal(got.some((e) => e.name === 'd:c199'), false);
  });

  test('(−) at most 200 files are read per folder', async () => {
    const m = machine();
    for (let i = 0; i < 250; i += 1) command(m.claudeDir, `c${String(i).padStart(3, '0')}`);
    for (let i = 0; i < 250; i += 1) skill(m.claudeDir, `s${String(i).padStart(3, '0')}`);
    const got = nonBuiltin(await list(m));
    assert.equal(got.length, 400);
    assert.ok(got.some((e) => e.name === 'c199'));
    assert.equal(got.some((e) => e.name === 'c200'), false);
    assert.equal(got.some((e) => e.name === 's200'), false);
  });

  test('(+) results are cached for 10 s per project', async () => {
    const m = machine();
    command(m.claudeDir, 'first');
    const first = await list(m, { now: 1_000_000 });
    command(m.claudeDir, 'second');
    assert.deepEqual(names(nonBuiltin(await list(m, { now: 1_009_999 }))), ['first']);
    assert.deepEqual(names(nonBuiltin(await list(m, { now: 1_010_000 }))), ['first', 'second']);
    assert.deepEqual(names(nonBuiltin(first)), ['first']);
  });

  test('(+) the cache is separate for each project', async () => {
    const m = machine();
    command(path.join(m.projectDir, '.claude'), 'only-here');
    assert.deepEqual(names(nonBuiltin(await list(m, { project: true, now: 5_000_000 }))), ['only-here']);
    assert.deepEqual(names(nonBuiltin(await list(m, { project: false, now: 5_000_001 }))), []);
  });

  test('(−) entries never carry paths or extra keys', async () => {
    const m = machine();
    command(m.claudeDir, 'ship', { description: 'd' });
    const install = cacheDir(m.claudeDir, 'market-one', 'demo', '1.0.0');
    command(install, 'fmt');
    registerPlugins(m.claudeDir, { 'demo@market-one': install });
    const allowed = new Set(['name', 'description', 'argHint', 'source', 'plugin', 'dialog']);
    for (const e of await list(m)) {
      for (const k of Object.keys(e)) assert.ok(allowed.has(k), k);
      assert.ok(!JSON.stringify(e).includes(m.base));
    }
  });

  test('(+) the user source follows symlinked commands/ and skills/ folders (dotfile managers link them)', async () => {
    const m = machine();
    const dotfiles = path.join(m.base, 'dotfiles');
    command(dotfiles, 'linked-command');
    skill(dotfiles, 'linked-skill');
    fs.mkdirSync(m.claudeDir, { recursive: true });
    fs.symlinkSync(path.join(dotfiles, 'commands'), path.join(m.claudeDir, 'commands'));
    fs.symlinkSync(path.join(dotfiles, 'skills'), path.join(m.claudeDir, 'skills'));
    assert.deepEqual(names(nonBuiltin(await list(m))).sort(), ['linked-command', 'linked-skill']);
  });

  test('(−) a plugin install whose commands/ or skills/ is a symlink out of the cache is not read', async () => {
    const m = machine();
    const outside = path.join(m.base, 'outside');
    command(outside, 'sneak');
    skill(outside, 'sneaky');
    const linked = cacheDir(m.claudeDir, 'market-one', 'linked', '1.0.0');
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(path.join(outside, 'commands'), path.join(linked, 'commands'));
    fs.symlinkSync(path.join(outside, 'skills'), path.join(linked, 'skills'));
    registerPlugins(m.claudeDir, { 'linked@market-one': linked });
    assert.deepEqual(nonBuiltin(await list(m)), []);
  });

  test('(−) a plugin skill folder that links out of the cache is skipped; one that links inside the cache is followed', async () => {
    const m = machine();
    const outside = path.join(m.base, 'outside', 'skills', 'escaped');
    write(path.join(outside, 'SKILL.md'), doc({ description: 'outside' }));
    const shared = cacheDir(m.claudeDir, 'market-one', 'shared-skill');
    write(path.join(shared, 'SKILL.md'), doc({ description: 'inside' }));
    const install = cacheDir(m.claudeDir, 'market-one', 'demo', '1.0.0');
    skill(install, 'real', { description: 'regular' });
    fs.symlinkSync(outside, path.join(install, 'skills', 'escaped'));
    fs.symlinkSync(shared, path.join(install, 'skills', 'shared'));
    registerPlugins(m.claudeDir, { 'demo@market-one': install });
    assert.deepEqual(nonBuiltin(await list(m)).map((e) => [e.name, e.description]), [['demo:real', 'regular'], ['demo:shared', 'inside']]);
  });

  test('(−) a project whose .claude/commands or .claude/skills is a symlink is not read, even when it points inside the project', async () => {
    const a = machine();
    write(path.join(a.projectDir, 'shared-commands', 'x.md'), doc({}));
    fs.mkdirSync(path.join(a.projectDir, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(a.projectDir, 'shared-commands'), path.join(a.projectDir, '.claude', 'commands'));
    skill(path.join(a.projectDir, '.claude'), 'ok');
    assert.deepEqual(names(nonBuiltin(await list(a, { project: true }))), ['ok']);

    const b = machine();
    write(path.join(b.projectDir, 'shared-skills', 'y', 'SKILL.md'), doc({}));
    fs.mkdirSync(path.join(b.projectDir, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(b.projectDir, 'shared-skills'), path.join(b.projectDir, '.claude', 'skills'));
    command(path.join(b.projectDir, '.claude'), 'ok');
    assert.deepEqual(names(nonBuiltin(await list(b, { project: true }))), ['ok']);
  });

  test('(−) a project whose .claude folder links outside the project is not read', async () => {
    const m = machine();
    const outside = path.join(m.base, 'elsewhere');
    command(outside, 'sneak');
    skill(outside, 'sneaky');
    fs.mkdirSync(m.projectDir, { recursive: true });
    fs.symlinkSync(outside, path.join(m.projectDir, '.claude'));
    assert.deepEqual(nonBuiltin(await list(m, { project: true })), []);
  });

  test('(−) a project skill folder that links outside the project is skipped; one that links inside is followed', async () => {
    const m = machine();
    write(path.join(m.base, 'elsewhere', 'SKILL.md'), doc({ description: 'outside' }));
    write(path.join(m.projectDir, 'tools', 'inner', 'SKILL.md'), doc({ description: 'inside' }));
    skill(path.join(m.projectDir, '.claude'), 'real', { description: 'regular' });
    const skills = path.join(m.projectDir, '.claude', 'skills');
    fs.symlinkSync(path.join(m.base, 'elsewhere'), path.join(skills, 'escaped'));
    fs.symlinkSync(path.join(m.projectDir, 'tools', 'inner'), path.join(skills, 'inner'));
    assert.deepEqual(nonBuiltin(await list(m, { project: true })).map((e) => [e.name, e.description]), [['inner', 'inside'], ['real', 'regular']]);
  });

  test('(−) at most 2000 files are opened per scan; what was found before is returned', async () => {
    const m = machine();
    const hidden = { 'user-invocable': 'false' };
    const pad = (i) => String(i).padStart(3, '0');
    const fill = (dir, mark) => {
      for (let i = 0; i < 200; i += 1) skill(dir, `hs${pad(i)}`, hidden);
      for (let i = 0; i < 199; i += 1) command(dir, `h${pad(i)}`, hidden);
      command(dir, mark); // the 200th command file
    };
    fill(m.claudeDir, 'user-mark'); // two folders with 200 files each: 400 opens
    fill(path.join(m.projectDir, '.claude'), 'project-mark'); // 800
    const keys = {};
    for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      const install = cacheDir(m.claudeDir, 'market-one', p, '1.0.0');
      for (let i = 0; i < 199; i += 1) command(install, `h${pad(i)}`, hidden);
      command(install, 'seen'); // 200 files in the folder: 1000, 1200, ... 2000 after f
      keys[`${p}@market-one`] = install;
    }
    registerPlugins(m.claudeDir, keys);
    const got = nonBuiltin(await list(m, { project: true }));
    assert.deepEqual(names(got), ['user-mark', 'project-mark', 'a:seen', 'b:seen', 'c:seen', 'd:seen', 'e:seen', 'f:seen']);
  });

  test('(+) calls that arrive during a scan share it', async () => {
    const m = machine();
    command(m.claudeDir, 'one');
    const now = (clock += 60_000);
    const [a, b, c] = await Promise.all([list(m, { now }), list(m, { now }), list(m, { now })]);
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal(await list(m, { now: now + 1 }), a); // and the finished scan is the cached one
    assert.notEqual(await list(m, { project: true, now }), a); // another project is another scan
  });

  test('(−) the returned array and its entries are frozen, so a caller cannot change the cached result', async () => {
    const m = machine();
    command(m.claudeDir, 'one');
    const got = await listCommands({ claudeDir: m.claudeDir, now: 9_000_000 });
    assert.ok(Object.isFrozen(got));
    assert.ok(got.every((e) => Object.isFrozen(e)));
    assert.throws(() => got.push({ name: 'x' }), TypeError);
    assert.throws(() => { got[0].name = 'changed'; }, TypeError);
    assert.throws(() => { got.at(-1).description = 'changed'; }, TypeError);
    const again = await listCommands({ claudeDir: m.claudeDir, now: 9_000_001 });
    assert.equal(again, got);
    assert.equal(again[0].name, BUILTIN_COMMANDS[0].name);
  });

  test('(+) same-named plugins from two marketplaces: the first full name wins, other names are kept', async () => {
    const m = machine();
    const one = cacheDir(m.claudeDir, 'market-one', 'dup', '1.0.0');
    const two = cacheDir(m.claudeDir, 'market-two', 'dup', '1.0.0');
    command(one, 'fmt', { description: 'from market one' });
    command(two, 'fmt', { description: 'from market two' });
    command(two, 'extra', { description: 'only in two' });
    registerPlugins(m.claudeDir, { 'dup@market-two': two, 'dup@market-one': one });
    assert.deepEqual(nonBuiltin(await list(m)).map((e) => [e.name, e.description]), [['dup:fmt', 'from market one'], ['dup:extra', 'only in two']]);
  });
});
