// The apply-rules sheet (public/project.js, app.css): a preview entry the server SKIPPED (a symlinked AGENTS.md beside a CLAUDE.md,
// F8) shows its own mark, label and note, is never counted as a change and never preselected. The browser is exercised by hand;
// here the real page code runs in a vm against the small fake DOM (test/fake-dom.js). Project and file names are synthetic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { El, installDom, withClass } from './fake-dom.js';
import { h, icon } from '../public/dom.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const PROJECT_SRC = code(read('project.js')).replace(/^import[\s\S]*?from '[^']+';$/gm, '').replace(/^export /gm, '');
const APP_CSS = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const settle = () => new Promise((r) => setImmediate(r));

let restore;
before(() => { restore = installDom(); });
after(() => restore());

const KEY = '0123456789abcdef';
const NOTE = 'AGENTS.md is a link; left as is';
const FILES = [
  { path: 'rules/orchestration.md', action: 'create', diff: '--- a/rules/orchestration.md\n+++ b/rules/orchestration.md\n@@ -0,0 +1 @@\n+# rules\n', foreign: false },
  { path: 'CLAUDE.md', action: 'update', diff: '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1,3 @@\n # acme-api\n+\n+@rules/orchestration.md\n' },
  { path: 'AGENTS.md', action: 'skipped', diff: '', note: NOTE },
  { path: '.claude/settings.local.json', action: 'unchanged', diff: '', keysPreserved: true, keptKeys: 0 },
];

function rig(files) {
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) {
      const el = new El(sel === '#dlg-rules' ? 'dialog' : 'div');
      el.classList = { toggle() {} };
      nodes.set(sel, el);
    }
    return nodes.get(sel);
  };
  const calls = [];
  const copied = [];
  const appFetch = async (url, opts = {}) => {
    calls.push({ method: opts.method ?? 'GET', url, json: opts.json });
    if (url === '/api/app/rules/apply') return { status: 200, body: { written: ['rules/orchestration.md'], backupDir: '/state/backups/acme-api/20261113T000000Z' } };
    if (url === '/api/app/rules/preview') return { status: 200, body: { hash: 'a'.repeat(64), files, warnings: [], backupDir: '/state/backups/acme-api/20261113T000000Z' } };
    throw new Error(`unexpected request ${url}`);
  };
  const ctx = {
    h, icon, $: node, state: { settings: {}, projects: [], modes: { map: {} } }, hooks: {}, appFetch, announce: () => {}, copyText: (text, what) => copied.push([text, what]),
    parseModes: () => null, modesAfter: (modes) => modes, // the poll that follows an apply finds nothing new here
    errText: (r) => r?.body?.message ?? `The server answered ${r?.status}.`,
    openDialog: (dlg) => { dlg.open = true; }, swap: (host, list) => host.replaceChildren(...list.flat().filter(Boolean)),
    setBusy: () => {}, render: () => {}, rulesEl: () => new El('span'), location: { hash: '' }, document: { title: '' }, window: { addEventListener: () => {} },
    setTimeout, clearTimeout, AbortController, TextEncoder,
  };
  const api = vm.runInNewContext(`${PROJECT_SRC}\n({ openRules, ru })`, ctx);
  return { api, node, calls, ctx, copied };
}

const navButtons = (r) => r.node('#ru-main').all((n) => n.tag === 'button' && n.attrs['data-fk']?.startsWith('ruf:'));
const marks = (r) => r.node('#ru-main').all(withClass('act'));

test('(+) a skipped entry has its own mark, "skipped" label and note; it is not preselected and not counted as a change', async () => {
  const r = rig(FILES);
  r.api.openRules({ key: KEY, dir: '/work/acme-api', name: 'acme-api' });
  await settle();
  const buttons = navButtons(r);
  assert.deepEqual(buttons.map((b) => b.all(withClass('fp'))[0].textContent), FILES.map((f) => f.path));
  assert.deepEqual(buttons.map((b) => b.all(withClass('fa'))[0].textContent), ['create', 'update', 'skipped', 'unchanged']);
  const skipped = buttons[2].all(withClass('act'))[0];
  assert.equal(skipped.attrs['data-a'], 'skipped');
  assert.equal(skipped.textContent, '–', 'a mark of its own, not the "?" fallback');
  assert.equal(marks(r)[0].attrs['data-a'], 'create');
  assert.equal(r.api.ru.sel, 0, 'the first file that changes is selected, not the skipped one');
  assert.match(r.node('#ru-foot').textContent, /^2 files change · 1 unchanged · 1 skipped/);
  buttons[2].click();
  const view = r.node('#ru-main').all((n) => n.tag === 'section')[0];
  assert.match(view.textContent, /AGENTS\.md/);
  assert.ok(view.textContent.includes(NOTE), 'the note is shown');
  assert.equal(view.all(withClass('dl')).length, 0, 'no diff for a file nika does not touch');
});

test('(+) with nothing else to change the skipped file is still not preselected, and the footer counts it apart', async () => {
  const r = rig([{ ...FILES[0], action: 'unchanged', diff: '' }, { ...FILES[1], action: 'unchanged', diff: '' }, FILES[2], FILES[3]]);
  r.api.openRules({ key: KEY, dir: '/work/acme-api', name: 'acme-api' });
  await settle();
  assert.equal(r.api.ru.sel, 0);
  assert.match(r.node('#ru-foot').textContent, /^0 files change · 3 unchanged · 1 skipped/);
});

test('(+) after Apply the backup path has a copy button with a title equal to its name (icon only); a failed apply shows none (0.4.0)', async () => {
  const r = rig(FILES);
  r.api.openRules({ key: KEY, dir: '/work/acme-api', name: 'acme-api' });
  await settle();
  r.node('#ru-foot').all((n) => n.attrs.id === 'ru-apply')[0].click();
  await settle();
  const copy = r.node('#ru-main').all((n) => n.tag === 'button' && n.attrs['aria-label'] === 'Copy backup path')[0];
  assert.ok(copy, 'the success view has it');
  assert.equal(copy.attrs.title, 'Copy backup path');
  copy.click();
  assert.deepEqual(r.copied, [['/state/backups/acme-api/20261113T000000Z', 'backup path']]);
  const fresh = rig(FILES);
  fresh.api.openRules({ key: KEY, dir: '/work/acme-api', name: 'acme-api' });
  await settle();
  assert.equal(fresh.node('#ru-main').all((n) => n.attrs?.['aria-label'] === 'Copy backup path').length, 0, 'the preview has no such button');
});

test('(+) the page never sends a file list: apply posts the hash and the two flags only, so a skipped file cannot be written from here', () => {
  const src = code(read('project.js'));
  const apply = /json: \{ project: ru\.project\.key, hash[^}]*\}/.exec(src)?.[0] ?? '';
  assert.equal(apply, 'json: { project: ru.project.key, hash: ru.preview.hash, overwriteForeign: ru.foreignOk, gitignore: ru.gitignore }');
});

test('(+) the stylesheet gives the skipped mark its own look (dashed outline, no fill) and its own colour, apart from every other mark', () => {
  const rule = (a) => new RegExp(`\\.act\\[data-a="${a}"\\]\\s*\\{([^}]*)\\}`).exec(APP_CSS)?.[1] ?? '';
  const colour = (a) => /(?:^|;)\s*color:\s*([^;]+);/.exec(rule(a))?.[1].trim();
  assert.match(rule('skipped'), /dashed/);
  assert.match(rule('skipped'), /background:\s*none/);
  assert.ok(colour('skipped'), 'the skipped mark sets a colour');
  for (const other of ['create', 'update', 'unchanged', 'foreign']) assert.notEqual(colour('skipped'), colour(other), `not the colour of ${other}`);
});
