// acceptSuggestion (nika 0.5, W4): Claude shows a prompt suggestion as dim text in an empty input box; the page's Tab or right arrow
// asks the server to press Tab in Claude. The controller presses it only when a fresh screen still shows that exact suggestion, the
// registry says idle and no prompt is open, and it presses nothing else. A fake pane models the box and records every key.
// Synthetic text only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl, checkSuggestionBody, readDraft } from '../src/session-control.js';
import { createKeys } from '../src/keys.js';
import { boxRows, span } from './helpers.js';

const COLS = 120;
const SUG = 'run the tests in acme-api';
const PROMPT = ['Bash command', '  run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];
const tick = () => new Promise((r) => setImmediate(r));
const code = (r) => [r.status, r.body.error];

/**
 * A pane with Claude's input box. Fields: text, suggestion (dim text shown while the box is empty), insert (vim `-- INSERT --` shown),
 * glyph ('prompt' | 'bash'), state / freshState (registry state; the fresh read answers freshState when set), prompt (a permission
 * prompt on screen), tabAccepts (Tab puts the suggestion into the box), lag (captures that still show the empty box after Tab),
 * override(w) (a screen to show instead), failSend(body, n), before(n, w) (runs before the n-th capture).
 */
function pane(opts = {}) {
  const w = {
    text: '', suggestion: SUG, insert: true, glyph: 'prompt', state: 'idle', freshState: null, prompt: false, tabAccepts: true, lag: 0,
    override: null, failSend: null, before: null, n: 0, t: 1_000_000, sent: [], stateArgs: [], tabbed: false, ...opts,
  };
  w.screen = () => {
    if (w.override) return w.override(w);
    if (w.prompt) return { rows: PROMPT.map((t) => (t ? [span(t)] : [])), cursor: { x: 0, y: 0, visible: true }, cols: COLS };
    return boxRows({ cols: COLS, lines: [w.text], ghost: w.text === '' && w.suggestion !== null ? w.suggestion : null, insert: w.insert, mode: w.glyph });
  };
  w.mirror = {
    async capture(id, inm, o) {
      w.n += 1;
      w.before?.(w.n, w);
      assert.equal(o?.fresh, true, 'every control read is fresh');
      if (w.tabbed && w.tabAccepts && w.text === '') { // Claude redraws late: `lag` captures still show the empty box
        if (w.lag > 0) w.lag -= 1;
        else w.text = w.suggestion;
      }
      return { status: 200, body: w.screen() };
    },
  };
  w.keys = {
    async send(id, body) {
      w.sent.push({ body, state: w.freshState ?? w.state });
      const failed = w.failSend?.(body, w.sent.length);
      if (failed) return failed;
      if (body.keys?.includes('Tab')) {
        w.tabbed = true;
        if (w.tabAccepts && w.lag === 0 && w.text === '' && w.suggestion !== null) w.text = w.suggestion;
      }
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 1 } } };
    },
  };
  w.stateOf = async (id, o) => { w.stateArgs.push(o); return o?.fresh && w.freshState !== null ? w.freshState : w.state; };
  w.sleep = async (ms) => { w.t += ms; };
  w.control = (extra = {}) => createSessionControl({
    mirror: w.mirror, keys: w.keys, paneCommand: async () => 'claude', stateOf: w.stateOf, vimOf: () => w.insert, plainOf: () => false,
    now: () => w.t, sleep: w.sleep, ...extra,
  });
  w.accept = (text = SUG) => w.control().acceptSuggestion('%2', { text });
  return w;
}

/** What must never go out, whatever the case: at most one request, and it is exactly `Tab`. */
function onlyTab(w) {
  assert.ok(w.sent.length <= 1, `at most one key request (${w.sent.length})`);
  for (const s of w.sent) assert.deepEqual(s.body, { keys: ['Tab'] }, 'the only key is Tab');
}

describe('checkSuggestionBody', () => {
  test('(+) exactly { text }: a non-empty string of at most 200 characters without controls', () => {
    assert.equal(checkSuggestionBody({ text: SUG }), null);
    assert.equal(checkSuggestionBody({ text: 'x'.repeat(200) }), null);
    assert.equal(checkSuggestionBody({ text: 'café → ok' }), null);
  });

  test('(−) anything else is 400 invalid: extra or missing keys, a non-string, empty, too long, controls, a non-object', () => {
    const bad = [{}, { text: SUG, base: '' }, { text: 5 }, { text: '' }, { text: 'x'.repeat(201) }, { text: 'a\nb' }, { text: 'a\tb' }, { text: 'a\u0000b' }, { text: 'a\u001b[2mb' }, { text: 'a\u007fb' }, { text: 'a\u0085b' }, null, 'text', 7, [], [SUG]];
    for (const b of bad) {
      const r = checkSuggestionBody(b);
      assert.deepEqual([r?.status, r?.body.error], [400, 'invalid'], JSON.stringify(b));
    }
  });
});

describe('acceptSuggestion', () => {
  test('(+) a suggestion on an idle pane: one Tab, the box reads it back, 200 { draft } with the new text', async () => {
    const w = pane();
    const r = await w.accept();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.draft.state, r.body.draft.text, r.body.draft.suggestion], ['text', SUG, null]);
    assert.deepEqual(Object.keys(r.body), ['draft'], 'the answer is { draft } only');
    assert.deepEqual(w.sent.map((s) => s.body), [{ keys: ['Tab'] }]);
    onlyTab(w);
  });

  test('(+) the same without `-- INSERT --` on the screen (plain input), and when Claude redraws late (the read-back waits)', async () => {
    const plain = pane({ insert: false });
    assert.equal((await plain.accept()).status, 200);
    onlyTab(plain);
    const late = pane({ lag: 2 });
    const r = await late.accept();
    assert.deepEqual([r.status, r.body.draft.text], [200, SUG], 'two stale captures, then the text');
    onlyTab(late);
  });

  test('(+) the registry is read fresh: a state that went from idle to busy since the cached read sends nothing', async () => {
    const w = pane({ state: 'idle', freshState: 'busy' });
    assert.deepEqual(code(await w.accept()), [409, 'not-idle']);
    assert.ok(w.stateArgs.some((o) => o?.fresh === true), 'stateOf was asked with { fresh: true }');
    assert.deepEqual(w.sent, []);
  });

  test('(−) the suggestion differs from the one the page shows: 409 draft-changed with the screen\'s draft, nothing sent', async () => {
    const w = pane({ suggestion: 'show me the contents of README.md' });
    const r = await w.accept();
    assert.deepEqual(code(r), [409, 'draft-changed']);
    assert.equal(r.body.draft.suggestion, 'show me the contents of README.md', 'the page learns the new suggestion');
    assert.deepEqual(w.sent, []);
  });

  test('(−) no suggestion at all (empty box, nothing dim), and the `Try "..."` placeholder: 409 draft-changed, nothing sent', async () => {
    for (const suggestion of [null, 'Try "fix the failing test"']) {
      const w = pane({ suggestion });
      const r = await w.accept();
      assert.deepEqual(code(r), [409, 'draft-changed'], String(suggestion));
      assert.equal(r.body.draft.suggestion, null);
      assert.deepEqual(w.sent, [], String(suggestion));
    }
  });

  test('(−) the box holds text (typed in the terminal), even text equal to the suggestion: 409 draft-changed, nothing sent', async () => {
    for (const text of ['hello', SUG]) {
      const w = pane({ text });
      assert.deepEqual(code(await w.accept()), [409, 'draft-changed'], text);
      assert.deepEqual(w.sent, []);
    }
  });

  test('(−) a `!` box is not a prompt box: its dim text is never accepted', async () => {
    const w = pane({ glyph: 'bash' });
    assert.deepEqual(code(await w.accept()), [409, 'draft-changed']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) an unreadable box (a pasted block, trailing spaces) is 409 draft-unreadable with the reason, nothing sent', async () => {
    const w = pane({ override: () => boxRows({ cols: COLS, lines: ['look at [Image #2]'], insert: true }) });
    const r = await w.accept();
    assert.deepEqual([...code(r), r.body.reason], [409, 'draft-unreadable', 'pasted']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) a permission prompt on screen: 409 not-idle, nothing sent (T51)', async () => {
    const w = pane({ prompt: true });
    assert.deepEqual(code(await w.accept()), [409, 'not-idle']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) a busy turn, a waiting state, and no registry state at all: 409 not-idle, nothing sent', async () => {
    for (const state of ['busy', 'waiting', null, 'weird']) {
      const w = pane({ state });
      assert.deepEqual(code(await w.accept()), [409, 'not-idle'], String(state));
      assert.deepEqual(w.sent, []);
    }
    const throws = pane();
    throws.stateOf = async () => { throw new Error('registry down'); };
    assert.deepEqual(code(await throws.accept()), [409, 'not-idle'], 'a failing lookup is never idle');
    assert.deepEqual(throws.sent, []);
  });

  test('(−) Stop is interrupting the pane: 409 not-idle even if the registry already reads idle, and no key follows the Escape', async () => {
    const w = pane({ state: 'busy', insert: false });
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = w.keys.send;
    w.keys.send = async (id, body) => { if (body.keys?.includes('Escape')) await gate; return inner(id, body); };
    const sc = w.control();
    const stop = sc.stop('%2');
    await tick();
    w.state = 'idle';
    assert.deepEqual(code(await sc.acceptSuggestion('%2', { text: SUG })), [409, 'not-idle']);
    assert.deepEqual(w.sent, [], 'nothing went out behind the Escape');
    release();
    await stop;
    assert.deepEqual(w.sent.map((s) => s.body), [{ keys: ['Escape'] }], 'only Stop\'s own Escape');
  });

  test('(−) a footer nobody recognises (a dialog): 409 mode-unknown; a screen with no input box: 409 input-unreadable; nothing sent', async () => {
    const dialog = pane({ override: () => boxRows({ cols: COLS, lines: [''], ghost: SUG, footer: 'some footer nobody recognises' }) });
    assert.deepEqual(code(await dialog.accept()), [409, 'mode-unknown']);
    const none = pane({ override: () => ({ rows: [[span('─'.repeat(COLS))], [span('❯ hello')], [span('⏵⏵ auto mode on (shift+tab to cycle)')]], cursor: { x: 2, y: 1 }, cols: COLS }) });
    assert.deepEqual(code(await none.accept()), [409, 'input-unreadable']);
    assert.deepEqual([dialog.sent, none.sent], [[], []]);
  });

  test('(−) the cursor is not in the box that reads (it may be a status line): 409 input-unreadable with no draft, nothing sent', async () => {
    for (const cursor of [null, { y: 0 }, { y: 2 }, { y: 3 }]) {
      const w = pane({ override: () => boxRows({ cols: COLS, lines: [''], ghost: SUG, insert: true, cursor }) });
      const r = await w.accept();
      assert.deepEqual([...code(r), r.body.draft], [409, 'input-unreadable', null], JSON.stringify(cursor));
      assert.deepEqual(w.sent, [], JSON.stringify(cursor));
    }
  });

  test('(−) Tab did not take (the box stays empty): 409 draft-mismatch with the screen\'s draft, exactly one Tab, no retry', async () => {
    const w = pane({ tabAccepts: false });
    const r = await w.accept();
    assert.deepEqual(code(r), [409, 'draft-mismatch']);
    assert.equal(r.body.draft.state, 'empty');
    assert.equal(w.sent.length, 1);
    onlyTab(w);
  });

  test('(−) Tab took, but the box reads something else than the suggestion: 409 draft-mismatch, the page gets what the box holds', async () => {
    const w = pane();
    const inner = w.keys.send;
    w.keys.send = async (id, body) => { const out = await inner(id, body); w.text = 'something else entirely'; return out; };
    const r = await w.accept();
    assert.deepEqual([...code(r), r.body.draft.text], [409, 'draft-mismatch', 'something else entirely']);
    onlyTab(w);
  });

  test('(−) a key send that fails (429, tmux) is passed through with the screen\'s draft; nothing else is tried', async () => {
    const w = pane({ failSend: () => ({ status: 429, body: { error: 'rate_limited', message: 'slow down' } }) });
    const r = await w.accept();
    assert.deepEqual([r.status, r.body.error, r.body.draft.suggestion], [429, 'rate_limited', SUG]);
    assert.equal(w.sent.length, 1);
    const gone = pane({ failSend: () => ({ status: 404, body: { error: 'not_found' } }) });
    assert.equal((await gone.accept()).status, 404);
  });

  test('(−) a failed capture is passed through with its own status, and nothing is sent', async () => {
    const w = pane();
    w.mirror.capture = async () => ({ status: 502, body: { error: 'tmux_failed' } });
    const r = await w.accept();
    assert.deepEqual([r.status, r.body.error], [502, 'tmux_failed']);
    assert.deepEqual(w.sent, []);
  });

  test('(−) a bad body is 400 and nothing is read or sent', async () => {
    const w = pane();
    for (const body of [{}, { text: '' }, { text: SUG, extra: 1 }, { text: 5 }, null]) {
      assert.equal((await w.control().acceptSuggestion('%2', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(w.n, 0, 'no capture');
    assert.deepEqual(w.sent, []);
  });

  test('(−) it takes the per-pane lock: while End (or any control) runs on the pane the answer is 409 busy-switching, nothing sent', async () => {
    const w = pane();
    let release;
    const hold = new Promise((r) => { release = r; });
    const inner = w.mirror.capture;
    w.mirror.capture = async (...a) => { await hold; return inner(...a); };
    const sc = w.control();
    const end = sc.endSession('%2');
    await tick();
    assert.deepEqual(code(await sc.acceptSuggestion('%2', { text: SUG })), [409, 'busy-switching']);
    assert.deepEqual(w.sent, []);
    release();
    await end;
    assert.ok(w.sent.every((s) => !s.body.keys?.includes('Tab')), 'End never presses Tab');
  });

  test('(−) the lock is released after a refusal: the next accept on the same pane runs', async () => {
    const w = pane({ suggestion: 'other' });
    const sc = w.control();
    assert.equal((await sc.acceptSuggestion('%2', { text: SUG })).status, 409);
    assert.equal((await sc.acceptSuggestion('%2', { text: 'other' })).status, 200);
  });

  test('(−) Tab counts toward the per-pane key limit: with 20 requests inside the window the accept is 429 and no Tab goes to tmux', async () => {
    const w = pane();
    const calls = [];
    let clock = 5_000_000;
    const exec = async (cmd, args) => { calls.push(args); return { stdout: '', stderr: '' }; };
    const real = createKeys({ exec, tmuxBin: 'tmux', now: () => clock });
    for (let i = 0; i < 20; i += 1) assert.equal((await real.send('%2', { keys: ['Up'] })).status, 200);
    const before = calls.length;
    w.keys = real;
    const r = await w.control().acceptSuggestion('%2', { text: SUG });
    assert.deepEqual([r.status, r.body.draft.suggestion], [429, SUG]);
    assert.equal(calls.length, before, 'tmux was not called');
    clock += 1100;
    assert.equal((await w.control().acceptSuggestion('%2', { text: SUG })).status, 409, 'after the window the Tab is sent (this fake screen never changes)');
    assert.deepEqual(calls.at(-1).filter((a) => a === 'Tab'), ['Tab']);
  });

  test('(−) over every case above the keys sent are only ever Tab: Enter, Escape, Right, text and paste never go out', async () => {
    const cases = [
      pane(), pane({ insert: false }), pane({ tabAccepts: false }), pane({ suggestion: 'x' }), pane({ text: 'hi' }), pane({ prompt: true }),
      pane({ state: 'busy' }), pane({ glyph: 'bash' }), pane({ suggestion: null }),
    ];
    for (const w of cases) {
      await w.accept();
      onlyTab(w);
      for (const s of w.sent) assert.ok(s.body.text === undefined && s.body.paste === undefined);
    }
  });

  test('(+) the answer\'s draft is the parse the page needs: sig, edit, box and cursorAtEnd', async () => {
    const w = pane();
    const before = readDraft(w.screen());
    const r = await w.accept();
    assert.notEqual(r.body.draft.sig, before.sig, 'the text changed the sig');
    assert.equal(r.body.draft.edit, 'insert');
    assert.equal(r.body.draft.cursorAtEnd, true);
    assert.deepEqual(r.body.draft.box, before.box);
  });
});
