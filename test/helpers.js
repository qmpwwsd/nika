// Synthetic fixtures only: never copy real transcripts, session files or prompts here (rules/project-rules.md §7).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SID = {
  busy: '11111111-1111-4111-8111-111111111111',
  idle: '22222222-2222-4222-8222-222222222222',
  dead: '33333333-3333-4333-8333-333333333333',
  reused: '44444444-4444-4444-8444-444444444444',
  ended: '55555555-5555-4555-8555-555555555555',
  old: '66666666-6666-4666-8666-666666666666',
  other: '77777777-7777-4777-8777-777777777777',
};

export const NOW = Date.UTC(2026, 10, 7, 20, 0, 0); // 2026-11-07T20:00:00Z
const MIN = 60_000;
const DAY = 86_400_000;
export const PROC_START = 'Sat Nov  7 18:57:14 2026';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function setMtime(file, ms) {
  const t = new Date(ms);
  fs.utimesSync(file, t, t);
}

export function jsonl(lines) {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
}

function transcriptLines({ sid, cwd, branch, model, title, prompt, startIso, endIso, bridge }) {
  return [
    { type: 'permission-mode', permissionMode: 'auto', sessionId: sid },
    { type: 'user', cwd, sessionId: sid, gitBranch: branch, version: '2.1.319', timestamp: startIso, message: { role: 'user', content: 'synthetic prompt' } },
    { type: 'assistant', cwd, sessionId: sid, gitBranch: branch, timestamp: endIso, message: { role: 'assistant', model, content: [] } },
    { type: 'ai-title', aiTitle: title, sessionId: sid },
    { type: 'last-prompt', lastPrompt: prompt, sessionId: sid },
    ...(bridge ? [{ type: 'bridge-session', sessionId: sid, bridgeSessionId: bridge, lastSequenceNum: 0 }] : []),
  ];
}

/**
 * Builds a fake machine under a temp dir:
 *   root/repo            git repo (main checkout)          → project "repo"
 *   root/repo-wt         linked worktree of repo           → project "repo", worktree "repo-wt"
 *   root/plain           not a git repo                    → project "plain"
 *   root/claude          fake CLAUDE_CONFIG_DIR
 *   root/tmp             fake NIKA_TMP_ROOT with spawn reports
 */
export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-test-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'repo-wt');
  const plain = path.join(root, 'plain');
  const claudeDir = path.join(root, 'claude');
  const tmpRoot = path.join(root, 'tmp');

  // git layout without running git
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'repo-wt'), { recursive: true });
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(repo, '.git', 'worktrees', 'repo-wt', 'commondir'), '../..\n');
  write(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'repo-wt')}\n`);
  fs.mkdirSync(path.join(wt, 'packages', 'app'), { recursive: true });
  fs.mkdirSync(plain, { recursive: true });

  // live registry
  const sessions = path.join(claudeDir, 'sessions');
  const reg = (pid, o) => write(path.join(sessions, `${pid}.json`), JSON.stringify({
    pid, kind: 'interactive', version: '2.1.319', procStart: PROC_START, startedAt: NOW - 60 * MIN, updatedAt: NOW - MIN, nameSource: 'derived', ...o,
  }));
  reg(101, { sessionId: SID.busy, cwd: wt, name: 'repo-wt-8a', status: 'busy', tmux: 'work:@1.%5', bridgeSessionId: 'session_01AbCdEf' });
  reg(102, { sessionId: SID.idle, cwd: repo, name: 'planner', nameSource: 'user', status: 'idle', tmux: 'work:@2.%6' });
  reg(103, { sessionId: SID.dead, cwd: repo, name: 'gone', status: 'idle' });
  reg(104, { sessionId: SID.reused, cwd: repo, name: 'reused', status: 'busy', procStart: 'Mon Oct  5 10:00:00 2026' });
  write(path.join(sessions, '105.json'), '{not json');
  write(path.join(sessions, '101.deadbeef.key'), 'SECRET-KEY-MATERIAL');

  // transcripts
  const slug = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
  const t = (cwd, sid, o, mtime) => {
    const file = path.join(claudeDir, 'projects', slug(cwd), `${sid}.jsonl`);
    write(file, jsonl(transcriptLines({ sid, cwd, ...o })));
    setMtime(file, mtime);
    return file;
  };
  t(wt, SID.busy, { branch: 'feat/x', model: 'claude-sonnet-5-5', title: 'Build story X', prompt: 'approved', startIso: new Date(NOW - 60 * MIN).toISOString(), endIso: new Date(NOW - MIN).toISOString(), bridge: 'cse_01AbCdEf' }, NOW - MIN);
  t(repo, SID.idle, { branch: 'main', model: 'claude-opus-5-5', title: 'Plan sprint', prompt: 'next', startIso: new Date(NOW - 120 * MIN).toISOString(), endIso: new Date(NOW - 5 * MIN).toISOString() }, NOW - 5 * MIN);
  t(repo, SID.dead, { branch: 'main', model: 'claude-haiku-4-5-20251001', title: 'Scout files', prompt: 'go', startIso: new Date(NOW - DAY).toISOString(), endIso: new Date(NOW - DAY + 10 * MIN).toISOString() }, NOW - DAY + 10 * MIN);
  t(repo, SID.ended, { branch: 'fix/y', model: 'claude-sonnet-5-5', title: 'Review diff', prompt: 'x'.repeat(500), startIso: new Date(NOW - 2 * DAY).toISOString(), endIso: new Date(NOW - 2 * DAY + MIN).toISOString(), bridge: 'cse_01Zz' }, NOW - 2 * DAY + MIN);
  t(repo, SID.old, { branch: 'main', model: 'claude-sonnet-5-5', title: 'Ancient', prompt: 'old', startIso: new Date(NOW - 20 * DAY).toISOString(), endIso: new Date(NOW - 20 * DAY).toISOString() }, NOW - 20 * DAY);
  t(plain, SID.other, { branch: undefined, model: 'claude-sonnet-5-5', title: 'Plain dir work', prompt: 'hi', startIso: new Date(NOW - 3 * DAY).toISOString(), endIso: new Date(NOW - 3 * DAY).toISOString() }, NOW - 3 * DAY);

  // subagents of the busy session
  const subDir = path.join(claudeDir, 'projects', slug(wt), SID.busy, 'subagents');
  write(path.join(subDir, 'agent-aaa111.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find callers', model: 'haiku', finished: true }));
  write(path.join(subDir, 'agent-aaa111.jsonl'), jsonl([{ type: 'user', isSidechain: true }]));
  setMtime(path.join(subDir, 'agent-aaa111.jsonl'), NOW - 30 * MIN);
  write(path.join(subDir, 'agent-bbb222.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Write tests', model: 'sonnet', finished: false }));
  write(path.join(subDir, 'agent-bbb222.jsonl'), jsonl([{ type: 'user', isSidechain: true }]));
  setMtime(path.join(subDir, 'agent-bbb222.jsonl'), NOW - 2 * MIN);
  write(path.join(subDir, 'agent-ccc333.meta.json'), '{broken');

  // spawn reports (spawn.sh layout: <tmpRoot>/<project-slug>/<session>/scratchpad/reports)
  const reports = path.join(tmpRoot, '-fake-project', 'aaaa-bbbb', 'scratchpad', 'reports');
  write(path.join(reports, 'build-7-1.session'), `${SID.busy}\n`);
  write(path.join(reports, 'build-7-1.md'), 'STATUS: RUNNING 7.1 build\n\n## Summary\n- synthetic\n');
  write(path.join(reports, 'review-old.session'), `${SID.ended}\n`);
  write(path.join(reports, 'review-old.md'), '## Summary\nno status line\n');
  write(path.join(reports, 'review-old.rc'), '0\n');
  write(path.join(reports, 'bad.session'), 'not-a-uuid\n');
  write(path.join(reports, '.last-pane'), '%5\n');

  return { root, repo, wt, plain, claudeDir, tmpRoot, reportsDir: reports, config: { claudeDir, tmpRoot, reportDirs: [], port: 0 } };
}

export function cleanup(fx) {
  fs.rmSync(fx.root, { recursive: true, force: true });
}

/** Fake execFile: answers ps and tmux like the real tools would; records every call. */
export function fakeExec({ psLines, tmuxLines, tmuxError } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith('ps')) {
      const lines = psLines ?? [`  101 ${PROC_START}`, `  102 ${PROC_START}`, `  104 ${PROC_START}`];
      return { stdout: lines.join('\n') + '\n', stderr: '' };
    }
    if (cmd === 'tmux') {
      if (tmuxError) {
        const e = new Error(tmuxError);
        e.code = tmuxError === 'ENOENT' ? 'ENOENT' : 1;
        throw e;
      }
      if (args.includes('list-panes')) {
        const lines = tmuxLines ?? [
          '%5\twork\t1\t[%5] build-7-1\tzsh',
          '%6\twork\t2\tMacBook.local\tclaude',
          '%7\twork\t3\t[%7] lazygit pane\tlazygit',
        ];
        return { stdout: lines.join('\n') + '\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
    throw Object.assign(new Error(`unexpected command ${cmd}`), { code: 'ENOENT' });
  };
  exec.calls = calls;
  return exec;
}
