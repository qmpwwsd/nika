// 0.5, W8: the shared subagent pieces of the pages (design W8 4.1, 4.9): the state badge, one list line, and the stylesheet rules that
// give each state its own colour, glyph and word. The real code from public/dom.js runs against the small fake DOM (test/fake-dom.js);
// the browser itself is exercised by hand. The copy strings are written out here on purpose: the tests must not read them back from
// the code under test. Names and ids are synthetic.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, withClass } from './fake-dom.js';
import { roleTagEl, subStateEl, subagentItemEl } from '../public/dom.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let restore;
before(() => { restore = installDom(); });
after(() => restore());

const one = (n, cls) => n.all(withClass(cls))[0] ?? null;
const sub = (over = {}) => ({ id: 'aaa111', type: 'Explore', description: 'List project files', model: 'haiku', modelLabel: 'Haiku 4.5', state: 'running', lastActivity: 5, ...over });

describe('subStateEl: the state badge (design 4.1, 4.9)', () => {
  const WORDS = {
    running: ['Running', 'Running inside its session'],
    finished: ['Finished', 'Finished its task'],
    stopped: ['Stopped', 'Did not finish: its session is no longer running'],
  };

  test('(+) each state: span.sst with data-ss and title, a glyph hidden from assistive tech, then the word', () => {
    for (const [state, [word, title]] of Object.entries(WORDS)) {
      const el = subStateEl(state);
      assert.equal(el.tag, 'span', state);
      assert.equal(el.className, 'sst', state);
      assert.equal(el.attrs['data-ss'], state);
      assert.equal(el.attrs.title, title);
      assert.deepEqual(el.kids.map((k) => k.className), ['sst-g', 'sst-l'], state);
      assert.equal(el.kids[0].attrs['aria-hidden'], 'true', 'the glyph is decoration');
      assert.equal(el.kids[0].textContent, '', 'the glyph holds no text; the stylesheet draws it');
      assert.equal(el.kids[1].textContent, word);
      assert.equal(el.accName, word, 'a screen reader hears the word once, never the glyph');
    }
  });

  test('(+) the three states have three different words and three different titles (never colour alone)', () => {
    const els = Object.keys(WORDS).map((s) => subStateEl(s));
    assert.equal(new Set(els.map((e) => e.accName)).size, 3);
    assert.equal(new Set(els.map((e) => e.attrs.title)).size, 3);
    assert.equal(new Set(els.map((e) => e.attrs['data-ss'])).size, 3);
  });

  test('(+) pill adds the class for the session header; the rest is the same', () => {
    const el = subStateEl('running', { pill: true });
    assert.equal(el.className, 'sst pill');
    assert.equal(el.attrs['data-ss'], 'running');
    assert.equal(el.accName, 'Running');
    assert.equal(subStateEl('finished', { pill: false }).className, 'sst');
  });

  test('(−) an unknown state gives null: other words, other cases, prototype names, and anything that is not text', () => {
    for (const state of ['Running', 'busy', 'ended', '', '__proto__', 'constructor', 'toString', undefined, null, 5, {}, ['running']]) {
      assert.equal(subStateEl(state), null, String(state));
    }
  });
});

describe('subagentItemEl: one subagent line (design 4.1, 4.7)', () => {
  test('(+) with a link: li.sub, the badge, then a.sub-desc.sub-link with href, data-fk and the title, then type, model and time', () => {
    const time = roleTagEl('main'); // any node stands in for the time
    const li = subagentItemEl(sub(), { href: 'session.html?session=S&agent=aaa111', fk: 'sub:g:k:S:aaa111', time });
    assert.equal(li.tag, 'li');
    assert.equal(li.className, 'sub');
    assert.equal(li.attrs['data-ss'], 'running');
    assert.equal(li.kids[0].className, 'sst');
    const a = one(li, 'sub-desc');
    assert.equal(a.tag, 'a');
    assert.deepEqual(a.className.split(' ').sort(), ['sub-desc', 'sub-link']);
    assert.equal(a.attrs.href, 'session.html?session=S&agent=aaa111');
    assert.equal(a.attrs['data-fk'], 'sub:g:k:S:aaa111');
    assert.equal(a.attrs.title, 'Open its transcript (read-only)');
    assert.equal(a.textContent, 'List project files');
    assert.equal(one(li, 'sub-type').textContent, 'Explore');
    assert.equal(one(li, 'model').textContent, 'Haiku 4.5');
    assert.equal(li.kids.at(-1), time, 'the time node the page passes comes last');
    assert.deepEqual(li.kids.map((k) => k.className.split(' ')[0]), ['sst', 'sub-desc', 'sub-type', 'model', 'tag']);
  });

  test('(+) without a link (browser tier): the description is a span.sub-desc, no href, no data-fk, no title', () => {
    const li = subagentItemEl(sub());
    const d = one(li, 'sub-desc');
    assert.equal(d.tag, 'span');
    assert.equal(d.className, 'sub-desc');
    assert.equal(d.hasAttribute('href'), false);
    assert.equal(d.hasAttribute('data-fk'), false);
    assert.equal(d.hasAttribute('title'), false);
    assert.equal(li.all((n) => n.tag === 'a').length, 0);
  });

  test('(+) no description: "(no description)", as text and as the link\'s name', () => {
    for (const description of [null, undefined, '']) {
      assert.equal(one(subagentItemEl(sub({ description })), 'sub-desc').textContent, '(no description)', String(description));
      assert.equal(one(subagentItemEl(sub({ description }), { href: 'session.html?x' }), 'sub-desc').accName, '(no description)');
    }
  });

  test('(+) no type, no model label, no time: those parts are left out, the badge and the description stay', () => {
    const li = subagentItemEl(sub({ type: null, modelLabel: undefined }));
    assert.deepEqual(li.kids.map((k) => k.className), ['sst', 'sub-desc']);
  });

  test('(+) the words are text, never markup: a description with tags is one text node of the span', () => {
    const li = subagentItemEl(sub({ description: '<img src=x onerror=1>' }));
    assert.equal(one(li, 'sub-desc').textContent, '<img src=x onerror=1>');
    assert.equal(li.all((n) => n.tag === 'img').length, 0);
  });

  test('(−) an unknown state draws no badge and no data-ss (the line itself still shows when the page asks for it)', () => {
    const li = subagentItemEl(sub({ state: 'Running' }));
    assert.equal(li.all(withClass('sst')).length, 0);
    assert.equal(li.hasAttribute('data-ss'), false);
    assert.equal(one(li, 'sub-desc').textContent, 'List project files');
  });

  test('(−) an href of null or empty draws a span, so a bad id upstream never makes a link', () => {
    for (const href of [null, undefined, '']) assert.equal(one(subagentItemEl(sub(), { href }), 'sub-desc').tag, 'span', String(href));
  });
});

describe('tokens.css: each subagent state has its own colour, glyph and word (design 4.1)', () => {
  const T = css('tokens.css');
  const rule = (sel) => {
    const at = T.indexOf(sel);
    assert.ok(at >= 0, `${sel} has a rule`);
    return T.slice(T.indexOf('{', at) + 1, T.indexOf('}', at));
  };

  test('(+) a rule for each data-ss: running green (busy), finished grey (ended), stopped amber (idle), each with its soft background', () => {
    assert.match(rule('.sst[data-ss="running"] {'), /--sst-c:\s*var\(--busy\);\s*--sst-bg:\s*var\(--busy-soft\)/);
    assert.match(rule('.sst[data-ss="finished"] {'), /--sst-c:\s*var\(--ended\);\s*--sst-bg:\s*var\(--ended-soft\)/);
    assert.match(rule('.sst[data-ss="stopped"] {'), /--sst-c:\s*var\(--idle\);\s*--sst-bg:\s*var\(--idle-soft\)/);
  });

  test('(+) each state has its own glyph: a dot with a spinning arc, a check, a hollow square', () => {
    assert.match(rule('.sst[data-ss="running"] .sst-g {'), /border-radius:\s*50%;[^}]*background:\s*var\(--sst-c\)/);
    assert.match(rule('.sst[data-ss="running"] .sst-g::after'), /animation:\s*st-spin/);
    const check = rule('.sst[data-ss="finished"] .sst-g::before');
    assert.match(check, /border-width:\s*0 2px 2px 0/);
    assert.match(check, /width:\s*4px/);
    assert.match(check, /height:\s*7px/);
    assert.match(check, /transform:\s*rotate\(45deg\)/);
    const hollow = rule('.sst[data-ss="stopped"] .sst-g {');
    assert.match(hollow, /width:\s*8px/);
    assert.match(hollow, /height:\s*8px/);
    assert.match(hollow, /border:\s*2px solid var\(--sst-c\)/);
    assert.match(hollow, /border-radius:\s*1px/);
  });

  test('(+) the badge itself: inline-flex, nowrap, the state colour, weight 600, the small size; the pill adds the soft fill', () => {
    const b = rule('.sst {');
    for (const re of [/display:\s*inline-flex/, /gap:\s*6px/, /align-items:\s*center/, /white-space:\s*nowrap/, /color:\s*var\(--sst-c\)/, /font-weight:\s*600/, /font-size:\s*var\(--fs-small\)/]) assert.match(b, re);
    const p = rule('.sst.pill');
    assert.match(p, /padding:\s*2px 10px 2px 8px/);
    assert.match(p, /border-radius:\s*999px/);
    assert.match(p, /background:\s*var\(--sst-bg\)/);
  });

  test('(+) the subagent role tag and the link: .tag.sa is dashed, .sub-link is underlined at 24 px and turns accent on hover', () => {
    const t = rule('.tag.sa');
    assert.match(t, /background:\s*var\(--surface-2\)/);
    assert.match(t, /color:\s*var\(--text\)/);
    assert.match(t, /border:\s*1px dashed var\(--accent-line\)/);
    const l = rule('.sub-link {');
    assert.match(l, /text-decoration:\s*underline/);
    assert.match(l, /text-underline-offset:\s*2px/);
    assert.match(l, /min-height:\s*24px/);
    assert.match(rule('.sub-link:hover'), /color:\s*var\(--accent\)/);
  });

  test('(+) the list rules live here now, so both pages share them: .subs ul, .subs li, .sub-desc, .sub-type', () => {
    for (const sel of ['.subs ul {', '.subs li {', '.sub-desc {', '.sub-type {']) assert.ok(T.includes(sel), `${sel} is in tokens.css`);
    const app = css('app.css');
    for (const sel of ['.subs ul {', '.subs li {', '.sub-desc {', '.sub-type {']) assert.ok(!app.includes(sel), `${sel} left app.css`);
  });

  test('(+) reduced motion: the running arc does not spin (inside the existing prefers-reduced-motion block)', () => {
    const at = T.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    assert.ok(at >= 0);
    const block = T.slice(at);
    assert.match(block, /\.sst\[data-ss="running"\] \.sst-g::after\s*\{[^}]*animation:\s*none/);
  });

  test('(−) no new colour: the badge uses only the status tokens that already exist, and no raw colour value', () => {
    const own = T.split('\n').filter((l) => /\.sst|\.tag\.sa|\.sub-link/.test(l)).join('\n');
    assert.ok(own.length > 0);
    assert.doesNotMatch(own, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/, 'tokens only');
    for (const v of own.match(/var\(--[a-z-]+\)/g) ?? []) {
      assert.ok(['--busy', '--busy-soft', '--ended', '--ended-soft', '--idle', '--idle-soft', '--sst-c', '--sst-bg', '--surface-2', '--text', '--accent', '--accent-line', '--fs-small'].includes(v.slice(4, -1)), v);
    }
  });

  test('(−) the three states do not share a colour token (colour is never the only difference, but it differs too)', () => {
    const colours = ['running', 'finished', 'stopped'].map((s) => /--sst-c:\s*var\((--[a-z]+)\)/.exec(rule(`.sst[data-ss="${s}"] {`))[1]);
    assert.equal(new Set(colours).size, 3);
  });
});
