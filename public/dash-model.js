// Pure decisions of the dashboard and the sidebar (no DOM, no network; both tiers may load it). app.js and project.js draw
// what these functions return, so Node tests cover the rules without a browser.

/** Most rows the sidebar's Detected list shows. */
export const DETECTED_MAX = 8;

/**
 * The muted dashboard note for registry files nika could not use (`snapshot.skipped.registry`), or null when none. Not an error:
 * the list is only short of those sessions. `nika status` prints the same words (src/cli.js).
 */
export function skippedText(n) {
  return Number.isInteger(n) && n > 0 ? `${n} session file${n === 1 ? '' : 's'} skipped (unreadable or not in Claude's format)` : null;
}

/**
 * What one group draws for its ended agents. `live` and `ended` are counts. `collapsed` = the user folded this section by hand.
 * "Show ended" off: the ended agents are not drawn, and a group with nothing live says so in one line. On: the section, open
 * unless folded by hand. The dashboard and the project view each pass their own toggle.
 */
export function endedPlan({ live, ended, showEnded, collapsed = false }) {
  const endedSection = showEnded && ended > 0;
  return { endedSection, open: endedSection && !collapsed, noLiveLine: !showEnded && live === 0 && ended > 0 };
}

/** Forget what the user opened or folded in one view's Ended sections (`ended:<view>:<key>` and `!ended:<view>:<key>`): `g` the dashboard (default), `pv` the project page. The other view's stay. */
export function resetEndedState(open, view = 'g') {
  for (const id of [...open]) if (id.replace(/^!/, '').startsWith(`ended:${view}:`)) open.delete(id);
}

/**
 * The sidebar: `rows` = the registered projects (with their counts), `empty` = there are none (the page shows its hint),
 * `detected` = repositories that run live agents but are not registered, most urgent first, at most DETECTED_MAX unless `showAll`
 * (the "N more" button); `detectedMore` = how many the cap leaves behind that button.
 * `groups` are the dashboard's groups (`project`, `key`, `root`, `label`, `counts`). `projects` = null means the list has not
 * loaded: no hint and no Detected (without it nika cannot tell which repositories are registered), so nothing is drawn yet.
 */
export function sidebarModel({ projects, groups, showAll = false }) {
  if (!projects) return { empty: false, rows: [], detected: [], detectedMore: 0 };
  const byProject = new Map(groups.filter((g) => g.project).map((g) => [g.project.key, g]));
  const rows = projects.map((p) => ({ key: p.key, name: p.name, attn: byProject.get(p.key)?.counts.attn ?? 0, live: byProject.get(p.key)?.counts.live ?? 0 }));
  const keys = new Set(projects.map((p) => p.key));
  const dirs = new Set(projects.map((p) => p.dir));
  const detected = groups
    .filter((g) => !g.project && !keys.has(g.key) && !dirs.has(g.root) && g.counts.live > 0)
    .map((g) => ({ key: g.key, name: g.label, attn: g.counts.attn, live: g.counts.live }))
    .sort((a, b) => b.attn - a.attn || b.live - a.live || a.name.localeCompare(b.name));
  const shown = showAll ? detected : detected.slice(0, DETECTED_MAX);
  return { empty: rows.length === 0, rows, detected: shown, detectedMore: detected.length - shown.length };
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
/** The main orchestrator is a live session the server tagged `orchestrator`; a sub-orchestrator has its own role. The page never reads the role from the depth. */
const isMain = (a) => a.live === true && a.role === 'orchestrator';

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
 * Another session of the group `g` that runs as the project's orchestrator (a live session tagged orchestrator, or the live saved
 * one `pickId`) other than `id`; the most recent one: `{ id, name }` or null. A sub-orchestrator never counts. The server refuses
 * Set and Resume while one runs (409 orchestrator_running), so the row menu is off with the same reason.
 */
export function otherRunning(g, pickId, id) {
  const hit = (g?.agents ?? []).filter((a) => a.live === true && a.id !== id && (a.role === 'orchestrator' || (Boolean(pickId) && a.id === pickId)))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  return hit ? { id: hit.id, name: nameOf(hit.name) } : null;
}

/**
 * The badge next to a session's name: `'main'` (runs, role orchestrator), `'sub'` (runs, role sub-orchestrator, whatever its depth:
 * an orphan keeps it), `'saved'` (not running, the saved orchestrator) or null.
 */
export function roleTag(a, pickId) {
  if (a.live === true && a.role === 'orchestrator') return 'main';
  if (a.live === true && a.role === 'sub-orchestrator') return 'sub';
  return a.live !== true && Boolean(pickId) && a.id === pickId ? 'saved' : null;
}

/** Words of each badge: `long` and `short` (the narrow rows show the short one), the class and the title. dom.js roleTagEl() draws it. */
export const ROLE_TAGS = {
  main: { cls: 'tag', long: 'orchestrator', short: 'orch', title: 'orchestrator' },
  sub: { cls: 'tag sub', long: 'sub-orchestrator', short: 'sub-orch', title: 'sub-orchestrator' },
  saved: { cls: 'tag muted', long: 'orchestrator', short: 'orch', title: "Saved orchestrator. Resume it from the header or this row's menu." },
};

/* ---------- the nesting tree and the spawn counts (0.4, O2) ---------- */
/** Most urgent first. The dashboard sorts by it, and a subtree takes the most urgent status inside it. */
export const STATUS_ORDER = { attn: 0, idle: 1, busy: 2, ended: 3 };

/** attn = a live agent whose state is neither busy nor idle (the server sets `attention` for exactly those). */
export function statusOf(a) {
  if (!a.live) return 'ended';
  if (a.attention) return 'attn';
  return a.state === 'busy' || a.state === 'idle' ? a.state : 'attn';
}

/**
 * The agent `a` hangs under, among `agents`, or null. `a.parent` is a session id when the server could resolve one and a pane id
 * otherwise (contract C6); a value of any other shape, a parent that is not listed, an ended pane and `a` itself all give null.
 */
export function parentOf(a, agents) {
  const p = a?.parent;
  const hit = typeof p !== 'string' ? null
    : UUID.test(p) ? agents.find((x) => x.id === p)
      : PANE.test(p) ? agents.find((x) => x.live === true && x.pane?.id === p) : null;
  return hit && hit !== a && hit.id !== a.id ? hit : null;
}

const refShape = (p) => typeof p === 'string' && (UUID.test(p) || PANE.test(p));
const lastOf = (a) => (Number.isFinite(a.lastActivity) ? a.lastActivity : 0);
const MAX_DEPTH = 3;

/**
 * The live agents of one group in the order the page draws them: a flat list of
 * `{ a, depth, root, kids, desc, collapsed, hiddenCount, hiddenAttn, hidden, parentName, orphan }`.
 * - `depth` is the row's place in the tree the page builds (a root is 1, each parent above adds one, never more than 3); no field
 *   of the server's agent sets it, so a forged one cannot move a row. `root` marks the start of a root subtree (the row cap counts
 *   those). `kids` = direct children; `desc` = the agent ids of every descendant, in row order (for aria-controls).
 * - Siblings: the most urgent status in each subtree first (STATUS_ORDER, so a subtree with a child that needs you rises), then
 *   the most recent activity in the subtree.
 * - `collapsed` (a Set of agent ids): the row hides its descendants (`hidden` on each) and counts them in `hiddenCount`, and those
 *   that need you in `hiddenAttn`. Both are 0 while it is expanded.
 * - An orphan has a parent reference that is not in `list`: it is a root, keeps its role, and `orphan` is true.
 * - A loop of parents is cut, so every agent appears once. `filtering` gives a flat list (status, then activity), nothing hidden;
 *   `parentName` still names the parent so the row can say "under <parent>".
 */
export function treeRows(list, { collapsed = new Set(), filtering = false } = {}) {
  const rank = (a) => STATUS_ORDER[statusOf(a)];
  const nodes = new Map(list.map((a) => [a, { a, kids: [], desc: [], urgency: rank(a), last: lastOf(a), attn: 0 }]));
  const parent = new Map(list.map((a) => [a, parentOf(a, list)]));
  const nameOfParent = (a) => nameOf(parent.get(a)?.name);
  const cmp = (x, y) => x.urgency - y.urgency || y.last - x.last;
  if (filtering) {
    return [...nodes.values()].sort(cmp).map((n) => ({
      a: n.a, depth: 1, root: true, kids: 0, desc: [], collapsed: false, hiddenCount: 0, hiddenAttn: 0, hidden: false, parentName: nameOfParent(n.a), orphan: false,
    }));
  }
  // cut every loop of parents (one link per loop), so what is left is a forest
  for (const a of list) {
    const path = new Set([a]);
    for (let cur = parent.get(a); cur; cur = parent.get(cur)) {
      if (path.has(cur)) {
        parent.set([...path].at(-1), null);
        break;
      }
      path.add(cur);
    }
  }
  const roots = [];
  for (const a of list) {
    const p = parent.get(a);
    if (p) nodes.get(p).kids.push(nodes.get(a));
    else roots.push(nodes.get(a));
  }
  const measure = (n) => {
    for (const k of n.kids) measure(k);
    for (const k of n.kids) {
      n.urgency = Math.min(n.urgency, k.urgency);
      n.last = Math.max(n.last, k.last);
    }
    n.kids.sort(cmp);
    n.desc = n.kids.flatMap((k) => [k, ...k.desc]);
    n.attn = n.desc.filter((d) => rank(d.a) === STATUS_ORDER.attn).length;
  };
  roots.forEach(measure);
  const out = [];
  const walk = (n, depth, hidden, root) => {
    const folded = n.kids.length > 0 && collapsed.has(n.a.id);
    out.push({
      a: n.a, depth, root, kids: n.kids.length, desc: n.desc.map((d) => d.a.id), collapsed: folded,
      hiddenCount: folded ? n.desc.length : 0, hiddenAttn: folded ? n.attn : 0, hidden,
      parentName: nameOfParent(n.a), orphan: refShape(n.a.parent) && !parentOf(n.a, list),
    });
    for (const k of n.kids) walk(k, Math.min(MAX_DEPTH, depth + 1), hidden || folded, false);
  };
  roots.sort(cmp).forEach((r) => walk(r, 1, false, true));
  return out;
}

/** Does the group nest at all? A group where no row has a parent or children is drawn as 0.3 drew it: no slot, no elbow. */
export const hasTree = (rows) => rows.some((r) => r.kids > 0 || r.orphan);

/**
 * The permission mode, pane placement and agent limit nika uses for one project: its own value in `settings.perProject[key]`, else
 * Settings' (the page's copy of src/store.js effectiveAgents). Before Settings has loaded: the defaults.
 */
export function effectiveAgents(settings, key) {
  const own = settings?.perProject?.[key] ?? {};
  return {
    permissionMode: own.permissionMode ?? settings?.permissionMode ?? 'default',
    panePlacement: own.panePlacement ?? settings?.panePlacement ?? 'beside',
    maxAgents: own.maxAgents ?? settings?.limits?.maxAgents ?? 3,
  };
}

/**
 * The counts behind the spawn sheet and its openers: `{ parent: { running, max }, project: { running, cap } }`. The live set is the
 * agents and sub-orchestrators of `g` (the main orchestrator is not in it). The parent bucket holds the live ones under the pane
 * `parentPane` (by pane id or by the session id that pane runs); with no pane it is "you": those with no parent at all.
 * `cap` = min(3 * max, 24). The server's count is the one that decides.
 */
export function spawnLimits(g, parentPane, max) {
  const n = Number.isInteger(max) && max >= 1 ? max : 3;
  const agents = g?.agents ?? [];
  const live = agents.filter((a) => a.live === true && (a.role === 'agent' || a.role === 'sub-orchestrator'));
  const holder = parentPane ? agents.find((a) => a.live === true && a.pane?.id === parentPane) : null;
  const under = parentPane
    ? live.filter((a) => a.parent === parentPane || (holder && a.parent === holder.id))
    : live.filter((a) => !a.parent);
  return { parent: { running: under.length, max: n }, project: { running: live.length, cap: Math.min(3 * n, 24) } };
}
