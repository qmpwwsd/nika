// Slash commands and skills for the session window's `/` palette (GET /api/app/commands, contract api-app.md).
// Every folder here is agent-writable (T22): names are checked against COMMAND_NAME, files are read through fsafe
// (no symlinks, regular user-owned files), only the first 4 KB of each, frontmatter only, text through clean().
// Bodies are never read and no path leaves this module.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readHead } from '../fsafe.js';
import { COMMAND_NAME } from '../ids.js';
import { clean } from '../text.js';
import { BUILTIN_COMMANDS } from '../commands-builtin.js';
import { listPluginDirs } from './plugins.js';

const HEAD_BYTES = 4096;
const MAX_FILES = 200; // per folder
const MAX_ENTRIES = 1000; // in total, built-ins included
const TEXT_MAX = 200;
const CACHE_MS = 10_000;

const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;

function scalar(raw) {
  const v = raw.trim();
  if (/^[>|][+-]?\d?$/.test(v)) return ''; // block scalar header: its text sits on indented lines, which are ignored
  const quoted = /^(["'])(.*)\1$/.exec(v);
  return quoted ? quoted[2] : v;
}

/**
 * `key: value` scalars between a leading `---` line and the next `---` line, quotes stripped; {} when the text does not
 * start with `---` or the block is not closed (a head cut off before the closing line counts as not closed).
 * Indented lines, list items, comments and anything else are ignored.
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return {};
  const lines = text.split(/\r?\n/);
  if (lines[0].trimEnd() !== '---') return {};
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return {};
  const pairs = [];
  for (const line of lines.slice(1, end)) {
    const m = KEY_LINE.exec(line);
    if (m) pairs.push([m[1], scalar(m[2] ?? '')]);
  }
  return Object.fromEntries(pairs); // fromEntries defines own properties, so a `__proto__` key cannot change the prototype
}

/** Frontmatter of a safe regular file; null when the file is missing, a symlink or otherwise unsafe. */
async function frontmatterOf(file) {
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

function entryOf(fm, name) {
  if (!COMMAND_NAME.test(name) || fm['user-invocable']?.toLowerCase() === 'false') return null;
  return { name, description: clean(fm.description, TEXT_MAX) ?? '', argHint: clean(fm['argument-hint'], TEXT_MAX) ?? '' };
}

/**
 * Entries of one source folder (`<base>/skills/<folder>/SKILL.md`, `<base>/commands/<file>.md`), at most `limit`. A skill wins over
 * a command of the same name. A skill folder may be a symlink (skill installers link folders); its SKILL.md may not.
 */
async function readSource(base, limit) {
  const found = new Map();
  const add = (e) => { if (e && !found.has(e.name)) found.set(e.name, e); };
  for (const folder of await names(path.join(base, 'skills'), (d) => d.isDirectory() || d.isSymbolicLink())) {
    if (found.size >= limit) break;
    const fm = await frontmatterOf(path.join(base, 'skills', folder, 'SKILL.md'));
    if (fm) add(entryOf(fm, fm.name || folder));
  }
  for (const file of await names(path.join(base, 'commands'), (d) => d.isFile() && d.name.endsWith('.md'))) {
    if (found.size >= limit) break;
    const fm = await frontmatterOf(path.join(base, 'commands', file));
    if (fm) add(entryOf(fm, file.slice(0, -'.md'.length)));
  }
  return [...found.values()];
}

async function addSource(out, base, source, plugin) {
  const room = MAX_ENTRIES - out.length;
  if (room <= 0) return;
  for (const e of (await readSource(base, room)).slice(0, room)) {
    out.push(plugin ? { ...e, name: `${plugin}:${e.name}`, source, plugin } : { ...e, source });
  }
}

const cache = new Map();

/**
 * Palette entries: built-ins first, then user, project (only with `projectDir`) and plugin entries. `claudeDir` and
 * `projectDir` come from the caller (nika's own project registry), never from a request. Cached 10 s per
 * claudeDir/projectDir pair; `now` is injectable for tests.
 */
export async function listCommands({ claudeDir, projectDir, now = Date.now() }) {
  const key = `${claudeDir}\0${projectDir ?? ''}`;
  const hit = cache.get(key);
  if (hit && now - hit.at >= 0 && now - hit.at < CACHE_MS) return hit.entries;

  const entries = BUILTIN_COMMANDS.map(({ name, description, argHint, dialog }) => (
    { name, description, argHint: argHint ?? '', source: 'builtin', ...(dialog && { dialog }) }
  ));
  await addSource(entries, claudeDir, 'user');
  if (projectDir) await addSource(entries, path.join(projectDir, '.claude'), 'project');
  for (const { name, installPath } of await listPluginDirs(claudeDir)) {
    await addSource(entries, installPath, 'plugin', name.split('@')[0]);
  }
  cache.set(key, { at: now, entries });
  return entries;
}
