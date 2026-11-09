// nika's own config (`configDir()/config.json`, 0600) and project registry (ADR 0006, 0008). The file is user-owned but
// lives in a dir agents can write to: loading never throws on garbage, it falls back to defaults and reports warnings.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './paths.js';
import { ensureDir, writeAtomic } from './fwrite.js';
import { readHead } from './fsafe.js';
import { clean } from './text.js';
import { PROJECT_KEY, UUID, MODEL_ID, RC_PREFIX, PLUGIN_NAME, PERMISSION_MODES, PANE_PLACEMENTS } from './ids.js';

const CONFIG_MAX = 256 * 1024;
const PLUGINS_MAX = 200;
const PROJECTS_MAX = 100;
const ROLES = ['orchestrator', 'reasoner', 'builder', 'scout']; // the keys of `models`, in the order the page lists them
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

/**
 * perProject: { <PROJECT_KEY>: { plugins?: string[], orchestratorSessionId?: UUID, models?: { <role>: MODEL_ID } } }. A bad key or an
 * entry that is not an object drops that entry; a bad plugin list drops just the list, a bad id just the id, a `models` that is not
 * an object just `models`, an unknown role or a bad model id just that role (each with a warning); other inner keys are dropped.
 * An entry that holds no non-empty plugin list, no id and no model is "none" and is not kept.
 */
function perProject(v, warn) {
  if (!isPlainObject(v)) return undefined;
  const out = {};
  for (const key of Object.keys(v)) {
    const at = `perProject.${clean(key, 40) ?? '?'}`;
    const entry = v[key];
    const plugins = isPlainObject(entry) && hasOwn(entry, 'plugins') ? pluginList(entry.plugins) : undefined;
    if (!isProjectKey(key) || !isPlainObject(entry)) {
      warn(`${at} dropped`);
      continue;
    }
    if (hasOwn(entry, 'plugins') && plugins === undefined) warn(`${at}.plugins invalid, dropped`);
    for (const k of Object.keys(entry)) if (k !== 'plugins' && k !== 'orchestratorSessionId' && k !== 'models') warn(`unknown key ${at}.${clean(k, 40) ?? '?'} dropped`);
    const id = hasOwn(entry, 'orchestratorSessionId') ? entry.orchestratorSessionId : undefined;
    const idOk = typeof id === 'string' && UUID.test(id);
    if (hasOwn(entry, 'orchestratorSessionId') && !idOk) warn(`${at}.orchestratorSessionId invalid, dropped`);
    const models = {};
    if (hasOwn(entry, 'models')) {
      if (!isPlainObject(entry.models)) warn(`${at}.models invalid, dropped`);
      else {
        for (const role of Object.keys(entry.models)) {
          if (!ROLES.includes(role)) warn(`unknown key ${at}.models.${clean(role, 40) ?? '?'} dropped`);
          else if (typeof entry.models[role] === 'string' && MODEL_ID.test(entry.models[role])) models[role] = entry.models[role];
          else warn(`${at}.models.${role} invalid, dropped`);
        }
      }
    }
    const hasModels = Object.keys(models).length > 0;
    if (plugins?.length || idOk || hasModels) {
      out[key] = { ...(plugins?.length ? { plugins } : {}), ...(idOk ? { orchestratorSessionId: id } : {}), ...(hasModels ? { models } : {}) };
    }
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

/** The Settings models with the project's own ids laid over them: what nika starts and renders for that project. Pure. */
export function effectiveModels(config, key) {
  return Object.fromEntries(ROLES.map((role) => [role, config.perProject?.[key]?.models?.[role] ?? config.models[role]]));
}

/** `{ plugins, models }` of one project: [] when no plugin is on; `models` always has the four roles, each an id or null. */
const projectConfig = (config, key) => ({
  plugins: config.perProject[key]?.plugins ?? [],
  models: Object.fromEntries(ROLES.map((role) => [role, config.perProject[key]?.models?.[role] ?? null])),
});

/** Throws EINVAL on a bad key. */
export async function getProjectConfig(key, env = process.env) {
  if (!isProjectKey(key)) throw bad('invalid project key');
  return projectConfig((await loadConfig(env)).config, key);
}

/** The ids of a `{ models }` patch that have a value, in role order; undefined unless it has exactly the four roles, each a MODEL_ID or null. */
function modelPatch(v) {
  const ok = isPlainObject(v) && Object.keys(v).length === ROLES.length && ROLES.every((r) => hasOwn(v, r) && (v[r] === null || (typeof v[r] === 'string' && MODEL_ID.test(v[r]))));
  return ok ? Object.fromEntries(ROLES.filter((r) => v[r] !== null).map((r) => [r, v[r]])) : undefined;
}

/**
 * Sets one project's config. The patch is exactly one of `{ plugins: string[] }` or `{ models: { orchestrator, reasoner, builder,
 * scout } }` (each a MODEL_ID, or null for "use the Settings default"), so the two dialogs never overwrite each other. `plugins: []`
 * and four nulls remove their list; the entry goes when nothing is left in it. Runs in the serial queue, so two pages saving
 * different projects cannot overwrite each other. Throws EINVAL (bad key or patch) or ENOENT (not a registered project); returns
 * the project's new `{ plugins, models }`.
 */
export function updateProjectConfig(key, patch, env = process.env) {
  return serial(async () => {
    if (!isProjectKey(key)) throw bad('invalid project key');
    // own keys only: an inherited or `__proto__` key never counts as `plugins` or `models`
    const field = isPlainObject(patch) && Object.keys(patch).length === 1 ? Object.keys(patch)[0] : null;
    if (field !== 'plugins' && field !== 'models') throw bad('patch must be { plugins: [...] } or { models: {...} }');
    const value = field === 'plugins' ? pluginList(patch.plugins) : modelPatch(patch.models);
    if (value === undefined) {
      throw bad(field === 'plugins' ? `plugins must be a list of at most ${PLUGINS_MAX} plugin names like name@marketplace` : 'models must have orchestrator, reasoner, builder and scout, each a model id or null');
    }
    const { config } = await loadConfig(env);
    if (!config.projects.some((p) => p.key === key)) throw Object.assign(new Error('project is not registered'), { code: 'ENOENT' });
    const entry = { ...config.perProject[key] };
    if (Object.keys(value).length) entry[field] = value;
    else delete entry[field];
    if (Object.keys(entry).length) config.perProject[key] = entry;
    else delete config.perProject[key];
    await writeConfig(config, env);
    return projectConfig(config, key);
  });
}

/** The project's saved orchestrator session id (a UUID), or null. Throws EINVAL on a bad key. */
export async function getOrchestrator(key, env = process.env) {
  if (!isProjectKey(key)) throw bad('invalid project key');
  return (await loadConfig(env)).config.perProject[key]?.orchestratorSessionId ?? null;
}

/**
 * Saves (a UUID) or forgets (null) the project's orchestrator session id; the plugin list beside it is untouched. Runs in the
 * serial queue. Throws EINVAL (bad key, or an id that is neither null nor a lowercase UUID) or ENOENT (not a registered project);
 * returns the new id or null.
 */
export function setOrchestrator(key, id, env = process.env) {
  return serial(async () => {
    if (!isProjectKey(key)) throw bad('invalid project key');
    if (id !== null && !(typeof id === 'string' && UUID.test(id))) throw bad('orchestrator must be a session id (a UUID) or null');
    const { config } = await loadConfig(env);
    if (!config.projects.some((p) => p.key === key)) throw Object.assign(new Error('project is not registered'), { code: 'ENOENT' });
    const entry = { ...config.perProject[key] };
    if (id) entry.orchestratorSessionId = id;
    else delete entry.orchestratorSessionId;
    if (Object.keys(entry).length) config.perProject[key] = entry;
    else delete config.perProject[key];
    await writeConfig(config, env);
    return id;
  });
}
