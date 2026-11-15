// writeDraft (design W5 sections 3, 7, 8, 9): the controller that types a draft into Claude's input box. A fake pane
// models the box (plain and vim input, the `!` glyph, the Escape rules of spike S9) and records every key with the fake
// clock and the registry state at that moment; `safe()` then asserts, for every case, what must never go out. Synthetic text only.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl, checkDraftBody, checkSubmitBody, readDraft } from '../src/session-control.js';
import { parseDraft } from '../src/draft.js';
import { boxRows, span } from './helpers.js';
import { dialogWorld, TAB } from './dialog-fake.js';

const COLS = 120;
const W = COLS - 4;
const NEVER = ['Enter', 'C-c', 'Up', 'Down', 'BTab', 'C-k'];
const PROMPT = ['Bash command', '  run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];
const BYPASS_PROMPT = ['Bash command', '  run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and bypass permissions for this session', '  3. No', 'Esc to cancel'];
const tick = () => new Promise((r) => setImmediate(r));

// 0.5, W13: the Escape recorder. Every fake pane of a test is listed here; a draft write or a submit that sends an Escape while the fake registry
// does not say idle fails the test (a pane built for Stop or End, which interrupt on purpose, says `stopSends`). Only the C-u road works while Claude works.
const made = [];
afterEach(() => {
  for (const p of made.splice(0)) assert.deepEqual(p.badEscapes, [], 'no Escape went out while the registry was not idle (it would interrupt the turn)');
});

// Claude's question and plan dialogs (0.5, W1): the input box under them is not a draft box, so nothing is typed (promptOpen)
const DIALOGS = {
  ask: { phase: 'ask' }, multi: { phase: 'ask', tabs: [TAB.tools] }, review: { phase: 'review', tabs: [TAB.project, TAB.tools] },
  plan: { phase: 'plan' }, exit: { phase: 'exit' }, nudge: { phase: 'nudge' },
};
const dialogScreen = (name) => () => dialogWorld(DIALOGS[name]).screen();

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
    // 0.5, W13: where the cursor sits ({ row, col } in the box, null = after the text), vim NORMAL's cursor one column left of the end (`left`),
    // the break space a C-u leaves behind a wrapped row (`breakSpace`: the cursor then sits one column past the text), Claude's queued-messages
    // placeholder (`queuedMsgs`), keys that do nothing (`swallowCu`, `swallowEnd`, `swallowEnter`), C-u that removes only `cuStep` characters, the
    // Enters that were taken (`submitted`) and the Escapes that went out while the registry did not say idle (`badEscapes`)
    cursorAt: null, left: 0, breakSpace: false, trail: false, queuedMsgs: false, ghost: null, swallowCu: false, swallowEnd: false, swallowEnter: false,
    cuStep: 0, submitted: [], badEscapes: [], stopSends: false, freshSeq: null,
    ...opts,
  };
  made.push(w);
  w.screen = () => {
    if (w.override) return w.override(w);
    if (w.prompt) return { rows: PROMPT.map((t) => (t ? [span(t)] : [])), cursor: { x: 0, y: 0, visible: true }, cols: COLS };
    let cursor;
    if (w.cursorAt && w.text !== '') cursor = { x: 2 + w.cursorAt.col, y: (w.armed ? 1 : 0) + 1 + w.cursorAt.row };
    else if (w.trail) cursor = { dx: 1 };
    else if (w.left && w.text !== '') cursor = { dx: -w.left };
    const cap = boxRows({
      cols: COLS, lines: w.text === '' ? [''] : visual(w.text), mode: w.glyph, insert: w.vim && (w.vimMode === 'insert' || w.lag > 0),
      label: w.history ? 'History 3/3' : null, hint: w.armed ? 'Esc again to clear' : null, cursor,
      ghost: w.ghost ?? (w.queuedMsgs && w.text === '' ? 'Press up to edit queued messages' : null),
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
    if (w.text === '') w.cursorAt = null;
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
    } else if (k === 'C-u') killRow();
    else if (k === 'End') toEnd();
    else if (k === 'Enter') submit();
  };
  // text offset where each visual row starts, and the { row, col } (null = the text end) of an offset: the cursor of a C-u that is not at the text end
  const rowStarts = (text) => { let off = 0; return text.split('\n').flatMap((line) => { const out = []; for (let i = 0; i < Math.max(line.length, 1); i += W) out.push(off + i); off += line.length + 1; return out; }); };
  const cursorFor = (text, off) => {
    if (off >= text.length) return null;
    const starts = rowStarts(text);
    const row = starts.findLastIndex((st) => st <= off);
    return { row, col: off - starts[row] };
  };
  // C-u kills from the cursor (at the text end by default) to the start of its VISUAL row; at a row start it removes the newline before it (spike W13 section 1)
  const killRow = () => {
    if (w.swallowCu || w.text === '') return;
    if (w.cursorAt) { // a cursor inside the text: only what is left of it goes, the cursor then sits where the cut was
      const starts = rowStarts(w.text);
      const at = starts[w.cursorAt.row] + w.cursorAt.col;
      const from = w.cursorAt.col === 0 ? Math.max(at - 1, 0) : starts[w.cursorAt.row];
      w.text = w.text.slice(0, from) + w.text.slice(at);
      w.cursorAt = cursorFor(w.text, from);
      return;
    }
    const last = visual(w.text).at(-1);
    if (last === '') { w.text = w.text.slice(0, -1); w.trail = false; return; }
    const cut = w.cuStep > 0 ? Math.min(w.cuStep, last.length) : last.length;
    const soft = w.text.length > last.length && w.text[w.text.length - last.length - 1] !== '\n';
    w.text = w.text.slice(0, w.text.length - cut);
    w.trail = soft && w.breakSpace && cut === last.length;
    w.left = 0;
  };
  // End goes to the end of the cursor's VISUAL row: the text end only from the last row (spike W13 section 2)
  const toEnd = () => {
    if (w.swallowEnd) return;
    const rows = visual(w.text);
    if (w.cursorAt === null) w.left = 0;
    else w.cursorAt = w.cursorAt.row >= rows.length - 1 ? null : { row: w.cursorAt.row, col: rows[w.cursorAt.row].length };
  };
  // Enter submits the box; while Claude works (any registry state but idle) it queues the message and shows the placeholder
  const submit = () => {
    if (w.swallowEnter) return;
    w.submitted.push(w.text);
    Object.assign(w, { text: '', glyph: 'prompt', cursorAt: null, trail: false, left: 0, armed: false });
    if ((w.freshState ?? w.state) !== 'idle') w.queuedMsgs = true;
    w.afterEnter?.(w);
  };
  w.keys = {
    async send(id, body) {
      w.sent.push({ body, t: w.t, state: w.freshState ?? w.state });
      if (body.keys?.includes('Escape') && (w.freshState ?? w.state) !== 'idle' && !w.stopSends) w.badEscapes.push(w.sent.length);
      const failed = w.failSend?.(body, w.sent.length);
      if (failed) return failed;
      for (const k of body.keys ?? []) press(k);
      if (body.text !== undefined) typeText(body.text);
      if (body.paste !== undefined) typeText(body.paste);
      w.afterType?.(body, w);
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 0 } } };
    },
  };
  // freshSeq: the answers of the successive fresh reads (the last one stays), for a state that changes between two reads
  w.stateOf = async (id, o) => {
    w.stateArgs.push(o);
    if (o?.fresh && w.freshSeq) return w.freshSeq.length > 1 ? w.freshSeq.shift() : w.freshSeq[0];
    return o?.fresh && w.freshState !== null ? w.freshState : w.state;
  };
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
const PLAIN = { mem: { vim: false, plain: true } };
// 0.5, W13: a replace clears with Escape only when the cursor is on an EARLIER row of the box (End would stop at the end of that row) and the registry says idle
const earlier = { text: 'one\ntwo', cursorAt: { row: 0, col: 1 } };

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

  test('(−) a question, review, plan, "Exit plan mode?" or nudge dialog on screen: 409 not-idle, one capture, nothing sent', async () => {
    for (const name of Object.keys(DIALOGS)) {
      const w = pane({ text: 'hello', override: dialogScreen(name) });
      assert.deepEqual(await w.control().writeDraft('%2', { text: 'bye', base: '' }), code(409, 'not-idle'), name);
      assert.deepEqual(w.sent, [], name);
      assert.equal(w.n, 1, name);
    }
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

  test('(−) a replace on an earlier row while Claude works (or has no live session) is 409 cursor-not-at-end with the draft; nothing is sent, so no Escape (W13: the last row clears with C-u instead)', async () => {
    for (const state of ['busy', 'waiting', null]) {
      const w = pane({ ...earlier, vim: true, state });
      const r = await w.put('bye');
      assert.equal(r.status, 409, String(state));
      assert.equal(r.body.error, 'cursor-not-at-end');
      assert.equal(r.body.draft.text, 'one\ntwo');
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) idle in the cached read but busy in the fresh read (an earlier row): 409 cursor-not-at-end, ZERO keys -- not even the probe i -- in every edit mode', async () => {
    for (const [name, o] of [['vim INSERT', { vim: true }], ['plain', PLAIN], ['unknown', {}], ['vim NORMAL', { vim: true, vimMode: 'normal' }]]) {
      const w = pane({ ...earlier, state: 'idle', freshState: 'busy', ...o });
      const r = await w.put('bye');
      assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'cursor-not-at-end', 'one\ntwo'], name);
      assert.deepEqual(w.stateArgs.filter(Boolean), [{ fresh: true }], `${name}: one registry read, and it skips the cache`);
      assert.deepEqual(w.sent, [], name);
    }
  });

  test('(−) idle at the road decision but busy at the Escape\'s own fresh read: 409 not-idle, no Escape (vim and plain)', async () => {
    for (const opts of [{ vim: true }, { mem: { vim: false, plain: true } }]) {
      const w = pane({ ...earlier, freshSeq: ['idle', 'busy'], ...opts });
      const r = await w.put('bye');
      assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
      assert.deepEqual(w.stateArgs.filter(Boolean), [{ fresh: true }, { fresh: true }], 'the road decision, then right before the Escape');
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

  test('(−) M-1: plain memory and the cursor on an empty last row cannot tell INSERT from vim NORMAL: no append, the replace road (C-u, no probe), never the suffix as literal keys', async () => {
    const w = pane({ text: 'hello\n', mem: { vim: false, plain: true } });
    const d = readDraft(w.screen());
    assert.deepEqual([d.text, d.cursorAtEnd], ['hello\n', true], 'the fixture: an end cursor on an empty last row');
    const r = await w.put('hello\nworld');
    assert.equal(r.status, 200);
    assert.deepEqual(w.sent.map((s) => s.body), [{ keys: ['C-u'] }, { keys: ['C-u'] }, { paste: 'hello\nworld' }], 'W13: the C-u road (the newline goes on its own press), still no probe and never the suffix alone');
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

  test('(+) append that is not a prefix, or a cursor that is not at the end, is a replace: while busy it clears with C-u (End first when the cursor is not at the end), never with Escape', async () => {
    const w = pane({ text: 'hello', vim: true, state: 'busy' });
    assert.equal((await w.put('help')).status, 200);
    assert.deepEqual(sentKeys(w), ['C-u', 'text:help']);
    const mid = pane({ text: 'hello', vim: true, state: 'busy', cursorAt: { row: 0, col: 3 } });
    assert.equal((await mid.put('hello world')).status, 200);
    assert.deepEqual(sentKeys(mid), ['End', 'C-u', 'text:hello world']);
    for (const x of [w, mid]) safe(x);
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
    const w = pane({ ...earlier, ...PLAIN, oneEscape: true });
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

  test('(−) the edit mode is unknown (plain and vim normal look the same): a text that extends the box is not typed as an append -- the probe goes first, busy or idle (W13: the C-u road follows)', async () => {
    const busy = pane({ text: 'hello', state: 'busy' });
    assert.equal((await busy.put('hello world')).status, 200);
    assert.deepEqual(sentKeys(busy), ['text:i', 'C-u', 'text:hello world']);
    const idle = pane({ text: 'hello', vim: true, vimMode: 'normal' });
    assert.equal((await idle.put('hello world')).status, 200);
    assert.deepEqual(sentKeys(idle).slice(0, 2), ['text:i', 'C-u'], 'vim normal mode would take the suffix as vim commands');
    safe(busy);
    safe(idle);
  });

  test('(+) vim INSERT: Escape, wait until INSERT is gone and 40 ms passed, ggdG, i, the text', async () => {
    const w = pane({ ...earlier, vim: true, escLag: 2 });
    const r = await w.put('bye');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.typed, r.body.draft.text, r.body.draft.edit], [3, 'bye', 'insert']);
    assert.deepEqual(sentKeys(w), ['Escape', 'text:ggdG', 'text:i', 'text:bye']);
    assert.ok(w.sent[1].t - w.sent[0].t >= 40, 'ggdG waited for the redraw and 40 ms');
    assert.ok(w.slept.filter((ms) => ms === 20).length >= 3, 'polled every 20 ms while INSERT was still shown');
    assert.deepEqual(w.stateArgs.filter(Boolean), [{ fresh: true }, { fresh: true }], 'two fresh registry reads: the road decision, then right before the Escape');
    assert.deepEqual(w.edits, ['vim']);
    safe(w);
  });

  test('(+) plain memory: Escape, at least 60 ms, Escape, the empty box, the text', async () => {
    const w = pane({ ...earlier, ...PLAIN });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text, r.body.draft.edit], [200, 'bye', 'plain']);
    assert.deepEqual(sentKeys(w), ['Escape', 'Escape', 'text:bye']);
    assert.ok(w.sent[1].t - w.sent[0].t >= 60, `Escapes ${w.sent[1].t - w.sent[0].t} ms apart`);
    safe(w);
  });

  test('(+) clearing to nothing (text empty) in plain memory: two Escapes, no text', async () => {
    const w = pane({ ...earlier, ...PLAIN });
    const r = await w.put('');
    assert.deepEqual([r.status, r.body.typed, r.body.draft.state], [200, 0, 'empty']);
    assert.deepEqual(sentKeys(w), ['Escape', 'Escape']);
    safe(w);
  });

  test('(+) nothing shows the mode, vim normal: the probe i shows INSERT, the vim road follows, the memory becomes vim', async () => {
    const w = pane({ ...earlier, vim: true, vimMode: 'normal' });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['text:i', 'Escape', 'text:ggdG', 'text:i', 'text:bye']);
    assert.deepEqual(w.edits, ['vim']);
    assert.deepEqual(w.mem, { vim: true, plain: false });
    safe(w);
  });

  test('(+) nothing shows the mode, plain: the probe i lands as text, the memory becomes plain, the two Escapes wipe it', async () => {
    const w = pane({ ...earlier });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['text:i', 'Escape', 'Escape', 'text:bye']);
    assert.deepEqual(w.edits, ['plain']);
    assert.deepEqual(w.mem, { vim: false, plain: true });
    safe(w);
  });

  test('(+) the memory says vim normal but vim is off (an i lands as text): the probe flips it to plain', async () => {
    const w = pane({ ...earlier, mem: { vim: true, plain: false } });
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
    const w = pane({ text: 'ls\n-la', cursorAt: { row: 0, col: 1 }, glyph: 'bash', mem: { vim: false, plain: true } });
    const r = await w.put('hello');
    assert.deepEqual([r.status, r.body.draft.mode, r.body.draft.text], [200, 'prompt', 'hello']);
    assert.deepEqual(sentKeys(w), ['Escape', 'Escape', 'BSpace', 'text:hello']);
    safe(w);
  });

  test('(−) a `!` draft is not appended to as a prompt one: a text without the ! is a replace (W13: C-u, BSpace, the whole text, also while busy)', async () => {
    const w = pane({ text: 'ls', glyph: 'bash', vim: true, state: 'busy' });
    const r = await w.put('ls -la');
    assert.deepEqual([r.status, r.body.draft.mode, r.body.draft.text], [200, 'prompt', 'ls -la']);
    assert.deepEqual(sentKeys(w), ['C-u', 'BSpace', 'text:ls -la']);
    safe(w);
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
    const w = pane({ ...earlier, vim: true, escLag: 3, before: (n, p) => { if (n === 4) p.prompt = true; } });
    const r = await w.put('bye');
    assert.equal(r.body.error, 'screen-changed');
    assert.deepEqual(sentKeys(w), ['Escape']);
    safe(w);
  });

  test('(−) T51: a question dialog opens before the second chunk: 409 screen-changed, the rest is never sent, no Enter ever', async () => {
    const w = pane({ text: '', vim: true, before: (n, p) => { if (n === 3) p.override = dialogScreen('ask'); } });
    const r = await w.put(three);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'screen-changed');
    assert.deepEqual(sentKeys(w), ['paste:l1\nl2\n']);
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
    const vim = pane({ ...earlier, vim: true });
    const keep = vim.keys.send;
    vim.keys.send = async (id, body) => { const r = await keep(id, body); if (body.text === 'ggdG') vim.text = 'one\ntwo'; return r; }; // ggdG does nothing
    const rv = await vim.put('bye');
    assert.deepEqual([rv.status, rv.body.error], [409, 'draft-mismatch']);
    assert.deepEqual(vim.edits, ['vim', 'none'], 'INSERT was seen, then the road failed');
    const plain = pane({ ...earlier, ...PLAIN });
    plain.keys.send = async (id, body) => { plain.sent.push({ body, t: plain.t, state: 'idle' }); return { status: 200, body: {} }; }; // Escape does nothing
    const rp = await plain.put('bye');
    assert.deepEqual([rp.status, rp.body.error], [409, 'draft-mismatch']);
    assert.deepEqual(plain.edits, ['none']);
    assert.deepEqual(sentKeys(plain), ['Escape', 'Escape'], 'no text typed over the old draft');
  });

  test('(−) INSERT never goes away after the Escape: 409 mode-unknown, no ggdG', async () => {
    const w = pane({ ...earlier, vim: true, escLag: 100 });
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
    const w = pane({ ...earlier, vim: true, failSend: (b, n) => (n === 3 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null) });
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

  const noCursor = (screen) => ({ ...screen, cursor: null }); // the same rows with the capture's cursor lost
  const bare = (screen) => parseDraft(screen.rows, null, screen.cols); // what the pure parser reads from them: no cursor, no gate (readDraft refuses such a capture)

  test('(−) a status line that parses as a box while the cursor sits in the real box above: nothing is sent, 409 input-unreadable (first layer: the parser says null, N-1)', async () => {
    const screen = statusBox();
    assert.equal(readDraft(screen), null, 'the fixture: with the cursor in the real box above, the status line is not read as a box');
    const fake = bare(screen);
    assert.equal(readDraft(noCursor(screen)), null, 'readDraft, the live reader, refuses a capture without a cursor');
    assert.deepEqual([fake.state, fake.text, fake.box], ['text', 'main', { top: 2, bottom: 4 }], 'without the cursor the parser does read it as the box');
    assert.ok(screen.cursor.y < fake.box.top, 'and the cursor is outside it');
    for (const mem of [{ vim: true, plain: false }, { vim: false, plain: true }]) {
      for (const next of ['main and more', 'other text', '']) { // append, replace, clear
        const w = pane({ text: 'hello', mem, override: () => screen });
        const r = await w.put(next, fake.sig);
        assert.deepEqual([r.status, r.body.error], [409, 'input-unreadable'], JSON.stringify([mem, next]));
        assert.ok(!r.body.draft, 'no draft: the page must not adopt a status line');
        assert.deepEqual(w.sent, [], 'not one key reached the real input');
        safe(w);
      }
    }
  });

  test('(−) the same status line when the capture lost its cursor: readDraft has no box (N-1 ruling), 409 input-unreadable, no draft, nothing sent', async () => {
    const screen = noCursor(statusBox());
    const fake = bare(screen);
    assert.equal(fake.text, 'main', 'the pure parser reads the status line as the box (no cursor to say otherwise)');
    assert.equal(readDraft(screen), null, 'the live reader does not');
    for (const mem of [{ vim: true, plain: false }, { vim: false, plain: true }]) {
      for (const next of ['main and more', 'other text', '']) {
        const w = pane({ text: 'hello', mem, override: () => screen });
        const r = await w.put(next, fake.sig);
        assert.deepEqual([r.status, r.body.error], [409, 'input-unreadable'], JSON.stringify([mem, next]));
        assert.ok(!r.body.draft, 'no draft: the page must not adopt a status line');
        assert.deepEqual(w.sent, [], 'not one key reached the real input');
        safe(w);
      }
    }
  });

  test('(−) a capture without integer cursor coordinates has no box for readDraft, even a real one; parseDraft alone reads it as before', () => {
    const real = boxRows({ lines: ['hello'], insert: true });
    assert.equal(readDraft(real).text, 'hello');
    for (const cursor of [null, undefined, {}, { x: 2 }, { y: 1 }, { x: 'a', y: 1 }, { x: 2.5, y: 1.5 }]) {
      assert.equal(readDraft({ ...real, cursor }), null, JSON.stringify(cursor));
    }
    assert.equal(parseDraft(real.rows, null, real.cols).text, 'hello');
  });

  test('(−) a write into an empty fake box (a status line over an empty real box) types nothing either', async () => {
    const screen = statusBox('');
    assert.equal(readDraft(screen), null);
    const fake = bare(screen);
    for (const shown of [screen, noCursor(screen)]) {
      const w = pane({ text: '', vim: true, override: () => shown });
      const r = await w.put('hello', fake.sig);
      assert.deepEqual([r.status, r.body.error, w.sent], [409, 'input-unreadable', []]);
      assert.ok(!r.body.draft);
    }
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
      const r = await w.put('hello again', bare(w.screen()).sig); // the sig a cursor-less read of the same rows has (readDraft refuses such a capture)
      assert.deepEqual([r.status, r.body.error, w.sent], [409, 'input-unreadable', []], JSON.stringify(cursor));
      assert.ok(!r.body.draft, JSON.stringify(cursor));
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
    const w = pane({ text: 'hello', vim: true, state: 'busy', stopSends: true });
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
    const w = pane({ text: '', vim: true, state: 'busy', stopSends: true });
    const release = stopInFlight(w);
    const sc = w.control();
    const stop = sc.stop('%2');
    await tick();
    assert.equal((await sc.writeDraft('%2', { text: 'queued note', base: w.sig() })).body.error, 'not-idle');
    assert.deepEqual(w.sent, []);
    release();
    await stop;
    w.t += 40; // the gap behind Stop's Escape (N-2)
    w.state = 'busy';
    const r = await sc.writeDraft('%2', { text: 'queued note', base: w.sig() });
    assert.deepEqual([r.status, r.body.typed], [200, 11]);
  });

  test('(−) N-2: Stop\'s send is over, but a key within 40 ms of its Escape is still refused: 409 not-idle, nothing sent; (+) from 40 ms on it goes', async () => {
    const w = pane({ text: 'hello', mem: { vim: false, plain: true }, state: 'busy', stopSends: true });
    const sc = w.control();
    assert.equal((await sc.stop('%2')).status, 200);
    assert.deepEqual(sentKeys(w), ['Escape']);
    w.armed = false; // Claude's "Esc again" hint is not the subject here
    const write = () => sc.writeDraft('%2', { text: 'hello again', base: w.sig() });
    w.t += 10; // the Escape went 10 ms ago
    let r = await write();
    assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
    assert.deepEqual(sentKeys(w), ['Escape'], 'nothing went out behind the Escape');
    w.t += 29; // 39 ms
    r = await write();
    assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
    assert.deepEqual(sentKeys(w), ['Escape']);
    w.t += 1; // 40 ms
    r = await write();
    assert.deepEqual([r.status, r.body.typed], [200, 6]);
    assert.deepEqual(sentKeys(w), ['Escape', 'text: again']); // (safe() is for writes: Stop itself sends its Escape while the state is busy)
  });

  test('(+) N-2: the gap is 40 ms and per pane: a key 50 ms after the Escape goes at once, and a pane that never saw an Escape is not held', async () => {
    const w = pane({ text: 'hello', mem: { vim: false, plain: true }, state: 'busy', stopSends: true });
    const sc = w.control();
    await sc.stop('%2');
    w.armed = false;
    w.t += 50;
    const r = await sc.writeDraft('%2', { text: 'hello again', base: w.sig() });
    assert.deepEqual([r.status, r.body.typed], [200, 6]);
    // a pane that never saw an Escape: nothing to wait for
    const other = pane({ text: 'hello', mem: { vim: false, plain: true }, state: 'busy', stopSends: true });
    assert.equal((await other.control().writeDraft('%2', { text: 'hello again', base: other.sig() })).status, 200);
  });

  test('(−) N-2: End\'s Escape holds the pane too: a write right behind a refused End is 409 not-idle, nothing sent', async () => {
    const w = pane({ text: '', mem: { vim: false, plain: true }, state: 'busy', stopSends: true });
    const sc = w.control({ sleep: async () => {} }); // End\'s wait does not move the clock: the write comes within the gap
    const end = await sc.endSession('%2');
    assert.equal(end.status, 409, 'still busy after the Escape: End refuses');
    assert.ok(sentKeys(w).includes('Escape'), 'End did interrupt');
    const before = w.sent.length;
    const r = await sc.writeDraft('%2', { text: 'queued note', base: w.sig() });
    assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
    assert.equal(w.sent.length, before, 'nothing went out behind End\'s Escape');
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

  test('(−) N-1: a status line drawn under Claude\'s lower rule (glyph + no-break space, or glyph + padding only), the cursor in the real box above: 409, nothing is typed', async () => {
    const NB = ' ';
    const rule = () => [span('─'.repeat(COLS), { fg: 244 })];
    const fakeBox = (row) => (p) => {
      const cap = boxRows({ cols: COLS, lines: [p.text], insert: true }); // top rule 0, the real row 1 (the cursor), lower rule 2
      cap.rows.splice(3, 0, row, rule()); // the status row 3 and its rule 4: the last two rules now frame the status line
      return cap;
    };
    for (const row of [[span(`❯${NB}main`)], [span('❯'), span(' '.repeat(COLS - 1))]]) {
      const shown = fakeBox(row)({ text: '' });
      assert.equal(readDraft(shown), null, 'the fixture: the parser does not read it');
      assert.notEqual(parseDraft(shown.rows, null, shown.cols), null, 'and the pure parser, given no cursor, does read the same rows as a box');
      for (const run of [asEnd, asCommand]) {
        const w = pane({ text: '', vim: true, override: fakeBox(row) });
        const r = await run(w);
        assert.equal(r.status, 409);
        assert.ok(['input-not-empty', 'input-unreadable'].includes(r.body.error), r.body.error);
        assert.deepEqual(w.sent, [], 'not one key reached the real input');
      }
    }
  });

  test('(−) N-1 ruling: a capture without a cursor is no box for End and the commands either: 409, nothing is typed (a real empty box included)', async () => {
    for (const cursor of [null, undefined]) {
      for (const run of [asEnd, asCommand]) {
        const w = pane({ text: '', vim: true, override: (p) => ({ ...boxRows({ cols: COLS, lines: [p.text], insert: true }), cursor }) });
        const r = await run(w);
        assert.equal(r.status, 409);
        assert.ok(['input-not-empty', 'input-unreadable'].includes(r.body.error), r.body.error);
        assert.deepEqual(w.sent, [], 'not one key reached the input');
      }
    }
  });

  test('(+) N-1: the same box with no status line under it is an empty box: End and a command are typed', async () => {
    for (const run of [asEnd, asCommand]) {
      const w = pane({ text: '', vim: true });
      const r = await run(w);
      assert.ok(w.sent.length > 0, 'something was typed');
      assert.notEqual(r.body?.error, 'input-unreadable');
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

// --- 0.5, W13: clear Claude's input without Escape (the C-u road) -----------------------------------------------------------------------

/** Keys that must never go out on the busy road: Escape interrupts a turn, Enter submits, the arrows touch the history and the task manager, DC joins lines. */
const BUSY_NEVER = [...NEVER, 'Escape', 'DC'];
const busySafe = (w) => {
  safe(w);
  w.sent.forEach((s) => { for (const k of s.body.keys ?? []) assert.ok(!BUSY_NEVER.includes(k), `never ${k} on the C-u road`); });
};
/** Time between consecutive requests of the C-u road (fake clock). */
const gaps = (w) => w.sent.slice(1).map((s, i) => s.t - w.sent[i].t);
/** Stop's Escape is held in flight (it runs apart from the lock). */
const holdStop = (w) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const inner = w.keys.send;
  w.keys.send = async (id, body) => { if (body.keys?.includes('Escape')) await gate; return inner(id, body); };
  return release;
};

describe('writeDraft: the C-u road (0.5, W13) -- the cursor on the last row, in any registry state', () => {
  test('(+) a replace clears with one C-u and types, in every registry state and in plain and vim INSERT: no Escape, no Enter', async () => {
    for (const [name, o] of [['plain', PLAIN], ['vim INSERT', { vim: true }]]) {
      for (const state of ['busy', 'shell', 'waiting', null, 'idle']) {
        const w = pane({ text: 'old text', state, ...o });
        const r = await w.put('new text');
        assert.deepEqual([r.status, r.body.typed, r.body.draft.text], [200, 8, 'new text'], `${name} ${state}`);
        assert.deepEqual(sentKeys(w), ['C-u', 'text:new text'], `${name} ${state}`);
        busySafe(w);
      }
    }
  });

  test('(+) the road is chosen by where the cursor is, not by the registry: idle with the cursor on the last row clears with C-u too (Q1)', async () => {
    const w = pane({ text: 'hello', mem: { vim: false, plain: true }, state: 'idle' });
    assert.equal((await w.put('bye')).status, 200);
    assert.deepEqual(sentKeys(w), ['C-u', 'text:bye']);
    assert.deepEqual(w.stateArgs.filter(Boolean), [], 'no fresh registry read: nothing on this road depends on idle');
  });

  test('(+) vim NORMAL while busy: the probe i shows INSERT (no interrupt), End moves from one column left of the end to the end, C-u, then the text', async () => {
    for (const mem of [{ vim: true, plain: false }, { vim: false, plain: false }]) {
      const w = pane({ text: 'normal probe', vim: true, vimMode: 'normal', left: 1, state: 'busy', mem });
      const r = await w.put('fresh');
      assert.deepEqual([r.status, r.body.draft.text, r.body.draft.edit], [200, 'fresh', 'insert']);
      assert.deepEqual(sentKeys(w), ['text:i', 'End', 'C-u', 'text:fresh']);
      assert.deepEqual(w.edits, ['vim']);
      busySafe(w);
    }
  });

  test('(+) plain mode with nothing known, busy: the probe i lands as text, then C-u wipes it with the old text -- no Escape', async () => {
    const w = pane({ text: 'hello', state: 'busy' });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['text:i', 'C-u', 'text:bye']);
    assert.deepEqual(w.edits, ['plain']);
    busySafe(w);
  });

  test('(+) the cursor in the middle of the last row: End first (it reaches the text end from the last row), then C-u', async () => {
    const w = pane({ text: 'hello world', vim: true, state: 'busy', cursorAt: { row: 0, col: 5 } });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['End', 'C-u', 'text:bye']);
    busySafe(w);
  });

  test('(+) three hard lines take five C-u (2N-1, the newline goes on its own press); every key is its own request, at least 60 ms after the one before', async () => {
    const w = pane({ text: 'line one\nline two\nline three', vim: true, state: 'busy' });
    const r = await w.put('x');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'x']);
    assert.deepEqual(sentKeys(w), ['C-u', 'C-u', 'C-u', 'C-u', 'C-u', 'text:x']);
    assert.ok(gaps(w).every((g) => g >= 60), `gaps ${gaps(w)}`);
    busySafe(w);
  });

  test('(+) a wrapped line takes one C-u per visual row; the break space Claude keeps is a `trailing` intermediate state, not a refusal', async () => {
    const w = pane({ text: 'x'.repeat(200), vim: true, state: 'busy', breakSpace: true });
    const seen = [];
    w.afterType = (b, p) => { const d = readDraft(p.screen()); seen.push(d.state === 'unreadable' ? d.reason : d.state); };
    const r = await w.put('ok');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'ok']);
    assert.deepEqual(sentKeys(w), ['C-u', 'C-u', 'text:ok']);
    assert.deepEqual(seen, ['trailing', 'empty', 'text'], 'the fixture: the first C-u leaves the cursor one column past the text');
    busySafe(w);
  });

  test('(+) the box shows Claude\'s queued placeholder after the last C-u: that is an empty box, the text goes; an empty queued box is typed into at once', async () => {
    const w = pane({ text: 'abc', vim: true, state: 'busy', queuedMsgs: true });
    const r = await w.put('xyz');
    assert.deepEqual([r.status, r.body.draft.text, r.body.draft.queued], [200, 'xyz', false]);
    assert.deepEqual(sentKeys(w), ['C-u', 'text:xyz']);
    const empty = pane({ text: '', vim: true, state: 'busy', queuedMsgs: true });
    assert.equal(readDraft(empty.screen()).queued, true, 'the fixture');
    assert.equal((await empty.put('next')).status, 200);
    assert.deepEqual(sentKeys(empty), ['text:next']);
    busySafe(w);
    busySafe(empty);
  });

  test('(+) a `!` draft replaced by a prompt text while busy: C-u, BSpace to leave the `!` box, the text; a text that starts with ! keeps the glyph', async () => {
    const w = pane({ text: 'ls -la', glyph: 'bash', vim: true, state: 'busy' });
    const r = await w.put('hello');
    assert.deepEqual([r.status, r.body.draft.mode, r.body.draft.text], [200, 'prompt', 'hello']);
    assert.deepEqual(sentKeys(w), ['C-u', 'BSpace', 'text:hello']);
    busySafe(w);
    const keep = pane({ text: 'ls -la', glyph: 'bash', vim: true, state: 'busy' });
    assert.deepEqual([(await keep.put('!pwd')).status, keep.text, keep.glyph], [200, 'pwd', 'bash']);
    assert.deepEqual(sentKeys(keep), ['C-u', 'text:pwd']);
  });

  test('(+) a replace that needs no clear still works as before: the same text sends nothing, an append sends only the new part', async () => {
    const same = pane({ text: 'hello', vim: true, state: 'busy' });
    assert.deepEqual([(await same.put('hello')).body.typed, same.sent], [0, []]);
    const more = pane({ text: 'hello', vim: true, state: 'busy' });
    assert.equal((await more.put('hello again')).status, 200);
    assert.deepEqual(sentKeys(more), ['text: again']);
  });

  test('(+) the pre-key check runs before EVERY key: a fresh capture sits right before each C-u and the first text', async () => {
    const w = pane({ text: 'a\nb\nc', vim: true, state: 'busy' });
    const order = [];
    const cap = w.mirror.capture;
    w.mirror.capture = async (...a) => { order.push('capture'); return cap(...a); };
    const send = w.keys.send;
    w.keys.send = async (id, b) => { order.push(b.keys ? b.keys[0] : 'text'); return send(id, b); };
    assert.equal((await w.put('z')).status, 200);
    const at = order.map((o, i) => (o === 'capture' ? -1 : i)).filter((i) => i >= 0);
    assert.ok(at.length >= 6, order.join());
    for (const i of at) assert.equal(order[i - 1], 'capture', `a capture right before key ${i}: ${order.join()}`);
  });

  test('(−) the cursor on an EARLIER row while Claude works (or has no state): 409 cursor-not-at-end with the draft, ZERO keys -- not even the probe i, whatever the edit mode', async () => {
    for (const [name, o] of [['plain', PLAIN], ['vim INSERT', { vim: true }], ['unknown', {}], ['vim NORMAL', { vim: true, vimMode: 'normal' }]]) {
      for (const state of ['busy', 'shell', 'waiting', null]) {
        const w = pane({ ...earlier, state, ...o });
        const r = await w.put('bye');
        assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'cursor-not-at-end', 'one\ntwo'], `${name} ${state}`);
        assert.deepEqual(w.sent, [], `${name} ${state}`);
      }
    }
  });

  test('(+) the cursor on an earlier row at idle: the W5 Escape road, unchanged (plain: two Escapes 60 ms apart; vim INSERT: Escape, ggdG, i)', async () => {
    const plain = pane({ ...earlier, ...PLAIN });
    assert.deepEqual([(await plain.put('bye')).status, plain.text], [200, 'bye']);
    assert.deepEqual(sentKeys(plain), ['Escape', 'Escape', 'text:bye']);
    assert.ok(plain.sent[1].t - plain.sent[0].t >= 60);
    const vim = pane({ ...earlier, vim: true });
    assert.deepEqual([(await vim.put('bye')).status, vim.text], [200, 'bye']);
    assert.deepEqual(sentKeys(vim), ['Escape', 'text:ggdG', 'text:i', 'text:bye']);
    safe(plain);
    safe(vim);
  });

  test('(−) the Escape road reads the registry again before its second Escape: a turn that started in between is never interrupted (409 not-idle, one Escape only)', async () => {
    const w = pane({ ...earlier, ...PLAIN });
    w.afterType = (b, p) => { if (b.keys?.includes('Escape')) p.freshState = 'busy'; };
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
    assert.deepEqual(sentKeys(w), ['Escape']);
  });

  test('(+) a live (padded) screen: the C-u road with several rows while busy works as on an unpadded one', async () => {
    const w = pane({ text: 'line one\nline two\nline three', vim: true, state: 'busy', padded: true });
    const r = await w.put('x');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'x']);
    assert.deepEqual(sentKeys(w), ['C-u', 'C-u', 'C-u', 'C-u', 'C-u', 'text:x']);
    busySafe(w);
  });

  test('(−) the user types in the terminal before the first C-u: not a prefix of what was read, 409 screen-changed with the screen\'s draft, no key', async () => {
    const w = pane({ text: 'hello world', vim: true, state: 'busy', before: (n, p) => { if (n === 2) p.text += 'X'; } });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'screen-changed', 'hello worldX']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) the user types right after a C-u: the text on screen is no prefix of the text before the press, 409 screen-changed, nothing more is pressed', async () => {
    const w = pane({ text: 'a\nb\nc', vim: true, state: 'busy' });
    w.afterType = (b, p) => { if (b.keys?.includes('C-u')) p.text = 'Z'; };
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'screen-changed', 'Z']);
    assert.deepEqual(sentKeys(w), ['C-u']);
    busySafe(w);
  });

  test('(−) C-u gets no redraw within 400 ms: 409 clear-stopped with the draft (kept as it is), no second C-u, no text', async () => {
    const w = pane({ text: 'hello', vim: true, state: 'busy', swallowCu: true });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'clear-stopped', 'hello']);
    assert.deepEqual(sentKeys(w), ['C-u']);
    assert.ok(w.slept.filter((ms) => ms === 20).length >= 20, '400 ms of polling every 20 ms');
    busySafe(w);
  });

  test('(−) a C-u that is swallowed while the user moves the cursor: a cursor move is no progress, 409 clear-stopped, no second C-u', async () => {
    const w = pane({ text: 'hello world', vim: true, state: 'busy', swallowCu: true });
    w.afterType = (b, p) => { if (b.keys?.includes('C-u')) p.cursorAt = { row: 0, col: 3 }; };
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'clear-stopped', 'hello world']);
    assert.deepEqual(sentKeys(w), ['C-u']);
    assert.ok(w.slept.filter((ms) => ms === 20).length >= 20, 'the full 400 ms of waiting: the moved cursor did not end it');
    busySafe(w);
  });

  test('(−) the user moves the cursor into the text right after a C-u, and the next C-u would cut at that cursor: the cut is not the start of the text, 409 screen-changed, nothing more', async () => {
    const w = pane({ text: 'line one\nline two', vim: true, state: 'busy' });
    w.afterType = (b, p) => { if (b.keys?.includes('C-u') && w.sent.length === 1) p.cursorAt = { row: 0, col: 4 }; };
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'screen-changed', ' one\n']);
    assert.deepEqual(sentKeys(w), ['C-u', 'C-u']);
    busySafe(w);
  });

  test('(+) a C-u from a cursor inside the text acts at the cursor, so End comes first and the whole text goes (the fake honours a mid-row cursor)', async () => {
    const w = pane({ text: 'line one\nline two', vim: true, state: 'busy', cursorAt: { row: 1, col: 4 } });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.draft.text], [200, 'bye']);
    assert.deepEqual(sentKeys(w), ['End', 'C-u', 'C-u', 'C-u', 'text:bye']);
    busySafe(w);
  });

  test('(−) clear-stopped drops the pane\'s edit memory (End swallowed, C-u swallowed, too many presses): the next try probes with i again', async () => {
    const stalls = [{ swallowEnd: true, cursorAt: { row: 0, col: 2 } }, { swallowCu: true }, { cuStep: 1 }];
    for (const o of stalls) {
      const w = pane({ text: 'hello world', ...PLAIN, state: 'busy', ...o });
      const r = await w.put('bye');
      assert.equal(r.body.error, 'clear-stopped', JSON.stringify(o));
      assert.deepEqual(w.edits, ['none'], 'the memory was dropped');
      assert.deepEqual(w.mem, { vim: false, plain: false });
      assert.equal(r.body.draft.edit, 'unknown', 'the answer says so');
      Object.assign(w, { swallowEnd: false, swallowCu: false, cuStep: 0, cursorAt: null });
      w.sent.length = 0;
      assert.equal((await w.put('bye')).status, 200, 'the next try works');
      assert.equal(sentKeys(w)[0], 'text:i', `${JSON.stringify(o)}: it probes first`);
      busySafe(w);
    }
  });

  test('(−) End does not reach the end of the text within 400 ms: 409 clear-stopped, only End was pressed', async () => {
    const w = pane({ text: 'hello world', vim: true, state: 'busy', cursorAt: { row: 0, col: 5 }, swallowEnd: true });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'clear-stopped', 'hello world']);
    assert.deepEqual(sentKeys(w), ['End']);
  });

  test('(−) more presses than 2 x the box rows + 2 and the box not empty: 409 clear-stopped after exactly that many C-u (a C-u that removes one character each time)', async () => {
    const one = pane({ text: 'abcdefghijkl', vim: true, state: 'busy', cuStep: 1 });
    const r = await one.put('x');
    assert.deepEqual([r.status, r.body.error, r.body.draft.text], [409, 'clear-stopped', 'abcdefgh']);
    assert.equal(sentKeys(one).length, 4, '1 row: 2 x 1 + 2');
    const two = pane({ text: 'abcdefghijkl\nmnopqrstuvwx', vim: true, state: 'busy', cuStep: 1 });
    assert.equal((await two.put('x')).body.error, 'clear-stopped');
    assert.equal(sentKeys(two).length, 6, '2 rows: 2 x 2 + 2');
    busySafe(one);
  });

  test('(−) T51 on this road: a permission prompt, any of the six dialogs or an unknown footer appears before the next C-u: 409 screen-changed, no key goes into it', async () => {
    const hooks = [
      (p) => { p.prompt = true; },
      ...Object.keys(DIALOGS).map((name) => (p) => { p.override = dialogScreen(name); }),
      (p) => { p.override = () => boxRows({ lines: ['a'], footer: 'some footer nobody recognises' }); },
    ];
    assert.equal(hooks.length, 8, 'a permission prompt, six dialogs, a footer');
    for (const hook of hooks) {
      const w = pane({ text: 'a\nb\nc', vim: true, state: 'busy', before: (n, p) => { if (n === 4) hook(p); } });
      const r = await w.put('bye');
      assert.deepEqual([r.status, r.body.error], [409, 'screen-changed']);
      assert.deepEqual(sentKeys(w), ['C-u'], 'the capture right before the second key already showed it');
      busySafe(w);
    }
  });

  test('(−) the box turns unreadable mid-clear (a placeholder, a history entry, the cursor outside the box): 409 screen-changed, nothing more is pressed', async () => {
    const hooks = [
      (p) => { p.override = () => boxRows({ lines: ['[Pasted text #1 +3 lines]'] }); },
      (p) => { p.history = true; },
      (p) => { p.override = (x) => boxRows({ lines: visual(x.text), insert: true, cursor: { x: 0, y: 0 } }); },
    ];
    for (const hook of hooks) {
      const w = pane({ text: 'a\nb\nc', vim: true, state: 'busy', before: (n, p) => { if (n === 4) hook(p); } });
      const r = await w.put('bye');
      assert.deepEqual([r.status, r.body.error], [409, 'screen-changed']);
      assert.deepEqual(sentKeys(w), ['C-u']);
    }
  });

  test('(−) Stop or End interrupts the pane (or its Escape went out < 40 ms ago): 409 not-idle, nothing is pressed', async () => {
    const w = pane({ text: 'hello', ...PLAIN, state: 'busy', stopSends: true });
    const release = holdStop(w);
    const sc = w.control();
    const stop = sc.stop('%2');
    await tick();
    const r = await sc.writeDraft('%2', { text: 'bye', base: w.sig() });
    assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
    assert.deepEqual(w.sent, []);
    release();
    await stop;
    const gap = await sc.writeDraft('%2', { text: 'bye', base: w.sig() });
    assert.deepEqual([gap.status, gap.body.error], [409, 'not-idle'], 'still inside the 40 ms behind Stop\'s Escape');
    assert.deepEqual(sentKeys(w), ['Escape']);
  });

  test('(−) a failed key send in the middle (429): the sequence stops, the answer is that status plus the screen\'s draft', async () => {
    const w = pane({ text: 'a\nb\nc', vim: true, state: 'busy', failSend: (b, n) => (n === 2 ? { status: 429, body: { error: 'busy', message: 'slow down' } } : null) });
    const r = await w.put('bye');
    assert.deepEqual([r.status, r.body.error], [429, 'busy']);
    assert.equal(typeof r.body.draft.sig, 'string');
    assert.deepEqual(sentKeys(w), ['C-u', 'C-u']);
  });

  test('(−) the recorder on the fake keys is real: an Escape that goes out while the registry is busy is caught (and cleared here so the hook passes)', async () => {
    const w = pane({ text: 'hello', vim: true, state: 'busy' });
    await w.keys.send('%2', { keys: ['Escape'] });
    assert.equal(w.badEscapes.length, 1);
    w.badEscapes.length = 0;
    const idle = pane({ text: 'hello', vim: true, state: 'idle' });
    await idle.keys.send('%2', { keys: ['Escape'] });
    assert.deepEqual(idle.badEscapes, []);
  });
});

// --- 0.5, W13: the guarded Send Enter (submit) ------------------------------------------------------------------------------------------

const sub = (w, body = { base: w.sig() }) => w.control().submit('%2', body);
/** The screen with Claude's footer but no input box (a user's own layout, or the box scrolled away). */
const noBox = () => { const s = boxRows({ lines: ['x'] }); return { ...s, rows: [s.rows[0], ...s.rows.slice(-2)] }; };

describe('checkSubmitBody', () => {
  test('(+) exactly { base? }: nothing, or a base of 16 lowercase hex (or empty: the same shape as the draft PUT)', () => {
    for (const body of [{}, { base: '0123456789abcdef' }, { base: '' }]) assert.equal(checkSubmitBody(body), null, JSON.stringify(body));
  });

  test('(−) any other key, a bad base, an array, null, a string: 400 invalid', () => {
    const bad = [
      null, undefined, 'x', 5, [], [{}], { text: 'hello' }, { base: '', text: 'x' }, { base: '0123456789abcdef', keys: ['Enter'] }, { Base: '' },
      { base: 5 }, { base: null }, { base: 'ABCDEF0123456789' }, { base: '0123456789abcde' }, { base: '0123456789abcdef0' }, { base: '0123456789abcdeg' },
    ];
    for (const body of bad) {
      const r = checkSubmitBody(body);
      assert.equal(r?.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid');
    }
  });
});

describe('submit: the Enter of Send (0.5, W13)', () => {
  test('(+) idle, base = the screen\'s sig: exactly one Enter, the box empties: 200 taken true with the empty draft', async () => {
    const w = pane({ text: 'hello', vim: true });
    const r = await sub(w);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.taken, r.body.draft.state, r.body.draft.queued], [true, 'empty', false]);
    assert.deepEqual(sentKeys(w), ['Enter']);
    assert.deepEqual(w.submitted, ['hello']);
    assert.deepEqual(w.slept, [50], 'one poll, 50 ms after the Enter');
  });

  test('(+) while Claude works (busy, shell, waiting, no state): the same one Enter; the box shows the queued placeholder, which is an empty box: taken true, draft.queued true', async () => {
    for (const state of ['busy', 'shell', 'waiting', null]) {
      const w = pane({ text: 'queue this', vim: true, state });
      const r = await sub(w);
      assert.deepEqual([r.status, r.body.taken, r.body.draft.state, r.body.draft.queued], [200, true, 'empty', true], String(state));
      assert.deepEqual(sentKeys(w), ['Enter'], String(state));
    }
  });

  test('(+) a `!` command and a multi-line text go the same way', async () => {
    for (const o of [{ text: 'ls -la', glyph: 'bash' }, { text: 'one\ntwo' }]) {
      const w = pane({ vim: true, state: 'busy', ...o });
      assert.equal((await sub(w)).body.taken, true);
      assert.deepEqual(sentKeys(w), ['Enter']);
    }
  });

  test('(+) both empty (base = the empty box\'s sig): the Enter is pressed (it does nothing in Claude), taken true', async () => {
    const w = pane({ text: '', vim: true });
    assert.deepEqual([(await sub(w)).body.taken, sentKeys(w)], [true, ['Enter']]);
  });

  test('(+) Q4: no base ({}), the box readable: the Enter is pressed and the emptied box says taken true', async () => {
    const w = pane({ text: 'typed by keys', vim: true });
    const r = await sub(w, {});
    assert.deepEqual([r.status, r.body.taken], [200, true]);
    assert.deepEqual(sentKeys(w), ['Enter']);
  });

  test('(+) Q4: no base, no box nika can read but a known footer: the Enter is pressed, taken null (nothing can be said), no more key', async () => {
    const w = pane({ text: 'x', vim: true, override: noBox });
    const r = await sub(w, {});
    assert.deepEqual([r.status, r.body.taken, r.body.draft], [200, null, null]);
    assert.deepEqual(sentKeys(w), ['Enter']);
    assert.ok(w.slept.filter((ms) => ms === 50).length >= 20, 'polled for the full second');
  });

  test('(+) the Enter did not take (the box still reads the text for a full second): taken false, the Enter is never repeated', async () => {
    const w = pane({ text: 'hello', vim: true, swallowEnter: true });
    const r = await sub(w);
    assert.deepEqual([r.status, r.body.taken, r.body.draft.text], [200, false, 'hello']);
    assert.deepEqual(sentKeys(w), ['Enter']);
    assert.ok(w.slept.filter((ms) => ms === 50).length >= 20 && w.slept.every((ms) => ms === 50), '20 polls of 50 ms');
  });

  test('(+) one read-back capture fails while every other poll still shows the text: taken null, never false (a failed read proves nothing); the Enter is not repeated', async () => {
    const w = pane({ text: 'hello', vim: true, swallowEnter: true });
    const capture = w.mirror.capture;
    let polls = 0;
    w.mirror.capture = async (...a) => (w.sent.length > 0 && (polls += 1) === 3 ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : capture(...a));
    const r = await sub(w);
    assert.deepEqual([r.status, r.body.taken, r.body.draft.text], [200, null, 'hello']);
    assert.ok(polls >= 20, 'it kept polling the whole second');
    assert.deepEqual(sentKeys(w), ['Enter']);
    const clean = pane({ text: 'hello', vim: true, swallowEnter: true });
    assert.equal((await sub(clean)).body.taken, false, 'the same run with no failed capture is false');
  });

  test('(+) a prompt opens right after the Enter and the box is gone: taken null, nothing more is pressed', async () => {
    const w = pane({ text: 'hello', vim: true, state: 'busy', afterEnter: (p) => { p.prompt = true; } });
    const r = await sub(w);
    assert.deepEqual([r.status, r.body.taken, r.body.draft], [200, null, null]);
    assert.deepEqual(sentKeys(w), ['Enter']);
  });

  test('(+) another text on screen after the Enter (the user typed again): taken null', async () => {
    const w = pane({ text: 'hello', vim: true, swallowEnter: true, afterEnter: null });
    w.before = (n, p) => { if (n === 4) p.text = 'something else'; };
    const r = await sub(w);
    assert.deepEqual([r.status, r.body.taken], [200, null]);
  });

  test('(−) a permission prompt: 409 prompt-open, ZERO keys, one capture, also at idle', async () => {
    for (const state of ['idle', 'busy']) {
      const w = pane({ text: 'hello', vim: true, state, prompt: true });
      const r = await sub(w, { base: 'a'.repeat(16) });
      assert.deepEqual([r.status, r.body.error], [409, 'prompt-open'], state);
      assert.deepEqual(w.sent, [], state);
      assert.equal(w.n, 1);
    }
  });

  test('(−) a question, review, plan, "Exit plan mode?" or nudge dialog: 409 prompt-open, ZERO keys (an Enter would confirm the highlighted option)', async () => {
    for (const name of Object.keys(DIALOGS)) {
      for (const body of [{ base: 'a'.repeat(16) }, {}]) {
        const w = pane({ text: '', vim: true, state: 'busy', override: dialogScreen(name) });
        const r = await sub(w, body);
        assert.deepEqual([r.status, r.body.error], [409, 'prompt-open'], name);
        assert.deepEqual(w.sent, [], name);
      }
    }
  });

  test('(+) an empty box that shows Claude\'s queued placeholder or the `Try "..."` example is not a suggestion: the Enter goes', async () => {
    const queued = pane({ text: '', vim: true, state: 'busy', queuedMsgs: true });
    assert.deepEqual([readDraft(queued.screen()).queued, readDraft(queued.screen()).suggestion], [true, null], 'the fixture');
    const example = pane({ text: '', vim: true, ghost: 'Try "fix the failing test"' });
    assert.deepEqual([readDraft(example.screen()).state, readDraft(example.screen()).suggestion], ['empty', null], 'the fixture');
    for (const w of [queued, example]) {
      for (const body of [{ base: w.sig() }, {}]) {
        w.sent.length = 0;
        const r = await sub(w, body);
        assert.equal(r.status, 200, JSON.stringify(body));
        assert.deepEqual(sentKeys(w), ['Enter'], JSON.stringify(body));
      }
    }
  });

  test('(−) an empty box that shows a prompt suggestion (base or not, idle or busy): 409 suggestion-shown with the draft, ZERO keys -- what Enter does there is unverified', async () => {
    for (const state of ['idle', 'busy']) {
      for (const make of [(o) => ({ base: o.sig() }), () => ({})]) {
        const w = pane({ text: '', vim: true, state, ghost: 'run the tests' });
        assert.equal(readDraft(w.screen()).suggestion, 'run the tests', 'the fixture');
        const r = await sub(w, make(w));
        assert.deepEqual([r.status, r.body.error, r.body.draft.state, r.body.draft.suggestion], [409, 'suggestion-shown', 'empty', 'run the tests'], state);
        assert.deepEqual(w.sent, [], state);
        assert.equal(w.n, 1, 'one capture');
      }
    }
  });

  test('(−) a prompt that mentions bypass, or a screen with an unreadable footer that mentions it: 409 bypass-prompt, ZERO keys (T26)', async () => {
    const prompt = pane({ text: 'hello', vim: true, state: 'busy', override: () => ({ rows: BYPASS_PROMPT.map((t) => [span(t)]), cursor: { x: 0, y: 0, visible: true }, cols: COLS }) });
    assert.deepEqual([(await sub(prompt, {})).body.error, prompt.sent], ['bypass-prompt', []]);
    const footer = pane({ text: 'hello', vim: true, override: () => boxRows({ lines: ['hello'], footer: 'a dialog about bypass permissions nobody recognises' }) });
    assert.deepEqual([(await sub(footer, {})).body.error, footer.sent], ['bypass-prompt', []]);
  });

  test('(−) the screen shows no footer nika knows and no box: 409 screen-unclear, ZERO keys', async () => {
    const w = pane({ text: 'hello', vim: true, override: () => boxRows({ lines: [''], footer: 'some footer nobody recognises' }) });
    for (const body of [{}, { base: 'a'.repeat(16) }]) {
      const r = await sub(w, body);
      assert.deepEqual([r.status, r.body.error], [409, 'screen-unclear']);
    }
    assert.deepEqual(w.sent, []);
  });

  test('(−) base given and the box changed (another sig, or an empty base): 409 draft-changed with the screen\'s draft, ZERO keys', async () => {
    for (const base of ['0123456789abcdef', '']) {
      const w = pane({ text: 'hello', vim: true });
      const r = await sub(w, { base });
      assert.deepEqual([r.status, r.body.error, r.body.draft.text, r.body.draft.sig], [409, 'draft-changed', 'hello', w.sig()], base);
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) base given and the box is a placeholder nika cannot read (sig null): 409 draft-changed, ZERO keys', async () => {
    const w = pane({ text: 'hello', vim: true });
    const base = w.sig();
    w.text = '[Pasted text #1 +3 lines]';
    const r = await sub(w, { base });
    assert.deepEqual([r.status, r.body.error, r.body.draft.state], [409, 'draft-changed', 'unreadable']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) base given and no recognised box (or the cursor is not in it, or the capture lost its cursor): 409 input-unreadable, ZERO keys', async () => {
    const lost = () => ({ ...boxRows({ lines: ['hello'], insert: true }), cursor: null });
    const outside = () => boxRows({ lines: ['hello'], insert: true, cursor: { x: 0, y: 0 } });
    for (const override of [noBox, lost, outside]) {
      const w = pane({ text: 'hello', vim: true, override });
      const r = await sub(w, { base: 'a'.repeat(16) });
      assert.deepEqual([r.status, r.body.error], [409, 'input-unreadable']);
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) Stop or End interrupts the pane: 409 not-idle, ZERO keys, not even a capture; within 40 ms of Stop\'s Escape the same; from 40 ms on the Enter goes', async () => {
    const w = pane({ text: 'hello', ...PLAIN, state: 'busy', stopSends: true });
    const release = holdStop(w);
    const sc = w.control();
    const stop = sc.stop('%2');
    await tick();
    const captures = w.n;
    const r = await sc.submit('%2', { base: w.sig() });
    assert.deepEqual([r.status, r.body.error], [409, 'not-idle']);
    assert.equal(w.n, captures, 'refused before any capture');
    assert.deepEqual(w.sent, []);
    release();
    await stop;
    w.armed = false;
    w.t += 10;
    assert.equal((await sc.submit('%2', { base: w.sig() })).body.error, 'not-idle');
    w.t += 30;
    const ok = await sc.submit('%2', { base: w.sig() });
    assert.deepEqual([ok.status, ok.body.taken], [200, true]);
    assert.deepEqual(sentKeys(w), ['Escape', 'Enter']);
  });

  test('(−) another control action holds the pane (End, a command, a draft write): 409 busy-switching, ZERO keys; the lock is free again afterwards', async () => {
    const w = pane({ text: 'hello', vim: true });
    let release;
    w.hold = new Promise((r) => { release = r; });
    const sc = w.control();
    const write = sc.writeDraft('%2', { text: 'hello again', base: w.sig() }); // a draft write never presses Enter
    await tick();
    assert.deepEqual(await sc.submit('%2', {}), code(409, 'busy-switching'));
    w.hold = null;
    release();
    assert.equal((await write).status, 200);
    assert.ok(!sentKeys(w).includes('Enter'), 'the refused submit pressed nothing');
    const after = await sc.submit('%2', {});
    assert.deepEqual([after.status, after.body.taken], [200, true], 'the lock is free again');
  });

  test('(−) a bad body is 400 before any capture or key', async () => {
    const w = pane({ text: 'hello', vim: true });
    for (const body of [{ text: 'x' }, { base: 5 }, { base: '', keys: ['Enter'] }, null, []]) {
      const r = await sub(w, body);
      assert.deepEqual([r.status, r.body.error], [400, 'invalid']);
    }
    assert.deepEqual([w.n, w.sent], [0, []]);
  });

  test('(−) the Enter send fails (429, tmux): its own status and body plus the screen\'s draft, no read-back wait, no second Enter', async () => {
    for (const failed of [{ status: 429, body: { error: 'busy', message: 'slow down' } }, { status: 502, body: { error: 'tmux_failed', message: 'x' } }]) {
      const w = pane({ text: 'hello', vim: true, failSend: () => failed });
      const r = await sub(w);
      assert.deepEqual([r.status, r.body.error], [failed.status, failed.body.error]);
      assert.equal(r.body.draft.text, 'hello');
      assert.equal(w.sent.length, 1);
      assert.deepEqual(w.slept, []);
    }
  });

  test('(−) a failed capture before the Enter: its own status and body, ZERO keys', async () => {
    const w = pane({ text: 'hello', vim: true });
    w.mirror.capture = async () => ({ status: 404, body: { error: 'not_found', message: 'gone' } });
    const r = await sub(w);
    assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) the Enter is the only key the whole suite of submits ever sent (never Escape, Tab, a digit, text, a paste)', async () => {
    for (const o of [{ text: 'hello' }, { text: '' }, { text: 'a\nb', state: 'busy' }, { text: 'ls', glyph: 'bash', state: 'shell' }]) {
      const w = pane({ vim: true, ...o });
      await sub(w);
      await sub(w, {});
      for (const s of w.sent) assert.deepEqual(s.body, { keys: ['Enter'] });
    }
  });
});
