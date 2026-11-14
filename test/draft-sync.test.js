// The page side of draft sync (design W5, docs/contracts/api-app.md): public/draft-sync.js, with no DOM and no requests of its own.
// The controller runs against a fake box, a fake PUT route and a manual clock, so every timing rule (1.5 s of quiet before a
// pull, 250 ms before a push) is asserted exactly. Fixtures are synthetic (acme-api, demo-api).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normDraft, sameDraft, inEnvelope, fits, canon, screenCanon, cleanDraft, cutAt, caretAfter, noteView, draftSendPlan, createDraftSync,
  QUIET_MS, PUSH_MS,
} from '../public/draft-sync.js';
import { normDraft as srcNorm, sameDraft as srcSame, inEnvelope as srcEnvelope } from '../src/draft.js';

const sig = (n) => String(n).padStart(16, '0'); // 16 lowercase hex, like the server's
const BOX = { top: 30, bottom: 32 };
const text = (t, over = {}) => ({ state: 'text', mode: 'prompt', text: t, sig: sig(1), box: BOX, cursorAtEnd: true, suggestion: null, ...over });
const empty = (over = {}) => ({ state: 'empty', mode: 'prompt', text: '', sig: sig(9), box: BOX, cursorAtEnd: true, suggestion: null, ...over });
const unreadable = (reason, over = {}) => ({ state: 'unreadable', mode: 'prompt', text: '', sig: null, reason, box: BOX, cursorAtEnd: false, suggestion: null, ...over });

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

  test('(−) anything that is not exactly the shape is null (fail closed: no cut, no sync)', () => {
    const bad = [
      undefined, null, 'draft', 7, [], text('a', { state: 'maybe' }), text('a', { mode: 'vim' }), text(5), text('x'.repeat(4097)),
      text('a', { sig: 'xyz' }), text('a', { sig: sig(1).toUpperCase().replace(/0/g, 'G') }), text('a', { sig: null }), empty({ sig: undefined }),
      text('a', { box: null }), text('a', { box: { top: -1, bottom: 3 } }), text('a', { box: { top: 1.5, bottom: 3 } }), text('a', { box: { top: 5, bottom: 5 } }),
      text('a', { box: { top: 5, bottom: 4 } }), text('a', { box: { top: '3', bottom: 5 } }),
    ];
    for (const b of bad) assert.equal(cleanDraft(b), null, JSON.stringify(b));
  });
});

describe('cutAt (design 5): where the mirror stops', () => {
  test('(+) a readable draft with Type into pane off cuts at the box top, empty or text', () => {
    assert.equal(cutAt(text('hello'), false), 30);
    assert.equal(cutAt(empty(), false), 30);
    assert.equal(cutAt(text('ls', { mode: 'bash' }), false), 30);
    assert.equal(cutAt(empty({ box: { top: 0, bottom: 2 } }), false), 0);
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
      layout: "something nika doesn't recognise",
    };
    for (const [reason, why] of Object.entries(want)) {
      const v = noteView({ kind: 'paused', reason });
      assert.equal(v.label, 'Sync paused:');
      assert.equal(v.text, `Claude's input holds ${why}. Edit or clear it in the terminal.`);
      assert.equal(v.kind, 'paused');
      assert.ok(v.icon);
    }
    assert.match(noteView({ kind: 'paused', reason: 'from-the-future' }).text, /something nika doesn't recognise/);
  });

  test('(+) long text and a refused replace each have their own word, icon and kind', () => {
    const long = noteView({ kind: 'long' });
    const wait = noteView({ kind: 'wait' });
    assert.equal(long.text, 'Long text goes to Claude when you send it.');
    assert.match(wait.text, /Claude is working/);
    assert.equal(new Set([noteView({ kind: 'paused', reason: 'tall' }).icon, long.icon, wait.icon]).size, 3, 'three states, three icons');
    assert.equal(new Set([noteView({ kind: 'paused', reason: 'tall' }).label, long.label, wait.label]).size, 3, 'and three words');
  });

  test('(−) no note and unknown kinds give null', () => {
    assert.equal(noteView(null), null);
    assert.equal(noteView({ kind: 'party' }), null);
  });
});

describe('draftSendPlan: the Send table (design 4)', () => {
  const plan = (over) => draftSendPlan({ value: 'fix the typo', shell: false, screen: text('fix the typo'), cols: 120, ...over });
  const ENTER = [{ keys: ['Enter'] }];

  test('(+) row 1: the screen already equals the box: Enter alone', () => {
    const p = plan({});
    assert.equal(p.act, 'enter');
    assert.deepEqual(p.payloads, ENTER);
    assert.equal(p.summary, 'Enter');
  });

  test('(+) row 1: equal up to trailing spaces, a tab or a trailing newline', () => {
    assert.equal(plan({ value: 'fix the typo   ' }).act, 'enter');
    assert.equal(plan({ value: 'fix the typo\n' }).act, 'enter');
    assert.equal(plan({ value: 'a\tb', screen: text('a    b') }).act, 'enter');
  });

  test('(+) row 1, Shell: a bash screen equal to "!" + the box is Enter alone, with no C-u first', () => {
    const p = plan({ value: 'ls -la', shell: true, screen: text('ls -la', { mode: 'bash' }) });
    assert.equal(p.act, 'enter');
    assert.deepEqual(p.payloads, ENTER);
  });

  test('(+) row 2: nika\'s box is empty: Enter, whatever the screen holds (readable, unreadable or none)', () => {
    for (const screen of [empty(), text('typed in the terminal'), unreadable('pasted'), null]) {
      const p = plan({ value: '', screen });
      assert.equal(p.act, 'enter');
      assert.deepEqual(p.payloads, ENTER);
    }
    assert.equal(plan({ value: '  \n ', screen: empty() }).act, 'enter');
  });

  test('(−) row 2, Shell: an empty box with Shell on sends nothing (today: no lone "!")', () => {
    assert.equal(plan({ value: '', shell: true, screen: empty() }).act, 'legacy');
  });

  test('(+) row 3: text in the envelope and a different readable screen: push (the trimmed text), then Enter', () => {
    const p = plan({ value: 'fix the typo in acme-api ', screen: text('fix the') });
    assert.equal(p.act, 'push');
    assert.equal(p.text, 'fix the typo in acme-api', 'the trailing space stays out of Claude\'s box');
    assert.deepEqual(p.payloads, ENTER);
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
});

// ---- the controller --------------------------------------------------------------------------------------------------------

/** A fake box, a fake PUT route and a manual clock. `type()` is the user typing in nika; `answer` scripts the route. */
function rig({ value = '', shell = false } = {}) {
  const st = { t: 5_000_000, timers: [], box: { value, shell } };
  const log = { puts: [], sets: [], notes: [], problems: [], gone: 0 };
  const r = { st, log, answer: null };
  r.answer = (body) => ({ status: 200, body: { draft: text(body.text.replace(/^!/, ''), { mode: body.text.startsWith('!') ? 'bash' : 'prompt', sig: sig(100 + log.puts.length) }), typed: body.text.length } });
  const io = {
    now: () => st.t,
    after(fn, ms) { const h = { at: st.t + ms, fn }; st.timers.push(h); return h; },
    cancel(h) { st.timers = st.timers.filter((x) => x !== h); },
    box: () => ({ ...st.box }),
    setBox(v, s) { st.box = { value: v, shell: s }; log.sets.push([v, s]); },
    put: async (body) => { log.puts.push(body); return r.answer(body); },
    note: (n) => log.notes.push(n),
    problem: (m) => log.problems.push(m),
    gone: () => { log.gone += 1; },
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
    assert.equal(r.lastNote().text, 'Long text goes to Claude when you send it.');
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

  test('(+) 409 not-idle: the "Claude is working" note, a retry in 3 s, and it goes through then', async () => {
    const r = await setup(409, { error: 'not-idle' });
    assert.equal(r.lastNote().kind, 'wait');
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
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(r.log.puts, [{ text: 'fix the typo', base: sig(4) }]);
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
    assert.deepEqual(await sent, { ok: true });
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
    assert.equal(new Set(Object.values(lines)).size, 9, `distinct lines (404 and 0 differ, the two unreadable ones share): ${JSON.stringify(lines)}`);
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
