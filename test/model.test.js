import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, cleanup, fakeExec, SID, NOW, jsonl } from './helpers.js';
import { collect, modelLabel, shellQuote, bridgeUrl } from '../src/model.js';
import { parseSince } from '../src/config.js';

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
      const repo = s.snapshot.groups.find((g) => g.key === fx2.repo);
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
        const g = s.snapshot.groups.find((x) => x.key === key);
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
