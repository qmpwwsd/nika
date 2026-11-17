// A synthetic Claude Code dialog for the key-script tests (nika 0.5, W1-T2, design W1 section 8). It renders the rows of Claude's question
// dialog (AskUserQuestion: its tabs and its review step), its plan approval (ExitPlanMode), "Exit plan mode?", the auto-mode nudge, a
// permission prompt and an idle input box from a scripted state, and changes that state the way Claude does after each key (shapes and key
// effects from spikes S3, W1-T0, W1-T0b and W1-T0c). It records every key together with the screen it landed in, and it can inject a change
// between two keys, drop a key, swallow a redraw or fail a send. Synthetic text only (acme-api, web-shop, demo-api).
import { createSessionControl } from '../src/session-control.js';
import { PLAN_TEXT_LABEL, readDialogScreen, sigOf } from '../src/dialog.js';
import { boxRows, span } from './helpers.js';

const DIM = { fg: 246 };
const ACC = { fg: 153 };
const MARK = { fg: 16, bg: 153 };
const ptr = (on) => (on ? '❯' : ' ');
const line = (s) => (Array.isArray(s) ? s : s === '' ? [] : [span(s)]);

/** The tabs of the usual forms; a test passes them (or its own) to dialogWorld. `options` are [label, description]. */
export const TAB = {
  project: { header: 'Project', question: 'Which project should I open?', options: [['acme-api', 'Open the acme-api project.'], ['web-shop', 'Open the web-shop project.'], ['demo-api', 'Open the demo-api project.']] },
  tools: { header: 'Tools', question: 'Which checks should I run?', multi: true, options: [['lint', 'Run the linter.'], ['test', 'Run the tests.'], ['build', 'Build the project.']] },
  mode: { header: 'Mode', question: 'Which mode should I use?', options: [['fast', 'Skip the slow steps.'], ['safe', 'Run every step.']] },
  name: { header: 'Name', question: 'What should the report be called?', options: [['weekly', 'The weekly report.'], ['monthly', 'The monthly report.']] },
};

const mkTab = (t) => ({
  multi: false, picked: null, checked: [], text: null, answered: false, ...t, options: t.options.map((o) => (Array.isArray(o) ? { label: o[0], desc: o[1] } : o)),
});

/** Greedy word wrap: the first row may hold `first` cells, the others `rest`. */
function wrap(text, first, rest) {
  const rows = [];
  let cur = '';
  let limit = first;
  for (const word of text.split(' ')) {
    if (cur === '') cur = word;
    else if ([...cur].length + 1 + [...word].length <= limit) cur += ` ${word}`;
    else { rows.push(cur); cur = word; limit = rest; }
  }
  rows.push(cur);
  return rows;
}

/** The tab strip: ` <box> <header> ` tokens (the current one with a background), ` ✔ Submit `, arrows. `current`: a tab index or 'submit'. */
function stripRow(w, current, withSubmit) {
  const out = [];
  if (withSubmit) out.push(span('←'), span(' '));
  w.tabs.forEach((t, n) => {
    if (n > 0) out.push(span(' '));
    out.push(span(` ${t.answered ? '☒' : '☐'} ${t.header} `, current === n ? MARK : {}));
  });
  if (withSubmit) out.push(span(' '), span(' ✔ Submit ', current === 'submit' ? MARK : {}), span(' '), span('→'));
  return out;
}

const answerOf = (t) => (t.multi ? [...t.options.filter((_, j) => t.checked.includes(j + 1)).map((o) => o.label), ...(t.text === null ? [] : [t.text])].join(', ') : t.picked !== null ? t.options[t.picked - 1].label : t.text);

function askRows(w) {
  const tab = w.tabs[w.i];
  const k = tab.options.length;
  const f = w.focus;
  const several = w.tabs.length > 1;
  const submit = several || tab.multi;
  const insert = w.vim && f === k + 1 && w.vimMode === 'insert';
  const nav = several ? 'Tab/Arrow keys' : '↑/↓';
  const ctrl = f === k + 1 || f === k + 2 || f === 'button'; // the input rows: the text row, Chat and the Next button (S-TABS)
  const indent = ' '.repeat(tab.multi ? 9 : 5);
  const rows = [line('⏺ I have a question first.'), [], [span('─'.repeat(w.cols), DIM)], stripRow(w, w.i, submit), [], [span(tab.question, { b: true, fg: 231 })], []];
  tab.options.forEach((o, j) => {
    const n = j + 1;
    const box = tab.multi ? (tab.checked.includes(n) ? '[✔] ' : '[ ] ') : '';
    const tick = !tab.multi && tab.picked === n ? ' ✔' : '';
    rows.push([span(ptr(f === n), ACC), span(' '), span(`${n}.`, DIM), span(` ${box}${o.label}${tick}`, f === n ? ACC : {})]);
    if (o.desc) rows.push([span(`${indent}${o.desc}`, DIM)]);
  });
  const tBox = tab.multi ? (tab.text === null ? '[ ] ' : '[✔] ') : '';
  const head = [span(ptr(f === k + 1), ACC), span(' '), span(`${k + 1}.`, DIM), span(` ${tBox}`)];
  if (tab.text === null) rows.push([...head, span(tab.multi ? 'Type something' : 'Type something.', { d: true })]);
  else {
    const tick = !tab.multi && tab.picked === null && tab.answered ? ' ✔' : ''; // the typed text is the answer of a single-select tab (S-TABS): keep it short, the tick joins the last row
    const parts = wrap(tab.text, w.cols - 1 - (5 + tBox.length), w.cols - 1 - indent.length);
    parts.forEach((p, j) => rows.push(j === 0 ? [...head, span(p + (j === parts.length - 1 ? tick : ''))] : [span(`${indent}${p}${j === parts.length - 1 ? tick : ''}`)]));
  }
  if (tab.multi) {
    const label = w.i === w.tabs.length - 1 ? 'Submit' : 'Next';
    rows.push(f === 'button' ? [span('❯', ACC), span('    '), span(label, { b: true, fg: 153 })] : [span(`     ${label}`, { b: true })]);
  }
  rows.push([span('─'.repeat(w.cols), DIM)], line(`${ptr(f === k + 2)} ${k + 2}. Chat about this`), []);
  rows.push([span(`${insert ? '-- INSERT -- · ' : ''}Enter to select · ${nav} to navigate${ctrl ? ' · ctrl+g to edit in demo-editor' : ''}${insert ? '' : ' · Esc to cancel'}`, DIM)]);
  return rows;
}

function reviewRows(w) {
  const done = w.tabs.filter((t) => t.answered);
  const rows = [line('⏺ Reviewing.'), [], [span('─'.repeat(w.cols), DIM)], stripRow(w, 'submit', true), [], [span('Review your answers', { b: true, fg: 231 })], []];
  if (done.length < w.tabs.length) rows.push([span('⚠ You have not answered all questions', { fg: 220 })], []);
  for (const t of done) rows.push([span(` ● ${t.question}`)], [span(`   → ${answerOf(t)}`, { fg: 114 })]);
  rows.push([], [span('Ready to submit your answers?', DIM)], [], line(`${ptr(w.rf === 1)} 1. Submit answers`), line(`${ptr(w.rf === 2)} 2. Cancel`));
  return rows;
}

function planRows(w) {
  const n3 = w.plan.labels.length + 1;
  const edge = w.cols - 4;
  return [
    line('⏺ Here is my plan.'), [],
    [span('▔'.repeat(w.cols - 20), ACC), span(' ◐ medium · /effort ', {}), span('▔', ACC)], [],
    [span(`  ${'─'.repeat(edge)}`, { fg: 73 })], [span('   Ready to code?', { b: true, fg: 153 })], [],
    line("   Here is Claude's plan:"), [span(`  ${'╌'.repeat(edge)}`, { fg: 239 })],
    ...w.plan.prose.map((p) => line(`   ${p}`)),
    [span(`  ${'╌'.repeat(edge)}`, { fg: 239 })], ...Array(6).fill([]),
    [span(`  ${'─'.repeat(edge)}`, { fg: 73 })],
    [span('   Claude has written up a plan and is ready to execute. Would you like to proceed?', DIM)], [],
    ...w.plan.labels.map((l, j) => line(`   ${ptr(w.pf === j + 1)} ${j + 1}. ${l}`)),
    line(`   ${ptr(w.pf === n3)} ${n3}. ${w.plan.text ?? PLAN_TEXT_LABEL}`),
    [span('        shift+tab to approve with this feedback', DIM)], [],
    [span('   ctrl+g to edit in Vim · <plans>/demo-api.md', DIM)],
  ];
}

const PERMISSION = ['Bash command', '  run the thing', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];

/** The capture `{ rows, cursor, cols }` for the world's phase. */
function screenOf(w) {
  const pane = (rows) => ({ rows, cursor: { x: 0, y: 0, visible: true }, cols: w.cols });
  switch (w.phase) {
    case 'ask': return pane(askRows(w));
    case 'review': return pane(reviewRows(w));
    case 'plan': return pane(planRows(w));
    case 'prompt': return pane(PERMISSION.map(line));
    case 'exit': return pane([line('⏺ Done planning.'), [], line(`  ${'─'.repeat(116)}`), line('   Exit plan mode?'), [], line('    Claude wants to exit plan mode'), [], line('    ❯ 1. Yes, and switch to default (ask each time) for this session'), line('      2. No')]);
    case 'nudge': {
      const box = boxRows({ cols: w.cols, lines: [''], insert: true });
      return pane([
        line('⏺ All done.'), [], [span('─'.repeat(w.cols), ACC)], [span('  Teach auto mode about your environment?', { b: true, fg: 153 })], [],
        line('  Auto mode works better when it knows your environment. Takes about a minute.'), [], line('  ❯ 1. Yes'), line('    2. Not now'), line("    3. Don't show again"), [],
        [span('  Enter to confirm · Esc to cancel', { fg: 246, i: true })], ...box.rows,
      ]);
    }
    default: return { ...boxRows({ cols: w.cols, lines: [''], insert: w.vim }), cols: w.cols }; // idle: Claude's input box
  }
}

/** Where the focus is: 'option', 'text', 'button', 'chat' (ask), 'review1', 'review2', 'plan-option', 'plan-text', else the phase itself. */
function slotOf(w) {
  if (w.phase === 'review') return `review${w.rf}`;
  if (w.phase === 'plan') return w.pf > w.plan.labels.length ? 'plan-text' : 'plan-option';
  if (w.phase !== 'ask') return w.phase;
  const k = w.tabs[w.i].options.length;
  return w.focus === 'button' ? 'button' : w.focus === k + 1 ? 'text' : w.focus === k + 2 ? 'chat' : 'option';
}

const slotsOf = (tab) => [...tab.options.map((_, j) => j + 1), tab.options.length + 1, ...(tab.multi ? ['button'] : []), tab.options.length + 2];

function goTo(w, j) {
  if (j < 0) return;
  if (j >= w.tabs.length) { w.phase = 'review'; w.rf = 1; return; }
  w.i = j;
  w.focus = 1; // coming back to a tab resets the focus (T0c)
  w.vimMode = 'insert';
}
/** A one-question single-select form has no strip arrows and no Submit tab: Left and Right do nothing there (S-TABS). */
const stripArrows = (w) => w.tabs.length > 1 || w.tabs[w.i].multi;
const close = (w, result) => { w.phase = 'idle'; w.result = result; };

/** A tab is answered: a one-question form is done, any other moves to the next tab (S3 Q2). */
function advance(w) {
  w.tabs[w.i].answered = true;
  if (w.tabs.length === 1) close(w, 'submitted');
  else goTo(w, w.i + 1);
}

function toggle(tab, n) {
  tab.checked = tab.checked.includes(n) ? tab.checked.filter((x) => x !== n) : [...tab.checked, n].sort((a, b) => a - b);
  tab.answered = tab.checked.length > 0 || tab.text !== null;
}

function move(w, by) {
  if (w.phase === 'ask') {
    const slots = slotsOf(w.tabs[w.i]);
    const at = slots.indexOf(w.focus);
    // Up on option 1 wraps to the text row; Down stops at Chat (S-TABS)
    w.focus = by < 0 && at === 0 ? w.tabs[w.i].options.length + 1 : slots[Math.max(0, Math.min(slots.length - 1, at + by))];
    if (w.focus === w.tabs[w.i].options.length + 1) w.vimMode = 'insert'; // vim: the text row takes INSERT at once (T0b)
  } else if (w.phase === 'review') w.rf = Math.max(1, Math.min(2, w.rf + by));
  else if (w.phase === 'plan') w.pf = Math.max(1, Math.min(w.plan.labels.length + 1, w.pf + by));
}

/** Typed characters reach the text row only while it has focus and vim is not in NORMAL mode (there they are vim commands). */
function typeIn(w, text) {
  if (w.phase === 'ask') {
    const tab = w.tabs[w.i];
    if (w.focus !== tab.options.length + 1 || (w.vim && w.vimMode === 'normal')) return;
    tab.text = (tab.text ?? '') + (w.mangle ? w.mangle(text) : text);
    if (tab.multi) tab.answered = true; // typing ticks the Other box (T0c L4)
  } else if (w.phase === 'plan' && w.pf === w.plan.labels.length + 1) w.plan.text = (w.plan.text ?? '') + text;
}

function digit(w, d) {
  const n = Number(d);
  if (w.phase === 'ask') {
    const tab = w.tabs[w.i];
    const k = tab.options.length;
    if (w.focus === k + 1) return typeIn(w, d); // the text row takes digits as text
    if (n <= k) {
      if (tab.multi) toggle(tab, n); // a digit toggles and leaves the focus where it is (S3 Q2)
      else { tab.picked = n; if (w.typedKept === false) tab.text = null; advance(w); }
    } else if (n === k + 1) w.focus = k + 1;
    else if (n === k + 2) close(w, 'chat');
  } else if (w.phase === 'review') {
    if (n === 1) close(w, 'submitted');
    if (n === 2) close(w, 'cancelled');
  } else if (w.phase === 'plan') {
    if (w.pf === w.plan.labels.length + 1) return typeIn(w, d);
    if (n <= w.plan.labels.length) close(w, `approved ${n}`);
  }
}

function enter(w) {
  if (w.phase === 'review') return close(w, w.rf === 1 ? 'submitted' : 'cancelled');
  if (w.phase === 'plan') return w.pf <= w.plan.labels.length ? close(w, `approved ${w.pf}`) : undefined;
  if (w.phase !== 'ask') return undefined;
  const tab = w.tabs[w.i];
  const k = tab.options.length;
  if (w.focus === k + 2) return close(w, 'chat');
  if (w.focus === 'button') return goTo(w, w.i + 1);
  if (w.focus === k + 1) {
    if (!tab.multi && tab.text !== null) { tab.picked = null; advance(w); }
    return undefined;
  }
  if (tab.multi) return toggle(tab, w.focus);
  tab.picked = w.focus;
  if (w.typedKept === false) tab.text = null;
  return advance(w);
}

function key(w, name) {
  if (name === 'Down') move(w, 1);
  else if (name === 'Up') move(w, -1);
  else if (name === 'Enter') enter(w);
  else if (name === 'Right') {
    const tab = w.tabs[w.i];
    if (w.phase === 'ask' && stripArrows(w) && Number.isInteger(w.focus) && w.focus <= tab.options.length) goTo(w, w.i + 1); // from an option row only (T0c, S-TABS); at Review nothing
  } else if (name === 'Left') {
    const tab = w.tabs[w.i];
    if (w.phase === 'ask' && stripArrows(w) && Number.isInteger(w.focus) && w.focus <= tab.options.length) goTo(w, w.i - 1); // no wrap at the first tab; the input rows keep the key
    else if (w.phase === 'review') { w.phase = 'ask'; w.i = w.tabs.length - 1; w.focus = 1; }
  } else if (name === 'Escape') {
    if (w.phase === 'ask' && w.vim && w.vimMode === 'insert' && w.focus === w.tabs[w.i].options.length + 1) w.vimMode = 'normal'; // the first Escape leaves INSERT (T0b L6a)
    else if (['ask', 'review', 'plan', 'exit', 'nudge'].includes(w.phase)) close(w, 'declined');
  }
}

/**
 * dialogWorld(opts) builds the pane. Fields (all can be changed by a test between keys):
 *   phase    'ask' | 'review' | 'plan' | 'prompt' | 'exit' | 'nudge' | 'idle' (a closed dialog leaves 'idle' and `result`)
 *   tabs     the form (TAB.project by default); i the current tab; focus the focused slot (1..k, k+1 the text row, 'button', k+2 chat)
 *   rf, pf   the review's and the plan's focus; plan { labels, prose, text }
 *   vim      Claude's input is vim (INSERT shows while the text row has focus and vimMode is 'insert'); mem { vim, plain } is nika's memory
 *   cols     the pane width; state the registry state (default 'attn')
 *   lag      captures after a key that still show the screen from before it (a late redraw)
 *   typedKept  (default true) a single-select digit keeps the text typed in the text row, as Claude does (S-TABS); false clears it
 *   Input rows (the text row, Chat, Next) keep Left and Right and add `ctrl+g to edit in demo-editor` to the footer; Up on option 1 wraps to the text row
 *   failSend(body, n), drop(body, n) (the key is lost), mangle(text) (typed text arrives changed), onKey(n, w) (runs after the n-th key took
 *   effect), before(n, w) (runs before the n-th capture), hold (a promise every capture waits for)
 * Records: log (every key with the phase, the focus slot and the INSERT marker it landed in, `failed` for a failed send), keysLog() (their names), leaks() (keys that landed
 * outside a dialog), slept, captures.
 */
export function dialogWorld(opts = {}) {
  const w = {
    phase: 'ask', i: 0, focus: 1, rf: 1, pf: 1, vim: false, vimMode: 'insert', cols: 120, state: 'attn', mem: { vim: false, plain: false }, lag: 0,
    plan: { labels: ['Yes, and use auto mode', 'Yes, manually approve edits'], prose: ['- Reply with the single word done.', '- Stop.'], text: null },
    failSend: null, drop: null, mangle: null, onKey: null, before: null, hold: null, result: null, t: 1_000_000, log: [], slept: [], captures: 0, ...opts,
  };
  w.tabs = (opts.tabs ?? [TAB.project]).map(mkTab);
  w.screen = () => screenOf(w);
  let stale = null; // a copy of the screen from before the last key, shown for `lag` captures
  w.mirror = {
    async capture() {
      w.captures += 1;
      w.before?.(w.captures, w);
      if (w.hold) await w.hold;
      if (w.captureFail) return w.captureFail;
      if (stale !== null && stale.left > 0) { stale.left -= 1; return { status: 200, body: stale.screen }; }
      return { status: 200, body: w.screen() };
    },
  };
  w.keys = {
    async send(pane, body) {
      const slot = slotOf(w);
      const entry = { text: body.text, keys: body.keys, paste: body.paste, phase: w.phase, slot, insert: slot === 'text' && w.vim && w.vimMode === 'insert' };
      w.log.push(entry);
      const failed = w.failSend?.(body, w.log.length);
      if (failed) { entry.failed = true; return failed; }
      if (w.lag > 0) stale = { screen: w.screen(), left: w.lag };
      if (!w.drop?.(body, w.log.length)) {
        if (typeof body.text === 'string') {
          if (/^[1-9]$/.test(body.text)) digit(w, body.text);
          else typeIn(w, body.text);
        }
        for (const name of body.keys ?? []) key(w, name);
      }
      w.onKey?.(w.log.length, w);
      return { status: 200, body: { sent: { text: 0, paste: 0, keys: 1 } } };
    },
  };
  w.keysLog = () => w.log.filter((e) => !e.failed).map((e) => (e.keys ? e.keys.join('+') : `text:${e.text}`));
  w.leaks = () => w.log.filter((e) => !['ask', 'review', 'plan'].includes(e.phase));
  w.read = () => readDialogScreen(w.screen().rows, w.cols);
  /** The sig the page would hold for the screen as it is now. */
  w.sig = () => sigOf(w.read());
  w.control = (extra = {}) => createSessionControl({
    mirror: w.mirror, keys: w.keys, paneCommand: async () => 'claude', stateOf: async () => w.state, vimOf: () => w.mem.vim, plainOf: () => w.mem.plain,
    now: () => w.t, sleep: async (ms) => { w.t += ms; w.slept.push(ms); }, ...extra,
  });
  w.ctl = w.control();
  /** What the page posts: `body` plus the current sig (a test passes its own `sig` to send a stale one). */
  w.answer = (body, pane = '%2') => w.ctl.answerDialog(pane, body.sig === undefined ? { sig: w.sig(), ...body } : body);
  return w;
}
