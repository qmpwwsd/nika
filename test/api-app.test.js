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
import { readHistory, readSubagentHistory } from '../src/collect/history.js';
import { loadConfig, addProject, removeProject, getOrchestrator, setOrchestrator } from '../src/store.js';
import { collect, findSession, findSessions } from '../src/model.js';
import { listCommands as realListCommands } from '../src/collect/commands.js';
import { startOrchestrator } from '../src/orchestrate.js';
import { spawnAgent } from '../src/spawn.js';
import { configDir, stateDir, reportsDir } from '../src/paths.js';
import { lastNonBlank, modeFromRows, promptFromRows, surveyShown, PROMPT_ROWS } from '../src/mode.js';
import { MODEL_CATALOG } from '../src/models.js';
import { makeWorld, fakeTmux, TMUX, CLAUDE } from './tmux-fake.js';
import { makeFixture, cleanup, fakeExec, SID, NOW, PROC_START, boxRows, subagentRows } from './helpers.js';
import { createMirror } from '../src/mirror.js';
import { readDialogScreen, dialogOnScreen, sigOf as dialogSig } from '../src/dialog.js';
import { createKeys } from '../src/keys.js';
import { dialogWorld, TAB } from './dialog-fake.js';

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
    readSubagentHistory: rec('readSubagentHistory', async (id, agent, q) => (q.limit === '0'
      ? { status: 400, body: { error: 'invalid', message: 'limit' } }
      : agent === 'missing'
        ? { status: 404, body: { error: 'not_found', message: 'no such subagent' } }
        : { status: 200, body: { entries: [{ id: '0:0', role: 'user', kind: 'text', text: 'sub', truncated: false }], nextBefore: null } })),
    listPlugins: rec('listPlugins', async () => ['alpha@market', 'beta@market']),
    rulesState: rec('rulesState', async () => ({ state: 'none', settingsIgnored: false, git: true })),
    preview: rec('preview', async () => ({ status: 200, body: { hash: 'h', files: [], warnings: [], backupDir: '/x' } })),
    apply: rec('apply', async (project, opts) => (opts.hash === 'stale' ? { status: 409, body: { error: 'conflict', message: 'x' } } : { status: 200, body: { written: [], backupDir: '/x' } })),
    spawnAgent: rec('spawnAgent', async (body) => (body.name === 'full' ? { status: 409, body: { error: 'limit', message: 'x' } } : { status: 200, body: { pane: '%9', session: 's', sessionId: null, reports: {} } })),
    startOrchestrator: rec('startOrchestrator', async () => ({ status: 200, body: { pane: '%3', session: 's', sessionId: null, created: true } })),
    mirror: { capture: rec('capture', async (pane, inm) => (inm === '"abc"' ? { status: 304, body: null, etag: 'abc' } : { status: 200, body: { cols: 80, rows: [], cursor: { x: 0, y: 0, visible: true }, etag: 'abc' }, etag: 'abc' })) },
    keys: { send: rec('keys', async (pane, body) => (body.text === 'busy' ? { status: 429, body: { error: 'busy', message: 'x' } } : body.text === 'bad' ? { status: 400, body: { error: 'invalid', message: 'x' } } : { status: 200, body: { sent: { text: 1, paste: 0, keys: 0 } } })) },
    picker: { start: () => null, status: () => null },
    window: rec('window', async () => {}),
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
async function boot({ deps = makeDeps(), ctxOver = {}, world = w } = {}) {
  const clock = { t: 1_000_000 };
  const ctx = world.ctx(async () => ({ stdout: '', stderr: '' }), { claudeDir: fx.claudeDir, now: () => clock.t, ...ctxOver });
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

describe('POST /api/app/window (F2): the page asks the shell to act on its window', () => {
  const ACTIONS = ['quit', 'close', 'minimize', 'zoom-in', 'zoom-out', 'zoom-reset'];
  const windowCalls = (b) => b.deps.calls.filter((c) => c[0] === 'window');
  let a;
  before(async () => { a = await boot(); });

  test('(+) each action answers 204 with no body and hands exactly that action to the shell, once', async () => {
    for (const action of ACTIONS) {
      const before = windowCalls(a).length;
      const r = await a.call('POST', '/api/app/window', { json: { action } });
      assert.equal(r.status, 204, action);
      assert.equal(r.raw, '', action);
      assert.equal(r.headers['cache-control'], 'no-store', action);
      assert.deepEqual(windowCalls(a).slice(before), [['window', action]], action);
    }
  });

  test('(−) an unknown, missing, non-string or extra field is 400 invalid and the shell hears nothing', async () => {
    const before = windowCalls(a).length;
    for (const json of [{ action: 'maximize' }, { action: 'Quit' }, { action: ' quit' }, { action: '' }, {}, { action: 1 }, { action: ['quit'] }, { action: null }, { action: 'quit', extra: 1 }, { acton: 'quit' }]) {
      const r = await a.call('POST', '/api/app/window', { json });
      assert.equal(r.status, 400, JSON.stringify(json));
      assert.equal(r.body.error, 'invalid', JSON.stringify(json));
    }
    assert.equal((await a.call('POST', '/api/app/window', { body: '{"action":"quit"', headers: { 'content-type': 'application/json' } })).status, 400);
    for (const body of ['[]', 'null', '"quit"', '[{"action":"quit"}]']) { // JSON, but not an object: the shared reader refuses it here too
      const r = await a.call('POST', '/api/app/window', { body, headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 400, body);
    }
    assert.equal(windowCalls(a).length, before);
  });

  test('(−) a body that is not JSON is 415; (−) a body over the 4 KB cap is 413; neither reaches the shell', async () => {
    const before = windowCalls(a).length;
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      assert.equal((await a.call('POST', '/api/app/window', { body: '{"action":"quit"}', headers: { 'content-type': type } })).status, 415, String(type));
    }
    assert.equal((await a.call('POST', '/api/app/window', { json: { action: 'quit', pad: 'x'.repeat(5000) } })).status, 413);
    assert.equal(windowCalls(a).length, before);
  });

  test('(−) the usual app checks apply: no secret or a wrong one is 403, a foreign Origin is 403, GET is 405', async () => {
    const before = windowCalls(a).length;
    assert.equal((await a.call('POST', '/api/app/window', { json: { action: 'quit' }, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('POST', '/api/app/window', { json: { action: 'quit' }, headers: { 'x-nika-app': WRONG_SAME_LENGTH } })).status, 403);
    assert.equal((await a.call('POST', '/api/app/window', { json: { action: 'quit' }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await a.call('POST', '/api/app/window', { json: { action: 'quit' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const get = await a.call('GET', '/api/app/window');
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST');
    assert.equal(windowCalls(a).length, before);
  });
});

describe('projects', () => {
  let a;
  before(async () => { a = await boot(); });

  test('(+) list returns the registered projects with their rules state', async () => {
    const r = await a.call('GET', '/api/app/projects');
    assert.equal(r.status, 200);
    assert.equal(r.body.projects.length, 1);
    assert.deepEqual(Object.keys(r.body.projects[0]), ['key', 'dir', 'name', 'addedAt', 'rules', 'orchestrator']);
    assert.equal(r.body.projects[0].orchestrator, null, 'no saved orchestrator');
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
  const NONE = { orchestrator: null, reasoner: null, builder: null, scout: null };
  const only = (plugins, models = NONE, items = {}) => ({ plugins, models, permissionMode: null, panePlacement: null, maxAgents: null, ...items });

  test('(+) GET answers { plugins: [], models: all null } for a project without a list or models', async () => {
    const r = await a.call('GET', url());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, only([]));
    assert.match(r.headers['cache-control'] ?? '', /no-store/);
  });

  test('(+) PUT saves installed plugins and answers 200 { plugins }; GET and the settings read them back', async () => {
    const r = await put({ plugins: ['beta@market', 'alpha@market'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, only(['beta@market', 'alpha@market']));
    assert.deepEqual((await a.call('GET', url())).body, only(['beta@market', 'alpha@market']));
    assert.deepEqual((await loadConfig(w.env)).config.perProject[w.project.key], { plugins: ['beta@market', 'alpha@market'] });
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.perProject[w.project.key], { plugins: ['beta@market', 'alpha@market'] });
  });

  test('(+) a name that is saved but no longer installed is accepted again; [] removes the list', async () => {
    assert.equal((await put({ plugins: ['alpha@market', 'beta@market'] })).status, 200);
    const gone = await boot({ deps: makeDeps({ listPlugins: async () => ['alpha@market'] }) }); // beta@market was uninstalled since
    const r = await gone.call('PUT', url(), { json: { plugins: ['alpha@market', 'beta@market'] } });
    assert.equal(r.status, 200, 'beta@market is saved for this project, so it stays allowed');
    assert.deepEqual(r.body, only(['alpha@market', 'beta@market']));
    const cleared = await put({ plugins: [] });
    assert.deepEqual([cleared.status, cleared.body], [200, only([])]);
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
  });

  test('(−) a name that is neither installed nor already saved for that project is 400 and nothing changes', async () => {
    assert.equal((await put({ plugins: ['alpha@market'] })).status, 200);
    const r = await put({ plugins: ['alpha@market', 'gamma@market'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid');
    assert.match(r.body.message, /gamma@market is not installed/);
    assert.deepEqual((await a.call('GET', url())).body, only(['alpha@market']));
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
    assert.deepEqual((await a.call('GET', url())).body, only([]));
  });

  test('(−) PUT needs application/json (415), stays within 16 KB (413) and needs the app secret (403)', async () => {
    assert.equal((await a.call('PUT', url(), { body: '{"plugins":[]}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await a.call('PUT', url(), { body: '{"plugins":[]}', headers: { 'content-type': null } })).status, 415);
    assert.equal((await a.call('PUT', url(), { body: JSON.stringify({ plugins: [], pad: 'x'.repeat(17 * 1024) }), headers: { 'content-type': 'application/json' } })).status, 413);
    assert.equal((await a.call('PUT', url(), { json: { plugins: [] }, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('GET', url(), { headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await a.call('PUT', url(), { json: { plugins: [] }, headers: { origin: 'http://evil.example' } })).status, 403);
  });

  test('(+) PUT { models } saves the four roles (null = the default) and answers 200 { plugins, models }; GET and the settings read them back', async () => {
    const models = { orchestrator: null, reasoner: 'claude-opus-5-5', builder: 'sonnet[1m]', scout: 'claude-not-in-the-catalog-1' };
    const r = await put({ models });
    assert.deepEqual([r.status, r.body], [200, only([], models)], 'a Custom ID is allowed when it matches MODEL_ID');
    assert.deepEqual((await a.call('GET', url())).body, only([], models));
    assert.deepEqual((await loadConfig(w.env)).config.perProject[w.project.key], { models: { reasoner: 'claude-opus-5-5', builder: 'sonnet[1m]', scout: 'claude-not-in-the-catalog-1' } });
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.perProject[w.project.key], { models: { reasoner: 'claude-opus-5-5', builder: 'sonnet[1m]', scout: 'claude-not-in-the-catalog-1' } });
    assert.deepEqual((await put({ models: NONE })).body, only([]), 'all null clears them');
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
  });

  test('(+) a plugins save leaves the models untouched, and a models save leaves the plugins untouched', async () => {
    const models = { ...NONE, builder: 'claude-opus-5-5' };
    assert.equal((await put({ models })).status, 200);
    assert.deepEqual((await put({ plugins: ['alpha@market'] })).body, only(['alpha@market'], models));
    assert.deepEqual((await put({ models: { ...NONE, scout: 'haiku' } })).body, only(['alpha@market'], { ...NONE, scout: 'haiku' }));
    assert.deepEqual((await put({ plugins: [] })).body, only([], { ...NONE, scout: 'haiku' }));
    assert.deepEqual((await put({ models: NONE })).body, only([]));
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
  });

  test('(−) a { models } body that is not the four roles with ids or null is 400 invalid, and nothing is written', async () => {
    const keep = { ...NONE, scout: 'haiku' };
    assert.equal((await put({ models: keep })).status, 200);
    const saved = JSON.stringify((await loadConfig(w.env)).config.perProject);
    const bad = [
      { models: { scout: 'haiku' } }, { models: {} }, { models: { ...NONE, helper: 'haiku' } }, // a missing role, none, a stray role
      { models: { ...NONE, scout: 'Haiku 5' } }, { models: { ...NONE, scout: '--model' } }, { models: { ...NONE, scout: '' } }, { models: { ...NONE, scout: 5 } }, { models: { ...NONE, scout: ['haiku'] } }, // a bad id
      { models: null }, { models: 'haiku' }, { models: [] }, { models: [null, null, null, null] },
      { models: NONE, plugins: [] }, { models: NONE, extra: 1 }, // two keys
    ];
    for (const body of bad) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid');
      assert.ok(r.body.message.length < 160, 'the message is short');
    }
    const proto = await a.call('PUT', url(), { body: '{"models":{"orchestrator":null,"reasoner":null,"builder":null,"scout":null,"__proto__":null}}', headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400);
    assert.equal(JSON.stringify((await loadConfig(w.env)).config.perProject), saved, 'every refusal left the config as it was');
    assert.deepEqual((await a.call('GET', url())).body, only([], keep));
    assert.equal((await put({ models: NONE })).status, 200);
  });

  test('(−) a { models } PUT for an unknown project is 404, for a malformed key 400, as non-JSON 415, and without the secret 403', async () => {
    const models = { ...NONE, scout: 'haiku' };
    const missing = await put({ models }, '0123456789abcdef');
    assert.deepEqual([missing.status, missing.body.error], [404, 'not_found']);
    assert.equal((await put({ models }, 'short')).status, 400);
    assert.equal((await a.call('PUT', url(), { body: JSON.stringify({ models }), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await a.call('PUT', url(), { json: { models }, headers: { 'x-nika-app': null } })).status, 403);
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
  });

  test('(+) PUT { permissionMode | panePlacement | maxAgents } saves that one value and answers 200 with the whole config; GET, the settings and config.json read it back; null clears it', async () => {
    const bodies = [{ permissionMode: 'auto' }, { panePlacement: 'under-last' }, { maxAgents: 5 }];
    let items = {};
    for (const body of bodies) {
      items = { ...items, ...body };
      const r = await put(body);
      assert.deepEqual([r.status, r.body], [200, only([], NONE, items)], JSON.stringify(body));
    }
    assert.deepEqual((await a.call('GET', url())).body, only([], NONE, items));
    assert.deepEqual((await loadConfig(w.env)).config.perProject[w.project.key], items);
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.perProject[w.project.key], items);
    const settings = (await a.call('GET', '/api/app/settings')).body;
    assert.deepEqual([settings.permissionMode, settings.panePlacement, settings.limits.maxAgents], ['default', 'beside', 3], 'Settings itself is not changed');
    for (const mode of ['default', 'manual', 'acceptEdits', 'plan', 'dontAsk']) assert.equal((await put({ permissionMode: mode })).body.permissionMode, mode, mode);
    assert.equal((await put({ maxAgents: 1 })).body.maxAgents, 1);
    assert.equal((await put({ maxAgents: 8 })).body.maxAgents, 8);
    assert.equal((await put({ panePlacement: 'beside' })).body.panePlacement, 'beside');
    assert.deepEqual((await put({ panePlacement: null })).body, only([], NONE, { permissionMode: 'dontAsk', maxAgents: 8 }));
    assert.deepEqual((await put({ permissionMode: null })).body, only([], NONE, { maxAgents: 8 }));
    assert.deepEqual((await put({ maxAgents: null })).body, only([]), 'null = use Settings');
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
  });

  test('(+) a save of the three leaves plugins and models untouched, and the other way round', async () => {
    const models = { ...NONE, builder: 'claude-opus-5-5' };
    assert.equal((await put({ models })).status, 200);
    assert.equal((await put({ plugins: ['alpha@market'] })).status, 200);
    assert.deepEqual((await put({ maxAgents: 2 })).body, only(['alpha@market'], models, { maxAgents: 2 }));
    assert.deepEqual((await put({ permissionMode: 'plan' })).body, only(['alpha@market'], models, { maxAgents: 2, permissionMode: 'plan' }));
    assert.deepEqual((await put({ models: NONE })).body, only(['alpha@market'], NONE, { maxAgents: 2, permissionMode: 'plan' }));
    assert.deepEqual((await put({ plugins: [] })).body, only([], NONE, { maxAgents: 2, permissionMode: 'plan' }));
    await put({ maxAgents: null });
    assert.deepEqual((await put({ permissionMode: null })).body, only([]));
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
  });

  test('(−) bypassPermissions is 400 invalid, never saved, and a saved value stays', async () => {
    assert.equal((await put({ permissionMode: 'plan' })).status, 200);
    const saved = JSON.stringify((await loadConfig(w.env)).config.perProject);
    const r = await put({ permissionMode: 'bypassPermissions' });
    assert.deepEqual([r.status, r.body.error, r.body.message], [400, 'invalid', 'bypassPermissions is never allowed']);
    assert.equal(JSON.stringify((await loadConfig(w.env)).config.perProject), saved, 'nothing was written');
    assert.equal((await a.call('GET', url())).body.permissionMode, 'plan');
    assert.equal((await put({ permissionMode: null })).status, 200);
    const none = await put({ permissionMode: 'bypassPermissions' });
    assert.equal(none.status, 400);
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {}, 'no entry was created for it');
  });

  test('(−) a body with two fields, a stray key, or a value that is not a mode, a placement or a whole number from 1 to 8 is 400 invalid and nothing is written', async () => {
    assert.equal((await put({ maxAgents: 3 })).status, 200);
    const saved = JSON.stringify((await loadConfig(w.env)).config.perProject);
    const bad = [
      { permissionMode: 'plan', maxAgents: 2 }, { panePlacement: 'beside', maxAgents: 2 }, { permissionMode: null, panePlacement: null, maxAgents: null }, // two or three fields
      { maxAgents: 2, plugins: [] }, { permissionMode: 'plan', models: NONE }, { maxAgents: 2, extra: 1 },
      { permissionMode: 'yolo' }, { permissionMode: '' }, { permissionMode: 5 }, { permissionMode: ['plan'] }, { permissionMode: true },
      { panePlacement: 'above' }, { panePlacement: 'under_last' }, { panePlacement: 5 }, { panePlacement: [] },
      { maxAgents: 0 }, { maxAgents: 9 }, { maxAgents: -1 }, { maxAgents: 1.5 }, { maxAgents: '3' }, { maxAgents: '' }, { maxAgents: true }, { maxAgents: [3] }, { maxAgents: {} },
      { limits: { maxAgents: 2 } }, { permission: 'plan' },
    ];
    for (const body of bad) {
      const r = await put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid');
      assert.ok(r.body.message.length < 160, 'the message is short');
    }
    const proto = await a.call('PUT', url(), { body: '{"maxAgents":2,"__proto__":{"permissionMode":"plan"}}', headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400);
    assert.equal(JSON.stringify((await loadConfig(w.env)).config.perProject), saved, 'every refusal left the config as it was');
    assert.equal((await put({ maxAgents: null })).status, 200);
  });

  test('(−) a PUT of one of the three for an unknown project is 404, for a malformed key 400, as non-JSON 415, and without the secret 403', async () => {
    const missing = await put({ maxAgents: 2 }, '0123456789abcdef');
    assert.deepEqual([missing.status, missing.body.error], [404, 'not_found']);
    assert.equal((await put({ permissionMode: 'plan' }, 'short')).status, 400);
    assert.equal((await a.call('PUT', url(), { body: '{"maxAgents":2}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await a.call('PUT', url(), { json: { panePlacement: 'beside' }, headers: { 'x-nika-app': null } })).status, 403);
    assert.deepEqual((await loadConfig(w.env)).config.perProject, {});
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

  test('(+) compaction (C7): the default is on, 80 %, 400k; every window and a one-key patch are saved and read back', async () => {
    assert.deepEqual((await a.call('GET', '/api/app/settings')).body.compaction, { enabled: true, pct: 80, window: 400000 });
    for (const window of [200000, 1000000, 'model', 400000]) {
      const r = await put({ compaction: { window } });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.compaction, { enabled: true, pct: 80, window });
      assert.deepEqual((await a.call('GET', '/api/app/settings')).body.compaction, { enabled: true, pct: 80, window });
    }
    const off = await put({ compaction: { enabled: false, pct: 95, window: 200000 } });
    assert.deepEqual(off.body.compaction, { enabled: false, pct: 95, window: 200000 });
    assert.deepEqual((await loadConfig(w.env)).config.compaction, { enabled: false, pct: 95, window: 200000 });
    assert.deepEqual((await put({ limits: { maxAgents: 2 } })).body.compaction, { enabled: false, pct: 95, window: 200000 }, 'an unrelated PUT keeps it');
    assert.equal((await put({ compaction: { enabled: true, pct: 20, window: 400000 } })).status, 200);
    assert.equal((await put({ compaction: { pct: 80 } })).status, 200);
  });

  test('(−) compaction: a fraction, 19, 96, an unknown window, a non-boolean and unknown keys are 400 naming the field; the saved value stays', async () => {
    assert.equal((await put({ compaction: { enabled: true, pct: 70, window: 1000000 } })).status, 200);
    const named = [[{ pct: 80.5 }, /compaction\.pct/], [{ pct: 19 }, /compaction\.pct/], [{ pct: 96 }, /compaction\.pct/], [{ pct: '80' }, /compaction\.pct/],
      [{ window: 300000 }, /compaction\.window/], [{ window: '400000' }, /compaction\.window/], [{ window: 'auto' }, /compaction\.window/],
      [{ enabled: 'false' }, /compaction\.enabled/], [{ enabled: 0 }, /compaction\.enabled/], [{ autocompact: 400000 }, /compaction\.autocompact/]];
    for (const [patch, re] of named) {
      const r = await put({ compaction: patch });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.match(r.body.message, re, JSON.stringify(patch));
    }
    for (const patch of [{ compaction: 'on' }, { compaction: null }, { compaction: [] }, { compaction: 80 }]) assert.equal((await put(patch)).status, 400, JSON.stringify(patch));
    assert.deepEqual((await loadConfig(w.env)).config.compaction, { enabled: true, pct: 70, window: 1000000 });
    assert.equal((await put({ compaction: { enabled: true, pct: 80, window: 400000 } })).status, 200);
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

describe('subagent history (0.5, W8)', () => {
  const sub = (id, agent, q = '') => `/api/app/session/${id}/subagents/${agent}/history${q}`;
  const writeSub = (agent, lines) => {
    const slugOf = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
    const dir = path.join(fx.claudeDir, 'projects', slugOf(fx.wt), SID.busy, 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `agent-${agent}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); // a transcript with no meta: the snapshot does not list it
  };

  test('(+) passes the ids, before, limit and the history route\'s cache to the module and relays its answer', async () => {
    const a = await boot();
    const r = await a.call('GET', sub(SID.busy, 'a0000000000000001', '?before=10&limit=5'));
    assert.equal(r.status, 200);
    assert.equal(r.body.entries[0].text, 'sub');
    await a.call('GET', sub(SID.busy, 'aaa111'));
    await a.call('GET', `/api/app/session/${SID.busy}/history`);
    const [first, second] = a.deps.calls.filter((c) => c[0] === 'readSubagentHistory');
    assert.deepEqual(first.slice(1, 4), [SID.busy, 'a0000000000000001', { before: '10', limit: '5' }]);
    assert.deepEqual(second.slice(2, 4), ['aaa111', { before: undefined, limit: undefined }]);
    assert.equal(first[4].claudeDir, a.ctx.claudeDir);
    assert.equal(typeof first[4].now, 'function');
    assert.equal(first[4].cache, second[4].cache);
    assert.equal(first[4].cache, a.deps.calls.find((c) => c[0] === 'readHistory')[3].cache, 'one transcript-index memo for both routes');
  });

  test('(+) an id is also accepted percent-encoded (the same decoding as every id parameter)', async () => {
    const a = await boot();
    assert.equal((await a.call('GET', sub(SID.busy, 'a%2D1'))).status, 200);
    assert.equal(a.deps.calls.find((c) => c[0] === 'readSubagentHistory')[2], 'a-1');
  });

  test('(−) a session id that is not a UUID is 404 "no such session" without calling the module', async () => {
    const a = await boot();
    for (const id of ['..%2F..%2Fetc%2Fpasswd', 'not-a-uuid', REQ_ID.toUpperCase(), `${SID.busy}x`, '%2e%2e%2f', 'a%00b']) {
      const r = await a.call('GET', sub(id, 'aaa111'));
      assert.equal(r.status, 404, id);
      assert.equal(r.body.message, 'no such session', id);
    }
    // a dot segment never reaches a handler as an id: the URL parser removes it (WHATWG), so the path is another route or none
    const dots = await a.call('GET', sub('%2E%2E', 'aaa111'));
    assert.equal(dots.status, 404);
    assert.equal(a.deps.calls.some((c) => c[0] === 'readSubagentHistory'), false);
  });

  test('(−) an agent id that is not a SUBAGENT_ID is 404 "no such subagent" without calling the module', async () => {
    const a = await boot();
    for (const agent of ['a%2Fb', 'a%5Cb', 'a.b', 'a%20b', 'x'.repeat(65), '%00', 'a%0Ab', '%2e%2e%2f', '.hidden']) {
      const r = await a.call('GET', sub(SID.busy, agent));
      assert.equal(r.status, 404, agent);
      assert.equal(r.body.message, 'no such subagent', agent);
    }
    assert.equal((await a.call('GET', `/api/app/session/${SID.busy}/subagents//history`)).status, 404, 'empty agent id');
    assert.equal((await a.call('GET', `/api/app/session/${SID.busy}/subagents/a/b/history`)).status, 404, 'a slash splits the path: no such route');
    // `..` and `%2E%2E` are dot segments: the URL parser folds them away before any handler runs, so they cannot name a file; they reach the
    // subagent module never (the folded path is the session's own history route, which has its own tests)
    for (const dots of ['..', '%2E%2E', '%2e%2E']) {
      const r = await a.call('GET', sub(SID.busy, dots));
      assert.equal(JSON.stringify(r.body).includes('"sub"'), false, dots);
    }
    assert.equal(a.deps.calls.some((c) => c[0] === 'readSubagentHistory'), false);
  });

  test('(−) the module\'s own 400 and 404 are relayed; POST is 405; a trailing slash is no route', async () => {
    const a = await boot();
    assert.equal((await a.call('GET', sub(SID.busy, 'aaa111', '?limit=0'))).status, 400);
    assert.equal((await a.call('GET', sub(SID.busy, 'missing'))).status, 404);
    const m = await a.call('POST', sub(SID.busy, 'aaa111'), { json: {} });
    assert.equal(m.status, 405);
    assert.equal(m.headers.allow, 'GET');
    assert.equal((await a.call('GET', `${sub(SID.busy, 'aaa111')}/`)).status, 404);
    assert.equal((await a.call('GET', `/api/app/session/${SID.busy}/subagents/aaa111`)).status, 404);
  });

  test('(−) without the app secret the route is refused like every app route: 403, module not called', async () => {
    const a = await boot();
    for (const headers of [{ 'x-nika-app': null }, { 'x-nika-app': WRONG_SAME_LENGTH }, { origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const r = await a.call('GET', sub(SID.busy, 'aaa111'), { headers });
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
    assert.equal(a.deps.calls.some((c) => c[0] === 'readSubagentHistory'), false);
  });

  test('(+) src/appio.js hands readSubagentHistory to the app API next to readHistory (the one place the real module is wired in)', () => {
    const src = fs.readFileSync(new URL('../src/appio.js', import.meta.url), 'utf8');
    assert.match(src, /import \{ readHistory, readSubagentHistory \} from '\.\/collect\/history\.js';/);
    assert.match(src, /^\s+readHistory, readSubagentHistory, /m);
  });

  test('(+) with the real module a subagent transcript in the session\'s folder is paged; (−) an unknown agent and an unknown session are 404', async () => {
    writeSub('ddd444', [{ type: 'user', isSidechain: true, timestamp: '2026-11-07T12:00:00.000Z', message: { role: 'user', content: 'sub prompt' } },
      { type: 'assistant', isSidechain: true, timestamp: '2026-11-07T12:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sub answer' }] } }]);
    const a = await boot({ deps: makeDeps({ readHistory, readSubagentHistory }) });
    const r = await a.call('GET', sub(SID.busy, 'ddd444', '?limit=10'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entries.map((e) => [e.role, e.text]), [['user', 'sub prompt'], ['assistant', 'sub answer']]);
    assert.equal(r.body.nextBefore, null);
    const unknown = await a.call('GET', sub(SID.busy, 'zzz999'));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.message, 'no such subagent');
    assert.equal((await a.call('GET', sub('99999999-9999-4999-8999-999999999999', 'ddd444'))).body.message, 'no such session');
    assert.equal((await a.call('GET', sub(SID.idle, 'ddd444'))).body.message, 'no such subagent', 'another session has no such file');
    assert.equal((await a.call('GET', sub(SID.busy, 'ddd444', '?limit=0'))).status, 400);
    assert.equal((await a.call('GET', sub(SID.busy, 'ddd444', '?before=999999'))).status, 400);
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

  describe('nesting through the route (the real spawnAgent, an in-memory tmux)', () => {
    const MAIN = (world) => ({ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${world.project.key}/orchestrator`, depth: '1' });
    const rigSpawn = async (settings, extraPanes = () => []) => {
      const world = await makeWorld(settings);
      const exec = fakeTmux({ panes: [MAIN(world), ...extraPanes(world)] });
      const a = await boot({ world, deps: makeDeps({ spawnAgent }), ctxOver: { exec, tmuxBin: TMUX, claudeBin: CLAUDE } });
      return { world, exec, a, post: (json) => a.call('POST', '/api/app/spawn', { json: { project: world.project.key, model: 'sonnet', brief: 'Do the thing.', ...json } }) };
    };
    const agents = (world, names, parent) => names.map((n, i) => ({ id: `%${40 + i}`, session: 'My-App', window: 0, windowName: 'zsh', command: 'node', role: 'agent', agent: `${world.project.key}/${n}`, depth: parent ? '2' : '1', parent: parent ?? '' }));

    test('(+) a spawn with parent and role: the main orchestrator\'s pane parents a sub-orchestrator at depth 2, and that one parents an agent at depth 3', async () => {
      const r = await rigSpawn();
      const res = await r.post({ name: 'planner', role: 'orchestrator', parent: '%1' });
      assert.equal(res.status, 200, res.raw);
      assert.equal(res.body.pane, '%20');
      const p = r.exec.panes.find((x) => x.id === '%20');
      assert.deepEqual([p.role, p.agent, p.depth, p.parent], ['sub-orchestrator', `${r.world.project.key}/planner`, '2', '%1']);
      const under = await r.post({ name: 'worker', parent: '%20' });
      assert.equal(under.status, 200, under.raw);
      assert.deepEqual(r.exec.panes.find((x) => x.id === '%21').depth, '3');
    });

    test('(+) F4: with no tmux server a spawn through the route creates the project session; (−) a claude that dies at launch is a 502 claude_exited body, for spawn and for start', async () => {
      const world = await makeWorld();
      const exec = fakeTmux();
      const ctxOver = { exec, tmuxBin: TMUX, claudeBin: CLAUDE };
      const a = await boot({ world, deps: makeDeps({ spawnAgent, startOrchestrator }), ctxOver });
      const body = { project: world.project.key, name: 'builder-1', model: 'sonnet', brief: 'Do the thing.' };
      const made = await a.call('POST', '/api/app/spawn', { json: body });
      assert.deepEqual([made.status, made.body.pane, made.body.session, exec.of('new-session').length], [200, '%20', 'My-App', 1], made.raw);
      const dying = fakeTmux();
      const d = await boot({ world, deps: makeDeps({ spawnAgent, startOrchestrator }), ctxOver: { ...ctxOver, exec: dying, sleep: async () => { dying.panes.splice(0); } } });
      for (const [route, json] of [['/api/app/spawn', { ...body, name: 'builder-2' }], ['/api/app/orchestrator/start', { project: world.project.key }]]) {
        const r = await d.call('POST', route, { json });
        assert.deepEqual([r.status, r.body.error, r.body.message], [502, 'claude_exited', 'Claude exited right after it started. Run `claude` once in a terminal in this folder to see why (for example, to log in).'], route);
      }
    });

    test('(−) the 409 depth and 404 parent-gone answers reach the page with their codes and nothing is started', async () => {
      const r = await rigSpawn();
      assert.equal((await r.post({ name: 'planner', role: 'orchestrator', parent: '%1' })).status, 200);
      const deeper = await r.post({ name: 'deeper', role: 'orchestrator', parent: '%20' });
      assert.deepEqual([deeper.status, deeper.body.error], [409, 'depth']);
      assert.match(deeper.body.message, /Only the main orchestrator can/);
      const gone = await r.post({ name: 'x1', parent: '%99' });
      assert.deepEqual([gone.status, gone.body.error], [404, 'not_found']);
      const none = await r.post({ name: 'x2', role: 'orchestrator' });
      assert.deepEqual([none.status, none.body.error], [409, 'depth']);
      assert.equal(r.exec.of('split-window').length, 1, 'only the first sub-orchestrator was started');
    });

    test('(−) the 409 depth text reaches the page whole: for a role-agent parent and for another project\'s orchestrator, whatever role is asked; nothing is started', async () => {
      const foreign = { id: '%50', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: 'ffffffffffffffff/orchestrator', depth: '1' };
      const r = await rigSpawn({}, (world) => [...agents(world, ['helper'], '%1'), foreign]);
      const text = (who) => `${who} can't start agents for this project: only this project's orchestrator and its sub-orchestrators can. Nothing was started.`;
      for (const role of ['agent', 'orchestrator']) {
        for (const [parent, who] of [['%40', 'helper'], ['%50', 'orchestrator']]) {
          const res = await r.post({ name: 'child', role, parent });
          assert.deepEqual([res.status, res.body], [409, { error: 'depth', message: text(who) }], `${role} under ${parent}`);
        }
      }
      assert.equal(r.exec.of('split-window').length, 0);
      assert.equal(r.exec.of('set-option').length, 0);
    });

    test('(−) a 409 limit body carries { scope, running, max }: parent, then project', async () => {
      const r = await rigSpawn({ limits: { maxAgents: 2 } }, (world) => agents(world, ['a', 'b'], '%1'));
      const parent = await r.post({ name: 'c', parent: '%1' });
      assert.deepEqual([parent.status, parent.body.error, parent.body.scope, parent.body.running, parent.body.max], [409, 'limit', 'parent', 2, 2]);
      assert.equal(typeof parent.body.message, 'string');
      const full = await rigSpawn({ limits: { maxAgents: 2 } }, (world) => [
        ...agents(world, ['a', 'b'], '%1'), ...agents(world, ['c', 'd'], '%61').map((p, i) => ({ ...p, id: `%${50 + i}` })), ...agents(world, ['e', 'f'], '%62').map((p, i) => ({ ...p, id: `%${55 + i}` })),
      ]);
      const project = await full.post({ name: 'g' });
      assert.deepEqual([project.status, project.body.error, project.body.scope, project.body.running, project.body.max], [409, 'limit', 'project', 6, 6]);
      assert.deepEqual(Object.keys(project.body).sort(), ['error', 'max', 'message', 'running', 'scope']);
    });

    test('(−) role and parent that are not valid are 400 invalid from the route, with nothing started', async () => {
      const r = await rigSpawn();
      for (const extra of [{ role: 'sub-orchestrator' }, { role: 'admin' }, { parent: 'x' }, { parent: '%1;' }, { parent: 7 }]) {
        const res = await r.post({ name: 'bad', ...extra });
        assert.deepEqual([res.status, res.body.error], [400, 'invalid'], JSON.stringify(extra));
      }
      assert.equal(r.exec.of('split-window').length, 0);
    });

    // 0.5 (W9): the route passes the body on; spawnAgent's parse runs before anything else, so a bad kind starts nothing
    test('(−) a kind that is not a word of the list, and a kind with role orchestrator, are 400 invalid from the route: no tmux call, nothing written', async () => {
      const r = await rigSpawn();
      for (const extra of [{ kind: 'boss' }, { kind: 'Coder' }, { kind: '' }, { kind: null }, { kind: 5 }, { kind: ['coder'] }, { kind: 'coder ' }]) {
        const res = await r.post({ name: 'bad', ...extra });
        assert.deepEqual([res.status, res.body], [400, { error: 'invalid', message: 'invalid kind: use coder, reviewer, tester, designer, scout, writer or agent' }], JSON.stringify(extra));
      }
      const orch = await r.post({ name: 'planner', role: 'orchestrator', parent: '%1', kind: 'coder' });
      assert.deepEqual([orch.status, orch.body], [400, { error: 'invalid', message: 'kind is for agents: a sub-orchestrator always shows sub-orchestrator' }]);
      assert.deepEqual(r.exec.calls, [], 'not even a listing');
      assert.equal(fs.existsSync(reportsDir(r.world.project.key, r.world.env)), false);
    });

    test('(+) a kind through the route tags the pane and comes back in the body; without one the model decides', async () => {
      const r = await rigSpawn();
      const asked = await r.post({ name: 'reviewer-1', kind: 'reviewer' });
      assert.deepEqual([asked.status, asked.body.kind], [200, 'reviewer'], asked.raw);
      const derived = await r.post({ name: 'builder-1', model: 'claude-sonnet-5-5' });
      assert.deepEqual([derived.status, derived.body.kind], [200, 'coder'], derived.raw);
      assert.deepEqual(r.exec.panes.filter((p) => p.id !== '%1').map((p) => p.kind), ['reviewer', 'coder']);
    });
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

describe('orchestrator pick: PUT|DELETE /api/app/projects/:key/orchestrator and the orchestrator field of GET /projects (O1: C1, C2)', () => {
  const ID = {
    live: '11111111-1111-4111-8111-111111111111',
    ended: '22222222-2222-4222-8222-222222222222',
    agent: '33333333-3333-4333-8333-333333333333',
    other: '44444444-4444-4444-8444-444444444444',
    running: '55555555-5555-4555-8555-555555555555',
    nopane: '66666666-6666-4666-8666-666666666666',
    nowhere: '77777777-7777-4777-8777-777777777777',
    unknown: '99999999-9999-4999-8999-999999999999',
    offpane: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sub: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const worlds = [];
  after(() => worlds.forEach((x) => x.cleanup()));

  /** A project with one tmux server and a table of sessions: findSession answers from it like src/model.js (agent + the project's group). */
  async function rig({ extra = [], tmuxPanes, depsOver = {}, ctxOver = {} } = {}) {
    const world = await makeWorld();
    worlds.push(world);
    const pane = (id, o = {}) => ({ id, session: 'work', window: 0, windowName: 'main', command: 'claude', ...o });
    const exec = fakeTmux({ panes: tmuxPanes ?? [pane('%6'), pane('%7', { role: 'agent' }), pane('%5', { role: 'orchestrator' }), pane('%9', { command: 'zsh' }), pane('%4', { role: 'sub-orchestrator' })] });
    const agent = (id, o = {}) => ({ id, name: id.slice(0, 8), live: false, role: null, pane: null, ...o });
    const mine = [
      agent(ID.live, { name: 'planner', live: true, pane: { id: '%6', session: 'work', command: 'claude' } }),
      agent(ID.ended, { name: 'old-planner' }),
      agent(ID.agent, { live: true, role: 'agent', pane: { id: '%7', session: 'work', command: 'claude' } }),
      agent(ID.sub, { live: true, role: 'sub-orchestrator', pane: { id: '%4', session: 'work', command: 'claude' } }),
      agent(ID.nopane, { live: true }),
      agent(ID.offpane, { live: true, pane: { id: '%9', session: 'work', command: 'zsh' } }),
      ...extra,
    ];
    const group = { key: world.project.key, root: world.project.dir, agents: mine };
    const table = new Map(mine.map((x) => [x.id, { agent: x, group }]));
    table.set(ID.other, { agent: agent(ID.other, { live: true, pane: { id: '%6', session: 'work', command: 'claude' } }), group: { key: 'fedcba9876543210', root: '/work/other-project', agents: [] } });
    table.set(ID.nowhere, { agent: agent(ID.nowhere), group: { key: '(unknown)', root: null, agents: [] } });
    const lookups = [];
    const batches = []; // each findSessions call: the ids it was asked for (the index walk of GET /projects)
    const findSessionFake = async (id) => { lookups.push(id); return table.get(id) ?? null; };
    const findSessionsFake = async (ids) => { batches.push([...ids]); return new Map(ids.filter((id) => table.has(id)).map((id) => [id, table.get(id)])); };
    const a = await boot({ world, deps: makeDeps(depsOver), ctxOver: { exec, tmuxBin: TMUX, findSession: findSessionFake, findSessions: findSessionsFake, ...ctxOver } });
    const url = `/api/app/projects/${world.project.key}/orchestrator`;
    return { world, exec, a, url, lookups, batches, table, group, put: (json) => a.call('PUT', url, { json }), pick: () => getOrchestrator(world.project.key, world.env) };
  }
  /** A refusal answers with its code and sends no tmux command and writes nothing. */
  async function refused(r, status, error, res) {
    assert.deepEqual([res.status, res.body.error], [status, error], JSON.stringify(res.body));
    assert.equal(typeof res.body.message, 'string');
    assert.deepEqual(r.exec.calls, [], 'no tmux command');
    assert.equal(await r.pick(), null, 'nothing stored');
    assert.equal(r.a.ctx.started.size, 0, 'nothing recorded');
  }

  test('(+) PUT for an ended session stores the id and answers it; no tmux command is sent', async () => {
    const r = await rig();
    const res = await r.put({ sessionId: ID.ended });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { orchestrator: { sessionId: ID.ended, state: 'ended', name: 'old-planner', pane: null } });
    assert.equal(await r.pick(), ID.ended);
    assert.deepEqual(r.exec.calls, []);
    assert.equal(r.a.ctx.started.size, 0);
    assert.match(res.headers['cache-control'] ?? '', /no-store/);
  });

  test('(+) PUT for a live session with a pane tags the pane (exact argv, constant values), records it in started, stores the id and makes the pane eligible', async () => {
    const r = await rig();
    const res = await r.put({ sessionId: ID.live });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { orchestrator: { sessionId: ID.live, state: 'live', name: 'planner', pane: '%6' } });
    assert.deepEqual(r.exec.calls, [
      [TMUX, '-u', 'set-option', '-p', '-t', '%6', '@nika-role', 'orchestrator'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%6', '@nika-agent', `${r.world.project.key}/orchestrator`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%6', '@nika-depth', '1'],
    ]);
    assert.deepEqual(r.a.ctx.started.get('%6'), { key: r.world.project.key, name: 'orchestrator', sessionId: ID.live, role: 'orchestrator' });
    assert.equal(await r.pick(), ID.live);
    assert.deepEqual(r.exec.panes.find((x) => x.id === '%6').role, 'orchestrator');
    assert.deepEqual(r.exec.panes.find((x) => x.id === '%6').agent, `${r.world.project.key}/orchestrator`);
  });

  test('(+) PUT replaces an earlier pick; the same session again is fine even while it is the running orchestrator', async () => {
    const r = await rig({ extra: [{ id: ID.running, name: 'main-orch', live: true, role: 'orchestrator', pane: { id: '%5', session: 'work', command: 'claude' } }] });
    await setOrchestrator(r.world.project.key, ID.ended, r.world.env);
    assert.equal((await r.put({ sessionId: ID.running })).status, 200, 'the only running orchestrator is this one');
    assert.equal(await r.pick(), ID.running);
    assert.equal((await r.put({ sessionId: ID.running })).status, 200, 'again: the same session is not "another" orchestrator');
    assert.equal((await r.put({ sessionId: ID.ended })).status, 409, 'now another one is running');
  });

  test('(+) DELETE forgets the id and retags nothing; a second DELETE is still 200', async () => {
    const r = await rig();
    await r.put({ sessionId: ID.live });
    r.exec.calls.length = 0;
    const del = await r.a.call('DELETE', r.url);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { orchestrator: null });
    assert.equal(await r.pick(), null);
    assert.deepEqual(r.exec.calls, [], 'a live pane keeps its tags until it ends');
    assert.equal((await r.a.call('DELETE', r.url)).status, 200);
  });

  test('(−) 404 not_found for a session nika does not know', async () => {
    const r = await rig();
    await refused(r, 404, 'not_found', await r.put({ sessionId: ID.unknown }));
  });

  test('(−) 409 other_project for a session of another project, or of none', async () => {
    const r = await rig();
    await refused(r, 409, 'other_project', await r.put({ sessionId: ID.other }));
    await refused(r, 409, 'other_project', await r.put({ sessionId: ID.nowhere }));
  });

  test('(−) 409 agent_session for a live nika agent: nothing is tagged, stored or recorded', async () => {
    const r = await rig();
    const res = await r.put({ sessionId: ID.agent });
    await refused(r, 409, 'agent_session', res);
    assert.equal(res.body.message, "That session is an agent nika started, so it can't be the orchestrator. Nothing changed.");
  });

  test('(−) 409 agent_session for a live sub-orchestrator too: nothing is tagged, stored or recorded', async () => {
    const r = await rig();
    const res = await r.put({ sessionId: ID.sub });
    await refused(r, 409, 'agent_session', res);
    assert.match(res.body.message, /sub-orchestrator nika started/);
    assert.match(res.body.message, /Nothing changed/);
  });

  test('(−) a running sub-orchestrator is not "another main orchestrator": Set on another session is not blocked by it', async () => {
    const r = await rig();
    assert.equal(r.exec.panes.find((x) => x.id === '%4').role, 'sub-orchestrator');
    assert.equal((await r.put({ sessionId: ID.live })).status, 200); // only a pane tagged `orchestrator` (or the stored pick) blocks
  });

  test('(−) 409 orchestrator_running while another main orchestrator is live, for a live and for an ended session', async () => {
    const r = await rig({ extra: [{ id: ID.running, name: 'main-orch', live: true, role: 'orchestrator', pane: { id: '%5', session: 'work', command: 'claude' } }] });
    await refused(r, 409, 'orchestrator_running', await r.put({ sessionId: ID.live }));
    await refused(r, 409, 'orchestrator_running', await r.put({ sessionId: ID.ended }));
  });

  test('(−) 409 orchestrator_running also when the stored pick is the live one (even if its pane carries no tag)', async () => {
    const r = await rig();
    await setOrchestrator(r.world.project.key, ID.live, r.world.env);
    const res = await r.put({ sessionId: ID.ended });
    assert.deepEqual([res.status, res.body.error], [409, 'orchestrator_running']);
    assert.deepEqual(r.exec.calls, []);
    assert.equal(await r.pick(), ID.live);
  });

  test('(−) 409 no_pane for a live session outside tmux, and for one whose pane does not run claude', async () => {
    const r = await rig();
    await refused(r, 409, 'no_pane', await r.put({ sessionId: ID.nopane }));
    await refused(r, 409, 'no_pane', await r.put({ sessionId: ID.offpane }));
  });

  test('(−) a body that is not exactly { sessionId: a UUID } is 400; non-JSON is 415; too large is 413', async () => {
    const r = await rig();
    for (const json of [{}, { sessionId: 'x' }, { sessionId: '../../etc/passwd' }, { sessionId: ID.live.toUpperCase().replace(/1/g, 'A') }, { sessionId: 5 }, { sessionId: null }, { sessionId: [ID.live] }, { sessionId: ID.live, extra: 1 }, { session: ID.live }]) {
      const res = await r.put(json);
      assert.deepEqual([res.status, res.body.error], [400, 'invalid'], JSON.stringify(json));
    }
    assert.equal((await r.a.call('PUT', r.url, { body: `sessionId=${ID.live}`, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await r.a.call('PUT', r.url, { json: { sessionId: ID.live, pad: 'x'.repeat(5000) } })).status, 413);
    assert.deepEqual(r.lookups, [], 'a bad request never reaches the lookup');
    await refused(r, 400, 'invalid', await r.put({}));
  });

  test('(−) a malformed key is 400, an unregistered one 404; GET and POST are 405 with Allow: PUT, DELETE', async () => {
    const r = await rig();
    for (const key of ['..%2Fx', 'ABCDEF0123456789', 'short']) assert.equal((await r.a.call('PUT', `/api/app/projects/${key}/orchestrator`, { json: { sessionId: ID.ended } })).status, 400, key);
    assert.equal((await r.a.call('PUT', '/api/app/projects/0123456789abcdef/orchestrator', { json: { sessionId: ID.ended } })).status, 404);
    assert.equal((await r.a.call('DELETE', '/api/app/projects/0123456789abcdef/orchestrator')).status, 404);
    const get = await r.a.call('GET', r.url);
    assert.equal(get.status, 405);
    assert.match(get.headers.allow, /PUT/);
    assert.match(get.headers.allow, /DELETE/);
    assert.equal((await r.a.call('POST', r.url, { json: {} })).status, 405);
    assert.deepEqual(r.lookups, []);
  });

  test('(−) the secret still guards the routes: without it PUT and DELETE are 403 and nothing happens', async () => {
    const r = await rig();
    assert.equal((await r.a.call('PUT', r.url, { json: { sessionId: ID.ended }, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await r.a.call('DELETE', r.url, { headers: { 'x-nika-app': null } })).status, 403);
    assert.deepEqual(r.lookups, []);
  });

  test('(−) a lookup that cannot read the transcript index is 503 index_unavailable: not "not found", and nothing is written', async () => {
    const r = await rig({ ctxOver: { findSession: async () => { throw Object.assign(new Error('x'), { code: 'EINDEX' }); } } });
    await refused(r, 503, 'index_unavailable', await r.put({ sessionId: ID.ended }));
  });

  test('(−) the project is removed while the request runs: 404 and no tmux command', async () => {
    const r = await rig();
    r.a.ctx.findSession = async (id) => { await removeProject(r.world.project.key, r.world.env); return r.table.get(id); };
    await refused(r, 404, 'not_found', await r.put({ sessionId: ID.live }));
  });

  // --- one adoption at a time per project (M3) ---

  /** A findSession that waits at `gate` for the ids in `holdIds`, and says when the first one is in. */
  function gated(r, holdIds) {
    const inner = r.a.ctx.findSession;
    let release;
    const gate = new Promise((res) => { release = res; });
    let entered;
    const first = new Promise((res) => { entered = res; });
    r.a.ctx.findSession = async (id) => {
      if (holdIds.includes(id)) {
        entered();
        await gate;
      }
      return inner(id);
    };
    return { release, first };
  }

  test("(−) a second PUT for the same project while one runs is 409 busy: nothing is sent and nothing is written; once it ends, the next PUT goes through (M3)", async () => {
    const r = await rig();
    const g = gated(r, [ID.live]);
    const firstPut = r.put({ sessionId: ID.live });
    await g.first;
    const second = await r.put({ sessionId: ID.ended });
    assert.deepEqual([second.status, second.body.error], [409, 'busy']);
    assert.equal(second.body.message, "Another change to this project's orchestrator is still running. Try again.");
    assert.deepEqual(r.exec.calls, [], 'the second sent no tmux command');
    assert.equal(await r.pick(), null, 'the second wrote nothing (the first has not finished)');
    assert.deepEqual(r.lookups, [], 'the second never reached the lookup');
    g.release();
    const done = await firstPut;
    assert.deepEqual([done.status, done.body.orchestrator.sessionId], [200, ID.live]);
    assert.equal(await r.pick(), ID.live);
    assert.equal((await r.put({ sessionId: ID.live })).status, 200, 'the guard is released');
  });

  test('(+) a PUT for another project is not blocked by one that runs; a refused PUT releases its guard too', async () => {
    const r = await rig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-api-pick-'));
    try {
      const p2 = await addProject(dir, r.world.env);
      r.table.set(ID.unknown, { agent: { id: ID.unknown, name: 'p2-old', live: false, pane: null }, group: { key: p2.key, root: p2.dir, agents: [] } });
      const g = gated(r, [ID.live]);
      const firstPut = r.put({ sessionId: ID.live });
      await g.first;
      const other = await r.a.call('PUT', `/api/app/projects/${p2.key}/orchestrator`, { json: { sessionId: ID.unknown } });
      assert.deepEqual([other.status, other.body.orchestrator.state], [200, 'ended']);
      g.release();
      assert.equal((await firstPut).status, 200);
      // a refused one (404) frees the guard: the next PUT is not busy
      const nope = await r.put({ sessionId: ID.nowhere });
      assert.equal(nope.status, 409);
      assert.equal(nope.body.error, 'other_project');
      assert.equal((await r.put({ sessionId: ID.live })).status, 200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(−) a PUT that throws (index unreadable) releases the guard: the next PUT is not busy', async () => {
    const r = await rig();
    const inner = r.a.ctx.findSession;
    r.a.ctx.findSession = async () => { throw Object.assign(new Error('x'), { code: 'EINDEX' }); };
    assert.equal((await r.put({ sessionId: ID.ended })).status, 503);
    r.a.ctx.findSession = inner;
    assert.equal((await r.put({ sessionId: ID.ended })).status, 200);
  });

  // --- GET /api/app/projects: the orchestrator field (C1) ---

  test('(+) GET /projects: no saved orchestrator is null and nothing is looked up', async () => {
    const r = await rig();
    const res = await r.a.call('GET', '/api/app/projects');
    assert.equal(res.body.projects[0].orchestrator, null);
    assert.deepEqual([r.lookups, r.batches], [[], []]);
  });

  test('(+) GET /projects: a live pick, an ended pick (from the 24 h snapshot, no extra lookup) and a pick outside the snapshot (from the index)', async () => {
    const snap = { groups: [] };
    const r = await rig({ depsOver: { collect: async () => snap } });
    snap.groups.push({ key: r.world.project.key, root: r.world.project.dir, agents: [
      { id: ID.live, name: 'planner', live: true, state: 'idle', pane: { id: '%6' } },
      { id: ID.ended, name: 'old-planner', live: false, state: 'ended', pane: { id: '%6' } },
    ] });
    const get = async () => (await r.a.call('GET', '/api/app/projects')).body.projects[0].orchestrator;
    await setOrchestrator(r.world.project.key, ID.live, r.world.env);
    assert.deepEqual(await get(), { sessionId: ID.live, state: 'live', name: 'planner', pane: '%6' });
    await setOrchestrator(r.world.project.key, ID.ended, r.world.env);
    assert.deepEqual(await get(), { sessionId: ID.ended, state: 'ended', name: 'old-planner', pane: null }, 'an ended session shows no pane');
    assert.deepEqual([r.lookups, r.batches], [[], []], 'both came from the snapshot');
    r.table.set(ID.unknown, { agent: { id: ID.unknown, name: 'ancient', live: false, pane: null }, group: r.group });
    await setOrchestrator(r.world.project.key, ID.unknown, r.world.env);
    assert.deepEqual(await get(), { sessionId: ID.unknown, state: 'ended', name: 'ancient', pane: null });
    assert.deepEqual(r.batches, [[ID.unknown]], 'outside the window: the index is asked, whatever the age');
    assert.deepEqual(r.lookups, [], 'never the full single-session lookup (a whole collect) on the poll');
  });

  test('(+) GET /projects: a pick nika has no transcript for is gone', async () => {
    const r = await rig();
    await setOrchestrator(r.world.project.key, ID.unknown, r.world.env);
    const o = (await r.a.call('GET', '/api/app/projects')).body.projects[0].orchestrator;
    assert.deepEqual(o, { sessionId: ID.unknown, state: 'gone', name: null, pane: null });
  });

  test('(−) GET /projects: a lookup that fails is neither gone nor ended: the field is null', async () => {
    const r = await rig({ ctxOver: { findSessions: async () => { throw new Error('index unreadable'); } } });
    await setOrchestrator(r.world.project.key, ID.unknown, r.world.env);
    const res = await r.a.call('GET', '/api/app/projects');
    assert.equal(res.status, 200);
    assert.equal(res.body.projects[0].orchestrator, null);
  });

  test('(+) GET /projects: three projects with picks older than 24 h cost exactly ONE index lookup and one snapshot, never a walk per project (I1)', async () => {
    const r = await rig();
    const dirs = [1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'nika-api-pick-')));
    try {
      const p2 = await addProject(dirs[0], r.world.env);
      const p3 = await addProject(dirs[1], r.world.env);
      const old2 = '12121212-1212-4212-8212-121212121212';
      const old3 = '13131313-1313-4313-8313-131313131313';
      const lost = '14141414-1414-4414-8414-141414141414';
      const ended = (id, name) => ({ id, name, live: false, role: null, pane: null });
      r.table.set(old2, { agent: ended(old2, 'second'), group: { key: p2.key, root: p2.dir, agents: [] } });
      r.table.set(old3, { agent: ended(old3, 'third'), group: { key: p3.key, root: p3.dir, agents: [] } });
      await setOrchestrator(r.world.project.key, ID.ended, r.world.env);
      await setOrchestrator(p2.key, old2, r.world.env);
      await setOrchestrator(p3.key, lost, r.world.env); // no transcript: gone
      const res = await r.a.call('GET', '/api/app/projects');
      const byKey = Object.fromEntries(res.body.projects.map((x) => [x.key, x.orchestrator]));
      assert.deepEqual(byKey[r.world.project.key], { sessionId: ID.ended, state: 'ended', name: 'old-planner', pane: null });
      assert.deepEqual(byKey[p2.key], { sessionId: old2, state: 'ended', name: 'second', pane: null });
      assert.deepEqual(byKey[p3.key], { sessionId: lost, state: 'gone', name: null, pane: null });
      assert.equal(r.batches.length, 1, 'one index lookup for the whole request');
      assert.deepEqual([...r.batches[0]].sort(), [ID.ended, old2, lost].sort(), 'all three picks in that one lookup');
      assert.deepEqual(r.lookups, [], 'never the single-session lookup (a full collect) on the poll');
      assert.equal(r.a.deps.calls.filter((c) => c[0] === 'collect').length, 1, 'one snapshot for the request');
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('(+) GET /projects: two projects with the same pick id ask the index for it once', async () => {
    const r = await rig();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-api-pick-'));
    try {
      const p2 = await addProject(dir, r.world.env);
      await setOrchestrator(r.world.project.key, ID.ended, r.world.env);
      await setOrchestrator(p2.key, ID.ended, r.world.env);
      const res = await r.a.call('GET', '/api/app/projects');
      assert.deepEqual(r.batches, [[ID.ended]]);
      const states = Object.fromEntries(res.body.projects.map((x) => [x.key, x.orchestrator.state]));
      assert.deepEqual(states, { [r.world.project.key]: 'ended', [p2.key]: 'gone' }, "the other project's folder does not own that session");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(−) GET /projects: a hand-edited pick naming another project's live session reads gone, with no pane to open (I2, T47)", async () => {
    const r = await rig();
    await setOrchestrator(r.world.project.key, ID.other, r.world.env); // live, pane %6, group of another project
    const o = (await r.a.call('GET', '/api/app/projects')).body.projects[0].orchestrator;
    assert.deepEqual(o, { sessionId: ID.other, state: 'gone', name: null, pane: null });
  });

  test("(−) GET /projects: the same when the other project's session is in the 24 h snapshot", async () => {
    const snap = { groups: [{ key: 'fedcba9876543210', root: '/work/other-project', agents: [{ id: ID.other, name: 'stranger', live: true, state: 'idle', pane: { id: '%6' } }] }] };
    const r = await rig({ depsOver: { collect: async () => snap } });
    await setOrchestrator(r.world.project.key, ID.other, r.world.env);
    const o = (await r.a.call('GET', '/api/app/projects')).body.projects[0].orchestrator;
    assert.deepEqual(o, { sessionId: ID.other, state: 'gone', name: null, pane: null });
    assert.deepEqual(r.batches, [], 'found in the snapshot: no lookup');
  });

  test("(+) GET /projects: a session whose group is another key but this project's folder is this project's (the page's own match)", async () => {
    const r = await rig();
    r.table.set(ID.unknown, { agent: { id: ID.unknown, name: 'by-folder', live: false, pane: null }, group: { key: 'fedcba9876543210', root: r.world.project.dir, agents: [] } });
    await setOrchestrator(r.world.project.key, ID.unknown, r.world.env);
    const o = (await r.a.call('GET', '/api/app/projects')).body.projects[0].orchestrator;
    assert.deepEqual(o, { sessionId: ID.unknown, state: 'ended', name: 'by-folder', pane: null });
  });

  test('(−) GET /projects: no snapshot (collect failed) proves nothing about a pick: null, and no index lookup that could mislabel a live session as ended', async () => {
    const r = await rig({ depsOver: { collect: async () => { throw new Error('collect failed'); } } });
    await setOrchestrator(r.world.project.key, ID.live, r.world.env);
    const res = await r.a.call('GET', '/api/app/projects');
    assert.equal(res.status, 200);
    assert.equal(res.body.projects[0].orchestrator, null);
    assert.deepEqual([r.lookups, r.batches], [[], []]);
  });

  test('(+) POST orchestrator/start relays the module\'s answer, `cleared: gone` included, and the module gets the shared ctx (with findSession)', async () => {
    const r = await rig({ depsOver: { startOrchestrator: async () => ({ status: 200, body: { pane: '%3', session: 's', sessionId: ID.live, created: true, cleared: 'gone' } }) } });
    const res = await r.a.call('POST', '/api/app/orchestrator/start', { json: { project: r.world.project.key } });
    assert.deepEqual(res.body, { pane: '%3', session: 's', sessionId: ID.live, created: true, cleared: 'gone' });
    assert.equal(typeof r.a.ctx.findSession, 'function');
    assert.equal(typeof r.a.ctx.findSessions, 'function');
  });

  test('(−) the browser tier (no app handler) has no orchestrator route and carries no orchestrator field', async () => {
    const server = createServer({ config: fx.config, exec: fakeExec(), token: 'tok', now: () => NOW, version: '0.0.0' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    servers.push(server);
    const port = server.address().port;
    const get = (method, p) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'content-length': '2' }) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      q.on('error', reject);
      q.end(method === 'GET' ? undefined : '{}');
    });
    for (const [method, p] of [['PUT', `/api/app/projects/${w.project.key}/orchestrator`], ['DELETE', `/api/app/projects/${w.project.key}/orchestrator`], ['GET', '/api/app/projects']]) {
      assert.equal((await get(method, p)).status, 404, `${method} ${p}`);
    }
    const agents = await get('GET', '/api/agents?since=all');
    assert.equal(agents.status, 200);
    assert.doesNotMatch(agents.data, /"orchestrator"\s*:/, 'no orchestrator field in any group or agent');
    assert.doesNotMatch(agents.data, /orchestratorSessionId/);
  });
});

describe('orchestrator pick end to end: the real store, model and orchestrate modules over the synthetic machine', () => {
  const worlds = [];
  // a second synthetic machine whose folders are real paths: on macOS the temp dir is a symlink, a session's cwd is a real path
  // (the shell resolves it) and a registered project is stored as its realpath, so the two only match this way
  const real = (() => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = fs.realpathSync(os.tmpdir());
    try {
      return makeFixture();
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  })();
  after(() => {
    worlds.forEach((x) => x.cleanup());
    cleanup(real);
  });

  async function machine() {
    const world = await makeWorld();
    worlds.push(world);
    const project = await addProject(real.repo, world.env); // the fixture repo: its sessions are SID.idle (live, pane %6), SID.busy (live, a worktree), SID.ended, SID.dead and SID.old (20 days old)
    const tmuxExec = fakeTmux({ panes: [{ id: '%6', session: 'work', window: 2, windowName: 'main', command: 'claude' }] });
    const collectExec = fakeExec();
    const ctxOver = { exec: tmuxExec, findSession: (id) => findSession(id, { config: real.config, exec: collectExec, now: NOW }), findSessions: (ids) => findSessions(ids, { config: real.config, now: NOW }) };
    const a = await boot({ world, ctxOver, deps: makeDeps({ startOrchestrator, collect: async () => ({ groups: [] }) }) });
    return { world, project, tmuxExec, a, url: `/api/app/projects/${project.key}/orchestrator`, pick: () => getOrchestrator(project.key, world.env) };
  }

  test('(+) an ended session from before the time window is picked from the transcript index, shown as ended, and Start resumes it with claude --resume', async () => {
    const m = await machine();
    const put = await m.a.call('PUT', m.url, { json: { sessionId: SID.old } });
    assert.deepEqual([put.status, put.body.orchestrator.state, put.body.orchestrator.name], [200, 'ended', 'Ancient']);
    assert.equal(await m.pick(), SID.old);
    const list = (await m.a.call('GET', '/api/app/projects')).body.projects.find((p) => p.key === m.project.key);
    assert.deepEqual(list.orchestrator, { sessionId: SID.old, state: 'ended', name: 'Ancient', pane: null });
    const start = await m.a.call('POST', '/api/app/orchestrator/start', { json: { project: m.project.key } });
    assert.deepEqual([start.status, start.body.created, start.body.sessionId], [200, true, SID.old]);
    const run = m.tmuxExec.of('new-session')[0];
    assert.deepEqual(run.slice(run.indexOf('--')), ['--', CLAUDE, '--resume', SID.old, '--model', 'claude-fable-5-1', '-n', run[run.indexOf('-s') + 1]]);
    assert.equal(await m.pick(), SID.old, 'the pick is the same session');
  });

  test('(+) a live session of the project is picked, its pane tagged, and Start then answers that pane instead of starting a second orchestrator', async () => {
    const m = await machine();
    const put = await m.a.call('PUT', m.url, { json: { sessionId: SID.idle } });
    assert.deepEqual([put.status, put.body.orchestrator.state, put.body.orchestrator.pane], [200, 'live', '%6']);
    assert.deepEqual(m.tmuxExec.panes.find((p) => p.id === '%6').role, 'orchestrator');
    assert.equal(m.tmuxExec.panes.find((p) => p.id === '%6').depth, '1');
    const before = m.tmuxExec.calls.length;
    const start = await m.a.call('POST', '/api/app/orchestrator/start', { json: { project: m.project.key } });
    assert.deepEqual(start.body, { pane: '%6', session: 'work', sessionId: SID.idle, created: false });
    assert.equal(m.tmuxExec.calls.length, before, 'no tmux command');
  });

  test('(−) a session of a project that is not registered, a worktree-free plain folder, is other_project; an unknown id is 404', async () => {
    const m = await machine();
    assert.equal((await m.a.call('PUT', m.url, { json: { sessionId: SID.other } })).body.error, 'other_project');
    assert.equal((await m.a.call('PUT', m.url, { json: { sessionId: '99999999-9999-4999-8999-999999999999' } })).status, 404);
    assert.equal(await m.pick(), null);
    assert.deepEqual(m.tmuxExec.calls, []);
  });

  test('(−) a pick whose transcript is deleted is gone in the list, and Start forgets it, starts fresh and says cleared: gone', async () => {
    const m = await machine();
    await setOrchestrator(m.project.key, '88888888-8888-4888-8888-888888888888', m.world.env);
    const list = (await m.a.call('GET', '/api/app/projects')).body.projects.find((p) => p.key === m.project.key);
    assert.deepEqual(list.orchestrator, { sessionId: '88888888-8888-4888-8888-888888888888', state: 'gone', name: null, pane: null });
    const start = await m.a.call('POST', '/api/app/orchestrator/start', { json: { project: m.project.key } });
    assert.deepEqual([start.status, start.body.cleared, start.body.created], [200, 'gone', true]);
    assert.notEqual(await m.pick(), '88888888-8888-4888-8888-888888888888');
    assert.equal(await m.pick(), start.body.sessionId, 'the fresh session is the new pick');
  });
});

// 0.5, W12: after /compact the orchestrator's conversation continues as a background job in a child claude (kind "bg", a jobId, no tmux); the
// claude in the pane is its host (the old session id, parkedJobId = the jobId). The saved pick may be either id; the pane belongs to one row.
describe('a background session that continues the orchestrator\'s conversation after /compact (0.5, W12)', () => {
  const HOST = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  const CHILD = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
  const OTHER = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
  const JOB = 'c0ffee01';
  const worlds = [];
  const real = (() => { // a registered project is stored as its realpath, and so is a session's cwd: see the machine of the end-to-end tests above
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = fs.realpathSync(os.tmpdir());
    try {
      return makeFixture();
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  })();
  after(() => {
    worlds.forEach((x) => x.cleanup());
    cleanup(real);
  });

  /** acme-api with a host (pid 201, state idle, pane %9) and its background child (pid 202, busy); `tagged`: the pane carries nika's orchestrator tag. */
  async function machine({ tagged = true, child = true, other = false, onCollect = null } = {}) {
    const world = await makeWorld();
    worlds.push(world);
    const project = await addProject(real.repo, world.env);
    const sessions = path.join(real.claudeDir, 'sessions');
    for (const pid of [201, 202, 203]) fs.rmSync(path.join(sessions, `${pid}.json`), { force: true });
    const reg = (pid, o) => fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, cwd: real.repo, version: '2.1.319', procStart: PROC_START, startedAt: NOW - 3_600_000, updatedAt: NOW - 60_000, nameSource: 'user', name: 'acme-api', ...o }));
    reg(201, { sessionId: HOST, kind: 'interactive', status: 'idle', parkedJobId: JOB, tmux: 'work:@3.%9' });
    if (child) reg(202, { sessionId: CHILD, kind: 'bg', status: 'busy', jobId: JOB });
    if (other) reg(203, { sessionId: OTHER, kind: 'interactive', status: 'idle', name: 'demo-api', tmux: 'work:@4.%10' });
    const pids = [201, ...(child ? [202] : []), ...(other ? [203] : [])];
    const collectExec = fakeExec({
      psLines: pids.map((p) => `  ${p} ${PROC_START}`),
      tmuxLines: [`%9\twork\t3\tmain\tclaude\t${tagged ? 'orchestrator' : ''}`, '%10\twork\t4\tmain\tclaude\t'],
    });
    const tmuxExec = fakeTmux({ panes: [
      { id: '%9', session: 'work', window: 3, windowName: 'main', command: 'claude', ...(tagged ? { role: 'orchestrator', agent: `${project.key}/orchestrator`, depth: '1' } : {}) },
      { id: '%10', session: 'work', window: 4, windowName: 'main', command: 'claude' },
    ] });
    const config = real.config;
    const batches = [];
    const control = fakeControl();
    const ctxOver = {
      exec: tmuxExec,
      findSession: (id) => findSession(id, { config, exec: collectExec, now: NOW }),
      findSessions: (ids) => { batches.push([...ids]); return findSessions(ids, { config, now: NOW }); },
    };
    const deps = makeDeps({
      startOrchestrator,
      collect: async () => {
        const snapshot = (await collect({ config, exec: collectExec, now: NOW, sinceMs: 7 * 86_400_000 })).snapshot;
        await onCollect?.(project, world.env); // a change to the saved pick while the poll is still running
        return snapshot;
      },
      createSessionControl: control.factory,
    });
    const a = await boot({ world, ctxOver, deps });
    deps.state.panes.set('%9', { command: 'claude' });
    deps.state.panes.set('%10', { command: 'claude' });
    const listed = async () => (await a.call('GET', '/api/app/projects')).body.projects.find((p) => p.key === project.key).orchestrator;
    // every save of config.json is a rename onto a new file: a changed stamp is a write
    const file = path.join(configDir(world.env), 'config.json');
    const stamp = () => { const st = fs.statSync(file); return `${st.ino}:${st.mtimeMs}:${st.size}`; };
    return { world, project, tmuxExec, a, batches, control, listed, stamp, file, url: `/api/app/projects/${project.key}/orchestrator`, pick: () => getOrchestrator(project.key, world.env) };
  }

  test('(+) Start with the host\'s id as the saved pick (before the pick has moved) answers that pane, created: false, and starts nothing', async () => {
    const m = await machine();
    await setOrchestrator(m.project.key, HOST, m.world.env);
    const before = m.tmuxExec.calls.length;
    const stamp = m.stamp();
    const start = await m.a.call('POST', '/api/app/orchestrator/start', { json: { project: m.project.key } });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body, { pane: '%9', session: 'work', sessionId: HOST, created: false });
    assert.equal(m.tmuxExec.calls.length, before, 'no tmux command: nothing started, no window opened');
    assert.equal(m.tmuxExec.of('new-window').length + m.tmuxExec.of('new-session').length, 0);
    assert.equal(m.a.ctx.started.size, 0);
    assert.equal(await m.pick(), HOST, 'Start does not move the pick; only the project list does');
    assert.equal(m.stamp(), stamp, 'no write');
  });

  test('(+) the project list reads the host\'s pick live with the pane, answers with the child\'s id and saves the child\'s id once; a second poll writes nothing', async () => {
    const m = await machine();
    await setOrchestrator(m.project.key, HOST, m.world.env);
    const before = m.stamp();
    assert.deepEqual(await m.listed(), { sessionId: CHILD, state: 'live', name: 'acme-api', pane: '%9' });
    assert.deepEqual(m.batches, [], 'the snapshot holds it: no transcript-index walk');
    assert.equal(await m.pick(), CHILD, 'the saved pick is now the child\'s id');
    const moved = m.stamp();
    assert.notEqual(moved, before, 'one write');
    assert.deepEqual(await m.listed(), { sessionId: CHILD, state: 'live', name: 'acme-api', pane: '%9' });
    assert.equal(m.stamp(), moved, 'the second poll writes nothing');
    const start = await m.a.call('POST', '/api/app/orchestrator/start', { json: { project: m.project.key } });
    assert.deepEqual(start.body, { pane: '%9', session: 'work', sessionId: CHILD, created: false });
    assert.equal(m.tmuxExec.of('new-window').length + m.tmuxExec.of('new-session').length, 0);
    assert.equal(m.stamp(), moved, 'Start writes nothing either');
  });

  test('(−) no move when the saved pick already is the child\'s id: the answer is the same and nothing is written', async () => {
    const m = await machine();
    await setOrchestrator(m.project.key, CHILD, m.world.env);
    const before = m.stamp();
    assert.deepEqual(await m.listed(), { sessionId: CHILD, state: 'live', name: 'acme-api', pane: '%9' });
    assert.equal(m.stamp(), before);
    assert.equal(await m.pick(), CHILD);
    const start = await m.a.call('POST', '/api/app/orchestrator/start', { json: { project: m.project.key } });
    assert.deepEqual(start.body, { pane: '%9', session: 'work', sessionId: CHILD, created: false });
  });

  test('(−) no move without a link (the host is an ordinary row), and none for a pick that no session answers to', async () => {
    const m = await machine({ child: false });
    await setOrchestrator(m.project.key, HOST, m.world.env);
    const before = m.stamp();
    assert.deepEqual(await m.listed(), { sessionId: HOST, state: 'live', name: 'acme-api', pane: '%9' });
    assert.equal(m.stamp(), before);
    assert.equal(await m.pick(), HOST);
    await setOrchestrator(m.project.key, OTHER, m.world.env); // no such session anywhere
    const other = m.stamp();
    assert.deepEqual(await m.listed(), { sessionId: OTHER, state: 'gone', name: null, pane: null });
    assert.equal(m.stamp(), other, 'a gone pick is not touched by the list');
    assert.equal(await m.pick(), OTHER);
  });

  test('(−) no move for another project: the host\'s row belongs to acme-api, so a pick of it in a second project reads gone and stays as it is', async () => {
    const m = await machine();
    const second = await addProject(real.plain, m.world.env);
    await setOrchestrator(second.key, HOST, m.world.env);
    const before = m.stamp();
    const projects = (await m.a.call('GET', '/api/app/projects')).body.projects;
    assert.deepEqual(projects.find((p) => p.key === second.key).orchestrator, { sessionId: HOST, state: 'gone', name: null, pane: null });
    assert.equal(m.stamp(), before, 'nothing written');
    assert.equal(await getOrchestrator(second.key, m.world.env), HOST);
  });

  test('(−) no move when the saved pick changed while the poll ran: the newer save wins', async () => {
    const m = await machine({ onCollect: (project, env) => setOrchestrator(project.key, OTHER, env) });
    await setOrchestrator(m.project.key, HOST, m.world.env);
    assert.deepEqual(await m.listed(), { sessionId: CHILD, state: 'live', name: 'acme-api', pane: '%9' }, 'this poll answers from the pick it read');
    assert.equal(await m.pick(), OTHER, 'the pick saved meanwhile was not overwritten');
  });

  test('(−) a failed save changes nothing and shows nothing: the answer still reads live with the child\'s id, and the next poll moves the pick', { skip: process.getuid?.() === 0 && 'root ignores a read-only folder' }, async () => {
    const m = await machine();
    await setOrchestrator(m.project.key, HOST, m.world.env);
    const before = m.stamp();
    fs.chmodSync(path.dirname(m.file), 0o500); // readable, so the config still loads; the save cannot create its temp file
    let failed;
    try {
      failed = await m.a.call('GET', '/api/app/projects');
    } finally {
      fs.chmodSync(path.dirname(m.file), 0o700);
    }
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.body.projects.find((p) => p.key === m.project.key).orchestrator, { sessionId: CHILD, state: 'live', name: 'acme-api', pane: '%9' });
    assert.equal(m.stamp(), before, 'the write failed');
    assert.equal(await m.pick(), HOST);
    assert.deepEqual(await m.listed(), { sessionId: CHILD, state: 'live', name: 'acme-api', pane: '%9' });
    assert.equal(await m.pick(), CHILD);
  });

  test('(+) PUT with the child\'s id while the pick is the host\'s id moves the pick (200), not "another session is running"', async () => {
    const m = await machine();
    await setOrchestrator(m.project.key, HOST, m.world.env);
    const put = await m.a.call('PUT', m.url, { json: { sessionId: CHILD } });
    assert.deepEqual([put.status, put.body.orchestrator?.sessionId, put.body.orchestrator?.state, put.body.orchestrator?.pane], [200, CHILD, 'live', '%9']);
    assert.equal(await m.pick(), CHILD);
  });

  test('(−) PUT with the child\'s id is still refused while another session is the running orchestrator (409), and nothing changes', async () => {
    const m = await machine({ other: true });
    await setOrchestrator(m.project.key, OTHER, m.world.env);
    const put = await m.a.call('PUT', m.url, { json: { sessionId: CHILD } });
    assert.deepEqual([put.status, put.body.error], [409, 'orchestrator_running']);
    assert.equal(await m.pick(), OTHER);
  });

  test('(+) pane eligibility: only the child claims the pane, so the pane is eligible once and its registry state is the child\'s busy, not the host\'s idle', async () => {
    const m = await machine();
    assert.equal(await m.control.opts.stateOf('%9', { fresh: true }), 'busy');
    assert.equal(await m.control.opts.stateOf('%10'), null, 'a pane no live session claims has no state');
    assert.equal((await m.a.call('GET', '/api/app/pane/%259/capture')).status, 200, 'eligible: in tmux\'s list, running claude, claimed by one live session');
    const snapshot = (await m.a.deps.collect());
    const claims = snapshot.groups.flatMap((g) => g.agents).filter((x) => x.live && x.pane?.id === '%9');
    assert.deepEqual(claims.map((x) => x.id), [CHILD], 'exactly one row claims the pane (two claims would make the state null)');
  });

  test('(−) without the child the host is an ordinary row: the pick reads live with the pane and its own state', async () => {
    const m = await machine({ child: false });
    await setOrchestrator(m.project.key, HOST, m.world.env);
    assert.deepEqual(await m.listed(), { sessionId: HOST, state: 'live', name: 'acme-api', pane: '%9' });
    assert.equal(await m.control.opts.stateOf('%9', { fresh: true }), 'idle');
  });

  test('(+) PUT orchestrator with the host\'s id re-adopts the running orchestrator (200), not "another session is running"', async () => {
    const m = await machine();
    await setOrchestrator(m.project.key, HOST, m.world.env);
    const put = await m.a.call('PUT', m.url, { json: { sessionId: HOST } });
    assert.deepEqual([put.status, put.body.orchestrator?.state, put.body.orchestrator?.pane], [200, 'live', '%9']);
    assert.equal(await m.pick(), HOST);
  });

  test('(−) with the host as the saved pick and its pane untagged, another live session is still refused (409 orchestrator_running); with no pick it is not', async () => {
    const m = await machine({ tagged: false, other: true });
    await setOrchestrator(m.project.key, HOST, m.world.env);
    const refused = await m.a.call('PUT', m.url, { json: { sessionId: OTHER } });
    assert.deepEqual([refused.status, refused.body.error], [409, 'orchestrator_running']);
    assert.equal(await m.pick(), HOST, 'nothing changed');
    assert.deepEqual(m.tmuxExec.of('set-option'), []);
    await setOrchestrator(m.project.key, null, m.world.env);
    const taken = await m.a.call('PUT', m.url, { json: { sessionId: OTHER } });
    assert.deepEqual([taken.status, taken.body.orchestrator?.pane], [200, '%10'], 'no pick: the child\'s untagged pane is no running orchestrator');
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
      return { status: 200, body: { cols: screens[pane]?.cols ?? 80, rows: screens[pane] ?? [], cursor: Object.hasOwn(screens[pane] ?? [], 'cursor') ? screens[pane].cursor : { x: 0, y: 0, visible: true }, etag: 'abc' }, etag: 'abc' }; // an array may carry its own `cursor` (a box fixture's, null included)
    },
  };
  return m;
}

/** A session-control factory that records what the router builds it with and what the routes call. `answers` overrides a method's result. */
function fakeControl(answers = {}) {
  const f = { calls: [], opts: null };
  const method = (name, fallback) => async (...args) => {
    f.calls.push([name, ...args]);
    return typeof answers[name] === 'function' ? answers[name](...args) : answers[name] ?? fallback(...args);
  };
  f.factory = (opts) => {
    f.opts = opts;
    return {
      switchMode: method('switchMode', (pane, target) => ({ status: 200, body: { mode: target, presses: 1 } })),
      endSession: method('endSession', () => ({ status: 200, body: { ended: true } })),
      runCommand: method('runCommand', () => ({ status: 200, body: { sent: true } })),
      answer: method('answer', (pane, b) => ({ status: 200, body: { answered: b.n } })),
      stop: method('stop', () => ({ status: 200, body: { stopped: true, presses: 1 } })),
      writeDraft: method('writeDraft', () => ({ status: 200, body: { draft: null, typed: 0 } })),
      submit: method('submit', () => ({ status: 200, body: { taken: true, draft: null } })),
      acceptSuggestion: method('acceptSuggestion', () => ({ status: 200, body: { draft: null } })),
      answerDialog: method('answerDialog', () => ({ status: 200, body: { done: 'next', sent: 1 } })),
      withPaneLock: async (id, fn) => fn(), // the lock and the interrupt gap the scroll controller is built with (src/scroll.js insists on both)
      keyGap: () => false,
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

  // 0.5: the plugins applied to the project (its saved list in nika's own config) decide the order of the answer
  const saveList = (a, plugins, key = w.project.key) => a.call('PUT', `/api/app/projects/${key}/config`, { json: { plugins } });

  test('(+) with a project key the plugins applied to it (its saved list, in nika\'s own config) are passed as `applied`', async () => {
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    try {
      assert.equal((await saveList(a, ['beta@market', 'alpha@market'])).status, 200);
      assert.equal((await a.call('GET', `/api/app/commands?project=${w.project.key}`)).status, 200);
      assert.deepEqual(f.calls[0].applied, ['beta@market', 'alpha@market']);
    } finally {
      await saveList(a, []);
    }
  });

  test('(+) without a project key, and for a project with no saved list, `applied` is empty', async () => {
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    await a.call('GET', '/api/app/commands');
    await a.call('GET', `/api/app/commands?project=${w.project.key}`);
    assert.deepEqual(f.calls.map((c) => c.applied), [[], []]);
  });

  test('(−) the list saved for one project never reaches another project\'s answer', async () => {
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-api-cmds-proj-'));
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    try {
      const other = await addProject(extra, w.env);
      assert.equal((await saveList(a, ['alpha@market'])).status, 200); // saved for w.project only
      await a.call('GET', `/api/app/commands?project=${other.key}`);
      await a.call('GET', '/api/app/commands');
      await a.call('GET', `/api/app/commands?project=${w.project.key}`);
      assert.deepEqual(f.calls.map((c) => c.applied), [[], [], ['alpha@market']]);
      await a.call('DELETE', `/api/app/projects/${other.key}`);
    } finally {
      await saveList(a, []);
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  test('(−) a plugin list in the request is ignored: `applied` comes only from the saved config', async () => {
    const f = withList();
    const a = await boot({ deps: makeDeps(f.deps) });
    const q = `project=${w.project.key}&applied=alpha%40market&plugins=beta%40market&plugin=beta%40market`;
    assert.equal((await a.call('GET', `/api/app/commands?${q}`)).status, 200);
    assert.deepEqual(f.calls[0].applied, []);
    assert.equal((await a.call('GET', '/api/app/commands?applied=alpha%40market')).status, 200);
    assert.deepEqual(f.calls[1].applied, []);
  });

  test('(+) end to end with the real collector: the saved list decides which plugin\'s commands come before the built-ins, at once', async () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-api-cmds-claude-'));
    const md = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '---\ndescription: d\n---\n'); };
    const install = (name) => {
      const dir = path.join(claudeDir, 'plugins', 'cache', 'market', name, '1.0.0');
      md(path.join(dir, 'commands', 'run.md'));
      return dir;
    };
    md(path.join(claudeDir, 'commands', 'mine.md'));
    const record = (name) => [{ scope: 'user', installPath: install(name), version: '1.0.0' }];
    fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'alpha@market': record('alpha'), 'beta@market': record('beta') } }));
    const a = await boot({ deps: makeDeps({ listCommands: realListCommands }), ctxOver: { claudeDir } });
    const url = `/api/app/commands?project=${w.project.key}`;
    const head = async () => {
      const list = (await a.call('GET', url)).body.commands;
      const firstBuiltin = list.findIndex((c) => c.source === 'builtin');
      return { before: list.slice(0, firstBuiltin).map((c) => c.name), after: list.slice(firstBuiltin).filter((c) => c.source !== 'builtin').map((c) => c.name) };
    };
    try {
      assert.deepEqual(await head(), { before: ['mine'], after: ['alpha:run', 'beta:run'] }, 'no list: plugins stay after the built-ins');
      assert.equal((await saveList(a, ['beta@market'])).status, 200);
      assert.deepEqual(await head(), { before: ['mine', 'beta:run'], after: ['alpha:run'] }, 'the new list shows at once, though the scan is cached');
      assert.equal((await saveList(a, [])).status, 200);
      assert.deepEqual(await head(), { before: ['mine'], after: ['alpha:run', 'beta:run'] });
    } finally {
      await saveList(a, []);
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
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

// --- 0.5 draft sync (design W5): the capture's `draft` and `PUT /api/app/pane/:id/draft` ---

describe('capture: draft', () => {
  /** The rows of a box fixture; they carry the fixture's cursor (the capture reads the draft with it, N-1: the cursor must be in the box). */
  const box = (lines, o = {}) => {
    const s = boxRows({ cols: 80, lines, ...o });
    return Object.assign(s.rows, { cursor: s.cursor });
  };

  test('(+) a plain box: state, mode, text, sig, box rows, cursorAtEnd, suggestion and edit (unknown until something shows the mode)', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = box(['hello', 'second line']);
    const r = await pane(a, '%6', 'capture');
    assert.equal(r.status, 200);
    const d = r.body.draft;
    assert.deepEqual([d.state, d.mode, d.text, d.edit, d.suggestion], ['text', 'prompt', 'hello\nsecond line', 'unknown', null]);
    assert.match(d.sig, /^[0-9a-f]{16}$/);
    assert.deepEqual(Object.keys(d).sort(), ['box', 'cursorAtEnd', 'edit', 'ghost', 'mode', 'queued', 'sig', 'state', 'suggestion', 'text']);
    assert.equal(d.ghost, false, 'no ghost cell was dropped');
    assert.deepEqual(d.box, { top: 0, bottom: 3 });
    assert.equal(r.body.mode, 'auto', 'the mode and the prompt fields are as before');
  });

  test('(+) an empty box, a `!` box, and an unreadable one (the placeholder: state and reason, no sig)', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = box([''], { ghost: 'run the tests' });
    const empty = (await pane(a, '%6', 'capture')).body.draft;
    assert.deepEqual([empty.state, empty.text, empty.suggestion, empty.ghost], ['empty', '', 'run the tests', true]);
    screens['%6'] = box(['ls -la'], { mode: 'bash' });
    const bash = (await pane(a, '%6', 'capture')).body.draft;
    assert.deepEqual([bash.state, bash.mode, bash.text], ['text', 'bash', 'ls -la']);
    screens['%6'] = box(['[Pasted text #1 +3 lines]']);
    const pasted = (await pane(a, '%6', 'capture')).body.draft;
    assert.deepEqual([pasted.state, pasted.reason, pasted.sig, pasted.text], ['unreadable', 'pasted', null, '']);
  });

  test('(−) null when the screen has no plain box: a permission prompt, no rule rows, a footer nobody recognises', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(PROMPT);
    const prompt = await pane(a, '%6', 'capture');
    assert.ok(prompt.body.prompt, 'the prompt is still reported');
    assert.equal(prompt.body.draft, null);
    screens['%6'] = rowsOf(['just text', FOOTER.plan]);
    assert.equal((await pane(a, '%6', 'capture')).body.draft, null);
    screens['%6'] = boxRows({ cols: 80, lines: ['hello'], footer: 'some footer nobody recognises' }).rows;
    assert.equal((await pane(a, '%6', 'capture')).body.draft, null);
    screens['%6'] = [];
    assert.equal((await pane(a, '%6', 'capture')).body.draft, null);
  });

  test('(−) N-1: a status line drawn under Claude\'s lower rule (glyph + no-break space, or glyph + padding only) with the cursor in the real box above: draft null', async () => {
    const { a, screens } = await bootScreens();
    const NB = '\u00a0';
    const dashes = () => [{ t: '\u2500'.repeat(80), s: { fg: 244 } }];
    for (const row of [[{ t: `\u276f${NB}main`, s: {} }], [{ t: '\u276f', s: {} }, { t: ' '.repeat(79), s: {} }]]) {
      const real = box(['hello']);
      const rows = Object.assign(real.slice(), { cursor: real.cursor });
      rows.splice(3, 0, row, dashes()); // the status row 3 and its rule 4 under Claude's lower rule (row 2)
      screens['%6'] = rows;
      const r = await pane(a, '%6', 'capture');
      assert.equal(r.status, 200);
      assert.equal(r.body.draft, null, 'the cursor is in the real box above these rules: nothing of the status line goes to the page');
    }
  });

  test('(−) N-1 ruling: a capture without a cursor has no box: draft null, the real box included (the pure parser alone reads such rows)', async () => {
    const { a, screens } = await bootScreens();
    for (const cursor of [null, undefined, {}, { x: 2 }, { y: 1 }, { x: 'a', y: 1 }]) {
      screens['%6'] = Object.assign(box(['hello']).slice(), { cursor });
      const r = await pane(a, '%6', 'capture');
      assert.equal(r.status, 200, JSON.stringify(cursor));
      assert.equal(r.body.draft, null, JSON.stringify(cursor));
    }
    screens['%6'] = box(['hello']);
    assert.equal((await pane(a, '%6', 'capture')).body.draft.text, 'hello', 'the control: with its cursor the same box reads');
  });

  test('(−) N-1: the cursor on a rule row, or past the box, is no draft either', async () => {
    const { a, screens } = await bootScreens();
    for (const y of [0, 2, 5]) {
      screens['%6'] = Object.assign(box(['hello']).slice(), { cursor: { x: 2, y, visible: true } });
      assert.equal((await pane(a, '%6', 'capture')).body.draft, null, `y ${y}`);
    }
  });

  test('(+) D1: captures that alternate no pointer / pointer on main / no pointer / pointer on an agent row keep the mode, modeConfirmed and the draft', async () => {
    const { a, screens } = await bootScreens();
    const s = boxRows({ cols: 80, lines: ['ghj'] });
    const seen = [];
    for (const pointer of [null, 'main', null, 1]) {
      screens['%6'] = Object.assign([...s.rows, ...subagentRows({ cols: 80, agents: 3, pointer })], { cursor: s.cursor });
      const r = await pane(a, '%6', 'capture');
      seen.push({ mode: r.body.mode, modeConfirmed: r.body.modeConfirmed, draft: r.body.draft });
    }
    assert.deepEqual([seen[0].mode, seen[0].modeConfirmed, seen[0].draft?.text], ['auto', true, 'ghj']);
    for (const [i, one] of seen.entries()) assert.deepEqual(one, seen[0], `capture ${i + 1}`);
  });

  test('(+) edit follows the pane\'s memory: insert while INSERT shows (and it forgets plain), normal after INSERT was seen, plain after a probe landed as text, unknown after none', async () => {
    const { a, screens, control } = await bootScreens();
    screens['%6'] = box(['hello']);
    assert.equal((await pane(a, '%6', 'capture')).body.draft.edit, 'unknown');
    control.opts.setEdit('%6', 'plain');
    assert.equal(control.opts.plainOf('%6'), true);
    assert.equal((await pane(a, '%6', 'capture')).body.draft.edit, 'plain');
    screens['%6'] = box(['hello'], { insert: true });
    assert.equal((await pane(a, '%6', 'capture')).body.draft.edit, 'insert');
    assert.equal(control.opts.plainOf('%6'), false, 'INSERT seen: not plain');
    assert.equal(control.opts.vimOf('%6'), true);
    screens['%6'] = box(['hello']);
    assert.equal((await pane(a, '%6', 'capture')).body.draft.edit, 'normal', 'INSERT was seen before, now none shows');
    control.opts.setEdit('%6', 'plain');
    assert.deepEqual([control.opts.vimOf('%6'), control.opts.plainOf('%6')], [false, true], 'a probe that lands as text turns vim off');
    control.opts.setEdit('%6', 'vim');
    assert.deepEqual([control.opts.vimOf('%6'), control.opts.plainOf('%6')], [true, false]);
    control.opts.setEdit('%6', 'none');
    assert.deepEqual([control.opts.vimOf('%6'), control.opts.plainOf('%6')], [false, false]);
    assert.equal((await pane(a, '%6', 'capture')).body.draft.edit, 'unknown');
  });

  test('(+) edit is part of the ETag: the same screen after the memory changed is not a 304', async () => {
    const { a, screens, control } = await bootScreens();
    screens['%6'] = box(['hello']);
    const first = await pane(a, '%6', 'capture');
    const again = await pane(a, '%6', 'capture', { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(again.status, 304);
    control.opts.setEdit('%6', 'plain');
    const changed = await pane(a, '%6', 'capture', { headers: { 'if-none-match': first.headers.etag } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.draft.edit, 'plain');
  });

  test('(−) the plain memory is dropped when the pane leaves the eligible set (a reused pane id starts unknown)', async () => {
    const { a, screens, control } = await bootScreens();
    screens['%6'] = box(['hello']);
    await pane(a, '%6', 'capture');
    control.opts.setEdit('%6', 'plain');
    await leaveAndReturn(a, '%6');
    assert.equal(control.opts.plainOf('%6'), false);
    assert.equal((await pane(a, '%6', 'capture')).body.draft.edit, 'unknown');
  });

  test('(−) the draft is on the app tier\'s capture only: the browser tier has no capture route and its agent list carries no draft', async () => {
    const server = createServer({ config: fx.config, exec: fakeExec(), token: 'tok', now: () => NOW, version: '0.0.0' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    servers.push(server);
    const port = server.address().port;
    const call = (method, p) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'content-length': '2' }) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      q.on('error', reject);
      q.end(method === 'GET' ? undefined : '{}');
    });
    assert.equal((await call('GET', '/api/app/pane/%256/capture')).status, 404);
    assert.equal((await call('PUT', '/api/app/pane/%256/draft')).status, 404);
    assert.equal((await call('POST', '/api/app/pane/%256/suggestion')).status, 404, 'accepting a suggestion presses a key: app tier only');
    assert.equal((await call('POST', '/api/app/pane/%256/submit')).status, 404, 'Send\'s Enter presses a key: app tier only');
    const agents = await call('GET', '/api/agents?since=all');
    assert.equal(agents.status, 200);
    assert.doesNotMatch(agents.data, /"draft"|"edit"|"cursorAtEnd"/);
  });
});

describe('PUT /api/app/pane/:id/draft', () => {
  const body = { text: 'hello world', base: '0123456789abcdef' };

  test('(+) hands the pane and exactly { text, base } to the controller and relays its answer and status', async () => {
    const { a, control } = await bootScreens({ ctlAnswers: { writeDraft: { status: 200, body: { draft: { sig: 'x' }, typed: 6 } } } });
    const r = await pane(a, '%6', 'draft', { method: 'PUT', json: body });
    assert.deepEqual([r.status, r.body], [200, { draft: { sig: 'x' }, typed: 6 }]);
    assert.deepEqual(control.calls, [['writeDraft', '%6', body]]);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('(+) a started pane is eligible; the controller\'s 409 bodies, draft included, are relayed as they are', async () => {
    const answer = { status: 409, body: { error: 'draft-changed', draft: { state: 'text', text: 'on screen', sig: '0123456789abcdef' } } };
    const { a, control } = await bootScreens({ ctlAnswers: { writeDraft: answer } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    const r = await pane(a, '%8', 'draft', { method: 'PUT', json: { text: 'x', base: '' } });
    assert.deepEqual([r.status, r.body], [409, answer.body]);
    assert.deepEqual(control.calls, [['writeDraft', '%8', { text: 'x', base: '' }]]);
  });

  test('(−) a bad body is 400 before the pane check, and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    const bad = [{}, { text: 'a' }, { text: 'a', base: 'XYZ' }, { text: 5, base: '' }, { text: 'x'.repeat(1025), base: '' }, { text: '\n'.repeat(13), base: '' }, { text: 'a\u0000', base: '' }, { text: 'a\u001b[2m', base: '' }, { text: 'a', base: '', path: '/etc/passwd' }];
    for (const json of bad) {
      for (const id of ['%6', '%5']) {
        const r = await pane(a, id, 'draft', { method: 'PUT', json });
        assert.equal(r.status, 400, `${JSON.stringify(json).slice(0, 50)} on ${id}`);
        assert.equal(r.body.error, 'invalid');
      }
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) an ineligible pane (zsh, not live, unknown id, bad id) is 404 and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    for (const id of ['%5', '%7', '%99', 'abc', '..']) {
      const r = await a.call('PUT', `/api/app/pane/${id.replace('%', '%25')}/draft`, { json: body });
      assert.equal(r.status, 404, id);
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) without the secret 403; text/plain 415; GET and POST 405; a body over 20 KB 413 -- the controller is not called', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'draft', { method: 'PUT', json: body, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'draft', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'draft', { method: 'GET' })).status, 405);
    assert.equal((await pane(a, '%6', 'draft', { method: 'POST', json: body })).status, 405);
    assert.equal((await pane(a, '%6', 'draft', { method: 'PUT', json: { text: 'x', base: '', pad: 'p'.repeat(21 * 1024) } })).status, 413);
    assert.deepEqual(control.calls, []);
  });

  test('(−) a write while End runs on the same pane is 409 busy-switching (one lock for every control), and the write sends nothing', async () => {
    const { a, screens, mirror } = await bootScreens({ fake: false });
    screens['%6'] = boxRows({ cols: 80, lines: [''] }).rows;
    let enter;
    const entered = new Promise((r) => { enter = r; });
    let release;
    const hold = new Promise((r) => { release = r; });
    const capture = mirror.capture;
    mirror.capture = async (...args) => { enter(); await hold; return capture(...args); };
    const end = pane(a, '%6', 'end', { method: 'POST', json: {} });
    await entered;
    const put = await pane(a, '%6', 'draft', { method: 'PUT', json: { text: 'hi', base: '' } });
    assert.deepEqual([put.status, put.body.error], [409, 'busy-switching']);
    release();
    await end;
    assert.ok(!a.deps.calls.some((c) => c[0] === 'keys' && c[2]?.text === 'hi'), 'nothing of the write was typed');
  });

  test('(+) end to end with the real controller: an append reaches keys.send as one -l call, and the answer carries the read draft', async () => {
    const { a, mirror } = await bootScreens({ fake: false });
    const lines = ['hello'];
    let shots = 0;
    mirror.capture = async () => { // the cursor sits at the end of the text, as Claude's does
      shots += 1;
      return { status: 200, body: { ...boxRows({ cols: 80, lines, insert: true }), etag: `e${shots}` }, etag: `e${shots}` };
    };
    // keys.send (the fake dep) changes the screen the way Claude would
    a.deps.keys.send = async (id, b) => {
      a.deps.calls.push(['keys', id, b]);
      lines[0] += b.text;
      return { status: 200, body: { sent: { text: 1, paste: 0, keys: 0 } } };
    };
    const first = (await pane(a, '%6', 'capture')).body.draft;
    const r = await pane(a, '%6', 'draft', { method: 'PUT', json: { text: 'hello!!', base: first.sig } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.typed, r.body.draft.text, r.body.draft.edit], [2, 'hello!!', 'insert']);
    assert.deepEqual(a.deps.calls.filter((c) => c[0] === 'keys').map((c) => c[2]), [{ text: '!!' }]);
  });

  test('(−) nothing of the draft, its sig or the base reaches a log line, on success and on an internal error', async () => {
    const secret = 'zq-private-draft-words';
    const lines = [];
    const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    for (const name of Object.keys(saved)) console[name] = (...args) => { lines.push(args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
    try {
      for (const ctlAnswers of [undefined, { writeDraft: () => { throw new Error('boom'); } }]) {
        const { a } = await bootScreens({ ctlAnswers });
        await pane(a, '%6', 'draft', { method: 'PUT', json: { text: secret, base: 'abcdef0123456789' } });
      }
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(lines.some((l) => /PUT .*draft failed/.test(l)), 'the internal error was logged (so the check is real)');
    assert.deepEqual(lines.filter((l) => l.includes(secret) || l.includes('abcdef0123456789')), []);
  });
});

describe('POST /api/app/pane/:id/suggestion', () => {
  const body = { text: 'run the tests in acme-api' };

  test('(+) hands the pane and exactly { text } to the controller and relays its answer and status', async () => {
    const { a, control } = await bootScreens({ ctlAnswers: { acceptSuggestion: { status: 200, body: { draft: { sig: 'x', text: 'run the tests in acme-api' } } } } });
    const r = await pane(a, '%6', 'suggestion', { method: 'POST', json: body });
    assert.deepEqual([r.status, r.body], [200, { draft: { sig: 'x', text: 'run the tests in acme-api' } }]);
    assert.deepEqual(control.calls, [['acceptSuggestion', '%6', body]]);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('(+) a started pane is eligible; every 409 the controller gives (with its draft) is relayed as it is', async () => {
    const answers = [
      { status: 409, body: { error: 'draft-changed', draft: { state: 'empty', suggestion: 'another one' } } },
      { status: 409, body: { error: 'not-idle', draft: null } },
      { status: 409, body: { error: 'draft-mismatch', draft: { state: 'empty' } } },
      { status: 409, body: { error: 'busy-switching' } },
      { status: 429, body: { error: 'busy', draft: { state: 'empty' } } },
    ];
    for (const answer of answers) {
      const { a, control } = await bootScreens({ ctlAnswers: { acceptSuggestion: answer } });
      a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
      const r = await pane(a, '%8', 'suggestion', { method: 'POST', json: body });
      assert.deepEqual([r.status, r.body], [answer.status, answer.body]);
      assert.deepEqual(control.calls, [['acceptSuggestion', '%8', body]]);
    }
  });

  test('(−) a bad body is 400 before the pane check, and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    const bad = [{}, { text: '' }, { text: 5 }, { text: 'x'.repeat(201) }, { text: 'a\nb' }, { text: 'a\u0000' }, { text: 'a\u001b[2m' }, { text: 'a', base: '' }, { text: 'a', path: '/etc/passwd' }, [], 'text'];
    for (const json of bad) {
      for (const id of ['%6', '%5']) {
        const r = await pane(a, id, 'suggestion', { method: 'POST', json });
        assert.equal(r.status, 400, `${JSON.stringify(json).slice(0, 50)} on ${id}`);
        assert.equal(r.body.error, 'invalid');
      }
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) an ineligible pane (zsh, not live, unknown id, bad id) is 404 and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    for (const id of ['%5', '%7', '%99', 'abc', '..']) {
      const r = await a.call('POST', `/api/app/pane/${id.replace('%', '%25')}/suggestion`, { json: body });
      assert.equal(r.status, 404, id);
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) without the secret 403; text/plain 415; GET and PUT 405; a body over 4 KB 413 -- the controller is not called', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'suggestion', { method: 'POST', json: body, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'suggestion', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'suggestion', { method: 'GET' })).status, 405);
    assert.equal((await pane(a, '%6', 'suggestion', { method: 'PUT', json: body })).status, 405);
    assert.equal((await pane(a, '%6', 'suggestion', { method: 'POST', json: { text: 'x', pad: 'p'.repeat(5 * 1024) } })).status, 413);
    assert.deepEqual(control.calls, []);
  });

  test('(−) a foreign Origin or Sec-Fetch-Site is 403 before any pane work', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'suggestion', { method: 'POST', json: body, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await pane(a, '%6', 'suggestion', { method: 'POST', json: body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.deepEqual(control.calls, []);
  });

  test('(−) an accept while End runs on the same pane is 409 busy-switching (one lock), and the Tab is not sent', async () => {
    const { a, screens, mirror } = await bootScreens({ fake: false });
    screens['%6'] = boxRows({ cols: 80, lines: [''], ghost: 'run the tests in acme-api' }).rows;
    let enter;
    const entered = new Promise((r) => { enter = r; });
    let release;
    const hold = new Promise((r) => { release = r; });
    const capture = mirror.capture;
    mirror.capture = async (...args) => { enter(); await hold; return capture(...args); };
    const end = pane(a, '%6', 'end', { method: 'POST', json: {} });
    await entered;
    const put = await pane(a, '%6', 'suggestion', { method: 'POST', json: body });
    assert.deepEqual([put.status, put.body.error], [409, 'busy-switching']);
    release();
    await end;
    assert.ok(!a.deps.calls.some((c) => c[0] === 'keys' && c[2]?.keys?.includes('Tab')), 'no Tab went out');
  });

  test('(+) end to end with the real controller: one Tab reaches keys.send, and the answer carries the draft the box now reads', async () => {
    const { a, mirror } = await bootScreens({ fake: false });
    const state = { text: '' };
    let shots = 0;
    mirror.capture = async () => {
      shots += 1;
      return { status: 200, body: { ...boxRows({ cols: 80, lines: [state.text], ghost: state.text === '' ? 'run the tests in acme-api' : null, insert: true }), etag: `e${shots}` }, etag: `e${shots}` };
    };
    a.deps.keys.send = async (id, b) => { // Claude takes the suggestion on Tab
      a.deps.calls.push(['keys', id, b]);
      if (b.keys?.includes('Tab')) state.text = 'run the tests in acme-api';
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 1 } } };
    };
    const r = await pane(a, '%6', 'suggestion', { method: 'POST', json: body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.draft.state, r.body.draft.text, r.body.draft.suggestion, r.body.draft.edit], ['text', 'run the tests in acme-api', null, 'insert']);
    assert.deepEqual(a.deps.calls.filter((c) => c[0] === 'keys').map((c) => c[2]), [{ keys: ['Tab'] }]);
    const stale = await pane(a, '%6', 'suggestion', { method: 'POST', json: { text: 'a suggestion that is gone' } });
    assert.deepEqual([stale.status, stale.body.error], [409, 'draft-changed']);
    assert.equal(a.deps.calls.filter((c) => c[0] === 'keys').length, 1, 'the stale accept sent nothing');
  });

  test('(−) nothing of the suggestion text reaches a log line, on success and on an internal error', async () => {
    const secret = 'zq-private-suggestion-words';
    const lines = [];
    const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    for (const name of Object.keys(saved)) console[name] = (...args) => { lines.push(args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
    try {
      for (const ctlAnswers of [undefined, { acceptSuggestion: () => { throw new Error('boom'); } }]) {
        const { a } = await bootScreens({ ctlAnswers });
        await pane(a, '%6', 'suggestion', { method: 'POST', json: { text: secret } });
      }
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(lines.some((l) => /POST .*suggestion failed/.test(l)), 'the internal error was logged (so the check is real)');
    assert.deepEqual(lines.filter((l) => l.includes(secret)), []);
  });
});

describe('POST /api/app/pane/:id/submit (0.5, W13)', () => {
  const body = { base: '0123456789abcdef' };

  test('(+) hands the pane and exactly { base } (or {}) to the controller and relays its answer and status', async () => {
    for (const json of [body, {}, { base: '' }]) {
      const { a, control } = await bootScreens({ ctlAnswers: { submit: { status: 200, body: { taken: true, draft: { state: 'empty', queued: true } } } } });
      const r = await pane(a, '%6', 'submit', { method: 'POST', json });
      assert.deepEqual([r.status, r.body], [200, { taken: true, draft: { state: 'empty', queued: true } }]);
      assert.deepEqual(control.calls, [['submit', '%6', json]]);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test('(+) a started pane is eligible; every 409 the controller gives (draft included) and a 429 are relayed as they are', async () => {
    const answers = [
      { status: 409, body: { error: 'prompt-open' } },
      { status: 409, body: { error: 'bypass-prompt' } },
      { status: 409, body: { error: 'screen-unclear' } },
      { status: 409, body: { error: 'draft-changed', draft: { state: 'text', text: 'on screen', sig: '0123456789abcdef' } } },
      { status: 409, body: { error: 'not-idle' } },
      { status: 409, body: { error: 'busy-switching' } },
      { status: 429, body: { error: 'busy', draft: { state: 'text' } } },
      { status: 200, body: { taken: false, draft: { state: 'text' } } },
    ];
    for (const answer of answers) {
      const { a, control } = await bootScreens({ ctlAnswers: { submit: answer } });
      a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
      const r = await pane(a, '%8', 'submit', { method: 'POST', json: body });
      assert.deepEqual([r.status, r.body], [answer.status, answer.body]);
      assert.deepEqual(control.calls, [['submit', '%8', body]]);
    }
  });

  test('(−) a bad body is 400 before the pane check, and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    const bad = [{ text: 'hello' }, { base: 'XYZ' }, { base: 5 }, { base: null }, { base: '0123456789abcde' }, { base: 'ABCDEF0123456789' }, { base: '', keys: ['Enter'] }, { base: 'a'.repeat(16), path: '/etc/passwd' }, [], 'base'];
    for (const json of bad) {
      for (const id of ['%6', '%5']) {
        const r = await pane(a, id, 'submit', { method: 'POST', json });
        assert.equal(r.status, 400, `${JSON.stringify(json).slice(0, 50)} on ${id}`);
        assert.equal(r.body.error, 'invalid');
      }
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) an ineligible pane (zsh, not live, unknown id, bad id) is 404 and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    for (const id of ['%5', '%7', '%99', 'abc', '..']) {
      const r = await a.call('POST', `/api/app/pane/${id.replace('%', '%25')}/submit`, { json: body });
      assert.equal(r.status, 404, id);
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) without the secret 403; text/plain 415; GET and PUT 405; a body over 1 KB 413 -- the controller is not called', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'submit', { method: 'POST', json: body, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'submit', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'submit', { method: 'GET' })).status, 405);
    assert.equal((await pane(a, '%6', 'submit', { method: 'PUT', json: body })).status, 405);
    assert.equal((await pane(a, '%6', 'submit', { method: 'POST', json: { base: '', pad: 'p'.repeat(1100) } })).status, 413);
    assert.deepEqual(control.calls, []);
  });

  test('(−) a foreign Origin or Sec-Fetch-Site is 403 before any pane work', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'submit', { method: 'POST', json: body, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await pane(a, '%6', 'submit', { method: 'POST', json: body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.deepEqual(control.calls, []);
  });

  test('(−) a submit while End runs on the same pane is 409 busy-switching (one lock), and no Enter of the submit is sent', async () => {
    const { a, screens, mirror } = await bootScreens({ fake: false });
    screens['%6'] = boxRows({ cols: 80, lines: ['hello'] }).rows;
    let enter;
    const entered = new Promise((r) => { enter = r; });
    let release;
    const hold = new Promise((r) => { release = r; });
    const capture = mirror.capture;
    mirror.capture = async (...args) => { enter(); await hold; return capture(...args); };
    const end = pane(a, '%6', 'end', { method: 'POST', json: {} });
    await entered;
    const sub = await pane(a, '%6', 'submit', { method: 'POST', json: {} });
    assert.deepEqual([sub.status, sub.body.error], [409, 'busy-switching']);
    release();
    await end;
    assert.equal(a.deps.calls.filter((c) => c[0] === 'keys').length, 0, 'End found a draft in the box and typed nothing; the submit pressed nothing');
  });

  test('(+) end to end with the real controller: one Enter reaches keys.send, in a busy state too, and the answer says the box was taken', async () => {
    const { a, mirror } = await bootScreens({ fake: false });
    const state = { text: 'ship it', queued: false };
    let shots = 0;
    mirror.capture = async () => {
      shots += 1;
      return { status: 200, body: { ...boxRows({ cols: 80, lines: [state.text], insert: true, ghost: state.text === '' && state.queued ? 'Press up to edit queued messages' : null }), etag: `e${shots}` }, etag: `e${shots}` };
    };
    a.deps.keys.send = async (id, b) => { // Claude queues the message: the box empties and shows its placeholder
      a.deps.calls.push(['keys', id, b]);
      if (b.keys?.includes('Enter')) { state.text = ''; state.queued = true; }
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 1 } } };
    };
    const first = (await pane(a, '%6', 'capture')).body.draft;
    const r = await pane(a, '%6', 'submit', { method: 'POST', json: { base: first.sig } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.taken, r.body.draft.state, r.body.draft.queued], [true, 'empty', true]);
    assert.deepEqual(a.deps.calls.filter((c) => c[0] === 'keys').map((c) => c[2]), [{ keys: ['Enter'] }]);
    const stale = await pane(a, '%6', 'submit', { method: 'POST', json: { base: first.sig } });
    assert.deepEqual([stale.status, stale.body.error], [409, 'draft-changed']);
    assert.equal(a.deps.calls.filter((c) => c[0] === 'keys').length, 1, 'the stale submit sent nothing');
  });

  test('(−) nothing of the base reaches a log line, on success and on an internal error', async () => {
    const secret = 'abcdef0123456789';
    const lines = [];
    const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    for (const name of Object.keys(saved)) console[name] = (...args) => { lines.push(args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
    try {
      for (const ctlAnswers of [undefined, { submit: () => { throw new Error('boom'); } }]) {
        const { a } = await bootScreens({ ctlAnswers });
        await pane(a, '%6', 'submit', { method: 'POST', json: { base: secret } });
      }
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(lines.some((l) => /POST .*submit failed/.test(l)), 'the internal error was logged (so the check is real)');
    assert.deepEqual(lines.filter((l) => l.includes(secret)), []);
  });
});

// --- Claude's question and plan dialogs (0.5, W1, ADR 0015): the capture's `dialog` field and POST /api/app/pane/:id/dialog ----------

/** The rows of a synthetic dialog as the screen mirror serves them (the array carries the pane width the dialog was drawn for). */
const dialogRows = (opts = {}) => {
  const s = dialogWorld(opts).screen();
  return Object.assign(s.rows, { cursor: s.cursor, cols: s.cols });
};
const SIG16 = /^[0-9a-f]{16}$/;
const DSIG = '0123456789abcdef';

// --- Send's own typing (0.5, security review I1, T54): the keys route with `send: true` looks at a fresh screen and refuses a prompt, a dialog, the survey, an unclear screen ---

describe("POST /api/app/pane/:id/keys: Send's own typing (send: true, T54)", () => {
  const keysTo = (a, json, id = '%6') => pane(a, id, 'keys', { method: 'POST', json });
  const sent = (a) => a.deps.calls.filter((c) => c[0] === 'keys');
  const boxScreen = (o = {}) => { const b = boxRows({ cols: 80, lines: ['hello'], ...o }); return Object.assign(b.rows, { cursor: b.cursor, cols: b.cols }); };
  const SURVEY_ROWS = ['⏺ All done.', '● How is Claude doing this session? (optional)', '  1: Bad    2: Fine    3: Good    0: Dismiss', FOOTER.plan];
  const UNCLEAR_ROWS = ['Trust the files in this folder?', ' Enter to confirm · Esc to cancel'];
  const BODIES = [{ text: 'hello' }, { text: '2' }, { text: '1. yes' }, { paste: 'one\ntwo' }, { keys: ['C-u'] }, { text: '!ls' }, { text: 'ok', keys: ['Enter'] }];
  // the five dialogs of Claude's that nika knows (dialog-fake.js): each is a dialog shape, none is a permission prompt
  const DIALOGS = {
    ask: () => dialogRows({ phase: 'ask', tabs: [TAB.project, TAB.mode] }),
    review: () => dialogRows({ phase: 'review', tabs: [TAB.project, TAB.mode] }),
    plan: () => dialogRows({ phase: 'plan' }),
    exit: () => dialogRows({ phase: 'exit' }),
    nudge: () => dialogRows({ phase: 'nudge' }),
  };

  test('(+) the fixtures are what the cases below say they are', () => {
    for (const [name, make] of Object.entries(DIALOGS)) {
      assert.equal(dialogOnScreen(make()), true, `${name} is a dialog shape`);
      assert.equal(promptFromRows(make()), null, `${name} is not a permission prompt`);
    }
    assert.notEqual(promptFromRows(rowsOf(PROMPT)), null);
    assert.equal(surveyShown(rowsOf(SURVEY_ROWS)), true);
    assert.equal(promptFromRows(rowsOf(SURVEY_ROWS)), null);
    assert.equal(dialogOnScreen(rowsOf(SURVEY_ROWS)), false);
    assert.notEqual(modeFromRows(rowsOf(SURVEY_ROWS)), 'unknown', 'only the survey check can refuse the survey screen');
    assert.equal(modeFromRows(rowsOf(UNCLEAR_ROWS)), 'unknown');
    assert.equal(promptFromRows(rowsOf(UNCLEAR_ROWS)), null);
    assert.equal(dialogOnScreen(rowsOf(UNCLEAR_ROWS)), false);
  });

  test('(+) a plain screen with a known footer: one fresh capture, then the module gets the body with send: true and a recheck', async () => {
    for (const screen of [rowsOf(['hello', FOOTER.plan]), boxScreen()]) {
      const { a, screens, mirror } = await bootScreens();
      screens['%6'] = screen;
      for (const json of [{ text: 'hello', send: true }, { paste: 'one\ntwo', send: true }, { keys: ['C-u'], send: true }, { text: '!ls', send: true }]) {
        assert.equal((await keysTo(a, json)).status, 200, JSON.stringify(json));
      }
      assert.deepEqual(mirror.opts, Array(4).fill({ fresh: true }), 'one capture per request, never the cached one');
      assert.deepEqual(sent(a).map((c) => c[2]), [
        { text: 'hello', paste: undefined, keys: undefined, send: true }, { text: undefined, paste: 'one\ntwo', keys: undefined, send: true },
        { text: undefined, paste: undefined, keys: ['C-u'], send: true }, { text: '!ls', paste: undefined, keys: undefined, send: true },
      ]);
      for (const c of sent(a)) assert.equal(typeof c[3]?.recheck, 'function', 'the chunk look is handed over');
    }
  });

  test('(+) letters without send skip the capture (as in 0.2); the same letters with send take one', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(['hello', FOOTER.plan]);
    assert.equal((await keysTo(a, { text: 'abc' })).status, 200);
    assert.deepEqual(mirror.seen, []);
    assert.equal((await keysTo(a, { text: 'abc', send: true })).status, 200);
    assert.deepEqual(mirror.seen, ['%6']);
  });

  test('(−) a permission prompt: 409 prompt-open for every kind of body, zero keys', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(PROMPT);
    for (const body of BODIES) {
      const r = await keysTo(a, { ...body, send: true });
      assert.deepEqual([r.status, r.body.error], [409, 'prompt-open'], JSON.stringify(body));
    }
    assert.deepEqual(sent(a), []);
  });

  test('(−) each of Claude\'s dialogs (question, review, plan, Exit plan mode?, the nudge): 409 prompt-open, zero keys', async () => {
    for (const [name, make] of Object.entries(DIALOGS)) {
      const { a, screens } = await bootScreens();
      screens['%6'] = make();
      for (const body of BODIES) {
        const r = await keysTo(a, { ...body, send: true });
        assert.deepEqual([r.status, r.body.error], [409, 'prompt-open'], `${name} ${JSON.stringify(body)}`);
      }
      assert.deepEqual(sent(a), [], name);
    }
  });

  test('(−) Claude\'s feedback survey (it takes the digits 0 to 3): 409 prompt-open, zero keys', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(SURVEY_ROWS);
    for (const body of BODIES) assert.deepEqual([(await keysTo(a, { ...body, send: true })).body.error], ['prompt-open'], JSON.stringify(body));
    assert.deepEqual(sent(a), []);
  });

  test('(−) an unreadable footer with no input box: 409 screen-unclear, zero keys', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(UNCLEAR_ROWS);
    for (const body of BODIES) {
      const r = await keysTo(a, { ...body, send: true });
      assert.deepEqual([r.status, r.body.error], [409, 'screen-unclear'], JSON.stringify(body));
    }
    assert.deepEqual(sent(a), []);
  });

  test('(−) a bypass prompt keeps its own code and line (the bypass checks run first, unchanged)', async () => {
    const { a, screens } = await bootScreens();
    for (const lines of [BYPASS_PROMPT, BYPASS_QUESTION_PROMPT]) {
      screens['%6'] = rowsOf(lines);
      const r = await keysTo(a, { text: 'hello', send: true });
      assert.deepEqual([r.status, r.body.error, r.body.message], [409, 'bypass-prompt', 'Answer this prompt in the terminal']);
    }
    screens['%6'] = rowsOf(['Allow bypass permissions for this folder?', ' Enter to confirm · Esc to cancel']);
    const r = await keysTo(a, { text: 'hello', send: true });
    assert.deepEqual([r.status, r.body.error], [409, 'screen-unclear']);
    assert.deepEqual(sent(a), []);
  });

  test('(−) the capture fails: its status and body, zero keys', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = null;
    const r = await keysTo(a, { text: 'hello', send: true });
    assert.deepEqual([r.status, r.body], [503, { error: 'tmux_unavailable', message: 'x' }]);
    assert.deepEqual(sent(a), []);
  });

  test('(−) send must be the boolean true: false, 1, "yes", null, an object are 400, before the pane check, with no capture and no keys', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(['hello', FOOTER.plan]);
    for (const send of [false, 1, 0, 'yes', 'true', null, {}, []]) {
      for (const id of ['%6', '%5']) { // %5 is not eligible: 400 still comes first
        const r = await keysTo(a, { text: 'hello', send }, id);
        assert.deepEqual([r.status, r.body.error], [400, 'invalid'], `${JSON.stringify(send)} ${id}`);
      }
    }
    assert.deepEqual(mirror.seen, []);
    assert.deepEqual(sent(a), []);
  });

  test('(−) an ineligible pane is still 404 with send: true, before any capture', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(['hello', FOOTER.plan]);
    assert.equal((await keysTo(a, { text: 'hello', send: true }, '%5')).status, 404);
    assert.deepEqual(mirror.seen, []);
  });

  test('(+) the passthrough (no send) is unchanged: digits and letters still go to a prompt, a dialog, the survey and an unclear screen, with no recheck handed over', async () => {
    const screens = [rowsOf(PROMPT), ...Object.values(DIALOGS).map((make) => make()), rowsOf(SURVEY_ROWS), rowsOf(UNCLEAR_ROWS)];
    for (const screen of screens) {
      const { a, screens: shown } = await bootScreens();
      shown['%6'] = screen;
      for (const json of [{ text: '2' }, { text: 'abc' }, { keys: ['Escape'] }, { keys: ['Down', 'Up'] }]) assert.equal((await keysTo(a, json)).status, 200, JSON.stringify(json));
      assert.equal(sent(a).length, 4);
      for (const c of sent(a)) assert.equal(c.length, 3, 'two arguments, as before: no options, no send');
    }
  });

  test('(−) the passthrough keeps today\'s bypass refusal on a bypass prompt (a digit is 409 bypass-prompt), and send changes nothing there', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(BYPASS_PROMPT);
    assert.equal((await keysTo(a, { text: '2' })).body.error, 'bypass-prompt');
    assert.equal((await keysTo(a, { text: '2', send: true })).body.error, 'bypass-prompt');
    assert.equal((await keysTo(a, { text: 'abc' })).status, 200, 'letters without send skip the capture');
  });

  describe('a long text: each chunk after the first looks again (real createKeys, a scripted screen)', () => {
    const rig = async (afterFirst) => {
      const typed = [];
      let boot2;
      const exec = async (cmd, args) => {
        if (args.includes('-l')) {
          typed.push(args.at(-1));
          if (typed.length === 1) boot2.screens['%6'] = afterFirst;
        }
        return { stdout: '', stderr: '' };
      };
      const keys = createKeys({ exec, tmuxBin: 'tmux', sleep: async () => {} });
      boot2 = await bootScreens({ over: { keys } });
      boot2.screens['%6'] = rowsOf(['hello', FOOTER.plan]);
      return { ...boot2, typed };
    };
    const TEXT = 'x'.repeat(800); // 700 + 100

    test('(+) the screen stays plain: both chunks go, the answer is 200, two fresh captures (before the first chunk and before the second)', async () => {
      const { a, mirror, typed } = await rig(rowsOf(['hello', FOOTER.plan]));
      const r = await keysTo(a, { text: TEXT, send: true });
      assert.deepEqual([r.status, r.body], [200, { sent: { text: 800, paste: 0, keys: 0 } }]);
      assert.deepEqual(typed.map((t) => t.length), [700, 100]);
      assert.deepEqual(mirror.opts, [{ fresh: true }, { fresh: true }]);
    });

    test('(−) a permission prompt, each dialog, the survey or an unclear screen appears after the first chunk: 409, the second chunk is not typed, the answer counts the first', async () => {
      const cases = { prompt: rowsOf(PROMPT), survey: rowsOf(SURVEY_ROWS), unclear: rowsOf(UNCLEAR_ROWS), ...Object.fromEntries(Object.entries(DIALOGS).map(([k, make]) => [k, make()])) };
      for (const [name, screen] of Object.entries(cases)) {
        const { a, typed } = await rig(screen);
        const r = await keysTo(a, { text: TEXT, send: true });
        assert.equal(r.status, 409, name);
        assert.ok(['prompt-open', 'screen-unclear'].includes(r.body.error), `${name}: ${r.body.error}`);
        assert.deepEqual(r.body.sent, { text: 700, paste: 0, keys: 0 }, name);
        assert.deepEqual(typed.map((t) => t.length), [700], `${name}: only the first chunk went out`);
      }
    });

    test('(−) a bypass prompt after the first chunk: 409 bypass-prompt, no second chunk', async () => {
      const { a, typed } = await rig(rowsOf(BYPASS_PROMPT));
      const r = await keysTo(a, { text: TEXT, send: true });
      assert.deepEqual([r.status, r.body.error, r.body.sent], [409, 'bypass-prompt', { text: 700, paste: 0, keys: 0 }]);
      assert.equal(typed.length, 1);
    });

    test('(−) the capture fails before the second chunk: its status, no second chunk', async () => {
      const { a, typed } = await rig(null);
      const r = await keysTo(a, { text: TEXT, send: true });
      assert.equal(r.status, 503);
      assert.equal(typed.length, 1);
    });

    test('(−) without send the same text is typed in both chunks whatever appears in between (the passthrough is the user\'s own typing)', async () => {
      const { a, typed } = await rig(rowsOf(PROMPT));
      const r = await keysTo(a, { text: TEXT });
      assert.deepEqual([r.status, typed.map((t) => t.length)], [200, [700, 100]]);
    });
  });
});

describe('capture: the dialog field', () => {
  test('(+) a question on screen: ready, with the tabs, the options and a 16-hex sig; prompt stays null', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = dialogRows({ tabs: [TAB.project, TAB.mode] });
    const r = await pane(a, '%6', 'capture');
    assert.equal(r.status, 200);
    const d = r.body.dialog;
    assert.equal(r.body.prompt, null);
    assert.deepEqual([d.state, d.kind, d.at, d.current, d.final, d.multi, d.other, d.bypass], ['ready', 'ask', 'question', 0, false, false, true, false]);
    assert.match(d.sig, SIG16);
    assert.deepEqual(d.options.map((o) => o.label), ['acme-api', 'web-shop', 'demo-api']);
    assert.deepEqual(d.tabs.map((t) => t.header), ['Project', 'Mode']);
    assert.equal(d.sig, dialogSig(readDialogScreen(screens['%6'], 120)), 'the sig is the one the controller computes');
    assert.equal(r.body.cols, 120, 'the width the dialog was read with');
  });

  test('(+) a multi-select question carries the checkbox marks; a review its answers; a plan its choices', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = dialogRows({ tabs: [TAB.tools] });
    const multi = (await pane(a, '%6', 'capture')).body.dialog;
    assert.deepEqual([multi.multi, multi.final, multi.other], [true, false, true]);
    assert.deepEqual(multi.options.map((o) => o.checked), [false, false, false]);
    screens['%6'] = dialogRows({ tabs: [TAB.project, TAB.tools], phase: 'review' });
    const review = (await pane(a, '%6', 'capture')).body.dialog;
    assert.deepEqual([review.state, review.kind, review.at], ['ready', 'ask', 'review']);
    assert.ok(Array.isArray(review.pairs) && Array.isArray(review.tabs));
    screens['%6'] = dialogRows({ phase: 'plan' });
    const plan = (await pane(a, '%6', 'capture')).body.dialog;
    assert.deepEqual([plan.state, plan.kind, plan.at], ['ready', 'plan', 'plan']);
    assert.ok(plan.options.length >= 2);
  });

  test('(+) the sig changes with the tab, the answer marks and the plan text, and not with the focus', async () => {
    const { a, screens } = await bootScreens();
    const sigs = new Set();
    for (const opts of [{ tabs: [TAB.project, TAB.mode] }, { tabs: [TAB.project, TAB.mode], i: 1 }, { tabs: [TAB.project, TAB.mode], focus: 2 }, { tabs: [TAB.project, TAB.mode], phase: 'review' }, { phase: 'plan' }]) {
      screens['%6'] = dialogRows(opts);
      sigs.add((await pane(a, '%6', 'capture')).body.dialog.sig);
    }
    assert.equal(sigs.size, 4, 'five screens, one pair that differs only by the focus');
  });

  test('(−) no dialog: a plain screen, a permission prompt (prompt wins) and an empty screen read null', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['hello', FOOTER.plan]);
    assert.equal((await pane(a, '%6', 'capture')).body.dialog, null);
    screens['%6'] = rowsOf(PROMPT);
    const p = await pane(a, '%6', 'capture');
    assert.equal(p.body.dialog, null);
    assert.ok(p.body.prompt, 'the permission prompt is still read');
    screens['%6'] = rowsOf([]);
    assert.equal((await pane(a, '%6', 'capture')).body.dialog, null);
  });

  test('(−) a dialog nika cannot read exactly is reported as unreadable with a reason, never as ready (a narrow pane, the nudge, "Exit plan mode?")', async () => {
    const { a, screens } = await bootScreens();
    for (const opts of [{ cols: 40 }, { phase: 'nudge' }, { phase: 'exit' }]) {
      screens['%6'] = dialogRows(opts);
      const d = (await pane(a, '%6', 'capture')).body.dialog;
      assert.equal(d.state, 'unreadable', JSON.stringify(opts));
      assert.ok(typeof d.reason === 'string' && d.reason.length > 0);
      assert.equal(d.sig, undefined, 'there is nothing to answer, so no sig');
    }
  });

  test('(−) a dialog that mentions bypass is ready with bypass true (the page then shows it as terminal-only)', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = dialogRows({ tabs: [{ header: 'Mode', question: 'Which mode?', options: [['bypass permissions', 'Skip every check.'], ['safe', 'Run every step.']] }] });
    const d = (await pane(a, '%6', 'capture')).body.dialog;
    assert.deepEqual([d.state, d.bypass], ['ready', true]);
  });

  test('(−) the dialog is on the app tier\'s capture only: the browser tier has no capture route and its agent list carries no dialog', async () => {
    const server = createServer({ config: fx.config, exec: fakeExec(), token: 'tok', now: () => NOW, version: '0.0.0' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    servers.push(server);
    const port = server.address().port;
    const call = (method, p) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'content-length': '2' }) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      q.on('error', reject);
      q.end(method === 'GET' ? undefined : '{}');
    });
    assert.equal((await call('GET', '/api/app/pane/%256/capture')).status, 404);
    assert.equal((await call('POST', '/api/app/pane/%256/dialog')).status, 404, 'answering a dialog presses keys: app tier only');
    const agents = await call('GET', '/api/agents?since=all');
    assert.equal(agents.status, 200);
    assert.doesNotMatch(agents.data, /"dialog"|"pairs"/);
  });
});

describe('POST /api/app/pane/:id/dialog', () => {
  const body = { picks: [2], sig: DSIG };

  test('(+) hands the pane and exactly the body to the controller and relays its answer and status (every shape)', async () => {
    const shapes = [{ picks: [2], sig: DSIG }, { picks: [], text: 'acme-api', sig: DSIG }, { sig: DSIG, submit: true }, { sig: DSIG, choice: 1 }, { sig: DSIG, cancel: true }];
    for (const json of shapes) {
      const { a, control } = await bootScreens({ ctlAnswers: { answerDialog: { status: 200, body: { done: 'next', sent: 1 } } } });
      const r = await pane(a, '%6', 'dialog', { method: 'POST', json });
      assert.deepEqual([r.status, r.body], [200, { done: 'next', sent: 1 }]);
      assert.deepEqual(control.calls, [['answerDialog', '%6', json]]);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test('(+) a started pane is eligible; every 400 and 409 the controller gives (with `sent`) is relayed as it is', async () => {
    const answers = [
      { status: 409, body: { error: 'dialog-changed' } },
      { status: 409, body: { error: 'no-dialog', sent: 2 } },
      { status: 409, body: { error: 'not-taken', sent: 1 } },
      { status: 409, body: { error: 'text-mismatch', sent: 3 } },
      { status: 409, body: { error: 'already-answered' } },
      { status: 409, body: { error: 'busy-switching' } },
      { status: 400, body: { error: 'terminal-only', message: 'answer this in the terminal' } },
      { status: 429, body: { error: 'busy', sent: 1 } },
    ];
    for (const answer of answers) {
      const { a, control } = await bootScreens({ ctlAnswers: { answerDialog: answer } });
      a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
      const r = await pane(a, '%8', 'dialog', { method: 'POST', json: body });
      assert.deepEqual([r.status, r.body], [answer.status, answer.body]);
      assert.deepEqual(control.calls, [['answerDialog', '%8', body]]);
    }
  });

  test('(−) a bad body is 400 before the pane check, and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    const bad = [
      {}, { sig: DSIG }, { picks: [1] }, { picks: [1], sig: 'xyz' }, { picks: [1], sig: DSIG.toUpperCase() }, { picks: [1], sig: `${DSIG}0` },
      { picks: [1], sig: DSIG, extra: 1 }, { picks: [1], sig: DSIG, path: '/etc/passwd' }, { picks: [1], sig: DSIG, submit: true },
      { sig: DSIG, submit: false }, { sig: DSIG, submit: 1 }, { sig: DSIG, submit: true, cancel: true }, { sig: DSIG, cancel: 'yes' }, { sig: DSIG, cancel: true, choice: 1 },
      { sig: DSIG, choice: 0 }, { sig: DSIG, choice: 10 }, { sig: DSIG, choice: '1' }, { sig: DSIG, choice: 1.5 },
      { picks: [0], sig: DSIG }, { picks: [8], sig: DSIG }, { picks: [1, 1], sig: DSIG }, { picks: [1.5], sig: DSIG }, { picks: ['1'], sig: DSIG }, { picks: '1', sig: DSIG },
      { picks: [1, 2, 3, 4, 5, 6, 7, 1], sig: DSIG }, { picks: [null], sig: DSIG }, { picks: { 0: 1, length: 1 }, sig: DSIG },
      { picks: [1], text: '', sig: DSIG }, { picks: [1], text: 5, sig: DSIG }, { picks: [], text: 'a\nb', sig: DSIG }, { picks: [], text: 'a'.repeat(301), sig: DSIG },
      { picks: [], text: ' a', sig: DSIG }, { picks: [], text: 'a ', sig: DSIG }, { picks: [], text: 'a\u001b[2mb', sig: DSIG }, { picks: [], text: 'a\u0000', sig: DSIG },
      { picks: [], text: 'a\u202eb', sig: DSIG }, { picks: [], text: 'a\u200bb', sig: DSIG }, { picks: [], text: 'a\ud800b', sig: DSIG }, { picks: [], text: null, sig: DSIG },
      [], 'sig',
    ];
    for (const json of bad) {
      for (const id of ['%6', '%5']) {
        const r = await pane(a, id, 'dialog', { method: 'POST', json });
        assert.equal(r.status, 400, `${JSON.stringify(json).slice(0, 60)} on ${id}`);
      }
      if (!Array.isArray(json) && typeof json === 'object') assert.equal((await pane(a, '%6', 'dialog', { method: 'POST', json })).body.error, 'invalid');
    }
    const proto = await pane(a, '%6', 'dialog', { method: 'POST', body: `{"__proto__":{"picks":[1]},"sig":"${DSIG}"}`, headers: { 'content-type': 'application/json' } });
    assert.equal(proto.status, 400, '__proto__ is refused');
    assert.deepEqual(control.calls, []);
  });

  test('(−) the longest text the validator takes (300 characters) and picks up to 7 reach the controller', async () => {
    const { a, control } = await bootScreens();
    const json = { picks: [1, 2, 3, 4, 5, 6, 7], text: 'a'.repeat(299) + 'é', sig: DSIG };
    assert.equal((await pane(a, '%6', 'dialog', { method: 'POST', json })).status, 200);
    assert.deepEqual(control.calls, [['answerDialog', '%6', json]]);
  });

  test('(−) an ineligible pane (zsh, not live, unknown id, bad id) is 404 and the controller is not called', async () => {
    const { a, control } = await bootScreens();
    for (const id of ['%5', '%7', '%99', 'abc', '..']) {
      const r = await a.call('POST', `/api/app/pane/${id.replace('%', '%25')}/dialog`, { json: body });
      assert.equal(r.status, 404, id);
    }
    assert.deepEqual(control.calls, []);
  });

  test('(−) without the secret 403; text/plain 415; GET and PUT 405; a body over 20 KB 413 -- the controller is not called', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'dialog', { method: 'POST', json: body, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await pane(a, '%6', 'dialog', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await pane(a, '%6', 'dialog', { method: 'GET' })).status, 405);
    assert.equal((await pane(a, '%6', 'dialog', { method: 'PUT', json: body })).status, 405);
    assert.equal((await pane(a, '%6', 'dialog', { method: 'POST', json: { ...body, pad: 'p'.repeat(21 * 1024) } })).status, 413);
    assert.deepEqual(control.calls, []);
  });

  test('(−) a foreign Origin or Sec-Fetch-Site is 403 before any pane work', async () => {
    const { a, control } = await bootScreens();
    assert.equal((await pane(a, '%6', 'dialog', { method: 'POST', json: body, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await pane(a, '%6', 'dialog', { method: 'POST', json: body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.deepEqual(control.calls, []);
  });

  test('(−) an answer while End runs on the same pane is 409 busy-switching (one lock), and no digit is sent', async () => {
    const { a, screens, mirror } = await bootScreens({ fake: false });
    screens['%6'] = dialogRows();
    let enter;
    const entered = new Promise((r) => { enter = r; });
    let release;
    const hold = new Promise((r) => { release = r; });
    const capture = mirror.capture;
    mirror.capture = async (...args) => { enter(); await hold; return capture(...args); };
    const end = pane(a, '%6', 'end', { method: 'POST', json: {} });
    await entered;
    const put = await pane(a, '%6', 'dialog', { method: 'POST', json: { picks: [1], sig: DSIG } });
    assert.deepEqual([put.status, put.body.error], [409, 'busy-switching']);
    release();
    await end;
    assert.ok(!a.deps.calls.some((c) => c[0] === 'keys' && c[2]?.text === '1'), 'no digit went out');
  });

  /** The real controller on a synthetic Claude: GET capture gives the sig, POST dialog answers one step, the screen changes the way Claude's does. */
  async function live(opts) {
    const world = dialogWorld(opts);
    const { a, mirror } = await bootScreens({ fake: false });
    let shots = 0;
    mirror.capture = async () => {
      shots += 1;
      const r = await world.mirror.capture('%6');
      return { ...r, body: { ...r.body, etag: `e${shots}` }, etag: `e${shots}` };
    };
    a.deps.keys.send = async (id, b) => { a.deps.calls.push(['keys', id, b]); return world.keys.send(id, b); };
    const sig = async () => (await pane(a, '%6', 'capture')).body.dialog;
    const post = (json) => pane(a, '%6', 'dialog', { method: 'POST', json });
    return { a, world, sig, post };
  }

  test('(+) end to end with the real controller: one step per request, a fresh sig each time, Submit last; the dialog is then gone', async () => {
    const { world, sig, post, a } = await live({ tabs: [TAB.project, TAB.mode] });
    const first = await sig();
    assert.deepEqual([first.state, first.current], ['ready', 0]);
    let r = await post({ picks: [2], sig: first.sig });
    assert.deepEqual([r.status, r.body], [200, { done: 'next', sent: 1 }]);
    const second = await sig();
    assert.deepEqual([second.state, second.current], ['ready', 1]);
    assert.notEqual(second.sig, first.sig);
    r = await post({ picks: [1], sig: second.sig });
    assert.deepEqual([r.status, r.body.done], [200, 'review']);
    const review = await sig();
    assert.equal(review.at, 'review');
    r = await post({ submit: true, sig: review.sig });
    assert.deepEqual([r.status, r.body.done], [200, 'submitted']);
    assert.equal(await sig(), null);
    assert.deepEqual(world.keysLog(), ['text:2', 'text:1', 'Enter']);
    assert.deepEqual(world.leaks(), []);
    const late = await post({ submit: true, sig: review.sig });
    assert.deepEqual([late.status, late.body.error], [409, 'no-dialog']);
    assert.equal(a.deps.calls.filter((c) => c[0] === 'keys').length, 3, 'the late request sent nothing');
  });

  test('(+) end to end: Other text, a plan choice and a Decline each take their keys and nothing else', async () => {
    const other = await live({});
    const s = await other.sig();
    const r = await other.post({ picks: [], text: 'acme-api staging', sig: s.sig });
    assert.deepEqual([r.status, r.body.done], [200, 'submitted']);
    assert.deepEqual(other.world.keysLog(), ['Down', 'Down', 'Down', 'text:acme-api staging', 'Enter']);
    const plan = await live({ phase: 'plan' });
    const ps = await plan.sig();
    assert.equal((await plan.post({ sig: ps.sig, choice: 1 })).body.done, 'chosen');
    assert.deepEqual(plan.world.keysLog(), ['text:1']);
    const decline = await live({ phase: 'plan' });
    const ds = await decline.sig();
    assert.equal((await decline.post({ sig: ds.sig, cancel: true })).body.done, 'declined');
    assert.deepEqual(decline.world.keysLog(), ['Escape']);
  });

  test('(−) end to end: a stale sig is 409 dialog-changed and a dialog that mentions bypass is 400 terminal-only -- nothing is sent', async () => {
    const stale = await live({ tabs: [TAB.project, TAB.mode] });
    const s = await stale.sig();
    assert.equal((await stale.post({ picks: [1], sig: s.sig })).status, 200);
    const old = await stale.post({ picks: [1], sig: s.sig });
    assert.deepEqual([old.status, old.body.error], [409, 'dialog-changed']);
    assert.deepEqual(stale.world.keysLog(), ['text:1'], 'only the first answer went out');
    const bypass = await live({ tabs: [{ header: 'Mode', question: 'Which mode?', options: [['bypass permissions', 'Skip every check.'], ['safe', 'Run every step.']] }] });
    const b = await bypass.sig();
    const r = await bypass.post({ picks: [1], sig: b.sig });
    assert.deepEqual([r.status, r.body.error], [400, 'terminal-only']);
    assert.deepEqual(bypass.world.keysLog(), []);
  });

  test('(−) nothing of the answer text, the picks or the sig reaches a log line, on success and on an internal error', async () => {
    const secret = 'zq-private-dialog-words';
    const lines = [];
    const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    for (const name of Object.keys(saved)) console[name] = (...args) => { lines.push(args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
    try {
      for (const ctlAnswers of [undefined, { answerDialog: () => { throw new Error('boom'); } }]) {
        const { a } = await bootScreens({ ctlAnswers });
        await pane(a, '%6', 'dialog', { method: 'POST', json: { picks: [], text: secret, sig: DSIG } });
      }
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(lines.some((l) => /POST .*dialog failed/.test(l)), 'the internal error was logged (so the check is real)');
    assert.deepEqual(lines.filter((l) => l.includes(secret) || l.includes(DSIG)), []);
  });
});

// --- fit (0.5, W7, ADR 0017): PUT|DELETE /api/app/pane/:id/fit -------------------------------------------------------------

const FIT_OK = (b) => ({ status: 200, body: { fit: { state: 'fitted', reason: null, pane: { cols: b.cols, rows: b.rows }, panes: 3, userZoom: false } } });

/** A fit factory that records what the router builds it with (`opts`) and what the routes call; `answers[name]` (a value or a function) replaces a method's result. */
function fakeFit(answers = {}) {
  const f = { calls: [], opts: null, answers };
  const method = (name, fallback) => async (...args) => {
    f.calls.push([name, ...args]);
    const given = f.answers[name];
    return typeof given === 'function' ? given(...args) : given ?? fallback(...args);
  };
  f.factory = (opts) => {
    f.opts = opts;
    return {
      hold: method('hold', (id, b) => FIT_OK(b)),
      release: method('release', () => ({ status: 200, body: { released: true } })),
      releaseWindow: method('releaseWindow', () => false),
      releaseAll: method('releaseAll', () => 0),
      recover: method('recover', () => ({ released: 0, dropped: 0 })),
      size: () => 0,
    };
  };
  return f;
}
const fitPane = (a, id, opts = {}) => a.call(opts.method ?? 'PUT', `/api/app/pane/${id.replace('%', '%25')}/fit`, opts);
const FIT_BODY = { cols: 120, rows: 39, open: true };
/** What the controller is handed for a 3-key body (F9): the route fills in the boolean `focus`, false when the page sent none. */
const FIT_SEEN = { ...FIT_BODY, focus: false };
const FIT_MESSAGE = 'cols must be an integer 40–400, rows 10–200, open a boolean, focus a boolean when present';
const FIT_LIST = [TMUX, '-u', 'list-panes', '-a', '-F', ['#{pane_id}', '#{window_id}', '#{window_panes}', '#{window_zoomed_flag}', '#{pane_active}', '#{window_width}', '#{window_height}', '#{pane_width}', '#{pane_height}', '#{pane_current_command}', '#{@nika-fit}', '#{@nika-role}', '#{window_active_clients}'].join('\t')];

describe('PUT|DELETE /api/app/pane/:id/fit', () => {
  // F9 (requirement changed): the controller is handed { cols, rows, open, focus }; a 3-key body arrives with focus false (the safe side)
  test('(+) PUT hands the pane and exactly { cols, rows, open, focus } to the controller and relays its status, body and no-store', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    const r = await fitPane(a, '%6', { json: FIT_BODY });
    assert.deepEqual([r.status, r.body], [200, FIT_OK(FIT_BODY).body]);
    assert.deepEqual(fit.calls, [['hold', '%6', FIT_SEEN]]);
    assert.equal(r.headers['cache-control'], 'no-store');
    fit.answers.hold = { status: 200, body: { fit: { state: 'zoomed', reason: 'panel-smaller', pane: { cols: 200, rows: 50 }, panes: 3, userZoom: false } } };
    a.clock.t += 2000;
    assert.deepEqual((await fitPane(a, '%6', { json: { cols: 40, rows: 10, open: false } })).body.fit.reason, 'panel-smaller');
    assert.deepEqual(fit.calls.at(-1), ['hold', '%6', { cols: 40, rows: 10, open: false, focus: false }]);
  });

  test('(+) F9: a PUT with focus true or false reaches the controller with that boolean, and a 200 relays its answer', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    const yes = await fitPane(a, '%6', { json: { ...FIT_BODY, focus: true } });
    assert.deepEqual([yes.status, yes.body], [200, FIT_OK(FIT_BODY).body]);
    assert.deepEqual(fit.calls.at(-1), ['hold', '%6', { ...FIT_BODY, focus: true }]);
    a.clock.t += 2000;
    assert.equal((await fitPane(a, '%6', { json: { ...FIT_BODY, focus: false } })).status, 200);
    assert.deepEqual(fit.calls.at(-1), ['hold', '%6', { ...FIT_BODY, focus: false }]);
  });

  test('(−) F9: a focus that is not a boolean is 400 with the new message before the pane check (an eligible and an ineligible pane), the controller is not called and no rate slot is used', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (const focus of ['yes', 'true', 1, 0, null, [], {}]) { // (JSON drops `undefined`: that body has three keys and is the valid focus-less one)
      for (const id of ['%6', '%5']) {
        const r = await fitPane(a, id, { json: { ...FIT_BODY, focus } });
        assert.equal(r.status, 400, `${String(focus)} on ${id}`);
        assert.deepEqual([r.body.error, r.body.message], ['invalid', FIT_MESSAGE]);
      }
    }
    assert.deepEqual(fit.calls, []);
    for (let i = 0; i < 4; i += 1) assert.equal((await fitPane(a, '%6', { json: { ...FIT_BODY, focus: true } })).status, 200, 'all four slots are still free');
  });

  test('(+) a started pane is eligible for a fit like for any control', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    assert.equal((await fitPane(a, '%8', { json: FIT_BODY })).status, 200);
    assert.deepEqual(fit.calls, [['hold', '%8', FIT_SEEN]]);
  });

  test('(+) DELETE hands the pane id to release and relays { released }', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    const r = await fitPane(a, '%6', { method: 'DELETE' });
    assert.deepEqual([r.status, r.body], [200, { released: true }]);
    assert.deepEqual(fit.calls, [['release', '%6']]);
    fit.answers.release = { status: 200, body: { released: false } };
    assert.deepEqual((await fitPane(a, '%6', { method: 'DELETE' })).body, { released: false });
  });

  test('(+) the router builds the controller from the real exec, tmux binary, clock, the state dir and the session controller\'s pane lock, and puts it on ctx', async () => {
    const fit = fakeFit();
    const control = fakeControl();
    const lock = async (id, fn) => fn();
    const calls = [];
    const exec = async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; };
    const a = await boot({ ctxOver: { exec }, deps: makeDeps({ createFit: fit.factory, createSessionControl: (o) => ({ ...control.factory(o), withPaneLock: lock }) }) });
    assert.equal(fit.opts.exec, exec);
    assert.equal(fit.opts.tmuxBin, a.ctx.tmuxBin);
    assert.equal(fit.opts.stateDir, stateDir(w.env));
    assert.equal(fit.opts.lock, lock);
    a.clock.t = 4242;
    assert.equal(fit.opts.now(), 4242, 'the controller reads the same clock as the router');
    assert.equal(typeof a.ctx.fit.hold, 'function');
    assert.equal(a.ctx.fit.size(), 0);
    assert.deepEqual(calls, [], 'building it runs no tmux call');
  });

  test('(+) with the real controller behind the router, a PUT goes to tmux with the real exec and tmux binary, and tmux\'s answer decides (a pane tmux does not list: 404)', async () => {
    const calls = [];
    const exec = async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; };
    const { a } = await bootScreens({ ctxOver: undefined, over: {} });
    const b = await boot({ ctxOver: { exec }, deps: a.deps });
    const r = await fitPane(b, '%6', { json: FIT_BODY });
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
    assert.deepEqual(calls, [[TMUX, ['-u', ...FIT_LIST.slice(2)]]]);
  });

  test('(+) a fit step shares the pane lock with End: it waits for a running End, and a draft write during the step is 409 busy-switching and types nothing', async () => {
    const fit = fakeFit();
    const { a, screens, mirror } = await bootScreens({ fake: false, over: { createFit: fit.factory } });
    screens['%6'] = boxRows({ cols: 80, lines: [''] }).rows;
    let enter;
    const entered = new Promise((r) => { enter = r; });
    let letGo;
    const gate = new Promise((r) => { letGo = r; });
    const capture = mirror.capture;
    mirror.capture = async (...args) => { enter(); await gate; return capture(...args); };
    const order = [];
    let release;
    const held = new Promise((r) => { release = r; });
    fit.answers.hold = (id, b) => fit.opts.lock(id, async () => {
      order.push('step');
      await held;
      return FIT_OK(b);
    });
    release(); // the first step does not stop
    const end = pane(a, '%6', 'end', { method: 'POST', json: {} });
    await entered;
    const put = fitPane(a, '%6', { json: FIT_BODY });
    await new Promise((r) => setTimeout(r, 120)); // several polls of the waiting lock
    assert.deepEqual(order, [], 'the fit waits while End holds the pane');
    letGo();
    await end;
    assert.equal((await put).status, 200);
    assert.deepEqual(order, ['step']);
    // second step: it holds the pane until the test lets go
    let letStep;
    const held2 = new Promise((r) => { letStep = r; });
    fit.answers.hold = (id, b) => fit.opts.lock(id, async () => {
      order.push('step2');
      await held2;
      return FIT_OK(b);
    });
    a.clock.t += 2000;
    const put2 = fitPane(a, '%6', { json: FIT_BODY });
    while (!order.includes('step2')) await new Promise((r) => setTimeout(r, 5));
    const typed = a.deps.calls.filter((c) => c[0] === 'keys').length;
    const draft = await pane(a, '%6', 'draft', { method: 'PUT', json: { text: 'hi', base: '' } });
    assert.deepEqual([draft.status, draft.body.error], [409, 'busy-switching']);
    assert.equal((await pane(a, '%6', 'end', { method: 'POST', json: {} })).body.error, 'busy-switching');
    assert.equal(a.deps.calls.filter((c) => c[0] === 'keys').length, typed, 'nothing was typed');
    letStep();
    assert.equal((await put2).status, 200);
  });

  test('(+) PUT: 4 per second per pane, the 5th is 429 and reaches no controller; a second later it is served again; another pane has its own count', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    for (let i = 0; i < 4; i += 1) assert.equal((await fitPane(a, '%6', { json: FIT_BODY })).status, 200);
    assert.equal(fit.calls.length, 4);
    const fifth = await fitPane(a, '%6', { json: FIT_BODY });
    assert.deepEqual([fifth.status, fifth.body.error], [429, 'busy']);
    assert.match(fifth.body.message, /at most 4 fit requests per second per pane/);
    assert.equal(fit.calls.length, 4, 'the refused request reached nothing');
    assert.equal((await fitPane(a, '%8', { json: FIT_BODY })).status, 200, 'another pane');
    a.clock.t += 1001;
    assert.equal((await fitPane(a, '%6', { json: FIT_BODY })).status, 200);
    assert.equal(fit.calls.length, 6);
  });

  test('(+) DELETE has its own bucket: 4 PUTs in one second, then a DELETE is 200 and releases (a page that closes right after a heartbeat gives the window back)', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (let i = 0; i < 4; i += 1) assert.equal((await fitPane(a, '%6', { json: FIT_BODY })).status, 200);
    assert.equal((await fitPane(a, '%6', { json: FIT_BODY })).status, 429, 'the PUT bucket is full');
    const del = await fitPane(a, '%6', { method: 'DELETE' });
    assert.deepEqual([del.status, del.body], [200, { released: true }]);
    assert.deepEqual(fit.calls.at(-1).slice(0, 2), ['release', '%6']);
    assert.equal(fit.calls.length, 5);
  });

  test('(+) and a full DELETE bucket does not take PUT slots: 4 DELETEs, then a PUT is 200', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (let i = 0; i < 4; i += 1) assert.equal((await fitPane(a, '%6', { method: 'DELETE' })).status, 200);
    assert.equal((await fitPane(a, '%6', { json: FIT_BODY })).status, 200);
    assert.deepEqual(fit.calls.map((c) => c[0]), ['release', 'release', 'release', 'release', 'hold']);
  });

  test('(−) 5 DELETEs in one second: the 5th is 429 busy and reaches no controller (no release, so no tmux call); another pane is served; a second later it is served again', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (let i = 0; i < 4; i += 1) assert.equal((await fitPane(a, '%6', { method: 'DELETE' })).status, 200);
    const fifth = await fitPane(a, '%6', { method: 'DELETE' });
    assert.deepEqual([fifth.status, fifth.body.error], [429, 'busy']);
    assert.match(fifth.body.message, /at most 4 fit requests per second per pane/);
    assert.equal(fit.calls.length, 4, 'the refused DELETE reached nothing');
    assert.equal((await fitPane(a, '%99', { method: 'DELETE' })).status, 200, 'another pane has its own count');
    a.clock.t += 1001;
    assert.equal((await fitPane(a, '%6', { method: 'DELETE' })).status, 200);
    assert.equal(fit.calls.length, 6);
  });

  test('(−) the real controller with no lease: five DELETEs in one second answer 200 x4 then 429, and no tmux call runs for any of them', async () => {
    const calls = [];
    const exec = async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; };
    const { a } = await bootScreens({});
    const b = await boot({ ctxOver: { exec }, deps: a.deps });
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await fitPane(b, '%6', { method: 'DELETE' })).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
    assert.deepEqual(calls, []);
  });

  test('(−) a bad body is 400 before the pane check (an eligible and an ineligible pane alike), the controller is not called, and the 400 uses no rate slot', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    const bad = [
      {}, { cols: 120, rows: 39 }, { cols: 120, open: true }, { rows: 39, open: true }, { cols: 120, rows: 39, open: 'true' }, { cols: 120, rows: 39, open: 1 },
      { cols: 120.5, rows: 39, open: true }, { cols: '120', rows: 39, open: true }, { cols: 120, rows: '39', open: true }, { cols: null, rows: 39, open: true },
      { cols: 39, rows: 39, open: true }, { cols: 401, rows: 39, open: true }, { cols: 120, rows: 9, open: true }, { cols: 120, rows: 201, open: true },
      { cols: 120, rows: 39, open: true, extra: 1 }, { cols: 120, rows: 39, open: true, path: '/etc/passwd' },
    ];
    for (const json of bad) {
      for (const id of ['%6', '%5']) {
        const r = await fitPane(a, id, { json });
        assert.equal(r.status, 400, `${JSON.stringify(json)} on ${id}`);
        assert.deepEqual([r.body.error, r.body.message], ['invalid', FIT_MESSAGE]); // F9 (requirement changed): the message names focus
      }
    }
    assert.deepEqual((await a.call('PUT', '/api/app/pane/%256/fit', { body: '[]', headers: { 'content-type': 'application/json' } })).body.error, 'invalid');
    assert.deepEqual(fit.calls, []);
    for (let i = 0; i < 4; i += 1) assert.equal((await fitPane(a, '%6', { json: FIT_BODY })).status, 200, 'all four slots are still free');
  });

  test('(−) the bounds are inclusive: 40 x 10 and 400 x 200 pass', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (const json of [{ cols: 40, rows: 10, open: false }, { cols: 400, rows: 200, open: true }]) assert.equal((await fitPane(a, '%6', { json })).status, 200);
  });

  test('(−) an ineligible pane (zsh, not live, unknown id, a bad id) is 404, the controller is not called, and the 404 uses no rate slot', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (let round = 0; round < 3; round += 1) {
      for (const id of ['%5', '%7', '%8', '%99', 'abc', '..']) assert.equal((await fitPane(a, id, { json: FIT_BODY })).status, 404, id);
    }
    assert.deepEqual(fit.calls, []);
  });

  test('(−) DELETE with a malformed pane id is 400, nothing is released; a well-formed id of a pane that is gone or is no claude is still passed on (not eligibility-gated)', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (const id of ['abc', '%x', '5', '%1%2', '%6;ls', 'x'.repeat(30)]) {
      const r = await a.call('DELETE', `/api/app/pane/${encodeURIComponent(id)}/fit`);
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], id);
    }
    assert.deepEqual(fit.calls, []);
    for (const id of ['%5', '%99', '%7']) assert.equal((await fitPane(a, id, { method: 'DELETE' })).status, 200, id);
    assert.deepEqual(fit.calls.map((c) => c.slice(0, 2)), [['release', '%5'], ['release', '%99'], ['release', '%7']]);
  });

  test('(−) DELETE for a pane that holds no lease is 200 { released: false } and runs no tmux call (the real controller)', async () => {
    const calls = [];
    const exec = async (...args) => { calls.push(args); return { stdout: '', stderr: '' }; };
    const { a } = await bootScreens({});
    const b = await boot({ ctxOver: { exec }, deps: a.deps });
    for (const id of ['%6', '%99', '%5']) {
      const r = await fitPane(b, id, { method: 'DELETE' });
      assert.deepEqual([r.status, r.body], [200, { released: false }], id);
    }
    assert.deepEqual(calls, []);
  });

  test('(−) a request for a tmux window another pane\'s request is still working on is 409 busy (the real controller over a scripted tmux)', async () => {
    const calls = [];
    let letGo;
    const gate = new Promise((r) => { letGo = r; });
    let reached;
    const waiting = new Promise((r) => { reached = r; });
    const row = (id, active) => [id, '@1', '2', '0', active, '200', '50', '100', '50', 'claude', '', '', '0'].join('\t'); // 13 fields: ..., @nika-fit, @nika-role, window_active_clients
    const exec = async (bin, argv) => {
      calls.push(argv);
      if (argv[1] === 'list-panes') return { stdout: `${row('%6', '1')}\n${row('%7', '0')}\n`, stderr: '' };
      if (argv[1] === 'show-options') { reached(); await gate; return { stdout: '', stderr: '' }; }
      if (argv[1] === 'display-message') return { stdout: '{"w":200,"h":50}\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const { a } = await bootScreens({});
    const b = await boot({ ctxOver: { exec }, deps: a.deps });
    b.ctx.started.set('%7', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    const first = fitPane(b, '%6', { json: FIT_BODY });
    await waiting;
    const second = await fitPane(b, '%7', { json: { cols: 130, rows: 40, open: true } });
    assert.deepEqual([second.status, second.body.error], [409, 'busy']);
    letGo();
    await first;
    assert.ok(calls.every((c) => c[0] === '-u'), 'every call carried -u first');
  });

  test('(−) the controller\'s 502 tmux_failed, 409 busy and 404 pass through as they are', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    for (const answer of [{ status: 502, body: { error: 'tmux_failed', message: 'x' } }, { status: 409, body: { error: 'busy', message: 'y' } }, { status: 404, body: { error: 'not_found', message: 'pane not found' } }, { status: 503, body: { error: 'tmux_unavailable', message: 'z' } }]) {
      fit.answers.hold = answer;
      fit.answers.release = answer;
      a.clock.t += 2000;
      const put = await fitPane(a, '%6', { json: FIT_BODY });
      assert.deepEqual([put.status, put.body], [answer.status, answer.body]);
      const del = await fitPane(a, '%6', { method: 'DELETE' });
      assert.deepEqual([del.status, del.body], [answer.status, answer.body]);
    }
  });

  test('(−) without the secret 403; text/plain 415; GET and POST 405; a body over 4 KB 413 -- the controller is not called', async () => {
    const fit = fakeFit();
    const { a } = await bootScreens({ over: { createFit: fit.factory } });
    assert.equal((await fitPane(a, '%6', { json: FIT_BODY, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await fitPane(a, '%6', { method: 'DELETE', headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await fitPane(a, '%6', { body: JSON.stringify(FIT_BODY), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await fitPane(a, '%6', { method: 'GET' })).status, 405);
    assert.equal((await fitPane(a, '%6', { method: 'POST', json: FIT_BODY })).status, 405);
    assert.equal((await fitPane(a, '%6', { json: { ...FIT_BODY, pad: 'p'.repeat(4097) } })).status, 413);
    assert.deepEqual(fit.calls, []);
  });

  test('(−) the browser tier has no fit route: PUT and DELETE are 404 there, whatever the headers', async () => {
    const server = createServer({ config: fx.config, exec: fakeExec(), token: 'tok', now: () => NOW, version: '0.0.0' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    servers.push(server);
    const port = server.address().port;
    const call = (method) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method, path: '/api/app/pane/%256/fit', headers: { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      q.on('error', reject);
      q.end('{}');
    });
    assert.equal(await call('PUT'), 404);
    assert.equal(await call('DELETE'), 404);
  });

  test('(−) the browser tier never loads fit.js: only api-app.js and appio.js import it, only appio.js imports api-app.js, and cli.js reaches appio.js by a dynamic import', () => {
    const dir = new URL('../src/', import.meta.url);
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js'));
    const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
    const importers = (name) => files.filter((f) => new RegExp(`(from\\s+|import\\()\\s*'(\\./|\\.\\./)${name}\\.js'`).test(read(f)));
    assert.deepEqual(importers('fit'), ['api-app.js', 'appio.js']);
    assert.deepEqual(importers('api-app'), ['appio.js']);
    const cli = read('cli.js');
    assert.doesNotMatch(cli, /^import .* from '\.\/appio\.js'/m);
    assert.match(cli, /await import\('\.\/appio\.js'\)/);
    assert.deepEqual(importers('appio'), ['cli.js']);
    assert.doesNotMatch(read('spawn.js'), /^import .*fit\.js/m, 'spawn.js (loaded by the CLI) takes the controller from ctx and imports nothing of it');
  });

  test('(−) nothing of the body reaches a log line, on success and on an internal error', async () => {
    const lines = [];
    const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    for (const name of Object.keys(saved)) console[name] = (...args) => { lines.push(args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
    try {
      for (const answers of [{}, { hold: () => { throw new Error('boom'); } }]) {
        const fit = fakeFit(answers);
        const { a } = await bootScreens({ over: { createFit: fit.factory } });
        await fitPane(a, '%6', { json: { cols: 321, rows: 77, open: true } });
      }
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(lines.some((l) => /PUT .*fit failed/.test(l)), 'the internal error was logged (so the check is real)');
    assert.deepEqual(lines.filter((l) => /\bcols\b|\brows\b|"open"|321|\b77\b/.test(l.split('\n')[0])), []);
  });
});

// --- scroll (0.5, W3, ADR 0018): POST /api/app/pane/:id/scroll ---------------------------------------------------------------

/** A scroll factory that records what the router builds it with (`opts`) and what the route calls; `answer` (a value or a function) replaces the result. */
function fakeScroller(answer) {
  const f = { calls: [], opts: null, answer };
  f.factory = (opts) => {
    f.opts = opts;
    return {
      scroll: async (id, body) => {
        f.calls.push([id, body]);
        return typeof f.answer === 'function' ? f.answer(id, body) : f.answer ?? { status: 200, body: { sent: body.pages ?? 1, scrolled: true } };
      },
    };
  };
  return f;
}
const scrollPane = (a, id, opts = {}) => pane(a, id, 'scroll', { method: 'POST', ...opts });
const SCROLL_UP3 = { dir: 'up', pages: 3 };
const keyCalls = (a) => a.deps.calls.filter((c) => c[0] === 'keys').map((c) => c[2]);

describe('POST /api/app/pane/:id/scroll', () => {
  /** A router with the REAL session and scroll controllers over a mirror that shows a plain input box in Claude's full-screen view. `seen` lists every capture { pane, fresh }; `hold()` stops the next captures until `open()`. */
  async function liveRouter(over = {}) {
    const { a, mirror } = await bootScreens({ fake: false, over });
    const seen = [];
    const gate = { wait: null, hit: null };
    const shot = () => ({ status: 200, body: { ...boxRows({ cols: 80, lines: [''] }), alt: true, scrolled: true, etag: 'e' }, etag: 'e' });
    mirror.capture = async (pane, inm, o) => {
      seen.push({ pane, fresh: o?.fresh === true });
      gate.hit?.();
      if (gate.wait) await gate.wait;
      return shot();
    };
    const hold = () => {
      let open;
      gate.wait = new Promise((r) => { open = r; });
      const entered = new Promise((r) => { gate.hit = r; });
      return { entered, open };
    };
    return { a, seen, hold };
  }

  test('(+) the route hands the pane id and exactly the body to the controller and relays its status, body and no-store; every shape of the body passes', async () => {
    const sc = fakeScroller();
    const { a } = await bootScreens({ over: { createScroll: sc.factory } });
    const r = await scrollPane(a, '%6', { json: SCROLL_UP3 });
    assert.deepEqual([r.status, r.body], [200, { sent: 3, scrolled: true }]);
    assert.equal(r.headers['cache-control'], 'no-store');
    for (const json of [{ dir: 'down', pages: 1 }, { dir: 'up', pages: 8 }, { to: 'top' }, { to: 'bottom' }]) assert.equal((await scrollPane(a, '%6', { json })).status, 200, JSON.stringify(json));
    assert.deepEqual(sc.calls, [['%6', SCROLL_UP3], ['%6', { dir: 'down', pages: 1 }], ['%6', { dir: 'up', pages: 8 }], ['%6', { to: 'top' }], ['%6', { to: 'bottom' }]]);
    sc.answer = { status: 409, body: { error: 'prompt-open', message: 'x' } };
    const refused = await scrollPane(a, '%6', { json: SCROLL_UP3 });
    assert.deepEqual([refused.status, refused.body.error], [409, 'prompt-open'], 'a refusal passes through');
    sc.answer = { status: 200, body: { sent: 1, scrolled: null } };
    assert.deepEqual((await scrollPane(a, '%6', { json: { to: 'bottom' } })).body, { sent: 1, scrolled: null });
  });

  test('(+) a started pane is eligible, like for any control', async () => {
    const sc = fakeScroller();
    const { a } = await bootScreens({ over: { createScroll: sc.factory } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    assert.equal((await scrollPane(a, '%8', { json: SCROLL_UP3 })).status, 200);
    assert.deepEqual(sc.calls, [['%8', SCROLL_UP3]]);
  });

  test('(+) the router builds the controller with the mirror, the keys, the session controller\'s pane lock and keyGap, and the router\'s clock; building it touches nothing', async () => {
    const sc = fakeScroller();
    const control = fakeControl();
    const lock = async (id, fn) => fn();
    const gap = () => false;
    const { a } = await bootScreens({ fake: false, over: { createScroll: sc.factory, createSessionControl: (o) => ({ ...control.factory(o), withPaneLock: lock, keyGap: gap }) } });
    assert.equal(sc.opts.mirror, a.deps.mirror);
    assert.equal(sc.opts.keys, a.deps.keys);
    assert.equal(sc.opts.lock, lock);
    assert.equal(sc.opts.keyGap, gap);
    a.clock.t = 4242;
    assert.equal(sc.opts.now(), 4242, 'the controller reads the same clock as the router');
    assert.deepEqual(keyCalls(a), []);
  });

  test('(−) Stop, then a scroll before its Escape is 40 ms old, is 409 busy-switching: nothing is captured or sent; once the gap has passed it goes (the real controllers share keyGap)', async () => {
    const busy = { groups: [{ agents: [{ live: true, state: 'busy', pane: { id: '%6' } }] }] };
    const { a, seen } = await liveRouter({ collect: async () => busy });
    const stopped = await pane(a, '%6', 'stop', { method: 'POST', json: {} });
    assert.deepEqual([stopped.status, stopped.body], [200, { stopped: true, presses: 1 }]);
    const captures = seen.length;
    const early = await scrollPane(a, '%6', { json: SCROLL_UP3 });
    assert.deepEqual([early.status, early.body.error], [409, 'busy-switching']);
    assert.deepEqual([seen.length, keyCalls(a)], [captures, [{ keys: ['Escape'] }]], 'the Escape is the only key, and the refused scroll captured nothing');
    a.clock.t += 41;
    assert.equal((await scrollPane(a, '%6', { json: SCROLL_UP3 })).status, 200);
    assert.deepEqual(keyCalls(a), [{ keys: ['Escape'] }, { keys: ['PPage', 'PPage', 'PPage'] }]);
  });

  test('(+) end to end with the real controllers: up 3 is one keys.send of PPage x 3 after a fresh capture, and the answer says where Claude\'s view is; bottom is C-End', async () => {
    const { a, seen } = await liveRouter();
    const r = await scrollPane(a, '%6', { json: SCROLL_UP3 });
    assert.deepEqual([r.status, r.body], [200, { sent: 3, scrolled: true }]);
    assert.deepEqual(keyCalls(a), [{ keys: ['PPage', 'PPage', 'PPage'] }]);
    assert.deepEqual(seen, [{ pane: '%6', fresh: true }, { pane: '%6', fresh: true }], 'one fresh capture before the keys, one after');
    a.clock.t += 1500;
    assert.equal((await scrollPane(a, '%6', { json: { to: 'bottom' } })).status, 200);
    assert.deepEqual(keyCalls(a).at(-1), { keys: ['C-End'] });
    assert.equal(keyCalls(a).length, 2);
  });

  test('(+) the capture body carries alt and scrolled from the mirror, and its ETag changes when only alt flips (the real mirror over a scripted tmux)', async () => {
    const pill = `${'\u001b'}[38;5;231m${'\u001b'}[48;5;237m Jump to bottom: fn+↓ to scroll ${'\u001b'}[39m${'\u001b'}[49m\n`;
    const view = { alt: '1' };
    const exec = async (cmd, args) => (args.includes('display-message')
      ? { stdout: `80\t24\t0\t0\t1\t${view.alt}\n`, stderr: '' }
      : { stdout: `older output\n${pill}input\n`, stderr: '' });
    const clock = { t: 1_000_000 };
    const mirror = createMirror({ exec, now: () => clock.t });
    const a = await boot({ deps: makeDeps({ mirror }) });
    const on = await pane(a, '%6', 'capture');
    assert.deepEqual([on.status, on.body.alt, on.body.scrolled], [200, true, true]);
    view.alt = '0';
    clock.t += 1000;
    const off = await pane(a, '%6', 'capture', { headers: { 'if-none-match': on.headers.etag } });
    assert.equal(off.status, 200, 'only alt changed: not a 304');
    assert.deepEqual([off.body.alt, off.body.scrolled], [false, false], 'no scrolled without the alternate screen');
    assert.notEqual(off.body.etag, on.body.etag);
  });

  test('(+) scrolled is true for the pill after text on the same row and for the new-message pills (live shapes, Claude Code 2.1.325); false for the divider rule (the real mirror over a scripted tmux)', async () => {
    const esc = '\u001b';
    const pillAfter = (left, words) => `${left}${esc}[38;5;231m${esc}[48;5;237m ${words} ${esc}[39m${esc}[49m\n`;
    const rule = (words) => `${esc}[38;5;246m${'─'.repeat(52)} ${words} ${'─'.repeat(52)}${esc}[39m\n`;
    const view = { screen: '' };
    const exec = async (cmd, args) => (args.includes('display-message')
      ? { stdout: '120\t40\t0\t0\t1\t1\n', stderr: '' }
      : { stdout: view.screen, stderr: '' });
    const clock = { t: 1_000_000 };
    const a = await boot({ deps: makeDeps({ mirror: createMirror({ exec, now: () => clock.t }) }) });
    for (const [screen, want] of [
      [`  150\n${pillAfter(`  151${' '.repeat(40)}`, 'Jump to bottom: fn+↓ to scroll')}input\n`, true],
      [`  12\n${pillAfter(`  13${' '.repeat(41)}`, '1 new message: fn+↓ to scroll')}input\n`, true],
      [`  12\n${pillAfter(' '.repeat(44), '2 new messages: fn+↓ to scroll')}input\n`, true],
      [`${rule('1 new message')}  12\n  13\ninput\n`, false],
    ]) {
      view.screen = screen;
      clock.t += 1000;
      const r = await pane(a, '%6', 'capture');
      assert.deepEqual([r.status, r.body.alt, r.body.scrolled], [200, true, want], screen.split('\n').find((l) => /message|bottom/.test(l)).replace(/\u001b\[[0-9;]*m/g, ''));
    }
  });

  test('(−) 400 before 404 before 429: a bad body is 400 on any pane and on a full bucket, an ineligible pane is 404 and takes no rate slot, then the 11th good request is 429', async () => {
    const sc = fakeScroller();
    const { a } = await bootScreens({ over: { createScroll: sc.factory } });
    const bad = [{}, { dir: 'up' }, { pages: 3 }, { dir: 'up', pages: 0 }, { dir: 'up', pages: 9 }, { dir: 'up', pages: 1.5 }, { dir: 'up', pages: '3' }, { dir: 'left', pages: 1 }, { to: 'middle' },
      { to: 'top', dir: 'up' }, { to: 'top', pages: 1 }, { dir: 'up', pages: 3, keys: ['PPage'] }, { to: 'bottom', text: 'x' }, { dir: 'PPage', pages: 1 }, { to: 'C-End' }];
    for (const json of bad) {
      for (const id of ['%6', '%5', '%99']) {
        const r = await scrollPane(a, id, { json });
        assert.deepEqual([r.status, r.body.error], [400, 'invalid'], `${JSON.stringify(json)} on ${id}`);
        assert.equal(r.body.message, 'body must be { dir: up|down, pages: 1-8 } or { to: top|bottom }');
      }
    }
    assert.equal((await scrollPane(a, '%6', { body: '[]', headers: { 'content-type': 'application/json' } })).body.error, 'invalid');
    assert.deepEqual(sc.calls, [], 'a bad body reaches no controller');
    for (let i = 0; i < 15; i += 1) for (const id of ['%5', '%7', '%8', '%99', 'abc', '..']) assert.equal((await scrollPane(a, id, { json: SCROLL_UP3 })).status, 404, id);
    assert.deepEqual(sc.calls, [], 'an ineligible pane reaches no controller either');
  });

  test('(−) the 11th scroll request on one pane within a second is 429 busy: nothing is captured or sent for it; another pane is served; a second later it is served again (real controllers)', async () => {
    const { a, seen } = await liveRouter();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent', mode: 'plan' });
    for (let i = 0; i < 10; i += 1) assert.equal((await scrollPane(a, '%6', { json: SCROLL_UP3 })).status, 200, `request ${i + 1}`);
    const captures = seen.length;
    const sent = keyCalls(a).length;
    const eleventh = await scrollPane(a, '%6', { json: SCROLL_UP3 });
    assert.deepEqual([eleventh.status, eleventh.body.error], [429, 'busy']);
    assert.match(eleventh.body.message, /at most 10 scroll requests per second per pane/);
    assert.deepEqual([seen.length, keyCalls(a).length], [captures, sent], 'the refused request captured and sent nothing');
    assert.equal((await scrollPane(a, '%8', { json: SCROLL_UP3 })).status, 200, 'another pane has its own count');
    a.clock.t += 1001;
    assert.equal((await scrollPane(a, '%6', { json: SCROLL_UP3 })).status, 200);
  });

  test('(−) a shell pane, an ended agent, a pane that is not claude and an unknown or malformed id are 404: nothing is captured or sent (real controllers)', async () => {
    const { a, seen } = await liveRouter();
    for (const id of ['%5', '%7', '%8', '%99', 'abc', '..']) {
      const r = await scrollPane(a, id, { json: SCROLL_UP3 });
      assert.deepEqual([r.status, r.body.error], [404, 'not_found'], id);
    }
    assert.deepEqual([seen.length, keyCalls(a).length], [0, 0]);
    await leaveAndReturn(a, '%6'); // a pane that dropped out of the tmux list is 404 as well, and comes back
    assert.deepEqual([seen.length, keyCalls(a).length], [0, 0]);
    assert.equal((await scrollPane(a, '%6', { json: SCROLL_UP3 })).status, 200);
  });

  test('(−) the guard of every /api/app route holds: no secret or a wrong one 403, a wrong Origin 403, text/plain 415, GET 405, a body over 4 KB 413; no controller is reached', async () => {
    const sc = fakeScroller();
    const { a } = await bootScreens({ over: { createScroll: sc.factory } });
    assert.equal((await scrollPane(a, '%6', { json: SCROLL_UP3, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await scrollPane(a, '%6', { json: SCROLL_UP3, headers: { 'x-nika-app': WRONG_SAME_LENGTH } })).status, 403);
    assert.equal((await scrollPane(a, '%6', { json: SCROLL_UP3, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await scrollPane(a, '%6', { body: JSON.stringify(SCROLL_UP3), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await scrollPane(a, '%6', { method: 'GET' })).status, 405);
    assert.equal((await scrollPane(a, '%6', { json: { ...SCROLL_UP3, pad: 'p'.repeat(4097) } })).status, 413);
    assert.deepEqual(sc.calls, []);
  });

  test('(+) a scroll waits for a running End on the same pane (one lock), then goes: PPage x 3 is sent after End finished', async () => {
    const { a, hold } = await liveRouter();
    const stop = hold();
    const end = pane(a, '%6', 'end', { method: 'POST', json: {} });
    await stop.entered;
    let answered = false;
    const scroll = scrollPane(a, '%6', { json: SCROLL_UP3 }).then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 120)); // several polls of the waiting lock
    assert.equal(answered, false, 'the scroll waits while End holds the pane');
    assert.deepEqual(keyCalls(a).filter((b) => b.keys?.includes('PPage')), [], 'no scroll key went out yet');
    stop.open();
    await end;
    const r = await scroll;
    assert.deepEqual([r.status, r.body.sent], [200, 3]);
    assert.deepEqual(keyCalls(a).at(-1), { keys: ['PPage', 'PPage', 'PPage'] }, 'the scroll keys went out last, after End was done');
  });

  test('(−) while a scroll holds the pane, End, a mode switch, a command and a draft write answer 409 busy-switching and type nothing; then the scroll finishes', async () => {
    const { a, hold } = await liveRouter();
    const stop = hold();
    const scroll = scrollPane(a, '%6', { json: SCROLL_UP3 });
    await stop.entered;
    const typed = keyCalls(a).length;
    assert.equal((await pane(a, '%6', 'end', { method: 'POST', json: {} })).body.error, 'busy-switching');
    assert.equal((await pane(a, '%6', 'mode', { method: 'POST', json: { target: 'plan' } })).body.error, 'busy-switching');
    assert.equal((await pane(a, '%6', 'command', { method: 'POST', json: { text: '/compact' } })).body.error, 'busy-switching');
    const draft = await pane(a, '%6', 'draft', { method: 'PUT', json: { text: 'hi', base: '' } });
    assert.deepEqual([draft.status, draft.body.error], [409, 'busy-switching']);
    assert.equal(keyCalls(a).length, typed, 'nothing was typed');
    stop.open();
    assert.equal((await scroll).status, 200);
    assert.deepEqual(keyCalls(a), [{ keys: ['PPage', 'PPage', 'PPage'] }]);
  });

  test('(−) a screen that is not a plain input box in Claude\'s full-screen view is a 409 and no key goes (alt off, a permission prompt, a dialog footer, a slash menu)', async () => {
    const { a, mirror } = await bootScreens({ fake: false });
    const shot = (body) => ({ status: 200, body: { cols: 80, cursor: { x: 0, y: 0, visible: true }, alt: true, scrolled: false, ...body, etag: 'e' }, etag: 'e' });
    const screens = {
      'no-view': shot({ ...boxRows({ cols: 80, lines: [''] }), alt: false }),
      'prompt-open': shot({ rows: rowsOf(PROMPT), cursor: null }),
      'screen-unclear': shot({ ...boxRows({ cols: 80, lines: ['hello'], footer: 'Enter to select · ↑/↓ to navigate · Esc to cancel' }) }),
      'menu-open': shot({ ...boxRows({ cols: 80, lines: ['/com'] }) }),
    };
    for (const [code, view] of Object.entries(screens)) {
      mirror.capture = async () => view;
      a.clock.t += 1500;
      const r = await scrollPane(a, '%6', { json: SCROLL_UP3 });
      assert.deepEqual([r.status, r.body.error], [409, code]);
    }
    assert.deepEqual(keyCalls(a), []);
  });

  test('(−) the browser tier has no scroll route: POST is 404 there, whatever the headers', async () => {
    const server = createServer({ config: fx.config, exec: fakeExec(), token: 'tok', now: () => NOW, version: '0.0.0' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    servers.push(server);
    const port = server.address().port;
    const status = await new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/app/pane/%256/scroll', headers: { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      q.on('error', reject);
      q.end('{}');
    });
    assert.equal(status, 404);
  });

  test('(−) the browser tier never loads scroll.js: only api-app.js imports it (and only appio.js imports api-app.js, which cli.js reaches by a dynamic import)', () => {
    const dir = new URL('../src/', import.meta.url);
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js'));
    const importers = files.filter((f) => /(from\s+|import\()\s*'(\.\/|\.\.\/)scroll\.js'/.test(fs.readFileSync(new URL(f, dir), 'utf8')));
    assert.deepEqual(importers, ['api-app.js']);
  });

  test('(−) nothing of the body reaches a log line, on success and on an internal error', async () => {
    const lines = [];
    const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    for (const name of Object.keys(saved)) console[name] = (...args) => { lines.push(args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
    try {
      for (const answer of [undefined, () => { throw new Error('boom'); }]) {
        const sc = fakeScroller(answer);
        const { a } = await bootScreens({ over: { createScroll: sc.factory } });
        await scrollPane(a, '%6', { json: { dir: 'up', pages: 7 } });
      }
      // and the real controller, whose capture fails with an error
      const real = await liveRouter();
      real.a.deps.mirror.capture = async () => { throw new Error('boom'); };
      await scrollPane(real.a, '%6', { json: { dir: 'down', pages: 5 } });
    } finally {
      Object.assign(console, saved);
    }
    assert.ok(lines.some((l) => /POST .*scroll failed/.test(l)), 'the internal error was logged (so the check is real)');
    assert.deepEqual(lines.filter((l) => /\bdir\b|\bpages\b|"up"|"down"|\b7\b|\b5\b/.test(l.split('\n')[0])), []);
  });
});

// --- attachments (0.5, W2, ADR 0016): upload, delete, send ---

const ATT = '0123456789abcdef'; // a synthetic attachment id
const ATT2 = 'fedcba9876543210';
const BASE16 = 'aaaaaaaaaaaaaaaa';
const UPLOAD = { name: 'shot.png', data: Buffer.from('synthetic-bytes').toString('base64') };
const GROUP_KEY = 'b1b2b3b4b5b6b7b8'; // a project key for a snapshot group (any 16 chars of [a-z0-9])

/** A store that records its calls; `over` replaces a method (a function, or a value to return / an Error to throw). */
function fakeStore(over = {}) {
  const f = { calls: [] };
  const method = (name, fallback) => async (...args) => {
    f.calls.push([name, ...args]);
    const given = over[name];
    if (given instanceof Error) throw given;
    return typeof given === 'function' ? given(...args) : given !== undefined ? given : fallback(...args);
  };
  f.save = method('save', () => ({ status: 200, body: { id: ATT, type: 'png', size: 15 } }));
  f.remove = method('remove', () => true);
  f.lookup = method('lookup', () => null);
  f.markSent = (...args) => { f.calls.push(['markSent', ...args]); };
  return f;
}

/** A send factory that records what the router builds it with and what the route calls. */
function fakeSender(answer) {
  const f = { calls: [], opts: null };
  f.factory = (opts) => {
    f.opts = opts;
    return { send: async (pane, body) => { f.calls.push([pane, body]); return typeof answer === 'function' ? answer(pane, body) : answer ?? { status: 200, body: { sent: 1, images: 0 } }; } };
  };
  return f;
}

/** Snapshot whose group carries a project key: panes `claims` (pane ids) each have one live agent in it. */
const keyedSnapshot = (...claims) => ({ groups: [{ key: GROUP_KEY, agents: claims.map((id) => ({ live: true, state: 'idle', pane: { id } })) }] });
const att = (a, id, suffix, opts) => pane(a, id, suffix, opts);
const capturingLog = async (fn) => {
  const lines = [];
  const saved = { error: console.error, log: console.log, warn: console.warn, info: console.info, write: process.stderr.write };
  for (const name of ['error', 'log', 'warn', 'info']) console[name] = (...args) => { lines.push(args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' ')); };
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
    process.stderr.write = saved.write;
  }
  return lines;
};

describe('attachments: upload', () => {
  test('(+) the store gets the pane, the key of the group that claims it, and the name and data; its answer goes to the page as is', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    const r = await att(a, '%6', 'attachments', { method: 'POST', json: UPLOAD });
    assert.deepEqual([r.status, r.body], [200, { id: ATT, type: 'png', size: 15 }]);
    assert.deepEqual(store.calls, [['save', { pane: '%6', key: GROUP_KEY, name: UPLOAD.name, data: UPLOAD.data }]]);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('(+) a pane nika started has its start key; the store answer 4xx of its own (wrong-type, too-big, rate) goes through', async () => {
    const store = fakeStore({ save: () => ({ status: 415, body: { error: 'wrong-type', message: 'x' } }) });
    const { a } = await bootScreens({ over: { attachments: store } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    const r = await att(a, '%8', 'attachments', { method: 'POST', json: UPLOAD });
    assert.deepEqual([r.status, r.body.error], [415, 'wrong-type']);
    assert.equal(store.calls[0][1].key, w.project.key);
    assert.equal(store.calls[0][1].pane, '%8');
  });

  test('(−) the key is never the request\'s: a body with a key, a path or an extra field is 400 and the store is not called', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    for (const json of [{ ...UPLOAD, key: 'ffffffffffffffff' }, { ...UPLOAD, path: '/etc/passwd' }, { name: 'x' }, { data: UPLOAD.data }, { name: 5, data: UPLOAD.data }, { name: 'x', data: 'not base64!' }, { name: 'x', data: 'abc' }, { name: 'n'.repeat(256), data: UPLOAD.data }]) {
      const r = await att(a, '%6', 'attachments', { method: 'POST', json });
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(json).slice(0, 60));
    }
    for (const body of ['[]', 'null', '"x"', '{bad', '']) {
      assert.equal((await att(a, '%6', 'attachments', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 400, body);
    }
    assert.deepEqual(store.calls, []);
  });

  test('(−) M4: a body named .env, .env.*, *.key or *.pem is 400 secret-file before the pane is looked at; the store is not called, and an ordinary name still goes', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    for (const name of ['.env', '.ENV.dev', 'prod.key', 'CERT.PEM', 'dir/.env']) {
      for (const id of ['%6', '%99']) { // an unknown pane too: the body comes first
        const r = await att(a, id, 'attachments', { method: 'POST', json: { name, data: UPLOAD.data } });
        assert.deepEqual([r.status, r.body.error], [400, 'secret-file'], `${name} ${id}`);
      }
    }
    assert.deepEqual(store.calls, []);
    assert.equal((await att(a, '%6', 'attachments', { method: 'POST', json: { name: 'notes.txt', data: UPLOAD.data } })).status, 200);
    assert.equal(store.calls.length, 1);
  });

  test('(−) F3: a body named .envrc, *.p12, *.pfx, *.jks, *.keystore or an SSH private key (any case, path in front) is 400 secret-file before the pane is looked at; the store is not called', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    for (const name of ['.envrc', '.ENVRC', '.envrc.dev', '.ENVRC.BAK', '/x/y/.envrc.dev', '.envrc.', 'cert.p12', 'CERT.PFX', 'store.jks', 'App.KeyStore', 'id_rsa', 'ID_RSA', '/x/y/ID_RSA', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'Id_Ecdsa_Sk', 'id_ed25519_sk']) {
      for (const id of ['%6', '%99']) {
        const r = await att(a, id, 'attachments', { method: 'POST', json: { name, data: UPLOAD.data } });
        assert.deepEqual([r.status, r.body.error], [400, 'secret-file'], `${name} ${id}`);
      }
    }
    assert.deepEqual(store.calls, []);
  });

  test('(+) F3: a public key and the look-alikes of the new kinds still go to the store', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    const names = ['id_rsa.pub', 'id_ed25519.pub', 'id_rsa_backup.txt', 'my.keystore.md', 'notes.envrc.txt', 'p12.txt', 'envrc.dev', '.envrcx'];
    for (const name of names) assert.equal((await att(a, '%6', 'attachments', { method: 'POST', json: { name, data: UPLOAD.data } })).status, 200, name);
    assert.equal(store.calls.length, names.length);
  });

  test('(−) the body is checked before the pane: a bad body to an unknown pane is 400, a good body to it is 404; the store is not called', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    assert.equal((await att(a, '%99', 'attachments', { method: 'POST', json: { name: 'x' } })).status, 400);
    assert.equal((await att(a, '%99', 'attachments', { method: 'POST', json: UPLOAD })).status, 404);
    assert.deepEqual(store.calls, []);
  });

  test('(−) a pane that is not in the tmux list, runs a shell, is not live Claude or was not started is 404; the store is not called', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6', '%5') } });
    for (const id of ['%5', '%8', '%99']) assert.equal((await att(a, id, 'attachments', { method: 'POST', json: UPLOAD })).status, 404, id); // %5 = zsh, %8 = node not claimed, %99 = no pane
    assert.equal((await a.call('POST', '/api/app/pane/abc/attachments', { json: UPLOAD })).status, 404);
    assert.deepEqual(store.calls, []);
  });

  test('(−) no-project: two live agents claim the pane, no group names it, or the key is not a project key; 409 and the store is not called', async () => {
    const store = fakeStore();
    const twice = { groups: [{ key: GROUP_KEY, agents: [{ live: true, state: 'idle', pane: { id: '%6' } }] }, { key: 'c1c2c3c4c5c6c7c8', agents: [{ live: true, state: 'idle', pane: { id: '%6' } }] }] };
    for (const snapshot of [twice, { groups: [{ key: 'BAD KEY', agents: [{ live: true, state: 'idle', pane: { id: '%6' } }] }] }, { groups: [{ agents: [{ live: true, state: 'idle', pane: { id: '%6' } }] }] }]) {
      const { a } = await bootScreens({ over: { attachments: store, collect: async () => snapshot } });
      const r = await att(a, '%6', 'attachments', { method: 'POST', json: UPLOAD });
      assert.deepEqual([r.status, r.body.error], [409, 'no-project'], JSON.stringify(snapshot).slice(0, 80));
    }
    const { a } = await bootScreens({ over: { attachments: store } }); // a started pane whose entry carries a key that is not a project key
    a.ctx.started.set('%8', { key: 'not a key', name: 'x', sessionId: null, role: 'agent' });
    assert.deepEqual([(await att(a, '%8', 'attachments', { method: 'POST', json: UPLOAD })).body.error], ['no-project']);
    assert.deepEqual(store.calls, []);
  });

  test('(−) a body over 12 MiB is 413, one just under it reaches the store; text/plain is 415; GET and PUT are 405; no secret is 403', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    assert.equal((await att(a, '%6', 'attachments', { method: 'POST', json: { name: 'x', data: 'A'.repeat(12 * 1024 * 1024) } })).status, 413);
    assert.equal(store.calls.length, 0);
    assert.equal((await att(a, '%6', 'attachments', { method: 'POST', json: { name: 'x', data: 'A'.repeat(11 * 1024 * 1024) } })).status, 200);
    assert.equal((await att(a, '%6', 'attachments', { method: 'POST', body: JSON.stringify(UPLOAD), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await att(a, '%6', 'attachments', { method: 'GET' })).status, 405);
    assert.equal((await att(a, '%6', 'attachments', { method: 'PUT', json: UPLOAD })).status, 405);
    assert.equal((await att(a, '%6', 'attachments', { method: 'POST', json: UPLOAD, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal(store.calls.length, 1, 'only the 11 MiB body got through');
  });

  test('(−) a store that throws is 500 write-failed; the log has the node code only, and neither the answer nor the log carries the name, the data, a path or an id', async () => {
    const boom = Object.assign(new Error('EACCES /srv/nika/attachments/secret-name.png'), { code: 'EACCES' });
    const store = fakeStore({ save: boom });
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6') } });
    let r;
    const lines = await capturingLog(async () => { r = await att(a, '%6', 'attachments', { method: 'POST', json: { name: 'secret-name.png', data: UPLOAD.data } }); });
    assert.deepEqual([r.status, r.body.error], [500, 'write-failed']);
    assert.equal(/secret-name|srv|EACCES/.test(r.raw), false);
    assert.deepEqual(lines, ['nika: attachments: EACCES\n']);
  });
});

// The paperclip's own file chooser (W2-T6): the page asks for a native dialog and polls for what the user picked. The server owns the reads.
const PICK = 'attachments/pick';
const FILES_DONE = [
  { ok: true, id: ATT, name: 'shot.png', size: 15, type: 'png' },
  { ok: false, name: 'big.bin', error: 'too_large' },
];

/** A picker whose files half records what it is given; `files` = reqId -> { pane, answer } for the status route. */
function fakePicker(over = {}) {
  const f = { starts: [], reqs: new Map(), calls: [] };
  f.start = () => null;
  f.status = () => null;
  f.startFiles = (arg) => {
    f.starts.push(arg);
    if (over.busy) return null;
    const id = over.reqId ?? REQ_ID;
    f.reqs.set(id, { pane: arg.pane, answer: over.answer ?? { state: 'pending' } });
    return id;
  };
  f.filesStatus = (pane, reqId) => {
    f.calls.push([pane, reqId]);
    const r = f.reqs.get(reqId);
    return r && r.pane === pane ? r.answer : null;
  };
  return f;
}

describe('attachments: the file chooser (POST pick)', () => {
  test('(+) a room of 1 to 6 starts a request for the pane and the key of the group that claims it; 202 with the id, nothing else', async () => {
    for (const room of [1, 2, 3, 4, 5, 6]) {
      const picker = fakePicker();
      const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6') } });
      const r = await att(a, '%6', PICK, { method: 'POST', json: { room } });
      assert.deepEqual([r.status, r.body], [202, { reqId: REQ_ID }], String(room));
      assert.deepEqual(picker.starts, [{ pane: '%6', key: GROUP_KEY, room }]);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test('(+) a pane nika started has its start key', async () => {
    const picker = fakePicker();
    const { a } = await bootScreens({ over: { picker } });
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    const r = await att(a, '%8', PICK, { method: 'POST', json: { room: 3 } });
    assert.equal(r.status, 202);
    assert.deepEqual(picker.starts, [{ pane: '%8', key: w.project.key, room: 3 }]);
  });

  test('(−) the body is exactly { room } with room an integer 1 to 6: anything else is 400 invalid and no chooser starts', async () => {
    const picker = fakePicker();
    const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6') } });
    const bad = [{}, { room: 0 }, { room: 7 }, { room: -1 }, { room: 1.5 }, { room: '3' }, { room: null }, { room: [3] }, { room: true }, { room: NaN },
      { room: 1, key: GROUP_KEY }, { room: 1, path: '/etc/passwd' }, { room: 1, pane: '%7' }, { ROOM: 1 }, { rooms: 1 }, { room: 1, extra: 0 }];
    for (const json of bad) {
      const r = await att(a, '%6', PICK, { method: 'POST', json });
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(json));
    }
    for (const body of ['[]', 'null', '"x"', '{bad', '', '{"room":1,"room":2,"x":1}']) {
      const r = await att(a, '%6', PICK, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 400, body);
    }
    assert.equal((await att(a, '%6', PICK, { method: 'POST', body: '{"room":1}', headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.deepEqual(picker.starts, []);
  });

  test('(−) a body over 4 KB is 413 and no chooser starts', async () => {
    const picker = fakePicker();
    const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6') } });
    assert.equal((await att(a, '%6', PICK, { method: 'POST', json: { room: 1, pad: 'x'.repeat(5000) } })).status, 413);
    assert.deepEqual(picker.starts, []);
  });

  test('(−) the body is checked before the pane: a bad body to an unknown pane is 400, a good body to it is 404', async () => {
    const picker = fakePicker();
    const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6') } });
    assert.equal((await att(a, '%99', PICK, { method: 'POST', json: {} })).status, 400);
    assert.equal((await att(a, '%99', PICK, { method: 'POST', json: { room: 1 } })).status, 404);
    assert.deepEqual(picker.starts, []);
  });

  test('(−) a pane that is not in the tmux list, runs a shell, is not live Claude or was not started is 404; no chooser starts', async () => {
    const picker = fakePicker();
    const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6', '%5') } });
    for (const id of ['%5', '%8', '%99']) assert.equal((await att(a, id, PICK, { method: 'POST', json: { room: 1 } })).status, 404, id);
    assert.equal((await a.call('POST', '/api/app/pane/abc/attachments/pick', { json: { room: 1 } })).status, 404);
    assert.deepEqual(picker.starts, []);
  });

  test('(−) no-project: two live agents claim the pane, or no group names it: 409 and no chooser starts', async () => {
    const picker = fakePicker();
    const twice = { groups: [{ key: GROUP_KEY, agents: [{ live: true, state: 'idle', pane: { id: '%6' } }] }, { key: 'c1c2c3c4c5c6c7c8', agents: [{ live: true, state: 'idle', pane: { id: '%6' } }] }] };
    for (const snapshot of [twice, { groups: [{ key: 'BAD KEY', agents: [{ live: true, state: 'idle', pane: { id: '%6' } }] }] }]) {
      const { a } = await bootScreens({ over: { picker, collect: async () => snapshot } });
      const r = await att(a, '%6', PICK, { method: 'POST', json: { room: 1 } });
      assert.deepEqual([r.status, r.body.error], [409, 'no-project']);
    }
    assert.deepEqual(picker.starts, []);
  });

  test('(−) 429 busy while any chooser (a folder or files) is open', async () => {
    const picker = fakePicker({ busy: true });
    const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6') } });
    const r = await att(a, '%6', PICK, { method: 'POST', json: { room: 2 } });
    assert.deepEqual([r.status, r.body.error], [429, 'busy']);
    assert.equal(picker.starts.length, 1, 'the picker was asked, and it said busy');
  });

  test('(−) GET and PUT on the start route are 405; no secret is 403', async () => {
    const picker = fakePicker();
    const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6') } });
    assert.equal((await att(a, '%6', PICK, { method: 'GET' })).status, 405);
    assert.equal((await att(a, '%6', PICK, { method: 'PUT', json: { room: 1 } })).status, 405);
    assert.equal((await att(a, '%6', PICK, { method: 'POST', json: { room: 1 }, headers: { 'x-nika-app': null } })).status, 403);
    assert.deepEqual(picker.starts, []);
  });
});

describe('attachments: the file chooser (GET pick/:reqId)', () => {
  const get = (a, id, reqId, opts) => att(a, id, `${PICK}/${reqId}`, opts);

  test('(+) pending, cancelled and done (with the files) as the picker says; done carries ids, names, sizes, types and error codes, no path', async () => {
    const answers = [{ state: 'pending' }, { state: 'cancelled' }, { state: 'done', files: FILES_DONE }];
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
    const picker = fakePicker();
    ids.forEach((id, i) => picker.reqs.set(id, { pane: '%6', answer: answers[i] }));
    const { a } = await bootScreens({ over: { picker } });
    for (const [i, id] of ids.entries()) {
      const r = await get(a, '%6', id);
      assert.deepEqual([r.status, r.body], [200, answers[i]], id);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
    const done = (await get(a, '%6', ids[2])).raw;
    assert.equal(/\/|\\/.test(done), false, 'no path separator anywhere in a done answer');
    assert.deepEqual(picker.calls.at(-1), ['%6', ids[2]], 'the picker is asked with the pane of the URL and the id');
  });

  test('(−) an unknown id, a malformed id and an id started for another pane are 404 (the same answer for all three)', async () => {
    const picker = fakePicker();
    picker.reqs.set(REQ_ID, { pane: '%6', answer: { state: 'done', files: FILES_DONE } });
    const { a } = await bootScreens({ over: { picker } });
    const unknown = await get(a, '%6', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    const other = await get(a, '%7', REQ_ID);
    assert.deepEqual([unknown.status, other.status], [404, 404]);
    assert.equal(unknown.raw, other.raw);
    for (const bad of ['not-a-uuid', '..%2F..%2Fetc', '%00', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'.slice(0, 35)]) {
      assert.equal((await get(a, '%6', bad)).status, 404, bad);
    }
    assert.equal((await a.call('GET', `/api/app/pane/abc/attachments/pick/${REQ_ID}`)).status, 404, 'a malformed pane id');
  });

  test('(+) the poll is not eligibility-gated: a pane that left the tmux list after the dialog opened still gets its answer', async () => {
    const picker = fakePicker();
    picker.reqs.set(REQ_ID, { pane: '%6', answer: { state: 'done', files: FILES_DONE } });
    const { a } = await bootScreens({ over: { picker } });
    a.deps.state.panes.delete('%6');
    assert.equal((await get(a, '%6', REQ_ID)).status, 200);
  });

  test('(−) POST, PUT and DELETE are 405 on the status route; no secret is 403', async () => {
    const picker = fakePicker();
    picker.reqs.set(REQ_ID, { pane: '%6', answer: { state: 'pending' } });
    const { a } = await bootScreens({ over: { picker } });
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await get(a, '%6', REQ_ID, { method, ...(method === 'DELETE' ? {} : { json: {} }) })).status, 405, method);
    assert.equal((await get(a, '%6', REQ_ID, { headers: { 'x-nika-app': null } })).status, 403);
  });

  test('(−) the delete route still takes only an attachment id: DELETE .../attachments/pick is 400 invalid, not a chooser', async () => {
    const picker = fakePicker();
    const store = fakeStore();
    const { a } = await bootScreens({ over: { picker, attachments: store } });
    const r = await att(a, '%6', PICK, { method: 'DELETE' });
    assert.deepEqual([r.status, r.body.error], [400, 'invalid']);
    assert.deepEqual(store.calls, []);
  });

  test('(−) the browser tier has neither chooser route: POST and GET are 404 there, whatever the headers', async () => {
    const server = createServer({ config: fx.config, exec: fakeExec(), token: 'tok', now: () => NOW, version: '0.0.0' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    servers.push(server);
    const port = server.address().port;
    const call = (method, p, payload) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, 'content-type': 'application/json', ...(payload ? { 'content-length': String(payload.length) } : {}) } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      q.on('error', reject);
      q.end(payload);
    });
    assert.equal(await call('POST', '/api/app/pane/%256/attachments/pick', '{"room":1}'), 404);
    assert.equal(await call('GET', `/api/app/pane/%256/attachments/pick/${REQ_ID}`), 404);
  });

  test('(−) nothing of a chooser is logged by the routes: no path, name or id on any console or stderr', async () => {
    const picker = fakePicker({ answer: { state: 'done', files: FILES_DONE } });
    const { a } = await bootScreens({ over: { picker, collect: async () => keyedSnapshot('%6') } });
    const lines = await capturingLog(async () => {
      await att(a, '%6', PICK, { method: 'POST', json: { room: 2 } });
      await get(a, '%6', REQ_ID);
      await get(a, '%7', REQ_ID);
    });
    assert.deepEqual(lines, []);
  });
});

describe('attachments: delete', () => {
  test('(+) removes by pane and id: { removed: true }; an unknown, another pane\'s or a sent id is { removed: false } (no oracle)', async () => {
    const store = fakeStore({ remove: (p, id) => p === '%6' && id === ATT });
    const { a } = await bootScreens({ over: { attachments: store } });
    assert.deepEqual((await att(a, '%6', `attachments/${ATT}`, { method: 'DELETE' })).body, { removed: true });
    assert.deepEqual((await att(a, '%6', `attachments/${ATT2}`, { method: 'DELETE' })).body, { removed: false });
    assert.deepEqual((await att(a, '%7', `attachments/${ATT}`, { method: 'DELETE' })).body, { removed: false });
    assert.deepEqual(store.calls.map((c) => c.slice(0, 3)), [['remove', '%6', ATT], ['remove', '%6', ATT2], ['remove', '%7', ATT]]);
  });

  test('(+) not gated by the pane being live Claude: a pane that is gone still gets its file removed', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store } });
    const r = await att(a, '%99', `attachments/${ATT}`, { method: 'DELETE' });
    assert.deepEqual([r.status, r.body], [200, { removed: true }]);
    assert.deepEqual(store.calls, [['remove', '%99', ATT]]);
  });

  test('(−) a bad pane id or attachment id is 400 and the store is not called; POST and GET are 405; no secret is 403', async () => {
    const store = fakeStore();
    const { a } = await bootScreens({ over: { attachments: store } });
    for (const [p, id] of [['%6', 'zz'], ['%6', ATT.toUpperCase().replace(/[0-9]/g, 'A')], ['%6', `${ATT}0`], ['abc', ATT], ['%6;rm', ATT], ['%0x', ATT]]) {
      const r = await a.call('DELETE', `/api/app/pane/${encodeURIComponent(p)}/attachments/${encodeURIComponent(id)}`);
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], `${p} ${id}`);
    }
    assert.equal((await att(a, '%6', `attachments/${ATT}`, { method: 'POST', json: {} })).status, 405);
    assert.equal((await att(a, '%6', `attachments/${ATT}`, { method: 'GET' })).status, 405);
    assert.equal((await att(a, '%6', `attachments/${ATT}`, { method: 'DELETE', headers: { 'x-nika-app': null } })).status, 403);
    assert.deepEqual(store.calls, []);
  });

  test('(−) a store that throws answers { removed: false } with the code logged only', async () => {
    const store = fakeStore({ remove: Object.assign(new Error('EBUSY /srv/nika/attachments/x'), { code: 'EBUSY' }) });
    const { a } = await bootScreens({ over: { attachments: store } });
    let r;
    const lines = await capturingLog(async () => { r = await att(a, '%6', `attachments/${ATT}`, { method: 'DELETE' }); });
    assert.deepEqual([r.status, r.body], [200, { removed: false }]);
    assert.deepEqual(lines, ['nika: attachments: EBUSY\n']);
  });
});

describe('attachments: send', () => {
  const control = fakeControl();
  const lock = async (id, fn) => fn();
  const gap = () => false;
  const overWith = (sender, store = fakeStore(), more = {}) => ({ attachments: store, createAttachSend: sender.factory, createSessionControl: (o) => ({ ...control.factory(o), withPaneLock: lock, keyGap: gap }), ...more });

  test('(+) the router builds the sender with the mirror, the keys, the store, the controller\'s pane lock and keyGap, and the edit-mode readers; (−) no registry reader (W13: it sends while Claude works)', async () => {
    const sender = fakeSender();
    const store = fakeStore();
    const { a } = await bootScreens({ fake: false, over: overWith(sender, store) });
    const o = sender.opts;
    assert.equal(o.mirror, a.deps.mirror);
    assert.equal(o.keys, a.deps.keys);
    assert.equal(o.store, store);
    assert.equal(o.lock, lock);
    assert.equal(o.keyGap, gap);
    for (const name of ['vimOf', 'plainOf']) assert.equal(typeof o[name], 'function', name);
    assert.equal('stateOf' in o, false, 'the sender gets no registry reader');
    assert.equal(o.vimOf('%6'), false);
    assert.equal(o.plainOf('%6'), false);
    assert.deepEqual(a.deps.calls.filter((c) => c[0] === 'keys'), [], 'building it sends nothing');
  });

  test('(+) an eligible pane: the sender gets the pane id and exactly { ids, base }; its status and body go to the page', async () => {
    const sender = fakeSender({ status: 200, body: { sent: 2, images: 1 } });
    const { a } = await bootScreens({ over: overWith(sender) });
    const r = await att(a, '%6', 'attach-send', { method: 'POST', json: { ids: [ATT, ATT2], base: BASE16 } });
    assert.deepEqual([r.status, r.body], [200, { sent: 2, images: 1 }]);
    assert.deepEqual(sender.calls, [['%6', { ids: [ATT, ATT2], base: BASE16 }]]);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('(+) the sender\'s refusals reach the page with their status and body (409 draft-changed with the draft, 429, 500 internal)', async () => {
    for (const answer of [{ status: 409, body: { error: 'draft-changed', pasted: 0, draft: { state: 'text' } } }, { status: 429, body: { error: 'busy', pasted: 1 } }, { status: 500, body: { error: 'internal', pasted: 2 } }]) {
      const sender = fakeSender(answer);
      const { a } = await bootScreens({ over: overWith(sender) });
      const r = await att(a, '%6', 'attach-send', { method: 'POST', json: { ids: [ATT], base: BASE16 } });
      assert.deepEqual([r.status, r.body], [answer.status, answer.body]);
    }
  });

  test('(−) a bad body is 400 before the pane and the sender: no ids, 7 ids, a duplicate, a bad id, a bad base, an extra key', async () => {
    const sender = fakeSender();
    const { a } = await bootScreens({ over: overWith(sender) });
    const seven = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(16));
    for (const json of [{ ids: [], base: BASE16 }, { ids: seven, base: BASE16 }, { ids: [ATT, ATT], base: BASE16 }, { ids: ['xyz'], base: BASE16 }, { ids: [ATT], base: 'short' }, { ids: [ATT] }, { base: BASE16 }, { ids: [ATT], base: BASE16, path: '/etc/passwd' }]) {
      assert.deepEqual([(await att(a, '%99', 'attach-send', { method: 'POST', json })).status, (await att(a, '%6', 'attach-send', { method: 'POST', json })).status], [400, 400], JSON.stringify(json).slice(0, 60));
    }
    assert.deepEqual(sender.calls, []);
  });

  test('(−) a pane that is not live Claude and was not started is 404; the sender is not called', async () => {
    const sender = fakeSender();
    const { a } = await bootScreens({ over: overWith(sender) });
    for (const id of ['%5', '%8', '%99']) assert.equal((await att(a, id, 'attach-send', { method: 'POST', json: { ids: [ATT], base: BASE16 } })).status, 404, id);
    assert.deepEqual(sender.calls, []);
  });

  test('(−) no secret 403; text/plain 415; GET and PUT 405; a body over 4 KB 413 -- the sender is not called', async () => {
    const sender = fakeSender();
    const { a } = await bootScreens({ over: overWith(sender) });
    const json = { ids: [ATT], base: BASE16 };
    assert.equal((await att(a, '%6', 'attach-send', { method: 'POST', json, headers: { 'x-nika-app': null } })).status, 403);
    assert.equal((await att(a, '%6', 'attach-send', { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await att(a, '%6', 'attach-send', { method: 'GET' })).status, 405);
    assert.equal((await att(a, '%6', 'attach-send', { method: 'PUT', json })).status, 405);
    assert.equal((await att(a, '%6', 'attach-send', { method: 'POST', json: { ...json, pad: 'p'.repeat(4097) } })).status, 413);
    assert.deepEqual(sender.calls, []);
  });

  test('(+) with the real sender behind the router: it shares the pane lock with End (an End refuses while it runs; it waits for a running End); nothing is pasted', async () => {
    const store = fakeStore({ lookup: (p, id) => ({ id, path: `/srv/nika/attachments/${GROUP_KEY}/${id}.pdf`, type: 'pdf', size: 3 }) });
    const { a, screens, mirror } = await bootScreens({ fake: false, over: { attachments: store } });
    const fixture = boxRows({ cols: 80, lines: [''] });
    screens['%6'] = Object.assign(fixture.rows, { cursor: fixture.cursor });
    const capture = mirror.capture;
    let enter;
    let entered = new Promise((r) => { enter = r; });
    let letGo;
    let gate = new Promise((r) => { letGo = r; });
    mirror.capture = async (...args) => { enter(); await gate; return capture(...args); };
    const body = { ids: [ATT], base: BASE16 };
    // 1. the send holds the pane: an End and a draft write are refused at once and type nothing
    const sending = att(a, '%6', 'attach-send', { method: 'POST', json: body });
    await entered;
    const typed = a.deps.calls.filter((c) => c[0] === 'keys').length;
    assert.equal((await pane(a, '%6', 'end', { method: 'POST', json: {} })).body.error, 'busy-switching');
    assert.equal((await pane(a, '%6', 'draft', { method: 'PUT', json: { text: 'hi', base: '' } })).body.error, 'busy-switching');
    assert.equal(a.deps.calls.filter((c) => c[0] === 'keys').length, typed, 'nothing was typed');
    letGo();
    const done = await sending;
    assert.deepEqual([done.status, done.body.error, done.body.pasted], [409, 'draft-changed', 0], 'the base was not what the screen reads: nothing is pasted');
    // 2. an End holds the pane: the send waits for it (the store is not asked meanwhile)
    store.calls.length = 0;
    entered = new Promise((r) => { enter = r; });
    gate = new Promise((r) => { letGo = r; });
    a.clock.t += 2000;
    const end = pane(a, '%6', 'end', { method: 'POST', json: {} });
    await entered;
    const waiting = att(a, '%6', 'attach-send', { method: 'POST', json: body });
    await new Promise((r) => setTimeout(r, 120)); // several polls of the waiting lock
    assert.deepEqual(store.calls, [], 'the send waits while End holds the pane');
    mirror.capture = capture; // the End goes on; the send runs after it
    letGo();
    await end;
    assert.equal((await waiting).body.pasted, 0);
    assert.equal(a.deps.calls.filter((c) => c[0] === 'keys' && c[2]?.paste !== undefined).length, 0, 'no paste went out');
  });

  test('(−) the browser tier has none of the three routes: POST, DELETE and POST are 404 there, whatever the headers', async () => {
    const server = createServer({ config: fx.config, exec: fakeExec(), token: 'tok', now: () => NOW, version: '0.0.0' });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    servers.push(server);
    const port = server.address().port;
    const call = (method, p) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, 'x-nika-app': SECRET, 'x-nika-token': 'tok', 'content-type': 'application/json', 'content-length': '2' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      q.on('error', reject);
      q.end('{}');
    });
    assert.equal(await call('POST', '/api/app/pane/%256/attachments'), 404);
    assert.equal(await call('DELETE', `/api/app/pane/%256/attachments/${ATT}`), 404);
    assert.equal(await call('POST', '/api/app/pane/%256/attach-send'), 404);
  });

  test('(−) the browser tier never loads the attachment modules: attach-send.js is imported by api-app.js only; attachments.js by api-app.js, appio.js and attach-send.js; none by server.js, cli.js or the collectors', () => {
    const dir = new URL('../src/', import.meta.url);
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js'));
    const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
    const importers = (name) => files.filter((f) => new RegExp(`(from\\s+|import\\()\\s*'(\\./|\\.\\./)${name}\\.js'`).test(read(f)));
    assert.deepEqual(importers('attach-send'), ['api-app.js']);
    assert.deepEqual(importers('attachments'), ['api-app.js', 'appio.js', 'attach-send.js']);
    assert.doesNotMatch(read('cli.js'), /attachments|attach-send/);
    assert.doesNotMatch(read('server.js'), /attachments|attach-send/);
  });
});

describe('attachments: the log is injected (0.5, W2 fix round 1, M7)', () => {
  test('(+) a store error in the upload and the delete route goes to deps.log as `nika: attachments: <code>` and nowhere else', async () => {
    const lines = [];
    const store = fakeStore({
      save: Object.assign(new Error('EACCES /srv/nika/attachments/secret-name.png'), { code: 'EACCES' }),
      remove: Object.assign(new Error('EBUSY /srv/nika/attachments/x'), { code: 'EBUSY' }),
    });
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6'), log: (line) => lines.push(line) } });
    const others = await capturingLog(async () => {
      assert.equal((await att(a, '%6', 'attachments', { method: 'POST', json: { name: 'secret-name.png', data: UPLOAD.data } })).status, 500);
      assert.deepEqual((await att(a, '%6', `attachments/${ATT}`, { method: 'DELETE' })).body, { removed: false });
    });
    assert.deepEqual(lines, ['nika: attachments: EACCES', 'nika: attachments: EBUSY']);
    assert.deepEqual(others, [], 'process.stderr and the console got nothing');
  });

  test('(+) the sender is built with that log; without one it writes the line to stderr', async () => {
    const given = (line) => line;
    const sender = fakeSender();
    await bootScreens({ over: { attachments: fakeStore(), createAttachSend: sender.factory, log: given } });
    assert.equal(sender.opts.log, given);
    const plainSender = fakeSender();
    await bootScreens({ over: { attachments: fakeStore(), createAttachSend: plainSender.factory } });
    const lines = await capturingLog(async () => plainSender.opts.log('nika: attachments: EIO'));
    assert.deepEqual(lines, ['nika: attachments: EIO\n']);
  });

  test('(−) the line never carries a message, a path, a name or an id, whatever the error holds', async () => {
    const lines = [];
    const store = fakeStore({ save: Object.assign(new Error(`${GROUP_KEY} ${ATT} /srv/secret.png`), { code: 'not a code /srv/secret.png' }) });
    const { a } = await bootScreens({ over: { attachments: store, collect: async () => keyedSnapshot('%6'), log: (line) => lines.push(line) } });
    await att(a, '%6', 'attachments', { method: 'POST', json: UPLOAD });
    assert.deepEqual(lines, ['nika: attachments: ERR']);
  });
});

// --- a dead pane is not eligible (0.5, W11; docs/security.md residual j) ------------------------------------------------------
// tmux's remain-on-exit keeps a pane whose process ended, with its tags, and names its command after the pane's argv, so it still "looks
// like claude". #{pane_dead} is the only thing that tells it apart: the pane list carries it (src/collect/tmux.js) and the check reads it.

describe('a dead pane (remain-on-exit) gets no keys and no capture', () => {
  // every route that goes through the eligibility check, each with a body that passes its own validation, so a 404 can only be the pane check
  const GATED = [
    ['GET', 'capture'], ['POST', 'keys', { text: 'hi' }], ['POST', 'mode', { target: 'plan' }], ['PUT', 'draft', { text: 'hello world', base: DSIG }],
    ['POST', 'submit', { base: DSIG }], ['PUT', 'fit', FIT_BODY], ['POST', 'scroll', SCROLL_UP3], ['POST', 'attachments', UPLOAD],
    ['POST', 'attachments/pick', { room: 1 }], ['POST', 'attach-send', { ids: [ATT], base: BASE16 }], ['POST', 'suggestion', { text: 'run the tests' }],
    ['POST', 'dialog', { picks: [2], sig: DSIG }], ['POST', 'answer', { n: 1, sig: DSIG }], ['POST', 'command', { text: '/compact' }],
    ['POST', 'end', {}], ['POST', 'stop', {}],
  ];
  const request = (a, id, [method, suffix, json]) => pane(a, id, suffix, { method, ...(json === undefined ? {} : { json }) });
  const setPane = (a, id, entry) => {
    a.deps.state.panes.set(id, entry);
    a.clock.t += 2000; // past the eligibility cache
  };

  test('(−) a live Claude session whose pane is dead is 404 not_found on every eligibility-gated route, and nothing reaches the mirror, the keys, the controller, the fit or the attachments', async () => {
    const fit = fakeFit();
    const { a, mirror, control } = await bootScreens({ over: { createFit: fit.factory } });
    setPane(a, '%6', { command: 'claude', dead: true });
    for (const route of GATED) {
      const r = await request(a, '%6', route);
      assert.equal(r.status, 404, `${route[0]} ${route[1]}`);
      assert.equal(r.body.error, 'not_found', `${route[0]} ${route[1]}`);
    }
    assert.deepEqual(mirror.seen, [], 'no capture');
    assert.deepEqual(control.calls, [], 'no controller action');
    assert.deepEqual(fit.calls, []);
    assert.equal(a.deps.calls.some((c) => ['keys', 'capture'].includes(c[0])), false);
  });

  test('(−) a pane nika started that is dead is just as ineligible (the started record does not qualify it)', async () => {
    const { a, mirror, control } = await bootScreens();
    a.ctx.started.set('%8', { key: w.project.key, name: 'x', sessionId: null, role: 'agent' });
    setPane(a, '%8', { command: 'node', dead: true });
    for (const route of GATED.slice(0, 4)) assert.equal((await request(a, '%8', route)).status, 404, `${route[0]} ${route[1]}`);
    assert.deepEqual(mirror.seen, []);
    assert.deepEqual(control.calls, []);
    assert.equal(a.ctx.started.has('%8'), true, 'the pane still exists, so its record stays');
  });

  test('(−) GET /modes leaves a dead pane out and does not capture it', async () => {
    const { a, screens, mirror } = await bootScreens();
    screens['%6'] = rowsOf(['t', FOOTER.plan]);
    setPane(a, '%6', { command: 'claude', dead: true });
    const r = await a.call('GET', '/api/app/modes');
    assert.deepEqual(r.body, { modes: {} });
    assert.deepEqual(mirror.seen, []);
  });

  test('(+) a live pane is unchanged: pane_dead false, or no field at all, is eligible for capture, keys, mode and /modes', async () => {
    for (const entry of [{ command: 'claude', dead: false }, { command: 'claude' }]) {
      const { a, screens, mirror } = await bootScreens();
      screens['%6'] = rowsOf(['t', FOOTER.plan]);
      setPane(a, '%6', entry);
      assert.equal((await request(a, '%6', ['GET', 'capture'])).status, 200, JSON.stringify(entry));
      assert.equal((await request(a, '%6', ['POST', 'keys', { text: 'hi' }])).status, 200, JSON.stringify(entry));
      assert.equal((await request(a, '%6', ['POST', 'mode', { target: 'plan' }])).status, 200, JSON.stringify(entry));
      assert.deepEqual(Object.keys((await a.call('GET', '/api/app/modes')).body.modes), ['%6'], JSON.stringify(entry));
      assert.ok(mirror.seen.includes('%6'));
    }
  });

  test('(+) a pane that was dead and is listed alive again (tmux reused the id) is eligible again at the next listing', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['t', FOOTER.plan]);
    setPane(a, '%6', { command: 'claude', dead: true });
    assert.equal((await request(a, '%6', ['GET', 'capture'])).status, 404);
    setPane(a, '%6', { command: 'claude', dead: false });
    assert.equal((await request(a, '%6', ['GET', 'capture'])).status, 200);
  });

  test('(−) the memory kept for a pane (held mode, vim, plain) is dropped when the pane dies, so a reused id starts unknown', async () => {
    const { a, screens } = await bootScreens();
    screens['%6'] = rowsOf(['t', FOOTER.plan]);
    assert.equal((await request(a, '%6', ['GET', 'capture'])).body.mode, 'plan');
    setPane(a, '%6', { command: 'claude', dead: true });
    assert.equal((await request(a, '%6', ['GET', 'capture'])).status, 404);
    screens['%6'] = rowsOf(PROMPT); // a prompt covers the footer: only a remembered mode could still say "plan"
    setPane(a, '%6', { command: 'claude', dead: false });
    const again = await request(a, '%6', ['GET', 'capture']);
    assert.equal(again.status, 200);
    assert.equal(again.body.mode, 'unknown');
  });
});
