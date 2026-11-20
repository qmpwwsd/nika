// 0.5.4 RM: collect() leaves removed sessions and folders out and counts them (design-053-rm 1.3, 1.5, 1.6, 4.2).
// Synthetic machine from test/helpers.js; the hidden maps are passed in, no state file is read here.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFixture, cleanup, fakeExec, jsonl, SID, NOW, PROC_START } from './helpers.js';
import { collect, findSession, findSessions, findGroup } from '../src/model.js';
import { statusLine } from '../src/appio.js';
import { saveConfig, defaults, keyFor } from '../src/store.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const NOPANE = '88888888-8888-4888-8888-888888888888'; // live, no tmux pane
const HOST = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const CHILD = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const OLD1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // solo: ended, first line 5 days ago
const RES = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // solo: first line 5 days ago, resumed 10 minutes ago in a plain terminal (live, no pane)
const NOTS = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; // solo: ended, a transcript without any timestamp (mtime 2 days ago)
const NEWER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; // solo: ended, first line one hour ago

const fx = makeFixture();
const tops = [];
after(() => {
  cleanup(fx);
  while (tops.length) fs.rmSync(tops.pop(), { recursive: true, force: true });
});

const slug = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
const SOLO = path.join(fx.root, 'solo');
fs.mkdirSync(SOLO, { recursive: true });
function transcript(sid, cwd, { start, mtime }) {
  const file = path.join(fx.claudeDir, 'projects', slug(cwd), `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stamp = (ms) => (ms === null ? {} : { timestamp: new Date(ms).toISOString() });
  fs.writeFileSync(file, jsonl([
    { type: 'user', cwd, sessionId: sid, ...stamp(start), message: { role: 'user', content: 'synthetic prompt' } },
    { type: 'assistant', cwd, sessionId: sid, ...stamp(start), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [] } },
  ]));
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}
const register = (pid, o) => fs.writeFileSync(path.join(fx.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({
  pid, kind: 'interactive', procStart: PROC_START, version: '2.1.319', nameSource: 'derived', updatedAt: NOW - MIN, ...o,
}));
// A live session without a pane: pid 106, status absent ("unknown"), started an hour ago
register(106, { sessionId: NOPANE, cwd: fx.repo, name: 'stuck-one', startedAt: NOW - 60 * MIN });
// solo: three ended sessions and one resumed in a plain terminal (a new process, old transcript)
transcript(OLD1, SOLO, { start: NOW - 5 * DAY, mtime: NOW - 5 * DAY + MIN });
transcript(RES, SOLO, { start: NOW - 5 * DAY, mtime: NOW - 5 * MIN });
transcript(NOTS, SOLO, { start: null, mtime: NOW - 2 * DAY });
transcript(NEWER, SOLO, { start: NOW - HOUR, mtime: NOW - 30 * MIN });
register(107, { sessionId: RES, cwd: SOLO, name: 'resumed', startedAt: NOW - 10 * MIN });

const PS = [`  101 ${PROC_START}`, `  102 ${PROC_START}`, `  104 ${PROC_START}`, `  106 ${PROC_START}`, `  107 ${PROC_START}`];
const PS_NO_RES = PS.filter((l) => !l.startsWith('  107'));
/** Nothing removed: an object of two empty maps. */
const none = () => ({ sessions: new Map(), groups: new Map() });
const hid = ({ sessions = [], groups = [] } = {}) => ({ sessions: new Map(sessions), groups: new Map(groups) });
const run = (hidden, o = {}) => collect({
  config: o.config ?? fx.config, exec: o.exec ?? fakeExec({ psLines: o.ps ?? PS }), now: NOW, sinceMs: 7 * DAY, ...(hidden === undefined ? {} : { hidden }),
});
const all = (s) => s.snapshot.groups.flatMap((g) => g.agents);
const ids = (s) => all(s).map((a) => a.id);
const group = (s, label) => s.snapshot.groups.find((g) => g.label === label);
const labels = (s) => s.snapshot.groups.map((g) => g.label).sort();

let keys;
const keyOf = async (label) => {
  keys ??= Object.fromEntries((await run()).snapshot.groups.map((g) => [g.label, g.key]));
  return keys[label];
};

/** A config with nika's project list: the projects given are written to config.json in a temp dir. */
async function withProjects(dirs) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-model-hidden-'));
  tops.push(base);
  const env = { NIKA_CONFIG_DIR: path.join(base, 'cfg') };
  await saveConfig({ ...defaults(), projects: dirs.map((dir) => ({ key: keyFor(dir), dir, name: path.basename(dir), addedAt: '2026-11-01T00:00:00.000Z' })) }, env);
  return { ...fx.config, env };
}

describe('collect with removed sessions', () => {
  test('(+) a removed ended row and a removed live row without a pane are left out; group.hidden and snapshot.hidden count them', async () => {
    const base = await run();
    assert.ok(ids(base).includes(SID.ended) && ids(base).includes(NOPANE));
    const s = await run(hid({ sessions: [[SID.ended, NOW], [NOPANE, NOW]] }));
    assert.ok(!ids(s).includes(SID.ended) && !ids(s).includes(NOPANE));
    assert.equal(group(s, 'repo').hidden, 2);
    assert.equal(group(s, 'plain').hidden, 0);
    assert.equal(s.snapshot.hidden, 2);
  });

  test('(+) counts leave the removed rows out, per group and in total', async () => {
    const base = await run();
    const s = await run(hid({ sessions: [[SID.ended, NOW], [NOPANE, NOW]] }));
    const was = group(base, 'repo').counts;
    const now = group(s, 'repo').counts;
    assert.equal(was.total - now.total, 2);
    assert.equal(was.ended - now.ended, 1, 'the ended row');
    assert.equal(was.other - now.other, 1, 'the live row without a status counts as "other"');
    assert.equal(base.snapshot.counts.total - s.snapshot.counts.total, 2);
  });

  test('(+) the tray line leaves a removed row out of its attention count (statusLine reads the counts)', async () => {
    const base = statusLine((await run()).snapshot);
    const gone = statusLine((await run(hid({ sessions: [[NOPANE, NOW]] }))).snapshot);
    assert.equal(base.attention - gone.attention, 1);
  });

  test('(+) a row whose host id is removed is left out too (a background session continues the pane\'s old session)', async () => {
    const fxh = makeFixture();
    try {
      const write = (pid, o) => fs.writeFileSync(path.join(fxh.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({
        pid, kind: 'interactive', cwd: fxh.repo, procStart: PROC_START, startedAt: NOW - 60 * MIN, updatedAt: NOW - MIN, version: '2.1.319', nameSource: 'user', name: 'acme', ...o,
      }));
      write(201, { sessionId: HOST, parkedJobId: 'c0ffee01', status: 'idle', tmux: 'work:@4.%9' });
      write(202, { sessionId: CHILD, kind: 'bg', jobId: 'c0ffee01', status: 'busy' });
      const ps = [`  101 ${PROC_START}`, `  102 ${PROC_START}`, `  201 ${PROC_START}`, `  202 ${PROC_START}`];
      const noPane = fakeExec({ psLines: ps });
      const withPane = fakeExec({ psLines: ps, tmuxLines: ['%5\twork\t1\tx\tzsh', '%6\twork\t2\ty\tclaude', '%9\twork\t4\tz\tclaude'] });
      const seen = await run(none(), { config: fxh.config, exec: noPane });
      const row = all(seen).find((a) => a.id === CHILD);
      assert.equal(row.hostId, HOST);
      assert.equal(row.pane, null, 'the host\'s pane is not in the tmux list');
      const s = await run(hid({ sessions: [[HOST, NOW]] }), { config: fxh.config, exec: noPane });
      assert.ok(!ids(s).includes(CHILD), 'dropped by its host id');
      assert.equal(s.snapshot.hidden, 1);
      const kept = await run(hid({ sessions: [[HOST, NOW]] }), { config: fxh.config, exec: withPane });
      assert.equal(all(kept).find((a) => a.id === CHILD).pane.id, '%9', '(\u2212) with the host\'s pane in tmux the row always shows');
    } finally {
      cleanup(fxh);
    }
  });

  test('(\u2212) a removed id that is live in a tmux pane still shows, and is not counted', async () => {
    const s = await run(hid({ sessions: [[SID.busy, NOW], [SID.idle, NOW]] }));
    assert.ok(ids(s).includes(SID.busy) && ids(s).includes(SID.idle));
    assert.equal(s.snapshot.hidden, 0);
    assert.equal(group(s, 'repo').hidden, 0);
  });

  test('(\u2212) no hidden argument, or two empty maps, changes nothing but the zero counts', async () => {
    const plain = await run();
    const empty = await run(none());
    assert.deepEqual(empty.snapshot, plain.snapshot);
    assert.equal(plain.snapshot.hidden, 0);
    assert.ok(plain.snapshot.groups.every((g) => g.hidden === 0));
    assert.deepEqual(ids(plain), ids(await run(hid({ sessions: [['99999999-9999-4999-8999-999999999999', NOW]], groups: [['0000000000000000', NOW]] }))), 'an id nobody has hides nothing');
  });

  test('(\u2212) a hidden argument with a missing map is read as empty (a caller that passes only sessions)', async () => {
    const s = await run({ sessions: new Map([[SID.ended, NOW]]) });
    assert.ok(!ids(s).includes(SID.ended));
    const g = await run({ groups: new Map() });
    assert.equal(g.snapshot.hidden, 0);
  });

  test('(\u2212) a detected folder whose rows are all removed by id is dropped; a nika project keeps its group (empty, with its count), so Show stays reachable', async () => {
    const s = await run(hid({ sessions: [[SID.other, NOW]] }));
    assert.ok(!labels(s).includes('plain'), 'a folder that is not a project goes when nothing is left');
    assert.equal(s.snapshot.hidden, 1, 'its row is still counted');
    const config = await withProjects([fx.plain]);
    const p = await run(hid({ sessions: [[SID.other, NOW]] }), { config });
    const plain = group(p, 'plain');
    assert.ok(plain, 'the project group stays');
    assert.deepEqual(plain.agents, []);
    assert.equal(plain.hidden, 1);
    assert.deepEqual(plain.counts, { busy: 0, idle: 0, other: 0, ended: 0, total: 0 });
    assert.equal(plain.lastActivity, 0);
  });

  test('(\u2212) findSession and findSessions pass no removals: a removed id is still found', async () => {
    const hit = await findSession(SID.ended, { config: fx.config, exec: fakeExec({ psLines: PS }), now: NOW });
    assert.equal(hit.agent.id, SID.ended);
    assert.equal(hit.agent.live, false);
    const live = await findSession(NOPANE, { config: fx.config, exec: fakeExec({ psLines: PS }), now: NOW });
    assert.equal(live.agent.live, true);
    const many = await findSessions([SID.ended, SID.other], { config: fx.config, now: NOW });
    assert.deepEqual([...many.keys()].sort(), [SID.ended, SID.other].sort());
  });
});

describe('collect with a removed folder (RM-Q1 = A)', () => {
  test('(+) a folder entry hides the rows that are not live in a tmux pane and started at or before it; a detected folder with nothing left is dropped, counted', async () => {
    const plainKey = await keyOf('plain');
    const s = await run(hid({ groups: [[plainKey, NOW]] }));
    assert.ok(!labels(s).includes('plain'));
    assert.ok(!ids(s).includes(SID.other));
    assert.equal(s.snapshot.hidden, 1);
    assert.ok(s.snapshot.groups.every((g) => g.label !== 'plain'), 'the rows are counted in the total, not in a group');
  });

  test('(+) the live rows of that folder in a tmux pane stay (a folder with one left keeps its group, with the others counted)', async () => {
    const repoKey = await keyOf('repo');
    const base = await run();
    const s = await run(hid({ groups: [[repoKey, NOW]] }));
    const repo = group(s, 'repo');
    assert.deepEqual(ids(s).filter((id) => [SID.busy, SID.idle].includes(id)).sort(), [SID.busy, SID.idle].sort());
    assert.ok(!ids(s).includes(SID.ended) && !ids(s).includes(SID.dead) && !ids(s).includes(NOPANE));
    assert.equal(repo.agents.length, 2);
    assert.equal(repo.hidden, group(base, 'repo').agents.length - 2);
    assert.equal(s.snapshot.hidden, repo.hidden, 'the other folders are untouched');
  });

  test('(+) an entry of one folder hides nothing of another, and a key nobody has hides nothing', async () => {
    const repoKey = await keyOf('repo');
    const s = await run(hid({ groups: [[repoKey, NOW]] }));
    assert.ok(ids(s).includes(SID.other), 'plain stays');
    assert.equal(group(s, 'plain').hidden, 0);
    const other = await run(hid({ groups: [['0123456789abcdef', NOW]] }));
    assert.deepEqual(ids(other), ids(await run()));
    assert.equal(other.snapshot.hidden, 0);
  });

  test('(+) a row that started AFTER the removal shows (only new sessions bring a removed folder back); the old rows stay out', async () => {
    const soloKey = await keyOf('solo');
    const at = NOW - DAY; // OLD1 and NOTS are older; NEWER started an hour ago; RES was resumed 10 minutes ago
    const s = await run(hid({ groups: [[soloKey, at]] }));
    assert.deepEqual(ids(s).filter((id) => [OLD1, RES, NOTS, NEWER].includes(id)).sort(), [NEWER, RES].sort());
    assert.equal(group(s, 'solo').hidden, 2, 'OLD1 and NOTS');
  });

  test('(+) an entry stamped exactly at a row\'s start still hides it (the watermark compares with at-or-before)', async () => {
    const soloKey = await keyOf('solo');
    const exact = await run(hid({ groups: [[soloKey, NOW - HOUR]] }));
    assert.ok(!ids(exact).includes(NEWER), 'started exactly at the removal: hidden');
    const before = await run(hid({ groups: [[soloKey, NOW - HOUR - 1]] }));
    assert.ok(ids(before).includes(NEWER), 'started one millisecond after: shown');
  });

  test('(+) an old session resumed outside tmux (a new process) shows while it runs, and is out again once it ended', async () => {
    const soloKey = await keyOf('solo');
    const at = NOW - DAY;
    const running = await run(hid({ groups: [[soloKey, at]] }));
    const row = all(running).find((a) => a.id === RES);
    assert.ok(row && row.live && row.pane === null, 'live, no pane, started after the removal (the registry\'s process start)');
    const ended = await run(hid({ groups: [[soloKey, at]] }), { ps: PS_NO_RES });
    assert.ok(!ids(ended).includes(RES), 'an ended row\'s start is its transcript\'s first line, 5 days ago');
    assert.ok(ids(ended).includes(NEWER));
  });

  test('(+) a row with no start time falls back to its last activity', async () => {
    const soloKey = await keyOf('solo');
    const early = await run(hid({ groups: [[soloKey, NOW - 3 * DAY]] }));
    const row = all(early).find((a) => a.id === NOTS);
    assert.ok(row, 'last activity 2 days ago is after a removal 3 days ago');
    assert.equal(row.startedAt, null);
    const late = await run(hid({ groups: [[soloKey, NOW - DAY]] }));
    assert.ok(!ids(late).includes(NOTS), 'a removal one day ago is after it');
  });

  test('(+) a row hidden by id and by its folder counts once', async () => {
    const plainKey = await keyOf('plain');
    const s = await run(hid({ sessions: [[SID.other, NOW]], groups: [[plainKey, NOW]] }));
    assert.equal(s.snapshot.hidden, 1);
  });

  test('(\u2212) a folder entry for a nika project hides nothing (the entry is ignored while it is a project)', async () => {
    const plainKey = await keyOf('plain');
    const config = await withProjects([fx.plain]);
    const s = await run(hid({ groups: [[plainKey, NOW]] }), { config });
    assert.ok(ids(s).includes(SID.other));
    assert.equal(group(s, 'plain').hidden, 0);
    assert.equal(s.snapshot.hidden, 0);
    const back = await run(hid({ groups: [[plainKey, NOW]] }));
    assert.ok(!ids(back).includes(SID.other), 'removed from nika\'s projects again: the same entry applies again (documented residual)');
  });

  test('(\u2212) a config without env knows no project (it reads no file): a folder entry then hides the folder', async () => {
    const plainKey = await keyOf('plain');
    const s = await run(hid({ groups: [[plainKey, NOW]] }), { config: { ...fx.config } });
    assert.ok(!ids(s).includes(SID.other));
  });

  test('(\u2212) findSession ignores a folder entry (it takes no removals)', async () => {
    const hit = await findSession(SID.other, { config: fx.config, exec: fakeExec({ psLines: PS }), now: NOW });
    assert.equal(hit.agent.id, SID.other);
  });
});

describe('findGroup: one folder by key, whatever its age (fix round 1: Remove of a folder that ended 8 to 30 days ago)', () => {
  const OLDX = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  const OLDY = 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4';
  const fxg = makeFixture();
  after(() => cleanup(fxg));
  const dir = path.join(fxg.root, 'old-folder');
  fs.mkdirSync(dir, { recursive: true });
  const write = (sid, ageMs) => {
    const file = path.join(fxg.claudeDir, 'projects', slug(dir), `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stamp = new Date(NOW - ageMs).toISOString();
    fs.writeFileSync(file, jsonl([
      { type: 'user', cwd: dir, sessionId: sid, timestamp: stamp, message: { role: 'user', content: 'synthetic prompt' } },
      { type: 'assistant', cwd: dir, sessionId: sid, timestamp: stamp, message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [] } },
    ]));
    fs.utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
  };
  write(OLDX, 20 * DAY);
  write(OLDY, 9 * DAY);
  const wide = () => collect({ config: fxg.config, exec: fakeExec({ psLines: [] }), now: NOW, sinceMs: Infinity });
  const week = () => collect({ config: fxg.config, exec: fakeExec({ psLines: [] }), now: NOW, sinceMs: 7 * DAY });

  test('(+) a folder whose sessions all ended 9 and 20 days ago: the 7-day snapshot has no group for it, findGroup returns it with both rows (ended, nothing hidden)', async () => {
    const key = (await wide()).snapshot.groups.find((g) => g.label === 'old-folder').key;
    assert.ok(!(await week()).snapshot.groups.some((g) => g.key === key), 'out of the 7-day window');
    const g = await findGroup(key, { config: fxg.config, now: NOW });
    assert.equal(g.key, key);
    assert.equal(g.label, 'old-folder');
    assert.equal(g.root, dir);
    assert.deepEqual(g.agents.map((a) => a.id).sort(), [OLDX, OLDY].sort());
    assert.ok(g.agents.every((a) => !a.live && a.pane === null), 'the index-only read answers nothing live');
    assert.equal(g.hidden, 0, 'unfiltered: it takes no hidden maps');
  });

  test('(\u2212) a key nika has no folder for is null', async () => {
    assert.equal(await findGroup('d'.repeat(16), { config: fxg.config, now: NOW }), null);
  });

  test('(\u2212) when nika cannot read its transcript index, "no such folder" is a guess: it throws EINDEX', async () => {
    const config = { ...fxg.config, claudeDir: path.join(fxg.root, 'no-such-claude-dir') };
    await assert.rejects(findGroup('d'.repeat(16), { config, now: NOW }), { code: 'EINDEX' });
  });
});
