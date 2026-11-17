import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readHistory, readSubagentHistory, createLimiter } from '../src/collect/history.js';

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
