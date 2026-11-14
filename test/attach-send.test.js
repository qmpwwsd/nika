import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachSend, checkAttachBody, errorCode, logCode } from '../src/attach-send.js';
import { readDraft } from '../src/session-control.js';
import { boxRows, span } from './helpers.js';

// The attachment send (0.5, W2, design-W2 section 5, T38, T51). Synthetic screens and files only: a scripted Claude pane (a box that
// grows by what is pasted, `[Image #N]` for an image path), a fake store and fake keys that record every send. After EVERY case the
// never-sent check runs: the only things sent are pastes whose content is exactly one record's path (or a space and the path) and at
// most one Enter, last; never literal text, Escape, C-u, BSpace, Tab, BTab, a digit, Up or Down.
const KEY = '0123456789abcdef';
const rec = (id, type, ext, dir = `/srv/nika/attachments/${KEY}`) => ({ id, path: `${dir}/${id}.${ext}`, type, size: 10 });
const PNG = rec('1111111111111111', 'png', 'png');
const PNG2 = rec('5555555555555555', 'jpeg', 'jpg');
const PDF = rec('2222222222222222', 'pdf', 'pdf');
const TXT = rec('3333333333333333', 'text', 'py');
const ALL = [PNG, PNG2, PDF, TXT];
const IMAGES = new Set(['png', 'jpeg', 'gif', 'webp']);
const PANE = '%7';
const BASE = '0000000000000000';
const chop = (text, width) => { const out = []; for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width)); return out.length ? out : ['']; };
const PROMPT = () => ({ rows: [[span('Read file')], [span(' Do you want to proceed?')], [span(' ❯ 1. Yes')], [span('   2. No')], [span(' Esc to cancel')]], cursor: { x: 0, y: 0, visible: true }, cols: 100 });
const SURVEY = ['● How is Claude doing this session? (optional)', '  1: Bad    2: Fine    3: Good    0: Dismiss'];

/** A scripted pane + fakes. `o`: cols, insert (vim INSERT shown), vim / plain (nika's memory), spaces ('none' | 'claude'), lag (captures before a paste shows), imageStaysText, drop, text, records, lockBusy. */
function rig(o = {}) {
  const opt = { cols: 100, insert: false, vim: false, plain: false, spaces: 'none', lag: 0, imageStaysText: false, drop: false, text: '', lockBusy: false, ...o };
  const pane = { text: opt.text, n: 0, prompt: false, screen: null, mode: 'prompt', state: 'idle', gap: false, cursor: undefined, pending: [], submitted: [], stateThrows: false };
  const sent = [];
  const captures = [];
  const slept = [];
  const log = [];
  const marked = [];
  const lookups = [];
  const states = [];
  let locks = 0;
  const records = new Map((opt.records ?? ALL).map((r) => [r.id, r]));
  const render = () => {
    if (pane.screen) return pane.screen;
    if (pane.prompt) return PROMPT();
    return boxRows({ cols: opt.cols, lines: pane.text === '' ? [''] : chop(pane.text, opt.cols - 4), mode: pane.mode, insert: opt.insert, ghost: pane.text === '' ? 'Try "fix lint errors"' : null, cursor: pane.cursor, pad: true });
  };
  const mirror = {
    async capture(id, inm, o2) {
      captures.push(o2);
      for (const p of pane.pending.splice(0)) {
        p.left -= 1;
        if (p.left > 0) pane.pending.push(p); else p.apply();
      }
      pane.onCapture?.(captures.length);
      const failed = pane.captureFail?.(captures.length);
      if (failed) return failed;
      const r = render();
      return { status: 200, body: { cols: r.cols, rows: r.rows, cursor: r.cursor, alt: false, scrolled: false } };
    },
  };
  const keys = {
    async send(id, body) {
      const failed = pane.failSend?.(body, sent.length + 1);
      sent.push(body);
      if (failed) return failed;
      if (body.paste !== undefined && !opt.drop) {
        const apply = () => {
          const hit = [...records.values()].find((r) => r.path === body.paste.trim());
          if (hit && IMAGES.has(hit.type) && !opt.imageStaysText) pane.text += `${opt.spaces === 'claude' && pane.text.endsWith(']') ? ' ' : ''}[Image #${(pane.n += 1)}]`;
          else pane.text += `${opt.spaces === 'claude' && pane.text !== '' && !body.paste.startsWith(' ') ? ' ' : ''}${body.paste}`;
        };
        if (opt.lag > 0) pane.pending.push({ left: opt.lag, apply }); else apply();
      }
      if (body.keys?.[0] === 'Enter') {
        pane.submitted.push(pane.text);
        pane.text = '';
      }
      pane.onSend?.(body, sent.length);
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 0 } } };
    },
  };
  const store = {
    async lookup(p, id) {
      lookups.push([p, id]);
      const r = records.get(id);
      return r ? { ...r } : null;
    },
    markSent(ids) { marked.push(...ids); },
  };
  const send = createAttachSend({
    mirror, keys, store,
    lock: async (id, fn) => {
      locks += 1;
      if (opt.lockBusy) throw Object.assign(new Error('another action is running on this pane'), { code: 'EPANEBUSY' });
      return fn();
    },
    keyGap: () => (typeof pane.gap === 'function' ? pane.gap(sent.length) : pane.gap),
    stateOf: async (id, o2) => {
      states.push(o2);
      if (pane.stateThrows) throw new Error('registry unreadable');
      return typeof pane.state === 'function' ? pane.state(sent.length) : pane.state;
    },
    vimOf: () => opt.vim,
    plainOf: () => opt.plain,
    sleep: async (ms) => { slept.push(ms); },
    log: (e) => log.push(e),
  });
  const base = () => readDraft(render())?.sig ?? BASE;
  return { pane, sent, captures, slept, log, marked, lookups, states, records, send, base, render, locks: () => locks, opt };
}

/** The never-sent check (design 5.5): see the file's first comment. */
function neverSent(rg) {
  const paths = new Set([...rg.records.values()].map((r) => r.path));
  rg.sent.forEach((b, i) => {
    assert.equal(b.text, undefined, `send ${i}: no literal text`);
    if (b.paste !== undefined) {
      assert.deepEqual(Object.keys(b), ['paste'], `send ${i}: a paste is only a paste`);
      assert.ok(paths.has(b.paste) || (b.paste.startsWith(' ') && paths.has(b.paste.slice(1))), `send ${i}: a paste is exactly one stored path (with at most one leading space)`);
    } else {
      assert.deepEqual(b, { keys: ['Enter'] }, `send ${i}: the only key is Enter`);
      assert.equal(i, rg.sent.length - 1, 'Enter is the last send');
    }
  });
  assert.ok(rg.sent.filter((b) => b.keys).length <= 1, 'at most one Enter');
}

/** Sends `recs` (default order) with `base` (default: what the screen reads now) and runs the never-sent check; an answer never carries a path. */
async function go(rg, recs, base = rg.base()) {
  const r = await rg.send.send(PANE, { ids: recs.map((x) => x.id), base });
  neverSent(rg);
  assert.equal(JSON.stringify(r).includes('/srv/'), false, 'an answer never carries a path');
  return r;
}
const pastes = (rg) => rg.sent.filter((b) => b.paste !== undefined).map((b) => b.paste);

describe('checkAttachBody', () => {
  const ok = { ids: [PNG.id], base: '0123456789abcdef' };

  test('(+) 1 to 6 different ids and a 16 hex base', () => {
    assert.equal(checkAttachBody(ok), null);
    assert.equal(checkAttachBody({ ids: ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444', '5555555555555555', '6666666666666666'], base: ok.base }), null);
  });

  test('(−) no ids, 7 ids, a duplicate, a bad id, a bad base, an extra or a missing key, not an object', () => {
    const seven = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(16));
    for (const body of [
      { ids: [], base: ok.base }, { ids: seven, base: ok.base }, { ids: [PNG.id, PNG.id], base: ok.base }, { ids: ['xyz'], base: ok.base },
      { ids: [PNG.id.toUpperCase().replace(/1/g, 'A')], base: ok.base }, { ids: [5], base: ok.base }, { ids: 'x', base: ok.base },
      { ids: [PNG.id], base: 'short' }, { ids: [PNG.id], base: ok.base.toUpperCase().replace(/0/g, 'A') }, { ids: [PNG.id], base: '' }, { ids: [PNG.id], base: 5 },
      { ids: [PNG.id] }, { base: ok.base }, { ...ok, extra: 1 }, { ids: [PNG.id], base: ok.base, path: '/etc/passwd' },
      null, [], 'ids', 5,
    ]) {
      const r = checkAttachBody(body);
      assert.equal(r?.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid');
    }
  });
});

describe('send: the road that works', () => {
  test('(+) an empty box and a PNG: one paste = the path, then Enter; the box read [Image #1]; 200 { sent: 1, images: 1 }; the file is marked sent', async () => {
    const rg = rig();
    const r = await go(rg, [PNG]);
    assert.deepEqual(r, { status: 200, body: { sent: 1, images: 1 } });
    assert.deepEqual(rg.sent, [{ paste: PNG.path }, { keys: ['Enter'] }]);
    assert.deepEqual(rg.pane.submitted, ['[Image #1]']);
    assert.deepEqual(rg.marked, [PNG.id]);
  });

  test('(+) text, then a PNG, a PDF and a text file: the image alone, the others with one leading space; Enter last', async () => {
    const rg = rig({ text: 'look at these' });
    const r = await go(rg, [PNG, PDF, TXT]);
    assert.deepEqual(r, { status: 200, body: { sent: 3, images: 1 } });
    assert.deepEqual(rg.sent, [{ paste: PNG.path }, { paste: ` ${PDF.path}` }, { paste: ` ${TXT.path}` }, { keys: ['Enter'] }]);
    assert.deepEqual(rg.pane.submitted, [`look at these[Image #1] ${PDF.path} ${TXT.path}`]);
    assert.deepEqual(rg.marked, [PNG.id, PDF.id, TXT.id], 'marked in the order of the ids');
  });

  test('(+) a PDF into an empty box has no leading space; the next file has one (the box is not empty any more)', async () => {
    const rg = rig();
    await go(rg, [PDF, TXT]);
    assert.deepEqual(rg.sent, [{ paste: PDF.path }, { paste: ` ${TXT.path}` }, { keys: ['Enter'] }]);
  });

  test('(+) two images in a row, then a text file: [Image #1][Image #2] and a space before the path', async () => {
    const rg = rig({ text: 'two shots' });
    const r = await go(rg, [PNG, PNG2, TXT]);
    assert.deepEqual(r, { status: 200, body: { sent: 3, images: 2 } });
    assert.deepEqual(rg.sent.slice(0, 3), [{ paste: PNG.path }, { paste: PNG2.path }, { paste: ` ${TXT.path}` }]);
  });

  test('(+) Claude adding its own spaces (between placeholders, before a path) reads back the same', async () => {
    const rg = rig({ text: 'look at these', spaces: 'claude' });
    const r = await go(rg, [PNG, PNG2, PDF]);
    assert.equal(r.status, 200);
    assert.match(rg.pane.submitted[0], /^look at these\[Image #1\] \[Image #2\] +\/srv\/nika\/attachments\//);
  });

  test('(+) a path wrapped over rows (60 columns, a long folder) reads back', async () => {
    const long = rec('7777777777777777', 'pdf', 'pdf', `/srv/nika/${'deep-folder-name/'.repeat(5)}${KEY}`);
    const rg = rig({ cols: 60, text: 'see the report', records: [...ALL, long] });
    const r = await go(rg, [long, TXT]);
    assert.equal(r.status, 200);
    assert.deepEqual(rg.pane.submitted, [`see the report ${long.path} ${TXT.path}`]);
  });

  test('(+) a vim INSERT box takes the paste; an empty box in plain mode and one with no memory of the edit mode do too', async () => {
    for (const o of [{ insert: true, vim: true }, { plain: true }, {}]) {
      const rg = rig(o);
      assert.equal((await go(rg, [PNG])).status, 200, JSON.stringify(o));
      assert.deepEqual(rg.pane.submitted, ['[Image #1]']);
    }
  });

  test('(+) the image placeholder shows only after a few captures: the wait polls every 150 ms for it', async () => {
    const rg = rig({ lag: 3 });
    assert.equal((await go(rg, [PNG])).status, 200);
    assert.deepEqual(rg.slept, [150, 150, 150]);
  });

  test('(+) every capture is fresh and every registry read skips its cache; a one-file send takes three captures and two registry reads', async () => {
    const rg = rig();
    await go(rg, [PNG]);
    assert.deepEqual(rg.captures, [{ fresh: true }, { fresh: true }, { fresh: true }]);
    assert.deepEqual(rg.states, [{ fresh: true }, { fresh: true }]);
    assert.deepEqual(rg.lookups, [[PANE, PNG.id]]);
  });
});

describe('send: nothing is sent', () => {
  const refused = async (rg, recs, error, extra = {}) => {
    const r = await go(rg, recs, extra.base);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, error);
    assert.equal(r.body.pasted, 0);
    assert.deepEqual(rg.sent, [], 'not one key');
    assert.deepEqual(rg.marked, []);
    return r;
  };

  test('(−) a bad body is 400 before the lock, the store, the screen or the registry is touched', async () => {
    const rg = rig();
    for (const body of [{}, { ids: [], base: BASE }, { ids: [PNG.id, PNG.id], base: BASE }, { ids: [PNG.id], base: 'x' }, { ids: [PNG.id], base: BASE, extra: 1 }]) {
      assert.equal((await rg.send.send(PANE, body)).status, 400);
    }
    assert.deepEqual([rg.locks(), rg.lookups.length, rg.captures.length, rg.states.length, rg.sent.length], [0, 0, 0, 0, 0]);
  });

  test('(−) attachment-gone: one id is unknown, another pane\'s, sent or changed (the store answers null): that id is named, nothing is sent, no capture', async () => {
    const rg = rig({ records: [PNG] });
    const r = await refused(rg, [PNG, PDF], 'attachment-gone');
    assert.equal(r.body.id, PDF.id);
    assert.equal(rg.captures.length, 0);
    assert.deepEqual(rg.lookups, [[PANE, PNG.id], [PANE, PDF.id]]);
  });

  test('(−) a stored path Claude could not take as one token (a space, a quote) or a type nika does not know: path-unusable, nothing sent', async () => {
    for (const bad of [rec('8888888888888888', 'png', 'png', '/srv/my files'), rec('8888888888888888', 'png', 'png', '/srv/it\'s'), rec('8888888888888888', 'png', 'png', 'relative/dir'), { ...PNG, id: '8888888888888888', type: 'svg' }]) {
      const rg = rig({ records: [bad] });
      assert.equal((await refused(rg, [bad], 'path-unusable')).body.id, bad.id);
    }
  });

  test('(−) not-idle: the registry says busy, has no live session (null), is unreadable, or an interrupt runs (keyGap); no capture is taken for the first two', async () => {
    for (const set of [(p) => { p.state = 'busy'; }, (p) => { p.state = 'attention'; }, (p) => { p.state = null; }, (p) => { p.stateThrows = true; }, (p) => { p.gap = true; }]) {
      const rg = rig();
      set(rg.pane);
      await refused(rg, [PNG], 'not-idle');
      assert.equal(rg.captures.length, 0);
    }
  });

  test('(−) not-idle: a permission prompt is on screen', async () => {
    const rg = rig();
    rg.pane.prompt = true;
    await refused(rg, [PNG], 'not-idle', { base: BASE });
  });

  test('(−) mode-unknown for a dialog footer, input-unreadable for a screen with a known footer and no box, for the survey and for no cursor', async () => {
    const dialog = boxRows({ cols: 100, lines: ['hello'], footer: 'Enter to select · ↑/↓ to navigate', pad: true });
    const noBox = { rows: [[span('hello')], [span('  ⏵⏵ auto mode on (shift+tab to cycle)')]], cursor: { x: 0, y: 0, visible: true }, cols: 100 };
    const s = boxRows({ cols: 100, lines: ['hello'], pad: true });
    const rows = s.rows.slice();
    rows.splice(rows.length - 2, 0, ...SURVEY.map((t) => [span(t)]));
    const survey = { ...s, rows };
    const noCursor = boxRows({ cols: 100, lines: ['hello'], cursor: null, pad: true });
    for (const [screen, error] of [[dialog, 'mode-unknown'], [noBox, 'input-unreadable'], [survey, 'input-unreadable'], [noCursor, 'input-unreadable']]) {
      const rg = rig();
      rg.pane.screen = screen;
      await refused(rg, [PNG], error, { base: BASE });
    }
  });

  test('(−) draft-unreadable with its reason and the draft: a pasted block, an image already in the box, spaces typed at the end, a wrap that reads two ways', async () => {
    const two = [`${'x'.repeat(55)} ${'y'.repeat(60)}`, 'z'.repeat(60)]; // the N-3 rows at 120 columns
    const cases = [
      [(rg) => { rg.pane.text = 'x [Pasted text #1 +3 lines]'; }, 'pasted'],
      [(rg) => { rg.pane.text = '[Image #4]'; }, 'pasted'],
      [(rg) => { rg.pane.text = 'abc'; rg.pane.cursor = { dx: 3 }; }, 'trailing'],
      [(rg) => { rg.pane.screen = boxRows({ cols: 120, lines: two, pad: true }); }, 'layout'],
    ];
    for (const [set, reason] of cases) {
      const rg = rig();
      set(rg);
      const r = await refused(rg, [PNG], 'draft-unreadable', { base: BASE });
      assert.equal(r.body.reason, reason);
      assert.equal(r.body.draft.state, 'unreadable');
      assert.equal(typeof r.body.draft.edit, 'string');
    }
  });

  test('(−) shell-mode: a ! box', async () => {
    const rg = rig();
    rg.pane.mode = 'bash';
    await refused(rg, [PNG], 'shell-mode', { base: BASE });
  });

  test('(−) draft-changed with the draft: the box is not what the page synced on', async () => {
    const rg = rig({ text: 'look at these' });
    const r = await refused(rg, [PNG], 'draft-changed', { base: BASE });
    assert.equal(r.body.draft.text, 'look at these');
    assert.equal(r.body.draft.sig, rg.base());
    assert.equal(r.body.draft.edit, 'unknown');
  });

  test('(−) cursor-not-at-end: the cursor sits inside the text (vim NORMAL sits one left); a paste would split the text', async () => {
    const rg = rig({ text: 'hello world' });
    rg.pane.cursor = { dx: -1 };
    const r = await refused(rg, [PNG], 'cursor-not-at-end', { base: rg.base() });
    assert.equal(r.body.draft.cursorAtEnd, false);
  });

  test('(−) vim-normal: an empty box while nika remembers vim and no INSERT shows', async () => {
    const rg = rig({ vim: true });
    const r = await refused(rg, [PNG], 'vim-normal', { base: rg.base() });
    assert.equal(r.body.draft.edit, 'normal');
  });
});

describe('send: it stops when the screen is not what was built (T38, T51)', () => {
  const stopped = async (rg, recs, error, pasted) => {
    const r = await go(rg, recs);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, error);
    assert.equal(r.body.pasted, pasted);
    assert.equal(rg.sent.some((b) => b.keys), false, 'no Enter');
    assert.deepEqual(rg.marked, []);
    return r;
  };

  test('(−) a permission prompt opens before the second paste: screen-changed { pasted: 1 }, no second paste, no Enter', async () => {
    const rg = rig();
    rg.pane.onCapture = (n) => { if (n === 3) rg.pane.prompt = true; }; // capture 1 = the first look, 2 = the wait, 3 = the look before paste 2
    await stopped(rg, [PNG, PDF], 'screen-changed', 1);
    assert.deepEqual(pastes(rg), [PNG.path]);
  });

  test('(−) a prompt opens while the first paste is read back: screen-changed { pasted: 1 }', async () => {
    const rg = rig({ lag: 2 });
    rg.pane.onCapture = (n) => { if (n === 3) rg.pane.prompt = true; };
    await stopped(rg, [PNG], 'screen-changed', 1);
  });

  test('(−) a prompt opens right before the Enter (the last fresh capture): no Enter', async () => {
    const rg = rig();
    rg.pane.onCapture = (n) => { if (n === 3) rg.pane.prompt = true; }; // 1 first look, 2 wait, 3 the capture before Enter
    await stopped(rg, [PNG], 'screen-changed', 1);
  });

  test('(−) Claude turns busy before the Enter: not-idle { pasted: n }, no Enter; nothing is cleared', async () => {
    const rg = rig({ text: 'go' });
    rg.pane.state = (nSent) => (nSent >= 2 ? 'busy' : 'idle'); // the read at step 2 sees idle; the read before Enter, after two pastes, sees busy
    await stopped(rg, [PNG, PDF], 'not-idle', 2);
    assert.equal(rg.pane.text, `go[Image #1] ${PDF.path}`, 'the box is left as it is');
  });

  test('(−) a Stop or End Escape goes out between the pastes, or right before the Enter: not-idle, no further key', async () => {
    const before2 = rig();
    before2.pane.gap = (nSent) => nSent >= 1;
    await stopped(before2, [PNG, PDF], 'not-idle', 1);
    assert.deepEqual(pastes(before2), [PNG.path]);
    const beforeEnter = rig();
    beforeEnter.pane.gap = (nSent) => nSent >= 1;
    await stopped(beforeEnter, [PNG], 'not-idle', 1);
  });

  test('(−) an image path that stays text after 1.5 s: not-taken { pasted: 1, id } after ten polls; the path is not cleared', async () => {
    const rg = rig({ imageStaysText: true });
    const r = await stopped(rg, [PNG], 'not-taken', 1);
    assert.equal(r.body.id, PNG.id);
    assert.deepEqual(rg.slept, Array(10).fill(150));
    assert.equal(rg.pane.text, PNG.path);
  });

  test('(−) a paste that never shows (a PDF, four polls): not-taken { pasted: 1, id }', async () => {
    const rg = rig({ drop: true });
    const r = await stopped(rg, [PDF], 'not-taken', 1);
    assert.equal(r.body.id, PDF.id);
    assert.deepEqual(rg.slept, Array(4).fill(150));
  });

  test('(−) the user types in the terminal between two pastes: screen-changed { pasted: 1 }', async () => {
    const rg = rig();
    rg.pane.onCapture = (n) => { if (n === 3) rg.pane.text += 'zz'; };
    await stopped(rg, [PNG, PDF], 'screen-changed', 1);
    assert.deepEqual(pastes(rg), [PNG.path]);
  });

  test('(−) the user types after the last paste, before the Enter: screen-changed, no Enter', async () => {
    const rg = rig({ text: 'hi' });
    rg.pane.onCapture = (n) => { if (n === 3) rg.pane.text += ' there'; };
    await stopped(rg, [PDF], 'screen-changed', 1);
  });

  test('(−) the paste lands as something else (the box shows other text): screen-changed after the polls', async () => {
    const rg = rig();
    rg.pane.onSend = () => { rg.pane.text = 'something else'; };
    await stopped(rg, [PNG], 'screen-changed', 1);
  });

  test('(−) the screen turns into a menu while waiting (no box): screen-changed', async () => {
    const rg = rig({ lag: 9 });
    rg.pane.onCapture = (n) => { if (n === 2) rg.pane.screen = boxRows({ cols: 100, lines: ['x'], footer: 'Enter to select', pad: true }); };
    await stopped(rg, [PNG], 'screen-changed', 1);
  });

  test('(−) a 429 on the second paste passes through with { pasted: 1 }; no Enter', async () => {
    const rg = rig();
    rg.pane.failSend = (b, n) => (n === 2 ? { status: 429, body: { error: 'busy', message: 'at most 20 requests per second per pane' } } : null);
    const r = await go(rg, [PNG, PDF]);
    assert.deepEqual(r, { status: 429, body: { error: 'busy', message: 'at most 20 requests per second per pane', pasted: 1 } });
    assert.equal(rg.sent.some((b) => b.keys), false);
    assert.deepEqual(rg.marked, []);
  });

  test('(−) a failed first paste: its own status, { pasted: 0 }; a failed Enter: its own status, { pasted: n }, nothing marked sent', async () => {
    const first = rig();
    first.pane.failSend = (b, n) => (n === 1 ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await go(first, [PNG]), { status: 502, body: { error: 'tmux_failed', message: 'x', pasted: 0 } });
    const enter = rig();
    enter.pane.failSend = (b) => (b.keys ? { status: 502, body: { error: 'tmux_failed', message: 'x' } } : null);
    assert.deepEqual(await go(enter, [PNG, PDF]), { status: 502, body: { error: 'tmux_failed', message: 'x', pasted: 2 } });
    assert.deepEqual(enter.marked, []);
  });

  test('(−) a capture that fails after a paste passes its status through with { pasted }', async () => {
    const rg = rig();
    rg.pane.captureFail = (n) => (n === 2 ? { status: 404, body: { error: 'not_found', message: 'pane not found' } } : null);
    assert.deepEqual(await go(rg, [PNG]), { status: 404, body: { error: 'not_found', message: 'pane not found', pasted: 1 } });
    const first = rig();
    first.pane.captureFail = () => ({ status: 503, body: { error: 'tmux_unavailable', message: 'x' } });
    assert.deepEqual(await go(first, [PNG]), { status: 503, body: { error: 'tmux_unavailable', message: 'x', pasted: 0 } });
    assert.deepEqual(first.sent, []);
  });

  test('(−) the pane lock is held for 5 s (EPANEBUSY): 409 busy-switching, nothing looked at or sent', async () => {
    const rg = rig({ lockBusy: true });
    const r = await go(rg, [PNG]);
    assert.deepEqual(r, { status: 409, body: { error: 'busy-switching', pasted: 0 } });
    assert.deepEqual([rg.lookups.length, rg.captures.length, rg.states.length, rg.sent.length], [0, 0, 0, 0]);
  });

  test('(−) an unexpected error is 500 internal with the paste count, logged, and the answer carries nothing of it', async () => {
    const rg = rig();
    rg.pane.onCapture = (n) => { if (n === 2) throw Object.assign(new Error('boom /srv/nika/secret/path'), { code: 'EIO' }); };
    const r = await go(rg, [PNG]);
    assert.deepEqual(r, { status: 500, body: { error: 'internal', message: 'internal error', pasted: 1 } });
    assert.equal(rg.log.length, 1);
    assert.equal(rg.sent.some((b) => b.keys), false);
  });
});

describe('the log carries a code, never a message', () => {
  test('(+) errorCode keeps a node error code, anything else is ERR; logCode writes one fixed-shape line', () => {
    assert.equal(errorCode(Object.assign(new Error('/srv/x'), { code: 'EIO' })), 'EIO');
    assert.equal(errorCode(Object.assign(new Error('x'), { code: 'not a code /srv/x' })), 'ERR');
    assert.equal(errorCode(new Error('/srv/x')), 'ERR');
    assert.equal(errorCode(null), 'ERR');
    const lines = [];
    const write = process.stderr.write;
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    try {
      logCode(Object.assign(new Error('/srv/nika/secret'), { code: 'EIO' }));
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(lines, ['nika: attachments: EIO\n']);
  });

  test('(−) the default log of the sender writes only the code of an unexpected error', async () => {
    const rg = rig();
    const lines = [];
    const write = process.stderr.write;
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    const send = createAttachSend({
      mirror: { capture: async () => { throw Object.assign(new Error('boom /srv/nika/secret'), { code: 'EACCES' }); } },
      keys: { send: async () => { throw new Error('never'); } }, store: { lookup: async (p, id) => ({ ...PNG, id }), markSent() {} },
      lock: async (p, fn) => fn(), keyGap: () => false, stateOf: async () => 'idle', vimOf: () => false,
    });
    try {
      const r = await send.send(PANE, { ids: [PNG.id], base: BASE });
      assert.equal(r.status, 500);
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(lines, ['nika: attachments: EACCES\n']);
    assert.equal(rg.sent.length, 0);
  });
});

describe('source', () => {
  test('(−) src/attach-send.js is pure ASCII, sends only pastes and Enter, and imports no I/O', async () => {
    const { default: fs } = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/attach-send.js', import.meta.url), 'utf8');
    assert.match(src, /^[\x00-\x7f]*$/);
    assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort(), ['./attachments.js', './draft.js', './mode.js', './session-control.js']);
    const bodies = [...src.matchAll(/\bpress\(\{ (.*) \}\)/g)].map((m) => m[1].trim());
    assert.deepEqual(bodies, ["paste: image || expect === '' ? r.path : ` ${r.path}`", "keys: ['Enter']"], 'the only two key bodies the module builds');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.doesNotMatch(code, /\b(Escape|BSpace|BTab|C-u|send-keys|execFile|child_process)\b/);
  });
});
