// The model dropdown's shared parts (docs/design/spec.md section 9.4 model popover; product spec 6.9). Used by the session window's
// Model action, Settings, the spawn sheet and the project's Models dialog. The catalog comes from GET /api/app/models
// (src/models.js), already in display order. Pure functions are tested in Node (test/models-ui.test.js); fillModelSelect draws with
// h(), so catalog text only ever lands in text nodes and attributes.
import { h } from './dom.js';

/** The server's MODEL_ID (src/ids.js): a test keeps the two equal. Brackets are safe: argv only, no shell. */
export const MODEL_ID = /^(?:claude-[a-z0-9-]{3,60}|opus|sonnet|haiku|fable|best|opusplan)(?:\[1m\])?$/;
/** Copy under the custom field when MODEL_ID refuses its text. */
export const MODEL_HINT = 'Use a model id such as claude-sonnet-5-5, or an alias such as opus or sonnet[1m].';
/** Value of the "Custom ID..." option. It is not a model id, so it can never collide with one. */
export const CUSTOM = '__custom__';

/** The four roles in the order the page lists them, and their labels. The server's `models` has the same four keys (src/store.js). */
export const ROLES = ['orchestrator', 'reasoner', 'builder', 'scout'];
export const ROLE_LABEL = { orchestrator: 'Orchestrator', reasoner: 'Reasoner', builder: 'Builder', scout: 'Scout' };

const GROUPS = [['latest', 'Latest'], ['alias', 'Aliases'], ['older', 'Older']];
const DOTS = String.fromCharCode(0x2026);

/** The catalog entries this page can use: an array of { id (MODEL_ID), label, group (latest|alias|older) }; anything else is dropped. */
const usable = (catalog) => (Array.isArray(catalog)
  ? catalog.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && MODEL_ID.test(x.id) && typeof x.label === 'string' && GROUPS.some(([k]) => k === x.group))
  : []);

/** [{ key, label, models }] for Latest, Aliases and Older, each in catalog order; a group with no model is left out. */
export function modelGroups(catalog) {
  const list = usable(catalog);
  return GROUPS.map(([key, label]) => ({ key, label, models: list.filter((x) => x.group === key) })).filter((g) => g.models.length > 0);
}

/** True when `id` is listed in the catalog (also true for aliases such as `opus[1m]`); anything else needs the Custom ID field. */
export function isCatalogId(id, catalog) {
  return typeof id === 'string' && usable(catalog).some((x) => x.id === id);
}

/** The catalog label of `id` ("Opus 5.5"), or null when it is not listed. */
export function modelLabel(id, catalog) {
  return usable(catalog).find((x) => x.id === id)?.label ?? null;
}

const optionText = (x) => (x.group === 'latest' ? `${x.label} (${x.id})` : x.id);

/**
 * Fills a <select> with the three optgroups and the "Custom ID..." option last, and selects `current`. `roles` ([{ value, text }],
 * the spawn sheet) puts a "Roles" optgroup first; a role value counts as known even when the catalog lacks it. Returns true when the
 * model is not listed (or unknown): Custom ID is selected and the caller shows its text field with `current` in it. `unset` (text)
 * puts a first option with the value "" (fillRoleOverride); `current === ''` then selects it and counts as known.
 */
export function fillModelSelect(select, catalog, current, roles = [], unset = null) {
  select.replaceChildren(
    ...(unset === null ? [] : [h('option', { value: '', text: unset })]),
    ...(roles.length ? [h('optgroup', { label: 'Roles' }, roles.map((r) => h('option', { value: r.value, text: r.text })))] : []),
    ...modelGroups(catalog).map((g) => h('optgroup', { label: g.label },
      g.models.map((x) => h('option', { value: x.id, title: x.note, text: optionText(x) })))),
    h('option', { value: CUSTOM, text: `Custom ID${DOTS}` }));
  const known = (unset !== null && current === '') || isCatalogId(current, catalog) || roles.some((r) => r.value === current);
  select.value = known ? current : CUSTOM;
  return !known;
}

/**
 * A role's override select in the project's Models dialog: "Use default (<label>)" first (value ""), then as fillModelSelect.
 * `current` is the project's id or null (selects "Use default"); `defaultId` is Settings' model for the role, shown by its catalog
 * label, else as the id. Returns true when `current` is not listed: Custom ID is selected and the caller fills its field.
 */
export function fillRoleOverride(select, catalog, current, defaultId) {
  return fillModelSelect(select, catalog, current ?? '', [], `Use default (${modelLabel(defaultId, catalog) ?? defaultId})`);
}

/**
 * The models nika uses for a project: its own id where set, else Settings' (`settings` is GET /api/app/settings). Mirrors the
 * server's effectiveModels (src/store.js); one table of cases in test/models-ui.test.js runs through both. A missing piece is null.
 */
export function effectiveRoleModels(settings, key) {
  return Object.fromEntries(ROLES.map((role) => [role, settings?.perProject?.[key]?.models?.[role] ?? settings?.models?.[role] ?? null]));
}
