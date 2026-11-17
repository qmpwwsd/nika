// 0.5.1 item E (design DES-A sections 1.5, 3 and 7.4): public/crop.js, the pure rules for cutting Claude's dialog out of the terminal view.
// panelOf says which of nika's own panels is up (and whether a bypass option is in play); cropOf says where the mirror ends for it. No DOM.
// The strip texts are written out here on purpose: the tests must not read the copy back from the code under test. Fixtures are synthetic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_TEXT, CROP_TEXT, PROMPT_LABEL_CUT, PROMPT_QUESTION_CUT, panelOf, cropOf } from '../public/crop.js';
import { clean } from '../src/text.js';
import { promptFromRows, promptTopRow } from '../src/mode.js';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'crop.js'), 'utf8');

// ---- fixtures: the cleaned W.* values panelOf reads, and a capture body cropOf reads ------------------------------------------------------------
const SIG = 'a1b2c3d4e5f60718';
const opt = (n, over = {}) => ({ n, label: `Option ${n}`, bypass: false, ...over });
const PROMPT = { question: 'Do you want to proceed?', options: [opt(1), opt(2), opt(3)], sig: 'p1', bypass: false, top: 12 };
const DIALOG = (at, over = {}) => ({ state: 'ready', at, sig: SIG, bypass: false, top: 6, ...over });
const SURVEY = { state: 'ready', kind: 'rating', top: 20 };

/** What the page hands panelOf: nothing shown unless the test says so. */
const view = (over = {}) => ({ promptShown: false, prompt: null, formShown: false, formLive: false, dialog: null, surveyShown: false, survey: null, ...over });
const withPrompt = (over = {}) => view({ promptShown: true, prompt: PROMPT, ...over });
const withForm = (at, over = {}) => view({ formShown: true, formLive: true, dialog: DIALOG(at), ...over });
const withSurvey = (over = {}) => view({ surveyShown: true, survey: SURVEY, ...over });

const ROWS = Array.from({ length: 30 }, (_, i) => [{ t: `row ${i}` }]);
const body = (over = {}) => ({ rows: ROWS, prompt: { ...PROMPT, top: 12 }, dialog: DIALOG('question', { top: 5 }), survey: { ...SURVEY, top: 20 }, ...over });
const OK = { passOn: false, dialogSig: SIG };

describe('the strip texts (3.2)', () => {
  test('(+) the input-box text is the one the page already shows; each kind has its own words, none of them equal', () => {
    assert.equal(INPUT_TEXT, 'Input box · mirrored in the message box below');
    assert.deepEqual({ ...CROP_TEXT }, {
      question: "Claude's question · answer it in the form below",
      review: 'Your answers · submit them in the form below',
      plan: 'Plan approval · the plan is above, answer in the form below',
      prompt: 'Permission prompt · answer it in the panel below',
      survey: 'Feedback question · answer it in the panel below',
    });
    assert.equal(new Set([INPUT_TEXT, ...Object.values(CROP_TEXT)]).size, 6, 'colour is never the only signal: six different words');
  });

  test('(−) the table cannot be changed from outside', () => {
    assert.ok(Object.isFrozen(CROP_TEXT));
    assert.throws(() => { 'use strict'; CROP_TEXT.prompt = 'x'; }, TypeError);
    assert.equal(CROP_TEXT.prompt, 'Permission prompt · answer it in the panel below');
  });

  test('(−) the file is ASCII (every symbol is an escape), builds no markup and touches no DOM', () => {
    assert.doesNotMatch(SRC, /[^\x00-\x7f]/);
    assert.doesNotMatch(SRC, /innerHTML|insertAdjacentHTML|document\.|window\.|eval\(|new Function/);
  });
});

describe('panelOf: which of nika\'s own panels is up (1.5)', () => {
  test('(+) the permission-prompt panel', () => {
    assert.deepEqual(panelOf(withPrompt()), { kind: 'prompt', bypass: false });
  });

  test('(+) the question form, the review and the plan approval, each in its own kind, while the form is live', () => {
    for (const at of ['question', 'review', 'plan']) assert.deepEqual(panelOf(withForm(at)), { kind: at, bypass: false }, at);
  });

  test('(+) the survey panel with a ready survey', () => {
    assert.deepEqual(panelOf(withSurvey()), { kind: 'survey', bypass: false });
  });

  test('(+) bypass: any prompt option marked bypass, or the dialog\'s own flag, is carried (the panel is still up, so the bar hides; only the crop is off)', () => {
    const risky = { ...PROMPT, options: [opt(1), opt(2, { bypass: true })] };
    assert.deepEqual(panelOf(withPrompt({ prompt: risky })), { kind: 'prompt', bypass: true });
    assert.deepEqual(panelOf(withForm('plan', { dialog: DIALOG('plan', { bypass: true }) })), { kind: 'plan', bypass: true });
    assert.deepEqual(panelOf(withForm('question', { dialog: DIALOG('question', { bypass: 'yes' }) })), { kind: 'question', bypass: false }, 'only a true flag counts');
  });

  test('(+) the order: a prompt wins over a form, a form over a survey; a hidden higher panel does not shadow a lower one', () => {
    const all = view({ promptShown: true, prompt: PROMPT, formShown: true, formLive: true, dialog: DIALOG('review'), surveyShown: true, survey: SURVEY });
    assert.equal(panelOf(all).kind, 'prompt');
    assert.equal(panelOf({ ...all, promptShown: false }).kind, 'review', 'a prompt that is not shown is not a panel');
    assert.equal(panelOf({ ...all, promptShown: false, formShown: false }).kind, 'survey');
    assert.equal(panelOf({ ...all, promptShown: false, formLive: false }).kind, 'survey', 'a form in terminal mode does not shadow the survey');
    assert.equal(panelOf({ ...all, prompt: null, promptShown: true }).kind, 'review', 'a shown flag with no prompt is not a panel');
    assert.equal(panelOf({ ...all, promptShown: false, formShown: false, surveyShown: false }), null);
  });

  test('(−) no panel: nothing shown, no value at all, or an empty object', () => {
    assert.equal(panelOf(view()), null);
    for (const v of [undefined, null, {}, 5, 'x', []]) assert.equal(panelOf(v), null, String(v));
  });

  test('(−) the prompt panel hidden, or shown with no prompt, is not a panel', () => {
    assert.equal(panelOf(withPrompt({ promptShown: false })), null);
    assert.equal(panelOf(view({ promptShown: true, prompt: null })), null);
    assert.equal(panelOf(view({ promptShown: true })), null);
  });

  test('(−) a form that is not live (terminal mode, reading), or not shown, is not a panel', () => {
    assert.equal(panelOf(withForm('question', { formLive: false })), null);
    assert.equal(panelOf(withForm('question', { formShown: false })), null);
    assert.equal(panelOf(withForm('plan', { formLive: undefined })), null);
  });

  test('(−) a dialog that is not ready, or whose kind is outside the three, is not a panel', () => {
    for (const state of ['unreadable', 'reading', 'terminal', undefined, 'READY']) assert.equal(panelOf(withForm('question', { dialog: DIALOG('question', { state }) })), null, String(state));
    for (const at of ['input', 'menu', 'prompt', 'survey', '', undefined, null, 5, 'constructor', '__proto__', 'Question']) {
      assert.equal(panelOf(withForm('question', { dialog: DIALOG(at) })), null, String(at));
    }
    assert.equal(panelOf(withForm('question', { dialog: null })), null);
  });

  test('(−) a survey that is terminal-only, not ready, or not shown is not a panel', () => {
    assert.equal(panelOf(withSurvey({ survey: { state: 'terminal', reason: 'consent' } })), null);
    assert.equal(panelOf(withSurvey({ survey: { state: 'none' } })), null);
    assert.equal(panelOf(withSurvey({ surveyShown: false })), null);
    assert.equal(panelOf(withSurvey({ survey: null })), null);
  });

  test('(−) only the value true switches a flag on: 1, "true" and other truthy values do not', () => {
    for (const v of [1, 'true', {}, [], 'yes']) {
      assert.equal(panelOf(withPrompt({ promptShown: v })), null, `promptShown ${JSON.stringify(v)}`);
      assert.equal(panelOf(withForm('question', { formShown: v })), null, `formShown ${JSON.stringify(v)}`);
      assert.equal(panelOf(withForm('question', { formLive: v })), null, `formLive ${JSON.stringify(v)}`);
      assert.equal(panelOf(withSurvey({ surveyShown: v })), null, `surveyShown ${JSON.stringify(v)}`);
    }
  });

  test('(−) a prompt with no options array cannot be told apart from a bypass one: it counts as bypass (no crop), never as safe', () => {
    for (const options of [undefined, null, 'x', {}]) assert.deepEqual(panelOf(withPrompt({ prompt: { ...PROMPT, options } })), { kind: 'prompt', bypass: true }, String(options));
  });

  test('(−) the value passed in is not changed', () => {
    const v = withPrompt();
    const before = JSON.stringify(v);
    panelOf(v);
    assert.equal(JSON.stringify(v), before);
  });
});

describe('cropOf: where the mirror ends for a panel (1.5, 3.1)', () => {
  test('(+) the permission prompt: the prompt\'s question row', () => {
    assert.deepEqual(cropOf(body(), { kind: 'prompt', bypass: false }, OK), { top: 12, kind: 'prompt' });
  });

  test('(+) the question, the review and the plan: the dialog\'s own row, when the form is the one the dialog was read for', () => {
    for (const [at, top] of [['question', 5], ['review', 3], ['plan', 9]]) {
      assert.deepEqual(cropOf(body({ dialog: DIALOG(at, { top }) }), { kind: at, bypass: false }, OK), { top, kind: at }, at);
    }
  });

  test('(+) the survey: its question row', () => {
    assert.deepEqual(cropOf(body(), { kind: 'survey', bypass: false }, OK), { top: 20, kind: 'survey' });
  });

  test('(+) the first row below the top and the last row of the capture are both inside the range', () => {
    assert.deepEqual(cropOf(body({ prompt: { ...PROMPT, top: 1 } }), { kind: 'prompt', bypass: false }, OK), { top: 1, kind: 'prompt' });
    assert.deepEqual(cropOf(body({ prompt: { ...PROMPT, top: 29 } }), { kind: 'prompt', bypass: false }, OK), { top: 29, kind: 'prompt' });
  });

  test('(+) the options argument may be left out for the kinds that need no sig', () => {
    assert.deepEqual(cropOf(body(), { kind: 'prompt', bypass: false }), { top: 12, kind: 'prompt' }, 'prompt and survey need no sig');
    assert.deepEqual(cropOf(body(), { kind: 'survey', bypass: false }, {}), { top: 20, kind: 'survey' });
  });

  test('(−) no panel, or a panel with bypass: no crop', () => {
    assert.equal(cropOf(body(), null, OK), null);
    assert.equal(cropOf(body(), undefined, OK), null);
    for (const kind of ['prompt', 'question', 'review', 'plan', 'survey']) assert.equal(cropOf(body({ dialog: DIALOG(kind, { top: 5 }) }), { kind, bypass: true }, OK), null, kind);
  });

  test('(−) Type into pane on (passOn): no crop, for every kind; a truthy non-true value counts too', () => {
    for (const kind of ['prompt', 'question', 'review', 'plan', 'survey']) {
      const b = body({ dialog: DIALOG(kind, { top: 5 }) });
      assert.equal(cropOf(b, { kind, bypass: false }, { passOn: true, dialogSig: SIG }), null, kind);
      assert.equal(cropOf(b, { kind, bypass: false }, { passOn: 1, dialogSig: SIG }), null, `${kind} truthy`);
    }
  });

  test('(−) a bypass flag on the capture itself (the prompt\'s, the dialog\'s) turns the crop off even if the panel said no bypass', () => {
    assert.equal(cropOf(body({ prompt: { ...PROMPT, bypass: true } }), { kind: 'prompt', bypass: false }, OK), null);
    assert.equal(cropOf(body({ dialog: DIALOG('question', { bypass: true, top: 5 }) }), { kind: 'question', bypass: false }, OK), null);
    assert.equal(cropOf(body({ dialog: DIALOG('plan', { bypass: true, top: 5 }) }), { kind: 'plan', bypass: false }, OK), null);
  });

  test('(−) a dialog whose sig is not the form\'s: no crop (the form was drawn for another reading)', () => {
    const b = body({ dialog: DIALOG('question', { top: 5, sig: 'ffffffffffffffff' }) });
    assert.equal(cropOf(b, { kind: 'question', bypass: false }, OK), null);
    assert.equal(cropOf(body({ dialog: DIALOG('question', { top: 5 }) }), { kind: 'question', bypass: false }, { passOn: false, dialogSig: 'ffffffffffffffff' }), null);
  });

  test('(−) no sig on either side is not a match: a missing dialogSig, a dialog with no sig, two nulls', () => {
    const q = { kind: 'question', bypass: false };
    assert.equal(cropOf(body(), q, { passOn: false, dialogSig: null }), null);
    assert.equal(cropOf(body(), q, { passOn: false }), null);
    assert.equal(cropOf(body(), q), null);
    assert.equal(cropOf(body({ dialog: DIALOG('question', { top: 5, sig: null }) }), q, { passOn: false, dialogSig: null }), null);
    assert.equal(cropOf(body({ dialog: DIALOG('question', { top: 5, sig: undefined }) }), q, { passOn: false, dialogSig: undefined }), null);
    assert.equal(cropOf(body({ dialog: DIALOG('question', { top: 5, sig: '' }) }), q, { passOn: false, dialogSig: '' }), null);
  });

  test('(−) a top outside 1 .. rows-1: 0, negative, fractional, text, not a number, past the last row, or missing', () => {
    for (const top of [0, -1, -5, 0.5, 1.5, '5', '12', NaN, Infinity, null, undefined, 30, 31, 99, 2 ** 40, true, [], [5]]) {
      const label = String(top);
      assert.equal(cropOf(body({ prompt: { ...PROMPT, top } }), { kind: 'prompt', bypass: false }, OK), null, `prompt ${label}`);
      assert.equal(cropOf(body({ dialog: DIALOG('review', { top }) }), { kind: 'review', bypass: false }, OK), null, `review ${label}`);
      assert.equal(cropOf(body({ survey: { ...SURVEY, top } }), { kind: 'survey', bypass: false }, OK), null, `survey ${label}`);
    }
    const noTop = { ...PROMPT };
    delete noTop.top;
    assert.equal(cropOf(body({ prompt: noTop }), { kind: 'prompt', bypass: false }, OK), null);
  });

  test('(−) the rows the top is measured against: none, not a list, or an empty one', () => {
    for (const rows of [undefined, null, 'abc', {}, [], { length: 30 }]) assert.equal(cropOf(body({ rows }), { kind: 'prompt', bypass: false }, OK), null, JSON.stringify(rows));
    assert.equal(cropOf(body({ rows: ROWS.slice(0, 12) }), { kind: 'prompt', bypass: false }, OK), null, 'top 12 in 12 rows is past the end');
    assert.deepEqual(cropOf(body({ rows: ROWS.slice(0, 13) }), { kind: 'prompt', bypass: false }, OK), { top: 12, kind: 'prompt' }, 'top 12 in 13 rows is the last row');
  });

  test('(−) an unreadable or still-reading dialog has no ready state: no crop, even with a top and a matching sig', () => {
    for (const state of ['unreadable', 'reading', undefined]) {
      assert.equal(cropOf(body({ dialog: DIALOG('question', { top: 5, state }) }), { kind: 'question', bypass: false }, OK), null, String(state));
    }
  });

  test('(−) a survey that is terminal-only or not ready: no crop', () => {
    assert.equal(cropOf(body({ survey: { state: 'terminal', reason: 'bypass', top: 20 } }), { kind: 'survey', bypass: false }, OK), null);
    assert.equal(cropOf(body({ survey: { top: 20 } }), { kind: 'survey', bypass: false }, OK), null);
  });

  test('(−) the panel and the capture must agree on the kind: a plan panel with a question dialog (or the reverse) gives no crop', () => {
    const b = body({ dialog: DIALOG('question', { top: 5 }) });
    assert.equal(cropOf(b, { kind: 'plan', bypass: false }, OK), null);
    assert.equal(cropOf(b, { kind: 'review', bypass: false }, OK), null);
    assert.equal(cropOf(body({ dialog: DIALOG('plan', { top: 5 }) }), { kind: 'question', bypass: false }, OK), null);
  });

  test('(−) each kind reads only its own source: a prompt kind ignores the dialog\'s top, a survey kind ignores the prompt\'s', () => {
    const b = body({ prompt: null, dialog: DIALOG('question', { top: 5 }), survey: null });
    assert.equal(cropOf(b, { kind: 'prompt', bypass: false }, OK), null);
    assert.equal(cropOf(b, { kind: 'survey', bypass: false }, OK), null);
    assert.equal(cropOf(body({ dialog: null }), { kind: 'question', bypass: false }, OK), null);
  });

  test('(−) an unknown kind, or no body at all: null, never a throw', () => {
    for (const kind of ['', 'input', 'constructor', '__proto__', undefined, null, 5]) assert.equal(cropOf(body(), { kind, bypass: false }, OK), null, String(kind));
    for (const b of [undefined, null, {}, 5, 'x', []]) assert.equal(cropOf(b, { kind: 'prompt', bypass: false }, OK), null, JSON.stringify(b));
  });

  test('(−) the capture is not changed, and the answer is a fresh object', () => {
    const b = body();
    const before = JSON.stringify(b);
    const a = cropOf(b, { kind: 'prompt', bypass: false }, OK);
    assert.equal(JSON.stringify(b), before);
    assert.notEqual(a, b.prompt);
    assert.deepEqual(Object.keys(a).sort(), ['kind', 'top']);
  });
});

// ---- round RV, I3: a permission prompt the server cut is never cropped ----------------------------------------------------------------------------
// src/mode.js cuts an option label at 80 characters and the question at 200 (clean(..., max) slices and leaves no marker), so the page cannot see
// that a label was cut; the tail of "Yes, and don't ask again for ..." would be visible nowhere once the mirror ends above the prompt. A label or a
// question at the cut length may have been cut, so the prompt is not cropped and the whole screen shows, as before 0.5.1.
describe('cropOf: a prompt whose text the server cut gets no crop (RV I3)', () => {
  const P = { kind: 'prompt', bypass: false };
  const text = (n, c = 'x') => c.repeat(n);
  const prompt = (over = {}) => ({ ...PROMPT, question: 'Do you want to proceed?', options: [opt(1), opt(2), opt(3)], ...over });
  const labelled = (n, at = 1) => prompt({ options: [opt(1), opt(2, { label: text(n) }), opt(3)].map((o, i) => (i === at ? { ...o, label: text(n) } : o)) });
  const crop = (p, o = OK) => cropOf(body({ prompt: p }), P, o);
  const row = (t) => [{ t, s: {} }];

  test('the two lengths are the numbers src/mode.js cuts at: read from its source, so a change there fails here', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mode.js'), 'utf8');
    assert.equal(Number(/const label = clean\(p\.join\(' '\), (\d+)\);/.exec(src)?.[1]), PROMPT_LABEL_CUT, 'option label');
    assert.equal(Number(/question: clean\(question, (\d+)\)/.exec(src)?.[1]), PROMPT_QUESTION_CUT, 'question');
    assert.equal(PROMPT_LABEL_CUT, 80);
    assert.equal(PROMPT_QUESTION_CUT, 200);
  });

  test('clean() marks a cut by nothing: the text is exactly max long, no ellipsis, so "at the cut length" is the only sign', () => {
    for (const [max, cut] of [[PROMPT_LABEL_CUT, PROMPT_LABEL_CUT], [PROMPT_QUESTION_CUT, PROMPT_QUESTION_CUT]]) {
      const out = clean(text(max + 50), max);
      assert.equal(out.length, cut);
      assert.equal(out, text(max), 'the first max characters, nothing appended');
      assert.equal(clean(text(max - 1), max), text(max - 1), 'one under: untouched');
      assert.equal(clean(text(max), max), text(max), 'exactly max: also untouched, so it cannot be told from a cut one');
    }
  });

  test('(+) a label of 79 characters and a question of 199 crop as before', () => {
    assert.deepEqual(crop(labelled(PROMPT_LABEL_CUT - 1)), { top: 12, kind: 'prompt' });
    assert.deepEqual(crop(prompt({ question: text(PROMPT_QUESTION_CUT - 1) })), { top: 12, kind: 'prompt' });
    assert.deepEqual(crop(prompt({ question: text(PROMPT_QUESTION_CUT - 1), options: [opt(1, { label: text(PROMPT_LABEL_CUT - 1) }), opt(2)] })), { top: 12, kind: 'prompt' });
    assert.deepEqual(crop(prompt()), { top: 12, kind: 'prompt' }, 'the plain fixture');
  });

  test('(−) a label at the cut length gives no crop, whichever option carries it', () => {
    for (const at of [0, 1, 2]) assert.equal(crop(labelled(PROMPT_LABEL_CUT, at)), null, `option ${at + 1}`);
    assert.equal(crop(labelled(PROMPT_LABEL_CUT + 1)), null, 'a label past the cut (cannot come from the server) is no safer');
    assert.equal(crop(labelled(500)), null);
  });

  test('(−) a question at the cut length gives no crop', () => {
    assert.equal(crop(prompt({ question: text(PROMPT_QUESTION_CUT) })), null);
    assert.equal(crop(prompt({ question: text(PROMPT_QUESTION_CUT + 1) })), null);
  });

  test('(−) one cut text is enough: a short question with a cut label, a short label with a cut question', () => {
    assert.equal(crop(prompt({ question: 'Short?', options: [opt(1), opt(2, { label: text(PROMPT_LABEL_CUT) })] })), null);
    assert.equal(crop(prompt({ question: text(PROMPT_QUESTION_CUT), options: [opt(1, { label: 'Yes' }), opt(2, { label: 'No' })] })), null);
  });

  test('(−) Type into pane on gives no crop either: for a cut prompt and for an uncut one (the cut check never turns a crop on)', () => {
    const on = { passOn: true, dialogSig: SIG };
    assert.equal(crop(labelled(PROMPT_LABEL_CUT), on), null);
    assert.equal(crop(prompt({ question: text(PROMPT_QUESTION_CUT) }), on), null);
    assert.equal(crop(labelled(PROMPT_LABEL_CUT - 1), on), null);
    assert.equal(crop(prompt({ question: text(PROMPT_QUESTION_CUT - 1) }), on), null);
    assert.equal(crop(prompt(), on), null);
  });

  test('(−) a prompt whose text cannot be measured gets no crop: no options list, a label or a question that is not text', () => {
    for (const options of [undefined, null, 'abc', {}, 5]) assert.equal(crop(prompt({ options })), null, JSON.stringify(options));
    for (const label of [undefined, null, 5, {}, ['a']]) assert.equal(crop(prompt({ options: [opt(1), opt(2, { label })] })), null, String(label));
    for (const question of [5, {}, ['a'], true]) assert.equal(crop(prompt({ question })), null, JSON.stringify(question));
  });

  test('(+) a prompt with no question text at all (null) is not a cut one: the options decide', () => {
    assert.deepEqual(crop(prompt({ question: null })), { top: 12, kind: 'prompt' });
  });

  test('the other kinds are not affected: a dialog and a survey crop whatever the prompt in the same capture says', () => {
    const cutPrompt = labelled(PROMPT_LABEL_CUT);
    assert.deepEqual(cropOf(body({ prompt: cutPrompt }), { kind: 'survey', bypass: false }, OK), { top: 20, kind: 'survey' });
    assert.deepEqual(cropOf(body({ prompt: cutPrompt, dialog: DIALOG('plan', { top: 9 }) }), { kind: 'plan', bypass: false }, OK), { top: 9, kind: 'plan' });
  });

  test('end to end: the real parser cuts a 130-character label to the cut length, and the page then does not crop; a 70-character one still crops', () => {
    const screen = (label, question = 'Do you want to proceed?') => [row('Bash command'), row('npm run build'), row(question), row('❯ 1. Yes'), row(`  2. ${label}`), row('  3. No'), row('Esc to cancel')];
    const asCapture = (rows) => ({ rows, prompt: { ...promptFromRows(rows), bypass: false, top: promptTopRow(rows) } });
    const long = asCapture(screen(`Yes, and don't ask again for curl commands in ${text(100)}`));
    assert.equal(long.prompt.options[1].label.length, PROMPT_LABEL_CUT, 'the parser cut it');
    assert.equal(cropOf(long, P, OK), null, 'a cut label: no crop');
    const short = asCapture(screen('Yes, and always allow this'));
    assert.deepEqual(cropOf(short, P, OK), { top: 2, kind: 'prompt' }, 'a whole label: the crop is at the question row');
    const longQ = asCapture(screen('No', `${text(PROMPT_QUESTION_CUT + 40)} proceed?`));
    assert.equal(longQ.prompt.question.length, PROMPT_QUESTION_CUT, 'the parser cut the question');
    assert.equal(cropOf(longQ, P, OK), null, 'a cut question: no crop');
  });
});
