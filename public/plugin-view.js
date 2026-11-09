// The pure model behind the project page's "Choose plugins" dialog (project.js): which rows to draw and in what order, what the
// filter shows, the counts and what Save sends. No DOM and no requests, so test/plugin-view.test.js runs it in Node.
// A plugin id is `name@marketplace` (src/ids.js PLUGIN_NAME); the server has already checked it, the page only renders it as text.

const text = (v) => (typeof v === 'string' ? v : null);
const lower = (s) => s.toLowerCase();
const unique = (list) => [...new Set([...(list ?? [])].map(text).filter(Boolean))];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A copy of `list` in A to Z order without regard to case (plain code-unit comparison, so it is the same on every machine). */
export function sortIds(list) {
  return [...list].sort((a, b) => cmp(lower(a), lower(b)) || cmp(a, b));
}

/**
 * The dialog's rows: every installed plugin plus every ticked one that is no longer installed. Order: the plugins in `opened`
 * first (A to Z), then the rest (A to Z); `opened` is the tick set the dialog opened with (default: `picked`), so ticking a
 * row later changes its `on`, never its place. `query` is a case-insensitive substring of `name@market`; a hidden row keeps its tick.
 * @param {{ installed?: string[], picked?: Iterable<string>, query?: string, opened?: Iterable<string> }} o
 * @returns {{ rows: { id: string, name: string, market: string, on: boolean, installed: boolean, shown: boolean }[],
 *   counts: { shown: number, total: number, on: number, installed: number } }}
 */
export function pluginView({ installed, picked, query, opened } = {}) {
  const have = new Set(unique(installed));
  const on = new Set(unique(picked));
  const first = new Set(unique(opened ?? picked));
  const ids = sortIds([...new Set([...have, ...on])]);
  const needle = lower(String(query ?? '').trim());
  const rows = [...ids.filter((id) => first.has(id)), ...ids.filter((id) => !first.has(id))].map((id) => {
    const at = id.indexOf('@');
    return {
      id,
      name: at < 0 ? id : id.slice(0, at),
      market: at < 0 ? '' : id.slice(at + 1),
      on: on.has(id),
      installed: have.has(id),
      shown: lower(id).includes(needle),
    };
  });
  return { rows, counts: { shown: rows.filter((r) => r.shown).length, total: rows.length, on: rows.filter((r) => r.on).length, installed: have.size } };
}

/** What Save sends: the ticked plugins, sorted and without repeats, or null when they are the plugins already saved (no request). */
export function pluginSave(saved, picked) {
  const next = unique(picked).sort();
  const before = unique(saved).sort();
  return next.length === before.length && next.every((id, i) => id === before[i]) ? null : next;
}

/** "<on> on · <n> installed", or with a filter "Showing <k> of <n> · <on> on". */
export function countText(view, query) {
  const { shown, total, on, installed } = view.counts;
  return String(query ?? '').trim() ? `Showing ${shown} of ${total} · ${on} on` : `${on} on · ${installed} installed`;
}

/** The sentence read out 400 ms after typing in the filter. */
export function filterNote(view) {
  const { shown } = view.counts;
  return shown === 0 ? 'No plugin matches' : `${shown} plugin${shown === 1 ? '' : 's'} shown`;
}
