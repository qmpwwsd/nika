// A synthetic Claude Code dialog for the key-script tests (nika 0.5, W1-T2, design W1 section 8). It renders the rows of Claude's question
// dialog (AskUserQuestion: its tabs and its review step), its plan approval (ExitPlanMode), "Exit plan mode?", the auto-mode nudge, a
// permission prompt and an idle input box from a scripted state, and changes that state the way Claude does after each key (shapes and key
// effects from spikes S3, W1-T0, W1-T0b and W1-T0c). It records every key together with the screen it landed in, and it can inject a change
// between two keys, drop a key, swallow a redraw or fail a send. Synthetic text only (acme-api, web-shop, demo-api).
import { createSessionControl } from '../src/session-control.js';
import { PLAN_TEXT_LABEL, readDialogScreen, sigOf, viewOf } from '../src/dialog.js';
import { width } from '../src/draft.js';
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

// A question step with a preview (0.5.4, QP; Claude Code 2.1.328): `preview` is { rows: [one list of lines per option], hidden: a number or one per option, fallback }.
// Its focus is an option number or 'chat' (no text row, no Next button); `note` is Claude's note (null: none), `noteOpen` its field being edited.
TAB.shape = { header: 'Shape', question: 'Pick a shape', options: [['Oval', ''], ['Box', ''], ['Star', '']], preview: { rows: [['( oval )', '', '  long and round'], ['[ box ]'], ['* star *']], hidden: 0, fallback: false } };
TAB.size = { header: 'Size', question: 'Pick a size', options: [['Small', ''], ['Large', '']], preview: { rows: [['s'], ['L']], hidden: 0, fallback: false } };

const mkTab = (t) => ({
  multi: false, picked: null, checked: [], text: null, answered: false, note: null, noteOpen: false, noteText: '', ...t, options: t.options.map((o) => (Array.isArray(o) ? { label: o[0], desc: o[1] } : o)),
  ...(t.preview ? { preview: { ...t.preview, rows: t.preview.rows.map((r) => [...r]), hidden: Array.isArray(t.preview.hidden) ? [...t.preview.hidden] : t.preview.hidden } } : {}), // a copy: a test changes its world's preview, never the shared TAB
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

const PV = { tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518', v: '\u2502', h: '\u2500', lt: '\u251c', rt: '\u2524', cut: '\u2702' };
const PV_FALLBACK = "(can't show the full preview \u00b7 compare the labels and descriptions instead)";
const PV_X = 34; // the default box column; a world sets `pvX` (closed) and `pvXOpen` (while the notes field is open): Claude's columns differ with the pane width (LC-QPB)
const PV_ELLIPSIS = '\u2026'; // the ellipsis Claude ends a cut placeholder with
const PV_PLACEHOLDER = 'Add notes on this design'; // the empty notes field's text, without its ellipsis

/** A preview step the way 2.1.328 draws it: the options at column 0 with the focused option's box beside them, Notes, Chat, the footer wrapped at the pane width. */
function previewRows(w) {
  const tab = w.tabs[w.i];
  const k = tab.options.length;
  const chat = w.focus === 'chat';
  const pv = tab.preview;
  const shown = chat ? k : w.focus; // with Chat focused the box still shows the last option's preview
  const X = tab.noteOpen ? w.pvXOpen ?? w.pvX ?? PV_X : w.pvX ?? PV_X; // the box column, which is also the Notes column (0.5.4, QPF: it differs between a closed and an open field on a narrow pane)
  const W = Math.min(pv.fallback ? width(PV_FALLBACK) + 4 : 44, w.cols - X - 2); // the fallback line is one row: its box is as wide as that needs
  const lines = pv.fallback ? [PV_FALLBACK] : pv.rows[shown - 1] ?? [];
  const hidden = pv.fallback ? 0 : Array.isArray(pv.hidden) ? pv.hidden[shown - 1] ?? 0 : pv.hidden ?? 0;
  const box = [PV.tl + PV.h.repeat(W - 2) + PV.tr];
  for (const t of lines) box.push(`${PV.v} ${t}${' '.repeat(Math.max(0, W - 4 - width(t)))} ${PV.v}`);
  if (hidden > 0) {
    const head = `${PV.lt}${PV.h.repeat(3)} ${PV.cut} ${PV.h.repeat(3)} ${hidden} ${hidden === 1 ? 'line' : 'lines'} hidden `;
    box.push(head + PV.h.repeat(Math.max(0, W - 1 - width(head))) + PV.rt);
  }
  box.push(PV.bl + PV.h.repeat(W - 2) + PV.br);
  const rows = [line('\u23fa I have a question first.'), [], [span('\u2500'.repeat(w.cols), DIM)], stripRow(w, w.i, w.tabs.length > 1), [], [span(tab.question, { b: true, fg: 231 })], []];
  for (let i = 0; i < Math.max(k, box.length); i += 1) {
    const right = box[i] ?? '';
    if (i >= k) { rows.push(right === '' ? [] : [span(' '.repeat(X) + right, DIM)]); continue; }
    const on = w.focus === i + 1 || (chat && w.lastOption === i + 1); // Chat's pointer is added; the option keeps its own
    const left = `${ptr(on)} ${i + 1}. ${tab.options[i].label}${tab.picked === i + 1 ? ' \u2714' : ''}`;
    rows.push([span(ptr(on), ACC), span(` ${i + 1}.`, DIM), span(` ${tab.options[i].label}${tab.picked === i + 1 ? ' \u2714' : ''}`, on ? ACC : {}), span(' '.repeat(Math.max(0, X - width(left)))), span(right, DIM)]);
  }
  // The Notes rows: `Notes: <text>` wrapped word by word at the pane width (the first row at X, the rest at X + 7: LC-QPB d-2, b-3). The open, empty field is one row and, when it would
  // reach the pane's edge, Claude cuts the placeholder so the row ends exactly at the last cell with an ellipsis (LC-QPB d-3b); it is never wrapped.
  const notesRows = [];
  if (tab.noteOpen && tab.noteText === '') {
    const room = w.cols - X - 'Notes: '.length; // cells left for the placeholder
    const text = width(PV_PLACEHOLDER) + 1 <= room ? PV_PLACEHOLDER + PV_ELLIPSIS : PV_PLACEHOLDER.slice(0, Math.max(0, room - 1)) + PV_ELLIPSIS;
    notesRows.push(line(`${' '.repeat(X)}Notes: ${text}`));
  } else {
    const noteText = tab.noteOpen ? tab.noteText : tab.note !== null ? tab.note : 'press n to add notes';
    wrap(`Notes: ${noteText}`, w.cols - 1 - X, w.cols - 1 - (X + 7)).forEach((t, j) => notesRows.push(line(`${' '.repeat(j === 0 ? X : X + 7)}${t}`)));
  }
  rows.push([], ...notesRows, [], [span('\u2500'.repeat(w.cols), DIM)], line(`${chat ? '\u276f' : ' '} Chat about this`), []);
  const sw = w.tabs.length > 1;
  const foot = `Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 n to add notes${sw ? ' \u00b7 Tab to switch questions' : ''}${tab.noteOpen ? ' \u00b7 ctrl+g to edit in Vim' : ''} \u00b7 Esc to cancel`;
  let cur = '';
  for (const word of foot.split(' ')) {
    if (cur === '') cur = word;
    else if (width(cur) + 1 + width(word) <= w.cols) cur += ` ${word}`;
    else { rows.push([span(cur, DIM)]); cur = word; }
  }
  rows.push([span(cur, DIM)]);
  if (w.named) rows.push([span(`${'\u2500'.repeat(Math.max(2, w.cols - 10))} demo \u2500`, DIM)]);
  return rows;
}

function askRows(w) {
  const tab = w.tabs[w.i];
  if (tab.preview) return previewRows(w);
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
  // 2.1.329/2.1.330 (v330, LC-QPB) word the warning `Some questions are unanswered`; 2.1.326 and the v328 option keep `You have not answered all questions`
  if (done.length < w.tabs.length) rows.push([span(w.v330 ? '⚠ Some questions are unanswered' : '⚠ You have not answered all questions', { fg: 220 })], []);
  for (const t of done) rows.push([span(` ● ${t.question}`)], [span(`   → ${answerOf(t)}`, { fg: 114 })]);
  // 2.1.328 and later draw no `Ready to submit your answers?` row (QP1): the options follow the answers after one blank row
  rows.push([], ...(w.v328 || w.v330 ? [] : [[span('Ready to submit your answers?', DIM)], []]), line(`${ptr(w.rf === 1)} 1. Submit answers`), line(`${ptr(w.rf === 2)} 2. Cancel`));
  return rows;
}

const PLAN_PROMPT = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';

/** The plan's footer: one row, or (planPath wider than the pane) the hint row and the path on a second row at indent 3, cut at the pane width (LC-QPB m-2). */
function planFooter(w) {
  const path = w.planPath ?? '<plans>/demo-api.md';
  const one = `   ctrl+g to edit in Vim · ${path}`;
  if (width(one) <= w.cols - 1) return [[span(one, DIM)]];
  const row = [...`   ${path}`].reduce((acc, ch) => (width(acc + ch) <= w.cols ? acc + ch : acc), '');
  return [[span('   ctrl+g to edit in Vim ·', DIM)], [span(row, DIM)]];
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
    // A narrow pane wraps the prompt: Claude broke an 83-cell row at 85 columns (LC-QPB m-6), so the fake wraps it six cells before the pane's edge (cols <= 85), at indent 3, directly under the rule
    ...wrap(PLAN_PROMPT, w.cols - 6, w.cols - 6).map((p) => [span(`   ${p}`, DIM)]), [],
    ...w.plan.labels.map((l, j) => line(`   ${ptr(w.pf === j + 1)} ${j + 1}. ${l}`)),
    line(`   ${ptr(w.pf === n3)} ${n3}. ${w.plan.text ?? PLAN_TEXT_LABEL}`),
    [span('        shift+tab to approve with this feedback', DIM)], [],
    ...planFooter(w),
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
  if (w.tabs[w.i].preview) return w.focus === 'chat' ? 'chat' : w.tabs[w.i].noteOpen ? 'note' : 'option';
  const k = w.tabs[w.i].options.length;
  return w.focus === 'button' ? 'button' : w.focus === k + 1 ? 'text' : w.focus === k + 2 ? 'chat' : 'option';
}

const slotsOf = (tab) => (tab.preview ? [...tab.options.map((_, j) => j + 1), 'chat'] : slotsOf0(tab));
const slotsOf0 = (tab) => [...tab.options.map((_, j) => j + 1), tab.options.length + 1, ...(tab.multi ? ['button'] : []), tab.options.length + 2];

function goTo(w, j) {
  if (j < 0) return;
  if (j >= w.tabs.length) { w.phase = 'review'; w.rf = 1; return; }
  w.i = j;
  w.focus = 1; // coming back to a tab resets the focus (T0c)
  w.lastOption = 1;
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
    if (w.tabs[w.i].preview) { // no wrap: Up stops at option 1, Down stops at Chat; Chat remembers the option it came from
      w.focus = slots[Math.max(0, Math.min(slots.length - 1, at + by))];
      if (Number.isInteger(w.focus)) w.lastOption = w.focus;
      return;
    }
    // Up on option 1 wraps to the text row; Down stops at Chat (S-TABS)
    w.focus = by < 0 && at === 0 ? w.tabs[w.i].options.length + 1 : slots[Math.max(0, Math.min(slots.length - 1, at + by))];
    if (w.focus === w.tabs[w.i].options.length + 1) w.vimMode = 'insert'; // vim: the text row takes INSERT at once (T0b)
  } else if (w.phase === 'review') w.rf = Math.max(1, Math.min(2, w.rf + by));
  else if (w.phase === 'plan') w.pf = Math.max(1, Math.min(w.plan.labels.length + 1, w.pf + by));
}

/** Typed characters reach the text row only while it has focus and vim is not in NORMAL mode (there they are vim commands). */
function typeIn(w, text) {
  if (w.phase === 'ask' && w.tabs[w.i].preview) {
    const tab = w.tabs[w.i];
    if (tab.noteOpen) tab.noteText += w.mangle ? w.mangle(text) : text;
    else if (text === 'n' && tab.note === null && w.focus !== 'chat') tab.noteOpen = true; // `n` opens the notes field
  } else if (w.phase === 'ask') {
    const tab = w.tabs[w.i];
    if (w.focus !== tab.options.length + 1 || (w.vim && w.vimMode === 'normal')) return;
    tab.text = (tab.text ?? '') + (w.mangle ? w.mangle(text) : text);
    if (tab.multi) tab.answered = true; // typing ticks the Other box (T0c L4)
  } else if (w.phase === 'plan' && w.pf === w.plan.labels.length + 1) w.plan.text = (w.plan.text ?? '') + text;
}

function digit(w, d) {
  const n = Number(d);
  if (w.phase === 'ask' && w.tabs[w.i].preview) {
    const tab = w.tabs[w.i];
    if (tab.noteOpen) typeIn(w, d);
    else if (n <= tab.options.length) { w.focus = n; w.lastOption = n; } // a digit only moves the focus on a preview step
  } else if (w.phase === 'ask') {
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
  if (tab.preview) {
    if (w.focus === 'chat') return close(w, 'chat');
    if (tab.noteOpen) { tab.note = tab.noteText; tab.noteOpen = false; } // Enter in the notes field saves it, selects the option and advances
    tab.picked = w.focus;
    return advance(w);
  }
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
 *   v328     the Review is drawn the way Claude Code 2.1.328 does: no `Ready to submit your answers?` row (default: the 2.1.326 shape)
 *   v330     the Review is drawn the way Claude Code 2.1.329/2.1.330 do (0.5.4, QPF): the v328 layout, and the warning reads `Some questions are unanswered`
 *   pvX, pvXOpen  the box column of a preview step (also its Notes column), closed and while the notes field is open (default 34, the same): 29 and 27 at 52 columns, as LC-QPB saw;
 *            the open, empty field is cut at the pane's edge with an ellipsis when `Notes: Add notes on this design...` would reach it
 *   planPath the plan file named in the plan's footer (default `<plans>/demo-api.md`); when it is wider than the pane it goes on a second footer row
 *            (a plan prompt wider than the pane minus six cells is drawn wrapped, at indent 3)
 *   vim      Claude's input is vim (INSERT shows while the text row has focus and vimMode is 'insert'); mem { vim, plain } is nika's memory
 *   cols     the pane width; state the registry state (default 'attn')
 *   lag      captures after a key that still show the screen from before it (a late redraw)
 *   A tab with a `preview` (TAB.shape, TAB.size; 0.5.4 QP) is drawn the way 2.1.328 does: no text row, no Next button, its focus is 1..k or 'chat'; a digit only moves the focus,
 *   `n` opens its notes field (`noteOpen`; typed text goes to `noteText`), Enter selects the focused option (saving an open note) and advances, Down at the last option reaches Chat,
 *   Enter on Chat closes the dialog ('chat'); `named` adds the labelled rule row under the footer; `lastOption` is the option Chat's pointer came from
 *   typedKept  (default true) a single-select digit keeps the text typed in the text row, as Claude does (S-TABS); false clears it
 *   Input rows (the text row, Chat, Next) keep Left and Right and add `ctrl+g to edit in demo-editor` to the footer; Up on option 1 wraps to the text row
 *   failSend(body, n), drop(body, n) (the key is lost), mangle(text) (typed text arrives changed), onKey(n, w) (runs after the n-th key took
 *   effect), before(n, w) (runs before the n-th capture), hold (a promise every capture waits for)
 * Records: log (every key with the phase, the focus slot and the INSERT marker it landed in, `failed` for a failed send), keysLog() (their names), leaks() (keys that landed
 * outside a dialog), slept, captures.
 */
export function dialogWorld(opts = {}) {
  const w = {
    phase: 'ask', i: 0, focus: 1, lastOption: 1, named: false, rf: 1, pf: 1, vim: false, vimMode: 'insert', cols: 120, state: 'attn', mem: { vim: false, plain: false }, lag: 0,
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
  /** The `view` the page would hold for a preview step as it is now (0.5.4, QP). */
  w.view = () => viewOf(w.read());
  w.control = (extra = {}) => createSessionControl({
    mirror: w.mirror, keys: w.keys, paneCommand: async () => 'claude', stateOf: async () => w.state, vimOf: () => w.mem.vim, plainOf: () => w.mem.plain,
    now: () => w.t, sleep: async (ms) => { w.t += ms; w.slept.push(ms); }, ...extra,
  });
  w.ctl = w.control();
  /** What the page posts: `body` plus the current sig (a test passes its own `sig` to send a stale one). */
  w.answer = (body, pane = '%2') => w.ctl.answerDialog(pane, body.sig === undefined ? { sig: w.sig(), ...body } : body);
  return w;
}
