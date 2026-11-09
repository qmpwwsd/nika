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
import { CUSTOM, fillModelSelect } from '../public/models-ui.js';

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
    this.tag = tag; this.text = text; this.kids = []; this.attrs = {}; this.className = ''; this.value = '';
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return this.attrs[k] ?? null; }

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
    assert.match(APP, /if \(isApp && canEndRow\(a, state\.modes\.map\)\) \{\s*items\.push\(\{ text: 'End session…', run: \(\) => endSession\(a, fk\('m'\)\) \}\);\s*\}/);
    const row = fn(APP, 'function rowEl(');
    assert.ok(row.indexOf('Focus pane') < row.indexOf('End session'), 'the destructive item is last');
  });

  test('(−) the End item is not built for ended agents or off the app tier: the guard is the pure rule, not the status text', () => {
    const row = fn(APP, 'function rowEl(');
    assert.equal(row.match(/End session/g).length, 1, 'one place builds it');
    assert.doesNotMatch(row, /s !== 'ended'[^\n]*End session|End session[^\n]*s !== 'ended'/);
  });

  test('(+) End opens end-dialog.js with the agent\'s name, working = busy and promptOpen = attention; after ended it toasts and redraws', () => {
    const f = fn(APP, 'async function endSession(');
    assert.match(f, /openEndDialog\(\{ pane: a\.pane\.id, name: a\.name, working: a\.state === 'busy', promptOpen: Boolean\(a\.attention\), onEnded: \(\) => afterEnd\(menuFk\) \}\)/);
    assert.match(f, /\?\.focus\(\);\s*openEndDialog/, 'focus is on the row\'s menu button when the dialog opens, so Cancel returns there');
    const after = fn(APP, 'async function afterEnd(');
    assert.match(after, /toast\('Session ended'\)/);
    assert.match(after, /await refresh\(\)/);
    assert.match(after, /offsetParent !== null/, 'a button inside a closed disclosure counts as gone');
    assert.match(after, /h1'\)\?\.focus\(\)/, 'the heading when the row is gone');
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

  test('(−) the row has no mode cell and the grids stay as in 0.2 off the app tier (the app grids are scoped to body[data-tier="app"])', () => {
    assert.match(APP_CSS, /\.row \{[^}]*grid-template-columns: 104px minmax\(120px, 1\.1fr\) 88px minmax\(0, 2\.4fr\) 56px 44px 32px;/);
    assert.match(APP_CSS, /@container rows \(max-width: 860px\) \{\s*\.row \{ grid-template-columns: 22px minmax\(110px, 1fr\) minmax\(0, 2fr\) 52px 32px; \}/);
    assert.match(APP_CSS, /@container rows \(max-width: 600px\) \{\s*\.row \{ grid-template-columns: 22px minmax\(0, 1fr\) 44px 32px; \}/);
    assert.equal([...APP_CSS.matchAll(/^\s*\.row \{ ?grid-template-columns: [^;]*\b24px\b/gm)].length, 0, 'no unscoped rule gives the browser tier a mode column');
    assert.equal([...APP_CSS.matchAll(/^\s*\.row \{ ?grid-template-columns: [^;]*\b128px\b/gm)].length, 0);
  });
});

describe('row grids with the mode column (spec 9.9)', () => {
  test('(+) app tier: 8 columns wide, then status glyph + icon-only mode at 860, the name row above the prompt at 600', () => {
    assert.match(APP_CSS, /body\[data-tier="app"\] \.row \{ grid-template-columns: 104px 128px minmax\(120px, 1\.1fr\) 88px minmax\(0, 2\.4fr\) 56px 44px 32px; \}/);
    assert.match(APP_CSS, /@container rows \(max-width: 860px\) \{[^@]*body\[data-tier="app"\] \.row \{ grid-template-columns: 22px 24px minmax\(110px, 1fr\) minmax\(0, 2fr\) 52px 32px; \}/);
    const small = /@container rows \(max-width: 600px\) \{([^@]*?)\n\}/.exec(APP_CSS)?.[1] ?? '';
    assert.match(small, /body\[data-tier="app"\] \.row \{ grid-template-columns: 22px 24px minmax\(0, 1fr\) 44px 32px; \}/);
    assert.match(small, /body\[data-tier="app"\] \.row \.c-what \{ grid-column: 3 \/ -1; grid-row: 2; \}/);
    assert.match(small, /body\[data-tier="app"\] \.row \.c-act \{ grid-row: 1; grid-column: 4; \}/);
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
    const open = fn(PROJECT, 'function openSpawn(');
    assert.match(open, /fillModelSelect\(\$\('#sp-model'\), state\.models, pref\.model \?\? roles\[0\]\.value, roles\)/);
    assert.match(open, /\$\('#sp-model-custom'\)\.hidden = !custom;/);
    assert.match(PROJECT, /const model = \$\('#sp-model'\)\.value === CUSTOM \? \$\('#sp-model-custom'\)\.value\.trim\(\) : \$\('#sp-model'\)\.value;/);
    assert.match(fn(PROJECT, 'function validateSpawn('), /MODEL_ID\.test\(/);
  });

  test('(+) the catalog is loaded with the other app data and kept in state.models; a failed load leaves null, so only Custom ID is offered', () => {
    assert.match(PROJECT, /export async function loadModels\(\) \{[^}]*appFetch\('\/api\/app\/models'\)/);
    assert.match(fn(PROJECT, 'export async function initApp('), /loadModels\(\)/);
    assert.match(SETTINGS, /await loadModels\(\)/, 'Settings retries the catalog when the first load failed');
  });
});
