import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readHistory, readSubagentHistory, readImage } from '../src/collect/history.js';
import { createLimiter } from '../src/limiter.js';

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
      { id: `${o[4]}:0`, at: ts(4), role: 'user', kind: 'tool_result', text: 'one\ntwo', truncated: false, images: [{ ref: `${o[4]}:0.1`, media: null, size: null }], imagesMore: 0 },
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
      JSON.stringify(assistant([null, 7, 'str', { type: 'image_url' }, { type: 'redacted_thinking' }, { type: 'text', text: 5 }, { type: 'tool_use' }], 1)),
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

  test('(+) a single line longer than the window is read whole (0.5.1, C: it used to be skipped), paging reaches the entries around it and ends', async () => {
    const giant = { type: 'user', timestamp: ts(5), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'z'.repeat(2_500_000) }] } };
    const fx = setup([say('before-1', 1), say('before-2', 2), giant, say('after-1', 6), say('after-2', 7)]);
    const { entries, requests } = await readAll(fx, 50);
    assert.deepEqual(entries.map((e) => e.text.slice(0, 8)), ['before-1', 'before-2', 'zzzzzzzz', 'after-1', 'after-2']);
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
    const fx = setup([user('héllo 日本', 1), assistant([{ type: 'thinking', thinking: '' }, { type: 'redacted_thinking' }, { type: 'text', text: 'third block' }], 2), say('tail', 3)]);
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

// ---- 0.5, W8: Claude's subagents (design W8 3.1, 3.2, 5.1) ----------------------------------------------------------------

const B = ID('2'); // a second session
const TOOL = 'toolu_01111111'; // synthetic tool-use id
const AG = 'a0000000000000001'; // synthetic subagent id
const getSub = (fx, agent, q = {}, deps = {}, session = A) => readSubagentHistory(session, agent, q, { claudeDir: fx.claudeDir, ...deps });
/** The folder `<project dir>/<session>/subagents` of a fixture (created). */
const subDirOf = (fx, session = A) => {
  const d = path.join(fx.dir, session, 'subagents');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
/** A subagent: its transcript (lines, or null for none) and its meta (an object, or null for none). */
function addSub(fx, agent, lines, meta = { agentType: 'Explore', description: 'List files', toolUseId: TOOL, finished: false }, session = A) {
  const d = subDirOf(fx, session);
  if (lines !== null) fs.writeFileSync(path.join(d, `agent-${agent}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (meta !== null) fs.writeFileSync(path.join(d, `agent-${agent}.meta.json`), JSON.stringify(meta));
  return d;
}
const call = (name, id = TOOL, input = { description: 'List files', subagent_type: 'Explore', prompt: 'go' }) => ({ type: 'tool_use', id, name, input });
/** Parent transcript with one assistant message holding the given blocks. */
const parentWith = (...blocks) => setup([user('start', 1), assistant(blocks, 2), say('after', 3)]);

describe('readSubagentHistory: paging (+)', () => {
  test('(+) a subagent transcript is paged exactly like readHistory pages the same lines: entries, ids, nextBefore, limit, before', async () => {
    const lines = Array.from({ length: 140 }, (_, i) => (i % 3 === 0 ? user(`q${i}`, i % 60) : say(`m${i}`, i % 60)));
    const fx = setup([say('parent', 1)]);
    addSub(fx, AG, lines);
    const twin = setup(lines, ID('3')); // the same lines as a plain session
    const mine = await getSub(fx, AG, { limit: 30 });
    const theirs = await readHistory(ID('3'), { limit: 30 }, { claudeDir: twin.claudeDir });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.entries.length, 30);
    assert.equal(typeof mine.body.nextBefore, 'number');
    assert.deepEqual(mine.body, theirs.body, 'same shape, same offsets');
    // walk back to the start: every entry once
    const all = [];
    let before;
    for (let guard = 0; guard < 50; guard += 1) {
      const r = await getSub(fx, AG, { before, limit: '50' });
      assert.equal(r.status, 200);
      all.unshift(...r.body.entries);
      if (r.body.nextBefore === null) break;
      assert.ok(before === undefined || r.body.nextBefore < before);
      before = r.body.nextBefore;
    }
    assert.deepEqual(all.map((e) => e.text), lines.map((l) => (typeof l.message.content === 'string' ? l.message.content : l.message.content[0].text)));
    assert.equal(new Set(all.map((e) => e.id)).size, 140);
  });

  test('(+) limit and before are accepted as numbers or digit strings; limit 1 and 200 work; before = 0 is an empty page', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, Array.from({ length: 10 }, (_, i) => say(`m${i}`, i)));
    assert.equal((await getSub(fx, AG, { limit: 1 })).body.entries.length, 1);
    assert.equal((await getSub(fx, AG, { limit: '200' })).body.entries.length, 10);
    const o = lineOffsets(path.join(fx.dir, A, 'subagents', `agent-${AG}.jsonl`));
    assert.deepEqual(texts(await getSub(fx, AG, { before: String(o[5]), limit: 100 })), ['m0', 'm1', 'm2', 'm3', 'm4']);
    assert.deepEqual(await getSub(fx, AG, { before: 0 }), { status: 200, body: { entries: [], nextBefore: null } });
  });

  test('(+) the answer is the same shape as the history answer and carries no subagent field', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [user('hi', 1), assistant([call('Agent')], 2)]);
    const r = await getSub(fx, AG);
    assert.deepEqual(Object.keys(r.body).sort(), ['entries', 'nextBefore']);
    for (const e of r.body.entries) assert.equal('subagent' in e, false);
  });

  test('(+) text goes through cleanBlock: escapes, controls and bidi marks in a subagent transcript are cleaned', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say(`line1\r\n\tline2${ESC}[31m red${ESC}]52;c;AAAA\u0007 \u202eevil\u0000 end\u009b`, 1)]);
    const [e] = (await getSub(fx, AG)).body.entries;
    assert.equal(e.text, 'line1\n\tline2 red  evil  end');
    assert.doesNotMatch(e.text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
  });

  test('(+) an entry over 32 KB is cut and flagged, as in the history route', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say('x'.repeat(40 * 1024), 1)]);
    const [e] = (await getSub(fx, AG)).body.entries;
    assert.equal(e.truncated, true);
    assert.ok(Buffer.byteLength(e.text) <= 32 * 1024);
  });
});

describe('readSubagentHistory: refusals (−)', () => {
  test('(−) a session id that is not a UUID, or not in the index, is 404 "no such session"', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say('x', 1)]);
    const bad = ['', 'abc', ID('a').toUpperCase(), `${A}x`, `../${A}`, `${A}/../${A}`, `${A}.jsonl`, '-'.repeat(36), undefined, null, 5, {}, [A]];
    for (const id of bad) {
      const r = await readSubagentHistory(id, AG, {}, { claudeDir: fx.claudeDir }); // not getSub: its default session would replace undefined
      assert.deepEqual(r, { status: 404, body: { error: 'not_found', message: 'no such session' } }, String(id));
    }
    assert.deepEqual(await getSub(fx, AG, {}, {}, ID('9')), { status: 404, body: { error: 'not_found', message: 'no such session' } }, 'a UUID nika does not know');
  });

  test('(−) an agent id that is not a SUBAGENT_ID is 404 "no such subagent", before limit and before the file is looked up', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say('x', 1)]);
    const bad = ['', '../x', '..', 'a/b', 'a\\b', 'a.b', 'a b', 'a\n', 'x'.repeat(65), '%2e%2e', null, undefined, 5, {}, [AG], true];
    for (const agent of bad) {
      for (const q of [{}, { limit: 0 }, { before: 'x' }]) {
        const r = await getSub(fx, agent, q);
        assert.deepEqual(r, { status: 404, body: { error: 'not_found', message: 'no such subagent' } }, `${String(agent)} ${JSON.stringify(q)}`);
      }
      // a session nika does not know: the agent id is still checked first
      assert.equal((await getSub(fx, agent, {}, {}, ID('9'))).body.message, 'no such subagent', String(agent));
    }
    // and a bad session id still comes first
    assert.equal((await getSub(fx, '../x', {}, {}, 'not-an-id')).body.message, 'no such session');
  });

  test('(−) limit and before are 400 for a good agent, as in the history route: same texts', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say('x', 1)]);
    for (const limit of [0, 201, -1, 1.5, NaN, '', 'abc', '1e2', false, {}]) {
      const r = await getSub(fx, AG, { limit });
      assert.equal(r.status, 400, String(limit));
      assert.deepEqual(r, await get(fx, { limit }), `same answer as history for limit ${String(limit)}`);
    }
    for (const before of [-1, 1.5, NaN, '', 'abc', '-1']) {
      const r = await getSub(fx, AG, { before });
      assert.equal(r.status, 400, String(before));
      assert.deepEqual(r, await get(fx, { before }));
    }
    const past = await getSub(fx, AG, { before: 999_999 });
    assert.deepEqual(past, { status: 400, body: { error: 'invalid', message: 'before is beyond the end of the transcript' } });
  });

  test('(−) an agent that is not in this session\'s folder is 404, also when another session has it', async () => {
    const fx = setup([say('p', 1)]);
    fs.writeFileSync(path.join(fx.dir, `${B}.jsonl`), JSON.stringify(say('b', 1)) + '\n');
    addSub(fx, AG, [say('mine', 1)], undefined, A);
    addSub(fx, 'only-in-b', [say('theirs', 1)], undefined, B);
    const no = { status: 404, body: { error: 'not_found', message: 'no such subagent' } };
    assert.deepEqual(await getSub(fx, 'nope'), no, 'unknown');
    assert.deepEqual(await getSub(fx, 'only-in-b'), no, 'session A does not list it');
    assert.deepEqual(texts(await getSub(fx, 'only-in-b', {}, {}, B)), ['theirs']);
    assert.deepEqual(await getSub(fx, AG, {}, {}, B), no, 'and the other way round');
    assert.deepEqual(texts(await getSub(fx, AG)), ['mine']);
  });

  test('(−) a name that is only a meta, or only a stray file next to a transcript, is not a transcript', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, 'metaonly', null);
    fs.writeFileSync(path.join(subDirOf(fx), 'agent-stray.jsonl.bak'), JSON.stringify(say('x', 1)) + '\n');
    for (const agent of ['metaonly', 'stray']) assert.equal((await getSub(fx, agent)).body.message, 'no such subagent', agent);
  });

  test('(−) a symlinked agent-<id>.jsonl is refused by fsafe: 404 "transcript not readable", nothing of the target is returned', async () => {
    const fx = setup([say('p', 1)]);
    const target = path.join(root, `outside-${n}.jsonl`);
    fs.writeFileSync(target, JSON.stringify(say('stolen', 1)) + '\n');
    fs.symlinkSync(target, path.join(subDirOf(fx), `agent-${AG}.jsonl`));
    const r = await getSub(fx, AG);
    assert.deepEqual(r, { status: 404, body: { error: 'not_found', message: 'transcript not readable' } });
    assert.equal(JSON.stringify(r).includes('stolen'), false);
  });

  test('(−) a hard-linked agent-<id>.jsonl is refused the same way', async () => {
    const fx = setup([say('p', 1)]);
    const d = addSub(fx, AG, [say('x', 1)]);
    fs.linkSync(path.join(d, `agent-${AG}.jsonl`), path.join(root, `second-sub-${n}.jsonl`));
    assert.deepEqual(await getSub(fx, AG), { status: 404, body: { error: 'not_found', message: 'transcript not readable' } });
  });

  test('(−) a directory named agent-<id>.jsonl is not a regular file: 404 "transcript not readable"', async () => {
    const fx = setup([say('p', 1)]);
    fs.mkdirSync(path.join(subDirOf(fx), `agent-${AG}.jsonl`));
    assert.equal((await getSub(fx, AG)).body.message, 'transcript not readable');
  });

  test('(−) a symlinked subagents folder, or a symlinked session folder, is 404 "no such subagent"', async () => {
    const outside = path.join(root, `outside-dir-${n}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, `agent-${AG}.jsonl`), JSON.stringify(say('stolen', 1)) + '\n');
    const a = setup([say('p', 1)]);
    fs.mkdirSync(path.join(a.dir, A), { recursive: true });
    fs.symlinkSync(outside, path.join(a.dir, A, 'subagents'));
    const b = setup([say('p', 1)]);
    const realSession = path.join(root, `real-session-${n}`);
    fs.mkdirSync(path.join(realSession, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(realSession, 'subagents', `agent-${AG}.jsonl`), JSON.stringify(say('stolen', 1)) + '\n');
    fs.symlinkSync(realSession, path.join(b.dir, A));
    for (const fx of [a, b]) {
      const r = await getSub(fx, AG);
      assert.deepEqual(r, { status: 404, body: { error: 'not_found', message: 'no such subagent' } });
    }
  });

  test('(−) a transcript that vanished after it was listed is 404, not a crash', async () => {
    const fx = setup([say('p', 1)]);
    const d = addSub(fx, AG, [say('x', 1)]);
    assert.equal((await getSub(fx, AG)).status, 200);
    fs.rmSync(path.join(d, `agent-${AG}.jsonl`));
    assert.equal((await getSub(fx, AG)).status, 404);
  });

  test('(+) the transcript index is the history route\'s: one memo on the cache object serves both routes', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say('x', 1)]);
    const cache = {};
    await get(fx, {}, { cache });
    const memo = cache.historyIndex;
    assert.equal((await getSub(fx, AG, {}, { cache })).status, 200);
    assert.equal(cache.historyIndex, memo, 'the subagent route reused the memo');
  });
});

/** Counts the handles nika holds open on `*.jsonl` transcripts at once and the meta files it opens; restores fs on the way out. */
async function tracked(fn, { delayMs = 0 } = {}) {
  const realOpen = fsp.open;
  const stat = { inFlight: 0, peak: 0, metaOpens: 0, transcriptOpens: 0 };
  fsp.open = async (file, ...rest) => {
    const h = await realOpen.call(fsp, file, ...rest);
    const name = String(file);
    if (name.endsWith('.meta.json')) stat.metaOpens += 1;
    if (!name.endsWith('.jsonl')) return h;
    stat.transcriptOpens += 1;
    stat.inFlight += 1;
    stat.peak = Math.max(stat.peak, stat.inFlight);
    const realRead = h.read.bind(h);
    const realClose = h.close.bind(h);
    h.read = async (...a) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return realRead(...a);
    };
    h.close = async () => {
      stat.inFlight -= 1;
      return realClose();
    };
    return h;
  };
  try {
    await fn(stat);
  } finally {
    fsp.open = realOpen;
  }
  return stat;
}

describe('readSubagentHistory: bounds', () => {
  test('(+) both routes share one limiter: 16 mixed requests never hold more than 4 transcripts open', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => say(`m${i}`, i % 60));
    const fx = setup(lines);
    addSub(fx, AG, lines);
    const stat = await tracked(async () => {
      const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? get(fx, { limit: 20 }) : getSub(fx, AG, { limit: 20 }))));
      assert.ok(rs.every((r) => r.status === 200));
    }, { delayMs: 15 });
    assert.equal(stat.transcriptOpens, 16);
    assert.equal(stat.peak, 4, 'four at a time, shared by both routes');
  });

  test('(+) the link map is built only for a page that holds an Agent or Task call: no meta is opened otherwise', async () => {
    const fx = parentWith({ type: 'text', text: 'no call here' }, call('Read', TOOL, { file_path: '/x' }));
    addSub(fx, AG, [say('x', 1)]);
    const none = await tracked(async () => { assert.equal((await get(fx)).status, 200); });
    assert.equal(none.metaOpens, 0, 'no Agent/Task call → the folder is not read');
    const fx2 = parentWith(call('Agent'));
    addSub(fx2, AG, [say('x', 1)]);
    const some = await tracked(async () => { assert.equal((await get(fx2)).status, 200); });
    assert.ok(some.metaOpens >= 1, 'an Agent call → the metas are read');
    const sub = await tracked(async () => { assert.equal((await getSub(fx2, AG)).status, 200); });
    assert.equal(sub.metaOpens, 0, 'the subagent route builds no link map');
    const bad = parentWith(call('Agent', 'has space'), call('Task', 5), { type: 'tool_use', name: 'Agent', input: {} });
    addSub(bad, AG, [say('x', 1)]);
    assert.equal((await tracked(async () => { await get(bad); })).metaOpens, 0, 'a call without a usable id needs no map');
  });
});

describe('readHistory: the subagent link on Agent and Task calls (design W8 3.2)', () => {
  const link = async (fx) => (await get(fx)).body.entries.filter((e) => e.kind === 'tool_use').map((e) => e.subagent);

  test('(+) an Agent call whose id exactly one meta names gets subagent = that agent id; Task the same', async () => {
    const fx = parentWith(call('Agent'), call('Task', 'toolu_02222222'));
    addSub(fx, AG, [say('x', 1)]);
    addSub(fx, 'bbb222', [say('y', 1)], { agentType: 'general-purpose', description: 'Other', toolUseId: 'toolu_02222222' });
    const r = await get(fx);
    const calls = r.body.entries.filter((e) => e.kind === 'tool_use');
    assert.deepEqual(calls.map((e) => [e.tool, e.subagent]), [['Agent', AG], ['Task', 'bbb222']]);
    assert.deepEqual(calls[0], { id: calls[0].id, at: ts(2), role: 'assistant', kind: 'tool_use', tool: 'Agent', text: '{"description":"List files","subagent_type":"Explore","prompt":"go"}', truncated: false, subagent: AG });
  });

  test('(+) the link also appears on an older page, and on a page cut by limit', async () => {
    const fx = setup([user('start', 1), assistant([call('Agent')], 2), ...Array.from({ length: 30 }, (_, i) => say(`m${i}`, 3 + i))]);
    addSub(fx, AG, [say('x', 1)]);
    const newest = await get(fx, { limit: 10 });
    assert.equal(newest.body.entries.some((e) => e.kind === 'tool_use'), false);
    const older = await get(fx, { limit: 200, before: newest.body.nextBefore });
    assert.deepEqual(older.body.entries.filter((e) => e.kind === 'tool_use').map((e) => e.subagent), [AG]);
  });

  test('(−) no subagent field: another tool name, even with a matching meta', async () => {
    const fx = parentWith(call('Read'), call('Bash', TOOL, { command: 'ls' }), call('agent'), call('TaskCreate'), call('Agent '));
    addSub(fx, AG, [say('x', 1)]);
    assert.deepEqual(await link(fx), [undefined, undefined, undefined, undefined, undefined]);
  });

  test('(−) no subagent field: no meta at all, or no folder', async () => {
    const fx = parentWith(call('Agent'));
    assert.deepEqual(await link(fx), [undefined]);
    addSub(fx, 'other', [say('x', 1)], { agentType: 'Explore', description: 'no toolUseId' });
    assert.deepEqual(await link(fx), [undefined], 'a meta without a toolUseId names nothing');
    addSub(fx, 'other2', [say('x', 1)], { agentType: 'Explore', toolUseId: 'toolu_09999999' });
    assert.deepEqual(await link(fx), [undefined], 'a meta that names another call');
  });

  test('(−) no subagent field: a tool-use id that is missing, not a string or not a TOOL_USE_ID, even when a meta repeats it', async () => {
    const bad = ['has space', 'a.b', '../x', 'x'.repeat(129), '', 5, null, { a: 1 }];
    const fx = parentWith(...bad.map((id) => call('Agent', id)), { type: 'tool_use', name: 'Task', input: {} });
    bad.forEach((id, i) => { if (typeof id === 'string') addSub(fx, `m${i}`, [say('x', 1)], { agentType: 'Explore', toolUseId: id }); });
    assert.deepEqual(await link(fx), new Array(bad.length + 1).fill(undefined));
  });

  test('(−) no subagent field: two metas with the same toolUseId link neither', async () => {
    const fx = parentWith(call('Agent'));
    addSub(fx, 'one', [say('x', 1)]);
    addSub(fx, 'two', [say('y', 1)]);
    assert.deepEqual(await link(fx), [undefined]);
    // removing one of the two brings the link back: the count is what decides
    fs.rmSync(path.join(subDirOf(fx), 'agent-two.meta.json'));
    assert.deepEqual(await link(fx), ['one']);
  });

  test('(−) no subagent field: a meta without agent-<id>.jsonl, or whose folder is not a real directory', async () => {
    const fx = parentWith(call('Agent'));
    addSub(fx, AG, null);
    assert.deepEqual(await link(fx), [undefined], 'meta without a transcript');
    const sym = parentWith(call('Agent'));
    const outside = path.join(root, `outside-links-${n}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, `agent-${AG}.jsonl`), JSON.stringify(say('x', 1)) + '\n');
    fs.writeFileSync(path.join(outside, `agent-${AG}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: TOOL }));
    fs.mkdirSync(path.join(sym.dir, A), { recursive: true });
    fs.symlinkSync(outside, path.join(sym.dir, A, 'subagents'));
    assert.deepEqual(await link(sym), [undefined], 'symlinked subagents folder');
  });

  test('(−) no subagent field: a broken or symlinked meta names nothing', async () => {
    const fx = parentWith(call('Agent'));
    const d = addSub(fx, AG, [say('x', 1)], null);
    fs.writeFileSync(path.join(d, `agent-${AG}.meta.json`), '{broken');
    assert.deepEqual(await link(fx), [undefined]);
    fs.rmSync(path.join(d, `agent-${AG}.meta.json`));
    const real = path.join(root, `meta-target-${n}.json`);
    fs.writeFileSync(real, JSON.stringify({ agentType: 'Explore', toolUseId: TOOL }));
    fs.symlinkSync(real, path.join(d, `agent-${AG}.meta.json`));
    assert.deepEqual(await link(fx), [undefined]);
  });

  test('(−) no subagent field on any entry that is not a tool_use, whatever the ids say', async () => {
    const fx = setup([
      user('start', 1),
      assistant([{ type: 'text', text: `see ${TOOL}` }, { type: 'thinking', thinking: `about ${TOOL}`, signature: 's' }], 2),
      { type: 'user', timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'done' }] } },
      assistant([call('Agent')], 4),
    ]);
    addSub(fx, AG, [say('x', 1)]);
    const entries = (await get(fx)).body.entries;
    assert.equal(entries.length, 5);
    assert.deepEqual(entries.filter((e) => 'subagent' in e).map((e) => e.kind), ['tool_use']);
  });

  test('(−) no entry of the subagent route carries subagent, even an Agent call the metas would link', async () => {
    const fx = parentWith(call('Agent'));
    addSub(fx, AG, [user('go', 1), assistant([call('Agent'), call('Task')], 2)]);
    const parent = (await get(fx)).body.entries.filter((e) => e.kind === 'tool_use');
    assert.equal(parent[0].subagent, AG, 'the parent links it');
    const own = (await getSub(fx, AG)).body.entries;
    assert.equal(own.filter((e) => e.kind === 'tool_use').length, 2);
    for (const e of own) assert.equal('subagent' in e, false);
  });

  test('(−) the tool-use id string appears in no response body, in either route', async () => {
    const fx = parentWith(call('Agent'));
    addSub(fx, AG, [user('go', 1), assistant([call('Agent')], 2), { type: 'user', timestamp: ts(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'ok' }] } }]);
    for (const r of [await get(fx), await getSub(fx, AG), await get(fx, { limit: 1 })]) {
      assert.equal(r.status, 200);
      assert.equal(JSON.stringify(r).includes(TOOL), false);
      assert.equal(JSON.stringify(r).includes('toolUseId'), false);
    }
    assert.ok((await get(fx)).body.entries.some((e) => e.subagent === AG), 'the link itself is there');
  });

  test('(+) linking never fails the page: an unreadable folder leaves the entries without a link', async () => {
    const fx = parentWith(call('Agent'));
    const d = addSub(fx, AG, [say('x', 1)]);
    fs.chmodSync(d, 0o000);
    try {
      const r = await get(fx);
      assert.equal(r.status, 200);
      assert.equal(r.body.entries.filter((e) => e.kind === 'tool_use')[0].subagent, undefined);
    } finally {
      fs.chmodSync(d, 0o755);
    }
  });
});

// ---- 0.5.1, C: pictures in the history, lines longer than the window, and the image route's reader -----------------------------------

const MIB = 1024 * 1024;
const HEADS = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]),
  gif: Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0, 1, 2, 3])]),
  webp: Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.from([0, 1, 2, 3])]),
};
/** An image content block; `buf` is the decoded picture, `media` the declared type. */
const picture = (media = 'png', buf = HEADS[media]) => ({ type: 'image', source: { type: 'base64', media_type: `image/${media}`, data: buf.toString('base64') } });
/** A picture of exactly `n` decoded bytes (its signature first). */
const pictureOf = (n, media = 'png') => picture(media, Buffer.concat([HEADS[media], Buffer.alloc(n - HEADS[media].length, 7)]));
const userWith = (blocks, i = 1) => ({ type: 'user', timestamp: ts(i), message: { role: 'user', content: blocks } });
const resultWith = (parts, i = 1, id = 't1') => userWith([{ type: 'tool_result', tool_use_id: id, content: parts }], i);
/** A tool result whose single text part is `n` bytes: the line is `n` plus a fixed frame. */
const bulky = (n, i = 5) => resultWith([{ type: 'text', text: 'z'.repeat(n) }], i);
/** The tool result line that takes exactly `total` bytes in the file, its newline included. */
const bulkyLine = (total) => {
  const frame = JSON.stringify(bulky(0)).length + 1;
  return bulky(total - frame);
};

describe('readHistory: image entries (0.5.1, C)', () => {
  test('(+) an image block of a user or assistant message is an image entry with its media and decoded size', async () => {
    const fx = setup([
      userWith([{ type: 'text', text: 'look' }, picture('png')], 1),
      assistant([picture('jpeg'), { type: 'text', text: 'ok' }, picture('gif'), picture('webp')], 2),
    ]);
    const o = lineOffsets(fx.file);
    const r = await get(fx);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entries, [
      { id: `${o[0]}:0`, at: ts(1), role: 'user', kind: 'text', text: 'look', truncated: false },
      { id: `${o[0]}:1`, at: ts(1), role: 'user', kind: 'image', text: '', media: 'png', size: HEADS.png.length, truncated: false },
      { id: `${o[1]}:0`, at: ts(2), role: 'assistant', kind: 'image', text: '', media: 'jpeg', size: HEADS.jpeg.length, truncated: false },
      { id: `${o[1]}:1`, at: ts(2), role: 'assistant', kind: 'text', text: 'ok', truncated: false },
      { id: `${o[1]}:2`, at: ts(2), role: 'assistant', kind: 'image', text: '', media: 'gif', size: HEADS.gif.length, truncated: false },
      { id: `${o[1]}:3`, at: ts(2), role: 'assistant', kind: 'image', text: '', media: 'webp', size: HEADS.webp.length, truncated: false },
    ]);
  });

  test('(+) a message that holds only a picture is kept: an empty text is noise, an image is not', async () => {
    const fx = setup([userWith([picture('png')], 1), assistant([{ type: 'text', text: '  ' }, picture('gif')], 2)]);
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => [e.kind, e.media]), [['image', 'png'], ['image', 'gif']]);
    assert.deepEqual(entries.map((e) => e.id.split(':')[1]), ['0', '1'], 'the block index counts the skipped empty text');
  });

  test('(+) size follows the base64 length and its padding (0, 1 and 2 "="), also for a big picture, and is never decoded', async () => {
    const sizes = [12, 13, 14, 15, 100, 3 * MIB + 1];
    const fx = setup(sizes.map((n, i) => userWith([pictureOf(n)], i)));
    const { entries } = await readAll(fx, 50);
    assert.deepEqual(entries.map((e) => e.size), sizes);
  });

  test('(−) media is null for SVG, other types, a source that is not base64, a missing or oddly cased type; size is then null too', async () => {
    const data = HEADS.png.toString('base64');
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/PNG', data } },
      { type: 'image', source: { type: 'base64', media_type: ' image/png', data } },
      { type: 'image', source: { type: 'base64', data } },
      { type: 'image', source: { type: 'base64', media_type: 5, data } },
      { type: 'image', source: { type: 'base64', media_type: '__proto__', data } },
      { type: 'image', source: { type: 'url', media_type: 'image/png', url: 'https://example.invalid/x.png' } },
      { type: 'image', source: { type: 'url', media_type: 'image/png', data } },
    ];
    const fx = setup([userWith(blocks, 1)]);
    const { entries } = (await get(fx)).body;
    assert.equal(entries.length, blocks.length);
    for (const [i, e] of entries.entries()) assert.deepEqual([e.kind, e.media, e.size], ['image', null, null], `block ${i}`);
  });

  test('(−) size is null when the length is not a multiple of 4 or the data is not a string; media stays', async () => {
    const good = HEADS.png.toString('base64');
    const fx = setup([userWith([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `${good}A` } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 12 } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: null } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ['AAAA'] } },
    ], 1)]);
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => [e.media, e.size]), Array.from({ length: 5 }, () => ['png', null]));
  });

  test('(+) paging only estimates the size: it does not decode or test the characters', async () => {
    const fx = setup([userWith([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '!!!!AAAA' } }], 1)]);
    const [e] = (await get(fx)).body.entries;
    assert.deepEqual([e.media, e.size], ['jpeg', 6]);
  });

  test('(−) an image block with no source, or one that is not an object, is still an entry, with media and size null', async () => {
    const fx = setup([assistant([{ type: 'image' }, { type: 'image', source: 'x' }, { type: 'image', source: null }, { type: 'image', source: {} }], 1)]);
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => [e.kind, e.media, e.size]), Array.from({ length: 4 }, () => ['image', null, null]));
  });

  test('(−) image blocks that are not blocks: null, numbers and strings in the array give nothing; an image in a string message does not exist', async () => {
    const fx = setup([userWith([null, 5, 'image', picture('png')], 1), user('image', 2)]);
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => e.kind), ['image', 'text']);
  });

  test('(−) the subagent route gives the same image entries', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [userWith([picture('webp')], 1)]);
    const { entries } = (await getSub(fx, AG)).body;
    assert.deepEqual(entries.map((e) => [e.kind, e.media, e.size]), [['image', 'webp', HEADS.webp.length]]);
  });
});

describe('readHistory: pictures in tool results (0.5.1, C)', () => {
  test('(+) image parts are listed with a ref "<off>:<block>.<part>", their media and size; the text is the text parts', async () => {
    const fx = setup([say('first', 1), resultWith([{ type: 'text', text: 'shot' }, picture('png'), { type: 'text', text: 'done' }, picture('jpeg')], 2)]);
    const o = lineOffsets(fx.file);
    const [, e] = (await get(fx)).body.entries;
    assert.deepEqual(e, {
      id: `${o[1]}:0`, at: ts(2), role: 'user', kind: 'tool_result', text: 'shot\ndone', truncated: false,
      images: [{ ref: `${o[1]}:0.1`, media: 'png', size: HEADS.png.length }, { ref: `${o[1]}:0.3`, media: 'jpeg', size: HEADS.jpeg.length }],
      imagesMore: 0,
    });
  });

  test('(+) the ref counts every block of the message and every part of the result', async () => {
    const fx = setup([userWith([{ type: 'text', text: 'x' }, { type: 'tool_result', tool_use_id: 'a', content: 'plain' },
      { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 't' }, { type: 'text', text: 'u' }, picture('gif')] }], 1)]);
    const o = lineOffsets(fx.file);
    const { entries } = (await get(fx)).body;
    const withImages = entries.find((e) => e.images);
    assert.equal(withImages.id, `${o[0]}:2`);
    assert.deepEqual(withImages.images, [{ ref: `${o[0]}:2.2`, media: 'gif', size: HEADS.gif.length }]);
  });

  test('(+) at most 8 parts are listed; imagesMore counts the rest', async () => {
    const fx = setup([resultWith(Array.from({ length: 11 }, () => picture('png')), 1)]);
    const o = lineOffsets(fx.file);
    const [e] = (await get(fx)).body.entries;
    assert.deepEqual(e.images.map((p) => p.ref), Array.from({ length: 8 }, (_, j) => `${o[0]}:0.${j}`));
    assert.equal(e.imagesMore, 3);
    const nine = setup([resultWith(Array.from({ length: 9 }, () => picture('png')), 1)]);
    const [n] = (await get(nine)).body.entries;
    assert.deepEqual([n.images.length, n.imagesMore], [8, 1]);
    const eight = setup([resultWith(Array.from({ length: 8 }, () => picture('png')), 1)]);
    const [m] = (await get(eight)).body.entries;
    assert.deepEqual([m.images.length, m.imagesMore], [8, 0]);
  });

  test('(+) parts 0 to 999 count; a part past index 999 is neither listed nor counted', async () => {
    const parts = Array.from({ length: 1000 }, () => ({ type: 'text', text: '' }));
    parts[999] = picture('png');
    parts.push(picture('png'), picture('png')); // indexes 1000 and 1001
    const fx = setup([resultWith(parts, 1)]);
    const o = lineOffsets(fx.file);
    const [e] = (await get(fx)).body.entries;
    assert.deepEqual(e.images, [{ ref: `${o[0]}:0.999`, media: 'png', size: HEADS.png.length }]);
    assert.equal(e.imagesMore, 0);
    const late = setup([resultWith([...Array.from({ length: 1000 }, () => ({ type: 'text', text: '' })), picture('png')], 1)]);
    const [l] = (await get(late)).body.entries;
    assert.equal(Object.hasOwn(l, 'images'), false);
    assert.equal(Object.hasOwn(l, 'imagesMore'), false);
  });

  test('(+) a result that holds nothing but pictures is kept, with empty text', async () => {
    const fx = setup([resultWith([picture('png')], 1)]);
    const [e] = (await get(fx)).body.entries;
    assert.deepEqual([e.kind, e.text, e.images.length], ['tool_result', '', 1]);
  });

  test('(−) neither field appears without an image part: string content, text parts, an object, null, a number', async () => {
    const cases = ['plain', [{ type: 'text', text: 'a' }], [], { type: 'image', source: {} }, null, 5, [null, 5, 'x', { type: 'text' }], [{ type: 'image_url' }]];
    for (const content of cases) {
      const fx = setup([resultWith(content, 1)]);
      const [e] = (await get(fx)).body.entries;
      assert.equal(e.kind, 'tool_result');
      assert.equal(Object.hasOwn(e, 'images'), false, JSON.stringify(content));
      assert.equal(Object.hasOwn(e, 'imagesMore'), false, JSON.stringify(content));
    }
  });

  test('(−) an image part with an unusable source is listed with media null and size null; a nested result is not searched', async () => {
    const fx = setup([resultWith([{ type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' } }, { type: 'image' },
      { type: 'tool_result', content: [picture('png')] }], 1)]);
    const o = lineOffsets(fx.file);
    const [e] = (await get(fx)).body.entries;
    assert.deepEqual(e.images, [{ ref: `${o[0]}:0.0`, media: null, size: null }, { ref: `${o[0]}:0.1`, media: null, size: null }]);
    assert.equal(e.imagesMore, 0);
  });

  test('(−) no other entry carries images or imagesMore, even when its block has a content array of pictures', async () => {
    const fx = setup([assistant([
      { type: 'text', text: 'hello', content: [picture('png')] },
      { type: 'tool_use', id: 'x', name: 'Bash', input: {}, content: [picture('png')] },
      { type: 'thinking', thinking: 'hm', content: [picture('png')] },
      { ...picture('png'), content: [picture('png')] },
    ], 1)]);
    const { entries } = (await get(fx)).body;
    assert.deepEqual(entries.map((e) => e.kind), ['text', 'tool_use', 'thinking', 'image']);
    for (const e of entries) {
      assert.equal(Object.hasOwn(e, 'images'), false, e.kind);
      assert.equal(Object.hasOwn(e, 'imagesMore'), false, e.kind);
    }
  });

  test('(+) the same fields on the subagent route', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [resultWith([picture('png')], 1)]);
    const [e] = (await getSub(fx, AG)).body.entries;
    assert.deepEqual(e.images.map((p) => p.media), ['png']);
    assert.equal(e.imagesMore, 0);
  });
});

/** Counts bytes read from transcripts, the reads that follow a request's window read ("long" reads) in flight at once, and the handles open at once. */
async function traced(fn, { delayMs = 0 } = {}) {
  const realOpen = fsp.open;
  const stat = { bytes: 0, active: 0, peakLong: 0, open: 0, peakOpen: 0, opened: 0 };
  fsp.open = async (file, ...rest) => {
    const h = await realOpen.call(fsp, file, ...rest);
    if (!String(file).endsWith('.jsonl')) return h;
    stat.opened += 1;
    stat.open += 1;
    stat.peakOpen = Math.max(stat.peakOpen, stat.open);
    let own = 0;
    const realRead = h.read.bind(h);
    const realClose = h.close.bind(h);
    h.read = async (...a) => {
      own += 1;
      const long = own > 1;
      if (long) {
        stat.active += 1;
        stat.peakLong = Math.max(stat.peakLong, stat.active);
      }
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const out = await realRead(...a);
        stat.bytes += out.bytesRead;
        return out;
      } finally {
        if (long) stat.active -= 1;
      }
    };
    h.close = async () => {
      stat.open -= 1;
      return realClose();
    };
    return h;
  };
  try {
    await fn(stat);
  } finally {
    fsp.open = realOpen;
  }
  return stat;
}

describe('readHistory: lines longer than the window (0.5.1, C)', () => {
  test('(+) a line over one window is read whole: its entry is there, cut to 32 KB and flagged, between its neighbours', async () => {
    const fx = setup([say('before-1', 1), say('before-2', 2), bulky(2_500_000), say('after-1', 6), say('after-2', 7)]);
    const { entries, requests } = await readAll(fx, 50);
    assert.deepEqual(entries.map((e) => e.kind), ['text', 'text', 'tool_result', 'text', 'text']);
    assert.deepEqual(entries.map((e) => e.text.slice(0, 8)), ['before-1', 'before-2', 'zzzzzzzz', 'after-1', 'after-2']);
    assert.equal(entries[2].truncated, true);
    assert.equal(entries[2].text.length, 32768);
    assert.ok(requests >= 3 && requests < 20);
    const o = lineOffsets(fx.file);
    assert.deepEqual(entries.map((e) => e.id), [`${o[0]}:0`, `${o[1]}:0`, `${o[2]}:0`, `${o[3]}:0`, `${o[4]}:0`]);
  });

  test('(+) limit 1 walks a file of long and short lines: every entry once, ids are the true line offsets, every page moves back', async () => {
    const lines = [say('a', 1), bulky(1_200_000, 2), say('b', 3), bulky(3_000_000, 4), bulky(1_100_000, 5), say('c', 6)];
    const fx = setup(lines);
    const o = lineOffsets(fx.file);
    const { entries } = await readAll(fx, 1);
    assert.deepEqual(entries.map((e) => e.id), o.map((x) => `${x}:0`));
  });

  test('(+) a long line at the very end, at offset 0, and alone', async () => {
    const tail = setup([say('a', 1), bulky(2_000_000, 2)]);
    const r = await get(tail, { limit: 1 });
    assert.deepEqual(r.body.entries.map((e) => e.kind), ['tool_result']);
    assert.equal(r.body.nextBefore, lineOffsets(tail.file)[1]);
    const head = setup([bulky(2_000_000, 1), say('z', 2)]);
    const { entries } = await readAll(head, 1);
    assert.deepEqual(entries.map((e) => e.kind), ['tool_result', 'text']);
    assert.equal(entries[0].id, '0:0');
    const alone = setup([bulky(2_000_000, 1)]);
    const a = await get(alone);
    assert.deepEqual([a.body.entries.length, a.body.nextBefore], [1, null]);
  });

  test('(+) a before inside a long line goes back to the line start and gives no entry for the cut line', async () => {
    const fx = setup([say('first', 1), bulky(2_500_000, 2), say('last', 3)]);
    const o = lineOffsets(fx.file);
    const mid = await get(fx, { before: o[1] + 1_800_000 });
    assert.equal(mid.status, 200);
    assert.deepEqual(mid.body.entries, []);
    assert.equal(mid.body.nextBefore, o[1]);
    const next = await get(fx, { before: mid.body.nextBefore });
    assert.deepEqual(next.body.entries.map((e) => e.text), ['first']);
  });

  test('(+) a line of exactly LINE_MAX bytes (newline included) is read, one byte more is skipped; the entries around both are reached', async () => {
    const LINE_MAX = 16 * MIB;
    const fits = setup([say('before', 1), bulkyLine(LINE_MAX), say('after', 7)]);
    const o = lineOffsets(fits.file);
    assert.equal(o[2] - o[1], LINE_MAX);
    const a = await readAll(fits, 50);
    assert.deepEqual(a.entries.map((e) => e.kind), ['text', 'tool_result', 'text']);
    const over = setup([say('before', 1), bulkyLine(LINE_MAX + 1), say('after', 7)]);
    const b = await readAll(over, 50);
    assert.deepEqual(b.entries.map((e) => e.text), ['before', 'after']);
    assert.ok(b.requests < 20);
  });

  test('(−) a line with no newline within 32 MiB behind it: pages step back by 32 MiB and paging still ends and reaches what is before', async () => {
    const fx = setup([say('early', 1), bulky(33 * MIB, 2), say('late', 3)]);
    const { entries, requests } = await readAll(fx, 50);
    assert.deepEqual(entries.map((e) => e.text), ['early', 'late']);
    assert.equal(requests, 4, 'the late page, two steps of 32 MiB through the line, the early page');
  });

  test('(−) a long line that is still being written gives no entry and no error, and is read whole once its newline is there', async () => {
    const line = JSON.stringify(say('x'.repeat(1_600_000), 2));
    const fx = setup([say('first', 1)]);
    fs.appendFileSync(fx.file, line.slice(0, 1_400_000)); // cut in the middle, no newline
    const cut = await get(fx);
    assert.equal(cut.status, 200);
    assert.deepEqual(cut.body.entries, []);
    assert.ok(cut.body.nextBefore > 0, 'the page still moves back');
    const behind = await get(fx, { before: cut.body.nextBefore });
    assert.deepEqual(behind.body.entries.map((e) => e.text), ['first']);
    fs.appendFileSync(fx.file, `${line.slice(1_400_000)}\n`);
    const all = await readAll(fx, 50);
    assert.deepEqual(all.entries.map((e) => e.text.slice(0, 5)), ['first', 'xxxxx']);
  });

  test('(+) a long line without its newline is read again by every request; once the newline is there, the page is cached', async () => {
    const fx = setup([say('first', 1)]);
    fs.appendFileSync(fx.file, JSON.stringify(say('y'.repeat(1_500_000), 2))); // complete JSON, no newline yet
    const a = await traced(async () => { assert.deepEqual((await get(fx)).body.entries.map((e) => e.kind), ['text']); });
    const b = await traced(async () => { assert.deepEqual((await get(fx)).body.entries.map((e) => e.kind), ['text']); });
    assert.ok(a.bytes > 1.5 * MIB && b.bytes > 1.5 * MIB, `not cached: ${a.bytes} then ${b.bytes}`);
    fs.appendFileSync(fx.file, '\n');
    await get(fx);
    const c = await traced(async () => { await get(fx); });
    assert.ok(c.bytes <= MIB, `cached once terminated: ${c.bytes}`);
  });

  test('(+) the subagent route reads long lines too', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say('s1', 1), bulky(2_000_000, 2), say('s2', 3)]);
    let before;
    const seen = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const r = await getSub(fx, AG, { before, limit: 1 });
      seen.unshift(...r.body.entries.map((e) => e.kind));
      if (r.body.nextBefore === null) break;
      before = r.body.nextBefore;
    }
    assert.deepEqual(seen, ['text', 'tool_result', 'text']);
  });

  test('(+) a picture on a long line shows up as an image entry with its media and size', async () => {
    const fx = setup([say('a', 1), userWith([pictureOf(3 * MIB)], 2), say('b', 3)]);
    const o = lineOffsets(fx.file);
    const { entries } = await readAll(fx, 1);
    assert.deepEqual(entries.map((e) => e.kind), ['text', 'image', 'text']);
    assert.deepEqual([entries[1].id, entries[1].media, entries[1].size], [`${o[1]}:0`, 'png', 3 * MIB]);
  });
});

describe('readHistory: the long-line cache (0.5.1, C)', () => {
  test('(+) the same page asked twice is read once: the second request reads only its window', async () => {
    const fx = setup([say('a', 1), bulky(3_000_000, 2)]);
    let first;
    let second;
    first = await traced(async () => { await get(fx, { limit: 1 }); });
    second = await traced(async () => { await get(fx, { limit: 1 }); });
    assert.ok(first.bytes > 3 * MIB, `first ${first.bytes}`);
    assert.ok(second.bytes <= MIB, `second ${second.bytes}`);
    assert.deepEqual((await get(fx, { limit: 1 })).body.entries.map((e) => e.kind), ['tool_result']);
  });

  test('(+) a hit returns copies: changing an answer changes neither the cache nor the next answer', async () => {
    const fx = setup([say('a', 1), resultWith([{ type: 'text', text: 'k'.repeat(1_500_000) }, picture('png'), picture('gif')], 2)]);
    const pristine = (await get(fx, { limit: 5 })).body; // a miss: the long line only
    assert.equal(pristine.entries.length, 1);
    const one = await get(fx, { limit: 5 }); // a hit
    assert.deepEqual(one.body, pristine);
    one.body.entries[0].text = 'changed';
    one.body.entries[0].subagent = 'zzz';
    one.body.entries[0].images[0].ref = 'changed';
    one.body.entries[0].images.pop();
    one.body.entries.push({});
    one.body.nextBefore = 7;
    const two = await get(fx, { limit: 5 });
    assert.deepEqual(two.body, pristine);
    two.body.entries[0].imagesMore = 99;
    assert.deepEqual((await get(fx, { limit: 5 })).body, pristine);
    // the answer of the very first request (a miss) is a copy of what was stored as well
    const fresh = setup([say('a', 1), resultWith([{ type: 'text', text: 'k'.repeat(1_500_000) }, picture('png')], 2)]);
    const first = await get(fresh, { limit: 5 });
    const want = JSON.parse(JSON.stringify(first.body));
    first.body.entries[0].images[0].media = 'changed';
    first.body.entries[0].text = 'changed';
    assert.deepEqual((await get(fresh, { limit: 5 })).body, want);
  });

  test('(+) an Agent call on a long line keeps its subagent link on a cached request, and the cache holds no link', async () => {
    const calls = assistant([{ type: 'text', text: 'k'.repeat(1_500_000) }, call('Agent')], 2);
    const fx = setup([say('first', 1), calls, say('last', 3)]);
    const d = addSub(fx, AG, [say('x', 1)]);
    const link = async () => (await readAll(fx, 1)).entries.find((e) => e.kind === 'tool_use')?.subagent;
    assert.equal(await link(), AG, 'first request');
    assert.equal(await link(), AG, 'second request, served from the cache');
    fs.rmSync(path.join(d, 'agent-' + AG + '.meta.json'));
    assert.equal(await link(), undefined, 'the cache kept no link of its own');
  });

  test('(−) a different before is a different page, and growth at the end does not change an earlier one', async () => {
    const fx = setup([say('a', 1), bulky(1_500_000, 2), say('b', 3), bulky(1_500_000, 4)]);
    const o = lineOffsets(fx.file);
    const size = fs.statSync(fx.file).size;
    const first = await get(fx, { before: o[2] });
    const second = await get(fx, { before: size });
    assert.deepEqual(first.body.entries.map((e) => e.id), [`${o[1]}:0`]);
    assert.deepEqual(second.body.entries.map((e) => e.id), [`${o[3]}:0`]);
    assert.deepEqual([first.body.nextBefore, second.body.nextBefore], [o[1], o[3]]);
    fs.appendFileSync(fx.file, `${JSON.stringify(say('c', 5))}\n`);
    assert.deepEqual((await get(fx, { before: o[2] })).body, first.body);
    assert.deepEqual((await get(fx, { before: size })).body, second.body);
    assert.deepEqual((await get(fx)).body.entries.map((e) => e.text), ['c']);
  });

  test('(−) two files whose long lines end at the same offset are two pages: the cache is keyed by file too', async () => {
    const mk = (ch) => setup([say('a', 1), resultWith([{ type: 'text', text: ch.repeat(1_500_000) }], 2)]);
    const [x, y] = [mk('x'), mk('y')];
    assert.equal(fs.statSync(x.file).size, fs.statSync(y.file).size);
    const one = await get(x);
    const two = await get(y);
    assert.equal(one.body.entries[0].text.slice(0, 3), 'xxx');
    assert.equal(two.body.entries[0].text.slice(0, 3), 'yyy');
    assert.equal((await get(x)).body.entries[0].text.slice(0, 3), 'xxx');
  });

  test('(+) it holds 16 pages: the 17th evicts the oldest, the newest are still cached', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => bulky(MIB + 100, i % 60));
    const fx = setup(lines);
    const o = lineOffsets(fx.file);
    const ends = [...o.slice(1), fs.statSync(fx.file).size];
    const page = (k) => get(fx, { before: ends[k], limit: 1 });
    for (let k = 0; k < 18; k += 1) await page(k); // 18 distinct long-line pages, the first two get pushed out
    const old = await traced(async () => { await page(0); });
    const recent = await traced(async () => { await page(17); });
    assert.ok(old.bytes > 2 * MIB, `page 0 was evicted and is read again: ${old.bytes}`);
    assert.ok(recent.bytes <= MIB, `page 17 is still cached: ${recent.bytes}`);
    const kept = await traced(async () => { await page(5); });
    assert.ok(kept.bytes <= MIB, `page 5 is still cached: ${kept.bytes}`);
  });
});

describe('readHistory: bounds on long reads (0.5.1, C)', () => {
  test('(+) long reads run one at a time across requests; the first window reads still run in parallel', async () => {
    const files = Array.from({ length: 4 }, () => setup([say('a', 1), bulky(1_300_000, 2)]));
    const stat = await traced(async () => {
      await Promise.all(files.map((fx) => get(fx, { limit: 1 })));
    }, { delayMs: 15 });
    assert.equal(stat.peakLong, 1, 'one long read at a time');
    assert.ok(stat.peakOpen <= 4);
  });

  test('(+) 16 concurrent requests on long lines all complete with the same answer, with at most 4 files open', async () => {
    const fx = setup([say('a', 1), bulky(2_000_000, 2), say('b', 3)]);
    const o = lineOffsets(fx.file);
    let rs;
    const stat = await traced(async () => {
      rs = await Promise.all(Array.from({ length: 16 }, (_, i) => get(fx, { before: o[2], limit: i % 2 ? 1 : 5 })));
    }, { delayMs: 2 });
    assert.ok(rs.every((r) => r.status === 200));
    assert.ok(stat.peakOpen <= 4, String(stat.peakOpen));
    assert.equal(stat.open, 0, 'every handle was closed');
  });
});

// Round RV, I4: a long line used to give one entry per block, however many (a forged line of 15 MiB made 925,214 entries and a 740 MiB process).
// Now a long-line page keeps the LAST 500 entries of the line and says so with `cut: true`; a page that was cut, or whose entry text is over 1 MiB, is not cached.
describe('readHistory: very many blocks on one long line (0.5.1, round RV, I4)', () => {
  const CAP = 500;
  /** An assistant line of `n` text blocks `b0` ... `b<n-1>`; with `big`, block 0 is a 1.2 MB text instead (so the line is long whatever `n` is). */
  const crowd = (n, { big = false, text = (i) => `b${i}` } = {}) => assistant(
    Array.from({ length: n }, (_, i) => ({ type: 'text', text: big && i === 0 ? 'z'.repeat(1_200_000) : text(i) })), 3);
  const reread = async (fx) => (await traced(async () => { await get(fx); })).bytes;

  test('(−) a line of 100k small blocks gives at most 500 entries, the last 500, marked cut, and quickly', async () => {
    const fx = setup([say('first', 1), crowd(100_000), say('last', 4)]);
    const o = lineOffsets(fx.file);
    assert.ok(o[2] - o[1] > 2 * MIB, 'the line is longer than a window');
    const t0 = performance.now();
    const r = await get(fx, { before: o[2] });
    const ms = performance.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.body.entries.length, CAP);
    assert.deepEqual(r.body.entries.map((e) => e.text).slice(0, 2).concat(r.body.entries.at(-1).text), ['b99500', 'b99501', 'b99999']);
    assert.equal(r.body.entries[0].id, `${o[1]}:99500`);
    assert.equal(r.body.entries.at(-1).id, `${o[1]}:99999`);
    assert.equal(r.body.cut, true);
    assert.equal(r.body.nextBefore, o[1], 'the next page is what comes before the line');
    assert.ok(ms < 5000, `${ms} ms`);
    assert.deepEqual(texts(await get(fx, { before: r.body.nextBefore })), ['first']);
  });

  test('(−) a page that was cut is not cached: every request reads the line again', async () => {
    const fx = setup([say('first', 1), crowd(100_000)]);
    const a = await reread(fx);
    const b = await reread(fx);
    assert.ok(a > 2 * MIB && b > 2 * MIB, `read ${a} then ${b} bytes`);
  });

  test('(−) a page whose entry text is over 1 MiB is not cached either, though it is under the entry cap', async () => {
    const fx = setup([say('first', 1), crowd(40, { text: () => 'y'.repeat(32_768) })]); // 40 entries of 32 KiB: 1.25 MiB of text in a 1.25 MiB line
    const r = await get(fx);
    assert.equal(r.body.entries.length, 40);
    assert.equal(r.body.cut, undefined, 'not cut');
    const a = await reread(fx);
    const b = await reread(fx);
    assert.ok(a > MIB && b > MIB, `read ${a} then ${b} bytes`);
  });

  test('(+) a long line under both limits is as before: all its entries, no `cut`, cached', async () => {
    const fx = setup([say('first', 1), crowd(CAP, { big: true })]); // exactly 500 entries; the first one is the 1.2 MB text, cut to 32 KB
    const o = lineOffsets(fx.file);
    const r = await get(fx);
    assert.equal(r.body.entries.length, CAP);
    assert.deepEqual([r.body.entries[0].id, r.body.entries[0].text.length, r.body.entries[0].truncated], [`${o[1]}:0`, 32768, true]);
    assert.deepEqual(Object.keys(r.body), ['entries', 'nextBefore'], 'the answer has its old shape');
    assert.equal(await reread(fx) <= MIB, true, 'the second request is a cache hit');
    assert.deepEqual((await get(fx)).body, r.body);
  });

  test('(+) the text limit is 1 MiB of entry text: exactly 1 MiB is cached, one character more is not', async () => {
    const chars = () => (i) => 'y'.repeat(i < 32 ? 32_768 : 1);
    const at = setup([say('first', 1), crowd(32, { text: chars() })]); // 32 x 32768 = 1,048,576
    assert.equal((await get(at)).body.entries.reduce((n, e) => n + e.text.length, 0), MIB);
    assert.ok(await reread(at) <= MIB, 'exactly at the limit: remembered');
    const over = setup([say('first', 1), crowd(33, { text: chars() })]); // the same and one more entry of one character
    assert.equal((await get(over)).body.entries.reduce((n, e) => n + e.text.length, 0), MIB + 1);
    assert.ok(await reread(over) > MIB, 'one character over the limit: read again');
    assert.ok(await reread(over) > MIB, 'and again');
  });

  test('(−) one entry more than the cap is cut: block 0 goes, 500 stay, and the page is not cached', async () => {
    const fx = setup([say('first', 1), crowd(CAP + 1, { big: true })]);
    const o = lineOffsets(fx.file);
    const r = await get(fx);
    assert.equal(r.body.entries.length, CAP);
    assert.equal(r.body.entries[0].id, `${o[1]}:1`);
    assert.equal(r.body.cut, true);
    assert.ok(await reread(fx) > MIB, 'read again');
  });

  test('(+) blocks that show nothing do not count towards the cap: 100k empty blocks and 3 real ones keep 3, not cut, cached', async () => {
    const blocks = [...Array.from({ length: 100_000 }, () => ({ type: 'text', text: '' })), ...['p', 'q', 'r'].map((text) => ({ type: 'text', text }))];
    const fx = setup([say('first', 1), assistant(blocks, 3)]);
    const o = lineOffsets(fx.file);
    const r = await get(fx);
    assert.deepEqual(texts(r), ['p', 'q', 'r']);
    assert.deepEqual(r.body.entries.map((e) => e.id), [100_000, 100_001, 100_002].map((i) => `${o[1]}:${i}`));
    assert.equal(r.body.cut, undefined);
    assert.ok(await reread(fx) <= MIB, 'cached');
  });

  test('(−) 100k blocks that each make an entry of their own kind (pictures with no source) are capped the same way', async () => {
    const fx = setup([assistant(Array.from({ length: 100_000 }, () => ({ type: 'image' })), 3)]);
    const r = await get(fx);
    assert.equal(r.body.entries.length, CAP);
    assert.equal(r.body.cut, true);
    assert.equal(r.body.nextBefore, null, 'the line starts the file');
  });

  test('(+) the subagent route caps and marks a long line the same way', async () => {
    const fx = setup([say('p', 1)]);
    addSub(fx, AG, [say('s1', 1), crowd(2_000, { big: true })]); // long because of block 0, many blocks after it
    const r = await getSub(fx, AG, {});
    assert.equal(r.body.entries.length, CAP);
    assert.equal(r.body.cut, true);
    assert.equal(r.body.entries.at(-1).text, 'b1999');
  });

  test('(+) a window with several short lines is not capped or marked, even with more than 500 entries', async () => {
    const fx = setup(Array.from({ length: 700 }, (_, i) => say(`m${i}`, i % 50)));
    const r = await get(fx, { limit: 200 });
    assert.ok(r.body.entries.length >= 200);
    assert.equal(r.body.cut, undefined);
    const all = await readAll(fx, 200);
    assert.equal(all.entries.length, 700);
  });
});

describe('readImage (0.5.1, C)', () => {
  const refsOf = async (fx, agent = null) => {
    const q = { limit: 200 };
    const body = (agent === null ? await get(fx, q) : await getSub(fx, agent, q)).body;
    return body.entries;
  };
  const view = (fx, ref, agent = null, session = A, deps = {}) => readImage(session, agent, ref, { claudeDir: fx.claudeDir, ...deps });
  const only = (r) => {
    assert.deepEqual(Object.keys(r.body).sort(), ['error', 'message']);
    return [r.status, r.body.error, r.body.message];
  };

  test('(+) a top-level image: the ref of its entry gives the type and the canonical base64 of its bytes', async () => {
    const fx = setup([say('a', 1), userWith([{ type: 'text', text: 't' }, picture('png')], 2), assistant([picture('webp')], 3)]);
    const o = lineOffsets(fx.file);
    const r = await view(fx, `${o[1]}:1`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['type', 'data']);
    assert.deepEqual(r.body, { type: 'png', data: HEADS.png.toString('base64') });
    assert.deepEqual((await view(fx, `${o[2]}:0`)).body, { type: 'webp', data: HEADS.webp.toString('base64') });
    const ids = (await refsOf(fx)).filter((e) => e.kind === 'image').map((e) => e.id);
    assert.deepEqual(ids, [`${o[1]}:1`, `${o[2]}:0`], 'the entry ids are the refs');
  });

  test('(+) all four types, and the first line of the file (offset 0)', async () => {
    const fx = setup([userWith([picture('png'), picture('jpeg'), picture('gif'), picture('webp')], 1)]);
    for (const [i, media] of ['png', 'jpeg', 'gif', 'webp'].entries()) {
      const r = await view(fx, `0:${i}`);
      assert.deepEqual(r.body, { type: media, data: HEADS[media].toString('base64') }, media);
    }
  });

  test('(+) a part of a tool result: the ref of images[n] gives its bytes', async () => {
    const fx = setup([say('a', 1), resultWith([{ type: 'text', text: 's' }, picture('jpeg'), picture('gif')], 2)]);
    const [, e] = await refsOf(fx);
    assert.deepEqual(e.images.map((p) => p.media), ['jpeg', 'gif']);
    assert.deepEqual((await view(fx, e.images[0].ref)).body, { type: 'jpeg', data: HEADS.jpeg.toString('base64') });
    assert.deepEqual((await view(fx, e.images[1].ref)).body, { type: 'gif', data: HEADS.gif.toString('base64') });
  });

  test('(+) the data is re-encoded from the bytes: a base64 string with non-zero spare bits is served in its canonical form', async () => {
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const buf = Buffer.concat([HEADS.png, Buffer.from([9])]); // 13 bytes: "==" padding, and the character before it has 4 spare bits
    const canonical = buf.toString('base64');
    assert.ok(canonical.endsWith('=='));
    const at = canonical.length - 3;
    const tweaked = `${canonical.slice(0, at)}${ABC[ABC.indexOf(canonical[at]) ^ 1]}==`;
    assert.notEqual(tweaked, canonical);
    assert.ok(Buffer.from(tweaked, 'base64').equals(buf), 'the same bytes under another spelling');
    const fx = setup([userWith([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: tweaked } }], 1)]);
    const r = await view(fx, '0:0');
    assert.equal(r.status, 200);
    assert.equal(r.body.data, canonical);
  });

  test('(+) the subagent transcript: the agent id picks the file, and the same offset in the session file is another line', async () => {
    const fx = setup([say('p', 1), userWith([picture('gif')], 2)]);
    addSub(fx, AG, [say('s', 1), userWith([picture('jpeg')], 2)]);
    const [, sub] = await refsOf(fx, AG);
    assert.deepEqual((await view(fx, sub.id, AG)).body, { type: 'jpeg', data: HEADS.jpeg.toString('base64') });
    const o = lineOffsets(fx.file);
    assert.deepEqual((await view(fx, `${o[1]}:0`)).body.type, 'gif');
  });

  test('(+) a picture on a long line (bigger than the window)', async () => {
    const big = pictureOf(3 * MIB, 'png');
    const fx = setup([say('a', 1), userWith([big], 2), say('b', 3)]);
    const o = lineOffsets(fx.file);
    const r = await view(fx, `${o[1]}:0`);
    assert.equal(r.status, 200);
    assert.equal(r.body.data, big.source.data);
  });

  test('(+) a picture on the last line, which has no newline yet', async () => {
    const first = JSON.stringify(say('a', 1));
    const fx = setup('');
    fs.writeFileSync(fx.file, `${first}\n${JSON.stringify(userWith([picture('jpeg')], 2))}`);
    const r = await view(fx, `${Buffer.byteLength(first) + 1}:0`);
    assert.deepEqual(r.body, { type: 'jpeg', data: HEADS.jpeg.toString('base64') });
  });

  test('(+) the largest picture: exactly 8 MiB decoded', async () => {
    const fx = setup([userWith([pictureOf(8 * MIB)], 1)]);
    const r = await view(fx, '0:0');
    assert.equal(r.status, 200);
    assert.equal(Buffer.from(r.body.data, 'base64').length, 8 * MIB);
  });

  test('(−) the order of checks: session id, agent id, ref, then the index; none of the first three touches the index', async () => {
    const fx = setup([userWith([picture('png')], 1)]);
    const cache = {};
    assert.deepEqual(only(await view(fx, '0:0', null, 'not-a-uuid', { cache })), [404, 'not_found', 'no such session']);
    assert.deepEqual(only(await view(fx, '0:0', 'bad/id', A, { cache })), [404, 'not_found', 'no such subagent']);
    assert.deepEqual(only(await view(fx, '0:0', '', A, { cache })), [404, 'not_found', 'no such subagent']);
    assert.deepEqual(only(await readImage(A, undefined, '0:0', { claudeDir: fx.claudeDir, cache })), [404, 'not_found', 'no such subagent']);
    assert.deepEqual(only(await view(fx, 'zz', null, A, { cache })), [404, 'not_found', 'no such image']);
    assert.deepEqual(only(await view(fx, 'zz', null, 5, { cache })), [404, 'not_found', 'no such session']);
    assert.equal(cache.historyIndex, undefined, 'no id check reached the transcript index');
    assert.deepEqual(only(await view(fx, '0:0', null, B, { cache })), [404, 'not_found', 'no such session']);
    assert.equal(typeof cache.historyIndex, 'object', 'a well-formed request does');
  });

  test('(−) a ref that is not <offset>:<block> or <offset>:<block>.<part> is 404 before any file is opened', async () => {
    const fx = setup([userWith([picture('png')], 1)]);
    const stat = await traced(async () => {
      for (const ref of ['', ':', '0', '0:', ':0', '0:0.', '0:0.a', '0:0.1.2', '-1:0', '0:-1', ' 0:0', '0:0 ', '1234567890123456:0', '0:123456', '0:0.1000', null, undefined, 5, {}, ['0:0'], '0%3A0', '../0:0']) {
        assert.deepEqual(only(await view(fx, ref)), [404, 'not_found', 'no such image'], JSON.stringify(ref));
      }
    });
    assert.equal(stat.opened, 0);
  });

  test('(−) the session or the agent is not there: 404 with its own words', async () => {
    const fx = setup([userWith([picture('png')], 1)]);
    assert.deepEqual(only(await view(fx, '0:0', null, B)), [404, 'not_found', 'no such session']);
    assert.deepEqual(only(await view(fx, '0:0', AG)), [404, 'not_found', 'no such subagent']);
    addSub(fx, AG, [userWith([picture('png')], 1)]);
    assert.equal((await view(fx, '0:0', AG)).status, 200);
    assert.deepEqual(only(await view(fx, '0:0', 'a0000000000000002')), [404, 'not_found', 'no such subagent']);
    fs.writeFileSync(path.join(fx.dir, `${B}.jsonl`), `${JSON.stringify(userWith([picture('png')], 1))}\n`);
    assert.equal((await view(fx, '0:0', null, B)).status, 200, 'the other session is there');
    assert.deepEqual(only(await view(fx, '0:0', AG, B)), [404, 'not_found', 'no such subagent'], 'the agent belongs to the first session');
  });

  test('(−) an offset past the end, at the end, in the middle of a line, or not a line start is 404', async () => {
    const fx = setup([say('a', 1), userWith([picture('png')], 2), say('b', 3)]);
    const o = lineOffsets(fx.file);
    const size = fs.statSync(fx.file).size;
    for (const off of [size, size + 1, 99999999, o[1] + 1, o[1] + 5, o[1] - 1, 1]) {
      assert.deepEqual(only(await view(fx, `${off}:0`)), [404, 'not_found', 'no such image'], String(off));
    }
    assert.equal((await view(fx, `${o[1]}:0`)).status, 200);
  });

  test('(−) an offset in the middle of a line is 404 even when the rest of the line is a good picture line', async () => {
    const junk = 'x ';
    const fx = setup([say('a', 1)]);
    fs.appendFileSync(fx.file, `${junk}${JSON.stringify(userWith([picture('png')], 2))}\n`);
    const o = lineOffsets(fx.file);
    for (const cut of [1, 2]) assert.deepEqual(only(await view(fx, `${o[1] + cut}:0`)), [404, 'not_found', 'no such image'], `after ${JSON.stringify(junk.slice(0, cut))}`);
    assert.deepEqual(only(await view(fx, `${o[1]}:0`)), [404, 'not_found', 'no such image'], 'and the whole line is not JSON either');
  });

  test('(−) a line that is not an image: not JSON, not user/assistant, no message, content not an array, no such block', async () => {
    const lines = [
      '{not json',
      JSON.stringify({ type: 'summary', message: { content: [picture('png')] } }),
      JSON.stringify({ type: 'user' }),
      JSON.stringify({ type: 'user', message: null }),
      JSON.stringify({ type: 'user', message: 'x' }),
      JSON.stringify({ type: 'user', message: { content: 'text' } }),
      JSON.stringify({ type: 'user', message: { content: { 0: picture('png') } } }),
      JSON.stringify(userWith([{ type: 'text', text: 'x' }, picture('png')], 1)),
      JSON.stringify(userWith([picture('png')], 1)),
      '[1,2]', '"x"', 'null',
    ];
    const fx = setup(lines);
    const o = lineOffsets(fx.file);
    for (const [i, off] of o.entries()) {
      if (i === 8) continue; // the one good line
      assert.deepEqual(only(await view(fx, `${off}:0`)), [404, 'not_found', 'no such image'], `line ${i}`);
    }
    assert.deepEqual(only(await view(fx, `${o[8]}:1`)), [404, 'not_found', 'no such image'], 'block 1 of a one-block line');
    assert.deepEqual(only(await view(fx, `${o[8]}:99999`)), [404, 'not_found', 'no such image']);
    assert.equal((await view(fx, `${o[7]}:1`)).status, 200);
    assert.equal((await view(fx, `${o[8]}:0`)).status, 200);
  });

  test('(−) a block or part that is not an image: text, tool_use, a tool result addressed without its part, a part that is text', async () => {
    const fx = setup([
      userWith([{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'x', name: 'N', input: {} }, picture('png'), { type: 'tool_result', content: [{ type: 'text', text: 'a' }, picture('png')] },
        { type: 'tool_result', content: 'plain' }, { type: 'tool_result', content: { 0: picture('png') } }, null, 7,
        { type: 'text', text: 'x', content: [picture('png')] }, { type: 'tool_use', id: 'k', name: 'N', input: {}, content: [picture('png')] }], 1),
    ]);
    const no = async (ref) => assert.deepEqual(only(await view(fx, ref)), [404, 'not_found', 'no such image'], ref);
    await no('0:0'); // text
    await no('0:1'); // tool_use
    await no('0:2.0'); // a part index on an image block
    await no('0:3'); // the tool result itself, no part
    await no('0:3.0'); // a text part
    await no('0:3.2'); // no such part
    await no('0:4.0'); // content is a string
    await no('0:5.0'); // content is an object
    await no('0:6'); // null block
    await no('0:6.0');
    await no('0:7');
    await no('0:8');
    await no('0:9.0'); // a text block that has a content array of pictures
    await no('0:10.0'); // so has a tool_use block
    assert.equal((await view(fx, '0:2')).status, 200);
    assert.equal((await view(fx, '0:3.1')).status, 200);
  });

  test('(−) 415: SVG, a source that is not base64, malformed base64, bytes that are not the declared type', async () => {
    const good = HEADS.png.toString('base64');
    const blocks = [
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64') } },
      { type: 'image', source: { type: 'url', media_type: 'image/png', url: 'https://example.invalid/x.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `${good.slice(0, 8)}!${good.slice(9)}` } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: `${good}A` } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: good } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: HEADS.jpeg.toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 5 } },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif' } },
      { type: 'image' },
    ];
    const fx = setup([userWith(blocks, 1)]);
    for (const [i] of blocks.entries()) {
      const r = await view(fx, `0:${i}`);
      assert.deepEqual(only(r), [415, 'not-image', 'not a supported image'], `block ${i}`);
    }
  });

  test('(−) 413: base64 over 11 184 812 characters, decoded over 8 MiB, and a line over 16 MiB', async () => {
    const over = (n) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(n) } });
    const fx = setup([userWith([over(11184812 + 4)], 1), userWith([over(11184812)], 2)]);
    const o = lineOffsets(fx.file);
    assert.deepEqual(only(await view(fx, `${o[0]}:0`)), [413, 'too-large', 'image too large']);
    assert.deepEqual(only(await view(fx, `${o[1]}:0`)), [413, 'too-large', 'image too large'], '8 MiB + 1 decoded');
    const huge = setup([say('a', 1), bulkyLine(16 * MIB + 1), userWith([picture('png')], 2)]);
    const oh = lineOffsets(huge.file);
    assert.deepEqual(only(await view(huge, `${oh[1]}:0`)), [413, 'too-large', 'image too large'], 'LINE_MAX + 1 bytes');
    assert.equal((await view(huge, `${oh[2]}:0`)).status, 200, 'the line after it is fine');
    const exact = setup([say('a', 1), bulkyLine(16 * MIB)]);
    const oe = lineOffsets(exact.file);
    assert.deepEqual(only(await view(exact, `${oe[1]}:0`)), [404, 'not_found', 'no such image'], 'exactly LINE_MAX is read, and is not an image');
  });

  test('(−) a transcript that is a symlink or a hard link, or vanished after indexing, is 404 and leaks nothing', async () => {
    const fx = setup([userWith([picture('png')], 1)]);
    const real = path.join(fx.dir, 'real.jsonl');
    fs.renameSync(fx.file, real);
    fs.symlinkSync(real, fx.file);
    assert.deepEqual(only(await view(fx, '0:0')), [404, 'not_found', 'no such session']);
    fs.rmSync(fx.file);
    fs.linkSync(real, fx.file);
    assert.equal((await view(fx, '0:0')).status, 404);
    fs.rmSync(real);
    fs.rmSync(fx.file);
    fs.writeFileSync(fx.file, `${JSON.stringify(userWith([picture('png')], 1))}\n`);
    const cache = {};
    assert.equal((await view(fx, '0:0', null, A, { cache })).status, 200);
    fs.rmSync(fx.file);
    assert.deepEqual(only(await view(fx, '0:0', null, A, { cache })), [404, 'not_found', 'no such image'], 'indexed, then gone');
  });

  test('(−) every handle is closed on every path', async () => {
    const fx = setup([say('a', 1), userWith([picture('png'), { type: 'text', text: 'x' }, pictureOf(20, 'png')], 2), bulkyLine(2 * MIB)]);
    const o = lineOffsets(fx.file);
    const stat = await traced(async () => {
      await view(fx, `${o[1]}:0`);
      await view(fx, `${o[1]}:1`);
      await view(fx, `${o[1] + 3}:0`);
      await view(fx, `${o[2]}:0`);
      await view(fx, '99999999:0');
      await view(fx, '0:0');
    });
    assert.ok(stat.opened >= 5);
    assert.equal(stat.open, 0);
  });

  test('(+) image reads share the limiter: 16 concurrent reads complete, at most 4 files open, one long read at a time', async () => {
    const fx = setup([say('a', 1), userWith([pictureOf(2 * MIB)], 2), say('b', 3)]);
    const o = lineOffsets(fx.file);
    let rs;
    const stat = await traced(async () => {
      rs = await Promise.all(Array.from({ length: 16 }, () => view(fx, `${o[1]}:0`)));
    }, { delayMs: 3 });
    assert.ok(rs.every((r) => r.status === 200 && r.body.data.length > 2 * MIB));
    assert.ok(stat.peakOpen <= 4, String(stat.peakOpen));
    assert.equal(stat.peakLong, 1);
    assert.equal(stat.open, 0);
  });

  test('(+) image reads take a slot of the same four as history reads: 6 history reads and 2 image reads never hold more than 4 files open', async () => {
    const fx = setup(Array.from({ length: 40 }, (_, i) => (i === 20 ? userWith([picture('png')], 2) : say(`m${i}`, i % 60))));
    const o = lineOffsets(fx.file);
    const stat = await traced(async () => {
      await Promise.all([...Array.from({ length: 6 }, () => get(fx, { limit: 5 })), view(fx, `${o[20]}:0`), view(fx, `${o[20]}:0`)]);
    }, { delayMs: 25 });
    assert.equal(stat.opened, 8);
    assert.equal(stat.peakOpen, 4);
  });

  test('(+) an image read and a long history read exclude each other', async () => {
    const fx = setup([say('a', 1), userWith([pictureOf(2 * MIB)], 2), bulky(1_300_000, 3)]);
    const o = lineOffsets(fx.file);
    const stat = await traced(async () => {
      await Promise.all([view(fx, `${o[1]}:0`), get(fx, { limit: 1 }), view(fx, `${o[1]}:0`), get(fx, { limit: 1 })]);
    }, { delayMs: 8 });
    assert.equal(stat.peakLong, 1);
  });
});

// ---- 0.5.4 SF, item 7 (RV051 M2): one order for the read slots: image gate -> limited -> longLimited ---------------------------------------------------
// The slots are module-level in history.js, so a run that deadlocks them stays deadlocked for the rest of this file: every wait below has a time limit
// (it fails the test instead of hanging the run), and this describe is the last one of the file.

describe('readImage: the slots and their one order (0.5.4 SF, item 7)', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** `p`, or a rejection after `ms`: a test that would wait for ever fails instead. */
  const within = async (p, ms, what) => {
    let timer;
    try {
      return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** Polls `cond` every millisecond and throws after `ms`: a poll that never ends would keep the process alive after `within` has failed the test, and the run would hang. */
  const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`until: still false after ${ms} ms`); await sleep(1); } };
  const view = (fx, ref, agent = null) => readImage(A, agent, ref, { claudeDir: fx.claudeDir });
  /** Makes every read of a transcript whose path holds one of `parts` wait until release(); `reached[part]` counts the reads that got that far. */
  function holdReads(...parts) {
    const realOpen = fsp.open;
    let release;
    const gate = new Promise((r) => { release = r; });
    const hold = { reached: Object.fromEntries(parts.map((x) => [x, 0])), release, restore: () => { fsp.open = realOpen; } };
    fsp.open = async (file, ...rest) => {
      const h = await realOpen.call(fsp, file, ...rest);
      const part = parts.find((x) => String(file).includes(x));
      if (!part) return h;
      const realRead = h.read.bind(h);
      h.read = async (...a) => { hold.reached[part] += 1; await gate; return realRead(...a); };
      return h;
    };
    return hold;
  }

  test('(+) four queued picture reads do not delay a history page read: it runs while the pictures wait, and at most one picture read holds a limited slot', async () => {
    const AG3 = 'a0000000000000003';
    const fx = setup([say('a', 1), say('b', 2), say('c', 3)]);
    addSub(fx, AG, [userWith([picture('png')], 1)]); // the pictures are read from this subagent's transcript, the page from the session's
    addSub(fx, AG3, [say('s', 1)]); // two history page reads of this one are parked, each holding a limited slot: two of the four are left
    const hold = holdReads(AG, AG3);
    const done = [];
    let others = [];
    try {
      others = [getSub(fx, AG3, { limit: 5 }), getSub(fx, AG3, { limit: 5 })];
      others.push(...Array.from({ length: 4 }, () => view(fx, '0:0', AG).then((r) => { done.push(r.status); return r; })));
      await within(until(() => hold.reached[AG] >= 1 && hold.reached[AG3] >= 2), 2000, 'the first picture read and the two parked page reads');
      // 2 parked page reads + 1 picture read hold three slots, the other three pictures wait at the gate: one slot is left for this page read.
      // With a picture read in each of the other two, or the gate behind `limited`, there would be none
      const page = await within(get(fx, { limit: 5 }), 1000, 'a history page read queued behind four picture reads');
      assert.equal(page.status, 200);
      assert.deepEqual(done, [], 'no picture read had finished when the page read did');
    } finally {
      hold.release();
      hold.restore();
      await Promise.all(others);
    }
    assert.deepEqual(done, [200, 200, 200, 200], 'and every picture read completes once it is let go');
  });

  test('(+) the probe shape of the review (2 picture reads and 4 page reads that need the long slot) finishes', async () => {
    const fx = setup([say('a', 1), userWith([pictureOf(2 * MIB)], 2), bulky(1_300_000, 3)]); // the last line is too long for the window: its page takes the long slot
    const o = lineOffsets(fx.file);
    const jobs = [view(fx, `${o[1]}:0`), get(fx, { limit: 1 }), get(fx, { limit: 1 }), get(fx, { limit: 1 }), get(fx, { limit: 1 }), view(fx, `${o[1]}:0`)];
    const rs = await within(Promise.all(jobs), 8000, 'the probe shape (a slot deadlock)');
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  });

  test('(+) the probe shape, held at the worst moment: four page reads hold every limited slot and need the long slot, then two picture reads arrive; once the page reads are let go all of them finish', async () => {
    const fx = setup([say('a', 1), bulky(1_300_000, 2)]); // the last line is too long for the window: each page read takes the long slot
    addSub(fx, AG, [userWith([picture('png')], 1)]);
    const mine = path.basename(fx.file);
    const hold = holdReads(mine);
    let all = [];
    try {
      const pages = Array.from({ length: 4 }, () => get(fx, { limit: 1 }));
      await within(until(() => hold.reached[mine] >= 4), 2000, 'the four page reads');
      const images = [view(fx, '0:0', AG), view(fx, '0:0', AG)];
      await sleep(25); // the picture reads go as far as they can: with the long slot taken first, one of them would now hold it and wait for a limited slot
      hold.release();
      all = [...pages, ...images];
      const rs = await within(Promise.all(all), 5000, 'the page reads and the picture reads (a slot deadlock)');
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
    } finally {
      hold.release();
      hold.restore();
    }
  });

  test('(\u2212) picture reads still run one after another and still respect the long slot: never two long reads at once, with page reads in between', async () => {
    const fx = setup([say('a', 1), userWith([pictureOf(2 * MIB)], 2), bulky(1_300_000, 3)]);
    const o = lineOffsets(fx.file);
    let rs;
    const alone = await traced(async () => {
      rs = await within(Promise.all(Array.from({ length: 6 }, () => view(fx, `${o[1]}:0`))), 8000, 'six picture reads');
    }, { delayMs: 3 });
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(alone.peakOpen, 1, 'one picture read at a time');
    let mixed;
    const stat = await traced(async () => {
      mixed = await within(Promise.all([...Array.from({ length: 6 }, () => view(fx, `${o[1]}:0`)), get(fx, { limit: 1 }), get(fx, { limit: 1 }), get(fx, { limit: 1 })]), 8000, 'six picture reads and three long page reads');
    }, { delayMs: 3 });
    assert.ok(mixed.every((r) => r.status === 200));
    assert.equal(stat.peakLong, 1, 'one long read at a time');
    assert.equal(stat.open, 0, 'every handle is closed');
  });
});
