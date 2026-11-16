import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, cleanup, fakeExec, SID, NOW } from './helpers.js';
import { makeWorld } from './tmux-fake.js';
import { createServer } from '../src/server.js';
import { ensureDir, writeAtomic } from '../src/fwrite.js';
import { reportsDir } from '../src/paths.js';

const fx = makeFixture();
const TOKEN = 'test-token-123';
let server;
let port;
let exec;

before(async () => {
  exec = fakeExec();
  server = createServer({ config: fx.config, exec, token: TOKEN, now: () => NOW, version: '0.1.0' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  cleanup(fx);
});

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const focus = (body, headers = {}) => req('POST', '/api/focus', {
  headers: { 'content-type': 'application/json', 'x-nika-token': TOKEN, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('static and host check', () => {
  test('(+) GET / serves the page with the token meta and a strict CSP', async () => {
    const r = await req('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, new RegExp(`<meta name="nika-token" content="${TOKEN}">`));
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    // F9 hardening
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
  });

  test('(+) app.js and app.css are served with their content types', async () => {
    assert.match((await req('GET', '/app.js')).headers['content-type'], /javascript/);
    assert.match((await req('GET', '/app.css')).headers['content-type'], /text\/css/);
  });

  test('(−) any other path is 404, including traversal attempts', async () => {
    assert.equal((await req('GET', '/../package.json')).status, 404);
    assert.equal((await req('GET', '/%2e%2e/package.json')).status, 404);
    assert.equal((await req('GET', '/src/server.js')).status, 404);
  });

  test('(+) localhost host header is accepted', async () => {
    assert.equal((await req('GET', '/api/health', { headers: { host: `localhost:${port}` } })).status, 200);
  });

  test('(−) foreign host header is rejected (DNS rebinding)', async () => {
    assert.equal((await req('GET', '/', { headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await req('GET', '/api/agents', { headers: { host: 'evil.example' } })).status, 403);
  });
});

describe('api', () => {
  test('(+) health reports version', async () => {
    const r = await req('GET', '/api/health');
    assert.deepEqual(JSON.parse(r.body), { ok: true, version: '0.1.0' });
  });

  test('(+) agents returns grouped snapshot, no-store', async () => {
    const r = await req('GET', '/api/agents?since=7d');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    const body = JSON.parse(r.body);
    assert.deepEqual(body.groups.map((g) => g.label), ['repo', 'plain']);
    assert.equal(body.since, '7d');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  test('(−) agents rejects an invalid window', async () => {
    assert.equal((await req('GET', '/api/agents?since=forever')).status, 400);
  });

  test('(+) report returns the mapped report text', async () => {
    const r = await req('GET', `/api/report/${SID.busy}`);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/plain/);
    assert.match(r.body, /^STATUS: RUNNING 7\.1 build/);
  });

  test('(−) report: non-uuid is 400, unmapped session is 404', async () => {
    assert.equal((await req('GET', '/api/report/..%2F..%2Fetc%2Fpasswd')).status, 400);
    assert.equal((await req('GET', `/api/report/${SID.idle}`)).status, 404);
  });
});

describe('focus pane', () => {
  test('(+) valid request focuses the pane with fixed tmux argv', async () => {
    exec.calls.length = 0;
    const r = await focus({ pane: '%5' });
    assert.equal(r.status, 200);
    const tmuxCalls = exec.calls.filter((c) => c[0] === 'tmux' && !c.includes('list-panes'));
    assert.deepEqual(tmuxCalls, [
      ['tmux', 'switch-client', '-t', '%5'],
      ['tmux', 'select-window', '-t', '%5'],
      ['tmux', 'select-pane', '-t', '%5'],
    ]);
  });

  test('(+) same-origin Origin header is accepted', async () => {
    assert.equal((await focus({ pane: '%5' }, { origin: `http://127.0.0.1:${port}` })).status, 200);
  });

  test('(−) missing or wrong token is 403', async () => {
    assert.equal((await focus({ pane: '%5' }, { 'x-nika-token': '' })).status, 403);
    assert.equal((await focus({ pane: '%5' }, { 'x-nika-token': 'nope' })).status, 403);
  });

  test('(−) cross-origin Origin is 403', async () => {
    assert.equal((await focus({ pane: '%5' }, { origin: 'http://evil.example' })).status, 403);
  });

  test('(−) non-JSON content type is 415', async () => {
    assert.equal((await focus('pane=%5', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  });

  test('(−) malformed pane id is 400 and never reaches tmux', async () => {
    exec.calls.length = 0;
    for (const pane of [';ls', '%5;ls', '5', '', '%', '%-1']) {
      assert.equal((await focus({ pane })).status, 400, pane);
    }
    assert.equal((await focus('{bad json')).status, 400);
    assert.equal(exec.calls.length, 0);
  });

  test('(−) unknown pane is 404', async () => {
    assert.equal((await focus({ pane: '%999' })).status, 404);
  });

  test('(−) oversized body is 413; wrong method is 405', async () => {
    assert.equal((await focus(JSON.stringify({ pane: '%5', pad: 'x'.repeat(5000) }))).status, 413);
    assert.equal((await req('GET', '/api/focus')).status, 405);
  });
});

describe('browser tier: /api/app is not mounted', () => {
  const PATHS = ['/api/app', '/api/app/', '/api/app/me', '/api/app/projects', '/api/app/settings', '/api/app/spawn', '/api/app/pane/%256/keys', '/api/app/rules/apply', '/api/app/window'];

  test('(−) every /api/app path is 404 for GET, POST, PUT and DELETE, with or without an X-Nika-App header', async () => {
    for (const p of PATHS) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        for (const headers of [{}, { 'x-nika-app': 'anything', 'content-type': 'application/json' }]) {
          const r = await req(method, p, method === 'GET' ? { headers } : { headers: { ...headers, 'content-length': '2' }, body: '{}' });
          assert.equal(r.status, 404, `${method} ${p}`);
          assert.equal(r.body, 'not found');
        }
      }
    }
  });

  test('(+) the 0.1 routes are unchanged next to it', async () => {
    assert.equal((await req('GET', '/api/health')).status, 200);
    assert.equal((await req('GET', '/api/agents?since=7d')).status, 200);
    assert.equal((await req('GET', '/api/focus')).status, 405);
    assert.equal((await req('POST', '/api/unknown', { headers: { 'content-type': 'application/json' }, body: '{}' })).status, 405);
    assert.equal((await req('GET', '/api/application')).status, 404);
    assert.equal((await focus({ pane: '%5' })).status, 200);
  });
});

describe('app tier: the injected handler owns /api/app/*', () => {
  const seen = [];
  let appServer;
  let appPort;
  before(async () => {
    const app = async (rq, rs, url, p) => {
      seen.push([rq.method, url.pathname, p]);
      if (url.pathname === '/api/app/claimed') {
        rs.writeHead(200, { 'Content-Type': 'text/plain' });
        rs.end('from app');
        return true;
      }
      return false;
    };
    appServer = createServer({ config: fx.config, exec: fakeExec(), token: TOKEN, now: () => NOW, version: '0.2.0', app });
    await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
    appPort = appServer.address().port;
  });
  after(() => new Promise((r) => appServer.close(r)));
  const at = (method, p, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: appPort, method, path: p, headers: { host: `127.0.0.1:${appPort}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    r.end();
  });

  test('(+) a claimed request is answered by the handler, which gets the request, url and listening port', async () => {
    seen.length = 0;
    const r = await at('POST', '/api/app/claimed');
    assert.deepEqual([r.status, r.body], [200, 'from app']);
    assert.deepEqual(seen, [['POST', '/api/app/claimed', appPort]]);
  });

  test('(−) a request the handler declines is 404; paths outside /api/app never reach it', async () => {
    seen.length = 0;
    assert.equal((await at('GET', '/api/app/other')).status, 404);
    await at('GET', '/api/health');
    await at('GET', '/api/application');
    await at('GET', '//api/app/claimed');
    assert.deepEqual(seen.map((x) => x[1]), ['/api/app/other']);
  });

  test('(−) a foreign Host is refused before the handler runs', async () => {
    seen.length = 0;
    assert.equal((await at('GET', '/api/app/claimed', { host: 'evil.example' })).status, 403);
    assert.deepEqual(seen, []);
  });

  test('(+) the 0.1 routes still work on the app tier', async () => {
    assert.equal((await at('GET', '/api/health')).status, 200);
    assert.equal((await at('GET', '/')).status, 200);
  });
});

describe('/api/report finds the reports of agents nika spawned', () => {
  const DECOY = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const REPORT_ID = '12121212-1212-4212-8212-121212121212';
  let w;
  let nikaServer;
  let nikaPort;
  before(async () => {
    w = await makeWorld();
    const dir = reportsDir(w.project.key, w.env);
    await ensureDir(dir);
    await writeAtomic(dir, 'builder-1.session', `${REPORT_ID}\n`);
    await writeAtomic(dir, 'builder-1.md', 'STATUS: DONE synthetic\n');
    await writeAtomic(dir, 'evil.session', `${DECOY}\n`);
    fs.writeFileSync(path.join(w.root, 'decoy.txt'), 'DECOY-CONTENT\n');
    fs.symlinkSync(path.join(w.root, 'decoy.txt'), path.join(dir, 'evil.md'));
    nikaServer = createServer({ config: { ...fx.config, env: w.env }, exec: fakeExec(), token: TOKEN, now: () => NOW, version: '0.2.0' });
    await new Promise((r) => nikaServer.listen(0, '127.0.0.1', r));
    nikaPort = nikaServer.address().port;
  });
  after(async () => {
    await new Promise((r) => nikaServer.close(r));
    w.cleanup();
  });
  const at = (id, p = nikaPort) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: p, path: `/api/report/${id}`, headers: { host: `127.0.0.1:${p}` } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });

  test('(+) a report in nika\'s per-project reports dir is served', async () => {
    const r = await at(REPORT_ID);
    assert.equal(r.status, 200);
    assert.match(r.body, /^STATUS: DONE synthetic/);
  });

  test('(−) a symlinked report there is never opened; a server without the registry env does not see the dir', async () => {
    const evil = await at(DECOY);
    assert.equal(evil.status, 404);
    assert.equal(evil.body.includes('DECOY-CONTENT'), false);
    assert.equal((await at(REPORT_ID, port)).status, 404); // the shared 0.1 test server has no env
  });
});

describe('context on the browser tier (0.4 O5, R3)', () => {
  // a server with the env (so it reads nika's config.json through loadConfig) over a fixture whose busy session has usage numbers
  const fx2 = makeFixture();
  const cfg = path.join(fx2.root, 'cfg');
  let srv;
  let p2;
  before(async () => {
    const slug = fx2.wt.replace(/[^A-Za-z0-9]/g, '-');
    fs.appendFileSync(path.join(fx2.claudeDir, 'projects', slug, `${SID.busy}.jsonl`), `${JSON.stringify({
      type: 'assistant', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 700, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 5 } },
    })}\n`);
    fs.mkdirSync(path.join(cfg, 'nika'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'nika', 'config.json'), JSON.stringify({ compaction: { enabled: true, pct: 50, window: 200000 } }), { mode: 0o600 });
    srv = createServer({ config: { ...fx2.config, env: { NIKA_CONFIG_DIR: cfg } }, exec: fakeExec(), token: TOKEN, now: () => NOW, version: '0.1.0' });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    p2 = srv.address().port;
  });
  after(async () => {
    await new Promise((r) => srv.close(r));
    cleanup(fx2);
  });
  const agents = async () => {
    const res = await fetch(`http://127.0.0.1:${p2}/api/agents?since=7d`);
    const body = await res.json();
    return body.groups.flatMap((g) => g.agents);
  };

  test('(+) /api/agents carries context numbers per session, measured against the setting nika reads from its own config.json', async () => {
    const a = (await agents()).find((x) => x.id === SID.busy);
    assert.deepEqual(a.context, { tokens: 1000, window: 200000, compactAt: null, pct: 0.5, compaction: 'none' });
  });

  test('(−) a session without usage has context null, and no usage field, model id or text of the transcript is added beside it', async () => {
    const list = await agents();
    assert.equal(list.find((x) => x.id === SID.idle).context, null);
    const raw = JSON.stringify(list);
    assert.equal(/input_tokens|cache_read|cache_creation|output_tokens|"usage"/.test(raw), false);
    assert.equal(raw.includes('synthetic prompt'), false);
  });
});

describe('browser tier: a Claude `shell` status reads as Working (0.4 fix)', () => {
  // the registry status `shell`: the turn is over and a background shell still runs; Claude lists it as Working, so it is not "needs you"
  const fx3 = makeFixture();
  const SHELL = 'dededede-dede-4ede-8ede-dededededede';
  const WAIT = 'efefefef-efef-4fef-8fef-efefefefefef';
  let srv;
  let p3;
  before(async () => {
    const reg = (pid, sessionId, status) => fs.writeFileSync(path.join(fx3.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({
      pid, sessionId, cwd: fx3.plain, status, procStart: 'Sat Nov  7 18:57:14 2026', updatedAt: NOW,
    }));
    reg(115, SHELL, 'shell');
    reg(116, WAIT, 'waiting');
    const ps = [101, 102, 115, 116].map((p) => `  ${p} Sat Nov  7 18:57:14 2026`);
    srv = createServer({ config: fx3.config, exec: fakeExec({ psLines: ps }), token: TOKEN, now: () => NOW, version: '0.1.0' });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    p3 = srv.address().port;
  });
  after(async () => {
    await new Promise((r) => srv.close(r));
    cleanup(fx3);
  });
  const snap = async () => (await fetch(`http://127.0.0.1:${p3}/api/agents?since=7d`)).json();

  test('(+) /api/agents: the shell session is busy with no attention, and the counts do not call it other', async () => {
    const body = await snap();
    const a = body.groups.flatMap((g) => g.agents).find((x) => x.id === SHELL);
    assert.equal(a.state, 'busy');
    assert.equal(a.attention, null);
    assert.deepEqual([body.counts.busy, body.counts.other], [2, 1], 'the fixture busy session and the shell one are busy; only waiting is other');
  });

  test('(−) /api/agents: a waiting session still needs you', async () => {
    const a = (await snap()).groups.flatMap((g) => g.agents).find((x) => x.id === WAIT);
    assert.equal(a.state, 'waiting');
    assert.equal(a.attention, 'waiting');
  });
});
