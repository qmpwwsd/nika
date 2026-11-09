// Pure decisions of the dashboard and the sidebar (no DOM, no network; both tiers may load it). app.js and project.js draw
// what these functions return, so Node tests cover the rules without a browser.

/** Most rows the sidebar's Detected list shows. */
export const DETECTED_MAX = 8;

/**
 * What one group draws for its ended agents. `live` and `ended` are counts. `collapsed` = the user folded this section by hand.
 * "Show ended" off: the ended agents are not drawn, and a group with nothing live says so in one line. On: the section, open
 * unless folded by hand. The project view always passes showEnded = true.
 */
export function endedPlan({ live, ended, showEnded, collapsed = false }) {
  const endedSection = showEnded && ended > 0;
  return { endedSection, open: endedSection && !collapsed, noLiveLine: !showEnded && live === 0 && ended > 0 };
}

/** Forget what the user opened or folded in the dashboard's Ended sections (`ended:g:<key>` and `!ended:g:<key>`); the project view's stay. */
export function resetEndedState(open) {
  for (const id of [...open]) if (/^!?ended:g:/.test(id)) open.delete(id);
}

/**
 * The sidebar: `rows` = the registered projects (with their counts), `empty` = there are none (the page shows its hint),
 * `detected` = repositories that run live agents but are not registered, most urgent first, at most DETECTED_MAX.
 * `groups` are the dashboard's groups (`project`, `key`, `root`, `label`, `counts`). `projects` = null means the list has not
 * loaded: no hint and no Detected (without it nika cannot tell which repositories are registered), so nothing is drawn yet.
 */
export function sidebarModel({ projects, groups }) {
  if (!projects) return { empty: false, rows: [], detected: [] };
  const byProject = new Map(groups.filter((g) => g.project).map((g) => [g.project.key, g]));
  const rows = projects.map((p) => ({ key: p.key, name: p.name, attn: byProject.get(p.key)?.counts.attn ?? 0, live: byProject.get(p.key)?.counts.live ?? 0 }));
  const keys = new Set(projects.map((p) => p.key));
  const dirs = new Set(projects.map((p) => p.dir));
  const detected = groups
    .filter((g) => !g.project && !keys.has(g.key) && !dirs.has(g.root) && g.counts.live > 0)
    .map((g) => ({ key: g.key, name: g.label, attn: g.counts.attn, live: g.counts.live }))
    .sort((a, b) => b.attn - a.attn || b.live - a.live || a.name.localeCompare(b.name))
    .slice(0, DETECTED_MAX);
  return { empty: rows.length === 0, rows, detected };
}

/**
 * The empty box's line when the dashboard filter matches no group. `q` = the filter as typed (trimmed), `endedMatch` = some ended
 * agent matches it. With "Show ended" off such a match is hidden, so the line says so; otherwise it is the plain no-match line.
 */
export function noMatchText({ q, showEnded, endedMatch }) {
  return !showEnded && endedMatch
    ? `Nothing live matches “${q}”. Tick Show ended to include ended agents, or clear the filter.`
    : `Nothing matches “${q}”. Clear the filter to see every agent.`;
}

/* ---------- the orchestrator (0.4, O1) ---------- */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PANE = /^%\d{1,6}$/;
const ORCH_STATES = ['live', 'ended', 'gone'];
const NO_ORCH = { kind: 'none', id: null, name: null, pane: null };
const paneOf = (v) => (typeof v === 'string' && PANE.test(v) ? v : null);
const nameOf = (v) => (typeof v === 'string' ? v : null);
/** A depth from the page's own snapshot: a whole number of 2 or more is a sub-orchestrator; a missing or odd one is a 0.3 pane, main. */
const subDepth = (a) => Number.isInteger(a.depth) && a.depth >= 2;
const isMain = (a) => a.live === true && a.role === 'orchestrator' && !subDepth(a);

/**
 * The project's saved orchestrator, whatever it is doing: `{ id, state: 'live' | 'ended' | 'gone', name, pane }`, or null (no
 * project, no field, an older server). Only the contract's shape (C1) counts: a bad id or state gives null, and a name or a pane
 * that is not the right kind of text is dropped.
 */
export function savedPick(project) {
  const o = project?.orchestrator;
  if (!o || typeof o !== 'object' || !ORCH_STATES.includes(o.state) || typeof o.sessionId !== 'string' || !UUID.test(o.sessionId)) return null;
  return { id: o.sessionId, state: o.state, name: nameOf(o.name), pane: paneOf(o.pane) };
}

/**
 * What the project's first button says: `{ kind: 'live' | 'ended' | 'gone' | 'none', id, name, pane }`. The server's
 * `project.orchestrator` (contract C1, app tier) decides when it holds a saved orchestrator, except that a main orchestrator that
 * runs wins over a saved one that does not (the most recent one: Open, never a second Resume). Without the field (an older server,
 * a failed load, no saved orchestrator) the snapshot `g` decides: `live` with a main orchestrator, else `none`. Anything the field
 * holds that is not exactly the contract's shape is ignored.
 */
export function orchState(project, g) {
  const pick = savedPick(project);
  const saved = pick && { kind: pick.state, id: pick.id, name: pick.name, pane: pick.pane };
  if (saved?.kind === 'live') return saved;
  const running = (g?.agents ?? []).filter(isMain).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  if (running) return { kind: 'live', id: running.id, name: nameOf(running.name), pane: paneOf(running.pane?.id) };
  return saved ?? NO_ORCH;
}

/**
 * Another session of the group `g` that runs as the project's orchestrator (a live session tagged orchestrator, main or sub, or the
 * live saved one `pickId`) other than `id`; the most recent one: `{ id, name }` or null. The server refuses Set and Resume while
 * one runs (409 orchestrator_running), so the row menu is off with the same reason.
 */
export function otherRunning(g, pickId, id) {
  const hit = (g?.agents ?? []).filter((a) => a.live === true && a.id !== id && (a.role === 'orchestrator' || (Boolean(pickId) && a.id === pickId)))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  return hit ? { id: hit.id, name: nameOf(hit.name) } : null;
}

/** The badge next to a session's name: `'main'` (runs, tagged orchestrator), `'sub'` (depth 2 or more), `'saved'` (not running, the saved orchestrator) or null. */
export function roleTag(a, pickId) {
  if (a.live === true && a.role === 'orchestrator') return subDepth(a) ? 'sub' : 'main';
  return a.live !== true && Boolean(pickId) && a.id === pickId ? 'saved' : null;
}

/** Words of each badge: `long` and `short` (the narrow rows show the short one), the class and the title. dom.js roleTagEl() draws it. */
export const ROLE_TAGS = {
  main: { cls: 'tag', long: 'orchestrator', short: 'orch', title: 'orchestrator' },
  sub: { cls: 'tag sub', long: 'sub-orchestrator', short: 'sub-orch', title: 'sub-orchestrator' },
  saved: { cls: 'tag muted', long: 'orchestrator', short: 'orch', title: "Saved orchestrator. Resume it from the header or this row's menu." },
};
