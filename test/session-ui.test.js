// Static checks on the session window files (public/session.{html,js,css}, public/mirror-render.js): strict-CSP rules,
// forbidden DOM sinks, ids used by the script exist in the page, the keys the page asks for are on the server's allow-list.
// The browser itself is exercised by hand (Playwright); these checks keep the rules from regressing.
import { test, describe, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { KEY_NAME } from '../src/ids.js';
import { moveActive as moveActiveReal, cleanCommands as cleanCommandsReal, paletteQuery as paletteQueryReal, shouldFetch as shouldFetchReal } from '../public/palette.js';
import { wantsHelp, wantsBack, wantsHistToggle, isTextEntry, backHint, helpHint, histHint, passKeyLabel, hintTips as hintTipsReal } from '../public/shortcuts.js';
import { quickState as quickStateReal, sendGate as sendGateReal, keysRefusal as keysRefusalReal, stopOutcome as stopOutcomeReal, commandSaid as commandSaidReal, commandFailure as commandFailureReal, problemKind as problemKindReal, followSession as followSessionReal, planShell as planShellReal, cleanPrompt as cleanPromptReal, hasAnswerButtons as hasAnswerButtonsReal, attnNote as attnNoteReal, answerOutcome as answerOutcomeReal, promptOff as promptOffReal, composerKey as composerKeyReal } from '../public/quick-actions.js';
import { planSend as planSendReal, arrowEcho as arrowEchoReal } from '../public/mirror-render.js';
import { switchFailure as switchFailureReal, MODE_TARGETS, MODE_META } from '../public/modes.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const HTML = read('session.html');
const JS = {
  'session.js': read('session.js'), 'mirror-render.js': read('mirror-render.js'), 'modes.js': read('modes.js'),
  'quick-actions.js': read('quick-actions.js'), 'models-ui.js': read('models-ui.js'), 'end-dialog.js': read('end-dialog.js'),
  'palette.js': read('palette.js'), 'shortcuts.js': read('shortcuts.js'),
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
    assert.deepEqual(imports.map((m) => m[2]), ['./dom.js', './api.js', './dash-model.js', './mirror-render.js', './modes.js', './quick-actions.js', './models-ui.js', './end-dialog.js', './palette.js', './shortcuts.js']);
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

  test('(+) 0.3.3: the mode row sits in the composer after the message box and before the hint line; it is hidden until the script wires the switcher', () => {
    const box = HTML.slice(at('id="composer-box"'));
    const order = ['class="inbox"', 'id="mode-row"', 'id="mode-switch"', 'id="msw-why"', 'class="hintline"'].map((n) => box.indexOf(n));
    assert.ok(order.every((i) => i > 0), 'all five are in #composer-box');
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(tagOf('mode-row'), /\bclass="mode-row"/);
    assert.match(tagOf('mode-row'), /\bhidden\b/);
    const row = new RegExp('<div class="mode-row" id="mode-row"[^>]*>([\\s\\S]*?)</div>\\s*<div class="hintline"').exec(HTML)?.[1] ?? '';
    assert.ok(row.includes('id="mode-switch"') && row.includes('id="msw-why"'), 'both inside #mode-row');
    assert.match(row, /<span class="mode-lbl" aria-hidden="true">Mode<\/span>/);
  });

  test('(−) 0.3.3: the "Mode" word is decoration (aria-hidden): the toolbar has its own label; the row is not a live region', () => {
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
    for (const k of ['Escape', 'C-u', 'Enter']) assert.ok(used.has(k), `${k} is sent somewhere`);
    for (const k of used) assert.ok(KEY_NAME.has(k), k);
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
    assert.match(wire, /buttons: W\.pane === 'ok' && hasAnswerButtons\(W\.prompt\), bypass: W\.prompt\?\.bypass === true/);
    assert.doesNotMatch(wire, /sendGate/, 'wireComposer holds no gate of its own: composerKey does');
    assert.doesNotMatch(src, /renderGatedKeys/);
    assert.match(fn(src, 'async function sendComposer()'), /sendGate\(\{ promptOpen: W\.promptOpen, status: A\.kind, buttons: W\.pane === 'ok' && hasAnswerButtons\(W\.prompt\), bypass: W\.prompt\?\.bypass === true \}\)/, 'the wording reads the panel and the capture\'s bypass mark; whether it is held does not');
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

  test('(−) 0.3.3: the markup has no static tip; the hint line has an id for renderTips and a hidden slot for the argument hint', () => {
    assert.doesNotMatch(HTML, /class="tip"|class="tip more"/);
    assert.match(HTML, /<div class="hintline" id="hintline">/);
    assert.match(tag('arg-hint'), /\bhidden\b/);
    assert.ok(HTML.indexOf('id="hintline"') < HTML.indexOf('id="arg-hint"'));
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
      W: { pane: state.pane ?? 'ok', promptOpen: state.promptOpen === true, prompt: null }, A: { kind: state.status ?? 'idle' },
      composerKey: composerKeyReal, hasAnswerButtons: hasAnswerButtonsReal, moveActive: moveActiveReal,
      grow() {}, updateChip() {}, wirePalette() {}, setPass: () => calls.push('pass'),
      sendComposer: () => calls.push('send'), sendKey: (k) => calls.push(`key ${k}`), closeModelPop: (r) => calls.push(`model ${r}`),
      closePalette: () => calls.push('palette'), insertActive: () => calls.push('insert'), setActive: (i) => calls.push(`active ${i}`),
      queueArrow: (k, repeat) => calls.push(`arrow ${k}${repeat ? ' repeat' : ''}`), endArrows: () => { ends += 1; return state.arrows === true; }, chain: state.chain ?? Promise.resolve(), stop: () => calls.push('stop'),
      showProblem: (m, kind, ms) => calls.push(`problem ${m} | ${kind} | ${ms}`),
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

  test('(+) 0.3.3: Ctrl+C while Claude works runs Stop (the stop route, not a key); it is not queued as C-c', () => {
    assert.deepEqual(press({ ...CLOSED, status: 'busy' }, { key: 'c', ctrlKey: true }), { calls: ['stop'], prevented: true });
    assert.equal(press.ends, 1);
  });

  test('(−) 0.3.3: Ctrl+C while Claude waits, asks or connects sends nothing and says why for 3 s', () => {
    const line = (m) => ({ calls: [`problem ${m} | warn | 3000`], prevented: true });
    assert.deepEqual(press({ ...CLOSED, status: 'idle' }, { key: 'c', ctrlKey: true }), line('Nothing to stop: Claude is waiting.'));
    assert.deepEqual(press({ ...CLOSED, status: 'attn' }, { key: 'c', ctrlKey: true }), line('Answer the prompt first.'));
    assert.deepEqual(press({ ...CLOSED, status: 'busy', promptOpen: true }, { key: 'c', ctrlKey: true }), line('Answer the prompt first. Esc = No is in the prompt panel.'));
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
    const log = { problems: [], sent: [], said: [], shellOff: 0 };
    const ta = { value, disabled: false };
    const ctx = {
      sending: false, composer: () => ta, S: { on: shell }, W: { promptOpen, prompt, pane }, A: { kind }, sendGate: sendGateReal, hasAnswerButtons: hasAnswerButtonsReal, planShell: planShellReal, planSend: planSendReal,
      showProblem: (m, k) => log.problems.push([m, k]), enqueueSeq: async (p) => { log.sent.push(p); return { ok: true }; }, $: () => el(), say: (m) => log.said.push(m),
      paneId: '%12', setShell: () => { log.shellOff += 1; }, grow() {}, updateChip() {},
    };
    return { log, ta, send: mk(['async function sendComposer()'], ctx).sendComposer };
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

  test('(−) B1: with no prompt everything goes out as before: a line, an empty box (Enter), Shell (three bodies, then Shell off)', async () => {
    const line = composerRig({ value: 'hello' });
    await line.send();
    assert.equal(line.log.sent.length, 1);
    assert.equal(line.log.sent[0].length, 1, 'one body');
    assert.equal(line.log.problems.length, 0);
    assert.equal(line.ta.value, '', 'the box is emptied after a send');
    const empty = composerRig({ value: '' });
    await empty.send();
    assert.equal(empty.log.sent.length, 1);
    const shell = composerRig({ value: 'ls', shell: true });
    await shell.send();
    assert.deepEqual(norm(shell.log.sent[0]), [{ keys: ['C-u'] }, { text: '!ls' }, { keys: ['Enter'] }]);
    assert.equal(shell.log.shellOff, 1);
  });

  test('(−) B1: passthrough is the raw terminal path and is not gated by this rule', () => {
    for (const head of ['function flushPass()', 'function wirePassthrough()', 'function setPass(']) assert.doesNotMatch(fnOf(head), /sendGate/, head);
  });

  const deliverRig = (response) => {
    const log = { problems: [], gone: 0 };
    const ctx = {
      M: { gone: false }, paneId: '%12', call: async () => response, showProblem: (m, k, ms) => log.problems.push([m, k, ms]), clearProblem() {}, setGone: () => { log.gone += 1; },
      sleep: async () => {}, RATE_MSG: 'Too fast.', keysRefusal: keysRefusalReal, serverMessage: (r, fb) => (typeof r.body?.message === 'string' ? r.body.message : fb),
    };
    return { log, deliver: mk(['async function deliver(payload)'], ctx).deliver };
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
    const ctx = { $: (id) => (id === 'attn-note' ? note : text), W: { pane, prompt }, A: { kind, name: 'builder-1', attention: 'Asking to run a command' }, attnNote: attnNoteReal, passKeyLabel, MAC: mac };
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
  const stopRig = ({ status = 200, body = { stopped: true, presses: 1 }, busy = null, stopping = false, gone = false } = {}) => {
    const log = { calls: [], said: [], problems: [], gone: 0, cleared: 0, renders: 0, marks: [] };
    const Q = { busy, stopping };
    const ctx = {
      Q, M: { gone }, paneId: '%12', A: { name: 'builder-1' }, renderQuick: () => { log.renders += 1; log.marks.push(Q.stopping); }, stopOutcome: stopOutcomeReal, problemKind: problemKindReal,
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
  const cmdRig = ({ status = 200, body = { sent: true } } = {}) => {
    const log = { calls: [], said: [], problems: [], gone: 0 };
    const ctx = {
      Q: { busy: null }, M: { gone: false }, paneId: '%12', renderQuick() {}, call: async (path, opts) => { log.calls.push([path, opts]); return { status, body }; }, clearProblem() {},
      say: (m) => log.said.push(m), setGone: () => { log.gone += 1; }, showProblem: (m, k) => log.problems.push([m, k]), commandFailure: commandFailureReal, commandSaid: commandSaidReal, problemKind: problemKindReal,
    };
    return { log, sendCommand: mk(['async function sendCommand(text)'], ctx).sendCommand };
  };

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

  test('(+) 320 px: .composer is a grid with one shrinkable column, so a wide child (the tool row, the mode row) cannot push the window sideways; it is the container the hint tips query', () => {
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
      $: () => ({ focus() {} }), refocus: { composer: false }, closePalette() {}, setPass() {}, idlePlaceholder: () => '',
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
      const ctx = { P: { on: was }, paneId: '%12', M: { gone: false }, composer: () => ({ disabled, focus() {} }), flushPass: () => log.push('flush'), $: el, announce() {}, A: { name: 'n' }, endArrows: () => log.push('end') };
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

  const tips = (mac) => {
    const line = { kids: [], prepend(...n) { this.kids = n; } };
    mk(['function renderTips()'], { $: (id) => { assert.equal(id, 'hintline'); return line; }, hintTips: hintTipsReal, MAC: mac, h }).renderTips();
    return line.kids;
  };

  test('(+) renderTips puts the platform\'s four tips in front of the hints: Linux words, macOS glyphs; two of them are "more"', () => {
    const linux = tips(false);
    assert.deepEqual(linux.map(plain), ['Esc Ctrl+C Shift+Tab go to Claude', '\u2191 \u2193 Enter too, in an empty box', 'Ctrl+Shift+Tab moves focus back', 'Ctrl+/ all shortcuts']);
    assert.deepEqual(linux.map((t) => t.class), ['tip', 'tip more', 'tip', 'tip more']);
    assert.deepEqual(tips(true).map(plain), ['Esc \u2303C \u21e7Tab go to Claude', '\u2191 \u2193 Enter too, in an empty box', '\u2303\u21e7Tab moves focus back', '\u2318/ all shortcuts']);
    assert.deepEqual(linux[0].kids.map((k) => k.tag ?? 'text'), ['kbd', 'text', 'kbd', 'text', 'kbd', 'text'], 'one keycap per key, a space between, then the words');
  });

  test('(−) renderTips builds text only (h, textContent) and runs once at boot, next to syncPassKeys', () => {
    assert.doesNotMatch(fnOf('function renderTips()'), /innerHTML|insertAdjacent/);
    assert.match(fnOf('function boot()'), /syncPassKeys\(\);\s*renderTips\(\);/);
    assert.equal((SRC.match(/renderTips\(\)/g) ?? []).length, 2, 'declared once, called once');
  });

  test('(+) the tips hide by the composer\'s width (container query, 940 px) and by window height (560 px)', () => {
    assert.match(css, /@container composer \(max-width: 940px\)\s*\{\s*\.hintline \.tip\.more\s*\{\s*display:\s*none;\s*\}\s*\}/);
    assert.match(css, /@media \(max-height: 560px\)\s*\{\s*\.hintline \.tip\s*\{\s*display:\s*none;\s*\}\s*\}/);
  });

  test('(−) the 760 px block no longer hides the tips or the switcher\'s words', () => {
    const block = /@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    assert.ok(block.length > 50, 'the block was found');
    assert.doesNotMatch(block, /\.hintline/);
    assert.doesNotMatch(block, /\.msw/);
    assert.match(block, /\.bar \.btn \.lbl, \.term-head \.btn \.lbl/, 'the header buttons still drop their labels');
  });

  test('(+) the message box name says where the keys go, in the markup and for a named agent', () => {
    const tail = ' Enter sends, Shift+Enter adds a line. Escape, Control+C and Shift+Tab go to Claude, and so do the arrow keys and Enter when the box is empty. Control+Shift+Tab moves focus back.';
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
