// Shared by spawn.test.js and orchestrate.test.js: an in-memory tmux that answers the argv shapes of contract §8 with
// exact-name sessions, plus a temp "world" (config dir, state dir, one registered project). Synthetic data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProject, updateSettings } from '../src/store.js';

export const TMUX = '/usr/bin/tmux';
export const CLAUDE = '/usr/bin/claude';
export const NIKA_ARGV = ['/usr/bin/node', '/opt/nika/bin/nika'];

const tmuxError = (message, code = 1) => Object.assign(new Error(message), { code, stderr: `${message}\n` });

/**
 * panes: [{ id, session, window, windowName, title, command, role }] (role = @nika-role, '' = untagged). Options: enoent (every call fails like a missing
 * binary), failOn (sub-commands that exit 1), commandOf (pane_current_command of a pane created by new-session /
 * new-window / split-window, by default `claude` for the first two and `node` for split-window).
 */
export function fakeTmux({ panes = [], enoent = false, failOn = [], nextId = 20 } = {}) {
  const state = panes.map((p) => ({ window: 0, windowName: 'zsh', title: '', command: 'zsh', ...p }));
  const calls = [];
  let counter = nextId;
  const sessions = () => new Set(state.map((p) => p.session));
  const noServer = () => tmuxError('no server running on /tmp/tmux-1/default');
  const create = (session, windowName, command) => {
    const pane = { id: `%${counter++}`, session, window: state.filter((p) => p.session === session).length, windowName, title: '', command, role: '' };
    state.push(pane);
    return `${pane.id}\n`;
  };
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (enoent) throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    const [u, sub, ...rest] = args;
    if (u !== '-u') throw new Error(`tmux must be called with -u first: ${args.join(' ')}`);
    if (failOn.includes(sub)) throw tmuxError(`${sub} failed`);
    switch (sub) {
      case 'list-panes': {
        if (!state.length) throw noServer();
        if (rest.includes('-a')) {
          return { stdout: `${state.map((p) => [p.id, p.session, p.window, p.title, p.command].join('\t')).join('\n')}\n`, stderr: '' };
        }
        // like tmux: `:=name` matches the window name exactly; `:name` tries exact, then prefix
        const m = /^=([^:]+):(=?)(.+)$/.exec(after(rest, '-t'));
        const inSession = state.filter((p) => p.session === m?.[1]);
        let hit = inSession.filter((p) => p.windowName === m?.[3]);
        if (!hit.length && m?.[2] !== '=') hit = inSession.filter((p) => p.windowName.startsWith(m?.[3] ?? '\0'));
        if (!hit.length) throw tmuxError(`can't find window: ${m?.[3]}`);
        return { stdout: `${hit.map((p) => `${p.id}\t${p.command}\t${p.role ?? ''}`).join('\n')}\n`, stderr: '' };
      }
      case 'has-session': {
        if (!state.length) throw noServer();
        if (!sessions().has(after(rest, '-t').replace(/^=/, '')) || !after(rest, '-t').startsWith('=')) throw tmuxError(`can't find session: ${after(rest, '-t')}`);
        return { stdout: '', stderr: '' };
      }
      case 'new-session': {
        const session = after(rest, '-s');
        if (sessions().has(session)) throw tmuxError(`duplicate session: ${session}`);
        return { stdout: create(session, after(rest, '-n'), 'claude'), stderr: '' };
      }
      case 'new-window': {
        const target = after(rest, '-t');
        if (!/^=[^:]+:$/.test(target) || !sessions().has(target.slice(1, -1))) throw tmuxError(`can't find session: ${target}`);
        return { stdout: create(target.slice(1, -1), after(rest, '-n'), 'claude'), stderr: '' };
      }
      case 'split-window': {
        const target = after(rest, '-t');
        const host = target.startsWith('%') ? state.find((p) => p.id === target) : state.find((p) => `=${p.session}:` === target);
        if (!host) throw tmuxError(`can't find pane: ${target}`);
        return { stdout: create(host.session, host.windowName, 'node'), stderr: '' };
      }
      case 'set-option': { // only `-p -t %n @nika-role <orchestrator|agent>`, the one pane option nika sets
        const [flag, t, pane, key, value] = rest;
        const target = state.find((p) => p.id === pane);
        if (flag !== '-p' || t !== '-t' || key !== '@nika-role' || !['orchestrator', 'agent'].includes(value) || rest.length !== 5) {
          throw new Error(`unexpected set-option ${rest.join(' ')}`);
        }
        if (!target) throw tmuxError("can't find pane");
        target.role = value;
        return { stdout: '', stderr: '' };
      }
      case 'select-pane': {
        const pane = state.find((p) => p.id === after(rest, '-t'));
        if (!pane) throw tmuxError("can't find pane");
        pane.title = after(rest, '-T');
        return { stdout: '', stderr: '' };
      }
      default:
        throw new Error(`unexpected tmux sub-command ${sub}`);
    }
  };
  exec.calls = calls;
  exec.panes = state;
  /** Calls of one sub-command, as the argv after `-u`. */
  exec.of = (sub) => calls.filter((c) => c[2] === sub).map((c) => c.slice(2));
  return exec;
}

/** Temp config + state dirs with one registered project named "My App" (tmux session "My-App"). Call cleanup() after. */
export async function makeWorld(settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-spawn-'));
  const env = { NIKA_CONFIG_DIR: path.join(root, 'cfg'), XDG_STATE_HOME: path.join(root, 'state') };
  fs.mkdirSync(env.NIKA_CONFIG_DIR, { recursive: true });
  const dir = path.join(root, 'My App');
  fs.mkdirSync(dir);
  const project = await addProject(dir, env);
  if (Object.keys(settings).length) await updateSettings(settings, env);
  const ctx = (exec, extra = {}) => ({ env, exec, tmuxBin: TMUX, claudeBin: CLAUDE, nikaArgv: NIKA_ARGV, claudeDir: path.join(root, 'claude'), now: Date.now, started: new Map(), ...extra });
  return { root, env, project, ctx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
