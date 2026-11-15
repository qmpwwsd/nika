// Reads Claude Code's question dialog (AskUserQuestion: one tab at a time, and the review step) and its plan approval (ExitPlanMode) from the
// rows of a pane capture, exactly or not at all (design W1, nika 0.5; docs/contracts/claude-tui.md). Pure: no I/O. Everything fails closed:
// a dialog that is cut off, too wide to be sure of, numbered above 9 or not exactly the captured shape is `unreadable`, and the page keeps
// its banner. `sig` is over the PARSED step, never over raw rows (rows change with every focus move, tick and typed character).
// Keep this file ASCII: write every symbol as an escape.
import { createHash } from 'node:crypto';
import { clean } from './text.js';
import { RULE_ROW, width } from './draft.js';
import { ASK_FOOTER, PLAN_FOOTER, REVIEW_END, bypassWindow, footerEnd, mentionsBypass, nudgeFooterAt, promptFromRows, rowText, surveyShown } from './mode.js';

export const TABS_MAX = 8; // strip tokens; more is garbage
export const NUMBER_MAX = 9; // a digit answers without Enter, so an option number above 9 is unsupported (k <= 7)
export const HEADER_MAX = 40;
export const QUESTION_MAX = 500;
export const LABEL_MAX = 200;
export const DESC_MAX = 500;
export const ANSWER_MAX = 500; // a review answer, and the value of a text row
export const TEXT_MAX = 300; // free text nika types (spike W1-T0b L10b: 300 characters read back exactly)
export const STEPS_MAX = 24; // loop guard per request (T2)
/** Free text in a multi-select question: only on the LAST tab (otherAllowed), where `Down` to the button row and `Enter` open the review (T0c). */
export const MULTI_OTHER = true;
/** How a plan choice is pressed: the digit takes effect at once (spike W1-T0b L5). */
export const PLAN_PICK = 'digit';
/** Free text on a pane that is not vim: the footer matches ASK_FOOTER and the text reads back (spike W1-T0c L9). */
export const PLAIN_TEXT = true;
/** The plan's free-text option; its label is this constant whatever is typed, so typing never changes the step's identity. */
export const PLAN_TEXT_LABEL = 'Tell Claude what to change';
/** Why a dialog on screen is not read, in the order they are decided (the first one found wins). */
export const REASONS = ['cut', 'wide', 'numbers', 'tab', 'layout', 'survey'];

const MIN_COLS = 20;
const SPAN_MAX = 100; // rows from the strip down to the footer: 7 options with wrapped descriptions fit well within
const PLAN_ROWS_MAX = 400;
const PLACEHOLDERS = ['Type something.', 'Type something', 'Chat about this'];
const PLAN_INTRO = "Here is Claude's plan:";
const PLAN_PROMPT = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';
const PLAN_HINT = 'shift+tab to approve with this feedback';
const EXIT_TITLE = 'Exit plan mode?';

// Rows (rtrimmed, no-break spaces read as spaces). An option row is two characters (the pointer or a space, then a space), the number, a dot.
// Any number matches so that a `10.` is seen and refused (numbers) instead of being glued to the row above.
const ASK_OPTION = /^(\u276f| ) (\d+)\. (.*)$/;
const CHAT_ROW = /^(\u276f| ) (\d+)\. Chat about this$/;
const CHECKBOX = /^\[([ \u2714])\] (.+)$/;
const BUTTON_ROW = /^(?:\u276f {4}| {5})(Next|Submit)$/; // the multi question's button row: indent 5, pointer in the first column when focused
const STRIP_START = /^ {0,2}(?:\u2190 +)?[\u2610\u2612\u2714] /;
const WARN_ROW = /^\u26a0 You have not answered all questions$/;
const PAIR_Q = /^ {0,2}\u25cf (.+)$/;
const PAIR_A = /^ {2,6}\u2192 (.+)$/;
const REVIEW_OPTION = /^(\u276f| ) ([12])\. (Submit answers|Cancel)$/;
const PLAN_OPTION = /^ {3}(\u276f| ) (\d+)\. (.*)$/; // plan options are indented 3 (spike W1-T0b 3.8)
const DASHED_RULE = /^ *\u254c+$/;
const PLAIN_RULE = /^ *\u2500+$/;
const GLYPH = /[\u2610\u2612\u2714]/;
const ELLIPSIS = '\u2026';

const spaced = (text) => text.replace(/\u00a0/g, ' ').trimEnd();

/**
 * What kind of dialog the bottom of the screen shows, or null. `texts` are the rtrimmed rows, `nb` the indexes of the non-blank rows down to
 * the footer (a subagent list under it is cut by footerEnd), `foot` the indexes of the footer rows: one, or up to three when Claude wrapped
 * the footer at a narrow width (their texts are joined with one space; a wrapped footer is found but never read, see readAsk).
 *   ask      a question step: the footer is ASK_FOOTER
 *   review   the review step: the last row is `2. Cancel` and `Review your answers` is in the last 40 rows
 *   plan     the plan approval: the footer is PLAN_FOOTER and `Ready to code?` is above it (the reader wants exactly one such row)
 *   exit     "Exit plan mode?": two options, no footer (spike W1-T0b 3.9)
 *   nudge    "Teach auto mode about your environment?": digit options, its footer is not the last row (src/mode.js nudgeFooterAt)
 * The last two are recognised so that everything that needs a plain input box fails closed; they are never read as a form.
 */
function shapeOf(rows) {
  if (!Array.isArray(rows)) return null;
  const raw = rows.map(rowText);
  const end = footerEnd(raw);
  const texts = raw.map(spaced);
  const nb = [];
  for (let x = 0; x <= end && x < texts.length; x += 1) if (texts[x].trim()) nb.push(x);
  const last = nb.at(-1);
  if (last === undefined) return null;
  const T = (x) => texts[x].trim();
  const base = { texts, nb };
  if (nudgeFooterAt(raw) === last) return { ...base, kind: 'nudge', foot: [last] };
  if (nb.length >= 3 && /^(?:\u276f )?2\. No$/.test(T(last)) && /^(?:\u276f )?1\. Yes\b/.test(T(nb.at(-2))) && nb.slice(-6, -2).some((x) => T(x) === EXIT_TITLE)) {
    return { ...base, kind: 'exit', foot: [last] };
  }
  for (let n = 1; n <= Math.min(3, nb.length); n += 1) {
    const foot = nb.slice(-n);
    const joined = foot.map(T).join(' ');
    const ask = ASK_FOOTER.exec(joined);
    if (ask !== null) return { ...base, kind: 'ask', foot, nav: ask[1] };
    if (PLAN_FOOTER.test(joined)) {
      const above = texts.slice(0, foot[0]);
      const ready = above.findLastIndex((t) => t.trim() === 'Ready to code?');
      // `readies`: how many such rows are above the footer. The dialog is recognised with one or more (so everything that needs a plain box still
      // refuses), but it is read only with exactly one: a plan text that repeats the title would move where the reading starts (M6).
      if (ready >= 0) return { ...base, kind: 'plan', foot, ready, readies: above.filter((t) => t.trim() === 'Ready to code?').length };
    }
  }
  if (REVIEW_END.test(T(last)) && nb.slice(-40).some((x) => T(x) === 'Review your answers')) return { ...base, kind: 'review', foot: [last] };
  return null;
}

/**
 * True when the bottom of the screen shows one of Claude's dialogs (a question step, the review, a plan approval, or the two shapes nika never reads).
 * src/session-control.js (promptOpen) and src/api-app.js (the keys route's look for Send's typing) import it. src/scroll.js does not: it relies on
 * `readDraft` being null for every dialog shape (the footer is no mode line, or the cursor is outside a box), so its box gate refuses them by itself.
 */
export const dialogOnScreen = (rows) => shapeOf(rows) !== null;

/** The strip row: tokens ` <box> <header> ` with an optional `Submit` token (with or without brackets), arrows at both ends. null when it is not exactly that. */
function parseStrip(row) {
  let text = '';
  const on = []; // per UTF-16 unit: carries a background or reverse video (the current tab, spike S3)
  for (const sp of Array.isArray(row) ? row : []) {
    const t = typeof sp?.t === 'string' ? sp.t.replace(/\u00a0/g, ' ') : '';
    text += t;
    const mark = sp?.s?.bg != null || sp?.s?.r === true;
    for (let k = 0; k < t.length; k += 1) on.push(mark);
  }
  let a = 0;
  while (text[a] === ' ') a += 1;
  if (text[a] === '\u2190') { a += 1; while (text[a] === ' ') a += 1; }
  let b = text.length;
  while (b > a && text[b - 1] === ' ') b -= 1;
  if (b > a && text[b - 1] === '\u2192') { b -= 1; while (b > a && text[b - 1] === ' ') b -= 1; }
  const core = text.slice(a, b);
  const starts = [...core.matchAll(/[\u2610\u2612\u2714] (?=\S)/g)].map((m) => m.index).filter((p) => p === 0 || core[p - 1] === ' ');
  if (starts[0] !== 0 || starts.length > TABS_MAX + 1) return null;
  const tabs = [];
  let submit = null;
  let opened = false; // the token before `Submit` ended with ` [`
  for (const [n, from] of starts.entries()) {
    const seg = core.slice(from, starts[n + 1] ?? core.length);
    const gap = seg.length - seg.trimEnd().length; // spaces up to the next token: tab tokens sit two apart in every capture
    let rest = seg.slice(2).trimEnd();
    const open = core[starts[n + 1]] === '\u2714' && / \[$/.test(rest);
    if (open) rest = rest.slice(0, -2).trimEnd();
    const close = seg[0] === '\u2714' && rest === 'Submit ]';
    if (close) rest = 'Submit';
    const cells = [];
    for (let k = a + from; k < a + from + 2 + rest.length; k += 1) if (text[k] !== ' ') cells.push(on[k]);
    const marked = cells.length > 0 && cells.every(Boolean);
    const mixed = cells.some(Boolean) && !marked;
    if (seg[0] === '\u2714') {
      if (rest !== 'Submit' || n !== starts.length - 1 || opened !== close) return null; // brackets come in pairs: `[ <check> Submit ]`
      submit = { marked, mixed };
    } else {
      opened = open;
      if (tabs.length > 0 && tabs.at(-1).gap < 2) return null;
      tabs.push({ header: rest, answered: seg[0] === '\u2612', marked, mixed, gap });
    }
  }
  if (tabs.length === 0 && submit === null) return null;
  return { tabs, submit };
}

/** The row of the strip: the nearest row above `stop` that looks like a strip and has a rule row directly above it, else -1. */
function findStrip(texts, stop) {
  for (let x = stop - 1; x >= 1 && stop - x <= SPAN_MAX; x -= 1) if (STRIP_START.test(texts[x]) && RULE_ROW.test(texts[x - 1])) return x;
  return -1;
}

/** clean() with a cap. Empty or too long adds `layout`; a text that ends in an ellipsis adds `cut` (Claude may have cut it) when `ellipsis`. */
function take(bad, text, max, ellipsis = true) {
  const v = clean(text, max + 1);
  if (v === null || v.length > max) { bad.add('layout'); return ''; }
  if (ellipsis && v.endsWith(ELLIPSIS)) bad.add('cut');
  return v;
}

/** The label of a question option without its checkbox (multi) or its trailing answered tick (single). */
function labelOf(body, multi) {
  if (multi) {
    const m = CHECKBOX.exec(body);
    return { text: m[2], checked: m[1] === '\u2714', ticked: false };
  }
  const m = /^(.*?)( \u2714)?$/.exec(body);
  return { text: m[1], checked: false, ticked: m[2] !== undefined };
}

const indented = (t, n) => t.startsWith(' '.repeat(n)) && t[n] !== ' ';
/** Whether a row of the region, not exempt, is as wide as the pane: Claude may have cut it there. Rule rows are exactly as wide as the pane. */
const reachesCols = (texts, from, to, cols, exempt) => {
  for (let x = from; x <= to; x += 1) if (!exempt.has(x) && !PLAIN_RULE.test(texts[x]) && width(texts[x]) >= cols) return true;
  return false;
};

/** The current question tab (everything between the strip and the footer). Returns the fields of S or null; reasons go to `bad`. */
function readQuestion(c) {
  const { texts, bad, s, stop, tabs, strip, cols } = c;
  let x = s + 1;
  const q = [];
  while (x < stop && !ASK_OPTION.test(texts[x])) {
    if (texts[x].trim()) q.push(texts[x].trim());
    if (RULE_ROW.test(texts[x]) || STRIP_START.test(texts[x])) bad.add('layout'); // a rule or a strip inside the question could be taken for the real one
    x += 1;
  }
  if (x >= stop) { bad.add('numbers'); return null; }
  if (q.length === 0) bad.add('layout');
  const items = []; // the numbered rows down to the separator; indented rows belong to the numbered row above them
  let sep = -1;
  for (; x < stop; x += 1) {
    const t = texts[x];
    if (RULE_ROW.test(t)) { sep = x; break; }
    const m = ASK_OPTION.exec(t);
    if (m !== null) items.push({ x, focus: m[1] === '\u276f', n: Number(m[2]), body: m[3], extra: [] });
    else if (t.trim() === '') bad.add('layout');
    else items.at(-1).extra.push(x);
  }
  if (sep < 0) { bad.add('layout'); return null; }
  let chat = null;
  for (x = sep + 1; x < stop; x += 1) {
    if (!texts[x].trim()) continue;
    const m = chat === null ? CHAT_ROW.exec(texts[x]) : null;
    if (m === null) bad.add('layout');
    else chat = { n: Number(m[2]), focus: m[1] === '\u276f' };
  }
  const m = items.length;
  if (chat === null || m < 2 || items.some((it, j) => it.n !== j + 1) || chat.n !== m + 1 || chat.n > NUMBER_MAX) { bad.add('numbers'); return null; }
  const multi = CHECKBOX.test(items[0].body);
  if (items.some((it) => CHECKBOX.test(it.body) !== multi)) { bad.add('layout'); return null; }
  const k = m - 1;

  const options = items.slice(0, k).map((it) => {
    const { text, checked, ticked } = labelOf(it.body, multi);
    const label = take(bad, text, LABEL_MAX);
    if (GLYPH.test(label)) bad.add('layout');
    let description = null;
    if (it.extra.length > 0) {
      // The row after an option row is a description unless it is the rest of a wrapped label. It cannot be told apart, except that
      // Claude wraps at the pane width (cols - 1 cells, measured): a first word that would have fitted behind the label was not wrapped.
      const word = texts[it.extra[0]].trim().split(' ')[0];
      if (width(texts[it.x]) + 1 + width(word) > cols - 1) bad.add('wide');
      if (it.extra.some((e) => !indented(texts[e], multi ? 9 : 5))) bad.add('layout');
      description = take(bad, it.extra.map((e) => texts[e].trim()).join(' '), DESC_MAX, false);
    }
    return { n: it.n, label, description, ...(multi ? { checked } : { ticked }) };
  });

  // The text row (option k+1): its value may wrap onto indented rows; in a multi question the button row is the last row under it.
  const tail = items[k];
  const t = labelOf(tail.body, multi);
  let rest = tail.extra.map((e) => texts[e]);
  const bm = rest.length > 0 ? BUTTON_ROW.exec(rest.at(-1)) : null;
  const button = bm === null ? null : bm[1];
  const buttonFocus = bm !== null && rest.at(-1)[0] === '\u276f';
  if (bm !== null) rest = rest.slice(0, -1);
  if (multi !== (button !== null)) { bad.add('numbers'); return null; }
  if (rest.some((e) => !/^ {4,}\S/.test(e))) bad.add('layout');
  const typed = [t.text, ...rest.map((e) => e.trim())].join(' ');
  const textRow = {
    n: m,
    value: rest.length === 0 && t.text === (multi ? 'Type something' : 'Type something.') ? null : take(bad, typed, ANSWER_MAX, false),
    ...(multi ? { checked: t.checked } : { ticked: t.ticked }),
  };

  const labels = options.map((o) => o.label);
  if (new Set(labels).size !== labels.length || labels.some((l) => PLACEHOLDERS.includes(l))) bad.add('layout');
  const marks = [...items.filter((it) => it.focus).map((it) => it.n), ...(chat.focus ? [chat.n] : []), ...(buttonFocus ? ['button'] : [])];
  if (marks.length > 1) bad.add('layout');
  const current = tabs.findIndex((_, n) => strip.tabs[n].marked);
  if (multi && (button === 'Submit') !== (current === tabs.length - 1)) bad.add('layout'); // Submit is the last tab's button, Next any other's
  if ((multi || tabs.length > 1) && strip.submit === null) bad.add('layout');
  const exempt = new Set([tail.x, ...tail.extra.filter((e) => BUTTON_ROW.exec(texts[e]) === null)]); // a text row's wrapped value reaches the pane's edge legitimately
  const question = take(bad, q.join(' '), QUESTION_MAX);
  if (GLYPH.test(question)) bad.add('layout');
  return { question, multi, options, textRow, chat: chat.n, button, focus: marks.length === 1 ? marks[0] : null, exempt };
}

/** The review step: `Review your answers`, the optional warning, the answered pairs, the question and the two options. */
function readReview(c) {
  const { texts, bad, s, last } = c;
  let x = s + 1;
  const skip = () => { while (x <= last && !texts[x].trim()) x += 1; };
  skip();
  if (x > last || texts[x].trim() !== 'Review your answers') { bad.add('layout'); return null; }
  x += 1;
  skip();
  const warn = x <= last && WARN_ROW.test(texts[x].trim());
  if (warn) { x += 1; skip(); }
  const raw = [];
  let part = 'q';
  for (; x <= last && texts[x].trim() !== 'Ready to submit your answers?'; x += 1) {
    const t = texts[x];
    if (!t.trim()) continue;
    const q = PAIR_Q.exec(t);
    const a = raw.length > 0 && part === 'q' ? PAIR_A.exec(t) : null;
    if (q !== null) { raw.push({ q: [q[1]], a: [] }); part = 'q'; }
    else if (a !== null) { raw.at(-1).a.push(a[1]); part = 'a'; }
    else if (raw.length > 0 && /^ {3,}[^\s\u25cf\u2192]/.test(t)) raw.at(-1)[part].push(t.trim()); // the rest of a wrapped question or answer
    else bad.add('layout');
  }
  if (x > last) { bad.add('layout'); return null; }
  const choices = [];
  for (x += 1; x <= last; x += 1) if (texts[x].trim()) choices.push(texts[x]);
  const ms = choices.map((t) => REVIEW_OPTION.exec(t));
  if (choices.length !== 2 || ms.some((m) => m === null) || ms[0][2] !== '1' || ms[0][3] !== 'Submit answers' || ms[1][2] !== '2' || ms[1][3] !== 'Cancel') {
    bad.add('layout');
    return null;
  }
  if (raw.length > TABS_MAX || raw.some((p) => p.a.length === 0)) bad.add('layout');
  const pairs = raw.map((p) => ({ question: take(bad, p.q.join(' '), QUESTION_MAX), answer: take(bad, p.a.join(' '), ANSWER_MAX) }));
  const marks = ms.flatMap((m) => (m[1] === '\u276f' ? [Number(m[2])] : []));
  if (marks.length > 1) bad.add('layout');
  return { warn, pairs, focus: marks.length === 1 ? marks[0] : null, exempt: new Set() };
}

/** A question step or the review step. `bad` collects reasons; S is only used when it stays empty. */
function readAsk(shape, rows, cols) {
  const { texts, foot } = shape;
  const review = shape.kind === 'review';
  const bad = new Set();
  const stop = foot[0];
  const last = foot.at(-1);
  if (!Number.isInteger(cols) || cols < MIN_COLS || foot.length > 1) bad.add('wide'); // a wrapped footer is never read (orchestrator ruling 1)
  const s = findStrip(texts, stop);
  if (s < 0) { bad.add('cut'); return { bad, S: null }; }
  const strip = parseStrip(rows[s]);
  if (strip === null) { bad.add('layout'); return { bad, S: null }; }
  const tabs = strip.tabs.map((t) => ({ header: take(bad, t.header, HEADER_MAX), answered: t.answered }));
  if (tabs.some((t) => GLYPH.test(t.header)) || tabs.length > TABS_MAX || tabs.length === 0) bad.add('layout');
  if (strip.tabs.some((t) => t.mixed) || strip.submit?.mixed) bad.add('tab');
  const marked = strip.tabs.flatMap((t, n) => (t.marked ? [n] : []));
  const ctx = { texts, bad, s, stop, last, tabs, strip, cols };
  const insert = /^-- INSERT --/.test(texts[stop].trim());
  const region = texts.slice(s, last + 1).join(' ');
  const bypass = mentionsBypass(region) || bypassWindow(rows);
  let body = null;
  let S = null;
  if (review) {
    if (marked.length > 0 || strip.submit === null || !strip.submit.marked) bad.add('tab'); // the Submit token is the current one
    body = readReview(ctx);
    if (body !== null) {
      const done = tabs.filter((t) => t.answered).length; // the review lists the answered questions only, and warns while a tab is still open
      if (body.pairs.length !== done || body.warn !== (done < tabs.length)) bad.add('layout');
    }
    if (body !== null) S = { kind: 'ask', at: 'review', tabs, warn: body.warn, pairs: body.pairs, focus: body.focus, insert: false, bypass };
  } else {
    if (marked.length !== 1 || strip.submit?.marked === true) bad.add('tab');
    body = readQuestion(ctx);
    if (body !== null) {
      const several = tabs.length > 1;
      if (shape.nav === '\u2191/\u2193' ? several : !several && strip.submit === null) bad.add('layout'); // the footer agrees with the strip
      S = {
        kind: 'ask', at: 'question', tabs, i: marked.length === 1 ? marked[0] : 0, single: !several, question: body.question, multi: body.multi,
        options: body.options, textRow: body.textRow, chat: body.chat, button: body.button, focus: body.focus, insert, bypass,
      };
    }
  }
  if (body !== null && reachesCols(texts, s, last, cols, body.exempt)) bad.add('wide');
  return { bad, S };
}

/** The plan approval. */
function readPlan(shape, rows, cols) {
  const { texts, foot, ready, readies } = shape;
  const bad = new Set();
  if (readies !== 1) bad.add('layout'); // a second `Ready to code?` row: the plan's start is ambiguous, so the plan is not read
  const stop = foot[0];
  const last = foot.at(-1);
  if (!Number.isInteger(cols) || cols < MIN_COLS || foot.length > 1) bad.add('wide');
  let x = ready + 1;
  while (x < stop && !texts[x].trim()) x += 1;
  if (x < stop && texts[x].trim() === PLAN_INTRO) x += 1;
  else bad.add('layout');
  while (x < stop && !texts[x].trim()) x += 1;
  if (x >= stop || !DASHED_RULE.test(texts[x])) { bad.add('cut'); return { bad, S: null }; }
  const from = x + 1;
  let to = from;
  while (to < stop && !DASHED_RULE.test(texts[to])) to += 1;
  let p = to + 1;
  while (p < stop && texts[p].trim() !== PLAN_PROMPT) p += 1;
  if (to >= stop || p >= stop) { bad.add('cut'); return { bad, S: null }; }
  const between = texts.slice(to + 1, p).filter((t) => t.trim());
  if (between.length !== 1 || !PLAIN_RULE.test(between[0])) bad.add('layout');
  const prose = texts.slice(from, to).map((t) => clean(t, 500) ?? '');
  while (prose.length > 0 && prose[0] === '') prose.shift();
  while (prose.length > 0 && prose.at(-1) === '') prose.pop();
  if (prose.length > PLAN_ROWS_MAX) bad.add('layout');

  const items = [];
  let prev = '';
  for (x = p + 1; x < stop; x += 1) {
    const t = texts[x];
    if (!t.trim()) continue;
    const m = PLAN_OPTION.exec(t);
    if (m !== null) { items.push({ focus: m[1] === '\u276f', n: Number(m[2]), body: m[3], hint: false }); prev = 'option'; }
    else if (t.trim() === PLAN_HINT && prev === 'option') { items.at(-1).hint = true; prev = 'hint'; }
    else {
      bad.add(prev === 'option' ? 'wide' : 'layout'); // a row under an option may be the rest of a wrapped label
      prev = 'other';
    }
  }
  if (items.length < 2 || items.some((it, j) => it.n !== j + 1 || it.n > NUMBER_MAX)) { bad.add('numbers'); return { bad, S: null }; }
  if (items.slice(0, -1).some((it) => it.hint)) bad.add('layout'); // only the last option is the text option
  const tail = items.at(-1);
  const options = items.map((it) => ({ n: it.n, label: it.hint ? PLAN_TEXT_LABEL : take(bad, it.body, LABEL_MAX), text: it.hint }));
  const textRow = tail.hint ? { n: tail.n, value: tail.body === PLAN_TEXT_LABEL ? null : take(bad, tail.body, ANSWER_MAX, false) } : null;
  const labels = options.map((o) => o.label);
  if (new Set(labels).size !== labels.length) bad.add('layout');
  const marks = items.filter((it) => it.focus).map((it) => it.n);
  if (marks.length > 1) bad.add('layout');
  if (reachesCols(texts, p, last, cols, new Set())) bad.add('wide');
  const S = {
    kind: 'plan', at: 'plan', options, textRow, planRows: prose, focus: marks.length === 1 ? marks[0] : null,
    insert: /^-- INSERT --/.test(texts[stop].trim()), bypass: mentionsBypass(texts.slice(p, last + 1).join(' ')) || bypassWindow(rows),
  };
  return { bad, S };
}

/**
 * Reads the dialog at the bottom of a capture (`rows` are the span rows, `cols` the pane width). Returns
 *   null                                  no dialog is on screen (dialogOnScreen is false)
 *   { unreadable, kind }                  a dialog is there but not read exactly: `unreadable` is one of REASONS, `kind` 'ask', 'plan' or null
 *   S                                     the step. `kind` 'ask' | 'plan'; `at` 'question' | 'review' | 'plan'; common fields `focus`
 *                                         (the focused option number, 'button' or null), `insert` (the footer starts `-- INSERT --`: the
 *                                         text row has focus in vim), `bypass`.
 *     question: tabs [{ header, answered }], i (the current tab), single (one tab), question, multi, options [{ n, label,
 *               description|null, checked (multi) | ticked (single) }], textRow { n, value|null, checked | ticked }, chat (its number),
 *               button 'Next' | 'Submit' | null
 *     review:   tabs, warn, pairs [{ question, answer }]
 *     plan:     options [{ n, label, text }], textRow { n, value|null } | null, planRows (the visible plan, only for the identity)
 * Strings are clean()ed and bounded. A dialog is unreadable when it is cut off (`cut`), may be cut at the pane's edge or is wrapped in a way
 * that cannot be told from a description (`wide`), is numbered above 9 or with gaps (`numbers`), has no single current tab (`tab`), or
 * is any other shape (`layout`); a feedback survey on screen is `survey`. A wrapped footer is always unreadable.
 */
export function readDialogScreen(rows, cols) {
  const shape = shapeOf(rows);
  if (shape === null) return null;
  if (shape.kind === 'nudge' || shape.kind === 'exit') return { unreadable: 'layout', kind: null };
  const plan = shape.kind === 'plan';
  const { bad, S } = plan ? readPlan(shape, rows, cols) : readAsk(shape, rows, cols);
  if (surveyShown(rows)) bad.add('survey');
  const reason = REASONS.find((r) => bad.has(r));
  return reason === undefined && S !== null ? S : { unreadable: reason ?? 'layout', kind: plan ? 'plan' : 'ask' };
}

/**
 * The step's identity as canonical JSON: the parsed content a key of one request must not change (design W1 2.4). It holds the strip's
 * headers, the current tab, the question and the options' labels and descriptions; or every review pair; or the visible plan rows and the
 * options (label and whether it is the text option). Focus, ticks, the answered marks and the typed text are not in it (they change during a request).
 */
export function identityOf(S) {
  const id = S.at === 'question'
    ? ['question', S.tabs.map((t) => t.header), S.i, S.question, S.multi, S.options.map((o) => [o.label, o.description])]
    : S.at === 'review'
      ? ['review', S.tabs.map((t) => t.header), S.warn, S.pairs.map((p) => [p.question, p.answer])]
      : ['plan', S.planRows, S.options.map((o) => [o.label, o.text])];
  return JSON.stringify([S.kind, id]);
}

/** 16 hex characters of sha256 over identityOf(S). */
export const sigOf = (S) => createHash('sha256').update(identityOf(S)).digest('hex').slice(0, 16);

/** Whether free text may be typed in this question: always in a single-select one, in a multi one only on the last tab (MULTI_OTHER). */
export const otherAllowed = (S) => S.at === 'question' && (!S.multi || (MULTI_OTHER && S.i === S.tabs.length - 1));

/**
 * The capture's `dialog` field (design W1 3): null, `{ state: 'unreadable', kind, reason }` or `{ state: 'ready', kind, at, sig, bypass, ... }`.
 * null when no dialog is on screen or a permission prompt parses. The multi checkboxes carry Claude's `checked` marks.
 */
export function dialogCapture(rows, cols) {
  if (promptFromRows(rows) !== null) return null;
  const S = readDialogScreen(rows, cols);
  if (S === null) return null;
  if (S.unreadable !== undefined) return { state: 'unreadable', kind: S.kind, reason: S.unreadable };
  const head = { state: 'ready', kind: S.kind, at: S.at, sig: sigOf(S), bypass: S.bypass };
  if (S.at === 'review') return { ...head, tabs: S.tabs, warn: S.warn, pairs: S.pairs };
  if (S.at === 'plan') return { ...head, options: S.options };
  return {
    ...head, tabs: S.tabs, current: S.i, final: S.single && !S.multi, question: S.question, multi: S.multi, other: otherAllowed(S),
    options: S.options.map((o) => ({ n: o.n, label: o.label, description: o.description, ...(S.multi ? { checked: o.checked } : {}) })),
  };
}
