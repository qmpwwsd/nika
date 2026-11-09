// public/quick-actions.js: the pure rules behind the session window's quick actions, prompt buttons, End dialog and Shell mode.
// Design and exact copy: docs/design/spec.md section 9.4 (states table, command-route failures), 9.5 (answer results), 9.6 (Shell),
// 9.8 (End dialog). Contract: docs/contracts/api-app.md section 3. No DOM here: session.js and end-dialog.js only draw what these return.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KEY_NAME } from '../src/ids.js';
import {
  quickState, cleanPrompt, isBypassLabel, promptMentionsBypass, answerOutcome, escOutcome, promptOff, promptNote, commandFailure, commandSaid, endOutcome, endNote,
  planShell, problemKind, sendGate, keysRefusal, stopOutcome, followSession, hasAnswerButtons, attnNote, SESSION_ID, PANE_ID,
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
    assert.equal(st.stop.title, 'Stops this turn (Esc in the pane; twice in vim insert mode). Keeps the work, also stops running subagents');
    assert.ok(offs(st, FOUR));
    assert.equal(st.end.off, false);
    assert.equal(st.reason, 'Compact, Clear, Model and Rewind are ready when Claude waits for you.');
    for (const n of FOUR) assert.equal(st[n].title, 'Available when Claude is waiting for you', n);
  });

  test('(+) Rewind follows the same gate as Compact, Clear and Model: it does not read nika\'s own message box any more', () => {
    for (const composerEmpty of [true, false]) {
      const st = quickState({ status: 'idle', composerEmpty }); // an old caller may still pass it; it changes nothing
      assert.ok(lives(st, [...FOUR, 'end']), String(composerEmpty));
      assert.equal(st.reason, '');
    }
  });

  test('(−) Rewind is off exactly where the other three are: working, a prompt, needs you, a switch in flight, a pane that is not ok', () => {
    const cases = [{ status: 'busy' }, { status: 'attn' }, { status: 'idle', prompt: PROMPT }, { status: 'idle', switching: true }, { status: 'ended' }, { pane: 'gone' }, { pane: 'tmux' }, { pane: 'connecting' }];
    for (const c of cases) {
      const st = quickState(c);
      assert.equal(st.rewind.off, st.compact.off, JSON.stringify(c));
      assert.equal(st.rewind.off, st.clear.off, JSON.stringify(c));
      assert.equal(st.rewind.off, st.model.off, JSON.stringify(c));
      assert.equal(st.rewind.off, true, JSON.stringify(c));
    }
  });

  test('(−) the retired Rewind copy is gone from the module (it needed an empty box of nika\'s own)', () => {
    const src = fs.readFileSync(new URL('../public/quick-actions.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Empty the message box first|Rewind needs an empty message box|composerEmpty|Esc Esc/);
  });

  test('(+) a live title for every live button (the hover text the spec lists)', () => {
    const st = quickState({ status: 'idle' });
    assert.equal(st.compact.title, 'Types /compact and Enter: summarises the conversation to free context');
    assert.equal(st.clear.title, 'Types /clear and Enter after you confirm');
    assert.equal(st.rewind.title, "Types /rewind and Enter: opens Claude's rewind menu in the pane");
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
    const p = cleanPrompt({ question: 'Do you want to proceed?', sig: 'abcdef0123456789', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] });
    assert.equal(p.question, 'Do you want to proceed?');
    assert.equal(p.sig, 'abcdef0123456789');
    assert.deepEqual(p.options.map((o) => [o.n, o.label, o.bypass]), [[1, 'Yes', false], [2, 'No', false]]);
  });

  test('(+) one option that mentions bypass flags every option of its prompt (14a A4: the answer route refuses the whole prompt)', () => {
    const p = cleanPrompt({ question: 'Do you want to proceed?', sig: 'abcdef0123456789', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, and bypass permissions for this session' }, { n: 3, label: 'No' }] });
    assert.deepEqual(p.options.map((o) => [o.n, o.label, o.bypass]), [[1, 'Yes', true], [2, 'Yes, and bypass permissions for this session', true], [3, 'No', true]]);
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
    assert.equal(p.options[0].bypass, true, 'and the plain one is flagged with it');
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

  test('(+) every other answer re-enables the buttons: no-prompt, busy-switching, 429, 404, 5xx, network, 403', () => {
    assert.deepEqual(row(409, 'no-prompt'), { message: 'The question is gone.', lock: false });
    assert.deepEqual(row(409, 'busy-switching'), { message: 'Another action is running on this session.', lock: false });
    assert.deepEqual(row(429), { message: 'Too many keys at once; try again.', lock: false });
    assert.deepEqual(row(404), { message: 'The session is gone.', lock: false });
    for (const s of [500, 502, 503, 0]) assert.deepEqual(row(s), { message: "nika couldn't reach tmux.", lock: false }, String(s));
    assert.deepEqual(row(403, 'forbidden'), { message: "nika couldn't send that answer.", lock: false });
  });

  test('(+) 400: the route refuses this prompt (it mentions bypass where the page could not see it): the terminal line, and the question is locked like an answered one', () => {
    assert.deepEqual(row(400, 'invalid'), { message: 'Answer this prompt in the terminal.', lock: true });
    assert.deepEqual(row(400), { message: 'Answer this prompt in the terminal.', lock: true }, 'whatever the code');
  });

  test('(−) the 400 line is fixed copy (server text never reaches it) and no other status takes it', () => {
    assert.equal(answerOutcome({ status: 400, code: 'invalid', message: '<b>this option is answered in the terminal</b>' }).message, 'Answer this prompt in the terminal.');
    for (const status of [200, 401, 403, 404, 409, 429, 500, 0]) assert.notEqual(answerOutcome({ status, code: 'invalid' }).message, 'Answer this prompt in the terminal.', String(status));
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

describe('whole-prompt bypass: no button at all when the prompt mentions bypass anywhere (14a A4)', () => {
  const P = (over = {}) => ({ question: 'Do you want to proceed?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], ...over });
  const flags = (raw) => cleanPrompt(raw).options.map((o) => o.bypass);

  test('(+) a plain prompt keeps its buttons: no option is flagged', () => {
    assert.deepEqual(flags(P()), [false, false]);
    assert.equal(promptMentionsBypass(P()), false);
  });

  test('(+) the question alone mentioning bypass flags every option, even plain "Yes" and "No"', () => {
    const raw = P({ question: 'Switch to bypass permissions?' });
    assert.equal(promptMentionsBypass(raw), true);
    assert.deepEqual(flags(raw), [true, true]);
  });

  test('(+) one option label alone flags all of them (the route refuses the whole prompt)', () => {
    const raw = P({ options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, and bypass permissions for this session' }, { n: 3, label: 'No' }] });
    assert.deepEqual(flags(raw), [true, true, true]);
  });

  test('(+) the server\'s prompt.bypass (its whole 15-row window, tool-call lines included) flags every option, however plain the visible text', () => {
    assert.deepEqual(flags(P({ bypass: true })), [true, true]);
    assert.deepEqual(flags(P({ bypass: true, options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, allow all edits' }, { n: 3, label: 'No' }] })), [true, true, true]);
  });

  test('(−) prompt.bypass false keeps the page\'s own checks (a label that says bypass still has no button); only a real true counts', () => {
    assert.deepEqual(flags(P({ bypass: false })), [false, false]);
    assert.deepEqual(flags(P({ bypass: false, options: [{ n: 1, label: 'Yes, and bypass permissions' }, { n: 2, label: 'No' }] })), [true, true]);
    for (const odd of ['true', 1, 'yes', {}, null]) assert.deepEqual(flags(P({ bypass: odd })), [false, false], JSON.stringify(odd));
  });

  test('(−) a `hint` field is not read: the server never sends one (the window is covered by prompt.bypass instead)', () => {
    assert.equal(promptMentionsBypass(P({ hint: 'Esc to cancel; bypass is on' })), false);
    assert.deepEqual(flags(P({ hint: 'Esc to cancel; bypass is on' })), [false, false]);
  });

  test('(+) it reads like the server: letters only, any case, NFKC (By-pass, full-width letters, a word split over a wrap)', () => {
    for (const q of ['By-pass the check?', 'BYPASS?', 'Run in ｂｙｐａｓｓ mode?', 'Use by pass now?']) {
      assert.equal(promptMentionsBypass(P({ question: q })), true, q);
      assert.deepEqual(flags(P({ question: q })), [true, true], q);
    }
    assert.equal(promptMentionsBypass({ question: 'a by', options: [{ n: 1, label: 'pass it' }] }), true, 'the fields are joined with a space, like the window rows');
  });

  test('(−) near misses do not flag: "pass", "bypa", "by the way", an unrelated word', () => {
    for (const q of ['Do you want to pass?', 'Allow bypa?', 'Proceed, by the way?', 'Allow compass?']) {
      assert.equal(promptMentionsBypass(P({ question: q })), false, q);
      assert.deepEqual(flags(P({ question: q })), [false, false], q);
    }
  });

  test('(−) the check sees the whole text, not the clipped one (a label of 250 characters that ends in bypass)', () => {
    const raw = P({ options: [{ n: 1, label: `${'x'.repeat(250)} bypass` }, { n: 2, label: 'No' }] });
    assert.deepEqual(flags(raw), [true, true]);
    assert.ok(cleanPrompt(raw).options[0].label.length <= 200);
  });

  test('(−) garbage is not a mention: null, non-objects, non-string fields', () => {
    for (const bad of [null, undefined, 'bypass', 7, [], {}, { question: 7, options: 'bypass' }, { question: null, options: [null, { label: 3 }] }]) assert.equal(promptMentionsBypass(bad), false, JSON.stringify(bad));
  });
});

describe('sendGate: Send and Shell wait while a prompt is open (H2)', () => {
  const WITH = { ok: false, message: 'Answer the prompt with the buttons above or in the terminal.' };
  const WITHOUT = { ok: false, message: 'Answer the prompt in the terminal, or turn on Type into pane.' };

  test('(+) with answer buttons on screen the line points at them', () => {
    assert.deepEqual(sendGate({ promptOpen: true, status: 'busy', buttons: true }), WITH);
    assert.deepEqual(sendGate({ promptOpen: true, buttons: true }), WITH);
    assert.deepEqual(sendGate({ status: 'attn', buttons: true }), WITH);
  });

  test('(+) without buttons (a prompt nika cannot parse, or a bypass prompt that has none) it names the terminal and Type into pane, never "buttons above"', () => {
    for (const a of [{ promptOpen: true }, { status: 'attn' }, { promptOpen: true, status: 'attn' }, { promptOpen: true, buttons: false }, { status: 'attn', buttons: 'yes' }]) {
      assert.deepEqual(sendGate(a), WITHOUT, JSON.stringify(a));
    }
  });

  test('(−) everything else goes out, buttons or not: idle, busy, ended, not known yet, no argument at all', () => {
    for (const status of ['idle', 'busy', 'ended', null, undefined]) {
      assert.deepEqual(sendGate({ promptOpen: false, status }), { ok: true }, String(status));
      assert.deepEqual(sendGate({ promptOpen: false, status, buttons: true }), { ok: true }, `${status} with buttons`);
    }
    assert.deepEqual(sendGate(), { ok: true });
    assert.deepEqual(sendGate({}), { ok: true });
  });
});

describe('hasAnswerButtons: does the prompt panel show an answer button?', () => {
  const o = (n, bypass = false) => ({ n, label: `option ${n}`, bypass });

  test('(+) at least one option without the bypass mark is a button', () => {
    assert.equal(hasAnswerButtons({ options: [o(1), o(2)] }), true);
    assert.equal(hasAnswerButtons({ options: [o(1, true), o(2)] }), true);
  });

  test('(−) no prompt, no options, or every option drawn as text (a bypass prompt) is no button', () => {
    for (const p of [null, undefined, {}, { options: [] }, { options: 'x' }, { options: [o(1, true), o(2, true)] }]) assert.equal(hasAnswerButtons(p), false, JSON.stringify(p));
    assert.equal(hasAnswerButtons(cleanPrompt({ question: 'Switch to bypass permissions?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] })), false, 'through cleanPrompt');
    assert.equal(hasAnswerButtons(cleanPrompt({ question: 'Proceed?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] })), true, 'through cleanPrompt');
  });
});

describe('attnNote: the note for a "Needs you" agent whose prompt nika cannot parse', () => {
  test('(+) names the terminal and Type into pane with the key as the page writes it (Mac glyph or Ctrl+])', () => {
    assert.equal(attnNote('builder-1', 'Asking to run a command', 'Ctrl+]'), 'builder-1 needs you: Asking to run a command. Answer it in the terminal, or turn on Type into pane (Ctrl+]).');
    assert.equal(attnNote('builder-1', 'Asking to run a command', '\u2303]'), 'builder-1 needs you: Asking to run a command. Answer it in the terminal, or turn on Type into pane (\u2303]).');
  });

  test('(−) it no longer tells the user to press Enter or the arrow keys, which nika blocks while a prompt is open', () => {
    const t = attnNote('a', 'b', 'Ctrl+]');
    assert.doesNotMatch(t, /Enter|arrow|Esc to refuse/);
  });
});

describe('keysRefusal: the keys route\'s 409 bypass-prompt (fixed copy)', () => {
  test('(+) only 409 with that code has a line', () => {
    assert.equal(keysRefusal({ status: 409, code: 'bypass-prompt' }), 'Answer this prompt in the terminal.');
  });

  test('(−) any other answer, any other code, and server text give null (deliver keeps its own lines)', () => {
    for (const r of [{ status: 409, code: 'busy-switching' }, { status: 409 }, { status: 200, code: 'bypass-prompt' }, { status: 400, code: 'bypass-prompt' }, { status: 429 }, {}, undefined]) assert.equal(keysRefusal(r), null, JSON.stringify(r));
    assert.equal(keysRefusal({ status: 409, code: 'bypass-prompt', message: '<b>x</b>' }), 'Answer this prompt in the terminal.', 'the response text is never read');
  });
});

describe('stopOutcome: the stop route\'s answers (contract section 3, fixed copy)', () => {
  const s = (status, code, name) => stopOutcome({ status, code, name });

  test('(+) 200 says what happened, with the agent\'s name, and has no problem line', () => {
    assert.deepEqual(s(200, undefined, 'builder-1'), { ok: true, say: "Stopped builder-1's turn", message: '' });
    assert.equal(s(200).say, "Stopped Claude's turn");
  });

  test('(+) 409 stopping (a second window or tab is already stopping this pane): its own line', () => {
    assert.deepEqual(s(409, 'stopping'), { ok: false, say: '', message: 'Already stopping the turn.' });
  });

  test('(+) the three 409 codes, exact copy', () => {
    assert.equal(s(409, 'prompt-open').message, 'Answer the prompt first. Esc = No is in the prompt panel.');
    assert.equal(s(409, 'not-busy').message, 'Nothing to stop: Claude is waiting.');
    assert.equal(s(409, 'mode-unknown').message, "Claude's input stayed in vim insert mode; press Esc in the terminal.");
    for (const code of ['prompt-open', 'not-busy', 'mode-unknown']) assert.equal(s(409, code).ok, false, code);
  });

  test('(+) 404 is the gone line (session.js also goes to the pane-gone state), 429, 5xx and network errors keep the shared lines', () => {
    assert.equal(s(404, 'not_found').message, 'The session is gone.');
    assert.equal(s(429).message, 'Too many keys at once; try again.');
    for (const status of [500, 502, 0]) assert.equal(s(status).message, "nika couldn't reach tmux.", String(status));
  });

  test('(−) an unknown 409 code, a prototype name, 400 or 403 get the plain fallback, never the server\'s text', () => {
    for (const r of [[409, 'something-new'], [409, '__proto__'], [409, 'toString'], [409, undefined], [400, 'invalid'], [403, undefined]]) {
      assert.deepEqual(s(...r), { ok: false, say: '', message: "nika couldn't stop the turn." }, JSON.stringify(r));
    }
    assert.equal(stopOutcome({ status: 409, code: 'not-busy', message: 'evil' }).message, 'Nothing to stop: Claude is waiting.');
  });

  test('(−) an error status is never ok, even with a stray success-looking code', () => {
    for (const status of [400, 404, 409, 429, 500, 0]) assert.equal(s(status, 'stopped').ok, false, String(status));
    assert.equal(stopOutcome().ok, false);
  });
});

describe('SESSION_ID and PANE_ID: the one copy of the URL shapes', () => {
  test('(+) a lower-case UUID and a pane id of 1 to 6 digits match', () => {
    assert.match('11111111-1111-4111-8111-111111111111', SESSION_ID);
    for (const id of ['%0', '%12', '%123456']) assert.match(id, PANE_ID, id);
  });

  test('(−) anything else does not: upper case, extra text, a path, a missing percent sign, 7 digits', () => {
    for (const id of ['11111111-1111-4111-8111-11111111111A', '11111111-1111-4111-8111-111111111111/x', '../11111111-1111-4111-8111-111111111111', '', '1111']) assert.doesNotMatch(id, SESSION_ID, id);
    for (const id of ['12', '%', '%x', '%1234567', '%12 ', '%12/../x', '%-1']) assert.doesNotMatch(id, PANE_ID, id);
  });
});

describe('commandSaid: the echo line after the command route answered 200', () => {
  test('(+) Rewind opens a menu in the pane, so it says that', () => {
    assert.equal(commandSaid('/rewind', '%12'), 'Opened Rewind in %12: pick a point in the pane');
  });

  test('(−) every other command was typed and sent: "Sent <text> + Enter to <pane>"', () => {
    assert.equal(commandSaid('/compact', '%12'), 'Sent /compact + Enter to %12');
    assert.equal(commandSaid('/clear', '%3'), 'Sent /clear + Enter to %3');
    assert.equal(commandSaid('/model opus', '%3'), 'Sent /model opus + Enter to %3');
    assert.equal(commandSaid('/rewind now', '%3'), 'Sent /rewind now + Enter to %3', 'only the bare command opens the menu');
  });
});

describe('followSession: a pane that started a new conversation (/clear) is followed, nothing else is', () => {
  const OLD = '11111111-1111-4111-8111-111111111111';
  const NEW = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const ag = (id, pane, live = true) => ({ id, live, pane: pane ? { id: pane } : null });
  const run = (agents, over = {}) => followSession({ sessionId: OLD, paneId: '%7', agents, ...over });

  test('(+) the old session ended, exactly one live agent now has the pane: its id', () => {
    assert.equal(run([ag(OLD, '%7', false), ag(NEW, '%7')]), NEW);
  });

  test('(+) the old session is not in the snapshot at all: still followed', () => {
    assert.equal(run([ag(NEW, '%7'), ag(OTHER, '%8')]), NEW);
  });

  test('(+) other panes and ended agents on this pane do not count as claimants', () => {
    assert.equal(run([ag(OLD, '%7', false), ag(OTHER, '%8'), ag('44444444-4444-4444-8444-444444444444', '%7', false), ag(NEW, '%7')]), NEW);
  });

  test('(−) the old session is still live: no follow, even if another live agent has the pane', () => {
    assert.equal(run([ag(OLD, '%7'), ag(NEW, '%7')]), null);
    assert.equal(run([ag(OLD, '%7')]), null);
    assert.equal(run([ag(OLD, null), ag(NEW, '%7')]), null, 'live without a pane is still live');
  });

  test('(−) two or more live agents claim the pane: ambiguous, stay', () => {
    assert.equal(run([ag(OLD, '%7', false), ag(NEW, '%7'), ag(OTHER, '%7')]), null);
  });

  test('(−) nobody live has the pane: stay', () => {
    assert.equal(run([ag(OLD, '%7', false), ag(NEW, '%8')]), null);
    assert.equal(run([]), null);
  });

  test('(−) no pane id, or one that is not a pane id: nothing to follow from', () => {
    for (const paneId of [null, undefined, '', '7', '%', '%x', '%1234567', '%7 ']) assert.equal(run([ag(NEW, '%7')], { paneId }), null, String(paneId));
  });

  test('(−) no session id in this window (a pane-only link already follows the pane), or a malformed one', () => {
    for (const sessionId of [null, undefined, '', 'abc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase()]) assert.equal(run([ag(NEW, '%7')], { sessionId }), null, String(sessionId));
  });

  test('(−) a claimant whose id is not a well-formed session id is never followed (it would go into a URL and a request path)', () => {
    for (const id of ['../../x', 'not-a-uuid', '', null, undefined, 7, `${NEW}/x`]) assert.equal(run([ag(OLD, '%7', false), ag(id, '%7')]), null, String(id));
  });

  test('(−) garbage input does not throw: no agents list, holes in it, agents without a pane', () => {
    assert.equal(run(null), null);
    assert.equal(run('x'), null);
    assert.equal(run([null, undefined, 7, {}, ag(NEW, '%7')]), NEW);
    assert.equal(run([{ id: NEW, live: true }]), null);
    assert.equal(followSession(), null);
  });
});
