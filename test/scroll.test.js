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
import { RULE_ROW } from '../src/draft.js';
import * as modeJs from '../src/mode.js';
import { promptFromRows, modeFromRows, surveyShown, rowText } from '../src/mode.js';
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
  ['unreadable draft: history entry with a slash later in the row', view({ label: 'History 3/3', lines: ['older /entry'] })],
  ['unreadable draft: trailing space', view({ lines: ['fix the build '] })],
  ['unreadable draft: a tall box that does not start with a slash', view({ lines: Array.from({ length: 14 }, (_, i) => `line ${i}`) })],
  ['vim INSERT footer', view({ insert: true, lines: ['x'] })],
  ['a turn is running', view({ above: ['  Working on it', '  ✻ Thinking… (12s · esc to interrupt)'] })],
  ['already scrolled up (pill on screen)', view({ above: ['  older output', pill()], scrolled: true })],
];

/** The rule rows of a screen (indexes), as the draft reader sees them. */
const ruleRows = (rows) => rows.flatMap((r, i) => (RULE_ROW.test(rowText(r).trimEnd()) ? [i] : []));
const inBox = (cap) => { const r = ruleRows(cap.rows); return r.length >= 2 && cap.cursor.y > r.at(-2) && cap.cursor.y < r.at(-1); };
/** What a refused screen must show for the code to be refused for the reason the fixture names (not by accident of another check). */
const WHY = {
  prompt: (cap) => assert.notEqual(promptFromRows(cap.rows), null, 'a permission prompt parses'),
  survey: (cap) => {
    assert.equal(surveyShown(cap.rows), true);
    assert.ok(ruleRows(cap.rows).length >= 2 && inBox(cap), 'the box is there');
    assert.notEqual(modeFromRows(cap.rows), 'unknown', 'the footer is readable: the survey alone refuses');
  },
  footer: (cap) => {
    assert.ok(inBox(cap), 'two rules with the cursor between them: the footer is what is left');
    assert.equal(surveyShown(cap.rows), false);
    assert.equal(modeFromRows(cap.rows), 'unknown');
  },
  cursor: (cap) => {
    assert.ok(ruleRows(cap.rows).length >= 2 && !inBox(cap), 'two rules, the cursor outside them');
    assert.equal(surveyShown(cap.rows), false);
    assert.notEqual(modeFromRows(cap.rows), 'unknown', 'the footer is readable: the cursor alone refuses');
  },
  'no-cursor': (cap) => {
    assert.equal(cap.cursor, null);
    assert.ok(ruleRows(cap.rows).length >= 2);
    assert.notEqual(modeFromRows(cap.rows), 'unknown');
  },
  rules: (cap) => assert.ok(ruleRows(cap.rows).length < 2, 'fewer than two rule rows'),
  'slash-text': (cap) => {
    const d = readDraft(cap);
    assert.equal(d.state, 'text');
    assert.ok(d.text.startsWith('/'));
  },
  'slash-unreadable': (cap) => {
    const d = readDraft(cap);
    assert.equal(d.state, 'unreadable');
    assert.equal(d.text, '', 'an unreadable draft has no text: the first box row is what shows the slash');
    assert.match(rowText(cap.rows[d.box.top + 1]).replace(/\u00a0/g, ' '), /^ {0,2}\u276f \//);
  },
};

/** Screens on which nothing may be sent: [name, capture body, code, why (a key of WHY, or null for no-view)]. */
const REFUSED_SCREENS = [
  ['alternate screen off', view({ alt: false }), 'no-view', null],
  ['alt missing', (({ alt, ...rest }) => rest)(view()), 'no-view', null],
  ['alt not a boolean', { ...view(), alt: '1' }, 'no-view', null],
  ['alt off and a prompt', { rows: PROMPT.map(row), cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: false }, 'no-view', null],
  ['permission prompt', { rows: PROMPT.map(row), cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true }, 'prompt-open', 'prompt'],
  ['permission prompt below a plain box', { ...view(), rows: [...view().rows, ...PROMPT.map(row)] }, 'prompt-open', 'prompt'],
  ['AskUserQuestion footer', view({ footer: 'Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel' }), 'screen-unclear', 'footer'],
  ['ExitPlanMode style dialog: option rows between two rules, unknown footer', {
    rows: ['Ready to code?', RULE, '\u276f\u00a01. Yes, auto-accept edits', '  2. No, keep planning', RULE, ' ctrl-g to edit plan'].map(row),
    cursor: { x: 4, y: 2, visible: true }, cols: COLS, alt: true,
  }, 'screen-unclear', 'footer'],
  ['numbered dialog with no rule rows at all', {
    rows: ['Ready to code?', '', ' Would you like to proceed?', ' \u276f 1. Yes, auto-accept edits', '   2. No, keep planning', '', ' ctrl-g to edit plan'].map(row),
    cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true,
  }, 'screen-unclear', 'rules'],
  ['feedback survey', view({ above: ['\u25cf How is Claude doing this session? (optional)', '  1: Bad    2: Fine    3: Good    0: Dismiss'] }), 'screen-unclear', 'survey'],
  ['unknown footer', view({ footer: 'something Claude never drew' }), 'screen-unclear', 'footer'],
  ['overlay in place of the mode line', view({ footer: '/model \u00b7 Esc to close' }), 'screen-unclear', 'footer'],
  ['cursor on the status line below the box', (() => { const v = view(); return { ...v, cursor: { x: 2, y: v.rows.length - 2, visible: true } }; })(), 'screen-unclear', 'cursor'],
  ['cursor on the top rule', (() => { const v = view(); return { ...v, cursor: { x: 2, y: 2, visible: true } }; })(), 'screen-unclear', 'cursor'],
  ['no cursor', view({ cursor: null }), 'screen-unclear', 'no-cursor'],
  ['no rule rows', { rows: ['  Here is the answer.', MODE_LINE].map(row), cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true }, 'screen-unclear', 'rules'],
  ['one rule row', { rows: ['  Here is the answer.', RULE, '\u276f\u00a0', MODE_LINE].map(row), cursor: { x: 2, y: 2, visible: true }, cols: COLS, alt: true }, 'screen-unclear', 'rules'],
  ['no rows', { rows: [], cursor: { x: 0, y: 0, visible: true }, cols: COLS, alt: true }, 'screen-unclear', 'rules'],
  ['slash command being typed', view({ lines: ['/com'] }), 'menu-open', 'slash-text'],
  ['a lone slash', view({ lines: ['/'] }), 'menu-open', 'slash-text'],
  ['multi-line draft that starts with a slash', view({ lines: ['/help', 'more'] }), 'menu-open', 'slash-text'],
  ['bash box whose text starts with a slash (fails closed)', view({ mode: 'bash', lines: ['/usr/bin/true'] }), 'menu-open', 'slash-text'],
  ['unreadable draft (history entry) that starts with a slash', view({ label: 'History 3/3', lines: ['/compact'] }), 'menu-open', 'slash-unreadable'],
  ['unreadable draft (trailing space) that starts with a slash', view({ lines: ['/com '] }), 'menu-open', 'slash-unreadable'],
  ['unreadable draft (pasted text) that starts with a slash', view({ lines: ['/review [Pasted text #1 +20 lines]'] }), 'menu-open', 'slash-unreadable'],
  ['unreadable draft (tall box) that starts with a slash', view({ lines: ['/start', ...Array.from({ length: 13 }, (_, i) => `line ${i}`)] }), 'menu-open', 'slash-unreadable'],
];

// ---- the fake pane ------------------------------------------------------------------------------------------------------
const ok = (body) => ({ status: 200, body });
const keysOk = (n) => ({ status: 200, body: { sent: { text: 0, paste: 0, keys: n } } });
const busyError = () => Object.assign(new Error('another action is running on this pane'), { code: 'EPANEBUSY' });

/**
 * Options: captures (answers in order, the last repeats; an Error is thrown), send (the keys.send answer), busy (the lock gives up),
 * lockThrows, wait (true: the lock waits a tick before it runs fn, as withPaneLock does behind a running action), gap (boolean or
 * (pane) => boolean), sleepThrows, tick (false: sleep does not move the clock).
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
    if (o.wait) await new Promise((resolve) => setImmediate(resolve));
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

describe('pillShown (re-exported from src/mode.js; its own tests are in test/mode.test.js)', () => {
  test('(+) src/scroll.js still exports pillShown, and it is the one of src/mode.js (the row check lives beside surveyShown)', () => {
    assert.equal(typeof modeJs.pillShown, 'function');
    assert.equal(pillShown, modeJs.pillShown);
  });

  test('(+) both pill texts of spike S5 match through the scroll.js export; the same words in plain style do not', () => {
    assert.equal(pillShown([row('older output'), pill('Jump to bottom: fn+\u2193 to scroll'), row('  input')]), true);
    assert.equal(pillShown([pill('Jump to bottom (click) \u2193')]), true);
    assert.equal(pillShown([row('Jump to bottom: fn+\u2193 to scroll')]), false);
  });
});

describe('scrollGate', () => {
  test('(+) allowed screens give null', () => {
    for (const [name, cap] of ALLOWED_SCREENS) {
      assert.notEqual(readDraft(cap), null, `fixture ${name} must have a readable box`);
      assert.equal(scrollGate(cap), null, name);
    }
  });

  test('(−) every other screen gives its code, and each fixture is refused for the reason it names', () => {
    for (const [name, cap, code, why] of REFUSED_SCREENS) {
      assert.equal(scrollGate(cap), code, name);
      if (why !== null) WHY[why](cap);
      if (code === 'screen-unclear') {
        assert.equal(promptFromRows(cap.rows), null, `${name}: not a permission prompt`);
        assert.equal(readDraft(cap), null, `${name}: no plain box`);
      }
      assert.equal(why === null, code === 'no-view', `${name}: only no-view needs no screen reason`);
    }
  });

  test('(−) a slash menu fails closed: a text draft that starts with a slash, or an unreadable draft whose first box row starts with one after the glyph', () => {
    for (const lines of [['/'], ['/com'], ['/com '], ['/compact now'], ['/help', 'second row']]) {
      assert.equal(scrollGate(view({ lines })), 'menu-open', JSON.stringify(lines));
    }
    for (const label of ['History 3/3', null]) assert.equal(scrollGate(view({ label, lines: ['/x'] })), 'menu-open', String(label));
    for (const lines of [['older /entry'], ['run /compact now'], [' /indented'], ['x/'], ['\u2500/x']]) {
      for (const label of ['History 3/3', null]) assert.equal(scrollGate(view({ label, lines })), null, `${label} ${JSON.stringify(lines)}`);
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
  test('(+) every body shape sends its keys in one keys.send, in the order lock, gap, capture, gap again, send, settle, capture', async () => {
    const cases = [
      [UP(3), ['PPage', 'PPage', 'PPage']], [DOWN(1), ['NPage']], [{ to: 'top' }, ['C-Home']], [{ to: 'bottom' }, ['C-End']],
    ];
    for (const [body, keys] of cases) {
      const h = harness({ captures: [ok(view()), ok(view({ above: ['  older', pill()], scrolled: true }))] });
      const r = await h.run(body);
      assert.deepEqual(r, { status: 200, body: { sent: keys.length, scrolled: true } }, JSON.stringify(body));
      assert.deepEqual(h.sends, [{ pane: PANE, body: { keys }, held: true }]);
      assert.deepEqual(h.log, ['lock', 'gap', 'capture', 'gap', 'send', 'sleep 30', 'capture'], JSON.stringify(body));
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

  test('(+) the keys are fixed when the body is validated: a body the caller changes afterwards changes nothing', async () => {
    const changes = [
      (b) => { b.pages = 8; }, (b) => { b.pages = 99; }, (b) => { b.dir = 'left'; }, (b) => { delete b.pages; }, (b) => { b.keys = ['Enter']; },
      (b) => { b.dir = 'down'; },
    ];
    for (const [change, wait] of changes.flatMap((c) => [[c, false], [c, true]])) {
      const h = harness({ wait });
      const body = UP(2);
      const pending = h.scroller.scroll(PANE, body);
      change(body); // the request is inside the lock, or waiting for it
      h.requests += 1;
      const r = await pending;
      safe(h);
      assert.deepEqual(h.sends.map((x) => x.body), [{ keys: ['PPage', 'PPage'] }], `${change} wait=${wait}`);
      assert.deepEqual(r, { status: 200, body: { sent: 2, scrolled: false } }, `${change} wait=${wait}`);
    }
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

  test('(−) keyGap is asked about the same pane, and a gap that closes lets the next request through', async () => {
    const asked = [];
    let blocked = true;
    const h = harness({ gap: (pane) => { asked.push(pane); return blocked; } });
    assert.equal((await h.run(UP(1), '%7')).status, 409);
    assert.deepEqual(asked, ['%7'], 'a closed gap stops at the first look');
    blocked = false;
    assert.equal((await h.run(UP(1), '%7')).status, 200);
    assert.deepEqual(asked, ['%7', '%7', '%7'], 'two looks for the request that went through: before the capture and before the keys');
  });

  test('(−) a Stop that starts during the capture: keyGap is asked again right before the keys, 409 busy-switching, nothing sent', async () => {
    let looks = 0;
    const h = harness({ captures: [ok(view()), ok(view())], gap: () => { looks += 1; return looks >= 2; } });
    const r = await h.run(UP(3));
    assert.deepEqual(r, { status: 409, body: { error: 'busy-switching' } });
    assert.deepEqual(h.log, ['lock', 'gap', 'capture', 'gap'], 'the second look comes after the capture and the gate, before any send');
    assert.equal(h.sends.length, 0);
    assert.equal(h.captures.length, 1, 'no look after keys that were never sent');
    assert.deepEqual(h.sleeps, []);
  });

  test('(−) the second look comes after the screen gate: an unsafe screen is still told apart from a busy pane', async () => {
    const [, prompt] = REFUSED_SCREENS.find(([name]) => name === 'permission prompt');
    let looks = 0;
    const h = harness({ captures: [ok(prompt)], gap: () => { looks += 1; return looks >= 2; } });
    assert.equal((await h.run(UP(1))).body.error, 'prompt-open');
    assert.equal(looks, 1);
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
