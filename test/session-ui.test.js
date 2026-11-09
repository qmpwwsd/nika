// Static checks on the session window files (public/session.{html,js,css}, public/mirror-render.js): strict-CSP rules,
// forbidden DOM sinks, ids used by the script exist in the page, key chips are on the server's allow-list.
// The browser itself is exercised by hand (Playwright); these checks keep the rules from regressing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { KEY_NAME } from '../src/ids.js';
import { moveActive as moveActiveReal, cleanCommands as cleanCommandsReal, paletteQuery as paletteQueryReal, shouldFetch as shouldFetchReal } from '../public/palette.js';
import { wantsHelp, wantsBack, isTextEntry, backHint, helpHint, passKeyLabel } from '../public/shortcuts.js';
import { quickState as quickStateReal, sendGate as sendGateReal, keysRefusal as keysRefusalReal, stopOutcome as stopOutcomeReal, commandSaid as commandSaidReal, commandFailure as commandFailureReal, problemKind as problemKindReal, followSession as followSessionReal, planShell as planShellReal, cleanPrompt as cleanPromptReal, hasAnswerButtons as hasAnswerButtonsReal, attnNote as attnNoteReal, answerOutcome as answerOutcomeReal, promptOff as promptOffReal } from '../public/quick-actions.js';
import { planSend as planSendReal } from '../public/mirror-render.js';
import { switchFailure as switchFailureReal } from '../public/modes.js';

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

  test('(+) every key chip is on the server allow-list and the set matches the spec', () => {
    const keys = [...HTML.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(keys, ['Escape', 'C-c', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'Enter']);
    for (const k of keys) assert.ok(KEY_NAME.has(k), k);
  });
});

describe('contracts with the other UI modules', () => {
  test('(+) session.js imports only names the shared modules export, from sibling files', () => {
    const imports = [...JS['session.js'].matchAll(/import \{([^}]+)\} from '([^']+)'/g)];
    assert.deepEqual(imports.map((m) => m[2]), ['./dom.js', './api.js', './mirror-render.js', './modes.js', './quick-actions.js', './models-ui.js', './end-dialog.js', './palette.js', './shortcuts.js']);
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

  test('(+) header order: status pill, mode tag, meta, spacer, switcher, reason line, claude link', () => {
    const order = ['id="sess-st"', 'id="sess-mode"', 'class="sess-meta"', 'class="sp"', 'id="mode-switch"', 'id="msw-why"', 'id="claude-link"'].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(at('id="sess-mode"') < at('</header>'));
    assert.ok(at('id="claude-link"') < at('</header>'));
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

  test('(+) the Shift-Tab and Enter key chips stay in the key row (aria-disabled by script while a prompt needs an answer)', () => {
    assert.match(HTML, /<button type="button" class="key" data-key="BTab" title="Shift-Tab cycles Claude&rsquo;s permission mode">Shift-Tab<\/button>/);
    assert.match(HTML, /<button type="button" class="key" data-key="Enter">Enter<\/button>/);
    const src = code(JS['session.js']);
    assert.match(src, /Answer the prompt first/);
    assert.match(src, /aria-disabled/);
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

  test('(+) every data-key used, in the page and in the script, is on the server allow-list', () => {
    const used = new Set([...HTML.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]));
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
    assert.match(fn(src, 'function renderGatedKeys()'), /sendGate\(\{ promptOpen: W\.promptOpen, status: A\.kind \}\)/);
    assert.match(fn(src, 'async function sendComposer()'), /sendGate\(\{ promptOpen: W\.promptOpen, status: A\.kind, buttons: W\.pane === 'ok' && hasAnswerButtons\(W\.prompt\) \}\)/, 'the wording reads the panel; whether it is held does not');
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
    const box = HTML.slice(HTML.indexOf('<div class="inbox">'), HTML.indexOf('<div class="keys"'));
    assert.ok(box.includes('id="pal"') && box.includes('id="palette"'));
    for (const n of ['i-cmd', 'i-dialog']) assert.match(HTML, new RegExp(`<symbol id="${n}"`));
  });

  test('(+) the hint line gains the "/ commands" tip and a hidden slot for the argument hint', () => {
    assert.match(HTML, /<span class="tip"><kbd>\/<\/kbd> commands<\/span>/);
    assert.match(tag('arg-hint'), /\bhidden\b/);
    assert.ok(HTML.indexOf('class="hintline"') < HTML.indexOf('id="arg-hint"'));
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

  // The keydown handler runs for real against stubs, so the key rules are proven, not just spelled.
  const press = (state, event) => {
    const calls = [];
    const ta = { selectionStart: 0, selectionEnd: 0, addEventListener(type, f) { if (type === 'keydown') this.keydown = f; } };
    const ctx = {
      composer: () => ta, $: () => ({ addEventListener() {} }), document: { querySelectorAll: () => [] },
      PL: state.PL, Q: { pop: state.pop === true }, S: { on: false }, moveActive: moveActiveReal,
      grow() {}, updateChip() {}, wirePalette() {}, setPass() {},
      sendComposer: () => calls.push('send'), sendKey: (k) => calls.push(`key ${k}`), closeModelPop: () => calls.push('model'),
      closePalette: () => calls.push('palette'), insertActive: () => calls.push('insert'), setActive: (i) => calls.push(`active ${i}`),
    };
    vm.runInNewContext(`${fnOf('function wireComposer()')}; wireComposer`, ctx)();
    const e = { key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    ta.keydown(e);
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

  test('(−) with no active option Tab and the arrows keep their normal job (focus move, caret)', () => {
    for (const state of [CLOSED, { PL: { open: true, active: -1, shown: [] } }]) {
      for (const key of ['Tab', 'ArrowDown', 'ArrowUp']) assert.deepEqual(press(state, { key }), { calls: [], prevented: false }, key);
    }
  });

  test('(−) Shift+Enter and Shift+Tab are not the palette\'s: a new line and a backwards Tab', () => {
    assert.deepEqual(press(OPEN(0), { key: 'Enter', shiftKey: true }), { calls: [], prevented: false });
    assert.deepEqual(press(OPEN(0), { key: 'Tab', shiftKey: true }), { calls: [], prevented: false });
  });

  test('(−) keys during IME composition are left alone', () => {
    assert.deepEqual(press(OPEN(0), { key: 'Enter', isComposing: true }), { calls: [], prevented: false });
    assert.deepEqual(press(OPEN(0), { key: 'ArrowDown', keyCode: 229 }), { calls: [], prevented: false });
  });

  test('(+) the Esc ladder: model popover first, then the palette, then the pane', () => {
    assert.deepEqual(press({ ...OPEN(0), pop: true }, { key: 'Escape' }).calls, ['model']);
    assert.deepEqual(press(OPEN(0), { key: 'Escape' }).calls, ['palette']);
    assert.deepEqual(press({ PL: { open: true, active: -1, shown: [] } }, { key: 'Escape' }).calls, ['palette'], 'an open list with no option closes too');
    assert.deepEqual(press(CLOSED, { key: 'Escape' }).calls, ['key Escape']);
    const rung = /if \(Q\.pop\) closeModelPop\(true\);\s*else if \(PL\.open\) closePalette\(\);\s*else sendKey\('Escape'\);/;
    assert.match(fnOf('function wireComposer()'), rung);
  });

  test('(+) closing keeps the text: Esc and closePalette never write the box', () => {
    assert.doesNotMatch(fnOf('function closePalette()'), /\.value\s*=[^=]/);
    const esc = /else if \(e\.key === 'Escape'\) \{[\s\S]*?\n {4}\}/.exec(fnOf('function wireComposer()'))?.[0] ?? '';
    assert.doesNotMatch(esc, /\.value\s*=[^=]/);
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
    const log = { opened: [], clicks: 0, prevented: 0 };
    const ctx = {
      MAC: mac, UI: { singleKey }, P: { on: passthrough }, wantsHelp, wantsBack, isTextEntry,
      openKbd: (opener) => log.opened.push(opener),
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
    assert.deepEqual([k.log.opened.length, k.log.clicks, k.log.prevented], [0, 0, 0]);
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

  const chipRig = () => {
    const chips = { BTab: el({ title: 'Shift-Tab cycles Claude\u2019s permission mode' }), Enter: el({ title: '' }), Escape: el({ title: 'Send Escape (interrupts Claude)' }) };
    const asked = [];
    const document = { querySelector: (sel) => { const name = /data-key="([A-Za-z]+)"/.exec(sel)[1]; asked.push(name); return chips[name]; } };
    const W = { promptOpen: false };
    const A = { kind: 'idle' };
    const run = mk(['function renderGatedKeys()'], { document, SW: { keyTitle: {} }, W, A, sendGate: sendGateReal }).renderGatedKeys;
    return { chips, asked, W, A, run };
  };

  test('(+) B1: the Enter chip is aria-disabled with "Answer the prompt first", exactly like Shift-Tab, while a prompt is open', () => {
    const r = chipRig();
    r.W.promptOpen = true;
    r.run();
    for (const name of ['BTab', 'Enter']) {
      assert.equal(r.chips[name].attrs['aria-disabled'], 'true', name);
      assert.equal(r.chips[name].title, 'Answer the prompt first', name);
    }
    assert.deepEqual(r.asked.sort(), ['BTab', 'Enter'], 'Esc (the No path) and the rest are never touched');
    assert.equal(r.chips.Escape.attrs['aria-disabled'], undefined);
  });

  test('(+) B1: needing you alone gates both chips; when it ends they get their own titles back', () => {
    const r = chipRig();
    r.A.kind = 'attn';
    r.run();
    assert.equal(r.chips.Enter.attrs['aria-disabled'], 'true');
    r.A.kind = 'idle';
    r.run();
    assert.equal(r.chips.BTab.attrs['aria-disabled'], 'false');
    assert.equal(r.chips.Enter.attrs['aria-disabled'], 'false');
    assert.equal(r.chips.BTab.title, 'Shift-Tab cycles Claude\u2019s permission mode');
    assert.equal(r.chips.Enter.title, '', 'Enter had no title; it has none again');
  });

  test('(−) B1: with no prompt neither chip is disabled', () => {
    const r = chipRig();
    r.run();
    assert.equal(r.chips.BTab.attrs['aria-disabled'], 'false');
    assert.equal(r.chips.Enter.attrs['aria-disabled'], 'false');
  });

  test('(+) B1: a click on an aria-disabled chip sends nothing and hands the focus to the box', async () => {
    const clicks = [];
    const chip = (name, off) => ({ dataset: { key: name }, attrs: { 'aria-disabled': String(off) }, getAttribute(k) { return this.attrs[k] ?? null; }, addEventListener(type, f) { clicks.push([name, f]); } });
    const ta = { focused: 0, selectionStart: 0, selectionEnd: 0, addEventListener() {}, focus() { this.focused += 1; } };
    const sent = [];
    const ctx = {
      composer: () => ta, $: () => ({ addEventListener() {} }), document: { querySelectorAll: () => [chip('Enter', true), chip('Tab', false)] }, PL: {}, Q: {}, S: {},
      grow() {}, updateChip() {}, wirePalette() {}, setShell() {}, sendComposer() {}, sendKey: async (n) => { sent.push(n); return true; },
    };
    mk(['function wireComposer()'], ctx).wireComposer();
    for (const [, f] of clicks) await f();
    assert.deepEqual(sent, ['Tab'], 'only the live chip sends');
    assert.equal(ta.focused, 2, 'both clicks end with focus in the box');
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

  test('(+) B2: the Stop button runs stop(); Esc = No and the Esc key chip stay on the keys route', () => {
    assert.match(SRC, /on\('stop', stop\);/);
    assert.doesNotMatch(SRC, /on\('stop', \(\) => sendKey/);
    assert.match(fnOf('async function escNo()'), /await sendKey\('Escape'\)/);
    assert.match(HTML, /data-key="Escape"/);
    assert.match(fnOf('function wireComposer()'), /else sendKey\('Escape'\)/, 'the Esc ladder\'s last rung is unchanged');
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

  const whyRig = (msg, reason = '') => {
    const why = { hidden: false, className: '', kids: [], replaceChildren(...n) { this.kids = n; } };
    const h = (tag, attrs) => ({ tag, text: attrs?.text });
    const ctx = { W: { msg, whySig: '' }, $: () => why, h, icon: (n) => ({ icon: n }), bypassTag: () => ({ tag: 'bypass-tag' }) };
    mk(['function renderWhy(st)'], ctx).renderWhy({ reason, chip: null });
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
    assert.deepEqual(refused.log.problems, [["Claude's input has text; clear it first.", 'warn']]);
    assert.deepEqual(refused.log.said, []);
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
  test('(+) B9: the passthrough key reads ctrl-glyph + "]" on a Mac and "Ctrl+]" elsewhere, in the toggle, its title, the banner and the hint line', () => {
    const run = (mac) => {
      const kbds = [{ textContent: 'Ctrl+]' }, { textContent: 'Ctrl+]' }, { textContent: 'Ctrl+]' }];
      const toggle = { title: '' };
      mk(['function syncPassKeys()'], { MAC: mac, passKeyLabel, document: { querySelectorAll: (sel) => (sel === 'kbd[data-passkey]' ? kbds : []) }, $: (id) => (id === 'pass-toggle' ? toggle : null) }).syncPassKeys();
      return { kbds: kbds.map((k) => k.textContent), title: toggle.title };
    };
    assert.deepEqual(run(true), { kbds: ['\u2303]', '\u2303]', '\u2303]'], title: 'Type straight into the pane (\u2303])' });
    assert.deepEqual(run(false), { kbds: ['Ctrl+]', 'Ctrl+]', 'Ctrl+]'], title: 'Type straight into the pane (Ctrl+])' });
  });

  test('(+) B9: the markup marks all three places with data-passkey and keeps aria-keyshortcuts as Control+]', () => {
    assert.equal([...HTML.matchAll(/<kbd data-passkey>Ctrl\+\]<\/kbd>/g)].length, 3, 'toggle, banner, hint line');
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

  test('(+) B7: the switcher side, the claude.ai link and the shortcuts button sit in one right-hand block; the last two in a group of their own', () => {
    const at = (needle) => header.indexOf(needle);
    const order = ['class="bar-end"', 'id="mode-switch"', 'id="msw-why"', 'class="bar-tools"', 'id="claude-link"', 'id="kbd-open"'].map(at);
    assert.ok(order.every((i) => i > 0), 'all six are in the header');
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    const tools = header.slice(at('class="bar-tools"'));
    assert.ok(tools.includes('id="claude-link"') && tools.includes('id="kbd-open"'));
    assert.ok(!tools.includes('id="mode-switch"') && !tools.includes('id="msw-why"'), 'the group is just the link and the button');
  });

  test('(+) B7: the pair never wraps apart (nowrap); the right-hand block wraps as one flex item of the bar', () => {
    assert.match(rule('.bar-tools') ?? '', /display:\s*flex/);
    assert.match(rule('.bar-tools') ?? '', /flex-wrap:\s*nowrap/);
    assert.match(rule('.bar-end') ?? '', /flex-wrap:\s*wrap/);
    assert.match(rule('.bar') ?? '', /flex-wrap:\s*wrap/, 'the bar itself still wraps, so a narrow window moves the block, not a lone button');
  });

  test('(+) 320 px: .composer is a grid with one shrinkable column, so a wide child (key chips, tool row) cannot push the window sideways', () => {
    const body = rule('.composer') ?? '';
    assert.match(body, /display:\s*grid/);
    assert.match(body, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  test('(−) 320 px: the one grid with a fixed pixel column (.split, 300 px) collapses to a single shrinkable column below 1000 px, so the composer fix is not undone one level up', () => {
    const wide = [...css.matchAll(/([^{}@]+)\{[^{}]*grid-template-columns:\s*([^;}]*\b\d{3,}px\b[^;}]*)[;}]/g)].map((m) => m[1].trim());
    assert.deepEqual(wide, ['.split'], 'a new fixed-width grid column needs its own 320 px check');
    assert.match(css, /@media \(max-width:\s*1000px\)\s*\{[^@]*?\.split \{ grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  });

  test('(−) B7: the grouping adds no colour and no token', () => {
    for (const sel of ['.bar-tools', '.bar-end']) {
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
