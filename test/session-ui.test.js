// Static checks on the session window files (public/session.{html,js,css}, public/mirror-render.js): strict-CSP rules,
// forbidden DOM sinks, ids used by the script exist in the page, the keys the page asks for are on the server's allow-list.
// The browser itself is exercised by hand (Playwright); these checks keep the rules from regressing.
import { test, describe, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { KEY_NAME } from '../src/ids.js';
import { moveActive as moveActiveReal, cleanCommands as cleanCommandsReal, paletteQuery as paletteQueryReal, shouldFetch as shouldFetchReal } from '../public/palette.js';
import { wantsHelp, wantsBack, wantsHistToggle, isTextEntry, backHint, helpHint, histHint, passKeyLabel, wireWindowKeys as wireWindowKeysReal } from '../public/shortcuts.js';
import { quickState as quickStateReal, sendGate as sendGateReal, keysRefusal as keysRefusalReal, stopOutcome as stopOutcomeReal, commandSaid as commandSaidReal, commandFailure as commandFailureReal, problemKind as problemKindReal, followSession as followSessionReal, planShell as planShellReal, cleanPrompt as cleanPromptReal, hasAnswerButtons as hasAnswerButtonsReal, attnNote as attnNoteReal, answerOutcome as answerOutcomeReal, promptOff as promptOffReal, composerKey as composerKeyReal } from '../public/quick-actions.js';
import { planSend as planSendReal, arrowEcho as arrowEchoReal, keyForEvent as keyForEventReal, planPaste as planPasteReal, toRenderModel as toRenderModelReal, cutCursor as cutCursorReal } from '../public/mirror-render.js';
import { draftSendPlan as draftSendPlanReal, cleanDraft as cleanDraftReal, cutAt as cutAtReal, caretAfter as caretAfterReal, noteView as noteViewReal, suggestionFor as suggestionForReal, submitResult as submitResultReal, submitMessage as submitMessageReal } from '../public/draft-sync.js';
import { switchFailure as switchFailureReal, MODE_TARGETS, MODE_META } from '../public/modes.js';
import {
  createFitPlanner as createFitPlannerReal, panelSize as panelSizeReal, scaleFor as scaleForReal, chipView as chipViewReal, fitPanelView as fitPanelViewReal, stillOffSay as stillOffSayReal,
  createRedrawHold as createRedrawHoldReal, remeasure as remeasureReal, askSize as askSizeReal, roomStep as roomStepReal, refitFrom as refitFromReal, HOLD_MS as HOLD_MS_REAL, REFIT_MS as REFIT_MS_REAL, FOCUS_SETTLE_MS as FOCUS_SETTLE_REAL, BLUR_SETTLE_MS as BLUR_SETTLE_REAL,
  hiddenRows as hiddenRowsReal, fillSize as fillSizeReal, drawnScale as drawnScaleReal, // F11
} from '../public/fit-ui.js';
import { createScrollPlanner as createScrollPlannerReal, routeFor as routeForReal, wheelRows as wheelRowsReal, scrollGate as scrollGateReal, viewRowsOf as viewRowsOfReal, pageRowsOf as pageRowsOfReal, refusalLine as refusalLineReal, noteView as scrollNoteViewReal, scrolledSay as scrolledSayReal, NOTE_MS as NOTE_MS_REAL } from '../public/scroll.js';
import { h as hReal, icon as iconReal, roleTagEl as roleTagElReal, subStateEl as subStateElReal, subagentItemEl as subagentItemElReal, labelEl as labelElReal } from '../public/dom.js';
import { subagentView as subagentViewReal, subagentHref as subagentHrefReal, SUBAGENT_ID as SUBAGENT_ID_REAL, agentLabelView as agentLabelViewReal, subLabelView as subLabelViewReal } from '../public/dash-model.js';
import { SESSION_ID as SESSION_ID_REAL, PANE_ID as PANE_ID_REAL } from '../public/quick-actions.js';
import { cleanDialog as cleanDialogReal } from '../public/dialog-form.js';
import { installDom, El, withClass, focus as focusState } from './fake-dom.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const HTML = read('session.html');
const JS = {
  'session.js': read('session.js'), 'mirror-render.js': read('mirror-render.js'), 'modes.js': read('modes.js'),
  'quick-actions.js': read('quick-actions.js'), 'models-ui.js': read('models-ui.js'), 'end-dialog.js': read('end-dialog.js'),
  'palette.js': read('palette.js'), 'shortcuts.js': read('shortcuts.js'), 'draft-sync.js': read('draft-sync.js'), 'fit-ui.js': read('fit-ui.js'), 'scroll.js': read('scroll.js'), 'dialog-form.js': read('dialog-form.js'),
};
const TOKENS = read('tokens.css');
const CSS = read('session.css');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Source with // and block comments removed (a `//` right after `:` is a URL, not a comment). */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

// Sinks are assembled from parts so this file does not contain them either.
const SINKS = [
  ['inner' + 'HTML', /inner\s*HTML/],
  ['insertAdjacent' + 'HTML', /insertAdjacent\s*HTML/],
  ['outer' + 'HTML', /outer\s*HTML/],
  ['document.' + 'write', /document\s*\.\s*write/],
  ['ev' + 'al(', /\beval\s*\(/],
  ['new Func' + 'tion', /new\s+Function\b/],
  ['Func' + 'tion(', /\bFunction\s*\(/],
  ["setAttribute('" + "style'", /setAttribute\s*\(\s*['"`]style['"`]/i],
  ['css' + 'Text', /css\s*Text/],
  ['src' + 'doc', /srcdoc/i],
  ['createContextual' + 'Fragment', /createContextualFragment/],
  ['DOM' + 'Parser', /DOMParser/],
  ['javascript' + ':', /javascript\s*:/i],
  ["setAttribute('" + "on...", /setAttribute\s*\(\s*['"`]on/i],
  ['.on...= handler property', /\.\s*on[a-z]+\s*=[^=]/],
  ['import' + 'Scripts / document.domain', /importScripts|document\.domain/],
];
const findSinks = (src) => SINKS.filter(([, re]) => re.test(code(src))).map(([name]) => name);

// ---- the Send chain (W13): sendComposer and the functions it ends in, run for real against a fake keys route and a fake submit route ----
const SEND_FUNCS = [
  'async function sendComposer()', 'async function pushThenSubmit(route)', 'async function typeThenSubmit(payloads)', 'async function submitEnter(base)',
  'async function deliverAll(payloads)', 'function clearBox(value)',
];
const TAKEN = { status: 200, body: { taken: true, draft: null } };
const jsonClone = (v) => JSON.parse(JSON.stringify(v)); // objects built inside the vm have another Object.prototype
/** The log of what went out: `keys` (bodies the keys route got), `posts` ([route tail, body] of the submit route), `order` (their order, with the sync's calls added by the rig). `sent` is both. */
const sendLog = () => ({ keys: [], posts: [], order: [], get sent() { return [...this.keys, ...this.posts]; } });
/** The context members the chain needs besides the page's own state. `submit(tail, body)` answers the submit route (default: taken). */
const sendIo = (log, submit = () => TAKEN, hold = { active: false }) => ({
  HOLD: hold, // F10: Send waits for the redraw hold; a hold that is not running is nothing to wait for
  enqueueJob: (run) => run(),
  deliver: async (payload) => { log.order.push('keys'); log.keys.push(jsonClone(payload)); return { ok: true }; },
  postRetry: async (tail, body) => { log.order.push(tail); log.posts.push([tail, jsonClone(body)]); return submit(tail, body); },
  submitResult: submitResultReal, clearProblem() {}, setGone() {},
});

describe('forbidden sinks', () => {
  for (const [file, src] of Object.entries(JS)) {
    test(`(−) ${file} uses no HTML-parsing, code-evaluating or style-string sink`, () => {
      assert.deepEqual(findSinks(src), []);
    });
  }

  test('(−) the scanner itself catches each sink (so the check above can fail)', () => {
    const samples = [
      'el.' + 'innerHTML = x', 'el.insertAdjacent' + "HTML('beforeend', x)", 'el.outer' + 'HTML = x', 'document.' + 'write(x)', 'ev' + 'al(x)',
      'new Func' + 'tion(x)', "el.setAttribute('" + "style', x)", 'el.style.css' + 'Text = x', 'f.src' + 'doc = x', 'a.href = "javascript' + ':1"',
      "el.setAttribute('on" + "click', x)", 'el.on' + 'click = f', 'new DOM' + 'Parser()',
    ];
    for (const s of samples) assert.notDeepEqual(findSinks(s), [], s);
    assert.deepEqual(findSinks('// el.' + 'innerHTML is forbidden\nconst a = 1; /* ev' + 'al( */'), [], 'comments are ignored');
  });

  test('(+) the page code does write through textContent and element.style only', () => {
    assert.match(JS['mirror-render.js'], /\.textContent = /);
    assert.match(JS['mirror-render.js'], /\.style\.color = /);
    assert.match(JS['session.js'], /textContent/);
  });

  test('(−) no page module touches the secret, storage of data, cookies or other origins', () => {
    for (const [file, src] of Object.entries(JS)) {
      const c = code(src);
      assert.doesNotMatch(c, /__NIKA_APP__|X-Nika-App|document\.cookie/, file);
      assert.doesNotMatch(c, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|window\.open|location\s*(\.href)?\s*=[^=]/, file);
      assert.doesNotMatch(c, /https?:\/\/(?!claude\.ai\/code\/)/, file);
    }
  });
});

describe('session.html under the strict CSP', () => {
  test('(−) no inline script, inline style, style attribute or on* attribute', () => {
    const scripts = [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0][1], /\btype="module"/);
    assert.match(scripts[0][1], /\bsrc="session\.js"/);
    assert.equal(scripts[0][2].trim(), '');
    assert.doesNotMatch(HTML, /<style\b/i);
    assert.doesNotMatch(HTML, /\sstyle\s*=/i);
    assert.doesNotMatch(HTML, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(HTML, /javascript:/i);
    assert.doesNotMatch(HTML, /<(iframe|object|embed|form|base)\b/i);
  });

  test('(+) it links tokens.css and session.css only, and no external resource', () => {
    const links = [...HTML.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].map((m) => /href="([^"]+)"/.exec(m[0])[1]);
    assert.deepEqual(links, ['tokens.css', 'session.css']);
    const urls = [...HTML.matchAll(/(?:src|href)="(https?:[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(urls, ['https://claude.ai/code/'], 'the only absolute URL is the claude.ai link placeholder (JS validates and sets the real one)');
    assert.match(HTML, /<a\b[^>]*id="claude-link"[^>]*rel="noopener noreferrer"/);
    assert.match(HTML, /<a\b[^>]*id="claude-link"[^>]*\bhidden\b/);
  });

  test('(+) skip links, landmarks, labelled regions and the mirror is not a live region', () => {
    assert.match(HTML, /<a class="skip" href="#sess-main">/);
    assert.match(HTML, /<a class="skip skip-2" href="#composer">/);
    assert.match(HTML, /<main\b/);
    assert.match(HTML, /<h1\b/);
    const term = /<div class="term"[^>]*>/.exec(HTML)[0];
    assert.match(term, /role="region"/);
    assert.match(term, /tabindex="0"/);
    assert.doesNotMatch(term, /aria-live|role="log"|role="status"|role="alert"/);
    assert.match(HTML, /id="echo" aria-live="polite"/);
    assert.match(HTML, /id="problem" role="alert"/);
    assert.match(HTML, /<label for="composer"/);
  });

  test('(+) ids are unique and every id the script looks up exists', () => {
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
    const src = code(JS['session.js']);
    const used = new Set([...src.matchAll(/\$\('([A-Za-z0-9-]+)'\)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/of \[((?:'[a-z-]+',? ?)+)\]/g)) for (const id of m[1].match(/[a-z-]+/g)) used.add(id);
    for (const id of ['sess-term', 'sess-hist']) used.add(id);
    const missing = [...used].filter((id) => !ids.includes(id));
    assert.deepEqual(missing, []);
    assert.ok(used.size > 30, 'the lookup scan found the ids');
  });

  test('(−) 0.3.3: the page has no key row: no class="keys", no data-key, no .key rule in session.css (the keys work from the message box)', () => {
    assert.doesNotMatch(HTML, /class="keys"|data-key=|class="key"/);
    assert.doesNotMatch(strip(CSS), /(^|[\s,}])\.keys?\b/);
  });
});

describe('contracts with the other UI modules', () => {
  test('(+) session.js imports only names the shared modules export, from sibling files', () => {
    const imports = [...JS['session.js'].matchAll(/import \{([^}]+)\} from '([^']+)'/g)];
    assert.deepEqual(imports.map((m) => m[2]), ['./dom.js', './api.js', './dash-model.js', './mirror-render.js', './draft-sync.js', './modes.js', './quick-actions.js', './models-ui.js', './end-dialog.js', './palette.js', './shortcuts.js', './fit-ui.js', './scroll.js', './attach.js', './dialog-form.js']);
    for (const [, names, from] of imports) {
      const exported = read(from.slice(2));
      for (const n of names.split(',').map((x) => x.trim())) assert.match(exported, new RegExp(`export (async )?(function|const|let) ${n}\\b`), `${from} exports ${n}`);
    }
  });

  test('(−) session.js talks to /api/app through appFetch only; its one public route goes through getJSON', () => {
    const src = code(JS['session.js']);
    const paths = [...src.matchAll(/['"`](\/api\/[^'"`]*)/g)].map((m) => m[1]);
    assert.ok(paths.length > 0);
    for (const p of paths) assert.match(p, /^\/api\/(app\/(session|pane|settings|projects|models|commands)|agents\?since=all)/, p);
    assert.match(src, /getJSON\('\/api\/agents\?since=all'\)/);
  });

  test('(+) the claude.ai link is only built from a validated session id', () => {
    const src = code(JS['session.js']);
    assert.match(src, /CLAUDE_SESSION = \/\^session_\[A-Za-z0-9\]\{1,64\}\$\//);
    assert.equal([...src.matchAll(/\.href = /g)].length, 2, 'only the back link and the claude.ai link get an href');
  });
});

describe('css and source hygiene', () => {
  test('(−) the stylesheet needs no color-mix(), :has(), @import or remote url()', () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /color-mix\(|:has\(|@import|url\(\s*['"]?https?:/i);
    assert.doesNotMatch(css, /expression\(|(^|[\s;{])behavior\s*:|-moz-binding/i);
  });

  test('(+) the stylesheet defines the mirror palette and the classes mirror-render.js emits', () => {
    for (let i = 0; i < 16; i += 1) {
      assert.match(CSS, new RegExp(`\\.f${i}\\{color:var\\(--a${i}\\)\\}`));
      assert.match(CSS, new RegExp(`\\.b${i}\\{background:var\\(--a${i}\\)\\}`));
    }
    for (const c of ['fdb', 'bdf', 'sb', 'sd', 'si', 'su', 'tc', 'tl']) assert.match(CSS, new RegExp(`\\.${c}\\s*\\{`), c);
  });

  test('(−) the files are pure ASCII (no raw bidi or other invisible code points) and never mention the banned word', () => {
    const banned = ['pony', 'tail'].join('');
    for (const [name, src] of [['session.html', HTML], ['session.css', CSS], ...Object.entries(JS)]) {
      assert.equal([...src].every((ch) => ch.codePointAt(0) < 128), true, name);
      assert.equal(src.toLowerCase().includes(banned), false, name);
    }
    assert.equal(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').toLowerCase().includes(banned), false);
  });
});

describe('permission mode: tag, frame, edge and switcher (spec 2.8, 9.1-9.3)', () => {
  const at = (needle) => {
    const i = HTML.indexOf(needle);
    assert.ok(i >= 0, `${needle} is in session.html`);
    return i;
  };
  const tagOf = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';

  test('(+) header order: status pill, mode tag, meta, spacer, tools (claude.ai link, shortcuts); the switcher and its reason line are not in the header', () => {
    const order = ['id="sess-st"', 'id="sess-mode"', 'class="sess-meta"', 'class="sp"', 'class="bar-tools"', 'id="claude-link"', 'id="kbd-open"'].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(at('id="sess-mode"') < at('</header>'));
    assert.ok(at('id="kbd-open"') < at('</header>'));
    const header = HTML.slice(at('<header'), at('</header>'));
    assert.ok(!header.includes('id="mode-switch"') && !header.includes('id="msw-why"') && !header.includes('bar-end'));
  });

  test('(+) 0.3.3: the mode row sits in the composer after the message box and before the notes row; it is hidden until the script wires the switcher', () => {
    const box = HTML.slice(at('id="composer-box"'));
    const order = ['class="inbox"', 'id="mode-row"', 'id="mode-switch"', 'id="msw-why"', 'id="notes"'].map((n) => box.indexOf(n));
    assert.ok(order.every((i) => i > 0), 'all five are in #composer-box');
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(tagOf('mode-row'), /\bclass="mode-row"/);
    assert.match(tagOf('mode-row'), /\bhidden\b/);
    const row = new RegExp('<div class="mode-row" id="mode-row"[^>]*>([\\s\\S]*?)</div>\\s*<div class="notes quiet" id="notes"').exec(HTML)?.[1] ?? '';
    assert.ok(row.includes('id="mode-switch"') && row.includes('id="msw-why"'), 'both inside #mode-row');
    assert.doesNotMatch(row, /mode-lbl|>\s*Mode\s*</, 'no visible "Mode" word (owner, 2026-11-13): the toolbar names itself');
  });

  test('(−) the toolbar has its own label (no visible "Mode" word since 0.4.0); the row is not a live region', () => {
    assert.doesNotMatch(tagOf('mode-row'), /aria-live|role=/);
    assert.match(tagOf('mode-switch'), /aria-label="Permission mode"/);
  });

  test('(+) #mode-switch is a labelled toolbar described by #msw-why; neither is a live region; the pane-less window shows none of it', () => {
    const sw = tagOf('mode-switch');
    assert.match(sw, /\bclass="msw"/);
    assert.match(sw, /\brole="toolbar"/);
    assert.match(sw, /\baria-label="Permission mode"/);
    assert.match(sw, /\baria-describedby="msw-why"/);
    assert.match(sw, /\bhidden\b/, 'script reveals it only when the window has a pane');
    const why = tagOf('msw-why');
    assert.match(why, /\bclass="msw-why"/);
    assert.doesNotMatch(why, /aria-live|role="(status|alert|log)"/);
    assert.doesNotMatch(sw, /aria-live|role="(status|alert|log)"/);
    assert.doesNotMatch(tagOf('sess-mode'), /aria-live|role=/, 'the tag is not a control and not a live region');
  });

  test('(+) #mode-live is one polite region, separate from the global announcer', () => {
    assert.match(tagOf('mode-live'), /aria-live="polite"/);
    assert.match(tagOf('announcer'), /aria-live="polite"/);
    assert.notEqual(at('id="mode-live"'), at('id="announcer"'));
  });

  test('(+) the 3 px frame is decoration: aria-hidden, the first child of body', () => {
    const body = HTML.slice(at('<body'));
    assert.match(body, /^<body[^>]*>\s*<div class="mode-frame" aria-hidden="true"><\/div>/);
  });

  test('(+) the sprite holds every mode icon plus info and warn, and every icon name the code draws', () => {
    const symbols = new Set([...HTML.matchAll(/<symbol id="i-([a-z-]+)"/g)].map((m) => m[1]));
    for (const n of ['m-manual', 'm-edits', 'm-plan', 'm-auto', 'm-bypass', 'm-dontask', 'm-unknown', 'info', 'warn']) assert.ok(symbols.has(n), n);
    const drawn = new Set();
    for (const f of ['session.js', 'modes.js']) {
      for (const call of code(JS[f]).matchAll(/\bicon\(([^()]*)\)/g)) for (const q of call[1].matchAll(/'([a-z-]+)'/g)) drawn.add(q[1]);
    }
    for (const m of code(JS['modes.js']).matchAll(/\bicon: '([a-z-]+)'/g)) drawn.add(m[1]);
    assert.ok(drawn.size >= 9);
    assert.deepEqual([...drawn].filter((n) => !symbols.has(n)), []);
  });

  test('(+) the message-box edge survives focus: edge and ring are one declaration, and the old ring-only rule is gone', () => {
    const css = strip(CSS);
    assert.match(css, /\.inbox\s*\{[^}]*box-shadow:\s*inset 3px 0 0 var\(--mc-line, transparent\)/);
    assert.match(css, /\.inbox:focus-within\s*\{[^}]*box-shadow:\s*inset 3px 0 0 var\(--mc-line, transparent\),\s*0 0 0 1px var\(--accent\)/);
    assert.doesNotMatch(css, /\.inbox:focus-within\s*\{\s*border-color:\s*var\(--accent\);\s*box-shadow:\s*0 0 0 1px var\(--accent\);\s*\}/);
  });

  test('(+) the frame is 0 px without a mode, 3 px with one; dashed when unconfirmed or unknown; striped (never dashed) for Bypass', () => {
    const css = strip(CSS);
    assert.match(css, /\.mode-frame\s*\{[^}]*height:\s*0/);
    assert.match(css, /body\[data-mode\] \.mode-frame\s*\{[^}]*height:\s*3px/);
    assert.match(css, /body\[data-confirmed="false"\] \.mode-frame, body\.m-unknown \.mode-frame\s*\{[^}]*repeating-linear-gradient\(90deg/);
    const bypass = css.search(/body\.m-bypass \.mode-frame/);
    assert.ok(bypass > css.search(/body\[data-confirmed="false"\] \.mode-frame/), 'the Bypass rule comes after the dashed rule so it wins');
    assert.match(css, /body\.m-bypass \.mode-frame\s*\{[^}]*repeating-linear-gradient\(135deg/);
  });

  test('(−) mode results never use the alert region or the problem line; they go to #mode-live', () => {
    const src = code(JS['session.js']);
    const block = /async function switchTo[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
    assert.ok(block.length > 200, 'switchTo found');
    assert.doesNotMatch(block, /showProblem/);
    assert.match(src, /\$\('mode-live'\)/);
  });
});

describe('quick actions, prompt buttons, End dialog and Shell (spec 9.4-9.8)', () => {
  const QA = ['qa-stop', 'qa-compact', 'qa-clear', 'qa-model', 'qa-rewind', 'qa-end'];
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';
  const whole = (id, name = 'button') => new RegExp(`<${name}\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</${name}>`).exec(HTML)?.[0] ?? '';
  const textOf = (markup) => markup.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/&hellip;/g, '…').replace(/\s+/g, ' ').trim();
  const dialog = (id) => new RegExp(`<dialog\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</dialog>`).exec(HTML)?.[0] ?? '';

  test('(+) quick-action buttons exist with accessible names', () => {
    for (const id of QA) {
      const b = whole(id);
      assert.match(b, /^<button type="button"/, id);
      assert.ok(textOf(b) !== '' || /\baria-label="[^"]+"/.test(b), `${id} has a name`);
    }
    assert.equal(textOf(whole('qa-stop')), 'Stop');
    assert.equal(textOf(whole('qa-compact')), 'Compact');
    assert.equal(textOf(whole('qa-clear')), 'Clear…');
    assert.match(textOf(whole('qa-model')), /^Model/);
    assert.equal(textOf(whole('qa-rewind')), 'Rewind');
    assert.equal(textOf(whole('qa-end')), 'End session…');
  });

  test('(+) Stop is in the first slot of #qa and End session sits last, alone at the far right', () => {
    const bar = whole('qa', 'div');
    assert.match(bar, /^<div class="qa" id="qa" role="toolbar"/);
    const order = QA.map((id) => bar.indexOf(`id="${id}"`));
    assert.ok(order.every((i) => i > 0), 'all six are inside #qa');
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'Stop, Compact, Clear, Model, Rewind, End');
    assert.ok(bar.indexOf('class="sp"') > order[4] && bar.indexOf('class="sp"') < order[5], 'a spacer pushes End to the right');
    assert.match(whole('qa-end'), /class="btn danger"/, 'plain danger, not filled (spec)');
  });

  test('(+) #qa is a labelled toolbar described by #qa-why, which is not a live region; only Stop is a Tab stop at first', () => {
    const bar = tag('qa');
    assert.match(bar, /\baria-label="Session actions"/);
    assert.match(bar, /\baria-describedby="qa-why"/);
    const why = tag('qa-why');
    assert.match(why, /\bclass="qa-why"/);
    assert.doesNotMatch(why, /aria-live|role="(status|alert|log)"/);
    const stops = QA.filter((id) => /\btabindex="0"/.test(tag(id)));
    assert.deepEqual(stops, ['qa-stop'], 'one Tab stop for the whole toolbar');
    for (const id of QA.slice(1)) assert.match(tag(id), /\btabindex="-1"/, id);
  });

  test('(+) all six start aria-disabled (nothing acts before the script has read the pane); none uses the disabled attribute', () => {
    for (const id of QA) {
      assert.match(tag(id), /\baria-disabled="true"/, id);
      assert.doesNotMatch(tag(id), /\sdisabled(\s|=|>)/, id);
    }
  });

  test('(+) Compact, Clear and Rewind keep their word in the label so the narrow layout can drop the text', () => {
    for (const id of ['qa-compact', 'qa-clear', 'qa-rewind']) {
      assert.match(whole(id), /<span class="lbl">/, id);
      assert.match(tag(id), /\baria-label="[A-Z][a-z]+"/, id);
    }
    assert.match(strip(CSS), /@media \(max-width: 760px\)[\s\S]*\.q-narrow \.lbl\s*\{[^}]*display:\s*none/);
  });

  test('(+) every key name sent, in the script and in the rules module, is on the server allow-list', () => {
    const used = new Set();
    for (const f of ['session.js', 'quick-actions.js']) {
      const src = code(JS[f]);
      for (const m of src.matchAll(/sendKey\('([^']+)'\)/g)) used.add(m[1]);
      for (const m of src.matchAll(/keys: \[([^\]]*)\]/g)) for (const k of m[1].matchAll(/'([^']+)'/g)) used.add(k[1]);
    }
    for (const k of ['Escape', 'C-u']) assert.ok(used.has(k), `${k} is sent somewhere`);
    for (const k of used) assert.ok(KEY_NAME.has(k), k);
  });

  test('(−) W13: no script or rule file names an Enter key for the keys route: Send presses Enter only through the submit route (the passthrough maps raw keys in mirror-render.js)', () => {
    const SEND_KEY_ENTER = /sendKey\(\s*['"`]Enter['"`]\s*\)/;
    const KEYS_WITH_ENTER = /keys:\s*\[[^\]]*['"`]Enter['"`]/;
    for (const f of ['session.js', 'quick-actions.js', 'draft-sync.js']) {
      const src = code(JS[f]);
      assert.doesNotMatch(src, SEND_KEY_ENTER, f);
      assert.doesNotMatch(src, KEYS_WITH_ENTER, f);
    }
    assert.doesNotMatch(code(JS['mirror-render.js']), KEYS_WITH_ENTER);
    for (const bad of [`sendKey('Enter')`, `sendKey("Enter")`, 'sendKey(`Enter`)', `keys: ['Enter']`, `keys: ["Enter"]`, `keys: ['a', "Enter"]`, `{ keys:["Enter"] }`]) {
      assert.ok(SEND_KEY_ENTER.test(bad) || KEYS_WITH_ENTER.test(bad), `the scan catches ${bad}`);
    }
  });

  test('(+) the model popover is a hidden disclosure with a labelled select, a custom field and Cancel / Switch model', () => {
    const btn = tag('qa-model');
    assert.match(btn, /\baria-expanded="false"/);
    assert.match(btn, /\baria-controls="model-pop"/);
    const pop = whole('model-pop', 'div');
    assert.match(pop, /\bhidden\b/);
    assert.match(pop, /role="group"/);
    assert.match(pop, /<label for="model-sel"/);
    assert.match(pop, /<select\b[^>]*\bid="model-sel"/);
    assert.match(pop, /<label[^>]*for="model-custom"/);
    assert.match(pop, /<input\b[^>]*\bid="model-custom"[^>]*\bautocomplete="off"/);
    assert.match(pop, /id="model-custom-err"/);
    assert.equal(textOf(whole('model-cancel')), 'Cancel');
    assert.equal(textOf(whole('model-go')), 'Switch model');
    assert.match(whole('model-go'), /class="btn primary"/);
    assert.ok(HTML.indexOf('id="qa"') < HTML.indexOf('id="model-pop"') && HTML.indexOf('id="model-pop"') < HTML.indexOf('id="prompt-btns"'), 'popover sits between the toolbar and the prompt panel (Tab order, spec 9.10)');
  });

  test('(+) end dialog has a heading and a Cancel button; Cancel is the initial focus; End session is the danger button', () => {
    const d = dialog('end-dlg');
    assert.ok(d, 'the dialog exists');
    assert.match(d, /<dialog\b[^>]*\bclass="dlg-confirm"/);
    assert.match(d, /<dialog\b[^>]*\baria-labelledby="end-h"/);
    assert.match(d, /<h2\b[^>]*\bid="end-h"/);
    assert.equal(textOf(whole('end-cancel')), 'Cancel');
    assert.match(whole('end-cancel'), /\bautofocus\b/);
    assert.equal(textOf(whole('end-go')), 'End session');
    assert.match(whole('end-go'), /class="btn danger fill"/, 'spec 9.8: End session is danger, filled');
    assert.match(tag('end-alert'), /role="alert"/);
    assert.match(tag('end-alert'), /\bhidden\b/);
    assert.match(tag('end-alert'), /data-kind="danger"/);
    assert.match(tag('end-wait'), /aria-live="polite"/);
  });

  test('(+) the Clear confirm has a heading, Cancel as initial focus and a danger "Clear conversation"', () => {
    const d = dialog('clear-dlg');
    assert.ok(d);
    assert.match(d, /<h2\b[^>]*\bid="clear-h"/);
    assert.match(d, /Claude starts a new conversation with empty context\./);
    assert.equal(textOf(whole('clear-cancel')), 'Cancel');
    assert.match(whole('clear-cancel'), /\bautofocus\b/);
    assert.equal(textOf(whole('clear-go')), 'Clear conversation');
    assert.match(whole('clear-go'), /class="btn danger"/, 'plain danger, not filled (spec)');
  });

  test('(+) #prompt-btns is a hidden group labelled by the question, in the composer above the message box', () => {
    const p = tag('prompt-btns');
    assert.match(p, /role="group"/);
    assert.match(p, /aria-labelledby="ask-q"/);
    assert.match(p, /\bhidden\b/);
    assert.match(tag('ask-q'), /\bclass="ask-q"/);
    assert.ok(HTML.indexOf('id="prompt-btns"') < HTML.indexOf('class="inbox"'));
    assert.match(HTML, /Each button presses its number in the pane\. Claude answers at once; no Enter\./);
    const s = code(JS['session.js']);
    assert.match(s, /\.bypass/, 'an option marked bypass is drawn without a button');
    assert.match(s, /Answer this one in the terminal/);
  });

  test('(+) shell toggle has aria-pressed, the on/off chip, and sits before the prompt sign and the textarea', () => {
    const t = tag('shell-toggle');
    assert.match(t, /\baria-pressed="false"/);
    assert.match(t, /^<button type="button" class="shell"/);
    const b = whole('shell-toggle');
    assert.match(b, /<span class="onoff" aria-hidden="true">off<\/span>/);
    assert.match(b, /<use href="#i-shell"\/>/);
    assert.equal(textOf(b).replace(/\s*off$/, ''), 'Shell');
    assert.ok(HTML.indexOf('id="shell-toggle"') < HTML.indexOf('class="prompt"'));
    assert.ok(HTML.indexOf('class="prompt"') < HTML.indexOf('id="composer"'));
    assert.match(tag('shell-hint'), /\bhidden\b/);
    assert.match(HTML, /Shell on: Enter runs this through Claude&rsquo;s ! mode, then shell turns off\./);
  });

  test('(+) "Type into pane" gains the on/off chip too, and the script keeps it in step', () => {
    assert.match(whole('pass-toggle'), /<span class="onoff" id="pass-onoff" aria-hidden="true">off<\/span>/);
    assert.match(code(JS['session.js']), /\$\('pass-onoff'\)/);
  });

  test('(+) .onoff is in tokens.css (both pages load it): 11 px 700, 1 px currentColor edge', () => {
    const css = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.onoff\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /font-size:\s*var\(--fs-cap\)/);
    assert.match(rule, /font-weight:\s*700/);
    assert.match(rule, /border:\s*1px solid currentColor/);
  });

  test('(+) the Shell look: ink border replaces the 1 px border and the mode edge; focus adds the accent ring; the sign is ink', () => {
    const css = strip(CSS);
    assert.match(css, /\.inbox\.shell-on\s*\{[^}]*border:\s*2px solid var\(--shell\)[^}]*box-shadow:\s*none/);
    assert.match(css, /\.inbox\.shell-on:focus-within\s*\{[^}]*border-color:\s*var\(--shell\)[^}]*box-shadow:\s*0 0 0 2px var\(--accent\)/);
    assert.match(css, /\.inbox\.shell-on \.prompt\s*\{[^}]*color:\s*var\(--shell\)/);
    assert.match(css, /\.shell\[aria-pressed="true"\]\s*\{[^}]*background:\s*var\(--shell\)[^}]*color:\s*var\(--on-shell\)/);
    assert.match(TOKENS, /--shell:\s*var\(--text\);\s*--on-shell:\s*var\(--surface\)/);
  });

  test('(+) every <use> in the page points at a symbol of its sprite (the quick-action icons are drawn)', () => {
    const symbols = new Set([...HTML.matchAll(/<symbol id="(i-[a-z-]+)"/g)].map((m) => m[1]));
    const used = [...HTML.matchAll(/<use href="#(i-[a-z-]+)"/g)].map((m) => m[1]);
    for (const n of ['i-stop', 'i-compact', 'i-clear', 'i-model', 'i-chev', 'i-rewind', 'i-end', 'i-shell']) assert.ok(symbols.has(n), n);
    assert.deepEqual(used.filter((n) => !symbols.has(n)), []);
  });

  test('(−) every id end-dialog.js looks up exists in the page', () => {
    const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const src = code(JS['end-dialog.js']);
    const used = [...src.matchAll(/getElementById\('([^']+)'\)|\bel\('([A-Za-z0-9-]+)'\)/g)].map((m) => m[1] ?? m[2]);
    assert.ok(used.length >= 6, 'the lookup scan found the ids');
    assert.deepEqual(used.filter((id) => !ids.has(id)), []);
  });

  test('(−) the End dialog shows fixed copy only: it never reads a message from the response', () => {
    const src = code(JS['end-dialog.js']);
    assert.doesNotMatch(src, /\.message\b/, 'the response has a message field; this file never reads it');
    assert.doesNotMatch(src, /(textContent|text:)[^;\n]*\bbody\b/, 'nothing from the response body becomes text');
    assert.match(src, /endOutcome/);
    assert.match(src, /cancel/);
    assert.match(src, /preventDefault/, 'Esc does nothing while it is ending');
    assert.match(src, /aria-busy/);
  });

  test('(+) 0.3.4: the End dialog\'s alert takes its kind from endOutcome (warn for the input-box refusals) and is a danger otherwise', () => {
    const src = code(JS['end-dialog.js']);
    assert.match(src, /function draw\(\{ alert = '', kind = 'danger',/);
    assert.match(src, /el\('end-alert'\)\.dataset\.kind = kind/);
    assert.match(src, /draw\(\{ alert: out\.text, kind: out\.kind, closeOnly: true \}\)/);
    assert.match(tag('end-alert'), /data-kind="danger"/, 'the markup default stays danger');
  });

  test('(+) the End dialog hands status, error code, ended and reason of the answer to endOutcome, and nothing else', () => {
    const src = code(JS['end-dialog.js']);
    assert.match(src, /answer = \{ status: res\.status, code: res\.body\?\.error, ended: res\.body\?\.ended, reason: res\.body\?\.reason \}/);
    assert.match(src, /endOutcome\(answer\)/);
    assert.match(src, /answer = \{ status: 0 \}/, 'a network failure still carries no reason');
  });

  test('(+) Compact, Clear and Model go through the command route only; Shell stays on the keys route', () => {
    const src = code(JS['session.js']);
    assert.match(src, /\/command`/);
    assert.match(src, /sendCommand\('\/compact'\)/);
    assert.match(src, /sendCommand\('\/clear'\)/);
    assert.match(src, /sendCommand\(`\/model \$\{/);
    assert.match(src, /planShell\(/);
    assert.match(src, /on\('rewind', \(\) => sendCommand\('\/rewind'\)\)/, 'Rewind is /rewind through the command route, like Compact');
    assert.doesNotMatch(src, /keys: \['Escape', 'Escape'\]|function rewind\(/, 'no Esc Esc and no separate rewind function any more');
    assert.doesNotMatch(src, /text: '\/(compact|clear|model|rewind)/, 'no command text goes through the keys route');
  });

  test('(+) a model is only sent from the Switch model button, never on a change event', () => {
    const src = code(JS['session.js']);
    assert.doesNotMatch(src, /model-sel['"]\)\.addEventListener\('change',[^)]*sendCommand/);
    const change = /addEventListener\('change',([\s\S]*?)\}\);/.exec(src)?.[1] ?? '';
    assert.doesNotMatch(change, /sendCommand/);
  });

  test('(−) the new modules never spell the refused mode (test/ui.test.js allows that only in modes.js)', () => {
    for (const f of ['session.js', 'quick-actions.js', 'models-ui.js', 'end-dialog.js', 'palette.js']) assert.doesNotMatch(JS[f], new RegExp(['bypass', 'Permissions'].join('')), f);
  });

  test('(+) the prompt panel, quick actions and dialogs have styles: qa row, reason line, prompt buttons, dialog, toast', () => {
    // dialog, alert and toast rules are shared with the dashboard and live once, in tokens.css (test/ui.test.js pins that)
    const css = strip(CSS);
    for (const sel of ['\\.qa', '\\.qa-why', '\\.ask', '\\.pbtn', '\\.pbtn-off', '\\.pbtn\\[aria-disabled="true"\\]', '\\.pop']) {
      assert.match(css, new RegExp(`(^|[\\s,}])${sel}[\\s,{:\\[]`), sel);
    }
    const shared = strip(TOKENS);
    for (const sel of ['dialog', 'dialog::backdrop', '\\.dlg-foot', '\\.alert\\[data-kind="danger"\\]', '\\.toast']) {
      assert.match(shared, new RegExp(`(^|[\\s,}])${sel}[\\s,{:\\[]`), sel);
    }
  });

  // -- fix round 1 (review of Task 10)
  const fn = (src, head) => {
    const at = src.indexOf(head);
    assert.ok(at >= 0, head);
    const end = src.indexOf('\n}\n', at);
    return src.slice(at, end + 2);
  };

  test('(+) Esc = No locks the question after a 200, like an answered option; a double click sends one Escape', () => {
    const src = code(JS['session.js']);
    const esc = fn(src, 'async function escNo()');
    assert.match(esc, /promptOff\(\{ pending: PA\.pending, lock: PA\.lock, sig: p\.sig \}\)/, 'refused while pending or locked');
    assert.match(esc, /PA\.pending = true;[\s\S]*await sendKey\('Escape'\)/, 'pending is set before the request, so a second click returns at once');
    assert.match(esc, /escOutcome\(\{ ok \}\)\.lock\) PA\.lock = p\.sig/, 'a 200 keeps the buttons off for this sig');
    assert.match(fn(src, 'async function sendKey('), /return r\.ok/, 'sendKey reports whether the keys route answered 200');
    assert.match(fn(src, 'async function answer('), /promptOff\(/, 'the option buttons use the same rule');
    const render = fn(src, 'function renderPrompt()');
    assert.match(render, /promptOff\(\{ pending: PA\.pending, lock: PA\.lock, sig: p\.sig \}\)/);
    assert.match(render, /for \(const b of \[\.\.\.PA\.btns, PA\.esc\]\) b\.setAttribute\('aria-disabled'/, 'Esc = No is switched off with the option buttons');
  });

  test('(+) the End dialog keeps its body text when the alert shows (aria-describedby must not point at a hidden node)', () => {
    assert.doesNotMatch(code(JS['end-dialog.js']), /end-d'\)\.hidden/);
    assert.match(tag('end-dlg'), /aria-describedby="end-d"/);
    assert.doesNotMatch(tag('end-d'), /\bhidden\b/);
  });

  test('(+) the model popover closing under focus (Claude turns busy or asks) hands focus to the Model button', () => {
    const quick = fn(code(JS['session.js']), 'function renderQuick()');
    assert.match(quick, /closeModelPop\(\$\('model-pop'\)\.contains\(document\.activeElement\)\)/);
    assert.match(fn(code(JS['session.js']), 'function closeModelPop('), /if \(refocus\) Q\.b\.model\.focus\(\)/);
  });

  test('(+) rebuilding the prompt buttons for a new sig moves focus from the old panel to the question text, never an option', () => {
    const render = fn(code(JS['session.js']), 'function renderPrompt()');
    assert.match(render, /if \(p\.sig !== PA\.sig\) \{[\s\S]*const focused = panel\.contains\(document\.activeElement\);[\s\S]*buildPrompt\(p\);[\s\S]*if \(focused\) \$\('ask-q'\)\.focus\(/);
    assert.match(tag('ask-q'), /\btabindex="-1"/, 'focusable by script only, not in the Tab order');
  });

  test('(−) a rebuilt prompt never hands focus to an option button, so a held or double Enter cannot answer an unseen question', () => {
    const render = fn(code(JS['session.js']), 'function renderPrompt()');
    assert.doesNotMatch(render, /PA\.btns\[\d+\][^;]*\.focus\(/);
  });

  test('(+) the gates read promptOpen (any prompt in the capture); only the panel reads the cleaned prompt', () => {
    const src = code(JS['session.js']);
    assert.match(src, /W\.promptOpen = Boolean\(body\.prompt\)/);
    assert.equal((src.match(/switcherState\(\{[^}]*prompt: W\.promptOpen/g) ?? []).length, 2, 'renderMode and switchTo');
    assert.match(src, /quickState\(\{[^}]*prompt: W\.promptOpen/);
    assert.match(fn(src, 'function openEnd()'), /promptOpen: W\.promptOpen \|\| A\.kind === 'attn'/);
    const wire = fn(src, 'function wireComposer()');
    assert.match(wire, /composerKey\(e, \{/);
    assert.match(wire, /status: A\.kind, promptOpen: W\.promptOpen,/, 'the message box keys read the same gate inputs as Send');
    assert.match(wire, /buttons: \(W\.pane === 'ok' && hasAnswerButtons\(W\.prompt\)\) \|\| DF\?\.live\(\) === true, bypass: W\.prompt\?\.bypass === true/, 'the same wording input as Send (P5): a live dialog form counts as buttons');
    assert.doesNotMatch(wire, /sendGate/, 'wireComposer holds no gate of its own: composerKey does');
    assert.doesNotMatch(src, /renderGatedKeys/);
    assert.match(fn(src, 'async function sendComposer()'), /sendGate\(\{ promptOpen: W\.promptOpen, status: A\.kind, buttons: \(W\.pane === 'ok' && hasAnswerButtons\(W\.prompt\)\) \|\| DF\?\.live\(\) === true, bypass: W\.prompt\?\.bypass === true \}\)/, 'the wording reads the panel and the capture\'s bypass mark; whether it is held does not');
    assert.doesNotMatch(src, /(switcherState|quickState)\(\{[^}]*prompt: W\.prompt\b/, 'no gate reads the cleaned prompt');
    assert.match(fn(src, 'function renderPrompt()'), /W\.prompt/, 'the panel does');
  });

  test('(+) roveKeys only moves focus: arrows, Home and End never click, and Enter or Space are left to the button', () => {
    const src = fn(JS['session.js'], 'function roveKeys(bar, buttons)');
    assert.doesNotMatch(code(src), /\.click\(|dispatchEvent|requestSubmit/);
    const log = [];
    const list = ['a', 'b', 'c'].map((name) => ({ name, focus() { doc.activeElement = this; log.push(`focus ${name}`); }, click() { log.push(`click ${name}`); } }));
    const doc = { activeElement: list[1] };
    let handler;
    const bar = { addEventListener: (type, fn2) => { if (type === 'keydown') handler = fn2; } };
    vm.runInNewContext(`${src}; roveKeys`, { document: doc })(bar, () => list);
    const press = (key, more = {}) => {
      const e = { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...more };
      handler(e);
      return e.defaultPrevented;
    };
    assert.equal(press('ArrowRight'), true);
    assert.equal(doc.activeElement.name, 'c');
    press('ArrowRight');
    assert.equal(doc.activeElement.name, 'a', 'wraps');
    press('ArrowLeft');
    assert.equal(doc.activeElement.name, 'c', 'wraps back');
    press('Home');
    assert.equal(doc.activeElement.name, 'a');
    press('End');
    assert.equal(doc.activeElement.name, 'c');
    const before = log.length;
    for (const key of ['Enter', ' ', 'Tab', 'a']) assert.equal(press(key), false, `${JSON.stringify(key)} is not handled`);
    assert.equal(press('ArrowLeft', { shiftKey: true }), false, 'a modified arrow is not handled');
    assert.equal(log.length, before, 'no focus change for the keys it does not handle');
    assert.deepEqual(log.filter((l) => l.startsWith('click')), [], 'nothing was ever clicked');
  });
});

describe('command palette wiring (spec 9.7, Task 11)', () => {
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';
  const src = code(JS['session.js']);
  const css = strip(CSS);
  const fnOf = (head) => {
    const at = src.indexOf(head);
    assert.ok(at >= 0, head);
    return src.slice(at, src.indexOf('\n}\n', at) + 2);
  };

  test('(+) the textarea controls #palette and has no active descendant until an option is active', () => {
    const ta = tag('composer');
    assert.match(ta, /\baria-controls="palette"/);
    assert.doesNotMatch(ta, /aria-activedescendant/);
  });

  test('(+) #palette is a listbox labelled Commands inside the hidden #pal, with a count, a key-hint row and a note line', () => {
    assert.match(tag('palette'), /^<ul\b[^>]*\brole="listbox"[^>]*\baria-label="Commands"/);
    assert.match(tag('pal'), /\bclass="pal"[^>]*\bhidden\b|\bhidden\b[^>]*\bclass="pal"/);
    assert.match(tag('pal-note'), /\bhidden\b/);
    assert.match(tag('pal-count'), /\bclass="muted"/);
    assert.ok(HTML.indexOf('id="pal"') < HTML.indexOf('id="palette"'));
    assert.match(HTML, /<span class="pal-k">[\s\S]*Enter<\/kbd> insert[\s\S]*Esc<\/kbd> close/);
  });

  test('(+) the Commands button: ghost icon button with the i-cmd icon, named "Commands (/)", between the paste chip and Send', () => {
    const b = /<button\b[^>]*\bid="cmd-btn"[^>]*>[\s\S]*?<\/button>/.exec(HTML)?.[0] ?? '';
    assert.match(b, /^<button type="button" class="btn ghost icon"/);
    assert.match(b, /\baria-label="Commands \(\/\)"/);
    assert.match(b, /<use href="#i-cmd"\/>/);
    assert.ok(HTML.indexOf('id="paste-chip"') < HTML.indexOf('id="cmd-btn"') && HTML.indexOf('id="cmd-btn"') < HTML.indexOf('id="send"'));
  });

  test('(+) the palette sits inside the message box (it opens upward from it); the sprite draws i-cmd and i-dialog', () => {
    const box = HTML.slice(HTML.indexOf('<div class="inbox">'), HTML.indexOf('<div class="mode-row"'));
    assert.ok(box.includes('id="pal"') && box.includes('id="palette"'));
    for (const n of ['i-cmd', 'i-dialog']) assert.match(HTML, new RegExp(`<symbol id="${n}"`));
  });

  test('(−) F7: the markup has no tip and no hint line; the notes row holds a hidden argument hint, the shell hint, the problem line and the echo', () => {
    assert.doesNotMatch(HTML, /class="tip"|class="tip more"|hintline/);
    assert.match(HTML, /<div class="notes quiet" id="notes">/);
    assert.match(tag('arg-hint'), /\bhidden\b/);
    assert.ok(HTML.indexOf('id="notes"') < HTML.indexOf('id="arg-hint"'));
    const order = ['id="arg-hint"', 'id="shell-hint"', 'id="problem"', 'id="echo"'].map((n) => HTML.indexOf(n));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the hints, the problem line, then the echo');
  });

  test('(+) the palette styles: anchored to the box, opens upward, 360 px list, active row = accent-soft + 3 px accent edge, no :has()/color-mix()', () => {
    assert.match(css, /\.inbox\s*\{[^}]*position:\s*relative/);
    assert.match(css, /\.pal\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100% \+ \d+px\)[^}]*box-shadow:\s*var\(--elev-2\)/);
    assert.match(css, /\.pal\s*\{[^}]*border:\s*1px solid var\(--line-strong\)[^}]*border-radius:\s*var\(--r-md\)/);
    assert.match(css, /\.pal-l\s*\{[^}]*max-height:\s*min\(360px, \d+vh\)[^}]*overflow:\s*auto/);
    assert.match(css, /\.pal-o\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--accent-soft\)[^}]*border-left-color:\s*var\(--accent\)/);
    assert.match(css, /\.pal-o\s*\{[^}]*border-left:\s*3px solid transparent/);
    assert.match(css, /\.pal-dlg\s*\{[^}]*color:\s*var\(--idle\)[^}]*font-weight:\s*600/);
    assert.match(css, /\.btn\.ghost\s*\{/);
    for (const sel of ['\\.pal-h', '\\.pal-k', '\\.pal-n', '\\.pal-a', '\\.pal-s', '\\.pal-d', '\\.pal-note']) assert.match(css, new RegExp(`(^|[\\s,}])${sel}[\\s,{:\\[]`), sel);
  });

  // The keydown handler runs for real against stubs, and with the real composerKey, so the key rules are proven, not just spelled.
  // `state`: PL (the palette), pop (the model popover), value (the box text), status (A.kind), promptOpen, pane, switching, selection.
  // press.ends: how many times the arrow run was ended before the action (endArrows), for the last press.
  const press = (state, event) => {
    const calls = [];
    let ends = 0;
    const ta = { value: state.value ?? '', selectionStart: 0, selectionEnd: state.selection ? 3 : 0, addEventListener(type, f) { if (type === 'keydown') this.keydown = f; } };
    const ctx = {
      composer: () => ta, $: (id) => ({ addEventListener() {}, focus() { calls.push(`focus ${id}`); } }), document: { querySelectorAll: () => [] },
      PL: state.PL ?? { open: false, active: -1, shown: [] }, Q: { pop: state.pop === true }, S: { on: false }, SW: { busy: state.switching ? 'plan' : null },
      W: { pane: state.pane ?? 'ok', promptOpen: state.promptOpen === true, prompt: null, dialog: state.dialog === true ? {} : null }, A: { kind: state.status ?? 'idle' }, DF: state.form ?? null,
      composerKey: composerKeyReal, hasAnswerButtons: hasAnswerButtonsReal, moveActive: moveActiveReal,
      grow() {}, updateChip() {}, wirePalette() {}, setPass: () => calls.push('pass'),
      sendComposer: () => calls.push('send'), sendKey: (k) => calls.push(`key ${k}`), closeModelPop: (r) => calls.push(`model ${r}`),
      closePalette: () => calls.push('palette'), insertActive: () => calls.push('insert'), setActive: (i) => calls.push(`active ${i}`),
      queueArrow: (k, repeat) => calls.push(`arrow ${k}${repeat ? ' repeat' : ''}`), endArrows: () => { ends += 1; return state.arrows === true; }, chain: state.chain ?? Promise.resolve(), stop: () => calls.push('stop'),
      showProblem: (m, kind, ms) => calls.push(`problem ${m} | ${kind} | ${ms}`),
      suggestionNow: () => state.suggestion ?? null, acceptSuggestion: (t) => calls.push(`accept ${t}`),
    };
    vm.runInNewContext(`${fnOf('function wireComposer()')}; wireComposer`, ctx)();
    const e = { key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    ta.keydown(e);
    press.ends = ends;
    return { calls, prevented: e.defaultPrevented };
  };
  const OPEN = (active, n = 3) => ({ PL: { open: true, active, shown: Array.from({ length: n }, () => ({})) } });
  const CLOSED = { PL: { open: false, active: -1, shown: [] } };

  test('(+) Enter or Tab with an active option inserts it and sends nothing; the arrows move it without wrapping', () => {
    assert.deepEqual(press(OPEN(0), { key: 'Enter' }), { calls: ['insert'], prevented: true });
    assert.deepEqual(press(OPEN(1), { key: 'Tab' }), { calls: ['insert'], prevented: true });
    assert.deepEqual(press(OPEN(0), { key: 'ArrowDown' }), { calls: ['active 1'], prevented: true });
    assert.deepEqual(press(OPEN(2), { key: 'ArrowDown' }), { calls: ['active 2'], prevented: true }, 'no wrap at the end');
    assert.deepEqual(press(OPEN(0), { key: 'ArrowUp' }), { calls: ['active 0'], prevented: true }, 'no wrap at the start');
  });

  test('(−) Enter with no active option (closed, empty list, loading, error) sends the text as typed', () => {
    assert.deepEqual(press(CLOSED, { key: 'Enter' }), { calls: ['send'], prevented: true });
    assert.deepEqual(press({ PL: { open: true, active: -1, shown: [] } }, { key: 'Enter' }), { calls: ['send'], prevented: true });
  });

  test('(−) with no active option Tab moves focus and the arrows move the caret (text in the box); an empty box sends the arrows to the pane (0.3.3)', () => {
    for (const state of [CLOSED, { PL: { open: true, active: -1, shown: [] } }]) {
      assert.deepEqual(press(state, { key: 'Tab' }), { calls: [], prevented: false }, 'Tab');
      for (const key of ['ArrowDown', 'ArrowUp']) assert.deepEqual(press({ ...state, value: 'abc' }, { key }), { calls: [], prevented: false }, key);
      assert.deepEqual(press(state, { key: 'ArrowDown' }), { calls: ['arrow Down'], prevented: true }, 'empty box');
    }
  });

  test('(−) Shift+Enter is a new line, not the palette\'s; Shift+Tab with the list open goes to Claude as BTab (0.3.3), not into the list', () => {
    assert.deepEqual(press(OPEN(0), { key: 'Enter', shiftKey: true }), { calls: [], prevented: false });
    assert.deepEqual(press(OPEN(0), { key: 'Tab', shiftKey: true }), { calls: ['key BTab'], prevented: true });
  });

  test('(+) Shift+Tab in the box while a dialog form is live names the buttons above, as Send does (P5), and sends no key', () => {
    const gate = 'Answer the prompt with the buttons above or in the terminal.';
    const r = press({ promptOpen: true, status: 'attn', form: { live: () => true } }, { key: 'Tab', shiftKey: true });
    assert.deepEqual(r, { calls: [`problem ${gate} | error | 0`], prevented: true });
  });

  test('(−) Shift+Tab while a dialog is open but no form is live (unreadable, terminal only, no form built) says the terminal wording, never BTab', () => {
    const wording = 'Answer the prompt in the terminal, or turn on Type into pane.';
    for (const form of [null, { live: () => false }]) {
      const r = press({ promptOpen: true, status: 'attn', form }, { key: 'Tab', shiftKey: true });
      assert.deepEqual(r, { calls: [`problem ${wording} | error | 0`], prevented: true }, JSON.stringify(form));
    }
  });

  test('(−) with no dialog open, a live-looking form changes nothing: Shift+Tab is BTab as before', () => {
    assert.deepEqual(press({ promptOpen: false, status: 'idle', form: { live: () => true } }, { key: 'Tab', shiftKey: true }), { calls: ['key BTab'], prevented: true });
  });

  test('(−) keys during IME composition are left alone', () => {
    assert.deepEqual(press(OPEN(0), { key: 'Enter', isComposing: true }), { calls: [], prevented: false });
    assert.deepEqual(press(OPEN(0), { key: 'ArrowDown', keyCode: 229 }), { calls: [], prevented: false });
  });

  test('(+) the Esc ladder: model popover first, then the palette, then the pane', () => {
    assert.deepEqual(press({ ...OPEN(0), pop: true }, { key: 'Escape' }).calls, ['model true']);
    assert.deepEqual(press(OPEN(0), { key: 'Escape' }).calls, ['palette']);
    assert.deepEqual(press({ PL: { open: true, active: -1, shown: [] } }, { key: 'Escape' }).calls, ['palette'], 'an open list with no option closes too');
    assert.deepEqual(press(CLOSED, { key: 'Escape' }).calls, ['key Escape']);
    const wire = fnOf('function wireComposer()');
    assert.match(wire, /a\.act === 'close-pop'\) closeModelPop\(true\)/);
    assert.match(wire, /a\.act === 'close-palette'\) closePalette\(\)/);
    assert.match(wire, /a\.act === 'key'\) sendKey\(a\.key\)/);
  });

  test('(+) Ctrl+C right after arrows waits for them: Stop runs only once the queue ahead of it is done', async () => {
    let release;
    const chain = new Promise((resolve) => { release = resolve; });
    const r = press({ status: 'busy', arrows: true, chain }, { key: 'c', ctrlKey: true });
    assert.equal(press.ends, 1, 'the run was ended first');
    await Promise.resolve();
    assert.deepEqual(r.calls, [], 'the arrow request is still in flight: no Stop yet');
    release();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(r.calls, ['stop']);
  });

  test('(−) Ctrl+C with no arrows pending stops at once: Stop is not on the queue', () => {
    assert.deepEqual(press({ status: 'busy', chain: new Promise(() => {}) }, { key: 'c', ctrlKey: true }).calls, ['stop'], 'not even a stuck queue holds it');
  });

  test('(+) closing keeps the text: Esc and closePalette never write the box', () => {
    assert.doesNotMatch(fnOf('function closePalette()'), /\.value\s*=[^=]/);
    const wire = fnOf('function wireComposer()');
    const keydown = wire.slice(wire.indexOf("addEventListener('keydown'"), wire.indexOf("$('paste-clear')"));
    assert.ok(keydown.length > 200, 'the keydown handler was found');
    assert.doesNotMatch(keydown, /\.value\s*=[^=]/, 'no key in the box writes the text');
  });

  test('(+) Shell never opens it: syncPalette closes on Shell, turning Shell on closes it, the button follows Shell', () => {
    assert.match(fnOf('function syncPalette()'), /S\.on \|\| composer\(\)\.disabled \? null : paletteQuery\(composer\(\)\.value\)/);
    assert.match(fnOf('function setShell(on)'), /if \(on\) closePalette\(\)/);
    assert.match(fnOf('function renderCmdBtn()'), /commandsButton\(\{ shell: S\.on, empty: composer\(\)\.value === '' \}\)/);
    assert.match(fnOf('function setShell(on)'), /renderCmdBtn\(\)/);
  });

  test('(+) every change of the box text re-evaluates the palette (input, send, clear, insert), so a sent or cleared box closes it', () => {
    const chip = fnOf('function updateChip()');
    assert.match(chip, /syncPalette\(\)/);
    assert.match(chip, /renderCmdBtn\(\)/);
    assert.match(chip, /renderArgHint\(\)/);
  });

  test('(+) the Commands button: empty box inserts "/" and opens; aria-disabled does nothing; the mouse keeps focus in the box', () => {
    const wired = fnOf('function wirePalette()');
    assert.match(wired, /btn\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/);
    assert.match(wired, /if \(aria\(btn\)\) return;/, 'aria-disabled: nothing happens');
    assert.match(wired, /ta\.value = '\/';[\s\S]*updateChip\(\);[\s\S]*ta\.focus\(\)/);
    assert.match(wired, /\$\('pal'\)\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/, 'a click in the list does not blur the box');
    assert.match(wired, /ta\.addEventListener\('blur', closePalette\)/);
  });

  test('(+) the Commands button joins the controls disabled with the pane, and a disabled box closes the palette', () => {
    const set = fnOf('function setInputEnabled(');
    assert.match(set, /const controls = \[[^\]]*\$\('cmd-btn'\)/);
    assert.match(set, /if \(!on\) closePalette\(\)/);
  });

  test('(+) fetch: GET /api/app/commands (project key only when there is one), at open, one at a time, refresh after 10 s', () => {
    assert.match(src, /\/api\/app\/commands\$\{on \? `\?project=\$\{projectKey\}` : ''\}/, 'the project key only when asked for');
    const load = fnOf('async function loadCommands()');
    assert.match(load, /if \(PL\.busy\) return;\s*PL\.busy = true;/);
    assert.match(load, /Array\.isArray\(r\.body\?\.commands\)/);
    assert.match(load, /cleanCommands\(r\.body\.commands\)/);
    const sync = fnOf('function syncPalette()');
    assert.match(sync, /if \(!PL\.open\) \{[\s\S]*shouldFetch\(\{ loadedAt: PL\.at, now: Date\.now\(\), busy: PL\.busy \}\)\) loadCommands\(\)/);
    assert.equal((src.match(/loadCommands\(\)/g) ?? []).length, 2, 'declared once, called once (from the open path)');
  });

  // -- fix round 1 (review of Task 11)
  test('(+) a repeated Enter (the key held down) does nothing, on the insert path and on the send path', () => {
    assert.deepEqual(press(OPEN(0), { key: 'Enter', repeat: true }), { calls: [], prevented: true }, 'a held Enter never inserts a second time');
    assert.deepEqual(press(CLOSED, { key: 'Enter', repeat: true }), { calls: [], prevented: true }, 'and never sends what the first one inserted');
    assert.deepEqual(press({ PL: { open: true, active: -1, shown: [] } }, { key: 'Enter', repeat: true }), { calls: [], prevented: true });
    assert.deepEqual(press(CLOSED, { key: 'Enter', ctrlKey: true, repeat: true }), { calls: [], prevented: true }, 'a held Ctrl+Enter too');
  });

  test('(−) the first Enter (repeat false) still inserts the active option, and still sends when there is none', () => {
    assert.deepEqual(press(OPEN(0), { key: 'Enter', repeat: false }), { calls: ['insert'], prevented: true });
    assert.deepEqual(press(CLOSED, { key: 'Enter', repeat: false }), { calls: ['send'], prevented: true });
  });

  test('(+) only a bare Enter inserts: Ctrl, Cmd or Alt+Enter keep the send path they had before the palette', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      assert.deepEqual(press(OPEN(0), { key: 'Enter', ...mods }), { calls: ['send'], prevented: true }, JSON.stringify(mods));
    }
    assert.deepEqual(press(OPEN(0), { key: 'Enter' }), { calls: ['insert'], prevented: true }, 'bare Enter inserts');
  });

  // -- 0.3.3: Esc, Ctrl+C, Shift+Tab, the arrows and Enter from the message box (the rules: composerKey, tested in quick-actions.test.js)
  test('(+) 0.3.3: Esc, Shift+Tab and Enter go to Claude from the box; the arrow run ends first, once, before each of them', () => {
    assert.deepEqual(press(CLOSED, { key: 'Escape' }), { calls: ['key Escape'], prevented: true });
    assert.equal(press.ends, 1);
    assert.deepEqual(press(CLOSED, { key: 'Tab', shiftKey: true }), { calls: ['key BTab'], prevented: true });
    assert.equal(press.ends, 1);
    assert.deepEqual(press(CLOSED, { key: 'Enter' }), { calls: ['send'], prevented: true });
    assert.equal(press.ends, 1);
  });

  test('(+) 0.3.3: arrows from an empty box are queued (a repeat is marked as one) and do not end the run', () => {
    assert.deepEqual(press(CLOSED, { key: 'ArrowDown' }), { calls: ['arrow Down'], prevented: true });
    assert.equal(press.ends, 0);
    assert.deepEqual(press(CLOSED, { key: 'ArrowLeft', repeat: true }), { calls: ['arrow Left repeat'], prevented: true });
  });

  test('(−) 0.3.3: keys that stay the browser\'s are not prevented and do not end the run: letters, Tab, arrows over text, a copy', () => {
    for (const [state, event] of [[CLOSED, { key: 'a' }], [CLOSED, { key: 'Tab' }], [{ ...CLOSED, value: 'hi' }, { key: 'ArrowUp' }], [{ ...CLOSED, status: 'busy', selection: true }, { key: 'c', ctrlKey: true }], [CLOSED, { key: 'Enter', shiftKey: true }]]) {
      assert.deepEqual(press(state, event), { calls: [], prevented: false }, JSON.stringify(event));
      assert.equal(press.ends, 0);
    }
  });

  test('(−) F2: the native editing keys stay the browser\'s in the message box on both platforms: cut, paste, select all, undo, redo, and a copy with a selection', () => {
    const editing = [
      { key: 'x', ctrlKey: true }, { key: 'v', ctrlKey: true }, { key: 'a', ctrlKey: true }, { key: 'z', ctrlKey: true }, { key: 'Z', ctrlKey: true, shiftKey: true }, { key: 'y', ctrlKey: true },
      { key: 'V', ctrlKey: true, shiftKey: true },
      { key: 'x', metaKey: true }, { key: 'c', metaKey: true }, { key: 'v', metaKey: true }, { key: 'a', metaKey: true }, { key: 'z', metaKey: true }, { key: 'Z', metaKey: true, shiftKey: true },
    ];
    for (const event of editing) assert.deepEqual(press({ ...CLOSED, value: 'hello' }, event), { calls: [], prevented: false }, JSON.stringify(event));
    for (const status of ['busy', 'idle', 'attn']) {
      for (const event of [{ key: 'c', ctrlKey: true }, { key: 'C', ctrlKey: true, shiftKey: true }]) {
        assert.deepEqual(press({ ...CLOSED, value: 'hello', status, selection: true }, event), { calls: [], prevented: false }, `${JSON.stringify(event)} with a selection, ${status}`);
      }
    }
    assert.equal(press.ends, 0);
  });

  test('(+) 0.3.3: Ctrl+C while Claude works runs Stop (the stop route, not a key); it is not queued as C-c', () => {
    assert.deepEqual(press({ ...CLOSED, status: 'busy' }, { key: 'c', ctrlKey: true }), { calls: ['stop'], prevented: true });
    assert.equal(press.ends, 1);
  });

  test('(−) 0.3.3: Ctrl+C while Claude waits, asks or connects sends nothing and says why for 3 s', () => {
    const line = (m) => ({ calls: [`problem ${m} | warn | 3000`], prevented: true });
    assert.deepEqual(press({ ...CLOSED, status: 'idle' }, { key: 'c', ctrlKey: true }), line('Nothing to stop: Claude is waiting.'));
    assert.deepEqual(press({ ...CLOSED, status: 'attn' }, { key: 'c', ctrlKey: true }), line('Answer the prompt first.'));
    assert.deepEqual(press({ ...CLOSED, status: 'busy', promptOpen: true }, { key: 'c', ctrlKey: true }), line('Answer the prompt first. Esc = No is in the prompt panel.'));
    assert.deepEqual(press({ ...CLOSED, status: 'busy', promptOpen: true, dialog: true }, { key: 'c', ctrlKey: true }), line('Answer the question above first.'), 'F3: W.dialog reaches composerKey; a question form has no No');
    assert.deepEqual(press({ ...CLOSED, status: 'busy', pane: 'connecting' }, { key: 'c', ctrlKey: true }), line('Connecting to the pane\u2026'));
  });

  test('(−) 0.3.3: Shift+Tab is refused with the Send gate lines while a prompt is held, and while this window switches the mode', () => {
    assert.deepEqual(press({ ...CLOSED, promptOpen: true }, { key: 'Tab', shiftKey: true }), { calls: ['problem Answer the prompt in the terminal, or turn on Type into pane. | error | 0'], prevented: true });
    assert.deepEqual(press({ ...CLOSED, switching: true }, { key: 'Tab', shiftKey: true }), { calls: ['problem Wait for the mode switch to finish. | warn | 3000'], prevented: true });
  });

  test('(−) 0.3.3: Esc still goes through while a prompt is held (the No path); a held Esc, Ctrl+C or Shift+Tab sends once', () => {
    assert.deepEqual(press({ ...CLOSED, promptOpen: true, status: 'attn' }, { key: 'Escape' }), { calls: ['key Escape'], prevented: true });
    for (const event of [{ key: 'Escape' }, { key: 'Tab', shiftKey: true }, { key: 'c', ctrlKey: true }]) {
      assert.deepEqual(press({ ...CLOSED, status: 'busy' }, { ...event, repeat: true }), { calls: [], prevented: true }, JSON.stringify(event));
      assert.equal(press.ends, 1, 'the run still ends');
    }
  });

  test('(+) 0.3.3: Ctrl+Shift+Tab moves focus to the Shell toggle, Ctrl+] enters passthrough', () => {
    assert.deepEqual(press(CLOSED, { key: 'Tab', ctrlKey: true, shiftKey: true }), { calls: ['focus shell-toggle'], prevented: true });
    assert.deepEqual(press(CLOSED, { key: ']', ctrlKey: true }), { calls: ['pass'], prevented: true });
  });

  // loadCommands and the focus rule run for real against stubs
  const load = async ({ projectKey, answers, pl = {} }) => {
    const paths = [];
    const PL = { open: false, list: null, failed: false, at: null, busy: false, shown: [], active: -1, noProject: false, ...pl };
    const ctx = { PL, projectKey, call: async (path) => { paths.push(path); return answers.shift() ?? { status: 500, body: null }; }, cleanCommands: cleanCommandsReal, renderPalette() {}, Date };
    await vm.runInNewContext(`${fnOf('async function loadCommands()')}; loadCommands`, ctx)();
    return { paths, PL };
  };
  const KEY = 'projectkey000000';
  const ONE = { status: 200, body: { commands: [{ name: 'compact', description: 'x', argHint: '', source: 'builtin' }] } };

  test('(+) a 404 for the project key retries once without it and uses that list; later loads skip the project query', async () => {
    const r = await load({ projectKey: KEY, answers: [{ status: 404, body: { error: 'not_found' } }, ONE] });
    assert.deepEqual(r.paths, [`/api/app/commands?project=${KEY}`, '/api/app/commands']);
    assert.equal(r.PL.list.length, 1);
    assert.equal(r.PL.failed, false);
    assert.equal(r.PL.noProject, true);
    const again = await load({ projectKey: KEY, answers: [ONE], pl: { noProject: true } });
    assert.deepEqual(again.paths, ['/api/app/commands'], 'the fallback is remembered for the window');
  });

  test('(+) a normal answer asks with the project key, once', async () => {
    const r = await load({ projectKey: KEY, answers: [ONE] });
    assert.deepEqual(r.paths, [`/api/app/commands?project=${KEY}`]);
    assert.equal(r.PL.noProject, false);
  });

  test('(−) any other failure makes no second call and keeps the error copy path (failed first load)', async () => {
    for (const status of [500, 403, 0, 400]) {
      const r = await load({ projectKey: KEY, answers: [{ status, body: null }, ONE] });
      assert.equal(r.paths.length, 1, String(status));
      assert.equal(r.PL.failed, true, String(status));
      assert.equal(r.PL.list, null);
      assert.equal(r.PL.noProject, false);
    }
  });

  test('(−) no project key: a 404 is not retried; a 404 on the retry is the error state and does not loop', async () => {
    const none = await load({ projectKey: null, answers: [{ status: 404, body: null }, ONE] });
    assert.deepEqual(none.paths, ['/api/app/commands']);
    assert.equal(none.PL.failed, true);
    const twice = await load({ projectKey: KEY, answers: [{ status: 404, body: null }, { status: 404, body: null }, ONE] });
    assert.equal(twice.paths.length, 2);
    assert.equal(twice.PL.failed, true);
  });

  const focusRig = ({ shell = false, value = '/co' } = {}) => {
    const calls = [];
    const listeners = {};
    const PL = { open: false, said: null, busy: false, at: null };
    const ta = { value, disabled: false, addEventListener(type, f) { listeners[type] = f; } };
    const el = () => ({ addEventListener() {}, hidden: true });
    const ctx = {
      PL, S: { on: shell }, composer: () => ta, $: el, aria: () => false, paletteQuery: paletteQueryReal, shouldFetch: shouldFetchReal, Date, renderCmdBtn() {},
      loadCommands: () => calls.push('load'), renderPalette: () => calls.push('render'), closePalette: () => calls.push('close'),
    };
    vm.runInNewContext(`${fnOf('function syncPalette()')}\n${fnOf('function wirePalette()')}; wirePalette`, ctx)();
    return { calls, listeners, PL };
  };

  test('(+) the box regaining focus with a command query reopens the palette', () => {
    assert.match(fnOf('function wirePalette()'), /ta\.addEventListener\('focus', syncPalette\)/);
    const r = focusRig({ value: '/co' });
    r.listeners.focus();
    assert.equal(r.PL.open, true);
    assert.deepEqual(r.calls, ['load', 'render']);
  });

  test('(−) it does not reopen with Shell on, nor for text that is not a command query', () => {
    const shell = focusRig({ shell: true });
    shell.listeners.focus();
    assert.equal(shell.PL.open, false);
    assert.deepEqual(shell.calls, ['close']);
    for (const value of ['hello', '', '/compact x']) {
      const r = focusRig({ value });
      r.listeners.focus();
      assert.equal(r.PL.open, false, value);
      assert.deepEqual(r.calls, ['close'], value);
    }
  });

  test('(+) options: role=option with aria-selected, id for aria-activedescendant, a click inserts, all text through textContent', () => {
    const opt = fnOf('function optionEl(');
    assert.match(opt, /role: 'option'/);
    assert.match(opt, /'aria-selected': 'false'/);
    assert.match(opt, /onclick: /);
    assert.match(opt, /icon\('dialog'\)/);
    assert.match(opt, /Opens a dialog in the terminal/);
    assert.match(opt, /sourceLabel\(c\)/);
    assert.match(opt, /title: c\.description/, 'the full description is in the title');
    assert.doesNotMatch(opt, /\bhtml\b/i);
  });

  test('(+) aria-activedescendant exists only while an option is active', () => {
    const set = fnOf('function setActive(');
    assert.match(set, /setAttribute\('aria-activedescendant', `pal-o-\$\{i\}`\)/);
    assert.match(set, /removeAttribute\('aria-activedescendant'\)/);
    assert.match(fnOf('function closePalette()'), /setActive\(-1\)/);
  });

  test('(+) the announcement is polite and debounced 400 ms, repeated only when the text changes, and dropped on close', () => {
    const say = fnOf('function sayPalette(');
    assert.match(say, /if \(msg === PL\.said\) return;/);
    assert.match(say, /setTimeout\(\(\) => announce\(msg\), 400\)/);
    assert.match(fnOf('function closePalette()'), /clearTimeout\(PL\.sayTimer\)/);
  });

  test('(+) choosing writes "/<name> " into the box, closes the list, keeps focus, and shows the argument hint', () => {
    const ins = fnOf('function insertActive()');
    assert.match(ins, /insertion\(c\)/);
    assert.match(ins, /ta\.value = ins\.text/);
    assert.match(ins, /ta\.focus\(\)/);
    assert.match(fnOf('function renderArgHint()'), /PL\.argFor/);
  });

  test('(−) palette.js is imported by name, and session.js never builds the command text by hand', () => {
    assert.match(JS['session.js'], /import \{[^}]*\bpaletteQuery\b[^}]*\} from '\.\/palette\.js';/);
    assert.doesNotMatch(src, /`\/\$\{c\.name\} `|'\/' \+ c\.name/);
  });
});

describe('Back button and Keyboard shortcuts window in the session window (spec 3.13, 4.6, Task 12b)', () => {
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';
  const src = JS['session.js'];
  const css = strip(CSS);
  const fn = (head) => {
    const at = src.indexOf(head);
    assert.ok(at >= 0, head);
    return src.slice(at, src.indexOf('\n}\n', at) + 2);
  };

  test('(+) the back link is a .back button: icon, then the project name (or Dashboard) in #proj', () => {
    assert.match(HTML, /<a class="back" id="back" href="\/#dashboard"><svg class="ic" aria-hidden="true"><use href="#i-back"\/><\/svg><span id="proj">Dashboard<\/span><\/a>/);
  });

  test('(−) no .crumb is left in the page or the stylesheet', () => {
    assert.doesNotMatch(HTML, /class="[^"]*\bcrumb\b/);
    assert.doesNotMatch(css, /\.crumb\b/);
    assert.doesNotMatch(css, /\.back\b/, '.back lives in tokens.css only');
    assert.match(strip(TOKENS), /\.back \{/);
  });

  test('(+) the Keyboard shortcuts button is the last control in the header: ghost icon button, i-kbd, label, title and aria-keyshortcuts', () => {
    const btn = tag('kbd-open');
    assert.match(btn, /^<button type="button" class="btn ghost icon"/);
    assert.match(btn, /aria-label="Keyboard shortcuts"/);
    assert.match(btn, /aria-keyshortcuts="[^"]+"/);
    assert.match(btn, /title="Keyboard shortcuts \(\?\)"/);
    assert.match(HTML, /<button\b[^>]*\bid="kbd-open"[^>]*><svg class="ic" aria-hidden="true"><use href="#i-kbd"\/><\/svg><\/button>/);
    const at = (needle) => HTML.indexOf(needle);
    assert.ok(at('id="claude-link"') < at('id="kbd-open"') && at('id="kbd-open"') < at('</header>'), 'after the claude.ai link, inside the header');
  });

  test('(+) #kbd-dlg is a native dialog with the heading, the window line, the body and the footer', () => {
    const dlg = /<dialog\b[^>]*\bid="kbd-dlg"[^>]*>[\s\S]*?<\/dialog>/.exec(HTML)?.[0] ?? '';
    assert.ok(dlg);
    assert.match(dlg, /<dialog\b[^>]*\bclass="dlg-kbd"/);
    assert.match(dlg, /\baria-labelledby="kbd-h"/);
    assert.match(dlg, /<h2 id="kbd-h" tabindex="-1">Keyboard shortcuts<\/h2>/);
    for (const id of ['kbd-sub', 'kbd-body', 'kbd-foot']) assert.match(dlg, new RegExp(`\\bid="${id}"`), id);
  });

  test('(+) the table styles for the window live once in tokens.css, where both pages see them', () => {
    const t = strip(TOKENS);
    for (const sel of ['dialog.dlg-kbd', 'dialog.dlg-kbd h2:focus', '.kbd-sec table', '.kbd-sec th', '.kbd-sec td', '.kbd-sec kbd', '.btn.link']) assert.ok(t.includes(sel), sel);
    assert.doesNotMatch(css, /dlg-kbd|kbd-sec/);
    assert.match(t, /\.kbd-sec kbd \{[^}]*font-size: var\(--fs-small\)/, 'mono 12 for keys');
  });

  test('(+) boot sets the Back hint, listens on the document and wires the button; the non-app page hides the button', () => {
    const boot = fn('function boot()');
    assert.match(boot, /setBack\('Dashboard'\)/);
    assert.match(boot, /document\.addEventListener\('keydown', onPageKey\)/);
    assert.match(boot, /\$\('kbd-open'\)\.addEventListener\('click', \(\) => openKbd\(\$\('kbd-open'\)\)\)/);
    const notApp = boot.slice(0, boot.indexOf('if (!sessionId && !paneId)'));
    assert.match(notApp, /\$\('kbd-open'\)\.hidden = true/);
    assert.ok(notApp.indexOf("$('kbd-open').hidden = true") < notApp.indexOf('return;'), 'before the early return');
  });

  test('(+) the poll sets the Back label through setBack, not a bare title', () => {
    assert.match(fn('function applyBackLabel('), /setBack\(String\(group\.label\)\)/);
    assert.match(fn('function applyAgent('), /applyBackLabel\(group\)/);
    assert.doesNotMatch(src, /\$\('back'\)\.title = String/);
  });

  test('(+) setBack puts the platform key in the title and aria-keyshortcuts', () => {
    const run = (mac) => {
      const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      vm.runInNewContext(`${fn('function setBack(label)')}; setBack('demo-api')`, { MAC: mac, backHint, $: () => el });
      return [el.title, el.attrs['aria-keyshortcuts']];
    };
    assert.deepEqual(run(false), ['Back to demo-api (Alt+←)', 'Alt+ArrowLeft']);
    assert.deepEqual(run(true), ['Back to demo-api (⌘[)', 'Meta+BracketLeft']);
  });

  test('(+) syncKbdHint names "?" while the setting is on and only Mod+/ when it is off', () => {
    const run = (singleKey) => {
      const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      vm.runInNewContext(`${fn('function syncKbdHint()')}; syncKbdHint()`, { MAC: false, UI: { singleKey }, helpHint, $: () => el });
      return [el.title, el.attrs['aria-keyshortcuts']];
    };
    assert.deepEqual(run(true), ['Keyboard shortcuts (?)', 'Shift+Slash Control+Slash']);
    assert.deepEqual(run(false), ['Keyboard shortcuts (Ctrl+/)', 'Control+Slash']);
  });

  // loadSettings reads GET /api/app/settings once: theme and ui.singleKeyShortcuts
  const loadRig = async (response) => {
    const themes = [];
    const ctx = { UI: { singleKey: true }, hints: 0, call: async () => response, applyTheme: (t) => themes.push(t), syncKbdHint() { ctx.hints += 1; } };
    await vm.runInNewContext(`${fn('async function loadSettings()')}; loadSettings`, ctx)();
    return { singleKey: ctx.UI.singleKey, themes, hints: ctx.hints };
  };

  test('(+) loadSettings reads ui.singleKeyShortcuts (false switches it off) and still applies the theme', async () => {
    assert.deepEqual(await loadRig({ status: 200, body: { ui: { theme: 'dark', singleKeyShortcuts: false } } }), { singleKey: false, themes: ['dark'], hints: 1 });
    assert.deepEqual(await loadRig({ status: 200, body: { ui: { theme: 'system', singleKeyShortcuts: true } } }), { singleKey: true, themes: ['system'], hints: 1 });
  });

  test('(−) a failed read, a missing field and a non-boolean leave the default: on', async () => {
    for (const response of [{ status: 0, body: null }, { status: 500, body: null }, { status: 200, body: { ui: { theme: 'dark' } } }, { status: 200, body: { ui: { singleKeyShortcuts: 'no' } } }, { status: 200, body: {} }]) {
      const r = await loadRig(response);
      assert.equal(r.singleKey, true, JSON.stringify(response));
      assert.equal(r.hints, 1, 'the hint is drawn either way');
    }
    assert.deepEqual((await loadRig({ status: 0, body: null })).themes, [], 'no theme change without an answer');
  });

  // onPageKey, run for real with the real rules from shortcuts.js
  const keys = ({ mac = false, singleKey = true, passthrough = false, dialog = false } = {}) => {
    const log = { opened: [], clicks: 0, prevented: 0, toggled: 0 };
    const ctx = {
      MAC: mac, UI: { singleKey }, P: { on: passthrough }, wantsHelp, wantsBack, wantsHistToggle, isTextEntry,
      openKbd: (opener) => log.opened.push(opener), toggleHist: () => { log.toggled += 1; },
      $: (id) => (id === 'back' ? { click() { log.clicks += 1; } } : null),
      document: { activeElement: { id: 'active' }, querySelector: (sel) => (sel === 'dialog[open]' && dialog ? {} : null) },
    };
    const onKey = vm.runInNewContext(`${fn('function onPageKey(e)')}; onPageKey`, ctx);
    return {
      log,
      press: (key, more = {}, target = { tagName: 'BUTTON' }) => {
        onKey({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, preventDefault() { log.prevented += 1; }, ...more });
        return log;
      },
    };
  };

  test('(+) "?" and Mod+/ open the window for the focused control and are consumed', () => {
    const k = keys();
    k.press('?', { shiftKey: true });
    k.press('/', { ctrlKey: true });
    assert.deepEqual(k.log.opened, [{ id: 'active' }, { id: 'active' }]);
    assert.equal(k.log.prevented, 2);
    const mac = keys({ mac: true });
    mac.press('/', { metaKey: true });
    assert.equal(mac.log.opened.length, 1);
  });

  test('(−) "?" is ignored in the message box, an input, a select and the terminal mirror (the key types or goes on)', () => {
    for (const target of [{ tagName: 'TEXTAREA' }, { tagName: 'INPUT' }, { tagName: 'SELECT' }, { tagName: 'DIV', closest: (s) => (s === '#term' ? {} : null) }]) {
      const k = keys();
      k.press('?', {}, target);
      assert.equal(k.log.opened.length, 0, target.tagName);
      assert.equal(k.log.prevented, 0, `${target.tagName}: the character is not swallowed`);
    }
  });

  test('(−) in passthrough "?" and Ctrl+/ (Linux) are ignored; Command+/ (macOS) still opens it', () => {
    const lin = keys({ passthrough: true });
    lin.press('?');
    lin.press('/', { ctrlKey: true });
    assert.equal(lin.log.opened.length, 0);
    const mac = keys({ passthrough: true, mac: true });
    mac.press('/', { metaKey: true });
    assert.equal(mac.log.opened.length, 1);
  });

  test('(−) with the setting off "?" is ignored and Mod+/ opens it; with a dialog open neither does', () => {
    const off = keys({ singleKey: false });
    off.press('?');
    assert.equal(off.log.opened.length, 0);
    off.press('/', { ctrlKey: true });
    assert.equal(off.log.opened.length, 1);
    const dlg = keys({ dialog: true });
    dlg.press('?');
    dlg.press('/', { ctrlKey: true });
    dlg.press('ArrowLeft', { altKey: true });
    assert.deepEqual([dlg.log.opened.length, dlg.log.clicks, dlg.log.prevented], [0, 0, 0]);
  });

  test('(+) Back: Alt+Left on Linux and Command+[ on macOS follow the Back link, from the message box too', () => {
    const lin = keys();
    lin.press('ArrowLeft', { altKey: true }, { tagName: 'TEXTAREA' });
    assert.deepEqual([lin.log.clicks, lin.log.prevented], [1, 1]);
    const mac = keys({ mac: true });
    mac.press('[', { metaKey: true });
    assert.deepEqual([mac.log.clicks, mac.log.prevented], [1, 1]);
  });

  test('(−) Back is ignored in passthrough (the pane rules apply) and for the other platform\'s key', () => {
    const pass = keys({ passthrough: true });
    pass.press('ArrowLeft', { altKey: true });
    assert.deepEqual([pass.log.clicks, pass.log.prevented], [0, 0]);
    const passMac = keys({ passthrough: true, mac: true });
    passMac.press('[', { metaKey: true });
    assert.equal(passMac.log.clicks, 0);
    const wrong = keys({ mac: true });
    wrong.press('ArrowLeft', { altKey: true });
    assert.equal(wrong.log.clicks, 0);
  });

  test('(−) other keys are left alone: not consumed, nothing opened', () => {
    const k = keys();
    for (const key of ['a', 'Enter', 'Escape', '/', '[']) k.press(key);
    assert.deepEqual([k.log.opened.length, k.log.clicks, k.log.prevented, k.log.toggled], [0, 0, 0, 0]);
  });

  test('(+) 0.3.4: Ctrl+Shift+H (Linux) and Command+Shift+H (macOS) toggle the transcript, from the message box too, and are consumed', () => {
    const lin = keys();
    lin.press('H', { ctrlKey: true, shiftKey: true });
    lin.press('h', { ctrlKey: true, shiftKey: true }, { tagName: 'TEXTAREA' });
    assert.deepEqual([lin.log.toggled, lin.log.prevented, lin.log.opened.length, lin.log.clicks], [2, 2, 0, 0]);
    const mac = keys({ mac: true });
    mac.press('H', { metaKey: true, shiftKey: true });
    mac.press('H', { metaKey: true, shiftKey: true }, { tagName: 'TEXTAREA' });
    assert.deepEqual([mac.log.toggled, mac.log.prevented], [2, 2]);
    const macPass = keys({ mac: true, passthrough: true });
    macPass.press('H', { metaKey: true, shiftKey: true });
    assert.equal(macPass.log.toggled, 1, 'the Command key stays the app\'s in passthrough, as for Back-less Mod+/');
  });

  test('(−) 0.3.4: Alt held, no Shift, the other platform\'s Mod, passthrough on Linux and an open dialog do not toggle and are not consumed', () => {
    const cases = [
      [{}, { ctrlKey: true, shiftKey: true, altKey: true }],
      [{}, { ctrlKey: true }],
      [{}, { metaKey: true, shiftKey: true }],
      [{ mac: true }, { ctrlKey: true, shiftKey: true }],
      [{ passthrough: true }, { ctrlKey: true, shiftKey: true }],
      [{ dialog: true }, { ctrlKey: true, shiftKey: true }],
      [{ mac: true, dialog: true }, { metaKey: true, shiftKey: true }],
    ];
    for (const [opts, mods] of cases) {
      const k = keys(opts);
      k.press('H', mods);
      assert.deepEqual([k.log.toggled, k.log.prevented], [0, 0], JSON.stringify([opts, mods]));
    }
  });

  test('(−) 0.3.4: holding the keys toggles once: the repeats are consumed but do nothing', () => {
    const k = keys();
    k.press('H', { ctrlKey: true, shiftKey: true });
    k.press('H', { ctrlKey: true, shiftKey: true, repeat: true });
    k.press('H', { ctrlKey: true, shiftKey: true, repeat: true });
    assert.deepEqual([k.log.toggled, k.log.prevented], [1, 3]);
  });
});

// ---- Task 14b: the page side of the release checks (prompt gate, Stop route, Rewind, bypass copy, header, live follow) ----------------
// The functions of session.js run for real in a vm against stubs, so the wiring is proven, not only spelled.

describe('Task 14b: wiring of the page rules', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const norm = (v) => JSON.parse(JSON.stringify(v)); // objects built inside the vm have another Object.prototype
  const el = (over = {}) => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, ...over });

  // -- B1: Send and Shell wait while a prompt is open
  const RAW_PROMPT = { question: 'Do you want to proceed?', sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] };
  const composerRig = ({ value = 'hello', promptOpen = false, kind = 'idle', shell = false, prompt = promptOpen ? cleanPromptReal(RAW_PROMPT) : null, pane = 'ok' } = {}) => {
    const log = Object.assign(sendLog(), { problems: [], said: [], shellOff: 0 });
    const ta = { value, disabled: false };
    const ctx = {
      sending: false, composer: () => ta, DF: null, S: { on: shell }, W: { promptOpen, prompt, pane, mode: 'default', confirmed: true }, A: { kind }, sendGate: sendGateReal, hasAnswerButtons: hasAnswerButtonsReal, planShell: planShellReal, planSend: planSendReal,
      showProblem: (m, k) => log.problems.push([m, k]), $: () => el(), say: (m) => log.said.push(m),
      paneId: '%12', setShell: () => { log.shellOff += 1; }, grow() {}, updateChip() {},
      DS: { screen: () => null, beginSend() {}, endSend() {}, sent() {}, submitted() {} }, draftSendPlan: draftSendPlanReal, M: { cols: 120, gone: false }, ATT: { pending: () => false },
      ...sendIo(log),
    };
    return { log, ta, ctx, send: mk(SEND_FUNCS, ctx).sendComposer };
  };
  const GATE = 'Answer the prompt with the buttons above or in the terminal.';
  const NO_BUTTONS = 'Answer the prompt in the terminal, or turn on Type into pane.';

  test('(+) B1: with a prompt open Send posts nothing for a line, a paste and a lone Enter; the text stays; the fixed line shows as an error', async () => {
    for (const value of ['hello', 'line one\nline two', '', '/compact', 'x'.repeat(2000)]) {
      const r = composerRig({ value, promptOpen: true });
      await r.send();
      assert.deepEqual(r.log.sent, [], JSON.stringify(value.slice(0, 20)));
      assert.equal(r.ta.value, value, 'the text stays in the box');
      assert.deepEqual(r.log.problems, [[GATE, 'error']]);
    }
  });

  test('(+) B1: Shell waits too, and stays on so a retry still goes as a command', async () => {
    const r = composerRig({ value: 'ls -la', promptOpen: true, shell: true });
    await r.send();
    assert.deepEqual(r.log.sent, []);
    assert.equal(r.log.shellOff, 0, 'Shell is not turned off by a send that never happened');
    assert.deepEqual(r.log.problems, [[GATE, 'error']]);
    assert.equal(r.ta.value, 'ls -la');
  });

  test('(+) B1: the agent needing you is enough, even before a capture shows the prompt; with no buttons the line names the terminal', async () => {
    const r = composerRig({ value: 'hello', promptOpen: false, kind: 'attn' });
    await r.send();
    assert.deepEqual(r.log.sent, []);
    assert.deepEqual(r.log.problems, [[NO_BUTTONS, 'error']]);
  });

  // a session whose turn is over but a background shell runs (Claude's `shell`): the server sends state 'busy' and no attention, so it is Working
  const kindOf = (agent) => mk(['function statusOf(agent)'], {}).statusOf(agent);
  const SHELL_AGENT = { live: true, state: 'busy', attention: null };

  test('(+) a shell-status session is Working: no "Answer the prompt first" note, and the message box sends', async () => {
    assert.equal(kindOf(SHELL_AGENT), 'busy');
    assert.equal(attnRig({ kind: kindOf(SHELL_AGENT) }).note.hidden, true, 'no needs-you note');
    const r = composerRig({ value: 'hello', kind: kindOf(SHELL_AGENT) });
    await r.send();
    assert.deepEqual([r.log.keys, r.log.posts], [[{ text: 'hello', send: true }], [['submit', {}]]], 'the line goes out: the text, then the guarded Enter');
    assert.deepEqual(r.log.problems, []);
    assert.equal(r.ta.value, '', 'the box is emptied after a send');
  });

  test('(−) a waiting session still needs you: the note shows and Send refuses', async () => {
    const kind = kindOf({ live: true, state: 'waiting', attention: 'waiting' });
    assert.equal(kind, 'attn');
    assert.equal(attnRig({ kind }).note.hidden, false);
    const r = composerRig({ value: 'hello', kind });
    await r.send();
    assert.deepEqual(r.log.sent, []);
    assert.deepEqual(r.log.problems, [[NO_BUTTONS, 'error']]);
  });

  test('(+) B1: the line tells the truth about the screen: buttons above only when the panel shows an answer button', async () => {
    const bypass = cleanPromptReal({ ...RAW_PROMPT, question: 'Switch to bypass permissions?' });
    assert.equal(hasAnswerButtonsReal(bypass), false, 'every option of a bypass prompt is text');
    for (const [name, over, line] of [
      ['plain prompt, panel shown', { promptOpen: true }, GATE],
      ['bypass prompt: no answer button', { promptOpen: true, prompt: bypass }, NO_BUTTONS],
      ['prompt nika cannot parse (open, no panel data)', { promptOpen: true, prompt: null }, NO_BUTTONS],
      ['panel data but the pane is not ok (the panel is hidden then)', { promptOpen: true, pane: 'gone' }, NO_BUTTONS],
    ]) {
      const r = composerRig({ value: 'hello', ...over });
      await r.send();
      assert.deepEqual(r.log.problems, [[line, 'error']], name);
      assert.deepEqual(r.log.sent, [], name);
    }
  });

  test('(−) B1: with no prompt everything goes out: a line (the text, then the guarded Enter), an empty box (the Enter alone), Shell (C-u and the command, then the Enter, then Shell off)', async () => {
    const line = composerRig({ value: 'hello' });
    await line.send();
    assert.deepEqual([line.log.keys, line.log.posts], [[{ text: 'hello', send: true }], [['submit', {}]]]);
    assert.equal(line.log.problems.length, 0);
    assert.equal(line.ta.value, '', 'the box is emptied after a send');
    const empty = composerRig({ value: '' });
    await empty.send();
    assert.deepEqual([empty.log.keys, empty.log.posts], [[], [['submit', {}]]]);
    const shell = composerRig({ value: 'ls', shell: true });
    await shell.send();
    assert.deepEqual(shell.log.keys, [{ keys: ['C-u'], send: true }, { text: '!ls', send: true }]);
    assert.deepEqual(shell.log.posts, [['submit', {}]]);
    assert.equal(shell.log.shellOff, 1);
  });

  test('(−) B1: passthrough is the raw terminal path and is not gated by this rule', () => {
    for (const head of ['function flushPass()', 'function wirePassthrough()', 'function setPass(']) assert.doesNotMatch(fnOf(head), /sendGate/, head);
  });

  const deliverRig = (response) => {
    const log = { problems: [], gone: 0 };
    const ctx = {
      M: { gone: false }, paneId: '%12', call: async () => response, showProblem: (m, k, ms) => log.problems.push([m, k, ms]), clearProblem() {}, setGone: () => { log.gone += 1; },
      sleep: async () => {}, RATE_MSG: 'Too fast.', keysRefusal: keysRefusalReal, submitMessage: submitMessageReal, serverMessage: (r, fb) => (typeof r.body?.message === 'string' ? r.body.message : fb),
    };
    return { log, deliver: mk(['async function postRetry(tail, payload)', 'function sendRefusal(payload, r)', 'async function deliver(payload)'], ctx).deliver };
  };

  test('(+) B1: the keys route\'s 409 bypass-prompt shows the fixed line, never the server\'s text', async () => {
    const r = deliverRig({ status: 409, body: { error: 'bypass-prompt', message: 'Evil <b>server</b> text' } });
    const out = await r.deliver({ keys: ['Enter'] });
    assert.deepEqual(norm(out), { ok: false, message: 'Answer this prompt in the terminal.' });
    assert.deepEqual(r.log.problems, [['Answer this prompt in the terminal.', 'error', 0]]);
  });

  test('(−) B1: other keys answers keep their lines (429 retried, network, 404 gone, a plain 409)', async () => {
    const net = await deliverRig({ status: 0, body: null }).deliver({ text: 'x' });
    assert.equal(net.message, 'nika did not answer. Your text is kept.');
    const gone = deliverRig({ status: 404, body: { error: 'not_found', message: 'gone' } });
    await gone.deliver({ text: 'x' });
    assert.equal(gone.log.gone, 1);
    const other = await deliverRig({ status: 409, body: { error: 'something-else', message: 'The pane is busy.' } }).deliver({ text: 'x' });
    assert.equal(other.message, 'The pane is busy.', 'only bypass-prompt has fixed copy; the rest is unchanged');
  });

  // T54: Send's own typing (`send: true`) is refused by the keys route for a prompt, a dialog, the survey or an unclear screen; the page shows the
  // fixed lines of the submit route (draft-sync.js submitMessage), never the server's text, and the passthrough keeps its own copy.
  const SUBMIT_PROMPT_OPEN = 'A prompt opened in Claude, so nika did not press Enter. Answer it, then send again. Your text is kept.';
  const SUBMIT_UNCLEAR = "nika can't tell what Claude is showing, so it did not press Enter. Use the terminal. Your text is kept.";

  test('(+) T54: a 409 prompt-open or screen-unclear for a body with send: true shows the submit route\'s fixed line, never the server\'s text', async () => {
    for (const [code, line] of [['prompt-open', SUBMIT_PROMPT_OPEN], ['screen-unclear', SUBMIT_UNCLEAR]]) {
      for (const payload of [{ text: 'hello', send: true }, { paste: 'a\nb', send: true }, { keys: ['C-u'], send: true }]) {
        const r = deliverRig({ status: 409, body: { error: code, message: 'Evil <b>server</b> text', sent: { text: 700, paste: 0, keys: 0 } } });
        const out = await r.deliver(payload);
        assert.deepEqual(norm(out), { ok: false, message: line }, `${code} ${JSON.stringify(payload).slice(0, 30)}`);
        assert.deepEqual(r.log.problems, [[line, 'error', 0]]);
      }
    }
  });

  test('(+) T54: bypass-prompt for a body with send: true still shows the bypass line', async () => {
    const r = deliverRig({ status: 409, body: { error: 'bypass-prompt', message: 'x' } });
    assert.equal((await r.deliver({ text: 'hello', send: true })).message, 'Answer this prompt in the terminal.');
  });

  test('(−) T54: without send the same 409s keep their old lines (the passthrough is the user\'s own typing)', async () => {
    const unclear = await deliverRig({ status: 409, body: { error: 'screen-unclear', message: 'x' } }).deliver({ text: 'a' });
    assert.equal(unclear.message, "nika can't tell what Claude is showing; use the terminal.", 'the keys route\'s own line (quick-actions.js)');
    const open = await deliverRig({ status: 409, body: { error: 'prompt-open', message: 'The server says so.' } }).deliver({ text: 'a' });
    assert.equal(open.message, 'The server says so.', 'no fixed copy for the passthrough: an unknown 409 keeps serverMessage');
    for (const bad of [{ send: false }, { send: 1 }, { send: 'true' }]) {
      const r = await deliverRig({ status: 409, body: { error: 'prompt-open', message: 'The server says so.' } }).deliver({ text: 'a', ...bad });
      assert.equal(r.message, 'The server says so.', `only the boolean true marks Send's typing: ${JSON.stringify(bad)}`);
    }
  });

  test('(−) T54: no passthrough call site (typed characters, a paste into the pane, named keys, arrow batches) sets send', () => {
    for (const head of ['async function sendKey(name)', 'function flushArrows()', 'function flushPass()', 'function wirePassthrough()']) {
      assert.doesNotMatch(fnOf(head), /\bsend\s*:\s*true/, head);
    }
  });

  /** postRetry and submitEnter for real. `answers`: what the route gives, in order (the last repeats). */
  const submitRig = (answers, { gone = false } = {}) => {
    const log = { paths: [], bodies: [], problems: [], cleared: 0, gone: 0, sleeps: [], submitted: [] };
    const queue = [...answers];
    const ctx = {
      HOLD: { active: false }, M: { gone }, paneId: '%12', call: async (path, o) => { log.paths.push(path); log.bodies.push(jsonClone(o.json)); return queue.length > 1 ? queue.shift() : queue[0]; },
      showProblem: (m, k, ms) => log.problems.push([m, k, ms]), clearProblem: () => { log.cleared += 1; }, setGone: () => { log.gone += 1; },
      sleep: async (ms) => { log.sleeps.push(ms); }, RATE_MSG: 'Too fast.', submitResult: submitResultReal, DS: { submitted: (r) => log.submitted.push(jsonClone(r)) },
    };
    return { log, submitEnter: mk(['async function postRetry(tail, payload)', 'async function submitEnter(base)'], ctx).submitEnter };
  };

  test('(+) W13: the Enter goes to the submit route of this pane, with `base` only when there is one, and the answer is told to the sync', async () => {
    const r = submitRig([{ status: 200, body: { taken: true, draft: null } }]);
    assert.deepEqual(jsonClone(await r.submitEnter('0123456789abcdef')), { ok: true, taken: true });
    assert.deepEqual(jsonClone(await r.submitEnter()), { ok: true, taken: true });
    assert.deepEqual(r.log.paths, ['/api/app/pane/%2512/submit', '/api/app/pane/%2512/submit']);
    assert.deepEqual(r.log.bodies, [{ base: '0123456789abcdef' }, {}], '`{}` for no base: `base: ""` would answer draft-changed');
    assert.equal(r.log.submitted.length, 2);
    assert.equal(r.log.cleared, 2);
    assert.deepEqual(r.log.problems, []);
  });

  test('(−) W13: a 429 waits and sends again (nothing was sent); the line at the end is the fixed one', async () => {
    const ok = submitRig([{ status: 429, body: { error: 'busy' } }, { status: 429, body: { error: 'busy' } }, { status: 200, body: { taken: null, draft: null } }]);
    assert.deepEqual(jsonClone(await ok.submitEnter()), { ok: true, taken: null });
    assert.equal(ok.log.paths.length, 3);
    assert.deepEqual(ok.log.sleeps, [700, 1400]);
    assert.deepEqual(ok.log.problems.slice(0, 2), [['Too fast.', 'warn', undefined], ['Too fast.', 'warn', undefined]]);
    const no = submitRig([{ status: 429, body: { error: 'busy' } }]);
    const out = jsonClone(await no.submitEnter());
    assert.deepEqual(out, { ok: false, message: 'Too many keys at once; try again. Your text is kept.' });
    assert.equal(no.log.paths.length, 4, 'four tries, then it gives up');
    assert.deepEqual(no.log.problems.at(-1), ['Too many keys at once; try again. Your text is kept.', 'warn', 3000]);
  });

  test('(−) fix round 1: only a 429 is sent again: no answer (status 0), a 5xx and every other refusal is exactly one POST, no wait, because the Enter may already have been pressed', async () => {
    for (const [status, body] of [[0, null], [500, null], [502, { error: 'bad-gateway' }], [503, null], [504, null], [400, { error: 'bad-request' }], [403, null], [404, { error: 'not_found' }], [409, { error: 'not-idle' }], [409, { error: 'draft-changed' }]]) {
      const r = submitRig([{ status, body }]);
      const out = jsonClone(await r.submitEnter('0123456789abcdef'));
      assert.equal(out.ok, false, `${status}`);
      assert.equal(r.log.paths.length, 1, `${status}: one POST, never repeated`);
      assert.deepEqual(r.log.sleeps, [], `${status}: no wait for a second try`);
      assert.equal(r.log.problems.length, 1, `${status}: the fixed line shows once`);
    }
    const net = submitRig([{ status: 0, body: null }]);
    assert.equal(jsonClone(await net.submitEnter()).message, "nika did not answer, so it is not known whether Enter was pressed. Check Claude's input in the terminal. Your text is kept.");
    const bad = submitRig([{ status: 502, body: null }]);
    assert.equal(jsonClone(await bad.submitEnter()).message, "nika couldn't press Enter in Claude's input. Check the terminal. Your text is kept.");
    const late = submitRig([{ status: 429, body: { error: 'busy' } }, { status: 0, body: null }, { status: 200, body: { taken: true, draft: null } }]);
    assert.equal(jsonClone(await late.submitEnter()).ok, false, 'a 429 then no answer: the retry stops at the answer that is not a 429');
    assert.equal(late.log.paths.length, 2);
  });

  test('(−) W13: a refusal shows its fixed line as an error and keeps the text; the server\'s own words never show; 404 is the gone state; taken false is not a success', async () => {
    const prompt = submitRig([{ status: 409, body: { error: 'prompt-open', message: 'Evil <b>server</b> text' } }]);
    const out = jsonClone(await prompt.submitEnter('0123456789abcdef'));
    assert.deepEqual(out, { ok: false, message: 'A prompt opened in Claude, so nika did not press Enter. Answer it, then send again. Your text is kept.' });
    assert.deepEqual(prompt.log.problems, [[out.message, 'error', 0]]);
    assert.equal(prompt.log.cleared, 0);
    const gone = submitRig([{ status: 404, body: { error: 'not_found' } }]);
    await gone.submitEnter();
    assert.equal(gone.log.gone, 1);
    const eaten = submitRig([{ status: 200, body: { taken: false, draft: null } }]);
    const eatenOut = jsonClone(await eaten.submitEnter('0123456789abcdef'));
    assert.equal(eatenOut.ok, false);
    assert.match(eatenOut.message, /^nika pressed Enter, but Claude's input still shows your text/);
    assert.equal(eaten.log.cleared, 0);
    assert.equal(eaten.log.submitted.length, 1, 'the screen the answer shows is still told to the sync');
  });

  test('(−) W13: a pane that is gone sends nothing', async () => {
    const r = submitRig([TAKEN], { gone: true });
    assert.deepEqual(jsonClone(await r.submitEnter()), { ok: false, message: 'The pane is gone.' });
    assert.deepEqual(r.log.paths, []);
  });

  test('(+) B1: a prompt that mentions bypass is drawn with no answer button at all, only the Esc button; a plain prompt keeps its buttons', () => {
    const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs ?? {}, kids: kids.flat(Infinity) });
    const build = (raw) => {
      const out = {};
      const ctx = {
        h, PA: { sig: null, btns: [], esc: null }, answer() {}, escNo() {}, announce() {}, promptNote: () => '', A: { name: 'builder-1' },
        $: (id) => (out[id] ??= { textContent: '', hidden: true, replaceChildren(...n) { this.kids = n; } }),
      };
      const api = mk(['function optionRow(o)', 'function buildPrompt(p)'], ctx);
      api.buildPrompt(cleanPromptReal(raw));
      const buttons = out['ask-opts'].kids.filter((n) => n.tag === 'button' && /\bpbtn\b/.test(n.attrs.class) && !/\besc\b/.test(n.attrs.class));
      return { buttons, texts: out['ask-opts'].kids.filter((n) => /pbtn-off/.test(n.attrs.class)), esc: out['ask-opts'].kids.at(-1), pa: ctx.PA };
    };
    const base = { sig: '0123456789abcdef', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }] };
    const plain = build({ ...base, question: 'Do you want to proceed?' });
    assert.equal(plain.buttons.length, 2);
    assert.equal(plain.texts.length, 0);
    const bypass = build({ ...base, question: 'Switch to bypass permissions?' });
    assert.equal(bypass.buttons.length, 0, 'no answer button');
    assert.equal(bypass.texts.length, 2, 'every option is text with the terminal note');
    assert.match(JSON.stringify(bypass.texts[0]), /Answer this one in the terminal/);
    assert.equal(bypass.pa.btns.length, 0, 'nothing to disable or click');
    assert.match(bypass.esc.attrs.class, /\besc\b/, 'Esc = No stays');
  });

  // -- the attention note for a prompt nika cannot parse (no panel)
  const attnRig = ({ mac = false, kind = 'attn', prompt = null, pane = 'ok' } = {}) => {
    const note = { hidden: true };
    const text = { textContent: '' };
    const ctx = { $: (id) => (id === 'attn-note' ? note : text), DF: null, W: { pane, prompt }, A: { kind, name: 'builder-1', attention: 'Asking to run a command' }, attnNote: attnNoteReal, passKeyLabel, MAC: mac };
    mk(['function renderAttn()'], ctx).renderAttn();
    return { note, text };
  };

  test('(+) the note for an unparseable prompt names the terminal and Type into pane, with the key as the page writes it (Mac glyph or Ctrl+])', () => {
    const mac = attnRig({ mac: true });
    assert.equal(mac.note.hidden, false);
    assert.equal(mac.text.textContent, 'builder-1 needs you: Asking to run a command. Answer it in the terminal, or turn on Type into pane (\u2303]).');
    assert.equal(attnRig({ mac: false }).text.textContent, 'builder-1 needs you: Asking to run a command. Answer it in the terminal, or turn on Type into pane (Ctrl+]).');
  });

  test('(−) the note never tells the user to press Enter (the gate blocks it); it stays hidden when the panel shows or the agent does not need you', () => {
    assert.doesNotMatch(attnRig().text.textContent, /Enter|arrow/);
    assert.equal(attnRig({ prompt: cleanPromptReal(RAW_PROMPT) }).note.hidden, true, 'the panel replaces the note');
    assert.equal(attnRig({ kind: 'idle' }).note.hidden, true);
    assert.equal(attnRig({ pane: 'gone', kind: 'attn', prompt: cleanPromptReal(RAW_PROMPT) }).note.hidden, false, 'a hidden panel does not replace it');
  });

  // -- prompt.bypass from the server and the 400 fallback
  const promptRig = (raw) => {
    const out = {};
    const h = (tag, attrs, ...kids) => ({ tag, attrs: attrs ?? {}, kids: kids.flat(Infinity) });
    const ctx = {
      h, PA: { sig: null, btns: [], esc: null }, answer() {}, escNo() {}, announce() {}, promptNote: () => '', A: { name: 'builder-1' },
      $: (id) => (out[id] ??= { textContent: '', hidden: true, replaceChildren(...n) { this.kids = n; } }),
    };
    const api = mk(['function optionRow(o)', 'function buildPrompt(p)'], ctx);
    api.buildPrompt(cleanPromptReal(raw));
    return { buttons: out['ask-opts'].kids.filter((n) => n.tag === 'button' && !/\besc\b/.test(n.attrs.class)).length, texts: out['ask-opts'].kids.filter((n) => /pbtn-off/.test(n.attrs.class)).length, esc: /\besc\b/.test(out['ask-opts'].kids.at(-1).attrs.class) };
  };

  test('(+) the server\'s prompt.bypass hides every answer button even when the visible text says nothing; Esc stays', () => {
    assert.deepEqual(promptRig({ ...RAW_PROMPT, bypass: true }), { buttons: 0, texts: 2, esc: true });
  });

  test('(−) prompt.bypass false or absent keeps the buttons', () => {
    assert.deepEqual(promptRig({ ...RAW_PROMPT, bypass: false }), { buttons: 2, texts: 0, esc: true });
    assert.deepEqual(promptRig(RAW_PROMPT), { buttons: 2, texts: 0, esc: true });
  });

  const answerRig = ({ status, body = {} }) => {
    const log = { calls: [], problems: [], said: [], renders: 0, gone: 0 };
    const PA = { sig: RAW_PROMPT.sig, pending: false, lock: null, esc: {}, btns: [] };
    const W = { prompt: cleanPromptReal(RAW_PROMPT) };
    const ctx = {
      W, PA, M: { gone: false }, paneId: '%12', promptOff: promptOffReal, answerOutcome: answerOutcomeReal, problemKind: problemKindReal, renderPrompt: () => { log.renders += 1; },
      call: async (path, opts) => { log.calls.push([path, opts]); return { status, body }; }, clearProblem() {}, say: (m) => log.said.push(m),
      showProblem: (m, k) => log.problems.push([m, k]), setGone: () => { log.gone += 1; },
    };
    return { log, PA, answer: mk(['async function answer(n)'], ctx).answer };
  };

  test('(+) a 400 from the answer route says to answer in the terminal and locks the question like an answered one (no retry loop)', async () => {
    const r = answerRig({ status: 400, body: { error: 'invalid', message: 'this option is answered in the terminal' } });
    await r.answer(1);
    assert.deepEqual(r.log.problems, [['Answer this prompt in the terminal.', 'warn']]);
    assert.equal(r.PA.lock, RAW_PROMPT.sig);
    assert.equal(promptOffReal({ pending: r.PA.pending, lock: r.PA.lock, sig: RAW_PROMPT.sig }), true, 'every button of this question is off');
    await r.answer(2);
    assert.equal(r.log.calls.length, 1, 'the locked question sends nothing more');
  });

  test('(−) other failures still re-enable the buttons (a 429 is worth a retry)', async () => {
    const r = answerRig({ status: 429 });
    await r.answer(1);
    assert.equal(r.PA.lock, null);
    assert.deepEqual(r.log.problems, [['Too many keys at once; try again.', 'warn']]);
  });

  // -- B2: Stop uses its own route
  const stopRig = ({ status = 200, body = { stopped: true, presses: 1 }, busy = null, stopping = false, gone = false, dialog = null } = {}) => {
    const log = { calls: [], said: [], problems: [], gone: 0, cleared: 0, renders: 0, marks: [] };
    const Q = { busy, stopping };
    const ctx = {
      Q, M: { gone }, W: { dialog }, paneId: '%12', A: { name: 'builder-1' }, renderQuick: () => { log.renders += 1; log.marks.push(Q.stopping); }, stopOutcome: stopOutcomeReal, problemKind: problemKindReal,
      call: async (path, opts) => { log.calls.push([path, opts]); return { status, body }; }, clearProblem: () => { log.cleared += 1; }, say: (m) => log.said.push(m),
      setGone: () => { log.gone += 1; }, showProblem: (m, k) => log.problems.push([m, k]),
    };
    return { log, Q, stop: mk(['async function stop()'], ctx).stop };
  };

  test('(+) B2: Stop posts {} to /stop (not the keys route) and says what happened on a 200', async () => {
    const r = stopRig();
    await r.stop();
    assert.deepEqual(norm(r.log.calls), [['/api/app/pane/%2512/stop', { method: 'POST', json: {} }]]);
    assert.deepEqual(r.log.said, ["Stopped builder-1's turn"]);
    assert.equal(r.log.cleared, 1);
    assert.deepEqual(r.log.problems, []);
    assert.equal(r.Q.stopping, false, 'the in-flight mark is cleared');
    assert.deepEqual(r.log.marks, [true, false], 'the button shows busy, then ready');
  });

  test('(+) B2: each refusal shows its fixed line; 404 also goes to the pane-gone state', async () => {
    const rows = [
      [409, 'prompt-open', 'Answer the prompt first. Esc = No is in the prompt panel.', 'warn'],
      [409, 'not-busy', 'Nothing to stop: Claude is waiting.', 'warn'],
      [409, 'mode-unknown', "Claude's input stayed in vim insert mode; press Esc in the terminal.", 'warn'],
      [404, 'not_found', 'The session is gone.', 'error'],
      [500, undefined, "nika couldn't reach tmux.", 'error'],
      [400, 'invalid', "nika couldn't stop the turn.", 'warn'],
    ];
    for (const [status, error, text, kind] of rows) {
      const r = stopRig({ status, body: { error, message: 'server text that must not show' } });
      await r.stop();
      assert.deepEqual(r.log.problems, [[text, kind]], `${status} ${error}`);
      assert.equal(r.log.gone, status === 404 ? 1 : 0, `${status} gone`);
      assert.deepEqual(r.log.said, []);
    }
  });

  test('(+) F3: Stop\'s 409 prompt-open while a question or plan form shows (W.dialog) says to answer the question above; a permission prompt keeps Esc = No (rows above)', async () => {
    const r = stopRig({ status: 409, body: { error: 'prompt-open' }, dialog: { at: 'question' } });
    await r.stop();
    assert.deepEqual(r.log.problems, [['Answer the question above first.', 'warn']]);
    const other = stopRig({ status: 409, body: { error: 'not-busy' }, dialog: { at: 'question' } });
    await other.stop();
    assert.deepEqual(other.log.problems, [['Nothing to stop: Claude is waiting.', 'warn']], 'only prompt-open changes');
  });

  test('(+) B2: a command in flight (Compact waiting on the control lock) does not block Stop: the route takes no lock', async () => {
    const r = stopRig({ busy: 'compact' });
    await r.stop();
    assert.equal(r.log.calls.length, 1);
    assert.equal(r.Q.busy, 'compact', 'the command\'s own mark is left alone');
    assert.deepEqual(r.log.said, ["Stopped builder-1's turn"]);
  });

  test('(−) B2: a second click while Stop\'s own request is in flight, or on a gone pane, sends nothing', async () => {
    const busy = stopRig({ stopping: true });
    await busy.stop();
    assert.deepEqual(busy.log.calls, []);
    assert.equal(busy.Q.stopping, true, 'the first request still owns the mark');
    const gone = stopRig({ gone: true });
    await gone.stop();
    assert.deepEqual(gone.log.calls, []);
  });

  test('(−) B2: the in-flight mark is cleared after a refusal too, so the next click works', async () => {
    for (const [status, error] of [[409, 'stopping'], [409, 'not-busy'], [500, undefined], [0, undefined]]) {
      const r = stopRig({ status, body: { error } });
      await r.stop();
      assert.equal(r.Q.stopping, false, `${status} ${error}`);
    }
  });

  test('(+) B2: 409 stopping (another window is already stopping it) shows its own fixed line as a warning', async () => {
    const r = stopRig({ status: 409, body: { error: 'stopping', message: 'server text' } });
    await r.stop();
    assert.deepEqual(r.log.problems, [['Already stopping the turn.', 'warn']]);
    assert.equal(r.log.gone, 0);
  });

  test('(+) B2: while Stop is in flight the Stop button is aria-busy and the other actions wait; a command in flight marks only its own button', () => {
    const run = ({ stopping, busy }) => {
      const b = Object.fromEntries(['stop', 'compact', 'clear', 'model', 'rewind', 'end'].map((id) => [id, { attrs: {}, title: '', classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; } }]));
      const why = { hidden: true, replaceChildren() {} };
      const ctx = {
        Q: { ready: true, b, busy, stopping, whySig: null, pop: false }, W: { pane: 'ok', promptOpen: false }, A: { kind: 'idle' }, SW: { busy: null },
        quickState: quickStateReal, $: () => why, icon: () => ({}), h: () => ({}), closeModelPop() {},
      };
      mk(['function renderQuick()'], ctx).renderQuick();
      return b;
    };
    const during = run({ stopping: true, busy: null });
    assert.equal(during.stop.attrs['aria-busy'], 'true');
    assert.equal(during.compact.attrs['aria-disabled'], 'true', 'idle again, but Stop has not answered yet');
    assert.equal(during.compact.attrs['aria-busy'], undefined);
    const cmd = run({ stopping: false, busy: 'compact' });
    assert.equal(cmd.compact.attrs['aria-busy'], 'true');
    assert.equal(cmd.stop.attrs['aria-busy'], undefined);
    const quiet = run({ stopping: false, busy: null });
    assert.equal(quiet.compact.attrs['aria-disabled'], 'false');
  });

  test('(+) W13: Stop\'s title says what Stop does with a queued message only while Q.queued, and only for a working Claude', () => {
    const run = ({ queued, kind }) => {
      const b = Object.fromEntries(['stop', 'compact', 'clear', 'model', 'rewind', 'end'].map((id) => [id, { attrs: {}, title: '', classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; } }]));
      const why = { hidden: true, replaceChildren() {} };
      const ctx = {
        Q: { ready: true, b, busy: null, stopping: false, whySig: null, pop: false, queued }, W: { pane: 'ok', promptOpen: false }, A: { kind }, SW: { busy: null },
        quickState: quickStateReal, $: () => why, icon: () => ({}), h: () => ({}), closeModelPop() {},
      };
      mk(['function renderQuick()'], ctx).renderQuick();
      return b.stop.title;
    };
    const QUEUED = "Stop ends Claude's current step. Your queued message then goes to Claude at once.";
    assert.equal(run({ queued: true, kind: 'busy' }), QUEUED);
    assert.notEqual(run({ queued: false, kind: 'busy' }), QUEUED);
    assert.notEqual(run({ queued: true, kind: 'idle' }), QUEUED, 'nothing to stop, nothing to explain');
    assert.match(fnOf('function renderQuick()'), /quickState\(\{[^}]*queued: Q\.queued/);
  });

  test('(+) F3: renderQuick reads W.dialog: a question or plan form gets the form copy for Stop\'s title and the reason line; a permission prompt keeps Esc = No', () => {
    const run = ({ dialog }) => {
      const b = Object.fromEntries(['stop', 'compact', 'clear', 'model', 'rewind', 'end'].map((id) => [id, { attrs: {}, title: '', classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; } }]));
      let reason = null;
      const why = { hidden: true, replaceChildren: (...nodes) => { reason = nodes.map((n) => n.text).filter(Boolean).join(''); } };
      const ctx = {
        Q: { ready: true, b, busy: null, stopping: false, whySig: null, pop: false }, W: { pane: 'ok', promptOpen: true, dialog }, A: { kind: 'attn' }, SW: { busy: null },
        quickState: quickStateReal, $: () => why, icon: () => ({}), h: (tag, o) => o, closeModelPop() {},
      };
      mk(['function renderQuick()'], ctx).renderQuick();
      return { title: b.stop.title, reason };
    };
    assert.deepEqual(run({ dialog: { at: 'question' } }), { title: 'Decline is in the question form', reason: 'Answer the question above first.' });
    assert.deepEqual(run({ dialog: null }), { title: 'Esc = No is in the prompt panel', reason: 'Answer the prompt first. Esc = No is in the prompt panel.' });
    assert.match(fnOf('function renderQuick()'), /quickState\(\{[^}]*dialog: W\.dialog !== null/);
    assert.match(fnOf('function wireComposer()'), /promptOpen: W\.promptOpen, dialog: W\.dialog !== null/);
    assert.match(fnOf('async function stop()'), /stopOutcome\(\{[^}]*dialog: W\.dialog !== null/);
  });

  test('(+) B2: the Stop button runs stop(); Esc = No and the message box\'s Esc stay on the keys route; Ctrl+C in the box is Stop, never a C-c key', () => {
    assert.match(SRC, /on\('stop', stop\);/);
    assert.doesNotMatch(SRC, /on\('stop', \(\) => sendKey/);
    assert.match(fnOf('async function escNo()'), /await sendKey\('Escape'\)/);
    const wire = fnOf('function wireComposer()');
    assert.match(wire, /else if \(a\.act === 'key'\) sendKey\(a\.key\)/, '`key` acts (Esc, Shift+Tab) go through sendKey, the keys route');
    assert.match(wire, /else if \(a\.act === 'stop'\) arrows \? chain\.then\(stop\) : stop\(\)/, 'Ctrl+C is the Stop route, behind arrows typed just before it');
    assert.doesNotMatch(wire, /C-c/);
  });

  // -- B3: loud failures
  const failRig = ({ mode = 'unknown', confirmed = true } = {}) => {
    const log = { polite: [], alerts: [] };
    const W = { mode, confirmed, struck: new Set(), strikeAt: null, last: null, msg: null };
    const ctx = {
      W, A: { name: 'builder-1' }, switchFailure: switchFailureReal, announceMode: (m) => log.polite.push(m), showProblem: (m, k) => log.alerts.push([m, k]),
    };
    return { log, W, fail: mk(['function failSwitch(r, start, target)'], ctx).failSwitch };
  };

  test('(+) B3: stopped-in-bypass goes to the alert line (not the polite region) and the reason line leads with the Bypass tag', () => {
    const r = failRig({ mode: 'bypassPermissions' });
    r.fail({ status: 409, body: { error: 'stopped-in-bypass', presses: 2 } }, 'plan', 'auto');
    const text = 'Stopped at Bypass permissions: Claude runs tools without asking. Press Shift-Tab in the terminal to leave it.';
    assert.deepEqual(r.log.alerts, [[text, 'error']]);
    assert.deepEqual(r.log.polite, [], 'one voice, the loud one');
    assert.deepEqual(norm(r.W.msg), { text, mode: 'bypassPermissions', bypass: true });
  });

  test('(+) B3: mode-unknown after a press is loud, without the Bypass tag; with no press it stays on the polite region', () => {
    const loud = failRig();
    loud.fail({ status: 409, body: { error: 'mode-unknown', presses: 1 } }, 'plan', 'auto');
    assert.equal(loud.log.alerts.length, 1);
    assert.match(loud.log.alerts[0][0], /^nika can't read the mode after pressing Shift-Tab\. Check the terminal: the session may be in any mode, including Bypass permissions\.$/);
    assert.equal(loud.W.msg.bypass, false);
    assert.deepEqual(loud.log.polite, []);
    const quiet = failRig();
    quiet.fail({ status: 409, body: { error: 'mode-unknown' } }, 'plan', 'auto');
    assert.deepEqual(quiet.log.alerts, []);
    assert.deepEqual(quiet.log.polite, ["builder-1: nika can't read the mode."]);
  });

  test('(−) B3: ordinary failures never use the alert line; a gone pane stays silent here (the pane-gone state announces it)', () => {
    const r = failRig();
    r.fail({ status: 409, body: { error: 'not-idle' } }, 'plan', 'auto');
    assert.deepEqual(r.log.alerts, []);
    assert.equal(r.log.polite.length, 1);
    const gone = failRig();
    gone.fail({ status: 404, body: null }, 'plan', 'auto');
    assert.deepEqual([gone.log.alerts, gone.log.polite], [[], []]);
  });

  const whyRig = (msg, reason = '', extra = {}) => {
    const why = { hidden: false, className: '', kids: [], replaceChildren(...n) { this.kids = n; } };
    const h = (tag, attrs) => ({ tag, text: attrs?.text });
    const ctx = { W: { msg, whySig: '', confirmed: true }, $: () => why, h, icon: (n) => ({ icon: n }), bypassTag: () => ({ tag: 'bypass-tag' }), modeEl: (m, o) => ({ modeEl: m, confirmed: o.confirmed }) };
    mk(['function renderWhy(st)'], ctx).renderWhy({ reason, chip: null, ...extra });
    return why;
  };

  test('(+) B3: the reason line leads with the Bypass tag only for a Bypass result; others keep the warn or info icon', () => {
    assert.deepEqual(whyRig({ text: 'Stopped...', bypass: true }).kids[0], { tag: 'bypass-tag' });
    assert.deepEqual(whyRig({ text: 'Stopped at Plan.', bypass: false }).kids[0], { icon: 'warn' });
    assert.deepEqual(whyRig(null, 'Answer the prompt first.').kids[0], { icon: 'info' });
    assert.match(whyRig({ text: 'x', bypass: true }).className, /\berr\b/);
  });

  test('(−) B4: the reason line has no Shift-Tab chip any more (nothing can ask for one)', () => {
    assert.doesNotMatch(fnOf('function renderWhy(st)'), /chip|Shift-Tab/);
    assert.equal(whyRig(null, "nika can't read the mode. Use the terminal.").kids.length, 2, 'icon and text, nothing else');
  });

  test('(+) 0.3.3: a mode with no segment leads the reason line with its tag (colour, icon, word) instead of the info icon', () => {
    const w = whyRig(null, "Don't ask is on. Change it in the terminal.", { tag: 'dontAsk' });
    assert.deepEqual(w.kids[0], { modeEl: 'dontAsk', confirmed: true });
    assert.equal(w.kids[1].text, "Don't ask is on. Change it in the terminal.");
    assert.equal(w.className, 'msw-why');
  });

  test('(+) 0.3.3: a live Bypass shows its note in the normal look (not the error look), led by the Bypass tag', () => {
    const w = whyRig(null, '', { tag: 'bypassPermissions', note: 'Claude runs every tool without asking.' });
    assert.equal(w.hidden, false);
    assert.equal(w.className, 'msw-why');
    assert.deepEqual(w.kids[0], { modeEl: 'bypassPermissions', confirmed: true });
    assert.equal(w.kids[1].text, 'Claude runs every tool without asking.');
  });

  test('(−) 0.3.3: no reason, result or note hides the line; a switch result ignores a tag and keeps its own warn icon', () => {
    const none = whyRig(null, '');
    assert.equal(none.hidden, true);
    assert.deepEqual(none.kids, []);
    const res = whyRig({ text: 'Stopped at Plan.', bypass: false }, '', { tag: 'dontAsk' });
    assert.deepEqual(res.kids[0], { icon: 'warn' });
    assert.match(res.className, /\berr\b/);
  });

  // -- B5: Rewind is /rewind through the command route
  const cmdRig = ({ status = 200, body = { sent: true }, hold = { active: false } } = {}) => {
    const log = { calls: [], said: [], problems: [], gone: 0 };
    const ctx = {
      HOLD: hold, Q: { busy: null }, M: { gone: false }, paneId: '%12', renderQuick() {}, call: async (path, opts) => { log.calls.push([path, opts]); return { status, body }; }, clearProblem() {},
      say: (m) => log.said.push(m), setGone: () => { log.gone += 1; }, showProblem: (m, k) => log.problems.push([m, k]), commandFailure: commandFailureReal, commandSaid: commandSaidReal, problemKind: problemKindReal,
    };
    return { log, sendCommand: mk(['async function sendCommand(text)'], ctx).sendCommand };
  };

  test('(+) F10: a quick-action command (sendCommand) during the hold goes after it, with the button busy meanwhile; with no hold it goes in the same tick', async () => {
    const hold = createRedrawHoldReal({ after: () => 1, cancel() {} });
    const r = cmdRig({ hold });
    hold.start({ want: { cols: 100, rows: 30 }, plainBefore: true });
    const p = r.sendCommand('/compact');
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(r.log.calls, [], 'held');
    hold.end();
    await p;
    assert.equal(r.log.calls.length, 1);
    assert.equal(r.log.calls[0][0], '/api/app/pane/%2512/command');
    const idle = cmdRig();
    idle.sendCommand('/compact');
    assert.equal(idle.log.calls.length, 1, 'no hold: not even a tick of delay');
  });

  test('(+) B5: Rewind posts /rewind to the command route and says it opened the menu in the pane', async () => {
    const r = cmdRig();
    await r.sendCommand('/rewind');
    assert.deepEqual(norm(r.log.calls), [['/api/app/pane/%2512/command', { method: 'POST', json: { text: '/rewind' } }]]);
    assert.deepEqual(r.log.said, ['Opened Rewind in %12: pick a point in the pane']);
  });

  test('(−) B5: the other commands still say "Sent <text> + Enter"; a refusal shows the shared command line', async () => {
    const compact = cmdRig();
    await compact.sendCommand('/compact');
    assert.deepEqual(compact.log.said, ['Sent /compact + Enter to %12']);
    const refused = cmdRig({ status: 409, body: { error: 'input-not-empty', message: 'server text' } });
    await refused.sendCommand('/rewind');
    assert.deepEqual(refused.log.problems, [["Claude's input has a draft. Send or clear it in the terminal, then try again.", 'warn']]);
    assert.deepEqual(refused.log.said, []);
    const lost = cmdRig({ status: 409, body: { error: 'input-unreadable', message: 'server text' } });
    await lost.sendCommand('/rewind');
    assert.deepEqual(lost.log.problems, [["nika can't find Claude's input box, so nothing was typed. Close any menu in the terminal (Esc), then try again.", 'warn']]);
    assert.deepEqual(lost.log.said, []);
  });

  test('(+) B5: Rewind no longer depends on nika\'s message box: quickState gets no composer input, and typing re-renders nothing', () => {
    assert.doesNotMatch(fnOf('function renderQuick()'), /composer/);
    assert.doesNotMatch(fnOf('function updateChip()'), /renderQuick/);
    assert.match(HTML, /id="qa-rewind"[^>]*title="Types \/rewind and Enter: opens Claude&rsquo;s rewind menu in the pane"/);
  });

  // -- B6: the Back label
  const backRig = (projectKey, group) => {
    const log = { proj: null, back: [] };
    const proj = { set textContent(v) { log.proj = v; } };
    mk(['function applyBackLabel(group)'], { projectKey, $: () => proj, setBack: (l) => log.back.push(l) }).applyBackLabel(group);
    return log;
  };

  test('(+) B6: from a project the label and the Back hint name the project', () => {
    assert.deepEqual(backRig('abcdefghij012345', { label: 'demo-api' }), { proj: 'demo-api', back: ['demo-api'] });
  });

  test('(−) B6: opened from the dashboard (no project key) the label stays "Dashboard", whatever group the agent is in', () => {
    assert.deepEqual(backRig(null, { label: 'demo-api' }), { proj: null, back: [] });
    assert.deepEqual(backRig('', { label: 'demo-api' }), { proj: null, back: [] });
    assert.deepEqual(backRig('abcdefghij012345', { label: '' }), { proj: null, back: [] }, 'a group without a label changes nothing');
    assert.deepEqual(backRig('abcdefghij012345', undefined), { proj: null, back: [] });
  });

  // -- B8: follow the pane to its new session after /clear
  const OLD = '11111111-1111-4111-8111-111111111111';
  const NEW = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const KEY = 'abcdefghij012345';
  const agent = (id, pane, live = true) => ({ id, live, name: id.slice(0, 4), pane: pane ? { id: pane } : null });
  const followRig = ({ sessionId = OLD, paneId = '%7', projectKey = null, agents }) => {
    const log = { replaced: [], resets: 0, announced: [], applied: [], notes: [], refreshed: 0 };
    const ctx = {
      sessionId, paneId, projectKey, H: { loaded: true }, A: { projectLooked: true }, followSession: followSessionReal,
      getJSON: async () => ({ groups: [{ label: 'demo', agents }] }), call: async () => ({ status: 200, body: {} }), $: () => ({}),
      history: { replaceState: (...a) => log.replaced.push(a) }, resetHistory: () => { log.resets += 1; }, historyNote: (m) => log.notes.push(m), refreshHistory: () => { log.refreshed += 1; },
      applyAgent: (a) => log.applied.push(a.id), announce: (m) => log.announced.push(m),
    };
    const api = mk(['function followPane(id)', 'async function refreshAgent()'], ctx);
    return { log, ctx, refresh: api.refreshAgent };
  };

  test('(+) B8: the old session ended and one live agent has the pane: the window follows it (URL, empty transcript, new agent, polite note)', async () => {
    const r = followRig({ agents: [agent(OLD, '%7', false), agent(NEW, '%7')] });
    await r.refresh();
    assert.equal(r.ctx.sessionId, NEW);
    assert.deepEqual(r.log.replaced, [[null, '', `?session=${NEW}&pane=%257`]], 'same shape, new id, pane percent-encoded');
    assert.equal(r.log.resets, 1);
    assert.equal(r.ctx.H.loaded, false, 'the transcript loads again from its start');
    assert.equal(r.log.refreshed, 1);
    assert.deepEqual(r.log.applied, [NEW]);
    assert.deepEqual(r.log.announced, ['Claude started a new conversation in this pane.']);
  });

  test('(+) B8: the project key stays in the address', async () => {
    const r = followRig({ projectKey: KEY, agents: [agent(OLD, '%7', false), agent(NEW, '%7')] });
    await r.refresh();
    assert.deepEqual(r.log.replaced, [[null, '', `?session=${NEW}&pane=%257&project=${KEY}`]]);
  });

  test('(−) B8: the old session is still live, or two live agents claim the pane, or the pane is unknown: the window stays', async () => {
    for (const [name, over] of [
      ['old still live', { agents: [agent(OLD, '%7'), agent(NEW, '%7')] }],
      ['two claimants', { agents: [agent(OLD, '%7', false), agent(NEW, '%7'), agent(OTHER, '%7')] }],
      ['no pane id', { paneId: null, agents: [agent(OLD, null, false), agent(NEW, '%7')] }],
      ['other pane', { agents: [agent(OLD, '%7', false), agent(NEW, '%8')] }],
    ]) {
      const r = followRig(over);
      await r.refresh();
      assert.equal(r.ctx.sessionId, OLD, name);
      assert.deepEqual([r.log.replaced, r.log.resets, r.log.announced], [[], 0, []], name);
      assert.deepEqual(r.log.applied, [OLD], `${name}: the header keeps showing the session it was opened for`);
    }
  });

  test('(−) B8: a pane-only window (no session id) never follows: it already shows whatever lives in the pane', async () => {
    const r = followRig({ sessionId: null, agents: [agent(NEW, '%7')] });
    await r.refresh();
    assert.deepEqual([r.log.replaced, r.log.resets, r.log.announced], [[], 0, []]);
    assert.deepEqual(r.log.applied, [NEW]);
  });

  test('(+) B8: session.js takes the session-id and pane-id shapes from quick-actions.js (one copy, no drift between the URL check and followSession)', () => {
    assert.match(SRC, /import \{[^}]*\bSESSION_ID\b[^}]*\bPANE_ID\b[^}]*\} from '\.\/quick-actions\.js'/);
    assert.match(SRC, /param\('pane', PANE_ID\)/);
  });

  test('(−) B8: session.js defines no id regex of its own any more', () => {
    assert.doesNotMatch(SRC, /\/\^\[0-9a-f\]\{8\}-/, 'no UUID literal');
    assert.doesNotMatch(SRC, /\/\^%\\d/, 'no pane id literal');
    assert.doesNotMatch(SRC, /^const (UUID|PANE_ID) = /m);
  });

  test('(+) B8: sessionId is a let, and the follow only ever puts a validated id into the address', () => {
    assert.match(SRC, /let sessionId = param\('session', SESSION_ID\)/);
    assert.match(fnOf('function followPane(id)'), /history\.replaceState\(null, '', `\?\$\{q\.join\('&'\)\}`\)/);
    assert.match(fnOf('async function refreshAgent()'), /followSession\(\{ sessionId, paneId, agents:/);
  });

  // -- B9: Mac wording
  test('(+) B9: the passthrough key reads ctrl-glyph + "]" on a Mac and "Ctrl+]" elsewhere, in the toggle, its title and the banner', () => {
    const run = (mac) => {
      const kbds = [{ textContent: 'Ctrl+]' }, { textContent: 'Ctrl+]' }];
      const toggle = { title: '' };
      mk(['function syncPassKeys()'], { MAC: mac, passKeyLabel, document: { querySelectorAll: (sel) => (sel === 'kbd[data-passkey]' ? kbds : []) }, $: (id) => (id === 'pass-toggle' ? toggle : null) }).syncPassKeys();
      return { kbds: kbds.map((k) => k.textContent), title: toggle.title };
    };
    assert.deepEqual(run(true), { kbds: ['\u2303]', '\u2303]'], title: 'Type straight into the pane (\u2303])' });
    assert.deepEqual(run(false), { kbds: ['Ctrl+]', 'Ctrl+]'], title: 'Type straight into the pane (Ctrl+])' });
  });

  test('(+) B9: the markup marks the two places with data-passkey (the toggle and the banner) and keeps aria-keyshortcuts as Control+]', () => {
    assert.equal([...HTML.matchAll(/<kbd data-passkey>Ctrl\+\]<\/kbd>/g)].length, 2, 'toggle, banner (the hint line no longer has the key)');
    assert.match(HTML, /id="pass-toggle"[^>]*aria-keyshortcuts="Control\+\]"/);
    assert.match(fnOf('function boot()'), /syncPassKeys\(\)/);
  });

  test('(−) B9: no page copy spells the key as separate Ctrl and ] caps any more, and the shortcuts window uses the same glyph', () => {
    assert.doesNotMatch(HTML, /<kbd>Ctrl<\/kbd>\+<kbd>\]<\/kbd>/);
    assert.equal(passKeyLabel(true), '\u2303]');
    assert.equal(passKeyLabel(false), 'Ctrl+]');
  });
});

describe('Task 14b: the header and the 320 px table (markup and stylesheet)', () => {
  const css = strip(CSS);
  const rule = (sel) => new RegExp(`(^|[\\s}])${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? null;
  const header = HTML.slice(HTML.indexOf('<header'), HTML.indexOf('</header>'));

  test('(+) B7: the claude.ai link and the shortcuts button sit in one group of their own, after the spacer; no switcher, reason line or .bar-end wrapper is in the header', () => {
    const at = (needle) => header.indexOf(needle);
    const order = ['class="sp"', 'class="bar-tools"', 'id="claude-link"', 'id="kbd-open"'].map(at);
    assert.ok(order.every((i) => i > 0), 'all four are in the header');
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    const tools = header.slice(at('class="bar-tools"'));
    assert.ok(tools.includes('id="claude-link"') && tools.includes('id="kbd-open"'));
    assert.ok(!header.includes('id="mode-switch"') && !header.includes('id="msw-why"'), 'the switcher moved under the message box');
  });

  test('(−) 0.3.3: no .bar-end in the page or the stylesheet', () => {
    assert.doesNotMatch(HTML, /bar-end/);
    assert.doesNotMatch(css, /bar-end/);
  });

  test('(+) B7: the pair never wraps apart (nowrap); the bar itself still wraps', () => {
    assert.match(rule('.bar-tools') ?? '', /display:\s*flex/);
    assert.match(rule('.bar-tools') ?? '', /flex-wrap:\s*nowrap/);
    assert.match(rule('.bar') ?? '', /flex-wrap:\s*wrap/, 'the bar itself still wraps, so a narrow window moves the block, not a lone button');
  });

  test('(+) 320 px: .composer is a grid with one shrinkable column, so a wide child (the tool row, the mode row) cannot push the window sideways; it stays a size container (no query reads it since F7)', () => {
    const body = rule('.composer') ?? '';
    assert.match(body, /display:\s*grid/);
    assert.match(body, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(body, /container:\s*composer \/ inline-size/);
    const row = rule('.mode-row') ?? '';
    assert.match(row, /flex-wrap:\s*wrap/);
    assert.match(row, /min-width:\s*0/);
  });

  test('(−) 320 px: the one grid with a fixed pixel column (.split, 300 px) collapses to a single shrinkable column below 1000 px, so the composer fix is not undone one level up', () => {
    const wide = [...css.matchAll(/([^{}@]+)\{[^{}]*grid-template-columns:\s*([^;}]*\b\d{3,}px\b[^;}]*)[;}]/g)].map((m) => m[1].trim());
    assert.deepEqual(wide, ['.split'], 'a new fixed-width grid column needs its own 320 px check');
    assert.match(css, /@media \(max-width:\s*1000px\)\s*\{[^@]*?\.split \{ grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  });

  test('(−) B7: the grouping adds no colour and no token', () => {
    for (const sel of ['.bar-tools', '.mode-row']) {
      const body = rule(sel) ?? '';
      assert.doesNotMatch(body, /color|background|border|box-shadow|#[0-9a-f]{3}|rgb|hsl|--[a-z]/i, sel);
    }
    assert.ok(!/--bar/.test(TOKENS) && !/--bar/.test(CSS));
  });

  test('(+) B9: the shortcuts window\'s table sits in a wrapper that scrolls sideways, and the table keeps a width that needs it at 320 px', () => {
    const t = strip(TOKENS);
    assert.match(t, /\.kbd-sec \.tbl-wrap \{[^}]*overflow-x:\s*auto/);
    assert.match(t, /\.kbd-sec \.tbl-wrap \{[^}]*position:\s*relative/, 'a scroll container is also a containing block (test/ui.test.js)');
    assert.match(t, /\.kbd-sec \{[^}]*min-width:\s*0/, 'the grid item may shrink below its table');
    const min = /\.kbd-sec table \{[^}]*min-width:\s*(\d+)px/.exec(t);
    assert.ok(min && Number(min[1]) > 320 - 32 - 32, 'wider than a 320 px window\'s dialog body, so it scrolls in the wrapper');
  });

  test('(−) B9: nothing clips sideways overflow (a clipped table would hide columns); the only horizontal scrollers are the table wrapper and the narrow-screen file strip', () => {
    const all = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.css')).map((f) => [f, strip(read(f))]);
    for (const [f, css] of all) {
      assert.doesNotMatch(css, /overflow-x:\s*hidden/, `${f} clips sideways instead of scrolling`);
      assert.doesNotMatch(css, /(^|[}\s,])(html|body)\s*(,[^{]*)?\{[^}]*overflow/, `${f} hides the page's own overflow`);
    }
    const scrollers = all.flatMap(([f, css]) => [...css.matchAll(/([^{}]+)\{[^{}]*overflow-x:\s*auto[^{}]*\}/g)].map((m) => `${f}: ${m[1].trim()}`));
    assert.deepEqual(scrollers.sort(), ['app.css: .files', 'tokens.css: .kbd-sec .tbl-wrap'], 'a new sideways scroller needs a test of its own');
  });
});

// ---- 0.3.3: arrow batching, the hint line, the mode row, the message box name -------------------------------------------------------

describe('0.3.3: arrow keys from an empty message box are batched (spec 4.2)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }; // the promise callbacks of the rig; the timers are the mock's

  afterEach(() => mock.timers.reset());

  const rig = ({ hold = false } = {}) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const log = { sent: [], said: [] };
    const AR = { buf: [], timer: 0, waiting: 0, sent: [], quiet: 0 };
    const enqueue = (payload) => {
      log.sent.push(payload);
      return hold ? new Promise(() => {}) : Promise.resolve({ ok: true });
    };
    const api = mk(['function queueArrow(key, repeat)', 'function flushArrows()', 'function echoArrows()', 'function endArrows()', 'function setInputEnabled(on, why)'], {
      AR, enqueue, chain: Promise.resolve(), say: (m) => log.said.push(m), paneId: '%12', arrowEcho: arrowEchoReal, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      $: () => ({ focus() {} }), refocus: { composer: false }, closePalette() {}, setPass() {}, idlePlaceholder: () => '', renderSuggestion() {}, ATT: { enable() {} },
      document: { activeElement: null, querySelector: () => ({ classList: { toggle() {} } }) },
    });
    const norm = (v) => JSON.parse(JSON.stringify(v)); // arrays built inside the vm have another Array.prototype
    const keys = () => norm(log.sent.map((p) => p.keys));
    return { ...api, log, AR, keys, buf: () => norm(AR.buf) };
  };

  test('(+) three presses within 50 ms go out as one request at 120 ms; the echo follows 400 ms later', async () => {
    const r = rig();
    r.queueArrow('Down', false);
    mock.timers.tick(20);
    r.queueArrow('Down', false);
    mock.timers.tick(20);
    r.queueArrow('Down', false);
    mock.timers.tick(79);
    assert.deepEqual(r.keys(), [], 'nothing before 120 ms after the first key');
    mock.timers.tick(1);
    assert.deepEqual(r.keys(), [['Down', 'Down', 'Down']]);
    await flush();
    assert.deepEqual(r.log.said, [], 'the echo waits for a quiet moment');
    mock.timers.tick(400);
    await flush();
    assert.deepEqual(r.log.said, ['Sent 3 \u00d7 Down to %12']);
  });

  test('(+) nine presses at once go out as 8 keys (the route\'s maximum) at once and 1 key at 120 ms', () => {
    const r = rig();
    for (let i = 0; i < 9; i += 1) r.queueArrow('Up', false);
    assert.deepEqual(r.keys(), [Array(8).fill('Up')], 'the eighth key flushes at once');
    mock.timers.tick(120);
    assert.deepEqual(r.keys(), [Array(8).fill('Up'), ['Up']]);
  });

  test('(−) with two requests still waiting a repeat is dropped and builds no backlog; a fresh press is kept', () => {
    const r = rig({ hold: true });
    for (let i = 0; i < 16; i += 1) r.queueArrow('Down', false); // two full batches, both held open
    assert.equal(r.AR.waiting, 2);
    r.queueArrow('Down', true);
    assert.deepEqual(r.buf(), [], 'the repeat was dropped');
    r.queueArrow('Down', false);
    assert.deepEqual(r.buf(), ['Down'], 'a fresh press is always kept');
    mock.timers.tick(120);
    assert.equal(r.keys().length, 3);
  });

  test('(−) a repeat is kept while fewer than two requests wait', () => {
    const r = rig({ hold: true });
    for (let i = 0; i < 8; i += 1) r.queueArrow('Left', false); // one batch waiting
    r.queueArrow('Left', true);
    assert.deepEqual(r.buf(), ['Left']);
  });

  test('(+) another action ends the run: the arrows are queued before it and their echo follows', async () => {
    const r = rig();
    r.queueArrow('Down', false);
    r.endArrows();
    r.log.sent.push({ keys: ['Enter'] }); // the Enter the box queues right after endArrows
    assert.deepEqual(r.keys(), [['Down'], ['Enter']], 'the arrow request is recorded before the Enter');
    await flush();
    assert.deepEqual(r.log.said, ['Sent Down to %12']);
    mock.timers.tick(1000);
    await flush();
    assert.deepEqual(r.log.said, ['Sent Down to %12'], 'said once');
  });

  test('(+) a Send click ends the run first: the arrows are queued before the Enter, and the click then focuses the box', () => {
    const order = [];
    const listeners = {};
    const el = (id) => ({ addEventListener(type, f) { listeners[`${id}:${type}`] = f; }, focus() { order.push('focus'); } });
    const ctx = { composer: () => el('composer'), $: el, endArrows: () => order.push('end'), sendComposer: () => order.push('send'), wirePalette() {} };
    vm.runInNewContext(`${fnOf('function wireComposer()')}; wireComposer`, ctx)();
    listeners['send:click']();
    assert.deepEqual(order, ['end', 'send', 'focus']);
  });

  test('(+) the Type into pane button ends the run first; (−) leaving passthrough, a refused start and a second start do not', () => {
    const run = (on, { disabled = false, was = false } = {}) => {
      const log = [];
      const el = () => ({ classList: { toggle() {} }, setAttribute() {}, focus() {}, textContent: '', hidden: false });
      const ctx = { P: { on: was }, paneId: '%12', M: { gone: false }, composer: () => ({ disabled, focus() {} }), flushPass: () => log.push('flush'), $: el, announce() {}, A: { name: 'n' }, endArrows: () => log.push('end'), drawMirror() {} };
      vm.runInNewContext(`${fnOf('function setPass(on, keepFocus = false)')}; setPass`, ctx)(on);
      return log;
    };
    assert.deepEqual(run(true), ['end']);
    assert.deepEqual(run(false, { was: true }), ['flush']);
    assert.deepEqual(run(true, { disabled: true }), [], 'a disabled box refuses to start it');
    assert.deepEqual(run(true, { was: true }), [], 'already on');
  });

  test('(+) a disabled box (pane gone, tmux error) drops the arrows not yet sent: the timer is cleared and nothing goes out', () => {
    const r = rig();
    r.queueArrow('Down', false);
    r.setInputEnabled(false, 'Pane is gone');
    assert.deepEqual(r.buf(), []);
    mock.timers.tick(1000);
    assert.deepEqual(r.keys(), []);
  });

  test('(−) enabling the box leaves a pending run alone', () => {
    const r = rig();
    r.queueArrow('Down', false);
    r.setInputEnabled(true);
    mock.timers.tick(120);
    assert.deepEqual(r.keys(), [['Down']]);
  });

  test('(−) disabling the box does not recall a request that already went out', () => {
    const r = rig();
    for (let i = 0; i < 8; i += 1) r.queueArrow('Up', false);
    r.setInputEnabled(false, 'x');
    assert.equal(r.keys().length, 1, 'the full batch had gone out already');
  });

  test('(−) ending a run that never began sends nothing and says nothing', async () => {
    const r = rig();
    r.endArrows();
    mock.timers.tick(1000);
    await flush();
    assert.deepEqual([r.log.sent, r.log.said], [[], []]);
  });

  test('(−) a refused request is not echoed (only keys the route accepted count)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const log = { said: [] };
    const AR = { buf: [], timer: 0, waiting: 0, sent: [], quiet: 0 };
    const api = mk(['function queueArrow(key, repeat)', 'function flushArrows()', 'function echoArrows()', 'function endArrows()'], {
      AR, enqueue: () => Promise.resolve({ ok: false }), chain: Promise.resolve(), say: (m) => log.said.push(m), paneId: '%12', arrowEcho: arrowEchoReal, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    });
    api.queueArrow('Up', false);
    mock.timers.tick(120);
    await flush();
    mock.timers.tick(400);
    await flush();
    assert.deepEqual(log.said, []);
    assert.equal(AR.waiting, 0);
  });
});

describe('0.3.3: the hint line, the mode row and the message box name (markup, stylesheet, script)', () => {
  const SRC = code(JS['session.js']);
  const css = strip(CSS);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const h = (tag, attrs, ...kids) => ({ tag, class: attrs?.class, text: attrs?.text, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) });
  const plain = (n) => (typeof n === 'string' ? n : n.text ?? n.kids.map(plain).join(''));

  test('(+) F7: the hint line is gone: no #hintline or .hintline, no tip markup, no renderTips or hintTips, and no rule that styled them', () => {
    assert.doesNotMatch(HTML, /hintline|class="tip/);
    assert.doesNotMatch(css, /hintline|\.tip\b/);
    assert.doesNotMatch(SRC, /renderTips|hintTips|hintline/);
    assert.doesNotMatch(code(JS['shortcuts.js']), /hintTips/);
    assert.doesNotMatch(css, /@container composer \(max-width:\s*940px\)/, 'the 940 px query only served the tips'); // 0.5 (W1) adds a 560 px composer query for the dialog form, so only the old width is pinned
  });

  test('(+) F7: #echo stays a polite live region and is visually hidden by the page\'s screen-reader-only class', () => {
    const tag = /<[a-z]+\b[^>]*\bid="echo"[^>]*>/.exec(HTML)?.[0] ?? '';
    assert.match(tag, /\baria-live="polite"/);
    assert.match(tag, /\bclass="sr-only"/);
    assert.doesNotMatch(tag, /\bhidden\b|aria-hidden|display/, 'a hidden node is not announced');
    assert.match(css, /\.sr-only \{[^}]*position:\s*absolute[^}]*clip:\s*rect\(0 0 0 0\)/);
    assert.doesNotMatch(css, /\.echo\b/, 'the visible styling of the echo is gone');
  });

  test('(+) F7: say() still writes the echo text, so the screen reader hears "Sent Enter to %5"', () => {
    const node = { textContent: '' };
    mk(['function say(msg)'], { $: (id) => { assert.equal(id, 'echo'); return node; } }).say('Sent Enter to %5');
    assert.equal(node.textContent, 'Sent Enter to %5');
  });

  test('(+) F7: the notes row keeps the problem line as an alert, the shell hint and the argument hint', () => {
    for (const id of ['problem', 'shell-hint', 'arg-hint']) assert.match(HTML, new RegExp(`id="${id}"`), id);
    assert.match(HTML, /id="problem" role="alert"/);
    assert.match(css, /\.notes \{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
  });

  // -- 0.5 (W11): the notes row takes no height and no gap while none of its four visible parts shows. #notes is a grid item of the composer (gap 6px),
  // so even an empty row would cost one gap. While it is quiet it is the page's screen-reader-only box: position:absolute leaves the grid (no cell,
  // no gap), the clip leaves no pixels, and the echo (a polite live region) and the attachment help stay in the accessibility tree, which display:none
  // would not do. session.js toggles the class from what the four parts show (no :has(), no inline style: the page's CSS rules).
  const notesRig = () => {
    const notes = { quiet: null, toggles: 0, classList: { toggle(name, on) { assert.equal(name, 'quiet'); notes.toggles += 1; notes.quiet = on; return on; } } };
    const nodes = { 'arg-hint': { hidden: true }, 'shell-hint': { hidden: true }, 'draft-note': { hidden: true }, problem: { textContent: '' }, echo: { textContent: '' }, notes };
    return { nodes, notes, $: (id) => { assert.ok(Object.hasOwn(nodes, id), id); return nodes[id]; } };
  };

  test('(+) W11: the notes row starts quiet in the markup, so the first paint has no gap before the script runs', () => {
    assert.match(HTML, /<div class="notes quiet" id="notes">/);
    assert.doesNotMatch(HTML, /id="notes"[^>]*\bhidden\b/, 'the row is never display:none or hidden: the echo lives in it');
  });

  test('(+) W11: .notes.quiet is a screen-reader-only box (absolute, 1px, clipped), never display:none or visibility:hidden; .notes itself still wraps its parts in a flex row', () => {
    const rule = /([^{}]*\.notes\.quiet[^{}]*)\{([^}]*)\}/.exec(css);
    assert.ok(rule, 'a rule for .notes.quiet');
    for (const re of [/position:\s*absolute/, /width:\s*1px/, /height:\s*1px/, /overflow:\s*hidden/, /clip:\s*rect\(0 0 0 0\)/]) assert.match(rule[2], re, String(re));
    assert.doesNotMatch(rule[2], /display:\s*none|visibility:\s*hidden|clip-path|opacity/, 'a node that is not rendered is not announced');
    assert.match(css, /\.notes \{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/);
    assert.doesNotMatch(css, /\.notes\[hidden\]|\.notes:empty/, 'no second way of hiding the row');
  });

  test('(+) W11: syncNotes keeps the row quiet while the argument hint, the shell hint, the draft note and the problem line are all absent, whatever the echo says', () => {
    const rig = notesRig();
    const { syncNotes } = mk(['function syncNotes()'], { $: rig.$ });
    syncNotes();
    assert.equal(rig.notes.quiet, true);
    rig.nodes.echo.textContent = 'Sent Enter to %5'; // the echo is read by screen readers while the row is collapsed; it must not open the row
    syncNotes();
    assert.equal(rig.notes.quiet, true);
  });

  test('(+) W11: each of the four parts shows the row again, and the row goes quiet once the part is gone', () => {
    for (const [id, show, hide] of [
      ['arg-hint', (n) => { n.hidden = false; }, (n) => { n.hidden = true; }],
      ['shell-hint', (n) => { n.hidden = false; }, (n) => { n.hidden = true; }],
      ['draft-note', (n) => { n.hidden = false; }, (n) => { n.hidden = true; }],
      ['problem', (n) => { n.textContent = 'Claude is busy'; }, (n) => { n.textContent = ''; }],
    ]) {
      const rig = notesRig();
      const { syncNotes } = mk(['function syncNotes()'], { $: rig.$ });
      show(rig.nodes[id]);
      syncNotes();
      assert.equal(rig.notes.quiet, false, `${id} shows`);
      hide(rig.nodes[id]);
      syncNotes();
      assert.equal(rig.notes.quiet, true, `${id} gone`);
    }
  });

  test('(−) W11: one part still showing keeps the row open when the others go away', () => {
    const rig = notesRig();
    const { syncNotes } = mk(['function syncNotes()'], { $: rig.$ });
    rig.nodes['shell-hint'].hidden = false;
    rig.nodes.problem.textContent = 'x';
    syncNotes();
    rig.nodes.problem.textContent = '';
    syncNotes();
    assert.equal(rig.notes.quiet, false, 'the shell hint is still up');
  });

  test('(+) W11: watchNotes watches the row and its parts (children, text, the hidden attribute: not class, so its own toggle cannot loop), syncs once at once and again on every change', () => {
    const rig = notesRig();
    const made = [];
    class FakeObserver { constructor(cb) { this.cb = cb; made.push(this); } observe(target, opts) { this.target = target; this.opts = opts; } }
    const { watchNotes } = mk(['function syncNotes()', 'function watchNotes()'], { $: rig.$, MutationObserver: FakeObserver });
    watchNotes();
    assert.equal(made.length, 1);
    assert.equal(made[0].target, rig.notes);
    assert.deepEqual(JSON.parse(JSON.stringify(made[0].opts)), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    assert.equal(rig.notes.quiet, true, 'synced when wired');
    rig.nodes['arg-hint'].hidden = false;
    made[0].cb([]);
    assert.equal(rig.notes.quiet, false);
    rig.nodes['arg-hint'].hidden = true;
    made[0].cb([]);
    assert.equal(rig.notes.quiet, true);
  });

  test('(+) W11: boot wires the watcher, and the problem line keeps its alert role and the echo its live region inside the quiet row', () => {
    assert.match(code(JS['session.js']), /\bwatchNotes\(\);/);
    assert.match(HTML, /id="problem" role="alert"/);
    assert.match(/<[a-z]+\b[^>]*\bid="echo"[^>]*>/.exec(HTML)?.[0] ?? '', /\baria-live="polite"/);
    assert.ok(HTML.indexOf('id="notes"') < HTML.indexOf('id="echo"') && HTML.indexOf('id="echo"') < HTML.indexOf('id="att-help"'));
  });

  test('(−) the 760 px block no longer hides the tips or the switcher\'s words', () => {
    const block = /@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    assert.ok(block.length > 50, 'the block was found');
    assert.doesNotMatch(block, /\.hintline/);
    assert.doesNotMatch(block, /\.msw/);
    assert.match(block, /\.bar \.btn \.lbl, \.term-head \.btn \.lbl/, 'the header buttons still drop their labels');
  });

  test('(+) the message box name says where the keys go, in the markup and for a named agent', () => {
    const tail = ' Enter sends, Shift+Enter adds a line. Escape and Control+C go to Claude; so does Shift+Tab when no question or prompt is open, and the arrow keys and Enter when the box is empty. Control+Shift+Tab moves focus back.';
    assert.match(HTML, new RegExp(`<label for="composer" class="sr-only" id="composer-label">Message to the agent\\.${tail.replace(/[.+]/g, '\\$&')}</label>`));
    assert.ok(fnOf('function applyAgent(').includes(`Message to \${A.name}.${tail}`));
  });

  test('(+) wireSwitcher shows the mode row, and a press on the switcher keeps the focus in the message box', () => {
    const listeners = {};
    const bar = { hidden: true, append() {}, addEventListener(type, f) { listeners[type] = f; } };
    const row = { hidden: true };
    const box = {};
    const doc = { activeElement: box };
    const ctx = {
      $: (id) => (id === 'mode-row' ? row : bar), MODE_TARGETS, MODE_META, h: (tag, attrs) => ({ tag, attrs }), icon: () => ({}), switchTo() {}, tabStops() {}, roveKeys() {}, renderMode() {},
      composer: () => box, document: doc, SW: { parts: [] },
    };
    mk(['function wireSwitcher()'], ctx).wireSwitcher();
    assert.equal(row.hidden, false);
    assert.equal(bar.hidden, false);
    assert.equal(ctx.SW.parts.length, 4);
    let prevented = 0;
    listeners.mousedown({ preventDefault() { prevented += 1; } });
    assert.equal(prevented, 1, 'focus was in the box: the press does not take it');
  });

  test('(−) without focus in the box a press on the switcher is left alone (it works as built)', () => {
    const listeners = {};
    const doc = { activeElement: {} };
    const ctx = {
      $: () => ({ hidden: true, append() {}, addEventListener(type, f) { listeners[type] = f; } }), MODE_TARGETS, MODE_META, h: (tag, attrs) => ({ tag, attrs }), icon: () => ({}), switchTo() {}, tabStops() {}, roveKeys() {}, renderMode() {},
      composer: () => ({}), document: doc, SW: { parts: [] },
    };
    mk(['function wireSwitcher()'], ctx).wireSwitcher();
    let prevented = 0;
    listeners.mousedown({ preventDefault() { prevented += 1; } });
    assert.equal(prevented, 0);
  });

  test('(−) the pane-less window shows no mode row: only wireSwitcher unhides it, and it is only called with a pane', () => {
    assert.equal((SRC.match(/\$\('mode-row'\)\.hidden = false/g) ?? []).length, 1);
    assert.match(fnOf('function boot()'), /if \(paneId\) \{\s*wireSwitcher\(\);/);
  });

  test('(−) the removed key row left nothing behind in the script: no renderGatedKeys, no keyTitle, no .key lookups', () => {
    assert.doesNotMatch(SRC, /renderGatedKeys|keyTitle|querySelectorAll\('\.key'\)/);
    assert.doesNotMatch(fnOf('function setInputEnabled('), /\.key\b/);
  });
});


// ---- 0.3.4: the transcript toggle (docs/design/spec.md 4.1 and 6) ----------------------------------------------------------------

describe('0.3.4: the transcript toggle', () => {
  const SRC = code(JS['session.js']);
  const css = strip(CSS);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const tagOf = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';
  const head = /<div class="term-head"[^>]*>([\s\S]*?)<div class="pass-banner"/.exec(HTML)?.[1] ?? '';

  test('(+) #hist-toggle is the first control of .term-head: a pressed .btn that controls the transcript, with icon, word and on/off chip', () => {
    const btn = tagOf('hist-toggle');
    assert.match(btn, /^<button type="button" class="btn"/);
    assert.match(btn, /aria-pressed="true"/);
    assert.match(btn, /aria-controls="sess-hist"/);
    assert.match(btn, /aria-keyshortcuts="Control\+Shift\+H"/);
    assert.match(btn, /title="Show or hide the transcript \(Ctrl\+Shift\+H\)"/);
    assert.match(head.trim(), /^<button\b[^>]*\bid="hist-toggle"/, 'first in the head');
    assert.match(head, /<button\b[^>]*\bid="hist-toggle"[^>]*><svg class="ic" aria-hidden="true"><use id="hist-use" href="#i-hist-on"\/><\/svg><span class="lbl">Transcript<\/span><span class="onoff" id="hist-onoff" aria-hidden="true">on<\/span><\/button>/);
    assert.ok(HTML.indexOf('id="hist-toggle"') < HTML.indexOf('id="live-label"'), 'before the live dot');
  });

  test('(+) both icons are in the sprite: a frame and a divider, with three lines on the left for "on"', () => {
    const on = /<symbol id="i-hist-on"[^>]*>([\s\S]*?)<\/symbol>/.exec(HTML)?.[1] ?? '';
    const off = /<symbol id="i-hist-off"[^>]*>([\s\S]*?)<\/symbol>/.exec(HTML)?.[1] ?? '';
    assert.match(on, /<rect\b/);
    assert.match(off, /<rect\b/);
    assert.notEqual(on, off, 'the two states look different');
    assert.ok(on.length > off.length, 'on draws the lines the off icon leaves out');
  });

  test('(+) wide windows: .hist-off gives the terminal the full width; narrow windows keep their tabs and hide the button', () => {
    assert.match(css, /@media \(min-width: 1001px\)\s*\{[^@]*\.split\.hist-off:not\(\.no-term\)\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);\s*\}[^@]*\.split\.hist-off:not\(\.no-term\) \.hist\s*\{\s*display:\s*none;\s*\}/);
    const narrow = /@media \(max-width: 1000px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    assert.match(narrow, /#hist-toggle\s*\{\s*display:\s*none;\s*\}/);
    assert.doesNotMatch(css, /\.hist-off[^{]*\.pane-tabs|\.split\.hist-off[^{]*\.termcol/, 'the narrow tab and the terminal stay');
  });

  test('(+) the state is told in words, colour and icon: the shared pressed look and the on/off chip', () => {
    assert.match(css, /\.btn\[aria-pressed="true"\]\s*\{[^}]*background: var\(--accent-soft\)/);
    assert.match(fnOf('function setHist('), /'#i-hist-on' : '#i-hist-off'/);
    assert.match(fnOf('function setHist('), /'on' : 'off'/);
    assert.match(fnOf('function setHist('), /setAttribute\('aria-pressed', String\(on\)\)/);
  });

  // ---- behaviour, run for real in a vm against fakes ----

  const classList = (initial = []) => {
    const set = new Set(initial);
    return { contains: (c) => set.has(c), toggle(c, force) { const on = force === undefined ? !set.has(c) : Boolean(force); if (on) set.add(c); else set.delete(c); return on; }, has: (c) => set.has(c) };
  };
  /** A page with the toggle: `store` is the shared localStorage (a Map), so a second rig on the same store is a reload. */
  const rig = ({ store = new Map(), broken = false, narrow = false, flags = [], focusInHist = false } = {}) => {
    const log = { said: [], writes: 0 };
    const inside = { id: 'inside-the-transcript' };
    const outside = { id: 'somewhere-else' };
    const doc = { activeElement: focusInHist ? inside : outside };
    const node = (id) => ({
      id, attrs: {}, textContent: '', focused: 0, listeners: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(type, f) { this.listeners[type] = f; },
      focus() { this.focused += 1; doc.activeElement = this; },
    });
    const els = Object.fromEntries(['split', 'sess-hist', 'hist-scroll', 'hist-toggle', 'hist-use', 'hist-onoff'].map((id) => [id, node(id)]));
    els.split.classList = classList(flags);
    // a browser drops focus from an element that becomes display:none: the fake does it the moment hist-off is set, so a read of
    // document.activeElement after the class flip sees the body, not the element that held focus
    const flip = els.split.classList.toggle;
    els.split.classList.toggle = (c, force) => {
      const on = flip(c, force);
      if (c === 'hist-off' && on && doc.activeElement === inside) doc.activeElement = outside;
      return on;
    };
    Object.assign(els['hist-scroll'], { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });
    els['sess-hist'].contains = (n) => n === inside;
    const localStorage = {
      getItem(k) { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { if (broken) throw new Error('blocked'); log.writes += 1; store.set(k, String(v)); },
    };
    const api = mk(['function storeGet(key)', 'function storeSet(key, value)', 'function histToggleable()', 'function setHist(on, user = false)', 'function toggleHist()', 'function wireHist()'], {
      $: (id) => els[id], document: doc, localStorage, window: { matchMedia: () => ({ matches: narrow }) }, announce: (m) => log.said.push(m),
      HIST: { at: null }, nearBottom: vm.runInNewContext(`${/const nearBottom = [^\n]*/.exec(SRC)[0]}; nearBottom`),
    });
    const state = () => ({ hidden: els.split.classList.has('hist-off'), pressed: els['hist-toggle'].attrs['aria-pressed'], icon: els['hist-use'].attrs.href, word: els['hist-onoff'].textContent });
    return { ...api, els, log, store, state, inside, click: () => els['hist-toggle'].listeners.click() };
  };
  const SHOWN = { hidden: false, pressed: 'true', icon: '#i-hist-on', word: 'on' };
  const HIDDEN = { hidden: true, pressed: 'false', icon: '#i-hist-off', word: 'off' };

  test('(+) the toggle hides and shows the transcript, sets aria-pressed, swaps the icon and the word, says what happened and keeps the choice', () => {
    const r = rig();
    r.wireHist();
    assert.deepEqual(r.state(), SHOWN, 'shown by default');
    assert.deepEqual(r.log.said, [], 'nothing is announced at load');
    r.click();
    assert.deepEqual(r.state(), HIDDEN);
    assert.deepEqual(r.log.said, ['Transcript hidden']);
    assert.equal(r.store.get('nika.transcript'), 'hidden');
    r.click();
    assert.deepEqual(r.state(), SHOWN);
    assert.deepEqual(r.log.said, ['Transcript hidden', 'Transcript shown']);
    assert.equal(r.store.get('nika.transcript'), 'shown');
  });

  test('(+) the choice persists across a reload (the same storage, a fresh page)', () => {
    const store = new Map();
    const first = rig({ store });
    first.wireHist();
    first.click();
    const second = rig({ store });
    second.wireHist();
    assert.deepEqual(second.state(), HIDDEN);
    assert.deepEqual(second.log.said, [], 'applied at boot without a word');
    assert.equal(second.log.writes, 0, 'and without a write');
    second.click();
    const third = rig({ store });
    third.wireHist();
    assert.deepEqual(third.state(), SHOWN);
  });

  test('(−) garbage in storage means shown; only the exact word "hidden" hides', () => {
    for (const value of ['banana', '', 'HIDDEN', 'hidden ', ' hidden', 'true', '0', '{"transcript":"hidden"}', 'shown']) {
      const r = rig({ store: new Map([['nika.transcript', value]]) });
      r.wireHist();
      assert.deepEqual(r.state(), SHOWN, JSON.stringify(value));
    }
  });

  test('(−) storage that throws means shown, and the toggle still works', () => {
    const r = rig({ broken: true });
    r.wireHist();
    assert.deepEqual(r.state(), SHOWN);
    r.click();
    assert.deepEqual(r.state(), HIDDEN);
    assert.deepEqual(r.log.said, ['Transcript hidden']);
    r.click();
    assert.deepEqual(r.state(), SHOWN);
  });

  test('(+) hiding while focus is inside the transcript moves focus to the toggle (focus is read before the column goes, as a browser drops it with the column)', () => {
    const r = rig({ focusInHist: true });
    r.wireHist();
    r.toggleHist();
    assert.deepEqual(r.state(), HIDDEN);
    assert.equal(r.els['hist-toggle'].focused, 1);
  });

  test('(−) focus elsewhere stays where it is, and showing never moves it', () => {
    const r = rig();
    r.wireHist();
    r.toggleHist();
    assert.equal(r.els['hist-toggle'].focused, 0, 'hiding with focus in the message box');
    r.toggleHist();
    assert.equal(r.els['hist-toggle'].focused, 0, 'showing');
  });

  test('(+) showing again puts the reader back where they were in the transcript (a hidden column loses its scroll offset)', () => {
    const r = rig();
    r.wireHist();
    const sc = r.els['hist-scroll'];
    sc.scrollTop = 300; // reading older entries: not near the bottom (1000 - 300 - 400 = 300)
    r.toggleHist();
    sc.scrollTop = 0; // what a display:none column ends up with
    sc.scrollHeight = 0;
    r.toggleHist();
    sc.scrollHeight = 1000;
    assert.equal(sc.scrollTop, 300);
  });

  test('(+) a reader who was at the bottom is at the bottom again, entries that arrived meanwhile included', () => {
    const r = rig();
    r.wireHist();
    const sc = r.els['hist-scroll'];
    sc.scrollTop = 600; // 1000 - 600 - 400 = 0: at the bottom
    r.toggleHist();
    sc.scrollTop = 0;
    sc.scrollHeight = 1300; // laid out again, with new entries
    r.toggleHist();
    assert.equal(sc.scrollTop, 1300);
  });

  test('(−) the scroll place is only touched when the column comes back: not at load, not when hiding, not when it was never hidden', () => {
    const r = rig();
    const sc = r.els['hist-scroll'];
    sc.scrollTop = 123;
    r.wireHist();
    assert.equal(sc.scrollTop, 123, 'shown at load: untouched');
    r.toggleHist();
    assert.equal(sc.scrollTop, 123, 'hiding does not write it');
    const hiddenAtLoad = rig({ store: new Map([['nika.transcript', 'hidden']]) });
    hiddenAtLoad.els['hist-scroll'].scrollTop = 77;
    hiddenAtLoad.wireHist();
    assert.equal(hiddenAtLoad.els['hist-scroll'].scrollTop, 77, 'hidden at load: untouched');
  });

  test('(−) no transcript, no terminal, or a narrow window (tabs): the toggle does nothing at all', () => {
    for (const opts of [{ flags: ['no-hist'] }, { flags: ['no-term'] }, { narrow: true }]) {
      const r = rig(opts);
      r.wireHist();
      r.toggleHist();
      assert.deepEqual(r.state().hidden, false, JSON.stringify(opts));
      assert.deepEqual([r.log.said, r.log.writes], [[], 0], JSON.stringify(opts));
    }
  });

  test('(−) a saved "hidden" is still applied to the class when the window is narrow, has no transcript or has no terminal; the stylesheet decides what shows', () => {
    for (const opts of [{ narrow: true }, { flags: ['no-hist'] }, { flags: ['no-term'] }]) {
      const r = rig({ store: new Map([['nika.transcript', 'hidden']]), ...opts });
      r.wireHist();
      assert.deepEqual(r.state(), HIDDEN, JSON.stringify(opts));
    }
    // ... and it never hides the transcript of a window with no terminal (the column would leave an empty window), nor applies below 1001 px
    const rules = /@media \(min-width: 1001px\)\s*\{([^@]*)\}\s*\n/.exec(css)?.[1] ?? '';
    assert.match(rules, /\.hist-off:not\(\.no-term\) \.hist/);
    assert.doesNotMatch(css.replace(/@media \(min-width: 1001px\)\s*\{[^@]*\}\s*\n/, ''), /hist-off/, 'the class has no effect outside that media query');
  });

  test('(+) syncHistHint puts the platform\'s key in the title and aria-keyshortcuts', () => {
    const run = (mac) => {
      const btn = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      mk(['function syncHistHint()'], { MAC: mac, histHint, $: () => btn }).syncHistHint();
      return [btn.title, btn.attrs['aria-keyshortcuts']];
    };
    assert.deepEqual(run(false), ['Show or hide the transcript (Ctrl+Shift+H)', 'Control+Shift+H']);
    assert.deepEqual(run(true), ['Show or hide the transcript (\u2318\u21e7H)', 'Meta+Shift+H']);
  });

  test('(+) boot: the hint and the saved choice are applied, the click is wired, and the button hides when there is no transcript', () => {
    const boot = fnOf('function boot()');
    assert.match(boot, /syncHistHint\(\)/);
    assert.match(boot, /wireHist\(\)/);
    assert.equal((SRC.match(/wireHist\(\)/g) ?? []).length, 2, 'declared once, called once');
    const noHist = boot.slice(boot.indexOf("split.classList.add('no-hist')"), boot.indexOf("showNotice('No transcript"));
    assert.match(noHist, /\$\('hist-toggle'\)\.hidden = true/);
    assert.match(fnOf('function onPageKey(e)'), /wantsHistToggle\(e, \{ mac: MAC, passthrough: P\.on, dialogOpen \}\)/);
  });

  test('(−) the choice is stored under nika.transcript with the values shown and hidden only, through the guarded storeSet', () => {
    assert.match(fnOf('function setHist('), /storeSet\('transcript', on \? 'shown' : 'hidden'\)/);
    assert.match(fnOf('function wireHist()'), /storeGet\('transcript'\) !== 'hidden'/);
    assert.doesNotMatch(SRC.replace(/function storeGet[\s\S]*?\n\}\n[\s\S]*?function storeSet[\s\S]*?\n\}\n/, ''), /localStorage/, 'no other storage call');
  });
});


// ---- F2: Type into pane keys, copy, window keys ------------------------------------------------------------------------------------

describe('F2: Type into pane keys (wirePassthrough), copy, and the window keys', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);

  /** wirePassthrough against stubs, with the real keyForEvent and planPaste. */
  const rig = ({ mac = false, on = true } = {}) => {
    const log = { keys: [], copies: 0, problems: [], text: [], pastes: [], flushes: 0 };
    const handlers = {};
    const term = { addEventListener: (type, f) => { handlers[type] = f; } };
    const ctx = {
      $: (id) => (id === 'term' ? term : { addEventListener() {} }), MAC: mac, P: { on, buf: '', timer: 0 },
      keyForEvent: keyForEventReal, planPaste: planPasteReal, setTimeout: () => 1, setPass() {}, say() {}, paneId: '%7',
      flushPass: () => { log.flushes += 1; }, sendKey: (k) => log.keys.push(k), copySelection: () => { log.copies += 1; },
      showProblem: (m) => log.problems.push(m), enqueue: async (payload) => { log.pastes.push(payload); return { ok: true }; },
    };
    mk(['function wirePassthrough()'], ctx).wirePassthrough();
    const mkEvent = (key, over) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; }, ...over });
    return {
      log, ctx,
      press: (key, over = {}) => {
        const e = mkEvent(key, over);
        handlers.keydown(e);
        return e;
      },
      paste: (text) => {
        const e = { prevented: 0, preventDefault() { this.prevented += 1; }, clipboardData: { getData: () => text } };
        handlers.paste(e);
        return e;
      },
    };
  };

  test('(+) Ctrl+C sends C-c to Claude and is consumed', () => {
    const r = rig();
    const e = r.press('c', { ctrlKey: true });
    assert.deepEqual(r.log.keys, ['C-c']);
    assert.deepEqual([e.prevented, e.stopped], [1, 1]);
    assert.equal(r.log.copies, 0);
  });

  test('(+) Ctrl+Shift+C copies the mirror\'s selection: it sends no key and the key is consumed', () => {
    for (const mac of [false, true]) {
      const r = rig({ mac });
      const e = r.press('C', { ctrlKey: true, shiftKey: true });
      assert.equal(r.log.copies, 1, `mac ${mac}`);
      assert.deepEqual(r.log.keys, []);
      assert.deepEqual([e.prevented, e.stopped], [1, 1]);
    }
  });

  test('(+) Linux: Ctrl+V and Ctrl+Shift+V are left to the browser (not prevented, nothing sent), and the paste event then goes to Claude as one paste', () => {
    const r = rig();
    for (const e of [r.press('v', { ctrlKey: true }), r.press('V', { ctrlKey: true, shiftKey: true })]) assert.deepEqual([e.prevented, e.stopped], [0, 0], e.key);
    assert.deepEqual(r.log.keys, []);
    assert.equal(r.paste('hello').prevented, 1, 'the paste handler takes it over');
    assert.deepEqual(r.log.pastes, [{ text: 'hello' }]);
    assert.deepEqual(r.log.problems, []);
  });

  test('(+) Linux: Ctrl+Q and the zoom keys are left to the window handler on the document: not prevented, not stopped, nothing sent to the pane', () => {
    const r = rig();
    for (const [key, over] of [['q', {}], ['=', {}], ['+', { shiftKey: true }], ['-', {}], ['0', {}]]) {
      const e = r.press(key, { ctrlKey: true, ...over });
      assert.deepEqual([e.prevented, e.stopped], [0, 0], key);
    }
    assert.deepEqual(r.log.keys, []);
    assert.deepEqual(r.log.problems, [], 'no "Not sent" message for a key that is not meant for the pane');
  });

  test('(−) Ctrl+W goes to Claude as C-w in Type into pane (it is not Close)', () => {
    const r = rig();
    const e = r.press('w', { ctrlKey: true });
    assert.deepEqual(r.log.keys, ['C-w']);
    assert.deepEqual([e.prevented, e.stopped], [1, 1]);
  });

  test('(−) macOS: Ctrl+V and Ctrl+Q are not on the allow-list (the user sees why); Command keys are left to the app', () => {
    const r = rig({ mac: true });
    r.press('v', { ctrlKey: true });
    r.press('q', { ctrlKey: true });
    assert.equal(r.log.problems.length, 2);
    assert.match(r.log.problems[0], /Not sent: Ctrl-v is not on the allow-list/);
    const e = r.press('v', { metaKey: true });
    assert.deepEqual([e.prevented, e.stopped], [0, 0]);
    assert.deepEqual(r.log.keys, []);
  });

  test('(−) with Type into pane off the handler does nothing at all', () => {
    const r = rig({ on: false });
    for (const e of [r.press('c', { ctrlKey: true }), r.press('C', { ctrlKey: true, shiftKey: true }), r.press('q', { ctrlKey: true })]) assert.deepEqual([e.prevented, e.stopped], [0, 0]);
    assert.deepEqual(r.log.keys, []);
    assert.equal(r.log.copies, 0);
  });

  // -- copySelection
  const copyRig = ({ selection, writeText = async () => {} } = {}) => {
    const log = { written: [], said: [], problems: [] };
    const inside = new Set(['a', 'b']);
    const ctx = {
      $: () => ({ contains: (n) => inside.has(n) }), document: { getSelection: () => selection },
      navigator: { clipboard: { writeText: async (t) => { log.written.push(t); return writeText(t); } } },
      say: (m) => log.said.push(m), showProblem: (m, kind, ms) => log.problems.push([m, kind, ms]),
    };
    return { log, copy: mk(['async function copySelection()'], ctx).copySelection };
  };
  const sel = (text, over = {}) => ({ isCollapsed: false, anchorNode: 'a', focusNode: 'b', toString: () => text, ...over });

  test('(+) copySelection writes the selected text of the mirror to the clipboard and says so', async () => {
    const r = copyRig({ selection: sel('npm test\nall green') });
    await r.copy();
    assert.deepEqual(r.log.written, ['npm test\nall green']);
    assert.deepEqual(r.log.said, ['Copied 18 characters']);
    assert.deepEqual(r.log.problems, []);
  });

  test('(−) copySelection copies nothing for no selection, a collapsed one, or one that reaches outside the mirror, and says what to do', async () => {
    for (const selection of [null, undefined, sel('x', { isCollapsed: true }), sel('x', { anchorNode: 'out' }), sel('x', { focusNode: 'out' }), sel('')]) {
      const r = copyRig({ selection });
      await r.copy();
      assert.deepEqual(r.log.written, [], JSON.stringify(selection));
      assert.equal(r.log.problems.length, 1);
      assert.deepEqual(r.log.problems[0].slice(1), ['warn', 3000]);
      assert.match(r.log.problems[0][0], /Select text in the terminal/);
    }
  });

  test('(−) copySelection: a clipboard that refuses is reported, not thrown', async () => {
    const r = copyRig({ selection: sel('abc'), writeText: async () => { throw new Error('denied'); } });
    await r.copy();
    assert.deepEqual(r.log.said, []);
    assert.deepEqual(r.log.problems, [['Could not copy the selection.', 'warn', 3000]]);
  });

  // -- the window keys on the session page
  test('(+) boot wires the window keys once, in the app tier, with the platform, the live Type into pane flag and the shell relay', () => {
    const boot = fnOf('function boot()');
    assert.match(boot, /wireWindowKeys\(\{ mac: MAC, passthrough: \(\) => P\.on, send: windowCommand \}\);/);
    assert.equal((SRC.match(/wireWindowKeys\(/g) ?? []).length, 1);
    assert.ok(boot.indexOf('wireWindowKeys(') > boot.indexOf('if (!appMode)'), 'after the browser-tier early return');
    assert.match(JS['session.js'], /import \{[^}]*\bwindowCommand\b[^}]*\} from '\.\/api\.js';/);
    assert.match(JS['session.js'], /import \{[^}]*\bwireWindowKeys\b[^}]*\} from '\.\/shortcuts\.js';/);
  });

  test('(+) the session page\'s window keys run for real: Ctrl+Q while typing into the pane reaches the shell relay, Ctrl+W does not', () => {
    const doc = { listeners: [], addEventListener(type, f) { if (type === 'keydown') this.listeners.push(f); } };
    const prevDoc = globalThis.document;
    globalThis.document = doc;
    try {
      const P = { on: true };
      const sent = [];
      wireWindowKeysReal({ mac: false, passthrough: () => P.on, send: (a) => sent.push(a) });
      const press = (key) => doc.listeners[0]({ key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault() {} });
      press('q');
      press('w');
      P.on = false;
      press('w');
      assert.deepEqual(sent, ['quit', 'close']);
    } finally {
      if (prevDoc === undefined) delete globalThis.document;
      else globalThis.document = prevDoc;
    }
  });
});

// ---- 0.5: draft sync (W5) and the cut (W6) ---------------------------------------------------------------------------------------
// The functions of session.js run for real in a vm against stubs; the pure rules (public/draft-sync.js) are the real ones.

describe('0.5: the cut and the draft note (markup and stylesheet)', () => {
  const css = strip(CSS);
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';

  test('(+) the strip is one hidden, aria-hidden row at the end of the mirror, with the keyboard icon and its words', () => {
    const t = tag('term-cut');
    assert.match(t, /\bclass="tl cut"/);
    assert.match(t, /\bhidden\b/);
    assert.match(t, /\baria-hidden="true"/);
    const block = /<div class="tl cut"[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? '';
    assert.match(block, /<use href="#i-kbd"\/>/);
    assert.match(block, /Input box &middot; mirrored in the message box below/);
    const term = HTML.slice(HTML.indexOf('<div class="term"'), HTML.indexOf('<span class="paused-note"'));
    assert.ok(term.indexOf('id="term-rows"') < term.indexOf('id="term-cut"'), 'after the rows');
    assert.doesNotMatch(block, /tabindex|<button|<a /, 'not focusable');
  });

  test('(+) the draft note is a polite status line in the notes row, before the problem line, hidden until a state shows; the box points at it', () => {
    const t = tag('draft-note');
    assert.match(t, /\bclass="dnote"/);
    assert.match(t, /\brole="status"/);
    assert.match(t, /\bhidden\b/);
    assert.ok(HTML.indexOf('id="notes"') < HTML.indexOf('id="draft-note"') && HTML.indexOf('id="draft-note"') < HTML.indexOf('id="problem"'));
    assert.match(tag('composer'), /\baria-describedby="draft-note"/);
  });

  test('(+) the sprite draws every note icon: paused, long, hold, cursor, queued and suggest each have their own, and the page draws no other', () => {
    const icons = ['paused', 'long', 'hold', 'cursor', 'queued', 'suggest'].map((k) => noteViewReal({ kind: k, reason: 'tall' }).icon);
    assert.deepEqual(icons, ['pause', 'info', 'dialog', 'window', 'send', 'kbd']);
    assert.equal(new Set(icons).size, 6);
    for (const n of icons) assert.match(HTML, new RegExp(`<symbol id="i-${n}"`), n);
  });

  test('(+) the strip is muted terminal ink on its own row; each note kind has its own colour (paused, long, hold, cursor, queued, suggest) and a bold word', () => {
    assert.match(css, /\.tl\.cut\s*\{[^}]*display:\s*flex[^}]*color:\s*var\(--a8\)/);
    const KINDS = ['paused', 'long', 'hold', 'cursor', 'queued', 'suggest'];
    for (const k of KINDS) assert.match(css, new RegExp(`\\.dnote\\[data-k="${k}"\\]\\s*\\{[^}]*color:\\s*var\\(--[a-z-]+\\)`), k);
    const colours = KINDS.map((k) => new RegExp(`\\.dnote\\[data-k="${k}"\\]\\s*\\{[^}]*color:\\s*(var\\(--[a-z-]+\\))`).exec(css)[1]);
    assert.equal(new Set(colours).size, 6, `six kinds, six colours: ${colours}`);
    assert.doesNotMatch(css, /\.dnote\[data-k="wait"\]/, 'the old wait rule is gone');
    for (const [k, fg, bg] of [['hold', '--attn', '--attn-soft'], ['cursor', '--fit-other', '--fit-other-soft'], ['queued', '--busy', '--busy-soft']]) {
      assert.match(css, new RegExp(`\\.dnote\\[data-k="${k}"\\]\\s*\\{[^}]*color:\\s*var\\(${fg}\\)[^}]*background:\\s*var\\(${bg}\\)`), `${k}: ${fg} on ${bg}`);
    }
    assert.match(css, /\.dnote\s*\{[^}]*display:\s*inline-flex/);
    assert.match(css, /\.dnote b\s*\{[^}]*font-weight:\s*(600|700)/);
  });

  test('(−) no inline style anywhere for the new parts, and the new files stay out of the sinks', () => {
    assert.doesNotMatch(HTML, /\sstyle\s*=/i);
    assert.deepEqual(findSinks(JS['draft-sync.js']), []);
  });
});

describe('0.5: drawing the mirror with the cut (design W6, section 5)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const row = (t) => [{ t, s: {} }];
  const BODY = { cols: 120, rows: Array.from({ length: 12 }, (_, i) => row(`row ${i}`)), cursor: { x: 2, y: 10, visible: true } };
  const BOX = { top: 8, bottom: 11 };
  const readable = (state = 'text', over = {}) => ({ state, mode: 'prompt', text: state === 'text' ? 'hello' : '', sig: '0000000000000001', box: BOX, cursorAtEnd: true, suggestion: null, queued: false, ...over });
  const unreadable = { state: 'unreadable', mode: 'prompt', text: '', sig: null, reason: 'pasted', box: BOX, cursorAtEnd: false, suggestion: null };

  // F11: the page's terminal element is a stand-in with scrollTop / scrollHeight (drawMirror re-pins it), and M carries the cut drawn (`cut: 'unset'` before any draw)
  const draw = ({ body = BODY, draft, pass = false, frozen = false }) => {
    const out = { calls: [], strip: { hidden: true }, term: { scrollTop: 0, scrollHeight: 500 } };
    const ctx = {
      M: { body, draft, frozen, cut: 'unset' }, P: { on: pass }, cutAt: cutAtReal, cutCursor: cutCursorReal, toRenderModel: toRenderModelReal,
      applyMirror: (container, model, cursor) => out.calls.push({ container, rows: model.length, last: model.at(-1)?.[0]?.text, cursor }),
      $: (id) => (id === 'term-cut' ? out.strip : id === 'term' ? out.term : id),
    };
    vm.runInNewContext(`${fnOf('function drawMirror()')}; drawMirror`, ctx)();
    return { ...out, call: out.calls[0], M: ctx.M };
  };

  test('(+) a readable draft with Type into pane off: the rows above the input box, no cursor, the strip shown', () => {
    for (const state of ['text', 'empty']) {
      const r = draw({ draft: readable(state) });
      assert.equal(r.calls.length, 1);
      assert.equal(r.call.container, 'term-rows');
      assert.equal(r.call.rows, 8, state);
      assert.equal(r.call.last, 'row 7');
      assert.equal(r.call.cursor, null, 'the cursor sat in the hidden box');
      assert.equal(r.strip.hidden, false, state);
    }
  });

  test('(−) an unreadable draft: every row, the cursor, no strip (the user must see what Enter would send)', () => {
    const r = draw({ draft: unreadable });
    assert.equal(r.call.rows, 12);
    assert.deepEqual(norm(r.call.cursor), BODY.cursor);
    assert.equal(r.strip.hidden, true);
  });

  test('(−) no plain box (a prompt, a dialog): every row, no strip', () => {
    const r = draw({ draft: null });
    assert.equal(r.call.rows, 12);
    assert.equal(r.strip.hidden, true);
  });

  test('(−) Type into pane on: every row and the cursor, no strip (the user types into the real box)', () => {
    const r = draw({ draft: readable(), pass: true });
    assert.equal(r.call.rows, 12);
    assert.deepEqual(norm(r.call.cursor), BODY.cursor);
    assert.equal(r.strip.hidden, true);
  });

  test('(−) a capture without a draft field (an older server): every row, no strip', () => {
    const r = draw({ draft: cleanDraftReal(undefined) });
    assert.equal(r.call.rows, 12);
    assert.equal(r.strip.hidden, true);
  });

  test('(−) before the first capture there is nothing to draw', () => {
    const r = draw({ body: null, draft: null });
    assert.equal(r.calls.length, 0);
  });

  test('(+) the cut follows the state at every draw: unreadable, then readable, then Type into pane', () => {
    const states = [[unreadable, false, 12, true], [readable(), false, 8, false], [readable(), true, 12, true], [readable(), false, 8, false]];
    for (const [draft, pass, rows, hidden] of states) {
      const r = draw({ draft, pass });
      assert.deepEqual([r.call.rows, r.strip.hidden], [rows, hidden]);
    }
  });

  test('(+) F11: the cut drawn is kept in M.cut: the row of the box\'s top rule while the strip is shown', () => {
    for (const state of ['text', 'empty']) assert.equal(draw({ draft: readable(state) }).M.cut, 8, state);
  });

  test('(−) F11: M.cut is null whenever no strip is drawn: an unreadable draft, no draft, Type into pane, a cut at or past the last row', () => {
    assert.equal(draw({ draft: unreadable }).M.cut, null);
    assert.equal(draw({ draft: null }).M.cut, null);
    assert.equal(draw({ draft: readable(), pass: true }).M.cut, null);
    assert.equal(draw({ draft: readable('text', { box: { top: 12, bottom: 15 } }) }).M.cut, null, 'a cut past the last row draws every row');
    assert.equal(draw({ draft: readable('text', { box: { top: 11, bottom: 15 } }) }).M.cut, 11);
  });

  test('(−) F11: before the first capture drawMirror changes nothing: M.cut and the scroll position stay', () => {
    const r = draw({ body: null, draft: null });
    assert.equal(r.M.cut, 'unset');
    assert.equal(r.term.scrollTop, 0);
  });

  test('(+) F11: drawMirror re-pins the mirror to the bottom when it is not paused, and leaves a paused one where the reader put it', () => {
    assert.equal(draw({ draft: readable() }).term.scrollTop, 500);
    assert.equal(draw({ draft: readable(), pass: true }).term.scrollTop, 500, 'with Type into pane on too (Claude\'s box is at the bottom)');
    const paused = (() => {
      const out = { calls: [], strip: { hidden: true }, term: { scrollTop: 123, scrollHeight: 500 } };
      const ctx = { M: { body: BODY, draft: readable(), frozen: true, cut: null }, P: { on: false }, cutAt: cutAtReal, cutCursor: cutCursorReal, toRenderModel: toRenderModelReal, applyMirror() {}, $: (id) => (id === 'term-cut' ? out.strip : id === 'term' ? out.term : id) };
      vm.runInNewContext(`${fnOf('function drawMirror()')}; drawMirror`, ctx)();
      return out.term.scrollTop;
    })();
    assert.equal(paused, 123);
  });

  test('(+) setPass draws again, so the strip appears and goes the moment Type into pane flips, not at the next capture', () => {
    const src = fnOf('function setPass(on, keepFocus = false)');
    assert.match(src, /P\.on = on;[\s\S]*drawMirror\(\);/);
  });

  test('(+) handleCapture keeps the body and its cleaned draft, draws through drawMirror, then tells the sync', () => {
    const log = [];
    const ctx = {
      recovered() {}, noteScreen() {}, $: () => ({ style: {}, scrollTop: 0, scrollHeight: 9 }), M: { frozen: false, scrollTop: 0 }, setLive() {}, MID: ' - ', TIMES: 'x', ETAG: /^[0-9a-f]{1,64}$/,
      cleanDraft: cleanDraftReal, Q: { queued: false }, renderQuick() {}, DS: { capture: (d, cols) => log.push(['capture', d, cols]) }, drawMirror: () => log.push(['draw']), renderSuggestion: () => log.push(['suggest']), ATT: { sending: () => false },
      setGone() {}, serverMessage: () => '', setPaneState() {}, setInputEnabled() {}, showOverlay() {},
    };
    const body = { ...BODY, draft: readable(), etag: 'ab12' };
    vm.runInNewContext(`${fnOf('function handleCapture(r)')}; handleCapture`, ctx)({ status: 200, body });
    assert.deepEqual(norm(log), [['draw'], ['capture', readable(), 120], ['suggest']].map(norm), 'the rows first: a sync can never delay the mirror; the placeholder follows the sync');
    assert.equal(ctx.M.body, body);
    assert.deepEqual(norm(ctx.M.draft), readable());
  });

  test('(+) W13: Stop\'s title follows the capture: Q.queued is set from the cleaned draft and the quick actions are drawn again only when it changes', () => {
    const renders = [];
    const ctx = {
      recovered() {}, noteScreen() {}, $: () => ({ style: {}, scrollTop: 0, scrollHeight: 9 }), M: { frozen: false, scrollTop: 0 }, setLive() {}, MID: ' - ', TIMES: 'x', ETAG: /^[0-9a-f]{1,64}$/,
      cleanDraft: cleanDraftReal, DS: { capture() {} }, drawMirror() {}, renderSuggestion() {}, ATT: { sending: () => false }, Q: { queued: false }, renderQuick: () => renders.push(ctx.Q.queued),
      setGone() {}, serverMessage: () => '', setPaneState() {}, setInputEnabled() {}, showOverlay() {},
    };
    const capture = vm.runInNewContext(`${fnOf('function handleCapture(r)')}; handleCapture`, ctx);
    const answer = (draft) => capture({ status: 200, body: { ...BODY, draft, etag: 'ab12' } });
    answer(readable('empty'));
    assert.deepEqual(renders, [], 'nothing changed');
    answer(readable('empty', { queued: true }));
    answer(readable('empty', { queued: true }));
    assert.deepEqual(renders, [true], 'drawn once when Claude took our message into its queue');
    answer(readable('empty'));
    assert.deepEqual(renders, [true, false], 'and once when the queue is gone');
    answer(null);
    answer(readable('text', { queued: true }));
    assert.equal(ctx.Q.queued, true, 'the cleaned draft decides, as the server sent it');
  });

  test('(−) handleCapture while attachments are being sent: no sync capture (the box holds placeholders), but the mirror is drawn and the placeholder follows', () => {
    const log = [];
    const ctx = {
      recovered() {}, noteScreen() {}, $: () => ({ style: {}, scrollTop: 0, scrollHeight: 9 }), M: { frozen: false, scrollTop: 0 }, setLive() {}, MID: ' - ', TIMES: 'x', ETAG: /^[0-9a-f]{1,64}$/,
      cleanDraft: cleanDraftReal, Q: { queued: false }, renderQuick() {}, DS: { capture: (d, cols) => log.push(['capture', d, cols]) }, drawMirror: () => log.push(['draw']), renderSuggestion: () => log.push(['suggest']), ATT: { sending: () => true },
      setGone() {}, serverMessage: () => '', setPaneState() {}, setInputEnabled() {}, showOverlay() {},
    };
    const body = { ...BODY, draft: readable(), etag: 'ab12' };
    vm.runInNewContext(`${fnOf('function handleCapture(r)')}; handleCapture`, ctx)({ status: 200, body });
    assert.deepEqual(norm(log), [['draw'], ['suggest']].map(norm));
    assert.equal(ctx.M.body, body, 'the body is still kept');
  });

  test('(−) fix round 1: Stop\'s title still follows the capture when the sync or the placeholder throws, or attachments are being sent', () => {
    for (const [label, over] of [
      ['DS.capture throws', { DS: { capture: () => { throw new Error('boom'); } } }],
      ['renderSuggestion throws', { renderSuggestion: () => { throw new Error('boom'); } }],
      ['attachments are being sent', { ATT: { sending: () => true } }],
    ]) {
      const renders = [];
      const ctx = {
        recovered() {}, noteScreen() {}, $: () => ({ style: {}, scrollTop: 0, scrollHeight: 9 }), M: { frozen: false, scrollTop: 0 }, setLive() {}, MID: ' - ', TIMES: 'x', ETAG: /^[0-9a-f]{1,64}$/,
        cleanDraft: cleanDraftReal, DS: { capture() {} }, drawMirror() {}, renderSuggestion() {}, ATT: { sending: () => false }, Q: { queued: false }, renderQuick: () => renders.push(ctx.Q.queued),
        setGone() {}, serverMessage: () => '', setPaneState() {}, setInputEnabled() {}, showOverlay() {}, ...over,
      };
      const capture = vm.runInNewContext(`${fnOf('function handleCapture(r)')}; handleCapture`, ctx);
      assert.doesNotThrow(() => capture({ status: 200, body: { ...BODY, draft: readable('empty', { queued: true }), etag: 'ab12' } }), label);
      assert.equal(ctx.Q.queued, true, label);
      assert.deepEqual(renders, [true], label);
      capture({ status: 200, body: { ...BODY, draft: readable('empty'), etag: 'ab13' } });
      assert.equal(ctx.Q.queued, false, label);
      assert.deepEqual(renders, [true, false], label);
    }
  });

  test('(−) a sync that throws never takes the mirror down: the rows are drawn and the error is not thrown', () => {
    const drew = [];
    const ctx = {
      recovered() {}, noteScreen() {}, $: () => ({ style: {}, scrollTop: 0, scrollHeight: 9 }), M: { frozen: false }, setLive() {}, MID: ' - ', TIMES: 'x', ETAG: /^[0-9a-f]{1,64}$/,
      cleanDraft: cleanDraftReal, Q: { queued: false }, renderQuick() {}, DS: { capture: () => { throw new Error('boom'); } }, drawMirror: () => drew.push(1), renderSuggestion() {}, ATT: { sending: () => false },
    };
    assert.doesNotThrow(() => vm.runInNewContext(`${fnOf('function handleCapture(r)')}; handleCapture`, ctx)({ status: 200, body: { ...BODY, draft: readable() } }));
    assert.equal(drew.length, 1);
  });
});

function norm(v) { return JSON.parse(JSON.stringify(v ?? null)); } // objects built inside a vm have another Object.prototype

describe('0.5: the note, the pull and the edits (wiring)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const h = (tag, attrs, ...kids) => ({ tag, text: attrs?.text, kids: kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false) });

  const noteRig = () => {
    const el = { hidden: true, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, replaceChildren(...k) { this.kids = k; } };
    const api = mk(['function renderDraftNote(view)'], { $: () => el, icon: (n) => ({ icon: n }), h });
    return { el, ...api };
  };

  test('(+) renderDraftNote draws icon + bold word + text through the element builder, and the kind drives the colour', () => {
    const r = noteRig();
    r.renderDraftNote(noteViewReal({ kind: 'paused', reason: 'pasted' }));
    assert.equal(r.el.hidden, false);
    assert.equal(r.el.attrs['data-k'], 'paused');
    assert.deepEqual(norm(r.el.kids[0]), { icon: 'pause' });
    assert.equal(r.el.kids[1].text, 'Sync paused:');
    assert.equal(r.el.kids[2].text, " Claude's input holds a pasted block nika can't read back. Edit or clear it in the terminal.");
  });

  test('(+) W13: hold, cursor and queued are drawn with their own data-k, icon and bold word (the colour follows data-k in session.css)', () => {
    for (const [kind, icon, word] of [['hold', 'dialog', 'On hold:'], ['cursor', 'window', 'Cursor:'], ['queued', 'send', 'Queued:']]) {
      const r = noteRig();
      r.renderDraftNote(noteViewReal({ kind }));
      assert.equal(r.el.hidden, false, kind);
      assert.equal(r.el.attrs['data-k'], kind);
      assert.deepEqual(norm(r.el.kids[0]), { icon }, kind);
      assert.equal(r.el.kids[1].text, word, kind);
    }
  });

  test('(−) no note hides the line, empties it and drops the kind (the live region has nothing left to read)', () => {
    const r = noteRig();
    r.renderDraftNote(noteViewReal({ kind: 'long' }));
    r.renderDraftNote(null);
    assert.equal(r.el.hidden, true);
    assert.equal(r.el.attrs['data-k'], undefined);
    assert.deepEqual(r.el.kids, []);
  });

  test('(+) the page hands the sync its box, a PUT to the draft route, the clock, the note and the gone state', () => {
    const src = fnOf('const DS = createDraftSync({').length ? SRC.slice(SRC.indexOf('const DS = createDraftSync({'), SRC.indexOf('});', SRC.indexOf('const DS = createDraftSync({')) + 3) : '';
    assert.match(src, /box: \(\) => \(\{ value: composer\(\)\.value, shell: S\.on \}\)/);
    // F10 (requirement change, not a weakened test): the write waits for the redraw hold, so the config names putDraft, and the PUT to the draft route is asserted on that function
    assert.match(src, /put: putDraft,/);
    assert.match(fnOf('async function putDraft(body)'), /return call\(`\/api\/app\/pane\/\$\{encodeURIComponent\(paneId\)\}\/draft`, \{ method: 'PUT', json: body \}\);/);
    assert.match(src, /setBox: pullIntoBox/);
    assert.match(src, /note: renderDraftNote/);
    assert.match(src, /gone: setGone/);
    assert.match(src, /now: \(\) => Date\.now\(\)/);
  });

  const pullRig = ({ value = 'old', caret = 3, focused = true } = {}) => {
    const log = [];
    const ta = {
      value, selectionStart: caret, setSelectionRange: (a, b) => log.push(['caret', a, b]),
    };
    const doc = { activeElement: focused ? ta : null };
    const api = mk(['function pullIntoBox(value, shell)'], {
      composer: () => ta, document: doc, caretAfter: caretAfterReal, setShell: (on) => log.push(['shell', on]), grow: () => log.push(['grow']),
      updateChip: () => log.push(['chip']), closePalette: () => log.push(['palette']),
    });
    return { log, ta, ...api };
  };

  test('(+) pullIntoBox sets the text and Shell, resizes, refreshes the chip and keeps the caret at the end of text that grew', () => {
    const r = pullRig({ value: 'fix the', caret: 7 });
    r.pullIntoBox('fix the typo', false);
    assert.equal(r.ta.value, 'fix the typo');
    assert.deepEqual(r.log, [['caret', 12, 12], ['shell', false], ['grow'], ['chip']]);
  });

  test('(+) pullIntoBox turns Shell on for a ! draft', () => {
    const r = pullRig({ value: '', caret: 0 });
    r.pullIntoBox('ls -la', true);
    assert.deepEqual(r.log.filter(([k]) => k === 'shell'), [['shell', true]]);
  });

  test('(−) a pull never moves focus or the caret of a box that is not focused, and closes a palette the text opened', () => {
    const r = pullRig({ focused: false });
    r.pullIntoBox('/com', false);
    assert.equal(r.log.some(([k]) => k === 'caret'), false);
    assert.deepEqual(r.log.at(-1), ['palette']);
    assert.doesNotMatch(fnOf('function pullIntoBox(value, shell)'), /\.focus\(/);
  });

  test('(−) a pull is not an edit: the function never calls DS.edited', () => {
    assert.doesNotMatch(fnOf('function pullIntoBox(value, shell)'), /DS\./);
  });

  test('(+) every user edit of the box tells the sync: typing, composing, Clear, the Commands button, the palette insert and the Shell toggle', () => {
    const wire = fnOf('function wireComposer()');
    assert.match(wire, /addEventListener\('input', \(\) => \{ grow\(\); updateChip\(\); DS\.edited\(\); \}\)/);
    assert.match(wire, /addEventListener\('compositionstart', \(\) => DS\.composition\(true\)\)/);
    assert.match(wire, /addEventListener\('compositionend', \(\) => DS\.composition\(false\)\)/);
    assert.match(wire, /\$\('paste-clear'\)\.addEventListener\('click', \(\) => \{[^}]*DS\.edited\(\);/);
    assert.match(wire, /\$\('shell-toggle'\)\.addEventListener\('click', \(\) => \{ setShell\(!S\.on\); DS\.edited\(\); \}\)/);
    assert.match(fnOf('function wirePalette()'), /ta\.value = '\/';[\s\S]*DS\.edited\(\);/);
    assert.match(fnOf('function insertActive()'), /ta\.value = ins\.text;[\s\S]*DS\.edited\(\);/);
  });

  test('(+) the listeners run for real: an input event is an edit, composition is told, nothing else is', () => {
    const calls = [];
    const listeners = {};
    const el = (id) => ({ addEventListener(type, f) { listeners[`${id}:${type}`] = f; }, focus() {} });
    const ta = { ...el('composer'), value: '', selectionStart: 0, selectionEnd: 0 };
    const ctx = {
      composer: () => ta, $: el, grow: () => calls.push('grow'), updateChip: () => calls.push('chip'), wirePalette() {}, endArrows() {}, sendComposer() {}, setShell: (on) => calls.push(`shell ${on}`), S: { on: false },
      DS: { edited: () => calls.push('edited'), composition: (on) => calls.push(`composition ${on}`) },
    };
    vm.runInNewContext(`${fnOf('function wireComposer()')}; wireComposer`, ctx)();
    listeners['composer:input']();
    listeners['composer:compositionstart']();
    listeners['composer:compositionend']();
    listeners['shell-toggle:click']();
    listeners['paste-clear:click']();
    assert.deepEqual(calls, ['grow', 'chip', 'edited', 'composition true', 'composition false', 'shell true', 'edited', 'grow', 'chip', 'edited']);
  });

  test('(+) a lost connection ends with a retry that follows the first-capture rule; a gone pane stops the sync', () => {
    assert.match(fnOf('function setGone()'), /DS\.stop\(\);/);
    assert.match(SRC, /\$\('over-retry'\)\.addEventListener\('click', \(\) => \{[\s\S]*?DS\.reset\(\);/);
    const reset = [];
    const ctx = { M: { errors: 2 }, hideOverlay() {}, W: { got: true, pane: 'ok' }, setPaneState() {}, DS: { reset: () => reset.push(1) } };
    vm.runInNewContext(`${fnOf('function recovered()')}; recovered`, ctx)();
    assert.equal(reset.length, 1, 'tmux was failing and answers again');
    ctx.M.errors = 0;
    vm.runInNewContext(`${fnOf('function recovered()')}; recovered`, ctx)();
    assert.equal(reset.length, 1, 'a healthy connection is not reset at every capture');
  });
});

describe('0.5: Send with the synced box (design W5, section 4)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const BOX = { top: 30, bottom: 32 };
  const D = (state, text = '', over = {}) => ({ state, mode: 'prompt', text, sig: '0000000000000001', box: BOX, cursorAtEnd: true, suggestion: null, queued: false, ...over });
  const UNREADABLE = { state: 'unreadable', mode: 'prompt', text: '', sig: null, reason: 'pasted', box: BOX, cursorAtEnd: false, suggestion: null, queued: false };
  const GATE = 'Answer the prompt with the buttons above or in the terminal.';

  const PUSHED = '00000000000000aa'; // the sig of the box as DS.send's write left it
  const SIG1 = '0000000000000001';

  /**
   * sendComposer for real, with the real plans (draftSendPlan, planSend, planShell, sendGate, submitResult), a fake sync and fake routes.
   * `pushAnswer`: what DS.send answers; `submit(tail, body)`: what the submit route answers (default: taken); `kind`: the agent's status.
   */
  const rig = ({ value, screen, shell = false, promptOpen = false, pushAnswer = { ok: true, sig: PUSHED }, submit, kind = 'idle', att = { pending: () => false }, footer = { mode: 'default', confirmed: true }, hold = { active: false } } = {}) => {
    const log = Object.assign(sendLog(), { problems: [], said: [], pushed: [], told: [], shellOff: 0 });
    const ta = { value, disabled: false };
    const ctx = {
      sending: false, composer: () => ta, DF: null, S: { on: shell }, W: { promptOpen, prompt: null, pane: 'ok', ...footer }, A: { kind }, M: { cols: 120, gone: false },
      sendGate: sendGateReal, hasAnswerButtons: hasAnswerButtonsReal, planShell: planShellReal, planSend: planSendReal, draftSendPlan: draftSendPlanReal,
      showProblem: (m, k) => log.problems.push([m, k]), $: () => ({ setAttribute() {}, removeAttribute() {} }), say: (m) => log.said.push(m), paneId: '%12',
      setShell: () => { log.shellOff += 1; }, grow() {}, updateChip() {},
      DS: {
        screen: () => screen,
        beginSend: () => log.order.push('begin'), endSend: () => log.order.push('end'), sent: () => log.order.push('sent'),
        submitted: (r) => { log.order.push('submitted'); log.told.push(jsonClone(r)); },
        send: async (text) => { log.order.push('push'); log.pushed.push(text); return pushAnswer; },
      },
      ATT: att,
      ...sendIo(log, submit, hold),
    };
    return { log, ta, ctx, send: mk(SEND_FUNCS, ctx).sendComposer };
  };
  const SUBMIT = (base) => [['submit', base === undefined ? {} : { base }]];

  test('(+) 0.5 attachments pending: sendComposer hands the box text to ATT.send and sends nothing itself (no keys, no submit, no push, no begin/end, the box is left to ATT)', async () => {
    const handed = [];
    const att = { pending: () => true, send: (v) => { handed.push(v); return Promise.resolve(); } };
    const r = rig({ value: 'see the files', screen: D('text', ''), att });
    await r.send();
    assert.deepEqual(handed, ['see the files']);
    assert.deepEqual(r.log.order, [], 'no keys job, no DS.send, no beginSend');
    assert.deepEqual(r.log.sent, []);
    assert.deepEqual(r.log.pushed, []);
    assert.deepEqual(r.log.said, []);
    assert.equal(r.ta.value, 'see the files');
  });

  test('(+) W13: attachments send while Claude works: the status is no gate, ATT.send gets the text', async () => {
    const handed = [];
    const att = { pending: () => true, send: (v) => { handed.push(v); return Promise.resolve(); } };
    const r = rig({ value: 'see the files', screen: D('empty'), kind: 'busy', att });
    await r.send();
    assert.deepEqual(handed, ['see the files']);
    assert.deepEqual(r.log.problems, []);
  });

  test('(−) 0.5 attachments pending behind an open permission prompt: the gate answers first and ATT.send is not called', async () => {
    const handed = [];
    const att = { pending: () => true, send: (v) => { handed.push(v); } };
    const r = rig({ value: 'see the files', screen: D('text', ''), promptOpen: true, att });
    await r.send();
    assert.deepEqual(handed, []);
    assert.deepEqual(r.log.problems, [['Answer the prompt in the terminal, or turn on Type into pane.', 'error']]);
    assert.deepEqual(r.log.order, []);
  });

  test('(+) row 1: the screen equals the box: the guarded Enter alone with the screen\'s sig, no push, no text, then the box is cleared and the sync told', async () => {
    const r = rig({ value: 'fix the typo', screen: D('text', 'fix the typo') });
    await r.send();
    assert.deepEqual(r.log.posts, SUBMIT(SIG1));
    assert.deepEqual(r.log.keys, []);
    assert.deepEqual(r.log.pushed, []);
    assert.deepEqual(r.log.order, ['begin', 'submit', 'submitted', 'sent', 'end']);
    assert.deepEqual(r.log.said, ['Sent Enter to %12']);
    assert.equal(r.ta.value, '');
  });

  test('(+) row 1, Shell: the screen equals "!" + the box: the Enter alone with no C-u and no text; Shell turns itself off after', async () => {
    const r = rig({ value: 'ls -la', shell: true, screen: D('text', 'ls -la', { mode: 'bash' }) });
    await r.send();
    assert.deepEqual(r.log.posts, SUBMIT(SIG1));
    assert.deepEqual(r.log.keys, []);
    assert.equal(r.log.shellOff, 1);
  });

  test('(+) row 2: an empty box over Claude\'s input that holds text, cannot be read or is not shown sends the Enter alone: with the screen\'s sig when it has one, none otherwise', async () => {
    for (const [screen, base] of [[D('text', 'typed in the terminal'), SIG1], [UNREADABLE, undefined], [null, undefined]]) {
      const r = rig({ value: '', screen });
      await r.send();
      assert.deepEqual(r.log.posts, SUBMIT(base));
      assert.deepEqual(r.log.keys, []);
      assert.deepEqual(r.log.pushed, []);
    }
  });

  test('(−) row 2: an empty box over an empty Claude input is nothing to send: no request of any kind, no begin, no echo, no problem line', async () => {
    for (const screen of [D('empty'), D('empty', '', { suggestion: 'run the tests in acme-api' }), D('empty', '', { queued: true })]) {
      for (const kind of ['idle', 'busy']) {
        const r = rig({ value: '  \n', screen, kind });
        await r.send();
        assert.deepEqual(r.log.order, [], `${kind} ${JSON.stringify(screen.suggestion)}`);
        assert.deepEqual([r.log.keys, r.log.posts, r.log.pushed, r.log.said, r.log.problems], [[], [], [], [], []]);
      }
    }
  });

  test('(+) row 3: text the screen does not hold is pushed first and the guarded Enter follows with the sig of that push; nothing else goes out', async () => {
    const r = rig({ value: 'fix the typo in acme-api', screen: D('text', 'fix the') });
    await r.send();
    assert.deepEqual(r.log.pushed, ['fix the typo in acme-api']);
    assert.deepEqual(r.log.posts, SUBMIT(PUSHED));
    assert.deepEqual(r.log.keys, []);
    assert.deepEqual(r.log.order, ['begin', 'push', 'submit', 'submitted', 'sent', 'end'], 'the push comes before the Enter');
    assert.deepEqual(r.log.said, ['Sent 24 characters + Enter to %12']);
    assert.equal(r.ta.value, '');
  });

  test('(+) row 3, Shell: "!" + the text is pushed, then the Enter', async () => {
    const r = rig({ value: 'ls -la', shell: true, screen: D('empty') });
    await r.send();
    assert.deepEqual(r.log.pushed, ['!ls -la']);
    assert.deepEqual(r.log.posts, SUBMIT(PUSHED));
  });

  test('(−) row 3: a push whose answer has no sig sends the Enter with no base, never an empty or made-up one', async () => {
    const r = rig({ value: 'mine', screen: D('empty'), pushAnswer: { ok: true, sig: null } });
    await r.send();
    assert.deepEqual(r.log.posts, SUBMIT());
  });

  test('(−) row 3: a push that does not land sends no Enter, shows its line, keeps the text and Shell, and lets the sync go on', async () => {
    const message = "Claude's input changed while nika was copying your text. nika shows what it holds now. Nothing was sent.";
    const r = rig({ value: 'mine', shell: true, screen: D('text', 'theirs'), pushAnswer: { ok: false, message } });
    await r.send();
    assert.deepEqual(r.log.sent, []);
    assert.deepEqual(r.log.problems, [[message, 'error']]);
    assert.equal(r.ta.value, 'mine');
    assert.equal(r.log.shellOff, 0);
    assert.deepEqual(r.log.order, ['begin', 'push', 'end'], 'the sync is released and was not told "sent"');
  });

  test('(+) row 4: a long text onto an empty prompt goes as today\'s paste (keys route, no Enter), then the guarded Enter with no base', async () => {
    const r = rig({ value: 'y'.repeat(2000), screen: D('empty') });
    await r.send();
    assert.deepEqual(r.log.keys, [{ paste: 'y'.repeat(2000), send: true }]);
    assert.deepEqual(r.log.posts, SUBMIT());
    assert.deepEqual(r.log.pushed, []);
    assert.deepEqual(r.log.order, ['begin', 'keys', 'submit', 'submitted', 'sent', 'end']);
  });

  test('(−) row 5 and 6: refusals send nothing, show the fixed line as an error, keep the text, and never begin a send', async () => {
    const long = rig({ value: 'y'.repeat(2000), screen: D('text', 'something else') });
    await long.send();
    assert.deepEqual(long.log.problems, [["Claude's input already holds text; it would be sent together with yours. Clear it in the terminal or shorten your message.", 'error']]);
    const paused = rig({ value: 'fix', screen: UNREADABLE });
    await paused.send();
    assert.deepEqual(paused.log.problems, [["Claude's input holds a pasted block nika can't read back. Send or clear it in the terminal.", 'error']]);
    for (const r of [long, paused]) {
      assert.deepEqual(r.log.sent, []);
      assert.deepEqual(r.log.order, []);
      assert.equal(r.ta.value.length > 0, true);
    }
  });

  test('(+) row 7: no readable box is today\'s path, including Shell\'s C-u and command: typed by the keys route, then the guarded Enter with no base', async () => {
    const line = rig({ value: 'hello', screen: null });
    await line.send();
    assert.deepEqual(line.log.keys, [{ text: 'hello', send: true }]);
    assert.deepEqual(line.log.posts, SUBMIT());
    const shell = rig({ value: 'ls', shell: true, screen: null });
    await shell.send();
    assert.deepEqual(shell.log.keys, [{ keys: ['C-u'], send: true }, { text: '!ls', send: true }]);
    assert.deepEqual(shell.log.posts, SUBMIT());
  });

  // F1 (live, Claude 2.1.325): keyboard focus in Claude's agent list replaces the mode line by a hint; the capture then reads mode `unknown` (never seen) or the
  // remembered mode with modeConfirmed false, and draft null. The legacy road would type the text into that list before the submit route could refuse.
  const CANT_READ = "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.";
  const UNKNOWN_FOOTERS = [{ mode: 'unknown', confirmed: true }, { mode: 'default', confirmed: false }, { mode: 'unknown', confirmed: false }];

  test('(−) F1: no readable box and an unknown footer (an agent list has the focus): text, Shell text and an empty-box Enter send NOTHING (no keys, no submit, no begin), show the fixed line, keep the text and Shell', async () => {
    for (const footer of UNKNOWN_FOOTERS) {
      for (const [label, opts] of [['text', { value: 'hello' }], ['Shell text', { value: 'ls', shell: true }], ['empty Enter', { value: '' }], ['spaces', { value: '  \n ' }]]) {
        const r = rig({ ...opts, screen: null, footer });
        await r.send();
        const at = `${label} ${JSON.stringify(footer)}`;
        assert.deepEqual([r.log.keys, r.log.posts, r.log.pushed, r.log.sent, r.log.order], [[], [], [], [], []], at);
        assert.deepEqual(r.log.problems, [[opts.value.trim() === '' ? CANT_READ.replace(' Your text is kept.', '') : CANT_READ, 'error']], at); // an empty box has no text to keep
        assert.equal(r.ta.value, opts.value, `${at}: the text stays in the box`);
        assert.equal(r.log.shellOff, 0, `${at}: Shell stays on`);
      }
    }
    const lone = rig({ value: '', shell: true, screen: null, footer: UNKNOWN_FOOTERS[0] });
    await lone.send();
    assert.deepEqual([lone.log.keys, lone.log.posts, lone.log.problems], [[], [], []], 'Shell on and nothing to run stays a quiet no-op');
  });

  test('(+) F1: the footer state only matters when no box reads: a readable screen sends as before whatever the footer says (a ! box reads its footer as unknown)', async () => {
    for (const footer of UNKNOWN_FOOTERS) {
      const r = rig({ value: 'ls', shell: true, screen: D('empty', '', { mode: 'bash' }), footer });
      await r.send();
      assert.deepEqual(r.log.pushed, ['!ls'], JSON.stringify(footer));
      assert.deepEqual(r.log.posts, SUBMIT(PUSHED), JSON.stringify(footer));
      assert.deepEqual(r.log.problems, [], JSON.stringify(footer));
    }
  });

  test('(−) a permission prompt still gates every row first: nothing is pushed or sent, and no send begins', async () => {
    const r = rig({ value: 'fix the typo', screen: D('text', 'fix the typo'), promptOpen: true });
    await r.send();
    assert.deepEqual(r.log.problems, [[GATE === r.log.problems[0][0] ? GATE : r.log.problems[0][0], 'error']]);
    assert.deepEqual(r.log.order, []);
    assert.deepEqual(r.log.sent, []);
  });

  test('(+) W13: Claude working does not gate Send: the text goes (pushed, then the Enter), and the echo says it is queued', async () => {
    const r = rig({ value: 'next step please', screen: D('empty'), kind: 'busy' });
    await r.send();
    assert.deepEqual(r.log.posts, SUBMIT(PUSHED));
    assert.deepEqual(r.log.problems, []);
    assert.deepEqual(r.log.said, ['Queued for Claude: 16 characters + Enter']);
    assert.equal(r.ta.value, '');
  });

  test('(−) W13: the "Queued" echo needs a working Claude, a taken Enter and a message: idle, taken null, taken false and a lone Enter say what they did', async () => {
    const idle = rig({ value: 'next step please', screen: D('empty') });
    await idle.send();
    assert.deepEqual(idle.log.said, ['Sent 16 characters + Enter to %12']);
    const unknown = rig({ value: 'next step please', screen: D('empty'), kind: 'busy', submit: () => ({ status: 200, body: { taken: null, draft: null } }) });
    await unknown.send();
    assert.deepEqual(unknown.log.said, ['Sent 16 characters + Enter to %12'], 'not proven: not claimed');
    const lone = rig({ value: '', screen: D('text', 'typed in the terminal'), kind: 'busy' });
    await lone.send();
    assert.deepEqual(lone.log.said, ['Sent Enter to %12'], 'a lone Enter queues nothing of nika\'s');
  });

  test('(+) fix round 1: while Claude works, the echo names the message in every route that carries text (enter, push, legacy, Shell) and never just "Enter"', async () => {
    const cases = [
      ['enter: the screen already holds the text', { value: 'fix the typo', screen: D('text', 'fix the typo') }, 'Queued for Claude: 12 characters + Enter'],
      ['push', { value: 'next step please', screen: D('empty') }, 'Queued for Claude: 16 characters + Enter'],
      ['legacy: no readable box', { value: 'hello', screen: null }, 'Queued for Claude: 5 characters + Enter'],
      ['Shell, push', { value: 'ls -la', shell: true, screen: D('empty') }, 'Queued for Claude: a shell command (6 characters) + Enter'],
      ['Shell, enter', { value: 'ls -la', shell: true, screen: D('text', 'ls -la', { mode: 'bash' }) }, 'Queued for Claude: a shell command (6 characters) + Enter'],
    ];
    for (const [label, opts, line] of cases) {
      const r = rig({ ...opts, kind: 'busy' });
      await r.send();
      assert.deepEqual(r.log.said, [line], label);
      assert.deepEqual(r.log.problems, [], label);
    }
  });

  test('(−) fix round 1: a lone Enter while Claude works says "Sent Enter", an idle Claude says "Sent", and neither claims a queue', async () => {
    for (const kind of ['busy', undefined]) {
      const r = rig({ value: '   ', screen: D('text', 'typed in the terminal'), ...(kind ? { kind } : {}) });
      await r.send();
      assert.deepEqual(r.log.said, ['Sent Enter to %12'], `${kind}`);
    }
    const idle = rig({ value: 'fix the typo', screen: D('text', 'fix the typo') });
    await idle.send();
    assert.deepEqual(idle.log.said, ['Sent Enter to %12'], 'idle, enter route: the Enter is what went out');
  });

  test('(−) W13: a refused Enter keeps the text, Shell and the box, shows its fixed line as an error, tells the sync the answer, and never says "sent"', async () => {
    const lines = {
      'prompt-open': 'A prompt opened in Claude, so nika did not press Enter. Answer it, then send again. Your text is kept.',
      'not-idle': 'Stop is running, so nika did not press Enter. Send again in a moment. Your text is kept.',
      'draft-changed': "Claude's input changed before Enter. nika shows what it holds now. Nothing was sent.",
      'screen-unclear': "nika can't tell what Claude is showing, so it did not press Enter. Use the terminal. Your text is kept.",
      'suggestion-shown': "Claude's input is empty and shows a suggestion, so nika did not press Enter. Nothing was sent.",
      'input-unreadable': "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.",
      'bypass-prompt': 'Answer this prompt in the terminal.',
    };
    for (const [code, line] of Object.entries(lines)) {
      const r = rig({ value: 'fix the typo', shell: true, screen: D('text', 'fix the typo', { mode: 'bash' }), submit: () => ({ status: 409, body: { error: code, message: 'Evil <b>server</b> text' } }) });
      await r.send();
      assert.deepEqual(r.log.problems, [[line, 'error']], code);
      assert.equal(r.ta.value, 'fix the typo', code);
      assert.equal(r.log.shellOff, 0, code);
      assert.equal(r.log.order.includes('sent'), false, code);
      assert.equal(r.log.order.includes('submitted'), true, code);
      assert.deepEqual(r.log.said, [], code);
      assert.equal(r.log.order.at(-1), 'end', code);
    }
  });

  test('(−) W13: taken false (the Enter did not take) keeps the text, shows the "menu may have taken the Enter" line, and does not say sent', async () => {
    const r = rig({ value: 'fix the typo', screen: D('text', 'fix the typo'), submit: () => ({ status: 200, body: { taken: false, draft: null } }) });
    await r.send();
    assert.equal(r.ta.value, 'fix the typo');
    assert.equal(r.log.problems.length, 1);
    assert.match(r.log.problems[0][0], /^nika pressed Enter, but Claude's input still shows your text/);
    assert.equal(r.log.order.includes('sent'), false);
    assert.deepEqual(r.log.said, []);
  });

  test('(−) W13: no Send path posts an Enter to the keys route: every route, with and without Shell, with a screen or without, ends in exactly one submit', async () => {
    const screens = [D('text', 'hello'), D('text', 'other'), D('empty'), UNREADABLE, null];
    for (const shell of [false, true]) {
      for (const value of ['', 'hello', 'a\nb', 'y'.repeat(2000)]) {
        for (const screen of screens) {
          const r = rig({ value, screen, shell });
          await r.send();
          const label = `${shell} ${JSON.stringify(value.slice(0, 5))} ${screen?.state ?? null}`;
          assert.equal(JSON.stringify(r.log.keys).includes('Enter'), false, label);
          const refused = r.log.problems.length > 0; // a fixed refusal line: nothing goes
          const nothingToSend = value === '' && (shell || screen?.state === 'empty'); // an empty Shell box, or an empty message over an empty Claude input: no request, no line
          if (refused || nothingToSend) {
            assert.equal(r.log.posts.length, 0, label);
          } else {
            assert.equal(r.log.posts.length, 1, `${label}: exactly one submit`);
          }
          assert.ok(r.log.posts.every(([tail]) => tail === 'submit'), label);
          if (nothingToSend) assert.deepEqual(r.log.problems, [], `${label}: nothing to send is silent`);
        }
      }
    }
  });

  test('(+) the push or the typing and the Enter are one job in the keys chain, so arrows queued before it go first; the Enter is only ever the submit route\'s', () => {
    const src = fnOf('async function sendComposer()');
    assert.match(src, /enqueueJob\(route\.act === 'push' \? \(\) => pushThenSubmit\(route\) : route\.act === 'enter' \? \(\) => submitEnter\(route\.submit\.base\) : \(\) => typeThenSubmit\(plan\.payloads\)\)/);
    assert.match(fnOf('function enqueueJob(run)'), /chain\.then\(run\)/);
    assert.match(fnOf('function enqueueSeq(payloads)'), /enqueueJob\(\(\) => deliverAll\(payloads\)\)/);
    assert.match(fnOf('async function pushThenSubmit(route)'), /await DS\.send\(route\.text\)[\s\S]*submitEnter\(p\.sig\)/);
    assert.match(fnOf('async function typeThenSubmit(payloads)'), /await deliverAll\(payloads\)[\s\S]*submitEnter\(\)/);
    const submit = fnOf('async function submitEnter(base)');
    assert.match(submit, /postRetry\('submit'/);
    assert.doesNotMatch(submit, /deliver\(|\/keys|keys:/);
    for (const f of [src, fnOf('async function pushThenSubmit(route)'), fnOf('async function typeThenSubmit(payloads)'), submit]) assert.doesNotMatch(f, /'Enter'|"Enter"|keys:/);
  });


  // ---- F10 (design F10 4.5): Send waits for the redraw hold; every server gate stays ------------------------------------------------------------
  const holdOf = () => createRedrawHoldReal({ after: () => 1, cancel() {} });
  const WANT = { cols: 100, rows: 30 };

  test('(+) F10: a Send whose box already holds the text (only the Enter) goes out after the hold', async () => {
    const hold = holdOf();
    const r = rig({ value: 'hello', screen: D('text', 'hello'), hold });
    hold.start({ want: WANT, plainBefore: true });
    const p = r.send();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(r.log.sent, [], 'held: nothing is sent on the strength of the held frame');
    hold.end();
    await p;
    assert.deepEqual(r.log.posts.map(([tail]) => tail), ['submit']);
  });

  test('(+) F10: a pushed Send (text copied into Claude\'s input first) waits before the guarded Enter, and a typed Send before its first key', async () => {
    const pushed = holdOf();
    const a = rig({ value: 'hello', screen: D('empty'), hold: pushed });
    pushed.start({ want: WANT, plainBefore: true });
    const pa = a.send();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(a.log.posts, [], 'the Enter waits');
    pushed.end();
    await pa;
    assert.equal(a.log.posts.length, 1);
    const typed = holdOf();
    const b = rig({ value: 'hello', screen: null, hold: typed });
    typed.start({ want: WANT, plainBefore: true });
    const pb = b.send();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(b.log.keys, [], 'no key is typed while the frame is held');
    typed.end();
    await pb;
    assert.ok(b.log.keys.length >= 1);
  });

  test('(−) F10: a pane that is gone by the time the hold ends gets no Enter', async () => {
    const hold = holdOf();
    const r = rig({ value: 'hello', screen: D('text', 'hello'), hold });
    hold.start({ want: WANT, plainBefore: true });
    const p = r.send();
    await new Promise((resolve) => { setImmediate(resolve); });
    r.ctx.M.gone = true;
    hold.end();
    await p;
    assert.deepEqual(r.log.posts, []);
    assert.equal(r.ta.value, 'hello', 'the text stays in the box');
  });

  test('(−) F10: with no hold a Send runs exactly as before (the same order of calls)', async () => {
    const r = rig({ value: 'hello', screen: D('text', 'hello'), hold: { active: false } });
    await r.send();
    assert.deepEqual(r.log.order, ['begin', 'submit', 'submitted', 'sent', 'end']);
  });
});


describe('W4: Claude\'s prompt suggestion in the message box (wiring)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const SUG = 'run the tests in acme-api';
  const BOX = { top: 30, bottom: 32 };
  const D = (state, over = {}) => ({ state, mode: 'prompt', text: '', sig: '0000000000000001', box: BOX, cursorAtEnd: true, suggestion: null, ...over });
  const WITH = D('empty', { suggestion: SUG });
  const PAUSED = { state: 'unreadable', mode: 'prompt', text: '', sig: null, reason: 'pasted', box: BOX, cursorAtEnd: false, suggestion: null };

  // idlePlaceholder and suggestionNow for real: the box's value, Shell and the sync's screen decide
  const ph = ({ screen = WITH, value = '', shell = false } = {}) => {
    const api = vm.runInNewContext(`${SRC.slice(SRC.indexOf('const idlePlaceholder'), SRC.indexOf('\n', SRC.indexOf('const idlePlaceholder')))}\n${fnOf('function suggestionNow()')}; ({ idlePlaceholder, suggestionNow })`, {
      S: { on: shell }, A: { name: 'acme-api' }, DOTS: '...', composer: () => ({ value }), DS: { screen: () => screen }, suggestionFor: suggestionForReal,
    });
    return api;
  };

  test('(+) the placeholder is the suggestion while the box is empty, Shell is off and the draft is a readable empty box with a suggestion', () => {
    const r = ph();
    assert.equal(r.idlePlaceholder(), SUG);
    assert.equal(r.suggestionNow(), SUG);
  });

  test('(−) the normal text comes back when the box holds text, Shell is on, the sync is paused, there is no box or no suggestion', () => {
    assert.equal(ph({ value: 'a' }).idlePlaceholder(), 'Message acme-api...');
    assert.equal(ph({ shell: true }).idlePlaceholder(), "Shell command for Claude's ! mode...", 'Shell has its own text');
    assert.equal(ph({ screen: PAUSED }).idlePlaceholder(), 'Message acme-api...');
    assert.equal(ph({ screen: null }).idlePlaceholder(), 'Message acme-api...');
    assert.equal(ph({ screen: D('empty') }).idlePlaceholder(), 'Message acme-api...');
    assert.equal(ph({ screen: D('text', { text: 'hello', suggestion: SUG }) }).idlePlaceholder(), 'Message acme-api...');
  });

  test('(−) fix round 1: while Claude holds a queued message the placeholder stays the normal one: no suggestion text, no Tab to accept (the queued text is not a suggestion)', () => {
    const queued = ph({ screen: D('empty', { suggestion: SUG, queued: true }) });
    assert.equal(queued.idlePlaceholder(), 'Message acme-api...');
    assert.equal(queued.suggestionNow(), null);
    const queuedNoSuggestion = ph({ screen: D('empty', { queued: true }) });
    assert.equal(queuedNoSuggestion.idlePlaceholder(), 'Message acme-api...');
    assert.equal(queuedNoSuggestion.suggestionNow(), null);
    assert.equal(ph({ screen: D('empty', { suggestion: SUG, queued: false }) }).idlePlaceholder(), SUG, 'the same screen without the queue still shows the suggestion');
  });

  test('(−) the `Try "..."` example Claude draws is no suggestion: the parser gives null, so the placeholder stays the normal one', () => {
    assert.equal(ph({ screen: D('empty', { suggestion: null }) }).idlePlaceholder(), 'Message acme-api...');
  });

  // renderSuggestion: the state class and the placeholder
  const rend = ({ screen = WITH, value = '', shell = false, disabled = false } = {}) => {
    const cls = new Set();
    const ta = { value, disabled, placeholder: 'old' };
    const api = mk(['function renderSuggestion()'], {
      composer: () => ta, document: { querySelector: () => ({ classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } }) },
      suggestionNow: () => suggestionForReal(screen, { value: ta.value, shell }), idlePlaceholder: () => (suggestionForReal(screen, { value: ta.value, shell }) ?? 'Message'),
    });
    return { ...api, cls, ta };
  };

  test('(+) renderSuggestion sets the suggestion as the placeholder and the "suggest" state class on the box', () => {
    const r = rend();
    r.renderSuggestion();
    assert.deepEqual([r.ta.placeholder, [...r.cls]], [SUG, ['suggest']]);
  });

  test('(−) no suggestion: the class is off and the placeholder is the normal one; a disabled box keeps the text its owner gave it', () => {
    const r = rend({ value: 'x' });
    r.renderSuggestion();
    assert.deepEqual([r.ta.placeholder, [...r.cls]], ['Message', []]);
    const off = rend({ disabled: true });
    off.renderSuggestion();
    assert.deepEqual([off.ta.placeholder, [...off.cls]], ['old', []], 'a gone pane\'s "Pane is gone" is not overwritten, and no state class on a disabled box');
  });

  test('(+) it follows every change: a capture, any change of the box text (updateChip), the Shell toggle, the input being enabled', () => {
    assert.match(fnOf('function handleCapture(r)'), /DS\.capture\(M\.draft, cols\);[\s\S]*renderSuggestion\(\)/);
    assert.match(fnOf('function updateChip()'), /renderSuggestion\(\)/);
    assert.match(fnOf('function setShell(on)'), /renderSuggestion\(\)/);
    assert.match(fnOf('function setInputEnabled('), /renderSuggestion\(\)/);
  });

  // the keydown handler: Tab and the right arrow
  const keydown = (state, event) => {
    const calls = [];
    const ta = { value: state.value ?? '', selectionStart: 0, selectionEnd: 0, addEventListener(type, f) { if (type === 'keydown') this.keydown = f; } };
    const ctx = {
      composer: () => ta, $: () => ({ addEventListener() {}, focus() {} }), document: { querySelectorAll: () => [] },
      PL: { open: false, active: -1, shown: [] }, Q: { pop: false }, S: { on: false }, SW: { busy: null }, W: { pane: 'ok', promptOpen: false, prompt: null }, A: { kind: 'idle' }, DF: null,
      composerKey: composerKeyReal, hasAnswerButtons: hasAnswerButtonsReal, moveActive: moveActiveReal,
      grow() {}, updateChip() {}, wirePalette() {}, setPass() {}, sendComposer: () => calls.push('send'), sendKey: (k) => calls.push(`key ${k}`),
      closeModelPop() {}, closePalette() {}, insertActive() {}, setActive() {}, queueArrow: (k) => calls.push(`arrow ${k}`), endArrows: () => { calls.push('ends'); return false; }, chain: Promise.resolve(), stop() {},
      showProblem() {}, suggestionNow: () => state.suggestion ?? null, acceptSuggestion: (t) => calls.push(`accept ${t}`),
    };
    vm.runInNewContext(`${fnOf('function wireComposer()')}; wireComposer`, ctx)();
    const e = { key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    ta.keydown(e);
    return { calls, prevented: e.defaultPrevented };
  };

  test('(+) Tab or the right arrow in an empty box that shows a suggestion accepts that exact text, after the arrows typed before it, and not as a key', () => {
    for (const key of ['Tab', 'ArrowRight']) assert.deepEqual(keydown({ suggestion: SUG }, { key }), { calls: ['ends', `accept ${SUG}`], prevented: true }, key);
  });

  test('(−) Tab with text in the box moves focus (the browser default); the right arrow with no suggestion still goes to the pane', () => {
    assert.deepEqual(keydown({ value: 'abc', suggestion: null }, { key: 'Tab' }), { calls: [], prevented: false });
    assert.deepEqual(keydown({ suggestion: null }, { key: 'Tab' }), { calls: [], prevented: false });
    assert.deepEqual(keydown({ suggestion: null }, { key: 'ArrowRight' }), { calls: ['arrow Right'], prevented: true });
    assert.deepEqual(keydown({ value: 'abc', suggestion: null }, { key: 'ArrowRight' }), { calls: [], prevented: false }, 'the caret key');
  });

  test('(−) a held Tab accepts once, and Shift+Tab is still BTab, never an accept', () => {
    assert.deepEqual(keydown({ suggestion: SUG }, { key: 'Tab', repeat: true }).calls, ['ends']);
    assert.deepEqual(keydown({ suggestion: SUG }, { key: 'Tab', shiftKey: true }).calls, ['ends', 'key BTab']);
  });

  test('(+) the handler asks for the suggestion once per key and hands composerKey the same value it accepts', () => {
    const src = fnOf('function wireComposer()');
    assert.match(src, /const sug = suggestionNow\(\);/);
    assert.match(src, /suggestion: sug/);
    assert.match(src, /a\.act === 'accept'\) acceptSuggestion\(sug\)/);
  });

  // acceptSuggestion: the guarded route through the keys chain
  const acc = (answer) => {
    const log = [];
    const api = mk(['async function acceptSuggestion(text)'], {
      enqueueJob: async (run) => { log.push('job'); return run(); }, DS: { accept: async (t) => { log.push(`accept ${t}`); return answer; } },
      renderSuggestion: () => log.push('render'), clearProblem: () => log.push('clear'), say: (m) => log.push(`say ${m}`),
      showProblem: (m, kind, ms) => log.push(`problem ${m} | ${kind} | ${ms}`), problemKind: problemKindReal,
    });
    return { ...api, log };
  };

  test('(+) acceptSuggestion runs in the keys chain, redraws the placeholder, clears the problem line and says what was taken', async () => {
    const r = acc({ ok: true, status: 200, message: '' });
    await r.acceptSuggestion(SUG);
    assert.deepEqual(r.log, ['job', `accept ${SUG}`, 'render', 'clear', `say Accepted Claude's suggestion: ${SUG}`]);
  });

  test('(−) a refusal shows its fixed line (warn; error for a gone or unreachable session), says nothing was accepted, and still redraws', async () => {
    const warn = acc({ ok: false, status: 409, message: "Claude's suggestion changed. Nothing was sent." });
    await warn.acceptSuggestion(SUG);
    assert.deepEqual(warn.log, ['job', `accept ${SUG}`, 'render', "problem Claude's suggestion changed. Nothing was sent. | warn | 6000"]);
    const gone = acc({ ok: false, status: 404, message: 'The session is gone.' });
    await gone.acceptSuggestion(SUG);
    assert.equal(gone.log.at(-1), 'problem The session is gone. | error | 6000');
    const local = acc({ ok: false, status: null, message: 'x' });
    await local.acceptSuggestion(SUG);
    assert.match(local.log.at(-1), /\| warn \|/, 'nothing was sent: a warning, not an error');
  });

  test('(−) the accept path sends no key itself: it goes only through DS.accept (the guarded route), never deliver, sendKey or the keys route', () => {
    const src = fnOf('async function acceptSuggestion(text)');
    assert.doesNotMatch(src, /deliver\(|sendKey\(|enqueue\(|enqueueSeq\(|\/keys|keys:/);
    assert.match(src, /DS\.accept\(text\)/);
  });

  test('(+) the sync gets a POST to the suggestion route with exactly the body it makes, and nothing else', () => {
    const at = SRC.indexOf('const DS = createDraftSync({');
    const src = SRC.slice(at, SRC.indexOf('});', at) + 3);
    assert.match(src, /suggest: \(body\) => call\(`\/api\/app\/pane\/\$\{encodeURIComponent\(paneId\)\}\/suggestion`, \{ method: 'POST', json: body \}\)/);
  });

  test('(−) accepting is not an edit of the box by the user: the pull inside DS.accept sets the text, the page never calls DS.edited for it', () => {
    assert.doesNotMatch(fnOf('async function acceptSuggestion(text)'), /DS\.edited|\.value\s*=/);
  });

  // CSS: its own look and its own word (the visible-state rule): colour + italic + the note's label
  const css = strip(CSS);
  test('(+) the suggestion placeholder has its own look (accent colour, italic) and the note its own colour; neither uses :has() or color-mix()', () => {
    assert.match(css, /\.inbox\.suggest textarea::placeholder\s*\{[^}]*color:\s*var\(--accent\)[^}]*font-style:\s*italic/);
    assert.match(css, /\.dnote\[data-k="suggest"\]\s*\{[^}]*color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/);
    assert.doesNotMatch(css, /:has\(|color-mix\(/);
  });

  test('(+) the note\'s icon exists in the page\'s sprite', () => {
    assert.match(HTML, /<symbol[^>]*id="i-kbd"/);
    assert.equal(noteViewReal({ kind: 'suggest' }).icon, 'kbd');
  });
});

// ---- 0.5, W7-T3: the fit (measure, requests, text scale, chip) ----------------------------------------------------------------------
// The pure rules are public/fit-ui.js (test/fit-ui.test.js). Here: the markup and stylesheet, and the functions of session.js run for
// real in a vm against a fake route, a manual clock and a fake DOM.

describe('W7-T3: the fit chip, the probe and the text scale (markup and stylesheet)', () => {
  const css = strip(CSS);
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';
  const rule = (sel) => new RegExp(`(^|[\\s}])${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? null;
  const head = /<div class="term-head"[^>]*>([\s\S]*?)<div class="pass-banner"/.exec(HTML)?.[1] ?? '';

  // F1 (design F12 2.1): the chip became a button inside a wrapper that carries `hidden`, followed by its panel
  const wrapHtml = /<span class="fit-wrap"[^>]*>([\s\S]*?)<\/span>\s*<span class="sp">/.exec(head)?.[1] ?? '';

  test('(+) F1: #fit-wrap is a hidden span in .term-head, after the Live label and before the spacer; it is not a live region (announce() speaks for it)', () => {
    const t = tag('fit-wrap');
    assert.match(t, /^<span class="fit-wrap"/);
    assert.match(t, /\bhidden\b/);
    assert.doesNotMatch(t, /aria-live|role=|tabindex/);
    assert.ok(head.indexOf('id="live-label"') >= 0 && head.indexOf('id="live-label"') < head.indexOf('id="fit-wrap"'), 'after Live C x R');
    assert.ok(head.indexOf('id="fit-wrap"') < head.indexOf('<span class="sp">'), 'before the spacer');
    assert.ok(wrapHtml.length > 0, 'the wrapper holds the button and the panel');
  });

  test('(+) F1: #fit-chip is a button (type="button") with aria-expanded="false" and aria-controls="fit-pop", empty, and visible: the wrapper hides it', () => {
    const t = tag('fit-chip');
    assert.match(t, /^<button type="button" class="fit"/);
    assert.match(t, /\baria-expanded="false"/);
    assert.match(t, /\baria-controls="fit-pop"/);
    assert.doesNotMatch(t, /\bhidden\b|\btitle=|aria-label=|aria-live|role=|tabindex/);
    assert.match(HTML, /id="fit-chip"[^>]*><\/button>/, 'empty: the script fills it');
    assert.doesNotMatch(HTML, /<span class="fit" id="fit-chip"/, 'no span any more');
    assert.ok(wrapHtml.indexOf('id="fit-chip"') >= 0 && wrapHtml.indexOf('id="fit-chip"') < wrapHtml.indexOf('id="fit-pop"'), 'the button comes first in the wrapper');
  });

  test('(+) F1: #fit-pop is a hidden group labelled by its heading, inside the wrapper, with the heading, reason, hint, note and the footer in this order', () => {
    const t = tag('fit-pop');
    assert.match(t, /^<div class="pop fit-pop"/);
    assert.match(t, /\brole="group"/);
    assert.match(t, /\baria-labelledby="fit-pop-h"/);
    assert.match(t, /\bhidden\b/);
    const ids = [...wrapHtml.slice(wrapHtml.indexOf('id="fit-pop"')).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ['fit-pop', 'fit-pop-h', 'fit-pop-why', 'fit-pop-hint', 'fit-pop-note', 'fit-pop-close', 'fit-again']);
    assert.match(tag('fit-pop-h'), /^<p class="pop-l"/);
    assert.match(tag('fit-pop-why'), /^<p class="fit-pop-why"/);
    for (const id of ['fit-pop-hint', 'fit-pop-note']) {
      assert.match(tag(id), /^<p class="pop-h[ "]/, id);
      assert.match(tag(id), /\bhidden\b/, id);
    }
    assert.match(tag('fit-pop-note'), /class="pop-h fit-pop-note"/);
  });

  test('(+) F1: Close comes before the action in the footer (Tab order), the action is the primary button, hidden until the script shows it, and is read with its reason', () => {
    assert.match(tag('fit-pop-close'), /^<button type="button" class="btn" /);
    const again = tag('fit-again');
    assert.match(again, /^<button type="button" class="btn primary"/);
    assert.match(again, /\bhidden\b/);
    assert.match(again, /\baria-describedby="fit-pop-why"/);
    assert.match(wrapHtml, /<div class="pop-f">\s*<button[^>]*id="fit-pop-close"[^>]*>Close<\/button>\s*<button[^>]*id="fit-again"[^>]*><\/button>\s*<\/div>/);
  });

  test('(+) F1: the chevron and the warning icon the button and the note draw are in the sprite', () => {
    for (const n of ['chev', 'warn']) assert.match(HTML, new RegExp(`<symbol id="i-${n}" viewBox="0 0 16 16">`), n);
  });

  test('(+) the sprite draws the four chip icons in the 16 x 16 stroke style, each different, and every icon chipView names is among them', () => {
    const bodies = ['fit', 'zoom', 'off', 'window'].map((n) => {
      const m = new RegExp(`<symbol id="i-${n}" viewBox="0 0 16 16">([\\s\\S]*?)</symbol>`).exec(HTML);
      assert.ok(m, `i-${n}`);
      assert.match(m[1], /<(path|circle|rect)\b/);
      assert.doesNotMatch(m[1], /\b(fill|stroke|style)=/, 'the .ic class draws the stroke');
      return m[1];
    });
    assert.equal(new Set(bodies).size, 4);
    for (const state of ['fitted', 'zoomed', 'blocked', 'other']) {
      const v = chipViewReal({ fit: { state, reason: state === 'zoomed' ? 'panel-smaller' : null } });
      assert.match(HTML, new RegExp(`<symbol id="i-${v.icon}"`), `${state} draws i-${v.icon}`);
    }
  });

  test('(+) each state has its own colour (data-k), and the chip is a bordered inline-flex label that does not wrap its words', () => {
    assert.match(rule('.fit') ?? '', /display:\s*inline-flex/);
    assert.match(rule('.fit') ?? '', /white-space:\s*nowrap/);
    const colours = ['fitted', 'zoomed', 'blocked', 'other'].map((k) => {
      const r = rule(`.fit[data-k="${k}"]`);
      assert.ok(r, k);
      return /(?:^|[\s;])color:\s*(var\(--[a-z-]+\))/.exec(r)?.[1];
    });
    assert.ok(colours.every(Boolean), `${colours}`);
    assert.equal(new Set(colours).size, 4, `four states, four colours: ${colours}`);
    assert.doesNotMatch(css, /color-mix\(|:has\(/);
  });

  // F1 (design F12 2.9): the look of the button, its chevron and the panel; tokens only, both themes through them
  const esc = (sel) => sel.replace(/[.[\]()+*?^$|\\]/g, '\\$&');
  const body = (sel) => new RegExp(`(?:^|[\\s}])${esc(sel)}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null;

  test('(+) F1: the wrapper is the panel\'s anchor (relative, inline-flex) so opening it never changes the header', () => {
    const r = body('.fit-wrap') ?? '';
    assert.match(r, /position:\s*relative/);
    assert.match(r, /display:\s*inline-flex/);
  });

  test('(+) F1: the button resets the font and keeps the chip\'s size, reach and weight: 24 px high (WCAG 2.2 target size), a pointer, small bold text', () => {
    const r = body('button.fit') ?? '';
    assert.match(r, /min-height:\s*24px/);
    assert.match(r, /cursor:\s*pointer/);
    assert.match(r, /font:\s*inherit/);
    assert.match(r, /font-size:\s*var\(--fs-small\)/);
    assert.match(r, /font-weight:\s*600/);
    assert.ok(r.indexOf('font: inherit') < r.indexOf('font-size'), 'the shorthand first, or it would reset the size');
    assert.match(body('button.fit') ?? '', /background:\s*transparent|background:\s*none/, 'a button has its own background; blocked has none of its own');
  });

  test('(+) F1: hover and the open state draw the edge in the text colour (blocked keeps its dashes: only the colour changes)', () => {
    const r = new RegExp(`button\\.fit:hover,\\s*button\\.fit\\[aria-expanded="true"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    assert.match(r, /border-color:\s*currentColor/);
    assert.doesNotMatch(r, /border-style|border:|dashed|solid/, 'only the colour, so the dashed edge of blocked stays');
  });

  test('(+) F1: the focus ring is the page\'s own (:focus-visible), and nothing takes the outline of the chip away', () => {
    assert.match(css, /(?:^|[\s}]):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
    assert.doesNotMatch(css, /\.fit[^{]*\{[^}]*outline:\s*(none|0)/);
  });

  test('(+) F1: the chevron is 12 px and turns half a turn while the panel is open, without a transition', () => {
    const base = body('.fit .chev') ?? '';
    assert.match(base, /width:\s*12px/);
    assert.match(base, /height:\s*12px/);
    assert.match(base, /margin-left:\s*2px/);
    assert.match(body('.fit[aria-expanded="true"] .chev') ?? '', /transform:\s*rotate\(180deg\)/);
    assert.doesNotMatch(css, /transition[^;}]*/, 'no motion rules in this stylesheet for the chip');
  });

  test('(+) F1: the panel is absolute under the chip (z-index above the terminal), 320 px wide, never wider than the window, and not pushed by .pop\'s own justify-self', () => {
    const r = body('.fit-pop') ?? '';
    assert.match(r, /position:\s*absolute/);
    assert.match(r, /top:\s*calc\(100% \+ 4px\)/);
    assert.match(r, /right:\s*0/);
    assert.match(r, /z-index:\s*30/);
    assert.match(r, /width:\s*320px/);
    assert.match(r, /max-width:\s*calc\(100vw - 16px\)/);
    assert.match(r, /justify-self:\s*auto/);
    assert.ok(css.indexOf('.fit-pop {') > css.indexOf('.pop {'), 'after .pop, which sets the width and the justify-self it overrides');
  });

  test('(+) F1: the placement rule of dom.js (data-x="start") has its CSS: left-aligned to the chip', () => {
    const r = body('.fit-pop[data-x="start"]') ?? '';
    assert.match(r, /left:\s*0/);
    assert.match(r, /right:\s*auto/);
  });

  // the design names a --warn token; the page has none: its warnings (.alert[data-kind="warn"] .ic, .dlg-warn) use --idle
  test('(+) F1: the reason, the note and the command are styled with tokens: small text colour, the page\'s warning colour (--idle) on the note\'s icon, a wrapping mono command', () => {
    assert.match(body('.fit-pop-why') ?? '', /font-size:\s*var\(--fs-small\)/);
    assert.match(body('.fit-pop-why') ?? '', /(^|[\s;])color:\s*var\(--text\)/);
    assert.match(body('.fit-pop-note') ?? '', /(^|[\s;])color:\s*var\(--text\)/);
    assert.match(body('.fit-pop-note .ic') ?? '', /(^|[\s;])color:\s*var\(--idle\)/);
    const code = body('.fit-pop code') ?? '';
    assert.match(code, /font:\s*var\(--fs-small\) var\(--mono\)/);
    assert.match(code, /overflow-wrap:\s*anywhere/);
  });

  test('(−) F1: the new rules take no colour but tokens that exist, and no color-mix() or :has()', () => {
    const own = ['.fit-wrap', 'button.fit', '.fit .chev', '.fit[aria-expanded="true"] .chev', '.fit-pop', '.fit-pop[data-x="start"]', '.fit-pop-why', '.fit-pop-note', '.fit-pop-note .ic', '.fit-pop code']
      .map((sel) => body(sel) ?? '').join(' ');
    assert.notEqual(own.trim(), '');
    assert.doesNotMatch(own, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|:has\(/i);
    for (const v of own.match(/var\(--[a-z0-9-]+\)/g)) assert.ok(TOKENS.includes(`${v.slice(4, -1)}:`), `${v} is a token`);
  });

  test('(+) a header too narrow for the chip wraps instead of pushing the window sideways', () => {
    assert.match(css, /(^|[\s}])\.term-head\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  // fix round 2, review minor 3: fit-ui.js subtracts the padding of .term from the box; if the stylesheet changes, the pane would be asked for a column or row too many
  test('(+) the padding fit-ui.js takes off the box is the padding of .term in session.css', () => {
    const bodies = [...css.matchAll(/(?:^|[\s}])\.term\s*\{([^}]*)\}/g)].map((m) => m[1]);
    assert.equal(bodies.length, 1, 'one .term rule');
    const pad = /(?:^|[\s;])padding:\s*(\d+)px\s+(\d+)px\s*;/.exec(bodies[0]);
    assert.ok(pad, 'padding is "Y px X px" (a different shorthand needs this test taught)');
    assert.doesNotMatch(bodies[0], /border(?:-width)?:\s*[1-9]/, 'a border on .term would be taken off too');
    const [padY, padX] = [2 * Number(pad[1]), 2 * Number(pad[2])];
    // a box of exactly padding + 100 x 50 one-pixel cells holds 100 x 50 cells: one more or less padding in fit-ui.js changes it
    assert.deepEqual(norm(panelSizeReal({ width: padX + 100, height: padY + 50, cellW: 1, cellH: 1 })), { cols: 100, rows: 50 });
    assert.deepEqual(norm(panelSizeReal({ width: padX + 99, height: padY + 49, cellW: 1, cellH: 1 })), { cols: 99, rows: 49 });
  });

  test('(+) the probe is hidden, aria-hidden, in .term after the rows, holds 100 zeros, and has the unscaled terminal font', () => {
    const t = tag('fit-probe');
    assert.match(t, /\bclass="fit-probe"/);
    assert.match(t, /\baria-hidden="true"/);
    assert.match(HTML, /id="fit-probe"[^>]*>0{100}<\/div>/);
    const term = HTML.slice(HTML.indexOf('<div class="term"'), HTML.indexOf('<span class="paused-note"'));
    assert.ok(term.indexOf('id="term-rows"') < term.indexOf('id="fit-probe"'), 'in .term, after the rows');
    const r = rule('.fit-probe') ?? '';
    assert.match(r, /position:\s*absolute/);
    assert.match(r, /visibility:\s*hidden/);
    assert.match(r, /left:\s*-9999px/);
    assert.match(r, /top:\s*0/, 'at the top, so it adds no height to the scroll area');
    assert.match(r, /white-space:\s*pre/);
    assert.match(r, /font:\s*var\(--fs-term\)\/1\.35 var\(--mono\)/);
    assert.match(rule('.term-rows') ?? '', /font:\s*var\(--fs-term\)\/1\.35 var\(--mono\)/, 'the probe measures the same font as the rows');
  });

  test('(+) the rows take their size from --fit-scale (1 when unset), after the font shorthand; the cut strip keeps its own font', () => {
    assert.match(rule('.term-rows') ?? '', /font:[^;]*;[^}]*font-size:\s*calc\(var\(--fs-term\) \* var\(--fit-scale, 1\)\)/);
    assert.match(rule('.tl') ?? '', /min-height:\s*1\.35em/, 'a row is 1.35 em, so its height scales with the text');
    assert.match(css, /\.tl\.cut\s*\{[^}]*font:\s*var\(--fs-small\)/);
  });

  test('(+) --fit-scale is set through CSSOM only: one setProperty in session.js, no style attribute, no style string anywhere', () => {
    const src = code(JS['session.js']);
    assert.equal([...src.matchAll(/--fit-scale/g)].length, 1, 'named once');
    assert.match(src, /\$\('term'\)\.style\.setProperty\('--fit-scale', String\(s\)\)/);
    assert.doesNotMatch(HTML, /\sstyle\s*=/i);
    assert.doesNotMatch(code(JS['fit-ui.js']), /--fit-scale|\.style\b|setAttribute/, 'the pure module never touches the page');
  });

  test('(−) the pure module has no DOM, request, storage or timer of its own', () => {
    assert.doesNotMatch(code(JS['fit-ui.js']), /\b(document|window|navigator|location)\s*[.[]|\b(fetch|setTimeout|setInterval|clearTimeout|XMLHttpRequest)\s*\(|localStorage|sessionStorage|\/api\//);
  });
});

/** The colour helpers the fit chip's hue tests share (W7 fix round 1, F4): the tokens of each theme, WCAG 2.x contrast and OKLab distance. */
function colourKit() {
  const blockAt = (opener) => {
    const at = TOKENS.indexOf(opener);
    assert.ok(at >= 0, `${opener} exists`);
    const open = TOKENS.indexOf('{', at);
    return TOKENS.slice(open + 1, TOKENS.indexOf('}', open));
  };
  const vars = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const BLOCKS = {
    light: blockAt(':root {'),
    dark: blockAt(':root:not([data-theme="light"]) {'),
    darkPinned: blockAt(':root[data-theme="dark"] {'),
  };
  const THEME = Object.fromEntries(Object.entries(BLOCKS).map(([k, b]) => [k, k === 'light' ? vars(b) : { ...vars(BLOCKS.light), ...vars(b) }]));
  // WCAG 2.x contrast, and OKLab distance (Ottosson) for "a different colour", not only a different hex
  const lin = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = (hex) => { const c = lin(hex); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const oklab = (hex) => {
    const [r, g, b] = lin(hex);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const dE = (a, b) => { const [p, q] = [oklab(a), oklab(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  const MIN_DE = 0.05; // the palette's own closest pair of colours that are meant to differ is 0.053 (dark: --m-manual and --m-default)
  return { THEME, ratio, dE, MIN_DE };
}

describe('W7-T3 fix round 1: the "other" chip has its own hue (tokens.css --fit-other*)', () => {
  const css = strip(CSS);
  const { THEME, ratio, dE, MIN_DE } = colourKit();
  const NAMES = ['--fit-other', '--fit-other-soft', '--fit-other-line'];

  test('(+) the three tokens are plain 6-digit hex in the light block and in both dark blocks, and the dark blocks agree', () => {
    for (const [name, v] of Object.entries(THEME)) for (const n of NAMES) assert.match(v[n] ?? '', /^#[0-9a-f]{6}$/i, `${n} in ${name}`);
    for (const n of NAMES) assert.equal(THEME.dark[n], THEME.darkPinned[n], n);
    for (const n of NAMES) assert.notEqual(THEME.light[n], THEME.dark[n], `${n} is tuned per theme`);
  });

  for (const name of Object.keys(THEME)) {
    test(`(+) contrast (${name}): the chip text is 4.5:1 on its soft fill and on the surfaces it can sit on; the edge is 3:1`, () => {
      const v = THEME[name];
      for (const ground of [v['--fit-other-soft'], v['--surface'], v['--bg'], v['--surface-2'], v['--surface-3'], v['--attn-row']]) {
        assert.ok(ratio(v['--fit-other'], ground) >= 4.5, `text on ${ground}: ${ratio(v['--fit-other'], ground).toFixed(2)}`);
      }
      for (const ground of [v['--bg'], v['--surface'], v['--surface-2']]) {
        assert.ok(ratio(v['--fit-other-line'], ground) >= 3, `edge on ${ground}: ${ratio(v['--fit-other-line'], ground).toFixed(2)}`);
      }
    });

    test(`(+) distinct (${name}): the colour is at least ${MIN_DE} OKLab away from accent, busy, idle, attention, danger, ended, the muted grey and every --m-* mode colour`, () => {
      const v = THEME[name];
      const peers = ['--accent', '--busy', '--idle', '--attn', '--danger', '--ended', '--text-muted', ...Object.keys(v).filter((k) => /^--m-[a-z]+$/.test(k))];
      assert.ok(peers.length >= 7 + 8, `the mode colours were found: ${peers.length}`);
      for (const p of peers) assert.ok(dE(v['--fit-other'], v[p]) >= MIN_DE, `${p} ${v[p]}: ${dE(v['--fit-other'], v[p]).toFixed(3)}`);
    });
  }

  test('(+) the other state reads the three tokens for text, fill and edge; blocked keeps the muted grey; fitted and zoomed keep accent and idle', () => {
    const rule = (k) => new RegExp(`\\.fit\\[data-k="${k}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    const other = rule('other');
    assert.match(other, /(^|[\s;])color:\s*var\(--fit-other\)/);
    assert.match(other, /background:\s*var\(--fit-other-soft\)/);
    assert.match(other, /border-color:\s*var\(--fit-other-line\)/);
    assert.match(rule('blocked'), /(^|[\s;])color:\s*var\(--text-muted\)/);
    assert.match(rule('blocked'), /dashed/);
    assert.match(rule('fitted'), /(^|[\s;])color:\s*var\(--accent\)/);
    assert.match(rule('zoomed'), /(^|[\s;])color:\s*var\(--idle\)/);
  });

  test('(−) the new tokens are used by the other chip and the Cursor note (W13) only, and tokens.css stays ASCII with no color-mix() or :has()', () => {
    const users = ['session.css', 'app.css', 'tokens.css'].flatMap((f) => (read(f).match(/var\(--fit-other[a-z-]*\)/g) ?? []).map((u) => `${f} ${u}`));
    assert.deepEqual(users.filter((u) => !u.startsWith('session.css')), []);
    assert.equal(users.length, 5);
    const rules = read('session.css').split('\n').filter((l) => /var\(--fit-other/.test(l)).map((l) => l.slice(0, l.indexOf(' {')));
    assert.deepEqual(rules, ['.fit[data-k="other"]', '.dnote[data-k="cursor"]']);
    const tokens = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(tokens, /color-mix\(|:has\(/);
    assert.equal([...TOKENS].every((ch) => ch.codePointAt(0) < 128), true);
  });
});

// ---- 0.5, F4-T2: the state `terminal` (design F4 3.5 to 3.7; owner answers of 2026-11-16: its own plum colour tokens and a terminal icon) ----
describe('F4-T2: the terminal chip has its own plum hue (tokens.css --fit-term*) and its own icon (session.html i-term)', () => {
  const css = strip(CSS);
  const { THEME, ratio, dE, MIN_DE } = colourKit();
  const NAMES = ['--fit-term', '--fit-term-soft', '--fit-term-line'];
  const rule = (k) => new RegExp(`(?:^|[\\s}])\\.fit\\[data-k="${k}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const symbol = (n) => new RegExp(`<symbol id="i-${n}" viewBox="0 0 16 16">([\\s\\S]*?)</symbol>`).exec(HTML)?.[1] ?? null;

  test('(+) the sprite draws i-term in the 16 x 16 stroke style (the .ic class draws the stroke), and it differs from every other chip icon and from the transcript frame', () => {
    const t = symbol('term');
    assert.ok(t, 'i-term is in the sprite');
    assert.match(t, /<(path|circle|rect)\b/);
    assert.match(t, /<rect\b/, 'a frame');
    assert.match(t, /<path\b/, 'with a prompt in it');
    assert.doesNotMatch(t, /\b(fill|stroke|style)=/);
    const others = ['fit', 'zoom', 'off', 'window', 'hist-off', 'hist-on'].map(symbol);
    assert.ok(others.every(Boolean));
    assert.equal(new Set([t, ...others]).size, 7, 'a different drawing from the other six');
  });

  test('(+) the icon chipView names for `terminal` is in the sprite', () => {
    const v = chipViewReal({ fit: { state: 'terminal', reason: null, panes: 1, userZoom: false } });
    assert.equal(v.icon, 'term');
    assert.match(HTML, new RegExp(`<symbol id="i-${v.icon}" viewBox="0 0 16 16">`));
  });

  test('(+) the three tokens are plain 6-digit hex in the light block and in both dark blocks, the dark blocks agree, and each is tuned per theme', () => {
    for (const [name, v] of Object.entries(THEME)) for (const n of NAMES) assert.match(v[n] ?? '', /^#[0-9a-f]{6}$/i, `${n} in ${name}`);
    for (const n of NAMES) assert.equal(THEME.dark[n], THEME.darkPinned[n], n);
    for (const n of NAMES) assert.notEqual(THEME.light[n], THEME.dark[n], `${n} is tuned per theme`);
  });

  for (const name of Object.keys(THEME)) {
    test(`(+) contrast (${name}): the chip text is 4.5:1 on its soft fill and on the surfaces it can sit on (the --fit-other grounds); the edge is 3:1`, () => {
      const v = THEME[name];
      for (const ground of [v['--fit-term-soft'], v['--surface'], v['--bg'], v['--surface-2'], v['--surface-3'], v['--attn-row']]) {
        assert.ok(ratio(v['--fit-term'], ground) >= 4.5, `text on ${ground}: ${ratio(v['--fit-term'], ground).toFixed(2)}`);
      }
      for (const ground of [v['--bg'], v['--surface'], v['--surface-2']]) {
        assert.ok(ratio(v['--fit-term-line'], ground) >= 3, `edge on ${ground}: ${ratio(v['--fit-term-line'], ground).toFixed(2)}`);
      }
    });

    test(`(+) distinct (${name}): the colour is at least ${MIN_DE} OKLab away from accent, busy, idle, attention, danger, ended, the muted grey, every --m-* mode colour and --fit-other`, () => {
      const v = THEME[name];
      const peers = ['--accent', '--busy', '--idle', '--attn', '--danger', '--ended', '--text-muted', '--fit-other', ...Object.keys(v).filter((k) => /^--m-[a-z]+$/.test(k))];
      assert.ok(peers.length >= 8 + 8, `the mode colours were found: ${peers.length}`);
      for (const p of peers) assert.ok(dE(v['--fit-term'], v[p]) >= MIN_DE, `${p} ${v[p]}: ${dE(v['--fit-term'], v[p]).toFixed(3)}`);
    });
  }

  test('(+) the terminal state reads the three tokens for text, fill and edge, and the five states have five different text colours', () => {
    const term = rule('terminal');
    assert.match(term, /(^|[\s;])color:\s*var\(--fit-term\)/);
    assert.match(term, /background:\s*var\(--fit-term-soft\)/);
    assert.match(term, /border-color:\s*var\(--fit-term-line\)/);
    const colours = ['fitted', 'zoomed', 'blocked', 'other', 'terminal'].map((k) => /(?:^|[\s;])color:\s*(var\(--[a-z-]+\))/.exec(rule(k))?.[1]);
    assert.ok(colours.every(Boolean), `${colours}`);
    assert.equal(new Set(colours).size, 5, `five states, five colours: ${colours}`);
  });

  test('(−) the earlier four states keep their colours: other keeps --fit-other (it is not shared), blocked the muted grey, fitted accent, zoomed idle', () => {
    assert.match(rule('other'), /(^|[\s;])color:\s*var\(--fit-other\)/);
    assert.doesNotMatch(rule('other'), /--fit-term/);
    assert.match(rule('blocked'), /(^|[\s;])color:\s*var\(--text-muted\)/);
    assert.match(rule('blocked'), /dashed/);
    assert.match(rule('fitted'), /(^|[\s;])color:\s*var\(--accent\)/);
    assert.match(rule('zoomed'), /(^|[\s;])color:\s*var\(--idle\)/);
  });

  test('(−) the new tokens are used by the terminal chip rule only, defined once per theme block in tokens.css, which stays ASCII with no color-mix() or :has()', () => {
    const users = ['session.css', 'app.css', 'tokens.css'].flatMap((f) => (read(f).match(/var\(--fit-term[a-z-]*\)/g) ?? []).map((u) => `${f} ${u}`));
    assert.deepEqual(users, ['session.css var(--fit-term)', 'session.css var(--fit-term-soft)', 'session.css var(--fit-term-line)']);
    const rules = read('session.css').split('\n').filter((l) => /var\(--fit-term/.test(l)).map((l) => l.slice(0, l.indexOf(' {')));
    assert.deepEqual(rules, ['.fit[data-k="terminal"]']);
    for (const n of NAMES) assert.equal([...TOKENS.matchAll(new RegExp(`${n}:`, 'g'))].length, 3, `${n}: the light block and the two dark blocks`);
    const tokens = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(tokens, /color-mix\(|:has\(/);
    assert.equal([...TOKENS].every((ch) => ch.codePointAt(0) < 128), true);
  });
});

describe('W7-T3: the fit in the session window (wiring)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const FITTED = { status: 200, body: { fit: { state: 'fitted', reason: null, pane: { cols: 100, rows: 30 }, panes: 3, userZoom: false } } };
  const answer = (state, reason = null) => ({ status: 200, body: { fit: { state, reason, pane: { cols: 100, rows: 30 }, panes: 3, userZoom: false } } });
  let restoreDom;
  before(() => { restoreDom = installDom(); });
  after(() => restoreDom());

  /** A manual clock for the page's setTimeout / clearTimeout; advance(ms) runs the timers due and lets the promises settle. */
  const fakeClock = () => {
    let now = 0;
    let next = 1;
    const timers = new Map();
    const settle = () => new Promise((resolve) => { setImmediate(resolve); });
    return {
      setTimeout(fn, ms) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
      get pending() { return timers.size; },
      async advance(ms) {
        const end = now + ms;
        for (;;) {
          const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
          if (!due) break;
          timers.delete(due[0]);
          now = due[1].at;
          due[1].fn();
          await settle();
        }
        now = end;
        await settle();
      },
    };
  };

  const NAMES = [
    'function fitCall(', 'function fitMeasure()', 'function fitScale()', 'function fitResize()', 'function fitCaptured()',
    'function drawFitPop()', 'function openFitPop()', 'function closeFitPop(refocus)', 'function fitAway(e)', 'function fitAgainEvent(e)',
    'function renderFit(view, opts)', 'function wireFitPop()', 'function wireFit()', 'function setGone()', 'function handleCapture(r)', 'function fitFocused()',
    // F10 (design F10 2 to 6)
    'function fitProbe()', 'function fitCommit()', 'function fitChip(view, opts)', 'function flushChip()', 'function fitSized(pane)', 'function handleHeld(r)',
    'function applyHeld(r)', 'function refit(oldScale)', 'function endRefit()', 'function holdTimeout(pending, ctx)', 'function holdEnded()',
    // F11 (design F11 2 to 6)
    'function fitStrip()',
  ];
  /** An element that also answers contains() (the fake El has no tree search): the panel's focus and dismissal rules ask it. */
  class Box extends El {
    contains(n) {
      for (let x = n; x; x = x.parent) if (x === this) return true;
      return false;
    }
  }
  const box = (tag, hidden = false) => {
    const e = new Box(tag);
    e.hidden = hidden;
    return e;
  };
  /**
   * The fit functions of session.js with a pane (or none), a terminal box of box.w x box.h CSS px, a glyph cell of cell.w / 100 x cell.h px
   * (the probe is 100 glyphs wide) and the route's replies in order (then FITTED). The box 827 x 562 with an 8 x 18 cell is 100 x 30 cells.
   * F1: the chip is a button in a hidden wrapper (`wrap`) with its panel (`pop`, `close`, `again`, ...); `outside` is a button elsewhere in
   * the header, `histToggle` the one focus goes to when the whole chip goes away; focus is the fake DOM's (focusState.el).
   */
  const rig = ({ pane = '%12', box: size = { w: 827, h: 562 }, cell = { w: 800, h: 18 }, replies = [], observer = true, realDraw = false, strip = 27 } = {}) => {
    const clk = fakeClock();
    const log = { calls: [], said: [], props: [], ro: null, observed: null, events: {}, gone: 0, overlays: [], placed: [], kicks: [], noted: [], drawn: [], lives: [], scrolled: [], rowsOn: {}, classOps: [], cutRows: [] };
    // F10: the page measures the border box (getBoundingClientRect), here the same numbers as the client box; scrollTop / scrollHeight show the re-pin
    const term = { clientWidth: size.w, clientHeight: size.h, scrollTop: 0, scrollHeight: 0, rectExtra: { w: 0, h: 0 }, getBoundingClientRect: () => ({ width: term.clientWidth + term.rectExtra.w, height: term.clientHeight + term.rectExtra.h }), style: { setProperty: (k, v) => log.props.push([k, v]) } };
    // F10: the mirror's rows element: the refit class (classList), the custom property (style.setProperty, never a style attribute) and the animationend listener
    const classes = new Set();
    const rows = { classes, classList: { add: (c) => { log.classOps.push(`+${c}`); classes.add(c); }, remove: (c) => { log.classOps.push(`-${c}`); classes.delete(c); }, contains: (c) => classes.has(c) }, offsetWidth: 0, offsetTop: 10, offsetHeight: 300, style: { props: {}, setProperty(k, v) { this.props[k] = String(v); } }, addEventListener: (t, fn) => { log.rowsOn[t] = fn; } };
    // F11: the strip stands 6 px under the rows (its margin); `strip` is its whole height in px, or null for a webview that gives no offsets
    const cutEl = { hidden: true, offsetTop: strip === null ? undefined : 10 + 300 + 6, offsetHeight: strip === null ? undefined : strip - 6 };
    const probe = { getBoundingClientRect: () => ({ width: cell.w, height: cell.h }) };
    const wrap = box('span', true);
    const chip = box('button');
    chip.setAttribute('aria-expanded', 'false');
    const pop = box('div', true);
    const [popH, popWhy, popHint, popNote, foot] = [box('p'), box('p'), box('p', true), box('p', true), box('div')];
    const [close, again] = [box('button'), box('button', true)];
    close.textContent = 'Close';
    foot.append(close, again);
    pop.append(popH, popWhy, popHint, popNote, foot);
    wrap.append(chip, pop);
    const histToggle = box('button');
    const outside = box('button');
    const els = { term, 'term-rows': rows, 'term-cut': cutEl, 'fit-probe': probe, 'fit-chip': chip, 'fit-wrap': wrap, 'fit-pop': pop, 'fit-pop-h': popH, 'fit-pop-why': popWhy, 'fit-pop-hint': popHint, 'fit-pop-note': popNote, 'fit-pop-close': close, 'fit-again': again, 'hist-toggle': histToggle };
    const docOn = new Map(); // the document's listeners by type: the page adds pointerdown while the panel is open and removes it when it closes
    // F9: what the page reads for its focus: document.visibilityState and document.hasFocus(); `throws` makes hasFocus() throw
    const page = { visible: true, focus: false, throws: false };
    focusState.el = null;
    const ctx = {
      paneId: pane, M: { cols: 0, rows: 0, gone: false, timer: 0, errors: 0, inputOff: false, frozen: false, body: null, draft: null, etag: null, cut: null },
      FIT: { planner: null, panel: null, frame: null, scale: 1, view: null, ui: { pending: false, note: false }, pop: false, state: null, room: false, d: 0, sentRows: 0, held: null, refitTimer: 0, hide: 0, strip: 0, sentCols: 0, scaledAt: null }, SC: { planner: null, scrolled: false },
      P: { on: false }, // F11: Type into pane, read by the real drawMirror
      $: (id) => els[id],
      call: async (path, opts) => { log.calls.push({ path, ...opts }); return replies.length ? replies.shift() : FITTED; },
      announce: (m) => log.said.push(m), h: hReal, icon: iconReal, Node: El,
      panelSize: panelSizeReal, scaleFor: scaleForReal, createFitPlanner: createFitPlannerReal, fitPanelView: fitPanelViewReal, stillOffSay: stillOffSayReal,
      remeasure: remeasureReal, askSize: askSizeReal, roomStep: roomStepReal, refitFrom: refitFromReal, REFIT_MS: REFIT_MS_REAL,
      hiddenRows: hiddenRowsReal, fillSize: fillSizeReal, drawnScale: drawnScaleReal, // F11
      cutAt: cutAtReal, cutCursor: cutCursorReal, toRenderModel: toRenderModelReal, applyMirror: (container, model) => { log.drawn.push(1); log.cutRows.push(model.length); }, // F11: for the real drawMirror (`realDraw`)
      // F10: the capture path of handleCapture, with spies where the page would draw or judge the screen (noteScreen is what moves the mode chip)
      noteScreen: (b) => log.noted.push(b), drawMirror: () => log.drawn.push(1), cleanDraft: cleanDraftReal, ATT: { sending: () => false }, renderSuggestion() {}, Q: { queued: false }, renderQuick() {},
      scrollCaptured: (b) => log.scrolled.push(b), ETAG: /^[0-9a-f]{1,64}$/, MID: ' - ', TIMES: 'x', kickMirror: (ms) => log.kicks.push(ms),
      placeMenuX: (m, btn) => log.placed.push(['place', m === pop, btn === chip, pop.hidden]),
      clearMenuPlacement: (m) => log.placed.push(['clear', m === pop, pop.hidden]),
      setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
      ResizeObserver: observer ? class { constructor(cb) { log.ro = cb; } observe(el) { log.observed = el; } } : undefined,
      document: {
        fonts: { ready: Promise.resolve() },
        get visibilityState() { return page.visible ? 'visible' : 'hidden'; },
        hasFocus: () => { if (page.throws) throw new Error('hasFocus unreadable'); return page.focus; },
        get activeElement() { return focusState.el; },
        addEventListener: (type, fn) => { if (!docOn.has(type)) docOn.set(type, new Set()); docOn.get(type).add(fn); },
        removeEventListener: (type, fn) => { docOn.get(type)?.delete(fn); },
      },
      window: { addEventListener: (type, fn) => { log.events[type] = fn; }, innerWidth: 1200, innerHeight: 800 },
      DS: { stop() {}, capture() {} }, setLive: (state, text) => log.lives.push([state, text]), setPaneState() {}, setInputEnabled() {}, showOverlay: (title) => log.overlays.push(title), recovered() {}, serverMessage: () => '',
    };
    // F10: the redraw hold on the rig's clock; its timeout and end go to the page's own functions (resolved lazily, they are defined just below)
    let fns = null;
    ctx.HOLD = createRedrawHoldReal({ after: clk.setTimeout, cancel: clk.clearTimeout, timeout: (pending, c) => fns.holdTimeout(pending, c), ended: () => fns.holdEnded() });
    // F11: `realDraw` runs the page's own drawMirror (it sets M.cut and shows the strip) instead of the spy
    fns = vm.runInNewContext(`${NAMES.concat(realDraw ? ['function drawMirror()'] : []).map(fnOf).join('\n')}; ({ fitCall, fitMeasure, fitScale, fitResize, fitCaptured, drawFitPop, openFitPop, closeFitPop, fitAgainEvent, renderFit, wireFitPop, wireFit, setGone, handleCapture, fitFocused, fitProbe, fitCommit, fitChip, flushChip, fitSized, handleHeld, applyHeld, refit, endRefit, holdTimeout, holdEnded, fitStrip${realDraw ? ', drawMirror' : ''} })`, ctx);
    const pointerdown = (target) => { for (const fn of [...(docOn.get('pointerdown') ?? [])]) fn({ type: 'pointerdown', target }); };
    return {
      ...fns, ctx, log, clk, page, term, rows, cutEl, chip, wrap, pop, popH, popWhy, popHint, popNote, close, again, histToggle, outside, pointerdown,
      listeners: (type) => docOn.get(type)?.size ?? 0,
    };
  };
  const calls = (r) => norm(r.log.calls);
  // F9 (requirement change, not a weakened test): the body carries `focus` too, false while the page is not focused (the rig's default)
  const PUT = (cols, rows, open, focus = false) => ({ path: '/api/app/pane/%2512/fit', method: 'PUT', json: { cols, rows, open, focus } });
  const DELETE = { path: '/api/app/pane/%2512/fit', method: 'DELETE', keepalive: true };

  test('(+) measuring: the box 827 x 562 with a probe of 800 x 18 px (8 x 18 per glyph) is 100 x 30 cells; padding is taken off first', () => {
    const r = rig();
    assert.deepEqual(norm(r.fitMeasure()), { cols: 100, rows: 30 });
    assert.deepEqual(norm(r.ctx.FIT.panel), { cols: 100, rows: 30 });
  });

  test('(−) a box that cannot be measured (a hidden tab) keeps the last good size and asks nothing new', async () => {
    const r = rig();
    r.wireFit();
    r.term.clientWidth = 0;
    r.term.clientHeight = 0;
    assert.deepEqual(norm(r.fitMeasure()), { cols: 100, rows: 30 });
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
  });

  test('(+) wireFit watches the terminal box with a ResizeObserver and the page\'s fonts, and measures at once; it asks nothing until a capture has answered', async () => {
    const r = rig();
    r.wireFit();
    assert.equal(r.log.observed, r.term);
    assert.deepEqual(norm(r.ctx.FIT.panel), { cols: 100, rows: 30 });
    await r.clk.advance(60000);
    assert.deepEqual(calls(r), []);
    assert.equal(typeof r.log.events.pagehide, 'function');
  });

  test('(+) the first capture starts the fit: one PUT to the pane\'s fit route with exactly cols, rows and open: true', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
    r.fitCaptured(); // every capture calls it
    r.fitCaptured();
    await r.clk.advance(0);
    assert.equal(r.log.calls.length, 1, 'start is once');
  });

  test('(+) a resize of the box is asked for 250 ms after the last change, with open: false; an unchanged size is not asked for', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.term.clientWidth = 24 + 8 * 110 + 1;
    r.log.ro();
    await r.clk.advance(249);
    assert.equal(r.log.calls.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(110, 30, false)]);
    r.log.ro();
    r.log.ro();
    await r.clk.advance(1000);
    assert.equal(r.log.calls.length, 2, 'the observer fired again with the same size');
  });

  test('(+) the heartbeat is a PUT every 5 s with the current size and open: false', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    await r.clk.advance(4999);
    assert.equal(r.log.calls.length, 1);
    await r.clk.advance(1);
    await r.clk.advance(5000);
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(100, 30, false), PUT(100, 30, false)]);
  });

  // F9 (requirement change, not a weakened test): the handler now also calls planner.focusChanged(document.hidden) first, both ways; the stubs have the method
  test('(+) the window showing again is one PUT now: boot\'s visibilitychange handler calls planner.beat() when the page is visible, and not when it is hidden', () => {
    const boot = fnOf('function boot()');
    const at = boot.indexOf("document.addEventListener('visibilitychange'");
    assert.ok(at > 0);
    const stmt = boot.slice(at, boot.indexOf('\n  });', at) + 6);
    const run = ({ hidden, planner }) => {
      const log = [];
      let handler;
      vm.runInNewContext(stmt, {
        document: { hidden, addEventListener: (type, fn) => { if (type === 'visibilitychange') handler = fn; } },
        kickMirror: () => log.push('mirror'), refreshHistory: () => log.push('history'), refreshAgent: () => log.push('agent'),
        FIT: { planner },
      });
      handler();
      return log;
    };
    assert.deepEqual(run({ hidden: false, planner: { beat: () => 'ignored', focusChanged: () => {} } }).length, 3, 'the old three still run');
    const beats = [];
    run({ hidden: false, planner: { beat: () => beats.push(1), focusChanged: () => {} } });
    assert.equal(beats.length, 1);
    run({ hidden: true, planner: { beat: () => beats.push(1), focusChanged: () => {} } });
    assert.equal(beats.length, 1, 'hidden: nothing');
    assert.doesNotThrow(() => run({ hidden: false, planner: null }), 'a window with no pane has no planner');
  });

  // F9 (design F9 3.2, 7.4)
  test('(+) F9: the visibilitychange handler calls planner.focusChanged(document.hidden) first, in both directions, then keeps its visible-only work in the old order', () => {
    const boot = fnOf('function boot()');
    const at = boot.indexOf("document.addEventListener('visibilitychange'");
    const stmt = boot.slice(at, boot.indexOf('\n  });', at) + 6);
    const run = (hidden) => {
      const log = [];
      let handler;
      vm.runInNewContext(stmt, {
        document: { hidden, addEventListener: (type, fn) => { if (type === 'visibilitychange') handler = fn; } },
        kickMirror: () => log.push('mirror'), refreshHistory: () => log.push('history'), refreshAgent: () => log.push('agent'),
        FIT: { planner: { focusChanged: (immediate) => log.push(`focusChanged ${immediate}`), beat: () => log.push('beat') } },
      });
      handler();
      return log;
    };
    assert.deepEqual(run(false), ['focusChanged false', 'mirror', 'history', 'agent', 'beat']);
    assert.deepEqual(run(true), ['focusChanged true'], 'hidden: the immediate give-back, and none of the visible-only work');
  });

  test('(−) F9: a page with no pane has no planner, and the handler still does not throw hidden or shown', () => {
    const boot = fnOf('function boot()');
    const at = boot.indexOf("document.addEventListener('visibilitychange'");
    const stmt = boot.slice(at, boot.indexOf('\n  });', at) + 6);
    for (const hidden of [true, false]) {
      let handler;
      vm.runInNewContext(stmt, {
        document: { hidden, addEventListener: (type, fn) => { if (type === 'visibilitychange') handler = fn; } },
        kickMirror() {}, refreshHistory() {}, refreshAgent() {}, FIT: { planner: null },
      });
      assert.doesNotThrow(() => handler(), String(hidden));
    }
  });

  // ---- F9 (design F9 3.1 to 3.3, 7.4): the page's focus goes to the server --------------------------------------------------------------------
  /** fitFocused() run alone against a document made of `doc`. */
  const focusedWith = (doc) => vm.runInNewContext(`${fnOf('function fitFocused()')}; fitFocused()`, { document: doc });

  test('(+) F9: fitFocused is true only while the page is visible and hasFocus() is the boolean true', () => {
    assert.equal(focusedWith({ visibilityState: 'visible', hasFocus: () => true }), true);
    assert.equal(focusedWith({ visibilityState: 'visible', hasFocus: () => false }), false);
    assert.equal(focusedWith({ visibilityState: 'hidden', hasFocus: () => true }), false, 'minimized, closed to the tray or covered: no focus, whatever hasFocus() says');
    assert.equal(focusedWith({ visibilityState: 'prerender', hasFocus: () => true }), false);
  });

  test('(−) F9: anything unreadable is "no focus": a missing or non-function hasFocus, a non-boolean answer, a throw, a missing visibilityState', () => {
    assert.equal(focusedWith({ visibilityState: 'visible' }), false, 'no hasFocus');
    assert.equal(focusedWith({ visibilityState: 'visible', hasFocus: true }), false, 'not a function');
    for (const odd of [1, 'true', {}, null, undefined, [true]]) assert.equal(focusedWith({ visibilityState: 'visible', hasFocus: () => odd }), false, JSON.stringify(odd));
    assert.equal(focusedWith({ visibilityState: 'visible', hasFocus: () => { throw new Error('boom'); } }), false, 'hasFocus throws');
    assert.equal(focusedWith({ get visibilityState() { throw new Error('boom'); }, hasFocus: () => true }), false, 'visibilityState throws');
    assert.equal(focusedWith({ hasFocus: () => true }), false, 'no visibilityState');
    assert.equal(focusedWith({}), false);
  });

  test('(+) F9: io.focused is fitFocused: the first PUT carries focus true while the page is visible and focused, false otherwise', async () => {
    for (const [visible, focus, expected] of [[true, true, true], [true, false, false], [false, true, false]]) {
      const r = rig();
      r.page.visible = visible;
      r.page.focus = focus;
      r.wireFit();
      r.fitCaptured();
      await r.clk.advance(0);
      assert.deepEqual(calls(r), [PUT(100, 30, true, expected)], `visible ${visible} focus ${focus}`);
    }
    const r = rig();
    r.page.focus = true;
    r.page.throws = true;
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(100, 30, true, false)], 'hasFocus() throws: no focus');
    assert.match(fnOf('function wireFit()'), /focused:\s*fitFocused\b/);
  });

  // F10 (requirement change, not a weakened test): the owner's Q2 answer replaces F9's 200 / 400 ms settles with 150 / 150
  test('(+) F9: wireFit listens for the window\'s focus and blur; both call planner.focusChanged(false) (a blur is sent 150 ms on, a focus 150 ms on)', async () => {
    const r = rig();
    r.page.focus = true;
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    assert.equal(typeof r.log.events.focus, 'function');
    assert.equal(typeof r.log.events.blur, 'function');
    r.page.focus = false;
    r.log.events.blur({ target: r.ctx.window });
    await r.clk.advance(149);
    assert.equal(r.log.calls.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(calls(r).slice(1), [PUT(100, 30, false, false)]);
    r.page.focus = true;
    r.log.events.focus({ target: r.ctx.window });
    await r.clk.advance(149);
    assert.equal(r.log.calls.length, 2);
    await r.clk.advance(1);
    assert.deepEqual(calls(r).slice(2), [PUT(100, 30, false, true)]);
    const src = fnOf('function wireFit()');
    assert.match(src, /addEventListener\('focus', \(e\) => \{[^}]*focusChanged\(false\)/);
    assert.match(src, /addEventListener\('blur', \(e\) => \{[^}]*focusChanged\(false\)/);
  });

  test('(−) F9: a focus or blur event whose target is not the window (an element\'s event seen from inside) does nothing; neither does an event with no target', async () => {
    const r = rig();
    r.page.focus = true;
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.page.focus = false;
    for (const ev of [{ target: {} }, { target: r.chip }, { target: null }, {}, undefined]) {
      r.log.events.blur(ev);
      r.log.events.focus(ev);
    }
    await r.clk.advance(1000 - 1); // the poll is the only way left to notice, and it is a second away
    assert.equal(r.log.calls.length, 1, 'no settle was started by a foreign event');
  });

  test('(−) F9: a window focus or blur before the planner has started (no capture yet) sends nothing', async () => {
    const r = rig();
    r.page.focus = true;
    r.wireFit();
    r.log.events.blur({ target: r.ctx.window });
    r.log.events.focus({ target: r.ctx.window });
    await r.clk.advance(60000);
    assert.deepEqual(calls(r), []);
  });

  // F10 (requirement change, not a weakened test): the poll finds the change at 1 s and the blur settle is 150 ms now, so the PUT follows at 1.15 s (F9: 1.2 s)
  test('(+) F9: the poll catches a change no event reported: hasFocus() flips, the PUT follows within about 1.15 s', async () => {
    const r = rig();
    r.page.focus = true;
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.page.focus = false;
    await r.clk.advance(1149);
    assert.equal(r.log.calls.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(calls(r).slice(1), [PUT(100, 30, false, false)]);
  });

  test('(+) F9: after pagehide the focus events and the poll send nothing (the planner is closed, no timer is left)', async () => {
    const r = rig();
    r.page.focus = true;
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.log.events.pagehide();
    r.page.focus = false;
    r.log.events.blur({ target: r.ctx.window });
    await r.clk.advance(60000);
    assert.deepEqual(calls(r), [PUT(100, 30, true, true), DELETE]);
    assert.equal(r.clk.pending, 0);
  });

  test('(+) F9: a persisted pageshow reads the focus fresh: the new lease opens with the focus of that moment', async () => {
    const r = rig();
    r.page.focus = true;
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    r.log.events.pagehide();
    r.page.focus = false;
    r.log.events.pageshow({ persisted: true });
    await r.clk.advance(0);
    assert.deepEqual(calls(r).slice(2), [PUT(100, 30, true, false)]);
  });

  // -- renderFit(view, { quiet })
  test('(+) F9: renderFit(view, { quiet: true }) updates data-k, title, aria-label and the words, and does not announce; without quiet it announces as today', () => {
    const r = rig();
    const fitted = chipViewReal(answer('fitted').body);
    const term = chipViewReal(answer('terminal', null).body);
    r.renderFit(fitted);
    assert.deepEqual(norm(r.log.said), [fitted.say], 'without options: announced');
    r.renderFit(term, { quiet: true });
    assert.equal(r.chip.getAttribute('data-k'), 'terminal');
    assert.equal(r.chip.getAttribute('title'), term.title);
    assert.equal(r.chip.getAttribute('aria-label'), term.label);
    assert.equal(r.chip.kids[1].textContent, term.text);
    assert.equal(r.chip.kids[0].kids[0].getAttribute('href'), '#i-term');
    assert.equal(r.wrap.hidden, false);
    assert.deepEqual(norm(r.log.said), [fitted.say], 'quiet: nothing more was said');
    r.renderFit(fitted, { quiet: false });
    assert.deepEqual(norm(r.log.said), [fitted.say, fitted.say], 'quiet: false announces');
  });

  test('(−) F9: only the boolean true is quiet: a truthy lookalike, an empty options object and null still announce', () => {
    for (const opts of [{ quiet: 'true' }, { quiet: 1 }, { quiet: {} }, {}, null, undefined, { Quiet: true }]) {
      const r = rig();
      r.renderFit(chipViewReal(answer('fitted').body), opts);
      assert.equal(r.log.said.length, 1, JSON.stringify(opts));
    }
  });

  test('(+) F9: a quiet change redraws an open panel in place (the panel shows the new hint) and still says nothing', () => {
    const r = rig();
    r.wireFit();
    r.renderFit(chipViewReal(answer('fitted').body));
    r.chip.click();
    assert.equal(r.ctx.FIT.pop, true);
    r.log.said.length = 0;
    r.renderFit(chipViewReal({ fit: { state: 'terminal', reason: 'switching', panes: 1, userZoom: false } }), { quiet: true });
    assert.equal(r.popHint.textContent, 'nika sizes the tmux window to this panel again within a minute while this window keeps focus.');
    assert.equal(r.popWhy.textContent, chipViewReal({ fit: { state: 'terminal', reason: 'switching' } }).title);
    assert.deepEqual(norm(r.log.said), []);
  });

  test('(+) F9: end to end, a state change that follows a focus change is drawn but not announced; one that follows a resize is announced', async () => {
    const r = rig({ replies: [answer('fitted'), answer('terminal'), answer('fitted'), answer('zoomed', 'panel-smaller')] });
    r.page.focus = true;
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    assert.equal(r.log.said.length, 1, 'the first answer is announced');
    r.page.focus = false;
    r.log.events.blur({ target: r.ctx.window });
    await r.clk.advance(200);
    assert.equal(r.chip.getAttribute('data-k'), 'terminal', 'the chip follows');
    assert.equal(r.log.said.length, 1, 'the blur-driven change is not announced');
    r.page.focus = true;
    r.log.events.focus({ target: r.ctx.window });
    await r.clk.advance(400);
    assert.equal(r.chip.getAttribute('data-k'), 'fitted');
    assert.equal(r.log.said.length, 1, 'neither is the focus-driven one');
    r.term.clientWidth = 24 + 8 * 110 + 1;
    r.log.ro();
    await r.clk.advance(250);
    assert.equal(r.chip.getAttribute('data-k'), 'zoomed');
    assert.equal(r.log.said.length, 2, 'a change that follows a resize is announced as always');
    assert.match(r.log.said[1], /^Fit: zoomed, text scaled\. /);
  });

  // -- no new colour, icon or CSS rule
  test('(−) F9: no new token, colour, sprite symbol or CSS rule: the new chip keys are the earlier states, with their icons, and the five state rules are the only ones', () => {
    const css = strip(CSS);
    const rules = [...css.matchAll(/(?:^|[\s}])\.fit\[data-k="([a-z]+)"\]\s*\{/g)].map((m) => m[1]);
    assert.deepEqual(rules, ['fitted', 'zoomed', 'blocked', 'other', 'terminal'], 'the chip rules: five states, none added');
    for (const b of [{ state: 'fitted', reason: 'terminal' }, { state: 'terminal', reason: 'switching', panes: 1 }, { state: 'terminal', reason: null, panes: 3 }]) {
      const v = chipViewReal({ fit: b });
      assert.ok(rules.includes(v.state), `${v.key}: its state has a rule`);
      assert.match(HTML, new RegExp(`<symbol id="i-${v.icon}" viewBox="0 0 16 16">`), `${v.key}: its icon is in the sprite`);
    }
    assert.equal(chipViewReal({ fit: { state: 'fitted', reason: 'terminal' } }).icon, chipViewReal({ fit: { state: 'fitted', reason: null } }).icon);
    assert.equal(chipViewReal({ fit: { state: 'terminal', reason: 'switching' } }).icon, chipViewReal({ fit: { state: 'terminal', reason: null } }).icon);
    assert.deepEqual(findSinks(fnOf('function fitFocused()')), []);
    assert.deepEqual(findSinks(fnOf('function wireFit()')), []);
    assert.doesNotMatch(code(JS['fit-ui.js']), /\b(?:document|window|navigator|localStorage)\s*[.[]|\.style\b|innerHTML|getElementById|querySelector|addEventListener|\bsetTimeout\b|\bfetch\(/, 'fit-ui.js has no DOM and no timer or request of its own');
    assert.doesNotMatch(JS['fit-ui.js'], /[^\x00-\x7f]/, 'fit-ui.js stays ASCII');
  });

  test('(+) the visibilitychange PUT really goes out: beat() through the page\'s planner sends one request', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    await r.clk.advance(2000);
    r.ctx.FIT.planner.beat();
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(100, 30, false)]);
  });

  test('(+) pagehide sends one DELETE to the same route with keepalive: true and nothing else; a second pagehide sends none', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.log.events.pagehide();
    r.log.events.pagehide();
    assert.deepEqual(calls(r), [PUT(100, 30, true), DELETE]);
    assert.equal(Object.hasOwn(r.log.calls[1], 'json'), false, 'no body');
    await r.clk.advance(60000);
    assert.equal(r.log.calls.length, 2, 'no heartbeat after the page left');
  });

  // fix round 2, review minor 4
  test('(−) a webview without ResizeObserver: wireFit does not throw, watches nothing, and the fit still starts after the first capture', async () => {
    const r = rig({ observer: false });
    assert.equal(r.ctx.ResizeObserver, undefined);
    assert.doesNotThrow(() => r.wireFit());
    assert.equal(r.log.ro, null);
    assert.equal(r.log.observed, null);
    assert.deepEqual(norm(r.ctx.FIT.panel), { cols: 100, rows: 30 }, 'measured once at wire-up');
    assert.deepEqual(calls(r), []);
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
    await r.clk.advance(5000);
    assert.deepEqual(calls(r).slice(1), [PUT(100, 30, false)], 'the heartbeat runs without the observer too');
  });

  // fix round 2, review minor 5: through handleCapture itself, not setGone called by hand
  test('(+) a capture answered 404 goes through handleCapture to setGone and sends exactly one DELETE; a second 404 and the page leaving send none', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    r.handleCapture({ status: 404, body: { error: 'not-found' } });
    assert.equal(r.ctx.M.gone, true, 'it really was handleCapture that reached setGone');
    assert.deepEqual(norm(r.log.overlays), ['Pane %12 is gone'], 'setGone ran whole: the overlay is shown');
    assert.deepEqual(calls(r), [PUT(100, 30, true), DELETE]);
    r.handleCapture({ status: 404, body: null });
    r.log.events.pagehide();
    await r.clk.advance(60000);
    assert.deepEqual(calls(r), [PUT(100, 30, true), DELETE], 'exactly one DELETE, and no heartbeat after it');
    assert.equal(r.clk.pending, 0);
  });

  test('(−) a capture answered 304, 500 or lost (0) sends no DELETE and keeps the lease', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    r.handleCapture({ status: 304, body: null });
    r.handleCapture({ status: 500, body: { message: 'x' } });
    r.handleCapture({ status: 0, body: null });
    assert.equal(r.ctx.M.gone, false);
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
  });

  // -- fix round 1: back from the back/forward cache is a new page load
  test('(+) a persisted pageshow after pagehide restarts the fit as a new page load: one PUT with open: true, then open: false heartbeats', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    r.log.events.pagehide();
    assert.equal(typeof r.log.events.pageshow, 'function');
    r.log.events.pageshow({ persisted: true });
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(100, 30, true), DELETE, PUT(100, 30, true)]);
    await r.clk.advance(5000);
    assert.deepEqual(calls(r).slice(3), [PUT(100, 30, false)]);
    r.fitCaptured(); // the next capture finds it started
    assert.equal(r.log.calls.length, 4);
  });

  test('(+) the persisted pageshow measures the box again first: a panel resized while the page was frozen is the size asked for', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    r.log.events.pagehide();
    r.term.clientWidth = 24 + 8 * 90;
    r.log.events.pageshow({ persisted: true });
    await r.clk.advance(0);
    assert.deepEqual(calls(r).slice(2), [PUT(90, 30, true)]);
  });

  test('(−) a pageshow that is not persisted (every first load fires one) does nothing extra, whatever the event holds', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    for (const ev of [{ persisted: false }, {}, undefined, { persisted: 'true' }]) r.log.events.pageshow(ev);
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(100, 30, true)], 'no second open: true, no release');
    r.log.events.pagehide();
    r.log.events.pageshow({ persisted: false });
    await r.clk.advance(60000);
    assert.deepEqual(calls(r), [PUT(100, 30, true), DELETE], 'a non-persisted pageshow after pagehide starts nothing');
  });

  test('(−) a persisted pageshow while the lease is still on (no pagehide before it), for a pane that is gone, or before any capture, sends nothing', async () => {
    const live = rig();
    live.wireFit();
    live.ctx.M.cols = 120;
    live.ctx.M.rows = 39;
    live.fitCaptured();
    await live.clk.advance(0);
    live.log.events.pageshow({ persisted: true });
    await live.clk.advance(0);
    assert.deepEqual(calls(live), [PUT(100, 30, true)]);

    const gone = rig();
    gone.wireFit();
    gone.ctx.M.cols = 120;
    gone.ctx.M.rows = 39;
    gone.fitCaptured();
    await gone.clk.advance(0);
    gone.log.events.pagehide();
    gone.ctx.M.gone = true;
    gone.log.events.pageshow({ persisted: true });
    await gone.clk.advance(60000);
    assert.deepEqual(calls(gone), [PUT(100, 30, true), DELETE], 'the pane is gone: no lease to ask for');

    const early = rig();
    early.wireFit();
    early.log.events.pageshow({ persisted: true });
    await early.clk.advance(60000);
    assert.deepEqual(calls(early), [], 'no capture has answered yet: the first one starts the fit, as on a first load');
  });

  test('(−) after a 403 a persisted pageshow asks nothing', async () => {
    const r = rig({ replies: [{ status: 403, body: { error: 'forbidden' } }] });
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    r.log.events.pagehide();
    r.log.events.pageshow({ persisted: true });
    await r.clk.advance(60000);
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
  });

  test('(+) the pane is gone (capture 404): setGone stops the heartbeat and sends one DELETE; a pane that answers again starts a new lease', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.setGone();
    r.setGone();
    r.log.events.pagehide(); // the page leaving after that sends no second release
    assert.deepEqual(calls(r), [PUT(100, 30, true), DELETE]);
    await r.clk.advance(60000);
    assert.equal(r.log.calls.length, 2);
    r.fitCaptured(); // "Check again" found the pane: open: true was sent once in this page load, the new lease is asked for with false
    assert.deepEqual(calls(r).slice(2), [PUT(100, 30, false)]);
  });

  test('(−) a window with no pane id asks nothing: fitCall never reaches the route, and boot wires the fit only inside the pane branch', async () => {
    const r = rig({ pane: null });
    assert.deepEqual(norm(await r.fitCall('PUT', { json: { cols: 100, rows: 30, open: true } })), { status: 0, body: null });
    assert.deepEqual(norm(await r.fitCall('DELETE', { keepalive: true })), { status: 0, body: null });
    assert.equal(r.log.calls.length, 0);
    const boot = fnOf('function boot()');
    assert.equal((boot.match(/wireFit\(\)/g) ?? []).length, 1);
    const inPane = boot.slice(boot.indexOf('if (paneId) {'), boot.indexOf('} else {', boot.indexOf('if (paneId) {')));
    assert.match(inPane, /wireSwitcher\(\);\s*wireQuick\(\);\s*wireFit\(\);/);
    assert.doesNotMatch(boot.slice(boot.indexOf('} else {', boot.indexOf('if (paneId) {'))), /wireFit|FIT\./);
  });

  test('(−) 429 and 409 are not retried before the next heartbeat', async () => {
    for (const status of [429, 409]) {
      const r = rig({ replies: [{ status, body: { error: 'busy', message: 'busy' } }] });
      r.wireFit();
      r.fitCaptured();
      await r.clk.advance(0);
      r.term.clientWidth = 24 + 8 * 120;
      r.log.ro();
      await r.clk.advance(4000);
      assert.equal(r.log.calls.length, 1, `${status}: nothing before the beat`);
      await r.clk.advance(1000);
      assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(120, 30, true)], `${status}: the beat asks again, still open: true (nothing was opened)`);
    }
  });

  test('(−) 403 stops everything, as the mirror does: no heartbeat, no resize, no DELETE at pagehide', async () => {
    const r = rig({ replies: [{ status: 403, body: { error: 'forbidden' } }] });
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.term.clientWidth = 24 + 8 * 120;
    r.log.ro();
    r.ctx.FIT.planner.beat();
    await r.clk.advance(60000);
    r.log.events.pagehide();
    r.setGone();
    r.fitCaptured();
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
    assert.equal(r.clk.pending, 0);
  });

  test('(+) after blocked / user-change the next heartbeat still sends open: false (the server keeps it off; only a page load opens)', async () => {
    const r = rig({ replies: [answer('blocked', 'user-change'), answer('blocked', 'user-change')] });
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    await r.clk.advance(5000);
    await r.clk.advance(5000);
    assert.deepEqual(calls(r).map((c) => c.json.open), [true, false, false]);
  });

  // -- the text scale
  test('(+) the scale is set through setProperty only, once per change: 100 x 30 cells for a 120 x 39 pane is the tighter axis', () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitScale();
    r.fitScale();
    assert.deepEqual(norm(r.log.props), [['--fit-scale', String(Math.min(100 / 120, 30 / 39))]]);
    assert.deepEqual(Object.keys(r.term.style), ['setProperty'], 'no other style property was written');
    assert.equal(r.term.setAttribute, undefined);
    r.ctx.M.cols = 100;
    r.ctx.M.rows = 30;
    r.fitScale();
    assert.deepEqual(norm(r.log.props).at(-1), ['--fit-scale', '1'], 'the pane was fitted: back to exactly 1');
  });

  test('(−) the scale never goes above 1: a pane smaller than the panel leaves the text at its normal size (and sets nothing)', () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 80;
    r.ctx.M.rows = 24;
    r.fitScale();
    assert.deepEqual(norm(r.log.props), []);
    assert.equal(r.ctx.FIT.scale, 1);
  });

  test('(−) no capture yet, or no measure yet: the scale is left alone', () => {
    const r = rig();
    r.wireFit();
    r.fitScale();
    assert.deepEqual(norm(r.log.props), []);
    const r2 = rig();
    r2.ctx.M.cols = 120;
    r2.ctx.M.rows = 39;
    r2.fitScale();
    assert.deepEqual(norm(r2.log.props), []);
  });

  test('(+) a resize of the box changes the scale at once (no debounce), while the request waits its 250 ms', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 100;
    r.ctx.M.rows = 30;
    r.fitCaptured();
    await r.clk.advance(0);
    r.term.clientWidth = 24 + 8 * 50;
    r.log.ro();
    assert.deepEqual(norm(r.log.props), [['--fit-scale', String(50 / 100)]]);
    assert.equal(r.log.calls.length, 1);
  });

  // -- handleCapture
  const captureRig = ({ frozen = false, planner = {}, fitCaptured } = {}) => {
    const order = [];
    const term = {
      style: { setProperty: (k, v) => order.push(`scale ${v}`) }, scrollHeight: 9,
      get scrollTop() { return 0; }, set scrollTop(v) { order.push('scroll'); },
    };
    const ctx = {
      recovered() {}, noteScreen() {}, $: (id) => (id === 'term' ? term : { style: {} }), M: { frozen, scrollTop: 0, cols: 0, rows: 0 },
      setLive: (state, text) => order.push(`${state}: ${text}`), MID: ' - ', TIMES: 'x', ETAG: /^[0-9a-f]{1,64}$/,
      cleanDraft: cleanDraftReal, Q: { queued: false }, renderQuick() {}, DS: { capture() {} }, drawMirror: () => order.push('draw'), renderSuggestion() {},
      FIT: { planner: { start: () => order.push('start'), ...planner }, panel: { cols: 100, rows: 30 }, scale: 1 },
      scaleFor: scaleForReal, setGone() {}, serverMessage: () => '', setPaneState() {}, setInputEnabled() {}, showOverlay() {},
      hiddenRows: hiddenRowsReal, drawnScale: drawnScaleReal, // F11 (requirement change: the scale is worked out by drawnScale, which is scaleFor when no rows are hidden)
    };
    const src = `${fnOf('function handleCapture(r)')}\n${fnOf('function fitScale()')}\n${fnOf('function fitCaptured()')}; handleCapture`;
    if (fitCaptured) ctx.fitCaptured = fitCaptured;
    const run = vm.runInNewContext(fitCaptured ? fnOf('function handleCapture(r)') + '; handleCapture' : src, ctx);
    return { order, run, ctx };
  };
  const BODY = { cols: 120, rows: Array.from({ length: 39 }, (_, i) => [{ t: `row ${i}`, s: {} }]), cursor: { x: 0, y: 0, visible: true }, etag: 'ab12' };

  test('(+) a drawn capture starts the fit, applies the scale, and only then scrolls to the end; the header keeps the pane\'s real 120 x 39', () => {
    const c = captureRig();
    c.run({ status: 200, body: BODY });
    assert.deepEqual(c.order, ['draw', 'live: Live - 120 x 39', 'start', `scale ${Math.min(100 / 120, 30 / 39)}`, 'scroll']);
  });

  test('(+) a paused mirror gets the scale too (and keeps the reader\'s place)', () => {
    const c = captureRig({ frozen: true });
    c.run({ status: 200, body: BODY });
    assert.deepEqual(c.order, ['draw', 'paused: Paused - 120 x 39', 'start', `scale ${Math.min(100 / 120, 30 / 39)}`]);
  });

  test('(−) a fit that throws never takes the mirror down: the rows are drawn, the label is set, the scroll happens, nothing is thrown', () => {
    const c = captureRig({ fitCaptured: () => { throw new Error('boom'); } });
    assert.doesNotThrow(() => c.run({ status: 200, body: BODY }));
    assert.deepEqual(c.order, ['draw', 'live: Live - 120 x 39', 'scroll']);
  });

  test('(−) a 304 and a refused capture do not start the fit', () => {
    const c = captureRig();
    c.run({ status: 304, body: null });
    c.run({ status: 500, body: { message: 'x' } });
    assert.deepEqual(c.order.filter((x) => x === 'start'), []);
  });

  test('(+) setGone closes the planner and handleCapture is guarded: the hooks are in the source where the design puts them', () => {
    assert.match(fnOf('function setGone()'), /M\.gone = true;[\s\S]*FIT\.planner\?\.close\(\);/);
    assert.match(fnOf('function handleCapture(r)'), /try \{\s*fitCaptured\(\);\s*\} catch \{[^}]*\}\s*try \{\s*scrollCaptured\(r\.body\);\s*\} catch \{[^}]*\}\s*if \(!M\.frozen\) term\.scrollTop = term\.scrollHeight;/);
    assert.match(fnOf('function boot()'), /FIT\.planner\?\.beat\(\);/);
  });

  // -- the chip
  test('(+) the chip is hidden until the first answer, then shows one of four states with colour (data-k), icon, words and the reason as its title', async () => {
    const r = rig({ replies: [answer('fitted')] });
    r.wireFit();
    assert.equal(r.wrap.hidden, true);
    r.fitCaptured();
    await r.clk.advance(0);
    assert.equal(r.wrap.hidden, false, 'F1: the wrapper carries hidden, the button inside it does not');
    assert.equal(r.chip.hidden, false);
    assert.equal(r.chip.getAttribute('data-k'), 'fitted');
    assert.equal(r.chip.kids.length, 3, 'icon, words, chevron');
    assert.equal(r.chip.kids[0].kids[0].getAttribute('href'), '#i-fit');
    assert.equal(r.chip.kids[1].textContent, 'Fit · fills the panel');
    assert.equal(r.chip.kids[2].kids[0].getAttribute('href'), '#i-chev');
    assert.equal(r.chip.kids[2].getAttribute('aria-hidden'), 'true');
    assert.match(r.chip.kids[2].getAttribute('class'), /\bchev\b/);
    assert.equal(r.chip.getAttribute('title'), chipViewReal(FITTED.body).title);
    assert.equal(r.chip.getAttribute('aria-label'), 'Fit: fills the panel', 'F1: the button\'s name is the label, the words and the chevron are not read twice');
    assert.equal(r.chip.getAttribute('aria-expanded'), 'false');
  });

  test('(+) all four states draw their own data-k, icon href, text and title; the six reasons draw their sentences', () => {
    const r = rig();
    const seen = new Set();
    const cases = [['fitted', null, 'fit'], ['zoomed', 'panel-smaller', 'zoom'], ['blocked', 'user-zoom', 'off'], ['other', null, 'window']];
    for (const [state, reason, ico] of cases) {
      const v = chipViewReal(answer(state, reason).body);
      r.renderFit(v);
      assert.equal(r.chip.getAttribute('data-k'), state);
      assert.equal(r.chip.kids[0].kids[0].getAttribute('href'), `#i-${ico}`);
      assert.equal(r.chip.kids[1].textContent, v.text);
      assert.equal(r.chip.getAttribute('title'), v.title);
      seen.add(`${state}|${ico}|${v.text}`);
    }
    assert.equal(seen.size, 4);
    const SIX = {
      'user-zoom': 'You zoomed another pane in this window; nika leaves it',
      'size-option': 'This tmux window has a window-size setting nika does not change',
      'foreign-tag': 'Another program marks this tmux window',
      changed: 'The tmux window changed while nika was fitting it, so nika put it back',
      'user-change': 'You changed this tmux window, so nika put it back',
    };
    for (const [reason, title] of Object.entries(SIX)) {
      r.renderFit(chipViewReal(answer('blocked', reason).body));
      assert.equal(r.chip.getAttribute('title'), title, reason);
      assert.equal(r.chip.kids[1].textContent, 'Fit · off', reason);
    }
    r.renderFit(chipViewReal(answer('zoomed', 'panel-smaller').body));
    assert.equal(r.chip.getAttribute('title'), 'Other panes in this tmux window would be squeezed, so nika zoomed the pane and scaled the text');
  });

  test('(+) a state change is announced once through announce(); the same state again, and a 502, say nothing', async () => {
    const r = rig({ replies: [answer('fitted'), answer('fitted'), answer('blocked', 'user-zoom'), { status: 502, body: { error: 'tmux_failed', message: 'tmux said no' } }, answer('blocked', 'user-zoom')] });
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    assert.equal(r.log.said.length, 1);
    assert.match(r.log.said[0], /^Fit: fills the panel\. /);
    await r.clk.advance(5000);
    assert.equal(r.log.said.length, 1, 'fitted again');
    await r.clk.advance(5000);
    assert.equal(r.log.said.length, 2);
    assert.equal(r.log.said[1], 'Fit: off. You zoomed another pane in this window; nika leaves it');
    assert.equal(r.chip.getAttribute('data-k'), 'blocked');
    await r.clk.advance(5000); // the 502
    await r.clk.advance(5000); // blocked again
    assert.equal(r.log.said.length, 2);
    assert.equal(r.chip.getAttribute('data-k'), 'blocked', 'the 502 left the chip as it was');
  });

  test('(−) a 502 or an odd body as the first answer leaves the chip hidden and says nothing', async () => {
    for (const first of [{ status: 502, body: { error: 'tmux_failed', message: 'tmux said no' } }, { status: 200, body: { fit: { state: 'none' } } }, { status: 200, body: null }]) {
      const r = rig({ replies: [first] });
      r.wireFit();
      r.fitCaptured();
      await r.clk.advance(0);
      assert.equal(r.wrap.hidden, true);
      assert.deepEqual(r.log.said, []);
    }
  });

  test('(+) renderFit(null) hides and empties the chip; the pane going away hides it', async () => {
    const r = rig({ replies: [answer('other')] });
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    assert.equal(r.wrap.hidden, false);
    r.setGone();
    assert.equal(r.wrap.hidden, true);
    assert.equal(r.chip.getAttribute('data-k'), null);
    assert.equal(r.chip.getAttribute('title'), null);
    assert.equal(r.chip.getAttribute('aria-label'), null);
    assert.equal(r.chip.kids.length, 0);
  });

  test('(−) nothing the server says reaches the chip: a hostile reason or message is never in its text, title or attributes', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const r = rig({ replies: [{ status: 200, body: { fit: { state: 'blocked', reason: hostile, message: hostile, pane: { cols: hostile, rows: 1 } }, message: hostile } }] });
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    assert.equal(r.wrap.hidden, false);
    const all = JSON.stringify([r.chip.attrs, r.chip.textContent, r.log.said]);
    assert.doesNotMatch(all, /img|onerror/);
    assert.equal(r.chip.getAttribute('title'), 'nika is not fitting this tmux window');
  });

  test('(+) renderFit writes with h() text and the icon sprite only: no markup sink, and the title through setAttribute', () => {
    const src = fnOf('function renderFit(view, opts)');
    assert.match(src, /h\('span', \{ text: view\.text \}\)/);
    assert.match(src, /setAttribute\('title', view\.title\)/);
    assert.deepEqual(findSinks(src), []);
  });

  // ---- F1 (design F12 2): the chip is a button; its panel, its exits, and Fit again ----------------------------------------------------

  const NOTE = 'nika could not fit the window just now. It tries again within 5 seconds.';
  const BLOCKED = answer('blocked', 'user-change');
  const REFUSED = { status: 502, body: { error: 'tmux_failed', message: 'tmux said no' } };
  /** A page whose first answer has put a chip up: the first replies are the route's, in order. */
  const chipped = async (replies) => {
    const r = rig({ replies });
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    return r;
  };
  const opened = async (replies) => {
    const r = await chipped(replies);
    r.chip.click();
    return r;
  };
  const isClosed = (r) => r.pop.hidden === true && r.chip.getAttribute('aria-expanded') === 'false' && r.listeners('pointerdown') === 0;

  test('(+) F1: before the first click the panel is shut, nothing listens on the document, nothing was placed, and the window\'s resize is wired', async () => {
    const r = await chipped([BLOCKED]);
    assert.equal(isClosed(r), true);
    assert.deepEqual(r.log.placed, []);
    assert.equal(typeof r.log.events.resize, 'function');
    assert.equal(r.wrap.hidden, false);
  });

  test('(+) F1: a click opens the panel: heading, reason and hint from the table, the action shown, focus on Fit again (blocked, user-change)', async () => {
    const r = await opened([BLOCKED]);
    assert.equal(r.pop.hidden, false);
    assert.equal(r.chip.getAttribute('aria-expanded'), 'true');
    assert.equal(focusState.el, r.again);
    assert.equal(r.popH.textContent, 'Fit: off');
    assert.equal(r.popWhy.textContent, 'You changed this tmux window, so nika put it back');
    assert.equal(r.popHint.hidden, false);
    // F4 (design F4 3.6, a requirement change, not a weakened test): over a window a terminal shows Fit again lands in `terminal`, so the old sentence would be false
    assert.equal(r.popHint.textContent, 'Fit again turns the fit on once more. After a change of your own nika stays off until you ask.');
    assert.equal(r.popNote.hidden, true);
    assert.equal(r.again.hidden, false);
    assert.equal(r.again.textContent, 'Fit again');
    assert.equal(r.again.getAttribute('aria-disabled'), null);
    assert.equal(r.listeners('pointerdown'), 1);
  });

  test('(+) F1: fitted opens an info-only panel: heading and reason, no hint, no action, focus on Close; zoomed adds its hint', async () => {
    const f = await opened([answer('fitted')]);
    assert.deepEqual([f.popH.textContent, f.popHint.hidden, f.again.hidden, focusState.el === f.close], ['Fit: fills the panel', true, true, true]);
    assert.equal(f.popWhy.textContent, chipViewReal(FITTED.body).title);
    const z = await opened([answer('zoomed', 'panel-smaller')]);
    assert.deepEqual([z.popH.textContent, z.popHint.hidden, z.again.hidden, focusState.el === z.close], ['Fit: zoomed, text scaled', false, true, true]);
    assert.match(z.popHint.textContent, /^To fill the panel without scaled text, make this window larger or hide the transcript \(Ctrl\+Shift\+H\)\.$/);
  });

  test('(+) F1: the panel is placed by dom.js: clearMenuPlacement while it is hidden, then placeMenuX(panel, chip) once it is shown (it needs its width); again on every open', async () => {
    const r = await opened([BLOCKED]);
    assert.deepEqual(r.log.placed, [['clear', true, true], ['place', true, true, false]]);
    r.chip.click(); // closes
    r.chip.click(); // opens again
    assert.equal(r.log.placed.length, 4);
    assert.deepEqual(r.log.placed.slice(2), r.log.placed.slice(0, 2));
  });

  test('(+) F1: session.js imports placeMenuX and clearMenuPlacement from dom.js and keeps no placement logic of its own', () => {
    const dom = /import \{([^}]*)\} from '\.\/dom\.js';/.exec(JS['session.js'])?.[1] ?? '';
    for (const n of ['placeMenuX', 'clearMenuPlacement']) assert.match(dom, new RegExp(`\\b${n}\\b`), n);
    for (const head of ['function openFitPop()', 'function closeFitPop(refocus)', 'function drawFitPop()', 'function fitAway(e)', 'function fitAgainEvent(e)', 'function wireFitPop()']) {
      assert.doesNotMatch(fnOf(head), /getBoundingClientRect|innerWidth|offsetWidth|menuSpan|data-x|\.style\b/, head);
    }
    assert.match(fnOf('function openFitPop()'), /clearMenuPlacement\(pop\);[\s\S]*pop\.hidden = false;[\s\S]*placeMenuX\(pop, chip\);/);
  });

  test('(+) F1: Esc in the panel closes it, puts focus on the chip, and stops the key: the page\'s own Esc handlers never see it', async () => {
    const r = await opened([BLOCKED]);
    const e = r.pop.fire('keydown', { key: 'Escape' });
    assert.deepEqual([e.defaultPrevented, e.stopped], [true, true]);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
  });

  test('(−) F1: other keys in the panel do nothing; Esc on the chip while the panel is shut is left to the page (not prevented, not stopped)', async () => {
    const r = await opened([BLOCKED]);
    const k = r.pop.fire('keydown', { key: 'Enter' });
    assert.deepEqual([k.defaultPrevented, k.stopped], [false, undefined]);
    assert.equal(r.pop.hidden, false);
    r.chip.fire('keydown', { key: 'Escape' }); // focus came back to the chip with the panel open: Esc still closes it
    assert.equal(isClosed(r), true);
    const e = r.chip.fire('keydown', { key: 'Escape' });
    assert.deepEqual([e.defaultPrevented, e.stopped], [false, undefined]);
  });

  test('(+) F1: Close closes it with focus on the chip; a second click on the chip closes it too', async () => {
    const r = await opened([BLOCKED]);
    r.close.click();
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
    r.chip.click();
    focusState.el = r.again;
    r.chip.click();
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
  });

  test('(+) F1: a pointerdown outside the panel and the chip closes it and does not take focus; inside it, on the chip or on its icon it does not', async () => {
    const r = await opened([BLOCKED]);
    for (const inside of [r.popWhy, r.pop, r.chip, r.chip.kids[0], r.again]) {
      r.pointerdown(inside);
      assert.equal(r.pop.hidden, false);
    }
    focusState.el = r.outside;
    r.pointerdown(r.outside);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.outside, 'it stays where the user went');
    assert.equal(r.listeners('pointerdown'), 0, 'the document listener is gone with the panel');
  });

  test('(−) F1: a shut panel listens to nothing: opening and closing again and again leaves no document listener behind, and a pointerdown then does nothing', async () => {
    const r = await chipped([BLOCKED]);
    for (let i = 0; i < 4; i += 1) {
      r.chip.click();
      assert.equal(r.listeners('pointerdown'), 1);
      r.close.click();
      assert.equal(r.listeners('pointerdown'), 0);
    }
    focusState.el = r.outside;
    r.pointerdown(r.outside);
    assert.equal(focusState.el, r.outside);
  });

  test('(+) F1: Tab out of the panel (focus goes to something outside it and not the chip) closes it without taking focus; to the chip, or into the panel, or nowhere, it stays', async () => {
    const r = await opened([BLOCKED]);
    r.pop.fire('focusout', { relatedTarget: r.chip });
    r.chip.fire('focusout', { relatedTarget: r.close });
    r.pop.fire('focusout', { relatedTarget: r.again });
    r.pop.fire('focusout', { relatedTarget: null });
    assert.equal(r.pop.hidden, false);
    focusState.el = r.outside;
    r.pop.fire('focusout', { relatedTarget: r.outside });
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.outside);
    r.chip.click();
    r.chip.fire('focusout', { relatedTarget: r.outside }); // shift+Tab off the chip while the panel is open
    assert.equal(isClosed(r), true);
  });

  test('(+) F1: the window\'s resize closes the panel; focus goes to the chip only when it was inside the panel', async () => {
    const r = await opened([BLOCKED]);
    assert.equal(focusState.el, r.again);
    r.log.events.resize();
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
    r.chip.click();
    focusState.el = r.outside;
    r.log.events.resize();
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.outside);
    r.log.events.resize(); // shut already: nothing happens
    assert.equal(focusState.el, r.outside);
  });

  test('(+) F1: Fit again reads "Fitting...", is aria-disabled (not disabled: focus stays), sends one PUT with open: true; the answer fitted closes the panel, focuses the chip and shows fitted', async () => {
    const r = await opened([BLOCKED, answer('fitted')]);
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
    r.again.click();
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(100, 30, true)]);
    assert.equal(r.again.textContent, 'Fitting…');
    assert.equal(r.again.getAttribute('aria-disabled'), 'true');
    assert.equal(r.again.disabled, false);
    assert.equal(focusState.el, r.again);
    assert.equal(r.pop.hidden, false);
    await r.clk.advance(0);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
    assert.equal(r.chip.getAttribute('data-k'), 'fitted');
    assert.equal(r.log.said.length, 2);
    assert.equal(r.log.said[1], chipViewReal(FITTED.body).say);
    assert.equal(r.again.textContent, 'Fitting…', 'the next draw resets it; a shut panel is not drawn');
  });

  test('(+) F1: an answer zoomed closes the panel like fitted', async () => {
    const r = await opened([BLOCKED, answer('zoomed', 'panel-smaller')]);
    r.again.click();
    await r.clk.advance(0);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
    assert.equal(r.chip.getAttribute('data-k'), 'zoomed');
  });

  test('(+) F1: the same state again keeps the panel open, enables the button, keeps focus there and announces "Fit is still off. " + the reason', async () => {
    const r = await opened([answer('blocked', 'changed'), answer('blocked', 'changed')]);
    r.again.click();
    assert.equal(r.again.getAttribute('aria-disabled'), 'true');
    await r.clk.advance(0);
    assert.equal(r.pop.hidden, false);
    assert.equal(r.again.textContent, 'Fit again');
    assert.equal(r.again.getAttribute('aria-disabled'), null);
    assert.equal(focusState.el, r.again);
    assert.equal(r.log.said.length, 2);
    assert.equal(r.log.said[1], 'Fit is still off. The tmux window changed while nika was fitting it, so nika put it back');
  });

  test('(+) F1: another blocked reason with no action keeps the panel open, redraws it, announces the new state once, and moves focus to Close (the button it was on is gone)', async () => {
    const r = await opened([answer('blocked', 'changed'), answer('blocked', 'user-zoom')]);
    r.again.click();
    await r.clk.advance(0);
    assert.equal(r.pop.hidden, false);
    assert.equal(r.again.hidden, true);
    assert.equal(focusState.el, r.close);
    assert.equal(r.popWhy.textContent, 'You zoomed another pane in this window; nika leaves it');
    assert.equal(r.log.said.length, 2);
    assert.equal(r.log.said[1], 'Fit: off. You zoomed another pane in this window; nika leaves it');
  });

  test('(+) F1: another blocked reason that has an action keeps focus on the button', async () => {
    const r = await opened([answer('blocked', 'user-change'), answer('blocked', 'changed')]);
    r.again.click();
    await r.clk.advance(0);
    assert.deepEqual([r.pop.hidden, r.again.hidden, focusState.el === r.again, r.again.getAttribute('aria-disabled')], [false, false, true, null]);
    assert.equal(r.popHint.textContent, 'Fit again tries once more.');
  });

  test('(−) F1: a refused ask shows the note (with the warning icon), enables the button again, keeps focus, and announces the note', async () => {
    const r = await opened([BLOCKED, REFUSED]);
    r.again.click();
    await r.clk.advance(0);
    assert.equal(r.pop.hidden, false);
    assert.equal(r.popNote.hidden, false);
    assert.equal(r.popNote.textContent, NOTE);
    assert.equal(r.popNote.kids[0].kids[0].getAttribute('href'), '#i-warn');
    assert.equal(r.again.textContent, 'Fit again');
    assert.equal(r.again.getAttribute('aria-disabled'), null);
    assert.equal(focusState.el, r.again);
    assert.equal(r.log.said.at(-1), NOTE);
    assert.equal(r.chip.getAttribute('data-k'), 'blocked', 'the chip is as it was');
    assert.doesNotMatch(JSON.stringify(r.log.said), /tmux said no/, 'the server\'s message is never shown');
  });

  test('(−) F1: the note goes away when the panel is closed and opened again, and when the next ask starts', async () => {
    const r = await opened([BLOCKED, REFUSED, REFUSED]);
    r.again.click();
    await r.clk.advance(0);
    assert.equal(r.popNote.hidden, false);
    r.again.click();
    assert.equal(r.popNote.hidden, true, 'a new ask starts clean');
    await r.clk.advance(0);
    assert.equal(r.popNote.hidden, false);
    r.close.click();
    r.chip.click();
    assert.equal(r.popNote.hidden, true, 'closing forgets it');
  });

  test('(−) F1: a second click while the ask is pending sends nothing and does not reach the planner (the page ignores aria-disabled itself)', async () => {
    const r = await opened([BLOCKED, answer('fitted')]);
    let asks = 0;
    const real = r.ctx.FIT.planner.reopen;
    r.ctx.FIT.planner.reopen = () => { asks += 1; return real(); };
    r.again.click();
    r.again.click();
    r.again.click();
    assert.equal(asks, 1);
    assert.equal(r.log.calls.length, 2);
  });

  test('(−) F1: no Fit again for user-zoom, size-option, foreign-tag, fitted and zoomed; focus goes to Close', async () => {
    for (const [state, reason] of [['blocked', 'user-zoom'], ['blocked', 'size-option'], ['blocked', 'foreign-tag'], ['fitted', null], ['zoomed', 'panel-smaller']]) {
      const r = await opened([answer(state, reason)]);
      assert.equal(r.again.hidden, true, `${state} ${reason}`);
      assert.equal(focusState.el, r.close, `${state} ${reason}`);
    }
  });

  test('(+) F1: foreign-tag shows the command as text in a code element under its hint', async () => {
    const r = await opened([answer('blocked', 'foreign-tag')]);
    assert.equal(r.popHint.hidden, false);
    const code = r.popHint.all((n) => n.tag === 'code');
    assert.equal(code.length, 1);
    assert.equal(code[0].textContent, 'tmux set-option -wu @nika-fit');
    assert.match(r.popHint.textContent, /^If no other nika runs, clear the mark in that tmux window, then nika fits it by itself:tmux set-option -wu @nika-fit$/);
  });

  // ---- F4 (design F4 3.5 to 3.7): the state `terminal` in the page ----
  const termAnswer = (panes = 1, userZoom = false) => ({ status: 200, body: { fit: { state: 'terminal', reason: null, pane: { cols: 200, rows: 50 }, panes, userZoom } } });
  const TERM_ONE = chipViewReal(termAnswer(1).body);
  const TERM_ZOOM = chipViewReal(termAnswer(3).body);

  test('(+) F4: a 200 `terminal` answer draws the chip: data-k terminal, the terminal icon, the words, the label as the button name, the title, and announces it once', async () => {
    const r = await chipped([termAnswer(1), termAnswer(1)]); // the second reply is the heartbeat's (the rig's default after the replies is fitted)
    assert.equal(r.wrap.hidden, false);
    assert.equal(r.chip.getAttribute('data-k'), 'terminal');
    assert.equal(r.chip.kids[0].kids[0].getAttribute('href'), '#i-term');
    assert.equal(r.chip.kids[1].textContent, "Fit \u00b7 your terminal's size");
    assert.equal(r.chip.getAttribute('aria-label'), "Fit: your terminal's size");
    assert.equal(r.chip.getAttribute('title'), TERM_ONE.title);
    assert.deepEqual(r.log.said, [TERM_ONE.say]);
    await r.clk.advance(5000); // the heartbeat's answer is the same state: nothing more is said
    assert.equal(r.log.said.length, 1);
  });

  test('(+) F4: a click on a `terminal` chip opens an info-only panel: heading, reason, the 30-second hint, no action, no note, focus on Close', async () => {
    const r = await opened([termAnswer(1)]);
    assert.equal(r.pop.hidden, false);
    assert.equal(r.popH.textContent, "Fit: your terminal's size");
    assert.equal(r.popWhy.textContent, TERM_ONE.title);
    assert.equal(r.popHint.hidden, false);
    // F9 (design F9 5.2, requirement change, not a weakened test): the hint now starts with what a click into this window does; the 30 seconds stay in it
    assert.equal(r.popHint.textContent, 'Click into this window and nika sizes the tmux window to this panel; your terminal gets its size back when you click into it again. With no terminal on the window for 30 seconds, nika also sizes it to this panel by itself.');
    assert.equal(r.popHint.all((n) => n.tag === 'code').length, 0, 'no command');
    assert.equal(r.again.hidden, true);
    assert.equal(r.popNote.hidden, true);
    assert.equal(focusState.el, r.close);
  });

  test('(+) F4: several panes that nika zoomed give the zoom title and hint; going from one form to the other is a new key, so the chip is drawn and announced again, and an open panel is redrawn', async () => {
    const r = await opened([termAnswer(1), termAnswer(3)]);
    assert.equal(r.popWhy.textContent, TERM_ONE.title);
    await r.clk.advance(5000);
    assert.equal(r.chip.getAttribute('title'), TERM_ZOOM.title);
    assert.equal(r.popWhy.textContent, TERM_ZOOM.title, 'the open panel is drawn again in place');
    // F9 (design F9 5.2, requirement change): the zoom hint names the click, not the 30 seconds
    assert.match(r.popHint.textContent, /^Your terminal shows this pane zoomed too, until this session window closes\. Click into this window and nika sizes the tmux window to this panel\.$/);
    assert.deepEqual(r.log.said, [TERM_ONE.say, TERM_ZOOM.say]);
    assert.equal(r.chip.getAttribute('data-k'), 'terminal');
    assert.deepEqual([r.again.hidden, focusState.el === r.close], [true, true], 'no action in either form of the terminal panel');
  });

  test('(+) F4: Fit again answered `terminal` closes the panel like fitted and zoomed, focuses the chip, shows the terminal chip and announces it', async () => {
    const r = await opened([BLOCKED, termAnswer(1)]);
    r.again.click();
    assert.equal(r.again.getAttribute('aria-disabled'), 'true');
    await r.clk.advance(0);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
    assert.equal(r.chip.getAttribute('data-k'), 'terminal');
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(100, 30, true)]);
    assert.equal(r.log.said.length, 2);
    assert.equal(r.log.said[1], TERM_ONE.say);
  });

  test('(+) F4: Fit here (another nika window) answered `terminal` closes the panel too', async () => {
    const r = await opened([answer('other'), termAnswer(3)]);
    r.again.click();
    await r.clk.advance(0);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.chip);
    assert.equal(r.chip.getAttribute('data-k'), 'terminal');
  });

  test('(−) F4: the answers that do not close the panel still do not: blocked with the same or another reason keeps it open (only fitted, zoomed and terminal are a way back)', async () => {
    const r = await opened([answer('blocked', 'changed'), answer('blocked', 'changed')]);
    r.again.click();
    await r.clk.advance(0);
    assert.equal(r.pop.hidden, false);
    assert.equal(r.chip.getAttribute('data-k'), 'blocked');
  });

  test('(+) F1: another nika window offers "Fit here", which sends open: true like Fit again', async () => {
    const r = await opened([answer('other'), answer('fitted')]);
    assert.equal(r.again.textContent, 'Fit here');
    assert.equal(r.popHint.textContent, 'The other nika window stops fitting it.');
    assert.equal(focusState.el, r.again);
    r.again.click();
    assert.deepEqual(calls(r).at(-1), PUT(100, 30, true));
    await r.clk.advance(0);
    assert.equal(r.chip.getAttribute('data-k'), 'fitted');
    assert.equal(isClosed(r), true);
  });

  test('(+) F1: while the panel is open a new view redraws it in place: it stays open, focus stays on the button while the button stays, moves to Close when it goes, and each change is announced', () => {
    const r = rig();
    r.wireFit();
    const view = (state, reason) => chipViewReal(answer(state, reason).body);
    r.renderFit(view('blocked', 'user-change'));
    r.chip.click();
    r.renderFit(view('blocked', 'changed'));
    assert.deepEqual([r.pop.hidden, r.popWhy.textContent, focusState.el === r.again], [false, 'The tmux window changed while nika was fitting it, so nika put it back', true]);
    r.renderFit(view('blocked', 'user-zoom'));
    assert.deepEqual([r.pop.hidden, r.again.hidden, focusState.el === r.close], [false, true, true]);
    r.renderFit(view('other', null));
    assert.deepEqual([r.pop.hidden, r.again.hidden, r.again.textContent, r.popH.textContent], [false, false, 'Fit here', 'Fit: another window']);
    assert.equal(r.log.said.length, 4);
  });

  test('(+) F1: the chip hidden by a 403 while the panel is open closes the panel, hides the wrapper and puts focus on the transcript button', async () => {
    const r = await opened([BLOCKED, { status: 403, body: { error: 'forbidden' } }]);
    r.again.click();
    await r.clk.advance(0);
    assert.equal(r.wrap.hidden, true);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.histToggle);
    assert.equal(r.chip.kids.length, 0);
    assert.equal(r.popNote.hidden, true, 'a 403 is not a note: the chip is gone');
  });

  test('(+) F1: the pane going away while the panel is open does the same; focus elsewhere stays where it is', async () => {
    const r = await opened([BLOCKED]);
    r.setGone();
    assert.equal(r.wrap.hidden, true);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.histToggle);
    const q = await opened([BLOCKED]);
    focusState.el = q.outside;
    q.setGone();
    assert.equal(q.wrap.hidden, true);
    assert.equal(isClosed(q), true);
    assert.equal(focusState.el, q.outside);
  });

  test('(+) F1: a pending ask forgotten by the chip going away does not come back: the next panel reads "Fit again", not "Fitting..."', async () => {
    const r = await opened([BLOCKED, answer('fitted')]);
    r.again.click();
    assert.equal(r.again.textContent, 'Fitting…');
    r.setGone();
    await r.clk.advance(0);
    r.renderFit(chipViewReal(BLOCKED.body));
    r.chip.click();
    assert.equal(r.again.textContent, 'Fit again');
    assert.equal(r.again.getAttribute('aria-disabled'), null);
  });

  test('(+) F1: with the panel closed, an answer that arrives later changes no focus and opens nothing; the announcement still comes', async () => {
    const r = await opened([answer('blocked', 'changed'), answer('blocked', 'changed')]);
    r.again.click();
    r.close.click();
    focusState.el = r.outside;
    await r.clk.advance(0);
    assert.equal(isClosed(r), true);
    assert.equal(focusState.el, r.outside);
    assert.equal(r.log.said.at(-1), 'Fit is still off. The tmux window changed while nika was fitting it, so nika put it back');
    r.chip.click();
    assert.equal(r.again.textContent, 'Fit again', 'the ask is over: the next open is not pending');
  });

  test('(−) F1: a refusal that arrives after the panel was closed leaves no note behind for the next open, and still announces it', async () => {
    const r = await opened([BLOCKED, REFUSED]);
    r.again.click();
    r.close.click();
    await r.clk.advance(0);
    assert.equal(r.log.said.at(-1), NOTE);
    assert.equal(r.popNote.hidden, true);
    r.chip.click();
    assert.equal(r.popNote.hidden, true);
    assert.equal(r.again.textContent, 'Fit again');
  });

  test('(−) F1: nothing the server says reaches the panel: a hostile reason, message or pane is never in its text or attributes', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const r = await opened([{ status: 200, body: { fit: { state: 'blocked', reason: hostile, message: hostile, pane: { cols: hostile, rows: 1 } }, message: hostile } }]);
    const all = JSON.stringify([r.popH, r.popWhy, r.popHint, r.popNote, r.again, r.chip].map((e) => [e.attrs, e.textContent]));
    assert.doesNotMatch(all, /img|onerror/);
    assert.equal(r.popWhy.textContent, 'nika is not fitting this tmux window');
    assert.equal(r.again.textContent, 'Fit again');
  });

  test('(+) F1: the panel is written with h() text, textContent and the icon sprite only: no markup sink anywhere in the new functions', () => {
    for (const head of ['function drawFitPop()', 'function openFitPop()', 'function closeFitPop(refocus)', 'function fitAway(e)', 'function fitAgainEvent(e)', 'function wireFitPop()', 'function renderFit(view, opts)']) {
      assert.deepEqual(findSinks(fnOf(head)), [], head);
    }
    assert.match(fnOf('function drawFitPop()'), /\.textContent = /);
    assert.match(fnOf('function renderFit(view, opts)'), /setAttribute\('aria-label', view\.label\)/);
    assert.match(fnOf('function renderFit(view, opts)'), /icon\('chev', 'ic chev'\)/);
  });

  test('(+) F1: wireFit hands the planner fitAgain and wires the panel; the pagehide, pageshow and resize handlers stay separate', async () => {
    const wire = fnOf('function wireFit()');
    assert.match(wire, /fitAgain:\s*fitAgainEvent/);
    assert.match(wire, /wireFitPop\(\);/);
    const r = rig();
    r.wireFit();
    // F9 (requirement change): the window's focus and blur are wired here too (the visibilitychange of the document is boot's)
    assert.deepEqual(Object.keys(r.log.events).sort(), ['blur', 'focus', 'pagehide', 'pageshow', 'resize']);
  });

  // ---- F10 (design F10 2 to 6, 8.3): one steady resize per focus, room for Claude's footer, the redraw hold, the transition -----------------------------
  const HOLD_MS = HOLD_MS_REAL;
  const flushAll = () => new Promise((resolve) => { setImmediate(resolve); });
  const answerAt = (state, pane, reason = null) => ({ status: 200, body: { fit: { state, reason, pane, panes: 1, userZoom: false } } });
  /** A capture of cols x rows; `over` is merged into the body (the draft is the raw one the server sends). */
  const shot = (cols, rows, over = {}) => ({ status: 200, body: { cols, rows: Array.from({ length: rows }, () => []), alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: true, scrolled: false, etag: 'ab', cursor: null, draft: null, ...over } });
  const BOXED = { state: 'empty', mode: 'prompt', text: '', sig: '0000000000000001', box: { top: 18, bottom: 20 }, cursorAtEnd: true, suggestion: null, queued: false };
  const PANEL_145X22 = { w: 24 + 8 * 145, h: 20 + 18 * 22 }; // a 145 x 22 cell panel at the 8 x 18 cell
  const PANEL_145X40 = { w: 24 + 8 * 145, h: 20 + 18 * 40 }; // 40 rows: never needs the room step

  /**
   * The page with a mirror drawn at 171 x 45 (the terminal's size), the fit started and its first answer given: `pane` is the pane size nika's
   * resize made, so a redraw hold runs (`plain`: the drawn frame showed a readable input box). The replies after it are `more`.
   */
  const heldRig = async ({ box = PANEL_145X22, pane = { cols: 145, rows: 21 }, plain = true, state = 'fitted', more = [], focus = false } = {}) => {
    const r = rig({ box, replies: [answerAt(state, pane), ...more] });
    r.page.focus = focus;
    r.wireFit();
    r.ctx.M.cols = 171;
    r.ctx.M.rows = 45;
    r.ctx.M.body = shot(171, 45, { draft: plain ? BOXED : null }).body;
    r.ctx.M.draft = plain ? cleanDraftReal(BOXED) : null;
    r.fitCaptured();
    await r.clk.advance(0);
    return r;
  };

  // -- steady size: the panel is measured only at fixed moments
  test('(+) F10: the border box is what is measured (getBoundingClientRect), with the window\'s inner size; the held frame carries both', () => {
    const r = rig({ box: PANEL_145X22 });
    r.ctx.window.innerWidth = 1300;
    r.ctx.window.innerHeight = 700;
    assert.deepEqual(norm(r.fitMeasure()), { cols: 145, rows: 22 });
    assert.deepEqual(norm(r.ctx.FIT.frame), { cols: 145, rows: 22, width: PANEL_145X22.w, height: PANEL_145X22.h, cellW: 8, cellH: 18, iw: 1300, ih: 700 });
  });

  test('(+) F10: a width change of the box (the transcript toggle) sends one PUT after the debounce', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.term.clientWidth = 24 + 8 * 70;
    r.log.ro();
    await r.clk.advance(249);
    assert.equal(r.log.calls.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(70, 30, false)]);
  });

  test('(+) F10: a change of the window\'s inner size is a commit even with the box\'s height moving too: one PUT with the new rows', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.ctx.window.innerHeight = 900;
    r.term.clientHeight = 562 + 90;
    r.log.ro();
    await r.clk.advance(250);
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(100, 35, false)]);
    assert.equal(r.ctx.FIT.frame.ih, 900);
  });

  test('(−) F10: a change of the box\'s height alone (a composer line, the problem line, a prompt panel) sends no PUT, changes no text scale and re-pins the bottom', async () => {
    const r = rig();
    r.wireFit();
    r.ctx.M.cols = 120;
    r.ctx.M.rows = 39;
    r.fitCaptured();
    await r.clk.advance(0);
    const props = r.log.props.length;
    for (const h of [562 - 54, 562 - 300, 562 + 120]) {
      r.term.clientHeight = h;
      r.term.scrollHeight = 900;
      r.term.scrollTop = 0;
      r.log.ro();
      await r.clk.advance(1000);
      assert.equal(r.term.scrollTop, 900, `pinned to the bottom at ${h}`);
    }
    assert.deepEqual(calls(r), [PUT(100, 30, true)]);
    assert.equal(r.log.props.length, props, 'the text scale was not touched');
    assert.deepEqual(norm(r.ctx.FIT.panel), { cols: 100, rows: 30 });
  });

  test('(−) F10: the same height-only change does not re-pin a paused (frozen) mirror', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.ctx.M.frozen = true;
    r.term.clientHeight = 562 - 54;
    r.term.scrollHeight = 900;
    r.term.scrollTop = 123;
    r.log.ro();
    assert.equal(r.term.scrollTop, 123, 'the reader keeps the place');
  });

  test('(−) F10: a width change of less than one cell and the font arriving with the same cell are no commits', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.term.clientWidth += 7;
    r.log.ro();
    await r.clk.advance(1000);
    assert.equal(r.log.calls.length, 1);
    assert.equal(r.ctx.FIT.frame.width, 827, 'the frame is still the one held');
  });

  test('(+) F10: the border box decides, not the client box: a scrollbar or border the client box leaves out counts', () => {
    const r = rig({ box: PANEL_145X22 });
    r.term.rectExtra = { w: 16, h: 0 }; // 2 columns of 8 px more in the border box
    assert.deepEqual(norm(r.fitMeasure()), { cols: 147, rows: 22 });
  });

  // -- one resize per focus
  test('(+) F10: a focus event measures the box of that moment; the settle\'s PUT carries that size with focus: true, and the debounce sends nothing more', async () => {
    const r = rig();
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.term.clientHeight = 562 - 90; // the resting layout moved the box's height with no commit (height alone)
    r.log.ro();
    assert.equal(r.ctx.FIT.panel.rows, 30);
    r.page.focus = true;
    r.log.events.focus({ target: r.ctx.window });
    assert.equal(r.ctx.FIT.panel.rows, 25, 'measured at the focus event');
    await r.clk.advance(FOCUS_SETTLE_REAL);
    assert.deepEqual(calls(r), [PUT(100, 30, true), PUT(100, 25, false, true)]);
    await r.clk.advance(1000);
    assert.equal(r.log.calls.length, 2, 'one resize for this focus');
  });

  test('(−) F10: blur is no commit point: it measures nothing and the give-back keeps the size it had', async () => {
    const r = rig();
    r.page.focus = true;
    r.wireFit();
    r.fitCaptured();
    await r.clk.advance(0);
    r.term.clientHeight = 562 - 90;
    r.log.ro();
    r.page.focus = false;
    r.log.events.blur({ target: r.ctx.window });
    await r.clk.advance(BLUR_SETTLE_REAL);
    assert.deepEqual(calls(r), [PUT(100, 30, true, true), PUT(100, 30, false, false)]);
  });

  test('(−) F10: chrome changes during the hold that follows a take send no PUT and keep the frame', async () => {
    const r = await heldRig();
    assert.equal(r.ctx.HOLD.active, true);
    for (const h of [416 - 36, 416 + 54, 416 - 72]) {
      r.term.clientHeight = h;
      r.log.ro();
    }
    await r.clk.advance(HOLD_MS - 1);
    assert.deepEqual(calls(r), [PUT(145, 22, true)]);
    assert.equal(r.ctx.FIT.frame.rows, 22);
  });

  // -- the redraw hold
  test('(+) F10: after a fit answer with a new pane size a hold runs and the mirror is polled at once; captures at the new size without a box are not drawn and the mode chip keeps its state', async () => {
    const r = await heldRig();
    assert.equal(r.ctx.HOLD.active, true);
    assert.ok(r.log.kicks.includes(0), 'the first capture after the answer is asked for at once');
    r.handleHeld(shot(145, 21, { mode: 'unknown', modeConfirmed: false })); // Claude has not repainted: no footer
    r.handleHeld(shot(145, 21, { mode: 'unknown', modeConfirmed: false }));
    assert.deepEqual([r.log.noted.length, r.log.drawn.length, r.log.lives.length, r.log.scrolled.length], [0, 0, 0, 0], 'not drawn, not judged, not counted');
    assert.deepEqual([r.ctx.M.cols, r.ctx.M.rows], [171, 45], 'the last good frame stays');
    r.handleHeld(shot(171, 45, { draft: BOXED })); // an old-size frame, even with a box, is not the answer either
    assert.deepEqual([r.log.noted.length, r.log.drawn.length], [0, 0]);
    r.handleHeld(shot(145, 21, { draft: BOXED })); // the box is back
    assert.deepEqual([r.log.noted.length, r.log.drawn.length, r.ctx.M.cols, r.ctx.M.rows], [1, 1, 145, 21]);
    assert.equal(r.ctx.HOLD.active, false);
    assert.equal(r.rows.classes.has('refit'), true, 'the new frame fades in');
    assert.deepEqual(r.log.lives.at(-1), ['live', 'Live - 145 x 21']);
  });

  test('(+) F10: the fit chip of the answer is held and drawn in the same step as the new frame', async () => {
    const r = await heldRig();
    assert.equal(r.wrap.hidden, true, 'not yet: the frame has not come');
    assert.equal(r.chip.getAttribute('data-k'), null);
    r.handleHeld(shot(145, 21));
    assert.equal(r.wrap.hidden, true);
    r.handleHeld(shot(145, 21, { draft: BOXED }));
    assert.equal(r.wrap.hidden, false);
    assert.equal(r.chip.getAttribute('data-k'), 'fitted');
    assert.deepEqual(norm(r.log.said), ['Fit: fills the panel. nika sized the tmux window to this panel and puts it back when this window closes']);
  });

  test('(+) F10: the held chip is drawn when the hold times out too, and a chip view with no hold is drawn at once', async () => {
    const r = await heldRig({ box: PANEL_145X40, pane: { cols: 145, rows: 39 } });
    r.handleHeld(shot(145, 39)); // no box
    await r.clk.advance(HOLD_MS);
    assert.equal(r.chip.getAttribute('data-k'), 'fitted');
    const plain = rig({ replies: [answerAt('fitted', { cols: 100, rows: 30 })] });
    plain.wireFit();
    plain.fitCaptured();
    await plain.clk.advance(0);
    assert.equal(plain.chip.getAttribute('data-k'), 'fitted', 'no frame was drawn before: nothing to hold');
  });

  test('(−) F10: after HOLD_MS a capture without a box is drawn as it is, and the mode chip reads what it says (unconfirmed)', async () => {
    const r = await heldRig({ box: PANEL_145X40, pane: { cols: 145, rows: 39 } }); // 40 rows: no room step
    r.handleHeld(shot(145, 39, { mode: 'unknown', modeConfirmed: false }));
    await r.clk.advance(HOLD_MS - 1);
    assert.equal(r.log.noted.length, 0, 'one millisecond before');
    await r.clk.advance(1);
    assert.equal(r.log.noted.length, 1);
    assert.equal(r.log.noted[0].modeConfirmed, false);
    assert.equal(r.log.drawn.length, 1);
    assert.equal(r.ctx.HOLD.active, false);
    assert.equal(r.log.calls.length, 1, 'and no extra resize');
  });

  test('(−) F10: a 404 during the hold shows the gone overlay at once', async () => {
    const r = await heldRig();
    r.handleHeld(shot(145, 21));
    r.handleHeld({ status: 404, body: { error: 'not-found' } });
    assert.equal(r.ctx.M.gone, true);
    assert.deepEqual(r.log.overlays, ['Pane %12 is gone']);
    assert.equal(r.ctx.HOLD.active, false);
  });

  test('(−) F10: a 500 or a lost request during the hold ends it and is handled as always; a 304 changes nothing', async () => {
    const a = await heldRig();
    a.handleHeld({ status: 304, body: null });
    assert.equal(a.ctx.HOLD.active, true, '304 leaves the hold alone');
    a.handleHeld({ status: 500, body: { message: 'x' } });
    assert.equal(a.ctx.HOLD.active, false);
    assert.deepEqual(a.log.overlays, ['tmux did not answer']);
    const b = await heldRig();
    b.handleHeld({ status: 0, body: null });
    assert.equal(b.ctx.HOLD.active, false);
    assert.equal(b.ctx.M.errors, 1);
  });

  test('(−) F10: a capture with a prompt, a dialog, or no full-screen view at the new size ends the hold at once', async () => {
    for (const over of [{ prompt: { kind: 'tool', question: 'x', options: [] } }, { dialog: { state: 'unreadable' } }, { alt: false }]) {
      const r = await heldRig();
      r.handleHeld(shot(145, 21, over));
      assert.equal(r.ctx.HOLD.active, false, JSON.stringify(over));
      assert.equal(r.log.noted.length, 1);
    }
  });

  test('(−) F10: when nothing was readable before the resize there is nothing to wait for: the first capture at the new size is drawn', async () => {
    const r = await heldRig({ plain: false });
    r.handleHeld(shot(145, 21));
    assert.equal(r.log.noted.length, 1);
    await r.clk.advance(HOLD_MS * 2);
    assert.equal(r.log.calls.length, 1, 'and no room step');
  });

  test('(−) F10: an answer with the pane size already drawn starts no hold; a drawn mirror is required to hold anything', async () => {
    const same = rig({ replies: [answerAt('fitted', { cols: 171, rows: 45 })] });
    same.wireFit();
    same.ctx.M.cols = 171;
    same.ctx.M.rows = 45;
    same.ctx.M.body = shot(171, 45).body;
    same.fitCaptured();
    await same.clk.advance(0);
    assert.equal(same.ctx.HOLD.active, false);
    const none = rig({ replies: [answerAt('fitted', { cols: 145, rows: 21 })] });
    none.wireFit();
    none.fitCaptured();
    await none.clk.advance(0);
    assert.equal(none.ctx.HOLD.active, false, 'no frame drawn yet');
    assert.deepEqual(none.log.kicks, []);
  });

  test('(+) F10: the border row d is the asked rows minus the answered pane rows, kept only when it is 0 or 1', async () => {
    const one = await heldRig({ pane: { cols: 145, rows: 21 } });
    assert.equal(one.ctx.FIT.d, 1);
    const zero = await heldRig({ pane: { cols: 145, rows: 22 } });
    assert.equal(zero.ctx.FIT.d, 0);
    const odd = await heldRig({ pane: { cols: 145, rows: 10 } });
    assert.equal(odd.ctx.FIT.d, 0, 'outside 0..1: 0');
  });

  // -- the room step
  test('(+) F10: hold timeout with every condition true -> exactly one PUT { cols: 210, rows: 33 } at once; the hold goes on; the chip panel then shows the room hint', async () => {
    const r = await heldRig({ more: [answerAt('fitted', { cols: 210, rows: 32 })] }); // frame 145 x 22, pane 145 x 21 (d 1)
    r.handleHeld(shot(145, 21)); // Claude's frame is cut: no input box
    await r.clk.advance(HOLD_MS - 1);
    assert.equal(r.log.calls.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(calls(r), [PUT(145, 22, true), PUT(210, 33, false)], 'at once, no 250 ms wait');
    assert.equal(r.ctx.FIT.room, true);
    assert.equal(r.log.noted.length, 0, 'the old frame stays drawn meanwhile');
    assert.equal(r.ctx.HOLD.active, true, 'the new hold starts at the answer');
    r.handleHeld(shot(210, 32, { draft: BOXED })); // the footer fits now
    assert.equal(r.log.noted.length, 1);
    assert.deepEqual([r.ctx.M.cols, r.ctx.M.rows], [210, 32]);
    r.openFitPop();
    // F11 (owner answer Q3; requirement change): the room is "more rows" now, and Fit again asks for full-size text
    assert.equal(r.popHint.textContent, "Claude's input box and footer did not fit this panel's rows, so nika gave the pane more rows and scaled the text. Fit again tries full-size text.");
    assert.equal(r.again.hidden, false);
    assert.equal(r.again.textContent, 'Fit again');
  });

  test('(−) F10: the room step is taken once: after the second hold the latest capture is applied whatever it shows', async () => {
    const r = await heldRig({ more: [answerAt('fitted', { cols: 210, rows: 32 })] });
    r.handleHeld(shot(145, 21));
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.calls.length, 2);
    r.handleHeld(shot(210, 32, { mode: 'unknown', modeConfirmed: false })); // still no footer
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.calls.length, 2, 'no third PUT');
    assert.equal(r.log.noted.length, 1);
    assert.equal(r.log.noted[0].modeConfirmed, false, 'the honest state');
    assert.equal(r.ctx.HOLD.active, false);
  });

  test('(−) F10: the room answer never comes: the second timeout applies the pending capture and sends nothing more', async () => {
    const r = await heldRig({ more: [{ status: 409, body: { error: 'busy' } }] });
    r.handleHeld(shot(145, 21));
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.calls.length, 2);
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.calls.length, 2);
    assert.equal(r.log.noted.length, 1);
    assert.equal(r.ctx.HOLD.active, false);
  });

  test('(−) F10: no room step when the frame has 33 rows or more, when nothing was readable before, or for a state other than fitted', async () => {
    const tall = await heldRig({ box: PANEL_145X40, pane: { cols: 145, rows: 39 } });
    tall.handleHeld(shot(145, 39));
    await tall.clk.advance(HOLD_MS * 2);
    assert.deepEqual([tall.log.calls.length, tall.ctx.FIT.room], [1, false], '40 rows');
    const blind = await heldRig({ plain: false });
    blind.handleHeld(shot(145, 21));
    await blind.clk.advance(HOLD_MS * 2);
    assert.deepEqual([blind.log.calls.length, blind.ctx.FIT.room], [1, false], '!plainBefore');
    for (const state of ['zoomed', 'terminal', 'blocked', 'other']) {
      const r = await heldRig({ state });
      r.handleHeld(shot(145, 21));
      await r.clk.advance(HOLD_MS * 2);
      assert.deepEqual([r.log.calls.length, r.ctx.FIT.room], [1, false], state);
    }
  });

  test('(−) F10: no room step when the capture is not at the answered size, shows a prompt, or Claude is not in its full-screen view', async () => {
    for (const [why, c] of [['old size', shot(171, 45)], ['prompt', shot(145, 21, { prompt: { kind: 'tool', question: 'x', options: [] } })], ['no full-screen view', shot(145, 21, { alt: false })]]) {
      const r = await heldRig();
      r.handleHeld(c);
      await r.clk.advance(HOLD_MS * 2);
      assert.deepEqual([r.log.calls.length, r.ctx.FIT.room], [1, false], why);
    }
  });

  test('(+) F10: later focus takes ask the room size straight away: the settle\'s PUT carries it, with no second resize', async () => {
    const r = await heldRig({ more: [answerAt('fitted', { cols: 210, rows: 32 })] });
    r.handleHeld(shot(145, 21));
    await r.clk.advance(HOLD_MS);
    r.handleHeld(shot(210, 32, { draft: BOXED }));
    r.page.focus = true;
    r.log.events.focus({ target: r.ctx.window });
    await r.clk.advance(FOCUS_SETTLE_REAL);
    assert.deepEqual(calls(r).slice(2), [PUT(210, 33, false, true)]);
    await r.clk.advance(1000);
    assert.equal(r.log.calls.length, 3);
  });

  test('(−) F10: Fit again clears the room and the next PUT is the panel\'s own size (open: true)', async () => {
    const r = await heldRig({ more: [answerAt('fitted', { cols: 210, rows: 32 }), answerAt('fitted', { cols: 145, rows: 21 })] });
    r.handleHeld(shot(145, 21));
    await r.clk.advance(HOLD_MS);
    r.handleHeld(shot(210, 32, { draft: BOXED }));
    r.openFitPop();
    r.again.click();
    await r.clk.advance(0);
    assert.equal(r.ctx.FIT.room, false);
    assert.deepEqual(calls(r).slice(2), [PUT(145, 22, true)]);
  });

  test('(−) F10: a commit with a new window size (or a box one cell wider) clears the room; a commit with the same window keeps it', async () => {
    const same = await heldRig({ more: [answerAt('fitted', { cols: 210, rows: 32 })] });
    same.handleHeld(shot(145, 21));
    await same.clk.advance(HOLD_MS);
    assert.equal(same.ctx.FIT.room, true);
    same.page.focus = true;
    same.log.events.focus({ target: same.ctx.window });
    assert.equal(same.ctx.FIT.room, true, 'a focus commit in the same window keeps it');
    const moved = await heldRig({ more: [answerAt('fitted', { cols: 210, rows: 32 })] });
    moved.handleHeld(shot(145, 21));
    await moved.clk.advance(HOLD_MS);
    moved.ctx.window.innerWidth = 1100;
    moved.term.clientWidth += 80;
    moved.log.ro();
    assert.equal(moved.ctx.FIT.room, false, 'a new window size deserves a try at the panel\'s size');
    await moved.clk.advance(250);
    assert.deepEqual(norm(calls(moved).at(-1)), norm(PUT(155, 22, false)));
  });

  test('(−) F10: holdTimeout takes no room step for a hold that had nothing readable before (plainBefore false), whatever the capture shows', async () => {
    const r = await heldRig(); // fitted, 145 x 22 frame: only plainBefore stands in the way
    r.ctx.HOLD.end();
    assert.equal(r.ctx.FIT.state, 'fitted');
    const pending = { r: shot(145, 21), body: shot(145, 21).body, draft: null };
    const before = r.log.calls.length;
    r.holdTimeout(pending, { want: { cols: 145, rows: 21 }, plainBefore: false });
    assert.equal(r.ctx.FIT.room, false);
    assert.equal(r.log.calls.length, before, 'no resize');
    assert.equal(r.log.noted.length, 1, 'the capture is drawn as it is');
    r.holdTimeout(pending, { want: { cols: 145, rows: 21 }, plainBefore: true });
    assert.equal(r.ctx.FIT.room, true, 'and with plainBefore the same call does take the step');
  });

  test('(−) F10: fitSized with nothing drawn yet does nothing and does not throw', () => {
    const r = rig({ box: PANEL_145X22 });
    r.wireFit();
    assert.doesNotThrow(() => r.fitSized({ cols: 145, rows: 21 }));
    assert.equal(r.ctx.HOLD.active, false);
    assert.deepEqual(r.log.kicks, []);
  });

  test('(−) F10: applyHeld with no frame drawn before starts no transition', () => {
    const r = rig({ box: PANEL_145X22 });
    r.wireFit();
    r.applyHeld(shot(145, 21));
    assert.deepEqual(r.log.classOps, []);
    assert.equal('--refit-from' in r.rows.style.props, false);
  });

  test('(+) F10: the class is restarted: removed, then added again, so a transition still running begins anew', async () => {
    const r = await heldRig();
    r.handleHeld(shot(145, 21, { draft: BOXED }));
    r.rows.classes.add('refit'); // as if the earlier one still ran
    r.log.classOps.length = 0;
    r.handleHeld(shot(171, 45, { draft: BOXED })); // no hold now: handled as always, no transition
    assert.deepEqual(r.log.classOps, []);
    r.ctx.HOLD.start({ want: { cols: 100, rows: 30 }, plainBefore: true });
    r.handleHeld(shot(100, 30, { draft: BOXED }));
    assert.deepEqual(r.log.classOps.slice(0, 2), ['-refit', '+refit']);
  });

  // -- the transition
  test('(+) F10: the applied frame starts --refit-from through style.setProperty (never a style attribute) and restarts the class; animationend removes it', async () => {
    const r = await heldRig();
    r.handleHeld(shot(145, 21, { draft: BOXED }));
    assert.equal(r.rows.classes.has('refit'), true);
    assert.equal(r.rows.style.props['--refit-from'], '0.5', 'the old text was 0.49, the new is 1: zoom in from half');
    assert.equal(typeof r.log.rowsOn.animationend, 'function');
    r.log.rowsOn.animationend({ animationName: 'nika-refit' });
    assert.equal(r.rows.classes.has('refit'), false);
  });

  test('(+) F10: without animationend (reduced motion: no animation runs) the class goes after REFIT_MS + 50 ms', async () => {
    const r = await heldRig();
    r.handleHeld(shot(145, 21, { draft: BOXED }));
    await r.clk.advance(REFIT_MS_REAL + 49);
    assert.equal(r.rows.classes.has('refit'), true);
    await r.clk.advance(1);
    assert.equal(r.rows.classes.has('refit'), false);
  });

  test('(−) F10: an animationend of another animation leaves the class alone', async () => {
    const r = await heldRig();
    r.handleHeld(shot(145, 21, { draft: BOXED }));
    r.log.rowsOn.animationend({ animationName: 'something-else' });
    r.log.rowsOn.animationend({});
    assert.equal(r.rows.classes.has('refit'), true);
  });

  test('(−) F10: no refit when the applied frame has the drawn size, and none for the first frame ever drawn', async () => {
    const r = await heldRig({ box: PANEL_145X40, pane: { cols: 145, rows: 39 } });
    r.handleHeld(shot(171, 45)); // the drawn size, no box: kept; applied at the timeout
    await r.clk.advance(HOLD_MS);
    assert.equal(r.log.drawn.length, 1);
    assert.equal(r.rows.classes.has('refit'), false);
    assert.equal('--refit-from' in r.rows.style.props, false);
    const first = rig();
    first.wireFit();
    first.handleHeld(shot(100, 30)); // no hold, nothing drawn before
    assert.equal(first.rows.classes.has('refit'), false);
  });

  test('(−) F10: a shrinking text only fades: --refit-from is 1', async () => {
    const r = await heldRig({ pane: { cols: 171, rows: 45 } }); // the same size as drawn: no hold ... so make one by hand
    r.ctx.HOLD.start({ want: { cols: 300, rows: 90 }, plainBefore: true });
    r.ctx.FIT.scale = 1;
    r.handleHeld(shot(300, 90, { draft: BOXED }));
    assert.equal(r.rows.style.props['--refit-from'], '1');
  });

  // -- the code
  test('(+) F10: the page code keeps constraint 6 for the new parts: refit uses the class and the CSSOM property only, in the fit-ui.js and session.js sources', () => {
    const src = [fnOf('function refit(oldScale)'), fnOf('function endRefit()'), fnOf('function fitChip(view, opts)'), fnOf('function handleHeld(r)')].join('\n');
    assert.match(src, /style\.setProperty\('--refit-from', String\(/);
    assert.match(src, /classList\.remove\('refit'\)/);
    assert.match(src, /classList\.add\('refit'\)/);
    assert.deepEqual(findSinks(src), []);
    assert.doesNotMatch(src, /setAttribute\('style'|\.style\.cssText|innerHTML|textContent =/);
  });

  test('(+) F10: wireFit hands the planner sized: fitSized and the chip sink fitChip, listens for animationend on the mirror rows, and commits on the focus event before it asks for the focus', () => {
    const wire = fnOf('function wireFit()');
    assert.match(wire, /sized:\s*fitSized\b/);
    assert.match(wire, /chip:\s*fitChip\b/);
    assert.match(wire, /\$\('term-rows'\)\.addEventListener\('animationend'/);
    assert.match(wire, /addEventListener\('focus', \(e\) => \{[^}]*fitCommit\(\);\s*FIT\.planner\.focusChanged\(false\)/);
    assert.match(wire, /send: \(body\) => \{[^}]*FIT\.sentRows = body\.rows;/);
    assert.doesNotMatch(wire, /addEventListener\('blur', \(e\) => \{[^}]*fitCommit/, 'blur measures nothing');
  });

  test('(+) F10: the mirror is read again at once after the answer and every HOLD_POLL_MS during a hold; the capture path goes through handleHeld', () => {
    const tick = fnOf('async function tickMirror()');
    assert.match(tick, /handleHeld\(r\)/);
    assert.doesNotMatch(tick, /handleCapture\(r\)/);
    assert.match(tick, /HOLD\.active \? HOLD_POLL_MS : 250/);
    assert.match(fnOf('function fitSized(pane)'), /kickMirror\(0\)/);
  });

  test('(+) F10: the page asks nothing of its own for the hold: the only new route traffic is the planner\'s PUT with the same four keys', () => {
    for (const f of ['function fitProbe()', 'function fitCommit()', 'function fitSized(pane)', 'function handleHeld(r)', 'function applyHeld(r)', 'function holdTimeout(pending, ctx)']) {
      assert.doesNotMatch(fnOf(f), /\bcall\(|fetch\(|appFetch/, f);
    }
    assert.match(fnOf('function fitCall(method, opts = {})'), /\/api\/app\/pane\/\$\{encodeURIComponent\(paneId\)\}\/fit/);
  });

  // ---- F10: the requests that wait for the redraw hold (design F10 4.5) ---------------------------------------------------------------------
  /** One function of session.js (or several) run alone in a vm against `ctx`. */
  const runFns = (heads, names, ctx) => vm.runInNewContext(`${heads.map(fnOf).join('\n')}; ({ ${names.join(', ')} })`, ctx);

  test('(+) F10: a mode switch during the hold sends its request after the hold ends; the segment shows busy meanwhile', async () => {
    const log = { calls: [], rendered: [] };
    const hold = createRedrawHoldReal({ after: () => 1, cancel() {} });
    const ctx = {
      HOLD: hold, SW: { busy: null }, M: { gone: false }, paneId: '%12', W: { struck: new Set(), mode: 'default', confirmed: true, promptOpen: false, msg: null, last: null, pane: 'ok' }, A: { kind: 'idle', name: 'agent' },
      switcherState: () => ({ disabled: false, pressed: 'default', reason: null }), renderMode: () => log.rendered.push(ctx.SW.busy),
      call: async (path, o) => { log.calls.push([path, norm(o)]); return { status: 200, body: { mode: 'auto', presses: 1 } }; },
      say() {}, TIMES: 'x', modeKey: (m) => m ?? 'unknown', announceMode() {}, modeNote: () => ({ msg: '', last: 'auto' }), nextCapture: async () => {}, failSwitch() {}, setGone() {}, encodeURIComponent,
    };
    const { switchTo } = runFns(['async function switchTo(target)'], ['switchTo'], ctx);
    hold.start({ want: { cols: 100, rows: 30 }, plainBefore: true });
    const p = switchTo('auto');
    await flushAll();
    assert.deepEqual(log.calls, [], 'held');
    assert.equal(ctx.SW.busy, 'auto');
    hold.end();
    await p;
    assert.deepEqual(log.calls, [['/api/app/pane/%2512/mode', { method: 'POST', json: { target: 'auto' } }]]);
    assert.equal(ctx.SW.busy, null);
  });

  test('(−) F10: a mode switch with no hold sends at once, in the same tick', () => {
    const log = { calls: [] };
    const ctx = {
      HOLD: { active: false }, SW: { busy: null }, M: { gone: false }, paneId: '%12', W: { struck: new Set(), mode: 'default', confirmed: true, promptOpen: false, msg: null, last: null, pane: 'ok' }, A: { kind: 'idle', name: 'agent' },
      switcherState: () => ({ disabled: false, pressed: 'default', reason: null }), renderMode() {},
      call: async (path, o) => { log.calls.push([path, norm(o)]); return { status: 200, body: { mode: 'auto', presses: 1 } }; },
      say() {}, TIMES: 'x', modeKey: (m) => m ?? 'unknown', announceMode() {}, modeNote: () => ({ msg: '', last: 'auto' }), nextCapture: async () => {}, failSwitch() {}, setGone() {}, encodeURIComponent,
    };
    runFns(['async function switchTo(target)'], ['switchTo'], ctx).switchTo('auto');
    assert.equal(log.calls.length, 1);
  });


  test('(+) F10: the draft sync\'s write (put) waits for the hold; the End dialog opens after it; Stop, the keys of Type into pane and the prompt answers do not wait', async () => {
    const log = [];
    const hold = createRedrawHoldReal({ after: () => 1, cancel() {} });
    const fn = runFns(['async function putDraft(body)'], ['putDraft'], { HOLD: hold, call: async (path, o) => { log.push([path, norm(o)]); return { status: 200, body: {} }; }, encodeURIComponent, paneId: '%12' }).putDraft;
    hold.start({ want: { cols: 100, rows: 30 }, plainBefore: true });
    const p = fn({ text: 'hi' });
    await flushAll();
    assert.deepEqual(log, [], 'held');
    hold.end();
    await p;
    assert.deepEqual(log, [['/api/app/pane/%2512/draft', { method: 'PUT', json: { text: 'hi' } }]]);

    const opened = [];
    const endHold = createRedrawHoldReal({ after: () => 1, cancel() {} });
    const end = runFns(['function openEnd()'], ['openEnd'], { HOLD: endHold, paneId: '%12', A: { name: 'a', kind: 'idle' }, W: { promptOpen: false }, openEndDialog: (o) => opened.push(o.pane), toast() {}, setGone() {} }).openEnd;
    endHold.start({ want: { cols: 100, rows: 30 }, plainBefore: true });
    end();
    await flushAll();
    assert.deepEqual(opened, [], 'the dialog waits for the hold');
    endHold.end();
    await flushAll();
    assert.deepEqual(opened, ['%12']);
    end();
    assert.deepEqual(opened, ['%12', '%12'], 'no hold: opens in the same tick');

    for (const head of ['async function stop()', 'async function deliver(payload)', 'function flushPass()', 'async function answer(n)', 'async function escNo()', 'function queueArrow(key, repeat)']) {
      assert.doesNotMatch(fnOf(head), /\bHOLD\b/, `${head} does not wait`);
    }
  });

  test('(+) F10: the waits are the Send chain\'s own (typeThenSubmit, submitEnter, putDraft), the scroll call and the mode and command calls, in the source', () => {
    for (const head of ['async function submitEnter(base)', 'async function typeThenSubmit(payloads)', 'async function switchTo(target)', 'async function sendCommand(text)', 'async function putDraft(body)']) {
      assert.match(fnOf(head), /if \(HOLD\.active\) await HOLD\.wait\(\);/, head);
    }
    assert.match(fnOf('function scrollCall(body)'), /if \(HOLD\.active\) return HOLD\.wait\(\)\.then\(\(\) => scrollCall\(body\)\);/);
  });

  // ---- F10: the stylesheet (design F10 6.2) ------------------------------------------------------------------------------------------------
  test('(+) F10: session.css has the nika-refit keyframes (fade and zoom from --refit-from), the 120 ms class anchored bottom-left, and no animation under reduced motion', () => {
    const css = strip(CSS);
    assert.match(css, /@keyframes nika-refit \{\s*from \{\s*opacity: 0\.4;\s*transform: scale\(var\(--refit-from, 1\)\);\s*\}\s*to \{\s*opacity: 1;\s*transform: none;\s*\}\s*\}/);
    assert.match(css, /\.term-rows\.refit \{[^}]*animation: nika-refit 120ms ease-out;[^}]*transform-origin: 0 100%;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.term-rows\.refit \{ animation: none; \}/);
    assert.match(css, new RegExp(`${REFIT_MS_REAL}ms`));
  });

  test('(−) F10: the transition is a class and a custom property, never a style attribute in the markup', () => {
    assert.doesNotMatch(HTML, /\sstyle\s*=/i);
    assert.doesNotMatch(HTML, /refit/);
  });

  // ---- F11 (design F11 8.2): the rows hidden under the strip are filled with more of Claude's conversation -----------------------------------------
  const inkRow = [{ t: 'x', s: {} }];
  const boxAt = (top, over = {}) => ({ ...BOXED, box: { top, bottom: top + 3 }, ...over });
  /** A capture of cols x rows with ink on every row and a readable input box whose top rule is row `top` (default: 6 rows from the bottom, so 6 hidden rows). */
  const fshot = (cols, rows, top = rows - 6, over = {}) => ({ status: 200, body: { cols, rows: Array.from({ length: rows }, () => inkRow), alt: true, prompt: null, dialog: null, mode: 'auto', modeConfirmed: true, scrolled: false, etag: 'ab', cursor: null, draft: boxAt(top), ...over } });
  const UNREADABLE = { state: 'unreadable', mode: 'prompt', text: '', sig: null, reason: 'pasted', box: { top: 39, bottom: 42 }, cursorAtEnd: false, suggestion: null };
  // the design's example panel: 145 x 22 cells at a 7.2 x 16.2 px cell, inner height 362.88 px, a 27 px strip (the probe is 100 glyphs wide)
  const FILL_BOX = { w: 1068.5, h: 382.88 };
  const FILL_CELL = { w: 720, h: 16.2 };
  const fillRig = (o = {}) => rig({ box: FILL_BOX, cell: FILL_CELL, realDraw: true, ...o });
  const scaleProps = (r) => norm(r.log.props).filter(([k]) => k === '--fit-scale');

  test('(+) F11: the first capture of a lease commits before it starts: the start PUT carries the hidden rows (exactly one PUT)', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 25 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45)); // 6 rows from the box's top rule down
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(145, 26, true)], '20 rows above the 27 px strip + 6 hidden rows (no border row learned yet)');
    assert.equal(r.ctx.FIT.hide, 6);
    assert.equal(r.ctx.FIT.strip, 27);
    r.handleCapture(fshot(171, 45));
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(1000);
    assert.equal(r.log.calls.length, 1, 'later captures commit nothing');
  });

  test('(−) F11: after setGone the first capture of the new lease commits again (one PUT, with that frame\'s hidden rows); a capture while started and a capture after a 403 commit nothing', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 25 }), answerAt('fitted', { cols: 145, rows: 28 })] });
    let measures = 0;
    const rect = r.term.getBoundingClientRect;
    r.term.getBoundingClientRect = () => { measures += 1; return rect(); };
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.equal(r.ctx.FIT.d, 1);
    const seen = measures;
    r.handleCapture(fshot(171, 45, 37)); // started: no commit
    r.handleCapture(fshot(171, 45, 37));
    assert.equal(measures, seen, 'a capture while started measures nothing');
    assert.equal(r.log.calls.length, 1);
    r.setGone();
    r.handleCapture(fshot(171, 45, 37)); // the new lease's first frame: 8 hidden rows
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(145, 26, true), DELETE, PUT(145, 29, false)], '20 + 8 + the border row');
    assert.ok(measures > seen, 'and the new lease measured');
    const dead = fillRig({ replies: [{ status: 403, body: null }] });
    let m2 = 0;
    const rect2 = dead.term.getBoundingClientRect;
    dead.term.getBoundingClientRect = () => { m2 += 1; return rect2(); };
    dead.wireFit();
    dead.handleCapture(fshot(171, 45));
    await dead.clk.advance(0);
    const after = m2;
    dead.handleCapture(fshot(171, 45));
    dead.handleCapture(fshot(171, 45));
    await dead.clk.advance(10000);
    assert.equal(m2, after, 'after a 403 no capture commits (no measure)');
    assert.equal(dead.log.calls.length, 1);
  });

  test('(+) F11: a focus with a readable draft and Type into pane off sends one PUT with the extra rows; captures after the answer, even one whose cut moved up, send no further PUT', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 25 }), answerAt('fitted', { cols: 145, rows: 26 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.equal(r.ctx.FIT.d, 1, 'asked 26 rows, got 25: the border row is learned');
    r.handleHeld(fshot(145, 25)); // Claude repainted at the new size
    assert.equal(r.ctx.HOLD.active, false);
    r.page.focus = true;
    r.log.events.focus({ target: r.ctx.window });
    await r.clk.advance(FOCUS_SETTLE_REAL);
    assert.deepEqual(calls(r), [PUT(145, 26, true), PUT(145, 27, false, true)], '20 rows above the strip + 6 + the border row');
    r.handleHeld(fshot(145, 26)); // the answer's frame, ready
    assert.equal(r.ctx.HOLD.active, false);
    r.handleHeld(fshot(145, 26, 18)); // the cut moved up 2 rows (a longer draft)
    r.handleHeld(fshot(145, 26, 22)); // and down
    await r.clk.advance(1000);
    assert.equal(r.log.calls.length, 2, 'one resize for this focus, and no cascade from the cut moving');
  });

  test('(−) F11: the same focus with Type into pane on, a null draft or an unreadable draft asks the size F10 asked (145 x 22), at the start and at the focus', async () => {
    const variants = [
      ['Type into pane on', true, fshot(171, 45)],
      ['no draft', false, fshot(171, 45, undefined, { draft: null })],
      ['an unreadable draft', false, fshot(171, 45, undefined, { draft: UNREADABLE })],
    ];
    for (const [why, pass, first] of variants) {
      const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 21 }), answerAt('fitted', { cols: 145, rows: 21 })] });
      r.ctx.P.on = pass;
      r.wireFit();
      r.handleCapture(first);
      await r.clk.advance(0);
      assert.equal(r.ctx.FIT.hide, 0, why);
      r.handleHeld({ status: 200, body: { ...fshot(145, 21).body, draft: first.body.draft } });
      r.page.focus = true;
      r.log.events.focus({ target: r.ctx.window });
      await r.clk.advance(FOCUS_SETTLE_REAL);
      assert.deepEqual(calls(r), [PUT(145, 22, true), PUT(145, 22, false, true)], why);
    }
  });

  test('(+) F11: the border row d is learned from nika\'s own answer (the asked columns and rows minus one) and kept through a terminal answer: the next focus PUT still adds it', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 25 }), answerAt('terminal', { cols: 171, rows: 45 }), answerAt('terminal', { cols: 171, rows: 45 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.deepEqual([r.ctx.FIT.sentCols, r.ctx.FIT.sentRows, r.ctx.FIT.d], [145, 26, 1]);
    r.handleHeld(fshot(145, 25));
    r.page.focus = true;
    r.log.events.focus({ target: r.ctx.window });
    await r.clk.advance(FOCUS_SETTLE_REAL);
    assert.equal(r.ctx.FIT.d, 1, 'the terminal\'s 171 x 45 (other columns) is not nika\'s size: d is kept, not reset to 0 or set to -18');
    r.handleHeld(fshot(171, 45));
    r.page.focus = false;
    r.log.events.blur({ target: r.ctx.window });
    await r.clk.advance(BLUR_SETTLE_REAL);
    assert.equal(r.ctx.FIT.d, 1);
    r.page.focus = true;
    r.log.events.focus({ target: r.ctx.window });
    await r.clk.advance(FOCUS_SETTLE_REAL);
    assert.deepEqual(calls(r).map((c) => [c.json.rows, c.json.focus]), [[26, false], [27, true], [27, false], [27, true]], 'with d reset to 0 this would ask 26');
  });

  test('(−) F11: an answer with other columns than asked, or rows that give a difference outside 0..1, keeps the border row it had', async () => {
    const r = fillRig();
    r.wireFit();
    r.ctx.FIT.d = 1;
    r.ctx.FIT.sentCols = 145;
    r.ctx.FIT.sentRows = 27;
    r.fitSized({ cols: 171, rows: 27 }); // other columns, and rows that look like "no border row": a terminal's size says nothing about d
    assert.equal(r.ctx.FIT.d, 1);
    r.ctx.FIT.d = 0;
    r.fitSized({ cols: 171, rows: 26 }); // and rows that look like a border row
    assert.equal(r.ctx.FIT.d, 0);
    r.ctx.FIT.d = 1;
    r.fitSized({ cols: 145, rows: 10 }); // 17 rows apart
    assert.equal(r.ctx.FIT.d, 1);
    r.fitSized({ cols: 145, rows: 29 }); // the pane is bigger than asked
    assert.equal(r.ctx.FIT.d, 1);
    r.fitSized({ cols: 145, rows: 27 }); // exactly the asked size: no border row
    assert.equal(r.ctx.FIT.d, 0);
    r.fitSized({ cols: 145, rows: 26 });
    assert.equal(r.ctx.FIT.d, 1);
  });

  test('(+) F11: the text scale counts the rows drawn: after the answer 145 x 26 and a ready frame it is 1, not 22/26', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 26 })] });
    r.ctx.FIT.d = 1; // learned earlier: the start asks 20 + 6 + 1 = 27 rows
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(145, 27, true)]);
    r.handleHeld(fshot(145, 26)); // a ready frame: 6 hidden rows
    assert.equal(r.ctx.FIT.scale, 1);
    assert.deepEqual(scaleProps(r).at(-1), ['--fit-scale', '1']);
    assert.equal(scaleProps(r).some(([, v]) => Math.abs(Number(v) - 22 / 26) < 1e-6), false, 'F10 would have set 22 / 26');
  });

  test('(+) F11: while the terminal owns the size (171 x 45, 6 hidden rows) the text is 0.532, not 0.489 (owner answer Q1)', async () => {
    const r = fillRig({ replies: [answerAt('terminal', { cols: 171, rows: 45 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.ok(Math.abs(r.ctx.FIT.scale - 0.5316) < 1e-3, String(r.ctx.FIT.scale));
    assert.ok(Math.abs(r.ctx.FIT.scale - 22 / 45) > 0.04);
    assert.equal(r.ctx.FIT.state, 'terminal');
  });

  test('(−) F11: a capture at the same pane size whose cut turned off, moved up or moved down changes no text scale and sends no PUT', async () => {
    const r = fillRig({ replies: [answerAt('terminal', { cols: 171, rows: 45 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    const [props, sent] = [scaleProps(r).length, r.log.calls.length];
    assert.equal(r.ctx.M.cut, 39);
    r.handleCapture(fshot(171, 45, 37)); // cut up 2: K 8
    assert.equal(r.ctx.M.cut, 37);
    r.handleCapture(fshot(171, 45, 41)); // cut down: K 4
    assert.equal(r.ctx.M.cut, 41);
    r.ctx.P.on = true; // Type into pane: no cut
    r.handleCapture(fshot(171, 45));
    assert.equal(r.ctx.M.cut, null);
    r.ctx.P.on = false;
    r.handleCapture(fshot(171, 45, undefined, { draft: null })); // a prompt, a dialog: no readable box
    assert.equal(r.ctx.M.cut, null);
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(1000);
    assert.equal(scaleProps(r).length, props, 'the text is held between commits');
    assert.equal(r.log.calls.length, sent, 'and nothing is asked');
  });

  test('(+) F11: a capture that changes the pane size recomputes the text from that frame\'s hidden rows (the hold\'s ready frame)', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 26 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45)); // committed with 6 hidden rows: 20 rows above the strip
    await r.clk.advance(0);
    r.handleHeld(fshot(145, 26, 24)); // Claude drew only 2 rows under the cut at the new size: 24 rows above it, 4 more than the panel holds
    assert.ok(Math.abs(r.ctx.FIT.scale - (382.88 - 20 - 27) / (24 * 16.2)) < 1e-6, `the text shrinks so nothing is hidden: ${r.ctx.FIT.scale}`);
    assert.ok(r.ctx.FIT.scale < 1);
  });

  test('(−) F11: a ready frame with more hidden rows than committed leaves the text at 1 (empty rows under the strip, never cut-off text)', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 26 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    r.handleHeld(fshot(145, 26, 16)); // 10 hidden rows
    assert.equal(r.ctx.FIT.scale, 1);
  });

  test('(+) F11: the mirror is re-pinned to the bottom by drawMirror when not paused, and left alone when paused', () => {
    const r = fillRig();
    r.wireFit();
    r.ctx.M.body = fshot(171, 45).body;
    r.ctx.M.draft = cleanDraftReal(r.ctx.M.body.draft);
    r.term.scrollHeight = 900;
    r.term.scrollTop = 0;
    r.drawMirror();
    assert.equal(r.term.scrollTop, 900);
    r.ctx.M.frozen = true;
    r.term.scrollTop = 123;
    r.drawMirror();
    assert.equal(r.term.scrollTop, 123, 'the reader keeps the place');
    assert.equal(r.ctx.M.cut, 39, 'the cut drawn is kept for the commit points');
  });

  test('(+) F11: Type into pane on and off redraws at once (no strip, then the strip) and re-pins the bottom; it sends no PUT and changes no text scale', () => {
    const log = { commit: 0, scale: 0, size: 0, drawn: [] };
    const term = { classList: { toggle() {} }, setAttribute() {}, focus() {}, scrollTop: 0, scrollHeight: 900 };
    const strip = { hidden: false };
    const els = { term, 'term-cut': strip, 'term-rows': 'rows', 'pass-banner': { hidden: true }, 'pass-toggle': { setAttribute() {} }, 'pass-onoff': {} };
    const body = fshot(171, 45).body;
    const ctx = {
      P: { on: false, buf: '', timer: 0 }, paneId: '%12', composer: () => ({ disabled: false, focus() {} }), endArrows() {}, flushPass() {}, A: { name: 'agent' }, announce() {},
      M: { gone: false, frozen: false, body, draft: cleanDraftReal(body.draft), cut: 39 }, $: (id) => els[id],
      cutAt: cutAtReal, cutCursor: cutCursorReal, toRenderModel: toRenderModelReal, applyMirror: (c, model) => log.drawn.push(model.length),
      fitCommit: () => { log.commit += 1; }, fitScale: () => { log.scale += 1; }, FIT: { planner: { size: () => { log.size += 1; } } },
    };
    const { setPass } = vm.runInNewContext(`${fnOf('function drawMirror()')}\n${fnOf('function setPass(on, keepFocus = false)')}; ({ setPass })`, ctx);
    setPass(true);
    assert.deepEqual([strip.hidden, ctx.M.cut, term.scrollTop, log.drawn.at(-1)], [true, null, 900, 45], 'every row, no strip, pinned to the bottom at once');
    term.scrollTop = 0;
    setPass(false, true);
    assert.deepEqual([strip.hidden, ctx.M.cut, term.scrollTop, log.drawn.at(-1)], [false, 39, 900, 39], 'the strip is back');
    assert.deepEqual([log.commit, log.scale, log.size], [0, 0, 0], 'no commit, no scale, no request');
  });

  test('(+) F11: the room step asks the room fill size at once (210 x 37), with the hidden rows and strip of the commit', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 25 }), answerAt('fitted', { cols: 210, rows: 36 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    r.handleHeld(fshot(145, 25, undefined, { draft: null })); // Claude's frame is cut: no input box
    await r.clk.advance(HOLD_MS - 1);
    assert.equal(r.log.calls.length, 1);
    await r.clk.advance(1);
    assert.deepEqual(calls(r), [PUT(145, 26, true), PUT(210, 37, false)], 'at once, no 250 ms wait');
    assert.equal(r.ctx.FIT.room, true);
  });

  test('(−) F11: no room step when the room ask adds no rows (a 32-row panel: the focus ask and the room ask are both 37): the pending frame is applied, no second PUT', async () => {
    const r = fillRig({ box: { w: 1068.5, h: 538.9 }, replies: [answerAt('fitted', { cols: 145, rows: 36 })] });
    r.ctx.FIT.d = 1;
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(145, 37, true)]);
    assert.equal(r.ctx.FIT.frame.rows, 32);
    r.handleHeld(fshot(145, 36, undefined, { draft: null }));
    await r.clk.advance(HOLD_MS * 2);
    assert.equal(r.log.calls.length, 1, 'the room ask equals the request last sent');
    assert.equal(r.ctx.FIT.room, false);
    assert.equal(r.ctx.HOLD.active, false);
    assert.equal(r.ctx.M.rows, 36, 'the pending frame is drawn as it is');
  });

  test('(+) F11: the strip\'s measured height is used: a 40 px strip leaves 19 rows above it (25 asked), where the 27 px one leaves 20 (26)', async () => {
    const r = fillRig({ strip: 40, replies: [answerAt('fitted', { cols: 145, rows: 24 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.equal(r.ctx.FIT.strip, 40);
    assert.deepEqual(calls(r), [PUT(145, 25, true)]);
  });

  test('(−) F11: a webview that gives no offsets uses the 2-cell fallback and still sends the PUT; a strip that is not shown measures 0', async () => {
    const r = fillRig({ strip: null, replies: [answerAt('fitted', { cols: 145, rows: 25 })] });
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    assert.equal(r.ctx.FIT.strip, 0);
    assert.deepEqual(calls(r), [PUT(145, 26, true)], 'the fallback leaves 20 rows above: nothing overfilled');
    const shown = fillRig();
    assert.equal(shown.fitStrip(), 0, 'hidden strip');
    shown.cutEl.hidden = false;
    assert.equal(shown.fitStrip(), 27);
    shown.cutEl.offsetHeight = -50;
    assert.equal(shown.fitStrip(), 0, 'a negative height is no height');
    shown.cutEl.offsetTop = NaN;
    assert.equal(shown.fitStrip(), 0);
  });

  test('(+) F11: Fit again reads the hidden rows again: Type into pane was on at the focus, now off, and Fit again\'s PUT carries the extra rows', async () => {
    const r = fillRig({ replies: [answerAt('fitted', { cols: 145, rows: 21 }), answerAt('fitted', { cols: 145, rows: 26 })] });
    r.ctx.P.on = true;
    r.wireFit();
    r.handleCapture(fshot(171, 45));
    await r.clk.advance(0);
    r.handleHeld(fshot(145, 21));
    assert.equal(r.ctx.FIT.hide, 0);
    r.ctx.P.on = false;
    r.handleCapture(fshot(145, 21)); // the box is hidden under the strip again
    r.ctx.FIT.room = true; // as if the room had been taken
    r.openFitPop();
    r.again.click();
    await r.clk.advance(0);
    assert.deepEqual(calls(r), [PUT(145, 22, true), PUT(145, 27, true)]);
    assert.equal(r.ctx.FIT.room, false);
    assert.equal(r.ctx.FIT.hide, 6);
  });

  test('(+) F11: the code reads the hidden rows only at commit points and at a pane-size change, never per capture', () => {
    assert.match(fnOf('function fitCommit()'), /FIT\.hide = hiddenRows\(M\.body\?\.rows, M\.cut\);/);
    assert.match(fnOf('function fitCommit()'), /FIT\.strip = FIT\.hide > 0 \? fitStrip\(\) : 0;/);
    assert.match(fnOf('function fitCommit()'), /fillSize\(frame, FIT\.room, FIT\.d, FIT\.hide, FIT\.strip\)/);
    assert.match(fnOf('function fitScale()'), /drawnScale\(\{ frame: FIT\.frame \?\? p,/);
    for (const head of ['function drawMirror()', 'function handleCapture(r)', 'function fitResize()', 'function fitSized(pane)']) assert.doesNotMatch(fnOf(head), /hiddenRows\(|fitStrip\(|fillSize\(|drawnScale\(/, head);
    const captured = fnOf('function fitCaptured()');
    assert.doesNotMatch(captured, /hiddenRows\(|fitStrip\(|fillSize\(|drawnScale\(/);
    assert.match(captured, /if \(FIT\.planner\?\.startable\) fitCommit\(\);\s*FIT\.planner\?\.start\(\);/, 'the first frame of a lease is committed before the start');
    assert.match(captured, /FIT\.scaledAt/, 'and the text is recomputed only when the pane size changed');
  });

  test('(+) F11: drawMirror keeps the cut it drew, the planner\'s send keeps the asked columns, and holdTimeout passes the room gain', () => {
    assert.match(fnOf('function drawMirror()'), /M\.cut = on \? cut : null;/);
    assert.match(fnOf('function drawMirror()'), /if \(!M\.frozen\) term\.scrollTop = term\.scrollHeight;/);
    assert.match(fnOf('function wireFit()'), /send: \(body\) => \{[^}]*FIT\.sentCols = body\.cols;[^}]*FIT\.sentRows = body\.rows;/);
    assert.match(fnOf('function holdTimeout(pending, ctx)'), /gain: [a-z.]*rows > FIT\.sentRows/);
    assert.match(fnOf('function holdTimeout(pending, ctx)'), /fillSize\(frame, true, FIT\.d, FIT\.hide, FIT\.strip\)/);
  });

  test('(−) F11: the new page code keeps constraint 6: no markup sink, no style attribute, the scale only through the one CSSOM call', () => {
    const src = ['function fitStrip()', 'function fitCommit()', 'function fitScale()', 'function fitCaptured()', 'function fitSized(pane)', 'function holdTimeout(pending, ctx)', 'function drawMirror()'].map(fnOf).join('\n');
    assert.deepEqual(findSinks(src), []);
    assert.doesNotMatch(src, /setAttribute\('style'|\.style\.cssText|innerHTML|textContent =|\.style\.[a-z]+ =/);
    assert.equal([...code(JS['session.js']).matchAll(/--fit-scale/g)].length, 1);
  });
});

// ---- 0.5, W3-T3: scrolling Claude's view (the wheel, PgUp/PgDn/Home/End, Jump to live, the corner note) ----------------------------------
// The pure rules are public/scroll.js (test/scroll-ui.test.js, with the twin of the server's gate). Here: the markup and stylesheet, and the
// functions of session.js run for real in a vm against a fake route, a manual clock and a fake DOM.

describe('W3-T3: scroll (markup and stylesheet)', () => {
  const css = strip(CSS);
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';
  const rules = (sel) => [...css.matchAll(new RegExp(`(?:^|[\\s}])${sel.replace(/[.[\]"=]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
  const symbol = (n) => new RegExp(`<symbol id="i-${n}" viewBox="0 0 16 16">([\\s\\S]*?)</symbol>`).exec(HTML)?.[1] ?? null;

  test('(+) the sprite draws i-up as the i-down path turned half a turn, and every icon the corner note names is in the sprite', () => {
    assert.equal(symbol('down'), '<path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/>');
    assert.equal(symbol('up'), '<path d="M8 13V3M12.5 7.5 8 3 3.5 7.5"/>');
    assert.doesNotMatch(symbol('up'), /\b(fill|stroke|style)=/, 'the .ic class draws the stroke');
    for (const state of [{ frozen: true }, { scrolled: true }]) assert.match(HTML, new RegExp(`<symbol id="i-${scrollNoteViewReal(state).note.icon}"`));
  });

  test('(+) #paused-note is empty and hidden in the markup (the script draws its icon and words); it keeps its place after #term', () => {
    assert.match(HTML, /<span class="paused-note" id="paused-note" hidden><\/span>/);
    assert.ok(HTML.indexOf('id="term"') < HTML.indexOf('id="paused-note"') && HTML.indexOf('id="paused-note"') < HTML.indexOf('id="jump-live"'));
  });

  test('(+) the terminal names its scroll keys in aria-keyshortcuts, stays a focusable region, and is still not a live region', () => {
    const t = tag('term');
    assert.match(t, /\baria-keyshortcuts="PageUp PageDown Home End"/);
    assert.match(t, /\btabindex="0"/);
    assert.match(t, /\brole="region"/);
    assert.doesNotMatch(t, /aria-live|role="log"|role="status"/);
  });

  test('(+) the note lays its icon and words out in a row (inline-flex), and Claude\'s scrolled view has its own colours (accent), apart from the idle pair of Paused', () => {
    const all = rules('.paused-note').join(' ');
    assert.match(all, /display:\s*inline-flex/);
    assert.match(all, /align-items:\s*center/);
    assert.match(all, /gap:\s*5px/);
    const base = rules('.paused-note')[0];
    assert.match(base, /background:\s*var\(--idle-soft\)/);
    assert.match(base, /(^|[\s;])color:\s*var\(--idle\)/);
    const scrolled = rules('.paused-note[data-k="scrolled"]');
    assert.equal(scrolled.length, 1);
    assert.match(scrolled[0], /(^|[\s;])color:\s*var\(--accent\)/);
    assert.match(scrolled[0], /background:\s*var\(--accent-soft\)/);
    assert.ok(css.lastIndexOf('.paused-note[data-k="scrolled"]') > css.indexOf('.paused-note {'), 'it comes after the base rule, so the cascade picks it');
  });

  test('(+) the [hidden] rule still hides the note (inline-flex must not override the attribute)', () => {
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  test('(−) no style attribute, inline style or new token: the colours are the existing accent and idle pairs', () => {
    assert.doesNotMatch(HTML, /\sstyle\s*=/i);
    assert.doesNotMatch(css, /color-mix\(|:has\(/);
    const own = rules('.paused-note[data-k="scrolled"]').join(' ');
    for (const v of own.match(/var\(--[a-z0-9-]+\)/g)) assert.ok(TOKENS.includes(`${v.slice(4, -1)}:`), `${v} is a token`);
  });

  const blockAt = (opener) => {
    const at = TOKENS.indexOf(opener);
    assert.ok(at >= 0, opener);
    const open = TOKENS.indexOf('{', at);
    return TOKENS.slice(open + 1, TOKENS.indexOf('}', open));
  };
  const vars = (block) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const light = vars(blockAt(':root {'));
  const THEME = { light, dark: { ...light, ...vars(blockAt(':root:not([data-theme="light"]) {')) }, darkPinned: { ...light, ...vars(blockAt(':root[data-theme="dark"] {')) } };
  const lin = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = (hex) => { const c = lin(hex); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  for (const [name, v] of Object.entries(THEME)) {
    test(`(+) contrast (${name}): the note text is at least 4.5:1 on its fill in both states, and the two states differ`, () => {
      assert.match(v['--accent'], /^#[0-9a-f]{6}$/i);
      assert.ok(ratio(v['--accent'], v['--accent-soft']) >= 4.5, `scrolled ${ratio(v['--accent'], v['--accent-soft']).toFixed(2)}`);
      assert.ok(ratio(v['--idle'], v['--idle-soft']) >= 4.5, `paused ${ratio(v['--idle'], v['--idle-soft']).toFixed(2)}`);
      assert.notEqual(v['--accent'], v['--idle']);
      assert.notEqual(v['--accent-soft'], v['--idle-soft']);
    });
  }

  test('(+) the module is served: /scroll.js is on the static list next to /fit-ui.js', () => {
    const server = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js'), 'utf8');
    assert.match(server, /\['\/scroll\.js', \['scroll\.js', 'text\/javascript; charset=utf-8'\]\]/);
    assert.ok(server.indexOf("'/fit-ui.js'") < server.indexOf("'/scroll.js'"));
  });

  test('(+) the Keyboard shortcuts window lists the scroll keys for the session window only (shortcuts.js)', async () => {
    const { shortcutsFor } = await import('../public/shortcuts.js');
    const names = (win) => shortcutsFor({ window: win, tier: 'app', mac: false }).flatMap((g) => g.rows).map((r) => r.name);
    assert.ok(names('session').includes("Scroll Claude's view") && names('session').includes('Top, or back to live'));
    assert.ok(!names('dashboard').includes("Scroll Claude's view"));
  });
});

describe('W3-T3: scroll in the session window (wiring)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const constOf = (head) => { // a one-line `const` of session.js
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n', at));
  };
  let restoreDom;
  before(() => { restoreDom = installDom(); });
  after(() => restoreDom());

  const NAMES = [
    'function scrollCall(body)', 'function renderNote()', 'function setScrolled(on)', 'function scrollCaptured(body)', 'function scrollLine(answer)',
    'function scrollDone(r)', 'function scrollOpen()', 'function scrollWheel(e)', 'function scrollKey(e)', 'function wireScroll()',
    'function setFrozen(on)', 'function jumpToLive()', 'function setGone()',
  ];
  const BOX = { top: 32, bottom: 34 }; // 32 rows above the input box: a page is 16 rows, 288 px at an 18 px cell
  const draftOf = (over = {}) => ({ state: 'empty', mode: 'prompt', text: '', sig: '0000000000000001', box: BOX, cursorAtEnd: true, suggestion: null, ...over });
  const bodyOf = (over = {}) => ({ alt: true, scrolled: false, prompt: null, cols: 120, rows: Array.from({ length: 36 }, () => []), draft: draftOf(), ...over });

  /** A manual clock for setTimeout / clearTimeout / Date.now; advance(ms) runs the timers due and lets the promises settle. */
  const clock = () => {
    let now = 5_000_000;
    let next = 1;
    const timers = new Map();
    const settle = () => new Promise((resolve) => { setImmediate(resolve); });
    return {
      setTimeout(fn, ms) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
      Date: { now: () => now },
      async advance(ms) {
        const end = now + ms;
        for (;;) {
          const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
          if (!due) break;
          timers.delete(due[0]);
          now = due[1].at;
          due[1].fn();
          await settle();
        }
        now = end;
        await settle();
      },
    };
  };

  /**
   * The scroll functions of session.js with a pane, a mirror box (term: scrollTop / scrollHeight / clientHeight), the last capture, and the route's
   * replies in order (then a 200 that says scrolled). The default box has no overflow, so the wheel and the keys are Claude's.
   */
  const rig = ({ pane = '%12', box = { top: 0, height: 400, client: 400 }, body = bodyOf(), replies = [], hold = false } = {}) => {
    const clk = clock();
    const log = { calls: [], signals: [], problems: [], said: [], kicks: [], lives: [], events: {}, focus: [] };
    const el = (id) => { const e = new El('div'); e.id = id; return e; };
    const term = Object.assign(el('term'), { scrollTop: box.top, scrollHeight: box.height, clientHeight: box.client, scrollLeft: 5 });
    const jump = el('jump-live');
    jump.hidden = true;
    const note = el('paused-note');
    note.hidden = true;
    const composer = Object.assign(el('composer'), { focus() { log.focus.push('composer'); } });
    const probe = Object.assign(el('fit-probe'), { getBoundingClientRect: () => ({ width: 800, height: 18 }) });
    const byId = { term, 'jump-live': jump, 'paused-note': note, composer, 'hist-scroll': el('hist-scroll'), 'fit-probe': probe };
    const ctx = {
      paneId: pane, M: { gone: false, fatal: false, frozen: false, cols: 120, rows: 36, etag: 'ab', timer: 0, body, draft: cleanDraftReal(body?.draft) }, P: { on: false }, FIT: { scale: 1, planner: null },
      $: (id) => byId[id], call: async (path, { signal, ...opts } = {}) => { log.calls.push({ path, ...opts }); log.signals.push(signal); return replies.length ? replies.shift() : { status: 200, body: { sent: 1, scrolled: true } }; },
      showProblem: (m, k, ms) => log.problems.push([m, k, ms]), announce: (m) => log.said.push(m), kickMirror: (ms) => log.kicks.push(ms),
      setLive: (state, text) => log.lives.push([state, text]), MID: ' - ', TIMES: 'x', h: hReal, icon: iconReal, AbortController,
      window: { addEventListener: (type, fn) => { log.events[type] = fn; } }, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, Date: clk.Date,
      // F10: a scroll request waits for the redraw hold; `hold: true` gives the rig a real one on the rig's clock
      HOLD: hold ? createRedrawHoldReal({ after: clk.setTimeout, cancel: clk.clearTimeout }) : { active: false },
      createScrollPlanner: createScrollPlannerReal, routeFor: routeForReal, wheelRows: wheelRowsReal, scrollGate: scrollGateReal, viewRowsOf: viewRowsOfReal, pageRowsOf: pageRowsOfReal,
      refusalLine: refusalLineReal, noteView: scrollNoteViewReal, scrolledSay: scrolledSayReal, NOTE_MS: NOTE_MS_REAL, encodeURIComponent,
      // setGone's other collaborators
      DS: { stop() {} }, setPaneState() {}, setInputEnabled() {}, showOverlay() {},
    };
    const src = `${constOf('const SC = ')}\n${constOf('const SCROLL_KEYS = ')}\n${NAMES.map(fnOf).join('\n')}; ({ scrollCall, renderNote, setScrolled, scrollCaptured, scrollLine, scrollDone, scrollOpen, scrollWheel, scrollKey, wireScroll, setFrozen, jumpToLive, setGone, SC })`;
    const fns = vm.runInNewContext(src, ctx);
    ctx.SC = fns.SC; // the file's own const, so tests read the state the functions use
    return { ...fns, ctx, log, clk, term, jump, note, composer, byId };
  };
  const ROUTE = '/api/app/pane/%2512/scroll';
  const POST = (json) => ({ path: ROUTE, method: 'POST', json });
  const wheel = (over = {}) => ({ deltaY: 144, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over }); // 144 px = 8 rows = half a page
  const key = (k, over = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...over });
  const calls = (r) => norm(r.log.calls);
  const wired = (opts) => { const r = rig(opts); r.wireScroll(); return r; };
  const fire = (r, type, e) => r.term.fire(type, e);

  // -- the wheel
  test('(+) a vertical wheel over the terminal with the gate open posts one scroll request and prevents the default (no overscroll bounce); focus does not move', () => {
    const r = wired();
    const e = fire(r, 'wheel', wheel());
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(calls(r), [POST({ dir: 'down', pages: 1 })]);
    assert.deepEqual(r.log.focus, []);
    assert.deepEqual(norm(r.log.problems), []);
  });

  test('(+) a wheel up is { dir: up }; the travel adds up over several events, and a page is half the rows above the input box', () => {
    const r = wired();
    fire(r, 'wheel', wheel({ deltaY: -72 })); // 4 rows
    assert.deepEqual(calls(r), [], 'a quarter of a page: nothing yet');
    fire(r, 'wheel', wheel({ deltaY: -72 }));
    assert.deepEqual(calls(r), [POST({ dir: 'up', pages: 1 })]);
  });

  test('(+) the cell height is the probe\'s height times the text scale: a scaled-down pane needs less pixel travel', () => {
    const r = wired();
    r.ctx.FIT.scale = 0.5; // 9 px per row, so 72 px is 8 rows
    fire(r, 'wheel', wheel({ deltaY: 72 }));
    assert.deepEqual(calls(r), [POST({ dir: 'down', pages: 1 })]);
  });

  test('(+) lines and pages as units: deltaMode 1 is rows, 2 is whole views', () => {
    const lines = wired();
    fire(lines, 'wheel', wheel({ deltaY: 8, deltaMode: 1 }));
    assert.deepEqual(calls(lines), [POST({ dir: 'down', pages: 1 })]);
    const pages = wired();
    fire(pages, 'wheel', wheel({ deltaY: -1, deltaMode: 2 })); // one view (32 rows) = two pages
    assert.deepEqual(calls(pages), [POST({ dir: 'up', pages: 2 })]);
  });

  test('(+) native first: the mirror\'s own overflow scrolls before Claude\'s view, in both directions', () => {
    const mid = wired({ box: { top: 300, height: 1000, client: 400 } });
    for (const dy of [-144, 144]) assert.equal(fire(mid, 'wheel', wheel({ deltaY: dy })).defaultPrevented, false, `${dy}: the browser scrolls`);
    assert.deepEqual(calls(mid), []);
    const top = wired({ box: { top: 0, height: 1000, client: 400 } });
    assert.equal(fire(top, 'wheel', wheel({ deltaY: 144 })).defaultPrevented, false, 'down from the top is native');
    assert.equal(fire(top, 'wheel', wheel({ deltaY: -144 })).defaultPrevented, true, 'up at the top is Claude\'s');
    assert.deepEqual(calls(top), [POST({ dir: 'up', pages: 1 })]);
    const bottom = wired({ box: { top: 600, height: 1000, client: 400 } });
    assert.equal(fire(bottom, 'wheel', wheel({ deltaY: -144 })).defaultPrevented, false, 'up from the bottom is native');
    assert.equal(fire(bottom, 'wheel', wheel({ deltaY: 144 })).defaultPrevented, true);
    assert.deepEqual(calls(bottom), [POST({ dir: 'down', pages: 1 })]);
  });

  test('(−) a pinch zoom or app gesture (Ctrl, Meta), sideways travel (Shift, deltaX) and a wheel with no travel stay with the browser: no request, no preventDefault', () => {
    const r = wired();
    for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 144 }, { deltaX: 200, deltaY: 144 }, { deltaY: 0 }, { deltaY: NaN }]) {
      assert.equal(fire(r, 'wheel', wheel(over)).defaultPrevented, false, JSON.stringify(over));
    }
    assert.deepEqual(calls(r), []);
  });

  test('(−) Claude not in its full-screen view (alt false or missing), no capture yet, a gone pane or a lost connection: no request and no line', () => {
    for (const body of [bodyOf({ alt: false }), (({ alt, ...rest }) => rest)(bodyOf()), bodyOf({ alt: 'true' }), null]) {
      const r = wired({ body });
      fire(r, 'wheel', wheel());
      assert.deepEqual(calls(r), []);
      assert.deepEqual(norm(r.log.problems), []);
    }
    for (const flag of ['gone', 'fatal']) {
      const r = wired();
      r.ctx.M[flag] = true;
      fire(r, 'wheel', wheel());
      assert.deepEqual(calls(r), [], flag);
      assert.deepEqual(norm(r.log.problems), []);
    }
  });

  test('(−) a gate that is closed (a prompt, a dialog, a slash menu) sends nothing and says why, in the page\'s own words, once per 3 s', async () => {
    const r = wired({ body: bodyOf({ prompt: { question: 'Do you want to proceed?', options: [] } }) });
    fire(r, 'wheel', wheel());
    fire(r, 'wheel', wheel());
    assert.deepEqual(calls(r), []);
    assert.deepEqual(norm(r.log.problems), [[refusalLineReal({ status: 409, code: 'prompt-open' }), 'warn', 3000]], 'one line');
    await r.clk.advance(2999);
    fire(r, 'wheel', wheel());
    assert.equal(r.log.problems.length, 1);
    await r.clk.advance(1);
    fire(r, 'wheel', wheel());
    assert.equal(r.log.problems.length, 2, 'the window passed');
    const codes = { 'screen-unclear': bodyOf({ draft: null }), 'menu-open': bodyOf({ draft: draftOf({ state: 'text', text: '/com' }) }) };
    for (const [code, body] of Object.entries(codes)) {
      const q = wired({ body });
      fire(q, 'wheel', wheel());
      assert.deepEqual(calls(q), []);
      assert.equal(q.log.problems[0][0], refusalLineReal({ status: 409, code }), code);
    }
  });

  test('(−) wheel events over the transcript or the message box are nobody\'s: wireScroll listens on the terminal only', () => {
    const r = wired();
    assert.deepEqual(Object.keys(r.term.listeners).sort(), ['keydown', 'wheel']);
    for (const [id, e] of Object.entries(r.byId)) if (id !== 'term') assert.deepEqual(e.listeners, {}, id);
    assert.deepEqual(Object.keys(r.log.events), ['pagehide']);
    assert.match(fnOf('function wireScroll()'), /\$\('term'\);/);
    assert.match(fnOf('function wireScroll()'), /addEventListener\('wheel', scrollWheel, \{ passive: false \}\)/);
  });

  // -- the keys
  test('(+) PgUp, PgDn, Home, End and Ctrl+Home, Ctrl+End in the terminal, Type into pane off: one page, or an end of Claude\'s view; the default is prevented', () => {
    const cases = [[key('PageUp'), { dir: 'up', pages: 1 }], [key('PageDown'), { dir: 'down', pages: 1 }], [key('Home'), { to: 'top' }], [key('End'), { to: 'bottom' }],
      [key('Home', { ctrlKey: true }), { to: 'top' }], [key('End', { ctrlKey: true }), { to: 'bottom' }]];
    for (const [e, json] of cases) {
      const r = wired();
      assert.equal(fire(r, 'keydown', e).defaultPrevented, true, e.key);
      assert.deepEqual(calls(r), [POST(json)], `${e.key}${e.ctrlKey ? ' + Ctrl' : ''}`);
      assert.deepEqual(r.log.focus, [], 'focus stays where it is');
    }
  });

  test('(+) the keys follow the same native-first rule: below the mirror\'s own top they are the browser\'s; Home at the top is Claude\'s, End from the top is not', () => {
    const mid = wired({ box: { top: 300, height: 1000, client: 400 } });
    for (const k of ['PageUp', 'PageDown', 'Home', 'End']) assert.equal(fire(mid, 'keydown', key(k)).defaultPrevented, false, k);
    assert.deepEqual(calls(mid), []);
    const top = wired({ box: { top: 0, height: 1000, client: 400 } });
    assert.equal(fire(top, 'keydown', key('Home')).defaultPrevented, true);
    assert.equal(fire(top, 'keydown', key('End')).defaultPrevented, false, 'End from the top: the mirror scrolls to its own bottom first');
    assert.deepEqual(calls(top), [POST({ to: 'top' })]);
  });

  test('(−) with Type into pane on, the keys are the pane\'s own: this handler sends nothing, and the passthrough maps them to PPage / NPage / Home / End for the keys route', () => {
    const r = wired();
    r.ctx.P.on = true;
    for (const k of ['PageUp', 'PageDown', 'Home', 'End']) assert.equal(fire(r, 'keydown', key(k)).defaultPrevented, false, k);
    assert.deepEqual(calls(r), []);
    const names = ['PageUp', 'PageDown', 'Home', 'End'].map((k) => keyForEventReal(key(k), { mac: false }));
    assert.deepEqual(names, [{ kind: 'key', name: 'PPage' }, { kind: 'key', name: 'NPage' }, { kind: 'key', name: 'Home' }, { kind: 'key', name: 'End' }]);
    for (const { name } of names) assert.ok(KEY_NAME.has(name), name);
  });

  test('(−) other chords stay with the browser: Shift, Alt or Meta with the keys, Ctrl+PgUp / Ctrl+PgDn (tabs), a key already handled, an IME key, other keys', () => {
    const r = wired();
    const nope = [key('PageUp', { shiftKey: true }), key('PageUp', { altKey: true }), key('PageUp', { metaKey: true }), key('PageUp', { ctrlKey: true }), key('PageDown', { ctrlKey: true }),
      key('Home', { shiftKey: true }), key('End', { altKey: true }), key('PageUp', { isComposing: true }), key('PageUp', { defaultPrevented: true }), key('ArrowUp'), key('Space'), key('a'), key('Enter')];
    for (const e of nope) assert.equal(r.term.fire('keydown', e).defaultPrevented, e.defaultPrevented === true, JSON.stringify(e));
    assert.deepEqual(calls(r), []);
  });

  test('(−) the message box keeps its own editing keys: nothing of this module listens there', () => {
    const r = wired();
    assert.deepEqual(r.composer.listeners, {});
    r.composer.fire('keydown', key('PageUp'));
    r.composer.fire('keydown', key('End'));
    assert.deepEqual(calls(r), []);
  });

  test('(−) a closed gate sends no key either, and says why', () => {
    const r = wired({ body: bodyOf({ prompt: { question: 'x?', options: [] } }) });
    assert.equal(fire(r, 'keydown', key('PageDown')).defaultPrevented, true);
    assert.deepEqual(calls(r), []);
    assert.equal(r.log.problems.length, 1);
    assert.match(r.log.problems[0][0], /^A prompt is open/);
  });

  // -- the answers
  test('(+) 200 says where Claude\'s view is now (a boolean), and the mirror is kicked to show it; a null leaves the state as it was', async () => {
    const r = wired({ replies: [{ status: 200, body: { sent: 1, scrolled: true } }, { status: 200, body: { sent: 1, scrolled: null } }, { status: 200, body: { sent: 1, scrolled: false } }] });
    fire(r, 'wheel', wheel());
    await r.clk.advance(0);
    assert.equal(r.ctx.SC.scrolled, true);
    assert.deepEqual(r.log.kicks, [0]);
    await r.clk.advance(100);
    fire(r, 'wheel', wheel({ deltaY: 288 })); // a whole page of travel: the first page was sent at half a page, so this one is due
    await r.clk.advance(0);
    assert.equal(r.ctx.SC.scrolled, true, 'null: unknown, unchanged');
    await r.clk.advance(100);
    fire(r, 'wheel', wheel({ deltaY: 288 }));
    await r.clk.advance(0);
    assert.equal(r.ctx.SC.scrolled, false);
    assert.equal(r.log.kicks.length, 3);
  });

  test('(−) a refusal shows its fixed line (409 by code, 0 and the rest by status) and drops what was queued; 429 says nothing', async () => {
    const cases = [
      [{ status: 409, body: { error: 'prompt-open', message: 'server words' } }, refusalLineReal({ status: 409, code: 'prompt-open' })],
      [{ status: 409, body: { error: 'busy-switching' } }, 'Another action is running on this session. Scroll again in a moment.'],
      [{ status: 502, body: { message: 'tmux said no' } }, "nika couldn't scroll Claude's view."],
      [{ status: 0, body: null }, 'nika did not answer.'],
      [{ status: 429, body: { error: 'busy' } }, null],
    ];
    for (const [reply, line] of cases) {
      const r = wired({ replies: [reply] });
      fire(r, 'wheel', wheel({ deltaY: 144 * 4 }));
      fire(r, 'wheel', wheel({ deltaY: 144 * 4 })); // queued behind the first
      await r.clk.advance(0);
      await r.clk.advance(1000);
      assert.equal(r.log.calls.length, 1, `status ${reply.status}: nothing behind a refusal`);
      assert.deepEqual(norm(r.log.problems), line === null ? [] : [[line, 'warn', 3000]], `status ${reply.status}`);
    }
  });

  test('(−) nothing the server says reaches the page: a hostile message or code is never shown', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const r = wired({ replies: [{ status: 409, body: { error: hostile, message: hostile } }] });
    fire(r, 'wheel', wheel());
    await r.clk.advance(0);
    assert.doesNotMatch(JSON.stringify([r.log.problems, r.log.said, r.note.attrs, r.note.textContent]), /img|onerror/);
    assert.equal(r.log.problems[0][0], "nika couldn't scroll Claude's view.");
  });

  test('(+) a 404 means the pane is gone (setGone closes the scroll planner); a 403 stops the planner for good', async () => {
    const gone = wired({ replies: [{ status: 404, body: { error: 'not_found' } }] });
    fire(gone, 'wheel', wheel());
    fire(gone, 'wheel', wheel({ deltaY: 144 * 3 }));
    await gone.clk.advance(0);
    assert.equal(gone.ctx.M.gone, true, 'setGone ran');
    await gone.clk.advance(1000);
    assert.equal(gone.log.calls.length, 1, 'the queued pages never went');
    assert.deepEqual(norm(gone.log.problems), []);
    const lost = wired({ replies: [{ status: 403, body: null }] });
    fire(lost, 'wheel', wheel());
    await lost.clk.advance(0);
    for (let i = 0; i < 3; i += 1) { fire(lost, 'wheel', wheel()); await lost.clk.advance(200); }
    fire(lost, 'keydown', key('PageUp'));
    lost.ctx.SC.scrolled = true;
    lost.jumpToLive();
    await lost.clk.advance(200);
    assert.equal(lost.log.calls.length, 1, 'no request after a 403');
    assert.deepEqual(norm(lost.log.problems), [], '403: the capture\'s overlay speaks, not this module');
  });

  test('(+) a pane that is gone, or a window with no pane, sends nothing: the route call itself refuses', async () => {
    const r = rig();
    r.ctx.M.gone = true;
    assert.deepEqual(norm(await r.scrollCall({ to: 'bottom' })), { status: 0, body: null });
    const none = rig({ pane: null });
    assert.deepEqual(norm(await none.scrollCall({ to: 'bottom' })), { status: 0, body: null });
    assert.deepEqual(r.log.calls.concat(none.log.calls), []);
  });

  test('(−) a call that never answers is cut off after 10 s (its signal aborts) and settles the planner like a lost request: one line, and the next wheel goes out', async () => {
    const r = wired();
    const signals = [];
    // a fetch that never answers until it is aborted, as the real one behaves
    r.ctx.call = (path, { signal }) => { signals.push(signal); return new Promise((resolve) => { signal.addEventListener('abort', () => resolve({ status: 0, body: null })); }); };
    fire(r, 'wheel', wheel());
    await r.clk.advance(0);
    assert.equal(signals.length, 1);
    await r.clk.advance(9999);
    assert.equal(signals[0].aborted, false, 'still waiting at 9.999 s');
    assert.deepEqual(norm(r.log.problems), []);
    fire(r, 'wheel', wheel({ deltaY: 144 * 4 })); // queued behind the call that is still out
    assert.equal(signals.length, 1, 'one request in flight');
    await r.clk.advance(1);
    assert.equal(signals[0].aborted, true, 'cut off at 10 s');
    assert.deepEqual(norm(r.log.problems), [['nika did not answer.', 'warn', 3000]], 'a failed answer: its fixed line');
    assert.equal(signals.length, 1, 'what was queued behind a failed answer is dropped');
    fire(r, 'wheel', wheel());
    await r.clk.advance(0);
    assert.equal(signals.length, 2, 'the planner is usable after the limit');
  });

  test('(+) an answer inside the limit clears the timer: the signal is never aborted afterwards, and the call carries a signal', async () => {
    const r = wired();
    fire(r, 'wheel', wheel());
    await r.clk.advance(0);
    assert.equal(r.log.signals.length, 1);
    assert.equal(r.log.signals[0] instanceof AbortSignal, true);
    await r.clk.advance(60000);
    assert.equal(r.log.signals[0].aborted, false);
  });

  test('(−) the limit is an AbortController with a timer, not AbortSignal.timeout (missing in older macOS web views); the signal goes to appFetch through call', () => {
    const fn = fnOf('function scrollCall(body)');
    assert.doesNotMatch(fn, /AbortSignal\.timeout/);
    assert.match(fn, /new AbortController\(\)/);
    assert.match(fn, /setTimeout\(\(\) => ctl\.abort\(\), 10000\)/);
    assert.match(fn, /signal: ctl\.signal/);
    assert.match(fn, /\.finally\(\(\) => clearTimeout\(timer\)\)/);
  });

  // -- the corner note and Jump to live
  test('(+) a scrolled-up view: the note has data-k="scrolled", the i-up icon and the words, Jump to live shows, and it is announced once', () => {
    const r = rig();
    r.scrollCaptured({ alt: true, scrolled: true });
    assert.equal(r.note.hidden, false);
    assert.equal(r.note.getAttribute('data-k'), 'scrolled');
    assert.equal(r.note.kids.length, 2);
    assert.equal(r.note.kids[0].kids[0].getAttribute('href'), '#i-up');
    assert.equal(r.note.kids[1].textContent, "Scrolled up in Claude's view");
    assert.equal(r.jump.hidden, false);
    assert.deepEqual(r.log.said, ["Scrolled up in Claude's view. Jump to live returns to the bottom."]);
    r.scrollCaptured({ alt: true, scrolled: true });
    r.scrollCaptured({ alt: true, scrolled: true });
    assert.equal(r.log.said.length, 1, 'the same state again says nothing');
  });

  test('(+) back at the bottom: the note and Jump to live are hidden, announced once', () => {
    const r = rig();
    r.scrollCaptured({ alt: true, scrolled: true });
    r.scrollCaptured({ alt: true, scrolled: false });
    assert.equal(r.note.hidden, true);
    assert.equal(r.note.getAttribute('data-k'), null);
    assert.equal(r.note.kids.length, 0);
    assert.equal(r.jump.hidden, true);
    assert.equal(r.log.said.at(-1), 'Back at the live bottom.');
    assert.equal(r.log.said.length, 2);
    r.scrollCaptured({ alt: true, scrolled: false });
    assert.equal(r.log.said.length, 2);
  });

  test('(−) a pill without the full-screen view, or a missing or odd field, is not "scrolled", and a fresh page says nothing', () => {
    const r = rig();
    for (const body of [{ alt: false, scrolled: true }, { scrolled: true }, { alt: true }, { alt: true, scrolled: 'true' }, { alt: true, scrolled: 1 }, {}]) r.scrollCaptured(body);
    assert.equal(r.ctx.SC.scrolled, false);
    assert.deepEqual(r.log.said, []);
    assert.equal(r.note.hidden, true);
    assert.equal(r.jump.hidden, true);
  });

  test('(+) nika\'s own Paused keeps its words and gains the pause icon, with its own data-k; Jump to live shows; the header says Paused as before', () => {
    const r = rig();
    r.setFrozen(true);
    assert.equal(r.note.hidden, false);
    assert.equal(r.note.getAttribute('data-k'), 'paused');
    assert.equal(r.note.kids[0].kids[0].getAttribute('href'), '#i-pause');
    assert.equal(r.note.kids[1].textContent, 'Paused while you scroll');
    assert.equal(r.jump.hidden, false);
    assert.deepEqual(r.log.lives, [['paused', 'Paused - 120 x 36']]);
    r.setFrozen(true);
    assert.equal(r.log.lives.length, 1, 'no change, no redraw');
    r.setFrozen(false);
    assert.equal(r.note.hidden, true);
    assert.equal(r.jump.hidden, true);
    assert.deepEqual(r.log.lives.at(-1), ['live', 'Live - 120 x 36']);
    assert.deepEqual(r.log.kicks, [0], 'leaving Paused kicks the mirror, as today');
    assert.deepEqual(r.log.said, [], 'Paused is not announced (unchanged)');
  });

  test('(+) both at once: the note says Claude\'s view is scrolled, the header says Paused, and ending Paused keeps the note and Jump to live', () => {
    const r = rig();
    r.setFrozen(true);
    r.scrollCaptured({ alt: true, scrolled: true });
    assert.equal(r.note.getAttribute('data-k'), 'scrolled');
    assert.equal(r.jump.hidden, false);
    assert.deepEqual(r.log.lives, [['paused', 'Paused - 120 x 36']]);
    r.setFrozen(false);
    assert.equal(r.note.getAttribute('data-k'), 'scrolled');
    assert.equal(r.jump.hidden, false, 'Claude\'s view is still up');
    r.scrollCaptured({ alt: true, scrolled: false });
    assert.equal(r.jump.hidden, true);
    assert.equal(r.note.hidden, true);
  });

  test('(+) Jump to live while Claude is scrolled posts { to: "bottom" }, returns the mirror to its bottom and first column, and focuses the message box', () => {
    const r = wired({ box: { top: 120, height: 1000, client: 400 } });
    r.scrollCaptured({ alt: true, scrolled: true });
    r.setFrozen(true);
    r.jumpToLive();
    assert.deepEqual(calls(r), [POST({ to: 'bottom' })]);
    assert.equal(r.term.scrollTop, 1000);
    assert.equal(r.term.scrollLeft, 0);
    assert.equal(r.ctx.M.etag, null);
    assert.deepEqual(r.log.focus, ['composer']);
    assert.equal(r.ctx.M.frozen, false);
    assert.equal(r.jump.hidden, false, 'it stays while Claude stays scrolled; the route\'s answer or the next capture hides it');
  });

  test('(+) Jump to live while only nika is Paused behaves as today: no request', () => {
    const r = wired({ box: { top: 120, height: 1000, client: 400 } });
    r.setFrozen(true);
    r.jumpToLive();
    assert.deepEqual(calls(r), []);
    assert.equal(r.term.scrollTop, 1000);
    assert.equal(r.ctx.M.frozen, false);
    assert.equal(r.jump.hidden, true);
    assert.deepEqual(r.log.focus, ['composer']);
  });

  test('(+) a refusal on Jump to live shows its line and the button stays while Claude stays scrolled', async () => {
    const r = wired({ replies: [{ status: 409, body: { error: 'screen-unclear' } }] });
    r.scrollCaptured({ alt: true, scrolled: true });
    r.jumpToLive();
    await r.clk.advance(0);
    assert.equal(r.log.problems[0][0], refusalLineReal({ status: 409, code: 'screen-unclear' }));
    assert.equal(r.jump.hidden, false);
    assert.equal(r.ctx.SC.scrolled, true);
  });

  test('(+) the route says Claude is back at the bottom: the note and the button go away at once, announced once, and the next capture agrees', async () => {
    const r = wired({ replies: [{ status: 200, body: { sent: 1, scrolled: false } }] });
    r.scrollCaptured({ alt: true, scrolled: true });
    r.jumpToLive();
    await r.clk.advance(0);
    assert.equal(r.jump.hidden, true);
    assert.equal(r.note.hidden, true);
    r.scrollCaptured({ alt: true, scrolled: false });
    assert.deepEqual(r.log.said, ["Scrolled up in Claude's view. Jump to live returns to the bottom.", 'Back at the live bottom.']);
  });

  // -- fix round 1
  test('(−) fix round 1, M1a/b: Jump to live sends nothing while the pane is gone or the connection is lost, but still does everything native (bottom, column 0, Live, focus)', async () => {
    for (const flag of ['gone', 'fatal']) {
      const r = wired({ box: { top: 120, height: 1000, client: 400 } });
      r.scrollCaptured({ alt: true, scrolled: true });
      r.setFrozen(true);
      r.ctx.M[flag] = true;
      r.jumpToLive();
      await r.clk.advance(1000);
      assert.deepEqual(calls(r), [], `${flag}: no request`);
      assert.deepEqual(norm(r.log.problems), [], `${flag}: and so no "nika did not answer."`);
      assert.equal(r.term.scrollTop, 1000, flag);
      assert.equal(r.term.scrollLeft, 0, flag);
      assert.equal(r.ctx.M.frozen, false, flag);
      assert.deepEqual(r.log.focus, ['composer'], flag);
    }
  });

  test('(+) fix round 1, M2: End in the mirror returns to column 0 like the button, still sends { to: "bottom" } and never moves focus; the other keys leave the column alone', () => {
    const end = wired();
    assert.equal(end.term.scrollLeft, 5);
    fire(end, 'keydown', key('End'));
    assert.equal(end.term.scrollLeft, 0);
    assert.deepEqual(calls(end), [POST({ to: 'bottom' })]);
    assert.deepEqual(end.log.focus, []);
    const ctrlEnd = wired();
    fire(ctrlEnd, 'keydown', key('End', { ctrlKey: true }));
    assert.equal(ctrlEnd.term.scrollLeft, 0);
    for (const k of ['Home', 'PageUp', 'PageDown']) {
      const r = wired();
      fire(r, 'keydown', key(k));
      assert.equal(r.term.scrollLeft, 5, k);
    }
  });

  test('(−) fix round 1, M2: End where the browser scrolls first (the mirror is not at its bottom) leaves everything to the browser, column included', () => {
    const r = wired({ box: { top: 0, height: 1000, client: 400 } });
    assert.equal(fire(r, 'keydown', key('End')).defaultPrevented, false);
    assert.equal(r.term.scrollLeft, 5);
    assert.deepEqual(calls(r), []);
  });

  // -- the hooks, where the design puts them
  test('(+) the hooks sit where the design puts them: S3 handleCapture, S4 setFrozen, S5 jumpToLive, S6 setGone, the 403 branch and wireTerminal', () => {
    assert.match(SRC, /try \{\s*fitCaptured\(\);\s*\} catch \{[^}]*\}\s*try \{\s*scrollCaptured\(r\.body\);\s*\} catch \{[^}]*\}\s*if \(!M\.frozen\) term\.scrollTop = term\.scrollHeight;/);
    assert.match(fnOf('function setFrozen(on)'), /M\.frozen = on;\s*renderNote\(\);/);
    assert.doesNotMatch(fnOf('function setFrozen(on)'), /\.hidden = /, 'renderNote owns both elements now');
    assert.match(fnOf('function jumpToLive()'), /if \(SC\.scrolled && !M\.gone && !M\.fatal\) SC\.planner\?\.jump\('bottom'\);\s*setFrozen\(false\);/);
    assert.match(fnOf('function setGone()'), /M\.gone = true;[\s\S]*SC\.planner\?\.close\(\);/);
    assert.match(SRC, /if \(r\.status === 403\) \{\s*M\.fatal = true;\s*clearTimeout\(M\.timer\);\s*SC\.planner\?\.close\(\);/);
    assert.match(fnOf('function wireTerminal()'), /wireScroll\(\);/);
    assert.match(SRC, /import \{[^}]*\} from '\.\/scroll\.js';/);
  });

  test('(+) closing the planner (what the 403 branch of handleCapture does) stops queued pages from going', async () => {
    const r = wired();
    fire(r, 'wheel', wheel()); // in flight
    fire(r, 'wheel', wheel({ deltaY: 144 * 3 })); // queued
    r.ctx.SC.planner.close();
    await r.clk.advance(1000);
    assert.equal(r.log.calls.length, 1);
  });

  test('(−) the page writes with h() text and the sprite only: no markup sink anywhere in the scroll code, and the note sets its attributes through setAttribute', () => {
    const body = NAMES.map(fnOf).join('\n');
    assert.deepEqual(findSinks(body), []);
    assert.match(fnOf('function renderNote()'), /h\('span', \{ text: v\.note\.text \}\)/);
    assert.match(fnOf('function renderNote()'), /setAttribute\('data-k', v\.note\.kind\)/);
    assert.doesNotMatch(body, /\.style\b|innerText/);
  });

  test('(+) the only route the scroll code calls is POST .../scroll, with a body that names a direction and a count or an end, never a key', () => {
    const src = `${fnOf('function scrollCall(body)')}${fnOf('function scrollKey(e)')}${fnOf('function wireScroll()')}`;
    assert.deepEqual([...src.matchAll(/\/api\/[^`'"]*/g)].map((m) => m[0]), ['/api/app/pane/${encodeURIComponent(paneId)}/scroll']);
    assert.match(src, /method: 'POST', json: body/);
    assert.doesNotMatch(src, /PPage|NPage|C-Home|C-End|keys:/);
  });

  // ---- F10 (design F10 4.5): a scroll request waits for the redraw hold; the server's gate still decides ---------------------------------------
  const tick = () => new Promise((resolve) => { setImmediate(resolve); });

  test('(+) F10: a wheel during the hold sends its scroll request only after the hold ends', async () => {
    const r = wired({ hold: true });
    r.ctx.HOLD.start({ want: { cols: 120, rows: 36 }, plainBefore: true });
    fire(r, 'wheel', wheel());
    await tick();
    assert.deepEqual(calls(r), [], 'held');
    r.ctx.HOLD.end();
    await tick();
    assert.deepEqual(calls(r), [POST({ dir: 'down', pages: 1 })]);
  });

  test('(+) F10: the hold timing out releases the request too (no box came back: the server decides, and its 409 shows the new words)', async () => {
    const r = wired({ hold: true, replies: [{ status: 409, body: { error: 'screen-unclear' } }] });
    r.ctx.HOLD.start({ want: { cols: 120, rows: 36 }, plainBefore: true });
    fire(r, 'wheel', wheel());
    await r.clk.advance(HOLD_MS_REAL - 1);
    assert.deepEqual(calls(r), []);
    await r.clk.advance(1);
    assert.deepEqual(calls(r), [POST({ dir: 'down', pages: 1 })]);
    assert.deepEqual(norm(r.log.problems), [["Claude's input box isn't on screen (a dialog or menu may be open), so nika doesn't send scroll keys. Close it first, or scroll in the terminal.", 'warn', 3000]]);
  });

  test('(+) F10: PgDn and End wait the same way: the request already asked for goes first, then the jump, both after the hold', async () => {
    const r = wired({ hold: true });
    r.ctx.HOLD.start({ want: { cols: 120, rows: 36 }, plainBefore: true });
    fire(r, 'keydown', key('PageDown'));
    fire(r, 'keydown', key('End'));
    await tick();
    assert.deepEqual(calls(r), []);
    r.ctx.HOLD.end();
    await r.clk.advance(0);
    await r.clk.advance(100);
    assert.deepEqual(calls(r), [POST({ dir: 'down', pages: 1 }), POST({ to: 'bottom' })]);
  });

  test('(−) F10: without a hold the request goes at once, in the same tick (nothing is delayed)', () => {
    const r = wired({ hold: true });
    fire(r, 'wheel', wheel());
    assert.deepEqual(calls(r), [POST({ dir: 'down', pages: 1 })]);
  });

  test('(−) F10: a pane that is gone by the time the hold ends gets no request', async () => {
    const r = wired({ hold: true });
    r.ctx.HOLD.start({ want: { cols: 120, rows: 36 }, plainBefore: true });
    fire(r, 'wheel', wheel());
    r.ctx.M.gone = true;
    r.ctx.HOLD.end();
    await tick();
    assert.deepEqual(calls(r), []);
  });
});

describe('W1-T3: question dialogs and plan approvals in the session window (hooks P1-P6, markup, stylesheet)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const mk = (names, ctx) => vm.runInNewContext(`${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const norm = (v) => JSON.parse(JSON.stringify(v));
  const SIG = 'a1b2c3d4e5f60718';
  const RAW = {
    state: 'ready', kind: 'ask', at: 'question', sig: SIG, bypass: false, tabs: [{ header: 'Tools', answered: false }], current: 0, final: true, question: 'Which database should I use?',
    multi: false, other: true, options: [{ n: 1, label: 'sqlite', description: null }, { n: 2, label: 'postgres', description: null }],
  };
  const el = (over = {}) => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; }, ...over });

  // -- the static list

  test('(+) /dialog-form.js is served: next to /attach.js on the static list, as JavaScript, and the file exists (else session.js\'s import 404s and the whole window breaks)', () => {
    const server = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js'), 'utf8');
    assert.match(server, /\['\/dialog-form\.js', \['dialog-form\.js', 'text\/javascript; charset=utf-8'\]\]/);
    assert.ok(server.indexOf("'/attach.js'") < server.indexOf("'/dialog-form.js'"));
    assert.ok(fs.existsSync(path.join(PUBLIC, 'dialog-form.js')));
  });

  // -- P1 and the declaration

  test('(+) P1: session.js imports createDialogForm and cleanDialog from ./dialog-form.js, after the attachments, and builds nothing at import', () => {
    assert.match(JS['session.js'], /import \{ createDialogForm, cleanDialog \} from '\.\/dialog-form\.js';/);
    assert.ok(JS['session.js'].indexOf("from './attach.js'") < JS['session.js'].indexOf("from './dialog-form.js'"));
    assert.match(SRC, /^let DF = null;/m, 'the form is built in boot, beside the quick actions');
  });

  test('(−) the hooks are exactly P2 to P6 and the Shift+Tab wording line: past its declaration, DF is named in renderMode, renderAttn, sendComposer, wireComposer (that one line) and boot, and nowhere else', () => {
    const body = SRC.replace(/^let DF = null;.*$/m, '');
    const places = [...body.matchAll(/\bDF\b/g)].map((m) => [...body.slice(0, m.index).matchAll(/\n(?:async )?function (\w+)\(/g)].at(-1)?.[1]);
    assert.deepEqual(places, ['renderMode', 'renderAttn', 'sendComposer', 'wireComposer', 'boot']);
    assert.equal((fnOf('function wireComposer()').match(/\bDF\b/g) ?? []).length, 1, 'wireComposer: the one wording line');
  });

  // -- P2: noteScreen

  const screenRig = () => {
    const log = { renders: 0 };
    const W = { pane: 'connecting', got: false, mode: 'unknown', confirmed: true, prompt: null, promptOpen: false, dialog: null, last: null, struck: new Set(), strikeAt: null };
    const ctx = {
      W, SW: { busy: null }, A: { name: 'builder-1' }, modeKey: (m) => m ?? 'unknown', cleanPrompt: cleanPromptReal, cleanDialog: cleanDialogReal,
      modeNote: () => ({ last: null, msg: '' }), announceMode() {}, renderMode: () => { log.renders += 1; },
    };
    return { W, log, note: mk(['function noteScreen(body)'], ctx).noteScreen };
  };

  test('(+) P2: a capture with a ready dialog sets W.dialog and counts as a prompt for every gate, with no permission panel', () => {
    const r = screenRig();
    r.note({ mode: 'default', prompt: null, dialog: RAW });
    assert.equal(r.W.dialog.state, 'ready');
    assert.equal(r.W.dialog.sig, SIG);
    assert.equal(r.W.promptOpen, true);
    assert.equal(r.W.prompt, null);
    assert.equal(r.log.renders, 1);
  });

  test('(+) P2: an unreadable dialog counts as a prompt too (the banner shows and Send stays gated)', () => {
    const r = screenRig();
    r.note({ mode: 'default', prompt: null, dialog: { state: 'unreadable', kind: 'ask', reason: 'wide' } });
    assert.equal(r.W.dialog.state, 'unreadable');
    assert.equal(r.W.promptOpen, true);
  });

  test('(−) P2: no dialog and no prompt is not a prompt; a permission prompt alone still is, and carries no dialog', () => {
    const r = screenRig();
    r.note({ mode: 'default', prompt: null, dialog: null });
    assert.equal(r.W.dialog, null);
    assert.equal(r.W.promptOpen, false);
    r.note({ mode: 'default', prompt: { question: 'Proceed?', sig: SIG, options: [{ n: 1, label: 'Yes' }] } });
    assert.equal(r.W.dialog, null, 'an older server has no dialog field at all');
    assert.equal(r.W.promptOpen, true);
    assert.notEqual(r.W.prompt, null);
  });

  test('(−) P2: a dialog field that is not the contract fails closed (unreadable), never to a form and never to "no dialog"', () => {
    for (const bad of ['dialog', 7, [], { state: 'ready', sig: 'x' }, { state: 'ready', kind: 'ask', at: 'question', sig: SIG, options: 'x' }]) {
      const r = screenRig();
      r.note({ mode: 'default', prompt: null, dialog: bad });
      assert.equal(r.W.dialog.state, 'unreadable', JSON.stringify(bad));
      assert.equal(r.W.promptOpen, true, JSON.stringify(bad));
    }
  });

  // -- P3: renderMode

  test('(+) P3: renderMode draws the form after the prompt panel, with the pane, the dialog, the name and the attention reason', () => {
    const order = [];
    let args = null;
    const stub = (n) => () => { order.push(n); };
    const ctx = {
      paneId: '%12', SW: { parts: [{}], busy: null }, W: { pane: 'ok', dialog: 'D', mode: 'default', confirmed: true, msg: null, promptOpen: true },
      A: { kind: 'attn', name: 'builder-1', attention: 'Claude has a question' }, switcherState: () => ({ reason: '' }),
      renderTag: stub('tag'), renderSegments: stub('segments'), renderWhy: stub('why'), renderQuick: stub('quick'), renderAttn: stub('attn'), renderPrompt: stub('prompt'),
      DF: { render: (a) => { order.push('form'); args = a; } },
    };
    mk(['function renderMode()'], ctx).renderMode();
    assert.deepEqual(order, ['tag', 'segments', 'why', 'quick', 'attn', 'prompt', 'form']);
    assert.deepEqual(norm(args), { pane: 'ok', dialog: 'D', name: 'builder-1', attention: 'Claude has a question' });
  });

  test('(−) P3: before the form exists (no pane, or boot not done) renderMode draws no form and does not fail', () => {
    const ctx = {
      paneId: '%12', SW: { parts: [{}], busy: null }, W: { pane: 'ok', mode: 'default', confirmed: true, msg: null }, A: { kind: 'idle', name: 'x', attention: '' }, switcherState: () => ({ reason: '' }),
      renderTag() {}, renderSegments() {}, renderWhy() {}, renderQuick() {}, renderAttn() {}, renderPrompt() {}, DF: null,
    };
    assert.doesNotThrow(() => mk(['function renderMode()'], ctx).renderMode());
  });

  // -- P4: renderAttn

  const attnRig = ({ form, prompt = null, pane = 'ok', kind = 'attn' }) => {
    const note = { hidden: true };
    const ctx = {
      $: (id) => (id === 'attn-note' ? note : { textContent: '' }), DF: form === undefined ? null : form, W: { pane, prompt }, A: { kind, name: 'builder-1', attention: 'Claude has a question' },
      attnNote: attnNoteReal, passKeyLabel, MAC: false,
    };
    mk(['function renderAttn()'], ctx).renderAttn();
    return note;
  };

  test('(+) P4: the attention note is hidden while the dialog form shows', () => {
    assert.equal(attnRig({ form: { shown: () => true } }).hidden, true);
  });

  test('(−) P4: with no form shown (reading is over, unreadable, or no DF) the note shows for a Needs-you agent, as before', () => {
    assert.equal(attnRig({ form: { shown: () => false } }).hidden, false);
    assert.equal(attnRig({ form: null }).hidden, false);
    assert.equal(attnRig({ form: { shown: () => true }, kind: 'idle' }).hidden, true, 'and never for an agent that is not asking');
    assert.equal(attnRig({ form: { shown: () => true }, pane: 'tmux' }).hidden, false, 'a form of a pane that is not ok does not hide the note');
  });

  // -- P5: the Send gate

  const GATE = 'Answer the prompt with the buttons above or in the terminal.';
  const NO_BUTTONS = 'Answer the prompt in the terminal, or turn on Type into pane.';
  const sendRig = ({ form = null, prompt = null, att = { pending: () => false } } = {}) => {
    const log = Object.assign(sendLog(), { problems: [], atts: [] });
    const ta = { value: 'hello', disabled: false };
    const ctx = {
      sending: false, composer: () => ta, DF: form, S: { on: false }, W: { promptOpen: true, prompt, pane: 'ok' }, A: { kind: 'attn' }, M: { cols: 120, gone: false },
      sendGate: sendGateReal, hasAnswerButtons: hasAnswerButtonsReal, planShell: planShellReal, planSend: planSendReal, draftSendPlan: draftSendPlanReal,
      showProblem: (m, k) => log.problems.push([m, k]), $: () => el(), say() {}, paneId: '%12', setShell() {}, grow() {}, updateChip() {},
      DS: { screen: () => null, beginSend() {}, endSend() {}, sent() {}, submitted() {} },
      ATT: { pending: att.pending, send: (v) => { log.atts.push(v); } },
      ...sendIo(log),
    };
    return { log, ta, ctx, send: mk(SEND_FUNCS, ctx).sendComposer };
  };

  test('(+) P5: with a dialog form on screen, Send names the buttons above, as an error, and sends nothing; the text stays', async () => {
    const r = sendRig({ form: { live: () => true } });
    await r.send();
    assert.deepEqual(r.log.problems, [[GATE, 'error']]);
    assert.deepEqual(r.log.sent, []);
    assert.equal(r.ta.value, 'hello');
  });

  test('(−) P5: the gate still blocks Send while a dialog shows whatever the form is: unreadable (no form), terminal only, no DF', async () => {
    for (const form of [null, { live: () => false }]) {
      const r = sendRig({ form });
      await r.send();
      assert.deepEqual(r.log.problems, [[NO_BUTTONS, 'error']], JSON.stringify(form));
      assert.deepEqual(r.log.sent, []);
    }
  });

  test('(−) P5: attachments do not get past it: with chips pending and a dialog open, ATT.send is not called', async () => {
    const r = sendRig({ form: { live: () => true }, att: { pending: () => true } });
    await r.send();
    assert.deepEqual(r.log.atts, []);
    assert.deepEqual(r.log.sent, []);
  });

  test('(+) P5: without a dialog or prompt the gate is open as before (the hook changes only the wording)', async () => {
    const log = sendLog();
    const ta = { value: 'hello', disabled: false };
    const ctx = {
      sending: false, composer: () => ta, DF: null, S: { on: false }, W: { promptOpen: false, prompt: null, pane: 'ok', mode: 'default', confirmed: true }, A: { kind: 'idle' }, M: { cols: 120, gone: false },
      sendGate: sendGateReal, hasAnswerButtons: hasAnswerButtonsReal, planShell: planShellReal, planSend: planSendReal, draftSendPlan: draftSendPlanReal,
      showProblem() {}, $: () => el(), say() {}, paneId: '%12', setShell() {}, grow() {}, updateChip() {},
      DS: { screen: () => null, beginSend() {}, endSend() {}, sent() {}, submitted() {} }, ATT: { pending: () => false },
      ...sendIo(log),
    };
    await mk(SEND_FUNCS, ctx).sendComposer();
    assert.equal(log.sent.length, 2, 'the text, then the guarded Enter');
  });

  test('(−) scroll keys stay refused while a dialog shows: the capture has no readable input box, so the page\'s gate answers "a dialog or menu is open"', () => {
    const body = { alt: true, prompt: null, dialog: RAW, rows: [], cols: 120 };
    assert.equal(scrollGateReal(body, null), 'screen-unclear');
    assert.equal(scrollGateReal({ ...body, dialog: null }, null), 'screen-unclear', 'the draft, not the dialog field, decides: the server sends no draft under a dialog');
    assert.match(fnOf('function scrollOpen()'), /scrollGate\(M\.body, M\.draft\)/);
  });

  // -- P6: boot

  test('(+) P6: boot builds the form right after the switcher, the quick actions and the fit are wired, with the io the module asks for and the one route tail built here', () => {
    const boot = fnOf('function boot()');
    assert.match(boot, /wireSwitcher\(\);\s*wireQuick\(\);\s*wireFit\(\);\s*DF = createDialogForm\(\{ root: \$\('dialog-form'\), paneId, call, path: \(tail\) => `\/api\/app\/pane\/\$\{encodeURIComponent\(paneId\)\}\/\$\{tail\}`, announce, say, showProblem, clearProblem, setGone, composer, refresh: renderAttn \}\);/);
    assert.ok(boot.indexOf('DF = createDialogForm') > boot.indexOf('if (paneId) {'), 'only with a pane');
  });

  // -- markup

  const tagOf = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';

  test('(+) #dialog-form is a hidden group in the composer, after the permission panel and before the attachment tray and the message box', () => {
    const t = tagOf('dialog-form');
    assert.match(t, /^<div class="ask dlg"/);
    assert.match(t, /role="group"/);
    assert.match(t, /aria-labelledby="dlg-q"/);
    assert.match(t, /\bhidden\b/);
    assert.doesNotMatch(t, /\sstyle=|aria-live|role="(status|alert|log)"/);
    const at = (needle) => HTML.indexOf(needle);
    assert.ok(at('id="prompt-btns"') < at('id="dialog-form"') && at('id="dialog-form"') < at('id="att-tray"') && at('id="att-tray"') < at('<div class="inbox">'));
    assert.ok(at('id="dialog-form"') > at('id="composer-box"'), 'inside the composer');
    assert.ok(at('id="dialog-form"') < at('id="shell-toggle"'), 'tab order: the form comes before the Shell toggle and the message box');
  });

  test('(+) the sprite has i-check, and every icon dialog-form.js draws is in it', () => {
    const symbols = new Set([...HTML.matchAll(/<symbol id="i-([a-z-]+)"/g)].map((m) => m[1]));
    assert.ok(symbols.has('check'));
    const used = [...code(JS['dialog-form.js']).matchAll(/icon\('([a-z-]+)'\)|icon: '([a-z-]+)'|icon\(kind === 'plan' \? '([a-z-]+)' : '([a-z-]+)'\)/g)].flatMap((m) => m.slice(1).filter(Boolean));
    assert.ok(used.length >= 8, 'the scan found the icons');
    assert.deepEqual([...new Set(used)].filter((n) => !symbols.has(n)), []);
  });

  test('(+) the permission panel header gains the kind tag: the warning icon and the word Permission, in the attention colour', () => {
    const header = /<div class="ask-h">[\s\S]*?<\/div>/.exec(HTML.slice(HTML.indexOf('id="prompt-btns"')))[0];
    assert.match(header, /<span class="dlg-kind" data-k="perm"><svg class="ic" aria-hidden="true"><use href="#i-warn"\/><\/svg>Permission<\/span>/);
    assert.match(header, /Needs you/);
    assert.match(header, /id="ask-reason"/);
    assert.match(strip(CSS), /\.dlg-kind\[data-k="perm"\]\s*\{[^}]*color:\s*var\(--attn\)/);
  });

  // -- stylesheet

  const START = CSS.indexOf('/* question dialogs (0.5, W1)');
  const BLOCK = strip(CSS.slice(START));

  test('(+) the form rules are appended at the end of session.css', () => {
    assert.ok(START > 0);
    assert.ok(START > CSS.indexOf('.att-drop'), 'after the attachment rules');
  });

  test('(+) the form scrolls inside itself, so the mirror keeps its height: max-height min(45vh, 420px)', () => {
    assert.match(BLOCK, /\.ask\.dlg\s*\{[^}]*max-height:\s*min\(45vh,\s*420px\)[^}]*overflow-y:\s*auto/);
  });

  test('(+) every state has its own colour pair: reading ended (the base chip rule), answering accent, answered busy, failed danger, terminal only a dashed edge with no fill', () => {
    const rule = (s) => new RegExp(`\\.dlg-chip\\[data-s="${s}"\\]\\s*\\{([^}]*)\\}`).exec(BLOCK)?.[1] ?? '';
    assert.match(/\.dlg-chip\s*\{([^}]*)\}/.exec(BLOCK)?.[1] ?? '', /color:\s*var\(--ended\)[^}]*background:\s*var\(--ended-soft\)/, 'the base rule is the Reading chip');
    assert.match(rule('answering'), /color:\s*var\(--accent\)[^}]*background:\s*var\(--accent-soft\)/);
    assert.match(rule('answered'), /color:\s*var\(--busy\)[^}]*background:\s*var\(--busy-soft\)/);
    assert.match(rule('failed'), /color:\s*var\(--danger\)[^}]*background:\s*var\(--danger-soft\)/);
    assert.match(rule('terminal'), /color:\s*var\(--text-muted\)[^}]*background:\s*transparent[^}]*border:\s*1px dashed var\(--line-strong\)/);
    assert.match(BLOCK, /\.dlg-kind\[data-k="plan"\]\s*\{[^}]*color:\s*var\(--m-plan\)/);
  });

  test('(+) a ticked row has the accent fill and edge; the narrow composer swaps the tabs for the step text', () => {
    assert.match(BLOCK, /\.ch\[data-on="true"\]\s*\{[^}]*background:\s*var\(--accent-soft\)[^}]*border-color:\s*var\(--accent\)/);
    assert.match(BLOCK, /@container composer \(max-width:\s*560px\)\s*\{[^@]*\.dlg-tabs\s*\{[^}]*display:\s*none[^}]*\}[^@]*\.dlg-step\s*\{[^}]*display:\s*block/);
    assert.match(BLOCK, /\.dlg-step\s*\{[^}]*display:\s*none/, 'hidden where the tabs show');
  });

  test('(+) the option rows share the permission buttons\' metrics (32 px, line-strong edge, surface fill) and a description is clamped to 3 lines', () => {
    assert.match(BLOCK, /\.ch\s*\{[^}]*min-height:\s*32px[^}]*border:\s*1px solid var\(--line-strong\)[^}]*background:\s*var\(--surface\)/);
    assert.match(BLOCK, /\.dlg-desc\.clamp\s*\{[^}]*-webkit-line-clamp:\s*3/);
    assert.match(BLOCK, /\.dlg-warn\s*\{[^}]*background:\s*var\(--idle-soft\)[^}]*color:\s*var\(--idle\)/);
  });

  test('(+) the spinner stops for reduced motion', () => {
    assert.match(BLOCK, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.dlg-chip \.spin\s*\{[^}]*animation:\s*none/);
  });

  test('(−) no rule repeats another: the Reading chip has no rule of its own (the base chip is that look), every other state differs from it, no selector is written twice', () => {
    assert.doesNotMatch(BLOCK, /\.dlg-chip\[data-s="reading"\]/);
    const base = /\.dlg-chip\s*\{([^}]*)\}/.exec(BLOCK)[1];
    for (const state of ['terminal', 'answering', 'answered', 'failed']) {
      const own = new RegExp(`\\.dlg-chip\\[data-s="${state}"\\]\\s*\\{([^}]*)\\}`).exec(BLOCK)[1];
      assert.match(own, /color:\s*var\(--(?!ended\b)/, `${state} has its own colour, not the base one`);
      assert.notEqual(own.trim(), base.trim());
    }
    const top = strip(BLOCK).replace(/@[a-z-]+[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ''); // the @container and @media blocks restate selectors on purpose
    const sels = [...top.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].map((m) => m[1].trim());
    assert.ok(sels.length > 40, 'the scan found the selectors');
    assert.deepEqual(sels.filter((x, i) => sels.indexOf(x) !== i), [], 'no selector is written twice');
  });

  test('(+) the link button is the shared one: no .btn.link rule in session.css, the More button keeps only its own size, and tokens.css still draws a link button', () => {
    assert.doesNotMatch(strip(CSS), /\.btn\.link/);
    assert.match(BLOCK, /\.dlg-more\s*\{[^}]*justify-self:\s*start[^}]*min-height:\s*24px[^}]*padding:\s*0 4px[^}]*font-size:\s*var\(--fs-small\)/);
    assert.doesNotMatch(/\.dlg-more\s*\{([^}]*)\}/.exec(BLOCK)[1], /background|color:|text-decoration/, 'colour and underline come from tokens.css');
    const link = /\.btn\.link\s*\{([^}]*)\}/.exec(strip(TOKENS))?.[1] ?? '';
    assert.match(link, /border-color:\s*transparent[^}]*background:\s*transparent[^}]*color:\s*var\(--accent\)[^}]*text-decoration:\s*underline/);
    assert.match(strip(TOKENS), /\.btn\.link:hover\s*\{[^}]*background:\s*var\(--surface-3\)/);
    assert.match(JS['dialog-form.js'], /class: 'btn link dlg-more'/, 'the More button carries all three classes');
  });

  test('(+) an inert form dims its option rows from data-inert, which paint() sets: answering, answered, terminal only, kept and locked all look the same', () => {
    assert.match(BLOCK, /\.dlg\[data-inert="true"\] \.ch\s*\{[^}]*opacity:\s*0\.6[^}]*cursor:\s*not-allowed/);
    assert.match(BLOCK, /\.dlg\[data-inert="true"\] \.ch:not\(\[data-on="true"\]\):hover\s*\{[^}]*background:\s*var\(--surface\)/, 'no hover tint on a row that ignores the click');
    assert.match(code(JS['dialog-form.js']), /root\.setAttribute\('data-inert', String\(!live\)\)/);
  });

  test('(−) the dimming no longer hangs on the chip state (a locked failure and a kept form have none of their own), and a live row keeps its hover', () => {
    assert.doesNotMatch(BLOCK, /\.dlg\[data-s="(answering|answered|terminal)"\] \.ch/);
    assert.match(BLOCK, /\.ch:hover\s*\{[^}]*background:\s*var\(--surface-2\)/);
  });

  test('(+) the warn line under the text field uses the existing warn style, with the warning icon and its fixed words', () => {
    assert.match(BLOCK, /\.dlg-warn\s*\{[^}]*background:\s*var\(--idle-soft\)[^}]*color:\s*var\(--idle\)[^}]*font-weight:\s*600/);
    assert.doesNotMatch(BLOCK, /dlg-lead/, 'no second style for it');
    assert.match(code(JS['dialog-form.js']), /h\('p', \{ class: 'dlg-warn', id: 'dlg-lead', hidden: true \}, icon\('warn'\), h\('span', \{ text: LEAD_NOTE \}\)\)/);
  });

  test('(+) the scrolling form is a containing block (position set), as the stylesheet-wide guard demands', () => {
    assert.match(BLOCK, /\.ask\.dlg\s*\{[^}]*position:\s*relative/);
  });

  test('(−) tokens only: every var() in the block is a token of tokens.css (no local custom property), and there is no colour literal', () => {
    const defined = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    assert.deepEqual([...BLOCK.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]), [], 'the block declares no custom property');
    const used = [...BLOCK.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(used.length > 40, 'the scan found the variables');
    assert.deepEqual([...new Set(used)].filter((n) => !defined.has(n)), []);
    assert.doesNotMatch(BLOCK, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|:has\(|@import|url\(/);
  });
});

// ---- 0.5, W8-T3: the session window's list of Claude's subagents, the read-only subagent view, the link from the parent's transcript ----

describe('W8-T3: the subagent list and the read-only subagent view (design W8, 4.3 to 4.10)', () => {
  const SRC = code(JS['session.js']);
  const css = strip(CSS);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  const lineOf = (re) => {
    const m = re.exec(SRC);
    assert.ok(m, String(re));
    return m[0];
  };
  const constOf = (name) => lineOf(new RegExp(`const ${name} = [^\\n]*`));
  const mk = (names, ctx, pre = '') => vm.runInNewContext(`${pre}\n${names.map(fnOf).join('\n')}; ({ ${names.map((n) => n.replace(/^(async )?function /, '').replace(/\(.*$/, '')).join(', ')} })`, ctx);
  const norm = (v) => JSON.parse(JSON.stringify(v));
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });
  const tagOf = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';

  // synthetic ids only: the repeated-digit UUIDs of the other tests, a 17-hex subagent id like Claude's, an easy second one
  const S = '11111111-1111-4111-8111-111111111111';
  const KEY = '0123456789abcdef';
  const AG = 'a0000000000000001';
  const AG2 = 'aaa111';
  const OLD_S = '22222222-2222-4222-8222-222222222222';
  const SA = (over = {}) => ({ id: AG, type: 'Explore', label: 'scout', description: 'List project files', model: 'claude-haiku-5-5', modelLabel: 'Haiku 5.5', state: 'running', lastActivity: 1700000000000, ...over });
  const PARENT = (over = {}) => ({ id: S, name: 'acme-api refactor', live: true, pane: { id: '%12' }, subagents: [SA()], ...over });

  let restoreDom;
  before(() => { restoreDom = installDom(); });
  after(() => restoreDom());

  /** A fake page: any id gives a div that knows `hidden`, a class list, dataset and the like (fake-dom.js El). */
  const node = (id, over = {}) => {
    const n = new El('div');
    const set = new Set();
    n.id = id;
    n.title = '';
    n.classList = { add: (c) => { set.add(c); }, remove: (c) => { set.delete(c); }, contains: (c) => set.has(c), toggle(c, force) { const on = force === undefined ? !set.has(c) : Boolean(force); if (on) set.add(c); else set.delete(c); return on; } };
    return Object.assign(n, over);
  };
  const page = () => {
    const els = new Map();
    return { els, $: (id) => { if (!els.has(id)) els.set(id, node(id)); return els.get(id); } };
  };

  // -- markup and stylesheet (4.3, 4.10)

  test('(+) 4.3: #sess-subs is a closed, hidden disclosure at the top of the Transcript column: between the head and the scrolling list, with the summary, the Show ended box and the list', () => {
    const col = /<section class="hist" id="sess-hist"[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? '';
    assert.ok(col);
    const order = ['class="hist-head"', 'id="sess-subs"', 'id="hist-scroll"'].map((n) => col.indexOf(n));
    assert.ok(order.every((i) => i > 0));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(tagOf('sess-subs'), /^<details class="subs" id="sess-subs" hidden>$/, 'a closed details (no open attribute), hidden until a poll lists subagents');
    const body = /<details class="subs" id="sess-subs" hidden>([\s\S]*?)<\/details>/.exec(HTML)?.[1] ?? '';
    assert.match(body, /^\s*<summary id="subs-sum"><\/summary>/);
    assert.match(body, /<label class="subs-ended"><input type="checkbox" id="subs-ended"> Show ended<\/label>/);
    assert.match(body, /<ul class="subs-list" id="subs-list"><\/ul>/);
    assert.ok(body.indexOf('id="subs-ended"') < body.indexOf('id="subs-list"'), 'the box comes before the list');
  });

  test('(+) W9 4.4: the header has #sess-kind (hidden until a label is known) right after #sess-role, outside the meta row, so no width drops it; #sess-subtype is gone; the context meter, pane, branch and claude.ai link start hidden, so the subagent view never shows them', () => {
    assert.match(HTML, /<span id="sess-role" hidden><\/span>\s*<span id="sess-kind" hidden><\/span>/);
    assert.match(tagOf('sess-kind'), /\bhidden\b/);
    assert.doesNotMatch(tagOf('sess-kind'), /hide-narrow/, 'visible at every width (the title truncates first)');
    assert.equal(HTML.match(/id="sess-kind"/g).length, 1);
    assert.doesNotMatch(HTML, /sess-subtype/);
    const meta = /<span class="sess-meta">([\s\S]*?)<\/span>\s*<span class="sp">/.exec(HTML)?.[1] ?? '';
    assert.doesNotMatch(meta, /sess-kind/, 'not in the meta row, which is dropped on narrow windows');
    for (const id of ['sess-ctx', 'meta-pane', 'sess-branch', 'claude-link', 'sess-model']) assert.match(tagOf(id), /\bhidden\b/, id);
  });

  test('(+) 4.3, 4.9, 4.10: the session list styles: pinned strip, 32 px summary, 24 px box, a list that scrolls inside itself, the transcript link like Show all', () => {
    assert.match(css, /#sess-subs\s*\{[^}]*flex:\s*none[^}]*border-bottom:\s*1px solid var\(--line\)[^}]*padding:\s*4px 8px 4px 14px/);
    assert.match(css, /#sess-subs > summary\s*\{[^}]*cursor:\s*pointer[^}]*min-height:\s*32px[^}]*color:\s*var\(--text-muted\)/);
    assert.match(css, /#sess-subs > summary:hover\s*\{[^}]*color:\s*var\(--text\)/);
    assert.match(css, /\.subs-ended\s*\{[^}]*min-height:\s*24px/);
    assert.match(css, /\.subs-list\s*\{[^}]*max-height:\s*40vh[^}]*overflow:\s*auto/);
    assert.match(css, /\.hx-sub\s*\{[^}]*color:\s*var\(--accent\)[^}]*text-decoration:\s*underline[^}]*min-height:\s*24px[^}]*justify-self:\s*start[^}]*margin-top:\s*4px/);
  });

  test('(−) the new rules use tokens only: every var() is a token of tokens.css, no colour literal, no custom property of its own', () => {
    const at = css.indexOf('#sess-subs');
    assert.ok(at >= 0);
    const block = css.slice(at);
    const defined = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(used.length >= 6, 'the scan found the variables');
    assert.deepEqual([...new Set(used)].filter((n) => !defined.has(n)), []);
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|:has\(|@import|url\(/);
    assert.deepEqual([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]), []);
  });

  test('(+) the page uses the shared pieces of dash-model.js and dom.js, not copies: the names are imported, and no local copy of the id shape or the badge is declared', () => {
    const imports = JS['session.js'];
    assert.match(imports, /import \{[^}]*\bsubStateEl\b[^}]*\} from '\.\/dom\.js';/);
    assert.match(imports, /import \{[^}]*\bsubagentItemEl\b[^}]*\} from '\.\/dom\.js';/);
    for (const name of ['subagentView', 'subagentHref', 'SUBAGENT_ID']) assert.match(imports, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\./dash-model\\.js';`), name);
    assert.doesNotMatch(SRC, /\[A-Za-z0-9_-\]\{1,64\}/, 'the id shape lives in dash-model.js only');
    assert.doesNotMatch(SRC, /Did not finish|Finished its task/, 'the badge words live in dash-model.js only');
  });

  // -- the address (4.4 boot, steps 1 to 4)

  const top = (search) => vm.runInNewContext([
    fnOf('function param(name, shape)'),
    lineOf(/^const agentId = [^\n]*$/m), lineOf(/^const SUB = [^\n]*$/m), lineOf(/^const BAD_AGENT = [^\n]*$/m),
    lineOf(/^let sessionId = [^\n]*$/m), lineOf(/^const paneId = [^\n]*$/m), lineOf(/^const projectKey = [^\n]*$/m),
    '({ agentId, SUB, BAD_AGENT, sessionId, paneId, projectKey })',
  ].join('\n'), { location: { search }, URLSearchParams, SESSION_ID: SESSION_ID_REAL, PANE_ID: PANE_ID_REAL, SUBAGENT_ID: SUBAGENT_ID_REAL, PROJECT_KEY: /^[a-z0-9]{16}$/ });

  test('(+) the address: a valid agent id makes the subagent view; the pane in the address is ignored (no pane id at all), the session and project are kept', () => {
    assert.deepEqual(norm(top(`?session=${S}&agent=${AG}&project=${KEY}`)), { agentId: AG, SUB: true, BAD_AGENT: false, sessionId: S, paneId: null, projectKey: KEY });
    assert.deepEqual(norm(top(`?session=${S}&agent=${AG}&pane=%2512&project=${KEY}`)), { agentId: AG, SUB: true, BAD_AGENT: false, sessionId: S, paneId: null, projectKey: KEY });
    assert.equal(top(`?session=${S}&agent=${AG}&pane=%12`).paneId, null, 'the bare form of the pane parameter is ignored too');
  });

  test('(−) without an agent the window is the session window it was: the pane is read, no subagent mode', () => {
    assert.deepEqual(norm(top(`?session=${S}&pane=%2512&project=${KEY}`)), { agentId: null, SUB: false, BAD_AGENT: false, sessionId: S, paneId: '%12', projectKey: KEY });
    assert.equal(top('').BAD_AGENT, false);
  });

  test('(−) an agent that is not an id is not a subagent view: it is flagged, and the pane (if any) is still read as before', () => {
    for (const bad of ['', '..%2Fx', 'a.b', 'a%2Fb', 'a b', 'x'.repeat(65), '%00']) {
      const t = top(`?session=${S}&agent=${bad}&pane=%2512`);
      assert.equal(t.SUB, false, bad);
      assert.equal(t.BAD_AGENT, true, bad);
      assert.equal(t.agentId, null, bad);
    }
  });

  // -- boot (4.4: 2 to 6)

  const BOOT_SPIES = ['setBackHref', 'setBack', 'syncKbdHint', 'syncHistHint', 'syncPassKeys', 'watchNotes', 'showUrlNotice', 'wireTabs', 'wireHistory', 'wireHist', 'wireTerminal', 'wireComposer', 'wireSubs', 'wireSwitcher', 'wireQuick', 'wireFit', 'loadSettings', 'startAgentPoll', 'startHistoryPoll', 'kickMirror', 'refreshHistory', 'refreshAgent', 'wireWindowKeys', 'createDialogForm'];
  const bootRig = ({ sub = false, bad = false, session = S, pane = null, project = KEY, app = true, search = '' } = {}) => {
    const p = page();
    const log = { calls: [], doc: [] };
    const spy = (name) => (...args) => { log.calls.push(name); return args; };
    const ctx = {
      isApp: () => app, $: p.$, SUB: sub, BAD_AGENT: bad, agentId: sub ? AG : null, sessionId: session, paneId: pane, projectKey: project, location: { search }, URLSearchParams,
      MAC: false, P: { on: false }, windowCommand() {}, notices: [], MID: ' \u00b7 ', ATT: { wire: spy('ATT.wire') }, FIT: { planner: null }, DF: null, A: { name: 'the agent' },
      composer: () => ({ focus() {} }), onPageKey() {}, openKbd() {}, announce() {}, setGone() {}, call() {}, say() {}, showProblem() {}, clearProblem() {}, renderAttn() {}, showOverlay() {}, DOTS: '...',
      document: { body: node('body'), title: '', querySelector: (sel) => (sel === '.skip-2' ? p.$('skip-2') : null), addEventListener: (type) => log.doc.push(type) },
      ...Object.fromEntries(BOOT_SPIES.map((n) => [n, spy(n)])),
    };
    const { boot } = mk(['function showEmpty(text)', 'function showNotice(msg)', 'function readOnlyView()', 'function boot()'], ctx);
    return { boot, p, log, ctx };
  };
  const MIRROR = ['wireTabs', 'wireHist', 'wireTerminal', 'wireComposer', 'ATT.wire', 'wireSubs', 'wireSwitcher', 'wireQuick', 'wireFit', 'createDialogForm', 'kickMirror'];

  test('(+) 4.4: boot in subagent mode: no terminal column, the Transcript alone, no tabs, no "Skip to message input", the read-only notice, the body class', () => {
    const r = bootRig({ sub: true, search: `?session=${S}&agent=${AG}&project=${KEY}` });
    r.boot();
    assert.equal(r.p.$('split').classList.contains('no-term'), true);
    assert.equal(r.p.$('split').dataset.tab, 'hist');
    assert.equal(r.p.$('pane-tabs').hidden, true);
    assert.equal(r.p.$('skip-2').hidden, true);
    assert.equal(r.p.$('notice').textContent, 'Read-only. A subagent runs inside its parent session: nika shows its transcript, with no pane to mirror and no input.');
    assert.equal(r.p.$('notice').hidden, false);
    assert.equal(r.ctx.document.body.classList.contains('sub-view'), true);
    assert.equal(r.p.els.has('empty-text'), false, 'no empty state was shown: the split stays');
    assert.equal(r.p.$('split').hidden, false);
  });

  test('(+) 4.4: boot in subagent mode starts as a "Subagent" with no badge, wires the history, the page keys, the window keys, the shortcuts button, the settings and both polls', () => {
    const r = bootRig({ sub: true, search: `?session=${S}&agent=${AG}` });
    r.boot();
    assert.equal(r.p.$('sess-h').textContent, 'Subagent');
    assert.equal(r.ctx.document.title, 'Subagent \u00b7 nika');
    assert.equal(r.p.$('sess-st').hidden, true, 'no state badge until a poll names the state');
    for (const name of ['wireHistory', 'wireWindowKeys', 'loadSettings', 'startAgentPoll', 'startHistoryPoll', 'setBackHref', 'setBack', 'watchNotes']) assert.ok(r.log.calls.includes(name), name);
    assert.ok(r.log.doc.includes('keydown') && r.log.doc.includes('visibilitychange'));
    assert.equal(r.p.$('kbd-open').listeners.click?.length, 1);
  });

  test('(−) 4.4: boot in subagent mode wires none of the pane parts: no terminal, composer, attachments, switcher, quick actions, fit, dialog form, tabs, transcript toggle, subagent list or mirror poll', () => {
    const r = bootRig({ sub: true, search: `?session=${S}&agent=${AG}&pane=%2512` });
    r.boot();
    assert.deepEqual(r.log.calls.filter((n) => MIRROR.includes(n)), []);
  });

  test('(−) 4.4: an address with a pane and a subagent shows no pane notice and asks for no capture: the pane is not in play', () => {
    const r = bootRig({ sub: true, pane: null, search: `?session=${S}&agent=${AG}&pane=%2512` });
    r.boot();
    assert.equal(r.p.$('notice').textContent.includes('invalid pane id'), false);
    assert.equal(r.p.$('notice').textContent.includes('not in tmux'), false);
    assert.ok(!r.log.calls.includes('kickMirror'));
    assert.ok(!r.log.calls.includes('createDialogForm'));
    assert.equal(r.ctx.DF, null);
  });

  test('(−) 4.4: an invalid agent id shows the empty state with its words and wires nothing', () => {
    const r = bootRig({ bad: true, search: `?session=${S}&agent=..%2Fx` });
    r.boot();
    assert.equal(r.p.$('empty-text').textContent, 'This link has no valid subagent id. Open the subagent again from its session.');
    assert.equal(r.p.$('empty').hidden, false);
    assert.equal(r.p.$('split').hidden, true);
    assert.deepEqual(r.log.calls.filter((n) => !['setBackHref', 'setBack', 'syncKbdHint', 'syncHistHint', 'syncPassKeys', 'watchNotes'].includes(n)), []);
  });

  test('(−) 4.4: a subagent link with no valid session id shows the empty state with its words and wires nothing (a pane id does not stand in for it)', () => {
    const r = bootRig({ sub: true, session: null, search: `?agent=${AG}&pane=%2512` });
    r.boot();
    assert.equal(r.p.$('empty-text').textContent, 'This link has no valid session id. Open the subagent again from its session.');
    assert.equal(r.p.$('split').hidden, true);
    assert.deepEqual(r.log.calls.filter((n) => !['setBackHref', 'setBack', 'syncKbdHint', 'syncHistHint', 'syncPassKeys', 'watchNotes'].includes(n)), []);
  });

  test('(−) the browser tier keeps its message for a subagent link too, and the shortcuts button is hidden there', () => {
    const r = bootRig({ sub: true, app: false, search: `?session=${S}&agent=${AG}` });
    r.boot();
    assert.match(r.p.$('empty-text').textContent, /part of the nika app/);
    assert.equal(r.p.$('kbd-open').hidden, true);
    assert.ok(!r.log.calls.includes('startHistoryPoll'));
  });

  test('(+) a session window (no agent) boots as before: tabs, toggle, terminal, composer, attachments, the subagent list, the mirror; the notice for a pane-less window is unchanged', () => {
    const withPane = bootRig({ pane: '%12', search: `?session=${S}&pane=%2512` });
    withPane.boot();
    for (const name of MIRROR.filter((n) => n !== 'kickMirror')) assert.ok(withPane.log.calls.includes(name), name);
    assert.ok(withPane.log.calls.includes('watchNotes'), 'the notes row is watched in a session window too');
    assert.ok(withPane.log.calls.includes('kickMirror'));
    assert.equal(withPane.ctx.document.body.classList.contains('sub-view'), false);
    assert.equal(withPane.p.$('sess-st').hidden, false, 'the status slot is the session window\'s');
    const paneless = bootRig({ search: `?session=${S}` });
    paneless.boot();
    assert.equal(paneless.p.$('notice').textContent, 'This session is not in tmux, so nika can show its transcript but cannot mirror or type into it.');
    assert.equal(paneless.p.$('split').classList.contains('no-term'), true);
    assert.ok(paneless.log.calls.includes('wireSubs'), 'the list is part of every window that has a transcript');
    assert.ok(!paneless.log.calls.includes('kickMirror'));
  });

  test('(−) a window with a bad session id says so as before', () => {
    const r = bootRig({ session: null, pane: '%12', search: '?session=nope&pane=%2512' });
    r.boot();
    assert.match(r.p.$('notice').textContent, /^The link had an invalid session id; it was ignored\./);
  });

  test('(+) 4.4: the Back link is set through one helper, so the stylesheet-free count of href assignments stays two (the back link and the claude.ai link)', () => {
    assert.equal([...SRC.matchAll(/\.href = /g)].length, 2);
    assert.match(fnOf('function setBackHref('), /\$\('back'\)\.href = /);
    assert.doesNotMatch(fnOf('function boot()'), /\.href = /);
  });

  // -- the header of the subagent view (4.4: the agent poll)

  const subRig = ({ kind = null, session = S, project = KEY, agent = AG } = {}) => {
    const p = page();
    for (const id of ['sess-ctx', 'meta-pane', 'sess-branch', 'claude-link', 'sess-model', 'sess-kind', 'sess-role', 'sess-st']) p.$(id).hidden = true; // as the markup has them
    const log = { said: [], history: 0, back: [], hrefs: [] };
    const ctx = {
      $: p.$, A: { name: 'the agent', kind, subs: [] }, agentId: agent, sessionId: session, projectKey: project, MID: ' · ', document: { title: '' },
      roleTagEl: roleTagElReal, subStateEl: subStateElReal, labelEl: labelElReal, subLabelView: subLabelViewReal, PANE_ID: PANE_ID_REAL,
      announce: (m) => log.said.push(m), refreshHistory: () => { log.history += 1; }, setBack: (l) => log.back.push(l), setBackHref: (u) => log.hrefs.push(u),
    };
    const api = mk(['function subTitle(s)', 'function subBack(parent)', 'function applySubagent(parent)'], ctx);
    const hit = (parent = PARENT()) => parent; // the poll hands the parent session over
    return { ...api, p, log, ctx, hit };
  };
  const withState = (state, over = {}) => PARENT({ subagents: [SA({ state, ...over })] });

  test('(+) 4.4: the title is the description, else the type, else "Subagent" and the first 8 characters of the id; the tab title follows', () => {
    for (const [over, want] of [[{}, 'List project files'], [{ description: '' }, 'Explore'], [{ description: null, type: null }, 'Subagent a0000000'], [{ description: '   ', type: '' }, 'Subagent a0000000']]) {
      const r = subRig();
      r.applySubagent(r.hit(PARENT({ subagents: [SA(over)] })));
      assert.equal(r.p.$('sess-h').textContent, want, JSON.stringify(over));
      assert.equal(r.p.$('sess-h').title, want);
      assert.equal(r.ctx.document.title, `${want} · nika`);
      assert.equal(r.ctx.A.name, want);
    }
  });

  test('(+) 4.4: the header shows the subagent role tag, the state pill (colour, glyph and word), the label chip and the model; the other header parts stay hidden', () => {
    const r = subRig();
    r.applySubagent(r.hit());
    const role = r.p.$('sess-role');
    assert.equal(role.hidden, false);
    assert.equal(role.kids[0].className, 'tag sa');
    assert.equal(role.kids[0].textContent.includes('subagent'), true);
    const pill = r.p.$('sess-st').kids[0];
    assert.equal(r.p.$('sess-st').hidden, false);
    assert.equal(pill.className, 'sst pill');
    assert.equal(pill.attrs['data-ss'], 'running');
    assert.equal(pill.accName, 'Running', 'the word is the name; the glyph is aria-hidden');
    assert.equal(r.p.$('sess-kind').hidden, false);
    assert.equal(r.p.$('sess-kind').kids.length, 1);
    assert.equal(r.p.$('sess-kind').kids[0].className, 'agent-kind');
    assert.equal(r.p.$('sess-kind').kids[0].textContent, 'scout');
    assert.equal(r.p.$('sess-kind').kids[0].attrs.title, "Claude's Explore subagent. Kind: scout, finds files and facts, read-only");
    assert.equal(r.p.$('sess-model').textContent, 'Haiku 5.5');
    assert.equal(r.p.$('sess-model').hidden, false);
    for (const id of ['sess-ctx', 'meta-pane', 'sess-branch', 'claude-link']) assert.equal(r.p.$(id).hidden, true, `${id} stays hidden`);
  });

  test('(+) 4.4: each state has its own pill word: Running, Finished, Stopped; a subagent with no model hides that slot, and one with no type or label still shows the label "agent" (W9: never empty)', () => {
    for (const [state, word] of [['running', 'Running'], ['finished', 'Finished'], ['stopped', 'Stopped']]) {
      const r = subRig();
      r.applySubagent(r.hit(withState(state, { type: '', label: undefined, modelLabel: '' })));
      assert.equal(r.p.$('sess-st').kids[0].attrs['data-ss'], state);
      assert.equal(r.p.$('sess-st').kids[0].accName, word);
      assert.equal(r.p.$('sess-kind').hidden, false);
      assert.equal(r.p.$('sess-kind').kids[0].textContent, 'agent');
      assert.equal(r.p.$('sess-kind').kids[0].attrs.title, "Claude's subagent. Kind: agent, no particular kind");
      assert.equal(r.p.$('sess-model').hidden, true);
    }
  });

  test('(+) W9 4.4: a custom agent type shows its own name as the chip and the full type in the title; the chip follows a later poll (replaced, not added)', () => {
    const r = subRig();
    r.applySubagent(r.hit(PARENT({ subagents: [SA({ type: 'codecrew:crew-code-reviewer', label: 'crew-code-reviewer' })] })));
    assert.equal(r.p.$('sess-kind').kids[0].textContent, 'crew-code-reviewer');
    assert.equal(r.p.$('sess-kind').kids[0].attrs.title, "Claude's codecrew:crew-code-reviewer subagent");
    r.applySubagent(r.hit());
    assert.equal(r.p.$('sess-kind').kids.length, 1);
    assert.equal(r.p.$('sess-kind').kids[0].textContent, 'scout');
  });

  test('(−) W9: #sess-subtype is not touched by the script any more (the chip replaced it); applySubagent writes #sess-kind and nothing else of the type', () => {
    assert.doesNotMatch(SRC, /sess-subtype/);
    const fn = fnOf('function applySubagent(');
    assert.match(fn, /\$\('sess-kind'\)/);
    assert.doesNotMatch(fn, /\.type\b/);
  });

  test('(+) W9 4.5: the subagent list\'s redraw signature includes the label, so a chip that changes is drawn again', () => {
    assert.match(fnOf('function renderSubs('), /s\.type, s\.label, s\.modelLabel/);
  });

  test('(+) 4.4: Back goes to the parent\'s session window with its pane while it runs, and the project when the address had one; its label is the parent\'s name', () => {
    const r = subRig();
    r.applySubagent(r.hit());
    assert.deepEqual(r.log.hrefs, [`session.html?session=${S}&pane=%2512&project=${KEY}`]);
    assert.equal(r.p.$('proj').textContent, 'acme-api refactor');
    assert.deepEqual(r.log.back, ['acme-api refactor']);
  });

  test('(−) 4.4: an ended parent has no pane to open: Back carries the session only; no project in the address means none in Back; a malformed pane id is left out', () => {
    const ended = subRig();
    ended.applySubagent(ended.hit(PARENT({ live: false, pane: null })));
    assert.deepEqual(ended.log.hrefs, [`session.html?session=${S}&project=${KEY}`]);
    const noProject = subRig({ project: null });
    noProject.applySubagent(noProject.hit());
    assert.deepEqual(noProject.log.hrefs, [`session.html?session=${S}&pane=%2512`]);
    const odd = subRig();
    odd.applySubagent(odd.hit(PARENT({ pane: { id: '%12; rm' } })));
    assert.deepEqual(odd.log.hrefs, [`session.html?session=${S}&project=${KEY}`]);
    const stale = subRig();
    stale.applySubagent(stale.hit(PARENT({ live: false, pane: { id: '%12' } })));
    assert.deepEqual(stale.log.hrefs, [`session.html?session=${S}&project=${KEY}`], 'a pane id of a session that is not live is not passed on');
  });

  test('(−) 4.4: a parent with no name (or only its id\'s start as name) is "untitled session", as in the session window\'s own header', () => {
    for (const name of ['', null, S.slice(0, 8)]) {
      const r = subRig();
      r.applySubagent(r.hit(PARENT({ name })));
      assert.equal(r.p.$('proj').textContent, 'untitled session', String(name));
      assert.deepEqual(r.log.back, ['untitled session']);
    }
  });

  test('(−) 4.6: a subagent the parent does not list (or a state nobody knows) hides the badge, keeps polling (kind null) and leaves the header as it was; Back still goes up', () => {
    const r = subRig({ kind: 'busy' });
    r.applySubagent(r.hit(PARENT({ subagents: [SA({ id: AG2 })] })));
    assert.equal(r.p.$('sess-st').hidden, true);
    assert.equal(r.ctx.A.kind, null);
    assert.equal(r.p.$('sess-h').textContent, '', 'the title was not touched');
    assert.equal(r.log.hrefs.length, 1, 'the parent is known, so Back goes to it');
    const odd = subRig();
    odd.applySubagent(odd.hit(withState('weird')));
    assert.equal(odd.p.$('sess-st').hidden, true);
    assert.equal(odd.ctx.A.kind, null);
    assert.deepEqual(odd.log.said, []);
  });

  test('(−) 4.6: no parent in the snapshot (or an older server with no subagents field) is not an error: nothing is drawn and nothing thrown', () => {
    const r = subRig();
    assert.doesNotThrow(() => r.applySubagent(null));
    assert.deepEqual(r.log.hrefs, [], 'with no parent there is no Back change');
    for (const subagents of [undefined, 'nope', [null, 5, 'x', []]]) assert.doesNotThrow(() => r.applySubagent(r.hit(PARENT({ subagents }))), String(subagents));
    assert.equal(r.p.$('sess-st').hidden, true);
    assert.equal(r.log.hrefs.length, 3, 'a parent that lists nothing usable still gets its Back link');
    assert.equal(r.ctx.A.kind, null);
  });

  test('(+) 4.4: the state decides the poll kind: running is busy, finished is idle (still polled), stopped is ended', () => {
    for (const [state, kind] of [['running', 'busy'], ['finished', 'idle'], ['stopped', 'ended']]) {
      const r = subRig();
      r.applySubagent(r.hit(withState(state)));
      assert.equal(r.ctx.A.kind, kind, state);
    }
  });

  test('(+) 4.4 and the ruling: the first answer says nothing; running to finished says "finished" and reads the live edge once; finished to running says "is running again" and reads nothing extra', () => {
    const r = subRig();
    r.applySubagent(r.hit(withState('running')));
    assert.deepEqual([r.log.said, r.log.history], [[], 0], 'the first poll is silent');
    r.applySubagent(r.hit(withState('running')));
    assert.deepEqual([r.log.said, r.log.history], [[], 0], 'the same state is silent');
    r.applySubagent(r.hit(withState('finished')));
    assert.deepEqual(r.log.said, ['List project files finished']);
    assert.equal(r.log.history, 1);
    r.applySubagent(r.hit(withState('finished')));
    assert.deepEqual([r.log.said.length, r.log.history], [1, 1], 'no repeat while it stays finished');
    r.applySubagent(r.hit(withState('running')));
    assert.deepEqual(r.log.said, ['List project files finished', 'List project files is running again']);
    assert.equal(r.log.history, 1, 'running again needs no extra read: the ordinary polls carry on');
    assert.equal(r.p.$('sess-st').kids[0].attrs['data-ss'], 'running', 'the badge went back to running');
  });

  test('(+) 4.4: running to stopped says "stopped" and reads the live edge once; finished to stopped (the parent went away) the same', () => {
    const a = subRig();
    a.applySubagent(a.hit(withState('running')));
    a.applySubagent(a.hit(withState('stopped')));
    assert.deepEqual(a.log.said, ['List project files stopped']);
    assert.equal(a.log.history, 1);
    const b = subRig();
    b.applySubagent(b.hit(withState('finished')));
    b.applySubagent(b.hit(withState('stopped')));
    assert.deepEqual(b.log.said, ['List project files stopped']);
    assert.equal(b.log.history, 1);
  });

  // the polls in play: the real refreshHistory next to the real applySubagent, with a counting fake of the history route
  const pollRig = () => {
    const log = { fetches: 0 };
    const A = { name: 'the agent', kind: null, subs: [] };
    const base = subRig();
    const ctx = {
      ...base.ctx, A, H: { items: [], ids: new Set(), older: null, liveEdge: true, loaded: true, busy: false }, document: { hidden: false, title: '' },
      fetchHistory: async () => { log.fetches += 1; return { status: 200, body: { entries: [] } }; }, cleanEntries: (l) => l,
    };
    delete ctx.refreshHistory;
    const api = vm.runInNewContext([fnOf('async function refreshHistory()'), ...['function subTitle(s)', 'function subBack(parent)', 'function applySubagent(parent)'].map(fnOf), '({ refreshHistory, applySubagent })'].join('\n'), ctx);
    return { ...api, log, A, hit: base.hit };
  };

  test('(+) the ruling: after "finished" the history poll goes on (Claude removes finished again when a subagent wakes up); the change to finished itself read the live edge once', async () => {
    const r = pollRig();
    r.applySubagent(r.hit(withState('running')));
    await settle();
    r.applySubagent(r.hit(withState('finished')));
    await settle();
    assert.equal(r.log.fetches, 1, 'the one read the change asks for');
    await r.refreshHistory();
    await r.refreshHistory();
    assert.equal(r.log.fetches, 3, 'the ordinary polls still read while it is finished');
  });

  test('(−) the poll stops on "stopped" (the parent is gone) after the one last read the change asks for; running and unknown keep reading', async () => {
    const r = pollRig();
    r.applySubagent(r.hit(withState('running')));
    await settle();
    r.applySubagent(r.hit(withState('stopped')));
    await settle();
    assert.equal(r.log.fetches, 1, 'the last read at the live edge');
    await r.refreshHistory();
    await r.refreshHistory();
    assert.equal(r.log.fetches, 1, 'nothing more once it is stopped');
    const busy = pollRig();
    busy.applySubagent(busy.hit(withState('running')));
    await busy.refreshHistory();
    assert.equal(busy.log.fetches, 1);
    const unknown = pollRig();
    assert.equal(unknown.A.kind, null);
    await unknown.refreshHistory();
    assert.equal(unknown.log.fetches, 1, 'before the first answer the poll reads');
  });

  // -- the agent poll in the subagent view: the session window's own poll, whose hit applyAgent hands to the subagent view

  const agentPollRig = ({ groups, fail = false, session = S, pane = null } = {}) => {
    const log = { applied: [], followed: [], paths: [] };
    const ctx = {
      sessionId: session, paneId: pane, projectKey: KEY, A: { projectLooked: false }, $: page().$,
      getJSON: async (path) => { log.paths.push(path); if (fail) throw new Error('down'); return { groups }; },
      call: async (path) => { log.paths.push(path); return { status: 200, body: { projects: [] } }; },
      followSession: (arg) => { const next = followSessionReal(arg); log.followed.push(next); return next; }, followPane() {}, announce() {},
      applyAgent: (a, g) => log.applied.push([a.id, g.label]),
    };
    const { refreshAgent } = mk(['async function refreshAgent()'], ctx);
    return { refreshAgent, log };
  };
  const GROUPS = [{ label: 'acme-api', agents: [{ id: '22222222-2222-4222-8222-222222222222', name: 'other', live: true }, PARENT()] }];

  test('(+) 4.4: the agent poll of the subagent view (no pane) finds the parent by its session id and hands it to applyAgent; followSession has no pane to follow, so nothing is followed', async () => {
    const r = agentPollRig({ groups: GROUPS });
    await r.refreshAgent();
    assert.deepEqual(r.log.applied, [[S, 'acme-api']]);
    assert.deepEqual(r.log.followed, [null]);
    assert.deepEqual(r.log.paths, ['/api/agents?since=all'], 'one read of the public snapshot, nothing else');
  });

  test('(+) 4.4: in the subagent view applyAgent hands the parent to applySubagent and returns before anything of the session header, the mode, the prompt or the composer is touched', () => {
    const fn = fnOf('function applyAgent(');
    assert.match(fn, /^function applyAgent\(agent, group\) \{\n  if \(SUB\) \{\n    applySubagent\(agent\);[^\n]*\n    return;\n  \}\n/);
    assert.equal(fn.split('applySubagent(').length, 2, 'one call');
    const seen = [];
    const run = vm.runInNewContext(`${fn}; applyAgent`, { SUB: true, applySubagent: (a) => seen.push(a.id) });
    run({ id: S }, { label: 'x' });
    assert.deepEqual(seen, [S]);
  });

  test('(−) 4.6: a snapshot that does not list the parent hands nothing over (the header keeps what it had); a failed poll or a snapshot without groups touches nothing', async () => {
    const none = agentPollRig({ groups: [{ label: 'x', agents: [] }] });
    await none.refreshAgent();
    assert.deepEqual(none.log.applied, []);
    const down = agentPollRig({ groups: GROUPS, fail: true });
    await down.refreshAgent();
    assert.deepEqual(down.log.applied, []);
    const odd = agentPollRig({ groups: 'nope' });
    await odd.refreshAgent();
    assert.deepEqual(odd.log.applied, []);
  });

  test('(+) the session window\'s own poll is unchanged: applyAgent with the hit, and the pane followed after /clear', async () => {
    const live = [{ id: OLD_S, name: 'old', live: false, pane: { id: '%12' } }, PARENT({ id: S })];
    const r = agentPollRig({ groups: [{ label: 'acme-api', agents: live }], session: OLD_S, pane: '%12' });
    await r.refreshAgent();
    assert.deepEqual(r.log.followed, [S], 'the pane\'s live session replaced the old one');
    assert.deepEqual(r.log.applied, [[S, 'acme-api']]);
  });

  test('(−) 4.4: in the subagent view nothing the page requests is a pane route: the snapshot, the history and the settings only', async () => {
    const paths = [];
    const ctx = {
      SUB: true, sessionId: S, agentId: AG, paneId: null, URLSearchParams, DOTS: '...', historyNote() {}, resetHistory() {}, cleanEntries: (l) => l, nextBefore: () => null, serverMessage: () => 'x',
      call: async (path) => { paths.push(path); return { status: 200, body: { entries: [], ui: {} } }; },
      getJSON: async (path) => { paths.push(path); return { groups: GROUPS }; }, applyTheme() {}, syncKbdHint() {}, UI: { singleKey: true },
      followSession: () => null, applyAgent() {}, A: { projectLooked: true },
    };
    const api = vm.runInNewContext([
      lineOf(/const fetchHistory = [\s\S]*?\n};/), fnOf('async function loadNewest()'), fnOf('async function refreshAgent()'), fnOf('async function loadSettings()'),
      '({ fetchHistory, loadNewest, refreshAgent, loadSettings })',
    ].join('\n'), ctx);
    await api.loadNewest();
    await api.fetchHistory(1200);
    await api.refreshAgent();
    await api.loadSettings();
    assert.ok(paths.length >= 4);
    assert.deepEqual(paths.filter((p) => p.includes('/pane/')), []);
    for (const p of paths) assert.match(p, /^\/api\/(app\/(session\/[0-9a-f-]+\/subagents\/[A-Za-z0-9_-]+\/history\?|settings$)|agents\?since=all$)/, p);
  });

  // -- the transcript of the subagent view (4.4: fetchHistory, "Parent", the start marker, 4.6 notes)

  const histRig = ({ sub }) => {
    const paths = [];
    const ctx = { SUB: sub, sessionId: S, agentId: AG, URLSearchParams, call: async (path) => { paths.push(path); return { status: 200, body: { entries: [] } }; } };
    const { fetchHistory } = vm.runInNewContext(`${lineOf(/const fetchHistory = [\s\S]*?\n};/)}; ({ fetchHistory })`, ctx);
    return { fetchHistory, paths };
  };

  test('(+) 4.4: the subagent view reads /api/app/session/<S>/subagents/<a>/history with limit 50 and, for older pages, before; the session window reads its own history route as before', async () => {
    const sub = histRig({ sub: true });
    await sub.fetchHistory(null);
    await sub.fetchHistory(1200);
    assert.deepEqual(sub.paths, [`/api/app/session/${S}/subagents/${AG}/history?limit=50`, `/api/app/session/${S}/subagents/${AG}/history?limit=50&before=1200`]);
    const plain = histRig({ sub: false });
    await plain.fetchHistory(null);
    await plain.fetchHistory(0);
    assert.deepEqual(plain.paths, [`/api/app/session/${S}/history?limit=50`, `/api/app/session/${S}/history?limit=50&before=0`]);
  });

  const noteRig = ({ sub, status, body = null }) => {
    const notes = [];
    const ctx = {
      SUB: sub, historyNote: (m) => notes.push(m), resetHistory() {}, cleanEntries: (l) => l, nextBefore: () => null, serverMessage: (r, fallback) => (typeof r.body?.message === 'string' ? r.body.message : fallback),
      fetchHistory: async () => ({ status, body }),
    };
    return { notes, run: () => mk(['async function loadNewest()'], ctx).loadNewest() };
  };

  test('(+) 4.6: the subagent view\'s notes: an empty transcript, a transcript not there yet (404, nika keeps looking), a failure with or without the server\'s words', async () => {
    const empty = noteRig({ sub: true, status: 200, body: { entries: [] } });
    await empty.run();
    assert.deepEqual(empty.notes, ['No messages in this transcript yet.']);
    const missing = noteRig({ sub: true, status: 404 });
    await missing.run();
    assert.deepEqual(missing.notes, ['No transcript for this subagent yet. nika keeps looking.']);
    const failing = noteRig({ sub: true, status: 500 });
    await failing.run();
    assert.deepEqual(failing.notes, ['The transcript could not be read. nika keeps trying.']);
    const said = noteRig({ sub: true, status: 503, body: { message: 'tmux is busy' } });
    await said.run();
    assert.deepEqual(said.notes, ['tmux is busy']);
  });

  test('(−) 4.6: the session window keeps its own 404 note', async () => {
    const missing = noteRig({ sub: false, status: 404 });
    await missing.run();
    assert.deepEqual(missing.notes, ['No transcript found for this session yet. nika keeps looking.']);
  });

  const startRig = ({ sub }) => {
    const starts = [];
    const els = { 'load-older': { setAttribute() {}, removeAttribute() {}, textContent: '', get ownerDocument() { return null; } }, older: {}, newer: {}, 'hist-count': {}, 'hx-list': { parentNode: { querySelector: () => null }, before: (p) => starts.push(p.textContent) } };
    const ctx = { SUB: sub, $: (id) => els[id], H: { items: [{ e: {} }], older: null, liveEdge: true }, h: hReal, scroller: () => ({ focus() {} }), document: { activeElement: null } };
    return { starts, run: () => mk(['function updateHistoryChrome()'], ctx).updateHistoryChrome() };
  };

  test('(+) 4.4: the start marker reads "Start of the subagent\'s transcript" in the subagent view and "Start of the session" in the session window', () => {
    const sub = startRig({ sub: true });
    sub.run();
    assert.deepEqual(sub.starts, ["Start of the subagent's transcript"]);
    const plain = startRig({ sub: false });
    plain.run();
    assert.deepEqual(plain.starts, ['Start of the session']);
  });

  // -- entries: who, the link (4.5)

  const entryRig = ({ sub = false, subs = [], project = KEY } = {}) => {
    const ctx = {
      SUB: sub, sessionId: S, projectKey: project, A: { subs }, h: hReal, subagentHref: subagentHrefReal, SUBAGENT_ID: SUBAGENT_ID_REAL, H: { items: [], ids: new Set() },
      Date, ENTRY_ID: vm.runInNewContext(constOf('ENTRY_ID') + '; ENTRY_ID'), KINDS: vm.runInNewContext(constOf('KINDS') + '; KINDS'),
    };
    const api = mk(['function cleanEntries(list)', 'function textBlock(e)', 'function foldBlock(e)', 'function subLinkEl(e)', 'function entryEl(e)', 'function linkLate(entries)'], ctx, `${constOf('DOTS')}\n${constOf('clip')}`);
    return { ...api, ctx };
  };
  const RAW = (over = {}) => ({ id: '100:0', at: '2026-11-15T10:00:00.000Z', role: 'assistant', kind: 'tool_use', tool: 'Agent', text: '{"description":"List project files"}', truncated: false, ...over });
  const linkOf = (li) => li.all(withClass('hx-sub'))[0] ?? null;

  test('(+) 4.5: a tool call with a subagent id gets "Open subagent transcript" after its fold: an a.hx-sub whose href is the subagent view of this session, the project kept', () => {
    const r = entryRig();
    const [e] = r.cleanEntries([RAW({ subagent: AG })]);
    const li = r.entryEl(e);
    const a = linkOf(li);
    assert.ok(a);
    assert.equal(a.tag, 'a');
    assert.equal(a.attrs.href, `session.html?session=${S}&agent=${AG}&project=${KEY}`);
    assert.equal(a.textContent, 'Open subagent transcript');
    assert.equal(a.attrs['aria-label'], undefined, 'the fold summary above already names the call when the page does not know the subagent');
    const kinds = li.kids.map((k) => k.tag + (k.className ? `.${k.className}` : ''));
    assert.ok(kinds.indexOf('a.hx-sub') > kinds.findIndex((k) => k.startsWith('details')), 'after the fold');
  });

  test('(+) 4.5, 4.9: when the last poll lists that subagent the link says which one (aria-label with its description); a project-less window leaves &project out', () => {
    const r = entryRig({ subs: [SA(), SA({ id: AG2, description: 'Other work' })], project: null });
    const a = linkOf(r.entryEl(r.cleanEntries([RAW({ subagent: AG2 })])[0]));
    assert.equal(a.attrs['aria-label'], 'Open the transcript of subagent Other work');
    assert.equal(a.attrs.href, `session.html?session=${S}&agent=${AG2}`);
    const noText = entryRig({ subs: [SA({ description: '' })] });
    assert.equal(linkOf(noText.entryEl(noText.cleanEntries([RAW({ subagent: AG })])[0])).attrs['aria-label'], undefined, 'no description, no label');
  });

  test('(−) 4.5: no link for a bad subagent id, for an entry that is not a tool call, for an entry with no id at all', () => {
    const r = entryRig();
    for (const bad of ['../x', 'a b', 'a.b', 'x'.repeat(65), '', 5, null, {}, [AG]]) {
      const [e] = r.cleanEntries([RAW({ subagent: bad })]);
      assert.equal(e.subagent, '', String(bad));
      assert.equal(linkOf(r.entryEl(e)), null, String(bad));
    }
    for (const kind of ['text', 'thinking', 'tool_result']) {
      const [e] = r.cleanEntries([RAW({ kind, subagent: AG })]);
      assert.equal(e.subagent, '', kind);
      assert.equal(linkOf(r.entryEl(e)), null, kind);
    }
    assert.equal(linkOf(r.entryEl(r.cleanEntries([RAW()])[0])), null, 'a call the server did not link');
  });

  test('(−) 4.5: the subagent view draws no link, even for an entry that carries an id (nested subagents are not built)', () => {
    const r = entryRig({ sub: true });
    const [e] = r.cleanEntries([RAW({ subagent: AG })]);
    assert.equal(linkOf(r.entryEl(e)), null);
  });

  test('(+) 4.5: the late link: a call already on screen without a link gets it when a later read carries the id, once, and the entry remembers it', () => {
    const r = entryRig();
    const [e] = r.cleanEntries([RAW()]);
    const li = r.entryEl(e);
    r.ctx.H.items.push({ e, el: li });
    const before = li.kids.length;
    r.linkLate(r.cleanEntries([RAW({ subagent: AG })]));
    assert.equal(li.kids.length, before + 1);
    assert.equal(linkOf(li).attrs.href, `session.html?session=${S}&agent=${AG}&project=${KEY}`);
    assert.equal(e.subagent, AG);
    r.linkLate(r.cleanEntries([RAW({ subagent: AG })]));
    assert.equal(li.kids.length, before + 1, 'not twice');
    assert.equal(li.all(withClass('hx-sub')).length, 1);
  });

  test('(−) 4.5: the late link ignores an entry that is not on screen, an entry with no id, an entry that already has its link, and the subagent view', () => {
    const r = entryRig();
    const [e] = r.cleanEntries([RAW()]);
    const li = r.entryEl(e);
    r.ctx.H.items.push({ e, el: li });
    const before = li.kids.length;
    r.linkLate(r.cleanEntries([RAW({ id: '999:0', subagent: AG })]));
    r.linkLate(r.cleanEntries([RAW()]));
    assert.equal(li.kids.length, before);
    const linked = entryRig();
    const [e2] = linked.cleanEntries([RAW({ subagent: AG })]);
    const li2 = linked.entryEl(e2);
    linked.ctx.H.items.push({ e: e2, el: li2 });
    const n = li2.kids.length;
    linked.linkLate(linked.cleanEntries([RAW({ subagent: AG2 })]));
    assert.equal(li2.kids.length, n, 'the link it has is kept');
    assert.equal(linkOf(li2).attrs.href.includes(AG2), false);
    const sub = entryRig({ sub: true });
    const [e3] = sub.cleanEntries([RAW()]);
    const li3 = sub.entryEl(e3);
    sub.ctx.H.items.push({ e: e3, el: li3 });
    sub.linkLate(sub.cleanEntries([RAW({ subagent: AG })]));
    assert.equal(linkOf(li3), null);
  });

  test('(+) 4.4: user text reads "Parent" in the subagent view; the tool result stays "Tool" and Claude "Claude"', () => {
    const r = entryRig({ sub: true });
    const who = (over) => r.entryEl(r.cleanEntries([RAW({ kind: 'text', ...over })])[0]).all(withClass('hx-who'))[0].textContent;
    assert.equal(who({ role: 'user' }), 'Parent');
    assert.equal(who({ role: 'assistant' }), 'Claude');
    assert.equal(who({ role: 'user', kind: 'tool_result' }), 'Tool');
  });

  test('(−) 4.4: the session window still says "You" for the user\'s text', () => {
    const r = entryRig({ sub: false });
    const who = (over) => r.entryEl(r.cleanEntries([RAW({ kind: 'text', ...over })])[0]).all(withClass('hx-who'))[0].textContent;
    assert.equal(who({ role: 'user' }), 'You');
    assert.equal(who({ role: 'assistant' }), 'Claude');
  });

  // the live-edge read next to the late link: the real refreshHistory, with a spy where the late link goes
  const lateRig = ({ shown, polled }) => {
    const log = { late: [], fetches: 0 };
    const sc = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
    const ctx = {
      H: { items: shown.map((e) => ({ e, el: { remove() {} } })), ids: new Set(shown.map((e) => e.id)), older: null, liveEdge: true, loaded: true, busy: false }, A: { kind: 'busy' }, document: { hidden: false },
      fetchHistory: async () => { log.fetches += 1; return { status: 200, body: { entries: polled, nextBefore: null } }; }, cleanEntries: (l) => l, nextBefore: () => null,
      linkLate: (entries) => log.late.push(entries.map((e) => [e.id, e.subagent])), scroller: () => sc, resetHistory() { throw new Error('no reset'); }, MAX_ENTRIES: 500,
      mount: () => 0, trim() {}, updateHistoryChrome() {}, keyOf: (id) => { const [off, block] = id.split(':').map(Number); return off * 100000 + block; },
    };
    const api = vm.runInNewContext(`${constOf('nearBottom')}\n${fnOf('async function refreshHistory()')}; ({ refreshHistory })`, ctx);
    return { ...api, log };
  };
  const E = (id, over = {}) => ({ id, at: '', role: 'assistant', kind: 'tool_use', text: 'x', tool: 'Agent', truncated: false, subagent: '', ...over });

  test('(+) 4.5: a read of the live edge that carries an id for a call already on screen hands it to the late link, even when nothing else is new', async () => {
    const r = lateRig({ shown: [E('100:0')], polled: [E('100:0', { subagent: AG })] });
    await r.refreshHistory();
    assert.deepEqual(r.log.late, [[['100:0', AG]]]);
  });

  test('(−) 4.5: a read with no ids calls no late link (a server that sends none, and the fake page of memory.test.js, lose nothing)', async () => {
    const none = lateRig({ shown: [E('100:0')], polled: [E('100:0'), E('200:0')] });
    await none.refreshHistory();
    assert.deepEqual(none.log.late, []);
  });

  // -- the list in the session window (4.3)

  const subsLine = () => lineOf(/^const SUBS = [^\n]*$/m); // read per test, so a missing declaration fails the tests that need it
  const subsRig = ({ store = new Map(), broken = false, name = 'acme-api', active = null } = {}) => {
    const p = page();
    const root = p.$('sess-subs');
    root.hidden = true;
    const sum = p.$('subs-sum');
    const box = p.$('subs-ended');
    const list = p.$('subs-list');
    const log = { redraws: 0 };
    const replace = list.replaceChildren.bind(list);
    list.replaceChildren = (...nodes) => { log.redraws += 1; replace(...nodes); };
    list.contains = (n) => n !== null && list.all((x) => x === n).length > 0;
    list.querySelectorAll = () => list.all((n) => n.tag === 'a');
    const doc = { activeElement: active };
    const localStorage = {
      getItem(k) { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { if (broken) throw new Error('blocked'); store.set(k, String(v)); },
    };
    const ctx = { $: p.$, h: hReal, subagentView: subagentViewReal, subagentHref: subagentHrefReal, subagentItemEl: subagentItemElReal, projectKey: KEY, A: { name, subs: [] }, document: doc, localStorage };
    const api = mk(['function storeGet(key)', 'function storeSet(key, value)', 'function renderSubs(agent)', 'function wireSubs()'], ctx, subsLine());
    return { ...api, p, root, sum, box, list, log, store, doc, ctx };
  };
  const AGENT = (subagents) => ({ id: S, name: 'acme-api', subagents });
  const lis = (list) => list.kids.filter((k) => k.tag === 'li');
  const hintOf = (sum) => sum.all(withClass('sub-hid'))[0]?.textContent ?? null;

  test('(−) 4.3: nothing to list (none, not an array, only garbage) leaves #sess-subs hidden', () => {
    for (const subagents of [undefined, null, [], 'x', 5, [null, 7, 'a']]) {
      const r = subsRig();
      r.renderSubs(AGENT(subagents));
      assert.equal(r.root.hidden, true, JSON.stringify(subagents));
    }
  });

  test('(+) 4.3: running ones show, the rest wait for Show ended: summary "1 subagent · 1 running", the hint "+2 ended", one line with the badge, the link and the model', () => {
    const r = subsRig();
    r.renderSubs(AGENT([SA(), SA({ id: AG2, state: 'finished' }), SA({ id: 'a3', state: 'stopped' })]));
    assert.equal(r.root.hidden, false);
    assert.equal(r.sum.textContent, '1 subagent · 1 running +2 ended');
    assert.equal(hintOf(r.sum), '+2 ended');
    assert.equal(lis(r.list).length, 1);
    assert.equal(r.list.attrs['aria-label'], 'Subagents of acme-api');
    const li = lis(r.list)[0];
    assert.equal(li.attrs['data-ss'], 'running');
    const a = li.all((n) => n.tag === 'a')[0];
    assert.equal(a.attrs.href, `session.html?session=${S}&agent=${AG}&project=${KEY}`);
    assert.equal(a.textContent, 'List project files');
    assert.equal(a.attrs.title, 'Open its transcript (read-only)');
    assert.equal(li.all(withClass('sst'))[0].accName, 'Running');
    assert.equal(li.all(withClass('model'))[0].textContent, 'Haiku 5.5');
  });

  test('(−) 4.3: the session list draws no time on a line (it would change at every poll); the rows of the dashboard do', () => {
    const r = subsRig();
    r.renderSubs(AGENT([SA({ lastActivity: 1700000000000 })]));
    const li = lis(r.list)[0];
    assert.deepEqual(li.all((n) => n.tag === 'time'), []);
    assert.equal(li.kids.length, 4, 'badge, link, type, model');
  });

  test('(+) 4.3: the Show ended box lists them all and says so: "3 subagents · 1 running", no hint; the choice is remembered as nika.showEndedSession', () => {
    const r = subsRig();
    r.wireSubs();
    r.renderSubs(AGENT([SA(), SA({ id: AG2, state: 'finished' }), SA({ id: 'a3', state: 'stopped' })]));
    r.box.checked = true;
    r.box.fire('change');
    assert.equal(r.sum.textContent, '3 subagents · 1 running');
    assert.equal(hintOf(r.sum), null);
    assert.equal(lis(r.list).length, 3);
    assert.deepEqual(lis(r.list).map((li) => li.attrs['data-ss']), ['running', 'finished', 'stopped'], 'the server\'s order');
    assert.equal(r.store.get('nika.showEndedSession'), 'true');
    r.box.checked = false;
    r.box.fire('change');
    assert.equal(r.store.get('nika.showEndedSession'), 'false');
    assert.equal(lis(r.list).length, 1);
  });

  test('(+) 4.3, 4.6: all ended with the box off: "No subagents running +3 ended", the list shell stays (the box is in the body), no lines; ticking the box lists them', () => {
    const r = subsRig();
    r.wireSubs();
    r.renderSubs(AGENT([SA({ state: 'finished' }), SA({ id: AG2, state: 'finished' }), SA({ id: 'a3', state: 'stopped' })]));
    assert.equal(r.root.hidden, false);
    assert.equal(r.sum.textContent, 'No subagents running +3 ended');
    assert.equal(lis(r.list).length, 0);
    r.box.checked = true;
    r.box.fire('change');
    assert.equal(lis(r.list).length, 3);
    assert.equal(r.sum.textContent, '3 subagents');
  });

  test('(+) 4.3: the box starts from the stored choice: only the string "true" is on', () => {
    const on = subsRig({ store: new Map([['nika.showEndedSession', 'true']]) });
    on.wireSubs();
    assert.equal(on.box.checked, true);
    on.renderSubs(AGENT([SA({ state: 'finished' })]));
    assert.equal(lis(on.list).length, 1);
  });

  test('(−) 4.3: anything else in storage is off; storage that throws is off and a change does not throw', () => {
    for (const value of ['True', '1', '', 'yes', 'false', ' true', 'true ', '{"a":1}']) {
      const r = subsRig({ store: new Map([['nika.showEndedSession', value]]) });
      r.wireSubs();
      assert.equal(r.box.checked, false, JSON.stringify(value));
      r.renderSubs(AGENT([SA({ state: 'finished' })]));
      assert.equal(lis(r.list).length, 0);
    }
    const broken = subsRig({ broken: true });
    broken.wireSubs();
    broken.renderSubs(AGENT([SA({ state: 'finished' })]));
    assert.equal(broken.box.checked, false);
    broken.box.checked = true;
    assert.doesNotThrow(() => broken.box.fire('change'));
    assert.equal(lis(broken.list).length, 1, 'the choice still applies for this window');
  });

  test('(+) 4.3: a redraw only when the signature changes: the same answer twice draws once; a new state, a new name or the box draws again', () => {
    const r = subsRig();
    r.wireSubs();
    r.renderSubs(AGENT([SA()]));
    r.renderSubs(AGENT([SA()]));
    r.renderSubs(AGENT([SA({ lastActivity: 1700000099999 })]));
    assert.equal(r.log.redraws, 1, 'the activity time is not part of the list');
    r.renderSubs(AGENT([SA({ state: 'finished' })]));
    assert.equal(r.log.redraws, 2);
    r.ctx.A.name = 'renamed';
    r.renderSubs(AGENT([SA({ state: 'finished' })]));
    assert.equal(r.log.redraws, 3, 'the list is labelled with the session name');
    assert.equal(r.list.attrs['aria-label'], 'Subagents of renamed');
  });

  test('(+) 4.3, 4.8: the disclosure itself is never opened or closed by the page, and a redraw keeps focus on the link that had it', () => {
    const r = subsRig();
    r.renderSubs(AGENT([SA(), SA({ id: AG2, description: 'Other work' })]));
    r.root.open = true; // the reader opened it
    const had = r.list.all((n) => n.tag === 'a')[1];
    assert.equal(had.attrs['data-fk'], `sub:${AG2}`);
    r.doc.activeElement = had;
    focusState.el = null;
    r.renderSubs(AGENT([SA({ lastActivity: 1 }), SA({ id: AG2, description: 'Other work', modelLabel: 'Sonnet 5.5' })]));
    const now = r.list.all((n) => n.tag === 'a')[1];
    assert.notEqual(now, had, 'the list was rebuilt');
    assert.equal(focusState.el, now, 'and focus went to the new link for the same subagent');
    assert.equal(r.root.open, true, 'still open');
    r.renderSubs(AGENT([]));
    assert.equal(r.root.hidden, true);
    assert.equal(r.root.open, true, 'hiding does not close it either');
  });

  test('(−) 4.3: a redraw does not move focus when it was elsewhere', () => {
    const r = subsRig({ active: { id: 'composer' } });
    r.renderSubs(AGENT([SA()]));
    focusState.el = null;
    r.renderSubs(AGENT([SA({ state: 'finished' })]));
    assert.equal(focusState.el, null);
  });

  test('(−) 4.3, constraint 6: a description with markup is text, and a subagent id that is not an id gets no link', () => {
    const r = subsRig();
    r.renderSubs(AGENT([SA({ description: '<img src=x onerror=alert(1)>' }), SA({ id: '../x', description: 'bad id' })]));
    const [one, two] = lis(r.list);
    const a = one.all((n) => n.tag === 'a')[0];
    assert.equal(a.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(a.kids.length, 0, 'text, not elements');
    assert.deepEqual(two.all((n) => n.tag === 'a'), []);
    assert.equal(two.all(withClass('sub-desc'))[0].tag, 'span');
  });

  test('(+) the list is part of the polled header: applyAgent hands the agent to renderSubs, and wireSubs is a normal-mode step of boot', () => {
    assert.match(fnOf('function applyAgent('), /renderSubs\(agent\);/);
    assert.equal((SRC.match(/wireSubs\(\)/g) ?? []).length, 2, 'declared once, called once');
  });

  // -- the Keyboard shortcuts window (4.4)

  const kbdRig = (sub) => {
    const asked = [];
    const ctx = { SUB: sub, MAC: false, UI: { singleKey: true }, openShortcuts: (o) => asked.push(o) };
    mk(['function openKbd(opener)'], ctx).openKbd('the-opener');
    return asked[0];
  };

  test('(+) 4.4: ? opens the subagent table in the subagent view and the session table in the session window', () => {
    assert.equal(kbdRig(true).window, 'subagent');
    assert.equal(kbdRig(false).window, 'session');
    assert.equal(kbdRig(true).tier, 'app');
  });
});

// ---- W9 4.4: the chip of an agent in the normal window (renderKind) -------------------------------------------------------------------
describe('the session header: the kind chip of an agent (W9 4.4)', () => {
  const SRC = code(JS['session.js']);
  const fnOf = (head) => {
    const at = SRC.indexOf(head);
    assert.ok(at >= 0, head);
    return SRC.slice(at, SRC.indexOf('\n}\n', at) + 2);
  };
  let restoreDom;
  before(() => { restoreDom = installDom(); });
  after(() => restoreDom());

  const rig = () => {
    const els = new Map();
    const $ = (id) => {
      if (!els.has(id)) {
        const n = new El('span');
        n.id = id;
        n.hidden = true; // as the markup has it
        els.set(id, n);
      }
      return els.get(id);
    };
    const run = vm.runInNewContext(`${fnOf('function renderKind(')}; renderKind`, { $, labelEl: labelElReal, agentLabelView: agentLabelViewReal });
    return { $, run };
  };
  const a = (over = {}) => ({ id: 's', name: 'builder-1', live: true, role: 'agent', label: 'coder', ...over });

  test('(+) a live agent shows its kind: #sess-kind holds the chip (word and title) and is shown', () => {
    const r = rig();
    r.run(a());
    assert.equal(r.$('sess-kind').hidden, false);
    assert.equal(r.$('sess-kind').kids.length, 1);
    assert.equal(r.$('sess-kind').kids[0].className, 'agent-kind');
    assert.equal(r.$('sess-kind').kids[0].textContent, 'coder');
    assert.equal(r.$('sess-kind').kids[0].attrs.title, 'Kind: coder, writes and changes code');
  });

  test('(+) every word of the list; a later poll replaces the chip, it does not add one', () => {
    const r = rig();
    for (const w of ['coder', 'reviewer', 'tester', 'designer', 'scout', 'writer', 'agent']) {
      r.run(a({ label: w }));
      assert.deepEqual(r.$('sess-kind').kids.map((k) => k.textContent), [w], w);
    }
  });

  test('(−) hidden and empty for a sub-orchestrator, the orchestrator, a user\'s own session and an ended one', () => {
    for (const over of [{ role: 'sub-orchestrator', label: 'sub-orchestrator' }, { role: 'orchestrator', label: null }, { role: null, label: null }, { live: false, label: null }, { label: undefined }]) {
      const r = rig();
      r.run(a(over));
      assert.equal(r.$('sess-kind').hidden, true, JSON.stringify(over));
      assert.equal(r.$('sess-kind').kids.length, 0, JSON.stringify(over));
    }
  });

  test('(−) a chip that was shown goes away again when the poll says the session has no label (the window follows a pane after /clear)', () => {
    const r = rig();
    r.run(a());
    assert.equal(r.$('sess-kind').hidden, false);
    r.run(a({ role: null, label: null }));
    assert.equal(r.$('sess-kind').hidden, true);
    assert.equal(r.$('sess-kind').kids.length, 0);
  });

  test('(−) a label the page does not know is not drawn (a word outside the list, a kind on a sub-orchestrator)', () => {
    for (const over of [{ label: 'boss' }, { label: 'Coder' }, { label: 5 }, { role: 'sub-orchestrator', label: 'coder' }]) {
      const r = rig();
      r.run(a(over));
      assert.equal(r.$('sess-kind').hidden, true, JSON.stringify(over));
    }
  });

  test('(+) wiring: applyAgent draws it beside the role badge, after renderRole, in the normal window only (the subagent view returns first)', () => {
    const fn = fnOf('function applyAgent(');
    assert.match(fn, /renderRole\(agent\);\s*renderKind\(agent\);/);
    assert.ok(fn.indexOf('applySubagent(agent)') < fn.indexOf('renderKind(agent)'), 'the subagent view is handled first');
    assert.match(JS['session.js'], /import \{[^}]*\blabelEl\b[^}]*\} from '\.\/dom\.js'/);
    assert.match(JS['session.js'], /import \{[^}]*\bagentLabelView\b[^}]*\bsubLabelView\b[^}]*\} from '\.\/dash-model\.js'|import \{[^}]*\bsubLabelView\b[^}]*\bagentLabelView\b[^}]*\} from '\.\/dash-model\.js'/);
  });
});
