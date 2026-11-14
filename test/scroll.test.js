// Scroll controller (design W3 sections 2.1 to 2.3, 3.2, 10.1, 12.1; threat T39): the request names a direction and a count, the server
// picks the keys. A fake mirror, a fake keys that records every call, a fake lock and a fake clock model one pane; after EVERY request
// `safe()` asserts what must never go out: only PPage, NPage, C-Home, C-End, never text or paste, at most 8 keys, at most one keys.send
// per request, and only while the lock is held. Synthetic screens only (acme-api text, no real capture).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SCROLL_RATE, MAX_PAGES, pillShown, checkScrollBody, scrollKeys, scrollGate, createScroll } from '../src/scroll.js';
import { createKeys } from '../src/keys.js';
import { createMirror } from '../src/mirror.js';
import { readDraft } from '../src/session-control.js';
import { promptFromRows } from '../src/mode.js';
import { boxRows, span } from './helpers.js';

const ESC = '\u001b';
const COLS = 120;
const PANE = '%5';
const ALLOWED = new Set(['PPage', 'NPage', 'C-Home', 'C-End']);
const MESSAGE_400 = 'body must be { dir: up|down, pages: 1-8 } or { to: top|bottom }';
const UP = (pages = 1) => ({ dir: 'up', pages });
const DOWN = (pages = 1) => ({ dir: 'down', pages });

// ---- screens ------------------------------------------------------------------------------------------------------------
const row = (t) => (typeof t === 'string' ? (t ? [span(t)] : []) : t);
/** Claude's scrolled-up pill row: centred, fg 231 on bg 237 (spike S5). */
const pill = (words = 'Jump to bottom: fn+↓ to scroll') => [span(' '.repeat(40)), span(` ${words} `, { fg: 231, bg: 237 })];
/** A capture body with Claude's full-screen view on: transcript rows, then the input box (helpers.boxRows). */
function view({ above = ['  Here is the answer.', ''], alt = true, scrolled = false, ...box } = {}) {
  const b = boxRows({ cols: COLS, ...box });
  return { cols: COLS, rows: [...above.map(row), ...b.rows], cursor: b.cursor && { ...b.cursor, y: b.cursor.y + above.length }, alt, scrolled };
}
const PROMPT = ['Bash command', '  run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];
const MODE_LINE = '  ⏵⏵ auto mode on (shift+tab to cycle)';
const RULE = '─'.repeat(COLS);

/** Screens on which scrolling is allowed (design 2.3): [name, capture body]. */
const ALLOWED_SCREENS = [
  ['empty box', view()],
  ['one-line draft', view({ lines: ['fix the build'] })],
  ['multi-line draft', view({ lines: ['first line', 'second line', 'third line'] })],
  ['a draft that mentions a slash command mid-text', view({ lines: ['run /compact now'] })],
  ['bash box with text', view({ mode: 'bash', lines: ['ls -la'] })],
  ['empty bash box', view({ mode: 'bash' })],
  ['unreadable draft: history entry', view({ label: 'History 3/3', lines: ['older entry'] })],
  ['unreadable draft: pasted text', view({ lines: ['[Pasted text #1 +20 lines]'] })],
  ['vim INSERT footer', view({ insert: true, lines: ['x'] })],
  ['a turn is running', view({ above: ['  Working on it', '  ✻ Thinking… (12s · esc to interrupt)'] })],
  ['already scrolled up (pill on screen)', view({ above: ['  older output', pill()], scrolled: true })],
];

/** Screens on which nothing may be sent: [name, capture body, code]. */
const REFUSED_SCREENS = [
  ['alternate screen off', view({ alt: false }), 'no-view'],
  ['alt missing', (({ alt, ...rest }) => rest)(view()), 'no-view'],
  ['alt not a boolean', { ...view(), alt: '1' }, 'no-view'],
  ['alt off and a prompt', { rows: PROMPT.map(row), cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: false }, 'no-view'],
  ['permission prompt', { rows: PROMPT.map(row), cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true }, 'prompt-open'],
  ['permission prompt below a plain box', { ...view(), rows: [...view().rows, ...PROMPT.map(row)] }, 'prompt-open'],
  ['AskUserQuestion footer', view({ footer: 'Enter to select · ↑/↓ to navigate · Esc to cancel' }), 'screen-unclear'],
  ['ExitPlanMode style dialog', {
    rows: ['Ready to code?', '', ' Would you like to proceed?', ' ❯ 1. Yes, auto-accept edits', '   2. No, keep planning', '', ' ctrl-g to edit plan'].map(row),
    cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true,
  }, 'screen-unclear'],
  ['feedback survey', view({ above: ['● How is Claude doing this session? (optional)', '  1: Bad    2: Fine    3: Good    0: Dismiss'] }), 'screen-unclear'],
  ['unknown footer', view({ footer: 'something Claude never drew' }), 'screen-unclear'],
  ['overlay in place of the mode line', view({ footer: '/model · Esc to close' }), 'screen-unclear'],
  ['cursor on the status line below the box', (() => { const v = view(); return { ...v, cursor: { x: 2, y: v.rows.length - 2, visible: true } }; })(), 'screen-unclear'],
  ['cursor on the top rule', (() => { const v = view(); return { ...v, cursor: { x: 2, y: 2, visible: true } }; })(), 'screen-unclear'],
  ['no cursor', view({ cursor: null }), 'screen-unclear'],
  ['no rule rows', { rows: ['  Here is the answer.', MODE_LINE].map(row), cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true }, 'screen-unclear'],
  ['one rule row', { rows: ['  Here is the answer.', RULE, '❯ ', MODE_LINE].map(row), cursor: { x: 2, y: 2, visible: true }, cols: COLS, alt: true }, 'screen-unclear'],
  ['no rows', { rows: [], cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true }, 'screen-unclear'],
  ['slash command being typed', view({ lines: ['/com'] }), 'menu-open'],
  ['a lone slash', view({ lines: ['/'] }), 'menu-open'],
  ['multi-line draft that starts with a slash', view({ lines: ['/help', 'more'] }), 'menu-open'],
  ['bash box whose text starts with a slash (fails closed)', view({ mode: 'bash', lines: ['/usr/bin/true'] }), 'menu-open'],
];

// ---- the fake pane ------------------------------------------------------------------------------------------------------
const ok = (body) => ({ status: 200, body });
const keysOk = (n) => ({ status: 200, body: { sent: { text: 0, paste: 0, keys: n } } });
const busyError = () => Object.assign(new Error('another action is running on this pane'), { code: 'EPANEBUSY' });

/**
 * Options: captures (answers in order, the last repeats; an Error is thrown), send (the keys.send answer), busy (the lock gives up),
 * lockThrows, gap (boolean or (pane) => boolean), sleepThrows, tick (false: sleep does not move the clock).
 * Records every event in order in `log`, and for every call whether the lock was held.
 */
function harness(o = {}) {
  const answers = o.captures ?? [ok(view())];
  const h = { log: [], clock: { t: 1_000_000 }, held: 0, requests: 0, captures: [], sends: [], sleeps: [], locks: [] };
  let n = 0;
  const mirror = {
    async capture(pane, inm, opts) {
      h.captures.push({ pane, inm, opts, held: h.held > 0 });
      h.log.push('capture');
      const a = answers[Math.min(n, answers.length - 1)];
      n += 1;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  const keys = {
    async send(pane, body) {
      h.sends.push({ pane, body: structuredClone(body), held: h.held > 0 });
      h.log.push('send');
      return o.send ?? keysOk(body.keys.length);
    },
  };
  const lock = async (pane, fn) => {
    h.locks.push(pane);
    h.log.push('lock');
    if (o.busy) throw busyError();
    if (o.lockThrows) throw o.lockThrows;
    h.held += 1;
    try {
      return await fn();
    } finally {
      h.held -= 1;
    }
  };
  const keyGap = (pane) => {
    h.log.push('gap');
    return typeof o.gap === 'function' ? o.gap(pane) : o.gap === true;
  };
  const sleep = async (ms) => {
    h.sleeps.push(ms);
    h.log.push(`sleep ${ms}`);
    if (o.tick !== false) h.clock.t += ms;
    if (o.sleepThrows) throw new Error('sleep failed');
  };
  h.scroller = createScroll({ mirror, keys, lock, keyGap, now: () => h.clock.t, sleep });
  /** One request; asserts the never-sent rules before and after returning. */
  h.run = async (body, ...more) => {
    const pane = more.length ? more[0] : PANE; // an explicit undefined pane is a request too
    const before = h.sends.length;
    h.requests += 1;
    const r = await h.scroller.scroll(pane, body);
    assert.ok(h.sends.length - before <= 1, 'at most one keys.send per request');
    safe(h);
    return r;
  };
  return h;
}

/** What must never go out, for every call made so far. */
function safe(h) {
  assert.ok(h.sends.length <= h.requests, 'at most one keys.send per request');
  for (const s of h.sends) {
    assert.deepEqual(Object.keys(s.body), ['keys'], 'never text or paste, nothing but keys');
    assert.ok(s.body.keys.length >= 1 && s.body.keys.length <= 8, `1 to 8 keys, got ${s.body.keys.length}`);
    for (const k of s.body.keys) assert.ok(ALLOWED.has(k), `key ${k} is not a scroll key`);
    assert.ok(s.held, 'keys only while the pane lock is held');
  }
  for (const c of h.captures) assert.ok(c.held, 'captures only while the pane lock is held');
}

// ---- tests --------------------------------------------------------------------------------------------------------------
describe('constants', () => {
  test('(+) the rate and the page cap are the design values', () => {
    assert.equal(SCROLL_RATE, 10);
    assert.equal(MAX_PAGES, 8);
  });
});

describe('checkScrollBody and scrollKeys', () => {
  test('(+) each body shape is valid and maps to its fixed keys', () => {
    const cases = [
      [UP(3), ['PPage', 'PPage', 'PPage']],
      [DOWN(1), ['NPage']],
      [{ to: 'top' }, ['C-Home']],
      [{ to: 'bottom' }, ['C-End']],
      [UP(1), ['PPage']],
      [UP(8), Array(8).fill('PPage')],
      [DOWN(8), Array(8).fill('NPage')],
      [{ pages: 2, dir: 'down' }, ['NPage', 'NPage']],
    ];
    for (const [body, keys] of cases) {
      assert.equal(checkScrollBody(body), null, JSON.stringify(body));
      assert.deepEqual(scrollKeys(body), keys, JSON.stringify(body));
    }
  });

  test('(+) every valid body gives only the four scroll keys, 1 to 8 of them', () => {
    const bodies = [{ to: 'top' }, { to: 'bottom' }];
    for (const dir of ['up', 'down']) for (let pages = 1; pages <= MAX_PAGES; pages += 1) bodies.push({ dir, pages });
    for (const body of bodies) {
      const keys = scrollKeys(body);
      assert.ok(keys.length >= 1 && keys.length <= 8, JSON.stringify(body));
      assert.ok(keys.every((k) => ALLOWED.has(k)), JSON.stringify(body));
    }
  });

  const BAD = [
    { dir: 'up', pages: 1, keys: ['Enter'] }, { dir: 'up', pages: 1, text: 'x' }, { dir: 'up', pages: 1, paste: 'x' }, { dir: 'up', pages: 1, to: 'top' },
    { dir: 'up', pages: 1, extra: 1 }, { to: 'top', pages: 1 }, { to: 'top', dir: 'up' }, { to: 'top', extra: 1 }, { to: 'top', keys: ['C-c'] },
    { dir: 'up', pages: 0 }, { dir: 'up', pages: 9 }, { dir: 'up', pages: -1 }, { dir: 'up', pages: 1.5 }, { dir: 'up', pages: '3' },
    { dir: 'up', pages: NaN }, { dir: 'up', pages: Infinity }, { dir: 'up', pages: null }, { dir: 'up', pages: [3] }, { dir: 'up', pages: true },
    { dir: 'up' }, { pages: 3 }, { dir: 'down' }, { dir: undefined, pages: 1 }, { dir: 'up', pages: undefined },
    { dir: 'left', pages: 1 }, { dir: 'UP', pages: 1 }, { dir: 'up ', pages: 1 }, { dir: '', pages: 1 }, { dir: null, pages: 1 }, { dir: ['up'], pages: 1 },
    { dir: 'PPage', pages: 1 }, { dir: 'NPage', pages: 1 }, { dir: 'Enter', pages: 1 }, { dir: 'C-End', pages: 1 },
    { dir: 'constructor', pages: 1 }, { dir: '__proto__', pages: 1 }, { dir: 'toString', pages: 1 }, { dir: 'hasOwnProperty', pages: 1 },
    { to: 'middle' }, { to: 'TOP' }, { to: 'top ' }, { to: '' }, { to: null }, { to: 5 }, { to: ['top'] }, { to: 'C-End' }, { to: 'Home' }, { to: 'End' },
    { to: 'constructor' }, { to: '__proto__' }, { to: 'toString' },
    {}, [], [{ dir: 'up', pages: 1 }], 'up', 5, true, null, undefined,
    JSON.parse('{"__proto__":{"dir":"up","pages":1}}'), JSON.parse('{"to":"top","__proto__":1}'),
  ];

  test('(−) any other shape is the 400 answer, and scrollKeys gives no key for it', () => {
    for (const body of BAD) {
      const what = JSON.stringify(body) ?? String(body);
      assert.deepEqual(checkScrollBody(body), { status: 400, body: { error: 'invalid', message: MESSAGE_400 } }, what);
      assert.deepEqual(scrollKeys(body), [], what);
    }
  });

  test('(−) a body that is not an own-property plain shape cannot borrow keys from its prototype', () => {
    const inherited = Object.create({ dir: 'up', pages: 2 });
    assert.notEqual(checkScrollBody(inherited), null);
    assert.deepEqual(scrollKeys(inherited), []);
    class Shaped { constructor() { this.to = 'bottom'; } }
    assert.equal(checkScrollBody(new Shaped()), null, 'own properties are what count');
    assert.deepEqual(scrollKeys(new Shaped()), ['C-End']);
  });
});

describe('pillShown', () => {
  const rowsOf = (...rows) => rows.map(row);

  test('(+) both pill texts of spike S5 match, in any row', () => {
    assert.equal(pillShown(rowsOf('older output', pill('Jump to bottom: fn+↓ to scroll'), '', '  input')), true);
    assert.equal(pillShown(rowsOf(pill('Jump to bottom (click) ↓'))), true);
    assert.equal(pillShown(rowsOf(pill(), 'a', 'b', 'c')), true, 'first row');
    assert.equal(pillShown(rowsOf('a', 'b', pill())), true, 'last row');
  });

  test('(+) the pill may start at column 0 and only the span holding the J is checked', () => {
    assert.equal(pillShown([[span('Jump to bottom', { fg: 231, bg: 237 })]]), true);
    assert.equal(pillShown([[span('Jump to ', { fg: 231, bg: 237 }), span('bottom: x')]]), true, 'the J is in the styled span');
    assert.equal(pillShown([[span(' '), span('J', { fg: 231, bg: 237 }), span('ump to bottom')]]), true);
    assert.equal(pillShown([[span('  '), span('Jump to bottom', { fg: 231, bg: 237 }), span(' ', { fg: 1, bg: 2 })]]), true);
  });

  test('(−) the right words without the right colours are not the pill', () => {
    const style = (s) => [[span(' ', {}), span(' Jump to bottom: fn+↓ to scroll ', s)]];
    assert.equal(pillShown(style({ fg: 231 })), false, 'no background');
    assert.equal(pillShown(style({ bg: 237 })), false, 'no foreground');
    assert.equal(pillShown(style({ fg: 231, bg: 236 })), false);
    assert.equal(pillShown(style({ fg: 230, bg: 237 })), false);
    assert.equal(pillShown(style({ fg: [255, 255, 255], bg: 237 })), false, 'rgb is another colour');
    assert.equal(pillShown(style({ fg: '231', bg: '237' })), false, 'strings are not colours');
    assert.equal(pillShown(style({})), false);
    assert.equal(pillShown([[span(' '), span('J', { fg: 231, bg: 237 }), span('ump to bottom', {})]]), true, 'sanity: the J decides');
    assert.equal(pillShown([[span('J'), span('ump to bottom', { fg: 231, bg: 237 })]]), false, 'the J is in a plain span');
  });

  test('(−) the words mid-row, other words, other case and plain text are not the pill', () => {
    const styled = (t) => [[span(t, { fg: 231, bg: 237 })]];
    assert.equal(pillShown(styled('see Jump to bottom')), false, 'after other text');
    assert.equal(pillShown(styled('> Jump to bottom')), false);
    assert.equal(pillShown(styled('Jump to bottomless')), false, 'a word boundary is required');
    assert.equal(pillShown(styled('jump to bottom')), false);
    assert.equal(pillShown(styled('Jump  to bottom')), false);
    assert.equal(pillShown(styled('Jump to top')), false);
    assert.equal(pillShown(styled('')), false);
    assert.equal(pillShown(rowsOf('Jump to bottom: fn+↓ to scroll')), false, 'plain text');
  });

  test('(−) rows that are not rows never throw and never match', () => {
    for (const rows of [undefined, null, 5, 'Jump to bottom', {}, [], [null], [undefined], [5], ['Jump to bottom'], [[]], [[null]], [[{}]], [[{ t: 5, s: {} }]], [[{ t: 'Jump to bottom' }]]]) {
      assert.equal(pillShown(rows), false, JSON.stringify(rows));
    }
  });
});

describe('scrollGate', () => {
  test('(+) allowed screens give null', () => {
    for (const [name, cap] of ALLOWED_SCREENS) {
      assert.notEqual(readDraft(cap), null, `fixture ${name} must have a readable box`);
      assert.equal(scrollGate(cap), null, name);
    }
  });

  test('(−) every other screen gives its code, and the fixtures reach the check they name', () => {
    for (const [name, cap, code] of REFUSED_SCREENS) {
      assert.equal(scrollGate(cap), code, name);
      if (code === 'screen-unclear') {
        assert.equal(promptFromRows(cap.rows), null, `${name}: not a permission prompt`);
        assert.equal(readDraft(cap), null, `${name}: no plain box`);
      }
      if (code === 'menu-open') assert.equal(readDraft(cap).state, 'text', name);
    }
  });

  test('(−) the checks run in the order alt, prompt, box, slash menu', () => {
    const prompt = { rows: PROMPT.map(row), cursor: { x: 0, y: 0, visible: true }, cols: COLS };
    assert.equal(scrollGate({ ...prompt, alt: false }), 'no-view');
    assert.equal(scrollGate({ ...prompt, alt: true }), 'prompt-open', 'a prompt also has no box, the prompt answer comes first');
    assert.equal(scrollGate(view({ alt: false, lines: ['/com'] })), 'no-view');
  });

  test('(−) not a capture at all gives no-view and never throws', () => {
    for (const cap of [undefined, null, 5, 'x', [], {}, { alt: false }, { alt: 1 }, { alt: 'true' }]) assert.equal(scrollGate(cap), 'no-view', JSON.stringify(cap));
    assert.equal(scrollGate({ alt: true }), 'screen-unclear');
    assert.equal(scrollGate({ alt: true, rows: 'x', cursor: { x: 0, y: 0 } }), 'screen-unclear');
  });
});

describe('createScroll: construction', () => {
  test('(−) the controller refuses to exist without its collaborators', () => {
    const mirror = { capture: async () => ok(view()) };
    const keys = { send: async () => keysOk(1) };
    const lock = async (p, fn) => fn();
    const keyGap = () => false;
    assert.doesNotThrow(() => createScroll({ mirror, keys, lock, keyGap }));
    assert.throws(() => createScroll(), TypeError);
    assert.throws(() => createScroll({ keys, lock, keyGap }), TypeError);
    assert.throws(() => createScroll({ mirror, lock, keyGap }), TypeError);
    assert.throws(() => createScroll({ mirror, keys, keyGap }), TypeError);
    assert.throws(() => createScroll({ mirror, keys, lock }), TypeError, 'keyGap has no permissive default');
    assert.throws(() => createScroll({ mirror, keys, lock, keyGap: true }), TypeError);
  });
});

describe('createScroll.scroll: sending', () => {
  test('(+) every body shape sends its keys in one keys.send, in the order lock, gap, capture, send, settle, capture', async () => {
    const cases = [
      [UP(3), ['PPage', 'PPage', 'PPage']], [DOWN(1), ['NPage']], [{ to: 'top' }, ['C-Home']], [{ to: 'bottom' }, ['C-End']],
    ];
    for (const [body, keys] of cases) {
      const h = harness({ captures: [ok(view()), ok(view({ above: ['  older', pill()], scrolled: true }))] });
      const r = await h.run(body);
      assert.deepEqual(r, { status: 200, body: { sent: keys.length, scrolled: true } }, JSON.stringify(body));
      assert.deepEqual(h.sends, [{ pane: PANE, body: { keys }, held: true }]);
      assert.deepEqual(h.log, ['lock', 'gap', 'capture', 'send', 'sleep 30', 'capture'], JSON.stringify(body));
      assert.deepEqual(h.locks, [PANE]);
    }
  });

  test('(+) all 18 valid bodies: the exact keys, never anything else', async () => {
    const bodies = [{ to: 'top' }, { to: 'bottom' }];
    for (const dir of ['up', 'down']) for (let pages = 1; pages <= MAX_PAGES; pages += 1) bodies.push({ dir, pages });
    for (const body of bodies) {
      const h = harness();
      const r = await h.run(body);
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual(h.sends[0].body.keys, scrollKeys(body));
      assert.equal(r.body.sent, h.sends[0].body.keys.length);
    }
  });

  test('(+) down and bottom are sent while scrolled is false: a pill nika fails to see must never strand the user', async () => {
    for (const body of [DOWN(2), { to: 'bottom' }]) {
      const h = harness({ captures: [ok(view({ scrolled: false })), ok(view({ scrolled: false }))] });
      const r = await h.run(body);
      assert.equal(r.status, 200);
      assert.equal(h.sends.length, 1);
      assert.deepEqual(r.body.scrolled, false);
    }
  });

  test('(+) screens on which scrolling is allowed send the keys', async () => {
    for (const [name, cap] of ALLOWED_SCREENS) {
      const h = harness({ captures: [ok(cap)] });
      const r = await h.run(UP(2));
      assert.equal(r.status, 200, name);
      assert.equal(h.sends.length, 1, name);
    }
  });

  test('(+) the first capture is fresh, with no If-None-Match; the second is fresh too, 30 ms after the keys', async () => {
    const h = harness({ captures: [ok(view()), ok(view())] });
    await h.run(UP(1));
    assert.equal(h.captures.length, 2);
    for (const c of h.captures) {
      assert.equal(c.pane, PANE);
      assert.equal(c.inm, undefined);
      assert.deepEqual(c.opts, { fresh: true });
    }
    assert.deepEqual(h.sleeps, [30]);
    assert.ok(h.log.indexOf('send') < h.log.indexOf('sleep 30') && h.log.indexOf('sleep 30') < h.log.lastIndexOf('capture'));
  });

  test('(+) scrolled in the answer is the second capture\'s, true or false', async () => {
    const up = harness({ captures: [ok(view()), ok(view({ above: ['  older', pill()], scrolled: true }))] });
    assert.deepEqual((await up.run(UP(1))).body, { sent: 1, scrolled: true });
    const bottom = harness({ captures: [ok(view({ above: ['  older', pill()], scrolled: true })), ok(view({ scrolled: false }))] });
    assert.deepEqual((await bottom.run({ to: 'bottom' })).body, { sent: 1, scrolled: false });
    const loose = harness({ captures: [ok(view()), ok({ ...view(), scrolled: 'yes' })] });
    assert.equal((await loose.run(UP(1))).body.scrolled, false, 'only a real true counts');
  });

  test('(+) a failed second capture is an unknown, not an error: the keys went out', async () => {
    const failures = [
      { status: 502, body: { error: 'tmux_failed' } }, { status: 404, body: { error: 'not_found' } }, { status: 503, body: { error: 'tmux_unavailable' } },
      new Error('boom'),
    ];
    for (const second of failures) {
      const h = harness({ captures: [ok(view()), second] });
      const r = await h.run(UP(2));
      assert.deepEqual(r, { status: 200, body: { sent: 2, scrolled: null } });
      assert.equal(h.sends.length, 1);
    }
    const h = harness({ sleepThrows: true });
    assert.deepEqual(await h.run(UP(1)), { status: 200, body: { sent: 1, scrolled: null } }, 'a failed pause too');
  });

  test('(+) a body that is later changed by the caller does not change what was sent', async () => {
    const h = harness();
    const body = UP(2);
    const p = h.scroller.scroll(PANE, body);
    body.pages = 8;
    h.requests += 1;
    await p;
    safe(h);
    assert.ok(h.sends[0].body.keys.length <= 8);
  });
});

describe('createScroll.scroll: refusals (nothing is sent)', () => {
  test('(−) invalid pane ids are 400 and reach nothing', async () => {
    const h = harness();
    for (const pane of ['', '5', '%', '%x', '%1234567', '%1;ls', '-t', '%1 %2', '$(x)', undefined, null, 5, {}]) {
      const r = await h.run(UP(1), pane);
      assert.equal(r.status, 400, String(pane));
      assert.deepEqual(r.body, { error: 'invalid', message: 'invalid pane id' });
    }
    assert.deepEqual(h.log, []);
  });

  test('(−) a bad body is 400 with the fixed message and reaches nothing, whatever it carries', async () => {
    const h = harness();
    const hostile = [
      { dir: 'up', pages: 1, keys: ['Enter'] }, { dir: '<script>alert(1)</script>', pages: 1 }, { to: 'top', text: 'rm -rf /' },
      { dir: 'up', pages: 1, paste: 'x' }, { dir: 'Escape', pages: 1 }, { to: 'C-c' }, null, undefined,
    ];
    for (const body of hostile) {
      const r = await h.run(body);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'invalid', message: MESSAGE_400 });
      assert.doesNotMatch(JSON.stringify(r.body), /script|rm -rf|Enter|Escape|C-c/);
    }
    assert.deepEqual(h.log, []);
  });

  test('(−) the pane id is checked before the body', async () => {
    const h = harness();
    const r = await h.scroller.scroll('nope', { dir: 'sideways' });
    assert.equal(r.body.message, 'invalid pane id');
  });

  test('(−) screens that are not safe give 409 with the code and a fixed message; one capture, no keys, no second capture', async () => {
    const messages = new Set();
    for (const [name, cap, code] of REFUSED_SCREENS) {
      const h = harness({ captures: [ok(cap), ok(view())] });
      const r = await h.run(UP(3));
      assert.equal(r.status, 409, name);
      assert.equal(r.body.error, code, name);
      assert.equal(typeof r.body.message, 'string', name);
      assert.ok(r.body.message.length > 0 && r.body.message.length <= 200, name);
      assert.deepEqual(Object.keys(r.body), ['error', 'message']);
      messages.add(`${code}: ${r.body.message}`);
      assert.equal(h.sends.length, 0, name);
      assert.equal(h.captures.length, 1, name);
      assert.deepEqual(h.sleeps, [], name);
    }
    assert.equal(messages.size, 4, 'one fixed message per code');
  });

  test('(−) every shape is refused on an unsafe screen, down and the ends included', async () => {
    const [, prompt] = REFUSED_SCREENS.find(([name]) => name === 'permission prompt');
    for (const body of [UP(1), DOWN(8), { to: 'top' }, { to: 'bottom' }]) {
      const h = harness({ captures: [ok(prompt)] });
      assert.equal((await h.run(body)).body.error, 'prompt-open');
      assert.equal(h.sends.length, 0);
    }
  });

  test('(−) a failed first capture answers with its own status and body, and nothing is sent', async () => {
    const failures = [
      { status: 404, body: { error: 'not_found', message: 'pane not found' } }, { status: 503, body: { error: 'tmux_unavailable', message: 'x' } },
      { status: 502, body: { error: 'tmux_failed', message: 'y' } }, { status: 400, body: { error: 'invalid', message: 'z' } },
    ];
    for (const f of failures) {
      const h = harness({ captures: [f, ok(view())] });
      assert.deepEqual(await h.run(UP(1)), f);
      assert.equal(h.sends.length, 0);
      assert.equal(h.captures.length, 1);
    }
  });

  test('(−) a first capture that throws is not swallowed and sends nothing', async () => {
    const h = harness({ captures: [new Error('boom')] });
    await assert.rejects(h.run(UP(1)), /boom/);
    assert.equal(h.sends.length, 0);
    assert.equal(h.held, 0, 'the lock is freed');
  });

  test('(−) the lock gives up (EPANEBUSY): 409 busy-switching, nothing captured or sent', async () => {
    const h = harness({ busy: true });
    const r = await h.run(UP(1));
    assert.deepEqual(r, { status: 409, body: { error: 'busy-switching' } });
    assert.deepEqual(h.log, ['lock']);
  });

  test('(−) any other lock failure is not turned into a 409', async () => {
    const h = harness({ lockThrows: Object.assign(new Error('disk'), { code: 'EIO' }) });
    await assert.rejects(h.run(UP(1)), /disk/);
    assert.equal(h.sends.length, 0);
    const plain = harness({ lockThrows: new Error('nothing special') });
    await assert.rejects(plain.run(UP(1)), /nothing special/);
  });

  test('(−) keyGap true (a Stop or End interrupt): 409 busy-switching inside the lock, nothing captured or sent', async () => {
    const h = harness({ gap: true });
    const r = await h.run(DOWN(2));
    assert.deepEqual(r, { status: 409, body: { error: 'busy-switching' } });
    assert.deepEqual(h.log, ['lock', 'gap'], 'the gap is asked after the lock, before any capture');
  });

  test('(−) keyGap is asked about the same pane, once, and a gap that closes lets the next request through', async () => {
    const asked = [];
    let blocked = true;
    const h = harness({ gap: (pane) => { asked.push(pane); return blocked; } });
    assert.equal((await h.run(UP(1), '%7')).status, 409);
    blocked = false;
    assert.equal((await h.run(UP(1), '%7')).status, 200);
    assert.deepEqual(asked, ['%7', '%7']);
  });

  test('(−) keys.send answers pass through with their status and body, and no second capture follows', async () => {
    const answers = [
      { status: 429, body: { error: 'busy', message: 'at most 20 requests per second per pane' } },
      { status: 502, body: { error: 'tmux_failed', message: 'x' } },
      { status: 404, body: { error: 'not_found', message: 'pane not found' } },
      { status: 400, body: { error: 'invalid', message: 'unknown key name' } },
    ];
    for (const send of answers) {
      const h = harness({ send });
      assert.deepEqual(await h.run(UP(2)), send);
      assert.equal(h.captures.length, 1, 'no look after keys that did not go out');
      assert.deepEqual(h.sleeps, []);
    }
  });
});

describe('createScroll.scroll: rate limit', () => {
  test('(−) the 11th request inside 1000 ms is 429 before the lock and before any capture', async () => {
    const h = harness({ tick: false });
    for (let i = 0; i < SCROLL_RATE; i += 1) assert.equal((await h.run(UP(1))).status, 200, `request ${i + 1}`);
    const before = [h.captures.length, h.sends.length, h.locks.length];
    const r = await h.run(UP(1));
    assert.deepEqual(r, { status: 429, body: { error: 'busy', message: 'at most 10 scroll requests per second per pane' } });
    assert.deepEqual([h.captures.length, h.sends.length, h.locks.length], before);
  });

  test('(+) the window slides: still full at 999 ms, free again at 1000 ms', async () => {
    const h = harness({ tick: false });
    for (let i = 0; i < SCROLL_RATE; i += 1) await h.run(UP(1));
    h.clock.t += 999;
    assert.equal((await h.run(UP(1))).status, 429);
    h.clock.t += 1;
    assert.equal((await h.run(UP(1))).status, 200);
  });

  test('(+) panes have their own budget; a quiet pane\'s old hits do not count against it', async () => {
    const h = harness({ tick: false });
    for (let i = 0; i < SCROLL_RATE; i += 1) await h.run(UP(1), '%5');
    assert.equal((await h.run(UP(1), '%5')).status, 429);
    assert.equal((await h.run(UP(1), '%6')).status, 200);
    h.clock.t += 5000;
    assert.equal((await h.run(UP(1), '%5')).status, 200);
    for (let i = 0; i < SCROLL_RATE - 1; i += 1) assert.equal((await h.run(UP(1), '%5')).status, 200);
    assert.equal((await h.run(UP(1), '%5')).status, 429);
  });

  test('(+) invalid requests do not use the budget; refused screens and busy locks do (a request got that far)', async () => {
    const h = harness({ tick: false });
    for (let i = 0; i < 30; i += 1) assert.equal((await h.run({ dir: 'up' })).status, 400);
    for (let i = 0; i < SCROLL_RATE; i += 1) assert.equal((await h.run(UP(1))).status, 200, 'the full budget is still there');
    const busy = harness({ tick: false, busy: true });
    for (let i = 0; i < SCROLL_RATE; i += 1) assert.equal((await busy.run(UP(1))).status, 409);
    assert.equal((await busy.run(UP(1))).status, 429, 'a flood of requests that wait for the lock is limited too');
  });
});

describe('createScroll.scroll: the log stays quiet', () => {
  test('(−) nothing of a request, good or bad, is written to the console', async () => {
    const seen = [];
    const names = ['log', 'info', 'warn', 'error', 'debug'];
    const saved = names.map((n) => console[n]);
    names.forEach((n) => { console[n] = (...a) => seen.push([n, ...a]); });
    try {
      const h = harness({ tick: false });
      await h.run(UP(2));
      await h.run({ dir: 'up', pages: 99, secret: 'hunter2' });
      await h.run(DOWN(1), '%99999999');
      const refused = harness({ captures: [ok(view({ alt: false }))] });
      await refused.run(UP(1));
      await harness({ busy: true }).run(UP(1));
      await harness({ send: { status: 502, body: { error: 'tmux_failed', message: 'x' } } }).run(UP(1));
    } finally {
      names.forEach((n, i) => { console[n] = saved[i]; });
    }
    assert.deepEqual(seen, []);
  });
});

describe('createScroll.scroll: with the real keys and mirror (tmux argv)', () => {
  const INFO = (alt) => `${COLS}\t7\t2\t3\t1\t${alt}`;
  const PILL_TEXT = `${' '.repeat(40)}${ESC}[38;5;231m${ESC}[48;5;237m Jump to bottom: fn+↓ to scroll ${ESC}[39m${ESC}[49m`;
  const screenText = (scrolled) => [
    '  Here is the answer.', scrolled ? PILL_TEXT : '', RULE, '❯ ', RULE, '  acme-api  master', MODE_LINE,
  ].join('\n') + '\n';

  /** A fake tmux for one pane: PPage/NPage/C-Home/C-End move a flag the capture shows as the pill. */
  function tmux({ alt = 1, prompt = false } = {}) {
    const st = { scrolled: false, calls: [] };
    const exec = async (cmd, args) => {
      st.calls.push([cmd, ...args]);
      if (args.includes('capture-pane')) return { stdout: prompt ? 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel\n' : screenText(st.scrolled), stderr: '' };
      if (args.includes('display-message')) return { stdout: `${INFO(alt)}\n`, stderr: '' };
      if (args.includes('send-keys')) {
        const key = args.at(-1);
        if (key === 'PPage' || key === 'C-Home') st.scrolled = true;
        if (key === 'C-End') st.scrolled = false;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected tmux call ${args.join(' ')}`);
    };
    return { exec, st };
  }
  const chain = (fake) => {
    let t = 5_000_000;
    const now = () => t;
    const mirror = createMirror({ exec: fake.exec, tmuxBin: '/opt/x/tmux', now });
    const keys = createKeys({ exec: fake.exec, tmuxBin: '/opt/x/tmux', now });
    return createScroll({ mirror, keys, lock: async (p, fn) => fn(), keyGap: () => false, now, sleep: async (ms) => { t += ms; } });
  };
  const sentKeys = (st) => st.calls.filter((c) => c.includes('send-keys'));

  test('(+) up 3 is three send-keys calls of PPage with the fixed argv, and the answer reads the pill', async () => {
    const fake = tmux();
    const r = await chain(fake).scroll(PANE, UP(3));
    assert.deepEqual(r, { status: 200, body: { sent: 3, scrolled: true } });
    assert.deepEqual(sentKeys(fake.st), Array(3).fill(['/opt/x/tmux', '-u', 'send-keys', '-t', PANE, '--', 'PPage']));
    const info = fake.st.calls.find((c) => c.includes('display-message'));
    assert.equal(info.at(-1), '#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{alternate_on}');
  });

  test('(+) top and bottom send C-Home and C-End, and down at the bottom is sent and reads scrolled false', async () => {
    const fake = tmux();
    const scroller = chain(fake);
    assert.deepEqual((await scroller.scroll(PANE, { to: 'top' })).body, { sent: 1, scrolled: true });
    assert.deepEqual((await scroller.scroll(PANE, { to: 'bottom' })).body, { sent: 1, scrolled: false });
    assert.deepEqual((await scroller.scroll(PANE, DOWN(2))).body, { sent: 2, scrolled: false });
    assert.deepEqual(sentKeys(fake.st).map((c) => c.at(-1)), ['C-Home', 'C-End', 'NPage', 'NPage']);
    assert.ok(sentKeys(fake.st).every((c) => !c.includes('-l') && !c.includes('-M') && !c.includes('-X')), 'literal text, mouse and copy-mode forms are never used');
  });

  test('(−) the alternate screen off: 409 no-view and no send-keys at all', async () => {
    const fake = tmux({ alt: 0 });
    const r = await chain(fake).scroll(PANE, UP(1));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'no-view');
    assert.deepEqual(sentKeys(fake.st), []);
  });

  test('(−) a permission prompt on screen: 409 prompt-open and no send-keys at all', async () => {
    const fake = tmux({ prompt: true });
    const r = await chain(fake).scroll(PANE, DOWN(1));
    assert.deepEqual([r.status, r.body.error], [409, 'prompt-open']);
    assert.deepEqual(sentKeys(fake.st), []);
  });

  test('(−) the keys check of the real sender still refuses anything that is not a scroll key it knows', async () => {
    const fake = tmux();
    const keys = createKeys({ exec: fake.exec, tmuxBin: '/opt/x/tmux' });
    for (const bad of ['C-d', 'C-Home ', 'Space']) assert.equal((await keys.send(PANE, { keys: [bad] })).status, 400, bad);
    assert.deepEqual(sentKeys(fake.st), []);
  });
});
