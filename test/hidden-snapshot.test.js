// 0.5.4 RM: what the user removed from the lists reaches the views -- the server's /api/agents (both tiers) and the app's status line -- and
// never the control data (src/server.js, src/appio.js; design-053-rm 4.4, 4.5, T69, T71). The state files are written through src/hidden.js into
// temp dirs; the machine is the synthetic one of test/helpers.js. Synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { makeFixture, cleanup, fakeExec, jsonl, SID, NOW, PROC_START } from './helpers.js';
import { collect } from '../src/model.js';
import { createServer } from '../src/server.js';
import { serveApp } from '../src/appio.js';
import { hideSession, hideGroup, HIDDEN_FILE } from '../src/hidden.js';
import { saveConfig, defaults, keyFor } from '../src/store.js';

const MIN = 60_000;
const NOPANE = '88888888-8888-4888-8888-888888888888'; // live, no tmux pane
const TOP = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-hidden-snap-'));
const fx = makeFixture();
after(() => {
  fs.rmSync(TOP, { recursive: true, force: true });
  cleanup(fx);
});
fs.writeFileSync(path.join(fx.claudeDir, 'sessions', '106.json'), JSON.stringify({
  pid: 106, sessionId: NOPANE, kind: 'interactive', cwd: fx.repo, name: 'stuck-one', procStart: PROC_START, startedAt: NOW - 60 * MIN, updatedAt: NOW - MIN, version: '2.1.319',
}));
const PS = [`  101 ${PROC_START}`, `  102 ${PROC_START}`, `  104 ${PROC_START}`, `  106 ${PROC_START}`];

let counter = 0;
/** Fresh temp state and config dirs; `hide` lists the session ids and `hideGroups` the folder keys written to hidden.json first. */
async function dirs({ hide = [], hideGroups = [], projects = [], orchestrator = null } = {}) {
  counter += 1;
  const base = path.join(TOP, `d${counter}`);
  fs.mkdirSync(path.join(base, 'cfg'), { recursive: true });
  const env = { NIKA_CONFIG_DIR: path.join(base, 'cfg'), XDG_STATE_HOME: path.join(base, 'state'), HOME: path.join(base, 'home'), PATH: '/usr/bin' };
  for (const id of hide) await hideSession(id, env, { now: NOW - MIN, warn: () => {} });
  for (const key of hideGroups) await hideGroup(key, env, { now: NOW - MIN, warn: () => {} });
  if (projects.length) {
    const perProject = orchestrator ? Object.fromEntries(projects.map((dir) => [keyFor(dir), { orchestratorSessionId: orchestrator }])) : {};
    await saveConfig({ ...defaults(), projects: projects.map((dir) => ({ key: keyFor(dir), dir, name: path.basename(dir), addedAt: '2026-11-01T00:00:00.000Z' })), perProject }, env);
  }
  return { base, env };
}

const request = (port, p, headers = {}, method = 'GET', payload = undefined) => new Promise((resolve, reject) => {
  const sent = payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...sent, ...headers } }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
  });
  r.on('error', reject);
  r.end(payload);
});

const servers = [];
after(async () => {
  for (const s of servers) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
});
/** The browser tier's server on a random port; `get(path)` resolves { status, body }. */
async function serve(config, { exec = fakeExec({ psLines: PS }), now = () => NOW } = {}) {
  const server = createServer({ config, exec, token: 'tok', now, version: '0.0.0' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const { port } = server.address();
  return (p) => request(port, p);
}
const ids = (snap) => snap.groups.flatMap((g) => g.agents.map((a) => a.id));
const group = (snap, label) => snap.groups.find((g) => g.label === label);
const SINCE = '/api/agents?since=7d';

describe('server snapshot (/api/agents), browser tier', () => {
  test('(+) removed ids are left out and counted, per group and in total', async () => {
    const { env } = await dirs({ hide: [SID.ended, NOPANE] });
    const get = await serve({ ...fx.config, env });
    const res = await get(SINCE);
    assert.equal(res.status, 200);
    assert.ok(!ids(res.body).includes(SID.ended) && !ids(res.body).includes(NOPANE));
    assert.equal(res.body.hidden, 2);
    assert.equal(group(res.body, 'repo').hidden, 2);
    assert.equal(group(res.body, 'plain').hidden, 0);
  });

  test('(+) a removed folder is left out as a whole; its rows are counted in the total only', async () => {
    const probe = await (await serve({ ...fx.config, env: (await dirs()).env }))(SINCE);
    const key = group(probe.body, 'plain').key;
    const { env } = await dirs({ hideGroups: [key] });
    const res = await (await serve({ ...fx.config, env }))(SINCE);
    assert.ok(!ids(res.body).includes(SID.other));
    assert.equal(group(res.body, 'plain'), undefined);
    assert.equal(res.body.hidden, 1);
  });

  test('(+) the config\'s project list is read for the folder test: a removed folder that is a project added to nika keeps its rows', async () => {
    const probe = await (await serve({ ...fx.config, env: (await dirs()).env }))(SINCE);
    const key = group(probe.body, 'plain').key;
    const { env } = await dirs({ hideGroups: [key], projects: [fx.plain] });
    const res = await (await serve({ ...fx.config, env }))(SINCE);
    assert.ok(ids(res.body).includes(SID.other));
    assert.equal(group(res.body, 'plain').hidden, 0);
    assert.equal(res.body.hidden, 0);
  });

  test('(\u2212) nothing removed: every row, hidden 0', async () => {
    const { env } = await dirs();
    const res = await (await serve({ ...fx.config, env }))(SINCE);
    assert.ok(ids(res.body).includes(SID.ended) && ids(res.body).includes(NOPANE));
    assert.equal(res.body.hidden, 0);
  });

  test('(\u2212) a removed id that is live in a tmux pane still shows', async () => {
    const { env } = await dirs({ hide: [SID.busy] });
    const res = await (await serve({ ...fx.config, env }))(SINCE);
    assert.ok(ids(res.body).includes(SID.busy));
    assert.equal(res.body.hidden, 0);
  });

  test('(\u2212) a config without env reads no file (0.1 callers): nothing is hidden, and the real state folder (process.env) is not read', async () => {
    const { env } = await dirs({ hide: [NOPANE] });
    const had = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = env.XDG_STATE_HOME; // what a fall-back to process.env would read
    try {
      const res = await (await serve({ ...fx.config }))(SINCE);
      assert.ok(ids(res.body).includes(NOPANE));
      assert.equal(res.body.hidden, 0);
    } finally {
      if (had === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = had;
    }
  });

  test('(\u2212) a hidden.json that is not valid shows every row and is not an error', async () => {
    const { env } = await dirs();
    fs.mkdirSync(path.join(env.XDG_STATE_HOME, 'nika'), { recursive: true });
    fs.writeFileSync(path.join(env.XDG_STATE_HOME, 'nika', HIDDEN_FILE), '{ not json');
    const res = await (await serve({ ...fx.config, env }))(SINCE);
    assert.equal(res.status, 200);
    assert.ok(ids(res.body).includes(NOPANE));
    assert.equal(res.body.hidden, 0);
  });

  test('(\u2212) the snapshot carries counts only: no id, key or time of a removed item', async () => {
    const { env } = await dirs();
    await hideSession(SID.ended, env, { now: NOW - 7_654_321, warn: () => {} });
    const res = await (await serve({ ...fx.config, env }))(SINCE);
    assert.equal(res.body.hidden, 1);
    assert.ok(!JSON.stringify(res.body).includes(SID.ended));
    assert.ok(!JSON.stringify(res.body).includes('7654321') && !JSON.stringify(res.body).includes(String(NOW - 7_654_321)), 'the time of the removal is not in it');
  });
});

describe('server cache and the write counter', () => {
  test('(+) a write within the cache\'s time to live: the next request is fresh', async () => {
    const { env } = await dirs();
    const get = await serve({ ...fx.config, env }); // the clock never moves, so the 1.5 s entry would be a hit
    assert.ok(ids((await get(SINCE)).body).includes(SID.ended));
    await hideSession(SID.ended, env, { now: NOW });
    const res = await get(SINCE);
    assert.ok(!ids(res.body).includes(SID.ended));
    assert.equal(res.body.hidden, 1);
  });

  test('(+) an Undo within the time to live is seen at once too', async () => {
    const { env } = await dirs({ hide: [SID.ended] });
    const get = await serve({ ...fx.config, env });
    assert.ok(!ids((await get(SINCE)).body).includes(SID.ended));
    const { unhideSession } = await import('../src/hidden.js');
    await unhideSession(SID.ended, env, { now: NOW });
    assert.ok(ids((await get(SINCE)).body).includes(SID.ended));
  });

  test('(+) a write that lands while the snapshot is being collected leaves that entry stale: the next request collects again', async () => {
    const { env } = await dirs();
    const base = fakeExec({ psLines: PS });
    let release;
    const gate = new Promise((r) => { release = r; });
    let reached;
    const atPs = new Promise((r) => { reached = r; });
    let first = true;
    const exec = async (cmd, args, o) => {
      if (first && cmd.endsWith('ps')) {
        first = false;
        reached();
        await gate;
      }
      return base(cmd, args, o);
    };
    const get = await serve({ ...fx.config, env }, { exec });
    const slow = get(SINCE);
    await atPs; // readHidden has already answered (nothing removed) and the collect waits
    await hideSession(SID.ended, env, { now: NOW });
    release();
    assert.ok(ids((await slow).body).includes(SID.ended), 'the request that was already collecting saw the old list');
    const next = await get(SINCE);
    assert.ok(!ids(next.body).includes(SID.ended), 'the entry it left in the cache is a miss, not a hit');
  });

  test('(\u2212) no write: the collectors run once within the time to live', async () => {
    const { env } = await dirs();
    const exec = fakeExec({ psLines: PS });
    const get = await serve({ ...fx.config, env }, { exec });
    await get(SINCE);
    const after1 = exec.calls.length;
    assert.ok(after1 > 0);
    await get(SINCE);
    assert.equal(exec.calls.length, after1);
  });

  test('(\u2212) a write that failed (a symlinked file) does not move the counter, so the cache still hits', async () => {
    const { env } = await dirs();
    const exec = fakeExec({ psLines: PS });
    const get = await serve({ ...fx.config, env }, { exec });
    await get(SINCE);
    const calls = exec.calls.length;
    fs.mkdirSync(path.join(env.XDG_STATE_HOME, 'nika'), { recursive: true });
    fs.symlinkSync(path.join(TOP, 'elsewhere.json'), path.join(env.XDG_STATE_HOME, 'nika', HIDDEN_FILE));
    await assert.rejects(hideSession(SID.ended, env, { now: NOW, warn: () => {} }));
    await get(SINCE);
    assert.equal(exec.calls.length, calls);
  });
});

/** serveApp on pipes: `get(path)` on its server, `status()` the first status line the tray feed sends, `stop()`. */
async function startApp({ env, exec = fakeExec({ psLines: PS }), config = fx.config }) {
  const secret = crypto.randomBytes(32).toString('base64url').slice(0, 43);
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.setEncoding('utf8');
  let text = '';
  const waiting = [];
  stdout.on('data', (c) => {
    text += c;
    waiting.slice().forEach((w) => w());
  });
  const done = serveApp({
    config, env: { ...env, NIKA_TMUX: 'tmux', NIKA_CLAUDE: '/nonexistent/claude' }, stdin, stdout, stderr, exec, now: () => NOW,
    intervalMs: 60_000, helloMs: 2000, appCopy: { home: path.join(TOP, 'home'), brewApps: [] },
  });
  stdin.write(`${JSON.stringify({ type: 'hello', proto: 1, secret })}\n`);
  const line = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} line; got ${text}`)), 5000);
    const check = () => {
      const hit = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.type === type);
      if (hit) {
        clearTimeout(timer);
        waiting.splice(waiting.indexOf(check), 1);
        resolve(hit);
      }
    };
    waiting.push(check);
    check();
  });
  const ready = await line('ready');
  return {
    status: () => line('status'),
    get: (p) => request(ready.port, p),
    app: (p) => request(ready.port, p, { 'x-nika-app': secret }),
    post: (p, json = {}) => request(ready.port, p, { 'x-nika-app': secret }, 'POST', JSON.stringify(json)),
    stop: async () => {
      stdin.end();
      await done;
    },
  };
}

describe('app tier', () => {
  test('(+) /api/agents leaves removed rows out of the app tier too (its own server, its own config)', async () => {
    const { env } = await dirs({ hide: [SID.ended, NOPANE] });
    const app = await startApp({ env });
    try {
      const res = await app.get(SINCE);
      assert.ok(!ids(res.body).includes(SID.ended) && !ids(res.body).includes(NOPANE));
      assert.equal(res.body.hidden, 2);
    } finally {
      await app.stop();
    }
  });

  test('(+) a removed live row without a pane leaves the tray\'s attention count', async () => {
    const plain = await dirs();
    const a = await startApp({ env: plain.env });
    const base = await a.status();
    await a.stop();
    const gone = await dirs({ hide: [NOPANE] });
    const b = await startApp({ env: gone.env });
    const hid = await b.status();
    await b.stop();
    assert.equal(base.attention - hid.attention, 1);
    assert.equal(base.ended, hid.ended);
  });

  test('(+) a removed folder leaves the tray counts and its per-project list', async () => {
    const plain = await dirs();
    const a = await startApp({ env: plain.env });
    const base = await a.status();
    const probe = await a.get(SINCE);
    await a.stop();
    const key = group(probe.body, 'plain').key;
    const gone = await dirs({ hideGroups: [key] });
    const b = await startApp({ env: gone.env });
    const hid = await b.status();
    await b.stop();
    assert.equal(base.ended - hid.ended, 1);
    assert.ok(base.projects.some((p) => p.name === 'plain') && !hid.projects.some((p) => p.name === 'plain'));
  });

  test('(\u2212) a removed id that runs in a tmux pane changes nothing in the tray', async () => {
    const plain = await dirs();
    const a = await startApp({ env: plain.env });
    const base = await a.status();
    await a.stop();
    const gone = await dirs({ hide: [SID.busy] });
    const b = await startApp({ env: gone.env });
    const hid = await b.status();
    await b.stop();
    assert.deepEqual(hid, base);
  });
});

describe('control data is never filtered (T69)', () => {
  test('(+) GET /api/app/projects: a removed, live, pane-less saved orchestrator still reads live while /api/agents leaves its row out', async () => {
    const { env } = await dirs({ hide: [NOPANE], projects: [fx.repo], orchestrator: NOPANE });
    const app = await startApp({ env });
    try {
      const view = await app.get(SINCE);
      assert.ok(!ids(view.body).includes(NOPANE), 'the view leaves it out');
      const res = await app.app('/api/app/projects');
      assert.equal(res.status, 200);
      const project = res.body.projects.find((p) => p.key === keyFor(fx.repo));
      assert.equal(project.orchestrator.sessionId, NOPANE);
      assert.equal(project.orchestrator.state, 'live', 'the control path reads every row');
    } finally {
      await app.stop();
    }
  });

  test('(\u2212) the same project with nothing removed reads live too (the control is not a side effect of the removal)', async () => {
    const { env } = await dirs({ projects: [fx.repo], orchestrator: NOPANE });
    const app = await startApp({ env });
    try {
      const res = await app.app('/api/app/projects');
      assert.equal(res.body.projects.find((p) => p.key === keyFor(fx.repo)).orchestrator.state, 'live');
    } finally {
      await app.stop();
    }
  });
});

describe('app tier: Remove of a folder whose sessions ended before the 7-day snapshot (fix round 1; src/appio.js wires findGroup)', () => {
  const OLD = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  const old = makeFixture();
  after(() => cleanup(old));
  const dir = path.join(old.root, 'old-folder');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(old.claudeDir, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), `${OLD}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stamp = new Date(NOW - 20 * 86_400_000).toISOString();
  fs.writeFileSync(file, jsonl([
    { type: 'user', cwd: dir, sessionId: OLD, timestamp: stamp, message: { role: 'user', content: 'synthetic prompt' } },
    { type: 'assistant', cwd: dir, sessionId: OLD, timestamp: stamp, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [] } },
  ]));
  fs.utimesSync(file, new Date(NOW - 20 * 86_400_000), new Date(NOW - 20 * 86_400_000));
  const keyOf = async () => (await collect({ config: old.config, exec: fakeExec({ psLines: [] }), now: NOW, sinceMs: Infinity })).snapshot.groups.find((g) => g.label === 'old-folder').key;

  test('(+) the 7-day snapshot of the app has no group for it, yet Remove finds it (index-only lookup), stores the key and answers its row count', async () => {
    const { env } = await dirs();
    const key = await keyOf();
    const app = await startApp({ env, config: old.config });
    try {
      assert.ok(!(await app.get(SINCE)).body.groups.some((g) => g.key === key), 'out of the window');
      const res = await app.post(`/api/app/groups/${key}/remove`);
      assert.deepEqual([res.status, res.body], [200, { hidden: true, sessions: 1, dropped: 0 }]);
      const stored = JSON.parse(fs.readFileSync(path.join(env.XDG_STATE_HOME, 'nika', HIDDEN_FILE), 'utf8'));
      assert.deepEqual(Object.keys(stored.groups), [key]);
    } finally {
      await app.stop();
    }
  });

  test('(\u2212) a key no folder has is 404 and writes nothing', async () => {
    const { env } = await dirs();
    const app = await startApp({ env, config: old.config });
    try {
      const res = await app.post(`/api/app/groups/${'d'.repeat(16)}/remove`);
      assert.deepEqual([res.status, res.body.error], [404, 'not_found']);
      assert.equal(fs.existsSync(path.join(env.XDG_STATE_HOME, 'nika', HIDDEN_FILE)), false);
    } finally {
      await app.stop();
    }
  });
});
