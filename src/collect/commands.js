// Slash commands and skills for the session window's `/` palette (GET /api/app/commands, contract api-app.md).
// Every folder here is agent-writable (T22): names are checked against COMMAND_NAME, files are read through fsafe
// (no symlinks, regular user-owned files), only the first 4 KB of each, frontmatter only, text through clean().
// Bodies are never read and no path leaves this module.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readHead, isRealDir } from '../fsafe.js';
import { COMMAND_NAME } from '../ids.js';
import { clean } from '../text.js';
import { BUILTIN_COMMANDS } from '../commands-builtin.js';
import { listPluginDirs } from './plugins.js';

const HEAD_BYTES = 4096;
const MAX_FILES = 200; // per folder
const MAX_ENTRIES = 1000; // in total, built-ins included
const MAX_OPENS = 2000; // files opened per scan, whatever they turn out to hold; the entries found so far are returned
const TEXT_MAX = 200;
const CACHE_MS = 10_000;

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
const BLOCK_HEADER = /^[>|][+-]?\d?$/;

function scalar(raw) {
  const v = raw.trim();
  if (BLOCK_HEADER.test(v)) return ''; // only `description` reads its block (see parseFrontmatter)
  const quoted = /^(["'])(.*)\1$/.exec(v);
  return quoted ? quoted[2] : v;
}

/**
 * `key: value` scalars between a leading `---` line and the next `---` line, quotes stripped. `description` may be a
 * folded or literal block (`>`, `>-`, `|`, `|-`): the more-indented lines after it, joined with one space. Indented
 * lines elsewhere, list items, comments and anything else are ignored.
 * Returns {} when the text does not start with `---` (no frontmatter) and null when it does but the block is never
 * closed: a head cut off before the closing line may have hidden a `user-invocable: false`, so the caller skips the file.
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return {};
  const lines = text.split(/\r?\n/);
  if (lines[0].trimEnd() !== '---') return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return null;
  const block = lines.slice(1, end);
  const pairs = [];
  for (let i = 0; i < block.length; i += 1) {
    const m = KEY_LINE.exec(block[i]);
    if (!m) continue;
    let value = scalar(m[2] ?? '');
    if (m[1] === 'description' && BLOCK_HEADER.test((m[2] ?? '').trim())) {
      const parts = [];
      while (i + 1 < block.length && /^(?:[ \t]|\s*$)/.test(block[i + 1])) parts.push(block[i += 1].trim());
      value = parts.filter(Boolean).join(' ');
    }
    pairs.push([m[1], value]);
  }
  return Object.fromEntries(pairs); // fromEntries defines own properties, so a `__proto__` key cannot change the prototype
}

/** Frontmatter of a safe regular file; null when the file is missing, a symlink, otherwise unsafe, or its frontmatter never closes. */
async function frontmatterOf(file, scan) {
  scan.opens += 1;
  try {
    return parseFrontmatter(await readHead(file, HEAD_BYTES));
  } catch {
    return null;
  }
}

/** Sorted names of the entries of `dir` that pass `keep`, at most MAX_FILES; [] when the folder is missing. */
async function names(dir, keep) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter(keep).map((d) => d.name).sort().slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

const realOrNull = (p) => fs.realpath(p).catch(() => null);

/** True when `p` resolves (symlinks followed) strictly inside the real directory `root`. */
async function inside(p, root) {
  const real = await realOrNull(p);
  return real !== null && real.startsWith(root + path.sep);
}

function entryOf(fm, name) {
  if (!COMMAND_NAME.test(name) || fm['user-invocable']?.toLowerCase() === 'false') return null;
  return { name, description: clean(fm.description, TEXT_MAX) ?? '', argHint: clean(fm['argument-hint'], TEXT_MAX) ?? '' };
}

/**
 * `<src.base>/commands` or `<src.base>/skills`, or null when it may not be read. A source with a `boundary` (project and
 * plugin sources: their folders are agent-writable, T22) must resolve inside it; with `realDirs` the folder must also be
 * a real directory, not a link. Without a boundary (the user's own config dir) links are followed: dotfile managers use them.
 */
async function container(src, name) {
  const dir = path.join(src.base, name);
  if (!src.boundary) return dir;
  if (src.realDirs && !(await isRealDir(dir))) return null;
  return (await inside(dir, src.boundary)) ? dir : null;
}

/**
 * Entries of one source (`<base>/skills/<folder>/SKILL.md`, `<base>/commands/<file>.md`), at most `limit`. A skill wins
 * over a command of the same name; a hidden skill (`user-invocable: false`) is not an entry, so it does not shadow one.
 * A skill folder may be a symlink (skill installers link folders), but under a boundary it must resolve inside it;
 * its SKILL.md may never be a link (fsafe).
 */
async function readSource(src, scan, limit) {
  const found = new Map();
  const add = (e) => { if (e && !found.has(e.name)) found.set(e.name, e); };
  const spent = () => found.size >= limit || scan.opens >= MAX_OPENS;
  const skills = await container(src, 'skills');
  if (skills) {
    for (const folder of await names(skills, (d) => d.isDirectory() || d.isSymbolicLink())) {
      if (spent()) break;
      const dir = path.join(skills, folder);
      if (src.boundary && !(await inside(dir, src.boundary))) continue;
      const fm = await frontmatterOf(path.join(dir, 'SKILL.md'), scan);
      if (fm) add(entryOf(fm, fm.name || folder));
    }
  }
  const commands = await container(src, 'commands');
  if (commands) {
    for (const file of await names(commands, (d) => d.isFile() && d.name.endsWith('.md'))) {
      if (spent()) break;
      const fm = await frontmatterOf(path.join(commands, file), scan);
      if (fm) add(entryOf(fm, file.slice(0, -'.md'.length)));
    }
  }
  return [...found.values()];
}

/** Appends the entries of one source to `out`; plugin entries are named `<plugin>:<name>` and the first of a full name wins (`seen`). */
async function addSource(out, src, scan, source, plugin, seen) {
  const room = MAX_ENTRIES - out.length;
  if (room <= 0) return;
  for (const e of await readSource(src, scan, room)) {
    const name = plugin ? `${plugin}:${e.name}` : e.name;
    if (seen?.has(name) || out.length >= MAX_ENTRIES) continue;
    seen?.add(name);
    out.push(plugin ? { ...e, name, source, plugin } : { ...e, source });
  }
}

async function scanAll(claudeDir, projectDir) {
  const scan = { opens: 0 };
  const entries = BUILTIN_COMMANDS.map(({ name, description, argHint, dialog }) => (
    { name, description, argHint: argHint ?? '', source: 'builtin', ...(dialog && { dialog }) }
  ));
  await addSource(entries, { base: claudeDir }, scan, 'user');
  const projectReal = projectDir ? await realOrNull(projectDir) : null;
  if (projectReal) await addSource(entries, { base: path.join(projectDir, '.claude'), boundary: projectReal, realDirs: true }, scan, 'project');
  const cacheReal = await realOrNull(path.join(claudeDir, 'plugins', 'cache'));
  if (cacheReal) {
    const seen = new Set();
    for (const { name, installPath } of await listPluginDirs(claudeDir)) {
      if (scan.opens >= MAX_OPENS || entries.length >= MAX_ENTRIES) break;
      await addSource(entries, { base: installPath, boundary: cacheReal }, scan, 'plugin', name.split('@')[0], seen);
    }
  }
  entries.forEach((e) => Object.freeze(e));
  return Object.freeze(entries);
}

const cache = new Map();
const inflight = new Map();

/**
 * Palette entries, frozen: built-ins first, then user, project (only with `projectDir`) and plugin entries.
 * `claudeDir` and `projectDir` come from the caller (nika's own project registry), never from a request. Cached 10 s per
 * claudeDir/projectDir pair; calls that arrive during a scan share it. `now` is injectable for tests.
 */
export function listCommands({ claudeDir, projectDir, now = Date.now() }) {
  const key = `${claudeDir}\0${projectDir ?? ''}`;
  const hit = cache.get(key);
  if (hit && now - hit.at >= 0 && now - hit.at < CACHE_MS) return Promise.resolve(hit.entries);
  if (!inflight.has(key)) {
    inflight.set(key, scanAll(claudeDir, projectDir)
      .then((entries) => { cache.set(key, { at: now, entries }); return entries; })
      .finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}
