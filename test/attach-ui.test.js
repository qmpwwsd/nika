// The page side of attachments (design W2 sections 6, 8 and 10; nika 0.5): public/attach.js, with the fake DOM of test/fake-dom.js and
// a fake of session.js's io (the route answers are scripted, the clock never runs). Every chip state has its icon and its words; the
// Send table of section 6 runs row by row; every server code maps to a fixed copy line and the server's own text never shows.
// Also the static side: the markup, the stylesheet (tokens only), the hooks in session.js, the static-file list, the shell's one line.
// Fixtures are synthetic (acme-api, %7).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FILES, MAX_BYTES, formatSize, shownName, uploadView, sendView, typeIcon, createAttachTray,
} from '../public/attach.js';
import { installDom, El, focus } from './fake-dom.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = read('public', 'session.html');
const CSS = read('public', 'session.css');
const TOKENS = read('public', 'tokens.css');
const SRC = read('public', 'attach.js');
const SESSION = read('public', 'session.js');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

const DOTS = String.fromCharCode(0x2026);
const MID = String.fromCharCode(0xb7);
const SIG = 'a1b2c3d4e5f60718';
const SIG2 = '0f1e2d3c4b5a6978';

// ---- the harness ------------------------------------------------------------------------------------------------------------------

class TEl extends El {
  constructor(tag) {
    super(tag);
    this.classes = new Set();
    this.classList = { toggle: (c, on) => { if (on) this.classes.add(c); else this.classes.delete(c); }, contains: (c) => this.classes.has(c) };
    this.clicks = 0;
  }

  click() { this.clicks += 1; super.click(); }
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };
const file = (name, size = 1000) => ({ name, size, type: '' });
const screenOf = (over = {}) => ({ state: 'empty', mode: 'prompt', text: '', sig: SIG, box: { top: 0, bottom: 2 }, cursorAtEnd: true, suggestion: null, ...over });
const uploadId = (n) => `00000000000000${String(n).padStart(2, '0')}`;
const typeOf = (name) => (/\.png$/.test(name) ? 'png' : /\.pdf$/.test(name) ? 'pdf' : 'text');
const isUpload = (p, o) => o.method === 'POST' && /\/attachments$/.test(p);
const isSend = (p, o) => o.method === 'POST' && /\/attach-send$/.test(p);
const sends = (r) => r.log.calls.filter((c) => c.path.endsWith('attach-send'));
const deletes = (r) => r.log.calls.filter((c) => c.method === 'DELETE');
const icons = (node) => node.all(() => true).filter((n) => n.tag === 'use').map((n) => n.attrs.href);

let current = null;
afterEach(() => { current?.(); current = null; });

/** A page with the ids attach.js looks up, and the io session.js gives createAttachTray. `reply(path, opts)` scripts a route answer. */
function rig(opts = {}) {
  current?.(); // one page at a time: a second rig in a test starts from a clean document
  const els = {};
  for (const [id, tag] of [['att-tray', 'ul'], ['att-btn', 'button'], ['att-input', 'input'], ['att-drop', 'span'], ['composer-box', 'div'], ['composer', 'textarea'], ['send', 'button']]) els[id] = new TEl(tag);
  els['att-tray'].hidden = true;
  els['att-drop'].hidden = true;
  els['att-input'].files = [];
  const docListeners = {};
  const restoreDom = installDom({ getElementById: (id) => els[id] ?? null, addEventListener: (t, fn) => { (docListeners[t] ??= []).push(fn); } });
  const savedWindow = globalThis.window;
  globalThis.window = new TEl('window');
  current = () => { restoreDom(); globalThis.window = savedWindow; };
  const doc = (type, extra = {}) => {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of docListeners[type] ?? []) fn(e);
    return e;
  };
  const log = { calls: [], say: [], announce: [], problem: [], notice: [], gone: 0, ds: [], clear: [], focus: 0, jobs: 0, sleeps: [] };
  const state = { screen: opts.screen === undefined ? screenOf() : opts.screen, working: false, shell: false, pushed: null, sentReply: null, n: 0 };
  const reply = opts.reply ?? ((p, o) => {
    if (isUpload(p, o)) {
      state.n += 1;
      return { status: 200, body: { id: uploadId(state.n), type: typeOf(o.json.name), size: 123 } };
    }
    if (isSend(p, o)) return state.sentReply ?? { status: 200, body: { sent: o.json.ids.length, images: 0 } };
    return { status: 200, body: { removed: true } };
  });
  const io = {
    paneId: opts.paneId === undefined ? '%7' : opts.paneId,
    path: (tail) => `/api/app/pane/${encodeURIComponent('%7')}/${tail}`,
    call: async (p, o = {}) => {
      log.calls.push({ path: p, method: o.method ?? 'GET', json: o.json });
      return reply(p, { ...o, method: o.method ?? 'GET' });
    },
    appFetch: async (p, o = {}) => { log.calls.push({ path: p, method: o.method ?? 'GET', keepalive: o.keepalive === true, json: o.json }); return { status: 200, body: null }; },
    ds: {
      screen: () => state.screen,
      send: async (text) => {
        log.ds.push(['send', text]);
        if (state.pushed) return state.pushed;
        state.screen = screenOf({ state: 'text', text, sig: SIG2 }); // the answer of the push carries the screen's new draft
        return { ok: true };
      },
      beginSend: () => log.ds.push(['begin']),
      endSend: () => log.ds.push(['end']),
    },
    enqueueJob: (run) => { log.jobs += 1; return Promise.resolve().then(run); },
    say: (m) => log.say.push(m),
    announce: (m) => log.announce.push(m),
    showProblem: (m, kind, ms) => log.problem.push([m, kind, ms]),
    clearProblem: () => log.problem.push(['']),
    showNotice: (m) => log.notice.push(m),
    setGone: () => { log.gone += 1; },
    box: () => ({ value: '', shell: state.shell }),
    working: () => state.working,
    cols: () => 120,
    clearBox: (v) => log.clear.push(v),
    focusBox: () => { log.focus += 1; },
    read: opts.read ?? (async () => 'QUJD'),
    sleep: async (ms) => { log.sleeps.push(ms); },
  };
  const att = createAttachTray(io);
  att.wire();
  const tray = els['att-tray'];
  return {
    att, els, io, log, state, tray, doc, win: globalThis.window,
    chips: () => tray.kids,
    add: async (...fs) => { els['att-input'].files = fs; els['att-input'].fire('change'); await settle(); },
  };
}

/** What a chip shows: [holder, name, meta, remove button] of its li. */
const view = (li) => {
  const [holder, n, m, x] = li.kids;
  return { s: li.attrs['data-s'], busy: li.attrs['aria-busy'], icons: icons(holder), spin: holder.all((k) => k.className === 'spin').length > 0, name: n.textContent, title: n.attrs.title, meta: m.textContent, x };
};

// ---- the pure rules -----------------------------------------------------------------------------------------------------------------

describe('formatSize', () => {
  test('(+) bytes, whole KB, one-decimal MB', () => {
    assert.equal(formatSize(0), '0 B');
    assert.equal(formatSize(820), '820 B');
    assert.equal(formatSize(1023), '1023 B');
    assert.equal(formatSize(14 * 1024), '14 KB');
    assert.equal(formatSize(1258291), '1.2 MB');
    assert.equal(formatSize(MAX_BYTES), '8.0 MB');
  });

  test('(+) just under a megabyte never reads as 1024 KB', () => {
    assert.equal(formatSize(1048575), '1.0 MB');
  });

  test('(−) not a size gives 0 B', () => {
    for (const v of [-1, NaN, Infinity, '5', null, undefined, {}]) assert.equal(formatSize(v), '0 B', String(v));
  });
});

describe('shownName', () => {
  test('(+) a plain name is kept; controls and bidi marks are dropped; the length is capped', () => {
    assert.equal(shownName('shot 1.png'), 'shot 1.png');
    assert.equal(shownName(`a${String.fromCharCode(0x202e)}b\u0000c\u007fd`), 'abcd');
    assert.equal(shownName('x'.repeat(400)).length, 255);
  });

  test('(−) empty, blank, or not a string gives the placeholder', () => {
    for (const v of ['', '   ', undefined, null, 5, {}, String.fromCharCode(0x202e)]) assert.equal(shownName(v), 'file', String(v));
  });
});

describe('typeIcon', () => {
  test('(+) images, pdf and text each draw their own symbol', () => {
    for (const t of ['png', 'jpeg', 'gif', 'webp']) assert.equal(typeIcon(t), 'image');
    assert.equal(typeIcon('pdf'), 'file');
    assert.equal(typeIcon('text'), 'text');
  });
});

describe('uploadView: section 8.6, upload rows', () => {
  const v = (status, error, name = 'notes.md') => uploadView({ status, code: error }, name);

  test('(+) every row has its chip short form and problem line, verbatim', () => {
    assert.deepEqual(v(413, 'too-big'), { short: `Too big ${MID} max 8 MB`, line: null });
    assert.deepEqual(v(413, 'too_large'), { short: `Too big ${MID} max 8 MB`, line: null });
    assert.deepEqual(v(415, 'wrong-type'), { short: 'Not supported', line: 'notes.md: use PNG, JPEG, GIF, WebP, PDF or UTF-8 text.' });
    assert.deepEqual(v(400, 'empty'), { short: 'Empty file', line: null });
    assert.deepEqual(v(409, 'no-project'), { short: 'Try again', line: "nika can't tell this session's project yet. Try again in a moment." });
    assert.deepEqual(v(409, 'path-unusable'), { short: "Can't store", line: "nika's attachments folder has a path Claude can't take (a space or a special character). Set XDG_STATE_HOME to a plain path." });
    assert.deepEqual(v(409, 'folder-unsafe'), { short: "Can't store", line: "nika's attachments folder isn't safe to write to (a link, or another owner). Nothing was saved." });
    assert.deepEqual(v(507, 'storage-full'), { short: 'Storage full', line: "nika's attachment storage is full (256 MB). Older attachments go after a day or two; try again later." });
    assert.deepEqual(v(507, 'disk-full'), { short: 'Disk full', line: 'The disk is full. Nothing was saved.' });
  });

  test('(+) 429 after the retry, no answer, 5xx and any other code are "Upload failed" with no line', () => {
    for (const [s, c] of [[429, 'busy'], [0, undefined], [500, 'write-failed'], [502, undefined], [503, undefined], [400, 'invalid'], [415, 'unsupported_media'], [409, 'surprise'], [507, 'other'], [418, 'x']]) {
      assert.deepEqual(v(s, c), { short: 'Upload failed', line: null }, `${s} ${c}`);
    }
  });

  test('(−) the server\'s own text never reaches the page', () => {
    const out = uploadView({ status: 409, code: 'no-project', message: 'SERVER SAID THIS /secret/path' }, 'a.txt');
    assert.doesNotMatch(JSON.stringify(out), /SERVER|secret/);
    assert.equal(uploadView(null, 'a.txt').short, 'Upload failed');
    assert.equal(uploadView(undefined, 'a.txt').short, 'Upload failed');
  });
});

describe('sendView: section 8.6, send rows', () => {
  const ctx = { total: 3, nameOf: (id) => (id === 'aaaaaaaaaaaaaaaa' ? 'plan.pdf' : null) };
  const s = (status, error, extra = {}, c = ctx) => sendView({ status, body: { error, pasted: 0, ...extra } }, c);

  test('(+) nothing pasted: one fixed line per code', () => {
    assert.equal(s(409, 'not-idle').line, 'Attachments go when Claude is waiting. Nothing was sent; your text and attachments are kept.');
    for (const c of ['mode-unknown', 'input-unreadable']) assert.equal(s(409, c).line, "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.");
    assert.equal(s(409, 'draft-unreadable', { reason: 'pasted' }).line, "Claude's input holds something nika can't read back. Send or clear it in the terminal, then try again.");
    assert.equal(s(409, 'draft-changed').line, "Claude's input changed while nika was getting ready. Nothing was sent; try again.");
    assert.equal(s(409, 'shell-mode').line, "Claude's input is in ! mode. Press Backspace in the terminal to leave it, then send again.");
    for (const c of ['cursor-not-at-end', 'vim-normal']) assert.equal(s(409, c).line, "Claude's input is in vim normal mode or its cursor isn't at the end. Press i (or End) in the terminal, then send again.");
    assert.equal(s(409, 'screen-changed').line, "Claude's screen changed, so nothing was sent.");
    assert.equal(s(409, 'busy-switching').line, 'Another action is running on this session. Try again in a moment.');
    assert.equal(s(429, 'busy').line, 'Too many keys at once; try again.');
  });

  test('(+) a file that is gone names the chip and marks it; one the page does not know is named generically', () => {
    const gone = s(409, 'attachment-gone', { id: 'aaaaaaaaaaaaaaaa' });
    assert.equal(gone.line, 'plan.pdf is no longer on disk. Remove it and add it again.');
    assert.equal(gone.goneId, 'aaaaaaaaaaaaaaaa');
    assert.equal(s(409, 'attachment-gone', { id: 'bbbbbbbbbbbbbbbb' }).line, 'An attachment is no longer on disk. Remove it and add it again.');
    assert.equal(s(409, 'attachment-gone', { id: '../etc' }).goneId, null, 'an id that is not 16 hex marks nothing');
  });

  test('(+) the stored path was refused at the send: the upload\'s folder line', () => {
    assert.match(s(409, 'path-unusable', { id: 'aaaaaaaaaaaaaaaa' }).line, /^nika's attachments folder has a path Claude can't take/);
  });

  test('(+) some pasted: how many went in, why it stopped, what to do, verbatim', () => {
    const tail = " Send or clear Claude's input in the terminal (Esc twice), then send again. Your text and attachments are kept here.";
    assert.equal(s(409, 'screen-changed', { pasted: 1 }).line, `nika put 1 of 3 attachments into Claude's input, then stopped without pressing Enter: Claude's screen changed (a prompt, a menu or a search may be open; Esc closes a search).${tail}`);
    assert.equal(s(409, 'not-taken', { pasted: 2, id: 'aaaaaaaaaaaaaaaa' }).line, `nika put 2 of 3 attachments into Claude's input, then stopped without pressing Enter: Claude didn't take plan.pdf.${tail}`);
    assert.equal(s(409, 'not-idle', { pasted: 3 }).line, `nika put 3 of 3 attachments into Claude's input, then stopped without pressing Enter: Claude started working.${tail}`);
    assert.ok(s(409, 'not-taken', { pasted: 1, id: 'cccccccccccccccc' }).line.includes("Claude didn't take the file."));
    assert.match(s(409, 'screen-changed', { pasted: 1 }, { total: 1, nameOf: () => null }).line, /^nika put 1 of 1 attachment into/);
  });

  test('(+) a rate limit or a failure after some pasted still says how many went in', () => {
    assert.match(s(429, 'busy', { pasted: 1 }).line, /^nika put 1 of 3 attachments into Claude's input, then stopped without pressing Enter: too many keys at once\./);
    assert.match(s(502, 'tmux_failed', { pasted: 2 }).line, /^nika put 2 of 3 attachments into Claude's input, then stopped without pressing Enter: nika could not finish\./);
  });

  test('(+) 404 is the gone session; no answer says it is not known what went in; the rest is a generic line', () => {
    assert.deepEqual(sendView({ status: 404, body: { error: 'not_found' } }, ctx), { line: 'The session is gone.', gone: true, goneId: null });
    assert.match(sendView({ status: 0, body: null }, ctx).line, /^nika did not answer, so it is not known whether anything was sent\. Check Claude's input in the terminal\./);
    for (const [st, c] of [[400, 'invalid'], [500, 'internal'], [502, 'tmux_failed'], [503, 'tmux_unavailable'], [409, 'surprise']]) {
      assert.equal(s(st, c).line, "nika couldn't send the attachments. Nothing was sent; your text and attachments are kept.", `${st} ${c}`);
    }
  });

  test('(−) pasted is trusted only as a small positive count; the server\'s text never shows', () => {
    for (const p of [-1, 1.5, '2', NaN, null]) assert.doesNotMatch(s(409, 'screen-changed', { pasted: p }).line, /^nika put/, String(p));
    assert.match(s(409, 'screen-changed', { pasted: 99 }).line, /^nika put 3 of 3 /, 'never more than the files sent');
    assert.doesNotMatch(JSON.stringify(sendView({ status: 409, body: { error: 'not-idle', pasted: 0, message: 'SERVER SAID THIS', draft: { text: 'secret draft' } } }, ctx)), /SERVER|secret/);
    assert.equal(sendView(null, ctx).goneId, null);
  });
});

// ---- the chips ------------------------------------------------------------------------------------------------------------------

describe('chip states: icon, words and colour hook (visible-state rule)', () => {
  test('(+) uploading: a spinner, "Uploading…", aria-busy; ready: the type icon and the size; failed: the warning icon and the reason', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const r = rig({ reply: async (p, o) => { if (isUpload(p, o)) { await gate; return { status: 200, body: { id: uploadId(1), type: 'png', size: 14 * 1024 } }; } return { status: 200, body: {} }; } });
    await r.add(file('shot.png'), file('huge.bin', MAX_BYTES + 1));
    const up = view(r.chips()[0]);
    assert.deepEqual([up.s, up.busy, up.spin, up.meta], ['uploading', 'true', true, `Uploading${DOTS}`]);
    assert.deepEqual(up.icons, []);
    const bad = view(r.chips()[1]);
    assert.deepEqual([bad.s, bad.busy, bad.spin, bad.meta, bad.icons], ['failed', undefined, false, `Too big ${MID} max 8 MB`, ['#i-warn']]);
    release();
    await settle();
    const ok = view(r.chips()[0]);
    assert.deepEqual([ok.s, ok.busy, ok.spin, ok.meta, ok.icons], ['ready', undefined, false, '14 KB', ['#i-image']]);
  });

  test('(+) a ready chip draws the icon of its type: image, file (pdf), text', async () => {
    const r = rig();
    await r.add(file('a.png'), file('b.pdf'), file('c.md'));
    assert.deepEqual(r.chips().map((li) => view(li).icons[0]), ['#i-image', '#i-file', '#i-text']);
  });

  test('(+) the states are announced politely, and the tray shows once it has a chip', async () => {
    const r = rig();
    assert.equal(r.tray.hidden, true);
    await r.add(file('shot.png', 820), file('huge.bin', MAX_BYTES + 1));
    assert.equal(r.tray.hidden, false);
    assert.deepEqual(r.log.announce, [`huge.bin can't be attached: Too big ${MID} max 8 MB.`, 'Attached shot.png, 123 B.']);
  });

  test('(−) a name with markup is text: no element, the full name in title and in the remove label', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const r = rig();
    await r.add(file(evil));
    const li = r.chips()[0];
    const v = view(li);
    assert.equal(v.name, evil);
    assert.equal(li.kids[1].kids.length, 0, 'no child element in the name');
    assert.equal(v.title, evil);
    assert.equal(v.x.attrs['aria-label'], `Remove ${evil}`);
    assert.equal(v.x.attrs.title, `Remove ${evil}`);
    assert.equal(v.x.attrs.type, 'button');
  });

  test('(−) a name without any characters falls back to "file"; the upload still carries the raw name for its extension', async () => {
    const r = rig();
    await r.add(file(''));
    assert.equal(view(r.chips()[0]).name, 'file');
    assert.equal(r.log.calls[0].json.name, '');
  });
});

describe('adding files', () => {
  test('(+) a file is read, then posted as { name, data } to the pane\'s attachments route; the answer makes it ready', async () => {
    const r = rig();
    await r.add(file('notes.md', 500));
    assert.equal(r.log.calls.length, 1);
    assert.deepEqual(r.log.calls[0], { path: '/api/app/pane/%257/attachments', method: 'POST', json: { name: 'notes.md', data: 'QUJD' } });
    assert.deepEqual(Object.keys(r.log.calls[0].json), ['name', 'data'], 'exactly the two keys the route takes');
    assert.equal(view(r.chips()[0]).s, 'ready');
  });

  test('(+) the name sent is cut to 255 units', async () => {
    const r = rig();
    await r.add(file('y'.repeat(300)));
    assert.equal(r.log.calls[0].json.name.length, 255);
  });

  test('(+) exactly 8 MiB goes up; (−) one byte more is a failed chip and no request', async () => {
    const r = rig();
    await r.add(file('edge.png', MAX_BYTES));
    assert.equal(r.log.calls.length, 1);
    await r.add(file('over.png', MAX_BYTES + 1));
    assert.equal(r.log.calls.length, 1, 'no second request');
    assert.deepEqual([view(r.chips()[1]).s, view(r.chips()[1]).meta], ['failed', `Too big ${MID} max 8 MB`]);
  });

  test('(+) a 9 MB file: a failed chip "Too big", no read, no request', async () => {
    let reads = 0;
    const r = rig({ read: async () => { reads += 1; return ''; } });
    await r.add(file('nine.pdf', 9 * 1024 * 1024));
    assert.equal(reads, 0);
    assert.equal(r.log.calls.length, 0);
    assert.equal(view(r.chips()[0]).s, 'failed');
  });

  test('(+) six files are fine; (−) the 7th is not added and the problem line says why (warn, 4 s)', async () => {
    const r = rig();
    await r.add(...Array.from({ length: MAX_FILES }, (_, i) => file(`f${i}.md`)));
    assert.equal(r.chips().length, 6);
    assert.deepEqual(r.log.problem, []);
    await r.add(file('seventh.md'));
    assert.equal(r.chips().length, 6);
    assert.equal(r.log.calls.length, 6);
    assert.deepEqual(r.log.problem, [['Up to 6 attachments per message.', 'warn', 4000]]);
  });

  test('(−) a batch that crosses the limit adds the files that fit and refuses the rest once', async () => {
    const r = rig();
    await r.add(...Array.from({ length: 8 }, (_, i) => file(`f${i}.md`)));
    assert.equal(r.chips().length, 6);
    assert.equal(r.log.problem.filter(([m]) => m === 'Up to 6 attachments per message.').length, 1);
  });

  test('(+) one upload at a time: the second request leaves after the first was answered', async () => {
    const releases = [];
    const r = rig({ reply: (p, o) => (isUpload(p, o) ? new Promise((resolve) => { releases.push(() => resolve({ status: 200, body: { id: uploadId(releases.length), type: 'text', size: 1 } })); }) : { status: 200, body: {} }) });
    await r.add(file('a.md'), file('b.md'));
    assert.equal(r.log.calls.length, 1);
    assert.deepEqual(r.chips().map((li) => view(li).s), ['uploading', 'uploading']);
    releases[0]();
    await settle();
    assert.equal(r.log.calls.length, 2);
    releases[1]();
    await settle();
    assert.deepEqual(r.chips().map((li) => view(li).s), ['ready', 'ready']);
  });

  test('(+) 429 busy retries once after 1 s; (−) a second 429 is "Upload failed"', async () => {
    let n = 0;
    const r = rig({ reply: (p, o) => { if (!isUpload(p, o)) return { status: 200, body: {} }; n += 1; return n === 1 ? { status: 429, body: { error: 'busy' } } : { status: 200, body: { id: uploadId(1), type: 'text', size: 5 } }; } });
    await r.add(file('a.md'));
    assert.deepEqual(r.log.sleeps, [1000]);
    assert.equal(view(r.chips()[0]).s, 'ready');
    const r2 = rig({ reply: () => ({ status: 429, body: { error: 'busy' } }) });
    await r2.add(file('a.md'));
    assert.equal(r2.log.calls.length, 2, 'one retry, not more');
    assert.deepEqual([view(r2.chips()[0]).s, view(r2.chips()[0]).meta], ['failed', 'Upload failed']);
  });

  test('(+) each refusal makes a failed chip with the short form and shows the line', async () => {
    for (const [status, error, short, line] of [
      [415, 'wrong-type', 'Not supported', 'x.bin: use PNG, JPEG, GIF, WebP, PDF or UTF-8 text.'],
      [507, 'disk-full', 'Disk full', 'The disk is full. Nothing was saved.'],
      [409, 'no-project', 'Try again', "nika can't tell this session's project yet. Try again in a moment."],
    ]) {
      const r = rig({ reply: () => ({ status, body: { error, message: 'server words' } }) });
      await r.add(file('x.bin'));
      const v = view(r.chips()[0]);
      assert.deepEqual([v.s, v.meta, v.icons], ['failed', short, ['#i-warn']], error);
      assert.deepEqual(r.log.problem.at(-1).slice(0, 2), [line, 'error'], error);
      assert.doesNotMatch(JSON.stringify(r.log.problem), /server words/);
    }
  });

  test('(−) an answer that is not { id: 16 hex, type: a known type } is a failed chip, never a ready one', async () => {
    for (const body of [{ id: '../x', type: 'png', size: 1 }, { id: uploadId(1), type: 'svg', size: 1 }, {}, null, { id: 5, type: 'png' }]) {
      const r = rig({ reply: () => ({ status: 200, body }) });
      await r.add(file('x.png'));
      assert.equal(view(r.chips()[0]).s, 'failed', JSON.stringify(body));
    }
  });

  test('(−) a file that cannot be read is a failed chip and the next one still goes', async () => {
    let n = 0;
    const r = rig({ read: async () => { n += 1; if (n === 1) throw new Error('read'); return 'QUJD'; } });
    await r.add(file('dir'), file('ok.md'));
    assert.deepEqual(r.chips().map((li) => view(li).s), ['failed', 'ready']);
    assert.equal(r.log.calls.length, 1);
  });

  test('(+) 404 on an upload: the pane is gone', async () => {
    const r = rig({ reply: () => ({ status: 404, body: { error: 'not_found' } }) });
    await r.add(file('a.md'));
    assert.equal(r.log.gone, 1);
    assert.equal(view(r.chips()[0]).s, 'failed');
    assert.equal(r.log.problem.at(-1)[0], 'The session is gone.');
  });

  test('(+) a network failure (status 0) is "Upload failed"', async () => {
    const r = rig({ reply: () => ({ status: 0, body: null }) });
    await r.add(file('a.md'));
    assert.equal(view(r.chips()[0]).meta, 'Upload failed');
  });
});

describe('the ways in: button, paste, drop', () => {
  test('(+) the button opens the file picker; the picked files are added and the input is cleared', async () => {
    const r = rig();
    r.els['att-btn'].fire('click');
    assert.equal(r.els['att-input'].clicks, 1);
    r.els['att-input'].value = 'C:\\fake\\shot.png';
    r.els['att-input'].files = [file('shot.png')];
    r.els['att-input'].fire('change');
    await settle();
    assert.equal(r.els['att-input'].value, '');
    assert.equal(r.chips().length, 1);
  });

  test('(−) a disabled input ignores the button and every way of adding; enable(true) brings them back', async () => {
    const r = rig();
    r.att.enable(false);
    assert.equal(r.els['att-btn'].disabled, true);
    r.els['att-btn'].fire('click');
    assert.equal(r.els['att-input'].clicks, 0);
    const e = r.els.composer.fire('paste', { clipboardData: { files: [file('a.png')] } });
    await settle();
    assert.equal(r.chips().length, 0);
    assert.equal(e.defaultPrevented, true, 'the paste is still not inserted as text');
    r.att.enable(true);
    assert.equal(r.els['att-btn'].disabled, false);
    r.els.composer.fire('paste', { clipboardData: { files: [file('a.png')] } });
    await settle();
    assert.equal(r.chips().length, 1);
  });

  test('(−) no pane, no attachments: nothing is added or posted', async () => {
    const r = rig({ paneId: null });
    r.els.composer.fire('paste', { clipboardData: { files: [file('a.png')] } });
    r.els['att-btn'].fire('click');
    await r.add(file('b.png'));
    assert.equal(r.chips().length, 0);
    assert.equal(r.log.calls.length, 0);
  });

  test('(+) a paste that carries files adds chips and is cancelled; (−) text only is left alone', async () => {
    const r = rig();
    const withFiles = r.els.composer.fire('paste', { clipboardData: { files: [file('image.png', 300)], getData: () => 'caption' } });
    await settle();
    assert.equal(withFiles.defaultPrevented, true);
    assert.equal(r.chips().length, 1);
    const textOnly = r.els.composer.fire('paste', { clipboardData: { files: [], getData: () => 'hello' } });
    assert.equal(textOnly.defaultPrevented, false);
    assert.equal(r.els.composer.fire('paste', { clipboardData: null }).defaultPrevented, false);
    assert.equal(r.els.composer.fire('paste', {}).defaultPrevented, false);
    assert.equal(r.chips().length, 1);
  });

  test('(+) a drop of files on the box adds them and ends the drop look; (−) a text drag shows nothing and still works', async () => {
    const r = rig();
    const box = r.els['composer-box'];
    const over = (types, files = []) => ({ dataTransfer: { types, files } });
    assert.equal(box.fire('dragenter', over(['Files'])).defaultPrevented, true);
    assert.deepEqual([box.classList.contains('dropping'), r.els['att-drop'].hidden], [true, false]);
    box.fire('dragenter', over(['Files'])); // a child element: enter again
    box.fire('dragleave', over(['Files']));
    assert.equal(box.classList.contains('dropping'), true, 'still over the box (one level left)');
    box.fire('dragleave', over(['Files']));
    assert.deepEqual([box.classList.contains('dropping'), r.els['att-drop'].hidden], [false, true]);
    box.fire('dragenter', over(['Files']));
    const drop = box.fire('drop', over(['Files'], [file('a.png'), file('b.pdf')]));
    await settle();
    assert.equal(drop.defaultPrevented, true);
    assert.deepEqual([box.classList.contains('dropping'), r.els['att-drop'].hidden], [false, true]);
    assert.equal(r.chips().length, 2);
    assert.equal(box.fire('dragenter', over(['text/plain'])).defaultPrevented, false);
    assert.equal(box.classList.contains('dropping'), false);
    assert.equal(box.fire('drop', over(['text/plain'])).defaultPrevented, false, 'a text drag into the box still works');
  });

  test('(+) a drag that ends never leaves the look on', () => {
    const r = rig();
    r.els['composer-box'].fire('dragover', { dataTransfer: { types: ['Files'] } });
    assert.equal(r.els['composer-box'].classList.contains('dropping'), true);
    r.els['composer-box'].fire('dragend', {});
    assert.equal(r.els['composer-box'].classList.contains('dropping'), false);
    assert.equal(r.els['att-drop'].hidden, true);
  });

  test('(+) a file dropped anywhere else is cancelled, so the window never navigates; (−) a text drag is not touched', () => {
    const r = rig();
    for (const type of ['dragover', 'drop']) {
      assert.equal(r.doc(type, { dataTransfer: { types: ['Files'] } }).defaultPrevented, true, type);
      assert.equal(r.doc(type, { dataTransfer: { types: ['text/plain'] } }).defaultPrevented, false, type);
      assert.equal(r.doc(type, {}).defaultPrevented, false, type);
    }
  });
});

describe('removing a chip', () => {
  test('(+) a ready chip: DELETE for its id at once, the chip goes, focus moves to the next remove button', async () => {
    const r = rig();
    await r.add(file('a.md'), file('b.md'), file('c.md'));
    const [a, b, c] = r.chips();
    a.kids[3].click();
    assert.deepEqual(deletes(r).map((d) => d.path), [`/api/app/pane/%257/attachments/${uploadId(1)}`]);
    assert.deepEqual(r.chips(), [b, c]);
    assert.equal(r.log.announce.at(-1), 'Removed a.md.');
    assert.equal(focus.el, b.kids[3], 'the next chip\'s remove button');
  });

  test('(+) the last chip hands focus to the previous one; none left hands it to the message box and hides the tray', async () => {
    const r = rig();
    await r.add(file('a.md'), file('b.md'));
    const [a, b] = r.chips();
    b.kids[3].click();
    assert.equal(focus.el, a.kids[3]);
    assert.equal(r.log.focus, 0);
    a.kids[3].click();
    assert.equal(r.log.focus, 1, 'the message box');
    assert.equal(r.tray.hidden, true);
  });

  test('(+) an uploading chip that is removed is deleted as soon as its upload answers', async () => {
    let release;
    const r = rig({ reply: (p, o) => (isUpload(p, o) ? new Promise((resolve) => { release = () => resolve({ status: 200, body: { id: uploadId(9), type: 'text', size: 5 } }); }) : { status: 200, body: {} }) });
    await r.add(file('a.md'));
    r.chips()[0].kids[3].click();
    assert.equal(r.chips().length, 0);
    assert.deepEqual(deletes(r), [], 'there is no id yet');
    release();
    await settle();
    assert.deepEqual(deletes(r).map((d) => d.path), [`/api/app/pane/%257/attachments/${uploadId(9)}`]);
    assert.equal(r.chips().length, 0, 'it does not come back as a chip');
  });

  test('(+) an uploading chip that never started is not uploaded at all', async () => {
    const releases = [];
    const r = rig({ reply: (p, o) => (isUpload(p, o) ? new Promise((resolve) => { releases.push(() => resolve({ status: 200, body: { id: uploadId(1), type: 'text', size: 5 } })); }) : { status: 200, body: {} }) });
    await r.add(file('first.md'), file('second.md'));
    r.chips()[1].kids[3].click();
    releases[0]();
    await settle();
    assert.equal(r.log.calls.filter((c) => c.method === 'POST').length, 1, 'only the first was posted');
    assert.equal(deletes(r).length, 0);
  });

  test('(−) a failed chip is only dropped: no DELETE', async () => {
    const r = rig();
    await r.add(file('huge.bin', MAX_BYTES + 1));
    r.chips()[0].kids[3].click();
    assert.equal(r.chips().length, 0);
    assert.equal(r.log.calls.length, 0);
  });

  test('(−) a disabled remove button does nothing', async () => {
    const r = rig();
    await r.add(file('a.md'));
    r.att.enable(false);
    assert.equal(r.chips()[0].kids[3].disabled, true);
    r.chips()[0].kids[3].fire('click');
    assert.equal(r.chips().length, 1);
    assert.equal(deletes(r).length, 0);
    r.att.enable(true);
    assert.equal(r.chips()[0].kids[3].disabled, false);
  });

  test('(+) pagehide: a keepalive DELETE for every ready chip; (−) none for uploading, failed or removed ones', async () => {
    let release;
    const r = rig({
      reply: (p, o) => {
        if (!isUpload(p, o)) return { status: 200, body: {} };
        if (o.json.name === 'slow.md') return new Promise((resolve) => { release = () => resolve({ status: 200, body: { id: uploadId(7), type: 'text', size: 1 } }); });
        return { status: 200, body: { id: uploadId(o.json.name === 'a.md' ? 1 : 2), type: 'text', size: 1 } };
      },
    });
    await r.add(file('a.md'), file('b.md'), file('huge.bin', MAX_BYTES + 1), file('slow.md'));
    r.chips()[1].kids[3].click(); // b.md removed: it has its own DELETE already
    const before = r.log.calls.length;
    r.win.fire('pagehide');
    assert.deepEqual(r.log.calls.slice(before).map((c) => [c.method, c.path, c.keepalive]), [['DELETE', `/api/app/pane/%257/attachments/${uploadId(1)}`, true]]);
    release();
    await settle();
  });
});

// ---- Send ------------------------------------------------------------------------------------------------------------------------------

describe('Send with attachments: the table of section 6', () => {
  test('(+) pending() is true for any chip, false for none; sending() is false at rest', async () => {
    const r = rig();
    assert.equal(r.att.pending(), false);
    assert.equal(r.att.sending(), false);
    await r.add(file('a.md'));
    assert.equal(r.att.pending(), true);
  });

  test('(−) Shell on: refused with its line; nothing is sent and the box is not cleared', async () => {
    const r = rig();
    await r.add(file('a.md'));
    r.state.shell = true;
    await r.att.send('echo hi');
    assert.deepEqual(r.log.problem.at(-1), ["Turn Shell off to send attachments: a ! command can't carry them.", 'error', undefined]);
    assert.equal(sends(r).length, 0);
    assert.deepEqual(r.log.clear, []);
    assert.equal(r.log.jobs, 0);
  });

  test('(−) a chip still uploading: refused', async () => {
    const r = rig({ reply: (p, o) => (isUpload(p, o) ? new Promise(() => {}) : { status: 200, body: {} }) });
    await r.add(file('a.md'));
    await r.att.send('hi');
    assert.equal(r.log.problem.at(-1)[0], 'Wait until the attachments have finished uploading.');
    assert.equal(r.log.jobs, 0);
  });

  test('(−) a failed chip: refused, and the line tells to remove it', async () => {
    const r = rig();
    await r.add(file('huge.bin', MAX_BYTES + 1), file('ok.md'));
    await r.att.send('hi');
    assert.equal(r.log.problem.at(-1)[0], 'Remove the attachments that failed, then send.');
    assert.equal(r.log.jobs, 0);
  });

  test('(−) Claude is working (owner Q1): refused, text and chips stay', async () => {
    const r = rig();
    await r.add(file('a.md'));
    r.state.working = true;
    await r.att.send('hi');
    assert.equal(r.log.problem.at(-1)[0], 'Attachments go when Claude is waiting. Wait for this turn to end, or press Stop. Your text and attachments are kept.');
    assert.equal(r.chips().length, 1);
    assert.deepEqual(r.log.clear, []);
    assert.deepEqual(r.log.ds, []);
  });

  test('(−) the sync plan refuses (Claude\'s input holds a pasted block): its own message, nothing sent', async () => {
    const r = rig({ screen: screenOf({ state: 'unreadable', sig: null, reason: 'pasted', text: '' }) });
    await r.add(file('a.md'));
    await r.att.send('some text');
    assert.equal(r.log.problem.at(-1)[0], "Claude's input holds a pasted block nika can't read back. Send or clear it in the terminal.");
    assert.deepEqual(r.log.ds, []);
  });

  test('(−) no readable box (legacy plan): "nika can\'t read Claude\'s input box right now"', async () => {
    const r = rig({ screen: null });
    await r.add(file('a.md'));
    await r.att.send('some text');
    assert.equal(r.log.problem.at(-1)[0], "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept.");
    assert.equal(r.log.jobs, 0);
  });

  test('(−) long text with attachments (owner Q2): refused with the "send the text first" line', async () => {
    const r = rig();
    await r.add(file('a.md'));
    await r.att.send('word '.repeat(300));
    assert.equal(r.log.problem.at(-1)[0], 'This message is too long to go with attachments. Send the text first, then the attachments.');
    assert.deepEqual(r.log.ds, []);
    assert.equal(sends(r).length, 0);
  });

  test('(−) an empty message and a box nika cannot read: refused, no request with a made-up base', async () => {
    for (const [screen, line] of [
      [null, "nika can't read Claude's input box right now (a menu may be open). Nothing was sent. Your text is kept."],
      [screenOf({ state: 'unreadable', sig: null, reason: 'layout', text: '' }), "Claude's input holds something nika can't read back. Send or clear it in the terminal, then try again."],
    ]) {
      const r = rig({ screen });
      await r.add(file('a.md'));
      await r.att.send('');
      assert.equal(r.log.problem.at(-1)[0], line);
      assert.equal(sends(r).length, 0);
    }
  });

  test('(+) push: the text is copied first, then attach-send names the chips in order with the sig the push left', async () => {
    const r = rig();
    await r.add(file('a.png'), file('b.pdf'), file('c.md'));
    await r.att.send('look at these');
    assert.deepEqual(r.log.ds, [['begin'], ['send', 'look at these'], ['end']]);
    const [send] = sends(r);
    assert.equal(send.path, '/api/app/pane/%257/attach-send');
    assert.deepEqual(send.json, { ids: [uploadId(1), uploadId(2), uploadId(3)], base: SIG2 });
    assert.deepEqual(Object.keys(send.json), ['ids', 'base']);
  });

  test('(+) enter: Claude\'s box already holds the text, so only attach-send goes, with the screen\'s sig', async () => {
    const r = rig({ screen: screenOf({ state: 'text', text: 'look at these', sig: SIG2 }) });
    await r.add(file('a.png'));
    await r.att.send('look at these');
    assert.deepEqual(r.log.ds, [['begin'], ['end']], 'no push');
    assert.deepEqual(sends(r)[0].json, { ids: [uploadId(1)], base: SIG2 });
  });

  test('(+) an empty message box with ready chips sends the attachments alone', async () => {
    const r = rig();
    await r.add(file('a.png'));
    await r.att.send('');
    assert.deepEqual(r.log.ds, [['begin'], ['end']]);
    assert.deepEqual(sends(r)[0].json, { ids: [uploadId(1)], base: SIG });
  });

  test('(−) the push does not land: its message, no attach-send, chips and text kept, the sync released', async () => {
    const r = rig();
    r.state.pushed = { ok: false, message: "Claude's input changed while nika was copying your text. nika shows what it holds now. Nothing was sent." };
    await r.add(file('a.png'));
    await r.att.send('look at these');
    assert.equal(r.log.problem.at(-1)[0], r.state.pushed.message);
    assert.equal(sends(r).length, 0);
    assert.equal(r.chips().length, 1);
    assert.deepEqual(r.log.clear, []);
    assert.deepEqual(r.log.ds.at(-1), ['end']);
  });

  test('(+) 200: the box and the chips clear, the echo says what went, the tray is hidden', async () => {
    const r = rig();
    await r.add(file('a.png'), file('b.png'));
    await r.att.send('look at these');
    assert.deepEqual(r.log.clear, ['look at these']);
    assert.equal(r.chips().length, 0);
    assert.equal(r.tray.hidden, true);
    assert.deepEqual(r.log.say, ['Sent 2 attachments and your message to %7']);
    assert.deepEqual(r.log.problem.at(-1), ['']);
    assert.deepEqual(r.log.notice, [], 'images only: no Read notice');
    assert.equal(deletes(r).length, 0, 'sent files are not deleted by the page');
  });

  test('(+) the echo reads right for one file and for no text', async () => {
    const r = rig();
    await r.add(file('a.png'));
    await r.att.send('');
    assert.deepEqual(r.log.say, ['Sent 1 attachment to %7']);
    const r2 = rig();
    await r2.add(file('a.png'));
    await r2.att.send('hi');
    assert.deepEqual(r2.log.say, ['Sent 1 attachment and your message to %7']);
  });

  test('(+) a pdf or text file among them adds the Read notice (plural for two or more), once per page', async () => {
    const r = rig();
    await r.add(file('a.png'), file('b.pdf'), file('c.md'));
    await r.att.send('look');
    assert.deepEqual(r.log.notice, ["Claude may ask to read the attached files: they are in nika's attachments folder, outside the project. Answer in the prompt panel."]);
    await r.add(file('d.pdf'));
    await r.att.send('again');
    assert.equal(r.log.notice.length, 1, 'the notice does not pile up');
    const one = rig();
    await one.add(file('a.png'), file('only.pdf'));
    await one.att.send('x');
    assert.deepEqual(one.log.notice, ["Claude may ask to read the attached file: it is in nika's attachments folder, outside the project. Answer in the prompt panel."]);
  });

  test('(+) while it sends: sending() is true, the sync is held, the tray is busy, nothing can be removed or added; afterwards all of it is released', async () => {
    let release;
    const r = rig({
      reply: (p, o) => {
        if (isSend(p, o)) return new Promise((resolve) => { release = () => resolve({ status: 200, body: { sent: 1, images: 1 } }); });
        return { status: 200, body: { id: uploadId(1), type: 'png', size: 5 } };
      },
    });
    await r.add(file('a.png'));
    const done = r.att.send('hi');
    await settle();
    assert.equal(r.att.sending(), true);
    assert.equal(r.tray.attrs['aria-busy'], 'true');
    assert.equal(r.chips()[0].kids[3].attrs['aria-disabled'], 'true');
    assert.deepEqual(r.log.ds[0], ['begin']);
    assert.equal(r.log.ds.filter(([k]) => k === 'end').length, 0);
    await r.att.send('hi'); // a second press while the first is out
    assert.equal(sends(r).length, 1, 'one send at a time');
    r.chips()[0].kids[3].fire('click');
    assert.equal(r.chips().length, 1, 'no removing mid-send');
    const pasted = r.els.composer.fire('paste', { clipboardData: { files: [file('late.png')] } });
    await settle();
    assert.equal(pasted.defaultPrevented, true);
    assert.equal(r.chips().length, 1, 'nothing is added mid-send');
    release();
    await done;
    assert.equal(r.att.sending(), false);
    assert.equal(r.tray.attrs['aria-busy'], undefined);
    assert.equal(r.log.ds.filter(([k]) => k === 'end').length, 1);
  });

  test('(+) the send goes through the keys chain (enqueueJob), once', async () => {
    const r = rig();
    await r.add(file('a.png'));
    await r.att.send('hi');
    assert.equal(r.log.jobs, 1);
  });

  test('(−) every refusal keeps the text and the chips, shows its line, and releases the sync', async () => {
    const cases = [
      [409, { error: 'not-idle', pasted: 0 }, 'Attachments go when Claude is waiting. Nothing was sent; your text and attachments are kept.'],
      [409, { error: 'draft-changed', pasted: 0, draft: {} }, "Claude's input changed while nika was getting ready. Nothing was sent; try again."],
      [409, { error: 'screen-changed', pasted: 0 }, "Claude's screen changed, so nothing was sent."],
      [409, { error: 'busy-switching', pasted: 0 }, 'Another action is running on this session. Try again in a moment.'],
      [429, { error: 'busy', pasted: 0 }, 'Too many keys at once; try again.'],
    ];
    for (const [status, body, line] of cases) {
      const r = rig();
      r.state.sentReply = { status, body };
      await r.add(file('a.png'));
      await r.att.send('look');
      assert.deepEqual(r.log.problem.at(-1), [line, 'error', undefined], body.error);
      assert.equal(r.chips().length, 1, body.error);
      assert.deepEqual(r.log.clear, [], body.error);
      assert.deepEqual(r.log.say, [], body.error);
      assert.equal(r.log.ds.at(-1)[0], 'end', body.error);
      assert.equal(r.att.sending(), false, body.error);
    }
  });

  test('(−) some pasted: the long line, chips and text kept', async () => {
    const r = rig();
    r.state.sentReply = { status: 409, body: { error: 'screen-changed', pasted: 1 } };
    await r.add(file('a.png'), file('b.pdf'));
    await r.att.send('look');
    assert.match(r.log.problem.at(-1)[0], /^nika put 1 of 2 attachments into Claude's input, then stopped without pressing Enter: /);
    assert.equal(r.chips().length, 2);
    assert.deepEqual(r.log.clear, []);
  });

  test('(−) attachment-gone marks that chip "Gone" (failed) so the next Send asks to remove it', async () => {
    const r = rig();
    r.state.sentReply = { status: 409, body: { error: 'attachment-gone', pasted: 0, id: uploadId(2) } };
    await r.add(file('a.png'), file('b.pdf'));
    await r.att.send('look');
    assert.equal(r.log.problem.at(-1)[0], 'b.pdf is no longer on disk. Remove it and add it again.');
    const gone = view(r.chips()[1]);
    assert.deepEqual([gone.s, gone.meta, gone.icons], ['failed', 'Gone', ['#i-warn']]);
    assert.equal(view(r.chips()[0]).s, 'ready');
    await r.att.send('look');
    assert.equal(r.log.problem.at(-1)[0], 'Remove the attachments that failed, then send.');
  });

  test('(−) 404: the pane is gone', async () => {
    const r = rig();
    r.state.sentReply = { status: 404, body: { error: 'not_found' } };
    await r.add(file('a.png'));
    await r.att.send('look');
    assert.equal(r.log.gone, 1);
    assert.equal(r.log.problem.at(-1)[0], 'The session is gone.');
  });

  test('(−) an answer\'s own message or draft stays out of every line', async () => {
    const r = rig();
    r.state.sentReply = { status: 409, body: { error: 'draft-changed', pasted: 0, message: 'SERVER SAID THIS', draft: { text: 'private draft text' } } };
    await r.add(file('a.png'));
    await r.att.send('look');
    assert.doesNotMatch(JSON.stringify([r.log.problem, r.log.say, r.log.notice, r.log.announce]), /SERVER|private/);
  });
});

// ---- the static side ------------------------------------------------------------------------------------------------------------------------

describe('public/attach.js source', () => {
  test('(+) it is ASCII, names no banned word, and does no DOM work at import (no top-level document or window use)', () => {
    assert.equal([...SRC].every((ch) => ch.codePointAt(0) < 128), true);
    assert.equal(SRC.toLowerCase().includes(['pony', 'tail'].join('')), false);
    assert.equal(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').toLowerCase().includes(['pony', 'tail'].join('')), false);
    const top = code(SRC).split('\n').filter((l) => /^(const|let|var)\b/.test(l)).join('\n');
    assert.doesNotMatch(top, /document|window|globalThis/);
  });

  test('(−) no HTML-parsing or code-evaluating sink, no style string, no direct fetch or other origin, no on* property', () => {
    const c = code(SRC);
    const sinks = ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document.' + 'write', 'ev' + 'al(', 'new Func' + 'tion', 'css' + 'Text', 'src' + 'doc', 'DOM' + 'Parser'];
    for (const s of sinks) assert.equal(c.includes(s), false, s);
    assert.doesNotMatch(c, /setAttribute\s*\(\s*['"`](style|on)/i);
    assert.doesNotMatch(c, /\.\s*on[a-z]+\s*=[^=]/);
    assert.doesNotMatch(c, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|window\.open|location\s*(\.href)?\s*=[^=]|https?:\/\//);
    assert.doesNotMatch(c, /\.style\b/, 'no inline style: classes and data attributes only');
    assert.match(c, /\.textContent/, 'strings from files and the server are text');
  });

  test('(+) it reaches the server only through the io the page gives it: no route string of its own (tier separation), three routes asked of io.path', () => {
    const c = code(SRC);
    assert.doesNotMatch(c, /\/api\//, 'ui.test.js: only the app-tier modules name /api/app, and session.js builds the paths');
    for (const call of ["io.path('attachments')", "io.path('attach-send')", 'io.path(`attachments/${id}`)']) assert.ok(c.includes(call), call);
    assert.equal([...c.matchAll(/io\.path\(/g)].length, 3, 'the upload, the send and the delete path only');
  });

  test('(+) every icon it draws and every id it looks up exists in session.html', () => {
    const symbols = new Set([...HTML.matchAll(/<symbol id="i-([a-z-]+)"/g)].map((m) => m[1]));
    for (const n of ['attach', 'image', 'file', 'text', 'x', 'warn']) assert.ok(symbols.has(n), n);
    const drawn = [...code(SRC).matchAll(/\bicon\('([a-z-]+)'\)/g)].map((m) => m[1]);
    assert.ok(drawn.includes('x') && drawn.includes('warn'));
    for (const n of drawn) assert.ok(symbols.has(n), n);
    const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...code(SRC).matchAll(/\bel\('([a-z-]+)'\)/g)].map((m) => m[1]));
    for (const id of ['att-tray', 'att-btn', 'att-input', 'att-drop', 'composer-box', 'composer']) assert.ok(used.has(id), id);
    for (const id of used) assert.ok(ids.has(id), id);
  });
});

describe('session.html: the markup of section 8.1', () => {
  const tag = (id) => new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`).exec(HTML)?.[0] ?? '';
  const at = (needle) => {
    const i = HTML.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };

  test('(+) the tray is a hidden labelled list between the prompt panel and the message box', () => {
    assert.match(tag('att-tray'), /^<ul class="att-tray" id="att-tray" aria-label="Attachments" hidden>/);
    assert.ok(at('id="prompt-btns"') < at('id="att-tray"') && at('id="att-tray"') < at('<div class="inbox">'));
  });

  test('(+) the button sits right after Commands and before Send, described by the help line', () => {
    const b = /<button\b[^>]*\bid="att-btn"[^>]*>[\s\S]*?<\/button>/.exec(HTML)?.[0] ?? '';
    assert.match(b, /^<button type="button" class="btn ghost icon"/);
    assert.match(b, /aria-label="Add attachments"/);
    assert.match(b, /title="Add attachments"/);
    assert.match(b, /aria-describedby="att-help"/);
    assert.match(b, /<use href="#i-attach"\/>/);
    assert.ok(at('id="cmd-btn"') < at('id="att-btn"') && at('id="att-btn"') < at('id="send"'));
  });

  test('(+) a hidden multiple file input with the picker filter, and the drop hint inside the message box', () => {
    const i = tag('att-input');
    assert.match(i, /type="file"/);
    assert.match(i, /\bmultiple\b/);
    assert.match(i, /\bhidden\b/);
    assert.match(i, /accept="image\/png,image\/jpeg,image\/gif,image\/webp,application\/pdf,text\/\*,/);
    assert.match(HTML, /<span class="att-drop" id="att-drop" aria-hidden="true" hidden>Drop to attach<\/span>/);
    const inbox = HTML.slice(at('<div class="inbox">'), at('<div class="mode-row"'));
    assert.ok(inbox.includes('id="att-btn"') && inbox.includes('id="att-input"') && inbox.includes('id="att-drop"'));
  });

  test('(+) the help line is screen-reader text in the notes row and names the limits', () => {
    assert.match(HTML, /<span class="sr-only" id="att-help">Images \(PNG, JPEG, GIF, WebP\), PDF or text files: up to 6 per message, 8 MB each\. You can also paste or drop them on the message box\.<\/span>/);
    assert.ok(at('id="notes"') < at('id="att-help"') && at('id="att-help"') < at('</main>'));
  });

  test('(+) the sprite draws the five new symbols at 16 x 16', () => {
    for (const n of ['attach', 'image', 'file', 'text', 'x']) assert.match(HTML, new RegExp(`<symbol id="i-${n}" viewBox="0 0 16 16">`), n);
  });

  test('(−) the page stays under the strict CSP: one module script, no inline style, no on* attribute, no form, ASCII', () => {
    assert.equal([...HTML.matchAll(/<script\b/gi)].length, 1);
    assert.doesNotMatch(HTML, /<style\b|\sstyle\s*=|\son[a-z]+\s*=|<form\b/i);
    assert.equal([...HTML].every((ch) => ch.codePointAt(0) < 128), true);
  });
});

describe('session.css: the rules of section 8.7, tokens only', () => {
  const rules = CSS.slice(CSS.indexOf('.att-tray')).replace(/\/\*[\s\S]*?\*\//g, '');

  test('(+) the tray, chip, name, meta, remove and drop rules exist', () => {
    assert.ok(CSS.indexOf('.att-tray') > 0);
    for (const sel of ['\\.att-tray', '\\.att', '\\.att-n', '\\.att-m', '\\.att\\[data-s="failed"\\]', '\\.att-x', '#composer-box\\.dropping \\.inbox', '\\.att-drop']) {
      assert.match(rules, new RegExp(`(^|[\\s,}])${sel}[\\s,{:\\[.]`), sel);
    }
    assert.match(rules, /\.att\[data-s="failed"\][^{]*\{[^}]*border-color:\s*var\(--danger-line\)/);
    assert.match(rules, /\.att\[data-s="failed"\] \.att-m[^{]*\{[^}]*color:\s*var\(--danger\)/);
  });

  test('(+) every variable it uses is defined in tokens.css (light and dark come with them)', () => {
    const defined = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...rules.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    assert.ok(used.length >= 10);
    for (const v of used) assert.ok(defined.has(v), v);
  });

  test('(−) it brings no colour of its own: no hex, rgb(), hsl() or named colour value', () => {
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b(?!\.)|rgba?\(|hsla?\(/);
    assert.doesNotMatch(rules, /\b(color|background|border-color|border):\s*(red|green|blue|white|black|gray|grey)\b/);
  });

  test('(+) the spinner has a still look for reduced motion, like the mode switch\'s', () => {
    assert.match(CSS, /prefers-reduced-motion[^{]*\{[^@]*\.att \.spin\s*\{[^}]*animation:\s*none/);
  });

  test('(+) the chip\'s remove button is at least 24 x 24 px', () => {
    assert.match(rules, /\.att-x\s*\{[^}]*min-width:\s*24px[^}]*min-height:\s*24px|\.att-x\s*\{[^}]*min-height:\s*24px[^}]*min-width:\s*24px/);
  });
});

describe('the hooks in session.js (H6)', () => {
  const src = code(SESSION);

  test('(+) it imports the tray from ./attach.js and builds it right after the draft sync', () => {
    assert.match(SESSION, /import \{ createAttachTray \} from '\.\/attach\.js';/);
    const ds = src.indexOf('const DS = createDraftSync(');
    const att = src.indexOf('const ATT = createAttachTray(');
    assert.ok(ds >= 0 && att > ds);
    const call = src.slice(att, src.indexOf('});', att) + 3);
    for (const k of ['paneId', 'path:', 'call', 'appFetch', 'ds: DS', 'enqueueJob', 'say', 'announce', 'showProblem', 'clearProblem', 'showNotice', 'setGone', 'box:', 'working:', 'cols:', 'clearBox', 'focusBox']) assert.ok(call.includes(k), k);
    assert.match(call, /working: \(\) => A\.kind === 'busy'/);
  });

  test('(+) sendComposer hands the send to the tray right after the prompt gate', () => {
    const f = src.slice(src.indexOf('async function sendComposer()'));
    const gate = f.indexOf('if (!gate.ok)');
    const hook = f.indexOf('if (ATT.pending()) return ATT.send(composer().value);');
    const plan = f.indexOf('draftSendPlan(');
    assert.ok(gate > 0 && hook > gate && hook < plan, 'gate, then the tray, then the plain plan');
  });

  test('(+) the success block of a send is one function both roads use', () => {
    assert.match(src, /function clearBox\(value\)/);
    const f = src.slice(src.indexOf('async function sendComposer()'), src.indexOf('async function pushThenEnter'));
    assert.match(f, /clearBox\(value\)/);
  });

  test('(+) the sync is not fed while the tray sends (H4), the tray follows the input being on or off, and boot wires it', () => {
    assert.match(src, /if \(!ATT\.sending\(\)\) DS\.capture\(M\.draft, cols\);/);
    assert.match(src, /function setInputEnabled\(on, why\) \{[\s\S]*?ATT\.enable\(on\);[\s\S]*?\n\}/);
    assert.match(src, /wireComposer\(\);\s*ATT\.wire\(\);/);
  });
});

describe('the static list and the desktop shell', () => {
  test('(+) /attach.js is served: next to /scroll.js on the static list, as JavaScript', () => {
    const server = read('src', 'server.js');
    assert.match(server, /\['\/attach\.js', \['attach\.js', 'text\/javascript; charset=utf-8'\]\]/);
    assert.ok(server.indexOf("'/scroll.js'") < server.indexOf("'/attach.js'"));
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'attach.js')));
  });

  test('(−) the content security policy is exactly the eight directives it had: no new source, no inline allowance', () => {
    const server = read('src', 'server.js');
    const block = /const CSP = \[([\s\S]*?)\]\.join/.exec(server)?.[1] ?? '';
    const directives = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(directives, ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]);
  });

  test('(+) the window builder turns Tauri\'s drag-and-drop handler off, in make_window, before the window is built', () => {
    const lib = read('app', 'src-tauri', 'src', 'lib.rs');
    const fn = lib.slice(lib.indexOf('fn make_window('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const off = body.indexOf('.disable_drag_drop_handler()');
    assert.ok(off > 0, 'the call is in make_window');
    assert.ok(off < body.indexOf('builder.build()'), 'before build');
    assert.ok(off < body.indexOf('.on_navigation('), 'in the same chain as the navigation guard');
  });

  test('(−) the shell registers no drag-drop listener and keeps its navigation guard and its new-window denial', () => {
    const lib = read('app', 'src-tauri', 'src', 'lib.rs');
    assert.doesNotMatch(lib, /on_drag_drop|DragDropEvent|WindowEvent::DragDrop/);
    assert.match(lib, /\.on_navigation\(/);
    assert.match(lib, /NewWindowResponse::Deny/);
  });
});
