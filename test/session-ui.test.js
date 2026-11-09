// Static checks on the session window files (public/session.{html,js,css}, public/mirror-render.js): strict-CSP rules,
// forbidden DOM sinks, ids used by the script exist in the page, key chips are on the server's allow-list.
// The browser itself is exercised by hand (Playwright); these checks keep the rules from regressing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_NAME } from '../src/ids.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const HTML = read('session.html');
const JS = {
  'session.js': read('session.js'), 'mirror-render.js': read('mirror-render.js'), 'modes.js': read('modes.js'),
  'quick-actions.js': read('quick-actions.js'), 'models-ui.js': read('models-ui.js'), 'end-dialog.js': read('end-dialog.js'),
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
    assert.deepEqual(imports.map((m) => m[2]), ['./dom.js', './api.js', './mirror-render.js', './modes.js', './quick-actions.js', './models-ui.js', './end-dialog.js']);
    for (const [, names, from] of imports) {
      const exported = read(from.slice(2));
      for (const n of names.split(',').map((x) => x.trim())) assert.match(exported, new RegExp(`export (async )?(function|const|let) ${n}\\b`), `${from} exports ${n}`);
    }
  });

  test('(−) session.js talks to /api/app through appFetch only; its one public route goes through getJSON', () => {
    const src = code(JS['session.js']);
    const paths = [...src.matchAll(/['"`](\/api\/[^'"`]*)/g)].map((m) => m[1]);
    assert.ok(paths.length > 0);
    for (const p of paths) assert.match(p, /^\/api\/(app\/(session|pane|settings|projects|models)|agents\?since=all)/, p);
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

  test('(+) the Shift-Tab key chip stays in the key row (aria-disabled by script while a prompt needs an answer)', () => {
    assert.match(HTML, /<button type="button" class="key" data-key="BTab" title="Shift-Tab cycles Claude&rsquo;s permission mode">Shift-Tab<\/button>/);
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
    assert.match(whole('qa-end'), /class="btn danger"/);
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
    assert.match(whole('end-go'), /class="btn danger"/);
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
    assert.match(whole('clear-go'), /class="btn danger"/);
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
    assert.match(src, /keys: \['Escape', 'Escape'\]/, 'Rewind is Esc Esc');
    assert.doesNotMatch(src, /text: '\/(compact|clear|model)/, 'no command text goes through the keys route');
  });

  test('(+) a model is only sent from the Switch model button, never on a change event', () => {
    const src = code(JS['session.js']);
    assert.doesNotMatch(src, /model-sel['"]\)\.addEventListener\('change',[^)]*sendCommand/);
    const change = /addEventListener\('change',([\s\S]*?)\}\);/.exec(src)?.[1] ?? '';
    assert.doesNotMatch(change, /sendCommand/);
  });

  test('(−) the new modules never spell the refused mode (test/ui.test.js allows that only in modes.js)', () => {
    for (const f of ['session.js', 'quick-actions.js', 'models-ui.js', 'end-dialog.js']) assert.doesNotMatch(JS[f], new RegExp(['bypass', 'Permissions'].join('')), f);
  });

  test('(+) the prompt panel, quick actions and dialogs have styles: qa row, reason line, prompt buttons, dialog, toast', () => {
    const css = strip(CSS);
    for (const sel of ['\\.qa', '\\.qa-why', '\\.ask', '\\.pbtn', '\\.pbtn-off', '\\.pbtn\\[aria-disabled="true"\\]', '\\.pop', 'dialog', 'dialog::backdrop', '\\.dlg-foot', '\\.alert\\[data-kind="danger"\\]', '\\.toast']) {
      assert.match(css, new RegExp(`(^|[\\s,}])${sel}[\\s,{:\\[]`), sel);
    }
  });
});
