// 0.5.4 SF (RV051 M7): createLimiter lives in src/limiter.js, a leaf module; the attachment store no longer imports it from the history collector.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const importsOf = (text) => [...text.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('0.5.4 SF (RV051 M7): src/limiter.js', () => {
  test('(+) createLimiter comes from src/limiter.js: at most max tasks at once, FIFO, and a task that throws frees its slot', async () => {
    const { createLimiter } = await import('../src/limiter.js');
    const limited = createLimiter(2);
    let active = 0;
    let peak = 0;
    const order = [];
    const task = (id) => limited(async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(id);
      await sleep(5);
      active -= 1;
      return id;
    });
    assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(task)), [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
    const one = createLimiter(1);
    await assert.rejects(one(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await one(async () => 'after'), 'after', 'the slot was released');
  });

  test('(+) the history collector uses it from src/limiter.js and neither defines nor exports a limiter of its own', () => {
    const history = read('collect/history.js');
    assert.ok(importsOf(history).includes('../limiter.js'));
    assert.doesNotMatch(history, /function createLimiter\b/);
    assert.doesNotMatch(history, /export\s*\{[^}]*createLimiter/);
  });

  test('(\u2212) the attachment store takes it from src/limiter.js and imports nothing from src/collect/ (a store does not depend on a collector)', () => {
    const imports = importsOf(read('attachments.js'));
    assert.ok(imports.includes('./limiter.js'));
    assert.deepEqual(imports.filter((i) => /collect\//.test(i)), []);
  });

  test('(\u2212) src/limiter.js is a leaf: it imports nothing, and the file is ASCII', () => {
    const text = read('limiter.js');
    assert.deepEqual(importsOf(text), []);
    assert.doesNotMatch(text, /^\s*import\b/m);
    assert.equal([...text].every((ch) => ch.codePointAt(0) < 128), true);
  });
});
