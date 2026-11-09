// public/quick-actions.js: the pure rules behind the session window's quick actions, prompt buttons, End dialog and Shell mode.
// Design and exact copy: docs/design/spec.md section 9.4 (states table, command-route failures), 9.5 (answer results), 9.6 (Shell),
// 9.8 (End dialog). Contract: docs/contracts/api-app.md section 3. No DOM here: session.js and end-dialog.js only draw what these return.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_NAME } from '../src/ids.js';
import {
  quickState, cleanPrompt, isBypassLabel, answerOutcome, escOutcome, promptOff, promptNote, commandFailure, endOutcome, endNote, planShell, problemKind,
} from '../public/quick-actions.js';

const DOTS = '…';
const FOUR = ['compact', 'clear', 'model', 'rewind'];
const offs = (st, names) => names.every((n) => st[n].off === true);
const lives = (st, names) => names.every((n) => st[n].off === false);
const PROMPT = { question: 'Do you want to proceed?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] };

describe('quickState: the spec 9.4 states table, first matching row wins', () => {
  test('(+) Claude waiting, empty box: Stop is off, the four are live, End is live, no reason line', () => {
    const st = quickState({ status: 'idle' });
    assert.equal(st.stop.off, true);
    assert.equal(st.stop.title, 'Nothing to stop: Claude is waiting');
    assert.ok(lives(st, [...FOUR, 'end']));
    assert.equal(st.reason, '');
  });

  test('(+) Claude working: only Stop and End are live; the reason says when the others come back', () => {
    const st = quickState({ status: 'busy' });
    assert.equal(st.stop.off, false);
    assert.equal(st.stop.title, 'Press Esc in the pane: ends this turn, keeps the work, also stops running subagents');
    assert.ok(offs(st, FOUR));
    assert.equal(st.end.off, false);
    assert.equal(st.reason, 'Compact, Clear, Model and Rewind are ready when Claude waits for you.');
    for (const n of FOUR) assert.equal(st[n].title, 'Available when Claude is waiting for you', n);
  });

  test('(+) Claude waiting, text in the message box: Rewind alone is off, with its own title and reason', () => {
    const st = quickState({ status: 'idle', composerEmpty: false });
    assert.ok(lives(st, ['compact', 'clear', 'model', 'end']));
    assert.equal(st.rewind.off, true);
    assert.equal(st.rewind.title, 'Empty the message box first');
    assert.equal(st.reason, 'Rewind needs an empty message box.');
  });

  test('(+) a live title for every live button (the hover text the spec lists)', () => {
    const st = quickState({ status: 'idle' });
    assert.equal(st.compact.title, 'Types /compact and Enter: summarises the conversation to free context');
    assert.equal(st.clear.title, 'Types /clear and Enter after you confirm');
    assert.equal(st.rewind.title, "Esc Esc on an empty prompt: opens Claude's rewind menu in the terminal");
    assert.equal(st.model.title, 'Switch the model');
    assert.equal(st.end.title, 'Claude exits and the pane closes');
  });

  test('(+) Needs you with the prompt panel: Stop and the four are off, End stays live, Esc = No is pointed to', () => {
    const st = quickState({ status: 'attn', prompt: PROMPT });
    assert.ok(offs(st, ['stop', ...FOUR]));
    assert.equal(st.stop.title, 'Esc = No is in the prompt panel');
    assert.equal(st.end.off, false);
    assert.equal(st.reason, 'Answer the prompt first. Esc = No is in the prompt panel.');
  });

  test('(+) Needs you with an unknown layout (prompt null): the plain line, End live', () => {
    const st = quickState({ status: 'attn', prompt: null });
    assert.ok(offs(st, ['stop', ...FOUR]));
    assert.equal(st.end.off, false);
    assert.equal(st.reason, 'Answer the prompt first.');
  });

  test('(+) a prompt on screen wins over a stale status', () => {
    const st = quickState({ status: 'busy', prompt: PROMPT });
    assert.equal(st.stop.off, true, 'the panel carries Esc = No');
    assert.equal(st.reason, 'Answer the prompt first. Esc = No is in the prompt panel.');
  });

  test('(+) pane gone, tmux error, no capture yet: everything is off including End, each with its own line', () => {
    const rows = { gone: ['The pane is gone.', 'The pane is gone'], tmux: ["nika couldn't reach tmux.", "nika couldn't reach tmux."], connecting: [`Connecting to the pane${DOTS}`, `Connecting to the pane${DOTS}`] };
    for (const [pane, [reason, endTitle]] of Object.entries(rows)) {
      const st = quickState({ pane, status: 'idle' });
      assert.ok(offs(st, ['stop', ...FOUR, 'end']), pane);
      assert.equal(st.reason, reason, pane);
      assert.equal(st.end.title, endTitle, pane);
    }
  });

  test('(−) a pane that is not ok wins over Claude working or a prompt', () => {
    assert.equal(quickState({ pane: 'gone', status: 'busy', prompt: PROMPT }).stop.off, true);
    assert.equal(quickState({ pane: 'gone', status: 'busy', prompt: PROMPT }).reason, 'The pane is gone.');
  });

  test('(+) a mode switch in flight turns the four off with no extra line; End stays live', () => {
    const st = quickState({ status: 'idle', switching: true });
    assert.ok(offs(st, FOUR));
    assert.equal(st.end.off, false);
    assert.equal(st.reason, '');
  });

  test('(−) status unknown (no agent yet) or ended: Stop is off; unknown leaves the server to decide, ended is treated as not waiting', () => {
    const unknown = quickState({ status: null });
    assert.equal(unknown.stop.off, true);
    assert.ok(lives(unknown, FOUR), 'the route answers 409 not-idle when it is wrong');
    const ended = quickState({ status: 'ended' });
    assert.ok(offs(ended, ['stop', ...FOUR]));
  });

  test('(+) Stop is live in exactly one case: working with the pane ok and no prompt', () => {
    for (const pane of ['ok', 'gone', 'tmux', 'connecting']) {
      for (const status of [null, 'idle', 'busy', 'attn', 'ended']) {
        for (const prompt of [null, PROMPT]) {
          const live = quickState({ pane, status, prompt }).stop.off === false;
          assert.equal(live, pane === 'ok' && status === 'busy' && prompt === null, `${pane} ${status} ${prompt ? 'prompt' : 'no prompt'}`);
        }
      }
    }
  });

  test('(−) defaults give the connecting-free "ok, waiting" row and an empty call does not throw', () => {
    assert.doesNotThrow(() => quickState());
    assert.equal(quickState().stop.off, true);
  });
});

describe('cleanPrompt and isBypassLabel', () => {
  test('(+) a good prompt passes through with a bypass flag on each option', () => {
    const p = cleanPrompt({ question: 'Do you want to proceed?', sig: 'abcdef0123456789', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, and bypass permissions for this session' }, { n: 3, label: 'No' }] });
    assert.equal(p.question, 'Do you want to proceed?');
    assert.equal(p.sig, 'abcdef0123456789');
    assert.deepEqual(p.options.map((o) => [o.n, o.label, o.bypass]), [[1, 'Yes', false], [2, 'Yes, and bypass permissions for this session', true], [3, 'No', false]]);
  });

  test('(+) "bypass" in any case marks an option; other words do not', () => {
    for (const s of ['Yes, and bypass permissions', 'BYPASS', 'ByPass mode', 'bypassPermissions']) assert.equal(isBypassLabel(s), true, s);
    for (const s of ['Yes', 'No', 'bypa ss', 'pass', '']) assert.equal(isBypassLabel(s), false, s);
  });

  test('(−) null, wrong types, a bad sig or no usable option give null (no panel, no buttons)', () => {
    const base = { question: 'q?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }] };
    for (const bad of [null, undefined, 'x', 3, [], {}, { ...base, sig: 'ABCDEF0123456789' }, { ...base, sig: '0123' }, { ...base, sig: 12 }, { ...base, question: 7 }, { ...base, options: 'x' },
      { ...base, options: [] }, { ...base, options: [{ n: 0, label: 'x' }] }, { ...base, options: [{ n: 10, label: 'x' }] }, { ...base, options: [{ n: 1.5, label: 'x' }] }, { ...base, options: [{ n: '1', label: 'x' }] },
      { ...base, options: [{ n: 1, label: 5 }] }, { ...base, options: [null] }]) {
      assert.equal(cleanPrompt(bad), null, JSON.stringify(bad));
    }
  });

  test('(−) one bad option is dropped, the good ones stay; the bypass check sees the whole label, not the clipped one', () => {
    const long = `${'x'.repeat(250)} bypass`;
    const p = cleanPrompt({ question: 'q?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }, { n: 'two', label: 'x' }, { n: 3, label: long }] });
    assert.deepEqual(p.options.map((o) => o.n), [1, 3]);
    assert.equal(p.options[1].bypass, true);
    assert.ok(p.options[1].label.length <= 200);
  });

  test('(−) the result is a copy: the capture object is not kept or changed', () => {
    const raw = { question: 'q?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }], extra: 'x' };
    const p = cleanPrompt(raw);
    assert.notEqual(p, raw);
    assert.equal('extra' in p, false);
    assert.equal('bypass' in raw.options[0], false);
  });
});

describe('answerOutcome (spec 9.5 results table)', () => {
  const row = (status, code) => answerOutcome({ status, code });

  test('(+) 200: no message, the buttons stay off until the question changes', () => {
    assert.deepEqual(row(200), { message: '', lock: true });
  });

  test('(+) 409 prompt-changed: the plain message and the lock; 409 already-answered: nothing new but the lock', () => {
    assert.deepEqual(row(409, 'prompt-changed'), { message: 'The question changed; check the session.', lock: true });
    assert.deepEqual(row(409, 'already-answered'), { message: '', lock: true });
  });

  test('(+) every other answer re-enables the buttons: no-prompt, busy-switching, 429, 404, 5xx, network, 400', () => {
    assert.deepEqual(row(409, 'no-prompt'), { message: 'The question is gone.', lock: false });
    assert.deepEqual(row(409, 'busy-switching'), { message: 'Another action is running on this session.', lock: false });
    assert.deepEqual(row(429), { message: 'Too many keys at once; try again.', lock: false });
    assert.deepEqual(row(404), { message: 'The session is gone.', lock: false });
    for (const s of [500, 502, 503, 0]) assert.deepEqual(row(s), { message: "nika couldn't reach tmux.", lock: false }, String(s));
    assert.deepEqual(row(400, 'invalid'), { message: "nika couldn't send that answer.", lock: false });
  });

  test('(−) an unknown 409 code or a code on a status that has none never locks', () => {
    assert.equal(row(409, 'something-new').lock, false);
    assert.equal(row(409).lock, false);
    assert.equal(row(500, 'prompt-changed').lock, false);
    assert.equal(row(404, 'already-answered').lock, false);
  });

  test('(−) the message is fixed copy: no server text can reach it', () => {
    assert.equal(answerOutcome({ status: 409, code: 'no-prompt', message: '<b>x</b>' }).message, 'The question is gone.');
  });
});

describe('Esc = No: the same lock as an answered option (keys route, no status)', () => {
  test('(+) a sent Escape locks the question; the buttons stay off for that sig', () => {
    assert.deepEqual(escOutcome({ ok: true }), { lock: true });
    assert.equal(promptOff({ lock: PROMPT.sig, sig: PROMPT.sig }), true);
  });

  test('(−) any failed send re-enables the buttons: no lock', () => {
    for (const r of [{ ok: false }, { ok: false, message: 'The pane is gone.' }, {}, undefined, { ok: 'yes' }]) assert.deepEqual(escOutcome(r), { lock: false });
  });

  test('(+) the lock ends with the question: another sig, or none, is live again', () => {
    assert.equal(promptOff({ lock: PROMPT.sig, sig: 'fedcba9876543210' }), false);
    assert.equal(promptOff({ lock: null, sig: PROMPT.sig }), false);
    assert.equal(promptOff({ lock: null, sig: null }), false, 'no lock never matches a missing sig');
  });

  test('(+) a request in flight is off whatever the lock says (a double click sends one Escape)', () => {
    assert.equal(promptOff({ pending: true, lock: null, sig: PROMPT.sig }), true);
    assert.equal(promptOff({ pending: true, lock: 'fedcba9876543210', sig: PROMPT.sig }), true);
    assert.equal(promptOff({ pending: false, lock: null, sig: PROMPT.sig }), false);
    assert.equal(promptOff(), false);
  });
});

describe('promptNote', () => {
  test('(+) names the agent, the question and the number of choices', () => {
    assert.equal(promptNote('builder-1', PROMPT), 'builder-1 asks: Do you want to proceed? 2 choices above the message box.');
    assert.equal(promptNote('builder-1', { ...PROMPT, options: [{ n: 1, label: 'Yes' }] }), 'builder-1 asks: Do you want to proceed? 1 choice above the message box.');
  });
});

describe('commandFailure (spec 9.4 command route failures, fixed copy)', () => {
  const f = (status, code) => commandFailure({ status, code });

  test('(+) every 409 code, 429, 404, 5xx and network error', () => {
    assert.equal(f(409, 'input-not-empty'), "Claude's input has text; clear it first.");
    assert.equal(f(409, 'not-at-prompt'), "Claude's input didn't take the command; nothing was submitted.");
    assert.equal(f(409, 'not-idle'), 'Compact, Clear, Model and Rewind are ready when Claude waits for you.');
    assert.equal(f(409, 'mode-unknown'), "Claude's screen isn't at the prompt; use the terminal.");
    assert.equal(f(409, 'busy-switching'), 'Another action is running on this session.');
    assert.equal(f(429), 'Too many keys at once; try again.');
    assert.equal(f(404), 'The session is gone.');
    for (const s of [500, 503, 0]) assert.equal(f(s), "nika couldn't reach tmux.", String(s));
  });

  test("(−) an answer the table does not know (400, an unknown 409) gets a plain fallback, never the server's text", () => {
    assert.equal(f(400, 'invalid'), "nika couldn't send that command.");
    assert.equal(f(409, 'new-code'), "nika couldn't send that command.");
    assert.equal(commandFailure({ status: 409, code: 'input-not-empty', message: 'evil' }), "Claude's input has text; clear it first.");
  });
});

describe('problemKind', () => {
  test('(+) 404, network failures and 5xx are errors; the rest is a warning the user can act on', () => {
    for (const s of [404, 0, 500, 503]) assert.equal(problemKind(s), 'error', String(s));
    for (const s of [409, 429, 400]) assert.equal(problemKind(s), 'warn', String(s));
  });
});

describe('endOutcome (spec 9.8)', () => {
  const o = (status, code, ended) => endOutcome({ status, code, ended });

  test('(+) 200 ended:true closes the dialog (no alert text)', () => {
    assert.deepEqual(o(200, undefined, true), { ended: true, text: '' });
  });

  test('(+) 200 ended:false is the failed state with the exact copy', () => {
    assert.deepEqual(o(200, undefined, false), { ended: false, text: "Claude didn't exit; use Stop or the terminal." });
  });

  test('(+) refusals use fixed copy per 409 code', () => {
    assert.equal(o(409, 'not-idle').text, "Claude didn't stop after Esc; use the terminal.");
    assert.equal(o(409, 'mode-unknown').text, "Claude's screen isn't at the prompt; use the terminal.");
    assert.equal(o(409, 'input-not-empty').text, "Claude's input has text; clear it first.");
    assert.equal(o(409, 'not-at-prompt').text, "Claude's input didn't take /exit; nothing was submitted.");
    assert.equal(o(409, 'busy-switching').text, 'Another action is running on this session.');
    for (const code of ['not-idle', 'mode-unknown', 'input-not-empty', 'not-at-prompt', 'busy-switching']) assert.equal(o(409, code).ended, false, code);
  });

  test('(+) 404, 429, 5xx and network error', () => {
    assert.equal(o(404).text, 'The session is gone.');
    assert.equal(o(429).text, 'Too many keys at once; try again.');
    for (const s of [500, 502, 0]) assert.equal(o(s).text, "nika couldn't reach tmux.", String(s));
  });

  test('(−) a 200 that does not say ended:true is never "ended"; an unknown refusal gets the plain fallback', () => {
    for (const ended of [undefined, null, 'true', 1, 'yes']) assert.deepEqual(o(200, undefined, ended), { ended: false, text: "Claude didn't exit; use Stop or the terminal." }, String(ended));
    assert.equal(o(400, 'invalid').text, "nika couldn't end the session.");
    assert.equal(o(409, 'x').text, "nika couldn't end the session.");
    assert.equal(o(409, 'x').ended, false);
  });

  test('(−) an error status never ends, even with ended:true in the body', () => {
    assert.equal(o(500, undefined, true).ended, false);
    assert.equal(o(409, 'not-idle', true).ended, false);
  });
});

describe('endNote (the muted line of the End dialog)', () => {
  test('(+) working and prompt-open lines; plain otherwise', () => {
    assert.equal(endNote({ working: true, promptOpen: false }), 'Claude is working. nika presses Esc first to end the turn, then ends the session.');
    assert.equal(endNote({ working: false, promptOpen: true }), 'Claude is asking a question. nika presses Esc first, which answers No.');
    assert.equal(endNote({ working: false, promptOpen: false }), '');
  });

  test('(−) a prompt wins over working (Esc there answers No)', () => {
    assert.equal(endNote({ working: true, promptOpen: true }), 'Claude is asking a question. nika presses Esc first, which answers No.');
    assert.equal(endNote(), '');
  });
});

describe('planShell (spec 9.6 sends: C-u, then ! + text, then Enter)', () => {
  test('(+) a command becomes the three payloads in order, every key on the server allow-list', () => {
    const p = planShell('git status --short');
    assert.equal(p.ok, true);
    assert.equal(p.empty, undefined);
    assert.deepEqual(p.payloads, [{ keys: ['C-u'] }, { text: '!git status --short' }, { keys: ['Enter'] }]);
    for (const k of p.payloads.flatMap((x) => x.keys ?? [])) assert.ok(KEY_NAME.has(k), k);
    assert.match(p.summary, /shell command/);
  });

  test('(+) trailing newlines are trimmed and the command itself is untouched (inner spaces stay)', () => {
    assert.deepEqual(planShell('ls  -la\n\n').payloads[1], { text: '!ls  -la' });
  });

  test('(−) an empty or blank box sends nothing: no lone "!"', () => {
    for (const v of ['', '   ', '\n', ' \n ', null, undefined]) assert.deepEqual(planShell(v), { ok: true, empty: true }, JSON.stringify(v));
  });

  test('(−) several lines, control characters and an over-long command are refused with a message that keeps the text', () => {
    assert.equal(planShell('a\nb').ok, false);
    assert.match(planShell('a\nb').message, /one line/);
    assert.match(planShell('a\nb').message, /Your text is kept/);
    assert.equal(planShell('ls\u0000').ok, false);
    assert.equal(planShell('a\tb').ok, false, 'a tab is a control character; the keys route refuses it');
    assert.equal(planShell('x'.repeat(1024)).ok, false, '! plus 1024 characters is over the 1024 limit');
    assert.equal(planShell('x'.repeat(1023)).ok, true, '! plus 1023 characters is exactly the limit');
  });

  test('(−) CRLF counts as a line break, not as a trailing control character', () => {
    assert.equal(planShell('ls\r\n').ok, true);
    assert.equal(planShell('a\r\nb').ok, false);
  });
});
