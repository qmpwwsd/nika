import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import { main } from '../src/cli.js';
import { getOrchestrator, setOrchestrator } from '../src/store.js';
import { fakeTmux, makeWorld, TMUX } from './tmux-fake.js';
import { makeFixture, cleanup, SID, NOW, fakeExec } from './helpers.js';
import { collect } from '../src/model.js';
import { hideSession, hideGroup, HIDDEN_FILE } from '../src/hidden.js';
import { keyFor } from '../src/store.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nika');
const fx = makeFixture();
after(() => cleanup(fx));

// NIKA_TMUX points nowhere so the result never depends on the developer's tmux server (review F19).
// NIKA_CONFIG_DIR / XDG_STATE_HOME: nika's own config and state live in the fixture, never the developer's (status reads the project list).
const env = { ...process.env, CLAUDE_CONFIG_DIR: fx.claudeDir, NIKA_TMP_ROOT: fx.tmpRoot, NIKA_TMUX: '/nonexistent/tmux', NO_COLOR: '1', NIKA_CONFIG_DIR: path.join(fx.root, 'nika-config'), XDG_STATE_HOME: path.join(fx.root, 'nika-state') };

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

  // F1b: a registry file nika cannot use would hide a live session without a word, so the count is printed (and is in the --json snapshot)
  test('(+) status prints one line when registry files were skipped (the fixture has one corrupt file), and --json carries the count', async () => {
    const r = await run(['status', '--since', 'all']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^1 session file skipped \(unreadable or not in Claude's format\)$/m);
    assert.deepEqual(JSON.parse((await run(['status', '--json', '--since', 'all'])).stdout).skipped, { registry: 1 });
  });

  test('(+) the line counts every skipped file, in the plural', async () => {
    const dir = path.join(fx.root, 'claude-skip3');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, 'sessions', `${n}.json`), '{broken');
    assert.match((await run(['status'], { CLAUDE_CONFIG_DIR: dir })).stdout, /^3 session files skipped \(unreadable or not in Claude's format\)$/m);
  });

  test('(−) nothing skipped: no such line', async () => {
    const dir = path.join(fx.root, 'claude-skip0');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions', '1.json'), JSON.stringify({ pid: 1, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }));
    const r = await run(['status'], { CLAUDE_CONFIG_DIR: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /skipped/);
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
        // the real path, as Claude records it (macOS temp folders sit behind a /var -> /private/var link): nika stores projects by realpath
        fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: fs.realpathSync(fx.plain), timestamp: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() })}\n${JSON.stringify({ type: 'ai-title', aiTitle: `worker-${i}`, sessionId: sid })}\n`);
        fs.utimesSync(file, new Date(Date.UTC(2026, 10, 1, 0, i)), new Date(Date.UTC(2026, 10, 1, 0, i)));
      }
      return { CLAUDE_CONFIG_DIR: dir };
    };

    // a folder added to nika is always listed; one that was never added shows only while something runs there (0.4.0, owner)
    const added = async (extra) => {
      const cfg = path.join(fx.root, `nika-config-${Math.random().toString(16).slice(2)}`);
      const r = await run(['projects', 'add', fx.plain], { ...extra, NIKA_CONFIG_DIR: cfg });
      assert.equal(r.code, 0, r.stderr);
      return { ...extra, NIKA_CONFIG_DIR: cfg };
    };

    test('(+) a folder never added to nika with only ended sessions is left out by default: one line counts it and says how to see it', async () => {
      const r = await run(['status', '--since', 'all'], sevenEnded());
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /^plain\s/m);
      assert.match(r.stdout, /^… 1 folder not added to nika, with only ended sessions, hidden \(nika status --ended\)$/m);
    });

    test('(+) --ended and --full list that folder again', async () => {
      for (const flag of ['--ended', '--full']) {
        const r = await run(['status', '--since', 'all', flag], sevenEnded());
        assert.match(r.stdout, /^plain\s.*ended 7$/m, flag);
        assert.doesNotMatch(r.stdout, /not added to nika/, flag);
      }
    });

    test('(−) a project added to nika is never left out, even with only ended sessions', async () => {
      const r = await run(['status', '--since', 'all'], await added(sevenEnded()));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^plain\s.*ended 7$/m);
      assert.doesNotMatch(r.stdout, /not added to nika/);
    });

    test('(+) a config.json nika cannot use is named in a note, since no project then counts as added', async () => {
      const cfg = path.join(fx.root, 'nika-config-bad');
      fs.mkdirSync(path.join(cfg, 'nika'), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'nika', 'config.json'), '{ not json');
      const r = await run(['status', '--since', 'all'], { ...sevenEnded(), NIKA_CONFIG_DIR: cfg });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^note: config\.json: /m);
    });

    test('(+) with --ended the same bad config.json gives the same note (the project list is read in every text view)', async () => {
      const cfg = path.join(fx.root, 'nika-config-bad2');
      fs.mkdirSync(path.join(cfg, 'nika'), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'nika', 'config.json'), '{ not json');
      const r = await run(['status', '--since', 'all', '--ended'], { ...sevenEnded(), NIKA_CONFIG_DIR: cfg });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^note: config\.json: /m);
      assert.match(r.stdout, /^plain\s/m);
    });

    // G9 (0.4.0, owner 2026-11-14): an added project nobody has run a session in is still listed, like the app's sidebar
    describe('an added project with no sessions yet', () => {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const mkdir = (name) => {
        const dir = path.join(fx.root, name);
        fs.mkdirSync(dir, { recursive: true });
        return fs.realpathSync(dir);
      };
      const addedDirs = async (extra, ...dirs) => {
        const cfg = path.join(fx.root, `nika-config-${Math.random().toString(16).slice(2)}`);
        for (const d of dirs) {
          const r = await run(['projects', 'add', d], { ...extra, NIKA_CONFIG_DIR: cfg });
          assert.equal(r.code, 0, r.stderr);
        }
        return { ...extra, NIKA_CONFIG_DIR: cfg };
      };
      const emptyClaude = () => {
        const dir = path.join(fx.root, `claude-empty-${Math.random().toString(16).slice(2)}`);
        fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
        return { CLAUDE_CONFIG_DIR: dir };
      };

      test('(+) default view: its block comes after the groups and before the "not added" line', async () => {
        const dir = mkdir('acme-api');
        const r = await run(['status', '--since', 'all'], await addedDirs(sevenEnded(), dir));
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`^acme-api {2}${esc(dir)} {3}no sessions yet\\n\\n… 1 folder not added to nika`, 'm'));
      });

      test('(+) --ended and --full: after the groups too', async () => {
        const dir = mkdir('acme-api');
        for (const flag of ['--ended', '--full']) {
          const r = await run(['status', '--since', 'all', flag], await addedDirs(sevenEnded(), dir));
          assert.equal(r.code, 0, r.stderr);
          assert.match(r.stdout, new RegExp(`^acme-api {2}${esc(dir)} {3}no sessions yet$`, 'm'), flag);
          assert.ok(r.stdout.indexOf('plain') < r.stdout.indexOf('acme-api'), flag);
        }
      });

      test('(+) "No agents in the last 7d." still prints, and the empty projects follow it', async () => {
        const dir = mkdir('web-shop');
        const r = await run(['status'], await addedDirs(emptyClaude(), dir));
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`^No agents in the last 7d\\.\\n\\nweb-shop {2}${esc(dir)} {3}no sessions in the last 7d\\n`));
      });

      test('(+) --since 24h names the window: "no sessions in the last 24h", never "yet"', async () => {
        const dir = mkdir('acme-api');
        for (const flag of [[], ['--ended']]) {
          const r = await run(['status', '--since', '24h', ...flag], await addedDirs(emptyClaude(), dir));
          assert.equal(r.code, 0, r.stderr);
          assert.match(r.stdout, new RegExp(`^acme-api {2}${esc(dir)} {3}no sessions in the last 24h$`, 'm'), flag.join(' '));
          assert.doesNotMatch(r.stdout, /no sessions yet/, flag.join(' '));
        }
      });

      test('(+) --since all says "no sessions yet"', async () => {
        const dir = mkdir('acme-api');
        const r = await run(['status', '--since', 'all'], await addedDirs(emptyClaude(), dir));
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`^acme-api {2}${esc(dir)} {3}no sessions yet$`, 'm'));
        assert.doesNotMatch(r.stdout, /no sessions in the last/);
      });

      test('(−) a project that has a group is not printed twice', async () => {
        const r = await run(['status', '--since', 'all'], await addedDirs(sevenEnded(), fx.plain));
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout.match(/^plain\s/gm).length, 1);
        assert.doesNotMatch(r.stdout, /no sessions (yet|in the last)/);
      });

      test('(−) --json is the snapshot only: no empty project in it', async () => {
        const dir = mkdir('demo-api');
        const r = await run(['status', '--json', '--since', 'all'], await addedDirs(sevenEnded(), dir));
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout).groups.map((g) => g.label), ['plain']);
        assert.doesNotMatch(r.stdout, /no sessions (yet|in the last)|demo-api/);
      });

      test('(−) a broken config.json: no empty-project line, the note prints, exit 0', async () => {
        const cfg = path.join(fx.root, 'nika-config-bad3');
        fs.mkdirSync(path.join(cfg, 'nika'), { recursive: true });
        fs.writeFileSync(path.join(cfg, 'nika', 'config.json'), '{ not json');
        for (const args of [['status'], ['status', '--ended']]) {
          const r = await run(args, { ...emptyClaude(), NIKA_CONFIG_DIR: cfg });
          assert.equal(r.code, 0, r.stderr);
          assert.doesNotMatch(r.stdout, /no sessions (yet|in the last)/, args.join(' '));
          assert.match(r.stdout, /^note: config\.json: /m, args.join(' '));
          assert.match(r.stdout, /^No agents in the last 7d\.$/m, args.join(' '));
        }
      });
    });

    test('(+) by default no ended row is printed; the header still counts them and one line says how to see them', async () => {
      const r = await run(['status', '--since', 'all'], await added(sevenEnded()));
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

describe('renderStatus: folders not added to nika (0.4.0)', async () => {
  const { renderStatus, addedTo } = await import('../src/cli.js');
  const plainPaint = { busy: (s) => s, idle: (s) => s, other: (s) => s, ended: (s) => s, bold: (s) => s };
  const agent = (live) => ({ live, state: live ? 'busy' : 'ended', name: live ? 'builder-1' : 'old-run', modelLabel: 'Sonnet 5.5', worktree: null, gitBranch: 'master', pane: null, lastActivity: 0 });
  const group = (label, key, root, agents) => ({ label, key, root, agents, counts: { busy: agents.filter((a) => a.live).length, idle: 0, other: 0, ended: agents.filter((a) => !a.live).length } });
  const KEY_A = 'a'.repeat(16);
  const KEY_W = 'b'.repeat(16);
  const snapshot = {
    generatedAt: 0, since: '24h', sources: {}, skipped: { registry: 0 },
    groups: [
      group('acme-api', KEY_A, '/work/acme-api', [agent(false)]),     // added, only ended
      group('web-shop', KEY_W, '/work/web-shop', [agent(true)]),      // not added, live
      group('scratch-1', 'c'.repeat(16), '/work/scratch-1', [agent(false)]), // not added, only ended
      group('scratch-2', 'd'.repeat(16), '/work/scratch-2', [agent(false)]), // not added, only ended
    ],
  };
  const isAdded = addedTo([{ key: KEY_A, dir: '/work/acme-api', name: 'acme-api' }]);

  test('(+) an added project with only ended sessions and a live folder not added both show; the other folders are counted on one line', () => {
    const out = renderStatus(snapshot, { ended: false, full: false }, plainPaint, isAdded);
    assert.match(out, /^acme-api\s/m);
    assert.match(out, /^web-shop\s/m);
    assert.match(out, /builder-1/);
    assert.doesNotMatch(out, /^scratch-/m);
    assert.match(out, /^… 2 folders not added to nika, with only ended sessions, hidden \(nika status --ended\)$/m);
  });

  test('(+) a project counts as added by its folder too, not only by key', () => {
    const byDir = addedTo([{ key: 'e'.repeat(16), dir: '/work/scratch-1', name: 'scratch-1' }]);
    assert.equal(byDir(snapshot.groups[2]), true);
    assert.equal(byDir(snapshot.groups[3]), false);
  });

  test('(+) a project with no group prints "<name>  <dir>   no sessions in the last 24h" after the groups and before the "not added" line, once, in config order', () => {
    const projects = [
      { key: KEY_A, dir: '/work/acme-api', name: 'acme-api' },                  // has a group, by key
      { key: 'e'.repeat(16), dir: '/work/scratch-1', name: 'scratch-1' },       // has a group, by folder only
      { key: 'f'.repeat(16), dir: '/work/demo-api', name: 'demo-api' },         // no group
      { key: '1'.repeat(16), dir: '/work/gadget-ui', name: 'gadget-ui' },       // no group
    ];
    const out = renderStatus(snapshot, { ended: false, full: false }, plainPaint, addedTo(projects), projects);
    assert.equal(out.match(/no sessions in the last 24h/g).length, 2);
    assert.match(out, /^demo-api {2}\/work\/demo-api {3}no sessions in the last 24h\n\ngadget-ui {2}\/work\/gadget-ui {3}no sessions in the last 24h\n\n… \d folders? not added to nika/m);
    assert.doesNotMatch(out, /^(acme-api|scratch-1)\s.*no sessions/m);
    assert.ok(out.indexOf('web-shop') < out.indexOf('demo-api'));
  });

  test('(+) with the window "all" the line reads "no sessions yet", and "No agents" keeps printing when no group exists', () => {
    const projects = [{ key: 'f'.repeat(16), dir: '/work/demo-api', name: 'demo-api' }];
    const out = renderStatus({ ...snapshot, since: 'all', groups: [] }, { ended: false, full: false }, plainPaint, addedTo(projects), projects);
    assert.equal(out, 'No agents in the last all.\n\ndemo-api  /work/demo-api   no sessions yet\n');
  });

  test('(−) the name of an empty project goes through clean()', () => {
    const projects = [{ key: 'f'.repeat(16), dir: '/work/demo-api', name: 'demo\u001b[31m-api' }];
    const out = renderStatus(snapshot, { ended: true, full: false }, plainPaint, addedTo(projects), projects);
    assert.equal(out.includes('\u001b'), false);
    assert.match(out, /^demo-api\s/m);
  });

  test('(−) with --ended nothing is left out and no line says so', () => {
    const out = renderStatus(snapshot, { ended: true, full: false }, plainPaint, isAdded);
    for (const l of ['acme-api', 'web-shop', 'scratch-1', 'scratch-2']) assert.match(out, new RegExp(`^${l}\\s`, 'm'));
    assert.doesNotMatch(out, /not added to nika/);
  });
});

// --- R1 F2 (final review): `nika orchestrate` with a saved orchestrator asks the same question as the app tier -----------------------------
// The session registry reads live sessions; when it cannot be read a live pick would read "ended" and be resumed in a second claude.

describe('orchestrate: the session registry (R1 F2, the CLI)', () => {
  const PICK = '11111111-1111-4111-8111-111111111111';
  const worlds = [];
  after(() => worlds.forEach((w) => w.cleanup()));

  /** A temp world with a fake claude, a transcript for PICK (not running), and an in-memory tmux with no session. `sessions`: what to make of <claude dir>/sessions. */
  async function rig({ sessions, pick = PICK } = {}) {
    const w = await makeWorld();
    worlds.push(w);
    fs.mkdirSync(path.join(w.root, 'bin'));
    const claude = path.join(w.root, 'bin', 'claude');
    fs.writeFileSync(claude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const claudeDir = path.join(w.root, 'claude');
    const proj = path.join(claudeDir, 'projects', '-synthetic-project');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${PICK}.jsonl`), `${JSON.stringify({ type: 'user', cwd: w.project.dir, sessionId: PICK, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'synthetic' } })}\n`);
    if (sessions === 'dir') fs.mkdirSync(path.join(claudeDir, 'sessions'));
    if (sessions === 'file') fs.writeFileSync(path.join(claudeDir, 'sessions'), 'not a folder');
    if (pick) await setOrchestrator(w.project.key, pick, w.env);
    const tmux = fakeTmux({ panes: [] });
    // tmux answers from the in-memory server; ps and anything else fails like a missing binary (nika then falls back to signal 0)
    const exec = async (cmd, args) => {
      if (cmd === TMUX) return tmux(cmd, args);
      throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
    };
    const env = { ...w.env, PATH: '', CLAUDE_CONFIG_DIR: claudeDir, NIKA_TMUX: TMUX, NIKA_CLAUDE: claude, NO_COLOR: '1' };
    const run = async () => {
      const sink = () => Object.assign(new Writable({ write(chunk, enc, cb) { this.text += chunk; cb(); } }), { text: '', isTTY: false });
      const out = sink();
      const err = sink();
      const code = await main(['orchestrate', '--detached'], env, { out, err, in: Object.assign(Readable.from([]), { isTTY: false }), cwd: w.project.dir, home: os.tmpdir(), brewApps: [], sleep: async () => {}, exec });
      return { code, out: out.text, err: err.text };
    };
    const started = () => tmux.of('new-session').length + tmux.of('new-window').length;
    return { w, tmux, run, started, pick: () => getOrchestrator(w.project.key, w.env) };
  }

  test('(−) the sessions folder cannot be read (missing, or not a folder): index_unavailable, exit 1 (the 5xx exit), nothing started, the pick stays', async () => {
    for (const sessions of ['none', 'file']) {
      const r = await rig({ sessions });
      const res = await r.run();
      assert.equal(res.code, 1, `${sessions}: ${res.err}`);
      assert.match(res.err, /index_unavailable: nika couldn't check the saved orchestrator, so nothing was started/);
      assert.equal(res.out, '');
      assert.equal(r.started(), 0, `${sessions}: no pane, no claude`);
      assert.deepEqual(r.tmux.calls, [], `${sessions}: no tmux command at all`);
      assert.equal(await r.pick(), PICK);
    }
  });

  test('(+) the sessions folder reads fine (empty: the pick is not running): the ended pick is resumed with claude --resume, exit 0', async () => {
    const r = await rig({ sessions: 'dir' });
    const res = await r.run();
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /started a new orchestrator/);
    assert.equal(r.started(), 1);
    const argv = r.tmux.of('new-session')[0];
    assert.deepEqual(argv.slice(argv.indexOf('--') + 2, argv.indexOf('--') + 4), ['--resume', PICK]);
    assert.equal(await r.pick(), PICK);
  });

  test('(+) with no saved pick the registry does not matter: a fresh start runs although the sessions folder cannot be read', async () => {
    const r = await rig({ sessions: 'none', pick: null });
    const res = await r.run();
    assert.equal(res.code, 0, res.err);
    assert.equal(r.started(), 1);
  });
});

// --- 0.5.4 (RM): `nika status` leaves out what the user removed from the lists in the app, and says how many --------------------------------------
describe('status and removed rows (0.5.4)', () => {
  const REMOVED_LINE = /^\u2026 (\d+) removed from the list \(Show removed in the nika app\)$/m;
  const NOW = Date.now();
  let n = 0;
  /** A fresh state folder (the child's XDG_STATE_HOME) with the given session ids and folder keys removed; `file` writes the file as given instead. */
  async function removed({ sessions = [], groups = [], file } = {}) {
    n += 1;
    const dir = path.join(fx.root, `state-rm-${n}`);
    const extra = { XDG_STATE_HOME: dir };
    if (file !== undefined) {
      fs.mkdirSync(path.join(dir, 'nika'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'nika', HIDDEN_FILE), file);
    }
    for (const id of sessions) await hideSession(id, extra, { now: NOW - 1000 });
    for (const key of groups) await hideGroup(key, extra, { now: NOW - 1000 });
    return extra;
  }
  const rows = (snap) => snap.groups.flatMap((g) => g.agents.map((a) => a.id));
  const json = async (extra) => JSON.parse((await run(['status', '--json', '--since', 'all'], extra)).stdout);

  test('(+) a removed session is left out of --json and counted, per group and in total', async () => {
    const base = await json();
    assert.ok(rows(base).includes(SID.ended));
    assert.equal(base.hidden, 0);
    const snap = await json(await removed({ sessions: [SID.ended] }));
    assert.ok(!rows(snap).includes(SID.ended));
    assert.equal(snap.hidden, 1);
    assert.equal(snap.groups.find((g) => g.label === 'repo').hidden, 1);
  });

  test('(+) the text view leaves the row out and prints one line: how many are removed and where to bring them back', async () => {
    const base = await run(['status', '--since', 'all', '--ended']);
    assert.match(base.stdout, /review-old/);
    assert.doesNotMatch(base.stdout, REMOVED_LINE);
    const r = await run(['status', '--since', 'all', '--ended'], await removed({ sessions: [SID.ended] }));
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /review-old/);
    assert.equal(r.stdout.match(REMOVED_LINE)[1], '1');
  });

  test('(+) a removed folder that is not a project is left out as a whole', async () => {
    const key = (await json()).groups.find((g) => g.label === 'plain').key;
    const snap = await json(await removed({ groups: [key] }));
    assert.deepEqual(snap.groups.map((g) => g.label), ['repo']);
    assert.equal(snap.hidden, 1);
  });

  test('(+) a folder added to nika keeps its rows although the folder is removed (the child reads nika\'s project list: its config has env)', async () => {
    // Claude records the real path of a folder; nika stores a project by its realpath, so the group's key is the project's key
    const dir = path.join(fx.root, 'claude-rmproj');
    const real = fs.realpathSync(fx.plain);
    const file = path.join(dir, 'projects', '-rmproj', 'abababab-abab-4bab-8bab-abababababab.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: real, timestamp: new Date(Date.UTC(2026, 10, 1)).toISOString() })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Ended work' })}\n`);
    const cfg = path.join(fx.root, 'nika-config-rm');
    const added = await run(['projects', 'add', fx.plain], { NIKA_CONFIG_DIR: cfg });
    assert.equal(added.code, 0, added.stderr);
    const extra = { ...(await removed({ groups: [keyFor(real)] })), CLAUDE_CONFIG_DIR: dir };
    const withProject = JSON.parse((await run(['status', '--json', '--since', 'all'], { ...extra, NIKA_CONFIG_DIR: cfg })).stdout);
    assert.equal(withProject.groups.length, 1, 'the project keeps its group and its row');
    assert.equal(withProject.hidden, 0);
    const without = JSON.parse((await run(['status', '--json', '--since', 'all'], { ...extra, NIKA_CONFIG_DIR: path.join(fx.root, 'nika-config-rm-none') })).stdout);
    assert.deepEqual(without.groups, [], 'the same folder, not a project: removed');
    assert.equal(without.hidden, 1);
  });

  test('(\u2212) nothing removed: no line, and --json carries hidden 0', async () => {
    const r = await run(['status', '--since', 'all', '--ended']);
    assert.doesNotMatch(r.stdout, /removed from the list/);
    assert.equal((await json()).hidden, 0);
  });

  test('(\u2212) a hidden.json that cannot be read hides nothing: every row, exit 0, one warning on stderr', async () => {
    const r = await run(['status', '--since', 'all', '--ended'], await removed({ file: '{ not json' }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /review-old/);
    assert.doesNotMatch(r.stdout, /removed from the list/);
    assert.match(r.stderr, /hidden\.json is not valid JSON/);
  });

  test('(\u2212) a removed id nobody has changes nothing and counts nothing', async () => {
    const snap = await json(await removed({ sessions: ['99999999-9999-4999-8999-999999999999'] }));
    assert.equal(snap.hidden, 0);
    assert.ok(rows(snap).includes(SID.ended));
  });
});

describe('renderStatus: the removed line (0.5.4)', async () => {
  const { renderStatus, addedTo } = await import('../src/cli.js');
  const plainPaint = { busy: (s) => s, idle: (s) => s, other: (s) => s, ended: (s) => s, bold: (s) => s };
  const snap = (extra) => ({ generatedAt: 0, since: '7d', sources: { registry: 'bad' }, skipped: { registry: 0 }, groups: [], ...extra });

  test('(+) a count above zero adds the line after the folder lines and before the notes; one, singular and plural alike', () => {
    const out = renderStatus(snap({ hidden: 3 }), { ended: false, full: false }, plainPaint);
    assert.match(out, /^\u2026 3 removed from the list \(Show removed in the nika app\)$/m);
    assert.ok(out.indexOf('removed from the list') < out.indexOf('note: registry'), 'before the notes');
    assert.match(renderStatus(snap({ hidden: 1 }), { ended: false, full: false }, plainPaint), /^\u2026 1 removed from the list/m);
  });

  test('(+) with every row removed it still says "No agents" and then the line', () => {
    const out = renderStatus(snap({ hidden: 2 }), { ended: false, full: false }, plainPaint);
    assert.match(out, /^No agents in the last 7d\.$/m);
    assert.match(out, /^\u2026 2 removed/m);
  });

  test('(\u2212) zero, a missing count and anything that is not a whole number print nothing', () => {
    for (const hidden of [0, undefined, null, -1, 1.5, '3', NaN]) {
      assert.doesNotMatch(renderStatus(snap({ hidden }), { ended: false, full: false }, plainPaint), /removed from the list/, String(hidden));
    }
  });

  test('(\u2212) addedTo is the one in src/store.js (the collector and the CLI share it)', async () => {
    const store = await import('../src/store.js');
    assert.equal(addedTo, store.addedTo);
  });
});

describe('renderStatus: the pane cell is <window>:<pane> (0.5.4, P1)', async () => {
  const { renderStatus } = await import('../src/cli.js');
  const plainPaint = { busy: (s) => s, idle: (s) => s, other: (s) => s, ended: (s) => s, bold: (s) => s };
  const snap = (pane) => ({
    generatedAt: 0, since: '24h', sources: {}, skipped: { registry: 0 },
    groups: [{ label: 'acme-api', key: 'a'.repeat(16), root: '/work/acme-api', counts: { busy: 1, idle: 0, other: 0, ended: 0 },
      agents: [{ live: true, state: 'busy', name: 'builder-1', modelLabel: 'Sonnet 5.5', worktree: null, gitBranch: 'master', pane, lastActivity: 0 }] }],
  });
  const row = (pane) => renderStatus(snap(pane), { ended: false, full: false }, plainPaint).split('\n').find((l) => l.includes('builder-1'));

  test('(+) a valid window index is shown before the pane id, and the column keeps its width of 9 for every row', () => {
    assert.match(row({ id: '%14', windowIndex: '1' }), / 1:%14 {5}\S/);
    assert.match(row({ id: '%14', windowIndex: '42' }), / 42:%14 {4}\S/);
    assert.match(row({ id: '%14', windowIndex: '999999' }), / 999999:%\u2026 \S/, 'six digits are accepted; the 9-wide cell cuts what does not fit');
    assert.match(row({ id: '%14' }), / %14 {7}\S/, 'no window index: the pane id alone, in the same width');
    assert.equal(row(null).length, row({ id: '%14', windowIndex: '1' }).length, 'no pane: an empty cell of the same width');
    assert.equal(row({ id: '%14' }).length, row({ id: '%14', windowIndex: '1' }).length);
  });

  test('(\u2212) a window index that is not 1 to 6 digits is left out, whatever else the snapshot says', () => {
    for (const windowIndex of ['x', '1;2', '1234567', '', '-1', '1\n2', ' 1', 1, null, undefined, {}, ['1']]) {
      assert.match(row({ id: '%14', windowIndex }), / %14 {7}\S/, JSON.stringify(windowIndex));
      assert.doesNotMatch(row({ id: '%14', windowIndex }), /:%14/, JSON.stringify(windowIndex));
    }
  });
});

// `nika status` is `collect({ exec: makeExec() })` then `renderStatus` (src/cli.js, the status command). The binary cannot be driven with a fake `ps` (the collector calls
// /bin/ps by absolute path), so this runs the same two functions: the real collector over the fixture with an injected exec, then the real renderer on its snapshot.
describe('nika status: the window index comes from the collector, end to end (0.5.4, P1)', async () => {
  const { renderStatus } = await import('../src/cli.js');
  const plainPaint = { busy: (s) => s, idle: (s) => s, other: (s) => s, ended: (s) => s, bold: (s) => s };
  const DAY = 86_400_000;
  const statusLine = async (index, name) => {
    const tmuxLines = [`%5\twork\t${index}\t[%5] build-7-1\tzsh`, '%6\twork\t2\tidle-pane\tclaude', '%7\twork\t3\t[%7] lazygit pane\tlazygit'];
    const { snapshot } = await collect({ config: fx.config, exec: fakeExec({ tmuxLines }), now: NOW, sinceMs: 7 * DAY });
    return renderStatus(snapshot, { ended: false, full: false }, plainPaint).split('\n').find((l) => l.includes(name));
  };

  test('(+) the live agent\'s row reads <window>:<pane> for the index tmux printed', async () => {
    const cells = async (index) => (await statusLine(index, 'build-7-1')).trim().split(/\s+/);
    assert.ok((await cells('1')).includes('1:%5'), 'window 1');
    assert.ok((await cells('12')).includes('12:%5'), 'window 12');
    assert.equal((await statusLine('12', 'build-7-1')).length, (await statusLine('1', 'build-7-1')).length, 'the column keeps its width');
  });

  test('(\u2212) a malformed index falls back to the pane id alone, in the same column width', async () => {
    const good = await statusLine('1', 'build-7-1');
    for (const index of ['x', '1;2', '1234567', '', '-1', ' 1']) {
      const line = await statusLine(index, 'build-7-1');
      assert.ok(line.trim().split(/\s+/).includes('%5'), JSON.stringify(index));
      assert.doesNotMatch(line, /:%5/, JSON.stringify(index));
      assert.equal(line.length, good.length, JSON.stringify(index));
    }
  });
});
