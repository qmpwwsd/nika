// 0.5.4 RM: Remove from the list, on the page (design-053-rm 2, 6; public/removed.js, app.js, project.js, index.html, tokens.css, app.css).
// The browser itself is exercised by hand; here the real removed.js runs in a vm against the small fake DOM (test/fake-dom.js) and recorded
// requests, the pieces of app.js and project.js that cannot be imported are run from their own source, and the markup, the colours and the
// served-file list are checked as text. The copy strings are written out here from design 2.3 and 2.4 on purpose: the tests must not read them
// back from the code under test. Synthetic data only.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, focus } from './fake-dom.js';
import { h, icon, timeEl, timeWordsEl, ago, agoWords } from '../public/dom.js';
import { menuEl, sessionHref, SHAPE } from '../public/ui.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} exists`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
};
const plain = (v) => JSON.parse(JSON.stringify(v)); // values built inside a vm have another realm's prototypes
const HTML = read('index.html');
const TOKENS = read('tokens.css');
const APP_CSS = read('app.css');
const REMOVED = read('removed.js');
const APP = code(read('app.js'));
const PROJECT = code(read('project.js'));

let restore;
before(() => { restore = installDom({ querySelector: () => null }); });
after(() => restore());

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const KEY = 'abcd1234abcd1234';
const KEY2 = 'bcde2345bcde2345';
const ELL = '\u2026';

// ---- the page code in a vm ---------------------------------------------------------------------------------------------------------

const SLOW = 400;
const UNDO_MS = 10000;

/** The real removed.js with recorded requests, toasts and timers. `routes`: 'METHOD url' -> { status, body } | 'net' | async function. */
function rig({ app = true, routes = {}, hold = [], headings = [], hiddenHeadings = [] } = {}) {
  const calls = [];
  const toasts = [];
  const timers = [];
  const opened = [];
  const announced = [];
  const gates = new Map();
  const nodes = new Map();
  const present = new Set(['#dlg-removed', '#rm-body', '#rm-h', '.screen:not([hidden]) h1']);
  const node = (sel) => {
    if (!nodes.has(sel)) {
      const el = new El(sel === '#dlg-removed' ? 'dialog' : sel.endsWith('h1') || sel.startsWith('#g-') || sel === '#rm-h' ? 'h2' : 'div');
      if (sel.startsWith('#g-')) el.offsetParent = hiddenHeadings.includes(sel.slice(3)) ? null : {}; // a heading of a screen that is hidden has no offsetParent
      nodes.set(sel, el);
    }
    return nodes.get(sel);
  };
  const $ = (sel) => {
    if (sel.startsWith('#g-')) return headings.includes(sel.slice(3)) ? node(sel) : null;
    return present.has(sel) ? node(sel) : null;
  };
  const ctx = {
    h, icon, timeWordsEl, $, SHAPE, JSON, Number, Promise, Object, Array, Set, Map, Math, String, Boolean, Error, Date, isApp: app,
    toast: (msg, o = {}) => {
      const el = new El('div');
      const t = { msg, ...o, el, removed: false };
      el.remove = () => { t.removed = true; };
      toasts.push(t);
      return el;
    },
    announce: (m) => announced.push(m),
    setBusy: (b, on, label) => { b.disabled = on; b.busy = on ? label : null; },
    openDialog: (dlg, o) => { dlg.open = true; opened.push({ dlg, o }); },
    setTimeout: (f, ms) => { const t = { f, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    appFetch: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      const key = `${method} ${url}`;
      calls.push({ method, url, json: opts.json === undefined ? undefined : plain(opts.json) });
      if (hold.includes(key)) {
        hold.splice(hold.indexOf(key), 1); // one-shot: only the first request of this kind waits
        await new Promise((r) => gates.set(key, r));
      }
      const given = routes[key];
      if (given === 'net') throw new Error('network down');
      if (typeof given === 'function') return given();
      if (given === undefined) throw new Error(`unexpected request ${key}`);
      return given;
    },
  };
  const src = code(REMOVED).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
  const mod = vm.runInNewContext(`${src}\n({ removeRow, removeGroup, removedLineEl, openRemovedList, removedView, removeOutcome })`, ctx);
  const refreshed = { n: 0 };
  const refresh = async () => { refreshed.n += 1; };
  return {
    mod, calls, toasts, timers, opened, announced, refresh, refreshed, node, release: (key) => gates.get(key)?.(),
    toastTexts: () => toasts.map((t) => t.msg),
    last: () => toasts[toasts.length - 1],
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

const row = (o = {}) => ({ id: ID, name: 'planner', live: false, pane: null, ...o });
const grp = (o = {}) => ({ key: KEY, label: 'demo', root: '/tmp/nika-test/demo', project: null, agents: [], ...o });
const OK = { status: 200, body: { hidden: true, dropped: 0 } };
const OK_BACK = { status: 200, body: { hidden: false } };
const rmUrl = (id = ID) => `POST /api/app/session/${id}/remove`;
const unUrl = (id = ID) => `POST /api/app/session/${id}/unhide`;
const grmUrl = (key = KEY) => `POST /api/app/groups/${key}/remove`;
const gunUrl = (key = KEY) => `POST /api/app/groups/${key}/unhide`;
const LIST = 'GET /api/app/hidden';

// ---- removeOutcome and removedView (pure) --------------------------------------------------------------------------------------------

describe('removeOutcome: the fixed copy of design 2.3, picked by the code and never by the server message', () => {
  const { mod } = rig();
  const out = (res) => plain(mod.removeOutcome(res));

  test('(+) each answer maps to its copy', () => {
    assert.deepEqual(out({ status: 200, body: { hidden: true, dropped: 0 } }), { kind: 'ok', text: null });
    assert.deepEqual(out({ status: 404, body: { error: 'not_found' } }), { kind: 'gone', text: "It's no longer in nika's list." });
    assert.deepEqual(out({ status: 409, body: { error: 'in-tmux' } }), { kind: 'in-tmux', text: 'This session runs in tmux. End it first.' });
    assert.deepEqual(out({ status: 409, body: { error: 'registered' } }), { kind: 'registered', text: 'This folder is a nika project now. Remove it on its project page.' });
    assert.deepEqual(out({ status: 500, body: { error: 'write_failed' } }), { kind: 'write', text: "Couldn't save the change. Nothing was removed." });
    assert.deepEqual(out({ status: 503, body: { error: 'index_unavailable' } }), { kind: 'index', text: "nika can't read its list of sessions right now. Nothing was removed." });
  });

  test('(\u2212) a network failure, a missing answer and any other answer read "Couldn\'t reach nika"', () => {
    const net = { kind: 'net', text: "Couldn't reach nika. Nothing was removed." };
    for (const res of [null, undefined, {}, { status: 200, body: {} }, { status: 200, body: { hidden: false } }, { status: 200, body: null }, { status: 400, body: { error: 'invalid' } },
      { status: 409, body: { error: 'other' } }, { status: 409, body: null }, { status: 500, body: { error: 'internal' } }, { status: 503, body: { error: 'x' } }, { status: 403, body: {} }]) {
      assert.deepEqual(out(res), net, JSON.stringify(res));
    }
  });

  test('(\u2212) the server message never reaches the text', () => {
    const secret = 'secret server message';
    for (const status of [404, 409, 500, 503, 400, 200]) {
      for (const error of ['not_found', 'in-tmux', 'registered', 'write_failed', 'index_unavailable', 'invalid', 'x']) {
        assert.ok(!String(mod.removeOutcome({ status, body: { error, message: secret } }).text ?? '').includes('secret'), `${status} ${error}`);
      }
    }
  });
});

describe('removedView: the list answer as view rows', () => {
  const { mod } = rig();
  const view = (b) => plain(mod.removedView(b));
  const body = (o = {}) => ({ groups: [], sessions: [], more: { groups: 0, sessions: 0 }, ...o });

  test('(+) folders and sessions become rows; a missing label or name has a fixed stand-in', () => {
    const v = view(body({
      groups: [{ key: KEY, label: 'demo', root: '/tmp/nika-test/demo', at: 5 }, { key: KEY2, label: null, root: null, at: 4 }],
      sessions: [{ id: ID, name: 'planner', project: 'demo', at: 3 }, { id: ID2, name: null, project: null, at: 2 }],
    }));
    assert.deepEqual(v.groups, [{ key: KEY, name: 'demo', path: '/tmp/nika-test/demo', at: 5 }, { key: KEY2, name: 'Folder with no recent sessions', path: null, at: 4 }]);
    assert.deepEqual(v.sessions, [{ id: ID, name: 'planner', project: 'demo', at: 3 }, { id: ID2, name: '22222222', project: null, at: 2 }]);
    assert.equal(v.empty, false);
    assert.deepEqual(v.more, { groups: 0, sessions: 0 });
  });

  test('(+) nothing removed is empty', () => {
    assert.equal(view(body()).empty, true);
  });

  test('(+) more counts what the server did not send, and a row beyond 100 is counted there too', () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `s${i}`, project: null, at: i }));
    const v = view(body({ sessions: many, more: { groups: 7, sessions: 20 } }));
    assert.equal(v.sessions.length, 100);
    assert.deepEqual(v.more, { groups: 7, sessions: 50 });
  });

  test('(\u2212) a body that is not the route\'s shape is null (the page shows its error state, not an empty list)', () => {
    for (const b of [null, undefined, 'x', 7, [], {}, { groups: [] }, { sessions: [] }, { groups: {}, sessions: [] }, { groups: [], sessions: 'x' }]) assert.equal(mod.removedView(b), null, JSON.stringify(b));
  });

  test('(\u2212) a row that does not fit is skipped; a bad "more" is 0', () => {
    const v = view(body({
      groups: [{ key: 'ABC', label: 'x', root: null, at: 1 }, { key: KEY, label: 'ok', root: null, at: 'x' }, null, 'x', { key: KEY, label: 'kept', root: null, at: 1 }],
      sessions: [{ id: 'nope', name: 'x', project: null, at: 1 }, { id: ID, name: 'kept', project: null, at: Infinity }, { id: ID, name: 'kept', project: null, at: 1 }, 7],
      more: { groups: -3, sessions: 'many' },
    }));
    assert.deepEqual(v.groups.map((g) => g.name), ['kept']);
    assert.deepEqual(v.sessions.map((s) => s.name), ['kept']);
    assert.deepEqual(v.more, { groups: 0, sessions: 0 });
  });
});

// ---- removeRow -----------------------------------------------------------------------------------------------------------------------

describe('removeRow: POST remove, a toast with Undo, refresh, focus', () => {
  test('(+) sends {} to the session\'s remove route, then shows "Removed <name> from the list." with Undo for 10 s, then refreshes', async () => {
    const r = rig({ routes: { [rmUrl()]: OK } });
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    assert.deepEqual(r.calls, [{ method: 'POST', url: `/api/app/session/${ID}/remove`, json: {} }]);
    const t = r.last();
    assert.equal(t.msg, 'Removed planner from the list.');
    assert.equal(t.ms, UNDO_MS);
    assert.equal(t.action.label, 'Undo');
    assert.notEqual(t.kind, 'error');
    assert.equal(r.refreshed.n, 1);
  });

  test('(+) a long name is cut at 40 characters with an ellipsis', async () => {
    const r = rig({ routes: { [rmUrl()]: OK } });
    await r.mod.removeRow(row({ name: 'n'.repeat(60) }), grp(), { refresh: r.refresh });
    assert.equal(r.last().msg, `Removed ${'n'.repeat(39)}${ELL} from the list.`);
    const exact = rig({ routes: { [rmUrl()]: OK } });
    await exact.mod.removeRow(row({ name: 'e'.repeat(40) }), grp(), { refresh: exact.refresh });
    assert.equal(exact.last().msg, `Removed ${'e'.repeat(40)} from the list.`);
  });

  test('(+) Undo posts {} to unhide, says "Back in the list." and refreshes', async () => {
    const r = rig({ routes: { [rmUrl()]: OK, [unUrl()]: OK_BACK } });
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    await r.last().action.run();
    assert.deepEqual(r.calls[1], { method: 'POST', url: `/api/app/session/${ID}/unhide`, json: {} });
    assert.equal(r.last().msg, 'Back in the list.');
    assert.notEqual(r.last().kind, 'error');
    assert.equal(r.refreshed.n, 2);
  });

  test('(\u2212) Undo that fails (an error answer, a network failure, a wrong answer) says to use Show removed, as an error', async () => {
    for (const un of [{ status: 500, body: { error: 'write_failed' } }, 'net', { status: 200, body: { hidden: true } }, { status: 404, body: {} }]) {
      const r = rig({ routes: { [rmUrl()]: OK, [unUrl()]: un } });
      await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
      await r.last().action.run();
      assert.equal(r.last().msg, "Couldn't undo. Use Show removed to bring it back.", JSON.stringify(un));
      assert.equal(r.last().kind, 'error');
    }
  });

  test('(+) focus goes to the group heading when the group still shows, else to the screen heading', async () => {
    const r = rig({ routes: { [rmUrl()]: OK }, headings: [KEY] });
    focus.el = null;
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    assert.equal(focus.el, r.node(`#g-${KEY}`));
    const r2 = rig({ routes: { [rmUrl()]: OK } });
    focus.el = null;
    await r2.mod.removeRow(row(), grp(), { refresh: r2.refresh });
    assert.equal(focus.el, r2.node('.screen:not([hidden]) h1'));
  });

  test('(+) a group heading that is in the page but hidden (the dashboard behind the project screen) is not focused: the visible screen heading is', async () => {
    const r = rig({ routes: { [rmUrl()]: OK, [grmUrl()]: OK }, headings: [KEY], hiddenHeadings: [KEY] });
    focus.el = null;
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    assert.equal(focus.el, r.node('.screen:not([hidden]) h1'), 'a row removed on the project page');
    focus.el = null;
    await r.mod.removeGroup(grp(), { refresh: r.refresh });
    assert.equal(focus.el, r.node('.screen:not([hidden]) h1'), 'a folder, same rule');
    assert.notEqual(focus.el, r.node(`#g-${KEY}`));
  });

  test('(+) a request that takes over 400 ms shows a spinner toast, which goes when the answer comes; a fast one shows none', async () => {
    const slow = rig({ routes: { [rmUrl()]: OK }, hold: [rmUrl()] });
    const p = slow.mod.removeRow(row(), grp(), { refresh: slow.refresh });
    await slow.settle();
    const timer = slow.timers.find((t) => t.ms === SLOW);
    assert.ok(timer && !timer.cleared, 'the 400 ms timer runs');
    timer.f();
    const spin = slow.toasts.find((t) => t.msg === `Removing from the list${ELL}`);
    assert.ok(spin, 'the spinner toast');
    assert.equal(spin.spin, true);
    assert.equal(spin.ms, 0, 'it stays until the answer');
    assert.equal(spin.removed, false);
    slow.release(rmUrl());
    await p;
    assert.equal(spin.removed, true);
    assert.equal(slow.last().msg, 'Removed planner from the list.');
    const fast = rig({ routes: { [rmUrl()]: OK } });
    await fast.mod.removeRow(row(), grp(), { refresh: fast.refresh });
    assert.ok(fast.timers.every((t) => t.cleared), 'the timer was cleared');
    assert.ok(!fast.toastTexts().includes(`Removing from the list${ELL}`));
  });

  test('(+) a second Remove of the same row while the first is in flight sends nothing; another row, or the same row afterwards, goes', async () => {
    const r = rig({ routes: { [rmUrl()]: OK, [rmUrl(ID2)]: OK }, hold: [rmUrl()] });
    const first = r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    await r.settle();
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    assert.equal(r.calls.filter((c) => c.url.endsWith(`${ID}/remove`)).length, 1, 'one request for the row');
    await r.mod.removeRow(row({ id: ID2 }), grp(), { refresh: r.refresh });
    assert.equal(r.calls.filter((c) => c.url.endsWith(`${ID2}/remove`)).length, 1, 'another row is not blocked');
    r.release(rmUrl());
    await first;
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    assert.equal(r.calls.filter((c) => c.url.endsWith(`${ID}/remove`)).length, 2, 'free again once the first is done');
  });

  test('(+) the pending mark is cleared after a failure too', async () => {
    const r = rig({ routes: { [rmUrl()]: 'net' } });
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    assert.equal(r.calls.length, 2);
  });

  const COPY = [
    [{ status: 404, body: {} }, "It's no longer in nika's list.", 'info', 1],
    [{ status: 409, body: { error: 'in-tmux' } }, 'This session runs in tmux. End it first.', 'error', 0],
    [{ status: 500, body: { error: 'write_failed' } }, "Couldn't save the change. Nothing was removed.", 'error', 0],
    [{ status: 503, body: { error: 'index_unavailable' } }, "nika can't read its list of sessions right now. Nothing was removed.", 'error', 0],
    ['net', "Couldn't reach nika. Nothing was removed.", 'error', 0],
  ];
  for (const [res, text, kind, refreshes] of COPY) {
    test(`(\u2212) ${typeof res === 'string' ? 'a network failure' : res.status} shows "${text}" (${kind}), no Undo, and ${refreshes ? 'refreshes' : 'does not refresh'}`, async () => {
      const r = rig({ routes: { [rmUrl()]: res } });
      await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
      assert.equal(r.toasts.length, 1);
      assert.equal(r.last().msg, text);
      assert.equal(r.last().kind ?? 'info', kind);
      assert.equal(r.last().action ?? null, null);
      assert.equal(r.refreshed.n, refreshes);
    });
  }

  test('(\u2212) a row id that is not a UUID, and the browser tier, send nothing and show nothing', async () => {
    const r = rig({ routes: {} });
    for (const id of ['x', '../x', `${ID}/remove`, '', undefined, 7]) await r.mod.removeRow(row({ id }), grp(), { refresh: r.refresh });
    assert.deepEqual([r.calls.length, r.toasts.length], [0, 0]);
    const b = rig({ app: false, routes: {} });
    await b.mod.removeRow(row(), grp(), { refresh: b.refresh });
    assert.deepEqual([b.calls.length, b.toasts.length], [0, 0]);
  });

  test('(\u2212) a hostile name stays text in the toast', async () => {
    const r = rig({ routes: { [rmUrl()]: OK } });
    await r.mod.removeRow(row({ name: '<img src=x onerror=alert(1)>' }), grp(), { refresh: r.refresh });
    assert.equal(r.last().msg, 'Removed <img src=x onerror=alert(1)> from the list.');
    assert.equal(r.last().el.all((n) => n.tag === 'img').length, 0);
  });
});

// ---- removeGroup ---------------------------------------------------------------------------------------------------------------------

describe('removeGroup: POST remove on a detected folder', () => {
  test('(+) sends {} to the group\'s remove route; the toast names the folder and the session count (4, 1, none)', async () => {
    for (const [n, tail] of [[4, ' (4 sessions)'], [1, ' (1 session)'], [0, '']]) {
      const r = rig({ routes: { [grmUrl()]: { status: 200, body: { hidden: true, sessions: n, dropped: 0 } } } });
      await r.mod.removeGroup(grp(), { refresh: r.refresh });
      assert.deepEqual(r.calls, [{ method: 'POST', url: `/api/app/groups/${KEY}/remove`, json: {} }]);
      assert.equal(r.last().msg, `Removed demo from the list${tail}.`, String(n));
      assert.equal(r.last().ms, UNDO_MS);
      assert.equal(r.last().action.label, 'Undo');
      assert.equal(r.refreshed.n, 1);
    }
  });

  test('(+) Undo posts to the group\'s unhide route', async () => {
    const r = rig({ routes: { [grmUrl()]: { status: 200, body: { hidden: true, sessions: 2, dropped: 0 } }, [gunUrl()]: OK_BACK } });
    await r.mod.removeGroup(grp(), { refresh: r.refresh });
    await r.last().action.run();
    assert.deepEqual(r.calls[1], { method: 'POST', url: `/api/app/groups/${KEY}/unhide`, json: {} });
    assert.equal(r.last().msg, 'Back in the list.');
  });

  test('(+) focus goes to the dashboard heading when the group is gone', async () => {
    const r = rig({ routes: { [grmUrl()]: { status: 200, body: { hidden: true, sessions: 2, dropped: 0 } } } });
    focus.el = null;
    await r.mod.removeGroup(grp(), { refresh: r.refresh });
    assert.equal(focus.el, r.node('.screen:not([hidden]) h1'));
  });

  test('(\u2212) 409 registered and the other answers show the fixed copy; the sessions count is not trusted when it is not a count', async () => {
    const reg = rig({ routes: { [grmUrl()]: { status: 409, body: { error: 'registered' } } } });
    await reg.mod.removeGroup(grp(), { refresh: reg.refresh });
    assert.equal(reg.last().msg, 'This folder is a nika project now. Remove it on its project page.');
    assert.equal(reg.last().kind, 'error');
    for (const sessions of ['4', -1, 1.5, null, undefined, 1e9]) {
      const r = rig({ routes: { [grmUrl()]: { status: 200, body: { hidden: true, sessions, dropped: 0 } } } });
      await r.mod.removeGroup(grp(), { refresh: r.refresh });
      assert.ok(/^Removed demo from the list(?: \(\d{1,6} sessions?\))?\.$/.test(r.last().msg), `${sessions}: ${r.last().msg}`);
      assert.ok(!r.last().msg.includes('NaN'));
    }
  });

  test('(\u2212) a key that is not a project key, and the browser tier, send nothing', async () => {
    const r = rig({ routes: {} });
    for (const key of ['x', 'ABCD1234ABCD1234', `${KEY}/remove`, '', undefined, null, `${KEY}0`]) await r.mod.removeGroup(grp({ key }), { refresh: r.refresh });
    assert.deepEqual([r.calls.length, r.toasts.length], [0, 0]);
    const b = rig({ app: false, routes: {} });
    await b.mod.removeGroup(grp(), { refresh: b.refresh });
    assert.deepEqual([b.calls.length, b.toasts.length], [0, 0]);
  });

  test('(\u2212) a second Remove of the same folder while the first is in flight sends nothing; a folder and a session never block each other', async () => {
    const r = rig({ routes: { [grmUrl()]: { status: 200, body: { hidden: true, sessions: 1, dropped: 0 } }, [rmUrl()]: OK }, hold: [grmUrl()] });
    const first = r.mod.removeGroup(grp(), { refresh: r.refresh });
    await r.settle();
    await r.mod.removeGroup(grp(), { refresh: r.refresh });
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    assert.equal(r.calls.filter((c) => c.url.includes('/groups/')).length, 1);
    assert.equal(r.calls.filter((c) => c.url.includes('/session/')).length, 1);
    r.release(grmUrl());
    await first;
  });
});

// ---- the removed line ---------------------------------------------------------------------------------------------------------------

describe('removedLineEl: the dashboard and project page line', () => {
  test('(+) app tier, dashboard: eye-off icon (aria-hidden), the text, and a Show button named "Show 3 removed"', () => {
    const r = rig();
    const el = r.mod.removedLineEl(3, { where: 'dash', refresh: r.refresh });
    assert.match(el.className, /\brm-line\b/);
    assert.equal(el.textContent.startsWith('3 removed from the list'), true);
    const ic = el.all((n) => n.tag === 'use')[0];
    assert.equal(ic.attrs.href, '#i-eye-off');
    const svg = el.all((n) => n.tag === 'svg')[0];
    assert.equal(svg.attrs['aria-hidden'], 'true');
    const btn = el.all((n) => n.tag === 'button')[0];
    assert.equal(btn.textContent, 'Show');
    assert.equal(btn.attrs['aria-label'], 'Show 3 removed');
    assert.equal(btn.attrs['data-fk'], 'rm-show');
    assert.equal(btn.attrs.type, 'button');
  });

  test('(+) project page wording', () => {
    const r = rig();
    const el = r.mod.removedLineEl(2, { where: 'project', refresh: r.refresh });
    assert.equal(el.textContent.startsWith("2 removed from this project's list"), true);
    assert.equal(el.all((n) => n.tag === 'button')[0].attrs['aria-label'], 'Show 2 removed');
  });

  test('(+) Show opens the list (one request to /api/app/hidden)', async () => {
    const r = rig({ routes: { [LIST]: { status: 200, body: { groups: [], sessions: [], more: { groups: 0, sessions: 0 } } } } });
    r.mod.removedLineEl(3, { where: 'dash', refresh: r.refresh }).all((n) => n.tag === 'button')[0].click();
    await r.settle();
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].dlg, r.node('#dlg-removed'));
    assert.deepEqual(r.calls, [{ method: 'GET', url: '/api/app/hidden', json: undefined }]);
  });

  test('(+) browser tier: text only, "in the nika app", no button, no request', () => {
    const r = rig({ app: false });
    const el = r.mod.removedLineEl(3, { where: 'dash', refresh: r.refresh });
    assert.equal(el.textContent.startsWith('3 removed from the list in the nika app'), true);
    assert.equal(el.all((n) => n.tag === 'button').length, 0);
    assert.equal(el.all((n) => n.tag === 'svg' || n.tag === 'use').length, 0, 'no icon either: the eye-off icon belongs to the app tier line');
    assert.equal(r.calls.length, 0);
  });

  test('(\u2212) nothing removed, or a count that is not a count, is no line', () => {
    const r = rig();
    for (const n of [0, -1, NaN, Infinity, 1.5, '3', null, undefined, {}]) assert.equal(r.mod.removedLineEl(n, { where: 'dash', refresh: r.refresh }), null, String(n));
  });
});

// ---- the list ------------------------------------------------------------------------------------------------------------------------

describe('openRemovedList: the Show removed dialog', () => {
  const FULL = {
    groups: [{ key: KEY, label: 'demo', root: '/tmp/nika-test/demo', at: Date.now() - 3 * 86_400_000 }, { key: KEY2, label: null, root: null, at: Date.now() - 60_000 }],
    sessions: [{ id: ID, name: 'planner', project: 'demo', at: Date.now() - 3_600_000 }, { id: ID2, name: 'builder', project: null, at: Date.now() - 86_400_000 }],
    more: { groups: 0, sessions: 12 },
  };
  const listOf = (r) => r.node('#rm-body');
  const buttons = (r) => listOf(r).all((n) => n.tag === 'button');
  const names = (r) => listOf(r).all((n) => n.className.split(' ').includes('rm-name')).map((n) => n.textContent);
  // 0.5.4 SF (item 13b): after a successful Show again the dialog reads the list again, so the server's answers go in turn (the last one repeats)
  const once = (...answers) => { let n = 0; return async () => answers[Math.min(n++, answers.length - 1)]; };

  test('(+) opens #dlg-removed, shows Loading while it waits, then Folders before Sessions with their rows', async () => {
    const r = rig({ routes: { [LIST]: { status: 200, body: FULL } }, hold: [LIST] });
    const p = r.mod.openRemovedList({ refresh: r.refresh });
    await r.settle();
    assert.equal(r.opened.length, 1);
    assert.equal(listOf(r).attrs['aria-busy'], 'true');
    const loading = listOf(r).all((n) => n.attrs.role === 'status')[0];
    assert.equal(loading.textContent.trim(), `Loading${ELL}`);
    assert.ok(loading.all((n) => n.className === 'spin').length === 1);
    r.release(LIST);
    await p;
    assert.equal(listOf(r).attrs['aria-busy'], 'false');
    const heads = listOf(r).all((n) => n.tag === 'h3').map((n) => n.textContent);
    assert.deepEqual(heads, ['Folders', 'Sessions']);
    assert.deepEqual(names(r), ['demo', 'Folder with no recent sessions', 'planner', 'builder']);
  });

  test('(+) a folder row has its path and "Removed <time>"; a session row has its project; each has a Show again button named after it', async () => {
    const r = rig({ routes: { [LIST]: { status: 200, body: FULL } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    const text = listOf(r).textContent;
    assert.ok(text.includes('/tmp/nika-test/demo'));
    assert.ok(text.includes('Removed 3 d'));
    assert.ok(text.includes('Removed 1 min') && text.includes('Removed 1 h') && text.includes('Removed 1 d'));
    assert.ok(text.includes('demo'));
    const labels = buttons(r).map((b) => b.attrs['aria-label']);
    assert.deepEqual(labels, ['Show demo again', 'Show Folder with no recent sessions again', 'Show planner again', 'Show builder again']);
    assert.ok(buttons(r).every((b) => b.textContent === 'Show again' && b.attrs.type === 'button'));
    assert.ok(buttons(r).every((b) => b.attrs['data-fk']));
  });

  test('(+) more: "and 12 more (oldest)" after the sessions', async () => {
    const r = rig({ routes: { [LIST]: { status: 200, body: FULL } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.ok(listOf(r).textContent.includes('and 12 more (oldest)'));
    const none = rig({ routes: { [LIST]: { status: 200, body: { ...FULL, more: { groups: 0, sessions: 0 } } } } });
    await none.mod.openRemovedList({ refresh: none.refresh });
    assert.ok(!listOf(none).textContent.includes('more (oldest)'));
  });

  test('(+) nothing removed: the empty line, no section headings', async () => {
    const r = rig({ routes: { [LIST]: { status: 200, body: { groups: [], sessions: [], more: { groups: 0, sessions: 0 } } } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.ok(listOf(r).textContent.includes('Nothing is removed from the list.'));
    assert.equal(listOf(r).all((n) => n.tag === 'h3').length, 0);
    assert.equal(buttons(r).length, 0);
  });

  test('(\u2212) a failed load (network, error status, a body of the wrong shape) is an alert with Try again, which loads again', async () => {
    for (const bad of ['net', { status: 500, body: { error: 'internal' } }, { status: 200, body: { nope: 1 } }, { status: 200, body: null }]) {
      let answer = bad;
      const r = rig({ routes: { [LIST]: async () => { if (answer === 'net') throw new Error('x'); return answer; } } });
      await r.mod.openRemovedList({ refresh: r.refresh });
      const alert = listOf(r).all((n) => n.attrs.role === 'alert')[0];
      assert.ok(alert, JSON.stringify(bad));
      assert.ok(alert.textContent.includes("Couldn't load the removed items."));
      assert.equal(alert.attrs['data-kind'], 'danger');
      const retry = alert.all((n) => n.tag === 'button')[0] ?? buttons(r).find((b) => b.textContent === 'Try again');
      assert.equal(retry.textContent, 'Try again');
      answer = { status: 200, body: FULL };
      retry.click();
      await r.settle();
      assert.ok(listOf(r).textContent.includes('planner'), 'the retry shows the list');
      assert.equal(listOf(r).all((n) => n.attrs.role === 'alert').length, 0);
    }
  });

  test('(\u2212) the server message of a failed load never reaches the page', async () => {
    const r = rig({ routes: { [LIST]: { status: 500, body: { error: 'internal', message: 'boom secret-server-text' } } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.ok(!listOf(r).textContent.includes('boom'));
  });

  test('(+) Show again on a session: unhide, the button shows Showing, the row goes, "Back in the list.", refresh, focus on the next row\'s button', async () => {
    const after = { status: 200, body: { ...FULL, sessions: FULL.sessions.filter((x) => x.id !== ID) } }; // the server's answer once planner is shown again
    const r = rig({ routes: { [LIST]: once({ status: 200, body: FULL }, after), [unUrl()]: OK_BACK }, hold: [unUrl()] });
    await r.mod.openRemovedList({ refresh: r.refresh });
    const btn = buttons(r).find((b) => b.attrs['aria-label'] === 'Show planner again');
    const next = buttons(r).find((b) => b.attrs['aria-label'] === 'Show builder again');
    btn.click();
    await r.settle();
    assert.deepEqual(r.calls[1], { method: 'POST', url: `/api/app/session/${ID}/unhide`, json: {} });
    assert.equal(btn.busy, `Showing${ELL}`);
    assert.equal(btn.disabled, true);
    focus.el = null;
    r.release(unUrl());
    await r.settle();
    assert.equal(r.last().msg, 'Back in the list.');
    assert.equal(r.refreshed.n, 1);
    assert.ok(!names(r).includes('planner'));
    assert.equal(focus.el.attrs['aria-label'], next.attrs['aria-label'], 'the button of the row that followed');
  });

  test('(+) Show again on a folder uses the group route; the last row shown again leaves the empty line and focus on the heading', async () => {
    const one = { groups: [{ key: KEY, label: 'demo', root: '/tmp/nika-test/demo', at: Date.now() }], sessions: [], more: { groups: 0, sessions: 0 } };
    const r = rig({ routes: { [LIST]: once({ status: 200, body: one }, { status: 200, body: { groups: [], sessions: [], more: { groups: 0, sessions: 0 } } }), [gunUrl()]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    focus.el = null;
    buttons(r)[0].click();
    await r.settle();
    assert.deepEqual(r.calls[1], { method: 'POST', url: `/api/app/groups/${KEY}/unhide`, json: {} });
    assert.ok(listOf(r).textContent.includes('Nothing is removed from the list.'));
    assert.equal(focus.el, r.node('#rm-h'));
  });

  test('(\u2212) Show again that fails keeps the row, frees the button and says so as an error (never the server message)', async () => {
    for (const un of ['net', { status: 500, body: { error: 'write_failed', message: 'boom secret-server-text' } }, { status: 200, body: { hidden: true } }]) {
      const r = rig({ routes: { [LIST]: { status: 200, body: FULL }, [unUrl()]: un } });
      await r.mod.openRemovedList({ refresh: r.refresh });
      const btn = buttons(r).find((b) => b.attrs['aria-label'] === 'Show planner again');
      btn.click();
      await r.settle();
      assert.ok(names(r).includes('planner'));
      assert.equal(btn.disabled, false);
      assert.equal(btn.busy, null);
      assert.equal(r.last().msg, "Couldn't show it again. Nothing changed.");
      assert.equal(r.last().kind, 'error');
      assert.equal(r.refreshed.n, 0);
    }
  });

  test('(\u2212) a second click on a Show again that is in flight sends nothing', async () => {
    const r = rig({ routes: { [LIST]: { status: 200, body: FULL }, [unUrl()]: OK_BACK }, hold: [unUrl()] });
    await r.mod.openRemovedList({ refresh: r.refresh });
    const btn = buttons(r).find((b) => b.attrs['aria-label'] === 'Show planner again');
    btn.click();
    await r.settle();
    btn.click();
    await r.settle();
    assert.equal(r.calls.filter((c) => c.url.endsWith('/unhide')).length, 1);
    r.release(unUrl());
    await r.settle();
  });

  test('(\u2212) a hostile label, name, project and path are text; the title holds the full text; no element is made from them', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const long = 'L'.repeat(300);
    const body = {
      groups: [{ key: KEY, label: evil, root: `/tmp/${evil}`, at: 1 }, { key: KEY2, label: long, root: null, at: 1 }],
      sessions: [{ id: ID, name: evil, project: evil, at: 1 }, { id: ID2, name: long, project: long, at: 1 }],
      more: { groups: 0, sessions: 0 },
    };
    const r = rig({ routes: { [LIST]: { status: 200, body } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.equal(listOf(r).all((n) => n.tag === 'img').length, 0);
    assert.ok(listOf(r).textContent.includes(evil));
    const longName = listOf(r).all((n) => n.className.split(' ').includes('rm-name') && n.textContent === long)[0];
    assert.equal(longName.attrs.title, long);
    const pathEl = listOf(r).all((n) => n.className.split(' ').includes('rm-path'))[0];
    assert.equal(pathEl.attrs.title, `/tmp/${evil}`);
  });

  test('(\u2212) more than 100 rows from the server show at most 100 per list', async () => {
    const sessions = Array.from({ length: 140 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `s${i}`, project: null, at: 1 }));
    const r = rig({ routes: { [LIST]: { status: 200, body: { groups: [], sessions, more: { groups: 0, sessions: 0 } } } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.equal(names(r).length, 100);
    assert.ok(listOf(r).textContent.includes('and 40 more (oldest)'));
  });

  test('(\u2212) the browser tier opens nothing and asks nothing', async () => {
    const r = rig({ app: false, routes: {} });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.deepEqual([r.opened.length, r.calls.length], [0, 0]);
  });
});

// ---- the module's own source ------------------------------------------------------------------------------------------------------

describe('public/removed.js: source rules', () => {
  const src = code(REMOVED);

  test('(+) it imports only api.js, dom.js and ui.js (no cycle back into app.js), and exports the six functions of design 6.6', () => {
    const from = [...src.matchAll(/from '(\.\/[a-z-]+\.js)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(from, ['./api.js', './dom.js', './ui.js']);
    for (const name of ['removeRow', 'removeGroup', 'removedLineEl', 'openRemovedList', 'removedView', 'removeOutcome']) assert.match(src, new RegExp(`export (async )?function ${name}\\(`), name);
  });

  test('(\u2212) it makes no markup from a string, no inline style, no cookie or storage, no other origin, and no secret', () => {
    const sinks = [/inner\s*HTML/, /outer\s*HTML/, /insertAdjacent\s*HTML/, /document\s*\.\s*write/, /\beval\s*\(/, /new\s+Function\b/, /\.style\b/, /setAttribute\s*\(\s*['"`]style/, /css\s*Text/, /DOMParser/, /srcdoc/i, /createContextualFragment/];
    for (const re of sinks) assert.doesNotMatch(src, re, String(re));
    assert.doesNotMatch(src, /document\.cookie|localStorage|sessionStorage|XMLHttpRequest|\bfetch\s*\(|https?:\/\/|__NIKA_APP__|X-Nika-App/i);
  });

  test('(\u2212) it is ASCII (escapes for the ellipsis) and every request goes through appFetch', () => {
    assert.equal([...REMOVED].every((ch) => ch.codePointAt(0) < 128), true);
    assert.equal([...src.matchAll(/appFetch\(/g)].length, 2, 'the POST helper and the list load: the only two places that send a request');
    for (const m of src.matchAll(/\/api\/app\/[a-z/]*/g)) assert.match(m[0], /^\/api\/app\/(session|groups|hidden)/, m[0]);
  });
});

// ---- the row menu, the folder menu, the lines (app.js and project.js) ---------------------------------------------------------------

describe('the row menu: Remove from the list (app.js rowEl)', () => {
  const calls = [];
  const REFRESH = () => {};
  function rowOf(a, { isApp = true } = {}) {
    calls.length = 0;
    const sandbox = {
      h, icon, menuEl, hooks: {}, SHAPE: { claudeUrl: /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{1,64}$/ }, sessionHref, isApp, parentOf: () => null, ctxEl: () => new El('span'), labelEl: () => null, agentLabelView: () => null,
      roleTag: () => null, roleTagEl: () => null, state: { modes: { map: {} } }, document: { getSelection: () => ({ isCollapsed: true }) }, location: {},
      sOf: (x) => (x.live ? 'idle' : 'ended'), rowMode: () => null, canEndRow: () => false, endedText: () => 'Ended', reasonOf: () => '', endedScope: (s) => `${s}-e`,
      statusEl: () => new El('span'), modeEl: () => new El('span'), modelEl: () => new El('span'), timeEl: () => new El('span'),
      copyText: () => {}, showReport: () => {}, focusPane: () => {}, endSession: () => {}, refresh: REFRESH, removeRow: (...args) => calls.push(args),
    };
    const rowEl = vm.runInNewContext(`${fn(APP, 'function rowEl(')}; rowEl`, sandbox);
    return rowEl(a, grp(), { scope: 'g' });
  }
  const item = (li) => li.all((n) => n.tag === 'button' && n.textContent === 'Remove from the list')[0];
  const agent = (o = {}) => ({ id: ID, name: 'planner', live: false, pane: null, resumeCmd: 'claude --resume x', lastActivity: 1, subagents: [], ...o });

  test('(+) an ended row, and a stuck row (live, no pane), have it as the last item, starting a group; it calls removeRow(a, g, { refresh })', () => {
    for (const a of [agent(), agent({ live: true, pane: null })]) {
      const li = rowOf(a);
      const it = item(li);
      assert.ok(it, JSON.stringify({ live: a.live }));
      assert.equal(it.attrs['data-fk'], 'rm:g:' + ID);
      const lis = li.all((n) => n.tag === 'li' && n.parent?.tag === 'ul' && n.parent.className.split(' ').includes('menu'));
      assert.equal(lis[lis.length - 1].className, 'grp', 'a rule above it');
      assert.ok(lis[lis.length - 1].all((n) => n === it).length === 1, 'and it is the last item');
      it.click();
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0].id, ID);
      assert.equal(calls[0][1].key, KEY);
      assert.equal(calls[0][2].refresh, REFRESH);
    }
  });

  test('(\u2212) a row in a tmux pane has no such item (End session is its way out)', () => {
    assert.equal(item(rowOf(agent({ live: true, pane: { id: '%3' } }))), undefined);
  });

  test('(\u2212) the browser tier has no such item on any row', () => {
    for (const a of [agent(), agent({ live: true, pane: null }), agent({ live: true, pane: { id: '%3' } })]) assert.equal(item(rowOf(a, { isApp: false })), undefined);
  });

  test('(+) the gate in the source is isApp and not (live and pane); the import is static from ./removed.js', () => {
    assert.match(fn(APP, 'function rowEl('), /if \(isApp && !\(a\.live && a\.pane\)\) items\.push\(\{ text: 'Remove from the list', group: true, fk: fk\('rm'\), run: \(\) => removeRow\(a, g, \{ refresh \}\) \}\);/);
    assert.match(APP, /import \{[^}]*\bremoveRow\b[^}]*\bremovedLineEl\b[^}]*\} from '\.\/removed\.js';|import \{[^}]*\bremovedLineEl\b[^}]*\bremoveRow\b[^}]*\} from '\.\/removed\.js';/);
  });
});

describe('the folder menu: Remove from the list on a detected folder (project.js groupActions)', () => {
  const calls = [];
  function actionsOf(g) {
    calls.length = 0;
    const sandbox = { h, icon, menuEl, addProject: () => {}, removeGroup: (...args) => calls.push(args), refresh: 'REFRESH', isApp: true };
    return vm.runInNewContext(`${fn(PROJECT, 'function groupActions(')}; groupActions`, sandbox)(g, {});
  }

  test('(+) a detected folder with a working folder keeps Add project first and gets a \u22ef menu with one item', () => {
    const acts = actionsOf(grp());
    assert.equal(acts.length, 2);
    assert.equal(acts[0].attrs['data-fk'], `add:${KEY}`);
    const wrap = acts[1];
    assert.match(wrap.className, /menu-wrap/);
    const trigger = wrap.all((n) => n.tag === 'button' && n.attrs['data-menu-btn'] !== undefined)[0];
    assert.equal(trigger.attrs['aria-label'], 'More actions for demo');
    const items = wrap.all((n) => n.tag === 'li');
    assert.equal(items.length, 1);
    const it = items[0].all((n) => n.tag === 'button')[0];
    assert.equal(it.textContent, 'Remove from the list');
    it.click();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].key, KEY);
    assert.equal(calls[0][1].refresh, 'REFRESH');
  });

  test('(\u2212) a folder with no working folder (the "(unknown)" one) has only Add project', () => {
    assert.equal(actionsOf(grp({ root: null })).length, 1);
    assert.equal(actionsOf(grp({ root: '' })).length, 1);
  });

  test('(\u2212) a nika project does not get it: the item is built in the detected-folder branch only (a project has its own Remove from nika)', () => {
    const body = fn(PROJECT, 'function groupActions(');
    const cut = body.indexOf('const st = orchState(');
    assert.ok(cut > 0);
    assert.ok(body.slice(0, cut).includes('removeGroup('));
    assert.ok(!body.slice(cut).includes('removeGroup('));
  });

  test('(+) project.js imports removeGroup and removedLineEl statically in ONE import from removed.js, and refresh from app.js', () => {
    assert.match(PROJECT, /import \{ removeGroup, removedLineEl \} from '\.\/removed\.js';/);
    assert.equal((PROJECT.match(/from '\.\/removed\.js'/g) ?? []).length, 1, 'one import line for the module');
    assert.match(PROJECT, /import \{[^}]*\brefresh\b[^}]*\} from '\.\/app\.js';/);
  });
});

describe('the folder header on the dashboard (app.js groupEl; 0.5.4 SF, RM review nit 10)', () => {
  function headerOf({ isApp, g }) {
    const asked = [];
    const sandbox = {
      h, isApp, hooks: { groupActions: (...args) => { asked.push(args); return [h('button', { type: 'button', text: 'Remove from the list' })]; } },
      countsLine: () => [], agentNodes: () => [], rulesEl: () => h('span', { text: 'rules' }),
    };
    const groupEl = vm.runInNewContext(`${fn(APP, 'function groupEl(')}; groupEl`, sandbox);
    return { section: groupEl(g, ''), asked };
  }
  const group = (o = {}) => ({ key: KEY, label: 'demo', root: '/x/demo', project: null, counts: {}, agents: [{ id: ID }], ...o });

  test('(\u2212) the browser tier: the group header builds no folder actions and has no grp-actions element, for a detected folder and for a project', () => {
    for (const g of [group(), group({ project: { key: KEY2, rules: null } })]) {
      const { section, asked } = headerOf({ isApp: false, g });
      assert.deepEqual(asked, [], 'groupActions is never called');
      assert.equal(section.all((n) => /\bgrp-actions\b/.test(n.className ?? '')).length, 0);
      assert.equal(section.all((n) => n.textContent === 'Remove from the list').length, 0);
    }
  });

  test('(+) the app tier: the same header asks groupActions once and carries its element (the control for the browser-tier test above)', () => {
    const { section, asked } = headerOf({ isApp: true, g: group() });
    assert.equal(asked.length, 1);
    assert.equal(section.all((n) => /\bgrp-actions\b/.test(n.className ?? '')).length, 1);
  });

  test('(\u2212) an app-tier group with no agents asks nothing in the header either (the body\'s call to action is the one place)', () => {
    assert.deepEqual(headerOf({ isApp: true, g: group({ agents: [] }) }).asked, []);
  });
});

describe('the lines and the group model (app.js, project.js)', () => {
  test('(+) buildGroups carries each group\'s hidden count (0 for a project with no group or an older server)', () => {
    const state = {
      data: { groups: [{ key: KEY, label: 'demo', root: '/x', lastActivity: 1, agents: [], hidden: 3 }, { key: KEY2, label: 'old', root: '/y', lastActivity: 1, agents: [] }] },
      projects: [{ key: 'cdef3456cdef3456', dir: '/z', name: 'proj', rules: null }],
    };
    const build = vm.runInNewContext(`${fn(APP.replace('export function buildGroups', 'function buildGroups'), 'function buildGroups(')}; buildGroups`, { isApp: true, state, countsOf: () => ({ attn: 0, live: 0 }), Number, Set, Map });
    const out = plain(build());
    assert.equal(out.find((g) => g.key === KEY).hidden, 3);
    assert.equal(out.find((g) => g.key === KEY2).hidden, 0);
    assert.equal(out.find((g) => g.key === 'cdef3456cdef3456').hidden, 0);
  });

  test('(+) the dashboard draws the line after the last group, in both tiers, also when every folder is removed; the redraw signature holds the snapshot count', () => {
    const body = fn(APP, 'function dashboardNodes(');
    assert.match(body, /const removed = removedLineEl\(state\.data\?\.hidden, \{ where: 'dash', refresh \}\);/);
    assert.ok(body.indexOf('const removed =') < body.indexOf('if (!groups.length)'));
    const empty = body.slice(body.indexOf('if (!groups.length)'), body.indexOf('const nodes = ['));
    assert.equal((empty.match(/\bremoved\b/g) ?? []).length, 2, 'both empty states');
    assert.match(body.slice(body.indexOf('nodes.push(groupEl(g, q));')), /nodes\.push\(removed\);\s*return nodes;/);
    assert.match(fn(APP, 'function renderDashboard('), /const sig = JSON\.stringify\(\[state\.data\.groups, state\.data\.hidden,/);
  });

  test('(+) the project page draws its group\'s line under the agents, and redraws when the count changes', () => {
    const body = fn(PROJECT, 'function renderProject(');
    assert.match(body, /removedLineEl\(g\.hidden, \{ where: 'project', refresh \}\)/);
    assert.match(body, /const sig = JSON\.stringify\(\[p, g\?\.agents, g\?\.hidden,/);
    assert.ok(body.indexOf("agentNodes(g, '', `pv:${key}`") < body.indexOf('removedLineEl('), 'under the agents');
    assert.match(PROJECT, /import \{ removedLineEl \} from '\.\/removed\.js';|import \{[^}]*\bremovedLineEl\b[^}]*\} from '\.\/removed\.js';/);
  });
});

// ---- markup, sprite, colours, styles, served files ---------------------------------------------------------------------------------

describe('index.html: the dialog and the icon', () => {
  const dlg = /<dialog id="dlg-removed"[\s\S]*?<\/dialog>/.exec(HTML)?.[0];

  test('(+) #dlg-removed: app only, named by its heading and described by its sentence, with the body, a close X and a Close button', () => {
    assert.ok(dlg, 'the dialog exists');
    assert.match(dlg, /^<dialog id="dlg-removed" class="dlg-removed" aria-labelledby="rm-h" aria-describedby="rm-d" data-app-only>/);
    assert.match(dlg, /<h2 id="rm-h" tabindex="-1">Removed from the list<\/h2>/);
    assert.match(dlg, /<p id="rm-d">Removed items are only hidden from nika's lists\. Nothing was deleted, and sessions that still run keep running\.<\/p>/);
    assert.match(dlg, /<div class="dlg-body" id="rm-body"[^>]*><\/div>/);
    assert.match(dlg, /<button type="button" class="btn icon ghost" data-close id="rm-x" data-fk="rm-x" aria-label="Close" title="Close">/);
    assert.match(dlg, /<button type="button" class="btn lg" data-close id="rm-close" data-fk="rm-close">Close<\/button>/);
    assert.equal(HTML.split('id="dlg-removed"').length - 1, 1);
    for (const id of ['rm-h', 'rm-d', 'rm-body', 'rm-x', 'rm-close']) assert.equal(HTML.split(`id="${id}"`).length - 1, 1, id);
  });

  test('(\u2212) no inline script, style or event attribute in it', () => {
    assert.doesNotMatch(dlg, /\sstyle\s*=|\son[a-z]+\s*=|<script|javascript:/i);
  });

  test('(+) the sprite has i-eye-off in the 16 x 16 stroke style (an eye and the diagonal of i-compact-off), different from every other symbol', () => {
    const symbols = [...HTML.matchAll(/<symbol id="i-([a-z0-9-]+)" viewBox="0 0 16 16">([\s\S]*?)<\/symbol>/g)].map((m) => [m[1], m[2]]);
    const mine = symbols.filter(([n]) => n === 'eye-off');
    assert.equal(mine.length, 1);
    assert.match(mine[0][1], /M2\.2 2\.2l11\.6 11\.6/);
    assert.match(mine[0][1], /<path\b/);
    assert.doesNotMatch(mine[0][1], /\b(fill|stroke|style)=/);
    assert.equal(symbols.filter(([, d]) => d === mine[0][1]).length, 1, 'a drawing of its own');
  });
});

describe('tokens.css: the removed state has its own colours (--rm, --rm-soft, --rm-line)', () => {
  const blockAt = (opener) => {
    const at = TOKENS.indexOf(opener);
    assert.ok(at >= 0, `${opener} exists`);
    const open = TOKENS.indexOf('{', at);
    return TOKENS.slice(open + 1, TOKENS.indexOf('}', open));
  };
  const vars = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const BLOCKS = { light: blockAt(':root {'), dark: blockAt(':root:not([data-theme="light"]) {'), darkPinned: blockAt(':root[data-theme="dark"] {') };
  const THEME = Object.fromEntries(Object.entries(BLOCKS).map(([k, b]) => [k, k === 'light' ? vars(b) : { ...vars(BLOCKS.light), ...vars(b) }]));
  const lin = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = (hex) => { const c = lin(hex); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const oklab = (hex) => {
    const [r, g, b] = lin(hex);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const dE = (a, b) => { const [p, q] = [oklab(a), oklab(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  const MIN_DE = 0.05;
  const NAMES = ['--rm', '--rm-soft', '--rm-line'];

  test('(+) the three tokens are the designed hex values in the light block and in both dark blocks, and tuned per theme', () => {
    assert.deepEqual(NAMES.map((n) => THEME.light[n]), ['#6e4630', '#f5ebe4', '#a07258']);
    assert.deepEqual(NAMES.map((n) => THEME.dark[n]), ['#c9b08f', '#2f2820', '#9c8264']);
    assert.deepEqual(NAMES.map((n) => THEME.darkPinned[n]), ['#c9b08f', '#2f2820', '#9c8264']);
  });

  for (const name of Object.keys(THEME)) {
    test(`(+) contrast (${name}): the text is 4.5:1 on its soft fill and on the surfaces it sits on; the edge is 3:1`, () => {
      const v = THEME[name];
      for (const ground of [v['--rm-soft'], v['--surface'], v['--bg'], v['--surface-2'], v['--surface-3'], v['--attn-row']]) {
        assert.ok(ratio(v['--rm'], ground) >= 4.5, `text on ${ground}: ${ratio(v['--rm'], ground).toFixed(2)}`);
      }
      for (const ground of [v['--bg'], v['--surface'], v['--surface-2']]) {
        assert.ok(ratio(v['--rm-line'], ground) >= 3, `edge on ${ground}: ${ratio(v['--rm-line'], ground).toFixed(2)}`);
      }
    });

    test(`(+) contrast (${name}): the dialog row pairs: --text-muted and --text on --rm-soft at 4.5:1, --rm-line on --rm-soft at 3:1`, () => {
      const v = THEME[name];
      for (const fg of ['--text-muted', '--text']) assert.ok(ratio(v[fg], v['--rm-soft']) >= 4.5, `${fg} on --rm-soft: ${ratio(v[fg], v['--rm-soft']).toFixed(2)}`);
      assert.ok(ratio(v['--rm-line'], v['--rm-soft']) >= 3, `--rm-line on --rm-soft: ${ratio(v['--rm-line'], v['--rm-soft']).toFixed(2)}`);
    });

    test(`(+) distinct (${name}): at least ${MIN_DE} OKLab from accent, busy, idle, attention, danger, ended, the muted grey, every mode and every Fit colour`, () => {
      const v = THEME[name];
      const peers = ['--accent', '--busy', '--idle', '--attn', '--danger', '--ended', '--text-muted', ...Object.keys(v).filter((k) => /^--(m|fit)-[a-z]+$/.test(k))];
      assert.ok(peers.length >= 7 + 8 + 5, `the mode and Fit colours were found: ${peers.length}`);
      for (const p of peers) assert.ok(dE(v['--rm'], v[p]) >= MIN_DE, `${p} ${v[p]}: ${dE(v['--rm'], v[p]).toFixed(3)}`);
    });
  }

  test('(\u2212) tokens.css stays ASCII with no color-mix() or :has()', () => {
    assert.doesNotMatch(strip(TOKENS), /color-mix\(|:has\(/);
    assert.equal([...TOKENS].every((ch) => ch.codePointAt(0) < 128), true);
  });
});

describe('app.css: the 0.5.4 RM block', () => {
  const css = strip(APP_CSS);
  const rule = (sel) => new RegExp(`(?:^|[\\s}])${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  test('(+) one marked block; the line reads the tokens for its icon, and the dialog has its width', () => {
    assert.equal(APP_CSS.split('/* 0.5.4 RM').length - 1, 1);
    assert.match(rule('.rm-line .ic'), /color:\s*var\(--rm\)/);
    assert.match(rule('dialog.dlg-removed'), /width:\s*min\(560px,\s*calc\(100vw - 32px\)\)/);
    assert.match(rule('.rm-path'), /overflow-wrap:\s*anywhere/);
    assert.match(rule('.rm-name'), /text-overflow:\s*ellipsis/);
  });

  test('(\u2212) the new tokens are used by this block only, and the block has no colour literal', () => {
    const users = ['app.css', 'session.css', 'tokens.css'].flatMap((f) => (read(f).match(/var\(--rm[a-z-]*\)/g) ?? []).map((u) => `${f} ${u}`));
    assert.ok(users.length >= 1);
    assert.ok(users.every((u) => u.startsWith('app.css')), users.join(', '));
    const block = APP_CSS.slice(APP_CSS.indexOf('/* 0.5.4 RM'));
    const end = block.indexOf('\n/* ', 10);
    const mine = strip(end > 0 ? block.slice(0, end) : block);
    assert.doesNotMatch(mine, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe('served files', () => {
  test('(+) server.js serves /removed.js as JavaScript from public/removed.js', () => {
    assert.match(read('../src/server.js'), /\['\/removed\.js', \['removed\.js', 'text\/javascript; charset=utf-8'\]\],/);
  });
});

// ---- 0.5.4 SF, item 13: the time copy of the dialog, and a dialog that does not go stale ----------------------------------------------

describe('0.5.4 SF item 13a: "Removed 3 min ago" in the dialog; the activity column stays "3 min"', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const metas = (r) => r.node('#rm-body').all((n) => n.className === 'rm-meta').map((n) => n.textContent);
  const when = (now, list) => ({ groups: [], sessions: list.map((ms, i) => ({ id: `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`, name: `s${i}`, project: null, at: now - ms })), more: { groups: 0, sessions: 0 } });
  // the ticker of ui.js, run from its own source against the time elements of a drawn dialog
  const ticker = (times) => vm.runInNewContext(`${fn(code(read('ui.js')), 'export function tickTimes').replace(/^export /, '')}\ntickTimes`, { $$: () => times, ago, agoWords, Number });
  const timesOf = (r) => r.node('#rm-body').all((n) => n.tag === 'time');

  test('(+) each unit reads in words, and "just now" under a minute', async () => {
    const now = Date.now();
    const r = rig({ routes: { [LIST]: { status: 200, body: when(now, [20_000, 3 * MIN + 5_000, 2 * HOUR + MIN, 4 * DAY + HOUR]) } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.deepEqual(metas(r), ['Removed just now', 'Removed 3 min ago', 'Removed 2 h ago', 'Removed 4 d ago']);
  });

  test('(+) agoWords at every boundary (a fixed now): 59.999 s is just now, 60 s is 1 min ago, 59 min, 1 h, 23 h, 1 d; a time in the future is just now', () => {
    const t = 1_700_000_000_000;
    const at = (ms) => agoWords(t - ms, t);
    assert.deepEqual([0, 59_999, MIN, 59 * MIN + 59_999, HOUR, DAY - 1, DAY, 40 * DAY].map(at), ['just now', 'just now', '1 min ago', '59 min ago', '1 h ago', '23 h ago', '1 d ago', '40 d ago']);
    assert.equal(agoWords(t + 5 * MIN, t), 'just now');
  });

  test('(+) a time that is not a number reads as the dash, with no "ago"', () => {
    for (const v of [NaN, Infinity, undefined, null, 'x']) assert.equal(agoWords(v, 1), '\u2013');
    const el = timeWordsEl(NaN);
    assert.equal(el.textContent, '\u2013');
    assert.equal(el.attrs['data-ts'], undefined);
  });

  test('(+) after one refresh tick the rows still read in words (the ticker rewrites every time[data-ts])', async () => {
    const now = Date.now();
    const r = rig({ routes: { [LIST]: { status: 200, body: when(now, [20_000, 3 * MIN + 5_000, 2 * HOUR + MIN, 4 * DAY + HOUR]) } } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    const times = timesOf(r);
    assert.equal(times.length, 4);
    for (const t of times) t.textContent = 'stale';
    ticker(times)();
    assert.deepEqual(metas(r), ['Removed just now', 'Removed 3 min ago', 'Removed 2 h ago', 'Removed 4 d ago']);
  });

  test('(\u2212) the activity column and every other timeEl caller still read "3 min", "now", "2 h", "4 d" (no "ago"), before and after a tick', () => {
    const now = Date.now();
    const els = [20_000, 3 * MIN + 5_000, 2 * HOUR + MIN, 4 * DAY + HOUR].map((ms) => timeEl(now - ms));
    assert.deepEqual(els.map((e) => e.textContent), ['now', '3 min', '2 h', '4 d']);
    assert.ok(els.every((e) => e.attrs['data-words'] === undefined));
    for (const e of els) e.textContent = 'stale';
    ticker(els)();
    assert.deepEqual(els.map((e) => e.textContent), ['now', '3 min', '2 h', '4 d']);
    assert.equal(ago(1_700_000_000_000 - 3 * MIN, 1_700_000_000_000), '3 min', 'ago() itself is unchanged');
  });

  test('(\u2212) app.js still calls timeEl with one argument for the activity column', () => {
    assert.match(APP, /timeEl\(a\.lastActivity\)\)/);
    assert.doesNotMatch(APP, /timeWordsEl/);
  });
});

describe('0.5.4 SF item 13b: the open dialog reads the list again after every successful action', () => {
  const now = Date.now();
  const S1 = { id: ID, name: 'planner', project: 'demo', at: now - 3_600_000 };
  const S2 = { id: ID2, name: 'builder', project: null, at: now - 7_200_000 };
  const S3 = { id: ID3, name: 'tester', project: null, at: now - 9_000_000 };
  const G1 = { key: KEY, label: 'demo', root: '/tmp/nika-test/demo', at: now - 60_000 };
  const G2 = { key: KEY2, label: 'other', root: '/tmp/nika-test/other', at: now - 120_000 };
  const list = (groups, sessions) => ({ status: 200, body: { groups, sessions, more: { groups: 0, sessions: 0 } } });
  /** The server's answers in turn (the last one repeats): the first for the open, one more for every re-read. */
  const seq = (...answers) => { let n = 0; return async () => answers[Math.min(n++, answers.length - 1)]; };
  const body = (r) => r.node('#rm-body');
  const names = (r) => body(r).all((n) => n.className.split(' ').includes('rm-name')).map((n) => n.textContent);
  const btn = (r, label) => body(r).all((n) => n.tag === 'button').find((b) => b.attrs['aria-label'] === label);
  const gets = (r) => r.calls.filter((c) => c.method === 'GET').length;

  test('(+) Show again on a session: the entry the server pruned meanwhile is gone after it, and the answer after the action is what is drawn', async () => {
    const r = rig({ routes: { [LIST]: seq(list([G1], [S1, S2, S3]), list([G1], [S3])), [unUrl()]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    assert.deepEqual(names(r), ['demo', 'planner', 'builder', 'tester']);
    btn(r, 'Show planner again').click();
    await r.settle();
    assert.deepEqual(names(r), ['demo', 'tester'], 'builder was pruned by the server: it is not listed any more');
    assert.deepEqual(r.calls.map((c) => `${c.method} ${c.url}`), [LIST, unUrl(), LIST]);
    assert.equal(r.last().msg, 'Back in the list.');
    assert.equal(r.refreshed.n, 1);
  });

  test('(+) Show again on a folder re-reads too, and a folder the server pruned goes with it', async () => {
    const r = rig({ routes: { [LIST]: seq(list([G1, G2], [S1]), list([], [S1])), [gunUrl()]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    btn(r, 'Show demo again').click();
    await r.settle();
    assert.deepEqual(names(r), ['planner']);
    assert.equal(gets(r), 2);
  });

  test('(+) focus goes to the next row that is still listed, by identity: a row the server pruned before it does not shift the focus', async () => {
    const r = rig({ routes: { [LIST]: seq(list([], [S1, S2, S3]), list([], [S3])), [unUrl(ID2)]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    focus.el = null;
    btn(r, 'Show builder again').click();
    await r.settle();
    assert.equal(focus.el.attrs['aria-label'], 'Show tester again', 'planner was pruned before it, so tester moved up to the first place: the row that followed is still tester');
    const last = rig({ routes: { [LIST]: seq(list([], [S1, S2]), list([], [S2])), [unUrl(ID2)]: OK_BACK } });
    await last.mod.openRemovedList({ refresh: last.refresh });
    focus.el = null;
    btn(last, 'Show builder again').click();
    await last.settle();
    assert.equal(focus.el, last.node('#rm-h'), 'nothing follows: the heading');
  });

  test('(+) an Undo while the dialog is open re-reads the list: the entry that is back in the list leaves it', async () => {
    const r = rig({ routes: { [LIST]: seq(list([], [S1, S2]), list([], [S2])), [rmUrl(ID3)]: OK, [unUrl(ID3)]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh }); // the dialog is open; an Undo toast of an earlier Remove can still be on screen
    await r.mod.removeRow(row({ id: ID3 }), grp(), { refresh: r.refresh });
    await r.last().action.run();
    assert.deepEqual(names(r), ['builder'], 'the re-read answer is drawn');
    assert.equal(gets(r), 2);
    assert.equal(r.last().msg, 'Back in the list.');
  });

  test('(\u2212) an Undo with the dialog closed reads nothing', async () => {
    const r = rig({ routes: { [rmUrl()]: OK, [unUrl()]: OK_BACK } });
    await r.mod.removeRow(row(), grp(), { refresh: r.refresh });
    await r.last().action.run();
    assert.equal(gets(r), 0);
  });

  test('(\u2212) a failed Show again keeps the list as it is, shows the error as today and reads nothing again', async () => {
    for (const un of ['net', { status: 500, body: { error: 'write_failed' } }, { status: 404, body: { error: 'not_found' } }, { status: 200, body: { hidden: true } }]) {
      const r = rig({ routes: { [LIST]: seq(list([G1], [S1, S2])), [unUrl()]: un } });
      await r.mod.openRemovedList({ refresh: r.refresh });
      btn(r, 'Show planner again').click();
      await r.settle();
      assert.deepEqual(names(r), ['demo', 'planner', 'builder'], JSON.stringify(un));
      assert.equal(gets(r), 1, JSON.stringify(un));
      assert.equal(r.last().msg, "Couldn't show it again. Nothing changed.");
      assert.equal(r.last().kind, 'error');
    }
  });

  test('(\u2212) a failed Undo reads nothing again', async () => {
    const r = rig({ routes: { [LIST]: seq(list([], [S1])), [rmUrl(ID3)]: OK, [unUrl(ID3)]: 'net' } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    await r.mod.removeRow(row({ id: ID3 }), grp(), { refresh: r.refresh });
    await r.last().action.run();
    assert.equal(gets(r), 1);
    assert.equal(r.last().msg, "Couldn't undo. Use Show removed to bring it back.");
  });

  test('(\u2212) a re-read that fails (network, an error status, a body of the wrong shape) leaves the row the action brought back out of the list, and says nothing more', async () => {
    for (const bad of ['net', { status: 500, body: { error: 'internal' } }, { status: 200, body: { nope: 1 } }, { status: 200, body: null }]) {
      let n = 0;
      const answer = async () => { if (n++ === 0) return list([G1], [S1, S2]); if (bad === 'net') throw new Error('x'); return bad; };
      const r = rig({ routes: { [LIST]: answer, [unUrl()]: OK_BACK } });
      await r.mod.openRemovedList({ refresh: r.refresh });
      btn(r, 'Show planner again').click();
      await r.settle();
      assert.deepEqual(names(r), ['demo', 'builder'], JSON.stringify(bad));
      assert.equal(r.last().msg, 'Back in the list.', JSON.stringify(bad));
      assert.notEqual(r.last().kind, 'error');
      assert.equal(body(r).all((x) => x.attrs.role === 'alert').length, 0, 'no error state: the list is still there');
    }
  });

  test('(\u2212) two quick actions: an older read that comes in after a newer one is dropped, so an entry that is back in the list does not reappear', async () => {
    let n = 0;
    let gate;
    const held = new Promise((res) => { gate = res; });
    const answer = async () => {
      n += 1;
      if (n === 1) return list([], [S1, S2]);
      if (n === 2) { await held; return list([], [S2]); } // the read after the first action: builder is still hidden then
      return list([], []);                                 // the read after the second action
    };
    const r = rig({ routes: { [LIST]: answer, [unUrl()]: OK_BACK, [unUrl(ID2)]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    btn(r, 'Show planner again').click();
    await r.settle();
    btn(r, 'Show builder again').click();
    await r.settle();
    assert.deepEqual(names(r), [], 'the newer read is drawn');
    gate();
    await r.settle();
    assert.deepEqual(names(r), [], 'the older read came in late and is dropped');
    assert.ok(body(r).textContent.includes('Nothing is removed from the list.'));
  });

  test('(\u2212) an Undo\'s read that comes in after the read of a later Show again is dropped too', async () => {
    let n = 0;
    let gate;
    const held = new Promise((res) => { gate = res; });
    const answer = async () => {
      n += 1;
      if (n === 1) return list([], [S1, S2]);
      if (n === 2) { await held; return list([], [S1, S2]); } // the read of the Undo: planner is still hidden when the server answers it
      return list([], [S2]);                                    // the read after Show again on planner
    };
    const r = rig({ routes: { [LIST]: answer, [rmUrl(ID3)]: OK, [unUrl(ID3)]: OK_BACK, [unUrl()]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    await r.mod.removeRow(row({ id: ID3 }), grp(), { refresh: r.refresh });
    const undo = r.last().action.run();
    await r.settle();
    btn(r, 'Show planner again').click();
    await r.settle();
    assert.deepEqual(names(r), ['builder']);
    gate();
    await undo;
    await r.settle();
    assert.deepEqual(names(r), ['builder'], 'the older answer is dropped');
  });

  test('(\u2212) a slow read of an earlier open does not overwrite the list of a newer one', async () => {
    let n = 0;
    let gate;
    const held = new Promise((res) => { gate = res; });
    const answer = async () => { n += 1; if (n === 1) { await held; return list([], [S1, S2]); } return list([], [S2]); };
    const r = rig({ routes: { [LIST]: answer } });
    const first = r.mod.openRemovedList({ refresh: r.refresh });
    await r.settle();
    await r.mod.openRemovedList({ refresh: r.refresh }); // opened again while the first read is still out
    assert.deepEqual(names(r), ['builder']);
    gate();
    await first;
    await r.settle();
    assert.deepEqual(names(r), ['builder'], 'the older answer is dropped');
    assert.equal(body(r).attrs['aria-busy'], 'false');
  });

  test('(+) the re-read is the same markup: the rows are text, with the new time copy, and every Show again button works on the new rows', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = rig({ routes: { [LIST]: seq(list([], [S1, S2]), list([], [{ ...S2, name: evil, at: now - 30_000 }]), list([], [])), [unUrl()]: OK_BACK, [unUrl(ID2)]: OK_BACK } });
    await r.mod.openRemovedList({ refresh: r.refresh });
    btn(r, 'Show planner again').click();
    await r.settle();
    assert.equal(body(r).all((n) => n.tag === 'img').length, 0);
    assert.deepEqual(names(r), [evil]);
    assert.ok(body(r).textContent.includes('Removed just now'));
    btn(r, `Show ${evil} again`).click();
    await r.settle();
    assert.ok(body(r).textContent.includes('Nothing is removed from the list.'));
  });
});
