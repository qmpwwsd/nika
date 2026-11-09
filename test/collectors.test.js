import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture, cleanup, fakeExec, SID, NOW, PROC_START, jsonl } from './helpers.js';
import { readRegistry, processTable, isAlive } from '../src/collect/registry.js';
import { indexTranscripts, readTranscript, createTranscriptCache } from '../src/collect/transcripts.js';
import { readSubagents } from '../src/collect/subagents.js';
import { listPanes, parsePaneLines } from '../src/collect/tmux.js';
import { discoverReportDirs, indexReports } from '../src/collect/reports.js';
import { resolveProject } from '../src/collect/projects.js';
import { defaultConfig } from '../src/config.js';

const fx = makeFixture();
after(() => cleanup(fx));

describe('registry', () => {
  test('(+) reads every <pid>.json entry with normalised fields', async () => {
    const r = await readRegistry(fx.claudeDir);
    assert.equal(r.error, null);
    const pids = r.entries.map((e) => e.pid).sort();
    assert.deepEqual(pids, [101, 102, 103, 104]);
    const busy = r.entries.find((e) => e.pid === 101);
    assert.equal(busy.sessionId, SID.busy);
    assert.equal(busy.status, 'busy');
    assert.equal(busy.tmuxPane, '%5');
    assert.equal(busy.bridgeSessionId, 'session_01AbCdEf');
  });

  test('(−) skips corrupt JSON and never parses *.key files', async () => {
    const r = await readRegistry(fx.claudeDir);
    assert.deepEqual(r.skipped, ['105.json']);
  });

  test('(−) missing sessions dir gives an empty list and an error message, no throw', async () => {
    const r = await readRegistry(path.join(fx.root, 'nope'));
    assert.deepEqual(r.entries, []);
    assert.match(r.error, /sessions/);
  });

  test('(+) process table maps pid to start time; isAlive matches procStart', async () => {
    const table = await processTable(fakeExec());
    // ps pads single-digit days ("Nov  7"); the table stores whitespace squashed so both sides compare equal.
    assert.equal(table.get(101), 'Sat Nov 7 18:57:14 2026');
    assert.equal(isAlive({ pid: 101, procStart: PROC_START }, table), true);
  });

  test('(+) F8: NIKA_TMUX overrides the tmux binary', () => {
    assert.equal(defaultConfig({ NIKA_TMUX: '/x/tmux' }).tmuxBin, '/x/tmux');
  });

  test('(+) ps runs with TZ=UTC because the registry writes procStart in UTC', async () => {
    const seen = [];
    await processTable(async (cmd, args, opts) => {
      seen.push(opts);
      return { stdout: '' };
    });
    assert.equal(seen[0]?.env?.TZ, 'UTC');
  });

  test('(−) dead pid and reused pid (different start time) are not alive', async () => {
    const table = await processTable(fakeExec());
    assert.equal(isAlive({ pid: 103, procStart: PROC_START }, table), false);
    assert.equal(isAlive({ pid: 104, procStart: 'Mon Oct  5 10:00:00 2026' }, table), false);
  });

  test('(−) ps failure returns null so callers fall back to signal 0', async () => {
    const exec = async () => { throw new Error('ps missing'); };
    assert.equal(await processTable(exec), null);
    assert.equal(isAlive({ pid: process.pid }, null), true);
    assert.equal(isAlive({ pid: 2 ** 30 }, null), false);
  });
});

describe('transcripts', () => {
  test('(+) indexes top-level <uuid>.jsonl files by session id with mtime', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    assert.equal(idx.error, null);
    assert.equal(idx.files.size, 6);
    const f = idx.files.get(SID.busy);
    assert.equal(Math.round(f.mtimeMs / 1000), Math.round((NOW - 60_000) / 1000));
  });

  test('(+) reads cwd, branch, model, title, last prompt, timestamps and bridge id', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const t = await readTranscript(idx.files.get(SID.busy), createTranscriptCache());
    assert.equal(t.cwd, fx.wt);
    assert.equal(t.gitBranch, 'feat/x');
    assert.equal(t.model, 'claude-sonnet-5-5');
    assert.equal(t.aiTitle, 'Build story X');
    assert.equal(t.lastPrompt, 'approved');
    assert.equal(t.bridgeSessionId, 'cse_01AbCdEf');
    assert.equal(t.startedAt, NOW - 60 * 60_000);
  });

  test('(+) a transcript with user or assistant lines has hasConversation true', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const t = await readTranscript(idx.files.get(SID.busy), createTranscriptCache());
    assert.equal(t.hasConversation, true);
  });

  test('(−) a title-only stub transcript has hasConversation false and no cwd', async () => {
    const file = path.join(fx.root, 'stub', 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl([{ type: 'ai-title', sessionId: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', aiTitle: 'Stub title' }]));
    const st = fs.statSync(file);
    const t = await readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
    assert.equal(t.hasConversation, false);
    assert.equal(t.cwd, null);
  });

  test('(+) large file: reads only head and tail chunks, cuts partial lines, last values win', async () => {
    const file = path.join(fx.root, 'big', `${SID.old}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = { type: 'attachment', pad: 'p'.repeat(1000) };
    const lines = [
      { type: 'user', cwd: '/start/dir', gitBranch: 'a', timestamp: '2026-11-01T00:00:00.000Z' },
      ...Array.from({ length: 900 }, () => pad),
      { type: 'ai-title', aiTitle: 'first title' },
      ...Array.from({ length: 50 }, () => pad),
      { type: 'assistant', cwd: '/start/dir', gitBranch: 'b', timestamp: '2026-11-02T00:00:00.000Z', message: { model: 'claude-opus-5-5' } },
      { type: 'ai-title', aiTitle: 'final title' },
    ];
    fs.writeFileSync(file, jsonl(lines));
    const st = fs.statSync(file);
    assert.ok(st.size > 600_000);
    const t = await readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
    assert.equal(t.cwd, '/start/dir');
    assert.equal(t.aiTitle, 'final title');
    assert.equal(t.model, 'claude-opus-5-5');
    assert.equal(t.gitBranch, 'b');
    assert.equal(t.bytesRead < st.size, true);
  });

  test('(−) corrupt lines and <synthetic> model are ignored', async () => {
    const file = path.join(fx.root, 'corrupt', `${SID.other}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl([
      { type: 'user', cwd: '/c', timestamp: '2026-11-01T00:00:00.000Z' },
      '{"type":"assistant", broken',
      { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
    ]));
    const st = fs.statSync(file);
    const t = await readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
    assert.equal(t.model, 'claude-sonnet-5-5');
    assert.equal(t.cwd, '/c');
  });

  test('(+) cache returns the same object while mtime and size are unchanged', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const cache = createTranscriptCache();
    const a = await readTranscript(idx.files.get(SID.idle), cache);
    const b = await readTranscript(idx.files.get(SID.idle), cache);
    assert.equal(a, b);
  });

  test('(−) missing projects dir gives an empty index and an error message', async () => {
    const idx = await indexTranscripts(path.join(fx.root, 'nope'));
    assert.equal(idx.files.size, 0);
    assert.match(idx.error, /projects/);
  });
});

describe('subagents', () => {
  test('(+) reads meta.json of each subagent with its transcript mtime', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const subs = await readSubagents(idx.files.get(SID.busy));
    assert.equal(subs.length, 2);
    const running = subs.find((s) => s.id === 'bbb222');
    assert.deepEqual(
      { type: running.type, description: running.description, model: running.model, finished: running.finished },
      { type: 'general-purpose', description: 'Write tests', model: 'sonnet', finished: false },
    );
    assert.equal(Math.round(running.lastActivity / 1000), Math.round((NOW - 120_000) / 1000));
  });

  test('(−) session without a subagents dir gives an empty list; broken meta is skipped', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    assert.deepEqual(await readSubagents(idx.files.get(SID.idle)), []);
    const subs = await readSubagents(idx.files.get(SID.busy));
    assert.equal(subs.some((s) => s.id === 'ccc333'), false);
  });
});

describe('tmux', () => {
  test('(+) parses panes; name only from the "[%id] name" title convention', () => {
    const panes = parsePaneLines('%5\twork\t1\t[%5] build-7-1\tzsh\n%6\twork\t2\tMacBook.local\tclaude\n');
    assert.equal(panes.get('%5').name, 'build-7-1');
    assert.equal(panes.get('%5').session, 'work');
    assert.equal(panes.get('%6').name, null);
  });

  test('(+) @nika-role: "orchestrator" and "agent" are read from the last field; an empty title keeps the fields in place', () => {
    const panes = parsePaneLines('%5\twork\t1\t[%5] build-7-1\tzsh\tagent\n%6\twork\t2\t\tclaude\torchestrator\n%7\twork\t3\tMacBook.local\tzsh\t\n');
    assert.equal(panes.get('%5').role, 'agent');
    assert.equal(panes.get('%6').role, 'orchestrator');
    assert.equal(panes.get('%6').title, '');
    assert.equal(panes.get('%6').command, 'claude');
    assert.equal(panes.get('%7').role, null);
  });

  test('(−) @nika-role: any other value, a 0.1-style line without the field, and short lines give role null and still parse', () => {
    const lines = ['%1\tw\t1\tt\tzsh\tadmin', '%2\tw\t1\tt\tzsh\tAgent', '%3\tw\t1\tt\tzsh\torchestrator ', '%4\tw\t1\tt\tzsh', '%8\tw\t1', '%9'];
    const panes = parsePaneLines(`${lines.join('\n')}\n`);
    for (const id of ['%1', '%2', '%3', '%4', '%8', '%9']) assert.equal(panes.get(id).role, null, id);
    assert.equal(panes.get('%4').name, null);
    assert.equal(panes.get('%4').command, 'zsh');
  });

  test('(+) listPanes asks tmux for the nika tags after the title and command: role, agent, depth, parent', async () => {
    const exec = fakeExec();
    await listPanes(exec);
    const format = exec.calls[0].at(-1);
    assert.ok(format.endsWith('\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}'));
    assert.equal(format.split('\t').length, 9);
  });

  const KEY = '0123456789abcdef';
  const TAGS = (role, agent, depth, parent) => `%5\twork\t1\t[%5] x\tnode\t${role}\t${agent}\t${depth}\t${parent}\n`;

  test('(+) @nika-role sub-orchestrator, @nika-agent, @nika-depth and @nika-parent are read when they parse', () => {
    const p = parsePaneLines(TAGS('sub-orchestrator', `${KEY}/planner`, '2', '%3')).get('%5');
    assert.deepEqual([p.role, p.agent, p.depth, p.parent], ['sub-orchestrator', `${KEY}/planner`, 2, '%3']);
    const a = parsePaneLines(TAGS('agent', `${KEY}/build-1`, '3', '%5')).get('%5');
    assert.deepEqual([a.role, a.agent, a.depth, a.parent], ['agent', `${KEY}/build-1`, 3, '%5']);
    const o = parsePaneLines(TAGS('orchestrator', `${KEY}/orchestrator`, '1', '')).get('%5');
    assert.deepEqual([o.role, o.agent, o.depth, o.parent], ['orchestrator', `${KEY}/orchestrator`, 1, null]);
  });

  test('(−) a bad agent tag, depth or parent becomes null (never cleaned up into something valid); a line without the fields has none', () => {
    for (const depth of ['0', '4', '12', '1 ', ' 2', '2.0', 'x', '-1', '٣']) assert.equal(parsePaneLines(TAGS('agent', `${KEY}/a`, depth, '')).get('%5').depth, null, JSON.stringify(depth));
    for (const parent of ['5', '%', '%x', '% 5', '%5 ', ' %5', '%1234567', '%5\u0000', '#{pane_id}', '%3;%4', '%03a']) assert.equal(parsePaneLines(TAGS('agent', `${KEY}/a`, '2', parent)).get('%5').parent, null, JSON.stringify(parent));
    for (const agent of ['a', `${KEY}`, `${KEY}/`, `${KEY.toUpperCase()}/a`, `${KEY}/a/b`, ` ${KEY}/a`, `${KEY}/A b`]) assert.equal(parsePaneLines(TAGS('agent', agent, '2', '')).get('%5').agent, null, JSON.stringify(agent));
    const old = parsePaneLines('%5\twork\t1\tt\tzsh\tagent\n').get('%5');
    assert.deepEqual([old.role, old.agent, old.depth, old.parent], ['agent', null, null, null]);
  });

  test('(−) a pane with no nika role carries no agent tag, depth or parent, whatever its options say', () => {
    const p = parsePaneLines(TAGS('', `${KEY}/a`, '2', '%3')).get('%5');
    assert.deepEqual([p.role, p.agent, p.depth, p.parent], [null, null, null, null]);
    const q = parsePaneLines(TAGS('admin', `${KEY}/a`, '2', '%3')).get('%5');
    assert.deepEqual([q.role, q.agent, q.depth, q.parent], [null, null, null, null]);
  });

  test('(+) listPanes calls tmux -u list-panes -a with a fixed format', async () => {
    // -u added for review finding F10 (non-ASCII pane titles were sanitised to "_").
    const exec = fakeExec();
    const r = await listPanes(exec);
    assert.equal(r.error, null);
    assert.equal(r.panes.size, 3);
    assert.deepEqual(exec.calls[0].slice(0, 4), ['tmux', '-u', 'list-panes', '-a']);
  });

  test('(−) tmux missing or no server: empty map and an error message, no throw', async () => {
    const r = await listPanes(fakeExec({ tmuxError: 'ENOENT' }));
    assert.equal(r.panes.size, 0);
    assert.match(r.error, /tmux/);
    const r2 = await listPanes(fakeExec({ tmuxError: 'no server running on /tmp/tmux-501/default' }));
    assert.equal(r2.panes.size, 0);
  });
});

describe('reports', () => {
  test('(+) discovers <tmpRoot>/*/*/scratchpad/reports dirs plus extra dirs', async () => {
    const extra = path.join(fx.root, 'extra-reports');
    fs.mkdirSync(extra, { recursive: true });
    const dirs = await discoverReportDirs(fx.tmpRoot, [extra, path.join(fx.root, 'missing')]);
    // Extra dirs are owner-configured and resolved with realpath (review F1); on macOS /var → /private/var.
    assert.deepEqual(dirs.sort(), [fs.realpathSync(extra), fx.reportsDir].sort());
  });

  test('(+) maps session id to report name, STATUS line, rc and report path', async () => {
    const idx = await indexReports([fx.reportsDir]);
    const busy = idx.get(SID.busy);
    assert.equal(busy.name, 'build-7-1');
    assert.equal(busy.status, 'STATUS: RUNNING 7.1 build');
    assert.equal(busy.rc, null);
    assert.equal(busy.reportPath, path.join(fx.reportsDir, 'build-7-1.md'));
    const old = idx.get(SID.ended);
    assert.equal(old.status, null);
    assert.equal(old.rc, 0);
  });

  test('(−) a .session file without a valid uuid is ignored; missing tmp root gives no dirs', async () => {
    const idx = await indexReports([fx.reportsDir]);
    assert.equal([...idx.values()].some((r) => r.name === 'bad'), false);
    assert.deepEqual(await discoverReportDirs(path.join(fx.root, 'nope'), []), []);
  });
});

describe('projects', () => {
  test('(+) main checkout groups under its own root', () => {
    const p = resolveProject(fx.repo);
    assert.deepEqual(p, { key: fx.repo, label: 'repo', root: fx.repo, worktree: null });
  });

  test('(+) linked worktree and its subdirs fold under the parent repo with a worktree tag', () => {
    assert.deepEqual(resolveProject(fx.wt), { key: fx.repo, label: 'repo', root: fx.repo, worktree: 'repo-wt' });
    assert.equal(resolveProject(path.join(fx.wt, 'packages', 'app')).key, fx.repo);
  });

  test('(−) non-git dir and missing dir group by the cwd itself', () => {
    assert.deepEqual(resolveProject(fx.plain), { key: fx.plain, label: 'plain', root: fx.plain, worktree: null });
    const gone = path.join(fx.root, 'deleted-scratch');
    assert.deepEqual(resolveProject(gone), { key: gone, label: 'deleted-scratch', root: gone, worktree: null });
  });

  test('(−) empty cwd groups under "(unknown)"', () => {
    assert.equal(resolveProject('').key, '(unknown)');
    assert.equal(resolveProject(undefined).label, '(unknown)');
  });

  test('(+) F6: a deleted dir inside a repo still folds under the repo', () => {
    assert.deepEqual(resolveProject(path.join(fx.repo, 'gone', 'deeper')), { key: fx.repo, label: 'repo', root: fx.repo, worktree: null });
  });

  test('(+) F6: a deleted Claude Code worktree (<repo>/.claude/worktrees/<name>) keeps its worktree tag', () => {
    assert.deepEqual(resolveProject(path.join(fx.repo, '.claude', 'worktrees', 'foo')), { key: fx.repo, label: 'repo', root: fx.repo, worktree: 'foo' });
  });

  test('(+) F11: a submodule groups under its own working dir, not the internal gitdir', () => {
    const sup = path.join(fx.root, 'super');
    const sub = path.join(sup, 'sub');
    fs.mkdirSync(path.join(sup, '.git', 'modules', 'sub'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    assert.deepEqual(resolveProject(sub), { key: sub, label: 'sub', root: sub, worktree: null });
  });

  test('(−) F12: a huge whitespace-padded .git file resolves fast and falls back', () => {
    const d = path.join(fx.root, 'slow-git');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.git'), `gitdir: x${' '.repeat(100_000)}y`);
    const t0 = performance.now();
    resolveProject(d);
    assert.ok(performance.now() - t0 < 200, 'took too long');
  });
});

describe('review fixes: liveness and tmux', () => {
  test('(−) F13: empty ps output means "unknown" (null), not "everything dead"', async () => {
    assert.equal(await processTable(async () => ({ stdout: '' })), null);
  });

  test('(+) F10: ps gets the C locale; tmux list-panes runs with -u (UTF-8)', async () => {
    const seen = [];
    await processTable(async (cmd, args, opts) => { seen.push(opts); return { stdout: '1 x' }; });
    assert.equal(seen[0].env.LC_ALL, 'C');
    const exec = fakeExec();
    await listPanes(exec);
    assert.deepEqual(exec.calls[0].slice(0, 3), ['tmux', '-u', 'list-panes']);
  });

  test('(+) F8: listPanes uses the configured tmux binary; a missing binary says how to fix it', async () => {
    const calls = [];
    const r = await listPanes(async (cmd) => { calls.push(cmd); throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); }, '/opt/x/tmux');
    assert.equal(calls[0], '/opt/x/tmux');
    assert.match(r.error, /NIKA_TMUX/);
  });
});
