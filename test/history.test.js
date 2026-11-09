import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHistory, createLimiter } from '../src/collect/history.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-history-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// Synthetic ids only (repeated digits).
const ID = (d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const A = ID('1');
const ESC = '\u001b';

let n = 0;
/** Fresh fake config dir with one transcript (array of lines or raw string) for session `id`. */
function setup(lines, id = A) {
  const claudeDir = path.join(root, `c${n += 1}`);
  const dir = path.join(claudeDir, 'projects', '-demo-project');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, typeof lines === 'string' ? lines : lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return { claudeDir, file, dir };
}

const ts = (i) => new Date(Date.UTC(2026, 10, 7, 12, 0, i)).toISOString();
const user = (text, i = 0) => ({ type: 'user', timestamp: ts(i), message: { role: 'user', content: text } });
const assistant = (blocks, i = 0) => ({ type: 'assistant', timestamp: ts(i), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: blocks } });
const say = (text, i) => assistant([{ type: 'text', text }], i);
const get = (fx, q = {}, deps = {}) => readHistory(A, q, { claudeDir: fx.claudeDir, ...deps });
const texts = (r) => r.body.entries.map((e) => e.text);
/** Byte offset of the start of every line of a transcript file. */
const lineOffsets = (file) => {
  const out = [];
  let off = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n').slice(0, -1)) {
    out.push(off);
    off += Buffer.byteLength(l) + 1;
  }
  return out;
};

/** Pages back from EOF until nextBefore is null; returns every entry, oldest first, and the number of requests. */
async function readAll(fx, limit, deps) {
  const pages = [];
  let before;
  for (let guard = 0; guard < 500; guard += 1) {
    const r = await get(fx, { before, limit }, deps);
    assert.equal(r.status, 200);
    pages.unshift(r.body.entries);
    if (r.body.nextBefore === null) return { entries: pages.flat(), requests: guard + 1 };
    assert.ok(before === undefined || r.body.nextBefore < before, 'every page moves back');
    before = r.body.nextBefore;
  }
  throw new Error('paging did not finish');
}

describe('readHistory: normalising entries', () => {
  test('(+) user strings, assistant blocks, tool_use and tool_result become entries in file order', async () => {
    const fx = setup([
      { type: 'permission-mode', permissionMode: 'auto' },
      user('please list files', 1),
      assistant([{ type: 'thinking', thinking: 'plan it', signature: 'sig' }, { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', description: 'list' } }], 2),
      { type: 'user', timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt\nb.txt' }] } },
      { type: 'user', timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'one' }, { type: 'image', source: {} }, { type: 'text', text: 'two' }] }] } },
      { type: 'ai-title', aiTitle: 'Listing files' },
      say('Done.', 5),
    ]);
    const r = await get(fx);
    assert.equal(r.status, 200);
    assert.equal(r.body.nextBefore, null);
    const o = lineOffsets(fx.file);
    assert.deepEqual(r.body.entries, [
      { id: `${o[1]}:0`, at: ts(1), role: 'user', kind: 'text', text: 'please list files', truncated: false },
      { id: `${o[2]}:0`, at: ts(2), role: 'assistant', kind: 'thinking', text: 'plan it', truncated: false },
      { id: `${o[2]}:1`, at: ts(2), role: 'assistant', kind: 'text', text: 'Looking.', truncated: false },
      { id: `${o[2]}:2`, at: ts(2), role: 'assistant', kind: 'tool_use', text: '{"command":"ls -la","description":"list"}', tool: 'Bash', truncated: false },
      { id: `${o[3]}:0`, at: ts(3), role: 'user', kind: 'tool_result', text: 'a.txt\nb.txt', truncated: false },
      { id: `${o[4]}:0`, at: ts(4), role: 'user', kind: 'tool_result', text: 'one\ntwo', truncated: false },
      { id: `${o[6]}:0`, at: ts(5), role: 'assistant', kind: 'text', text: 'Done.', truncated: false },
    ]);
  });

  test('(+) text keeps newlines and tabs; escapes, controls and bidi marks are cleaned (cleanBlock)', async () => {
    const fx = setup([say(`line1\r\n\tline2${ESC}[31m red${ESC}]52;c;AAAA\u0007 \u202eevil\u0000 end\u009b`, 1)]);
    const [e] = (await get(fx)).body.entries;
    assert.equal(e.text, 'line1\n\tline2 red  evil  end'); // CSI and the OSC 52 clipboard sequence go whole, the other controls become spaces
    assert.doesNotMatch(e.text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
  });

  test('(+) an entry over 32 KB is cut at 32 KB, flagged truncated, and stays valid UTF-8', async () => {
    const fx = setup([say('ok', 1), say('日'.repeat(20000), 2), { type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(40000) }] } }]);
    const { entries } = (await get(fx)).body;
    assert.equal(entries[0].truncated, false);
    assert.equal(entries[1].truncated, true);
    assert.ok(Buffer.byteLength(entries[1].text) <= 32768);
    assert.doesNotMatch(entries[1].text, /�/);
    assert.equal(entries[2].truncated, true);
    assert.equal(entries[2].text.length, 32768);
    assert.equal(entries[2].at, null, 'missing timestamp gives at: null');
  });

  test('(+) a tool_use with a huge input is truncated and flagged', async () => {
    const fx = setup([assistant([{ type: 'tool_use', name: 'Write', input: { content: 'y'.repeat(50000) } }], 1)]);
    const [e] = (await get(fx)).body.entries;
    assert.equal(e.truncated, true);
    assert.equal(e.tool, 'Write');
    assert.ok(Buffer.byteLength(e.text) <= 32768);
  });

  test('(+) an empty tool_result is kept, empty text and thinking blocks are not', async () => {
    const fx = setup([assistant([{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: '  ' }], 1),
      { type: 'user', timestamp: ts(2), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] } }]);
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => [e.kind, e.text]), [['tool_result', '']]);
  });

  test('(−) lines that are not conversation, corrupt lines and a half-written last line give no entries and no error', async () => {
    const fx = setup([
      { type: 'summary', summary: 'x' }, { type: 'system', content: 'x' }, { type: 'file-history-snapshot' }, { type: 'last-prompt', lastPrompt: 'p' },
      '{broken json', '[1,2,3]', '"text"', 'null', '{"type":"user"}', '{"type":"user","message":null}', '{"type":"assistant","message":{"content":5}}',
      JSON.stringify(assistant([null, 7, 'str', { type: 'image' }, { type: 'redacted_thinking' }, { type: 'text', text: 5 }, { type: 'tool_use' }], 1)),
      say('survivor', 2),
    ].concat(['{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"cut mid wri']));
    fs.writeFileSync(fx.file, fs.readFileSync(fx.file, 'utf8').trimEnd()); // no trailing newline: the last line is incomplete
    const r = await get(fx);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entries.map((e) => [e.kind, e.text]), [['text', 'survivor']]);
  });

  test('(−) a tool name is cleaned and capped; an unusable one is omitted', async () => {
    const fx = setup([assistant([{ type: 'tool_use', name: `Ba${ESC}[2Jsh`.padEnd(300, 'x'), input: {} }, { type: 'tool_use', name: 5, input: { a: 1 } }], 1)]);
    const [a, b] = (await get(fx)).body.entries;
    assert.ok(a.tool.length <= 100);
    assert.doesNotMatch(a.tool, /\u001b/);
    assert.equal('tool' in b, false);
  });
});

describe('readHistory: paging', () => {
  const many = (count) => Array.from({ length: count }, (_, i) => say(`m${String(i).padStart(4, '0')}`, i));

  test('(+) default limit is 50: the last 50 entries and a nextBefore that points at the line start of the first one', async () => {
    const fx = setup(many(120));
    const r = await get(fx);
    assert.equal(r.body.entries.length, 50);
    assert.deepEqual(texts(r).slice(0, 2), ['m0070', 'm0071']);
    assert.equal(r.body.entries.at(-1).text, 'm0119');
    const file = fs.readFileSync(fx.file);
    const { nextBefore } = r.body;
    assert.equal(file[nextBefore - 1], 0x0a, 'offset is a line start');
    assert.equal(JSON.parse(file.subarray(nextBefore, file.indexOf(0x0a, nextBefore)).toString()).message.content[0].text, 'm0070');
  });

  test('(+) following nextBefore walks the whole file back without gaps or repeats, then returns null', async () => {
    const fx = setup(many(120));
    const { entries, requests } = await readAll(fx, 50);
    assert.deepEqual(entries.map((e) => e.text), many(120).map((l) => l.message.content[0].text));
    assert.equal(requests, 3);
  });

  test('(+) limit and before are accepted as numbers or digit strings; before = size equals the default', async () => {
    const fx = setup(many(10));
    const size = fs.statSync(fx.file).size;
    const base = await get(fx, { limit: 3 });
    assert.deepEqual(texts(base), ['m0007', 'm0008', 'm0009']);
    assert.deepEqual(await get(fx, { limit: '3', before: String(size) }), base);
    assert.deepEqual(await get(fx, { limit: 3, before: size }), base);
    assert.deepEqual(await get(fx, { limit: null, before: null }), await get(fx, {}));
    assert.deepEqual(await get(fx, undefined), await get(fx, {}));
  });

  test('(+) limit 1 and limit 200 work', async () => {
    const fx = setup(many(300));
    assert.deepEqual(texts(await get(fx, { limit: 1 })), ['m0299']);
    assert.equal((await get(fx, { limit: 200 })).body.entries.length, 200);
  });

  test('(+) before = 0 gives an empty page and null; an empty or non-conversation file gives the same', async () => {
    const fx = setup(many(3));
    assert.deepEqual((await get(fx, { before: 0 })).body, { entries: [], nextBefore: null });
    const empty = setup('');
    assert.deepEqual((await get(empty)).body, { entries: [], nextBefore: null });
    const other = setup([{ type: 'summary' }, { type: 'ai-title' }]);
    assert.deepEqual((await get(other)).body, { entries: [], nextBefore: null });
  });

  test('(+) a message with several blocks stays together: limit is met at line granularity, so nothing is lost between pages', async () => {
    const three = assistant([{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }, { type: 'tool_use', name: 'X', input: {} }], 9);
    const fx = setup([say('first', 1), three, say('last', 10)]);
    const page1 = await get(fx, { limit: 2 });
    assert.deepEqual(texts(page1), ['a', 'b', '{}', 'last']); // limit 2 reached inside the three-block line: the whole line stays
    const all = await readAll(fx, 1);
    assert.deepEqual(all.entries.map((e) => e.text), ['first', 'a', 'b', '{}', 'last']);
  });

  test('(+) a file over 1 MB is read in windows: every entry exactly once, windows start mid-line and mid-character', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => say(`${String(i).padStart(5, '0')} ${'日本語'.repeat(300)}`, i % 60));
    const fx = setup(lines);
    assert.ok(fs.statSync(fx.file).size > 3 * 1024 * 1024);
    const first = await get(fx, { limit: 200 });
    assert.ok(first.body.entries.length > 100 && first.body.entries.length <= 200);
    const { entries, requests } = await readAll(fx, 200);
    assert.deepEqual(entries.map((e) => e.text.slice(0, 5)), lines.map((_, i) => String(i).padStart(5, '0')));
    assert.ok(requests >= 4);
    for (const e of entries) assert.equal(e.text.length, 5 + 1 + 900);
  });

  test('(+) a single line longer than the window is skipped, paging still reaches the entries around it and ends', async () => {
    const giant = { type: 'user', timestamp: ts(5), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(2_500_000) }] } };
    const fx = setup([say('before-1', 1), say('before-2', 2), giant, say('after-1', 6), say('after-2', 7)]);
    const { entries, requests } = await readAll(fx, 50);
    assert.deepEqual(entries.map((e) => e.text), ['before-1', 'before-2', 'after-1', 'after-2']);
    assert.ok(requests >= 3 && requests < 20);
  });

  test('(+) a line that ends exactly at the window edge or starts at offset 0 is handled', async () => {
    const fx = setup([say('only', 1)]);
    const r = await get(fx);
    assert.deepEqual([texts(r), r.body.nextBefore], [['only'], null]);
  });

  test('(−) invalid limit values are 400: 0, 201, negative, fractional, NaN, empty, words, arrays', async () => {
    const fx = setup(many(3));
    for (const limit of [0, 201, 1000, -1, 1.5, NaN, Infinity, '', ' 5', '5 ', '1e1', '0x5', 'abc', '-3', '0', '201', [5], {}, true]) {
      const r = await get(fx, { limit });
      assert.equal(r.status, 400, JSON.stringify(limit));
      assert.equal(r.body.error, 'invalid');
    }
  });

  test('(−) invalid before values are 400: negative, fractional, past EOF, empty, words, huge', async () => {
    const fx = setup(many(3));
    const size = fs.statSync(fx.file).size;
    for (const before of [-1, 1.5, size + 1, 1e12, NaN, '', 'abc', '-1', '1.5', '0x10', '12345678901234567890', [1], {}, true]) {
      const r = await get(fx, { before });
      assert.equal(r.status, 400, JSON.stringify(before));
      assert.equal(r.body.error, 'invalid');
    }
  });

  test('(−) a before offset in the middle of a line gives only whole earlier lines and no error', async () => {
    const fx = setup(many(5));
    const file = fs.readFileSync(fx.file);
    const mid = file.indexOf(0x0a, file.indexOf(0x0a) + 1) + 20; // inside the third line
    const r = await get(fx, { before: mid });
    assert.equal(r.status, 200);
    assert.deepEqual(texts(r), ['m0000', 'm0001']);
  });
});

describe('readHistory: entry ids', () => {
  const many = (count) => Array.from({ length: count }, (_, i) => say(`m${String(i).padStart(4, '0')}`, i));
  const idOf = (e) => e.id.split(':').map(Number);

  test('(+) id is "<byte offset of the line>:<block index>"; the block index counts skipped blocks too', async () => {
    const fx = setup([user('héllo 日本', 1), assistant([{ type: 'thinking', thinking: '' }, { type: 'image' }, { type: 'text', text: 'third block' }], 2), say('tail', 3)]);
    const o = lineOffsets(fx.file);
    assert.ok(o[1] > 12, 'offsets are bytes, not characters');
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => e.id), [`${o[0]}:0`, `${o[1]}:2`, `${o[2]}:0`]);
    for (const e of entries) assert.match(e.id, /^\d+:\d+$/);
  });

  test('(+) the same entry has the same id on every page, whatever the page size or window start', async () => {
    const fx = setup(many(120));
    const o = lineOffsets(fx.file);
    const small = await readAll(fx, 7);
    const big = await readAll(fx, 200);
    assert.deepEqual(small.entries.map((e) => e.id), o.map((off) => `${off}:0`));
    assert.deepEqual(big.entries.map((e) => e.id), small.entries.map((e) => e.id));
    assert.equal(new Set(small.entries.map((e) => e.id)).size, 120, 'ids are unique');
    const page = await get(fx, { limit: 3, before: o[100] });
    assert.deepEqual(page.body.entries.map((e) => e.id), [97, 98, 99].map((i) => `${o[i]}:0`));
  });

  test('(+) ids do not move when the transcript grows at the end; ids stay unique inside a multi-block line', async () => {
    const lines = [say('one', 1), assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 2), say('three', 3)];
    const fx = setup(lines);
    const before = (await get(fx)).body.entries.map((e) => [e.id, e.text]);
    fs.appendFileSync(fx.file, `${JSON.stringify(say('four', 4))}\n`);
    const after = (await get(fx)).body.entries.map((e) => [e.id, e.text]);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(new Set(after.map(([id]) => id)).size, after.length);
  });

  test('(+) a window that starts mid-line does not shift the ids of the whole lines after it', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => say(`${String(i).padStart(5, '0')} ${'日本語'.repeat(300)}`, i % 60));
    const fx = setup(lines);
    const o = lineOffsets(fx.file);
    const { entries } = await readAll(fx, 200);
    assert.ok(entries.length === 1500);
    entries.forEach((e, i) => assert.equal(e.id, `${o[i]}:0`));
  });

  test('(−) lines that give no entries leave no id; offsets of the entries after them still count the skipped bytes', async () => {
    const fx = setup([{ type: 'summary', summary: 'x' }, '{broken json', say('kept', 1)]);
    const o = lineOffsets(fx.file);
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => e.id), [`${o[2]}:0`]);
    assert.ok(idOf(entries[0])[0] > 0);
  });
});

describe('readHistory: finding the file', () => {
  test('(−) ids that are not UUIDs, or not in the index, are 404 and never touch a path', async () => {
    const fx = setup([say('x', 1)]);
    const bad = ['', 'abc', ID('a').toUpperCase(), `${A}x`, `../${A}`, `${A}/../${A}`, `${A}.jsonl`, '-'.repeat(36), ID('2'), undefined, null, 5, {}, [A]];
    for (const id of bad) {
      const r = await readHistory(id, {}, { claudeDir: fx.claudeDir });
      assert.equal(r.status, 404, String(id));
      assert.equal(r.body.error, 'not_found');
    }
  });

  test('(−) a missing claude dir or projects dir is 404', async () => {
    assert.equal((await readHistory(A, {}, { claudeDir: path.join(root, 'nowhere') })).status, 404);
  });

  test('(−) order of checks: a malformed id is 404 before parameters, parameters are 400 before the file is looked up', async () => {
    const fx = setup([say('x', 1)]);
    assert.equal((await readHistory('not-an-id', { limit: 0 }, { claudeDir: fx.claudeDir })).status, 404);
    assert.equal((await readHistory(ID('2'), { limit: 0 }, { claudeDir: fx.claudeDir })).status, 400);
    assert.equal((await readHistory(ID('2'), {}, { claudeDir: fx.claudeDir })).status, 404);
  });

  test('(−) a symlinked transcript is not in the index: 404', async () => {
    const fx = setup([say('x', 1)], ID('3'));
    const target = path.join(root, 'outside.jsonl');
    fs.writeFileSync(target, JSON.stringify(say('stolen', 1)) + '\n');
    fs.symlinkSync(target, path.join(fx.dir, `${A}.jsonl`));
    assert.equal((await get(fx)).status, 404);
  });

  test('(−) a hard-linked transcript is refused by fsafe: 404', async () => {
    const fx = setup([say('x', 1)]);
    fs.linkSync(fx.file, path.join(root, `second-${n}.jsonl`));
    const r = await get(fx);
    assert.equal(r.status, 404);
    assert.equal(r.body.message, 'transcript not readable');
  });

  test('(−) a transcript that vanished after indexing is 404, not a crash', async () => {
    const fx = setup([say('x', 1)]);
    const cache = {};
    assert.equal((await get(fx, {}, { cache })).status, 200);
    fs.rmSync(fx.file);
    assert.equal((await get(fx, {}, { cache })).status, 404);
  });

  test('(+) the transcript index is kept on the cache object and reused; a new session is found by re-indexing', async () => {
    const fx = setup([say('x', 1)]);
    const cache = {};
    const clock = { t: 100_000 };
    const deps = { cache, now: () => clock.t };
    await get(fx, {}, deps);
    const memo = cache.historyIndex;
    assert.ok(memo.files.has(A));
    await get(fx, {}, deps);
    assert.equal(cache.historyIndex, memo, 'second call used the memo');
    fs.writeFileSync(path.join(fx.dir, `${ID('4')}.jsonl`), JSON.stringify(say('new session', 1)) + '\n');
    const r = await readHistory(ID('4'), {}, { claudeDir: fx.claudeDir, ...deps });
    assert.deepEqual(texts(r), ['new session']);
    assert.notEqual(cache.historyIndex, memo, 'unknown id forced a fresh index');
    clock.t += 11_000;
    await get(fx, {}, deps);
    assert.notEqual(cache.historyIndex.at, memo.at, 'memo expires after 10 s');
  });
});

describe('readHistory: concurrency', () => {
  test('(+) createLimiter runs at most N tasks at once, FIFO, and releases a slot when a task throws', async () => {
    const limited = createLimiter(2);
    let active = 0;
    let peak = 0;
    const order = [];
    const gate = [];
    const task = (i, { boom = false } = {}) => limited(async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(i);
      await new Promise((resolve) => gate.push(resolve));
      active -= 1;
      if (boom) throw new Error(`boom ${i}`);
      return i;
    });
    const runs = [task(0), task(1, { boom: true }), task(2), task(3), task(4)].map((p) => p.then((v) => ({ ok: v }), (e) => ({ err: e.message })));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, [0, 1], 'only two started');
    while (order.length < 5 || gate.length) {
      gate.shift()?.();
      await new Promise((r) => setImmediate(r));
    }
    const settled = await Promise.all(runs);
    assert.equal(peak, 2);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
    assert.deepEqual(settled, [{ ok: 0 }, { err: 'boom 1' }, { ok: 2 }, { ok: 3 }, { ok: 4 }]);
    assert.equal(await limited(async () => 'free again'), 'free again');
  });

  test('(−) createLimiter(1) serialises', async () => {
    const limited = createLimiter(1);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => limited(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active -= 1;
    })));
    assert.equal(peak, 1);
  });

  test('(+) 16 concurrent history requests (4 at a time inside) all complete with the same answer', async () => {
    const fx = setup(Array.from({ length: 400 }, (_, i) => say(`m${i}`, i % 60)));
    const rs = await Promise.all(Array.from({ length: 16 }, () => get(fx, { limit: 20 })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(new Set(rs.map((r) => JSON.stringify(r.body))).size, 1);
  });
});
