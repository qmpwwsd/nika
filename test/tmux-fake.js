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
 * panes: [{ id, session, window, windowName, title, command, role, agent, depth, parent }] (role = @nika-role, agent = @nika-agent = `<project key>/<name>`, depth = @nika-depth, parent = @nika-parent, '' = untagged). Options: enoent (every call fails like a missing
 * binary), failOn (sub-commands that exit 1), commandOf (pane_current_command of a pane created by new-session /
 * new-window / split-window, by default `claude` for the first two and `node` for split-window).
 */
export function fakeTmux({ panes = [], enoent = false, failOn = [], nextId = 20 } = {}) {
  const state = panes.map((p) => ({ window: 0, windowName: 'zsh', title: '', command: 'zsh', role: '', agent: '', depth: '', parent: '', ...p }));
  const calls = [];
  let counter = nextId;
  const sessions = () => new Set(state.map((p) => p.session));
  const noServer = () => tmuxError('no server running on /tmp/tmux-1/default');
  const create = (session, windowName, command) => {
    const pane = { id: `%${counter++}`, session, window: state.filter((p) => p.session === session).length, windowName, title: '', command, role: '', agent: '', depth: '', parent: '' };
    state.push(pane);
    return `${pane.id}\n`;
  };
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  // the format variables nika uses; like tmux, an unset @option expands to an empty string
  const fields = { pane_id: 'id', session_name: 'session', window_index: 'window', window_name: 'windowName', pane_title: 'title', pane_current_command: 'command', '@nika-role': 'role', '@nika-agent': 'agent', '@nika-depth': 'depth', '@nika-parent': 'parent' };
  const expand = (format, p) => format.replace(/#\{([^}]+)\}/g, (m, k) => {
    if (!Object.hasOwn(fields, k)) throw new Error(`unexpected format variable ${k}`);
    return String(p[fields[k]] ?? '');
  });
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
          return { stdout: `${state.map((p) => expand(after(rest, '-F'), p)).join('\n')}\n`, stderr: '' };
        }
        // `-s -t =<session>`: every pane of that session (exact name), whatever its window
        if (rest.includes('-s')) {
          const name = after(rest, '-t');
          if (!name.startsWith('=') || !sessions().has(name.slice(1))) throw tmuxError(`can't find session: ${name}`);
          return { stdout: `${state.filter((p) => p.session === name.slice(1)).map((p) => expand(after(rest, '-F'), p)).join('\n')}\n`, stderr: '' };
        }
        throw new Error(`unexpected list-panes ${rest.join(' ')}`);
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
      case 'set-option': { // only `-p -t %n @nika-role <orchestrator|sub-orchestrator|agent>`, `@nika-agent <key>/<name>`, `@nika-depth <1|2|3>` and `@nika-parent <%n>`, the pane options nika sets
        const [flag, t, pane, key, value] = rest;
        const target = state.find((p) => p.id === pane);
        const field = { '@nika-role': 'role', '@nika-agent': 'agent', '@nika-depth': 'depth', '@nika-parent': 'parent' }[key];
        const valid = key === '@nika-role' ? ['orchestrator', 'sub-orchestrator', 'agent'].includes(value)
          : key === '@nika-depth' ? ['1', '2', '3'].includes(value)
            : key === '@nika-parent' ? /^%\d{1,6}$/.test(value)
              : key === '@nika-agent' && /^[a-z0-9]{16}\/[a-z0-9][a-z0-9-]{0,39}$/.test(value);
        if (flag !== '-p' || t !== '-t' || !valid || rest.length !== 5) throw new Error(`unexpected set-option ${rest.join(' ')}`);
        if (!target) throw tmuxError("can't find pane");
        target[field] = value;
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
