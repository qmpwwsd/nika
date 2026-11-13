import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, cleanup } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nika');
const fx = makeFixture();
after(() => cleanup(fx));

// NIKA_TMUX points nowhere so the result never depends on the developer's tmux server (review F19).
const env = { ...process.env, CLAUDE_CONFIG_DIR: fx.claudeDir, NIKA_TMP_ROOT: fx.tmpRoot, NIKA_TMUX: '/nonexistent/tmux', NO_COLOR: '1' };

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

describe('cli', () => {
  test('(−) N6: status --json escapes C1 control characters', async () => {
    const dir = path.join(fx.root, 'claude-n6');
    const sid = 'efefefef-efef-4fef-8fef-efefefefefef';
    const cwd = `/tmp/n6${'\u009b'}31m`;
    const file = path.join(dir, 'projects', '-n6', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString() })}\n`);
    const r = await run(['status', '--json', '--since', 'all'], { CLAUDE_CONFIG_DIR: dir });
    assert.equal(r.code, 0);
    assert.equal(/[\u0080-\u009f]/.test(r.stdout), false);
    assert.equal(JSON.parse(r.stdout).groups[0].agents[0].cwd, cwd);
  });

  test('(+) --version prints the package version', async () => {
    const r = await run(['--version']);
    assert.equal(r.code, 0);
    const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(BIN), '..', 'package.json'), 'utf8'));
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(r.stdout.trim(), `nika ${version}`);
  });

  test('(+) status --json lists agents grouped by project', async () => {
    const r = await run(['status', '--json', '--since', 'all']);
    assert.equal(r.code, 0, r.stderr);
    const snap = JSON.parse(r.stdout);
    assert.deepEqual(snap.groups.map((g) => g.label).sort(), ['plain', 'repo']);
    assert.ok(snap.groups.find((g) => g.label === 'repo').agents.some((a) => a.name === 'build-7-1'));
  });

  test('(+) status text shows a header per project and agent names', async () => {
    const r = await run(['status', '--since', 'all', '--ended']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^repo\s/m);
    assert.match(r.stdout, /build-7-1/);
    assert.match(r.stdout, /^plain\s/m);
  });

  // F5 (0.4): ended agents are hidden by default everywhere. Seven ended sessions in one folder: more than the cap of 5 that --ended shows.
  describe('status and ended agents', () => {
    const nameRows = (out) => out.split('\n').filter((l) => /^ {2}○ ended/.test(l));
    const sevenEnded = () => {
      const dir = path.join(fx.root, 'claude-ended7');
      const slug = '-ended7';
      for (let i = 1; i <= 7; i += 1) {
        const sid = `0000000${i}-0000-4000-8000-000000000000`;
        const file = path.join(dir, 'projects', slug, `${sid}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: fx.plain, timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() })}\n${JSON.stringify({ type: 'ai-title', aiTitle: `worker-${i}`, sessionId: sid })}\n`);
        fs.utimesSync(file, new Date(Date.UTC(2026, 10, 1, 0, i)), new Date(Date.UTC(2026, 10, 1, 0, i)));
      }
      return { CLAUDE_CONFIG_DIR: dir };
    };

    test('(+) by default no ended row is printed; the header still counts them and one line says how to see them', async () => {
      const r = await run(['status', '--since', 'all'], sevenEnded());
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^plain\s.*ended 7$/m);
      assert.deepEqual(nameRows(r.stdout), []);
      assert.match(r.stdout, /^ {2}… 7 ended hidden \(nika status --ended\)$/m);
    });

    test('(+) --ended prints the latest 5 ended rows and points at --full for the rest', async () => {
      const r = await run(['status', '--since', 'all', '--ended'], sevenEnded());
      assert.equal(r.code, 0, r.stderr);
      assert.equal(nameRows(r.stdout).length, 5);
      assert.match(r.stdout, /worker-7/);
      assert.doesNotMatch(r.stdout, /worker-2\b/);
      assert.match(r.stdout, /^ {2}… 2 more ended \(nika status --full\)$/m);
      assert.doesNotMatch(r.stdout, /hidden/);
    });

    test('(+) --full lists every ended row, with no cap and no hint (it implies --ended)', async () => {
      const r = await run(['status', '--since', 'all', '--full'], sevenEnded());
      assert.equal(r.code, 0, r.stderr);
      assert.equal(nameRows(r.stdout).length, 7);
      assert.doesNotMatch(r.stdout, /more ended|hidden/);
    });

    test('(+) a project with nothing ended prints no hint', async () => {
      const dir = path.join(fx.root, 'claude-nothing-ended');
      fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
      const r = await run(['status', '--since', 'all'], { CLAUDE_CONFIG_DIR: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /hidden|more ended/);
    });

    test('(+) --json is not affected: every agent stays in the machine-readable output', async () => {
      const r = await run(['status', '--json', '--since', 'all'], sevenEnded());
      assert.equal(JSON.parse(r.stdout).groups.flatMap((g) => g.agents).length, 7);
    });

    test('(−) an unknown option is still refused with exit 2, also next to --ended; so is --ended=1', async () => {
      for (const args of [['status', '--bogus'], ['status', '--ended', '--bogus'], ['status', '--ended=1'], ['status', '--endedx']]) {
        const r = await run(args);
        assert.equal(r.code, 2, args.join(' '));
        assert.match(r.stderr, /unknown option/);
      }
    });

    test('(+) the usage text lists --ended, and --full says it implies it', async () => {
      const r = await run(['help']);
      assert.match(r.stdout, /^ {6}--ended {12}also list ended agents \(the latest 5 per project\)$/m);
      assert.match(r.stdout, /^ {6}--full {13}list every ended agent, not only the latest 5 \(implies --ended\)$/m);
    });
  });

  test('(−) unknown command and bad --since exit 2 with usage', async () => {
    const a = await run(['frobnicate']);
    assert.equal(a.code, 2);
    assert.match(a.stderr, /usage: nika/i);
    const b = await run(['status', '--since', 'forever']);
    assert.equal(b.code, 2);
    assert.match(b.stderr, /--since/);
  });

  // --browser: a bare `nika open` would launch the real app on a machine that has it installed
  test('(−) open --browser with no server running exits 1 and says how to start it', async () => {
    const r = await run(['open', '--browser'], { NIKA_PORT: String(await freePort()) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not running/);
    assert.match(r.stderr, /brew services start nika/);
  });

  test('(−) the new commands reject bad usage with exit 2, through the real binary', async () => {
    for (const args of [['spawn'], ['rules', 'frob'], ['projects'], ['orchestrate', 'a', 'b'], ['_run-agent'], ['doctor', 'x'], ['serve', '--bogus'], ['app', 'install', 'x'], ['app', 'bogus']]) {
      const r = await run(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, /usage: nika/i);
    }
  });

  test('(+) help lists the 0.2 commands', async () => {
    const r = await run(['help']);
    assert.equal(r.code, 0);
    for (const c of ['projects add', 'rules apply', 'spawn <name>', 'orchestrate', 'doctor', 'serve [--app]', 'app install']) assert.ok(r.stdout.includes(c), c);
  });

  test('(−) serve rejects an invalid port', async () => {
    const r = await run(['serve'], { NIKA_PORT: '99999' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /NIKA_PORT/);
  });
});
