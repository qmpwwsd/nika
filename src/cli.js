import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { defaultConfig, findClaude, parseSince, DEFAULT_SINCE } from './config.js';
import { makeExec } from './exec.js';
import { collect, findSession } from './model.js';
import { createServer } from './server.js';
import { clean, cleanBlock } from './text.js';
import { configDir, stateDir, backupsRoot } from './paths.js';
import { openRegular, readAt } from './fsafe.js';
import { PROJECT_KEY, PANE_ID, TMUX_SESSION } from './ids.js';
import { addProject, listProjects, loadConfig, removeProject } from './store.js';
import { rulesState, preview as rulesPreview, apply as rulesApply } from './rules.js';
import { spawnAgent, runAgent } from './spawn.js';
import { startOrchestrator } from './orchestrate.js';
import { INSTALL_ROOT, targetPath, appCopyState, installAppCopy, refreshManagedCopy } from './appcopy.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const ENDED_SHOWN = 5;
const APP_ID = 'io.github.qmpwwsd.nika';
const BRIEF_MAX = 64 * 1024;
const DIFF_MAX = 1024 * 1024;
// Absolute path of bin/nika: tmux panes run `node <this> _run-agent ...` without a PATH lookup (contract §8).
const NIKA_BIN = fileURLToPath(new URL('../bin/nika', import.meta.url));
const NO_APP = `the nika app is not installed (looked for the macOS bundle ${APP_ID}, or on Linux nika-app on PATH and the ${APP_ID} desktop entry)
install it, or use the browser dashboard: nika open --browser`;

// Fixed texts for the app copy (ADR 0011): the module's errors carry only a code, so no path or OS text can reach a terminal.
const COPY_FAILURES = {
  'no-source': "nika can't find its own app to copy. Reinstall it with Homebrew: brew reinstall nika",
  'foreign-target': "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace. Move it away, then run nika app install again.",
  'copy-busy': 'nika is already copying the app.',
  'copy-failed': "nika couldn't copy the app to ~/Applications. An existing copy was left as it was.",
};

const USAGE = `usage: nika [command]

commands:
  open [--app|--browser]  open the app when installed, else the browser dashboard (default)
  app                  open the desktop app (fails when it is not installed)
  app install          copy the app into ~/Applications so Spotlight finds it (macOS)
  serve [--app]        run the dashboard server on 127.0.0.1 (brew services runs this)
                         --app: private app-tier server on a random port, for the desktop app (needs a pipe on stdin)
  status [options]     print agents grouped by project
      --json             machine-readable output
      --since <window>   24h | 7d | 30d | all (default ${DEFAULT_SINCE})
      --ended            also list ended agents (the latest ${ENDED_SHOWN} per project)
      --full             list every ended agent, not only the latest ${ENDED_SHOWN} (implies --ended)
  projects list        list registered projects with their rules state
  projects add <dir>   register a project folder
  projects remove <key>  unregister a project (its files are never touched)
  rules preview [dir]  show the orchestration rules nika would write into a project
  rules apply [dir]    write them after a preview and confirmation
      --yes              do not ask (required without a terminal)
      --overwrite-foreign  replace a rules/orchestration.md nika did not write
      --gitignore        also add .claude/settings.local.json to .gitignore
  spawn <name> <model> <brief>  start an agent in a tmux pane (inside tmux, or with --session)
      <brief>            path of a file (<= 64 KB), or - for stdin
      --project <dir>    project folder (default: the one containing the current directory)
      --permission-mode <m>  default | manual | acceptEdits | plan | auto | dontAsk
      --rc <prefix|off>  Remote Control name prefix, or off
      --role <agent|orchestrator>  orchestrator starts a sub-orchestrator (only the main orchestrator may); default agent
      --under <%pane>    split below this pane
      --session <name>   tmux session (default: the project's)
                         the parent is the pane you run it from ($TMUX_PANE), read from tmux's own record; it is never an option
  orchestrate [dir]    start or reuse the project's tmux session with an orchestrator pane
      --detached         do not attach or switch to the session
  doctor               check node, tmux, claude, the app, and nika's config and state folders
  --version, -v        print the version
  help, -h             show this help

[dir] defaults to the registered project containing the current directory.
exit codes: 0 ok, 1 runtime error, 2 usage, 3 refused (validation, limit, foreign file, declined)

environment:
  NIKA_PORT            port (default 3335)
  CLAUDE_CONFIG_DIR    Claude Code config dir (default ~/.claude)
  NIKA_TMP_ROOT        Claude scratchpad root with spawn reports (default /private/tmp/claude-<uid>)
  NIKA_REPORT_DIRS     extra report dirs, colon-separated
  NIKA_TMUX, NIKA_CLAUDE  tmux and claude binaries
  NIKA_CONFIG_DIR      nika config dir (default ~/.config/nika)
`;

class UsageError extends Error {}
/** An expected failure: the message goes to stderr, `code` is the exit code (1 runtime, 2 usage, 3 refused). */
class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function parseStatusArgs(args) {
  const o = { json: false, ended: false, full: false, since: DEFAULT_SINCE };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--ended') o.ended = true;
    else if (a === '--full') o.full = o.ended = true;
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

function renderStatus(snapshot, { ended: withEnded, full }, paint) {
  const now = snapshot.generatedAt;
  const lines = [];
  if (snapshot.groups.length === 0) lines.push(`No agents in the last ${snapshot.since}.`);
  for (const g of snapshot.groups) {
    const c = g.counts;
    lines.push(`${paint.bold(clean(g.label, 120) ?? '')}  ${tilde(g.root)}   busy ${c.busy} · idle ${c.idle}${c.other ? ` · other ${c.other}` : ''} · ended ${c.ended}`);
    const live = g.agents.filter((a) => a.live);
    const ended = g.agents.filter((a) => !a.live);
    const shown = !withEnded ? [] : full ? ended : ended.slice(0, ENDED_SHOWN);
    for (const a of [...live, ...shown]) {
      const kind = !a.live ? 'ended' : (a.state === 'busy' || a.state === 'idle' ? a.state : 'other');
      const dot = a.live ? '●' : '○';
      const where = [a.worktree, a.gitBranch].filter(Boolean).join(' · ');
      lines.push(`  ${paint[kind](`${dot} ${fit(a.state, 7)}`)} ${fit(a.name, 28)} ${fit(a.modelLabel ?? '-', 11)} ${fit(where, 34)} ${fit(a.pane?.id ?? '', 6)} ${ago(a.lastActivity, now)}`);
    }
    if (!withEnded && ended.length) lines.push(paint.ended(`  … ${ended.length} ended hidden (nika status --ended)`));
    else if (shown.length < ended.length) lines.push(paint.ended(`  … ${ended.length - shown.length} more ended (nika status --full)`));
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

// --- app and browser -----------------------------------------------------------------------------------------------

async function openBrowser(cx) {
  if (cx.config.port === null) throw new UsageError('NIKA_PORT must be a port number 1-65535');
  const url = `http://127.0.0.1:${cx.config.port}/`;
  if (!(await health(cx.config.port))) {
    cx.err.write(`nika is not running on ${url}\nStart it: brew services start nika   (or run it in the foreground: nika serve)\n`);
    return 1;
  }
  try {
    await cx.execT(15_000)(cx.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  } catch (err) {
    if (!err.killed) cx.err.write(`nika: could not launch a browser (${clean(err.message, 200)}); open ${url} yourself\n`);
  }
  cx.out.write(`${url}\n`);
  return 0;
}

/** First executable `bin` in the absolute PATH dirs (a relative entry would resolve against the cwd), or null. */
function onPath(bin, env) {
  for (const d of (env.PATH || '').split(':').filter((x) => path.isAbsolute(x))) {
    const file = path.join(d, bin);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return null;
}

/** Runs a long-lived program detached from this terminal; true once it has started. */
function startDetached(spawn, bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, [], { detached: true, stdio: 'ignore', shell: false });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

// Everything the app copy needs besides the exec: where this install lives, whose HOME, which state dir. `io.home`, `io.root`
// and `io.brewApps` are test seams; nothing here comes from a request or an argument.
const copyArgs = (cx) => ({ root: cx.root, home: cx.home, platform: cx.platform, stateDir: stateDir(cx.env) });
const copyDeps = (cx) => ({ exec: cx.execT(120_000), ...(cx.brewApps ? { brewApps: cx.brewApps } : {}) });

/**
 * After `brew upgrade`: brings a copy nika made up to this version. Never blocks a launch: a failure is one line on stderr.
 * Reads the copy's state once and returns it (as it stands after the refresh; null when it could not be read), so the
 * launch decides what to open without a second read.
 */
async function refreshCopy(cx) {
  let copy = null;
  try {
    copy = await appCopyState(copyArgs(cx), copyDeps(cx));
    if ((await refreshManagedCopy({ ...copyArgs(cx), version: VERSION }, copyDeps(cx), copy)) === 'updated') {
      cx.out.write(`updated the nika app in ~/Applications to ${VERSION} (if nika was open, quit and reopen it)\n`);
      copy = { ...copy, state: 'current', version: copy.available };
    }
  } catch (err) {
    cx.err.write(`nika: could not update the app in ~/Applications (${COPY_FAILURES[err?.code] ? err.code : 'copy-failed'})\n`);
  }
  return copy;
}

/**
 * Starts the desktop app: macOS opens the copy nika manages in ~/Applications by path (after refreshing it), else
 * `open -b <bundle id>` (non-zero = not installed, verified on macOS: exit 1 and a LaunchServices message on stderr);
 * Linux `nika-app` on PATH, else `gtk-launch <id>`. True when it was launched.
 */
async function launchApp(cx) {
  const tried = (cmd, args) => cx.execT(10_000)(cmd, args).then(() => true, () => false);
  if (cx.platform === 'darwin') {
    const copy = await refreshCopy(cx);
    // with two copies the bundle id is ambiguous: the one nika made is opened by its path
    if (copy?.managed && (copy.state === 'current' || copy.state === 'stale') && (await tried('open', [targetPath(cx.home)]))) return true;
    return tried('open', ['-b', APP_ID]);
  }
  const bin = onPath('nika-app', cx.env);
  return bin ? startDetached(cx.spawn, bin) : tried('gtk-launch', [APP_ID]);
}

/** Whether the app is installed, without starting it: macOS Spotlight by bundle id; Linux nika-app on PATH or a desktop entry. */
async function appInstalled(cx) {
  if (cx.platform === 'darwin') {
    try {
      return (await cx.execT(2000)('mdfind', [`kMDItemCFBundleIdentifier == "${APP_ID}"`])).stdout.trim() !== '';
    } catch {
      return false;
    }
  }
  if (onPath('nika-app', cx.env)) return true;
  const dirs = [cx.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), ...(cx.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
  return dirs.some((d) => path.isAbsolute(d) && fs.existsSync(path.join(d, 'applications', `${APP_ID}.desktop`)));
}

async function openCmd(rest, cx) {
  const { values } = parse(rest, { app: B, browser: B });
  if (values.app && values.browser) throw new UsageError('--app and --browser exclude each other');
  if (!values.browser && (await launchApp(cx))) {
    cx.out.write('opened the nika app\n');
    return 0;
  }
  if (values.app) throw new CliError(NO_APP, 1);
  return openBrowser(cx);
}

/** `nika app install` (macOS): copy or update the app in ~/Applications. */
async function appInstallCmd(cx) {
  if (cx.platform !== 'darwin') throw new CliError('the .deb or AppImage installs the desktop entry; there is nothing to copy on this system', 1);
  let r;
  try {
    r = await installAppCopy(copyArgs(cx), copyDeps(cx));
  } catch (err) {
    throw new CliError(COPY_FAILURES[err?.code] ?? COPY_FAILURES['copy-failed'], 1);
  }
  if (r.changed === 'added') cx.out.write(`added nika ${r.version} to ~/Applications (find it with Spotlight)\n`);
  else if (r.changed === 'updated') cx.out.write(`updated nika in ~/Applications to ${r.version} (if nika was open, quit and reopen it)\n`);
  else cx.out.write(`already current: nika ${r.version} is in ~/Applications\n`);
  if (r.recorded === false) cx.err.write("nika: could not record the copy as managed; nika won't refresh it\n");
  return 0;
}

async function appCmd(rest, cx) {
  if (rest[0] === 'install') {
    parse(rest.slice(1));
    return appInstallCmd(cx);
  }
  parse(rest);
  if (!(await launchApp(cx))) throw new CliError(NO_APP, 1);
  cx.out.write('opened the nika app\n');
  return 0;
}

async function serveAppCmd(cx, io) {
  if (cx.stdin.isTTY) throw new CliError('serve --app needs a pipe on stdin: the desktop app starts it (to open the dashboard run: nika open)', 2);
  try {
    const serveApp = io.serveApp ?? (await import('./appio.js')).serveApp; // loaded only for --app
    // appio resolves with its exit code (0 stdin closed, 1 cannot listen, 2 refused); contract §9 says void: treat that as 0
    const code = await serveApp({ config: cx.config, env: cx.env, stdin: cx.stdin, stdout: cx.out, stderr: cx.err });
    return Number.isInteger(code) ? code : 0;
  } catch (err) {
    throw new CliError(`serve --app: ${clean(err.message, 300) ?? 'failed'}`, 1);
  }
}

// --- arguments, projects, results ----------------------------------------------------------------------------------

const B = { type: 'boolean' };
const S = { type: 'string' };

/** util.parseArgs in strict mode; every complaint becomes a UsageError, and at most `max` positionals are allowed. */
function parse(args, options = {}, max = 0) {
  let r;
  try {
    r = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    if (typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) throw new UsageError(err.message.split('\n')[0].split('. ')[0]);
    throw err;
  }
  if (r.positionals.length > max) throw new UsageError(`unexpected argument ${clean(r.positionals[max], 60)}`);
  return r;
}

/** The body of a 200 result; any other `{ status, body }` becomes a CliError (4xx refused = 3, 5xx runtime = 1). */
function ok(res) {
  if (res.status === 200) return res.body;
  const b = res.body ?? {};
  const partial = Array.isArray(b.written) && b.written.length ? ` (already written: ${b.written.join(', ')}; backups: ${clean(b.backupDir, 300)})` : '';
  throw new CliError(`${clean(b.error, 40) ?? 'error'}${b.code ? ` (${clean(b.code, 20)})` : ''}: ${clean(b.message, 300) ?? 'failed'}${partial}`, res.status >= 500 ? 1 : 3);
}

/**
 * The registered project for `dirArg` (exactly), or, without it, for the current directory or its nearest registered
 * ancestor. Projects are matched by realpath, as they are stored.
 */
async function findProject(dirArg, cx) {
  const hint = 'register it first: nika projects add <dir>';
  let d;
  try {
    d = await fsp.realpath(path.resolve(cx.cwd, dirArg ?? '.'));
  } catch {
    throw new CliError(`no such directory: ${clean(dirArg, 200)}`, 3);
  }
  const projects = await listProjects(cx.env);
  for (;;) {
    const hit = projects.find((p) => p.dir === d);
    if (hit) return hit;
    const up = path.dirname(d);
    if (dirArg !== undefined || up === d) throw new CliError(`${dirArg !== undefined ? 'that directory is' : 'the current directory is not inside'} a registered project\n${hint}`, 3);
    d = up;
  }
}

/** Dependencies of the tmux-facing modules (spawn, orchestrate). */
function toolCtx(cx) {
  return {
    env: cx.env, exec: cx.execT(5000), tmuxBin: cx.config.tmuxBin, claudeBin: findClaude(cx.env),
    nikaArgv: [process.execPath, NIKA_BIN], claudeDir: cx.config.claudeDir, now: Date.now, started: new Map(),
    lenientParent: true, // a `$TMUX_PANE` that tmux no longer lists is "no parent", not an error (a page request names a gone pane: 404)
    findSession: (id) => findSession(id, { config: cx.config, exec: cx.execT(5000) }), // the saved orchestrator, whatever its age
  };
}

// --- projects and rules --------------------------------------------------------------------------------------------

async function projectsCmd(rest, cx) {
  const [sub, ...args] = rest;
  const bad = () => new UsageError('usage: nika projects list | add <dir> | remove <key>');
  if (sub === 'list') {
    parse(args);
    const projects = await listProjects(cx.env);
    if (!projects.length) {
      cx.out.write('No projects. Add one: nika projects add <dir>\n');
      return 0;
    }
    const paint = painter(cx.out, cx.env);
    cx.out.write(`${paint.bold(`${'key'.padEnd(16)}  ${'name'.padEnd(24)}  ${'rules'.padEnd(8)}  dir`)}\n`);
    for (const p of projects) cx.out.write(`${p.key}  ${fit(p.name, 24)}  ${fit((await rulesState(p)).state, 8)}  ${tilde(p.dir)}\n`);
    return 0;
  }
  if (sub === 'add') {
    const { positionals } = parse(args, {}, 1);
    if (!positionals.length) throw bad();
    let p;
    try {
      p = await addProject(path.resolve(cx.cwd, positionals[0]), cx.env);
    } catch (err) {
      if (['ENOENT', 'ENOTDIR', 'EPATH', 'EINVAL'].includes(err.code)) throw new CliError(`cannot add ${clean(positionals[0], 200)}: ${err.code} ${clean(err.message, 200)}`, 3);
      throw err;
    }
    cx.out.write(`registered ${clean(p.name, 120)}  ${p.key}  ${tilde(p.dir)}\n`);
    return 0;
  }
  if (sub === 'remove') {
    const { positionals } = parse(args, {}, 1);
    if (!positionals.length) throw bad();
    if (!PROJECT_KEY.test(positionals[0])) throw new UsageError('a project key is 16 characters (see: nika projects list)');
    if (!(await removeProject(positionals[0], cx.env))) throw new CliError('no project with that key (see: nika projects list)', 3);
    cx.out.write(`removed ${positionals[0]} (the project's files were not touched)\n`);
    return 0;
  }
  throw bad();
}

function showPreview(project, p, cx) {
  const paint = painter(cx.out, cx.env);
  cx.out.write(`${paint.bold(clean(project.name, 120) ?? project.key)}  ${tilde(project.dir)}\n`);
  for (const f of p.files) {
    const tags = [f.action, f.foreign && 'not written by nika', f.optional && 'only with --gitignore'].filter(Boolean).join(', ');
    cx.out.write(`\n${paint.bold(f.path)} (${tags})\n`);
    if (f.diff) cx.out.write(`${cleanBlock(f.diff, DIFF_MAX) ?? ''}\n`); // diffs contain project file text: no terminal escapes
    if (f.note) cx.out.write(`${clean(f.note, 200)}\n`);
  }
  if (p.warnings.length) cx.out.write('\n');
  for (const w of p.warnings) cx.out.write(`warning: ${clean(w, 300)}\n`);
}

/** One answer line from stdin; anything but y / yes (including end of input) is no. */
async function confirm(cx, question) {
  cx.out.write(question);
  const rl = readline.createInterface({ input: cx.stdin });
  try {
    for await (const line of rl) return /^y(es)?$/i.test(line.trim());
    return false;
  } finally {
    rl.close();
  }
}

async function rulesCmd(rest, cx) {
  const [sub, ...args] = rest;
  if (sub !== 'preview' && sub !== 'apply') throw new UsageError('usage: nika rules preview|apply [dir] [--yes] [--overwrite-foreign] [--gitignore]');
  const applying = sub === 'apply';
  const { values, positionals } = parse(args, applying ? { yes: B, 'overwrite-foreign': B, gitignore: B } : {}, 1);
  const project = await findProject(positionals[0], cx);
  const ctx = { env: cx.env };
  const p = ok(await rulesPreview(project, ctx));
  showPreview(project, p, cx);
  if (!applying) return 0;

  const overwrite = values['overwrite-foreign'] === true;
  const gitignore = values.gitignore === true;
  if (!p.files.some((f) => f.action !== 'unchanged' && f.action !== 'skipped' && (!f.optional || gitignore))) {
    cx.out.write('\nNothing to apply.\n');
    return 0;
  }
  if (p.files.some((f) => f.foreign) && !overwrite) {
    throw new CliError('rules/orchestration.md was not written by nika; to replace it (a backup is kept) run again with --overwrite-foreign', 3);
  }
  if (!values.yes) {
    if (!(cx.stdin.isTTY && cx.out.isTTY)) throw new CliError('not a terminal: pass --yes to apply without asking', 3);
    cx.out.write('\n');
    if (!(await confirm(cx, 'Apply? [y/N] '))) throw new CliError('not applied (declined); nothing was written', 3);
  }
  const done = ok(await rulesApply(project, { hash: p.hash, overwriteForeign: overwrite, gitignore }, ctx));
  cx.out.write(`written: ${done.written.join(', ')}\nbackups: ${clean(done.backupDir, 500)}\n`);
  return 0;
}

// --- spawn, orchestrate, doctor ------------------------------------------------------------------------------------

/** A spawn brief: a regular file (O_NOFOLLOW, owned by you) or `-` for stdin, each at most 64 KB. */
async function readBrief(src, cx) {
  const tooBig = () => new CliError(`the brief is larger than ${BRIEF_MAX / 1024} KB`, 3);
  if (src === '-') {
    const chunks = [];
    let n = 0;
    for await (const c of cx.stdin) {
      const b = Buffer.from(c);
      n += b.length;
      if (n > BRIEF_MAX) throw tooBig();
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  let opened;
  try {
    opened = await openRegular(path.resolve(cx.cwd, src));
  } catch (err) {
    throw new CliError(`cannot read the brief ${clean(src, 200)}: ${err.code ?? clean(err.message, 100)}`, err.code ? 3 : 1);
  }
  try {
    if (opened.st.size > BRIEF_MAX) throw tooBig();
    return await readAt(opened.handle, 0, opened.st.size);
  } finally {
    await opened.handle.close();
  }
}

async function spawnCmd(rest, cx) {
  const { values: v, positionals } = parse(rest, { project: S, 'permission-mode': S, rc: S, role: S, under: S, session: S }, 3);
  const [name, model, brief] = positionals;
  if (brief === undefined) throw new UsageError('usage: nika spawn <name> <model> <brief> [--project dir] [--permission-mode m] [--rc prefix|off] [--role agent|orchestrator] [--under %pane] [--session name]');
  if (v.role !== undefined && v.role !== 'agent' && v.role !== 'orchestrator') throw new UsageError('--role must be agent or orchestrator');
  if (!cx.env.TMUX && !v.session) throw new UsageError('spawn needs a tmux session: run it inside tmux, or pass --session <name>');
  if (v['permission-mode'] === 'bypassPermissions') throw new CliError('bypassPermissions is never allowed', 3);
  const project = await findProject(v.project, cx);
  // the parent is the pane this runs in; spawnAgent reads that pane's role and depth from tmux's own tags (never from here)
  const parent = typeof cx.env.TMUX_PANE === 'string' && PANE_ID.test(cx.env.TMUX_PANE) ? cx.env.TMUX_PANE : undefined;
  const req = { project: project.key, name, model, brief: await readBrief(brief, cx), permissionMode: v['permission-mode'], under: v.under, session: v.session, rc: v.rc, role: v.role, parent };
  const o = ok(await spawnAgent(req, toolCtx(cx)));
  cx.out.write(`pane: ${o.pane}\nsession: ${clean(o.session, 60)}\nreport: ${clean(path.join(o.reports.dir, o.reports.report), 500)}\n`);
  return 0;
}

/**
 * The `-t` target of the orchestrator's session for switch-client (`tail` ':') or attach-session (`tail` ''): the exact session
 * (`=<name><tail>`) when the name is a valid TMUX_SESSION, else its pane id (tmux resolves `%n` to that pane's session; the session
 * of an orchestrator adopted from the user's own tmux can be named anything), else nothing runs. Rules constraint 3.
 */
export function sessionTarget(o, tail) {
  if (typeof o.session === 'string' && TMUX_SESSION.test(o.session)) return `=${o.session}${tail}`;
  if (typeof o.pane === 'string' && PANE_ID.test(o.pane)) return o.pane;
  throw new CliError("cannot attach: the orchestrator's tmux session name is not one nika can target", 1);
}

async function orchestrateCmd(rest, cx) {
  const { values, positionals } = parse(rest, { detached: B }, 1);
  const project = await findProject(positionals[0], cx);
  const ctx = toolCtx(cx);
  const o = ok(await startOrchestrator(project.key, ctx));
  cx.out.write(`session: ${clean(o.session, 60)}\npane: ${o.pane}\n${o.created ? 'started a new orchestrator' : 'the orchestrator is already running'}\n`);
  if (values.detached || !cx.out.isTTY) return 0;
  if (cx.env.TMUX) {
    const target = sessionTarget(o, ':');
    try {
      await ctx.exec(ctx.tmuxBin, ['-u', 'switch-client', '-t', target]);
    } catch (err) {
      throw new CliError(`tmux switch-client failed: ${clean(String(err.stderr || err.message).trim().split('\n')[0], 200)}`, 1);
    }
    return 0;
  }
  const target = sessionTarget(o, '');
  return new Promise((resolve) => {
    const child = cx.spawn(ctx.tmuxBin, ['-u', 'attach-session', '-t', target], { stdio: 'inherit', shell: false });
    child.once('error', (err) => {
      cx.err.write(`nika: cannot run tmux: ${clean(err.code ?? err.message, 100)}\n`);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code === 0 ? 0 : 1));
  });
}

/** Mode of a folder as `0700`, with a note when group or others can reach it. */
function dirInfo(dir) {
  try {
    const mode = fs.lstatSync(dir).mode & 0o777;
    return `${tilde(dir)}  mode ${mode.toString(8).padStart(4, '0')}${mode & 0o077 ? '  (should be 0700)' : ''}`;
  } catch {
    return `${tilde(dir)}  not created yet`;
  }
}

/** What `nika doctor` adds to the app row about the copy in ~/Applications (macOS); empty when there is nothing to say. */
async function copyNote(cx) {
  const c = await appCopyState(copyArgs(cx), copyDeps(cx)).catch(() => null);
  if (!c) return '';
  const note = {
    missing: 'not in ~/Applications: run nika app install',
    current: `~/Applications copy: ${c.version}, ${c.managed ? 'managed' : 'not managed'} by nika`,
    stale: `~/Applications copy is ${c.version ?? 'of another version'}, ${c.available} is available: run nika app install`,
    foreign: "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace",
  }[c.state];
  return note ? `  (${note})` : '';
}

/**
 * What `nika doctor` adds to the tmux row (0.4): a warning below tmux 3.2, which auto-compact needs (`new-session -e`, ADR 0014);
 * "version unknown" when the first line of `tmux -V` is not exactly `tmux <major>.<minor>` with an optional letter (a build such
 * as `tmux next-3.5` or `tmux master` is not guessed at). Empty when the version is 3.2 or newer.
 */
function tmuxVersionNote(line) {
  const m = /^tmux (\d{1,3})\.(\d{1,3})[a-z]?$/.exec(line);
  if (!m) return '  (version unknown)';
  const old = Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 2);
  return old ? `  (tmux ${line.slice(5)} is older than 3.2: nika's auto-compact needs 3.2 or newer)` : '';
}

async function doctor(cx) {
  const row = (k, v) => cx.out.write(`${k.padEnd(7)} ${v}\n`);
  const firstLine = async (bin, arg) => {
    try {
      const { stdout, stderr } = await cx.execT(2000)(bin, [arg]);
      return clean(String(stdout || stderr).split('\n')[0], 120);
    } catch {
      return null;
    }
  };
  const major = Number(process.versions.node.split('.')[0]);
  row('node', `${process.version}${major >= 22 ? '' : '  (nika needs >= 22)'}`);
  const tmuxV = await firstLine(cx.config.tmuxBin, '-V');
  const tmuxInstall = cx.platform === 'darwin' ? 'brew install tmux' : cx.platform === 'linux' ? 'sudo apt install tmux' : null; // no command elsewhere
  row('tmux', tmuxV ? `${tilde(cx.config.tmuxBin)}  ${tmuxV}${tmuxVersionNote(tmuxV)}` : `not found (${tmuxInstall ? `install: ${tmuxInstall}; or set NIKA_TMUX` : 'add it to PATH or set NIKA_TMUX'})`);
  const claudeBin = findClaude(cx.env);
  const claudeV = claudeBin ? await firstLine(claudeBin, '--version') : null;
  row('claude', !claudeBin ? 'not found (add it to PATH or set NIKA_CLAUDE)' : `${tilde(claudeBin)}  ${claudeV ?? '--version failed'}`);
  row('app', `${(await appInstalled(cx)) ? 'installed' : 'not installed'}${await copyNote(cx)}`);
  row('config', dirInfo(configDir(cx.env)));
  row('state', dirInfo(stateDir(cx.env)));
  row('backups', `${dirInfo(backupsRoot(cx.env))}  (rules apply keeps the last 10 per project)`);
  for (const w of (await loadConfig(cx.env)).warnings) row('warning', `config.json: ${clean(w, 200)}`);
  return 0;
}

/** JSON for a terminal: C1 controls escaped as \uXXXX, which JSON.stringify leaves raw (verify N6). */
function toJson(v) {
  return JSON.stringify(v, null, 2).replace(/[\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const showVersion = (rest, cx) => {
  cx.out.write(`nika ${VERSION}\n`);
  return 0;
};
const showHelp = (rest, cx) => {
  cx.out.write(USAGE);
  return 0;
};

/**
 * The command table: every first word nika answers to, with its handler (`rest`, `cx`, the caller's `io`). The one place a command
 * is added, and the table a sub-orchestrator's deny list is built from (src/spawn.js `deniedTools`): every command here except
 * `spawn` and `status` is denied to it, so a new command is denied by default.
 */
const COMMANDS = {
  '--version': showVersion,
  '-v': showVersion,
  version: showVersion,
  help: showHelp,
  '-h': showHelp,
  '--help': showHelp,
  status: async (rest, cx) => {
    const o = parseStatusArgs(rest);
    const { snapshot } = await collect({ config: cx.config, exec: makeExec(), now: Date.now(), sinceMs: parseSince(o.since), since: o.since });
    cx.out.write(o.json ? `${toJson(snapshot)}\n` : renderStatus(snapshot, o, painter(cx.out, cx.env)));
    return 0;
  },
  serve: async (rest, cx, io) => {
    const { values } = parse(rest, { app: B });
    if (values.app) return serveAppCmd(cx, io);
    if (cx.config.port === null) throw new UsageError('NIKA_PORT must be a port number 1-65535');
    return serve(cx.config, io);
  },
  open: openCmd,
  app: appCmd,
  projects: projectsCmd,
  rules: rulesCmd,
  spawn: spawnCmd,
  orchestrate: orchestrateCmd,
  doctor: (rest, cx) => {
    parse(rest);
    return doctor(cx);
  },
  '_run-agent': (rest, cx) => { // hidden: the wrapper `spawn` starts inside a tmux pane
    if (rest.length !== 2) throw new UsageError('_run-agent takes <key> <name>');
    return runAgent(rest[0], rest[1], { env: cx.env, claudeBin: findClaude(cx.env), commands: COMMAND_NAMES, stderr: cx.err, spawn: cx.spawn });
  },
};
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));

export async function main(argv, env = process.env, io = { out: process.stdout, err: process.stderr }) {
  const [cmd = 'open', ...rest] = argv;
  const config = defaultConfig(env);
  // `io` may carry test doubles: in (stdin), cwd, platform, exec, spawn, serveApp, and for the app copy home, root, brewApps.
  const cx = {
    env, config, out: io.out, err: io.err, stdin: io.in ?? process.stdin, cwd: io.cwd ?? process.cwd(),
    platform: io.platform ?? process.platform, spawn: io.spawn ?? nodeSpawn, execT: (timeout) => io.exec ?? makeExec({ timeout }),
    home: io.home ?? os.homedir(), root: io.root ?? INSTALL_ROOT, brewApps: io.brewApps,
  };
  try {
    if (!Object.hasOwn(COMMANDS, cmd)) throw new UsageError(`unknown command ${clean(cmd, 60)}`);
    return await COMMANDS[cmd](rest, cx, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err.write(`nika: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof CliError) {
      io.err.write(`nika: ${err.message}\n`);
      return err.code;
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
