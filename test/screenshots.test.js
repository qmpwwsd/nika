// scripts/screenshots.mjs (dev script behind the README images): its safety checks, and that nika's own parsers read the
// invented Claude screens the way the shots assume (a changed footer or prompt layout would silently show "Mode ?").
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { defaultRoot, assertDemoRoot, assertInWorld, LIVE, COLS, ROWS, paneScreen } from '../scripts/screenshots.mjs';
import { parseCapture } from '../src/mirror.js';
import { modeFromRows, promptFromRows, rowText, bypassWindow } from '../src/mode.js';

const ROOT = path.join(path.sep, 'tmp', 'nika-demo');
const worldEnv = (root = ROOT) => ({
  HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'), NIKA_CONFIG_DIR: path.join(root, '.config'),
  XDG_STATE_HOME: path.join(root, '.local', 'state'), TMUX_TMPDIR: path.join(root, '.tmux'), NIKA_TMP_ROOT: path.join(root, '.tmp'),
});
const rowsOf = (agent, kind) => parseCapture(paneScreen(agent, kind).text, COLS);

describe('screenshots: the demo root', () => {
  test('(+) the default root is accepted, on macOS and elsewhere', () => {
    assert.equal(assertDemoRoot(defaultRoot('linux')), defaultRoot('linux'));
    assert.equal(assertDemoRoot(defaultRoot('darwin')), defaultRoot('darwin'));
    assert.notEqual(defaultRoot('darwin'), defaultRoot('linux'));
  });

  test('(−) anything that could name a real folder is refused', () => {
    for (const bad of ['', undefined, null, 'nika-demo', 'tmp/nika-demo', '/', '/tmp', '/nika-demo', '/tmp/other', '/tmp/nika-demo/', '/tmp/x/../nika-demo', '/tmp/nika-demo/..', '/tmp/not-nika-demo', '/tmp/nika-demo x']) {
      assert.throws(() => assertDemoRoot(bad), /refusing to use/, JSON.stringify(bad));
    }
  });
});

describe('screenshots: the world stays inside its root', () => {
  test('(+) an environment inside the root passes', () => {
    assert.doesNotThrow(() => assertInWorld(worldEnv(), ROOT));
  });

  test('(−) a folder outside the root, a look-alike prefix, a .. segment or a missing key is refused', () => {
    for (const key of Object.keys(worldEnv())) {
      for (const bad of [path.join(path.sep, 'home', 'someone', '.claude'), `${ROOT}-evil`, `${ROOT}/../elsewhere`, '', undefined, 42]) {
        assert.throws(() => assertInWorld({ ...worldEnv(), [key]: bad }, ROOT), new RegExp(`${key} must point into the demo world`), `${key}=${bad}`);
      }
      const { [key]: _gone, ...rest } = worldEnv();
      assert.throws(() => assertInWorld(rest, ROOT), new RegExp(key));
    }
  });
});

describe('screenshots: nika reads the invented panes', () => {
  test('(+) a normal screen is ROWS rows of at most COLS columns and reads as the agent\'s mode', () => {
    for (const a of LIVE) {
      const kind = a.screen === 'prompt' ? 'idle' : a.screen;
      const rows = rowsOf(a, kind);
      assert.equal(rows.length, ROWS, a.name);
      assert.ok(rows.every((r) => rowText(r).length <= COLS), `${a.name}: a row is wider than ${COLS}`);
      assert.equal(modeFromRows(rows), a.mode, `${a.name} (${kind})`);
      assert.equal(promptFromRows(rows), null, `${a.name} (${kind}) shows no prompt`);
    }
  });

  test('(+) the permission-prompt screen reads as a prompt with three options, no mode and no bypass mention', () => {
    const asking = LIVE.filter((a) => a.screen === 'prompt');
    assert.equal(asking.length, 1);
    const rows = rowsOf(asking[0], 'prompt');
    assert.equal(modeFromRows(rows), 'unknown');
    assert.deepEqual(promptFromRows(rows).options.map((o) => o.n), [1, 2, 3]);
    assert.equal(promptFromRows(rows).question, 'Do you want to proceed?');
    assert.equal(bypassWindow(rows), false);
  });

  test('(+) the agents that need you are exactly the ones whose registry state is waiting', () => {
    assert.deepEqual(LIVE.filter((a) => a.state === 'waiting').map((a) => a.screen).sort(), ['ask', 'prompt']);
    assert.equal(new Set(LIVE.map((a) => a.pane)).size, LIVE.length, 'pane ids are unique');
    assert.equal(new Set(LIVE.map((a) => a.sid)).size, LIVE.length, 'session ids are unique');
  });

  test('(−) a screen without its footer reads as an unknown mode (the check would catch a changed footer)', () => {
    const a = LIVE.find((x) => x.mode === 'plan');
    const broken = parseCapture(paneScreen(a, 'idle').text.replace('plan mode on', 'planning'), COLS);
    assert.equal(modeFromRows(broken), 'unknown');
  });
});
