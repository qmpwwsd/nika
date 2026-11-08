import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, cleanup, fakeExec, SID, NOW, jsonl } from './helpers.js';
import { collect, modelLabel, shellQuote, bridgeUrl } from '../src/model.js';
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
    assert.equal(a.subagents[0].modelLabel, 'Sonnet');
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
  const AGENT_KEYS = ['attention', 'bridgeUrl', 'cwd', 'gitBranch', 'id', 'lastActivity', 'lastPrompt', 'live', 'model', 'modelLabel', 'name', 'pane',
    'pid', 'report', 'resumeCmd', 'role', 'startedAt', 'state', 'subagents', 'title', 'version', 'worktree'];
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

describe('helpers', () => {
  test('(+) modelLabel turns ids into short labels', () => {
    assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
    assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
    assert.equal(modelLabel('sonnet'), 'Sonnet');
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
