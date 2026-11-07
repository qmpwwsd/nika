// Live session registry: <claudeDir>/sessions/<pid>.json, one file per running Claude Code process.
// Only <pid>.json files are read; the *.key files next to them are never opened (rules/project-rules.md §4).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readHead } from '../fsafe.js';
import { UUID } from '../ids.js';

const REGISTRY_FILE = /^\d+\.json$/;
const MAX_BYTES = 64 * 1024;
const MAX_DATE_MS = 8.64e15;

const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
// Timestamps outside the Date range would throw in the UI (review F15).
const ms = (v) => (Number.isFinite(v) && v > 0 && v < MAX_DATE_MS ? v : null);

function normalise(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  // Session ids end up in a shell command (Copy resume): only uuids pass (review F3).
  if (typeof raw.sessionId !== 'string' || !UUID.test(raw.sessionId)) return null;
  const pane = /(%\d+)$/.exec(str(raw.tmux) ?? '');
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    cwd: str(raw.cwd),
    name: str(raw.name),
    nameSource: str(raw.nameSource),
    status: str(raw.status),
    kind: str(raw.kind),
    tmuxPane: pane ? pane[1] : null,
    version: str(raw.version),
    startedAt: ms(raw.startedAt),
    updatedAt: ms(raw.updatedAt),
    procStart: str(raw.procStart),
    bridgeSessionId: str(raw.bridgeSessionId),
  };
}

export async function readRegistry(claudeDir) {
  const dir = path.join(claudeDir, 'sessions');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    return { entries: [], skipped: [], error: `cannot read ${dir}: ${err.code ?? err.message}` };
  }
  const entries = [];
  const skipped = [];
  await Promise.all(names.filter((n) => REGISTRY_FILE.test(n)).map(async (n) => {
    try {
      const entry = normalise(JSON.parse(await readHead(path.join(dir, n), MAX_BYTES)));
      if (entry) entries.push(entry); else skipped.push(n);
    } catch {
      skipped.push(n);
    }
  }));
  skipped.sort();
  return { entries, skipped, error: null };
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Map pid → process start time ("Sat Nov 7 18:57:14 2026", whitespace squashed); null when ps fails or prints nothing.
 * Claude Code writes `procStart` in UTC, so ps runs with TZ=UTC (and the C locale) to print the same clock.
 */
export async function processTable(exec) {
  try {
    const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=,lstart='], { env: { TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
    const table = new Map();
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (m) table.set(Number(m[1]), squash(m[2]));
    }
    // An empty table would mark every session dead; treat it as "ps unavailable" instead (review F13).
    return table.size ? table : null;
  } catch {
    return null;
  }
}

/** Alive = pid present and, when the registry recorded a start time, the same start time (guards pid reuse). */
export function isAlive(entry, table) {
  if (table) {
    const started = table.get(entry.pid);
    if (started === undefined) return false;
    return !entry.procStart || squash(entry.procStart) === started;
  }
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
