// Merges every source into Agent records and groups them by project.
import fs from 'node:fs';
import path from 'node:path';
import { readRegistry, processTable, isAlive } from './collect/registry.js';
import { indexTranscripts, readTranscript, createTranscriptCache, CACHE_SLACK } from './collect/transcripts.js';
import { readSubagents } from './collect/subagents.js';
import { listPanes } from './collect/tmux.js';
import { allReportDirs, indexReports } from './collect/reports.js';
import { resolveProject } from './collect/projects.js';
import { mapLimit } from './util.js';
import { clean } from './text.js';
import { UUID } from './ids.js';
import { MODEL_CATALOG } from './models.js';
import { keyFor } from './store.js';

const PROMPT_MAX = 200;
const IO_LIMIT = 16;
const LIVE_ORDER = { busy: 0, idle: 1 };

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const CATALOG_LABEL = new Map(MODEL_CATALOG.map((m) => [m.id, m.label]));

/** Catalog label first ('opusplan' → 'Opus plan, Sonnet build'), else derived: 'claude-haiku-4-5-20251001' → 'Haiku 4.5'. */
export function modelLabel(id) {
  if (!id) return null;
  if (CATALOG_LABEL.has(id)) return CATALOG_LABEL.get(id);
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
 * The tree fields of contract C6, from the panes' own nika tags (set by nika, read strictly by collect/tmux.js): `parent` is the
 * parent's session id when its pane maps to a live session here, else the pane id; `depth` 1 to 3; `children` the ids of the live
 * agents whose parent it is. Only agents and sub-orchestrators have a parent. A self-parent or a loop is cut: every member of it
 * becomes a root at depth 1. Ended agents keep the null, null and [] they were built with.
 */
function linkTree(entries) {
  const live = entries.filter((e) => e.agent.live);
  const byPane = new Map(live.filter((e) => e.tags).map((e) => [e.tags.id, e]));
  const parentPane = (e) => (e.agent.role === 'agent' || e.agent.role === 'sub-orchestrator' ? e.tags.parent : null);
  const inLoop = (e) => {
    let n = byPane.get(parentPane(e));
    for (let hops = 0; n && hops <= live.length; hops += 1) {
      if (n === e) return true;
      n = byPane.get(parentPane(n));
    }
    return false;
  };
  const loops = new Set(live.filter(inLoop)); // decided before any link is made
  for (const e of live) {
    const { agent } = e;
    const pane = loops.has(e) ? null : parentPane(e);
    const parent = byPane.get(pane);
    agent.parent = parent ? parent.agent.id : pane;
    agent.depth = loops.has(e) || agent.role === 'orchestrator' ? 1 : agent.role === 'sub-orchestrator' ? 2 : e.tags?.depth ?? (pane ? 2 : 1);
    parent?.agent.children.push(agent.id);
  }
}

/**
 * `include`: session ids listed whatever their age, when nika has a transcript for them (the app tier looks up a saved orchestrator).
 * `indexOnly`: read the transcript index and nothing else (findSessions).
 * @returns {{ snapshot: object, reportPaths: Map<string,string> }}
 *   snapshot is the public JSON (no file paths of reports); reportPaths stays server-side.
 */
export async function collect({ config, exec, now = Date.now(), sinceMs, since = null, cache = {}, include = [], indexOnly = false }) {
  cache.transcripts ??= createTranscriptCache();
  // indexOnly: just the transcript index (findSessions); no registry, ps, tmux or reports, so nothing is live
  const [registry, table, index, tmux, reportDirs] = indexOnly
    ? [{ entries: [], error: null }, null, await indexTranscripts(config.claudeDir), { panes: new Map(), error: null }, []]
    : await Promise.all([
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
  for (const id of include) if (index.files.has(id)) ids.add(id);

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
    const state = isLive ? (clean(reg.status, 32) ?? 'unknown') : 'ended';
    const activity = [reg?.updatedAt, file?.mtimeMs, t?.lastTimestamp].filter(Number.isFinite);
    return {
      project,
      agent: {
        id,
        pid: reg?.pid ?? null,
        live: isLive,
        state,
        role: paneInfo?.role ?? null,
        parent: null, // linkTree() fills these three for a live agent
        depth: null,
        children: [],
        // what a live agent that is neither busy nor idle is doing (e.g. waiting on a permission prompt)
        attention: isLive && state !== 'busy' && state !== 'idle' ? clean(reg.status, 80) : null,
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
      tags: paneInfo, // the pane's raw nika tags for linkTree(); never part of the snapshot
    };
  });
  // after the reads, so the entries just used are the newest and the ones of vanished or long-idle transcripts go first
  if (!index.error) cache.transcripts.resize(index.files.size + CACHE_SLACK);
  const entries = results.filter(Boolean);
  foldScratchpad(entries, config.tmpRoot);
  linkTree(entries);

  const groups = new Map();
  const counts = emptyCounts();
  for (const { project, agent } of entries) {
    let g = groups.get(project.key);
    if (!g) {
      g = { key: keyFor(project.root ?? project.key), label: clean(project.label, 120) ?? '(unknown)', root: project.root, counts: emptyCounts(), lastActivity: 0, agents: [] };
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

/**
 * One session by id, whatever its age: `{ agent, group }` (the group is its project's, with the live sessions beside it), or null
 * when nika has neither a live registry entry nor a transcript for it. The id is only a lookup key, never a path. Throws EINDEX
 * when it is not found and the transcript index could not be read: "not found" would then be a guess.
 * @param {object} o { config, exec, now?, cache? } as collect()
 */
export async function findSession(id, { config, exec, now = Date.now(), cache = {} }) {
  // a zero window: the snapshot holds the live sessions and the one asked for, so the lookup reads one transcript
  const { snapshot } = await collect({ config, exec, now, sinceMs: 0, cache, include: [id] });
  for (const group of snapshot.groups) {
    const agent = group.agents.find((a) => a.id === id);
    if (agent) return { agent, group };
  }
  if (snapshot.sources.transcripts !== 'ok') throw Object.assign(new Error('transcript index unavailable'), { code: 'EINDEX' });
  return null;
}

/**
 * Several sessions by id with ONE walk of the transcript index and no ps, tmux, registry or report read: `Map(id → { agent, group })`
 * for the ids nika has a transcript for (an id it has none for is left out). It never answers "live" (there is no registry here), so
 * callers ask only for ids the live snapshot did not hold. Throws EINDEX when an id is missing and the index could not be read.
 * shortcut: a session whose folder is a deleted scratchpad worktree is not folded into its project here (that needs every session
 * of the run), so its group is its own folder; upgrade by passing the registered projects to foldScratchpad.
 * @param {object} o { config, now?, cache? } as collect()
 */
export async function findSessions(ids, { config, now = Date.now(), cache = {} }) {
  const found = new Map();
  if (!ids.length) return found;
  const { snapshot } = await collect({ config, exec: null, now, sinceMs: 0, cache, include: ids, indexOnly: true });
  const wanted = new Set(ids);
  for (const group of snapshot.groups) for (const agent of group.agents) if (wanted.has(agent.id)) found.set(agent.id, { agent, group });
  if (found.size < wanted.size && snapshot.sources.transcripts !== 'ok') throw Object.assign(new Error('transcript index unavailable'), { code: 'EINDEX' });
  return found;
}
