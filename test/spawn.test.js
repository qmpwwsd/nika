// spawnAgent, runAgent and the dashboard hook for nika's own report dirs; in-memory tmux, injected spawn, temp dirs,
// synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnAgent, runAgent, deniedTools } from '../src/spawn.js';
import { startOrchestrator, sessionNameFor } from '../src/orchestrate.js';
import { TMUX_SESSION, AGENT_NAME } from '../src/ids.js';
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
const LIST_ALL = [TMUX, '-u', 'list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}'];
const LIST_AGENTS = [TMUX, '-u', 'list-panes', '-a', '-F', '#{pane_id}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{session_name}\t#{window_name}'];
const OTHER_KEY = '0123456789abcdef'; // the key of some other project
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
      LIST_AGENTS,
      [TMUX, '-u', 'split-window', '-h', '-t', '=My-App:', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, 'builder-1'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'agent'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/builder-1`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '1'],
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] builder-1'],
    ]);
    assert.equal(mode(rd(w)), 0o700);
    assert.deepEqual(fs.readdirSync(rd(w)).sort(), ['.last-pane', 'builder-1.agent.json', 'builder-1.brief.md']);
    for (const f of fs.readdirSync(rd(w))) assert.equal(mode(path.join(rd(w), f)), 0o600, f);
    assert.equal(read(w, 'builder-1.brief.md'), 'Do the thing.');
    assert.deepEqual(JSON.parse(read(w, 'builder-1.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1 });
    assert.equal(read(w, '.last-pane'), '%20\n');
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'builder-1', sessionId: null, role: 'agent', parent: null, depth: 1, mode: 'manual' });
    assert.equal(exec.panes.find((p) => p.id === '%20').title, '[%20] builder-1');
    assert.equal(exec.panes.find((p) => p.id === '%20').role, 'agent');
    assert.equal(exec.panes.find((p) => p.id === '%20').agent, `${w.project.key}/builder-1`);
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

  test('(+) started records the launch permission mode: request, else settings; `default` (no flag) is manual', async () => {
    const w = await world({ permissionMode: 'acceptEdits' });
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    const modeOf = async (over) => {
      const r = await spawnAgent(req(w, over), ctx);
      assert.equal(r.status, 200);
      return ctx.started.get(r.body.pane).mode;
    };
    assert.equal(await modeOf({ name: 'one' }), 'acceptEdits');
    assert.equal(await modeOf({ name: 'two', permissionMode: 'plan' }), 'plan');
    assert.equal(await modeOf({ name: 'three', permissionMode: 'default' }), 'manual');
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
      { parent: '%x' }, { parent: 'x' }, { parent: 7 }, { parent: '' }, { parent: '%1;%2' }, { parent: '%1234567' }, { parent: '#{pane_id}' }, { parent: null },
      { role: 'admin' }, { role: 'sub-orchestrator' }, { role: 'Agent' }, { role: '' }, { role: 5 }, { role: null },
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
    const r = await spawnAgent(req(w, { brief: `${'é'.repeat(32 * 1024 - 1)} x` }), w.ctx(fakeTmux({ panes: BASE_PANES() })));
    assert.equal(r.status, 200);
    assert.equal(fs.statSync(path.join(rd(w), 'builder-1.brief.md')).size, 64 * 1024);
  });

  test('(−) a one-word brief (claude could read it as a subcommand) → 400, no tmux call, no file; (+) two words or two lines pass', async () => {
    const w = await world({ limits: { maxAgents: 8 } });
    const exec = fakeTmux({ panes: BASE_PANES() });
    for (const brief of ['update', 'doctor', ' mcp ', 'install\n', '\tupdate\r\n', '--help', 'é']) {
      const r = await spawnAgent(req(w, { brief }), w.ctx(exec));
      assert.deepEqual([r.status, r.body.error, r.body.message], [400, 'invalid', 'brief must be more than one word'], JSON.stringify(brief));
    }
    assert.equal(exec.calls.length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
    for (const [i, brief] of ['update the docs', 'one\ntwo', '--help me', ' a b '].entries()) {
      assert.equal((await spawnAgent(req(w, { name: `ok-${i}`, brief }), w.ctx(exec))).status, 200, JSON.stringify(brief));
    }
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
  // live agent panes as nika leaves them in tmux: `@nika-role` agent and `@nika-agent` <project key>/<name>
  const live = (key, names, from = 31, session = 'My-App') => names.map((n, i) => ({ id: `%${from + i}`, session, window: 0, windowName: 'zsh', command: 'node', role: 'agent', agent: `${key}/${n}` }));

  test('(+) the limit counts the agent panes tagged <key>/<name> in tmux: maxAgents of them → 409 limit; nothing is written for the new one', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [...BASE_PANES(), ...live(w.project.key, ['a', 'b', 'c'])] });
    const r = await spawnAgent(req(w, { name: 'd' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [409, 'limit']);
    assert.equal(exec.of('split-window').length, 0);
    assert.equal(exists(w, 'd.brief.md'), false);
    const two = fakeTmux({ panes: [...BASE_PANES(), ...live(w.project.key, ['a', 'b'])] });
    assert.equal((await spawnAgent(req(w, { name: 'd' }), w.ctx(two))).status, 200); // two of three are below the limit
  });

  test('(+) a spawned agent is tagged @nika-role agent and @nika-agent <key>/<name> and counts at once', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec, { started: undefined }); // as in the CLI: no in-process record, tmux is the only memory
    assert.equal((await spawnAgent(req(w, { name: 'one' }), ctx)).status, 200);
    assert.equal((await spawnAgent(req(w, { name: 'two' }), ctx)).status, 200);
    assert.deepEqual(exec.panes.filter((p) => p.role === 'agent').map((p) => p.agent), [`${w.project.key}/one`, `${w.project.key}/two`]);
    assert.equal((await spawnAgent(req(w, { name: 'three' }), ctx)).body.error, 'limit');
    assert.equal((await spawnAgent(req(w, { name: 'one' }), ctx)).body.error, 'conflict');
  });

  test('(+) an agent of the same project in another tmux session counts, for the limit and for the name check', async () => {
    const w = await world();
    const k = w.project.key;
    const spread = fakeTmux({ panes: [...BASE_PANES(), ...live(k, ['a'], 31, 'My-App'), ...live(k, ['b'], 32, 'elsewhere'), ...live(k, ['c'], 33, 'third')] });
    assert.equal((await spawnAgent(req(w, { name: 'd' }), w.ctx(spread))).body.error, 'limit'); // 3 of 3, in 3 sessions
    const elsewhere = fakeTmux({ panes: [...BASE_PANES(), ...live(k, ['builder-1'], 31, 'elsewhere')] });
    assert.equal((await spawnAgent(req(w), w.ctx(elsewhere))).body.error, 'conflict'); // same name, other session
    const fewer = fakeTmux({ panes: [...BASE_PANES(), ...live(k, ['a'], 31, 'elsewhere'), ...live(k, ['b'], 32, 'third')] });
    assert.equal((await spawnAgent(req(w, { name: 'd' }), w.ctx(fewer))).status, 200); // 2 of 3
  });

  test('(−) agents of another project in the same session neither count nor conflict; the same name in another project is free', async () => {
    const w = await world();
    const foreign = fakeTmux({ panes: [...BASE_PANES(), ...live(OTHER_KEY, ['builder-1', 'b', 'c', 'd', 'e'])] }); // five, same session, same name
    const ctx = w.ctx(foreign);
    assert.equal((await spawnAgent(req(w), ctx)).status, 200); // neither the limit nor the name check sees them
    assert.equal((await spawnAgent(req(w, { name: 'second' }), ctx)).status, 200);
    assert.equal((await spawnAgent(req(w), ctx)).body.error, 'conflict'); // but this project's own builder-1 does
    assert.deepEqual(foreign.panes.filter((p) => p.agent.startsWith(`${w.project.key}/`)).map((p) => p.agent), [`${w.project.key}/builder-1`, `${w.project.key}/second`]);
  });

  test('(−) a malformed tag, or a good tag without the agent role, is ignored: never counted, never a conflict', async () => {
    const w = await world({ limits: { maxAgents: 1 } });
    const k = w.project.key;
    const tags = [
      'builder-1', '/builder-1', `${k}/`, k, `${k}-builder-1`, `short/builder-1`, `${k.toUpperCase()}/builder-1`, `${k}/Builder 1`, `${k}/builder-1/x`,
      `${k}//builder-1`, ` ${k}/builder-1`, `${k}/builder-1 `, `${k}/-builder-1`, `${k}/${'a'.repeat(41)}`, `x${k}/builder-1`, `${k}\\builder-1`,
    ];
    for (const agent of tags) {
      const exec = fakeTmux({ panes: [...BASE_PANES(), { id: '%31', session: 'My-App', window: 0, windowName: 'zsh', command: 'node', role: 'agent', agent }] });
      const r = await spawnAgent(req(w), w.ctx(exec));
      assert.equal(r.status, 200, JSON.stringify(agent)); // maxAgents is 1 and builder-1 is the name in the tag
    }
    for (const role of ['', 'orchestrator']) {
      const exec = fakeTmux({ panes: [...BASE_PANES(), { id: '%31', session: 'My-App', window: 0, windowName: 'zsh', command: 'node', role, agent: `${k}/builder-1` }] });
      assert.equal((await spawnAgent(req(w), w.ctx(exec))).status, 200, `role ${JSON.stringify(role)}`);
    }
    const good = fakeTmux({ panes: [...BASE_PANES(), ...live(k, ['builder-1'])] }); // the control: the same pane with a well-formed tag
    assert.equal((await spawnAgent(req(w), w.ctx(good))).body.error, 'conflict');
  });

  test('(−) forged, extra or missing <name>.pane files change neither the limit nor the name check', async () => {
    const w = await world();
    // extra and forged: files claiming live panes, dead panes, panes of shells, and the name about to be used
    for (const [n, pane] of [['x', '%1'], ['y', '%31'], ['z', '%98'], ['builder-1', '%1'], ['junk', 'not a pane']]) await put(w, `${n}.pane`, `${pane}\n`);
    const quiet = fakeTmux({ panes: [...BASE_PANES(), ...live(w.project.key, ['a'])] });
    assert.equal((await spawnAgent(req(w), w.ctx(quiet))).status, 200); // 5 forged files: no limit, no conflict
    // missing: three tagged agents and no .pane file at all
    const w2 = await world();
    const busy = fakeTmux({ panes: [...BASE_PANES(), ...live(w2.project.key, ['a', 'b', 'builder-1'])] });
    assert.equal(exists(w2, 'a.pane'), false);
    assert.equal((await spawnAgent(req(w2, { name: 'd' }), w2.ctx(busy))).body.error, 'limit');
    const named = fakeTmux({ panes: [...BASE_PANES(), ...live(w2.project.key, ['builder-1'])] });
    assert.equal((await spawnAgent(req(w2), w2.ctx(named))).body.error, 'conflict'); // no .pane file for builder-1 either
  });

  test('(−) agents started in this process count even when the tag could not be set; stale started entries are dropped', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const exec = fakeTmux({ panes: [...BASE_PANES(), ...live(w.project.key, ['a', 'b']).map((p) => ({ ...p, role: '', agent: '' }))] });
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

  test('(−) a live agent with the same name → 409 conflict (tagged pane or in-process record); a dead one is replaced', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [...BASE_PANES(), ...live(w.project.key, ['builder-1'])] });
    let r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [409, 'conflict']);
    const untagged = fakeTmux({ panes: [...BASE_PANES(), ...live(w.project.key, ['builder-1']).map((p) => ({ ...p, role: '', agent: '' }))] });
    const started = new Map([['%31', { key: w.project.key, name: 'builder-1', sessionId: null, role: 'agent' }]]);
    r = await spawnAgent(req(w), w.ctx(untagged, { started }));
    assert.equal(r.body.error, 'conflict');
    r = await spawnAgent(req(w), w.ctx(fakeTmux({ panes: BASE_PANES() }))); // the pane died
    assert.equal(r.status, 200);
  });

  test('(−) a tmux failure while listing the tagged panes → 502 tmux_failed, nothing is split or written', async () => {
    const w = await world();
    const calls = [];
    const base = fakeTmux({ panes: BASE_PANES() });
    const exec = async (cmd, args) => {
      calls.push(args[1]);
      if (args[1] === 'list-panes' && args.some((a) => String(a).endsWith('#{session_name}\t#{window_name}'))) throw Object.assign(new Error('boom'), { stderr: 'boom\n' });
      return base(cmd, args);
    };
    const r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.equal(calls.includes('split-window'), false);
    assert.equal(fs.existsSync(rd(w)), false);
  });
});

// --- nesting (0.4): who the parent is, how deep the child sits, and the caps ----------------------------------------------

describe('spawnAgent: nesting and limits (0.4)', () => {
  const KEY_OF = (w) => w.project.key;
  // tmux's record of the main orchestrator (0.4 tag), a sub-orchestrator under it, and an agent
  const MAIN = (w, over = {}) => ({ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${KEY_OF(w)}/orchestrator`, depth: '1', ...over });
  const SUB = (w, over = {}) => ({ id: '%2', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'node', role: 'sub-orchestrator', agent: `${KEY_OF(w)}/planner`, depth: '2', parent: '%1', ...over });
  const AGENT = (w, over = {}) => ({ id: '%3', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'node', role: 'agent', agent: `${KEY_OF(w)}/helper`, depth: '2', parent: '%1', ...over });
  const live = (w, names, { from = 31, parent = '', role = 'agent', session = 'My-App' } = {}) => names.map((n, i) => ({
    id: `%${from + i}`, session, window: 0, windowName: 'zsh', command: 'node', role, agent: `${KEY_OF(w)}/${n}`, depth: parent ? '2' : '1', parent,
  }));
  const tags = (exec, id) => { const p = exec.panes.find((x) => x.id === id); return [p.role, p.agent.slice(17), p.depth, p.parent]; };
  /** A refusal splits nothing, writes nothing and sets no tag. */
  async function refuse(w, panes, over, status, error, ctxOver = {}) {
    const exec = fakeTmux({ panes });
    const before = exec.panes.map((p) => ({ ...p }));
    const files = () => (fs.existsSync(rd(w)) ? fs.readdirSync(rd(w)).sort() : null);
    const filesBefore = files();
    const r = await spawnAgent(req(w, over), w.ctx(exec, ctxOver));
    assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(r.body));
    assert.equal(typeof r.body.message, 'string');
    assert.equal(exec.of('split-window').length, 0);
    assert.equal(exec.of('set-option').length, 0);
    assert.deepEqual(files(), filesBefore, 'no report dir, brief or agent.json');
    assert.deepEqual(exec.panes, before, 'no pane changed');
    return r;
  }

  test('(+) a sub-orchestrator under the main orchestrator: depth 2, the exact tag argv, .agent.json, started record', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [MAIN(w)] });
    const ctx = w.ctx(exec);
    const r = await spawnAgent(req(w, { name: 'planner', role: 'orchestrator', parent: '%1' }), ctx);
    assert.equal(r.status, 200);
    assert.deepEqual(exec.calls, [
      LIST_ALL,
      LIST_AGENTS,
      [TMUX, '-u', 'split-window', '-h', '-t', '=My-App:', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, 'planner'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'sub-orchestrator'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/planner`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '2'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-parent', '%1'],
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] planner'],
    ]);
    assert.deepEqual(JSON.parse(read(w, 'planner.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '', role: 'sub-orchestrator', parent: '%1', depth: 2 });
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'planner', sessionId: null, role: 'sub-orchestrator', parent: '%1', depth: 2, mode: 'manual' });
    assert.deepEqual(tags(exec, '%20'), ['sub-orchestrator', 'planner', '2', '%1']);
  });

  test('(+) an agent under the main orchestrator is depth 2; under a sub-orchestrator it is depth 3', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [MAIN(w), SUB(w)] });
    const ctx = w.ctx(exec);
    assert.equal((await spawnAgent(req(w, { name: 'under-main', parent: '%1' }), ctx)).status, 200);
    assert.equal((await spawnAgent(req(w, { name: 'under-sub', parent: '%2' }), ctx)).status, 200);
    assert.deepEqual(tags(exec, '%20'), ['agent', 'under-main', '2', '%1']);
    assert.deepEqual(tags(exec, '%21'), ['agent', 'under-sub', '3', '%2']);
    assert.deepEqual(JSON.parse(read(w, 'under-sub.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: '%2', depth: 3 });
    assert.deepEqual(exec.of('set-option').filter((c) => c[3] === '%21'), [
      ['set-option', '-p', '-t', '%21', '@nika-role', 'agent'], ['set-option', '-p', '-t', '%21', '@nika-agent', `${w.project.key}/under-sub`],
      ['set-option', '-p', '-t', '%21', '@nika-depth', '3'], ['set-option', '-p', '-t', '%21', '@nika-parent', '%2'],
    ]);
  });

  test('(+) no parent (the page header, a shell) is depth 1, role agent, and no @nika-parent is set', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [MAIN(w)] });
    assert.equal((await spawnAgent(req(w), w.ctx(exec))).status, 200);
    assert.deepEqual(tags(exec, '%20'), ['agent', 'builder-1', '1', '']);
    assert.equal(exec.of('set-option').some((c) => c[4] === '@nika-parent'), false);
    // a pane that carries no nika role is "you" as well, and so is a plain claude session
    for (const plain of [{ role: '' }, { role: '', depth: '2', parent: '%9', agent: `${w.project.key}/x` }]) {
      const e2 = fakeTmux({ panes: [MAIN(w, { id: '%1', ...plain })] });
      assert.equal((await spawnAgent(req(w, { parent: '%1' }), w.ctx(e2))).status, 200);
      assert.deepEqual(tags(e2, '%20'), ['agent', 'builder-1', '1', ''], JSON.stringify(plain));
    }
  });

  test('(+) a 0.3 orchestrator pane (no tags, in the project session, window `orchestrator`) is the main orchestrator for a parent', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator' }] });
    assert.equal((await spawnAgent(req(w, { name: 'planner', role: 'orchestrator', parent: '%1' }), w.ctx(exec))).status, 200);
    assert.deepEqual(tags(exec, '%20'), ['sub-orchestrator', 'planner', '2', '%1']);
    // the pane itself is never retagged
    assert.equal(exec.of('set-option').some((c) => c[3] === '%1'), false);
    assert.deepEqual([exec.panes[0].agent, exec.panes[0].depth], ['', '']);
  });

  test('(−) role orchestrator under a sub-orchestrator → 409 depth', async () => {
    const w = await world();
    const r = await refuse(w, [MAIN(w), SUB(w)], { name: 'deeper', role: 'orchestrator', parent: '%2' }, 409, 'depth');
    assert.match(r.body.message, /Only the main orchestrator can/);
    assert.match(r.body.message, /three levels/);
    assert.match(r.body.message, /Nothing was started/);
  });

  test('(−) role orchestrator with no parent (header, shell, a plain pane, a gone pane for the CLI) → 409 depth', async () => {
    const w = await world();
    await refuse(w, [MAIN(w)], { name: 'planner', role: 'orchestrator' }, 409, 'depth');
    await refuse(w, [MAIN(w, { role: '' })], { name: 'planner', role: 'orchestrator', parent: '%1' }, 409, 'depth');
    await refuse(w, [MAIN(w)], { name: 'planner', role: 'orchestrator', parent: '%99' }, 409, 'depth', { lenientParent: true });
  });

  test('(−) a role-agent parent → 409 depth, for an agent and for an orchestrator request; its @nika-depth is never read', async () => {
    const w = await world();
    for (const depth of ['1', '2', '3', '', 'x']) {
      for (const role of ['agent', 'orchestrator']) {
        const r = await refuse(w, [MAIN(w), AGENT(w, { depth })], { name: 'child', role, parent: '%3' }, 409, 'depth');
        assert.match(r.body.message, /three levels/);
      }
    }
  });

  test('(−) a forged @nika-depth 1 (or an @nika-agent <key>/orchestrator) on an agent never makes it an orchestrator', async () => {
    const w = await world();
    const forged = [{ depth: '1' }, { depth: '1', agent: `${w.project.key}/orchestrator` }, { depth: '2', agent: `${w.project.key}/orchestrator`, parent: '' }];
    for (const over of forged) {
      await refuse(w, [MAIN(w), AGENT(w, over)], { name: 'planner', role: 'orchestrator', parent: '%3' }, 409, 'depth');
      await refuse(w, [MAIN(w), AGENT(w, over)], { name: 'child', parent: '%3' }, 409, 'depth');
    }
  });

  test('(−) a parent whose tag names another project or does not parse is "you": depth 1, and never an orchestrator', async () => {
    const w = await world();
    const bad = ['ffffffffffffffff/orchestrator', 'ffffffffffffffff/planner', 'x', `${w.project.key}/Bad Name`, `${w.project.key}`, '', `${w.project.key}/a/b`];
    for (const role of ['orchestrator', 'sub-orchestrator', 'agent']) {
      for (const agent of bad) {
        const depth = role === 'sub-orchestrator' ? '2' : role === 'orchestrator' ? '1' : '2';
        const panes = [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role, agent, depth, parent: '' }];
        // a 0.3-looking pane (role orchestrator, no tag) in the `orchestrator` window is the legacy main orchestrator: not part of this case
        if (role === 'orchestrator' && agent === '') continue;
        await refuse(w, panes, { name: 'planner', role: 'orchestrator', parent: '%1' }, 409, 'depth');
        const exec = fakeTmux({ panes });
        assert.equal((await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec))).status, 200, `${role} ${JSON.stringify(agent)}`);
        assert.deepEqual(tags(exec, '%20'), ['agent', 'builder-1', '1', ''], `${role} ${JSON.stringify(agent)}`);
      }
    }
  });

  test('(−) a contradictory tag (a depth that does not fit the role) or a legacy pane out of place is "you", not an orchestrator', async () => {
    const w = await world();
    const cases = [
      MAIN(w, { depth: '2' }), MAIN(w, { depth: '3' }), MAIN(w, { depth: 'x' }), // the main orchestrator is depth 1
      MAIN(w, { agent: '', windowName: 'main' }), // a 0.3 pane is the main orchestrator only in the `orchestrator` window...
      MAIN(w, { agent: '', session: 'elsewhere' }), // ...of the project's own tmux session
      MAIN(w, { agent: `${w.project.key}/planner` }), // the main orchestrator is always named `orchestrator`
      SUB(w, { id: '%1', depth: '' }), SUB(w, { id: '%1', depth: '1' }), SUB(w, { id: '%1', depth: '3' }), SUB(w, { id: '%1', depth: '22' }), // a sub-orchestrator is depth 2
    ];
    for (const pane of cases) {
      const panes = [pane, { id: '%9', session: 'My-App', window: 1, windowName: 'zsh', command: 'zsh' }]; // the project's session exists in every case
      await refuse(w, panes, { name: 'planner', role: 'orchestrator', parent: '%1' }, 409, 'depth');
      const exec = fakeTmux({ panes });
      assert.equal((await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec))).status, 200, JSON.stringify(pane));
      assert.equal(tags(exec, '%20')[2], '1', JSON.stringify(pane));
    }
  });

  test('(−) a parent pane that is gone → 404 not_found for a page request; for the CLI (lenientParent) it is "you"', async () => {
    const w = await world();
    const r = await refuse(w, [MAIN(w)], { parent: '%99' }, 404, 'not_found');
    assert.match(r.body.message, /parent/i);
    const exec = fakeTmux({ panes: [MAIN(w)] });
    assert.equal((await spawnAgent(req(w, { parent: '%99' }), w.ctx(exec, { lenientParent: true }))).status, 200);
    assert.deepEqual(tags(exec, '%20'), ['agent', 'builder-1', '1', '']);
  });

  test('(−) a request cannot choose depth or role by other fields: depth, tags and files in the body are ignored', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [MAIN(w)] });
    const r = await spawnAgent({ ...req(w), depth: 1, role: 'agent', nikaDepth: 3, tag: `${w.project.key}/orchestrator`, parentDepth: 1, 'agent.json': { role: 'sub-orchestrator' } }, w.ctx(exec));
    assert.equal(r.status, 200);
    assert.deepEqual(tags(exec, '%20'), ['agent', 'builder-1', '1', '']);
  });

  // --- limits ---

  test('(−) per parent: a parent with maxAgents live children answers 409 limit { scope: parent, running, max }; another parent and "you" are separate buckets', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const panes = [MAIN(w), SUB(w), ...live(w, ['a'], { from: 31, parent: '%1' }), ...live(w, ['c'], { from: 35, parent: '%2' })]; // %1 runs a and the sub-orchestrator
    const r = await refuse(w, panes, { name: 'd', parent: '%1' }, 409, 'limit');
    assert.deepEqual([r.body.scope, r.body.running, r.body.max], ['parent', 2, 2]);
    assert.match(r.body.message, /already runs 2 of 2 agents of its own/);
    assert.match(r.body.message, /Agents per orchestrator/);
    const other = fakeTmux({ panes });
    assert.equal((await spawnAgent(req(w, { name: 'd', parent: '%2' }), w.ctx(other))).status, 200); // %2 runs 1 of 2
    assert.equal((await spawnAgent(req(w, { name: 'e' }), w.ctx(other))).status, 200); // "you" run none
  });

  test('(−) per parent, "you": the live entries with no valid @nika-parent count together; a malformed parent tag counts as none', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const panes = [MAIN(w), ...live(w, ['a'], { from: 31 }), ...live(w, ['b'], { from: 33, parent: 'junk' })];
    const r = await refuse(w, panes, { name: 'c' }, 409, 'limit');
    assert.deepEqual([r.body.scope, r.body.running, r.body.max], ['parent', 2, 2]);
    assert.match(r.body.message, /You already run 2 of 2 agents spawned from nika/);
    const under = fakeTmux({ panes }); // the main orchestrator has none of its own
    assert.equal((await spawnAgent(req(w, { name: 'c', parent: '%1' }), w.ctx(under))).status, 200);
  });

  test('(−) a sub-orchestrator counts as one of its parent\'s agents, and the project cap counts it too', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const panes = [MAIN(w), ...live(w, ['a'], { from: 31, parent: '%1' }), ...live(w, ['planner'], { from: 33, parent: '%1', role: 'sub-orchestrator' })];
    const r = await refuse(w, panes, { name: 'c', parent: '%1' }, 409, 'limit');
    assert.deepEqual([r.body.scope, r.body.running, r.body.max], ['parent', 2, 2]);
    const sub = await refuse(w, panes, { name: 'another', role: 'orchestrator', parent: '%1' }, 409, 'limit');
    assert.equal(sub.body.scope, 'parent');
  });

  test('(−) the project cap is min(3 x maxAgents, 24): 6 for 2, 9 for 3, 24 for 8; the project check runs before the parent check', async () => {
    for (const [n, cap] of [[2, 6], [3, 9], [8, 24]]) {
      const w = await world({ limits: { maxAgents: n } });
      // `cap` live agents spread over parents so that no parent is full: n per parent
      const full = [];
      for (let i = 0; i < cap; i += 1) full.push(...live(w, [`a${i}`], { from: 100 + i, parent: `%${900 + Math.floor(i / n)}` }));
      const r = await refuse(w, [MAIN(w), ...full], { name: 'one-more' }, 409, 'limit');
      assert.deepEqual([r.body.scope, r.body.running, r.body.max], ['project', cap, cap], `N=${n}`);
      assert.match(r.body.message, /already runs \d+ of \d+ agents, the most one project can run/);
      const one = fakeTmux({ panes: [MAIN(w), ...full.slice(0, cap - 1)] }); // one below the cap is fine
      assert.equal((await spawnAgent(req(w, { name: 'one-more' }), w.ctx(one))).status, 200, `N=${n}`);
    }
    // both caps are full: the answer is the project's
    const w = await world({ limits: { maxAgents: 2 } });
    const panes = [MAIN(w), ...live(w, ['a', 'b'], { from: 31 }), ...live(w, ['c', 'd'], { from: 41, parent: '%1' }), ...live(w, ['e', 'f'], { from: 51, parent: '%2' })];
    assert.equal((await refuse(w, panes, { name: 'g' }, 409, 'limit')).body.scope, 'project');
  });

  test('(−) other projects\' agents and non-agent roles (the orchestrator, a plain pane) are not in the live set, for the caps or for the name check', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const foreign = live({ project: { key: OTHER_KEY } }, ['builder-1', 'b', 'c', 'd', 'e', 'f', 'g'], { from: 31, parent: '' });
    const exec = fakeTmux({ panes: [MAIN(w), ...foreign, { id: '%80', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh', role: '', agent: `${w.project.key}/builder-1` }] });
    assert.equal((await spawnAgent(req(w), w.ctx(exec))).status, 200);
  });

  test('(−) a name taken by a live sub-orchestrator is taken for an agent, and the other way round → 409 conflict', async () => {
    const w = await world();
    const subLive = [MAIN(w), ...live(w, ['planner'], { from: 31, parent: '%1', role: 'sub-orchestrator' })];
    assert.equal((await refuse(w, subLive, { name: 'planner' }, 409, 'conflict')).status, 409);
    await refuse(w, subLive, { name: 'planner', role: 'orchestrator', parent: '%1' }, 409, 'conflict');
    const agentLive = [MAIN(w), ...live(w, ['helper'], { from: 31, parent: '%1' })];
    await refuse(w, agentLive, { name: 'helper', role: 'orchestrator', parent: '%1' }, 409, 'conflict');
  });

  test('(−) panes this process started count in their own parent\'s bucket even when their tags could not be set', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const panes = [MAIN(w), ...live(w, ['a', 'b'], { from: 31 }).map((p) => ({ ...p, role: '', agent: '', depth: '', parent: '' }))];
    const started = new Map([
      ['%31', { key: w.project.key, name: 'a', sessionId: null, role: 'agent', parent: '%1', depth: 2 }],
      ['%32', { key: w.project.key, name: 'b', sessionId: null, role: 'sub-orchestrator', parent: '%1', depth: 2 }],
    ]);
    const exec = fakeTmux({ panes });
    const r = await spawnAgent(req(w, { name: 'c', parent: '%1' }), w.ctx(exec, { started }));
    assert.deepEqual([r.status, r.body.scope, r.body.running], [409, 'parent', 2]);
    assert.equal((await spawnAgent(req(w, { name: 'c' }), w.ctx(exec, { started }))).status, 200); // "you" run none of them
  });

  test('(−) two sub-orchestrators spawned at once under one parent with maxAgents 1: one wins, one is 409 limit (still one at a time per project)', async () => {
    const w = await world({ limits: { maxAgents: 1 } });
    const exec = fakeTmux({ panes: [MAIN(w)] });
    const ctx = w.ctx(exec);
    const rs = await Promise.all([spawnAgent(req(w, { name: 'p1', role: 'orchestrator', parent: '%1' }), ctx), spawnAgent(req(w, { name: 'p2', role: 'orchestrator', parent: '%1' }), ctx)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(exec.of('split-window').length, 1);
  });

  test('(−) a tmux failure while listing the tags is 502 and nothing is split, tagged or written (nesting included)', async () => {
    const w = await world();
    const base = fakeTmux({ panes: [MAIN(w)] });
    const exec = async (cmd, args) => {
      if (args[1] === 'list-panes' && args.some((a) => String(a).includes('@nika-depth') && !String(a).includes('window_index'))) throw Object.assign(new Error('boom'), { stderr: 'boom\n' });
      return base(cmd, args);
    };
    const r = await spawnAgent(req(w, { name: 'planner', role: 'orchestrator', parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.equal(base.of('split-window').length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
  });
});

// tmux format-expands `new-session -s`, `new-window -n`, `select-pane -T` and `-c`, not only the start directory (T6): a
// `#(cmd)` in any of them would run cmd. Names and titles are safe only because they can never contain a `#`.
describe('tmux format expansion (T6)', () => {
  const HASHES = ['a#b', '#{pane_id}', 'a#(id)', '#', '##', 'x #S', '#{?#{pane_id},a,b}'];

  test('(+) TMUX_SESSION and AGENT_NAME contain no # and reject every value that has one; sessionNameFor reduces it away', () => {
    assert.equal(TMUX_SESSION.test('My-App_2'), true);
    assert.equal(AGENT_NAME.test('builder-1'), true);
    for (const v of HASHES) {
      assert.equal(TMUX_SESSION.test(v), false, v);
      assert.equal(AGENT_NAME.test(v), false, v);
    }
    assert.equal(TMUX_SESSION.source.includes('#'), false);
    assert.equal(AGENT_NAME.source.includes('#'), false);
    for (const name of HASHES) {
      const session = sessionNameFor({ name, key: '0123456789abcdef' });
      assert.equal(TMUX_SESSION.test(session), true, name);
      assert.equal(session.includes('#'), false, name);
    }
  });

  test('(−) a project folder with # in its name: no -s, -n or -T value nika passes holds a #; only -c carries ## (doubled)', async () => {
    const w = await world();
    const hashed = path.join(w.root, 'Hash#{pane_id}#(id) App');
    fs.mkdirSync(hashed);
    const project = await addProject(hashed, w.env);
    const session = sessionNameFor(project);
    const fresh = fakeTmux({ panes: [] });
    const present = fakeTmux({ panes: [{ id: '%1', session, window: 0, windowName: 'zsh', command: 'zsh' }] });
    assert.equal((await startOrchestrator(project.key, w.ctx(fresh))).body.created, true); // new-session
    assert.equal((await startOrchestrator(project.key, w.ctx(present, { findSession: async () => null }))).body.created, true); // new-window (the first start saved a pick; this lookup finds no transcript for it)
    assert.equal((await spawnAgent({ project: project.key, name: 'builder-1', model: 'sonnet', brief: 'Do the thing.' }, w.ctx(fresh))).status, 200); // split-window, select-pane
    const values = (flag) => [fresh, present].flatMap((e) => e.calls.flatMap((c) => c.map((a, i) => (c[i - 1] === flag ? a : null)).filter((a) => a !== null)));
    for (const flag of ['-s', '-n', '-T']) {
      const seen = values(flag);
      assert.ok(seen.length > 0, `${flag} was passed`);
      for (const v of seen) assert.equal(v.includes('#'), false, `${flag} ${v}`);
    }
    assert.ok(values('-T').includes('[%21] builder-1'));
    const dirs = values('-c');
    assert.ok(dirs.length >= 3 && dirs.every((d) => d.replaceAll('##', '').includes('#') === false && d.includes('##')), JSON.stringify(dirs));
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
async function prepared(over = {}, settings, panes) {
  const w = await world(settings);
  const r = await spawnAgent(req(w, over), w.ctx(fakeTmux({ panes: panes?.(w) ?? BASE_PANES() })));
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

  test('(+) a bracketed alias such as opus[1m] reaches claude as one argv element, no shell', async () => {
    const { run } = await prepared({ model: 'opus[1m]' });
    const { spawn } = await run();
    const args = spawn.calls[0].args;
    assert.equal(args[args.indexOf('--model') + 1], 'opus[1m]');
    assert.equal(spawn.calls[0].opts.shell, false);
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
    const good = { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1 };
    const variants = [
      { ...good, permissionMode: 'bypassPermissions' }, { ...good, permissionMode: 'yolo' }, { ...good, permissionMode: 1 },
      { ...good, model: 'gpt-5' }, { ...good, model: '--x' }, { ...good, model: 5 },
      { ...good, rc: 'UPPER' }, { ...good, rc: '-x' }, { ...good, rc: 'x'.repeat(65) }, { ...good, rc: 5 }, { ...good, rc: null },
      { ...good, extra: 1 }, { model: 'sonnet', permissionMode: 'default' }, { permissionMode: 'default', rc: '' },
      [], 'str', 5, null,
      // 0.4: role, parent and depth are required keys with exact values
      ...['role', 'parent', 'depth'].map((k) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== k))),
      { ...good, role: 'orchestrator' }, { ...good, role: 'Agent' }, { ...good, role: '' }, { ...good, role: null }, { ...good, role: 5 },
      { ...good, depth: 0 }, { ...good, depth: 4 }, { ...good, depth: '1' }, { ...good, depth: 1.5 }, { ...good, depth: null }, { ...good, depth: -1 }, { ...good, depth: [1] },
      { ...good, parent: 'x' }, { ...good, parent: '%' }, { ...good, parent: 5 }, { ...good, parent: '%1234567' }, { ...good, parent: '%1\n' }, { ...good, parent: '#{pane_id}' },
      { ...good, parent: '%1' }, // depth 1 has no parent
      { ...good, depth: 2 }, // a parent is needed from depth 2
      { ...good, role: 'sub-orchestrator', parent: '%1', depth: 3 }, { ...good, role: 'sub-orchestrator' }, // a sub-orchestrator is depth 2 under a parent
    ];
    for (const v of variants) {
      const { w, run } = await prepared();
      fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify(v));
      const { code, spawn } = await run();
      assert.equal(code, 3, JSON.stringify(v));
      assert.equal(spawn.calls.length, 0);
      assert.equal(exists(w, 'builder-1.session'), false);
    }
    for (const raw of ['{not json', '', `{"__proto__":{"x":1},"model":"sonnet","permissionMode":"default","rc":"","role":"agent","parent":null,"depth":1}`, ' '.repeat(5000)]) {
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
      'brief one word': (w) => fs.writeFileSync(path.join(rd(w), 'builder-1.brief.md'), ' update\n'),
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

  test('(−) a stored one-word brief is refused (exit 3) with a message and claude never runs; (+) two words run', async () => {
    const { w, run } = await prepared();
    fs.writeFileSync(path.join(rd(w), 'builder-1.brief.md'), 'update');
    const refused = await run();
    assert.equal(refused.code, 3);
    assert.equal(refused.spawn.calls.length, 0);
    assert.match(refused.stderr.lines.join(''), /brief must be more than one word/);
    fs.writeFileSync(path.join(rd(w), 'builder-1.brief.md'), 'update it');
    const ok = await run();
    assert.equal(ok.code, 0);
    assert.equal(ok.spawn.calls[0].args.at(-1), 'update it');
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
    fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'bypassPermissions', rc: '', role: 'agent', parent: null, depth: 1 }));
    assert.equal((await run()).code, 3);
    assert.equal(exists(w, 'builder-1.rc'), false);
    const agentJson = (rc) => fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'default', rc, role: 'agent', parent: null, depth: 1 }));
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

describe('runAgent: a sub-orchestrator (0.4)', () => {
  // the CLI's command table as src/cli.js passes it (a small stand-in here; test/cli-commands.test.js pins the real one)
  const COMMANDS = ['status', 'spawn', 'projects', 'rules', 'doctor'];
  const SUB_DENIED = ['Bash(tmux:*)', 'Bash(claude:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)', 'Bash(nika)', 'Bash(nika projects:*)', 'Bash(nika rules:*)', 'Bash(nika doctor:*)'];
  const mainPane = (w) => [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${w.project.key}/orchestrator`, depth: '1' }];
  const sub = () => prepared({ name: 'planner', role: 'orchestrator', parent: '%1' }, undefined, mainPane);

  test('(+) the launch argv is pinned: the orchestrator guard, and a deny list that keeps only nika spawn and nika status of nika', async () => {
    const { w, run } = await sub();
    const { code, spawn, stderr } = await run({ commands: COMMANDS });
    assert.equal(code, 0);
    assert.deepEqual(stderr.lines, []);
    const sid = read(w, 'planner.session').trim();
    const args = spawn.calls[0].args;
    const guard = args[args.indexOf('--append-system-prompt') + 1];
    assert.deepEqual(args, [
      '--session-id', sid, '--model', 'sonnet', '-n', 'planner', '--add-dir', rd(w), '--append-system-prompt', guard,
      '--settings', DENY_SETTINGS, '--disallowedTools', ...SUB_DENIED, '--', 'Do the thing.',
    ]);
    assert.ok(!SUB_DENIED.includes('Bash(nika:*)') && !SUB_DENIED.includes('Bash(nika spawn:*)') && !SUB_DENIED.includes('Bash(nika status:*)'));
  });

  test('(+) the guard file is templates/guard-orchestrator.txt, filled in: the name, the report path, the spawn/status allowance, the three levels', async () => {
    const { w, run } = await sub();
    const { spawn } = await run({ commands: COMMANDS });
    const args = spawn.calls[0].args;
    const guard = args[args.indexOf('--append-system-prompt') + 1];
    assert.equal(guard, fs.readFileSync(new URL('../templates/guard-orchestrator.txt', import.meta.url), 'utf8').replace('{{name}}', 'planner').replace('{{reportPath}}', path.join(rd(w), 'planner.md')));
    assert.ok(guard.includes('"planner"') && guard.includes(path.join(rd(w), 'planner.md')) && !guard.includes('{{'));
    assert.match(guard, /nika spawn/);
    assert.match(guard, /nika status/);
    assert.match(guard, /three levels/);
    assert.match(guard, /git add, git commit and git push/);
    assert.doesNotMatch(guard, /never run nika, tmux or claude/i); // an agent's guard says that; this one allows spawn and status
  });

  test('(+) an agent keeps today\'s guard and the whole deny list, whatever table it is given; a sub-orchestrator\'s deny list is built from the table', async () => {
    const { run } = await prepared();
    const { spawn } = await run({ commands: COMMANDS });
    const args = spawn.calls[0].args;
    assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1, -2), DENIED);
    assert.match(args[args.indexOf('--append-system-prompt') + 1], /never run nika, tmux or claude/i);
    assert.deepEqual(deniedTools('agent', COMMANDS), DENIED);
    assert.deepEqual(deniedTools('sub-orchestrator', COMMANDS), SUB_DENIED);
    // a command added to the table is denied by default; spawn and status never are
    assert.deepEqual(deniedTools('sub-orchestrator', ['status', 'spawn', 'new-thing']).slice(-2), ['Bash(nika)', 'Bash(nika new-thing:*)']);
    assert.deepEqual(deniedTools('sub-orchestrator', ['spawn', 'status']).slice(-1), ['Bash(nika)']);
  });

  test('(−) without a usable command table a sub-orchestrator is denied all of nika (it fails closed, never open)', async () => {
    for (const commands of [undefined, null, [], 'spawn', ['ok', 5], ['bad name'], ['a;b'], ['$(id)'], [''], {}]) {
      assert.deepEqual(deniedTools('sub-orchestrator', commands), DENIED, JSON.stringify(commands));
    }
    const { run } = await sub();
    const { spawn } = await run({}); // no `commands` in the context
    const args = spawn.calls[0].args;
    assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1, -2), DENIED);
  });

  test('(−) a stored file that says sub-orchestrator for an agent spawn changes the run only if it agrees with itself: role, parent and depth must fit', async () => {
    const { w, run } = await prepared();
    const put2 = (v) => fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'default', rc: '', ...v }));
    put2({ role: 'sub-orchestrator', parent: null, depth: 1 });
    assert.equal((await run({ commands: COMMANDS })).code, 3);
    put2({ role: 'sub-orchestrator', parent: '%1', depth: 3 });
    assert.equal((await run({ commands: COMMANDS })).code, 3);
    put2({ role: 'sub-orchestrator', parent: '%1', depth: 2 });
    const ok = await run({ commands: COMMANDS });
    assert.equal(ok.code, 0);
    assert.ok(ok.spawn.calls[0].args.includes('Bash(nika projects:*)'));
    put2({ role: 'agent', parent: '%2', depth: 3 });
    assert.equal((await run({ commands: COMMANDS })).code, 0);
    put2({ role: 'agent', parent: '%2', depth: 2 });
    assert.equal((await run({ commands: COMMANDS })).code, 0);
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
