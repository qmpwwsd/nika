// Merges every source into Agent records and groups them by project.
import fs from 'node:fs';
import path from 'node:path';
import { readRegistry, processTable, isAlive } from './collect/registry.js';
import { indexTranscripts, readTranscript, createTranscriptCache } from './collect/transcripts.js';
import { readSubagents } from './collect/subagents.js';
import { listPanes } from './collect/tmux.js';
import { allReportDirs, indexReports } from './collect/reports.js';
import { resolveProject } from './collect/projects.js';
import { mapLimit } from './util.js';
import { clean } from './text.js';
import { UUID } from './ids.js';

const PROMPT_MAX = 200;
const IO_LIMIT = 16;
const LIVE_ORDER = { busy: 0, idle: 1 };

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** 'claude-opus-5-5' → 'Opus 5.5', 'claude-haiku-4-5-20251001' → 'Haiku 4.5', 'sonnet' → 'Sonnet'. */
export function modelLabel(id) {
  if (!id) return null;
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  if (/^(opus|sonnet|haiku|fable)$/.test(id)) return cap(id);
  return clean(id, 80);
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** Remote Control link. Registry ids look like session_<x>, transcript ids like cse_<x>; both map to session_<x>. */
export function bridgeUrl(id) {
  const m = /^(?:session|cse)_([A-Za-z0-9]{1,64})$/.exec(id ?? '');
  return m ? `https://claude.ai/code/session_${m[1]}` : null;
}

/** Claude Code's directory slug: every non-alphanumeric character becomes "-". */
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');

function liveRank(a) {
  return a.live ? (LIVE_ORDER[a.state] ?? 2) : 3;
}

function compareAgents(a, b) {
  return liveRank(a) - liveRank(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
}

function emptyCounts() {
  return { busy: 0, idle: 0, other: 0, ended: 0, total: 0 };
}

function count(counts, a) {
  if (!a.live) counts.ended += 1;
  else if (a.state === 'busy') counts.busy += 1;
  else if (a.state === 'idle') counts.idle += 1;
  else counts.other += 1;
  counts.total += 1;
}

/**
 * A cwd in a deleted scratchpad worktree (<tmpRoot>/<project-slug>/<session>/scratchpad/<wt>) has no repository
 * left on disk; its first path segment is the slug of the project the session ran in. Fold it into that project.
 */
function foldScratchpad(entries, tmpRoot) {
  const bySlug = new Map();
  for (const { project } of entries) {
    if (!project.root || !fs.existsSync(project.root)) continue;
    // Slugs are lossy ("/a/b-c" and "/a/b/c" share one): fold only when exactly one project has the slug (verify N3).
    const slug = slugOf(project.root);
    const prev = bySlug.get(slug);
    bySlug.set(slug, prev === undefined || prev?.key === project.key ? project : null);
  }
  for (const e of entries) {
    const cwd = e.agent.cwd;
    if (!cwd || !tmpRoot || e.project.worktree || fs.existsSync(e.project.root ?? '')) continue;
    const rel = path.relative(tmpRoot, cwd);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const target = bySlug.get(rel.split(path.sep)[0]);
    if (target) {
      e.project = target;
      e.agent.worktree = clean(path.basename(cwd), 120);
    }
  }
}

/**
 * @returns {{ snapshot: object, reportPaths: Map<string,string> }}
 *   snapshot is the public JSON (no file paths of reports); reportPaths stays server-side.
 */
export async function collect({ config, exec, now = Date.now(), sinceMs, since = null, cache = {} }) {
  cache.transcripts ??= createTranscriptCache();
  const [registry, table, index, tmux, reportDirs] = await Promise.all([
    readRegistry(config.claudeDir),
    processTable(exec),
    indexTranscripts(config.claudeDir),
    listPanes(exec, config.tmuxBin ?? 'tmux'),
    allReportDirs(config),
  ]);
  const reports = await indexReports(reportDirs);
  const sources = {
    registry: registry.error ?? 'ok',
    processes: table ? 'ok' : 'ps unavailable: liveness by signal 0',
    transcripts: index.error ?? 'ok',
    tmux: tmux.error ?? 'ok',
    reports: 'ok',
  };

  const live = new Map();
  for (const e of registry.entries) {
    if (!isAlive(e, table)) continue;
    const prev = live.get(e.sessionId);
    if (!prev || (prev.updatedAt ?? 0) < (e.updatedAt ?? 0)) live.set(e.sessionId, e);
  }
  const cutoff = sinceMs === Infinity ? -Infinity : now - sinceMs;
  const ids = new Set(live.keys());
  for (const [id, f] of index.files) if (f.mtimeMs >= cutoff) ids.add(id);

  const projectCache = new Map();
  const reportPaths = new Map();
  const results = await mapLimit([...ids], IO_LIMIT, async (id) => {
    const reg = live.get(id) ?? null;
    const file = index.files.get(id) ?? null;
    let t = null;
    if (file) {
      try {
        t = await readTranscript(file, cache.transcripts);
      } catch {
        t = null;
      }
    }
    // Not live and no user or assistant line: a title-only stub, not an agent (it made the "(unknown)" group, 0.1.1).
    if (!reg && t && !t.hasConversation) return null;
    const report = reports.get(id) ?? null;
    if (report?.reportPath) reportPaths.set(id, report.reportPath);
    const paneInfo = reg?.tmuxPane ? tmux.panes.get(reg.tmuxPane) ?? null : null;
    const cwd = reg?.cwd ?? t?.cwd ?? null;
    const project = resolveProject(cwd, projectCache);
    const isLive = Boolean(reg);
    const title = clean(t?.customTitle ?? t?.aiTitle, 300);
    const name = clean(report?.name, 128)
      ?? clean(paneInfo?.name, 128)
      ?? (reg?.nameSource === 'user' ? clean(reg.name, 128) : null)
      ?? title
      ?? clean(reg?.name, 128)
      ?? id.slice(0, 8);
    const subagents = (file ? await readSubagents(file) : [])
      .map((s) => ({
        id: s.id,
        type: clean(s.type, 80),
        description: clean(s.description, PROMPT_MAX),
        model: clean(s.model, 80),
        modelLabel: modelLabel(s.model),
        state: s.finished ? 'finished' : (isLive ? 'running' : 'stopped'),
        lastActivity: s.lastActivity,
      }))
      .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    const activity = [reg?.updatedAt, file?.mtimeMs, t?.lastTimestamp].filter(Number.isFinite);
    return {
      project,
      agent: {
        id,
        pid: reg?.pid ?? null,
        live: isLive,
        state: isLive ? (clean(reg.status, 32) ?? 'unknown') : 'ended',
        name,
        title,
        model: clean(t?.model, 80),
        modelLabel: modelLabel(t?.model),
        cwd,
        worktree: clean(project.worktree, 120),
        gitBranch: clean(t?.gitBranch, 200),
        version: clean(reg?.version ?? t?.version, 32),
        startedAt: reg?.startedAt ?? t?.startedAt ?? null,
        lastActivity: activity.length ? Math.max(...activity) : null,
        lastPrompt: clean(t?.lastPrompt, PROMPT_MAX),
        pane: paneInfo ? { id: paneInfo.id, session: clean(paneInfo.session, 80), title: clean(paneInfo.title, 200), command: clean(paneInfo.command, 80) } : null,
        bridgeUrl: bridgeUrl(reg?.bridgeSessionId ?? t?.bridgeSessionId),
        report: report ? { name: clean(report.name, 128), status: clean(report.status, 300), rc: report.rc, hasFile: Boolean(report.reportPath) } : null,
        subagents,
        resumeCmd: `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}claude --resume ${UUID.test(id) ? id : shellQuote(id)}`,
      },
    };
  });
  const entries = results.filter(Boolean);
  foldScratchpad(entries, config.tmpRoot);

  const groups = new Map();
  const counts = emptyCounts();
  for (const { project, agent } of entries) {
    let g = groups.get(project.key);
    if (!g) {
      g = { key: project.key, label: clean(project.label, 120) ?? '(unknown)', root: project.root, counts: emptyCounts(), lastActivity: 0, agents: [] };
      groups.set(project.key, g);
    }
    g.agents.push(agent);
    count(g.counts, agent);
    count(counts, agent);
    g.lastActivity = Math.max(g.lastActivity, agent.lastActivity ?? 0);
  }
  const sorted = [...groups.values()];
  for (const g of sorted) g.agents.sort(compareAgents);
  sorted.sort((a, b) => b.lastActivity - a.lastActivity || a.label.localeCompare(b.label));

  return {
    snapshot: { generatedAt: now, since, sources, counts, groups: sorted },
    reportPaths,
  };
}
