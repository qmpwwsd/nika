// writeDraft (design W5 sections 3, 7, 8, 9): the controller that types a draft into Claude's input box. A fake pane
// models the box (plain and vim input, the `!` glyph, the Escape rules of spike S9) and records every key with the fake
// clock and the registry state at that moment; `safe()` then asserts, for every case, what must never go out. Synthetic text only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl, checkDraftBody, readDraft } from '../src/session-control.js';
import { boxRows, span } from './helpers.js';

const COLS = 120;
const W = COLS - 4;
const NEVER = ['Enter', 'C-c', 'Up', 'Down', 'BTab', 'C-k'];
const PROMPT = ['Bash command', '  run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];
const tick = () => new Promise((r) => setImmediate(r));

/** A live screen: `capture-pane -p -e -N` keeps the spaces Claude draws after the text, so every row is as wide as the pane (live check, Claude 2.1.325). */
const padded = (cap) => ({
  ...cap,
  rows: cap.rows.map((row) => {
    const used = row.reduce((n, sp) => n + [...sp.t].length, 0);
    if (used >= COLS) return row;
    if (row.length === 0) return [span(' '.repeat(COLS))];
    return [...row.slice(0, -1), { ...row.at(-1), t: row.at(-1).t + ' '.repeat(COLS - used) }];
  }),
});

/** Logical text to visual box rows: a newline starts a row, a line longer than the usable width wraps at exactly W (the tests wrap only text without spaces). */
const visual = (text) => text.split('\n').flatMap((line) => {
  const rows = [];
  for (let i = 0; i < Math.max(line.length, 1); i += W) rows.push(line.slice(i, i + W));
  return rows;
});

/**
 * A pane with Claude's input box. Fields: text, glyph ('prompt' | 'bash'), vim (the input is in vim mode) with vimMode
 * ('insert' | 'normal'), mem ({ vim, plain }: nika's memory of the edit mode), state / freshState (registry state; the fresh read
 * answers freshState when set), lag (captures that still show INSERT after an Escape; `escLag` sets it), swallow(s) (what of typed
 * text reaches the box), before(n, w) (runs before the n-th capture), afterType(body, w), failSend(body, n), override(w) (a screen
 * to show instead), prompt (a permission prompt on screen). Vim normal mode takes `ggdG` and `i` as commands; plain Escape arms
 * "Esc again to clear" and the second one clears; Escape on an empty plain box would open Rewind (counted, must stay 0).
 */
function pane(opts = {}) {
  const w = {
    text: '', glyph: 'prompt', vim: false, vimMode: 'insert', mem: { vim: false, plain: false }, armed: false,
    state: 'idle', freshState: null, lag: 0, escLag: 0, swallow: (s) => s, before: null, afterType: null, failSend: null, override: null,
    prompt: false, history: false, t: 1_000_000, n: 0, sent: [], slept: [], edits: [], stateArgs: [], rewinds: 0, hold: null,
    ...opts,
  };
  w.screen = () => {
    if (w.override) return w.override(w);
    if (w.prompt) return { rows: PROMPT.map((t) => (t ? [span(t)] : [])), cursor: { x: 0, y: 0, visible: true }, cols: COLS };
    const cap = boxRows({
      cols: COLS, lines: w.text === '' ? [''] : visual(w.text), mode: w.glyph, insert: w.vim && (w.vimMode === 'insert' || w.lag > 0),
      label: w.history ? 'History 3/3' : null, hint: w.armed ? 'Esc again to clear' : null,
    });
    return w.padded ? padded(cap) : cap;
  };
  w.mirror = {
    async capture(id, inm, o) {
      w.n += 1;
      w.before?.(w.n, w);
      if (w.hold) await w.hold;
      const out = { status: 200, body: w.screen() };
      assert.equal(o?.fresh, true, 'every control read is fresh');
      if (w.lag > 0) w.lag -= 1;
      return out;
    },
  };
  const typeText = (s) => {
    const part = w.swallow(s);
    if (w.vim && w.vimMode === 'normal') { // vim commands, not text
      if (part === 'ggdG') w.text = '';
      else if (part === 'i') w.vimMode = 'insert';
      return;
    }
    if (w.text === '' && w.glyph === 'prompt' && part.startsWith('!')) { // `!` as the first character moves to the glyph
      w.glyph = 'bash';
      w.text = part.slice(1);
    } else w.text += part;
    w.armed = false;
  };
  const press = (k) => {
    if (k === 'Escape') {
      if (w.vim) {
        if (w.vimMode === 'insert') w.lag = w.escLag;
        w.vimMode = 'normal';
      } else if (w.text !== '') {
        if (w.armed || w.oneEscape) { w.text = ''; w.armed = false; } else w.armed = true;
      } else w.rewinds += 1;
    } else if (k === 'BSpace') {
      if (w.text === '' && w.glyph === 'bash') w.glyph = 'prompt';
      else w.text = w.text.slice(0, -1);
    } else if (k === 'C-u') w.text = '';
  };
  w.keys = {
    async send(id, body) {
      w.sent.push({ body, t: w.t, state: w.freshState ?? w.state });
      const failed = w.failSend?.(body, w.sent.length);
      if (failed) return failed;
      for (const k of body.keys ?? []) press(k);
      if (body.text !== undefined) typeText(body.text);
      if (body.paste !== undefined) typeText(body.paste);
      w.afterType?.(body, w);
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 0 } } };
    },
  };
  w.stateOf = async (id, o) => { w.stateArgs.push(o); return o?.fresh && w.freshState !== null ? w.freshState : w.state; };
  w.setEdit = (id, kind) => {
    w.edits.push(kind);
    w.mem = kind === 'vim' ? { vim: true, plain: false } : kind === 'plain' ? { vim: false, plain: true } : { vim: false, plain: false };
  };
  w.sleep = async (ms) => { w.t += ms; w.slept.push(ms); };
  w.control = (extra = {}) => createSessionControl({
    mirror: w.mirror, keys: w.keys, paneCommand: async () => 'claude', stateOf: w.stateOf, vimOf: () => w.mem.vim, plainOf: () => w.mem.plain,
    setEdit: w.setEdit, now: () => w.t, sleep: w.sleep, ...extra,
  });
  w.sig = () => readDraft(w.screen()).sig;
  /** The write the page makes: `base` is the sig the page last saw (the screen's by default). */
  w.put = (text, base = w.sig()) => w.control().writeDraft('%2', { text, base });
  return w;
}

/** What must never go out, whatever the case (design 8, brief): asserted after every write. */
function safe(w) {
  w.sent.forEach((s, i) => {
    for (const k of s.body.keys ?? []) assert.ok(!NEVER.includes(k), `never ${k}`);
    if (typeof s.body.text === 'string') assert.ok(s.body.text.length <= 700, 'a -l call stays within 700 characters');
    for (const piece of [s.body.text, s.body.paste]) if (typeof piece === 'string') assert.ok(!/[ \t]$/.test(piece), `no chunk ends in a space or tab: ${JSON.stringify(piece.slice(-5))}`);
    if (s.body.keys?.includes('Escape')) {
      assert.equal(s.state, 'idle', 'Escape only while the registry says idle');
      const next = w.sent[i + 1];
      if (next) assert.ok(next.t - s.t >= 40, `no key within 40 ms of an Escape (${next.t - s.t} ms)`);
    }
  });
  assert.equal(w.rewinds, 0, 'Escape on an empty plain box (Rewind) never goes out');
}
const sentKeys = (w) => w.sent.map((s) => (s.body.keys ? s.body.keys.join('+') : s.body.paste !== undefined ? `paste:${s.body.paste}` : `text:${s.body.text}`));
const code = (status, error) => ({ status, body: { error } });

describe('checkDraftBody', () => {
  const ok = { text: 'hello', base: '' };
  test('(+) a text with newlines and tabs, and a base of 16 lowercase hex or empty', () => {
    assert.equal(checkDraftBody(ok), null);
    assert.equal(checkDraftBody({ text: 'a\nb\tc', base: '0123456789abcdef' }), null);
    assert.equal(checkDraftBody({ text: '', base: '' }), null);
    assert.equal(checkDraftBody({ text: 'x'.repeat(1024), base: '' }), null);
    assert.equal(checkDraftBody({ text: '\n'.repeat(12), base: '' }), null);
  });

  test('(−) not a string, 1025 characters, 13 newlines, a control character, a bad base, other keys: 400 invalid', () => {
    const bad = [
      null, undefined, 'x', [], {}, { text: 'a' }, { base: '' }, { text: 'a', base: '', extra: 1 },
      { text: 5, base: '' }, { text: null, base: '' }, { text: 'x'.repeat(1025), base: '' }, { text: '\n'.repeat(13), base: '' },
      { text: 'a\u0000b', base: '' }, { text: 'a\rb', base: '' }, { text: 'a\u001bb', base: '' }, { text: 'a\u007fb', base: '' }, { text: 'a\u0085b', base: '' },
      { text: 'a', base: 5 }, { text: 'a', base: null }, { text: 'a', base: 'ABCDEF0123456789' }, { text: 'a', base: '0123456789abcde' },
      { text: 'a', base: '0123456789abcdef0' }, { text: 'a', base: '0123456789abcdeg' },
    ];
    for (const body of bad) {
      const r = checkDraftBody(body);
      assert.equal(r?.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid');
    }
  });
});

describe('writeDraft: the answers that send nothing', () => {
  test('(+) the box already reads the text: 200, typed 0, the draft in the answer, no key, one capture', async () => {
    const w = pane({ text: 'hello', vim: true });
    const r = await w.put('hello');
    assert.equal(r.status, 200);
    assert.equal(r.body.typed, 0);
    assert.equal(r.body.draft.text, 'hello');
    assert.equal(r.body.draft.edit, 'insert');
    assert.deepEqual(w.sent, []);
    assert.equal(w.n, 1);
    safe(w);
  });

  test('(+) trailing spaces and a tab at the end are not typed and are not a difference', async () => {
    const w = pane({ text: 'hello', vim: true });
    assert.equal((await w.put('hello  \t')).body.typed, 0);
    assert.deepEqual(w.sent, []);
  });

  test('(−) 400 for a bad body before any capture or key', async () => {
    const w = pane({ text: 'hello' });
    for (const body of [{ text: 'a\u0000', base: '' }, { text: 'x'.repeat(1025), base: '' }, { text: '\n'.repeat(13), base: '' }, { text: 'a', base: 'XYZ' }, { text: 'a' }]) {
      const r = await w.control().writeDraft('%2', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(w.n, 0);
    assert.deepEqual(w.sent, []);
  });

  test('(−) 400 when the text is inside the character and newline bounds but needs more than 13 rows (the page does not send it)', async () => {
    const w = pane({ text: 'hello', vim: true });
    const text = Array.from({ length: 7 }, () => 'y'.repeat(140)).join('\n'); // 986 characters, 7 lines of 2 rows
    assert.equal((await w.put(text)).status, 400);
    assert.deepEqual(w.sent, []);
  });

  test('(−) a permission prompt on screen: 409 not-idle, one capture, nothing sent (a draft never lands in a prompt)', async () => {
    const w = pane({ text: 'hello', prompt: true });
    assert.deepEqual(await w.control().writeDraft('%2', { text: 'bye', base: '' }), code(409, 'not-idle'));
    assert.deepEqual(w.sent, []);
    assert.equal(w.n, 1);
  });

  test('(−) a footer nobody recognises (a dialog may be open): 409 mode-unknown; no input box: 409 input-unreadable', async () => {
    const unknown = pane({ override: () => boxRows({ lines: ['hello'], footer: 'some footer nobody recognises' }) });
    assert.deepEqual(await unknown.control().writeDraft('%2', { text: 'bye', base: '' }), code(409, 'mode-unknown'));
    const oneRule = pane({ override: () => { const s = boxRows({ lines: ['hello'] }); return { ...s, rows: s.rows.filter((_, i) => i !== 0) }; } });
    assert.deepEqual(await oneRule.control().writeDraft('%2', { text: 'bye', base: '' }), code(409, 'input-unreadable'));
    assert.deepEqual([...unknown.sent, ...oneRule.sent], []);
  });

  test('(−) an unreadable box is never written over: 409 draft-unreadable with the reason, per reason, nothing sent', async () => {
    const odd = () => { const s = boxRows({ lines: ['hello', 'second'] }); s.rows[2] = [span(' bad row')]; return s; };
    const cases = {
      history: () => boxRows({ lines: ['hello'], label: 'History 3/3' }),
      pasted: () => boxRows({ lines: ['[Pasted text #1 +3 lines]'] }),
      tall: () => boxRows({ lines: Array.from({ length: 14 }, (_, i) => `row ${i}`) }),
      trailing: () => boxRows({ lines: ['hello'], cursor: { dx: 3 } }),
      layout: odd,
    };
    for (const [reason, override] of Object.entries(cases)) {
      const w = pane({ override });
      const r = await w.control().writeDraft('%2', { text: 'bye', base: '' });
      assert.equal(r.status, 409, reason);
      assert.equal(r.body.error, 'draft-unreadable', reason);
      assert.equal(r.body.reason, reason);
      assert.equal(r.body.draft.state, 'unreadable');
      assert.deepEqual(w.sent, [], reason);
    }
  });

  test('(−) a stale or empty base: 409 draft-changed with the screen\'s draft, nothing sent', async () => {
    for (const base of ['0123456789abcdef', '']) {
      const w = pane({ text: 'hello', vim: true });
      const r = await w.put('bye', base);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'draft-changed');
      assert.equal(r.body.draft.text, 'hello');
      assert.equal(r.body.draft.sig, w.sig());
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a replace while Claude works (or has no live session) is 409 not-idle with the draft; nothing is sent, so no Escape', async () => {
    for (const state of ['busy', 'waiting', null]) {
      const w = pane({ text: 'hello', vim: true, state });
      const r = await w.put('bye');
      assert.equal(r.status, 409, String(state));
      assert.equal(r.body.error, 'not-idle');
      assert.equal(r.body.draft.text, 'hello');
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) idle in the cached read but busy in the fresh read right before the Escape: 409 not-idle, no Escape (vim and plain)', async () => {
    for (const opts of [{ vim: true }, { mem: { vim: false, plain: true } }]) {
      const w = pane({ text: 'hello', freshState: 'busy', ...opts });
      const r = await w.put('bye');
      assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
      assert.deepEqual(w.stateArgs.at(-1), { fresh: true }, 'the registry cache is skipped before an Escape');
      assert.deepEqual(w.sent, []);
    }
  });
});

describe('writeDraft: append and type (no Escape, so they run while Claude works)', () => {
  test('(+) append in vim INSERT: only the new part, as one -l call; read back; 200 with typed', async () => {
    const w = pane({ text: 'hello', vim: true });
    const r = await w.put('hello world');
    assert.equal(r.status, 200);
    assert.equal(r.body.typed, 6);
    assert.equal(r.body.draft.text, 'hello world');
    assert.equal(r.body.draft.edit, 'insert');
    assert.deepEqual(w.sent.map((s) => s.body), [{ text: ' world' }]);
    safe(w);
  });

  test('(+) append in plain mode (the pane\'s memory says plain)', async () => {
    const w = pane({ text: 'hello', mem: { vim: false, plain: true } });
    const r = await w.put('hello there');
    assert.deepEqual([r.status, r.body.typed, r.body.draft.edit], [200, 6, 'plain']);
    assert.deepEqual(w.sent.map((s) => s.body), [{ text: ' there' }]);
  });

  test('(−) M-1: plain memory and the cursor on an empty last row cannot tell INSERT from vim NORMAL: no append, the replace road (Escapes, no probe), never the suffix as literal keys', async () => {
    const w = pane({ text: 'hello\n', mem: { vim: false, plain: true } });
    const d = readDraft(w.screen());
    assert.deepEqual([d.text, d.cursorAtEnd], ['hello\n', true], 'the fixture: an end cursor on an empty last row');
    const r = await w.put('hello\nworld');
    assert.equal(r.status, 200);
    assert.deepEqual(w.sent.map((s) => s.body), [{ keys: ['Escape'] }, { keys: ['Escape'] }, { paste: 'hello\nworld' }]);
    safe(w);
    // the same screen with a vim INSERT footer (insert is shown, not remembered): the append is safe and stays
    const v = pane({ text: 'hello\n', vim: true });
    assert.equal((await v.put('hello\nworld')).status, 200);
    assert.deepEqual(v.sent.map((s) => s.body), [{ text: 'world' }]);
  });

  test('(+) M-1: plain memory and an end cursor on a row with text still appends', async () => {
    const w = pane({ text: 'hello\nthere', mem: { vim: false, plain: true } });
    assert.equal((await w.put('hello\nthere again')).status, 200);
    assert.deepEqual(w.sent.map((s) => s.body), [{ text: ' again' }]);
  });

  test('(+) an append with a newline goes as a bracketed paste, a tab too', async () => {
    const a = pane({ text: 'hello', vim: true });
    assert.equal((await a.put('hello\nworld')).status, 200);
    assert.deepEqual(a.sent.map((s) => s.body), [{ paste: '\nworld' }]);
    assert.equal(a.text, 'hello\nworld');
    const b = pane({ text: 'hello', vim: true });
    assert.equal((await b.put('hello\tx')).status, 200);
    assert.deepEqual(b.sent.map((s) => s.body), [{ paste: '\tx' }]);
  });

  test('(+) append while Claude works (state busy) goes, and so does typing into an empty box', async () => {
    const a = pane({ text: 'hello', vim: true, state: 'busy' });
    assert.equal((await a.put('hello again')).status, 200);
    assert.deepEqual(sentKeys(a), ['text: again']);
    const b = pane({ text: '', vim: true, state: 'busy' });
    assert.equal((await b.put('queued note')).status, 200);
    assert.deepEqual(sentKeys(b), ['text:queued note']);
    const c = pane({ text: '', mem: { vim: false, plain: true }, state: null });
    assert.equal((await c.put('no registry state')).status, 200);
    for (const x of [a, b, c]) safe(x);
  });

  test('(+) an empty box in INSERT or plain memory: typed at once, no probe', async () => {
    for (const opts of [{ vim: true }, { mem: { vim: false, plain: true } }]) {
      const w = pane({ text: '', ...opts });
      const r = await w.put('hello');
      assert.deepEqual([r.status, r.body.typed, r.body.draft.text], [200, 5, 'hello']);
      assert.deepEqual(sentKeys(w), ['text:hello']);
    }
  });

  test('(+) M-3: a chunk boundary that falls on a space moves before it: no chunk ends in a space, and the write needs no `trailing` tolerance', async () => {
    const w = pane({ text: '', vim: true });
    const text = `${'x'.repeat(699)} ${'y'.repeat(60)}`; // the 700th character is a space
    const r = await w.put(text);
    assert.deepEqual([r.status, r.body.typed, r.body.draft.text.length], [200, 760, 760]);
    assert.deepEqual(w.sent.map((s) => s.body.text.length), [699, 61]);
    safe(w);
  });

  test('(−) M-3: spaces typed after the text in the terminal between two chunks are `trailing`, a refusal like any unreadable screen: 409 draft-mismatch, no more keys', async () => {
    const w = pane({ text: '', vim: true });
    w.afterType = () => { w.override = (p) => boxRows({ lines: visual(p.text), insert: true, cursor: { dx: 2 } }); }; // the cursor two columns past the text
    const r = await w.put('l1\nl2\nl3\nl4\nl5');
    assert.deepEqual([r.status, r.body.error], [409, 'draft-mismatch']);
    assert.deepEqual(sentKeys(w), ['paste:l1\nl2\n']);
    safe(w);
  });

  test('(+) a long text goes in chunks of at most 700 characters, 300 ms apart (fake clock)', async () => {
    const w = pane({ text: '', vim: true });
    const text = 'x'.repeat(800);
    const r = await w.put(text);
    assert.deepEqual([r.status, r.body.typed, r.body.draft.text.length], [200, 800, 800]);
    assert.deepEqual(w.sent.map((s) => s.body.text.length), [700, 100]);
    assert.ok(w.sent[1].t - w.sent[0].t >= 300, `chunks ${w.sent[1].t - w.sent[0].t} ms apart`);
    safe(w);
  });

  test('(+) chunks with newlines: each one is a paste of at most 2 newlines, the last without a newline an -l call', async () => {
    const w = pane({ text: '', vim: true });
    const text = 'l1\nl2\nl3\nl4\nl5';
    assert.equal((await w.put(text)).status, 200);
    assert.deepEqual(sentKeys(w), ['paste:l1\nl2\n', 'paste:l3\nl4\n', 'text:l5']);
    assert.equal(w.text, text);
    safe(w);
  });

  test('(+) append that is not a prefix, or a cursor that is not at the end, is a replace (needs idle): 409 not-idle while busy', async () => {
    const w = pane({ text: 'hello', vim: true, state: 'busy' });
    assert.equal((await w.put('help')).body.error, 'not-idle');
    const mid = pane({ text: 'hello', vim: true, state: 'busy', override: (p) => boxRows({ lines: [p.text], cursor: { dx: -2 }, insert: true }) });
    assert.equal((await mid.put('hello world')).body.error, 'not-idle');
    assert.deepEqual([...w.sent, ...mid.sent], []);
  });
});

describe('writeDraft: live screens pad every row with spaces (Claude 2.1.325, capture-pane -N)', () => {
  const fields = (d) => ({ state: d.state, mode: d.mode, text: d.text, cursorAtEnd: d.cursorAtEnd, sig: d.sig, reason: d.reason });

  test('(+) readDraft reads a padded screen as the unpadded one: empty box, text, wrapped text, a `!` box', () => {
    for (const lines of [[''], ['hello world'], ['x'.repeat(116), 'x'.repeat(14)], ['line one', 'line two']]) {
      for (const mode of ['prompt', 'bash']) {
        const cap = boxRows({ lines, mode, insert: true });
        const live = padded(cap);
        assert.ok(live.rows.some((r) => r.some((sp) => / {20}$/.test(sp.t))), 'the fixture really is padded');
        assert.deepEqual(fields(readDraft(live)), fields(readDraft(cap)), JSON.stringify([lines, mode]));
      }
    }
    const d = readDraft(padded(boxRows({ lines: ['hello world'], insert: true })));
    assert.deepEqual([d.text, d.cursorAtEnd], ['hello world', true]);
  });

  test('(+) a ghost placeholder or suggestion after the cursor still reads as an empty box / the typed text', () => {
    const empty = readDraft(padded(boxRows({ lines: [''], ghost: 'Try "fix the bug"', insert: true })));
    assert.deepEqual([empty.state, empty.text], ['empty', '']);
    const typed = readDraft(padded(boxRows({ lines: ['hel'], ghost: 'lo there', insert: true })));
    assert.deepEqual([typed.state, typed.text, typed.cursorAtEnd], ['text', 'hel', true]);
  });

  test('(−) spaces the user typed after the text are still `trailing`: the cursor column shows them', () => {
    const d = readDraft(padded(boxRows({ lines: ['hello'], cursor: { dx: 1 }, insert: true })));
    assert.deepEqual([d.state, d.reason], ['unreadable', 'trailing']);
  });

  test('(+) append in vim INSERT and in plain mode on a padded screen: only the new part, no Escape', async () => {
    for (const opts of [{ vim: true }, { mem: { vim: false, plain: true } }]) {
      const w = pane({ text: 'hello', padded: true, state: 'busy', ...opts });
      const r = await w.put('hello world');
      assert.deepEqual([r.status, r.body.typed, r.body.draft.text], [200, 6, 'hello world']);
      assert.deepEqual(w.sent.map((s) => s.body), [{ text: ' world' }]);
      safe(w);
    }
  });

  test('(+) typing into an empty padded box, and the replace roads, work as on an unpadded one', async () => {
    const a = pane({ text: '', vim: true, padded: true });
    assert.deepEqual([(await a.put('fresh')).status, a.text], [200, 'fresh']);
    const b = pane({ text: 'old text', vim: true, padded: true });
    assert.deepEqual([(await b.put('new text')).status, b.text], [200, 'new text']);
    const c = pane({ text: 'old text', mem: { vim: false, plain: true }, padded: true });
    assert.deepEqual([(await c.put('new text')).status, c.text], [200, 'new text']);
    for (const x of [a, b, c]) safe(x);
  });

  test('(+) the draft the page gets carries no padding', async () => {
    const w = pane({ text: 'hello', vim: true, padded: true });
    const r = await w.put('hello');
    assert.deepEqual([r.status, r.body.typed, r.body.draft.text], [200, 0, 'hello']);
  });
});

describe('writeDraft: replace', () => {
  test('(+) plain mode whose first Escape already clears the box: no second Escape (it would open Rewind on an empty box)', async () => {
    const w = pane({ text: 'hello', mem: { vim: false, plain: true }, oneEscape: true });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['Escape', 'text:bye']);
    safe(w);
  });

  test('(+) trailing spaces of the text are not typed: the box could not show them and the read-back would call it unreadable', async () => {
    const w = pane({ text: '', vim: true });
    const r = await w.put('hello   ');
    assert.deepEqual([r.status, r.body.typed, r.body.draft.state, r.body.draft.text], [200, 5, 'text', 'hello']);
    assert.deepEqual(sentKeys(w), ['text:hello']);
  });

  test('(−) the edit mode is unknown (plain and vim normal look the same): a text that extends the box is not typed as an append -- busy: 409 not-idle; idle: the probe goes first', async () => {
    const busy = pane({ text: 'hello', state: 'busy' });
    assert.equal((await busy.put('hello world')).body.error, 'not-idle');
    assert.deepEqual(busy.sent, []);
    const idle = pane({ text: 'hello', vim: true, vimMode: 'normal' });
    assert.equal((await idle.put('hello world')).status, 200);
    assert.deepEqual(sentKeys(idle).slice(0, 2), ['text:i', 'Escape'], 'vim normal mode would take the suffix as vim commands');
    safe(idle);
  });

  test('(+) vim INSERT: Escape, wait until INSERT is gone and 40 ms passed, ggdG, i, the text', async () => {
    const w = pane({ text: 'hello', vim: true, escLag: 2 });
    const r = await w.put('bye');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.typed, r.body.draft.text, r.body.draft.edit], [3, 'bye', 'insert']);
    assert.deepEqual(sentKeys(w), ['Escape', 'text:ggdG', 'text:i', 'text:bye']);
    assert.ok(w.sent[1].t - w.sent[0].t >= 40, 'ggdG waited for the redraw and 40 ms');
    assert.ok(w.slept.filter((ms) => ms === 20).length >= 3, 'polled every 20 ms while INSERT was still shown');
    assert.deepEqual(w.stateArgs.filter(Boolean), [{ fresh: true }], 'one fresh registry read, right before the Escape');
    assert.deepEqual(w.edits, ['vim']);
    safe(w);
  });

  test('(+) plain memory: Escape, at least 60 ms, Escape, the empty box, the text', async () => {
    const w = pane({ text: 'hello', mem: { vim: false, plain: true } });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text, r.body.draft.edit], [200, 'bye', 'plain']);
    assert.deepEqual(sentKeys(w), ['Escape', 'Escape', 'text:bye']);
    assert.ok(w.sent[1].t - w.sent[0].t >= 60, `Escapes ${w.sent[1].t - w.sent[0].t} ms apart`);
    safe(w);
  });

  test('(+) clearing to nothing (text empty) in plain memory: two Escapes, no text', async () => {
    const w = pane({ text: 'hello', mem: { vim: false, plain: true } });
    const r = await w.put('');
    assert.deepEqual([r.status, r.body.typed, r.body.draft.state], [200, 0, 'empty']);
    assert.deepEqual(sentKeys(w), ['Escape', 'Escape']);
    safe(w);
  });

  test('(+) nothing shows the mode, vim normal: the probe i shows INSERT, the vim road follows, the memory becomes vim', async () => {
    const w = pane({ text: 'hello', vim: true, vimMode: 'normal' });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['text:i', 'Escape', 'text:ggdG', 'text:i', 'text:bye']);
    assert.deepEqual(w.edits, ['vim']);
    assert.deepEqual(w.mem, { vim: true, plain: false });
    safe(w);
  });

  test('(+) nothing shows the mode, plain: the probe i lands as text, the memory becomes plain, the two Escapes wipe it', async () => {
    const w = pane({ text: 'hello' });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['text:i', 'Escape', 'Escape', 'text:bye']);
    assert.deepEqual(w.edits, ['plain']);
    assert.deepEqual(w.mem, { vim: false, plain: true });
    safe(w);
  });

  test('(+) the memory says vim normal but vim is off (an i lands as text): the probe flips it to plain', async () => {
    const w = pane({ text: 'hello', mem: { vim: true, plain: false } });
    const r = await w.put('bye');
    assert.equal(r.status, 200);
    assert.deepEqual(w.edits, ['plain']);
    assert.deepEqual(sentKeys(w), ['text:i', 'Escape', 'Escape', 'text:bye']);
  });

  test('(+) an empty box and nothing known: probe i; vim: INSERT then the text; plain: the i is removed with one C-u first', async () => {
    const vim = pane({ text: '', vim: true, vimMode: 'normal' });
    assert.equal((await vim.put('hello')).status, 200);
    assert.deepEqual(sentKeys(vim), ['text:i', 'text:hello']);
    assert.deepEqual(vim.edits, ['vim']);
    const plain = pane({ text: '' });
    const r = await plain.put('hello');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'hello']);
    assert.deepEqual(sentKeys(plain), ['text:i', 'C-u', 'text:hello']);
    assert.deepEqual(plain.edits, ['plain']);
    safe(vim);
    safe(plain);
  });

  test('(+) the glyph: an empty `!` box and a text that is not a shell command: one BSpace, then the text', async () => {
    const w = pane({ text: '', glyph: 'bash', vim: true });
    const r = await w.put('hello');
    assert.deepEqual([r.status, r.body.draft.mode, r.body.draft.text], [200, 'prompt', 'hello']);
    assert.deepEqual(sentKeys(w), ['BSpace', 'text:hello']);
    safe(w);
  });

  test('(+) the glyph: a text that starts with ! onto an empty `!` box is typed without its !', async () => {
    const w = pane({ text: '', glyph: 'bash', vim: true });
    const r = await w.put('!ls -la');
    assert.deepEqual([r.status, r.body.draft.mode, r.body.draft.text], [200, 'bash', 'ls -la']);
    assert.deepEqual(sentKeys(w), ['text:ls -la']);
  });

  test('(+) the glyph: a text with ! onto an empty prompt box is typed as it is (the ! moves to the glyph); append in a `!` box', async () => {
    const w = pane({ text: '', vim: true });
    const r = await w.put('!ls');
    assert.deepEqual([r.status, r.body.draft.mode, r.body.draft.text], [200, 'bash', 'ls']);
    assert.deepEqual(sentKeys(w), ['text:!ls']);
    const a = pane({ text: 'ls', glyph: 'bash', vim: true });
    const ar = await a.put('!ls -la');
    assert.deepEqual([ar.status, ar.body.draft.text], [200, 'ls -la']);
    assert.deepEqual(sentKeys(a), ['text: -la']);
  });

  test('(+) a `!` draft replaced by a prompt text: two Escapes, BSpace to leave the `!` box, the text', async () => {
    const w = pane({ text: 'ls -la', glyph: 'bash', mem: { vim: false, plain: true } });
    const r = await w.put('hello');
    assert.deepEqual([r.status, r.body.draft.mode, r.body.draft.text], [200, 'prompt', 'hello']);
    assert.deepEqual(sentKeys(w), ['Escape', 'Escape', 'BSpace', 'text:hello']);
    safe(w);
  });

  test('(−) a `!` draft is not appended to as a prompt one: a text without the ! is a replace', async () => {
    const w = pane({ text: 'ls', glyph: 'bash', vim: true, state: 'busy' });
    assert.equal((await w.put('ls -la')).body.error, 'not-idle');
  });
});

describe('writeDraft: what changes on screen while it writes (T51 and the user in the terminal)', () => {
  const three = 'l1\nl2\nl3\nl4\nl5'; // three chunks

  test('(−) T51: a prompt appears before the third chunk: 409 screen-changed, the third chunk is never sent, no Enter ever', async () => {
    const w = pane({ text: '', vim: true, before: (n, p) => { if (n === 4) p.prompt = true; } });
    const r = await w.put(three);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'screen-changed');
    assert.equal(r.body.draft, null);
    assert.deepEqual(sentKeys(w), ['paste:l1\nl2\n', 'paste:l3\nl4\n']);
    safe(w);
  });

  test('(−) T51: a prompt appears before the second chunk, and before the first key: nothing more is typed', async () => {
    const second = pane({ text: '', vim: true, before: (n, p) => { if (n === 3) p.prompt = true; } });
    assert.equal((await second.put(three)).body.error, 'screen-changed');
    assert.deepEqual(sentKeys(second), ['paste:l1\nl2\n']);
    const first = pane({ text: '', vim: true, before: (n, p) => { if (n === 2) p.prompt = true; } });
    assert.equal((await first.put(three)).body.error, 'screen-changed');
    assert.deepEqual(first.sent, [], 'the capture right before the first key already showed it');
    safe(second);
  });

  test('(−) T51: a prompt appears while the vim clear waits for INSERT to go: no ggdG, no i, no text typed into it', async () => {
    const w = pane({ text: 'hello', vim: true, escLag: 3, before: (n, p) => { if (n === 4) p.prompt = true; } });
    const r = await w.put('bye');
    assert.equal(r.body.error, 'screen-changed');
    assert.deepEqual(sentKeys(w), ['Escape']);
    safe(w);
  });

  test('(−) T51: a dialog that hides the mode line between chunks is the same: the box is gone, 409 screen-changed', async () => {
    const w = pane({ text: '', vim: true, before: (n, p) => { if (n === 3) p.override = () => boxRows({ lines: ['l1'], footer: 'some footer nobody recognises' }); } });
    assert.equal((await w.put(three)).body.error, 'screen-changed');
    assert.equal(w.sent.length, 1);
  });

  test('(−) the user types in the terminal between two chunks: 409 screen-changed with the screen\'s draft; the page pulls it', async () => {
    const w = pane({ text: '', vim: true, before: (n, p) => { if (n === 3) p.text += 'X'; } });
    const r = await w.put(three);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'screen-changed');
    assert.equal(r.body.draft.text, 'l1\nl2\nX');
    assert.equal(w.sent.length, 1);
    safe(w);
  });

  test('(−) the user types in the terminal before an append\'s first key: nothing is typed on top of it', async () => {
    const w = pane({ text: 'hello', vim: true, before: (n, p) => { if (n === 2) p.text = 'hello!'; } });
    const r = await w.put('hello world');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'screen-changed', 'hello!']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) the read-back differs: 409 draft-mismatch with the screen\'s draft', async () => {
    const w = pane({ text: '', vim: true, swallow: (s) => s.slice(0, -1) });
    const r = await w.put('bye');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'draft-mismatch');
    assert.equal(r.body.draft.text, 'by');
    assert.equal(w.n, 1 + 1 + 4, 'the capture, the pre-key check and four read-back polls');
    safe(w);
  });

  test('(−) the read-back is unreadable (a chunk turned into a placeholder): 409 draft-mismatch with state unreadable', async () => {
    const w = pane({ text: '', vim: true, afterType: (b, p) => { p.override = () => boxRows({ lines: ['[Pasted text #1 +3 lines]'] }); } });
    const r = await w.put('hello');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'draft-mismatch');
    assert.deepEqual([r.body.draft.state, r.body.draft.reason], ['unreadable', 'pasted']);
  });

  test('(−) the box turns unreadable between two chunks (our own text made a placeholder): 409 draft-mismatch, no more chunks', async () => {
    const w = pane({ text: '', vim: true, before: (n, p) => { if (n === 3) p.override = () => boxRows({ lines: ['[Pasted text #1 +3 lines]'] }); } });
    const r = await w.put(three);
    assert.deepEqual([r.status, r.body.error, r.body.draft.state], [409, 'draft-mismatch', 'unreadable']);
    assert.equal(w.sent.length, 1);
  });

  test('(−) a clear that does not clear: vim 409 draft-mismatch after the 400 ms wait, plain after the 600 ms wait; both forget the pane\'s edit mode', async () => {
    const vim = pane({ text: 'hello', vim: true });
    const keep = vim.keys.send;
    vim.keys.send = async (id, body) => { const r = await keep(id, body); if (body.text === 'ggdG') vim.text = 'hello'; return r; }; // ggdG does nothing
    const rv = await vim.put('bye');
    assert.deepEqual([rv.status, rv.body.error], [409, 'draft-mismatch']);
    assert.deepEqual(vim.edits, ['vim', 'none'], 'INSERT was seen, then the road failed');
    const plain = pane({ text: 'hello', mem: { vim: false, plain: true } });
    plain.keys.send = async (id, body) => { plain.sent.push({ body, t: plain.t, state: 'idle' }); return { status: 200, body: {} }; }; // Escape does nothing
    const rp = await plain.put('bye');
    assert.deepEqual([rp.status, rp.body.error], [409, 'draft-mismatch']);
    assert.deepEqual(plain.edits, ['none']);
    assert.deepEqual(sentKeys(plain), ['Escape', 'Escape'], 'no text typed over the old draft');
  });

  test('(−) INSERT never goes away after the Escape: 409 mode-unknown, no ggdG', async () => {
    const w = pane({ text: 'hello', vim: true, escLag: 100 });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error], [409, 'mode-unknown']);
    assert.deepEqual(sentKeys(w), ['Escape']);
  });

  test('(−) the probe i neither shows INSERT nor lands as text: 409 screen-changed, nothing else is sent', async () => {
    const w = pane({ text: 'hello', swallow: () => '' });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error], [409, 'screen-changed']);
    assert.deepEqual(sentKeys(w), ['text:i']);
  });

  test('(−) a failed capture before a key: its own status and body, nothing more is sent', async () => {
    const w = pane({ text: '', vim: true });
    const base = w.mirror.capture;
    w.mirror.capture = async (...a) => (w.n >= 1 ? { status: 404, body: { error: 'not_found', message: 'gone' } } : base(...a));
    const r = await w.put('hello');
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) a 429 on the third key stops the sequence; the answer is the 429 plus the screen\'s draft', async () => {
    const w = pane({ text: 'hello', vim: true, failSend: (b, n) => (n === 3 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null) });
    const r = await w.put('bye');
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'busy');
    assert.equal(typeof r.body.draft.sig, 'string');
    assert.deepEqual(sentKeys(w), ['Escape', 'text:ggdG', 'text:i']);
    safe(w);
  });

  test('(−) a tmux failure on the first chunk: 5xx relayed, the draft read once more, no further key', async () => {
    const w = pane({ text: '', vim: true, failSend: () => ({ status: 502, body: { error: 'tmux_failed', message: 'x' } }) });
    const r = await w.put('hello');
    assert.deepEqual([r.status, r.body.error, r.body.draft.state], [502, 'tmux_failed', 'empty']);
    assert.equal(w.sent.length, 1);
  });
});

describe('writeDraft: the per-pane lock is shared with the other controls', () => {
  const holdCapture = (w) => {
    let release;
    w.hold = new Promise((r) => { release = r; });
    return () => { w.hold = null; release(); };
  };

  test('(−) a write while End runs on the pane is 409 busy-switching and sends nothing', async () => {
    const w = pane({ text: '', vim: true });
    const release = holdCapture(w);
    const sc = w.control();
    const end = sc.endSession('%2');
    await tick();
    assert.deepEqual(await sc.writeDraft('%2', { text: 'hi', base: '' }), code(409, 'busy-switching'));
    release();
    await end;
    assert.ok(!sentKeys(w).includes('text:hi'));
  });

  test('(−) End, a command and a mode switch while a write runs are 409 busy-switching; another pane is not blocked', async () => {
    const w = pane({ text: '', vim: true });
    const release = holdCapture(w);
    const sc = w.control();
    const write = sc.writeDraft('%2', { text: 'hi', base: w.sig() });
    await tick();
    assert.deepEqual(await sc.endSession('%2'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.runCommand('%2', '/compact'), code(409, 'busy-switching'));
    assert.deepEqual(await sc.switchMode('%2', 'plan'), code(409, 'busy-switching'));
    release();
    assert.equal((await write).status, 200);
    assert.equal((await sc.writeDraft('%2', { text: 'hi again', base: w.sig() })).status, 200, 'the lock is released after the write');
  });
});

describe('writeDraft: the cursor must be inside the box that was read (second layer behind the parser, I-1)', () => {
  const NB = '\u00a0';
  const dashes = () => [span('\u2500'.repeat(COLS), { fg: 244 })];
  /** Claude's real box with `real` in it, then a user status line that looks like a box: `❯<NB>main` and a row of dashes below it. */
  const statusBox = (real = 'hello') => {
    const cap = boxRows({ lines: [real], insert: true });
    const [top, row, lower, ...rest] = cap.rows;
    return { ...cap, rows: [top, row, lower, [span(`\u276f${NB}`), span('main')], dashes(), ...rest] }; // the cursor stays in the real box (y = 1)
  };

  test('(−) a status line that parses as a box while the cursor sits in the real box above: nothing is sent, 409 input-unreadable', async () => {
    const screen = statusBox();
    const fake = readDraft(screen);
    assert.deepEqual([fake.state, fake.text, fake.box], ['text', 'main', { top: 2, bottom: 4 }], 'the fixture: the parser reads the status line as the box');
    assert.ok(screen.cursor.y < fake.box.top, 'and the cursor is outside it');
    for (const mem of [{ vim: true, plain: false }, { vim: false, plain: true }]) {
      for (const next of ['main and more', 'other text', '']) { // append, replace, clear
        const w = pane({ text: 'hello', mem, override: () => screen });
        const r = await w.put(next, fake.sig);
        assert.deepEqual([r.status, r.body.error, r.body.draft], [409, 'input-unreadable', null], JSON.stringify([mem, next]));
        assert.deepEqual(w.sent, [], 'not one key reached the real input');
        safe(w);
      }
    }
  });

  test('(−) a write into an empty fake box (a status line over an empty real box) types nothing either', async () => {
    const screen = statusBox('');
    const fake = readDraft(screen);
    const w = pane({ text: '', vim: true, override: () => screen });
    const r = await w.put('hello', fake.sig);
    assert.deepEqual([r.status, r.body.error, w.sent], [409, 'input-unreadable', []]);
  });

  test('(−) the cursor leaves the box between two chunks: the next chunk is not sent, 409 screen-changed', async () => {
    const w = pane({ text: '', vim: true });
    w.afterType = (body) => { // after the first paste the screen shows the same text with the cursor on the row above the box
      w.override = (p) => boxRows({ lines: visual(p.text), insert: true, cursor: { y: 0 } });
      return body;
    };
    const r = await w.put('l1\nl2\nl3\nl4\nl5');
    assert.deepEqual([r.status, r.body.error, r.body.draft], [409, 'screen-changed', null], 'no draft: the page does not adopt a box the cursor is not in');
    assert.deepEqual(sentKeys(w), ['paste:l1\nl2\n']);
    safe(w);
  });

  test('(+) normal writes are unchanged: empty box, one row, three rows, plain memory', async () => {
    for (const opts of [{ text: '', vim: true }, { text: 'hello', vim: true }, { text: 'a\nb\nc', vim: true }, { text: 'hello', mem: { vim: false, plain: true } }]) {
      const w = pane(opts);
      const r = await w.put(`${opts.text} more`.trim());
      assert.equal(r.status, 200, JSON.stringify(opts));
      safe(w);
    }
  });

  test('(−) no cursor at all (the capture lost it), or on a rule row of the box: nothing is sent', async () => {
    // one text row: the top rule is row 0, the text row 1, the lower rule row 2
    for (const cursor of [null, { y: 0 }, { y: 2 }, { y: 3 }]) {
      const w = pane({ text: 'hello', vim: true, override: (p) => boxRows({ lines: [p.text], insert: true, cursor }) });
      const r = await w.put('hello again', readDraft(w.screen()).sig);
      assert.deepEqual([r.status, r.body.error, w.sent], [409, 'input-unreadable', []], JSON.stringify(cursor));
    }
  });
});

describe('writeDraft: Stop runs apart from the lock (M-2)', () => {
  // Stop's Escape is held in flight; a chunk right behind an Escape would be read as Meta+key, so nothing may go out meanwhile
  const stopInFlight = (w) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = w.keys.send;
    w.keys.send = async (id, body) => { if (body.keys?.includes('Escape')) await gate; return inner(id, body); };
    return release;
  };

  test('(−) an append that is due while Stop interrupts the pane sends nothing: 409 not-idle', async () => {
    const w = pane({ text: 'hello', vim: true, state: 'busy' });
    const release = stopInFlight(w);
    const sc = w.control();
    const stop = sc.stop('%2');
    await tick();
    const r = await sc.writeDraft('%2', { text: 'hello again', base: w.sig() });
    assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
    assert.deepEqual(w.sent, [], 'nothing went out behind the Escape');
    release();
    await stop;
    assert.deepEqual(sentKeys(w).slice(0, 1), ['Escape']);
    assert.ok(!sentKeys(w).includes('text: again'));
  });

  test('(−) typing into an empty box obeys the same gate; (+) after Stop ended the append goes', async () => {
    const w = pane({ text: '', vim: true, state: 'busy' });
    const release = stopInFlight(w);
    const sc = w.control();
    const stop = sc.stop('%2');
    await tick();
    assert.equal((await sc.writeDraft('%2', { text: 'queued note', base: w.sig() })).body.error, 'not-idle');
    assert.deepEqual(w.sent, []);
    release();
    await stop;
    w.state = 'busy';
    const r = await sc.writeDraft('%2', { text: 'queued note', base: w.sig() });
    assert.deepEqual([r.status, r.body.typed], [200, 11]);
  });
});

describe('End and the commands read the box with src/draft.js', () => {
  // the End / command paths are covered in session-control.test.js; here, the cases the parser changed (spike S9 contradictions 2, 3, 5, 8)
  const asEnd = (w) => w.control().endSession('%2');
  const asCommand = (w) => w.control().runCommand('%2', '/compact');

  test('(−) a `!` box (bash mode) is 409 input-not-empty with a message that says so; nothing is typed', async () => {
    for (const run of [asEnd, asCommand]) {
      const w = pane({ text: 'ls -la', glyph: 'bash', vim: true });
      const r = await run(w);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, 'input-not-empty');
      assert.match(r.body.message, /! mode/);
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a box that shows an old history entry is 409 input-unreadable; nothing is typed', async () => {
    for (const run of [asEnd, asCommand]) {
      const w = pane({ text: 'an old prompt', history: true, vim: true });
      assert.deepEqual(await run(w), code(409, 'input-unreadable'));
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a pasted block, a tall draft and trailing spaces are drafts: 409 input-not-empty; nothing is typed', async () => {
    const screens = [
      () => boxRows({ lines: ['[Pasted text #1 +3 lines]'] }),
      () => boxRows({ lines: Array.from({ length: 14 }, (_, i) => `row ${i}`) }),
      () => boxRows({ lines: ['hello'], cursor: { dx: 3 } }),
    ];
    for (const override of screens) {
      const w = pane({ override });
      assert.deepEqual(await asEnd(w), code(409, 'input-not-empty'));
      assert.deepEqual(w.sent, []);
    }
  });

  test('(+) a dim suggestion (prompt suggestion) is an empty box: a command is typed after it, as for the placeholder', async () => {
    const w = pane({ text: '', vim: true, override: (p) => boxRows({ lines: [p.text], ghost: p.text === '' ? 'run the tests' : null, insert: true }) });
    const r = await asCommand(w);
    assert.equal(r.status, 200);
    assert.deepEqual(sentKeys(w), ['text:/compact', 'Enter'], 'vim INSERT is shown: the whole command at once');
  });

  test('(−) M-4: `/exit` followed by a ghost completion is not "what nika typed": End presses no Enter (409 not-at-prompt)', async () => {
    const w = pane({ text: '', vim: true, override: (p) => boxRows({ lines: [p.text], ghost: p.text === '/exit' ? ' now' : null, insert: true }) });
    const r = await asEnd(w);
    assert.deepEqual([r.status, r.body.error], [409, 'not-at-prompt']);
    assert.ok(!sentKeys(w).includes('Enter'), sentKeys(w).join(','));
    const c = pane({ text: '', vim: true, override: (p) => boxRows({ lines: [p.text], ghost: p.text === '/compact' ? ' now' : null, insert: true }) });
    assert.equal((await asCommand(c)).status, 409);
    assert.ok(!sentKeys(c).includes('Enter'), 'a command is read the same way');
  });

  test('(+) M-4: without a ghost the same End goes; and the draft route keeps its tolerance for a ghost after typed text', async () => {
    const w = pane({ text: '', vim: true });
    assert.equal((await asEnd(w)).status, 200);
    assert.ok(sentKeys(w).includes('Enter'));
    const d = pane({ text: 'hel', vim: true, override: (p) => boxRows({ lines: [p.text], ghost: ' there', insert: true }) });
    const r = await d.put('hello');
    assert.deepEqual([r.status, r.body.typed, r.body.draft.text], [200, 2, 'hello'], 'a completion ghost does not stop a draft write: it never presses Enter');
    assert.deepEqual(d.sent.map((s) => s.body), [{ text: 'lo' }]);
  });

  test('(−) a box under a footer nobody recognises is a dialog for End: 409 mode-unknown, nothing typed', async () => {
    const w = pane({ override: () => boxRows({ lines: ['x'], footer: 'some footer nobody recognises' }) });
    assert.deepEqual(await asEnd(w), code(409, 'mode-unknown'));
    assert.deepEqual(w.sent, []);
  });
});
