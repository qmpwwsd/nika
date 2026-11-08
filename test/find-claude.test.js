// findClaude: absolute executable path or null; temp dirs only. The machine's own claude install is kept out of
// the way by passing explicit fallback dirs (default dirs are /opt/homebrew/bin and /usr/local/bin).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaude, defaultConfig } from '../src/config.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-claude-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh dir below root; `claude` in it is executable unless mode says otherwise. */
function dirWith(mode = 0o755) {
  const d = path.join(root, `d${n++}`);
  fs.mkdirSync(d);
  if (mode !== null) fs.writeFileSync(path.join(d, 'claude'), '#!/bin/sh\n', { mode });
  return d;
}
const home = () => {
  const h = path.join(root, `home${n++}`);
  fs.mkdirSync(h);
  return h;
};
const NONE = [];

describe('findClaude', () => {
  test('(+) the first claude on PATH wins, as an absolute path', () => {
    const a = dirWith();
    const b = dirWith();
    assert.equal(findClaude({ PATH: `${a}:${b}`, HOME: home() }, NONE), path.join(a, 'claude'));
  });

  test('(+) a symlink to an executable is accepted and returned as found (not resolved)', () => {
    const target = dirWith();
    const d = dirWith(null);
    fs.symlinkSync(path.join(target, 'claude'), path.join(d, 'claude'));
    assert.equal(findClaude({ PATH: d, HOME: home() }, NONE), path.join(d, 'claude'));
  });

  test('(+) a bare PATH (launchd) still finds ~/.local/bin, then ~/.claude/local, then the fallback dirs', () => {
    const h = home();
    const fallback = dirWith();
    assert.equal(findClaude({ PATH: '/nonexistent', HOME: h }, [fallback]), path.join(fallback, 'claude'));
    fs.mkdirSync(path.join(h, '.claude', 'local'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude', 'local', 'claude'), '', { mode: 0o755 });
    assert.equal(findClaude({ PATH: '', HOME: h }, [fallback]), path.join(h, '.claude', 'local', 'claude'));
    fs.mkdirSync(path.join(h, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(h, '.local', 'bin', 'claude'), '', { mode: 0o755 });
    assert.equal(findClaude({ PATH: '', HOME: h }, [fallback]), path.join(h, '.local', 'bin', 'claude'));
    const onPath = dirWith();
    assert.equal(findClaude({ PATH: onPath, HOME: h }, [fallback]), path.join(onPath, 'claude'));
  });

  test('(+) NIKA_CLAUDE overrides the search', () => {
    const a = dirWith();
    const b = dirWith();
    assert.equal(findClaude({ NIKA_CLAUDE: path.join(b, 'claude'), PATH: a, HOME: home() }, NONE), path.join(b, 'claude'));
  });

  test('(+) defaultConfig keeps the env for the project registry', () => {
    const env = { NIKA_PORT: '3335' };
    assert.equal(defaultConfig(env).env, env);
  });

  test('(−) nothing found → null, never a bare name', () => {
    assert.equal(findClaude({ PATH: '/nonexistent', HOME: home() }, NONE), null);
  });

  test('(−) a non-executable file or a directory called claude is skipped', () => {
    const plain = dirWith(0o644);
    const dir = dirWith(null);
    fs.mkdirSync(path.join(dir, 'claude'));
    const good = dirWith();
    assert.equal(findClaude({ PATH: `${plain}:${dir}`, HOME: home() }, NONE), null);
    assert.equal(findClaude({ PATH: `${plain}:${dir}:${good}`, HOME: home() }, NONE), path.join(good, 'claude'));
  });

  test('(−) relative or empty PATH entries are never searched (they would resolve against the cwd)', () => {
    const d = dirWith();
    const before = process.cwd();
    process.chdir(d);
    try {
      assert.equal(findClaude({ PATH: `.::bin:${path.basename(d)}`, HOME: home() }, NONE), null);
    } finally {
      process.chdir(before);
    }
  });

  test('(−) a relative HOME is ignored; NIKA_CLAUDE must be absolute and executable, else null (no silent fallback)', () => {
    const d = dirWith();
    const plain = dirWith(0o644);
    assert.equal(findClaude({ NIKA_CLAUDE: 'claude', PATH: d, HOME: home() }, NONE), null);
    assert.equal(findClaude({ NIKA_CLAUDE: path.join(plain, 'claude'), PATH: d, HOME: home() }, NONE), null);
    assert.equal(findClaude({ NIKA_CLAUDE: path.join(root, 'missing', 'claude'), PATH: d, HOME: home() }, NONE), null);
    // a relative HOME is not used (it would resolve against the cwd): os.homedir() is, and that is HOME of the process
    const h = home();
    fs.mkdirSync(path.join(h, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(h, '.local', 'bin', 'claude'), '', { mode: 0o755 });
    const saved = process.env.HOME;
    process.env.HOME = h;
    try {
      assert.equal(findClaude({ PATH: '', HOME: 'rel/home' }, NONE), path.join(h, '.local', 'bin', 'claude'));
      assert.equal(findClaude({ PATH: '' }, NONE), path.join(h, '.local', 'bin', 'claude'));
    } finally {
      process.env.HOME = saved;
    }
  });
});
