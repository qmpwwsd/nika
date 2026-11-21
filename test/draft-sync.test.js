// The page side of draft sync (design W5, docs/contracts/api-app.md): public/draft-sync.js, with no DOM and no requests of its own.
// The controller runs against a fake box, a fake PUT route and a manual clock, so every timing rule (1.5 s of quiet before a
// pull, 250 ms before a push) is asserted exactly. Fixtures are synthetic (acme-api, demo-api).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normDraft, sameDraft, inEnvelope, fits, canon, screenCanon, cleanDraft, cutAt, caretAfter, noteView, draftSendPlan, createDraftSync,
  suggestionFor, submitResult, QUIET_MS, PUSH_MS,
  keepForm, cleanKept, keyOf, KEEP_MS, RESTORING_TEXT, RESTORED_TEXT, RESTORE_TEXT_FAILED, RESTORE_TEXT_SKIPPED, KEEP_FAILED, KEEP_NO_PROJECT,
} from '../public/draft-sync.js';
import { normDraft as srcNorm, sameDraft as srcSame, inEnvelope as srcEnvelope } from '../src/draft.js';

const sig = (n) => String(n).padStart(16, '0'); // 16 lowercase hex, like the server's
const BOX = { top: 30, bottom: 32 };
const text = (t, over = {}) => ({ state: 'text', mode: 'prompt', text: t, sig: sig(1), box: BOX, cursorAtEnd: true, suggestion: null, queued: false, ...over });
const empty = (over = {}) => ({ state: 'empty', mode: 'prompt', text: '', sig: sig(9), box: BOX, cursorAtEnd: true, suggestion: null, queued: false, ...over });
const unreadable = (reason, over = {}) => ({ state: 'unreadable', mode: 'prompt', text: '', sig: null, reason, box: BOX, cursorAtEnd: false, suggestion: null, queued: false, ...over });

describe('the twin helpers answer like src/draft.js', () => {
  const SAMPLES = ['', 'a', 'a b', 'a  ', 'a\t', '\ta', 'a ', 'a b  \nc d ', 'x\n\n y ', 'héllo ✓ ', '日本語  ', ' \n '];

  test('(+) normDraft and sameDraft agree on tabs, no-break spaces, trailing spaces and unicode', () => {
    for (const s of SAMPLES) assert.equal(normDraft(s), srcNorm(s), JSON.stringify(s));
    for (const a of SAMPLES) for (const b of SAMPLES) assert.equal(sameDraft(a, b), srcSame(a, b), `${JSON.stringify(a)} ${JSON.stringify(b)}`);
  });

  test('(−) non-strings are never the same', () => {
    assert.equal(normDraft(null), '');
    assert.equal(sameDraft(null, null), false);
    assert.equal(sameDraft('a', undefined), false);
    assert.equal(sameDraft(1, 1), false);
  });

  test('(+) inEnvelope agrees at 1024/1025 characters, 12/13 newlines, the row estimate, wide characters, tabs and bad input', () => {
    const cases = [
      ['x'.repeat(1024), 2000], ['x'.repeat(1025), 2000], ['a\n'.repeat(12), 120], ['a\n'.repeat(13), 120],
      ['x'.repeat(116 * 13), 120], ['x'.repeat(116 * 13 + 1), 120], ['日'.repeat(58 * 13), 120], ['日'.repeat(58 * 13 + 1), 120],
      ['\t\t\t', 12], ['', 120], ['a', 4], ['a', 5], ['a', 1.5], ['a', undefined], [42, 120], [null, 120], ['x'.repeat(300) + '\n' + 'y'.repeat(300), 120],
    ];
    for (const [t, cols] of cases) assert.deepEqual(inEnvelope(t, cols), srcEnvelope(t, cols), JSON.stringify([typeof t === 'string' ? t.length : t, cols]));
  });

  test('(−) the envelope refuses a run of 699 or more spaces and tabs (reason chars) like the server does, and 698 stays inside', () => {
    assert.deepEqual(inEnvelope(' '.repeat(698), 120), { ok: true }, '698 spaces');
    assert.notEqual(inEnvelope('\t'.repeat(698), 120).reason, 'chars', '698 tabs are too many rows (4 cells each), not too long a run');
    assert.deepEqual(inEnvelope('\t'.repeat(698), 120), srcEnvelope('\t'.repeat(698), 120));
    for (const unit of [' ', '\t']) {
      assert.deepEqual(inEnvelope(unit.repeat(699), 120), { ok: false, reason: 'chars' }, `699 x ${JSON.stringify(unit)}`);
      assert.deepEqual(inEnvelope(`a${unit.repeat(700)}b`, 200), { ok: false, reason: 'chars' });
    }
    assert.deepEqual(inEnvelope(' \t'.repeat(350), 200), { ok: false, reason: 'chars' }, 'a mixed run of 700');
    assert.deepEqual(inEnvelope(`${' '.repeat(400)}x${' '.repeat(400)}`, 200), { ok: true }, 'two runs of 400 with a character between them');
    assert.deepEqual(inEnvelope(' '.repeat(699), 120), srcEnvelope(' '.repeat(699), 120));
  });

  test('(+) the row estimate is the server\'s wrap simulation, not a division: a row that cannot hold the next word breaks early', () => {
    // 59 words of 4 + a space wrap 23 per row at w = 116 under the simulation; a division by the width says fewer rows
    for (const [t, cols] of [
      ['abcd '.repeat(23).trim() + ' ' + 'x'.repeat(115), 120], // the long token starts on the next row
      [['a', 'b', 'c'].map((c) => c.repeat(60)).join(' ').repeat(2), 120],
      [`${'日'.repeat(57)} 日日日`.repeat(13), 120],
      ['x'.repeat(231), 120], ['x'.repeat(232), 120], ['x'.repeat(233), 120],
    ]) assert.deepEqual(inEnvelope(t, cols), srcEnvelope(t, cols), JSON.stringify([t.length, cols]));
    const three = ['a', 'b', 'c'].map((c) => c.repeat(60)).join(' '); // 182 cells: 2 rows by a division, 3 by the simulation (no two 60-cell words share a 116-cell row)
    assert.deepEqual(inEnvelope([three, three, three, three].join('\n'), 120), { ok: true }, '12 rows');
    assert.deepEqual(inEnvelope([three, three, three, three, three].join('\n'), 120), { ok: false, reason: 'rows' }, '15 rows by the simulation, 10 by a division');
  });

  test('(+) fuzz parity: 6000 seeded texts of words, long tokens, wide characters, runs of spaces and tabs and newlines, at 40 to 200 columns, answer exactly like src/draft.js', () => {
    let seed = 0x5eed1234; // mulberry32: deterministic, no dependency
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = (list) => list[int(0, list.length - 1)];
    const word = (n) => Array.from({ length: n }, () => String.fromCharCode(int(97, 122))).join('');
    const wide = (n) => Array.from({ length: n }, () => String.fromCodePoint(int(0x4e00, 0x4e50))).join('');
    const emoji = (n) => Array.from({ length: n }, () => String.fromCodePoint(int(0x1f600, 0x1f64f))).join('');
    const piece = (w) => {
      const k = rnd();
      if (k < 0.10) { // rows filled to the exact cell: the boundary the wrap rules turn on (`used >= w`, `used + n > w`)
        const a = int(1, w - 2);
        return pick([`${word(a)} ${word(w - 1 - a)}`, `${word(a)} ${word(w - 1 - a)} ${word(int(1, 9))}`, `${word(w)} ${word(int(1, 9))}`, word(w), word(2 * w), `${word(a)} ${wide(Math.floor((w - 1 - a) / 2))}x`]);
      }
      if (k < 0.34) return word(int(1, 12));
      if (k < 0.44) return word(int(20, 260)); // a long token (a path, a hash)
      if (k < 0.52) return wide(int(1, 70));
      if (k < 0.56) return emoji(int(1, 30));
      if (k < 0.70) return ' '.repeat(int(1, 6));
      if (k < 0.74) return '\t'.repeat(int(1, 4));
      if (k < 0.755) return pick([' ', '\t']).repeat(int(690, 705)); // around the 699 limit
      if (k < 0.76) return ' \t'.repeat(int(340, 352));
      if (k < 0.82) return '\n'.repeat(int(1, 4));
      return '\n';
    };
    const seen = {};
    for (let i = 0; i < 6000; i += 1) {
      const target = pick([40, 120, 400, 900, 1100, 1500]);
      const cols = int(40, 200);
      let t = '';
      while (t.length < target && t.length < 1600) t += piece(cols - 4);
      const want = srcEnvelope(t, cols);
      const got = inEnvelope(t, cols);
      assert.deepEqual(got, want, `case ${i}: cols ${cols}, ${t.length} chars, ${JSON.stringify(t.slice(0, 80))}`);
      const key = want.ok ? 'ok' : want.reason;
      seen[key] = (seen[key] ?? 0) + 1;
    }
    for (const key of ['ok', 'chars', 'newlines', 'rows']) assert.ok((seen[key] ?? 0) >= 100, `the fuzz reaches '${key}' at least 100 times (${JSON.stringify(seen)})`);
  });

  test('(+) fits is the envelope plus "no control character but newline and tab" (the route answers 400 for those)', () => {
    assert.equal(fits('one line', 120), true);
    assert.equal(fits('a\tb\nc', 120), true);
    for (const bad of ['a\u0007b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\rb']) assert.equal(fits(bad, 120), false, JSON.stringify(bad));
    assert.equal(fits('x'.repeat(1025), 120), false);
    assert.equal(fits('a\n'.repeat(13), 120), false);
  });
});

describe('canon, screenCanon and the Shell toggle', () => {
  test('(+) Shell on is a leading "!", and so is a bash screen: one canonical form', () => {
    assert.equal(canon('ls -la', true), '!ls -la');
    assert.equal(canon('ls -la', false), 'ls -la');
    assert.equal(canon('', true), '!');
    assert.equal(screenCanon(text('ls -la', { mode: 'bash' })), '!ls -la');
    assert.equal(screenCanon(text('hello')), 'hello');
    assert.equal(screenCanon(empty({ mode: 'bash' })), '!');
    assert.equal(sameDraft(screenCanon(text('ls', { mode: 'bash' })), canon('ls', true)), true);
    assert.equal(sameDraft(screenCanon(text('ls', { mode: 'bash' })), canon('ls', false)), false);
  });
});

describe('cleanDraft: the capture body is data', () => {
  test('(+) a readable draft keeps its fields and nothing else', () => {
    const d = cleanDraft({ ...text('fix the typo'), edit: 'insert', extra: '<b>x</b>' });
    assert.deepEqual(d, text('fix the typo'));
    assert.equal(Object.hasOwn(d, 'edit'), false);
  });

  test('(+) an unreadable draft keeps its reason; an unknown reason reads as "layout"; text and sig are dropped', () => {
    assert.deepEqual(cleanDraft(unreadable('pasted', { text: 'leak' })), unreadable('pasted'));
    assert.equal(cleanDraft(unreadable('from-the-future')).reason, 'layout');
    assert.equal(cleanDraft(unreadable('pasted', { sig: sig(3) })).sig, null);
  });

  test('(+) the suggestion survives only as a string of at most 200 characters', () => {
    assert.equal(cleanDraft(empty({ suggestion: 'run the tests' })).suggestion, 'run the tests');
    assert.equal(cleanDraft(empty({ suggestion: 'x'.repeat(201) })).suggestion, null);
    assert.equal(cleanDraft(empty({ suggestion: 7 })).suggestion, null);
  });

  test('(+) queued (Claude holds our message, W13) survives only as the boolean true: anything else, and every older answer, is false', () => {
    assert.equal(cleanDraft(empty({ queued: true })).queued, true);
    assert.equal(cleanDraft(empty({ queued: false })).queued, false);
    for (const queued of ['true', 1, 'yes', {}, [], null, undefined]) assert.equal(cleanDraft(empty({ queued })).queued, false, String(queued));
    const old = empty();
    delete old.queued;
    assert.equal(cleanDraft(old).queued, false, 'an older server sends none');
    assert.equal(cleanDraft(unreadable('pasted', { queued: true })).queued, false, 'a paused draft is never queued');
  });

  test('(−) anything that is not exactly the shape is null (fail closed: no cut, no sync)', () => {
    const bad = [
      undefined, null, 'draft', 7, [], text('a', { state: 'maybe' }), text('a', { mode: 'vim' }), text(5), text('x'.repeat(4097)),
      text('a', { sig: 'xyz' }), text('a', { sig: sig(1).toUpperCase().replace(/0/g, 'G') }), text('a', { sig: null }), empty({ sig: undefined }),
      text('a', { box: null }), text('a', { box: { top: -1, bottom: 3 } }), text('a', { box: { top: 1.5, bottom: 3 } }), text('a', { box: { top: 5, bottom: 5 } }),
      text('a', { box: { top: 5, bottom: 4 } }), text('a', { box: { top: '3', bottom: 5 } }),
    ];
    for (const b of bad) assert.equal(cleanDraft(b), null, JSON.stringify(b));
  });

  // ---- LC18: Claude's task list pinned above the box (box.tasks, the row of its header); the glide's frame ends there (test/glide.test.js) ----
  const withTasks = (make, tasks, extra = {}) => make({ box: { top: 30, bottom: 32, tasks, ...extra } });

  test('(+) box.tasks survives when it is an integer from 0 up to (not including) the box\'s top, on a text, an empty and an unreadable draft', () => {
    for (const tasks of [0, 1, 17, 29]) {
      assert.deepEqual(cleanDraft(withTasks((o) => text('fix the typo', o), tasks)), text('fix the typo', { box: { top: 30, bottom: 32, tasks } }), `text / ${tasks}`);
      assert.deepEqual(cleanDraft(withTasks(empty, tasks)).box, { top: 30, bottom: 32, tasks }, `empty / ${tasks}`);
      assert.deepEqual(cleanDraft(withTasks((o) => unreadable('pasted', o), tasks)), unreadable('pasted', { box: { top: 30, bottom: 32, tasks } }), `unreadable / ${tasks}`);
    }
  });

  test('(−) a tasks that is not an integer, is negative, is the box\'s top or past it, or is a string number is dropped: the box is exactly { top, bottom } and the draft is kept', () => {
    for (const tasks of [1.5, -1, -0.5, 30, 31, 99, 2 ** 40, '17', '0', null, true, false, [], [17], {}, NaN, Infinity, -Infinity, undefined]) {
      for (const [name, make] of [['text', (o) => text('a', o)], ['empty', empty], ['unreadable', (o) => unreadable('pasted', o)]]) {
        const d = cleanDraft(withTasks(make, tasks));
        assert.notEqual(d, null, `${name} / ${String(tasks)}: only the field is dropped`);
        assert.deepEqual(d.box, { top: 30, bottom: 32 }, `${name} / ${String(tasks)}`);
        assert.equal(Object.hasOwn(d.box, 'tasks'), false, `${name} / ${String(tasks)}`);
        assert.deepEqual({ ...d, box: BOX }, { ...make({}), box: BOX }, `${name} / ${String(tasks)}: nothing else changes`);
      }
    }
  });

  test('(+) a box without the field (an older server, or no list) stays exactly { top, bottom }; other keys of the box are never kept', () => {
    assert.deepEqual(cleanDraft(text('a')).box, { top: 30, bottom: 32 });
    assert.deepEqual(cleanDraft(unreadable('pasted')).box, { top: 30, bottom: 32 });
    assert.deepEqual(cleanDraft(withTasks((o) => text('a', o), 3, { extra: '<b>x</b>', cursor: 4 })).box, { top: 30, bottom: 32, tasks: 3 });
  });

  test('(+) the cleaned box is a copy: the capture body is not kept', () => {
    const raw = text('a', { box: { top: 30, bottom: 32, tasks: 3 } });
    const d = cleanDraft(raw);
    assert.notEqual(d.box, raw.box);
    raw.box.tasks = 5;
    assert.equal(d.box.tasks, 3);
  });
});

describe('cutAt (design 5): where the mirror stops', () => {
  test('(+) a readable draft with Type into pane off cuts at the box top, empty or text', () => {
    assert.equal(cutAt(text('hello'), false), 30);
    assert.equal(cutAt(empty(), false), 30);
    assert.equal(cutAt(text('ls', { mode: 'bash' }), false), 30);
    assert.equal(cutAt(empty({ box: { top: 0, bottom: 2 } }), false), 0);
  });

  test('(+) an empty box that shows a prompt suggestion is cut like any other: the message box\'s placeholder shows it now (W4 lifts M-6)', () => {
    assert.equal(cutAt(empty({ suggestion: 'show me the contents of README.md' }), false), 30);
    assert.equal(cutAt(text('sh', { suggestion: 'show me' }), false), 30);
    assert.equal(cutAt(empty({ suggestion: null }), false), 30);
  });

  test('(−) a suggestion does not stop the other no-cut rules: Type into pane on, unreadable, null', () => {
    assert.equal(cutAt(empty({ suggestion: 'show me' }), true), null);
    assert.equal(cutAt(unreadable('pasted', { suggestion: 'show me' }), false), null);
    assert.equal(cutAt(null, false), null);
  });

  test('(−) unreadable, null, missing, malformed or Type into pane on: no cut', () => {
    assert.equal(cutAt(unreadable('pasted'), false), null);
    assert.equal(cutAt(null, false), null);
    assert.equal(cutAt(undefined, false), null);
    assert.equal(cutAt(text('hello'), true), null);
    assert.equal(cutAt({ state: 'text', box: { top: -2 } }, false), null);
    assert.equal(cutAt({ state: 'text', box: { top: 2.5 } }, false), null);
    assert.equal(cutAt({ state: 'text' }, false), null);
  });
});

describe('caretAfter: a pull keeps the typing position', () => {
  test('(+) text that only grew keeps the caret at the end; a caret inside the old text stays where it was', () => {
    assert.equal(caretAfter('fix the', 'fix the typo', 7), 12);
    assert.equal(caretAfter('fix the', 'fix the typo', 3), 3);
    assert.equal(caretAfter('', 'fix', 0), 3);
  });

  test('(+) text that was replaced puts the caret at the end', () => {
    assert.equal(caretAfter('abc', 'xyz!', 1), 4);
    assert.equal(caretAfter('abc', '', 3), 0);
    assert.equal(caretAfter('abcdef', 'abc', 6), 3);
  });
});

describe('noteView: the one note under the box', () => {
  test('(+) paused says why and what to do, per reason (exact copy)', () => {
    const want = {
      pasted: "a pasted block nika can't read back",
      tall: 'a draft longer than 14 rows',
      trailing: 'text that ends in spaces',
      history: 'a prompt-history entry',
      layout: "text nika can't read back exactly",
    };
    for (const [reason, why] of Object.entries(want)) {
      const v = noteView({ kind: 'paused', reason });
      assert.equal(v.label, 'Sync paused:');
      assert.equal(v.text, `Claude's input holds ${why}. Edit or clear it in the terminal.`);
      assert.equal(v.kind, 'paused');
      assert.ok(v.icon);
    }
    assert.match(noteView({ kind: 'paused', reason: 'from-the-future' }).text, /Claude's input holds text nika can't read back exactly\. Edit or clear it in the terminal\./);
  });

  test('(+) long text has its own word, icon and kind', () => {
    const long = noteView({ kind: 'long' });
    assert.deepEqual(long, { kind: 'long', icon: 'info', label: 'Not mirrored:', text: 'This text goes to Claude when you send it.' });
  });

  test('(+) W13: hold, cursor and queued say what they mean in the approved words, each with its own kind, icon and label', () => {
    assert.deepEqual(noteView({ kind: 'hold' }), {
      kind: 'hold', icon: 'dialog', label: 'On hold:',
      text: "A prompt is open or Stop is running. Your text goes into Claude's input when that is over.",
    });
    assert.deepEqual(noteView({ kind: 'cursor' }), {
      kind: 'cursor', icon: 'window', label: 'Cursor:',
      text: 'Claude is working and the cursor in its input is not at the end. Move it to the end in the terminal, or wait: your text goes in when Claude waits.',
    });
    assert.deepEqual(noteView({ kind: 'queued' }), { kind: 'queued', icon: 'send', label: 'Queued:', text: 'Claude takes your message at its next step.' });
  });

  test('(+) W13: all six notes differ in kind, icon and label (every state its own colour key, icon and word)', () => {
    const all = [{ kind: 'paused', reason: 'tall' }, { kind: 'long' }, { kind: 'hold' }, { kind: 'cursor' }, { kind: 'queued' }, { kind: 'suggest' }].map(noteView);
    for (const key of ['kind', 'icon', 'label']) assert.equal(new Set(all.map((v) => v[key])).size, 6, key);
  });

  test('(−) no note and unknown kinds give null; the old `wait` kind is gone', () => {
    assert.equal(noteView(null), null);
    assert.equal(noteView({ kind: 'party' }), null);
    assert.equal(noteView({ kind: 'wait' }), null);
  });
});

describe('draftSendPlan: the Send table (design 4)', () => {
  const plan = (over) => draftSendPlan({ value: 'fix the typo', shell: false, screen: text('fix the typo'), cols: 120, ...over });

  test('(+) row 1: the screen already equals the box: Enter alone, through the submit route with the screen\'s sig as base', () => {
    const p = plan({});
    assert.equal(p.act, 'enter');
    assert.deepEqual(p.submit, { base: sig(1) });
    assert.equal(p.summary, 'Enter');
    assert.equal(Object.hasOwn(p, 'payloads'), false, 'no keys-route body: Send never posts Enter there (W13)');
  });

  test('(+) fix round 1: a plan with text carries `textSummary` (what the echo of a queued message names); a lone Enter and a refusal do not', () => {
    assert.equal(plan({}).textSummary, '12 characters + Enter', 'enter: summary stays "Enter", the text is named apart');
    assert.equal(plan({}).summary, 'Enter');
    const pushed = plan({ screen: empty() });
    assert.equal(pushed.act, 'push');
    assert.equal(pushed.textSummary, '12 characters + Enter');
    assert.equal(pushed.summary, pushed.textSummary);
    const shellEnter = plan({ value: 'ls -la', shell: true, screen: text('ls -la', { mode: 'bash' }) });
    assert.equal(shellEnter.act, 'enter');
    assert.equal(shellEnter.textSummary, 'a shell command (6 characters) + Enter');
    const shellPush = plan({ value: 'ls -la', shell: true, screen: empty() });
    assert.equal(shellPush.act, 'push');
    assert.equal(shellPush.textSummary, 'a shell command (6 characters) + Enter');
    for (const p of [plan({ value: '', screen: text('typed in the terminal') }), plan({ value: '', screen: null }), plan({ value: '', screen: empty() }), plan({ screen: null }), plan({ screen: unreadable('pasted') })]) {
      assert.equal(Object.hasOwn(p, 'textSummary'), false, p.act);
    }
  });

  test('(+) row 1: equal up to trailing spaces, a tab or a trailing newline', () => {
    assert.equal(plan({ value: 'fix the typo   ' }).act, 'enter');
    assert.equal(plan({ value: 'fix the typo\n' }).act, 'enter');
    assert.equal(plan({ value: 'a\tb', screen: text('a    b') }).act, 'enter');
  });

  test('(+) row 1, Shell: a bash screen equal to "!" + the box is Enter alone, with no C-u first', () => {
    const p = plan({ value: 'ls -la', shell: true, screen: text('ls -la', { mode: 'bash' }) });
    assert.equal(p.act, 'enter');
    assert.deepEqual(p.submit, { base: sig(1) });
  });

  test('(+) row 2: nika\'s box is empty and Claude\'s input holds text, cannot be read or is not shown: Enter; the base is the sig of a readable screen, none otherwise', () => {
    for (const [screen, submit] of [[text('typed in the terminal'), { base: sig(1) }], [unreadable('pasted'), {}], [null, {}], [undefined, {}]]) {
      const p = plan({ value: '', screen });
      assert.equal(p.act, 'enter');
      assert.deepEqual(p.submit, submit);
    }
    assert.equal(plan({ value: '  \n ', screen: text('typed in the terminal') }).act, 'enter');
  });

  test('(−) row 2: both boxes empty (a readable empty screen, with or without a suggestion or Claude\'s queue) is nothing to send: no Enter, no request', () => {
    for (const screen of [empty(), empty({ suggestion: 'run the tests in acme-api' }), empty({ queued: true }), empty({ mode: 'bash' })]) {
      for (const value of ['', '  \n ', undefined, null]) assert.deepEqual(plan({ value, screen }), { act: 'none' }, JSON.stringify(value));
    }
  });

  test('(−) row 2: only an empty box over an empty screen is nothing: Shell keeps its own row, and text in either box still sends', () => {
    assert.equal(plan({ value: '', shell: true, screen: empty() }).act, 'legacy');
    assert.equal(plan({ value: 'a', screen: empty() }).act, 'push');
    assert.equal(plan({ value: '', screen: text('x') }).act, 'enter');
  });

  test('(−) W13: a sig that is not 16 lowercase hex never becomes a base (the route would answer 400)', () => {
    for (const bad of ['', 'xyz', sig(1).toUpperCase().replace(/0/g, 'G'), undefined, 7]) {
      assert.deepEqual(plan({ value: '', screen: text('typed in the terminal', { sig: bad }) }).submit, {}, String(bad));
    }
  });

  test('(−) row 2, Shell: an empty box with Shell on sends nothing (today: no lone "!")', () => {
    assert.equal(plan({ value: '', shell: true, screen: empty() }).act, 'legacy');
  });

  test('(+) row 3: text in the envelope and a different readable screen: push (the trimmed text), then Enter', () => {
    const p = plan({ value: 'fix the typo in acme-api ', screen: text('fix the') });
    assert.equal(p.act, 'push');
    assert.equal(p.text, 'fix the typo in acme-api', 'the trailing space stays out of Claude\'s box');
    assert.equal(Object.hasOwn(p, 'payloads') || Object.hasOwn(p, 'submit'), false, 'the Enter follows with the sig of the push (DS.send), not a sig known now');
    assert.equal(p.summary, '24 characters + Enter');
    assert.equal(plan({ value: 'a\nb', screen: empty() }).act, 'push', 'several lines in the envelope are pushed too, not pasted');
  });

  test('(+) row 3, Shell: push "!" + text, then Enter', () => {
    const p = plan({ value: 'ls -la', shell: true, screen: empty() });
    assert.equal(p.act, 'push');
    assert.equal(p.text, '!ls -la');
    assert.equal(p.summary, 'a shell command (6 characters) + Enter');
  });

  test('(+) row 4: text outside the envelope and an empty prompt: today\'s paste + Enter', () => {
    const long = 'y'.repeat(2000);
    assert.equal(plan({ value: long, screen: empty() }).act, 'legacy');
    assert.equal(plan({ value: 'a\n'.repeat(20), screen: empty() }).act, 'legacy');
    assert.equal(plan({ value: 'a\u0007b', screen: empty() }).act, 'legacy', 'a control character cannot be typed into the box');
  });

  test('(−) row 5: text outside the envelope while Claude\'s box holds other text: refused, with the exact line', () => {
    const p = plan({ value: 'y'.repeat(2000), screen: text('something else') });
    assert.equal(p.act, 'refuse');
    assert.equal(p.message, "Claude's input already holds text; it would be sent together with yours. Clear it in the terminal or shorten your message.");
    assert.equal(plan({ value: 'y'.repeat(2000), screen: empty({ mode: 'bash' }) }).act, 'refuse', 'a ! box is not an empty prompt');
  });

  test('(−) row 6: text and an unreadable screen: refused, naming the reason and the terminal', () => {
    const p = plan({ value: 'fix', screen: unreadable('pasted') });
    assert.equal(p.act, 'refuse');
    assert.equal(p.message, "Claude's input holds a pasted block nika can't read back. Send or clear it in the terminal.");
    assert.match(plan({ value: 'fix', screen: unreadable('history') }).message, /a prompt-history entry\. Send or clear it in the terminal\.$/);
  });

  test('(+) row 7: no readable box at all (prompt, dialog, unknown footer): today\'s path', () => {
    assert.equal(plan({ screen: null }).act, 'legacy');
    assert.equal(plan({ screen: undefined }).act, 'legacy');
    assert.equal(plan({ value: 'ls', shell: true, screen: null }).act, 'legacy');
  });

  test('(+) F1: no readable box on a KNOWN footer is still today\'s path (footerKnown true, and the default for a caller that does not know)', () => {
    for (const over of [{ footerKnown: true }, {}]) {
      assert.equal(plan({ screen: null, ...over }).act, 'legacy');
      assert.equal(plan({ value: 'ls', shell: true, screen: null, ...over }).act, 'legacy');
      assert.equal(plan({ value: '', screen: null, ...over }).act, 'enter');
    }
  });

  test('(−) F1: no readable box and an UNKNOWN footer (Claude\'s agent list has the focus): text, Shell text and the empty-box Enter are refused with the fixed line', () => {
    const line = "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.";
    for (const screen of [null, undefined]) {
      for (const over of [{}, { shell: true, value: 'ls' }, { value: 'y'.repeat(2000) }]) {
        assert.deepEqual(plan({ screen, footerKnown: false, ...over }), { act: 'refuse', message: line }, JSON.stringify(over));
      }
      for (const over of [{ value: '' }, { value: '  \n ' }]) { // an empty box: the line does not claim there is text to keep
        assert.deepEqual(plan({ screen, footerKnown: false, ...over }), { act: 'refuse', message: line.replace(' Your text is kept.', '') }, JSON.stringify(over));
      }
    }
    assert.equal(plan({ value: '', shell: true, screen: null, footerKnown: false }).act, 'legacy', 'Shell on and nothing to run: the page does nothing');
  });

  test('(+) F1: an unknown footer changes nothing when a box reads (it is the screen that decides then)', () => {
    assert.equal(plan({ footerKnown: false }).act, 'enter');
    assert.equal(plan({ screen: empty(), footerKnown: false }).act, 'push');
    assert.equal(plan({ value: '', screen: empty(), footerKnown: false }).act, 'none');
    assert.equal(plan({ screen: unreadable('pasted'), footerKnown: false }).act, 'refuse');
  });
});

// ---- the controller --------------------------------------------------------------------------------------------------------

/** A fake box, a fake PUT route and a manual clock. `type()` is the user typing in nika; `answer` scripts the route. */
function rig({ value = '', shell = false } = {}) {
  const st = { t: 5_000_000, timers: [], box: { value, shell } };
  // keeps / fetches / announces / problemMs: the kept text of 0.5.4 (LT), recorded apart from the draft PUTs; keepAnswer / fetchAnswer script its routes; setBoxError: the next setBox throws it (once)
  const log = { puts: [], sets: [], notes: [], problems: [], gone: 0, suggests: [], keeps: [], fetches: 0, announces: [], problemMs: [] };
  const r = { st, log, answer: null, suggestAnswer: null, keepAnswer: null, fetchAnswer: null, setBoxError: null };
  r.keepAnswer = () => ({ status: 200, body: { kept: true } });
  r.fetchAnswer = () => ({ status: 200, body: { kept: null } });
  r.answer = (body) => ({ status: 200, body: { draft: text(body.text.replace(/^!/, ''), { mode: body.text.startsWith('!') ? 'bash' : 'prompt', sig: sig(100 + log.puts.length) }), typed: body.text.length } });
  const io = {
    now: () => st.t,
    after(fn, ms) { const h = { at: st.t + ms, fn }; st.timers.push(h); return h; },
    cancel(h) { st.timers = st.timers.filter((x) => x !== h); },
    box: () => ({ ...st.box }),
    setBox(v, s) {
      if (r.setBoxError) { const e = r.setBoxError; r.setBoxError = null; throw e; }
      st.box = { value: v, shell: s };
      log.sets.push([v, s]);
    },
    put: async (body) => { log.puts.push(body); return r.answer(body); },
    suggest: async (body) => { log.suggests.push(body); return r.suggestAnswer(body); },
    note: (n) => log.notes.push(n),
    problem: (m, ms) => { log.problems.push(m); log.problemMs.push(ms); },
    gone: () => { log.gone += 1; },
    keep: async (body) => { log.keeps.push(body); return r.keepAnswer(body); },
    fetchKept: async () => { log.fetches += 1; return r.fetchAnswer(); },
    announce: (m) => log.announces.push(m),
  };
  r.ds = createDraftSync(io);
  const flush = () => new Promise((res) => { setImmediate(res); });
  r.flush = flush;
  r.advance = async (ms) => {
    const end = st.t + ms;
    for (;;) {
      st.timers.sort((a, b) => a.at - b.at);
      const next = st.timers[0];
      if (!next || next.at > end) break;
      st.timers.shift();
      st.t = Math.max(st.t, next.at);
      next.fn();
      await flush();
    }
    st.t = end;
    await flush();
  };
  r.type = (v, s = st.box.shell) => { st.box = { value: v, shell: s }; r.ds.edited(); };
  r.lastNote = () => log.notes.at(-1) ?? null;
  return r;
}

describe('pull: the terminal to the box (design 2)', () => {
  test('(+) a changed screen is pulled at once when the user has been quiet for 1.5 s; the Shell toggle follows the mode', () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.ds.capture(text('fix the typo in acme-api', { sig: sig(2) }), 120);
    assert.deepEqual(r.log.sets, [['fix the typo in acme-api', false]]);
    r.ds.capture(text('ls -la', { mode: 'bash', sig: sig(3) }), 120);
    assert.deepEqual(r.log.sets.at(-1), ['ls -la', true], 'a ! draft turns Shell on with the text');
    r.ds.capture(empty({ sig: sig(4) }), 120);
    assert.deepEqual(r.log.sets.at(-1), ['', false], 'and an empty prompt turns it off again');
  });

  test('(+) not before 1.5 s of quiet: the pull waits for the clock, with no new capture needed', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('abc');
    await r.advance(PUSH_MS); // the push lands: Claude shows abc
    assert.equal(r.log.puts.length, 1);
    r.ds.capture(text('abc and more', { sig: sig(2) }), 120); // the user typed in the terminal 300 ms after the last keystroke here
    assert.deepEqual(r.log.sets, [], 'too soon');
    await r.advance(QUIET_MS - PUSH_MS - 1);
    assert.deepEqual(r.log.sets, [], '1 ms short');
    await r.advance(1);
    assert.deepEqual(r.log.sets, [['abc and more', false]], 'exactly at 1.5 s');
  });

  test('(−) no pull while composing; it follows the end of the composition', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.ds.composition(true);
    r.ds.capture(text('typed in the terminal', { sig: sig(2) }), 120);
    await r.advance(5000);
    assert.deepEqual(r.log.sets, []);
    r.ds.composition(false);
    assert.deepEqual(r.log.sets, [['typed in the terminal', false]]);
  });

  test('(+) the first readable capture pulls only into an empty box', () => {
    const r = rig();
    r.ds.capture(text('already in claude', { sig: sig(2) }), 120);
    assert.deepEqual(r.log.sets, [['already in claude', false]]);
  });

  test('(−) the first readable capture never wipes text already in nika\'s box (and does not push it unless it was typed)', async () => {
    const r = rig({ value: 'restored text' });
    r.ds.capture(text('something else', { sig: sig(2) }), 120);
    await r.advance(5000);
    assert.deepEqual(r.log.sets, [], 'not wiped');
    assert.deepEqual(r.log.puts, [], 'not pushed: the user did not type it');
    r.type('restored text, and more'); // typed: now it is the user\'s edit and it wins
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 1);
    assert.equal(r.log.puts[0].base, sig(2));
  });

  test('(−) a screen that already reads like the box is not pulled (trailing spaces, tabs)', async () => {
    const r = rig({ value: 'fix the typo   ' });
    r.ds.capture(text('fix the typo'), 120);
    r.ds.capture(text('fix the typo', { sig: sig(2) }), 120);
    await r.advance(5000);
    assert.deepEqual(r.log.sets, []);
    assert.deepEqual(r.log.puts, []);
  });

  test('(−) text the user typed and not yet sent is never pulled over, even when the terminal changed meanwhile', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.answer = () => ({ status: 409, body: { error: 'busy-switching' } }); // the push keeps failing
    r.type('my own words');
    r.ds.capture(text('typed over there', { sig: sig(2) }), 120);
    await r.advance(10_000);
    assert.deepEqual(r.log.sets, [], 'nika wins while it holds unsent text');
  });

  test('(−) nothing is pulled while a write of ours is in flight', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    let release;
    r.answer = (body) => new Promise((res) => { release = () => res({ status: 200, body: { draft: text(body.text, { sig: sig(7) }) } }); });
    r.type('abc');
    await r.advance(PUSH_MS);
    r.ds.capture(text('ab', { sig: sig(5) }), 120); // the typing is landing: Claude shows a part of it
    await r.advance(5000);
    assert.deepEqual(r.log.sets, []);
    release();
    await r.flush();
    assert.deepEqual(r.log.sets, [], 'the answer is the end state; nothing to pull');
  });
});

describe('pause: a draft nika cannot read (design 2)', () => {
  test('(+) unreadable: the note says why, and nothing is pulled or pushed', async () => {
    const r = rig({ value: 'my text' });
    r.ds.capture(text('my text'), 120);
    r.type('my text, edited');
    r.ds.capture(unreadable('pasted'), 120);
    await r.advance(10_000);
    assert.deepEqual(r.log.sets, []);
    assert.deepEqual(r.log.puts, []);
    assert.equal(r.lastNote().kind, 'paused');
    assert.match(r.lastNote().text, /a pasted block nika can't read back/);
  });

  test('(+) the note is hidden again when the draft reads again, and the waiting edit is pushed', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.ds.capture(unreadable('trailing'), 120);
    assert.equal(r.lastNote().kind, 'paused');
    r.type('typed while paused');
    await r.advance(2000);
    assert.deepEqual(r.log.puts, []);
    r.ds.capture(empty({ sig: sig(2) }), 120);
    assert.equal(r.lastNote(), null);
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 1);
    assert.equal(r.log.puts[0].text, 'typed while paused');
  });

  test('(+) every reason has its note; the note is told once, not at every capture', () => {
    const r = rig();
    for (const reason of ['pasted', 'tall', 'trailing', 'history', 'layout']) {
      r.ds.capture(unreadable(reason), 120);
      r.ds.capture(unreadable(reason), 120);
      assert.equal(r.lastNote().text.includes('Edit or clear it in the terminal.'), true);
    }
    assert.equal(r.log.notes.length, 5, 'five reasons, five notes');
  });

  test('(−) a draft that is null (a prompt, a dialog) leaves the text alone, clears the note and waits', async () => {
    const r = rig();
    r.ds.capture(unreadable('pasted'), 120);
    r.type('draft in nika');
    r.ds.capture(null, 120);
    assert.equal(r.lastNote(), null);
    await r.advance(5000);
    assert.deepEqual(r.log.puts, [], 'the push waits for a box');
    assert.deepEqual(r.log.sets, []);
    assert.equal(r.st.box.value, 'draft in nika');
    r.ds.capture(empty(), 120);
    await r.advance(0);
    assert.equal(r.log.puts.length, 1, 'and goes as soon as the box is back');
  });
});

describe('the two timings are the spec\'s numbers (design 2, 3)', () => {
  test('(+) the constants are 1500 ms of quiet and 250 ms before a push', () => {
    assert.equal(QUIET_MS, 1500);
    assert.equal(PUSH_MS, 250);
  });

  test('(+) a push lands 250 ms after the last edit, not before and not much later', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    r.type('abc');
    await r.advance(249);
    assert.equal(r.log.puts.length, 0);
    await r.advance(1);
    assert.equal(r.log.puts.length, 1);
  });

  test('(+) a pull lands 1500 ms after the last local edit, not before', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    r.type('abc');
    await r.advance(250); // pushed; the box is clean again
    r.answer = () => ({ status: 200, body: { draft: text('abc', { sig: sig(60) }) } });
    r.ds.capture(text('typed over there', { sig: sig(61) }), 120);
    await r.advance(1248);
    assert.deepEqual(r.log.sets, [], 'still inside the quiet window (the last edit was 1498 ms ago)');
    await r.advance(2);
    assert.deepEqual(r.log.sets, [['typed over there', false]]);
  });
});

describe('push: the box to the terminal (design 3)', () => {
  test('(+) a local edit goes out 250 ms later with the screen\'s sig as base, not before', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    r.type('fix the typo');
    await r.advance(PUSH_MS - 1);
    assert.deepEqual(r.log.puts, []);
    await r.advance(1);
    assert.deepEqual(r.log.puts, [{ text: 'fix the typo', base: sig(4) }]);
  });

  test('(+) several edits inside the window are one push of the last text; the timer restarts at every edit', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('f');
    await r.advance(200);
    r.type('fi');
    await r.advance(200);
    r.type('fix');
    await r.advance(PUSH_MS - 1);
    assert.deepEqual(r.log.puts, []);
    await r.advance(1);
    assert.deepEqual(r.log.puts.map((p) => p.text), ['fix']);
  });

  test('(+) Shell on pushes "!" + the text; text with trailing spaces goes without them (a trailing space would make Claude\'s box unreadable)', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('ls -la', true);
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts[0].text, '!ls -la');
    r.type('echo hi   ', true);
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts[1].text, '!echo hi');
    r.type('see this \n', false);
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts[2].text, 'see this \n', 'only spaces at the very end go; a line break stays');
  });

  test('(+) the Shell toggle alone is an edit: the new form is pushed', async () => {
    const r = rig({ value: 'ls' });
    r.ds.capture(text('ls'), 120);
    r.st.box = { value: 'ls', shell: true };
    r.ds.edited();
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.puts.map((p) => p.text), ['!ls']);
  });

  test('(+) a 200 is the new state: seenSig follows, dirty ends, and the next capture of the same text pulls nothing', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('abc');
    await r.advance(PUSH_MS);
    r.ds.capture(text('abc', { sig: sig(101) }), 120);
    await r.advance(5000);
    assert.equal(r.log.puts.length, 1, 'no second push');
    assert.deepEqual(r.log.sets, [], 'and no pull');
  });

  test('(+) an edit made while a write is in flight is pushed after the answer, with the sig it returned', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    let release;
    r.answer = (body) => (r.log.puts.length === 1
      ? new Promise((res) => { release = () => res({ status: 200, body: { draft: text(body.text, { sig: sig(50) }) } }); })
      : { status: 200, body: { draft: text(body.text, { sig: sig(51) }) } });
    r.type('abc');
    await r.advance(PUSH_MS);
    r.type('abcd'); // typed while the first write is on its way
    await r.advance(PUSH_MS * 4);
    assert.equal(r.log.puts.length, 1, 'one request in flight at a time');
    release();
    await r.flush();
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.puts, [{ text: 'abc', base: sig(9) }, { text: 'abcd', base: sig(50) }]);
  });

  test('(−) no push when the screen already equals the box, or when nothing was edited', async () => {
    const r = rig({ value: 'same' });
    r.ds.capture(text('same'), 120);
    await r.advance(5000);
    r.type('same');
    await r.advance(5000);
    assert.deepEqual(r.log.puts, []);
  });

  test('(−) outside the envelope nothing is pushed and the note says the text goes on Send; back inside, it goes', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('x'.repeat(1100));
    await r.advance(5000);
    assert.deepEqual(r.log.puts, []);
    assert.equal(r.lastNote().kind, 'long');
    assert.equal(r.lastNote().text, 'This text goes to Claude when you send it.');
    r.type('x'.repeat(100));
    assert.equal(r.lastNote(), null);
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 1);
  });

  test('(−) the terminal\'s change is not pulled over long text either (it stays here)', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('x'.repeat(1100));
    r.ds.capture(text('typed over there', { sig: sig(2) }), 120);
    await r.advance(5000);
    assert.deepEqual(r.log.sets, []);
  });

  test('(−) no push while composing; it goes after the composition ends', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.ds.composition(true);
    r.type('ni');
    await r.advance(5000);
    assert.deepEqual(r.log.puts, []);
    r.ds.composition(false);
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 1);
  });

  test('(−) a programmatic set (a pull, a send) is not an edit: nothing is pushed back', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.ds.capture(text('from the terminal', { sig: sig(2) }), 120); // the pull sets the box without edited()
    await r.advance(5000);
    assert.deepEqual(r.log.puts, []);
  });
});

describe('push answers (design 3.1, 3.2, 7)', () => {
  const setup = async (status, body) => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.answer = () => ({ status, body });
    r.type('abc');
    await r.advance(PUSH_MS);
    return r;
  };

  for (const code of ['draft-changed', 'screen-changed', 'draft-mismatch']) {
    test(`(+) 409 ${code}: the screen's draft is pulled into the box and the edit is dropped (the terminal wins)`, async () => {
      const r = await setup(409, { error: code, draft: text('typed in the terminal', { sig: sig(7) }) });
      assert.deepEqual(r.log.sets, [['typed in the terminal', false]]);
      await r.advance(10_000);
      assert.equal(r.log.puts.length, 1, 'no second push of the old text');
    });
  }

  test('(+) 409 with a draft: text typed here after the request left stays and goes again with the new base', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    let release;
    r.answer = (body) => (r.log.puts.length === 1
      ? new Promise((res) => { release = () => res({ status: 409, body: { error: 'draft-changed', draft: text('typed in the terminal', { sig: sig(7) }) } }); })
      : { status: 200, body: { draft: text(body.text, { sig: sig(8) }) } });
    r.type('abc');
    await r.advance(PUSH_MS);
    r.type('abcd');
    release();
    await r.flush();
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.sets, []);
    assert.deepEqual(r.log.puts[1], { text: 'abcd', base: sig(7) });
  });

  test('(+) 409 draft-mismatch with an unreadable draft: the paused note, nothing pulled', async () => {
    const r = await setup(409, { error: 'draft-mismatch', draft: unreadable('pasted') });
    assert.deepEqual(r.log.sets, []);
    assert.equal(r.lastNote().kind, 'paused');
  });

  test('(+) 409 draft-unreadable { reason }: the paused note for that reason, with no retry loop', async () => {
    const r = await setup(409, { error: 'draft-unreadable', reason: 'history' });
    assert.match(r.lastNote().text, /a prompt-history entry/);
    await r.advance(10_000);
    assert.equal(r.log.puts.length, 1);
  });

  test('(+) 409 busy-switching: no note, no problem line, one quiet retry after a moment', async () => {
    const r = await setup(409, { error: 'busy-switching' });
    assert.deepEqual(r.log.problems, []);
    assert.equal(r.lastNote(), null);
    r.answer = (body) => ({ status: 200, body: { draft: text(body.text, { sig: sig(60) }) } });
    await r.advance(400);
    assert.equal(r.log.puts.length, 2);
  });

  test('(+) 409 not-idle: the "On hold" note (a prompt is open or Stop runs), a retry in 3 s, and it goes through then', async () => {
    const r = await setup(409, { error: 'not-idle' });
    assert.equal(r.lastNote().kind, 'hold');
    r.answer = (body) => ({ status: 200, body: { draft: text(body.text, { sig: sig(60) }) } });
    await r.advance(2900);
    assert.equal(r.log.puts.length, 1);
    await r.advance(200);
    assert.equal(r.log.puts.length, 2);
    assert.equal(r.lastNote(), null, 'the note ends with the push');
  });

  for (const code of ['input-unreadable', 'mode-unknown']) {
    test(`(+) 409 ${code}: the text stays, no note, and the next try waits a second`, async () => {
      const r = await setup(409, { error: code });
      assert.equal(r.lastNote(), null);
      assert.deepEqual(r.log.sets, []);
      await r.advance(900);
      assert.equal(r.log.puts.length, 1);
      await r.advance(200);
      assert.equal(r.log.puts.length, 2);
    });
  }

  test('(−) 400: the note says the text goes on Send, and it is not retried until the text changes', async () => {
    const r = await setup(400, { error: 'invalid' });
    assert.equal(r.lastNote().kind, 'long');
    await r.advance(20_000);
    assert.equal(r.log.puts.length, 1);
    r.type('abcd');
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 2);
  });

  test('(−) 404: the page learns the pane is gone and does not retry', async () => {
    const r = await setup(404, { error: 'not_found' });
    assert.equal(r.log.gone, 1);
    await r.advance(20_000);
    assert.equal(r.log.puts.length, 1);
  });

  test('(−) 429: a quiet retry after 700 ms, no problem line', async () => {
    const r = await setup(429, { error: 'rate_limited', draft: text('ab', { sig: sig(7) }) });
    assert.deepEqual(r.log.problems, []);
    r.answer = (body) => ({ status: 200, body: { draft: text(body.text, { sig: sig(61) }) } });
    await r.advance(700);
    assert.equal(r.log.puts.length, 2);
    assert.equal(r.log.puts[1].base, sig(7), 'the partial result is the new screen and the new base');
  });

  test('(−) the network (status 0): the problem line says the text is kept, once, and the push is retried', async () => {
    const r = await setup(0, null);
    assert.deepEqual(r.log.problems, ['nika did not answer. Your text is kept.']);
    await r.advance(2100);
    assert.equal(r.log.puts.length, 2);
    assert.equal(r.log.problems.length, 1, 'said once, not at every retry');
    assert.equal(r.st.box.value, 'abc');
  });

  test('(−) an unexpected status: one fixed problem line, and three tries at most until the user edits again', async () => {
    const r = await setup(500, { error: 'tmux', message: 'Evil <b>server</b> text' });
    assert.deepEqual(r.log.problems, ["nika couldn't copy your text into Claude's input. It is kept here."]);
    await r.advance(60_000);
    assert.equal(r.log.puts.length, 3);
    r.type('abcd');
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 4);
  });

  test('(−) a 200 with a broken body ends the edit and does not throw', async () => {
    const r = await setup(200, 'not json');
    await r.advance(5000);
    assert.equal(r.log.puts.length, 1);
    assert.deepEqual(r.log.sets, []);
  });

  test('(−) the server\'s own words never reach a note or a problem line', async () => {
    const r = await setup(409, { error: 'draft-unreadable', reason: 'x', message: 'Evil <b>server</b> text', draft: null });
    for (const n of r.log.notes) assert.doesNotMatch(JSON.stringify(n), /Evil/);
    const r2 = await setup(0, null);
    assert.doesNotMatch(JSON.stringify(r2.log.problems), /Evil/);
  });
});

describe('reconnect and stop', () => {
  test('(+) after reset() the next readable capture follows the first-capture rule again (no wipe)', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('mine');
    await r.advance(PUSH_MS);
    r.ds.reset();
    r.ds.capture(text('theirs', { sig: sig(3) }), 120);
    assert.deepEqual(r.log.sets, [], 'nika\'s box is not empty, so it is not wiped');
  });

  test('(+) stop() drops the waiting timer', async () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.type('abc');
    r.ds.stop();
    await r.advance(10_000);
    assert.deepEqual(r.log.puts, []);
  });
});

describe('send: the push before Enter (design 4)', () => {
  const ready = () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    return r;
  };

  test('(+) send() pushes with the sig the page last synced on and reports ok', async () => {
    const r = ready();
    r.ds.beginSend();
    const out = await r.ds.send('fix the typo');
    assert.deepEqual(out, { ok: true, sig: sig(101) }, 'the sig of the box as the write left it: the base of the Enter that follows');
    assert.deepEqual(r.log.puts, [{ text: 'fix the typo', base: sig(4) }]);
  });

  test('(−) a 200 whose draft has no readable sig gives the Enter no base (null), never a made-up one', async () => {
    const r = ready();
    r.answer = () => ({ status: 200, body: { draft: null } });
    r.ds.beginSend();
    assert.deepEqual(await r.ds.send('abc'), { ok: true, sig: null });
  });

  test('(−) the terminal moved on while the user typed: the Send pushes on the sig of the last sync, not the newest screen, so the route can refuse (design 4, 7)', async () => {
    const r = ready(); // synced on sig(4)
    r.type('abc');
    r.ds.capture(text('typed over there', { sig: sig(7) }), 120); // the screen changed; unsent text is never pulled over
    assert.deepEqual(r.log.sets, []);
    r.ds.beginSend();
    await r.ds.send('abc');
    assert.deepEqual(r.log.puts, [{ text: 'abc', base: sig(4) }], 'base is the last synced sig, so a changed screen is a 409');
  });

  test('(+) a write already in flight lands first, then the push of the Send', async () => {
    const r = ready();
    let release;
    r.answer = (body) => (r.log.puts.length === 1
      ? new Promise((res) => { release = () => res({ status: 200, body: { draft: text(body.text, { sig: sig(50) }) } }); })
      : { status: 200, body: { draft: text(body.text, { sig: sig(51) }) } });
    r.type('abc');
    await r.advance(PUSH_MS);
    r.st.box = { value: 'abcd', shell: false };
    r.ds.beginSend();
    const sent = r.ds.send('abcd');
    await r.flush();
    assert.equal(r.log.puts.length, 1, 'waits for the first write');
    release();
    assert.deepEqual(await sent, { ok: true, sig: sig(51) });
    assert.deepEqual(r.log.puts[1], { text: 'abcd', base: sig(50) });
  });

  test('(−) the terminal changed since the last sync: 409, nothing is sent, the screen\'s text is shown, the message is fixed copy', async () => {
    const r = ready();
    r.answer = () => ({ status: 409, body: { error: 'draft-changed', message: 'Evil <b>server</b> text', draft: text('typed over there', { sig: sig(7) }) } });
    r.ds.beginSend();
    const out = await r.ds.send('mine');
    assert.equal(out.ok, false);
    assert.equal(out.message, "Claude's input changed while nika was copying your text. nika shows what it holds now. Nothing was sent.");
    r.ds.endSend();
    assert.deepEqual(r.log.sets, [['typed over there', false]]);
  });

  test('(−) each refusal has its own fixed line', async () => {
    const lines = {};
    for (const [status, error, extra] of [
      [409, 'not-idle'], [409, 'input-unreadable'], [409, 'mode-unknown'], [409, 'busy-switching'], [409, 'draft-unreadable', { reason: 'tall' }],
      [409, 'cursor-not-at-end'], [409, 'clear-stopped'],
      [400, 'invalid'], [404, 'not_found'], [429, 'rate_limited'], [0, null], [500, 'tmux'],
    ]) {
      const r = ready();
      r.answer = () => ({ status, body: error ? { error, message: 'Evil <b>server</b> text', ...extra } : null });
      r.ds.beginSend();
      const out = await r.ds.send('abc');
      assert.equal(out.ok, false, `${status} ${error}`);
      assert.doesNotMatch(out.message, /Evil/);
      assert.match(out.message, /Nothing was sent|Your text is kept|session is gone|Send or clear it in the terminal/, `${status} ${error}`);
      lines[`${status} ${error}`] = out.message;
    }
    assert.equal(new Set(Object.values(lines)).size, 11, `distinct lines (404 and 0 differ, the two unreadable ones share): ${JSON.stringify(lines)}`);
  });

  test('(+) W13: the three new push refusals use the approved words', async () => {
    const want = {
      'not-idle': "A prompt is open in Claude or Stop is running, so nika can't change its input now. Nothing was sent. Your text is kept.",
      'cursor-not-at-end': 'Claude is working and the cursor in its input is not at the end. Move it to the end in the terminal, or send when Claude waits. Nothing was sent. Your text is kept.',
      'clear-stopped': "Claude's input did not clear in time. Nothing was sent. Your text is kept; send again.",
    };
    for (const [code, message] of Object.entries(want)) {
      const r = ready();
      r.answer = () => ({ status: 409, body: { error: code, message: 'Evil <b>server</b> text', draft: text('half', { sig: sig(8) }) } });
      r.ds.beginSend();
      assert.deepEqual(await r.ds.send('abc'), { ok: false, message }, code);
    }
  });

  test('(−) while a Send runs, captures neither pull nor push; endSend() lets the page sync again', async () => {
    const r = ready();
    r.ds.beginSend();
    r.type('abc');
    r.ds.capture(text('typed over there', { sig: sig(7) }), 120);
    await r.advance(10_000);
    assert.deepEqual(r.log.sets, []);
    assert.deepEqual(r.log.puts, []);
    r.ds.endSend();
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 1, 'the edit is still waiting and goes');
  });

  test('(+) sent() ends the edit: nothing is pushed over the submitted text', async () => {
    const r = ready();
    r.type('abc');
    r.ds.beginSend();
    r.ds.sent();
    r.st.box = { value: '', shell: false };
    r.ds.endSend();
    await r.advance(10_000);
    assert.deepEqual(r.log.puts, []);
  });
});


// Final review fix G3, R2 #1: after sent() the sync has "forgotten" the screen (seenSig ''), but a Send in that state must not write against the
// base '' (the route answers 409, "matches no screen") and must not pull Claude's input over text the user typed after the last capture.
describe('R2 #1: a quick second Send after sent()', () => {
  /** Message 1 went out through the attachments road: the screen is gone (no readable box after the Enter) and the box was cleared. */
  const afterSent = (first = 'first') => {
    const r = rig({ value: first });
    r.ds.capture(text(first, { sig: sig(5) }), 120);
    r.ds.beginSend();
    r.ds.submitted({ status: 200, body: { draft: null } });
    r.st.box = { value: '', shell: false };
    r.ds.sent();
    r.ds.endSend();
    assert.equal(r.ds.screen(), null);
    return r;
  };

  test('(+) sent(), the user types message 2, one capture is applied, Send: the put\'s base is that capture\'s sig and the text goes', async () => {
    const r = afterSent();
    await r.advance(10);
    r.type('second message');
    await r.advance(10);
    r.ds.capture(empty({ sig: sig(9) }), 120); // the screen is readable again: Send takes the push road
    await r.advance(10); // inside the 250 ms push debounce
    r.ds.beginSend();
    const out = await r.ds.send('second message');
    assert.deepEqual(r.log.puts, [{ text: 'second message', base: sig(9) }], 'not base ""');
    assert.equal(out.ok, true);
    assert.deepEqual(r.log.sets, [], 'the box is not touched');
    assert.equal(r.st.box.value, 'second message');
  });

  test('(+) the same without any edit in between: the base is the screen\'s sig (an empty message is Enter alone, so only the text case writes)', async () => {
    const r = afterSent();
    r.ds.capture(empty({ sig: sig(9) }), 120);
    r.ds.beginSend();
    await r.ds.send('third');
    assert.deepEqual(r.log.puts, [{ text: 'third', base: sig(9) }]);
  });

  test('(−) a 409 the page adopted keeps today\'s rule: the next Send in that state still writes with base "" (the route refuses it)', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    r.answer = () => ({ status: 409, body: { error: 'draft-changed', draft: text('typed over there', { sig: sig(7) }) } });
    r.ds.beginSend();
    assert.equal((await r.ds.send('mine')).ok, false);
    r.answer = () => ({ status: 409, body: { error: 'draft-changed', draft: text('typed over there', { sig: sig(7) }) } });
    await r.ds.send('mine');
    assert.deepEqual(r.log.puts.map((p) => p.base), [sig(4), ''], 'the adopted 409 forgot the screen it last matched; only sent() makes the next capture the base');
  });

  test('(−) the base is the screen\'s sig only after sent(): a page that never sent still writes against the sig it last synced on', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    r.type('abc');
    r.ds.capture(text('typed over there', { sig: sig(7) }), 120); // the terminal moved on; unsent text is never pulled over
    r.ds.beginSend();
    await r.ds.send('abc');
    assert.deepEqual(r.log.puts, [{ text: 'abc', base: sig(4) }]);
  });

  const REFUSED = { status: 409, body: { error: 'draft-changed', draft: text('typed over there', { sig: sig(7) }) } };

  test('(−) Send\'s own push is refused after the user edited since the last capture: the box keeps its text, the refusal says it is kept, and nothing is pulled over it', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    await r.advance(10);
    r.type('abc'); // an edit after the last applied capture
    await r.advance(20); // and the request leaves later than the edit: the user did not type after it left
    r.answer = () => REFUSED;
    r.ds.beginSend();
    const out = await r.ds.send('abc');
    assert.deepEqual(out, { ok: false, message: "Claude's input changed while nika was copying your text. Nothing was sent. Your text is kept." });
    r.ds.endSend();
    assert.deepEqual(r.log.sets, [], 'nothing pulled');
    assert.equal(r.st.box.value, 'abc');
    r.answer = (body) => ({ status: 200, body: { draft: text(body.text, { sig: sig(60) }) } });
    await r.advance(10_000);
    assert.deepEqual(r.log.sets, [], 'and the retry that follows does not pull either');
    assert.equal(r.st.box.value, 'abc');
    assert.equal(r.log.puts.at(-1).text, 'abc', 'the user\'s text goes on against the new sig, as any edit would');
    assert.equal(r.log.puts.at(-1).base, sig(7));
  });

  test('(−) no edit since the last capture: Send\'s refused push keeps today\'s rule (the terminal wins, its text is pulled, the old line)', async () => {
    const r = rig({ value: 'abc' });
    r.type('abc');
    await r.advance(10);
    r.ds.capture(empty({ sig: sig(4) }), 120); // the capture is newer than the edit
    await r.advance(10);
    r.answer = () => REFUSED;
    r.ds.beginSend();
    const out = await r.ds.send('abc');
    assert.equal(out.message, "Claude's input changed while nika was copying your text. nika shows what it holds now. Nothing was sent.");
    r.ds.endSend();
    assert.deepEqual(r.log.sets, [['typed over there', false]]);
  });

  test('(−) the refusals other than draft-changed do not change: screen-changed and draft-mismatch keep the box too after a fresh edit (same rule), with the same kept line', async () => {
    for (const error of ['screen-changed', 'draft-mismatch']) {
      const r = rig();
      r.ds.capture(empty({ sig: sig(4) }), 120);
      await r.advance(10);
      r.type('abc');
      await r.advance(20);
      r.answer = () => ({ status: 409, body: { error, draft: text('typed over there', { sig: sig(7) }) } });
      r.ds.beginSend();
      const out = await r.ds.send('abc');
      assert.match(out.message, /Nothing was sent\. Your text is kept\.$/, error);
      r.ds.endSend();
      assert.deepEqual(r.log.sets, [], error);
    }
  });

  test('(+) a Send whose push lands is unchanged by the edit rule: a 200 never marks the box dirty', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    await r.advance(10);
    r.type('abc');
    r.ds.beginSend();
    const out = await r.ds.send('abc');
    assert.deepEqual(out, { ok: true, sig: sig(101) });
    r.ds.sent();
    r.st.box = { value: '', shell: false };
    r.ds.endSend();
    await r.advance(10_000);
    assert.equal(r.log.puts.length, 1, 'nothing is pushed over the sent text');
  });
});

describe('suggestionFor (W4): the suggestion the message box shows as its placeholder and Tab accepts', () => {
  const SUG = 'run the tests in acme-api';
  const e = (over = {}) => empty({ suggestion: SUG, ...over });

  test('(+) a readable empty prompt draft with a suggestion, an empty box and Shell off gives the suggestion', () => {
    assert.equal(suggestionFor(e(), { value: '', shell: false }), SUG);
    assert.equal(suggestionFor(e()), SUG, 'the defaults are an empty box and Shell off');
    assert.equal(suggestionFor(e({ suggestion: 'x'.repeat(200) }), { value: '' }), 'x'.repeat(200));
  });

  test('(−) the box holds text, even one space: no suggestion', () => {
    for (const value of ['a', ' ', '\n', 'run the tests']) assert.equal(suggestionFor(e(), { value, shell: false }), null, JSON.stringify(value));
  });

  test('(−) Shell on: no suggestion (Shell is Claude\'s ! mode, which has none)', () => {
    assert.equal(suggestionFor(e(), { value: '', shell: true }), null);
  });

  test('(−) paused (an unreadable draft) and no box on screen (null) give none, whatever the old suggestion was', () => {
    assert.equal(suggestionFor(unreadable('pasted', { suggestion: SUG }), { value: '' }), null);
    assert.equal(suggestionFor(null, { value: '' }), null);
    assert.equal(suggestionFor(undefined, { value: '' }), null);
  });

  test('(−) a draft that holds text, a `!` box, no suggestion (the `Try "..."` placeholder is null before it gets here), a non-string or an over-long one', () => {
    assert.equal(suggestionFor(text('hello', { suggestion: SUG }), { value: '' }), null);
    assert.equal(suggestionFor(e({ mode: 'bash' }), { value: '' }), null);
    for (const suggestion of [null, undefined, '', 7, {}, ['x'], 'x'.repeat(201)]) assert.equal(suggestionFor(e({ suggestion }), { value: '' }), null, String(suggestion));
  });
});

describe('noteView: the suggestion note', () => {
  test('(+) its own word, icon and kind; it says which keys accept', () => {
    const v = noteView({ kind: 'suggest' });
    assert.equal(v.kind, 'suggest');
    assert.equal(v.label, 'Suggestion:');
    assert.equal(v.text, 'Tab or → accepts what Claude suggests.');
    const others = ['paused', 'long', 'hold', 'cursor', 'queued'].map((kind) => noteView({ kind, reason: 'tall' }));
    assert.equal(new Set([v.icon, ...others.map((o) => o.icon)]).size, 6, 'six states, six icons');
    assert.equal(new Set([v.label, ...others.map((o) => o.label)]).size, 6, 'and six words');
  });
});

describe('the suggestion note in the controller (W4)', () => {
  const SUG = 'run the tests in acme-api';
  const e = (over = {}) => empty({ suggestion: SUG, ...over });

  test('(+) an empty box over an empty screen that shows a suggestion: the note; typing hides it, clearing brings it back', () => {
    const r = rig();
    r.ds.capture(e(), 120);
    assert.equal(r.lastNote().kind, 'suggest');
    r.type('x');
    assert.equal(r.lastNote(), null, 'the box holds text: nothing to accept');
    r.type('');
    assert.equal(r.lastNote().kind, 'suggest');
  });

  test('(−) no note without a suggestion, with Shell on, while paused, and when no box is on screen', () => {
    const r = rig();
    r.ds.capture(empty(), 120);
    assert.equal(r.lastNote(), null);
    r.ds.capture(e(), 120);
    assert.equal(r.lastNote().kind, 'suggest');
    r.ds.capture(unreadable('pasted', { suggestion: SUG }), 120);
    assert.equal(r.lastNote().kind, 'paused', 'paused replaces it');
    r.ds.capture(e({ sig: sig(3) }), 120);
    assert.equal(r.lastNote().kind, 'suggest');
    r.ds.capture(null, 120);
    assert.equal(r.lastNote(), null);
    r.ds.capture(e({ sig: sig(4) }), 120);
    r.type('', true);
    assert.notEqual(r.lastNote()?.kind, 'suggest', 'Shell on');
  });

  test('(+) the note is told once per change, not at every capture', () => {
    const r = rig();
    for (let i = 0; i < 5; i += 1) r.ds.capture(e(), 120);
    assert.equal(r.log.notes.filter((n) => n?.kind === 'suggest').length, 1);
  });
});

describe('accept: Tab or the right arrow on the suggestion (W4)', () => {
  const SUG = 'run the tests in acme-api';
  const e = (over = {}) => empty({ suggestion: SUG, ...over });
  const taken = (over = {}) => ({ status: 200, body: { draft: text(SUG, { sig: sig(50), ...over }) } });

  test('(+) posts exactly { text }, then the answer\'s text becomes the box\'s text (a pull: no push follows)', async () => {
    const r = rig();
    r.suggestAnswer = () => taken();
    r.ds.capture(e(), 120);
    const out = await r.ds.accept(SUG);
    assert.deepEqual(r.log.suggests, [{ text: SUG }]);
    assert.deepEqual(out, { ok: true, status: 200, message: '' });
    assert.deepEqual(r.log.sets, [[SUG, false]]);
    await r.advance(5000);
    assert.deepEqual(r.log.puts, [], 'the text came from the terminal: nothing to push back');
    assert.equal(r.lastNote(), null, 'the suggestion note is gone');
    assert.deepEqual(r.ds.screen().text, SUG);
  });

  test('(+) the next capture of the same screen changes nothing', async () => {
    const r = rig();
    r.suggestAnswer = () => taken();
    r.ds.capture(e(), 120);
    await r.ds.accept(SUG);
    r.ds.capture(text(SUG, { sig: sig(50) }), 120);
    await r.advance(5000);
    assert.equal(r.log.sets.length, 1);
    assert.deepEqual(r.log.puts, []);
  });

  test('(+) the capture can show the accepted text before the answer arrives: one pull, no second', async () => {
    const r = rig();
    let release;
    r.suggestAnswer = () => new Promise((res) => { release = () => res(taken()); });
    r.ds.capture(e(), 120);
    const p = r.ds.accept(SUG);
    await r.flush();
    r.ds.capture(text(SUG, { sig: sig(50) }), 120);
    assert.deepEqual(r.log.sets, [[SUG, false]], 'pulled by the capture');
    release();
    assert.equal((await p).ok, true);
    assert.equal(r.log.sets.length, 1, 'the answer found the box already in sync');
    assert.deepEqual(r.log.puts, []);
  });

  test('(−) the user typed while the request was out: their text stays, and wins against the screen as with any edit', async () => {
    const r = rig();
    let release;
    r.suggestAnswer = () => new Promise((res) => { release = () => res(taken()); });
    r.ds.capture(e(), 120);
    const p = r.ds.accept(SUG);
    await r.flush();
    r.type('my own words');
    release();
    assert.equal((await p).ok, true);
    assert.deepEqual(r.log.sets, [], 'not overwritten');
    assert.equal(r.st.box.value, 'my own words');
  });

  test('(−) no request when the page\'s suggestion is not the one on the screen now, the box has text, Shell is on or the draft is paused', async () => {
    const r = rig();
    r.ds.capture(e({ suggestion: 'a newer suggestion' }), 120);
    assert.equal((await r.ds.accept(SUG)).ok, false);
    r.type('hello');
    r.ds.capture(e(), 120);
    assert.equal((await r.ds.accept(SUG)).ok, false, 'text in the box');
    r.type('', true);
    assert.equal((await r.ds.accept(SUG)).ok, false, 'Shell on');
    r.type('', false);
    r.ds.capture(unreadable('pasted', { suggestion: SUG }), 120);
    assert.equal((await r.ds.accept(SUG)).ok, false, 'paused');
    r.ds.capture(null, 120);
    assert.equal((await r.ds.accept(SUG)).ok, false, 'no box on screen');
    assert.deepEqual(r.log.suggests, []);
  });

  test('(−) no request while a Send runs or after the pane is gone', async () => {
    const r = rig();
    r.ds.capture(e(), 120);
    r.ds.beginSend();
    assert.equal((await r.ds.accept(SUG)).ok, false);
    r.ds.endSend();
    r.ds.stop();
    assert.equal((await r.ds.accept(SUG)).ok, false);
    assert.deepEqual(r.log.suggests, []);
  });

  test('(+) a write of ours that is still landing finishes first; the suggestion is then checked against the screen it left', async () => {
    const r = rig();
    r.ds.capture(e(), 120);
    let release;
    r.answer = () => new Promise((res) => { release = () => res({ status: 200, body: { draft: e({ sig: sig(60) }) } }); });
    r.type('abc');
    await r.advance(PUSH_MS);
    r.type('');
    const p = r.ds.accept(SUG);
    await r.flush();
    assert.deepEqual(r.log.suggests, [], 'waits for the write');
    r.suggestAnswer = () => taken();
    release();
    await r.flush();
    await p;
    assert.deepEqual(r.log.suggests.length, 1);
  });

  test('(−) 409 draft-changed: the screen\'s new suggestion is adopted (the note and the placeholder follow), nothing is pulled, a fixed line says so', async () => {
    const r = rig();
    r.suggestAnswer = () => ({ status: 409, body: { error: 'draft-changed', draft: e({ suggestion: 'a newer suggestion' }) } });
    r.ds.capture(e(), 120);
    const out = await r.ds.accept(SUG);
    assert.deepEqual([out.ok, out.status], [false, 409]);
    assert.equal(out.message, "Claude's suggestion changed. Nothing was sent.");
    assert.equal(r.ds.screen().suggestion, 'a newer suggestion');
    assert.deepEqual(r.log.sets, []);
  });

  test('(−) 409 draft-mismatch: the terminal wins, the text it holds is pulled', async () => {
    const r = rig();
    r.suggestAnswer = () => ({ status: 409, body: { error: 'draft-mismatch', draft: text('something else', { sig: sig(70) }) } });
    r.ds.capture(e(), 120);
    const out = await r.ds.accept(SUG);
    assert.equal(out.ok, false);
    assert.equal(out.message, "Claude's input did not take the suggestion. nika shows what it holds now.");
    assert.deepEqual(r.log.sets, [['something else', false]]);
  });

  test('(−) every refusal has fixed copy (no server word reaches the page), and a 404 says the session is gone', async () => {
    const want = [
      [{ status: 409, body: { error: 'not-idle', message: 'SERVER WORDS' } }, "Claude is working or a prompt is open, so nika can't accept the suggestion now. Nothing was sent."],
      [{ status: 409, body: { error: 'busy', message: 'SERVER WORDS' } }, "Claude is answering right now, so nika can't accept the suggestion. Nothing was sent."],
      [{ status: 409, body: { error: 'input-unreadable' } }, "nika can't read Claude's input box right now (a menu may be open). Nothing was sent."],
      [{ status: 409, body: { error: 'mode-unknown' } }, "nika can't read Claude's input box right now (a menu may be open). Nothing was sent."],
      [{ status: 409, body: { error: 'busy-switching' } }, 'Another action is running on this session. Try again in a moment.'],
      [{ status: 409, body: { error: 'draft-unreadable', reason: 'pasted', draft: unreadable('pasted') } }, "Claude's input holds a pasted block nika can't read back. Send or clear it in the terminal."],
      [{ status: 400, body: { error: 'invalid', message: 'SERVER WORDS' } }, "nika can't accept this suggestion."],
      [{ status: 429, body: { error: 'busy', message: 'SERVER WORDS' } }, 'Too many keys at once; try again.'],
      [{ status: 0, body: null }, 'nika did not answer.'],
      [{ status: 500, body: { error: 'x', message: 'SERVER WORDS' } }, "nika couldn't accept the suggestion."],
    ];
    for (const [answer, message] of want) {
      const r = rig();
      r.suggestAnswer = () => answer;
      r.ds.capture(e(), 120);
      const out = await r.ds.accept(SUG);
      assert.deepEqual([out.ok, out.message], [false, message], JSON.stringify(answer.body));
      assert.deepEqual(r.log.sets, []);
      assert.equal(r.log.gone, 0);
    }
    const gone = rig();
    gone.suggestAnswer = () => ({ status: 404, body: { error: 'not_found' } });
    gone.ds.capture(e(), 120);
    const out = await gone.ds.accept(SUG);
    assert.deepEqual([out.ok, out.message, gone.log.gone], [false, 'The session is gone.', 1]);
  });

  test('(−) a request that rejects reads as "nika did not answer", and a malformed answer is not trusted', async () => {
    const r = rig();
    r.suggestAnswer = () => { throw new Error('network'); };
    r.ds.capture(e(), 120);
    assert.deepEqual(await r.ds.accept(SUG), { ok: false, status: 0, message: 'nika did not answer.' });
    for (const answer of [null, undefined, 'x', { status: 200, body: 'x' }, { status: 200, body: { draft: 'no' } }, { status: 200, body: { draft: text('hi', { sig: 'zz' }) } }]) {
      const q = rig();
      q.suggestAnswer = () => answer;
      q.ds.capture(e(), 120);
      await q.ds.accept(SUG);
      assert.deepEqual(q.log.sets, [], JSON.stringify(answer));
    }
  });
});

// ---- W13: send while Claude works ------------------------------------------------------------------------------------------

describe('W13: Claude\'s queued placeholder is no suggestion', () => {
  test('(−) a queued draft gives no suggestion even if one rides along; the normal suggestion is still offered', () => {
    assert.equal(suggestionFor(empty({ suggestion: 'run the tests', queued: true }), { value: '' }), null);
    assert.equal(suggestionFor(empty({ suggestion: 'run the tests', queued: false }), { value: '' }), 'run the tests');
  });
});

describe('W13: the writes Claude refuses while it works (hold, cursor, clear-stopped)', () => {
  const setup = async (status, body) => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.answer = () => ({ status, body });
    r.type('abc');
    await r.advance(PUSH_MS);
    return r;
  };
  const ok = (r) => { r.answer = (body) => ({ status: 200, body: { draft: text(body.text, { sig: sig(60) }) } }); };

  test('(+) 409 cursor-not-at-end: the "Cursor" note, the text stays, nothing is pulled, one retry after 3 s that goes through', async () => {
    const r = await setup(409, { error: 'cursor-not-at-end', draft: text('older text in claude', { sig: sig(7) }) });
    assert.equal(r.lastNote().kind, 'cursor');
    assert.deepEqual(r.log.sets, [], 'the box keeps its text, the terminal\'s text is not adopted');
    assert.deepEqual(r.log.problems, [], 'a note, not a problem line');
    ok(r);
    await r.advance(2900);
    assert.equal(r.log.puts.length, 1);
    await r.advance(200);
    assert.equal(r.log.puts.length, 2);
    assert.equal(r.lastNote(), null, 'the note ends with the write');
  });

  test('(+) hold and cursor replace each other with the last refusal, and an edit clears either', async () => {
    const r = await setup(409, { error: 'not-idle' });
    assert.equal(r.lastNote().kind, 'hold');
    r.answer = () => ({ status: 409, body: { error: 'cursor-not-at-end', draft: text('older text in claude', { sig: sig(7) }) } });
    await r.advance(3000);
    assert.equal(r.lastNote().kind, 'cursor');
    r.answer = () => ({ status: 409, body: { error: 'not-idle' } });
    r.type('abcd');
    assert.equal(r.lastNote(), null, 'typing is a new attempt');
    await r.advance(PUSH_MS);
    assert.equal(r.lastNote().kind, 'hold');
  });

  test('(−) hold and cursor show only while the box holds unsent text', async () => {
    const r = await setup(409, { error: 'cursor-not-at-end', draft: text('older text in claude', { sig: sig(7) }) });
    assert.equal(r.lastNote().kind, 'cursor');
    r.type('');
    r.ds.capture(empty({ sig: sig(8) }), 120);
    assert.equal(r.lastNote(), null);
  });

  test('(−) 409 clear-stopped never adopts the partial text: the box keeps its text, the next try writes against the partial screen, a 200 settles it', async () => {
    const r = await setup(409, { error: 'clear-stopped', draft: text('a half-cleared te', { sig: sig(7) }) });
    assert.deepEqual(r.log.sets, [], 'nika\'s own partial clear is not the terminal\'s text');
    assert.deepEqual(r.log.problems, []);
    assert.equal(r.lastNote(), null);
    ok(r);
    await r.advance(900);
    assert.equal(r.log.puts.length, 1);
    await r.advance(200);
    assert.deepEqual(r.log.puts[1], { text: 'abc', base: sig(7) }, 'retried after 1 s on the partial screen\'s sig');
    assert.deepEqual(r.log.sets, []);
  });

  test('(−) clear-stopped counts toward the failures: the problem line shows at the third, then nothing more is pushed until the next edit', async () => {
    const r = await setup(409, { error: 'clear-stopped', draft: text('half', { sig: sig(7) }) });
    await r.advance(1000);
    assert.equal(r.log.puts.length, 2);
    assert.deepEqual(r.log.problems, []);
    await r.advance(1000);
    assert.equal(r.log.puts.length, 3);
    assert.deepEqual(r.log.problems, ["nika couldn't copy your text into Claude's input. It is kept here."]);
    await r.advance(30_000);
    assert.equal(r.log.puts.length, 3, 'given up');
    assert.deepEqual(r.log.sets, []);
    ok(r);
    r.type('abcd');
    await r.advance(PUSH_MS);
    assert.equal(r.log.puts.length, 4, 'an edit starts again');
  });

  test('(+) fix round 1: clear-stopped twice, then a 500 as the third failure: the problem line shows at that third failure and the sync gives up (never silently)', async () => {
    const r = await setup(409, { error: 'clear-stopped', draft: text('half', { sig: sig(7) }) });
    await r.advance(1000);
    assert.equal(r.log.puts.length, 2);
    assert.deepEqual(r.log.problems, [], 'two clears that stopped: still trying');
    r.answer = () => ({ status: 500, body: null });
    await r.advance(1000);
    assert.equal(r.log.puts.length, 3);
    assert.deepEqual(r.log.problems, ["nika couldn't copy your text into Claude's input. It is kept here."]);
    await r.advance(30_000);
    assert.equal(r.log.puts.length, 3, 'given up');
    assert.equal(r.log.problems.length, 1, 'said once');
  });

  test('(+) fix round 1: a 500 first and clear-stopped after it: the problem line shows once, at the first failure, and is not repeated', async () => {
    const r = await setup(500, null);
    assert.equal(r.log.problems.length, 1);
    r.answer = () => ({ status: 409, body: { error: 'clear-stopped', draft: text('half', { sig: sig(7) }) } });
    await r.advance(3000);
    assert.equal(r.log.puts.length, 2);
    await r.advance(1000);
    assert.equal(r.log.puts.length, 3);
    await r.advance(30_000);
    assert.equal(r.log.puts.length, 3, 'given up');
    assert.equal(r.log.problems.length, 1, 'said once for the whole run');
  });

  test('(+) fix round 1: a success ends the run of failures, so the next run says its problem again', async () => {
    const r = await setup(500, null);
    assert.equal(r.log.problems.length, 1);
    ok(r);
    await r.advance(3000);
    assert.equal(r.lastNote(), null);
    r.answer = () => ({ status: 500, body: null });
    r.type('abcd');
    await r.advance(PUSH_MS);
    assert.equal(r.log.problems.length, 2, 'a new run of failures speaks again');
  });

  test('(−) fix round 1: a later answer of another kind ends a stale "On hold" or "Cursor" note', async () => {
    for (const [first, second, firstKind] of [
      [{ error: 'not-idle' }, { error: 'clear-stopped', draft: text('half', { sig: sig(7) }) }, 'hold'],
      [{ error: 'cursor-not-at-end', draft: text('older', { sig: sig(7) }) }, { error: 'clear-stopped', draft: text('half', { sig: sig(8) }) }, 'cursor'],
      [{ error: 'not-idle' }, { error: 'input-unreadable' }, 'hold'],
      // (final review fix G3, R2 #6: busy-switching and 429 no longer end the note; they have their own tests below)
    ]) {
      const r = await setup(409, first);
      assert.equal(r.lastNote().kind, firstKind, 'the first refusal is named');
      r.answer = () => ({ status: 409, body: second });
      await r.advance(3000);
      assert.ok(r.log.puts.length >= 2, 'the retry ran');
      assert.equal(r.lastNote(), null, `${second.error} after ${first.error}: no stale ${firstKind} note`);
    }
  });

  // Final review fix G3, R2 #6: the note must not blink or be announced twice when a busy-switching or 429 answer sits between two refusals.
  test('(+) R2 #6: not-idle, busy-switching, not-idle: the "On hold" note never clears and is told once (also for a cursor refusal)', async () => {
    const r = await setup(409, { error: 'not-idle' });
    assert.deepEqual(r.log.notes.map((n) => n?.kind ?? null), ['hold']);
    r.answer = () => ({ status: 409, body: { error: 'busy-switching' } });
    await r.advance(3000);
    assert.equal(r.log.puts.length, 2, 'the busy-switching answer came');
    r.answer = () => ({ status: 409, body: { error: 'not-idle' } });
    await r.advance(300);
    assert.equal(r.log.puts.length, 3, 'and the next not-idle after the quiet 300 ms retry');
    assert.deepEqual(r.log.notes.map((n) => n?.kind ?? null), ['hold'], 'told once, never hidden in between');

    const c = await setup(409, { error: 'cursor-not-at-end', draft: text('older', { sig: sig(7) }) });
    c.answer = () => ({ status: 409, body: { error: 'busy-switching' } });
    await c.advance(3000);
    assert.deepEqual(c.log.notes.map((n) => n?.kind ?? null), ['cursor'], 'the cursor note stays through busy-switching as well');
  });

  test('(+) R2 #6: a 429 between two refusals keeps the note too (no blink, told once)', async () => {
    const r = await setup(409, { error: 'not-idle' });
    r.answer = () => ({ status: 429, body: { error: 'rate_limited' } });
    await r.advance(3000);
    assert.equal(r.log.puts.length, 2, 'the 429 answer came');
    assert.equal(r.lastNote().kind, 'hold');
    r.answer = () => ({ status: 409, body: { error: 'not-idle' } });
    await r.advance(700);
    assert.equal(r.log.puts.length, 3);
    assert.deepEqual(r.log.notes.map((n) => n?.kind ?? null), ['hold']);
  });

  test('(−) R2 #6: the note ends at the next answer of any other kind (a 200 ends it too), and busy-switching with no note before it does not make one', async () => {
    const r = await setup(409, { error: 'not-idle' });
    r.answer = () => ({ status: 409, body: { error: 'busy-switching' } });
    await r.advance(3000);
    ok(r);
    await r.advance(300);
    assert.equal(r.lastNote(), null, 'a 200 ends the note after the busy-switching answer');

    const fresh = await setup(409, { error: 'busy-switching' });
    assert.deepEqual(fresh.log.notes, [], 'no refusal before it: no note');
  });

  test('(−) fix round 1: a 500 or no answer at all (status 0) after a hold ends the note as well', async () => {
    for (const status of [500, 0]) {
      const r = await setup(409, { error: 'not-idle' });
      assert.equal(r.lastNote().kind, 'hold');
      r.answer = () => ({ status, body: null });
      await r.advance(3000);
      assert.equal(r.lastNote(), null, `${status}`);
    }
  });
});

describe('F14 round 2: 409 survey-undo (the clear needs an Escape that would undo Claude\'s rating)', () => {
  const LINE = 'Claude shows "Esc to undo" for the rating nika just sent, so nika sends no Esc for 4 seconds. Try again then.';
  const GENERIC = "nika couldn't copy your text into Claude's input. It is kept here.";
  const undo = (extra = {}) => ({ error: 'survey-undo', message: 'Evil <b>server</b> text', draft: text('older text in claude', { sig: sig(7) }), ...extra });
  const setup = async (status, body) => {
    const r = rig();
    r.ds.capture(empty(), 120);
    r.answer = () => ({ status, body });
    r.type('abc');
    await r.advance(PUSH_MS);
    return r;
  };

  test('(+) Send\'s push: 409 survey-undo gives the exact line, nothing is sent, and the server\'s text never shows', async () => {
    const r = rig();
    r.ds.capture(empty({ sig: sig(4) }), 120);
    r.answer = () => ({ status: 409, body: undo() });
    r.ds.beginSend();
    assert.deepEqual(await r.ds.send('abc'), { ok: false, message: LINE });
    assert.deepEqual(r.log.problems, [], 'Send returns the line; the sync does not say it a second time');
  });

  test('(+) the background write: 409 survey-undo says the line once (the same retry as any failed write), never adopts the screen\'s text', async () => {
    const r = await setup(409, undo());
    assert.deepEqual(r.log.problems, [LINE]);
    assert.deepEqual(r.log.sets, [], 'the box keeps its text');
    assert.equal(r.st.box.value, 'abc');
    await r.advance(3000);
    assert.equal(r.log.puts.length, 2, 'the existing retry, no new one');
    assert.equal(r.log.problems.length, 1, 'said once, not at every retry');
  });

  test('(+) once the undo row is gone the retry lands, and a later failure of another kind can say its own line', async () => {
    const r = await setup(409, undo());
    r.answer = (body) => ({ status: 200, body: { draft: text(body.text, { sig: sig(60) }) } });
    await r.advance(3000);
    assert.equal(r.log.puts.length, 2);
    assert.equal(r.log.problems.length, 1);
    r.answer = () => ({ status: 500, body: null });
    r.type('abcd');
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.problems, [LINE, GENERIC], 'a 200 ended the run, so the next failure is told again');
  });

  test('(−) an unknown 409 code still gets the generic lines, in both places, and the server\'s text never shows', async () => {
    for (const error of ['survey-undone', 'SURVEY-UNDO', 'something-new']) {
      const r = await setup(409, undo({ error }));
      assert.deepEqual(r.log.problems, [GENERIC], error);
      const s = rig();
      s.ds.capture(empty({ sig: sig(4) }), 120);
      s.answer = () => ({ status: 409, body: undo({ error }) });
      s.ds.beginSend();
      const out = await s.ds.send('abc');
      assert.equal(out.ok, false);
      assert.equal(out.message, "nika couldn't copy your text into Claude's input. Your text is kept.", error);
    }
  });

  test('(−) the code needs a 409: a 500 or a 400 that carries it keeps its own handling', async () => {
    const a = await setup(500, undo());
    assert.deepEqual(a.log.problems, [GENERIC]);
    const s = rig();
    s.ds.capture(empty({ sig: sig(4) }), 120);
    s.answer = () => ({ status: 400, body: undo() });
    s.ds.beginSend();
    assert.equal((await s.ds.send('abc')).message, "This text can't be copied into Claude's input as it is. Your text is kept.");
  });
});

describe('W13: the Queued note', () => {
  const q = (over = {}) => empty({ queued: true, ...over });

  test('(+) both boxes empty and in sync, the screen shows Claude\'s queued placeholder: the "Queued" note, told once', () => {
    const r = rig();
    for (let i = 0; i < 4; i += 1) r.ds.capture(q(), 120);
    assert.equal(r.lastNote().kind, 'queued');
    assert.equal(r.log.notes.filter((n) => n?.kind === 'queued').length, 1);
    r.ds.capture(empty(), 120);
    assert.equal(r.lastNote(), null, 'Claude took the message: the placeholder is gone');
  });

  test('(−) not while nika\'s box holds text, Shell is on, the screen holds text or is paused, or no box is on screen', () => {
    const r = rig();
    r.ds.capture(q(), 120);
    assert.equal(r.lastNote().kind, 'queued');
    r.type('next message');
    assert.notEqual(r.lastNote()?.kind, 'queued', 'a draft in the box');
    r.type('');
    assert.equal(r.lastNote().kind, 'queued');
    r.type('', true);
    assert.notEqual(r.lastNote()?.kind, 'queued', 'Shell on');
    r.type('', false);
    r.ds.capture(text('typed over there', { sig: sig(3), queued: true }), 120);
    assert.notEqual(r.lastNote()?.kind, 'queued', 'queued is only ever an empty box');
    r.ds.capture(unreadable('pasted'), 120);
    assert.equal(r.lastNote().kind, 'paused');
    r.ds.capture(null, 120);
    assert.equal(r.lastNote(), null);
  });

  test('(−) queued is never offered as a suggestion, so the suggestion note stays away', () => {
    const r = rig();
    r.ds.capture(q({ suggestion: 'run the tests in acme-api' }), 120);
    assert.equal(r.lastNote().kind, 'queued');
    assert.equal(suggestionFor(r.ds.screen(), { value: '' }), null);
  });
});

describe('W13: after the Enter (submitted, sent)', () => {
  const sentRig = (value = 'hello') => {
    const r = rig({ value });
    r.ds.capture(text(value, { sig: sig(5) }), 120);
    assert.deepEqual(r.log.sets, []);
    return r;
  };
  const clearBox = (r) => { r.st.box = { value: '', shell: false }; };

  test('(+) taken: the answer\'s empty screen replaces the one from before the Enter, so the sent text is not pulled back', async () => {
    const r = sentRig();
    r.ds.beginSend();
    r.ds.submitted({ status: 200, body: { taken: true, draft: empty({ sig: sig(9) }) } });
    clearBox(r);
    r.ds.sent();
    r.ds.endSend();
    await r.advance(10_000);
    assert.deepEqual(r.log.sets, []);
    assert.equal(r.ds.screen().sig, sig(9));
  });

  test('(+) taken with Claude\'s queue: the screen is the queued placeholder and the Queued note shows after the Send', async () => {
    const r = sentRig();
    r.ds.beginSend();
    r.ds.submitted({ status: 200, body: { taken: true, draft: empty({ queued: true }) } });
    clearBox(r);
    r.ds.sent();
    r.ds.endSend();
    assert.equal(r.lastNote().kind, 'queued');
  });

  test('(+) taken null (not proven) and the screen still holds the text: the sync forgets what it matched, so the text comes back into the box', async () => {
    const r = sentRig();
    r.ds.beginSend();
    r.ds.submitted({ status: 200, body: { taken: null, draft: text('hello', { sig: sig(5) }) } });
    clearBox(r);
    r.ds.sent();
    r.ds.endSend();
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.sets, [['hello', false]], 'nothing is lost: the text Claude still holds is shown again');
    assert.deepEqual(r.log.puts, [], 'and it is not pushed over itself');
  });

  test('(−) without the forget, the same screen would stay hidden: sent() is what makes the next capture win', async () => {
    const r = sentRig();
    r.ds.beginSend();
    r.ds.submitted({ status: 200, body: { draft: text('hello', { sig: sig(5) }) } });
    clearBox(r);
    r.ds.sent();
    r.ds.endSend();
    r.ds.capture(text('hello', { sig: sig(5) }), 120); // the very next capture shows the same text
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.sets, [['hello', false]]);
  });

  test('(+) fix round 1: an attachment send reports submitted(200, no draft) before the box is cleared: no step or composition end pulls the sent text back', async () => {
    const r = sentRig();
    r.ds.beginSend();
    r.ds.endSend();
    r.ds.submitted({ status: 200, body: { draft: null } });
    clearBox(r);
    r.ds.sent();
    r.ds.composition(true);
    r.ds.composition(false);
    await r.advance(10_000);
    assert.deepEqual(r.log.sets, [], 'the stale screen (the text, from before the Enter) is gone');
    assert.deepEqual(r.log.puts, []);
    assert.equal(r.ds.screen(), null);
  });

  test('(−) fix round 1: without that call the stale screen pulls the sent text back at the first step (why attach.js tells the sync)', async () => {
    const r = sentRig();
    r.ds.beginSend();
    r.ds.endSend();
    clearBox(r);
    r.ds.sent();
    r.ds.composition(false);
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.sets, [['hello', false]]);
  });

  test('(+) a refusal that carries a draft (draft-changed) is where the screen is; the next step pulls that text, the terminal wins', async () => {
    const r = sentRig();
    r.ds.beginSend();
    r.ds.submitted({ status: 409, body: { error: 'draft-changed', draft: text('typed over there', { sig: sig(7) }) } });
    r.ds.endSend();
    await r.advance(PUSH_MS);
    assert.deepEqual(r.log.sets, [['typed over there', false]]);
  });

  test('(−) a refusal with no draft (prompt-open, not-idle) leaves the screen as it was; garbage is not trusted; a 200 with no readable box says there is none', () => {
    const r = sentRig();
    const before = r.ds.screen();
    r.ds.submitted({ status: 409, body: { error: 'prompt-open' } });
    r.ds.submitted({ status: 409, body: { error: 'x', draft: { state: 'maybe' } } });
    r.ds.submitted({ status: 429, body: null });
    r.ds.submitted(undefined);
    r.ds.submitted({ status: 0, body: null });
    assert.equal(r.ds.screen(), before);
    r.ds.submitted({ status: 200, body: { taken: null, draft: null } });
    assert.equal(r.ds.screen(), null);
  });
});

describe('W13: submitResult and submitMessage (the submit route\'s answers, fixed copy)', () => {
  test('(+) 200 taken true or null is ok; Claude queues, and a box that could not be compared is not a failure', () => {
    assert.deepEqual(submitResult({ status: 200, body: { taken: true, draft: null } }), { ok: true, taken: true });
    assert.deepEqual(submitResult({ status: 200, body: { taken: null, draft: null } }), { ok: true, taken: null });
    for (const taken of [undefined, 'true', 1, {}]) assert.deepEqual(submitResult({ status: 200, body: { taken } }), { ok: true, taken: null }, String(taken));
    assert.deepEqual(submitResult({ status: 200, body: 'x' }), { ok: true, taken: null });
  });

  test('(−) 200 taken false keeps the text: not ok, with the approved words', () => {
    assert.deepEqual(submitResult({ status: 200, body: { taken: false } }), {
      ok: false,
      message: "nika pressed Enter, but Claude's input still shows your text (a menu may have taken the Enter). Check the terminal. Your text is kept.",
    });
  });

  test('(−) each 409 has its approved line; the server\'s own words never reach the page', () => {
    const want = {
      'prompt-open': 'A prompt opened in Claude, so nika did not press Enter. Answer it, then send again. Your text is kept.',
      'not-idle': 'Stop is running, so nika did not press Enter. Send again in a moment. Your text is kept.',
      'draft-changed': "Claude's input changed before Enter. nika shows what it holds now. Nothing was sent.",
      'screen-unclear': "nika can't tell what Claude is showing, so it did not press Enter. Use the terminal. Your text is kept.",
      'suggestion-shown': "Claude's input is empty and shows a suggestion, so nika did not press Enter. Nothing was sent.",
      'input-unreadable': "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.",
      'mode-unknown': "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.",
      'bypass-prompt': 'Answer this prompt in the terminal.',
      'busy-switching': 'Another action is running on this session. Try again in a moment. Your text is kept.',
    };
    for (const [code, message] of Object.entries(want)) {
      assert.deepEqual(submitResult({ status: 409, body: { error: code, message: 'Evil <b>server</b> text' } }), { ok: false, message }, code);
    }
  });

  test('(−) the other failures: 404, 429, no answer, 400, 500 and an unknown 409 code each read as a fixed line', () => {
    const lines = [
      [404, 'The session is gone.'],
      [429, 'Too many keys at once; try again. Your text is kept.'],
      [0, "nika did not answer, so it is not known whether Enter was pressed. Check Claude's input in the terminal. Your text is kept."],
      [400, "nika couldn't press Enter in Claude's input. Check the terminal. Your text is kept."],
      [500, "nika couldn't press Enter in Claude's input. Check the terminal. Your text is kept."],
    ];
    for (const [status, message] of lines) assert.equal(submitResult({ status, body: { error: 'x', message: 'Evil' } }).message, message, String(status));
    assert.equal(submitResult({ status: 409, body: { error: 'from-the-future', message: 'Evil' } }).message, "nika couldn't press Enter in Claude's input. Check the terminal. Your text is kept.");
    assert.equal(submitResult({ status: 409, body: null }).ok, false);
    assert.equal(submitResult(undefined).ok, false);
    assert.equal(submitResult({ status: 200, body: { taken: true } }).message, undefined);
    assert.doesNotMatch(JSON.stringify(lines.map(([, m]) => m)), /Evil/);
  });
});

// ---- LT (0.5.4): the unsent text that the sync does not mirror is kept, and comes back --------------------------------------------

describe('kept text (0.5.4, LT)', () => {
  const LONG = 'x'.repeat(1100); // past the envelope (1024 characters): Send pastes it, the sync never mirrors it
  const OVER_NOTE = { kind: 'over', icon: 'warn', label: 'Not kept:', text: "Over 16 KB: Send can't send it, and nika can't keep it if you leave. Shorten it or send it in parts." }; // the note of a text over 16 KB (round 1, SF-1)
  const okKept = (kept) => ({ status: 200, body: { kept } });
  const seq = (list, last) => () => (list.length ? list.shift() : last);

  /** A page that has booted: restore() asked and the server held nothing; the first capture is an empty Claude input, 120 columns. */
  async function booted(opts) {
    const r = rig(opts);
    await r.ds.restore();
    r.ds.capture(empty(), 120);
    return r;
  }

  /** restore() with the GET held: `during()` runs while it is held, then `answer` is given. */
  async function restoreHeld(r, answer, during) {
    r.fetchAnswer = () => new Promise((res) => { r.release = res; });
    const p = r.ds.restore();
    await r.flush();
    if (during) await during();
    r.release(answer);
    await p;
  }

  /** The draft PUTs are held until release(): the push is in flight. */
  function holdPuts(r) {
    const h = { release: null };
    r.answer = (body) => new Promise((res) => { h.release = () => res({ status: 200, body: { draft: text(body.text.replace(/^!/, ''), { sig: sig(200) }), typed: body.text.length } }); });
    return h;
  }

  // Tests added after the first mutation table of step 3 (each kills a mutant that the first set of tests let live; the table is in the report).
  describe('the keeping: states and timers pinned by the mutation round', () => {
    const E500 = { status: 500, body: null };
    const E429 = { status: 429, body: { error: 'busy', message: 'x' } };
    const OK = { status: 200, body: { kept: true } };

    test('(−) cleanKept refuses an array that carries the two fields', () => {
      assert.equal(cleanKept(Object.assign([], { text: 'x', shell: false })), null);
      assert.deepEqual(cleanKept({ text: 'x', shell: false }), { text: 'x', shell: false });
    });

    test('(+) D7: an edit after a 429 does not wait out the 1 s: the new text is kept KEEP_MS after the edit', async () => {
      const r = await booted();
      r.keepAnswer = seq([E429], OK);
      r.type(LONG);
      await r.advance(KEEP_MS); // the write is refused: a retry would be 1 s later
      assert.equal(r.log.keeps.length, 1);
      await r.advance(100);
      r.type(`${LONG}y`);
      await r.advance(KEEP_MS - 1);
      assert.equal(r.log.keeps.length, 1);
      await r.advance(1);
      assert.equal(r.log.keeps.length, 2, 'KEEP_MS after the edit, not after the 1 s wait');
    });

    test('(+) D16: a short text that the draft route refuses (400) is kept after KEEP_MS; accepted, it is never kept', async () => {
      const r = await booted();
      r.answer = () => ({ status: 400, body: { error: 'invalid', message: 'x' } });
      r.type('short words');
      await r.advance(PUSH_MS); // refused
      assert.deepEqual(r.log.keeps, []);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: 'short words', shell: false }]);
      const ok = await booted();
      ok.type('short words');
      await ok.advance(20000);
      assert.deepEqual(ok.log.keeps, [], 'a mirrored text is not kept');
    });

    test('(+) D4: the latch holds after a text over 16 KB: the shortened text that is still unsent is kept, and a second over-size text is told again (as the note, SF-1)', async () => {
      const r = await booted();
      const OVER = 'x'.repeat(16385);
      r.type(OVER);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.lastNote(), OVER_NOTE);
      assert.deepEqual(r.log.problems, [], 'the state is a note, not a problem line');
      assert.deepEqual(r.log.keeps, [], 'nothing over 16 KB is kept');
      holdPuts(r);
      r.type('y'.repeat(100));
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: 'y'.repeat(100), shell: false }], 'the shortened text is kept while it is unsent');
      assert.equal(r.lastNote(), null, 'and the over note is gone with the size');
      r.type('y'.repeat(101));
      r.type('y'.repeat(102));
      assert.equal(r.log.notes.filter((n) => n?.kind === 'over').length, 1, 'told once so far');
      r.type(OVER);
      assert.equal(r.log.notes.filter((n) => n?.kind === 'over').length, 2, 'and an over-size text after it is told again');
      assert.deepEqual(r.log.problems, []);
    });

    test('(+) D1: back to the text the server holds before the timer ran: the timer is cancelled and nothing is written', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.type(`${LONG}b`);
      assert.equal(r.st.timers.length, 1, 'armed for the other text');
      r.type(LONG);
      assert.equal(r.st.timers.length, 0, 'the server already holds this text: nothing is left armed');
      await r.advance(5000);
      assert.equal(r.log.keeps.length, 1);
    });

    test('(+) D7: one write at a time: a change while a write is on its way waits for its answer, then KEEP_MS', async () => {
      const r = await booted();
      let release = null;
      r.keepAnswer = () => new Promise((res) => { release = () => res(OK); });
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      r.type(`${LONG}y`);
      await r.advance(KEEP_MS * 3);
      assert.equal(r.log.keeps.length, 1, 'no second write while one is on its way');
      r.keepAnswer = () => OK;
      release();
      await r.flush();
      assert.equal(r.log.keeps.length, 1, 'not in the same breath: the new text waits KEEP_MS like any change');
      await r.advance(KEEP_MS - 1);
      assert.equal(r.log.keeps.length, 1);
      await r.advance(1);
      assert.deepEqual(r.log.keeps.at(-1), { text: `${LONG}y`, shell: false });
      assert.equal(r.log.keeps.length, 2);
    });

    test('(+) D3: sent() while a keep write is on its way clears right after its answer, with no KEEP_MS wait', async () => {
      const r = await booted();
      let release = null;
      r.keepAnswer = () => new Promise((res) => { release = () => res(OK); });
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      r.st.box = { value: '', shell: false };
      r.ds.sent();
      assert.equal(r.log.keeps.length, 1, 'one write at a time');
      r.keepAnswer = () => OK;
      release();
      await r.flush();
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false }, 'the clear follows the answer at once');
      assert.equal(r.log.keeps.length, 2);
    });

    test('(+) D3: sent() cancels a keep timer that was armed for the text typed after the last write: no timer is left', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.type(`${LONG}b`);
      assert.equal(r.st.timers.length, 1);
      r.st.box = { value: '', shell: false };
      r.ds.sent();
      assert.equal(r.st.timers.length, 0, 'at once, while the clear is on its way');
      await r.flush();
      assert.equal(r.st.timers.length, 0);
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
      assert.equal(r.log.keeps.length, 2);
    });

    test('(+) D7: after three failures a Send still clears at once; (−) a timer step does not (it waits for an edit)', async () => {
      const r = await booted();
      r.keepAnswer = () => E500;
      r.type(LONG);
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 3, 'three tries, then it waits for an edit');
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 3);
      r.st.box = { value: '', shell: false };
      r.keepAnswer = () => OK;
      r.ds.sent();
      await r.flush();
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
      assert.equal(r.log.keeps.length, 4);
    });

    test('(+) D7: a success zeroes the failure count: a clear that then fails twice is still retried', async () => {
      const r = await booted();
      r.keepAnswer = seq([E500, E500], OK);
      r.type(LONG);
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 3, 'the third try landed');
      r.st.box = { value: '', shell: false };
      r.keepAnswer = () => E500;
      r.ds.sent();
      await r.flush();
      assert.equal(r.log.keeps.length, 4, 'the clear went at once and failed');
      await r.advance(2000);
      assert.equal(r.log.keeps.length, 5, 'and it is retried: one failure, not three');
    });

    test('(−) D7: 429s are not failures: four of them are retried 1 s apart, then the write lands, and no line is shown', async () => {
      const r = await booted();
      r.keepAnswer = seq([E429, E429, E429, E429], OK);
      r.type(LONG);
      await r.advance(KEEP_MS + 4000 + 100);
      assert.equal(r.log.keeps.length, 5);
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 5);
      assert.deepEqual(r.log.problems, []);
    });

    test('(+) D7: the line is shown with the second failure, not before and not after', async () => {
      const r = await booted();
      r.keepAnswer = () => E500;
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.deepEqual([r.log.keeps.length, r.log.problems], [1, []]);
      await r.advance(1999);
      assert.deepEqual([r.log.keeps.length, r.log.problems], [1, []]);
      await r.advance(1);
      assert.deepEqual([r.log.keeps.length, r.log.problems], [2, [KEEP_FAILED]], 'with the second failure');
    });

    test('(+) D7: a success lets the next run of failures say its line again', async () => {
      const r = await booted();
      r.keepAnswer = seq([E500, E500, OK, E500, E500], OK);
      r.type(LONG);
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 3);
      assert.deepEqual(r.log.problems, [KEEP_FAILED]);
      r.type(`${LONG}y`);
      await r.advance(KEEP_MS);
      await r.advance(2000);
      assert.equal(r.log.keeps.length, 5);
      assert.deepEqual(r.log.problems, [KEEP_FAILED, KEEP_FAILED], 'a new run of failures is told again');
    });

    test('(+) D7: a write that did not land leaves the copy unknown: the same text is written again when the user goes back to it', async () => {
      for (const failure of [E500, E429]) {
        const r = await booted();
        r.type(LONG);
        await r.advance(KEEP_MS); // the server holds LONG
        r.keepAnswer = () => failure;
        r.type(`${LONG}b`);
        await r.advance(KEEP_MS);
        assert.equal(r.log.keeps.length, 2, `${failure.status}: the other text did not land`);
        r.keepAnswer = () => OK;
        r.type(LONG);
        await r.advance(KEEP_MS);
        assert.equal(r.log.keeps.length, 3, `${failure.status}: unknown, so written again`);
      }
    });

    test('(+) D13: stop() cancels a pending keep: no timer is left and nothing is written later', async () => {
      const r = await booted();
      r.type(LONG);
      assert.equal(r.st.timers.length, 1);
      r.ds.stop();
      assert.equal(r.st.timers.length, 0);
      await r.advance(5000);
      assert.equal(r.log.keeps.length, 0);
    });

    test('(−) D13: flushKeep with an io.keep that throws, and one that rejects, throws nothing and leaves no unhandled rejection', async () => {
      const r = await booted();
      r.type(LONG);
      r.keepAnswer = () => Promise.reject(new Error('boom'));
      assert.doesNotThrow(() => r.ds.flushKeep());
      await r.flush();
      assert.equal(r.log.keeps.length, 1);
      let calls = 0;
      const ds = createDraftSync({
        now: () => 1, after: () => 1, cancel() {}, box: () => ({ value: LONG, shell: false }), setBox() {}, put: async () => ({ status: 200, body: {} }), suggest: async () => ({ status: 200, body: {} }),
        note() {}, problem() {}, gone() {}, keep: () => { calls += 1; throw new Error('boom'); }, fetchKept: async () => ({ status: 200, body: { kept: null } }), announce() {},
      });
      await ds.restore();
      ds.capture(empty(), 120);
      ds.edited();
      assert.doesNotThrow(() => ds.flushKeep());
      assert.equal(calls, 1);
    });

    test('(−) D8: while the kept text is being brought back no timer of the sync or of the keeping is armed', async () => {
      for (const [value, what] of [[LONG, 'the keep timer'], ['short words', 'the push timer']]) {
        const r = await booted();
        r.type(value);
        assert.equal(r.st.timers.length, 1, `${what} is armed before`);
        r.fetchAnswer = () => new Promise(() => {});
        r.ds.restore();
        await r.flush();
        assert.equal(r.st.timers.length, 0, what);
      }
    });

    test('(+) D8: a draft write that is on its way is awaited before the GET is sent', async () => {
      const r = await booted();
      const held = holdPuts(r);
      r.type('short words');
      await r.advance(PUSH_MS);
      assert.equal(r.log.puts.length, 1, 'the push is on its way');
      const before = r.log.fetches;
      const p = r.ds.restore();
      await r.flush();
      assert.equal(r.log.fetches, before, 'the GET waits for the write');
      held.release();
      await r.flush();
      await p;
      assert.equal(r.log.fetches, before + 1);
    });

    test('(−) D8: stop() while the GET runs: its answer changes nothing (no box, no announcement)', async () => {
      const r = await booted();
      await restoreHeld(r, okKept({ text: 'late words', shell: false }), async () => { r.ds.stop(); });
      assert.deepEqual(r.log.sets, []);
      assert.deepEqual(r.log.announces, []);
    });

    test('(−) D11: a fetch that rejects counts as a failure: one retry, then the line and the hold', async () => {
      const r = rig();
      r.fetchAnswer = () => { throw new Error('boom'); };
      const p = r.ds.restore();
      await r.flush();
      await r.advance(2000);
      await p;
      assert.equal(r.log.fetches, 2);
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
    });

    test('(−) D11: an array that carries a kept field is not an answer: a failure like any other', async () => {
      for (const body of [Object.assign([], { kept: null }), Object.assign([], { kept: { text: 'x', shell: false } })]) {
        const r = rig();
        r.fetchAnswer = () => ({ status: 200, body });
        const p = r.ds.restore();
        await r.flush();
        await r.advance(2000);
        await p;
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
        assert.deepEqual(r.log.sets, []);
      }
    });

    test('(+) D11: a failed restore leaves the server copy unknown: the first edit writes the box even when it equals what was kept before', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      r.fetchAnswer = () => E500;
      const p = r.ds.restore();
      await r.flush();
      await r.advance(2000);
      await p;
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 2, 'unknown, so written');
    });

    test('(+) D12: the same text with another Shell flag is not the same copy: it is put back with the kept flag', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.fetchAnswer = () => okKept({ text: LONG, shell: true });
      await r.ds.restore();
      assert.deepEqual(r.log.sets.at(-1), [LONG, true]);
      assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
    });

    test('(+) D12: an equal copy settles the mark: a write that had failed is not retried', async () => {
      const r = await booted();
      r.keepAnswer = () => E500;
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1, 'the write failed: a retry is armed');
      r.fetchAnswer = () => okKept({ text: LONG, shell: false }); // the server holds it after all
      await r.ds.restore();
      await r.advance(10000);
      assert.equal(r.log.keeps.length, 1, 'no retry');
    });

    describe('put-back text starts fresh: the state of the text before does not hold it', () => {
      const same = (r) => { r.fetchAnswer = () => okKept({ text: 'second words', shell: false }); };

      test('(+) D9: a refusal (400) of the text before does not block the put-back text: it is pushed', async () => {
        const r = await booted();
        const ok = r.answer;
        r.answer = () => ({ status: 400, body: { error: 'invalid', message: 'x' } });
        r.type('first words');
        await r.advance(PUSH_MS);
        assert.equal(r.log.puts.length, 1);
        await r.advance(KEEP_MS); // the refused text is kept: this page saved it, so the box still holds its own saved copy when the other page's text is put back (MF-2)
        assert.deepEqual(r.log.keeps, [{ text: 'first words', shell: false }]);
        r.answer = ok;
        same(r);
        await r.ds.restore();
        await r.advance(PUSH_MS);
        assert.equal(r.log.puts.length, 2);
        assert.equal(r.log.puts[1].text, 'second words');
      });

      test('(+) D9: three failed pushes of the text before do not stop the put-back text: it is pushed', async () => {
        const r = await booted();
        const ok = r.answer;
        r.answer = () => E500;
        r.type('first words');
        await r.advance(20000);
        const n = r.log.puts.length;
        assert.ok(n >= 3, 'three tries');
        r.answer = ok;
        same(r);
        await r.ds.restore();
        await r.advance(20000);
        assert.equal(r.log.puts.length, n + 1);
        assert.equal(r.log.puts.at(-1).text, 'second words');
      });

      test('(+) D9: the "paused" mark of the text before (a refused write) is gone: the note is cleared by the put-back', async () => {
        const r = await booted();
        r.answer = () => ({ status: 409, body: { error: 'not-idle', message: 'x' } });
        r.type('first words');
        await r.advance(PUSH_MS);
        assert.equal(r.lastNote()?.kind, 'hold', 'the refusal shows its note');
        await r.advance(KEEP_MS); // kept: this page saved the text before (MF-2)
        assert.deepEqual(r.log.keeps, [{ text: 'first words', shell: false }]);
        same(r);
        await r.ds.restore();
        assert.equal(r.lastNote(), null, 'the put-back text has no such mark');
      });
    });
  });

  describe('the pure helpers', () => {
    test('(+) D5: keepForm turns CRLF and CR into a newline, removes C0 (but tab and newline), DEL and C1, and trailing newlines; a valid pair stays', () => {
      assert.equal(keepForm('a\r\nb\rc'), 'a\nb\nc');
      assert.equal(keepForm('a\u0007b\u001bc\u007fd\u0085e\u009ff\u0000g'), 'abcdefg');
      assert.equal(keepForm('hello\n\n\n'), 'hello');
      assert.equal(keepForm('hello\r\n\r\n'), 'hello');
      assert.equal(keepForm('one\n\ntwo'), 'one\n\ntwo');
      assert.equal(keepForm('a\ud83d\ude00b'), 'a\ud83d\ude00b');
      assert.equal(keepForm(''), '');
    });

    test('(+) D5: every lone surrogate becomes U+FFFD, two in a row too; both branches (toWellFormed there, and the loop when it is missing) answer alike', () => {
      const cases = [['a\udc00\udc00b', 'a\ufffd\ufffdb'], ['\ud800', '\ufffd'], ['\ud800\ud800', '\ufffd\ufffd'], ['\ud800a', '\ufffda'], ['a\udc00', 'a\ufffd'], ['\udc00\ud800', '\ufffd\ufffd'],
        ['\ud83d\ude00\ud83d', '\ud83d\ude00\ufffd'], ['\ud83d\ud83d\ude00', '\ufffd\ud83d\ude00']];
      for (const [raw, want] of cases) assert.equal(keepForm(raw), want, JSON.stringify(raw));
      const saved = String.prototype.toWellFormed;
      assert.equal(typeof saved, 'function', 'this Node has toWellFormed');
      delete String.prototype.toWellFormed;
      try {
        assert.equal(typeof ''.toWellFormed, 'undefined');
        for (const [raw, want] of cases) assert.equal(keepForm(raw), want, `loop: ${JSON.stringify(raw)}`);
      } finally {
        String.prototype.toWellFormed = saved;
      }
    });

    test('(−) D5: bidi marks, zero-width joiners, tabs and trailing spaces are kept as typed', () => {
      const typed = 'a\u200db\u202ec\td  \u200f e';
      assert.equal(keepForm(typed), typed);
      assert.equal(keepForm('line  \n'), 'line  ');
    });

    test('(+) cleanKept copies exactly { text, shell } of a keepable answer: 16 384 bytes pass, a Shell flag is kept', () => {
      assert.deepEqual(cleanKept({ text: 'abc\ndef\tg', shell: true, extra: 1, path: '/x' }), { text: 'abc\ndef\tg', shell: true });
      assert.deepEqual(cleanKept({ text: 'a'.repeat(16384), shell: false }), { text: 'a'.repeat(16384), shell: false });
      assert.deepEqual(cleanKept({ text: '\u20ac'.repeat(5461) + 'a', shell: false }).text.length, 5462);
      assert.deepEqual(Object.keys(cleanKept({ text: 'a', shell: false, more: 1 })).sort(), ['shell', 'text']);
    });

    test('(−) cleanKept refuses what the page would not have kept itself: a non-object, an empty text, a text that is not in its kept form, over 16 KB, a bad shell', () => {
      const bad = [
        null, undefined, 'x', 5, [], [{ text: 'a', shell: false }], {}, { text: 'a' }, { shell: false }, { text: '', shell: false }, { text: 5, shell: false }, { text: null, shell: false },
        { text: 'a', shell: 'true' }, { text: 'a', shell: 1 }, { text: 'a', shell: null }, { text: 'a\r', shell: false }, { text: 'a\r\nb', shell: false }, { text: 'a\u0007', shell: false },
        { text: 'a\u007f', shell: false }, { text: 'a\u0085', shell: false }, { text: 'a\n', shell: false }, { text: 'a\ud800', shell: false }, { text: 'a'.repeat(16385), shell: false },
        { text: '\u20ac'.repeat(5461) + 'ab', shell: false },
      ];
      for (const raw of bad) assert.equal(cleanKept(raw), null, JSON.stringify(raw)?.slice(0, 60));
    });

    test('(+) keyOf: nothing is the empty key; a copy is its text with a mark for the Shell flag', () => {
      assert.equal(keyOf(null), '');
      assert.equal(keyOf({ text: 'a', shell: false }), '-a');
      assert.equal(keyOf({ text: 'a', shell: true }), '!a');
      assert.notEqual(keyOf({ text: 'a', shell: false }), keyOf({ text: 'a', shell: true }));
    });

    test('(+) the copy is ASCII and says what the design says', () => {
      const copy = { RESTORING_TEXT, RESTORED_TEXT, RESTORE_TEXT_FAILED, RESTORE_TEXT_SKIPPED, KEEP_FAILED, KEEP_NO_PROJECT };
      assert.equal(RESTORING_TEXT, 'nika is bringing back the text you had not sent. Try again in a moment.');
      assert.equal(RESTORED_TEXT, 'Restored the text you had not sent.');
      assert.equal(RESTORE_TEXT_FAILED, "nika couldn't bring back the text you had not sent. Leave this session and open it again to try once more.");
      assert.equal(RESTORE_TEXT_SKIPPED, 'You started typing before nika could bring back the text you had not sent, so it was not put back.');
      assert.equal(KEEP_FAILED, "nika couldn't keep the text you have not sent. It is lost if you leave this session before you send it.");
      assert.equal(KEEP_NO_PROJECT, "nika can't keep unsent text for this session because it can't tell the session's project. It is lost if you leave before you send it.");
      for (const [name, line] of Object.entries(copy)) assert.match(line, /^[\x20-\x7e]+$/, name);
    });

    test('(+) KEEP_MS is 500, above PUSH_MS: a text the sync pushes is never kept', () => {
      assert.equal(KEEP_MS, 500);
      assert.ok(KEEP_MS > PUSH_MS);
    });
  });

  describe('keeping', () => {
    test('(+) D1: 1100 characters after an empty capture are kept once, at KEEP_MS after the last change', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS - 1);
      assert.deepEqual(r.log.keeps, []);
      await r.advance(1);
      assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }]);
      await r.advance(10000);
      assert.equal(r.log.keeps.length, 1, 'once, not again');
      assert.deepEqual(r.log.problems, []);
    });

    test('(−) D1: a short text that the sync pushes within PUSH_MS is never kept, and nothing is cleared either', async () => {
      const r = await booted();
      r.type('fix the typo in acme-api');
      await r.advance(10000);
      assert.equal(r.log.puts.length, 1, 'it was pushed');
      assert.deepEqual(r.log.keeps, [], 'and never kept');
    });

    test('(+) D1: the kept text is the newest: typing on moves the write to KEEP_MS after the last change', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(400);
      r.type(`${LONG}y`);
      await r.advance(KEEP_MS - 1);
      assert.deepEqual(r.log.keeps, []);
      await r.advance(1);
      assert.deepEqual(r.log.keeps, [{ text: `${LONG}y`, shell: false }]);
    });

    test('(+) D1: the kept form goes out, not the raw box: CRLF and a trailing newline are normalised, a control is removed', async () => {
      const r = await booted();
      r.type(`${LONG}\r\nsecond\u0007 line\r\n\r\n`);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: `${LONG}\nsecond line`, shell: false }]);
    });

    test('(−) D1: a text of only spaces and newlines is nothing to keep', async () => {
      const r = await booted();
      r.type(' '.repeat(1100));
      await r.advance(10000);
      assert.deepEqual(r.log.keeps, []);
      r.type('\n'.repeat(30));
      await r.advance(10000);
      assert.deepEqual(r.log.keeps, []);
    });

    test('(+) D2: the latch: a kept long text that is shortened until it fits is kept as the shorter text while it is unsent, and cleared after the push lands', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      const held = holdPuts(r);
      const shorter = 'y'.repeat(100);
      r.type(shorter);
      await r.advance(PUSH_MS);
      assert.equal(r.log.puts.length, 1, 'the push left and is not answered yet');
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps.at(-1), { text: shorter, shell: false }, 'the shorter text replaces the long one');
      assert.equal(r.log.keeps.length, 2);
      held.release();
      await r.flush();
      assert.equal(r.log.keeps.length, 2, 'no clear in the same breath');
      await r.advance(KEEP_MS - 1);
      assert.equal(r.log.keeps.length, 2);
      await r.advance(1);
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false }, 'the push landed, so Claude holds it: one clear');
      assert.equal(r.log.keeps.length, 3);
    });

    test('(−) D2: no clear while the shortened text is still unsent (the push is in flight)', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      holdPuts(r);
      r.type('y'.repeat(100));
      await r.advance(20000);
      assert.ok(r.log.keeps.every((k) => k.text !== ''), 'not one clear before the push is answered');
      assert.deepEqual(r.log.keeps.at(-1), { text: 'y'.repeat(100), shell: false });
    });

    test('(+) D3: sent() clears at once, with no KEEP_MS wait', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      r.st.box = { value: '', shell: false };
      r.ds.sent();
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false }, 'before any timer ran');
      assert.equal(r.log.keeps.length, 2);
      await r.advance(10000);
      assert.equal(r.log.keeps.length, 2, 'and once');
    });

    test('(+) D3: a box that is emptied is cleared KEEP_MS later', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.type('');
      await r.advance(KEEP_MS - 1);
      assert.equal(r.log.keeps.length, 1);
      await r.advance(1);
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
      assert.equal(r.log.keeps.length, 2);
    });

    test('(+) D3: a refused push whose 409 the terminal wins (adopted) clears the kept copy', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.answer = () => ({ status: 409, body: { error: 'draft-changed', draft: text('terminal text', { sig: sig(300) }) } });
      r.type('abc');
      await r.advance(PUSH_MS);
      assert.equal(r.log.puts.length, 1);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
    });

    test('(−) D3: when the user typed on during a send (no sent() call) the new text is kept and nothing is cleared', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.type(`${LONG} and a new second part`);
      await r.advance(10000);
      assert.deepEqual(r.log.keeps.map((k) => k.text.length > 0), [true, true]);
      assert.deepEqual(r.log.keeps.at(-1), { text: `${LONG} and a new second part`, shell: false });
    });

    test('(+) D4: Shell on keeps the flag, and toggling Shell is a new write of the same text', async () => {
      const r = await booted();
      r.type(LONG, true);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: LONG, shell: true }]);
      r.type(LONG, false);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: LONG, shell: true }, { text: LONG, shell: false }]);
    });

    test('(+) D6: exactly 16 384 bytes are kept; the multi-byte count is bytes, not characters', async () => {
      const r = await booted();
      r.type('a'.repeat(16384));
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      assert.equal(r.log.keeps[0].text.length, 16384);
      const r2 = await booted();
      r2.type('\u20ac'.repeat(5461) + 'a');
      await r2.advance(KEEP_MS);
      assert.equal(r2.log.keeps.length, 1, '16 384 bytes of 3-byte characters');
      assert.deepEqual(r.log.problems.concat(r2.log.problems), []);
    });

    test('(−) D6: 16 385 bytes are not kept: the over note (it stays while the state holds), a clear of what was kept, and back at 16 384 the note is the long one and the text is kept', async () => {
      const r = await booted();
      r.type('a'.repeat(16384));
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      assert.equal(r.lastNote().kind, 'long', 'exactly 16 384 bytes is not over');
      r.type('a'.repeat(16385));
      assert.deepEqual(r.lastNote(), OVER_NOTE);
      assert.deepEqual(r.log.problems, [], 'no problem line: the state has its own note');
      await r.advance(KEEP_MS);
      assert.deepEqual(r.lastNote(), OVER_NOTE, 'the note is still there after the clear');
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false }, 'what was kept is cleared: it could not be sent either');
      assert.equal(r.log.keeps.length, 2);
      r.type('a'.repeat(16384));
      assert.equal(r.lastNote().kind, 'long', 'back at 16 384 bytes the over note is replaced');
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps.at(-1), { text: 'a'.repeat(16384), shell: false });
      assert.equal(r.log.keeps.length, 3);
    });

    test('(−) D6: the over note is told once, not at every key; 16 385 multi-byte bytes are over too', async () => {
      const r = await booted();
      for (let i = 0; i < 5; i += 1) r.type('a'.repeat(16385 + i));
      await r.advance(10000);
      assert.deepEqual(r.log.notes, [OVER_NOTE]);
      assert.deepEqual(r.log.problems, []);
      assert.deepEqual(r.log.keeps, [], 'nothing was kept, so nothing to clear');
      const r2 = await booted();
      r2.type('\u20ac'.repeat(5461) + 'ab');
      assert.deepEqual(r2.lastNote(), OVER_NOTE);
    });

    test('(+) D7: a 500 and then a 200 is quiet: one retry after 2 s, no line', async () => {
      const r = await booted();
      r.keepAnswer = seq([{ status: 500, body: null }, { status: 200, body: { kept: true } }]);
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      await r.advance(1999);
      assert.equal(r.log.keeps.length, 1);
      await r.advance(1);
      assert.equal(r.log.keeps.length, 2);
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 2);
      assert.deepEqual(r.log.problems, []);
    });

    test('(−) D7: two 500s say KEEP_FAILED once; the third failure stops the tries until an edit', async () => {
      const r = await booted();
      r.keepAnswer = () => ({ status: 500, body: null });
      r.type(LONG);
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 3, 'three tries, 2 s apart');
      assert.deepEqual(r.log.problems, [KEEP_FAILED]);
      assert.deepEqual(r.log.problemMs, [8000]);
      r.type(`${LONG}y`);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 4, 'an edit gives fresh tries');
      assert.deepEqual(r.log.problems, [KEEP_FAILED], 'still one line for the run');
    });

    test('(−) D7: an io.keep that rejects counts as a failure and leaves no unhandled rejection', async () => {
      const r = await booted();
      r.keepAnswer = () => Promise.reject(new Error('boom'));
      r.type(LONG);
      await r.advance(5000);
      assert.deepEqual(r.log.problems, [KEEP_FAILED]);
    });

    test('(−) D7: a 409 says KEEP_NO_PROJECT once and no more keeps are tried', async () => {
      const r = await booted();
      r.keepAnswer = () => ({ status: 409, body: { error: 'no-project', message: 'x' } });
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.problems, [KEEP_NO_PROJECT]);
      assert.deepEqual(r.log.problemMs, [8000]);
      r.type(`${LONG}y`);
      await r.advance(10000);
      assert.equal(r.log.keeps.length, 1);
      assert.deepEqual(r.log.problems, [KEEP_NO_PROJECT]);
    });

    test('(−) D7: a 404 stops the keeps in silence (the sync\'s own 404 flow speaks)', async () => {
      const r = await booted();
      r.keepAnswer = () => ({ status: 404, body: { error: 'not_found', message: 'x' } });
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.type(`${LONG}y`);
      await r.advance(10000);
      assert.equal(r.log.keeps.length, 1);
      assert.deepEqual(r.log.problems, []);
      assert.equal(r.log.gone, 0, 'the keep route does not end the page');
    });

    test('(−) D7: a 429 is retried after 1 s, with no line and no failure count', async () => {
      const r = await booted();
      r.keepAnswer = seq([{ status: 429, body: { error: 'busy', message: 'x' } }, { status: 200, body: { kept: true } }]);
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      await r.advance(999);
      assert.equal(r.log.keeps.length, 1);
      await r.advance(1);
      assert.equal(r.log.keeps.length, 2);
      assert.deepEqual(r.log.problems, []);
    });

    test('(+) D15b: reset() (the connection came back) lets a page that was switched off by a 404 keep again', async () => {
      const r = await booted();
      r.keepAnswer = () => ({ status: 404, body: null });
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.type(`${LONG}a`);
      await r.advance(5000);
      assert.equal(r.log.keeps.length, 1, 'off');
      r.keepAnswer = () => ({ status: 200, body: { kept: true } });
      r.ds.reset();
      r.ds.capture(empty(), 120);
      r.type(`${LONG}b`);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 2);
      assert.deepEqual(r.log.keeps.at(-1), { text: `${LONG}b`, shell: false });
    });

    test('(−) D15: after stop() no keep request goes out, not for a pending text, not for an edit, not for a flush', async () => {
      const r = await booted();
      r.type(LONG);
      r.ds.stop();
      await r.advance(10000);
      assert.deepEqual(r.log.keeps, []);
      r.type(`${LONG}y`);
      r.ds.flushKeep();
      await r.advance(10000);
      assert.deepEqual(r.log.keeps, []);
    });

    test('(−) D15: a keep that is answered after stop() starts no further one', async () => {
      const r = await booted();
      let release;
      r.keepAnswer = () => new Promise((res) => { release = () => res({ status: 500, body: null }); });
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      r.ds.stop();
      release();
      await r.advance(20000);
      assert.equal(r.log.keeps.length, 1);
    });
  });

  describe('waiting text (Q1: the owner also wants short waiting text kept)', () => {
    test('(+) D16: no readable box (a prompt or a dialog is open): a short text is kept after KEEP_MS, and cleared once it is mirrored', async () => {
      const r = await booted();
      r.ds.capture(null, 120);
      r.type('short reply');
      await r.advance(KEEP_MS - 1);
      assert.deepEqual(r.log.keeps, []);
      await r.advance(1);
      assert.deepEqual(r.log.keeps, [{ text: 'short reply', shell: false }]);
      r.ds.capture(empty(), 120);
      await r.advance(PUSH_MS);
      assert.equal(r.log.puts.length, 1, 'the push goes when the box is back');
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
      assert.equal(r.log.keeps.length, 2);
    });

    test('(+) D16: Claude\'s input is paused (unreadable): a short text is kept', async () => {
      const r = await booted();
      r.ds.capture(unreadable('pasted'), 120);
      r.type('short reply');
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: 'short reply', shell: false }]);
    });

    test('(+) D16: a refused push (hold: a prompt is open; cursor: Claude works) keeps the short text KEEP_MS after the refusal', async () => {
      for (const code of ['not-idle', 'cursor-not-at-end']) {
        const r = await booted();
        r.answer = () => ({ status: 409, body: { error: code, message: 'x' } });
        r.type('short reply');
        await r.advance(PUSH_MS);
        assert.equal(r.log.puts.length, 1, code);
        assert.deepEqual(r.log.keeps, [], `${code}: not before the refusal has been read`);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: 'short reply', shell: false }], code);
      }
    });

    test('(+) D16: three failed pushes make a short text wait, so it is kept', async () => {
      const r = await booted();
      r.answer = () => ({ status: 500, body: null });
      r.type('short reply');
      await r.advance(6250);
      assert.equal(r.log.puts.length, 3);
      assert.deepEqual(r.log.keeps, [], 'two failures are still the sync\'s business');
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: 'short reply', shell: false }]);
    });

    test('(−) D16: a short text that is pushed normally, with a readable box, is kept never (D1 stays)', async () => {
      const r = await booted();
      r.type('short reply');
      await r.advance(PUSH_MS);
      assert.equal(r.log.puts.length, 1);
      await r.advance(10000);
      assert.deepEqual(r.log.keeps, []);
    });

    test('(+) D16: the \'long\' note\'s words no longer say Long: they say what a short waiting text needs too', () => {
      assert.deepEqual(noteView({ kind: 'long' }), { kind: 'long', icon: 'info', label: 'Not mirrored:', text: 'This text goes to Claude when you send it.' });
    });
  });

  describe('restoring', () => {
    test('(+) D8: restore at boot: while the GET is held the captures neither pull nor push; the kept text is put back with Shell as kept, one announcement, the note says long', async () => {
      const r = rig();
      r.fetchAnswer = () => new Promise((res) => { r.release = res; });
      const p = r.ds.restore();
      await r.flush();
      assert.equal(r.ds.restoring(), true);
      assert.equal(r.log.fetches, 1);
      r.ds.capture(text('claude text', { sig: sig(2) }), 120);
      await r.advance(5000);
      assert.deepEqual(r.log.sets, [], 'no pull while the restore runs');
      assert.deepEqual(r.log.puts, [], 'and no push');
      r.release(okKept({ text: LONG, shell: true }));
      await p;
      assert.equal(r.ds.restoring(), false);
      assert.deepEqual(r.log.sets, [[LONG, true]], 'the put-back and nothing else: Claude\'s text was not pulled over it');
      assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
      assert.equal(r.lastNote().kind, 'long');
      assert.deepEqual(r.log.problems, []);
      await r.advance(10000);
      assert.deepEqual(r.log.puts, [], 'long text goes on Send');
      assert.deepEqual(r.log.keeps, [], 'the server already holds exactly this');
    });

    test('(−) D8: { kept: null } leaves the box alone and the first capture pulls as today', async () => {
      const r = rig();
      await r.ds.restore();
      assert.deepEqual(r.log.sets, []);
      assert.deepEqual(r.log.announces, []);
      r.ds.capture(text('from claude', { sig: sig(2) }), 120);
      assert.deepEqual(r.log.sets, [['from claude', false]]);
      assert.deepEqual(r.log.keeps, [], 'and nothing is cleared');
    });

    test('(−) D8: { kept: null } never wipes a box that already has text, and the page keeps the box (D12)', async () => {
      const r = rig({ value: 'typed before' });
      await r.ds.restore();
      assert.equal(r.st.box.value, 'typed before');
      assert.deepEqual(r.log.sets, []);
    });

    test('(+) D8: the put-back text is set the way a pull sets it (setBox), and the page asks the GET once', async () => {
      const r = rig();
      r.fetchAnswer = () => okKept({ text: 'two\nlines', shell: false });
      await r.ds.restore();
      assert.deepEqual(r.log.sets, [['two\nlines', false]]);
      assert.equal(r.log.fetches, 1);
      await r.ds.restore();
      assert.equal(r.log.fetches, 2, 'a second restore (a back/forward return) asks again');
    });

    test('(+) D9: a put-back text that fits, over an empty Claude input, is pushed at PUSH_MS, and the server copy is cleared once Claude holds it', async () => {
      const r = rig();
      await restoreHeld(r, okKept({ text: 'short kept text', shell: false }), () => r.ds.capture(empty(), 120));
      assert.deepEqual(r.log.sets, [['short kept text', false]]);
      assert.deepEqual(r.log.puts, []);
      await r.advance(PUSH_MS - 1);
      assert.deepEqual(r.log.puts, []);
      await r.advance(1);
      assert.deepEqual(r.log.puts, [{ text: 'short kept text', base: sig(9) }]);
      assert.deepEqual(r.log.keeps, [], 'not yet');
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: '', shell: false }]);
    });

    test('(−) D9: a put-back text over Claude\'s other text (the stale start, or terminal text) is never pushed: no draft PUT in 20 s, the note says long; after one edit the normal push goes', async () => {
      const r = rig();
      await restoreHeld(r, okKept({ text: 'short kept text', shell: false }), () => r.ds.capture(text('stale start', { sig: sig(2) }), 120));
      assert.deepEqual(r.log.sets, [['short kept text', false]], 'not pulled over');
      await r.advance(20000);
      assert.deepEqual(r.log.puts, []);
      assert.equal(r.lastNote().kind, 'long');
      assert.deepEqual(r.log.keeps, [], 'the server still holds the copy');
      r.type('short kept text!');
      await r.advance(PUSH_MS);
      assert.deepEqual(r.log.puts, [{ text: 'short kept text!', base: sig(2) }]);
    });

    test('(−) D9: a put-back text over an unreadable or missing box waits as well', async () => {
      for (const screen of [() => unreadable('pasted'), () => null]) {
        const r = rig();
        await restoreHeld(r, okKept({ text: 'short kept text', shell: false }), () => r.ds.capture(screen(), 120));
        await r.advance(20000);
        assert.deepEqual(r.log.puts, []);
      }
    });

    test('(+) D10: the box edited while the restore ran: RESTORE_TEXT_SKIPPED, the kept text is not put back, and the new short box clears the server copy', async () => {
      const r = rig();
      await restoreHeld(r, okKept({ text: 'old kept text', shell: false }), () => { r.ds.capture(empty(), 120); r.type('typed meanwhile'); });
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
      assert.deepEqual(r.log.problemMs, [8000]);
      assert.deepEqual(r.log.sets, []);
      assert.equal(r.st.box.value, 'typed meanwhile');
      assert.deepEqual(r.log.announces, []);
      await r.advance(KEEP_MS);
      assert.equal(r.log.puts.length, 1, 'the typed text is pushed as usual');
      assert.deepEqual(r.log.keeps, [{ text: '', shell: false }], 'the old copy is replaced by the new state of the box: nothing to keep');
    });

    test('(+) D10: and a long text typed meanwhile is kept in place of the old copy', async () => {
      const r = rig();
      await restoreHeld(r, okKept({ text: 'old kept text', shell: false }), () => { r.ds.capture(empty(), 120); r.type(LONG); });
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }]);
    });

    test('(+) D11: a 500 and then a 200: one wait of 2 s, then the text is put back', async () => {
      const r = rig();
      r.fetchAnswer = seq([{ status: 500, body: null }, okKept({ text: 'kept after the retry', shell: false })]);
      const p = r.ds.restore();
      await r.flush();
      assert.equal(r.log.fetches, 1);
      assert.equal(r.ds.restoring(), true);
      await r.advance(1999);
      assert.equal(r.log.fetches, 1, 'still waiting');
      await r.advance(1);
      await p;
      assert.equal(r.log.fetches, 2);
      assert.deepEqual(r.log.sets, [['kept after the retry', false]]);
      assert.deepEqual(r.log.problems, []);
    });

    test('(−) D11: two failures say RESTORE_TEXT_FAILED once and then neither keep nor clear is written until the first edit', async () => {
      const r = rig();
      r.fetchAnswer = () => ({ status: 500, body: null });
      const p = r.ds.restore();
      await r.flush();
      await r.advance(2000);
      await p;
      assert.equal(r.log.fetches, 2);
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
      assert.deepEqual(r.log.problemMs, [8000]);
      assert.deepEqual(r.log.sets, []);
      r.ds.capture(empty(), 120);
      await r.advance(10000);
      r.ds.flushKeep();
      assert.deepEqual(r.log.keeps, [], 'the server copy stays for the next try');
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }], 'the first edit lets the page keep again');
    });

    test('(−) D11: a 404 says nothing and does not retry', async () => {
      const r = rig();
      r.fetchAnswer = () => ({ status: 404, body: { error: 'not_found', message: 'x' } });
      await r.ds.restore();
      await r.advance(10000);
      assert.equal(r.log.fetches, 1);
      assert.deepEqual(r.log.problems, []);
      assert.deepEqual(r.log.sets, []);
    });

    test('(−) D11: a status 0 (the 3 s abort), a 409, and an answer that is not shaped { kept } or whose kept fails cleanKept all count as failures', async () => {
      const answers = [
        { status: 0, body: null }, { status: 409, body: { error: 'no-project', message: 'x' } }, { status: 200, body: null }, { status: 200, body: [] }, { status: 200, body: {} },
        { status: 200, body: { kept: 'x' } }, { status: 200, body: { kept: [] } }, okKept({ text: '', shell: false }), okKept({ text: 'x', shell: 'no' }), okKept({ text: 'a\r', shell: false }),
        okKept({ text: 'a\u0007', shell: false }), okKept({ text: 'a\n', shell: false }), okKept({ text: 'a'.repeat(16385), shell: false }), okKept({ shell: false }),
      ];
      for (const answer of answers) {
        const r = rig();
        r.fetchAnswer = () => answer;
        const p = r.ds.restore();
        await r.flush();
        await r.advance(2000);
        await p;
        assert.equal(r.log.fetches, 2, JSON.stringify(answer)?.slice(0, 50));
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED], JSON.stringify(answer)?.slice(0, 50));
        assert.deepEqual(r.log.sets, [], 'nothing of a bad answer reaches the box');
      }
    });

    test('(+) D11: only { text, shell } of the answer reaches the box', async () => {
      const r = rig();
      r.fetchAnswer = () => ({ status: 200, body: { kept: { text: 'plain words', shell: true, extra: '<b>x</b>', path: '/srv/x' }, other: 1 } });
      await r.ds.restore();
      assert.deepEqual(r.log.sets, [['plain words', true]]);
    });

    test('(+) D12: a back/forward return: a server copy that differs from the box is put back, and nothing is written for it', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      const newer = 'newer text from the other page: ' + LONG; // long, so the sync does not push it (a text that fits goes into an empty input by itself: D9)
      r.fetchAnswer = () => okKept({ text: newer, shell: true });
      await r.ds.restore();
      assert.deepEqual(r.log.sets.at(-1), [newer, true]);
      assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
      await r.advance(5000);
      assert.equal(r.log.keeps.length, 1, 'the server already holds that copy');
    });

    test('(+) D12: a server copy that equals the box changes nothing and says nothing', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.fetchAnswer = () => okKept({ text: LONG, shell: false });
      const before = r.log.sets.length;
      await r.ds.restore();
      assert.equal(r.log.sets.length, before);
      assert.deepEqual(r.log.announces, []);
      await r.advance(5000);
      assert.equal(r.log.keeps.length, 1);
    });

    test('(−) D12: { kept: null } (the tray was dropped) does not clear the box; the next keep step keeps the box again', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      r.fetchAnswer = () => okKept(null);
      await r.ds.restore();
      assert.equal(r.st.box.value, LONG, 'the box is not cleared');
      assert.deepEqual(r.log.sets, []);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 2);
      assert.deepEqual(r.log.keeps.at(-1), { text: LONG, shell: false });
    });

    test('(−) D12: a restore while one runs, or after stop(), asks nothing', async () => {
      const r = rig();
      r.fetchAnswer = () => new Promise((res) => { r.release = res; });
      const p = r.ds.restore();
      await r.flush();
      const again = r.ds.restore();
      await r.flush();
      assert.equal(r.log.fetches, 1, 'one at a time');
      r.release(okKept(null));
      await p;
      await again;
      const s = rig();
      s.ds.stop();
      await s.ds.restore();
      assert.equal(s.log.fetches, 0);
    });

    test('(+) D13: flushKeep() with a pending change writes it at once and cancels the timer', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(100);
      r.ds.flushKeep();
      assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }]);
      await r.advance(10000);
      assert.equal(r.log.keeps.length, 1, 'the timer was cancelled');
    });

    test('(+) D13: flushKeep() also sends a pending clear (the box was emptied)', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.type('');
      r.ds.flushKeep();
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
      assert.equal(r.log.keeps.length, 2);
    });

    test('(−) D13: flushKeep() with nothing pending, with a server copy that is current, while restoring, after a 409, or after a failed restore asks nothing', async () => {
      const a = await booted();
      a.ds.flushKeep();
      assert.deepEqual(a.log.keeps, [], 'nothing pending');
      const b = await booted();
      b.type(LONG);
      await b.advance(KEEP_MS);
      b.ds.flushKeep();
      assert.equal(b.log.keeps.length, 1, 'the server already holds it');
      const c = rig();
      c.fetchAnswer = () => new Promise((res) => { c.release = res; });
      const p = c.ds.restore();
      await c.flush();
      c.type(LONG);
      c.ds.flushKeep();
      assert.deepEqual(c.log.keeps, [], 'while restoring');
      c.release(okKept(null));
      await p;
      const d = await booted();
      d.keepAnswer = () => ({ status: 409, body: { error: 'no-project', message: 'x' } });
      d.type(LONG);
      await d.advance(KEEP_MS);
      d.type(`${LONG}y`);
      d.ds.flushKeep();
      assert.equal(d.log.keeps.length, 1, 'after a 409');
      const e = rig();
      e.fetchAnswer = () => ({ status: 500, body: null });
      const q = e.ds.restore();
      await e.flush();
      await e.advance(2000);
      await q;
      e.ds.flushKeep();
      assert.deepEqual(e.log.keeps, [], 'after a failed restore');
    });

    test('(+) D14: accept() while restoring answers RESTORING_TEXT and sends no suggest request; after the restore it works', async () => {
      const r = rig();
      r.fetchAnswer = () => new Promise((res) => { r.release = res; });
      r.suggestAnswer = () => ({ status: 200, body: { draft: text('try it', { sig: sig(5) }) } });
      const p = r.ds.restore();
      await r.flush();
      r.ds.capture(empty({ suggestion: 'try it', sig: sig(4) }), 120);
      const during = await r.ds.accept('try it');
      assert.deepEqual(during, { ok: false, status: null, message: RESTORING_TEXT });
      assert.deepEqual(r.log.suggests, []);
      r.release(okKept(null));
      await p;
      const after = await r.ds.accept('try it');
      assert.equal(after.ok, true);
      assert.equal(r.log.suggests.length, 1);
    });
  });

  // ---- LT fix round 1 (review-LT): MF-1, SF-2, SF-3, SF-1, N2 ---------------------------------------------------------------
  describe('LT fix round 1 (review-LT)', () => {
    const gone404 = () => ({ status: 404, body: { error: 'not_found', message: 'x' } });
    const E500 = () => ({ status: 500, body: null });

    /** The keep PUTs are held until release(): the write is in flight. */
    function holdKeeps(r) {
      const h = { pending: [], release(n = 1) { for (let i = 0; i < n; i += 1) h.pending.shift()?.({ status: 200, body: { kept: true } }); } };
      r.keepAnswer = () => new Promise((res) => { h.pending.push(res); });
      return h;
    }

    // MF-1: a restore that did not end on a known answer never clears what the server holds
    test('(−) MF-1 (P4b): a restore that ends on 404 never clears the copy the server holds: the first capture, 10 s and a flush send nothing', async () => {
      const r = rig();
      r.fetchAnswer = gone404;
      await r.ds.restore();
      r.ds.capture(empty(), 120);
      await r.advance(10000);
      r.ds.flushKeep();
      assert.deepEqual(r.log.keeps, []);
      assert.deepEqual(r.log.problems, [], '404 says nothing here: the capture flow speaks');
      assert.equal(r.log.fetches, 1, 'and does not retry on its own');
    });

    test('(+) MF-1 (P4): 404, then stop() and reset() (tmux answers again): the restore asks again, the text comes back, and no clear or keep went out meanwhile', async () => {
      const r = rig();
      r.fetchAnswer = gone404;
      await r.ds.restore();
      r.ds.capture(empty(), 120);
      await r.advance(3000);
      r.ds.stop();
      r.fetchAnswer = () => okKept({ text: LONG, shell: false });
      r.ds.reset();
      await r.flush();
      assert.equal(r.log.fetches, 2);
      assert.deepEqual(r.log.sets, [[LONG, false]]);
      assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
      r.ds.capture(empty(), 120);
      await r.advance(10000);
      assert.deepEqual(r.log.keeps, [], 'the server already holds that text');
      r.ds.reset();
      await r.flush();
      assert.equal(r.log.fetches, 2, 'answered now: the next reset does not ask again');
    });

    test('(−) MF-1: reset() asks the GET again only when the last restore ended on 404 or a throw: a restore that was answered, or that failed twice (its line says to reopen), is not repeated', async () => {
      const a = rig();
      await a.ds.restore();
      a.ds.reset();
      await a.flush();
      assert.equal(a.log.fetches, 1, 'answered { kept: null }');
      const b = rig();
      b.fetchAnswer = () => okKept({ text: 'kept words', shell: false });
      await b.ds.restore();
      b.ds.reset();
      await b.flush();
      assert.equal(b.log.fetches, 1, 'answered with a text');
      const c = rig();
      c.fetchAnswer = E500;
      const p = c.ds.restore();
      await c.flush();
      await c.advance(2000);
      await p;
      c.ds.reset();
      await c.flush();
      assert.equal(c.log.fetches, 2, 'failed twice: the two tries only');
    });

    test('(−) MF-1: a reset after a 404 that is still 404 asks once more and keeps the hold: nothing is cleared, and the next reset asks again', async () => {
      const r = rig();
      r.fetchAnswer = gone404;
      await r.ds.restore();
      r.ds.reset();
      await r.flush();
      assert.equal(r.log.fetches, 2);
      r.ds.capture(empty(), 120);
      await r.advance(10000);
      assert.deepEqual(r.log.keeps, []);
      r.ds.reset();
      await r.flush();
      assert.equal(r.log.fetches, 3, 'still unknown, so asked again');
    });

    test('(−) MF-1 (P5, N3): a setBox that throws in the put-back: restore() does not reject, nothing is cleared, the failure line shows, and a reset brings the text back', async () => {
      const r = rig();
      r.fetchAnswer = () => okKept({ text: LONG, shell: false });
      r.setBoxError = new Error('boom');
      await r.ds.restore();
      assert.equal(r.ds.restoring(), false);
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
      assert.deepEqual(r.log.problemMs, [8000]);
      r.ds.capture(empty(), 120);
      await r.advance(10000);
      r.ds.flushKeep();
      assert.deepEqual(r.log.keeps, [], 'no clear and no keep');
      assert.equal(r.st.box.value, '');
      r.ds.reset();
      await r.flush();
      assert.deepEqual(r.log.sets, [[LONG, false]]);
    });

    test('(−) MF-1 (N3): a box() that throws, and an announce() that throws, are caught the same way: restore() resolves and leaves the hold', async () => {
      for (const which of ['box', 'announce']) {
        const st = { t: 1, timers: [] };
        const log = { keeps: [], problems: [] };
        const io = {
          now: () => st.t, after: (fn, ms) => { const h = { at: st.t + ms, fn }; st.timers.push(h); return h; }, cancel: () => {},
          box: () => { if (which === 'box') throw new Error('boom'); return { value: '', shell: false }; },
          setBox() {}, put: async () => ({ status: 200, body: {} }), suggest: async () => ({ status: 200, body: {} }), note() {},
          problem: (m) => log.problems.push(m), gone() {}, keep: async (b) => { log.keeps.push(b); return { status: 200, body: { kept: true } }; },
          fetchKept: async () => ({ status: 200, body: { kept: { text: 'kept words', shell: false } } }),
          announce: () => { if (which === 'announce') throw new Error('boom'); },
        };
        const ds = createDraftSync(io);
        await ds.restore();
        assert.equal(ds.restoring(), false, which);
        assert.deepEqual(log.problems, [RESTORE_TEXT_FAILED], which);
        ds.flushKeep();
        assert.deepEqual(log.keeps, [], which);
      }
    });

    test('(+) MF-1 (round 2, SF-4): after a restore that ended on 404 the first edit does not release the hold: the re-try answers first (RESTORE_TEXT_SKIPPED), then the box is kept', async () => {
      const r = rig();
      r.fetchAnswer = gone404;
      await r.ds.restore();
      r.ds.capture(empty(), 120);
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [], 'the server copy was never seen: the hold lasts until the re-try answers');
      r.fetchAnswer = () => okKept({ text: `older copy: ${LONG}`, shell: false });
      await r.advance(2000);
      r.ds.capture(empty(), 120);
      await r.flush();
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }]);
    });

    test('(+) MF-1: a restore that is answered after a failed one lifts the hold: a Send then clears the server copy (404 then reset; two failures then a back/forward restore)', async () => {
      const r = rig();
      r.fetchAnswer = gone404;
      await r.ds.restore();
      r.fetchAnswer = () => okKept({ text: LONG, shell: false });
      r.ds.reset();
      await r.flush();
      r.ds.capture(empty(), 120);
      r.st.box = { value: '', shell: false };
      r.ds.sent();
      await r.flush();
      assert.deepEqual(r.log.keeps, [{ text: '', shell: false }], 'the sent text does not come back');
      const q = rig();
      q.fetchAnswer = E500;
      const p = q.ds.restore();
      await q.flush();
      await q.advance(2000);
      await p;
      q.fetchAnswer = () => okKept({ text: LONG, shell: false });
      await q.ds.restore();
      q.ds.capture(empty(), 120);
      q.st.box = { value: '', shell: false };
      q.ds.sent();
      await q.flush();
      assert.deepEqual(q.log.keeps, [{ text: '', shell: false }]);
    });

    // SF-2: flushKeep must not trust the copy mark while a write is on its way
    test('(+) SF-2 (P3): kept A, A2 in flight, back to A, the page is left: A is written', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1);
      const h = holdKeeps(r);
      const A2 = `${LONG}2`;
      r.type(A2);
      await r.advance(KEEP_MS);
      assert.deepEqual(r.log.keeps.at(-1), { text: A2, shell: false }, 'A2 is in flight');
      r.type(LONG);
      r.ds.flushKeep();
      assert.deepEqual(r.log.keeps.at(-1), { text: LONG, shell: false }, 'the leave writes A, not nothing');
      assert.equal(r.log.keeps.length, 3);
      h.release(2);
      await r.flush();
    });

    test('(+) SF-2 (P3b): nothing kept, X in flight, Send succeeds, the page is left at once: the clear is sent', async () => {
      const r = await booted();
      const h = holdKeeps(r);
      r.type(LONG);
      await r.advance(KEEP_MS);
      assert.equal(r.log.keeps.length, 1, 'X is in flight');
      r.st.box = { value: '', shell: false };
      r.ds.sent();
      r.ds.flushKeep();
      assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
      assert.equal(r.log.keeps.length, 2);
      h.release(2);
      await r.flush();
    });

    test('(−) SF-2: with no write in flight a flush of what the server holds still sends nothing (D13 stays)', async () => {
      const r = await booted();
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.ds.flushKeep();
      assert.equal(r.log.keeps.length, 1);
      const e = await booted();
      e.ds.flushKeep();
      assert.deepEqual(e.log.keeps, []);
    });

    // SF-3: the copy mark of the skipped branch (survivor 8 of the first report)
    test('(+) SF-3 (P1): a back/forward return, a short text typed during the GET, and another page\'s copy on the server: the copy is cleared', async () => {
      const r = await booted(); // the server held nothing: D.kept is ''
      r.fetchAnswer = () => new Promise((res) => { r.release = res; });
      const p = r.ds.restore();
      await r.flush();
      r.type('typed short');
      r.release(okKept({ text: 'the other page\'s copy', shell: false }));
      await p;
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
      assert.equal(r.st.box.value, 'typed short', 'the box wins');
      await r.advance(KEEP_MS + PUSH_MS);
      assert.deepEqual(r.log.keeps, [{ text: '', shell: false }], 'the other copy would otherwise come back on the next open');
    });

    // N2: the edit snapshot is taken before the wait for a write on its way
    test('(+) N2: an edit made while restore() waits for a draft write on its way is seen: the box is not replaced', async () => {
      const r = await booted();
      const h = holdPuts(r);
      r.type('first words');
      await r.advance(PUSH_MS);
      assert.equal(r.log.puts.length, 1, 'the push is in flight');
      r.fetchAnswer = () => okKept({ text: 'an older kept copy', shell: false });
      const p = r.ds.restore();
      await r.flush();
      r.type('first words and more');
      h.release();
      await p;
      assert.equal(r.st.box.value, 'first words and more');
      assert.deepEqual(r.log.sets.filter(([v]) => v === 'an older kept copy'), []);
      assert.deepEqual(r.log.problems.at(-1), RESTORE_TEXT_SKIPPED);
    });

    test('(−) N2: with no edit during that wait the same restore puts the kept copy back', async () => {
      const r = await booted();
      const h = holdPuts(r);
      r.type(LONG);
      await r.advance(KEEP_MS);
      r.fetchAnswer = () => okKept({ text: `newer ${LONG}`, shell: false });
      const p = r.ds.restore();
      await r.flush();
      h.release?.();
      await p;
      assert.deepEqual(r.log.sets.at(-1), [`newer ${LONG}`, false]);
    });

    // SF-1: the over-size state has its own note
    test('(+) SF-1: over 16 KB shows its own note (kind over, warn icon, "Not kept:", the words) and raises no problem line; 16 384 bytes does not', async () => {
      const r = await booted();
      r.type('x'.repeat(16385));
      assert.deepEqual(r.lastNote(), OVER_NOTE);
      assert.deepEqual(r.log.problems, []);
      const a = await booted();
      a.type('x'.repeat(16384));
      assert.equal(a.lastNote().kind, 'long');
      const b = await booted();
      b.type(`${'x'.repeat(16384)}\n\n\r\n`);
      assert.equal(b.lastNote().kind, 'long', 'trailing newlines are not kept, so they do not count');
      const c = await booted();
      c.type(`${'x'.repeat(16380)}\n\n\u20ac`);
      assert.equal(c.lastNote().kind, 'over', 'a 3-byte character counts as 3');
    });

    test('(+) SF-1: the note stays while the state holds: more captures, 20 s, a problem line from elsewhere and a failed restore do not remove it', async () => {
      const r = await booted();
      r.type('x'.repeat(16385));
      r.ds.capture(empty({ sig: sig(30) }), 120);
      await r.advance(20000);
      assert.deepEqual(r.log.notes, [OVER_NOTE], 'shown once and never hidden');
      r.fetchAnswer = E500;
      const p = r.ds.restore();
      await r.flush();
      await r.advance(2000);
      await p;
      assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
      assert.deepEqual(r.log.notes, [OVER_NOTE], 'the problem slot is not the note slot');
    });

    test('(−) SF-1: the note follows the text: shortened to 16 384 bytes it is the long note, to a short text none, and a sent or emptied box has none', async () => {
      const r = await booted();
      r.type('x'.repeat(16385));
      r.type('x'.repeat(16384));
      assert.equal(r.lastNote().kind, 'long');
      r.type('x'.repeat(16385));
      r.type('short');
      assert.equal(r.lastNote(), null);
      r.type('x'.repeat(16385));
      r.type('');
      assert.equal(r.lastNote(), null);
      r.type('x'.repeat(16385));
      r.st.box = { value: '', shell: false };
      r.ds.sent();
      r.ds.capture(empty(), 120);
      assert.equal(r.lastNote(), null);
    });

    test('(+) SF-1 (round 2, SF-5): the over note shows in every state of the screen: a readable input, no box on screen (a dialog), and an unreadable input (it wins over paused)', async () => {
      const r = await booted();
      r.type('x'.repeat(16385));
      assert.equal(r.lastNote().kind, 'over');
      r.ds.capture(null, 120);
      assert.equal(r.lastNote().kind, 'over');
      r.ds.capture(empty(), 120);
      assert.equal(r.lastNote().kind, 'over');
      r.ds.capture(unreadable('tall'), 120);
      assert.equal(r.lastNote().kind, 'over');
    });

    test('(−) after sent() no long or over note stays for the emptied box, even while the put-back hold still reads true over Claude\'s text', async () => {
      const r = rig();
      await restoreHeld(r, okKept({ text: LONG, shell: false }), () => r.ds.capture(text('claude has this', { sig: sig(40) }), 120));
      assert.equal(r.lastNote().kind, 'long', 'the put-back text waits over Claude\'s other text');
      r.st.box = { value: '', shell: false };
      r.ds.sent();
      r.ds.capture(text('claude has this', { sig: sig(41) }), 120);
      assert.equal(r.lastNote(), null, 'nothing unsent is left, so no note about unsent text');
    });

    test('(+) SF-1: noteView({ kind: over }) is exactly the approved words; all seven kinds differ in kind, icon and label', () => {
      assert.deepEqual(noteView({ kind: 'over' }), OVER_NOTE);
      const all = [{ kind: 'paused', reason: 'tall' }, { kind: 'long' }, { kind: 'hold' }, { kind: 'cursor' }, { kind: 'queued' }, { kind: 'suggest' }, { kind: 'over' }].map(noteView);
      for (const key of ['kind', 'icon', 'label']) assert.equal(new Set(all.map((v) => v[key])).size, 7, key);
      assert.match(OVER_NOTE.text, /^[\x20-\x7e]+$/);
    });

    // MF-2 (owner answer A): on a back/forward return the page keeps its box unless the server's copy came from another page and the box still holds what this page saved
    describe('MF-2: the put-back rule on a back/forward return', () => {
      const X = `${LONG} edited after the last save`;
      const OK200 = () => ({ status: 200, body: { kept: true } });

      /** A page that has saved LONG (confirmed) and then has `typed` in the box, not yet written. */
      async function savedThenTyped(typed) {
        const r = await booted();
        r.type(LONG);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }]);
        if (typed !== undefined) r.type(typed);
        return r;
      }

      test('(−) MF-2 (P2): saved A, typed X, the leave-time write fails, the server still holds A: the box keeps X, nothing is put back, and X is saved', async () => {
        const r = await savedThenTyped(X);
        r.keepAnswer = E500;
        r.ds.flushKeep();
        assert.deepEqual(r.log.keeps.at(-1), { text: X, shell: false });
        r.keepAnswer = OK200;
        r.fetchAnswer = () => okKept({ text: LONG, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, [], 'the old copy of its own text is not put back');
        assert.deepEqual(r.log.announces, []);
        assert.deepEqual(r.log.problems, [], 'nothing was skipped: the user typed nothing during the restore');
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps.at(-1), { text: X, shell: false }, 'and the next keep step saves X');
        assert.equal(r.log.keeps.length, 3);
      });

      test('(−) MF-2: the same, but the leave-time write landed (the server holds X): the box keeps X, nothing is put back and nothing more is written', async () => {
        const r = await savedThenTyped(X);
        r.ds.flushKeep();
        assert.equal(r.log.keeps.length, 2);
        r.fetchAnswer = () => okKept({ text: X, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        assert.deepEqual(r.log.announces, []);
        await r.advance(20000);
        assert.equal(r.log.keeps.length, 2, 'the server holds X already');
      });

      test('(+) MF-2 (D12, two pages): the box holds the copy this page saved, another page wrote B: the box shows B, and nothing is written for it', async () => {
        const r = await savedThenTyped();
        const B = `${LONG} written by the other page`;
        r.fetchAnswer = () => okKept({ text: B, shell: true });
        await r.ds.restore();
        assert.deepEqual(r.log.sets, [[B, true]]);
        assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
        await r.advance(20000);
        assert.equal(r.log.keeps.length, 1, 'the server already holds B');
      });

      test('(−) MF-2: another page wrote B, but the box holds X that this page never saved: the box keeps X, nothing is put back, and X is saved over B', async () => {
        const r = await savedThenTyped(X);
        r.fetchAnswer = () => okKept({ text: `${LONG} written by the other page`, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        assert.deepEqual(r.log.announces, []);
        assert.deepEqual(r.log.problems, [], 'the "you started typing" line is for an edit during the GET: this was not one');
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps.at(-1), { text: X, shell: false });
        assert.equal(r.log.keeps.length, 2);
      });

      test('(+) MF-2 (round 2, MF-2b): a copy written at the leave counts as saved once its write answered 200: saved A, typed X, left (the write answered 200), another page then wrote B: the box shows B', async () => {
        const r = await savedThenTyped(X);
        r.ds.flushKeep();
        await r.flush(); // the leave-time write answers 200
        const B = `${LONG} written by the other page`;
        r.fetchAnswer = () => okKept({ text: B, shell: false });
        await r.ds.restore();
        assert.deepEqual(r.log.sets, [[B, false]]);
        assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
      });

      test('(+) MF-2: text put back at boot counts as saved: a later return with another page\'s copy on the server shows that copy; once the user edits it, the edit is kept instead', async () => {
        const a = rig();
        a.fetchAnswer = () => okKept({ text: LONG, shell: false });
        await a.ds.restore();
        a.ds.capture(empty(), 120);
        assert.deepEqual(a.log.sets, [[LONG, false]]);
        const B = `${LONG} written by the other page`;
        a.fetchAnswer = () => okKept({ text: B, shell: false });
        await a.ds.restore();
        assert.deepEqual(a.log.sets, [[LONG, false], [B, false]], 'put back at boot, and nobody edited it since');
        const b = rig();
        b.fetchAnswer = () => okKept({ text: LONG, shell: false });
        await b.ds.restore();
        b.ds.capture(empty(), 120);
        b.type(X);
        b.fetchAnswer = () => okKept({ text: B, shell: false });
        await b.ds.restore();
        assert.equal(b.st.box.value, X);
        assert.deepEqual(b.log.sets, [[LONG, false]], 'only the boot put-back: the edited text stays');
      });

      test('(−) MF-2: a write that was in flight at the leave is the page\'s own copy too: it landed (the server holds X), the leave wrote Y, the box holds Y: Y stays and is saved', async () => {
        const r = await savedThenTyped();
        const h = holdKeeps(r);
        const Y = `${LONG} typed after that write started`;
        r.type(X);
        await r.advance(KEEP_MS);
        assert.equal(h.pending.length, 1, 'the write of X is on its way');
        r.type(Y);
        r.ds.flushKeep();
        assert.deepEqual(r.log.keeps.at(-1), { text: Y, shell: false });
        h.pending.shift()({ status: 500, body: null }); // the answer to the first write is lost, but the write had landed
        await r.flush();
        h.pending.shift()(OK200()); // round 2: the leave-time write of Y answers 200, so Y is the copy this page saved and the box holds it: only the own-key check keeps Y over X
        await r.flush();
        r.keepAnswer = OK200;
        r.fetchAnswer = () => okKept({ text: X, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, Y);
        assert.deepEqual(r.log.sets, []);
        await r.advance(20000);
        assert.deepEqual(r.log.keeps.at(-1), { text: Y, shell: false });
      });

      test('(−) MF-2: the user emptied the box and the clear did not land (the server still holds A): the box stays empty and the clear is sent again; A is not put back', async () => {
        const r = await savedThenTyped('');
        r.keepAnswer = E500;
        r.ds.flushKeep();
        assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
        r.keepAnswer = OK200;
        r.fetchAnswer = () => okKept({ text: LONG, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, '');
        assert.deepEqual(r.log.sets, []);
        assert.deepEqual(r.log.announces, []);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps.at(-1), { text: '', shell: false });
        assert.equal(r.log.keeps.length, 3);
      });

      test('(−) MF-2: the page remembers a copy it saved earlier through failed writes of newer text (even repeated ones): the leave-time write of X answers 200, the server then shows A (an older write of this page landed last): the box keeps X', async () => {
        const r = await savedThenTyped();
        r.keepAnswer = E500;
        for (let i = 0; i < 3; i += 1) {
          r.type(X);
          await r.advance(20000);
        }
        assert.ok(r.log.keeps.filter((k) => k.text === X).length >= 7, 'the same text was tried again and again, and every try failed');
        r.keepAnswer = OK200; // round 2: the leave-time write answers 200 (X is saved, the box holds it), so only the own-key list keeps X over the older copy A
        r.ds.flushKeep();
        await r.flush();
        r.fetchAnswer = () => okKept({ text: LONG, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps.at(-1), { text: X, shell: false });
      });

      test('(+) MF-2: a server copy that equals the box settles the mark: the box then counts as saved, so a later copy of another page is put back', async () => {
        const r = await booted();
        r.type(X);
        r.fetchAnswer = () => okKept({ text: X, shell: false });
        await r.ds.restore();
        assert.deepEqual(r.log.sets, [], 'equal: nothing changes');
        const B = `${LONG} written by the other page`;
        r.fetchAnswer = () => okKept({ text: B, shell: false });
        await r.ds.restore();
        assert.deepEqual(r.log.sets, [[B, false]]);
      });

      test('(−) MF-2: a write that failed is not a save: saved A, typed X, the write of X failed, another page wrote B: the box keeps X and saves it', async () => {
        const r = await savedThenTyped(X);
        r.keepAnswer = E500;
        await r.advance(KEEP_MS);
        assert.equal(r.log.keeps.length, 2, 'the write of X went out and failed');
        r.keepAnswer = OK200;
        r.fetchAnswer = () => okKept({ text: `${LONG} written by the other page`, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        await r.advance(20000);
        assert.deepEqual(r.log.keeps.at(-1), { text: X, shell: false });
      });

      test('(+) MF-2: after the box is kept over another page\'s copy B the page knows the server holds B: typing exactly B writes nothing', async () => {
        const r = await savedThenTyped(X);
        const B = `${LONG} written by the other page`;
        r.fetchAnswer = () => okKept({ text: B, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        r.type(B);
        await r.advance(20000);
        assert.equal(r.log.keeps.length, 1, 'only the first save of A: the server holds B already');
      });

      test('(−) MF-2: text typed while a restore ran is not a saved copy, even when it later equals the other page\'s copy: a second return keeps the box', async () => {
        const r = await savedThenTyped();
        const B = `${LONG} written by the other page`;
        await restoreHeld(r, okKept({ text: B, shell: false }), () => r.type(X));
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
        r.type(B);
        r.fetchAnswer = () => okKept({ text: `${LONG} written by a third page`, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, B);
        assert.deepEqual(r.log.sets, []);
      });

      test('(−) MF-2: the same when the box was kept over another page\'s copy: that copy is not a save of this page, so typing exactly it and returning again keeps the box', async () => {
        const r = await savedThenTyped(X);
        const B = `${LONG} written by the other page`;
        r.fetchAnswer = () => okKept({ text: B, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        r.type(B);
        r.fetchAnswer = () => okKept({ text: `${LONG} written by a third page`, shell: false });
        await r.ds.restore();
        assert.equal(r.st.box.value, B);
        assert.deepEqual(r.log.sets, []);
      });

      test('(+) MF-2: a tray the server dropped ({ kept: null }) does not make the page forget what it saved: another page then wrote B, and B is put back', async () => {
        const r = await savedThenTyped();
        r.fetchAnswer = () => okKept(null);
        await r.ds.restore();
        assert.deepEqual(r.log.sets, []);
        const B = `${LONG} written by the other page`;
        r.fetchAnswer = () => okKept({ text: B, shell: false });
        await r.ds.restore();
        assert.deepEqual(r.log.sets, [[B, false]]);
      });

      test('(+) MF-2: at boot (an empty box, nothing saved by this page) the server\'s copy is put back, as before', async () => {
        const r = rig();
        r.fetchAnswer = () => okKept({ text: LONG, shell: true });
        await r.ds.restore();
        assert.deepEqual(r.log.sets, [[LONG, true]]);
        assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
      });
    });

    // ---- round 2 (review-LT re-check 1): MF-1b, MF-2b, SF-4, SF-5 -------------------------------------------------------------
    describe('LT fix round 2 (review-LT re-check 1)', () => {
      const copyOf = (t, shell = false) => () => okKept({ text: t, shell });
      const A = LONG; // the copy the server holds
      const X = `${LONG} typed here`;
      const B = `${LONG} written by the other page`;
      const OK200 = () => ({ status: 200, body: { kept: true } });

      /** A page that has saved A (confirmed); `typed` is then in the box, not yet written. */
      async function savedAThen(typed) {
        const r = await booted();
        r.type(A);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: A, shell: false }]);
        if (typed !== undefined) r.type(typed);
        return r;
      }

      /** restore() with the GET held; the page is stopped (the capture's 404, setGone) before the answer. Returns after the restore ended. */
      async function stoppedRestore(answer) {
        const r = rig();
        r.fetchAnswer = () => new Promise((res) => { r.release = res; });
        const p = r.ds.restore();
        await r.flush();
        r.ds.stop();
        r.release(answer);
        await p;
        return r;
      }

      // MF-1b: a restore that ends while the page is stopped never used its answer
      test('(−) MF-1b (P4c): the capture\'s 404 stops the page before the GET answers 404; Check again (reset) and a good capture: no clear is sent, the GET is asked again, and the text comes back', async () => {
        const r = await stoppedRestore(gone404());
        r.fetchAnswer = copyOf(A);
        r.ds.reset();
        await r.flush();
        r.ds.capture(empty(), 120);
        await r.advance(KEEP_MS + 10);
        assert.deepEqual(r.log.keeps, [], 'no blind clear of a copy that was never brought back');
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.sets, [[A, false]]);
      });

      test('(−) MF-1b (P4d): the same with the GET answering 200 after the stop (the copy was not used): no clear, a second GET, the text comes back', async () => {
        const r = await stoppedRestore(okKept({ text: A, shell: false }));
        assert.deepEqual(r.log.sets, [], 'a stopped page puts nothing back');
        r.fetchAnswer = copyOf(A);
        r.ds.reset();
        await r.flush();
        r.ds.capture(empty(), 120);
        await r.advance(KEEP_MS + 10);
        assert.deepEqual(r.log.keeps, []);
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.sets, [[A, false]]);
      });

      // MF-2b: a leave-time write counts as saved only on its own 200
      test('(−) MF-2b (P2c): saved A, typed X, the leave-time write of X fails, another page wrote B, a back/forward return: the box keeps X and saves it', async () => {
        const r = await savedAThen(X);
        r.keepAnswer = E500;
        r.ds.flushKeep();
        await r.flush();
        assert.deepEqual(r.log.keeps.at(-1), { text: X, shell: false });
        r.keepAnswer = OK200;
        r.fetchAnswer = copyOf(B);
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        assert.deepEqual(r.log.announces, []);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps.at(-1), { text: X, shell: false });
        assert.equal(r.log.keeps.length, 3);
      });

      test('(−) MF-2b (P2c-late): the same, but the leave-time write has not answered when the GET answers (and then fails): the box keeps X', async () => {
        const r = await savedAThen(X);
        const h = holdKeeps(r);
        r.ds.flushKeep();
        await r.flush();
        assert.equal(h.pending.length, 1, 'the leave-time write is on its way');
        r.keepAnswer = OK200;
        r.fetchAnswer = copyOf(B);
        await r.ds.restore();
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        h.pending.shift()({ status: 0, body: null });
        await r.flush();
        assert.equal(r.st.box.value, X);
      });

      test('(−) MF-2b: a leave-time write that answers 200 after the page saved something newer does not move the saved mark back', async () => {
        const r = await savedAThen(X);
        const h = holdKeeps(r);
        r.ds.flushKeep(); // X goes, unanswered
        await r.flush();
        r.keepAnswer = OK200;
        const Y = `${LONG} typed after the leave`;
        r.type(Y);
        await r.advance(KEEP_MS); // Y is saved (200): the mark is Y
        assert.deepEqual(r.log.keeps.at(-1), { text: Y, shell: false });
        h.pending.shift()(OK200()); // the leave-time write of X answers late
        await r.flush();
        r.fetchAnswer = copyOf(B);
        await r.ds.restore();
        assert.deepEqual(r.log.sets, [[B, false]], 'the box holds Y, which was saved: the other page\'s copy is put back');
      });

      test('(+) MF-2b: a leave-time write that throws synchronously, or answers with a non-object, breaks nothing and counts as not saved', async () => {
        const r = await savedAThen(X);
        r.keepAnswer = () => { throw new Error('boom'); };
        assert.doesNotThrow(() => r.ds.flushKeep());
        await r.flush();
        r.keepAnswer = () => null;
        r.type(`${X}!`);
        assert.doesNotThrow(() => r.ds.flushKeep());
        await r.flush();
        r.keepAnswer = OK200;
        r.fetchAnswer = copyOf(B);
        await r.ds.restore();
        assert.equal(r.st.box.value, `${X}!`);
        assert.deepEqual(r.log.sets, []);
      });

      // SF-4: a restore that never saw the server's copy is asked again from captures (bounded)
      test('(−) SF-4 (R404-iso short): the GET says 404 and the captures answer; a short text typed meanwhile: no write before the re-try; the re-try says RESTORE_TEXT_SKIPPED; the short text then clears the old copy, as at boot', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        r.fetchAnswer = copyOf(A);
        r.ds.capture(empty(), 120);
        await r.advance(300);
        r.type('ab');
        r.ds.capture(text('ab', { sig: sig(2) }), 120);
        await r.advance(1000);
        assert.deepEqual(r.log.keeps, [], 'the server copy was never seen: nothing is cleared yet');
        assert.equal(r.log.fetches, 1);
        await r.advance(1000);
        r.ds.capture(text('ab', { sig: sig(2) }), 120);
        await r.flush();
        assert.equal(r.log.fetches, 2, 'the re-try at 2 s');
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
        assert.deepEqual(r.log.sets, []);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: '', shell: false }]);
      });

      test('(−) SF-4 (R404-iso long): the same with a long text: no write before the re-try; RESTORE_TEXT_SKIPPED; then the typed text is kept over the old copy', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        r.fetchAnswer = copyOf(A);
        r.ds.capture(empty(), 120);
        await r.advance(300);
        r.type(X);
        await r.advance(KEEP_MS + 600);
        assert.deepEqual(r.log.keeps, [], 'no write before the server copy was seen');
        await r.advance(1000);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: X, shell: false }]);
      });

      test('(+) SF-4: with an empty box the re-try puts the server\'s copy back, and nothing asks again after it', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        r.fetchAnswer = copyOf(A);
        r.ds.capture(empty(), 120);
        await r.advance(1000);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 1, 'one GET per 2 s at most: 1 s is too early');
        await r.advance(1000);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.sets, [[A, false]]);
        assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
        for (let i = 0; i < 5; i += 1) {
          await r.advance(3000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 2, 'the answer ended the chain');
        assert.deepEqual(r.log.keeps, [], 'the server already holds that copy');
      });

      test('(−) SF-4: a GET that always answers 404 while 30 captures arrive over 30 s: 4 GETs (the first and 3 re-tries, one per 2 s at most), RESTORE_TEXT_FAILED once; then the first edit lifts the hold', async () => {
        const r = rig();
        const t0 = r.st.t;
        const times = [];
        r.fetchAnswer = () => { times.push(r.st.t - t0); return gone404(); };
        await r.ds.restore();
        for (let i = 0; i < 30; i += 1) {
          await r.advance(1000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.deepEqual(times, [0, 2000, 4000, 6000]);
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
        assert.deepEqual(r.log.problemMs, [8000]);
        assert.deepEqual(r.log.keeps, []);
        r.ds.reset();
        await r.flush();
        assert.equal(r.log.fetches, 4, 'a failed chain is not asked again by reset()');
        r.type(LONG);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }], 'the first edit lifts the hold, as for any failed restore');
      });

      test('(−) SF-4: a put-back that throws is not asked again from captures: 30 captures, 1 GET, RESTORE_TEXT_FAILED once (reset() still asks)', async () => {
        const r = rig();
        r.fetchAnswer = copyOf(A);
        r.setBoxError = new Error('boom');
        await r.ds.restore();
        for (let i = 0; i < 30; i += 1) {
          await r.advance(1000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 1);
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
        assert.equal(r.st.box.value, '');
        r.ds.reset();
        await r.flush();
        assert.equal(r.log.fetches, 2, 'reset() asks, as in round 1');
        assert.deepEqual(r.log.sets, [[A, false]]);
      });

      // round 2b (ruling in round-b-at-lt-2b.md): a re-try is a restore() started from a capture or from reset(); the boot restore and a back/forward return are first tries and start a new chain
      test('(+) SF-4b: a back/forward return (pageshow restore) after a put-back that threw is a first try, not a re-try: the box that holds what this page saved takes another page\'s copy, with no "typed before" line', async () => {
        const r = rig();
        r.fetchAnswer = copyOf(A);
        r.setBoxError = new Error('boom');
        await r.ds.restore(); // boot: the put-back throws; reset() would ask again, nothing else does
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
        const B1 = `${A} typed and saved after that`;
        r.type(B1);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: B1, shell: false }], 'the first edit lifted the hold and this page saved B1');
        const C = `${A} written by the other page`;
        r.fetchAnswer = copyOf(C);
        await r.ds.restore(); // pageshow, persisted
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED], 'no "typed before nika could bring back" line: nothing was typed during this restore');
        assert.deepEqual(r.log.sets, [[C, false]], 'owner answer A: the box holds the copy this page saved, so the other page\'s copy is put back');
        assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
      });

      test('(+) SF-4b: a back/forward return while a capture re-try is pending, with an empty box: the server\'s copy is put back and the pending capture re-try is gone', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore(); // boot: 404, a capture re-try is pending
        assert.equal(r.log.fetches, 1);
        r.fetchAnswer = copyOf(A);
        await r.ds.restore(); // the return comes before any capture
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.sets, [[A, false]]);
        assert.deepEqual(r.log.announces, [RESTORED_TEXT]);
        assert.deepEqual(r.log.problems, []);
        for (let i = 0; i < 10; i += 1) {
          await r.advance(3000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 2, 'the return ended the chain: no capture asks again');
      });

      test('(−) SF-4b: a return starts a new chain count: one capture re-try, then a return that says 404 again, then captures: the new chain gets its own 3 re-tries (6 GETs), then RESTORE_TEXT_FAILED once', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        await r.advance(2000);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 2, 'the first try and one re-try');
        await r.ds.restore(); // the return: a first try of a new chain
        assert.equal(r.log.fetches, 3);
        for (let i = 0; i < 30; i += 1) {
          await r.advance(1000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 6, 'the return and its own 3 re-tries');
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
      });

      test('(−) SF-4: the 500 failure path starts no capture re-try (two GETs, its own line), and its first edit still releases the hold', async () => {
        const r = rig();
        r.fetchAnswer = E500;
        const p = r.ds.restore();
        await r.flush();
        await r.advance(2000);
        await p;
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
        for (let i = 0; i < 10; i += 1) {
          await r.advance(1000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 2);
        r.type(LONG);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }]);
      });

      test('(−) SF-4 (P4c): a stopped exit gets no capture re-try while the page is stopped, and reset() asks once; the answer ends the chain', async () => {
        const r = await stoppedRestore(gone404());
        assert.equal(r.log.fetches, 1);
        await r.advance(3000);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 1, 'stopped: no capture re-try');
        r.fetchAnswer = copyOf(A);
        r.ds.reset();
        await r.flush();
        assert.equal(r.log.fetches, 2);
        assert.deepEqual(r.log.sets, [[A, false]]);
        for (let i = 0; i < 5; i += 1) {
          await r.advance(3000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 2, 'reset() asked once; the answer ended the chain');
      });

      test('(−) SF-4: reset() re-asks with the first try\'s edit snapshot: text typed since that try is RESTORE_TEXT_SKIPPED, and is kept over the old copy once the page is back', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        r.ds.stop();
        r.type(X);
        await r.advance(KEEP_MS + 600);
        assert.deepEqual(r.log.keeps, [], 'stopped: nothing is written');
        r.fetchAnswer = copyOf(A);
        r.ds.reset();
        await r.flush();
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_SKIPPED]);
        assert.equal(r.st.box.value, X);
        assert.deepEqual(r.log.sets, []);
        r.ds.capture(empty(), 120);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: X, shell: false }]);
      });

      test('(−) SF-4: reset() starts a new count: after 2 capture re-tries a stop and a reset allow 3 more (7 GETs), and the 7th ends in RESTORE_TEXT_FAILED once', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        for (let i = 0; i < 2; i += 1) {
          await r.advance(2000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 3);
        assert.deepEqual(r.log.problems, []);
        r.ds.stop();
        r.ds.reset();
        await r.flush();
        assert.equal(r.log.fetches, 4);
        for (let i = 0; i < 6; i += 1) {
          await r.advance(2000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 7);
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
      });

      test('(+) SF-4: every known answer ends the chain: { kept: null } and a failure path; the hold stays only while a capture re-try is pending', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        r.fetchAnswer = () => okKept(null);
        await r.advance(2000);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 2);
        for (let i = 0; i < 5; i += 1) {
          await r.advance(3000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 2, '{ kept: null } ended the chain');
        r.type(LONG);
        await r.advance(KEEP_MS);
        assert.deepEqual(r.log.keeps, [{ text: LONG, shell: false }], 'the hold lifted with the answer');
      });

      test('(−) SF-4: typing before the first try is not typing since it: the re-try after a 404 shows no line and puts another page\'s copy into the box that still holds what this page saved', async () => {
        const r = await booted();
        r.type(A);
        await r.advance(KEEP_MS); // A is typed and saved: the edit count is above 0 when the first try runs
        assert.deepEqual(r.log.keeps, [{ text: A, shell: false }]);
        r.fetchAnswer = gone404;
        await r.ds.restore();
        const B = `${A} written by the other page`;
        r.fetchAnswer = copyOf(B);
        await r.advance(2000);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 3, 'boot, the first try that said 404, the re-try');
        assert.deepEqual(r.log.problems, [], 'nothing was typed since the first try');
        assert.deepEqual(r.log.sets, [[B, false]]);
      });

      test('(−) SF-4: a new chain starts a new count: after a chain that ended on 200, a second restore that never sees the copy gets its own first try and 3 re-tries (4 GETs), then RESTORE_TEXT_FAILED once', async () => {
        const r = rig();
        r.fetchAnswer = gone404;
        await r.ds.restore();
        await r.advance(2000);
        r.ds.capture(empty(), 120);
        await r.flush();
        await r.advance(2000);
        r.fetchAnswer = () => okKept(null);
        r.ds.capture(empty(), 120);
        await r.flush();
        assert.equal(r.log.fetches, 3, 'chain one: the first try, a re-try that said 404, a re-try that answered: 2 of 3 re-tries used');
        assert.deepEqual(r.log.problems, []);
        r.fetchAnswer = gone404;
        await r.ds.restore(); // chain two (a back/forward return)
        for (let i = 0; i < 30; i += 1) {
          await r.advance(1000);
          r.ds.capture(empty(), 120);
          await r.flush();
        }
        assert.equal(r.log.fetches, 3 + 4, 'chain two: its own first try and its own 3 re-tries');
        assert.deepEqual(r.log.problems, [RESTORE_TEXT_FAILED]);
      });

      test('(−) SF-4: a capture that arrives while the page is stopped never starts a re-try and is not swallowed: it still runs the sync step (the paused note is drawn)', async () => {
        const r = await stoppedRestore(gone404());
        r.type('ab');
        assert.equal(r.lastNote(), null, 'nothing to say yet');
        await r.advance(3000);
        r.ds.capture(unreadable('pasted'), 120);
        await r.flush();
        assert.equal(r.log.fetches, 1, 'stopped: no GET');
        assert.equal(r.lastNote()?.kind, 'paused', 'the capture still ran the sync step');
      });

      // SF-5: the over note wins in every state where the text can be neither kept nor sent
      const OVER = 'x'.repeat(16385);
      const FITS = 'x'.repeat(16384);

      test('(+) SF-5: 17 KB typed, then a prompt or dialog on screen (no box): the over note, and it goes when the text is shortened', async () => {
        const r = await booted();
        r.type(OVER);
        r.ds.capture(null, 120);
        assert.deepEqual(r.lastNote(), OVER_NOTE);
        r.type(FITS);
        assert.equal(r.lastNote(), null, 'no box on screen and nothing over: no note, as before');
      });

      test('(+) SF-5: 17 KB with an unreadable screen: the over note, not paused; shortened, paused comes back with its reason', async () => {
        const r = await booted();
        r.type(OVER);
        r.ds.capture(unreadable('tall'), 120);
        assert.deepEqual(r.lastNote(), OVER_NOTE);
        r.type(FITS);
        assert.equal(r.lastNote().kind, 'paused');
        assert.equal(r.lastNote().text, noteView({ kind: 'paused', reason: 'tall' }).text);
      });

      test('(−) SF-5: 16 KB or less in both states: null with no box on screen and paused with an unreadable one, as before', async () => {
        const a = await booted();
        a.type(FITS);
        a.ds.capture(null, 120);
        assert.equal(a.lastNote(), null);
        const b = await booted();
        b.type(FITS);
        b.ds.capture(unreadable('tall'), 120);
        assert.equal(b.lastNote().kind, 'paused');
      });

      test('(−) SF-5: unsent text only: after sent() the emptied box shows no over note in either state, and a box nobody typed in is never over', async () => {
        const r = await booted();
        r.type(OVER);
        r.ds.capture(null, 120);
        assert.equal(r.lastNote().kind, 'over');
        r.st.box = { value: '', shell: false };
        r.ds.sent();
        r.ds.capture(unreadable('tall'), 120);
        assert.equal(r.lastNote().kind, 'paused');
        r.ds.capture(null, 120);
        assert.equal(r.lastNote(), null);
        const q = rig();
        q.st.box = { value: OVER, shell: false }; // text in the box that the user never typed (dirty is false)
        q.ds.capture(null, 120);
        assert.equal(q.lastNote(), null);
      });
    });
  });
});
