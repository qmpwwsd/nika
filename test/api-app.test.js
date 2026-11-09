// /api/app/*: the privileged guard and every route, with injected fake modules, a real server on 127.0.0.1:0 and the real
// store in temp dirs. Synthetic data only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';
import { createAppApi } from '../src/api-app.js';
import { readHistory } from '../src/collect/history.js';
import { loadConfig, addProject } from '../src/store.js';
import { configDir, stateDir } from '../src/paths.js';
import { lastNonBlank, modeFromRows, PROMPT_ROWS } from '../src/mode.js';
import { MODEL_CATALOG } from '../src/models.js';
import { makeWorld } from './tmux-fake.js';
import { makeFixture, cleanup, SID } from './helpers.js';

const SECRET = 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9v'.slice(0, 43);
const REQ_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WRONG_SAME_LENGTH = 'x'.repeat(SECRET.length);
const APP_COPY = { state: 'missing', managed: false, dismissed: false, version: null, available: '9.9.9', running: false };
const SNAPSHOT = { groups: [{ agents: [{ live: true, state: 'idle', pane: { id: '%6' } }, { live: false, state: 'ended', pane: { id: '%7' } }, { live: true, state: 'idle', pane: null }] }] };

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
    appCopy: {
      state: rec('appCopyState', async () => APP_COPY),
      install: rec('appCopyInstall', async () => ({ state: 'current', version: '9.9.9', restart: false, changed: 'added' })),
      dismiss: rec('appCopyDismiss', async () => {}),
    },
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
      tier: 'app', version: '9.9.9', platform: process.platform, tmux: true, claude: true, configDir: configDir(w.env), stateDir: stateDir(w.env), appCopy: APP_COPY,
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

describe('app copy (ADR 0011)', () => {
  const bodyOf = (r) => r.body;

  test('(+) me carries appCopy from the module; (−) a module that throws leaves me working with a "no-source" copy', async () => {
    const a = await boot();
    assert.deepEqual((await a.call('GET', '/api/app/me')).body.appCopy, APP_COPY);
    const b = await boot({ deps: makeDeps({ appCopy: { ...makeDeps().appCopy, state: async () => { throw new Error('/some/private/path exploded'); } } }) });
    const r = await b.call('GET', '/api/app/me');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.appCopy, { state: 'no-source', managed: false, dismissed: false, version: null, available: null, running: false });
    assert.equal(r.raw.includes('exploded'), false);
  });

  test('(+) install answers 200 with the module result (restart false or true); the request carries no path to the module', async () => {
    const a = await boot();
    const r = await a.call('POST', '/api/app/app-copy', { json: { action: 'install' } });
    assert.equal(r.status, 200);
    assert.deepEqual(bodyOf(r), { state: 'current', version: '9.9.9', restart: false });
    assert.deepEqual(a.deps.calls.filter((c) => c[0] === 'appCopyInstall'), [['appCopyInstall']], 'called with no argument at all');
    const b = await boot({ deps: makeDeps({ appCopy: { ...makeDeps().appCopy, install: async () => ({ state: 'current', version: '9.9.9', restart: true, changed: 'updated' }) } }) });
    assert.equal((await b.call('POST', '/api/app/app-copy', { json: { action: 'install' } })).body.restart, true);
  });

  test('(+) dismiss records "Not now" and does not copy', async () => {
    const a = await boot();
    const r = await a.call('POST', '/api/app/app-copy', { json: { action: 'dismiss' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { dismissed: true });
    assert.deepEqual(a.deps.calls.filter((c) => c[0].startsWith('appCopy')).map((c) => c[0]), ['appCopyDismiss']);
  });

  test('(−) any other body is 400 invalid and reaches no module: unknown action, missing, non-string, extra keys, a path', async () => {
    const a = await boot();
    for (const json of [{}, { action: 'remove' }, { action: 'Install' }, { action: ['install'] }, { action: 1 }, { action: null }, { action: 'install', source: '/x' }, { action: 'install', path: '/x' }, { source: '/x' }]) {
      const r = await a.call('POST', '/api/app/app-copy', { json });
      assert.equal(r.status, 400, JSON.stringify(json));
      assert.equal(r.body.error, 'invalid');
    }
    assert.deepEqual(a.deps.calls.filter((c) => c[0].startsWith('appCopy')), []);
  });

  test('(+) a copy whose marker could not be written is still 200 with the contract\'s three fields', async () => {
    const a = await boot({ deps: makeDeps({ appCopy: { ...makeDeps().appCopy, install: async () => ({ state: 'current', version: '9.9.9', restart: false, changed: 'added', recorded: false }) } }) });
    const r = await a.call('POST', '/api/app/app-copy', { json: { action: 'install' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { state: 'current', version: '9.9.9', restart: false });
  });

  test('(−) the module\'s refusals are 409 with a fixed body: foreign-target, no-source, copy-busy, unsupported', async () => {
    for (const code of ['foreign-target', 'no-source', 'copy-busy', 'unsupported']) {
      const a = await boot({ deps: makeDeps({ appCopy: { ...makeDeps().appCopy, install: async () => { throw Object.assign(new Error(code), { code }); } } }) });
      const r = await a.call('POST', '/api/app/app-copy', { json: { action: 'install' } });
      assert.equal(r.status, 409, code);
      assert.equal(r.body.error, code);
      assert.equal(typeof r.body.message, 'string');
      if (code === 'foreign-target') assert.equal(r.body.message, "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace");
    }
  });

  test('(−) copy-failed and any unexpected error are 500 copy-failed with fixed text: no path, no OS error text', async () => {
    for (const thrown of [Object.assign(new Error('copy-failed'), { code: 'copy-failed' }), Object.assign(new Error('EACCES: /some/private/path/nika.app'), { code: 'EACCES' }), new Error('boom')]) {
      const a = await boot({ deps: makeDeps({ appCopy: { ...makeDeps().appCopy, install: async () => { throw thrown; } } }) });
      const r = await a.call('POST', '/api/app/app-copy', { json: { action: 'install' } });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, 'copy-failed');
      assert.equal(r.raw.includes('private'), false);
      assert.equal(r.raw.includes('EACCES'), false);
    }
    const d = await boot({ deps: makeDeps({ appCopy: { ...makeDeps().appCopy, dismiss: async () => { throw new Error('/some/private/path'); } } }) });
    const r = await d.call('POST', '/api/app/app-copy', { json: { action: 'dismiss' } });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'dismiss-failed', 'its own code, not the copy-failed text');
    assert.equal(r.body.message.includes('copy'), false);
    assert.equal(r.raw.includes('private'), false);
  });

  test('(−) the guard applies: no secret 403, text/plain 415, a body over 4 KB 413, GET 405', async () => {
    const a = await boot();
    assert.equal((await a.call('POST', '/api/app/app-copy', { json: { action: 'install' }, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('POST', '/api/app/app-copy', { json: { action: 'install' }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await a.call('POST', '/api/app/app-copy', { body: '{"action":"install"}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await a.call('POST', '/api/app/app-copy', { json: { action: 'install', pad: 'x'.repeat(4200) } })).status, 413);
    const get = await a.call('GET', '/api/app/app-copy');
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.deepEqual(a.deps.calls.filter((c) => c[0] === 'appCopyInstall'), []);
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

describe('project config (GET|PUT /api/app/projects/:key/config)', () => {
  let a;
  let extra;
  const url = (key = w.project.key) => `/api/app/projects/${key}/config`;
  before(async () => {
    a = await boot();
    extra = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-api-pcfg-'));
  });
  after(() => fs.rmSync(extra, { recursive: true, force: true }));
  const put = (json, key) => a.call('PUT', url(key), { json });

  test('(+) GET answers { plugins: [] } for a project without a list', async () => {
    const r = await a.call('GET', url());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { plugins: [] });
    assert.match(r.headers['cache-control'] ?? '', /no-store/);
  });

  test('(+) PUT saves installed plugins and answers 200 { plugins }; GET and the settings read them back', async () => {
    const r = await put({ plugins: ['beta@market', 'alpha@market'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { plugins: ['beta@market', 'alpha@market'] });
    assert.deepEqual((await a.call('GET', url())).body, { plugins: ['beta@market', 'alpha@market'] });
    assert.deepEqual((await loadConfig(w.env)).config.perProject[w.project.key], { plugins: ['beta@market', 'alpha@market'] });
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.perProject[w.project.key], { plugins: ['beta@market', 'alpha@market'] });
  });

  test('(+) a name that is saved but no longer installed is accepted again; [] removes the list', async () => {
    assert.equal((await put({ plugins: ['alpha@market', 'beta@market'] })).status, 200);
    const gone = await boot({ deps: makeDeps({ listPlugins: async () => ['alpha@market'] }) }); // beta@market was uninstalled since
    const r = await gone.call('PUT', url(), { json: { plugins: ['alpha@market', 'beta@market'] } });
    assert.equal(r.status, 200, 'beta@market is saved for this project, so it stays allowed');
    assert.deepEqual(r.body, { plugins: ['alpha@market', 'beta@market'] });
    const cleared = await put({ plugins: [] });
    assert.deepEqual([cleared.status, cleared.body], [200, { plugins: [] }]);
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
  });

  test('(−) a name that is neither installed nor already saved for that project is 400 and nothing changes', async () => {
    assert.equal((await put({ plugins: ['alpha@market'] })).status, 200);
    const r = await put({ plugins: ['alpha@market', 'gamma@market'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid');
    assert.match(r.body.message, /gamma@market is not installed/);
    assert.deepEqual((await a.call('GET', url())).body, { plugins: ['alpha@market'] });
    // "saved" is per project: a name saved for another project does not make it known here
    const other = await addProject(extra, w.env);
    const gone = await boot({ deps: makeDeps({ listPlugins: async () => [] }) });
    assert.equal((await gone.call('PUT', url(other.key), { json: { plugins: ['alpha@market'] } })).status, 400);
    assert.equal((await gone.call('PUT', url(), { json: { plugins: ['alpha@market'] } })).status, 200);
    await a.call('DELETE', `/api/app/projects/${other.key}`);
    assert.equal((await put({ plugins: [] })).status, 200);
  });

  test('(−) an unknown project is 404 not_found, a malformed key is 400, for GET and PUT', async () => {
    for (const call of [() => a.call('GET', url('0123456789abcdef')), () => put({ plugins: [] }, '0123456789abcdef')]) {
      const r = await call();
      assert.equal(r.status, 404);
      assert.equal(r.body.error, 'not_found');
    }
    for (const key of ['short', '0123456789ABCDEF', '0123456789abcdef0', '..%2F..%2Fetc', '%5Fx']) {
      assert.equal((await a.call('GET', url(key))).status, 400, `GET ${key}`);
      assert.equal((await put({ plugins: [] }, key)).status, 400, `PUT ${key}`);
    }
    assert.equal((await a.call('DELETE', url())).status, 405);
  });

  test('(−) a body that is not { plugins: [names] } is 400: wrong type, extra key, bad name, over 200, __proto__', async () => {
    for (const body of [{}, { plugins: 'alpha@market' }, { plugins: null }, { plugins: [5] }, { plugins: [['alpha@market']] }, { plugins: ['alpha@market'], models: {} }, { models: {} }, { plugins: Array.from({ length: 201 }, () => 'alpha@market') }]) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(r.body.error, 'invalid');
    }
    const longName = await put({ plugins: [`${'x'.repeat(300)}@market`] });
    assert.equal(longName.status, 400);
    assert.ok(longName.body.message.length < 120, 'the plugin name in the message is cut');
    const proto = await a.call('PUT', url(), { body: '{"__proto__":{"plugins":["alpha@market"]}}', headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400);
    assert.deepEqual((await a.call('GET', url())).body, { plugins: [] });
  });

  test('(−) PUT needs application/json (415), stays within 16 KB (413) and needs the app secret (403)', async () => {
    assert.equal((await a.call('PUT', url(), { body: '{"plugins":[]}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await a.call('PUT', url(), { body: '{"plugins":[]}', headers: { 'content-type': null } })).status, 415);
    assert.equal((await a.call('PUT', url(), { body: JSON.stringify({ plugins: [], pad: 'x'.repeat(17 * 1024) }), headers: { 'content-type': 'application/json' } })).status, 413);
    assert.equal((await a.call('PUT', url(), { json: { plugins: [] }, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('GET', url(), { headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('PUT', url(), { json: { plugins: [] }, headers: { origin: 'http://evil.example' } })).status, 403);
  });

  test('(+) removing a project drops its list: a later GET is 404 and the config has no entry', async () => {
    const p = await addProject(extra, w.env);
    assert.equal((await put({ plugins: ['alpha@market'] }, p.key)).status, 200);
    assert.deepEqual((await loadConfig(w.env)).config.perProject[p.key], { plugins: ['alpha@market'] });
    assert.equal((await a.call('DELETE', `/api/app/projects/${p.key}`)).status, 200);
    assert.equal((await a.call('GET', url(p.key))).status, 404);
    assert.equal(p.key in (await loadConfig(w.env)).config.perProject, false);
  });
});

describe('settings', () => {
  let a;
  before(async () => { a = await boot(); });
  const put = (json) => a.call('PUT', '/api/app/settings', { json });

  test('(+) GET returns the config without projects, with perProject (an empty map to start with) and no plugins group', async () => {
    const r = await a.call('GET', '/api/app/settings');
    assert.equal(r.status, 200);
    assert.equal('projects' in r.body, false);
    assert.equal('plugins' in r.body, false);
    assert.deepEqual(r.body.perProject, {});
    assert.equal(r.body.limits.maxAgents, 3);
    assert.equal(r.body.permissionMode, 'default');
  });

  test('(+) GET shows the plugins saved for a project under perProject[key].plugins', async () => {
    await a.call('PUT', `/api/app/projects/${w.project.key}/config`, { json: { plugins: ['alpha@market'] } });
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.perProject, { [w.project.key]: { plugins: ['alpha@market'] } });
    await a.call('PUT', `/api/app/projects/${w.project.key}/config`, { json: { plugins: [] } });
  });

  test('(+) PUT merges a partial patch, saves it and answers with the re-read settings', async () => {
    const r = await put({ limits: { maxAgents: 2 }, models: { scout: 'haiku' } });
    assert.equal(r.status, 200);
    assert.equal('projects' in r.body, false);
    assert.equal(r.body.limits.maxAgents, 2);
    assert.equal(r.body.models.scout, 'haiku');
    assert.equal(r.body.models.builder, 'claude-sonnet-5-5');
    const disk = (await loadConfig(w.env)).config;
    assert.equal(disk.limits.maxAgents, 2);
    assert.equal(disk.projects.length, 1);
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body, r.body);
  });

  test('(−) bypassPermissions is 400 and nothing is saved', async () => {
    const r = await put({ permissionMode: 'bypassPermissions' });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /bypassPermissions/);
    assert.equal((await loadConfig(w.env)).config.permissionMode, 'default');
  });

  test('(−) a body with perProject or the old plugins group is 400 and the project config is not touched', async () => {
    await a.call('PUT', `/api/app/projects/${w.project.key}/config`, { json: { plugins: ['alpha@market'] } });
    const mine = await put({ perProject: { [w.project.key]: { plugins: ['beta@market'] } } });
    assert.equal(mine.status, 400);
    assert.match(mine.body.message, /project page/);
    for (const body of [{ perProject: {} }, { perProject: [] }, { plugins: { perProject: { [w.project.key]: ['beta@market'] } } }, { plugins: [] }]) {
      assert.equal((await put(body)).status, 400, JSON.stringify(body));
    }
    const proto = await a.call('PUT', '/api/app/settings', { body: '{"perProject":{"__proto__":{"plugins":["alpha@market"]}}}', headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400);
    assert.deepEqual((await loadConfig(w.env)).config.perProject, { [w.project.key]: { plugins: ['alpha@market'] } });
    await a.call('PUT', `/api/app/projects/${w.project.key}/config`, { json: { plugins: [] } });
  });

  test('(+) a settings save leaves the project config alone (the page no longer sends plugins)', async () => {
    await a.call('PUT', `/api/app/projects/${w.project.key}/config`, { json: { plugins: ['beta@market'] } });
    assert.equal((await put({ limits: { maxAgents: 2 } })).status, 200);
    assert.deepEqual((await loadConfig(w.env)).config.perProject, { [w.project.key]: { plugins: ['beta@market'] } });
    await a.call('PUT', `/api/app/projects/${w.project.key}/config`, { json: { plugins: [] } });
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
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.ui, { theme: 'system', singleKeyShortcuts: true });
    for (const theme of ['dark', 'light', 'system']) {
      const r = await put({ ui: { theme } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.ui, { theme, singleKeyShortcuts: true });
      assert.equal((await loadConfig(w.env)).config.ui.theme, theme);
      assert.deepEqual((await a.call('GET', '/api/app/settings')).body.ui, { theme, singleKeyShortcuts: true });
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

  test('(+) ui.singleKeyShortcuts: false is saved next to the theme and read back; true restores it', async () => {
    const off = await put({ ui: { singleKeyShortcuts: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.ui.singleKeyShortcuts, false);
    assert.equal((await put({ ui: { theme: 'dark' } })).body.ui.singleKeyShortcuts, false, 'a theme-only PUT keeps the switch');
    assert.equal((await a.call('GET', '/api/app/settings')).body.ui.singleKeyShortcuts, false);
    assert.equal((await loadConfig(w.env)).config.ui.singleKeyShortcuts, false);
    assert.equal((await put({ ui: { theme: 'system', singleKeyShortcuts: true } })).body.ui.singleKeyShortcuts, true);
  });

  test('(−) ui.singleKeyShortcuts: a non-boolean is 400 naming the field; the saved value stays', async () => {
    assert.equal((await put({ ui: { singleKeyShortcuts: false } })).status, 200);
    for (const bad of ['false', 0, null, []]) {
      const r = await put({ ui: { singleKeyShortcuts: bad } });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(r.body.message, /ui\.singleKeyShortcuts/);
    }
    assert.equal((await loadConfig(w.env)).config.ui.singleKeyShortcuts, false);
    assert.equal((await put({ ui: { singleKeyShortcuts: true } })).status, 200);
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
    assert.match(r.body.etag, /^[0-9a-f]{32}$/, 'hex, as the page accepts it');
    assert.equal(r.headers.etag, `"${r.body.etag}"`);
    assert.equal(a.deps.calls.find((c) => c[0] === 'capture')[1], '%6');
    const again = await a.call('GET', '/api/app/pane/%256/capture', { headers: { 'if-none-match': r.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.raw, '');
    assert.equal(again.headers.etag, r.headers.etag);
  });

  test('(−) an If-None-Match that is not the current ETag (the mirror\'s own rows hash included) gets the full 200', async () => {
    const a = await boot();
    const r = await a.call('GET', '/api/app/pane/%256/capture');
    for (const inm of ['"abc"', '"0000"', 'W/"nope"', '']) {
      const again = await a.call('GET', '/api/app/pane/%256/capture', { headers: { 'if-none-match': inm } });
      assert.equal(again.status, 200, inm);
      assert.equal(again.body.etag, r.body.etag);
    }
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

// --- 0.3 session control: capture fields, modes, mode / answer / command / end routes, commands, models ---

const rowsOf = (lines) => lines.map((t) => [{ t, s: { b: false, fg: null, bg: null, u: false, i: false, d: false } }]);
const FOOTER = { plan: '  ⏸ plan mode on (shift+tab to cycle)', accept: '  ⏵⏵ accept edits on (shift+tab to cycle)', insert: '-- INSERT --' };
const PROMPT = ['Edit file notes.txt', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, allow all edits during this session', '   3. No', ' Esc to cancel'];
const BYPASS_QUESTION_PROMPT = ['Edit file notes.txt', ' Switch to bypass permissions mode?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'];
const BYPASS_PROMPT = ['Edit file notes.txt', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and bypass permissions for this session', '   3. No', ' Esc to cancel'];
const sigOf = (lines) => createHash('sha256').update(lastNonBlank(rowsOf(lines), PROMPT_ROWS).join('\n')).digest('hex').slice(0, 16);

/** Mirror whose screens the test sets per pane: screens['%6'] = rowsOf([...]); null = the capture fails (503). `seen` lists the captured panes. */
function screenMirror(screens, { delay = 0 } = {}) {
  const seen = [];
  const m = {
    seen, opts: [], inflight: 0, peak: 0,
    capture: async (pane, inm, o) => {
      seen.push(pane);
      m.opts.push(o);
      m.inflight += 1;
      m.peak = Math.max(m.peak, m.inflight);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      m.inflight -= 1;
      if (screens[pane] === null) return { status: 503, body: { error: 'tmux_unavailable', message: 'x' } };
      return { status: 200, body: { cols: 80, rows: screens[pane] ?? [], cursor: { x: 0, y: 0, visible: true }, etag: 'abc' }, etag: 'abc' };
    },
  };
  return m;
}

/** A session-control factory that records what the router builds it with and what the routes call. `answers` overrides a method's result. */
function fakeControl(answers = {}) {
  const f = { calls: [], opts: null };
  const method = (name, fallback) => async (...args) => {
    f.calls.push([name, ...args]);
    return answers[name] ?? fallback(...args);
  };
  f.factory = (opts) => {
    f.opts = opts;
    return {
      switchMode: method('switchMode', (pane, target) => ({ status: 200, body: { mode: target, presses: 1 } })),
      endSession: method('endSession', () => ({ status: 200, body: { ended: true } })),
      runCommand: method('runCommand', () => ({ status: 200, body: { sent: true } })),
      answer: method('answer', (pane, b) => ({ status: 200, body: { answered: b.n } })),
      stop: method('stop', () => ({ status: 200, body: { stopped: true, presses: 1 } })),
    };
  };
  return f;
}

/** A server whose pane screens the test controls; `over` replaces deps, `ctlAnswers` the fake control's results. */
async function bootScreens({ over = {}, fake = true, ctlAnswers } = {}) {
  const screens = {};
  const mirror = screenMirror(screens);
  const control = fake ? fakeControl(ctlAnswers) : null;
  const a = await boot({ deps: makeDeps({ mirror, ...(control ? { createSessionControl: control.factory } : {}), ...over }) });
  return { a, screens, mirror, control };
}
const pane = (a, id, suffix, opts) => a.call(opts?.method ?? 'GET', `/api/app/pane/${id.replace('%', '%25')}/${suffix}`, opts);
const leaveAndReturn = async (a, id) => { // the pane drops out of the tmux list for one refresh, then comes back
  const entry = a.deps.state.panes.get(id);
  a.deps.state.panes.delete(id);
  a.clock.t += 2000;
  assert.equal((await pane(a, id, 'capture')).status, 404);
  a.deps.state.panes.set(id, entry);
  a.clock.t += 2000;
};

describe('capture: mode, modeConfirmed, prompt', () => {
  test('(+) a readable footer: mode with modeConfirmed true, prompt null, the mirror fields kept', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['hello', FOOTER.plan]);
    const r = await pane(a, '%6', 'capture');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'plan');
    assert.equal(r.body.modeConfirmed, true);
    assert.equal(r.body.prompt, null);
    assert.equal(r.body.cols, 80);
    assert.match(r.body.etag, /^[0-9a-f]{32}$/);
    assert.equal(r.headers.etag, `"${r.body.etag}"`);
  });

  test('(+) a permission prompt on screen: question, options and a 16-hex sig', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(PROMPT);
    const r = await pane(a, '%6', 'capture');
    assert.deepEqual(r.body.prompt, {
      question: 'Do you want to proceed?',
      options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, allow all edits during this session' }, { n: 3, label: 'No' }],
      sig: sigOf(PROMPT),
      bypass: false,
    });
    assert.match(r.body.prompt.sig, /^[0-9a-f]{16}$/);
  });

  test('(+) prompt.bypass is true when the prompt window mentions bypass: in the question, in an option, or only in the lines above the question', async () => {
    const { a, screens } = await bootScreens();
    const quiet = ['Run: claude --dangerously-skip-permissions (bypass)', ...PROMPT.slice(1)];
    for (const lines of [BYPASS_QUESTION_PROMPT, BYPASS_PROMPT, ['Allow tool call Bypass-Check?', ...PROMPT.slice(1)], quiet]) {
      screens['%6'] = rowsOf(lines);
      const r = await pane(a, '%6', 'capture');
      assert.equal(r.body.prompt.bypass, true, lines[0]);
      assert.equal(r.body.prompt.sig, sigOf(lines));
    }
  });

  test('(−) prompt.bypass is false for a prompt that does not mention it, also when the word is above the 15-row window; no prompt, no field', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(PROMPT);
    assert.equal((await pane(a, '%6', 'capture')).body.prompt.bypass, false);
    const old = ['bypass permissions was mentioned long ago', ...Array.from({ length: 14 }, (_, i) => `output line ${i}`), ...PROMPT];
    screens['%6'] = rowsOf(old);
    assert.equal((await pane(a, '%6', 'capture')).body.prompt.bypass, false, 'outside the last 15 non-blank rows');
    screens['%6'] = rowsOf(['bypass permissions is on', FOOTER.plan]);
    assert.equal((await pane(a, '%6', 'capture')).body.prompt, null, 'plain output is not a prompt');
  });

  test('(+) prompt.sig equals sha256(lastNonBlank(rows, PROMPT_ROWS).join("\\n")).slice(0, 16); another screen gives another sig', async () => {
    const { a, screens } = await bootScreens();
    const lines = ['', ...PROMPT, '', ''];
    screens['%6'] = rowsOf(lines);
    const want = createHash('sha256').update(lastNonBlank(rowsOf(lines), PROMPT_ROWS).join('\n')).digest('hex').slice(0, 16);
    assert.equal((await pane(a, '%6', 'capture')).body.prompt.sig, want);
    screens['%6'] = rowsOf(BYPASS_PROMPT);
    assert.notEqual((await pane(a, '%6', 'capture')).body.prompt.sig, want);
  });

  test('(+) a started pane with an unknown footer: the launch mode, modeConfirmed false', async () => {
    const { a, screens } = await bootScreens();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'acceptEdits' });
    screens['%8'] = rowsOf(['❯ ']);
    const r = await pane(a, '%8', 'capture');
    assert.equal(r.body.mode, 'acceptEdits');
    assert.equal(r.body.modeConfirmed, false);
  });

  test('(+) a prompt covering the footer after a plan footer was read: mode plan, modeConfirmed false; the footer back: confirmed again', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['text', FOOTER.plan]);
    await pane(a, '%6', 'capture');
    screens['%6'] = rowsOf(PROMPT);
    const covered = await pane(a, '%6', 'capture');
    assert.equal(covered.body.mode, 'plan');
    assert.equal(covered.body.modeConfirmed, false);
    assert.notEqual(covered.body.prompt, null);
    screens['%6'] = rowsOf(['text', FOOTER.accept]);
    const back = await pane(a, '%6', 'capture');
    assert.equal(back.body.mode, 'acceptEdits');
    assert.equal(back.body.modeConfirmed, true);
  });

  test('(+) the footer read beats the launch mode; the held mode beats the launch mode', async () => {
    const { a, screens } = await bootScreens();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'manual' });
    screens['%8'] = rowsOf(['text', FOOTER.plan]);
    assert.equal((await pane(a, '%8', 'capture')).body.mode, 'plan');
    screens['%8'] = rowsOf(PROMPT);
    const held = await pane(a, '%8', 'capture');
    assert.deepEqual([held.body.mode, held.body.modeConfirmed], ['plan', false]);
  });

  test('(−) a pane never read and not started, footer unknown: mode unknown, modeConfirmed true', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['just some text']);
    const r = await pane(a, '%6', 'capture');
    assert.equal(r.body.mode, 'unknown');
    assert.equal(r.body.modeConfirmed, true);
    assert.equal(r.body.prompt, null);
  });

  test('(−) the held mode is dropped when the pane leaves the eligible set: a reused pane id starts unknown', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['text', FOOTER.plan]);
    await pane(a, '%6', 'capture');
    await leaveAndReturn(a, '%6');
    screens['%6'] = rowsOf(['a stranger']);
    const r = await pane(a, '%6', 'capture');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.mode, r.body.modeConfirmed], ['unknown', true]);
  });

  test('(+) a failed tmux list or registry read keeps the held mode and the vim memory (one blip proves nothing)', async () => {
    let fail = false;
    const { a, screens, control } = await bootScreens({ over: { collect: async () => { if (fail) throw new Error('ps'); return SNAPSHOT; } } });
    screens['%6'] = rowsOf(['text', `${FOOTER.insert} ⏵⏸ plan mode on (shift+tab to cycle)`]);
    await pane(a, '%6', 'capture');
    assert.equal(control.opts.vimOf('%6'), true);
    const panes = a.deps.state.panes;
    a.deps.state.panes = new Map();
    a.deps.state.error = 'tmux unavailable: no server running';
    a.clock.t += 2000;
    assert.equal((await pane(a, '%6', 'capture')).status, 404);
    a.deps.state.panes = panes;
    a.deps.state.error = undefined;
    fail = true;
    a.clock.t += 2000;
    await pane(a, '%6', 'capture');
    fail = false;
    a.clock.t += 2000;
    screens['%6'] = rowsOf(['a dialog covers the footer']);
    const r = await pane(a, '%6', 'capture');
    assert.deepEqual([r.body.mode, r.body.modeConfirmed], ['plan', false]);
    assert.equal(control.opts.vimOf('%6'), true);
  });

  test('(−) a pane that stops running claude (shell) also drops its held mode', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['text', FOOTER.plan]);
    await pane(a, '%6', 'capture');
    a.deps.state.panes.set('%6', { command: 'zsh' });
    a.clock.t += 2000;
    assert.equal((await pane(a, '%6', 'capture')).status, 404);
    a.deps.state.panes.set('%6', { command: 'claude' });
    a.clock.t += 2000;
    screens['%6'] = rowsOf(['prompt-less text']);
    assert.equal((await pane(a, '%6', 'capture')).body.mode, 'unknown');
  });

  test('(−) a failing capture and a 304 carry no mode fields; the shared cached body is not mutated', async () => {
    const shared = { cols: 80, rows: rowsOf(['t', FOOTER.plan]), cursor: { x: 0, y: 0, visible: true }, etag: 'abc' };
    const a = await boot({ deps: makeDeps({ mirror: { capture: async () => ({ status: 200, body: shared, etag: 'abc' }) } }) });
    const first = await pane(a, '%6', 'capture');
    assert.equal(first.body.mode, 'plan');
    assert.equal('mode' in shared, false);
    assert.equal(shared.etag, 'abc', 'the shared body keeps the mirror\'s own ETag');
    const again = await pane(a, '%6', 'capture', { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal(again.raw, '');
    const down = await boot({ deps: makeDeps({ mirror: { capture: async () => ({ status: 503, body: { error: 'tmux_unavailable', message: 'x' } }) } }) });
    const r = await pane(down, '%6', 'capture');
    assert.equal(r.status, 503);
    assert.equal('mode' in r.body, false);
  });
});

describe('capture: the ETag covers the mode shown, not only the rows (final review, Minor 3)', () => {
  const lost = { status: 409, body: { error: 'mode-unknown', presses: 1 } };

  test('(−) same rows, held mode changed by a failed switch: the page\'s If-None-Match no longer gets a 304, it gets 200 with the new mode', async () => {
    const { a, screens } = await bootScreens({ ctlAnswers: { switchMode: lost } });
    screens['%6'] = rowsOf(['text', FOOTER.plan]);
    assert.equal((await pane(a, '%6', 'capture')).body.mode, 'plan');
    screens['%6'] = rowsOf(['dialog over the footer', 'a footer nobody recognises']); // the footer is covered: the held mode is shown
    const covered = await pane(a, '%6', 'capture');
    assert.deepEqual([covered.body.mode, covered.body.modeConfirmed], ['plan', false]);
    const same = await pane(a, '%6', 'capture', { headers: { 'if-none-match': covered.headers.etag } });
    assert.equal(same.status, 304, 'nothing changed: still a 304');
    assert.equal((await pane(a, '%6', 'mode', { method: 'POST', json: { target: 'manual' } })).status, 409); // 1 press, then the held mode is forgotten
    const after = await pane(a, '%6', 'capture', { headers: { 'if-none-match': covered.headers.etag } });
    assert.equal(after.status, 200);
    assert.deepEqual([after.body.mode, after.body.modeConfirmed], ['unknown', true]);
    assert.notEqual(after.body.etag, covered.body.etag);
    assert.equal(after.headers.etag, `"${after.body.etag}"`);
    assert.equal((await pane(a, '%6', 'capture', { headers: { 'if-none-match': after.headers.etag } })).status, 304, 'and the new answer can be revalidated');
  });

  test('(+) the same rows with the same mode keep one ETag; a different mode over the same rows is another', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['same text', FOOTER.plan]);
    const plan = await pane(a, '%6', 'capture');
    assert.equal((await pane(a, '%6', 'capture')).body.etag, plan.body.etag);
    screens['%6'] = rowsOf(['same text', FOOTER.accept]); // the fake mirror reports one rows hash for every screen
    assert.notEqual((await pane(a, '%6', 'capture')).body.etag, plan.body.etag);
  });
});

describe('GET /api/app/modes', () => {
  test('(+) lists eligible panes only, with mode and confirmed', async () => {
    const { a, screens, mirror } = await bootScreens();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'acceptEdits' });
    screens['%6'] = rowsOf(['t', FOOTER.plan]);
    screens['%8'] = rowsOf(PROMPT);
    const r = await a.call('GET', '/api/app/modes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { modes: { '%6': { mode: 'plan', confirmed: true }, '%8': { mode: 'acceptEdits', confirmed: false } } });
    assert.deepEqual(mirror.seen.sort(), ['%6', '%8']); // %5 is a shell, %7 is not a live session
  });

  test('(+) the modes it reads feed the held mode of capture', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['t', FOOTER.plan]);
    await a.call('GET', '/api/app/modes');
    screens['%6'] = rowsOf(PROMPT);
    assert.deepEqual((await pane(a, '%6', 'capture')).body.mode, 'plan');
  });

  test('(−) a pane whose capture fails is left out; no eligible pane (or tmux down) gives an empty map', async () => {
    const { a, screens } = await bootScreens();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    screens['%6'] = rowsOf(['t', FOOTER.plan]);
    screens['%8'] = null;
    assert.deepEqual((await a.call('GET', '/api/app/modes')).body, { modes: { '%6': { mode: 'plan', confirmed: true } } });
    a.deps.state.panes = new Map();
    a.deps.state.error = 'tmux unavailable: no server running';
    a.clock.t += 2000;
    assert.deepEqual((await a.call('GET', '/api/app/modes')).body, { modes: {} });
  });

  test('(−) at most 4 captures at once', async () => {
    const screens = {};
    const mirror = screenMirror(screens, { delay: 10 });
    const a = await boot({ deps: makeDeps({ mirror }) });
    a.deps.state.panes = new Map();
    for (let i = 10; i < 20; i += 1) {
      a.deps.state.panes.set(`%${i}`, { command: 'claude' });
      a.ctx.started.set(`%${i}`, { key: w.project.key, name: `n${i}`, sessionId: null, role: 'agent', mode: 'plan' });
    }
    const r = await a.call('GET', '/api/app/modes');
    assert.equal(Object.keys(r.body.modes).length, 10);
    assert.equal(mirror.peak, 4);
  });

  test('(−) POST is 405; without the secret 403', async () => {
    const { a } = await bootScreens();
    assert.equal((await a.call('POST', '/api/app/modes', { json: {} })).status, 405);
    assert.equal((await a.call('GET', '/api/app/modes', { headers: { 'x-nika-app': null } })).status, 403);
  });
});

describe('session control: wiring', () => {
  test('(+) one controller is built per server, with the registry state of the live agent and the vim memory', async () => {
    let built = 0;
    const control = fakeControl();
    const a = await boot({ deps: makeDeps({ createSessionControl: (o) => { built += 1; return control.factory(o); } }) });
    for (let i = 0; i < 3; i += 1) await a.call('POST', '/api/app/pane/%256/mode', { json: { target: 'plan' } });
    assert.equal(built, 1);
    const { stateOf, vimOf, mirror, keys, paneCommand } = control.opts;
    assert.equal(await stateOf('%6'), 'idle');
    assert.equal(await stateOf('%7'), null); // not live
    assert.equal(await stateOf('%99'), null);
    assert.equal(vimOf('%6'), false);
    assert.equal(mirror, a.deps.mirror);
    assert.equal(keys, a.deps.keys);
    assert.equal(await paneCommand('%6'), 'claude');
    assert.equal(await paneCommand('%99'), null); // gone
  });

  test('(+) stateOf follows the snapshot: busy, and a pane with two live agents is not idle', async () => {
    const control = fakeControl();
    const live = (id, state) => ({ live: true, state, pane: { id } });
    let agents = [live('%6', 'busy')];
    const a = await boot({ deps: makeDeps({ collect: async () => ({ groups: [{ agents }] }), createSessionControl: control.factory }) });
    await a.call('POST', '/api/app/pane/%256/mode', { json: { target: 'plan' } });
    assert.equal(await control.opts.stateOf('%6'), 'busy');
    agents = [live('%6', 'idle'), live('%6', 'idle')];
    a.clock.t += 2000;
    assert.equal(await control.opts.stateOf('%6'), null); // ambiguous: never idle
  });

  test('(+) stateOf with { fresh: true } drops the cached snapshot and reads the registry again; without it the cache (1 s) still answers', async () => {
    const control = fakeControl();
    const live = (state) => ({ live: true, state, pane: { id: '%6' } });
    let agents = [live('busy')];
    let reads = 0;
    const a = await boot({ deps: makeDeps({ collect: async () => { reads += 1; return { groups: [{ agents }] }; }, createSessionControl: control.factory }) });
    await a.call('POST', '/api/app/pane/%256/mode', { json: { target: 'plan' } });
    assert.equal(await control.opts.stateOf('%6'), 'busy');
    const before = reads;
    agents = [live('idle')];
    assert.equal(await control.opts.stateOf('%6'), 'busy', 'the cached snapshot, as before');
    assert.equal(await control.opts.stateOf('%6', {}), 'busy', 'an options object without fresh changes nothing');
    assert.equal(reads, before);
    assert.equal(await control.opts.stateOf('%6', { fresh: true }), 'idle');
    assert.equal(reads, before + 1);
    assert.equal(await control.opts.stateOf('%6'), 'idle', 'the new snapshot is cached again');
    assert.equal(reads, before + 1);
  });

  test('(−) fresh with a failing registry read is no state at all (never idle), and the next plain read is not poisoned', async () => {
    const control = fakeControl();
    let fail = false;
    const a = await boot({ deps: makeDeps({ collect: async () => { if (fail) throw new Error('ps'); return { groups: [{ agents: [{ live: true, state: 'busy', pane: { id: '%6' } }] }] }; }, createSessionControl: control.factory }) });
    await a.call('POST', '/api/app/pane/%256/mode', { json: { target: 'plan' } });
    fail = true;
    assert.equal(await control.opts.stateOf('%6', { fresh: true }), null, 'the snapshot is gone and none could be read: no live session');
    fail = false;
    a.clock.t += 2000; // the failed snapshot is cached like any other, until it expires
    assert.equal(await control.opts.stateOf('%6'), 'busy');
  });

  test('(−) paneCommand throws when tmux cannot be listed, so End never reports a pane gone on a failed lookup', async () => {
    const control = fakeControl();
    const a = await boot({ deps: makeDeps({ createSessionControl: control.factory }) });
    a.deps.state.panes = new Map();
    a.deps.state.error = 'tmux unavailable: no server running';
    await assert.rejects(() => control.opts.paneCommand('%6'));
  });

  test('(+) vimOf is true after a capture whose mode line shows -- INSERT --; (−) a reused pane id that left the eligible set starts false', async () => {
    const { a, screens, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'mode', { method: 'POST', json: { target: 'plan' } })).status, 200); // builds nothing new; opts are set at boot
    screens['%6'] = rowsOf(['text', `${FOOTER.insert} ⏵⏵ accept edits on`]);
    screens['%8'] = rowsOf(['text', FOOTER.plan]);
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    assert.equal(control.opts.vimOf('%6'), false);
    await pane(a, '%6', 'capture');
    await pane(a, '%8', 'capture');
    assert.equal(control.opts.vimOf('%6'), true);
    assert.equal(control.opts.vimOf('%8'), false); // another pane, no INSERT seen
    screens['%6'] = rowsOf(['text', FOOTER.plan]); // the line no longer shows INSERT: the memory stays
    await pane(a, '%6', 'capture');
    assert.equal(control.opts.vimOf('%6'), true);
    await leaveAndReturn(a, '%6');
    assert.equal(control.opts.vimOf('%6'), false);
  });
});

describe('POST /api/app/pane/:id/mode', () => {
  test('(+) passes the pane and target to sessionControl and relays its answer', async () => {
    const { a, control } = await bootScreens();
    const r = await pane(a, '%6', 'mode', { method: 'POST', json: { target: 'plan', extra: 'dropped' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { mode: 'plan', presses: 1 });
    assert.deepEqual(control.calls, [['switchMode', '%6', 'plan']]);
  });

  test('(+) a started pane is eligible; the controller\'s 409 is relayed as it is', async () => {
    const { a, control } = await bootScreens({ ctlAnswers: { switchMode: { status: 409, body: { error: 'not-idle' } } } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    const r = await pane(a, '%8', 'mode', { method: 'POST', json: { target: 'auto' } });
    assert.deepEqual([r.status, r.body], [409, { error: 'not-idle' }]);
    assert.deepEqual(control.calls, [['switchMode', '%8', 'auto']]);
  });

  test('(−) a target outside manual / acceptEdits / plan / auto is 400 before any pane check, and sessionControl is not called', async () => {
    const { a, control } = await bootScreens();
    for (const target of ['bypassPermissions', 'dontAsk', 'default', '', undefined, 5, null, ['plan'], { a: 1 }]) {
      for (const id of ['%6', '%5']) {
        const r = await pane(a, id, 'mode', { method: 'POST', json: { target } });
        assert.equal(r.status, 400, `${JSON.stringify(target)} on ${id}`);
        assert.equal(r.body.error, 'invalid');
      }
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) an ineligible pane (zsh, not live, unknown id, bad id) is 404 and sessionControl is not called', async () => {
    const { a, control } = await bootScreens();
    for (const id of ['%5', '%7', '%99', 'abc', '..']) {
      const r = await a.call('POST', `/api/app/pane/${id.replace('%', '%25')}/mode`, { json: { target: 'plan' } });
      assert.equal(r.status, 404, id);
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) without the app secret 403; text/plain 415; GET 405; a body over 4 KB 413 -- sessionControl is not called', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'mode', { method: 'POST', json: { target: 'plan' }, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'mode', { method: 'POST', body: '{"target":"plan"}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'mode')).status, 405);
    assert.equal((await pane(a, '%6', 'mode', { method: 'POST', json: { target: 'plan', pad: 'x'.repeat(5000) } })).status, 413);
    assert.deepEqual(control.calls, []);
  });
});

describe('POST /api/app/pane/:id/answer', () => {
  const answer = (a, json, id = '%6') => pane(a, id, 'answer', { method: 'POST', json });
  const keyCalls = (a) => a.deps.calls.filter((c) => c[0] === 'keys');

  test('(+) a matching sig sends the digit as text and returns answered', async () => {
    const { a, screens } = await bootScreens({ fake: false });
    screens['%6'] = rowsOf(PROMPT);
    const sig = (await pane(a, '%6', 'capture')).body.prompt.sig;
    const r = await answer(a, { n: 2, sig });
    assert.deepEqual([r.status, r.body], [200, { answered: 2 }]);
    assert.deepEqual(keyCalls(a), [['keys', '%6', { text: '2' }]]);
  });

  test('(+) the same sig answered twice within 3 s is 409 already-answered, and answers again after the hold', async () => {
    const { a, screens } = await bootScreens({ fake: false });
    screens['%6'] = rowsOf(PROMPT);
    const sig = sigOf(PROMPT);
    assert.equal((await answer(a, { n: 1, sig })).status, 200);
    const again = await answer(a, { n: 1, sig });
    assert.deepEqual([again.status, again.body.error], [409, 'already-answered']);
    assert.equal(keyCalls(a).length, 1);
    a.clock.t += 3100;
    assert.equal((await answer(a, { n: 1, sig })).status, 200);
  });

  test('(−) the prompt rows changed since the capture: 409 prompt-changed, nothing sent', async () => {
    const { a, screens } = await bootScreens({ fake: false });
    screens['%6'] = rowsOf(PROMPT);
    const sig = sigOf(PROMPT);
    screens['%6'] = rowsOf(['Edit file other.txt', ...PROMPT.slice(1)]);
    const r = await answer(a, { n: 1, sig });
    assert.deepEqual([r.status, r.body.error], [409, 'prompt-changed']);
    assert.deepEqual(keyCalls(a), []);
  });

  test('(−) no prompt on screen: 409 no-prompt, nothing sent', async () => {
    const { a, screens } = await bootScreens({ fake: false });
    screens['%6'] = rowsOf(['just text', FOOTER.plan]);
    const r = await answer(a, { n: 1, sig: sigOf(PROMPT) });
    assert.deepEqual([r.status, r.body.error], [409, 'no-prompt']);
    assert.deepEqual(keyCalls(a), []);
  });

  test('(−) n not among the options: 400, nothing sent', async () => {
    const { a, screens } = await bootScreens({ fake: false });
    screens['%6'] = rowsOf(PROMPT);
    const r = await answer(a, { n: 7, sig: sigOf(PROMPT) });
    assert.deepEqual([r.status, r.body.error], [400, 'invalid']);
    assert.deepEqual(keyCalls(a), []);
  });

  test('(−) a prompt whose window mentions bypass (an option or the question) is 400 for every option, nothing sent; a clean prompt still answers', async () => {
    const { a, screens } = await bootScreens({ fake: false });
    for (const lines of [BYPASS_PROMPT, BYPASS_QUESTION_PROMPT]) {
      screens['%6'] = rowsOf(lines);
      const sig = sigOf(lines);
      for (const n of [1, 2]) {
        const r = await answer(a, { n, sig });
        assert.deepEqual([r.status, r.body.error], [400, 'invalid'], `option ${n}`);
      }
    }
    assert.deepEqual(keyCalls(a), []);
    screens['%6'] = rowsOf(PROMPT);
    assert.equal((await answer(a, { n: 3, sig: sigOf(PROMPT) })).status, 200);
  });

  test('(−) n not an integer 1-9 or sig not 16 lowercase hex: 400 before any pane work; ineligible pane 404', async () => {
    const { a, control } = await bootScreens();
    const sig = 'abcdef0123456789';
    for (const body of [
      { n: 0, sig }, { n: 10, sig }, { n: 1.5, sig }, { n: '1', sig }, { n: null, sig }, { sig }, { n: 1 },
      { n: 1, sig: 'ABCDEF0123456789' }, { n: 1, sig: 'abcdef012345678' }, { n: 1, sig: `${sig}0` }, { n: 1, sig: 5 }, { n: 1, sig: 'ghijklmnopqrstuv' },
    ]) {
      const r = await answer(a, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal((await answer(a, { n: 1, sig: 'abcdef012345678' }, '%5')).status, 400); // body first, as in the contract
    assert.equal((await answer(a, { n: 1, sig }, '%5')).status, 404);
    assert.equal((await answer(a, { n: 1, sig }, '%7')).status, 404);
    assert.deepEqual(control.calls, []);
  });

  test('(+) a valid body is passed to sessionControl.answer as { n, sig } only; its answer is relayed', async () => {
    const { a, control } = await bootScreens({ ctlAnswers: { answer: { status: 409, body: { error: 'busy-switching' } } } });
    const r = await answer(a, { n: 3, sig: 'abcdef0123456789', extra: 1 });
    assert.deepEqual([r.status, r.body], [409, { error: 'busy-switching' }]);
    assert.deepEqual(control.calls, [['answer', '%6', { n: 3, sig: 'abcdef0123456789' }]]);
  });

  test('(−) without the secret 403; text/plain 415; GET 405', async () => {
    const { a, control } = await bootScreens();
    const body = { n: 1, sig: 'abcdef0123456789' };
    assert.equal((await pane(a, '%6', 'answer', { method: 'POST', json: body, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'answer', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'answer')).status, 405);
    assert.deepEqual(control.calls, []);
  });
});

describe('POST /api/app/pane/:id/command', () => {
  const command = (a, json, id = '%6') => pane(a, id, 'command', { method: 'POST', json });

  test('(+) a slash command is passed to sessionControl.runCommand and its result returned', async () => {
    const { a, control } = await bootScreens();
    for (const text of ['/compact', '/model opus', '/demo:lint src/a.js --fix', '/clear ', '/a.b_c-d', `/${'a'.repeat(100)}`, `/compact ${'x'.repeat(191)}`, '/memo café über']) {
      const r = await command(a, { text });
      assert.deepEqual([r.status, r.body], [200, { sent: true }], text);
    }
    assert.equal(control.calls.length, 8);
    assert.deepEqual(control.calls[0], ['runCommand', '%6', '/compact']);
    assert.deepEqual(control.calls[1], ['runCommand', '%6', '/model opus']);
  });

  test('(+) the controller\'s 409 is relayed', async () => {
    const { a } = await bootScreens({ ctlAnswers: { runCommand: { status: 409, body: { error: 'input-not-empty' } } } });
    const r = await command(a, { text: '/compact' });
    assert.deepEqual([r.status, r.body], [409, { error: 'input-not-empty' }]);
  });

  test('(−) text that is not / + COMMAND_NAME (+ one space and args), over 200 chars or with a control char is 400; runCommand is not called', async () => {
    const { a, control } = await bootScreens();
    for (const text of [
      'compact', '/', '/ compact', '//x', '/.x', '/-x', '/x;y', '/x|y arg', '/../etc', '/a/b', ` /compact`, '/ ', '',
      `/${'a'.repeat(101)}`, `/compact ${'x'.repeat(192)}`, '/compact\n', '/compact\nfoo', '/compact\tfoo', '/compact\u001b[A', '/compact\r', '/comp\u0000act', '/compact \u0085', '/compact \u007f',
      5, null, undefined, ['/compact'], { text: '/compact' },
    ]) {
      const r = await command(a, { text });
      assert.equal(r.status, 400, JSON.stringify(text));
      assert.equal(r.body.error, 'invalid');
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) an ineligible pane is 404 and runCommand is not called; 403 / 415 / 405 as for every write', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await command(a, { text: '/compact' }, '%5')).status, 404);
    assert.equal((await command(a, { text: '/compact' }, '%7')).status, 404);
    assert.equal((await pane(a, '%6', 'command', { method: 'POST', json: { text: '/compact' }, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'command', { method: 'POST', body: '{"text":"/compact"}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'command')).status, 405);
    assert.deepEqual(control.calls, []);
  });
});

describe('POST /api/app/pane/:id/end', () => {
  const end = (a, json = {}, id = '%6') => pane(a, id, 'end', { method: 'POST', json });

  test('(+) returns ended and resets the eligibility cache', async () => {
    const { a, control } = await bootScreens();
    const collects = () => a.deps.calls.filter((c) => c[0] === 'collect').length;
    const r = await end(a);
    assert.deepEqual([r.status, r.body], [200, { ended: true }]);
    assert.deepEqual(control.calls, [['endSession', '%6']]);
    assert.equal(collects(), 1);
    await pane(a, '%6', 'capture'); // within the 1 s window: the cache would have served this
    assert.equal(collects(), 2);
  });

  test('(+) the eligibility cache is also reset when End answers 409 or ended false (with or without reason keys, relayed as the controller sent it)', async () => {
    for (const answers of [{ status: 409, body: { error: 'not-idle' } }, { status: 200, body: { ended: false } }, { status: 200, body: { ended: false, reason: 'keys' } }]) {
      const { a } = await bootScreens({ ctlAnswers: { endSession: answers } });
      const r = await end(a);
      assert.deepEqual([r.status, r.body], [answers.status, answers.body]);
      await pane(a, '%6', 'capture');
      assert.equal(a.deps.calls.filter((c) => c[0] === 'collect').length, 2);
    }
  });

  test('(−) a pane that is not in list-panes (or not Claude) is 404 and endSession is not called', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await end(a, {}, '%99')).status, 404);
    assert.equal((await end(a, {}, '%5')).status, 404);
    assert.equal((await end(a, {}, '%7')).status, 404);
    assert.deepEqual(control.calls, []);
  });

  test('(−) without the secret 403; text/plain 415; GET 405; invalid JSON 400', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'end', { method: 'POST', json: {}, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'end', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'end')).status, 405);
    assert.equal((await pane(a, '%6', 'end', { method: 'POST', body: '[]', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.deepEqual(control.calls, []);
  });
});

describe('POST /api/app/pane/:id/keys: the bypass prompt guard (A2, H2)', () => {
  const keysTo = (a, json, id = '%6') => pane(a, id, 'keys', { method: 'POST', json });
  const sent = (a) => a.deps.calls.filter((c) => c[0] === 'keys');
  const BYPASS = { status: 409, error: 'bypass-prompt', message: 'Answer this prompt in the terminal' };

  test('(+) Enter with no prompt on screen: one fresh capture first, then the keys are sent as before', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(['hello', FOOTER.plan]);
    const r = await keysTo(a, { keys: ['Enter'] });
    assert.equal(r.status, 200);
    assert.deepEqual(mirror.seen, ['%6']);
    assert.deepEqual(mirror.opts, [{ fresh: true }], 'the capture is fresh, never the cached one');
    assert.deepEqual(sent(a).map((c) => c.slice(1)), [['%6', { text: undefined, paste: undefined, keys: ['Enter'] }]]);
  });

  test('(+) Enter, a digit or a paste on a prompt that does not mention bypass: sent', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(PROMPT);
    for (const json of [{ keys: ['Enter'] }, { text: '2' }, { text: 'git log -3' }, { paste: 'one\ntwo' }, { text: 'x', keys: ['Enter'] }]) {
      assert.equal((await keysTo(a, json)).status, 200, JSON.stringify(json));
    }
    assert.equal(sent(a).length, 5);
  });

  test('(+) letters, arrows, Escape and the like skip the capture and go through even while a bypass prompt is open', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(BYPASS_PROMPT);
    for (const json of [{ text: 'hello world' }, { keys: ['Up', 'Down', 'Left', 'Right'] }, { keys: ['Escape'] }, { keys: ['C-u', 'Tab'] }, { text: 'abc', keys: ['C-c'] }]) {
      assert.equal((await keysTo(a, json)).status, 200, JSON.stringify(json));
    }
    assert.equal(sent(a).length, 5);
    assert.deepEqual(mirror.seen, [], 'not one capture: typing stays as fast as in 0.2');
  });

  test('(+) BTab with no prompt on screen: one fresh capture first, then it is sent (mode switching by chip is unaffected)', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(['hello', FOOTER.plan]);
    assert.equal((await keysTo(a, { keys: ['BTab'] })).status, 200);
    assert.deepEqual(mirror.opts, [{ fresh: true }]);
    screens['%6'] = rowsOf(PROMPT);
    assert.equal((await keysTo(a, { keys: ['Up', 'BTab'] })).status, 200, 'a prompt that does not mention bypass: sent, like Enter');
    screens['%6'] = rowsOf(['working...', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']);
    assert.equal((await keysTo(a, { keys: ['BTab'] })).status, 200, 'a readable bypass footer is not a prompt: Shift-Tab is how a session leaves bypass');
    assert.deepEqual(sent(a).map((c) => c[2].keys), [['BTab'], ['Up', 'BTab'], ['BTab']]);
  });

  test('(−) BTab on a bypass prompt (Shift-Tab can pick "allow for this session"): 409 bypass-prompt and nothing is sent', async () => {
    const { a, screens } = await bootScreens();
    for (const lines of [BYPASS_PROMPT, BYPASS_QUESTION_PROMPT]) {
      screens['%6'] = rowsOf(lines);
      for (const json of [{ keys: ['BTab'] }, { keys: ['Up', 'BTab'] }, { text: 'x', keys: ['BTab'] }]) {
        const r = await keysTo(a, json);
        assert.deepEqual([r.status, r.body.error, r.body.message], [BYPASS.status, BYPASS.error, BYPASS.message], JSON.stringify(json));
      }
    }
    assert.deepEqual(sent(a), []);
  });

  test('(−) Enter on a bypass prompt: 409 bypass-prompt and nothing is sent', async () => {
    const { a, screens } = await bootScreens();
    for (const lines of [BYPASS_PROMPT, BYPASS_QUESTION_PROMPT]) {
      screens['%6'] = rowsOf(lines);
      const r = await keysTo(a, { keys: ['Enter'] });
      assert.deepEqual([r.status, r.body.error, r.body.message], [BYPASS.status, BYPASS.error, BYPASS.message]);
    }
    assert.deepEqual(sent(a), []);
  });

  test('(−) text with a digit (git log -3) or any other digit, and any paste, on a bypass prompt: 409 bypass-prompt, nothing sent', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(BYPASS_PROMPT);
    for (const json of [{ text: 'git log -3' }, { text: '1' }, { text: 'abc9' }, { paste: 'one line' }, { paste: '' }, { text: 'ok', keys: ['Enter'] }, { text: 'hello', paste: 'x' }]) {
      const r = await keysTo(a, json);
      assert.deepEqual([r.status, r.body.error], [409, 'bypass-prompt'], JSON.stringify(json));
    }
    assert.deepEqual(sent(a), []);
  });

  test('(−) a bypass word in plain output (no prompt on screen) does not block Enter; only a prompt does', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['the notes talk about bypass permissions', FOOTER.plan]);
    assert.equal((await keysTo(a, { keys: ['Enter'] })).status, 200);
    const filler = Array.from({ length: 16 }, (_, i) => `output row ${i}`);
    screens['%6'] = rowsOf(['the notes talk about bypass permissions', ...filler, ...PROMPT]);
    assert.equal((await keysTo(a, { keys: ['Enter'] })).status, 200, 'older than the 15-row prompt window: it does not count');
    screens['%6'] = rowsOf(['the notes talk about bypass permissions', ...PROMPT]);
    assert.equal((await keysTo(a, { keys: ['Enter'] })).status, 409, 'inside the window (fail closed): it does');
  });

  test('(−) a dialog nika does not parse (another hint row, unreadable footer) whose window mentions bypass: Enter, a digit, a paste and BTab are 409 screen-unclear, nothing sent', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['Allow bypass permissions for this folder?', ' Enter to confirm · Esc to cancel']);
    assert.equal((await pane(a, '%6', 'capture')).body.prompt, null, 'the page has no buttons for it either');
    for (const json of [{ keys: ['Enter'] }, { text: '1' }, { paste: 'x' }, { keys: ['BTab'] }]) {
      const r = await keysTo(a, json);
      assert.deepEqual([r.status, r.body.error, r.body.message], [409, 'screen-unclear', "nika can't tell what Claude is showing; use the terminal"], JSON.stringify(json));
    }
    assert.deepEqual(sent(a), []);
  });

  test('(−) the slash menu is an unreadable footer too: a command with "bypass" in its name does not read as a bypass prompt', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['❯ /byp', '  /bypass-cache   Skip the cache for one run', '  /bypass-ci      Rerun without CI']);
    const r = await keysTo(a, { keys: ['Enter'] });
    assert.deepEqual([r.status, r.body.error], [409, 'screen-unclear']);
    assert.deepEqual(sent(a), []);
  });

  test('(+) a parsed prompt keeps bypass-prompt even though its footer is unreadable (a prompt covers the footer)', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(BYPASS_PROMPT);
    assert.equal(modeFromRows(rowsOf(BYPASS_PROMPT)), 'unknown');
    assert.equal((await keysTo(a, { keys: ['Enter'] })).body.error, 'bypass-prompt');
  });

  test('(+) the same unreadable dialog without the word, or a readable footer that itself says bypass, or a bypass word in output with a readable footer: sent', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['Trust the files in this folder?', ' Enter to confirm · Esc to cancel']);
    assert.equal((await keysTo(a, { keys: ['Enter'] })).status, 200);
    screens['%6'] = rowsOf(['working...', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']);
    assert.equal((await pane(a, '%6', 'capture')).body.mode, 'bypassPermissions');
    assert.equal((await keysTo(a, { keys: ['Enter'] })).status, 200, 'a session in bypass can still be typed to; the footer is not a prompt');
    assert.equal((await keysTo(a, { text: 'git log -3' })).status, 200);
    screens['%6'] = rowsOf(['notes about bypass', FOOTER.plan]);
    assert.equal((await keysTo(a, { keys: ['Enter'] })).status, 200);
    assert.equal(sent(a).length, 4);
  });

  test('(−) the capture fails: its status and body, nothing sent', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = null;
    const r = await keysTo(a, { keys: ['Enter'] });
    assert.deepEqual([r.status, r.body], [503, { error: 'tmux_unavailable', message: 'x' }]);
    assert.deepEqual(sent(a), []);
    screens['%6'] = rowsOf(['text']);
    assert.equal((await keysTo(a, { text: 'letters only' })).status, 200, 'and a request without Enter / digit / paste does not care');
  });

  test('(−) an ineligible pane is still 404 before any capture; module 400 and 429 are still relayed after a clean capture', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(['text']);
    assert.equal((await keysTo(a, { keys: ['Enter'] }, '%5')).status, 404);
    assert.deepEqual(mirror.seen, []);
    assert.equal((await keysTo(a, { text: 'busy', keys: ['Enter'] })).status, 429);
    assert.equal((await keysTo(a, { text: 'bad', keys: ['Enter'] })).status, 400);
  });
});

describe('POST /api/app/pane/:id/mode: a switch that fails after a press forgets the held mode (A1, H1)', () => {
  const modeTo = (a, id = '%6', target = 'manual') => pane(a, id, 'mode', { method: 'POST', json: { target } });
  const lost = { status: 409, body: { error: 'mode-unknown', presses: 1 } };

  test('(+) 409 with presses 1: the next capture with an unreadable footer reports mode unknown, not the mode held before', async () => {
    const { a, screens } = await bootScreens({ ctlAnswers: { switchMode: lost } });
    screens['%6'] = rowsOf(['text', FOOTER.plan]);
    assert.equal((await pane(a, '%6', 'capture')).body.mode, 'plan');
    const r = await modeTo(a);
    assert.deepEqual([r.status, r.body], [409, { error: 'mode-unknown', presses: 1 }], 'the body is relayed as it is');
    screens['%6'] = rowsOf(['text', 'a footer nobody recognises']);
    const c = await pane(a, '%6', 'capture');
    assert.equal(c.body.mode, 'unknown');
    assert.equal(c.body.modeConfirmed, true);
    screens['%6'] = rowsOf(['text', FOOTER.accept]);
    assert.equal((await pane(a, '%6', 'capture')).body.mode, 'acceptEdits', 'a readable footer is trusted again at once');
  });

  test('(+) the same for a pane nika started: its launch mode is not shown in place of the footer either', async () => {
    const { a, screens } = await bootScreens({ ctlAnswers: { switchMode: lost } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'manual' });
    screens['%8'] = rowsOf(['text', FOOTER.plan]);
    assert.equal((await pane(a, '%8', 'capture')).body.mode, 'plan');
    assert.equal((await modeTo(a, '%8')).status, 409);
    screens['%8'] = rowsOf(['text', 'a footer nobody recognises']);
    assert.equal((await pane(a, '%8', 'capture')).body.mode, 'unknown');
    const other = await bootScreens({ ctlAnswers: { switchMode: lost } });
    other.a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'manual' });
    other.screens['%8'] = rowsOf(['❯ ']);
    assert.equal((await modeTo(other.a, '%8')).status, 409);
    assert.equal((await pane(other.a, '%8', 'capture')).body.mode, 'unknown', 'never read before: the launch mode is stale after a press');
  });

  test('(−) every non-200 with presses above 0 does it (stopped-in-bypass, not-idle, a 429), a 200 and a 409 without presses do not', async () => {
    for (const answer of [{ status: 409, body: { error: 'stopped-in-bypass', presses: 2 } }, { status: 409, body: { error: 'not-idle', presses: 1 } }, { status: 429, body: { error: 'busy', message: 'x', presses: 3 } }]) {
      const { a, screens } = await bootScreens({ ctlAnswers: { switchMode: answer } });
      screens['%6'] = rowsOf(['text', FOOTER.plan]);
      await pane(a, '%6', 'capture');
      await modeTo(a);
      screens['%6'] = rowsOf(['text', 'a footer nobody recognises']);
      assert.equal((await pane(a, '%6', 'capture')).body.mode, 'unknown', answer.body.error);
    }
    for (const answer of [{ status: 200, body: { mode: 'manual', presses: 2 } }, { status: 409, body: { error: 'not-idle' } }, { status: 429, body: { error: 'busy', message: 'x', presses: 0 } }]) {
      const { a, screens } = await bootScreens({ ctlAnswers: { switchMode: answer } });
      screens['%6'] = rowsOf(['text', FOOTER.plan]);
      await pane(a, '%6', 'capture');
      await modeTo(a);
      screens['%6'] = rowsOf(['text', 'a footer nobody recognises']);
      const c = await pane(a, '%6', 'capture');
      assert.deepEqual([c.body.mode, c.body.modeConfirmed], ['plan', false], JSON.stringify(answer));
    }
  });
});

describe('POST /api/app/pane/:id/stop (A3, F1)', () => {
  const stop = (a, json = {}, id = '%6') => pane(a, id, 'stop', { method: 'POST', json });
  const busySnapshot = { groups: [{ agents: [{ live: true, state: 'busy', pane: { id: '%6' } }] }] };

  test('(+) passes the pane to sessionControl.stop and relays its answer', async () => {
    const { a, control } = await bootScreens();
    const r = await stop(a, { extra: 'dropped' });
    assert.deepEqual([r.status, r.body], [200, { stopped: true, presses: 1 }]);
    assert.deepEqual(control.calls, [['stop', '%6']]);
  });

  test('(+) a pane nika started is eligible; the controller\'s 409 is relayed as it is', async () => {
    const { a, control } = await bootScreens({ ctlAnswers: { stop: { status: 409, body: { error: 'not-busy' } } } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    const r = await stop(a, {}, '%8');
    assert.deepEqual([r.status, r.body], [409, { error: 'not-busy' }]);
    assert.deepEqual(control.calls, [['stop', '%8']]);
  });

  test('(−) an ineligible pane (zsh, not live, unknown id, bad id) is 404 and stop is not called', async () => {
    const { a, control } = await bootScreens();
    for (const id of ['%5', '%7', '%99', 'abc', '..']) {
      assert.equal((await a.call('POST', `/api/app/pane/${id.replace('%', '%25')}/stop`, { json: {} })).status, 404, id);
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) the guard: no secret 403; text/plain 415; GET 405; a body that is not a JSON object 400; over 4 KB 413 -- stop is not called', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'stop', { method: 'POST', json: {}, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'stop', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'stop')).status, 405);
    for (const body of ['[]', 'null', '5', '"x"', '{"__proto__":{}}']) {
      assert.equal((await pane(a, '%6', 'stop', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 400, body);
    }
    assert.equal((await pane(a, '%6', 'stop', { method: 'POST', json: { pad: 'x'.repeat(5000) } })).status, 413);
    assert.deepEqual(control.calls, []);
  });

  test('(+) with the real controller: a busy pane gets one Escape (fresh capture first); (−) an idle pane is 409 not-busy and gets none', async () => {
    const busy = await bootScreens({ fake: false, over: { collect: async () => busySnapshot } });
    busy.screens['%6'] = rowsOf(['working...', FOOTER.plan]);
    const r = await stop(busy.a);
    assert.deepEqual([r.status, r.body], [200, { stopped: true, presses: 1 }]);
    assert.deepEqual(busy.a.deps.calls.filter((c) => c[0] === 'keys'), [['keys', '%6', { keys: ['Escape'] }]]);
    assert.deepEqual(busy.mirror.opts, [{ fresh: true }]);
    const idle = await bootScreens({ fake: false });
    idle.screens['%6'] = rowsOf(['done', FOOTER.plan]);
    const n = await stop(idle.a);
    assert.deepEqual([n.status, n.body.error], [409, 'not-busy']);
    assert.deepEqual(idle.a.deps.calls.filter((c) => c[0] === 'keys'), []);
  });

  test('(−) with the real controller: a prompt on screen is 409 prompt-open, no key; Stop works while another control action holds the lock', async () => {
    const { a, screens } = await bootScreens({ fake: false, over: { collect: async () => busySnapshot } });
    screens['%6'] = rowsOf(PROMPT);
    const p = await stop(a);
    assert.deepEqual([p.status, p.body.error], [409, 'prompt-open']);
    assert.deepEqual(a.deps.calls.filter((c) => c[0] === 'keys'), []);

    let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    const started = new Promise((r) => { entered = r; });
    let captures = 0;
    const rows = rowsOf(['working...', FOOTER.plan]);
    const mirror = { capture: async () => { captures += 1; if (captures === 1) { entered(); await gate; } return { status: 200, body: { cols: 80, rows, cursor: { x: 0, y: 0, visible: true }, etag: 'e' }, etag: 'e' }; } };
    const b = await boot({ deps: makeDeps({ mirror, collect: async () => busySnapshot }) });
    const holding = pane(b, '%6', 'command', { method: 'POST', json: { text: '/compact' } }); // takes the lock, waits in its first capture
    await started;
    assert.equal((await pane(b, '%6', 'end', { method: 'POST', json: {} })).body.error, 'busy-switching', 'the lock is held');
    const s = await stop(b);
    assert.deepEqual([s.status, s.body], [200, { stopped: true, presses: 1 }], 'Stop does not wait for it');
    release();
    await holding;
  });
});

describe('real controller on the router: one lock for all four routes', () => {
  test('(−) a control action in progress makes the next one 409 busy-switching, whichever route it comes from', async () => {
    const screens = { '%6': rowsOf(PROMPT) };
    let release;
    const gate = new Promise((r) => { release = r; });
    let entered;
    const started = new Promise((r) => { entered = r; });
    const mirror = { capture: async () => { entered(); await gate; return { status: 200, body: { cols: 80, rows: screens['%6'], cursor: { x: 0, y: 0, visible: true }, etag: 'e' }, etag: 'e' }; } };
    const a = await boot({ deps: makeDeps({ mirror }) });
    const first = pane(a, '%6', 'answer', { method: 'POST', json: { n: 1, sig: sigOf(PROMPT) } }); // holds the lock inside its fresh capture
    await started;
    const second = await pane(a, '%6', 'command', { method: 'POST', json: { text: '/compact' } });
    assert.deepEqual([second.status, second.body.error], [409, 'busy-switching']);
    assert.equal((await pane(a, '%6', 'mode', { method: 'POST', json: { target: 'plan' } })).body.error, 'busy-switching');
    assert.equal((await pane(a, '%6', 'end', { method: 'POST', json: {} })).body.error, 'busy-switching');
    release();
    assert.equal((await first).status, 200);
  });
});

describe('GET /api/app/commands', () => {
  const list = Object.freeze([Object.freeze({ name: 'compact', description: 'Summarize', argHint: '[instructions]', source: 'builtin' }), Object.freeze({ name: 'demo:lint', description: 'Lint', argHint: '', source: 'plugin', plugin: 'demo' })]);
  const withList = () => {
    const calls = [];
    return { calls, deps: { listCommands: async (o) => { calls.push(o); return list; } } };
  };

  test('(+) without a project: built-ins, user and plugin entries (no projectDir) from the Claude dir', async () => {
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    const r = await a.call('GET', '/api/app/commands');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { commands: list });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].claudeDir, a.ctx.claudeDir);
    assert.equal(f.calls[0].projectDir, undefined);
  });

  test('(+) with a project key the registered project dir is passed (never a path from the request)', async () => {
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    const r = await a.call('GET', `/api/app/commands?project=${w.project.key}`);
    assert.equal(r.status, 200);
    assert.equal(f.calls[0].projectDir, w.project.dir);
    assert.equal(f.calls[0].claudeDir, a.ctx.claudeDir);
  });

  test('(−) an unknown project key is 404, a malformed or empty one 400; the module is not called', async () => {
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    assert.equal((await a.call('GET', '/api/app/commands?project=0123456789abcdef')).status, 404);
    for (const key of ['', '../x', 'ABCDEF0123456789', 'abc', `${w.project.key}0`, '%2Fetc%2Fpasswd']) {
      const r = await a.call('GET', `/api/app/commands?project=${key}`);
      assert.equal(r.status, 400, key);
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal(f.calls.length, 0);
  });

  test('(−) POST is 405; without the secret 403', async () => {
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    assert.equal((await a.call('POST', '/api/app/commands', { json: {} })).status, 405);
    assert.equal((await a.call('GET', '/api/app/commands', { headers: { 'x-nika-app': null } })).status, 403);
    assert.equal(f.calls.length, 0);
  });
});

describe('GET /api/app/models', () => {
  test('(+) returns the catalog', async () => {
    const a = await boot();
    const r = await a.call('GET', '/api/app/models');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { models: JSON.parse(JSON.stringify(MODEL_CATALOG)) });
    assert.ok(r.body.models.length > 0);
  });

  test('(−) POST is 405; without the secret 403', async () => {
    const a = await boot();
    assert.equal((await a.call('POST', '/api/app/models', { json: {} })).status, 405);
    assert.equal((await a.call('GET', '/api/app/models', { headers: { 'x-nika-app': null } })).status, 403);
  });
});
