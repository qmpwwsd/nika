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
 * `groups` are the dashboard's groups (`project`, `key`, `root`, `label`, `counts`).
 */
export function sidebarModel({ projects, groups }) {
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
