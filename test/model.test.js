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
  const AGENT_KEYS = ['attention', 'bridgeUrl', 'children', 'cwd', 'depth', 'gitBranch', 'id', 'lastActivity', 'lastPrompt', 'live', 'model', 'modelLabel', 'name', 'pane',
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
