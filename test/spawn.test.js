// spawnAgent, runAgent and the dashboard hook for nika's own report dirs; in-memory tmux, injected spawn, temp dirs,
// synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnAgent, runAgent, deniedTools, agentSettings } from '../src/spawn.js';
import { startOrchestrator, sessionNameFor } from '../src/orchestrate.js';
import { TMUX_SESSION, AGENT_NAME } from '../src/ids.js';
import { NO_TMUX_SERVER } from '../src/tmuxerr.js';
import { WINDOW_ENV, PCT_ENV } from '../src/compact.js';
import { reportsDir } from '../src/paths.js';
import { addProject, updateProjectConfig } from '../src/store.js';
import { ensureDir, writeAtomic } from '../src/fwrite.js';
import { collect } from '../src/model.js';
import { listPanes } from '../src/collect/tmux.js';
import { COLLECTOR_FIELDS, COLLECTOR_PARENT_FIELD } from '../src/place.js';
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
const LIST_ALL = [TMUX, '-u', 'list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_title}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{pane_dead}\t#{@nika-kind}'];
const LIST_AGENTS = [TMUX, '-u', 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}\t#{session_name}\t#{window_name}'];
const OTHER_KEY = '0123456789abcdef'; // the key of some other project
// 0.5.4 (P1): the placement listing (one per spawn into an existing session) and its format, written out by hand so a change of the format fails here
const PLACE = '#{pane_id}\t#{window_id}\t#{window_index}\t#{window_active}\t#{window_panes}\t#{window_zoomed_flag}\t#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}\t#{pane_dead}\t#{pane_active}\t#{@nika-role}\t#{@nika-agent}\t#{@nika-fit}';
const L1 = (session = 'My-App') => [TMUX, '-u', 'list-panes', '-s', '-t', `=${session}`, '-F', PLACE];
const CHECK = (pane) => [TMUX, '-u', 'display-message', '-p', '-t', pane, '#{pane_dead}']; // the early-exit check (F4), made once the pane is created and tagged
// Written out by hand (not built with agentSettings), so a change of the JSON shape fails here.
const SETTINGS = (dir) => `{"permissions":{"deny":["Read(**/.env*)","Edit(**/.env*)","Read(**/*.key)","Edit(**/*.key)"],"additionalDirectories":[${JSON.stringify(dir)}]}}`;
const DENIED = ['Bash(nika:*)', 'Bash(tmux:*)', 'Bash(claude:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)'];
const COMPACT_1M = { window: 400000, pct: '84.2106' }; // the default setting on a 1M model such as `sonnet`: W = 400k, 80 %
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
  test('(+) beside: argv snapshot, files 0600 in a 0700 dir, started map, response shape (0.5.4 P1: L1 before the split, the split names the anchor pane %1, the answer says placement)', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual(r, {
      status: 200,
      body: { pane: '%20', session: 'My-App', sessionId: null, kind: 'agent', placement: 'beside', reports: { dir: rd(w), session: 'builder-1.session', report: 'builder-1.md', rc: 'builder-1.rc', remote: 'builder-1.remote' } },
    });
    assert.deepEqual(exec.calls, [
      LIST_ALL,
      LIST_AGENTS,
      L1(),
      [TMUX, '-u', 'split-window', '-h', '-t', '%1', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, 'builder-1'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'agent'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/builder-1`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '1'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-kind', 'agent'],
      CHECK('%20'),
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] builder-1'],
    ]);
    assert.equal(mode(rd(w)), 0o700);
    assert.deepEqual(fs.readdirSync(rd(w)).sort(), ['.last-pane', 'builder-1.agent.json', 'builder-1.brief.md']);
    for (const f of fs.readdirSync(rd(w))) assert.equal(mode(path.join(rd(w), f)), 0o600, f);
    assert.equal(read(w, 'builder-1.brief.md'), 'Do the thing.');
    assert.deepEqual(JSON.parse(read(w, 'builder-1.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1, compact: COMPACT_1M });
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

  test('(+) the project\'s own placement beats Settings\': under-last for a project on beside, beside for a project on under-last; no choice of its own uses Settings (0.5.4 P1: the split target is a pane id)', async () => {
    const spawnTwo = async (w) => {
      const exec = fakeTmux({ panes: BASE_PANES().map((p) => ({ ...p, winW: 400 })) }); // 400 wide: 200 | 199 after the first split, room for a second one beside
      const ctx = w.ctx(exec);
      await spawnAgent(req(w, { name: 'one' }), ctx);
      await spawnAgent(req(w, { name: 'two' }), ctx);
      return exec.of('split-window')[1].slice(1, 4); // the second pane is the one that can go under the first
    };
    const a = await world({ panePlacement: 'beside' });
    await updateProjectConfig(a.project.key, { panePlacement: 'under-last' }, a.env);
    assert.deepEqual(await spawnTwo(a), ['-v', '-t', '%20']);
    const b = await world({ panePlacement: 'under-last' });
    await updateProjectConfig(b.project.key, { panePlacement: 'beside' }, b.env);
    assert.deepEqual(await spawnTwo(b), ['-h', '-t', '%20'], 'beside: the second agent goes beside the first (0.5.4 P1: its pane id, not =My-App:)');
    assert.deepEqual(await spawnTwo(await world({ panePlacement: 'under-last' })), ['-v', '-t', '%20'], 'Settings alone still works');
    assert.deepEqual(await spawnTwo(await world({ panePlacement: 'beside' })), ['-h', '-t', '%20']);
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
      assert.deepEqual(exec.of('split-window')[0].slice(1, 4), ['-h', '-t', '%1'], JSON.stringify(content)); // 0.5.4 P1: beside = the anchor pane %1
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

  test('(+) explicit session: =other: ; (−) a session that does not exist and is not the project\'s → 404, nothing created; the project\'s own is created (F4)', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [...BASE_PANES(), { id: '%7', session: 'other', window: 0, windowName: 'x', command: 'zsh' }] });
    const ok = await spawnAgent(req(w, { session: 'other' }), w.ctx(exec));
    assert.equal(ok.body.session, 'other');
    assert.equal(exec.of('split-window')[0][3], '%7'); // 0.5.4 P1: the active pane of that session's current window, not `=other:`
    const none = await spawnAgent(req(w, { name: 'x', session: 'nope' }), w.ctx(exec));
    assert.deepEqual([none.status, none.body.error, none.body.message], [404, 'not_found', 'tmux session nope not found']);
    // the default session is the project's own; without it the spawn creates it (F4)
    const alone = fakeTmux({ panes: [{ id: '%7', session: 'other' }] });
    const made = await spawnAgent(req(w, { name: 'y' }), w.ctx(alone));
    assert.deepEqual([made.status, made.body.session, alone.of('new-session').length], [200, 'My-App', 1]);
  });

  test('(+) settings: default permission mode comes from the settings, the request overrides it', async () => {
    const w = await world({ permissionMode: 'acceptEdits' });
    const exec = fakeTmux({ panes: BASE_PANES() });
    await spawnAgent(req(w, { name: 'one' }), w.ctx(exec));
    await spawnAgent(req(w, { name: 'two', permissionMode: 'plan' }), w.ctx(exec));
    assert.equal(JSON.parse(read(w, 'one.agent.json')).permissionMode, 'acceptEdits');
    assert.equal(JSON.parse(read(w, 'two.agent.json')).permissionMode, 'plan');
  });

  test('(+) the project\'s own permission mode is the default of a spawn; the request still overrides it; no choice of its own uses Settings; default beats a Settings mode', async () => {
    const w = await world({ permissionMode: 'acceptEdits', limits: { maxAgents: 8 } });
    await updateProjectConfig(w.project.key, { permissionMode: 'plan' }, w.env);
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    const r1 = await spawnAgent(req(w, { name: 'one' }), ctx);
    const r2 = await spawnAgent(req(w, { name: 'two', permissionMode: 'dontAsk' }), ctx);
    assert.equal(JSON.parse(read(w, 'one.agent.json')).permissionMode, 'plan');
    assert.equal(JSON.parse(read(w, 'two.agent.json')).permissionMode, 'dontAsk', 'an explicit request (the sheet, the CLI) wins');
    assert.deepEqual([ctx.started.get(r1.body.pane).mode, ctx.started.get(r2.body.pane).mode], ['plan', 'dontAsk']);
    await updateProjectConfig(w.project.key, { permissionMode: 'default' }, w.env);
    const r3 = await spawnAgent(req(w, { name: 'three' }), ctx);
    assert.equal(JSON.parse(read(w, 'three.agent.json')).permissionMode, 'default');
    assert.equal(ctx.started.get(r3.body.pane).mode, 'manual');
    await updateProjectConfig(w.project.key, { permissionMode: null }, w.env);
    await spawnAgent(req(w, { name: 'four' }), ctx);
    assert.equal(JSON.parse(read(w, 'four.agent.json')).permissionMode, 'acceptEdits', 'back to Settings');
  });

  test('(−) a project-level bypassPermissions that got past load (a hand-built config) is refused with 400: no tmux call, no agent file', async () => {
    const w = await world({ permissionMode: 'plan' });
    const { loadConfig } = await import('../src/store.js');
    const { config } = await loadConfig(w.env);
    config.perProject = { [w.project.key]: { permissionMode: 'bypassPermissions' } };
    const exec = fakeTmux({ panes: BASE_PANES() });
    const r = await spawnAgent(req(w, { name: 'one' }), { ...w.ctx(exec), loadConfig: async () => ({ config }) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid');
    assert.match(r.body.message, /bypassPermissions/);
    assert.equal(exec.calls.length, 0, 'tmux is never called');
    assert.throws(() => read(w, 'one.agent.json'), { code: 'ENOENT' });
  });

  test('(−) bypassPermissions in a project entry of a tampered config.json is dropped on load: the spawn takes the Settings mode and nothing carries bypass', async () => {
    const w = await world({ permissionMode: 'plan' });
    const file = path.join(w.env.NIKA_CONFIG_DIR, 'nika', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.perProject = { [w.project.key]: { permissionMode: 'bypassPermissions' } };
    fs.writeFileSync(file, JSON.stringify(cfg));
    const exec = fakeTmux({ panes: BASE_PANES() });
    const r = await spawnAgent(req(w, { name: 'one' }), w.ctx(exec));
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(read(w, 'one.agent.json')).permissionMode, 'plan');
    assert.ok(!JSON.stringify(exec.calls).includes('bypass') && !read(w, 'one.agent.json').includes('bypass'));
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

  test('(\u2212) 0.5.4 SF (item 11): a pane id with a leading zero as under or parent (%050, %00, %0123) is 400 invalid, no tmux call, no file; (+) %0 and %999999 are not refused as invalid', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    for (const id of ['%050', '%00', '%0123']) {
      for (const [field, message] of [['under', 'invalid under pane'], ['parent', 'invalid parent pane']]) {
        const r = await spawnAgent(req(w, { [field]: id }), w.ctx(exec));
        assert.deepEqual([r.status, r.body.error, r.body.message], [400, 'invalid', message], `${field} ${id}`);
      }
    }
    assert.equal(exec.calls.length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
    for (const id of ['%0', '%999999']) {
      for (const field of ['under', 'parent']) {
        const r = await spawnAgent(req(w, { name: `ok-${field}`, [field]: id }), w.ctx(exec));
        assert.notEqual(r.body.error, 'invalid', `${field} ${id}: the shape is fine, the pane checks decide`);
      }
    }
  });

  test('(−) the name `orchestrator` is reserved for the main orchestrator\'s tag, for both roles: 400, no tmux call, no file; (+) names that only contain it pass', async () => {
    const w = await world({ limits: { maxAgents: 8 } });
    const exec = fakeTmux({ panes: BASE_PANES() });
    for (const over of [{ name: 'orchestrator' }, { name: 'orchestrator', role: 'orchestrator' }, { name: 'orchestrator', role: 'agent', parent: '%1' }]) {
      const r = await spawnAgent(req(w, over), w.ctx(exec));
      assert.deepEqual([r.status, r.body.error, r.body.message], [400, 'invalid', 'orchestrator is reserved'], JSON.stringify(over));
    }
    assert.equal(exec.calls.length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
    for (const name of ['orchestrator-2', 'my-orchestrator', 'orchestrators', 'o']) {
      assert.equal((await spawnAgent(req(w, { name }), w.ctx(exec))).status, 200, name);
    }
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

  test('(−) tmux missing → 503 tmux_unavailable: no binary, or the binary cannot be run (no server running is not an error any more, F4)', async () => {
    const w = await world();
    for (const [exec, extra] of [[fakeTmux(), { tmuxBin: null }], [fakeTmux({ enoent: true }), {}]]) {
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

// --- F4: no tmux server or no project session, and the early-exit check -----------------------------------------------------

describe('spawnAgent: no tmux server or no project session (F4)', () => {
  const EXITED = 'Claude exited right after it started. Run `claude` once in a terminal in this folder to see why (for example, to log in).';
  const newSession = (w, name = 'builder-1', session = 'My-App') => [TMUX, '-u', 'new-session', '-d', '-s', session, '-n', 'agents', '-c', w.project.dir, '-x', '200', '-y', '50', '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, name];
  const OTHER = { id: '%7', session: 'other', window: 0, windowName: 'zsh', command: 'zsh' };

  test('(+) no tmux server: one new-session with the pinned argv creates the project session, the pane is tagged and titled, 200', async () => {
    const w = await world();
    const exec = fakeTmux();
    const ctx = w.ctx(exec);
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual(r, {
      status: 200,
      body: { pane: '%20', session: 'My-App', sessionId: null, kind: 'agent', placement: 'session', reports: { dir: rd(w), session: 'builder-1.session', report: 'builder-1.md', rc: 'builder-1.rc', remote: 'builder-1.remote' } },
    });
    assert.deepEqual(exec.calls, [
      LIST_ALL, // no server: both listings fail, which is "no panes", not an error
      LIST_AGENTS,
      newSession(w),
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'agent'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/builder-1`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '1'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-kind', 'agent'],
      CHECK('%20'),
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] builder-1'],
    ]);
    assert.deepEqual(ctx.slept, [1000]);
    assert.equal(exec.of('split-window').length, 0);
    assert.deepEqual(exec.panes.map((p) => [p.id, p.session, p.windowName, p.role, p.agent, p.depth]), [['%20', 'My-App', 'agents', 'agent', `${w.project.key}/builder-1`, '1']]);
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'builder-1', sessionId: null, role: 'agent', parent: null, depth: 1, mode: 'manual' });
    assert.equal(read(w, '.last-pane'), '%20\n');
    assert.deepEqual(JSON.parse(read(w, 'builder-1.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1, compact: COMPACT_1M });
  });

  test('(+) a server runs but has no project session (only the user\'s own): the same new-session, the other session is left alone', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [OTHER] });
    const r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.pane, r.body.session], [200, '%20', 'My-App']);
    assert.deepEqual(exec.of('new-session'), [newSession(w).slice(2)]);
    assert.deepEqual([exec.of('split-window').length, exec.panes.find((p) => p.id === '%7').session], [0, 'other']);
    assert.deepEqual(exec.panes.find((p) => p.id === '%20').session, 'My-App');
  });

  test('(+) the project session exists: unchanged, a split-window beside, no new-session', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.session], [200, 'My-App']);
    assert.equal(exec.of('new-session').length, 0);
    assert.deepEqual(exec.of('split-window')[0].slice(1, 4), ['-h', '-t', '%1']); // 0.5.4 P1: the anchor pane
  });

  test('(+) the session just created is the project session for the next spawn: under-last now has a last pane to split under (placement only when the session exists)', async () => {
    const w = await world({ panePlacement: 'under-last' });
    const exec = fakeTmux();
    const ctx = w.ctx(exec);
    assert.equal((await spawnAgent(req(w, { name: 'one' }), ctx)).status, 200);
    assert.equal((await spawnAgent(req(w, { name: 'two' }), ctx)).status, 200);
    assert.deepEqual([exec.of('new-session').length, exec.of('split-window').length], [1, 1]);
    assert.deepEqual(exec.of('split-window')[0].slice(1, 4), ['-v', '-t', '%20']); // under-last now has a last pane
  });

  test('(+) under-last with no session yet: placement is ignored (the stale .last-pane of an earlier run changes nothing)', async () => {
    const w = await world({ panePlacement: 'under-last' });
    await put(w, '.last-pane', '%1\n');
    const exec = fakeTmux();
    assert.equal((await spawnAgent(req(w), w.ctx(exec))).status, 200);
    assert.deepEqual([exec.of('new-session').length, exec.of('split-window').length], [1, 0]);
  });

  test('(+) an explicit `session` that is the project\'s own name is created too; any other missing session is still 404, nothing created', async () => {
    const w = await world();
    const mine = fakeTmux();
    assert.equal((await spawnAgent(req(w, { session: 'My-App' }), w.ctx(mine))).status, 200);
    assert.equal(mine.of('new-session').length, 1);
    const v = await world();
    const other = fakeTmux();
    const r = await spawnAgent(req(v, { session: 'Nope' }), v.ctx(other));
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
    assert.match(r.body.message, /Nope/);
    assert.equal(other.of('new-session').length, 0);
    assert.equal(exists(v, 'builder-1.brief.md'), false);
  });

  test('(−) the tmux binary is missing (ENOENT): 503 tmux_unavailable, no session created, nothing written', async () => {
    const w = await world();
    const exec = fakeTmux({ enoent: true });
    const r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [503, 'tmux_unavailable']);
    assert.match(r.body.message, /tmux not found/);
    assert.equal(exec.of('new-session').length, 0);
    assert.equal(fs.existsSync(rd(w)), false);
  });

  test('(−) new-session failing is a 502 tmux_failed with tmux\'s reason; no pane is recorded, no .last-pane, no check', async () => {
    const w = await world();
    const exec = fakeTmux({ failOn: ['new-session'] });
    const ctx = w.ctx(exec);
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual([r.status, r.body.error, r.body.message], [502, 'tmux_failed', 'tmux failed: new-session failed']);
    assert.equal(ctx.started.size, 0);
    assert.equal(exists(w, '.last-pane'), false);
    assert.deepEqual([exec.of('display-message').length, ctx.slept.length], [0, 0]);
  });

  test('(−) a tmux failure that is not "no server" while listing the tags is still a 502 tmux_failed (the panes were listed fine)', async () => {
    const w = await world();
    const base = fakeTmux({ panes: BASE_PANES() });
    const exec = async (cmd, args) => {
      if (args[1] === 'list-panes' && args.some((a) => String(a).endsWith('#{session_name}\t#{window_name}'))) throw Object.assign(new Error('boom'), { stderr: 'boom\n' });
      return base(cmd, args);
    };
    const r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.equal(base.of('new-session').length + base.of('split-window').length, 0);
  });

  test('(−) the pane is gone after the wait (claude died at launch): 502 claude_exited with the fixed words; no record, no .last-pane, no title', async () => {
    const w = await world();
    for (const panes of [[], [OTHER], BASE_PANES()]) { // no server, a server without the project session, the project session (split-window)
      const exec = fakeTmux({ panes });
      const ctx = w.ctx(exec, { sleep: async (ms) => { ctx.slept.push(ms); exec.panes.splice(exec.panes.findIndex((p) => p.id === '%20'), 1); } });
      const r = await spawnAgent(req(w), ctx);
      assert.deepEqual([r.status, r.body], [502, { error: 'claude_exited', message: EXITED }], JSON.stringify(panes));
      assert.deepEqual(ctx.slept, [1000]);
      assert.equal(exec.of('display-message').length, 1);
      assert.equal(exec.of('select-pane').length, 0);
      assert.equal(ctx.started.size, 0);
      assert.equal(exists(w, '.last-pane'), false);
    }
  });

  test('(−) the pane still exists but is dead (remain-on-exit): 502 claude_exited too', async () => {
    const w = await world();
    const exec = fakeTmux();
    const ctx = w.ctx(exec, { sleep: async () => { exec.panes.find((p) => p.id === '%20').dead = '1'; } });
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual([r.status, r.body.error], [502, 'claude_exited']);
    assert.equal(ctx.started.size, 0);
    assert.equal(exists(w, '.last-pane'), false);
  });

  test('(−) a failed check (tmux errors on display-message) means gone: 502 claude_exited', async () => {
    const w = await world();
    const r = await spawnAgent(req(w), w.ctx(fakeTmux({ panes: BASE_PANES(), failOn: ['display-message'] })));
    assert.deepEqual([r.status, r.body.error], [502, 'claude_exited']);
  });

  test('(−) a refused spawn (duplicate name) starts nothing and waits for nothing', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    assert.equal((await spawnAgent(req(w), ctx)).status, 200);
    assert.deepEqual(ctx.slept, [1000]);
    assert.equal((await spawnAgent(req(w), ctx)).status, 409);
    assert.deepEqual(ctx.slept, [1000], 'the refusal did not wait');
  });
});

// --- F4 fix round 1: a broken listing fails closed, dead panes are not live, a lost race is a clean 502 ---------------------------

describe('spawnAgent: a broken tmux listing, dead panes and a lost race (F4, fix round 1)', () => {
  const MAIN = (w, over = {}) => ({ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${w.project.key}/orchestrator`, depth: '1', ...over });
  const agent = (w, id, name, over = {}) => ({ id, session: 'My-App', window: 0, windowName: 'zsh', command: 'node', role: 'agent', agent: `${w.project.key}/${name}`, depth: '1', ...over });
  /** both listings fail with `stderr` (an exit 1 from tmux); every other sub-command goes to `base` */
  const listFails = (base, stderr) => async (cmd, args) => {
    if (args[1] === 'list-panes') throw Object.assign(new Error(`Command failed: tmux ${stderr}`), { code: 1, stderr: `${stderr}\n` });
    return base(cmd, args);
  };
  const NO_SERVER = ['no server running on /tmp/tmux-1/default', 'error connecting to /tmp/tmux-1/default (No such file or directory)', 'error connecting to /tmp/tmux-1/default (Connection refused)'];
  const BROKEN = ['server exited unexpectedly', 'error connecting to /tmp/tmux-1/default (Permission denied)', 'protocol version mismatch (client 8, server 7)', 'lost server', ''];

  test('(+) NO_TMUX_SERVER matches the three ways tmux says there is no server; (−) nothing else', () => {
    for (const s of NO_SERVER) assert.equal(NO_TMUX_SERVER.test(s), true, s);
    for (const s of BROKEN) assert.equal(NO_TMUX_SERVER.test(s), false, s);
    assert.equal(NO_TMUX_SERVER.test("can't find session: My-App"), false);
  });

  test('(+) "no server running", "error connecting … (No such file or directory)" and "(Connection refused)" still create the session', async () => {
    for (const stderr of NO_SERVER) {
      const w = await world();
      const base = fakeTmux();
      const r = await spawnAgent(req(w), w.ctx(listFails(base, stderr)));
      assert.deepEqual([r.status, r.body.session, base.of('new-session').length], [200, 'My-App', 1], stderr);
    }
  });

  test('(−) any other failure of the listing is 502 tmux_failed: no session created, nothing written, nothing started', async () => {
    for (const stderr of BROKEN) {
      const w = await world();
      const base = fakeTmux({ panes: BASE_PANES() });
      const ctx = w.ctx(listFails(base, stderr));
      const r = await spawnAgent(req(w), ctx);
      assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed'], stderr);
      assert.equal(base.of('new-session').length + base.of('split-window').length, 0, stderr);
      assert.equal(fs.existsSync(rd(w)), false, stderr);
      assert.deepEqual([ctx.slept, base.of('display-message').length], [[], 0]);
    }
  });

  test('(−) the two listings disagree (only the first fails): 502 tmux_failed, this process\'s started records are kept', async () => {
    const w = await world();
    const base = fakeTmux({ panes: BASE_PANES() });
    const exec = async (cmd, args) => {
      if (args[1] === 'list-panes' && args.includes('-F') && String(args[args.indexOf('-F') + 1]).includes('#{pane_title}')) throw Object.assign(new Error('transient'), { code: 1, stderr: 'transient\n' });
      return base(cmd, args);
    };
    const started = new Map([['%31', { key: w.project.key, name: 'other', sessionId: null, role: 'agent' }]]);
    const ctx = w.ctx(exec, { started });
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.deepEqual([...started.keys()], ['%31'], 'liveAgents did not drop the record of a pane it could not see');
    assert.equal(base.of('new-session').length + base.of('split-window').length, 0);
  });

  test('(−) the CLI (lenient parent) with a broken listing is not "you": 502, not a depth-1 agent that skips its parent\'s cap', async () => {
    const w = await world({ limits: { maxAgents: 2 } });
    const adopted = { session: 'work', windowName: 'main' }; // the orchestrator the user adopted from a tmux session of their own
    const panes = [MAIN(w, adopted), agent(w, '%11', 'a', { ...adopted, depth: '2', parent: '%1' }), agent(w, '%12', 'b', { ...adopted, depth: '2', parent: '%1' })];
    const control = fakeTmux({ panes: panes.map((p) => ({ ...p })) });
    const capped = await spawnAgent(req(w, { parent: '%1' }), w.ctx(control, { lenientParent: true }));
    assert.deepEqual([capped.status, capped.body.error, capped.body.scope], [409, 'limit', 'parent'], 'control: a working listing refuses the third');
    const broken = fakeTmux({ panes: panes.map((p) => ({ ...p })), failOn: ['list-panes'] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(broken, { lenientParent: true }));
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.equal(broken.of('new-session').length + broken.of('split-window').length, 0);
  });

  test('(+) remain-on-exit: after a 502 claude_exited the dead pane stays, and a retry with the same name is not a 409', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    let die = true;
    const ctx = w.ctx(exec, { sleep: async () => { if (die) exec.panes.find((p) => p.id === '%20').dead = '1'; } });
    const first = await spawnAgent(req(w), ctx);
    assert.deepEqual([first.status, first.body.error], [502, 'claude_exited']);
    const dead = exec.panes.find((p) => p.id === '%20');
    assert.deepEqual([dead.dead, dead.role, dead.agent], ['1', 'agent', `${w.project.key}/builder-1`], 'the dead pane is still there, still tagged');
    die = false;
    const retry = await spawnAgent(req(w), ctx);
    assert.deepEqual([retry.status, retry.body.pane], [200, '%21'], JSON.stringify(retry.body));
  });

  test('(−) a dead tagged agent pane counts toward no cap: per parent and for the project (a live one does)', async () => {
    const w = await world({ limits: { maxAgents: 1 } });
    const spawnWith = async (deadFlag, panes) => spawnAgent(req(w, { name: 'fresh' }), w.ctx(fakeTmux({ panes: panes(deadFlag) })));
    const one = (d) => [...BASE_PANES(), agent(w, '%31', 'old', { dead: d })]; // maxAgents 1: one live agent of "you" is the cap
    assert.deepEqual([(await spawnWith('0', one)).status, (await spawnWith('0', one)).body.scope], [409, 'parent']);
    assert.equal((await spawnWith('1', one)).status, 200);
    const three = (d) => [...BASE_PANES(), ...['x', 'y', 'z'].map((n, i) => agent(w, `%${41 + i}`, n, { parent: `%9${i}`, depth: '2', dead: d }))]; // min(3 × 1, 24) = 3 for the project
    assert.deepEqual([(await spawnWith('0', three)).status, (await spawnWith('0', three)).body.scope], [409, 'project']);
    assert.equal((await spawnWith('1', three)).status, 200);
  });

  test('(−) a pane this server started that died after the check is no longer live: the same name spawns again', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const ctx = w.ctx(exec);
    const first = await spawnAgent(req(w), ctx);
    assert.deepEqual([first.status, first.body.pane], [200, '%20']);
    assert.deepEqual([(await spawnAgent(req(w), ctx)).status], [409], 'alive: a duplicate');
    exec.panes.find((p) => p.id === '%20').dead = '1'; // claude exits later; remain-on-exit keeps the pane listed
    const again = await spawnAgent(req(w), ctx);
    assert.deepEqual([again.status, again.body.pane], [200, '%21'], JSON.stringify(again.body));
  });

  test('(−) a dead tagged agent pane does not make its name a duplicate', async () => {
    const w = await world();
    const live = await spawnAgent(req(w, { name: 'old' }), w.ctx(fakeTmux({ panes: [...BASE_PANES(), agent(w, '%31', 'old')] })));
    assert.deepEqual([live.status, live.body.error], [409, 'conflict']);
    const dead = await spawnAgent(req(w, { name: 'old' }), w.ctx(fakeTmux({ panes: [...BASE_PANES(), agent(w, '%31', 'old', { dead: '1' })] })));
    assert.equal(dead.status, 200);
  });

  test('(−) a dead orchestrator pane named as the parent is refused the way a gone parent is (404 for the page, "you" for the CLI)', async () => {
    const w = await world();
    const outcome = async (panes, parent, extra = {}) => {
      const exec = fakeTmux({ panes });
      const r = await spawnAgent(req(w, { parent }), w.ctx(exec, extra));
      return [r.status, r.body.error, r.status === 200 ? exec.panes.find((p) => p.id === r.body.pane).depth : null, exec.of('split-window').length];
    };
    const gone = await outcome(BASE_PANES(), '%99');
    const dead = await outcome([MAIN(w, { dead: '1' })], '%1');
    assert.deepEqual(gone, [404, 'not_found', null, 0]);
    assert.deepEqual(dead, gone, 'page request: the same 404');
    const goneCli = await outcome(BASE_PANES(), '%99', { lenientParent: true });
    const deadCli = await outcome([MAIN(w, { dead: '1' })], '%1', { lenientParent: true });
    assert.deepEqual(goneCli, [200, undefined, '1', 1]);
    // 0.5.4 P1: "you", depth 1, not a child of the dead orchestrator, same as a gone parent; but a dead pane is never split, so its agent opens a new window (was: the same split)
    assert.deepEqual(deadCli, [200, undefined, '1', 0], 'CLI: "you", depth 1, not a child of the dead orchestrator');
    const live = await outcome([MAIN(w)], '%1', { lenientParent: true });
    assert.equal(live[2], '2', 'control: a live main orchestrator makes depth 2');
  });

  // R1 F6 (final review, owner ruling): one parse of pane_dead (paneDead in src/collect/tmux.js). 1 = dead: not live. 0 = running. Anything
  // else is unknown: it still counts toward the caps and the duplicate-name check (the cautious direction) but is never accepted as a parent.
  const ODD = ['x', '2', '', 'true', '01'];

  test('(+) a pane_dead that is neither 0 nor 1 still counts: per-parent cap, project cap and the duplicate-name check (a known-dead pane counts for none)', async () => {
    const w = await world({ limits: { maxAgents: 1 } });
    const spawnWith = (panes, over = {}) => spawnAgent(req(w, { name: 'fresh', ...over }), w.ctx(fakeTmux({ panes })));
    for (const dead of ODD) {
      const one = [...BASE_PANES(), agent(w, '%31', 'old', { dead })]; // maxAgents 1: one counted agent of "you" is the cap
      const parent = await spawnWith(one);
      assert.deepEqual([parent.status, parent.body.error, parent.body.scope], [409, 'limit', 'parent'], JSON.stringify(dead));
      const three = [...BASE_PANES(), ...['x', 'y', 'z'].map((n, i) => agent(w, `%${41 + i}`, n, { parent: `%9${i}`, depth: '2', dead }))]; // min(3 × 1, 24) = 3 for the project
      const project = await spawnWith(three);
      assert.deepEqual([project.status, project.body.error, project.body.scope], [409, 'limit', 'project'], JSON.stringify(dead));
      const same = await spawnWith([...BASE_PANES(), agent(w, '%31', 'old', { dead })], { name: 'old' });
      assert.deepEqual([same.status, same.body.error], [409, 'conflict'], JSON.stringify(dead));
    }
    assert.equal((await spawnWith([...BASE_PANES(), agent(w, '%31', 'old', { dead: '1' })])).status, 200, 'control: known dead counts for none');
    assert.equal((await spawnWith([...BASE_PANES(), agent(w, '%31', 'old', { dead: '1' })], { name: 'old' })).status, 200);
  });

  test('(−) a main or sub-orchestrator pane whose pane_dead is neither 0 nor 1 is never accepted as a parent: 409 depth for the page and for the CLI, nothing split', async () => {
    const w = await world();
    const SUB = (over = {}) => ({ id: '%2', session: 'My-App', window: 1, windowName: 'zsh', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/lead`, depth: '2', parent: '%1', ...over });
    const outcome = async (panes, parent, extra = {}) => {
      const exec = fakeTmux({ panes });
      const r = await spawnAgent(req(w, { parent }), w.ctx(exec, extra));
      return [r.status, r.body.error, r.status === 200 ? exec.panes.find((p) => p.id === r.body.pane).depth : null, exec.of('split-window').length];
    };
    for (const dead of ODD) {
      for (const extra of [{}, { lenientParent: true }]) {
        assert.deepEqual(await outcome([MAIN(w, { dead })], '%1', extra), [409, 'depth', null, 0], `main ${JSON.stringify(dead)} ${JSON.stringify(extra)}`);
        assert.deepEqual(await outcome([MAIN(w), SUB({ dead })], '%2', extra), [409, 'depth', null, 0], `sub ${JSON.stringify(dead)} ${JSON.stringify(extra)}`);
      }
    }
    assert.deepEqual(await outcome([MAIN(w)], '%1'), [200, undefined, '2', 1], 'control: running (0) is the parent');
    assert.deepEqual(await outcome([MAIN(w), SUB()], '%2'), [200, undefined, '3', 1], 'control: a running sub-orchestrator is the parent');
  });

  test('(−) new-session losing a race ("duplicate session"): 502 tmux_failed, nothing recorded, no .last-pane, no check, no title', async () => {
    const w = await world();
    const base = fakeTmux({ panes: [{ id: '%1', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }] }); // another process created the session meanwhile
    let blind = 2; // the two listings ran before it existed
    const exec = async (cmd, args) => {
      if (args[1] === 'list-panes' && blind-- > 0) throw Object.assign(new Error('no server'), { code: 1, stderr: 'no server running on /tmp/tmux-1/default\n' });
      return base(cmd, args);
    };
    const ctx = w.ctx(exec);
    const r = await spawnAgent(req(w), ctx);
    assert.deepEqual([r.status, r.body.error, r.body.message], [502, 'tmux_failed', 'tmux failed: duplicate session: My-App']);
    assert.equal(base.of('new-session').length, 1);
    assert.deepEqual([ctx.started.size, exists(w, '.last-pane'), base.of('display-message').length, base.of('select-pane').length, ctx.slept], [0, false, 0, 0, []]);
    assert.equal(base.panes.length, 1, 'no pane was created');
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
      L1(),
      [TMUX, '-u', 'split-window', '-h', '-t', '%1', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, 'planner'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'sub-orchestrator'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/planner`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '2'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-parent', '%1'],
      CHECK('%20'),
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] planner'],
    ]);
    assert.deepEqual(JSON.parse(read(w, 'planner.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '', role: 'sub-orchestrator', parent: '%1', depth: 2, compact: COMPACT_1M });
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
    assert.deepEqual(JSON.parse(read(w, 'under-sub.agent.json')), { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: '%2', depth: 3, compact: COMPACT_1M });
    assert.deepEqual(exec.of('set-option').filter((c) => c[3] === '%21'), [
      ['set-option', '-p', '-t', '%21', '@nika-role', 'agent'], ['set-option', '-p', '-t', '%21', '@nika-agent', `${w.project.key}/under-sub`],
      ['set-option', '-p', '-t', '%21', '@nika-depth', '3'], ['set-option', '-p', '-t', '%21', '@nika-parent', '%2'], ['set-option', '-p', '-t', '%21', '@nika-kind', 'agent'],
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

  // an orchestrator the user adopted from a tmux session of their own (tagged `<key>/orchestrator` by the adopt route)
  const ADOPTED = (w, over = {}) => MAIN(w, { session: 'work', windowName: 'main', ...over });
  const SPLIT_BESIDE_PARENT = (w) => [TMUX, '-u', 'split-window', '-h', '-t', '%1', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, 'builder-1'];

  test('(+) an agent under an orchestrator adopted in another tmux session lands beside it there, even with no project session (argv snapshot)', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [ADOPTED(w)] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.session, 'work');
    assert.deepEqual(exec.calls, [
      LIST_ALL,
      LIST_AGENTS,
      L1('work'),
      SPLIT_BESIDE_PARENT(w),
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'agent'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/builder-1`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '2'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-parent', '%1'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-kind', 'agent'],
      CHECK('%20'),
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] builder-1'],
    ]);
    assert.equal(exec.panes.find((p) => p.id === '%20').session, 'work');
    assert.deepEqual(tags(exec, '%20'), ['agent', 'builder-1', '2', '%1']);
  });

  test('(+) the project\'s own session exists too: the child still goes to its parent\'s session; a sub-orchestrator and an agent under one follow it', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [ADOPTED(w, { winW: 400 }), { id: '%9', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }] }); // 400 wide: room for both splits beside
    assert.equal((await spawnAgent(req(w, { name: 'planner', role: 'orchestrator', parent: '%1' }), w.ctx(exec))).body.session, 'work');
    assert.equal((await spawnAgent(req(w, { name: 'helper', parent: '%20' }), w.ctx(exec))).body.session, 'work');
    // 0.5.4 P1: the splits target panes, not `=work:` (was ['=work:', '=work:']): the planner beside the adopted orchestrator %1, the helper beside the planner %20
    assert.deepEqual(exec.of('split-window').map((c) => c[3]), ['%1', '%20']);
    assert.deepEqual(exec.of('new-window').length, 0);
    assert.deepEqual(exec.panes.filter((p) => ['%20', '%21'].includes(p.id)).map((p) => p.session), ['work', 'work']);
    assert.deepEqual(tags(exec, '%21'), ['agent', 'helper', '3', '%20']);
  });

  test('(+) F4: no parent and no project session creates the project session (new-session); an adopted orchestrator elsewhere is left alone and is not the parent', async () => {
    const w = await world();
    const panes = [ADOPTED(w), { id: '%5', session: 'work', window: 1, windowName: 'shell', command: 'zsh' }];
    for (const over of [{}, { parent: '%5' }]) { // no parent at all, and a plain pane with no nika role ("you")
      const exec = fakeTmux({ panes: panes.map((p) => ({ ...p })) });
      const r = await spawnAgent(req(w, { name: `a${Object.keys(over).length}`, ...over }), w.ctx(exec));
      assert.deepEqual([r.status, r.body.session, exec.of('new-session').length, exec.of('split-window').length], [200, 'My-App', 1, 0], JSON.stringify(over));
      assert.deepEqual(tags(exec, '%20').slice(2), ['1', ''], 'depth 1, no parent: the agent is "you"');
      assert.deepEqual(exec.panes.filter((p) => p.session === 'work').map((p) => p.id), ['%1', '%5']);
    }
  });

  test('(+) an explicit `session` or `under` wins over the parent\'s session', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [ADOPTED(w), { id: '%9', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }, { id: '%7', session: 'other', window: 0, windowName: 'zsh', command: 'zsh' }] });
    const a = await spawnAgent(req(w, { name: 'explicit', parent: '%1', session: 'My-App' }), w.ctx(exec));
    // 0.5.4 P1: the parent is in another session, so the user's own pane %9 there is not split (only this project's agents are): a new agents window in My-App (was: a split of `=My-App:`)
    assert.deepEqual([a.status, a.body.session, a.body.placement, exec.of('split-window').length, exec.of('new-window')[0].slice(1, 4)], [200, 'My-App', 'window', 0, ['-d', '-t', '=My-App:']]);
    const b = await spawnAgent(req(w, { name: 'below', parent: '%1', under: '%7' }), w.ctx(exec));
    assert.deepEqual([b.status, b.body.session, exec.of('split-window')[0].slice(1, 4)], [200, 'other', ['-v', '-t', '%7']]);
    assert.deepEqual(tags(exec, '%21'), ['agent', 'below', '2', '%1']); // still the adopted orchestrator's child
    // a session that is not the project's and does not exist is still 404, even though the parent's own session exists
    const none = await refuse(w, [ADOPTED(w)], { parent: '%1', session: 'Nope' }, 404, 'not_found');
    assert.equal(none.body.message, 'tmux session Nope not found');
  });

  test('(\u2212) a parent session name that is not a valid TMUX_SESSION falls back to the project\'s session (created when it has no pane, F4; an agents window in it when it has)', async () => {
    const w = await world();
    for (const session of ['my work', '-t', 'a:b', '']) {
      const fresh = fakeTmux({ panes: [ADOPTED(w, { session })] });
      const made = await spawnAgent(req(w, { name: `new-${session.length}`, parent: '%1' }), w.ctx(fresh));
      assert.deepEqual([made.status, made.body.session, fresh.of('new-session').length], [200, 'My-App', 1], JSON.stringify(session));
      const exec = fakeTmux({ panes: [ADOPTED(w, { session }), { id: '%9', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }] });
      const r = await spawnAgent(req(w, { name: `ok-${session.length}`, parent: '%1' }), w.ctx(exec));
      assert.deepEqual([r.status, r.body.session], [200, 'My-App'], JSON.stringify(session));
      // 0.5.4 P1: the user's own pane %9 of the project's session is never split: a new agents window in it (was: a split of `=My-App:`)
      assert.deepEqual([exec.of('split-window').length, exec.of('new-window')[0].slice(1, 4)], [0, ['-d', '-t', '=My-App:']]);
    }
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
        assert.match(r.body.message, /^helper can't start agents for this project: only this project's orchestrator and its sub-orchestrators can\. Nothing was started\.$/);
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

  test('(−) a nika-tagged parent whose tag names another project or does not parse is 409 depth (never "you", never an orchestrator)', async () => {
    const w = await world();
    const bad = ['ffffffffffffffff/orchestrator', 'ffffffffffffffff/planner', 'x', `${w.project.key}/Bad Name`, `${w.project.key}`, '', `${w.project.key}/a/b`];
    for (const role of ['orchestrator', 'sub-orchestrator', 'agent']) {
      for (const agent of bad) {
        const depth = role === 'sub-orchestrator' ? '2' : role === 'orchestrator' ? '1' : '2';
        const panes = [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role, agent, depth, parent: '' }];
        // a 0.3-looking pane (role orchestrator, no tag) in the `orchestrator` window is the legacy main orchestrator: not part of this case
        if (role === 'orchestrator' && agent === '') continue;
        for (const over of [{ name: 'planner', role: 'orchestrator', parent: '%1' }, { parent: '%1' }]) {
          const r = await refuse(w, panes, over, 409, 'depth', {});
          assert.match(r.body.message, /can't (start agents for this project: only this project's orchestrator and its sub-orchestrators can|start a sub-orchestrator)/, `${role} ${JSON.stringify(agent)}`);
          assert.match(r.body.message, /Nothing was started\./);
          // the same through the CLI's lenient parent: a pane that exists and carries a nika role is refused too
          await refuse(w, panes, over, 409, 'depth', { lenientParent: true });
        }
      }
    }
  });

  test('(−) the refusal names the parent: its name from the tag when it parses, else its pane id', async () => {
    const w = await world();
    const msg = async (pane) => (await refuse(w, [pane], { parent: pane.id }, 409, 'depth')).body.message;
    assert.match(await msg(AGENT(w, { id: '%7', agent: `${w.project.key}/helper` })), /^helper can't start agents for this project: only this project's orchestrator and its sub-orchestrators can\. Nothing was started\.$/);
    assert.match(await msg(AGENT(w, { id: '%7', agent: `${OTHER_KEY}/planner` })), /^planner can't start agents for this project/);
    assert.match(await msg(AGENT(w, { id: '%7', agent: 'x/\u202e\u0007y' })), /^%7 can't start agents for this project/);
  });

  test('(−) a pane with a role value nika never writes (or a tagged pane with other tags missing) is 409 depth, not "you"', async () => {
    const w = await world();
    for (const role of ['foo', 'Agent', 'ORCHESTRATOR', 'sub_orchestrator', ' agent', 'agent ', 'x'.repeat(200)]) {
      await refuse(w, [MAIN(w, { role })], { parent: '%1' }, 409, 'depth');
      await refuse(w, [MAIN(w, { role })], { name: 'planner', role: 'orchestrator', parent: '%1' }, 409, 'depth', { lenientParent: true });
    }
  });

  test('(−) an orchestrator or sub-orchestrator of another project (the CLI run from its pane with --project) is refused, nothing sent', async () => {
    const w = await world();
    const panes = [
      { id: '%1', session: 'Other', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${OTHER_KEY}/orchestrator`, depth: '1' },
      { id: '%2', session: 'Other', window: 0, windowName: 'orchestrator', command: 'node', role: 'sub-orchestrator', agent: `${OTHER_KEY}/planner`, depth: '2', parent: '%1' },
      { id: '%3', session: 'My-App', window: 1, windowName: 'zsh', command: 'zsh' },
    ];
    for (const parent of ['%1', '%2']) {
      for (const over of [{}, { name: 'planner', role: 'orchestrator' }]) await refuse(w, panes, { ...over, parent }, 409, 'depth', { lenientParent: true });
    }
  });

  test('(−) a contradictory tag (a depth that does not fit the role) or a legacy pane out of place is 409 depth, not an orchestrator and not "you"', async () => {
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
      await refuse(w, panes, { parent: '%1' }, 409, 'depth');
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

  test('(+) the project\'s own limit is the per-parent limit: lower than Settings\' stops sooner (and the message points at the project page), higher lets more through; null goes back to Settings', async () => {
    const w = await world({ limits: { maxAgents: 3 } });
    await updateProjectConfig(w.project.key, { maxAgents: 2 }, w.env);
    const panes = [MAIN(w), ...live(w, ['a', 'b'], { from: 31, parent: '%1' })];
    const r = await refuse(w, panes, { name: 'c', parent: '%1' }, 409, 'limit');
    assert.deepEqual([r.body.scope, r.body.running, r.body.max], ['parent', 2, 2]);
    assert.match(r.body.message, /already runs 2 of 2 agents of its own/);
    assert.match(r.body.message, /“Per orchestrator” on this project’s New agents card\./, 'raising Settings would not help this project');
    assert.doesNotMatch(r.body.message, /in Settings/);
    await updateProjectConfig(w.project.key, { maxAgents: null }, w.env);
    assert.equal((await spawnAgent(req(w, { name: 'c', parent: '%1' }), w.ctx(fakeTmux({ panes })))).status, 200, 'Settings allows 3');
    const v = await world({ limits: { maxAgents: 1 } });
    await updateProjectConfig(v.project.key, { maxAgents: 3 }, v.env);
    const exec = fakeTmux({ panes: [MAIN(v), ...live(v, ['a', 'b'], { from: 31, parent: '%1' })] });
    assert.equal((await spawnAgent(req(v, { name: 'c', parent: '%1' }), v.ctx(exec))).status, 200, 'the project allows 3, Settings only 1');
    const full = await refuse(v, [MAIN(v), ...live(v, ['a', 'b', 'c'], { from: 31, parent: '%1' })], { name: 'd', parent: '%1' }, 409, 'limit');
    assert.deepEqual([full.body.running, full.body.max], [3, 3]);
  });

  test('(+) the project\'s own limit sets the project cap min(3 x N, 24) too: N=2 caps at 6 although Settings\' 5 would allow 15, and N=8 reaches 24', async () => {
    const spread = (w, count, perParent) => Array.from({ length: count }, (_, i) => live(w, [`a${i}`], { from: 100 + i, parent: `%${900 + Math.floor(i / perParent)}` })).flat();
    const w = await world({ limits: { maxAgents: 5 } });
    await updateProjectConfig(w.project.key, { maxAgents: 2 }, w.env);
    const r = await refuse(w, [MAIN(w), ...spread(w, 6, 2)], { name: 'one-more' }, 409, 'limit');
    assert.deepEqual([r.body.scope, r.body.running, r.body.max], ['project', 6, 6]);
    const v = await world({ limits: { maxAgents: 2 } });
    await updateProjectConfig(v.project.key, { maxAgents: 8 }, v.env);
    const exec = fakeTmux({ panes: [MAIN(v), ...spread(v, 23, 8)] });
    assert.equal((await spawnAgent(req(v, { name: 'one-more' }), v.ctx(exec))).status, 200, 'Settings\' 2 would have stopped at 6');
    const capped = await refuse(v, [MAIN(v), ...spread(v, 24, 8)], { name: 'one-more' }, 409, 'limit');
    assert.deepEqual([capped.body.scope, capped.body.running, capped.body.max], ['project', 24, 24]);
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
    const bare = fakeTmux({ panes: [] });
    assert.equal((await spawnAgent({ project: project.key, name: 'builder-1', model: 'sonnet', brief: 'Do the thing.' }, w.ctx(bare))).status, 200); // F4: a spawn with no server runs new-session -s -n agents
    assert.deepEqual([bare.of('new-session')[0].at(bare.of('new-session')[0].indexOf('-n') + 1), bare.of('new-session')[0].at(bare.of('new-session')[0].indexOf('-s') + 1)], ['agents', session]);
    const values = (flag) => [fresh, present, bare].flatMap((e) => e.calls.flatMap((c) => c.map((a, i) => (c[i - 1] === flag ? a : null)).filter((a) => a !== null)));
    for (const flag of ['-s', '-n', '-T']) {
      const seen = values(flag);
      assert.ok(seen.length > 0, `${flag} was passed`);
      for (const v of seen) assert.equal(v.includes('#'), false, `${flag} ${v}`);
    }
    assert.ok(values('-T').includes('[%21] builder-1'));
    const dirs = values('-c');
    assert.ok(dirs.length >= 4 && dirs.every((d) => d.replaceAll('##', '').includes('#') === false && d.includes('##')), JSON.stringify(dirs));
  });
});

// --- 0.5.4 (P1): placement. Windows, sizes and the agents window; the sizes are the ones tmux 3.8 gave in spike S-P1 ---------------

describe('spawnAgent: placement (0.5.4, P1)', () => {
  const L2 = (win) => [TMUX, '-u', 'list-panes', '-t', win, '-F', PLACE]; // the re-list before the tile and the read-back after it
  const TILE = (win) => [TMUX, '-u', 'select-layout', '-t', win, 'tiled'];
  const SPLIT = (w, dir, target, name = 'builder-1') => [TMUX, '-u', 'split-window', dir, '-t', target, '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, name];
  const NEW_WINDOW = (w, name = 'builder-1') => [TMUX, '-u', 'new-window', '-d', '-t', '=My-App:', '-n', 'agents', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, name];
  const TAGS = (w, pane, name, depth, parent) => [
    [TMUX, '-u', 'set-option', '-p', '-t', pane, '@nika-role', 'agent'],
    [TMUX, '-u', 'set-option', '-p', '-t', pane, '@nika-agent', `${w.project.key}/${name}`],
    [TMUX, '-u', 'set-option', '-p', '-t', pane, '@nika-depth', String(depth)],
    ...(parent ? [[TMUX, '-u', 'set-option', '-p', '-t', pane, '@nika-parent', parent]] : []),
    [TMUX, '-u', 'set-option', '-p', '-t', pane, '@nika-kind', 'agent'],
  ];
  const TITLE = (pane, name = 'builder-1') => [TMUX, '-u', 'select-pane', '-t', pane, '-T', `[${pane}] ${name}`];
  // the main orchestrator's window `@1` is the session's current window; an agent of it is tagged as nika tags it
  const main = (w, o = {}) => ({ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${w.project.key}/orchestrator`, depth: '1', win: '@1', ...o });
  const mate = (w, id, name, o = {}) => ({ id, session: 'My-App', window: 0, windowName: 'orchestrator', command: 'node', role: 'agent', agent: `${w.project.key}/${name}`, depth: '2', parent: '%1', win: '@1', ...o });
  // a window of agents only (the agents window): `ids` are its panes, every one an agent of this project
  const crowd = (w, win, index, ids, o = {}) => ids.map((id, i) => mate(w, id, `x${id.slice(1)}`, { window: index, windowName: 'agents', win, w: 99, h: 16, ...(i === 0 ? o : {}) }));
  const world8 = (extra = {}) => world({ limits: { maxAgents: 8 }, ...extra });
  const at = (exec, id) => exec.panes.find((p) => p.id === id);
  const subs = (exec) => exec.calls.map((c) => c[2]);

  test('S-1 (+) beside: the orchestrator alone at 200 x 50, parent %1: L1, a split of %1 with -h, tags, check, title; no re-tile', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w)] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
    assert.deepEqual(r, {
      status: 200,
      body: { pane: '%20', session: 'My-App', sessionId: null, kind: 'agent', placement: 'beside', reports: { dir: rd(w), session: 'builder-1.session', report: 'builder-1.md', rc: 'builder-1.rc', remote: 'builder-1.remote' } },
    });
    assert.deepEqual(exec.calls, [LIST_ALL, LIST_AGENTS, L1(), SPLIT(w, '-h', '%1'), ...TAGS(w, '%20', 'builder-1', 2, '%1'), CHECK('%20'), TITLE('%20')]);
    assert.deepEqual([at(exec, '%1').w, at(exec, '%20').w], [100, 99]);
    assert.equal(exec.of('select-layout').length, 0);
  });

  test('S-2 (+) the second agent: 100 | 99 leaves no room beside, so a new tmux window named agents, made with -d; nothing is split', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w)] });
    const ctx = w.ctx(exec);
    await spawnAgent(req(w, { name: 'one', parent: '%1' }), ctx);
    const r = await spawnAgent(req(w, { name: 'two', parent: '%1' }), ctx);
    assert.deepEqual([r.status, r.body.pane, r.body.placement], [200, '%21', 'window']);
    assert.equal(exec.of('split-window').length, 1, 'only the first spawn split');
    assert.deepEqual(exec.of('new-window'), [NEW_WINDOW(w, 'two').slice(2)]);
    assert.equal(exec.of('select-layout').length, 0);
    assert.deepEqual([...exec.windows.values()].map((x) => [x.id, x.name, x.active]), [['@1', 'orchestrator', true], ['@2', 'agents', false]], 'the current window stays');
    assert.equal(at(exec, '%21').win, '@2');
  });

  test('S-3 (+) the third agent joins the agents window: split -h of its one pane (200 >= 2 x 50), then L2, select-layout tiled, L3, after the tags', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w)] });
    const ctx = w.ctx(exec);
    for (const name of ['one', 'two']) await spawnAgent(req(w, { name, parent: '%1' }), ctx);
    const mark = exec.calls.length;
    const r = await spawnAgent(req(w, { name: 'three', parent: '%1' }), ctx);
    assert.deepEqual([r.status, r.body.pane, r.body.placement], [200, '%22', 'tiled']);
    assert.deepEqual(exec.calls.slice(mark + 3), [SPLIT(w, '-h', '%21', 'three'), ...TAGS(w, '%22', 'three', 2, '%1'), L2('@2'), TILE('@2'), L2('@2'), CHECK('%22'), TITLE('%22', 'three')]);
    assert.deepEqual(exec.panes.filter((p) => p.win === '@2').map((p) => [p.id, p.w, p.h]), [['%21', 200, 24], ['%22', 200, 25]], 'tiled: 2 x 1');
  });

  test('S-4 (+) at 400 x 50 (orchestrator 200, agent 199) the split lands on the agent pane, never on the orchestrator', async () => {
    const w = await world();
    const exec = fakeTmux({ nextId: 60, panes: [main(w, { winW: 400, w: 200 }), mate(w, '%20', 'one', { w: 199 })] });
    const r = await spawnAgent(req(w, { name: 'two', parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement], [200, 'beside']);
    assert.deepEqual(exec.of('split-window')[0].slice(0, 4), ['split-window', '-h', '-t', '%20']);
    assert.equal(at(exec, '%1').w, 200, 'the orchestrator keeps its size');
  });

  test('S-5 (+) under-last: .last-pane %20 at 99 x 50 takes the split below it (-v), 25 | 24 rows', async () => {
    const w = await world({ panePlacement: 'under-last' });
    await put(w, '.last-pane', '%20\n');
    const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'one', { w: 99 })] });
    const r = await spawnAgent(req(w, { name: 'two', parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement], [200, 'under']);
    assert.deepEqual(exec.of('split-window')[0].slice(0, 4), ['split-window', '-v', '-t', '%20']);
    assert.deepEqual([at(exec, '%20').h, at(exec, r.body.pane).h], [25, 24]);
    assert.equal(exec.of('select-layout').length, 0);
  });

  test('S-6 (+) no session yet: new-session as before, no L1 (there is nothing to list), placement session', async () => {
    const w = await world();
    const exec = fakeTmux();
    const r = await spawnAgent(req(w), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement], [200, 'session']);
    assert.equal(exec.of('list-panes').filter((a) => a.includes('-s') || a.includes('@1')).length, 0);
    assert.deepEqual([exec.of('new-session').length, exec.of('split-window').length, exec.of('new-window').length], [1, 0, 0]);
  });

  test('S-7 (+) two agents windows: the one with the fewest panes takes the agent; on a tie the lower window index', async () => {
    const w = await world8();
    const home = [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 })];
    const a = fakeTmux({ nextId: 60, panes: [...home, ...crowd(w, '@2', 1, ['%21', '%22', '%23']), ...crowd(w, '@3', 2, ['%31'])] });
    assert.equal((await spawnAgent(req(w, { parent: '%1' }), w.ctx(a))).body.placement, 'tiled');
    assert.deepEqual([a.of('split-window')[0][3], a.of('select-layout')[0][2]], ['%31', '@3']);
    const b = fakeTmux({ nextId: 60, panes: [...home, ...crowd(w, '@4', 5, ['%41']), ...crowd(w, '@5', 3, ['%51'])] });
    assert.equal((await spawnAgent(req(w, { name: 'two', parent: '%1' }), w.ctx(b))).body.placement, 'tiled');
    assert.deepEqual([b.of('split-window')[0][3], b.of('select-layout')[0][2]], ['%51', '@5'], 'index 3 before index 5');
  });

  test('S-8 (+) a sub-orchestrator is the home of its agents: it joins its agents window while it fits; the 7th pane goes to a new window', async () => {
    const w = await world8();
    const sub = (o = {}) => ({ id: '%30', session: 'My-App', window: 2, windowName: 'agents', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-1`, depth: '2', parent: '%1', win: '@3', w: 99, h: 16, ...o });
    const kids = (ids) => ids.map((id) => mate(w, id, `k${id.slice(1)}`, { window: 2, windowName: 'agents', win: '@3', parent: '%30', depth: '3', w: 99, h: 16 }));
    const five = fakeTmux({ panes: [main(w), sub(), ...kids(['%31', '%32', '%33', '%34'])] });
    const r = await spawnAgent(req(w, { parent: '%30' }), w.ctx(five));
    assert.deepEqual([r.status, r.body.placement, five.of('select-layout')[0][2]], [200, 'tiled', '@3']);
    assert.equal(at(five, r.body.pane).depth, '3');
    const six = fakeTmux({ panes: [main(w), sub(), ...kids(['%31', '%32', '%33', '%34', '%35'])] });
    const full = await spawnAgent(req(w, { parent: '%30' }), w.ctx(six));
    assert.deepEqual([full.status, full.body.placement, six.of('split-window').length, six.of('new-window').length], [200, 'window', 0, 1], 'the 7th pane would be 66 wide');
  });

  test('S-10 (\u2212) an orchestrator 150 wide alone: %1 is not split (it would leave 74 columns); a new window', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w, { winW: 150, w: 150 })] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 0, 1]);
    assert.equal(at(exec, '%1').w, 150);
  });

  test('S-11 (\u2212) the user zoomed the home window: no split, no resize, no re-tile, no unzoom; a new window with -d; the zoom and the current window stay', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w, { zoomed: '1' })] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement], [200, 'window']);
    assert.deepEqual(subs(exec).filter((s) => ['split-window', 'select-layout', 'resize-pane'].includes(s)), []);
    assert.equal(exec.of('new-window')[0][1], '-d');
    assert.deepEqual([exec.windows.get('@1').zoomed, exec.windows.get('@1').active], ['1', true]);
    // an explicit "under" in a zoomed window is not honoured either
    const z = fakeTmux({ nextId: 60, panes: [main(w, { zoomed: '1', w: 100 }), mate(w, '%20', 'one', { w: 99, h: 40 })] });
    const u = await spawnAgent(req(w, { name: 'two', under: '%20', parent: '%1' }), w.ctx(z));
    assert.deepEqual([u.body.placement, u.body.moved, z.of('split-window').length], ['window', 'under', 0]);
  });

  test('S-12 (\u2212) the home window carries @nika-fit: no split there, and the fit controller is never called', async () => {
    const w = await world();
    const noFit = new Proxy({}, { get: (_, k) => { throw new Error(`ctx.fit.${String(k)} was used`); } });
    const exec = fakeTmux({ panes: [main(w, { fit: 'a1b2c3d4e5f60718' })] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { fit: noFit }));
    assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 0, 1]);
    assert.equal(exec.windows.get('@1').fit, 'a1b2c3d4e5f60718', 'nika never touched the lease');
    const zoomed = fakeTmux({ panes: [main(w, { fit: 'a1b2c3d4e5f60718', zoomed: '1' })] });
    assert.equal((await spawnAgent(req(w, { name: 'two', parent: '%1' }), w.ctx(zoomed, { fit: noFit }))).status, 200);
  });

  test('S-13 (\u2212) a user pane appears in the agents window after the split, before the re-list: no select-layout, one log line, 200', async () => {
    const w = await world();
    const logs = [];
    const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21'], { w: 200, h: 50 })] });
    exec.onCall('split-window', () => { exec.add({ session: 'My-App', win: '@2', window: 1, windowName: 'agents', command: 'vim', w: 60, h: 24 }); });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { stderr: { write: (t) => logs.push(t) } }));
    assert.deepEqual([r.status, r.body.placement, exec.of('split-window')[0][3], exec.of('select-layout').length], [200, 'tiled', '%21', 0]);
    assert.deepEqual(logs, ['nika: spawn placement: the agents window changed, so it was not re-tiled\n']);
    assert.equal(exec.of('list-panes').filter((a) => a.includes('@2')).length, 1, 'L2 only: no read-back after a skipped tile');
  });

  test('S-14 (\u2212) the agents window would need a 7th pane at 200 x 50: no split there, no re-tile; a new window', async () => {
    const w = await world8();
    const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21', '%22', '%23', '%24', '%25', '%26'])] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('select-layout').length, exec.of('new-window').length], [200, 'window', 0, 0, 1]);
  });

  test('S-15 (\u2212) L1 fails: 502 tmux_failed, nothing is written (no brief, no agent.json), nothing is split or created', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w)], failOn: ['list-panes -s'] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.equal(fs.existsSync(rd(w)), false, 'L1 runs before the brief is written');
    assert.deepEqual(subs(exec).filter((s) => ['split-window', 'new-window', 'new-session', 'set-option'].includes(s)), []);
  });

  test('S-16 (\u2212) an explicit under pane with no room (80 x 20): placed by the setting, and the answer says moved: under', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w), { id: '%5', session: 'My-App', window: 1, windowName: 'zsh', command: 'zsh', win: '@2', winW: 80, winH: 20 }] });
    const r = await spawnAgent(req(w, { under: '%5', parent: '%1' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement, r.body.moved], [200, 'beside', 'under']);
    assert.deepEqual(exec.of('split-window')[0].slice(0, 4), ['split-window', '-h', '-t', '%1']);
    assert.equal(exec.panes.filter((p) => p.win === '@2').length, 1, 'the user pane is untouched');
    const roomy = fakeTmux({ panes: [main(w), { id: '%5', session: 'My-App', window: 1, windowName: 'zsh', command: 'zsh', win: '@2', winW: 100, winH: 40 }] });
    const ok = await spawnAgent(req(w, { name: 'two', under: '%5', parent: '%1' }), w.ctx(roomy));
    assert.deepEqual([ok.body.placement, 'moved' in ok.body, roomy.of('split-window')[0].slice(0, 4)], ['under', false, ['split-window', '-v', '-t', '%5']]);
  });

  describe('the failure of the re-tile or its read-back never fails a spawn that already runs', () => {
    const run = async (failOn) => {
      const w = await world();
      const logs = [];
      const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21'], { w: 200, h: 50 })], failOn });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { stderr: { write: (t) => logs.push(t) } }));
      return { w, exec, r, logs };
    };

    test('S-17 (\u2212) select-layout fails: 200, one log line with the step and tmux\'s exit code only (no layout text, no names)', async () => {
      const { w, exec, r, logs } = await run(['select-layout']);
      assert.deepEqual([r.status, r.body.placement], [200, 'tiled']);
      assert.deepEqual(logs, ['nika: spawn placement failed (tile 1)\n']);
      assert.ok(!logs.join('').includes(w.project.key) && !logs.join('').includes('builder-1') && !logs.join('').includes('select-layout'));
      assert.equal(read(w, '.last-pane'), `${r.body.pane}\n`, 'the rest of the spawn ran');
      assert.equal(at(exec, r.body.pane).title, `[${r.body.pane}] builder-1`);
    });

    test('S-17 (\u2212) the re-list fails: no select-layout, the same kind of line; the read-back fails: the line says readback', async () => {
      const relist = await run([(sub, args) => sub === 'list-panes' && args.includes('@2')]);
      assert.deepEqual([relist.r.status, relist.exec.of('select-layout').length, relist.logs], [200, 0, ['nika: spawn placement failed (relist 1)\n']]);
      let n = 0;
      const read = await run([(sub, args) => sub === 'list-panes' && args.includes('@2') && (n += 1) === 2]);
      assert.deepEqual([read.r.status, read.exec.of('select-layout').length, read.logs], [200, 1, ['nika: spawn placement failed (readback 1)\n']]);
    });

    test('S-17 (+) a pane of the agents window below 80 x 15 after the tile is only logged, nothing is re-tiled again', async () => {
      const w = await world();
      const logs = [];
      // tmux can leave a pane smaller than the grid predicts (a tiled-layout-max-columns the user set, T65 d): the hook shrinks one after the tile
      const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21'], { w: 150, h: 50, winW: 150 })] });
      exec.onCall('select-layout', () => { exec.panes.find((p) => p.win === '@2').h = 10; });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { stderr: { write: (t) => logs.push(t) } }));
      assert.deepEqual([r.status, exec.of('select-layout').length, logs], [200, 1, ['nika: spawn placement: a pane of the agents window is below 80x15\n']]);
    });
  });

  test('S-17 (\u2212) the floor of the read-back is exactly 80 x 15: 80 x 15 is not logged, 79 x 15 and 80 x 14 are', async () => {
    for (const [w80, h15, logged] of [[80, 15, false], [79, 15, true], [80, 14, true]]) {
      const w = await world();
      const logs = [];
      const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21'], { w: 150, h: 50, winW: 150 })] });
      exec.onCall('select-layout', () => { Object.assign(exec.panes.find((p) => p.win === '@2'), { w: w80, h: h15 }); });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { stderr: { write: (t) => logs.push(t) } }));
      assert.equal(r.status, 200);
      assert.deepEqual(logs, logged ? ['nika: spawn placement: a pane of the agents window is below 80x15\n'] : [], `${w80} x ${h15}`);
    }
  });

  test('S-18 (\u2212) a plain forged tag (a tab, or a newline) in the agents window: its row no longer parses, so the listing is untrusted and a new agents window opens (crafted payloads that carry a whole row: S-22 to S-24)', async () => {
    for (const forged of ['x\ty', 'x\nsplit-here']) {
      const w = await world();
      const panes = [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21', '%22'])];
      const exec = fakeTmux({ nextId: 60, panes });
      exec.panes.find((p) => p.id === '%22').agent = `${w.project.key}/x22${forged}`;
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
      assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('select-layout').length], [200, 'window', 0, 0], JSON.stringify(forged));
    }
  });

  test('S-19 (+) a sub-orchestrator\'s own window is its agents\' home, not the current window of the main orchestrator (live case 2026-11-19): the app tier', async () => {
    const w = await world();
    const subPane = { id: '%30', session: 'My-App', window: 2, windowName: 'zsh', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-1`, depth: '2', parent: '%1', win: '@3', winActive: 0, winW: 300, w: 200 };
    const exec = fakeTmux({ panes: [main(w), subPane, { id: '%31', session: 'My-App', window: 2, windowName: 'zsh', command: 'zsh', win: '@3', w: 99 }] });
    const r = await spawnAgent(req(w, { parent: '%30' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement, r.body.session], [200, 'beside', 'My-App']);
    assert.deepEqual(exec.of('split-window')[0].slice(0, 4), ['split-window', '-h', '-t', '%30']);
    assert.ok(!exec.of('split-window')[0].includes('%1') && !exec.of('split-window')[0].includes('=My-App:'));
    assert.equal(exec.of('select-layout').length, 0, '@3 holds a user pane: not an agents window');
    assert.equal(at(exec, '%1').w, 200, 'the main orchestrator is untouched');
    assert.equal(at(exec, r.body.pane).depth, '3');
  });

  test('S-20 (+) the sub-orchestrator alone in its window (an agents window): split %30, L2, select-layout of @3, L3; the main orchestrator\'s window is never touched', async () => {
    const w = await world();
    const subPane = { id: '%30', session: 'My-App', window: 2, windowName: 'agents', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-1`, depth: '2', parent: '%1', win: '@3', winActive: 0, winW: 300 };
    const exec = fakeTmux({ panes: [main(w), subPane] });
    const r = await spawnAgent(req(w, { parent: '%30' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.placement], [200, 'tiled']);
    const mark = exec.calls.findIndex((c) => c[2] === 'split-window');
    assert.deepEqual(exec.calls.slice(mark, mark + 1), [SPLIT(w, '-h', '%30')]);
    assert.deepEqual(exec.calls.filter((c) => ['list-panes', 'select-layout'].includes(c[2]) && c.includes('@3')), [L2('@3'), TILE('@3'), L2('@3')]);
    assert.deepEqual(exec.calls.filter((c) => c.includes('%1') || c.includes('@1')), [], 'no call names the main orchestrator or its window');
    assert.deepEqual(exec.of('select-layout'), [['select-layout', '-t', '@3', 'tiled']]);
    assert.equal(at(exec, '%1').w, 200);
  });

  test('S-21 (\u2212) the parent is not in the listing (it lives in another tmux session): the main orchestrator %1 of the current window is never split; a new agents window', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w), { id: '%30', session: 'sub-session', window: 0, windowName: 'zsh', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-1`, depth: '2', parent: '%1' }] });
    const r = await spawnAgent(req(w, { parent: '%30', session: 'My-App' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.session, r.body.placement], [200, 'My-App', 'window']);
    assert.deepEqual([exec.of('split-window').length, exec.of('select-layout').length, exec.of('new-window').length], [0, 0, 1]);
    assert.equal(at(exec, '%1').w, 200);
  });

  // ---- review M1 (0.5.4, P1): tmux prints a tag raw, so one tag value can add a whole row to a listing ---------------------------------------------------
  // The forged row claims a pane sits alone in a made-up agents window @99, 400 x 50, as an agent of this project: the shape place() likes best.
  const forgedFields = (w, pane) => [pane, '@99', '9', '0', '1', '0', '400', '50', '400', '50', '0', '1', 'agent', `${w.project.key}/fake`];
  // the three vectors; each returns the panes (and window) the payload is set on. `forger` is %9, alone in its own window @2.
  const VECTORS = {
    // @nika-agent = "x\n<14 forged fields>": the real row is a short line (dropped), the real @nika-fit closes the forged row
    agent: (w, pane) => ({ id: '%9', session: 'My-App', window: 1, windowName: 'agents', command: 'zsh', win: '@2', agent: `x\n${forgedFields(w, pane).join('\t')}` }),
    // @nika-role = "x\n<12 forged fields>\tagent": the forger is an agent of this project, so its real tag closes the forged row as an agent of this project
    role: (w, pane) => ({ id: '%9', session: 'My-App', window: 1, windowName: 'agents', command: 'node', win: '@2', role: `x\n${[...forgedFields(w, pane).slice(0, 12), 'agent'].join('\t')}`, agent: `${w.project.key}/forger`, depth: '2', parent: '%1' }),
    // @nika-fit (a window option) = "x\n<14 forged fields>\t": every line parses, the forged row follows a valid one
    fit: (w, pane) => ({ id: '%9', session: 'My-App', window: 1, windowName: 'agents', command: 'zsh', win: '@2', fit: `x\n${forgedFields(w, pane).join('\t')}\t` }),
  };
  const HOMES = { zoomed: { zoomed: '1', w: 100 }, fitted: { fit: 'a1b2c3d4e5f60718', w: 100 }, narrow: { w: 100 } };
  const TARGETS = { 'the orchestrator %1': '%1', 'the forger itself': '%9', 'a made-up pane': '%77', 'a pane of another session': '%60' };
  const ELSEWHERE = { id: '%60', session: 'other', window: 0, windowName: 'zsh', command: 'zsh' };

  test('S-22 (\u2212) a crafted tag value carries a whole forged row (in @nika-role, @nika-agent or @nika-fit) naming the orchestrator, the forger, a made-up pane or a pane of another session, with the home window zoomed, fitted or too narrow: never a split, never a re-tile; a new agents window', async () => {
    for (const [vector, make] of Object.entries(VECTORS)) {
      for (const [home, homeOpts] of Object.entries(HOMES)) {
        for (const [what, pane] of Object.entries(TARGETS)) {
          const label = `${vector} / ${home} / ${what}`;
          // as "you" (no parent), so the forged row is the only thing between the spawn and a split of %1; the sizes of every pane must be as they were
          const w = await world8();
          const exec = fakeTmux({ nextId: 80, panes: [main(w, homeOpts), mate(w, '%20', 'h1', { w: 99 }), make(w, pane), ELSEWHERE] });
          const before = JSON.stringify(exec.panes.map((p) => [p.id, p.w, p.h]));
          const r = await spawnAgent(req(w), w.ctx(exec));
          assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('select-layout').length, exec.of('new-window').length], [200, 'window', 0, 0, 1], label);
          assert.deepEqual(exec.of('new-window')[0].slice(1, 6), ['-d', '-t', '=My-App:', '-n', 'agents'], label);
          assert.equal(JSON.stringify(exec.panes.filter((p) => p.id !== r.body.pane).map((p) => [p.id, p.w, p.h])), before, `${label}: no pane was resized`);
          // and with the orchestrator named as the parent: a row that rewrites %1 in the tag listing may make the parent check refuse (409, nothing started), never split anything
          const w2 = await world8();
          const exec2 = fakeTmux({ nextId: 80, panes: [main(w2, homeOpts), mate(w2, '%20', 'h1', { w: 99 }), make(w2, pane), ELSEWHERE] });
          const r2 = await spawnAgent(req(w2, { parent: '%1' }), w2.ctx(exec2));
          assert.deepEqual([exec2.of('split-window').length, exec2.of('select-layout').length], [0, 0], `${label} (parent %1)`);
          assert.equal(r2.status === 200 ? r2.body.placement : 'refused', r2.status === 200 ? 'window' : 'refused', `${label} (parent %1)`);
          assert.equal(r2.status === 200 || (r2.status === 409 && exec2.of('new-window').length === 0), true, `${label} (parent %1): ${r2.status}`);
        }
      }
    }
  });

  test('S-23 (\u2212) the same forgery in the second listing (the one before a re-tile): no select-layout, one log line with the step and the reason only', async () => {
    const note = 'nika: spawn placement: the agents window listing could not be trusted, so it was not re-tiled\n';
    // (a) a newline in @nika-agent of a pane of the agents window, set after the split: the forged row names that same pane, with the window's own fields,
    //     so the rows still add up and every one is an agent of this project; only the short first half of the real row gives it away
    {
      const w = await world8();
      const logs = [];
      const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21', '%22'], { w: 99, h: 16 })] });
      exec.onCall('split-window', () => {
        exec.panes.find((p) => p.id === '%21').agent = `x\n${['%21', '@2', '1', '0', '3', '0', '200', '50', '99', '16', '0', '0', 'agent', `${w.project.key}/x21`].join('\t')}`;
      });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { stderr: { write: (t) => logs.push(t) } }));
      assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('select-layout').length], [200, 'tiled', 1, 0], 'the split itself was decided on an honest first listing');
      assert.deepEqual(logs, [note]);
    }
    // (b) a pane id on two rows: a made-up window repeats a pane of the agents window (every line parses, and the agents window's own rows still add up)
    {
      const w = await world8();
      const logs = [];
      const exec = fakeTmux({ nextId: 60, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ...crowd(w, '@2', 1, ['%21', '%22'], { w: 99, h: 16 })] });
      // after the split, the listing of the agents window also carries a row for %21 in a made-up window (every line parses; the window's own rows still add up)
      const wrap = async (cmd, args, opts) => {
        const out = await exec(cmd, args, opts);
        const l2 = args.includes('list-panes') && args.includes('-t') && args.includes('@2');
        return l2 && exec.of('split-window').length ? { ...out, stdout: `${out.stdout}${forgedFields(w, '%21').join('\t')}\t\n` } : out;
      };
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { exec: wrap, stderr: { write: (t) => logs.push(t) } }));
      assert.deepEqual([r.status, r.body.placement, exec.of('select-layout').length], [200, 'tiled', 0]);
      assert.deepEqual(logs, [note]);
    }
  });

  test('S-24 (\u2212) a first listing that is untrusted (a line that does not parse, or a pane id twice): a new agents window, and an explicit under pane is reported as moved', async () => {
    for (const bad of ['junk', '%1\t@99\t9']) {
      const w = await world();
      const exec = fakeTmux({ nextId: 60, panes: [main(w), crowd(w, '@2', 1, ['%21'], { w: 200 })[0]] });
      const wrap = async (cmd, args, opts) => {
        const out = await exec(cmd, args, opts);
        return args.includes('-s') && args.includes('list-panes') ? { ...out, stdout: `${out.stdout}${bad}\n` } : out;
      };
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { exec: wrap }));
      assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 0, 1], JSON.stringify(bad));
    }
    const w = await world();
    const exec = fakeTmux({ nextId: 60, panes: [main(w, { winW: 400 }), mate(w, '%20', 'h1', { w: 199, h: 40 })] });
    const wrap = async (cmd, args, opts) => {
      const out = await exec(cmd, args, opts);
      return args.includes('-s') && args.includes('list-panes') ? { ...out, stdout: `${out.stdout}${out.stdout.split('\n')[0]}\n` } : out;
    };
    const r = await spawnAgent(req(w, { parent: '%1', under: '%20' }), w.ctx(exec, { exec: wrap }));
    assert.deepEqual([r.status, r.body.placement, r.body.moved, exec.of('split-window').length], [200, 'window', 'under', 0], 'a row repeated: untrusted, so even a pane with room is not split');
  });

  // ---- 0.5.4 SF (P1, round 3): an untrusted first listing says so on stderr, once, with the step and the reason only ------------------------------------------
  const L1_NOTE = 'nika: spawn placement: the session listing could not be trusted, so a new agents window opened\n';
  /** An exec that adds one line to the first listing (the session's, `list-panes -s`): `extra(stdout)` is the line. */
  const withExtraLine = (exec, extra) => async (cmd, args, opts) => {
    const out = await exec(cmd, args, opts);
    return args.includes('-s') && args.includes('list-panes') ? { ...out, stdout: `${out.stdout}${extra(out.stdout)}\n` } : out;
  };
  const BAD_FIRST = { 'a line that does not parse': () => 'junk', 'a short line': () => '%1\t@99\t9', 'a pane id on two rows': (stdout) => stdout.split('\n')[0] };

  test('SF-P1-a (+) 0.5.4 SF: a first listing that is untrusted (a line that does not parse, a short line, a pane id twice) logs the one fixed line, and the agent still opens in a new agents window', async () => {
    for (const [what, extra] of Object.entries(BAD_FIRST)) {
      const w = await world();
      const logs = [];
      const exec = fakeTmux({ nextId: 60, panes: [main(w), crowd(w, '@2', 1, ['%21'], { w: 200 })[0]] });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { exec: withExtraLine(exec, extra), stderr: { write: (t) => logs.push(t) } }));
      assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 0, 1], what);
      assert.deepEqual(logs, [L1_NOTE], what);
    }
  });

  test('SF-P1-b (\u2212) 0.5.4 SF: a trusted first listing logs nothing about the listing (a split into a roomy home window, and a lone orchestrator pane)', async () => {
    for (const panes of [(w) => [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 })], (w) => [main(w)]]) {
      const w = await world();
      const logs = [];
      const exec = fakeTmux({ nextId: 60, panes: panes(w) });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { stderr: { write: (t) => logs.push(t) } }));
      assert.equal(r.status, 200);
      assert.equal(logs.some((t) => t.includes('session listing')), false, logs.join('|'));
    }
  });

  test('SF-P1-c (\u2212) 0.5.4 SF: the line carries no listing text: a hostile row (a marker, a path, an escape sequence, a pane id) never reaches stderr', async () => {
    const w = await world();
    const logs = [];
    const exec = fakeTmux({ nextId: 60, panes: [main(w), crowd(w, '@2', 1, ['%21'], { w: 200 })[0]] });
    const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { exec: withExtraLine(exec, () => 'junk-ZQX-marker /secret/path \u001b[31mred %77 @99'), stderr: { write: (t) => logs.push(t) } }));
    assert.equal(r.status, 200);
    assert.deepEqual(logs, [L1_NOTE]);
    for (const leak of ['ZQX', 'secret', 'junk', '\u001b', '%77', '@99']) assert.equal(logs.join('').includes(leak), false, leak);
  });

  test('S-29 (\u2212) 0.5.4 SF (item 11, review R2-1 shape 7b): the alias %050 for the foreign pane %50, as a forged row in the first listing (@nika-fit) plus a whole -a line (@nika-kind), is never split: the first listing is untrusted, a new agents window opens, one log line', async () => {
    const w = await world();
    const logs = [];
    const foreign = { id: '%50', session: 'Aaa', window: 0, windowName: 'zsh', command: 'zsh', win: '@5' };
    const alias = ['%050', 'My-App', '0', '', '', '', '', '', '', '0', ''].join('\t'); // a whole 11-field line of the collector's format, as a @nika-kind value can carry it
    const user = { id: '%9', session: 'My-App', window: 1, windowName: 'zsh', command: 'vim', win: '@2', w: 100, h: 20, winW: 100, winH: 20, fit: `v\n${forgedFields(w, '%050').join('\t')}\t`, kind: `x\n${alias}` };
    const exec = fakeTmux({ nextId: 60, panes: [foreign, main(w, { w: 100, h: 20, winW: 100, winH: 20 }), user] });
    const before = JSON.stringify(exec.panes.map((p) => [p.id, p.w, p.h]));
    const r = await spawnAgent(req(w), w.ctx(exec, { stderr: { write: (t) => logs.push(t) } }));
    assert.deepEqual([r.status, r.body.placement, r.body.session, exec.of('split-window').length, exec.of('select-layout').length, exec.of('new-window').length], [200, 'window', 'My-App', 0, 0, 1]);
    assert.equal(exec.calls.some((c) => c.includes('%050')), false, 'the alias never reaches a tmux argv');
    assert.deepEqual(logs, [L1_NOTE]);
    assert.equal(JSON.stringify(exec.panes.filter((p) => p.id !== r.body.pane).map((p) => [p.id, p.w, p.h])), before, 'no pane was resized');
  });

  test('S-25 (\u2212) the split target must be a pane of the spawn\'s session in the strict listing too: a made-up or a foreign pane named only by the placement listing is never split', async () => {
    for (const [what, pane] of [['made-up', '%77'], ['another session', '%60']]) {
      const w = await world();
      const exec = fakeTmux({ nextId: 70, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99 }), ELSEWHERE] });
      // a placement listing that claims `pane` is the only pane of a roomy agents window (as a forged row that still parses would)
      const wrap = async (cmd, args, opts) => {
        const out = await exec(cmd, args, opts);
        return args.includes('-s') && args.includes('list-panes') ? { ...out, stdout: `${out.stdout}${forgedFields(w, pane).join('\t')}\t\n` } : out;
      };
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { exec: wrap }));
      assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 0, 1], what);
    }
  });

  test('S-25 (\u2212) b: an explicit under pane with no room, and a forged row that offers a made-up pane: no split of it, a new agents window, and the answer still says the under pane was moved', async () => {
    const w = await world();
    const exec = fakeTmux({ nextId: 70, panes: [main(w, { w: 100 }), mate(w, '%20', 'h1', { w: 99, h: 20 })] });
    const wrap = async (cmd, args, opts) => {
      const out = await exec(cmd, args, opts);
      return args.includes('-s') && args.includes('list-panes') ? { ...out, stdout: `${out.stdout}${forgedFields(w, '%77').join('\t')}\t\n` } : out;
    };
    const r = await spawnAgent(req(w, { parent: '%1', under: '%20' }), w.ctx(exec, { exec: wrap }));
    assert.deepEqual([r.status, r.body.placement, r.body.moved, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 'under', 0, 1]);
  });

  // ---- round 4 (review R1-1): check (c) reads the collector's `-a` read strictly ------------------------------------------------------------------------
  // The collector's own parse accepts a short line and lets a later row of a pane id win. The spawn's view of the same read does not: a line with fewer
  // fields than the format, or a pane id on two lines, and nothing is split.
  const isCollectorRead = (args) => args.includes('list-panes') && args.includes('-a') && String(args[args.length - 1]).includes('#{pane_title}');
  const changeCollectorRead = (exec, change) => async (cmd, args, opts) => {
    const out = await exec(cmd, args, opts);
    return isCollectorRead(args) ? { ...out, stdout: change(out.stdout) } : out;
  };

  test('S-27 (\u2212) probe 6: a placement row from @nika-fit offers a foreign pane, and a value only the collector reads puts it in this session: no split of it, a new agents window in the spawn\'s session', async () => {
    const halves = {
      '@nika-parent (a short line)': { parent: 'y\n%50\tMy-App' },
      'pane_current_command (a short line)': { command: 'vim\n%50\tMy-App' },
      '@nika-kind (a whole line: the pane id is then on two lines)': { kind: `x\n${['%50', 'My-App', '0', '', '', '', '', '', '', '0', ''].join('\t')}` },
      '@nika-kind (a whole line, after a short one)': { parent: 'y\n%51\tMy-App', kind: `x\n${['%50', 'My-App', '0', '', '', '', '', '', '', '0', ''].join('\t')}` },
    };
    for (const [what, half] of Object.entries(halves)) {
      const w = await world();
      const foreign = { id: '%50', session: 'Aaa', window: 0, windowName: 'zsh', command: 'zsh', win: '@5' };
      const user = { id: '%9', session: 'My-App', window: 1, windowName: 'zsh', command: 'vim', win: '@2', w: 100, h: 20, winW: 100, winH: 20, fit: `v\n${forgedFields(w, '%50').join('\t')}\t`, ...half };
      const exec = fakeTmux({ nextId: 60, panes: [foreign, main(w, { w: 100, h: 20, winW: 100, winH: 20 }), user] });
      const before = JSON.stringify(exec.panes.map((p) => [p.id, p.w, p.h]));
      const r = await spawnAgent(req(w), w.ctx(exec));
      assert.deepEqual([r.status, r.body.placement, r.body.session, exec.of('split-window').length, exec.of('select-layout').length, exec.of('new-window').length], [200, 'window', 'My-App', 0, 0, 1], what);
      assert.deepEqual(exec.of('new-window')[0].slice(1, 6), ['-d', '-t', '=My-App:', '-n', 'agents'], what);
      assert.equal(at(exec, r.body.pane).session, 'My-App', what);
      assert.equal(JSON.stringify(exec.panes.filter((p) => p.id !== r.body.pane).map((p) => [p.id, p.w, p.h])), before, `${what}: no pane was resized`);
    }
  });

  test('S-28 (\u2212) a short line alone, and a pane id on two lines alone, in the collector\'s -a read: no split (parent %1 would be split beside otherwise); a new agents window', async () => {
    const changes = {
      'a short line': (out) => `${out}junk\n`,
      'a short line for a made-up pane': (out) => `${out}%61\tMy-App\n`,
      'a line of whitespace': (out) => `${out} \n`,
      'the line of %1 cut before the last field': (out) => out.replace(/^(?:[^\t]*\t){9}[^\t]*\t[^\n]*/m, (line) => line.split('\t').slice(0, 10).join('\t')),
      'a pane id on two lines': (out) => `${out}${out.split('\n')[0]}\n`,
    };
    for (const [what, change] of Object.entries(changes)) {
      const w = await world();
      const exec = fakeTmux({ panes: [main(w)] });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { exec: changeCollectorRead(exec, change) }));
      assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 0, 1], what);
      assert.equal(at(exec, '%1').w, 200, `${what}: the orchestrator is untouched`);
    }
  });

  test('S-28 (\u2212) b: the same with an explicit under pane that has room: not split, and the answer says it was moved', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w, { winW: 400 }), mate(w, '%20', 'h1', { w: 199, h: 40 })] });
    const r = await spawnAgent(req(w, { parent: '%1', under: '%20' }), w.ctx(exec, { exec: changeCollectorRead(exec, (out) => `${out}junk\n`) }));
    assert.deepEqual([r.status, r.body.placement, r.body.moved, exec.of('split-window').length, exec.of('new-window').length], [200, 'window', 'under', 0, 1]);
  });

  test('S-28 (+) c: the view only guards splits: a short line in the -a read does not stop the project session from being created when only another session exists', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [{ id: '%7', session: 'elsewhere', window: 0, windowName: 'zsh', command: 'zsh', w: 200, h: 50 }] });
    const r = await spawnAgent(req(w), w.ctx(exec, { exec: changeCollectorRead(exec, (out) => `${out}junk\n`) }));
    assert.deepEqual([r.status, r.body.placement, r.body.session, exec.of('new-session').length, exec.of('split-window').length], [200, 'session', 'My-App', 1, 0]);
  });

  test('S-29 (+) an honest -a read, and one whose last field holds a tab (the kind may), place as before: beside the orchestrator', async () => {
    const changes = {
      'honest': (out) => out,
      'a tab and more in the last field of every line': (out) => out.split('\n').map((line) => (line === '' ? line : `${line}\ta tab\tand more`)).join('\n'),
    };
    for (const [what, change] of Object.entries(changes)) {
      const w = await world();
      const exec = fakeTmux({ panes: [main(w)] });
      const r = await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec, { exec: changeCollectorRead(exec, change) }));
      assert.deepEqual([r.status, r.body.placement, exec.of('split-window').length, exec.of('new-window').length], [200, 'beside', 1, 0], what);
      assert.deepEqual(exec.of('split-window')[0].slice(0, 4), ['split-window', '-h', '-t', '%1'], what);
    }
  });

  test('S-30 (+) COLLECTOR_FIELDS is the number of fields of the format the collector sends in its -a read (the spawn\'s strict view counts them)', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [main(w)] });
    await spawnAgent(req(w, { parent: '%1' }), w.ctx(exec));
    const format = exec.calls[0][exec.calls[0].length - 1];
    assert.deepEqual(exec.calls[0], LIST_ALL);
    assert.equal(format.split('\t').length, COLLECTOR_FIELDS);
    assert.equal(format.split('\t')[COLLECTOR_PARENT_FIELD], '#{@nika-parent}', 'parentTags reads the parent tag from this field (0.5.4 SF, item 14)');
  });

  // ---- 0.5.4 SF (item 12, owner decision 2026-11-20, "keep trees apart"): the live check tiled sub-orchestrator B's agents into sub-orchestrator A's window -----
  test('S-31 (\u2212) 0.5.4 SF (item 12): sub B (parent %40) and the main orchestrator are not tiled into sub A\'s agents window, which has room; a plain agents window is; sub A (parent %30) still is', async () => {
    const w = await world8();
    const subA = { id: '%30', session: 'My-App', window: 2, windowName: 'agents', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-a`, depth: '2', parent: '%1', win: '@3', w: 99, h: 50 };
    const kidA = mate(w, '%31', 'a1', { window: 2, windowName: 'agents', win: '@3', parent: '%30', depth: '3', w: 100, h: 50 });
    // sub B: a window of its own with a user pane and no room beside it, so only rule 4 can place its agent
    const subB = { id: '%40', session: 'My-App', window: 3, windowName: 'zsh', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-b`, depth: '2', parent: '%1', win: '@4', w: 100 };
    const userB = { id: '%41', session: 'My-App', window: 3, windowName: 'zsh', command: 'zsh', win: '@4', w: 99 };
    const base = () => [main(w, { w: 100 }), mate(w, '%10', 'm1', { w: 99 }), subA, kidA, subB, userB]; // %20 is the first id the fake gives a new pane
    const sizes = (exec) => [exec.of('split-window').length, exec.of('select-layout').length];
    for (const parent of ['%40', '%1']) {
      const exec = fakeTmux({ panes: base() });
      const r = await spawnAgent(req(w, { parent }), w.ctx(exec));
      assert.deepEqual([r.status, r.body.placement, sizes(exec), exec.of('new-window').length], [200, 'window', [0, 0], 1], `${parent}: a new agents window, nothing split or re-tiled`);
      assert.equal(JSON.stringify(exec.calls).includes('"@3"'), false, `${parent}: no call names sub A's window`);
    }
    // 0.5.4 SF (item 14): the plain agents window is sub B's own now (its agents carry parent %40); it held agents of the main orchestrator (the default of `mate`), which are not B's tree
    const plain = fakeTmux({ panes: [...base(), ...crowd(w, '@5', 4, ['%51', '%52']).map((p) => ({ ...p, parent: '%40' }))] });
    const p = await spawnAgent(req(w, { parent: '%40' }), w.ctx(plain));
    assert.deepEqual([p.status, p.body.placement, plain.of('select-layout')[0][2]], [200, 'tiled', '@5'], 'the plain agents window takes it');
    const own = fakeTmux({ panes: base() });
    const a = await spawnAgent(req(w, { parent: '%30' }), w.ctx(own));
    assert.deepEqual([a.status, a.body.placement, own.of('select-layout')[0][2], own.of('split-window')[0].slice(1, 4)], [200, 'tiled', '@3', ['-h', '-t', '%31']], 'sub A\'s own agent still joins its window');
  });

  // ---- 0.5.4 SF (item 14, owner answer P1-Q6 A, 2026-11-20, "whole trees"): the tree of every pane comes from the `-a` read doSpawn already made ----------------------
  test('S-32 (\u2212) 0.5.4 SF (item 14): an agents window is tiled only when every pane in it is the spawn\'s parent or its child, by @nika-parent of the -a read: no new tmux call, no new argv', async () => {
    const w = await world8();
    const kids = (win, index, ids, parent) => crowd(w, win, index, ids).map((p) => ({ ...p, parent, depth: parent === '%1' ? '2' : '3' }));
    const subA = { id: '%30', session: 'My-App', window: 2, windowName: 'agents', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-a`, depth: '2', parent: '%1', win: '@3', w: 99, h: 16 };
    const subB = { id: '%40', session: 'My-App', window: 3, windowName: 'zsh', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/sub-b`, depth: '2', parent: '%1', win: '@4', w: 100 };
    const userB = { id: '%41', session: 'My-App', window: 3, windowName: 'zsh', command: 'zsh', win: '@4', w: 99 };
    // sub A's window is full (sub A and five agents of its own), it has an overflow window of its own (@6); the main orchestrator has its own agents window (@5)
    const base = () => [main(w, { w: 100 }), mate(w, '%10', 'm1', { w: 99 }), subA, ...kids('@3', 2, ['%31', '%32', '%33', '%34', '%35'], '%30'), subB, userB, ...kids('@5', 4, ['%51', '%52'], '%1'), ...kids('@6', 5, ['%61', '%62'], '%30')];
    const where = async (parent, panes = base(), extra = {}) => {
      const exec = fakeTmux({ panes });
      const r = await spawnAgent(req(w, { ...(parent ? { parent } : {}), ...extra }), w.ctx(exec));
      return { r, exec, tile: exec.of('select-layout')[0]?.[2] ?? null };
    };
    const named = (exec, ...wins) => wins.filter((x) => JSON.stringify(exec.calls).includes(`"${x}"`));

    const b = await where('%40');
    assert.deepEqual([b.r.status, b.r.body.placement, b.exec.of('new-window').length, b.exec.of('split-window').length], [200, 'window', 1, 0], 'sub B: no agents window of its own, a new one');
    assert.deepEqual(named(b.exec, '@3', '@5', '@6'), [], 'and no call names another tree\'s window');
    const m = await where('%1');
    assert.deepEqual([m.r.status, m.r.body.placement, m.tile], [200, 'tiled', '@5'], 'the main orchestrator: its own agents window, not sub A\'s');
    assert.deepEqual(named(m.exec, '@3', '@6'), []);
    const a = await where('%30');
    assert.deepEqual([a.r.status, a.r.body.placement, a.tile], [200, 'tiled', '@6'], 'sub A: its full window has no room, so its own overflow window, not the main orchestrator\'s');
    assert.deepEqual(named(a.exec, '@5', '@4'), []);
    // no new read and no new argument: the same calls as ever before the split (the -a read, the tag read, the session listing)
    assert.deepEqual(m.exec.calls.slice(0, 3), [LIST_ALL, LIST_AGENTS, L1()]);
    assert.equal(m.exec.calls.filter((c) => c[2] === 'list-panes' && c[3] === '-a').length, 2, 'two -a reads, as before: the tree is read from them');

    // "you": no parent. Agents that carry a parent tag are not its tree; untagged ones are
    const you = await where(null);
    assert.deepEqual([you.r.status, you.r.body.placement], [200, 'window'], '"you": every agents window holds tagged agents');
    const untagged = [...base(), ...kids('@8', 1, ['%81', '%82'], '')];
    const y2 = await where(null, untagged);
    assert.deepEqual([y2.r.status, y2.r.body.placement, y2.tile], [200, 'tiled', '@8'], '"you": the window of untagged agents');
    const y3 = await where('%1', untagged);
    assert.equal(y3.tile, '@5', 'and the main orchestrator does not take it (the untagged window has the lower index: it would be first if it were open)');

    // a tag that is not a pane id, and a pane that the read lists with no tag, put the window in nobody\'s tree
    const bad = base().map((p) => (p.id === '%52' ? { ...p, parent: 'junk' } : p));
    const m2 = await where('%1', bad);
    assert.deepEqual([m2.r.status, m2.r.body.placement, m2.exec.of('select-layout').length], [200, 'window', 0], 'a malformed tag in the main orchestrator\'s window: closed');
    const loose = base().map((p) => (p.id === '%52' ? { ...p, parent: '' } : p));
    assert.equal((await where('%1', loose)).r.body.placement, 'window', 'an untagged agent in it: closed');

    // under-last: .last-pane of another tree is not followed; one of its own tree is
    const last = await world8({ panePlacement: 'under-last' });
    const kidsL = (win, index, ids, parent) => crowd(last, win, index, ids).map((p) => ({ ...p, parent, depth: parent === '%1' ? '2' : '3' }));
    const baseL = () => [main(last, { w: 100 }), mate(last, '%10', 'm1', { w: 99 }), { ...subA, agent: `${last.project.key}/sub-a` }, { ...subB, agent: `${last.project.key}/sub-b` }, userB, ...kidsL('@6', 5, ['%61', '%62'], '%30')];
    const under = async (parent, pane) => {
      await put(last, '.last-pane', `${pane}\n`);
      const exec = fakeTmux({ panes: baseL() });
      const r = await spawnAgent(req(last, { parent }), last.ctx(exec));
      return { r, exec, tile: exec.of('select-layout')[0]?.[2] ?? null };
    };
    const own = await under('%30', '%62');
    assert.deepEqual([own.r.body.placement, own.exec.of('split-window')[0].slice(1, 4)], ['tiled', ['-v', '-t', '%62']], 'sub A follows its own last pane');
    const other = await under('%40', '%62');
    assert.deepEqual([other.r.body.placement, other.exec.of('split-window').length, other.exec.of('new-window').length], ['window', 0, 1], 'sub B does not follow sub A\'s last pane');
    const mine = await under('%1', '%62');
    assert.equal(mine.r.body.placement, 'window', 'nor does the main orchestrator');
  });

  // ---- review M2: the under pane's session name goes into argv, so it must pass TMUX_SESSION --------------------------------------------------
  test('S-26 (\u2212) an under pane in a tmux session whose name nika cannot target: 400 invalid before the caps and before any write; no argv carries the name', async () => {
    for (const session of ['my work', 'a:b', '-t', 'x.y', 'caf\u00e9', `${'a'.repeat(48)}b`]) {
      const w = await world();
      const exec = fakeTmux({ panes: [{ id: '%5', session, window: 0, windowName: 'zsh', command: 'zsh', w: 80, h: 20 }] });
      const r = await spawnAgent(req(w, { under: '%5' }), w.ctx(exec));
      assert.deepEqual([r.status, r.body.error, r.body.message], [400, 'invalid', 'That pane is in a tmux session nika cannot target.'], JSON.stringify(session));
      assert.deepEqual(exec.calls.map((c) => c[2]), ['list-panes'], `only the read: ${JSON.stringify(session)}`);
      assert.equal(JSON.stringify(exec.calls).includes(session), false, 'no argv carries the name');
      assert.equal(fs.existsSync(path.join(rd(w), 'builder-1.brief.md')) || fs.existsSync(path.join(rd(w), 'builder-1.agent.json')), false, 'no brief and no agent.json');
    }
  });

  test('S-26 (+) an under pane in a session with a valid name is still split or moved as before', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [{ id: '%7', session: 'other_2', window: 0, windowName: 'zsh', command: 'zsh', w: 200, h: 50 }] });
    const r = await spawnAgent(req(w, { under: '%7' }), w.ctx(exec));
    assert.deepEqual([r.status, r.body.session, exec.of('split-window')[0].slice(1, 4)], [200, 'other_2', ['-v', '-t', '%7']]);
  });
});

describe('tmux-fake: its windows, splits and tiled layout match the sizes tmux 3.8 gave (spike S-P1)', () => {
  const T = (exec, ...args) => exec(TMUX, ['-u', ...args]);
  const one = (session = 's', o = {}) => fakeTmux({ panes: [{ id: '%1', session, window: 0, windowName: 'w', command: 'zsh', ...o }] });
  const sizes = (exec, win) => exec.panes.filter((p) => p.win === win).map((p) => [p.w, p.h]);

  test('F-1 (+) a tiled window of n panes has the smallest pane the spike measured: 200 x 50 for n = 1..10, 120 x 40 for n = 1..6', async () => {
    const want200 = [[200, 50], [200, 24], [99, 24], [99, 24], [99, 16], [99, 16], [66, 16], [66, 16], [66, 16], [66, 11]];
    for (let n = 1; n <= 10; n++) {
      const exec = one('s', { winW: 200, winH: 50 });
      for (let i = 1; i < n; i++) await T(exec, 'split-window', '-h', '-t', '%1', '-P', '-F', '#{pane_id}', '--', 'x');
      await T(exec, 'select-layout', '-t', '@1', 'tiled');
      assert.deepEqual([Math.min(...sizes(exec, '@1').map((s) => s[0])), Math.min(...sizes(exec, '@1').map((s) => s[1]))], want200[n - 1], `200x50 n=${n}`);
    }
    const want120 = [[120, 40], [120, 19], [59, 19], [59, 19], [59, 12], [59, 12]];
    for (let n = 1; n <= 6; n++) {
      const exec = one('s', { winW: 120, winH: 40 });
      for (let i = 1; i < n; i++) await T(exec, 'split-window', '-v', '-t', '%1', '-P', '-F', '#{pane_id}', '--', 'x');
      await T(exec, 'select-layout', '-t', '@1', 'tiled');
      assert.deepEqual([Math.min(...sizes(exec, '@1').map((s) => s[0])), Math.min(...sizes(exec, '@1').map((s) => s[1]))], want120[n - 1], `120x40 n=${n}`);
    }
  });

  test('F-2 (+) the raw tiled layouts of the spike: n = 2, 3 and 8 at 200 x 50 (the last pane of a row takes what is left)', async () => {
    const lay = async (n) => {
      const exec = one('s', { winW: 200, winH: 50 });
      for (let i = 1; i < n; i++) await T(exec, 'split-window', '-h', '-t', '%1', '-P', '-F', '#{pane_id}', '--', 'x');
      await T(exec, 'select-layout', '-t', '@1', 'tiled');
      return sizes(exec, '@1');
    };
    assert.deepEqual(await lay(2), [[200, 24], [200, 25]]);
    assert.deepEqual(await lay(3), [[99, 24], [100, 24], [200, 25]]);
    assert.deepEqual((await lay(8)).slice(-2), [[66, 16], [133, 16]]);
  });

  test('F-3 (+) split sizes: new = floor((n-1)/2), old = n-1-new, to the right (-h) or below (-v); the other panes are untouched (spike S-P1d)', async () => {
    const cases = [[200, [100, 99]], [199, [99, 99]], [161, [80, 80]], [160, [80, 79]]];
    for (const [width, [old, nw]] of cases) {
      const exec = one('s', { winW: width + 41, w: width, h: 50 });
      await T(exec, 'split-window', '-h', '-t', '%1', '-P', '-F', '#{pane_id}', '--', 'x');
      assert.deepEqual([exec.panes[0].w, exec.panes[1].w, exec.panes[1].h], [old, nw, 50], `-h ${width}`);
    }
    for (const [height, [old, nw]] of [[50, [25, 24]], [31, [15, 15]], [30, [15, 14]]]) {
      const exec = one('s', { winH: height + 11, w: 200, h: height });
      await T(exec, 'split-window', '-v', '-t', '%1', '-P', '-F', '#{pane_id}', '--', 'x');
      assert.deepEqual([exec.panes[0].h, exec.panes[1].h, exec.panes[1].w], [old, nw, 200], `-v ${height}`);
    }
  });

  test('F-4 (+) new-window -d keeps the current window and takes the size of the first window; without -d the new window is current', async () => {
    const exec = one('s', { winW: 150, winH: 40 });
    await T(exec, 'new-window', '-d', '-t', '=s:', '-n', 'agents', '-P', '-F', '#{pane_id}', '--', 'x');
    assert.deepEqual([...exec.windows.values()].map((x) => [x.id, x.index, x.active, x.w, x.h]), [['@1', 0, true, 150, 40], ['@2', 1, false, 150, 40]]);
    await T(exec, 'new-window', '-t', '=s:', '-n', 'next', '-P', '-F', '#{pane_id}', '--', 'x');
    assert.deepEqual([...exec.windows.values()].map((x) => [x.id, x.index, x.active]), [['@1', 0, false], ['@2', 1, false], ['@3', 2, true]]);
  });

  test('F-5 (+) list-panes -t @W lists one window and the format fields add up; (\u2212) other layouts, resizes and unknown windows throw', async () => {
    const exec = one('s', { winW: 200, winH: 50 });
    await T(exec, 'split-window', '-h', '-t', '%1', '-P', '-F', '#{pane_id}', '--', 'x');
    await T(exec, 'new-window', '-d', '-t', '=s:', '-n', 'agents', '-P', '-F', '#{pane_id}', '--', 'x');
    const out = (await T(exec, 'list-panes', '-t', '@1', '-F', '#{pane_id} #{window_id} #{window_panes} #{window_active} #{window_zoomed_flag} #{pane_width}x#{pane_height} #{window_width}x#{window_height}[#{@nika-fit}]')).stdout;
    assert.equal(out, '%1 @1 2 1 0 100x50 200x50[]\n%20 @1 2 1 0 99x50 200x50[]\n');
    await assert.rejects(T(exec, 'list-panes', '-t', '@9', '-F', '#{pane_id}'), /can't find window/);
    await assert.rejects(T(exec, 'select-layout', '-t', '@1', 'even-horizontal'), /unexpected select-layout/);
    await assert.rejects(T(exec, 'resize-pane', '-t', '%1', '-x', '50'), /unexpected tmux sub-command/);
    await assert.rejects(T(exec, 'select-layout', '-t', '@9', 'tiled'), /can't find window/);
  });

  test('F-6 (+) a split in a zoomed window ends the zoom (tmux does); a pane added by hand joins its window; failOn and onCall take their forms', async () => {
    const exec = one('s', { zoomed: '1' });
    assert.equal(exec.windows.get('@1').zoomed, '1');
    await T(exec, 'split-window', '-h', '-t', '%1', '-P', '-F', '#{pane_id}', '--', 'x');
    assert.equal(exec.windows.get('@1').zoomed, '0');
    const seen = [];
    exec.onCall('list-panes', (args, n) => seen.push([args[0], n]));
    await T(exec, 'list-panes', '-a', '-F', '#{pane_id}');
    await T(exec, 'list-panes', '-a', '-F', '#{pane_id}');
    assert.deepEqual(seen, [['-a', 1], ['-a', 2]]);
    const failing = fakeTmux({ panes: [{ id: '%1', session: 's' }], failOn: ['list-panes -s', (sub, args) => sub === 'has-session' && args.length === 2] });
    await assert.rejects(T(failing, 'list-panes', '-s', '-t', '=s', '-F', '#{pane_id}'), /list-panes failed/);
    assert.equal((await T(failing, 'list-panes', '-a', '-F', '#{pane_id}')).stdout, '%1\n');
    await assert.rejects(T(failing, 'has-session', '-t', '=s'), /has-session failed/);
  });

  test('F-7 (\u2212) a split-window whose target is a session (`=s:`) or not a pane id throws, and an unknown pane id is a tmux error: the fake never guesses which pane was meant', async () => {
    const exec = one('s');
    for (const target of ['=s:', 's', '%', '%1;ls', '%1234567', undefined]) {
      await assert.rejects(T(exec, 'split-window', '-h', '-t', target, '-P', '-F', '#{pane_id}', '--', 'x'), /split-window must target a pane id/, String(target));
    }
    await assert.rejects(T(exec, 'split-window', '-h', '-t', '%9', '-P', '-F', '#{pane_id}', '--', 'x'), /can't find pane/);
    assert.equal(exec.panes.length, 1, 'nothing was created');
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
      '--session-id', sid, '--model', 'sonnet', '-n', 'builder-1', '--append-system-prompt', guard,
      '--settings', SETTINGS(rd(w)), '--disallowedTools', ...DENIED, '--', 'Do the thing.',
    ]);
  });

  test('(+) permission mode and Remote Control come after --model and -n; .remote holds the RC name', async () => {
    const { w, run } = await prepared({}, { permissionMode: 'plan', remoteControl: { enabled: true, prefix: '' } });
    const { spawn } = await run();
    const sid = read(w, 'builder-1.session').trim();
    const args = spawn.calls[0].args;
    assert.deepEqual(args.slice(0, 9), ['--session-id', sid, '--model', 'sonnet', '--permission-mode', 'plan', '-n', 'builder-1', '--remote-control=my-app-builder-1']);
    assert.equal(args[9], '--append-system-prompt');
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
    const good = { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1, compact: null };
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
    for (const raw of ['{not json', '', `{"__proto__":{"x":1},"model":"sonnet","permissionMode":"default","rc":"","role":"agent","parent":null,"depth":1,"compact":null}`, ' '.repeat(5000)]) {
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
    fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'bypassPermissions', rc: '', role: 'agent', parent: null, depth: 1, compact: null }));
    assert.equal((await run()).code, 3);
    assert.equal(exists(w, 'builder-1.rc'), false);
    const agentJson = (rc) => fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'default', rc, role: 'agent', parent: null, depth: 1, compact: null }));
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
      '--session-id', sid, '--model', 'sonnet', '-n', 'planner', '--append-system-prompt', guard,
      '--settings', SETTINGS(rd(w)), '--disallowedTools', ...SUB_DENIED, '--', 'Do the thing.',
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
    const put2 = (v) => fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'default', rc: '', compact: null, ...v }));
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
      assert.deepEqual(agent(withOwn, SID.idle).report, { name: 'scout-1', status: 'STATUS: DONE nika-spawned report', rc: 3, hasFile: true, sessionId: SID.idle });
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

// --- 0.4: auto-compact for spawned agents and sub-orchestrators (ADR 0014) -----------------------------------------------------------
// spawnAgent computes compactLaunch(model, setting) once and stores { window, pct } in <name>.agent.json; _run-agent re-checks both and
// adds exactly the two variables to the env of the claude it starts (spawn(), no shell). Off: nothing is added.

describe('spawnAgent: .agent.json carries the compaction window and PCT (0.4)', () => {
  const compactOf = async (over = {}, settings, panes) => {
    const w = await world(settings);
    const r = await spawnAgent(req(w, over), w.ctx(fakeTmux({ panes: panes?.(w) ?? BASE_PANES() })));
    assert.equal(r.status, 200);
    return JSON.parse(read(w, `${over.name ?? 'builder-1'}.agent.json`)).compact;
  };

  test('(+) a 1M model with the default setting: window 400k, PCT 84.2106 (a string, as the env will carry it)', async () => {
    assert.deepEqual(await compactOf({ model: 'claude-opus-5-5' }), { window: 400000, pct: '84.2106' });
    assert.deepEqual(await compactOf({ model: 'opus[1m]' }), { window: 400000, pct: '84.2106' });
  });

  test('(+) a 200k model: W is the model\'s window; the spawn\'s own model decides, not the Settings orchestrator or builder model', async () => {
    assert.deepEqual(await compactOf({ model: 'claude-sonnet-4-6' }, { models: { builder: 'claude-opus-5-5' } }), { window: 200000, pct: '88.8889' });
    assert.deepEqual(await compactOf({ model: 'claude-opus-5-5' }, { models: { builder: 'claude-sonnet-4-5', orchestrator: 'claude-haiku-4-5' } }), { window: 400000, pct: '84.2106' });
  });

  test('(+) the setting decides: window 1M or "model", a pct above the cap sends PCT 100, off is null', async () => {
    assert.deepEqual(await compactOf({}, { compaction: { pct: 60, window: 1000000 } }), { window: 1000000, pct: '61.2245' });
    assert.deepEqual(await compactOf({}, { compaction: { window: 'model' } }), { window: 1000000, pct: '81.6327' });
    assert.deepEqual(await compactOf({ model: 'claude-haiku-4-5' }, { compaction: { window: 'model', pct: 20 } }), { window: 200000, pct: '22.2223' });
    assert.deepEqual(await compactOf({}, { compaction: { pct: 95 } }), { window: 400000, pct: '100' });
    assert.equal(await compactOf({}, { compaction: { enabled: false } }), null);
  });

  test('(+) a sub-orchestrator gets it too; a custom model id is a 200k model', async () => {
    const main = (w) => [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${w.project.key}/orchestrator`, depth: '1' }];
    assert.deepEqual(await compactOf({ name: 'planner', role: 'orchestrator', parent: '%1' }, undefined, main), COMPACT_1M);
    assert.deepEqual(await compactOf({ model: 'claude-future-9-20260101' }), { window: 200000, pct: '88.8889' });
  });

  test('(−) a refused spawn writes no .agent.json, so no compact either', async () => {
    const w = await world();
    const r = await spawnAgent(req(w, { model: 'gpt-5' }), w.ctx(fakeTmux({ panes: BASE_PANES() })));
    assert.equal(r.status, 400);
    assert.equal(fs.existsSync(rd(w)), false);
  });
});

describe('runAgent: the compaction variables in the env of the claude it starts (0.4)', () => {
  const COMMANDS = ['status', 'spawn', 'projects', 'rules', 'doctor'];
  const main = (w) => [{ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${w.project.key}/orchestrator`, depth: '1' }];
  const INHERITED = { PATH: '/usr/bin', HOME: '/nonexistent', TMUX_PANE: '%20', LANG: 'C' };
  const withEnv = (w, extra = {}) => ({ ...w.env, ...INHERITED, ...extra });

  test('(+) an agent: the inherited env plus the window and PCT, nothing else added, and the run\'s own env object is not changed', async () => {
    const { w, run } = await prepared();
    const env = withEnv(w);
    const before = { ...env };
    const spawn = fakeSpawn();
    const { code } = await run({ spawn, env }); // `extra.env` replaces the default env of run()
    assert.equal(code, 0);
    assert.deepEqual(spawn.calls[0].opts.env, { ...before, [WINDOW_ENV]: '400000', [PCT_ENV]: '84.2106' });
    assert.deepEqual(env, before, 'the context env is copied, never written to');
    assert.equal(spawn.calls[0].opts.shell, false);
    assert.equal(spawn.calls[0].opts.stdio, 'inherit');
  });

  test('(+) a sub-orchestrator gets the same pair', async () => {
    const { w, run } = await prepared({ name: 'planner', role: 'orchestrator', parent: '%1' }, undefined, main);
    const env = withEnv(w);
    const spawn = fakeSpawn();
    await run({ spawn, env, commands: COMMANDS });
    assert.deepEqual(spawn.calls[0].opts.env, { ...env, [WINDOW_ENV]: '400000', [PCT_ENV]: '84.2106' });
  });

  test('(+) a 200k model and a pct above the cap: PCT 100 on the last; the argv is unchanged by either', async () => {
    const small = await prepared({ model: 'claude-sonnet-4-6' });
    const s1 = fakeSpawn();
    await small.run({ spawn: s1, env: withEnv(small.w) });
    assert.deepEqual([s1.calls[0].opts.env[WINDOW_ENV], s1.calls[0].opts.env[PCT_ENV]], ['200000', '88.8889']);
    const cap = await prepared({}, { compaction: { pct: 95 } });
    const s2 = fakeSpawn();
    await cap.run({ spawn: s2, env: withEnv(cap.w) });
    assert.equal(s2.calls[0].opts.env[WINDOW_ENV], '400000');
    assert.equal(s2.calls[0].opts.env[PCT_ENV], '100', 'always set: an inherited PCT never stays in force');
    const sid = read(small.w, 'builder-1.session').trim();
    assert.deepEqual(s1.calls[0].args.slice(0, 6), ['--session-id', sid, '--model', 'claude-sonnet-4-6', '-n', 'builder-1']);
    assert.ok(![...s1.calls[0].args, ...s2.calls[0].args].some((a) => /autocompact/i.test(a)), 'the --autocompact flag is never used');
  });

  test('(+) off: nothing is added, the inherited env goes through unchanged (a variable the tmux server set stays)', async () => {
    const { w, run } = await prepared({}, { compaction: { enabled: false } });
    const env = withEnv(w, { [WINDOW_ENV]: '150000', [PCT_ENV]: '50' });
    const spawn = fakeSpawn();
    await run({ spawn, env });
    assert.deepEqual(spawn.calls[0].opts.env, env);
    assert.equal(spawn.calls[0].opts.env[WINDOW_ENV], '150000');
    assert.equal(JSON.parse(read(w, 'builder-1.agent.json')).compact, null);
  });

  test('(+) on: nika\'s value replaces a variable inherited from the tmux server', async () => {
    const { w, run } = await prepared();
    const spawn = fakeSpawn();
    await run({ spawn, env: withEnv(w, { [WINDOW_ENV]: '150000', [PCT_ENV]: '50' }) });
    assert.equal(spawn.calls[0].opts.env[WINDOW_ENV], '400000');
    assert.equal(spawn.calls[0].opts.env[PCT_ENV], '84.2106');
  });

  test('(−) a tampered compact is refused (exit 3) and claude never runs: window out of range or not an integer, PCT not digits and a dot, extra or missing keys, wrong shapes', async () => {
    const good = { window: 400000, pct: '84.2106' };
    const variants = [
      { ...good, window: 99999 }, { ...good, window: 1000001 }, { ...good, window: 0 }, { ...good, window: -400000 }, { ...good, window: 400000.5 }, { ...good, window: '400000' },
      { ...good, window: null }, { ...good, window: [400000] }, { ...good, window: 'model' }, { pct: good.pct }, // window missing
      { ...good, pct: '0' }, { ...good, pct: '0.0000' }, { ...good, pct: '100.0001' }, { ...good, pct: '101' }, { ...good, pct: 84.2106 }, { ...good, pct: 80 }, { ...good, pct: '' },
      { ...good, pct: '84.21061' }, { ...good, pct: '8e1' }, { ...good, pct: ' 80' }, { ...good, pct: '80\n' }, { ...good, pct: '80;rm -rf' }, { ...good, pct: '$HOME' }, { ...good, pct: '-5' },
      { ...good, pct: undefined }, { ...good, pct: null }, // pct is always a string when compact is on (null is for the whole compact only)
      { ...good, extra: 1 }, { ...good, flag: '--autocompact' }, { window: 400000 }, {}, [], [400000, '84.2106'], 'on', 5, true, '{}',
    ];
    for (const compact of variants) {
      const { w, run } = await prepared();
      const raw = { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1, compact };
      fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify(raw));
      const { code, spawn, stderr } = await run();
      assert.equal(code, 3, JSON.stringify(compact));
      assert.equal(spawn.calls.length, 0, JSON.stringify(compact));
      assert.match(stderr.lines.join(''), /compact/, JSON.stringify(compact));
      assert.equal(exists(w, 'builder-1.session'), false);
    }
  });

  test('(−) agent.json without the compact key is refused (exit 3); with compact: null it runs and adds nothing', async () => {
    const { w, run } = await prepared();
    const base = { model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1 };
    fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify(base));
    assert.equal((await run()).code, 3);
    fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ ...base, compact: null }));
    const ok = await run({ spawn: fakeSpawn(), env: withEnv(w) });
    assert.equal(ok.code, 0);
    assert.deepEqual(ok.spawn.calls[0].opts.env, withEnv(w));
  });

  test('(+) a compact with PCT "100" (the target is above the cap) runs with both variables', async () => {
    const { w, run } = await prepared();
    fs.writeFileSync(path.join(rd(w), 'builder-1.agent.json'), JSON.stringify({ model: 'sonnet', permissionMode: 'default', rc: '', role: 'agent', parent: null, depth: 1, compact: { window: 400000, pct: '100' } }));
    const spawn = fakeSpawn();
    assert.equal((await run({ spawn, env: withEnv(w) })).code, 0);
    assert.deepEqual(spawn.calls[0].opts.env, { ...withEnv(w), [WINDOW_ENV]: '400000', [PCT_ENV]: '100' });
  });
});

// --- a window the fit holds is given back before a split lands in it (W7, owner answer Q3) -------------------------------------

describe('spawnAgent: the fit is never asked (0.5.4, P1)', () => {
  // A split used to ask the app tier's fit to give a window back first; a fitted window is now never split into, so ctx.fit has no part in a spawn.
  const noFit = () => new Proxy({}, { get: (_, k) => { throw new Error(`ctx.fit.${String(k)} was used`); } });
  const norm = (w, calls) => calls.map((c) => c.map((x) => String(x).replace(w.project.key, 'KEY').replace(w.project.dir, 'DIR')));

  test('(+) a ctx.fit that throws on any use: beside, then a new tmux window, then a new session all answer 200, with the tmux calls of a spawn without ctx.fit', async () => {
    const run = async (extra) => {
      const w = await world();
      const exec = fakeTmux({ panes: BASE_PANES() });
      const ctx = w.ctx(exec, extra);
      const first = await spawnAgent(req(w, { name: 'one' }), ctx);
      const second = await spawnAgent(req(w, { name: 'two' }), ctx);
      const fresh = fakeTmux();
      const third = await spawnAgent(req(w, { name: 'three' }), w.ctx(fresh, extra));
      return { statuses: [first.status, second.status, third.status], placements: [first.body.placement, second.body.placement, third.body.placement], calls: norm(w, exec.calls), fresh: norm(w, fresh.calls) };
    };
    const without = await run({});
    const withFit = await run({ fit: noFit() });
    assert.deepEqual(without.statuses, [200, 200, 200]);
    assert.deepEqual(without.placements, ['beside', 'window', 'session']);
    assert.deepEqual(withFit, without);
  });

  test('(\u2212) a refused spawn (the name is already running, a bad parent, the cap) never touches ctx.fit either', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [...BASE_PANES(), { id: '%30', session: 'My-App', window: 0, windowName: 'x', command: 'node', role: 'agent', agent: `${w.project.key}/builder-1`, depth: '1' }] });
    const r = await spawnAgent(req(w), w.ctx(exec, { fit: noFit() }));
    assert.deepEqual([r.status, r.body.error], [409, 'conflict']);
    assert.equal(exec.of('split-window').length + exec.of('new-window').length, 0);
  });
});

describe('spawnAgent: the kind label (0.5, W9)', () => {
  const MAIN = (w) => ({ id: '%1', session: 'My-App', window: 0, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: `${w.project.key}/orchestrator`, depth: '1' });
  const KIND_CALL = (pane, kind) => [TMUX, '-u', 'set-option', '-p', '-t', pane, '@nika-kind', kind];
  const kindCalls = (exec) => exec.of('set-option').filter((c) => c[4] === '@nika-kind').map((c) => c[5]);
  const MSG_KIND = 'invalid kind: use coder, reviewer, tester, designer, scout, writer or agent';
  const MSG_ORCH = 'kind is for agents: a sub-orchestrator always shows sub-orchestrator';
  const paneOf = (exec, id) => exec.panes.find((p) => p.id === id);
  /** Spawns once in a fresh world (Settings `settings`, then `after(w)`), returns { r, exec, w }. */
  async function spawnOnce(over = {}, { settings, after: setup, panes } = {}) {
    const w = await world(settings);
    await setup?.(w);
    const exec = fakeTmux({ panes: panes?.(w) ?? BASE_PANES() });
    const r = await spawnAgent(req(w, over), w.ctx(exec));
    return { r, exec, w };
  }

  test('(+) kind reviewer under the main orchestrator: @nika-kind reviewer is the last tag call, after @nika-parent; the body carries it; the listing reads it back', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [MAIN(w)] });
    const r = await spawnAgent(req(w, { kind: 'reviewer', parent: '%1' }), w.ctx(exec));
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'reviewer');
    assert.deepEqual(exec.calls, [
      LIST_ALL,
      LIST_AGENTS,
      L1(),
      [TMUX, '-u', 'split-window', '-h', '-t', '%1', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', ...NIKA_ARGV, '_run-agent', w.project.key, 'builder-1'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'agent'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/builder-1`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '2'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-parent', '%1'],
      KIND_CALL('%20', 'reviewer'),
      CHECK('%20'),
      [TMUX, '-u', 'select-pane', '-t', '%20', '-T', '[%20] builder-1'],
    ]);
    const { panes } = await listPanes(exec, TMUX);
    assert.deepEqual([panes.get('%20').role, panes.get('%20').kind], ['agent', 'reviewer']);
    assert.equal(panes.get('%1').kind, null, 'the orchestrator pane has none');
  });

  test('(+) each of the seven words can be asked for', async () => {
    for (const kind of ['coder', 'reviewer', 'tester', 'designer', 'scout', 'writer', 'agent']) {
      const { r, exec } = await spawnOnce({ kind });
      assert.equal(r.status, 200, kind);
      assert.equal(r.body.kind, kind);
      assert.deepEqual(kindCalls(exec), [kind]);
      assert.equal(paneOf(exec, '%20').kind, kind);
    }
  });

  test('(+) a kind asked for beats the model: the Builder model with kind writer is writer; kind agent on the Builder model is agent', async () => {
    assert.equal((await spawnOnce({ model: 'claude-sonnet-5-5', kind: 'writer' })).r.body.kind, 'writer');
    const { r, exec } = await spawnOnce({ model: 'claude-sonnet-5-5', kind: 'agent' });
    assert.equal(r.body.kind, 'agent');
    assert.deepEqual(kindCalls(exec), ['agent']);
  });

  test('(+) without kind the model decides at spawn: the Builder model is coder, the Reasoner designer, the Scout scout, anything else agent', async () => {
    const table = [['claude-sonnet-5-5', 'coder'], ['claude-opus-5-5', 'designer'], ['claude-haiku-5-5', 'scout'], ['claude-fable-5-1', 'agent'], ['claude-sonnet-4-1', 'agent']];
    for (const [model, kind] of table) {
      const { r, exec } = await spawnOnce({ model });
      assert.equal(r.status, 200, model);
      assert.equal(r.body.kind, kind, model);
      assert.deepEqual(kindCalls(exec), [kind], model);
      assert.equal(paneOf(exec, '%20').kind, kind, model);
    }
  });

  test('(−) without kind an alias or a 1M id is not a role\'s model (exact match, no alias resolution): agent', async () => {
    for (const model of ['sonnet', 'opus', 'haiku', 'claude-sonnet-5-5[1m]', 'sonnet[1m]']) {
      const { r, exec } = await spawnOnce({ model });
      assert.deepEqual([r.status, r.body.kind, kindCalls(exec)], [200, 'agent', ['agent']], model);
    }
  });

  test('(+) the project\'s own role models beat Settings\': its Builder id is coder and Settings\' is no longer', async () => {
    const own = (w) => updateProjectConfig(w.project.key, { models: { orchestrator: null, reasoner: null, builder: 'claude-sonnet-4-1', scout: null } }, w.env);
    assert.equal((await spawnOnce({ model: 'claude-sonnet-4-1' }, { after: own })).r.body.kind, 'coder');
    assert.equal((await spawnOnce({ model: 'claude-sonnet-5-5' }, { after: own })).r.body.kind, 'agent', 'Settings\' builder id is overridden for this project');
    assert.equal((await spawnOnce({ model: 'claude-haiku-5-5' }, { after: own })).r.body.kind, 'scout', 'a role the project leaves alone still follows Settings');
  });

  test('(+) Settings\' role models decide when the project sets none', async () => {
    assert.equal((await spawnOnce({ model: 'claude-opus-4-1' }, { settings: { models: { builder: 'claude-opus-4-1' } } })).r.body.kind, 'coder');
  });

  test('(−) two roles on one id that name different kinds: agent', async () => {
    const { r, exec } = await spawnOnce({ model: 'claude-sonnet-5-5' }, { settings: { models: { scout: 'claude-sonnet-5-5' } } });
    assert.deepEqual([r.body.kind, kindCalls(exec)], ['agent', ['agent']]);
  });

  test('(+) a sub-orchestrator gets no @nika-kind call at all, and its body kind is null', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [MAIN(w)] });
    const r = await spawnAgent(req(w, { name: 'planner', role: 'orchestrator', parent: '%1', model: 'claude-sonnet-5-5' }), w.ctx(exec));
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, null);
    assert.deepEqual(kindCalls(exec), []);
    assert.deepEqual(exec.of('set-option').map((c) => c[4]), ['@nika-role', '@nika-agent', '@nika-depth', '@nika-parent']);
    assert.equal(paneOf(exec, '%20').kind ?? '', '');
  });

  test('(−) a kind that is not a word of the list is 400 invalid with the exact message; nothing is written and tmux is never called', async () => {
    for (const kind of ['Coder', 'CODER', 'boss', '', null, 5, ['coder'], 'coder ', ' coder', 'sub-orchestrator', 'orchestrator', {}, true, 'coder\n']) {
      const w = await world();
      const exec = fakeTmux({ panes: BASE_PANES() });
      const r = await spawnAgent(req(w, { kind }), w.ctx(exec));
      assert.deepEqual(r, { status: 400, body: { error: 'invalid', message: MSG_KIND } }, JSON.stringify(kind));
      assert.deepEqual(exec.calls, [], JSON.stringify(kind));
      assert.equal(fs.existsSync(rd(w)), false, `${JSON.stringify(kind)}: no report folder, brief or agent.json`);
    }
  });

  test('(−) a kind with role orchestrator is 400 with its own message; nothing is created', async () => {
    for (const kind of ['coder', 'agent', 'reviewer']) {
      const w = await world();
      const exec = fakeTmux({ panes: [MAIN(w)] });
      const r = await spawnAgent(req(w, { name: 'planner', role: 'orchestrator', parent: '%1', kind }), w.ctx(exec));
      assert.deepEqual(r, { status: 400, body: { error: 'invalid', message: MSG_ORCH } }, kind);
      assert.deepEqual(exec.calls, []);
      assert.equal(fs.existsSync(rd(w)), false);
    }
  });

  test('(−) the kind check runs before anything else of the request: an invalid kind beside an invalid project key still reads as the first failing check in parse order', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: BASE_PANES() });
    const bad = await spawnAgent({ ...req(w, { kind: 'boss' }), project: 'nope' }, w.ctx(exec));
    assert.equal(bad.body.message, 'invalid project key', 'project is checked first, as before');
    const unregistered = await spawnAgent(req(w, { kind: 'boss', project: '0123456789abcdef' }), w.ctx(exec));
    assert.equal(unregistered.status, 400, 'a bad kind is refused before the project is looked up');
    assert.equal(unregistered.body.message, MSG_KIND);
    assert.deepEqual(exec.calls, []);
  });

  test('(−) the kind never reaches claude: agent.json keeps its seven keys, no file holds it, claude\'s argv and env do not carry it', async () => {
    const { w, run } = await prepared({ kind: 'reviewer' });
    assert.deepEqual(Object.keys(JSON.parse(read(w, 'builder-1.agent.json'))).sort(), ['compact', 'depth', 'model', 'parent', 'permissionMode', 'rc', 'role']);
    assert.deepEqual(fs.readdirSync(rd(w)).sort(), ['.last-pane', 'builder-1.agent.json', 'builder-1.brief.md']);
    for (const f of fs.readdirSync(rd(w))) assert.equal(read(w, f).includes('reviewer'), false, f);
    const { spawn } = await run();
    assert.equal(JSON.stringify(spawn.calls[0].args).includes('reviewer'), false);
    assert.equal(Object.keys(spawn.calls[0].opts.env).some((k) => /kind/i.test(k)), false);
  });

  test('(−) an agent.json with a kind key is refused by _run-agent (exit 3): the file nika wrote has none', async () => {
    const { w, run } = await prepared();
    const good = JSON.parse(read(w, 'builder-1.agent.json'));
    await put(w, 'builder-1.agent.json', `${JSON.stringify({ ...good, kind: 'coder' })}\n`);
    const { code, spawn, stderr } = await run();
    assert.equal(code, 3);
    assert.equal(spawn.calls.length, 0);
    assert.match(stderr.lines.join(''), /unexpected fields/);
  });

  test('(−) the started record of the process is unchanged by the kind (the snapshot reads the tag)', async () => {
    const w = await world();
    const ctx = w.ctx(fakeTmux({ panes: BASE_PANES() }));
    await spawnAgent(req(w, { kind: 'tester' }), ctx);
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'builder-1', sessionId: null, role: 'agent', parent: null, depth: 1, mode: 'manual' });
  });
});

describe("agentSettings: the agent's --settings JSON (0.5, F18; spike S-ADD)", () => {
  test('(+) the deny list as before, and the reports dir as the one additional directory, nothing else', () => {
    const dir = path.join(path.sep, 'state', 'nika', 'projects', 'abcdef0123456789', 'reports');
    const s = JSON.parse(agentSettings(dir));
    assert.deepEqual(Object.keys(s), ['permissions']);
    assert.deepEqual(Object.keys(s.permissions), ['deny', 'additionalDirectories']);
    assert.deepEqual(s.permissions.deny, ['Read(**/.env*)', 'Edit(**/.env*)', 'Read(**/*.key)', 'Edit(**/*.key)']);
    assert.deepEqual(s.permissions.additionalDirectories, [dir]);
    assert.equal(agentSettings(dir), SETTINGS(dir));
  });

  test('(−) a dir with quotes, spaces or a backslash stays one JSON string: it never adds a key or a second directory', () => {
    const dir = path.join(path.sep, 'state', 'a "b" c\\d', '"],"allow":["Bash(*)');
    const s = JSON.parse(agentSettings(dir));
    assert.deepEqual(s.permissions.additionalDirectories, [dir]);
    assert.deepEqual(Object.keys(s.permissions), ['deny', 'additionalDirectories']);
    assert.equal(s.permissions.allow, undefined);
  });

  test('(−) spawn never passes --add-dir: Claude Code 2.1.326 asks to trust such a folder at every start', () => {
    const src = fs.readFileSync(new URL('../src/spawn.js', import.meta.url), 'utf8');
    assert.ok(!/'--add-dir'/.test(src));
  });
});
