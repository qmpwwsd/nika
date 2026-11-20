// 0.5.4 RM: the five routes that remove sessions and folders from the lists (src/hidden-routes.js, mounted by src/api-app.js; design-053-rm 4.1, 4.3).
// A real server on 127.0.0.1:0 with the app handler, injected fake modules, and the real hidden.json and config.json in temp dirs. Synthetic data only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createAppApi } from '../src/api-app.js';
import { stateDir } from '../src/paths.js';
import { readHidden, hideSession, hideGroup, HIDDEN_FILE } from '../src/hidden.js';
import { keyFor } from '../src/store.js';
import { makeWorld } from './tmux-fake.js';

const SECRET = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9v'.slice(0, 43);
const SOURCES_OK = { registry: 'ok', processes: 'ok', transcripts: 'ok', tmux: 'ok', reports: 'ok' };
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const DAY = 86_400_000;
const uid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const E1 = uid(1); // ended
const S1 = uid(2); // live, no pane (stuck)
const P1 = uid(3); // live, in a tmux pane
const E2 = uid(4); // ended, of the registered project
const HOST = uid(5); // a host id: the row that continues it has another id
const CHILD = uid(6);
const GONE = uid(7); // nika knows no transcript for it
const BADINDEX = uid(8); // findSession throws EINDEX for it
const KEY_A = keyFor('/tmp/nika-test/demo');
const KEY_U = keyFor('(unknown)');
const ROOT_A = '/tmp/nika-test/demo';

const w = await makeWorld();
after(() => w.cleanup());

const agent = (id, o = {}) => ({ id, name: `name-${id.slice(0, 2)}`, title: null, live: false, pane: null, hostId: null, ...o });
const GROUP_A = { key: KEY_A, label: 'demo', root: ROOT_A, agents: [agent(E1), agent(S1, { live: true }), agent(P1, { live: true, pane: { id: '%6' } }), agent(CHILD, { live: true, hostId: HOST })] };
const GROUP_R = { key: w.project.key, label: 'my-app', root: w.project.dir, agents: [agent(E2)] };
const GROUP_BY_ROOT = { key: 'b'.repeat(16), label: 'my-app-2', root: w.project.dir, agents: [agent(uid(9))] };
const GROUP_U = { key: KEY_U, label: '(unknown)', root: null, agents: [agent(uid(10))] };
const FOLDERS = [GROUP_A, GROUP_R, GROUP_BY_ROOT, GROUP_U];
// fix round 1: a detected folder whose sessions all ended 8 to 30 days ago is not in the 7-day eligibility snapshot; only the index-only lookup has it
const KEY_OLD = keyFor('/tmp/nika-test/old-demo');
const OLD_GROUP = { key: KEY_OLD, label: 'old-demo', root: '/tmp/nika-test/old-demo', agents: [agent(uid(11)), agent(uid(12))] };
const eindex = () => Object.assign(new Error('index'), { code: 'EINDEX' });

/** What nika's own index knows: id -> { agent, group }. */
function index() {
  const map = new Map();
  for (const g of FOLDERS) for (const a of g.agents) map.set(a.id, { agent: a, group: g });
  map.set(HOST, { agent: map.get(CHILD).agent, group: GROUP_A }); // findSession(HOST) answers the child's row: not the row the request names
  return map;
}

function makeDeps(over = {}) {
  const state = { panes: new Map([['%6', { command: 'claude' }]]), error: null };
  return {
    version: '9.9.9',
    collect: async () => ({ sources: SOURCES_OK, groups: FOLDERS }),
    listPanes: async () => ({ panes: state.panes, error: state.error }),
    mirror: { capture: async () => ({ status: 200, body: {} }) },
    keys: { send: async () => ({ status: 200, body: {} }) },
    picker: { start: () => null, status: () => null },
    window: async () => {},
    appCopy: { state: async () => ({ state: 'missing', managed: false, dismissed: false, version: null, available: null, running: false }), install: async () => ({}), dismiss: async () => {} },
    ...over,
  };
}

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
});

/** Real server with the app handler on its own state dir (`env`); `call(method, path, { json, headers })`. */
async function boot({ env = w.env, deps = makeDeps(), ctxOver = {}, app = true } = {}) {
  const known = index();
  const ctx = w.ctx(async () => ({ stdout: '', stderr: '' }), {
    env, claudeDir: path.join(w.root, 'claude'), now: () => NOW,
    findSession: async (id) => {
      if (id === BADINDEX) throw Object.assign(new Error('index'), { code: 'EINDEX' });
      return known.get(id) ?? null;
    },
    findSessions: async (ids) => new Map(ids.filter((id) => known.has(id) && id !== HOST).map((id) => [id, known.get(id)])),
    findGroup: async (key) => (key === KEY_OLD ? OLD_GROUP : null),
    ...ctxOver,
  });
  const handler = app ? createAppApi({ secret: SECRET, ctx, deps }) : null;
  const server = createServer({ config: { claudeDir: ctx.claudeDir, tmpRoot: path.join(w.root, 'tmp'), reportDirs: [], port: 0 }, exec: async () => ({ stdout: '', stderr: '' }), token: 'tok', version: '0.0.0', app: handler });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const { port } = server.address();
  const call = (method, p, { headers = {}, json, body } = {}) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, ...(json !== undefined || body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const payload = json !== undefined ? JSON.stringify(json) : body;
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: data, body: data && res.headers['content-type']?.includes('json') ? JSON.parse(data) : data }));
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
  return { call, ctx, port };
}

let n = 0;
/** A fresh state dir (so every test starts with no hidden.json), the config dir of the world kept. */
const fresh = () => {
  n += 1;
  const state = path.join(w.root, `state-${n}`);
  return { ...w.env, XDG_STATE_HOME: state };
};
const fileOf = (env) => path.join(stateDir(env), HIDDEN_FILE);
const rawOf = (env) => JSON.parse(fs.readFileSync(fileOf(env), 'utf8'));
const exists = (env) => fs.existsSync(fileOf(env));
const sessionIds = async (env) => [...(await readHidden(env, NOW)).sessions.keys()];
const groupKeys = async (env) => [...(await readHidden(env, NOW)).groups.keys()];
const rm = (id) => `/api/app/session/${id}/remove`;
const unrm = (id) => `/api/app/session/${id}/unhide`;
const grm = (key) => `/api/app/groups/${key}/remove`;
const ungrm = (key) => `/api/app/groups/${key}/unhide`;

describe('POST /api/app/session/:id/remove', () => {
  let env;
  let a;
  before(async () => {
    env = fresh();
    a = await boot({ env });
  });

  test('(+) {} removes an ended row: 200 { hidden: true, dropped: 0 }, no-store, the entry is written (0600)', async () => {
    const r = await a.call('POST', rm(E1), { json: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { hidden: true, dropped: 0 });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(await sessionIds(env), [E1]);
    assert.equal(fs.statSync(fileOf(env)).mode & 0o777, 0o600);
  });

  test('(+) a stuck row (live, no pane) is removable too', async () => {
    const r = await a.call('POST', rm(S1), { json: {} });
    assert.equal(r.status, 200);
    assert.ok((await sessionIds(env)).includes(S1));
  });

  test('(+) a percent-encoded id is decoded', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    assert.equal((await b.call('POST', rm(E2.replace(/-/g, '%2D')), { json: {} })).status, 200);
    assert.deepEqual(await sessionIds(e), [E2]);
  });

  test('(+) the write drops the entries of sessions that run in a tmux pane now, and counts them', async () => {
    const e = fresh();
    await hideSession(P1, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('POST', rm(E1), { json: {} });
    assert.deepEqual(r.body, { hidden: true, dropped: 1 });
    assert.deepEqual(await sessionIds(e), [E1]);
  });

  test('(\u2212) a body with any key is 400 and nothing is written; so is a non-object body', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    for (const json of [{ a: 1 }, { rm: true }, { id: E1 }, { path: '/etc/passwd' }]) {
      const r = await b.call('POST', rm(E1), { json });
      assert.equal(r.status, 400, JSON.stringify(json));
      assert.equal(r.body.error, 'invalid');
    }
    for (const body of ['[]', 'null', '7', '"x"', '{bad']) assert.equal((await b.call('POST', rm(E1), { body })).status, 400, body);
    assert.equal(exists(e), false);
  });

  test('(\u2212) a bad id, an unknown id and a host id are 404, and nothing is written', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    for (const id of ['abc', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', `${E1}x`, '%E0%A4%A', GONE, HOST]) {
      const r = await b.call('POST', rm(id), { json: {} });
      assert.deepEqual([r.status, r.body.error], [404, 'not_found'], id);
    }
    assert.equal(exists(e), false);
  });

  test('(\u2212) a row in a tmux pane is 409 in-tmux and is not removed', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    const r = await b.call('POST', rm(P1), { json: {} });
    assert.deepEqual([r.status, r.body.error], [409, 'in-tmux']);
    assert.equal(exists(e), false);
  });

  test('(\u2212) 0.5.4: the index row alone says it runs in a pane (the snapshot is older): 409', async () => {
    const e = fresh();
    const quiet = { ...GROUP_A, agents: GROUP_A.agents.map((a) => (a.id === P1 ? { ...a, live: false, pane: null } : a)) };
    const b = await boot({ env: e, deps: makeDeps({ collect: async () => ({ sources: SOURCES_OK, groups: [quiet] }) }) });
    assert.deepEqual([(await b.call('POST', rm(P1), { json: {} })).status, exists(e)], [409, false]);
  });

  test('(\u2212) 0.5.4: the snapshot alone says it runs in a pane (the index row is older): 409, and nothing is stored', async () => {
    const e = fresh();
    const inPane = { ...GROUP_A, agents: GROUP_A.agents.map((a) => (a.id === E1 ? { ...a, live: true, pane: { id: '%6' } } : a)) };
    const b = await boot({ env: e, deps: makeDeps({ collect: async () => ({ sources: SOURCES_OK, groups: [inPane] }) }) });
    const r = await b.call('POST', rm(E1), { json: {} });
    assert.deepEqual([r.status, r.body.error, exists(e)], [409, 'in-tmux', false]);
  });

  test('(\u2212) 0.5.4: a snapshot that cannot be taken still lets an ended row go (the index row decides), with dropped 0', async () => {
    const e = fresh();
    const b = await boot({ env: e, deps: makeDeps({ collect: async () => { throw new Error('collect failed'); } }) });
    const r = await b.call('POST', rm(E1), { json: {} });
    assert.deepEqual([r.status, r.body], [200, { hidden: true, dropped: 0 }]);
    assert.deepEqual(await sessionIds(e), [E1]);
  });

  test('(\u2212) an index that cannot be read is 503 index_unavailable', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    const r = await b.call('POST', rm(BADINDEX), { json: {} });
    assert.deepEqual([r.status, r.body.error], [503, 'index_unavailable']);
    assert.equal(exists(e), false);
  });

  test('(\u2212) a state folder that cannot be written is 500 write_failed, with a fixed message (no path, no OS text)', async () => {
    const e = fresh();
    fs.mkdirSync(path.dirname(stateDir(e)), { recursive: true });
    fs.writeFileSync(stateDir(e), 'a file where nika\'s state folder should be');
    const b = await boot({ env: e });
    const r = await b.call('POST', rm(E1), { json: {} });
    assert.deepEqual([r.status, r.body.error], [500, 'write_failed']);
    assert.ok(!JSON.stringify(r.body).includes(w.root));
  });

  test('(\u2212) a symlinked hidden.json is 500 and the target is not touched', async () => {
    const e = fresh();
    fs.mkdirSync(stateDir(e), { recursive: true, mode: 0o700 });
    const elsewhere = path.join(w.root, 'elsewhere-session.json');
    fs.writeFileSync(elsewhere, '{"v":1,"sessions":{}}');
    fs.symlinkSync(elsewhere, fileOf(e));
    const b = await boot({ env: e });
    assert.equal((await b.call('POST', rm(E1), { json: {} })).status, 500);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{"v":1,"sessions":{}}');
  });

  test('(\u2212) no secret: 403 and nothing is written; the wrong method is 405', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    assert.equal((await b.call('POST', rm(E1), { json: {}, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal(exists(e), false);
    const get = await b.call('GET', rm(E1));
    assert.equal(get.status, 405);
    assert.match(get.headers.allow, /POST/);
  });

  test('(\u2212) the browser tier does not mount it: 404', async () => {
    const e = fresh();
    const b = await boot({ env: e, app: false });
    for (const [m, p] of [['POST', rm(E1)], ['POST', unrm(E1)], ['POST', grm(KEY_A)], ['POST', ungrm(KEY_A)], ['GET', '/api/app/hidden']]) {
      assert.equal((await b.call(m, p, { json: m === 'POST' ? {} : undefined })).status, 404, p);
    }
    assert.equal(exists(e), false);
  });
});

describe('POST /api/app/session/:id/unhide', () => {
  test('(+) a removed session is shown again; the answer is { hidden: false }; the others stay', async () => {
    const e = fresh();
    await hideSession(E1, e, { now: NOW - 2000, warn: () => {} });
    await hideSession(S1, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('POST', unrm(E1), { json: {} });
    assert.deepEqual([r.status, r.body, r.headers['cache-control']], [200, { hidden: false }, 'no-store']);
    assert.deepEqual(await sessionIds(e), [S1]);
  });

  test('(+) Show again also drops the entries of sessions that run in a tmux pane now (R11: every write prunes)', async () => {
    const e = fresh();
    await hideSession(E1, e, { now: NOW - 3000, warn: () => {} });
    await hideSession(S1, e, { now: NOW - 2000, warn: () => {} });
    await hideSession(P1, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('POST', unrm(E1), { json: {} });
    assert.deepEqual([r.status, r.body], [200, { hidden: false }]);
    assert.deepEqual(await sessionIds(e), [S1], 'E1 is shown again, P1 runs in a pane, S1 (no pane) stays removed');
  });

  test('(+) also when the id was not removed: the write that pruned P1 still happens', async () => {
    const e = fresh();
    await hideSession(P1, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    assert.equal((await b.call('POST', unrm(GONE), { json: {} })).status, 200);
    assert.deepEqual(await sessionIds(e), []);
  });

  test('(+) also when it was not removed, and for an id nika has no transcript for', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    assert.deepEqual((await b.call('POST', unrm(E1), { json: {} })).body, { hidden: false });
    assert.equal((await b.call('POST', unrm(GONE), { json: {} })).status, 200);
    assert.equal(exists(e), false, 'nothing was stored, so nothing is written');
    await hideSession(GONE, e, { now: NOW - 1000, warn: () => {} });
    assert.equal((await b.call('POST', unrm(GONE), { json: {} })).status, 200);
    assert.deepEqual(await sessionIds(e), [], 'an entry whose transcript is gone can still be cleared');
  });

  test('(\u2212) a body with any key is 400; a bad id is 404; a state folder that cannot be written is 500', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    assert.equal((await b.call('POST', unrm(E1), { json: { a: 1 } })).status, 400);
    assert.equal((await b.call('POST', unrm('nope'), { json: {} })).status, 404);
    await hideSession(E1, e, { now: NOW - 1000, warn: () => {} });
    fs.chmodSync(stateDir(e), 0o500); // an entry that can be read but a folder nika cannot write into
    try {
      const r = await b.call('POST', unrm(E1), { json: {} });
      assert.deepEqual([r.status, r.body.error], [500, 'write_failed']);
    } finally {
      fs.chmodSync(stateDir(e), 0o700);
    }
    assert.deepEqual(await sessionIds(e), [E1], 'nothing changed');
  });
});

describe('POST /api/app/groups/:key/remove', () => {
  test('(+) a detected folder: 200 with the number of its rows that have no tmux pane; the entry is stored under the key', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    const r = await b.call('POST', grm(KEY_A), { json: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { hidden: true, sessions: 3, dropped: 0 }, 'E1, S1 and the child: not P1, which runs in a pane');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(await groupKeys(e), [KEY_A]);
    assert.deepEqual(rawOf(e), { v: 1, sessions: {}, groups: { [KEY_A]: { at: NOW } } });
  });

  test('(+) the write drops the entries of sessions that run in a tmux pane now, and counts them (R11)', async () => {
    const e = fresh();
    await hideSession(P1, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('POST', grm(KEY_A), { json: {} });
    assert.deepEqual(r.body, { hidden: true, sessions: 3, dropped: 1 });
    assert.deepEqual(await sessionIds(e), []);
    assert.deepEqual(await groupKeys(e), [KEY_A]);
  });

  test('(+) a detected folder whose sessions all ended 8 to 30 days ago (only the index-only lookup has it) is removed; a folder of the snapshot does not ask the index', async () => {
    const e = fresh();
    const asked = [];
    const b = await boot({ env: e, ctxOver: { findGroup: async (key) => { asked.push(key); return key === KEY_OLD ? OLD_GROUP : null; } } });
    const r = await b.call('POST', grm(KEY_OLD), { json: {} });
    assert.deepEqual([r.status, r.body], [200, { hidden: true, sessions: 2, dropped: 0 }]);
    assert.deepEqual(await groupKeys(e), [KEY_OLD]);
    assert.deepEqual(rawOf(e).groups, { [KEY_OLD]: { at: NOW } });
    assert.deepEqual(asked, [KEY_OLD]);
    assert.equal((await b.call('POST', grm(KEY_A), { json: {} })).status, 200);
    assert.deepEqual(asked, [KEY_OLD], 'KEY_A is in the eligibility snapshot: no index walk');
  });

  test('(\u2212) a key in neither the snapshot nor the index is 404 and writes nothing (the index was asked once)', async () => {
    const e = fresh();
    const asked = [];
    const b = await boot({ env: e, ctxOver: { findGroup: async (key) => { asked.push(key); return null; } } });
    const r = await b.call('POST', grm('d'.repeat(16)), { json: {} });
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
    assert.deepEqual(asked, ['d'.repeat(16)]);
    assert.equal(exists(e), false);
  });

  test('(\u2212) a registered folder that only the index-only lookup has is still 409 registered, by key and by folder', async () => {
    const e = fresh();
    const only = { collect: async () => ({ sources: SOURCES_OK, groups: [GROUP_A] }) };
    for (const found of [GROUP_R, GROUP_BY_ROOT]) {
      const b = await boot({ env: e, deps: makeDeps(only), ctxOver: { findGroup: async (key) => (key === found.key ? found : null) } });
      const r = await b.call('POST', grm(found.key), { json: {} });
      assert.deepEqual([r.status, r.body.error], [409, 'registered'], found.label);
    }
    assert.equal(exists(e), false);
  });

  test('(\u2212) the (unknown) folder found by the index-only lookup is 404 too (no working folder to name)', async () => {
    const e = fresh();
    const b = await boot({ env: e, deps: makeDeps({ collect: async () => ({ sources: SOURCES_OK, groups: [GROUP_A] }) }), ctxOver: { findGroup: async (key) => (key === KEY_U ? GROUP_U : null) } });
    const r = await b.call('POST', grm(KEY_U), { json: {} });
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
    assert.equal(exists(e), false);
  });

  test('(\u2212) the lookup cannot read the index: 503 for an unknown key with nothing written, but a key already stored is still stamped again', async () => {
    const e = fresh();
    const b = await boot({ env: e, ctxOver: { findGroup: async () => { throw eindex(); } } });
    const r = await b.call('POST', grm('d'.repeat(16)), { json: {} });
    assert.deepEqual([r.status, r.body.error], [503, 'index_unavailable']);
    assert.equal(exists(e), false);
    await hideGroup('d'.repeat(16), e, { now: NOW - 5 * DAY, warn: () => {} });
    const again = await b.call('POST', grm('d'.repeat(16)), { json: {} });
    assert.deepEqual([again.status, again.body], [200, { hidden: true, sessions: 0, dropped: 0 }]);
    assert.deepEqual(rawOf(e).groups, { ['d'.repeat(16)]: { at: NOW } });
  });

  test('(+) a key that is already stored but no longer in the snapshot is stamped again (sessions: 0)', async () => {
    const e = fresh();
    const old = 'c'.repeat(16);
    await hideGroup(old, e, { now: NOW - 5 * DAY, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('POST', grm(old), { json: {} });
    assert.deepEqual(r.body, { hidden: true, sessions: 0, dropped: 0 });
    assert.deepEqual(rawOf(e).groups, { [old]: { at: NOW } });
  });

  test('(\u2212) a body with any key is 400 and nothing is written', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    for (const json of [{ a: 1 }, { root: '/' }, { label: 'x' }]) assert.equal((await b.call('POST', grm(KEY_A), { json })).status, 400, JSON.stringify(json));
    assert.equal(exists(e), false);
  });

  test('(\u2212) a bad key, a key nika has no folder for, and the (unknown) folder are 404', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    for (const key of ['abc', 'ABCDEF0123456789', '../x', `${KEY_A}0`, 'd'.repeat(16), KEY_U]) {
      const r = await b.call('POST', grm(key), { json: {} });
      assert.deepEqual([r.status, r.body.error], [404, 'not_found'], key);
    }
    assert.equal(exists(e), false);
  });

  test('(\u2212) a folder that is a project added to nika is 409 registered, by key and by folder', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    for (const key of [w.project.key, GROUP_BY_ROOT.key]) {
      const r = await b.call('POST', grm(key), { json: {} });
      assert.deepEqual([r.status, r.body.error], [409, 'registered'], key);
    }
    assert.equal(exists(e), false);
  });

  test('(\u2212) a stored key that is not in the snapshot but is a project key is 409 too (by key only)', async () => {
    const e = fresh();
    await hideGroup(w.project.key, e, { now: NOW - 5 * DAY, warn: () => {} });
    const b = await boot({ env: e, deps: makeDeps({ collect: async () => ({ sources: SOURCES_OK, groups: [GROUP_A] }) }) });
    const r = await b.call('POST', grm(w.project.key), { json: {} });
    assert.deepEqual([r.status, r.body.error], [409, 'registered']);
  });

  test('(\u2212) no snapshot (the collect failed) is 503 index_unavailable and nothing is written', async () => {
    const e = fresh();
    const b = await boot({ env: e, deps: makeDeps({ collect: async () => { throw new Error('collect failed'); } }) });
    const r = await b.call('POST', grm(KEY_A), { json: {} });
    assert.deepEqual([r.status, r.body.error], [503, 'index_unavailable']);
    assert.equal(exists(e), false);
  });

  test('(\u2212) a state folder that cannot be written is 500 write_failed', async () => {
    const e = fresh();
    fs.mkdirSync(path.dirname(stateDir(e)), { recursive: true });
    fs.writeFileSync(stateDir(e), 'a file');
    const b = await boot({ env: e });
    const r = await b.call('POST', grm(KEY_A), { json: {} });
    assert.deepEqual([r.status, r.body.error], [500, 'write_failed']);
  });
});

describe('POST /api/app/groups/:key/unhide', () => {
  test('(+) a removed folder is shown again; { hidden: false }; the others stay', async () => {
    const e = fresh();
    await hideGroup(KEY_A, e, { now: NOW - 2000, warn: () => {} });
    await hideGroup('e'.repeat(16), e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('POST', ungrm(KEY_A), { json: {} });
    assert.deepEqual([r.status, r.body], [200, { hidden: false }]);
    assert.deepEqual(await groupKeys(e), ['e'.repeat(16)]);
  });

  test('(+) Show again of a folder also drops the entries of sessions that run in a tmux pane now (R11: every write prunes)', async () => {
    const e = fresh();
    await hideSession(S1, e, { now: NOW - 3000, warn: () => {} });
    await hideSession(P1, e, { now: NOW - 2000, warn: () => {} });
    await hideGroup(KEY_A, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('POST', ungrm(KEY_A), { json: {} });
    assert.deepEqual([r.status, r.body], [200, { hidden: false }]);
    assert.deepEqual(await groupKeys(e), []);
    assert.deepEqual(await sessionIds(e), [S1], 'P1 runs in a pane: pruned; S1 has no pane: stays');
  });

  test('(+) a key that was never stored is fine and writes nothing', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    assert.equal((await b.call('POST', ungrm(KEY_A), { json: {} })).status, 200);
    assert.equal(exists(e), false);
  });

  test('(\u2212) a body with any key is 400; a bad key is 404; a state folder that cannot be written is 500', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    assert.equal((await b.call('POST', ungrm(KEY_A), { json: { a: 1 } })).status, 400);
    assert.equal((await b.call('POST', ungrm('nope'), { json: {} })).status, 404);
    await hideGroup(KEY_A, e, { now: NOW - 1000, warn: () => {} });
    fs.chmodSync(stateDir(e), 0o500);
    try {
      const r = await b.call('POST', ungrm(KEY_A), { json: {} });
      assert.deepEqual([r.status, r.body.error], [500, 'write_failed']);
    } finally {
      fs.chmodSync(stateDir(e), 0o700);
    }
    assert.deepEqual(await groupKeys(e), [KEY_A], 'nothing changed');
  });
});

describe('GET /api/app/hidden', () => {
  test('(+) both lists newest first; names and projects from the index; labels and paths from nika\'s own snapshot; more: 0', async () => {
    const e = fresh();
    await hideSession(E1, e, { now: NOW - 3000, warn: () => {} });
    await hideSession(E2, e, { now: NOW - 1000, warn: () => {} });
    await hideGroup(KEY_A, e, { now: NOW - 2000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('GET', '/api/app/hidden');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body, {
      groups: [{ key: KEY_A, label: 'demo', root: ROOT_A, at: NOW - 2000 }],
      sessions: [
        { id: E2, name: `name-${E2.slice(0, 2)}`, project: 'my-app', at: NOW - 1000 },
        { id: E1, name: `name-${E1.slice(0, 2)}`, project: 'demo', at: NOW - 3000 },
      ],
      more: { groups: 0, sessions: 0 },
    });
  });

  test('(+) an empty list', async () => {
    const e = fresh();
    const b = await boot({ env: e });
    assert.deepEqual((await b.call('GET', '/api/app/hidden')).body, { groups: [], sessions: [], more: { groups: 0, sessions: 0 } });
  });

  test('(+) at most 100 rows per list; the rest is counted in more', async () => {
    const e = fresh();
    const entries = { sessions: {}, groups: {} };
    for (let i = 1; i <= 130; i += 1) entries.sessions[uid(1000 + i)] = { at: NOW - 100_000 + i };
    for (let i = 1; i <= 120; i += 1) entries.groups[`g${String(i).padStart(15, '0')}`] = { at: NOW - 100_000 + 1000 + i };
    fs.mkdirSync(stateDir(e), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fileOf(e), JSON.stringify({ v: 1, ...entries }), { mode: 0o600 });
    const b = await boot({ env: e });
    const r = await b.call('GET', '/api/app/hidden');
    assert.equal(r.body.sessions.length, 100);
    assert.equal(r.body.groups.length, 100);
    assert.deepEqual(r.body.more, { groups: 20, sessions: 30 });
    assert.equal(r.body.sessions[0].id, uid(1130), 'the newest first');
  });

  test('(\u2212) an index that cannot be read leaves the names unknown but still answers 200', async () => {
    const e = fresh();
    await hideSession(E1, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e, ctxOver: { findSessions: async () => { throw Object.assign(new Error('index'), { code: 'EINDEX' }); } } });
    const r = await b.call('GET', '/api/app/hidden');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions, [{ id: E1, name: null, project: null, at: NOW - 1000 }]);
  });

  test('(\u2212) a folder key the snapshot does not have lists with label and path null', async () => {
    const e = fresh();
    await hideGroup('f'.repeat(16), e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    assert.deepEqual((await b.call('GET', '/api/app/hidden')).body.groups, [{ key: 'f'.repeat(16), label: null, root: null, at: NOW - 1000 }]);
  });

  test('(\u2212) without a snapshot the folders list with label and path null, and the route still answers', async () => {
    const e = fresh();
    await hideGroup(KEY_A, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e, deps: makeDeps({ collect: async () => { throw new Error('collect failed'); } }) });
    const r = await b.call('GET', '/api/app/hidden');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups, [{ key: KEY_A, label: null, root: null, at: NOW - 1000 }]);
  });

  test('(\u2212) a session nika has no transcript for lists with name and project null', async () => {
    const e = fresh();
    await hideSession(GONE, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    assert.deepEqual((await b.call('GET', '/api/app/hidden')).body.sessions, [{ id: GONE, name: null, project: null, at: NOW - 1000 }]);
  });

  test('(\u2212) a name, a project, a label and a path from the index are cleaned and cut', async () => {
    const e = fresh();
    const dirty = agent(uid(20), { name: `bad\u001b[31mname${'x'.repeat(200)}` });
    const group = { key: 'a'.repeat(16), label: `la\u0007bel${'y'.repeat(200)}`, root: `/tmp/${'z'.repeat(400)}`, agents: [dirty] };
    await hideSession(dirty.id, e, { now: NOW - 1000, warn: () => {} });
    await hideGroup(group.key, e, { now: NOW - 2000, warn: () => {} });
    const b = await boot({
      env: e,
      deps: makeDeps({ collect: async () => ({ sources: SOURCES_OK, groups: [group] }) }),
      ctxOver: { findSessions: async (ids) => new Map(ids.map((id) => [id, { agent: dirty, group }])) },
    });
    const r = await b.call('GET', '/api/app/hidden');
    const s = r.body.sessions[0];
    const g = r.body.groups[0];
    assert.ok(s.name.length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(s.name));
    assert.ok(s.project.length <= 120 && !/[\u0000-\u001f\u007f-\u009f]/.test(s.project));
    assert.ok(g.label.length <= 120 && !/[\u0000-\u001f\u007f-\u009f]/.test(g.label));
    assert.ok(g.root.length <= 300);
  });

  test('(\u2212) a hidden.json that is not valid is an empty list, not an error', async () => {
    const e = fresh();
    fs.mkdirSync(stateDir(e), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fileOf(e), '{ not json');
    const b = await boot({ env: e });
    const r = await b.call('GET', '/api/app/hidden');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { groups: [], sessions: [], more: { groups: 0, sessions: 0 } });
  });

  test('(\u2212) the answer carries no secret, no body of a transcript and no field the page did not ask for', async () => {
    const e = fresh();
    await hideSession(E1, e, { now: NOW - 1000, warn: () => {} });
    const b = await boot({ env: e });
    const r = await b.call('GET', '/api/app/hidden');
    assert.deepEqual(Object.keys(r.body).sort(), ['groups', 'more', 'sessions']);
    assert.deepEqual(Object.keys(r.body.sessions[0]).sort(), ['at', 'id', 'name', 'project']);
    assert.ok(!r.raw.includes(SECRET));
  });
});
