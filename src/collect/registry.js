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
  // Session ids end up in a shell command (Copy resume): only uuids pass (review F3). An upper-case uuid is the same id, kept in lower case.
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.toLowerCase() : '';
  if (!UUID.test(sessionId)) return null;
  const pane = /(%\d+)$/.exec(str(raw.tmux) ?? '');
  return {
    pid: raw.pid,
    sessionId,
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
    } catch (err) {
      // Claude deletes <pid>.json when a session exits: a file gone since readdir is a session that ended, not a file nika skipped
      if (err?.code !== 'ENOENT') skipped.push(n);
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

const DIGITS = /^\d+$/;
const STAT_MAX_BYTES = 4096;

/**
 * Field 22 (`starttime`, clock ticks since boot) of a /proc/<pid>/stat line, or null. The comm (field 2) may hold spaces
 * and parentheses, so the fields are counted from the text after the last `)`: token 0 is field 3, token 19 is field 22.
 */
export function parseStarttime(text) {
  if (typeof text !== 'string') return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const tokens = text.slice(close + 1).trim().split(/\s+/);
  // A real line has 44 fields or more; one that ends at field 22 was cut short and is not trusted.
  return tokens.length > 20 && DIGITS.test(tokens[19]) ? tokens[19] : null;
}

// readHead works on /proc files (regular, one link, owned by the process's user); a pid of another user fails and is left out.
const defaultReadStat = (pid) => readHead(`/proc/${pid}/stat`, STAT_MAX_BYTES);

/**
 * Map pid → `starttime` for the entries whose `procStart` is digits (Claude Code on Linux writes the /proc starttime;
 * on macOS it writes a date and nothing is read). A read or parse failure leaves that pid out.
 */
export async function procStarts(entries, readStat = defaultReadStat) {
  const starts = new Map();
  await Promise.all(entries.filter((e) => DIGITS.test(e.procStart ?? '')).map(async (e) => {
    try {
      const start = parseStarttime(await readStat(e.pid));
      if (start) starts.set(e.pid, start);
    } catch { /* unreadable: isAlive trusts ps for this pid */ }
  }));
  return starts;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = new RegExp(`^(?:${WEEKDAYS.join('|')}) (${MONTHS.join('|')}) (\\d{1,2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`);
// Only an ISO date-time counts as a parsed instant: V8's Date.parse also reads nonsense such as "hello 1" as a date
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** `Www Mmm d hh:mm:ss yyyy` (ps's shape, whitespace squashed) of an instant in this process's local time. */
function localLstart(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

// The instant is month, day, time and year: the weekday word and a zero before the day are dropped, so a writer that pads the day
// or names another weekday still names the same instant. Applied only to strings LSTART matched.
const instantKey = (s) => s.replace(/^\w+ (\w+) 0?(\d{1,2}) /, '$1 $2 ');

/**
 * Whether the registry's `procStart` (squashed) names the instant `ps` printed (`psText`, in UTC). A date string in ps's shape is
 * compared as text (instantKey) with that instant written out in UTC and in local time (Claude Code has been seen writing either; a local time
 * is never parsed back, because a repeated DST hour names two instants). An ISO date-time (`YYYY-MM-DDT…`) is compared to the second.
 * Anything else, or a `ps` text that is no date, cannot tell a reused pid from the process: it counts as the same, because ps listed the pid.
 */
function sameInstant(procStart, psText) {
  const m = LSTART.exec(psText);
  if (!m) return true;
  const at = Date.UTC(Number(m[6]), MONTHS.indexOf(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  if (LSTART.test(procStart)) return [psText, localLstart(at)].some((t) => instantKey(t) === instantKey(procStart));
  const iso = ISO.test(procStart) ? Date.parse(procStart) : NaN;
  return !Number.isFinite(iso) || Math.floor(iso / 1000) === at / 1000;
}

/**
 * Alive = pid present and, when the registry recorded a start time, the same start time (guards pid reuse).
 * A digits `procStart` is compared with `starts` (see procStarts); a pid missing there stays alive, because ps listed it.
 * A date or ISO `procStart` is compared as an instant (sameInstant).
 */
export function isAlive(entry, table, starts) {
  if (table) {
    const started = table.get(entry.pid);
    if (started === undefined) return false;
    if (!entry.procStart) return true;
    if (DIGITS.test(entry.procStart)) {
      const start = starts?.get(entry.pid);
      return start === undefined || start === entry.procStart;
    }
    const mine = squash(entry.procStart);
    return mine === started || sameInstant(mine, started);
  }
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
