// public/palette.js: the pure rules behind the session window's slash-command palette (query, ranking, list shape, copy, fetch
// timing, the Commands button). No DOM there: session.js draws what these return. Design: docs/design/spec.md section 9.7.
// Contract: docs/contracts/api-app.md, GET /api/app/commands. Fixtures are synthetic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PALETTE_MAX, paletteQuery, rankCommands, cleanCommands, sourceLabel, commandsButton, shouldFetch, paletteView, insertion, moveActive,
} from '../public/palette.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const DOTS = '…';

const cmd = (name, description = '', extra = {}) => ({ name, description, argHint: '', source: 'builtin', ...extra });
const names = (list) => list.map((c) => c.name);

describe('paletteQuery: when the message box is asking for a command', () => {
  test('(+) the text after a leading slash while it has no whitespace', () => {
    assert.equal(paletteQuery('/co'), 'co');
    assert.equal(paletteQuery('/'), '');
    assert.equal(paletteQuery('/demo:lint'), 'demo:lint');
  });

  test('(+) a path-like word is a query too (the list then says nothing matches)', () => {
    assert.equal(paletteQuery('/usr/bin/env'), 'usr/bin/env');
  });

  test('(−) text that does not start with a slash is not a query', () => {
    assert.equal(paletteQuery('hello'), null);
    assert.equal(paletteQuery(''), null);
    assert.equal(paletteQuery(' /co'), null);
  });

  test('(−) any whitespace after the slash closes it: a space, a tab, a line break (Review Focus 4)', () => {
    assert.equal(paletteQuery('/usr/bin/env x'), null);
    assert.equal(paletteQuery('/compact '), null);
    assert.equal(paletteQuery('/co\tx'), null);
    assert.equal(paletteQuery('/co\nmore'), null);
    assert.equal(paletteQuery('/ co'), null);
  });

  test('(−) anything that is not a string is not a query', () => {
    for (const v of [undefined, null, 5, {}, ['/co']]) assert.equal(paletteQuery(v), null, String(v));
  });
});

describe('rankCommands: exact name, name prefix, name substring, description; stable; at most 50', () => {
  const LIST = [
    cmd('copy', 'Copy the last response'),
    cmd('compact', 'Summarize the conversation'),
    cmd('co', 'The short one'),
    cmd('review', 'Look at the code'),
    cmd('demo:coverage', 'Show test coverage', { source: 'plugin', plugin: 'demo' }),
    cmd('config', 'Open settings'),
    cmd('help', 'Show help and how to use the code'),
  ];

  test('(+) name-prefix matches come before name-substring matches, which come before description matches', () => {
    assert.deepEqual(names(rankCommands(LIST, 'co')), ['co', 'copy', 'compact', 'config', 'demo:coverage', 'review', 'help']);
  });

  test('(+) an exact name match ranks first (query "co": co before compact)', () => {
    const out = names(rankCommands(LIST, 'co'));
    assert.equal(out[0], 'co');
    assert.ok(out.indexOf('co') < out.indexOf('compact'));
  });

  test('(+) the order inside a tier is the order of the input (stable)', () => {
    assert.deepEqual(names(rankCommands(LIST, 'com')), ['compact']);
    assert.deepEqual(names(rankCommands(LIST, 'co')).slice(1, 4), ['copy', 'compact', 'config']);
    assert.deepEqual(names(rankCommands([cmd('bb'), cmd('ba'), cmd('bc')], 'b')), ['bb', 'ba', 'bc']);
  });

  test('(+) it is case-insensitive on the query, the name and the description', () => {
    assert.deepEqual(names(rankCommands([cmd('Compact', 'SUMMARIZE')], 'COMP')), ['Compact']);
    assert.deepEqual(names(rankCommands([cmd('x', 'SUMMARIZE the chat')], 'summ')), ['x']);
  });

  test('(+) a plugin command matches on its full <plugin>:<name> string, by prefix and by the part after the colon', () => {
    const plug = [cmd('demo:lint', 'Lint it', { source: 'plugin', plugin: 'demo' }), cmd('lint', 'Project lint')];
    assert.deepEqual(names(rankCommands(plug, 'demo:li')), ['demo:lint']);
    assert.deepEqual(names(rankCommands(plug, 'lint')), ['lint', 'demo:lint'], 'exact name first, then the substring hit');
  });

  test('(+) an empty query keeps every command in the server order', () => {
    assert.deepEqual(names(rankCommands(LIST, '')), names(LIST));
  });

  test('(+) it returns at most 50 entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => cmd(`cmd${i}`, 'x'));
    assert.equal(PALETTE_MAX, 50);
    assert.equal(rankCommands(many, 'cmd').length, 50);
    assert.equal(rankCommands(many, '').length, 50);
    assert.deepEqual(names(rankCommands(many, 'cmd')), names(many.slice(0, 50)));
  });

  test('(+) it does not change its input', () => {
    const copy = JSON.stringify(LIST);
    rankCommands(LIST, 'co');
    assert.equal(JSON.stringify(LIST), copy);
  });

  test('(−) a path-like query matches nothing', () => {
    assert.deepEqual(rankCommands(LIST, 'usr/bin/env'), []);
    assert.deepEqual(rankCommands(LIST, 'zzz'), []);
  });

  test('(−) the query is text, not a pattern: regex characters match literally', () => {
    assert.deepEqual(rankCommands(LIST, '.*'), []);
    assert.deepEqual(rankCommands(LIST, '('), []);
    assert.deepEqual(names(rankCommands([cmd('a.b', ''), cmd('axb', '')], 'a.')), ['a.b']);
  });

  test('(−) a list that is not an array, and entries without a string name, give nothing instead of throwing', () => {
    for (const bad of [null, undefined, 'compact', {}, 3]) assert.deepEqual(rankCommands(bad, 'c'), []);
    assert.deepEqual(rankCommands([null, 5, {}, { name: 7 }, cmd('compact')], 'c').map((c) => c.name), ['compact']);
  });

  test('(−) a description that is not a string never matches and never throws', () => {
    assert.deepEqual(rankCommands([{ name: 'a', description: 5 }], 'x'), []);
    assert.deepEqual(rankCommands([{ name: 'a' }], 'x'), []);
  });
});

describe('cleanCommands: the list as the page may use it', () => {
  const GOOD = { name: 'compact', description: 'Summarize', argHint: '[instructions]', source: 'builtin' };

  test('(+) keeps the contract fields and sets dialog and plugin only where they apply', () => {
    const out = cleanCommands([GOOD, { name: 'config', description: 'Settings', argHint: '', source: 'builtin', dialog: true }, { name: 'demo:lint', description: '', argHint: '', source: 'plugin', plugin: 'demo' }]);
    assert.deepEqual(out[0], { name: 'compact', description: 'Summarize', argHint: '[instructions]', source: 'builtin', dialog: false, plugin: '' });
    assert.equal(out[1].dialog, true);
    assert.equal(out[2].plugin, 'demo');
    assert.equal(out[2].name, 'demo:lint');
  });

  test('(−) drops entries with a bad name, an unknown source, or the wrong shape; names with a space or control character never get in', () => {
    const bad = [null, 7, 'x', [], {}, { ...GOOD, name: '' }, { ...GOOD, name: 'a b' }, { ...GOOD, name: 'a\nb' }, { ...GOOD, name: '/compact' }, { ...GOOD, name: 'a'.repeat(300) }, { ...GOOD, name: 5 }, { ...GOOD, source: 'web' }, { ...GOOD, source: undefined }];
    assert.deepEqual(cleanCommands(bad), []);
    assert.deepEqual(names(cleanCommands([...bad, GOOD])), ['compact']);
  });

  test('(−) text fields that are not strings become empty, long ones are cut, a stray dialog or plugin value is ignored', () => {
    const [c] = cleanCommands([{ ...GOOD, description: 5, argHint: { x: 1 }, dialog: 'yes', plugin: 'demo' }]);
    assert.equal(c.description, '');
    assert.equal(c.argHint, '');
    assert.equal(c.dialog, false);
    assert.equal(c.plugin, '', 'plugin is read only for plugin entries');
    const [long] = cleanCommands([{ ...GOOD, description: 'd'.repeat(900), argHint: 'h'.repeat(900) }]);
    assert.ok(long.description.length <= 200 && long.argHint.length <= 100);
  });

  test('(−) not an array: nothing; a huge array is cut', () => {
    for (const v of [null, undefined, {}, 'x']) assert.deepEqual(cleanCommands(v), []);
    assert.ok(cleanCommands(Array.from({ length: 5000 }, (_, i) => ({ ...GOOD, name: `c${i}` }))).length <= 1000);
  });
});

describe('sourceLabel', () => {
  test('(+) Built-in, Personal, Project, Plugin <name>', () => {
    assert.equal(sourceLabel({ source: 'builtin' }), 'Built-in');
    assert.equal(sourceLabel({ source: 'user' }), 'Personal');
    assert.equal(sourceLabel({ source: 'project' }), 'Project');
    assert.equal(sourceLabel({ source: 'plugin', plugin: 'demo-tools' }), 'Plugin demo-tools');
    assert.equal(sourceLabel({ source: 'plugin', plugin: '' }), 'Plugin');
  });

  test('(−) an unknown source, a missing entry or a prototype name gives no tag', () => {
    for (const v of [{ source: 'web' }, { source: 'constructor' }, {}, null, undefined]) assert.equal(sourceLabel(v), '', String(v?.source));
  });
});

describe('commandsButton: the Commands button state (spec 9.7)', () => {
  test('(+) an empty box with Shell off: live', () => {
    const b = commandsButton({ shell: false, empty: true });
    assert.equal(b.off, false);
    assert.equal(b.title, 'Commands (/)');
  });

  test('(−) text in the box: off, and the title says what to do', () => {
    assert.deepEqual(commandsButton({ shell: false, empty: false }), { off: true, title: 'Empty the message box to pick a command' });
  });

  test('(−) Shell on: off with its own title, whatever the box holds', () => {
    assert.deepEqual(commandsButton({ shell: true, empty: true }), { off: true, title: 'Turn Shell off to pick a command' });
    assert.deepEqual(commandsButton({ shell: true, empty: false }), { off: true, title: 'Turn Shell off to pick a command' });
  });
});

describe('shouldFetch: once per window, again on a later open after 10 s, one request at a time', () => {
  const NOW = 1_000_000;

  test('(+) the first open fetches', () => {
    assert.equal(shouldFetch({ loadedAt: null, now: NOW, busy: false }), true);
  });

  test('(+) a later open fetches only when the last good answer is older than 10 s', () => {
    assert.equal(shouldFetch({ loadedAt: NOW - 10_001, now: NOW, busy: false }), true);
    assert.equal(shouldFetch({ loadedAt: NOW - 10_000, now: NOW, busy: false }), false);
    assert.equal(shouldFetch({ loadedAt: NOW - 100, now: NOW, busy: false }), false);
  });

  test('(−) never while a request is in flight, whatever the age', () => {
    assert.equal(shouldFetch({ loadedAt: null, now: NOW, busy: true }), false);
    assert.equal(shouldFetch({ loadedAt: NOW - 60_000, now: NOW, busy: true }), false);
  });

  test('(−) a clock that went backwards does not make it fetch on every open', () => {
    assert.equal(shouldFetch({ loadedAt: NOW + 5_000, now: NOW, busy: false }), false);
  });
});

describe('paletteView: what the list shows, in the exact copy of spec 9.7', () => {
  const LIST = [cmd('compact', 'Summarize'), cmd('config', 'Settings'), cmd('copy', 'Copy')];

  test('(+) a list: the ranked items, "<n> match /<q>" in the header, the polite announcement', () => {
    const v = paletteView({ list: LIST, failed: false, query: 'co' });
    assert.equal(v.kind, 'list');
    assert.deepEqual(names(v.items), ['compact', 'config', 'copy']);
    assert.equal(v.head, '3 match /co');
    assert.equal(v.note, '');
    assert.equal(v.say, '3 commands. Up and Down to choose, Enter to insert, Escape to close.');
  });

  test('(+) one command says "1 command"; an empty query counts the commands instead of matches', () => {
    assert.equal(paletteView({ list: LIST, failed: false, query: 'compa' }).say, '1 command. Up and Down to choose, Enter to insert, Escape to close.');
    const all = paletteView({ list: LIST, failed: false, query: '' });
    assert.equal(all.head, '3 commands');
    assert.equal(paletteView({ list: [LIST[0]], failed: false, query: '' }).head, '1 command');
  });

  test('(+) nothing matches: the empty line names the query and says Enter still sends', () => {
    const v = paletteView({ list: LIST, failed: false, query: 'xyz' });
    assert.equal(v.kind, 'empty');
    assert.deepEqual(v.items, []);
    assert.equal(v.note, 'No command matches /xyz. Enter sends the text as typed.');
    assert.equal(v.say, v.note);
    assert.equal(v.head, '');
  });

  test('(+) loading while there is no list and no failure', () => {
    const v = paletteView({ list: null, failed: false, query: 'co' });
    assert.equal(v.kind, 'loading');
    assert.equal(v.note, `Loading commands${DOTS}`);
    assert.deepEqual(v.items, []);
  });

  test('(−) a failed first load: the error line, no items, even when the query would match', () => {
    const v = paletteView({ list: null, failed: true, query: 'co' });
    assert.equal(v.kind, 'error');
    assert.equal(v.note, "Couldn't load the command list. Enter sends the text as typed.");
    assert.deepEqual(v.items, []);
  });

  test('(−) a failed refresh keeps the list that is already there', () => {
    assert.equal(paletteView({ list: LIST, failed: true, query: 'co' }).kind, 'list');
  });

  test('(−) a path-like query on a real list is the empty state, not an error', () => {
    const v = paletteView({ list: LIST, failed: false, query: 'usr/bin/env' });
    assert.equal(v.kind, 'empty');
    assert.equal(v.note, 'No command matches /usr/bin/env. Enter sends the text as typed.');
  });
});

describe('insertion: what Enter, Tab or a click puts in the box', () => {
  test('(+) "/<name> " with the trailing space, and the argument line when there is a hint', () => {
    assert.deepEqual(insertion({ name: 'model', argHint: '[model]' }), { text: '/model ', hint: 'Arguments: [model]' });
    assert.deepEqual(insertion({ name: 'demo:lint', argHint: '' }), { text: '/demo:lint ', hint: '' });
  });

  test('(−) a missing hint gives no argument line', () => {
    assert.equal(insertion({ name: 'clear' }).hint, '');
    assert.equal(insertion({ name: 'clear', argHint: 5 }).hint, '');
  });
});

describe('moveActive: arrows move without wrapping', () => {
  test('(+) down and up inside the list', () => {
    assert.equal(moveActive(0, 1, 5), 1);
    assert.equal(moveActive(3, -1, 5), 2);
  });

  test('(−) no wrap at either end; an empty list has no active option', () => {
    assert.equal(moveActive(4, 1, 5), 4);
    assert.equal(moveActive(0, -1, 5), 0);
    assert.equal(moveActive(0, 1, 0), -1);
    assert.equal(moveActive(-1, 1, 0), -1);
  });
});

describe('palette.js is data in, data out', () => {
  const src = read('public', 'palette.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

  test('(−) no HTML sinks, no style strings, no code evaluation', () => {
    const sinks = [/inner\s*HTML/, /insertAdjacent\s*HTML/, /outer\s*HTML/, /document\s*\.\s*write/, /\beval\s*\(/, /new\s+Function\b/, /css\s*Text/, /setAttribute\s*\(\s*['"`]style/i, /DOMParser/, /createContextualFragment/];
    for (const re of sinks) assert.doesNotMatch(src, re);
  });

  test('(−) no imports, no DOM, no network, storage or timers: it only computes', () => {
    assert.doesNotMatch(src, /^\s*import\b/m);
    assert.doesNotMatch(src, /\bdocument\b|\bwindow\b|\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|setTimeout|setInterval|Date\.now|\/api\//);
  });

  test('(+) the server serves /palette.js as JavaScript, next to the other public modules', () => {
    assert.match(read('src', 'server.js'), /\['\/palette\.js', \['palette\.js', 'text\/javascript; charset=utf-8'\]\]/);
  });

  test('(−) the file is pure ASCII (copy with an ellipsis is built from a code point)', () => {
    assert.equal([...read('public', 'palette.js')].every((ch) => ch.codePointAt(0) < 128), true);
  });
});
