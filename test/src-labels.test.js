// 0.5.4 SF (item 9b): the Fit mode (P2) ships in 0.5.4, so the comments in src/ say 0.5.4. The QP1 Review fix comments keep 0.5.3 (it shipped in 0.5.3).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
const lines = files(SRC).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((text, i) => ({ file: path.relative(SRC, f), line: i + 1, text })));

describe('0.5.4 SF (item 9b): release labels in src/ comments', () => {
  test('(\u2212) no src/ comment about P2 or the Fit mode says 0.5.3', () => {
    const stale = lines.filter((l) => /0\.5\.3/.test(l.text) && /\bP2\b|Fit mode|fit mode|fit\.setMode|setMode|fit:/.test(l.text) && !/QP1|Review/.test(l.text));
    assert.deepEqual(stale.map((l) => `${l.file}:${l.line}`), []);
  });

  test('(+) the six lines that carried the old label say 0.5.4 now (src/ids.js, store.js, appio.js, api-app.js x2, fit.js)', () => {
    const has = (file, needle) => lines.some((l) => l.file === file && l.text.includes(needle));
    assert.ok(has('ids.js', 'The Fit mode setting (0.5.4, P2)'));
    assert.ok(has('store.js', 'through setMode (0.5.4)'));
    assert.ok(has('appio.js', '// 0.5.4 (P2): the saved Fit mode, before the first request'));
    assert.ok(has('api-app.js', '// 0.5.4 (P2): the saved Fit mode reaches the controller at once'));
    assert.ok(has('api-app.js', '// 0.5.4 (P2): a page that opens, or asks to fit again'));
    assert.ok(has('fit.js', '// P2 (0.5.4, design-052d section 2.1)'));
  });
});
