// Task 12: the dashboard's mode tags and End item (public/app.js rowEl, public/modes.js helpers), the /api/app/modes poll
// (public/project.js) and the model pickers of Settings and the spawn sheet (public/settings.js, project.js, models-ui.js).
// The browser itself is exercised by hand; these checks run the pure parts in Node, the poll in a vm against stubs, and pin
// the page code that cannot be imported (app.js starts the page when loaded). Design: docs/design/spec.md 9.8 and 9.9.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { MODE_META, parseModes, modesAfter, rowMode, canEndRow } from '../public/modes.js';
import { CUSTOM, ROLE_LABEL, fillModelSelect, effectiveRoleModels } from '../public/models-ui.js';
import { h } from '../public/dom.js';
import { statusOf, spawnLimits } from '../public/dash-model.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
/** Source of the top-level function that starts with `head`, up to its closing brace at column 0. */
const fn = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} exists`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
};

const APP = code(read('app.js'));
const PROJECT = code(read('project.js'));
const SETTINGS = code(read('settings.js'));
const HTML = read('index.html');
const APP_CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- modes.js: the dashboard's pure parts ---------------------------------------------------------------------------

describe('parseModes', () => {
  test('(+) keeps one { mode, confirmed } per pane id; a word that is not a mode becomes unknown, a non-boolean confirmed false', () => {
    const map = parseModes({ modes: {
      '%3': { mode: 'plan', confirmed: true },
      '%14': { mode: 'acceptEdits', confirmed: false },
      '%15': { mode: 'turbo', confirmed: 'yes' },
    } });
    assert.deepEqual(map, {
      '%3': { mode: 'plan', confirmed: true },
      '%14': { mode: 'acceptEdits', confirmed: false },
      '%15': { mode: 'unknown', confirmed: false },
    });
  });

  test('(+) an empty answer is a valid map (no eligible pane), not a failure', () => {
    assert.deepEqual(parseModes({ modes: {} }), {});
  });

  test('(−) a body that is not { modes: {...} } is a failed poll (null)', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { modes: null }, { modes: [] }, { modes: 'plan' }]) assert.equal(parseModes(bad), null, JSON.stringify(bad));
  });

  test('(−) keys that are not pane ids and entries that are not objects are dropped; other fields are never copied', () => {
    const body = JSON.parse('{"modes":{"__proto__":{"mode":"plan","confirmed":true},"3":{"mode":"plan","confirmed":true},"%":{"mode":"plan"},"%1234567":{"mode":"plan"},"%4":"plan","%5":null,"%6":{"mode":"auto","confirmed":true,"path":"/x"}}}');
    const map = parseModes(body);
    assert.deepEqual(Object.keys(map), ['%6']);
    assert.deepEqual(map['%6'], { mode: 'auto', confirmed: true });
    assert.equal(Object.getPrototypeOf(map), Object.prototype, 'no prototype pollution through a hostile key');
  });
});

describe('modesAfter', () => {
  const A = { '%3': { mode: 'plan', confirmed: true } };
  const B = { '%3': { mode: 'auto', confirmed: true } };

  test('(+) an answer replaces the map and resets the miss count', () => {
    assert.deepEqual(modesAfter({ map: A, misses: 1 }, B), { map: B, misses: 0 });
    assert.deepEqual(modesAfter({ map: A, misses: 0 }, {}), { map: {}, misses: 0 }, 'an empty map is an answer');
  });

  test('(+) one failed poll keeps the last map; the second clears it; a later answer comes back', () => {
    const one = modesAfter({ map: A, misses: 0 }, null);
    assert.deepEqual(one, { map: A, misses: 1 });
    const two = modesAfter(one, null);
    assert.deepEqual(two.map, {});
    assert.deepEqual(modesAfter(two, null).map, {}, 'stays clear');
    assert.deepEqual(modesAfter(two, B), { map: B, misses: 0 });
  });

  test('(−) a failure before any answer, or with a missing previous state, leaves an empty map', () => {
    assert.deepEqual(modesAfter({ map: {}, misses: 0 }, null).map, {});
    assert.deepEqual(modesAfter(undefined, null).map, {});
    assert.deepEqual(modesAfter(null, null).map, {});
  });
});

describe('rowMode and canEndRow (the mode cell and the End item share one rule)', () => {
  const map = { '%3': { mode: 'plan', confirmed: true }, '%14': { mode: 'acceptEdits', confirmed: false } };
  const live = (id) => ({ live: true, pane: { id } });

  test('(+) a live agent whose pane is in the map gets its entry; held entries come through unconfirmed', () => {
    assert.deepEqual(rowMode(live('%3'), map), { mode: 'plan', confirmed: true });
    assert.deepEqual(rowMode(live('%14'), map), { mode: 'acceptEdits', confirmed: false });
    assert.equal(canEndRow(live('%3'), map), true);
    assert.equal(canEndRow(live('%14'), map), true);
  });

  test('(−) an ended agent has neither a tag nor an End item, even when its old pane id is in the map', () => {
    const ended = { live: false, pane: { id: '%3' } };
    assert.equal(rowMode(ended, map), null);
    assert.equal(canEndRow(ended, map), false);
  });

  test('(−) no pane, a pane that is not in the map (not in tmux, capture failed) or an empty map: empty cell, no End item', () => {
    for (const a of [{ live: true }, { live: true, pane: null }, live('%99'), { live: true, pane: { id: 7 } }]) {
      assert.equal(rowMode(a, map), null, JSON.stringify(a));
      assert.equal(canEndRow(a, map), false, JSON.stringify(a));
    }
    assert.equal(canEndRow(live('%3'), {}), false);
    assert.equal(canEndRow(live('%3'), undefined), false);
    assert.equal(canEndRow(undefined, map), false);
  });

  test('(−) names inherited from Object.prototype are not panes', () => {
    for (const id of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) assert.equal(canEndRow(live(id), {}), false, id);
  });
});

// ---- models-ui.js: the spawn sheet's Roles group ---------------------------------------------------------------------

class FNode {
  constructor(tag, text = '') {
    this.tag = tag; this.text = text; this.kids = []; this.attrs = {}; this.className = ''; this.value = ''; this.dataset = {};
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return this.attrs[k] ?? null; }

  removeAttribute(k) { delete this.attrs[k]; }

  append(...nodes) { this.kids.push(...nodes); }

  replaceChildren(...nodes) { this.kids = nodes; }

  addEventListener() {}

  set textContent(v) { this.kids = []; this.text = String(v); }

  get textContent() { return this.text + this.kids.map((k) => k.textContent).join(''); }
}

let saved;
before(() => {
  saved = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = FNode;
  globalThis.document = { createElement: (tag) => new FNode(tag), createTextNode: (t) => new FNode('#text', t) };
});
after(() => {
  globalThis.document = saved.document;
  globalThis.Node = saved.Node;
});

describe('fillModelSelect with a Roles group (spawn sheet)', () => {
  const CATALOG = [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'latest' },
    { id: 'opus', label: 'Opus', group: 'alias' },
    { id: 'claude-old-1', label: 'Old 1', group: 'older' },
  ];
  const ROLES = [{ value: 'claude-sonnet-5-5', text: 'Builder · claude-sonnet-5-5' }, { value: 'haiku', text: 'Scout · haiku' }];
  const labels = (sel) => sel.kids.map((k) => k.attrs.label ?? `#${k.attrs.value}`);

  test('(+) Roles come first, then Latest, Aliases, Older, then Custom ID; a role value is selected without Custom', () => {
    const sel = new FNode('select');
    const custom = fillModelSelect(sel, CATALOG, 'haiku', ROLES);
    assert.deepEqual(labels(sel), ['Roles', 'Latest', 'Aliases', 'Older', `#${CUSTOM}`]);
    assert.deepEqual(sel.kids[0].kids.map((o) => [o.attrs.value, o.textContent]), ROLES.map((r) => [r.value, r.text]));
    assert.equal(sel.value, 'haiku');
    assert.equal(custom, false);
  });

  test('(+) a catalog id that is no role is selected too; the roles list is optional and callers without it are unchanged', () => {
    const sel = new FNode('select');
    assert.equal(fillModelSelect(sel, CATALOG, 'claude-old-1', ROLES), false);
    assert.equal(sel.value, 'claude-old-1');
    const plain = new FNode('select');
    assert.equal(fillModelSelect(plain, CATALOG, 'opus'), false);
    assert.deepEqual(labels(plain), ['Latest', 'Aliases', 'Older', `#${CUSTOM}`]);
  });

  test('(−) a value that is neither a role nor in the catalog selects Custom ID and reports it, so the caller fills the field', () => {
    const sel = new FNode('select');
    assert.equal(fillModelSelect(sel, CATALOG, 'claude-private-9', ROLES), true);
    assert.equal(sel.value, CUSTOM);
    assert.equal(fillModelSelect(new FNode('select'), null, 'opus', []), true, 'no catalog and no roles: only Custom ID is left');
  });
});

// ---- the /api/app/modes poll (project.js pollModes, run in a vm against stubs) ----------------------------------------

describe('pollModes', () => {
  const src = fn(PROJECT, 'function pollModes(');
  const rig = (answers) => {
    const calls = [];
    const renders = [];
    const timers = [];
    const queue = [...answers];
    const ctx = {
      state: { modes: { map: {}, misses: 0 } },
      appFetch: (url, opts) => { calls.push([url, opts]); const next = queue.shift(); return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); },
      AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
      setTimeout: (f, ms) => { timers.push({ f, ms, cleared: false }); return timers.length - 1; },
      clearTimeout: (id) => { timers[id].cleared = true; },
      parseModes,
      modesAfter,
      render: () => renders.push(JSON.stringify(ctx.state.modes.map)),
      Promise,
      JSON,
    };
    const poll = vm.runInNewContext(`let modesBusy = false; ${src}; pollModes`, ctx);
    return { ctx, calls, renders, timers, poll };
  };
  const ok = (modes) => ({ status: 200, body: { modes } });
  const settle = () => new Promise((r) => setImmediate(r));
  const PLAN = { '%3': { mode: 'plan', confirmed: true } };

  test('(+) asks /api/app/modes with an abort timer, stores the answer and redraws once when the map changed', async () => {
    const { ctx, calls, renders, timers, poll } = rig([ok(PLAN), ok(PLAN)]);
    poll();
    await settle();
    assert.equal(calls[0][0], '/api/app/modes');
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms <= 5000, 'a hung request cannot keep stale tags for long');
    assert.equal(timers[0].cleared, true, 'the timer is cleared once the request settles');
    timers[0].f();
    assert.equal(calls[0][1].signal.aborted, true, 'the timer aborts the request');
    assert.deepEqual(ctx.state.modes.map, PLAN);
    assert.equal(renders.length, 1);
    poll();
    await settle();
    assert.equal(renders.length, 1, 'the same map does not redraw');
  });

  test('(+) one request at a time: a call while one is in flight sends nothing', async () => {
    const { calls, poll } = rig([ok(PLAN)]);
    poll();
    poll();
    poll();
    assert.equal(calls.length, 1);
    await settle();
    poll();
    assert.equal(calls.length, 2, 'free again after the answer');
  });

  test('(−) a failed poll (network error, 500, 403, malformed body) keeps the tags one more cycle, then clears them', async () => {
    for (const bad of [new Error('down'), { status: 500, body: {} }, { status: 403, body: null }, { status: 200, body: { modes: 'plan' } }]) {
      const { ctx, renders, poll } = rig([ok(PLAN), bad, bad]);
      poll(); await settle();
      poll(); await settle();
      assert.deepEqual(ctx.state.modes.map, PLAN, 'kept after the first failure');
      poll(); await settle();
      assert.deepEqual(ctx.state.modes.map, {}, 'cleared after the second');
      assert.equal(renders.length, 2, 'drawn for the answer and for the clearing');
    }
  });

  test('(−) a failure frees the poller (the in-flight flag is not stuck)', async () => {
    const { calls, poll } = rig([new Error('down'), ok(PLAN)]);
    poll(); await settle();
    poll(); await settle();
    assert.equal(calls.length, 2);
  });
});

// ---- app.js: the row (cannot be imported; pinned) ----------------------------------------------------------------------

describe('dashboard row', () => {
  test('(+) the mode cell exists only on the app tier and holds a compact modeEl for the pane\'s entry, empty otherwise', () => {
    assert.match(APP, /import \{[^}]*\bmodeEl\b[^}]*\} from '\.\/modes\.js'/);
    assert.match(APP, /const mode = isApp \? rowMode\(a, state\.modes\.map\) : null;/);
    assert.match(APP, /isApp \? h\('div', \{ class: 'c-mode' \}, mode && modeEl\(mode\.mode, \{ confirmed: mode\.confirmed, compact: true \}\)\) : null,/);
    const row = fn(APP, 'function rowEl(');
    assert.ok(row.indexOf("'c-st'") < row.indexOf("'c-mode'") && row.indexOf("'c-mode'") < row.indexOf("'c-name'"), 'status, mode, name');
  });

  test('(+) the row menu gets "End session…" after the other items, for live agents with a pane in the latest /modes answer only', () => {
    assert.match(APP, /if \(isApp && canEndRow\(a, state\.modes\.map\)\) \{\s*items\.push\(\{ text: 'End session…', group: orchItems\.length > 0, run: \(\) => endSession\(a, fk\('m'\), fk\('m', endedScope\(scope\)\)\) \}\);\s*\}/);
    assert.match(fn(APP, 'export function agentNodes('), /scope: endedScope\(scope\)/, 'the Ended group draws its rows under the scope the End item computes');
    const row = fn(APP, 'function rowEl(');
    assert.ok(row.indexOf('Focus pane') < row.indexOf('hooks.rowItems') && row.indexOf('hooks.rowItems') < row.indexOf('End session'), 'the orchestrator items sit between the pane item and the destructive one, which is last');
    assert.match(row, /const orchItems = isApp \? hooks\.rowItems\?\.\(a, g, scope\) \?\? \[\] : \[\];/, 'asked on the app tier only');
  });

  test('(−) the End item is not built for ended agents or off the app tier: the guard is the pure rule, not the status text', () => {
    const row = fn(APP, 'function rowEl(');
    assert.equal(row.match(/End session/g).length, 1, 'one place builds it');
    assert.doesNotMatch(row, /s !== 'ended'[^\n]*End session|End session[^\n]*s !== 'ended'/);
  });

  test('(+) End loads end-dialog.js on first use (a dynamic import), so the dashboard does not pay for it up front', () => {
    assert.match(fn(APP, 'async function endSession('), /await import\('\.\/end-dialog\.js'\)/);
    assert.doesNotMatch(APP, /^import[^\n]*end-dialog\.js/m);
  });

  test('(+) a mode change redraws the lists: the dashboard signature includes the map', () => {
    assert.match(fn(APP, 'function renderDashboard('), /isApp \? state\.modes\.map : null/);
    assert.match(fn(PROJECT, 'function renderProject('), /state\.modes\.map/);
  });

  test('(+) the sprite of the dashboard draws every mode icon modes.js can ask for', () => {
    const symbols = new Set([...HTML.matchAll(/<symbol id="i-([a-z-]+)"/g)].map((m) => m[1]));
    for (const meta of Object.values(MODE_META)) assert.ok(symbols.has(meta.icon), meta.icon);
  });
});

// ---- End from the row menu (app.js endSession and afterEnd, run in a vm against stubs) ---------------------------------------
//
// import() in a vm needs a Node flag, so the rig swaps the one dynamic import for a call to a stub loader; the code under test is
// otherwise the page's own text.

describe('End session from the row menu', () => {
  const sOfSrc = fn(APP, 'export function sOf(').replace('export ', '');
  const endSrc = fn(APP, 'async function endSession(').replace("import('./end-dialog.js')", 'loadEndDialog()');
  const afterSrc = fn(APP, 'async function afterEnd(');
  const SECRET = 'chunk 7f3a failed at /srv/secret-path';
  const LIVE = { id: 'agent-a', name: 'builder-1', live: true, state: 'busy', attention: null, pane: { id: '%3' } };
  const live = (over = {}) => ({ ...LIVE, ...over });
  const ended = (over = {}) => ({ ...LIVE, live: false, state: 'ended', ...over });
  const MENU = 'm:g1:agent-a';
  const ENDED_MENU = 'm:g1-e:agent-a';
  const btn = (events, name, visible = true) => ({ offsetParent: visible ? {} : null, focus: () => events.push(`focus:${name}`) });

  /** buttons: { fk: { visible } }; after: the agents the list holds once refresh has run. */
  const rig = ({ isApp = true, buttons = {}, after = [], dialog = {}, loader } = {}) => {
    const events = [];
    const toasts = [];
    const opened = [];
    const nodes = Object.fromEntries(Object.entries(buttons).map(([k, v]) => [k, btn(events, k, v.visible)]));
    const h1 = { focus: () => events.push('focus:h1') };
    const ctx = {
      isApp,
      statusOf,
      state: { data: null },
      CSS: { escape: (x) => x },
      $: (sel) => {
        if (sel === '.screen:not([hidden]) h1') return h1;
        const fk = /^\[data-fk="(.*)"\]$/.exec(sel)?.[1];
        return (fk && nodes[fk]) || null;
      },
      toast: (text, opts) => { toasts.push([text, opts]); events.push(`toast:${text}`); },
      refresh: async () => { events.push('refresh'); ctx.state.data = { groups: [{ agents: after }] }; },
      loadEndDialog: loader ?? (async () => ({ openEndDialog: (o) => { opened.push(o); if (dialog.throws) throw new Error(SECRET); } })),
    };
    const run = vm.runInNewContext(`${sOfSrc}\n${afterSrc}\n${endSrc}\n({ endSession, afterEnd })`, ctx);
    return { ...run, events, toasts, opened, ctx };
  };

  test('(+) End puts focus on the row\'s menu button, then opens the dialog with the pane, the name, working = busy and promptOpen = attention', async () => {
    const { endSession, events, opened } = rig({ buttons: { [MENU]: {} } });
    await endSession(live(), MENU, ENDED_MENU);
    assert.deepEqual(events, [`focus:${MENU}`], 'focus first, so Cancel returns there');
    assert.equal(opened.length, 1);
    assert.deepEqual({ ...opened[0], onEnded: typeof opened[0].onEnded }, { pane: '%3', name: 'builder-1', working: true, promptOpen: false, onEnded: 'function' });
    const second = rig({ buttons: { [MENU]: {} } });
    await second.endSession(live({ state: 'idle', attention: 'permission prompt' }), MENU, ENDED_MENU);
    assert.deepEqual([second.opened[0].working, second.opened[0].promptOpen], [false, true]);
  });

  test('(−) off the app tier nothing loads and nothing opens', async () => {
    let loads = 0;
    const { endSession, opened, events } = rig({ isApp: false, loader: async () => { loads += 1; return { openEndDialog() {} }; } });
    await endSession(live(), MENU, ENDED_MENU);
    assert.equal(loads, 0);
    assert.deepEqual([opened.length, events.length], [0, 0]);
  });

  test('(+) a chunk that cannot load shows the fixed error toast and never the error\'s own text; the click handler does not reject', async () => {
    const { endSession, toasts, opened } = rig({ buttons: { [MENU]: {} }, loader: async () => { throw new Error(SECRET); } });
    await assert.doesNotReject(endSession(live(), MENU, ENDED_MENU));
    assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [["Couldn't open the End dialog.", { kind: 'error' }]]); // JSON: the vm has its own Object
    assert.equal(opened.length, 0);
  });

  test('(+) a dialog that throws while opening gets the same fixed toast', async () => {
    const { endSession, toasts, opened } = rig({ buttons: { [MENU]: {} }, dialog: { throws: true } });
    await assert.doesNotReject(endSession(live(), MENU, ENDED_MENU));
    assert.equal(opened.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [["Couldn't open the End dialog.", { kind: 'error' }]]); // JSON: the vm has its own Object
  });

  test('(−) no error text reaches the page: the secret string is in no toast, whichever step fails', async () => {
    for (const opts of [{ loader: async () => { throw new Error(SECRET); } }, { dialog: { throws: true } }]) {
      const { endSession, toasts } = rig({ buttons: { [MENU]: {} }, ...opts });
      await endSession(live(), MENU, ENDED_MENU);
      assert.equal(JSON.stringify(toasts).includes(SECRET), false);
      assert.equal(JSON.stringify(toasts).includes('secret'), false);
    }
  });

  test('(+) when the dialog reports ended: toast first, read the list again, then focus the ended row\'s menu button if that row is visible', async () => {
    const { endSession, events, opened } = rig({ buttons: { [ENDED_MENU]: {} }, after: [ended()] });
    await endSession(live(), MENU, ENDED_MENU);
    events.length = 0;
    await opened[0].onEnded();
    assert.deepEqual(events, ['toast:Session ended', 'refresh', `focus:${ENDED_MENU}`]);
  });

  test('(+) a stale list (/api/agents is cached 1.5 s) that still shows the agent live sends focus to the heading, not to a row that is about to move', async () => {
    const { afterEnd, events } = rig({ buttons: { [MENU]: {} }, after: [live()] });
    await afterEnd(live(), ENDED_MENU);
    assert.deepEqual(events, ['toast:Session ended', 'refresh', 'focus:h1']);
  });

  test('(−) the status decides, not the DOM: a visible button under the ended scope is not focused while the list still says live', async () => {
    const { afterEnd, events } = rig({ buttons: { [MENU]: {}, [ENDED_MENU]: {} }, after: [live()] });
    await afterEnd(live(), ENDED_MENU);
    assert.deepEqual(events.slice(-1), ['focus:h1']);
  });

  test('(−) an ended row inside the closed Ended disclosure is not visible: heading', async () => {
    const { afterEnd, events } = rig({ buttons: { [ENDED_MENU]: { visible: false } }, after: [ended()] });
    await afterEnd(live(), ENDED_MENU);
    assert.deepEqual(events.slice(-1), ['focus:h1']);
    assert.equal(events.includes(`focus:${ENDED_MENU}`), false);
  });

  test('(−) the agent is gone from the list, or only another agent\'s button exists: heading, never somebody else\'s button', async () => {
    const gone = rig({ buttons: { 'm:g1-e:agent-b': {} }, after: [] });
    await gone.afterEnd(live(), ENDED_MENU);
    assert.deepEqual(gone.events.slice(-1), ['focus:h1']);
    const other = rig({ buttons: { 'm:g1-e:agent-b': {} }, after: [ended({ id: 'agent-b' }), ended()] });
    await other.afterEnd(live(), ENDED_MENU);
    assert.deepEqual(other.events.slice(-1), ['focus:h1'], 'the ended agent has no button on screen');
  });

  test('(−) no data after the refresh (the list could not be read): heading', async () => {
    const r = rig({ buttons: { [ENDED_MENU]: {} } });
    r.ctx.refresh = async () => { r.events.push('refresh'); };
    await r.afterEnd(live(), ENDED_MENU);
    assert.deepEqual(r.events.slice(-1), ['focus:h1']);
  });
});

describe('browser tier has no mode polling', () => {
  test('(+) /api/app/modes is named once, in project.js (app tier, loaded only behind isApp)', () => {
    assert.equal(PROJECT.match(/\/api\/app\/modes/g)?.length, 1);
    for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.js') && x !== 'project.js')) assert.doesNotMatch(code(read(f)), /\/api\/app\/modes/, f);
  });

  test('(−) app.js never fetches modes and never calls the poller itself; project.js starts it only from pollApp, which initApp registers', () => {
    assert.doesNotMatch(APP, /pollModes|appFetch/);
    assert.match(fn(PROJECT, 'async function pollApp('), /pollModes\(\);/);
    assert.match(fn(PROJECT, 'export async function initApp('), /hooks\.pollApp = pollApp;/);
  });

  test('(−) the row has no mode cell and the grids keep the 0.2 columns (only the name column is wider since 0.4) off the app tier (the app grids are scoped to body[data-tier="app"])', () => {
    assert.match(APP_CSS, /\.row \{[^}]*grid-template-columns: 104px minmax\(232px, 1\.5fr\) 88px 64px minmax\(0, 2fr\) 56px 44px 32px;/);
    assert.match(APP_CSS, /@container rows \(max-width: 860px\) \{\s*\.row \{ grid-template-columns: 22px minmax\(208px, 1\.1fr\) 56px minmax\(0, 2fr\) 52px 32px; \}/);
    assert.match(APP_CSS, /@container rows \(max-width: 600px\) \{\s*\.row \{ column-gap: 6px; grid-template-columns: 22px minmax\(0, 1fr\) 56px 40px 32px; \}/);
    assert.equal([...APP_CSS.matchAll(/^\s*\.row \{ ?grid-template-columns: [^;]*\b24px\b/gm)].length, 0, 'no unscoped rule gives the browser tier a mode column');
    assert.equal([...APP_CSS.matchAll(/^\s*\.row \{ ?grid-template-columns: [^;]*\b128px\b/gm)].length, 0);
  });
});

describe('row grids with the mode column (spec 9.9)', () => {
  test('(+) app tier: 9 columns wide (the context meter after the model, 0.4), then status glyph + icon-only mode at 860, the name row above the prompt at 600', () => {
    assert.match(APP_CSS, /body\[data-tier="app"\] \.row \{ grid-template-columns: 104px 128px minmax\(232px, 1\.5fr\) 88px 64px minmax\(0, 2fr\) 56px 44px 32px; \}/);
    assert.match(APP_CSS, /@container rows \(max-width: 860px\) \{[^@]*body\[data-tier="app"\] \.row \{ grid-template-columns: 22px 24px minmax\(208px, 1\.1fr\) 56px minmax\(0, 2fr\) 52px 32px; \}/);
    const small = /@container rows \(max-width: 600px\) \{([^@]*?)\n\}/.exec(APP_CSS)?.[1] ?? '';
    assert.match(small, /body\[data-tier="app"\] \.row \{ grid-template-columns: 22px 24px minmax\(0, 1fr\) 56px 40px 32px; \}/);
    assert.match(small, /body\[data-tier="app"\] \.row \.c-what \{ grid-column: 3 \/ -1; grid-row: 2; \}/);
    assert.match(small, /body\[data-tier="app"\] \.row \.c-act \{ grid-row: 1; grid-column: 5; \}/);
  });

  test('(+) app tier: its wide grid needs 864 px, so the narrow grid takes over at 1010 px with the same rules as the 860 px block (every rule has an app-tier twin)', () => {
    assert.equal(104 + 128 + 232 + 88 + 64 + 56 + 44 + 32 + 8 * 12 + 20, 864, 'the floors of the app wide grid');
    const norm = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    const narrow = norm(/@container rows \(max-width: 860px\) \{([^@]*?)\n\}/.exec(APP_CSS)?.[1] ?? '');
    const app = norm(/@container rows \(max-width: 1010px\) \{([^@]*?)\n\}/.exec(APP_CSS)?.[1] ?? '');
    assert.match(app, /^body\[data-tier="app"\] \.row \{ grid-template-columns: 22px 24px minmax\(208px, 1\.1fr\) 56px minmax\(0, 2fr\) 52px 32px; \}/);
    const rules = [...narrow.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2].trim()]).filter(([sel]) => sel !== '.row' && !sel.startsWith('body[data-tier'));
    assert.equal(rules.length, 10, 'the 860 px block has ten rules besides the two grids');
    for (const [sel, decl] of rules) {
      const twin = `${sel.split(',').map((s) => `body[data-tier="app"] ${s.trim()}`).join(', ')} { ${decl} }`;
      assert.ok(app.includes(twin), `no app-tier twin for ${sel}`);
    }
    assert.equal([...app.matchAll(/([^{}]+)\{/g)].every((m) => m[1].split(',').every((s) => s.trim().startsWith('body[data-tier="app"]'))), true, 'the 1010 px block is app-tier only: the browser tier keeps 860 px');
  });

  test('(−) the project page stacks its cards under the list at 1030 px, not 1000: beside the list a 400 px list clipped the sub-orchestrator tag', () => {
    assert.match(APP_CSS, /@media \(max-width: 1030px\) \{\s*\.proj-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.doesNotMatch(APP_CSS, /@media \(max-width: 1000px\) \{\s*\.proj-grid/);
  });

  test('(+) at 860 px and below the tag is icon-only: the label leaves the layout but stays for screen readers and in the title', () => {
    const wide = /@container rows \(max-width: 860px\) \{([^@]*?)\n\}/.exec(APP_CSS)?.[1] ?? '';
    assert.match(wide, /\.row \.c-mode \.ml \{[^}]*position: absolute;[^}]*clip: rect\(0 0 0 0\)/);
    assert.match(wide, /\.row \.c-mode \.mode \{[^}]*padding: 0 4px;[^}]*gap: 0/);
  });

  test('(+) the mode cell is a flex box that can shrink; the 128 px column keeps the tag from overflowing', () => {
    assert.match(APP_CSS, /\.c-mode \{[^}]*min-width: 0;[^}]*display: flex;[^}]*align-items: center/);
  });
});

// ---- model pickers -------------------------------------------------------------------------------------------------

describe('Settings and spawn sheet pickers', () => {
  test('(+) settings.js reads and writes the picker: select value or the custom field, checked with MODEL_ID and MODEL_HINT', () => {
    const names = /import \{([^}]*)\} from '\.\/models-ui\.js'/.exec(SETTINGS)?.[1].split(',').map((x) => x.trim()) ?? [];
    for (const n of ['CUSTOM', 'MODEL_ID', 'MODEL_HINT', 'fillModelSelect']) assert.ok(names.includes(n), `settings.js imports ${n}`);
    assert.match(SETTINGS, /fillModelSelect\(/);
    assert.match(SETTINGS, /MODEL_ID\.test\(/);
    assert.match(SETTINGS, /MODEL_HINT/);
    assert.doesNotMatch(SETTINGS, /\.dataset\.rx\b[^\n]*model|RX\.model/);
  });

  test('(−) a saved value that is not in the catalog opens as Custom with the field filled; a hidden field is never validated or saved', () => {
    const fill = fn(SETTINGS, 'function fillRoles(');
    assert.match(fill, /const custom = fillModelSelect\(roleSel\(r\), state\.models, value\);/);
    assert.match(fill, /roleCustom\(r\)\.value = custom \? value : '';/);
    assert.match(fill, /roleCustom\(r\)\.hidden = !custom;/);
    assert.match(fn(SETTINGS, 'function validate('), /!input\.hidden && !MODEL_ID\.test\(input\.value\.trim\(\)\)/);
    assert.match(fn(SETTINGS, 'function roleValue('), /=== CUSTOM \? roleCustom\(r\)\.value\.trim\(\) : roleSel\(r\)\.value/);
  });

  test('(+) the spawn sheet lists Roles first, then the catalog, then Custom ID; the chosen id is the select or the checked custom field', () => {
    const fill = fn(PROJECT, 'function fillSpawnModel(');
    assert.match(fn(PROJECT, 'function openSpawn('), /fillSpawnModel\(start, pref\.model\);/);
    assert.match(fill, /fillModelSelect\(\$\('#sp-model'\), state\.models, value, roles\)/);
    assert.match(fill, /roles\[role === 'orchestrator' \? 3 : 0\]\.value/, 'Builder for an agent, Orchestrator for a sub-orchestrator');
    assert.match(fill, /\$\('#sp-model-custom'\)\.hidden = !custom;/);
    assert.match(fn(PROJECT, 'async function submitSpawn('), /const model = spawnModel\(\);/, 'one reading of the picker, the one the tests below run');
    assert.match(fn(PROJECT, 'function validateSpawn('), /MODEL_ID\.test\(/);
  });

  test('(+) the catalog is loaded with the other app data and kept in state.models; a failed load leaves null, so only Custom ID is offered', () => {
    assert.match(PROJECT, /export async function loadModels\(\) \{[^}]*appFetch\('\/api\/app\/models'\)/);
    assert.match(fn(PROJECT, 'export async function initApp('), /loadModels\(\)/);
    assert.match(SETTINGS, /await loadModels\(\)/, 'Settings retries the catalog when the first load failed');
  });
});

// ---- the pickers, run against fake nodes ---------------------------------------------------------------------------------

describe('Settings role pickers (settings.js fillRoles and roleValue)', () => {
  const CATALOG = [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'latest' },
    { id: 'opus', label: 'Opus', group: 'alias' },
    { id: 'claude-old-1', label: 'Old 1', group: 'older' },
  ];
  const ROLE_NAMES = ['orchestrator', 'reasoner', 'builder', 'scout'];
  const saved = (over = {}) => ({ orchestrator: 'opus', reasoner: 'claude-sonnet-5-5', builder: 'claude-old-1', scout: 'opus', ...over });

  const rig = (catalog) => {
    const nodes = new Map();
    const node = (sel) => { if (!nodes.has(sel)) nodes.set(sel, new FNode(sel.endsWith('-custom') ? 'input' : 'select')); return nodes.get(sel); };
    const head = [/^const ROLES = .*$/m, /^const roleSel = .*$/m, /^const roleCustom = .*$/m].map((re) => re.exec(SETTINGS)?.[0]);
    assert.ok(head.every(Boolean), 'ROLES, roleSel and roleCustom exist');
    const ctx = { $: node, state: { models: catalog }, fillModelSelect, CUSTOM };
    const api = vm.runInNewContext(`${head.join('\n')}\n${fn(SETTINGS, 'function fillRoles(')}\n${fn(SETTINGS, 'function roleValue(')}\n({ ROLES, fillRoles, roleValue, roleSel, roleCustom })`, ctx);
    return { ...api, ctx };
  };

  test('(+) a catalog id or alias comes back unchanged, with the custom field empty and hidden', () => {
    const { ROLES, fillRoles, roleValue, roleSel, roleCustom } = rig(CATALOG);
    assert.deepEqual([...ROLES], ROLE_NAMES);
    const models = saved();
    fillRoles(models);
    for (const r of ROLE_NAMES) {
      assert.equal(roleValue(r), models[r], r);
      assert.equal(roleSel(r).value, models[r], `${r} selects the catalog entry`);
      assert.deepEqual([roleCustom(r).value, roleCustom(r).hidden], ['', true], r);
    }
  });

  test('(+) a custom id that is not in the catalog opens as Custom ID with the field filled and comes back unchanged', () => {
    const { fillRoles, roleValue, roleSel, roleCustom } = rig(CATALOG);
    fillRoles(saved({ builder: 'claude-private-9' }));
    assert.equal(roleSel('builder').value, CUSTOM);
    assert.deepEqual([roleCustom('builder').value, roleCustom('builder').hidden], ['claude-private-9', false]);
    assert.equal(roleValue('builder'), 'claude-private-9');
    assert.equal(roleValue('scout'), 'opus', 'the other roles are untouched');
  });

  test('(−) when /models failed (no catalog) every saved id survives as Custom ID: Save would send exactly what was loaded', () => {
    const { fillRoles, roleValue, roleSel, roleCustom } = rig(null);
    const models = saved();
    fillRoles(models);
    for (const r of ROLE_NAMES) {
      assert.equal(roleSel(r).value, CUSTOM, r);
      assert.equal(roleCustom(r).hidden, false, r);
      assert.equal(roleValue(r), models[r], r);
    }
  });

  test('(−) a failed loadModels leaves state.models as it was, so the same round-trip holds afterwards', async () => {
    const calls = [];
    const state = { models: null };
    const answers = [new Error('down'), { status: 500, body: {} }, { status: 200, body: { models: 'x' } }, { status: 200, body: {} }];
    const ctx = { state, appFetch: (url) => { calls.push(url); const a = answers.shift(); return a instanceof Error ? Promise.reject(a) : Promise.resolve(a); }, Array };
    const loadModels = vm.runInNewContext(`${fn(PROJECT, 'export async function loadModels(').replace('export ', '')}\nloadModels`, ctx);
    await assert.rejects(loadModels(), /down/, 'a network error reaches the caller, which catches it');
    for (let i = 0; i < 3; i += 1) await loadModels();
    assert.equal(state.models, null);
    assert.deepEqual(calls, Array(4).fill('/api/app/models'));
    const { fillRoles, roleValue } = rig(state.models);
    fillRoles(saved({ builder: 'claude-sonnet-5-5' }));
    assert.equal(roleValue('builder'), 'claude-sonnet-5-5');
    state.models = CATALOG; // an earlier catalog survives a later failure
    answers.push({ status: 500, body: {} });
    await loadModels();
    assert.equal(state.models, CATALOG);
  });

  test('(+) loadModels keeps a catalog that is an array', async () => {
    const state = { models: null };
    const loadModels = vm.runInNewContext(`${fn(PROJECT, 'export async function loadModels(').replace('export ', '')}\nloadModels`, { state, Array, appFetch: async () => ({ status: 200, body: { models: CATALOG } }) });
    await loadModels();
    assert.deepEqual(state.models, CATALOG);
  });

  test('(−) the hidden custom field is ignored once another entry is chosen: its leftover text is never saved', () => {
    const { fillRoles, roleValue, roleSel, roleCustom } = rig(CATALOG);
    fillRoles(saved({ scout: 'claude-private-9' }));
    roleSel('scout').value = 'opus';
    roleCustom('scout').hidden = true;
    assert.equal(roleValue('scout'), 'opus');
    roleSel('scout').value = CUSTOM;
    roleCustom('scout').value = '  claude-private-10  ';
    assert.equal(roleValue('scout'), 'claude-private-10', 'trimmed');
  });
});

describe('spawn sheet model picker (project.js openSpawn and spawnModel)', () => {
  const CATALOG = [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'latest' },
    { id: 'opus', label: 'Opus', group: 'alias' },
    { id: 'claude-old-1', label: 'Old 1', group: 'older' },
  ];
  const SETTINGS_MODELS = { builder: 'claude-sonnet-5-5', reasoner: 'claude-opus-5-5', scout: 'haiku', orchestrator: 'claude-fable-1' };
  const group = { project: { key: 'k1' }, label: 'demo', agents: [] };

  const PROJECT_MOD = PROJECT.replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
  const rig = ({ catalog = CATALOG, settings = { models: SETTINGS_MODELS, permissionMode: 'default', panePlacement: 'beside' }, pref } = {}) => {
    const nodes = new Map();
    const node = (sel) => { if (!nodes.has(sel)) nodes.set(sel, new FNode(sel === '#sp-model' ? 'select' : 'input')); return nodes.get(sel); };
    const ctx = {
      $: node, h, state: { models: catalog, settings }, fillModelSelect, CUSTOM, ROLE_LABEL, effectiveRoleModels, spawnLimits,
      toast() {}, fieldError() {}, openDialog() {}, syncRadioCards() {}, TextEncoder,
    };
    const api = vm.runInNewContext(`${PROJECT_MOD}\n({ openSpawn, spawnModel, spawnPrefs })`, ctx);
    if (pref) api.spawnPrefs.set('k1:agent', pref);
    return { ...api, node, ctx };
  };
  const optionsOf = (sel) => sel.kids.flatMap((k) => (k.tag === 'optgroup' ? k.kids.map((o) => [k.attrs.label, o.attrs.value, o.textContent]) : [[null, k.attrs.value, k.textContent]]));

  test('(+) the Roles optgroup lists the four configured models first; the first role is chosen and is what a spawn would send', () => {
    const { openSpawn, spawnModel, node } = rig();
    openSpawn(group);
    const rows = optionsOf(node('#sp-model'));
    assert.deepEqual(rows.filter((r) => r[0] === 'Roles'), [
      ['Roles', 'claude-sonnet-5-5', 'Builder · claude-sonnet-5-5'],
      ['Roles', 'claude-opus-5-5', 'Reasoner · claude-opus-5-5'],
      ['Roles', 'haiku', 'Scout · haiku'],
      ['Roles', 'claude-fable-1', 'Orchestrator · claude-fable-1'],
    ]);
    assert.equal(rows[0][0], 'Roles', 'Roles come first');
    assert.equal(rows.at(-1)[1], CUSTOM, 'Custom ID comes last');
    assert.equal(node('#sp-model').value, 'claude-sonnet-5-5');
    assert.equal(node('#sp-model-custom').hidden, true);
    assert.equal(spawnModel(), 'claude-sonnet-5-5');
  });

  test('(+) choosing another role sends that role\'s model, not the first one', () => {
    const { openSpawn, spawnModel, node } = rig();
    openSpawn(group);
    node('#sp-model').value = 'haiku';
    assert.equal(spawnModel(), 'haiku');
    node('#sp-model').value = 'claude-old-1';
    assert.equal(spawnModel(), 'claude-old-1', 'a catalog entry works too');
  });

  test('(+) a remembered model that is in the catalog is selected again; one that is not opens as Custom ID with the field filled', () => {
    const known = rig({ pref: { model: 'claude-old-1' } });
    known.openSpawn(group);
    assert.deepEqual([known.node('#sp-model').value, known.node('#sp-model-custom').hidden, known.spawnModel()], ['claude-old-1', true, 'claude-old-1']);
    const odd = rig({ pref: { model: 'claude-private-9' } });
    odd.openSpawn(group);
    assert.equal(odd.node('#sp-model').value, CUSTOM);
    assert.deepEqual([odd.node('#sp-model-custom').value, odd.node('#sp-model-custom').hidden], ['claude-private-9', false]);
    assert.equal(odd.spawnModel(), 'claude-private-9');
    odd.node('#sp-model-custom').value = '  claude-private-10 ';
    assert.equal(odd.spawnModel(), 'claude-private-10', 'trimmed');
  });

  test('(−) Custom ID never sends its marker value, and an empty field sends an empty id for the validator to refuse', () => {
    const { openSpawn, spawnModel, node } = rig();
    openSpawn(group);
    node('#sp-model').value = CUSTOM;
    node('#sp-model-custom').value = '';
    assert.equal(spawnModel(), '');
    assert.notEqual(spawnModel(), CUSTOM);
  });

  test('(−) without a catalog (the /models call failed) the roles are still offered and the first is chosen; without settings the four aliases stand in', () => {
    const noCatalog = rig({ catalog: null });
    noCatalog.openSpawn(group);
    assert.deepEqual(optionsOf(noCatalog.node('#sp-model')).map((r) => r[0] ?? '-'), ['Roles', 'Roles', 'Roles', 'Roles', '-'], 'four roles, then Custom ID');
    assert.equal(noCatalog.spawnModel(), 'claude-sonnet-5-5');
    const noSettings = rig({ settings: null });
    noSettings.openSpawn(group);
    assert.deepEqual(optionsOf(noSettings.node('#sp-model')).filter((r) => r[0] === 'Roles').map((r) => r[1]), ['opus', 'sonnet', 'haiku', 'fable']);
    assert.equal(noSettings.spawnModel(), 'opus');
  });
});
