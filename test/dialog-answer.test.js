// answerDialog (nika 0.5, W1-T2, design W1 section 4): the route that answers Claude's question and plan dialogs, one step per request.
// The real step machine runs against test/dialog-fake.js (a fake screen that changes the way Claude does after each key). Every "never
// sent" case asserts on the fake's key log; `safe(w)` asserts, after most cases, what must never go out. Synthetic text only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkDialogBody } from '../src/session-control.js';
import { STEPS_MAX, TEXT_MAX } from '../src/dialog.js';
import { dialogWorld, TAB } from './dialog-fake.js';
import { span } from './helpers.js';

const SIG = '0123456789abcdef';
const PLAIN = { vim: false, plain: true }; // nika's memory of a pane whose input is not vim: it may type when it starts on the text row
const code = (r) => [r.status, r.body.error];
const ok = (r, done, sent) => assert.deepEqual(r, { status: 200, body: { done, sent } });
const words = (n) => Array.from({ length: n }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).join(' ');

/** What must never go out, whatever the case (design 4.4): asserted on the key log. `escape`: the case is a Decline. */
function safe(w, { escape = false } = {}) {
  assert.deepEqual(w.leaks(), [], 'no key after the dialog closed, none toward an input box or a permission prompt');
  for (const e of w.log.filter((x) => !x.failed)) {
    assert.equal(e.paste, undefined, 'no paste');
    assert.ok(!(e.keys && e.text !== undefined), 'one thing per request');
    assert.ok(e.keys === undefined || e.keys.length === 1, 'one key per request');
    for (const k of e.keys ?? []) {
      assert.ok(['Down', 'Right', 'Enter', 'Escape'].includes(k), `never ${k}`);
      if (k === 'Escape') assert.ok(escape, 'Escape only for Decline');
      if (k === 'Right') assert.equal(e.slot, 'option', 'Right only from an option row');
      if (k === 'Enter') assert.ok(['text', 'button', 'review1'].includes(e.slot), `Enter never on ${e.slot}`);
    }
    assert.notEqual(e.slot, 'chat', 'nothing on the chat row');
    if (typeof e.text === 'string') {
      assert.ok(e.text.length <= TEXT_MAX, 'text within TEXT_MAX');
      if (/^[1-9]$/.test(e.text)) assert.ok(['option', 'plan-option'].includes(e.slot), `a digit never on ${e.slot}`);
      else assert.equal(e.slot, 'text', 'free text only on the text row');
    }
  }
}

describe('checkDialogBody', () => {
  test('(+) the four shapes: answer, submit, choice, decline', () => {
    const good = [
      { sig: SIG, picks: [1] }, { sig: SIG, picks: [] , text: 'x' }, { sig: SIG, picks: [1, 2, 3, 4, 5, 6, 7] }, { sig: SIG, picks: [3, 1], text: 'my custom check' },
      { sig: SIG, picks: [], text: 'x'.repeat(TEXT_MAX) }, { sig: SIG, picks: [], text: 'café → ok  inner  spaces' }, { sig: SIG, submit: true },
      { sig: SIG, picks: [], text: 'apples 2' }, { sig: SIG, picks: [], text: 'a1' }, { sig: SIG, picks: [], text: '0 apples' }, { sig: SIG, picks: [], text: '\uff12 apples' },
      { sig: SIG, choice: 1 }, { sig: SIG, choice: 9 }, { sig: SIG, cancel: true },
    ];
    for (const b of good) assert.equal(checkDialogBody(b), null, JSON.stringify(b));
  });

  test('(−) anything else is 400 invalid: key sets, sig, picks, text, submit, choice, cancel, non-objects, __proto__', () => {
    const bad = [
      {}, { sig: SIG }, { picks: [1] }, { sig: 'ABCDEF0123456789', picks: [1] }, { sig: SIG.slice(1), picks: [1] }, { sig: SIG + '0', picks: [1] }, { sig: 5, picks: [1] },
      { sig: SIG, picks: [1], base: '' }, { sig: SIG, picks: [1], submit: true }, { sig: SIG, submit: true, cancel: true }, { sig: SIG, submit: true, choice: 1 },
      { sig: SIG, picks: [1, 2, 3, 4, 5, 6, 7, 1] }, { sig: SIG, picks: [1, 1] }, { sig: SIG, picks: [0] }, { sig: SIG, picks: [8] }, { sig: SIG, picks: [1.5] },
      { sig: SIG, picks: ['1'] }, { sig: SIG, picks: 1 }, { sig: SIG, picks: null }, { sig: SIG, picks: [null] }, { sig: SIG, picks: new Array(2) },
      { sig: SIG, picks: [1], text: '' }, { sig: SIG, picks: [1], text: 5 }, { sig: SIG, picks: [], text: 'x'.repeat(TEXT_MAX + 1) },
      { sig: SIG, picks: [], text: 'a\nb' }, { sig: SIG, picks: [], text: 'a\tb' }, { sig: SIG, picks: [], text: 'a\u0000b' }, { sig: SIG, picks: [], text: 'a\u007fb' },
      { sig: SIG, picks: [], text: 'a\u0085b' }, { sig: SIG, picks: [], text: 'a\u001b[2mb' }, { sig: SIG, picks: [], text: 'a\u200bb' }, { sig: SIG, picks: [], text: 'a\u202eb' },
      { sig: SIG, picks: [], text: '2' }, { sig: SIG, picks: [], text: '2 apples' }, { sig: SIG, picks: [], text: '1' }, { sig: SIG, picks: [], text: '9x' }, { sig: SIG, picks: [3], text: '7 up' },
      { sig: SIG, picks: [], text: ' a' }, { sig: SIG, picks: [], text: 'a ' }, { sig: SIG, picks: [], text: 'a\ud800' }, { sig: SIG, picks: [], text: ' ' },
      { sig: SIG, submit: false }, { sig: SIG, submit: 1 }, { sig: SIG, choice: 0 }, { sig: SIG, choice: 10 }, { sig: SIG, choice: 1.5 }, { sig: SIG, choice: '1' },
      { sig: SIG, cancel: false }, { sig: SIG, cancel: 'yes' },
      JSON.parse(`{"__proto__":{"x":1},"sig":"${SIG}","picks":[1]}`), null, undefined, [], 'sig', 7,
    ];
    for (const b of bad) {
      const r = checkDialogBody(b);
      assert.deepEqual([r?.status, r?.body.error], [400, 'invalid'], JSON.stringify(b));
    }
  });
});

describe('checkDialogBody: the step move (0.5.1, D)', () => {
  test('(+) { sig, tab } with a whole number from 0 to 8', () => {
    for (const tab of [0, 1, 3, 8]) assert.equal(checkDialogBody({ sig: SIG, tab }), null, String(tab));
  });

  test('(−) a tab that is not a whole number from 0 to 8, or any extra or missing key: 400 invalid', () => {
    const bad = [
      { sig: SIG, tab: -1 }, { sig: SIG, tab: 9 }, { sig: SIG, tab: 1.5 }, { sig: SIG, tab: '1' }, { sig: SIG, tab: null }, { sig: SIG, tab: NaN }, { sig: SIG, tab: [1] },
      { sig: SIG, tab: 1, picks: [1] }, { sig: SIG, tab: 1, submit: true }, { sig: SIG, tab: 1, choice: 1 }, { sig: SIG, tab: 1, cancel: true }, { sig: SIG, tab: 1, text: 'x' },
      { tab: 1 }, { sig: 'ABCDEF0123456789', tab: 1 }, { sig: 5, tab: 1 }, { sig: SIG },
    ];
    for (const b of bad) assert.deepEqual([checkDialogBody(b)?.status, checkDialogBody(b)?.body.error], [400, 'invalid'], JSON.stringify(b));
  });
});

describe('answerDialog: a single-select question', () => {
  test('(+) a one-question form: the digit submits it (done submitted, one key)', async () => {
    const w = dialogWorld();
    ok(await w.answer({ picks: [2] }), 'submitted', 1);
    assert.deepEqual(w.keysLog(), ['text:2']);
    assert.equal(w.tabs[0].picked, 2);
    assert.equal(w.phase, 'idle');
    safe(w);
  });

  test('(+) a 4-question form: the pick on tab 1 moves to tab 2 (done next), tab 1 answered; the pick on the last tab opens the review', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode, TAB.name, TAB.mode] });
    ok(await w.answer({ picks: [3] }), 'next', 1);
    assert.deepEqual([w.i, w.tabs[0].answered, w.phase, w.read().i], [1, true, 'ask', 1]);
    ok(await w.answer({ picks: [1] }), 'next', 1);
    ok(await w.answer({ picks: [2] }), 'next', 1);
    ok(await w.answer({ picks: [2] }), 'review', 1);
    assert.equal(w.phase, 'review');
    assert.deepEqual(w.keysLog(), ['text:3', 'text:1', 'text:2', 'text:2']);
    safe(w);
  });

  test('(+) Other: Down to the text row (k + 1 - f times), the text with one send-keys -l, then Enter', async () => {
    const w = dialogWorld();
    ok(await w.answer({ picks: [], text: 'my custom project' }), 'submitted', 5);
    assert.deepEqual(w.keysLog(), ['Down', 'Down', 'Down', 'text:my custom project', 'Enter']);
    assert.equal(w.tabs[0].text, 'my custom project');
    safe(w);
    const from2 = dialogWorld({ focus: 2 });
    ok(await from2.answer({ picks: [], text: 'x y' }), 'submitted', 4);
    assert.deepEqual(from2.keysLog(), ['Down', 'Down', 'text:x y', 'Enter']);
    safe(from2);
  });

  test('(+) Other on a form with several tabs moves on (done next); vim INSERT, plain and a remembered plain pane all type', async () => {
    for (const opts of [{ vim: true }, { vim: false }, { vim: false, mem: { vim: false, plain: true } }]) {
      const w = dialogWorld({ tabs: [TAB.project, TAB.mode], ...opts });
      ok(await w.answer({ picks: [], text: 'beta' }), 'next', 5);
      assert.deepEqual(w.keysLog(), ['Down', 'Down', 'Down', 'text:beta', 'Enter'], JSON.stringify(opts));
      safe(w);
    }
  });

  test('(+) a text of TEXT_MAX words that wraps over several rows reads back and is entered', async () => {
    const text = `${words(59)} w060x`;
    assert.equal(text.length, TEXT_MAX);
    const w = dialogWorld({ vim: true, focus: 4 });
    ok(await w.answer({ picks: [], text }), 'submitted', 2);
    assert.deepEqual(w.keysLog(), [`text:${text}`, 'Enter']);
    assert.equal(w.tabs[0].text, text);
    safe(w);
  });

  test('(+) text with inner double spaces: the screen collapses them, the read-back compares collapsed text', async () => {
    const w = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await w.answer({ picks: [], text: 'two  spaces here' }), 'submitted', 2);
    safe(w);
  });

  test('(+) resumable: the focus already on the text row types and enters; the text already typed only enters; the xor needs nothing more', async () => {
    const onText = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await onText.answer({ picks: [], text: 'beta' }), 'submitted', 2);
    assert.deepEqual(onText.keysLog(), ['text:beta', 'Enter']);
    const typed = dialogWorld({ focus: 4 });
    typed.tabs[0].text = 'beta';
    ok(await typed.answer({ picks: [], text: 'beta' }), 'submitted', 1);
    assert.deepEqual(typed.keysLog(), ['Enter']);
    safe(typed);
  });

  test('(+) the sleeps: a settle wait before every read after a key, none before the first read', async () => {
    const w = dialogWorld();
    await w.answer({ picks: [1] });
    assert.deepEqual(w.slept, [150]);
  });
});

describe('answerDialog: a multi-select question', () => {
  test('(+) picks by xor: the smallest differing number first, then Right (done review on a one-question form, next on the first tab)', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    w.tabs[0].checked = [1, 2];
    ok(await w.answer({ picks: [1, 3] }), 'review', 3);
    assert.deepEqual(w.keysLog(), ['text:2', 'text:3', 'Right']);
    assert.deepEqual([w.tabs[0].checked, w.phase], [[1, 3], 'review']);
    safe(w);
    const first = dialogWorld({ tabs: [TAB.tools, TAB.project] });
    ok(await first.answer({ picks: [2] }), 'next', 2);
    assert.deepEqual(first.keysLog(), ['text:2', 'Right']);
    safe(first);
  });

  test('(+) a half-done retry finishes from the screen: only what still differs is pressed, and nothing when the set is already right', async () => {
    const half = dialogWorld({ tabs: [TAB.tools] });
    half.tabs[0].checked = [3];
    ok(await half.answer({ picks: [1, 3] }), 'review', 2);
    assert.deepEqual(half.keysLog(), ['text:1', 'Right']);
    const done = dialogWorld({ tabs: [TAB.tools] });
    done.tabs[0].checked = [1, 3];
    ok(await done.answer({ picks: [1, 3] }), 'review', 1);
    assert.deepEqual(done.keysLog(), ['Right']);
    safe(done);
  });

  test('(+) a digit toggles and the focus stays: the next toggle needs focus on an option row, which it still has', async () => {
    const w = dialogWorld({ tabs: [TAB.tools], focus: 2 });
    ok(await w.answer({ picks: [1, 2, 3] }), 'review', 4);
    assert.deepEqual(w.keysLog(), ['text:1', 'text:2', 'text:3', 'Right']);
    safe(w);
  });

  test('(+) Other on the LAST tab: toggles, Down to the text row, the text, Down to the Submit button (focus checked), Enter opens the review', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.tools], i: 1 });
    ok(await w.answer({ picks: [1], text: 'my custom check' }), 'review', 7);
    assert.deepEqual(w.keysLog(), ['text:1', 'Down', 'Down', 'Down', 'text:my custom check', 'Down', 'Enter']);
    assert.deepEqual([w.phase, w.tabs[1].checked, w.tabs[1].text], ['review', [1], 'my custom check']);
    assert.equal(w.leaks().length, 0);
    safe(w);
  });

  test('(+) Other alone (no picks) on the last tab; resumed with the text typed and the focus on the button', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    ok(await w.answer({ picks: [], text: 'my custom check' }), 'review', 6);
    assert.deepEqual(w.keysLog(), ['Down', 'Down', 'Down', 'text:my custom check', 'Down', 'Enter']);
    const resumed = dialogWorld({ tabs: [TAB.tools], focus: 'button' });
    resumed.tabs[0].text = 'my custom check';
    resumed.tabs[0].answered = true;
    ok(await resumed.answer({ picks: [], text: 'my custom check' }), 'review', 1);
    assert.deepEqual(resumed.keysLog(), ['Enter']);
    safe(resumed);
  });

  test('(−) Other on a multi question that is not the last tab: 400 invalid, nothing sent', async () => {
    const w = dialogWorld({ tabs: [TAB.tools, TAB.project] });
    assert.deepEqual(code(await w.answer({ picks: [1], text: 'x' })), [400, 'invalid']);
    assert.deepEqual(w.log, []);
  });

  test('(−) a toggle with the focus on the text row, the button or the chat row: 409 dialog-focus, nothing sent (the digit would be text)', async () => {
    for (const focus of [4, 'button', 5]) {
      const w = dialogWorld({ tabs: [TAB.tools], focus });
      assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'dialog-focus'], String(focus));
      assert.deepEqual(w.log, []);
    }
  });

  test('(−) Right needs an option row: from the text row, the button or the chat row it is 409 dialog-focus (nika never presses Up)', async () => {
    for (const focus of [4, 'button', 5]) {
      const w = dialogWorld({ tabs: [TAB.tools], focus });
      w.tabs[0].checked = [1];
      assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'dialog-focus'], String(focus));
      assert.deepEqual(w.log, []);
    }
  });

  test('(−) the Other text with the focus on the chat row: 409 dialog-focus; typed text that differs from the wanted one: 409 dialog-touched', async () => {
    const chat = dialogWorld({ tabs: [TAB.tools], focus: 5 });
    assert.deepEqual(code(await chat.answer({ picks: [], text: 'x' })), [409, 'dialog-focus']);
    assert.deepEqual(chat.log, []);
    const other = dialogWorld({ tabs: [TAB.tools], focus: 4 });
    other.tabs[0].text = 'someone typed this';
    assert.deepEqual(code(await other.answer({ picks: [], text: 'x' })), [409, 'dialog-touched']);
    assert.deepEqual(other.log, []);
  });

  test('(−) an Other text in the box while only picks are wanted: 409 dialog-touched, nothing sent', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    w.tabs[0].text = 'typed in the terminal';
    assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'dialog-touched']);
    assert.deepEqual(w.log, []);
  });
});

describe('answerDialog: the review step', () => {
  const review = (answered, extra = {}) => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.tools], phase: 'review', ...extra });
    w.tabs[0].picked = 2;
    w.tabs[0].answered = answered.includes(0);
    w.tabs[1].checked = [1];
    w.tabs[1].answered = answered.includes(1);
    return w;
  };

  test('(+) Submit on the review the user saw: one Enter on 1. Submit answers (done submitted)', async () => {
    const w = review([0, 1]);
    ok(await w.answer({ submit: true }), 'submitted', 1);
    assert.deepEqual(w.keysLog(), ['Enter']);
    assert.equal(w.result, 'submitted');
    safe(w);
  });

  // QP1: Claude Code 2.1.328 draws the Review with no `Ready to submit your answers?` row (the fake's `v328` option)
  test('(+) Submit on a 2.1.328 Review (no Ready row): one Enter on 1. Submit answers (done submitted)', async () => {
    const w = review([0, 1], { v328: true });
    assert.equal(w.read().at, 'review', 'the form is readable, so the page has a sig to post');
    ok(await w.answer({ submit: true }), 'submitted', 1);
    assert.deepEqual(w.keysLog(), ['Enter']);
    assert.equal(w.result, 'submitted');
    safe(w);
    const warned = review([0], { v328: true });
    ok(await warned.answer({ submit: true }), 'submitted', 1);
    safe(warned);
  });

  test('(\u2212) the 2.1.328 Review: the focus on 2. Cancel is 409 dialog-focus, and a question body on it is 409 dialog-changed, nothing sent', async () => {
    const w = review([0, 1], { v328: true });
    w.rf = 2;
    assert.deepEqual(code(await w.answer({ submit: true })), [409, 'dialog-focus']);
    const q = review([0, 1], { v328: true });
    assert.deepEqual(code(await q.answer({ picks: [1] })), [409, 'dialog-changed']);
    assert.deepEqual([...w.log, ...q.log], []);
  });

  // The owner's case (QP1): a 2-question dialog on 2.1.328. The answer to the last question lands on the Review; nika must see it as the Review
  // (done review), not as an unreadable screen (409 dialog-changed after 1 key).
  test('(+) a 2-question dialog on 2.1.328: answer 1 (next), answer 2 lands on the Review (done review, not dialog-changed), then Submit', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode], v328: true });
    ok(await w.answer({ picks: [2] }), 'next', 1);
    assert.deepEqual([w.i, w.phase], [1, 'ask']);
    ok(await w.answer({ picks: [1] }), 'review', 1);
    assert.equal(w.phase, 'review');
    assert.equal(w.read().at, 'review');
    ok(await w.answer({ submit: true }), 'submitted', 1);
    assert.deepEqual(w.keysLog(), ['text:2', 'text:1', 'Enter']);
    assert.equal(w.result, 'submitted');
    safe(w);
  });

  test('(+) the warning row does not block Submit (Claude allows it)', async () => {
    const w = review([0]);
    assert.equal(w.read().warn, true);
    ok(await w.answer({ submit: true }), 'submitted', 1);
    safe(w);
  });

  test('(−) the focus on 2. Cancel: 409 dialog-focus, nothing sent (Enter would cancel the whole dialog)', async () => {
    const w = review([0, 1]);
    w.rf = 2;
    assert.deepEqual(code(await w.answer({ submit: true })), [409, 'dialog-focus']);
    assert.deepEqual(w.log, []);
  });

  test('(−) a submit body on a question step, and a question body on the review: 409 dialog-changed, nothing sent', async () => {
    const q = dialogWorld();
    assert.deepEqual(code(await q.answer({ submit: true })), [409, 'dialog-changed']);
    const r = review([0, 1]);
    assert.deepEqual(code(await r.answer({ picks: [1] })), [409, 'dialog-changed']);
    assert.deepEqual([...q.log, ...r.log], []);
  });

  test('(−) the answers changed since the form was built: 409 dialog-changed', async () => {
    const w = review([0, 1]);
    const sig = w.sig();
    w.tabs[1].checked = [1, 2];
    assert.deepEqual(code(await w.answer({ submit: true, sig })), [409, 'dialog-changed']);
    assert.deepEqual(w.log, []);
  });
});

describe('answerDialog: the plan approval', () => {
  test('(+) a choice goes as its digit and nothing else (done chosen); the focus may be on another option', async () => {
    const w = dialogWorld({ phase: 'plan' });
    ok(await w.answer({ choice: 1 }), 'chosen', 1);
    assert.deepEqual(w.keysLog(), ['text:1']);
    assert.equal(w.result, 'approved 1');
    safe(w);
    const second = dialogWorld({ phase: 'plan', pf: 2 });
    ok(await second.answer({ choice: 1 }), 'chosen', 1);
    assert.equal(second.result, 'approved 1');
    const two = dialogWorld({ phase: 'plan' });
    ok(await two.answer({ choice: 2 }), 'chosen', 1);
    assert.deepEqual(two.keysLog(), ['text:2']);
  });

  test('(−) the text option ("Tell Claude what to change") is terminal-only in 0.5: 400 invalid, nothing sent', async () => {
    const w = dialogWorld({ phase: 'plan' });
    assert.deepEqual(code(await w.answer({ choice: 3 })), [400, 'invalid']);
    assert.deepEqual(w.log, []);
  });

  test('(−) a choice that is not shown: 400 invalid; the focus on the text option: 409 dialog-focus; nothing sent', async () => {
    const w = dialogWorld({ phase: 'plan' });
    assert.deepEqual(code(await w.answer({ choice: 4 })), [400, 'invalid']);
    assert.deepEqual(code(await w.answer({ choice: 9 })), [400, 'invalid']);
    const typing = dialogWorld({ phase: 'plan', pf: 3 });
    assert.deepEqual(code(await typing.answer({ choice: 1 })), [409, 'dialog-focus']);
    assert.deepEqual([...w.log, ...typing.log], []);
  });

  test('(−) an answer body on the plan, and a choice on a question step: 409 dialog-changed, nothing sent', async () => {
    const plan = dialogWorld({ phase: 'plan' });
    assert.deepEqual(code(await plan.answer({ picks: [1] })), [409, 'dialog-changed']);
    const q = dialogWorld();
    assert.deepEqual(code(await q.answer({ choice: 1 })), [409, 'dialog-changed']);
    assert.deepEqual([...plan.log, ...q.log], []);
  });

  test('(−) the plan text changed since the page read it: 409 dialog-changed', async () => {
    const w = dialogWorld({ phase: 'plan' });
    const sig = w.sig();
    w.plan.prose = ['- Delete the build folder.'];
    assert.deepEqual(code(await w.answer({ choice: 1, sig })), [409, 'dialog-changed']);
    assert.deepEqual(w.log, []);
  });

  test('(−) M3: feedback already typed in the plan\'s text option: a choice is 409 dialog-touched whatever the focus, nothing sent (a digit would lose it)', async () => {
    const feedback = (pf) => dialogWorld({ phase: 'plan', pf, plan: { labels: ['Yes, and use auto mode', 'Yes, manually approve edits'], prose: ['- Reply with the single word done.', '- Stop.'], text: 'please also add tests' } });
    for (const pf of [1, 2, 3]) {
      const w = feedback(pf);
      assert.equal(w.read().textRow.value, 'please also add tests');
      assert.deepEqual(code(await w.answer({ choice: 1 })), [409, 'dialog-touched'], `focus ${pf}`);
      assert.deepEqual(code(await w.answer({ choice: 2 })), [409, 'dialog-touched'], `focus ${pf}`);
      assert.deepEqual(w.log, [], `focus ${pf}`);
    }
  });

  test('(+) M3: the same plan with the text option empty takes a choice; a Decline is allowed with feedback typed', async () => {
    const empty = dialogWorld({ phase: 'plan', pf: 2 });
    assert.equal(empty.read().textRow.value, null);
    ok(await empty.answer({ choice: 1 }), 'chosen', 1);
    const typed = dialogWorld({ phase: 'plan', pf: 3, plan: { labels: ['Yes, and use auto mode', 'Yes, manually approve edits'], prose: ['- Stop.'], text: 'please also add tests' } });
    ok(await typed.answer({ cancel: true }), 'declined', 1);
    assert.deepEqual(typed.keysLog(), ['Escape']);
  });
});

describe('answerDialog: Decline', () => {
  test('(+) one Escape declines a question, the review and the plan (done declined)', async () => {
    for (const w of [dialogWorld(), dialogWorld({ tabs: [TAB.project, TAB.tools], i: 1 }), dialogWorld({ tabs: [TAB.project], phase: 'review' }), dialogWorld({ phase: 'plan' })]) {
      ok(await w.answer({ cancel: true }), 'declined', 1);
      assert.deepEqual(w.keysLog(), ['Escape']);
      assert.equal(w.result, 'declined');
      safe(w, { escape: true });
    }
  });

  test('(+) from vim INSERT (the text row has focus): the first Escape leaves INSERT, the second one goes only after a fresh capture shows INSERT gone, 40 ms later', async () => {
    const w = dialogWorld({ vim: true, focus: 4 });
    assert.equal(w.read().insert, true);
    ok(await w.answer({ cancel: true }), 'declined', 2);
    assert.deepEqual(w.keysLog(), ['Escape', 'Escape']);
    assert.deepEqual(w.log.map((e) => e.insert), [true, false], 'the second Escape landed with INSERT gone');
    assert.ok(w.slept.includes(40), 'VIM_ESC_GAP_MS between the two');
    safe(w, { escape: true });
  });

  test('(+) a late redraw of the INSERT marker: the second Escape waits for it to go (not a fixed gap)', async () => {
    const w = dialogWorld({ vim: true, focus: 4, lag: 2 });
    ok(await w.answer({ cancel: true }), 'declined', 2);
    assert.deepEqual(w.log.map((e) => e.insert), [true, false]);
    safe(w, { escape: true });
  });

  test('(+) vim NORMAL on the text row (no INSERT): one Escape declines', async () => {
    const w = dialogWorld({ vim: true, focus: 4, vimMode: 'normal' });
    ok(await w.answer({ cancel: true }), 'declined', 1);
    assert.deepEqual(w.keysLog(), ['Escape']);
  });

  test('(+) Decline is allowed on a dialog that mentions bypass (terminal-only does not apply to it)', async () => {
    const ask = dialogWorld({ tabs: [{ header: 'Mode', question: 'Which mode?', options: [['bypass permissions', 'Skip every check.'], ['default', 'Ask each time.']] }] });
    assert.equal(ask.read().bypass, true);
    ok(await ask.answer({ cancel: true }), 'declined', 1);
    const plan = dialogWorld({ phase: 'plan', plan: { labels: ['Yes, and use bypass permissions', 'Yes, manually approve edits'], prose: ['- Stop.'], text: null } });
    assert.equal(plan.read().bypass, true);
    ok(await plan.answer({ cancel: true }), 'declined', 1);
  });

  test('(−) the first Escape from INSERT is lost: not-taken after one key, no second Escape (at most two Escapes, the second only on proof)', async () => {
    const w = dialogWorld({ vim: true, focus: 4 });
    w.drop = (b, n) => n === 1;
    const r = await w.answer({ cancel: true });
    assert.deepEqual(r, { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Escape']);
  });

  test('(−) the second Escape does not close the dialog: 409 not-taken after exactly two Escapes, never a third', async () => {
    const w = dialogWorld({ vim: true, focus: 4 });
    w.drop = (b, n) => n === 2;
    assert.deepEqual(code(await w.answer({ cancel: true })), [409, 'not-taken']);
    assert.deepEqual(w.keysLog(), ['Escape', 'Escape']);
  });

  test('(−) a changed sig, a closed dialog, a permission prompt: nothing is sent', async () => {
    const stale = dialogWorld();
    assert.deepEqual(code(await stale.answer({ cancel: true, sig: SIG })), [409, 'dialog-changed']);
    const closed = dialogWorld({ phase: 'idle' });
    assert.deepEqual(code(await closed.ctl.answerDialog('%2', { sig: SIG, cancel: true })), [409, 'no-dialog']);
    const prompt = dialogWorld({ phase: 'prompt' });
    assert.deepEqual(code(await prompt.ctl.answerDialog('%2', { sig: SIG, cancel: true })), [409, 'no-dialog']);
    assert.deepEqual([...stale.log, ...closed.log, ...prompt.log], []);
  });
});

describe('answerDialog: refusals before the first key (nothing is sent)', () => {
  test('(−) a sig that is not the screen\'s: 409 dialog-changed', async () => {
    const w = dialogWorld();
    assert.deepEqual(code(await w.answer({ picks: [1], sig: SIG })), [409, 'dialog-changed']);
    assert.deepEqual(w.log, []);
  });

  test('(−) the form of the earlier tab while the dialog is on the next one, identical except its index: the sig differs (409 dialog-changed)', async () => {
    const same = { question: 'Which project should I open?', options: TAB.project.options };
    const w = dialogWorld({ tabs: [{ header: 'First', ...same }, { header: 'Second', ...same }] });
    const first = w.sig();
    ok(await w.answer({ picks: [1] }), 'next', 1);
    assert.notEqual(w.sig(), first);
    const before = w.log.length;
    assert.deepEqual(code(await w.answer({ picks: [1], sig: first })), [409, 'dialog-changed']);
    assert.equal(w.log.length, before, 'no key');
  });

  test('(−) bypass in a label, a description, a question, a review answer or a plan choice: 400 terminal-only', async () => {
    const mention = (over) => ({ header: 'Mode', question: 'Which mode should I use?', options: [['fast', 'Skip the slow steps.'], ['safe', 'Run every step.']], ...over });
    const forms = [
      dialogWorld({ tabs: [mention({ options: [['bypass permissions', 'x'], ['safe', 'y']] })] }),
      dialogWorld({ tabs: [mention({ options: [['fast', 'turns off permission checks (bypass mode)'], ['safe', 'y']] })] }),
      dialogWorld({ tabs: [mention({ question: 'Switch to bypass permissions mode?' })] }),
      dialogWorld({ phase: 'plan', plan: { labels: ['Yes, and use bypass permissions', 'Yes, manually approve edits'], prose: ['- Stop.'], text: null } }),
    ];
    const body = [{ picks: [1] }, { picks: [1] }, { picks: [1] }, { choice: 1 }];
    for (const [n, w] of forms.entries()) {
      const r = await w.answer(body[n]);
      assert.deepEqual(code(r), [400, 'terminal-only'], `form ${n}`);
      assert.deepEqual(w.log, [], `form ${n}`);
    }
    const review = dialogWorld({ tabs: [mention({})], phase: 'review' });
    review.tabs[0].picked = 1;
    review.tabs[0].answered = true;
    review.tabs[0].options[0].label = 'bypass permissions';
    assert.deepEqual(code(await review.answer({ submit: true })), [400, 'terminal-only']);
    assert.deepEqual(review.log, []);
  });

  test('(−) I1: free text that starts with 1-9 is 400 invalid before any capture or key, on a single-select Other and on the last multi tab', async () => {
    for (const text of ['2', '2 apples', '9', '1x', '7 up']) {
      const single = dialogWorld({ focus: 4, mem: PLAIN });
      const multi = dialogWorld({ tabs: [TAB.tools], focus: 4, mem: PLAIN });
      assert.deepEqual(code(await single.answer({ picks: [], text })), [400, 'invalid'], text);
      assert.deepEqual(code(await multi.answer({ picks: [], text })), [400, 'invalid'], text);
      assert.deepEqual([...single.log, ...multi.log], [], `${text}: not one key`);
      assert.equal(single.captures + multi.captures, 0, `${text}: refused before the first read`);
    }
    const toggle = dialogWorld({ tabs: [TAB.tools] }); // a pick next to the digit text
    assert.deepEqual(code(await toggle.answer({ picks: [1], text: '3' })), [400, 'invalid']);
    assert.deepEqual(toggle.log, []);
  });

  test('(+) I1: a digit later in the text, a zero, or a full-width digit is typed as text', async () => {
    const single = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await single.answer({ picks: [], text: 'apples 2' }), 'submitted', 2);
    assert.deepEqual(single.keysLog(), ['text:apples 2', 'Enter']);
    const zero = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await zero.answer({ picks: [], text: '0 apples' }), 'submitted', 2);
    const wide = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await wide.answer({ picks: [], text: '\uff12 apples' }), 'submitted', 2);
    const multi = dialogWorld({ tabs: [TAB.tools], focus: 4, mem: PLAIN });
    ok(await multi.answer({ picks: [], text: 'run 3 times' }), 'review', 3);
    for (const w of [single, zero, wide, multi]) safe(w);
  });

  // The format characters an eye cannot see (\p{Cf}) and a combining mark (\p{M}) used to pass in front of a digit, so the digit was the
  // second character typed (W1-T2 re-review, I1 residual). U+FEFF is trim()'s own, the rest are not.
  const HIDDEN = { 'U+2060 word joiner': '\u2060', 'U+00AD soft hyphen': '\u00ad', 'U+180E Mongolian vowel separator': '\u180e', 'U+FEFF zero width no-break space': '\ufeff', 'U+0301 combining acute accent': '\u0301' };

  test('(−) I1 residual: an invisible format character or a combining mark before a digit is 400 invalid before any capture or key', async () => {
    for (const [name, c] of Object.entries(HIDDEN)) {
      for (const text of [`${c}2`, `${c}2 apples`, `${c}apples`]) {
        const single = dialogWorld({ focus: 4, mem: PLAIN });
        const multi = dialogWorld({ tabs: [TAB.tools], focus: 4, mem: PLAIN });
        assert.deepEqual(code(await single.answer({ picks: [], text })), [400, 'invalid'], `${name}: ${JSON.stringify(text)}`);
        assert.deepEqual(code(await multi.answer({ picks: [], text })), [400, 'invalid'], `${name}: ${JSON.stringify(text)}`);
        assert.deepEqual([...single.log, ...multi.log], [], `${name}: not one key`);
        assert.equal(single.captures + multi.captures, 0, `${name}: refused before the first read`);
      }
    }
    const toggle = dialogWorld({ tabs: [TAB.tools] }); // a pick next to the hidden digit
    assert.deepEqual(code(await toggle.answer({ picks: [1], text: '\u20603' })), [400, 'invalid']);
    assert.deepEqual(toggle.log, []);
  });

  test('(−) I1 residual: a format character anywhere in the text is refused, not only at the front', async () => {
    for (const c of ['\u2060', '\u00ad', '\u180e', '\ufeff']) {
      for (const text of [`apples${c}`, `ap${c}ples 2`, `apples ${c}2`]) {
        const w = dialogWorld({ focus: 4, mem: PLAIN });
        assert.deepEqual(code(await w.answer({ picks: [], text })), [400, 'invalid'], JSON.stringify(text));
        assert.deepEqual(w.log, [], JSON.stringify(text));
      }
    }
  });

  test('(+) I1 residual: a combining mark later in the text is typed (the accent of an e), as is an emoji with no format character', async () => {
    const accent = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await accent.answer({ picks: [], text: 'cafe\u0301 2' }), 'submitted', 2);
    assert.deepEqual(accent.keysLog(), ['text:cafe\u0301 2', 'Enter']);
    const plain = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await plain.answer({ picks: [], text: 'ok \ud83d\ude00 2' }), 'submitted', 2);
    for (const w of [accent, plain]) safe(w);
  });

  test('(−) M2: free text that mentions bypass is 400 terminal-only before any key (no Down, nothing typed), however it is spelled', async () => {
    for (const text of ['no bypass please', 'ByPaSs', 'b.y.p.a.s.s mode', '\uff42\uff59\uff50\uff41\uff53\uff53 it', 'bypassing the rules']) {
      const single = dialogWorld();
      const multi = dialogWorld({ tabs: [TAB.tools] });
      for (const w of [single, multi]) {
        const r = await w.answer({ picks: [], text });
        assert.deepEqual([r.status, r.body.error], [400, 'terminal-only'], text);
        assert.equal(r.body.sent, undefined);
        assert.deepEqual(w.log, [], `${text}: not one key`);
      }
    }
    const withPick = dialogWorld({ tabs: [TAB.tools] });
    assert.deepEqual(code(await withPick.answer({ picks: [1], text: 'bypass' })), [400, 'terminal-only']);
    assert.deepEqual(withPick.log, []);
  });

  test('(+) M2: text that only looks near it ("by the pass", "bypas") is typed; a Decline never carries text', async () => {
    for (const text of ['by the pass', 'bypas']) {
      const w = dialogWorld();
      ok(await w.answer({ picks: [], text }), 'submitted', 5);
      assert.deepEqual(w.keysLog(), ['Down', 'Down', 'Down', `text:${text}`, 'Enter']);
      safe(w);
    }
  });

  test('(\u2212) a dialog nika cannot read exactly: a narrow pane, a survey, "Exit plan mode?", the auto-mode nudge, an unknown overlay: 409 dialog-unread (0.5.4, QP, O3; was dialog-changed)', async () => {
    const shapes = {
      narrow: (w) => { w.cols = 40; },
      survey: (w) => { const screen = w.screen; w.screen = () => { const s = screen(); return { ...s, rows: [[{ t: 'How is Claude doing this session? (optional)', s: {} }], ...s.rows] }; }; },
      exit: (w) => { w.phase = 'exit'; },
      nudge: (w) => { w.phase = 'nudge'; },
      overlay: (w) => { w.screen = () => ({ rows: [[{ t: 'Select a model', s: {} }], [{ t: '  1. sonnet', s: {} }]], cursor: { x: 0, y: 0, visible: true }, cols: 120 }); },
    };
    for (const [name, make] of Object.entries(shapes)) {
      const w = dialogWorld();
      const sig = w.sig();
      make(w);
      assert.deepEqual(code(await w.answer({ picks: [1], sig })), [409, 'dialog-unread'], name);
      assert.deepEqual(w.log, [], name);
    }
  });

  test('(\u2212) a capture without the pane width cannot be read exactly: 409 dialog-unread (0.5.4, QP, O3; was dialog-changed)', async () => {
    const w = dialogWorld();
    const sig = w.sig();
    const capture = w.mirror.capture;
    w.mirror.capture = async () => { const r = await capture(); return { status: 200, body: { ...r.body, cols: undefined } }; };
    assert.deepEqual(code(await w.answer({ picks: [1], sig })), [409, 'dialog-unread']);
    assert.deepEqual(w.log, []);
  });

  test('(−) no dialog: a closed one (a plain input box) and a permission prompt are 409 no-dialog', async () => {
    for (const phase of ['idle', 'prompt']) {
      const w = dialogWorld({ phase });
      assert.deepEqual(code(await w.ctl.answerDialog('%2', { sig: SIG, picks: [1] })), [409, 'no-dialog'], phase);
      assert.deepEqual(w.log, []);
    }
  });

  test('(−) a failed capture passes its status and body through', async () => {
    const w = dialogWorld();
    w.captureFail = { status: 503, body: { error: 'tmux_unavailable', message: 'x' } };
    assert.deepEqual(await w.answer({ picks: [1], sig: SIG }), { status: 503, body: { error: 'tmux_unavailable', message: 'x' } });
    assert.deepEqual(w.log, []);
  });

  test('(−) an invalid body is 400 before any capture', async () => {
    const w = dialogWorld();
    assert.deepEqual(code(await w.ctl.answerDialog('%2', { sig: 'zz', picks: [1] })), [400, 'invalid']);
    assert.equal(w.captures, 0);
  });

  test('(−) single-select bodies that do not fit the question: a pick and a text, no pick and no text, two picks, a pick beyond k, a text where none is offered: 400 invalid', async () => {
    const w = dialogWorld();
    for (const b of [{ picks: [1], text: 'x' }, { picks: [] }, { picks: [1, 2] }, { picks: [4] }, { picks: [7] }]) assert.deepEqual(code(await w.answer(b)), [400, 'invalid'], JSON.stringify(b));
    const m = dialogWorld({ tabs: [TAB.tools] });
    for (const b of [{ picks: [] }, { picks: [4] }]) assert.deepEqual(code(await m.answer(b)), [400, 'invalid'], JSON.stringify(b));
    assert.deepEqual([...w.log, ...m.log], []);
  });

  test('(−) a single pick with the focus on the text row, the chat row or nowhere: 409 dialog-focus, nothing sent (the digit would be text, or Claude\'s selection moved)', async () => {
    for (const focus of [4, 5, null]) {
      const w = dialogWorld({ focus });
      assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'dialog-focus'], String(focus));
      assert.deepEqual(w.log, []);
    }
  });

  test('(−) text with the focus on the chat row: 409 dialog-focus; a digit-only pick never lands on the chat row', async () => {
    const w = dialogWorld({ focus: 5 });
    assert.deepEqual(code(await w.answer({ picks: [], text: 'x' })), [409, 'dialog-focus']);
    assert.deepEqual(w.log, []);
  });

  // 0.5.1, D: an answered single tab is answered again like any other (it was 409 dialog-touched in 0.5.0); see 'answering a step again' below.
  test('(+) 0.5.1: a single tab that is already answered (the user went back to it) takes a new pick: the digit goes and the dialog moves on', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode] });
    w.tabs[0].answered = true;
    w.tabs[0].picked = 2;
    ok(await w.answer({ picks: [1] }), 'next', 1);
    assert.deepEqual(w.keysLog(), ['text:1']);
    assert.equal(w.tabs[0].picked, 1);
    safe(w);
  });

  test('(−) the text row holds text of its own: a request for other text than that is 409 dialog-touched, nothing sent (a pick no longer is: see the next test)', async () => {
    const w = dialogWorld({ focus: 2 });
    w.tabs[0].text = 'typed in the terminal';
    assert.deepEqual(code(await w.answer({ picks: [], text: 'something else' })), [409, 'dialog-touched']);
    assert.deepEqual(w.log, []);
  });

  test('(+) 0.5.1: a single-select pick is sent although the text row holds text (a digit on an option never touches the text row)', async () => {
    const w = dialogWorld({ focus: 2 });
    w.tabs[0].text = 'typed in the terminal';
    ok(await w.answer({ picks: [1] }), 'submitted', 1);
    assert.deepEqual(w.keysLog(), ['text:1']);
    safe(w);
  });

  test('(−) vim NORMAL on the text row (no INSERT, vim known): 409 text-mode, no text typed; a pane known to be plain does type', async () => {
    const normal = dialogWorld({ vim: true, focus: 4, vimMode: 'normal', mem: { vim: true, plain: false } });
    assert.deepEqual(code(await normal.answer({ picks: [], text: 'beta' })), [409, 'text-mode']);
    assert.deepEqual(normal.log, []);
  });

  test('(−) the pane is vim (INSERT was seen during this request) and the user pressed Escape on the text row: 409 dialog-touched after the Down (M1: INSERT is gone since the key took), nothing typed, no Enter', async () => {
    const w = dialogWorld({ vim: true, focus: 3 });
    w.before = (n) => { if (n === 4) w.vimMode = 'normal'; }; // reads: 1 first, 2 before the Down, 3 after it (INSERT shows), 4 before the text
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-touched', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Down']);
    safe(w);
  });

  test('(−) M4: a request that starts on the text row with no INSERT, on a pane not known to be plain (a plain pane and vim NORMAL draw the same screen): 409 text-mode, nothing sent, no `sent` field', async () => {
    for (const opts of [{ vim: true, vimMode: 'normal' }, { vim: false }, { vim: true, vimMode: 'normal', mem: { vim: false, plain: false } }]) {
      const w = dialogWorld({ focus: 4, ...opts });
      assert.equal(w.read().insert, false);
      assert.deepEqual(await w.answer({ picks: [], text: 'beta' }), { status: 409, body: { error: 'text-mode' } }, JSON.stringify(opts));
      assert.deepEqual(w.log, []);
    }
    const multi = dialogWorld({ tabs: [TAB.tools], focus: 4 }); // the multi question's Other row: the same
    assert.deepEqual(code(await multi.answer({ picks: [], text: 'beta' })), [409, 'text-mode']);
    assert.deepEqual(multi.log, []);
  });

  test('(+) M4: the same start types when INSERT shows (vim), when the pane is known to be plain, or when nika\'s own Down brought the focus here with no INSERT coming', async () => {
    const insert = dialogWorld({ focus: 4, vim: true });
    assert.equal(insert.read().insert, true);
    ok(await insert.answer({ picks: [], text: 'beta' }), 'submitted', 2);
    const known = dialogWorld({ focus: 4, mem: PLAIN });
    ok(await known.answer({ picks: [], text: 'beta' }), 'submitted', 2);
    const arrived = dialogWorld({ focus: 3 }); // a plain pane nika has never seen: the Down lands on the text row and no INSERT follows
    ok(await arrived.answer({ picks: [], text: 'beta' }), 'submitted', 3);
    assert.deepEqual(arrived.keysLog(), ['Down', 'text:beta', 'Enter']);
    const multi = dialogWorld({ tabs: [TAB.tools], focus: 3 });
    ok(await multi.answer({ picks: [], text: 'beta' }), 'review', 4);
    assert.deepEqual(multi.keysLog(), ['Down', 'text:beta', 'Down', 'Enter']);
    for (const w of [insert, known, arrived, multi]) safe(w);
  });

  test('(−) M4: the Down arrived on the text row with no INSERT, but vim is known for this pane (vim enters INSERT on that row at once): 409 text-mode after the Down, nothing typed', async () => {
    const w = dialogWorld({ focus: 3, mem: { vim: true, plain: false } }); // the fake draws a plain screen: no INSERT on arrival
    assert.deepEqual(await w.answer({ picks: [], text: 'beta' }), { status: 409, body: { error: 'text-mode', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Down']);
    safe(w);
  });

  test('(−) another action holds the pane: 409 busy-switching and nothing sent', async () => {
    const w = dialogWorld();
    let release;
    w.hold = new Promise((r) => { release = r; });
    const first = w.answer({ picks: [1] });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(code(await w.answer({ picks: [2] })), [409, 'busy-switching']);
    release();
    ok(await first, 'submitted', 1);
    assert.deepEqual(w.keysLog(), ['text:1']);
  });

  test('(−) a Stop/End interrupt ran just now (inside the 40 ms gap): 409 not-idle and not one key; from 40 ms on it goes', async () => {
    const w = dialogWorld({ phase: 'idle', state: 'busy' });
    assert.deepEqual(await w.ctl.stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
    w.phase = 'ask';
    assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'not-idle']);
    assert.equal(w.log.length, 1, 'only the interrupt\'s own Escape');
    w.t += 40;
    ok(await w.answer({ picks: [1] }), 'submitted', 1);
  });

  test('(−) the same dialog answered again within answerHoldMs: 409 already-answered, nothing sent; after 3 s it is a new dialog', async () => {
    const w = dialogWorld();
    const sig = w.sig();
    ok(await w.answer({ picks: [1] }), 'submitted', 1);
    w.phase = 'ask'; // Claude asks the very same question again
    w.tabs[0].picked = null;
    w.tabs[0].answered = false;
    assert.deepEqual(code(await w.answer({ picks: [1], sig })), [409, 'already-answered']);
    assert.equal(w.log.length, 1);
    w.t += 3000;
    ok(await w.answer({ picks: [1], sig }), 'submitted', 1);
    assert.equal(w.log.length, 2);
  });

  test('(−) already-answered also holds for a Decline and a plan choice', async () => {
    const plan = dialogWorld({ phase: 'plan' });
    const sig = plan.sig();
    ok(await plan.answer({ choice: 1 }), 'chosen', 1);
    plan.phase = 'plan';
    assert.deepEqual(code(await plan.answer({ choice: 1, sig })), [409, 'already-answered']);
    const ask = dialogWorld();
    const askSig = ask.sig();
    ok(await ask.answer({ cancel: true }), 'declined', 1);
    ask.phase = 'ask';
    assert.deepEqual(code(await ask.answer({ cancel: true, sig: askSig })), [409, 'already-answered']);
    assert.equal(plan.log.length + ask.log.length, 2);
  });
});

describe('answerDialog: the screen changes while a request runs (it stops at once; the answer carries `sent`)', () => {
  const other = () => dialogWorld({ tabs: [{ ...TAB.project, header: 'Project' }] });

  test('(−) the dialog is closed in the terminal after the 2nd Down: 409 no-dialog with sent 2, no key after it', async () => {
    const w = other();
    w.onKey = (n) => { if (n === 2) { w.phase = 'idle'; w.result = 'closed in the terminal'; } };
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'no-dialog', sent: 2 } });
    assert.deepEqual(w.keysLog(), ['Down', 'Down']);
    assert.equal(w.leaks().length, 0, 'not one key toward the input box');
  });

  test('(−) a permission prompt appears after the 1st Down: 409 no-dialog with sent 1, and no key reaches the prompt', async () => {
    const w = other();
    w.onKey = (n) => { if (n === 1) w.phase = 'prompt'; };
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'no-dialog', sent: 1 } });
    assert.equal(w.leaks().length, 0);
  });

  test('(−) the question changes after the 1st Down (a new call): 409 dialog-changed with sent 1', async () => {
    const w = other();
    w.onKey = (n) => { if (n === 1) w.tabs[0].question = 'Which folder should I clean?'; };
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-changed', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Down']);
  });

  test('(−) Claude moves to the next tab after the 1st toggle: 409 dialog-changed, no Right is sent', async () => {
    const w = dialogWorld({ tabs: [TAB.tools, TAB.project] });
    w.onKey = (n) => { if (n === 1) { w.i = 1; w.focus = 1; } };
    const r = await w.answer({ picks: [1, 2] });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-changed', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:1']);
  });

  test('(−) the text row gets text from the terminal between the Down and the typing: 409 dialog-touched, nothing typed', async () => {
    const w = dialogWorld({ focus: 3 });
    w.onKey = (n) => { if (n === 1) w.tabs[0].text = 'typed there'; };
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-touched', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Down']);
  });

  test('(−) the focus is moved in the terminal after the 1st Down (to the chat row): 409 not-taken, nothing typed', async () => {
    const w = dialogWorld({ focus: 2 });
    w.onKey = (n) => { if (n === 1) w.focus = 5; };
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Down']);
  });

  test('(−) the review changes between the two reads of one request: 409 dialog-changed', async () => {
    const w = dialogWorld({ tabs: [TAB.project], phase: 'review' });
    w.tabs[0].answered = true;
    w.tabs[0].picked = 1;
    w.before = (n) => { if (n === 2) w.tabs[0].picked = 2; }; // the second capture of the request is the one before the key
    assert.deepEqual(code(await w.answer({ submit: true })), [409, 'dialog-changed']);
    assert.deepEqual(w.log, []);
  });

  test('(−) the dialog closes between the first read and the key read: 409 no-dialog and nothing is sent', async () => {
    const w = dialogWorld();
    w.before = (n) => { if (n === 2) w.phase = 'idle'; };
    assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'no-dialog']);
    assert.deepEqual(w.log, []);
  });

  test('(−) M1: the focus is moved in the terminal after a key took: 409 dialog-focus and the next key is not re-derived from the new screen', async () => {
    for (const to of [1, 2, 5]) { // another option, the same option the Down left, the chat row
      const w = dialogWorld({ focus: 2 });
      w.before = (n) => { if (n === 4) w.focus = to; }; // reads: 1 first, 2 before the Down, 3 settle (focus 3), 4 before the next key
      const r = await w.answer({ picks: [], text: 'beta' });
      assert.deepEqual(r, { status: 409, body: { error: 'dialog-focus', sent: 1 } }, String(to));
      assert.deepEqual(w.keysLog(), ['Down'], `focus ${to}: not a second Down from the new place`);
      safe(w);
    }
  });

  test('(−) M1: a box is changed in the terminal after a key took: 409 dialog-touched, no toggle that would override it', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    w.before = (n) => { if (n === 4) w.tabs[0].checked = [1, 3]; }; // wanted [1, 2]: toggle 1 took ([1]); the terminal then adds 3
    const r = await w.answer({ picks: [1, 2] });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-touched', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:1']);
    assert.deepEqual(w.tabs[0].checked, [1, 3], 'left as the person made it');
  });

  test('(−) M1: text appears in the Other row after the Down took (the terminal): 409 dialog-touched, nothing typed over it', async () => {
    const w = dialogWorld({ focus: 3 });
    w.before = (n) => { if (n === 4) w.tabs[0].text = 'typed there'; };
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-touched', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Down']);
  });

  test('(−) M1: the first Decline Escape left INSERT, then it is back (the person pressed i): 409 dialog-touched after one Escape, no second one', async () => {
    const w = dialogWorld({ vim: true, focus: 4 });
    w.before = (n) => { if (n === 4) w.vimMode = 'insert'; }; // reads: 1 first, 2 before the Escape, 3 settle (INSERT gone), 4 before the next key
    const r = await w.answer({ cancel: true });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-touched', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Escape']);
  });

  test('(+) M1: a late redraw within settleTries is not a change: every read after it equals the one the key was proven on', async () => {
    const multi = dialogWorld({ tabs: [TAB.tools], lag: 2 });
    ok(await multi.answer({ picks: [1, 2] }), 'review', 3);
    assert.deepEqual(multi.keysLog(), ['text:1', 'text:2', 'Right']);
    const other = dialogWorld({ lag: 2 });
    ok(await other.answer({ picks: [], text: 'beta' }), 'submitted', 5);
    safe(multi);
    safe(other);
  });
});

describe('answerDialog: keys that are not taken, failed sends and the loop guard', () => {
  test('(−) the digit is lost: 409 not-taken with sent 1, the key is not repeated', async () => {
    const w = dialogWorld();
    w.drop = () => true;
    assert.deepEqual(await w.answer({ picks: [2] }), { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:2']);
    assert.equal(w.captures, 2 + 4, 'two reads before the key and settleTries reads after it');
  });

  test('(−) a toggle that does not show: 409 not-taken, the Right is not sent', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    w.drop = () => true;
    assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'not-taken']);
    assert.deepEqual(w.keysLog(), ['text:1']);
  });

  test('(−) a Down that does not move the focus: 409 not-taken after it, no text is typed', async () => {
    const w = dialogWorld();
    w.drop = (b) => b.keys?.[0] === 'Down';
    assert.deepEqual(code(await w.answer({ picks: [], text: 'beta' })), [409, 'not-taken']);
    assert.deepEqual(w.keysLog(), ['Down']);
  });

  test('(−) a late redraw within settleTries is waited for; one past it is not-taken', async () => {
    const late = dialogWorld({ lag: 3 });
    ok(await late.answer({ picks: [1] }), 'submitted', 1);
    const tooLate = dialogWorld({ lag: 4 });
    assert.deepEqual(code(await tooLate.answer({ picks: [1] })), [409, 'not-taken']);
    assert.deepEqual(tooLate.keysLog(), ['text:1']);
  });

  test('(−) typed text that arrives changed: 409 text-mismatch, and the Enter is never pressed', async () => {
    const w = dialogWorld({ focus: 4, mem: PLAIN });
    w.mangle = (t) => t.replace('e', '3');
    assert.deepEqual(await w.answer({ picks: [], text: 'beta' }), { status: 409, body: { error: 'text-mismatch', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:beta']);
    safe(w);
  });

  test('(−) typed text that does not show at all: 409 text-mismatch', async () => {
    const w = dialogWorld({ focus: 4, mem: PLAIN });
    w.drop = () => true;
    assert.deepEqual(code(await w.answer({ picks: [], text: 'beta' })), [409, 'text-mismatch']);
  });

  test('(−) a 429 on the first key has no `sent`; a 429 on the third key carries sent 2 and nothing follows', async () => {
    const busy = { status: 429, body: { error: 'busy', message: 'at most 20 requests per second per pane' } };
    const first = dialogWorld();
    first.failSend = () => busy;
    assert.deepEqual(await first.answer({ picks: [1] }), busy);
    const third = dialogWorld();
    third.failSend = (b, n) => (n === 3 ? busy : null);
    assert.deepEqual(await third.answer({ picks: [], text: 'beta' }), { status: 429, body: { ...busy.body, sent: 2 } });
    assert.deepEqual(third.keysLog(), ['Down', 'Down']);
    assert.equal(third.log.length, 3, 'the failed send was the last attempt');
  });

  test('(−) a capture that fails after a key passes its own status and body, with sent', async () => {
    const w = dialogWorld();
    w.onKey = () => { w.captureFail = { status: 502, body: { error: 'tmux_failed', message: 'x' } }; };
    assert.deepEqual(await w.answer({ picks: [1] }), { status: 502, body: { error: 'tmux_failed', message: 'x', sent: 1 } });
  });

  test('(−) M1: a toggle takes and is undone in the terminal before the next read: 409 dialog-touched after that one key, no 24 rounds of toggling against the terminal', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    // captures: 1 first read; then per round a read before the key (even) and the settle read after it (odd)
    w.before = (n) => { w.tabs[0].checked = n % 2 === 0 || n === 1 ? [] : [1]; };
    const r = await w.answer({ picks: [1] });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-touched', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:1']);
    assert.equal(STEPS_MAX, 24, 'the loop guard stays a backstop');
  });
});

describe('answerDialog: a Stop or End interrupt still running (M6)', () => {
  /**
   * A busy vim pane (INSERT shown, nothing to answer yet): `start(w)` is Stop or End. Its Escape goes out and it waits for INSERT to go; that
   * capture (the 2nd) is held, so the interrupt is in flight while a dialog appears and a request for it runs.
   */
  async function inFlight(start) {
    const w = dialogWorld({ phase: 'idle', vim: true, state: 'busy' });
    let open;
    const gate = new Promise((r) => { open = r; });
    w.before = (n, world) => { world.hold = n === 2 ? gate : null; };
    const running = start(w);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(w.captures, 2, 'the interrupt is waiting for its second capture');
    assert.deepEqual(w.keysLog(), ['Escape']);
    w.phase = 'ask'; // Claude raises a question while the Escape is still being waited for
    w.vim = false;
    return { w, running, release: () => { w.state = 'idle'; open(); } };
  }

  test('(−) Stop in flight (it holds no lock, only the interrupt flag): the dialog request is 409 not-idle and not one key goes out', async () => {
    const { w, running, release } = await inFlight((world) => world.ctl.stop('%2'));
    assert.deepEqual(await w.answer({ picks: [1] }), { status: 409, body: { error: 'not-idle' } });
    assert.deepEqual(w.keysLog(), ['Escape'], 'only the interrupt\'s own Escape');
    release();
    assert.equal((await running).status, 200);
    assert.deepEqual(w.keysLog(), ['Escape']);
  });

  test('(−) End in flight (it holds the pane lock): the dialog request is 409 busy-switching and not one key goes out', async () => {
    const { w, running, release } = await inFlight((world) => world.ctl.endSession('%2'));
    assert.deepEqual(await w.answer({ picks: [1] }), { status: 409, body: { error: 'busy-switching' } });
    assert.deepEqual(w.keysLog(), ['Escape']);
    release();
    assert.deepEqual(code(await running), [409, 'not-idle'], 'End then sees a dialog and types nothing');
    assert.deepEqual(w.keysLog(), ['Escape']);
  });

  test('(+) the interrupt has finished: the same request goes (after the 40 ms gap)', async () => {
    const { w, running, release } = await inFlight((world) => world.ctl.stop('%2'));
    release();
    await running;
    w.t += 40;
    ok(await w.answer({ picks: [1] }), 'submitted', 1);
    assert.deepEqual(w.keysLog(), ['Escape', 'text:1']);
  });
});

describe('answerDialog: the key log holds only the allowed keys, in every scenario', () => {
  test('(+) every scenario above is also run through safe(): Down, Right, Enter and Escape only; digits only on options; text only on the text row; no paste', async () => {
    const runs = [
      [dialogWorld(), { picks: [3] }], [dialogWorld(), { picks: [], text: 'beta' }], [dialogWorld({ tabs: [TAB.tools, TAB.mode] }), { picks: [1, 2, 3] }],
      [dialogWorld({ tabs: [TAB.mode, TAB.tools], i: 1 }), { picks: [2], text: 'beta' }], [dialogWorld({ tabs: [TAB.project], phase: 'review' }), { submit: true }],
      [dialogWorld({ phase: 'plan' }), { choice: 2 }], [dialogWorld({ vim: true, focus: 4 }), { cancel: true }], [dialogWorld({ phase: 'plan' }), { cancel: true }],
    ];
    for (const [w, body] of runs) {
      const r = await w.answer(body);
      assert.equal(r.status, 200, JSON.stringify(body));
      safe(w, { escape: body.cancel === true });
    }
  });
});

describe('answerDialog: answering a step again (0.5.1, D)', () => {
  test('(+) an answered single tab that is not the last: the new pick goes as its digit and the dialog moves to the next tab (done next)', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode, TAB.name], i: 0 });
    w.tabs[0].answered = true;
    w.tabs[0].picked = 1;
    ok(await w.answer({ picks: [3] }), 'next', 1);
    assert.deepEqual([w.i, w.tabs[0].picked, w.keysLog()], [1, 3, ['text:3']]);
    safe(w);
  });

  test('(+) the same on the last tab opens the review (done review)', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode], i: 1 });
    w.tabs[0].answered = true;
    w.tabs[1].answered = true;
    w.tabs[1].picked = 1;
    ok(await w.answer({ picks: [2] }), 'review', 1);
    assert.deepEqual([w.phase, w.tabs[1].picked, w.keysLog()], ['review', 2, ['text:2']]);
    safe(w);
  });

  test('(+) the same typed text again from an option row: Down to the text row k times, then Enter (it re-confirms the text, nothing is typed)', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode] });
    w.tabs[0].text = 'beta';
    w.tabs[0].answered = true;
    w.focus = 1;
    ok(await w.answer({ picks: [], text: 'beta' }), 'next', 4);
    assert.deepEqual(w.keysLog(), ['Down', 'Down', 'Down', 'Enter']);
    assert.equal(w.tabs[0].picked, null);
    safe(w);
  });

  test('(+) a pick over an answered typed text: the option replaces the answer, the typed text stays in the row (Claude keeps it)', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode] });
    w.tabs[0].text = 'beta';
    w.tabs[0].answered = true;
    ok(await w.answer({ picks: [2] }), 'next', 1);
    assert.deepEqual([w.tabs[0].picked, w.tabs[0].text], [2, 'beta']);
    const gone = dialogWorld({ tabs: [TAB.project, TAB.mode], typedKept: false });
    gone.tabs[0].text = 'beta';
    ok(await gone.answer({ picks: [2] }), 'next', 1);
    assert.equal(gone.tabs[0].text, null, 'the fake can also model a Claude that drops the text');
  });

  test('(−) other text than the one in the row is still 409 dialog-touched; a multi tab with text in its Other row and a request without it too (unchanged)', async () => {
    const single = dialogWorld({ focus: 2 });
    single.tabs[0].text = 'typed in the terminal';
    assert.deepEqual(code(await single.answer({ picks: [], text: 'other words' })), [409, 'dialog-touched']);
    const multi = dialogWorld({ tabs: [TAB.tools] });
    multi.tabs[0].text = 'kept';
    multi.tabs[0].answered = true;
    assert.deepEqual(code(await multi.answer({ picks: [1] })), [409, 'dialog-touched']);
    assert.deepEqual(code(await multi.answer({ picks: [1], text: 'different' })), [409, 'dialog-touched']);
    assert.deepEqual([...single.log, ...multi.log], []);
  });

  test('(+) a multi tab with typed text and a request that carries the same text goes on (the page sends it with every request)', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    w.tabs[0].text = 'kept';
    w.tabs[0].answered = true;
    ok(await w.answer({ picks: [1], text: 'kept' }), 'review', 6);
    assert.deepEqual(w.keysLog(), ['text:1', 'Down', 'Down', 'Down', 'Down', 'Enter']); // the toggle, Down to the text row and on to Submit, Enter
    assert.deepEqual([w.tabs[0].checked, w.tabs[0].text], [[1], 'kept']);
  });
});

/** What a step move may send, asserted on the key log (design 5.1 safeMove): Right, Left and Up only; Up only to leave an input row; Left and Right only from an option row (or the review). */
function safeMove(w) {
  assert.deepEqual(w.leaks(), [], 'no key after the dialog closed, none toward an input box or a permission prompt');
  for (const e of w.log.filter((x) => !x.failed)) {
    assert.equal(e.text, undefined, 'no text, no digit');
    assert.equal(e.paste, undefined, 'no paste');
    assert.ok(Array.isArray(e.keys) && e.keys.length === 1, 'one key per request');
    const [k] = e.keys;
    assert.ok(['Right', 'Left', 'Up'].includes(k), `never ${k}`);
    if (k === 'Up') assert.ok(['text', 'chat', 'button'].includes(e.slot), `Up never on ${e.slot}`);
    else assert.ok(['option', 'review1'].includes(e.slot), `${k} never on ${e.slot}`);
  }
}

describe('answerDialog: moving to another step (0.5.1, D)', () => {
  const three = (opts = {}) => dialogWorld({ tabs: [TAB.project, TAB.mode, TAB.name], ...opts });
  const moved = (r, sent) => assert.deepEqual(r, { status: 200, body: sent === 0 ? { done: 'moved' } : { done: 'moved', sent } });
  /** Runs `change(world)` right before the capture that follows the first key's proof: the screen changes between two rounds, not during one. */
  const racing = (w, change) => {
    let c0 = null;
    w.onKey = (n, world) => { if (n === 1) c0 = world.captures; };
    w.before = (n, world) => { if (c0 !== null && n === c0 + 2 && world.log.length === 1) change(world); };
  };

  test('(+) tab 0 to 2: Right, Right', async () => {
    const w = three();
    moved(await w.answer({ tab: 2 }), 2);
    assert.deepEqual([w.keysLog(), w.i, w.phase], [['Right', 'Right'], 2, 'ask']);
    safeMove(w);
  });

  test('(+) tab 2 to 0: Left, Left', async () => {
    const w = three({ i: 2 });
    moved(await w.answer({ tab: 0 }), 2);
    assert.deepEqual([w.keysLog(), w.i], [['Left', 'Left'], 0]);
    safeMove(w);
  });

  test('(+) tab 1 to Review (tab = the number of questions): Right, Right; Review to tab 0: Left, Left, Left', async () => {
    const w = three({ i: 1 });
    moved(await w.answer({ tab: 3 }), 2);
    assert.deepEqual([w.keysLog(), w.phase], [['Right', 'Right'], 'review']);
    moved(await w.answer({ tab: 0 }), 3);
    assert.deepEqual([w.log.slice(2).map((e) => e.keys[0]), w.phase, w.i], [['Left', 'Left', 'Left'], 'ask', 0]);
    safeMove(w);
  });

  test('(+) a move answers nothing: no tab is answered by it, the answers stay, the review lists them as before', async () => {
    const w = three();
    w.tabs[0].answered = true;
    w.tabs[0].picked = 2;
    moved(await w.answer({ tab: 2 }), 2);
    assert.deepEqual(w.tabs.map((t) => [t.answered, t.picked]), [[true, 2], [false, null], [false, null]]);
    safeMove(w);
  });

  test('(+) the focus on the text row (plain pane): Up first, then Right; on Chat: Up, Up, Right', async () => {
    const text = three({ focus: 4 });
    moved(await text.answer({ tab: 1 }), 2);
    assert.deepEqual([text.keysLog(), text.i], [['Up', 'Right'], 1]);
    safeMove(text);
    const chat = three({ focus: 5 });
    moved(await chat.answer({ tab: 1 }), 3);
    assert.deepEqual([chat.keysLog(), chat.i], [['Up', 'Up', 'Right'], 1]);
    safeMove(chat);
  });

  test('(+) a multi question on its Next button: Up, Up, then Right; on Chat: three Ups, then Right', async () => {
    const next = dialogWorld({ tabs: [TAB.tools, TAB.project], focus: 'button' });
    moved(await next.answer({ tab: 1 }), 3);
    assert.deepEqual(next.keysLog(), ['Up', 'Up', 'Right']);
    safeMove(next);
    const chat = dialogWorld({ tabs: [TAB.tools, TAB.project], focus: 5 });
    moved(await chat.answer({ tab: 1 }), 4);
    assert.deepEqual(chat.keysLog(), ['Up', 'Up', 'Up', 'Right']);
    safeMove(chat);
  });

  test('(+) a move to the step it is already on (the user got there in the terminal) answers moved with no key', async () => {
    const w = three();
    w.before = (n, world) => { if (n === 2) world.i = 1; }; // read 1 is the request\'s first look, read 2 the round\'s
    moved(await w.answer({ tab: 1 }), 0);
    assert.deepEqual(w.log, []);
  });

  test('(+) a move clears the answer hold: the step answered a second ago takes its new answer, not 409 already-answered', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode] });
    const first = w.sig();
    ok(await w.answer({ picks: [1] }), 'next', 1);
    moved(await w.answer({ tab: 0 }), 1);
    assert.equal(w.sig(), first, 'the same step, the same sig');
    ok(await w.answer({ picks: [2] }), 'next', 1);
    assert.deepEqual(w.keysLog(), ['text:1', 'Left', 'text:2']);
    assert.deepEqual(w.leaks(), []);
  });

  test('(−) the hold is not cleared by a refused move: the same answer a moment later is still already-answered', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode] });
    const first = w.sig();
    ok(await w.answer({ picks: [1] }), 'next', 1);
    assert.deepEqual(code(await w.answer({ tab: 0, sig: 'ffffffffffffffff' })), [409, 'dialog-changed']);
    w.i = 0;
    assert.deepEqual(code(await w.answer({ picks: [1], sig: first })), [409, 'already-answered']);
  });

  test('(−) a one-question form: 400 invalid, nothing sent (the single-select form has no strip; the multi one has only itself and the review)', async () => {
    for (const w of [dialogWorld(), dialogWorld({ tabs: [TAB.tools] })]) {
      assert.deepEqual(code(await w.answer({ tab: 0 })), [400, 'invalid']);
      assert.deepEqual(code(await w.answer({ tab: 1 })), [400, 'invalid']);
      assert.deepEqual(w.log, []);
    }
  });

  test('(−) the step it is on, or a step that does not exist: 400 invalid, nothing sent', async () => {
    const w = three({ i: 1 });
    assert.deepEqual(code(await w.answer({ tab: 1 })), [400, 'invalid']);
    assert.deepEqual(code(await w.answer({ tab: 4 })), [400, 'invalid']);
    assert.deepEqual(code(await w.answer({ tab: 8 })), [400, 'invalid']);
    const review = three({ phase: 'review' });
    assert.deepEqual(code(await review.answer({ tab: 3 })), [400, 'invalid'], 'the review is tab = n');
    assert.deepEqual([...w.log, ...review.log], []);
  });

  test('(−) a sig that is not the screen\'s, a closed dialog, a plan and a permission prompt: 409 dialog-changed or no-dialog, nothing sent', async () => {
    const stale = three();
    assert.deepEqual(code(await stale.answer({ tab: 2, sig: SIG })), [409, 'dialog-changed']);
    const closed = three({ phase: 'idle' });
    assert.deepEqual(code(await closed.answer({ tab: 2, sig: SIG })), [409, 'no-dialog']);
    const plan = dialogWorld({ phase: 'plan' });
    assert.deepEqual(code(await plan.answer({ tab: 1, sig: plan.sig() })), [409, 'dialog-changed']);
    const prompt = three({ phase: 'prompt' });
    assert.deepEqual(code(await prompt.answer({ tab: 1, sig: SIG })), [409, 'no-dialog']);
    assert.deepEqual([...stale.log, ...closed.log, ...plan.log, ...prompt.log], []);
  });

  test('(−) bypass in the dialog: 400 terminal-only, nothing sent (a move is not a Decline)', async () => {
    const w = dialogWorld({ tabs: [{ ...TAB.mode, options: [['bypass permissions', 'x'], ['safe', 'y']] }, TAB.project] });
    assert.deepEqual(code(await w.answer({ tab: 1 })), [400, 'terminal-only']);
    assert.deepEqual(code(await w.answer({ tab: 0 })), [400, 'terminal-only'], 'before the request is checked against the steps');
    assert.deepEqual(w.log, []);
  });

  test('(−) bypass shows up on a later step: 400 terminal-only with sent 1, no second key', async () => {
    const w = three();
    w.onKey = (n, world) => { if (n === 1) world.tabs[1].options = [{ label: 'bypass permissions', desc: 'x' }, { label: 'safe', desc: 'y' }]; };
    const r = await w.answer({ tab: 2 });
    assert.deepEqual([r.status, r.body.error, r.body.sent], [400, 'terminal-only', 1]);
    assert.deepEqual(w.keysLog(), ['Right']);
    safeMove(w);
  });

  test('(−) the dialog closes, or a permission prompt appears, between two rounds: 409 dialog-changed with sent 1, no second key', async () => {
    const closed = three();
    racing(closed, (world) => { world.phase = 'idle'; world.result = 'closed in the terminal'; });
    assert.deepEqual(await closed.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-changed', sent: 1 } });
    assert.deepEqual(closed.keysLog(), ['Right']);
    const prompt = three();
    racing(prompt, (world) => { world.phase = 'prompt'; });
    assert.deepEqual(await prompt.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-changed', sent: 1 } });
    assert.deepEqual([prompt.keysLog(), prompt.leaks()], [['Right'], []]);
  });

  test('(\u2212) the step becomes unreadable (a clipped option) between two Ups: 409 dialog-unread with sent 1, not a second Up (0.5.4, QP, O3; was dialog-changed)', async () => {
    const w = three({ focus: 5 });
    racing(w, (world) => { world.tabs[0].options[0].label = 'acme-api\u2026'; });
    assert.deepEqual(await w.answer({ tab: 1 }), { status: 409, body: { error: 'dialog-unread', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Up']);
  });

  test('(−) an Up after which Claude stands on another step (the person pressed Right too): 409 not-taken with sent 1, no Right', async () => {
    const w = three({ focus: 4 });
    w.onKey = (n, world) => { if (n === 1) { world.i = 1; world.focus = 2; } };
    assert.deepEqual(await w.answer({ tab: 2 }), { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Up']);
  });

  test('(+) vim (round 3, SVIM rows 24 and 27): Up leaves the text row in INSERT and in NORMAL alike, and on Chat; then Right moves the tab', async () => {
    const insert = three({ vim: true, focus: 4 });
    assert.equal(insert.read().insert, true, 'premise: INSERT shows on the text row');
    moved(await insert.answer({ tab: 1 }), 2);
    assert.deepEqual(insert.keysLog(), ['Up', 'Right']);
    const normal = three({ vim: true, vimMode: 'normal', focus: 4, mem: { vim: true, plain: false } });
    assert.equal(normal.read().insert, false, 'premise: NORMAL shows no marker');
    moved(await normal.answer({ tab: 1 }), 2);
    assert.deepEqual(normal.keysLog(), ['Up', 'Right']);
    const chat = three({ focus: 5, mem: { vim: true, plain: false } });
    moved(await chat.answer({ tab: 1 }), 3);
    assert.deepEqual(chat.keysLog(), ['Up', 'Up', 'Right']);
    for (const w of [insert, normal, chat]) safeMove(w);
  });

  test('(−) vim: no key but Up and Right/Left goes out for a move: not a letter (i, j, k, h, l), not Escape, not text', async () => {
    for (const w of [three({ vim: true, focus: 4 }), three({ vim: true, vimMode: 'normal', focus: 4, mem: { vim: true, plain: false } })]) {
      await w.answer({ tab: 2 });
      assert.deepEqual(w.keysLog().filter((k) => !['Up', 'Right', 'Left'].includes(k)), []);
      assert.deepEqual(w.log.filter((e) => e.text !== undefined), []);
      assert.deepEqual(w.leaks(), []);
    }
  });

  test('(−) three Ups that all took but still left the focus on an input row: 409 text-focus with sent 3, never a fourth Up and never a Right', async () => {
    const w = three({ focus: 5 });
    w.onKey = (n, world) => { world.focus = n % 2 === 1 ? 4 : 5; }; // the focus keeps hopping between the text row and Chat: every Up shows a change, none gets out
    assert.deepEqual(await w.answer({ tab: 1 }), { status: 409, body: { error: 'text-focus', sent: 3 } });
    assert.deepEqual(w.keysLog(), ['Up', 'Up', 'Up']);
    safeMove(w);
  });

  test('(−) an Up that is lost: 409 not-taken with sent 1, the key is not repeated and no Right follows', async () => {
    const w = three({ focus: 4, drop: (b) => b.keys?.[0] === 'Up' });
    assert.deepEqual(await w.answer({ tab: 1 }), { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Up']);
    safeMove(w);
  });

  test('(−) the focus is on the text row of a later step (the user moved it in the terminal): 409 dialog-focus, no Up, no Right', async () => {
    const w = three();
    w.onKey = (n, world) => { if (n === 1) world.focus = 3; }; // the first Right took (the mode tab has two options); the person then moved to its text row
    const r = await w.answer({ tab: 2 });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-focus', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Right']);
    safeMove(w);
  });

  test('(−) a pane locked by another action: 409 busy-switching, nothing sent', async () => {
    const w = three();
    let release;
    w.hold = new Promise((r) => { release = r; });
    const first = w.answer({ tab: 1 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(code(await w.answer({ tab: 2 })), [409, 'busy-switching']);
    release();
    moved(await first, 1);
    assert.deepEqual(w.keysLog(), ['Right']);
  });

  test('(−) a Stop/End Escape went out just now: 409 not-idle and no key; from 40 ms on it goes', async () => {
    const w = dialogWorld({ phase: 'idle', state: 'busy', tabs: [TAB.project, TAB.mode] });
    assert.deepEqual(await w.ctl.stop('%2'), { status: 200, body: { stopped: true, presses: 1 } });
    w.phase = 'ask';
    assert.deepEqual(code(await w.answer({ tab: 1 })), [409, 'not-idle']);
    assert.equal(w.log.length, 1, 'only the interrupt\'s own Escape');
    w.t += 40;
    moved(await w.answer({ tab: 1 }), 1);
  });

  test('(−) the headers change after the first key: 409 dialog-changed with sent 1, no second key', async () => {
    const w = three();
    w.onKey = (n, world) => { if (n === 1) world.tabs[2].header = 'Renamed'; };
    assert.deepEqual(await w.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-changed', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Right']);
  });

  test('(−) an answered mark flips after the first key (someone answered in the terminal): 409 dialog-touched with sent 1', async () => {
    const w = three();
    w.onKey = (n, world) => { if (n === 1) world.tabs[2].answered = true; };
    assert.deepEqual(await w.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-touched', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Right']);
  });

  test('(−) the key is lost: 409 not-taken with sent 1, the key is not repeated', async () => {
    const w = three({ drop: () => true });
    assert.deepEqual(await w.answer({ tab: 2 }), { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Right']);
  });

  test('(−) the dialog closes after the first key: 409 dialog-changed with sent 1, and no key after the close', async () => {
    const w = three();
    w.onKey = (n, world) => { if (n === 1) { world.phase = 'idle'; world.result = 'closed in the terminal'; } };
    assert.deepEqual(await w.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-changed', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Right']);
    safeMove(w);
  });

  test('(−) Claude lands two steps away after one key (the person pressed Right too): 409 dialog-changed on the next read, no further key', async () => {
    const w = three({ tabs: [TAB.project, TAB.mode, TAB.name, TAB.mode] });
    w.onKey = (n, world) => { if (n === 1) world.i = 2; };
    assert.deepEqual(await w.answer({ tab: 3 }), { status: 409, body: { error: 'dialog-changed', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Right']);
  });

  test('(−) a permission prompt appears after the first key: no key reaches it', async () => {
    const w = three();
    w.onKey = (n, world) => { if (n === 1) world.phase = 'prompt'; };
    const r = await w.answer({ tab: 2 });
    assert.deepEqual([r.status, r.body.error, r.body.sent], [409, 'dialog-changed', 1]);
    assert.deepEqual(w.keysLog(), ['Right']);
    assert.deepEqual(w.leaks(), [], 'the prompt received nothing');
  });

  test('(−) a failed capture and a failed key send pass their own status through', async () => {
    const cap = three();
    cap.captureFail = { status: 502, body: { error: 'capture-failed' } };
    assert.deepEqual(code(await cap.answer({ tab: 1, sig: SIG })), [502, 'capture-failed']);
    const send = three({ failSend: () => ({ status: 429, body: { error: 'rate-limited' } }) });
    assert.deepEqual(code(await send.answer({ tab: 1 })), [429, 'rate-limited']);
    assert.deepEqual(send.keysLog(), []);
  });

  test('(−) a move never types: a text row with typed text is left alone, and the typed text is still there after the move', async () => {
    const w = three({ focus: 4 });
    w.tabs[0].text = 'kept words';
    moved(await w.answer({ tab: 1 }), 2);
    assert.deepEqual([w.tabs[0].text, w.keysLog()], ['kept words', ['Up', 'Right']]);
    safeMove(w);
  });
});

// ---- 0.5.4, QP (O3): no false "The question changed" ----------------------------------------------------------------------------
// After a key that answers a tab, Claude shows the next step. nika proves the step moved from the strip alone (the same headers, the answered mark of the tab it
// answered, every other mark as before, the strip one step on), so a next step it cannot read (a preview step before 0.5.4's reader, a clipped option) is `next`, not
// "The question changed". A dialog nika cannot read at all is 409 dialog-unread; dialog-changed means a readable other step.
describe('O3 (0.5.4, QP): a step Claude draws next is proven by the strip, and a dialog nika cannot read is dialog-unread', () => {
  const shot = (extra = {}) => dialogWorld({ tabs: [TAB.project, TAB.shape, TAB.size], ...extra }); // the screenshot's flow: a plain step, then two preview steps
  const three = (extra = {}) => dialogWorld({ tabs: [TAB.project, TAB.mode, TAB.name], ...extra });

  test('(+) the screenshot: an answer on a plain step whose next step is a preview step is 200 next after one key, not 409 dialog-changed', async () => {
    const w = shot();
    ok(await w.answer({ picks: [2] }), 'next', 1);
    assert.deepEqual([w.i, w.phase], [1, 'ask']);
    assert.deepEqual(w.keysLog(), ['text:2']);
    safe(w);
  });

  test('(+) a next step nika cannot read (a clipped option) is `next` too: the strip proves the move', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode] });
    w.onKey = (n, world) => { if (n === 1) world.tabs[1].options[0].label = 'fast\u2026'; };
    ok(await w.answer({ picks: [1] }), 'next', 1);
    assert.equal(w.read().unreadable, 'clipped', 'the step Claude moved to is not readable');
    safe(w);
  });

  test('(+) a multi-select tab: Right to a step nika cannot read is `next`', async () => {
    const w = dialogWorld({ tabs: [TAB.tools, TAB.shape] });
    w.tabs[0].checked = [1];
    w.tabs[0].answered = true;
    ok(await w.answer({ picks: [1] }), 'next', 1);
    assert.deepEqual(w.keysLog(), ['Right']);
    assert.equal(w.i, 1);
    safe(w);
  });

  test('(+) the last question lands on the Review: `review`, as before', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode], v328: true });
    ok(await w.answer({ picks: [2] }), 'next', 1);
    ok(await w.answer({ picks: [1] }), 'review', 1);
    assert.equal(w.phase, 'review');
    safe(w);
  });

  test('(\u2212) the strip proves only the tab that was answered: another header, another answered mark or a step two on is not `next` (409 dialog-changed, sent 1)', async () => {
    const cases = {
      'another header': (world) => { world.tabs[2].header = 'Other'; },
      'an answered mark of another tab': (world) => { world.tabs[2].answered = true; },
      'two steps on (the person pressed Right too)': (world) => { world.i = 2; },
      'the answered tab is not marked': (world) => { world.tabs[0].answered = false; },
    };
    for (const [name, change] of Object.entries(cases)) {
      const w = three();
      w.onKey = (n, world) => { if (n === 1) change(world); };
      const r = await w.answer({ picks: [1] });
      assert.deepEqual([r.status, r.body.error, r.body.sent], [409, 'dialog-changed', 1], name);
      assert.deepEqual(w.keysLog(), ['text:1'], `${name}: no second key`);
    }
  });

  test('(\u2212) the key took but the screen is a dialog nika cannot read (no strip): 409 dialog-unread with sent 1, not dialog-changed', async () => {
    const w = three();
    w.onKey = (n, world) => { if (n === 1) world.phase = 'exit'; };
    assert.deepEqual(await w.answer({ picks: [1] }), { status: 409, body: { error: 'dialog-unread', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:1']);
  });

  test('(\u2212) a dialog nika cannot read at the start of a request: 409 dialog-unread, nothing sent (a narrow pane, the auto-mode nudge, an unknown overlay)', async () => {
    for (const make of [(w) => { w.cols = 40; }, (w) => { w.phase = 'nudge'; }, (w) => { w.phase = 'exit'; }]) {
      const w = dialogWorld();
      const sig = w.sig();
      make(w);
      assert.deepEqual(code(await w.answer({ picks: [1], sig })), [409, 'dialog-unread']);
      assert.deepEqual(w.log, []);
    }
  });

  test('(\u2212) the codes that stay: a stale sig is dialog-changed, a permission prompt after the key is no-dialog (and dialog-changed for a step move), nothing reaches the prompt', async () => {
    const stale = three();
    assert.deepEqual(code(await stale.answer({ picks: [1], sig: SIG })), [409, 'dialog-changed']);
    const prompt = three();
    prompt.onKey = (n, world) => { if (n === 1) world.phase = 'prompt'; };
    const r = await prompt.answer({ picks: [1] });
    assert.deepEqual([r.status, r.body.error, r.body.sent], [409, 'no-dialog', 1]);
    assert.deepEqual(prompt.leaks(), [], 'the prompt received nothing');
    const move = three();
    move.onKey = (n, world) => { if (n === 1) world.phase = 'prompt'; };
    assert.deepEqual(await move.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-changed', sent: 1 } });
  });

  test('(\u2212) moveTab: the dialog turns into one nika cannot read between the request\'s first look and its first round: 409 dialog-unread, no key; a closed dialog there is dialog-changed', async () => {
    const x = three();
    x.before = (n, world) => { if (n === 2) world.phase = 'exit'; }; // read 1 is the request's first look, read 2 the round's
    assert.deepEqual(await x.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-unread' } });
    assert.deepEqual(x.log, []);
    const closed = three();
    closed.before = (n, world) => { if (n === 2) { world.phase = 'idle'; world.result = 'closed in the terminal'; } };
    assert.deepEqual(await closed.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-changed' } });
    assert.deepEqual(closed.log, []);
  });

  test('(+) moveTab: a step it moved to that nika cannot read is still where it is going (the strip is all a move reads); the dialog that goes unreadable is dialog-unread with sent', async () => {
    const w = shot();
    assert.deepEqual((await w.answer({ tab: 1 })).body, { done: 'moved', sent: 1 });
    assert.equal(w.i, 1);
    const x = three();
    x.onKey = (n, world) => { if (n === 1) world.phase = 'exit'; };
    assert.deepEqual(await x.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-unread', sent: 1 } });
    assert.deepEqual(x.keysLog(), ['Right']);
  });
});

// ---- 0.5.4, QP: a question step with a preview (Claude Code 2.1.328): focus, answer, note, Chat, Decline, End and a step move (design-053-qp sections 5 to 7, 10.2) ----
describe('a question step with a preview (0.5.4, QP): the route', () => {
  const V = 'fedcba9876543210';
  const pv = (o = {}) => dialogWorld({ tabs: [TAB.project, TAB.shape, TAB.size], i: 1, mem: PLAIN, ...o });
  const answerPv = (w, picks, extra = {}) => w.answer({ picks, view: w.view(), ...extra });
  /** What may go out on a preview step: Down, Up, Enter, Right (a step move), Escape (a Decline only), `n` and a note as text. Never a digit, a paste, two things at once. */
  function safePv(w, { escape = false } = {}) {
    assert.deepEqual(w.leaks(), [], 'no key after the dialog closed');
    for (const e of w.log.filter((x) => !x.failed)) {
      assert.equal(e.paste, undefined, 'no paste');
      assert.ok(!(e.keys && e.text !== undefined), 'one thing per request');
      assert.ok(e.keys === undefined || e.keys.length === 1, 'one key per request');
      for (const k of e.keys ?? []) {
        assert.ok(['Down', 'Up', 'Enter', 'Right', 'Escape'].includes(k), `never ${k}`);
        if (k === 'Escape') assert.ok(escape, 'Escape only for a Decline');
      }
      if (typeof e.text === 'string') assert.ok(!/^[1-9]$/.test(e.text), 'a digit is never sent on a preview step (it only moves the focus there)');
    }
  }

  test('(+) shapes: the four bodies of a preview step are valid', () => {
    for (const b of [{ sig: SIG, focus: 3 }, { sig: SIG, focus: 1 }, { sig: SIG, focus: 7 }, { sig: SIG, chat: true }, { sig: SIG, view: V, picks: [3] }, { sig: SIG, view: V, picks: [3], note: 'short note' }, { sig: SIG, view: V, picks: [1], note: 'a'.repeat(TEXT_MAX) }]) {
      assert.equal(checkDialogBody(b), null, JSON.stringify(b));
    }
  });

  test('(\u2212) shapes: a focus outside 1 to 7, chat that is not true, a view that is not 16 lowercase hex, two picks, a note with a leading digit, a control, an edge space or over 300 characters', () => {
    const bad = [
      { sig: SIG, focus: 0 }, { sig: SIG, focus: 8 }, { sig: SIG, focus: '2' }, { sig: SIG, focus: 1.5 }, { sig: SIG, focus: null }, { sig: SIG, focus: 2, view: V }, { sig: SIG, focus: 2, picks: [2] },
      { sig: SIG, chat: false }, { sig: SIG, chat: 1 }, { sig: SIG, chat: 'true' }, { sig: SIG, chat: true, focus: 2 }, { sig: SIG, chat: true, picks: [1] },
      { sig: SIG, view: 'xyz', picks: [1] }, { sig: SIG, view: V.toUpperCase(), picks: [1] }, { sig: SIG, view: `${V}0`, picks: [1] }, { sig: SIG, view: 5, picks: [1] }, { sig: SIG, view: V },
      { sig: SIG, view: V, picks: [1, 2] }, { sig: SIG, view: V, picks: [] }, { sig: SIG, view: V, picks: [1], text: 'x' },
      { sig: SIG, note: 'x', picks: [1] }, { sig: SIG, note: 'x', view: V }, { sig: SIG, view: V, picks: [1], note: '1 first' }, { sig: SIG, view: V, picks: [1], note: 'a\nb' },
      { sig: SIG, view: V, picks: [1], note: ' a' }, { sig: SIG, view: V, picks: [1], note: 'a ' }, { sig: SIG, view: V, picks: [1], note: '' }, { sig: SIG, view: V, picks: [1], note: 'a'.repeat(TEXT_MAX + 1) },
      { sig: SIG, view: V, picks: [1], note: 7 }, { sig: SIG, view: V, picks: [1], note: 'a\u202eb' }, { sig: SIG, view: V, picks: [1], extra: 1 }, { sig: SIG, focus: 2, extra: 1 },
    ];
    for (const b of bad) assert.equal(checkDialogBody(b)?.status, 400, JSON.stringify(b));
  });

  test('(\u2212) on a plain step the four new bodies are 400 invalid, nothing sent', async () => {
    const w = dialogWorld();
    for (const body of [{ focus: 2 }, { chat: true }, { view: V, picks: [1] }, { view: V, picks: [1], note: 'x' }]) assert.deepEqual(code(await w.answer(body)), [400, 'invalid'], JSON.stringify(body));
    assert.deepEqual(w.log, []);
  });

  test('(\u2212) on a preview step: picks without a view and text are 400 invalid, a pick beyond the options too; nothing sent', async () => {
    const w = pv();
    for (const body of [{ picks: [1] }, { picks: [], text: 'x' }, { picks: [1], text: 'x' }, { picks: [4], view: w.view() }, { focus: 4 }]) assert.deepEqual(code(await w.answer(body)), [400, 'invalid'], JSON.stringify(body));
    assert.deepEqual(w.log, []);
  });

  test('(\u2212) the notes field is open: 409 notes-open for every shape (a Decline and a step move too), nothing sent', async () => {
    const w = pv();
    w.tabs[1].noteOpen = true;
    for (const body of [{ focus: 3 }, { picks: [1], view: w.view() }, { picks: [1], view: w.view(), note: 'x' }, { chat: true }, { cancel: true }, { tab: 2 }]) {
      assert.deepEqual(code(await w.answer(body)), [409, 'notes-open'], JSON.stringify(body));
    }
    assert.deepEqual(w.log, []);
  });

  test('(\u2212) the view of the page is not the screen\'s: 409 preview-changed, nothing sent (a preview row, the hidden count, the fallback, the focus or a note changed)', async () => {
    const changes = [(w) => { w.tabs[1].preview.rows[0] = ['( oval )', 'x']; }, (w) => { w.tabs[1].preview.hidden = 3; }, (w) => { w.tabs[1].preview.fallback = true; },
      (w) => { w.focus = 2; w.lastOption = 2; }, (w) => { w.tabs[1].note = 'typed in the terminal'; }];
    for (const change of changes) {
      const w = pv();
      const view = w.view();
      change(w);
      assert.deepEqual(code(await w.answer({ picks: [1], view })), [409, 'preview-changed'], String(change));
      assert.deepEqual(w.log, []);
    }
  });

  test('(\u2212) bypass in a preview row, in the note on screen or in the body\'s note: 400 terminal-only, nothing sent; a Decline stays', async () => {
    const row = pv();
    row.tabs[1].preview.rows[0] = ['bypass permissions'];
    for (const body of [{ picks: [1], view: row.view() }, { focus: 2 }, { chat: true }]) assert.deepEqual(code(await row.answer(body)), [400, 'terminal-only'], JSON.stringify(body));
    assert.deepEqual(row.log, []);
    const saved = pv();
    saved.tabs[1].note = 'no bypass please';
    assert.deepEqual(code(await answerPv(saved, [1])), [400, 'terminal-only']);
    assert.deepEqual(saved.log, []);
    const typed = pv();
    assert.deepEqual(code(await answerPv(typed, [1], { note: 'bypass this' })), [400, 'terminal-only']);
    assert.deepEqual(typed.log, []);
    ok(await row.answer({ cancel: true }), 'declined', 1);
    safePv(row, { escape: true });
  });

  test('(\u2212) a note when the step already shows one: 400 invalid, nothing sent; the answer without a note keeps the one on screen', async () => {
    const w = pv();
    w.tabs[1].note = 'saved earlier';
    assert.deepEqual(code(await answerPv(w, [1], { note: 'x' })), [400, 'invalid']);
    assert.deepEqual(w.log, []);
    ok(await answerPv(w, [1]), 'next', 1);
    assert.equal(w.tabs[1].note, 'saved earlier');
    safePv(w);
  });

  test('(\u2212) a note on a pane not known plain, or known to be vim: 409 note-mode, nothing sent; an answer without a note goes out', async () => {
    for (const mem of [{ vim: false, plain: false }, { vim: true, plain: false }, { vim: true, plain: true }]) {
      const w = pv({ mem });
      assert.deepEqual(code(await answerPv(w, [1], { note: 'round it' })), [409, 'note-mode'], JSON.stringify(mem));
      assert.deepEqual(w.log, []);
    }
    const w = pv({ mem: { vim: true, plain: false } });
    ok(await answerPv(w, [1]), 'next', 1);
  });

  test('(+) focus: Down twice from 1 to 3, Up twice from 3 to 1, one Up from Chat to the last option and two to the one before it', async () => {
    const down = pv();
    ok(await down.answer({ focus: 3 }), 'focused', 2);
    assert.deepEqual([down.keysLog(), down.focus], [['Down', 'Down'], 3]);
    const up = pv({ focus: 3, lastOption: 3 });
    ok(await up.answer({ focus: 1 }), 'focused', 2);
    assert.deepEqual([up.keysLog(), up.focus], [['Up', 'Up'], 1]);
    const chat = pv({ focus: 'chat', lastOption: 3 });
    ok(await chat.answer({ focus: 3 }), 'focused', 1);
    assert.deepEqual([chat.keysLog(), chat.focus], [['Up'], 3]);
    const chat2 = pv({ focus: 'chat', lastOption: 3 });
    ok(await chat2.answer({ focus: 2 }), 'focused', 2);
    assert.deepEqual([chat2.keysLog(), chat2.focus], [['Up', 'Up'], 2]);
    for (const w of [down, up, chat, chat2]) { safePv(w); assert.equal(w.i, 1, 'nothing was answered'); }
  });

  test('(+) focus: already there is 200 focused with sent 0 and no key (never an Up at 1, never a Down at the last option)', async () => {
    const one = pv();
    assert.deepEqual(await one.answer({ focus: 1 }), { status: 200, body: { done: 'focused', sent: 0 } });
    const last = pv({ focus: 3, lastOption: 3 });
    assert.deepEqual(await last.answer({ focus: 3 }), { status: 200, body: { done: 'focused', sent: 0 } });
    assert.deepEqual([one.log, last.log], [[], []]);
  });

  test('(\u2212) focus: the person moves it in the terminal between two keys: 409 dialog-focus with sent, no more keys; the person opens notes: notes-open with sent', async () => {
    const moved = pv();
    moved.before = (n, world) => { if (n === 4) { world.focus = 1; world.lastOption = 1; } }; // read, round 1, the settle read, then round 2's fresh read
    assert.deepEqual(await moved.answer({ focus: 3 }), { status: 409, body: { error: 'dialog-focus', sent: 1 } });
    assert.deepEqual(moved.keysLog(), ['Down']);
    const open = pv();
    open.before = (n, world) => { if (n === 4) world.tabs[1].noteOpen = true; };
    assert.deepEqual(await open.answer({ focus: 3 }), { status: 409, body: { error: 'notes-open', sent: 1 } });
    assert.deepEqual(open.keysLog(), ['Down']);
  });

  test('(\u2212) focus: a key that does not take is 409 not-taken (not repeated); a failed send passes its status through', async () => {
    const lost = pv();
    lost.drop = (b, n) => n === 1;
    assert.deepEqual(await lost.answer({ focus: 2 }), { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(lost.keysLog(), ['Down']);
  });

  test('(+) answer: Enter takes the pick that has the focus and goes to the next step; the last question goes to the review', async () => {
    const w = pv({ focus: 2, lastOption: 2 });
    ok(await answerPv(w, [2]), 'next', 1);
    assert.deepEqual([w.keysLog(), w.tabs[1].picked, w.i], [['Enter'], 2, 2]);
    ok(await answerPv(w, [1]), 'review', 1);
    assert.equal(w.phase, 'review');
    safePv(w);
  });

  test('(\u2212) answer: a pick that does not have the focus is 409 dialog-focus (nothing sent); with Chat focused too, even for the option Chat\'s pointer came from', async () => {
    const w = pv({ focus: 2, lastOption: 2 });
    assert.deepEqual(code(await answerPv(w, [1])), [409, 'dialog-focus']);
    const chat = pv({ focus: 'chat', lastOption: 3 });
    assert.deepEqual(code(await answerPv(chat, [3])), [409, 'dialog-focus'], 'Chat has a pointer and so has option 3: Enter would choose Chat');
    assert.deepEqual([w.log, chat.log], [[], []]);
  });

  test('(\u2212) answer: the preview changes between the read and the Enter: 409 preview-changed with nothing sent (the check is on the screen right before the key)', async () => {
    const w = pv();
    w.before = (n, world) => { if (n === 2) world.tabs[1].preview.rows[0] = ['changed']; };
    assert.deepEqual(code(await answerPv(w, [1])), [409, 'preview-changed']);
    assert.deepEqual(w.log, []);
  });

  test('(+) note: `n`, the note and Enter on a pane known plain: the note is typed in Claude\'s field and the step is answered', async () => {
    const w = pv({ focus: 2, lastOption: 2 });
    ok(await answerPv(w, [2], { note: 'make it round' }), 'next', 3);
    assert.deepEqual(w.keysLog(), ['text:n', 'text:make it round', 'Enter']);
    assert.deepEqual([w.tabs[1].note, w.tabs[1].picked, w.i], ['make it round', 2, 2]);
    safePv(w);
  });

  test('(\u2212) note: `n` that does not take is 409 not-taken and the note is not typed; a note that reads back differently is 409 note-mismatch and no Enter goes out', async () => {
    const lost = pv();
    lost.drop = (b) => b.text === 'n';
    assert.deepEqual(await answerPv(lost, [1], { note: 'round it' }), { status: 409, body: { error: 'not-taken', sent: 1 } });
    assert.deepEqual(lost.keysLog(), ['text:n']);
    const mangled = pv();
    mangled.mangle = (t) => t.toUpperCase();
    assert.deepEqual(await answerPv(mangled, [1], { note: 'round it' }), { status: 409, body: { error: 'note-mismatch', sent: 2 } });
    assert.deepEqual(mangled.keysLog(), ['text:n', 'text:round it']);
    assert.equal(mangled.tabs[1].noteOpen, true, 'the field stays open for the person (nika never sends Escape there)');
    safePv(mangled);
  });

  test('(\u2212) note: the preview changes after the note was typed: 409 preview-changed with sent, no Enter', async () => {
    const w = pv();
    w.onKey = (n, world) => { if (n === 2) world.tabs[1].preview.hidden = 7; };
    assert.deepEqual(await answerPv(w, [1], { note: 'round it' }), { status: 409, body: { error: 'preview-changed', sent: 2 } });
    assert.deepEqual(w.keysLog(), ['text:n', 'text:round it']);
  });

  test('(\u2212) note: the field was opened in the terminal before `n` would go: 409 notes-open, the keys that went out are counted', async () => {
    const w = pv();
    w.before = (n, world) => { if (n === 2) world.tabs[1].noteOpen = true; }; // the first round's fresh read
    assert.deepEqual(await answerPv(w, [1], { note: 'round it' }), { status: 409, body: { error: 'notes-open' } });
    assert.deepEqual(w.log, []);
  });

  test('(\u2212) note: after nika\'s own `n` the person closes the field or types into it in the terminal: 409 dialog-touched with sent 1, `n` is not pressed again, no text, no Enter', async () => {
    for (const [name, change] of [['closes the field', (world) => { world.tabs[1].noteOpen = false; }], ['types into it', (world) => { world.tabs[1].noteText = 'x'; }]]) {
      const w = pv();
      w.before = (n, world) => { if (n === 4) change(world); }; // read, round 1, the settle read after `n`, round 2's fresh read
      assert.deepEqual(await answerPv(w, [1], { note: 'round it' }), { status: 409, body: { error: 'dialog-touched', sent: 1 } }, name);
      assert.deepEqual(w.keysLog(), ['text:n'], name);
    }
  });

  test('(\u2212) note: the `n` takes but not as expected (text appears in the field at once, the focus moves, the preview changes): 409 not-taken with sent 1 and nothing typed after it', async () => {
    const changes = [(world) => { world.tabs[1].noteText = 'x'; }, (world) => { world.focus = 2; world.lastOption = 2; }, (world) => { world.tabs[1].preview.rows[0] = ['changed']; }];
    for (const change of changes) {
      const w = pv();
      w.tabs[1].preview.rows[1] = [...w.tabs[1].preview.rows[0]]; // two options with the same preview: only the focus tells the move
      w.onKey = (n, world) => { if (n === 1) change(world); };
      assert.deepEqual(await answerPv(w, [1], { note: 'round it' }), { status: 409, body: { error: 'not-taken', sent: 1 } }, String(change));
      assert.deepEqual(w.keysLog(), ['text:n'], String(change));
    }
  });

  test('(\u2212) note: the note is typed but the field is no longer open on the next read (closed in the terminal with the text kept): 409 note-mismatch with sent 2, no Enter', async () => {
    const w = pv();
    w.onKey = (n, world) => { if (n === 2) { world.tabs[1].noteOpen = false; world.tabs[1].note = 'round it'; } };
    assert.deepEqual(await answerPv(w, [1], { note: 'round it' }), { status: 409, body: { error: 'note-mismatch', sent: 2 } });
    assert.deepEqual(w.keysLog(), ['text:n', 'text:round it']);
  });

  test('(\u2212) focus, Chat and note: the dialog closes while a key is settling (a Decline in the terminal): the answer is the 409 of the lost dialog, never a thrown error, no more keys', async () => {
    const cases = [[{ focus: 3 }, 1, ['Down']], [{ chat: true }, 1, ['Down']], [{ picks: [1], note: 'round it' }, 1, ['text:n']], [{ picks: [1], note: 'round it' }, 2, ['text:n', 'text:round it']]];
    for (const [body, at, keys] of cases) {
      const w = pv();
      w.onKey = (n, world) => { if (n === at) world.phase = 'idle'; };
      const r = await w.answer(body.picks ? { ...body, view: w.view() } : body);
      assert.deepEqual([r.status, r.body.error, r.body.sent], [409, 'no-dialog', at], JSON.stringify(body));
      assert.deepEqual(w.keysLog(), keys, JSON.stringify(body));
    }
  });

  test('(+) Chat: Down to Chat, each proven, then Enter: the dialog is gone and the answer is 200 chat', async () => {
    const w = pv();
    ok(await w.answer({ chat: true }), 'chat', 4);
    assert.deepEqual(w.keysLog(), ['Down', 'Down', 'Down', 'Enter']);
    assert.deepEqual([w.phase, w.result], ['idle', 'chat']);
    const at = pv({ focus: 'chat', lastOption: 3 });
    ok(await at.answer({ chat: true }), 'chat', 1);
    assert.deepEqual(at.keysLog(), ['Enter']);
    safePv(w);
    assert.deepEqual(w.leaks(), []);
  });

  test('(\u2212) Chat: Enter goes only after a fresh read shows the focus on Chat (a lost Down is not-taken, no Enter); an Enter that does not close the dialog is not-taken', async () => {
    const lost = pv();
    lost.drop = (b, n) => n === 3;
    assert.deepEqual(await lost.answer({ chat: true }), { status: 409, body: { error: 'not-taken', sent: 3 } });
    assert.deepEqual(lost.keysLog(), ['Down', 'Down', 'Down']);
    const stays = pv({ focus: 'chat', lastOption: 3 });
    stays.drop = (b) => b.keys?.[0] === 'Enter';
    assert.deepEqual(await stays.answer({ chat: true }), { status: 409, body: { error: 'not-taken', sent: 1 } });
  });

  // QP round 1 (review N6): Chat's Enter counts as taken only when the dialog is gone, no prompt parses AND the screen is not unknown (an input box or a mode line is back)
  test('(\u2212) Chat: after Enter the screen shows no dialog nika finds, no prompt and no input box (a dialog may still be drawn): 409 with sent 1, never 200 chat', async () => {
    const w = pv({ focus: 'chat', lastOption: 3 });
    w.onKey = (n, world) => {
      world.screen = () => ({ rows: [[span('Some output that is no dialog and no prompt')], [], [span('and no input box either')]], cursor: { x: 0, y: 0, visible: true }, cols: world.cols });
    };
    const r = await w.answer({ chat: true });
    assert.deepEqual(r, { status: 409, body: { error: 'dialog-unread', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Enter']);
    safePv(w);
  });

  test('(+) Decline: Escape closes the step when the notes field is closed (as on any step)', async () => {
    const w = pv();
    ok(await w.answer({ cancel: true }), 'declined', 1);
    assert.deepEqual(w.keysLog(), ['Escape']);
    safePv(w, { escape: true });
  });

  test('(+) End: with the notes field closed it declines as on any dialog; with the field open it is 409 notes-open and no Escape goes out', async () => {
    const closed = pv();
    assert.deepEqual(code(await closed.ctl.endSession('%2')), [409, 'not-idle']);
    assert.deepEqual(closed.keysLog(), ['Escape']);
    const open = pv();
    open.tabs[1].noteOpen = true;
    assert.deepEqual(code(await open.ctl.endSession('%2')), [409, 'notes-open']);
    assert.deepEqual(open.log, []);
  });

  test('(+) moveTab: Right from an option row of a preview step; from Chat one Up first (the strip cannot see Chat\'s focus), then Right', async () => {
    const a = pv();
    assert.deepEqual((await a.answer({ tab: 2 })).body, { done: 'moved', sent: 1 });
    assert.deepEqual([a.keysLog(), a.i], [['Right'], 2]);
    const c = pv({ focus: 'chat', lastOption: 3 });
    assert.deepEqual((await c.answer({ tab: 2 })).body, { done: 'moved', sent: 2 });
    assert.deepEqual([c.keysLog(), c.i], [['Up', 'Right'], 2]);
    for (const w of [a, c]) safePv(w);
  });

  test('(\u2212) moveTab: the notes field opens between two rounds: 409 notes-open with sent and no Up or Right after; a preview step that turns unreadable with Chat focused: dialog-unread and no Up', async () => {
    const open = pv({ focus: 'chat', lastOption: 3 });
    open.before = (n, world) => { if (n === 4) world.tabs[1].noteOpen = true; }; // read, round 1, the settle after its Up, round 2
    assert.deepEqual(await open.answer({ tab: 2 }), { status: 409, body: { error: 'notes-open', sent: 1 } });
    assert.deepEqual(open.keysLog(), ['Up']);
    const unread = pv({ focus: 'chat', lastOption: 3 });
    unread.before = (n, world) => { if (n === 2) world.tabs[1].options[0].label = 'Oval\u2026'; }; // clipped: the step is no longer read whole
    assert.deepEqual(await unread.answer({ tab: 2 }), { status: 409, body: { error: 'dialog-unread' } });
    assert.deepEqual(unread.log, []);
  });
});
