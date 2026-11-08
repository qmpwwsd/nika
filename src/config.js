import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 3335;
export const DEFAULT_SINCE = '7d';
const MAX_SINCE_DAYS = 3650;

/** '24h' | '7d' | '30d' | 'all' (any <n>h / <n>d up to 10 years) → milliseconds; null when invalid. */
export function parseSince(value) {
  if (value === 'all') return Infinity;
  const m = /^(\d{1,5})([hd])$/.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const hours = m[2] === 'h' ? n : n * 24;
  if (n <= 0 || hours > MAX_SINCE_DAYS * 24) return null;
  return hours * 3_600_000;
}

/** Port from NIKA_PORT, or null when it is set but invalid. */
export function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Scratchpad root used by Claude Code for this user (spawn reports live below it). */
function defaultTmpRoot() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const base = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
  return path.join(base, `claude-${uid}`);
}

/**
 * tmux binary: NIKA_TMUX, else the first `tmux` on PATH, else the usual Homebrew locations (a launchd service may run
 * with a bare PATH, review F8), else plain "tmux" (reported as not found).
 */
export function findTmux(env = process.env) {
  if (env.NIKA_TMUX) return env.NIKA_TMUX;
  const dirs = [...(env.PATH || '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    const candidate = path.join(d, 'tmux');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return 'tmux';
}

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * claude binary as an absolute executable path, or null (never a bare name: it is run without a shell and a launchd
 * service has a bare PATH). NIKA_CLAUDE, else absolute PATH dirs (a relative entry would resolve against the cwd),
 * `~/.local/bin`, `~/.claude/local`, then `fallbackDirs` (a parameter so tests do not see the machine's own install).
 */
export function findClaude(env = process.env, fallbackDirs = ['/opt/homebrew/bin', '/usr/local/bin']) {
  if (env.NIKA_CLAUDE) return path.isAbsolute(env.NIKA_CLAUDE) && isExecutable(env.NIKA_CLAUDE) ? env.NIKA_CLAUDE : null;
  const home = env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  const dirs = [
    ...(env.PATH || '').split(':').filter((d) => path.isAbsolute(d)),
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), ...fallbackDirs,
  ];
  for (const d of dirs) {
    const candidate = path.join(d, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function defaultConfig(env = process.env) {
  return {
    // lets collect() find the project registry and nika's own report dirs (src/collect/reports.js projectReportDirs)
    env,
    claudeDir: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    tmpRoot: env.NIKA_TMP_ROOT || defaultTmpRoot(),
    reportDirs: (env.NIKA_REPORT_DIRS || '').split(':').filter(Boolean),
    port: parsePort(env.NIKA_PORT),
    tmuxBin: findTmux(env),
  };
}
