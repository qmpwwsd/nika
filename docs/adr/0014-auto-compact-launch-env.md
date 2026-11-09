# ADR 0014 — Auto-compact via the launch environment

Date 2026-11-09 · Status accepted (nika 0.4)

## Context
A long Claude Code session fills its context window and then compacts at a point Claude Code picks. 0.4 lets the user say
when: Settings gets "Auto-compact at [80] % of [400k]", on by default, and it applies to every claude nika starts (the
orchestrator, fresh or resumed, and spawned agents and sub-orchestrators). Sessions already running and sessions the user
starts by hand are not touched. Spike S2 (Claude Code 2.1.319, tmux 3.8) measured what is available:

- `--autocompact <tokens>` and the environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set the same window. The variable
  wins when both are set. Both are capped at the model's real window (1M for the 5.x ids, 200k for the 4.x ids and unknown ids).
- Claude Code compacts at `min(floor(effective x PCT / 100), effective - 13000)` with `effective = window - 20000`
  (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is PCT). So PCT is a per cent of the window minus 20k, not of the window, and with no
  PCT the session compacts at `window - 33000` (the 33k `/context` shows as the autocompact buffer). With the window unset
  ("auto" source) proactive compaction is off, so the window must always be set when a PCT is.
- `/context` never shows the PCT, so the live threshold cannot be read back from the UI.
- tmux `new-session -e` and `new-window -e` put a variable in the pane's environment, repeatable, and the value is literal
  (no format expansion, `#` and spaces kept). The environment of a no-shell `spawn()` is the other place a value can go.
- The user's own Claude settings may already carry a window (on the machine of the spike, 400k).

## Decision
- **The setting** is `compaction: { enabled, pct, window }` in `config.json` and `GET|PUT /api/app/settings` (C7): `pct` an
  integer 20–95, `window` 200000, 400000, 1000000 or `"model"`, default on, 80, 400000.
- **The mechanism is the environment pair**, never the `--autocompact` flag. `compactLaunch(model, compaction)` in
  `src/compact.js` (pure) returns `null` when off, else `{ env, window, compactAt }`:
  `W` is the model's window (`modelWindow`, from the catalog's new `window` field, else 1M for `[1m]`, else 200k) when the
  setting says `"model"`, else `min(setting, model window)`; `target = floor(W x pct / 100)`; `limit = W - 33000`;
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW = W`; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = ceil4(100 x target / (W - 20000))` when
  `target <= limit`, else `100` (Claude computes `min((W - 20000) x 100 / 100, W - 33000)`, which is the cap). The PCT is therefore always
  set, and an inherited value can never stay in force. `compactAt = min(target, limit)` is what the session will do.
- **Validate before use.** `compactEnv` accepts an integer window in 100000–1000000 and a PCT string of digits and at most one
  dot (above 0, at most 100; never `null`), and throws otherwise. A setting outside its ranges throws in `compactLaunch`. Whatever reaches a
  launch passed it: the orchestrator's `-e` values, and the agent's, which `_run-agent` checks again.
- **Orchestrator.** The tmux call that creates its pane gets one `-e NAME=value` per variable, before `--`. The model is the
  project's effective orchestrator model, so a per-project model changes `W`.
- **Agents and sub-orchestrators.** `spawnAgent` computes `compactLaunch(v.model, config.compaction)` and stores
  `compact: { window, pct } | null` in `<name>.agent.json` (`pct` the PCT string; `null` is only for the whole `compact`, meaning off); `runAgent` asserts the exact key set,
  re-validates both values (exit 3 on any failure) and adds the two variables to a copy of its environment for the `spawn()` that
  starts claude. No shell is involved.
- **Off:** nika sets neither variable. The environment inherited from the tmux server or the CLI goes through unchanged, so the
  user's own Claude settings apply.
- **The page** previews the form's unsaved values (`compactPreview` in `public/ctx.js`) with the same cap rule, and never
  computes anything the server launches with.

## Alternatives considered
- **`--autocompact <tokens>`.** It has a 100k floor and exits 1 below it, so "20 % of 200k" (40k) cannot be reached; it changes
  the window Claude shows (the context bar of the TUI would read tokens/N, not tokens/W); it leans on the 33000 constant to turn
  a per cent into a window; and it does not beat the variable. Kept only as a theoretical fallback.
- **`--settings '{"autoCompactWindow": N}'`.** It works through inline settings, but it is the same window-only route with the
  same drawbacks, and it would be one more key of a Claude settings file that nika's rules otherwise never write or read
  (constraint 4).
- **Writing the user's own Claude settings.** Rejected: nika never touches them.
- **One PCT for every model (the window unknown).** Simple, but early by up to 20k x P/100 tokens and wrong for a chosen 400k.
  The catalog's `window` makes the numbers exact for known models, and unknown ids fall to 200k.

## Consequences
- `/autocompact` inside a session nika started is locked to the environment ("takes precedence", spike S2 section 5.7), and a
  subagent's own `autoCompactWindow` can only lower it. A user who wants a different setting changes it in nika's Settings and
  restarts the session, or starts the session by hand.
- The PCT effect is proven by reading the Claude Code 2.1.319 binary, not by watching a compaction (the variable is named as a
  test hook in the code, so a later release may change it). The constants 20000 and 13000 are Claude Code internals; if they
  change, the number nika computes drifts by a few per cent. `/context` shows the live buffer if a recheck is ever wanted.
- A very low per cent on a 200k model puts the threshold under the ~59k a fresh session already weighs (below about 33 %).
  The setting allows it (the owner's range is 20–95); the page's result line shows the number.
- Both variables are set on every launch while the setting is on, so a window or PCT already in the tmux server's or the CLI's
  environment is overwritten, never inherited. Only with the setting off does the inherited environment apply.
- Browser tier: the setting is read-only data nobody can change there; the tier has no launch path.
