// DEV / CI ONLY (not shipped: package.json "files" excludes scripts/). Stdlib only.
// A fake `nika serve --app` for the desktop shell, used by scripts/gui-smoke.sh. The shell starts it as
//   <NIKA_NODE> <root>/bin/nika serve --app      (cleared env, hello on stdin, ready on stdout)
// so gui-smoke.sh generates an executable `node` wrapper whose shebang is the real node and which imports this file.
// The probe serves a page plus a script (strict CSP, no inline script) on 127.0.0.1, the shell opens a real WebKit
// window on it, and the page reports what the window may and may not do. One JSON result line goes to stderr (the
// shell inherits it), then the probe exits. Nothing here is a secret: the page sends back only a hash of the secret.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

const OVERALL_MS = 90_000; // from the hello line: WebKit's first start in a bare container is slow
const CONTROL_WAIT_MS = 6_000; // after the page's report, wait for its same-origin control navigation
const CMDS = ['plugin:app|version', 'plugin:autostart|is_enabled', 'plugin:webview|get_all_webviews'];
const ALLOWED_ENV = new Set(['PATH', 'HOME', 'NIKA_APP', 'CLAUDE_CONFIG_DIR', 'NIKA_CONFIG_DIR', 'XDG_CONFIG_HOME',
  'XDG_STATE_HOME', 'TMUX_TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']);
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>nika probe</title><script src="/probe.js"></script></head><body><p>probe</p></body></html>';

/** Runs in the WebKit window. Served as text, so it uses nothing from this module. */
async function page(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { origin: location.origin, secureContext: window.isSecureContext, ua: navigator.userAgent.slice(0, 120), ipc: {}, ipcMessage: {}, nav: {} };
  const post = (obj) => fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    const d = Object.getOwnPropertyDescriptor(window, '__NIKA_APP__');
    const v = d && d.value;
    out.app = d ? {
      keys: Object.keys(v || {}),
      flags: { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable },
      frozen: Object.isFrozen(v),
      port: v && v.port,
      onWindowKeys: Object.keys(window).includes('__NIKA_APP__'),
    } : null;
    if (v && window.crypto && window.crypto.subtle) {
      const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(v.secret));
      out.app.secretSha256 = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    out.deleted = (delete window.__NIKA_APP__) && window.__NIKA_APP__ === undefined;
    out.tauriGlobal = typeof window.__TAURI__;

    const s = document.createElement('script'); // the CSP must refuse this
    s.textContent = 'window.__inline = 1';
    document.head.appendChild(s);
    out.inlineScriptRan = window.__inline === 1;

    const inv = window.__TAURI_INTERNALS__;
    out.internals = Boolean(inv && typeof inv.invoke === 'function');
    for (const cmd of cfg.cmds) {
      if (!out.internals) { out.ipc[cmd] = 'no-internals'; continue; }
      const limit = sleep(6000).then(() => 'timeout');
      const call = Promise.resolve().then(() => inv.invoke(cmd)).then(() => 'resolved', (e) => { out.ipcMessage[cmd] = String((e && e.message) || e).slice(0, 100); return 'rejected'; });
      out.ipc[cmd] = await Promise.race([call, limit]);
    }

    // A blocked navigation leaves this page alive; one that went through would unload it (and show in the traps).
    for (const [label, url] of [
      ['localhost', 'http://localhost:' + location.port + '/trap-localhost'],
      ['otherPort', 'http://127.0.0.1:' + cfg.otherPort + '/trap-other-port'],
      ['file', 'file:///etc/hosts'],
    ]) {
      location.href = url;
      await sleep(1500);
      out.nav[label] = 'alive';
    }
    let w;
    try { w = window.open('http://127.0.0.1:' + cfg.otherPort + '/trap-open'); } catch (e) { w = 'threw'; }
    out.openIsNull = w === null;
    await sleep(1000);
  } catch (e) {
    out.error = String(e).slice(0, 200);
  }
  await post(out);
  location.href = '/control'; // control: a same-origin navigation must still be allowed
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail).replace(/\s+/g, ' ').slice(0, 240) });
const seen = [];
let secret = null;
let report = null;
let controlSeen = false;
let finished = false;
let portA = 0;
let portB = 0;
let waitTimer = null;

function finish(why) {
  if (finished) return;
  finished = true;
  const p = report;
  const app = p?.app;
  const trapped = (needle) => seen.filter((r) => r.path.startsWith(needle));
  check('hello: proto 1 and a 43-char secret', secret !== null, secret === null ? why : '');
  const argv = process.argv.slice(2);
  check('child argv is <root>/bin/nika serve --app', argv.length === 3 && argv[0].endsWith(path.join('bin', 'nika')) && argv[1] === 'serve' && argv[2] === '--app', argv.map((a) => path.basename(a)).join(' '));
  const keys = Object.keys(process.env);
  check('child env: only the allowed keys, PATH starts with the node dir, NIKA_APP=1',
    keys.every((k) => ALLOWED_ENV.has(k)) && process.env.NIKA_APP === '1' && process.env.PATH.startsWith(path.dirname(process.argv[1]) + ':'), keys.sort().join(','));
  check('page: loaded from the probe origin and ran its script', p && p.origin === `http://127.0.0.1:${portA}`, p ? p.origin : `no report from the page (${why})`);
  check('init script: window.__NIKA_APP__ has the keys secret, port', app && app.keys.join() === 'secret,port', app ? app.keys.join() : 'missing');
  check('init script: configurable true, enumerable false, writable false', app && app.flags.configurable === true && app.flags.enumerable === false && app.flags.writable === false && app.onWindowKeys === false, JSON.stringify(app?.flags));
  check('init script: value frozen, port matches the server', app && app.frozen === true && app.port === portA, app ? `frozen ${app.frozen}, port ${app.port}` : 'missing');
  check('init script: SHA-256 of the secret equals the hello secret', secret !== null && app?.secretSha256 === sha256(secret), `isSecureContext ${p?.secureContext}, hash ${app?.secretSha256 ? 'present' : 'missing'}`);
  check('init script: delete window.__NIKA_APP__ works', p?.deleted === true);
  check('no window.__TAURI__ global', p?.tauriGlobal === 'undefined', p?.tauriGlobal);
  for (const cmd of CMDS) {
    check(`IPC refused: ${cmd}`, p && (p.ipc[cmd] === 'rejected' || p.ipc[cmd] === 'no-internals'), `${p?.ipc?.[cmd]} ${p?.ipcMessage?.[cmd] ?? ''}`);
  }
  check('CSP blocks an inline script', p?.inlineScriptRan === false);
  check('navigation to http://localhost:<port>/ is blocked', p?.nav?.localhost === 'alive' && trapped('/trap-localhost').length === 0, `page ${p?.nav?.localhost ?? 'gone'}, requests seen ${trapped('/trap-localhost').length}`);
  check('navigation to another loopback port is blocked', p?.nav?.otherPort === 'alive' && trapped('/trap-other-port').length === 0, `page ${p?.nav?.otherPort ?? 'gone'}, requests seen ${trapped('/trap-other-port').length}`);
  check('navigation to file:// is blocked (page still alive)', p?.nav?.file === 'alive', p?.nav?.file ?? 'gone');
  check('window.open returns null and opens nothing', p?.openIsNull === true && trapped('/trap-open').length === 0, `null ${p?.openIsNull}, requests seen ${trapped('/trap-open').length}`);
  check('control: a same-origin navigation is allowed', controlSeen, controlSeen ? '' : 'the probe never saw GET /control');
  const ok = checks.every((c) => c.ok);
  const result = { probe: 'nika-shell-probe', ok, why, checks, userAgent: p?.ua ?? null, requests: seen.filter((r) => r.path !== '/probe.js' && r.path !== '/favicon.ico') };
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exit(ok ? 0 : 1);
}

function reply(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function onRequest(server) {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    seen.push({ server, host: req.headers.host ?? null, method: req.method, path: url });
    if (seen.length > 200) seen.shift();
    if (server === 'other') return reply(res, 404, 'text/plain', 'no');
    if (req.method === 'GET' && url === '/') return reply(res, 200, 'text/html; charset=utf-8', HTML);
    if (req.method === 'GET' && url === '/probe.js') return reply(res, 200, 'text/javascript; charset=utf-8', `(${page.toString()})(${JSON.stringify({ cmds: CMDS, otherPort: portB })});`);
    if (req.method === 'GET' && url === '/control') {
      controlSeen = true;
      reply(res, 200, 'text/html; charset=utf-8', '<!doctype html><title>control</title><p>control</p>');
      return void setTimeout(() => finish('done'), 300);
    }
    if (req.method === 'POST' && url === '/result') {
      let body = '';
      req.on('data', (d) => { if (body.length < 65_536) body += d; });
      req.on('end', () => {
        try { report = JSON.parse(body); } catch { report = null; }
        reply(res, 204, 'text/plain', '');
        waitTimer = setTimeout(() => finish('no control navigation'), CONTROL_WAIT_MS);
      });
      return undefined;
    }
    return reply(res, 404, 'text/plain', 'not found');
  };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function start(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { msg = null; }
  if (!msg || msg.type !== 'hello' || msg.proto !== 1 || typeof msg.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(msg.secret)) {
    return finish('bad hello line');
  }
  secret = msg.secret;
  const main = http.createServer(onRequest('main'));
  const other = http.createServer(onRequest('other'));
  portB = await listen(other);
  portA = await listen(main);
  setTimeout(() => finish('timeout: the window never reported'), OVERALL_MS).unref();
  process.stdout.write(`${JSON.stringify({ type: 'ready', proto: 1, port: portA, version: '0.0.0-probe' })}\n`);
  return undefined;
}

const rl = readline.createInterface({ input: process.stdin });
rl.once('line', (line) => { start(line); });
rl.on('close', () => { if (waitTimer) clearTimeout(waitTimer); finish('stdin closed'); });
