// Regression tests for the independent review (findings F1–F4, F9, F12, F15, F17). Synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFixture, cleanup, fakeExec, jsonl, NOW } from './helpers.js';
import { discoverReportDirs, indexReports } from '../src/collect/reports.js';
import { readRegistry } from '../src/collect/registry.js';
import { readTranscript, createTranscriptCache } from '../src/collect/transcripts.js';
import { readReport } from '../src/actions.js';
import { collect } from '../src/model.js';
import { mapLimit } from '../src/util.js';

const fx = makeFixture();
after(() => cleanup(fx));
const EVIL = '88888888-8888-4888-8888-888888888888';
const FIFO_ID = '99999999-9999-4999-8999-999999999999';
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nika');

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms))]);
}

describe('F1 symlinks in agent-writable report dirs', () => {
  const decoy = path.join(fx.root, 'outside', 'id_secret');
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  fs.writeFileSync(decoy, 'DECOY-PRIVATE-KEY-MATERIAL\n');
  fs.writeFileSync(path.join(fx.reportsDir, 'evil.session'), `${EVIL}\n`);
  fs.symlinkSync(decoy, path.join(fx.reportsDir, 'evil.md'));
  // symlinked .session pointing at a file that holds a valid uuid
  const sessTarget = path.join(fx.root, 'outside', 'sess');
  fs.writeFileSync(sessTarget, `${EVIL.replace(/8/g, '7')}\n`);
  fs.symlinkSync(sessTarget, path.join(fx.reportsDir, 'linked.session'));
  // symlinked reports dir
  const realDir = path.join(fx.root, 'outside', 'reports');
  fs.mkdirSync(realDir, { recursive: true });
  fs.mkdirSync(path.join(fx.tmpRoot, '-linked', 'sess', 'scratchpad'), { recursive: true });
  fs.symlinkSync(realDir, path.join(fx.tmpRoot, '-linked', 'sess', 'scratchpad', 'reports'));

  test('(−) a symlinked <name>.md is never opened; the report route answers 404', async () => {
    const idx = await indexReports([fx.reportsDir]);
    assert.equal(idx.get(EVIL)?.reportPath ?? null, null);
    const r = await readReport(EVIL, fx.config);
    assert.equal(r.status, 404);
    assert.equal(r.text.includes('DECOY'), false);
  });

  test('(−) N1: a hard-linked <name>.md is refused', async () => {
    const HARD = '12121212-1212-4212-8212-121212121212';
    fs.writeFileSync(path.join(fx.reportsDir, 'hard.session'), `${HARD}\n`);
    fs.linkSync(decoy, path.join(fx.reportsDir, 'hard.md'));
    const r = await readReport(HARD, fx.config);
    assert.equal(r.status, 404);
    assert.equal(r.text.includes('DECOY'), false);
  });

  test('(−) N2: no source file contains raw bidi code points', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    for (const dir of ['src', 'src/collect', 'public', 'test', 'bin']) {
      for (const f of fs.readdirSync(path.join(root, dir))) {
        const p = path.join(root, dir, f);
        if (!fs.statSync(p).isFile()) continue;
        assert.equal(/[\u202a-\u202e\u2066-\u2069]/.test(fs.readFileSync(p, 'utf8')), false, p);
      }
    }
  });

  test('(−) a symlinked <name>.session is ignored', async () => {
    const idx = await indexReports([fx.reportsDir]);
    assert.equal([...idx.values()].some((e) => e.name === 'linked'), false);
  });

  test('(−) a symlinked scratchpad/reports dir is not discovered', async () => {
    const dirs = await discoverReportDirs(fx.tmpRoot, []);
    assert.deepEqual(dirs, [fx.reportsDir]);
  });

  test('(+) a regular report file still works', async () => {
    const idx = await indexReports([fx.reportsDir]);
    assert.equal(idx.get('11111111-1111-4111-8111-111111111111').status, 'STATUS: RUNNING 7.1 build');
  });
});

describe('F2 FIFOs in report dirs', () => {
  test('(−) FIFO .md and .session do not hang the index', async () => {
    const dir = path.join(fx.root, 'fifo-reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pipe.session'), `${FIFO_ID}\n`);
    execFileSync('mkfifo', [path.join(dir, 'pipe.md')]);
    execFileSync('mkfifo', [path.join(dir, 'other.session')]);
    try {
      const idx = await withTimeout(indexReports([dir]), 2000);
      assert.equal(idx.get(FIFO_ID).reportPath, null);
      assert.equal(idx.size, 1);
    } finally {
      // unblock any reader stuck in open() so the test process can exit even when red
      for (const f of ['pipe.md', 'other.session']) {
        try {
          fs.closeSync(fs.openSync(path.join(dir, f), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          // no reader waiting
        }
      }
    }
  });
});

describe('F3 session ids from disk', () => {
  test('(−) registry entries whose sessionId is not a uuid are skipped', async () => {
    const dir = path.join(fx.root, 'claude-f3');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', '777.json'), JSON.stringify({ pid: 777, sessionId: 'x; touch /tmp/pwned #', cwd: '/tmp' }));
    const r = await readRegistry(dir);
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.skipped, ['777.json']);
  });
});

describe('F4 terminal escapes', () => {
  const dir = path.join(fx.root, 'claude-f4');
  const sid = 'abababab-abab-4bab-8bab-abababababab';
  const file = path.join(dir, 'projects', '-x', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl([
    { type: 'user', cwd: fx.plain, gitBranch: 'feat/\u001b[31mred', timestamp: new Date(NOW).toISOString() },
    { type: 'ai-title', aiTitle: 'fix\u001b]0;PWNED\u0007\u001b[2J ok\u202e' },
    { type: 'last-prompt', lastPrompt: 'hi\u0007there' },
  ]));

  test('(−) control and bidi characters are stripped from every display field', async () => {
    const { snapshot } = await collect({ config: { claudeDir: dir, tmpRoot: path.join(fx.root, 'none'), reportDirs: [] }, exec: fakeExec(), now: NOW, sinceMs: Infinity });
    const a = snapshot.groups[0].agents[0];
    for (const v of [a.name, a.title, a.lastPrompt, a.gitBranch]) {
      assert.equal(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v), false, JSON.stringify(v));
    }
    assert.equal(a.title, 'fix ok', 'the OSC title and the CSI erase go whole, not just their escape byte');
  });

  test('(−) nika status prints no ESC bytes', async () => {
    const out = await new Promise((resolve) => {
      execFile(process.execPath, [BIN, 'status', '--since', 'all'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir, NIKA_TMP_ROOT: path.join(fx.root, 'none'), NIKA_TMUX: '/nonexistent/tmux', NO_COLOR: '1' },
      }, (err, stdout) => resolve(stdout));
    });
    assert.match(out, /fix ok/);
    assert.doesNotMatch(out, /PWNED/);
    assert.equal(out.includes('\u001b'), false);
    assert.equal(out.includes('\u0007'), false);
  });
});

describe('F15 out-of-range timestamps', () => {
  test('(−) registry timestamps outside the Date range become null', async () => {
    const dir = path.join(fx.root, 'claude-f15');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', '778.json'), JSON.stringify({ pid: 778, sessionId: EVIL, startedAt: 1e20, updatedAt: -5 }));
    const r = await readRegistry(dir);
    assert.equal(r.entries[0].startedAt, null);
    assert.equal(r.entries[0].updatedAt, null);
  });
});

describe('F17 tail without a newline', () => {
  test('(+) a huge last line widens the tail read instead of falling back to head values', async () => {
    const file = path.join(fx.root, 'f17', `${EVIL}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = { type: 'attachment', pad: 'p'.repeat(1000) };
    fs.writeFileSync(file, jsonl([
      { type: 'user', cwd: '/start', timestamp: '2026-11-01T00:00:00.000Z' },
      ...Array.from({ length: 100 }, () => pad),
      { type: 'assistant', message: { model: 'claude-opus-5-5' } },
      { type: 'ai-title', aiTitle: 'tail title' },
      { type: 'attachment', blob: 'b'.repeat(400_000) },
    ]));
    const st = fs.statSync(file);
    const t = await readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
    assert.equal(t.aiTitle, 'tail title');
    assert.equal(t.model, 'claude-opus-5-5');
  });
});

describe('F5 bounded concurrency', () => {
  test('(+) mapLimit keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([...Array(40).keys()], 4, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
      return n * 2;
    });
    assert.equal(peak <= 4, true);
    assert.deepEqual(out, [...Array(40).keys()].map((n) => n * 2));
  });

  test('(−) mapLimit on an empty list resolves to an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });
});
