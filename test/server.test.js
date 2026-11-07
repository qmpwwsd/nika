import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeFixture, cleanup, fakeExec, SID, NOW } from './helpers.js';
import { createServer } from '../src/server.js';

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
