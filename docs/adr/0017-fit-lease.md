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
  setting *(0.5.4: there is one now, `fit.mode`, and `off` holds no lease; see "Fit modes" at the end)*. The request carries only the panel size (integers, 40–400 × 10–200) and `open`; every tmux target and stored value
  (`@W`, `%P`, pane count, zoom flag, sizes, the `window-size` option, the layout) is read from tmux's own listing in the same call.
- **Zoom always, resize only when it cannot squeeze.** A window with several panes is zoomed on the mirrored pane (only when
  nobody has zoomed it; the flag and the active pane are read first, so no blind toggle). It is resized to the panel only when the
  panel is at least as wide and as tall as the window; a smaller panel gets the zoom only and the page scales its text (never
  above 1×, never below 0.4×). A renew that finds a smaller panel resizes back to the window's original size, never below it. A
  single-pane window has no siblings and is resized to the panel. *F15 (the last amendment of this file) narrows this: while the session
  window has focus, a smaller panel also sizes a window with several panes, and the way back puts its layout back.*
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
  '#{window_id}'`) and calls `releaseWindow` before the `split-window`; the page fits again on its next beat. *(0.5.4: gone. A spawn
  never splits a window that is zoomed or that carries `@nika-fit`, so `releaseFitted` and `fit.releaseWindow` were removed; the new
  agent goes to the agents window instead. See ADR 0021, which replaces this decision, and the "Fit modes" amendment below.)*
- **Quit and start.** `finish()` stops taking requests, then `releaseAll()` (bounded by 3 s); `start()` runs `recover()` (bounded by
  3 s) before `ready`, which gives back what a crash left, from the lease files. (Fix before 0.5.0: the shell sends SIGTERM 2 s after
  stdin closes, and `finish()` used to remove the server's SIGTERM listener first, so the restore could be cut at 2 s. `finish()` now keeps a
  no-op SIGTERM listener from the start of the release until `releaseAll()` has resolved or hit its 3 s, then removes it; SIGINT is not held.
  The shell's SIGKILL at about 4 s is the only cut left.)
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
  leaves a nika-sized window with an extra pane. Rejected (Q3): release first. *(0.5.4: replaced by ADR 0021, a spawn never splits a fitted window.)*
- **Putting the fit on the capture route.** The capture's ETag and cache (250 ms then, 100 ms since F10) stay untouched (the draft sync relies on them), a
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
- Rules 3, 4, 11 and 12 gain the fit: new tmux argv shapes (and the spawn read of the window id, *gone in 0.5.4, ADR 0021*), new reads, the lease files and
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
  second as a spawn: off (the user's pane is untagged). *(0.5.4: a spawn no longer splits a fitted window, ADR 0021; the rest of this row stands.)* `docs/design/spec.md` §9.13 has the table.
- **Alternatives rejected.** *Re-base the lease instead of release + acquire* (update `panes`, zoom again): the restore's saved layout and
  window size would need recomputing at a fitted size; release + acquire reuses the two tested paths. *Let the page's next beat acquire after a
  release without a mark* (no refit in the watch): the window sits restored for up to 5 s and then jumps back, two visible jumps instead of one
  redraw pair. *Read the role through the tmux collector* (`src/collect/tmux.js`): a second listing per tick, outside the fit's
  one-listing decision; the fit's own listing keeps every decision on one snapshot. *`ctx.started` (panes this process started) instead of the tag*: the CLI's spawns are
  another process, which is the case F2 must cover. (A "Fit again" chip without a panel, the fifth alternative of the design, is in the F1 amendment.)
- **Consequences.** `fit.test.js`'s fake tmux lists a role per pane; the F2 tests assert the exact call sequence of a refit, the grace to
  the millisecond and every user change that must stay one. Residuals (`docs/security.md`, residual m items 6, 7, 11, 12 and 13): a split
  between the acquire's resize and its read-back still ends `blocked / changed` (Fit again recovers it); a pane the user closes by hand
  that nika tagged counts as nika's; a forged `@nika-role agent` makes nika refit instead of staying off (same window, same size, within
  the single-user trust model); and a refit applies two size changes in a row and cannot restore the saved layout (the pane count changed).
- **Not built:** telling a user's close of an agent's pane from the agent's own exit; fitting again after a user change without the user
  asking (the W7 Q6 rule stands); a remembered "never fit this window" choice.

## Amendment 2026-11-16 (0.5, F4): nika never resizes a tmux window that a terminal shows

*F9 (the amendment at the end of this file) narrows this: the rule below holds for a session window without focus; the SHRINK and GROW refits are
replaced by in place moves.*

Owner ruling (2026-11-16, "need to fix it"): with the user's own terminal attached to the orchestrator's tmux window and the session window open,
the fit resized the window to the panel (`window-size manual`) and the terminal showed fill characters (dots) around the smaller window. From now
on, while any terminal client views the tmux window nika never resizes it: it zooms the pane (a window with several panes) and the page scales the
text. When no terminal views the window nika may size it to the panel as before. "Never resize at all" and "keep as is" were rejected. Server side
in `src/fit.js`, page side in `public/fit-ui.js`; **no new route, body field, file key, tmux command or argv shape** (`ARGV` and `FILE_KEYS` are
unchanged). Evidence: spike S16 (tmux 3.8, a private socket) and the two live checks F4a and F4b of the `linux-verify` fit group.

- **The test: a terminal views the window.** The fit's single `list-panes -a` gets a 13th constant field, `#{window_active_clients}`, read as digits
  in 0 to 9999 and compared only with 0 ("viewed" is above 0); it is never a target, a stored value, a lease-file key or page text. A row needs
  exactly 13 fields and a value that does not parse drops the row; a dropped row of the lease's window is a user change (fail closed, as in F2).
  **Every client counts**: a plain terminal, a control-mode client (iTerm2's tmux integration), an `ignore-size` client, a read-only one, and a
  client of a linked or grouped session on this window. A client on another window of the same session does not (tmux counts per window). Counting
  one that would not have shown dots costs only full-size text; missing one that does breaks the ruling. nika itself is never a client: the fit, the
  capture and every other tmux call of nika are command clients that never attach (spike S16 read 0 with only the listing connected). tmux computes
  the number and it is not an option, so no `set-option` can forge it; changing it means attaching or detaching a client on the tmux socket, which
  could resize any window anyway (rule 10). The field is in the tmux 3.1 source (the floor is 3.2); on a tmux without it the format expands to
  nothing, every row drops and the fit answers 404.
- **The state `terminal`.** A decision that finds the window viewed (row 12 of the contract's decision table; the `blocked` rows win over it) takes
  the lease and the tag as before, zooms a window with several panes that nobody has zoomed, and **never sends `resize-window`**. The answer is
  `{ state: "terminal", reason: null, pane, panes, userZoom }`. It wins over `zoomed / panel-smaller` (both are zoom only; `terminal` names the
  lasting reason). A renew of a `terminal` lease takes no lock and makes no tmux call; it keeps the panel's `cols` and `rows` for the grow below.
- **Two races close inside the request.** An acquire reads the viewer count again inside the pane lock: a terminal that arrived during the lock wait
  gets no resize and a `terminal` lease. The read-back (`verify`) does not judge the size of a `terminal` lease (the terminal sizes the window); when
  a terminal came between nika's own resize and the read-back (spike S16), nika gives the window back without a mark and the same request takes it
  again once with `noResize`, so the retry can neither resize nor answer `AGAIN`: at most one retry.
- **The watch** judges the viewer inside "nothing else changed", so a user who unzooms in the tick their terminal arrives is still a user change (W7
  Q6). The verdicts of `observe`:
  - a terminal views a window nika **resized** → **SHRINK**: a refit at once (F2's release without a mark, then decide again), which lands as
    `terminal`; a page request or the read-back may see it first. The dots last at most about a second.
  - a terminal views a window nika did **not** resize → **VIEW**: the lease becomes `terminal` in memory, no tmux call.
  - a `terminal` lease with no terminal → **AWAY**: the watch notes the first tick without a terminal (`awayAt`); a terminal back clears it.
  - a `terminal` lease with no terminal for `GROW_MS` (30 s, owner answer Q2) → **GROW**: a refit that sizes the window to the panel again →
    `fitted` or `zoomed`. Shrink at once, grow after 30 s: someone who looks away and comes back within 30 s never meets a resized window. A window
    does at most one grow and one shrink per 30 s, so at most 4 refits a minute.

  The size of a window nika did not resize is not judged while a terminal shows it or while the lease is `terminal` (the window follows its terminal:
  a terminal resize is not a user change). A size nika set is always judged (no terminal can resize a `manual` window). An unzoom, a focus change and
  a user's split or kill stay user changes. A page silent for 15 s still only releases (never a refit, a view or an away).
- **A refit inside the grace keeps it.** F2's refit of a `terminal` lease that is still inside the `GROW_MS` grace (an agent's split, say) takes the
  window again with `noResize`: it never ends the grace early, and the watch's refit carries `awayAt` to the new lease so the 30 s go on where they
  were. A refit that a **page request** meets first also stays `terminal`, but does not carry `awayAt`: the 30 s start over, which is longer, never
  shorter (kept on review, 2026-11-16).
- **The restore resizes back only a size nika set.** The lease has a memory flag `sized`, set before the call that may resize (A4, or a renew's
  `resize-window`), so a call that failed counts. A lease read from a file after a crash has it set (nika may have resized before the crash). R3, the
  resize back, runs only when `sized` and the size differs from the saved one. So the restore of a `terminal` lease, whose window follows its
  terminal, sends no `resize-window` (it would be one frame of dots and two redraws at every close of the session window), and a zoom-only window
  that the user resized by hand is left alone. "The resize back also overrides a resize the user made during the lease" (above) now holds for leases
  nika resized. R9, the one read at the end that logs a difference, compares the size only when `sized` **and** no terminal shows the window after the
  restore: after a SHRINK the window follows the terminal and its size is no longer the saved one (kept on review, 2026-11-16).
- **A `DELETE` that meets a refit releases the lease the refit made** (owner answer Q5; F2's leftover is fixed). `release` takes the window from the
  pane's lease, or from a queued operation of that pane (a refit between its restore and its acquire holds no lease), waits its turn in the window
  queue and releases **whatever lease the pane holds then**, not the one it found when it arrived. It notes the window for 2 s as before. A pane
  with no lease and no queued operation still answers `released: false` with no tmux call. A `DELETE` that meets a queued operation of its pane
  answers `released: true` and notes the window even when that operation ends with no lease, so a late heartbeat within 2 s is blocked.
- **The page.** Chip state `terminal`: words "Fit · your terminal's size", label "Fit: your terminal's size", the terminal icon (`i-term`), its own
  plum tokens `--fit-term*`. Two titles, chosen by the chip: with one pane, or the user's own zoom, "A terminal shows this tmux window, so nika
  leaves its size to the terminal and scales the text to this panel"; with several panes that nika zoomed "A terminal shows this tmux window, so
  nika only zoomed this pane, leaves the size to the terminal and scales the text to this panel" (chip keys `terminal:` and `terminal:zoom`). The
  panel of both has a hint and no action, because `open: true` cannot override the terminal rule. A Fit again answered `terminal` closes the panel,
  and the hint of `blocked / user-change` no longer promises a size. `docs/design/spec.md` §9.13 has the words, tokens and contrast.
- **Alternatives rejected.** *`list-clients -F '#{window_id}'`* (a second call, outside the fit's one-snapshot decision). *Leaving out control-mode,
  `ignore-size` or read-only clients*: they draw the window, so missing one breaks the ruling. *Counting every client of the window's session or of the
  server*: a window would almost never be full size while its session is attached, and the ruling says "views". *A reason on an existing state*
  (`zoomed / terminal`, `blocked / terminal`): "Fit · off" would show in the owner's own one-pane case and read as broken, and "zoomed" is false for one
  pane. *Shrinking in place instead of a refit* (option back, keep zoom and tag): the saved size and layout go stale against the terminal's size; the
  refit re-reads them and reuses tested paths. *Growing at once or at the next beat*: every short look away would leave a resized window and dots on
  return. *Growing only on Fit again*: the chip would claim "your terminal's size" after the terminal is gone for good. *tmux hooks for zero delay*:
  they write the user's tmux configuration and run commands from hooks, against rules 3 and 11. *No lease for a one-pane window a terminal shows*: the
  grow, the `other` state and the hysteresis would need a second mechanism.
- **Consequences.** Up to about a second of dots remains possible when a terminal comes to a window nika resized (the watch tick; a window with
  several panes also shows unzoomed for the refit's ~100 ms); only tmux hooks could remove it. A big terminal and a small panel give small text (about
  0.42× for a 200 × 50 pane in a 112 × 21 panel; below 0.4× the panel scrolls, W7 Q2). The zoom shows in the user's terminal and moves its focus to the
  mirrored pane. A refit sends the mirrored pane about 4 to 6 size changes within ~100 ms (Claude redraws on each); while a terminal shows the window
  nika sends none. The watch costs the same (one listing a second while a lease is held, one field more). The 30 s in the panel hints are typed text:
  if `GROW_MS` changes, `PANEL` in `public/fit-ui.js` changes with it. The `linux-verify` fit group gains F4a (a control-mode client shows the 3-pane
  window → `terminal`, zoomed, `window-size` never `manual`) and F4b (a fitted single pane, a control-mode client attaches → within 2.5 s the size is
  given back and the answer is `terminal`, the restore logs nothing); they run on the Linux runner's tmux in CI, not on macOS. Unverified: the field on
  tmux 3.2 to 3.5 and 3.7 (spike S16 read the 3.1 source and ran 3.8), how iTerm2's control mode draws a `manual` window, and tmux's `select-layout` of
  a layout saved at another size (R5 at a SHRINK). `docs/security.md` T52 and residual m items 14 to 19 list them. Rules 4 and 12 gain the viewer-count
  read and the sentences above (approved 2026-11-16).
- **Not built:** tmux hooks, a faster watch, a per-session or server-wide viewer test, a countdown of the 30 s on the page, a setting for the delay,
  skipping R3 for a resized lease while a terminal watches the release (it needs the window's global `window-size`, which nika does not read), and a
  Fit again that overrides the terminal rule.

## Amendment 2026-11-16 (0.5, F9): the focused window wins the pane's size

*F10 (the amendment at the end of this file) changes the page's settle times below to 150 ms for a blur and 150 ms for a focus (they were 200 and 400 ms), and measures
the panel only at commit points; the rest of this amendment holds.*

Owner ruling (2026-11-16, "Focused one wins"), after the F4 live check: a terminal 64 columns wide showed the orchestrator's window, and nika's
wide panel showed the pane scaled with empty space. While nika's session window has focus, nika sizes the tmux window to its panel **even when a
terminal shows it**. Click into the terminal and it gets its full size back within about 1 s. The owner accepts the cost: Claude redraws on each
switch, and the side not in use looks off (the terminal shows dots while you work in nika). F4 stays for a session window **without** focus. The owner
also decided design-F9 §11 Q1 to Q4 on 2026-11-16, all as recommended (marked Q1 to Q4 below). Server
side in `src/fit.js`, page side in `public/fit-ui.js` and `public/session.js`. **One new optional request field (`focus`), and no new route, lease-file
key, tmux command or argv shape** (`ARGV` and `FILE_KEYS` are unchanged). Evidence: the unit tests of the fake tmux world, spike S16 for the tmux facts,
and the live checks F9a and F9b of the `linux-verify` fit group, which pass in the CI job (confirmed on commit `2836505`; they do not run on macOS).

- **The one rule.** `yields = (a terminal shows the window) && !focus`. While `yields`, the lease behaves as F4's `terminal` form; otherwise the panel
  decides as in W7 (resize when that squeezes no pane, else zoom only). A page with focus, a terminal and a smaller panel over a window with several
  panes lands on `zoomed / panel-smaller`, not `terminal`: the reason nika does not resize is the squeeze rule, and the `zoomed` hint is the action that
  helps. For a page without focus F4's "`terminal` wins over `zoomed`" stays.
- **The page sends its focus.** Every fit `PUT` carries `focus`, a strict boolean: `document.visibilityState === 'visible' && document.hasFocus() === true`,
  and anything unreadable is `false`, so a page that cannot tell never holds the size of a window a terminal shows. The body is `{ cols, rows, open }` or
  `{ cols, rows, open, focus }`; an absent `focus` reads as `false` (the safe side, F4's behaviour; every older 3-key body and a page loaded before an
  update keep working). A `focus` that is not a boolean is `400`. Window `focus` and `blur` (target the window itself) and `visibilitychange` are only
  triggers: the value is always read fresh, a 1 s poll (`FOCUS_POLL_MS`) re-reads it, because WebKit changed these events in 2026 and the two webviews
  differ. A blur is sent after 200 ms (`BLUR_SETTLE_MS`), a focus after 400 ms (`FOCUS_SETTLE_MS`; a flick back sends nothing), a hidden window at once;
  not on the 5 s beat (owner decision 2026-11-16, Q3: about 0.3 s to the terminal, about 0.5 s to nika). A focus change refused or lost is sent again by
  the poll, at most once a second.
- **Two in place moves replace F4's two refits** (owner decision 2026-11-16, Q2: one in place move for every size switch, also for a terminal that
  arrives and for the 30 s grow, instead of release-and-acquire refits; about one redraw per pane per switch instead of three or four, and no flash of
  the unzoomed panes in the terminal). GIVE (the page has no focus and a terminal shows a window nika resized): `resize-window` back to the
  window's own size (`width0` × `height0`, only while nika holds a size and the window is not at it), then the `window-size` option back. TAKE (focus
  came, or the terminal has been away for `GROW_MS`, or a terminal resized a window nika did not): the window is planned again with the panel's size and
  `resize-window` is sent when the plan resizes. Each is one change of the window's size inside the window queue and the pane lock; the lease, the tag and
  the zoom stay (no unzoom, no flash of the other panes in a terminal that shows the window with several panes), so the mirrored pane sees about one
  size change per switch instead of F4's four to six. tmux resizes the whole layout of a zoomed window, so every pane of it (the hidden agent panes too)
  redraws once per move. The request that carries the change runs the move at once (a blur → give, a focus → take, in that request); the watch runs it
  within a second as the fallback, using the `focus` recorded from the last request, even a refused one (recorded before any check can refuse it).
  `layout0` is not refreshed by a move, so the final restore puts back the user's proportions and not tmux's rounded rescales; `verify` reads `layout1`
  again after each move. `verify`'s F4 retry after a terminal showed up between nika's resize and the read-back is now a give in the same request (for a
  page without focus); it can never give twice, because a give ends in the same read-back with nothing resized.
- **The cap** (owner decision 2026-11-16, Q3: at most 12 takes a minute per window, giving back never limited). A take for a page with focus that sent `resize-window` is noted per window; at most 12 (`TAKE_MAX`) in 60 000 ms (`TAKE_SPAN_MS`), kept in
  memory for 64 windows (the oldest dropped first). The thirteenth is not made: the lease stays `terminal` and the answer carries `reason: switching` to
  the page with focus (a blur after the cap answers a plain `terminal`); the watch takes when the minute frees up. A give is never limited, the unfocused
  take after `GROW_MS` and a renew to a new panel size do not count.
- **Answers and the chip** (owner decision 2026-11-16, Q1: "Fit · fills the panel" keeps its look when a terminal shows the window too, with its own title
  and panel line about the dots; a new colour would flip on every switch). No new state and no new colour: `fitted` gains the reason `terminal` (a terminal shows the window too: own title and panel line
  about the dots) and `terminal` gains the reason `switching`. Both are selected only by the exact pair of state and reason, never by a free reason text.
  A state change that follows a change of the page's own focus is drawn but not announced a second time; the answer to the user's own Fit again always is.
  `docs/design/spec.md` §9.13 has the words, and `docs/contracts/api-app.md` the rows.
- **The restore.** `sized` is set before every `resize-window` of an acquire, a renew or a take, and cleared only by a give whose calls both succeeded, so a
  failed call leaves the restore's resize back armed. Closing the session window (`pagehide`, a `DELETE`) after a give sends no resize back; after a take
  it sends one to the refreshed `width0` × `height0`. **Hiding** the window (close button, minimize) is a blur: it gives the size back and keeps the lease
  (owner decision 2026-11-16, Q4, as F4 does: hiding is usually brief, and a full release would unzoom and zoom on every hide and show).
- **Four details settled in the build (orchestrator rulings, 2026-11-16).** The design text was refined where the code and its tests showed a defect:
  1. A take expects the `window-size` option to be `manual` when nika holds a size it set earlier, and the value saved at the acquire otherwise. With the
     saved value only, a lease nika had sized and then given back (or renewed back to the original size) was released as `user-change` although the
     `manual` was nika's own.
  2. A take refreshes `width0` × `height0` (the restore's resize-back target) only when nika holds no size of its own; a size nika set is not the window's
     own, and the target must stay the original.
  3. `take` and `give` adopt the page's new `cols` and `rows` only after their own look inside the lock (and a take held back by the cap adopts them
     too, so the watch takes with the newest size). Written before the look, the new size made the lease look like a window nika had not set, and the
     move answered a false `blocked / user-change`.
  4. A give refreshes what the lease knows of the terminal from its own in-lock listing, so a terminal that left before the give looked is not reported
     in the answer (`terminal`, not `fitted / terminal`).
- **Two page details settled in the build.** The `terminal:zoom` panel hint no longer ends with the 30-second sentence (it says to click into the window);
  the plain `terminal:` hint keeps it. The answer to the user's own Fit again is announced even when it followed a focus change, because the Fit again
  handler announces nothing for an unchanged chip and a silent answer would leave a screen reader with no word (WCAG 4.1.3).
- **Alternatives rejected.** *F4's refits for every switch* (release + acquire): three or four size changes of the mirrored pane per switch, every pane
  resized more than once, and the terminal shows the unzoomed layout for about 100 ms at the moment the user looks at it. *Two mechanisms* (refits for
  SHRINK and GROW, in place moves for focus): two code paths for one tmux transition. *Release on blur, acquire on focus*: an unzoom and a zoom per
  switch, a flash, more redraws. *Delaying the blur on the server*: 1.3 to 1.5 s; the page's settle gives about 0.3 s and the server stays simple.
  *Focus from the Tauri shell* (`WindowEvent::Focused` over stdio): native and exact, but a Rust change, a protocol change and a mapping from one
  window to the leases; kept as the fallback if WebKit misses events. *No cap*: a flapping focus (focus-follows-mouse, a webview bug) would resize
  without bound. *Cap both directions*: it would hold the size for an unfocused page, against the ruling. *A new chip state* for "filled while a terminal
  shows it": in nika the panel is filled and the same words are true, and a new colour would flip on every switch. *`focus` required* (exactly four
  keys): about 70 test bodies change for nothing, and a missing `focus` already fails safe. *Refresh `layout0` on each move*: bakes tmux's rounded
  rescales into the restore. *The cap per lease*: a refit replaces the lease and would reset the count.
- **Consequences.** (1) WebKit's focus events changed in 2026: if `blur` stops firing the 1 s poll still catches `hasFocus()`; if that is wrong too, nika
  behaves as F4 (false is the default; it never holds the size while unfocused). Only the owner's live check proves macOS, and nothing proves WebKitGTK
  until a Linux user runs it. (2) Every pane of the window redraws once or twice per switch (the owner accepted redraws; the count per agent is new
  information). (3) The terminal shows dots while nika has focus (the ruling), or a cropped view when the terminal is smaller than the panel. (4) A
  native dialog (the attach chooser) blurs nika: the size goes back while it is open and comes again after, two resizes per pick. (5) The final restore's
  `select-layout` applies the acquire's `layout0` to a window that may have another size by then; tmux resizes the window to the layout and then gives it
  the client's size again, from the tmux source and unverified on 3.8 (F4 had the same case after a refit). (6) Focus-follows-mouse window managers: the
  400 ms settle filters a pass of the pointer, the cap bounds the rest. (7) A page that flaps faster than the settles allow can meet the route's 429; the
  poll resends within a second. (8) A hidden nika keeps its lease: a terminal showing a window with several panes keeps the pane zoomed until nika is
  shown, the page lapses (15 s without a request, if the webview stops its timers) or it leaves. (9) The `fitted` chip's translucent edge is 1.72:1
  (light) and 1.96:1 (dark), as before; its text is at least 5.19:1, and the chip is identified by text and icon (WCAG 1.4.11 does not need the edge).
  The F4 tests of SHRINK, GROW and `verify`'s retry were replaced, each listed in the build report; the mutation set gained equivalents for the new
  paths. Rule 12's Fit sentences change in three places (approved 2026-11-16, `rules/project-rules.md`); `docs/security.md` T52 and residual m items
  20 to 24 list the rest.
- **Not built:** a focused page taking over another page's lease by itself (the app tier has one window; Fit here exists for that), a focus signal from
  the Tauri shell (the fallback above), and a cap that survives a restart of nika (the take counts are memory only, never in the lease file).

## Amendment 2026-11-16 (0.5, F10): a steady size, room for Claude's footer, a redraw hold, and faster settles

*F11 (the amendment at the end of this file) adds the rows the mirror hides under its input-box strip to the size asked at a commit, so the room ask is 33 rows or more and the room hint says "more rows";
the first capture of a lease becomes a commit point; the rest of this amendment holds.*

Owner words after the build-9 live check (2026-11-16): "need to do smoother fitting size after focus (also faster). Bug - if nika is focused then can't scroll into nika
app". Owner setup: tmux 3.8, `pane-border-status top`, terminal and nika side by side, Claude in its full-screen view with a 7-line task list. The owner decided
design-F10 §12 Q1 to Q4 on 2026-11-16, all as recommended (marked Q1 to Q4 below). **Page side only** (`public/fit-ui.js`, `public/session.js`, `public/session.css`,
`public/scroll.js` for one copy line) plus the mirror's capture cache (`src/mirror.js`, 250 → 100 ms). **No new route, body key, answer field, lease-file key, tmux
command or argv shape** (`ARGV` and `FILE_KEYS` unchanged). Evidence: the recordings and the pane-size log of the check (design-F10 §1), spike S17 to S17d for Claude's
repaint times, the unit and rig tests (fit-ui 266, session-ui 680 and scroll-ui 103 tests, with 113 of 115 code reversions caught and the two survivors equivalent), and the full
suite. Nothing was run against a live Claude or tmux for this amendment: the owner's live checklist (design-F10 §10) is the proof. F9's settle times (200 and 400 ms,
above) are replaced by Q2 below.

- **Root causes.** (A) The page sent every change of the terminal box as a new panel size, and the box changes because of what the resize itself causes (the mode chip
  reads "unconfirmed", lines and panels come and go): one focus gave five window sizes in four seconds, down to the route's floor of 10 rows. (B) In its full-screen view
  Claude gives the conversation about half of the screen and draws its bottom area (task list, notices, input box, footer) below it without clipping, so a pane of about
  21 rows with a 7-line task list loses its input box and footer (the footer is whole only from about `2 × bottom area + 2` pane rows; this model, H1, is fitted to Claude 2.1.319 and 2.1.325
  captures and is used for one number only, `ROOM_ROWS`). (C) The page judged the screen during nika's own resize and showed it as Claude's state: the mode chip flipped to
  "unconfirmed" and the scroll gate answered `screen-unclear`.
- **A steady size** (Q1's frame; part of the bug fix). The panel is measured from the terminal's border box, with one glyph cell and the window's inner size, only at commit
  points (the start, a window focus, Fit again, a window, font or width change); a change of the box's height alone sends nothing and keeps the text size, the mirror pinned to
  the bottom. One focus change is one resize.
- **Room for Claude's footer** (Q1, adaptive). The page asks for the panel's size first. When, after nika's resize, Claude's input box is not on screen (the hold ran out) and
  the other conditions hold (the screen was plain before, the chip is `fitted`, the panel has fewer than 33 rows, no room step yet), it asks once, at once, for 33 rows
  (`ROOM_ROWS`) with the columns in the panel's proportion and scales the text; the room stays on for the window until Fit again, a new window size or a page load. It is an
  ordinary request of the body `{ cols, rows, open, focus }` inside the route's ranges, from a page that holds the lease: a renew, not a take, so `TAKE_MAX` is not touched by
  it (later focus takes ask the room size straight away and count as any take). The server does not know that the page asked for more rows than it measured.
- **The redraw hold** (Q4). For up to 1.2 s (`HOLD_MS`) after nika's own resize the page keeps drawing the last good frame, reading the capture at once and every 100 ms, until a
  capture at the answered size shows Claude's input box, a prompt, a dialog or no full-screen view. The mode chip, the quick actions, the scroll gate and the Live label do not see
  the half-drawn frames. The page's scroll, Send, draft write, mode switch and quick-action requests wait for the hold; **every server gate is unchanged**: nothing is sent on the
  strength of the held frame. At the timeout the room step is taken if its conditions hold, else the frame is drawn as it is and the page shows the truth.
- **Faster** (Q2): focus settle 400 → 150 ms and blur settle 200 → 150 ms (the cap of 12 takes a minute per window stays), the capture cache 250 → 100 ms, and an immediate capture
  plus 100 ms polls during the hold. Focus to a finished new frame is about 0.55 s (at most about 0.9 s); the first focus of a window that needs room about 1.1–1.4 s.
- **Smoother.** The new frame fades in over 120 ms (`REFIT_MS`) and, when the text grows, zooms in from the old size, anchored bottom-left; none under `prefers-reduced-motion`.
  The fit chip and the Live label change in the same step as the mirror.
- **Rule text** (Q3). Constraint 12's Fit sentence gains one sentence: the page asks for its panel's size or, once, for 33 rows with the columns in the panel's proportion
  (`rules/project-rules.md`, approved 2026-11-16, word for word from design-F10 §7). The scroll and key rules are unchanged.
- **Four details settled in the build (orchestrator rulings, 2026-11-16).** The design text was refined where the code and its tests showed the need:
  1. The answer's pane size reaches the page **before** the chip (the design said after), because the chip has to wait with the frame; the chip can appear up to 1.2 s after the answer.
  2. Send waits inside its own steps (the copy into Claude's input, the draft write, the Enter), never in the shared key delivery, which also carries the passthrough and the arrow
     keys (those do not wait).
  3. End opens its dialog after the hold; the dialog sends its own request, which therefore does not wait, and End's own gate re-reads the screen.
  4. A change of the panel's height alone sends nothing and keeps the text size; the mirror is pinned to the bottom, so the top rows may be hidden while a panel or a taller draft is open.
- **Alternatives rejected.** *Q1 (b), always the panel's size*: 100 % text, but with a tall task list the mode stays unconfirmed and scroll stays refused (today's bug).
  *Q1 (c), never fewer than 33 rows*: about two thirds text and one resize on every focus, also where the footer fits. *Q2 (b), 250 ms and 200 ms settles*: more filtering of flicks,
  but only about 0.15 s faster. *Q4 (b), show Claude's repaint live*: faster first pixels, but the half-drawn frame, the flashing chip and the refusals stay. *Fixed slots or
  overlays for every transient line* (chip width, notes, refusal lines, prompt panels): they touch the header, the notes row and the prompt panels, and still leave scrollbars and
  the textarea; with the commit rule none of them can change the size. *Doing the hold on the server*: the server cannot tell its own redraw from a real dialog without a new
  contract field or a timed exemption in the gates, which would weaken them; the page knows when it asked and what it drew before. *Deciding the room from H1 alone*: the model is fitted to
  two Claude versions; the decision to give room is taken from what the screen shows.
- **Consequences.** (1) H1 is a fitted model: a Claude update that needs more rows than 33 leaves the room step without effect, and the page shows the honest state (unconfirmed, scroll
  refused), with no safety impact. (2) A menu or dialog nika does not know that opens exactly during the hold, on a plain frame, costs one extra resize and smaller text until Fit again or a
  window resize. (3) After a growth (a blur give, a user resize) tmux keeps the old frame plus blank rows and the frame can read as ready before Claude repaints, so a second visible
  change can follow. (4) With a height-only change the top rows of Claude's frame are hidden while a prompt panel or a tall draft is open. (5) A request made during a hold waits up to 1.2 s
  (2.4 s with a room step), only in the first moment after nika's own resize. (6) 150 ms filters fewer flicks: on a focus-follows-mouse desktop a pass of the pointer may take the size more
  often, and the cap of 12 takes a minute per window still bounds it. (7) In the owner's setup the room size means about 8 px text for the orchestrator pane. (8) Measuring the border box
  puts up to two columns under a classic vertical scrollbar, only while the mirror overflows. (9) More tmux load: at most one `capture-pane` and one `display-message` per pane per
  100 ms instead of per 250 ms, one capture in flight per pane as before; the 100 ms page polls run only during a hold.
- **Not built:** fixed slots for every transient line, a server-side hold, a setting for the room or the hold, and a change of the scroll and key rules.

## Amendment 2026-11-16 (0.5, F11): more of Claude's conversation under the input-box strip

Owner words after the build-10 live check (2026-11-16): about 4 to 5 empty rows of panel under the dashed strip "Input box · mirrored in the message box below", "use this empty space also". The
owner decided **"More conversation"**: when the mirror hides Claude's input box and footer, nika asks tmux for those rows too, in the same single resize at each commit point; the text size
stays as F10 sets it; the box and the footer stay hidden (they stay on Claude's screen, since nika reads the draft and the mode from them). The owner also decided design-F11 §12 Q1 to Q3
on 2026-11-16, all as recommended (marked Q1 to Q3 below). **Page side only** (`public/fit-ui.js`, `public/session.js`; `public/draft-sync.js`, `public/mirror-render.js`, `public/session.css`
and everything under `src/` are unchanged). **No new route, body key, answer field, lease-file key, tmux command or argv shape** (`ARGV` and `FILE_KEYS` unchanged), no change of the route's
ranges or of any gate. Evidence: design-F11, the unit and rig tests (fit-ui 304 tests; fit-ui and session-ui together 1009; 48 of 48 code reversions caught) and the full suite. Nothing was run against a
live Claude or tmux for this amendment: the owner's live checklist (design-F11 §10) is the proof.

- **Root cause.** The mirror draws only the rows above Claude's input box and a one-row strip in its place, but the fit asked for and scaled to all of the pane's rows, so the rows under the cut
  (the box and the footer, about 6) stayed empty panel: 5.7 rows in a 145 × 22 panel, 4.2 and 3.4 scaled rows where the room or the terminal's size is in force.
- **The size asked** (`hiddenRows`, `fillSize`). At a commit the page counts the hidden rows K in the capture it drew (the last row with ink + 1 − the cut row; none for a cut that is not a row
  1 to rows − 1, and none when more than `HIDE_MAX` 24 would be hidden) and asks `rows = max(F10's rows, the rows that fit above the strip at F10's text scale + K + d)`, at most 200, with F10's
  columns. 145 × 27 instead of 145 × 22, and 210 × 37 instead of 210 × 33 with the room (the example panel). Still one request per commit, the same body, the same 12 takes a minute.
- **When K is read.** Only at the commit points (the start, a focus, Fit again, a change of the window, the width or the cell), never per capture and never on a change of K or of the box's height
  alone, so there is no resize cascade. **The first capture of a lease is a commit point** (orchestrator ruling 2026-11-16, accepted with the T1 deviations): the start request used to carry the
  size measured at boot, when no frame was drawn; it now carries the K of the first frame, still as one request.
- **The text scale counts the rows drawn** (`drawnScale`): the rows above the cut and the strip fill the panel's height, the columns its width, never above 1 and never below 0.4. At nika's own sizes the
  width decides and the text is F10's. **Q1:** the same rule while the terminal owns the size (nika cannot add rows there): 0.53 instead of 0.49 for a 171 × 45 pane, nothing empty under the strip, no resize.
  It is worked out at a commit and when an applied capture changes the pane's size, and held in between.
- **Between commits** nothing is asked and the text does not change: a cut that turns off (Type into pane, a draft nika cannot read, a prompt or a dialog) overflows about 4 rows at the top (the mirror stays
  pinned to the bottom), a cut that moves up leaves empty rows, one that moves down overflows; the next commit corrects it.
- **With F10.** `frameReady`, `remeasure`, the redraw hold, the 150 ms settles, the 12 takes a minute, `ROOM_ROWS` and the chip's states, words, colours and icons are unchanged. The room step asks the room's fill
  size and is taken only when it adds rows (`gain`: the room ask has more rows than the request last sent; else the step would send nothing and wait out another hold). The border row d is learned only from
  nika's own answers (the asked columns came back) and kept through a terminal's or a zoomed window's size, because F11 adds d to the rows. **Q3:** the room hint reads "Claude's input box and footer did not
  fit this panel's rows, so nika gave the pane more rows and scaled the text. Fit again tries full-size text." ("33 rows" is no longer exact).
- **Rule text** (Q2). Constraint 12's Fit sentence gains one sentence: while the mirror hides Claude's input box and the footer under its one-row strip, the same request asks for the rows that fill the panel down to
  the strip at that text size plus the hidden rows, never fewer rows than without them, counted only when it asks (`rules/project-rules.md`, approved 2026-11-16, word for word from design-F11 §7).
- **Alternatives not picked.** The owner chose conversation over *showing Claude's footer under the strip* and over *giving the space to the message box*. Q1 (b), keeping F10's all-rows scale while the terminal owns the size:
  smaller text and about 3 empty rows there. Q2 (b), keeping the rule as it was: the rule would then describe fewer rows than the page asks. Q3 (b), keeping the build-10 hint words. Considered in the design and
  rejected: `max(33, panel + K)` rows (at a text scale below 1 the panel holds more rows than its cell count, so about 8 scaled rows would stay empty with the room on); making the Type into pane toggle or a change
  of the cut a commit point (a resize with a redraw hold on a user action that needs a steady screen, and a cut that follows nika's own resize would start the cascade F10 removed); counting blank rows under
  Claude's footer in K (the next commit would count the rows just added, growing the pane to 200 rows).
- **Consequences.** (1) K is read from the frame drawn at the commit, which at a focus is the terminal's (about 64 columns), and applied at about 200 columns: a draft or footer line that wraps differently makes Claude's
  box 1 or 2 rows taller or shorter than committed. The text then adapts at the pane-size change (smaller when fewer rows are hidden than counted, empty rows when more); it repeats at each focus while the draft stays, and an
  empty draft has no such drift. (2) While the strip is off (Type into pane on, a prompt, a dialog) the top 4 or so rows of conversation sit above the panel's edge until the next commit; with classic scrollbars a vertical bar
  covers up to 2 columns, more often than in F10. (3) Typing a multi-line message in the message box leaves one empty row per extra line until Send. (4) Before nika's first own answer d is 0, so the first ask of a window can be one row short
  until the next commit. (5) For a split tmux window the larger ask counts as the panel in the squeeze rule, as F10's room did: a window that was `zoomed` (the panel smaller than the window) can now be zoomed and resized (`fitted`); the other
  panes get the extra rows too, hidden by the zoom, and nothing shrinks. (6) The strip's height is read from layout offsets in whole pixels (1 or 2 px of error is absorbed by the rounding down); a strip that is not a positive height up to 4 cells
  counts as 2 cells, which underfills and never overfills. (7) The first capture of a lease measures the panel once (a layout read per lease start, not per capture). The server cannot tell any of these asks from a panel of that size, and every
  rule of the lease, the squeeze rule, the cap and the rate applies to them (`docs/security.md` T52, item 25).
- **Not built:** a commit when the Type into pane toggle or the box's height changes, a setting for the extra rows, and a change of the server, the route or its gates.
- **F12 (owner decision 2026-11-16, after the build-11 live check): the room step also covers Claude's mode line.** Build 11 passed the owner's check with one gap: with nika focused and a 145 × 28 pane, Claude's bottom area
  (a 7-line task list, a notice, the input box and a 3-line footer) was one row too tall, and Claude let the footer's last line (the mode) run off the screen. The input box stayed readable, so the redraw hold ended as ready
  (`hasBox(draft)`) and the room step, which needs no readable box, never ran; the capture answered `modeConfirmed: false`, the chip read "Auto unconfirmed" and a mode switch from nika would have been refused (scroll and Send
  worked: they need only the box; at 64 × 45, the terminal's size, all three footer lines show). **Decision:** if Claude's mode line was readable before nika's resize and is gone after the redraw, nika takes the same one-time room
  step (33 rows or more, F11's room fill size, the text scaled). The page records `modeBefore` at each start of the hold (the drawn frame's capture had `modeConfirmed` `true` and a mode other than `unknown`, besides the readable
  box `plainBefore` needs; a restart, including the room step's, keeps the first one). `frameReady` then counts a readable box as finished only with `modeConfirmed` `true`, and `roomStep` also takes a readable box whose
  `modeConfirmed` is not `true`; the other ready exits (a prompt, a dialog, no full-screen view, no readable box before) and every other room condition (`gain`, room not on, fewer than 33 rows, `fitted`, the answered size, the
  full-screen view, no prompt, no dialog) are as before. **No rule change:** constraint 12 already says "when Claude's input box and footer were not on screen after nika's last resize". **Cost:** a frame whose footer never
  confirms after nika's resize keeps the old frame for the whole 1.2 s (the box alone used to end the hold at once) and then takes the room step once; if the mode line is still off at 33 rows or more, the second hold waits
  another 1.2 s and the frame is drawn as it is ("unconfirmed", as before), because there is one room step per window until Fit again or a window resize. A mode line that is gone for another reason (a notice that replaces the
  footer, say) costs the same 1.2 s and one room step. Page side only (`public/fit-ui.js`, `public/session.js`): no new route, body key, answer field, lease-file key, tmux command or argv shape, no change of any gate. Evidence: the
  unit and rig tests (fit-ui 332 tests; fit-ui and session-ui together 1043; 19 of 19 code reversions caught) and the full suite. Nothing was run against a live Claude or tmux: the owner's live check is the proof.

## Amendment 2026-11-16 (0.5, F15): while the session window has focus, any pane may be squeezed, and the way back puts the layout back

Owner decision (2026-11-16, "resize while zoomed", asked twice and confirmed): a window with several panes is sized to the panel while the session
window has focus even when the panel is smaller than the window, **whatever the other panes run**, and on blur nika re-applies the layout it read right
before the resize and zooms the mirrored pane again. This replaces the design's `nikaOnly` rule (squeeze only when every other pane is one of nika's
agents) and its `other-panes` reason. **Server side** (`src/fit.js`) **and the chip's two strings** (`public/fit-ui.js`); **no new route, body key, answer
field, reason, lease-file key, tmux command, listing field or argv shape** (`ARGV` and `FILE_KEYS` unchanged). Evidence: spike S-F15 (tmux 3.8 only, no
Claude), `test/fit.test.js` (a describe block of its own, checked by reverting the code piece by piece in a scratch copy), `linux-verify` group `F15a` (CI), and the full suite.

- **The plan.** `plan(…, yields, focus)` is `fitted` to the panel when the window has one pane, when the panel is at least as wide and as tall as the
  window, **or when the page has focus**; otherwise `zoomed / panel-smaller` at the window's own size. There is no `other-panes` reason any more (the
  page shows a plain "off" if a server ever sent it with `blocked`). A user's own zoom of another pane still blocks (`blocked / user-zoom`), a
  terminal that shows the window still ends `terminal` without focus, and everything else of F4 and F9 stands: the tag, the cap of 12 takes a minute per
  window, the rate, the release's R5 with `layout0`, and a window tmux cannot shrink (`blocked / changed`).
- **The take keeps the layout.** When the target is below the window's own size in either dimension (`squeezes`), the take reads `#{window_layout}`
  inside the pane lock, from the same fresh listing that decides it, strips the focus markers and validates it exactly as it does `layout0` (`turnBack`),
  and keeps it in **memory** as `layoutT` (set in `acquire`, `take` and `renew`; never in the lease file; absent from `FILE_KEYS`; `null` after a parse). Then
  `resize-window`. A layout that cannot be read or does not validate (a `#` in it, say) means nothing is squeezed: the pane stays zoomed at the window's
  size with scaled text (`zoomed / panel-smaller`) and the watch tries again at its next tick while the page has focus. A crash while squeezed is
  recovered from `layout0`, as before, at the next start.
- **The give puts it back.** A give (blur; a terminal that comes; the page's `DELETE` is the release below) does, in this order, R3 `resize-window` back
  to the window's own size, R4 the `window-size` option back, `select-layout -t @W -- <layoutT>` (tmux unzooms the window), one guard listing, and
  `resize-pane -Z -t %P` **only if** the pane is still in that window and shows unzoomed (so a `select-layout` that did not unzoom is never toggled off),
  then one read-back listing: zoom flag 1, the window's own size, the stripped layout equal to `layoutT`, the pane still in the window. Any mismatch
  releases with `blocked / changed`, once, with no retry loop. `layoutT` is cleared after a give. The give also runs when no terminal shows the window,
  judged before the `viewed` rule (the state is then `zoomed / panel-smaller`; with a terminal it is `terminal`), and is never rate-limited.
- **What the spike found (S-F15, tmux 3.8).** The give sequence restored the stripped layout, the zoom, the active pane, every hidden pane's size, the window
  size and the unset `window-size` option exactly in **870 of 870 cycles** (29 cases × 30; 4 and 6 panes, side by side and stacked, also when the squeeze
  pushed hidden panes to 1 column or 1 row), and the same four commands sent as one tmux invocation passed 480 of 480. Client kind made no difference: no
  client, a control-mode client (sized and unsized) and a real tty client; the only client effect is that `set-option -wu window-size` snaps the window to a
  sized client's size at once. A plain round trip (`resize-window` there and back) without `select-layout` left a different layout in 16 of 29 cases, and
  the drift does not grow (one distinct layout from the first round trip on). `select-layout` never failed (rc 0, no output) on a window that is not exactly
  the layout's size: with `window-size` manual it scales the layout to the window, with the option unset and no sized client it resizes the window to the
  layout's size; the give satisfies the second case because R3 and R4 run first. The smallest panel tmux reaches with 6 panes is 11 columns × 1 row side by
  side and 1 × 11 stacked (2n − 1 along the split axis, 1 on the other); below that `resize-window` exits 0, prints nothing and leaves the window at the
  minimum, so the size is read back (`verify`) and a window larger than the panel ends `blocked / changed`. Not measured: the time every pane is visible
  between `select-layout` and `resize-pane -Z`; tmux 3.2 (the floor); mixed grids; a client of another size at give time.
- **Alternatives rejected.** *Squeeze only when every other pane is nika's* (`nikaOnly`, the design): the owner wants the window filled whatever runs beside.
  *Give with `resize-window` and `window-size` only*: S-F15 shows the layout comes back wrong in more than half of the cases. *Send the give as one tmux
  invocation*: it passed, but each step is then not read back; the separate calls stay (the guard listing sits between `select-layout` and `-Z`).
  *Keep the layout on disk*: a new file key and a second source for a value that must come from tmux; a crash keeps using `layout0`.
- **Consequences** (all accepted by the owner except where noted; `docs/security.md` T52 and residual m): (1) A shell or an editor in a hidden pane sees a
  narrow window while the page has focus and may keep lines wrapped at that width. (2) On blur the terminal briefly shows every pane (between
  `select-layout` and the zoom). (3) Up to 12 takes a minute per window, and each take and each give sends SIGWINCH to every pane of the window. (4) tmux
  hooks the user set on `window-layout-changed`, `window-resized` or `pane-focus-in` run on every take and give. (5) A window nika had **grown** and a
  later renew squeezes has no own-size layout to read (tmux scaled it), so it keeps no `layoutT`: its give is the plain one, and the release's R5 restores
  `layout0`; the hidden panes then get their layout back at the release, not at the blur. (6) A user who changes the layout, size or zoom while the window is
  squeezed is a user change or `changed`: the lease is released and R5 is skipped when the user changed the layout. (7) A window tmux cannot shrink to the
  panel ends `blocked / changed` at once. (8) `F15a` in `scripts/linux-verify.sh` assumes `#{window_layout}` under zoom reports the saved layout and
  `select-layout` restores it exactly; it passes only where CI says so, and a different tmux makes the read-back release with `changed` instead of leaving a
  wrong layout.
- **Rule text.** Constraint 12's Fit sentence changes in two places (approved 2026-11-16, word for word from design-F13-addendum, "F15 changes" item 7): it
  resizes a window with several panes when the panel is at least as wide and as tall, and, while the session window has focus, also to a smaller panel; the
  restore's `select-layout` and the zoom again are named. Constraint 3's Fit targets are changed by the final review's text (a file gives them only at the
  next start, and only while tmux's listing shows the tag equal to the file's nonce); constraint 4 is unchanged.
- **Not built:** a squeeze that waits for the other panes to be idle, a setting to turn the squeeze off, a layout kept in the lease file, a flash-free give.

## Amendment 2026-11-17 (0.5, F16): a cut-off question gets more rows while it is open

**Context.** Owner report (2026-11-16): the fit sizes the pane to the panel (the owner's case 145 × 21), and Claude draws a question dialog taller than the pane by clipping its **top** (rule, tab strip, question, first option).
`src/dialog.js` finds no strip and answers `unreadable` / `cut`, so the page showed "Reading Claude's question…" for 2 s and then the banner "<name> needs you … Answer it in the terminal". 27 rows hold that dialog; 21 do not. The owner
decided **"Grow the pane"** (2026-11-16): while a cut-off question is open, nika gives Claude more rows than the panel shows, reads the form, then sizes back. On 2026-11-17 the owner approved the rule-12 sentence (Q1) and chose questions
only, never plan approvals (Q2). **Page side, plus one reason split in `src/dialog.js` and the reason set of `public/dialog-form.js`** (the split is an amendment of ADR 0015). **No new route, body key, answer field, lease-file key, tmux command or
argv shape** (`ARGV` and `FILE_KEYS` unchanged), no change of the route's ranges, the rate limit or any gate. Evidence: design-F16, the unit and rig tests (81 new, the full suite 6807 tests on the build tree, 53 of 53 code reversions caught)
and the build report. Nothing was run against a live Claude or tmux for this amendment: the live check (design-F16 §10) is the proof.

**Decision.**
- **When.** Only for `kind: "ask"`, `state: "unreadable"`, `reason: "cut"` (a question step or the review) while the chip's state is exactly `fitted` (also with a terminal on the window, F4). A plan approval is not grown for (a plan text is often
  longer than any cap, so most grows would end in a give-up after 3 or 4 resizes). A text ending in `…` is `clipped` (below) and never grows.
- **How many rows.** `growNext(rows) = min(120, max(rows + 12, 2 × rows))`, counted from the size the fit asks without the grow. The rows a clipped dialog needs cannot be read (the clipped part is gone), so the page doubles: from the
  owner's 21 rows one step (42 ≥ 27), from 10 rows four steps (22, 44, 88, 120). The cap 120 is the reader's reach (`SPAN_MAX` 100 rows strip-to-footer, a rule, the task block under the footer, the border row); more rows can never make a
  dialog readable.
- **How it asks.** The planner's `size(cols, rows, { now: true })`, the same `PUT …/fit` body `{ cols, rows, open, focus }`; a renew from a page that holds the lease, not a take, so `TAKE_MAX` does not count it. A question that is still
  `cut` 200 ms after it was first seen (`GROW_CONFIRM_MS`) steps; the next step waits for the drawn frame to have the asked row count and then 800 ms (`GROW_SETTLE_MS`; Claude repaints 340–680 ms after a resize); a step whose size never shows
  in the frame in 6 s while `fitted` (`GROW_WAIT_MS`) or a question still `cut` at 120 rows is given up: the page asks the base size at once and does not grow again for this question until a commit changes the base size (`growRebase`).
- **When it sizes back.** When no question dialog has been on screen for 1 s (`GROW_CLOSE_MS`), not when the form is read: `POST …/dialog` takes a fresh capture and needs the question whole, so sizing back while it is open would clip
  it again. A gap between two tabs shorter than 1 s keeps the size.
- **The redraw hold.** A grow step's hold (`cutBefore`) ends on the first capture at the asked size whose question is no longer `cut`, or after 1.2 s, so Claude's half-drawn frame is never shown (the F10 rule).
- **The text keeps its size.** The scale is pinned to the rows without the grow (the base rows less the border row and the hidden rows of the last commit, `scaleRows`), so the pane is taller than the panel; the mirror overflows natively and stays
  pinned to the bottom (the existing "Paused while you scroll" covers the rest).
- **Not `fitted`.** In `terminal`, `zoomed`, `blocked` and `other` the page takes no step and the clocks wait; the grown rows stay in what it asks, so a commit or a take that follows already carries them.
- **The dialog form** stays on "Reading Claude's question…" while a step runs (`growing`), also past 2 s; the chip keeps its states, words, colours and icons, and its panel gains one fixed line while grown. Nothing is announced.
- **Rule text** (Q1, approved 2026-11-17, word for word from design-F16 §12.6). Constraint 12's Fit paragraph gains one sentence after the F11 one (`rules/project-rules.md`).

**Alternatives** (the owner's other options of 2026-11-16, as listed to them, and plans). *Fit the dialog's needed rows exactly:* not knowable, the clipped part is gone. *Scale the text to show the whole grown pane:* the text
shrinks and grows back around every tall question. *Grow until the form is read, then size back:* the answer route needs the readable screen, so the question would be cut off again before it is answered. *Grow for plans too* (Q2): rejected,
see above.

**Consequences.** (1) At most four steps and one size-back per question (a new question right after another costs a size-back and a new grow, two fades of the mirror). (2) The pane may be up to twice the needed rows: a capture of 120 × 400 cells at 4 Hz;
its real cost is not measured. (3) While this window has focus and a terminal also shows the window (`fitted:terminal`, the dots of F4), the terminal shows only part of a window taller than itself until the question closes or the user clicks
into the terminal (F9 then gives the terminal its size back); how tmux pans it is not verified. (4) A question the page gave up on, a plan, a `clipped`, `wide`, `numbers`, `tab`, `layout` or `survey` dialog keeps the banner, as before.
(5) The server cannot tell any of these asks from a panel of that size, and every rule of the lease, the squeeze rule, the cap and the rate applies to them (`docs/security.md` T52, item 25).
- **Not built:** growing for a plan approval, a setting for the grow, a size-back as soon as the form is read, text scaled to the grown pane, a server change.

## Amendment 2026-11-17 (0.5, FX2): a fresh commit when a panel that a commit was measured under closes

**Context.** The live check LC17 (build 17, K2) ran a focus round trip while a question form was open. The form (like the prompt panel's buttons, the feedback survey and the attention note) takes height from
the terminal box, and a window `focus` is a commit point (F9, F10), so the commit measured a box about 10 rows tall where the resting panel is 14 to 16. F16's size back after the question closed goes to the
commit's base, so the window ended at 10 to 12 rows, 2 to 6 below the panel, until the next commit (a resize of the panel). The same run without a focus event ended at the panel's size. F10 says the form must never
cause a commit; the focus commit is not caused by the form, it only measures with the form shown. **Page side only. No new route, body key, answer field, lease-file key, tmux command or argv shape** (`ARGV` and
`FILE_KEYS` unchanged), and no change of the route's ranges, the rate limit or any gate.

**Decision.**
- **A commit remembers.** `fitCommit` sets `FIT.short` from `boxShortened()`: true when the prompt panel (`prompt-btns`), the question form (`dialog-form`), the survey (`survey-panel`) or the attention note
  (`attn-note`) is not hidden. Every commit sets it, so a commit with none of them shown clears it.
- **When the panel closes.** `fitPanelClosed()` runs at the top of `growTick`, so after every drawn capture and every 304, before the grow looks at the base. While the flag is false or any of the four is still shown
  it does nothing. When none is shown it clears the flag, and then takes **one** `fitCommit()` only if there is a planner, the chip's state is neither `null` nor `blocked`, and the window has focus (`fitFocused()`).
  So the base is the panel's size again before F16 asks the size back, and the way back is counted from it.
- **Blurred, hidden, Fit off or no chip.** The flag ends and no commit is taken. A window that was blurred gets its commit from the later `focus` event, as before, and measures the whole panel.
- **A height change alone is still no commit** (F10): the new look needs an earlier commit that was measured under a panel, and a test asserts that the `ResizeObserver` look commits nothing. No new timer, listener or request.
  The extra commit is the ordinary `fitCommit`; a size that did not change is not asked for.

**Alternatives.** *A commit at the instant a panel hides:* it would need a hook in each of the four panels and new stubs in every page harness; `growTick` already runs after every capture and every 304, so the cost is
up to one mirror poll of delay. *A commit on every height change:* the F10 cascade (one focus gave five window sizes in four seconds); rejected there and unchanged. *Counting only the question form:* the prompt panel,
the survey and the attention note take height from the box in the same way, so all four are counted.

**Consequences.** (1) Up to one mirror poll passes between a panel hiding and the commit. (2) Other causes of a shorter box at a commit (a grown composer, a problem line, a suggestion line, the chip's panel) are not
covered. (3) The chips `fitted`, `zoomed`, `terminal` and `other` commit; `blocked` ("Fit · off") and an absent chip do not. (4) The page's rig tests cover each of the four panels, the blurred and Fit-off cases and the
source shape (the look only in `growTick`, one declaration and one call); the live repeat of LC17 K2 passed in LC18 (2026-11-17) for a window with no terminal on it: it ended at the panel's size, not 10 or 12 rows. A terminal that attached after the question had opened ended short again (LC18 R4b); that is the next amendment (FX3).
`docs/design/spec.md` §9.13 ("The panel's size after a commit taken under a panel") and `docs/contracts/api-app.md` ("A steady size", "A cut-off question") carry the details.

## Amendment 2026-11-17 (0.5, FX3): a look at the panel when the grow sizes back

The live check LC18 (R4b) attached a real tmux client after a question had opened, blurred and focused the window, and answered: the window ended at 10 rows with a panel of 12, twice, and the next grow stepped from 10 (22, then 44) instead of from 12 (24, then 48). A commit had measured a box as short as the one with the question form shown, and F16's way back goes to `FIT.base` whatever commit wrote it; FX2's four panels do not explain this one, and about 6000 randomised orders in the page's rig (which has no layout) all end at the panel, so the element was not found. **Page side only; no new route, body key, answer field, lease-file key, tmux command, argv shape or gate.** `growTick` now calls `fitBaseFresh()` when, and only when, the grow asks the base size back: it returns at once without a base, a planner, a chip or with `blocked`, without window focus, or while one of the four panels of `boxShortened()` is shown; otherwise it measures the panel (`fitProbe`, the same `fillSize` as a commit) and, when the columns equal the base's and the rows are strictly more, replaces `FIT.base` and the held frame, so the way back is counted from the panel's size. A base as tall as the measurement or taller stays (a short box at that moment is no new measurement, F10). **The look is no commit point** (nothing is sent, no timer, listener or markup; the way back is the one request, as before; a height change alone is still no commit), it only ever grows the base, and it costs one extra layout read per way back. Consequences: the look can adopt a box that is taller than at the commit (a line went away), so the text is a little smaller until the next commit corrects it; a short focus commit with no grow still asks the short size until the next commit (the F9 and F10 design, not touched). Rejected: a commit at the way back (a second resize for one request), and a console probe to name the element, which is a separate small task. `docs/design/spec.md` §9.13 ("A look at the panel when the grow sizes back") and `docs/contracts/api-app.md` ("A steady size", "A cut-off question") carry the details. Checked live (LC19, 2026-11-17): 5 of 5 late-attach runs ended at the panel's size (13 or 14 rows).

## Amendment 2026-11-17 (0.5.2, FX4): the box without the panel

**Context.** Two live findings with the 0.5.1 build. The owner's report (2026-11-17): with the question form or the feedback survey up, an empty band stood between the terminal view and nika's panel (case 2, a review; case 1, a three-question dialog whose step 3 left about 9 rows of empty space), and LC22 finding 4: with a plan approval up, narrowing the window and widening it again left the pane at 106 x 24 until the window was very tall. One rule was missing, not three. While a panel is up the terminal box is shorter than the resting layout, and a commit point (a window `focus`, a change of the window's width) measured that box. FX2 repaired the size after the panel closed, but a plan that does not fit in a short pane stays unreadable, so its form (and FX2's trigger, the panel closing) never closed: a deadlock. The box (`flex: 1`) also took every pixel the composer left, so the rows the mirror did not fill showed as empty space, and a form whose height changed between steps (step 1's form is taller than step 3's by about 9 rows) changed the box's height with no commit to follow it (F10; this cause of case 1 is inferred from the numbers, not reproduced, and LC23 item 2 checks it; the new layout removes the band whatever its cause, because the box no longer has spare height under a panel). **Page side only. No new route, body key, answer field, lease-file key, tmux command, argv shape or gate; the server's ranges, rate limit and every rule of the lease are unchanged.**

**Decision.**
- **A frame without the panel.** `panelFrame(next, held)` (`public/fit-ui.js`, pure) is used at one place, `fitCommit`, whenever a panel is up and a frame is held (`#sess-term[data-lay]` is set). It builds the frame as it would be without the panel: the width, the cell size and the window's inner size are the ones measured now (the hug does not change the width); the height is the held frame's height moved by the change of the window's inner height (`next.ih - held.ih`, never below 0); columns and rows are `panelSize` of that width and height. A probe that gives no usable size leaves the held frame as it is. So a panel never lowers the rows, narrowing then widening the window keeps them, and a taller window still grows the pane while the panel is up. A shorter window lowers the rows by the window's own change only (owner decision Q4, 2026-11-17, option A), never by the panel.
- **Only a frame measured with no panel counts.** `fitMeasure` records `FIT.free` (no panel was shown when it measured); `data-lay` needs it. With no such frame yet (the boot probe failed and the first good probe came under a panel) the layout stays today's, FX2 measures as before, and the first commit after the panel closes gives a free frame. Without the flag a short FX2 frame would become the base of every later commit under the panel, which is finding 4 again.
- **The hidden rows stay.** Under a panel the commit keeps `FIT.hide` and `FIT.strip` of the last commit, in the ask and in the text scale: the dialog only covers Claude's input box for a while, and counting 0 there would drop those rows from the ask and shrink the text until the panel closes.
- **The layout (CSS, `#sess-term[data-lay]`).** `crop` (a question, review or survey crop under a shown panel): the terminal box hugs the rows above the crop and the strip and may shrink to the strip alone, and the form's `min(45vh, 420px)` cap is lifted; `panel` (the prompt buttons, a plan form, a form with no crop, a survey without a crop, the attention note): the box hugs the mirror's rows, 120 px at least, and the form keeps its cap. The attribute is set and removed in the same task that shows or hides the panel (`renderLayout`, `layoutOf` in `public/crop.js`). Spec §9.19 has the table.
- **One observer more.** The page's one `ResizeObserver(fitResize)` also observes `#sess-term`: under a panel `#term` hugs its rows, so only the column follows the window's height. `fitResize` is unchanged and still commits only through `remeasure` (the window's inner size, a cell side, or a box width of one cell or more), so a height change alone from a banner or a chip is still no commit (F10).
- **FX2 stays.** The commit under a panel sets `FIT.short`, so `fitPanelClosed` takes one fresh commit after the panel closes (the same size in the normal case, which the planner does not ask for). What FX2 still covers alone is the path with no free frame yet. The two FX2 tests that expected a short frame were rewritten for the new rule (the frame under a panel is the held one, moved by the window), and a new test proves that FX2 works as before when there is no free frame.
- **No loop.** The drawn scale uses `FIT.frame`, never the hugged box; the observer sees only height-only changes under a panel (`remeasure` is false, so the mirror pins to the bottom); a width change is a commit, and that commit builds the frame without the panel again.

**Alternatives.** *Measure the box as it is and correct after the panel closes (FX2 alone):* it does nothing for a panel that cannot close because the pane is too small, and the pane keeps the short size meanwhile. *Hold the rows for as long as a panel is up (Q4, option B):* safer for a tall dialog, but the mirror overflows a window that really got smaller. *A window `resize` listener for the height:* a second commit trigger; the column observer reaches the same place with `remeasure` as the only decision. *Lay the panel over the terminal box:* the rows under the panel would be unreadable; the panel takes its place in the flow instead.

**Consequences.** (1) A shorter window lowers the rows by its own change only; a taller one grows them. (2) A banner that appears under a panel is a height-only change and is ignored, as F10 already does for every other panel. (3) The close commit reads the hidden rows (K) from the frame drawn at that moment, as FX2 does: if Claude has not drawn its input box yet, K is 0 and the ask drops by K until the next commit point. (4) The path with no free frame can still show finding 4 until the panel closes once. (5) The layout is CSS on a flex column that the page's rig cannot lay out: the Node tests prove the attribute, the guard and the sizes asked; the look is checked live (LC23, not yet run). (6) Rule text: constraint 12's Fit paragraph (`rules/project-rules.md`) gains the clause that the size asked under a panel is the one the panel had without it, written by the orchestrator and approved by the owner with the PR. `docs/design/spec.md` §9.13 ("The box without the panel") and §9.19 and `docs/contracts/api-app.md` ("A steady size") carry the details.

## Amendment 2026-11-19 (0.5.4, P2): Fit modes (auto, fill, terminal, off)

**Context.** Fit had one behaviour, and its terminal-aware parts (F4, F9, F15) decided by themselves when the window you click into gets the size. People want to choose: some want the panel always filled, some never want nika to resize a tmux window, some want nika to leave tmux alone. One global setting with four values answers all three. **The server enforces it and the page follows. No new tmux command, argv shape, lease-file key, route or request key.** The mode only picks among behaviours rule 12 and this ADR already allow.

**Decision.**
- **The setting.** `fit: { mode }` in nika's `config.json`: `auto` (the default; an absent key means `auto`), `fill`, `terminal` or `off` (`FIT_MODES` in `src/ids.js`, checked by the store). An unknown value loads as `auto` with the warning `fit.mode invalid, default used`; an unknown inner key is dropped with a warning; a settings `PUT` with a bad value is 400 `invalid` and changes nothing. It is global (every project), set under Settings → Session window, and `GET` and `PUT /api/app/settings` carry it. A downgrade to a build without it drops the key as unknown, which is `auto`, the safe side. The browser tier reads nothing new.
- **The mode never comes from a request.** The fit body keeps its four keys (`cols`, `rows`, `open`, `focus`) and `checkFitBody` still refuses any other. The app tier calls `fit.setMode` at start (before `recover()`), after a settings save has succeeded, and on a fit `PUT` with `open: true` (it re-reads `config.json` first, so a hand edit is seen when a session window opens). The mode is memory only: it is never written to a lease file.
- **What each mode does.** The controller overrides two inputs, nothing else: `focusOf(lease)` (the page's `focus` in `auto`, always true in `fill`, always false in `terminal`) and `shown(row)` (a client is attached in `auto` and `fill`; every window counts as shown in `terminal`). Every place that read a lease's focus or a window's client count reads these two.
  - **`auto`:** all of this ADR, unchanged.
  - **`fill`:** every request counts as focused. The window is sized to the panel whenever the page holds it: a terminal's presence, a blur and F15's squeeze no longer stop it, and the terminal shows dots around the pane while a session window is open. A focus take after something else moved the size still counts toward the 12-per-minute cap, which `fill` rarely reaches because it has no focus switches.
  - **`terminal`:** every window counts as one a terminal shows, and no request as focused. nika zooms the pane of a window that has several panes and nobody zoomed (the F4 terminal form), never runs `resize-window`, and gives back in place, within about 1 s, a size it set before the switch. The lease, the tag and the file stay, because nika must know what to give back. The page scales the text.
  - **`off`:** no lease. Every fit request is answered `{ fit: { state: 'off', reason: null, mode: 'off' } }` with no tmux call. A lease this pane still holds is released like a `DELETE`'s, with no mark and no note, so leaving `off` never leaves a window blocked. The start-up `recover()` still runs in every mode, because it only gives back what an earlier run left.
- **A change while leases are held.** Any mode to `off`: every lease is released at once (queued), and in `off` the 1 s watch only releases, so a lease that outlives the switch is never run as `auto` (review M1). `auto` or `fill` to `terminal`: memory only; the watch sees `focusOf` false and `shown` true and gives back a resized window (GIVE) or keeps the terminal form for an unresized one. To `fill`: the watch sees focus and takes (TAKE). `fill` or `terminal` to `auto`: the page's own focus decides again. `off` to anything: nothing is held; the next request of a page (within 5 s) acquires.
- **The mode is read right before each tmux change.** A lock wait can last up to 5 s and a switch can come in it. The acquire, the refit, the give and a resizing renew read the mode in the same step as the tmux call, with no `await` between them (review M2): a switch to `off` never tags, zooms or resizes afterwards, a switch to `terminal` never resizes, and a fit cut short by `off` puts the window back exactly, with no mark.
- **Every fit answer names the mode.** `chipView` reads it; a missing or unknown value is `auto`, so an older server and a newer page work together. Three new chip looks, each with its own colour token, icon and words: `fill` (`--fit-fill`, `i-fit-pin`, "Fit · always fills"), `term-set` (`--fit-set`, `i-term-pin`, "Fit · terminal's size (set)") and `off-set` (`--fit-off`, `i-fit-off`, "Fit · off in Settings"), plus one copy variant, `zoomed:fill`, on today's zoomed look. The pin dot marks "set in Settings". `off-set` is solid on a grey ground and `blocked` stays dashed, so the two never look alike. The popover of a set look says "Change it in nika's Settings, under Session window." and has no button, because nothing on the page can change the mode. Auto's looks are unchanged.
- **The page follows within one heartbeat.** It keeps its planner and its 5 s beat in every mode; `off` costs a request and no tmux call. A new chip key redraws the chip. Room (F10), hidden rows (F11) and grow (F16) run only in `auto` and `fill`; FX2 and FX3 are skipped while the state is `off` or the mode is `terminal`; a grow that is already running ends at the switch and does not send its way back (SF-1). The text scale (at most 1×, at least 0.4×) holds in every mode, `off` included (the owner's decision of 2026-11-18, P2 Q6, as recommended).
- **A spawn no longer touches Fit.** `releaseFitted` and `fit.releaseWindow` are gone; a spawn never splits a fitted or zoomed window (ADR 0021).
- **Rule text.** Rule 4 names `fit.mode` among the keys nika reads from its own `config.json`; rule 12's Fit paragraph opens with "Fit mode (0.5.4)" (both landed with the server commit).

**Alternatives.**
- *The mode in the request body:* a request must never carry a value that changes what nika does to tmux; the exact-keys check would have to be loosened, and T66 would need a new row.
- *`terminal` holds no lease and changes nothing in tmux* (P2 Q5, alternative; the owner chose the zoom on 2026-11-18): then the pane of a multi-pane window would not be zoomed, and the mirror would show a pane smaller than its window. Built as the F4 terminal form instead; the zoom is the one visible difference from `off`.
- *`off` at 1× with a cut-off mirror* (P2 Q6, alternative; the owner chose to scale the text on 2026-11-18): rejected for the reason `blocked` already scales the text.

**Consequences.**
1. A forged `fill` (`config.json` sits in an agent-writable directory, rule 9) makes the terminal show dots while a session window is open, until the chip is seen and the setting changed (T66). A file edit takes effect only at app start, after a settings save, or on a fit request with `open: true`.
2. In `terminal` your terminal shows Claude's pane zoomed too, until the session window closes.
3. In `fill` with a client attached and the page blurred, the chip's title changes to the "dots" variant with no announcement (live check LC-P2, observation).
4. A null layout read after a switch to `off` is fail-closed: nothing is applied and no line is logged.
5. The three chip colours are 0.013 to 0.035 OKLab from some `--m-*` colours (accepted: every look also has its own icon and words).
6. Found in the live check and fixed before release: after a question closed in `terminal` or `off`, a later switch back to `auto` asked the stale grown size again (a grow that ends now retargets the planner's base, with no request, whatever the mode), the pin dots touched the corner bracket at 14 px (now a small dot with a clear gap), and the Settings card icons sat high against their titles (one CSS rule).
7. `docs/design/spec.md` (§9.22), `docs/contracts/api-app.md` and `docs/security.md` (T66) carry the details.
