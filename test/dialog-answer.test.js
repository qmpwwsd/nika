// answerDialog (nika 0.5, W1-T2, design W1 section 4): the route that answers Claude's question and plan dialogs, one step per request.
// The real step machine runs against test/dialog-fake.js (a fake screen that changes the way Claude does after each key). Every "never
// sent" case asserts on the fake's key log; `safe(w)` asserts, after most cases, what must never go out. Synthetic text only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkDialogBody } from '../src/session-control.js';
import { STEPS_MAX, TEXT_MAX } from '../src/dialog.js';
import { dialogWorld, TAB } from './dialog-fake.js';

const SIG = '0123456789abcdef';
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
    const w = dialogWorld({ focus: 4 });
    ok(await w.answer({ picks: [], text: 'two  spaces here' }), 'submitted', 2);
    safe(w);
  });

  test('(+) resumable: the focus already on the text row types and enters; the text already typed only enters; the xor needs nothing more', async () => {
    const onText = dialogWorld({ focus: 4 });
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
  const review = (answered) => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.tools], phase: 'review' });
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

  test('(−) a dialog nika cannot read exactly: a narrow pane, a survey, "Exit plan mode?", the auto-mode nudge, an unknown overlay: 409 dialog-changed', async () => {
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
      assert.deepEqual(code(await w.answer({ picks: [1], sig })), [409, 'dialog-changed'], name);
      assert.deepEqual(w.log, [], name);
    }
  });

  test('(−) a capture without the pane width cannot be read exactly: 409 dialog-changed', async () => {
    const w = dialogWorld();
    const sig = w.sig();
    const capture = w.mirror.capture;
    w.mirror.capture = async () => { const r = await capture(); return { status: 200, body: { ...r.body, cols: undefined } }; };
    assert.deepEqual(code(await w.answer({ picks: [1], sig })), [409, 'dialog-changed']);
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

  test('(−) a single tab that is already answered (someone went back to it in the terminal): 409 dialog-touched', async () => {
    const w = dialogWorld({ tabs: [TAB.project, TAB.mode] });
    w.tabs[0].answered = true;
    w.tabs[0].picked = 2;
    assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'dialog-touched']);
    assert.deepEqual(w.log, []);
  });

  test('(−) the text row holds text when a pick is wanted, or other text than the wanted one: 409 dialog-touched', async () => {
    const w = dialogWorld({ focus: 2 });
    w.tabs[0].text = 'typed in the terminal';
    assert.deepEqual(code(await w.answer({ picks: [1] })), [409, 'dialog-touched']);
    assert.deepEqual(code(await w.answer({ picks: [], text: 'something else' })), [409, 'dialog-touched']);
    assert.deepEqual(w.log, []);
  });

  test('(−) vim NORMAL on the text row (no INSERT, vim known): 409 text-mode, no text typed; a pane known to be plain does type', async () => {
    const normal = dialogWorld({ vim: true, focus: 4, vimMode: 'normal', mem: { vim: true, plain: false } });
    assert.deepEqual(code(await normal.answer({ picks: [], text: 'beta' })), [409, 'text-mode']);
    assert.deepEqual(normal.log, []);
  });

  test('(−) the pane is vim (INSERT was seen during this request) and the user pressed Escape on the text row: 409 text-mode after the Down, nothing typed, no Enter', async () => {
    const w = dialogWorld({ vim: true, focus: 3 });
    w.before = (n) => { if (n === 4) w.vimMode = 'normal'; }; // reads: 1 first, 2 before the Down, 3 after it (INSERT shows), 4 before the text
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'text-mode', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['Down']);
    safe(w);
  });

  test('(−) vim never seen by nika and NORMAL on the text row: the letters would be vim commands, they do not read back: 409 text-mismatch, and no Enter', async () => {
    const w = dialogWorld({ vim: true, focus: 4, vimMode: 'normal' });
    const r = await w.answer({ picks: [], text: 'beta' });
    assert.deepEqual(r, { status: 409, body: { error: 'text-mismatch', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:beta']);
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
    const w = dialogWorld({ focus: 4 });
    w.mangle = (t) => t.replace('e', '3');
    assert.deepEqual(await w.answer({ picks: [], text: 'beta' }), { status: 409, body: { error: 'text-mismatch', sent: 1 } });
    assert.deepEqual(w.keysLog(), ['text:beta']);
    safe(w);
  });

  test('(−) typed text that does not show at all: 409 text-mismatch', async () => {
    const w = dialogWorld({ focus: 4 });
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

  test('(−) STEPS_MAX: a toggle that takes and is undone again and again stops after 24 keys with 409 not-taken', async () => {
    const w = dialogWorld({ tabs: [TAB.tools] });
    // captures: 1 first read; then per round a read before the key (even) and the settle read after it (odd)
    w.before = (n) => { w.tabs[0].checked = n % 2 === 0 || n === 1 ? [] : [1]; };
    const r = await w.answer({ picks: [1] });
    assert.deepEqual(r, { status: 409, body: { error: 'not-taken', sent: STEPS_MAX } });
    assert.equal(w.log.length, STEPS_MAX);
    assert.equal(STEPS_MAX, 24);
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
