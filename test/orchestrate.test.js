// startOrchestrator and the shared tmux/rc helpers; in-memory tmux, temp dirs, synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOrchestrator, launchArgv, inProject, pickState, claudePane, sessionNameFor, reduceRc, tmuxLiteral } from '../src/orchestrate.js';
import { configDir } from '../src/paths.js';
import { addProject, getOrchestrator, setOrchestrator, loadConfig, updateProjectConfig } from '../src/store.js';
import { fakeTmux, makeWorld, TMUX, CLAUDE } from './tmux-fake.js';

const worlds = [];
const world = async (settings) => {
  const w = await makeWorld(settings);
  worlds.push(w);
  return w;
};
after(() => worlds.forEach((w) => w.cleanup()));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const claudeFlags = (argv) => argv.slice(argv.indexOf('--') + 2);
// the one tmux listing findOrchestratorPane makes: every pane of the project's session with its window name
const LIST_ORCH = [TMUX, '-u', 'list-panes', '-s', '-t', '=My-App', '-F', '#{pane_id}\t#{pane_current_command}\t#{@nika-role}\t#{@nika-agent}\t#{window_name}'];
const PICK = '11111111-1111-4111-8111-111111111111';
const PICK_PANE = { id: '%8', session: 'other-session', command: 'claude' };
/** ctx.findSession as src/model.js gives it: { agent, group } of one session, or null when nika has no transcript for it. */
const sessionLookup = (agent, key, group = {}) => async (id) => (agent === null ? null : { agent: { id, name: 'planner', live: false, pane: null, ...agent }, group: { key, agents: [], ...group } });

describe('tmux format injection in -c (start-directory is format-expanded; #(cmd) runs cmd)', () => {
  test('(+) tmuxLiteral doubles every # and leaves other text alone', () => {
    assert.equal(tmuxLiteral('/p/plain dir'), '/p/plain dir');
    assert.equal(tmuxLiteral('/p/a#(touch x)#{session_name}##'), '/p/a##(touch x)##{session_name}####');
  });

  test('(−) a project dir with #(…) and #{…} reaches tmux -c escaped, so tmux never runs or expands it', async () => {
    const w = await world();
    const dir = path.join(w.root, 'evil#(touch PWNED)#{session_name}');
    fs.mkdirSync(dir);
    const project = await addProject(dir, w.env);
    const exec = fakeTmux();
    const r = await startOrchestrator(project.key, w.ctx(exec));
    assert.equal(r.status, 200);
    const argv = exec.of('new-session')[0];
    assert.equal(argv[argv.indexOf('-c') + 1], path.join(fs.realpathSync(w.root), 'evil##(touch PWNED)##{session_name}'));
  });

  test('(−) source invariant: every tmux -c argument in src/ goes through tmuxLiteral()', () => {
    const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
    const offenders = [];
    for (const file of fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js'))) {
      for (const m of fs.readFileSync(path.join(src, file), 'utf8').matchAll(/'-c',\s*([^,\]\)]+)/g)) {
        if (!m[1].trim().startsWith('tmuxLiteral(')) offenders.push(`${file}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('startOrchestrator: new session', () => {
  test('(+) no tmux server: has-session fails, new-session runs claude with the exact flags (argv snapshot)', async () => {
    const w = await world();
    const exec = fakeTmux();
    const ctx = w.ctx(exec);
    const r = await startOrchestrator(w.project.key, ctx);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { pane: '%20', session: 'My-App', sessionId: r.body.sessionId, created: true });
    assert.match(r.body.sessionId, UUID);
    assert.deepEqual(exec.calls, [
      [TMUX, '-u', 'has-session', '-t', '=My-App'],
      [TMUX, '-u', 'new-session', '-d', '-s', 'My-App', '-n', 'orchestrator', '-c', w.project.dir, '-x', '200', '-y', '50',
        '-P', '-F', '#{pane_id}', '--', CLAUDE,
        '--session-id', r.body.sessionId, '--model', 'claude-fable-5-1', '-n', 'My-App'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'orchestrator'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/orchestrator`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '1'],
    ]);
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'orchestrator', sessionId: r.body.sessionId, role: 'orchestrator', mode: 'manual' });
  });

  test('(+) started records the launch permission mode from the settings', async () => {
    for (const [permissionMode, mode] of [['plan', 'plan'], ['acceptEdits', 'acceptEdits'], ['default', 'manual']]) {
      const w = await world({ permissionMode });
      const ctx = w.ctx(fakeTmux());
      const r = await startOrchestrator(w.project.key, ctx);
      assert.equal(ctx.started.get(r.body.pane).mode, mode, permissionMode);
    }
  });

  test('(+) other sessions exist but not this one: still new-session; a longer name is not a prefix match', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [{ id: '%1', session: 'My-App-2' }] });
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.equal(r.body.created, true);
    assert.equal(exec.of('new-session').length, 1);
  });

  test('(+) model, permission mode and Remote Control come from the settings', async () => {
    const w = await world({ models: { orchestrator: 'opus' }, permissionMode: 'plan', remoteControl: { enabled: true, prefix: '' } });
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.deepEqual(claudeFlags(exec.of('new-session')[0]), [
      '--session-id', r.body.sessionId, '--model', 'opus', '--permission-mode', 'plan', '-n', 'My-App', '--remote-control=my-app',
    ]);
  });

  test('(+) the project\'s own orchestrator model (Models dialog) is the one nika starts; another project\'s is not', async () => {
    const w = await world();
    await updateProjectConfig(w.project.key, { models: { orchestrator: 'claude-opus-5-5', reasoner: null, builder: null, scout: null } }, w.env);
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.deepEqual(claudeFlags(exec.of('new-session')[0]), ['--session-id', r.body.sessionId, '--model', 'claude-opus-5-5', '-n', 'My-App']);
    const v = await world();
    const other = await addProject(fs.mkdtempSync(path.join(v.root, 'other-')), v.env);
    await updateProjectConfig(other.key, { models: { orchestrator: 'opus', reasoner: null, builder: null, scout: null } }, v.env);
    const exec2 = fakeTmux();
    await startOrchestrator(v.project.key, v.ctx(exec2));
    assert.equal(claudeFlags(exec2.of('new-session')[0])[3], 'claude-fable-5-1');
  });

  test('(+) a configured Remote Control prefix is the RC name', async () => {
    const w = await world({ remoteControl: { enabled: true, prefix: 'team1' } });
    const exec = fakeTmux();
    await startOrchestrator(w.project.key, w.ctx(exec));
    assert.equal(claudeFlags(exec.of('new-session')[0]).at(-1), '--remote-control=team1');
  });

  test('(−) no --remote-control flag while Remote Control is off, no --permission-mode for default', async () => {
    const w = await world();
    const exec = fakeTmux();
    await startOrchestrator(w.project.key, w.ctx(exec));
    const flags = claudeFlags(exec.of('new-session')[0]);
    assert.ok(!flags.some((f) => f.startsWith('--remote-control')));
    assert.ok(!flags.includes('--permission-mode'));
  });

  test('(−) bypassPermissions in a tampered config.json falls back to default: never reaches claude', async () => {
    const w = await world();
    const file = path.join(configDir(w.env), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.permissionMode = 'bypassPermissions';
    fs.writeFileSync(file, JSON.stringify(cfg));
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(exec.calls).includes('bypassPermissions'));
  });

  test('(−) new-session failing is a 502 tmux_failed and records nothing; a pane id that is not %n is refused', async () => {
    const w = await world();
    let ctx = w.ctx(fakeTmux({ failOn: ['new-session'] }));
    let r = await startOrchestrator(w.project.key, ctx);
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'tmux_failed');
    assert.match(r.body.message, /new-session failed/);
    assert.equal(ctx.started.size, 0);

    const odd = async (cmd, args) => (args[1] === 'has-session' ? Promise.reject(Object.assign(new Error('x'), { code: 1 })) : { stdout: 'not-a-pane\n', stderr: '' });
    ctx = w.ctx(odd);
    r = await startOrchestrator(w.project.key, ctx);
    assert.equal(r.status, 502);
    assert.equal(ctx.started.size, 0);
  });
});

describe('startOrchestrator: existing session', () => {
  const sessionWith = (command, extra = {}) => fakeTmux({ panes: [{ id: '%3', session: 'My-App', window: 1, windowName: 'orchestrator', command, role: 'orchestrator', ...extra }] });

  test('(+) the orchestrator window already runs claude: its pane is returned, nothing is created (argv snapshot)', async () => {
    const w = await world();
    for (const command of ['claude', 'node', '2.1.319']) {
      const exec = sessionWith(command);
      const ctx = w.ctx(exec);
      const r = await startOrchestrator(w.project.key, ctx);
      assert.deepEqual(r, { status: 200, body: { pane: '%3', session: 'My-App', sessionId: null, created: false } }, command);
      assert.deepEqual(exec.calls, [[TMUX, '-u', 'has-session', '-t', '=My-App'], LIST_ORCH]);
      assert.equal(ctx.started.size, 0); // a pane nika did not create is not marked as started
    }
  });

  test('(+) sessionId is returned when nika started that pane in this process', async () => {
    const w = await world();
    const sid = '11111111-1111-4111-8111-111111111111';
    const ctx = w.ctx(sessionWith('claude'), { started: new Map([['%3', { key: w.project.key, name: 'orchestrator', sessionId: sid, role: 'orchestrator' }]]) });
    const r = await startOrchestrator(w.project.key, ctx);
    assert.equal(r.body.sessionId, sid);
    assert.equal(r.body.created, false);
  });

  test('(+) session without an orchestrator window: new-window with the same claude flags (argv snapshot)', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [{ id: '%1', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }] });
    const ctx = w.ctx(exec);
    const r = await startOrchestrator(w.project.key, ctx);
    assert.deepEqual(r.body, { pane: '%20', session: 'My-App', sessionId: r.body.sessionId, created: true });
    assert.deepEqual(exec.calls.slice(1), [
      LIST_ORCH,
      [TMUX, '-u', 'new-window', '-t', '=My-App:', '-n', 'orchestrator', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', CLAUDE,
        '--session-id', r.body.sessionId, '--model', 'claude-fable-5-1', '-n', 'My-App'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'orchestrator'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/orchestrator`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '1'],
    ]);
    assert.equal(ctx.started.get('%20').sessionId, r.body.sessionId);
    assert.equal(exec.panes.find((p) => p.id === '%20').role, 'orchestrator');
  });

  test('(−) a window only prefixed `orchestrator` (e.g. orchestrator-x) that nika did not tag is never reused', async () => {
    const w = await world();
    const exec = sessionWith('claude', { windowName: 'orchestrator-x', role: '' });
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.equal(r.body.created, true);
    assert.notEqual(r.body.pane, '%3');
    assert.equal(exec.of('new-window').length, 1);
  });

  test('(−) the orchestrator exited: an agent pane (role agent, running node) in its window is not returned, a new window is made', async () => {
    const w = await world();
    const exec = fakeTmux({
      panes: [
        { id: '%3', session: 'My-App', window: 1, windowName: 'orchestrator', command: 'zsh', role: 'orchestrator' }, // claude exited
        { id: '%4', session: 'My-App', window: 1, windowName: 'orchestrator', command: 'node', role: 'agent' },
        { id: '%5', session: 'My-App', window: 1, windowName: 'orchestrator', command: '2.1.319', role: 'agent' },
      ],
    });
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.deepEqual([r.body.created, r.body.pane], [true, '%20']);
    assert.equal(exec.of('new-window').length, 1);
    assert.deepEqual(exec.of('set-option'), [
      ['set-option', '-p', '-t', '%20', '@nika-role', 'orchestrator'],
      ['set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/orchestrator`],
      ['set-option', '-p', '-t', '%20', '@nika-depth', '1'],
    ]);
  });

  test('(−) an untagged claude pane (not created by nika, or tagging failed) is not reused', async () => {
    for (const role of ['', 'agent', 'other']) {
      const w = await world(); // a start saves its session as the project's pick, so each round gets its own project
      const exec = sessionWith('claude', { role });
      const r = await startOrchestrator(w.project.key, w.ctx(exec));
      assert.deepEqual([r.body.created, exec.of('new-window').length], [true, 1], JSON.stringify(role));
    }
  });

  test('(+) tagging is best effort: set-option failing still returns the new orchestrator pane', async () => {
    const w = await world();
    const r = await startOrchestrator(w.project.key, w.ctx(fakeTmux({ failOn: ['set-option'] })));
    assert.deepEqual([r.status, r.body.created, r.body.pane], [200, true, '%20']);
  });

  test('(+) an orchestrator window that runs something else (a shell) gets a new window', async () => {
    const w = await world();
    const exec = sessionWith('zsh');
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.equal(r.body.created, true);
    assert.equal(exec.of('new-window').length, 1);
    assert.equal(exec.of('new-session').length, 0);
  });
});

describe('startOrchestrator: an adopted pane outside the orchestrator window', () => {
  // adopting (PUT …/orchestrator) tags the pane `<key>/orchestrator`; a pane outside the orchestrator window counts only with that tag
  const adopted = (w, over = {}) => ({ id: '%6', session: 'My-App', window: 2, windowName: 'main', command: 'claude', role: 'orchestrator', agent: `${w.project.key}/orchestrator`, ...over });

  test('(+) a pane tagged orchestrator that runs claude in another window of the project session is returned, nothing is created (argv snapshot)', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [{ id: '%1', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }, adopted(w)] });
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.deepEqual(r, { status: 200, body: { pane: '%6', session: 'My-App', sessionId: null, created: false } });
    assert.deepEqual(exec.calls, [[TMUX, '-u', 'has-session', '-t', '=My-App'], LIST_ORCH]);
  });

  test('(+) the pane in the `orchestrator` window wins over an adopted one, whatever the listing order', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [adopted(w), { id: '%3', session: 'My-App', window: 1, windowName: 'orchestrator', command: 'node', role: 'orchestrator' }] });
    assert.equal((await startOrchestrator(w.project.key, w.ctx(exec))).body.pane, '%3');
  });

  test('(−) an untagged pane, a forged tag (agent or any other word) and a tagged pane that no longer runs claude are ignored: a new window is made', async () => {
    for (const over of [{ role: '' }, { role: 'agent' }, { role: 'other' }, { role: 'Orchestrator' }, { command: 'zsh' }, { command: 'vim' }]) {
      const w = await world();
      const exec = fakeTmux({ panes: [adopted(w, over)] });
      const r = await startOrchestrator(w.project.key, w.ctx(exec));
      assert.deepEqual([r.body.created, exec.of('new-window').length], [true, 1], JSON.stringify(over));
    }
  });

  test('(−) an adopted-looking pane whose tag names another project or another name, or has no tag at all, is not this project\'s main orchestrator', async () => {
    for (const agent of ['', 'ffffffffffffffff/orchestrator', 'KEY/orchestrator', 'x', 'not/a/tag']) {
      const w = await world();
      const tag = agent === 'KEY/orchestrator' ? `${w.project.key}/planner` : agent;
      const exec = fakeTmux({ panes: [adopted(w, { agent: tag })] });
      const r = await startOrchestrator(w.project.key, w.ctx(exec));
      assert.deepEqual([r.body.created, exec.of('new-window').length], [true, 1], JSON.stringify(tag));
    }
  });

  test('(−) a pane tagged for another project in the `orchestrator` window is not this project\'s either; the legacy 0.3 pane (no tag, `orchestrator` window) still is', async () => {
    const w = await world();
    const foreign = fakeTmux({ panes: [{ id: '%3', session: 'My-App', window: 1, windowName: 'orchestrator', command: 'claude', role: 'orchestrator', agent: 'ffffffffffffffff/orchestrator' }] });
    assert.equal((await startOrchestrator(w.project.key, w.ctx(foreign))).body.created, true);
    const v = await world();
    const legacy = fakeTmux({ panes: [{ id: '%3', session: 'My-App', window: 1, windowName: 'orchestrator', command: 'claude', role: 'orchestrator' }] });
    assert.deepEqual((await startOrchestrator(v.project.key, v.ctx(legacy))).body, { pane: '%3', session: 'My-App', sessionId: null, created: false });
  });

  test('(−) a sub-orchestrator pane in the project session is never found as the main orchestrator (any window, claude or node, tagged for this project)', async () => {
    for (const over of [{ windowName: 'orchestrator' }, { windowName: 'main' }, { command: 'node' }, { command: 'claude', windowName: 'orchestrator', depth: '1' }]) {
      const w = await world();
      const sub = { id: '%6', session: 'My-App', window: 2, windowName: 'main', command: 'claude', role: 'sub-orchestrator', agent: `${w.project.key}/planner`, depth: '2', parent: '%1', ...over };
      const exec = fakeTmux({ panes: [sub] });
      const r = await startOrchestrator(w.project.key, w.ctx(exec));
      assert.deepEqual([r.body.created, r.body.pane !== '%6', exec.of('new-window').length], [true, true, 1], JSON.stringify(over));
    }
  });

  test('(−) a pane tagged orchestrator in another tmux session (even a longer name with the same prefix) is not this project\'s', async () => {
    const w = await world();
    const exec = fakeTmux({ panes: [adopted(w, { session: 'My-App-2' })] });
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.equal(r.body.created, true);
    assert.equal(exec.of('new-session').length, 1);
    assert.equal(exec.of('list-panes').length, 0, 'there is no session of that name to list');
  });
});

describe('launchArgv: the one place that builds the orchestrator\'s claude arguments', () => {
  const project = { key: '0123456789abcdef', name: 'My App' };
  const cfg = (over = {}) => ({ models: { orchestrator: 'claude-fable-5-1' }, permissionMode: 'default', remoteControl: { enabled: false, prefix: '' }, ...over });

  test('(+) a fresh session passes --session-id; model and name follow', () => {
    assert.deepEqual(launchArgv(cfg(), project, { sessionId: PICK }), ['--session-id', PICK, '--model', 'claude-fable-5-1', '-n', 'My-App']);
  });

  test('(+) a resume passes --resume <id> in the same place, with the same flags after it', () => {
    assert.deepEqual(launchArgv(cfg(), project, { sessionId: PICK, resume: true }), ['--resume', PICK, '--model', 'claude-fable-5-1', '-n', 'My-App']);
    const full = cfg({ models: { orchestrator: 'opus' }, permissionMode: 'plan', remoteControl: { enabled: true, prefix: '' } });
    assert.deepEqual(launchArgv(full, project, { sessionId: PICK, resume: true }), ['--resume', PICK, '--model', 'opus', '--permission-mode', 'plan', '-n', 'My-App', '--remote-control=my-app']);
    assert.deepEqual(launchArgv(full, project, { sessionId: PICK }).slice(2), launchArgv(full, project, { sessionId: PICK, resume: true }).slice(2));
  });

  test('(+) the project\'s orchestrator model replaces the default, fresh and resumed; the other roles do not reach the argv', () => {
    const over = cfg({ perProject: { [project.key]: { models: { orchestrator: 'claude-opus-5-5', builder: 'haiku' } } } });
    assert.deepEqual(launchArgv(over, project, { sessionId: PICK }), ['--session-id', PICK, '--model', 'claude-opus-5-5', '-n', 'My-App']);
    assert.deepEqual(launchArgv(over, project, { sessionId: PICK, resume: true }), ['--resume', PICK, '--model', 'claude-opus-5-5', '-n', 'My-App']);
  });

  test('(+) without an override of its own the default is used, whatever other projects or other roles override', () => {
    const others = cfg({ perProject: { [project.key]: { models: { builder: 'haiku' } }, fedcba9876543210: { models: { orchestrator: 'opus' } } } });
    for (const resume of [false, true]) assert.equal(launchArgv(others, project, { sessionId: PICK, resume })[3], 'claude-fable-5-1');
  });

  test('(−) an id that is not a UUID is refused before it can become an argument (a flag-looking value, a path, an upper-case UUID, a non-string)', () => {
    for (const sessionId of ['--model', '-p', '../x', 'x', '', PICK.toUpperCase().replace(/1/g, 'A'), `${PICK} `, undefined, null, 5]) {
      for (const resume of [false, true]) assert.throws(() => launchArgv(cfg(), project, { sessionId, resume }), { code: 'EINVAL' }, `${JSON.stringify(sessionId)} ${resume}`);
    }
  });

  test('(−) bypassPermissions never reaches the arguments, fresh or resumed', () => {
    for (const resume of [false, true]) assert.throws(() => launchArgv(cfg({ permissionMode: 'bypassPermissions' }), project, { sessionId: PICK, resume }), { code: 'EINVAL' });
  });
});

describe('startOrchestrator: the saved orchestrator (the project\'s pick)', () => {
  const pickNow = (w) => getOrchestrator(w.project.key, w.env);

  test('(+) a fresh start passes --session-id <uuid> and saves that id as the pick', async () => {
    const w = await world();
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup(null, w.project.key) }));
    assert.equal(r.status, 200);
    assert.match(r.body.sessionId, UUID);
    assert.deepEqual(claudeFlags(exec.of('new-session')[0]).slice(0, 2), ['--session-id', r.body.sessionId]);
    assert.equal(await pickNow(w), r.body.sessionId);
    assert.equal('cleared' in r.body, false);
  });

  test('(+) an ended pick is resumed: new-session runs claude --resume <id> with the same fixed argv as a start, tagged and recorded (argv snapshot)', async () => {
    const w = await world({ models: { orchestrator: 'opus' }, permissionMode: 'plan' });
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux();
    const ctx = w.ctx(exec, { findSession: sessionLookup({}, w.project.key) });
    const r = await startOrchestrator(w.project.key, ctx);
    assert.deepEqual(r, { status: 200, body: { pane: '%20', session: 'My-App', sessionId: PICK, created: true } });
    assert.deepEqual(exec.calls, [
      [TMUX, '-u', 'has-session', '-t', '=My-App'],
      [TMUX, '-u', 'new-session', '-d', '-s', 'My-App', '-n', 'orchestrator', '-c', w.project.dir, '-x', '200', '-y', '50',
        '-P', '-F', '#{pane_id}', '--', CLAUDE, '--resume', PICK, '--model', 'opus', '--permission-mode', 'plan', '-n', 'My-App'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'orchestrator'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-agent', `${w.project.key}/orchestrator`],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-depth', '1'],
    ]);
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'orchestrator', sessionId: PICK, role: 'orchestrator', mode: 'plan' });
    assert.equal(await pickNow(w), PICK, 'the pick is the same session after the resume');
  });

  test('(+) resuming a stored pick uses the project\'s own orchestrator model in the argv (not the Settings one); another role\'s override does not reach it', async () => {
    const w = await world({ models: { orchestrator: 'sonnet' } });
    await setOrchestrator(w.project.key, PICK, w.env);
    await updateProjectConfig(w.project.key, { models: { orchestrator: 'claude-opus-5-5', reasoner: null, builder: 'haiku', scout: null } }, w.env);
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup({}, w.project.key) }));
    assert.equal(r.body.sessionId, PICK);
    assert.deepEqual(claudeFlags(exec.of('new-session')[0]), ['--resume', PICK, '--model', 'claude-opus-5-5', '-n', 'My-App']);
  });

  test('(+) an ended pick in a tmux session without an orchestrator window: new-window, the same resume arguments', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux({ panes: [{ id: '%1', session: 'My-App', window: 0, windowName: 'zsh', command: 'zsh' }] });
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup({}, w.project.key) }));
    assert.deepEqual([r.body.pane, r.body.sessionId, r.body.created], ['%20', PICK, true]);
    const argv = exec.of('new-window')[0];
    assert.deepEqual(argv.slice(argv.indexOf('--')), ['--', CLAUDE, '--resume', PICK, '--model', 'claude-fable-5-1', '-n', 'My-App']);
  });

  test('(+) a live pick answers its own pane, even in another tmux session: no tmux command, no new session, the pick stays', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux();
    const ctx = w.ctx(exec, { findSession: sessionLookup({ live: true, pane: PICK_PANE }, w.project.key) });
    const r = await startOrchestrator(w.project.key, ctx);
    assert.deepEqual(r, { status: 200, body: { pane: '%8', session: 'other-session', sessionId: PICK, created: false } });
    assert.deepEqual(exec.calls, []);
    assert.equal(ctx.started.size, 0);
    assert.equal(await pickNow(w), PICK);
  });

  test('(+) a pick whose transcript is gone is forgotten, a new orchestrator is started and saved, and the answer says cleared: gone', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup(null, w.project.key) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.cleared, 'gone');
    assert.equal(r.body.created, true);
    assert.notEqual(r.body.sessionId, PICK);
    assert.deepEqual(claudeFlags(exec.of('new-session')[0]).slice(0, 2), ['--session-id', r.body.sessionId]);
    assert.equal(await pickNow(w), r.body.sessionId, 'the new session replaced the gone pick');
  });

  test('(−) a pick that is a session of another project (a hand-edited config.json) is never resumed or opened: treated like a gone one, forgotten, and a fresh orchestrator starts', async () => {
    for (const lookup of [{ live: false }, { live: true, pane: PICK_PANE }]) {
      const w = await world();
      await setOrchestrator(w.project.key, PICK, w.env);
      const exec = fakeTmux();
      const foreign = sessionLookup(lookup, 'ffffffffffffffff', { root: '/work/other-project' });
      const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: foreign }));
      assert.equal(r.status, 200);
      assert.equal(r.body.cleared, 'gone');
      assert.notEqual(r.body.sessionId, PICK);
      const argv = claudeFlags(exec.of('new-session')[0]);
      assert.deepEqual(argv.slice(0, 2), ['--session-id', r.body.sessionId]);
      assert.ok(!argv.includes('--resume') && !argv.includes(PICK), 'the other project\'s id is nowhere in the argv');
      assert.equal(await pickNow(w), r.body.sessionId);
    }
  });

  test('(+) a pick whose group matches the project by its folder (not its key) still resumes', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup({}, 'ffffffffffffffff', { root: w.project.dir }) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.cleared, undefined);
    assert.deepEqual(claudeFlags(exec.of('new-session')[0]).slice(0, 2), ['--resume', PICK]);
  });

  test('(+) a gone pick beside an orchestrator pane that still runs: the pick is forgotten and that pane is answered', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux({ panes: [{ id: '%3', session: 'My-App', window: 1, windowName: 'orchestrator', command: 'claude', role: 'orchestrator' }] });
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup(null, w.project.key) }));
    assert.deepEqual(r.body, { pane: '%3', session: 'My-App', sessionId: null, created: false, cleared: 'gone' });
    assert.equal(await pickNow(w), null);
  });

  test('(+) an ended pick beside an orchestrator pane that runs: that pane is answered, nothing is resumed (never two orchestrators)', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux({ panes: [{ id: '%3', session: 'My-App', window: 1, windowName: 'orchestrator', command: 'claude', role: 'orchestrator' }] });
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup({}, w.project.key) }));
    assert.deepEqual([r.body.pane, r.body.created], ['%3', false]);
    assert.equal(exec.of('new-window').length + exec.of('new-session').length, 0);
    assert.equal(await pickNow(w), PICK);
  });

  test('(−) bypassPermissions in a tampered config.json never reaches the resume arguments', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const file = path.join(configDir(w.env), 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.permissionMode = 'bypassPermissions';
    fs.writeFileSync(file, JSON.stringify(cfg));
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup({}, w.project.key) }));
    assert.equal(r.status, 200);
    assert.ok(exec.of('new-session')[0].includes('--resume'));
    assert.ok(!JSON.stringify(exec.calls).includes('bypassPermissions'));
  });

  test('(−) a live pick that has no usable tmux pane (outside tmux, or a pane that no longer runs claude) is 409 no_pane: nothing is started or forgotten', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    for (const pane of [null, { id: '%8', session: 's', command: 'zsh' }, { id: 'nope', session: 's', command: 'claude' }]) {
      const exec = fakeTmux();
      const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: sessionLookup({ live: true, pane }, w.project.key) }));
      assert.deepEqual([r.status, r.body.error], [409, 'no_pane'], JSON.stringify(pane));
      assert.deepEqual(exec.calls, []);
    }
    assert.equal(await pickNow(w), PICK);
  });

  test('(−) a lookup that fails is not "gone": nothing is started, the pick stays, and the answer is 503', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { findSession: async () => { throw new Error('index unreadable'); } }));
    assert.deepEqual([r.status, r.body.error], [503, 'index_unavailable']);
    assert.deepEqual(exec.calls, []);
    assert.equal(await pickNow(w), PICK);
  });

  test('(−) a pick with no way to look it up fails closed: no tmux command, the pick stays', async () => {
    const w = await world();
    await setOrchestrator(w.project.key, PICK, w.env);
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec));
    assert.deepEqual([r.status, r.body.error], [500, 'internal']);
    assert.deepEqual(exec.calls, []);
    assert.equal(await pickNow(w), PICK);
  });

  test('(−) a refused start (tmux failing) saves no pick; a gone pick is still forgotten', async () => {
    const w = await world();
    const r = await startOrchestrator(w.project.key, w.ctx(fakeTmux({ failOn: ['new-session'] }), { findSession: sessionLookup(null, w.project.key) }));
    assert.equal(r.status, 502);
    assert.equal(await pickNow(w), null);
    await setOrchestrator(w.project.key, PICK, w.env);
    await startOrchestrator(w.project.key, w.ctx(fakeTmux({ failOn: ['new-session'] }), { findSession: sessionLookup(null, w.project.key) }));
    assert.equal(await pickNow(w), null, 'forgotten: its transcript is gone whatever happens next');
  });

  test('(−) a project removed while the start runs does not fail the pane that already runs', async () => {
    const w = await world();
    const exec = fakeTmux();
    const ctx = w.ctx(exec, { findSession: sessionLookup(null, w.project.key) });
    const origExec = ctx.exec;
    ctx.exec = async (cmd, args) => {
      const out = await origExec(cmd, args);
      if (args[1] === 'new-session') fs.writeFileSync(path.join(configDir(w.env), 'config.json'), JSON.stringify({ projects: [] }));
      return out;
    };
    const r = await startOrchestrator(w.project.key, ctx);
    assert.deepEqual([r.status, r.body.created], [200, true]);
    assert.equal((await loadConfig(w.env)).config.perProject[w.project.key], undefined);
  });
});

describe('startOrchestrator: refusals', () => {
  test('(−) malformed key → 400 and no tmux call; unregistered key → 404', async () => {
    const w = await world();
    const exec = fakeTmux();
    for (const bad of [undefined, null, 42, '', '../etc', 'ABCDEFGHIJKLMNOP', '0123456789abcde', '0123456789abcdef0']) {
      const r = await startOrchestrator(bad, w.ctx(exec));
      assert.equal(r.status, 400, String(bad));
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal((await startOrchestrator('0123456789abcdef', w.ctx(exec))).status, 404);
    assert.equal(exec.calls.length, 0);
  });

  test('(−) tmux missing → 503 tmux_unavailable (no binary, or the binary cannot be run)', async () => {
    const w = await world();
    let r = await startOrchestrator(w.project.key, w.ctx(fakeTmux(), { tmuxBin: null }));
    assert.deepEqual([r.status, r.body.error], [503, 'tmux_unavailable']);
    r = await startOrchestrator(w.project.key, w.ctx(fakeTmux({ enoent: true })));
    assert.deepEqual([r.status, r.body.error], [503, 'tmux_unavailable']);
  });

  test('(−) claude missing → 503 claude_unavailable before any tmux call', async () => {
    const w = await world();
    const exec = fakeTmux();
    const r = await startOrchestrator(w.project.key, w.ctx(exec, { claudeBin: null }));
    assert.deepEqual([r.status, r.body.error], [503, 'claude_unavailable']);
    assert.equal(exec.calls.length, 0);
  });
});

describe('session and Remote Control names', () => {
  test('(+) project name reduced to TMUX_SESSION; key as the fallback', () => {
    const key = '0123456789abcdef';
    assert.equal(sessionNameFor({ name: 'My App', key }), 'My-App');
    assert.equal(sessionNameFor({ name: 'a.b:c', key }), 'a-b-c');
    assert.equal(sessionNameFor({ name: '--x', key }), 'x');
    assert.equal(sessionNameFor({ name: 'y'.repeat(60), key }), 'y'.repeat(48));
    assert.equal(sessionNameFor({ name: '_ok-1', key }), '_ok-1');
  });

  test('(+) a long session name is a full RC_NAME for the orchestrator (≤ 64), not cut to the 20-char prefix length', async () => {
    const w = await world({ remoteControl: { enabled: true, prefix: '' } });
    const long = path.join(w.root, 'Long_Project Name.Of 25 chars');
    fs.mkdirSync(long);
    const p = await addProject(long, w.env);
    const exec = fakeTmux();
    await startOrchestrator(p.key, w.ctx(exec));
    const flags = claudeFlags(exec.of('new-session')[0]);
    assert.deepEqual(flags.slice(-3), ['-n', 'Long_Project-Name-Of-25-chars', '--remote-control=long-project-name-of-25-chars']);
    assert.match(flags.at(-1).slice('--remote-control='.length), /^[a-z0-9][a-z0-9-]{0,63}$/);
  });

  test('(−) nothing usable left → the key (no leading dash, no empty name)', () => {
    const key = '0123456789abcdef';
    for (const name of ['', '---', '日本語', ' ']) assert.equal(sessionNameFor({ name, key }), key, JSON.stringify(name));
  });

  test('(+) RC names are lowercase, start alphanumeric, ≤ 20 chars; fallback when nothing is left', () => {
    assert.equal(reduceRc('My-App', 'fb'), 'my-app');
    assert.equal(reduceRc('Proj.X-build 1', 'fb'), 'proj-x-build-1');
    assert.equal(reduceRc('a'.repeat(30), 'fb'), 'a'.repeat(20));
    assert.equal(reduceRc('abcdefghi-abcdefghij-', 'fb'), 'abcdefghi-abcdefghij');
    assert.equal(reduceRc('--x', 'fb'), 'x');
    assert.equal(reduceRc('---', 'fb'), 'fb');
    assert.equal(reduceRc('日本語', 'fb'), 'fb');
    // full = RC_NAME: up to 64 chars
    assert.equal(reduceRc('a'.repeat(30), 'fb', true), 'a'.repeat(30));
    assert.equal(reduceRc('My_Long.Name-x', 'fb', true), 'my-long-name-x');
    assert.equal(reduceRc('b'.repeat(80), 'fb', true), 'b'.repeat(64));
    assert.equal(reduceRc(`${'c'.repeat(63)}--d`, 'fb', true), 'c'.repeat(63));
    assert.equal(reduceRc('---', 'fb', true), 'fb');
  });
});

describe('inProject (a session\'s group is the project\'s)', () => {
  const project = { key: '0123456789abcdef', dir: '/work/demo-api' };
  test('(+) the registered key matches, and so does the folder', () => {
    assert.equal(inProject({ key: project.key, root: null }, project), true);
    assert.equal(inProject({ key: 'ffffffffffffffff', root: '/work/demo-api' }, project), true);
  });

  test('(−) another key and folder, no group, and a group with no root against a project whose dir is empty never match', () => {
    assert.equal(inProject({ key: 'ffffffffffffffff', root: '/work/other' }, project), false);
    assert.equal(inProject(null, project), false);
    assert.equal(inProject(undefined, project), false);
    assert.equal(inProject({ key: 'ffffffffffffffff' }, project), false);
    assert.equal(inProject({ key: 'ffffffffffffffff', root: null }, { key: 'aaaaaaaaaaaaaaaa', dir: null }), false);
  });
});

describe('pickState and claudePane (one reading of a saved orchestrator for the page and for Start)', () => {
  const project = { key: '0123456789abcdef', dir: '/work/demo-api' };
  const mine = { key: project.key, root: project.dir };
  const other = { key: 'ffffffffffffffff', root: '/work/other-project' };
  const pane = { id: '%6', session: 'work', command: 'claude' };
  const live = { id: PICK, name: 'planner', live: true, pane };
  const ended = { id: PICK, name: 'old-planner', live: false, pane: null };

  test('(+) a live session of the project is live with its name and pane id; an ended one is ended with no pane', () => {
    assert.deepEqual(pickState(project, PICK, { agent: live, group: mine }), { sessionId: PICK, state: 'live', name: 'planner', pane: '%6' });
    assert.deepEqual(pickState(project, PICK, { agent: ended, group: mine }), { sessionId: PICK, state: 'ended', name: 'old-planner', pane: null });
    assert.deepEqual(pickState(project, PICK, { agent: { ...ended, name: undefined }, group: mine }), { sessionId: PICK, state: 'ended', name: null, pane: null });
  });

  test('(+) a lookup with no hit is gone, with no name and no pane', () => {
    assert.deepEqual(pickState(project, PICK, null), { sessionId: PICK, state: 'gone', name: null, pane: null });
    assert.deepEqual(pickState(project, PICK, undefined), { sessionId: PICK, state: 'gone', name: null, pane: null });
  });

  test('(−) a session of another project, live or ended, reads as gone: no name and no pane of someone else\'s session (T47)', () => {
    for (const agent of [live, ended]) {
      assert.deepEqual(pickState(project, PICK, { agent, group: other }), { sessionId: PICK, state: 'gone', name: null, pane: null });
    }
    assert.equal(pickState(project, PICK, { agent: live, group: undefined }).state, 'gone', 'a hit with no group proves nothing');
  });

  test('(+) claudePane gives the pane of a live session that exists and runs claude (claude, node or a version string)', () => {
    assert.equal(claudePane(live), pane);
    assert.equal(claudePane({ live: true, pane: { id: '%2', command: ' node ' } }).id, '%2');
    assert.equal(claudePane({ live: true, pane: { id: '%2', command: '2.1.319' } }).id, '%2');
  });

  test('(−) no pane, a pane that is not claude, a bad pane id, or an ended session give null', () => {
    assert.equal(claudePane({ live: true, pane: null }), null);
    assert.equal(claudePane({ live: true, pane: { id: '%2', command: 'zsh' } }), null);
    assert.equal(claudePane({ live: true, pane: { id: '2;kill', command: 'claude' } }), null);
    assert.equal(claudePane({ live: false, pane }), null);
    assert.equal(claudePane(null), null);
  });
});
