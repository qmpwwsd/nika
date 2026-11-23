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
 * panes: [{ id, session, window, windowName, title, command, role, agent, depth, parent }] (role = @nika-role, agent = @nika-agent = `<project key>/<name>`, depth = @nika-depth, parent = @nika-parent, '' = untagged; dead = pane_dead, '0' running or '1' dead). Options: enoent (every call fails like a missing
 * binary), failOn (sub-commands that exit 1), commandOf (pane_current_command of a pane created by new-session /
 * new-window / split-window, by default `claude` for the first two and `node` for split-window).
 * Environment scope (tmux 3.2+, verified on 3.8): `new-session -e` sets the SESSION environment (exec.sessionEnv, which every later pane of the
 * session inherits) and the first pane's; `new-window -e` sets only that pane's; `set-environment -t =<session> -u NAME` removes a name from
 * the session environment, not from panes already running. A pane's own environment is `pane.env`.
 * Windows and sizes (0.5.4, P1; spike S-P1, tmux 3.8). Every pane has a window `win` (`@n`; by default one per (session, window index) pair, numbered
 * from @1) and a size `w` x `h` (by default an even horizontal share of the window). Window properties are given on a pane and apply to its whole
 * window, the first pane naming one wins: `winActive` (by default the session's lowest window), `zoomed` ('0'), `fit` (the `@nika-fit` text, ''),
 * `winW` / `winH` (200 / 50). `active: true` on a pane makes it the window's active pane (`pane_active`; by default the first pane of the window, and the pane a
 * `split-window` without `-d` creates; two panes marked `active` are both listed active, which tmux never does: the test of a hostile listing). `split-window -h|-v -t %n` halves the pane the way tmux does (new = floor((n-1)/2), old = n-1-new, the new pane to the
 * right or below) and ends a zoom; `new-window` makes a window `@n+1` of the size of the session's first window, active only without `-d`;
 * `select-layout -t @W tiled` lays the window's panes out in tmux's tiled grid (its own copy of the loop: the test is not circular) and refuses any other
 * layout; `list-panes -t @W` lists one window. Any resize, swap or move throws, like every sub-command not listed. `failOn` takes a sub-command
 * (`'list-panes'`), a sub-command and one flag (`'list-panes -s'`) or a function `(sub, args) => boolean`. `exec.onCall(sub, fn)` runs `fn(args, n)`
 * after the n-th successful call of that sub-command has been answered, so a test can change the world between two calls; `exec.add(pane)` adds a
 * pane the same way the constructor does; `exec.windows` is the window table.
 */
export function fakeTmux({ panes = [], enoent = false, failOn = [], nextId = 20 } = {}) {
  const state = panes.map((p) => ({ window: 0, windowName: 'zsh', title: '', command: 'zsh', role: '', agent: '', depth: '', parent: '', dead: '0', ...p }));
  const calls = [];
  let counter = nextId;
  const hooks = new Map(); // sub-command -> [fn(args, n)]
  const answered = new Map(); // sub-command -> successful calls so far
  const wins = new Map(); // window id -> { id, session, index, name, active, zoomed, fit, w, h }
  let nextWin = 1 + Math.max(0, ...state.map((p) => Number(/^@(\d+)$/.exec(String(p.win ?? ''))?.[1] ?? 0)));
  const given = (win, key, value) => { // the first pane that names a window property sets it
    if (value === undefined || win.given.has(key)) return;
    win.given.add(key);
    win[key] = value;
  };
  // A pane joins its window (a new one when none is named or known); window properties named on the pane are applied
  const register = (p) => {
    if (!p.win) p.win = [...wins.values()].find((x) => x.session === p.session && x.index === p.window)?.id ?? `@${nextWin++}`;
    if (!wins.has(p.win)) wins.set(p.win, { id: p.win, session: p.session, index: p.window, name: p.windowName, active: null, zoomed: '0', fit: '', w: 200, h: 50, given: new Set() });
    const win = wins.get(p.win);
    given(win, 'active', p.winActive === undefined ? undefined : p.winActive === true || p.winActive === 1 || p.winActive === '1');
    given(win, 'zoomed', p.zoomed === undefined ? undefined : String(p.zoomed));
    given(win, 'fit', p.fit);
    given(win, 'w', p.winW);
    given(win, 'h', p.winH);
    return win;
  };
  // the session's lowest window is the current one unless a window says so
  const settle = () => {
    for (const session of new Set(state.map((p) => p.session))) {
      const own = [...wins.values()].filter((w) => w.session === session);
      if (own.some((w) => w.active === true)) own.forEach((w) => { w.active = w.active === true; });
      else own.sort((a, b) => a.index - b.index).forEach((w, i) => { w.active = i === 0; });
    }
  };
  state.forEach(register);
  settle();
  for (const win of wins.values()) {
    const own = state.filter((p) => p.win === win.id);
    own.forEach((p) => {
      p.w ??= Math.floor((win.w - (own.length - 1)) / own.length);
      p.h ??= win.h;
    });
  }
  const sessions = () => new Set(state.map((p) => p.session));
  const noServer = () => tmuxError('no server running on /tmp/tmux-1/default');
  const sessionEnv = new Map(); // session name → { NAME: value }
  // the `-e NAME=value` pairs before `--`, nothing else is accepted
  const envPairs = (args) => {
    const out = {};
    const end = args.includes('--') ? args.indexOf('--') : args.length;
    for (let i = 0; i < end; i++) {
      if (args[i] !== '-e') continue;
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/s.exec(args[i + 1] ?? '');
      if (!m) throw new Error(`unexpected -e ${args[i + 1]}`);
      out[m[1]] = m[2];
    }
    return out;
  };
  // a new pane in a window: it fills the window (a split makes room for it afterwards)
  const create = (win, command, own = {}) => {
    const pane = { id: `%${counter++}`, session: win.session, window: win.index, windowName: win.name, win: win.id, title: '', command, role: '', agent: '', depth: '', parent: '', dead: '0', w: win.w, h: win.h, env: { ...sessionEnv.get(win.session), ...own } };
    state.push(pane);
    return pane;
  };
  const newWindow = (session, name, w, h, active) => {
    const index = 1 + Math.max(-1, ...[...wins.values()].filter((x) => x.session === session).map((x) => x.index));
    const win = { id: `@${nextWin++}`, session, index, name, active, zoomed: '0', fit: '', w, h, given: new Set() };
    wins.set(win.id, win);
    return win;
  };
  const after = (args, flag) => args[args.indexOf(flag) + 1];
  // a pane that a test pushed onto exec.panes by hand joins a window when it is first listed
  const winOf = (p) => (p.win && wins.has(p.win) ? wins.get(p.win) : (() => { const win = register(p); settle(); p.w ??= win.w; p.h ??= win.h; return win; })());
  const sized = (p, key) => { winOf(p); return String(p[key]); };
  // the window's active pane: the one a split made, else the panes a test marked `active`, else the first pane
  const isActive = (p) => {
    const win = winOf(p);
    const own = state.filter((x) => x.win === win.id);
    const chosen = own.find((x) => x.id === win.activePane);
    if (chosen) return chosen === p;
    const marked = own.filter((x) => x.active === true || x.active === 1 || x.active === '1');
    return marked.length ? marked.includes(p) : own[0] === p;
  };
  // the format variables nika uses; like tmux, an unset @option expands to an empty string
  const fields = {
    pane_id: 'id', session_name: 'session', window_index: 'window', window_name: 'windowName', pane_title: 'title', pane_current_command: 'command', '@nika-role': 'role', '@nika-agent': 'agent', '@nika-depth': 'depth', '@nika-parent': 'parent', pane_dead: 'dead', '@nika-kind': 'kind',
    pane_active: (p) => (isActive(p) ? '1' : '0'),
    window_id: (p) => winOf(p).id, window_active: (p) => (winOf(p).active ? '1' : '0'), window_panes: (p) => String(state.filter((x) => x.win === winOf(p).id).length),
    window_zoomed_flag: (p) => winOf(p).zoomed, window_width: (p) => String(winOf(p).w), window_height: (p) => String(winOf(p).h),
    pane_width: (p) => sized(p, 'w'), pane_height: (p) => sized(p, 'h'), '@nika-fit': (p) => winOf(p).fit,
  };
  const expand = (format, p) => format.replace(/#\{([^}]+)\}/g, (m, k) => {
    if (!Object.hasOwn(fields, k)) throw new Error(`unexpected format variable ${k}`);
    return String(typeof fields[k] === 'function' ? fields[k](p) : (p[fields[k]] ?? ''));
  });
  // tmux's tiled layout (layout_set_tiled), written out again here on purpose: place.js has its own copy, and the two must agree on the spike's numbers
  const tile = (win) => {
    const own = state.filter((p) => p.win === win.id);
    let rows = 1;
    let cols = 1;
    while (rows * cols < own.length) {
      rows += 1;
      if (rows * cols < own.length) cols += 1;
    }
    const cw = Math.floor((win.w - (cols - 1)) / cols);
    const ch = Math.floor((win.h - (rows - 1)) / rows);
    own.forEach((p, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, own.length - row * cols);
      const last = i % cols === inRow - 1; // the last pane of a row, and the last row, take what is left
      p.w = last ? win.w - (inRow - 1) * (cw + 1) : cw;
      p.h = row === rows - 1 ? win.h - (rows - 1) * (ch + 1) : ch;
    });
  };
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (enoent) throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
    const [u, sub, ...rest] = args;
    if (u !== '-u') throw new Error(`tmux must be called with -u first: ${args.join(' ')}`);
    if (failOn.some((f) => (typeof f === 'function' ? f(sub, rest) : f === sub || (f.startsWith(`${sub} `) && rest.includes(f.slice(sub.length + 1)))))) throw tmuxError(`${sub} failed`);
    const result = answer(sub, rest);
    answered.set(sub, (answered.get(sub) ?? 0) + 1);
    for (const fn of hooks.get(sub) ?? []) fn(rest, answered.get(sub));
    return result;
  };
  const answer = (sub, rest) => {
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
        // `-t @W`: the panes of one window
        const target = after(rest, '-t');
        if (/^@\d{1,6}$/.test(target ?? '') && rest.length === 4) {
          if (!wins.has(target)) throw tmuxError(`can't find window: ${target}`);
          return { stdout: `${state.filter((p) => p.win === target).map((p) => expand(after(rest, '-F'), p)).join('\n')}\n`, stderr: '' };
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
        const pairs = envPairs(rest);
        sessionEnv.set(session, pairs); // session-scoped: later panes of this session inherit it
        const size = (flag) => (rest.includes(flag) ? Number(after(rest, flag)) : undefined);
        const win = newWindow(session, after(rest, '-n'), size('-x') ?? 200, size('-y') ?? 50, true);
        return { stdout: `${create(win, 'claude').id}\n`, stderr: '' };
      }
      case 'set-environment': { // only `-t =<session> -u <NAME>` (nika's cleanup of the compaction pair)
        const [t, target, flag, name] = rest;
        if (t !== '-t' || flag !== '-u' || rest.length !== 4 || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`unexpected set-environment ${rest.join(' ')}`);
        if (!target.startsWith('=') || !sessions().has(target.slice(1))) throw tmuxError(`can't find session: ${target}`);
        delete sessionEnv.get(target.slice(1))?.[name];
        return { stdout: '', stderr: '' };
      }
      case 'new-window': {
        const target = after(rest, '-t');
        if (!/^=[^:]+:$/.test(target) || !sessions().has(target.slice(1, -1))) throw tmuxError(`can't find session: ${target}`);
        const session = target.slice(1, -1);
        // the size of the session's first window (spike S-P1c: no client attached); `-d` keeps the current window, without it the new one becomes current
        const first = [...wins.values()].filter((x) => x.session === session).sort((a, b) => a.index - b.index)[0];
        const win = newWindow(session, after(rest, '-n'), first?.w ?? 200, first?.h ?? 50, rest.includes('-d') ? false : true);
        if (win.active) [...wins.values()].filter((x) => x.session === session && x !== win).forEach((x) => { x.active = false; });
        return { stdout: `${create(win, 'claude', envPairs(rest)).id}\n`, stderr: '' }; // -e here is pane-only
      }
      case 'split-window': {
        const target = after(rest, '-t');
        // nika splits a pane it chose from its own listing (0.5.4): a session target (`=<session>:`) would split whatever pane is active there, so it throws
        if (!/^%\d{1,6}$/.test(target ?? '')) throw new Error(`split-window must target a pane id, got ${target}`);
        const host = state.find((p) => p.id === target);
        if (!host) throw tmuxError(`can't find pane: ${target}`);
        const win = winOf(host);
        const pane = create(win, 'node');
        // tmux's split: the new pane takes floor((n-1)/2) of the cells, the old one the rest, one cell is the border; a split ends a zoom
        const [along, across] = rest.includes('-h') ? ['w', 'h'] : ['h', 'w'];
        pane[along] = Math.floor((host[along] - 1) / 2);
        host[along] -= 1 + pane[along];
        pane[across] = host[across];
        win.zoomed = '0';
        if (!rest.includes('-d')) win.activePane = pane.id; // without -d the new pane becomes the window's active pane
        return { stdout: `${pane.id}\n`, stderr: '' };
      }
      case 'select-layout': { // only `-t @W tiled`
        const [t, target, layout] = rest;
        if (rest.length !== 3 || t !== '-t' || layout !== 'tiled') throw new Error(`unexpected select-layout ${rest.join(' ')}`);
        if (!wins.has(target)) throw tmuxError(`can't find window: ${target}`);
        tile(wins.get(target));
        return { stdout: '', stderr: '' };
      }
      case 'set-option': { // only `-p -t %n @nika-role <orchestrator|sub-orchestrator|agent>`, `@nika-agent <key>/<name>`, `@nika-depth <1|2|3>`, `@nika-parent <%n>` and `@nika-kind <one of the seven kinds>`, the pane options nika sets
        const [flag, t, pane, key, value] = rest;
        const target = state.find((p) => p.id === pane);
        const field = { '@nika-role': 'role', '@nika-agent': 'agent', '@nika-depth': 'depth', '@nika-parent': 'parent', '@nika-kind': 'kind' }[key];
        const valid = key === '@nika-role' ? ['orchestrator', 'sub-orchestrator', 'agent'].includes(value)
          : key === '@nika-depth' ? ['1', '2', '3'].includes(value)
            : key === '@nika-parent' ? /^%\d{1,6}$/.test(value)
              : key === '@nika-kind' ? ['coder', 'reviewer', 'tester', 'designer', 'scout', 'writer', 'agent'].includes(value)
                : key === '@nika-agent' && /^[a-z0-9]{16}\/[a-z0-9][a-z0-9-]{0,39}$/.test(value);
        if (flag !== '-p' || t !== '-t' || !valid || rest.length !== 5) throw new Error(`unexpected set-option ${rest.join(' ')}`);
        if (!target) throw tmuxError("can't find pane");
        target[field] = value;
        return { stdout: '', stderr: '' };
      }
      case 'display-message': { // only `-p -t %n #{pane_dead}`, nika's early-exit check: 0 = running, 1 = dead (remain-on-exit); a pane that exited is gone
        const [p, t, target, format] = rest;
        if (rest.length !== 4 || p !== '-p' || t !== '-t' || format !== '#{pane_dead}') throw new Error(`unexpected display-message ${rest.join(' ')}`);
        if (!state.length) throw noServer();
        const pane = state.find((x) => x.id === target);
        if (!pane) throw tmuxError(`can't find pane: ${target}`);
        return { stdout: `${pane.dead}\n`, stderr: '' };
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
  exec.windows = wins;
  exec.sessionEnv = sessionEnv;
  exec.onCall = (sub, fn) => { hooks.set(sub, [...(hooks.get(sub) ?? []), fn]); };
  exec.add = (pane) => {
    const p = { window: 0, windowName: 'zsh', title: '', command: 'zsh', role: '', agent: '', depth: '', parent: '', dead: '0', id: `%${counter++}`, ...pane };
    const win = register(p);
    p.w ??= win.w;
    p.h ??= win.h;
    state.push(p);
    settle();
    return p;
  };
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
  // `sleep` is the early-exit wait of a start or spawn (1 s in production): it returns at once here and records how long it was asked to wait
  const ctx = (exec, extra = {}) => {
    const slept = [];
    return { env, exec, tmuxBin: TMUX, claudeBin: CLAUDE, nikaArgv: NIKA_ARGV, claudeDir: path.join(root, 'claude'), now: Date.now, started: new Map(), sleep: async (ms) => { slept.push(ms); }, slept, ...extra };
  };
  return { root, env, project, ctx, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
