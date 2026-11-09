// 0.4, O1: pick or resume an orchestrator, the page side (design 0.4 section 1): menuEl items with fk / reason / group, the role badge,
// the row menu and badge in app.js rowEl, and the flows in project.js (header button, row items, Set, Resume, Stop using, the gone alert).
// The browser is exercised by hand; here the real page code runs in a vm (or Node) against a small fake DOM (test/fake-dom.js) and
// recorded requests. Names and ids are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, withClass, focus } from './fake-dom.js';
import { h, icon, roleTagEl } from '../public/dom.js';
import { menuEl, sessionHref } from '../public/ui.js';
import { orchState, roleTag, savedPick, otherRunning } from '../public/dash-model.js';
import { parseModes, modesAfter } from '../public/modes.js';
import { pluginView, pluginSave, sortIds, countText, filterNote } from '../public/plugin-view.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const plain = (v) => JSON.parse(JSON.stringify(v)); // values built inside a vm have another realm's prototypes
const settle = () => new Promise((r) => setImmediate(r));

let restore;
const realSetTimeout = globalThis.setTimeout;
before(() => {
  const box = new El('div');
  restore = installDom({ querySelector: (sel) => (sel === '#toasts' ? box : null), toastBox: box });
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSetTimeout(fn, ms, ...a); t.unref?.(); return t; }; // a toast's 4 s timer must not hold the run
});
after(() => {
  globalThis.setTimeout = realSetTimeout;
  restore();
});

// ---- menuEl: fk, reason and group (design section 0) -----------------------------------------------------------------------------

const itemsOf = (menu) => menu.all((n) => n.tag === 'li');
const controlOf = (li) => li.kids[0];

describe('menuEl: fk, reason and group', () => {
  const noop = () => {};

  test('(+) an item with an fk carries it as data-fk, on a button and on a link', () => {
    const menu = menuEl('More', [{ text: 'One', run: noop, fk: 'orch-set:g:a' }, { text: 'Two', href: 'https://claude.ai/code/session_x', fk: 'link' }], 'm');
    const [one, two] = itemsOf(menu).map(controlOf);
    assert.equal(one.tag, 'button');
    assert.equal(one.attrs['data-fk'], 'orch-set:g:a');
    assert.equal(two.tag, 'a');
    assert.equal(two.attrs['data-fk'], 'link');
  });

  test('(+) group: true puts the class grp on that item\'s li (a rule above it); the others keep a plain li', () => {
    const lis = itemsOf(menuEl('More', [{ text: 'One', run: noop }, { text: 'Two', run: noop, group: true }], 'm'));
    assert.equal(lis[0].className, '');
    assert.equal(lis[1].className, 'grp');
  });

  test('(+) a reason makes the item aria-disabled with the reason as its title, and a click shows the reason as an error toast and runs nothing', () => {
    let ran = 0;
    const menu = menuEl('More', [{ text: 'Set as orchestrator', run: () => { ran += 1; }, reason: 'Needs tmux. Install it, then check again.' }], 'm');
    const btn = controlOf(itemsOf(menu)[0]);
    assert.equal(btn.attrs['aria-disabled'], 'true');
    assert.equal(btn.attrs.title, 'Needs tmux. Install it, then check again.');
    assert.equal(btn.attrs.disabled, undefined, 'not the disabled attribute: the item stays focusable and clickable');
    btn.fire('click');
    assert.equal(ran, 0);
    const box = globalThis.document.toastBox;
    const t = box.kids.at(-1);
    assert.equal(t.attrs['data-kind'], 'error');
    assert.equal(t.attrs.role, 'alert');
    assert.match(t.textContent, /Needs tmux/);
  });

  test('(−) an item without a reason is not aria-disabled, has no title and runs on click', () => {
    let ran = 0;
    const btn = controlOf(itemsOf(menuEl('More', [{ text: 'Copy', run: () => { ran += 1; } }], 'm'))[0]);
    assert.equal(btn.attrs['aria-disabled'], undefined);
    assert.equal(btn.attrs.title, undefined);
    assert.equal(btn.attrs['data-fk'], undefined);
    btn.fire('click');
    assert.equal(ran, 1);
  });

  test('(−) a null or empty reason is no reason', () => {
    for (const reason of [null, undefined, '']) {
      const btn = controlOf(itemsOf(menuEl('More', [{ text: 'Copy', run: () => {}, reason }], 'm'))[0]);
      assert.equal(btn.attrs['aria-disabled'], undefined, String(reason));
    }
  });
});

// ---- roleTagEl (design section 1.1) ----------------------------------------------------------------------------------------------

describe('roleTagEl: the badge markup', () => {
  test('(+) main: span.tag with the full word in .tag-l and the short word, hidden from screen readers, in .tag-s', () => {
    const t = roleTagEl('main');
    assert.equal(t.tag, 'span');
    assert.equal(t.className, 'tag');
    assert.equal(t.attrs.title, 'orchestrator');
    assert.equal(t.kids[0].className, 'tag-l');
    assert.equal(t.kids[0].textContent, 'orchestrator');
    assert.equal(t.kids[1].className, 'tag-s');
    assert.equal(t.kids[1].textContent, 'orch');
    assert.equal(t.kids[1].attrs['aria-hidden'], 'true');
    assert.equal(t.accName, 'orchestrator', 'a screen reader reads the long word once');
  });

  test('(+) sub has its own class and words; saved is the muted tag with the resume hint as its title', () => {
    const sub = roleTagEl('sub');
    assert.equal(sub.className, 'tag sub');
    assert.equal(sub.kids[0].textContent, 'sub-orchestrator');
    assert.equal(sub.kids[1].textContent, 'sub-orch');
    assert.equal(sub.attrs.title, 'sub-orchestrator');
    const saved = roleTagEl('saved');
    assert.equal(saved.className, 'tag muted');
    assert.equal(saved.kids[0].textContent, 'orchestrator');
    assert.equal(saved.attrs.title, "Saved orchestrator. Resume it from the header or this row's menu.");
  });

  test('(−) null, an unknown kind and names off the prototype give no element', () => {
    for (const k of [null, undefined, '', 'agent', '__proto__', 'constructor', 'toString', 7]) assert.equal(roleTagEl(k), null, String(k));
  });
});

// ---- rowEl in app.js: the badge and the row hook (design sections 0 and 1.1) -------------------------------------------------------

const APP = code(read('app.js'));
/** Source of the top-level function that starts with `head`, up to its closing brace at column 0. */
const fn = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} exists`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
};
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const KEY = '0123456789abcdef';
const SHAPE = { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, pane: /^%\d{1,6}$/, key: /^[a-z0-9]{16}$/, claudeUrl: /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{1,64}$/ };

function rowRig({ isApp = true, rowItems = undefined } = {}) {
  const seen = [];
  const hooks = rowItems === undefined ? {} : { rowItems: (...args) => { seen.push(args); return rowItems; } };
  const ctx = {
    h, roleTag, roleTagEl, menuEl, hooks, SHAPE, sessionHref, isApp,
    state: { modes: { map: {} } }, document: { getSelection: () => ({ isCollapsed: true }) }, location: {},
    sOf: (a) => (a.live ? 'idle' : 'ended'), rowMode: () => null, canEndRow: () => true, endedText: () => 'Ended', reasonOf: () => '', endedScope: (s) => `${s}-e`,
    statusEl: () => new El('span'), modeEl: () => new El('span'), modelEl: () => new El('span'), timeEl: () => new El('span'),
    copyText: () => {}, showReport: () => {}, focusPane: () => {}, endSession: () => {},
  };
  const rowEl = vm.runInNewContext(`${fn(APP, 'function rowEl(')}; rowEl`, ctx);
  return { rowEl, seen };
}
const agent = (over = {}) => ({ id: ID, name: 'planner', live: true, role: null, pane: { id: '%3' }, resumeCmd: 'claude --resume x', lastActivity: 1, subagents: [], ...over });
const grp = (over = {}) => ({ key: KEY, label: 'demo-api', project: { key: KEY, name: 'demo-api' }, agents: [], ...over });
const menuTexts = (li) => li.all((n) => n.tag === 'li' && n.parent?.className === 'menu').map((n) => n.textContent);
const tagOf = (li) => li.all((n) => n.className.split(' ').includes('tag'))[0] ?? null;

describe('rowEl: the role badge', () => {
  test('(+) a live main orchestrator shows the orchestrator badge; a depth-2 one shows sub-orchestrator', () => {
    const { rowEl } = rowRig();
    const main = tagOf(rowEl(agent({ role: 'orchestrator' }), grp(), { scope: 'g:k' }));
    assert.equal(main.className, 'tag');
    assert.equal(main.kids[0].textContent, 'orchestrator');
    const sub = tagOf(rowEl(agent({ role: 'orchestrator', depth: 2 }), grp(), { scope: 'g:k' }));
    assert.equal(sub.className, 'tag sub');
  });

  test('(+) an ended session that is the project\'s saved orchestrator shows the muted saved badge (app tier)', () => {
    const { rowEl } = rowRig();
    const g = grp({ project: { key: KEY, name: 'demo-api', orchestrator: { sessionId: ID, state: 'ended', name: 'planner', pane: null } } });
    const t = tagOf(rowEl(agent({ live: false, pane: null }), g, { scope: 'g:k' }));
    assert.equal(t.className, 'tag muted');
    assert.match(t.attrs.title, /^Saved orchestrator\./);
  });

  test('(−) the saved badge never shows on the browser tier (no project list there), nor on another session, an agent or an untagged live one', () => {
    const pick = { key: KEY, name: 'demo-api', orchestrator: { sessionId: ID, state: 'ended', name: 'planner', pane: null } };
    const browser = rowRig({ isApp: false }).rowEl;
    assert.equal(tagOf(browser(agent({ live: false, pane: null }), grp({ project: null }), { scope: 'g:k' })), null);
    const { rowEl } = rowRig();
    assert.equal(tagOf(rowEl(agent({ live: false, id: ID2, pane: null }), grp({ project: pick }), { scope: 'g:k' })), null, 'another ended session');
    assert.equal(tagOf(rowEl(agent({ role: 'agent' }), grp(), { scope: 'g:k' })), null, 'an agent');
    assert.equal(tagOf(rowEl(agent(), grp(), { scope: 'g:k' })), null, 'an untagged live session');
  });

  test('(+) the browser tier still shows main and sub (they come from tmux tags)', () => {
    const { rowEl } = rowRig({ isApp: false });
    assert.equal(tagOf(rowEl(agent({ role: 'orchestrator' }), grp({ project: null }), { scope: 'g:k' })).className, 'tag');
    assert.equal(tagOf(rowEl(agent({ role: 'orchestrator', depth: 2 }), grp({ project: null }), { scope: 'g:k' })).className, 'tag sub');
  });
});

describe('rowEl: hooks.rowItems', () => {
  const copy = 'Copy resume command';
  test('(+) the hook is asked with the agent, the group and the scope; its items come before End session, the first with a rule above it, and End gets a rule too', () => {
    const run = () => {};
    const { rowEl, seen } = rowRig({ rowItems: [{ text: 'Set as orchestrator', run, fk: 'orch-set:g:k:x' }, { text: 'Stop using as orchestrator', run }] });
    const a = agent();
    const g = grp();
    const li = rowEl(a, g, { scope: 'g:k' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], a);
    assert.equal(seen[0][1], g);
    assert.equal(seen[0][2], 'g:k');
    assert.deepEqual(menuTexts(li), [copy, 'Focus pane %3 in tmux', 'Set as orchestrator', 'Stop using as orchestrator', 'End session…']);
    const lis = li.all((n) => n.tag === 'li' && n.parent?.className === 'menu');
    assert.deepEqual(lis.map((n) => n.className), ['', '', 'grp', '', 'grp']);
  });

  test('(−) no hook, an empty list, or the browser tier: the menu is as before, with no rule above End', () => {
    for (const rig of [rowRig(), rowRig({ rowItems: [] })]) {
      const li = rig.rowEl(agent(), grp(), { scope: 'g:k' });
      assert.deepEqual(menuTexts(li), [copy, 'Focus pane %3 in tmux', 'End session…']);
      assert.ok(li.all((n) => n.className === 'grp').length === 0);
    }
    const browser = rowRig({ isApp: false, rowItems: [{ text: 'Set as orchestrator', run: () => {} }] });
    const li = browser.rowEl(agent(), grp({ project: null }), { scope: 'g:k' });
    assert.deepEqual(menuTexts(li), [copy, 'Focus pane %3 in tmux']);
    assert.equal(browser.seen.length, 0, 'the hook is not even asked');
  });
});

// ---- project.js: header button, row items, Set / Resume / Stop using, the gone alert (design sections 1.2 to 1.5) --------------------

const PROJECT_SRC = code(read('project.js')).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
const URL_PICK = `/api/app/projects/${KEY}/orchestrator`;
const OFFLINE = 'Offline. nika is reconnecting.';
const NO_TMUX = 'Needs tmux. Install it, then check again.';
const NO_TMUX_COPY = "This session isn't running in tmux, so nika can't make it the orchestrator. End it, then use Resume as orchestrator.";

/** `answers`: { 'METHOD url': response | (opts) => response | Promise }. A request nobody answers throws (the page then says "Could not reach"). */
function flowRig({ project = {}, agents = [], answers = {}, me = { tmux: true, claude: true }, error = null } = {}) {
  const proj = { key: KEY, dir: '/work/demo-api', name: 'demo-api', rules: { state: 'nika' }, orchestrator: null, ...project };
  const g = { key: KEY, label: 'demo-api', project: proj, agents };
  const calls = [];
  const toastLog = [];
  const navs = [];
  const renders = [];
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, new El(sel === '#proj-h' ? 'h1' : 'div'));
    return nodes.get(sel);
  };
  const state = { error, me, projects: [proj], settings: { limits: { maxAgents: 3 }, permissionMode: 'default', panePlacement: 'beside' }, modes: { map: {}, misses: 0 }, route: { name: 'project', key: KEY }, open: new Set(), expanded: new Set(), plugins: null, showEnded: false, models: null };
  const appFetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ method, url, json: opts.json === undefined ? undefined : plain(opts.json) });
    const key = `${method} ${url}`;
    if (key === 'GET /api/app/projects') return { status: 200, body: { projects: [proj] } };
    if (key === 'GET /api/app/me') return { status: 200, body: me };
    if (key === 'GET /api/app/modes') return { status: 404, body: null };
    const a = answers[key];
    if (a === undefined) throw new Error(`down: ${key}`);
    return typeof a === 'function' ? a(opts) : a;
  };
  const ctx = {
    h, icon, $: node, state, hooks: {}, appFetch, menuEl, sessionHref, roleTag, orchState, savedPick, otherRunning, parseModes, modesAfter,
    pluginView, pluginSave, sortIds, countText, filterNote,
    location: { set href(v) { navs.push(v); }, get href() { return ''; }, hash: '' },
    document: { title: '' },
    toast: (msg, o) => {
      const t = { msg, kind: o?.kind ?? 'info', ms: o?.ms, spin: Boolean(o?.spin), action: o?.action, removed: false, remove() { this.removed = true; } };
      toastLog.push(t);
      return t;
    },
    announce: () => {}, errText: (r) => r?.body?.message ?? `The server answered ${r?.status}.`, copyText: () => {}, setBusy: () => {}, openDialog: () => {},
    render: (force) => renders.push(force), buildGroups: () => [g], agentNodes: () => [new El('ul')], swap: (host, list) => host.replaceChildren(...list), interacting: () => false,
    rulesEl: () => new El('span'), setTimeout, clearTimeout, AbortController, TextEncoder, window: { addEventListener: () => {} },
  };
  const api = vm.runInNewContext(`${PROJECT_SRC}\n({ groupActions, rowItems, startOrchestrator, setPick, forgetPick, renderProject })`, ctx);
  return { api, ctx, g, proj, state, calls, toastLog, navs, renders, node, settle,
    texts: () => toastLog.map((t) => t.msg),
    last: () => toastLog.at(-1),
    writes: () => calls.filter((c) => c.method !== 'GET' || !c.url.startsWith('/api/app/')).filter((c) => !['/api/app/projects', '/api/app/me', '/api/app/modes'].includes(c.url)) };
}

const orchRow = (over = {}) => ({ id: ID, name: 'planner', live: true, role: 'orchestrator', pane: { id: '%3', command: 'claude' }, lastActivity: 5, ...over });
const pick = (state, over = {}) => ({ sessionId: ID, state, name: 'planner', pane: state === 'live' ? '%3' : null, ...over });
const iconOf = (btn) => btn.all((n) => n.tag === 'use')[0]?.attrs.href;
const labelOf = (btn) => btn.all(withClass('lbl'))[0]?.textContent;

describe('groupActions: the first button follows the orchestrator state (design 1.3)', () => {
  test('(+) none: Start orchestrator, with the play icon and its own fk, primary when asked', () => {
    const r = flowRig();
    const [btn] = r.api.groupActions(r.g, { primary: true });
    assert.equal(labelOf(btn), 'Start orchestrator');
    assert.equal(iconOf(btn), '#i-play');
    assert.equal(btn.attrs['data-fk'], `start:${KEY}`);
    assert.equal(btn.attrs.title, 'Start orchestrator');
    assert.ok(withClass('primary')(btn));
    assert.ok(!withClass('primary')(r.api.groupActions(r.g, { primary: 'spawn' })[0]), 'Spawn agent is the primary one on the project page');
  });

  test('(+) live: an Open orchestrator link to the session window, titled with the name', () => {
    const r = flowRig({ agents: [orchRow()], project: { orchestrator: pick('live') } });
    const [a] = r.api.groupActions(r.g, {});
    assert.equal(a.tag, 'a');
    assert.equal(labelOf(a), 'Open orchestrator');
    assert.equal(iconOf(a), '#i-term');
    assert.equal(a.attrs['data-fk'], `orch:${KEY}`);
    assert.equal(a.attrs.title, 'Open planner');
    assert.equal(a.attrs.href, `session.html?session=${ID}&pane=%253&project=${KEY}`);
  });

  test('(+) ended: Resume orchestrator with the resume icon, titled "Resume <name> in tmux", primary like Start', () => {
    const r = flowRig({ project: { orchestrator: pick('ended') } });
    const [btn] = r.api.groupActions(r.g, { primary: true });
    assert.equal(btn.tag, 'button');
    assert.equal(labelOf(btn), 'Resume orchestrator');
    assert.equal(iconOf(btn), '#i-resume');
    assert.equal(btn.attrs['data-fk'], `resume:${KEY}`);
    assert.equal(btn.attrs.title, 'Resume planner in tmux');
    assert.ok(withClass('primary')(btn));
    assert.equal(btn.attrs['aria-disabled'], undefined);
  });

  test('(+) gone: Start orchestrator whose title says the saved one is gone', () => {
    const r = flowRig({ project: { orchestrator: pick('gone', { name: null }) } });
    const [btn] = r.api.groupActions(r.g, {});
    assert.equal(labelOf(btn), 'Start orchestrator');
    assert.equal(btn.attrs['data-fk'], `start:${KEY}`);
    assert.equal(btn.attrs.title, 'The saved orchestrator is gone. Starts a new one.');
  });

  test('(−) a sub-orchestrator alone is not "the orchestrator": the button is Start; a nameless saved one titles "Resume the saved session in tmux"', () => {
    const r = flowRig({ agents: [orchRow({ depth: 2 })] });
    assert.equal(labelOf(r.api.groupActions(r.g, {})[0]), 'Start orchestrator');
    const n = flowRig({ project: { orchestrator: pick('ended', { name: null }) } });
    assert.equal(n.api.groupActions(n.g, {})[0].attrs.title, 'Resume the saved session in tmux');
  });

  test('(−) offline or without tmux: Start and Resume are aria-disabled with the reason, and a click starts nothing', async () => {
    for (const [over, why] of [[{ error: 'down' }, OFFLINE], [{ me: { tmux: false, claude: true } }, NO_TMUX]]) {
      for (const project of [{}, { orchestrator: pick('ended') }]) {
        const r = flowRig({ ...over, project });
        const [btn] = r.api.groupActions(r.g, {});
        assert.equal(btn.attrs['aria-disabled'], 'true');
        assert.equal(btn.attrs.title, why);
        btn.click();
        await settle();
        assert.equal(r.calls.length, 0, 'no request');
        assert.deepEqual([r.last().kind, r.last().msg], ['error', why]);
      }
    }
  });

  test('(−) an unregistered group offers only Add project (no orchestrator button)', () => {
    const r = flowRig();
    const out = r.api.groupActions({ ...r.g, project: null }, {});
    assert.equal(out.length, 1);
    assert.equal(out[0].attrs['data-fk'], `add:${KEY}`);
  });
});

describe('start and resume from the header', () => {
  const START = 'POST /api/app/orchestrator/start';
  const ok = { status: 200, body: { sessionId: ID, pane: '%3', created: true } };

  test('(+) Start posts the project key, shows a spinner toast while it runs, removes it and opens the session window', async () => {
    const r = flowRig({ answers: { [START]: ok } });
    const p = r.api.startOrchestrator(r.proj);
    assert.deepEqual([r.last().msg, r.last().ms, r.last().spin], ['Starting the orchestrator for demo-api…', 0, true]);
    await p;
    assert.deepEqual(r.writes(), [{ method: 'POST', url: '/api/app/orchestrator/start', json: { project: KEY } }]);
    assert.equal(r.last().removed, true);
    assert.deepEqual(r.navs, [`session.html?session=${ID}&pane=%253&project=${KEY}`]);
  });

  test('(+) Resume posts the same request, with its own spinner toast naming the session and the project', async () => {
    const r = flowRig({ answers: { [START]: ok } });
    const p = r.api.startOrchestrator(r.proj, { resume: { name: 'planner' } });
    assert.equal(r.last().msg, 'Resuming planner as the orchestrator for demo-api…');
    await p;
    assert.deepEqual(r.writes().map((c) => [c.method, c.url, c.json]), [['POST', '/api/app/orchestrator/start', { project: KEY }]]);
    assert.equal(r.navs.length, 1);
  });

  test('(+) a nameless session reads "the saved session", and a long name is cut at 40 characters', async () => {
    const r = flowRig({ answers: { [START]: ok } });
    r.api.startOrchestrator(r.proj, { resume: { name: null } });
    assert.equal(r.last().msg, 'Resuming the saved session as the orchestrator for demo-api…');
    await settle();
    const long = flowRig({ answers: { [START]: ok } });
    long.api.startOrchestrator(long.proj, { resume: { name: 'n'.repeat(60) } });
    assert.equal(long.last().msg, `Resuming ${'n'.repeat(39)}… as the orchestrator for demo-api…`);
    await settle();
  });

  test('(+) a start that answers cleared: "gone" says so in a toast and still opens the session window', async () => {
    const r = flowRig({ answers: { [START]: { status: 200, body: { ...ok.body, cleared: 'gone' } } } });
    await r.api.startOrchestrator(r.proj);
    assert.ok(r.texts().includes('Started a new orchestrator. The saved one was gone.'));
    assert.equal(r.toastLog.find((t) => t.msg.startsWith('Started a new')).kind, 'info');
    assert.equal(r.navs.length, 1);
  });

  test('(+) with no usable link the toast says what happened', async () => {
    const r = flowRig({ answers: { [START]: { status: 200, body: { sessionId: null, pane: null } } } });
    await r.api.startOrchestrator(r.proj);
    assert.equal(r.last().msg, 'Started the orchestrator for demo-api.');
    const s = flowRig({ answers: { [START]: { status: 200, body: { sessionId: null, pane: null } } } });
    await s.api.startOrchestrator(s.proj, { resume: { name: 'planner' } });
    assert.equal(s.last().msg, 'Resumed planner as the orchestrator for demo-api.');
    assert.equal(s.navs.length, 0);
  });

  test('(−) a second press while one runs does nothing; after it ends a new one works', async () => {
    let release;
    const r = flowRig({ answers: { [START]: () => new Promise((res) => { release = () => res(ok); }) } });
    const first = r.api.startOrchestrator(r.proj);
    await r.api.startOrchestrator(r.proj);
    await r.api.startOrchestrator(r.proj, { resume: { name: 'planner' } });
    assert.equal(r.writes().length, 1);
    release();
    await first;
    r.navs.length = 0;
    r.api.startOrchestrator(r.proj);
    assert.equal(r.writes().length, 2, 'the flag was released');
    release();
    await settle();
  });

  test('(−) a refusal shows the server message and releases the flag; a network failure says it could not reach the server', async () => {
    const r = flowRig({ answers: { [START]: { status: 409, body: { error: 'limit', message: 'Already running.' } } } });
    await r.api.startOrchestrator(r.proj);
    assert.deepEqual([r.last().kind, r.last().msg, r.last().removed], ['error', 'Already running.', false]);
    assert.ok(r.toastLog[0].removed, 'the spinner is gone');
    assert.equal(r.navs.length, 0);
    const down = flowRig({ answers: {} });
    await down.api.startOrchestrator(down.proj);
    assert.deepEqual([down.last().kind, down.last().msg], ['error', 'Could not reach the nika server.']);
  });
});

describe('rowItems: the row menu matrix (design 1.2)', () => {
  const texts = (items) => Array.from(items, (i) => i.text);
  const items = (a, over = {}) => { const r = flowRig({ agents: [a], ...over }); return { r, out: r.api.rowItems(a, r.g, 'g:k') }; };
  const SET = 'Set as orchestrator';
  const RESUME = 'Resume as orchestrator';
  const STOP = 'Stop using as orchestrator';

  test('(+) live main orchestrator that is the pick: Stop only', () => {
    assert.deepEqual(texts(items(orchRow(), { project: { orchestrator: pick('live') } }).out), [STOP]);
  });

  test('(+) live main orchestrator that is not the pick (a 0.3 pane): Set only', () => {
    assert.deepEqual(texts(items(orchRow()).out), [SET]);
    assert.deepEqual(texts(items(orchRow(), { project: { orchestrator: pick('ended', { sessionId: ID2 }) } }).out), [SET]);
  });

  test('(+) live session without a nika role, in tmux: Set; with no pane: Set, disabled with the tmux reason (R2)', () => {
    const plain = { id: ID, name: 'scratch', live: true, role: null, pane: { id: '%4', command: 'claude' } };
    const { out } = items(plain);
    assert.deepEqual(texts(out), [SET]);
    assert.equal(out[0].reason, null);
    const none = items({ ...plain, pane: null }).out;
    assert.deepEqual(texts(none), [SET]);
    assert.equal(none[0].reason, "This session isn't running in tmux, so nika can't make it the orchestrator. End it, then use Resume as orchestrator.");
  });

  test('(+) ended and the pick: Resume and Stop; ended and not the pick: Set and Resume (a pick elsewhere or none)', () => {
    const ended = { id: ID, name: 'planner', live: false, role: null, pane: null };
    assert.deepEqual(texts(items(ended, { project: { orchestrator: pick('ended') } }).out), [RESUME, STOP]);
    assert.deepEqual(texts(items(ended).out), [SET, RESUME]);
    assert.deepEqual(texts(items(ended, { project: { orchestrator: pick('ended', { sessionId: ID2 }) } }).out), [SET, RESUME]);
  });

  test('(+) each item has its own fk, <kind>:<scope>:<id>', () => {
    const ended = { id: ID, name: 'planner', live: false, role: null, pane: null };
    assert.deepEqual(Array.from(items(ended, { project: { orchestrator: pick('ended') } }).out, (i) => i.fk), [`orch-resume:g:k:${ID}`, `orch-stop:g:k:${ID}`]);
    assert.deepEqual(Array.from(items(ended).out, (i) => i.fk), [`orch-set:g:k:${ID}`, `orch-resume:g:k:${ID}`]);
  });

  test('(−) a live sub-orchestrator, a live nika agent or a live row with an odd role: no items', () => {
    assert.deepEqual(plain(items(orchRow({ depth: 2 })).out), []);
    assert.deepEqual(plain(items(orchRow({ role: 'agent' })).out), []);
    assert.deepEqual(plain(items(orchRow({ role: 'something-else' })).out), []);
  });

  test('(−) an unregistered group gets none', () => {
    const r = flowRig({ agents: [orchRow()] });
    assert.deepEqual(plain(r.api.rowItems(orchRow(), { ...r.g, project: null }, 'g:k')), []);
  });

  test('(−) R1: while another orchestrator runs, Set and Resume on this session are disabled with its name; Stop is not', () => {
    const other = orchRow({ id: ID2, name: 'api-lead' });
    const ended = { id: ID, name: 'planner', live: false, role: null, pane: null };
    const r = flowRig({ agents: [other, ended], project: { orchestrator: pick('ended') } });
    const out = r.api.rowItems(ended, r.g, 'g:k');
    assert.deepEqual(texts(out), [RESUME, STOP]);
    assert.equal(out[0].reason, "api-lead is running as this project's orchestrator. End it first, then choose another.");
    assert.equal(out[1].reason, null);
    const r2 = flowRig({ agents: [orchRow({ id: ID2, name: null }), ended] });
    assert.equal(r2.api.rowItems(ended, r2.g, 'g:k')[0].reason, "Another session is running as this project's orchestrator. End it first, then choose another.");
  });

  test('(−) R1 also holds with two main orchestrators live (a 0.3 leftover): Set is off on both', () => {
    const one = orchRow({ id: ID, name: 'planner' });
    const two = orchRow({ id: ID2, name: 'api-lead' });
    const r = flowRig({ agents: [one, two] });
    assert.match(r.api.rowItems(one, r.g, 'g:k')[0].reason, /^api-lead is running/);
    assert.match(r.api.rowItems(two, r.g, 'g:k')[0].reason, /^planner is running/);
  });

  test('(−) R0: offline turns every item off with the offline reason; Resume and a live Set also need tmux, an ended Set and Stop need only the server', () => {
    const ended = { id: ID, name: 'planner', live: false, role: null, pane: null };
    const off = items(ended, { project: { orchestrator: pick('ended') }, error: 'down' }).out;
    assert.deepEqual(Array.from(off, (i) => i.reason), [OFFLINE, OFFLINE]);
    const noTmux = items(ended, { project: { orchestrator: pick('ended') }, me: { tmux: false, claude: true } }).out;
    assert.deepEqual(Array.from(noTmux, (i) => [i.text, i.reason]), [[RESUME, NO_TMUX], [STOP, null]]);
    const endedSet = items(ended, { me: { tmux: false, claude: true } }).out;
    assert.deepEqual(Array.from(endedSet, (i) => [i.text, i.reason]), [[SET, null], [RESUME, NO_TMUX]]);
    const liveSet = items({ id: ID, name: 's', live: true, role: null, pane: { id: '%4', command: 'claude' } }, { me: { tmux: false, claude: true } }).out;
    assert.equal(liveSet[0].reason, NO_TMUX);
  });
});

describe('Set as orchestrator (PUT) and its toasts (design 1.5)', () => {
  const PUT = `PUT ${URL_PICK}`;
  const liveRow = { id: ID, name: 'scratch', live: true, role: null, pane: { id: '%4', command: 'claude' } };
  const endedRow = { id: ID, name: 'planner', live: false, role: null, pane: null };
  const put = (state) => ({ status: 200, body: { orchestrator: { sessionId: ID, state, name: 'x', pane: state === 'live' ? '%4' : null } } });

  test('(+) a live session: PUT the id, toast "now the orchestrator" with an Open action to its session window, spinner removed, list refreshed', async () => {
    const r = flowRig({ agents: [liveRow], answers: { [PUT]: put('live') } });
    await r.api.setPick(liveRow, r.g);
    assert.deepEqual(r.writes(), [{ method: 'PUT', url: URL_PICK, json: { sessionId: ID } }]);
    assert.deepEqual([r.toastLog[0].msg, r.toastLog[0].ms, r.toastLog[0].spin, r.toastLog[0].removed], ['Saving…', 0, true, true]);
    const t = r.last();
    assert.equal(t.msg, 'scratch is now the orchestrator for demo-api.');
    assert.equal(t.action.label, 'Open');
    t.action.run();
    assert.deepEqual(r.navs, [`session.html?session=${ID}&pane=%254&project=${KEY}`]);
    assert.deepEqual(r.renders, [true]);
    assert.ok(r.calls.some((c) => c.url === '/api/app/projects'), 'the project list is read again');
  });

  test('(+) an ended session: the toast says to resume it from the header, with a Resume now action that posts the start request', async () => {
    const r = flowRig({ agents: [endedRow], answers: { [PUT]: put('ended'), 'POST /api/app/orchestrator/start': { status: 200, body: { sessionId: ID, pane: '%5' } } } });
    await r.api.setPick(endedRow, r.g);
    const t = r.last();
    assert.equal(t.msg, 'planner is the orchestrator for demo-api. Resume it from the header when you need it.');
    assert.equal(t.action.label, 'Resume now');
    t.action.run();
    await settle();
    assert.equal(r.toastLog.find((x) => x.spin && x.msg.startsWith('Resuming')).msg, 'Resuming planner as the orchestrator for demo-api…');
    assert.deepEqual(r.writes().map((c) => `${c.method} ${c.url}`), [`PUT ${URL_PICK}`, 'POST /api/app/orchestrator/start']);
    assert.equal(r.navs.length, 1);
  });

  test('(+) replacing a saved orchestrator names the old one before the full stop', async () => {
    const live = flowRig({ agents: [liveRow], project: { orchestrator: pick('ended', { sessionId: ID2, name: 'old-lead' }) }, answers: { [PUT]: put('live') } });
    await live.api.setPick(liveRow, live.g);
    assert.equal(live.last().msg, 'scratch is now the orchestrator for demo-api (was old-lead).');
    const ended = flowRig({ agents: [endedRow], project: { orchestrator: pick('gone', { sessionId: ID2, name: null }) }, answers: { [PUT]: put('ended') } });
    await ended.api.setPick(endedRow, ended.g);
    assert.equal(ended.last().msg, 'planner is the orchestrator for demo-api (was the saved session). Resume it from the header when you need it.');
  });

  test('(+) the server\'s answer decides live or ended when it differs from the row (the session ended in between)', async () => {
    const r = flowRig({ agents: [liveRow], answers: { [PUT]: put('ended') } });
    await r.api.setPick(liveRow, r.g);
    assert.match(r.last().msg, /Resume it from the header/);
  });

  test('(−) each refusal shows its fixed copy as an error toast, refreshes nothing and releases the busy flag', async () => {
    const cases = [
      [404, 'not_found', "nika can't find that session any more. Its transcript may have been deleted. Nothing changed."],
      [409, 'other_project', "That session belongs to another project, so it can't be this project's orchestrator. Nothing changed."],
      [409, 'no_pane', NO_TMUX_COPY],
      [409, 'orchestrator_running', "Another session is running as this project's orchestrator. End it first, then choose another."],
    ];
    for (const [status, error, copy] of cases) {
      const r = flowRig({ agents: [liveRow], answers: { [PUT]: { status, body: { error, message: 'server words' } } } });
      await r.api.setPick(liveRow, r.g);
      assert.deepEqual([r.last().kind, r.last().msg], ['error', copy], error);
      assert.deepEqual(r.renders, []);
      assert.equal(r.calls.length, 1, 'no list read after a refusal');
      await r.api.setPick(liveRow, r.g);
      assert.equal(r.calls.length, 2, 'the flag was released');
    }
  });

  test('(−) the running orchestrator is named in the orchestrator_running copy; agent_session and unknown codes show the server\'s own message', async () => {
    const other = orchRow({ id: ID2, name: 'api-lead' });
    const r = flowRig({ agents: [liveRow, other], answers: { [PUT]: { status: 409, body: { error: 'orchestrator_running', message: 'x' } } } });
    await r.api.setPick(liveRow, r.g);
    assert.equal(r.last().msg, "api-lead is running as this project's orchestrator. End it first, then choose another.");
    const a = flowRig({ agents: [liveRow], answers: { [PUT]: { status: 409, body: { error: 'agent_session', message: "That session is an agent nika started, so it can't be the orchestrator. Nothing changed." } } } });
    await a.api.setPick(liveRow, a.g);
    assert.equal(a.last().msg, "That session is an agent nika started, so it can't be the orchestrator. Nothing changed.");
    const odd = flowRig({ agents: [liveRow], answers: { [PUT]: { status: 409, body: { error: '__proto__', message: 'plain words' } } } });
    await odd.api.setPick(liveRow, odd.g);
    assert.equal(odd.last().msg, 'plain words');
  });

  test('(−) a network failure says it could not reach the server; a second press while one runs does nothing', async () => {
    const down = flowRig({ agents: [liveRow], answers: {} });
    await down.api.setPick(liveRow, down.g);
    assert.deepEqual([down.last().kind, down.last().msg], ['error', 'Could not reach the nika server.']);
    let release;
    const r = flowRig({ agents: [liveRow], answers: { [PUT]: () => new Promise((res) => { release = () => res(put('live')); }) } });
    const first = r.api.setPick(liveRow, r.g);
    await r.api.setPick(liveRow, r.g);
    await r.api.forgetPick(r.proj, pick('live'));
    assert.equal(r.writes().length, 1, 'neither a second Set nor a Stop ran');
    release();
    await first;
  });
});

describe('Resume as orchestrator from a row', () => {
  const PUT = `PUT ${URL_PICK}`;
  const START = 'POST /api/app/orchestrator/start';
  const endedRow = { id: ID, name: 'planner', live: false, role: null, pane: null };
  const ok = { status: 200, body: { sessionId: ID, pane: '%5' } };
  const put = { status: 200, body: { orchestrator: { sessionId: ID, state: 'ended', name: 'planner', pane: null } } };
  const click = async (r, a, text) => { r.api.rowItems(a, r.g, 'g:k').find((i) => i.text === text).run(); await settle(); };

  test('(+) a session that is not the saved one yet: PUT, then the start request, then the session window opens', async () => {
    const r = flowRig({ agents: [endedRow], answers: { [PUT]: put, [START]: ok } });
    await click(r, endedRow, 'Resume as orchestrator');
    assert.deepEqual(r.writes().map((c) => [c.method, c.url, c.json]), [['PUT', URL_PICK, { sessionId: ID }], ['POST', '/api/app/orchestrator/start', { project: KEY }]]);
    assert.equal(r.toastLog[0].msg, 'Resuming planner as the orchestrator for demo-api…');
    assert.equal(r.navs.length, 1);
  });

  test('(+) the saved one itself: only the start request (the pick is already stored)', async () => {
    const r = flowRig({ agents: [endedRow], project: { orchestrator: pick('ended') }, answers: { [START]: ok } });
    await click(r, endedRow, 'Resume as orchestrator');
    assert.deepEqual(r.writes().map((c) => `${c.method} ${c.url}`), ['POST /api/app/orchestrator/start']);
  });

  test('(−) the PUT is refused: its fixed copy, and no start request', async () => {
    const r = flowRig({ agents: [endedRow], answers: { [PUT]: { status: 404, body: { error: 'not_found', message: 'm' } }, [START]: ok } });
    await click(r, endedRow, 'Resume as orchestrator');
    assert.equal(r.last().msg, "nika can't find that session any more. Its transcript may have been deleted. Nothing changed.");
    assert.deepEqual(r.writes().map((c) => c.method), ['PUT']);
    assert.equal(r.navs.length, 0);
  });

  test('(−) the PUT works but the start fails: the toast says it is saved and points at the header, and the list is read again', async () => {
    const r = flowRig({ agents: [endedRow], answers: { [PUT]: put, [START]: { status: 503, body: { error: 'tmux', message: 'tmux is not answering.' } } } });
    await click(r, endedRow, 'Resume as orchestrator');
    assert.deepEqual([r.last().kind, r.last().msg], ['error', "planner is saved as the orchestrator, but it didn't start: tmux is not answering. Try Resume orchestrator in the header."]);
    assert.deepEqual(r.renders, [true]);
  });

  test('(−) R1 refusal at the server (another orchestrator started in between) names the one that runs', async () => {
    const r = flowRig({ agents: [endedRow, orchRow({ id: ID2, name: 'api-lead' })], answers: { [PUT]: { status: 409, body: { error: 'orchestrator_running', message: 'm' } } } });
    // the menu would be disabled; call the run function anyway, as a stale menu could
    r.api.rowItems(endedRow, r.g, 'g:k').find((i) => i.text === 'Resume as orchestrator').run();
    await settle();
    assert.equal(r.last().msg, "api-lead is running as this project's orchestrator. End it first, then choose another.");
  });
});

describe('Stop using as orchestrator (DELETE) and the header menu item', () => {
  const DEL = `DELETE ${URL_PICK}`;
  const del = { status: 200, body: { orchestrator: null } };

  test('(+) a live pick: DELETE, and the toast says it keeps running', async () => {
    const r = flowRig({ project: { orchestrator: pick('live') }, answers: { [DEL]: del } });
    await r.api.forgetPick(r.proj, pick('live'));
    assert.deepEqual(r.writes(), [{ method: 'DELETE', url: URL_PICK, json: undefined }]);
    assert.equal(r.last().msg, 'planner is no longer the saved orchestrator. It keeps running until you end it.');
    assert.deepEqual(r.renders, [true]);
  });

  test('(+) an ended or gone pick: the project has no saved orchestrator now', async () => {
    for (const st of ['ended', 'gone']) {
      const r = flowRig({ answers: { [DEL]: del } });
      await r.api.forgetPick(r.proj, pick(st));
      assert.equal(r.last().msg, 'demo-api has no saved orchestrator now. Start orchestrator starts a new one.', st);
    }
  });

  test('(+) from the gone alert the focus goes to the page heading afterwards', async () => {
    const r = flowRig({ answers: { [DEL]: del } });
    focus.el = null;
    await r.api.forgetPick(r.proj, pick('gone'), { fromAlert: true });
    assert.equal(focus.el, r.node('#proj-h'));
    focus.el = null;
    await r.api.forgetPick(r.proj, pick('gone'));
    assert.equal(focus.el, null, 'a menu item keeps the focus on the menu button instead');
  });

  test('(−) a refusal or a network failure shows an error toast and changes nothing on the page', async () => {
    const bad = flowRig({ answers: { [DEL]: { status: 404, body: { error: 'not_found', message: 'project is not registered' } } } });
    await bad.api.forgetPick(bad.proj, pick('ended'));
    assert.deepEqual([bad.last().kind, bad.last().msg], ['error', 'project is not registered']);
    assert.deepEqual(bad.renders, []);
    const down = flowRig({ answers: {} });
    await down.api.forgetPick(down.proj, pick('ended'));
    assert.equal(down.last().msg, 'Could not reach the nika server.');
  });

  test('(+) the project header menu offers "Stop using <name> as orchestrator" for a live, ended or gone pick, and nothing without a pick', () => {
    const menuItems = (r) => { r.api.renderProject(true); return r.node('#proj-actions').all((n) => n.tag === 'li').map((n) => n.textContent); };
    const live = flowRig({ agents: [orchRow()], project: { orchestrator: pick('live') } });
    assert.deepEqual(menuItems(live), ['Copy folder path', 'Stop using planner as orchestrator', 'Remove from nika…']);
    assert.equal(live.node('#proj-actions').byFk('orch-stop-proj').tag, 'button');
    assert.deepEqual(menuItems(flowRig({ project: { orchestrator: pick('ended') } })), ['Copy folder path', 'Stop using planner as orchestrator', 'Remove from nika…']);
    assert.deepEqual(menuItems(flowRig({ project: { orchestrator: pick('gone', { name: null }) } })), ['Copy folder path', 'Stop using the saved orchestrator', 'Remove from nika…']);
    assert.deepEqual(menuItems(flowRig({ project: { orchestrator: pick('ended', { name: null }) } })), ['Copy folder path', 'Stop using the saved session as orchestrator', 'Remove from nika…']);
    assert.deepEqual(menuItems(flowRig()), ['Copy folder path', 'Remove from nika…']);
    assert.deepEqual(menuItems(flowRig({ agents: [orchRow()] })), ['Copy folder path', 'Remove from nika…'], 'a 0.3 orchestrator with no pick: nothing to stop');
  });

  test('(−) offline: the header item is aria-disabled with the reason, and clicking it sends nothing', async () => {
    const r = flowRig({ project: { orchestrator: pick('ended') }, error: 'down', answers: { [DEL]: del } });
    r.api.renderProject(true);
    const btn = r.node('#proj-actions').byFk('orch-stop-proj');
    assert.equal(btn.attrs['aria-disabled'], 'true');
    assert.equal(btn.attrs.title, OFFLINE);
    btn.fire('click');
    await settle();
    assert.equal(r.calls.length, 0);
    const shown = globalThis.document.toastBox.kids.at(-1); // menuEl raises its own toast (ui.js)
    assert.deepEqual([shown.attrs['data-kind'], shown.textContent], ['error', OFFLINE]);
  });
});

describe('the gone alert on the project page (design 1.4)', () => {
  const alertOf = (r) => { r.api.renderProject(true); return r.node('#proj-agents').byFk('orch-gone'); };

  test('(+) a gone pick shows the warn alert first in the agents area, with its words, an icon and the "Stop using it" button', () => {
    const r = flowRig({ project: { orchestrator: pick('gone', { name: null }) } });
    const a = alertOf(r);
    assert.ok(a);
    assert.equal(r.node('#proj-agents').kids[0], a, 'before the rows');
    assert.equal(a.className, 'alert');
    assert.equal(a.attrs['data-kind'], 'warn');
    assert.equal(a.attrs.role, undefined, 'state, not an event');
    assert.equal(a.all((n) => n.tag === 'use')[0].attrs.href, '#i-warn');
    assert.equal(a.all((n) => n.tag === 'p')[0].textContent, "The saved orchestrator is gone: its transcript was deleted, so it can't be resumed. Start orchestrator starts a new one.");
    const btn = a.byFk('orch-forget');
    assert.equal(btn.textContent, 'Stop using it');
    assert.ok(withClass('link')(btn));
  });

  test('(+) "Stop using it" sends the DELETE and moves focus to the heading', async () => {
    const r = flowRig({ project: { orchestrator: pick('gone', { name: null }) }, answers: { [`DELETE ${URL_PICK}`]: { status: 200, body: { orchestrator: null } } } });
    alertOf(r).byFk('orch-forget').click();
    await settle();
    assert.deepEqual(r.writes().map((c) => `${c.method} ${c.url}`), [`DELETE ${URL_PICK}`]);
    assert.equal(focus.el, r.node('#proj-h'));
  });

  test('(−) no alert for a live, ended or absent pick, or when the project list has no orchestrator field (an older server)', () => {
    for (const project of [{ orchestrator: pick('live') }, { orchestrator: pick('ended') }, { orchestrator: null }, { orchestrator: undefined }]) {
      assert.equal(alertOf(flowRig({ project })), null, JSON.stringify(project));
    }
  });

  test('(−) a gone pick with a main orchestrator that runs (the snapshot wins) shows no alert', () => {
    assert.equal(alertOf(flowRig({ agents: [orchRow({ id: ID2 })], project: { orchestrator: pick('gone') } })), null);
  });
});

// ---- the session window header (design 1.1 and 6.4) --------------------------------------------------------------------------------

describe('session header: the role badge', () => {
  const SESSION = code(read('session.js'));
  const SESSION_HTML = read('session.html');

  /** renderRole and loadPick as shipped, against a node for #sess-role and recorded requests. */
  function headerRig({ isApp = true, projectKey = KEY, status = 200, projects = [{ key: KEY, orchestrator: { sessionId: ID, state: 'ended', name: 'planner', pane: null } }], throws = false } = {}) {
    const role = new El('span');
    role.hidden = true;
    const calls = [];
    const A = { pickId: null, pickAsked: false };
    const ctx = {
      A, isApp, projectKey, roleTag, roleTagEl, savedPick, $: () => role,
      call: async (url) => { calls.push(url); if (throws) throw new Error('down'); return { status, body: status === 200 ? { projects } : null }; },
    };
    const api = vm.runInNewContext(`${fn(SESSION, 'function renderRole(')}\n${fn(SESSION, 'async function loadPick(')}\n({ renderRole, loadPick })`, ctx);
    return { api, role, calls, A };
  }
  const ended = { id: ID, live: false, role: null };

  test('(+) the header has a hidden #sess-role right after the title and before the status pill', () => {
    const at = (s) => SESSION_HTML.indexOf(s);
    assert.ok(at('id="sess-h"') > 0 && at('id="sess-h"') < at('id="sess-role"') && at('id="sess-role"') < at('id="sess-st"'));
    assert.match(SESSION_HTML, /<span id="sess-role" hidden><\/span>/);
  });

  test('(+) applyAgent draws the badge and asks for the pick', () => {
    const body = fn(SESSION, 'function applyAgent(');
    assert.match(body, /renderRole\(agent\);/);
    assert.match(body, /loadPick\(agent\)\.then\(\(learned\) => \{ if \(learned\) renderRole\(agent\); \}/);
  });

  test('(+) a live orchestrator shows the orchestrator badge, a depth-2 one the sub badge; the element is shown', () => {
    const r = headerRig();
    r.api.renderRole({ id: ID, live: true, role: 'orchestrator' });
    assert.equal(r.role.hidden, false);
    assert.equal(r.role.kids[0].className, 'tag');
    r.api.renderRole({ id: ID, live: true, role: 'orchestrator', depth: 2 });
    assert.equal(r.role.kids[0].className, 'tag sub');
    assert.equal(r.role.kids.length, 1, 'replaced, not appended');
  });

  test('(+) an ended session that is the saved orchestrator: the app tier asks the project list once and shows the muted badge', async () => {
    const r = headerRig();
    await r.api.loadPick(ended);
    assert.deepEqual(r.calls, ['/api/app/projects']);
    assert.equal(r.A.pickId, ID);
    r.api.renderRole(ended);
    assert.equal(r.role.kids[0].className, 'tag muted');
    await r.api.loadPick(ended);
    assert.equal(r.calls.length, 1, 'once per window');
  });

  test('(−) no badge for an agent, an untagged live session, or an ended session that is not the saved one; the element stays hidden', async () => {
    const r = headerRig();
    for (const a of [{ id: ID, live: true, role: 'agent' }, { id: ID, live: true, role: null }, ended]) {
      r.api.renderRole(a);
      assert.equal(r.role.hidden, true, JSON.stringify(a));
      assert.equal(r.role.kids.length, 0);
    }
    await r.api.loadPick({ ...ended, id: ID2 });
    r.api.renderRole({ ...ended, id: ID2 });
    assert.equal(r.role.hidden, true);
  });

  test('(−) no request for a live session, without a project in the address, off the app tier; a failed or odd answer gives no pick', async () => {
    for (const over of [{ isApp: false }, { projectKey: null }]) {
      const r = headerRig(over);
      await r.api.loadPick(ended);
      assert.deepEqual(r.calls, [], JSON.stringify(over));
    }
    const live = headerRig();
    await live.api.loadPick({ id: ID, live: true, role: 'orchestrator' });
    assert.deepEqual(live.calls, []);
    for (const over of [{ status: 500 }, { projects: 'nope' }, { projects: [null, { key: KEY, orchestrator: 'x' }] }, { projects: [{ key: 'other', orchestrator: { sessionId: ID, state: 'ended', name: null, pane: null } }] }]) {
      const r = headerRig(over);
      await r.api.loadPick(ended);
      assert.equal(r.A.pickId, null, JSON.stringify(over));
    }
  });
});

// ---- CSS, sprite and wiring pins -----------------------------------------------------------------------------------------------------

describe('O1 styles, icon and wiring', () => {
  const TOKENS = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const APPCSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const INDEX = read('index.html');
  const PROJECT = code(read('project.js'));
  const appCode = code(read('app.js'));

  test('(+) the badge classes live in tokens.css (the session window loads only that file): .tag, .tag.muted, .tag.sub and the hidden short word', () => {
    assert.match(TOKENS, /\.tag \{[^}]*display: inline-flex[^}]*\}/);
    assert.match(TOKENS, /\.tag\.muted \{[^}]*\}/);
    assert.match(TOKENS, /\.tag\.sub \{[^}]*background: transparent;[^}]*border: 1px solid var\(--accent-line\);[^}]*\}/);
    assert.match(TOKENS, /\.tag \.tag-s \{ display: none; \}/);
  });

  test('(−) app.css no longer defines .tag itself (one definition), and its narrow-rows rule swaps the long word for the short one inside the 860 px container block', () => {
    assert.doesNotMatch(APPCSS, /^\.tag(\.muted)? \{/m);
    const block = /@container rows \(max-width: 860px\) \{([\s\S]*?)\n\}/.exec(APPCSS)?.[1] ?? '';
    assert.match(block, /\.row \.tag \.tag-l \{[^}]*position: absolute;[^}]*clip: rect\(0 0 0 0\)[^}]*\}/, 'clipped, still read by screen readers');
    assert.match(block, /\.row \.tag \.tag-s \{ display: inline; \}/);
  });

  test('(+) menu rules: a rule above a group, and a disabled item that stays visible and says not-allowed', () => {
    assert.match(APPCSS, /\.menu li\.grp \{ border-top: 1px solid var\(--line\); margin-top: 4px; padding-top: 4px; \}/);
    assert.match(APPCSS, /\.menu \[aria-disabled="true"\] \{ opacity: 0\.5; cursor: not-allowed; \}/);
  });

  test('(+) the main page sprite draws the resume icon the header button asks for; every icon project.js names exists', () => {
    assert.match(INDEX, /<symbol id="i-resume" viewBox="0 0 16 16"><path d="M2\.5 8a5\.5 5\.5 0 1 0 1\.6-3\.9M2\.5 2\.5v2\.6h2\.6"\/><path d="M6\.8 5\.9v4\.2L10\.2 8z"\/><\/symbol>/);
    const symbols = new Set([...INDEX.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
    for (const m of PROJECT.matchAll(/\bicon\('([a-z0-9-]+)'\)/g)) assert.ok(symbols.has(m[1]), `i-${m[1]} is in the sprite`);
    for (const m of PROJECT.matchAll(/\bact\('[^']+', '([a-z0-9-]+)'/g)) assert.ok(symbols.has(m[1]), `i-${m[1]} is in the sprite`);
  });

  test('(+) initApp registers the row hook next to groupActions; app.js only ever calls it through hooks (no app-tier import)', () => {
    assert.match(PROJECT, /hooks\.groupActions = groupActions;\s*hooks\.rowItems = rowItems;/);
    assert.doesNotMatch(appCode, /from '\.\/project\.js'/);
    assert.equal(appCode.match(/hooks\.rowItems/g).length, 1, 'one call');
  });

  test('(−) the orchestrator routes are named only in app-tier modules, and every request is a literal /api/app/ path', () => {
    for (const f of ['app.js', 'dom.js', 'ui.js', 'dash-model.js']) assert.doesNotMatch(code(read(f)), /\/api\/app|\/orchestrator/, f);
    assert.equal(PROJECT.match(/\/orchestrator`/g).length, 3, 'PUT twice (Set, save-then-resume) and DELETE once');
  });

  test('(−) bypass is nowhere in these flows: the page never sends a mode, and the saved id is only ever one the row or the server gave', () => {
    for (const fnName of ['async function startOrchestrator(', 'async function setPick(', 'async function forgetPick(', 'function rowItems(']) {
      const body = fn(PROJECT, fnName);
      assert.doesNotMatch(body, /permission|bypass|mode/i, fnName);
    }
    for (const m of PROJECT.matchAll(/json: (\{[^}]*\})/g)) if (/sessionId/.test(m[1])) assert.match(m[1], /^\{ sessionId: (a|save)\.id \}$/);
  });
});
