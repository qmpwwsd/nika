// 0.3.4 app memory: what grew without a bound is capped now. lru(), the transcript cache, the command-list cache, and the
// session window's transcript column (public/session.js runs for real in a vm against stubs). Synthetic fixtures only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { lru } from '../src/util.js';
import { createTranscriptCache, readTranscript } from '../src/collect/transcripts.js';
import { collect } from '../src/model.js';
import { listCommands } from '../src/collect/commands.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-memory-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('lru(max)', () => {
  test('(+) set evicts the oldest entry once past max, and size never exceeds max', () => {
    const m = lru(3);
    for (let i = 0; i < 10; i += 1) m.set(`k${i}`, i);
    assert.equal(m.size, 3);
    assert.deepEqual([...m.keys()], ['k7', 'k8', 'k9']);
    assert.equal(m.get('k0'), undefined);
  });

  test('(+) get refreshes recency: the entry read last is the one that survives', () => {
    const m = lru(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    assert.equal(m.get('a'), 1); // a is now the newest; b is the oldest
    m.set('d', 4);
    assert.deepEqual([...m.keys()], ['c', 'a', 'd']);
    assert.equal(m.get('b'), undefined);
  });

  test('(+) setting an existing key replaces its value, refreshes it and does not grow the map', () => {
    const m = lru(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 10);
    assert.equal(m.size, 2);
    m.set('c', 3);
    assert.deepEqual([...m.entries()], [['a', 10], ['c', 3]]);
  });

  test('(+) resize shrinks at once (oldest first) and grows without losing entries', () => {
    const m = lru(5);
    for (const k of 'abcde') m.set(k, k);
    m.resize(2);
    assert.deepEqual([...m.keys()], ['d', 'e']);
    m.resize(4);
    m.set('x', 1);
    assert.equal(m.size, 3);
  });

  test('(−) has() and a miss do not refresh recency or add entries', () => {
    const m = lru(2);
    m.set('a', 1);
    m.set('b', 2);
    assert.equal(m.has('a'), true);
    assert.equal(m.get('zzz'), undefined);
    m.set('c', 3);
    assert.deepEqual([...m.keys()], ['b', 'c'], 'a was only peeked at, so it was still the oldest');
  });

  test('(−) a max below 1, NaN or not a number is clamped to 1 (the map keeps the newest entry), never unbounded', () => {
    for (const bad of [0, -5, NaN, undefined, 'x', null, 0.4]) {
      const m = lru(bad);
      m.set('a', 1);
      m.set('b', 2);
      assert.equal(m.size, 1, String(bad));
      assert.equal(m.get('b'), 2, String(bad));
    }
    const m = lru(3.9);
    for (const k of 'abcde') m.set(k, k);
    assert.equal(m.size, 3, 'a fraction is floored');
  });
});

describe('transcript cache', () => {
  const claudeDir = path.join(root, 'claude');
  const mkTranscript = (n) => {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const dir = path.join(claudeDir, 'projects', '-synthetic-proj');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: '/synthetic/proj', timestamp: new Date().toISOString(), message: { role: 'user', content: `hello ${n}` } })}\n`);
    return file;
  };
  const stat = (file) => {
    const st = fs.statSync(file);
    return { path: file, mtimeMs: st.mtimeMs, size: st.size };
  };
  const run = (cache) => collect({
    config: { claudeDir, tmpRoot: path.join(root, 'tmp'), reportDirs: [], tmuxBin: '/nonexistent/tmux' }, // no env: no project registry, nothing outside this folder is read
    exec: async () => { throw Object.assign(new Error('no exec in this test'), { code: 'ENOENT' }); },
    now: Date.now(), sinceMs: Infinity, since: 'all', cache,
  });

  test('(+) createTranscriptCache gives a bounded map: cap + N inserts leave it at the cap', async () => {
    const file = mkTranscript(1);
    const cache = createTranscriptCache();
    const cap = cache.max;
    assert.ok(Number.isInteger(cap) && cap >= 64, 'a cap exists and is not tiny');
    cache.resize(5);
    for (let i = 0; i < 50; i += 1) cache.set(`/synthetic/${i}.jsonl`, { mtimeMs: 1, size: 1, data: {} });
    assert.equal(cache.size, 5);
    // and readTranscript still hits the cache for a file it has just read
    const a = await readTranscript(stat(file), cache);
    assert.equal(await readTranscript(stat(file), cache), a, 'a hit returns the same object');
  });

  test('(+) collect() keeps the cache at (transcripts on disk + 64): entries of vanished files are dropped, live ones kept', async () => {
    const live = [10, 11, 12].map(mkTranscript);
    const cache = { transcripts: createTranscriptCache() };
    for (let i = 0; i < 400; i += 1) cache.transcripts.set(`/synthetic/gone-${i}.jsonl`, { mtimeMs: 1, size: 1, data: {} }); // sessions cleaned up long ago
    await run(cache);
    const indexed = fs.readdirSync(path.join(claudeDir, 'projects', '-synthetic-proj')).filter((n) => n.endsWith('.jsonl')).length;
    assert.ok(cache.transcripts.size <= indexed + 64, `${cache.transcripts.size} entries for ${indexed} transcripts`);
    for (const f of live) assert.equal(cache.transcripts.has(f), true, `${path.basename(f)} is still cached`);
  });

  test('(−) the cap follows the index: cached transcripts that are still on disk are never evicted early, even beyond 64 of them', async () => {
    const dir = path.join(claudeDir, 'projects', '-synthetic-many');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < 150; i += 1) {
      const id = `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`;
      const file = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: '/synthetic/many', timestamp: new Date().toISOString(), message: { role: 'user', content: 'x' } })}\n`);
      files.push(file);
    }
    const cache = { transcripts: createTranscriptCache() };
    await run(cache);
    for (const f of files) assert.equal(cache.transcripts.has(f), true, path.basename(f));
    const before = cache.transcripts.get(files[0]);
    await run(cache);
    assert.equal(cache.transcripts.get(files[0]), before, 'the second collect re-uses the parsed entry (no re-read)');
  });
});

describe('command-list cache', () => {
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const claudeDir = path.join(root, 'cmd-claude');
  const proj = (i) => path.join(root, 'cmd-projects', `p${i}`);
  const T = 5_000_000_000; // one instant for every call: nothing expires by age here

  test('(+) more distinct projects than the cap evict the oldest listing: it is scanned again, newer ones stay cached', async () => {
    const n = 40;
    for (let i = 0; i < n; i += 1) write(path.join(proj(i), '.claude', 'commands', 'cmd.md'), '---\ndescription: v1\n---\nx\n');
    const first = [];
    for (let i = 0; i < n; i += 1) first.push(await listCommands({ claudeDir, projectDir: proj(i), now: T }));
    for (let i = 0; i < n; i += 1) write(path.join(proj(i), '.claude', 'commands', 'cmd.md'), '---\ndescription: v2\n---\nx\n');
    const desc = (list) => list.find((e) => e.name === '/cmd' || e.name === 'cmd')?.description;
    const oldest = await listCommands({ claudeDir, projectDir: proj(0), now: T });
    const newest = await listCommands({ claudeDir, projectDir: proj(n - 1), now: T });
    assert.equal(desc(first[0]), 'v1');
    assert.equal(desc(oldest), 'v2', 'the oldest key was evicted, so the file is read again');
    assert.equal(desc(newest), 'v1', 'a recent key is still served from the cache');
  });

  test('(−) a listing inside the cap is not evicted early: asking again within 10 s still returns the cached list', async () => {
    const p = proj(900);
    write(path.join(p, '.claude', 'commands', 'cmd.md'), '---\ndescription: v1\n---\nx\n');
    const a = await listCommands({ claudeDir, projectDir: p, now: T + 1 });
    write(path.join(p, '.claude', 'commands', 'cmd.md'), '---\ndescription: v2\n---\nx\n');
    assert.equal(await listCommands({ claudeDir, projectDir: p, now: T + 2 }), a);
  });
});

// ---- the transcript column of the session window ----------------------------------------------------------------------

describe('session window: the transcript column keeps at most 500 entries', () => {
  const SRC = fs.readFileSync(new URL('../public/session.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const constOf = (name) => {
    const at = SRC.indexOf(`const ${name} = `);
    assert.ok(at >= 0, name);
    const eol = SRC.indexOf('\n', at);
    return SRC.slice(at, SRC[eol - 1] === '{' ? SRC.indexOf('\n};', at) + 3 : eol); // one line, or an arrow function with a block body
  };
  const MAX = Number(/const MAX_ENTRIES = (\d+);/.exec(SRC)[1]);
  const STEP = 100; // bytes between two transcript lines in the fake transcript

  /** The page's mount/trim/refreshHistory/loadOlder against a fake DOM and a fake server holding `total` one-entry lines. */
  function rig({ total, shown = MAX, atBottom = true }) {
    const ids = [...Array(total).keys()].map((i) => `${i * STEP}:0`);
    const state = { total, atBottom, fetched: [], list: [] };
    const sc = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400, focus() {} };
    const listEl = {
      prepend(frag) { state.list.unshift(...frag.items); },
      append(frag) { state.list.push(...frag.items); },
      parentNode: { querySelector: () => null },
      before() {},
    };
    const els = new Map([['hx-list', listEl], ['hist-scroll', sc], ['load-older', { setAttribute() {}, removeAttribute() {}, textContent: '' }],
      ['older', {}], ['newer', {}], ['hist-count', {}]]);
    const entry = (id) => ({ id, at: '', role: 'assistant', kind: 'text', text: id, tool: '', truncated: false });
    /** The real server's paging: the newest `limit` lines ending before `before`; nextBefore = offset of the page's first line. */
    const fetchHistory = async (before) => {
      state.fetched.push(before);
      const upto = before === null ? ids.length : ids.findIndex((id) => Number(id.split(':')[0]) >= before);
      const end = upto === -1 ? ids.length : upto;
      const page = ids.slice(Math.max(0, end - 50), end);
      return { status: 200, body: { entries: page.map(entry), nextBefore: end - 50 > 0 ? Number(page[0].split(':')[0]) : null } };
    };
    const api = vm.runInNewContext([
      constOf('MAX_ENTRIES'), constOf('keyOf'), constOf('offsetOf'), constOf('nextBefore'), constOf('nearBottom'),
      fnOf('function mount('), fnOf('function trim('), fnOf('async function refreshHistory('), fnOf('async function loadOlder('),
      '({ H, mount, trim, refreshHistory, loadOlder })',
    ].join('\n'), {
      $: (id) => els.get(id),
      document: { hidden: false, activeElement: null, createDocumentFragment: () => ({ items: [], append(el) { this.items.push(el); } }) },
      entryEl: (e) => ({ id: e.id, gone: false, remove() { this.gone = true; } }),
      scroller: () => sc,
      cleanEntries: (list) => list,
      fetchHistory,
      updateHistoryChrome() {},
      resetHistory() { throw new Error('a poll that overlaps the shown entries must not reset the list'); },
      showProblem() {},
      announce() {},
      serverMessage: () => 'x',
      A: { kind: 'busy' },
      DOTS: '...',
      H: { items: [], ids: new Set(), older: null, liveEdge: true, loaded: true, busy: false },
    });
    // the page already shows `shown` newest entries of the first `total - 0` lines
    const first = total - shown;
    for (const id of ids.slice(first)) {
      const it = { e: entry(id), el: { id, gone: false, remove() { this.gone = true; } } };
      api.H.items.push(it);
      api.H.ids.add(id);
      state.list.push(it.el);
    }
    api.H.older = first > 0 ? first * STEP : null;
    // nearBottom reads scrollTop/scrollHeight/clientHeight: put the scroller at the bottom or well above it
    const place = (bottom) => { sc.scrollTop = bottom ? 600 : 100; };
    place(atBottom);
    return { ...api, state, sc, place, grow: (n) => { ids.push(...[...Array(n).keys()].map((i) => `${(ids.length + i) * STEP}:0`)); }, ids };
  }

  test('(+) the cap is 500 entries', () => {
    assert.equal(MAX, 500);
  });

  test('(+) following the live tail: new entries arrive, the oldest leave from the top, the list stays at 500 and the removed elements are detached', async () => {
    const r = rig({ total: 600, shown: 500 });
    r.grow(30);
    const firstBefore = r.H.items[0].e.id;
    await r.refreshHistory();
    assert.equal(r.H.items.length, 500);
    assert.equal(r.H.ids.size, 500);
    assert.equal(r.H.items.at(-1).e.id, r.ids.at(-1), 'the newest entry is shown');
    assert.equal(r.H.items.some((it) => it.e.id === firstBefore), false, 'the oldest entries were dropped');
    assert.equal(r.state.list.filter((el) => el.gone).length, 30, 'their elements were removed from the page');
    assert.equal(r.H.older, Number(r.H.items[0].e.id.split(':')[0]), 'Load older now starts where the list starts');
  });

  test('(−) the user has scrolled up: new entries are added at the end and nothing is removed, however far past the cap the list gets', async () => {
    const r = rig({ total: 800, shown: 580, atBottom: false }); // e.g. after a few Load older clicks
    const oldestId = r.H.items[0].e.id;
    const olderBefore = r.H.older;
    r.grow(30);
    await r.refreshHistory();
    assert.equal(r.H.items.length, 610);
    assert.equal(r.H.items[0].e.id, oldestId);
    assert.equal(r.H.older, olderBefore);
    assert.equal(r.state.list.some((el) => el.gone), false);
    r.grow(40);
    await r.refreshHistory();
    assert.equal(r.H.items.length, 650, 'still nothing removed while the reader is up in the transcript');
    assert.equal(r.state.list.some((el) => el.gone), false);
  });

  test('(+) back at the bottom the cap applies again, even when no new entry arrives', async () => {
    const r = rig({ total: 600, shown: 500, atBottom: false });
    r.grow(30);
    await r.refreshHistory();
    assert.equal(r.H.items.length, 530);
    r.place(true);
    await r.refreshHistory(); // nothing new on the server, but the reader is following the tail again
    assert.equal(r.H.items.length, 500);
    assert.equal(r.H.items.at(-1).e.id, r.ids.at(-1));
  });

  test('(+) Load older after a trim fetches the removed entries again, from where the list now starts', async () => {
    const r = rig({ total: 600, shown: 500 });
    const removedId = r.H.items[0].e.id; // the oldest shown entry: the next poll drops it
    r.grow(40);
    await r.refreshHistory();
    assert.equal(r.H.ids.has(removedId), false, 'trimmed');
    const start = r.H.older;
    await r.loadOlder();
    assert.equal(r.state.fetched.at(-1), start, 'the request asks for the entries before the list start');
    assert.equal(r.H.ids.has(removedId), true, 'the trimmed entry is back');
  });

  test('(−) right after Load older the oldest entries are not removed: the cap is held at the other end (newest), as before', async () => {
    const r = rig({ total: 700, shown: 500, atBottom: false });
    const oldestBefore = Number(r.H.items[0].e.id.split(':')[0]);
    await r.loadOlder();
    assert.ok(r.H.items.length <= 500, `${r.H.items.length} entries`);
    assert.ok(Number(r.H.items[0].e.id.split(':')[0]) < oldestBefore, 'the entries just loaded are at the top and kept');
    assert.equal(r.H.liveEdge, false, 'the newest were cut, so the page offers Jump to latest, and the poll stops adding to the end');
    const before = r.H.items.map((it) => it.e.id).join();
    r.grow(20);
    await r.refreshHistory();
    assert.equal(r.H.items.map((it) => it.e.id).join(), before, 'a poll right after Load older changes nothing');
  });

  test('(+) the polls and the mirror timer are started once: one chain each, no timer is re-created without being cleared', () => {
    for (const name of ['startHistoryPoll', 'startAgentPoll']) {
      assert.equal((SRC.match(new RegExp(`\\b${name}\\(\\)`, 'g')) ?? []).length, 2, `${name}: declared once, called once`);
    }
    assert.match(fnOf('function kickMirror('), /clearTimeout\(M\.timer\);\s*M\.timer = setTimeout\(/, 'the mirror timer is cleared before it is set again');
  });
});
