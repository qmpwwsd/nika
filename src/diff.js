// Unified diff for the rules preview (stdlib only): Myers shortest edit script on whole lines, 3 lines of context.
const CONTEXT = 3;
// shortcut: past this many edits in the changed region the region is shown as one delete block plus one insert block
// (still a valid diff, just not minimal); raise it if previews of unrelated large files ever look too noisy.
const MAX_EDITS = 1000;

function split(text) {
  if (text === '') return { lines: [], eol: true };
  const lines = text.split('\n');
  const eol = text.endsWith('\n');
  if (eol) lines.pop();
  return { lines, eol };
}

/** Myers forward search; returns the edit script ('e' keep, 'd' delete, 'i' insert) or null past MAX_EDITS. */
function myers(n, m, same) {
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && same(x, y)) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, off);
    }
  }
  return null;
}

function backtrack(trace, n, m, off) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = v[off + pk];
    const py = px - pk;
    while (x > px && y > py) {
      ops.push('e');
      x--;
      y--;
    }
    if (d > 0) ops.push(down ? 'i' : 'd');
    x = px;
    y = py;
  }
  return ops.reverse();
}

/**
 * Unified diff of two texts for `path` (`--- a/path`, `+++ b/path`); '' when they are equal. A create is an empty `oldText`,
 * a missing final newline prints `\ No newline at end of file`.
 */
export function unifiedDiff(oldText, newText, path) {
  if (oldText === newText) return '';
  const a = split(oldText);
  const b = split(newText);
  // a last line without a newline differs from the same text with one
  const same = (i, j) => a.lines[i] === b.lines[j] && (i === a.lines.length - 1 && !a.eol) === (j === b.lines.length - 1 && !b.eol);

  let head = 0;
  while (head < a.lines.length && head < b.lines.length && same(head, head)) head++;
  let tail = 0;
  while (tail < a.lines.length - head && tail < b.lines.length - head && same(a.lines.length - 1 - tail, b.lines.length - 1 - tail)) tail++;
  const n = a.lines.length - head - tail;
  const m = b.lines.length - head - tail;
  const mid = myers(n, m, (x, y) => same(head + x, head + y)) ?? [...'d'.repeat(n), ...'i'.repeat(m)];
  const script = [...'e'.repeat(head), ...mid, ...'e'.repeat(tail)];

  // rows carry the line numbers (0-based) at which each operation starts
  const rows = [];
  let i = 0;
  let j = 0;
  for (const t of script) {
    rows.push({ t, i, j });
    if (t !== 'i') i++;
    if (t !== 'd') j++;
  }

  const changes = [];
  rows.forEach((r, idx) => {
    if (r.t !== 'e') changes.push(idx);
  });
  const out = [`--- a/${path}`, `+++ b/${path}`];
  const line = (r) => {
    const mark = { e: ' ', d: '-', i: '+' }[r.t];
    const src = r.t === 'i' ? b : a;
    const idx = r.t === 'i' ? r.j : r.i;
    const text = `${mark}${src.lines[idx]}`;
    return idx === src.lines.length - 1 && !src.eol ? `${text}\n\\ No newline at end of file` : text;
  };
  const range = (start, count) => (count === 0 ? `${start},0` : count === 1 ? `${start + 1}` : `${start + 1},${count}`);
  for (let c = 0; c < changes.length; ) {
    let last = c;
    while (last + 1 < changes.length && changes[last + 1] - changes[last] - 1 <= 2 * CONTEXT) last++;
    const from = Math.max(0, changes[c] - CONTEXT);
    const to = Math.min(rows.length, changes[last] + CONTEXT + 1);
    const slice = rows.slice(from, to);
    const oldCount = slice.filter((r) => r.t !== 'i').length;
    const newCount = slice.filter((r) => r.t !== 'd').length;
    out.push(`@@ -${range(rows[from].i, oldCount)} +${range(rows[from].j, newCount)} @@`, ...slice.map(line));
    c = last + 1;
  }
  return `${out.join('\n')}\n`;
}
