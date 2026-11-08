// spawnAgent, runAgent and the dashboard hook for nika's own report dirs; in-memory tmux, injected spawn, temp dirs,
// synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnAgent, runAgent } from '../src/spawn.js';
import { startOrchestrator } from '../src/orchestrate.js';
import { reportsDir } from '../src/paths.js';
import { addProject } from '../src/store.js';
import { ensureDir, writeAtomic } from '../src/fwrite.js';
import { collect } from '../src/model.js';
import { indexReports } from '../src/collect/reports.js';
import { fakeTmux, makeWorld, TMUX, CLAUDE, NIKA_ARGV } from './tmux-fake.js';
import { makeFixture, cleanup, fakeExec, SID, NOW } from './helpers.js';

const worlds = [];
const world = async (settings) => {
  const w = await makeWorld(settings);
  worlds.push(w);
  return w;
};
after(() => worlds.forEach((w) => w.cleanup()));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIST_ALL = [TMUX, '-u', 'list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}\t#{@nika-role}'];
const DENY_SETTINGS = '{"permissions":{"deny":["Read(**/.env*)","Edit(**/.env*)","Read(**/*.key)","Edit(**/*.key)"]}}';
const DENIED = ['Bash(nika:*)', 'Bash(tmux:*)', 'Bash(claude:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)'];
const BASE_PANES = () => [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude' }];

const rd = (w) => reportsDir(w.project.key, w.env);
const req = (w, over = {}) => ({ project: w.project.key, name: 'builder-1', model: 'sonnet', brief: 'Do the thing.', ...over });
const mode = (p) => fs.statSync(p).mode & 0o777;
const read = (w, file) => fs.readFileSync(path.join(rd(w), file), 'utf8');
const exists = (w, file) => fs.existsSync(path.join(rd(w), file));
async function put(w, file, content) {
  await ensureDir(rd(w));
  await writeAtomic(rd(w), file, content);
}

describe('spawnAgent: placement and files', () => {
  test('(+) beside: argv snapshot, files 0600 in a 0700 dir, started map, response shape', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual(r, {
      status: 200,
      body: { pane: '%20', session: 'My-App', sessionId: null, reports: { dir: rd(w), session: 'builder-1.session', report: 'builder-1.md', rc: 'builder-1.rc', remote: 'builder-1.remote' } },
    });
    assert.deepEqual(exec.calls, [
      LIST_ALL,
      [TMUX, '-u', 'split-window', '-h', '-t', '=My-App:', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, 'builder-1'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'agent'],
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] builder-1'],
    ]);
    assert.equal(mode(rd(w)), 0o700);
    assert.deepEqual(fs.readdirSync(rd(w)).sort(), ['.last-pane', 'builder-1.agent.json', 'builder-1.brief.md']);
    for (const f of fs.readdirSync(rd(w))) assert.equal(mode(path.join(rd(w), f)), 0o600, f);
    assert.equal(read(w, 'builder-1.brief.md'), 'Do the thing.');
    assert.deepEqual(JSON.parse(read(w, 'builder-1.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '' });
    assert.equal(read(w, '.last-pane'), '%20\n');
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'builder-1', sessionId: null, role: 'agent' });
    assert.equal(exec.panes.find((p) => p.id === '%20').title, '[%20] builder-1');
    assert.equal(exec.panes.find((p) => p.id === '%20').role, 'agent');
  });

  test('(−) an agent split into the orchestrator window is tagged agent: the orchestrator lookup never returns it', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'zsh', role: 'orchestrator' }] });
    assert.equal((await spawnAgent(req(w), w.ctx(exec))).status, 200);
    const r = await startOrchestrator(w.project.key, w.ctx(exec)); // the agent pane runs node in the same window
    assert.deepEqual([r.body.created, exec.of('new-window').length], [true, 1]);
    assert.notEqual(r.body.pane, '%20');
  });

  test('(+) the brief and nothing from the request body reach tmux argv beyond the validated ids', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    await spawnAgent(req(w, { brief: 'SECRET-BRIEF-MARKER $(id) `x` ; rm -rf' }), w.ctx(exec));
    assert.ok(!JSON.stringify(exec.calls).includes('SECRET-BRIEF-MARKER'));
    assert.equal(read(w, 'builder-1.brief.md'), 'SECRET-BRIEF-MARKER $(id) `x` ; rm -rf');
  });

  test('(+) under-last: the next agent goes below the last spawned pane (-v -t %n)', async () => {
    const w = await world({ panePlacement: 'under-last' });
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    assert.equal((await spawnAgent(req(w, { name: 'one' }), ctx)).status, 200);
    assert.equal(exec.of('split-window')[0][1], '-h'); // no .last-pane yet → beside
    const r = await spawnAgent(req(w, { name: 'two' }), ctx);
    assert.equal(r.body.pane, '%21');
    assert.deepEqual(exec.of('split-window')[1].slice(1, 4), ['-v', '-t', '%20']);
    assert.equal(read(w, '.last-pane'), '%21\n');
  });

  test('(−) under-last falls back to beside when .last-pane is dead, in another session, garbage or a symlink', async () => {
    const w = await world({ panePlacement: 'under-last' });
    const panes = [...BASE_PANES(), { id: '%50', session: 'elsewhere', window: 0, windowName: 'x', command: 'zsh' }];
    const outside = path.join(w.root, 'outside');
    fs.writeFileSync(outside, '%1\n');
    let i = 0;
    for (const content of ['%99\n', '%50\n', '$(id)\n', null]) {
      const exec = fakeTmux({ panes: panes.map((p) => ({ ...p })) });
      const name = `a${i += 1}`;
      fs.rmSync(path.join(rd(w), '.last-pane'), { force: true });
      if (content === null) {
        await ensureDir(rd(w));
        fs.symlinkSync(outside, path.join(rd(w), '.last-pane'));
      } else await put(w, '.last-pane', content);
      const r = await spawnAgent(req(w, { name }), w.ctx(exec));
      assert.equal(r.status, 200, JSON.stringify(content));
      assert.deepEqual(exec.of('split-window')[0].slice(1, 4), ['-h', '-t', '=My-App:'], JSON.stringify(content));
      fs.rmSync(path.join(rd(w), '.last-pane'), { force: true });
    }
  });

  test('(+) explicit under pane: -v -t %n and the session of that pane', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [...BASE_PANES(), { id: '%7', session: 'other', window: 0, windowName: 'x', command: 'zsh' }] });
    const r = await spawnAgent(req(w, { under: '%7' }), w.ctx(exec));
    assert.equal(r.status, 200);
    assert.equal(r.body.session, 'other');
    assert.deepEqual(exec.of('split-window')[0].slice(0, 4), ['split-window', '-v', '-t', '%7']);
    assert.equal((await spawnAgent(req(w, { name: 'b', under: '%7', session: 'other' }), w.ctx(exec))).status, 200);
  });

  test('(−) under pane unknown → 404; under pane in a different session than `session` → 400; nothing written or split', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    assert.equal((await spawnAgent(req(w, { under: '%77' }), w.ctx(exec))).status, 404);
    const mismatch = await spawnAgent(req(w, { under: '%1', session: 'other' }), w.ctx(exec));
    assert.deepEqual([mismatch.status, mismatch.body.error], [400, 'invalid']);
    assert.equal(exec.of('split-window').length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
  });

  test('(+) explicit session: =other: ; (−) a session that does not exist → 404 telling to start the orchestrator', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [...BASE_PANES(), { id: '%7', session: 'other', window: 0, windowName: 'x', command: 'zsh' }] });
    const ok = await spawnAgent(req(w, { session: 'other' }), w.ctx(exec));
    assert.equal(ok.body.session, 'other');
    assert.equal(exec.of('split-window')[0][3], '=other:');
    const none = await spawnAgent(req(w, { name: 'x', session: 'nope' }), w.ctx(exec));
    assert.deepEqual([none.status, none.body.error], [404, 'not_found']);
    assert.match(none.body.message, /orchestrator/);
    // the default session is the project's orchestrator session; without it there is nowhere to go
    const alone = await spawnAgent(req(w, { name: 'y' }), w.ctx(fakeTmux({ panes: [{ id: '%7', session: 'other' }] })));
    assert.equal(alone.status, 404);
  });

  test('(+) settings: default permission mode comes from the settings, the request overrides it', async () => {
    const w = await world({ permissionMode: 'acceptEdits' });
    const exec = fakeTmux({ panes: BASE_PANES() });
    await spawnAgent(req(w, { name: 'one' }), w.ctx(exec));
    await spawnAgent(req(w, { name: 'two', permissionMode: 'plan' }), w.ctx(exec));
    assert.equal(JSON.parse(read(w, 'one.agent.json')).permissionMode, 'acceptEdits');
    assert.equal(JSON.parse(read(w, 'two.agent.json')).permissionMode, 'plan');
  });

  test('(+) Remote Control name: <prefix>-<name> reduced to RC_PREFIX, project name when the prefix is empty, `rc` overrides', async () => {
    const w = await world({ remoteControl: { enabled: true, prefix: '' } });
    const rc = async (over) => {
      const exec = fakeTmux({ panes: BASE_PANES() });
      await spawnAgent(req(w, over), w.ctx(exec));
      return JSON.parse(read(w, `${over.name ?? 'builder-1'}.agent.json`)).rc;
    };
    assert.equal(await rc({}), 'my-app-builder-1');
    assert.equal(await rc({ name: 'a-very-long-agent-name' }), 'my-app-a-very-long-agent-name'); // never cut to 20
    assert.equal(await rc({ name: 'off', rc: 'off' }), '');
    assert.equal(await rc({ name: 'qa', rc: 'team1' }), 'team1-qa');
  });

  test('(+) the prefix is reduced to RC_PREFIX (≤ 20), the whole name stays valid RC_NAME (≤ 64) even at the longest', async () => {
    const w = await world({ remoteControl: { enabled: true, prefix: '' } });
    const long = path.join(w.root, 'Project.With_a very-long-name 2026');
    fs.mkdirSync(long);
    const p = await addProject(long, w.env);
    const exec = fakeTmux({ panes: [{ id: '%1', session: 'Project-With_a-very-long-name-2026', window: 0, windowName: 'orchestrator', command: 'claude' }] });
    const name = 'n'.repeat(40);
    assert.equal((await spawnAgent(req(w, { project: p.key, name }), w.ctx(exec))).status, 200);
    const rc = JSON.parse(fs.readFileSync(path.join(reportsDir(p.key, w.env), `${name}.agent.json`), 'utf8')).rc;
    assert.equal(rc, `project-with-a-very-${name}`); // 19 + 1 + 40 = 60 chars
    assert.match(rc, /^[a-z0-9][a-z0-9-]{0,63}$/);
    // a configured prefix and req.rc are used as the prefix, reduced the same way
    const cfg = await world({ remoteControl: { enabled: true, prefix: 'team1' } });
    await spawnAgent(req(cfg), cfg.ctx(fakeTmux({ panes: BASE_PANES() })));
    assert.equal(JSON.parse(read(cfg, 'builder-1.agent.json')).rc, 'team1-builder-1');
  });

  test('(−) Remote Control off (the default) writes an empty rc: _run-agent passes no --remote-control', async () => {
    const w = await world();
    await spawnAgent(req(w), w.ctx(fakeTmux({ panes: BASE_PANES() })));
    assert.equal(JSON.parse(read(w, 'builder-1.agent.json')).rc, '');
  });
});

describe('spawnAgent: refusals', () => {
  test('(−) invalid requests → 400 invalid, no tmux call, no file', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const big = 'x'.repeat(64 * 1024 + 1);
    const bad = [
      null, 'x', [],
      { project: 'nope' }, { project: undefined },
      { name: 'Bad Name' }, { name: '-x' }, { name: 'a'.repeat(41) }, { name: '../x' }, { name: '' }, { name: 5 },
      { model: 'gpt-5' }, { model: 'claude-' }, { model: undefined }, { model: 'opus; ls' },
      { brief: '' }, { brief: '  \n' }, { brief: 5 }, { brief: 'a\0b' }, { brief: big }, { brief: 'é'.repeat(32 * 1024 + 1) },
      { permissionMode: 'yolo' }, { permissionMode: 5 },
      { under: '%x' }, { under: 'x' }, { under: 7 },
      { session: '-t' }, { session: 'a:b' }, { session: 'a.b' }, { session: '' },
      { rc: 'UPPER' }, { rc: '-x' }, { rc: 5 }, { rc: 'x'.repeat(21) },
    ];
    for (const over of bad) {
      const r = await spawnAgent(over && typeof over === 'object' && !Array.isArray(over) ? req(w, over) : over, w.ctx(exec));
      assert.deepEqual([r.status, r.body.error], [400, 'invalid'], JSON.stringify(over)?.slice(0, 60));
    }
    assert.deepEqual((await spawnAgent({}, w.ctx(exec))).body.error, 'invalid');
    assert.equal(exec.calls.length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
  });

  test('(+) a brief of exactly 64 KB (bytes) is accepted', async () => {
    const w = await world();
    const r = await spawnAgent(req(w, { brief: 'é'.repeat(32 * 1024) }), w.ctx(fakeTmux({ panes: BASE_PANES() })));
    assert.equal(r.status, 200);
    assert.equal(fs.statSync(path.join(rd(w), 'builder-1.brief.md')).size, 64 * 1024);
  });

  test('(−) bypassPermissions is refused with 400, nothing is called or written', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const r = await spawnAgent(req(w, { permissionMode: 'bypassPermissions' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [400, 'invalid']);
    assert.match(r.body.message, /bypassPermissions/);
    assert.equal(exec.calls.length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
  });

  test('(−) unregistered project → 404', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const r = await spawnAgent(req(w, { project: '0123456789abcdef' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
    assert.equal(exec.calls.length, 0);
  });

  test('(−) tmux missing → 503 tmux_unavailable: no binary, binary not runnable, or no server running', async () => {
    const w = await world();
    for (const [exec, extra] of [[fakeTmux(), { tmuxBin: null }], [fakeTmux({ enoent: true }), {}], [fakeTmux(), {}]]) {
      const r = await spawnAgent(req(w), w.ctx(exec, extra));
      assert.deepEqual([r.status, r.body.error], [503, 'tmux_unavailable']);
    }
    assert.equal(fs.existsSync(rd(w)), false);
  });

  test('(−) claude missing → 503 claude_unavailable before any tmux call', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const r = await spawnAgent(req(w), w.ctx(exec, { claudeBin: null }));
    assert.deepEqual([r.status, r.body.error], [503, 'claude_unavailable']);
    assert.equal(exec.calls.length, 0);
  });

  test('(−) a bad nikaArgv is a 500, not a split-window with a broken command', async () => {
    const w = await world();
    for (const nikaArgv of [undefined, [], [''], ['/usr/bin/node', 5], 'nika']) {
      const exec = fakeTmux({ panes: BASE_PANES() });
      const r = await spawnAgent(req(w), w.ctx(exec, { nikaArgv }));
      assert.deepEqual([r.status, r.body.error], [500, 'internal']);
      assert.equal(exec.calls.length, 0);
    }
  });

  test('(−) split-window failing → 502 tmux_failed; no pane is recorded, no .last-pane', async () => {
    const w = await world();
    const ctx = w.ctx(fakeTmux({ panes: BASE_PANES(), failOn: ['split-window'] }));
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.equal(ctx.started.size, 0);
    assert.equal(exists(w, '.last-pane'), false);
  });

  test('(−) tmux printing something that is not a pane id → 502', async () => {
    const w = await world();
    const inner = fakeTmux({ panes: BASE_PANES() });
    const exec = async (cmd, args) => (args[1] === 'split-window' ? { stdout: '%1; ls\n', stderr: '' } : inner(cmd, args));
    const ctx = w.ctx(exec);
    assert.equal((await spawnAgent(req(w), ctx)).status, 502);
    assert.equal(ctx.started.size, 0);
  });

  test('(+) set-option failing only costs the tag: the agent is running, the answer is 200', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES(), failOn: ['set-option'] });
    const r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.pane], [200, '%20']);
    assert.equal(exec.of('select-pane').length, 1);
  });

  test('(+) select-pane failing only costs the title: the agent is running, the answer is 200', async () => {
    const w = await world();
    const r = await spawnAgent(req(w), w.ctx(fakeTmux({ panes: BASE_PANES(), failOn: ['select-pane'] })));
    assert.equal(r.status, 200);
    assert.equal(r.body.pane, '%20');
  });

  test('(−) a symlinked reports dir or brief target is refused (500), nothing is split', async () => {
    const w = await world();
    const elsewhere = path.join(w.root, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.mkdirSync(path.dirname(rd(w)), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, rd(w));
    let exec = fakeTmux({ panes: BASE_PANES() });
    let r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [500, 'internal']);
    assert.match(r.body.message, /ESYMLINK/);
    assert.equal(exec.of('split-window').length, 0);
    assert.deepEqual(fs.readdirSync(elsewhere), []);

    fs.unlinkSync(rd(w));
    fs.mkdirSync(rd(w), { mode: 0o700 });
    const victim = path.join(w.root, 'victim');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(rd(w), 'builder-1.brief.md'));
    exec = fakeTmux({ panes: BASE_PANES() });
    r = await spawnAgent(req(w), w.ctx(exec));
    assert.equal(r.status, 500);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
    assert.equal(exec.of('split-window').length, 0);
  });
});

describe('spawnAgent: limits and conflicts', () => {
  const live = (names, from = 31) => names.map((n, i) => ({ id: `%${from + i}`, session: 'My-App', window: 0, windowName: 'zsh', command: 'node', n }));

  test('(−) maxAgents live agents (their .pane files point at live panes) → 409 limit; nothing is written for the new one', async () => {
    const w = await world();
    for (const [i, n] of ['a', 'b', 'c'].entries()) await put(w, `${n}.pane`, `%${31 + i}\n`);
    const exec = fakeTmux({ panes: [...BASE_PANES(), ...live(['a', 'b', 'c'])] });
    const r = await spawnAgent(req(w, { name: 'd' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [409, 'limit']);
    assert.equal(exec.of('split-window').length, 0);
    assert.equal(exists(w, 'd.brief.md'), false);
  });

  test('(+) panes that are gone do not count; another project\'s agents do not count; limit follows the settings', async () => {
    const w = await world();
    await put(w, 'a.pane', '%31\n');
    await put(w, 'b.pane', '%98\n'); // dead pane
    await put(w, 'c.pane', '%99\n'); // dead pane
    await put(w, 'junk.pane', 'not a pane\n');
    const other = path.join(w.root, 'other-project');
    fs.mkdirSync(other);
    const op = await addProject(other, w.env);
    for (const n of ['x', 'y', 'z']) {
      await ensureDir(reportsDir(op.key, w.env));
      await writeAtomic(reportsDir(op.key, w.env), `${n}.pane`, '%31\n');
    }
    const ctx = w.ctx(fakeTmux({ panes: [...BASE_PANES(), ...live(['a'])] }));
    assert.equal((await spawnAgent(req(w, { name: 'd' }), ctx)).status, 200);
    assert.equal((await spawnAgent(req(w, { name: 'e' }), ctx)).status, 200);
    assert.equal((await spawnAgent(req(w, { name: 'f' }), ctx)).body.error, 'limit'); // a, d, e live
  });

  test('(−) agents started in this process count before their .pane file exists; stale started entries are dropped', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const exec = fakeTmux({ panes: [...BASE_PANES(), ...live(['a', 'b'])] });
    const started = new Map([
      ['%31', { key: w.project.key, name: 'a', sessionId: null, role: 'agent' }],
      ['%32', { key: w.project.key, name: 'b', sessionId: null, role: 'agent' }],
      ['%1', { key: w.project.key, name: 'orchestrator', sessionId: null, role: 'orchestrator' }], // never counts
      ['%90', { key: w.project.key, name: 'gone', sessionId: null, role: 'agent' }], // pane is gone
    ]);
    const ctx = w.ctx(exec, { started });
    assert.equal((await spawnAgent(req(w, { name: 'c' }), ctx)).body.error, 'limit');
    assert.equal(started.has('%90'), false);
    assert.equal(started.has('%1'), true);
  });

  test('(−) two spawns at once with maxAgents 1: one wins, one is 409 limit (spawns of a project are serialised)', async () => {
    const w = await world({ limits: { maxAgents: 1 } });
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    const results = await Promise.all([spawnAgent(req(w, { name: 'a' }), ctx), spawnAgent(req(w, { name: 'b' }), ctx)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(exec.of('split-window').length, 1);
  });

  test('(−) a live agent with the same name → 409 conflict (file or in-process record); a dead one is replaced', async () => {
    const w = await world();
    await put(w, 'builder-1.pane', '%31\n');
    const exec = fakeTmux({ panes: [...BASE_PANES(), ...live(['builder-1'])] });
    let r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [409, 'conflict']);
    const started = new Map([['%31', { key: w.project.key, name: 'builder-1', sessionId: null, role: 'agent' }]]);
    fs.rmSync(path.join(rd(w), 'builder-1.pane'));
    r = await spawnAgent(req(w), w.ctx(exec, { started }));
    assert.equal(r.body.error, 'conflict');
    await put(w, 'builder-1.pane', '%98\n'); // pane died
    r = await spawnAgent(req(w), w.ctx(fakeTmux({ panes: BASE_PANES() })));
    assert.equal(r.status, 200);
  });
});

// --- runAgent -----------------------------------------------------------------------------------------------------

function fakeSpawn({ code = 0, signal = null, error = null, throws = null } = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (throws) throw throws;
    const child = new EventEmitter();
    setImmediate(() => (error ? child.emit('error', error) : child.emit('exit', signal ? null : code, signal)));
    return child;
  };
  fn.calls = calls;
  return fn;
}
const sink = () => {
  const lines = [];
  return { write: (s) => lines.push(s), lines };
};

/** A spawned agent's stored files, written by the real spawnAgent. */
async function prepared(over = {}, settings) {
  const w = await world(settings);
  const r = await spawnAgent(req(w, over), w.ctx(fakeTmux({ panes: BASE_PANES() })));
  assert.equal(r.status, 200);
  const run = async (extra = {}, env = {}) => {
    const spawn = extra.spawn ?? fakeSpawn();
    const stderr = sink();
    const code = await runAgent(over.project ?? w.project.key, over.name ?? 'builder-1', {
      env: { ...w.env, PATH: '/usr/bin', TMUX_PANE: '%20', ...env }, claudeBin: CLAUDE, spawn, stderr, ...extra,
    });
    return { code, spawn, stderr };
  };
  return { w, run, name: over.name ?? 'builder-1' };
}

describe('runAgent', () => {
  test('(+) default mode: records the session and runs claude with the exact argv (snapshot)', async () => {
    const { w, run } = await prepared();
    const listeners = process.listenerCount('SIGINT');
    const { code, spawn, stderr } = await run();
    assert.equal(code, 0);
    assert.equal(process.listenerCount('SIGINT'), listeners);
    assert.deepEqual(stderr.lines, []);
    const sid = read(w, 'builder-1.session').trim();
    assert.match(sid, UUID);
    assert.equal(read(w, 'builder-1.session'), `${sid}\n`);
    assert.equal(read(w, 'builder-1.remote'), '');
    assert.equal(read(w, 'builder-1.rc'), '0\n'); // claude's exit code, written after it exited
    assert.equal(read(w, 'builder-1.pane'), '%20\n');
    for (const f of ['builder-1.session', 'builder-1.remote', 'builder-1.rc', 'builder-1.pane']) assert.equal(mode(path.join(rd(w), f)), 0o600, f);

    assert.equal(spawn.calls.length, 1);
    const [{ cmd, args, opts }] = spawn.calls;
    assert.equal(cmd, CLAUDE);
    assert.equal(opts.stdio, 'inherit');
    assert.equal(opts.shell, false);
    const guard = args[args.indexOf('--append-system-prompt') + 1];
    assert.ok(guard.includes('"builder-1"') && guard.includes(path.join(rd(w), 'builder-1.md')) && !guard.includes('{{'));
    assert.match(guard, /never run nika, tmux or claude/i);
    assert.match(guard, /git add, git commit or git push/);
    assert.deepEqual(args, [
      '--session-id', sid, '--model', 'sonnet', '-n', 'builder-1', '--add-dir', rd(w), '--append-system-prompt', guard,
      '--settings', DENY_SETTINGS, '--disallowedTools', ...DENIED, '--', 'Do the thing.',
    ]);
  });

  test('(+) permission mode and Remote Control come after --model and -n; .remote holds the RC name', async () => {
    const { w, run } = await prepared({}, { permissionMode: 'plan', remoteControl: { enabled: true, prefix: '' } });
    const { spawn } = await run();
    const sid = read(w, 'builder-1.session').trim();
    const args = spawn.calls[0].args;
    assert.deepEqual(args.slice(0, 9), ['--session-id', sid, '--model', 'sonnet', '--permission-mode', 'plan', '-n', 'builder-1', '--remote-control=my-app-builder-1']);
    assert.equal(args[9], '--add-dir');
    assert.equal(read(w, 'builder-1.remote'), 'my-app-builder-1\n');
  });

  test('(+) every permission mode but default is passed through; default passes no flag', async () => {
    for (const permissionMode of ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk']) {
      const { run } = await prepared({ permissionMode });
      const { spawn } = await run();
      assert.deepEqual(spawn.calls[0].args.slice(4, 6), ['--permission-mode', permissionMode]);
    }
    const { run } = await prepared({ permissionMode: 'default' });
    assert.ok(!(await run()).spawn.calls[0].args.includes('--permission-mode'));
  });

  test('(+) the brief is one element after `--` even when it looks like a flag or spans lines', async () => {
    const brief = '--dangerously-skip-permissions\nline two; $(id)';
    const { run } = await prepared({ brief });
    const { spawn } = await run();
    const args = spawn.calls[0].args;
    assert.equal(args.at(-1), brief);
    assert.equal(args.at(-2), '--');
    assert.ok(!args.slice(0, -2).includes('--dangerously-skip-permissions'));
  });

  test('(+) resolves with claude\'s exit code; killed by a signal → 128 + signal number', async () => {
    const { run } = await prepared();
    assert.equal((await run({ spawn: fakeSpawn({ code: 7 }) })).code, 7);
    assert.equal((await run({ spawn: fakeSpawn({ signal: 'SIGTERM' }) })).code, 143);
  });

  test('(−) a TMUX_PANE that is not a pane id writes no .pane file; claude still runs', async () => {
    for (const TMUX_PANE of ['%x', '$(id)', '%1234567', '', undefined, '%1\n%2']) {
      const { w, run } = await prepared();
      const { code, spawn } = await run({}, { TMUX_PANE });
      assert.equal(code, 0);
      assert.equal(spawn.calls.length, 1);
      assert.equal(exists(w, 'builder-1.pane'), false, String(TMUX_PANE));
    }
  });

  test('(−) invalid key or name → exit 3, nothing read, written or run', async () => {
    const { w, run } = await prepared();
    for (const [key, name] of [['../x', 'builder-1'], [w.project.key, '../x'], [w.project.key, 'Bad'], [w.project.key, ''], [5, 'a'], [w.project.key, undefined], ['0123456789ABCDEF', 'a']]) {
      const spawn = fakeSpawn();
      const stderr = sink();
      const code = await runAgent(key, name, { env: w.env, claudeBin: CLAUDE, spawn, stderr });
      assert.equal(code, 3, `${key} ${name}`);
      assert.equal(spawn.calls.length, 0);
      assert.match(stderr.lines.join(''), /invalid/);
    }
    assert.equal(exists(w, 'builder-1.session'), false);
    assert.equal((await run({ claudeBin: null })).code, 1);
  });

  test('(−) tampered .agent.json is refused (exit 3): bypassPermissions, bad fields, extra keys, not an object', async () => {
    const good = { model: 'sonnet', permissionMode: 'default', rc: '' };
    const variants = [
      { ...good, permissionMode: 'bypassPermissions' }, { ...good, permissionMode: 'yolo' }, { ...good, permissionMode: 1 },
      { ...good, model: 'gpt-5' }, { ...good, model: '--x' }, { ...good, model: 5 },
      { ...good, rc: 'UPPER' }, { ...good, rc: '-x' }, { ...good, rc: 'x'.repeat(65) }, { ...good, rc: 5 }, { ...good, rc: null },
      { ...good, extra: 1 }, { model: 'sonnet', permissionMode: 'default' }, { permissionMode: 'default', rc: '' },
      [], 'str', 5, null,
    ];
    for (const v of variants) {
      const { w, run } = await prepared();
      fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify(v));
      const { code, spawn } = await run();
      assert.equal(code, 3, JSON.stringify(v));
      assert.equal(spawn.calls.length, 0);
      assert.equal(exists(w, 'builder-1.session'), false);
    }
    for (const raw of ['{not json', '', `{"__proto__":{"x":1},"model":"sonnet","permissionMode":"default","rc":""}`, ' '.repeat(5000)]) {
      const { w, run } = await prepared();
      fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), raw);
      assert.equal((await run()).code, 3, raw.slice(0, 30));
    }
  });

  test('(−) unsafe files are refused (exit 3): symlinked or hard-linked brief, oversize or empty brief, symlinked agent.json', async () => {
    const outside = path.join((await world()).root, 'out.txt');
    fs.writeFileSync(outside, 'secret');
    const cases = {
      'brief symlink': (w) => { fs.rmSync(path.join(rd(w), 'builder-1.brief.md')); fs.symlinkSync(outside, path.join(rd(w), 'builder-1.brief.md')); },
      'brief hard link': (w) => fs.linkSync(path.join(rd(w), 'builder-1.brief.md'), path.join(w.root, 'link')),
      'brief too large': (w) => fs.writeFileSync(path.join(rd(w), 'builder-1.brief.md'), 'x'.repeat(64 * 1024 + 1)),
      'brief empty': (w) => fs.writeFileSync(path.join(rd(w), 'builder-1.brief.md'), '  \n'),
      'brief NUL': (w) => fs.writeFileSync(path.join(rd(w), 'builder-1.brief.md'), 'a\0b'),
      'agent.json symlink': (w) => { fs.rmSync(path.join(rd(w), 'builder-1.agent.json')); fs.symlinkSync(outside, path.join(rd(w), 'builder-1.agent.json')); },
    };
    for (const [label, tamper] of Object.entries(cases)) {
      const { w, run } = await prepared();
      tamper(w);
      const { code, spawn } = await run();
      assert.equal(code, 3, label);
      assert.equal(spawn.calls.length, 0, label);
      assert.equal(exists(w, 'builder-1.session'), false, label);
    }
  });

  test('(−) missing brief → exit 1; a reports dir that is not safe to write (group-writable) → exit 1, claude never starts', async () => {
    const { w, run } = await prepared();
    fs.rmSync(path.join(rd(w), 'builder-1.brief.md'));
    assert.equal((await run()).code, 1);
    const second = await prepared();
    fs.chmodSync(rd(second.w), 0o770);
    const { code, spawn, stderr } = await second.run();
    assert.equal(code, 1);
    assert.equal(spawn.calls.length, 0);
    assert.match(stderr.lines.join(''), /EMODE/);
  });

  test('(+) <name>.rc is claude\'s exit code (decimal + newline) written after it exits; the 0.1 indexer shows it, .remote is ignored', async () => {
    const { w, run } = await prepared();
    assert.equal((await run({ spawn: fakeSpawn({ code: 7 }) })).code, 7);
    assert.equal(read(w, 'builder-1.rc'), '7\n');
    assert.equal(mode(path.join(rd(w), 'builder-1.rc')), 0o600);
    assert.equal((await run({ spawn: fakeSpawn({ signal: 'SIGTERM' }) })).code, 143);
    assert.equal(read(w, 'builder-1.rc'), '143\n');
    const sid = read(w, 'builder-1.session').trim();
    await put(w, 'builder-1.remote', 'my-app-builder-1\n'); // an RC name next to the exit code
    const entry = (await indexReports([rd(w)])).get(sid);
    assert.equal(entry.name, 'builder-1');
    assert.equal(entry.rc, 143);
    assert.deepEqual([...(await indexReports([rd(w)])).keys()], [sid]);
  });

  test('(+) before claude starts .session, .remote and .pane exist and .rc is empty (an earlier run\'s code is cleared)', async () => {
    const { w, run } = await prepared({}, { remoteControl: { enabled: true, prefix: '' } });
    await run({ spawn: fakeSpawn({ code: 9 }) });
    assert.equal(read(w, 'builder-1.rc'), '9\n');
    const seen = {};
    const spawn = (cmd, args, opts) => {
      for (const f of ['session', 'remote', 'pane', 'rc']) seen[f] = read(w, `builder-1.${f}`);
      return fakeSpawn({ code: 0 })(cmd, args, opts);
    };
    await run({ spawn });
    assert.match(seen.session, /^[0-9a-f-]{36}\n$/);
    assert.equal(seen.remote, 'my-app-builder-1\n');
    assert.equal(seen.pane, '%20\n');
    assert.equal(seen.rc, '');
    assert.equal(read(w, 'builder-1.rc'), '0\n');
  });

  test('(+) a failed start of claude is recorded as exit code 1; a failing .rc write does not hide claude\'s code', async () => {
    const { w, run } = await prepared();
    await run({ spawn: fakeSpawn({ throws: new Error('boom') }) });
    assert.equal(read(w, 'builder-1.rc'), '1\n');
    const spawn = (cmd, args, opts) => {
      fs.chmodSync(rd(w), 0o770); // the dir turns unsafe while claude runs
      return fakeSpawn({ code: 7 })(cmd, args, opts);
    };
    const { code, stderr } = await run({ spawn });
    assert.equal(code, 7);
    assert.match(stderr.lines.join(''), /cannot record the exit code: EMODE/);
    fs.chmodSync(rd(w), 0o700);
    assert.equal(read(w, 'builder-1.rc'), ''); // cleared at the start, the final write was refused
  });

  test('(−) a refused run writes no .rc; a 64-character RC name is accepted, 65 is refused', async () => {
    const { w, run } = await prepared();
    fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'bypassPermissions', rc: '' }));
    assert.equal((await run()).code, 3);
    assert.equal(exists(w, 'builder-1.rc'), false);
    const agentJson = (rc) => fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'default', rc }));
    agentJson('r'.repeat(64));
    const ok = await run();
    assert.equal(ok.code, 0);
    assert.ok(ok.spawn.calls[0].args.includes(`--remote-control=${'r'.repeat(64)}`));
    agentJson('r'.repeat(65));
    assert.equal((await run()).code, 3);
  });

  test('(−) claude failing to start: error event, synchronous throw → exit 1 with a message; no SIGINT listener is left behind', async () => {
    const { run } = await prepared();
    const listeners = process.listenerCount('SIGINT');
    let r = await run({ spawn: fakeSpawn({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr.lines.join(''), /cannot run claude: ENOENT/);
    r = await run({ spawn: fakeSpawn({ throws: Object.assign(new Error('bad arg'), { code: 'ERR_INVALID_ARG_VALUE' }) }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr.lines.join(''), /ERR_INVALID_ARG_VALUE/);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  });
});

// --- reports of nika's own agents show up in the dashboard --------------------------------------------------------

describe('collect() with nika report dirs', () => {
  const DAY = 86_400_000;
  async function setup() {
    const fx = makeFixture();
    const w = await world();
    const dir = rd(w);
    await ensureDir(dir);
    await writeAtomic(dir, 'scout-1.session', `${SID.idle}\n`);
    await writeAtomic(dir, 'scout-1.md', 'STATUS: DONE nika-spawned report\n\n## Summary\n- synthetic\n');
    await writeAtomic(dir, 'scout-1.rc', '3\n');
    await writeAtomic(dir, 'scout-1.remote', 'my-app-scout-1\n');
    for (const [f, c] of [['scout-1.brief.md', 'brief'], ['scout-1.agent.json', '{"model":"sonnet","permissionMode":"default","rc":""}'], ['scout-1.pane', '%5\n'], ['.last-pane', '%5\n']]) {
      await writeAtomic(dir, f, c);
    }
    return { fx, w, dir };
  }
  const agent = (s, id) => s.snapshot.groups.flatMap((g) => g.agents).find((a) => a.id === id);
  const run = (fx, env) => collect({ config: { ...fx.config, ...(env ? { env } : {}) }, exec: fakeExec(), now: NOW, sinceMs: 7 * DAY });

  test('(+) the report and exit code of a nika-spawned agent are indexed; .brief.md .agent.json .pane .last-pane .remote are ignored', async () => {
    const { fx, w } = await setup();
    try {
      const without = await run(fx);
      const withOwn = await run(fx, w.env);
      assert.equal(agent(without, SID.idle).report, null);
      assert.deepEqual(agent(withOwn, SID.idle).report, { name: 'scout-1', status: 'STATUS: DONE nika-spawned report', rc: 3, hasFile: true });
      assert.equal(agent(withOwn, SID.idle).name, 'scout-1');
      assert.ok(withOwn.reportPaths.get(SID.idle).endsWith(path.join('reports', 'scout-1.md')));
      // nothing else changed: same agents, no phantom entries from the new file kinds
      const ids = (s) => s.snapshot.groups.flatMap((g) => g.agents.map((a) => a.id)).sort();
      assert.deepEqual(ids(withOwn), ids(without));
    } finally {
      cleanup(fx);
    }
  });

  test('(−) a symlinked reports dir is not followed; with no env or no projects nothing changes', async () => {
    const { fx, w, dir } = await setup();
    try {
      const moved = `${dir}-real`;
      fs.renameSync(dir, moved);
      fs.symlinkSync(moved, dir);
      assert.equal(agent(await run(fx, w.env), SID.idle).report, null);
      const empty = await world();
      fs.rmSync(path.join(empty.env.NIKA_CONFIG_DIR, 'nika'), { recursive: true });
      assert.equal(agent(await run(fx, empty.env), SID.idle).report, null);
    } finally {
      cleanup(fx);
    }
  });
});
