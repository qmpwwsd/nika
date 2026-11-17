// Labels (0.5, W9, design-W9 2.3): what kind of agent a row is. Pure, no I/O. A label is display only: no flag, prompt, tool list,
// permission or limit depends on it, and it never reaches claude. Keep this file ASCII: the ellipsis is written as an escape.
import { KINDS } from './ids.js';
import { clean } from './text.js';

/** The longest label of a Claude subagent, in code points, the ellipsis included. */
export const LABEL_MAX = 24;
/** The role models that name a kind; the orchestrator's model names none. */
export const ROLE_KIND = { builder: 'coder', reasoner: 'designer', scout: 'scout' };
/** Claude Code's built-in subagent types -> a kind (exact, case-sensitive). `web-fetch` and `fork` are not confirmed built-ins (design-W9 2.4). */
export const SUBAGENT_KIND = {
  Explore: 'scout', Plan: 'designer', 'general-purpose': 'agent', claude: 'agent',
  'statusline-setup': 'coder', 'claude-code-guide': 'scout', 'web-fetch': 'scout', fork: 'agent',
};

/** True for exactly one of the seven words of KINDS (case, padding and every other type are no kind). */
export const isKind = (v) => typeof v === 'string' && KINDS.includes(v);

/**
 * The kind of a spawn without `kind`: the roles among builder, reasoner and scout whose model id in `models` (the project's effective
 * role models, store.js effectiveModels) equals `model` exactly. One kind -> it. None, or two roles naming different kinds (builder and
 * scout on the same id) -> 'agent'. No alias resolution: 'sonnet' never equals 'claude-sonnet-5-5'.
 */
export function kindFromModel(model, models) {
  const kinds = new Set(Object.entries(ROLE_KIND).filter(([role]) => typeof model === 'string' && models?.[role] === model).map(([, k]) => k));
  return kinds.size === 1 ? [...kinds][0] : 'agent';
}

/**
 * A Claude subagent's label from its agentType: a built-in type's kind; else its own name, cleaned (text.js clean, 80), after the last
 * ':' (a plugin's agent `plugin:name` shows `name`) when anything is left there, cut to LABEL_MAX code points (23 + an ellipsis); else
 * 'agent'. Own-property lookup only: 'constructor' is a name, not a prototype hit.
 */
export function subagentLabel(type) {
  if (typeof type !== 'string') return 'agent';
  if (Object.hasOwn(SUBAGENT_KIND, type)) return SUBAGENT_KIND[type];
  const name = clean(type, 80);
  if (name === null) return 'agent';
  const label = name.slice(name.lastIndexOf(':') + 1).trim() || name;
  const points = Array.from(label);
  return points.length > LABEL_MAX ? `${points.slice(0, LABEL_MAX - 1).join('')}\u2026` : label;
}
