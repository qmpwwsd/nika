// 0.5.4 RM: nika's own list of removed sessions and folders, ${stateDir}/hidden.json (src/hidden.js, design-053-rm 1.2).
// Every test runs in its own temp state dir; nothing outside it is read or written. Ids are built at runtime and the literals are synthetic
// (repeated digits), so test/hygiene.test.js passes.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readHidden, listHidden, hideSession, unhideSession, hideGroup, unhideGroup, hiddenGeneration, HIDDEN_FILE, MAX_ENTRIES, MAX_AGE_MS,
} from '../src/hidden.js';
import { UUID, PROJECT_KEY } from '../src/ids.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const DAY = 86_400_000;
const uid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const key = (n) => `k${String(n).padStart(15, '0')}`;
const A = uid(1);
const B = uid(2);
const C = uid(3);
const KA = key(1);
const KB = key(2);

const made = [];
function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-hidden-'));
  made.push(root);
  const env = { XDG_STATE_HOME: root };
  return { root, env, dir: path.join(root, 'nika'), file: path.join(root, 'nika', HIDDEN_FILE) };
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

const writeDoc = (t, doc) => {
  fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(t.file, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode: 0o600 });
};
const doc = (sessions, groups) => ({ v: 1, sessions, ...(groups === undefined ? {} : { groups }) });
const raw = (t) => JSON.parse(fs.readFileSync(t.file, 'utf8'));
const warnings = () => {
  const list = [];
  const warn = (m) => list.push(m);
  warn.list = list;
  return warn;
};
const ids = (h) => [...h.sessions.keys()];
const keys = (h) => [...h.groups.keys()];

describe('the ids used here match the shapes', () => {
  test('(+) uid() is a session id and key() a project key', () => {
    assert.ok(UUID.test(A) && PROJECT_KEY.test(KA));
  });
});

describe('hideSession / readHidden / listHidden', () => {
  test('(+) hide, then read: the id is hidden; the file holds { v: 1, sessions, groups } and nothing else (no name, no path)', async () => {
    const t = fresh();
    assert.deepEqual(await hideSession(A, t.env, { now: NOW }), { dropped: 0 });
    const h = await readHidden(t.env, NOW);
    assert.deepEqual(ids(h), [A]);
    assert.deepEqual(keys(h), []);
    assert.equal(h.sessions.get(A), NOW);
    assert.deepEqual(raw(t), { v: 1, sessions: { [A]: { at: NOW } }, groups: {} });
  });

  test('(+) the file is 0600 and its folder 0700', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW });
    assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
  });

  test('(+) listHidden is newest first, per kind, with the hide time', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 3000 });
    await hideSession(C, t.env, { now: NOW - 1000 });
    await hideSession(B, t.env, { now: NOW - 2000 });
    await hideGroup(KA, t.env, { now: NOW - 500 });
    await hideGroup(KB, t.env, { now: NOW - 400 });
    assert.deepEqual(await listHidden(t.env, NOW), {
      sessions: [{ id: C, at: NOW - 1000 }, { id: B, at: NOW - 2000 }, { id: A, at: NOW - 3000 }],
      groups: [{ key: KB, at: NOW - 400 }, { key: KA, at: NOW - 500 }],
    });
  });

  test('(+) hiding an id twice keeps one entry with the newer time', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 5000 });
    await hideSession(A, t.env, { now: NOW });
    assert.deepEqual((await listHidden(t.env, NOW)).sessions, [{ id: A, at: NOW }]);
  });

  test('(+) an entry older than 90 days is ignored on read and dropped by the next write', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - MAX_AGE_MS - 1 });
    assert.deepEqual(ids(await readHidden(t.env, NOW)), [], 'ignored on read, the file is not touched');
    assert.ok(fs.readFileSync(t.file, 'utf8').includes(A));
    assert.deepEqual(await hideSession(B, t.env, { now: NOW }), { dropped: 1 });
    assert.deepEqual(Object.keys(raw(t).sessions), [B]);
  });

  test('(+) exactly 90 days old still counts, for a session and for a folder', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - MAX_AGE_MS });
    await hideGroup(KA, t.env, { now: NOW - MAX_AGE_MS });
    const h = await readHidden(t.env, NOW);
    assert.deepEqual([ids(h), keys(h)], [[A], [KA]]);
  });

  test('(+) sessions and folders are read from a valid file, `at` up to one day ahead counts, a file with only `sessions` is valid', async () => {
    const t = fresh();
    writeDoc(t, doc({ [A]: { at: NOW - 1000 }, [B]: { at: NOW + DAY } }, { [KA]: { at: NOW - 2000 } }));
    const warn = warnings();
    const h = await readHidden(t.env, NOW, { warn });
    assert.deepEqual([ids(h).sort(), keys(h)], [[A, B], [KA]]);
    assert.deepEqual(warn.list, []);
    writeDoc(t, doc({ [A]: { at: NOW } }));
    const only = await readHidden(t.env, NOW, { warn });
    assert.deepEqual([ids(only), keys(only), warn.list], [[A], [], []]);
  });

  test('(+) a write drops the entries whose session runs in a tmux pane nika sees', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 2000 });
    await hideSession(B, t.env, { now: NOW - 1000 });
    const r = await hideSession(C, t.env, { now: NOW, liveInTmux: new Set([A]) });
    assert.deepEqual(r, { dropped: 1 });
    assert.deepEqual(ids(await readHidden(t.env, NOW)).sort(), [B, C].sort());
  });

  test('(+) the id being hidden is not stored when it runs in a tmux pane (it would show anyway)', async () => {
    const t = fresh();
    assert.deepEqual(await hideSession(A, t.env, { now: NOW, liveInTmux: new Set([A]) }), { dropped: 1 });
    assert.deepEqual(ids(await readHidden(t.env, NOW)), []);
  });

  test('(+) a folder entry is not touched by the tmux prune (only sessions are pruned)', async () => {
    const t = fresh();
    await hideGroup(KA, t.env, { now: NOW - 1000 });
    await hideSession(A, t.env, { now: NOW, liveInTmux: new Set([A]) });
    assert.deepEqual(keys(await readHidden(t.env, NOW)), [KA]);
  });

  test('(+) writes in parallel keep every id (they run one after the other)', async () => {
    const t = fresh();
    await Promise.all([hideSession(A, t.env, { now: NOW }), hideSession(B, t.env, { now: NOW + 1 }), hideGroup(KA, t.env, { now: NOW + 2 }), hideSession(C, t.env, { now: NOW + 3 })]);
    const h = await readHidden(t.env, NOW + 3);
    assert.deepEqual(ids(h).sort(), [A, B, C].sort());
    assert.deepEqual(keys(h), [KA]);
  });

  test('(+) a write that fails does not block the next one', async () => {
    const t = fresh();
    await assert.rejects(hideSession('nope', t.env, { now: NOW }), { code: 'EINVAL' });
    await hideSession(A, t.env, { now: NOW });
    assert.deepEqual(ids(await readHidden(t.env, NOW)), [A]);
  });

  test('(\u2212) a missing file is empty, with no warning and no file created by a read', async () => {
    const t = fresh();
    const warn = warnings();
    const h = await readHidden(t.env, NOW, { warn });
    assert.deepEqual([ids(h), keys(h), warn.list], [[], [], []]);
    assert.equal(fs.existsSync(t.dir), false);
  });

  test('(\u2212) hideSession refuses an id that is not a session uuid and writes nothing; the generation does not move', async () => {
    const t = fresh();
    const gen = hiddenGeneration();
    for (const bad of ['', 'x', '../etc', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', `${A}x`, null, undefined, 7]) {
      await assert.rejects(hideSession(bad, t.env, { now: NOW }), { code: 'EINVAL' }, String(bad));
    }
    assert.equal(fs.existsSync(t.file), false);
    assert.equal(hiddenGeneration(), gen);
  });
});

describe('hideGroup', () => {
  test('(+) writes groups[key] = { at }; the session map is kept; a second hide re-stamps `at`', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 9000 });
    assert.deepEqual(await hideGroup(KA, t.env, { now: NOW - 5000 }), { dropped: 0 });
    assert.deepEqual(raw(t), { v: 1, sessions: { [A]: { at: NOW - 9000 } }, groups: { [KA]: { at: NOW - 5000 } } });
    await hideGroup(KA, t.env, { now: NOW });
    assert.deepEqual(raw(t).groups, { [KA]: { at: NOW } });
    assert.equal(fs.statSync(t.file).mode & 0o777, 0o600);
  });

  test('(+) 500 stored + 1 hide: the raw file has exactly 500 keys across both kinds and the oldest is gone', async () => {
    const t = fresh();
    const sessions = {};
    const groups = {};
    for (let n = 1; n <= 300; n += 1) sessions[uid(n)] = { at: NOW - 100_000 + n };
    for (let n = 1; n <= 200; n += 1) groups[key(n)] = { at: NOW - 100_000 + 1000 + n };
    writeDoc(t, doc(sessions, groups));
    const h = await readHidden(t.env, NOW);
    assert.equal(h.sessions.size + h.groups.size, MAX_ENTRIES);
    const r = await hideGroup(key(9999), t.env, { now: NOW });
    assert.deepEqual(r, { dropped: 1 });
    const file = raw(t);
    assert.equal(Object.keys(file.sessions).length + Object.keys(file.groups).length, MAX_ENTRIES, 'the raw file, not a read-back (a read cuts too)');
    assert.ok(!(uid(1) in file.sessions), 'the oldest entry went');
    assert.ok(uid(2) in file.sessions && key(9999) in file.groups);
  });

  test('(+) a file with more than 500 entries reads as the newest 500, shared by both kinds', async () => {
    const t = fresh();
    const sessions = {};
    const groups = {};
    for (let n = 1; n <= 300; n += 1) sessions[uid(n)] = { at: NOW - 100_000 + n };
    for (let n = 1; n <= 220; n += 1) groups[key(n)] = { at: NOW - 100_000 + 1000 + n };
    writeDoc(t, doc(sessions, groups));
    const h = await readHidden(t.env, NOW);
    assert.equal(h.sessions.size + h.groups.size, MAX_ENTRIES);
    assert.ok(!h.sessions.has(uid(1)), 'the oldest session went');
    assert.ok(h.groups.has(key(220)));
  });

  test('(+) the 500 entries of the longest shape serialise to under 64 KiB (the read cap never cuts a file nika wrote)', async () => {
    const t = fresh();
    const sessions = {};
    for (let n = 1; n <= MAX_ENTRIES; n += 1) sessions[uid(n)] = { at: NOW - 100_000 + n };
    writeDoc(t, doc(sessions, {}));
    await hideGroup(KA, t.env, { now: NOW }); // rewrites through save(): 500 entries, the longest kind
    const bytes = fs.statSync(t.file).size;
    assert.ok(bytes < 64 * 1024, `${bytes} bytes`);
    assert.ok(bytes < 40 * 1024, `about 30 KB expected, got ${bytes}`);
    const h = await readHidden(t.env, NOW, { warn: warnings() });
    assert.equal(h.sessions.size + h.groups.size, MAX_ENTRIES, 'and it reads back whole');
  });

  test('(\u2212) a key that is not a project key is refused and writes nothing', async () => {
    const t = fresh();
    const gen = hiddenGeneration();
    for (const bad of ['../x', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0', '', null, undefined, 7, A]) {
      await assert.rejects(hideGroup(bad, t.env, { now: NOW }), { code: 'EINVAL' }, String(bad));
    }
    assert.equal(fs.existsSync(t.file), false);
    assert.equal(hiddenGeneration(), gen);
  });
});

describe('unhideSession / unhideGroup', () => {
  test('(+) removes the entry and keeps the others', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW });
    await hideSession(B, t.env, { now: NOW });
    await hideGroup(KA, t.env, { now: NOW });
    await hideGroup(KB, t.env, { now: NOW });
    await unhideSession(A, t.env, { now: NOW });
    await unhideGroup(KA, t.env, { now: NOW });
    const h = await readHidden(t.env, NOW);
    assert.deepEqual([ids(h), keys(h)], [[B], [KB]]);
  });

  test('(+) an unhide that writes moves the generation by one', async () => {
    const t = fresh();
    await hideGroup(KA, t.env, { now: NOW });
    const gen = hiddenGeneration();
    await unhideGroup(KA, t.env, { now: NOW });
    assert.equal(hiddenGeneration(), gen + 1);
  });

  test('(+) an expired entry is dropped when an unhide writes', async () => {
    const t = fresh();
    writeDoc(t, doc({ [A]: { at: NOW - MAX_AGE_MS - 5 }, [B]: { at: NOW - 1000 } }, { [KA]: { at: NOW - MAX_AGE_MS - 5 } }));
    await unhideSession(B, t.env, { now: NOW });
    assert.deepEqual(raw(t), { v: 1, sessions: {}, groups: {} });
  });

  test('(+) an expired entry is dropped when an unhide of an id that was not stored writes (the file is cleaned, the generation moves)', async () => {
    const t = fresh();
    writeDoc(t, doc({ [A]: { at: NOW - MAX_AGE_MS - 5 } }, { [KA]: { at: NOW - MAX_AGE_MS - 5 } }));
    const before = hiddenGeneration();
    await unhideSession(B, t.env, { now: NOW });
    assert.deepEqual(raw(t), { v: 1, sessions: {}, groups: {} });
    assert.equal(hiddenGeneration(), before + 1);
  });

  test('(\u2212) an id or key that was not stored is fine and writes nothing (mtime and generation unchanged)', async () => {
    const t = fresh();
    await unhideSession(A, t.env, { now: NOW });
    await unhideGroup(KA, t.env, { now: NOW });
    assert.equal(fs.existsSync(t.file), false);
    await hideSession(B, t.env, { now: NOW });
    const before = fs.readFileSync(t.file, 'utf8');
    const mtime = fs.statSync(t.file).mtimeMs;
    const gen = hiddenGeneration();
    await unhideSession(A, t.env, { now: NOW });
    await unhideGroup(KA, t.env, { now: NOW });
    assert.equal(fs.readFileSync(t.file, 'utf8'), before);
    assert.equal(fs.statSync(t.file).mtimeMs, mtime);
    assert.equal(hiddenGeneration(), gen);
  });

  test('(\u2212) a shape that does not fit is refused', async () => {
    const t = fresh();
    await assert.rejects(unhideSession('nope', t.env, { now: NOW }), { code: 'EINVAL' });
    await assert.rejects(unhideSession(KA, t.env, { now: NOW }), { code: 'EINVAL' });
    await assert.rejects(unhideGroup(A, t.env, { now: NOW }), { code: 'EINVAL' });
    await assert.rejects(unhideGroup('../x', t.env, { now: NOW }), { code: 'EINVAL' });
  });
});

describe('every write drops the session entries that run in a tmux pane nika sees (rule R11; fix round 1)', () => {
  const live = () => new Set([A]);

  test('(+) hideGroup prunes them, counts them and keeps the others', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 2000 });
    await hideSession(B, t.env, { now: NOW - 1000 });
    assert.deepEqual(await hideGroup(KA, t.env, { now: NOW, liveInTmux: live() }), { dropped: 1 });
    assert.deepEqual(raw(t), { v: 1, sessions: { [B]: { at: NOW - 1000 } }, groups: { [KA]: { at: NOW } } });
  });

  test('(+) unhideSession prunes them besides removing its own entry', async () => {
    const t = fresh();
    for (const [id, at] of [[A, 3000], [B, 2000], [C, 1000]]) await hideSession(id, t.env, { now: NOW - at });
    await unhideSession(B, t.env, { now: NOW, liveInTmux: live() });
    assert.deepEqual(ids(await readHidden(t.env, NOW)), [C]);
  });

  test('(+) unhideGroup prunes them besides removing its own entry', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 3000 });
    await hideSession(B, t.env, { now: NOW - 2000 });
    await hideGroup(KA, t.env, { now: NOW - 1000 });
    await unhideGroup(KA, t.env, { now: NOW, liveInTmux: live() });
    assert.deepEqual(raw(t), { v: 1, sessions: { [B]: { at: NOW - 2000 } }, groups: {} });
  });

  test('(+) an unhide of something that was not stored still writes when it pruned, and the generation moves once', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 1000 });
    const g0 = hiddenGeneration();
    await unhideSession(C, t.env, { now: NOW, liveInTmux: live() });
    assert.deepEqual(raw(t), { v: 1, sessions: {}, groups: {} });
    assert.equal(hiddenGeneration(), g0 + 1);
    await hideSession(A, t.env, { now: NOW - 1000 });
    const g1 = hiddenGeneration();
    await unhideGroup(KB, t.env, { now: NOW, liveInTmux: live() });
    assert.deepEqual(raw(t), { v: 1, sessions: {}, groups: {} });
    assert.equal(hiddenGeneration(), g1 + 1);
  });

  test('(\u2212) a session that runs in a pane but is not stored costs no write; a folder entry is never pruned by an unhide', async () => {
    const t = fresh();
    await hideSession(B, t.env, { now: NOW - 2000 });
    await hideGroup(KA, t.env, { now: NOW - 1000 });
    const before = fs.statSync(t.file).mtimeMs;
    const g0 = hiddenGeneration();
    await unhideSession(C, t.env, { now: NOW, liveInTmux: live() });
    await unhideGroup(KB, t.env, { now: NOW, liveInTmux: live() });
    assert.equal(hiddenGeneration(), g0, 'nothing pruned, nothing stored: no write');
    assert.equal(fs.statSync(t.file).mtimeMs, before);
    await unhideSession(B, t.env, { now: NOW, liveInTmux: live() });
    assert.deepEqual(keys(await readHidden(t.env, NOW)), [KA]);
  });

  test('(\u2212) without a liveInTmux set nothing is pruned (the default is empty)', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW - 2000 });
    await hideSession(B, t.env, { now: NOW - 1000 });
    await hideGroup(KA, t.env, { now: NOW });
    await unhideGroup(KB, t.env, { now: NOW });
    await unhideSession(C, t.env, { now: NOW });
    assert.deepEqual(ids(await readHidden(t.env, NOW)).sort(), [A, B].sort());
  });
});

describe('a file someone else wrote', () => {
  test('(\u2212) bad JSON, a wrong version, an array, a non-object sessions or groups: ignored with a warning, never a throw', async () => {
    const bads = ['{not json', JSON.stringify({ v: 2, sessions: {} }), JSON.stringify([]), JSON.stringify({ v: 1, sessions: [] }), JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 1, sessions: {}, groups: [] }), JSON.stringify({ v: 1, sessions: {}, groups: 'x' }), JSON.stringify({ v: '1', sessions: {} }), '', 'null'];
    for (const bad of bads) {
      const t = fresh();
      writeDoc(t, bad);
      const warn = warnings();
      const h = await readHidden(t.env, NOW, { warn });
      assert.deepEqual([ids(h), keys(h)], [[], []], bad);
      assert.equal(warn.list.length, 1, bad);
      assert.deepEqual(await listHidden(t.env, NOW, { warn }), { sessions: [], groups: [] }, bad);
    }
  });

  test('(\u2212) a wrong version is the unknown-shape warning (the `v` check is what rejects it)', async () => {
    const t = fresh();
    writeDoc(t, { v: 2, sessions: { [A]: { at: NOW } } });
    const warn = warnings();
    assert.deepEqual(ids(await readHidden(t.env, NOW, { warn })), []);
    assert.deepEqual(warn.list, ['hidden.json has an unknown shape, ignored']);
  });

  test('(\u2212) a key of the wrong shape, `at` in the future, a string, a float, a non-object entry: that entry is ignored, the rest kept', async () => {
    const t = fresh();
    writeDoc(t, doc({
      [A]: { at: NOW - 1000 }, 'not-a-uuid': { at: NOW }, [B]: { at: NOW + 2 * DAY }, [C]: { at: String(NOW) },
      [uid(4)]: { at: NOW + 0.5 }, [uid(5)]: 7, [uid(6)]: null, [KA]: { at: NOW },
    }, {
      [KB]: { at: NOW - 2000 }, [A]: { at: NOW }, 'NOT-A-KEY': { at: NOW }, [key(3)]: { at: NOW + 2 * DAY }, [key(4)]: { at: 1.5 },
    }));
    const warn = warnings();
    const h = await readHidden(t.env, NOW, { warn });
    assert.deepEqual([ids(h), keys(h)], [[A], [KB]]);
    assert.deepEqual(warn.list, ['hidden.json: 11 invalid entries ignored']);
  });

  test('(\u2212) `at` of -1 is invalid, not expired: one warning that says so (a mutant that counts it as expired stays silent)', async () => {
    const t = fresh();
    writeDoc(t, doc({ [A]: { at: -1 } }));
    const warn = warnings();
    assert.deepEqual(ids(await readHidden(t.env, NOW, { warn })), []);
    assert.deepEqual(warn.list, ['hidden.json: 1 invalid entry ignored']);
    const g = fresh();
    writeDoc(g, doc({}, { [KA]: { at: -1 } }));
    const gw = warnings();
    assert.deepEqual(keys(await readHidden(g.env, NOW, { warn: gw })), []);
    assert.deepEqual(gw.list, ['hidden.json: 1 invalid entry ignored']);
  });

  test('(\u2212) a file over 64 KiB is cut by the read cap and ignored as a whole', async () => {
    const t = fresh();
    const entries = {};
    for (let n = 1; n <= 1200; n += 1) entries[uid(n)] = { at: NOW - n };
    writeDoc(t, doc(entries));
    assert.ok(fs.statSync(t.file).size > 64 * 1024);
    const warn = warnings();
    assert.deepEqual(ids(await readHidden(t.env, NOW, { warn })), []);
    assert.equal(warn.list.length, 1);
  });

  test('(\u2212) a symlinked hidden.json is refused by the read (empty) and by the write (the error propagates, the target is untouched)', async () => {
    const t = fresh();
    fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const elsewhere = path.join(t.root, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify(doc({ [A]: { at: NOW } })));
    fs.symlinkSync(elsewhere, t.file);
    const warn = warnings();
    assert.deepEqual(ids(await readHidden(t.env, NOW, { warn })), []);
    assert.equal(warn.list.length, 1);
    const gen = hiddenGeneration();
    await assert.rejects(hideSession(B, t.env, { now: NOW, warn: warnings() }), (e) => e.code === 'ESYMLINK');
    await assert.rejects(hideGroup(KA, t.env, { now: NOW, warn: warnings() }), (e) => e.code === 'ESYMLINK');
    assert.deepEqual(JSON.parse(fs.readFileSync(elsewhere, 'utf8')), doc({ [A]: { at: NOW } }));
    assert.equal(hiddenGeneration(), gen, 'a failed write does not move the generation');
  });

  test('(\u2212) a hard-linked hidden.json is refused too', async () => {
    const t = fresh();
    fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    const other = path.join(t.root, 'other.json');
    fs.writeFileSync(other, JSON.stringify(doc({ [A]: { at: NOW } })));
    fs.linkSync(other, t.file);
    assert.deepEqual(ids(await readHidden(t.env, NOW, { warn: warnings() })), []);
    await assert.rejects(hideSession(B, t.env, { now: NOW }));
  });

  test('(\u2212) a state dir that cannot be created makes the write throw, not the read; the generation does not move', async () => {
    const t = fresh();
    fs.writeFileSync(path.join(t.root, 'nika'), 'a file where the folder should be');
    assert.deepEqual(ids(await readHidden(t.env, NOW, { warn: warnings() })), []);
    const gen = hiddenGeneration();
    await assert.rejects(hideSession(A, t.env, { now: NOW }));
    await assert.rejects(hideGroup(KA, t.env, { now: NOW }));
    assert.equal(hiddenGeneration(), gen);
  });

  test('(\u2212) the default warning is printed once per distinct message, not once per read', async () => {
    const t = fresh();
    writeDoc(t, '{not json');
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    try {
      await readHidden(t.env, NOW);
      await readHidden(t.env, NOW);
      await readHidden(t.env, NOW);
    } finally {
      console.error = orig;
    }
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('nika: '));
    assert.ok(!lines[0].includes(t.root), 'no path in the warning');
  });
});

describe('readHidden without an env (0.1 callers: a config with no env reads no file)', () => {
  test('(\u2212) env undefined, null, a string or an array: empty, and the real state dir (process.env) is not read', async () => {
    const t = fresh();
    writeDoc(t, doc({ [A]: { at: NOW } }, { [KA]: { at: NOW } }));
    const had = process.env.XDG_STATE_HOME;
    const hadHome = process.env.HOME;
    // a string or an array env makes stateDir() fall back to os.homedir()/.local/state, not to process.env: a guard weakened to `env == null` would read
    // this stand-in HOME (fix round 1: the XDG_STATE_HOME file above cannot show that read)
    const home = fresh();
    const homeState = path.join(home.root, '.local', 'state', 'nika');
    fs.mkdirSync(homeState, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(homeState, HIDDEN_FILE), JSON.stringify(doc({ [A]: { at: NOW } }, { [KA]: { at: NOW } })), { mode: 0o600 });
    process.env.XDG_STATE_HOME = t.root; // what a fall-back to process.env would read
    process.env.HOME = home.root;
    try {
      assert.deepEqual(ids(await readHidden({}, NOW)), [A], 'the stand-in HOME file is readable through an env object with no XDG_STATE_HOME, so the trap is real');
      for (const env of [undefined, null, 'x', ['y'], 7]) {
        const warn = warnings();
        const h = await readHidden(env, NOW, { warn });
        assert.deepEqual([ids(h), keys(h), warn.list], [[], [], []], String(env));
        assert.deepEqual(await listHidden(env, NOW, { warn }), { sessions: [], groups: [] }, String(env));
      }
      assert.deepEqual(ids(await readHidden(t.env, NOW)), [A], 'the same file is read through an env that is an object');
    } finally {
      if (had === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = had;
      if (hadHome === undefined) delete process.env.HOME;
      else process.env.HOME = hadHome;
    }
  });
});

describe('hiddenGeneration', () => {
  test('(+) goes up by one after every successful write, session or folder', async () => {
    const t = fresh();
    const g0 = hiddenGeneration();
    await hideSession(A, t.env, { now: NOW });
    await hideGroup(KA, t.env, { now: NOW });
    assert.equal(hiddenGeneration(), g0 + 2);
  });

  test('(\u2212) a read does not move it', async () => {
    const t = fresh();
    await hideSession(A, t.env, { now: NOW });
    const g = hiddenGeneration();
    await readHidden(t.env, NOW);
    await listHidden(t.env, NOW);
    assert.equal(hiddenGeneration(), g);
  });
});
