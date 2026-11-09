// nika's own config (`configDir()/config.json`, 0600) and project registry (ADR 0006, 0008). The file is user-owned but
// lives in a dir agents can write to: loading never throws on garbage, it falls back to defaults and reports warnings.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './paths.js';
import { ensureDir, writeAtomic } from './fwrite.js';
import { readHead } from './fsafe.js';
import { clean } from './text.js';
import { PROJECT_KEY, MODEL_ID, RC_PREFIX, PLUGIN_NAME, PERMISSION_MODES, PANE_PLACEMENTS } from './ids.js';

const CONFIG_MAX = 256 * 1024;
const PLUGINS_MAX = 200;
const PROJECTS_MAX = 100;
export const TEMPLATE_NAME = /^[A-Za-z0-9_-]{1,64}\.md$/;
const THEMES = ['system', 'light', 'dark']; // system = follow prefers-color-scheme
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (m) => Object.assign(new Error(m), { code: 'EINVAL' });
const isProjectKey = (k) => typeof k === 'string' && PROJECT_KEY.test(k);

export function defaults() {
  return {
    models: { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-sonnet-5-5', scout: 'claude-haiku-5-5' },
    remoteControl: { enabled: false, prefix: '' },
    permissionMode: 'default',
    panePlacement: 'beside',
    limits: { maxAgents: 3 },
    perProject: {},
    projects: [],
    rules: { localTemplate: null },
    ui: { theme: 'system', singleKeyShortcuts: true },
  };
}

// Each leaf returns the accepted value or undefined (→ default + warning).
const str = (re) => (v) => (typeof v === 'string' && re.test(v) ? v : undefined);
const oneOf = (list) => (v) => (list.includes(v) ? v : undefined);
const intIn = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

/** A deduplicated list of at most PLUGINS_MAX plugin names, or undefined when v is anything else. */
function pluginList(v) {
  const ok = Array.isArray(v) && v.length <= PLUGINS_MAX && v.every((p) => typeof p === 'string' && PLUGIN_NAME.test(p));
  return ok ? [...new Set(v)] : undefined;
}

/** perProject: { <PROJECT_KEY>: { plugins?: string[] } }. A bad key, entry or list drops that entry; other inner keys are dropped (0.4 adds more). An empty list or an empty entry is "none" and is not kept. */
function perProject(v, warn) {
  if (!isPlainObject(v)) return undefined;
  const out = {};
  for (const key of Object.keys(v)) {
    const at = `perProject.${clean(key, 40) ?? '?'}`;
    const entry = v[key];
    const plugins = isPlainObject(entry) && hasOwn(entry, 'plugins') ? pluginList(entry.plugins) : undefined;
    if (!isProjectKey(key) || !isPlainObject(entry) || (hasOwn(entry, 'plugins') && plugins === undefined)) {
      warn(`${at} dropped`);
      continue;
    }
    for (const k of Object.keys(entry)) if (k !== 'plugins') warn(`unknown key ${at}.${clean(k, 40) ?? '?'} dropped`);
    if (plugins?.length) out[key] = { plugins }; // an empty list is a valid "none": no entry (the entry holds only `plugins` until 0.4)
  }
  return out;
}

export function keyFor(realDir) {
  return crypto.createHash('sha256').update(realDir).digest('hex').slice(0, 16);
}

function projects(v, warn) {
  if (!Array.isArray(v) || v.length > PROJECTS_MAX) return undefined;
  const out = [];
  for (const p of v) {
    const ok = isPlainObject(p) && typeof p.dir === 'string' && path.isAbsolute(p.dir) && p.key === keyFor(p.dir)
      && typeof p.name === 'string' && clean(p.name, 255) === p.name && (p.addedAt === undefined || typeof p.addedAt === 'string');
    if (!ok) {
      warn('projects entry dropped');
      continue;
    }
    out.push({ key: p.key, dir: p.dir, name: p.name, ...(p.addedAt ? { addedAt: p.addedAt } : {}) });
  }
  return out;
}

const SCHEMA = {
  models: { orchestrator: str(MODEL_ID), reasoner: str(MODEL_ID), builder: str(MODEL_ID), scout: str(MODEL_ID) },
  remoteControl: { enabled: bool, prefix: (v) => (v === '' ? v : str(RC_PREFIX)(v)) },
  permissionMode: oneOf(PERMISSION_MODES),
  panePlacement: oneOf(PANE_PLACEMENTS),
  limits: { maxAgents: intIn(1, 8) },
  perProject,
  projects,
  rules: { localTemplate: (v) => (v === null ? v : str(TEMPLATE_NAME)(v)) },
  ui: { theme: oneOf(THEMES), singleKeyShortcuts: bool },
};

/** Walks SCHEMA: unknown keys dropped, bad values replaced by defaults; every deviation is a warning. */
function validate(raw, schema = SCHEMA, dflt = defaults(), warnings = [], prefix = '') {
  const warn = (m) => warnings.push(m);
  const out = {};
  const src = isPlainObject(raw) ? raw : {};
  for (const k of Object.keys(src)) if (!hasOwn(schema, k)) warn(`unknown key ${prefix}${clean(k, 40) ?? '?'} dropped`);
  for (const k of Object.keys(schema)) {
    const node = schema[k];
    if (typeof node === 'function') {
      const v = hasOwn(src, k) ? node(src[k], warn) : undefined;
      if (v === undefined) {
        if (hasOwn(src, k)) warn(`${prefix}${k} invalid, default used`);
        out[k] = dflt[k];
      } else out[k] = v;
    } else {
      if (hasOwn(src, k) && !isPlainObject(src[k])) warn(`${prefix}${k} invalid, default used`);
      out[k] = validate(src[k], node, dflt[k], warnings, `${prefix}${k}.`);
    }
  }
  return out;
}

function configFile(env) {
  return path.join(configDir(env), 'config.json');
}

/**
 * 0.3.3 and older kept plugin lists in `plugins.perProject: { key: [names] }`; 0.3.4 keeps them in `perProject[key].plugins`.
 * The legacy group is converted when `perProject` is absent and dropped silently either way; the next save writes the new shape.
 */
function migrate(raw) {
  if (!isPlainObject(raw) || !hasOwn(raw, 'plugins') || !isPlainObject(raw.plugins)) return raw;
  const { plugins: legacy, ...rest } = raw;
  if (!hasOwn(rest, 'perProject') && isPlainObject(legacy.perProject)) {
    rest.perProject = Object.fromEntries(Object.entries(legacy.perProject).map(([k, list]) => [k, Array.isArray(list) ? { plugins: list } : list]));
  }
  return rest;
}

/** Never throws: a missing, unreadable or tampered file yields defaults plus warnings. */
export async function loadConfig(env = process.env) {
  const file = configFile(env);
  const warnings = [];
  let raw = {};
  try {
    raw = JSON.parse(await readHead(file, CONFIG_MAX));
  } catch (err) {
    if (err.code !== 'ENOENT') warnings.push(`config.json unreadable (${err.code || 'invalid JSON'}), defaults used`);
  }
  return { config: validate(migrate(raw), SCHEMA, defaults(), warnings), warnings, file };
}

// Mutations (read-modify-write of config.json) of this process run one at a time, so concurrent API calls cannot lose
// each other's update. Across processes the last atomic rename wins.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {}); // a failed mutation must not block the next one
  return run;
}

/** Re-validates and writes config.json (0600) through fwrite; returns the file path. Runs inside the queue. */
async function writeConfig(config, env) {
  const warnings = [];
  const valid = validate(config, SCHEMA, defaults(), warnings);
  if (warnings.length) throw Object.assign(new Error(warnings.join('; ')), { code: 'EINVAL', warnings });
  const dir = await ensureDir(configDir(env));
  return writeAtomic(dir, 'config.json', `${JSON.stringify(valid, null, 2)}\n`);
}

/** Re-validates and writes config.json (0600) through fwrite; returns the file path. */
export function saveConfig(config, env = process.env) {
  return serial(() => writeConfig(config, env));
}

/** Registers a project dir (realpath; existing dir); returns the existing entry on a duplicate. */
export function addProject(dir, env = process.env) {
  return serial(async () => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw Object.assign(new Error('project dir must be absolute'), { code: 'EPATH' });
    const real = await fs.realpath(dir);
    if (!(await fs.stat(real)).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
    const key = keyFor(real);
    const { config } = await loadConfig(env);
    const existing = config.projects.find((p) => p.key === key);
    if (existing) return existing;
    const name = clean(path.basename(real), 255) ?? key;
    const project = { key, dir: real, name, addedAt: new Date().toISOString() };
    config.projects.push(project);
    await writeConfig(config, env);
    return project;
  });
}

/** Removes a project and its per-project config; true when something was removed. */
export function removeProject(key, env = process.env) {
  return serial(async () => {
    if (!isProjectKey(key)) throw bad('invalid project key');
    const { config } = await loadConfig(env);
    const before = config.projects.length;
    config.projects = config.projects.filter((p) => p.key !== key);
    delete config.perProject[key];
    if (config.projects.length === before) return false;
    await writeConfig(config, env);
    return true;
  });
}

export async function listProjects(env = process.env) {
  return (await loadConfig(env)).config.projects;
}

/**
 * Merges a settings patch (every top-level key except `projects` and `perProject`; object groups merge one level deep)
 * and saves it. Throws EINVAL on any invalid or unknown value.
 */
export function updateSettings(patch, env = process.env) {
  return serial(async () => {
    if (!isPlainObject(patch)) throw bad('settings must be an object');
    if (hasOwn(patch, 'projects')) throw bad('projects are managed with nika projects add|remove');
    if (hasOwn(patch, 'perProject')) throw bad('per-project settings are saved on the project page');
    if (patch.permissionMode === 'bypassPermissions') throw bad('bypassPermissions is never allowed');
    // own keys only: `__proto__` from JSON.parse must never reach the `next[k] =` assignment below
    for (const k of Object.keys(patch)) if (!hasOwn(SCHEMA, k)) throw bad(`unknown key ${clean(k, 40) ?? '?'}`);
    const { config } = await loadConfig(env);
    const next = { ...config };
    for (const k of Object.keys(patch)) {
      const node = SCHEMA[k];
      next[k] = typeof node !== 'function' && isPlainObject(patch[k]) && isPlainObject(config[k]) ? { ...config[k], ...patch[k] } : patch[k];
    }
    await writeConfig(next, env);
    return (await loadConfig(env)).config;
  });
}

/** `{ plugins }` saved for a project: the names to turn on, [] when none. Throws EINVAL on a bad key. */
export async function getProjectConfig(key, env = process.env) {
  if (!isProjectKey(key)) throw bad('invalid project key');
  return { plugins: (await loadConfig(env)).config.perProject[key]?.plugins ?? [] };
}

/**
 * Sets one project's config. Today the patch is exactly `{ plugins: string[] }` (0.4 adds more); `plugins: []` removes the list
 * and the entry with it. Runs in the serial queue, so two pages saving different projects cannot overwrite each other.
 * Throws EINVAL (bad key or patch) or ENOENT (not a registered project); returns the project's new `{ plugins }`.
 */
export function updateProjectConfig(key, patch, env = process.env) {
  return serial(async () => {
    if (!isProjectKey(key)) throw bad('invalid project key');
    // own keys only: an inherited or `__proto__` key never counts as `plugins`
    if (!isPlainObject(patch) || Object.keys(patch).length !== 1 || !hasOwn(patch, 'plugins')) throw bad('patch must be { plugins: [...] }');
    const plugins = pluginList(patch.plugins);
    if (plugins === undefined) throw bad(`plugins must be a list of at most ${PLUGINS_MAX} plugin names like name@marketplace`);
    const { config } = await loadConfig(env);
    if (!config.projects.some((p) => p.key === key)) throw Object.assign(new Error('project is not registered'), { code: 'ENOENT' });
    const entry = { ...config.perProject[key] };
    if (plugins.length) entry.plugins = plugins;
    else delete entry.plugins;
    if (Object.keys(entry).length) config.perProject[key] = entry;
    else delete config.perProject[key];
    await writeConfig(config, env);
    return { plugins };
  });
}
