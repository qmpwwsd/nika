# ADR 0014 — Auto-compact via the launch environment

Date 2026-11-09 · Status accepted (nika 0.4)

## Context
A long Claude Code session fills its context window and then compacts at a point Claude Code picks. 0.4 lets the user say
when: Settings gets "Auto-compact at [80] % of [400k]", on by default, and it applies to every claude nika starts (the
orchestrator, fresh or resumed, and spawned agents and sub-orchestrators). Sessions already running and sessions the user
starts by hand get no environment (since 0.5.4 the app types `/compact` into them, see the amendment at the end). Spike S2 (Claude Code 2.1.319, tmux 3.8) measured what is available:

- `--autocompact <tokens>` and the environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set the same window. The variable
  wins when both are set. Both are capped at the model's real window (1M for the 5.x ids, 200k for the 4.x ids and unknown ids).
- Claude Code compacts at `min(floor(effective x PCT / 100), effective - 13000)` with `effective = window - 20000`
  (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is PCT). So PCT is a per cent of the window minus 20k, not of the window, and with no
  PCT the session compacts at `window - 33000` (the 33k `/context` shows as the autocompact buffer). With the window unset
  ("auto" source) proactive compaction is off, so the window must always be set when a PCT is. *(Corrected in 0.5.4: an unset
  window is not the `auto` source; see the amendment at the end. nika still sets both variables on every launch.)*
- `/context` never shows the PCT, so the live threshold cannot be read back from the UI.
- tmux `new-session -e` and `new-window -e` are repeatable and the value is literal (no format expansion, `#` and spaces kept). Their
  scope differs (found in review, tmux 3.8): `new-window -e` sets the new pane's environment only; `new-session -e` sets the SESSION
  environment, which every later pane of that tmux session inherits. `new-session -e` needs tmux 3.2 (`new-window -e`: 3.0). The
  environment of a no-shell `spawn()` is the other place a value can go.
- The user's own Claude settings may already carry a window (on the machine of the spike, 400k).

## Decision
- **The setting** is `compaction: { enabled, pct, window }` in `config.json` and `GET|PUT /api/app/settings` (C7): `pct` an
  integer 20–95, `window` 200000, 400000, 1000000 or `"model"`, default on, 80, 400000.
- **The mechanism is the environment pair**, never the `--autocompact` flag. `compactLaunch(model, compaction)` in
  `src/compact.js` (pure) returns `null` when off, else `{ env, window, compactAt }`:
  `W` is the model's window (`modelWindow`, from the catalog's new `window` field after dropping one trailing `-YYYYMMDD` date suffix, else 1M for `[1m]`, else 200k) when the
  setting says `"model"`, else `min(setting, model window)`; `target = floor(W x pct / 100)`; `limit = W - 33000`;
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW = W`; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = ceil4(100 x target / (W - 20000))` when
  `target <= limit`, else `100` (Claude computes `min((W - 20000) x 100 / 100, W - 33000)`, which is the cap). The PCT is therefore always
  set, and an inherited value can never stay in force. `compactAt = min(target, limit)` is what the session will do.
- **Validate before use.** `compactEnv` accepts an integer window in 100000–1000000 and a PCT string of digits and at most one
  dot (above 0, at most 100; never `null`), and throws otherwise. A setting outside its ranges throws in `compactLaunch`. Whatever reaches a
  launch passed it: the orchestrator's `-e` values, and the agent's, which `_run-agent` checks again.
- **Orchestrator.** The tmux call that creates its pane gets one `-e NAME=value` per variable, before `--`. The model is the
  project's effective orchestrator model, so a per-project model changes `W`. After a `new-session` that carried `-e`, nika runs
  `set-environment -t =<session> -u <NAME>` once per name it sent (fixed argv, exact target, only the two constant names; best
  effort, the start answers as usual if it fails). The first pane already holds its copy, since a process environment is fixed when it
  starts, and later panes inherit the global environment again. `new-window -e` is pane-only and needs no cleanup.
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
- The variables live only in the orchestrator's pane and in each agent's process. A window you open in the project's tmux session, or a
  claude you start by hand there, does not get them, and neither does an agent spawned after the setting went off. If the cleanup
  `set-environment -u` fails (best effort), the pair stays in the project session's environment until that tmux session ends, and a
  pane started there with the setting off would inherit it; this is the one residual (T48).
- tmux 3.2 or newer is required for `new-session -e`. On tmux 3.0 or 3.1 the default-on setting makes the orchestrator start fail with
  tmux's own error; the remedy is a newer tmux or switching Auto-compact off in Settings. The README and `docs/packaging.md` state the floor.
- Browser tier: the setting is read-only data nobody can change there; the tier has no launch path.

## Amendment 2026-11-19 (0.5.4, AC): typed `/compact`, and what Claude Code 2.1.328 does with the window

**Context.** The launch environment reaches only sessions nika starts, and Claude Code checks the compact point only before a request, so a
session that waits (finished, or waiting for the user) is never compacted by it, and a session the user started by hand has no variable at
all. The owner (2026-11-19, "yes, all sessions") asked nika to compact every live Claude session it shows when one waits past the point.
The live check of 0.5.4 (Claude Code 2.1.328 and 2.1.329, `claude-haiku-5-5`) and the binary gave these facts:

- 2.1.328 keeps the formula of this ADR: `T = min(floor(E × PCT / 100), E − 13000)`, `E = W − 20000`; nika's 400k window with PCT 84.2106
  gives 320000. Live, with a window of 80000 the source read `env` and `T` was 60000, which matched Claude's footer.
- **Correction.** An unset window variable does not mean the `auto` source (Context above). 2.1.328 takes the window from
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (source `env`), else the user's `autoCompactWindow` unless it is `"auto"` (source `settings`), else a served or
  model default, and only last `auto`. Only the `auto` source turns proactive compaction off. Live, with no variable and no setting, Haiku 5.5
  logged `level=ok effectiveWindow=980000`: a default source, about 967k, not off. nika still sets both variables on every launch, so the
  correction changes no number nika computes.
- Claude's own Auto-compact switch off (`autoCompactEnabled` false), or `DISABLE_AUTO_COMPACT=1`, stops all proactive compaction, idle
  compaction too; nika's variables cannot override it.
- The check runs before every request, mid-turn and between turns. A session that waits sends no request and is never checked, except by
  Claude's idle compaction (about 54 minutes after a turn, only with a 1 h prompt cache).
- A session started or resumed by hand gets neither variable. A typed `/compact` through nika's command route ran a manual compaction (200,
  `PostCompact` with `manual`, the box back in 6.6 s, keys `/`, `compact`, `Enter` only).
- A compaction writes a `system` entry with `subtype` `compact_boundary` and `compactMetadata.postTokens`; Claude's own size uses it until the
  next reply. With `/compact` in the box the slash menu is drawn above the box's top rule and the footer still reads.
- 2.1.329 behaved as 2.1.328 here. Its footer says `auto-compact next`, not `N% until auto-compact`.

**Decision.**
- **App tier only, setting on:** nika types `/compact` into a live Claude session it shows that waits past its compact point, whether nika
  started it or not. Claude's own switch is never read or changed (owner decision AC-Q6 = A). The launch environment is unchanged. The browser
  tier and the CLI never type.
- **The point** is `compactLaunch(<model>, <setting>).compactAt` for the model of the session's context size, the number the meter shows (new
  C6 word `typed` for a live session nika did not start, `docs/contracts/api-app.md` C6). The size is read through `usageOf`, which now stops at
  a `compact_boundary` entry that comes after the last assistant entry and takes its `postTokens` (an integer from 0 to 10,000,000, else no size),
  so a typed `/compact` re-arms only after a real drop.
- **When** (`src/autocompact.js`, `decide`, ticked by the app's 3 s status timer; at most one pane per tick): the pane passes the keys route's
  pane check and holds exactly one live session; the size is at or past the point; the registry has read `idle` at each of nika's ticks for at
  least 60 s with no change of size or session (a tick that does not observe the pane, because it is not eligible, does not hold exactly one live
  row, is missing from tmux's listing, or tmux or the registry cannot be read, restarts the count; failures, floor, armed state and notes are
  kept); no user action has named the pane for 60 s; the pane is armed (a size below the point has been read since the last typed `/compact`);
  at least 10 minutes since the last attempt that sent a key; fewer than 3 failed attempts on that pane since the app started (a total, a
  success never resets it).
- **A user action stamps the pane** once its request has passed the pane check and the body check, also when it is then refused with 409 or 429
  (owner answer AC-N2 = A; a 404 pane check or a 400, 413 or 415 body check stamps nothing). That is 16 routes: keys, mode, draft (PUT), submit,
  scroll, attachments (POST, pick, DELETE), attach-send, suggestion, dialog, survey, answer, command, end and stop; a capture with the header
  `X-Nika-Typing: 1` (sent once, after an edit in the message box, IME events included) stamps too. The fit heartbeat, a capture without the
  header, the attachment status, list and image reads and the kept-draft routes (0.5.4, LT) stamp nothing. A stamp is forgotten only when a good tmux
  listing no longer lists the pane.
- **How:** `autoCompact(pane)` in `src/session-control.js`, inside the same per-pane lock as every other control, without waiting for it: a fresh
  capture with the registry state, the registry read again without its cache, a second fresh capture, each showing idle, no prompt, dialog or survey,
  a readable footer, no running turn and an empty prompt-mode box; then the Compact quick action's typing (`/` read back, the vim road, `compact`,
  `Enter` only when the box reads exactly `❯ /compact` and the screen is still quiet); after `Enter` a 2 s read (a running turn or a box without
  `/compact` is success; otherwise nika removes its own text with `C-u`, never a user's draft). Only those keys, at most 11 key requests per
  attempt, through the per-pane rate limit; `Escape` is refused while a rating's undo row shows. A refusal before any key retries after 30 s.
- **Once per crossing.** After a success the pane is disarmed until a size below the point is read. All state is in memory: an app restart arms
  every pane again and clears the failure count. After 3 failures nika types nothing more into that pane until the restart and the page says so.
- **Notes** (`typed`, `compacted`, `stopped`, each with its own icon, colour token and words) travel only under `/api/app/*` (the capture body's
  `compacted` and `/api/app/modes` `{ modes, compacted }`), carry no session id or text, and are drawn from numbers with `textContent`.

**Rejected.**
- *Turn Claude's switch on* (`autoCompactEnabled: true` in the agents' `--settings`): overrides the user's own choice and needs a settings-key
  rule change (AC-Q6 = B, declined).
- *Read `autoCompactEnabled` to warn when Claude's switch is off:* reads a Claude settings key, which rules 4 and 12 forbid.
- *End hand-started sessions and resume them with the variables:* disruptive, loses the terminal's state, and still cannot act on a session in
  another terminal.
- *Set the variables in a running session:* a process environment cannot be changed from outside, and the check never runs while the session waits.
- *Stamp any valid pane id when the request arrives, before the pane and body checks* (AC-N2 = B): it closes a gap of one request inside a
  one-second miss of the session registry and only ever delays typing; the owner kept the code and moved the rule's wording.

**Consequences.**
- New automatic input (rule 12 **Typed compaction**, `docs/security.md` T72 to T74, residual r). A finished session waiting to be closed
  compacts once (owner decision 2026-11-19).
- A key the user types into the real terminal, or a turn that starts, between the last capture and `Enter` is not seen. Passthrough keys can
  interleave with nika's own: the echo check then refuses `Enter` and `C-u` removes only nika's own remnant; mixed text stays in the box.
  `POST keys` takes no pane lock and Stop runs outside it; scroll, fit and attach-send wait for the lock.
- Claude's own compaction can run at the same moment (its pre-request check, or its idle compaction); the typed `/compact` then waits in
  Claude's queue or meets a busy screen and is not typed. Live (nika-started sessions) Claude's `PreCompact` `auto` fired first without a
  `PostCompact`, and nika's manual one then worked.
- Known limits (live check): a background shell that still runs is not a running turn, so `/compact` is typed (Claude took it); after a
  compaction the size stays below the point until the user's next turn, so with a point below what a fresh session loads (a low percent on a
  small window with the user's own rules) nika types at most once per user turn, 10 minutes apart; the registry is matched by pane id only, so
  the same pane id on another tmux server can be taken for the session; a session in a plain terminal or on another tmux server is not reached.
- Not built: typing into a session that keeps working past the point (Claude compacts it itself, or nika at its next wait).
- Details: `docs/design/spec.md` §9.25 (the session line, the meter and the Settings sentence) and `docs/contracts/api-app.md` (C6).
