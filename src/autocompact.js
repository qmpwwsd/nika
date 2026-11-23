// The sweeper of the typed /compact (nika 0.5.4, AC; docs/adr/0014 amendment, rule 12 "Typed compaction"). App tier only: createAppApi builds it,
// appio's 3 s status tick calls tick(). It decides, per pane and cheapest first, when a Claude session that waits past its compact point gets a
// typed `/compact`, and it keeps the little memory that makes that happen once per crossing. It types nothing itself: `compact(pane)` is the
// controller's autoCompact (src/session-control.js), which takes the per-pane lock without waiting, re-reads the screen and sends the keys.
//
// All state lives in this closure's memory and is never written: an app restart arms every pane again. Nothing here reads a file, a request or a
// transcript; the size and the point are the numbers the context meter shows (the row's `context`, C6), so trigger and meter cannot disagree.

export const WAIT_MS = 60000; // the registry has read `idle` at each of nika's ticks for this long (C5)
export const QUIET_MS = 60000; // no user action has named the pane for this long (C6)
export const FLOOR_MS = 600000; // no attempt that sent a key within this long of the last one (C8)
export const MAX_FAILS = 3; // failed tries on one pane in total, a success does not reset the count (C9)
export const NOT_NOW_MS = 30000; // a refusal before any key retries after this long (C10)

const STOPPED_LINE = 'nika: auto-compact: stopped on a pane after 3 failed tries'; // no pane id, no text of the screen

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** A copy of the entry with its idle wait started over (the pane was not observed); the entry itself when no wait is running. */
const unwaited = (entry) => (entry.idleSince === null ? entry : { ...entry, idleSince: null });

const fresh = (session) => ({ session, tokens: null, idleSince: null, armed: true, lastAt: null, fails: 0, notBefore: 0, note: null });

/**
 * One pane, one tick. Pure: no I/O, the input entry is not changed. `reading` = { session, host, state, tokens, compactAt, mode, touchedAt,
 * eligible, single }: the pane's single live row (id, hostId), the registry state, the row's context numbers and compaction word, the last
 * time a user action named the pane (-Infinity for never), whether the keys route would accept the pane and whether exactly one live session
 * claims it. Returns { entry, fire }.
 *
 * A pane that is not eligible or has no single live row never fires and keeps its entry as it was (a tmux blip proves nothing: the failures, the
 * floor, the disarmed state, the size and the note stay), except that its idle wait starts over: C5 counts the 60 s from nika's own ticks, and a gap in
 * which nika saw nothing is no part of that wait (round 1).
 */
export function decide(entry, reading, now) {
  if (!reading.eligible || !reading.single) return { entry: entry === null ? null : unwaited(entry), fire: false };
  let e = { ...(entry ?? fresh(reading.session)) };

  if (e.session !== reading.session) {
    if (reading.host === e.session) {
      // a background child that continues the pane's session after /compact (W12): the same session under a new id
      if (e.note?.session === e.session) e.note = { ...e.note, session: reading.session };
      e.session = reading.session;
    } else {
      // a new session in the pane: armed again, the count of its wait starts over; the floor, the failures and the retry time stay with the pane
      e = { ...e, session: reading.session, armed: true, idleSince: null, tokens: null, note: e.note?.state === 'stopped' ? e.note : null };
    }
  }

  // C5: counted from nika's own ticks. A change of size between two ticks means a turn ran, so the wait starts again from this tick
  if (reading.state === 'idle') {
    if (e.idleSince === null || (isCount(reading.tokens) && e.tokens !== null && reading.tokens !== e.tokens)) e.idleSince = now;
  } else {
    e.idleSince = null;
  }
  if (isCount(reading.tokens)) e.tokens = reading.tokens;

  const known = isCount(reading.tokens) && isCount(reading.compactAt);
  if (known && reading.tokens < reading.compactAt) {
    e.armed = true; // the size was seen below the point: a later crossing counts again
    if (e.note?.state === 'typed') e.note = { ...e.note, state: 'compacted' };
  }

  const fire = (reading.mode === 'on' || reading.mode === 'typed') // C1
    && known && reading.tokens >= reading.compactAt // C4
    && e.idleSince !== null && now - e.idleSince >= WAIT_MS // C5
    && now - reading.touchedAt >= QUIET_MS // C6
    && e.armed === true // C7
    && (e.lastAt === null || now - e.lastAt >= FLOOR_MS) // C8
    && e.fails < MAX_FAILS // C9
    && now >= e.notBefore; // C10
  return { entry: e, fire };
}

/** The wire form of a note: three fields, no session id, no text. */
const wire = (note) => ({ state: note.state, at: note.at, tokens: note.tokens });

/**
 * deps: eligibility() -> { panes, error, live, snapshot } (api-app's loadEligibility), isEligible(e, pane), compact(pane) -> { status, body, keys },
 * touchedAt(pane) -> ms or -Infinity, now() -> ms, log(line). Returns { tick(), stop(), noteFor(pane, e) }.
 */
export function createAutoCompact({ eligibility, isEligible, compact, touchedAt, now, log = () => {} }) {
  const entries = new Map(); // pane id -> entry
  let running = false;
  let stopped = false;

  /** The live rows of the snapshot that claim each pane. */
  const liveRows = (e) => {
    const byPane = new Map();
    for (const g of e.snapshot?.groups ?? []) {
      for (const a of g.agents ?? []) {
        if (a.live !== true || typeof a.pane?.id !== 'string' || typeof a.id !== 'string') continue;
        byPane.set(a.pane.id, [...(byPane.get(a.pane.id) ?? []), a]);
      }
    }
    return byPane;
  };

  /**
   * The entry after an attempt (design 5.3). `outcome` is { status, body, keys }, or null when compact threw. `at` is read when `compact` resolves, so
   * `lastAt`, `notBefore` and the note's `at` count from the END of the attempt: the gap between two attempts is never shorter than the 10 min floor.
   */
  function settle(entry, outcome, at) {
    if (outcome !== null && outcome.status === 200) {
      return { entry: { ...entry, lastAt: at, armed: false, note: { state: 'typed', at, tokens: entry.tokens, session: entry.session } }, stoppedNow: false };
    }
    if (outcome !== null && outcome.keys === 0) return { entry: { ...entry, notBefore: at + NOT_NOW_MS }, stoppedNow: false };
    // sent a key and failed, threw, or an answer with no key count: all count as a failure (the safe side)
    const fails = entry.fails + 1;
    const stoppedNow = fails === MAX_FAILS;
    const note = stoppedNow ? { state: 'stopped', at, tokens: entry.tokens, session: entry.session } : entry.note;
    return { entry: { ...entry, lastAt: at, fails, note }, stoppedNow };
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const e = await eligibility();
      const t = now();
      const byPane = liveRows(e);
      let target = null;
      const seen = new Set();
      for (const pane of e.panes.keys()) {
        seen.add(pane);
        const rows = byPane.get(pane) ?? [];
        const row = rows.length === 1 ? rows[0] : null;
        const context = row?.context ?? null;
        const { entry, fire } = decide(entries.get(pane) ?? null, {
          session: row?.id ?? null, host: row?.hostId ?? null, state: row ? (e.live.get(pane) ?? null) : null,
          tokens: context?.tokens, compactAt: context?.compactAt, mode: context?.compaction, touchedAt: touchedAt(pane),
          eligible: isEligible(e, pane), single: row !== null,
        }, t);
        if (entry !== null) entries.set(pane, entry);
        if (fire && target === null) target = pane;
      }
      // a pane the listing did not give this tick (tmux or the registry could not be read) was not observed: its idle wait starts over, the rest stays
      for (const [pane, entry] of entries) if (!seen.has(pane)) entries.set(pane, unwaited(entry));
      // a pane tmux no longer lists is forgotten (its id can be reused by another session); a failed listing or registry read proves nothing
      if (!e.error && e.snapshot) for (const pane of [...entries.keys()]) if (!e.panes.has(pane)) entries.delete(pane);
      // the setting reads off: no stale "typed" line anywhere
      for (const rows of byPane.values()) {
        if (rows.some((r) => r.context?.compaction === 'off')) {
          for (const [pane, entry] of entries) entries.set(pane, { ...entry, note: null });
          break;
        }
      }
      if (target === null || stopped) return;

      let outcome = null;
      try {
        outcome = await compact(target);
      } catch {
        outcome = null;
      }
      const entry = entries.get(target);
      if (!entry) return; // the pane vanished while the keys were going
      const result = settle(entry, outcome, now());
      entries.set(target, result.entry);
      if (result.stoppedNow) log(STOPPED_LINE);
    } catch {
      // a tick that cannot read the world (tmux gone, a collect that failed) types nothing and observed no pane: every idle wait starts over
      for (const [pane, entry] of entries) entries.set(pane, unwaited(entry));
    } finally {
      running = false;
    }
  }

  function stop() {
    stopped = true;
  }

  /**
   * The note the page may show for a pane, or null: the last typed /compact of the pane's session (typed, compacted), or the stop of the pane
   * (per pane, whatever session is in it). A typed or compacted note belongs to the session that was typed into, found by its id or its hostId.
   */
  function noteFor(pane, e) {
    const note = entries.get(pane)?.note ?? null;
    if (note === null) return null;
    if (note.state === 'stopped') return wire(note);
    const rows = liveRows(e).get(pane) ?? [];
    if (rows.length !== 1) return null;
    return rows[0].id === note.session || rows[0].hostId === note.session ? wire(note) : null;
  }

  return { tick, stop, noteFor };
}
