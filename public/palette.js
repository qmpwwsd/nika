// The session window's slash-command palette: the rules and the exact copy, with no DOM and no requests, so Node tests them
// (test/palette.test.js). session.js only draws what these return. Design: docs/design/spec.md section 9.7.
// Contract: docs/contracts/api-app.md, GET /api/app/commands (`name` has no leading "/"; plugin entries are "<plugin>:<name>").

const DOTS = String.fromCharCode(0x2026);

export const PALETTE_MAX = 50; // options shown
export const REFETCH_MS = 10000; // a later open fetches again only when the last good answer is older than this

/** The text after a leading "/" while it has no whitespace, else null: that is when the message box is asking for a command. */
export function paletteQuery(value) {
  if (typeof value !== 'string' || value[0] !== '/') return null;
  const q = value.slice(1);
  return /\s/.test(q) ? null : q;
}

/**
 * The commands that match `query`, best first: exact name, name prefix, name substring, description substring. Case-insensitive,
 * stable inside a tier, at most PALETTE_MAX. An empty query keeps the server order. A plugin entry matches on its full
 * "<plugin>:<name>". The query is text, never a pattern.
 */
export function rankCommands(list, query) {
  if (!Array.isArray(list)) return [];
  const q = String(query ?? '').toLowerCase();
  const tiers = [[], [], [], []];
  for (const c of list) {
    if (!c || typeof c.name !== 'string') continue;
    const name = c.name.toLowerCase();
    const desc = typeof c.description === 'string' ? c.description.toLowerCase() : '';
    const tier = q === '' || name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : desc.includes(q) ? 3 : -1;
    if (tier >= 0) tiers[tier].push(c);
  }
  return tiers.flat().slice(0, PALETTE_MAX);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/; // the server's COMMAND_NAME, plus room for a "<plugin>:" prefix
const SOURCES = new Set(['builtin', 'user', 'project', 'plugin']);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** The response's `commands` as the page may use it. A name with a space or control character never gets in: it is typed into the box. */
export function cleanCommands(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw.slice(0, 1000)) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !NAME.test(c.name) || !SOURCES.has(c.source)) continue;
    out.push({
      name: c.name, description: text(c.description, 200), argHint: text(c.argHint, 100), source: c.source,
      dialog: c.dialog === true, plugin: c.source === 'plugin' ? text(c.plugin, 100) : '',
    });
  }
  return out;
}

/** The source tag of an option; '' for a source the page does not know. */
export function sourceLabel(c) {
  switch (c?.source) {
    case 'builtin': return 'Built-in';
    case 'user': return 'Personal';
    case 'project': return 'Project';
    case 'plugin': return c.plugin ? `Plugin ${c.plugin}` : 'Plugin';
    default: return '';
  }
}

/** The Commands button (spec 9.7): off (aria-disabled) while Shell is on, and while the box holds text. Shell wins. */
export function commandsButton({ shell = false, empty = true } = {}) {
  if (shell) return { off: true, title: 'Turn Shell off to pick a command' };
  if (!empty) return { off: true, title: 'Empty the message box to pick a command' };
  return { off: false, title: 'Commands (/)' };
}

/** Fetch on the first open, then again on a later open once the last good answer is older than REFETCH_MS; one request at a time. */
export function shouldFetch({ loadedAt = null, now = 0, busy = false } = {}) {
  if (busy) return false;
  return loadedAt === null || now - loadedAt > REFETCH_MS;
}

const plural = (n) => `${n} ${n === 1 ? 'command' : 'commands'}`;
const TAIL = 'Enter sends the text as typed.';

/**
 * What the palette shows for the list the page holds (`list`: null until a load answered), whether the first load failed, and the
 * query. { kind: 'loading' | 'error' | 'empty' | 'list', items, note (the line for a state without options), head (the muted count
 * in the header), say (the polite announcement) }. A failed refresh keeps the list it already has.
 */
export function paletteView({ list = null, failed = false, query = '' } = {}) {
  const state = (kind, note) => ({ kind, items: [], note, head: '', say: note });
  if (list === null) return failed ? state('error', `Couldn't load the command list. ${TAIL}`) : state('loading', `Loading commands${DOTS}`);
  const items = rankCommands(list, query);
  if (items.length === 0) return state('empty', `No command matches /${query}. ${TAIL}`);
  return {
    kind: 'list',
    items,
    note: '',
    head: query === '' ? plural(items.length) : `${items.length} match /${query}`,
    say: `${plural(items.length)}. Up and Down to choose, Enter to insert, Escape to close.`,
  };
}

/** What choosing a command puts in the box ("/<name> ", trailing space) and the argument line for the hint ('' = none). */
export function insertion(c) {
  const hint = typeof c?.argHint === 'string' ? c.argHint : '';
  return { text: `/${c.name} `, hint: hint ? `Arguments: ${hint}` : '' };
}

/** The active option after an arrow key: no wrap; -1 when the list is empty. */
export const moveActive = (i, delta, n) => (n > 0 ? Math.max(0, Math.min(n - 1, i + delta)) : -1);
