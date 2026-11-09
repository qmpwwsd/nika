import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture, createMirror } from '../src/mirror.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const DEF = { b: false, fg: null, bg: null, u: false, i: false, d: false };
const sty = (o) => ({ ...DEF, ...o });
const span = (t, s = DEF) => ({ t, s });
const text = (rows) => rows.map((r) => r.map((sp) => sp.t).join(''));

/** Everything the page may ever receive must satisfy this, whatever the input was. */
function assertSafe(rows) {
  const colour = (c) => c === null || (Number.isInteger(c) && c >= 0 && c <= 255)
    || (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.ok(Array.isArray(row));
    for (const sp of row) {
      assert.deepEqual(Object.keys(sp), ['t', 's']);
      assert.equal(typeof sp.t, 'string');
      assert.ok(sp.t.length > 0, 'no empty spans');
      assert.doesNotMatch(sp.t, /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/, JSON.stringify(sp.t));
      for (const k of ['b', 'u', 'i', 'd']) assert.equal(typeof sp.s[k], 'boolean');
      assert.ok(colour(sp.s.fg) && colour(sp.s.bg));
      for (const k of Object.keys(sp.s)) assert.ok(['b', 'fg', 'bg', 'u', 'i', 'd', 'r'].includes(k), k);
    }
  }
}

describe('parseCapture: rows and styles', () => {
  test('(+) plain text splits on newlines; a trailing newline adds no row; empty middle rows stay', () => {
    assert.deepEqual(parseCapture('a\nb\n', 80), [[span('a')], [span('b')]]);
    assert.deepEqual(parseCapture('a\n\nb', 80), [[span('a')], [], [span('b')]]);
    assert.deepEqual(parseCapture('', 80), []);
    assert.deepEqual(parseCapture('only', 80), [[span('only')]]);
  });

  test('(+) SGR bold + red, reset, and spans merge while the style is unchanged', () => {
    const rows = parseCapture(`${ESC}[1;31mred${ESC}[1m bold${ESC}[0m plain`, 80);
    assert.deepEqual(rows, [[span('red bold', sty({ b: true, fg: 1 })), span(' plain')]]);
  });

  test('(+) every whitelisted attribute and its reset', () => {
    const rows = parseCapture(`${ESC}[1;2;3;4mA${ESC}[22mB${ESC}[23mC${ESC}[24mD${ESC}[7mE${ESC}[27mF`, 80);
    assert.deepEqual(rows[0].map((s) => s.s), [
      sty({ b: true, d: true, i: true, u: true }),
      sty({ i: true, u: true }),
      sty({ u: true }),
      DEF,
      { ...DEF, r: true },
      DEF,
    ]);
  });

  test('(+) 16 colours map to 0-15, 256-colour and true-colour forms survive, 39/49 reset', () => {
    const rows = parseCapture(
      `${ESC}[34mA${ESC}[92mB${ESC}[44mC${ESC}[105mD${ESC}[38;5;208mE${ESC}[48;2;10;20;30mF${ESC}[38;2;255;0;128mG${ESC}[39;49mH`, 80,
    );
    assert.deepEqual(rows[0].map((s) => [s.s.fg, s.s.bg]), [
      [4, null], [10, null], [10, 4], [10, 13], [208, 13], [208, [10, 20, 30]], [[255, 0, 128], [10, 20, 30]], [null, null],
    ]);
  });

  test('(+) an empty SGR (ESC[m) resets; style carries over from row to row like a terminal', () => {
    const rows = parseCapture(`${ESC}[1mA\nB${ESC}[mC`, 80);
    assert.deepEqual(rows, [[span('A', sty({ b: true }))], [span('B', sty({ b: true })), span('C')]]);
  });

  test('(+) tmux-style underline sub-parameters (4:3) turn underline on, 4:0 off; other sub-parameter forms are ignored', () => {
    const rows = parseCapture(`${ESC}[4:3mA${ESC}[4:0mB${ESC}[38:5:9mC${ESC}[58:5:1mD`, 80);
    assert.deepEqual(rows[0].map((s) => [s.t, s.s.u, s.s.fg]), [['A', true, null], ['BCD', false, null]]);
  });

  test('(+) rows are cut to 2 x cols units, so a wide pane keeps its whole row', () => {
    assert.equal(parseCapture('x'.repeat(80), 80)[0][0].t.length, 80);
    assert.equal(parseCapture('x'.repeat(500), 80)[0][0].t.length, 160);
  });

  test('(+) non-ASCII text and emoji pass through', () => {
    assert.deepEqual(text(parseCapture('héllo 日本 😀', 80)), ['héllo 日本 😀']);
  });
});

describe('parseCapture: hostile input (T9)', () => {
  test('(−) OSC 52 clipboard write, BEL- and ST-terminated, is dropped, visible text stays', () => {
    assert.deepEqual(text(parseCapture(`a${ESC}]52;c;SGVsbG8=${BEL}b${ESC}]52;c;AAAA${ST}c`, 80)), ['abc']);
  });

  test('(−) OSC 8 hyperlinks are dropped, the link text stays', () => {
    const s = `${ESC}]8;;http://example.invalid/x${ST}link text${ESC}]8;;${ST} after`;
    assert.deepEqual(text(parseCapture(s, 80)), ['link text after']);
  });

  test('(−) OSC title, OSC with C1 ST (U+009C), DCS, APC, PM and SOS are dropped', () => {
    const s = `1${ESC}]0;title${BEL}2${ESC}]0;t2\u009c3${ESC}P1;2|payload${ST}4${ESC}_apc${ST}5${ESC}^pm${ST}6${ESC}Xsos${ST}7`;
    assert.deepEqual(text(parseCapture(s, 80)), ['1234567']);
  });

  test('(−) cursor movement, erase, mode, scroll and private CSI are dropped; text after them stays', () => {
    const s = `${ESC}[2J${ESC}[H${ESC}[10;20Hx${ESC}[?1049h${ESC}[5A${ESC}[K${ESC}[?25l${ESC}[1;24r${ESC}[>c${ESC}[6nz${ESC}[ q`;
    assert.deepEqual(text(parseCapture(s, 80)), ['xz']);
  });

  test('(−) other ESC sequences (charset, keypad, reset, stray ST) are dropped', () => {
    assert.deepEqual(text(parseCapture(`a${ESC}(Bb${ESC}=c${ESC}7d${ESC}ce${ESC}\\f${ESC}#8g`, 80)), ['abcdefg']);
  });

  test('(−) a truncated escape at the end of the capture is dropped, never shown', () => {
    for (const tail of [ESC, `${ESC}[`, `${ESC}[3`, `${ESC}[38;5`, `${ESC}]`, `${ESC}]52;c;AAA`, `${ESC}P`, `${ESC}P1;2|x`, `${ESC}(`]) {
      assert.deepEqual(text(parseCapture(`abc${tail}`, 80)), ['abc'], JSON.stringify(tail));
    }
  });

  test('(−) an unterminated OSC/DCS swallows the rest of its row only, never the next row', () => {
    assert.deepEqual(text(parseCapture(`a${ESC}]52;c;AAAA\nsecond${ESC}P1|x\nthird`, 80)), ['a', 'second', 'third']);
  });

  test('(−) an unfinished CSI does not eat the next row or the next escape', () => {
    assert.deepEqual(text(parseCapture(`a${ESC}[12\nb${ESC}[1${ESC}[31mc`, 80)), ['a', 'bc']);
    assert.equal(parseCapture(`a${ESC}[1${ESC}[31mc`, 80)[0][1].s.fg, 1);
  });

  test('(−) C1 CSI (U+009B), C1 OSC/DCS introducers and every U+0080-U+009F are dropped and never start a sequence', () => {
    const rows = parseCapture('\u009b31mred\u009b1mnot bold\u009d0;title\u0007\u0090x', 80);
    assert.deepEqual(rows, [[span('31mred1mnot bold0;titlex')]]);
    for (let cp = 0x80; cp <= 0x9f; cp += 1) assert.deepEqual(text(parseCapture(`a${String.fromCharCode(cp)}b`, 80)), ['ab']);
  });

  test('(−) C0 controls (NUL, BEL, BS, TAB, CR, VT, FF, SO/SI, CAN, SUB), DEL and bidi controls are dropped', () => {
    const noise = '\u0000\u0007\u0008\u0009\r\u000b\u000c\u000e\u000f\u0018\u001a\u007f\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';
    assert.deepEqual(text(parseCapture(`a${noise}b${noise}\nc`, 80)), ['ab', 'c']);
  });

  test('(−) SGR codes outside the whitelist are ignored: blink, conceal, strike, underline colour, fonts, bad colours', () => {
    const s = `${ESC}[5mA${ESC}[8mB${ESC}[9mC${ESC}[53mD${ESC}[10mE${ESC}[21mF${ESC}[58;5;1mG${ESC}[38;5;300mH${ESC}[38;2;1;2mI${ESC}[48;9mJ${ESC}[999mK`;
    assert.deepEqual(parseCapture(s, 80), [[span('ABCDEFGHIJK')]]);
  });

  test('(−) a malformed extended colour stops the rest of that sequence, a later sequence still applies', () => {
    const rows = parseCapture(`${ESC}[38;9;1mA${ESC}[1mB`, 80);
    assert.deepEqual(rows, [[span('A'), span('B', sty({ b: true }))]]);
  });

  test('(−) SGR with intermediates or private markers is not SGR (ESC[?1m, ESC[1 m, ESC[>4;2m)', () => {
    assert.deepEqual(parseCapture(`${ESC}[?1mA${ESC}[1 mB${ESC}[>4;2mC${ESC}[<1mD`, 80), [[span('ABCD')]]);
  });

  test('(−) HTML and script text is data: kept verbatim as text for textContent', () => {
    assert.deepEqual(text(parseCapture('<img src=x onerror=alert(1)>', 80)), ['<img src=x onerror=alert(1)>']);
  });

  test('(−) huge row counts are capped at 2000 rows', () => {
    const rows = parseCapture('line\n'.repeat(5000), 80);
    assert.equal(rows.length, 2000);
    assertSafe(rows);
  });

  test('(−) huge widths are capped per row, also for an absurd cols argument', () => {
    assert.equal(parseCapture('x'.repeat(1_000_000), 80)[0][0].t.length, 160);
    assert.equal(parseCapture('x'.repeat(1_000_000), 1e9)[0][0].t.length, 2000);
    assert.equal(parseCapture('x'.repeat(5000), 0)[0][0].t.length, 2);
    for (const cols of [NaN, undefined, null, 'wide', -5, Infinity]) assert.ok(parseCapture('x'.repeat(5000), cols)[0][0].t.length <= 2000);
  });

  test('(−) a flood of style changes is bounded in span count and the text still arrives', () => {
    const flood = `${ESC}[1mx${ESC}[22mx`.repeat(60_000);
    const rows = parseCapture(flood, 1000);
    const spans = rows.flat();
    assert.ok(spans.length <= 20_001, `${spans.length} spans`);
    assert.equal(spans.reduce((n, sp) => n + sp.t.length, 0), Math.min(120_000, 2000));
    assertSafe(rows);
  });

  test('(−) non-string input gives no rows', () => {
    for (const v of [undefined, null, 5, {}, Buffer.from('x')]) assert.deepEqual(parseCapture(v, 80), []);
  });

  test('(−) fuzz: random mixes of escape fragments always satisfy the output invariants', () => {
    const pieces = [ESC, '[', ']', 'P', '_', '^', 'X', '\\', BEL, '\n', '\r', 'm', ';', ':', '0', '1', '5', '7', '38', '48', '2', '255', '256',
      '?', '>', ' ', 'a', 'Z', '\u009b', '\u009d', '\u009c', '\u0090', '\u007f', '\u202e', '\u0000', 'é', '😀', '52', 'H', 'J'];
    let seed = 0x2545f491;
    const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
    for (let run = 0; run < 400; run += 1) {
      let s = '';
      for (let k = rnd(120); k >= 0; k -= 1) s += pieces[rnd(pieces.length)];
      assertSafe(parseCapture(s, 1 + rnd(120)));
    }
  });
});

describe('createMirror', () => {
  /** Fake tmux: `capture` is the pane text, `info` the display-message line; calls are recorded. */
  function fakeTmux({ capture = 'hello\n', info = '80\t24\t5\t3\t1', fail } = {}) {
    const calls = [];
    const pending = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (fail) return Promise.reject(typeof fail === 'function' ? fail(args) : fail);
      const out = args.includes('capture-pane') ? capture : args.includes('display-message') ? info : '';
      return new Promise((resolve) => { pending.push(() => resolve({ stdout: out, stderr: '' })); });
    };
    exec.calls = calls;
    exec.flush = () => { while (pending.length) pending.shift()(); };
    return exec;
  }
  let t = 1_000_000;
  const clock = () => t;
  const tick = async (exec) => { await new Promise((r) => setImmediate(r)); exec.flush(); };

  test('(+) captures with the contract argv and returns cols, rows, cursor and etag', async () => {
    const exec = fakeTmux({ capture: `${ESC}[1mhi${ESC}[0m\nthere\n` });
    const mirror = createMirror({ exec, tmuxBin: '/opt/x/tmux', now: clock });
    const p = mirror.capture('%12');
    await tick(exec);
    const r = await p;
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rows, [[span('hi', sty({ b: true }))], [span('there')]]);
    assert.equal(r.body.cols, 80);
    assert.deepEqual(r.body.cursor, { x: 5, y: 3, visible: true });
    assert.match(r.body.etag, /^[0-9a-f]{32}$/);
    assert.equal(r.etag, r.body.etag);
    assert.deepEqual(exec.calls, [
      ['/opt/x/tmux', '-u', 'capture-pane', '-p', '-e', '-N', '-t', '%12'],
      ['/opt/x/tmux', '-u', 'display-message', '-p', '-t', '%12', '-F', '#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}'],
    ]);
  });

  test('(+) a hidden cursor is reported as not visible', async () => {
    const exec = fakeTmux({ info: '100\t30\t0\t0\t0' });
    const p = createMirror({ exec, now: clock }).capture('%1');
    await tick(exec);
    const r = await p;
    assert.deepEqual(r.body.cursor, { x: 0, y: 0, visible: false });
    assert.equal(r.body.cols, 100);
  });

  test('(+) the result is cached 250 ms per pane, then fetched again', async () => {
    t = 5_000;
    const exec = fakeTmux();
    const mirror = createMirror({ exec, now: clock });
    const first = mirror.capture('%1');
    await tick(exec);
    await first;
    assert.equal(exec.calls.length, 2);
    t += 249;
    const cached = await mirror.capture('%1');
    assert.equal(cached.status, 200);
    assert.equal(exec.calls.length, 2, 'served from cache');
    const other = mirror.capture('%2'); // another pane is its own cache entry
    await tick(exec);
    await other;
    assert.equal(exec.calls.length, 4);
    t += 1;
    const again = mirror.capture('%1');
    await tick(exec);
    await again;
    assert.equal(exec.calls.length, 6, 'refetched at 250 ms');
  });

  test('(+) capture with fresh: true runs tmux again inside the 250 ms window and refreshes the cache', async () => {
    t = 30_000;
    const exec = fakeTmux();
    const mirror = createMirror({ exec, now: clock });
    const first = mirror.capture('%1');
    await tick(exec);
    await first;
    assert.equal(exec.calls.length, 2);
    t += 10;
    const plain = await mirror.capture('%1');
    assert.equal(plain.status, 200);
    assert.equal(exec.calls.length, 2, 'a plain capture still hits the cache');
    const fresh = mirror.capture('%1', undefined, { fresh: true });
    await tick(exec);
    assert.equal((await fresh).status, 200);
    assert.equal(exec.calls.length, 4, 'fresh skips the cache');
    t += 245; // 255 ms after the first capture (expired), 245 after the fresh one: the fresh result is what the cache holds
    const after = await mirror.capture('%1');
    assert.equal(after.status, 200);
    assert.equal(exec.calls.length, 4, 'the fresh capture refreshed the cache');
  });

  test('(−) fresh does not join a capture already in flight, and a plain request still shares a single one', async () => {
    t = 40_000;
    const exec = fakeTmux();
    const mirror = createMirror({ exec, now: clock });
    const old = mirror.capture('%1'); // in flight, started before the fresh request
    const fresh = mirror.capture('%1', undefined, { fresh: true });
    const plain = mirror.capture('%1'); // joins the plain one, not a second one
    await tick(exec);
    const rs = await Promise.all([old, fresh, plain]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(exec.calls.length, 4, 'one plain capture and one fresh capture, two tmux calls each');
  });

  test('(−) fresh with an If-None-Match that matches still answers 304, and a bad option object is ignored', async () => {
    t = 50_000;
    const exec = fakeTmux();
    const mirror = createMirror({ exec, now: clock });
    const a = mirror.capture('%1', undefined, { fresh: true });
    await tick(exec);
    const { etag } = await a;
    const b = mirror.capture('%1', `"${etag}"`, { fresh: true });
    await tick(exec);
    assert.equal((await b).status, 304);
    const c = mirror.capture('%1', undefined, null); // null options must not throw
    assert.equal((await c).status, 200);
  });

  test('(+) concurrent requests for one pane share a single capture (single flight)', async () => {
    t = 9_000;
    const exec = fakeTmux();
    const mirror = createMirror({ exec, now: clock });
    const all = [mirror.capture('%3'), mirror.capture('%3'), mirror.capture('%3')];
    await tick(exec);
    const rs = await Promise.all(all);
    assert.equal(exec.calls.length, 2);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(new Set(rs.map((r) => r.etag)).size, 1);
  });

  test('(+) If-None-Match with the current etag gives 304 and no body; list, weak and star forms match; a stale etag gives 200', async () => {
    t = 20_000;
    const exec = fakeTmux();
    const mirror = createMirror({ exec, now: clock });
    const p = mirror.capture('%4');
    await tick(exec);
    const { etag } = await p;
    for (const header of [etag, `"${etag}"`, `W/"${etag}"`, `"old", "${etag}"`, '*']) {
      const r = await mirror.capture('%4', header);
      assert.deepEqual([r.status, r.body, r.etag], [304, null, etag], header);
    }
    for (const header of ['"stale"', '', undefined, null, 'nonsense']) {
      assert.equal((await mirror.capture('%4', header)).status, 200, String(header));
    }
  });

  test('(+) the etag changes when the rows, the cursor or the width change', async () => {
    const etagFor = async (opts) => {
      t += 1000;
      const exec = fakeTmux(opts);
      const p = createMirror({ exec, now: clock }).capture('%5');
      await tick(exec);
      return (await p).etag;
    };
    const base = await etagFor({});
    assert.equal(await etagFor({}), base);
    assert.notEqual(await etagFor({ capture: 'hello!\n' }), base);
    assert.notEqual(await etagFor({ info: '80\t24\t6\t3\t1' }), base);
    assert.notEqual(await etagFor({ info: '81\t24\t5\t3\t1' }), base);
  });

  test('(+) a clock that is not a function falls back to Date.now', async () => {
    const exec = fakeTmux();
    const p = createMirror({ exec, now: 12345 }).capture('%6');
    await tick(exec);
    assert.equal((await p).status, 200);
  });

  test('(−) invalid pane ids are refused with 400 and never reach tmux', async () => {
    const exec = fakeTmux();
    const mirror = createMirror({ exec, now: clock });
    for (const pane of ['', '5', '%', '%x', '%1234567', '%1;ls', '-t', '%1 %2', '$(x)', undefined, null, 5, {}]) {
      const r = await mirror.capture(pane);
      assert.equal(r.status, 400, String(pane));
      assert.equal(r.body.error, 'invalid');
    }
    assert.equal(exec.calls.length, 0);
  });

  test('(−) a pane tmux does not know gives 404 not_found and is not cached', async () => {
    t = 40_000;
    const exec = fakeTmux({ fail: () => Object.assign(new Error('x'), { code: 1, stderr: "can't find pane: %9\n" }) });
    const mirror = createMirror({ exec, now: clock });
    const r = await mirror.capture('%9');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    await mirror.capture('%9');
    assert.equal(exec.calls.length, 4, 'errors are not cached: two calls per attempt');
  });

  test('(−) tmux missing or no server gives 503 tmux_unavailable', async () => {
    t = 50_000;
    const enoent = createMirror({ exec: fakeTmux({ fail: Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }) }), now: clock });
    assert.deepEqual([(await enoent.capture('%1')).status, (await enoent.capture('%1')).body.error], [503, 'tmux_unavailable']);
    const down = createMirror({ exec: fakeTmux({ fail: Object.assign(new Error('x'), { code: 1, stderr: 'no server running on /tmp/x\n' }) }), now: clock });
    assert.equal((await down.capture('%1')).status, 503);
  });

  test('(−) any other tmux failure gives 502 tmux_failed with a cleaned one-line message', async () => {
    const exec = fakeTmux({ fail: Object.assign(new Error('x'), { code: 1, stderr: `weird \u001b[31mfailure${'!'.repeat(500)}\nsecond line\n` }) });
    const r = await createMirror({ exec, now: clock }).capture('%1');
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'tmux_failed');
    assert.ok(r.body.message.length <= 200);
    assert.doesNotMatch(r.body.message, /[\u0000-\u001f]|second line/);
  });

  test('(−) hostile pane content never reaches the response: OSC 52, DCS and C1 are gone from the body', async () => {
    t = 60_000;
    const evil = `${ESC}]52;c;AAAA${BEL}safe\n${ESC}P1|x${ST}more\u009b31m\u0090\n`;
    const exec = fakeTmux({ capture: evil });
    const p = createMirror({ exec, now: clock }).capture('%1');
    await tick(exec);
    const r = await p;
    assert.deepEqual(text(r.body.rows), ['safe', 'more31m']);
    assert.doesNotMatch(JSON.stringify(r.body), /\\u001b|\\u009b|\\u0090|AAAA/);
  });

  test('(−) malformed display-message output falls back to safe defaults instead of failing', async () => {
    t = 70_000;
    const exec = fakeTmux({ info: 'garbage' });
    const p = createMirror({ exec, now: clock }).capture('%1');
    await tick(exec);
    const r = await p;
    assert.equal(r.status, 200);
    assert.equal(r.body.cols, 80);
    assert.deepEqual(r.body.cursor, { x: 0, y: 0, visible: false });
  });
});
