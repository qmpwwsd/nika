// Local HTTP server. Binds 127.0.0.1 only (cli.js); every request is checked against the Host allow-list.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collect } from './model.js';
import { parseSince, DEFAULT_SINCE } from './config.js';
import { focusPane, readReport } from './actions.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const SNAPSHOT_TTL_MS = 1500;
const BODY_LIMIT = 1024;
const SINCE_CACHE_MAX = 16;

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        if (size > limit * 64) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('close', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {object} o
 * @param {object} o.config   defaultConfig() shape
 * @param {Function} o.exec   execFile wrapper (src/exec.js)
 * @param {string} o.token    per-process random token required by state-changing routes
 * @param {Function} [o.now]  clock
 * @param {string} o.version
 */
export function createServer({ config, exec, token, now = Date.now, version }) {
  const collectorCache = {};
  const snapshots = new Map();
  const staticCache = new Map();

  async function snapshot(since) {
    const t = now();
    const hit = snapshots.get(since);
    if (hit && t - hit.at < SNAPSHOT_TTL_MS) return hit.promise;
    if (snapshots.size >= SINCE_CACHE_MAX) snapshots.clear();
    const promise = collect({ config, exec, now: t, sinceMs: parseSince(since), since, cache: collectorCache })
      .then((r) => r.snapshot);
    snapshots.set(since, { at: t, promise });
    promise.catch(() => snapshots.delete(since));
    return promise;
  }

  async function serveStatic(res, [file, type]) {
    let body = staticCache.get(file);
    if (body === undefined) {
      try {
        body = await fs.readFile(path.join(PUBLIC_DIR, file), file.endsWith('.html') ? 'utf8' : undefined);
      } catch {
        return send(res, 500, 'missing asset');
      }
      if (file === 'index.html') body = body.replace('__NIKA_TOKEN__', token);
      staticCache.set(file, body);
    }
    return send(res, 200, body, type, { 'Cache-Control': 'no-cache' });
  }

  async function handleFocus(req, res, origins) {
    if (!sameToken(req.headers['x-nika-token'], token)) return json(res, 403, { error: 'missing or wrong token' });
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return json(res, 403, { error: 'cross-origin request refused' });
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'cross-site request refused' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return json(res, 415, { error: 'content-type must be application/json' });
    const raw = await readBody(req, BODY_LIMIT);
    if (raw === null) return json(res, 413, { error: 'body too large' });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const r = await focusPane(body?.pane, exec, config.tmuxBin ?? 'tmux');
    return json(res, r.status, r.body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address()?.port;
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'forbidden host');
      const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      let url;
      try {
        url = new URL(req.url, `http://${host}`);
      } catch {
        return send(res, 400, 'bad url');
      }
      const p = url.pathname;

      if (p === '/api/focus') {
        if (req.method !== 'POST') return send(res, 405, 'method not allowed', undefined, { Allow: 'POST' });
        return await handleFocus(req, res, origins);
      }
      if (req.method !== 'GET') return send(res, 405, 'method not allowed', undefined, { Allow: 'GET' });

      if (STATIC.has(p)) return await serveStatic(res, STATIC.get(p));
      if (p === '/api/health') return json(res, 200, { ok: true, version });
      if (p === '/api/agents') {
        const since = url.searchParams.get('since') ?? DEFAULT_SINCE;
        if (parseSince(since) === null) return json(res, 400, { error: 'since must be like 24h, 7d, 30d or all' });
        return json(res, 200, await snapshot(since));
      }
      const m = /^\/api\/report\/([^/]+)$/.exec(p);
      if (m) {
        const r = await readReport(m[1], config);
        return send(res, r.status, r.text);
      }
      return send(res, 404, 'not found');
    } catch (err) {
      // stderr goes to the brew services log (review F18)
      console.error(`nika: ${req.method} ${req.url?.slice(0, 200)} failed:`, err);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.destroy(err);
    }
  });
  return server;
}
