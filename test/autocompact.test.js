// The sweeper of the typed /compact (nika 0.5.4, AC; design-053-ac sections 1, 2 and 5): when it fires, once per crossing, the floor, the cap, one pane per tick,
// the notes. The controller's typing is tested in test/session-control.test.js; here `compact` is a fake that records its calls and returns scripted
// answers, the clock is a number the test moves, and the eligibility is a hand-made snapshot. Synthetic ids only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoCompact, decide, WAIT_MS, QUIET_MS, FLOOR_MS, MAX_FAILS, NOT_NOW_MS } from '../src/autocompact.js';

const T0 = 1_000_000_000;
const SESS = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', c: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const SENT = { status: 200, body: { sent: true }, keys: 3 };
const FAILED = { status: 409, body: { error: 'not-taken' }, keys: 4 };
const NOT_NOW = { status: 409, body: { error: 'busy-switching' }, keys: 0 };

/** A snapshot row of a live session in `pane`; the context numbers are the meter's (C6). */
const row = (pane, o = {}) => ({
  id: SESS.a, hostId: null, live: true, state: 'idle', pane: { id: pane },
  context: { tokens: 330000, window: 400000, compactAt: 320000, pct: 82.5, compaction: 'typed' }, ...o,
});
const ctxOf = (tokens, o = {}) => ({ tokens, window: 400000, compactAt: 320000, pct: 0, compaction: 'typed', ...o });

/**
 * A sweeper over a made-up world. `r.rows` is pane id -> the rows of live sessions that claim it; `r.eligible` the panes the keys route would accept;
 * `r.script` the answers of `compact` in order (an Error is thrown; the default is a success); `r.at(ms)` moves the clock to T0 + ms and ticks once.
 */
function rig({ panes = ['%1'], rows = {}, eligible = panes } = {}) {
  const r = {
    t: T0, panes, rows: new Map(Object.entries(rows).map(([k, v]) => [k, [].concat(v)])), eligible: new Set(eligible), touched: new Map(),
    calls: [], logs: [], script: [], error: null, snapshot: true, asked: 0, hold: null, during: 0, fail: false,
  };
  for (const id of panes) if (!r.rows.has(id)) r.rows.set(id, [row(id)]);
  r.world = () => {
    const agents = [...r.rows.values()].flat();
    const live = new Map();
    for (const a of agents) if (a.live && a.pane?.id) live.set(a.pane.id, live.has(a.pane.id) ? null : (a.state ?? null));
    return {
      panes: new Map(r.panes.map((id) => [id, { id, command: 'claude', dead: false }])), error: r.error, live,
      snapshot: r.snapshot ? { groups: [{ key: '0123456789abcdef', agents }] } : null,
    };
  };
  r.make = () => createAutoCompact({
    eligibility: async () => {
      r.asked += 1;
      if (r.hold) await r.hold;
      if (r.fail) throw new Error('eligibility unavailable');
      return r.world();
    },
    isEligible: (e, id) => r.eligible.has(id),
    compact: async (pane) => {
      r.calls.push([pane, r.t - T0]);
      r.t += r.during; // typing takes a while: the attempt ends later than it began
      const next = r.script.length ? r.script.shift() : SENT;
      if (next instanceof Error) throw next;
      return next;
    },
    touchedAt: (pane) => r.touched.get(pane) ?? -Infinity,
    now: () => r.t,
    log: (line) => r.logs.push(line),
  });
  r.ac = r.make();
  r.at = async (ms) => {
    r.t = T0 + ms;
    await r.ac.tick();
  };
  /** Sets the context of the (first) row of a pane. */
  r.set = (pane, o) => { Object.assign(r.rows.get(pane)[0], o); };
  r.tokens = (pane, n, extra) => r.set(pane, { context: ctxOf(n, extra) });
  r.fires = () => r.calls.length;
  return r;
}

describe('constants (design 1.1)', () => {
  test('(+) the numbers the rule fixes', () => {
    assert.deepEqual([WAIT_MS, QUIET_MS, FLOOR_MS, MAX_FAILS, NOT_NOW_MS], [60000, 60000, 600000, 3, 30000]);
  });
});

describe('C1: the setting (the row\'s compaction word)', () => {
  test('(+) test 5: "typed" and "on" fire (a session nika did not start, and one it started)', async () => {
    for (const compaction of ['typed', 'on']) {
      const r = rig({ rows: { '%1': row('%1', { context: ctxOf(330000, { compaction }) }) } });
      await r.at(0);
      assert.equal(r.fires(), 0, `${compaction}: the first tick only starts the count`);
      await r.at(WAIT_MS);
      assert.equal(r.fires(), 1, compaction);
    }
  });

  test('(\u2212) test 5: "off" and "none" never fire, and a point that is null never fires', async () => {
    for (const ctx of [ctxOf(330000, { compaction: 'off', compactAt: null }), ctxOf(330000, { compaction: 'none', compactAt: null }), ctxOf(330000, { compaction: 'typed', compactAt: null }), ctxOf(330000, { compaction: 'none' })]) {
      const r = rig({ rows: { '%1': row('%1', { context: ctx }) } });
      for (const ms of [0, WAIT_MS, 5 * WAIT_MS, 10 * FLOOR_MS]) await r.at(ms);
      assert.equal(r.fires(), 0, JSON.stringify(ctx));
    }
  });
});

describe('C2 and C3: the pane (eligible, one live session)', () => {
  test('(\u2212) test 6: a pane the keys route would not accept (dead, not claude, not live) is never typed into', async () => {
    const r = rig({ eligible: [] });
    for (const ms of [0, WAIT_MS, 5 * WAIT_MS]) await r.at(ms);
    assert.equal(r.fires(), 0);
  });

  test('(+) test 6: an eligible pane fires', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    assert.deepEqual(r.calls, [['%1', WAIT_MS]]);
  });

  test('(\u2212) test 7: two live rows claim the pane (its state reads null): no fire, however long', async () => {
    const r = rig({ rows: { '%1': [row('%1'), row('%1', { id: SESS.b })] } });
    assert.equal(r.world().live.get('%1'), null, 'premise: the ambiguous pane');
    for (const ms of [0, WAIT_MS, 5 * WAIT_MS]) await r.at(ms);
    assert.equal(r.fires(), 0);
  });

  test('(+) test 7: one live row fires; an ended row beside it does not make the pane ambiguous', async () => {
    const r = rig({ rows: { '%1': row('%1') } });
    r.rows.get('%1').push({ id: SESS.c, hostId: null, live: false, state: 'ended', pane: null, context: ctxOf(999999) });
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
  });
});

describe('C4: the point', () => {
  test('(+) test 8: tokens equal to the point fire; one below does not', async () => {
    const at = rig({ rows: { '%1': row('%1', { context: ctxOf(320000) }) } });
    await at.at(0);
    await at.at(WAIT_MS);
    assert.equal(at.fires(), 1);
    const below = rig({ rows: { '%1': row('%1', { context: ctxOf(319999) }) } });
    for (const ms of [0, WAIT_MS, 5 * WAIT_MS]) await below.at(ms);
    assert.equal(below.fires(), 0);
  });

  test('(\u2212) test 8: no number for the size or the point (context null, a string, a fraction) changes nothing and never fires', async () => {
    for (const context of [null, { tokens: '330000', compactAt: 320000, compaction: 'typed' }, { tokens: 330000, compactAt: '320000', compaction: 'typed' }, { tokens: 330000.5, compactAt: 320000, compaction: 'typed' }, { tokens: -1, compactAt: 320000, compaction: 'typed' }, {}]) {
      const r = rig({ rows: { '%1': row('%1', { context }) } });
      for (const ms of [0, WAIT_MS, 5 * WAIT_MS]) await r.at(ms);
      assert.equal(r.fires(), 0, JSON.stringify(context));
    }
  });
});

describe('C5: waiting 60 s, counted by the sweeper\'s own ticks', () => {
  test('(+) test 9: idle first seen at t, fired at t + 60000 and not a ms before', async () => {
    const r = rig();
    await r.at(1000);
    await r.at(1000 + WAIT_MS - 1);
    assert.equal(r.fires(), 0);
    await r.at(1000 + WAIT_MS);
    assert.deepEqual(r.calls, [['%1', 1000 + WAIT_MS]]);
  });

  test('(\u2212) test 9: a busy tick between resets the count; a state that is no state resets it too', async () => {
    for (const state of ['busy', 'waiting', null]) {
      const r = rig();
      await r.at(0);
      r.set('%1', { state });
      await r.at(WAIT_MS - 1000);
      r.set('%1', { state: 'idle' });
      await r.at(WAIT_MS); // idle seen again here, 60 s after the first read but only 1 s after the break
      assert.equal(r.fires(), 0, String(state));
      await r.at(WAIT_MS + WAIT_MS - 1);
      assert.equal(r.fires(), 0, `${state}: counted from the tick that read idle again`);
      await r.at(WAIT_MS + WAIT_MS);
      assert.equal(r.fires(), 1, String(state));
    }
  });

  test('(\u2212) test 9: a change of size between two ticks (a turn ran) restarts the count at that tick', async () => {
    const r = rig();
    await r.at(0);
    r.tokens('%1', 331000); // still past the point, but a turn ran between the ticks
    await r.at(WAIT_MS - 1000);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 0);
    await r.at(WAIT_MS - 1000 + WAIT_MS - 1);
    assert.equal(r.fires(), 0);
    await r.at(WAIT_MS - 1000 + WAIT_MS);
    assert.equal(r.fires(), 1);
  });

  test('(+) test 9: after an app restart the first tick starts the count (nothing is typed at once)', async () => {
    const r = rig();
    await r.at(5 * FLOOR_MS);
    assert.equal(r.fires(), 0);
    await r.at(5 * FLOOR_MS + WAIT_MS);
    assert.equal(r.fires(), 1);
  });
});

describe('C6: no user input in the last 60 s', () => {
  test('(+) test 10: touched at t, fired at t + 60000 and not a ms before', async () => {
    const r = rig();
    await r.at(0);
    r.touched.set('%1', T0 + 100_000);
    await r.at(100_000 + QUIET_MS - 1);
    assert.equal(r.fires(), 0);
    await r.at(100_000 + QUIET_MS);
    assert.deepEqual(r.calls, [['%1', 100_000 + QUIET_MS]]);
  });

  test('(\u2212) test 10: a touch of another pane does not hold this one; a touch in the future (a clock that went back) holds it', async () => {
    const r = rig({ panes: ['%1', '%2'] });
    await r.at(0);
    r.touched.set('%2', T0 + WAIT_MS);
    await r.at(WAIT_MS);
    assert.deepEqual(r.calls.map((c) => c[0]), ['%1'], 'only %1 (the first that qualifies)');
    const back = rig();
    await back.at(0);
    back.touched.set('%1', T0 + 10 * FLOOR_MS);
    await back.at(WAIT_MS);
    assert.equal(back.fires(), 0);
  });
});

describe('C7: once per crossing (armed)', () => {
  test('(\u2212) test 13: after a success the pane is disarmed: staying past the point never fires again, however long', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
    for (const ms of [2 * FLOOR_MS, 10 * FLOOR_MS, 100 * FLOOR_MS]) await r.at(WAIT_MS + ms);
    assert.equal(r.fires(), 1);
  });

  test('(+) test 13: a size below the point re-arms; past it again fires (after the floor), and the note goes typed -> compacted', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'typed');
    r.tokens('%1', 42000); // the compaction worked
    await r.at(WAIT_MS + 3000);
    assert.deepEqual(r.ac.noteFor('%1', r.world()), { state: 'compacted', at: T0 + WAIT_MS, tokens: 330000 });
    r.tokens('%1', 330000);
    await r.at(WAIT_MS + FLOOR_MS + 3000);
    await r.at(WAIT_MS + FLOOR_MS + 3000 + WAIT_MS);
    assert.equal(r.fires(), 2);
  });

  test('(\u2212) test 13: a size exactly at the point does not re-arm (below means below)', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    r.tokens('%1', 320000);
    await r.at(WAIT_MS + 3000);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'typed', 'not compacted yet');
    for (const ms of [2 * FLOOR_MS, 3 * FLOOR_MS]) await r.at(WAIT_MS + ms);
    assert.equal(r.fires(), 1);
  });
});

describe('C8: the 10 min floor after an attempt that sent a key', () => {
  test('(+) test 14: a failure at t, the next fire at t + 600000', async () => {
    const r = rig();
    r.script.push(FAILED);
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
    await r.at(WAIT_MS + FLOOR_MS);
    assert.equal(r.fires(), 2);
    assert.deepEqual(r.calls[1], ['%1', WAIT_MS + FLOOR_MS]);
  });

  test('(\u2212) test 14: one ms short of the floor, nothing; the ticks in between do not reset the wait', async () => {
    const r = rig();
    r.script.push(FAILED);
    await r.at(0);
    await r.at(WAIT_MS);
    for (let ms = WAIT_MS + 3000; ms < WAIT_MS + FLOOR_MS; ms += 100_000) await r.at(ms);
    await r.at(WAIT_MS + FLOOR_MS - 1);
    assert.equal(r.fires(), 1);
  });

  test('(\u2212) test 14: the floor counts from a thrown attempt too (keys unknown)', async () => {
    const r = rig();
    r.script.push(new Error('tmux gone'));
    await r.at(0);
    await r.at(WAIT_MS);
    await r.at(WAIT_MS + FLOOR_MS - 1);
    assert.equal(r.fires(), 1);
    await r.at(WAIT_MS + FLOOR_MS);
    assert.equal(r.fires(), 2);
  });
});

describe('C8 (cont.): the floor and the note count from the end of the attempt', () => {
  test('(+) test 14: the attempt takes 5 s: the floor and the note time are those of its end', async () => {
    const r = rig();
    r.during = 5000;
    r.script.push(FAILED);
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
    await r.at(WAIT_MS + FLOOR_MS);
    assert.equal(r.fires(), 1, 'ten minutes from the start of the attempt is too early');
    await r.at(WAIT_MS + 5000 + FLOOR_MS);
    assert.equal(r.fires(), 2);
  });

  test('(+) the typed note carries the time the keys were done', async () => {
    const r = rig();
    r.during = 5000;
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.ac.noteFor('%1', r.world()).at, T0 + WAIT_MS + 5000);
  });
});

describe('C9: stop after 3 failures until the app restarts', () => {
  const fail = async (r, times) => {
    await r.at(0);
    for (let i = 0; i < times; i += 1) await r.at(WAIT_MS + i * FLOOR_MS);
  };

  test('(+) test 15: two failures still leave the pane open for a third attempt', async () => {
    const r = rig();
    r.script.push(FAILED, FAILED);
    await fail(r, 3);
    assert.equal(r.fires(), 3);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'typed', 'the third one succeeded');
  });

  test('(\u2212) test 15: the third failure stops the pane: no more attempts ever, the note says stopped, one stderr line without a pane id', async () => {
    const r = rig();
    r.script.push(FAILED, FAILED, FAILED);
    await fail(r, 3);
    assert.equal(r.fires(), 3);
    for (const k of [4, 10, 100, 1000]) await r.at(WAIT_MS + k * FLOOR_MS);
    assert.equal(r.fires(), 3);
    assert.deepEqual(r.ac.noteFor('%1', r.world()), { state: 'stopped', at: T0 + WAIT_MS + 2 * FLOOR_MS, tokens: 330000 });
    assert.deepEqual(r.logs, ['nika: auto-compact: stopped on a pane after 3 failed tries']);
  });

  test('(\u2212) test 15: a success does not reset the count: failure, success, failure, failure stops the pane', async () => {
    const r = rig();
    r.script.push(FAILED, SENT, FAILED, FAILED);
    await r.at(0);
    await r.at(WAIT_MS); // failure 1
    await r.at(WAIT_MS + FLOOR_MS); // success: disarmed
    r.tokens('%1', 42000);
    await r.at(WAIT_MS + FLOOR_MS + 3000); // below: armed again
    r.tokens('%1', 330000);
    await r.at(WAIT_MS + 2 * FLOOR_MS + 4000);
    await r.at(WAIT_MS + 2 * FLOOR_MS + 4000 + WAIT_MS); // failure 2
    await r.at(WAIT_MS + 3 * FLOOR_MS + 4000 + WAIT_MS); // failure 3
    assert.equal(r.fires(), 4);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'stopped');
    for (const k of [4, 10, 100]) await r.at(k * FLOOR_MS + WAIT_MS * 10);
    assert.equal(r.fires(), 4);
  });

  test('(\u2212) test 15: the stop is per pane: another pane keeps its own count', async () => {
    const r = rig({ panes: ['%1', '%2'], rows: { '%1': row('%1'), '%2': row('%2', { id: SESS.b }) } });
    r.script.push(FAILED, FAILED, FAILED);
    r.touched.set('%2', T0 + 10 * FLOOR_MS * 10); // %2 is being written to: nothing for it yet
    await fail(r, 3);
    assert.equal(r.calls.every((c) => c[0] === '%1'), true);
    r.touched.delete('%2');
    await r.at(WAIT_MS + 20 * FLOOR_MS);
    assert.deepEqual(r.calls.at(-1)[0], '%2');
  });
});

describe('C10: a refusal before any key retries after 30 s, and counts for nothing else', () => {
  test('(+) test 16: keys 0 sets notBefore = t + 30000, no floor, no failure', async () => {
    const r = rig();
    r.script.push(NOT_NOW);
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
    await r.at(WAIT_MS + NOT_NOW_MS);
    assert.equal(r.fires(), 2, 'well inside the 10 min floor, because nothing was typed');
  });

  test('(\u2212) test 16: before t + 30000 nothing; and five refusals in a row never become a stop', async () => {
    const r = rig();
    r.script.push(NOT_NOW);
    await r.at(0);
    await r.at(WAIT_MS);
    await r.at(WAIT_MS + NOT_NOW_MS - 1);
    assert.equal(r.fires(), 1);
    const many = rig();
    many.script.push(NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW, NOT_NOW);
    await many.at(0);
    for (let i = 0; i < 6; i += 1) await many.at(WAIT_MS + i * NOT_NOW_MS);
    assert.equal(many.fires(), 6, 'the sixth one is a success: no failure was counted');
    assert.deepEqual(many.logs, []);
    assert.equal(many.ac.noteFor('%1', many.world()).state, 'typed');
  });

  test('(\u2212) test 16: an answer with no key count counts as a failure (the safe side)', async () => {
    const r = rig();
    r.script.push({ status: 409, body: { error: 'x' } });
    await r.at(0);
    await r.at(WAIT_MS);
    await r.at(WAIT_MS + NOT_NOW_MS);
    assert.equal(r.fires(), 1, 'the floor holds: it was a failure');
  });
});

describe('one pane per tick', () => {
  test('(+) test 17: two qualifying panes make one compact call per tick, the first in list order, the second on the next', async () => {
    const r = rig({ panes: ['%1', '%2'], rows: { '%1': row('%1'), '%2': row('%2', { id: SESS.b }) } });
    await r.at(0);
    await r.at(WAIT_MS);
    assert.deepEqual(r.calls.map((c) => c[0]), ['%1']);
    await r.at(WAIT_MS + 3000);
    assert.deepEqual(r.calls.map((c) => c[0]), ['%1', '%2']);
  });
});

describe('memory only', () => {
  test('(+) test 18: a new instance (an app restart) arms every pane again and forgets the failures and the notes', async () => {
    const r = rig();
    r.script.push(FAILED, FAILED, FAILED);
    await r.at(0);
    for (let i = 0; i < 3; i += 1) await r.at(WAIT_MS + i * FLOOR_MS);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'stopped');
    r.ac = r.make();
    assert.equal(r.ac.noteFor('%1', r.world()), null);
    const before = r.fires();
    await r.at(10 * FLOOR_MS);
    assert.equal(r.fires(), before, 'the first tick of the new instance starts the count');
    await r.at(10 * FLOOR_MS + WAIT_MS);
    assert.equal(r.fires(), before + 1);
  });
});

describe('a new session in the pane', () => {
  test('(+) test 19: a new session re-arms but keeps the floor and the failures of the pane', async () => {
    const r = rig();
    r.script.push(FAILED, SENT);
    await r.at(0);
    await r.at(WAIT_MS); // failure
    r.set('%1', { id: SESS.b }); // a new session in the pane, also past the point
    await r.at(WAIT_MS + 1000);
    await r.at(WAIT_MS + FLOOR_MS - 1);
    assert.equal(r.fires(), 1, 'the floor of the pane holds');
    await r.at(WAIT_MS + FLOOR_MS);
    assert.equal(r.fires(), 2);
    r.set('%1', { id: SESS.c }); // and another, after a success: armed again at once (the old session\'s disarm is gone)
    await r.at(WAIT_MS + FLOOR_MS + 1000);
    await r.at(WAIT_MS + 2 * FLOOR_MS + 1000);
    assert.equal(r.fires(), 3, 'a new session is armed even though the last one was typed into');
  });

  test('(\u2212) test 19: a row whose hostId is the entry\'s session is the same session continuing (W12): no re-arm, the note stays', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
    r.set('%1', { id: SESS.b, hostId: SESS.a }); // a background child continues the pane's session after /compact
    for (const k of [2, 10, 50]) await r.at(WAIT_MS + k * FLOOR_MS);
    assert.equal(r.fires(), 1, 'still disarmed');
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'typed', 'the note is still the pane\'s');
  });

  test('(\u2212) test 19: the failure count survives a new session (a new session in a stopped pane stays stopped, the stopped line stays)', async () => {
    const r = rig();
    r.script.push(FAILED, FAILED, FAILED);
    await r.at(0);
    for (let i = 0; i < 3; i += 1) await r.at(WAIT_MS + i * FLOOR_MS);
    r.set('%1', { id: SESS.b });
    for (const k of [10, 20, 30]) await r.at(WAIT_MS + k * FLOOR_MS);
    assert.equal(r.fires(), 3);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'stopped');
  });
});

describe('the note follows the session over W12 hops (round 2, N1)', () => {
  test('(\u2212) test 19: two hops in a row (a background child continues the session, and a child continues that one): the notes read typed, compacted, compacted', async () => {
    const r = rig();
    const note = () => r.ac.noteFor('%1', r.world())?.state ?? null;
    await r.at(0);
    await r.at(WAIT_MS); // typed into SESS.a
    const seen = [note()];
    r.set('%1', { id: SESS.b, hostId: SESS.a, context: ctxOf(42000) }); // the compaction: a child continues the session, the size has fallen
    await r.at(WAIT_MS + 3000);
    seen.push(note());
    r.set('%1', { id: SESS.c, hostId: SESS.b }); // and a child of that one
    await r.at(WAIT_MS + 6000);
    seen.push(note());
    assert.deepEqual(seen, ['typed', 'compacted', 'compacted']);
    assert.equal(r.fires(), 1, 'one session over three ids: nothing was typed again');
    r.set('%1', { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', hostId: null }); // an unrelated session
    assert.equal(note(), null, 'the note does not follow a session that no hop led to');
  });

  test('(+) test 19: a hop keeps the pane disarmed: staying past the point after two hops never fires', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    r.set('%1', { id: SESS.b, hostId: SESS.a });
    await r.at(WAIT_MS + 3000);
    r.set('%1', { id: SESS.c, hostId: SESS.b });
    for (const k of [2, 10, 50]) await r.at(WAIT_MS + k * FLOOR_MS);
    assert.equal(r.fires(), 1);
    assert.equal(r.ac.noteFor('%1', r.world())?.state, 'typed');
  });
});

describe('a new session restarts the wait (round 2, S1)', () => {
  test('(\u2212) test 19: the old session idle since t0 below the point, a new session past the point at t0 + 100 s: no fire before t0 + 160 s', async () => {
    const r = rig({ rows: { '%1': row('%1', { context: ctxOf(100000) }) } }); // idle, below the point: it never fires
    for (const ms of [0, 30000, 60000, 90000]) await r.at(ms);
    assert.equal(r.fires(), 0);
    r.set('%1', { id: SESS.b, context: ctxOf(330000) }); // for example a /resume typed in the terminal: another session, already past the point
    await r.at(100000);
    assert.equal(r.fires(), 0, 'the old session\'s idle time is not the new session\'s: the count starts at its first tick');
    await r.at(130000);
    await r.at(160000 - 1);
    assert.equal(r.fires(), 0);
  });

  test('(+) test 19: the same run fires at t0 + 160 s, when every other condition holds', async () => {
    const r = rig({ rows: { '%1': row('%1', { context: ctxOf(100000) }) } });
    for (const ms of [0, 30000, 60000, 90000]) await r.at(ms);
    r.set('%1', { id: SESS.b, context: ctxOf(330000) });
    await r.at(100000);
    await r.at(130000);
    await r.at(160000);
    assert.deepEqual(r.calls, [['%1', 160000]]);
  });

  test('(\u2212) test 19 (pure): a new session in the entry\'s pane starts its wait at its first reading, with the rest of the new-session rules', () => {
    const reading = { session: SESS.b, host: null, state: 'idle', tokens: 330000, compactAt: 320000, mode: 'typed', touchedAt: -Infinity, eligible: true, single: true };
    const old = { session: SESS.a, tokens: 100000, idleSince: T0, armed: false, lastAt: T0 - FLOOR_MS - 5, fails: 1, notBefore: T0 + 7, note: null };
    const first = decide(old, reading, T0 + 100000);
    assert.equal(first.fire, false);
    assert.equal(first.entry.idleSince, T0 + 100000);
    assert.deepEqual([first.entry.session, first.entry.armed, first.entry.tokens, first.entry.lastAt, first.entry.fails, first.entry.notBefore], [SESS.b, true, 330000, T0 - FLOOR_MS - 5, 1, T0 + 7]);
    assert.equal(decide(first.entry, reading, T0 + 100000 + WAIT_MS - 1).fire, false);
    assert.equal(decide(first.entry, reading, T0 + 100000 + WAIT_MS).fire, true);
  });
});

describe('notes (design 6.4)', () => {
  test('(+) the typed note is the pane\'s only while its session is the one typed into (by id or by host)', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    assert.deepEqual(r.ac.noteFor('%1', r.world()), { state: 'typed', at: T0 + WAIT_MS, tokens: 330000 });
    r.set('%1', { id: SESS.b, hostId: SESS.a });
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'typed', 'by host');
    r.set('%1', { id: SESS.c, hostId: null });
    assert.equal(r.ac.noteFor('%1', r.world()), null, 'another session: no note');
  });

  test('(\u2212) a note of a pane with no single live session is null; a pane without an entry has none; the wire shape has three fields and no session id', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    assert.deepEqual(Object.keys(r.ac.noteFor('%1', r.world())), ['state', 'at', 'tokens']);
    r.rows.get('%1').push(row('%1', { id: SESS.b }));
    assert.equal(r.ac.noteFor('%1', r.world()), null, 'two claim the pane');
    assert.equal(r.ac.noteFor('%9', r.world()), null);
    assert.equal(createAutoCompact({ eligibility: async () => r.world(), isEligible: () => true, compact: async () => SENT, touchedAt: () => -Infinity, now: () => T0, log: () => {} }).noteFor('%1', r.world()), null);
  });

  test('(\u2212) a new session clears a typed note; the stopped note stays with the pane', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    r.set('%1', { id: SESS.b });
    await r.at(WAIT_MS + 1000);
    assert.equal(r.ac.noteFor('%1', r.world()), null);
  });

  test('(\u2212) the setting off clears every note at once (no stale line), also the note of a pane this tick cannot read', async () => {
    const r = rig({ panes: ['%1', '%2'], rows: { '%1': row('%1'), '%2': row('%2', { id: SESS.b }) } });
    await r.at(0);
    await r.at(WAIT_MS);
    await r.at(WAIT_MS + 3000);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'typed');
    assert.equal(r.ac.noteFor('%2', r.world()).state, 'typed');
    r.eligible.delete('%2'); // %2 is not read this tick
    r.tokens('%1', 330000, { compaction: 'off', compactAt: null });
    await r.at(WAIT_MS + 6000);
    assert.equal(r.ac.noteFor('%1', r.world()), null);
    assert.equal(r.ac.noteFor('%2', r.world()), null);
  });

  test('(\u2212) a stopped pane whose size falls below the point stays stopped (the note is not turned into "compacted")', async () => {
    const r = rig();
    r.script.push(FAILED, FAILED, FAILED);
    await r.at(0);
    for (let i = 0; i < 3; i += 1) await r.at(WAIT_MS + i * FLOOR_MS);
    r.tokens('%1', 42000);
    await r.at(WAIT_MS + 3 * FLOOR_MS);
    assert.equal(r.ac.noteFor('%1', r.world()).state, 'stopped');
  });
});

describe('same number as the meter (design 4.1)', () => {
  test('(+) test 31: the size and the point are the row\'s own (here a point the setting would never give), and the note carries that size', async () => {
    const r = rig({ rows: { '%1': row('%1', { context: { tokens: 123456, window: 777777, compactAt: 123000, pct: 15.9, compaction: 'typed' } }) } });
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
    assert.equal(r.ac.noteFor('%1', r.world()).tokens, 123456);
  });

  test('(\u2212) test 31: a row with context null never fires; a row one below its own point does not either', async () => {
    const none = rig({ rows: { '%1': row('%1', { context: null }) } });
    for (const ms of [0, WAIT_MS, 5 * WAIT_MS]) await none.at(ms);
    assert.equal(none.fires(), 0);
    const near = rig({ rows: { '%1': row('%1', { context: { tokens: 122999, window: 777777, compactAt: 123000, pct: 15.9, compaction: 'typed' } }) } });
    for (const ms of [0, WAIT_MS, 5 * WAIT_MS]) await near.at(ms);
    assert.equal(near.fires(), 0);
  });
});

describe('lifecycle (test 40, the sweeper\'s half)', () => {
  /** A rig whose second tick waits for a snapshot until `release()`, with the count already started by the first. */
  const waiting = async () => {
    const r = rig();
    await r.at(0);
    let release;
    r.hold = new Promise((ok) => { release = ok; });
    r.t = T0 + WAIT_MS;
    return { r, release, inflight: r.ac.tick() };
  };

  test('(+) premise: the tick that waits for its snapshot types when nothing stops it', async () => {
    const { r, release, inflight } = await waiting();
    release();
    await inflight;
    assert.equal(r.fires(), 1);
  });

  test('(\u2212) stop() while a tick waits for its snapshot: that tick makes no compact call', async () => {
    const { r, release, inflight } = await waiting();
    r.ac.stop();
    release();
    await inflight;
    assert.equal(r.fires(), 0);
  });

  test('(\u2212) stop(): later ticks return at once and do not even ask for a snapshot', async () => {
    const r = rig();
    await r.at(0);
    const asked = r.asked;
    r.ac.stop();
    for (const ms of [WAIT_MS, 5 * WAIT_MS, 10 * FLOOR_MS]) await r.at(ms);
    assert.equal(r.asked, asked);
    assert.equal(r.fires(), 0);
  });

  test('(\u2212) a slow tick is not stacked: a second tick while the first is running returns at once and asks for no snapshot', async () => {
    const r = rig();
    let asked = 0;
    let release;
    const gate = new Promise((ok) => { release = ok; });
    const ac = createAutoCompact({
      eligibility: async () => { asked += 1; await gate; return r.world(); }, isEligible: () => true, compact: async (pane) => { r.calls.push([pane]); return SENT; },
      touchedAt: () => -Infinity, now: () => r.t, log: () => {},
    });
    const first = ac.tick();
    const others = [ac.tick(), ac.tick()];
    await new Promise((ok) => setImmediate(ok)); // not awaited: a second tick that did not return at once would sit on the same gate
    assert.equal(asked, 1);
    release();
    await Promise.all([first, ...others]);
    await ac.tick();
    assert.equal(asked, 2, 'free again once the first is done');
  });

  test('(\u2212) a snapshot that cannot be taken, or a compact that throws, never rejects the tick', async () => {
    const r = rig();
    const down = createAutoCompact({ eligibility: async () => { throw new Error('tmux gone'); }, isEligible: () => true, compact: async () => SENT, touchedAt: () => -Infinity, now: () => r.t, log: () => {} });
    await down.tick();
    r.script.push(new Error('boom'));
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
  });
});

describe('entries of vanished panes', () => {
  test('(+) a pane that tmux no longer lists is forgotten when the listing and the snapshot were read without error (a reused id starts fresh)', async () => {
    const r = rig();
    r.script.push(FAILED, FAILED);
    await r.at(0);
    await r.at(WAIT_MS);
    await r.at(WAIT_MS + FLOOR_MS); // two failures
    const V = WAIT_MS + FLOOR_MS;
    r.panes = [];
    r.rows.clear();
    await r.at(V + 1000);
    r.panes = ['%1']; // tmux reuses the id for another session
    r.rows.set('%1', [row('%1', { id: SESS.b })]);
    r.script.push(FAILED, FAILED);
    await r.at(V + 2000);
    await r.at(V + 2000 + WAIT_MS);
    assert.equal(r.fires(), 3, 'fresh entry: no floor, armed');
    await r.at(V + 2000 + WAIT_MS + FLOOR_MS);
    await r.at(V + 2000 + WAIT_MS + 2 * FLOOR_MS);
    assert.equal(r.fires(), 5, 'two failures of the new pane do not stop it: the old count is gone');
  });

  test('(\u2212) a tmux blip (an error, or no snapshot) keeps the entry, so a failure count is not shed by a blip', async () => {
    for (const blip of ['error', 'snapshot']) {
      const r = rig();
      r.script.push(FAILED, FAILED, FAILED);
      await r.at(0);
      await r.at(WAIT_MS);
      await r.at(WAIT_MS + FLOOR_MS);
      if (blip === 'error') { r.error = 'tmux unavailable'; r.panes = []; } else { r.snapshot = false; r.panes = []; }
      await r.at(WAIT_MS + FLOOR_MS + 1000);
      r.error = null;
      r.snapshot = true;
      r.panes = ['%1'];
      await r.at(WAIT_MS + FLOOR_MS + 2000);
      await r.at(WAIT_MS + 2 * FLOOR_MS);
      assert.equal(r.fires(), 3, blip);
      for (const k of [3, 4, 5]) await r.at(WAIT_MS + k * FLOOR_MS);
      assert.equal(r.fires(), 3, `${blip}: the third failure stopped it, the count survived the blip`);
    }
  });
});

describe('decide (pure)', () => {
  const reading = (o = {}) => ({ session: SESS.a, host: null, state: 'idle', tokens: 330000, compactAt: 320000, mode: 'typed', touchedAt: -Infinity, eligible: true, single: true, ...o });
  const fresh = () => ({ session: SESS.a, tokens: null, idleSince: null, armed: true, lastAt: null, fails: 0, notBefore: 0, note: null });

  test('(+) a null entry starts fresh; the result is a new object and the input is not changed', () => {
    const e = Object.freeze({ ...fresh(), idleSince: T0 });
    const out = decide(e, reading(), T0 + WAIT_MS);
    assert.equal(out.fire, true);
    assert.notEqual(out.entry, e);
    const first = decide(null, reading(), T0);
    assert.deepEqual(first, { entry: { ...fresh(), idleSince: T0, tokens: 330000 }, fire: false });
  });

  test('(\u2212) a pane that is not eligible, or has no single live row, keeps its entry (but for the idle wait, round 1) and never fires', () => {
    const e = { ...fresh(), idleSince: T0, tokens: 330000 };
    for (const o of [{ eligible: false }, { single: false }]) {
      assert.deepEqual(decide(e, reading(o), T0 + 10 * FLOOR_MS), { entry: { ...e, idleSince: null }, fire: false }, JSON.stringify(o));
    }
    const waiting = { ...fresh(), tokens: 330000 }; // no wait running: nothing to restart, the same entry comes back
    assert.equal(decide(waiting, reading({ eligible: false }), T0).entry, waiting);
    assert.deepEqual(decide(null, reading({ single: false }), T0), { entry: null, fire: false });
  });

  test('(\u2212) each condition alone blocks the fire (setting, point, wait, quiet, armed, floor, cap, not now)', () => {
    const ready = { ...fresh(), idleSince: T0, tokens: 330000 };
    const now = T0 + WAIT_MS;
    assert.equal(decide(ready, reading(), now).fire, true, 'premise');
    const blocked = [
      ['mode off', ready, { mode: 'off' }], ['mode none', ready, { mode: 'none' }], ['below the point', ready, { tokens: 319999 }],
      ['not waited', { ...ready, idleSince: T0 + 1 }, {}], ['touched', ready, { touchedAt: now - QUIET_MS + 1 }], ['disarmed', { ...ready, armed: false }, {}],
      ['floor', { ...ready, lastAt: now - FLOOR_MS + 1 }, {}], ['cap', { ...ready, fails: MAX_FAILS }, {}], ['not now', { ...ready, notBefore: now + 1 }, {}],
      ['busy', ready, { state: 'busy' }],
    ];
    for (const [name, entry, o] of blocked) assert.equal(decide(entry, reading(o), now).fire, false, name);
    const edge = [['floor', { ...ready, lastAt: now - FLOOR_MS }, {}], ['quiet', ready, { touchedAt: now - QUIET_MS }], ['not now', { ...ready, notBefore: now }, {}], ['fails 2', { ...ready, fails: MAX_FAILS - 1 }, {}]];
    for (const [name, entry, o] of edge) assert.equal(decide(entry, reading(o), now).fire, true, `${name} at its edge`);
  });
});

describe('round 1 (answer 1): a tick that does not observe the pane restarts the 60 s idle wait', () => {
  const GAPS = {
    'the pane is not eligible': (r) => { r.eligible.delete('%1'); return () => r.eligible.add('%1'); },
    'two live rows claim the pane': (r) => { r.rows.get('%1').push(row('%1', { id: SESS.b })); return () => r.rows.get('%1').pop(); },
    'tmux lists no panes (an error)': (r) => { r.error = 'tmux unavailable'; r.panes = []; return () => { r.error = null; r.panes = ['%1']; }; },
    'tmux lists no panes and the registry read gave no snapshot': (r) => { r.snapshot = false; r.panes = []; return () => { r.snapshot = true; r.panes = ['%1']; }; },
    'the registry read gave no snapshot (the pane is still listed)': (r) => { r.snapshot = false; return () => { r.snapshot = true; }; },
    'the whole tick fails (eligibility throws)': (r) => { r.fail = true; return () => { r.fail = false; }; },
  };
  /** Ticks every 3 s from `from` to `to` (both included). */
  const ticks = async (r, from, to) => { for (let ms = from; ms <= to; ms += 3000) await r.at(ms); };

  for (const [name, open] of Object.entries(GAPS)) {
    test(`(\u2212) idle seen at t, unobserved ticks from t + 3 s to t + 90 s (${name}), observed idle at t + 93 s: no fire before t + 153 s`, async () => {
      const r = rig();
      await r.at(0); // idle seen: the wait starts
      const close = open(r);
      await ticks(r, 3000, 90000);
      close();
      await r.at(93000);
      assert.equal(r.fires(), 0, 'the gap is no part of the wait: the count starts again at the first observed tick');
      await ticks(r, 96000, 150000);
      assert.equal(r.fires(), 0);
      await r.at(152999);
      assert.equal(r.fires(), 0, 'one ms short of 60 s after t + 93 s');
    });

    test(`(+) the same run (${name}) fires at t + 153 s, when every other condition holds`, async () => {
      const r = rig();
      await r.at(0);
      const close = open(r);
      await ticks(r, 3000, 90000);
      close();
      await r.at(93000);
      await ticks(r, 96000, 150000);
      await r.at(153000);
      assert.equal(r.fires(), 1);
      assert.deepEqual(r.calls, [['%1', 153000]]);
    });
  }

  test('(\u2212) the unobserved tick keeps fails, lastAt, armed, notBefore, tokens and a stopped note: only idleSince goes', () => {
    const reading = (o = {}) => ({ session: SESS.a, host: null, state: 'idle', tokens: 330000, compactAt: 320000, mode: 'typed', touchedAt: -Infinity, eligible: true, single: true, ...o });
    const stopped = { state: 'stopped', at: T0 - 5, tokens: 331000, session: SESS.a };
    const e = { session: SESS.a, tokens: 331000, idleSince: T0, armed: false, lastAt: T0 - 7, fails: 2, notBefore: T0 + 5, note: stopped };
    for (const o of [{ eligible: false }, { single: false }, { eligible: false, state: null, tokens: undefined }]) {
      const out = decide(e, reading(o), T0 + 90000);
      assert.deepEqual(out, { entry: { ...e, idleSince: null }, fire: false }, JSON.stringify(o));
      assert.equal(out.entry.note, stopped, 'the note itself, not a copy that could differ');
    }
    assert.equal(e.idleSince, T0, 'the input entry is not changed');
  });

  test('(\u2212) a gap keeps the failure count and the floor: failure, failure, gap, then the third failure stops the pane and no fourth try comes', async () => {
    const r = rig();
    r.script.push(FAILED, FAILED, FAILED);
    await r.at(0);
    await r.at(WAIT_MS);
    await r.at(WAIT_MS + FLOOR_MS);
    assert.equal(r.fires(), 2);
    const close = GAPS['the pane is not eligible'](r);
    await ticks(r, WAIT_MS + FLOOR_MS + 3000, WAIT_MS + FLOOR_MS + 90000);
    close();
    await r.at(WAIT_MS + FLOOR_MS + 93000); // observed again: the idle wait starts here and is long over before the floor is
    await r.at(WAIT_MS + 2 * FLOOR_MS - 1);
    assert.equal(r.fires(), 2, 'the floor still counts from the last try (lastAt is kept)');
    await r.at(WAIT_MS + 2 * FLOOR_MS);
    assert.equal(r.fires(), 3);
    assert.deepEqual(r.logs, ['nika: auto-compact: stopped on a pane after 3 failed tries'], 'two failures before the gap and one after it make three');
    const open = GAPS['the pane is not eligible'](r);
    await ticks(r, WAIT_MS + 2 * FLOOR_MS + 3000, WAIT_MS + 2 * FLOOR_MS + 90000);
    open();
    assert.equal(r.ac.noteFor('%1', r.world())?.state, 'stopped', 'a stopped note survives a gap');
    for (const k of [3, 4, 5]) await r.at(WAIT_MS + k * FLOOR_MS + 100000);
    assert.equal(r.fires(), 3, 'stopped stays stopped');
  });

  test('(\u2212) a gap does not re-arm a pane that was typed into: staying above the point never fires a second time', async () => {
    const r = rig();
    await r.at(0);
    await r.at(WAIT_MS);
    assert.equal(r.fires(), 1);
    assert.equal(r.ac.noteFor('%1', r.world())?.state, 'typed');
    const close = GAPS['two live rows claim the pane'](r);
    await ticks(r, WAIT_MS + 3000, WAIT_MS + 90000);
    close();
    assert.equal(r.ac.noteFor('%1', r.world())?.state, 'typed', 'the note stays through the gap');
    await ticks(r, WAIT_MS + 93000, WAIT_MS + 93000 + 3 * FLOOR_MS);
    assert.equal(r.fires(), 1, 'armed is kept (false) through the gap');
  });

  test('(+) a pane that is idle and observed again after a short gap waits the whole 60 s again, not the rest of the old one', async () => {
    const r = rig();
    await r.at(0);
    await r.at(30000); // 30 s of the wait seen
    const close = GAPS['the pane is not eligible'](r);
    await r.at(33000);
    close();
    await r.at(36000);
    await r.at(36000 + WAIT_MS - 1);
    assert.equal(r.fires(), 0);
    await r.at(36000 + WAIT_MS);
    assert.equal(r.fires(), 1);
  });
});
