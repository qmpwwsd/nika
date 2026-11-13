// 0.4, O2b: the nesting tree, the spawn items and the spawn sheet, the page side (design 0.4 sections 2 and 3).
// The real page code runs in a vm against the small fake DOM (test/fake-dom.js) and recorded requests; the browser is exercised by
// hand. The pure helpers (treeRows, spawnLimits) are tested in test/dash-model.test.js. The copy strings are written out
// here from design 2.4 / 2.5 / 3 on purpose: the tests must not read them back from the code under test. Names and ids are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, withClass, focus } from './fake-dom.js';
import { h, icon, roleTagEl, ctxEl } from '../public/dom.js';
import { menuEl, sessionHref, RX } from '../public/ui.js';
import {
  orchState, roleTag, savedPick, otherRunning, parentOf, spawnLimits, statusOf, treeRows, hasTree, endedPlan, STATUS_ORDER,
} from '../public/dash-model.js';
import { parseModes, modesAfter, modeEl, settingModeEl } from '../public/modes.js';
import { pluginView, pluginSave, sortIds, countText, filterNote } from '../public/plugin-view.js';
import { ROLES, ROLE_LABEL, CUSTOM, MODEL_ID, MODEL_HINT, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels } from '../public/models-ui.js';

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
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSetTimeout(fn, ms, ...a); t.unref?.(); return t; };
});
after(() => {
  globalThis.setTimeout = realSetTimeout;
  restore();
});

// ---- fixtures: one project, the orchestrator "planner", its sub-orchestrator "api-lead" and two agents --------------------------------

const MAIN = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const B1 = '33333333-3333-4333-8333-333333333333';
const B2 = '44444444-4444-4444-8444-444444444444';
const NEW = '55555555-5555-4555-8555-555555555555';
const KEY = '0123456789abcdef';
const SHAPE = { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, pane: /^%\d{1,6}$/, key: /^[a-z0-9]{16}$/, claudeUrl: /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{1,64}$/ };

const ag = (id, name, over = {}) => ({
  id, name, live: true, state: 'idle', role: 'agent', parent: null, depth: 1, pane: { id: '%9', command: 'claude' }, lastActivity: 1, subagents: [], resumeCmd: 'claude --resume x', ...over,
});
/** planner (main) > api-lead (sub, busy) > builder-1 (needs you), and builder-2 straight under planner, named by its pane id. */
const family = () => [
  ag(MAIN, 'planner', { role: 'orchestrator', pane: { id: '%1', command: 'claude' }, lastActivity: 10 }),
  ag(SUB, 'api-lead', { role: 'sub-orchestrator', parent: MAIN, depth: 2, state: 'busy', pane: { id: '%2', command: 'claude' }, lastActivity: 9 }),
  ag(B1, 'builder-1', { parent: SUB, depth: 3, attention: 'permission', pane: { id: '%3', command: 'claude' }, lastActivity: 8 }),
  ag(B2, 'builder-2', { parent: '%1', depth: 2, pane: { id: '%4', command: 'claude' }, lastActivity: 7 }),
];
const livePick = { sessionId: MAIN, state: 'live', name: 'planner', pane: '%1' };
const group = (agents, over = {}) => ({ key: KEY, label: 'demo-api', project: { key: KEY, name: 'demo-api', orchestrator: livePick }, agents, ...over });
const rowsOf = (ul) => ul.kids.filter(withClass('row'));
const nameOf = (li) => li.all(withClass('name'))[0].textContent;
const toggleOf = (li) => li.all(withClass('tree-tg'))[0] ?? null;

// ---- the tree in app.js: agentNodes, rowEl and treeSlot against the real h() ---------------------------------------------------------

const APP = code(read('app.js'));
/** Source of the top-level function that starts with `head`, up to its closing brace at column 0. */
const fn = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} exists`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2);
};
const line = (re) => re.exec(APP)[0];
const TREE_SRC = [
  fn(APP, 'export function sOf(').replace('export ', ''), fn(APP, 'function matches('), line(/const byStatus = [^\n]+/), line(/const endedScope = [^\n]+/),
  fn(APP, 'function subagentsEl('), fn(APP, 'function treeSlot('), fn(APP, 'function rowEl('), line(/const rowsEl = [^\n]+/), line(/const treeEl = [^\n]+/),
  fn(APP, 'export function agentNodes(').replace('export ', ''), fn(APP, 'export function swap(').replace('export ', ''),
].join('\n');

function treeRig({ isApp = true, open = [], expanded = [], rowItems = null } = {}) {
  const state = { showEnded: false, open: new Set(open), expanded: new Set(expanded), modes: { map: {} } };
  const renders = [];
  const seen = [];
  const ctx = {
    isApp, state, hooks: rowItems ? { rowItems: (...args) => { seen.push(args); return rowItems; } } : {}, ORDER: STATUS_ORDER, ROW_CAP: 12,
    endedPlan, statusOf, treeRows, hasTree, parentOf, roleTag, roleTagEl, ctxEl, h, icon, menuEl, sessionHref, SHAPE,
    rowMode: () => null, canEndRow: () => false, reasonOf: () => 'Needs you', endedText: () => 'Ended',
    statusEl: () => new El('span'), modeEl: () => new El('span'), modelEl: () => new El('span'), timeEl: () => new El('span'),
    copyText: () => {}, showReport: () => {}, focusPane: () => {}, endSession: () => {},
    render: (force) => renders.push(force), document: { getSelection: () => ({ isCollapsed: true }), activeElement: null }, location: {},
    CSS: { escape: (s) => s }, $: (sel, root) => root.byFk(/data-fk="(.*)"\]/.exec(sel)[1]),
  };
  const api = vm.runInNewContext(`${TREE_SRC}\n({ agentNodes, rowEl, swap })`, ctx);
  return { ...api, ctx, state, renders, seen };
}
const hostOf = () => {
  const host = new El('div');
  host.contains = (n) => host.all((x) => x === n).length > 0;
  return host;
};

describe('the tree rows (design 2.1)', () => {
  test('(+) a nested group draws one flat list in tree order, each row with data-depth, aria-level and an id the toggles point at', () => {
    const { agentNodes } = treeRig();
    const [ul] = agentNodes(group(family()), '', 'g:k');
    assert.equal(ul.tag, 'ul');
    assert.equal(ul.className, 'rows');
    const rows = rowsOf(ul);
    assert.deepEqual(rows.map(nameOf), ['planner', 'api-lead', 'builder-1', 'builder-2'], 'the subtree with an agent that needs you comes before the idle sibling');
    assert.deepEqual(rows.map((r) => r.attrs['data-depth']), ['1', '2', '3', '2']);
    assert.deepEqual(rows.map((r) => r.attrs['aria-level']), ['1', '2', '3', '2']);
    assert.deepEqual(rows.map((r) => r.attrs.id), [MAIN, SUB, B1, B2].map((id) => `row-g:k-${id}`));
  });

  test('(+) only a row with children has the collapse button; the others keep an empty slot of the same width', () => {
    const { agentNodes } = treeRig();
    const rows = rowsOf(agentNodes(group(family()), '', 'g:k')[0]);
    assert.deepEqual(rows.map((r) => (toggleOf(r) ? 'button' : 'slot')), ['button', 'button', 'slot', 'slot']);
    const slot = rows[2].all(withClass('tree-sp'))[0];
    assert.equal(slot.attrs['aria-hidden'], 'true');
  });

  test('(+) the toggle: aria-expanded, aria-controls (every descendant row id, in row order, and each id exists) and a label with the count', () => {
    const { agentNodes } = treeRig();
    const ul = agentNodes(group(family()), '', 'g:k')[0];
    const [main, sub] = rowsOf(ul);
    const t = toggleOf(main);
    assert.equal(t.tag, 'button');
    assert.equal(t.attrs.type, 'button');
    assert.equal(t.attrs['aria-expanded'], 'true');
    assert.equal(t.attrs['aria-controls'], [SUB, B1, B2].map((id) => `row-g:k-${id}`).join(' '));
    assert.equal(t.attrs['aria-label'], 'Hide the 3 agents under planner');
    assert.equal(t.attrs['data-fk'], `tree:g:k:${MAIN}`);
    for (const id of t.attrs['aria-controls'].split(' ')) assert.ok(ul.all((n) => n.attrs.id === id).length === 1, id);
    assert.equal(toggleOf(sub).attrs['aria-label'], 'Hide the 1 agent under api-lead', 'singular');
    assert.equal(toggleOf(sub).attrs['aria-controls'], `row-g:k-${B1}`);
  });

  test('(+) a row below the first level has the elbow (hidden from screen readers) and says whom it is under for a screen reader', () => {
    const { agentNodes } = treeRig();
    const rows = rowsOf(agentNodes(group(family()), '', 'g:k')[0]);
    assert.equal(rows[0].all(withClass('elbow')).length, 0);
    assert.equal(rows[0].all(withClass('sr-only')).filter((n) => n.textContent.startsWith(', under')).length, 0);
    const elbow = rows[2].all(withClass('elbow'))[0];
    assert.equal(elbow.attrs['aria-hidden'], 'true');
    assert.deepEqual(rows[2].all(withClass('sr-only')).map((n) => n.textContent).filter((t) => t.startsWith(', under')), [', under api-lead']);
    assert.deepEqual(rows[3].all(withClass('sr-only')).map((n) => n.textContent).filter((t) => t.startsWith(', under')), [', under planner'], 'a parent named by its pane id resolves too');
  });

  test('(+) the role tags come from the role: main and sub-orchestrator tags, no tag on an agent', () => {
    const { agentNodes } = treeRig();
    const rows = rowsOf(agentNodes(group(family()), '', 'g:k')[0]);
    const tags = rows.map((r) => r.all(withClass('tag'))[0]?.className ?? null);
    assert.deepEqual(tags, ['tag', 'tag sub', null, null]);
  });

  test('(+) collapse: a folded row hides every descendant (hidden), keeps its own depth, and shows "+N" with the count of those that need you', () => {
    const { agentNodes } = treeRig({ open: [`!tree:g:k:${MAIN}`] });
    const rows = rowsOf(agentNodes(group(family()), '', 'g:k')[0]);
    assert.deepEqual(rows.map((r) => r.hidden), [false, true, true, true]);
    assert.deepEqual(rows.map((r) => r.attrs['data-depth']), ['1', '2', '3', '2'], 'depth stays, so unfolding is just removing hidden');
    const t = toggleOf(rows[0]);
    assert.equal(t.attrs['aria-expanded'], 'false');
    assert.equal(t.attrs['aria-label'], 'Show the 3 agents under planner, 1 needs you');
    const hid = rows[0].all(withClass('tree-hid'))[0];
    assert.equal(hid.attrs['aria-hidden'], 'true');
    assert.equal(hid.kids[0].textContent, '+3');
    assert.equal(hid.all(withClass('attn'))[0].textContent, '1');
  });

  test('(+) folding a sub-orchestrator hides only its own agents; the count shows "+1" and no "needs you" badge when none does', () => {
    const agents = family();
    agents[2] = { ...agents[2], attention: null, state: 'idle' };
    const { agentNodes } = treeRig({ open: [`!tree:g:k:${SUB}`] });
    const rows = rowsOf(agentNodes(group(agents), '', 'g:k')[0]);
    assert.deepEqual(rows.map((r) => r.hidden), [false, false, true, false]);
    const hid = rows[1].all(withClass('tree-hid'))[0];
    assert.equal(hid.kids[0].textContent, '+1');
    assert.equal(hid.all(withClass('attn')).length, 0);
    assert.equal(toggleOf(rows[1]).attrs['aria-label'], 'Show the 1 agent under api-lead');
    assert.equal(rows[0].all(withClass('tree-hid')).length, 0, 'an expanded row shows no count');
  });

  test('(+) clicking the toggle flips the folded mark in state.open (the "!" pattern of the Ended sections) and asks for a render', () => {
    const r = treeRig();
    const mark = `!tree:g:k:${MAIN}`;
    const t = toggleOf(rowsOf(r.agentNodes(group(family()), '', 'g:k')[0])[0]);
    t.fire('click');
    assert.ok(r.state.open.has(mark));
    assert.deepEqual(r.renders, [true]);
    const t2 = toggleOf(rowsOf(r.agentNodes(group(family()), '', 'g:k')[0])[0]);
    t2.fire('click');
    assert.ok(!r.state.open.has(mark));
    assert.deepEqual(r.renders, [true, true]);
  });

  test('(+) keyboard focus stays on the toggle across the rebuild a click causes (swap matches data-fk)', () => {
    const r = treeRig();
    const host = hostOf();
    r.swap(host, r.agentNodes(group(family()), '', 'g:k'));
    const old = host.byFk(`tree:g:k:${MAIN}`);
    r.ctx.document.activeElement = old;
    old.fire('click');
    r.swap(host, r.agentNodes(group(family()), '', 'g:k'));
    const now = host.byFk(`tree:g:k:${MAIN}`);
    assert.notEqual(now, old, 'the button was rebuilt');
    assert.equal(focus.el, now);
    assert.equal(now.attrs['aria-expanded'], 'false');
  });

  test('(+) the same state folds the same scope only: the project page scope and the dashboard scope fold on their own', () => {
    const { agentNodes } = treeRig({ open: [`!tree:pv:${KEY}:${MAIN}`] });
    assert.deepEqual(rowsOf(agentNodes(group(family()), '', `g:${KEY}`)[0]).map((r) => r.hidden), [false, false, false, false]);
    assert.deepEqual(rowsOf(agentNodes(group(family()), '', `pv:${KEY}`)[0]).map((r) => r.hidden), [false, true, true, true]);
  });

  test('(+) an orphan (its parent is not running) is a root, keeps its tag and says "parent ended"', () => {
    const lost = ag(SUB, 'api-lead', { role: 'sub-orchestrator', parent: '%99', depth: 2, pane: { id: '%2', command: 'claude' } });
    const { agentNodes } = treeRig();
    const rows = rowsOf(agentNodes(group([lost, ag(B2, 'builder-2', { pane: { id: '%4', command: 'claude' } })]), '', 'g:k')[0]);
    const row = rows.find((r) => nameOf(r) === 'api-lead');
    assert.equal(row.attrs['data-depth'], '1', 'depth by structure, not the stored 2');
    assert.equal(row.all(withClass('tag'))[0].className, 'tag sub', 'the tag comes from the role');
    const mark = row.all(withClass('tree-orphan'))[0];
    assert.equal(mark.textContent, 'parent ended');
    assert.equal(mark.attrs.title, "This agent's parent session is no longer running.");
    assert.equal(row.all(withClass('elbow')).length, 0);
  });

  test('(−) a sub-orchestrator with no parent at all is a root with its tag, and no "parent ended" mark', () => {
    const lone = ag(SUB, 'api-lead', { role: 'sub-orchestrator', parent: null, depth: null, pane: { id: '%2', command: 'claude' } });
    const { agentNodes } = treeRig();
    const nodes = agentNodes(group([lone, ag(B2, 'builder-2', { parent: '%2', pane: { id: '%4', command: 'claude' } })]), '', 'g:k');
    const row = rowsOf(nodes[0])[0];
    assert.equal(row.all(withClass('tag'))[0].className, 'tag sub');
    assert.equal(row.all(withClass('tree-orphan')).length, 0);
  });

  test('(−) a forged depth moves nothing: the row sits where its parent chain puts it, and never below level 3', () => {
    const agents = family();
    agents[3] = { ...agents[3], depth: 99 };
    agents.push(ag('66666666-6666-4666-8666-666666666666', 'builder-9', { parent: B1, depth: 1, pane: { id: '%7', command: 'claude' } }));
    const { agentNodes } = treeRig();
    const rows = rowsOf(agentNodes(group(agents), '', 'g:k')[0]);
    assert.deepEqual(rows.map((r) => r.attrs['data-depth']), ['1', '2', '3', '3', '2'], 'a fourth level is drawn at 3');
  });

  test('(−) a group where nothing nests renders exactly as in 0.3: no depth, no id, no slot, no toggle, no elbow', () => {
    const flat = [ag(MAIN, 'planner', { role: 'orchestrator', pane: { id: '%1', command: 'claude' } }), ag(B1, 'builder-1', { pane: { id: '%3', command: 'claude' } })];
    const { agentNodes } = treeRig();
    const [ul] = agentNodes(group(flat), '', 'g:k');
    const rows = rowsOf(ul);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      for (const k of ['data-depth', 'aria-level', 'id']) assert.equal(r.attrs[k], undefined, k);
      assert.equal(r.hidden, false);
      assert.equal(r.all((n) => /^(tree-|elbow)/.test(n.className)).length, 0);
      assert.equal(r.all(withClass('proj-chip')).length, 0, 'no "under" chip when there is no parent');
    }
  });

  test('(−) the browser tier draws the tree too, and asks the app-tier hook for nothing', () => {
    const r = treeRig({ isApp: false, rowItems: [{ text: 'x', run: () => {} }] });
    const rows = rowsOf(r.agentNodes(group(family(), { project: null }), '', 'g:k')[0]);
    assert.deepEqual(rows.map((x) => x.attrs['data-depth']), ['1', '2', '3', '2']);
    assert.equal(r.seen.length, 0);
  });
});

describe('flat lists: the filter, the queue and Ended (design 2.1)', () => {
  test('(+) a filter makes the group flat and each child says whom it hangs under', () => {
    const { agentNodes } = treeRig();
    const [ul] = agentNodes(group(family()), 'builder', 'g:k');
    const rows = rowsOf(ul);
    assert.deepEqual(rows.map(nameOf), ['builder-1', 'builder-2'], 'needs-you first');
    for (const r of rows) {
      assert.equal(r.attrs['data-depth'], undefined);
      assert.equal(toggleOf(r), null);
    }
    const chips = rows.map((r) => r.all(withClass('proj-chip')).map((n) => n.textContent));
    assert.deepEqual(chips, [['under api-lead'], ['under planner']]);
    assert.equal(rows[0].all(withClass('proj-chip'))[0].attrs.title, 'Under api-lead');
  });

  test('(+) in the queue (showProject) the project chip comes first and the "under" chip after it', () => {
    const { rowEl } = treeRig();
    const agents = family();
    const li = rowEl(agents[2], group(agents), { scope: 'q', showProject: true });
    assert.deepEqual(li.all(withClass('proj-chip')).map((n) => n.textContent), ['demo-api', 'under api-lead']);
  });

  test('(+) a long parent name is cut at 24 characters in the chip, whole in the title', () => {
    const agents = family();
    agents[1] = { ...agents[1], name: 'api-lead-with-a-really-long-name-here' };
    const { rowEl } = treeRig();
    const chip = rowEl(agents[2], group(agents), { scope: 'q' }).all(withClass('proj-chip'))[0];
    assert.equal(chip.textContent, 'under api-lead-with-a-really-…');
    assert.equal(chip.attrs.title, 'Under api-lead-with-a-really-long-name-here');
  });

  test('(+) an ended agent in the Ended section is a flat row with no tree markup and no "under" chip: the server gives it no parent', () => {
    const agents = [...family(), ag('77777777-7777-4777-8777-777777777777', 'builder-3', { live: false, state: 'ended', pane: null, parent: null })];
    const r = treeRig();
    r.state.showEnded = true;
    const nodes = r.agentNodes(group(agents), '', 'g:k');
    const ended = nodes.find((n) => n.tag === 'details');
    const row = rowsOf(ended.all((n) => n.tag === 'ul')[0])[0];
    assert.equal(nameOf(row), 'builder-3');
    assert.equal(row.attrs['data-depth'], undefined);
    assert.deepEqual(row.all(withClass('proj-chip')).map((n) => n.textContent), []);
    assert.equal(rowsOf(nodes[0]).length, 4, 'the tree above holds the live four only');
  });

  test('(−) a row whose parent is not in the list gets no "under" chip (nothing to name)', () => {
    const { rowEl } = treeRig();
    const a = ag(B1, 'builder-1', { parent: '%99' });
    assert.equal(rowEl(a, group([a]), { scope: 'q' }).all(withClass('proj-chip')).length, 0);
  });
});

// F5 (0.4): finished and stopped subagents hide with the ended sessions; the running ones stay. One toggle per view.
describe('Claude\'s own subagents under a row: hidden when finished until "Show ended" (F5)', () => {
  const sub = (id, state, over = {}) => ({ id, type: 'Explore', description: `task ${id}`, model: 'haiku', modelLabel: 'Haiku 4.5', state, lastActivity: 5, ...over });
  const SUBS = [sub('s1', 'running'), sub('s2', 'finished'), sub('s3', 'stopped')];
  const busy = () => ag(B1, 'builder-1', { state: 'busy', subagents: SUBS });
  const subsOf = (nodes) => nodes.flatMap((n) => n.all(withClass('subs')));
  const summaryOf = (d) => d.all((n) => n.tag === 'summary')[0];
  const itemsOf = (d) => d.all((n) => n.tag === 'li').map((li) => li.all(withClass('sub-desc'))[0].textContent);

  test('(+) by default only the running subagent is listed; the summary counts what is shown and a muted "+2 ended" hint says the rest is hidden', () => {
    const r = treeRig();
    const [d] = subsOf(r.agentNodes(group([busy()]), '', 'g:k'));
    assert.deepEqual(itemsOf(d), ['task s1']);
    assert.equal(summaryOf(d).textContent, '1 subagent · 1 running +2 ended');
    const hint = summaryOf(d).all(withClass('muted'))[0];
    assert.equal(hint.textContent, '+2 ended');
  });

  test('(+) with the toggle on every subagent is listed, the summary counts all of them and there is no hint', () => {
    const r = treeRig();
    r.state.showEnded = true;
    const [d] = subsOf(r.agentNodes(group([busy()]), '', 'g:k'));
    assert.deepEqual(itemsOf(d).sort(), ['task s1', 'task s2', 'task s3']);
    assert.equal(summaryOf(d).textContent, '3 subagents · 1 running');
    assert.equal(summaryOf(d).all(withClass('muted')).length, 0);
  });

  test('(+) a row whose subagents are all finished or stopped draws no subagent line at all while they are hidden', () => {
    const a = ag(B1, 'builder-1', { state: 'busy', subagents: [sub('s2', 'finished'), sub('s3', 'stopped')] });
    const r = treeRig();
    assert.equal(subsOf(r.agentNodes(group([a]), '', 'g:k')).length, 0);
    r.state.showEnded = true;
    assert.equal(itemsOf(subsOf(r.agentNodes(group([a]), '', 'g:k'))[0]).length, 2);
  });

  test('(+) the project page has its own toggle: the option decides, the dashboard flag does not leak in, either way round', () => {
    const r = treeRig();
    r.state.showEnded = true; // the dashboard checkbox is on, the project page one is off
    assert.deepEqual(itemsOf(subsOf(r.agentNodes(group([busy()]), '', 'pv:k', { showEnded: false }))[0]), ['task s1']);
    r.state.showEnded = false;
    assert.equal(itemsOf(subsOf(r.agentNodes(group([busy()]), '', 'pv:k', { showEnded: true }))[0]).length, 3);
  });

  test('(+) an ended session in the Ended section keeps its subagents hidden with the toggle off (the section itself is not drawn) and shows them with it on', () => {
    const gone = ag(B2, 'builder-2', { live: false, state: 'ended', pane: null, subagents: [sub('s4', 'stopped')] });
    const r = treeRig();
    assert.equal(subsOf(r.agentNodes(group([gone]), '', 'g:k')).length, 0);
    const nodes = r.agentNodes(group([gone]), '', 'g:k', { showEnded: true });
    assert.deepEqual(itemsOf(subsOf(nodes)[0]), ['task s4']);
  });

  test('(−) a subagent state that is not "running" is never shown by default, whatever the word', () => {
    const odd = ag(B1, 'builder-1', { state: 'busy', subagents: [sub('s5', 'Running'), sub('s6', undefined), sub('s7', 'running')] });
    const [d] = subsOf(treeRig().agentNodes(group([odd]), '', 'g:k'));
    assert.deepEqual(itemsOf(d), ['task s7']);
    assert.equal(summaryOf(d).textContent, '1 subagent · 1 running +2 ended');
  });

  test('(+) the open mark of the disclosure survives the redraw as before (same id per session)', () => {
    const r = treeRig({ open: [`subs:${B1}`] });
    const [d] = subsOf(r.agentNodes(group([busy()]), '', 'g:k'));
    assert.ok(d.hasAttribute('open'));
    assert.ok(!subsOf(treeRig().agentNodes(group([busy()]), '', 'g:k'))[0].hasAttribute('open'), 'closed unless opened by hand');
  });
});

describe('row caps (design 2.1, F1b): live rows are never capped, the Ended section is', () => {
  const idOf = (i) => `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const many = (n) => Array.from({ length: n }, (_, i) => ag(idOf(i), `agent-${i + 1}`, { pane: { id: `%${i + 20}`, command: 'claude' }, lastActivity: 100 - i }));
  const done = (n) => Array.from({ length: n }, (_, i) => ag(idOf(i + 500), `done-${i + 1}`, { live: false, state: 'ended', pane: null, lastActivity: 100 - i }));
  const sectionOf = (nodes) => nodes.find((n) => n.tag === 'details');
  const endedRows = (nodes) => rowsOf(sectionOf(nodes).all((n) => n.tag === 'ul')[0]);
  const moreOf = (node) => node.all((n) => n.tag === 'button' && /^more:/.test(n.attrs['data-fk'] ?? ''));

  test('(+) 20 live root rows in one group all render, and there is no "Show more" button', () => {
    const [ul, ...rest] = treeRig().agentNodes(group(many(20)), '', 'g:k');
    assert.equal(rowsOf(ul).length, 20);
    assert.equal(moreOf(ul).length, 0);
    assert.deepEqual(rest, []);
  });

  test('(+) a live tree is never cut: 20 roots and a child under the last one give 21 rows', () => {
    const roots = many(20);
    const kid = ag('99999999-9999-4999-8999-999999999999', 'kid', { parent: roots[19].id, pane: { id: '%90', command: 'claude' }, lastActivity: 1 });
    const [ul] = treeRig().agentNodes(group([...roots, kid]), '', 'g:k');
    assert.equal(rowsOf(ul).length, 21);
    assert.equal(moreOf(ul).length, 0);
  });

  test('(+) 20 live rows beside 3 ended ones: all live rows draw and the 3 ended fit, so no button at all', () => {
    const r = treeRig();
    r.state.showEnded = true;
    const nodes = r.agentNodes(group([...many(20), ...done(3)]), '', 'g:k');
    assert.equal(rowsOf(nodes[0]).length, 20);
    assert.equal(endedRows(nodes).length, 3);
    assert.equal(nodes.flatMap(moreOf).length, 0);
  });

  test('(+) 13 ended rows: the Ended section draws 12 and a button that counts the one left out; its summary still counts all 13', () => {
    const r = treeRig();
    r.state.showEnded = true;
    const nodes = r.agentNodes(group(done(13)), '', 'g:k');
    assert.equal(endedRows(nodes).length, 12);
    assert.equal(sectionOf(nodes).all((n) => n.tag === 'summary')[0].textContent, 'Ended (13)');
    const [more] = moreOf(sectionOf(nodes));
    assert.equal(more.textContent, 'Show 1 more ended agent', 'singular for one');
    assert.equal(more.attrs['data-fk'], 'more:g:k');
  });

  test('(+) "Show more" on the Ended section asks for a render and the expanded section then shows all of it, without the button', () => {
    const r = treeRig();
    r.state.showEnded = true;
    const first = r.agentNodes(group(done(30)), '', 'g:k');
    assert.equal(moreOf(sectionOf(first))[0].textContent, 'Show 18 more ended agents');
    moreOf(sectionOf(first))[0].fire('click');
    assert.ok(r.state.expanded.has('cap:g:k'));
    assert.deepEqual(r.renders, [true]);
    const again = r.agentNodes(group(done(30)), '', 'g:k');
    assert.equal(endedRows(again).length, 30);
    assert.equal(moreOf(sectionOf(again)).length, 0);
  });

  test('(−) exactly 12 ended rows: nothing is cut, no button', () => {
    const r = treeRig();
    r.state.showEnded = true;
    const nodes = r.agentNodes(group(done(12)), '', 'g:k');
    assert.equal(endedRows(nodes).length, 12);
    assert.equal(moreOf(sectionOf(nodes)).length, 0);
  });

  test('(−) the project page counts its own scope: expanding the dashboard group leaves the project page capped', () => {
    const r = treeRig({ expanded: ['cap:g:k'] });
    r.state.showEnded = true;
    assert.equal(endedRows(r.agentNodes(group(done(13)), '', 'g:k')).length, 13);
    assert.equal(endedRows(r.agentNodes(group(done(13)), '', 'pv:k', { showEnded: true })).length, 12);
  });
});

// ---- project.js: the spawn items, the header button, the sheet and its failures (design 1.2, 2.3, 2.4, 3) ---------------------------

const PROJECT_SRC = code(read('project.js')).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
const OFFLINE = 'Offline. nika is reconnecting.';
const NO_TMUX = 'Needs tmux. Install it, then check again.';
const NO_MAIN = 'Start the orchestrator first: sub-orchestrators run under it.';
const TAIL = 'Wait for one to finish, or raise “Agents per orchestrator” in Settings.';
const SETTINGS = {
  limits: { maxAgents: 3 }, permissionMode: 'default', panePlacement: 'beside',
  models: { builder: 'claude-sonnet-5-5', reasoner: 'claude-opus-5-5', scout: 'haiku', orchestrator: 'claude-fable-1' }, perProject: {},
};

/** `agents`: the project's rows. `answers`: { 'METHOD url': response | (opts) => response }; an unanswered request throws ("Could not reach"). */
function projRig({ agents = family(), project = {}, settings = SETTINGS, me = { tmux: true, claude: true }, error = null, answers = {}, groupOver = {} } = {}) {
  const proj = { key: KEY, dir: '/work/demo-api', name: 'demo-api', rules: { state: 'nika' }, orchestrator: livePick, ...project };
  const g = { key: KEY, label: 'demo-api', project: proj, agents, ...groupOver };
  const calls = [];
  const toastLog = [];
  const navs = [];
  const renders = [];
  const opened = [];
  const synced = [];
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) {
      const n = new El(sel === '#sp-model' ? 'select' : 'div');
      if (sel === 'input[name="sp-place"]:checked') n.value = 'settings';
      nodes.set(sel, n);
    }
    return nodes.get(sel);
  };
  const state = { error, me, projects: [proj], settings, models: null, modes: { map: {}, misses: 0 }, route: { name: 'project', key: KEY }, open: new Set(), expanded: new Set(), plugins: null, showEnded: false };
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
    h, icon, $: node, state, hooks: {}, appFetch, menuEl, sessionHref, roleTag, orchState, savedPick, otherRunning, spawnLimits, parseModes, modesAfter, settingModeEl, RX,
    pluginView, pluginSave, sortIds, countText, filterNote, ROLES, ROLE_LABEL, CUSTOM, MODEL_ID, MODEL_HINT, modelLabel, fillModelSelect, fillRoleOverride, effectiveRoleModels,
    location: { set href(v) { navs.push(v); }, get href() { return ''; }, hash: '' }, document: { title: '' },
    toast: (msg, o) => {
      const t = { msg, kind: o?.kind ?? 'info', action: o?.action, remove() {} };
      toastLog.push(t);
      return t;
    },
    announce: () => {}, errText: (r) => r?.body?.message ?? `The server answered ${r?.status}.`, copyText: () => {}, openDialog: (dlg, o) => opened.push({ dlg, o }),
    setBusy: (btn, busy, label) => { btn.disabled = busy; btn.busyLabel = busy ? label : null; },
    fieldError: (input, msg) => { input.err = msg; }, syncRadioCards: (root) => synced.push(root),
    render: (force) => renders.push(force), buildGroups: () => [g], agentNodes: () => [new El('ul')], swap: (host, list) => host.replaceChildren(...list), interacting: () => false,
    rulesEl: () => new El('span'), setTimeout, clearTimeout, AbortController, TextEncoder, window: { addEventListener: () => {} },
  };
  const api = vm.runInNewContext(`${PROJECT_SRC}\n({ groupActions, rowItems, openSpawn, changeRole, submitSpawn, setupCards, confirmRemove, limitCopy, limitReason, spawnPrefs, sp, renderProject })`, ctx);
  const set = (sel, patch) => Object.assign(node(sel), patch);
  const role = (which) => { // the radios say which role is chosen
    set('#sp-role-agent', { checked: which === 'agent' });
    set('#sp-role-orch', { checked: which === 'orchestrator' });
  };
  return { api, ctx, g, proj, state, calls, toastLog, navs, renders, opened, synced, node, set, role,
    texts: () => toastLog.map((t) => t.msg), last: () => toastLog.at(-1),
    posts: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/app/spawn') };
}
const mainRow = () => family()[0];
const subRow = () => family()[1];
const textOf = (n) => n.textContent;

describe('renderProject: the "Show ended" box', () => {
  test('(−) a project that is not registered shows no "Show ended" box: there is nothing to show', () => {
    const r = projRig();
    r.state.route = { name: 'project', key: 'ffffffffffffffff' };
    r.api.renderProject(true);
    assert.equal(r.node('#proj-h').textContent, 'Project not found');
    assert.equal(r.node('#proj-ended-wrap').hidden, true);
  });

  test('(+) a registered project shows it again', () => {
    const r = projRig();
    r.node('#proj-ended-wrap').hidden = true;
    try { r.api.renderProject(true); } catch { /* the rest of the page needs more of the DOM than this rig has */ }
    assert.equal(r.node('#proj-h').textContent, 'demo-api');
    assert.equal(r.node('#proj-ended-wrap').hidden, false);
  });
});

describe('rowItems: the Spawn columns of the menu matrix (design 1.2)', () => {
  const texts = (items) => Array.from(items, (i) => i.text);
  const forRow = (a, over = {}) => { const r = projRig({ agents: family(), ...over }); return { r, out: r.api.rowItems(a, r.g, 'g:k') }; };
  const spawnOnly = (out) => Array.from(out).filter((i) => i.text.startsWith('Spawn'));
  const SPAWN = ['Spawn agent under planner…', 'Spawn sub-orchestrator under planner…'];

  test('(+) the main orchestrator: Spawn agent under and Spawn sub-orchestrator under, each with its own fk', () => {
    const out = spawnOnly(forRow(mainRow()).out);
    assert.deepEqual(texts(out), SPAWN);
    assert.deepEqual(Array.from(out, (i) => i.fk), [`spawn-under:g:k:${MAIN}`, `spawn-sub:g:k:${MAIN}`]);
    assert.deepEqual(Array.from(out, (i) => i.reason), [null, null]);
  });

  test('(+) a sub-orchestrator: Spawn agent under only (no third level)', () => {
    const { out } = forRow(subRow());
    assert.deepEqual(texts(out), ['Spawn agent under api-lead…']);
    assert.equal(out[0].fk, `spawn-under:g:k:${SUB}`);
    assert.equal(out[0].group, undefined, 'it is the only item, so it starts no group of its own');
  });

  test('(+) the spawn items start their own rule when other items come before them (Stop using as orchestrator)', () => {
    const { out } = forRow(mainRow());
    assert.deepEqual(texts(out), ['Stop using as orchestrator', ...SPAWN]);
    assert.deepEqual(Array.from(out, (i) => Boolean(i.group)), [false, true, false]);
  });

  test('(−) an agent, a session with no role, an ended session and a live main without a pane get no spawn items', () => {
    const agentRow = family()[2];
    assert.deepEqual(plain(forRow(agentRow).out), []);
    const roleless = ag(NEW, 'scratch', { role: null, pane: { id: '%8', command: 'claude' } });
    assert.ok(!texts(forRow(roleless).out).some((t) => t.startsWith('Spawn')));
    const ended = { ...mainRow(), live: false, pane: null };
    assert.ok(!texts(forRow(ended).out).some((t) => t.startsWith('Spawn')));
    const noPane = { ...mainRow(), pane: null };
    assert.ok(!texts(forRow(noPane).out).some((t) => t.startsWith('Spawn')));
  });

  test('(−) an unregistered group gets none', () => {
    const r = projRig();
    assert.deepEqual(plain(r.api.rowItems(mainRow(), { ...r.g, project: null }, 'g:k')), []);
  });

  test('(+) R0 first: offline and missing tmux or claude turn both items off with the shared reason, ahead of any limit', () => {
    const full = family().slice(0, 1).concat(Array.from({ length: 3 }, (_, i) => ag(`aaaaaaaa-0000-4000-8000-00000000000${i}`, `builder-${i + 5}`, { parent: '%1', pane: { id: `%${30 + i}`, command: 'claude' } })));
    assert.deepEqual(Array.from(forRow(mainRow(), { agents: full, error: 'down' }).out.slice(-2), (i) => i.reason), [OFFLINE, OFFLINE]);
    assert.deepEqual(Array.from(forRow(mainRow(), { me: { tmux: false, claude: true } }).out.slice(-2), (i) => i.reason), [NO_TMUX, NO_TMUX]);
    assert.deepEqual(Array.from(forRow(mainRow(), { me: { tmux: true, claude: false } }).out.slice(-2), (i) => i.reason), ['Needs Claude Code (claude) on your PATH.', 'Needs Claude Code (claude) on your PATH.']);
  });

  test('(+) a parent at its limit: both items off with "<parent> already runs <r> of <max> agents of its own..."', () => {
    const { out } = forRow(mainRow(), { settings: { ...SETTINGS, limits: { maxAgents: 2 } } }); // planner already has api-lead and builder-2
    const why = `planner already runs 2 of 2 agents of its own. ${TAIL}`;
    assert.deepEqual(Array.from(out.slice(-2), (i) => i.reason), [why, why]);
  });

  test('(+) the project cap when the parent is below its own: "<project> already runs <r> of <cap> agents, the most one project can run..."', () => {
    const loose = [mainRow(), ...Array.from({ length: 3 }, (_, i) => ag(`bbbbbbbb-0000-4000-8000-00000000000${i}`, `builder-${i + 5}`, { parent: '%77', pane: { id: `%${40 + i}`, command: 'claude' } }))];
    const { out } = forRow(mainRow(), { agents: loose, settings: { ...SETTINGS, limits: { maxAgents: 1 } } }); // cap min(3, 24) = 3, planner has none
    assert.deepEqual(Array.from(out.slice(-2), (i) => i.reason), Array(2).fill('demo-api already runs 3 of 3 agents, the most one project can run. Wait for one to finish.'));
  });

  test('(−) one agent below both limits: no reason; a sub-orchestrator counts toward its parent and the project like an agent', () => {
    assert.deepEqual(Array.from(forRow(mainRow()).out.slice(-2), (i) => i.reason), [null, null]);
    const { out } = forRow(mainRow(), { settings: { ...SETTINGS, limits: { maxAgents: 2 } } });
    assert.equal(out.at(-1).reason !== null, true, 'planner has 2 children, one of them the sub-orchestrator');
  });

  test('(+) running an item opens the sheet for that row: parent and role preset', () => {
    const r = projRig();
    const [agentItem, subItem] = spawnOnly(r.api.rowItems(mainRow(), r.g, 'g:k'));
    agentItem.run();
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
    assert.equal(r.node('#sp-parent').textContent, 'planner · orchestrator · pane %1');
    subItem.run();
    assert.equal(r.node('#sp-h').textContent, 'Spawn sub-orchestrator');
    assert.equal(r.node('#sp-role-orch').checked, true);
    r.api.rowItems(subRow(), r.g, 'g:k')[0].run();
    assert.equal(r.node('#sp-parent').textContent, 'api-lead · sub-orchestrator · pane %2');
    assert.equal(r.node('#sp-role-agent').checked, true);
  });
});

describe('the header buttons (design 2.3)', () => {
  const labels = (btns) => Array.from(btns, (b) => b.all(withClass('lbl'))[0].textContent);

  test('(+) the project page header adds Spawn sub-orchestrator after Spawn agent; the dashboard header keeps two buttons', () => {
    const r = projRig();
    assert.deepEqual(labels(r.api.groupActions(r.g, { primary: 'spawn', sub: true })), ['Open orchestrator', 'Spawn agent', 'Spawn sub-orchestrator']);
    assert.deepEqual(labels(r.api.groupActions(r.g, {})), ['Open orchestrator', 'Spawn agent']);
  });

  test('(+) the sub button has its own icon and fk, a fixed aria-label (the label hides on narrow screens), and is not primary', () => {
    const r = projRig();
    const btn = r.api.groupActions(r.g, { primary: 'spawn', sub: true })[2];
    assert.equal(btn.attrs['data-fk'], `spawn-sub:${KEY}`);
    assert.equal(btn.attrs['aria-label'], 'Spawn sub-orchestrator');
    assert.equal(btn.all((n) => n.tag === 'use')[0].attrs.href, '#i-sub-spawn');
    assert.ok(!withClass('primary')(btn));
    assert.equal(btn.attrs['aria-disabled'], undefined);
    assert.equal(btn.attrs.title, 'Spawn sub-orchestrator');
  });

  test('(+) with a live main orchestrator a click opens the sheet as a sub-orchestrator under it', () => {
    const r = projRig();
    r.api.groupActions(r.g, { sub: true })[2].fire('click');
    assert.equal(r.opened.length, 1);
    assert.equal(r.node('#sp-h').textContent, 'Spawn sub-orchestrator');
    assert.equal(r.node('#sp-parent').textContent, 'planner · orchestrator · pane %1');
    assert.equal(r.node('#sp-role-orch').checked, true);
  });

  test('(+) a main orchestrator that is only running (no saved pick, a 0.3 pane) also counts as the parent', () => {
    const r = projRig({ project: { orchestrator: null } });
    const btn = r.api.groupActions(r.g, { sub: true })[2];
    assert.equal(btn.attrs['aria-disabled'], undefined);
    btn.fire('click');
    assert.equal(r.node('#sp-parent').textContent, 'planner · orchestrator · pane %1');
  });

  test('(−) no main orchestrator (none, or saved and ended): disabled with "Start the orchestrator first..."; a click toasts it and opens nothing', () => {
    for (const orchestrator of [null, { sessionId: MAIN, state: 'ended', name: 'planner', pane: null }]) {
      const r = projRig({ agents: family().slice(2), project: { orchestrator } });
      const btn = r.api.groupActions(r.g, { sub: true }).at(-1);
      assert.equal(btn.attrs['aria-disabled'], 'true');
      assert.equal(btn.attrs.title, NO_MAIN);
      assert.equal(btn.attrs['aria-label'], 'Spawn sub-orchestrator', 'the name stays for a screen reader');
      btn.fire('click');
      assert.equal(r.last().msg, NO_MAIN);
      assert.equal(r.last().kind, 'error');
      assert.equal(r.opened.length, 0);
    }
  });

  test('(−) R0 comes before the missing orchestrator, and a limit comes after it', () => {
    const off = projRig({ error: 'down' });
    assert.equal(off.api.groupActions(off.g, { sub: true })[2].attrs.title, OFFLINE);
    const full = projRig({ settings: { ...SETTINGS, limits: { maxAgents: 2 } } }); // planner runs 2 of 2
    assert.equal(full.api.groupActions(full.g, { sub: true })[2].attrs.title, `planner already runs 2 of 2 agents of its own. ${TAIL}`);
  });

  test('(+) Spawn agent in the header is off when you already run N from nika, with the "You already run..." line', () => {
    const own = Array.from({ length: 3 }, (_, i) => ag(`cccccccc-0000-4000-8000-00000000000${i}`, `builder-${i + 5}`, { parent: null, pane: { id: `%${50 + i}`, command: 'claude' } }));
    const r = projRig({ agents: [mainRow(), ...own] });
    const btn = r.api.groupActions(r.g, {})[1];
    assert.equal(btn.attrs['aria-disabled'], 'true');
    assert.equal(btn.attrs.title, `You already run 3 of 3 agents spawned from nika in demo-api. ${TAIL}`);
    btn.fire('click');
    assert.equal(r.opened.length, 0);
    assert.equal(r.last().msg, btn.attrs.title);
  });
});

describe('the spawn sheet: opening (design 3)', () => {
  const open = (opts = {}, rigOver = {}) => {
    const r = projRig(rigOver);
    r.api.openSpawn(r.g, opts);
    return r;
  };
  const WHY_NONE = "Sub-orchestrators run under the orchestrator. Use Spawn sub-orchestrator in the header, or the orchestrator's row menu.";
  const WHY_SUB = 'Only the main orchestrator can start sub-orchestrators: nika allows three levels.';

  test('(+) from the header with no parent: "None. You start it from nika.", Agent chosen, Sub-orchestrator off with the reason beside it', () => {
    const r = open();
    assert.equal(r.node('#sp-parent').textContent, 'None. You start it from nika.');
    assert.equal(r.node('#sp-role-agent').checked, true);
    assert.equal(r.node('#sp-role-orch').checked, false);
    assert.equal(r.node('#sp-role-orch').disabled, true);
    assert.equal(r.node('#sp-role-orch').attrs['aria-describedby'], 'sp-role-why');
    assert.equal(r.node('#sp-role-orch-card').dataset.off, 'true');
    assert.equal(r.node('#sp-role-why').textContent, WHY_NONE);
    assert.equal(r.node('#sp-role-why').hidden, false);
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
    assert.equal(r.node('#sp-go').textContent, 'Spawn agent');
    assert.equal(r.node('#sp-d').textContent, 'In demo-api. Opens a new tmux pane and starts Claude Code with your brief.');
    assert.equal(r.node('#sp-brief-help').textContent, "The agent's first message: more than one word. It never passes through the tmux command line.");
  });

  test('(+) under the main orchestrator: the Parent line names it, the Sub-orchestrator card is on and the reason is hidden and empty', () => {
    const r = open({ parent: mainRow(), role: 'agent' });
    assert.equal(r.node('#sp-parent').textContent, 'planner · orchestrator · pane %1');
    assert.equal(r.node('#sp-role-orch').disabled, false);
    assert.equal(r.node('#sp-role-orch').attrs['aria-describedby'], undefined);
    assert.equal(r.node('#sp-role-orch-card').dataset.off, undefined);
    assert.equal(r.node('#sp-role-why').hidden, true);
    assert.equal(r.node('#sp-role-why').textContent, '');
    assert.equal(r.node('#sp-role-orch-d').textContent, 'Plans the work and spawns up to 3 agents of its own. It may run only nika spawn and nika status.');
    assert.ok(r.synced.length >= 1, 'the card marks are synced');
  });

  test('(+) opened as a sub-orchestrator: title, button, radio, default name lead-1, the Orchestrator role model and the brief help follow', () => {
    const r = open({ parent: mainRow(), role: 'orchestrator' });
    assert.equal(r.node('#sp-h').textContent, 'Spawn sub-orchestrator');
    assert.equal(r.node('#sp-go').textContent, 'Spawn sub-orchestrator');
    assert.equal(r.node('#sp-role-orch').checked, true);
    assert.equal(r.node('#sp-role-agent').checked, false);
    assert.equal(r.node('#sp-name').value, 'lead-1');
    assert.equal(r.node('#sp-model').value, 'claude-fable-1');
    assert.equal(r.node('#sp-brief-help').textContent, "The sub-orchestrator's first message: the part of the work it plans and hands out. More than one word. It never passes through the tmux command line.");
  });

  test('(+) an agent opens with the Builder role model and the next free builder-N name', () => {
    const r = open();
    assert.equal(r.node('#sp-name').value, 'builder-3', 'builder-1 and builder-2 are taken');
    assert.equal(r.node('#sp-model').value, 'claude-sonnet-5-5');
  });

  test('(−) a sub-orchestrator parent cannot start another: the role falls back to Agent and the reason says three levels', () => {
    const r = open({ parent: subRow(), role: 'orchestrator' });
    assert.equal(r.node('#sp-parent').textContent, 'api-lead · sub-orchestrator · pane %2');
    assert.equal(r.node('#sp-role-agent').checked, true);
    assert.equal(r.node('#sp-role-orch').checked, false);
    assert.equal(r.node('#sp-role-orch').disabled, true);
    assert.equal(r.node('#sp-role-why').textContent, WHY_SUB);
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
  });

  test('(−) role "orchestrator" with no parent is not honoured either', () => {
    const r = open({ parent: null, role: 'orchestrator' });
    assert.equal(r.node('#sp-role-agent').checked, true);
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
  });

  test('(+) the counts note, from the snapshot: the parent\'s bucket and the project\'s', () => {
    assert.equal(open({ parent: mainRow() }).node('#sp-note').textContent, 'planner: 2 of 3 · demo-api: 3 of 9 running');
    assert.equal(open({ parent: subRow() }).node('#sp-note').textContent, 'api-lead: 1 of 3 · demo-api: 3 of 9 running');
    assert.equal(open().node('#sp-note').textContent, 'Spawned from nika: 0 of 3 · demo-api: 3 of 9 running');
  });

  test('(+) the counts follow Settings: 5 per orchestrator gives a cap of 15, and long names are cut at 24', () => {
    const agents = family();
    agents[0] = { ...agents[0], name: 'planner-with-a-very-long-name-indeed' };
    const r = open({ parent: agents[0] }, { agents, settings: { ...SETTINGS, limits: { maxAgents: 5 } }, groupOver: { label: 'demo-api-with-a-very-long-label-here' } });
    assert.equal(r.node('#sp-note').textContent, 'planner-with-a-very-lon…: 2 of 5 · demo-api-with-a-very-lo…: 3 of 15 running');
    assert.equal(r.node('#sp-role-orch-d').textContent, 'Plans the work and spawns up to 5 agents of its own. It may run only nika spawn and nika status.');
  });

  test('(+) a long parent name is whole in the Parent line (the dd wraps); it is cut only in the counts note', () => {
    const agents = family();
    agents[0] = { ...agents[0], name: 'planner-with-a-very-long-name-indeed' };
    const r = open({ parent: agents[0] }, { agents });
    assert.equal(r.node('#sp-parent').textContent, 'planner-with-a-very-long-name-indeed · orchestrator · pane %1');
  });

  test('(−) at a limit the sheet does not open: the reason is toasted instead', () => {
    const r = projRig({ settings: { ...SETTINGS, limits: { maxAgents: 2 } } });
    r.api.openSpawn(r.g, { parent: mainRow(), role: 'agent' });
    assert.equal(r.opened.length, 0);
    assert.equal(r.last().msg, `planner already runs 2 of 2 agents of its own. ${TAIL}`);
    assert.equal(r.last().kind, 'error');
  });

  test('(+) the Roles group shows an overridden role as "(this project)"', () => {
    const r = open({}, { settings: { ...SETTINGS, perProject: { [KEY]: { models: { builder: 'claude-opus-5-5' } } } } });
    const roles = r.node('#sp-model').kids[0];
    assert.equal(roles.attrs.label, 'Roles');
    assert.equal(roles.kids[0].textContent, 'Builder · claude-opus-5-5 (this project)');
    assert.equal(r.node('#sp-model').value, 'claude-opus-5-5');
  });
});

describe('the spawn sheet: switching the role (design 3)', () => {
  const opened = () => {
    const r = projRig();
    r.api.openSpawn(r.g, { parent: mainRow(), role: 'agent' });
    return r;
  };

  test('(+) agent to sub-orchestrator: title, button, brief help, the card marks, the untouched name and model all follow', () => {
    const r = opened();
    const before = r.synced.length;
    r.role('orchestrator');
    r.api.changeRole();
    assert.equal(r.node('#sp-h').textContent, 'Spawn sub-orchestrator');
    assert.equal(r.node('#sp-go').textContent, 'Spawn sub-orchestrator');
    assert.match(r.node('#sp-brief-help').textContent, /^The sub-orchestrator's first message/);
    assert.equal(r.node('#sp-name').value, 'lead-1');
    assert.equal(r.node('#sp-model').value, 'claude-fable-1');
    assert.ok(r.synced.length > before);
    r.role('agent');
    r.api.changeRole();
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
    assert.equal(r.node('#sp-name').value, 'builder-3');
    assert.equal(r.node('#sp-model').value, 'claude-sonnet-5-5');
    assert.match(r.node('#sp-brief-help').textContent, /^The agent's first message/);
  });

  test('(+) a name the user typed is kept, and so is a model the user picked', () => {
    const r = opened();
    r.node('#sp-name').value = 'my-helper';
    r.api.sp.touched = true; // the model select's change handler sets this
    r.node('#sp-model').value = 'haiku';
    r.role('orchestrator');
    r.api.changeRole();
    assert.equal(r.node('#sp-name').value, 'my-helper');
    assert.equal(r.node('#sp-model').value, 'haiku');
    assert.equal(r.node('#sp-h').textContent, 'Spawn sub-orchestrator', 'the words still follow');
  });

  test('(+) a remembered model is per role: the last agent model does not leak into the sub-orchestrator', () => {
    const r = opened();
    r.api.spawnPrefs.set(`${KEY}:agent`, { model: 'haiku' });
    r.api.spawnPrefs.set(`${KEY}:orchestrator`, { model: 'claude-opus-5-5' });
    r.role('orchestrator');
    r.api.changeRole();
    assert.equal(r.node('#sp-model').value, 'claude-opus-5-5');
    r.role('agent');
    r.api.changeRole();
    assert.equal(r.node('#sp-model').value, 'haiku');
  });

  test('(−) no change of role, a busy sheet or no open group: nothing moves', () => {
    const r = opened();
    r.api.changeRole(); // role still agent
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
    r.role('orchestrator');
    r.api.sp.busy = true;
    r.api.changeRole();
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
    assert.equal(r.node('#sp-name').value, 'builder-3');
    r.api.sp.busy = false;
    r.api.sp.group = null;
    r.api.changeRole();
    assert.equal(r.node('#sp-h').textContent, 'Spawn agent');
  });
});

describe('the spawn sheet: the request and the toasts (design 3)', () => {
  const READY = { status: 200, body: { sessionId: NEW, pane: '%9' } };
  /** Open under `parent`, fill the brief, submit; returns the rig once the request has been answered. */
  async function run({ parent = null, role = 'agent', reply = READY, tweak = null, rigOver = {} } = {}) {
    const r = projRig({ answers: { 'POST /api/app/spawn': reply }, ...rigOver });
    r.api.openSpawn(r.g, { parent, role });
    r.node('#sp-brief').value = 'Add the /health route and a test for it.';
    r.node('#dlg-spawn').open = true; // what openDialog does in the browser
    tweak?.(r);
    await r.api.submitSpawn({ preventDefault() {} });
    await settle();
    return r;
  }

  test('(+) from the header: role agent and no parent key at all', async () => {
    const r = await run();
    assert.equal(r.posts().length, 1);
    assert.deepEqual(r.posts()[0].json, { project: KEY, name: 'builder-3', model: 'claude-sonnet-5-5', brief: 'Add the /health route and a test for it.', role: 'agent' });
    assert.ok(!('parent' in r.posts()[0].json));
  });

  test('(+) under the main orchestrator as an agent: parent is its pane, role agent', async () => {
    const r = await run({ parent: mainRow() });
    assert.equal(r.posts()[0].json.parent, '%1');
    assert.equal(r.posts()[0].json.role, 'agent');
  });

  test('(+) the header sub-orchestrator: role orchestrator, parent the main orchestrator\'s pane, the Orchestrator model, name lead-1', async () => {
    const r = await run({ parent: mainRow(), role: 'orchestrator' });
    const body = r.posts()[0].json;
    assert.equal(body.role, 'orchestrator');
    assert.equal(body.parent, '%1');
    assert.equal(body.name, 'lead-1');
    assert.equal(body.model, 'claude-fable-1');
  });

  test('(+) the header button end to end: click Spawn sub-orchestrator, fill the sheet, submit; the request is exactly role orchestrator under the main orchestrator\'s pane', async () => {
    const r = projRig({ answers: { 'POST /api/app/spawn': READY } });
    r.api.groupActions(r.g, { primary: 'spawn', sub: true })[2].fire('click'); // the page's own button, not openSpawn called by the test
    assert.equal(r.opened.length, 1);
    r.node('#sp-brief').value = 'Plan the API work and split it between agents.';
    r.node('#dlg-spawn').open = true;
    await r.api.submitSpawn({ preventDefault() {} });
    await settle();
    assert.equal(r.posts().length, 1);
    assert.deepEqual(r.posts()[0].json, { project: KEY, name: 'lead-1', model: 'claude-fable-1', brief: 'Plan the API work and split it between agents.', role: 'orchestrator', parent: '%1' });
    assert.equal(r.last().msg, 'Spawned sub-orchestrator lead-1 under planner in pane %9');
  });

  test('(+) under a sub-orchestrator: parent is the sub-orchestrator\'s pane', async () => {
    const r = await run({ parent: subRow() });
    assert.equal(r.posts()[0].json.parent, '%2');
  });

  test('(+) the role the radios say at submit time is the role sent (a switch inside the sheet)', async () => {
    const r = await run({ parent: mainRow(), tweak: (x) => { x.role('orchestrator'); x.api.changeRole(); } });
    assert.equal(r.posts()[0].json.role, 'orchestrator');
    assert.equal(r.posts()[0].json.name, 'lead-1');
  });

  test('(+) success with no parent: "Spawned builder-3 in pane %9" with Open session; the sheet closes and the list is read again', async () => {
    const r = await run();
    assert.equal(r.last().msg, 'Spawned builder-3 in pane %9');
    assert.equal(r.last().kind, 'info');
    assert.equal(r.last().action.label, 'Open session');
    r.last().action.run();
    assert.equal(r.navs.length, 1);
    assert.match(r.navs[0], new RegExp(`session=${NEW}`));
    assert.equal(r.node('#dlg-spawn').open, false);
    assert.ok(r.calls.some((c) => c.method === 'GET' && c.url === '/api/app/projects'), 'the list is polled');
    assert.deepEqual(r.renders, [true]);
  });

  test('(+) success under a parent: "Spawned builder-3 under planner in pane %9"', async () => {
    assert.equal((await run({ parent: mainRow() })).last().msg, 'Spawned builder-3 under planner in pane %9');
  });

  test('(+) success of a sub-orchestrator: "Spawned sub-orchestrator lead-1 under planner in pane %9"', async () => {
    assert.equal((await run({ parent: mainRow(), role: 'orchestrator' })).last().msg, 'Spawned sub-orchestrator lead-1 under planner in pane %9');
  });

  test('(+) a success remembers the model for that role only', async () => {
    const r = await run({ parent: mainRow(), role: 'orchestrator' });
    assert.equal(r.api.spawnPrefs.get(`${KEY}:orchestrator`).model, 'claude-fable-1');
    assert.equal(r.api.spawnPrefs.get(`${KEY}:agent`), undefined);
  });

  test('(+) while it runs the sheet is busy (Cancel and the role radios off); afterwards they are back', async () => {
    let during = null;
    const r = projRig({ answers: { 'POST /api/app/spawn': () => { during = [r.node('#sp-cancel').disabled, r.node('#sp-role').disabled, r.node('#dlg-spawn').dataset.busy, r.node('#sp-go').busyLabel]; return READY; } } });
    r.api.openSpawn(r.g, { parent: mainRow() });
    r.node('#sp-brief').value = 'Add the /health route and a test for it.';
    await r.api.submitSpawn({ preventDefault() {} });
    assert.deepEqual(during, [true, true, '1', 'Starting builder-3…']);
    assert.deepEqual([r.node('#sp-cancel').disabled, r.node('#sp-role').disabled, r.node('#dlg-spawn').dataset.busy], [false, false, undefined]);
  });

  const alertOf = (r) => ({ text: r.node('#sp-alert-text').textContent, shown: r.node('#sp-alert').hidden === false, focused: focus.el === r.node('#sp-alert') });
  const refuse = (status, body) => ({ status, body });

  test('(+) 409 limit, scope parent, under a parent: its name, the counts the server sent, and the Settings hint; fields kept, focus on the alert', async () => {
    const r = await run({ parent: mainRow(), reply: refuse(409, { error: 'limit', message: 'server words', scope: 'parent', running: 3, max: 3 }) });
    assert.deepEqual(alertOf(r), { text: `planner already runs 3 of 3 agents of its own. ${TAIL}`, shown: true, focused: true });
    assert.equal(r.node('#sp-name').value, 'builder-3');
    assert.equal(r.node('#sp-brief').value, 'Add the /health route and a test for it.');
    assert.equal(r.node('#dlg-spawn').open, true, 'the sheet stays open');
    assert.equal(r.texts().length, 0, 'no success toast');
  });

  test('(+) F4: tmux_unavailable, tmux_failed and claude_exited show their sentence in the sheet\'s alert; the sheet stays open, nothing navigates, no toast', async () => {
    const EXITED = 'Claude exited right after it started. Run `claude` once in a terminal in this folder to see why (for example, to log in).';
    for (const [reply, text] of [
      [refuse(503, { error: 'tmux_unavailable', message: 'tmux not found (add it to PATH or set NIKA_TMUX)' }), 'tmux not found. Install tmux 3.2 or newer, then try again.'],
      [refuse(502, { error: 'tmux_failed', message: 'tmux failed: no space left on device' }), 'tmux failed: no space left on device'],
      [refuse(502, { error: 'claude_exited', message: 'server words' }), EXITED],
    ]) {
      const r = await run({ reply });
      assert.deepEqual(alertOf(r), { text, shown: true, focused: true });
      assert.equal(r.node('#dlg-spawn').open, true);
      assert.deepEqual([r.navs, r.texts()], [[], []]);
      assert.equal(r.node('#sp-brief').value, 'Add the /health route and a test for it.', 'the fields are kept');
    }
  });

  test('(−) F4: any other code keeps the server\'s words in the alert', async () => {
    const r = await run({ reply: refuse(503, { error: 'claude_unavailable', message: 'claude not found (add it to PATH or set NIKA_CLAUDE)' }) });
    assert.equal(alertOf(r).text, 'claude not found (add it to PATH or set NIKA_CLAUDE)');
  });

  test('(+) 409 limit, scope parent, from the header ("you"): the "You already run..." line', async () => {
    const r = await run({ reply: refuse(409, { error: 'limit', scope: 'parent', running: 3, max: 3 }) });
    assert.equal(alertOf(r).text, `You already run 3 of 3 agents spawned from nika in demo-api. ${TAIL}`);
  });

  test('(+) 409 limit, scope project: the cap line, whoever the parent is', async () => {
    const want = 'demo-api already runs 9 of 9 agents, the most one project can run. Wait for one to finish.';
    assert.equal(alertOf(await run({ reply: refuse(409, { error: 'limit', scope: 'project', running: 9, max: 9 }) })).text, want);
    assert.equal(alertOf(await run({ parent: mainRow(), reply: refuse(409, { error: 'limit', scope: 'project', running: 9, max: 9 }) })).text, want);
  });

  test('(+) 409 depth on a sub-orchestrator request: the three-levels line naming the parent; nothing was started', async () => {
    const r = await run({ parent: mainRow(), role: 'orchestrator', reply: refuse(409, { error: 'depth', message: 'server words' }) });
    assert.equal(alertOf(r).text, "planner can't start a sub-orchestrator. Only the main orchestrator can: nika allows three levels (orchestrator, sub-orchestrators, their agents). Nothing was started.");
  });

  test('(+) 404 for a parent that is gone: "<parent> is no longer running, so nothing was started..."', async () => {
    const r = await run({ parent: mainRow(), reply: refuse(404, { error: 'not_found', message: 'server words' }) });
    assert.equal(alertOf(r).text, 'planner is no longer running, so nothing was started. Close this and spawn from a session that is running.');
  });

  test('(−) 404 from the header (no parent) is the server\'s own message, not a "parent gone" line', async () => {
    const r = await run({ reply: refuse(404, { error: 'not_found', message: 'Project not found.' }) });
    assert.equal(alertOf(r).text, 'Project not found.');
  });

  test('(−) 404 while an "under" pane is also sent: the pane that is gone may be that one, so the server\'s words stand', async () => {
    const r = await run({
      parent: mainRow(), reply: refuse(404, { error: 'not_found', message: 'That pane is not running.' }),
      tweak: (x) => { x.api.sp.under = '%4'; x.node('input[name="sp-place"]:checked').value = 'under'; },
    });
    assert.equal(r.posts()[0].json.under, '%4');
    assert.equal(alertOf(r).text, 'That pane is not running.');
  });

  test('(−) 409 depth on a plain agent request, and any other 409 or 400 (the reserved name), show the server\'s message', async () => {
    assert.equal(alertOf(await run({ parent: mainRow(), reply: refuse(409, { error: 'depth', message: 'That parent cannot have children.' }) })).text, 'That parent cannot have children.');
    assert.equal(alertOf(await run({ reply: refuse(409, { error: 'conflict', message: 'An agent named builder-3 is running.' }) })).text, 'An agent named builder-3 is running.');
    assert.equal(alertOf(await run({ reply: refuse(400, { error: 'invalid', message: 'orchestrator is reserved' }) })).text, 'orchestrator is reserved');
  });

  test('(−) a 409 limit whose body is malformed (unknown scope, counts that are not whole numbers) falls back to the server\'s message', async () => {
    for (const body of [{ scope: 'galaxy', running: 3, max: 3 }, { scope: 'parent', running: '3', max: 3 }, { scope: 'project', running: 3 }, {}]) {
      const r = await run({ reply: refuse(409, { error: 'limit', message: 'Too many agents.', ...body }) });
      assert.equal(alertOf(r).text, 'Too many agents.', JSON.stringify(body));
    }
  });

  test('(−) no answer: "Could not reach the nika server."', async () => {
    const r = projRig();
    r.api.openSpawn(r.g, { parent: mainRow() });
    r.node('#sp-brief').value = 'Add the /health route and a test for it.';
    await r.api.submitSpawn({ preventDefault() {} });
    assert.equal(alertOf(r).text, 'Could not reach the nika server.');
  });

  test('(−) a brief of one word is refused before any request, with the role unchanged', async () => {
    const r = await run({ tweak: (x) => { x.node('#sp-brief').value = 'update'; } });
    assert.equal(r.posts().length, 0);
    assert.equal(alertOf(r).text, '1 field needs a fix before spawning.');
  });
});

describe('Settings, the New agents card and Remove project (design 2.5)', () => {
  const cardRows = (card) => {
    const dl = card.all((n) => n.tag === 'dl')[0];
    const pairs = [];
    for (let i = 0; i < dl.kids.length; i += 2) pairs.push([dl.kids[i].textContent, dl.kids[i + 1].textContent]);
    return pairs;
  };
  const newAgents = (r, ...args) => r.api.setupCards(r.proj, r.g, ...args).find((c) => c.all((n) => n.tag === 'h2')[0]?.textContent === 'New agents');

  test('(+) the New agents card: Permission mode, Pane, Per orchestrator, Spawned from nika, This project', () => {
    const r = projRig();
    assert.deepEqual(cardRows(newAgents(r)), [
      ['Permission mode', 'Default'], ['Pane', 'Beside'], ['Per orchestrator', '3 at once'], ['Spawned from nika', '0 of 3'], ['This project', '3 of 9 running'],
    ]);
    assert.equal(newAgents(r).all(withClass('limit')).length, 0, 'no note below the limits');
  });

  // F6: the card shows the mode as the session header's chip (colour class, icon, short word), not as a sentence. Written out here on purpose.
  const CHIPS = {
    default: ['m-default', '#i-gear', 'Default'],
    manual: ['m-manual', '#i-m-manual', 'Manual'],
    acceptEdits: ['m-edits', '#i-m-edits', 'Accept edits'],
    plan: ['m-plan', '#i-m-plan', 'Plan'],
    auto: ['m-auto', '#i-m-auto', 'Auto'],
    dontAsk: ['m-dontask', '#i-m-dontask', "Don't ask"],
  };

  test('(+) the Permission mode value is a mode chip with the short label, the mode\'s icon and its colour class, for every mode', () => {
    for (const [mode, [cls, href, label]] of Object.entries(CHIPS)) {
      const r = projRig({ settings: { ...SETTINGS, permissionMode: mode } });
      const dd = newAgents(r).all((n) => n.tag === 'dd')[0];
      const chip = dd.all(withClass('mode'))[0];
      assert.ok(chip, mode);
      assert.equal(chip.className, `mode ${cls}`, mode);
      assert.equal(chip.all((n) => n.tag === 'use')[0].attrs.href, href, mode);
      assert.equal(chip.all(withClass('ml'))[0].textContent, label, mode);
      assert.equal(dd.kids.length, 1, 'the chip alone');
    }
  });

  test('(+) the chip is the one the session header builds (modeEl): same class and title; its text drops only the spoken "Permission mode: ", which the card\'s label says', () => {
    for (const mode of ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk']) {
      const r = projRig({ settings: { ...SETTINGS, permissionMode: mode } });
      const chip = newAgents(r).all(withClass('mode'))[0];
      const header = modeEl(mode);
      assert.equal(chip.className, header.className, mode);
      assert.equal(`Permission mode: ${chip.textContent}`, header.textContent, mode);
      assert.equal(chip.attrs.title, header.attrs.title, mode);
    }
  });

  test('(−) the long descriptions are not on the card: they stay in the spawn sheet\'s select', () => {
    for (const mode of Object.keys(CHIPS)) {
      const r = projRig({ settings: { ...SETTINGS, permissionMode: mode } });
      const text = newAgents(r).textContent;
      for (const gone of ['classifier', 'approves actions', 'ask every time', 'no flag', 'Claude Code default', 'without asking you']) assert.ok(!text.includes(gone), `${mode}: ${gone}`);
    }
    const r = projRig({ settings: { ...SETTINGS, permissionMode: 'auto' } });
    r.api.openSpawn(r.g);
    const options = r.node('#sp-perm').kids.map((o) => o.textContent);
    assert.ok(options.includes('Auto: a classifier approves actions without asking you'), 'the select keeps the warning copy');
    assert.ok(options.includes('Manual: ask every time') && options.includes('Claude Code default (no flag)'));
  });

  test('(−) a value Settings cannot hold shows the "Mode ?" chip, never raw text', () => {
    const r = projRig({ settings: { ...SETTINGS, permissionMode: '<b>x</b>' } });
    const chip = newAgents(r).all(withClass('mode'))[0];
    assert.equal(chip.className, 'mode m-unknown');
    assert.ok(!newAgents(r).textContent.includes('<b>'));
  });

  test('(+) the counts follow the snapshot and Settings', () => {
    const r = projRig({ settings: { ...SETTINGS, limits: { maxAgents: 5 } } });
    const rows = cardRows(newAgents(r));
    assert.deepEqual(rows.slice(2), [['Per orchestrator', '5 at once'], ['Spawned from nika', '0 of 5'], ['This project', '3 of 15 running']]);
  });

  test('(+) the project cap reached: the note says so and that spawning is off until one ends', () => {
    const loose = [mainRow(), ...Array.from({ length: 3 }, (_, i) => ag(`dddddddd-0000-4000-8000-00000000000${i}`, `builder-${i + 5}`, { parent: '%77', pane: { id: `%${60 + i}`, command: 'claude' } }))];
    const r = projRig({ agents: loose, settings: { ...SETTINGS, limits: { maxAgents: 1 } } });
    const note = newAgents(r).all(withClass('limit'))[0];
    assert.equal(note.attrs.id, 'limit-note');
    assert.equal(note.textContent, 'Limit reached: 3 of 3 agents are running in this project. Spawning is off until one ends.');
  });

  test('(+) your own bucket full (below the cap): the note points at an orchestrator\'s row', () => {
    const own = Array.from({ length: 3 }, (_, i) => ag(`eeeeeeee-0000-4000-8000-00000000000${i}`, `builder-${i + 5}`, { parent: null, pane: { id: `%${70 + i}`, command: 'claude' } }));
    const r = projRig({ agents: [mainRow(), ...own] });
    assert.equal(newAgents(r).all(withClass('limit'))[0].textContent, "Limit reached: you run 3 of 3 agents spawned from nika. Spawn from an orchestrator's row, or wait for one to end.");
  });

  test('(−) before Settings has loaded the card still shows the default limit of 3 and dashes for the rest', () => {
    const r = projRig({ settings: null });
    assert.deepEqual(cardRows(newAgents(r)).slice(0, 3), [['Permission mode', '–'], ['Pane', '–'], ['Per orchestrator', '3 at once']]);
  });

  test('(+) Remove project: the dialog says what is forgotten and that running agents keep running', () => {
    const r = projRig();
    r.api.confirmRemove(r.proj);
    assert.equal(r.node('#cf-d').textContent, 'nika stops listing this project and forgets its plugin and model choices and its saved orchestrator. No files change and running agents keep running.');
    assert.equal(r.node('#cf-h').textContent, 'Remove demo-api from nika?');
    assert.equal(r.node('#cf-ok').textContent, 'Remove project');
    assert.equal(r.opened.length, 1);
  });

  test('(+) Settings: the label is "Agents per orchestrator" with the new help; the old label is gone; the Models line mentions the project override', () => {
    const html = read('index.html');
    assert.match(html, /<label for="set-max">Agents per orchestrator<\/label>/);
    assert.match(html, /id="set-max-help">1 to 8\. How many agents each orchestrator can run at once; the agents you spawn from nika share one more such limit\. One project runs at most 3 times this number, and never more than 24\.<\/p>/);
    assert.ok(!html.includes('Agents per project at once'));
    assert.ok(!html.includes('Counts only agents nika spawned that are still running'));
    assert.match(html, /<p>Which model plays each role when nika starts an orchestrator or spawns an agent\. A project can override them on its page\.<\/p>/);
  });
});

describe('markup and styles the code relies on', () => {
  const html = read('index.html');
  const css = read('app.css');

  test('(+) the sprite has the sub-spawn and chevron icons, and every id the sheet code reads exists once', () => {
    for (const id of ['i-sub-spawn', 'i-chev']) assert.equal(html.split(`<symbol id="${id}"`).length - 1, 1, id);
    for (const id of ['sp-parent', 'sp-role', 'sp-role-agent', 'sp-role-orch', 'sp-role-orch-card', 'sp-role-orch-d', 'sp-role-why', 'sp-note', 'sp-h', 'sp-go', 'sp-brief-help', 'sp-alert', 'sp-alert-text']) {
      assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
    }
  });

  test('(+) the sub-orchestrator radio starts disabled, the reason line starts hidden, and the Parent row is a dl.kv.sp-kv', () => {
    assert.match(html, /<input type="radio" name="sp-role" value="orchestrator" id="sp-role-orch"[^>]* disabled>/);
    assert.match(html, /<p class="help" id="sp-role-why" hidden><\/p>/);
    assert.match(html, /<dl class="kv sp-kv"><dt>Parent<\/dt><dd id="sp-parent"/);
  });

  test('(+) the new rules exist: tree toggle, slot, elbow, hidden count, orphan mark, off card, sp-kv, and the narrow overrides', () => {
    for (const sel of ['.tree-tg', '.tree-sp', '.elbow', '.tree-hid', '.tree-orphan', '.radio-card[data-off="true"]', '.sp-kv', '.row[data-depth="2"] .elbow', '.row[data-depth="3"] .elbow']) {
      assert.ok(css.includes(sel), sel);
    }
    assert.match(css, /\.tree-tg\[aria-expanded="false"\] \.ic \{ transform: rotate\(-90deg\); \}/);
  });

  test('(−) the new page code builds no markup from data: no innerHTML, outerHTML, insertAdjacentHTML or inline style in app.js, project.js, dash-model.js', () => {
    for (const f of ['app.js', 'project.js', 'dash-model.js', 'ui.js']) {
      const src = code(read(f));
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), f);
      assert.ok(!/\.style\b|setAttribute\('style'|'style':/.test(src), f);
    }
  });

  test('(+) initApp wires both role radios to changeRole, and the model select and custom field mark the model as touched', () => {
    const src = code(read('project.js'));
    assert.match(src, /for \(const id of \['#sp-role-agent', '#sp-role-orch'\]\) \$\(id\)\.addEventListener\('change', changeRole\);/);
    assert.match(src, /\$\('#sp-model'\)\.addEventListener\('change', \(\) => \{[^}]*sp\.touched = true;/);
    assert.match(src, /\$\('#sp-model-custom'\)\.addEventListener\('input', \(\) => \{ sp\.touched = true; \}\);/);
  });
});
