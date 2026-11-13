// 0.3.1: "Show ended" hides ended agents on the dashboard, and the sidebar lists a hint and the detected repositories.
// The decisions are pure functions in public/dash-model.js (tested here in Node); the page code that draws them cannot be imported
// (app.js starts the page when loaded), so agentNodes and showGroup run in a vm against stubs and the wiring is pinned by source.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { load, loadFlag } from '../public/ui.js';
import {
  DETECTED_MAX, skippedText, endedPlan, noMatchText, resetEndedState, sidebarModel, orchState, roleTag, savedPick, otherRunning, ROLE_TAGS,
  statusOf, STATUS_ORDER, parentOf, treeRows, hasTree, spawnLimits,
} from '../public/dash-model.js';

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
const HTML = read('index.html');
const CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- a tiny node tree for the page code that runs in a vm -----------------------------------------------------------------------

const makeNode = (tag, attrs, kids) => ({
  tag, attrs: attrs ?? {}, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false), listeners: {},
  addEventListener(type, f) { this.listeners[type] = f; },
  append(...more) { this.kids.push(...more); },
});
const textOf = (n) => (typeof n === 'string' ? n : (n.attrs?.text ?? '') + (n.kids ?? []).map(textOf).join(''));
/** Every element under (and including) `n`, depth first. */
const walk = (n) => (typeof n === 'string' ? [] : [n, ...(n.kids ?? []).flatMap(walk)]);

// ---- endedPlan ------------------------------------------------------------------------------------------------------------

describe('endedPlan (what a group draws for its ended agents)', () => {
  const plan = (live, ended, showEnded, collapsed) => endedPlan({ live, ended, showEnded, collapsed });

  test('(+) unchecked, live and ended agents: the live rows only, no Ended section, no line', () => {
    assert.deepEqual(plan(2, 3, false), { endedSection: false, open: false, noLiveLine: false });
  });

  test('(+) unchecked, only ended agents: no Ended section, and the one line "No live agents." instead of the rows', () => {
    assert.deepEqual(plan(0, 4, false), { endedSection: false, open: false, noLiveLine: true });
  });

  test('(+) checked: the Ended section is there and open, with live agents or without', () => {
    assert.deepEqual(plan(2, 3, true), { endedSection: true, open: true, noLiveLine: false });
    assert.deepEqual(plan(0, 3, true), { endedSection: true, open: true, noLiveLine: false }, 'a group of ended agents only still opens its section');
  });

  test('(+) checked, folded by hand: the section stays, closed', () => {
    assert.deepEqual(plan(1, 1, true, true), { endedSection: true, open: false, noLiveLine: false });
  });

  test('(−) checked with no ended agents: no section and no line', () => {
    assert.deepEqual(plan(2, 0, true), { endedSection: false, open: false, noLiveLine: false });
    assert.deepEqual(plan(0, 0, true, true), { endedSection: false, open: false, noLiveLine: false });
  });

  test('(−) unchecked with no agents at all: no line (the empty project box has its own copy)', () => {
    assert.equal(plan(0, 0, false).noLiveLine, false);
  });

  test('(−) unchecked ignores a manual fold or open: there is nothing to open', () => {
    assert.deepEqual(plan(0, 2, false, true), plan(0, 2, false, false));
    assert.equal(plan(1, 2, false, true).endedSection, false);
  });

  test('(−) the line never shows next to live rows or next to the section', () => {
    for (const live of [0, 1, 7]) {
      for (const ended of [0, 1, 3]) {
        for (const showEnded of [false, true]) {
          for (const collapsed of [false, true]) {
            const p = endedPlan({ live, ended, showEnded, collapsed });
            assert.equal(p.noLiveLine && (live > 0 || p.endedSection), false, JSON.stringify({ live, ended, showEnded, collapsed }));
            assert.equal(p.open && !p.endedSection, false, 'open only means something for a section that exists');
          }
        }
      }
    }
  });
});

// ---- the manual state of the dashboard's Ended sections -----------------------------------------------------------------------

describe('resetEndedState (the checkbox changes: every dashboard section starts open again)', () => {
  test('(+) forgets the open and the closed-on-purpose marks of every dashboard group, whatever the group key', () => {
    const open = new Set(['ended:g:k1', '!ended:g:k1', '!ended:g:abcdef0123456789', 'ended:g:g2']);
    resetEndedState(open);
    assert.deepEqual([...open], []);
  });

  test('(−) leaves the project view\'s sections, the subagent lists and every other mark alone', () => {
    const keep = ['ended:pv:abcdef0123456789', '!ended:pv:abcdef0123456789', 'subs:agent-a', 'g:k1', '!subs:agent-a'];
    const open = new Set(['!ended:g:k1', ...keep]);
    resetEndedState(open);
    assert.deepEqual([...open], keep);
  });

  test('(+) the project view\'s own toggle forgets only the project sections (view "pv"), and the dashboard ones stay', () => {
    const open = new Set(['ended:pv:abcdef0123456789', '!ended:pv:abcdef0123456789', 'ended:pv:fedcba9876543210', '!ended:g:k1', 'ended:g:k2', 'subs:agent-a']);
    resetEndedState(open, 'pv');
    assert.deepEqual([...open], ['!ended:g:k1', 'ended:g:k2', 'subs:agent-a']);
  });

  test('(−) a view name that is not a plain word forgets nothing (it is never turned into a pattern)', () => {
    const open = new Set(['ended:pv:k1', '!ended:g:k1']);
    resetEndedState(open, '.*');
    resetEndedState(open, 'pv|g');
    assert.deepEqual([...open], ['ended:pv:k1', '!ended:g:k1']);
  });

  test('(−) an empty set stays empty, and a key that only contains the prefix somewhere else is kept', () => {
    const empty = new Set();
    resetEndedState(empty);
    assert.equal(empty.size, 0);
    const odd = new Set(['x-ended:g:k1']);
    resetEndedState(odd);
    assert.deepEqual([...odd], ['x-ended:g:k1']);
  });
});

// ---- sidebarModel ---------------------------------------------------------------------------------------------------------------

describe('sidebarModel (the sidebar\'s Projects list and its Detected repositories)', () => {
  const proj = (key, name, dir = `/r/${name}`) => ({ key, name, dir });
  const counts = (attn = 0, live = 0, ended = 0) => ({ attn, idle: 0, busy: 0, ended, live });
  const grp = (key, label, c, project = null, root = `/r/${label}`) => ({ key, label, root, project, counts: c, agents: [] });
  const names = (list) => list.map((r) => r.name);

  test('(+) no registered projects: empty is true (the page shows the hint) and the list has no rows', () => {
    const m = sidebarModel({ projects: [], groups: [] });
    assert.deepEqual(m, { empty: true, rows: [], detected: [], detectedMore: 0 });
  });

  test('(+) registered projects are listed in their own order with the counts of their group; a project without agents shows 0 and 0', () => {
    const p1 = proj('p1', 'alpha');
    const p2 = proj('p2', 'beta');
    const m = sidebarModel({ projects: [p1, p2], groups: [grp('p2', 'beta', counts(1, 3), p2), grp('p1', 'alpha', counts(), p1)] });
    assert.equal(m.empty, false);
    assert.deepEqual(m.rows, [{ key: 'p1', name: 'alpha', attn: 0, live: 0 }, { key: 'p2', name: 'beta', attn: 1, live: 3 }]);
  });

  test('(+) Detected = unregistered repositories with at least one live agent, with name, key and counts', () => {
    const m = sidebarModel({ projects: [], groups: [grp('d1', 'gamma', counts(0, 2)), grp('d2', 'delta', counts(1, 1))] });
    assert.deepEqual(m.detected, [{ key: 'd2', name: 'delta', attn: 1, live: 1 }, { key: 'd1', name: 'gamma', attn: 0, live: 2 }]);
    assert.equal(m.empty, true, 'the hint and the Detected list can show together');
  });

  test('(+) Detected is ordered by agents that need you, then live agents, then name', () => {
    const groups = [
      grp('a', 'zulu', counts(0, 5)), grp('b', 'alpha', counts(0, 2)), grp('c', 'mike', counts(0, 2)),
      grp('d', 'lima', counts(2, 2)), grp('e', 'kilo', counts(1, 9)), grp('f', 'oscar', counts(2, 4)),
    ];
    assert.deepEqual(names(sidebarModel({ projects: [], groups }).detected), ['oscar', 'lima', 'kilo', 'zulu', 'alpha', 'mike']);
  });

  test('(+) 8 rows by default, the best 8 by that order, and `detectedMore` counts the rest (F1b)', () => {
    const groups = Array.from({ length: 11 }, (_, i) => grp(`d${i}`, `repo-${String(i).padStart(2, '0')}`, counts(0, i + 1)));
    const m = sidebarModel({ projects: [], groups });
    assert.equal(DETECTED_MAX, 8);
    assert.equal(m.detected.length, 8);
    assert.deepEqual(m.detected.map((r) => r.live), [11, 10, 9, 8, 7, 6, 5, 4]);
    assert.equal(m.detectedMore, 3);
  });

  test('(+) `showAll` lists every detected repository in the same order and leaves nothing behind the button (F1b)', () => {
    const groups = Array.from({ length: 11 }, (_, i) => grp(`d${i}`, `repo-${String(i).padStart(2, '0')}`, counts(0, i + 1)));
    const m = sidebarModel({ projects: [], groups, showAll: true });
    assert.deepEqual(m.detected.map((r) => r.live), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert.equal(m.detectedMore, 0);
  });

  test('(−) 8 or fewer detected repositories: no "more" count, with showAll or without', () => {
    const groups = Array.from({ length: 8 }, (_, i) => grp(`d${i}`, `repo-${i}`, counts(0, i + 1)));
    assert.equal(sidebarModel({ projects: [], groups }).detectedMore, 0);
    assert.equal(sidebarModel({ projects: [], groups, showAll: true }).detectedMore, 0);
    assert.equal(sidebarModel({ projects: [], groups: [] }).detectedMore, 0);
  });

  test('(−) a repository with only ended agents is not detected', () => {
    const m = sidebarModel({ projects: [], groups: [grp('d1', 'gamma', counts(0, 0, 3)), grp('d2', 'delta', counts())] });
    assert.deepEqual(m.detected, []);
  });

  test('(−) a registered repository never appears in Detected, whichever way the group knows it', () => {
    const p1 = proj('p1', 'alpha', '/r/alpha');
    const groups = [
      grp('p1', 'alpha', counts(1, 2), p1), // the group carries its project
      grp('p1', 'alpha', counts(1, 2), null, '/elsewhere'), // only its key matches
      grp('x9', 'alpha-copy', counts(0, 1), null, '/r/alpha'), // only its folder matches
      grp('d1', 'gamma', counts(0, 1)),
    ];
    const m = sidebarModel({ projects: [p1], groups });
    assert.deepEqual(names(m.detected), ['gamma']);
    assert.deepEqual(m.rows, [{ key: 'p1', name: 'alpha', attn: 1, live: 2 }]);
  });

  test('(−) no unregistered repository with live agents: no Detected rows (the page hides the list)', () => {
    const p1 = proj('p1', 'alpha');
    assert.deepEqual(sidebarModel({ projects: [p1], groups: [grp('p1', 'alpha', counts(0, 1), p1)] }).detected, []);
  });

  test('(−) it reads its inputs only: the arrays it was given are not reordered', () => {
    const groups = [grp('a', 'bravo', counts(0, 1)), grp('b', 'alpha', counts(1, 1))];
    const before = JSON.stringify(groups);
    sidebarModel({ projects: [], groups });
    assert.equal(JSON.stringify(groups), before);
  });

  test('(+) the project list has not loaded (null): no hint, no rows and no Detected, even with live unregistered groups', () => {
    const groups = [grp('d1', 'gamma', counts(0, 2)), grp('d2', 'delta', counts(1, 1))];
    assert.deepEqual(sidebarModel({ projects: null, groups }), { empty: false, rows: [], detected: [], detectedMore: 0 });
    assert.deepEqual(sidebarModel({ projects: null, groups: [] }), { empty: false, rows: [], detected: [], detectedMore: 0 });
  });

  test('(−) a loaded empty list (not null) still shows the hint and fills Detected as before', () => {
    const groups = [grp('d1', 'gamma', counts(0, 2)), grp('d2', 'delta', counts(1, 1))];
    assert.deepEqual(sidebarModel({ projects: [], groups }), {
      empty: true, rows: [], detected: [{ key: 'd2', name: 'delta', attn: 1, live: 1 }, { key: 'd1', name: 'gamma', attn: 0, live: 2 }], detectedMore: 0,
    });
  });
});

// ---- the note for skipped session files (F1b) -------------------------------------------------------------------------------------

describe('skippedText (the dashboard note; the same words as `nika status`)', () => {
  test('(+) a count of 2 or more: the exact line', () => {
    assert.equal(skippedText(3), "3 session files skipped (unreadable or not in Claude's format)");
  });

  test('(+) a count of 1 reads in the singular', () => {
    assert.equal(skippedText(1), "1 session file skipped (unreadable or not in Claude's format)");
  });

  test('(−) nothing skipped, or a value that is not a positive whole number: no note', () => {
    for (const v of [0, -1, 1.5, NaN, Infinity, '3', null, undefined, {}]) assert.equal(skippedText(v), null, String(v));
  });

  test('(+) nika status prints the same words (the browser page cannot import src/, so both spell the line)', () => {
    const cli = fs.readFileSync(path.join(PUBLIC, '..', 'src', 'cli.js'), 'utf8');
    assert.ok(cli.includes("session file${n === 1 ? '' : 's'} skipped (unreadable or not in Claude's format)"), 'cli.js spells the line');
    assert.ok(read('dash-model.js').includes("session file${n === 1 ? '' : 's'} skipped (unreadable or not in Claude's format)"), 'dash-model.js spells it the same');
  });
});

describe('the dashboard draws the note as a muted line above the groups, not as a banner (F1b)', () => {
  const rig = (data) => {
    const swaps = [];
    const ctx = {
      state: { data, projects: null, modes: { map: {} }, filter: '', showEnded: false, open: new Set(), expanded: new Set(), me: null, error: null },
      isApp: false, interacting: () => false, dashboardNodes: () => [makeNode('p', { text: 'groups' }, [])], skippedText,
      $: () => ({ classList: { toggle() {} } }), swap: (host, nodes) => swaps.push(nodes),
      h: (tag, attrs, ...kids) => makeNode(tag, attrs, kids),
    };
    const src = `${/let dashSig = '';/.exec(APP)[0]}\n${fn(APP, 'function skippedNote(')}\n${fn(APP, 'function renderDashboard(')}`;
    const { renderDashboard } = vm.runInNewContext(`${src}\n({ renderDashboard })`, ctx);
    return { renderDashboard, swaps };
  };
  const tops = (swaps) => Array.from(swaps.at(-1)).filter(Boolean).map((n) => `${n.tag}${n.attrs.class ? `.${n.attrs.class.split(' ').join('.')}` : ''}:${textOf(n)}`);

  test('(+) skipped files: a muted <p> first, then the groups', () => {
    const { renderDashboard, swaps } = rig({ groups: [], skipped: { registry: 2 } });
    renderDashboard(true);
    assert.deepEqual(tops(swaps), ["p.skip-note.muted:2 session files skipped (unreadable or not in Claude's format)", 'p:groups']);
  });

  test('(−) none skipped, an older server that sends no field, or junk: no note, only the groups', () => {
    for (const skipped of [{ registry: 0 }, undefined, { registry: 'x' }, null]) {
      const { renderDashboard, swaps } = rig({ groups: [], skipped });
      renderDashboard(true);
      assert.deepEqual(tops(swaps), ['p:groups'], JSON.stringify(skipped));
    }
  });

  test('(+) a change in the count redraws the dashboard; the same count does not', () => {
    const data = { groups: [], skipped: { registry: 1 } };
    const { renderDashboard, swaps } = rig(data);
    renderDashboard();
    renderDashboard();
    assert.equal(swaps.length, 1);
    data.skipped = { registry: 2 };
    renderDashboard();
    assert.equal(swaps.length, 2);
  });

  test('(−) not an error banner: the sources banner never mentions the skipped count', () => {
    assert.doesNotMatch(fn(APP, 'function bannerList('), /skipped/);
  });
});

// ---- agentNodes and groupMatches (app.js, run against stubs) ----------------------------------------------------------------------

describe('agentNodes with "Show ended"', () => {
  const sigOf = (n) => `${n.tag}${n.attrs.class ? `.${n.attrs.class.split(' ').join('.')}` : ''}`;
  const sigs = (nodes) => Array.from(nodes, sigOf); // Array.from: the vm's arrays have another prototype than deepEqual expects

  const rig = ({ showEnded = false, open = [] } = {}) => {
    const ctx = {
      isApp: true,
      state: { showEnded, open: new Set(open), expanded: new Set() },
      hooks: {},
      ORDER: { attn: 0, idle: 1, busy: 2, ended: 3 },
      ROW_CAP: 12,
      endedPlan,
      statusOf,
      treeRows,
      hasTree,
      endedScope: (s) => `${s}-e`,
      render: () => {},
      h: (tag, attrs, ...kids) => makeNode(tag, attrs, kids),
      rowsEl: (list, g, opts, label) => makeNode('ul', { class: 'rows', 'aria-label': label, 'data-scope': opts.scope }, list.map((a) => makeNode('li', { text: a.name }, []))),
      treeEl: (rows, g, scope, label) => makeNode('ul', { class: 'rows', 'aria-label': label, 'data-scope': scope, 'data-tree': 'yes' }, rows.map((r) => makeNode('li', { text: r.a.name }, []))),
    };
    const src = [fn(APP, 'export function sOf(').replace('export ', ''), fn(APP, 'function matches('), /const byStatus = [^\n]+/.exec(APP)[0],
      fn(APP, 'function groupMatches('), fn(APP, 'export function agentNodes(').replace('export ', '')].join('\n');
    return { ctx, ...vm.runInNewContext(`${src}\n({ agentNodes, groupMatches })`, ctx) };
  };
  const LIVE = (name, over = {}) => ({ id: name, name, live: true, state: 'busy', ...over });
  const DONE = (name, over = {}) => ({ id: name, name, live: false, state: 'ended', ...over });
  const group = (agents, project = null) => ({ key: 'k1', label: 'repo', project, agents });

  test('(+) unchecked: the live rows are drawn, the ended agents are not rendered at all', () => {
    const { agentNodes } = rig();
    const nodes = agentNodes(group([LIVE('a'), DONE('b'), DONE('c')]), '', 'g:k1');
    assert.deepEqual(sigs(nodes), ['ul.rows']);
    assert.equal(textOf(nodes[0]), 'a');
  });

  test('(+) unchecked, every agent ended: one line "No live agents." in place of the rows, no Ended section', () => {
    const { agentNodes } = rig();
    const nodes = agentNodes(group([DONE('b'), DONE('c')]), '', 'g:k1');
    assert.deepEqual(sigs(nodes), ['div.rows.no-agents']);
    assert.equal(textOf(nodes[0]), 'No live agents.');
    assert.equal(JSON.stringify(nodes).includes('Ended ('), false);
  });

  test('(+) checked: the Ended section shows with its count, expanded, rows under the ended scope', () => {
    const { agentNodes } = rig({ showEnded: true });
    const nodes = agentNodes(group([LIVE('a'), DONE('b'), DONE('c')]), '', 'g:k1');
    assert.deepEqual(sigs(nodes), ['ul.rows', 'details.ended']);
    const [, section] = nodes;
    assert.equal(section.attrs.open, true);
    assert.equal(textOf(section.kids[0]), 'Ended (2)');
    assert.equal(section.kids[1].attrs['data-scope'], 'g:k1-e');
    const only = agentNodes(group([DONE('b')]), '', 'g:k1');
    assert.deepEqual(sigs(only), ['details.ended'], 'a group of ended agents only is the section alone: no "No live agents." line');
    assert.equal(only[0].attrs.open, true);
  });

  test('(+) checked: a section the user folded by hand stays folded; opening it forgets the mark, folding it again remembers', () => {
    const { agentNodes, ctx } = rig({ showEnded: true, open: ['!ended:g:k1'] });
    const [, section] = agentNodes(group([LIVE('a'), DONE('b')]), '', 'g:k1');
    assert.notEqual(section.attrs.open, true);
    section.open = true;
    section.listeners.toggle();
    assert.deepEqual([...ctx.state.open], ['ended:g:k1']);
    section.open = false;
    section.listeners.toggle();
    assert.deepEqual([...ctx.state.open], ['!ended:g:k1']);
  });

  test('(−) checked with no ended agents: no section; unchecked never builds one, even for a group that was folded or opened by hand before', () => {
    const { agentNodes } = rig({ showEnded: true });
    assert.deepEqual(sigs(agentNodes(group([LIVE('a')]), '', 'g:k1')), ['ul.rows']);
    const off = rig({ open: ['ended:g:k1', '!ended:g:k1'] });
    assert.deepEqual(sigs(off.agentNodes(group([LIVE('a'), DONE('b')]), '', 'g:k1')), ['ul.rows']);
  });

  test('(+) the project view hides its Ended section too until its own toggle is on (F5): the option decides, the dashboard checkbox does not', () => {
    for (const dashboard of [false, true]) {
      const { agentNodes } = rig({ showEnded: dashboard });
      const off = agentNodes(group([LIVE('a'), DONE('b')], { key: 'p1' }), '', 'pv:p1', { showEnded: false });
      assert.deepEqual(sigs(off), ['ul.rows'], `dashboard checkbox ${dashboard}: project toggle off`);
      const aloneOff = agentNodes(group([DONE('b')], { key: 'p1' }), '', 'pv:p1', { showEnded: false });
      assert.deepEqual(sigs(aloneOff), ['div.rows.no-agents'], 'only ended agents: the "No live agents." line');
      assert.equal(textOf(aloneOff[0]), 'No live agents.');
      const on = agentNodes(group([LIVE('a'), DONE('b')], { key: 'p1' }), '', 'pv:p1', { showEnded: true });
      assert.deepEqual(sigs(on), ['ul.rows', 'details.ended'], `dashboard checkbox ${dashboard}: project toggle on`);
      assert.equal(on[1].attrs.open, true, 'open until folded by hand');
      assert.deepEqual(sigs(agentNodes(group([DONE('b')], { key: 'p1' }), '', 'pv:p1', { showEnded: true })), ['details.ended']);
    }
  });

  test('(−) a registered project with no agents keeps its call to action; with ended agents only it says "No live agents." (checkbox off)', () => {
    const { agentNodes } = rig();
    const empty = agentNodes(group([], { key: 'p1' }), '', 'g:k1');
    assert.equal(textOf(empty[0]), 'No agents in this project.');
    const done = agentNodes(group([DONE('b')], { key: 'p1' }), '', 'g:k1');
    assert.equal(textOf(done[0]), 'No live agents.');
  });

  test('(+) the filter applies on top: with the checkbox on, an ended match keeps its group; unchecked, only a live match does', () => {
    const g = group([LIVE('builder-1'), DONE('scout-9')]);
    const on = rig({ showEnded: true });
    assert.equal(on.groupMatches(g, 'scout'), true);
    assert.equal(on.groupMatches(g, 'builder'), true);
    const off = rig();
    assert.equal(off.groupMatches(g, 'builder'), true);
    assert.deepEqual(sigs(off.agentNodes(g, 'builder', 'g:k1')), ['ul.rows'], 'a live match is drawn, the ended agent is not');
  });

  test('(−) unchecked, a filter that matches only ended agents drops the group; a filter that matches nothing drops it too', () => {
    const g = group([LIVE('builder-1'), DONE('scout-9')]);
    const off = rig();
    assert.equal(off.groupMatches(g, 'scout'), false);
    assert.equal(off.groupMatches(g, 'nothing-like-this'), false);
    assert.equal(rig({ showEnded: true }).groupMatches(g, 'nothing-like-this'), false);
  });
});

// ---- the page code that draws the decisions (pinned) ------------------------------------------------------------------------------

describe('dashboard wiring', () => {
  test('(+) app.js takes endedPlan and resetEndedState from dash-model.js, and agentNodes draws from the plan', () => {
    assert.match(APP, /import \{[^}]*\bendedPlan\b[^}]*\} from '\.\/dash-model\.js'/);
    assert.match(APP, /import \{[^}]*\bresetEndedState\b[^}]*\} from '\.\/dash-model\.js'/);
    const nodes = fn(APP, 'export function agentNodes(');
    assert.match(nodes, /agentNodes\(g, q, scope, \{ showEnded = state\.showEnded \} = \{\}\)/);
    assert.match(nodes, /endedPlan\(\{[^}]*\bshowEnded,/);
    assert.doesNotMatch(APP, /endedOpen/, 'the project view no longer forces its Ended section open');
    assert.match(nodes, /collapsed: state\.open\.has\(`!\$\{id\}`\)/);
    assert.match(nodes, /if \(plan\.endedSection\)/);
    assert.match(nodes, /plan\.noLiveLine/);
    assert.match(nodes, /text: 'No live agents\.'/);
    assert.doesNotMatch(nodes, /!live\.length/, 'a group without live agents no longer forces its Ended section open');
  });

  test('(+) the Show ended checkbox forgets the manual open and closed marks before it redraws', () => {
    const at = APP.indexOf("ended.addEventListener('change'");
    assert.ok(at > 0);
    const handler = APP.slice(at, APP.indexOf('});', at));
    assert.match(handler, /state\.showEnded = ended\.checked;/);
    assert.match(handler, /save\('showEnded', state\.showEnded\);/);
    assert.ok(handler.indexOf('resetEndedState(state.open)') > handler.indexOf('state.showEnded = ended.checked'), 'reset after the new value');
    assert.ok(handler.indexOf('resetEndedState(state.open)') < handler.indexOf('render(true)'), 'reset before the redraw');
  });

  test('(+) the group filter on the dashboard goes through groupMatches, which hides ended matches while the checkbox is off', () => {
    assert.match(fn(APP, 'function dashboardNodes('), /if \(q && !groupMatches\(g, q\)\) continue;/);
    assert.match(fn(APP, 'function groupMatches('), /state\.showEnded \|\| sOf\(a\) !== 'ended'/);
  });

  test('(+) the project view passes its own toggle (true only for a real true), never the dashboard one, and redraws when it flips', () => {
    assert.match(PROJECT, /agentNodes\(g, '', `pv:\$\{key\}`, \{ showEnded: state\.showEndedProject === true \}\)/);
    assert.doesNotMatch(PROJECT, /endedOpen/);
    assert.match(fn(PROJECT, 'function renderProject('), /state\.showEndedProject/, 'the redraw signature includes the toggle');
  });

  test('(+) boot reads both remembered toggles through loadFlag; nothing else reads them', () => {
    const boot = fn(APP, 'async function boot(');
    assert.match(boot, /state\.showEnded = loadFlag\('showEnded'\);/);
    assert.match(boot, /state\.showEndedProject = loadFlag\('showEndedProject'\);/);
    assert.doesNotMatch(APP, /load\('showEnded/);
    assert.match(read('ui.js'), /showEndedProject: false,/, 'off until the stored value says true');
  });

  test('(+) the project header has its "Show ended" checkbox in the dashboard\'s style, in the app-only screen, next to the actions', () => {
    const screen = /<section class="screen" data-screen="project"[^>]*data-app-only>[\s\S]*?<\/section>\s*<section class="screen" data-screen="settings"/.exec(HTML);
    assert.ok(screen, 'the project screen is app-only');
    assert.match(screen[0], /<label class="check center" id="proj-ended-wrap"><input type="checkbox" id="proj-ended"> Show ended<\/label>\s*<span class="bar-actions" id="proj-actions">/);
    assert.match(HTML, /<label class="check center"><input type="checkbox" id="dash-ended"> Show ended<\/label>/, 'the dashboard\'s is the model');
  });

  test('(+) a group heading can take focus from the sidebar (tabindex -1, like the screen headings)', () => {
    assert.match(fn(APP, 'function groupEl('), /h\('h2', \{ id: `g-\$\{g\.key\}`, tabindex: '-1', 'data-fk'/);
  });
});

// ---- the remembered "Show ended" toggles (F5) -----------------------------------------------------------------------------------

describe('loadFlag: a remembered toggle is on only for a stored true', () => {
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = (map) => { globalThis.localStorage = { getItem: (k) => map[k] ?? null, setItem(k, v) { map[k] = v; } }; };
  const restore = () => { if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage); else delete globalThis.localStorage; };

  test('(+) the stored value true is on; false, nothing stored and a throwing storage are off', () => {
    try {
      store({ 'nika.showEnded': 'true' });
      assert.equal(loadFlag('showEnded'), true);
      store({ 'nika.showEnded': 'false' });
      assert.equal(loadFlag('showEnded'), false);
      store({});
      assert.equal(loadFlag('showEnded'), false);
      globalThis.localStorage = { getItem() { throw new Error('blocked'); } };
      assert.equal(loadFlag('showEnded'), false);
    } finally { restore(); }
  });

  test('(−) a garbage stored value is off: not JSON, a string, a number, an object, an array, null', () => {
    try {
      for (const bad of ['{not json', '"true"', '1', 'yes', 'TRUE', '{"on":true}', '[true]', 'null', '']) {
        store({ 'nika.showEnded': bad, 'nika.showEndedProject': bad });
        assert.equal(loadFlag('showEnded'), false, bad);
        assert.equal(loadFlag('showEndedProject'), false, bad);
      }
    } finally { restore(); }
  });

  test('(+) the two views remember separately: the project one is its own key', () => {
    try {
      store({ 'nika.showEndedProject': 'true' });
      assert.equal(loadFlag('showEnded'), false);
      assert.equal(loadFlag('showEndedProject'), true);
      assert.equal(load('showEndedProject', false), true);
    } finally { restore(); }
  });
});

describe('the project page "Show ended" toggle (project.js wireEnded)', () => {
  const rig = ({ checked = false } = {}) => {
    const box = { checked, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
    const calls = [];
    const state = { showEndedProject: false, open: new Set(['ended:pv:k1', '!ended:pv:k1', 'ended:g:k1', 'subs:x']) };
    const ctx = {
      state, $: (sel) => (sel === '#proj-ended' ? box : null), save: (k, v) => calls.push(['save', k, v]), render: (force) => calls.push(['render', force]),
      resetEndedState: (open, view) => { calls.push(['reset', view]); for (const id of [...open]) if (id.replace(/^!/, '').startsWith(`ended:${view}:`)) open.delete(id); },
    };
    const wire = vm.runInNewContext(`${fn(PROJECT, 'function wireEnded(')}\nwireEnded`, ctx);
    return { box, state, calls, wire };
  };

  test('(+) wiring shows the remembered value; ticking it turns the project page on, remembers it under its own key, forgets manual folds and redraws', () => {
    const r = rig();
    r.state.showEndedProject = true;
    r.wire();
    assert.equal(r.box.checked, true, 'the box starts as remembered');
    r.box.checked = false;
    r.box.listeners.change();
    assert.equal(r.state.showEndedProject, false);
    r.box.checked = true;
    r.box.listeners.change();
    assert.equal(r.state.showEndedProject, true);
    assert.deepEqual(r.calls.slice(-3), [['save', 'showEndedProject', true], ['reset', 'pv'], ['render', true]]);
    assert.deepEqual([...r.state.open], ['ended:g:k1', 'subs:x'], 'the project page\'s Ended folds are forgotten; the dashboard\'s and other marks stay');
  });

  test('(−) it never touches the dashboard toggle or its stored key', () => {
    const r = rig();
    r.wire();
    r.box.checked = true;
    r.box.listeners.change();
    assert.ok(!r.calls.some((c) => c[0] === 'save' && c[1] === 'showEnded'));
    assert.equal(r.state.showEnded, undefined);
  });

  test('(+) initApp wires it', () => {
    assert.match(fn(PROJECT, 'export async function initApp('), /\bwireEnded\(\);/);
  });
});

// ---- groupEl, dashboardNodes and swap (app.js, run against stubs) ---------------------------------------------------------------

describe('groupEl: the heading keeps focus across a redraw', () => {
  const rig = ({ isApp = true } = {}) => {
    const ctx = {
      isApp,
      hooks: {},
      h: (tag, attrs, ...kids) => makeNode(tag, attrs, kids),
      rulesEl: () => null,
      countsLine: () => [],
      agentNodes: () => [],
    };
    return { ctx, ...vm.runInNewContext(`${fn(APP, 'function groupEl(')}\n({ groupEl })`, ctx) };
  };
  const grp = (project) => ({ key: 'k1', label: 'repo', root: '/r/repo', project, agents: [], counts: { attn: 0, idle: 0, busy: 0, ended: 0, live: 0 } });
  const heading = (section) => walk(section).find((n) => n.tag === 'h2');

  test('(+) the group h2 carries data-fk gh:<key>, for a registered project and for a repository that is not one', () => {
    const { groupEl } = rig();
    assert.equal(heading(groupEl(grp({ key: 'k1', name: 'repo' }), '')).attrs['data-fk'], 'gh:k1');
    assert.equal(heading(groupEl(grp(null), '')).attrs['data-fk'], 'gh:k1');
    assert.equal(heading(rig({ isApp: false }).groupEl(grp(null), '')).attrs['data-fk'], 'gh:k1', 'the browser tier too');
  });

  test('(−) the project link inside the h2 keeps its own g:<key>; no data-fk appears twice in the group', () => {
    const section = rig().groupEl(grp({ key: 'k1', name: 'repo' }), '');
    const link = walk(heading(section)).find((n) => n.tag === 'a');
    assert.equal(link.attrs['data-fk'], 'g:k1');
    const fks = walk(section).map((n) => n.attrs?.['data-fk']).filter(Boolean);
    assert.deepEqual(fks.slice().sort(), ['g:k1', 'gh:k1']);
    assert.equal(new Set(fks).size, fks.length);
  });

  test('(+) swap puts focus back on the heading after a redraw, matched by that data-fk', () => {
    const { groupEl } = rig();
    const fresh = groupEl(grp(null), '');
    const events = [];
    const target = heading(fresh);
    target.focus = (o) => events.push(['focus', o.preventScroll]);
    const host = { contains: () => true, replaceChildren: (...n) => events.push(['replace', n.length]), hasAttribute: () => false };
    const ctx = {
      document: { activeElement: { dataset: { fk: 'gh:k1' } } },
      CSS: { escape: (x) => x },
      $: (sel) => walk(fresh).find((n) => `[data-fk="${n.attrs['data-fk']}"]` === sel) ?? null,
    };
    const { swap } = vm.runInNewContext(`${fn(APP, 'export function swap(').replace('export ', '')}\n({ swap })`, ctx);
    swap(host, [fresh]);
    assert.deepEqual(events, [['replace', 1], ['focus', true]]);
  });

  test('(+) wiring: the h2 has tabindex -1 and data-fk gh:<key>; the project link keeps g:<key>', () => {
    const src = fn(APP, 'function groupEl(');
    assert.match(src, /h\('h2', \{ id: `g-\$\{g\.key\}`, tabindex: '-1', 'data-fk': `gh:\$\{g\.key\}` \}/);
    assert.match(src, /'data-fk': `g:\$\{g\.key\}`/);
  });
});

describe('noMatchText (the filter\'s "No agent matches" line)', () => {
  test('(+) Show ended off and an ended agent matches: says that live agents are the ones missing, and how to include the ended ones', () => {
    assert.equal(noMatchText({ q: 'scout', showEnded: false, endedMatch: true }),
      'Nothing live matches “scout”. Tick Show ended to include ended agents, or clear the filter.');
  });

  test('(−) Show ended off and no ended agent matches: today\'s line, byte for byte', () => {
    assert.equal(noMatchText({ q: 'scout', showEnded: false, endedMatch: false }),
      'Nothing matches “scout”. Clear the filter to see every agent.');
  });

  test('(−) Show ended on: today\'s line, whatever endedMatch says (ended agents are already included)', () => {
    for (const endedMatch of [false, true]) {
      assert.equal(noMatchText({ q: 'scout', showEnded: true, endedMatch }), 'Nothing matches “scout”. Clear the filter to see every agent.');
    }
  });

  test('(−) the filter text is put in as it is, quotes and markup characters included (it is drawn as text)', () => {
    assert.equal(noMatchText({ q: '<b>"x"</b>', showEnded: false, endedMatch: false }), 'Nothing matches “<b>"x"</b>”. Clear the filter to see every agent.');
  });
});

describe('dashboardNodes: the no-match line', () => {
  const LIVE = (name) => ({ id: name, name, live: true, state: 'busy' });
  const DONE = (name) => ({ id: name, name, live: false, state: 'ended' });
  const rig = ({ filter, showEnded = false, groups }) => {
    const ctx = {
      isApp: true,
      state: { filter, showEnded },
      hooks: {},
      noMatchText,
      buildGroups: () => groups.map((agents, i) => ({ key: `k${i}`, label: 'repo', agents })),
      groupEl: (g) => makeNode('section', { class: 'grp' }, []),
      queueEl: () => null,
      plainSummary: () => 'summary',
      countsOf: () => ({}),
      h: (tag, attrs, ...kids) => makeNode(tag, attrs, kids),
      icon: () => null,
      statusOf,
    };
    const src = [fn(APP, 'export function sOf(').replace('export ', ''), fn(APP, 'function matches('), fn(APP, 'function groupMatches('),
      fn(APP, 'function emptyEl('), fn(APP, 'function dashboardNodes(')].join('\n');
    const { dashboardNodes } = vm.runInNewContext(`${src}\n({ dashboardNodes })`, ctx);
    return Array.from(dashboardNodes());
  };
  const emptyText = (nodes) => textOf(nodes.find((n) => n.attrs.class === 'empty'));

  test('(+) unchecked, the filter matches only an ended agent: the empty box says "Nothing live matches" and how to include ended agents', () => {
    const text = emptyText(rig({ filter: ' scout ', groups: [[LIVE('builder-1'), DONE('scout-9')]] }));
    assert.equal(text, 'No agent matchesNothing live matches “scout”. Tick Show ended to include ended agents, or clear the filter.');
  });

  test('(−) unchecked, nothing matches at all: today\'s line', () => {
    const text = emptyText(rig({ filter: 'nope', groups: [[LIVE('builder-1'), DONE('scout-9')]] }));
    assert.equal(text, 'No agent matchesNothing matches “nope”. Clear the filter to see every agent.');
  });

  test('(−) checked, the filter matches an ended agent: its group is drawn and there is no empty box; checked with no match: today\'s line', () => {
    const hit = rig({ filter: 'scout', showEnded: true, groups: [[LIVE('builder-1'), DONE('scout-9')]] });
    assert.equal(hit.some((n) => n.attrs.class === 'empty'), false);
    assert.equal(hit.some((n) => n.attrs.class === 'grp'), true);
    const miss = rig({ filter: 'nope', showEnded: true, groups: [[LIVE('builder-1'), DONE('scout-9')]] });
    assert.equal(emptyText(miss), 'No agent matchesNothing matches “nope”. Clear the filter to see every agent.');
  });

  test('(+) a live match anywhere keeps the groups and shows no empty box; the ended match is found in any group', () => {
    assert.equal(rig({ filter: 'builder', groups: [[LIVE('builder-1')], [DONE('scout-9')]] }).some((n) => n.attrs.class === 'empty'), false);
    assert.match(emptyText(rig({ filter: 'scout', groups: [[LIVE('builder-1')], [DONE('scout-9')]] })), /Nothing live matches “scout”/);
  });

  test('(+) wiring: the text comes from noMatchText, drawn through emptyEl, from the shared matches() and sOf()', () => {
    assert.match(APP, /import \{[^}]*\bnoMatchText\b[^}]*\} from '\.\/dash-model\.js'/);
    const src = fn(APP, 'function dashboardNodes(');
    assert.match(src, /emptyEl\('No agent matches', noMatchText\(\{ q: state\.filter\.trim\(\), showEnded: state\.showEnded, endedMatch/);
    assert.match(src, /sOf\(a\) === 'ended' && matches\(a, g, q\)/);
  });
});

describe('sidebar wiring', () => {
  test('(+) index.html: the hint under the Projects heading, exact copy, hidden until the page shows it', () => {
    const hint = /<div\b[^>]*\bid="side-hint"[^>]*>[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? '';
    assert.ok(hint, '#side-hint exists');
    assert.match(hint, /<div\b[^>]*\bhidden\b/);
    assert.match(hint, /<p>No projects yet\.<\/p>/);
    assert.match(hint, /<p>Add a repo with \+ to start agents and apply rules here\.<\/p>/);
    assert.ok(HTML.indexOf('id="side-p"') < HTML.indexOf('id="side-hint"') && HTML.indexOf('id="side-hint"') < HTML.indexOf('id="side-projects"'), 'between the heading and the list');
    assert.match(HTML, /<button\b[^>]*\bid="side-add"[^>]*aria-label="Add project"/, 'the + button stays as it was');
  });

  test('(+) index.html: a "Detected" sub-heading (h3) labels its own list, hidden until there is a row, after the registered projects', () => {
    assert.match(HTML, /<h3\b[^>]*\bid="side-d"[^>]*>Detected<\/h3>/);
    assert.match(HTML, /<div\b[^>]*\bid="side-det"[^>]*\bhidden\b[^>]*>|<div\b[^>]*\bhidden\b[^>]*\bid="side-det"[^>]*>/);
    assert.match(HTML, /<ul\b[^>]*\bid="side-detected"[^>]*\baria-labelledby="side-d"|<ul\b[^>]*\baria-labelledby="side-d"[^>]*\bid="side-detected"/);
    assert.ok(HTML.indexOf('id="side-projects"') < HTML.indexOf('id="side-det"') && HTML.indexOf('id="side-det"') < HTML.indexOf('class="side-foot"'));
  });

  test('(+) renderSide draws from sidebarModel; the hint shows when there are no projects and Detected only when it has rows', () => {
    assert.match(PROJECT, /import \{[^}]*\bsidebarModel\b[^}]*\} from '\.\/dash-model\.js'/);
    const side = fn(PROJECT, 'function renderSide(');
    assert.match(side, /sidebarModel\(\{ projects: state\.projects, groups: buildGroups\(\), showAll: /);
    assert.doesNotMatch(side, /state\.projects \?\?/, 'a project list that has not loaded (null) is not turned into an empty one');
    assert.match(side, /\$\('#side-projects'\)\.hidden = empty;/);
    assert.match(side, /\$\('#side-hint'\)\.hidden = !empty;/);
    assert.match(side, /\$\('#side-det'\)\.hidden = !detected\.length;/);
    assert.match(side, /JSON\.stringify\(\[rows, detected, detectedMore, cur, env\]\)/, 'a change in Detected or in the "more" count redraws the sidebar');
    assert.match(side, /sidebarModel\(\{[^}]*showAll: state\.expanded\.has\('detected'\)/, 'the button\'s state lives in state.expanded like the other "show more" buttons');
  });

  describe('the Detected list shows 8 rows, then an "N more" button (F1b)', () => {
    const rig = (n, { expanded = [], me = null } = {}) => {
      const groups = Array.from({ length: n }, (_, i) => ({ key: `d${String(i).padStart(2, '0')}`, label: `repo-${String(i).padStart(2, '0')}`, root: `/r/${i}`, project: null, counts: { attn: 0, idle: 0, busy: 0, ended: 0, live: n - i } }));
      const hosts = {};
      const host = (sel) => (hosts[sel] ??= { sel, nodes: [], hidden: false, textContent: '' });
      const focused = [];
      const ctx = {
        state: { projects: [], route: { name: 'dashboard' }, me, expanded: new Set(expanded) },
        DETECTED_MAX, sidebarModel, buildGroups: () => groups, showGroup() {}, addProject() {}, icon: (name) => makeNode('svg', { 'data-i': name }, []),
        h: (tag, attrs, ...kids) => makeNode(tag, attrs, kids),
        $: (sel) => (sel.startsWith('#side-detected li:nth-child(') ? { focus: () => focused.push(sel) } : host(sel)),
        swap: (el, nodes) => { el.nodes = nodes.flat().filter(Boolean); },
      };
      const src = [/let sideSig = '';/.exec(PROJECT)[0], fn(PROJECT, 'function sideLink('), fn(PROJECT, 'function renderSide(')].join('\n');
      const { renderSide } = vm.runInNewContext(`${src}\n({ renderSide })`, ctx);
      renderSide();
      return { renderSide, ctx, host, focused };
    };
    const lis = (r) => r.host('#side-detected').nodes;
    const moreBtn = (r) => lis(r).flatMap(walk).find((x) => x.tag === 'button' && x.attrs['data-fk'] === 'det-more');

    test('(+) 11 detected repositories: 8 rows with their Add buttons, then one button that counts the other 3', () => {
      const r = rig(11);
      assert.equal(lis(r).filter((li) => li.attrs.class === 'has-act').length, 8);
      assert.equal(lis(r).length, 9);
      assert.equal(lis(r)[8].attrs.class, 'side-more');
      assert.equal(textOf(moreBtn(r)), '3 more');
      assert.equal(moreBtn(r).attrs['aria-label'], 'Show 3 more detected repositories');
      assert.equal(r.host('#side-det').hidden, false);
    });

    test('(+) the environment dots: the words are hidden on the rail (900 px and below), so each dot has its words as a title (0.4.0)', () => {
      const dots = (me) => rig(0, { me }).host('#env').nodes;
      const [tmux, claude, ver] = dots({ tmux: true, claude: false, version: '0.4.0' });
      assert.deepEqual([textOf(tmux), tmux.attrs.title, tmux.attrs.class], ['tmux ready', 'tmux ready', 'env-ok']);
      assert.deepEqual([textOf(claude), claude.attrs.title, claude.attrs.class], ['claude missing', 'claude missing', 'env-bad']);
      assert.equal(ver.attrs.title, undefined, 'the version line is text with no dot: no title');
      const [t2, c2] = dots({ tmux: false, claude: true, version: '0.4.0' });
      assert.deepEqual([t2.attrs.title, c2.attrs.title], ['tmux missing', 'claude ready']);
      assert.equal(dots(null).length, 0, '(−) no answer from the server yet: no dots, no titles');
    });

    test('(+) one hidden repository: the label says "repository", in the singular', () => {
      const r = rig(9);
      assert.equal(textOf(moreBtn(r)), '1 more');
      assert.equal(moreBtn(r).attrs['aria-label'], 'Show 1 more detected repository');
    });

    test('(+) pressing it shows the rest, drops the button and puts focus on the first row that was behind it', () => {
      const r = rig(11);
      moreBtn(r).attrs.onclick();
      assert.ok(r.ctx.state.expanded.has('detected'));
      assert.equal(lis(r).filter((li) => li.attrs.class === 'has-act').length, 11);
      assert.equal(moreBtn(r), undefined);
      assert.deepEqual(r.focused, ['#side-detected li:nth-child(9) a']);
    });

    test('(+) already expanded (state kept across redraws): all rows, no button', () => {
      const r = rig(11, { expanded: ['detected'] });
      assert.equal(lis(r).length, 11);
      assert.equal(moreBtn(r), undefined);
    });

    test('(−) 8 or fewer detected repositories: no button', () => {
      const r = rig(8);
      assert.equal(lis(r).length, 8);
      assert.equal(moreBtn(r), undefined);
    });
  });

  test('(+) a Detected row: the repo name and counts as text, a link to the dashboard, and an Add button that calls addProject()', () => {
    const side = fn(PROJECT, 'function renderSide(');
    const rows = side.slice(side.indexOf("swap($('#side-detected')"));
    assert.match(rows, /href: '#dashboard'/);
    assert.match(rows, /showGroup\(r\.key\)/);
    assert.match(rows, /'aria-label': `Add \$\{r\.name\} as a project`/);
    assert.match(rows, /onclick: \(\) => addProject\(\)/);
    assert.match(rows, /icon\('plus'\)/);
    assert.match(rows, /'data-fk': `det:\$\{r\.key\}`/);
    assert.match(rows, /'data-fk': `detadd:\$\{r\.key\}`/);
    assert.match(fn(PROJECT, 'function sideLink('), /text: r\.name/);
  });

  test('(−) the Add button asks for no path: addProject takes no argument and still opens the folder picker', () => {
    const rows = fn(PROJECT, 'function renderSide(');
    assert.doesNotMatch(rows, /addProject\([^)]/);
    assert.match(fn(PROJECT, 'async function addProject('), /\/api\/app\/projects\/pick/);
    assert.doesNotMatch(fn(PROJECT, 'async function addProject('), /g\.root|\.dir/);
  });

  test('(−) the sidebar shows counts the way project rows do: attention badge keeps its style and text, live count its own text', () => {
    const link = fn(PROJECT, 'function sideLink(');
    assert.match(link, /'data-s': 'attn'/);
    assert.match(link, /', needs you: '/);
    assert.match(link, /', live agents: '/);
  });

  test('(−) no HTML-parsing sink and no inline style in the new module or the sidebar code', () => {
    for (const src of [code(read('dash-model.js')), fn(PROJECT, 'function renderSide('), fn(PROJECT, 'function sideLink('), fn(PROJECT, 'function showGroup(')]) {
      assert.doesNotMatch(src, new RegExp(['inner', 'HTML'].join(''), 'i'));
      assert.doesNotMatch(src, /style\s*[:=]|setAttribute\(\s*'style'/);
    }
    assert.doesNotMatch(code(read('dash-model.js')), /\bdocument\b|\bwindow\b|\bfetch\b|\/api\//, 'the model module is pure');
  });

  test('(+) app.css styles the hint, the sub-heading and the row with its Add button, with tokens only; the narrow rail keeps one "+"', () => {
    for (const sel of ['.side-hint', '.side-sub', '.side-det', '.side-projects li.has-act']) assert.ok(CSS.includes(sel), sel);
    const rule = (sel) => new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    for (const sel of ['.side-hint', '.side-sub', '.side-det', '.side-projects li.has-act']) {
      assert.doesNotMatch(rule(sel), /#[0-9a-f]{3,8}\b|rgb\(/i, `${sel} uses tokens, not colours`);
    }
    assert.match(rule('.side-sub'), /color: var\(--text-muted\)/);
    assert.match(rule('.side-hint'), /color: var\(--text-muted\)/);
    const rail = CSS.slice(CSS.indexOf('@media (max-width: 900px)'));
    assert.match(rail, /\.side \.side-sub/, 'the sub-heading goes screen-reader-only in the rail, like the other headings');
    // the rail stacked a "+" under every Detected avatar, which read as unrelated buttons: it drops the per-row "+" and
    // keeps the header "+" (#side-add), which calls the same addProject() folder picker, so the action stays reachable
    assert.match(rail, /\.side-projects li\.has-act \.btn \{ display: none; \}/, 'the rail drops the per-row "+"');
    assert.doesNotMatch(rail, /#side-add|\.side-h[^{,]*\{[^}]*display:\s*none/, 'the header "+" stays in the rail');
    assert.doesNotMatch(rail, /\.side-projects li\.has-act a[^{]*\{[^}]*display:\s*none/, 'the Detected row link stays in the rail');
  });

  test('(+) app.css (F1b): the skipped-files note is small muted text, and the "N more" row stays inside the narrow rail; tokens only', () => {
    const rule = (sel) => new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    assert.match(rule('.skip-note'), /color: var\(--text-muted\)/);
    assert.match(rule('.skip-note'), /font-size: var\(--fs-small\)/);
    assert.ok(rule('.side-more .btn'), '.side-more .btn is styled');
    for (const sel of ['.skip-note', '.side-more .btn']) assert.doesNotMatch(rule(sel), /#[0-9a-f]{3,8}\b|rgb\(/i, `${sel} uses tokens, not colours`);
    assert.match(CSS.slice(CSS.indexOf('@media (max-width: 900px)')), /\.side-more \.btn \{[^}]*\}/, 'the rail has its own size for the button');
  });
});

// ---- showGroup (project.js, run against stubs) ----------------------------------------------------------------------------------

describe('showGroup (a Detected row goes to the dashboard and puts focus on that repo\'s heading)', () => {
  const rig = (route) => {
    const events = [];
    let onHash = null;
    const ctx = {
      state: { route: { name: route } },
      document: { getElementById: (id) => (id === 'g-d1' ? { focus: () => events.push('focus:g-d1') } : null) },
      window: { addEventListener: (type, f, opts) => { events.push(`listen:${type}:${opts?.once === true}`); onHash = f; } },
      location: { hash: '#settings' },
    };
    const { showGroup } = vm.runInNewContext(`${fn(PROJECT, 'function showGroup(')}\n({ showGroup })`, ctx);
    return { showGroup, events, ctx, fire: () => onHash?.() };
  };

  test('(+) already on the dashboard: focus the group heading now, change nothing else', () => {
    const { showGroup, events } = rig('dashboard');
    showGroup('d1');
    assert.deepEqual(events, ['focus:g-d1']);
  });

  test('(+) from another screen: go to #dashboard, and focus the heading once the screen is drawn (one hashchange)', () => {
    const { showGroup, events, fire, ctx } = rig('settings');
    showGroup('d1');
    assert.deepEqual(events, ['listen:hashchange:true'], 'nothing is focused before the dashboard exists');
    assert.equal(ctx.location.hash, '#dashboard');
    fire();
    assert.deepEqual(events.slice(1), ['focus:g-d1']);
  });

  test('(−) a group that is gone from the dashboard (no heading) is a no-op, not an error', () => {
    const a = rig('dashboard');
    assert.doesNotThrow(() => a.showGroup('gone'));
    assert.deepEqual(a.events, []);
    const b = rig('project');
    b.showGroup('gone');
    assert.doesNotThrow(() => b.fire());
  });
});

// ---- orchState and roleTag (0.4, O1: pick or resume an orchestrator; design 0.4 sections 0, 1.1 and 1.3) ------------------------------

describe('orchState (what the project\'s first button says)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  const live = (id, over = {}) => ({ id, name: `s-${id.slice(0, 2)}`, live: true, role: 'orchestrator', lastActivity: 1, pane: { id: '%3' }, ...over });
  const g = (...agents) => ({ agents });
  const proj = (orchestrator) => ({ key: 'k', orchestrator });

  test('(+) a saved orchestrator that runs, ended or is gone decides the button, with its id, name and pane', () => {
    assert.deepEqual(orchState(proj({ sessionId: ID, state: 'live', name: 'planner', pane: '%3' }), g()), { kind: 'live', id: ID, name: 'planner', pane: '%3' });
    assert.deepEqual(orchState(proj({ sessionId: ID, state: 'ended', name: 'planner', pane: null }), g()), { kind: 'ended', id: ID, name: 'planner', pane: null });
    assert.deepEqual(orchState(proj({ sessionId: ID, state: 'gone', name: null, pane: null }), g()), { kind: 'gone', id: ID, name: null, pane: null });
  });

  test('(+) without a saved orchestrator (null, or an older server that sends no field) the snapshot decides: live with a main orchestrator, else none', () => {
    const a = live(ID);
    assert.deepEqual(orchState(proj(null), g(a)), { kind: 'live', id: ID, name: a.name, pane: '%3' });
    assert.deepEqual(orchState(proj(undefined), g(a)), { kind: 'live', id: ID, name: a.name, pane: '%3' });
    assert.deepEqual(orchState(proj(null), g()), { kind: 'none', id: null, name: null, pane: null });
    assert.deepEqual(orchState(proj(undefined), g(live(ID, { role: 'agent' }))), { kind: 'none', id: null, name: null, pane: null }, 'an agent is not an orchestrator');
  });

  test('(+) a saved orchestrator that has ended still gives way to a main orchestrator that runs (the most recent one): Open, not Resume', () => {
    const old = live(ID, { lastActivity: 1 });
    const recent = live(ID2, { lastActivity: 9 });
    assert.deepEqual(orchState(proj({ sessionId: 'x', state: 'ended', name: 'n', pane: null }), g(old, recent)), { kind: 'live', id: ID2, name: recent.name, pane: '%3' });
  });

  test('(+) a live saved orchestrator wins over another running one', () => {
    const other = live(ID2, { lastActivity: 99 });
    assert.equal(orchState(proj({ sessionId: ID, state: 'live', name: 'planner', pane: '%3' }), g(other)).id, ID);
  });

  test('(−) a sub-orchestrator and an ended agent are not the main orchestrator; the role decides, never the depth', () => {
    assert.equal(orchState(proj(null), g(live(ID, { role: 'sub-orchestrator', depth: 1 }))).kind, 'none', 'a sub-orchestrator that is a root is still a sub-orchestrator');
    assert.equal(orchState(proj(null), g(live(ID, { role: 'sub-orchestrator', depth: 2 }))).kind, 'none');
    assert.equal(orchState(proj(null), g(live(ID, { depth: 2 }))).kind, 'live', 'the role is orchestrator: a depth field cannot demote it');
    assert.equal(orchState(proj(null), g(live(ID, { depth: undefined }))).kind, 'live');
    assert.equal(orchState(proj(null), g(live(ID, { live: false }))).kind, 'none');
  });

  test('(−) a field that is not exactly one of the three states, a bad id, or junk is ignored: the snapshot decides', () => {
    for (const o of [{ sessionId: ID, state: 'running', name: 'n', pane: null }, { sessionId: 'not-an-id', state: 'ended', name: 'n', pane: null }, { state: 'ended' }, 'ended', 5, [], { sessionId: ID, state: '__proto__' }]) {
      assert.equal(orchState(proj(o), g()).kind, 'none', JSON.stringify(o));
    }
    assert.equal(orchState(proj({ sessionId: ID, state: 'live', name: 7, pane: { id: '%3' } }), g()).name, null, 'a name that is not text is dropped');
    assert.equal(orchState(proj({ sessionId: ID, state: 'live', name: 'n', pane: { id: '%3' } }), g()).pane, null, 'a pane that is not an id string is dropped');
  });

  test('(−) no project (an unregistered group) and no group are survivable', () => {
    assert.equal(orchState(null, g()).kind, 'none');
    assert.equal(orchState(undefined, undefined).kind, 'none');
    assert.equal(orchState({ key: 'k', orchestrator: { sessionId: ID, state: 'gone', name: null, pane: null } }, undefined).kind, 'gone');
  });
});

describe('roleTag (the badge next to a name)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  test('(+) a live orchestrator is main, a live sub-orchestrator is sub: the role decides', () => {
    assert.equal(roleTag({ id: 'a', live: true, role: 'orchestrator' }, null), 'main');
    assert.equal(roleTag({ id: 'a', live: true, role: 'orchestrator', depth: 1 }, null), 'main');
    assert.equal(roleTag({ id: 'a', live: true, role: 'sub-orchestrator', depth: 2 }, null), 'sub');
  });

  test('(+) a sub-orchestrator without a parent (an orphan, depth 1 by structure) keeps its tag, because the page never derives the role from the depth', () => {
    assert.equal(roleTag({ id: 'a', live: true, role: 'sub-orchestrator', depth: 1, parent: null }, null), 'sub');
    assert.equal(roleTag({ id: 'a', live: true, role: 'sub-orchestrator' }, null), 'sub');
  });

  test('(+) a session that is not running and is the saved orchestrator is saved; running and saved is main', () => {
    assert.equal(roleTag({ id: ID, live: false, role: null }, ID), 'saved');
    assert.equal(roleTag({ id: ID, live: true, role: 'orchestrator' }, ID), 'main');
  });

  test('(−) an agent, an untagged session, a live pick without a tag and an ended session that is not the pick have no badge', () => {
    assert.equal(roleTag({ id: 'a', live: true, role: 'agent' }, null), null);
    assert.equal(roleTag({ id: 'a', live: true, role: null }, null), null);
    assert.equal(roleTag({ id: ID, live: true, role: null }, ID), null);
    assert.equal(roleTag({ id: 'b', live: false, role: null }, ID), null);
    assert.equal(roleTag({ id: 'b', live: false, role: 'orchestrator' }, null), null, 'an ended session has no pane, so no tag');
  });

  test('(−) no pick: never "saved"; a depth field of any kind never changes the tag of an orchestrator, and an ended sub-orchestrator has no badge', () => {
    assert.equal(roleTag({ id: ID, live: false }, undefined), null);
    assert.equal(roleTag({ id: ID, live: false }, null), null);
    for (const depth of [2, 9, '2', null, 1.5, NaN, {}]) assert.equal(roleTag({ id: 'a', live: true, role: 'orchestrator', depth }, null), 'main', String(depth));
    assert.equal(roleTag({ id: 'a', live: false, role: 'sub-orchestrator' }, null), null);
  });
});

describe('savedPick (the project\'s saved orchestrator, whatever it is doing)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  test('(+) the contract\'s shape comes back as id, state, name and pane', () => {
    assert.deepEqual(savedPick({ orchestrator: { sessionId: ID, state: 'ended', name: 'planner', pane: null } }), { id: ID, state: 'ended', name: 'planner', pane: null });
    assert.deepEqual(savedPick({ orchestrator: { sessionId: ID, state: 'live', name: 'planner', pane: '%3' } }), { id: ID, state: 'live', name: 'planner', pane: '%3' });
    assert.deepEqual(savedPick({ orchestrator: { sessionId: ID, state: 'gone', name: null, pane: null } }), { id: ID, state: 'gone', name: null, pane: null });
  });

  test('(−) no project, no field, null, a bad id, a bad state, a name or pane that is not text: null, or the odd part dropped', () => {
    for (const p of [null, undefined, {}, { orchestrator: null }, { orchestrator: 'x' }, { orchestrator: { sessionId: 'nope', state: 'ended' } }, { orchestrator: { sessionId: ID, state: 'running' } }, { orchestrator: { sessionId: ID, state: '__proto__' } }]) {
      assert.equal(savedPick(p), null, JSON.stringify(p));
    }
    assert.deepEqual(savedPick({ orchestrator: { sessionId: ID, state: 'live', name: 7, pane: { id: '%3' } } }), { id: ID, state: 'live', name: null, pane: null });
  });
});

describe('ROLE_TAGS (the words of each badge)', () => {
  test('(+) main, sub and saved each have their own class, a long word, a short word and a title', () => {
    assert.deepEqual(Object.keys(ROLE_TAGS), ['main', 'sub', 'saved']);
    assert.equal(ROLE_TAGS.main.long, 'orchestrator');
    assert.equal(ROLE_TAGS.sub.long, 'sub-orchestrator');
    assert.equal(ROLE_TAGS.sub.short, 'sub-orch');
    assert.match(ROLE_TAGS.saved.title, /^Saved orchestrator\. Resume it from the header or this row's menu\.$/);
    assert.equal(new Set(Object.values(ROLE_TAGS).map((t) => t.cls)).size, 3, 'never the same look twice');
  });
});

describe('otherRunning (who else runs as the orchestrator, so Set and Resume are off)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  const ID3 = '33333333-3333-4333-8333-333333333333';
  const live = (id, over = {}) => ({ id, name: `s-${id.slice(0, 2)}`, live: true, role: null, lastActivity: 1, ...over });

  test('(+) another live session tagged orchestrator is the answer, with its id and name', () => {
    assert.deepEqual(otherRunning({ agents: [live(ID2, { role: 'orchestrator' })] }, null, ID), { id: ID2, name: 's-22' });
  });

  test('(+) a live saved orchestrator counts even without a tag, and the most recent of several wins', () => {
    assert.deepEqual(otherRunning({ agents: [live(ID2)] }, ID2, ID), { id: ID2, name: 's-22' });
    const many = { agents: [live(ID2, { role: 'orchestrator', lastActivity: 1 }), live(ID3, { role: 'orchestrator', lastActivity: 9 })] };
    assert.equal(otherRunning(many, null, ID).id, ID3);
  });

  test('(−) the session itself, an ended one, an agent or an untagged live session is not another orchestrator', () => {
    assert.equal(otherRunning({ agents: [live(ID, { role: 'orchestrator' })] }, ID, ID), null, 'itself');
    assert.equal(otherRunning({ agents: [live(ID2, { role: 'orchestrator', live: false })] }, ID2, ID), null, 'ended');
    assert.equal(otherRunning({ agents: [live(ID2, { role: 'agent' }), live(ID3)] }, null, ID), null, 'agent and plain');
  });

  test('(−) a sub-orchestrator is not another orchestrator: the server never counts it for the 409 orchestrator_running', () => {
    assert.equal(otherRunning({ agents: [live(ID2, { role: 'sub-orchestrator', depth: 2 })] }, null, ID), null);
  });

  test('(−) no group, no agents and no name are survivable; a name that is not text is null', () => {
    assert.equal(otherRunning(undefined, null, ID), null);
    assert.equal(otherRunning({}, null, ID), null);
    assert.deepEqual(otherRunning({ agents: [live(ID2, { role: 'orchestrator', name: 7 })] }, null, ID), { id: ID2, name: null });
  });
});

// ---- the nesting tree and the spawn counts (0.4, O2; design 0.4 sections 2.1, 2.2 and 3) --------------------------------------------------

describe('statusOf and STATUS_ORDER (one status per agent, most urgent first)', () => {
  test('(+) ended, attention, busy and idle; the order puts attn first and ended last', () => {
    assert.equal(statusOf({ live: false, state: 'busy' }), 'ended');
    assert.equal(statusOf({ live: true, state: 'busy', attention: 'permission prompt' }), 'attn');
    assert.equal(statusOf({ live: true, state: 'busy' }), 'busy');
    assert.equal(statusOf({ live: true, state: 'idle' }), 'idle');
    assert.deepEqual(STATUS_ORDER, { attn: 0, idle: 1, busy: 2, ended: 3 });
  });

  test('(−) a live agent in a state that is neither busy nor idle needs you', () => {
    assert.equal(statusOf({ live: true, state: 'waiting' }), 'attn');
    assert.equal(statusOf({ live: true }), 'attn');
  });
});

describe('parentOf (the parent of an agent, among the agents we hold)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const ID2 = '22222222-2222-4222-8222-222222222222';
  const planner = { id: ID, name: 'planner', live: true, pane: { id: '%3' } };

  test('(+) a session id finds the agent with that id; a pane id finds the live agent in that pane', () => {
    assert.equal(parentOf({ id: ID2, parent: ID }, [planner]), planner);
    assert.equal(parentOf({ id: ID2, parent: '%3' }, [planner]), planner);
  });

  test('(−) no parent, an unknown one, an ended pane, its own id, and a value that is neither a session id nor a pane id: null', () => {
    assert.equal(parentOf({ id: ID2 }, [planner]), null);
    assert.equal(parentOf({ id: ID2, parent: null }, [planner]), null);
    assert.equal(parentOf({ id: ID2, parent: '22222222-2222-4222-8222-aaaaaaaaaaaa' }, [planner]), null);
    assert.equal(parentOf({ id: ID2, parent: '%3' }, [{ ...planner, live: false }]), null, 'an ended agent holds no pane');
    assert.equal(parentOf({ id: ID, parent: ID }, [planner]), null, 'a self-parent is cut');
    for (const parent of ['planner', '', '%x', '../etc', 7, {}, ['%3']]) assert.equal(parentOf({ id: ID2, parent }, [planner]), null, String(parent));
  });
});

describe('treeRows (the live rows of one group, in tree order)', () => {
  const uid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const A = (n, name, over = {}) => ({ id: uid(n), name, live: true, state: 'busy', lastActivity: 100 + n, pane: { id: `%${n}` }, parent: null, ...over });
  const planner = A(1, 'planner', { role: 'orchestrator' });
  const lead = A(2, 'api-lead', { role: 'sub-orchestrator', parent: uid(1) });
  const builder = A(3, 'builder-1', { role: 'agent', parent: uid(2) });
  const web = A(4, 'web-lead', { role: 'sub-orchestrator', parent: uid(1) });
  const reviewer = A(5, 'reviewer', { role: 'agent', parent: uid(1) });
  const solo = A(6, 'my-helper', { role: 'agent' });
  const names = (rows) => rows.map((r) => r.a.name);
  const shape = (rows) => rows.map((r) => [r.a.name, r.depth]);

  test('(+) the main orchestrator first, then its children, then the grandchildren right under their parent (depth 1, 2, 3)', () => {
    const rows = treeRows([builder, lead, planner], {});
    assert.deepEqual(shape(rows), [['planner', 1], ['api-lead', 2], ['builder-1', 3]]);
    assert.deepEqual(rows.map((r) => r.root), [true, false, false]);
    assert.deepEqual(rows.map((r) => r.kids), [1, 1, 0]);
    assert.deepEqual(rows.map((r) => r.parentName), [null, 'planner', 'api-lead']);
  });

  test('(+) siblings: the most urgent subtree first (a child that needs you lifts its whole subtree), then the most recent activity', () => {
    const a = { ...lead, state: 'idle' };
    const calm = { ...web, lastActivity: 999 };
    // calm is more recent, but api-lead has a child that needs you: its subtree rises
    const needy = { ...builder, attention: 'permission prompt' };
    assert.deepEqual(names(treeRows([planner, calm, a, needy], {})), ['planner', 'api-lead', 'builder-1', 'web-lead']);
    // without the urgent child: idle (api-lead) still outranks busy (web-lead)
    assert.deepEqual(names(treeRows([planner, calm, a], {})), ['planner', 'api-lead', 'web-lead']);
    // equal urgency: the most recent first
    assert.deepEqual(names(treeRows([planner, { ...web, lastActivity: 1 }, { ...lead, lastActivity: 50 }], {})), ['planner', 'api-lead', 'web-lead']);
    assert.deepEqual(names(treeRows([planner, { ...web, lastActivity: 90 }, { ...lead, lastActivity: 50 }], {})), ['planner', 'web-lead', 'api-lead']);
  });

  test('(+) roots are ordered the same way, and a child counts toward its root\'s activity', () => {
    const quiet = { ...planner, lastActivity: 1 };
    const busyKid = { ...reviewer, lastActivity: 500 };
    assert.deepEqual(names(treeRows([{ ...solo, lastActivity: 200 }, quiet], {})), ['my-helper', 'planner']);
    assert.deepEqual(names(treeRows([{ ...solo, lastActivity: 200 }, quiet, busyKid], {})), ['planner', 'reviewer', 'my-helper'], 'the root with the recent child comes first');
  });

  test('(+) collapsed: the descendants are hidden, the root says how many, and how many of them need you', () => {
    const needy = { ...builder, attention: 'permission prompt' };
    const rows = treeRows([planner, lead, needy, reviewer], { collapsed: new Set([planner.id]) });
    const root = rows[0];
    assert.equal(root.collapsed, true);
    assert.equal(root.hiddenCount, 3);
    assert.equal(root.hiddenAttn, 1);
    assert.deepEqual(root.desc, rows.slice(1).map((r) => r.a.id), 'every descendant, in row order');
    assert.deepEqual([...root.desc].sort(), [lead.id, needy.id, reviewer.id].sort());
    assert.deepEqual(rows.slice(1).map((r) => r.hidden), [true, true, true]);
    assert.equal(rows.filter((r) => !r.hidden).length, 1);
  });

  test('(+) expanded (the default): nothing hidden, no hidden counts, but the descendants are still listed for aria-controls', () => {
    const rows = treeRows([planner, lead, builder], {});
    assert.deepEqual(rows.map((r) => [r.collapsed, r.hiddenCount, r.hiddenAttn, r.hidden]), [[false, 0, 0, false], [false, 0, 0, false], [false, 0, 0, false]]);
    assert.deepEqual(rows[0].desc, [lead.id, builder.id]);
    assert.deepEqual(rows[1].desc, [builder.id]);
    assert.deepEqual(rows[2].desc, []);
  });

  test('(+) a child that is collapsed inside an expanded parent hides only its own descendants', () => {
    const rows = treeRows([planner, lead, builder, reviewer], { collapsed: new Set([lead.id]) });
    const hidden = Object.fromEntries(rows.map((r) => [r.a.name, r.hidden]));
    assert.deepEqual(hidden, { planner: false, 'api-lead': false, 'builder-1': true, reviewer: false });
    assert.equal(rows.find((r) => r.a.name === 'api-lead').hiddenCount, 1);
  });

  test('(+) a group with no parent and no child is a plain list: depth 1, no kids, no orphan, in status-then-activity order', () => {
    const rows = treeRows([A(7, 'x', { lastActivity: 1 }), A(8, 'y', { lastActivity: 9 }), A(9, 'z', { state: 'idle', lastActivity: 0 })], {});
    assert.deepEqual(names(rows), ['z', 'y', 'x']);
    assert.equal(hasTree(rows), false);
    assert.ok(rows.every((r) => r.depth === 1 && r.kids === 0 && !r.orphan && !r.hidden && r.root));
  });

  test('(−) an orphan (a parent that is not listed) is a root that keeps its role and carries the flag; the group is a tree', () => {
    const orphan = A(8, 'api-lead', { role: 'sub-orchestrator', parent: uid(9), depth: 2 });
    const rows = treeRows([orphan, solo], {});
    const o = rows.find((r) => r.a.name === 'api-lead');
    assert.deepEqual([o.depth, o.orphan, o.root, o.parentName], [1, true, true, null]);
    assert.equal(rows.find((r) => r.a.name === 'my-helper').orphan, false);
    assert.equal(hasTree(rows), true);
    assert.equal(treeRows([A(8, 'q', { parent: '%99' })], {})[0].orphan, true, 'a pane id that is not listed is an orphan too');
  });

  test('(−) an odd parent value is no parent at all: a root, not an orphan', () => {
    for (const parent of ['planner', '', 7, {}]) {
      const [r] = treeRows([A(8, 'q', { parent })], {});
      assert.deepEqual([r.depth, r.orphan, r.root], [1, false, true], String(parent));
    }
  });

  test('(−) a forged depth never moves a row: the depth is the place in the parent chain, capped at 3', () => {
    const forged = [planner, { ...lead, depth: 99 }, { ...builder, depth: 1 }, { ...solo, depth: 3 }];
    assert.deepEqual(shape(treeRows(forged, {})).sort(), [['api-lead', 2], ['builder-1', 3], ['my-helper', 1], ['planner', 1]]);
    for (const depth of [0, -4, 1.5, NaN, '2', null]) assert.equal(treeRows([{ ...lead, parent: null, depth }], {})[0].depth, 1, String(depth));
  });

  test('(−) a chain deeper than three levels stays at depth 3', () => {
    const d4 = A(7, 'deep-4', { parent: builder.id });
    const d5 = A(8, 'deep-5', { parent: d4.id });
    const rows = treeRows([planner, lead, builder, d4, d5], {});
    assert.deepEqual(rows.map((r) => r.depth), [1, 2, 3, 3, 3]);
  });

  test('(−) a loop of parents and a self-parent end: every agent is drawn once', () => {
    const x = A(7, 'x', { parent: uid(8) });
    const y = A(8, 'y', { parent: uid(7) });
    const self = A(9, 'self', { parent: uid(9) });
    const rows = treeRows([x, y, self], {});
    assert.deepEqual(names(rows).sort(), ['self', 'x', 'y']);
    assert.equal(new Set(rows.map((r) => r.a.id)).size, 3);
    assert.ok(rows.some((r) => r.root));
  });

  test('(−) filtering: a flat list, status then activity, nothing hidden or indented, collapsed or not, each row still names its parent', () => {
    const rows = treeRows([planner, lead, builder, reviewer, solo], { filtering: true, collapsed: new Set([planner.id]) });
    assert.ok(rows.every((r) => r.depth === 1 && r.kids === 0 && !r.hidden && !r.collapsed && !r.orphan && r.root && r.hiddenCount === 0));
    assert.equal(hasTree(rows), false);
    assert.equal(rows.find((r) => r.a.name === 'builder-1').parentName, 'api-lead');
    assert.deepEqual(names(rows), ['my-helper', 'reviewer', 'builder-1', 'api-lead', 'planner']);
  });

  test('(−) nothing, one agent, and no options at all are survivable', () => {
    assert.deepEqual(treeRows([], {}), []);
    assert.deepEqual(treeRows([], undefined), []);
    assert.equal(treeRows([solo]).length, 1);
  });
});

describe('hasTree', () => {
  test('(+) hasTree: a row with kids or an orphan makes the group a tree; (−) plain roots do not', () => {
    assert.equal(hasTree([{ kids: 1, orphan: false }, { kids: 0, orphan: false }]), true);
    assert.equal(hasTree([{ kids: 0, orphan: true }]), true);
    assert.equal(hasTree([{ kids: 0, orphan: false }]), false);
    assert.equal(hasTree([]), false);
  });
});

describe('spawnLimits (the counts the spawn sheet and its openers show)', () => {
  const uid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const A = (n, role, over = {}) => ({ id: uid(n), name: `n${n}`, live: true, role, pane: { id: `%${n}` }, parent: null, ...over });
  const main = A(1, 'orchestrator');
  const lead = A(2, 'sub-orchestrator', { parent: uid(1) });
  const b1 = A(3, 'agent', { parent: uid(2) });
  const b2 = A(4, 'agent', { parent: '%2' });
  const mine = A(5, 'agent');
  const g = { agents: [main, lead, b1, b2, mine] };

  test('(+) the parent bucket counts the live children of that pane (by session id or pane id); the project counts every agent and sub-orchestrator, not the main orchestrator', () => {
    assert.deepEqual(spawnLimits(g, '%2', 3), { parent: { running: 2, max: 3 }, project: { running: 4, cap: 9 } });
    assert.deepEqual(spawnLimits(g, '%1', 3).parent, { running: 1, max: 3 }, 'the sub-orchestrator is one of the orchestrator\'s agents');
  });

  test('(+) "you" (no parent pane) counts the agents with no parent', () => {
    assert.deepEqual(spawnLimits(g, null, 3).parent, { running: 1, max: 3 });
  });

  test('(+) the project cap is min(3N, 24)', () => {
    assert.equal(spawnLimits(g, null, 1).project.cap, 3);
    assert.equal(spawnLimits(g, null, 3).project.cap, 9);
    assert.equal(spawnLimits(g, null, 8).project.cap, 24);
    assert.equal(spawnLimits(g, null, 8).parent.max, 8);
  });

  test('(−) ended agents, an orphan\'s children of another pane, and a main orchestrator never count', () => {
    const done = { ...b1, live: false };
    assert.equal(spawnLimits({ agents: [main, lead, done] }, '%2', 3).parent.running, 0);
    assert.equal(spawnLimits({ agents: [main, lead, done] }, '%2', 3).project.running, 1);
    assert.equal(spawnLimits({ agents: [main] }, null, 3).project.running, 0);
    const orphan = A(6, 'agent', { parent: uid(9) });
    assert.equal(spawnLimits({ agents: [orphan] }, null, 3).parent.running, 0, 'an agent whose parent is gone is not "you"');
  });

  test('(−) no group, no agents and a max that is not a whole number from 1 up fall back to 3', () => {
    assert.deepEqual(spawnLimits(undefined, null, 3), { parent: { running: 0, max: 3 }, project: { running: 0, cap: 9 } });
    assert.deepEqual(spawnLimits({}, '%1', 3), { parent: { running: 0, max: 3 }, project: { running: 0, cap: 9 } });
    for (const max of [undefined, null, 0, -1, 2.5, NaN, '3']) assert.equal(spawnLimits(g, null, max).parent.max, 3, String(max));
  });
});
