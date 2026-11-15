# ADR 0017 — Fit: a lease on the tmux window, zoom and resize only when safe, an exact restore

Date 2026-11-14 · Status accepted (nika 0.5)

## Context
The session window mirrors a pane at the pane's own size. Next to Claude in a tmux window there are often other panes, so the
mirror is either cut off or leaves empty space in the panel. 0.5 makes the mirrored pane fill the panel: the page measures it and
the app tier zooms the pane and sizes the tmux window to match, then puts everything back. That changes the user's own tmux
window, which they may be looking at, so four things have to be decided:

- **What may nika change, and when is it safe?** A window resized smaller squeezes its other panes (spike S10: a 37-column pane
  became 1 column and a shell kept stray scrollback), and a blind zoom toggle undoes a zoom the user made.
- **How does nika give the window back exactly?** `set-option -wu window-size` alone does not (S10: wrong layout, wrong active
  pane, and with no client the window stays at nika's size).
- **Who holds the window?** One tmux window has one zoom flag and one size, so two session windows cannot both fit it.
- **What if nika dies or the user changes the window meanwhile?** A crash must not leave the window at nika's size for good, and
  nika must never undo or overwrite a change the user made.

Everything nika does here is a write to tmux driven by a page that is untrusted input (rule 12), so the targets and the stored
values must not be steerable from a request, a tag or a file.

## Decision
- **App tier only, always on.** `PUT /api/app/pane/:id/fit { cols, rows, open }` and `DELETE …/fit`, new module `src/fit.js`, no
  setting. The request carries only the panel size (integers, 40–400 × 10–200) and `open`; every tmux target and stored value
  (`@W`, `%P`, pane count, zoom flag, sizes, the `window-size` option, the layout) is read from tmux's own listing in the same call.
- **Zoom always, resize only when it cannot squeeze.** A window with several panes is zoomed on the mirrored pane (only when
  nobody has zoomed it; the flag and the active pane are read first, so no blind toggle). It is resized to the panel only when the
  panel is at least as wide and as tall as the window; a smaller panel gets the zoom only and the page scales its text (never
  above 1×, never below 0.4×). A renew that finds a smaller panel resizes back to the window's original size, never below it. A
  single-pane window has no siblings and is resized to the panel.
- **One lease per tmux window, in three places.** Server memory (the truth while running), a 0600 file
  `<state>/fit/fit-<nonce>.json` written before the first tmux change (crash recovery), and the window option
  `@nika-fit <16 hex nonce>` (proof that the window is the same one and nika's; it dies with the tmux server). A restore runs only
  while the tag still equals the nonce nika holds; a tag that differs or is gone drops the lease without touching tmux. The last
  opened session window takes a window; the other shows "another window".
- **Restore is the spike's sequence, undoing only what nika did.** Judged first on nika's size: is the layout still the one nika left,
  with the same pane count? Then: unzoom only a zoom nika made and only while it is still on the mirrored pane; `resize-window` back;
  the saved `window-size` back exactly (unset again when it was unset); `select-layout` of the saved layout only when the layout is
  unchanged and the window unzoomed (the 3.8 `"a"` and `"l"` markers removed, so focus does not move); focus back only when it still
  sits where nika put it; tag off; file removed; one read at the end that logs a difference and never retries. The restore is exact
  except tmux's last-pane order: the `l` markers are stripped before the layout is applied, so the pane `last-pane` would jump back to
  is not restored. The resize back also overrides a resize the user made during the lease: the saved size is the only size nika can
  name, and a window left at the panel's size would be worse. The answer of a request that ends in a release (`blocked /
  user-change`, `blocked / changed`) describes the window after the restore (a fresh pane size and pane count; `userZoom` only while
  the user's own zoom still holds), not the read-back taken while fitted.
- **A page that goes quiet, or a user who changes the window, ends the lease.** The page beats every 5 s; 15 s without a beat
  releases. A 1 s watch (only while a lease is held) releases on the first sign of a user change: unzoom, navigation, a different
  pane count or window size, the pane gone. After a user change, or a read-back that differs from what nika set (a tmux hook fought
  back), the window stays off (`blocked / user-change`, `blocked / changed`) until the session window is opened again (`open: true`):
  nika never re-asserts and never loops (owner decision 2026-11-14, Q6). A heartbeat that was already on its way when the page's own
  `DELETE` gave the window back would otherwise fit it again: for 2 s after a `DELETE` that gave a lease back, a `PUT` with `open:
  false` answers `blocked / user-change` and changes nothing (an in-memory note, at most 64 windows; `open: true` clears it).
- **A user's zoom of another pane blocks the fit** (`blocked / user-zoom`, owner decision Q1); a user's zoom of the mirrored pane is
  kept and never undone. A `window-size` option that is not unset or one of the four known values blocks the fit, because it could
  not be put back exactly.
- **Everything under the pane's control lock, reads included.** Every tmux change of a fit runs in `withPaneLock` of
  `createSessionControl`, which waits for a running End, draft write, mode switch or command (at most 5 s, then 409 `busy`), so a
  resize never lands in the middle of a draft write. Because that wait can be long, every read that decides a zoom, a resize or a
  restore is taken inside the lock too (review I1): an acquire lists the window again, reads the layout and the `window-size`
  option again and compares them with what its decision rested on (pane count, zoom flag, active pane, tag, window and pane size,
  layout, option), and changes nothing when any of them differs (`blocked / changed`; no tag, no lease, no file, no mark); a
  restore runs wholly inside the lock, from its own listing and layout read; a renew that resizes lists the window again inside the
  lock and judges it against the size nika holds (review N1), and on a difference (the user resized, unzoomed, moved the focus or
  split during the wait) it resizes nothing and releases as a user change, so a user's resize is never overridden. Otherwise a
  user's `C-b z` or focus change during the wait would meet a blind `resize-pane -Z` built from an older listing, and their resize
  a `resize-window` built from an older size. A step holds the lock for at most 8 calls (a restore), 6 (an acquire) or 2 (a
  resizing renew). While a fit step holds the pane the other control actions
  answer 409 `busy-switching`. One acquire, renew or release runs at a time per window.
- **Spawn gives the window back first** (owner decision Q3). A split into a fitted window would unzoom it and put the new pane
  into a nika-sized window, so `spawnAgent` reads the window id of its split target (`display-message -p -t <target> -F
  '#{window_id}'`) and calls `releaseWindow` before the `split-window`; the page fits again on its next beat.
- **Quit and start.** `finish()` stops taking requests, then `releaseAll()` (bounded by 3 s); `start()` runs `recover()` (bounded by
  3 s) before `ready`, which gives back what a crash left, from the lease files.
- **Own files go through `fwrite.js`.** The lease file is written by `writeAtomic` and removed by the new `removeOwnFile(dir, name)`
  (rule 11); it is read back through `fsafe` with every field shape-checked.
- Rate: 4 requests per second per pane, in one bucket for `PUT` and another for `DELETE`.

## Alternatives
- **Resize without a zoom, or always to the panel.** Simplest, and it squeezes the other panes: S10 measured a sibling at 1 column
  and permanent stray scrollback in a shell that nika cannot undo. Rejected; resize only when the panel is at least the window.
- **Restore with `set-option -wu window-size` only.** S10 (Q4, evidence A): the layout and the active pane come back wrong, and with
  no client attached the window stays at nika's size. Rejected for the saved-layout restore above.
- **A blind `resize-pane -Z`.** It toggles the window and unzooms a zoom the user made (S10 Q1, Q4, Q5). Rejected: read the flag first.
- **Taking over a pane the user zoomed** (`select-pane -Z`, S10 Q4: it works). Rejected (Q1): the zoom is a deliberate choice, and
  taking it over adds the one restore step that re-zooms the user's pane and can misfire if focus moved.
- **The lease in one place only.** Tag only: after a crash nothing knows the saved layout and size. File only: window ids restart at
  `@0` after a tmux restart, so a file could "restore" another window (S10 Q5). Memory only: no crash recovery. Rejected: the three
  together, with the tag as the check.
- **A lease per pane.** One zoom flag and one size per window (S10 Q5): two fits would fight and break each other. Rejected.
- **Re-asserting after the user changed the window.** The user just undid nika's zoom; zooming again 5 s later is fighting them (Q6).
  Rejected: stay off until the window is opened again.
- **Refusing a spawn into a fitted window, or splitting with `-Z`.** The first blocks the orchestrator's main action; the second
  leaves a nika-sized window with an extra pane. Rejected (Q3): release first.
- **Putting the fit on the capture route.** The capture's ETag and 250 ms cache stay untouched (the draft sync relies on them), a
  beat has to run while the mirror is hidden, and the capture must never change tmux. Rejected: two routes.
- **A settings switch.** Draft sync has none either; the chip tells the user when nika holds a window. Not built.

## Consequences
- nika now changes the user's tmux window while the session window is open, which is why the chip is always visible (colour, icon
  and words) and why the lease, the watch and the tag exist. A crash leaves the window at nika's size until the next app-tier start;
  a user's change is seen within one 1 s tick of the watch, and the restore follows within tens of milliseconds (measured on
  tmux 3.8: the whole restore was done 1009 to 1045 ms after the change); every `resize-window` sends SIGWINCH to every pane of the window, and with `focus-events on`
  zoom and restore flip the active pane (`ESC[I` / `ESC[O` to panes that asked for focus reports). A tmux hook that rewrites the
  layout makes nika release and stay off. `docs/security.md` T52 and residual risk m list them.
- `pane-border-status top|bottom` makes tmux reserve one row for the border line on every pane, a zoomed or only pane included
  (tmux 3.8 `layout_fix_panes`), so the read-back accepts a pane height of the window's or one row less (width and window size stay
  exact); anything further off is still a mismatch (`blocked / changed`), and the page keeps asking for the panel's rows.
- The page and the control lock now depend on each other: the draft sync must re-push after a 409 `busy-switching` (it does, about
  300 ms later).
- Rules 3, 4, 11 and 12 gain the fit: new tmux argv shapes (and the spawn read of the window id), new reads, the lease files and
  `removeOwnFile`. `src/ids.js` holds `WINDOW_ID` and `FIT_NONCE`.
- Verified live on tmux 3.8 (spike S10 and the release's live checks) and, through the fit group of `scripts/linux-verify.sh`, by
  the `linux-verify` CI job on the Linux runner's tmux (ubuntu-latest ships tmux 3.6a): a 3-pane window and a single pane fitted and
  given back exactly, `select-layout -- <layout>` accepted, and `show-options -w window-size` empty while unset. The floor is 3.2;
  tmux 3.2 to 3.5 and 3.7 are not verified (the older layout string without markers was exercised only by 3.4, which CI no longer runs).
- Not built: the take-over of a user's zoom, re-asserting after a user change, reading `#{window_manual_width}` (3.8 only), any fit on
  the browser tier.

## Amendment 2026-11-15 (0.5, F1): the chip is a button, and Fit again re-opens

Owner request (2026-11-15): after nika puts a window back because of a change the user made, the only way to fit again was to close and open
the session window, and nothing on the page said so for a keyboard or touch user (the reason was a `title` and one announcement). The chip is
now a button that opens a small panel (heading, the reason, a hint and, where it helps, an action), and the action sends the request the
reopened window would have sent. Everything below is page side; **the routes, their bodies, their answers and the controller are unchanged**.

- **What the action sends.** "Fit again" (states `blocked / user-change`, `blocked / changed` and a `blocked` with no known reason) and
  "Fit here" (state `other`) make the page's next `PUT` carry `open: true`, the one flag that already clears a window's mark and takes a
  window over from another nika window (rows 6 and 8 of the contract's decision table). The planner (`createFitPlanner`) gains `reopen()`: it
  clears a waiting heartbeat, re-arms the beat and sends at once, or as soon as the request in flight ends. Exactly one asked request is
  tracked; a refused or lost one (any status but 200 or 403) leaves the page treating the window as not yet opened, so the next heartbeat
  sends `open: true` again, and a second ask while one is pending does nothing.
- **Owner decision W7 Q6 stays.** After a user change nika stays off until the *user* asks: by opening the session window or by pressing
  Fit again. Nothing fits the window again on nika's own initiative, and `open: true` is still sent only on a page load, a `pageshow` from the
  back/forward cache and the user's ask.
- **No action where it cannot help.** `user-zoom`, `size-option` and `foreign-tag` get a hint (and, for `foreign-tag`, the command
  `tmux set-option -wu @nika-fit` as text) but no button: the controller refuses `open: true` again for them, so a button would only
  fail. `user-zoom` and `foreign-tag` recover on the next heartbeat once the user acts in tmux.
- **A button in every state** (fitted and zoomed too), because the panel is where the reason is readable without a pointer. The chip's
  words and colours are unchanged; the `user-change` title no longer says "Reopen the session window to fit again".
- **Alternatives rejected.** *A "Fit again" chip without a panel*: no room for the reason or the hint, which would stay a `title` that
  keyboard and touch users never see. *Fitting again by itself after a user change* (on a timer or at the next heartbeat): the user just undid nika's
  zoom, and doing it again is fighting them (Q6 stands). *A new route or a new body field for the ask*: `open` already means "the user opened this
  window"; a second flag would only duplicate it.
- **Consequences.** The page's rule "every later request is `open: false`" now reads "until the user asks again"; `opened` is set by a 200
  and cleared by a failed ask. A user who presses Fit again over a window that still cannot be fitted (the same reason) gets the panel drawn
  again and "Fit is still off. <reason>" announced. `docs/design/spec.md` §9.13 has the panel, its keys and its copy.

## Amendment 2026-11-15 (0.5, F2): nika's own agent panes never turn the fit off

Owner request (2026-11-15): an orchestrator starts agents, and its agents end, in the window that is fitted. The first version took every
split and every exit for a change of the user's, restored the window and stayed off, so a window with a working orchestrator was off most
of the time. The decisions of the same day: refit at once, in the watch (Q2); a pane the user closes by hand that nika tagged as an agent
counts as nika's (Q3); one watch tick of grace for a new pane that has no tag yet (Q4); the rule text of constraints 4 and 12 (Q6). Server
side only, in `src/fit.js`; **no new route, body field, file key, tmux command or argv shape** (`ARGV` and `FILE_KEYS` are unchanged).

- **What the watch can tell.** The fit's `list-panes -a` gets a 12th constant field, `#{@nika-role}`, read as exact text and compared only
  with `agent` and `sub-orchestrator` (`NIKA_PANES`; never `orchestrator`, never any other text). A row needs exactly 12 fields, so a role
  with a tab in it drops the row, and a dropped row of the window makes the row count differ from `window_panes`, which is a user change
  (fail closed). The spawn sets `@nika-role` with `tagPane` right after `split-window` returns, which is why a new pane with no role gets one tick.
- **What the lease remembers (memory only).** `known`: which panes of its window were nika's agents (set after every read-back that
  succeeds and refreshed at every quiet watch tick), because a pane that left has no tags to read. `waitAt`: when the watch first saw an untagged new pane.
  Neither is written to the lease file.
- **The rules (`observe`).** A size change is judged first and is always the user's: a split or an exit changes the pane count and
  unzooms the window, never its size. When the panes are the same, an unzoom or another active pane is the user's. When panes came or went,
  the zoom and the active pane say nothing about the user (a split without `-Z` unzooms and activates the new pane; so does an exit). Panes
  added and all tagged `agent` or `sub-orchestrator`, and panes removed all known as nika's → **refit**. Any removed pane that was not known
  as an agent → the user's. An added pane with no role yet → **wait**: the watch remembers the first sighting and a look at least
  `WATCH_MS` later that still sees it untagged is a user change.
- **The refit.** `releaseNow` without a mark, a fresh listing, then `decide(…, open: false)` with the lease's last `cols` and `rows`, in the
  window queue under the pane lock: a mark, a fresh note of the page's `DELETE`, a foreign tag and every refusal still win. The new lease
  keeps the old `lastBeat`, so only the page's own request keeps a lease alive; a lapsed lease (> 15 s) is only released, never refitted or
  waited for. A page request that meets the change before the watch (`renew`, and the N1 recheck inside the pane lock) does the same:
  refit → release and acquire in the one request, wait → answered from the lease with no resize (the grace is counted from the watch's tick,
  not the request). Calls: 18 after a split, 19 after an agent pane exits, because the restore then also puts focus back on the pane that
  was active before nika's zoom.
- **The user's table.** Split by the orchestrator's `nika spawn`, an agent's claude ending, a sub-orchestrator's agents: fitted again within
  about a second. The user's own split, unzoom, focus change, resize or kill: off, as before (Fit again, F1). A user split in the same
  second as a spawn: off (the user's pane is untagged). `docs/design/spec.md` §9.13 has the table.
- **Alternatives rejected.** *Re-base the lease instead of release + acquire* (update `panes`, zoom again): the restore's saved layout and
  window size would need recomputing at a fitted size; release + acquire reuses the two tested paths. *Let the page's next beat acquire after a
  release without a mark* (no refit in the watch): the window sits restored for up to 5 s and then jumps back, two visible jumps instead of one
  redraw pair. *Read the role through the tmux collector* (`src/collect/tmux.js`): a second listing per tick, outside the fit's
  one-listing decision; the fit's own listing keeps every decision on one snapshot. *`ctx.started` (panes this process started) instead of the tag*: the CLI's spawns are
  another process, which is the case F2 must cover. (A "Fit again" chip without a panel, the fifth alternative of the design, is in the F1 amendment.)
- **Consequences.** `fit.test.js`'s fake tmux lists a role per pane; the F2 tests assert the exact call sequence of a refit, the grace to
  the millisecond and every user change that must stay one. Residuals (`docs/security.md`, residual m items 6, 7 and 11 to 14): a split
  between the acquire's resize and its read-back still ends `blocked / changed` (Fit again recovers it); a pane the user closes by hand
  that nika tagged counts as nika's; a forged `@nika-role agent` makes nika refit instead of staying off (same window, same size, within
  the single-user trust model); a refit applies two size changes in a row and cannot restore the saved layout (the pane count changed); and
  **a `DELETE` of the session window that races a refit can leave the new lease held until it lapses**: `release` looks the pane's lease up
  when the request arrives, so a `DELETE` that waits in the window queue behind a refit finds the old lease finished and does nothing, and one
  that arrives between the refit's restore and its acquire finds no lease. The new lease inherits the old heartbeat, so the window stays
  fitted for at most 15 s after the page's last request and is then given back without a mark. Not fixed in F2; the cheap fix, if wanted, is
  to look the pane up again after the release in `release` and release a replacement lease.
- **Not built:** telling a user's close of an agent's pane from the agent's own exit; fitting again after a user change without the user
  asking (the W7 Q6 rule stands); a remembered "never fit this window" choice.
