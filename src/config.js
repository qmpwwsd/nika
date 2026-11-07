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

export function defaultConfig(env = process.env) {
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    tmpRoot: env.NIKA_TMP_ROOT || defaultTmpRoot(),
    reportDirs: (env.NIKA_REPORT_DIRS || '').split(':').filter(Boolean),
    port: parsePort(env.NIKA_PORT),
    tmuxBin: findTmux(env),
  };
}
