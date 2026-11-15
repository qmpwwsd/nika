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
