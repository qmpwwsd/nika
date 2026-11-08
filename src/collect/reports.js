// Orchestrator spawn reports (spawn.sh convention): <reports>/<name>.session holds the session uuid,
// <name>.md is the agent's report (first "STATUS:" line shown), <name>.rc the exit code once the pane closed.
// Report dirs are found below <tmpRoot>/*/*/scratchpad/reports, plus NIKA_REPORT_DIRS.
// These dirs are writable by agents, so every path component must be a real directory (no symlinks) and every
// file is opened with O_NOFOLLOW | O_NONBLOCK as a regular file owned by this user (review findings F1, F2).
import fs from 'node:fs/promises';
import path from 'node:path';
import { UUID } from '../ids.js';
import { readHead, isRealDir } from '../fsafe.js';
import { listProjects } from '../store.js';
import { reportsDir } from '../paths.js';
import { mapLimit } from '../util.js';

const NAME = /^([a-z0-9][a-z0-9._-]{0,127})\.session$/;
const STATUS_SCAN_BYTES = 4096;

async function realSubdirs(p) {
  try {
    return (await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(p, d.name));
  } catch {
    return [];
  }
}

export async function discoverReportDirs(tmpRoot, extraDirs = []) {
  const found = new Set();
  for (const project of await realSubdirs(tmpRoot)) {
    for (const session of await realSubdirs(project)) {
      const scratch = path.join(session, 'scratchpad');
      const dir = path.join(scratch, 'reports');
      if (await isRealDir(scratch) && await isRealDir(dir)) found.add(dir);
    }
  }
  // Extra dirs are configured by the owner, so symlinks there are accepted (resolved once).
  for (const d of extraDirs) {
    try {
      const real = await fs.realpath(d);
      if (await isRealDir(real)) found.add(real);
    } catch {
      // missing
    }
  }
  return [...found];
}

/** nika's own report dir of every registered project (spawned agents write there); a symlinked dir is not followed. */
export async function projectReportDirs(env) {
  const dirs = [];
  if (!env) return dirs; // a config without env (tests, 0.1 callers) has no registry
  for (const p of await listProjects(env)) {
    const dir = reportsDir(p.key, env);
    if (await isRealDir(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Every report dir for a config: the scratchpad ones, `reportDirs`, and nika's own per-project dirs. */
export async function allReportDirs(config) {
  const own = await projectReportDirs(config.env);
  return discoverReportDirs(config.tmpRoot, [...(config.reportDirs ?? []), ...own]);
}

async function safeText(file, max) {
  try {
    return await readHead(file, max);
  } catch {
    return null;
  }
}

/** Map sessionId → { name, reportPath | null, status | null, rc | null, mtimeMs }; newest .session wins. */
export async function indexReports(dirs) {
  const out = new Map();
  for (const dir of dirs) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    const set = new Set(names);
    await mapLimit(names, 16, async (n) => { // bounded, like the transcript index (verify N4)
      const m = NAME.exec(n);
      if (!m) return;
      const name = m[1];
      const sessionFile = path.join(dir, n);
      const raw = await safeText(sessionFile, 256);
      const sessionId = raw?.trim();
      if (!sessionId || !UUID.test(sessionId)) return;
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.lstat(sessionFile)).mtimeMs;
      } catch {
        return;
      }
      let reportPath = null;
      let status = null;
      if (set.has(`${name}.md`)) {
        const head = await safeText(path.join(dir, `${name}.md`), STATUS_SCAN_BYTES);
        if (head !== null) {
          reportPath = path.join(dir, `${name}.md`);
          const line = head.split('\n').find((l) => l.startsWith('STATUS:'));
          status = line ? line.trim().slice(0, 300) : null;
        }
      }
      let rc = null;
      if (set.has(`${name}.rc`)) {
        const v = (await safeText(path.join(dir, `${name}.rc`), 64))?.trim() ?? '';
        rc = /^-?\d{1,5}$/.test(v) ? Number(v) : null;
      }
      const prev = out.get(sessionId);
      if (!prev || prev.mtimeMs < mtimeMs) out.set(sessionId, { name, reportPath, status, rc, mtimeMs });
    });
  }
  return out;
}
