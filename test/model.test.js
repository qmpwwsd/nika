import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, cleanup, fakeExec, SID, NOW, jsonl } from './helpers.js';
import { collect, findSession, findSessions, modelLabel, shellQuote, bridgeUrl } from '../src/model.js';
import { parseSince } from '../src/config.js';
import { keyFor } from '../src/store.js';

const fx = makeFixture();
after(() => cleanup(fx));
const DAY = 86_400_000;

async function snap(sinceMs = 7 * DAY, exec = fakeExec()) {
  return collect({ config: fx.config, exec, now: NOW, sinceMs });
}

const all = (s) => s.snapshot.groups.flatMap((g) => g.agents);
const byId = (s, id) => all(s).find((a) => a.id === id);

describe('collect', () => {
  test('(+) live sessions carry registry status, pane, report name, model label and bridge url', async () => {
    const s = await snap();
    const a = byId(s, SID.busy);
    assert.equal(a.live, true);
    assert.equal(a.state, 'busy');
    assert.equal(a.name, 'build-7-1');
    assert.equal(a.title, 'Build story X');
    assert.equal(a.model, 'claude-sonnet-5-5');
    assert.equal(a.modelLabel, 'Sonnet 5.5');
    assert.equal(a.worktree, 'repo-wt');
    assert.equal(a.gitBranch, 'feat/x');
    assert.deepEqual(a.pane, { id: '%5', session: 'work', title: '[%5] build-7-1', command: 'zsh' });
    assert.equal(a.bridgeUrl, 'https://claude.ai/code/session_01AbCdEf');
    assert.deepEqual(a.report, { name: 'build-7-1', status: 'STATUS: RUNNING 7.1 build', rc: null, hasFile: true });
    assert.equal(a.resumeCmd, `cd ${shellQuote(fx.wt)} && claude --resume ${SID.busy}`);
  });

  test('(+) name priority: user-set registry name beats ai-title when no report or pane name', async () => {
    const s = await snap();
    const a = byId(s, SID.idle);
    assert.equal(a.name, 'planner');
    assert.equal(a.state, 'idle');
    assert.equal(a.modelLabel, 'Opus 5.5');
    assert.equal(a.pane.id, '%6');
  });

  test('(+) subagents nest under their parent; unfinished child of a live parent is running', async () => {
    const a = byId(await snap(), SID.busy);
    assert.equal(a.subagents.length, 2);
    assert.deepEqual(a.subagents.map((x) => [x.id, x.state]), [['bbb222', 'running'], ['aaa111', 'finished']]);
    assert.equal(a.subagents[0].modelLabel, 'Sonnet (latest)');
  });

  test('(−) dead pid becomes ended from its transcript; reused pid without transcript is dropped', async () => {
    const s = await snap();
    const dead = byId(s, SID.dead);
    assert.equal(dead.live, false);
    assert.equal(dead.state, 'ended');
    assert.equal(dead.pid, null);
    assert.equal(byId(s, SID.reused), undefined);
  });

  test('(+) ended agents use report name, truncated last prompt and rc', async () => {
    const a = byId(await snap(), SID.ended);
    assert.equal(a.name, 'review-old');
    assert.equal(a.lastPrompt.length, 200);
    assert.equal(a.report.rc, 0);
    assert.equal(a.bridgeUrl, 'https://claude.ai/code/session_01Zz');
  });

  test('(+) groups by repo (worktree folded in), ordered by latest activity; agents live-first', async () => {
    const s = await snap();
    assert.deepEqual(s.snapshot.groups.map((g) => g.label), ['repo', 'plain']);
    const repo = s.snapshot.groups[0];
    assert.deepEqual(repo.agents.map((a) => a.id), [SID.busy, SID.idle, SID.dead, SID.ended]);
    assert.deepEqual(repo.counts, { busy: 1, idle: 1, other: 0, ended: 2, total: 4 });
    assert.deepEqual(s.snapshot.counts, { busy: 1, idle: 1, other: 0, ended: 3, total: 5 });
  });

  test('(−) window excludes older ended agents but never live ones', async () => {
    const day = await snap(DAY / 2);
    assert.deepEqual(all(day).map((a) => a.id).sort(), [SID.busy, SID.idle].sort());
    const every = await snap(Infinity);
    assert.ok(byId(every, SID.old));
  });

  test('(+) sources report ok; report paths stay internal', async () => {
    const s = await snap();
    assert.deepEqual(s.snapshot.sources, { registry: 'ok', processes: 'ok', transcripts: 'ok', tmux: 'ok', reports: 'ok' });
    assert.equal(JSON.stringify(s.snapshot).includes('build-7-1.md'), false);
    assert.equal(s.reportPaths.get(SID.busy).endsWith('build-7-1.md'), true);
  });

  test('(+) a deleted worktree in a Claude scratchpad folds into the repo named by the scratchpad slug', async () => {
    const fx2 = makeFixture();
    try {
      const sid = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
      const slug = fx2.repo.replace(/[^A-Za-z0-9]/g, '-');
      const gone = path.join(fx2.tmpRoot, slug, 'some-session', 'scratchpad', 'wt-gone');
      const file = path.join(fx2.claudeDir, 'projects', gone.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, jsonl([{ type: 'user', cwd: gone, timestamp: new Date(NOW).toISOString() }]));
      const s = await collect({ config: fx2.config, exec: fakeExec(), now: NOW, sinceMs: Infinity });
      const repo = s.snapshot.groups.find((g) => g.root === fx2.repo);
      const a = repo.agents.find((x) => x.id === sid);
      assert.equal(a.worktree, 'wt-gone');
      assert.equal(s.snapshot.groups.some((g) => g.label === 'wt-gone'), false);
    } finally {
      cleanup(fx2);
    }
  });

  test('(−) N3: when two projects share the scratchpad slug, a deleted worktree is not folded into either', async () => {
    const fx2 = makeFixture();
    const twin = `${fx2.root}-repo`; // slug of <root>-repo equals slug of <root>/repo
    try {
      fs.mkdirSync(path.join(twin, '.git'), { recursive: true });
      fs.writeFileSync(path.join(twin, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      const twinSid = 'dededede-dede-4ede-8ede-dededededede';
      const twinFile = path.join(fx2.claudeDir, 'projects', twin.replace(/[^A-Za-z0-9]/g, '-'), `${twinSid}.jsonl`);
      fs.mkdirSync(path.dirname(twinFile), { recursive: true });
      fs.writeFileSync(twinFile, jsonl([{ type: 'user', cwd: twin, timestamp: new Date(NOW).toISOString() }]));
      const sid = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
      const slug = fx2.repo.replace(/[^A-Za-z0-9]/g, '-');
      const gone = path.join(fx2.tmpRoot, slug, 'some-session', 'scratchpad', 'wt-gone');
      const file = path.join(fx2.claudeDir, 'projects', gone.replace(/[^A-Za-z0-9]/g, '-'), `${sid}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, jsonl([{ type: 'user', cwd: gone, timestamp: new Date(NOW).toISOString() }]));
      const s = await collect({ config: fx2.config, exec: fakeExec(), now: NOW, sinceMs: Infinity });
      for (const key of [fx2.repo, twin]) {
        const g = s.snapshot.groups.find((x) => x.root === key);
        assert.equal(g?.agents.some((x) => x.id === sid) ?? false, false, key);
      }
    } finally {
      fs.rmSync(twin, { recursive: true, force: true });
      cleanup(fx2);
    }
  });

  test('(−) 0.1.1: a title-only stub transcript that is not live is not listed and makes no (unknown) group', async () => {
    const fx2 = makeFixture();
    try {
      const stub = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
      const file = path.join(fx2.claudeDir, 'projects', '-somewhere-else', `${stub}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, jsonl([{ type: 'ai-title', sessionId: stub, aiTitle: 'Stub title' }]));
      const s = await collect({ config: fx2.config, exec: fakeExec(), now: NOW, sinceMs: Infinity });
      assert.equal(s.snapshot.groups.flatMap((g) => g.agents).some((a) => a.id === stub), false);
      assert.equal(s.snapshot.groups.some((g) => g.label === '(unknown)'), false);
    } finally {
      cleanup(fx2);
    }
  });

  test('(+) 0.1.1: a live session whose transcript is still title-only stays listed', async () => {
    const fx2 = makeFixture();
    try {
      const file = path.join(fx2.claudeDir, 'projects', fx2.repo.replace(/[^A-Za-z0-9]/g, '-'), `${SID.idle}.jsonl`);
      fs.writeFileSync(file, jsonl([{ type: 'ai-title', sessionId: SID.idle, aiTitle: 'Stub title' }]));
      const s = await collect({ config: fx2.config, exec: fakeExec(), now: NOW, sinceMs: Infinity });
      const a = s.snapshot.groups.flatMap((g) => g.agents).find((x) => x.id === SID.idle);
      assert.equal(a?.live, true);
      assert.equal(a.cwd, fx2.repo);
    } finally {
      cleanup(fx2);
    }
  });

  test('(−) tmux unavailable: agents still listed, pane null, source shows the error', async () => {
    const s = await snap(7 * DAY, fakeExec({ tmuxError: 'ENOENT' }));
    assert.equal(byId(s, SID.busy).pane, null);
    assert.equal(byId(s, SID.busy).name, 'build-7-1');
    assert.match(s.snapshot.sources.tmux, /tmux/);
  });
});

describe('collect: key, role, attention (0.2 UI fields)', () => {
  const AGENT_KEYS = ['attention', 'bridgeUrl', 'children', 'context', 'cwd', 'depth', 'gitBranch', 'id', 'lastActivity', 'lastPrompt', 'live', 'model', 'modelLabel', 'name', 'pane',
    'parent', 'pid', 'report', 'resumeCmd', 'role', 'startedAt', 'state', 'subagents', 'title', 'version', 'worktree'];
  const GROUP_KEYS = ['agents', 'counts', 'key', 'label', 'lastActivity', 'root'];
  const PANES = (role5, role6) => [`%5\twork\t1\t[%5] build-7-1\tzsh\t${role5}`, `%6\twork\t2\tMacBook.local\tclaude\t${role6}`];

  test('(+) every group has key = keyFor(repo root): 16 hex, one per group, worktrees share the repo key', async () => {
    const s = await snap();
    const repo = s.snapshot.groups.find((g) => g.label === 'repo');
    const plain = s.snapshot.groups.find((g) => g.label === 'plain');
    assert.equal(repo.key, keyFor(fx.repo));
    assert.equal(plain.key, keyFor(fx.plain));
    assert.equal(repo.agents.some((a) => a.worktree === 'repo-wt'), true, 'the worktree agent sits in the repo group');
    for (const g of s.snapshot.groups) assert.match(g.key, /^[0-9a-f]{16}$/);
    assert.equal(new Set(s.snapshot.groups.map((g) => g.key)).size, s.snapshot.groups.length);
  });

  test('(−) a group without a repository root still gets a 16-hex key', async () => {
    const fx2 = makeFixture();
    try {
      const sid = 'abababab-abab-4bab-8bab-abababababab';
      fs.writeFileSync(path.join(fx2.claudeDir, 'sessions', '106.json'), JSON.stringify({ pid: 106, sessionId: sid, status: 'busy', procStart: 'Sat Nov  7 18:57:14 2026', updatedAt: NOW }));
      const ps = ['  101 Sat Nov  7 18:57:14 2026', '  106 Sat Nov  7 18:57:14 2026'];
      const s = await collect({ config: fx2.config, exec: fakeExec({ psLines: ps }), now: NOW, sinceMs: DAY });
      const g = s.snapshot.groups.find((x) => x.agents.some((a) => a.id === sid));
      assert.equal(g.label, '(unknown)');
      assert.equal(g.root, null);
      assert.match(g.key, /^[0-9a-f]{16}$/);
    } finally {
      cleanup(fx2);
    }
  });

  test('(+) role comes from the pane option: orchestrator, agent; none for panes without it', async () => {
    const s = await snap(7 * DAY, fakeExec({ tmuxLines: PANES('orchestrator', 'agent') }));
    assert.equal(byId(s, SID.busy).role, 'orchestrator');
    assert.equal(byId(s, SID.idle).role, 'agent');
    const plain = await snap();
    assert.equal(byId(plain, SID.busy).role, null);
    assert.equal(byId(plain, SID.idle).role, null);
  });

  test('(−) role is null for an unknown pane value, an ended agent, and when tmux is unavailable', async () => {
    const odd = await snap(7 * DAY, fakeExec({ tmuxLines: PANES('root', 'ORCHESTRATOR') }));
    assert.equal(byId(odd, SID.busy).role, null);
    assert.equal(byId(odd, SID.idle).role, null);
    assert.equal(byId(odd, SID.ended).role, null);
    const none = await snap(7 * DAY, fakeExec({ tmuxError: 'ENOENT' }));
    assert.equal(byId(none, SID.busy).role, null);
  });

  test('(+) attention = the cleaned registry status (max 80) of a live agent that is neither busy nor idle', async () => {
    const fx2 = makeFixture();
    try {
      const mk = (pid, d, status, extra = {}) => {
        const sid = `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
        fs.writeFileSync(path.join(fx2.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: fx2.plain, status, procStart: 'Sat Nov  7 18:57:14 2026', updatedAt: NOW, ...extra }));
        return sid;
      };
      const waiting = mk(110, 'a', 'waiting for permission');
      const long = mk(111, 'b', `needs\u001b[31m input ${'x'.repeat(120)}`);
      const noStatus = mk(112, 'c', undefined);
      const emptyStatus = mk(113, 'd', '   ');
      const ps = [101, 102, 110, 111, 112, 113].map((p) => `  ${p} Sat Nov  7 18:57:14 2026`);
      const s = await collect({ config: fx2.config, exec: fakeExec({ psLines: ps }), now: NOW, sinceMs: DAY });
      const a = (id) => s.snapshot.groups.flatMap((g) => g.agents).find((x) => x.id === id);
      assert.equal(a(waiting).state, 'waiting for permission');
      assert.equal(a(waiting).attention, 'waiting for permission');
      assert.equal(a(long).attention.length, 80);
      assert.doesNotMatch(a(long).attention, /\u001b/);
      assert.equal(a(long).state.length, 32);
      assert.equal(a(noStatus).state, 'unknown');
      assert.equal(a(noStatus).attention, null);
      assert.equal(a(emptyStatus).attention, null);
    } finally {
      cleanup(fx2);
    }
  });

  // Claude Code 2.1.321 writes busy, shell, idle and waiting; `shell` = the turn is over and a background shell still runs (Claude lists it as Working)
  const withStatus = async (status) => {
    const fx2 = makeFixture();
    try {
      const sid = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
      const ps = ['  101 Sat Nov  7 18:57:14 2026', '  102 Sat Nov  7 18:57:14 2026'];
      const base = await collect({ config: fx2.config, exec: fakeExec({ psLines: ps }), now: NOW, sinceMs: DAY });
      fs.writeFileSync(path.join(fx2.claudeDir, 'sessions', '114.json'), JSON.stringify({ pid: 114, sessionId: sid, cwd: fx2.plain, status, procStart: 'Sat Nov  7 18:57:14 2026', updatedAt: NOW }));
      const s = await collect({ config: fx2.config, exec: fakeExec({ psLines: [...ps, '  114 Sat Nov  7 18:57:14 2026'] }), now: NOW, sinceMs: DAY });
      const agent = s.snapshot.groups.flatMap((g) => g.agents).find((x) => x.id === sid);
      const delta = (k) => s.snapshot.counts[k] - base.snapshot.counts[k];
      return { agent, delta, group: s.snapshot.groups.find((g) => g.agents.includes(agent)) };
    } finally {
      cleanup(fx2);
    }
  };

  test('(+) registry shell reads as busy: state busy, no attention, counted as busy and not as other', async () => {
    const { agent, delta, group } = await withStatus('shell');
    assert.equal(agent.live, true);
    assert.equal(agent.state, 'busy');
    assert.equal(agent.attention, null);
    assert.deepEqual([delta('busy'), delta('other'), delta('idle'), delta('total')], [1, 0, 0, 1]);
    assert.equal(group.counts.other, 0);
  });

  test('(−) waiting and an unknown status still need you: state as written, attention set, counted as other', async () => {
    for (const status of ['waiting', 'paused', 'shell2']) {
      const { agent, delta } = await withStatus(status);
      assert.equal(agent.state, status);
      assert.equal(agent.attention, status);
      assert.deepEqual([delta('busy'), delta('other')], [0, 1], status);
    }
  });

  test('(−) attention is null for busy, idle and ended agents', async () => {
    const s = await snap(Infinity);
    for (const id of [SID.busy, SID.idle, SID.dead, SID.ended, SID.old, SID.other]) assert.equal(byId(s, id).attention, null, id);
  });

  test('(−) the agent and group objects carry exactly the documented keys; no registry secret and no new path reaches the snapshot', async () => {
    const fx2 = makeFixture();
    try {
      const sid = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
      fs.writeFileSync(path.join(fx2.claudeDir, 'sessions', '107.json'), JSON.stringify({
        pid: 107, sessionId: sid, cwd: fx2.plain, status: 'waiting', procStart: 'Sat Nov  7 18:57:14 2026', updatedAt: NOW,
        env: { TOKEN: 'SECRET-ENV-VALUE' }, apiKeyHelper: 'SECRET-HELPER', transcriptPath: '/nowhere/SECRET-PATH.jsonl', waitingFor: 'SECRET-PROMPT-TEXT',
      }));
      const ps = ['  101 Sat Nov  7 18:57:14 2026', '  107 Sat Nov  7 18:57:14 2026'];
      const s = await collect({ config: fx2.config, exec: fakeExec({ psLines: ps, tmuxLines: PANES('agent', '') }), now: NOW, sinceMs: DAY });
      const agents = s.snapshot.groups.flatMap((g) => g.agents);
      assert.ok(agents.some((a) => a.attention === 'waiting'));
      assert.equal(agents.find((a) => a.id === sid).role, null, 'a live agent without a pane has no role');
      for (const a of agents) assert.deepEqual(Object.keys(a).sort(), AGENT_KEYS, a.id);
      for (const g of s.snapshot.groups) assert.deepEqual(Object.keys(g).sort(), GROUP_KEYS, g.label);
      assert.equal(/SECRET/.test(JSON.stringify(s.snapshot)), false);
    } finally {
      cleanup(fx2);
    }
  });
});

describe('collect: parent, depth and children (0.4, contract C6)', () => {
  const K = '0123456789abcdef';
  const ID = (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
  const tree = async (rows, extra = []) => {
    // rows: [letter, pane, role, tag, depth, parent, extra registry fields]; one live session per row, in a plain folder
    const fx2 = makeFixture();
    try {
      for (const [i, [c, pane]] of rows.entries()) {
        fs.writeFileSync(path.join(fx2.claudeDir, 'sessions', `${120 + i}.json`), JSON.stringify({
          pid: 120 + i, sessionId: ID(c), cwd: fx2.plain, status: 'idle', procStart: 'Sat Nov  7 18:57:14 2026', updatedAt: NOW, tmux: `work:@1.${pane}`,
        }));
      }
      const tmuxLines = rows.map(([c, pane, role, tag, depth, parent]) => `${pane}\twork\t1\t[${pane}] n-${c}\tnode\t${role}\t${tag}\t${depth}\t${parent}`).concat(extra);
      const ps = rows.map((_, i) => `  ${120 + i} Sat Nov  7 18:57:14 2026`);
      const s = await collect({ config: fx2.config, exec: fakeExec({ psLines: ps, tmuxLines }), now: NOW, sinceMs: DAY });
      return (c) => s.snapshot.groups.flatMap((g) => g.agents).find((x) => x.id === ID(c));
    } finally {
      cleanup(fx2);
    }
  };
  const view = (a) => [a.parent, a.depth, [...a.children].sort()];

  test('(+) parent (the parent session when it maps to one, else the pane), depth and children come from the pane tags', async () => {
    const a = await tree([
      ['a', '%1', 'orchestrator', `${K}/orchestrator`, '1', ''],
      ['b', '%2', 'sub-orchestrator', `${K}/planner`, '2', '%1'],
      ['c', '%3', 'agent', `${K}/build-1`, '3', '%2'],
      ['d', '%4', 'agent', `${K}/build-2`, '2', '%1'],
      ['e', '%5', 'agent', `${K}/build-3`, '1', ''],
      ['f', '%6', 'agent', `${K}/build-4`, '2', '%99'], // its parent pane is not a session nika knows
      ['9', '%7', '', '', '', ''], // a plain claude session
    ]);
    assert.deepEqual(view(a('a')), [null, 1, [ID('b'), ID('d')]]);
    assert.deepEqual(view(a('b')), [ID('a'), 2, [ID('c')]]);
    assert.deepEqual(view(a('c')), [ID('b'), 3, []]);
    assert.deepEqual(view(a('d')), [ID('a'), 2, []]);
    assert.deepEqual(view(a('e')), [null, 1, []]);
    assert.deepEqual(view(a('f')), ['%99', 2, []]);
    assert.deepEqual(view(a('9')), [null, 1, []]);
    assert.equal(a('b').role, 'sub-orchestrator');
  });

  test('(−) bad tags are ignored: a bad parent is no parent (so a root, depth 1); only agents and sub-orchestrators have a parent', async () => {
    const a = await tree([
      ['a', '%1', 'orchestrator', `${K}/orchestrator`, '3', '%2'], // a main orchestrator is depth 1 and nobody's child
      ['b', '%2', 'agent', `${K}/x`, '7', 'nope'],
      ['c', '%3', 'agent', `${K}/y`, '2', '%1 '],
      ['d', '%4', '', '', '2', '%1'], // no nika role: the tags beside it mean nothing
      ['e', '%5', 'sub-orchestrator', `${K}/z`, '', ''], // no parent: a root, whatever it is called
      ['f', '%6', 'agent', `${K}/w`, '2', '%5'],
    ]);
    assert.deepEqual(view(a('a')), [null, 1, []]);
    assert.deepEqual(view(a('b')), [null, 1, []]);
    assert.deepEqual(view(a('c')), [null, 1, []]); // the depth tag parses, the parent does not: nothing above it
    assert.deepEqual(view(a('d')), [null, 1, []]);
    assert.deepEqual(view(a('e')), [null, 1, [ID('f')]]);
    assert.deepEqual(view(a('f')), [ID('e'), 2, []]);
  });

  test('(−) a self-parent and a cycle are cut: every member becomes a root at depth 1 with no children from the loop', async () => {
    const a = await tree([
      ['a', '%1', 'agent', `${K}/a`, '2', '%1'],
      ['b', '%2', 'sub-orchestrator', `${K}/b`, '2', '%3'],
      ['c', '%3', 'sub-orchestrator', `${K}/c`, '2', '%2'],
      ['d', '%4', 'agent', `${K}/d`, '3', '%2'], // hangs off the loop, not part of it
    ]);
    assert.deepEqual(view(a('a')), [null, 1, []]);
    assert.deepEqual(view(a('b')), [null, 1, [ID('d')]]);
    assert.deepEqual(view(a('c')), [null, 1, []]);
    assert.deepEqual(view(a('d')), [ID('b'), 2, []]); // one step below a root, whatever its own tag says
  });

  test('(−) depth comes from the place in the parent chain (root 1, at most 3), never from the agent\'s own @nika-depth', async () => {
    const a = await tree([
      ['a', '%1', 'orchestrator', `${K}/orchestrator`, '1', ''],
      ['b', '%2', 'sub-orchestrator', `${K}/planner`, '1', '%1'], // forged: claims depth 1
      ['c', '%3', 'agent', `${K}/build-1`, '1', '%2'], // forged: a depth-3 agent claims depth 1
      ['d', '%4', 'agent', `${K}/build-2`, '3', ''], // forged: a root claims depth 3
      ['e', '%5', 'agent', `${K}/build-3`, '1', '%99'], // its parent is a pane nika has no session for: one step below it
      ['f', '%6', 'agent', `${K}/build-4`, '1', '%3'], // below an agent (nika refuses to start one; a forged tag could say so): capped at 3
    ]);
    assert.deepEqual(view(a('a')), [null, 1, [ID('b')]]);
    assert.deepEqual(view(a('b')), [ID('a'), 2, [ID('c')]]);
    assert.deepEqual(view(a('c')), [ID('b'), 3, [ID('f')]]);
    assert.deepEqual(view(a('d')), [null, 1, []]);
    assert.deepEqual(view(a('e')), ['%99', 2, []]);
    assert.deepEqual(view(a('f')), [ID('c'), 3, []]);
  });

  test('(−) ended agents carry no parent and no depth, and children []; so does a live agent when tmux is unavailable', async () => {
    const s = await snap(Infinity);
    for (const id of [SID.dead, SID.ended, SID.old, SID.other]) {
      const a = byId(s, id);
      assert.deepEqual([a.live, a.parent, a.depth, a.children], [false, null, null, []], id);
    }
    const none = await snap(7 * DAY, fakeExec({ tmuxError: 'ENOENT' }));
    assert.deepEqual([byId(none, SID.busy).parent, byId(none, SID.busy).depth, byId(none, SID.busy).children], [null, 1, []]);
  });
});

describe('collect: context (0.4 O5, contract C6)', () => {
  const slug = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
  const usage = (total) => ({ input_tokens: total - 300, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 7 });
  const PANES = (role5, role6) => [`%5\twork\t1\t[%5] build-7-1\tzsh\t${role5}`, `%6\twork\t2\tMacBook.local\tclaude\t${role6}`];
  const SETTING = { enabled: true, pct: 80, window: 400000 };
  /**
   * One pass over a fresh machine: `last` = [session id, tokens, model] lines appended to the transcripts, `compaction` = the
   * setting in nika's own config.json (null: no file), `roles` = the nika role tag of the panes %5 (SID.busy) and %6 (SID.idle).
   */
  async function run({ last = [], compaction = SETTING, roles = ['', ''], config = (c) => c, sinceMs = 7 * DAY } = {}) {
    const fx2 = makeFixture();
    try {
      const where = { [SID.busy]: fx2.wt, [SID.idle]: fx2.repo, [SID.dead]: fx2.repo, [SID.ended]: fx2.repo };
      for (const [sid, tokens, model] of last) {
        fs.appendFileSync(path.join(fx2.claudeDir, 'projects', slug(where[sid]), `${sid}.jsonl`), jsonl([{ type: 'assistant', message: { model, usage: usage(tokens) } }]));
      }
      const cfgRoot = path.join(fx2.root, 'cfg');
      if (compaction !== null) {
        fs.mkdirSync(path.join(cfgRoot, 'nika'), { recursive: true });
        fs.writeFileSync(path.join(cfgRoot, 'nika', 'config.json'), JSON.stringify({ compaction }), { mode: 0o600 });
      }
      const s = await collect({ config: config({ ...fx2.config, env: { NIKA_CONFIG_DIR: cfgRoot } }), exec: fakeExec({ tmuxLines: PANES(...roles) }), now: NOW, sinceMs });
      return (id) => s.snapshot.groups.flatMap((g) => g.agents).find((a) => a.id === id);
    } finally {
      cleanup(fx2);
    }
  }

  test('(+) on, a session nika started (its pane carries a role): the window is the setting\'s (400k on a 1M model), compactAt is the launch threshold, pct is tokens / window', async () => {
    const get = await run({ last: [[SID.busy, 312000, 'claude-sonnet-5-5']], roles: ['orchestrator', ''] });
    assert.deepEqual(get(SID.busy).context, { tokens: 312000, window: 400000, compactAt: 320000, pct: 78, compaction: 'on' });
  });

  test('(+) every nika role counts as started: orchestrator, sub-orchestrator and agent', async () => {
    for (const role of ['orchestrator', 'sub-orchestrator', 'agent']) {
      const get = await run({ last: [[SID.idle, 1000, 'claude-opus-5-5']], roles: ['', role] });
      assert.equal(get(SID.idle).context.compaction, 'on', role);
      assert.equal(get(SID.idle).context.compactAt, 320000, role);
    }
  });

  test('(+) pct is rounded to one decimal and not capped', async () => {
    const get = await run({ last: [[SID.busy, 123456, 'claude-sonnet-5-5'], [SID.idle, 500000, 'claude-opus-5-5']], roles: ['agent', 'agent'] });
    assert.equal(get(SID.busy).context.pct, 30.9);
    assert.equal(get(SID.idle).context.pct, 125);
  });

  test('(+) off: the window is the model\'s own, compactAt is null, compaction is "off" (for any session)', async () => {
    const get = await run({ last: [[SID.busy, 312000, 'claude-sonnet-5-5'], [SID.idle, 100000, 'claude-haiku-4-5']], compaction: { ...SETTING, enabled: false }, roles: ['agent', ''] });
    assert.deepEqual(get(SID.busy).context, { tokens: 312000, window: 1000000, compactAt: null, pct: 31.2, compaction: 'off' });
    assert.deepEqual(get(SID.idle).context, { tokens: 100000, window: 200000, compactAt: null, pct: 50, compaction: 'off' });
  });

  test('(+) not started by nika (no role tag, or no pane): the same window, compactAt null, compaction "none"', async () => {
    const get = await run({ last: [[SID.busy, 312000, 'claude-sonnet-5-5'], [SID.idle, 312000, 'claude-sonnet-5-5']], roles: ['', 'bogus'] });
    for (const id of [SID.busy, SID.idle]) assert.deepEqual(get(id).context, { tokens: 312000, window: 400000, compactAt: null, pct: 78, compaction: 'none' }, id);
  });

  test('(+) an ended session gets the same computation with compaction "none"', async () => {
    const get = await run({ last: [[SID.dead, 312000, 'claude-sonnet-5-5']], roles: ['agent', 'agent'] });
    assert.equal(get(SID.dead).live, false);
    assert.deepEqual(get(SID.dead).context, { tokens: 312000, window: 400000, compactAt: null, pct: 78, compaction: 'none' });
  });

  test('(+) the setting\'s window is cut to the model\'s: "model" gives 1M on a 1M model and 200k on a 200k one; 1M on a 200k model gives 200k', async () => {
    const get = await run({ last: [[SID.busy, 100000, 'claude-sonnet-5-5'], [SID.idle, 100000, 'claude-sonnet-4-6']], compaction: { ...SETTING, window: 'model' }, roles: ['agent', 'agent'] });
    assert.deepEqual([get(SID.busy).context.window, get(SID.busy).context.compactAt], [1000000, 800000]);
    assert.deepEqual([get(SID.idle).context.window, get(SID.idle).context.compactAt], [200000, 160000]);
    const big = await run({ last: [[SID.idle, 100000, 'claude-sonnet-4-6']], compaction: { ...SETTING, window: 1000000 }, roles: ['agent', 'agent'] });
    assert.equal(big(SID.idle).context.window, 200000);
  });

  test('(+) an unknown model id counts as 200k', async () => {
    const get = await run({ last: [[SID.busy, 100000, 'claude-future-9']], roles: ['agent', ''] });
    assert.deepEqual(get(SID.busy).context, { tokens: 100000, window: 200000, compactAt: 160000, pct: 50, compaction: 'on' });
  });

  test('(+) a dated model id (as transcripts record it) uses the catalog window of its undated id', async () => {
    const get = await run({ last: [[SID.busy, 100000, 'claude-sonnet-5-5-20260101'], [SID.idle, 100000, 'claude-sonnet-4-6-20260101']], compaction: { ...SETTING, window: 'model' }, roles: ['agent', 'agent'] });
    assert.deepEqual([get(SID.busy).context.window, get(SID.busy).context.compactAt, get(SID.busy).context.pct], [1000000, 800000, 10]);
    assert.deepEqual([get(SID.idle).context.window, get(SID.idle).context.compactAt, get(SID.idle).context.pct], [200000, 160000, 50]);
    const off = await run({ last: [[SID.busy, 100000, 'claude-sonnet-5-5-20260101']], compaction: { ...SETTING, enabled: false } });
    assert.equal(off(SID.busy).context.window, 1000000);
  });

  test('(−) no model on the usage entry: the window, compactAt and pct are null (nowin), the tokens stay', async () => {
    const get = await run({ last: [[SID.busy, 124000, 'not a model id']], roles: ['agent', ''] });
    assert.deepEqual(get(SID.busy).context, { tokens: 124000, window: null, compactAt: null, pct: null, compaction: 'on' });
    const off = await run({ last: [[SID.busy, 124000, 'not a model id']], compaction: { ...SETTING, enabled: false } });
    assert.deepEqual(off(SID.busy).context, { tokens: 124000, window: null, compactAt: null, pct: null, compaction: 'off' });
  });

  test('(−) no usage in the transcript: context is null (the fixtures\' own assistant lines carry none)', async () => {
    const get = await run();
    for (const id of [SID.busy, SID.idle, SID.dead, SID.ended]) assert.equal(get(id).context, null, id);
  });

  test('(+) the setting is read from nika\'s config.json at every pass: a change shows at the next one', async () => {
    const on = await run({ last: [[SID.busy, 100000, 'claude-sonnet-5-5']], compaction: { enabled: true, pct: 50, window: 1000000 }, roles: ['agent', ''] });
    assert.deepEqual([on(SID.busy).context.window, on(SID.busy).context.compactAt], [1000000, 500000]);
    const off = await run({ last: [[SID.busy, 100000, 'claude-sonnet-5-5']], compaction: { enabled: false, pct: 50, window: 1000000 }, roles: ['agent', ''] });
    assert.equal(off(SID.busy).context.compaction, 'off');
  });

  test('(−) a missing or garbage config.json gives the defaults (on, 80 %, 400k); a bad value is dropped by loadConfig, not trusted', async () => {
    const last = [[SID.busy, 100000, 'claude-sonnet-5-5']];
    for (const compaction of [null, { enabled: 'yes', pct: 5, window: 123 }, 'text', []]) {
      const get = await run({ last, compaction, roles: ['agent', ''] });
      assert.deepEqual(get(SID.busy).context, { tokens: 100000, window: 400000, compactAt: 320000, pct: 25, compaction: 'on' }, JSON.stringify(compaction));
    }
  });

  test('(−) a config without env (tests, 0.1 callers) reads no file and uses the defaults', async () => {
    const fx2 = makeFixture();
    try {
      fs.appendFileSync(path.join(fx2.claudeDir, 'projects', slug(fx2.wt), `${SID.busy}.jsonl`), jsonl([{ type: 'assistant', message: { model: 'claude-sonnet-5-5', usage: usage(100000) } }]));
      const s = await collect({ config: fx2.config, exec: fakeExec(), now: NOW, sinceMs: DAY });
      const a = s.snapshot.groups.flatMap((g) => g.agents).find((x) => x.id === SID.busy);
      assert.deepEqual(a.context, { tokens: 100000, window: 400000, compactAt: null, pct: 25, compaction: 'none' });
    } finally {
      cleanup(fx2);
    }
  });

  test('(−) context holds numbers and the state word only: no model id, no text', async () => {
    const get = await run({ last: [[SID.busy, 1000, 'claude-sonnet-5-5']], roles: ['agent', ''] });
    assert.deepEqual(Object.keys(get(SID.busy).context).sort(), ['compactAt', 'compaction', 'pct', 'tokens', 'window']);
    assert.equal(/claude-sonnet/.test(JSON.stringify(get(SID.busy).context)), false);
  });

  test('(+) findSession and findSessions carry context too (an ended session by id)', async () => {
    const fx2 = makeFixture();
    try {
      fs.appendFileSync(path.join(fx2.claudeDir, 'projects', slug(fx2.repo), `${SID.old}.jsonl`), jsonl([{ type: 'assistant', message: { model: 'claude-opus-5-5', usage: usage(50000) } }]));
      const config = { ...fx2.config, env: { NIKA_CONFIG_DIR: path.join(fx2.root, 'none') } };
      const one = await findSession(SID.old, { config, exec: fakeExec(), now: NOW });
      assert.deepEqual(one.agent.context, { tokens: 50000, window: 400000, compactAt: null, pct: 12.5, compaction: 'none' });
      const many = await findSessions([SID.old], { config, now: NOW });
      assert.deepEqual(many.get(SID.old).agent.context, one.agent.context);
    } finally {
      cleanup(fx2);
    }
  });
});

describe('helpers', () => {
  test('(+) modelLabel turns ids into short labels', () => {
    assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
    assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
    assert.equal(modelLabel('sonnet'), 'Sonnet (latest)');
  });

  test('(−) modelLabel keeps unknown ids and returns null for empty', () => {
    assert.equal(modelLabel('weird-model'), 'weird-model');
    assert.equal(modelLabel(null), null);
  });

  test('(+) shellQuote survives spaces and single quotes', () => {
    assert.equal(shellQuote("/a b/it's"), "'/a b/it'\\''s'");
  });

  test('(+/−) bridgeUrl normalises cse_/session_ ids and rejects anything else', () => {
    assert.equal(bridgeUrl('cse_01Ab'), 'https://claude.ai/code/session_01Ab');
    assert.equal(bridgeUrl('session_01Ab'), 'https://claude.ai/code/session_01Ab');
    assert.equal(bridgeUrl('session_"><script>'), null);
    assert.equal(bridgeUrl(null), null);
  });

  test('(+) parseSince accepts 24h, 7d, 30d, all', () => {
    assert.equal(parseSince('24h'), DAY);
    assert.equal(parseSince('7d'), 7 * DAY);
    assert.equal(parseSince('30d'), 30 * DAY);
    assert.equal(parseSince('all'), Infinity);
  });

  test('(−) parseSince rejects junk, zero and absurd windows', () => {
    for (const bad of ['abc', '0d', '7x', '99999d', '', '-1d', '7d;rm']) assert.equal(parseSince(bad), null, bad);
  });
});

describe('collect with include, and findSession (one session by id, whatever its age)', () => {
  const NOBODY = '99999999-9999-4999-8999-999999999999';
  const ofSession = (id, over = {}) => findSession(id, { config: fx.config, exec: fakeExec(), now: NOW, ...over });

  test('(+) include adds a session outside the time window; without it the session is not listed', async () => {
    assert.equal(byId(await snap(DAY), SID.old), undefined, '20 days old, window of one day');
    const s = await collect({ config: fx.config, exec: fakeExec(), now: NOW, sinceMs: DAY, include: [SID.old] });
    const a = byId(s, SID.old);
    assert.equal(a.live, false);
    assert.equal(a.state, 'ended');
    assert.equal(a.name, 'Ancient');
  });

  test('(+) findSession returns the agent and the group of its project, for an ended session older than any window', async () => {
    const hit = await ofSession(SID.old);
    assert.equal(hit.agent.id, SID.old);
    assert.equal(hit.agent.live, false);
    assert.equal(hit.group.key, keyFor(fx.repo));
    assert.equal(hit.group.root, fx.repo);
    assert.ok(hit.group.agents.includes(hit.agent));
  });

  test('(+) findSession finds a live session with its pane, and the group lists the other live sessions of the project but no old ones', async () => {
    const hit = await ofSession(SID.idle);
    assert.deepEqual([hit.agent.live, hit.agent.state, hit.agent.pane.id], [true, 'idle', '%6']);
    assert.deepEqual(hit.group.agents.map((a) => a.id).sort(), [SID.busy, SID.idle].sort(), 'the live sessions of the project (a worktree folds in) and nothing older: the window is zero');
    const other = await ofSession(SID.old);
    assert.ok(other.group.agents.some((a) => a.id === SID.idle), 'a live session of the project is in its group');
    assert.ok(!other.group.agents.some((a) => a.id === SID.ended), 'an old ended one is not');
  });

  test('(−) an id nika has no transcript or live registry entry for is null', async () => {
    assert.equal(await ofSession(NOBODY), null);
    assert.equal(await ofSession('../../etc/passwd'), null, 'the id is only ever a lookup key, never a path');
  });

  test('(−) a dead registry entry without a transcript is not a session either', async () => {
    assert.equal(await ofSession(SID.reused), null);
  });

  test('(−) when nika cannot read its transcript index, "not found" is a guess: findSession throws instead of answering null', async () => {
    const config = { ...fx.config, claudeDir: path.join(fx.root, 'no-such-claude-dir') };
    await assert.rejects(ofSession(SID.old, { config }), { code: 'EINDEX' });
  });
});

describe('findSessions (several ended sessions by id, one index walk, no ps and no tmux)', () => {
  const NOBODY = '99999999-9999-4999-8999-999999999999';
  const calls = [];
  const spy = (...args) => { calls.push(args); return fakeExec()(...args); };
  const ofIds = (ids, over = {}) => { calls.length = 0; return findSessions(ids, { config: fx.config, now: NOW, ...over }); };

  test('(+) every id nika has a transcript for comes back with its agent and its project\'s group, whatever its age; an id it has none for is left out', async () => {
    const hits = await ofIds([SID.old, SID.ended, NOBODY]);
    assert.deepEqual([...hits.keys()].sort(), [SID.old, SID.ended].sort());
    const old = hits.get(SID.old);
    assert.deepEqual([old.agent.live, old.agent.state, old.agent.name, old.agent.pane], [false, 'ended', 'Ancient', null]);
    assert.equal(old.group.key, keyFor(fx.repo));
    assert.equal(old.group.root, fx.repo);
    assert.equal(hits.get(SID.ended).group.key, keyFor(fx.repo));
  });

  test('(+) it reads the transcript index only: no registry, no ps, no tmux (it never answers "live": its callers ask for ids the live snapshot lacks)', async () => {
    const hits = await ofIds([SID.idle], { exec: spy });
    assert.deepEqual(calls, [], 'no subprocess');
    assert.equal(hits.get(SID.idle).agent.live, false);
    assert.equal(hits.get(SID.idle).agent.pane, null);
  });

  test('(+) no ids means nothing is read', async () => {
    const config = { ...fx.config, claudeDir: path.join(fx.root, 'no-such-claude-dir') };
    assert.equal((await ofIds([], { config })).size, 0, 'an unreadable index does not matter when nothing is asked');
  });

  test('(−) an id that is not a session id is only a lookup key: it is left out, never opened as a path', async () => {
    const hits = await ofIds(['../../etc/passwd', '', SID.old]);
    assert.deepEqual([...hits.keys()], [SID.old]);
  });

  test('(−) when nika cannot read its transcript index, "left out" would be a guess: it throws EINDEX', async () => {
    const config = { ...fx.config, claudeDir: path.join(fx.root, 'no-such-claude-dir') };
    await assert.rejects(ofIds([SID.old, NOBODY], { config }), { code: 'EINDEX' });
  });
});
