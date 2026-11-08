// Unified diff (stdlib Myers). Round trips go through a tiny patch applier written here; synthetic text only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../src/diff.js';

/** Applies a diff made by unifiedDiff to `oldText`; throws when a context or delete line does not match. */
function applyDiff(oldText, diff) {
  if (diff === '') return oldText;
  const oldEol = oldText === '' || oldText.endsWith('\n');
  const old = oldText === '' ? [] : oldText.split('\n');
  if (oldEol && old.length) old.pop();
  const out = [];
  let pos = 0;
  let lastNewNoEol = false; // the last line taken from the diff's new side carried the "No newline" marker
  const lines = diff.split('\n');
  assert.equal(lines.pop(), '', 'diff ends with a newline');
  assert.match(lines[0], /^--- a\//);
  assert.match(lines[1], /^\+\+\+ b\//);
  for (let i = 2; i < lines.length; i++) {
    const l = lines[i];
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(l);
    if (h) {
      const start = h[2] === '0' ? Number(h[1]) : Number(h[1]) - 1;
      while (pos < start) out.push(old[pos++]);
    } else if (l.startsWith('\\ No newline')) {
      lastNewNoEol = lines[i - 1][0] !== '-';
    } else if (l[0] === '+') {
      out.push(l.slice(1));
      lastNewNoEol = false;
    } else {
      assert.equal(old[pos], l.slice(1), `line ${pos + 1} matches`);
      pos++;
      if (l[0] === ' ') {
        out.push(l.slice(1));
        lastNewNoEol = false;
      }
    }
  }
  const rest = pos < old.length;
  while (pos < old.length) out.push(old[pos++]);
  if (out.length === 0) return '';
  return out.join('\n') + ((rest ? oldEol : !lastNewNoEol) ? '\n' : '');
}

const nums = (n, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`);
const text = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

describe('unifiedDiff', () => {
  test('(+) a create is a single hunk from an empty old side', () => {
    assert.equal(unifiedDiff('', 'a\nb\n', 'rules/x.md'), '--- a/rules/x.md\n+++ b/rules/x.md\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    assert.equal(unifiedDiff('', 'one\n', 'x'), '--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+one\n');
  });

  test('(+) a delete mirrors a create', () => {
    assert.equal(unifiedDiff('a\nb\n', '', 'x'), '--- a/x\n+++ b/x\n@@ -1,2 +0,0 @@\n-a\n-b\n');
  });

  test('(+) a change shows 3 lines of context on each side and the header numbers', () => {
    const old = text(nums(12));
    const next = old.replace('line 6\n', 'changed\n');
    assert.equal(unifiedDiff(old, next, 'f'), [
      '--- a/f', '+++ b/f', '@@ -3,7 +3,7 @@', ' line 3', ' line 4', ' line 5', '-line 6', '+changed', ' line 7', ' line 8', ' line 9', '',
    ].join('\n'));
  });

  test('(+) changes far apart make two hunks, close ones merge into one', () => {
    const old = text(nums(30));
    const far = unifiedDiff(old, old.replace('line 3\n', 'X\n').replace('line 25\n', 'Y\n'), 'f');
    assert.equal(far.split('\n').filter((l) => l.startsWith('@@')).length, 2);
    const near = unifiedDiff(old, old.replace('line 10\n', 'X\n').replace('line 17\n', 'Y\n'), 'f'); // 6 lines between
    assert.equal(near.split('\n').filter((l) => l.startsWith('@@')).length, 1);
    const apart = unifiedDiff(old, old.replace('line 10\n', 'X\n').replace('line 18\n', 'Y\n'), 'f'); // 7 lines between
    assert.equal(apart.split('\n').filter((l) => l.startsWith('@@')).length, 2);
  });

  test('(+) a missing final newline is marked on the side that lacks it', () => {
    assert.equal(unifiedDiff('a\nb', 'a\nb\n', 'x'), '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    assert.equal(unifiedDiff('a\nb\n', 'a\nb', 'x'), '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n');
    assert.equal(unifiedDiff('a', 'a\nb', 'x'), '--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n\\ No newline at end of file\n+a\n+b\n\\ No newline at end of file\n');
    // an unchanged last line that has no newline on either side is context and is marked too
    assert.equal(unifiedDiff('x\na', 'y\na', 'f'), '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-x\n+y\n a\n\\ No newline at end of file\n');
  });

  test('(+) equal texts give an empty string', () => {
    assert.equal(unifiedDiff('', '', 'x'), '');
    assert.equal(unifiedDiff('a\nb', 'a\nb', 'x'), '');
    assert.equal(unifiedDiff('a\n', 'a\n', 'x'), '');
  });

  test('(+) appending one line to a file shows the new line with context', () => {
    assert.equal(unifiedDiff('# T\n\n@rules/a.md\n', '# T\n\n@rules/a.md\n\n@rules/b.md\n', 'CLAUDE.md'),
      '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,3 +1,5 @@\n # T\n \n @rules/a.md\n+\n+@rules/b.md\n');
  });

  test('(+) round trip: applying the diff to the old text yields the new text (seeded random edits)', () => {
    let seed = 12345; // mulberry32
    const rnd = (n) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    let changed = 0;
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: rnd(40) }, () => `l${rnd(8)}`);
      const next = [...base];
      for (let e = rnd(8); e > 0; e--) {
        const at = rnd(next.length + 1);
        if (rnd(2) && next.length) next.splice(at % next.length, 1);
        else next.splice(at, 0, `n${rnd(8)}`);
      }
      const oldText = base.join('\n') + (base.length && rnd(4) ? '\n' : '');
      const newText = next.join('\n') + (next.length && rnd(4) ? '\n' : '');
      const diff = unifiedDiff(oldText, newText, 'f');
      assert.equal(applyDiff(oldText, diff), newText, `round ${round}\n${JSON.stringify(oldText)}\n${JSON.stringify(newText)}\n${diff}`);
      if (diff) changed++;
    }
    assert.ok(changed > 200, `only ${changed} of 300 rounds produced a diff`);
  });

  test('(+) texts with no common line, past the edit limit, still give a correct diff', () => {
    const oldText = text(nums(1200));
    const newText = text(nums(1300, 5000));
    const diff = unifiedDiff(oldText, newText, 'big');
    assert.equal(applyDiff(oldText, diff), newText);
    assert.equal(diff.split('\n').filter((l) => l.startsWith('-line')).length, 1200);
    assert.equal(diff.split('\n').filter((l) => l.startsWith('+line')).length, 1300);
  });

  test('(−) the diff is minimal for a single moved line (no spurious context rewrites)', () => {
    const old = text(nums(10));
    const next = text([...nums(10).slice(1), 'line 1']);
    const diff = unifiedDiff(old, next, 'f');
    assert.equal(diff.split('\n').filter((l) => /^[-+]line/.test(l)).length, 2);
    assert.equal(applyDiff(old, diff), next);
  });

  test('(−) lines that only differ by a trailing carriage return are different lines', () => {
    const diff = unifiedDiff('a\r\nb\r\n', 'a\nb\n', 'f');
    assert.match(diff, /^-a\r$/m);
    assert.match(diff, /^\+a$/m);
  });
});
