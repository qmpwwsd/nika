#!/usr/bin/env node
// DEV ONLY (not shipped: package.json "files" excludes scripts/). Rebuilds the README screenshots of the desktop app:
//   node scripts/screenshots.mjs [--out docs/screenshots] [--only <name>] [--root <dir>]
// It builds an invented machine (4 repositories, 11 agents, fake tmux and ps, invented plugins), runs nika's real app
// tier on it in this process (serveApp, the way the desktop shell starts it), and photographs the app's own pages with a
// local Google Chrome / Chromium (headless, driven over the DevTools protocol with Node's WebSocket): no npm package.
// Never touches the real ~/.claude, nika's real config or state, tmux or claude: every path comes from the invented
// world, the "tmux" and "ps" are functions below, Chrome may only reach 127.0.0.1. The world and the browser profile are
// deleted on exit. Needs Node 22.4+ and Chrome or Chromium (set CHROME to a binary to use another one).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveApp } from '../src/appio.js';
import { defaultConfig } from '../src/config.js';
import { addProject, updateProjectConfig, updateSettings } from '../src/store.js';
import { preview, apply } from '../src/rules.js';
import { NOW, PROC_START, jsonl } from '../test/helpers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = { width: 1280, height: 800 };
const THEMES = ['light', 'dark'];
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const COLS = 84; // pane width in columns: fits the terminal column of the session window at 1280 px
const ROWS = 34; // pane height in rows

// ---------------------------------------------------------------------------------------------------------------------
// Safety checks (pure, exported for test/screenshots.test.js)

/** A neutral place that renders without a user name or a temp folder: the shared folder of macOS (its /tmp is a symlink, so nika would store a /private path), /tmp elsewhere. */
export function defaultRoot(platform = process.platform) {
  return platform === 'darwin' ? path.join(path.sep, 'Users', 'Shared', 'nika-demo') : path.join(path.sep, 'tmp', 'nika-demo');
}

/** The only folder this script may create and later delete: absolute, normalized, named nika-demo*, not shallow. */
export function assertDemoRoot(root) {
  const ok = typeof root === 'string' && path.isAbsolute(root) && path.normalize(root) === root && !root.endsWith(path.sep)
    && /^nika-demo[A-Za-z0-9._-]*$/.test(path.basename(root)) && root.split(path.sep).length >= 3;
  if (!ok) throw new Error(`refusing to use ${JSON.stringify(root)} as the demo root: it must be an absolute path whose last part starts with nika-demo`);
  return root;
}

/** Every folder the server and the browser may use lies inside the world, so nothing real is read or written. */
export function assertInWorld(env, root) {
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'NIKA_CONFIG_DIR', 'XDG_STATE_HOME', 'TMUX_TMPDIR', 'NIKA_TMP_ROOT']) {
    const v = env[key];
    if (typeof v !== 'string' || path.normalize(v) !== v || !(v === root || v.startsWith(`${root}${path.sep}`))) {
      throw new Error(`${key} must point into the demo world (${key}=${JSON.stringify(v)})`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The invented machine

const uuid = (n) => { const c = '0123456789abcdef'[n]; return `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`; };
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');
const FIRST = 'claude-fable-5-1';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

// Footer of Claude's prompt box per permission mode (docs/contracts/claude-tui.md section 1): glyph, phrase, xterm-256 colour.
const FOOTER = {
  auto: ['⏵⏵', 'auto mode on', 220],
  manual: ['⏸', 'manual mode on', 246],
  acceptEdits: ['⏵⏵', 'accept edits on', 147],
  plan: ['⏸', 'plan mode on', 73],
};

/**
 * Live agents. state: busy | idle | waiting (waiting = needs you). `ago` = minutes since the last activity. `screen` says what the
 * pane shows: 'work' (a working screen), 'idle', 'review' (the reviewer's whole conversation), 'ask' (a plain question), 'prompt'
 * (a permission prompt).
 * Names of nika-started agents come from the pane title "[%n] name"; the others get their AI title as name.
 */
const LIVE = [
  { id: 1, repo: 'acme-api', pane: 11, name: 'planner', role: 'orchestrator', state: 'busy', mode: 'plan', model: FIRST, branch: 'master', ago: 1.5, screen: 'work', prompt: 'Add rate limiting to the login route and keep the public API unchanged', title: 'Rate limiting plan' },
  { id: 2, repo: 'acme-api', pane: 12, name: 'builder-1', role: 'agent', state: 'busy', mode: 'acceptEdits', model: SONNET, branch: 'feat/rate-limit', ago: 2.5, screen: 'work', prompt: 'Add rate limiting to the login route', title: 'Add rate limiting' },
  { id: 3, repo: 'acme-api', pane: 13, name: 'builder-2', role: 'agent', state: 'waiting', mode: 'auto', model: SONNET, branch: 'fix/token-refresh', ago: 7.5, screen: 'prompt', prompt: 'Fix the token refresh race in the auth client', title: 'Fix token refresh' },
  { id: 4, repo: 'acme-api', pane: 14, name: 'reviewer', role: 'agent', state: 'idle', mode: 'plan', model: OPUS, branch: 'feat/rate-limit', ago: 12.5, screen: 'review', prompt: 'Does the test suite cover window expiry?', title: 'Review rate limiting' },
  { id: 5, repo: 'web-shop', pane: 21, name: 'planner', role: 'orchestrator', state: 'idle', mode: 'plan', model: FIRST, branch: 'master', ago: 21.5, screen: 'idle', prompt: 'Plan the checkout redesign in three steps', title: 'Checkout redesign plan' },
  { id: 6, repo: 'web-shop', pane: 22, name: 'builder-1', role: 'agent', state: 'busy', mode: 'acceptEdits', model: SONNET, branch: 'feat/cart-total', ago: 3.5, screen: 'work', prompt: 'Write tests for the cart total', title: 'Cart total tests' },
  { id: 7, repo: 'web-shop', pane: 23, name: 'builder-2', role: 'agent', state: 'busy', mode: 'auto', model: SONNET, branch: 'feat/checkout-form', ago: 5.5, screen: 'work', prompt: 'Validate the checkout form fields on submit', title: 'Checkout form validation' },
  { id: 8, repo: 'docs-site', pane: 31, state: 'busy', mode: 'manual', model: SONNET, branch: 'docs/install-guide', ago: 1.5, screen: 'work', prompt: 'Rewrite the install guide for the new CLI', title: 'Rewrite install guide' },
  { id: 9, repo: 'docs-site', pane: 32, state: 'idle', mode: 'auto', model: HAIKU, branch: 'master', ago: 34.5, screen: 'idle', prompt: 'Find broken links in the docs', title: 'Check broken links' },
  { id: 10, repo: 'infra', pane: 41, state: 'waiting', mode: 'plan', model: OPUS, branch: 'chore/staging-vpc', ago: 15.5, screen: 'ask', prompt: 'Plan the staging VPC change', title: 'Staging VPC plan' },
  { id: 11, repo: 'infra', pane: 42, state: 'busy', mode: 'auto', model: SONNET, branch: 'master', ago: 6.5, screen: 'work', prompt: 'Summarize last month cloud costs by service', title: 'Cloud cost report' },
].map((a) => ({ ...a, sid: uuid(a.id), pid: 4100 + a.id }));

/** Agents that have ended: a transcript and no running process. `ago` in days. */
const ENDED = [
  { id: 12, repo: 'acme-api', model: HAIKU, branch: 'master', ago: 2, prompt: 'Find where login attempts are logged', title: 'Find login logging' },
  { id: 13, repo: 'acme-api', model: SONNET, branch: 'feat/request-id', ago: 3, prompt: 'Add a request id to every log line', title: 'Request id in logs' },
  { id: 14, repo: 'web-shop', model: OPUS, branch: 'feat/cart-refactor', ago: 1, prompt: 'Review the cart refactor for regressions', title: 'Review cart refactor' },
].map((a) => ({ ...a, sid: uuid(a.id) }));

const SUBAGENTS = [ // all on the acme-api orchestrator
  { id: 'a1', agentType: 'Explore', description: 'Find every caller of the login handler', model: 'haiku', finished: true, ago: 30 },
  { id: 'b2', agentType: 'general-purpose', description: 'Write tests for the rate limiter', model: 'sonnet', finished: false, ago: 2 },
  { id: 'c3', agentType: 'Plan', description: 'Check the order of the middleware', model: 'opus', finished: false, ago: 4 },
];

const REGISTERED = { 'acme-api': { plugins: ['test-runner@demo-plugins', 'lint-helper@demo-plugins'] }, 'web-shop': { plugins: ['test-runner@demo-plugins'] } };
const PLUGINS = ['test-runner@demo-plugins', 'lint-helper@demo-plugins', 'api-docs@demo-plugins', 'git-notes@demo-plugins'];
const SESSION_OF = 'reviewer'; // the agent whose session window is photographed (acme-api)
const SCREEN_NAMES = ['dashboard', 'session', 'project', 'rules', 'settings', 'spawn'];

// --- what a pane shows ---------------------------------------------------------------------------------------------

const sgr = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = (s) => sgr('2', s);
const bold = (s) => sgr('1', s);
const brand = (s) => sgr('38;5;173', s);
const green = (s) => sgr('32', s);
const rule = () => dim('─'.repeat(COLS));

function footerRow(mode) {
  const [glyph, text, colour] = FOOTER[mode];
  return ` ${sgr(`38;5;${colour}`, `${glyph} ${text}`)}${dim(' (shift+tab to cycle)')}`;
}

const inputBox = (mode) => [rule(), '❯ ', rule(), footerRow(mode)];

const TAIL = { // the end of the conversation per kind of screen (each row is a plain string with SGR)
  idle: [
    `${brand('●')} Done. The change is in place and the tests pass.`,
    '',
    '  Tell me what you want next.',
  ],
  review: [
    `${bold('❯')} ${dim('Review the rate limiting diff. Focus on the proxy setup and memory use.')}`,
    '',
    `${brand('●')} Bash(git diff master...HEAD --stat)`,
    '  ⎿  src/middleware/rateLimit.js | 54 +++++++++',
    '     src/routes/login.js         | 12 +-',
    '     test/rateLimit.test.js      | 61 +++++++++',
    '     3 files changed, 125 insertions(+), 2 deletions(-)',
    '',
    `${brand('●')} Read(src/middleware/rateLimit.js)`,
    '  ⎿  Read 54 lines',
    '',
    `${brand('●')} Three things to fix before this merges:`,
    '',
    '  1. The limiter keys on req.ip. Behind the load balancer every request',
    '     shares one address, so one client can lock out everyone.',
    '  2. The map is never pruned, so memory grows with every new address.',
    '  3. A 429 sends no Retry-After header, so clients retry at once.',
    '',
    `${bold('❯')} ${dim('Does the test suite cover window expiry?')}`,
    '',
    `${brand('●')} Grep(pattern: "useFakeTimers|advanceTimers", path: "test/")`,
    '  ⎿  No matches found',
    '',
    `${brand('●')} No. The tests cover the limit and the 429 body, but nothing moves the clock,`,
    '  so a window that never expires would still pass. Add a fake-timer test that',
    '  fills the window, advances 61 seconds and expects the next request to succeed.',
    '',
    '  The other findings stand. The first one is the one to fix before merging.',
  ],
  work: [
    `${brand('●')} Read(src/middleware/rateLimit.js)`,
    '  ⎿  Read 54 lines',
    '',
    `${brand('●')} Update(src/routes/login.js)`,
    `  ⎿  Updated src/routes/login.js with ${green('12 additions')} and 2 removals`,
    '       3  import { rateLimit } from "../middleware/rateLimit.js";',
    sgr('32', '       7 +router.post("/login", rateLimit({ windowMs: 60_000, max: 5 }), login);'),
    '',
    `${brand('✻')} Running tests… ${dim('(14s · ↑ 1.2k tokens · esc to interrupt)')}`,
  ],
  ask: [
    `${brand('●')} The plan needs one decision before I touch any Terraform:`,
    '',
    '  A. One /20 subnet per zone, three zones (4,096 addresses each).',
    '  B. A /19 for private subnets and a /22 for public ones.',
    '',
    '  B leaves room for a fourth zone later. A is simpler to read in the plan.',
    '  Which one do you want?',
  ],
  prompt: [
    `${brand('●')} Update(src/auth/refresh.js)`,
    `  ⎿  Updated src/auth/refresh.js with ${green('9 additions')} and 3 removals`,
    '',
    `${brand('●')} The refresh now takes a lock, so I will run the migration for the token table first.`,
    '',
    rule(),
    ` ${bold('Bash command')}`,
    '',
    '   npm run db:migrate -- --env test',
    dim('   Apply pending migrations to the test database'),
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for npm run db:migrate commands",
    '   3. No',
    ' Esc to cancel · Tab to amend',
  ],
};

/** capture-pane text for an agent: earlier output on top, then the tail; padded to ROWS rows. A permission prompt has no footer. */
function paneScreen(a, kind) {
  const earlier = kind === 'review' ? [] : [`${bold('❯')} ${dim(a.prompt)}`, '', `${brand('●')} I'll read the code first.`, '', `${brand('●')} Read(src)`, '  ⎿  Listed 14 files', ''];
  const tail = TAIL[kind];
  const box = kind === 'prompt' ? [] : inputBox(a.mode);
  const rows = [...earlier, ...tail, ...(kind === 'prompt' ? [] : ['']), ...box];
  const pad = Math.max(0, ROWS - rows.length);
  const text = [...Array(pad).fill(''), ...rows].slice(-ROWS).join('\n');
  const y = kind === 'prompt' ? ROWS - 1 : ROWS - 3;
  return { text, cursor: { x: kind === 'prompt' ? 0 : 2, y } };
}

// --- transcripts ---------------------------------------------------------------------------------------------------

const iso = (ms) => new Date(ms).toISOString();

function baseLines(a, cwd, at, extra = []) {
  const start = at - 40 * MIN;
  return [
    { type: 'permission-mode', permissionMode: a.mode ?? 'auto', sessionId: a.sid },
    { type: 'user', cwd, sessionId: a.sid, gitBranch: a.branch, version: '2.1.319', timestamp: iso(start), message: { role: 'user', content: a.prompt } },
    { type: 'assistant', cwd, sessionId: a.sid, gitBranch: a.branch, timestamp: iso(at), message: { role: 'assistant', model: a.model, content: [{ type: 'text', text: "I'll start by reading the code." }] } },
    ...extra,
    { type: 'ai-title', aiTitle: a.title, sessionId: a.sid },
    { type: 'last-prompt', lastPrompt: a.prompt, sessionId: a.sid },
  ];
}

/** The reviewer's conversation: what its session window lists. */
function reviewerLines(a, cwd, at) {
  const t = (min) => iso(at - min * MIN);
  const msg = (role, min, content) => ({ type: role, cwd, sessionId: a.sid, gitBranch: a.branch, version: '2.1.319', timestamp: t(min), message: { role, ...(role === 'assistant' ? { model: a.model } : {}), content } });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const res = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
  return [
    { type: 'permission-mode', permissionMode: 'plan', sessionId: a.sid },
    msg('user', 38, 'Review the rate limiting diff. Focus on the proxy setup and memory use.'),
    msg('assistant', 37, [{ type: 'text', text: 'I will start with the diff against master.' }]),
    msg('assistant', 37, [use('t1', 'Bash', { command: 'git diff master...HEAD --stat' })]),
    msg('user', 36, [res('t1', ' src/middleware/rateLimit.js | 54 +++++++++\n src/routes/login.js         | 12 +-\n test/rateLimit.test.js      | 61 +++++++++\n 3 files changed, 125 insertions(+), 2 deletions(-)')]),
    msg('assistant', 35, [use('t2', 'Read', { file_path: 'src/middleware/rateLimit.js' })]),
    msg('user', 34, [res('t2', 'const hits = new Map();\n\nexport function rateLimit({ windowMs, max }) {\n  return (req, res, next) => {\n    const key = req.ip;\n    const now = Date.now();\n    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);\n    recent.push(now);\n    hits.set(key, recent);\n    if (recent.length > max) return res.status(429).json({ error: "too many requests" });\n    next();\n  };\n}')]),
    msg('assistant', 30, [{ type: 'text', text: 'Three things to fix before this merges:\n\n1. The limiter keys on req.ip. Behind the load balancer every request shares one address, so one client can lock out everyone. Use the forwarded address the proxy sets.\n2. The map is never pruned, so memory grows with every new address.\n3. A 429 sends no Retry-After header, so clients retry at once.\n\nThe tests cover the happy path and the limit, but not window expiry.' }]),
    msg('user', 14, 'Does the test suite cover window expiry?'),
    msg('assistant', 13, [use('t3', 'Grep', { pattern: 'useFakeTimers|advanceTimers', path: 'test/' })]),
    msg('user', 13, [res('t3', 'No matches found')]),
    msg('assistant', 13, [{ type: 'text', text: 'No. The tests cover the limit and the 429 body, but nothing moves the clock, so a window that never expires would still pass. Add a fake-timer test that fills the window, advances 61 seconds and expects the next request to succeed.\n\nThe other findings stand. The first one is the one to fix before merging.' }]),
    { type: 'ai-title', aiTitle: a.title, sessionId: a.sid },
    { type: 'last-prompt', lastPrompt: a.prompt, sessionId: a.sid },
  ];
}

// --- the world on disk ---------------------------------------------------------------------------------------------

function put(file, content, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

const NOTES = (name, what) => `# ${name}\n\n${what}\n\nRun the tests with \`npm test\`. Keep route handlers thin; business rules live in \`src/\`.\n`;

function writeRepos(root) {
  for (const repo of ['acme-api', 'web-shop', 'docs-site', 'infra']) {
    put(path.join(root, repo, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    put(path.join(root, repo, 'README.md'), `# ${repo}\n`);
  }
  put(path.join(root, 'acme-api', 'CLAUDE.md'), NOTES('acme-api', 'HTTP API for the Acme demo company. Node 22, Express, PostgreSQL.'));
  put(path.join(root, 'acme-api', '.gitignore'), 'node_modules/\n.claude/settings.local.json\n');
  put(path.join(root, 'web-shop', 'CLAUDE.md'), NOTES('web-shop', 'Storefront for the demo shop. Node 22, Express, server-rendered pages.'));
  put(path.join(root, 'web-shop', '.gitignore'), 'node_modules/\ndist/\n');
}

function writeClaudeDir(root, env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  const cwdOf = (a) => path.join(root, a.repo);
  for (const a of LIVE) {
    const at = NOW - a.ago * MIN;
    const cwd = cwdOf(a);
    put(path.join(dir, 'sessions', `${a.pid}.json`), JSON.stringify({
      pid: a.pid, kind: 'interactive', version: '2.1.319', procStart: PROC_START, startedAt: NOW - 90 * MIN, updatedAt: at,
      sessionId: a.sid, cwd, name: a.title, nameSource: 'derived', status: a.state, tmux: `${a.repo}:@1.%${a.pane}`,
    }));
    const lines = a.name === SESSION_OF ? reviewerLines(a, cwd, at) : baseLines(a, cwd, at);
    put(path.join(dir, 'projects', slugOf(cwd), `${a.sid}.jsonl`), jsonl(lines), at);
  }
  for (const a of ENDED) {
    const at = NOW - a.ago * DAY;
    const cwd = cwdOf(a);
    put(path.join(dir, 'projects', slugOf(cwd), `${a.sid}.jsonl`), jsonl(baseLines(a, cwd, at)), at);
  }
  const orch = LIVE.find((a) => a.repo === 'acme-api' && a.role === 'orchestrator');
  const subs = path.join(dir, 'projects', slugOf(cwdOf(orch)), orch.sid, 'subagents');
  for (const s of SUBAGENTS) {
    put(path.join(subs, `agent-${s.id}.meta.json`), JSON.stringify({ agentType: s.agentType, description: s.description, model: s.model, finished: s.finished }));
    put(path.join(subs, `agent-${s.id}.jsonl`), jsonl([{ type: 'user', isSidechain: true }]), NOW - s.ago * MIN);
  }
  put(path.join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 1, plugins: Object.fromEntries(PLUGINS.map((p) => [p, [{ scope: 'user', version: '1.0.0' }]])),
  }));
}

/** Fills `root` (a folder this run has just created) with the invented machine and returns what the server and the browser need. */
async function buildWorld(root) {
  const real = fs.realpathSync(root);
  if (real !== root) throw new Error(`${root} resolves to ${real}: pass a --root whose path has no symlink, so the shots show the same path nika stores`);
  const env = {
    HOME: root, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: path.join(root, '.claude'), NIKA_CONFIG_DIR: path.join(root, '.config'),
    XDG_STATE_HOME: path.join(root, '.local', 'state'), TMUX_TMPDIR: path.join(root, '.tmux'), NIKA_TMP_ROOT: path.join(root, '.tmp'),
    NIKA_TMUX: '/usr/bin/tmux', NIKA_CLAUDE: path.join(root, '.bin', 'claude'),
  };
  assertInWorld(env, root);
  for (const d of [env.TMUX_TMPDIR, env.NIKA_TMP_ROOT]) fs.mkdirSync(d, { recursive: true });
  put(env.NIKA_CLAUDE, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(env.NIKA_CLAUDE, 0o755); // only has to look installed: nothing runs it
  writeRepos(root);
  writeClaudeDir(root, env);

  const projects = {};
  for (const name of Object.keys(REGISTERED)) projects[name] = await addProject(path.join(root, name), env);
  await updateSettings({ permissionMode: 'acceptEdits', limits: { maxAgents: 5 }, remoteControl: { enabled: true, prefix: 'acme' } }, env);
  for (const [name, r] of Object.entries(REGISTERED)) await updateProjectConfig(projects[name].key, { plugins: r.plugins }, env);

  // acme-api already has current rules: written by nika's own apply, so the shot shows a real "Rules current"
  const ctx = { env, now: () => NOW };
  const p = await preview(projects['acme-api'], ctx);
  const done = await apply(projects['acme-api'], { hash: p.body.hash, overwriteForeign: false, gitignore: false }, ctx);
  if (done.status !== 200) throw new Error(`could not write the demo rules: ${JSON.stringify(done.body)}`);

  const panes = new Map(LIVE.map((a) => [`%${a.pane}`, a]));
  // every pane starts on a normal screen (footer visible); the two that need you switch to theirs after nika has read the modes
  const kinds = new Map(LIVE.map((a) => [`%${a.pane}`, a.screen === 'prompt' ? 'idle' : a.screen]));
  return { root, env, projects, panes, kinds, clock: { skew: 0 } };
}

/** Fake `ps` and `tmux` for serveApp: nothing real is ever run, and a command nika should not run here fails loudly. */
function fakeExec(world) {
  return async (cmd, args) => {
    if (cmd.endsWith('/ps')) return { stdout: `${LIVE.map((a) => `${a.pid} ${PROC_START}`).join('\n')}\n`, stderr: '' };
    if (cmd !== world.env.NIKA_TMUX || args[0] !== '-u') throw new Error(`demo world: unexpected command ${cmd} ${args.join(' ')}`);
    const target = args[args.indexOf('-t') + 1];
    switch (args[1]) {
      case 'list-panes':
        return { stdout: `${LIVE.map((a) => [`%${a.pane}`, a.repo, 0, a.role ? `[%${a.pane}] ${a.name}` : 'claude', 'claude', a.role ?? ''].join('\t')).join('\n')}\n`, stderr: '' };
      case 'capture-pane':
        return { stdout: paneScreen(world.panes.get(target), world.kinds.get(target)).text, stderr: '' };
      case 'display-message': {
        const { cursor } = paneScreen(world.panes.get(target), world.kinds.get(target));
        return { stdout: `${COLS}\t${ROWS}\t${cursor.x}\t${cursor.y}\t1\n`, stderr: '' };
      }
      default:
        throw new Error(`demo world: unexpected tmux ${args.join(' ')}`);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The server: nika's real app tier, in this process

async function startServer(world) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.on('data', (c) => process.stderr.write(`server: ${c}`));
  const lines = [];
  let buffer = '';
  const waiting = [];
  stdout.setEncoding('utf8');
  stdout.on('data', (c) => {
    buffer += c;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
      for (const w of waiting.splice(0)) w();
    }
  });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the app tier did not start in time')), 15_000);
    const check = () => {
      const hit = lines.find((l) => l.type === 'ready');
      if (hit) { clearTimeout(t); resolve(hit); } else waiting.push(check);
    };
    check();
  });
  const done = serveApp({
    config: defaultConfig(world.env), env: world.env, stdin, stdout, stderr, exec: fakeExec(world), now: () => NOW + world.clock.skew, intervalMs: 3_600_000,
    // no ~/Applications to look at: the "Add nika to Applications" notice does not apply (not macOS here)
    appCopy: { platform: 'linux', home: world.root, root: world.root, brewApps: [], exec: async () => { throw new Error('demo world: no app copy'); } },
  });
  stdin.write(`${JSON.stringify({ type: 'hello', proto: 1, secret })}\n`);
  const { port } = await ready;
  return { port, secret, stop: async () => { stdin.end(); await done; } };
}

/** GET /api/app/<path> with the secret (the same call the page makes), as parsed JSON. */
function appGet(server, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: p, headers: { 'X-Nika-App': server.secret } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error(`GET ${p}: ${res.statusCode}`))));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Chrome over the DevTools protocol

function findChrome(env = process.env) {
  if (env.CHROME) return env.CHROME;
  const fixed = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : [];
  const named = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const onPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((d) => named.map((n) => path.join(d, n)));
  const found = [...fixed, ...onPath].find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
  if (!found) throw new Error('no Google Chrome or Chromium found: install one, or set CHROME to its binary');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchChrome(world, port) {
  if (typeof WebSocket === 'undefined') throw new Error('this Node has no WebSocket: use Node 22.4 or newer');
  const profile = path.join(world.root, '.chrome');
  const child = spawn(findChrome(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${VIEW.width},${VIEW.height}`, '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings', '--disable-default-apps',
    '--disable-crash-reporter', '--disable-breakpad', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    // HOME is the demo folder, so on macOS the network stack would wait for a keychain that is not there: every
    // request to the server then hangs (seen with Chrome 155). A mock keychain keeps the run off the user's keychain.
    '--use-mock-keychain', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], env: { PATH: world.env.PATH, HOME: world.root, TMPDIR: world.root } });
  const exited = new Promise((r) => child.once('exit', r));
  let debugPort = null;
  for (let i = 0; i < 100 && debugPort === null; i += 1) {
    try { debugPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(100); }
  }
  if (!debugPort) { child.kill(); throw new Error('Chrome did not open its DevTools port'); }
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('cannot connect to Chrome')); });
  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject, method });
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await send('Emulation.setLocaleOverride', { locale: 'en-US' });
  // The real shell defines this before any page script runs; here only the server's own origin gets it. The clock starts at NOW.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (location.origin === 'http://127.0.0.1:${port}') {
      window.__NIKA_APP__ = { secret: ${JSON.stringify(world.secret)}, port: ${port} };
      const R = Date; const off = ${NOW} - R.now();
      const F = function (...a) { return a.length ? new R(...a) : new R(R.now() + off); };
      Object.setPrototypeOf(F, R); F.prototype = R.prototype; F.now = () => R.now() + off; F.parse = R.parse; F.UTC = R.UTC;
      window.Date = F;
    }` });
  return {
    send, evaluate, problems,
    async theme(name) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: name }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    },
    async waitFor(expression, what) {
      for (let i = 0; i < 150; i += 1) {
        if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    async shot() {
      await evaluate('document.activeElement?.blur()');
      await sleep(400);
      return Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64');
    },
    async close() {
      ws.close();
      child.kill('SIGTERM');
      if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]) === false) { child.kill('SIGKILL'); await exited; }
    },
    pid: child.pid,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The six screens

const click = (selector) => `document.querySelector(${JSON.stringify(selector)}).click()`;
const ROWS_READY = `document.querySelectorAll('#dash-body .row').length >= ${LIVE.length} && document.querySelectorAll('#dash-body .c-mode .mode').length >= ${LIVE.length} && document.querySelectorAll('#side-projects a').length >= 2 && !document.querySelector('#side-det[hidden]')`;

function screens(world) {
  const acme = world.projects['acme-api'];
  const shop = world.projects['web-shop'];
  const session = LIVE.find((a) => a.repo === 'acme-api' && a.name === SESSION_OF);
  const projectReady = (key) => `location.hash === '#project/${key}' && document.querySelector('#proj-body').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#proj-setup .card').length === 3 && document.querySelectorAll('#proj-agents .row').length >= 3`;
  return {
    dashboard: { url: '/#dashboard', ready: ROWS_READY },
    session: {
      url: `/session.html?session=${session.sid}&pane=%25${session.pane}&project=${acme.key}`,
      ready: `document.querySelectorAll('#hx-list > li').length >= 6 && document.querySelectorAll('#term-rows > *').length >= 20 && !document.querySelector('#mode-switch[hidden]') && document.querySelector('#qa-compact').getAttribute('aria-disabled') !== 'true'`,
    },
    project: {
      url: `/#project/${acme.key}`, ready: projectReady(acme.key),
      prep: click('#proj-agents details.subs summary'),
    },
    rules: {
      url: `/#project/${shop.key}`, ready: projectReady(shop.key),
      prep: click('[data-fk="rules-open"]'), after: `document.querySelectorAll('#ru-main .files button').length === 4`,
    },
    settings: {
      url: '/#settings', ready: `document.querySelectorAll('#set-model-builder option').length > 4 && document.querySelector('#set-max').value === '5'`,
      prep: "document.getElementById('s-models').scrollIntoView()",
    },
    spawn: {
      url: `/#project/${acme.key}`, ready: projectReady(acme.key),
      prep: `${click(`#proj-actions [data-fk^="spawn:"]`)}; setTimeout(() => { const b = document.getElementById('sp-brief'); b.value = 'Add pagination to GET /orders. Keep the response shape, cap the page size at 100 and add tests for the limits.'; b.dispatchEvent(new Event('input', { bubbles: true })); }, 50)`,
      after: `document.getElementById('dlg-spawn').open && document.getElementById('sp-brief').value.length > 20`,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------

export { LIVE, COLS, ROWS, paneScreen }; // test/screenshots.test.js checks that nika's own parsers read the invented screens

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string', default: path.join(REPO, 'docs', 'screenshots') }, only: { type: 'string' }, root: { type: 'string' } } });
  const root = assertDemoRoot(values.root ?? defaultRoot());
  const out = path.resolve(values.out);
  let world = null;
  let server = null;
  let chrome = null;
  let created = false;
  const cleanup = async () => {
    await chrome?.close().catch(() => {});
    await server?.stop().catch(() => {});
    if (created) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => cleanup().finally(() => process.exit(130)));

  try {
    if (values.only !== undefined && !SCREEN_NAMES.includes(values.only)) throw new Error(`--only must be one of ${SCREEN_NAMES.join(', ')}`);
    try {
      fs.mkdirSync(root); // not recursive: an existing folder is refused, never merged into
      created = true;
    } catch (err) {
      throw err.code === 'EEXIST' ? new Error(`${root} already exists (a run that was interrupted?): remove it, or pass another --root`) : err;
    }
    world = await buildWorld(root);
    server = await startServer(world);
    world.secret = server.secret;

    // Read every pane once with its normal screen, so nika remembers each mode; then the prompts replace two footers
    await appGet(server, '/api/app/modes');
    for (const a of LIVE) world.kinds.set(`%${a.pane}`, a.screen);
    world.clock.skew += 60_000; // caches expire on this clock, not on real time
    chrome = await launchChrome(world, server.port);

    fs.mkdirSync(out, { recursive: true });
    const plan = screens(world);
    for (const name of values.only ? [values.only] : SCREEN_NAMES) {
      for (const theme of THEMES) {
        const s = plan[name];
        await chrome.theme(theme);
        await chrome.send('Page.navigate', { url: 'about:blank' }); // a fresh document every time: no state from the last shot
        await chrome.send('Page.navigate', { url: `http://127.0.0.1:${server.port}${s.url}` });
        await chrome.waitFor(s.ready, `the ${name} screen`);
        if (s.prep) await chrome.evaluate(s.prep);
        if (s.after) await chrome.waitFor(s.after, `the ${name} dialog`);
        const png = await chrome.shot();
        const file = path.join(out, `${name}-${theme}.png`);
        fs.writeFileSync(file, png);
        console.log(`${path.relative(process.cwd(), file)}  ${(png.length / 1024).toFixed(0)} KB`);
        if (png.length > 300 * 1024) console.warn(`warning: ${file} is over 300 KB`);
      }
    }
    if (chrome.problems.length) console.warn(`page errors:\n${[...new Set(chrome.problems)].join('\n')}`);
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (err) => { console.error(`screenshots: ${err.message}`); process.exit(1); });
}
