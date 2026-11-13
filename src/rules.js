// "Apply orchestration rules to a project" (ADR 0006, contracts §3 and §9, rules T5 and T8): render the template, plan the
// allowed writes, show them as unified diffs, and write them only when the plan's hash still matches. All writes go
// through src/fwrite.js; nothing here runs git. Handlers return { status, body } like the other app-tier modules.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openRegular, isRealDir } from './fsafe.js';
import { ensureDir, writeAtomic, checkComponents, backupFile, pruneBackups } from './fwrite.js';
import { configDir, backupsDir } from './paths.js';
import { loadConfig, keyFor, effectiveModels, effectiveAgents } from './store.js';
import { PROJECT_KEY } from './ids.js';
import { clean } from './text.js';
import { unifiedDiff } from './diff.js';

/** Bump when the built-in template or its placeholder set changes: files written with an older value become `outdated`. */
export const TEMPLATE_VERSION = 2;

const RULES = 'rules/orchestration.md';
const CLAUDE = 'CLAUDE.md';
const AGENTS = 'AGENTS.md';
const SETTINGS = '.claude/settings.local.json';
const GITIGNORE = '.gitignore';
const IMPORT_LINE = '@rules/orchestration.md';
const FILE_MAX = 1024 * 1024;
const BACKUPS_KEEP = 10; // backup folders kept per project
const TEMPLATE_MAX = 256 * 1024;
const BUILTIN = fileURLToPath(new URL('../templates/orchestration.md', import.meta.url));
const MARKER = /^<!-- nika:orchestration v(\d{1,6}) sha256:([0-9a-f]{64}) -->\n/;
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)\s*\}\}/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// shortcut: a line match, not gitignore semantics (no negation, no nested .gitignore files, no global excludes)
const IGNORING_LINES = new Set([
  '.claude/settings.local.json', '/.claude/settings.local.json', '**/.claude/settings.local.json',
  '.claude/', '/.claude/', '.claude', '/.claude', '.claude/*', '.claude/*.local.json',
  '*.local.json', '**/*.local.json', 'settings.local.json', '**/settings.local.json',
]);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A request-level failure; `toResult` turns it into { status, body }. */
function fail(status, error, message, code) {
  return Object.assign(new Error(message), { status, error, ...(code ? { code } : {}) });
}

function toResult(err) {
  if (err.status) return { status: err.status, body: { error: err.error, message: err.message, ...(err.code ? { code: err.code } : {}) } };
  // fwrite / fsafe / OS refusals (ESYMLINK, ENLINK, EMODE, EFBIG, ENOENT, ...): nothing was written
  if (typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) {
    const code = err.code === 'ELOOP' ? 'ESYMLINK' : err.code;
    return { status: 409, body: { error: 'refused', code, message: clean(err.message, 300) ?? code } };
  }
  throw err;
}

// ---------------------------------------------------------------------------------------------------------------- reading

/** Text of a safe regular file (fsafe checks), null when absent. Refuses oversized and non-UTF-8 files: we rewrite what we read. */
async function readText(abs, max) {
  let opened;
  try {
    opened = await openRegular(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') throw Object.assign(new Error(`${abs} is a symlink`), { code: 'ESYMLINK' });
    throw err;
  }
  let buf;
  try {
    const probe = Buffer.alloc(max + 1);
    const { bytesRead } = await opened.handle.read(probe, 0, max + 1, 0);
    buf = probe.subarray(0, bytesRead);
  } finally {
    await opened.handle.close();
  }
  if (buf.length > max) throw Object.assign(new Error(`${path.basename(abs)} is larger than ${max} bytes`), { code: 'EFBIG' });
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw fail(400, 'invalid', `${path.basename(abs)} is not valid UTF-8`);
  return text;
}

/** A file below the project root: every path component checked (T8), then read safely. */
async function readTarget(dir, rel) {
  return readText((await checkComponents(dir, rel)).abs, FILE_MAX);
}

/**
 * AGENTS.md is never followed: `{ link: true }` for a symlink (the plan skips it or refuses, see plan()), else `{ text }`, read
 * like any target (null when absent). A link swapped in after the lstat is still refused by readText's O_NOFOLLOW.
 */
async function readAgents(dir) {
  const { abs } = await checkComponents(dir, AGENTS);
  const st = await fs.lstat(abs).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
  if (st?.isSymbolicLink()) return { link: true };
  return { text: await readText(abs, FILE_MAX) };
}

// -------------------------------------------------------------------------------------------------------------- template

/** Replaces `{{a.b}}` with `values.a.b`. Unknown placeholders, objects and stray `{{` / `}}` throw EPLACEHOLDER. */
export function render(template, values) {
  const bad = (m) => Object.assign(new Error(m), { code: 'EPLACEHOLDER' });
  const out = template.replace(PLACEHOLDER, (_, key) => {
    let v = values;
    for (const part of key.split('.')) {
      if (!isPlain(v) || !Object.prototype.hasOwnProperty.call(v, part)) throw bad(`unknown placeholder {{${key}}}`);
      v = v[part];
    }
    if (typeof v !== 'string' && typeof v !== 'number') throw bad(`placeholder {{${key}}} is not a value`);
    return String(v);
  });
  if (/\{\{|\}\}/.test(out)) throw bad('stray {{ or }} in template');
  return out;
}

function valuesFor(config, project) {
  const rc = config.remoteControl;
  const agents = effectiveAgents(config, project.key); // the project's own values, else Settings'
  return {
    models: effectiveModels(config, project.key),
    panePlacement: agents.panePlacement,
    limits: { maxAgents: agents.maxAgents },
    permissionMode: agents.permissionMode,
    remoteControl: !rc.enabled ? 'off' : `on (name prefix: ${rc.prefix || 'the project name'})`,
    plugins: (config.perProject[project.key]?.plugins ?? []).map((p) => `\`${p}\``).join(', ') || 'none',
  };
}

async function loadTemplate(config, env) {
  const name = config.rules.localTemplate;
  if (name === null) return fs.readFile(BUILTIN, 'utf8'); // shipped with nika like src/, not an agent-writable folder
  const dir = path.join(configDir(env), 'templates');
  if (!(await isRealDir(dir))) throw fail(409, 'refused', `local template ${name} not found`, 'ENOENT');
  const text = await readText(path.join(dir, name), TEMPLATE_MAX);
  if (text === null) throw fail(409, 'refused', `local template ${name} not found`, 'ENOENT');
  return text;
}

/** The file content nika writes: marker line, then the rendered body (marker carries the body's hash). */
async function renderRules(config, project, env) {
  let body;
  try {
    body = render(await loadTemplate(config, env), valuesFor(config, project));
  } catch (err) {
    if (err.code === 'EPLACEHOLDER') throw fail(400, 'invalid', `template: ${err.message}`);
    throw err;
  }
  if (!body.endsWith('\n')) body += '\n';
  return `<!-- nika:orchestration v${TEMPLATE_VERSION} sha256:${sha(body)} -->\n${body}`;
}

/** nika | outdated | foreign, from the marker and the hash of the body that follows it. */
function classify(text) {
  const m = MARKER.exec(text);
  if (!m || sha(text.slice(m[0].length)) !== m[2]) return 'foreign'; // no marker, or edited by hand
  const v = Number(m[1]);
  return v === TEMPLATE_VERSION ? 'nika' : v < TEMPLATE_VERSION ? 'outdated' : 'foreign';
}

// ----------------------------------------------------------------------------------------------------- planned file bodies

/** The import line for CLAUDE.md and AGENTS.md alike; null (no file yet) only ever happens for CLAUDE.md. */
function importWith(current) {
  if (current === null) return `${IMPORT_LINE}\n`;
  if (current.split('\n').some((l) => l.trim() === IMPORT_LINE)) return current;
  let t = current;
  if (t !== '' && !t.endsWith('\n')) t += '\n';
  if (t !== '' && !t.endsWith('\n\n')) t += '\n';
  return `${t}${IMPORT_LINE}\n`;
}

function gitignoreWith(current) {
  const t = current === null || current === '' || current.endsWith('\n') ? (current ?? '') : `${current}\n`;
  return `${t}${SETTINGS}\n`;
}

function isIgnored(gitignore) {
  return gitignore !== null && gitignore.split('\n').some((l) => IGNORING_LINES.has(l.trim()));
}

function hasForbiddenKey(root) {
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) return true;
      stack.push(v[k]);
    }
  }
  return false;
}

/**
 * T5: parses the current settings.local.json, replaces only `enabledPlugins` (selected → true, other `true` entries
 * removed, `false` entries untouched) and copies every other key verbatim. Returns the new text, or `current` when nothing
 * changes, or null when there is no file and nothing to write. Never interprets hooks, permissions, env, apiKeyHelper,
 * mcpServers or model.
 */
function settingsWith(current, selected) {
  const invalid = (m) => fail(400, 'invalid', `${SETTINGS}: ${m}`);
  let obj = {};
  if (current !== null) {
    try {
      obj = JSON.parse(current);
    } catch {
      throw invalid('invalid JSON');
    }
    if (!isPlain(obj)) throw invalid('not a JSON object');
    if (hasForbiddenKey(obj)) throw invalid('contains a __proto__, constructor or prototype key');
  }
  const prev = obj.enabledPlugins;
  if (prev !== undefined && !isPlain(prev)) throw invalid('enabledPlugins is not an object');
  const plugins = {};
  for (const [k, v] of Object.entries(prev ?? {})) if (v !== true || selected.includes(k)) plugins[k] = v;
  for (const p of selected) plugins[p] = true;

  const next = {};
  for (const k of Object.keys(obj)) next[k] = k === 'enabledPlugins' ? plugins : obj[k];
  if (prev === undefined && Object.keys(plugins).length) next.enabledPlugins = plugins;
  if (isDeepStrictEqual(next, obj)) return current; // keep the file's own formatting when nothing changes
  const text = `${JSON.stringify(next, null, 2)}\n`;

  // deep-equal assertion: every other key must survive the rewrite
  const again = JSON.parse(text);
  const kept = Object.keys(again).filter((k) => k !== 'enabledPlugins');
  const same = kept.length === Object.keys(obj).filter((k) => k !== 'enabledPlugins').length
    && kept.every((k) => Object.prototype.hasOwnProperty.call(obj, k) && isDeepStrictEqual(again[k], obj[k]));
  if (!same) throw invalid('a value does not survive a rewrite');
  return text;
}

/**
 * What the preview may show of settings.local.json: `{"enabledPlugins": …}` before and after (pretty JSON), and how many
 * other top-level keys the file has. The values of those keys (env, permissions, hooks, …) never leave this module. A
 * missing file shows an empty "before". Never throws: an unreadable file is only ever `unchanged` (no selection).
 */
function settingsView(current, next) {
  const parse = (text) => {
    try {
      const v = text === null ? null : JSON.parse(text);
      return isPlain(v) ? v : {};
    } catch {
      return {};
    }
  };
  const block = (obj) => `${JSON.stringify({ enabledPlugins: obj.enabledPlugins }, null, 2)}\n`;
  const after = parse(next);
  return {
    from: current === null ? '' : block(parse(current)),
    to: block(after),
    keptKeys: Object.keys(after).filter((k) => k !== 'enabledPlugins').length,
  };
}

// ------------------------------------------------------------------------------------------------------------------ plan

async function checkProject(project) {
  const ok = isPlain(project) && typeof project.key === 'string' && PROJECT_KEY.test(project.key)
    && typeof project.dir === 'string' && path.isAbsolute(project.dir) && keyFor(project.dir) === project.key;
  if (!ok) throw fail(400, 'invalid', 'invalid project');
  let real;
  try {
    if (!(await fs.lstat(project.dir)).isDirectory()) throw new Error('not a directory');
    real = await fs.realpath(project.dir);
  } catch {
    throw fail(409, 'conflict', 'the project folder is gone or is no longer a folder');
  }
  if (real !== project.dir) throw fail(409, 'conflict', 'the project folder moved or is now behind a symlink');
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);

function nowMs(ctx) {
  const n = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  return Number.isFinite(n) ? n : Date.now();
}

/** `YYYYMMDDTHHMMSSZ` (pruneBackups in fwrite.js recognises this format, plus the `-<n>` suffix freshBackupDir adds) */
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Reads the project and computes every planned write; throws a `fail` / fwrite error on anything unsafe. */
async function plan(project, ctx = {}) {
  const env = ctx.env ?? process.env;
  await checkProject(project);
  const dir = project.dir;
  const { config, warnings: configWarnings } = await loadConfig(env);
  const warnings = configWarnings.map((w) => `config: ${w}`);

  const files = [];
  const add = (rel, current, next, extra = {}) => files.push({ path: rel, current, next, extra });

  const rulesNext = await renderRules(config, project, env);
  const rulesCurrent = await readTarget(dir, RULES);
  add(RULES, rulesCurrent, rulesNext, { foreign: rulesCurrent !== null && classify(rulesCurrent) === 'foreign' });

  // Claude reads AGENTS.md only while no CLAUDE.md exists: a CLAUDE.md nika created beside a lone AGENTS.md would turn it off.
  // So CLAUDE.md is created only when there is no AGENTS.md; an AGENTS.md is edited, never created. A symlinked AGENTS.md is
  // never followed or written: it is skipped when CLAUDE.md exists (the usual AGENTS.md -> CLAUDE.md), refused when it is alone.
  const claudeCurrent = await readTarget(dir, CLAUDE);
  const agents = await readAgents(dir);
  if (agents.link && claudeCurrent === null) {
    throw fail(409, 'refused', 'AGENTS.md is a symlink and there is no CLAUDE.md; nika never follows links, so it cannot add the rules import. Replace the link with a regular file, then apply again.', 'ESYMLINK');
  }
  if (claudeCurrent !== null || (!agents.link && agents.text === null)) add(CLAUDE, claudeCurrent, importWith(claudeCurrent));
  if (agents.link) add(AGENTS, null, null, { note: 'AGENTS.md is a link; left as is' });
  else if (agents.text !== null) add(AGENTS, agents.text, importWith(agents.text));

  // plugins are managed only for projects the user configured; no entry means enabledPlugins stays as it is
  const selected = config.perProject[project.key]?.plugins;
  const settingsCurrent = await readTarget(dir, SETTINGS);
  const settingsNext = selected === undefined ? settingsCurrent : settingsWith(settingsCurrent, selected);
  add(SETTINGS, settingsCurrent, settingsNext, { keysPreserved: true });

  if (!(await exists(path.join(dir, '.git')))) warnings.push('no .git in the project folder: not a git repository (or a subfolder of one)');
  if (settingsNext !== null) {
    let gitignore = null;
    let readable = true;
    try {
      gitignore = await readTarget(dir, GITIGNORE);
    } catch (err) {
      readable = false;
      warnings.push(`.gitignore cannot be read safely (${err.code ?? 'error'}); add ${SETTINGS} to it yourself`);
    }
    if (readable && !isIgnored(gitignore)) add(GITIGNORE, gitignore, gitignoreWith(gitignore), { optional: true });
    if (!readable || !isIgnored(gitignore)) warnings.push('settings.local.json is not gitignored');
  }

  for (const f of files) {
    f.action = f.extra.note ? 'skipped' : f.next === null || f.next === f.current ? 'unchanged' : f.current === null ? 'create' : 'update';
    let [from, to] = [f.current ?? '', f.next];
    if (f.path === SETTINGS) {
      ({ from, to, keptKeys: f.extra.keptKeys } = settingsView(f.current, f.next)); // the hash below still covers the whole file
    }
    f.diff = f.action === 'unchanged' || f.action === 'skipped' ? '' : unifiedDiff(from, to, f.path);
  }
  const hash = sha(JSON.stringify(files.map((f) => [f.path, f.current === null ? null : sha(f.current), f.next])));
  return { files, hash, warnings, backupDir: path.join(backupsDir(project.key, env), stamp(nowMs(ctx))) };
}

// --------------------------------------------------------------------------------------------------------------- public

/** `{ state, settingsIgnored, git }` for the project list. Never throws for a registered project: an unreadable rules file counts as foreign. */
export async function rulesState(project) {
  const dir = project.dir;
  let state = 'none';
  try {
    const current = await readTarget(dir, RULES);
    if (current !== null) state = classify(current);
  } catch {
    state = 'foreign';
  }
  let settingsIgnored = false;
  try {
    settingsIgnored = isIgnored(await readTarget(dir, GITIGNORE));
  } catch {
    // unreadable .gitignore: not known to cover the file
  }
  return { state, settingsIgnored, git: await exists(path.join(dir, '.git')) };
}

/** `{ status, body }`: per-file actions with unified diffs, warnings, the hash `apply` must echo, and the backup folder. */
export async function preview(project, ctx = {}) {
  try {
    const p = await plan(project, ctx);
    const files = p.files.map((f) => ({ path: f.path, action: f.action, diff: f.diff, ...f.extra }));
    return { status: 200, body: { hash: p.hash, files, warnings: p.warnings, backupDir: p.backupDir } };
  } catch (err) {
    return toResult(err);
  }
}

/** First `<stamp>`, `<stamp>-1`, ... that does not exist yet, so two applies in one second never share a backup folder. */
async function freshBackupDir(base) {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw fail(409, 'refused', 'too many backups in the same second', 'EEXIST');
}

/**
 * Mode for a written file: an existing target keeps its mode minus group/other write (never widened, so a 0600 settings
 * file stays 0600); a new `.claude/settings.local.json` is 0600 (user-local settings), other new files 0644.
 */
async function targetMode(abs, rel) {
  try {
    return ((await fs.lstat(abs)).mode & 0o777) & ~0o022;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return rel === SETTINGS ? 0o600 : 0o644;
  }
}

/**
 * Recomputes the preview; a different hash is 409 `conflict`, a foreign rules file without `overwriteForeign` is 409
 * `foreign`. Then, per changed file: checkComponents → backup → ensureDir → writeAtomic (mode: see targetMode). Every check and backup
 * runs before the first write, so a refusal leaves the project untouched.
 */
export async function apply(project, opts, ctx = {}) {
  const written = [];
  let backupDir;
  try {
    if (!isPlain(opts) || typeof opts.hash !== 'string' || !/^[0-9a-f]{64}$/.test(opts.hash)) throw fail(400, 'invalid', 'hash must be the hash from the preview');
    for (const k of ['overwriteForeign', 'gitignore']) if (opts[k] !== undefined && typeof opts[k] !== 'boolean') throw fail(400, 'invalid', `${k} must be a boolean`);
    const p = await plan(project, ctx);
    if (p.hash !== opts.hash) throw fail(409, 'conflict', 'the project changed since the preview; preview again');
    const rules = p.files.find((f) => f.path === RULES);
    if (rules.extra.foreign && !opts.overwriteForeign) throw fail(409, 'foreign', `${RULES} was not written by nika; overwriting needs overwriteForeign`);

    const dir = project.dir;
    const PROJ = { project: true, platform: ctx.platform, gid: ctx.gid }; // platform and gid are injectable for tests only
    const todo = p.files.filter((f) => f.action !== 'unchanged' && f.action !== 'skipped' && (!f.extra.optional || opts.gitignore === true));
    backupDir = await freshBackupDir(p.backupDir);
    await ensureDir(dir, 0o755, PROJ); // the project root itself: world-writable is refused, nothing is created yet
    const prepared = [];
    for (const f of todo) {
      const c = await checkComponents(dir, f.path);
      // CLAUDE.md is created only because there is no AGENTS.md: if one arrived since the plan, creating it would turn that file off
      if (f.path === CLAUDE && f.current === null && (await exists(path.join(dir, AGENTS)))) throw fail(409, 'conflict', 'AGENTS.md appeared while applying; preview again');
      if (await isRealDir(c.dir)) await ensureDir(c.dir, 0o755, PROJ);
      if ((await readText(c.abs, FILE_MAX)) !== f.current) throw fail(409, 'conflict', `${f.path} changed while applying; preview again`);
      await backupFile(c.abs, backupDir, f.path);
      prepared.push({ f, c, mode: await targetMode(c.abs, f.path) });
    }
    for (const { f, c, mode } of prepared) {
      await ensureDir(c.dir, 0o755, PROJ);
      await writeAtomic(c.dir, c.name, f.next, { mode, root: dir, ...PROJ });
      written.push(f.path);
    }
    // the writes are done: a failed prune (unsafe folder, race) must not turn a successful apply into an error
    if (written.length) await pruneBackups(path.dirname(backupDir), BACKUPS_KEEP, path.basename(backupDir)).catch(() => {});
    return { status: 200, body: { written, backupDir } };
  } catch (err) {
    const res = toResult(err);
    if (written.length) Object.assign(res.body, { written, backupDir }); // partial write: say what landed and where the backups are
    return res;
  }
}
