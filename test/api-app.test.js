// /api/app/*: the privileged guard and every route, with injected fake modules, a real server on 127.0.0.1:0 and the real
// store in temp dirs. Synthetic data only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createAppApi } from '../src/api-app.js';
import { readHistory } from '../src/collect/history.js';
import { loadConfig, addProject } from '../src/store.js';
import { configDir, stateDir } from '../src/paths.js';
import { makeWorld } from './tmux-fake.js';
import { makeFixture, cleanup, SID } from './helpers.js';

const SECRET = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9v'.slice(0, 43);
const REQ_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WRONG_SAME_LENGTH = 'x'.repeat(SECRET.length);
const SNAPSHOT = { groups: [{ agents: [{ live: true, pane: { id: '%6' } }, { live: false, pane: { id: '%7' } }, { live: true, pane: null }] }] };

const w = await makeWorld();
const fx = makeFixture();
after(() => {
  w.cleanup();
  cleanup(fx);
});

/** Fake modules that record their calls; `over` replaces any of them. */
function makeDeps(over = {}) {
  const calls = [];
  const rec = (name, fn) => async (...args) => {
    calls.push([name, ...args]);
    return fn(...args);
  };
  const state = { panes: new Map([['%5', { command: 'zsh' }], ['%6', { command: 'claude' }], ['%7', { command: 'claude' }], ['%8', { command: 'node' }]]), error: null };
  const deps = {
    version: '9.9.9',
    collect: rec('collect', async () => SNAPSHOT),
    listPanes: rec('listPanes', async () => ({ panes: state.panes, error: state.error })),
    readHistory: rec('readHistory', async (id, q) => (q.limit === '0'
      ? { status: 400, body: { error: 'invalid', message: 'limit' } }
      : { status: 200, body: { entries: [], nextBefore: null } })),
    listPlugins: rec('listPlugins', async () => ['alpha@market', 'beta@market']),
    rulesState: rec('rulesState', async () => ({ state: 'none', settingsIgnored: false, git: true })),
    preview: rec('preview', async () => ({ status: 200, body: { hash: 'h', files: [], warnings: [], backupDir: '/x' } })),
    apply: rec('apply', async (project, opts) => (opts.hash === 'stale' ? { status: 409, body: { error: 'conflict', message: 'x' } } : { status: 200, body: { written: [], backupDir: '/x' } })),
    spawnAgent: rec('spawnAgent', async (body) => (body.name === 'full' ? { status: 409, body: { error: 'limit', message: 'x' } } : { status: 200, body: { pane: '%9', session: 's', sessionId: null, reports: {} } })),
    startOrchestrator: rec('startOrchestrator', async () => ({ status: 200, body: { pane: '%3', session: 's', sessionId: null, created: true } })),
    mirror: { capture: rec('capture', async (pane, inm) => (inm === '"abc"' ? { status: 304, body: null, etag: 'abc' } : { status: 200, body: { cols: 80, rows: [], cursor: { x: 0, y: 0, visible: true }, etag: 'abc' }, etag: 'abc' })) },
    keys: { send: rec('keys', async (pane, body) => (body.text === 'busy' ? { status: 429, body: { error: 'busy', message: 'x' } } : body.text === 'bad' ? { status: 400, body: { error: 'invalid', message: 'x' } } : { status: 200, body: { sent: { text: 1, paste: 0, keys: 0 } } })) },
    picker: { start: () => null, status: () => null },
    ...over,
  };
  deps.calls = calls;
  deps.state = state;
  return deps;
}

const servers = [];
/** Real server with the app handler; returns helpers bound to its port. */
async function boot({ deps = makeDeps(), ctxOver = {} } = {}) {
  const clock = { t: 1_000_000 };
  const ctx = w.ctx(async () => ({ stdout: '', stderr: '' }), { claudeDir: fx.claudeDir, now: () => clock.t, ...ctxOver });
  const app = createAppApi({ secret: SECRET, ctx, deps });
  const server = createServer({ config: fx.config, exec: async () => ({ stdout: '', stderr: '' }), token: 'tok', version: '0.0.0', app });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = server.address().port;
  /** headers: a null value removes a default header. */
  const call = (method, p, { headers = {}, body, json } = {}) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const payload = json !== undefined ? JSON.stringify(json) : body;
    if (payload !== undefined && h['content-length'] === undefined) h['content-length'] = Buffer.byteLength(payload); // DELETE is not chunked by default
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
  return { call, port, ctx, deps, clock };
}
after(async () => {
  for (const s of servers) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
});

describe('guard', () => {
  let a;
  before(async () => { a = await boot(); });

  test('(+) a request with the secret is served', async () => {
    const r = await a.call('GET', '/api/app/me');
    assert.equal(r.status, 200);
    assert.equal(r.body.tier, 'app');
  });

  test('(−) missing, wrong (same length) and wrong (other length) secret: 403 with one and the same body', async () => {
    const none = await a.call('GET', '/api/app/me', { headers: { 'x-nika-app': null } });
    const same = await a.call('GET', '/api/app/me', { headers: { 'x-nika-app': WRONG_SAME_LENGTH } });
    const longer = await a.call('GET', '/api/app/me', { headers: { 'x-nika-app': `${SECRET}x` } });
    const shorter = await a.call('GET', '/api/app/me', { headers: { 'x-nika-app': SECRET.slice(1) } });
    const empty = await a.call('GET', '/api/app/me', { headers: { 'x-nika-app': '' } });
    for (const r of [none, same, longer, shorter, empty]) {
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'forbidden');
      assert.equal(r.raw, none.raw);
    }
    assert.equal(none.raw.includes(SECRET), false);
  });

  test('(−) the secret in the query string or a cookie is not a credential', async () => {
    assert.equal((await a.call('GET', `/api/app/me?x-nika-app=${SECRET}`, { headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('GET', '/api/app/me', { headers: { 'x-nika-app': null, cookie: `x-nika-app=${SECRET}` } })).status, 403);
  });

  test('(−) the guard answers before the router: an unknown route without the secret is 403, not 404', async () => {
    assert.equal((await a.call('GET', '/api/app/nope', { headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('DELETE', '/api/app/projects/0123456789abcdef', { headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('OPTIONS', '/api/app/me', { headers: { 'x-nika-app': null } })).status, 403);
  });

  test('(+) Origin equal to the server origin and Sec-Fetch-Site same-origin / none pass', async () => {
    assert.equal((await a.call('GET', '/api/app/me', { headers: { origin: `http://127.0.0.1:${a.port}` } })).status, 200);
    assert.equal((await a.call('GET', '/api/app/me', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await a.call('GET', '/api/app/me', { headers: { 'sec-fetch-site': 'none' } })).status, 200);
  });

  test('(−) any other Origin is 403, including localhost, null, an empty value and another port', async () => {
    for (const origin of ['http://evil.example', `http://localhost:${a.port}`, 'null', '', `http://127.0.0.1:${a.port + 1}`, `https://127.0.0.1:${a.port}`]) {
      assert.equal((await a.call('GET', '/api/app/me', { headers: { origin } })).status, 403, JSON.stringify(origin));
    }
  });

  test('(−) Sec-Fetch-Site cross-site, same-site or anything else is 403', async () => {
    for (const site of ['cross-site', 'same-site', '', 'same-origin, cross-site']) {
      assert.equal((await a.call('GET', '/api/app/me', { headers: { 'sec-fetch-site': site } })).status, 403, JSON.stringify(site));
    }
  });

  test('(+) localhost Host is accepted like in 0.1; (−) a foreign Host is refused before the app sees the request', async () => {
    assert.equal((await a.call('GET', '/api/app/me', { headers: { host: `localhost:${a.port}` } })).status, 200);
    const before = a.deps.calls.length;
    assert.equal((await a.call('GET', '/api/app/plugins', { headers: { host: `evil.example:${a.port}` } })).status, 403);
    assert.equal((await a.call('GET', '/api/app/plugins', { headers: { host: 'evil.example' } })).status, 403);
    assert.equal(a.deps.calls.length, before);
  });

  test('(−) writes: text/plain, form and missing content type are 415; invalid JSON, arrays, scalars, null, empty and __proto__ are 400', async () => {
    const p = '/api/app/rules/preview';
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', null]) {
      assert.equal((await a.call('POST', p, { body: '{}', headers: { 'content-type': type } })).status, 415, String(type));
    }
    for (const body of ['{bad', '[]', '"x"', '1', 'null', '', '{"__proto__":{"a":1}}']) {
      const r = await a.call('POST', p, { body, headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 400, body);
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal((await a.call('POST', p, { body: '{}', headers: { 'content-type': 'Application/JSON; charset=utf-8' } })).status, 400); // passes the type check, then fails on the project
  });

  test('(−) a body over the route cap is 413 (4 KB, settings 16 KB, keys 20 KB, spawn 80 KB); (+) just under passes the cap', async () => {
    const pad = (n) => ({ pad: 'x'.repeat(n) });
    assert.equal((await a.call('POST', '/api/app/rules/preview', { json: pad(5000) })).status, 413);
    assert.equal((await a.call('PUT', '/api/app/settings', { json: pad(17 * 1024) })).status, 413);
    assert.equal((await a.call('POST', '/api/app/pane/%256/keys', { json: pad(21 * 1024) })).status, 413);
    assert.equal((await a.call('POST', '/api/app/spawn', { json: pad(81 * 1024) })).status, 413);
    assert.equal((await a.call('POST', '/api/app/rules/preview', { json: pad(3000) })).status, 400); // under the cap: reaches the route
    assert.equal((await a.call('PUT', '/api/app/settings', { json: pad(15 * 1024) })).status, 400);
    assert.equal((await a.call('POST', '/api/app/spawn', { json: { ...pad(70 * 1024), name: 'ok' } })).status, 200);
  });

  test('(+) unknown route after the guard is 404 not_found; (−) wrong method is 405 with Allow', async () => {
    const r = await a.call('GET', '/api/app/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    assert.equal((await a.call('GET', '/api/app')).status, 404);
    assert.equal((await a.call('GET', '/api/app/me/')).status, 404);
    const m = await a.call('POST', '/api/app/me', { json: {} });
    assert.equal(m.status, 405);
    assert.equal(m.headers.allow, 'GET');
    assert.equal((await a.call('PUT', '/api/app/spawn', { json: {} })).status, 405);
    assert.equal((await a.call('DELETE', '/api/app/settings')).status, 405);
  });

  test('(+) every response carries no-store and the 0.1 security headers; none carries CORS headers', async () => {
    for (const r of [
      await a.call('GET', '/api/app/me'),
      await a.call('GET', '/api/app/me', { headers: { 'x-nika-app': null } }),
      await a.call('GET', '/api/app/nope'),
      await a.call('POST', '/api/app/me', { json: {} }),
      await a.call('POST', '/api/app/spawn', { body: 'x' }),
      await a.call('POST', '/api/app/rules/preview', { json: { pad: 'x'.repeat(5000) } }),
      await a.call('GET', '/api/app/pane/%256/capture'),
    ]) {
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.match(r.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
      assert.equal(Object.keys(r.headers).some((k) => k.startsWith('access-control-')), false);
    }
  });

  test('(−) an unexpected module failure is a generic 500 that leaks nothing', async () => {
    const b = await boot({ deps: makeDeps({ listPlugins: async () => { throw new Error('boom /private/detail'); } }) });
    const log = console.error;
    console.error = () => {};
    try {
      const r = await b.call('GET', '/api/app/plugins');
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: 'internal', message: 'internal error' });
    } finally {
      console.error = log;
    }
  });
});

describe('me and plugins', () => {
  let a;
  before(async () => { a = await boot(); });

  test('(+) me reports tier, version, platform, tools and the nika dirs', async () => {
    const r = await a.call('GET', '/api/app/me');
    assert.deepEqual(r.body, {
      tier: 'app', version: '9.9.9', platform: process.platform, tmux: true, claude: true, configDir: configDir(w.env), stateDir: stateDir(w.env),
    });
  });

  test('(−) me says tmux/claude are missing when they are; POST is 405', async () => {
    const b = await boot({ ctxOver: { tmuxBin: 'tmux', claudeBin: null } });
    const r = await b.call('GET', '/api/app/me');
    assert.equal(r.body.tmux, false);
    assert.equal(r.body.claude, false);
    assert.equal((await a.call('POST', '/api/app/me', { json: {} })).status, 405);
  });

  test('(+) plugins lists the installed names; (−) POST is 405', async () => {
    const r = await a.call('GET', '/api/app/plugins');
    assert.deepEqual(r.body, { plugins: ['alpha@market', 'beta@market'] });
    assert.equal(a.deps.calls.find((c) => c[0] === 'listPlugins')[1], a.ctx.claudeDir);
    assert.equal((await a.call('POST', '/api/app/plugins', { json: {} })).status, 405);
  });
});

describe('projects', () => {
  let a;
  before(async () => { a = await boot(); });

  test('(+) list returns the registered projects with their rules state', async () => {
    const r = await a.call('GET', '/api/app/projects');
    assert.equal(r.status, 200);
    assert.equal(r.body.projects.length, 1);
    assert.deepEqual(Object.keys(r.body.projects[0]), ['key', 'dir', 'name', 'addedAt', 'rules']);
    assert.equal(r.body.projects[0].key, w.project.key);
    assert.equal(r.body.projects[0].name, 'My App');
    assert.deepEqual(r.body.projects[0].rules, { state: 'none', settingsIgnored: false, git: true });
    assert.equal(a.deps.calls.find((c) => c[0] === 'rulesState')[1].dir, w.project.dir);
  });

  test('(−) POST /projects is 405', async () => {
    const r = await a.call('POST', '/api/app/projects', { json: {} });
    assert.equal(r.status, 405);
    assert.match(r.headers.allow, /GET/);
  });

  test('(+) pick starts a request and answers 202 with its id; (−) 429 busy while one is open; (−) needs a JSON body', async () => {
    let open = null;
    const b = await boot({ deps: makeDeps({ picker: { start: () => (open ? null : (open = REQ_ID)), status: () => null } }) });
    const first = await b.call('POST', '/api/app/projects/pick', { json: {} });
    assert.equal(first.status, 202);
    assert.deepEqual(first.body, { reqId: REQ_ID });
    const second = await b.call('POST', '/api/app/projects/pick', { json: {} });
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'busy');
    assert.equal((await b.call('POST', '/api/app/projects/pick', { body: '{}' })).status, 415);
  });

  test('(+) pick status: pending, cancelled and done (with the project and its rules); (−) unknown or malformed id is 404', async () => {
    const states = new Map([
      [REQ_ID, { state: 'pending' }],
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { state: 'cancelled' }],
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', { state: 'done', project: w.project }],
    ]);
    const b = await boot({ deps: makeDeps({ picker: { start: () => null, status: (id) => states.get(id) ?? null } }) });
    assert.deepEqual((await b.call('GET', `/api/app/projects/pick/${REQ_ID}`)).body, { state: 'pending' });
    assert.deepEqual((await b.call('GET', '/api/app/projects/pick/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).body, { state: 'cancelled' });
    const done = (await b.call('GET', '/api/app/projects/pick/cccccccc-cccc-4ccc-8ccc-cccccccccccc')).body;
    assert.equal(done.state, 'done');
    assert.equal(done.project.key, w.project.key);
    assert.deepEqual(done.project.rules, { state: 'none', settingsIgnored: false, git: true });
    assert.equal((await b.call('GET', '/api/app/projects/pick/dddddddd-dddd-4ddd-8ddd-dddddddddddd')).status, 404);
    assert.equal((await b.call('GET', '/api/app/projects/pick/not-a-uuid')).status, 404);
    assert.equal((await b.call('GET', '/api/app/projects/pick/..%2F..%2Fetc')).status, 404);
  });

  test('(+) delete removes a project; (−) a second delete, an unknown key and a malformed key are 404; a non-JSON body is 415', async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-api-proj-'));
    try {
      const added = await addProject(extra, w.env);
      assert.equal((await a.call('GET', '/api/app/projects')).body.projects.length, 2);
      assert.equal((await a.call('DELETE', `/api/app/projects/${added.key}`, { body: 'x', headers: { 'content-type': 'text/plain' } })).status, 415);
      const r = await a.call('DELETE', `/api/app/projects/${added.key}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { removed: true });
      assert.deepEqual((await a.call('GET', '/api/app/projects')).body.projects.map((p) => p.key), [w.project.key]);
      assert.equal((await a.call('DELETE', `/api/app/projects/${added.key}`)).status, 404);
      assert.equal((await a.call('DELETE', '/api/app/projects/0123456789abcdef')).status, 404);
      assert.equal((await a.call('DELETE', '/api/app/projects/pick')).status, 404);
      assert.equal((await a.call('DELETE', '/api/app/projects/..%2Fconfig')).status, 404);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });
});

describe('settings', () => {
  let a;
  before(async () => { a = await boot(); });
  const put = (json) => a.call('PUT', '/api/app/settings', { json });

  test('(+) GET returns the config without projects', async () => {
    const r = await a.call('GET', '/api/app/settings');
    assert.equal(r.status, 200);
    assert.equal('projects' in r.body, false);
    assert.equal(r.body.limits.maxAgents, 3);
    assert.equal(r.body.permissionMode, 'default');
  });

  test('(+) PUT merges a partial patch, saves it and answers with the re-read settings; per-project plugins ⊂ installed', async () => {
    const r = await put({ limits: { maxAgents: 2 }, models: { scout: 'haiku' }, plugins: { perProject: { [w.project.key]: ['alpha@market'] } } });
    assert.equal(r.status, 200);
    assert.equal('projects' in r.body, false);
    assert.equal(r.body.limits.maxAgents, 2);
    assert.equal(r.body.models.scout, 'haiku');
    assert.equal(r.body.models.builder, 'claude-sonnet-5-5');
    assert.deepEqual(r.body.plugins.perProject, { [w.project.key]: ['alpha@market'] });
    const disk = (await loadConfig(w.env)).config;
    assert.equal(disk.limits.maxAgents, 2);
    assert.equal(disk.projects.length, 1);
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body, r.body);
    assert.equal((await put({ plugins: { perProject: {} } })).status, 200); // replaces the whole map
  });

  test('(−) bypassPermissions is 400 and nothing is saved', async () => {
    const r = await put({ permissionMode: 'bypassPermissions' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /bypassPermissions/);
    assert.equal((await loadConfig(w.env)).config.permissionMode, 'default');
  });

  test('(−) a perProject key that is not a registered project, an uninstalled plugin and a malformed list are 400', async () => {
    const unknown = await put({ plugins: { perProject: { '0123456789abcdef': ['alpha@market'] } } });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /not a registered project/);
    const missing = await put({ plugins: { perProject: { [w.project.key]: ['alpha@market', 'gamma@market'] } } });
    assert.equal(missing.status, 400);
    assert.match(missing.body.message, /gamma@market is not installed/);
    assert.equal((await put({ plugins: { perProject: { [w.project.key]: 'alpha@market' } } })).status, 400);
    assert.equal((await put({ plugins: { perProject: [] } })).status, 400);
    const proto = await a.call('PUT', '/api/app/settings', { body: '{"plugins":{"perProject":{"__proto__":["alpha@market"]}}}', headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400); // a literal { __proto__: … } would set a prototype instead of sending the key
    assert.deepEqual((await loadConfig(w.env)).config.plugins.perProject, {});
  });

  test('(−) projects, unknown keys, bad values and a __proto__ key are 400 and name the first bad field', async () => {
    assert.equal((await put({ projects: [] })).status, 400);
    const unknown = await put({ shell: true });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.message, /shell/);
    const bad = await put({ limits: { maxAgents: 99 } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /limits\.maxAgents/);
    assert.equal((await put({ panePlacement: 'floating' })).status, 400);
    const proto = await a.call('PUT', '/api/app/settings', { body: '{"__proto__":{"limits":{"maxAgents":8}}}', headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400);
    assert.equal(({}).limits, undefined);
    assert.equal((await loadConfig(w.env)).config.limits.maxAgents, 2);
  });

  test('(+) ui.theme: default system; light, dark and system are saved and read back', async () => {
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.ui, { theme: 'system' });
    for (const theme of ['dark', 'light', 'system']) {
      const r = await put({ ui: { theme } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.ui, { theme });
      assert.equal((await loadConfig(w.env)).config.ui.theme, theme);
      assert.deepEqual((await a.call('GET', '/api/app/settings')).body.ui, { theme });
    }
  });

  test('(−) ui.theme: a bad value, a non-object ui and an unknown ui key are 400 naming the field; the saved theme stays', async () => {
    assert.equal((await put({ ui: { theme: 'dark' } })).status, 200);
    const bad = await put({ ui: { theme: 'sepia' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /ui\.theme/);
    for (const patch of [{ ui: { theme: null } }, { ui: { theme: 1 } }, { ui: 'dark' }, { ui: { accent: 'red' } }]) {
      assert.equal((await put(patch)).status, 400, JSON.stringify(patch));
    }
    assert.equal((await loadConfig(w.env)).config.ui.theme, 'dark');
    assert.equal((await put({ ui: { theme: 'system' } })).status, 200);
  });

  test('(−) POST /settings is 405; a text/plain PUT is 415', async () => {
    assert.equal((await a.call('POST', '/api/app/settings', { json: {} })).status, 405);
    assert.equal((await a.call('PUT', '/api/app/settings', { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  });
});

describe('templates', () => {
  const secretBody = 'TEMPLATE-BODY-MUST-NOT-LEAK {{models.builder}}\n';
  /** A server whose config dir is fresh; `files(dir)` builds the templates folder (or nothing). */
  async function withTemplates(files) {
    const cfg = fs.mkdtempSync(path.join(fx.root, 'cfg-'));
    const dir = path.join(configDir({ NIKA_CONFIG_DIR: cfg }), 'templates'); // <cfg>/nika/templates
    if (files) {
      fs.mkdirSync(dir, { recursive: true });
      files(dir);
    }
    return { ...(await boot({ ctxOver: { env: { NIKA_CONFIG_DIR: cfg } } })), dir, cfg };
  }
  const names = async (a) => (await a.call('GET', '/api/app/templates')).body.templates;

  test('(+) lists the file names in configDir/templates, sorted, and nothing else', async () => {
    const a = await withTemplates((dir) => {
      for (const n of ['b.md', 'a.md', 'Z_9-x.md', `${'n'.repeat(64)}.md`]) fs.writeFileSync(path.join(dir, n), secretBody);
    });
    const r = await a.call('GET', '/api/app/templates');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { templates: ['Z_9-x.md', 'a.md', 'b.md', `${'n'.repeat(64)}.md`] });
    assert.deepEqual(Object.keys(r.body), ['templates']);
    assert.equal(r.raw.includes('MUST-NOT-LEAK'), false, 'no contents');
    assert.equal(r.raw.includes(a.cfg), false, 'no paths');
  });

  test('(+) [] when the templates folder or the whole config dir is missing; an empty folder is []', async () => {
    assert.deepEqual(await names(await withTemplates(null)), []);
    assert.deepEqual(await names(await withTemplates(() => {})), []);
    const gone = await withTemplates(null);
    fs.rmSync(gone.cfg, { recursive: true });
    assert.deepEqual(await names(gone), []);
  });

  test('(−) names that do not match ^[A-Za-z0-9_-]{1,64}\\.md$ are left out', async () => {
    const a = await withTemplates((dir) => {
      for (const n of ['ok.md', 'x.txt', '.hidden.md', 'a b.md', 'a.md.bak', 'a.MD', 'ünï.md', '.md', `${'n'.repeat(65)}.md`, 'a;b.md', 'README']) fs.writeFileSync(path.join(dir, n), 'x');
    });
    assert.deepEqual(await names(a), ['ok.md']);
  });

  test('(−) a symlink, a folder, a FIFO and a hard-linked file are not templates (fsafe)', async () => {
    const a = await withTemplates((dir) => {
      fs.writeFileSync(path.join(dir, 'real.md'), 'x');
      fs.writeFileSync(path.join(fx.root, 'outside.txt'), 'x');
      fs.symlinkSync(path.join(fx.root, 'outside.txt'), path.join(dir, 'link.md'));
      fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'alias.md'));
      fs.mkdirSync(path.join(dir, 'folder.md'));
      execFileSync('mkfifo', [path.join(dir, 'pipe.md')]);
      fs.writeFileSync(path.join(fx.root, 'shared.txt'), 'x');
      fs.linkSync(path.join(fx.root, 'shared.txt'), path.join(dir, 'hard.md'));
    });
    assert.deepEqual(await names(a), ['real.md']);
  });

  test('(−) a templates folder that is a symlink is not followed: []', async () => {
    const cfg = fs.mkdtempSync(path.join(fx.root, 'cfg-'));
    const real = fs.mkdtempSync(path.join(fx.root, 'elsewhere-'));
    fs.writeFileSync(path.join(real, 'a.md'), 'x');
    fs.mkdirSync(path.join(cfg, 'nika'));
    fs.symlinkSync(real, path.join(cfg, 'nika', 'templates'));
    const a = await boot({ ctxOver: { env: { NIKA_CONFIG_DIR: cfg } } });
    assert.deepEqual(await names(a), []);
  });

  test('(−) at most 50 names: the first 50 in sorted order', async () => {
    const all = Array.from({ length: 60 }, (_, i) => `t${String(i).padStart(2, '0')}.md`);
    const a = await withTemplates((dir) => { for (const n of all) fs.writeFileSync(path.join(dir, n), 'x'); });
    assert.deepEqual(await names(a), all.slice(0, 50));
  });

  test('(−) invalid files do not use up the 50: a folder of broken entries ahead of good ones still lists the good ones', async () => {
    const a = await withTemplates((dir) => {
      for (let i = 0; i < 55; i += 1) fs.mkdirSync(path.join(dir, `a${String(i).padStart(2, '0')}.md`));
      fs.writeFileSync(path.join(dir, 'z.md'), 'x');
    });
    assert.deepEqual(await names(a), ['z.md']);
  });

  test('(−) POST is 405 (Allow: GET); without the secret it is 403', async () => {
    const a = await withTemplates(() => {});
    const m = await a.call('POST', '/api/app/templates', { json: {} });
    assert.equal(m.status, 405);
    assert.equal(m.headers.allow, 'GET');
    assert.equal((await a.call('GET', '/api/app/templates', { headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('GET', '/api/app/templates/')).status, 404);
  });
});

describe('history', () => {
  test('(+) passes the id, before, limit and one shared cache to the module and relays its answer', async () => {
    const a = await boot();
    const r = await a.call('GET', `/api/app/session/${SID.busy}/history?before=10&limit=5`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { entries: [], nextBefore: null });
    await a.call('GET', `/api/app/session/${SID.busy}/history`);
    const [first, second] = a.deps.calls.filter((c) => c[0] === 'readHistory');
    assert.deepEqual(first.slice(1, 3), [SID.busy, { before: '10', limit: '5' }]);
    assert.deepEqual(second.slice(2, 3), [{ before: undefined, limit: undefined }]);
    assert.equal(first[3].claudeDir, a.ctx.claudeDir);
    assert.equal(first[3].cache, second[3].cache);
    assert.equal(typeof first[3].now, 'function');
  });

  test('(−) a non-UUID id is 404 without calling the module; the module\'s own 400 is relayed', async () => {
    const a = await boot();
    assert.equal((await a.call('GET', '/api/app/session/..%2F..%2Fetc%2Fpasswd/history')).status, 404);
    assert.equal((await a.call('GET', '/api/app/session/not-a-uuid/history')).status, 404);
    assert.equal(a.deps.calls.some((c) => c[0] === 'readHistory'), false);
    assert.equal((await a.call('GET', `/api/app/session/${SID.busy}/history?limit=0`)).status, 400);
    assert.equal((await a.call('POST', `/api/app/session/${SID.busy}/history`, { json: {} })).status, 405);
  });

  test('(+) with the real module a transcript from nika\'s index is paged; (−) an id outside the index is 404', async () => {
    const a = await boot({ deps: makeDeps({ readHistory }) });
    const r = await a.call('GET', `/api/app/session/${SID.busy}/history?limit=10`);
    assert.equal(r.status, 200);
    assert.equal(r.body.entries[0].role, 'user');
    assert.equal(r.body.entries[0].text, 'synthetic prompt');
    assert.equal((await a.call('GET', '/api/app/session/99999999-9999-4999-8999-999999999999/history')).status, 404);
  });
});

describe('pane capture and keys', () => {
  test('(+) a live Claude pane is captured with an ETag; If-None-Match gives 304 with an empty body', async () => {
    const a = await boot();
    const r = await a.call('GET', '/api/app/pane/%256/capture');
    assert.equal(r.status, 200);
    assert.equal(r.headers.etag, '"abc"');
    assert.equal(r.body.etag, 'abc');
    assert.equal(a.deps.calls.find((c) => c[0] === 'capture')[1], '%6');
    const again = await a.call('GET', '/api/app/pane/%256/capture', { headers: { 'if-none-match': '"abc"' } });
    assert.equal(again.status, 304);
    assert.equal(again.raw, '');
    assert.equal(again.headers.etag, '"abc"');
  });

  test('(+) a pane nika started is eligible; the unencoded %-form of the id works too', async () => {
    const a = await boot();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    assert.equal((await a.call('GET', '/api/app/pane/%258/capture')).status, 200);
    assert.equal((await a.call('GET', '/api/app/pane/%8/capture')).status, 200);
  });

  test('(−) a pane that is not in the tmux list, is not live Claude, was not started, or has a bad id is 404 and never reaches tmux', async () => {
    const a = await boot();
    a.ctx.started.set('%99', { key: w.project.key, name: 'gone', sessionId: null, role: 'agent' });
    for (const id of ['%2599', '%255', '%257', '%25', 'abc', '%25%25', '%2512345678', '..%2F..']) {
      const r = await a.call('GET', `/api/app/pane/${id}/capture`);
      assert.equal(r.status, 404, id);
      assert.equal(r.body.error, 'not_found');
    }
    assert.equal((await a.call('POST', '/api/app/pane/%255/keys', { json: { text: 'x' } })).status, 404);
    assert.equal(a.deps.calls.some((c) => c[0] === 'capture' || c[0] === 'keys'), false);
    assert.equal(a.ctx.started.has('%99'), false); // a stale entry is dropped: tmux ids restart with the server
  });

  test('(−) a forged registry entry pointing at a shell pane is not eligible: the live pane must run claude', async () => {
    const a = await boot();
    for (const command of ['zsh', 'bash', 'vim', '', 'claudex']) {
      a.deps.state.panes = new Map([['%6', { command }]]);
      a.deps.calls.length = 0;
      const now = a.ctx.now;
      a.ctx.now = () => now() + 10_000; // past the eligibility cache
      assert.equal((await a.call('GET', '/api/app/pane/%256/capture')).status, 404, command);
      assert.equal((await a.call('POST', '/api/app/pane/%256/keys', { json: { text: 'rm -rf x' } })).status, 404, command);
      assert.equal(a.deps.calls.some((c) => c[0] === 'capture' || c[0] === 'keys'), false, command);
    }
    for (const command of ['claude', 'node', '2.1.319']) {
      a.deps.state.panes = new Map([['%6', { command }]]);
      const now = a.ctx.now;
      a.ctx.now = () => now() + 10_000;
      assert.equal((await a.call('GET', '/api/app/pane/%256/capture')).status, 200, command);
    }
  });

  test('(+) a started pane that runs claude, node (npm install, _run-agent) or a native version string is eligible for capture and keys', async () => {
    const a = await boot();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    for (const command of ['claude', 'node', '2.1.319']) {
      a.deps.state.panes = new Map([['%8', { command }]]);
      a.clock.t += 2000; // past the eligibility cache
      assert.equal((await a.call('GET', '/api/app/pane/%258/capture')).status, 200, command);
      assert.equal((await a.call('POST', '/api/app/pane/%258/keys', { json: { text: 'hi' } })).status, 200, command);
    }
  });

  test('(−) a started pane whose id is now a shell (tmux reused it) is 404 for capture and keys and never reaches tmux; the record is kept while the pane exists', async () => {
    const a = await boot();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    for (const command of ['zsh', 'bash', 'vim', '', 'claudex']) {
      a.deps.state.panes = new Map([['%8', { command }]]);
      a.deps.calls.length = 0;
      a.clock.t += 2000;
      assert.equal((await a.call('GET', '/api/app/pane/%258/capture')).status, 404, command);
      assert.equal((await a.call('POST', '/api/app/pane/%258/keys', { json: { text: 'rm -rf x' } })).status, 404, command);
      assert.equal(a.deps.calls.some((c) => c[0] === 'capture' || c[0] === 'keys'), false, command);
    }
    a.deps.state.panes = new Map([['%8', { command: 'node' }]]);
    a.clock.t += 2000;
    assert.equal((await a.call('GET', '/api/app/pane/%258/capture')).status, 200); // it runs claude again
  });

  test('(−) when tmux cannot be listed nothing is eligible: 404 that says why; started entries are kept', async () => {
    const a = await boot();
    a.deps.state.panes = new Map();
    a.deps.state.error = 'tmux unavailable: no server running';
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    const r = await a.call('GET', '/api/app/pane/%256/capture');
    assert.equal(r.status, 404);
    assert.match(r.body.message, /tmux unavailable/);
    assert.equal(a.ctx.started.has('%8'), true);
  });

  test('(+) the pane list and the live snapshot are cached for ~1 s: four captures run collect() once', async () => {
    const a = await boot();
    for (let i = 0; i < 4; i += 1) assert.equal((await a.call('GET', '/api/app/pane/%256/capture')).status, 200);
    assert.equal(a.deps.calls.filter((c) => c[0] === 'collect').length, 1);
    assert.equal(a.deps.calls.filter((c) => c[0] === 'listPanes').length, 1);
    a.clock.t += 1100;
    await a.call('GET', '/api/app/pane/%256/capture');
    assert.equal(a.deps.calls.filter((c) => c[0] === 'collect').length, 2);
  });

  test('(+) a failing collect() leaves started panes eligible; (−) the module\'s 502/503 are relayed', async () => {
    const a = await boot({ deps: makeDeps({ collect: async () => { throw new Error('ps'); } }) });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    assert.equal((await a.call('GET', '/api/app/pane/%258/capture')).status, 200);
    assert.equal((await a.call('GET', '/api/app/pane/%256/capture')).status, 404);
    const b = await boot({ deps: makeDeps({ mirror: { capture: async () => ({ status: 503, body: { error: 'tmux_unavailable', message: 'x' } }) } }) });
    assert.equal((await b.call('GET', '/api/app/pane/%256/capture')).status, 503);
    assert.equal((await b.call('POST', '/api/app/pane/%256/capture', { json: {} })).status, 405);
  });

  test('(+) keys: an eligible pane gets text, paste and keys; the module\'s answer is relayed', async () => {
    const a = await boot();
    const r = await a.call('POST', '/api/app/pane/%256/keys', { json: { text: 'hi', keys: ['Enter'], extra: 'dropped' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { sent: { text: 1, paste: 0, keys: 0 } });
    const call = a.deps.calls.find((c) => c[0] === 'keys');
    assert.deepEqual(call.slice(1), ['%6', { text: 'hi', paste: undefined, keys: ['Enter'] }]);
  });

  test('(−) keys: module 400 and 429 are relayed, a body over 20 KB is 413, a non-JSON body is 415', async () => {
    const a = await boot();
    assert.equal((await a.call('POST', '/api/app/pane/%256/keys', { json: { text: 'bad' } })).status, 400);
    assert.equal((await a.call('POST', '/api/app/pane/%256/keys', { json: { text: 'busy' } })).status, 429);
    assert.equal((await a.call('POST', '/api/app/pane/%256/keys', { json: { paste: 'x'.repeat(21 * 1024) } })).status, 413);
    assert.equal((await a.call('POST', '/api/app/pane/%256/keys', { body: 'text=x', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await a.call('GET', '/api/app/pane/%256/keys')).status, 405);
  });
});

describe('spawn and orchestrator', () => {
  test('(+) spawn passes the body and the shared ctx to the module and relays the answer', async () => {
    const a = await boot();
    const body = { project: w.project.key, name: 'builder-1', model: 'sonnet', brief: 'Do it.' };
    const r = await a.call('POST', '/api/app/spawn', { json: body });
    assert.equal(r.status, 200);
    assert.equal(r.body.pane, '%9');
    const call = a.deps.calls.find((c) => c[0] === 'spawnAgent');
    assert.deepEqual(call[1], body);
    assert.equal(call[2], a.ctx);
  });

  test('(−) spawn: bypassPermissions is 400 and never reaches the module; module 409 is relayed; arrays are 400', async () => {
    const a = await boot();
    const r = await a.call('POST', '/api/app/spawn', { json: { project: w.project.key, name: 'x', model: 'sonnet', brief: 'b', permissionMode: 'bypassPermissions' } });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /bypassPermissions/);
    assert.equal(a.deps.calls.some((c) => c[0] === 'spawnAgent'), false);
    assert.equal((await a.call('POST', '/api/app/spawn', { json: { name: 'full' } })).status, 409);
    assert.equal((await a.call('POST', '/api/app/spawn', { body: '[]', headers: { 'content-type': 'application/json' } })).status, 400);
  });

  test('(+) a successful spawn makes its new pane eligible at once, without waiting for the 1 s cache', async () => {
    const a = await boot();
    assert.equal((await a.call('GET', '/api/app/pane/%259/capture')).status, 404); // not in the (now cached) list yet
    a.deps.state.panes = new Map([...a.deps.state.panes, ['%9', { command: 'node' }]]); // an agent pane runs `_run-agent` as node
    a.ctx.started.set('%9', { key: w.project.key, name: 'new', sessionId: null, role: 'agent' });
    assert.equal((await a.call('GET', '/api/app/pane/%259/capture')).status, 404); // still the cached list
    assert.equal((await a.call('POST', '/api/app/spawn', { json: { name: 'new' } })).status, 200);
    assert.equal((await a.call('GET', '/api/app/pane/%259/capture')).status, 200);
  });

  test('(+) orchestrator/start calls the module with the project key and ctx', async () => {
    const a = await boot();
    const r = await a.call('POST', '/api/app/orchestrator/start', { json: { project: w.project.key } });
    assert.equal(r.status, 200);
    assert.equal(r.body.created, true);
    const call = a.deps.calls.find((c) => c[0] === 'startOrchestrator');
    assert.equal(call[1], w.project.key);
    assert.equal(call[2], a.ctx);
  });

  test('(−) orchestrator/start: a missing or malformed project is 400, an unregistered one 404, the module\'s 503 is relayed', async () => {
    const a = await boot();
    for (const project of [undefined, 5, '../x', 'ABCDEF0123456789', '']) {
      assert.equal((await a.call('POST', '/api/app/orchestrator/start', { json: { project } })).status, 400, String(project));
    }
    assert.equal((await a.call('POST', '/api/app/orchestrator/start', { json: { project: '0123456789abcdef' } })).status, 404);
    assert.equal(a.deps.calls.some((c) => c[0] === 'startOrchestrator'), false);
    assert.equal((await a.call('GET', '/api/app/orchestrator/start')).status, 405);
    const down = await boot({ deps: makeDeps({ startOrchestrator: async () => ({ status: 503, body: { error: 'tmux_unavailable', message: 'x' } }) }) });
    const r = await down.call('POST', '/api/app/orchestrator/start', { json: { project: w.project.key } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'tmux_unavailable');
  });
});

describe('rules', () => {
  test('(+) preview calls the module with the registered project and ctx', async () => {
    const a = await boot();
    const r = await a.call('POST', '/api/app/rules/preview', { json: { project: w.project.key } });
    assert.equal(r.status, 200);
    assert.equal(r.body.hash, 'h');
    const call = a.deps.calls.find((c) => c[0] === 'preview');
    assert.equal(call[1].key, w.project.key);
    assert.equal(call[1].dir, w.project.dir);
    assert.equal(call[2], a.ctx);
  });

  test('(−) preview: malformed project 400, unregistered 404, GET 405', async () => {
    const a = await boot();
    assert.equal((await a.call('POST', '/api/app/rules/preview', { json: {} })).status, 400);
    assert.equal((await a.call('POST', '/api/app/rules/preview', { json: { project: '../etc' } })).status, 400);
    assert.equal((await a.call('POST', '/api/app/rules/preview', { json: { project: '0123456789abcdef' } })).status, 404);
    assert.equal((await a.call('GET', '/api/app/rules/preview')).status, 405);
    assert.equal(a.deps.calls.some((c) => c[0] === 'preview'), false);
  });

  test('(+) apply passes only hash, overwriteForeign and gitignore to the module', async () => {
    const a = await boot();
    const r = await a.call('POST', '/api/app/rules/apply', { json: { project: w.project.key, hash: 'h1', overwriteForeign: true, gitignore: false, path: '/etc/passwd' } });
    assert.equal(r.status, 200);
    const call = a.deps.calls.find((c) => c[0] === 'apply');
    assert.deepEqual(call[2], { hash: 'h1', overwriteForeign: true, gitignore: false });
    assert.equal(call[3], a.ctx);
  });

  test('(−) apply: the module\'s 409 is relayed; malformed project 400; unregistered 404; PUT 405', async () => {
    const a = await boot();
    assert.equal((await a.call('POST', '/api/app/rules/apply', { json: { project: w.project.key, hash: 'stale' } })).status, 409);
    assert.equal((await a.call('POST', '/api/app/rules/apply', { json: { hash: 'h' } })).status, 400);
    assert.equal((await a.call('POST', '/api/app/rules/apply', { json: { project: '0123456789abcdef', hash: 'h' } })).status, 404);
    assert.equal((await a.call('PUT', '/api/app/rules/apply', { json: {} })).status, 405);
  });
});
