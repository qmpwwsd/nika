// startOrchestrator and the shared tmux/rc helpers; in-memory tmux, temp dirs, synthetic data only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOrchestrator, sessionNameFor, reduceRc, tmuxLiteral } from '../src/orchestrate.js';
import { configDir } from '../src/paths.js';
import { addProject } from '../src/store.js';
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
    ]);
    assert.deepEqual(ctx.started.get('%20'), { key: w.project.key, name: 'orchestrator', sessionId: r.body.sessionId, role: 'orchestrator' });
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
      assert.deepEqual(exec.calls, [
        [TMUX, '-u', 'has-session', '-t', '=My-App'],
        [TMUX, '-u', 'list-panes', '-t', '=My-App:=orchestrator', '-F', '#{pane_id}\t#{pane_current_command}\t#{@nika-role}'],
      ]);
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
      [TMUX, '-u', 'list-panes', '-t', '=My-App:=orchestrator', '-F', '#{pane_id}\t#{pane_current_command}\t#{@nika-role}'],
      [TMUX, '-u', 'new-window', '-t', '=My-App:', '-n', 'orchestrator', '-c', w.project.dir, '-P', '-F', '#{pane_id}', '--', CLAUDE,
        '--session-id', r.body.sessionId, '--model', 'claude-fable-5-1', '-n', 'My-App'],
      [TMUX, '-u', 'set-option', '-p', '-t', '%20', '@nika-role', 'orchestrator'],
    ]);
    assert.equal(ctx.started.get('%20').sessionId, r.body.sessionId);
    assert.equal(exec.panes.find((p) => p.id === '%20').role, 'orchestrator');
  });

  test('(−) a window only prefixed `orchestrator` (e.g. orchestrator-x running claude) is never reused', async () => {
    const w = await world();
    const exec = sessionWith('claude', { windowName: 'orchestrator-x' });
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
    assert.deepEqual(exec.of('set-option'), [['set-option', '-p', '-t', '%20', '@nika-role', 'orchestrator']]);
  });

  test('(−) an untagged claude pane (not created by nika, or tagging failed) is not reused', async () => {
    const w = await world();
    for (const role of ['', 'agent', 'other']) {
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
