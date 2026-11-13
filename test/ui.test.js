// Static and served-file checks for the main UI (public/index.html, app.js, app.css and the modules they load).
// The browser itself is exercised by hand (Playwright); these checks keep the strict-CSP rules, the tier separation
// and the static file list from regressing. The session window has its own checks in session-ui.test.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeFixture, cleanup, fakeExec, NOW } from './helpers.js';
import { createServer } from '../src/server.js';
import { CUSTOM as CUSTOM_VALUE } from '../public/models-ui.js';
import { wantsHelp, wantsBack, isTextEntry, helpHint, backHint } from '../public/shortcuts.js';
import { copyBanner, copyErrorText, copyToast } from '../public/app-copy.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const files = fs.readdirSync(PUBLIC);
const JS = files.filter((f) => f.endsWith('.js'));
const HTML = files.filter((f) => f.endsWith('.html'));
const CSS = files.filter((f) => f.endsWith('.css'));

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

describe('forbidden sinks in every public script', () => {
  test('(+) the scan covers the main UI modules and the session window', () => {
    for (const f of ['app.js', 'api.js', 'dom.js', 'ui.js', 'project.js', 'settings.js', 'session.js', 'mirror-render.js']) {
      assert.ok(JS.includes(f), `${f} is scanned`);
    }
  });

  for (const f of JS) {
    test(`(−) ${f} uses no HTML-parsing, code-evaluating or style-string sink`, () => {
      assert.deepEqual(findSinks(read(f)), []);
    });
  }

  test('(−) the scanner itself catches each sink (so the checks above can fail)', () => {
    const samples = [
      'el.' + 'innerHTML = x', 'el.insertAdjacent' + "HTML('beforeend', x)", 'el.outer' + 'HTML = x', 'document.' + 'write(x)', 'ev' + 'al(x)',
      'new Func' + 'tion(x)', "el.setAttribute('" + "style', x)", 'el.style.css' + 'Text = x', 'f.src' + 'doc = x', 'a.href = "javascript' + ':1"',
      "el.setAttribute('on" + "click', x)", 'el.on' + 'click = f', 'new DOM' + 'Parser()',
    ];
    for (const s of samples) assert.notDeepEqual(findSinks(s), [], s);
    assert.deepEqual(findSinks('// el.' + 'innerHTML is forbidden\nconst a = 1; /* ev' + 'al( */'), [], 'comments are ignored');
  });

  test('(+) untrusted text goes through textContent (dom.js h() text attribute and text nodes)', () => {
    const dom = code(read('dom.js'));
    assert.match(dom, /textContent/);
    assert.match(dom, /createTextNode/);
  });

  test('(−) the main UI never builds a style string, reads cookies, or talks to another origin', () => {
    for (const f of ['app.js', 'ui.js', 'dom.js', 'project.js', 'settings.js']) {
      const c = code(read(f));
      assert.doesNotMatch(c, /\.style\.cssText|setAttribute\s*\(\s*['"`]style/, f);
      assert.doesNotMatch(c, /document\.cookie|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, f);
      assert.doesNotMatch(c, /https?:\/\/(?!claude\.ai\/code\/|www\.w3\.org\/2000\/svg)/, f); // the SVG namespace is an identifier, not a request
    }
  });

  test('(−) no module outside api.js can read the secret or send the app header', () => {
    for (const f of JS.filter((x) => x !== 'api.js')) {
      assert.doesNotMatch(code(read(f)), /__NIKA_APP__|X-Nika-App/i, f);
    }
  });
});

describe('HTML pages under the strict CSP', () => {
  test('(+) every page is scanned', () => {
    assert.deepEqual(HTML.sort(), ['index.html', 'session.html']);
  });

  for (const f of HTML) {
    test(`(−) ${f} has no inline script or style, style attribute, on* attribute or javascript: URL`, () => {
      const src = read(f);
      for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        assert.match(m[1], /\bsrc="[^"]+"/, 'script must be external');
        assert.equal(m[2].trim(), '', 'script must have no inline body');
      }
      assert.doesNotMatch(src, /<style\b/i);
      assert.doesNotMatch(src, /\sstyle\s*=/i);
      assert.doesNotMatch(src, /\son[a-z]+\s*=/i);
      assert.doesNotMatch(src, /javascript:/i);
      assert.doesNotMatch(src, /<(iframe|object|embed|base)\b/i);
      for (const m of src.matchAll(/<form\b[^>]*>/gi)) assert.doesNotMatch(m[0], /\s(action|method)\s*=/i, 'forms are handled in JS; the CSP has form-action none');
    });
  }

  test('(+) index.html: one module script, tokens.css then app.css, one token placeholder, no external URL', () => {
    const src = read('index.html');
    const scripts = [...src.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /type="module"/);
    assert.match(scripts[0], /src="\/?app\.js"/);
    const links = [...src.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].map((m) => /href="([^"]+)"/.exec(m[0])[1]);
    assert.deepEqual(links.map((l) => l.replace(/^\//, '')), ['tokens.css', 'app.css']);
    assert.equal(src.split('__NIKA_TOKEN__').length - 1, 1, 'the server replaces the placeholder once');
    assert.deepEqual([...src.matchAll(/(?:src|href)="(https?:[^"]*)"/g)].map((m) => m[1]), []);
  });

  test('(+) index.html: ids are unique and every id the scripts look up exists', () => {
    const src = read('index.html');
    const ids = [...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
    const missing = new Set();
    // ids that the scripts create themselves (e.g. the rules dialog's alert) count as present
    const made = new Set();
    for (const f of ['app.js', 'ui.js', 'project.js', 'settings.js']) for (const m of code(read(f)).matchAll(/\bid:\s*'([A-Za-z0-9_-]+)'/g)) made.add(m[1]);
    for (const f of ['app.js', 'ui.js', 'project.js', 'settings.js']) {
      const c = code(read(f));
      for (const m of c.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)) if (!ids.includes(m[1]) && !made.has(m[1])) missing.add(`${f}: #${m[1]}`);
      for (const m of c.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) if (!ids.includes(m[1]) && !made.has(m[1])) missing.add(`${f}: #${m[1]}`);
    }
    assert.deepEqual([...missing], []);
  });

  test('(+) index.html: landmarks, skip link, live regions and a single h1 per screen', () => {
    const src = read('index.html');
    assert.match(src, /<a class="skip" href="#main">/);
    assert.match(src, /<main\b[^>]*id="main"/);
    assert.match(src, /<nav\b/);
    assert.match(src, /id="announce"[^>]*aria-live="polite"/);
    assert.equal((src.match(/<h1\b/g) ?? []).length, 3, 'dashboard, project and settings');
    assert.equal((src.match(/<dialog\b/g) ?? []).length, 8, 'spawn, rules, plugins, models, confirm, report, end, keyboard shortcuts');
  });

  test('(+) index.html: app-only controls are marked so the browser tier removes them', () => {
    const src = read('index.html');
    assert.match(src, /<body[^>]*data-tier="browser"/);
    assert.match(src, /<nav\b[^>]*data-app-only/);
    assert.match(src, /data-browser-only/);
  });
});

describe('permission modes and the spawn brief', () => {
  const html = read('index.html');
  const project = read('project.js');
  const WARNING = /classifier approves actions without asking you/;

  test('(+) every place that offers the auto mode says a classifier approves actions without asking you: the Settings option and the spawn sheet / project labels', () => {
    const card = /<label class="radio-card">(?:(?!<\/label>)[^])*value="auto"(?:(?!<\/label>)[^])*<\/label>/.exec(html);
    assert.ok(card, 'the Settings radio card for auto exists');
    assert.match(card[0], WARNING);
    const label = /PERM_LABEL = \{[^}]*\bauto: '([^']+)'/.exec(project);
    assert.ok(label, 'project.js labels the auto mode (spawn sheet options and project view)');
    assert.match(label[1], WARNING);
  });

  test('(−) the other modes do not claim it, and bypassPermissions is offered nowhere', () => {
    for (const mode of ['default', 'manual', 'acceptEdits', 'plan', 'dontAsk']) {
      const card = new RegExp(`<label class="radio-card">(?:(?!</label>)[^])*value="${mode}"(?:(?!</label>)[^])*</label>`).exec(html);
      assert.ok(card, mode);
      assert.doesNotMatch(card[0], WARNING, mode);
    }
    for (const f of [...JS, ...HTML]) {
      let text = read(f).replace(/Bypass permissions is not offered[^<]*/, '');
      // modes.js must name the mode to show it (a session already in bypass gets the loud Bypass tag); it may do so only
      // in its display table, its loud-note check and bypassTag(), and its switch targets never include it
      if (f.endsWith('modes.js')) {
        assert.match(text, /export const MODE_TARGETS = \['manual', 'acceptEdits', 'plan', 'auto'\];/, f);
        text = text.replace(/\n {2}bypassPermissions: \{ label: 'Bypass',[^\n]*/, '').replace(/key === 'bypassPermissions' \?/, '').replace(/bypassTag = \(\) => modeEl\('bypassPermissions'\);/, '');
      }
      assert.doesNotMatch(text, /bypassPermissions/, f);
    }
  });

  // The spawn sheet's rule is the client half of src/spawn.js (parseRequest): run the page's own function.
  const briefProblem = (() => {
    const m = /\nfunction briefProblem\(text, bytes\) \{[^]*?\n\}\n/.exec(project);
    assert.ok(m, 'project.js defines briefProblem(text, bytes)');
    return vm.runInNewContext(`${m[0]}; briefProblem`, { BRIEF_MAX: 64 * 1024 });
  })();

  test('(−) the spawn sheet refuses an empty brief, a one-word brief and an oversized one before any request', () => {
    assert.match(briefProblem('', 0), /Write the first message/);
    assert.match(briefProblem('  \n', 3), /Write the first message/);
    for (const word of ['update', ' doctor ', 'mcp\n', '--help']) assert.match(briefProblem(word, word.length), /more than one word/, word);
    assert.match(briefProblem('two words', 64 * 1024 + 1), /over 64 KB/);
  });

  test('(+) two words or two lines pass, at the size limit too', () => {
    for (const ok of ['update docs', 'one\ntwo', ' a b ']) assert.equal(briefProblem(ok, ok.length), '', ok);
    assert.equal(briefProblem('two words', 64 * 1024), '');
  });
});

describe('CSS', () => {
  test('(−) no color-mix() and no :has() in any stylesheet', () => {
    for (const f of CSS) {
      const c = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(c, /color-mix\s*\(/, f);
      assert.doesNotMatch(c, /:has\s*\(/, f);
    }
  });

  test('(+) every var(--token) used by app.css is defined in tokens.css (or app.css itself)', () => {
    const defined = new Set([...(read('tokens.css') + read('app.css')).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...read('app.css').matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
    assert.deepEqual([...used].filter((t) => !defined.has(t)), []);
  });

  test('(+) tokens.css has the dark palette for both the OS preference and the pinned choice, and reduced motion', () => {
    const t = read('tokens.css');
    assert.match(t, /prefers-color-scheme:\s*dark/);
    assert.match(t, /:root\[data-theme="dark"\]/);
    assert.match(t, /:root\[data-theme="light"\]/);
    assert.match(t, /prefers-reduced-motion:\s*reduce/);
  });

  // A scroll container that is not positioned lets absolutely positioned descendants (.sr-only labels) anchor to the
  // page: the page grows as tall as the list and WebKit scrolls the whole window, leaving a blank band.
  const unanchoredScrollers = (css) => {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      sels: m[1].split(',').map((s) => s.trim()).filter(Boolean),
      body: m[2],
    }));
    const positioned = new Set(rules.filter((r) => /(^|;)\s*position\s*:\s*(relative|absolute|fixed|sticky)/.test(r.body)).flatMap((r) => r.sels));
    return rules.filter((r) => /overflow(-[xy])?\s*:\s*(auto|scroll)/.test(r.body)).flatMap((r) => r.sels).filter((s) => !positioned.has(s));
  };

  test('(+) every scroll container in every stylesheet is a containing block (position set)', () => {
    for (const f of CSS) assert.deepEqual(unanchoredScrollers(read(f)), [], f);
  });

  test('(−) the scroll-container check catches an unpositioned scroller (so the check above can fail)', () => {
    assert.deepEqual(unanchoredScrollers('.list { overflow: auto; } .ok { position: relative; overflow-y: scroll; }'), ['.list']);
  });

  // The End dialog must look the same on both pages, so the shared rules live once, in tokens.css (both pages load it).
  const ruleSelectors = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()));
  const keyframes = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
  const SHARED = ['dialog', 'dialog::backdrop', 'dialog[open]', 'dialog.dlg-confirm', '.dlg-head', '.dlg-head h2', '.dlg-body', '.dlg-foot', '.alert', '.alert p', '.alert .ic',
    '.alert[data-kind="danger"]', '.alert[data-kind="danger"] .ic', '.toasts', '.toast', '.toast p', '.spin', '.btn.danger', '.btn.danger:hover', '.btn.danger.fill', '.btn.danger.fill:hover'];

  test('(+) dialog, alert and toast rules (and .spin, .btn.danger and their keyframes) are defined once, in tokens.css', () => {
    const tokens = ruleSelectors(read('tokens.css'));
    for (const sel of SHARED) assert.equal(tokens.filter((x) => x === sel).length, 1, `${sel} once in tokens.css`);
    for (const f of ['app.css', 'session.css']) {
      const own = ruleSelectors(read(f));
      for (const sel of SHARED) assert.equal(own.includes(sel), false, `${sel} is not repeated in ${f}`);
    }
    for (const name of ['dlg-in', 'toast-in', 'st-spin']) {
      assert.equal(keyframes(read('tokens.css')).filter((x) => x === name).length, 1, `@keyframes ${name} once in tokens.css`);
      for (const f of ['app.css', 'session.css']) assert.equal(keyframes(read(f)).includes(name), false, `@keyframes ${name} is not repeated in ${f}`);
    }
  });

  test('(−) both pages load tokens.css before their own sheet, and the page-only dialog variants stay where they are used', () => {
    for (const [page, own] of [['index.html', 'app.css'], ['session.html', 'session.css']]) {
      const links = [...read(page).matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/?([^"]+)"/g)].map((m) => m[1]);
      assert.ok(links.indexOf('tokens.css') >= 0 && links.indexOf('tokens.css') < links.indexOf(own), page);
    }
    const app = ruleSelectors(read('app.css'));
    for (const sel of ['dialog.sheet', 'dialog.dlg-report', 'dialog.dlg-rules']) assert.ok(app.includes(sel), `${sel} stays in app.css`);
    assert.equal(ruleSelectors(read('tokens.css')).includes('dialog.sheet'), false, 'the side sheet is a dashboard-only dialog');
  });

  test('(+) the End dialog alert keeps its 600 weight on both pages, and the muted lines in a dialog use the small size', () => {
    const tokens = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(tokens, /\.dlg-confirm \.alert \{[^}]*font-weight: 600/);
    assert.match(tokens, /\.dlg-body \.muted \{[^}]*font-size: var\(--fs-small\)/);
    assert.match(tokens, /\.dlg-body p \{[^}]*margin: 0/);
  });

  test('(+) .btn.danger.fill is the filled danger button of spec 9.8: danger fill and border, surface text, and the fill survives hover', () => {
    const tokens = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(tokens, /\.btn\.danger\.fill \{[^}]*background: var\(--danger\);[^}]*color: var\(--surface\);[^}]*border-color: var\(--danger\);/);
    const hover = /\.btn\.danger\.fill:hover \{([^}]*)\}/.exec(tokens)?.[1] ?? '';
    assert.match(hover, /background: var\(--danger\);/, 'hover keeps the fill');
    assert.match(hover, /border-color: var\(--danger\);/);
    assert.match(hover, /color: var\(--surface\);/);
    assert.doesNotMatch(hover, /danger-soft/, 'the pale hover of the plain danger button would wash the label out');
    assert.ok(tokens.indexOf('.btn.danger.fill {') > tokens.indexOf('.btn.danger:hover {'), 'declared after the plain danger rules, so the fill wins by order as well');
  });

  test('(+) End session in the dashboard dialog and in the session window is the filled danger button', () => {
    for (const page of ['index.html', 'session.html']) {
      const btn = new RegExp('<button\\b[^>]*\\bid="end-go"[^>]*>').exec(read(page))?.[0] ?? '';
      assert.match(btn, /class="btn danger fill"/, page);
    }
  });

  test('(−) fill is on those two buttons only: the quick-actions End, the Clear dialog and the dashboard confirm stay plain danger', () => {
    const tagOf = (page, id) => new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`).exec(read(page))?.[0] ?? '';
    for (const [page, id] of [['index.html', 'cf-ok'], ['session.html', 'qa-end'], ['session.html', 'clear-go']]) {
      const btn = tagOf(page, id);
      assert.match(btn, /class="btn danger\b/, `${page} #${id} is still danger`);
      assert.doesNotMatch(btn, /\bfill\b/, `${page} #${id} is not filled`);
    }
    const uses = ['index.html', 'session.html'].flatMap((f) => [...read(f).matchAll(/class="[^"]*\bfill\b[^"]*"/g)]);
    assert.equal(uses.length, 2, 'two buttons use .fill, nothing else');
  });

  test('(−) the owner-banned word never appears in the shipped UI', () => {
    const banned = new RegExp('pony' + 'tail', 'i');
    for (const f of files.filter((x) => /\.(js|css|html|svg)$/.test(x))) assert.doesNotMatch(read(f), banned, f);
  });
});

describe('model pickers in the markup', () => {
  const html = read('index.html');
  const ROLES = ['orchestrator', 'reasoner', 'builder', 'scout'];
  const select = (id) => new RegExp(`<select\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</select>`).exec(html)?.[0] ?? '';
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '';

  test('(+) settings markup has four selects, each with a Custom ID option, and a hidden custom field with its own error slot', () => {
    for (const r of ROLES) {
      const sel = select(`set-model-${r}`);
      assert.ok(sel, `select for ${r}`);
      assert.match(sel, /<option value="__custom__">Custom ID…<\/option>/, `${r} has the Custom ID option`);
      assert.match(html, new RegExp(`<label for="set-model-${r}">`));
      const custom = tag(`set-model-${r}-custom`);
      assert.match(custom, /^<input type="text"/, r);
      assert.match(custom, /\bhidden\b/, `${r}: hidden until Custom ID is chosen`);
      assert.match(custom, /\baria-label="Custom model ID for/, r);
      assert.match(tag(`set-model-${r}-custom-err`), /class="err"[^>]*\bhidden\b|\bhidden\b[^>]*class="err"/, r);
    }
    assert.equal(CUSTOM_VALUE, '__custom__');
  });

  test('(−) the model datalist and every free-text model input without a dropdown are gone from Settings', () => {
    assert.doesNotMatch(html, /<datalist\b/);
    assert.doesNotMatch(html, /\blist="model-list"/);
    assert.doesNotMatch(html, /data-rx="model"/);
    for (const r of ROLES) assert.doesNotMatch(tag(`set-model-${r}`), /^<input/, `${r} is a select now`);
  });

  test('(+) the spawn sheet model is a select with a hidden custom field and an error slot', () => {
    assert.match(select('sp-model'), /^<select\b/);
    assert.match(tag('sp-model-custom'), /^<input type="text"[^>]*\bhidden\b/);
    assert.match(tag('sp-model-custom-err'), /\bhidden\b/);
  });

  test('(−) the model rule lives once: ui.js has no second copy of MODEL_ID in RX', () => {
    assert.doesNotMatch(code(read('ui.js')), /model:\s*\[\s*\//);
  });
});

describe('Back button and the Keyboard shortcuts window on the dashboard (spec 3.13, 4.6)', () => {
  const html = read('index.html');
  const tokens = read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()));
  const tag = (src, re) => re.exec(src)?.[0] ?? '';
  /** Source of a top-level `function name(...) { ... }` (it ends at the first line that is just a closing brace). */
  const topFn = (src, name) => {
    const m = new RegExp(`\nfunction ${name}\\([^)]*\\) \\{[^]*?\n\\}\n`).exec(src);
    assert.ok(m, `app.js defines ${name}()`);
    return m[0];
  };

  test('(+) the project view back link is a .back button: icon, then the label in a span, to #dashboard', () => {
    assert.match(html, /<a class="back" href="#dashboard"><svg class="ic" aria-hidden="true"><use href="#i-back"\/><\/svg><span>Dashboard<\/span><\/a>/);
  });

  test('(−) no .crumb is left: not in a page, not in a stylesheet', () => {
    for (const f of HTML) assert.doesNotMatch(read(f), /class="[^"]*\bcrumb\b/, f);
    for (const f of CSS) assert.equal(selectors(read(f)).some((x) => /\.crumb\b/.test(x)), false, f);
  });

  test('(+) .back is defined once, in tokens.css, with the values of spec 3.13 (and not again in a page sheet)', () => {
    for (const sel of ['.back', '.back span', '.back:hover', '.back:active', '.back:focus-visible']) {
      assert.equal(selectors(read('tokens.css')).filter((x) => x === sel).length, 1, `${sel} once in tokens.css`);
      for (const f of ['app.css', 'session.css']) assert.equal(selectors(read(f)).includes(sel), false, `${sel} is not repeated in ${f}`);
    }
    const body = /\.back \{([^}]*)\}/.exec(tokens)[1];
    for (const decl of ['display: inline-flex', 'align-items: center', 'gap: 4px', 'height: 28px', 'max-width: 28ch', 'padding: 0 8px 0 4px', 'border-radius: var(--r-sm)', 'color: var(--text-muted)', 'font-weight: 600', 'text-decoration: none']) {
      assert.ok(body.includes(decl), decl);
    }
    assert.match(tokens, /\.back span \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
    assert.match(tokens, /\.back:hover \{[^}]*background: var\(--surface-3\);[^}]*color: var\(--text\)/);
    assert.match(tokens, /\.back:active \{[^}]*background: var\(--surface-3\)/);
    assert.match(tokens, /\.back:focus-visible \{[^}]*outline: 2px solid var\(--focus\);[^}]*outline-offset: 2px/);
  });

  test('(+) #kbd-dlg is a native dialog for both tiers: labelled, with the heading, the window line, the body and the footer', () => {
    const dlg = /<dialog\b[^>]*\bid="kbd-dlg"[^>]*>[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? '';
    assert.ok(dlg, 'index.html has #kbd-dlg');
    assert.match(dlg, /<dialog\b[^>]*\bclass="dlg-kbd"/);
    assert.match(dlg, /\baria-labelledby="kbd-h"/);
    assert.doesNotMatch(dlg, /data-app-only/, 'the browser tier has the window too (Mod+/)');
    assert.match(dlg, /<h2 id="kbd-h" tabindex="-1">Keyboard shortcuts<\/h2>/);
    for (const id of ['kbd-sub', 'kbd-body', 'kbd-foot']) assert.match(dlg, new RegExp(`\\bid="${id}"`), id);
    assert.match(dlg, /class="dlg-head"/);
    assert.match(dlg, /class="dlg-body"/);
    assert.match(dlg, /class="dlg-foot"/);
    assert.match(tokens, /dialog\.dlg-kbd \{[^}]*width: min\(560px, calc\(100vw - 32px\)\)/);
    assert.match(tokens, /dialog\.dlg-kbd \{[^}]*max-height: min\(720px, calc\(100vh - 32px\)\)/);
  });

  test('(+) the sidebar footer (app tier) has the Keyboard shortcuts button; the browser tier gets its own in the dashboard bar', () => {
    const nav = /<nav class="side"[\s\S]*?<\/nav>/.exec(html)[0];
    const btn = tag(nav, /<button\b[^>]*\bdata-kbd-open\b[^>]*>[\s\S]*?<\/button>/);
    assert.ok(btn, 'a button in the app-only sidebar');
    assert.match(btn, /class="btn icon ghost"/);
    assert.match(btn, /aria-label="Keyboard shortcuts"/);
    assert.match(btn, /aria-keyshortcuts="[^"]+"/);
    assert.match(btn, /title="Keyboard shortcuts \(\?\)"/);
    assert.match(btn, /<use href="#i-kbd"\/>/);
    assert.ok(nav.indexOf('data-kbd-open') > nav.indexOf('class="side-foot"'), 'in the footer');
    const bar = /<header class="bar">[\s\S]*?<\/header>/.exec(html)[0];
    const alt = tag(bar, /<button\b[^>]*\bdata-kbd-open\b[^>]*>[\s\S]*?<\/button>/);
    assert.ok(alt, 'the dashboard bar has one too');
    assert.match(alt, /\bdata-browser-only\b/, 'removed on the app tier so there is one button per tier');
    assert.match(alt, /aria-label="Keyboard shortcuts"/);
    assert.match(alt, /aria-keyshortcuts="[^"]+"/);
    assert.equal((html.match(/data-kbd-open/g) ?? []).length, 2);
  });

  test('(+) the i-kbd icon is in the sprite, byte for byte as in the session window', () => {
    const sym = (src) => /<symbol id="i-kbd"[^>]*>[\s\S]*?<\/symbol>/.exec(src)?.[0];
    assert.ok(sym(html));
    assert.equal(sym(html), sym(read('session.html')));
  });

  test('(+) Settings > Appearance has the Single-key shortcuts checkbox with its help text', () => {
    const sec = /<section class="set-sec" id="s-appearance"[\s\S]*?<\/section>/.exec(html)[0];
    const input = tag(sec, /<input\b[^>]*\bid="set-singlekey"[^>]*>/);
    assert.match(input, /type="checkbox"/);
    assert.match(input, /aria-describedby="set-singlekey-help"/);
    assert.doesNotMatch(input, /\bchecked\b/, 'the page sets it from the saved value');
    assert.match(sec, /<span>Single-key shortcuts<\/span>/);
    assert.match(sec, /<p class="help" id="set-singlekey-help">Press \? to show keyboard shortcuts\. Turn this off if you use speech input or single-key commands\.<\/p>/);
  });

  test('(+) settings.js reads the checkbox from the saved value (default on) and saves it next to the theme', () => {
    const src = code(read('settings.js'));
    assert.match(src, /\$\('#set-singlekey'\)\.checked = s\.ui\?\.singleKeyShortcuts !== false/);
    assert.match(src, /ui: \{ theme: radio\('theme'\), singleKeyShortcuts: \$\('#set-singlekey'\)\.checked \}/);
  });

  test('(+) app.js imports the shortcut rules from shortcuts.js, and ui.js takes MAC from isMac (one platform test)', () => {
    assert.match(read('app.js'), /import \{[^}]*\bwantsHelp\b[^}]*\} from '\.\/shortcuts\.js';/);
    assert.match(code(read('ui.js')), /export const MAC = isMac\(navigator\);/);
    assert.doesNotMatch(code(read('ui.js')), /\/Mac\|iPhone\|iPad\//);
  });

  // The keydown handler of app.js, run for real: the shortcut rules (shortcuts.js) are the real ones, the page is a stub.
  const keyRig = ({ isApp = true, settings = { ui: { singleKeyShortcuts: true } }, route = 'dashboard', dialog = false, mac = false } = {}) => {
    const app = read('app.js');
    const log = { kbd: [], hash: [], prevented: 0 };
    let handler;
    const state = { settings, route: { name: route } };
    const ctx = {
      isApp, state, MAC: mac, hooks: {}, wantsHelp, wantsBack, isTextEntry,
      openKbd: (opener) => log.kbd.push(opener),
      location: { set hash(v) { log.hash.push(v); } },
      $: (sel) => (sel === 'dialog[open]' && dialog ? { id: 'open-dialog' } : null),
      document: { activeElement: { id: 'active' }, addEventListener: (type, fn) => { if (type === 'keydown') handler = fn; } },
    };
    vm.runInNewContext(`${topFn(app, 'singleKey')}\n${topFn(app, 'initKeys')}\ninitKeys()`, ctx);
    return {
      log,
      press: (key, more = {}, target = { tagName: 'BUTTON' }) => {
        const e = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target, preventDefault() { log.prevented += 1; }, ...more };
        handler(e);
        return log.prevented;
      },
    };
  };

  test('(+) app tier: "?" outside text entry and Mod+/ open the window for the focused control', () => {
    const r = keyRig();
    r.press('?', { shiftKey: true });
    assert.deepEqual(r.log.kbd, [{ id: 'active' }]);
    r.press('/', { ctrlKey: true });
    assert.equal(r.log.kbd.length, 2);
    assert.equal(r.log.prevented, 2, 'both are consumed');
    const mac = keyRig({ mac: true });
    mac.press('/', { metaKey: true });
    assert.equal(mac.log.kbd.length, 1);
  });

  test('(−) app tier: "?" does nothing in an input, a textarea, a select, with a dialog open or with the setting off', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      const r = keyRig();
      r.press('?', {}, target);
      assert.equal(r.log.kbd.length, 0, target.tagName);
    }
    const dlg = keyRig({ dialog: true });
    dlg.press('?');
    dlg.press('/', { ctrlKey: true });
    assert.equal(dlg.log.kbd.length, 0, 'also not the shortcuts window itself');
    const off = keyRig({ settings: { ui: { singleKeyShortcuts: false } } });
    off.press('?');
    assert.equal(off.log.kbd.length, 0);
    off.press('/', { ctrlKey: true });
    assert.equal(off.log.kbd.length, 1, 'Mod+/ always works');
  });

  test('(+) a settings answer without the field (or no answer yet) counts as on', () => {
    for (const settings of [null, {}, { ui: {} }, { ui: { singleKeyShortcuts: 'no' } }]) {
      const r = keyRig({ settings });
      r.press('?');
      assert.equal(r.log.kbd.length, 1, JSON.stringify(settings));
    }
  });

  test('(−) browser tier: "?" never opens it (the setting cannot be stored there); Mod+/ does', () => {
    const r = keyRig({ isApp: false, settings: null });
    r.press('?');
    assert.equal(r.log.kbd.length, 0);
    r.press('/', { ctrlKey: true });
    assert.equal(r.log.kbd.length, 1);
  });

  test('(+) Back: Alt+Left on Linux and Command+[ on macOS go to the dashboard from another screen', () => {
    const lin = keyRig({ route: 'project' });
    lin.press('ArrowLeft', { altKey: true });
    assert.deepEqual(lin.log.hash, ['#dashboard']);
    const mac = keyRig({ route: 'settings', mac: true });
    mac.press('[', { metaKey: true });
    assert.deepEqual(mac.log.hash, ['#dashboard']);
  });

  test('(−) Back does nothing on the dashboard, in a dialog, on the browser tier, or with the wrong platform key', () => {
    const cases = [keyRig({ route: 'dashboard' }), keyRig({ route: 'project', dialog: true }), keyRig({ route: 'project', isApp: false }), keyRig({ route: 'project', mac: true })];
    for (const r of cases) r.press('ArrowLeft', { altKey: true });
    for (const r of cases) assert.deepEqual(r.log.hash, []);
  });

  test('(+) the buttons\' title and aria-keyshortcuts follow the Settings switch and the platform', () => {
    const app = read('app.js');
    const buttons = [{ attrs: {} }, { attrs: {} }].map((b) => ({ ...b, setAttribute(k, v) { this.attrs[k] = v; } }));
    const state = { settings: { ui: { singleKeyShortcuts: true } } };
    const ctx = { isApp: true, state, MAC: false, helpHint, $$: () => buttons };
    const sync = vm.runInNewContext(`let hintSig = null;\n${topFn(app, 'singleKey')}\n${topFn(app, 'syncHints')}\nsyncHints`, ctx);
    sync();
    assert.deepEqual(buttons.map((b) => [b.title, b.attrs['aria-keyshortcuts']]), Array(2).fill(['Keyboard shortcuts (?)', 'Shift+Slash Control+Slash']));
    state.settings = { ui: { singleKeyShortcuts: false } };
    sync();
    assert.deepEqual(buttons.map((b) => [b.title, b.attrs['aria-keyshortcuts']]), Array(2).fill(['Keyboard shortcuts (Ctrl+/)', 'Control+Slash']));
  });

  test('(−) F2: the dashboard\'s own key handler swallows no editing key in a text field: copy, cut, paste, select all, undo, redo, on both platforms', () => {
    const editing = [['a', {}], ['c', {}], ['x', {}], ['v', {}], ['z', {}], ['y', {}], ['Z', { shiftKey: true }]];
    for (const [mac, mod] of [[false, 'ctrlKey'], [true, 'metaKey']]) {
      for (const route of ['dashboard', 'project', 'settings']) {
        const r = keyRig({ mac, route });
        for (const [key, more] of editing) assert.equal(r.press(key, { [mod]: true, ...more }, { tagName: 'INPUT' }), 0, `${mac ? 'Command' : 'Ctrl'}+${key} on ${route}`);
        assert.deepEqual(r.log.hash, []);
      }
    }
  });

  test('(+) F2: app.js wires the window keys once, in the app tier only, with the platform and the shell relay (windowCommand from api.js)', () => {
    const app = read('app.js');
    const boot = /\nasync function boot\(\) \{[^]*?\n\}\n/.exec(app)?.[0] ?? '';
    assert.match(boot, /if \(isApp\) \{[^}]*wireWindowKeys\(\{ mac: MAC, send: windowCommand \}\);/);
    assert.equal((code(app).match(/wireWindowKeys\(/g) ?? []).length, 1);
    assert.match(app, /import \{[^}]*\bisApp\b[^}]*\bwindowCommand\b[^}]*\} from '\.\/api\.js';/);
    assert.match(app, /import \{[^}]*\bwireWindowKeys\b[^}]*\} from '\.\/shortcuts\.js';/);
  });

  test('(+) F2: api.js sends the window action through appFetch to POST /api/app/window, never throws, and sends nothing on the browser tier', () => {
    const c = code(read('api.js'));
    assert.match(c, /export function windowCommand\(action\) \{\s*return appFetch\('\/api\/app\/window', \{ method: 'POST', json: \{ action \} \}\)\.catch\(\(\) => \{\}\);\s*\}/);
    const calls = [];
    const ctx = { appFetch: async (path, opts) => { calls.push([path, opts]); throw new Error('app tier only'); } };
    const run = vm.runInNewContext(`${/export (function windowCommand[\s\S]*?\n\})/.exec(read('api.js'))[1]}; windowCommand`, ctx);
    return run('zoom-in').then((r) => {
      assert.equal(r, undefined, 'a refusal is swallowed');
      assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/api/app/window', { method: 'POST', json: { action: 'zoom-in' } }]]); // objects built in the vm have another prototype
    });
  });

  test('(+) every back link gets its title and aria-keyshortcuts from backHint with its own label', () => {
    const src = code(read('app.js'));
    assert.match(src, /for \(const a of \$\$\('a\.back'\)\) \{[^}]*backHint\(\{ label: \$\('span', a\)\.textContent, mac: MAC \}\)/);
    assert.deepEqual(backHint({ label: 'Dashboard', mac: false }).keys, 'Alt+ArrowLeft');
  });
});

describe('tier separation in the page code', () => {
  test('(+) api.js copies the injected global into a module constant and deletes it', () => {
    const c = code(read('api.js'));
    assert.match(c, /const injected = window\.__NIKA_APP__/);
    assert.match(c, /delete window\.__NIKA_APP__/);
    assert.match(c, /X-Nika-App/);
  });

  test('(−) api.js holds no literal secret: no long token-like string literal', () => {
    const c = code(read('api.js'));
    const literals = [...c.matchAll(/(['"`])((?:\\.|(?!\1).){20,})\1/g)].map((m) => m[2]);
    for (const s of literals) assert.doesNotMatch(s, /^[A-Za-z0-9+/_=-]{20,}$/, `looks like a secret: ${s}`);
  });

  test('(−) /api/app appears only in the app-tier modules (best-effort: strings in comments are ignored)', () => {
    // end-dialog.js serves the app tier only (the session window, and the dashboard's End item behind isApp)
    for (const f of JS.filter((x) => !['api.js', 'project.js', 'settings.js', 'session.js', 'end-dialog.js'].includes(x))) {
      assert.doesNotMatch(code(read(f)), /\/api\/app/, `${f} is loaded on the browser tier and must not name an app route`);
    }
  });

  test('(+) the privileged modules load only through a dynamic import behind isApp, never a static import', () => {
    for (const f of JS.filter((x) => !['project.js', 'settings.js'].includes(x))) {
      assert.doesNotMatch(code(read(f)), /^\s*import\b[^;]*from\s*['"]\.\/(project|settings)\.js['"]/m, `${f} must not import them statically`);
    }
    const app = code(read('app.js'));
    for (const mod of ['project', 'settings', 'end-dialog']) {
      const at = app.indexOf(`import('./${mod}.js')`);
      assert.ok(at > 0, `app.js imports ${mod}.js dynamically`);
      assert.match(app.slice(Math.max(0, at - 160), at), /if \(!?isApp\)/, `${mod}.js import sits inside an isApp guard`);
    }
  });

  test('(+) end-dialog.js loads on the dashboard only through a dynamic import behind isApp (the End item is built only on the app tier)', () => {
    for (const f of JS.filter((x) => x !== 'session.js')) {
      assert.doesNotMatch(code(read(f)), /^\s*import\b[^;]*from\s*['"]\.\/end-dialog\.js['"]/m, `${f} must not import it statically`);
    }
    const app = code(read('app.js'));
    assert.equal(app.split("import('./end-dialog.js')").length - 1, 1, 'one dynamic import');
    const loader = app.slice(app.indexOf('async function endSession('), app.indexOf("import('./end-dialog.js')"));
    assert.match(loader, /^async function endSession\([^)]*\) \{\s*if \(!isApp\) return;/, 'the loader refuses outside the app tier');
    assert.equal(app.match(/endSession\(/g).length, 2, 'its definition and one call');
    assert.match(app, /if \(isApp && canEndRow\([^)]*\)\) \{\s*items\.push\(\{ text: 'End session…'[^}]*endSession\(/, 'the one call sits behind isApp');
  });

  test('(−) the End dialog of the dashboard is app-only markup, with every id end-dialog.js looks up', () => {
    const html = read('index.html');
    const dlg = /<dialog\b[^>]*\bid="end-dlg"[^>]*>[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? '';
    assert.ok(dlg, 'index.html has #end-dlg');
    assert.match(dlg, /<dialog\b[^>]*\bdata-app-only\b/, 'removed from the browser tier at boot');
    assert.match(dlg, /<dialog\b[^>]*\bclass="dlg-confirm"/);
    assert.match(dlg, /<dialog\b[^>]*\baria-labelledby="end-h"[^>]*\baria-describedby="end-d"|<dialog\b[^>]*\baria-describedby="end-d"[^>]*\baria-labelledby="end-h"/);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...code(read('end-dialog.js')).matchAll(/getElementById\('([^']+)'\)|\bel\('([A-Za-z0-9-]+)'\)/g)].map((m) => m[1] ?? m[2]);
    assert.ok(used.length >= 6);
    assert.deepEqual(used.filter((id) => !ids.has(id)), []);
  });

  test('(+) #add-project (tray) calls the folder picker once, behind isApp, after replacing the hash', () => {
    const app = code(read('app.js'));
    const route = app.slice(app.indexOf('function route('), app.indexOf('function initControls('));
    assert.match(route, /if \(isApp && location\.hash === '#add-project'\) \{\s*history\.replaceState\(null, '', '#dashboard'\);\s*hooks\.addProject\?\.\(\);\s*\}/);
    assert.equal(route.match(/addProject/g).length, 1, 'one call in route()');
  });

  test('(−) #add-project is not a screen: parseRoute does not know it, and no other module reads it', () => {
    const app = code(read('app.js'));
    const parse = app.slice(app.indexOf('function parseRoute('), app.indexOf('function route('));
    assert.doesNotMatch(parse, /add-project/);
    assert.match(parse, /if \(isApp\) \{/); // the screen routes themselves stay app-only
    for (const f of JS.filter((x) => x !== 'app.js')) assert.doesNotMatch(code(read(f)), /add-project/, f);
  });

  test('(+) every appFetch call site in project.js and settings.js targets an /api/app/ path', () => {
    for (const f of ['project.js', 'settings.js']) {
      const calls = [...code(read(f)).matchAll(/appFetch\(\s*([^,)]*)/g)].map((m) => m[1].trim());
      const own = calls.filter((c) => !c.startsWith('path') && !c.startsWith('p,'));
      for (const arg of own) assert.match(arg, /^[`'"]\/api\/app\//, `${f}: appFetch(${arg}`);
    }
  });
});

// ---- the Add to Applications notice (docs/design/spec.md 3.14, ADR 0011) ----------------------------------------------
describe('Add to Applications notice (spec 3.14)', () => {
  const MISSING = { state: 'missing', managed: false, dismissed: false, version: null, available: '0.3.0', running: false };
  const STALE = { state: 'stale', managed: true, dismissed: false, version: '0.2.0', available: '0.3.0', running: false };
  const UI = { busy: false, error: null, hidden: false };
  const fn = (src, head) => {
    const at = src.indexOf(head);
    assert.ok(at >= 0, `${head} exists`);
    return src.slice(at, src.indexOf('\n}\n', at) + 2);
  };

  test('(+) missing and not dismissed: the Add banner with its exact copy and buttons', () => {
    assert.deepEqual(copyBanner(MISSING, UI), {
      mode: 'add', title: 'Add nika to Applications', text: 'so Spotlight and Launchpad can find it.',
      primary: { label: 'Add to Applications', busy: 'Adding…' }, ghost: { label: 'Not now' },
    });
  });

  test('(+) stale and managed: the Update banner names the installed version', () => {
    assert.deepEqual(copyBanner(STALE, UI), {
      mode: 'update', title: 'nika 0.3.0 is installed.', text: 'Update the app in Applications to match.',
      primary: { label: 'Update app', busy: 'Updating…' }, ghost: { label: 'Not now' },
    });
  });

  test('(−) no banner for current, foreign, no-source, unsupported (Linux), a dismissed Add, an unmanaged stale copy, or a copy with no source version', () => {
    const none = [
      { ...MISSING, state: 'current', version: '0.3.0' },
      { ...MISSING, state: 'foreign' },
      { ...MISSING, state: 'no-source', available: null },
      { ...MISSING, state: 'unsupported', available: null },
      { ...MISSING, dismissed: true },
      { ...MISSING, available: null },
      { ...STALE, managed: false },
      { ...STALE, available: null },
      { ...MISSING, state: 'bogus' },
      null, undefined, 'missing', 42, [], {},
    ];
    for (const c of none) assert.equal(copyBanner(c, UI), null, JSON.stringify(c));
  });

  test('(−) "Not now" hides either banner until the next launch (the page keeps that in memory only)', () => {
    assert.equal(copyBanner(MISSING, { ...UI, hidden: true }), null);
    assert.equal(copyBanner(STALE, { ...UI, hidden: true }), null);
    assert.notEqual(copyBanner(STALE, { ...UI, busy: true }), null, 'busy keeps it on screen');
  });

  test('(+) the toasts: Added, Updated, and Updated with a restart', () => {
    assert.equal(copyToast('add', { version: '0.3.0', restart: false }), 'nika is in Applications. Open it from Spotlight or Launchpad.');
    assert.equal(copyToast('update', { version: '0.3.0', restart: false }), 'Updated the app in Applications to 0.3.0.');
    assert.equal(copyToast('update', { version: '0.3.0', restart: true }), 'Updated to 0.3.0. Quit and reopen nika to use it.');
  });

  test('(+) errors are fixed copy chosen by the server\'s code', () => {
    const e = (status, error) => ({ status, body: { error, message: 'ignored' } });
    assert.equal(copyErrorText(e(409, 'foreign-target')), "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace. Move it away, then try again.");
    assert.equal(copyErrorText(e(409, 'no-source')), "nika can't find its own app to copy. Reinstall it with Homebrew.");
    assert.equal(copyErrorText(e(409, 'copy-busy')), 'nika is already copying the app.');
    assert.equal(copyErrorText(e(500, 'copy-failed')), "nika couldn't copy the app to Applications.");
  });

  test('(−) any other failure (5xx, 403, network, a hostile message or code) is the generic line, never the server\'s text', () => {
    const generic = "nika couldn't copy the app to Applications.";
    for (const res of [null, undefined, { status: 500, body: { error: 'internal', message: '<img src=x onerror=alert(1)>' } }, { status: 403, body: { error: 'forbidden' } },
      { status: 409, body: { error: 'unsupported', message: '/some/path' } }, { status: 409, body: { error: '__proto__' } }, { status: 409, body: { error: 'constructor' } }, { status: 409, body: null }, { status: 200, body: {} }]) {
      assert.equal(copyErrorText(res), generic, JSON.stringify(res));
    }
  });

  test('(−) the module is pure: it names no app route, does no network, storage or timer work and imports nothing', () => {
    const src = code(read('app-copy.js'));
    assert.doesNotMatch(src, /\/api\/app|\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|setTimeout|setInterval|document\.cookie/);
    assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]), []);
  });

  test('(+) the server serves /app-copy.js as JavaScript; the page sprite has the i-apps symbol', () => {
    assert.match(read('../src/server.js'), /\['\/app-copy\.js', \['app-copy\.js', 'text\/javascript; charset=utf-8'\]\]/);
    assert.match(read('index.html'), /<symbol id="i-apps" viewBox="0 0 16 16">(?:<rect [^>]*\/>){4}<\/symbol>/);
  });

  // app.js cannot be imported (it starts the page); its bannerList is run in a vm against stubs
  function bannerRig({ isApp = true, route = 'dashboard', me = { appCopy: MISSING, tmux: true, claude: true }, ui = { ...UI } } = {}) {
    const calls = [];
    const ctx = {
      isApp, copyBanner, REFRESH_MS: 3000, Object, Date,
      state: { route: { name: route }, me, appCopyUi: ui, data: { sources: {} }, error: null },
      hooks: { appCopyInstall: () => calls.push('install'), appCopyDismiss: () => calls.push('dismiss'), checkEnv: () => {} },
      refresh() {},
    };
    const list = vm.runInNewContext(`${fn(read('app.js'), 'function bannerList(')}\nbannerList`, ctx);
    return { ids: () => list().map((b) => b.id), get: () => list().find((b) => b.id === 'app-copy'), byId: (id) => list().find((b) => b.id === id), calls, ctx };
  }

  test('(+) the dashboard banner list gets the app-copy banner (info kind, i-apps icon) for missing and for stale+managed, wired to the hooks', () => {
    const add = bannerRig().get();
    assert.equal(add.kind, 'info');
    assert.equal(add.icon, 'apps');
    assert.equal(add.title, 'Add nika to Applications');
    assert.equal(JSON.stringify(add.actions.map((a) => [a.label, Boolean(a.primary)])), JSON.stringify([['Add to Applications', true], ['Not now', false]]));
    const rig = bannerRig({ me: { appCopy: STALE } });
    const up = rig.get();
    assert.equal(up.title, 'nika 0.3.0 is installed.');
    up.actions[0].run();
    up.actions[1].run();
    assert.deepEqual(rig.calls, ['install', 'dismiss']);
    assert.equal(up.busy, false);
    assert.equal(bannerRig({ ui: { ...UI, busy: true, error: 'x' } }).get().busy, true);
    assert.equal(bannerRig({ ui: { ...UI, error: 'oops' } }).get().error, 'oops');
  });

  test('(−) no app-copy banner on the browser tier, on Linux, off the dashboard screen, or for any other state', () => {
    assert.equal(JSON.stringify(bannerRig({ isApp: false, me: null }).ids()), '["ro"]', 'browser tier: only the read-only note');
    assert.equal(bannerRig({ isApp: false, me: { appCopy: MISSING } }).get(), undefined, 'even with an appCopy in hand');
    assert.equal(bannerRig({ me: { appCopy: { ...MISSING, state: 'unsupported', available: null }, tmux: true, claude: true } }).get(), undefined, 'Linux');
    assert.equal(bannerRig({ route: 'project' }).get(), undefined);
    assert.equal(bannerRig({ route: 'settings' }).get(), undefined);
    assert.equal(bannerRig({ me: { appCopy: { ...MISSING, dismissed: true } } }).get(), undefined);
    assert.equal(bannerRig({ me: null }).get(), undefined);
  });

  // F1b: collect() now answers `tmux: 'ok'` when no tmux server runs (test/model.test.js); the banner follows the sources it is given
  test('(+) sources all ok (also with no tmux server): no "Some sources are unavailable" banner; (−) a real failure still shows it, naming the source', () => {
    const NO_COPY = { state: 'unsupported', available: null };
    const rig = (sources) => {
      const r = bannerRig({ me: { tmux: true, claude: true, appCopy: NO_COPY } });
      r.ctx.state.data = { sources };
      return r;
    };
    const ok = { registry: 'ok', processes: 'ok', transcripts: 'ok', tmux: 'ok', reports: 'ok' };
    assert.equal(rig(ok).byId('sources'), undefined);
    const bad = rig({ ...ok, tmux: 'tmux unavailable: protocol version mismatch' }).byId('sources');
    assert.equal(bad.title, 'Some sources are unavailable');
    assert.match(bad.text, /tmux: tmux unavailable: protocol version mismatch/);
  });

  test('(+) the tmux banner names the install command of the platform: brew on macOS, apt on Linux', () => {
    const NO_COPY = { state: 'unsupported', available: null };
    const tmux = (platform) => bannerRig({ me: { tmux: false, claude: true, platform, appCopy: NO_COPY } }).byId('tmux');
    assert.equal(tmux('darwin').cmd, 'brew install tmux');
    assert.equal(tmux('linux').cmd, 'sudo apt install tmux');
    for (const p of ['darwin', 'linux']) {
      assert.equal(tmux(p).title, 'tmux not found');
      assert.equal(tmux(p).kind, 'danger');
      assert.equal(tmux(p).action.label, 'Check again');
    }
  });

  test('(−) any other or unknown platform gets the tmux banner without a command; tmux present means no banner', () => {
    const NO_COPY = { state: 'unsupported', available: null };
    for (const platform of ['win32', 'freebsd', 'sunos', '', undefined, null, 'Darwin', 'LINUX', 'constructor', '__proto__', 'toString']) {
      const b = bannerRig({ me: { tmux: false, claude: true, platform, appCopy: NO_COPY } }).byId('tmux');
      assert.equal(b.title, 'tmux not found', String(platform));
      assert.equal(b.cmd, undefined, `no command for ${String(platform)}`);
    }
    assert.equal(bannerRig({ me: { tmux: true, claude: true, platform: 'linux', appCopy: NO_COPY } }).byId('tmux'), undefined);
    assert.equal(bannerRig({ isApp: false, me: { tmux: false, platform: 'linux' } }).byId('tmux'), undefined, 'browser tier never shows it');
  });

  test('(+) the banner renderer draws the primary and the ghost button, a busy state with aria-busy and aria-disabled, and an alert line', () => {
    const el = code(fn(read('app.js'), 'function bannerEl('));
    assert.match(el, /'aria-busy': busy && a\.primary \? 'true' : null/);
    assert.match(el, /'aria-disabled': busy \? 'true' : null/);
    assert.match(el, /onclick: \(\) => \{ if \(!busy\) a\.run\(\); \}/, 'a press while busy does nothing');
    assert.match(el, /class: 'banner-err', role: 'alert'/);
    assert.match(el, /\{ text: b\.title \}/, 'texts go through textContent');
    const r = code(fn(read('app.js'), 'function renderBanners('));
    assert.match(r, /swap\(\$\('#banners'\)/, 'focus stays on the same control across redraws');
    assert.match(r, /busy, error \}\) => \[id, kind, title, text, cmd, busy, error\]/, 'a busy or failed state redraws');
  });

  // project.js holds the app-tier part: the two POSTs; run in a vm against stubs
  function actionRig({ answers = [], me = { appCopy: MISSING }, ui = { ...UI } } = {}) {
    const calls = [];
    const toasts = [];
    const queue = [...answers];
    const ctx = {
      state: { me, appCopyUi: ui }, copyBanner, copyErrorText, copyToast, Promise,
      appFetch: async (p, o) => {
        calls.push([p, o.method, o.json]);
        const a = queue.shift();
        if (a instanceof Error) throw a;
        return a;
      },
      loadMe: async () => { ctx.state.me = { appCopy: { ...MISSING, state: 'current', version: '0.3.0' } }; },
      render: () => calls.push('render'),
      toast: (m, o) => toasts.push([m, o?.kind ?? 'info']),
      $: () => ({ contains: () => false, focus() {} }),
      Boolean,
      document: { activeElement: null },
    };
    const P = read('project.js');
    const src = `${fn(P, 'function offered(')}\n${fn(P, 'function keepFocus(')}\n${fn(P, 'async function appCopyInstall(')}\n${fn(P, 'async function appCopyDismiss(')}\n({ appCopyInstall, appCopyDismiss })`;
    return { calls, toasts, ctx, api: vm.runInNewContext(src, ctx) };
  }

  test('(+) pressing Add posts exactly { action: "install" }, shows busy, toasts on 200, and re-reads me', async () => {
    const rig = actionRig({ answers: [{ status: 200, body: { state: 'current', version: '0.3.0', restart: false } }] });
    const p = rig.api.appCopyInstall();
    assert.equal(rig.ctx.state.appCopyUi.busy, true, 'busy while the request runs');
    await p;
    assert.equal(JSON.stringify(rig.calls.filter((c) => Array.isArray(c))), JSON.stringify([['/api/app/app-copy', 'POST', { action: 'install' }]]));
    assert.deepEqual(rig.toasts, [['nika is in Applications. Open it from Spotlight or Launchpad.', 'info']]);
    assert.equal(rig.ctx.state.appCopyUi.busy, false);
    assert.equal(rig.ctx.state.appCopyUi.error, null);
    assert.equal(rig.ctx.state.me.appCopy.state, 'current');
  });

  test('(+) Update with restart true says to quit and reopen', async () => {
    const rig = actionRig({ me: { appCopy: STALE }, answers: [{ status: 200, body: { state: 'current', version: '0.3.0', restart: true } }] });
    await rig.api.appCopyInstall();
    assert.deepEqual(rig.toasts, [['Updated to 0.3.0. Quit and reopen nika to use it.', 'info']]);
  });

  test('(−) a refusal or a network failure stays in the banner as fixed copy, with the buttons free again and no toast', async () => {
    for (const [answer, text] of [
      [{ status: 409, body: { error: 'foreign-target', message: 'x' } }, "~/Applications or ~/Applications/nika.app isn't a folder nika can safely replace. Move it away, then try again."],
      [{ status: 409, body: { error: 'copy-busy', message: 'x' } }, 'nika is already copying the app.'],
      [{ status: 500, body: { error: 'copy-failed', message: 'x' } }, "nika couldn't copy the app to Applications."],
      [new Error('network down'), "nika couldn't copy the app to Applications."],
    ]) {
      const rig = actionRig({ answers: [answer] });
      await rig.api.appCopyInstall();
      assert.equal(rig.ctx.state.appCopyUi.error, text);
      assert.equal(rig.ctx.state.appCopyUi.busy, false);
      assert.deepEqual(rig.toasts, []);
    }
  });

  test('(−) a second press while busy sends nothing; with no banner on offer nothing is sent either', async () => {
    const rig = actionRig({ answers: [{ status: 200, body: { state: 'current', version: '0.3.0', restart: false } }] });
    const first = rig.api.appCopyInstall();
    await rig.api.appCopyInstall();
    await first;
    assert.equal(rig.calls.filter((c) => Array.isArray(c)).length, 1);
    const none = actionRig({ me: { appCopy: { ...MISSING, state: 'current' } } });
    await none.api.appCopyInstall();
    await none.api.appCopyDismiss();
    assert.deepEqual(none.calls, []);
  });

  test('(+) Not now on Add posts { action: "dismiss" } and hides the banner; on Update it only hides it (nothing is posted)', async () => {
    const add = actionRig({ answers: [{ status: 200, body: { dismissed: true } }] });
    await add.api.appCopyDismiss();
    assert.equal(JSON.stringify(add.calls.filter((c) => Array.isArray(c))), JSON.stringify([['/api/app/app-copy', 'POST', { action: 'dismiss' }]]));
    assert.equal(add.ctx.state.appCopyUi.hidden, true);
    const up = actionRig({ me: { appCopy: STALE } });
    await up.api.appCopyDismiss();
    assert.deepEqual(up.calls.filter((c) => Array.isArray(c)), []);
    assert.equal(up.ctx.state.appCopyUi.hidden, true);
  });

  test('(−) a failed dismiss still hides the banner for this session and shows no error', async () => {
    const rig = actionRig({ answers: [new Error('down')] });
    await rig.api.appCopyDismiss();
    assert.equal(rig.ctx.state.appCopyUi.hidden, true);
    assert.equal(rig.ctx.state.appCopyUi.error, null);
  });

  test('(+) initApp registers the two hooks; app.js reaches the route only through them', () => {
    const init = fn(read('project.js'), 'export async function initApp(');
    assert.match(init, /hooks\.appCopyInstall = appCopyInstall;/);
    assert.match(init, /hooks\.appCopyDismiss = appCopyDismiss;/);
    assert.doesNotMatch(code(read('app.js')), /\/api\/app/);
  });
});

describe('api.js behaviour with a stubbed page', () => {
  const API = pathToFileURL(path.join(PUBLIC, 'api.js')).href;
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  let n = 0;
  const load = (injected) => {
    globalThis.window = injected ? { __NIKA_APP__: injected } : {};
    return import(`${API}?case=${n++}`);
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  };
  after(restore);

  test('(+) with the shell global: isApp, the global is gone, the header carries the secret, JSON is parsed', async () => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push([url, opts]);
      return { status: 200, headers: new Map(), text: async () => '{"ok":true}' };
    };
    const api = await load({ secret: 'unit-test-secret', port: 1 });
    assert.equal(globalThis.window.__NIKA_APP__, undefined, 'global deleted after the first read');
    assert.equal(api.isApp, true);
    const r = await api.appFetch('/api/app/me', { method: 'PUT', json: { a: 1 } });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    const [url, opts] = calls[0];
    assert.equal(url, '/api/app/me');
    assert.equal(opts.headers['X-Nika-App'], 'unit-test-secret');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.equal(opts.body, '{"a":1}');
    assert.equal(opts.cache, 'no-store');
  });

  test('(+) a caller cannot override the secret header, and an error status resolves instead of throwing', async () => {
    globalThis.fetch = async (url, opts) => ({ status: 409, headers: new Map(), text: async () => `{"seen":"${opts.headers['X-Nika-App']}"}` });
    const api = await load({ secret: 'real', port: 1 });
    const r = await api.appFetch('/api/app/x', { headers: { 'X-Nika-App': 'forged' } });
    assert.deepEqual([r.status, r.body], [409, { seen: 'real' }]);
  });

  test('(−) a non-app path is refused before any request is sent', async () => {
    let sent = 0;
    globalThis.fetch = async () => { sent++; return { status: 200, headers: new Map(), text: async () => '{}' }; };
    const api = await load({ secret: 'real', port: 1 });
    for (const p of ['/api/agents', '/api/app', 'api/app/x', 'http://evil.example/api/app/x', undefined]) {
      await assert.rejects(() => api.appFetch(p), /not an app route/, String(p));
    }
    assert.equal(sent, 0);
  });

  test('(−) without the shell global (browser tier): isApp is false and appFetch sends nothing', async () => {
    let sent = 0;
    globalThis.fetch = async () => { sent++; return { status: 200, headers: new Map(), text: async () => '{}' }; };
    for (const bad of [undefined, { secret: '', port: 1 }, { port: 1 }, { secret: 42, port: 1 }]) {
      const api = await load(bad);
      assert.equal(api.isApp, false);
      await assert.rejects(() => api.appFetch('/api/app/me'), /app tier only/);
    }
    assert.equal(sent, 0);
  });

  test('(−) a non-JSON error body becomes a message, a network failure rejects', async () => {
    globalThis.fetch = async () => ({ status: 502, headers: new Map(), text: async () => '<html>bad gateway</html>' });
    const api = await load({ secret: 's', port: 1 });
    const r = await api.appFetch('/api/app/me');
    assert.equal(r.status, 502);
    assert.match(r.body.message, /bad gateway/);
    globalThis.fetch = async () => { throw new TypeError('network down'); };
    await assert.rejects(() => api.appFetch('/api/app/me'), /network down/);
  });

  test('(+) getJSON reads a public route and throws on a bad status', async () => {
    const api = await load(null);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ groups: [] }) });
    assert.deepEqual(await api.getJSON('/api/agents'), { groups: [] });
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(() => api.getJSON('/api/agents'), /HTTP 500/);
  });

  test('(+) applyTheme pins light or dark and removes the pin for system or garbage', async () => {
    const root = { dataset: {} };
    globalThis.document = { documentElement: root };
    const api = await load(null);
    api.applyTheme('dark');
    assert.equal(root.dataset.theme, 'dark');
    api.applyTheme('light');
    assert.equal(root.dataset.theme, 'light');
    api.applyTheme('system');
    assert.equal(root.dataset.theme, undefined);
    api.applyTheme('dark');
    api.applyTheme('<script>');
    assert.equal(root.dataset.theme, undefined);
  });
});

describe('static files served by the server', () => {
  const fx = makeFixture();
  const TOKEN = 'ui-test-token';
  const CSP = [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  let server;
  let port;

  before(async () => {
    server = createServer({ config: fx.config, exec: fakeExec(), token: TOKEN, now: () => NOW, version: '0.2.0' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    cleanup(fx);
  });

  const get = (p, method = 'GET') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });

  test('(+) every file in public/ is served with the right type, the unchanged CSP and nosniff', async () => {
    assert.ok(files.length >= 14, 'public/ has the main UI and the session window');
    for (const f of files) {
      const url = f === 'index.html' ? '/' : `/${f}`;
      const r = await get(url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers['content-type'], TYPES[path.extname(f)], url);
      assert.equal(r.headers['content-security-policy'], CSP, url);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(r.headers['x-frame-options'], 'DENY', url);
      if (f !== 'index.html') assert.equal(r.body.toString('utf8'), fs.readFileSync(path.join(PUBLIC, f), 'utf8'), `${url} is served byte for byte`);
    }
  });

  test('(+) /shortcuts.js is served (both tiers load it) byte for byte, as JavaScript', async () => {
    const r = await get('/shortcuts.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.body.toString('utf8'), fs.readFileSync(path.join(PUBLIC, 'shortcuts.js'), 'utf8'));
  });

  test('(+) the page gets this process\'s token in its meta tag and no placeholder is left', async () => {
    const r = await get('/');
    const body = r.body.toString('utf8');
    assert.match(body, new RegExp(`<meta name="nika-token" content="${TOKEN}">`));
    assert.doesNotMatch(body, /__NIKA_TOKEN__/);
  });

  test('(−) an unknown path, a directory traversal, a source-tree path and /index.html all 404', async () => {
    for (const p of ['/nope.js', '/public/app.js', '/..%2Fpackage.json', '/../package.json', '/src/server.js', '/index.html', '/app.js.map', '/tokens.css/']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
    }
  });

  test('(−) the browser tier does not mount /api/app (the privileged routes exist only on the private server)', async () => {
    for (const p of ['/api/app', '/api/app/me', '/api/app/settings', '/api/app/projects']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });

  test('(−) static files accept GET only', async () => {
    const r = await get('/app.js', 'POST');
    assert.equal(r.status, 405);
  });
});

describe('ui.js restoreFocus: a dialog opened from a menu item gives focus back to the menu button (Task 14b, B9)', () => {
  const src = read('ui.js');
  const head = src.indexOf('function restoreFocus(dlg)');
  const body = src.slice(head, src.indexOf('\n}\n', head) + 2);
  const node = (name, over = {}) => ({ name, isConnected: true, focused: 0, focus() { this.focused += 1; }, closest: () => null, ...over });
  /** restoreFocus as shipped, run against a tiny page: `$` answers from `byQuery`, `openers` holds what openDialog would have stored. */
  const rig = ({ opener, fk = null, menu = null, button = null, openDialogs = false, heading = node('h1') }) => {
    const asked = [];
    const byQuery = (sel) => {
      asked.push(sel);
      if (sel === 'dialog[open]') return openDialogs ? node('dialog') : null;
      if (menu && sel === `[aria-controls="${menu.id}"]`) return button;
      if (sel === '.screen:not([hidden]) h1') return heading;
      return null;
    };
    const dlg = {};
    const openers = new Map([[dlg, { el: opener, fk }]]);
    const run = vm.runInNewContext(`${body}; restoreFocus`, { $: byQuery, openers, CSS: { escape: (s) => s } });
    return { run: () => run(dlg), asked, heading, openers, dlg };
  };
  const menuItem = (menu, over = {}) => node('item', { closest: (s) => (s === '.menu' ? menu : null), ...over });

  test('(+) the opener sat in a closed menu: the button that names the menu in aria-controls gets the focus, not the hidden item', () => {
    const menu = { id: 'menu-7', hidden: true };
    const button = node('menu button');
    const item = menuItem(menu);
    const r = rig({ opener: item, menu, button });
    r.run();
    assert.equal(button.focused, 1);
    assert.equal(item.focused, 0, 'a hidden control cannot take focus');
    assert.equal(r.heading.focused, 0);
    assert.equal(r.openers.has(r.dlg), false, 'the stored opener is consumed as before');
  });

  test('(+) a closed menu whose button cannot be found falls back to the screen heading, as for a gone opener', () => {
    const menu = { id: 'menu-8', hidden: true };
    const item = menuItem(menu);
    const r = rig({ opener: item, menu, button: null });
    r.run();
    assert.equal(item.focused, 0);
    assert.equal(r.heading.focused, 1);
  });

  test('(−) an opener in an open menu, or outside any menu, keeps the focus as today', () => {
    const open = { id: 'menu-9', hidden: false };
    const inOpen = menuItem(open);
    rig({ opener: inOpen, menu: open, button: node('b') }).run();
    assert.equal(inOpen.focused, 1);
    const plain = node('plain button');
    const r = rig({ opener: plain });
    r.run();
    assert.equal(plain.focused, 1);
    assert.equal(r.heading.focused, 0);
  });

  test('(−) a gone opener still falls back to its data-fk, then the heading; another open dialog still blocks the restore', () => {
    const gone = node('gone', { isConnected: false });
    const r = rig({ opener: gone });
    r.run();
    assert.equal(r.heading.focused, 1);
    assert.equal(gone.focused, 0);
    const blocked = rig({ opener: node('x'), openDialogs: true });
    blocked.run();
    assert.equal(blocked.heading.focused, 0);
    assert.equal(blocked.openers.has(blocked.dlg), true, 'untouched: the other dialog will restore it');
  });

  test('(+) the source asks for the menu through aria-controls and the id, never through sibling order', () => {
    assert.match(body, /\.closest\('\.menu'\)/);
    assert.match(body, /aria-controls="\$\{CSS\.escape\(/);
  });
});
