import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { defaultConfig, parseSince, DEFAULT_SINCE } from './config.js';
import { makeExec } from './exec.js';
import { collect } from './model.js';
import { createServer } from './server.js';
import { clean } from './text.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const ENDED_SHOWN = 5;

const USAGE = `usage: nika [command]

commands:
  open                 open the dashboard in the browser (default)
  serve                run the dashboard server on 127.0.0.1 (brew services runs this)
  status [options]     print agents grouped by project
      --json             machine-readable output
      --since <window>   24h | 7d | 30d | all (default ${DEFAULT_SINCE})
      --full             list every ended agent, not only the latest ${ENDED_SHOWN}
  --version, -v        print the version
  help, -h             show this help

environment:
  NIKA_PORT            port (default 3335)
  CLAUDE_CONFIG_DIR    Claude Code config dir (default ~/.claude)
  NIKA_TMP_ROOT        Claude scratchpad root with spawn reports (default /private/tmp/claude-<uid>)
  NIKA_REPORT_DIRS     extra report dirs, colon-separated
`;

class UsageError extends Error {}

function parseStatusArgs(args) {
  const o = { json: false, full: false, since: DEFAULT_SINCE };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--full') o.full = true;
    else if (a === '--since') o.since = args[(i += 1)];
    else if (a.startsWith('--since=')) o.since = a.slice('--since='.length);
    else throw new UsageError(`unknown option ${a}`);
  }
  if (parseSince(o.since) === null) throw new UsageError('--since must be like 24h, 7d, 30d or all');
  return o;
}

function ago(ms, now) {
  if (!Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const home = os.homedir();
// Everything printed goes through clean(): no terminal escapes from agent-controlled text (review F4).
const tilde = (p) => {
  const v = clean(p ?? '', 1000) ?? '';
  return v.startsWith(`${home}/`) ? `~${v.slice(home.length)}` : v;
};
const fit = (s, n) => {
  const v = clean(String(s ?? ''), 1000) ?? '';
  return v.length > n ? `${v.slice(0, n - 1)}…` : v.padEnd(n);
};

function painter(stream, env) {
  const on = Boolean(stream.isTTY) && !env.NO_COLOR;
  const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { busy: wrap('32'), idle: wrap('33'), other: wrap('34'), ended: wrap('2'), bold: wrap('1') };
}

function renderStatus(snapshot, { full }, paint) {
  const now = snapshot.generatedAt;
  const lines = [];
  if (snapshot.groups.length === 0) lines.push(`No agents in the last ${snapshot.since}.`);
  for (const g of snapshot.groups) {
    const c = g.counts;
    lines.push(`${paint.bold(clean(g.label, 120) ?? '')}  ${tilde(g.root)}   busy ${c.busy} · idle ${c.idle}${c.other ? ` · other ${c.other}` : ''} · ended ${c.ended}`);
    const live = g.agents.filter((a) => a.live);
    const ended = g.agents.filter((a) => !a.live);
    const shown = full ? ended : ended.slice(0, ENDED_SHOWN);
    for (const a of [...live, ...shown]) {
      const kind = !a.live ? 'ended' : (a.state === 'busy' || a.state === 'idle' ? a.state : 'other');
      const dot = a.live ? '●' : '○';
      const where = [a.worktree, a.gitBranch].filter(Boolean).join(' · ');
      lines.push(`  ${paint[kind](`${dot} ${fit(a.state, 7)}`)} ${fit(a.name, 28)} ${fit(a.modelLabel ?? '-', 11)} ${fit(where, 34)} ${fit(a.pane?.id ?? '', 6)} ${ago(a.lastActivity, now)}`);
    }
    if (shown.length < ended.length) lines.push(paint.ended(`  … ${ended.length - shown.length} more ended (nika status --full)`));
    lines.push('');
  }
  const bad = Object.entries(snapshot.sources).filter(([, v]) => v !== 'ok');
  for (const [k, v] of bad) lines.push(paint.ended(`note: ${k}: ${clean(v, 300)}`));
  return `${lines.join('\n').trimEnd()}\n`;
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function serve(config, io) {
  const token = crypto.randomBytes(24).toString('base64url');
  const server = createServer({ config, exec: makeExec(), token, version: VERSION });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', resolve);
    });
  } catch (err) {
    io.err.write(err.code === 'EADDRINUSE'
      ? `nika: port ${config.port} is in use (another nika? try: nika open)\n`
      : `nika: cannot listen on 127.0.0.1:${config.port}: ${err.message}\n`);
    return 1;
  }
  io.out.write(`nika ${VERSION} listening on http://127.0.0.1:${config.port}/\n`);
  return new Promise((resolve) => {
    const stop = () => server.close(() => resolve(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function open(config, io) {
  const url = `http://127.0.0.1:${config.port}/`;
  if (!(await health(config.port))) {
    io.err.write(`nika is not running on ${url}\nStart it: brew services start nika   (or run it in the foreground: nika serve)\n`);
    return 1;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await new Promise((resolve) => {
    execFile(opener, [url], (err) => {
      if (err) io.err.write(`nika: could not launch a browser (${err.message}); open ${url} yourself\n`);
      resolve();
    });
  });
  io.out.write(`${url}\n`);
  return 0;
}

/** JSON for a terminal: C1 controls escaped as \uXXXX, which JSON.stringify leaves raw (verify N6). */
function toJson(v) {
  return JSON.stringify(v, null, 2).replace(/[\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function main(argv, env = process.env, io = { out: process.stdout, err: process.stderr }) {
  const [cmd = 'open', ...rest] = argv;
  const config = defaultConfig(env);
  try {
    switch (cmd) {
      case '--version':
      case '-v':
      case 'version':
        io.out.write(`nika ${VERSION}\n`);
        return 0;
      case 'help':
      case '-h':
      case '--help':
        io.out.write(USAGE);
        return 0;
      case 'status': {
        const o = parseStatusArgs(rest);
        const { snapshot } = await collect({ config, exec: makeExec(), now: Date.now(), sinceMs: parseSince(o.since), since: o.since });
        io.out.write(o.json ? `${toJson(snapshot)}\n` : renderStatus(snapshot, o, painter(io.out, env)));
        return 0;
      }
      case 'serve':
      case 'open':
        if (rest.length) throw new UsageError(`${cmd} takes no arguments`);
        if (config.port === null) throw new UsageError('NIKA_PORT must be a port number 1-65535');
        return cmd === 'serve' ? await serve(config, io) : await open(config, io);
      default:
        throw new UsageError(`unknown command ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err.write(`nika: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }
}

export async function run() {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`nika: ${err.message}\n`);
    process.exitCode = 1;
  }
}
