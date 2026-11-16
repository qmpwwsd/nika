// Synthetic fixtures only: never copy real transcripts, session files or prompts here (rules/project-rules.md §7).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cellWidth } from '../public/mirror-render.js';

export const SID = {
  busy: '11111111-1111-4111-8111-111111111111',
  idle: '22222222-2222-4222-8222-222222222222',
  dead: '33333333-3333-4333-8333-333333333333',
  reused: '44444444-4444-4444-8444-444444444444',
  ended: '55555555-5555-4555-8555-555555555555',
  old: '66666666-6666-4666-8666-666666666666',
  other: '77777777-7777-4777-8777-777777777777',
};

export const NOW = Date.UTC(2026, 10, 7, 20, 0, 0); // 2026-11-07T20:00:00Z
const MIN = 60_000;
const DAY = 86_400_000;
export const PROC_START = 'Sat Nov  7 18:57:14 2026';

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function setMtime(file, ms) {
  const t = new Date(ms);
  fs.utimesSync(file, t, t);
}

export function jsonl(lines) {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
}

function transcriptLines({ sid, cwd, branch, model, title, prompt, startIso, endIso, bridge }) {
  return [
    { type: 'permission-mode', permissionMode: 'auto', sessionId: sid },
    { type: 'user', cwd, sessionId: sid, gitBranch: branch, version: '2.1.319', timestamp: startIso, message: { role: 'user', content: 'synthetic prompt' } },
    { type: 'assistant', cwd, sessionId: sid, gitBranch: branch, timestamp: endIso, message: { role: 'assistant', model, content: [] } },
    { type: 'ai-title', aiTitle: title, sessionId: sid },
    { type: 'last-prompt', lastPrompt: prompt, sessionId: sid },
    ...(bridge ? [{ type: 'bridge-session', sessionId: sid, bridgeSessionId: bridge, lastSequenceNum: 0 }] : []),
  ];
}

/**
 * Builds a fake machine under a temp dir:
 *   root/repo            git repo (main checkout)          → project "repo"
 *   root/repo-wt         linked worktree of repo           → project "repo", worktree "repo-wt"
 *   root/plain           not a git repo                    → project "plain"
 *   root/claude          fake CLAUDE_CONFIG_DIR
 *   root/tmp             fake NIKA_TMP_ROOT with spawn reports
 */
export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nika-test-'));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'repo-wt');
  const plain = path.join(root, 'plain');
  const claudeDir = path.join(root, 'claude');
  const tmpRoot = path.join(root, 'tmp');

  // git layout without running git
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'repo-wt'), { recursive: true });
  write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(repo, '.git', 'worktrees', 'repo-wt', 'commondir'), '../..\n');
  write(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'repo-wt')}\n`);
  fs.mkdirSync(path.join(wt, 'packages', 'app'), { recursive: true });
  fs.mkdirSync(plain, { recursive: true });

  // live registry
  const sessions = path.join(claudeDir, 'sessions');
  const reg = (pid, o) => write(path.join(sessions, `${pid}.json`), JSON.stringify({
    pid, kind: 'interactive', version: '2.1.319', procStart: PROC_START, startedAt: NOW - 60 * MIN, updatedAt: NOW - MIN, nameSource: 'derived', ...o,
  }));
  reg(101, { sessionId: SID.busy, cwd: wt, name: 'repo-wt-8a', status: 'busy', tmux: 'work:@1.%5', bridgeSessionId: 'session_01AbCdEf' });
  reg(102, { sessionId: SID.idle, cwd: repo, name: 'planner', nameSource: 'user', status: 'idle', tmux: 'work:@2.%6' });
  reg(103, { sessionId: SID.dead, cwd: repo, name: 'gone', status: 'idle' });
  reg(104, { sessionId: SID.reused, cwd: repo, name: 'reused', status: 'busy', procStart: 'Mon Oct  5 10:00:00 2026' });
  write(path.join(sessions, '105.json'), '{not json');
  write(path.join(sessions, '101.deadbeef.key'), 'SECRET-KEY-MATERIAL');

  // transcripts
  const slug = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
  const t = (cwd, sid, o, mtime) => {
    const file = path.join(claudeDir, 'projects', slug(cwd), `${sid}.jsonl`);
    write(file, jsonl(transcriptLines({ sid, cwd, ...o })));
    setMtime(file, mtime);
    return file;
  };
  t(wt, SID.busy, { branch: 'feat/x', model: 'claude-sonnet-5-5', title: 'Build story X', prompt: 'approved', startIso: new Date(NOW - 60 * MIN).toISOString(), endIso: new Date(NOW - MIN).toISOString(), bridge: 'cse_01AbCdEf' }, NOW - MIN);
  t(repo, SID.idle, { branch: 'main', model: 'claude-opus-5-5', title: 'Plan sprint', prompt: 'next', startIso: new Date(NOW - 120 * MIN).toISOString(), endIso: new Date(NOW - 5 * MIN).toISOString() }, NOW - 5 * MIN);
  t(repo, SID.dead, { branch: 'main', model: 'claude-haiku-4-5-20251001', title: 'Scout files', prompt: 'go', startIso: new Date(NOW - DAY).toISOString(), endIso: new Date(NOW - DAY + 10 * MIN).toISOString() }, NOW - DAY + 10 * MIN);
  t(repo, SID.ended, { branch: 'fix/y', model: 'claude-sonnet-5-5', title: 'Review diff', prompt: 'x'.repeat(500), startIso: new Date(NOW - 2 * DAY).toISOString(), endIso: new Date(NOW - 2 * DAY + MIN).toISOString(), bridge: 'cse_01Zz' }, NOW - 2 * DAY + MIN);
  t(repo, SID.old, { branch: 'main', model: 'claude-sonnet-5-5', title: 'Ancient', prompt: 'old', startIso: new Date(NOW - 20 * DAY).toISOString(), endIso: new Date(NOW - 20 * DAY).toISOString() }, NOW - 20 * DAY);
  t(plain, SID.other, { branch: undefined, model: 'claude-sonnet-5-5', title: 'Plain dir work', prompt: 'hi', startIso: new Date(NOW - 3 * DAY).toISOString(), endIso: new Date(NOW - 3 * DAY).toISOString() }, NOW - 3 * DAY);

  // subagents of the busy session
  const subDir = path.join(claudeDir, 'projects', slug(wt), SID.busy, 'subagents');
  write(path.join(subDir, 'agent-aaa111.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find callers', model: 'haiku', finished: true }));
  write(path.join(subDir, 'agent-aaa111.jsonl'), jsonl([{ type: 'user', isSidechain: true }]));
  setMtime(path.join(subDir, 'agent-aaa111.jsonl'), NOW - 30 * MIN);
  write(path.join(subDir, 'agent-bbb222.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Write tests', model: 'sonnet', finished: false }));
  write(path.join(subDir, 'agent-bbb222.jsonl'), jsonl([{ type: 'user', isSidechain: true }]));
  setMtime(path.join(subDir, 'agent-bbb222.jsonl'), NOW - 2 * MIN);
  write(path.join(subDir, 'agent-ccc333.meta.json'), '{broken');

  // spawn reports (spawn.sh layout: <tmpRoot>/<project-slug>/<session>/scratchpad/reports)
  const reports = path.join(tmpRoot, '-fake-project', 'aaaa-bbbb', 'scratchpad', 'reports');
  write(path.join(reports, 'build-7-1.session'), `${SID.busy}\n`);
  write(path.join(reports, 'build-7-1.md'), 'STATUS: RUNNING 7.1 build\n\n## Summary\n- synthetic\n');
  write(path.join(reports, 'review-old.session'), `${SID.ended}\n`);
  write(path.join(reports, 'review-old.md'), '## Summary\nno status line\n');
  write(path.join(reports, 'review-old.rc'), '0\n');
  write(path.join(reports, 'bad.session'), 'not-a-uuid\n');
  write(path.join(reports, '.last-pane'), '%5\n');

  return { root, repo, wt, plain, claudeDir, tmpRoot, reportsDir: reports, config: { claudeDir, tmpRoot, reportDirs: [], port: 0 } };
}

export function cleanup(fx) {
  fs.rmSync(fx.root, { recursive: true, force: true });
}

/** Fake execFile: answers ps and tmux like the real tools would; records every call. */
export function fakeExec({ psLines, tmuxLines, tmuxError } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith('ps')) {
      const lines = psLines ?? [`  101 ${PROC_START}`, `  102 ${PROC_START}`, `  104 ${PROC_START}`];
      return { stdout: lines.join('\n') + '\n', stderr: '' };
    }
    if (cmd === 'tmux') {
      if (tmuxError) {
        const e = new Error(tmuxError);
        e.code = tmuxError === 'ENOENT' ? 'ENOENT' : 1;
        throw e;
      }
      if (args.includes('list-panes')) {
        const lines = tmuxLines ?? [
          '%5\twork\t1\t[%5] build-7-1\tzsh',
          '%6\twork\t2\tMacBook.local\tclaude',
          '%7\twork\t3\t[%7] lazygit pane\tlazygit',
        ];
        return { stdout: lines.join('\n') + '\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
    throw Object.assign(new Error(`unexpected command ${cmd}`), { code: 'ENOENT' });
  };
  exec.calls = calls;
  return exec;
}

// ---- Claude's input box (src/draft.js tests; W5) -------------------------------------------------------------------
// Synthetic screens only: acme-api / web-shop text, never a real capture. Symbols are escapes.
const BOX_STYLE = { b: false, fg: null, bg: null, u: false, i: false, d: false };
const NBSP = '\u00a0';

/** One span as the mirror delivers it; `s` overrides the plain style (e.g. { d: true }, { fg: 246 }, { r: true }). */
export const span = (t, s = {}) => ({ t, s: { ...BOX_STYLE, ...s } });

// Terminal cells of a string, by public/mirror-render.js (an independent copy of the rule draft.js uses): the oracle for the cursor.
const cells = (text) => [...text].reduce((n, ch) => n + cellWidth(ch.codePointAt(0)), 0);

/**
 * A screen around Claude's input box, in the shape the mirror delivers it: [hint row], top rule, the box rows, bottom rule,
 * a status-line row, the mode line. Returns { rows, cursor, cols } (feed `parseDraft(s.rows, s.cursor, s.cols)`).
 *   cols    pane width (rule width); default 120
 *   lines   the VISUAL rows of the box, as Claude draws them: a string or a span list per row. Row 0 gets the prompt glyph
 *           and a no-break space, the others two spaces. An empty string is an empty (or blank) row
 *   mode    'prompt' (glyph U+276F, rules fg 244) or 'bash' (glyph '!', rules fg 211, mode line `! for shell mode`)
 *   insert  put `-- INSERT --` (fg 246) at the start of the mode line (vim INSERT)
 *   label   a label drawn into the top rule: `--- <label> ---` (a session name, or `History 3/3`)
 *   ghost   dim text appended to the last box row (the placeholder or a prompt suggestion)
 *   hint    a transient hint row ABOVE the top rule (e.g. `Esc again to clear`)
 *   footer  replaces the mode line text after the optional `-- INSERT --`
 *   cursor  undefined: the cursor sits right after the last row's real text (spans that are not dim and not fg 246);
 *           null: no cursor; { x, y, dx }: absolute column / row, and dx an offset from the default column
 *   pad     true: pad EVERY row with plain spaces to `cols`, as Claude draws its screen (seen live on 2.1.325). Default false
 */
export function boxRows({ cols = 120, lines = [''], mode = 'prompt', insert = false, label = null, cursor, ghost = null, hint = null, footer, pad = false } = {}) {
  const bash = mode === 'bash';
  const dashes = (n) => '\u2500'.repeat(n);
  const rule = (text) => [span(text, { fg: bash ? 211 : 244 })];
  const top = label === null
    ? rule(dashes(cols))
    : [span(dashes(3), { fg: bash ? 211 : 244 }), span(` ${label} `, { d: true }), span(dashes(Math.max(2, cols - label.length - 5)), { fg: bash ? 211 : 244 })];
  const items = lines.map((l) => (typeof l === 'string' ? (l ? [span(l)] : []) : l));
  if (ghost !== null) items[items.length - 1] = [...items.at(-1), span(ghost, { d: true })];
  const glyph = bash ? '!' : '\u276f';
  const box = items.map((spans, i) => [span(i === 0 ? glyph + NBSP : '  '), ...spans]);
  const above = hint === null ? [] : [[span(`  ${hint}`, { fg: 246 })]];
  const text = footer ?? (bash ? '! for shell mode' : '\u23f5\u23f5 auto mode on (shift+tab to cycle)');
  const modeLine = [span('  '), ...(insert ? [span('-- INSERT --', { fg: 246 }), span(' ')] : []), span(text, { fg: bash ? 211 : 220 })];
  const padded = (row) => { const n = cols - cells(row.map((sp) => sp.t).join('')); return pad && n > 0 ? [...row, span(' '.repeat(n))] : row; };
  const rows = [...above, top, ...box, rule(dashes(cols)), [span('  acme-api  master')], modeLine].map(padded);
  const real = items.at(-1).filter((sp) => !sp.s.d && sp.s.fg !== 246).map((sp) => sp.t).join('');
  const where = cursor === null ? null : {
    x: cursor?.x ?? 2 + cells(real) + (cursor?.dx ?? 0),
    y: cursor?.y ?? above.length + box.length, // the last box row: top rule at above.length, box rows follow
    visible: true,
  };
  return { rows, cursor: where, cols };
}

// ---- Claude's subagent list below the footer (F2; live capture, Claude Code 2.1.325, 60 and 120 columns) ---------------
/**
 * The rows Claude draws BELOW the footer while background subagents run, to append to a screen: a blank row, `  ⏺ main` (bold),
 * one row per agent `  ◯ <type>  <label>   <elapsed>[ · <arrow> <n> tokens]` (fg 246, the elapsed and tokens right-aligned to
 * `cols`), and `  ↓ N more` when more than five run. Synthetic labels only.
 *   agents  a number (n generic agents) or [{ type = 'Explore', label, elapsed = '5s', tokens = '↓ 23.4k' (null: none) }]
 *   more    N: add the overflow row
 *   blank   false drops the blank row above `main`; main false drops the `main` row (the (-) shapes)
 *   pointer 'main' or a 0-based agent index: Claude's hover pointer (spike D1-S), `❯ ` in place of the two leading spaces of that row
 */
export function subagentRows({ cols = 120, agents = 1, more = 0, blank = true, main = true, pointer = null } = {}) {
  const list = typeof agents === 'number' ? Array.from({ length: agents }, (_, i) => ({ label: `Agent ${i + 1}` })) : agents;
  if (pointer !== null && pointer !== 'main' && !(Number.isInteger(pointer) && pointer >= 0 && pointer < list.length)) throw new RangeError(`subagentRows: no row for pointer ${pointer}`);
  const lead = (which) => (pointer === which ? '❯ ' : '  ');
  const rows = list.map(({ type = 'Explore', label, elapsed = '5s', tokens = '↓ 23.4k' }, i) => {
    const head = `${lead(i)}◯ ${type}  ${label}`;
    const tail = tokens === null ? elapsed : `${elapsed} · ${tokens} tokens`;
    return [span(head, { fg: 246 }), span(' '.repeat(Math.max(1, cols - cells(head) - cells(tail))), {}), span(tail, { fg: 246 })];
  });
  return [
    ...(blank ? [[]] : []),
    ...(main ? [[span(`${lead('main')}⏺ main`, { b: true })]] : []),
    ...rows,
    ...(more > 0 ? [[span(`  ↓ ${more} more`, { fg: 246 })]] : []),
  ];
}

// ---- Claude's task list under a dialog's last row (F13-A v2: the S-F13 shapes; made-up labels) --------------------------------
// Rows, after the dialog's last row: [blank rows], then ONE of: a rule row alone; the task block, which in a named session is a rule row at column
// 0 (labelled with the session name), one blank row and the block, and in an unnamed one just the block (at least one blank row above it).
// Block: `  <T> tasks (<D> done, <P> in progress, <O> open)` (the in-progress part only when P > 0; "1 tasks" is real), task rows
// `  <glyph> <label>` (◼ in progress, ✔ done, ◻ open) and, when tasks are hidden, `   … +<n> in progress, <n> pending, <n> completed` (only
// the parts above 0, in that order).
const TASK_LABELS = ['Draft the outline', 'Check the sample data', 'Write the summary', 'Review the notes', 'Tidy the folders', 'Plan the next step', 'Collect the figures'];
const TASK_GLYPH = { doing: '◼', done: '✔', open: '◻' };
const TASK_FG = { doing: 174, done: 114, open: 246 };

/**
 * The rows Claude draws below a dialog or a permission prompt while it keeps a task list, to append to a screen.
 *   cols         pane width (the rule row is cols wide)
 *   named        a session started with -n: a rule row labelled with the name comes first; false: no rule row, the block follows the blank rows
 *   rule         'labelled' | 'plain' | 'indented' (two spaces before the dashes) | 'none'; default by named
 *   label        the session name in the labelled rule
 *   blank        blank rows between the dialog's last row and the rule (named) or the header (unnamed; default 1); gap: blank rows between the rule and the header (default 1)
 *   doing, open, shownDone    rows ◼, ◻ and ✔ shown, in that order (order: a string of 'd', 'x', 'o' in drawing order, e.g. 'dxxo', replaces it)
 *   hiddenDoing, hiddenOpen, hiddenDone   the numbers in the overflow row (in progress, pending, completed); 0 for all: no overflow row
 *   hiddenText   replaces the text after '+' in the overflow row; claim: overrides of the header numbers { total, done, doing, open }
 *   head         replaces the whole header; labels: the task labels, in order
 * The header numbers are the truth computed from the rows and the overflow row unless claim overrides them.
 */
export function taskRows({ cols = 120, named = true, rule = null, label = 'demo-session', blank = null, gap = 1, doing = 1, open = 1, shownDone = 2, hiddenDoing = 0, hiddenOpen = 0, hiddenDone = 3, order = null, hiddenText = null, claim = {}, head = null, labels = TASK_LABELS } = {}) {
  const kinds = [...(order ?? ('d'.repeat(doing) + 'x'.repeat(shownDone) + 'o'.repeat(open)))].map((c) => ({ d: 'doing', x: 'done', o: 'open' })[c]);
  const count = (k) => kinds.filter((x) => x === k).length;
  const n = { done: count('done') + hiddenDone, doing: count('doing') + hiddenDoing, open: count('open') + hiddenOpen };
  Object.assign(n, { total: n.done + n.doing + n.open, ...claim });
  const bold = (v) => span(String(v), { b: true });
  const kind = rule ?? (named ? 'labelled' : 'none');
  const ruleRow = kind === 'none' ? [] : [[span(kind === 'plain' ? '─'.repeat(cols)
    : kind === 'indented' ? `  ${'─'.repeat(cols - 2)}`
      : `${'─'.repeat(Math.max(2, cols - label.length - 3))} ${label} ─`, { fg: 244 })]];
  const parts = [[hiddenDoing, 'in progress'], [hiddenOpen, 'pending'], [hiddenDone, 'completed']].filter(([v]) => v > 0).map(([v, w]) => `${v} ${w}`);
  const overflow = hiddenText ?? (parts.length > 0 ? parts.join(', ') : null);
  return [
    ...Array.from({ length: blank ?? (kind === 'none' ? 1 : 0) }, () => []),
    ...ruleRow,
    ...(kind === 'none' ? [] : Array.from({ length: gap }, () => [])),
    head !== null ? [span(head)] : [span('  '), bold(n.total), span(' tasks ('), bold(n.done), span(' done, '), ...(n.doing > 0 ? [bold(n.doing), span(' in progress, ')] : []), bold(n.open), span(' open)')],
    ...kinds.map((k, i) => [span(`  ${TASK_GLYPH[k]} `, { fg: TASK_FG[k] }), span(labels[i % labels.length], k === 'done' ? { fg: 246 } : { b: true })]),
    ...(overflow !== null ? [[span(`   … +${overflow}`, { fg: 246 })]] : []),
  ];
}

/**
 * A whole screen of `rows` rows as Claude draws it: `top` rows of older transcript, the dialog, then the block anchored to the bottom, so a
 * taller pane has more blank rows between the dialog's last row and the rule (spike S-F13: 0 at 36 to 45 rows, 10 to 11 at 60). opts go to taskRows.
 */
export function taskScreen(dialog, { rows = 45, top = 12, ...opts } = {}) {
  const transcript = Array.from({ length: top }, (_, i) => (i % 3 === 2 ? [] : [span(`⏺ older text ${i}`)]));
  const base = taskRows(opts);
  const lead = base.findIndex((r) => r.length > 0);
  const blanks = Math.max(0, rows - top - dialog.length - base.length);
  return [...transcript, ...dialog, ...taskRows({ ...opts, blank: lead + blanks })];
}

/** Capture text as `tmux capture-pane -p -e -N` writes it, from span rows: SGR codes for the style, every row padded with spaces to `cols`. */
export function ansiOf(rows, cols) {
  const sgr = (s = {}) => ['0', s.b ? '1' : null, s.d ? '2' : null, s.i ? '3' : null, s.u ? '4' : null, s.r ? '7' : null,
    s.fg == null ? null : `38;5;${s.fg}`, s.bg == null ? null : `48;5;${s.bg}`].filter((c) => c !== null).join(';');
  return rows.map((row) => {
    const text = row.map((sp) => sp.t).join('');
    const pad = ' '.repeat(Math.max(0, cols - cells(text)));
    return `${row.map((sp) => `\u001b[${sgr(sp.s)}m${sp.t}`).join('')}\u001b[0m${pad}`;
  }).join('\n') + '\n';
}

/**
 * Screens that carry a task list or a rule row in a shape nika must NOT cut (F13-A (−)): name → rows. Every entry leaves `footerEnd` at the last
 * row. `dialog` are the rows of a dialog or a permission prompt the block would hang under (its last row is the anchor). The entries that
 * change one row of the block do it on a copy of the plain named block (taskRows() defaults: 1 in progress, 1 open, 2 done listed + 3 hidden,
 * 7 tasks) and keep the header's counts true, so that only the shape is wrong and each entry fails for the one check it names.
 */
export function taskMisfits(dialog, { cols = 120 } = {}) {
  const line = (text, s) => [span(text, s)];
  const block = (o) => taskRows({ cols, ...o });
  const withBlock = (o) => [...dialog, ...block(o)];
  const edit = (change, o) => { const rows = withBlock(o); change(rows); return rows; };
  const headAt = (rows) => rows.findIndex((r) => /tasks \(/.test(r.map((sp) => sp.t).join('')));
  const modeLine = [line('transcript line'), line('│ > │'), line('╰──────╯'), line('⏵⏵ auto mode on (shift+tab to cycle)')];
  const agents = subagentRows({ cols, agents: 2 });
  const rule = taskRows({ cols, doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }).slice(0, 1);
  return {
    'the total does not add up': withBlock({ claim: { total: 8 } }),
    'the done count does not match the rows and the overflow row': withBlock({ claim: { done: 6, total: 8 } }),
    'the in-progress count does not match the rows': withBlock({ claim: { doing: 2, total: 8 } }),
    'the open count does not match the rows': withBlock({ claim: { open: 2, total: 8 } }),
    'the hidden in-progress count does not match': withBlock({ hiddenDoing: 2, claim: { doing: 4, total: 10 } }),
    'the hidden pending count does not match': withBlock({ hiddenOpen: 2, claim: { open: 4, total: 10 } }),
    'no task at all (total 0)': withBlock({ doing: 0, open: 0, shownDone: 0, hiddenDone: 0 }),
    'no task row and an overflow row': withBlock({ doing: 0, open: 0, shownDone: 0, hiddenDone: 3 }),
    'a rule row followed by two blank rows': withBlock({ gap: 2 }),
    'a rule row followed by no blank row': withBlock({ gap: 0 }),
    'an unnamed block with no blank row above the header': withBlock({ named: false, blank: 0 }),
    'a rule row indented by two spaces': withBlock({ rule: 'indented' }),
    'a text row instead of the blank row between the rule and the header': edit((rows) => { rows[headAt(rows) - 1] = line('  a note'); }),
    'a text row instead of the rule row': edit((rows) => { rows[headAt(rows) - 2] = line('  a note'); }),
    'a text row between the dialog end and an unnamed block': edit((rows) => { rows.splice(headAt(rows), 0, line('  a note'), []); }, { named: false }),
    'the header says 0 in progress': withBlock({ doing: 0, open: 2, shownDone: 2, hiddenDone: 0, head: '  4 tasks (2 done, 0 in progress, 2 open)' }),
    'the header says 1 task': withBlock({ doing: 0, open: 0, shownDone: 1, hiddenDone: 0, head: '  1 task (1 done, 0 open)' }),
    'a row with an unknown glyph': edit((rows) => rows.splice(headAt(rows) + 2, 0, line('  ● Another thing'))),
    'a task row indented by four spaces': edit((rows) => { rows[headAt(rows) + 1] = line('    \u25fc Draft the outline'); }),
    'a task row indented by one space': edit((rows) => { rows[headAt(rows) + 1] = line(' \u25fc Draft the outline'); }),
    'a task row indented by three spaces': edit((rows) => { rows[headAt(rows) + 1] = line('   \u25fc Draft the outline'); }),
    'a glyph row without a label': edit((rows) => { rows[headAt(rows) + 1] = line('  ◼ '); }),
    'a second row under a task': edit((rows) => rows.splice(headAt(rows) + 2, 0, line('    rest of the label'))),
    'a notification row after the last row of the block': [...withBlock(), line('  A notice from the shell')],
    'a notification row between the tasks': edit((rows) => rows.splice(headAt(rows) + 3, 0, line('  A notice from the shell'))),
    'the overflow row names a state that does not exist': edit((rows) => { rows[rows.length - 1] = line('   … +3 finished'); }),
    'the overflow row lists the states in another order': withBlock({ hiddenDone: 3, hiddenOpen: 1, hiddenText: '3 completed, 1 pending' }),
    'the overflow row lists a state with a zero count': withBlock({ hiddenDone: 3, hiddenText: '0 pending, 3 completed' }),
    'the overflow row repeats a state': withBlock({ hiddenDone: 1, hiddenText: '2 completed, 1 completed' }),
    'the overflow row has text after its last part': withBlock({ hiddenText: '3 completed soon' }),
    'the overflow row joins its parts with a space': withBlock({ hiddenDone: 3, hiddenOpen: 1, hiddenText: '1 pending 3 completed' }),
    'the overflow row is not the last row': (() => { const rows = withBlock({ shownDone: 3, hiddenDone: 3 }); rows.push(rows.splice(-2, 1)[0]); return rows; })(),
    'two overflow rows': [...withBlock({ claim: { total: 10, done: 8 } }), line('   … +3 completed')],
    'a lone rule followed by a text row': [...dialog, ...rule, line('  a note')],
    'two rule rows': [...dialog, ...rule, ...rule],
    'the block hangs under a mode line': [...modeLine, ...block()],
    'a lone rule hangs under a mode line': [...modeLine, ...rule],
    'the block hangs under Esc to cancel with no prompt above it': [line('transcript line'), line('Esc to cancel · Tab to amend'), ...block()],
    'a subagent list below the block': [...withBlock(), ...agents],
    'the block below a subagent list': [...dialog, ...agents, ...block()],
    'an unnamed block below a subagent list': [...dialog, ...agents, ...block({ named: false })],
    'a real block above a message and a real input box (not at the bottom)': [...withBlock(), line('⏺ A later message.'), ...modeLine],
  };
}
