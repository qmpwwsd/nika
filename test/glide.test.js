// The glide of the mirror after a scroll request (nika 0.5, design F17): public/glide.js, with no DOM and no timer of its own.
// The arm runs against a manual clock and synthetic frames (a made-up document of numbered lines), so every rule is asserted exactly:
// the shift finder (unique rows vote), the arm (direction, window, rebase, far slide), the start offset and the matrix reader.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLIDE_MS, GLIDE_ARM_MS, GLIDE_MIN_ROWS, GLIDE_SHARE, frameOf, findShift, createGlideArm, glideFrom, matrixY, paneWriteDisarms } from '../public/glide.js';
import { rowText } from '../public/scroll.js';
import { parseDraft } from '../src/draft.js';
import { cleanDraft } from '../public/draft-sync.js';
import { boxRows, taskRows } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'public', 'glide.js'), 'utf8');
const CSS = fs.readFileSync(path.join(HERE, '..', 'public', 'session.css'), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

// ---- synthetic frames: a document of numbered lines seen through a 32-row window, with a 4-row input box below it ----------------
const DOC = Array.from({ length: 300 }, (_, i) => `line ${i} of the made-up document`);
const BOX = { top: 32, bottom: 34 };
const draftOf = (box = BOX) => ({ state: 'empty', mode: 'prompt', text: '', sig: '0000000000000001', box, cursorAtEnd: true, suggestion: null });
const spans = (t) => [{ t }];
/** The capture body of the window that starts at document line `o`: 32 document rows, then the input box and the footer. */
const bodyAt = (o, over = {}) => ({
  alt: true, scrolled: o > 0, cols: 120,
  rows: [...DOC.slice(o, o + 32).map(spans), spans('-----'), spans('> '), spans('-----'), spans('? for shortcuts')],
  draft: draftOf(), ...over,
});
const view = (o) => frameOf(bodyAt(o), draftOf());
/** A frame straight from texts, for the cases that need exact rows. */
const fr = (texts, over = {}) => ({ texts, end: texts.length, cols: 80, rows: texts.length, ...over });
/** A manual clock and an arm that reads it. */
const rig = () => {
  let t = 1000;
  return { arm: createGlideArm({ now: () => t }), tick: (ms) => { t += ms; } };
};
const UP = { dir: 'up', pages: 1 };
const DOWN = { dir: 'down', pages: 1 };

describe('constants', () => {
  test('(+) the numbers are the designed ones', () => {
    assert.deepEqual([GLIDE_MS, GLIDE_ARM_MS, GLIDE_MIN_ROWS, GLIDE_SHARE], [150, 700, 3, 0.8]);
  });

  test('(+) the stylesheet and GLIDE_MS agree on the slide time', () => {
    assert.match(CSS, new RegExp(`animation:\\s*nika-glide ${GLIDE_MS}ms\\b`));
  });
});

describe('frameOf', () => {
  test('(+) bottom: only a capture that says Claude\'s view is not scrolled up (scrolled === false) is at the bottom', () => {
    assert.equal(frameOf(bodyAt(0, { scrolled: false }), draftOf()).bottom, true);
    assert.equal(frameOf(bodyAt(0, { scrolled: true }), draftOf()).bottom, false);
  });

  test('(−) bottom: a capture that does not say (no flag, null, a string, no body) is not at the bottom', () => {
    for (const scrolled of [undefined, null, 'false', 0]) assert.equal(frameOf({ ...bodyAt(0), scrolled }, draftOf()).bottom, false, String(scrolled));
    assert.equal(frameOf(undefined, undefined).bottom, false);
    assert.equal(frameOf({}, null).bottom, false);
  });

  test('(+) the texts end at the top of Claude\'s input box, and carry the pane size', () => {
    const f = view(0);
    assert.equal(f.texts.length, 32);
    assert.equal(f.end, 32);
    assert.equal(f.texts[0], DOC[0]);
    assert.equal(f.texts[31], DOC[31]);
    assert.equal(f.cols, 120);
    assert.equal(f.rows, 36);
  });

  test('(+) with no readable box every row is the conversation', () => {
    for (const draft of [null, undefined, { box: null }, { box: { top: 'x' } }]) {
      const f = frameOf(bodyAt(0), draft);
      assert.equal(f.end, 36, JSON.stringify(draft));
      assert.equal(f.texts.length, 36);
    }
  });

  test('(+) a box higher than the capture cannot read past the rows; a no-break space is a space; the right edge is trimmed', () => {
    const f = frameOf({ cols: 10, rows: [[{ t: 'a b' }, { t: '   ' }], [{ t: '  ' }], [{ t: 'c' }]] }, { box: { top: 99 } });
    assert.deepEqual(f.texts, ['a b', '', 'c']);
    assert.equal(f.end, 3);
  });

  test('(−) no rows, a body that is not one, or a row that is not a list of spans: nothing to compare', () => {
    for (const body of [null, undefined, {}, { rows: 'x' }, { rows: [] }]) {
      const f = frameOf(body, draftOf());
      assert.deepEqual(f.texts, [], JSON.stringify(body));
      assert.equal(f.end, 0);
    }
    assert.deepEqual(frameOf({ cols: 5, rows: [null, 5, [{ t: 7 }, null, { t: 'ok' }]] }, null).texts, ['', '', 'ok']);
  });

  test('(+) rowText is the one scroll.js has: the spans joined, anything else empty', () => {
    assert.equal(rowText([{ t: 'a' }, { t: 'b' }]), 'ab');
    assert.equal(rowText(null), '');
  });
});

// ---- 0.5.1 E: the crop (nika's own panel stands in for Claude's dialog; the mirror ends at the dialog's top row) -----------------------------
describe('frameOf and findShift with a crop (0.5.1 E)', () => {
  test('(+) the frame ends at the crop and carries it; the pane size and the rows above are unchanged', () => {
    const f = frameOf(bodyAt(0), draftOf(), 20);
    assert.equal(f.end, 20);
    assert.equal(f.crop, 20);
    assert.deepEqual(f.texts, DOC.slice(0, 20));
    assert.equal(f.rows, 36);
    assert.equal(f.cols, 120);
  });

  test('(+) a crop below the box ends the frame at the smaller of the two; a crop above the task list header wins over it too', () => {
    assert.equal(frameOf(bodyAt(0), draftOf(), 99).end, 32, 'a crop past the box top: the box still ends the frame');
    assert.equal(frameOf(bodyAt(0), draftOf(), 99).crop, 99, 'the crop is still recorded');
    const tasksBox = { top: 27, bottom: 29, tasks: 17 };
    assert.equal(frameOf(pinnedAt(0), draftOf(tasksBox), 10).end, 10);
    assert.equal(frameOf(pinnedAt(0), draftOf(tasksBox), 25).end, 17, 'the task list header ends it first');
  });

  test('(+) a crop of null (or left out) is the frame it always was, with crop: null', () => {
    const plain = frameOf(bodyAt(0), draftOf());
    assert.equal(plain.crop, null);
    assert.deepEqual(frameOf(bodyAt(0), draftOf(), null), plain);
    assert.deepEqual(frameOf(bodyAt(0), draftOf(), undefined), plain);
    assert.equal(plain.end, 32);
  });

  test('(−) a crop that is not a whole number from 0 up is ignored and recorded as null', () => {
    for (const crop of [-1, 7.5, '7', NaN, Infinity, true, [], {}]) {
      const f = frameOf(bodyAt(0), draftOf(), crop);
      assert.equal(f.crop, null, String(crop));
      assert.equal(f.end, 32, String(crop));
    }
  });

  test('(+) findShift gives the same shift for two frames cropped the same way', () => {
    const s = findShift(frameOf(bodyAt(5), draftOf(), 20), frameOf(bodyAt(2), draftOf(), 20));
    assert.equal(s.k, 3);
    assert.equal(s.votes, 17);
  });

  test('(−) findShift gives null when the crops differ (a crop that appears or goes never slides), either way round', () => {
    const cropped = frameOf(bodyAt(3), draftOf(), 20);
    const whole = frameOf(bodyAt(0), draftOf());
    assert.equal(findShift(cropped, whole), null);
    assert.equal(findShift(whole, cropped), null);
    assert.equal(findShift(frameOf(bodyAt(3), draftOf(), 20), frameOf(bodyAt(0), draftOf(), 21)), null, 'two different crops');
  });

  test('(−) findShift with both crops null, or a hand-made frame with no crop field, is what it was', () => {
    assert.notEqual(findShift(view(3), view(0)), null);
    assert.equal(findShift(view(3), view(0)).k, 3);
    assert.notEqual(findShift(fr(['a', 'b', 'c', 'd']), fr(['x', 'a', 'b', 'c'])), null, 'neither frame has the field');
    assert.notEqual(findShift(fr(['a', 'b'], { crop: null }), fr(['x', 'a'])), null, 'null and absent are the same');
  });

  test('(−) the arm does not glide across a crop that appeared between the base frame and the next one: it rebases or gives up, never slides', () => {
    const { arm } = rig();
    assert.equal(arm.arm(UP, { scrolled: true, before: frameOf(bodyAt(3), draftOf()) }), true);
    assert.equal(arm.offer(frameOf(bodyAt(0), draftOf(), 20)), null, 'a different size of frame: no glide, the arm is over');
    assert.equal(arm.armed(), false);
  });
});

// ---- Claude's task list pinned between the conversation and its box (LC18 Finding 2): static rows that must neither vote nor slide ----------
// 17 document rows, the list (9 rows: header, 7 task rows, overflow row), one blank row, then the box. With the view moved by 3 rows, 14 of the 17 document
// rows are in both frames: 14 rows vote the shift and the 9 list rows vote "no shift", the numbers of the live check (14 of 23 = 0.61 < GLIDE_SHARE).
const SHOWN = 17;
const LIST = ['  3/9 tasks done · 1 in progress', ...Array.from({ length: 7 }, (_, i) => `  ◻ Made-up task ${i}`), '  … +1 task (1 open)'];
const pinnedAt = (o, over = {}) => ({
  alt: true, scrolled: o > 0, cols: 120,
  rows: [...DOC.slice(o, o + SHOWN).map(spans), ...LIST.map(spans), spans(''), spans('-----'), spans('> '), spans('-----'), spans('? for shortcuts')],
  ...over,
});
const PLAIN_BOX = { top: 27, bottom: 29 }; // the draft before box.tasks existed: the list rows are inside the frame
const LIST_BOX = { ...PLAIN_BOX, tasks: SHOWN };

describe('frameOf: the task list pinned above Claude\'s box (LC18)', () => {
  test('(+) the frame ends at the list\'s header (draft.box.tasks): the list rows are not in it, the pane size is unchanged', () => {
    const f = frameOf(pinnedAt(0), draftOf(LIST_BOX));
    assert.equal(f.end, SHOWN);
    assert.equal(f.texts.length, SHOWN);
    assert.deepEqual(f.texts, DOC.slice(0, SHOWN));
    assert.equal(f.rows, 31);
    assert.equal(f.cols, 120);
    assert.equal(f.bottom, true);
    const before = frameOf(pinnedAt(0), draftOf(PLAIN_BOX));
    assert.equal(before.end, 27, 'without the field the frame still ends at the box, as it did');
    assert.deepEqual(before.texts.slice(0, SHOWN), f.texts);
    assert.deepEqual(before.texts.slice(SHOWN, SHOWN + LIST.length), LIST);
  });

  test('(+) a list at the very top of the screen (tasks 0) leaves nothing to compare; tasks at the box\'s top is the whole frame', () => {
    const none = frameOf(pinnedAt(0), draftOf({ ...PLAIN_BOX, tasks: 0 }));
    assert.equal(none.end, 0);
    assert.deepEqual(none.texts, []);
    assert.equal(frameOf(pinnedAt(0), draftOf({ ...PLAIN_BOX, tasks: 27 })).end, 27);
  });

  test('(+) a header past the rows of a short capture cannot read past them; one inside them ends the frame there', () => {
    const body = { cols: 10, rows: [[{ t: 'a' }], [{ t: 'b' }], [{ t: 'c' }]] };
    assert.equal(frameOf(body, { box: { top: 99, tasks: 5 } }).end, 3);
    assert.equal(frameOf(body, { box: { top: 99, tasks: 2 } }).end, 2);
    assert.deepEqual(frameOf(body, { box: { top: 99, tasks: 2 } }).texts, ['a', 'b']);
  });

  test('(−) a tasks that is not an integer, is negative or lies past the box\'s top is ignored: the frame ends at the box', () => {
    for (const tasks of [1.5, -1, -0.5, '17', '0', null, true, false, [], [17], {}, NaN, Infinity, -Infinity, 28, 99, 2 ** 40, undefined]) {
      const f = frameOf(pinnedAt(0), draftOf({ ...PLAIN_BOX, tasks }));
      assert.equal(f.end, 27, `tasks = ${String(tasks)}`);
      assert.equal(f.texts.length, 27, `tasks = ${String(tasks)}`);
    }
  });

  test('(−) no draft, no box, a box with no tasks: the frame is what it was', () => {
    for (const draft of [null, undefined, {}, { box: null }, { box: {} }]) assert.equal(frameOf(pinnedAt(0), draft).end, 31, JSON.stringify(draft));
    for (const box of [{ top: 27 }, PLAIN_BOX]) assert.equal(frameOf(pinnedAt(0), draftOf(box)).end, 27, JSON.stringify(box));
  });

  test('(+) the live numbers: without the field the 9 list rows vote "no shift" and the glide never starts; with it the pair is a clean shift of 3', () => {
    const plain = findShift(frameOf(pinnedAt(3), draftOf(PLAIN_BOX)), frameOf(pinnedAt(0), draftOf(PLAIN_BOX)));
    assert.deepEqual([plain.k, plain.votes, plain.total, plain.tie], [3, 14, 23, false]);
    assert.ok(plain.votes < GLIDE_SHARE * plain.total, 'under the share (0.61 < 0.8)');
    const a = rig().arm;
    a.arm(UP, { scrolled: true, before: frameOf(pinnedAt(3), draftOf(PLAIN_BOX)) });
    assert.deepEqual(a.offer(frameOf(pinnedAt(0), draftOf(PLAIN_BOX))), { act: 'rebase' }, 'the bug: the matcher rebases, the rows jump');

    const clean = findShift(frameOf(pinnedAt(3), draftOf(LIST_BOX)), frameOf(pinnedAt(0), draftOf(LIST_BOX)));
    assert.deepEqual([clean.k, clean.votes, clean.total, clean.tie], [3, 14, 14, false]);
    const b = rig().arm;
    b.arm(UP, { scrolled: true, before: frameOf(pinnedAt(3), draftOf(LIST_BOX)) });
    assert.deepEqual(b.offer(frameOf(pinnedAt(0), draftOf(LIST_BOX))), { act: 'glide', k: 3, end: SHOWN }, 'only the conversation rows slide: end is the list\'s header');
  });

  test('(+) a down request glides the same way, and a list that changes between the frames does not disturb the conversation\'s vote', () => {
    const a = rig().arm;
    a.arm(DOWN, { scrolled: true, before: frameOf(pinnedAt(0), draftOf(LIST_BOX)) });
    assert.deepEqual(a.offer(frameOf(pinnedAt(3), draftOf(LIST_BOX))), { act: 'glide', k: -3, end: SHOWN });
    const b = rig().arm;
    b.arm(UP, { scrolled: true, before: frameOf(pinnedAt(3), draftOf(LIST_BOX)) });
    const moved = pinnedAt(0);
    moved.rows[SHOWN + 1] = spans('  ✔ A task that just got done'); // a list row changed: it is not in the frame
    assert.deepEqual(b.offer(frameOf(moved, draftOf(LIST_BOX))), { act: 'glide', k: 3, end: SHOWN });
  });

  test('(+) the reader and the matcher agree: the Draft parseDraft writes for a real screen ends the frame at the header of the list', () => {
    const live = (o, tasks = taskRows({ named: false, blank: 0, doing: 1, open: 3, shownDone: 3, hiddenDone: 1 })) => {
      const s = boxRows({ lines: [''] });
      const above = [...DOC.slice(o, o + SHOWN).map(spans), ...tasks, []];
      const rows = [...above, ...s.rows];
      const draft = parseDraft(rows, { ...s.cursor, y: s.cursor.y + above.length }, s.cols);
      return { draft, frame: frameOf({ alt: true, scrolled: o > 0, cols: s.cols, rows }, draft) };
    };
    const first = live(3);
    const second = live(0);
    assert.equal(first.draft.box.tasks, SHOWN);
    assert.equal(first.frame.end, SHOWN);
    assert.deepEqual(second.frame.texts, DOC.slice(0, SHOWN));
    const arm = rig().arm;
    arm.arm(UP, { scrolled: true, before: first.frame });
    assert.deepEqual(arm.offer(second.frame), { act: 'glide', k: 3, end: SHOWN });
    const bare = live(0, []); // no list: the same screen as before, the frame ends at the box
    assert.equal(Object.hasOwn(bare.draft.box, 'tasks'), false);
    assert.equal(bare.frame.end, bare.draft.box.top);
  });

  test('(+) the page\'s own path: the server\'s Draft over the wire, through cleanDraft, then frameOf ends at the list\'s header and the pair glides', () => {
    const live = (o) => {
      const s = boxRows({ lines: [''] });
      const above = [...DOC.slice(o, o + SHOWN).map(spans), ...taskRows({ named: false, blank: 0, doing: 1, open: 3, shownDone: 3, hiddenDone: 1 }), []];
      const rows = [...above, ...s.rows];
      const wire = JSON.parse(JSON.stringify(parseDraft(rows, { ...s.cursor, y: s.cursor.y + above.length }, s.cols))); // the capture body's draft
      const body = { alt: true, scrolled: o > 0, cols: s.cols, rows };
      const draft = cleanDraft(wire); // what public/session.js hands to frameOf
      return { wire, draft, frame: frameOf(body, draft), body };
    };
    const first = live(3);
    const second = live(0);
    assert.equal(first.wire.box.tasks, SHOWN, 'the server wrote it');
    assert.equal(first.draft.box.tasks, SHOWN, 'cleanDraft kept it');
    assert.equal(first.frame.end, SHOWN);
    assert.deepEqual(second.frame.texts, DOC.slice(0, SHOWN));
    const arm = rig().arm;
    arm.arm(UP, { scrolled: true, before: first.frame });
    assert.deepEqual(arm.offer(second.frame), { act: 'glide', k: 3, end: SHOWN });
    // The same screen with a value cleanDraft refuses: the frame ends at the box, as before the field existed.
    for (const tasks of [-1, 1.5, '17', first.draft.box.top, first.draft.box.top + 1]) {
      const bad = cleanDraft({ ...first.wire, box: { ...first.wire.box, tasks } });
      assert.deepEqual(bad.box, { top: first.draft.box.top, bottom: first.draft.box.bottom }, String(tasks));
      assert.equal(frameOf(first.body, bad).end, first.draft.box.top, String(tasks));
    }
  });
});

describe('findShift', () => {
  test('(+) a window that moved down 16 rows is k = 16, and every shared row votes for it', () => {
    const s = findShift(view(16), view(0));
    assert.equal(s.k, 16);
    assert.equal(s.votes, 16);
    assert.equal(s.total, 16);
    assert.equal(s.tie, false);
  });

  test('(+) a window that moved up 16 rows is k = -16', () => {
    const s = findShift(view(0), view(16));
    assert.equal(s.k, -16);
    assert.equal(s.votes, 16);
  });

  test('(+) with the pill row and the spinner row changed it is still k = 16, with at least 80 % of the votes', () => {
    const a = view(16);
    const b = view(0);
    a.texts[3] = 'a spinner turns';
    b.texts[28] = 'a pill says scrolled';
    b.texts[9] = 'a different row';
    const s = findShift(a, b);
    assert.equal(s.k, 16);
    assert.ok(s.votes >= GLIDE_SHARE * s.total, `${s.votes} of ${s.total}`);
    assert.ok(s.votes >= GLIDE_MIN_ROWS);
  });

  test('(+) identical frames are k = 0, and every unique row votes', () => {
    const s = findShift(view(8), view(8));
    assert.equal(s.k, 0);
    assert.equal(s.votes, 32);
    assert.equal(s.total, 32);
  });

  test('(−) rows that occur more than once, and blank rows, carry no position', () => {
    const rule = '-'.repeat(20);
    const none = findShift(fr([rule, rule, '', '', '}', '}']), fr([rule, '}', '', rule, '}', '']));
    assert.deepEqual([none.votes, none.total], [0, 0]);
    const one = findShift(fr(['x', 'x', 'a']), fr(['a', 'x', 'y']));
    assert.deepEqual([one.k, one.votes, one.total], [-2, 1, 1], 'x repeats in the first frame: only a votes');
    const other = findShift(fr(['a', 'y', 'x']), fr(['x', 'x', 'a']));
    assert.deepEqual([other.votes, other.total], [1, 1], 'x repeats in the second frame: only a votes');
  });

  test('(−) a blank row that occurs once on each side carries no position either', () => {
    const s = findShift(fr(['', 'x']), fr(['y', '']));
    assert.deepEqual([s.votes, s.total], [0, 0]);
    const t = findShift(fr(['a', '', 'b']), fr(['', 'a', 'b']));
    assert.deepEqual([t.total, t.votes, t.k, t.tie], [2, 1, 1, true], 'only a and b vote (two shifts of one vote each); the blank row would have been a third');
  });

  test('(−) frames of another size have no shift at all', () => {
    assert.equal(findShift(view(0), frameOf(bodyAt(0, { cols: 121 }), draftOf())), null);
    assert.equal(findShift(view(0), frameOf({ ...bodyAt(0), rows: bodyAt(0).rows.slice(1) }, draftOf())), null);
    assert.equal(findShift(null, view(0)), null);
    assert.equal(findShift(view(0), undefined), null);
  });

  test('(+) two shifts with the same votes are a tie; a clear winner is not', () => {
    const tie = findShift(fr(['a', 'b', 'c', 'd']), fr(['b', 'a', 'd', 'c']));
    assert.deepEqual([tie.votes, tie.total, tie.tie], [2, 4, true]);
    const win = findShift(fr(['a', 'b', 'c', 'd']), fr(['b', 'c', 'x', 'y']));
    assert.deepEqual([win.k, win.votes, win.tie], [-1, 2, false]);
    assert.equal(findShift(fr(['a']), fr(['b'])).tie, false, 'no votes: no tie');
  });
});

describe('createGlideArm', () => {
  test('(+) an up request and a frame that moved down 16 rows glide by 16; the arm is consumed', () => {
    const { arm } = rig();
    assert.equal(arm.arm(UP, { scrolled: false, before: view(16) }), true);
    assert.deepEqual(arm.offer(view(0)), { act: 'glide', k: 16, end: 32 });
    assert.equal(arm.offer(view(0)), null, 'one glide per arm');
  });

  test('(+) a frame that did not move is a rebase: still armed, and the next frame glides relative to the rebased one', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    assert.deepEqual(arm.offer(view(16)), { act: 'rebase' });
    assert.deepEqual(arm.offer(view(0)), { act: 'glide', k: 16, end: 32 });
  });

  test('(+) a frame that moved the wrong way (output streaming in) is a rebase, and the scroll frame then glides from it', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    assert.deepEqual(arm.offer(view(20)), { act: 'rebase' }); // the content moved up 4 rows
    assert.deepEqual(arm.offer(view(4)), { act: 'glide', k: 16, end: 32 }); // 16 from the rebased frame, not 12 from the first
  });

  test('(+) a frame whose shared rows do not agree (60 % on one shift) is a rebase, not a glide', () => {
    const { arm } = rig();
    const texts = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    const before = fr([...texts, ...Array(10).fill('')]);
    const moved = Array(30).fill('');
    texts.forEach((t, i) => { moved[i < 12 ? i + 5 : i + 9] = t; }); // 12 rows by +5, 8 rows by +9
    arm.arm(UP, { scrolled: false, before });
    assert.deepEqual(arm.offer(fr(moved)), { act: 'rebase' });
    const s = findShift(before, fr(moved));
    assert.deepEqual([s.k, s.votes, s.total], [5, 12, 20]);
  });

  test('(+) 80 % is enough: 4 of 5 agreeing rows glide; 3 agreeing rows are the least', () => {
    const rows = ['p', 'q', 'r', 's', 't'];
    const arm5 = rig().arm;
    arm5.arm(UP, { scrolled: false, before: fr([...rows, '', '', '', '']) });
    assert.equal(arm5.offer(fr(['', '', 'p', 'q', 'r', 's', '', '', 't'])).act, 'glide'); // p..s by +2, t by +4: 4 of 5
    const arm3 = rig().arm;
    arm3.arm(UP, { scrolled: false, before: fr(['p', 'q', 'r', '', '', '']) });
    assert.equal(arm3.offer(fr(['', '', 'p', 'q', 'r', ''])).act, 'glide');
    const arm2 = rig().arm;
    arm2.arm(UP, { scrolled: false, before: fr(['p', 'q', '', '', '', '']) });
    assert.equal(arm2.offer(fr(['', '', 'p', 'q', '', ''])).act, 'rebase', 'two rows are not enough');
  });

  test('(−) 700 ms after the request there is no glide; the arm is gone', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    tick(GLIDE_ARM_MS + 1);
    assert.equal(arm.offer(view(0)), null);
    assert.equal(arm.offer(view(0)), null, 'and it stays off');
  });

  test('(+) at exactly 700 ms the window is still open', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    tick(GLIDE_ARM_MS);
    assert.equal(arm.offer(view(0)).act, 'glide');
  });

  test('(+) the route\'s answer renews the window by 700 ms', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    tick(600);
    arm.extend();
    tick(600); // 1200 ms after the send, 600 after the answer
    assert.equal(arm.offer(view(0)).act, 'glide');
  });

  test('(−) an answer after the window is over renews nothing', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    tick(GLIDE_ARM_MS + 1);
    arm.extend();
    assert.equal(arm.offer(view(0)), null);
    const idle = rig().arm;
    idle.extend(); // nothing armed: nothing happens
    assert.equal(idle.offer(view(0)), null);
  });

  test('(−) a rebase does not renew the window', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    tick(600);
    assert.equal(arm.offer(view(16)).act, 'rebase');
    tick(200);
    assert.equal(arm.offer(view(0)), null);
  });

  test('(−) down while Claude\'s view is at the bottom is not armed: nothing moves there', () => {
    for (const scrolled of [false, undefined, null, 'yes']) {
      const { arm } = rig();
      assert.equal(arm.arm(DOWN, { scrolled, before: view(0) }), false, String(scrolled));
      assert.equal(arm.offer(view(16)), null);
    }
    const bottom = rig().arm;
    assert.equal(bottom.arm({ to: 'bottom' }, { scrolled: false, before: view(0) }), false);
  });

  test('(+) down while scrolled up is armed: the content moves up, k is negative', () => {
    const { arm } = rig();
    assert.equal(arm.arm(DOWN, { scrolled: true, before: view(0) }), true);
    assert.deepEqual(arm.offer(view(16)), { act: 'glide', k: -16, end: 32 });
  });

  test('(−) a down request clears an up request that was still armed when Claude is not scrolled up', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    assert.equal(arm.arm(DOWN, { scrolled: false, before: view(16) }), false);
    assert.equal(arm.offer(view(0)), null);
  });

  test('(−) the wrong direction never glides: an up request with a frame that moved up', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(0) });
    assert.deepEqual(arm.offer(view(16)), { act: 'rebase' });
    const down = rig().arm;
    down.arm(DOWN, { scrolled: true, before: view(16) });
    assert.deepEqual(down.offer(view(0)), { act: 'rebase' }, 'a down request with a frame that moved down');
  });

  test('(+) several pages with no shared rows slide half the conversation in the request\'s direction (rounded up)', () => {
    const odd = (n, tag) => fr(Array.from({ length: n }, (_, i) => `${tag} ${i}`), { end: n });
    const up = rig().arm;
    up.arm({ dir: 'up', pages: 3 }, { scrolled: false, before: odd(33, 'old') });
    assert.deepEqual(up.offer(odd(33, 'new')), { act: 'glide', k: 17, end: 33 });
    const down = rig().arm;
    down.arm({ dir: 'down', pages: 2 }, { scrolled: true, before: odd(33, 'old') });
    assert.deepEqual(down.offer(odd(33, 'new')), { act: 'glide', k: -17, end: 33 });
  });

  test('(+) a jump to the top or the bottom with no shared rows slides half the conversation too', () => {
    const odd = (n, tag) => fr(Array.from({ length: n }, (_, i) => `${tag} ${i}`), { end: n });
    const bottom = rig().arm;
    bottom.arm({ to: 'bottom' }, { scrolled: true, before: odd(32, 'old') });
    assert.deepEqual(bottom.offer(odd(32, 'new')), { act: 'glide', k: -16, end: 32 });
    const top = rig().arm;
    top.arm({ to: 'top' }, { scrolled: false, before: odd(32, 'old') });
    assert.deepEqual(top.offer(odd(32, 'new')), { act: 'glide', k: 16, end: 32 });
  });

  test('(+) a jump near its goal shares rows: the exact shift, not the half-view slide', () => {
    const { arm } = rig();
    arm.arm({ to: 'top' }, { scrolled: false, before: view(10) });
    assert.deepEqual(arm.offer(view(0)), { act: 'glide', k: 10, end: 32 });
  });

  test('(−) one page with no shared rows is not a scroll result: no far slide, a rebase', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: fr(['a', 'b', 'c', 'd'], { end: 4 }) });
    assert.deepEqual(arm.offer(fr(['w', 'x', 'y', 'z'], { end: 4 })), { act: 'rebase' });
  });

  test('(−) a far request with a conversation that did not change is a rebase; one row changed in a sparse frame is a far slide', () => {
    const sparse = fr(['a', 'b', '', '', '', '', '', '']);
    const same = rig().arm;
    same.arm({ dir: 'up', pages: 2 }, { scrolled: false, before: sparse });
    assert.deepEqual(same.offer(fr(['a', 'b', '', '', '', '', '', ''])), { act: 'rebase' });
    const changed = rig().arm;
    changed.arm({ dir: 'up', pages: 2 }, { scrolled: false, before: sparse });
    assert.deepEqual(changed.offer(fr(['a', 'c', '', '', '', '', '', ''])), { act: 'glide', k: 4, end: 8 });
  });

  test('(−) a far request does not slide a frame that shares rows but is no clean shift: it did not move, moved the wrong way, or is mixed', () => {
    const none = rig().arm;
    none.arm({ dir: 'up', pages: 3 }, { scrolled: false, before: view(16) });
    const same = view(16);
    same.texts[3] = 'a spinner turns';
    assert.deepEqual(none.offer(same), { act: 'rebase' }, 'did not move');
    const wrong = rig().arm;
    wrong.arm({ to: 'top' }, { scrolled: false, before: view(16) });
    assert.deepEqual(wrong.offer(view(20)), { act: 'rebase' }, 'moved the wrong way');
  });

  test('(+) a far slide is used up: the next frame is not offered a second slide', () => {
    const odd = (n, tag) => fr(Array.from({ length: n }, (_, i) => `${tag} ${i}`), { end: n });
    const { arm } = rig();
    arm.arm({ to: 'top' }, { scrolled: false, before: odd(32, 'old') });
    assert.equal(arm.offer(odd(32, 'new')).act, 'glide');
    assert.equal(arm.offer(odd(32, 'newer')), null);
    assert.equal(arm.armed(), false);
  });

  test('(−) a far request whose conversation vanished (the box moved to the top) is a rebase, never a slide of zero rows', () => {
    const { arm } = rig();
    arm.arm({ dir: 'up', pages: 2 }, { scrolled: false, before: fr(['a', 'b', 'c'], { rows: 3 }) });
    assert.deepEqual(arm.offer(fr([], { end: 0, rows: 3 })), { act: 'rebase' });
  });

  test('(−) a far request with an empty conversation never slides', () => {
    const { arm } = rig();
    arm.arm({ to: 'top' }, { scrolled: false, before: fr([], { end: 0 }) });
    assert.deepEqual(arm.offer(fr([], { end: 0 })), { act: 'rebase' });
  });

  test('(+) a second request in the same direction keeps the older base: the shifts add up', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(20) });
    tick(100);
    arm.arm(UP, { scrolled: false, before: view(10) });
    assert.deepEqual(arm.offer(view(0)), { act: 'glide', k: 20, end: 32 });
  });

  test('(+) a second request in the same direction renews the window and makes the arm far if it is', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(100) });
    tick(600);
    arm.arm({ dir: 'up', pages: 4 }, { scrolled: false, before: view(100) });
    tick(600);
    assert.deepEqual(arm.offer(view(0)), { act: 'glide', k: 16, end: 32 }, 'still armed, and the far slide applies');
  });

  // ---- the flick: a request merged into the arm before its frame was drawn keeps the arm for the next frame ----
  test('(+) two requests before frame 1 (a flick): both frames glide, the second relative to the first, then the arm ends', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.arm(UP, { scrolled: false, before: view(40) }); // request 2 goes out before frame 1 is drawn: the drawn frame is still the old one
    assert.deepEqual(arm.offer(view(24)), { act: 'glide', k: 16, end: 32 });
    assert.equal(arm.armed(), true, 'the second request still waits for its frame');
    assert.deepEqual(arm.offer(view(8)), { act: 'glide', k: 16, end: 32 }, 'from frame 1, not from the first base (that would be 32)');
    assert.equal(arm.armed(), false);
    assert.equal(arm.offer(view(8)), null);
  });

  test('(+) a single request still uses up the arm; the count never goes below zero and never leaks into the next request', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(48) });
    assert.equal(arm.offer(view(32)).act, 'glide');
    assert.equal(arm.armed(), false, 'one request, one glide');
    arm.arm(UP, { scrolled: false, before: view(32) });
    assert.equal(arm.offer(view(16)).act, 'glide');
    assert.equal(arm.armed(), false, 'a later single request is single too');
    assert.equal(arm.offer(view(0)), null);
  });

  test('(+) three merged requests: three glides, a frame that did not move in between uses none of them, and the arm ends after the last', () => {
    const { arm } = rig();
    for (let i = 0; i < 3; i += 1) arm.arm(UP, { scrolled: false, before: view(48) });
    assert.equal(arm.offer(view(32)).act, 'glide');
    assert.deepEqual(arm.offer(view(32)), { act: 'rebase' }, 'a spinner tick: nothing moved');
    assert.equal(arm.offer(view(16)).act, 'glide');
    assert.equal(arm.armed(), true);
    assert.equal(arm.offer(view(0)).act, 'glide');
    assert.equal(arm.armed(), false, 'after the last');
    assert.equal(arm.offer(view(0)), null);
  });

  test('(+) a glide that leaves a request waiting renews the window; the waiting request has its own 700 ms', () => {
    const { arm, tick } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.arm(UP, { scrolled: false, before: view(40) });
    tick(600);
    assert.equal(arm.offer(view(24)).act, 'glide');
    tick(600); // 1200 ms after the sends: past the first window, inside the renewed one
    assert.equal(arm.offer(view(8)).act, 'glide');
    const late = rig();
    late.arm.arm(UP, { scrolled: false, before: view(40) });
    late.arm.arm(UP, { scrolled: false, before: view(40) });
    late.arm.offer(view(24));
    late.tick(GLIDE_ARM_MS + 1);
    assert.equal(late.arm.offer(view(8)), null, 'and it ends after its own window');
  });

  test('(+) a far slide that leaves a request waiting keeps the arm too', () => {
    const odd = (n, tag) => fr(Array.from({ length: n }, (_, i) => `${tag} ${i}`), { end: n });
    const { arm } = rig();
    arm.arm({ to: 'top' }, { scrolled: false, before: odd(32, 'old') });
    arm.arm({ dir: 'up', pages: 3 }, { scrolled: false, before: odd(32, 'old') });
    assert.deepEqual(arm.offer(odd(32, 'new')), { act: 'glide', k: 16, end: 32 });
    assert.equal(arm.armed(), true);
    assert.deepEqual(arm.offer(odd(32, 'newer')), { act: 'glide', k: 16, end: 32 });
    assert.equal(arm.armed(), false);
  });

  test('(−) a request in the other direction does not merge: it starts its own arm with nothing waiting', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.arm(UP, { scrolled: false, before: view(40) }); // one request waiting
    assert.equal(arm.arm(DOWN, { scrolled: true, before: view(10) }), true);
    assert.deepEqual(arm.offer(view(26)), { act: 'glide', k: -16, end: 32 });
    assert.equal(arm.armed(), false, 'the waiting count of the up arm did not follow');
  });

  test('(−) a request that does not arm (not a scroll, or Claude at the bottom) merges nothing', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    assert.equal(arm.arm({}, { scrolled: true, before: view(40) }), false);
    assert.equal(arm.offer(view(24)).act, 'glide');
    assert.equal(arm.armed(), false, 'still one request');
  });

  // ---- review RV17 I1: a refused or lost request leaves no arm for a frame it did not cause ----
  test('(+) drop with no request waiting ends the arm: a prompt or any frame after a refused request never glides', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.drop();
    assert.equal(arm.armed(), false);
    assert.equal(arm.offer(view(24)), null);
    const far = rig();
    far.arm.arm({ to: 'bottom' }, { scrolled: true, before: fr(['a', 'b', 'c', 'd'], { end: 4 }) });
    far.arm.drop();
    assert.equal(far.arm.offer(fr(['p', 'q', 'r', 's'], { end: 4 })), null, 'a frame with no shared rows is no far slide either');
  });

  test('(+) drop on the second of two merged requests gives up that one only: the first frame still glides, then the arm ends', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.drop();
    assert.equal(arm.armed(), true, 'the first request is still waiting for its frame');
    assert.deepEqual(arm.offer(view(24)), { act: 'glide', k: 16, end: 32 });
    assert.equal(arm.armed(), false, 'and nothing is left over for the next frame');
    assert.equal(arm.offer(view(8)), null);
  });

  test('(+) drop twice for two merged requests ends the arm; a third drop does nothing', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.drop();
    arm.drop();
    assert.equal(arm.armed(), false);
    assert.doesNotThrow(() => arm.drop());
    assert.equal(arm.offer(view(24)), null);
  });

  test('(−) drop with no arm, and drop on an arm that ran out, throw nothing and leave nothing armed', () => {
    const { arm, tick } = rig();
    assert.doesNotThrow(() => arm.drop());
    assert.equal(arm.armed(), false);
    arm.arm(UP, { scrolled: false, before: view(40) });
    arm.arm(UP, { scrolled: false, before: view(40) });
    tick(GLIDE_ARM_MS + 1);
    arm.drop(); // the window is over: the merged count does not keep a dead arm
    assert.equal(arm.armed(), false);
    assert.equal(arm.offer(view(24)), null);
  });

  test('(−) the review\'s near case: a refused PgDn, then a prompt that pushes the conversation up 3 rows, is not a glide', () => {
    const { arm } = rig();
    arm.arm(DOWN, { scrolled: true, before: view(10) });
    arm.drop();
    assert.equal(arm.offer(fr(view(10).texts.slice(3).concat(['x', 'y', 'z']), { cols: 120, rows: 36, end: 32 })), null);
  });

  // ---- review RV17 I2: a down arm ends on a frame that shows Claude's view at its bottom ----
  const atBottom = (f) => ({ ...f, bottom: true });

  test('(+) PgDn to the bottom glides once (the frame that reaches the bottom is the scroll), and the arm is over', () => {
    const { arm } = rig();
    arm.arm(DOWN, { scrolled: true, before: view(10) });
    assert.deepEqual(arm.offer(atBottom(view(26))), { act: 'glide', k: -16, end: 32 });
    assert.equal(arm.armed(), false);
  });

  test('(−) the next frame, output streaming in at the bottom (content up 3 rows), is not a glide', () => {
    const { arm } = rig();
    arm.arm(DOWN, { scrolled: true, before: view(10) });
    arm.arm(DOWN, { scrolled: true, before: view(10) }); // a flick: two requests, so the arm outlives the first glide (round 1)
    assert.equal(arm.offer(atBottom(view(26))).act, 'glide');
    assert.equal(arm.armed(), false, 'at the bottom the second request has nothing left to move');
    assert.equal(arm.offer(atBottom(view(29))), null, 'streaming');
  });

  test('(−) both pages in one frame that shares one row (a rebase) at the bottom: the arm is over, the next streaming frame is not a glide', () => {
    const { arm } = rig();
    const base = fr(Array.from({ length: 33 }, (_, i) => `row ${i}`), { end: 33 });
    arm.arm(DOWN, { scrolled: true, before: base });
    arm.arm(DOWN, { scrolled: true, before: base });
    const both = atBottom(fr(['row 32', ...Array.from({ length: 32 }, (_, i) => `new ${i}`)], { end: 33 }));
    assert.deepEqual(arm.offer(both), { act: 'rebase' });
    assert.equal(arm.armed(), false);
    const stream = atBottom(fr([...both.texts.slice(3), 'out 1', 'out 2', 'out 3'], { end: 33 }));
    assert.equal(arm.offer(stream), null);
  });

  test('(+) a down arm stays through a rebase while the frame does not say bottom (still scrolled up)', () => {
    const { arm } = rig();
    arm.arm(DOWN, { scrolled: true, before: view(10) });
    assert.deepEqual(arm.offer(view(10)), { act: 'rebase' });
    assert.equal(arm.armed(), true);
    assert.equal(arm.offer(view(26)).act, 'glide');
  });

  test('(−) a frame that does not say where Claude\'s view is (no bottom flag) never ends a down arm', () => {
    const { arm } = rig();
    const base = fr(Array.from({ length: 33 }, (_, i) => `row ${i}`), { end: 33 });
    arm.arm(DOWN, { scrolled: true, before: base });
    assert.equal('bottom' in base, false);
    assert.deepEqual(arm.offer(fr(base.texts.slice(), { end: 33 })), { act: 'rebase' });
    assert.equal(arm.armed(), true);
    assert.deepEqual(arm.offer({ ...fr(base.texts.slice(), { end: 33 }), bottom: null }), { act: 'rebase' });
    assert.equal(arm.armed(), true, 'null is not a bottom either');
  });

  test('(+) an up arm is unaffected by a frame that says bottom: it rebases and stays', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(40) });
    assert.deepEqual(arm.offer(atBottom(view(40))), { act: 'rebase' });
    assert.equal(arm.armed(), true);
    assert.equal(arm.offer(view(24)).act, 'glide');
  });

  // ---- review RV17 M1: a down request at the bottom moves nothing, so it must not clear a live down arm ----
  test('(+) a down request at the bottom keeps a live down arm: frame 1, the real scroll, still glides', () => {
    const { arm } = rig();
    assert.equal(arm.arm(DOWN, { scrolled: true, before: view(10) }), true);
    assert.equal(arm.arm(DOWN, { scrolled: false, before: view(10) }), false, 'the second request, sent after the first answer said bottom, arms nothing');
    assert.equal(arm.armed(), true);
    assert.deepEqual(arm.offer(view(26)), { act: 'glide', k: -16, end: 32 });
    assert.equal(arm.armed(), false, 'and it did not merge: one request, one glide');
  });

  test('(−) a down request at the bottom with no arm arms nothing, and an up arm is still cleared by it', () => {
    const { arm } = rig();
    assert.equal(arm.arm(DOWN, { scrolled: false, before: view(10) }), false);
    assert.equal(arm.armed(), false);
    arm.arm(UP, { scrolled: false, before: view(40) });
    assert.equal(arm.arm(DOWN, { scrolled: false, before: view(40) }), false);
    assert.equal(arm.armed(), false, 'the up arm is over');
  });

  test('(+) a request in the other direction arms again with the new base', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(20) });
    assert.equal(arm.arm(DOWN, { scrolled: true, before: view(10) }), true);
    assert.deepEqual(arm.offer(view(20)), { act: 'glide', k: -10, end: 32 });
  });

  test('(+) disarm() (a key, Send, a resize, a gone pane) ends it', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    arm.disarm();
    assert.equal(arm.offer(view(0)), null);
  });

  test('(−) a frame of another size is never a glide, and ends the arm', () => {
    const { arm } = rig();
    arm.arm(UP, { scrolled: false, before: view(16) });
    assert.equal(arm.offer(frameOf(bodyAt(0, { cols: 100 }), draftOf())), null);
    assert.equal(arm.offer(view(0)), null, 'disarmed');
    const rows = rig().arm;
    rows.arm({ to: 'top' }, { scrolled: false, before: view(16) });
    assert.equal(rows.offer({ ...view(0), rows: 40 }), null, 'a far jump does not slide a resized pane either');
  });

  test('(−) a body that is not a scroll request, or no frame to start from, is not armed', () => {
    for (const req of [{}, null, undefined, { dir: 'sideways' }, { to: 'middle' }, { pages: 3 }]) {
      const { arm } = rig();
      assert.equal(arm.arm(req, { scrolled: true, before: view(16) }), false, JSON.stringify(req));
      assert.equal(arm.offer(view(0)), null);
    }
    const none = rig().arm;
    assert.equal(none.arm(UP, { scrolled: false, before: null }), false);
    assert.equal(none.arm(UP), false);
    assert.equal(none.offer(view(0)), null);
  });

  test('(+) armed() is true only inside the window of an arm: not before it, not after 700 ms, a disarm or a glide; a rebase and extend() keep it', () => {
    const { arm, tick } = rig();
    assert.equal(arm.armed(), false, 'nothing armed yet');
    arm.arm(UP, { scrolled: false, before: view(16) });
    assert.equal(arm.armed(), true);
    tick(GLIDE_ARM_MS);
    assert.equal(arm.armed(), true, 'the edge of the window');
    tick(1);
    assert.equal(arm.armed(), false, 'the window is over');
    arm.arm(UP, { scrolled: false, before: view(16) });
    arm.offer(view(16)); // a rebase
    assert.equal(arm.armed(), true);
    arm.disarm();
    assert.equal(arm.armed(), false);
    arm.arm(UP, { scrolled: false, before: view(16) });
    arm.offer(view(0)); // a glide consumes it
    assert.equal(arm.armed(), false);
    assert.equal(rig().arm.arm({}, { before: view(0) }) || rig().arm.armed(), false, 'a body that is no scroll request arms nothing');
  });

  test('(−) an arm that was never made offers nothing', () => {
    assert.equal(rig().arm.offer(view(0)), null);
  });
});

describe('glideFrom', () => {
  test('(+) the slide starts k rows back: minus k times the row height', () => {
    assert.equal(glideFrom({ k: 16, rowPx: 18, maxPx: 1000 }), -288);
    assert.equal(glideFrom({ k: -16, rowPx: 18, maxPx: 1000 }), 288);
  });

  test('(+) a slide that is still running adds its offset', () => {
    assert.equal(glideFrom({ k: 16, rowPx: 18, current: -100, maxPx: 1000 }), -388);
    assert.equal(glideFrom({ k: -16, rowPx: 18, current: 50, maxPx: 1000 }), 338);
  });

  test('(+) it never starts more than one region away, in either direction', () => {
    assert.equal(glideFrom({ k: 16, rowPx: 18, current: -400, maxPx: 500 }), -500);
    assert.equal(glideFrom({ k: -16, rowPx: 18, current: 400, maxPx: 500 }), 500);
    assert.equal(glideFrom({ k: 16, rowPx: 18, current: 0, maxPx: 288 }), -288, 'the edge itself is allowed');
  });

  test('(−) anything that is not a finite number, or no region, is no slide (0)', () => {
    assert.equal(glideFrom({ k: NaN, rowPx: 18, maxPx: 500 }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: Infinity, maxPx: 500 }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: 18, current: NaN, maxPx: 500 }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: 18, current: -Infinity, maxPx: 500 }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: 18, maxPx: NaN }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: 18, maxPx: Infinity }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: 18, maxPx: 0 }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: 18, maxPx: -5 }), 0);
    assert.equal(glideFrom({ k: 16, rowPx: 18 }), 0);
  });
});

describe('matrixY', () => {
  test('(+) none is no offset; a 2D matrix is its ty; a 3D matrix is its 14th value', () => {
    assert.equal(matrixY('none'), 0);
    assert.equal(matrixY('matrix(1, 0, 0, 1, 0, -12.5)'), -12.5);
    assert.equal(matrixY('  matrix(1,0,0,1,3,40)  '), 40);
    assert.equal(matrixY('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -7, 0, 1)'), -7);
  });

  test('(−) garbage, a number, nothing, or a matrix with no usable value is 0', () => {
    for (const t of ['', 'abc', 'translateY(5px)', 'matrix(1,0,0,1,0)', 'matrix(1,0,0,1,0,NaN)', 'matrix(1,0,0,1,0,Infinity)', 'matrix3d(1,2)', 'matrix(1,0,0,1,0,5) x', 5, null, undefined, {}]) {
      assert.equal(matrixY(t), 0, String(t));
    }
  });
});

describe('the module itself', () => {
  test('(+) ASCII only: every symbol is an escape', () => {
    assert.equal([...SRC].every((ch) => ch.codePointAt(0) < 128), true);
  });

  test('(−) no DOM, request, storage, style read or timer of its own', () => {
    const c = code(SRC);
    assert.doesNotMatch(c, /\b(document|window|navigator|location|localStorage|sessionStorage|getComputedStyle|fetch|setTimeout|setInterval|clearTimeout|XMLHttpRequest)\b/);
    assert.doesNotMatch(c, /\/api\//);
  });

  test('(+) it imports only from scroll.js (rowText, viewRowsOf)', () => {
    assert.deepEqual([...SRC.matchAll(/^import \{([^}]+)\} from '([^']+)'/gm)].map((m) => [m[2], m[1].split(',').map((x) => x.trim())]), [['./scroll.js', ['rowText', 'viewRowsOf']]]);
  });
});

describe('paneWriteDisarms', () => {
  const P = (tail) => `/api/app/pane/%2512/${tail}`;
  test('(+) every write to a pane ends a pending glide, but the scroll, the capture and the fit heartbeat', () => {
    for (const tail of ['keys', 'submit', 'command', 'attach-send', 'answer', 'dialog', 'survey', 'stop', 'end', 'mode', 'draft', 'suggestion', 'attachments', 'attachments/abc123']) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(paneWriteDisarms(P(tail), method), true, `${method} ${tail}`);
    }
  });

  test('(−) the scroll, the capture and the fit heartbeat keep it, whatever the method', () => {
    for (const tail of ['scroll', 'capture', 'fit']) {
      for (const method of ['POST', 'PUT', 'DELETE', 'GET', undefined]) assert.equal(paneWriteDisarms(P(tail), method), false, `${method} ${tail}`);
    }
    assert.equal(paneWriteDisarms(`${P('fit')}?x=1`, 'POST'), false, 'a query string is not part of the route');
  });

  test('(+) a route added later disarms by default (only the three above are exempt)', () => {
    assert.equal(paneWriteDisarms(P('brand-new-thing'), 'POST'), true);
    assert.equal(paneWriteDisarms(P('scrollx'), 'POST'), true, 'a longer name is another route');
    assert.equal(paneWriteDisarms(P('capture2'), 'PUT'), true);
    assert.equal(paneWriteDisarms(P(''), 'POST'), true, 'a trailing slash with no name');
    assert.equal(paneWriteDisarms('/api/app/pane/%2512', 'DELETE'), true, 'the pane itself');
    assert.equal(paneWriteDisarms(P('Scroll'), 'POST'), true, 'case matters');
    assert.equal(paneWriteDisarms(P('keys'), 'post'), true, 'a lower-case method is a write too');
    assert.equal(paneWriteDisarms(P('keys'), 'Put'), true);
  });

  test('(−) a read never disarms, nor does a request that is not for a pane', () => {
    for (const tail of ['keys', 'state', 'command', 'history']) {
      assert.equal(paneWriteDisarms(P(tail), 'GET'), false, tail);
      assert.equal(paneWriteDisarms(P(tail), 'HEAD'), false, tail);
      assert.equal(paneWriteDisarms(P(tail)), false, `${tail}: no method is a GET`);
    }
    assert.equal(paneWriteDisarms('/api/app/settings', 'PUT'), false);
    assert.equal(paneWriteDisarms('/api/app/projects', 'POST'), false);
    assert.equal(paneWriteDisarms('/api/app/session/abc/history', 'POST'), false);
    assert.equal(paneWriteDisarms('/api/app/panel/x/keys', 'POST'), false, 'a look-alike prefix');
    assert.equal(paneWriteDisarms('/pane/%2512/keys', 'POST'), false);
    assert.equal(paneWriteDisarms('/other/api/app/pane/%2512/keys', 'POST'), false, 'the route starts the path');
    assert.equal(paneWriteDisarms('https://example.test/api/app/pane/%2512/keys', 'POST'), false);
    assert.equal(paneWriteDisarms(P('keys'), 'get'), false, 'a lower-case read is a read');
    assert.equal(paneWriteDisarms(P('keys'), 'head'), false);
  });

  test('(−) anything that is not a path string never disarms and never throws', () => {
    for (const bad of [undefined, null, 5, {}, [], () => {}]) assert.doesNotThrow(() => assert.equal(paneWriteDisarms(bad, 'POST'), false));
    for (const method of [null, 5, {}]) assert.doesNotThrow(() => assert.equal(paneWriteDisarms(P('keys'), method), false, `method ${String(method)} is read as GET`));
  });
});
