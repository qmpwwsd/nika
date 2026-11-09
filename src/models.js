// Static model catalog behind the model dropdowns (GET /api/app/models). IDs come from docs/contracts/claude-tui.md §6 only.
// No network call: what an alias resolves to depends on the provider. A custom id is still accepted when it matches MODEL_ID.
// `window` is the context window in tokens as Claude Code 2.1.319 believes it (spike S2, section 1): 1M for the 5.x ids and the aliases
// that resolve to them, 200k for the 4.x ids. It feeds modelWindow() only, i.e. the auto-compact launch env (src/compact.js).
const m = (id, label, group, window, note) => Object.freeze(note ? { id, label, group, window, note } : { id, label, group, window });
const K200 = 200_000;
const M1 = 1_000_000;

export const MODEL_CATALOG = Object.freeze([
  m('claude-fable-5-1', 'Fable 5.1', 'latest', M1),
  m('claude-opus-5-5', 'Opus 5.5', 'latest', M1),
  m('claude-sonnet-5-5', 'Sonnet 5.5', 'latest', M1),
  m('claude-haiku-5-5', 'Haiku 5.5', 'latest', M1),
  m('best', 'Best available', 'alias', M1),
  m('fable', 'Fable (latest)', 'alias', M1),
  m('opus', 'Opus (latest)', 'alias', M1),
  m('sonnet', 'Sonnet (latest)', 'alias', M1),
  m('haiku', 'Haiku (latest)', 'alias', M1),
  m('opusplan', 'Opus plan, Sonnet build', 'alias', M1, 'Opus in plan mode, Sonnet otherwise'),
  m('opus[1m]', 'Opus, 1M context', 'alias', M1),
  m('sonnet[1m]', 'Sonnet, 1M context', 'alias', M1),
  m('claude-fable-5', 'Fable 5', 'older', M1),
  m('claude-opus-5', 'Opus 5', 'older', M1),
  m('claude-sonnet-5', 'Sonnet 5', 'older', M1),
  m('claude-opus-4-6', 'Opus 4.6', 'older', K200),
  m('claude-sonnet-4-6', 'Sonnet 4.6', 'older', K200),
  m('claude-sonnet-4-5', 'Sonnet 4.5', 'older', K200),
  m('claude-haiku-4-5', 'Haiku 4.5', 'older', K200),
]);

const WINDOWS = new Map(MODEL_CATALOG.map((x) => [x.id, x.window]));

/**
 * The context window of a model id in tokens: the catalog's value, else 1M for any id ending in `[1m]`, else 200k. An unknown or
 * custom id (and anything that is not a string) is 200k, the conservative side, as Claude Code itself treats an id it does not know.
 */
export function modelWindow(id) {
  if (typeof id !== 'string') return K200;
  return WINDOWS.get(id) ?? (id.endsWith('[1m]') ? M1 : K200);
}
