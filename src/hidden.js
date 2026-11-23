// nika's own list of sessions and folders the user removed from the lists (0.5.4, RM; design-053-rm 1.2): `${stateDir}/hidden.json`,
// `{ "v": 1, "sessions": { "<uuid>": { "at": <ms> } }, "groups": { "<project key>": { "at": <ms> } } }`, nothing else (no name, no path). The file
// is nika's own, but any local process of the user can edit it (rules/project-rules.md constraint 10), so it is read like every agent-writable
// file: through fsafe (no symlink, a regular single-link file owned by the user, 64 KiB at most) and parsed strictly. A bad file or entry is
// ignored with one warning, never a crash. Reads never write; writes go through fwrite (0600 file, 0700 folder, atomic) one after the other.
import path from 'node:path';
import { readHead } from './fsafe.js';
import { ensureDir, writeAtomic } from './fwrite.js';
import { stateDir } from './paths.js';
import { UUID, PROJECT_KEY } from './ids.js';

export const HIDDEN_FILE = 'hidden.json';
/** One cap for both maps together: the newest 500 entries. At about 60 bytes an entry that stays far under the 64 KiB read cap. */
export const MAX_ENTRIES = 500;
export const MAX_AGE_MS = 90 * 86_400_000;
const MAX_BYTES = 64 * 1024;
const FUTURE_MS = 86_400_000; // a clock that runs a day ahead still counts

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The default warning goes to stderr (the brew services log), once per distinct message: the snapshot reads this file every few seconds.
let lastWarning = null;
function defaultWarn(message) {
  if (message === lastWarning) return;
  lastWarning = message;
  console.error(`nika: ${message}`);
}

// Counts every successful write of this process. The server's snapshot cache stores the value it was made under, so a Remove or an Undo is
// seen by the very next request instead of after the cache's time to live (design-053-rm 4.5).
let generation = 0;
/** How many writes of hidden.json this process has finished. A read never moves it, and neither does a write that failed. */
export const hiddenGeneration = () => generation;

const bad = (what) => Object.assign(new Error(`not a ${what}`), { code: 'EINVAL' });
const badId = (id) => (typeof id !== 'string' || !UUID.test(id) ? bad('session id') : null);
const badKey = (k) => (typeof k !== 'string' || !PROJECT_KEY.test(k) ? bad('project key') : null);

const newest = (a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Both maps cut to the newest MAX_ENTRIES entries in total: `{ sessions: Map, groups: Map, cut }`. */
function capped(sessions, groups) {
  const all = [
    ...[...sessions].map(([key, at]) => ({ kind: 'sessions', key, at })),
    ...[...groups].map(([key, at]) => ({ kind: 'groups', key, at })),
  ].sort(newest);
  const out = { sessions: new Map(), groups: new Map(), cut: Math.max(0, all.length - MAX_ENTRIES) };
  for (const e of all.slice(0, MAX_ENTRIES)) out[e.kind].set(e.key, e.at);
  return out;
}

/**
 * The valid, unexpired entries: `{ sessions: Map(id -> at), groups: Map(key -> at), expired, cut }`, both maps newest first. `expired`: entries older
 * than 90 days; `cut`: entries beyond the newest 500 of both maps together. A missing file is empty and silent; anything else that does not parse
 * is empty with one warning.
 */
async function load(env, now, warn) {
  const empty = () => ({ sessions: new Map(), groups: new Map(), expired: 0, cut: 0 });
  let text;
  try {
    text = await readHead(path.join(stateDir(env), HIDDEN_FILE), MAX_BYTES);
  } catch (err) {
    if (err?.code !== 'ENOENT') warn(`${HIDDEN_FILE} cannot be read (${err?.code ?? 'error'}), ignored`);
    return empty();
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    warn(`${HIDDEN_FILE} is not valid JSON, ignored`);
    return empty();
  }
  if (!isPlain(doc) || doc.v !== 1 || !isPlain(doc.sessions) || (doc.groups !== undefined && !isPlain(doc.groups))) {
    warn(`${HIDDEN_FILE} has an unknown shape, ignored`);
    return empty();
  }
  const sessions = new Map();
  const groups = new Map();
  let expired = 0;
  let invalid = 0;
  const take = (into, shape, entries) => {
    for (const [k, entry] of Object.entries(entries ?? {})) {
      const at = isPlain(entry) ? entry.at : undefined;
      if (!shape.test(k) || !Number.isSafeInteger(at) || at < 0 || at > now + FUTURE_MS) invalid += 1;
      else if (now - at > MAX_AGE_MS) expired += 1;
      else into.set(k, at);
    }
  };
  take(sessions, UUID, doc.sessions);
  take(groups, PROJECT_KEY, doc.groups);
  if (invalid) warn(`${HIDDEN_FILE}: ${invalid} invalid ${invalid === 1 ? 'entry' : 'entries'} ignored`);
  const kept = capped(sessions, groups);
  return { sessions: kept.sessions, groups: kept.groups, expired, cut: kept.cut };
}

/**
 * What is hidden now: `{ sessions: Map(id -> at), groups: Map(key -> at) }`. Never writes; `opts.warn(message)` replaces the default warning (tests).
 * An `env` that is not a plain object (a config without one: tests, 0.1 callers) reads nothing at all: it never falls back to `process.env`, so
 * such a caller cannot reach the real state folder.
 */
export async function readHidden(env, now, { warn = defaultWarn } = {}) {
  if (!isPlain(env)) return { sessions: new Map(), groups: new Map() };
  const { sessions, groups } = await load(env, now, warn);
  return { sessions, groups };
}

/** What is hidden, newest first: `{ sessions: [{ id, at }], groups: [{ key, at }] }` (`at` = when it was removed, ms). Never writes. */
export async function listHidden(env, now, opts) {
  const { sessions, groups } = await readHidden(env, now, opts);
  return { sessions: [...sessions].map(([id, at]) => ({ id, at })), groups: [...groups].map(([key, at]) => ({ key, at })) };
}

// Writes run one after the other (a failed one must not block the next)
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function save(env, { sessions, groups }) {
  const body = {
    v: 1,
    sessions: Object.fromEntries([...sessions].map(([id, at]) => [id, { at }])),
    groups: Object.fromEntries([...groups].map(([k, at]) => [k, { at }])),
  };
  const dir = await ensureDir(stateDir(env));
  await writeAtomic(dir, HIDDEN_FILE, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  generation += 1; // after the rename only: a failed write changed nothing
}

/** Drops the session entries that run in a tmux pane nika sees (`liveInTmux`, a Set of session ids; a row in a pane always shows). Returns how many it dropped. */
function pruneLive(sessions, liveInTmux) {
  let pruned = 0;
  for (const id of [...sessions.keys()]) {
    if (liveInTmux.has(id)) {
      sessions.delete(id);
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * Adds one entry as of `now`: read, set it, drop what expired, drop the session entries that run in a tmux pane nika sees (`pruneLive`), keep the newest 500
 * of both maps, write. Resolves `{ dropped }`: the entries the write removed besides the one asked for. Rejects with the fwrite error when the file or its
 * folder is not safe to write (a symlink, a hard link).
 */
function add(kind, value, env, { now, liveInTmux, warn }) {
  return serial(async () => {
    const { sessions, groups, expired, cut } = await load(env, now, warn);
    (kind === 'sessions' ? sessions : groups).set(value, now);
    let dropped = expired + cut;
    dropped += pruneLive(sessions, liveInTmux);
    const kept = capped(sessions, groups);
    dropped += kept.cut;
    await save(env, kept);
    return { dropped };
  });
}

/** Removes one entry and, like every write, the session entries that run in a tmux pane nika sees. Nothing is written when it removed nothing and nothing expired. */
function drop(kind, value, env, { now, liveInTmux, warn }) {
  return serial(async () => {
    const loaded = await load(env, now, warn);
    const had = loaded[kind].delete(value);
    const pruned = pruneLive(loaded.sessions, liveInTmux);
    if (had || pruned > 0 || loaded.expired > 0 || loaded.cut > 0) await save(env, loaded);
  });
}

/** Removes the session `id` from the lists as of `now` (see `add`). */
export function hideSession(id, env, { now = Date.now(), liveInTmux = new Set(), warn = defaultWarn } = {}) {
  const refused = badId(id);
  return refused ? Promise.reject(refused) : add('sessions', id, env, { now, liveInTmux, warn });
}

/** Removes the folder `key` (a group key of nika's snapshot) from the lists as of `now` (see `add`). A second call re-stamps `at`. */
export function hideGroup(key, env, { now = Date.now(), liveInTmux = new Set(), warn = defaultWarn } = {}) {
  const refused = badKey(key);
  return refused ? Promise.reject(refused) : add('groups', key, env, { now, liveInTmux, warn });
}

/** Shows `id` again (and, like every write, drops the entries in `liveInTmux`). Nothing is written when it removed nothing and nothing expired. */
export function unhideSession(id, env, { now = Date.now(), liveInTmux = new Set(), warn = defaultWarn } = {}) {
  const refused = badId(id);
  return refused ? Promise.reject(refused) : drop('sessions', id, env, { now, liveInTmux, warn });
}

/** Shows the folder `key` again (and, like every write, drops the entries in `liveInTmux`). Nothing is written when it removed nothing and nothing expired. */
export function unhideGroup(key, env, { now = Date.now(), liveInTmux = new Set(), warn = defaultWarn } = {}) {
  const refused = badKey(key);
  return refused ? Promise.reject(refused) : drop('groups', key, env, { now, liveInTmux, warn });
}
