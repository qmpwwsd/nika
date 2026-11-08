// Static model catalog behind the model dropdowns (GET /api/app/models). IDs come from docs/contracts/claude-tui.md §6 only.
// No network call: what an alias resolves to depends on the provider. A custom id is still accepted when it matches MODEL_ID.
const m = (id, label, group, note) => Object.freeze(note ? { id, label, group, note } : { id, label, group });

export const MODEL_CATALOG = Object.freeze([
  m('claude-fable-5-1', 'Fable 5.1', 'latest'),
  m('claude-opus-5-5', 'Opus 5.5', 'latest'),
  m('claude-sonnet-5-5', 'Sonnet 5.5', 'latest'),
  m('claude-haiku-5-5', 'Haiku 5.5', 'latest'),
  m('best', 'Best available', 'alias'),
  m('fable', 'Fable (latest)', 'alias'),
  m('opus', 'Opus (latest)', 'alias'),
  m('sonnet', 'Sonnet (latest)', 'alias'),
  m('haiku', 'Haiku (latest)', 'alias'),
  m('opusplan', 'Opus plan, Sonnet build', 'alias', 'Opus in plan mode, Sonnet otherwise'),
  m('opus[1m]', 'Opus, 1M context', 'alias'),
  m('sonnet[1m]', 'Sonnet, 1M context', 'alias'),
  m('claude-fable-5', 'Fable 5', 'older'),
  m('claude-opus-5', 'Opus 5', 'older'),
  m('claude-sonnet-5', 'Sonnet 5', 'older'),
  m('claude-opus-4-6', 'Opus 4.6', 'older'),
  m('claude-sonnet-4-6', 'Sonnet 4.6', 'older'),
  m('claude-sonnet-4-5', 'Sonnet 4.5', 'older'),
  m('claude-haiku-4-5', 'Haiku 4.5', 'older'),
]);
