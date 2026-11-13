import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeFixture, cleanup, fakeExec, SID, NOW, PROC_START, jsonl } from './helpers.js';
import { readRegistry, processTable, isAlive, parseStarttime, procStarts } from '../src/collect/registry.js';
import { indexTranscripts, readTranscript, createTranscriptCache } from '../src/collect/transcripts.js';
import { readSubagents } from '../src/collect/subagents.js';
import { listPanes, parsePaneLines } from '../src/collect/tmux.js';
import { discoverReportDirs, indexReports } from '../src/collect/reports.js';
import { resolveProject } from '../src/collect/projects.js';
import { defaultConfig } from '../src/config.js';

const fx = makeFixture();
after(() => cleanup(fx));

describe('registry', () => {
  test('(+) reads every <pid>.json entry with normalised fields', async () => {
    const r = await readRegistry(fx.claudeDir);
    assert.equal(r.error, null);
    const pids = r.entries.map((e) => e.pid).sort();
    assert.deepEqual(pids, [101, 102, 103, 104]);
    const busy = r.entries.find((e) => e.pid === 101);
    assert.equal(busy.sessionId, SID.busy);
    assert.equal(busy.status, 'busy');
    assert.equal(busy.tmuxPane, '%5');
    assert.equal(busy.bridgeSessionId, 'session_01AbCdEf');
  });

  test('(−) skips corrupt JSON and never parses *.key files', async () => {
    const r = await readRegistry(fx.claudeDir);
    assert.deepEqual(r.skipped, ['105.json']);
  });

  test('(−) missing sessions dir gives an empty list and an error message, no throw', async () => {
    const r = await readRegistry(path.join(fx.root, 'nope'));
    assert.deepEqual(r.entries, []);
    assert.match(r.error, /sessions/);
  });

  test('(+) process table maps pid to start time; isAlive matches procStart', async () => {
    const table = await processTable(fakeExec());
    // ps pads single-digit days ("Nov  7"); the table stores whitespace squashed so both sides compare equal.
    assert.equal(table.get(101), 'Sat Nov 7 18:57:14 2026');
    assert.equal(isAlive({ pid: 101, procStart: PROC_START }, table), true);
  });

  test('(+) F8: NIKA_TMUX overrides the tmux binary', () => {
    assert.equal(defaultConfig({ NIKA_TMUX: '/x/tmux' }).tmuxBin, '/x/tmux');
  });

  test('(+) ps runs with TZ=UTC because the registry writes procStart in UTC', async () => {
    const seen = [];
    await processTable(async (cmd, args, opts) => {
      seen.push(opts);
      return { stdout: '' };
    });
    assert.equal(seen[0]?.env?.TZ, 'UTC');
  });

  test('(−) dead pid and reused pid (different start time) are not alive', async () => {
    const table = await processTable(fakeExec());
    assert.equal(isAlive({ pid: 103, procStart: PROC_START }, table), false);
    assert.equal(isAlive({ pid: 104, procStart: 'Mon Oct  5 10:00:00 2026' }, table), false);
  });

  test('(−) ps failure returns null so callers fall back to signal 0', async () => {
    const exec = async () => { throw new Error('ps missing'); };
    assert.equal(await processTable(exec), null);
    assert.equal(isAlive({ pid: process.pid }, null), true);
    assert.equal(isAlive({ pid: 2 ** 30 }, null), false);
  });

  describe('Linux procStart (digits: starttime in clock ticks, issue #14)', () => {
    // Synthetic /proc/<pid>/stat: field 22 (starttime) is the 20th token after the comm's closing parenthesis.
    const stat = (pid, comm, start) => `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 8 0 ${start} 1000000 500 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0\n`;
    const table = new Map([[201, 'Sat Nov 7 18:57:14 2026']]);
    const entry = { pid: 201, procStart: '3304488' };

    test('(+) a digits procStart equal to the stat starttime is alive', async () => {
      const starts = await procStarts([entry], async (pid) => stat(pid, 'claude', '3304488'));
      assert.equal(starts.get(201), '3304488');
      assert.equal(isAlive(entry, table, starts), true);
    });

    test('(−) a digits procStart that differs from the stat starttime (reused pid) is not alive', async () => {
      const starts = await procStarts([entry], async (pid) => stat(pid, 'claude', '3304999'));
      assert.equal(isAlive(entry, table, starts), false);
    });

    test('(+) an unreadable stat leaves the pid out and the session alive, because ps listed the pid', async () => {
      const starts = await procStarts([entry], async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
      assert.equal(starts.size, 0);
      assert.equal(isAlive(entry, table, starts), true);
      assert.equal(isAlive(entry, table), true);
    });

    test('(−) a pid ps does not list is not alive whatever the stat says', async () => {
      const starts = await procStarts([{ pid: 202, procStart: '5' }], async (pid) => stat(pid, 'claude', '5'));
      assert.equal(isAlive({ pid: 202, procStart: '5' }, table, starts), false);
    });

    test('(−) only digits procStart entries are read: date strings and missing values never touch /proc', async () => {
      const seen = [];
      const starts = await procStarts(
        [{ pid: 1, procStart: PROC_START }, { pid: 2, procStart: null }, { pid: 3, procStart: '12ab' }, { pid: 4, procStart: '77' }],
        async (pid) => { seen.push(pid); return stat(pid, 'x', '77'); },
      );
      assert.deepEqual(seen, [4]);
      assert.deepEqual([...starts], [[4, '77']]);
    });

    test('(+) parseStarttime takes field 22 after the last parenthesis, whatever the comm holds', () => {
      assert.equal(parseStarttime(stat(201, 'claude', '3304488')), '3304488');
      assert.equal(parseStarttime(stat(201, 'a ) (b c) d', '42')), '42');
      assert.equal(parseStarttime(stat(201, '(((', '9')), '9');
      assert.equal(parseStarttime(stat(201, 'a\nb) c', '7')), '7', 'a newline in the comm');
    });

    test('(−) parseStarttime needs more than the 20 tokens up to field 22: a line cut right after the value is not trusted (F1b M3)', () => {
      const cut = '201 (claude) S 1 201 201 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 8 0 3304488'; // field 22 is the last token
      assert.equal(parseStarttime(cut), null);
      assert.equal(parseStarttime(`${cut} 1000000`), '3304488');
    });

    test('(−) parseStarttime returns null for garbage, a short line or a non-numeric field', () => {
      for (const bad of ['', 'garbage', '201 claude S 1', '201 (claude) S 1 2 3', stat(201, 'claude', 'abc'), stat(201, 'claude', '-5'), null, undefined, 42]) {
        assert.equal(parseStarttime(bad), null, String(bad));
      }
    });

    test('(+) the macOS date-string path is unchanged: starts is ignored for a date procStart', () => {
      const starts = new Map([[101, '1']]);
      const t = new Map([[101, 'Sat Nov 7 18:57:14 2026']]);
      assert.equal(isAlive({ pid: 101, procStart: PROC_START }, t, starts), true);
      assert.equal(isAlive({ pid: 101, procStart: 'Mon Oct  5 10:00:00 2026' }, t, starts), false);
      assert.equal(isAlive({ pid: 101, procStart: null }, t, starts), true);
    });

    test('(+) Linux only: the real reader on this process gives a starttime that isAlive accepts', { skip: process.platform !== 'linux' }, async () => {
      const probe = { pid: process.pid, procStart: '1' };
      const first = await procStarts([probe]);
      assert.match(first.get(process.pid) ?? '', /^\d+$/);
      const real = { pid: process.pid, procStart: first.get(process.pid) };
      const starts = await procStarts([real]);
      assert.equal(isAlive(real, new Map([[process.pid, 'x']]), starts), true);
      assert.equal(isAlive({ pid: process.pid, procStart: String(Number(real.procStart) + 1) }, new Map([[process.pid, 'x']]), starts), false);
    });
  });
});

describe('registry: procStart as an instant, skipped files, session id case (F1b)', () => {
  const PS = 'Sat Nov 7 18:57:14 2026'; // what ps prints in UTC (whitespace squashed)
  const table = new Map([[301, PS]]);
  const alive = (procStart, t = table) => isAlive({ pid: 301, procStart }, t);
  // The writer's local zone is a property of the process: it is set in a child node (TZ=<zone>), never in this one, so no other test sees it.
  const REGISTRY_URL = new URL('../src/collect/registry.js', import.meta.url).href;
  const aliveIn = (tz, cases) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { isAlive } from ${JSON.stringify(REGISTRY_URL)};\nconsole.log(JSON.stringify(JSON.parse(process.argv[1]).map(([s, ps]) => isAlive({ pid: 1, procStart: s }, new Map([[1, ps]])))));`,
    JSON.stringify(cases)], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));
  // Asia/Kolkata is UTC+5:30 all year (no DST): 18:57:14Z on Nov 7 is 00:27:14 on Nov 8.
  const KOLKATA = 'Asia/Kolkata';

  test('(+) the UTC date string, with the day padded or not, is alive', () => {
    assert.equal(alive(PS), true);
    assert.equal(alive('Sat Nov  7 18:57:14 2026'), true);
  });

  test('(+) a local-time date string for the same instant is alive', () => {
    assert.deepEqual(aliveIn(KOLKATA, [['Sun Nov 8 00:27:14 2026', PS], ['Sun Nov  8 00:27:14 2026', PS]]), [true, true], 'the second is padded like ps');
  });

  // M-1: a repeated local hour (fall back) names two instants. The local form is made from the ps instant, so both passes match.
  test('(+) the repeated hour of a DST fall-back: the local time 01:30 is alive for the first pass (EDT) and for the second (EST)', () => {
    const NY = 'America/New_York'; // 2026-11-01: 01:30 EDT is 05:30Z, 01:30 EST is 06:30Z
    assert.deepEqual(aliveIn(NY, [
      ['Sun Nov 1 01:30:00 2026', 'Sun Nov 1 05:30:00 2026'],
      ['Sun Nov 1 01:30:00 2026', 'Sun Nov 1 06:30:00 2026'],
      ['Sun Nov 1 06:30:00 2026', 'Sun Nov 1 06:30:00 2026'],
    ]), [true, true, true]);
  });

  test('(−) the repeated hour does not make a different second alive, in either pass', () => {
    assert.deepEqual(aliveIn('America/New_York', [
      ['Sun Nov 1 01:30:01 2026', 'Sun Nov 1 05:30:00 2026'],
      ['Sun Nov 1 01:30:01 2026', 'Sun Nov 1 06:30:00 2026'],
      ['Sun Nov 1 00:30:00 2026', 'Sun Nov 1 06:30:00 2026'],
    ]), [false, false, false]);
  });

  test('(+) an ISO string for the same instant is alive, with Z, an offset or milliseconds; the comparison is to the second', () => {
    assert.equal(alive('2026-11-07T18:57:14Z'), true);
    assert.equal(alive('2026-11-07T20:57:14+02:00'), true);
    assert.equal(alive('2026-11-07T18:57:14.987Z'), true);
  });

  test('(+) a string nobody can parse is alive, like a missing procStart: ps lists the pid', () => {
    for (const odd of ['not a date', 'Sat Foo 7 18:57:14 2026', 'pid-reuse-unknown']) assert.equal(alive(odd), true, odd);
  });

  // M-4: V8's legacy Date.parse reads many nonsense strings as dates; only an ISO date-time (YYYY-MM-DDT…) counts as a parsed instant
  test('(+) text that only V8 would read as a date is unparseable, so alive: "hello 1", "12 3", a bare year, a date without a time', () => {
    for (const odd of ['hello 1', '12 3', '2026', '1', '2026-11-07', 'Nov 7 2026']) assert.equal(alive(odd), true, odd);
  });

  test('(+) the ps side cannot be read as a date: nothing to compare, the pid ps lists stays alive', () => {
    assert.equal(alive('Mon Oct 5 10:00:00 2026', new Map([[301, 'garbled']])), true);
  });

  test('(−) a parsed instant that differs is a reused pid: not alive, in every format', () => {
    assert.equal(alive('Mon Oct  5 10:00:00 2026'), false);
    assert.equal(alive('Sat Nov 7 18:57:15 2026'), false, 'one second off');
    assert.equal(alive('2026-11-07T18:57:15Z'), false);
    assert.equal(alive('2026-11-07T18:57:13.999Z'), false);
    assert.equal(alive('2026-11-07T18:57:14'.replace('18', '19') + 'Z'), false);
    assert.deepEqual(aliveIn(KOLKATA, [['Sun Nov 8 00:27:15 2026', PS], ['Sun Nov 8 00:27:14 2026', PS]]), [false, true]);
  });

  test('(−) a pid ps does not list is not alive, whatever the format', () => {
    assert.equal(isAlive({ pid: 999, procStart: '2026-11-07T18:57:14Z' }, table), false);
  });

  describe('files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-reg-'));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const UP = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const sessions = path.join(dir, 'sessions');
    fs.mkdirSync(sessions);
    const put = (name, body) => fs.writeFileSync(path.join(sessions, name), typeof body === 'string' ? body : JSON.stringify(body));
    put('401.json', { pid: 401, sessionId: UP, cwd: '/x' });
    put('402.json', { pid: 402, sessionId: 'not-a-uuid' });
    put('403.json', { pid: 403, sessionId: UP.toLowerCase() });
    put('404.json', '{broken');

    test('(+) an upper-case UUID session id is accepted and stored in lower case', async () => {
      const r = await readRegistry(dir);
      const e = r.entries.find((x) => x.pid === 401);
      assert.equal(e?.sessionId, UP.toLowerCase());
      assert.equal(r.entries.find((x) => x.pid === 403)?.sessionId, UP.toLowerCase(), 'both spellings are one session id');
    });

    // M-3: Claude deletes <pid>.json when a session exits, so a file can be listed by readdir and gone by the time it is read
    test('(−) a file that is gone between readdir and read is not a skipped file, but an unreadable one still is', async () => {
      const real = fsp.readdir;
      fsp.readdir = async (...args) => [...await real(...args), '405.json'];
      try {
        const r = await readRegistry(dir);
        assert.deepEqual(r.skipped, ['402.json', '404.json']);
        assert.equal(r.entries.length, 2);
      } finally {
        fsp.readdir = real;
      }
    });

    test('(−) an id that is no UUID in any case, and a file that is not JSON, are skipped and listed', async () => {
      const r = await readRegistry(dir);
      assert.deepEqual(r.skipped, ['402.json', '404.json']);
      assert.deepEqual(r.entries.map((x) => x.pid).sort(), [401, 403]);
    });
  });
});

describe('transcripts', () => {
  test('(+) indexes top-level <uuid>.jsonl files by session id with mtime', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    assert.equal(idx.error, null);
    assert.equal(idx.files.size, 6);
    const f = idx.files.get(SID.busy);
    assert.equal(Math.round(f.mtimeMs / 1000), Math.round((NOW - 60_000) / 1000));
  });

  test('(+) reads cwd, branch, model, title, last prompt, timestamps and bridge id', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const t = await readTranscript(idx.files.get(SID.busy), createTranscriptCache());
    assert.equal(t.cwd, fx.wt);
    assert.equal(t.gitBranch, 'feat/x');
    assert.equal(t.model, 'claude-sonnet-5-5');
    assert.equal(t.aiTitle, 'Build story X');
    assert.equal(t.lastPrompt, 'approved');
    assert.equal(t.bridgeSessionId, 'cse_01AbCdEf');
    assert.equal(t.startedAt, NOW - 60 * 60_000);
  });

  test('(+) a transcript with user or assistant lines has hasConversation true', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const t = await readTranscript(idx.files.get(SID.busy), createTranscriptCache());
    assert.equal(t.hasConversation, true);
  });

  test('(−) a title-only stub transcript has hasConversation false and no cwd', async () => {
    const file = path.join(fx.root, 'stub', 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl([{ type: 'ai-title', sessionId: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', aiTitle: 'Stub title' }]));
    const st = fs.statSync(file);
    const t = await readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
    assert.equal(t.hasConversation, false);
    assert.equal(t.cwd, null);
  });

  test('(+) large file: reads only head and tail chunks, cuts partial lines, last values win', async () => {
    const file = path.join(fx.root, 'big', `${SID.old}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pad = { type: 'attachment', pad: 'p'.repeat(1000) };
    const lines = [
      { type: 'user', cwd: '/start/dir', gitBranch: 'a', timestamp: '2026-11-01T00:00:00.000Z' },
      ...Array.from({ length: 900 }, () => pad),
      { type: 'ai-title', aiTitle: 'first title' },
      ...Array.from({ length: 50 }, () => pad),
      { type: 'assistant', cwd: '/start/dir', gitBranch: 'b', timestamp: '2026-11-02T00:00:00.000Z', message: { model: 'claude-opus-5-5' } },
      { type: 'ai-title', aiTitle: 'final title' },
    ];
    fs.writeFileSync(file, jsonl(lines));
    const st = fs.statSync(file);
    assert.ok(st.size > 600_000);
    const t = await readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
    assert.equal(t.cwd, '/start/dir');
    assert.equal(t.aiTitle, 'final title');
    assert.equal(t.model, 'claude-opus-5-5');
    assert.equal(t.gitBranch, 'b');
    assert.equal(t.bytesRead < st.size, true);
  });

  test('(−) corrupt lines and <synthetic> model are ignored', async () => {
    const file = path.join(fx.root, 'corrupt', `${SID.other}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl([
      { type: 'user', cwd: '/c', timestamp: '2026-11-01T00:00:00.000Z' },
      '{"type":"assistant", broken',
      { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
    ]));
    const st = fs.statSync(file);
    const t = await readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
    assert.equal(t.model, 'claude-sonnet-5-5');
    assert.equal(t.cwd, '/c');
  });

  test('(+) cache returns the same object while mtime and size are unchanged', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const cache = createTranscriptCache();
    const a = await readTranscript(idx.files.get(SID.idle), cache);
    const b = await readTranscript(idx.files.get(SID.idle), cache);
    assert.equal(a, b);
  });

  test('(−) missing projects dir gives an empty index and an error message', async () => {
    const idx = await indexTranscripts(path.join(fx.root, 'nope'));
    assert.equal(idx.files.size, 0);
    assert.match(idx.error, /projects/);
  });
});

describe('transcripts: context usage (0.4, R1)', () => {
  const asst = (usage, model = 'claude-sonnet-5-5') => ({ type: 'assistant', message: { model, usage } });
  const read = async (lines, name) => {
    const file = path.join(fx.root, 'usage', `${name}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl(lines));
    const st = fs.statSync(file);
    return readTranscript({ path: file, mtimeMs: st.mtimeMs, size: st.size }, createTranscriptCache());
  };
  const U = { input_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 999 };

  test('(+) tokens = input + cache read + cache creation of the LAST assistant entry; output tokens and earlier entries do not count', async () => {
    const t = await read([{ type: 'user', cwd: '/u' }, asst({ input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }), asst(U)], 'sum');
    assert.deepEqual(t.usage, { tokens: 2310, model: 'claude-sonnet-5-5' });
  });

  test('(+) the model of that entry is read, and a missing field counts as 0', async () => {
    const t = await read([asst({ input_tokens: 42 }, 'claude-opus-5-5')], 'model');
    assert.deepEqual(t.usage, { tokens: 42, model: 'claude-opus-5-5' });
  });

  test('(+) a synthetic assistant entry after the real one (an interrupt or an API error: zeros) is skipped', async () => {
    const zero = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const t = await read([asst(U), asst(zero, '<synthetic>')], 'synthetic');
    assert.deepEqual(t.usage, { tokens: 2310, model: 'claude-sonnet-5-5' });
  });

  test('(+) a model that is not a MODEL_ID is ignored; the tokens stay', async () => {
    for (const model of ['not a model', 'CLAUDE-OPUS', undefined, 7]) {
      const t = await read([{ type: 'assistant', message: { model, usage: U } }], 'badmodel');
      assert.deepEqual(t.usage, { tokens: 2310, model: null }, String(model));
    }
  });

  test('(−) no assistant entry, or an assistant entry without usage: no usage', async () => {
    assert.equal((await read([{ type: 'user', cwd: '/u' }], 'none')).usage, null);
    assert.equal((await read([{ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } }], 'nousage')).usage, null);
    assert.equal((await read([{ type: 'assistant' }], 'nomsg')).usage, null);
  });

  test('(−) malformed usage: a non-number, a fraction, a negative, over 10,000,000 (a field or the sum), a non-object: no usage, and no fall back to an earlier entry', async () => {
    const cases = [
      { input_tokens: '12' }, { input_tokens: 1.5 }, { input_tokens: -1 }, { cache_read_input_tokens: '5' }, { cache_creation_input_tokens: -3 }, { cache_creation_input_tokens: true },
      { input_tokens: [5] }, { input_tokens: {} }, { input_tokens: 10_000_001 }, { cache_read_input_tokens: 10_000_001 },
      { input_tokens: 6_000_000, cache_read_input_tokens: 6_000_000 }, 'many', 7, [1, 2], null,
    ];
    for (const [i, usage] of cases.entries()) {
      const t = await read([asst(U), asst(usage)], `bad${i}`);
      assert.equal(t.usage, null, JSON.stringify(usage));
    }
  });

  test('(+) a null field counts as 0, the same as a missing one (the API types allow null for the cache counts)', async () => {
    assert.deepEqual((await read([asst({ input_tokens: 40, cache_read_input_tokens: 2, cache_creation_input_tokens: null })], 'null1')).usage, { tokens: 42, model: 'claude-sonnet-5-5' });
    assert.deepEqual((await read([asst({ input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null })], 'null3')).usage, { tokens: 0, model: 'claude-sonnet-5-5' });
  });

  test('(+) exactly 10,000,000 is accepted', async () => {
    assert.deepEqual((await read([asst({ cache_read_input_tokens: 10_000_000 })], 'cap')).usage, { tokens: 10_000_000, model: 'claude-sonnet-5-5' });
  });

  test('(+) large file: the usage comes from the tail chunk', async () => {
    const pad = { type: 'attachment', pad: 'p'.repeat(1000) };
    const t = await read([asst({ input_tokens: 5 }), ...Array.from({ length: 700 }, () => pad), asst({ input_tokens: 77, cache_read_input_tokens: 23 }, 'claude-opus-5-5')], 'bigtail');
    assert.deepEqual(t.usage, { tokens: 100, model: 'claude-opus-5-5' });
  });

  test('(−) large file: a usage line that sits only before the tail window (in the head) is not read', async () => {
    const pad = { type: 'attachment', pad: 'p'.repeat(1000) };
    const t = await read([asst({ input_tokens: 5 }), ...Array.from({ length: 700 }, () => pad), { type: 'user', cwd: '/u' }], 'bighead');
    assert.equal(t.usage, null);
    assert.equal(t.model, 'claude-sonnet-5-5'); // the existing head fall-back still works
    assert.equal(t.bytesRead < fs.statSync(path.join(fx.root, 'usage', 'bighead.jsonl')).size, true);
  });

  test('(−) large file whose tail sits inside one huge last line: the head\'s usage is far behind the end and is not used', async () => {
    const t = await read([asst({ input_tokens: 5 }), { type: 'user', cwd: '/u', pad: 'x'.repeat(2_500_000) }], 'hugeline');
    assert.equal(t.usage, null);
    assert.equal(t.model, 'claude-sonnet-5-5'); // the existing head fall-back for the other fields still works
  });
});

describe('subagents', () => {
  test('(+) reads meta.json of each subagent with its transcript mtime', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    const subs = await readSubagents(idx.files.get(SID.busy));
    assert.equal(subs.length, 2);
    const running = subs.find((s) => s.id === 'bbb222');
    assert.deepEqual(
      { type: running.type, description: running.description, model: running.model, finished: running.finished },
      { type: 'general-purpose', description: 'Write tests', model: 'sonnet', finished: false },
    );
    assert.equal(Math.round(running.lastActivity / 1000), Math.round((NOW - 120_000) / 1000));
  });

  test('(−) session without a subagents dir gives an empty list; broken meta is skipped', async () => {
    const idx = await indexTranscripts(fx.claudeDir);
    assert.deepEqual(await readSubagents(idx.files.get(SID.idle)), []);
    const subs = await readSubagents(idx.files.get(SID.busy));
    assert.equal(subs.some((s) => s.id === 'ccc333'), false);
  });
});

describe('tmux', () => {
  test('(+) parses panes; name only from the "[%id] name" title convention', () => {
    const panes = parsePaneLines('%5\twork\t1\t[%5] build-7-1\tzsh\n%6\twork\t2\tMacBook.local\tclaude\n');
    assert.equal(panes.get('%5').name, 'build-7-1');
    assert.equal(panes.get('%5').session, 'work');
    assert.equal(panes.get('%6').name, null);
  });

  test('(+) @nika-role: "orchestrator" and "agent" are read from the last field; an empty title keeps the fields in place', () => {
    const panes = parsePaneLines('%5\twork\t1\t[%5] build-7-1\tzsh\tagent\n%6\twork\t2\t\tclaude\torchestrator\n%7\twork\t3\tMacBook.local\tzsh\t\n');
    assert.equal(panes.get('%5').role, 'agent');
    assert.equal(panes.get('%6').role, 'orchestrator');
    assert.equal(panes.get('%6').title, '');
    assert.equal(panes.get('%6').command, 'claude');
    assert.equal(panes.get('%7').role, null);
  });

  test('(−) @nika-role: any other value, a 0.1-style line without the field, and short lines give role null and still parse', () => {
    const lines = ['%1\tw\t1\tt\tzsh\tadmin', '%2\tw\t1\tt\tzsh\tAgent', '%3\tw\t1\tt\tzsh\torchestrator ', '%4\tw\t1\tt\tzsh', '%8\tw\t1', '%9'];
    const panes = parsePaneLines(`${lines.join('\n')}\n`);
    for (const id of ['%1', '%2', '%3', '%4', '%8', '%9']) assert.equal(panes.get(id).role, null, id);
    assert.equal(panes.get('%4').name, null);
    assert.equal(panes.get('%4').command, 'zsh');
  });

  test('(+) listPanes asks tmux for the nika tags after the title and command: role, agent, depth, parent', async () => {
    const exec = fakeExec();
    await listPanes(exec);
    const format = exec.calls[0].at(-1);
    assert.ok(format.endsWith('\t#{@nika-role}\t#{@nika-agent}\t#{@nika-depth}\t#{@nika-parent}'));
    assert.equal(format.split('\t').length, 9);
  });

  const KEY = '0123456789abcdef';
  const TAGS = (role, agent, depth, parent) => `%5\twork\t1\t[%5] x\tnode\t${role}\t${agent}\t${depth}\t${parent}\n`;

  test('(+) @nika-role sub-orchestrator, @nika-agent, @nika-depth and @nika-parent are read when they parse', () => {
    const p = parsePaneLines(TAGS('sub-orchestrator', `${KEY}/planner`, '2', '%3')).get('%5');
    assert.deepEqual([p.role, p.agent, p.depth, p.parent], ['sub-orchestrator', `${KEY}/planner`, 2, '%3']);
    const a = parsePaneLines(TAGS('agent', `${KEY}/build-1`, '3', '%5')).get('%5');
    assert.deepEqual([a.role, a.agent, a.depth, a.parent], ['agent', `${KEY}/build-1`, 3, '%5']);
    const o = parsePaneLines(TAGS('orchestrator', `${KEY}/orchestrator`, '1', '')).get('%5');
    assert.deepEqual([o.role, o.agent, o.depth, o.parent], ['orchestrator', `${KEY}/orchestrator`, 1, null]);
  });

  test('(−) a bad agent tag, depth or parent becomes null (never cleaned up into something valid); a line without the fields has none', () => {
    for (const depth of ['0', '4', '12', '1 ', ' 2', '2.0', 'x', '-1', '٣']) assert.equal(parsePaneLines(TAGS('agent', `${KEY}/a`, depth, '')).get('%5').depth, null, JSON.stringify(depth));
    for (const parent of ['5', '%', '%x', '% 5', '%5 ', ' %5', '%1234567', '%5\u0000', '#{pane_id}', '%3;%4', '%03a']) assert.equal(parsePaneLines(TAGS('agent', `${KEY}/a`, '2', parent)).get('%5').parent, null, JSON.stringify(parent));
    for (const agent of ['a', `${KEY}`, `${KEY}/`, `${KEY.toUpperCase()}/a`, `${KEY}/a/b`, ` ${KEY}/a`, `${KEY}/A b`]) assert.equal(parsePaneLines(TAGS('agent', agent, '2', '')).get('%5').agent, null, JSON.stringify(agent));
    const old = parsePaneLines('%5\twork\t1\tt\tzsh\tagent\n').get('%5');
    assert.deepEqual([old.role, old.agent, old.depth, old.parent], ['agent', null, null, null]);
  });

  test('(−) a pane with no nika role carries no agent tag, depth or parent, whatever its options say', () => {
    const p = parsePaneLines(TAGS('', `${KEY}/a`, '2', '%3')).get('%5');
    assert.deepEqual([p.role, p.agent, p.depth, p.parent], [null, null, null, null]);
    const q = parsePaneLines(TAGS('admin', `${KEY}/a`, '2', '%3')).get('%5');
    assert.deepEqual([q.role, q.agent, q.depth, q.parent], [null, null, null, null]);
  });

  test('(+) listPanes calls tmux -u list-panes -a with a fixed format', async () => {
    // -u added for review finding F10 (non-ASCII pane titles were sanitised to "_").
    const exec = fakeExec();
    const r = await listPanes(exec);
    assert.equal(r.error, null);
    assert.equal(r.panes.size, 3);
    assert.deepEqual(exec.calls[0].slice(0, 4), ['tmux', '-u', 'list-panes', '-a']);
  });

  test('(−) tmux missing or no server: empty map and an error message, no throw', async () => {
    const r = await listPanes(fakeExec({ tmuxError: 'ENOENT' }));
    assert.equal(r.panes.size, 0);
    assert.match(r.error, /tmux/);
    const r2 = await listPanes(fakeExec({ tmuxError: 'no server running on /tmp/tmux-501/default' }));
    assert.equal(r2.panes.size, 0);
  });
});

describe('reports', () => {
  test('(+) discovers <tmpRoot>/*/*/scratchpad/reports dirs plus extra dirs', async () => {
    const extra = path.join(fx.root, 'extra-reports');
    fs.mkdirSync(extra, { recursive: true });
    const dirs = await discoverReportDirs(fx.tmpRoot, [extra, path.join(fx.root, 'missing')]);
    // Extra dirs are owner-configured and resolved with realpath (review F1); on macOS /var → /private/var.
    assert.deepEqual(dirs.sort(), [fs.realpathSync(extra), fx.reportsDir].sort());
  });

  test('(+) maps session id to report name, STATUS line, rc and report path', async () => {
    const idx = await indexReports([fx.reportsDir]);
    const busy = idx.get(SID.busy);
    assert.equal(busy.name, 'build-7-1');
    assert.equal(busy.status, 'STATUS: RUNNING 7.1 build');
    assert.equal(busy.rc, null);
    assert.equal(busy.reportPath, path.join(fx.reportsDir, 'build-7-1.md'));
    const old = idx.get(SID.ended);
    assert.equal(old.status, null);
    assert.equal(old.rc, 0);
  });

  test('(−) a .session file without a valid uuid is ignored; missing tmp root gives no dirs', async () => {
    const idx = await indexReports([fx.reportsDir]);
    assert.equal([...idx.values()].some((r) => r.name === 'bad'), false);
    assert.deepEqual(await discoverReportDirs(path.join(fx.root, 'nope'), []), []);
  });
});

describe('projects', () => {
  test('(+) main checkout groups under its own root', () => {
    const p = resolveProject(fx.repo);
    assert.deepEqual(p, { key: fx.repo, label: 'repo', root: fx.repo, worktree: null });
  });

  test('(+) linked worktree and its subdirs fold under the parent repo with a worktree tag', () => {
    assert.deepEqual(resolveProject(fx.wt), { key: fx.repo, label: 'repo', root: fx.repo, worktree: 'repo-wt' });
    assert.equal(resolveProject(path.join(fx.wt, 'packages', 'app')).key, fx.repo);
  });

  test('(−) non-git dir and missing dir group by the cwd itself', () => {
    assert.deepEqual(resolveProject(fx.plain), { key: fx.plain, label: 'plain', root: fx.plain, worktree: null });
    const gone = path.join(fx.root, 'deleted-scratch');
    assert.deepEqual(resolveProject(gone), { key: gone, label: 'deleted-scratch', root: gone, worktree: null });
  });

  test('(−) empty cwd groups under "(unknown)"', () => {
    assert.equal(resolveProject('').key, '(unknown)');
    assert.equal(resolveProject(undefined).label, '(unknown)');
  });

  test('(+) F6: a deleted dir inside a repo still folds under the repo', () => {
    assert.deepEqual(resolveProject(path.join(fx.repo, 'gone', 'deeper')), { key: fx.repo, label: 'repo', root: fx.repo, worktree: null });
  });

  test('(+) F6: a deleted Claude Code worktree (<repo>/.claude/worktrees/<name>) keeps its worktree tag', () => {
    assert.deepEqual(resolveProject(path.join(fx.repo, '.claude', 'worktrees', 'foo')), { key: fx.repo, label: 'repo', root: fx.repo, worktree: 'foo' });
  });

  test('(+) F11: a submodule groups under its own working dir, not the internal gitdir', () => {
    const sup = path.join(fx.root, 'super');
    const sub = path.join(sup, 'sub');
    fs.mkdirSync(path.join(sup, '.git', 'modules', 'sub'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    assert.deepEqual(resolveProject(sub), { key: sub, label: 'sub', root: sub, worktree: null });
  });

  test('(−) F12: a huge whitespace-padded .git file resolves fast and falls back', () => {
    const d = path.join(fx.root, 'slow-git');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.git'), `gitdir: x${' '.repeat(100_000)}y`);
    const t0 = performance.now();
    resolveProject(d);
    assert.ok(performance.now() - t0 < 200, 'took too long');
  });
});

describe('review fixes: liveness and tmux', () => {
  test('(−) F13: empty ps output means "unknown" (null), not "everything dead"', async () => {
    assert.equal(await processTable(async () => ({ stdout: '' })), null);
  });

  test('(+) F10: ps gets the C locale; tmux list-panes runs with -u (UTF-8)', async () => {
    const seen = [];
    await processTable(async (cmd, args, opts) => { seen.push(opts); return { stdout: '1 x' }; });
    assert.equal(seen[0].env.LC_ALL, 'C');
    const exec = fakeExec();
    await listPanes(exec);
    assert.deepEqual(exec.calls[0].slice(0, 3), ['tmux', '-u', 'list-panes']);
  });

  test('(+) F8: listPanes uses the configured tmux binary; a missing binary says how to fix it', async () => {
    const calls = [];
    const r = await listPanes(async (cmd) => { calls.push(cmd); throw Object.assign(new Error('spawn'), { code: 'ENOENT' }); }, '/opt/x/tmux');
    assert.equal(calls[0], '/opt/x/tmux');
    assert.match(r.error, /NIKA_TMUX/);
  });
});
