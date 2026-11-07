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
const TEMPLATE_NAME = /^[A-Za-z0-9_-]{1,64}\.md$/;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function defaults() {
  return {
    models: { orchestrator: 'claude-fable-5-1', reasoner: 'claude-opus-5-5', builder: 'claude-sonnet-5-5', scout: 'claude-haiku-5-5' },
    remoteControl: { enabled: false, prefix: '' },
    permissionMode: 'default',
    panePlacement: 'beside',
    limits: { maxAgents: 3, maxTurns: 80 },
    plugins: { perProject: {} },
    projects: [],
    rules: { localTemplate: null },
  };
}

// Each leaf returns the accepted value or undefined (→ default + warning).
const str = (re) => (v) => (typeof v === 'string' && re.test(v) ? v : undefined);
const oneOf = (list) => (v) => (list.includes(v) ? v : undefined);
const intIn = (lo, hi) => (v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

function perProject(v, warn) {
  if (!isPlainObject(v)) return undefined;
  const out = {};
  for (const key of Object.keys(v)) {
    const list = v[key];
    if (!PROJECT_KEY.test(key) || !Array.isArray(list) || list.length > PLUGINS_MAX || !list.every((p) => PLUGIN_NAME.test(p))) {
      warn(`plugins.perProject.${clean(key, 40) ?? '?'} dropped`);
      continue;
    }
    out[key] = [...new Set(list)];
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
  limits: { maxAgents: intIn(1, 8), maxTurns: intIn(1, 1000) },
  plugins: { perProject },
  projects,
  rules: { localTemplate: (v) => (v === null ? v : str(TEMPLATE_NAME)(v)) },
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
  return { config: validate(raw, SCHEMA, defaults(), warnings), warnings, file };
}

/** Re-validates and writes config.json (0600) through fwrite; returns the file path. */
export async function saveConfig(config, env = process.env) {
  const warnings = [];
  const valid = validate(config, SCHEMA, defaults(), warnings);
  if (warnings.length) throw Object.assign(new Error(warnings.join('; ')), { code: 'EINVAL', warnings });
  const dir = await ensureDir(configDir(env));
  return writeAtomic(dir, 'config.json', `${JSON.stringify(valid, null, 2)}\n`);
}

/** Registers a project dir (realpath; existing dir); returns the existing entry on a duplicate. */
export async function addProject(dir, env = process.env) {
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
  await saveConfig(config, env);
  return project;
}

/** Removes a project and its per-project plugin list; true when something was removed. */
export async function removeProject(key, env = process.env) {
  if (!PROJECT_KEY.test(key)) throw Object.assign(new Error('invalid project key'), { code: 'EINVAL' });
  const { config } = await loadConfig(env);
  const before = config.projects.length;
  config.projects = config.projects.filter((p) => p.key !== key);
  delete config.plugins.perProject[key];
  if (config.projects.length === before) return false;
  await saveConfig(config, env);
  return true;
}

export async function listProjects(env = process.env) {
  return (await loadConfig(env)).config.projects;
}

/**
 * Merges a settings patch (every top-level key except `projects`; object groups merge one level deep,
 * `plugins.perProject` is replaced as a whole) and saves it. Throws EINVAL on any invalid or unknown value.
 */
export async function updateSettings(patch, env = process.env) {
  const bad = (m) => Object.assign(new Error(m), { code: 'EINVAL' });
  if (!isPlainObject(patch)) throw bad('settings must be an object');
  if (hasOwn(patch, 'projects')) throw bad('projects are managed with nika projects add|remove');
  if (patch.permissionMode === 'bypassPermissions') throw bad('bypassPermissions is never allowed');
  const { config } = await loadConfig(env);
  const next = { ...config };
  for (const k of Object.keys(patch)) {
    const node = SCHEMA[k];
    next[k] = node && typeof node !== 'function' && isPlainObject(patch[k]) && isPlainObject(config[k]) ? { ...config[k], ...patch[k] } : patch[k];
  }
  await saveConfig(next, env);
  return (await loadConfig(env)).config;
}
