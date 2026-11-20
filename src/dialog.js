// Reads Claude Code's question dialog (AskUserQuestion: one tab at a time, and the review step) and its plan approval (ExitPlanMode) from the
// rows of a pane capture, exactly or not at all (design W1, nika 0.5; docs/contracts/claude-tui.md). Pure: no I/O. Everything fails closed:
// a dialog that is cut off, too wide to be sure of, numbered above 9 or not exactly the captured shape is `unreadable`, and the page keeps
// its banner. `sig` is over the PARSED step, never over raw rows (rows change with every focus move, tick and typed character).
// Keep this file ASCII: write every symbol as an escape.
import { createHash } from 'node:crypto';
import { clean, cleanBlock } from './text.js';
import { RULE_ROW, width } from './draft.js';
import { ASK_FOOTER, PLAN_FOOTER, REVIEW_END, askFooterRows, bypassWindow, footerEnd, mentionsBypass, nudgeFooterAt, promptFromRows, rowText, surveyOrFollowUpShown } from './mode.js';

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
/** Why a dialog on screen is not read, in the order they are decided (the first one found wins). `cut`: clipped at the top (or a plan without
 *  its rules): more rows can show it (F16). `clipped`: a text ends in an ellipsis: Claude shortened it to the width; rows never help. */
export const REASONS = ['cut', 'clipped', 'wide', 'numbers', 'tab', 'layout', 'survey'];

const MIN_COLS = 20;
const SPAN_MAX = 160; // rows from the strip down to the footer: 7 options with wrapped descriptions fit well within, and so does a preview step on a 120-row pane (0.5.4, QP; was 100)
const PREVIEW_ROWS_MAX = 120; // a preview's rows (the F16 grow cap is 120 pane rows); more is unreadable / layout, never cut
const PREVIEW_LINE_MAX = 200; // characters in one preview row
const PREVIEW_HIDDEN_MAX = 99999; // the `N lines hidden` count Claude prints (five digits)
const PREVIEW_OPTIONS_MAX = 7; // options of a step with a preview (a digit never answers there, so 7 is a limit of the design, not of Claude's numbering)
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
const UPDOWN = '\u2191/\u2193'; // the navigation hint of a one-question form, and of a question step with a preview
const BAR = '\u2502 '; // Claude draws it, dim, in front of every row of a wide or multi-line question (spike S-F13, 2.1.325); nika leaves it out
// The review step draws the same bar in front of its question rows and their wrapped rest (` \u2502 \u25cf question`, ` \u2502   rest`; LC17 K1b, 2.1.326), never in
// front of an answer row. It is the unbarred row with `\u2502 ` put in after the indent, so taking it out gives the unbarred row back.
const BAR_ROW = /^( {0,2})\u2502 (.*)$/;

// A question step with a preview (Claude Code 2.1.328; design-053-qp section 3): a box beside the options, a Notes row, a rule and an unnumbered Chat row.
const BOX_TOP = /\u250c\u2500+\u2510$/;
const BOX_BOTTOM = /^\u2514\u2500+\u2518$/;
const BOX_DIVIDER = /^\u251c\u2500+ \u2702 \u2500+ (\d{1,5}) lines? hidden \u2500*\u2524$/; // 1 row, or 2 rows joined with a space (Claude wraps it at the pane width)
const PV_CHAT_ROW = /^(\u276f| ) Chat about this$/; // unnumbered; the pointer in the first column when focused
const PV_FALLBACK = "(can't show the full preview \u00b7 compare the labels and descriptions instead)";
const PV_NOTES_HINT = 'press n to add notes'; // Claude's hint on the Notes row: no note
const PV_NOTES_PLACEHOLDER = 'Add notes on this design\u2026'; // the empty notes field (editing)
const EDITOR_HINT = /\bctrl\+g to edit in /; // the footer's hint while Claude's own input has the focus (a text row, Chat, a Next button, the notes field)

const spaced = (text) => text.replace(/\u00a0/g, ' ').trimEnd();

/** The text of the cells [from, to) of a row (`to` may be Infinity), or null when a double-width character straddles a boundary. */
function cellSlice(t, from, to = Infinity) {
  let w = 0;
  let out = '';
  for (const ch of t) {
    const cw = width(ch);
    if (cw > 0 && ((w < from && w + cw > from) || (w < to && w + cw > to))) return null;
    if (w >= from && w < to) out += ch;
    w += cw;
  }
  return out;
}

/**
 * What kind of dialog the bottom of the screen shows, or null. `texts` are the rtrimmed rows, `nb` the indexes of the non-blank rows down to
 * the footer (a subagent list under it is cut by footerEnd), `foot` the indexes of the footer rows: one, or up to three when Claude wrapped
 * the footer at a narrow width (0.5.4, QP, O1: a question footer of 2 or 3 rows is found by askFooterRows, consecutive rows at column 0 under a blank row; the reader
 * proves the wrap with the pane width, see wrapProven). A question footer also gives `nav` (its navigation hint), `notes` and `sw` (it carries `n to add notes` and
 * `Tab to switch questions`: a step with a preview) and `footBad` (the hints disagree with each other: see below).
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
  const askShape = (foot, ask) => {
    const notes = ask[2] !== undefined;
    const sw = ask[3] !== undefined;
    // The hints are one set: `n to add notes` goes with the up/down navigation and with `Tab to switch questions` (a preview step that has several tabs), and not with
    // the vim INSERT prefix (never seen, so never read). A footer that disagrees with itself is `layout` (readAsk) or no strip (stripOf).
    const footBad = (notes && ask[1] !== UPDOWN) || notes !== sw || (notes && /^-- INSERT --/.test(T(foot[0])));
    return { ...base, kind: 'ask', foot, nav: ask[1], notes, sw, footBad };
  };
  const wrapped = askFooterRows(texts, last); // 1 to 3 consecutive rows at column 0 under a blank row; 0 when the last row ends no question footer
  if (wrapped > 0) {
    const foot = [];
    for (let x = last - wrapped + 1; x <= last; x += 1) foot.push(x);
    return askShape(foot, ASK_FOOTER.exec(foot.map(T).join(' ')));
  }
  for (let n = 1; n <= Math.min(3, nb.length); n += 1) {
    const foot = nb.slice(-n);
    const joined = foot.map(T).join(' ');
    const ask = n === 1 ? ASK_FOOTER.exec(joined) : null; // one row, as before (no blank row above or column 0 needed); two or three rows only through askFooterRows
    if (ask !== null) return askShape(foot, ask);
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

/** clean() with a cap. Empty or too long adds `layout`; a text that ends in an ellipsis adds `clipped` (Claude shortened it) when `ellipsis`. */
function take(bad, text, max, ellipsis = true) {
  const v = clean(text, max + 1);
  if (v === null || v.length > max) { bad.add('layout'); return ''; }
  if (ellipsis && v.endsWith(ELLIPSIS)) bad.add('clipped');
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

/**
 * The current question tab (everything between the strip and the footer). Returns the fields of S or null; reasons go to `bad`. The question's
 * rows either all start with Claude's bar (`BAR`, removed before reading) or none does (some: `layout`). A row as wide as the pane is exempt from
 * the `wide` rule when the row right below it continues the same question or the same option's description (it was wrapped there, not cut).
 */
function readQuestion(c) {
  const { texts, bad, s, stop, tabs, strip, cols } = c;
  const head = questionHead(c);
  if (head === null) return null;
  const { qx } = head;
  let x = head.x;
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
  for (const i of qx) if (qx.includes(i + 1)) exempt.add(i); // a question row with another question row right below it
  for (const it of items.slice(0, k)) for (const e of it.extra) if (it.extra.includes(e + 1)) exempt.add(e); // a description row with another row of the same description below it
  const question = take(bad, head.text, QUESTION_MAX);
  if (GLYPH.test(question)) bad.add('layout');
  return { question, multi, options, textRow, chat: chat.n, button, focus: marks.length === 1 ? marks[0] : null, exempt };
}

/**
 * The question's rows, from the strip down to the first option row (shared by a plain step and a step with a preview): `x` is that option row, `qx` the question's row
 * indexes and `text` its text without Claude's bar. null (reason `numbers`) when no option row follows.
 */
function questionHead(c) {
  const { texts, bad, s, stop } = c;
  let x = s + 1;
  const q = [];
  const qx = []; // the indexes of the question's rows
  while (x < stop && !ASK_OPTION.test(texts[x])) {
    if (texts[x].trim()) { q.push(texts[x].trim()); qx.push(x); }
    if (RULE_ROW.test(texts[x]) || STRIP_START.test(texts[x])) bad.add('layout'); // a rule or a strip inside the question could be taken for the real one
    x += 1;
  }
  if (x >= stop) { bad.add('numbers'); return null; }
  if (q.length === 0) bad.add('layout');
  const barred = qx.filter((i) => texts[i].startsWith(BAR)).length;
  if (barred > 0 && barred < qx.length) bad.add('layout');
  return { x, qx, text: (barred === qx.length && barred > 0 ? q.map((t) => t.slice(BAR.length)) : q).join(' ') };
}

/**
 * A question step with a preview (0.5.4, QP; design-053-qp section 3): options at column 0 with a bordered box beside them (its top border on option 1's row, at cell column X,
 * W wide), then a blank row, the `Notes:` row at X (wrapped rows at X + 7), a blank row, a rule row, the unnumbered `Chat about this` row, a blank row and the footer. Returns
 * { question, options, focus, preview { rows, hidden, fallback }, notes { text, editing }, exempt } or null; reasons go to `bad` (anything off the captured shape is `layout`).
 * `focus` is the option with the pointer (exactly one option has it, also while Chat has it: the live capture keeps it) or 'chat'. The box's rows are shown as drawn: the inner
 * text is the cells [X + 2, X + W - 2) with the end trimmed and the spaces before it kept; the divider (`N lines hidden`) is read, never shown.
 */
function readPreview(c, shape) {
  const { texts, bad, stop, cols } = c;
  const fail = () => { bad.add('layout'); return null; };
  const head = questionHead(c);
  if (head === null) return null;
  const r1 = head.x;
  const top = BOX_TOP.exec(texts[r1]);
  if (top === null) return fail();
  const X = width(texts[r1].slice(0, top.index));
  const W = width(top[0]);
  if (X + W > cols) return fail(); // the box is wider than the pane
  // The box: the run of rows, from option 1's row, that have something at or after column X. The options are the left parts of the same rows (and of rows below the box).
  const run = [];
  let y = r1;
  for (; y < stop; y += 1) {
    const left = cellSlice(texts[y], 0, X);
    const right = cellSlice(texts[y], X);
    if (left === null || right === null) return fail();
    if (right.trim() === '') break;
    run.push({ y, left: left.trimEnd(), right: right.trimEnd() });
  }
  if (run.length < 3 || y >= stop || !BOX_BOTTOM.test(run.at(-1).right) || width(run.at(-1).right) !== W) return fail();
  const items = [];
  let j = 0;
  for (; j < run.length; j += 1) {
    const m = ASK_OPTION.exec(run[j].left);
    if (m === null) break;
    items.push({ focus: m[1] === '\u276f', n: Number(m[2]), body: m[3] });
  }
  if (run.slice(j).some((r) => r.left !== '')) bad.add('layout'); // a row beside the box that is no option: a description, a wrapped label
  let end = run.at(-1).y;
  if (j === run.length) { // the options may go on below the box
    for (y = end + 1; y < stop; y += 1) {
      const m = ASK_OPTION.exec(texts[y]);
      if (m === null) break;
      items.push({ focus: m[1] === '\u276f', n: Number(m[2]), body: m[3] });
      end = y;
    }
  }
  if (items.length < 2 || items.some((it, n) => it.n !== n + 1)) { bad.add('numbers'); return null; }
  if (items.length > PREVIEW_OPTIONS_MAX) return fail();
  const exempt = new Set(run.map((r) => r.y)); // a box row may reach the pane's edge (its right border is there)
  for (const i of head.qx) if (head.qx.includes(i + 1)) exempt.add(i);

  // The box's rows between its borders: the preview's lines, or its fallback line, and the divider directly above the bottom border.
  const mid = run.slice(1, -1);
  let divider = 0;
  let hidden = 0;
  const one = mid.length >= 1 && width(mid.at(-1).right) === W ? BOX_DIVIDER.exec(mid.at(-1).right) : null; // a one-row divider is as wide as the box, like every inner row (the two-row one is joined)
  const two = one === null && mid.length >= 2 ? BOX_DIVIDER.exec(`${mid.at(-2).right} ${mid.at(-1).right.trimStart()}`) : null;
  if (one !== null || two !== null) { divider = one !== null ? 1 : 2; hidden = Number((one ?? two)[1]); }
  if (hidden > PREVIEW_HIDDEN_MAX) return fail();
  const inner = [];
  for (const r of mid.slice(0, mid.length - divider)) {
    const text = cellSlice(texts[r.y], X + 2, X + W - 2);
    if (text === null || r.right[0] !== '\u2502' || r.right.at(-1) !== '\u2502' || width(r.right) !== W || cellSlice(texts[r.y], X + 1, X + 2) !== ' ' || cellSlice(texts[r.y], X + W - 2, X + W - 1) !== ' ') return fail();
    const v = cleanBlock(text, PREVIEW_LINE_MAX + 1) ?? '';
    if (v.length > PREVIEW_LINE_MAX) return fail();
    inner.push(v);
  }
  const fallback = inner.map((t) => t.trim()).join(' ') === PV_FALLBACK; // one row, or the same line wrapped inside a narrow box
  if (divider > 0 && (inner.length === 0 || fallback)) return fail();
  if (inner.length > PREVIEW_ROWS_MAX) return fail();

  // Under the box: a blank row, the Notes row and its wrapped rows, a blank row, a rule, the Chat row, a blank row, and the footer (the row at `stop`).
  y = end + 1;
  if (y >= stop || texts[y].trim() !== '' || !texts[y + 1]?.startsWith(`${' '.repeat(X)}Notes:`)) return fail();
  const noteRows = [y + 1];
  for (y += 2; y < stop && texts[y].trim() !== ''; y += 1) noteRows.push(y);
  if (noteRows.slice(1).some((r) => !indented(texts[r], X + 7))) return fail();
  for (const r of noteRows.slice(0, -1)) exempt.add(r); // a Notes row with another below it was wrapped there, not cut
  if (y !== stop - 4 || !RULE_ROW.test(texts[y + 1]) || texts[stop - 1].trim() !== '') return fail(); // blank, rule, Chat, blank, then the footer
  const chatRow = PV_CHAT_ROW.exec(texts[y + 2]);
  if (chatRow === null) return fail();
  const rest = [texts[noteRows[0]].slice(X + 'Notes:'.length), ...noteRows.slice(1).map((r) => texts[r])].map((t) => t.trim()).join(' ').trim();
  const editing = EDITOR_HINT.test(shape.foot.map((x) => texts[x].trim()).join(' '));
  let noteText = null;
  if (rest === PV_NOTES_HINT) { if (editing) return fail(); } // the hint is the closed field
  else if (rest === PV_NOTES_PLACEHOLDER) { if (!editing) return fail(); noteText = ''; } // the placeholder is the open, empty field
  else noteText = take(bad, rest, TEXT_MAX, false);

  const options = items.map((it) => {
    if (CHECKBOX.test(it.body)) { bad.add('layout'); return { n: it.n, label: '', description: null, ticked: false }; }
    const { text, ticked } = labelOf(it.body, false);
    const label = take(bad, text, LABEL_MAX);
    if (GLYPH.test(label)) bad.add('layout');
    return { n: it.n, label, description: null, ticked };
  });
  const labels = options.map((o) => o.label);
  if (new Set(labels).size !== labels.length || labels.some((l) => PLACEHOLDERS.includes(l))) bad.add('layout');
  const marked = items.filter((it) => it.focus).map((it) => it.n);
  if (marked.length !== 1) bad.add('layout');
  const question = take(bad, head.text, QUESTION_MAX);
  if (GLYPH.test(question)) bad.add('layout');
  return {
    question, options, focus: chatRow[1] === '\u276f' ? 'chat' : marked.length === 1 ? marked[0] : null, exempt,
    preview: { rows: fallback ? [] : inner, hidden, fallback }, notes: { text: noteText, editing },
  };
}

/**
 * The review step: `Review your answers`, the optional warning, the answered pairs, the optional `Ready to submit your answers?` row (2.1.326 only) and the two options. A pair's question rows (the
 * `\u25cf` row and its wrapped rest) either all start with Claude's bar or none does (some: `layout`, like the question step); different questions of the
 * step may differ (Claude bars a wide or multi-line question and not a short one; spike S-T326 item 9). The bar is removed before reading, so the same text
 * has the same sig with or without it. An answer row never carries it: a barred answer row is a `layout`, and so is a barred
 * option row below (it is not matched as one). Like the question step, it returns `exempt`: the question rows that are wrapped, not cut, when they reach the pane width.
 */
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
  // The pairs end at the Ready row (2.1.326: the two options follow it), or, with no Ready row (2.1.328), at the first row that is the `1.` option at
  // column 0. The raw row is tested, not the trimmed one: a pair's rest row starts with 3 or more spaces, so an answer that reads `1. Submit answers`
  // stays an answer. Either way the two options are then checked as before.
  let from = -1; // the row the option rows start at
  for (; x <= last; x += 1) {
    if (texts[x].trim() === 'Ready to submit your answers?') { from = x + 1; break; }
    if (REVIEW_OPTION.exec(texts[x])?.[2] === '1') { from = x; break; }
    if (!texts[x].trim()) continue;
    const bm = BAR_ROW.exec(texts[x]);
    const t = bm === null ? texts[x] : bm[1] + bm[2]; // the row as it reads without the bar
    const q = PAIR_Q.exec(t);
    const a = raw.length > 0 && part === 'q' ? PAIR_A.exec(t) : null;
    if (q !== null) { raw.push({ q: [q[1]], a: [], bars: [bm !== null], qx: [x] }); part = 'q'; }
    else if (a !== null) { raw.at(-1).a.push(a[1]); part = 'a'; if (bm !== null) bad.add('layout'); }
    else if (raw.length > 0 && /^ {3,}[^\s\u25cf\u2192]/.test(t)) { // the rest of a wrapped question or answer
      raw.at(-1)[part].push(t.trim());
      if (part === 'q') { raw.at(-1).bars.push(bm !== null); raw.at(-1).qx.push(x); }
      else if (bm !== null) bad.add('layout');
    } else bad.add('layout');
  }
  if (raw.some((p) => p.bars.some(Boolean) && !p.bars.every(Boolean))) bad.add('layout'); // within one question: every row barred or none
  if (from < 0) { bad.add('layout'); return null; }
  const choices = [];
  for (x = from; x <= last; x += 1) if (texts[x].trim()) choices.push(texts[x]);
  const ms = choices.map((t) => REVIEW_OPTION.exec(t));
  if (choices.length !== 2 || ms.some((m) => m === null) || ms[0][2] !== '1' || ms[0][3] !== 'Submit answers' || ms[1][2] !== '2' || ms[1][3] !== 'Cancel') {
    bad.add('layout');
    return null;
  }
  if (raw.length > TABS_MAX || raw.some((p) => p.a.length === 0)) bad.add('layout');
  const pairs = raw.map((p) => ({ question: take(bad, p.q.join(' '), QUESTION_MAX), answer: take(bad, p.a.join(' '), ANSWER_MAX) }));
  const marks = ms.flatMap((m) => (m[1] === '\u276f' ? [Number(m[2])] : []));
  if (marks.length > 1) bad.add('layout');
  // A question row as wide as the pane is a wrap, not a cut, when a rest row of the same question (same bar state) is directly below it (LC19 F2:
  // Claude wraps a long question at the pane width, so its rows reach it). The question's last row, an answer row and every other row stay subject to `wide`.
  const exempt = new Set();
  for (const p of raw) for (let j = 0; j + 1 < p.qx.length; j += 1) if (p.qx[j + 1] === p.qx[j] + 1 && p.bars[j] === p.bars[j + 1]) exempt.add(p.qx[j]);
  return { warn, pairs, focus: marks.length === 1 ? marks[0] : null, exempt };
}

/**
 * Whether a footer of more than one row is a footer Claude wrapped and not one split by hand (0.5.4, QP, O1; footerEnd has no pane width, so the reader proves it). Claude breaks a row at
 * the pane width, so each row but the last was too full to take the next row's first word: row + one space + that word is wider than cols - 1 (the same bound the option rows use).
 */
function wrapProven(texts, foot, cols) {
  if (!Number.isInteger(cols)) return false;
  for (let i = 0; i + 1 < foot.length; i += 1) {
    const word = texts[foot[i + 1]].trim().split(' ')[0];
    if (width(texts[foot[i]]) + 1 + width(word) <= cols - 1) return false;
  }
  return true;
}

/** A question step or the review step. `bad` collects reasons; S is only used when it stays empty. */
function readAsk(shape, rows, cols) {
  const { texts, foot } = shape;
  const review = shape.kind === 'review';
  const bad = new Set();
  const stop = foot[0];
  const last = foot.at(-1);
  if (!Number.isInteger(cols) || cols < MIN_COLS) bad.add('wide');
  else if (foot.length > 1 && !wrapProven(texts, foot, cols)) bad.add('layout'); // two or three rows that Claude did not wrap (0.5.4, QP: a wrapped footer is read; orchestrator ruling 1 is gone)
  if (shape.footBad) bad.add('layout');
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
    if (body !== null) S = { kind: 'ask', at: 'review', tabs, warn: body.warn, pairs: body.pairs, focus: body.focus, insert: false, bypass, top: s - 1 };
  } else {
    if (marked.length !== 1 || strip.submit?.marked === true) bad.add('tab');
    const preview = shape.notes === true; // the footer carries `n to add notes` (and the hints agree, or footBad is set)
    body = preview ? readPreview(ctx, shape) : readQuestion(ctx);
    if (body !== null) {
      const several = tabs.length > 1;
      if (preview) { if (!several || strip.submit === null) bad.add('layout'); } // a step with a preview has the strip with its Submit token
      else if (shape.nav === '\u2191/\u2193' ? several : !several && strip.submit === null) bad.add('layout'); // the footer agrees with the strip
      S = {
        kind: 'ask', at: 'question', tabs, i: marked.length === 1 ? marked[0] : 0, single: !several, question: body.question, multi: body.multi ?? false,
        options: body.options, textRow: body.textRow ?? null, chat: body.chat ?? null, button: body.button ?? null, focus: body.focus, insert, bypass, top: s - 1,
        ...(preview ? { preview: body.preview, notes: body.notes } : {}),
      };
    }
  }
  if (body !== null && foot.length > 1) for (const x of foot) body.exempt.add(x); // the rows of a wrapped footer reach the pane width legitimately (wrapProven)
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
  const top = to + 1 + texts.slice(to + 1, p).findIndex((t) => t.trim()); // 0.5.1 E: the screen row of that plain rule (used only when the step is read, i.e. when it is the single row)
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
    kind: 'plan', at: 'plan', options, textRow, planRows: prose, focus: marks.length === 1 ? marks[0] : null, top,
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
 *   `top` (0.5.1, E; display only, in no identity or sig): the screen row a crop of the terminal view starts at. Question and review: the rule row
 *   directly above the tab strip. Plan: the single plain rule row under the plan's closing dashed rule (the plan text stays above it).
 * Strings are clean()ed and bounded. A dialog is unreadable when it is cut off at the top (`cut`), has a text Claude shortened with an
 * ellipsis (`clipped`), may be cut at the pane's edge or is wrapped in a way
 * that cannot be told from a description (`wide`), is numbered above 9 or with gaps (`numbers`), has no single current tab (`tab`), or
 * is any other shape (`layout`); a feedback survey on screen is `survey`. A question footer wrapped over two or three rows is read when each row but the last is full (wrapProven), else `layout`.
 */
export function readDialogScreen(rows, cols) {
  const shape = shapeOf(rows);
  if (shape === null) return null;
  if (shape.kind === 'nudge' || shape.kind === 'exit') return { unreadable: 'layout', kind: null };
  const plan = shape.kind === 'plan';
  const { bad, S } = plan ? readPlan(shape, rows, cols) : readAsk(shape, rows, cols);
  if (surveyOrFollowUpShown(rows)) bad.add('survey'); // also Claude's post-rating row (M1): a digit typed for an option could reach its `1`
  const reason = REASONS.find((r) => bad.has(r));
  return reason === undefined && S !== null ? S : { unreadable: reason ?? 'layout', kind: plan ? 'plan' : 'ask' };
}

/**
 * True when a question step with a preview shows Claude's notes field open (0.5.4, QP): the footer carries `n to add notes` and `ctrl+g to edit in`. It reads the footer only, so it
 * holds for a step nika cannot read whole too: End and the dialog routes refuse (409 notes-open) before any key, since an Escape there would land in the field.
 */
export function notesOpen(rows) {
  const shape = shapeOf(rows);
  return shape !== null && shape.kind === 'ask' && shape.notes === true && EDITOR_HINT.test(shape.foot.map((x) => shape.texts[x].trim()).join(' '));
}

/**
 * The strip of tabs and where Claude's question dialog stands in it (0.5.1, D): null, or `{ at, n, headers, answered, input, insert, bypass }`.
 * It reads the strip row and the footer only, never the options, so a step whose options are clipped, wide or cut still gives its strip
 * (moving between steps needs the place, not the content). `at` is the current step: the marked question tab's index, or `n` (the number of
 * questions) on the Review step; `headers` and `answered` are the strip's tokens; `input` is true while the focus is on an input row of the
 * step (its text row, `Chat about this`, a multi question's Next button): Claude adds `ctrl+g to edit in <editor>` to the footer there, and
 * Right and Left do nothing on those rows; `insert` is true when the footer starts with the vim INSERT marker; `bypass` is the dialog's
 * bypass mention (same rule as readDialogScreen).
 * Null for: no dialog, a plan, a permission prompt, a nudge or exit shape, a footer wrapped where Claude would not have wrapped it or that disagrees with itself, a pane narrower than MIN_COLS, no strip row, a
 * strip that does not parse, fewer than two steps (a one-question form has no strip to move on), no single marked token (none, two, a half-marked
 * one, or a marked token that is not the Review's Submit on the review), a footer that disagrees with the strip, or a header that is empty, too
 * long or holds a checkbox glyph.
 */
export function stripOf(rows, cols) {
  const shape = shapeOf(rows);
  if (shape === null || (shape.kind !== 'ask' && shape.kind !== 'review')) return null;
  const { texts, foot } = shape;
  if (!Number.isInteger(cols) || cols < MIN_COLS || shape.footBad === true) return null;
  if (foot.length > 1 && !wrapProven(texts, foot, cols)) return null;
  const s = findStrip(texts, foot[0]);
  if (s < 0) return null;
  const strip = parseStrip(rows[s]);
  if (strip === null || strip.tabs.length < 2 || strip.tabs.length > TABS_MAX) return null;
  if (strip.tabs.some((t) => t.mixed) || strip.submit?.mixed) return null;
  const bad = new Set();
  const headers = strip.tabs.map((t) => take(bad, t.header, HEADER_MAX));
  if (bad.has('layout') || headers.some((h) => GLYPH.test(h))) return null;
  const marked = strip.tabs.flatMap((t, n) => (t.marked ? [n] : []));
  const n = strip.tabs.length;
  let at;
  if (shape.kind === 'review') {
    if (marked.length > 0 || strip.submit === null || !strip.submit.marked) return null;
    at = n;
  } else {
    if (marked.length !== 1 || strip.submit?.marked === true || (shape.nav === '\u2191/\u2193' && !shape.sw)) return null; // up/down arrows in the footer and no tab hint: a one-question form
    at = marked[0];
  }
  const footer = foot.map((x) => texts[x].trim()).join(' ');
  const bypass = mentionsBypass(texts.slice(s, foot.at(-1) + 1).join(' ')) || bypassWindow(rows);
  // A step with a preview (the footer has `n to add notes`): `ctrl+g to edit in` there means the notes field is open (`editing`), not a text row, and Right and Left
  // still switch tabs on the option rows. So `input` is false and the two extra keys say what the strip can: `notes` true, `editing` (0.5.4, QP; plain steps keep the old keys).
  const preview = shape.kind === 'ask' && shape.notes === true;
  const editor = EDITOR_HINT.test(footer);
  return {
    at, n, headers, answered: strip.tabs.map((t) => t.answered),
    input: preview ? false : editor, insert: /^-- INSERT --/.test(footer), bypass,
    ...(preview ? { notes: true, editing: editor } : {}),
  };
}

/**
 * The step's identity as canonical JSON: the parsed content a key of one request must not change (design W1 2.4). It holds the strip's
 * headers, the current tab, the question and the options' labels and descriptions; or every review pair; or the visible plan rows and the
 * options (label and whether it is the text option). Focus, ticks, the answered marks and the typed text are not in it (they change during a request).
 */
export function identityOf(S) {
  const id = S.at === 'question'
    ? ['question', S.tabs.map((t) => t.header), S.i, S.question, S.multi, S.options.map((o) => [o.label, o.description]), ...(S.preview === undefined ? [] : [{ preview: true }])]
    : S.at === 'review'
      ? ['review', S.tabs.map((t) => t.header), S.warn, S.pairs.map((p) => [p.question, p.answer])]
      : ['plan', S.planRows, S.options.map((o) => [o.label, o.text])];
  return JSON.stringify([S.kind, id]);
}

/** 16 hex characters of sha256 over identityOf(S). */
export const sigOf = (S) => createHash('sha256').update(identityOf(S)).digest('hex').slice(0, 16);

/**
 * The `view` of a step with a preview (0.5.4, QP): 16 hex characters over the sig and everything the form shows next to the options that an answer must not outrun: the focus, the preview's
 * rows, its hidden count and fallback flag, and the note's text (`note` replaces the step's own, so the route can compute the view of the step as it will stand once its note is typed).
 * It is the content of the box and of the Notes row only, never an SGR code or a row's position.
 */
export const viewOf = (S, note = S.notes.text) => createHash('sha256')
  .update(JSON.stringify([sigOf(S), S.focus, S.preview.rows, S.preview.hidden, S.preview.fallback, note])).digest('hex').slice(0, 16);

/** Whether free text may be typed in this question: always in a single-select one, in a multi one only on the last tab (MULTI_OTHER). */
export const otherAllowed = (S) => S.at === 'question' && S.preview === undefined && (!S.multi || (MULTI_OTHER && S.i === S.tabs.length - 1)); // a step with a preview has no text row

/**
 * The capture's `dialog` field (design W1 3): null, `{ state: 'unreadable', kind, reason }` or `{ state: 'ready', kind, at, sig, bypass, ... }`.
 * null when no dialog is on screen or a permission prompt parses. The multi checkboxes carry Claude's `checked` marks.
 */
export function dialogCapture(rows, cols) {
  if (promptFromRows(rows) !== null) return null;
  const S = readDialogScreen(rows, cols);
  if (S === null) return null;
  if (S.unreadable !== undefined) return { state: 'unreadable', kind: S.kind, reason: S.unreadable };
  const head = { state: 'ready', kind: S.kind, at: S.at, sig: sigOf(S), bypass: S.bypass, top: S.top };
  if (S.at === 'review') return { ...head, tabs: S.tabs, warn: S.warn, pairs: S.pairs };
  if (S.at === 'plan') return { ...head, options: S.options };
  return {
    ...head, tabs: S.tabs, current: S.i, final: S.single && !S.multi, question: S.question, multi: S.multi, other: otherAllowed(S),
    ...(S.preview === undefined ? {} : { focus: S.focus, preview: { ...S.preview, rows: [...S.preview.rows], view: viewOf(S) }, notes: { ...S.notes } }),
    // `checked` is Claude's tick on every option (multi: its checkbox; single: the answered tick after the label) and `typed` the text in Claude's own text
    // row (null when it is empty): both are display only and neither is in identityOf, so the sig does not move when they change (0.5.1, D).
    options: S.options.map((o) => ({ n: o.n, label: o.label, description: o.description, checked: S.multi ? o.checked : o.ticked === true })),
    typed: S.textRow === null || S.textRow.value === null ? null : { text: S.textRow.value.slice(0, ANSWER_MAX), answered: S.multi ? S.textRow.checked === true : S.textRow.ticked === true },
  };
}
