// Auto-compact for the sessions nika starts (0.4, ADR 0014, spike S2). Pure: the settings and a model id in, the two launch
// environment variables out. Claude Code compacts at min(floor(effective x PCT / 100), effective - 13000) with effective =
// window - 20000, so "P % of the window W" needs PCT = 100 x (W x P / 100) / (W - 20000), and the window must be set explicitly
// (with the window unset, proactive compaction is off). The PCT is always sent ('100' above the cap, which Claude turns into its own
// cap), so a value inherited from the environment can never stay in force. The values go into a tmux `-e NAME=value` (literal, never format-expanded)
// or into the env of a no-shell spawn; only what compactEnv() has validated ever gets there.
import { modelWindow } from './models.js';

export const WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const PCT_ENV = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE';
const RESERVED = 20_000; // tokens Claude Code reserves for the model's output
const BUFFER = 33_000; // reserved output + the 13k summary buffer: where Claude compacts when no PCT is set (/context shows 33k)
const WINDOWS = [200_000, 400_000, 1_000_000, 'model'];
const bad = (message) => Object.assign(new Error(message), { code: 'EINVAL' });

/** An integer window in 100000 to 1000000 (the range Claude Code accepts). */
export const validWindow = (w) => Number.isInteger(w) && w >= 100_000 && w <= 1_000_000;
/** A PCT string of digits and at most one dot (up to 4 decimals), above 0 and at most 100. */
export const validPct = (p) => typeof p === 'string' && /^\d{1,3}(\.\d{1,4})?$/.test(p) && Number(p) > 0 && Number(p) <= 100;

/**
 * The launch environment for a window and a PCT string: `{ CLAUDE_CODE_AUTO_COMPACT_WINDOW, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE }`.
 * Throws EINVAL for anything validWindow / validPct refuse, so a bad setting or a tampered file never reaches a launch.
 */
export function compactEnv(window, pct) {
  if (!validWindow(window)) throw bad('compaction window must be an integer from 100000 to 1000000');
  if (!validPct(pct)) throw bad('compaction PCT must be digits and at most one dot, above 0 and at most 100');
  return { [WINDOW_ENV]: String(window), [PCT_ENV]: pct };
}

/**
 * What a session on `model` needs to compact at `compaction.pct` per cent of `compaction.window` (the Settings shape: enabled, pct
 * 20 to 95, window 200000 | 400000 | 1000000 | 'model'), or null when auto-compact is off. W is the setting's window limited to the
 * model's own (the whole model window for 'model'). The threshold is limited to W - 33000, the highest Claude Code allows; a target
 * above it sends PCT 100, which Claude Code caps at the same number (min((W - 20000) x 100 / 100, W - 33000)). Returns { env, window: W, compactAt } with the
 * threshold in tokens. Throws EINVAL for a setting outside its ranges.
 */
export function compactLaunch(model, compaction) {
  if (!compaction || typeof compaction !== 'object' || typeof compaction.enabled !== 'boolean') throw bad('compaction must be { enabled, pct, window }');
  const { enabled, pct, window } = compaction;
  if (!Number.isInteger(pct) || pct < 20 || pct > 95) throw bad('compaction pct must be a whole number from 20 to 95');
  if (!WINDOWS.includes(window)) throw bad('compaction window must be 200000, 400000, 1000000 or "model"');
  if (!enabled) return null;
  const own = modelWindow(model);
  const W = window === 'model' ? own : Math.min(window, own);
  const limit = W - BUFFER;
  const target = Math.floor((W * pct) / 100);
  // ceil to 4 decimals in integer arithmetic: 10^6 x target / (W - 20000) is the PCT in ten-thousandths (< 2^53, no float drift)
  const tenThousandths = Math.ceil((1e6 * target) / (W - RESERVED));
  return { env: compactEnv(W, target <= limit ? String(tenThousandths / 1e4) : '100'), window: W, compactAt: Math.min(target, limit) };
}
