// The app tier process (`nika serve --app`): the stdio handshake with the desktop shell (contract §5), the private
// server on 127.0.0.1:<random port>, the status feed and the folder picker relay. Stdout carries protocol lines only;
// diagnostics go to stderr. The secret arrives on stdin and goes nowhere else: not argv, env, logs, files or stdout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTmux, findClaude, parseSince, DEFAULT_SINCE } from './config.js';
import { makeExec } from './exec.js';
import { collect } from './model.js';
import { createServer } from './server.js';
import { createAppApi } from './api-app.js';
import { addProject, keyFor } from './store.js';
import { listPanes } from './collect/tmux.js';
import { readHistory } from './collect/history.js';
import { listPlugins } from './collect/plugins.js';
import { createMirror } from './mirror.js';
import { createKeys } from './keys.js';
import { rulesState, preview, apply } from './rules.js';
import { spawnAgent } from './spawn.js';
import { startOrchestrator } from './orchestrate.js';
import { clean } from './text.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NIKA_BIN = fileURLToPath(new URL('../bin/nika', import.meta.url));
const LINE_MAX = 64 * 1024;
const HELLO_MS = 5000;
const STATUS_MS = 3000;
const PROJECTS_SHOWN = 8;
const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const PICK_PATH_MAX = 4096;

/**
 * Splits a stream into lines. A line over LINE_MAX bytes is reported as `null` (and dropped); the rest of an unfinished
 * over-long line is skipped up to its newline, so memory stays bounded.
 */
function readLines(stream, onLine) {
  stream.setEncoding('utf8');
  let buf = '';
  let skipping = false;
  stream.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (skipping) skipping = false; // tail of a line already reported as too long
      else onLine(Buffer.byteLength(line) > LINE_MAX ? null : line);
    }
    if (!skipping && buf.length > LINE_MAX) {
      skipping = true;
      buf = '';
      onLine(null);
    } else if (skipping) buf = '';
  });
}

/** One open folder picker at a time. State lives here; the shell's `folder` message resolves it (contract §3, §5). */
export function createPicker({ send, env }) {
  let slot = null; // { reqId, state: 'pending' | 'working' | 'done' | 'cancelled', project? }
  const open = () => slot && (slot.state === 'pending' || slot.state === 'working');
  return {
    /** New request id, or null while another picker is open. */
    start() {
      if (open()) return null;
      slot = { reqId: crypto.randomUUID(), state: 'pending' };
      send({ type: 'pick-folder', reqId: slot.reqId });
      return slot.reqId;
    },
    /** { state, project? } of the latest request, or null for any other id. */
    status(reqId) {
      if (!slot || slot.reqId !== reqId) return null;
      return slot.state === 'working' ? { state: 'pending' } : { state: slot.state, project: slot.project };
    },
    /** A `folder` message: ignored unless it answers the open request; an unusable path closes it as cancelled. */
    async onFolder(msg) {
      const s = slot;
      if (!s || s.state !== 'pending' || msg.reqId !== s.reqId) return;
      if (msg.path === null) {
        s.state = 'cancelled';
        return;
      }
      s.state = 'working'; // a second answer for the same request is ignored
      try {
        const p = msg.path;
        if (typeof p !== 'string' || p.length > PICK_PATH_MAX || p.includes('\0') || !path.isAbsolute(p)) throw new Error('not an absolute path');
        const real = await fsp.realpath(p);
        if (!(await fsp.stat(real)).isDirectory()) throw new Error('not a directory');
        s.project = await addProject(real, env);
        s.state = 'done';
      } catch {
        s.state = 'cancelled';
      }
    },
  };
}

/** `status` protocol line from a collect() snapshot (contract §5). `attention` = live agents that are neither busy nor idle. */
export function statusLine(snapshot) {
  const c = snapshot.counts;
  return {
    type: 'status',
    busy: c.busy,
    idle: c.idle,
    other: c.other,
    ended: c.ended,
    attention: c.other,
    projects: snapshot.groups.slice(0, PROJECTS_SHOWN).map((g) => ({
      key: keyFor(g.root ?? g.key),
      name: clean(g.label, 80) ?? '(unknown)',
      busy: g.counts.busy,
      idle: g.counts.idle,
      attention: g.counts.other,
    })),
  };
}

/**
 * Runs the app tier until stdin closes. Resolves with the exit code: 0 after stdin closed, 2 when refused (stdin is a TTY,
 * no valid first `hello` within 5 s), 1 when the server cannot listen. The caller exits with it.
 * `exec`, `now`, `intervalMs` and `helloMs` are test seams.
 * @param {object} o
 * @param {object} o.config  defaultConfig() shape
 * @param {object} o.env
 * @param {import('node:stream').Readable} o.stdin
 * @param {import('node:stream').Writable} o.stdout
 * @param {import('node:stream').Writable} o.stderr
 * @returns {Promise<number>}
 */
export function serveApp({ config, env = process.env, stdin, stdout, stderr, exec = makeExec(), now = Date.now, intervalMs = STATUS_MS, helloMs = HELLO_MS }) {
  const say = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
  stdout.on('error', () => {}); // the shell went away: stdin closes next and ends us
  if (stdin.isTTY) {
    stderr.write('nika: serve --app needs a pipe on stdin (the desktop app starts it); use "nika serve" for the browser dashboard\n');
    return Promise.resolve(2);
  }

  return new Promise((resolve) => {
    let phase = 'hello'; // hello → running → done
    let server = null;
    let timer = null;
    let onMessage = () => {}; // messages after the hello; set once the server runs
    const helloTimer = setTimeout(() => refuse('no hello in time'), helloMs);
    const stop = () => finish(0);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    function finish(code) {
      if (phase === 'done') return;
      phase = 'done';
      clearTimeout(helloTimer);
      clearInterval(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (!server) return resolve(code);
      server.close(() => resolve(code));
      server.closeAllConnections();
    }

    // fixed messages only: a JSON.parse error message quotes the input, which may hold the secret
    function refuse(message) {
      if (phase !== 'hello') return;
      say({ type: 'error', message });
      finish(2);
    }

    async function start(secret) {
      phase = 'running';
      const tmuxBin = findTmux(env);
      const cfg = { ...config, env, tmuxBin };
      const ctx = { env, exec, tmuxBin, claudeBin: findClaude(env), nikaArgv: [process.execPath, NIKA_BIN], claudeDir: config.claudeDir, now, started: new Map() };
      const collectorCache = {};
      const snapshot = () => collect({ config: cfg, exec, now: now(), sinceMs: parseSince(DEFAULT_SINCE), since: DEFAULT_SINCE, cache: collectorCache }).then((r) => r.snapshot);
      const picker = createPicker({ send: say, env });
      const deps = {
        version: VERSION,
        collect: snapshot,
        listPanes: () => listPanes(exec, tmuxBin),
        readHistory, listPlugins, rulesState, preview, apply, spawnAgent, startOrchestrator,
        mirror: createMirror({ exec, tmuxBin, now }),
        keys: createKeys({ exec, tmuxBin, now }),
        picker,
      };
      server = createServer({ config: cfg, exec, token: crypto.randomBytes(24).toString('base64url'), now, version: VERSION, app: createAppApi({ secret, ctx, deps }) });
      try {
        await new Promise((ok, fail) => {
          server.once('error', fail);
          server.listen(0, '127.0.0.1', ok);
        });
      } catch (e) {
        say({ type: 'error', message: `cannot listen on 127.0.0.1: ${clean(e.code ?? e.message, 80)}` });
        server = null;
        return finish(1);
      }
      server.on('error', (e) => stderr.write(`nika: server error: ${clean(e.code ?? e.message, 80)}\n`));
      if (phase === 'done') return; // stdin closed while the server was starting: finish() has closed it
      say({ type: 'ready', proto: 1, port: server.address().port, version: VERSION });

      let busy = false;
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          const line = statusLine(await snapshot());
          if (phase === 'running') say(line);
        } catch {
          // a failed collect() skips this tick
        } finally {
          busy = false;
        }
      };
      timer = setInterval(tick, intervalMs);
      timer.unref(); // never keeps the process alive on its own
      tick();
      onMessage = (msg) => {
        if (msg.type === 'folder') picker.onFolder(msg);
      };
    }

    readLines(stdin, (line) => {
      if (phase === 'done') return;
      if (phase === 'hello') {
        let msg = null;
        try {
          msg = line === null ? null : JSON.parse(line);
        } catch {
          // reported below with a fixed message
        }
        if (msg?.type !== 'hello' || msg.proto !== 1 || typeof msg.secret !== 'string' || !SECRET.test(msg.secret)) return refuse('first line must be a valid hello');
        clearTimeout(helloTimer);
        start(msg.secret).catch(() => {
          say({ type: 'error', message: 'cannot start the server' });
          finish(1);
        });
        return;
      }
      if (line === null) return;
      try {
        const msg = JSON.parse(line);
        if (msg && typeof msg === 'object' && !Array.isArray(msg)) onMessage(msg);
      } catch {
        // not JSON: ignored
      }
    });
    const ended = () => (phase === 'hello' ? refuse('stdin closed before hello') : finish(0));
    stdin.once('end', ended);
    stdin.once('close', ended);
  });
}
