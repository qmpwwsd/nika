// The app tier process (`nika serve --app`): the stdio handshake with the desktop shell (contract §5), the private
// server on 127.0.0.1:<random port>, the status feed and the folder picker relay. Stdout carries protocol lines only;
// diagnostics go to stderr. The secret arrives on stdin and goes nowhere else: not argv, env, logs, files or stdout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTmux, findClaude, parseSince, DEFAULT_SINCE } from './config.js';
import { makeExec } from './exec.js';
import { collect, findSession, findSessions } from './model.js';
import { createServer } from './server.js';
import { createAppApi } from './api-app.js';
import { RELEASE_ALL_MS } from './fit.js';
import { addProject, keyFor } from './store.js';
import { listPanes } from './collect/tmux.js';
import { readHistory, readSubagentHistory } from './collect/history.js';
import { listPlugins } from './collect/plugins.js';
import { listCommands } from './collect/commands.js';
import { createMirror } from './mirror.js';
import { createKeys } from './keys.js';
import { createAttachments, MAX_BYTES, isSecretName } from './attachments.js';
import { openRegular } from './fsafe.js';
import { rulesState, preview, apply } from './rules.js';
import { spawnAgent } from './spawn.js';
import { startOrchestrator } from './orchestrate.js';
import { clean } from './text.js';
import { stateDir } from './paths.js';
import { INSTALL_ROOT, appCopyState, installAppCopy, dismissAppCopy } from './appcopy.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NIKA_BIN = fileURLToPath(new URL('../bin/nika', import.meta.url));
const LINE_MAX = 64 * 1024;
const HELLO_MS = 5000;
const STATUS_MS = 3000;
const PROJECTS_SHOWN = 8;
const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const PICK_PATH_MAX = 4096;
const COPY_MS = 120_000; // ditto of the whole app bundle

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

/** The name of a picked file as the page shows it: the last part of its path only, never the path; `file` when nothing is left. */
function pickedName(p) {
  return clean(typeof p === 'string' ? path.basename(p) : '', 255) ?? 'file';
}

/**
 * One chooser open at a time, of either kind (a folder for Add project, files for the attachment button). State lives here; the shell's
 * `folder` or `files` message resolves it (contract §3, §5). A files request reads what the user picked itself, through fsafe, and hands the
 * bytes to the attachment store; the paths live only for the length of that read and never reach an answer, a log or the page.
 */
export function createPicker({ send, env, attachments }) {
  let slot = null; // { kind: 'folder' | 'files', reqId, state: 'pending' | 'working' | 'done' | 'cancelled', project?, pane?, key?, room?, files? }
  const open = () => slot && (slot.state === 'pending' || slot.state === 'working');
  const answers = (s, msg) => s && s.state === 'pending' && msg.reqId === s.reqId;

  /** One picked path as an entry of the answer. A failure here is this entry's alone. */
  async function readPicked(p, { pane, key }) {
    const name = pickedName(p);
    const bad = (error) => ({ ok: false, name, error });
    if (typeof p !== 'string' || p.length > PICK_PATH_MAX || p.includes('\0') || !path.isAbsolute(p)) return bad('invalid');
    if (isSecretName(path.basename(p))) return bad('secret-file'); // a credential file's name (`isSecretName`: .env*, .envrc*, *.key, *.pem, keystores, SSH private keys, .netrc, .git-credentials, .pgpass, .npmrc, credentials, *.ovpn): refused before the file is opened (rule 4)
    let handle;
    try {
      let st;
      try {
        ({ handle, st } = await openRegular(p)); // O_NOFOLLOW, a regular file, owned by this user, one link
      } catch {
        return bad('unreadable');
      }
      if (st.size > MAX_BYTES) return bad('too_large'); // from the fstat, before any byte is read
      const bytes = Buffer.alloc(st.size);
      let got = 0;
      while (got < st.size) {
        const { bytesRead } = await handle.read(bytes, got, st.size - got, got);
        if (bytesRead === 0) break; // the file shrank: what was there is all there is
        got += bytesRead;
      }
      const saved = await attachments.saveBytes({ pane, key, name, bytes: bytes.subarray(0, got) });
      return saved.status === 200 ? { ok: true, name, id: saved.body.id, size: saved.body.size, type: saved.body.type } : bad(saved.body?.error ?? 'write-failed');
    } catch {
      return bad('write-failed'); // a read or store failure; its text could carry the path, so nothing of it is kept
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return {
    /** New folder request id, or null while another chooser is open. */
    start() {
      if (open()) return null;
      slot = { kind: 'folder', reqId: crypto.randomUUID(), state: 'pending' };
      send({ type: 'pick-folder', reqId: slot.reqId });
      return slot.reqId;
    },
    /** New files request id for `pane` (its project `key`; at most `room` files are taken), or null while another chooser is open. */
    startFiles({ pane, key, room }) {
      if (open()) return null;
      slot = { kind: 'files', reqId: crypto.randomUUID(), state: 'pending', pane, key, room };
      send({ type: 'pick-files', reqId: slot.reqId });
      return slot.reqId;
    },
    /** { state, project? } of the latest folder request, or null for any other id (a files request is not one). */
    status(reqId) {
      if (!slot || slot.kind !== 'folder' || slot.reqId !== reqId) return null;
      return slot.state === 'working' ? { state: 'pending' } : { state: slot.state, project: slot.project };
    },
    /** { state: 'pending' | 'cancelled' } or { state: 'done', files } of the latest files request, or null for any other id or another pane's. */
    filesStatus(pane, reqId) {
      if (!slot || slot.kind !== 'files' || slot.reqId !== reqId || slot.pane !== pane) return null;
      if (slot.state === 'done') return { state: 'done', files: slot.files };
      return { state: slot.state === 'working' ? 'pending' : slot.state };
    },
    /** A `folder` message: ignored unless it answers the open request; an unusable path closes it as cancelled. */
    async onFolder(msg) {
      const s = slot;
      if (s?.kind !== 'folder' || !answers(s, msg)) return;
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
    /**
     * A `files` message: ignored unless it answers the open files request. `paths: null` (or anything that is not a list with an entry)
     * closes it as cancelled; otherwise the first `room` entries are read one after the other, each on its own: a failure of one
     * never stops the others, and the entries beyond `room` are never opened.
     */
    async onFiles(msg) {
      const s = slot;
      if (s?.kind !== 'files' || !answers(s, msg)) return;
      if (!Array.isArray(msg.paths) || msg.paths.length === 0) {
        s.state = 'cancelled';
        return;
      }
      s.state = 'working'; // a second answer for the same request is ignored
      const files = [];
      for (const p of msg.paths.slice(0, s.room)) files.push(await readPicked(p, s));
      s.files = files;
      s.state = 'done';
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
 * `exec`, `now`, `intervalMs`, `helloMs`, `releaseMs` (the bound of the fit's recovery at start and release at quit), `appCopy` ({ home,
 * root, platform, exec, brewApps }, for src/appcopy.js) and `attachments` (options for createAttachments: loadKeepDays, setTimer, clearTimer, log) are test seams.
 * @param {object} o
 * @param {object} o.config  defaultConfig() shape
 * @param {object} o.env
 * @param {import('node:stream').Readable} o.stdin
 * @param {import('node:stream').Writable} o.stdout
 * @param {import('node:stream').Writable} o.stderr
 * @returns {Promise<number>}
 */
export function serveApp({ config, env = process.env, stdin, stdout, stderr, exec = makeExec(), now = Date.now, intervalMs = STATUS_MS, helloMs = HELLO_MS, appCopy = {}, releaseMs = RELEASE_ALL_MS, attachments: attachOpts = {} }) {
  const say = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
  stdout.on('error', () => {}); // the shell went away: stdin closes next and ends us
  if (stdin.isTTY) {
    stderr.write('nika: serve --app needs a pipe on stdin (the desktop app starts it); use "nika serve" for the browser dashboard\n');
    return Promise.resolve(2);
  }

  return new Promise((resolve) => {
    let phase = 'hello'; // hello → running → done
    let server = null;
    let fit = null; // the fit controller (src/fit.js), built by createAppApi
    let attachments = null; // the attachment store (src/attachments.js): pruned after ready and every 24 h, stopped at finish
    let timer = null;
    let onMessage = () => {}; // messages after the hello; set once the server runs
    const helloTimer = setTimeout(() => refuse('no hello in time'), helloMs);
    const stop = () => finish(0);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    /** Waits for `work`, but at most releaseMs, and never fails: the fit controller logs its own failures and bounds itself too; this bound is the process's. */
    function bounded(work) {
      let t;
      return Promise.race([Promise.resolve(work).catch(() => {}), new Promise((ok) => { t = setTimeout(ok, releaseMs); })]).finally(() => clearTimeout(t));
    }

    function finish(code) {
      if (phase === 'done') return;
      phase = 'done';
      clearTimeout(helloTimer);
      clearInterval(timer);
      attachments?.stop();
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (!server) return resolve(code);
      // The server stops taking requests first (a late heartbeat must not fit a window again), then every window nika holds is given back:
      // the exit code waits for both, but for the release only up to releaseMs. What a hung tmux leaves is recovered at the next start.
      // The shell sends SIGTERM 2 s after it closes stdin, and the release may take its full 3 s (app/src-tauri/src/child.rs): with no listener
      // left Node's default action would end the process halfway through the restore. `hold` only keeps that default away; it is dropped as
      // soon as the release has resolved or hit its bound, so the exit after it is as it always was. SIGINT is not held: a second Ctrl-C still ends it.
      const hold = () => {};
      process.on('SIGTERM', hold);
      const closed = new Promise((ok) => {
        server.close(ok);
        server.closeAllConnections();
      });
      Promise.all([closed, bounded(fit?.releaseAll())]).then(() => {
        process.off('SIGTERM', hold);
        resolve(code);
      });
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
      const collectorCache = {};
      const ctx = {
        env, exec, tmuxBin, claudeBin: findClaude(env), nikaArgv: [process.execPath, NIKA_BIN], claudeDir: config.claudeDir, now, started: new Map(),
        findSession: (id) => findSession(id, { config: cfg, exec, now: now(), cache: collectorCache }), // one session by id, whatever its age (the saved orchestrator)
        findSessions: (ids) => findSessions(ids, { config: cfg, now: now(), cache: collectorCache }), // ended sessions by id in one transcript-index walk (the project list's saved orchestrators)
      };
      const snapshot = () => collect({ config: cfg, exec, now: now(), sinceMs: parseSince(DEFAULT_SINCE), since: DEFAULT_SINCE, cache: collectorCache }).then((r) => r.snapshot);
      const attachLog = attachOpts.log ?? ((line) => stderr.write(`${line}\n`)); // the store's lines and the routes' go to the same stderr
      attachments = createAttachments({ env, now, ...attachOpts, log: attachLog });
      const picker = createPicker({ send: say, env, attachments }); // the file chooser hands what it reads to the same store the routes use
      // the copy of the app in ~/Applications (ADR 0011): where it comes from and goes to is fixed by this install, never by a request
      const copyArgs = { root: appCopy.root ?? INSTALL_ROOT, home: appCopy.home ?? os.homedir(), platform: appCopy.platform ?? process.platform, stateDir: stateDir(env) };
      const copyDeps = { exec: appCopy.exec ?? makeExec({ timeout: COPY_MS }), ...(appCopy.brewApps ? { brewApps: appCopy.brewApps } : {}) };
      const deps = {
        version: VERSION,
        collect: snapshot,
        listPanes: () => listPanes(exec, tmuxBin),
        readHistory, readSubagentHistory, listPlugins, listCommands, rulesState, preview, apply, spawnAgent, startOrchestrator,
        mirror: createMirror({ exec, tmuxBin, now }),
        keys: createKeys({ exec, tmuxBin, now }),
        attachments,
        log: attachLog,
        picker,
        window: (action) => say({ type: 'window', action }), // the shell acts on its window (contract §5)
        appCopy: { state: () => appCopyState(copyArgs, copyDeps), install: () => installAppCopy(copyArgs, copyDeps), dismiss: () => dismissAppCopy(copyArgs, copyDeps) },
      };
      server = createServer({ config: cfg, exec, token: crypto.randomBytes(24).toString('base64url'), now, version: VERSION, app: createAppApi({ secret, ctx, deps }) });
      fit = ctx.fit;
      await bounded(fit.recover()); // give back what a crash left (design W7 section 6): before the first request and before `ready`
      if (phase === 'done') return; // stdin closed while it ran: finish() has closed the server
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
      attachments.start(); // prune now, then daily; it never rejects

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
        if (msg.type === 'files') picker.onFiles(msg);
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
